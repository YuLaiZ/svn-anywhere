/**
 * 面板宿主测试（mock vscode）：HTML 骨架（CSP/nonce/asWebviewUri）、
 * 消息校验与会话代次、请求去重、忙碌拒绝、复用 reveal、dispose 清理。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakePanel {
  viewType: string;
  title: string;
  html: string;
  posted: unknown[];
  revealed: number;
  disposed: boolean;
  reveal(): void;
  dispose(): void;
  receive(raw: unknown): Promise<void> | void;
  fireDispose(): void;
  onDidReceiveMessageHandler?: (raw: unknown) => unknown;
}

const panelsCreated: FakePanel[] = [];

function makeFakePanel(viewType: string, title: string): FakePanel {
  let disposeHandler: (() => void) | undefined;
  const panel: FakePanel = {
    viewType,
    title,
    html: '',
    posted: [],
    revealed: 0,
    disposed: false,
    reveal() {
      panel.revealed += 1;
    },
    dispose() {
      if (panel.disposed) {
        return;
      }
      panel.disposed = true;
      disposeHandler?.();
    },
    receive(raw) {
      return panel.onDidReceiveMessageHandler?.(raw) as void | Promise<void>;
    },
    fireDispose() {
      panel.dispose();
    },
  };
  (panel as unknown as { webview: unknown }).webview = {
    set html(value: string) {
      panel.html = value;
    },
    get html() {
      return panel.html;
    },
    postMessage(message: unknown) {
      panel.posted.push(message);
      return Promise.resolve(true);
    },
    asWebviewUri: (uri: { toString(): string }) => ({ toString: () => `vscode-webview://test${uri.toString()}` }),
    cspSource: 'vscode-webview-test:',
    onDidReceiveMessage(handler: (raw: unknown) => unknown) {
      panel.onDidReceiveMessageHandler = handler;
      return { dispose: () => { panel.onDidReceiveMessageHandler = undefined; } };
    },
  };
  (panel as unknown as { onDidDispose: unknown }).onDidDispose = (handler: () => void) => {
    disposeHandler = handler;
    return { dispose: () => { disposeHandler = undefined; } };
  };
  return panel;
}

const vscodeMock = vi.hoisted(() => ({
  ViewColumn: { Active: 1 },
}));

vi.mock('vscode', () => ({
  ViewColumn: vscodeMock.ViewColumn,
  Uri: {
    file: (path: string) => ({ scheme: 'file', path, toString: () => `file://${path}`, fsPath: path }),
    joinPath: (base: { toString(): string }, ...parts: string[]) => ({
      scheme: 'file',
      path: [base.toString().replace('file://', ''), ...parts].join('/'),
      toString: () => `file://${[base.toString().replace('file://', ''), ...parts].join('/')}`,
      fsPath: [base.toString().replace('file://', ''), ...parts].join('/'),
    }),
  },
  window: {
    createWebviewPanel: (viewType: string, title: string) => {
      const panel = makeFakePanel(viewType, title);
      panelsCreated.push(panel);
      return panel;
    },
    createOutputChannel: () => ({
      appendLine: () => {},
      show: () => {},
      dispose: () => {},
    }),
  },
  workspace: {
    onDidCloseTextDocument: () => ({ dispose: () => {} }),
  },
}));

import { createPanel, panelHtmlTemplate, resetPanelRegistry } from '../src/host/panel/host';
import type { PanelState } from '../src/host/panel/state';

const context = {
  extensionUri: { toString: () => 'file:///ext' } as never,
  subscriptions: [] as Array<{ dispose(): void }>,
};

function state(patch: Partial<PanelState> = {}): PanelState {
  return {
    sessionId: 's1',
    title: '面板',
    targetLabel: 'wc',
    revision: 0,
    formRevision: 0,
    busy: false,
    banners: [],
    ...patch,
  };
}

const renderMessage = (posted: unknown[]) =>
  posted.filter((m) => (m as { type?: string }).type === 'render').at(-1);
const toastMessages = (posted: unknown[]) =>
  posted.filter((m) => (m as { type?: string }).type === 'toast') as Array<{ message: string }>;

beforeEach(() => {
  resetPanelRegistry();
  panelsCreated.length = 0;
  context.subscriptions = [];
});

describe('面板创建与 HTML 骨架', () => {
  it('createPanel 注入 CSP + nonce + asWebviewUri 骨架', () => {
    const handle = createPanel('t1', { title: 'T' }, { onIntent: () => {} }, context);
    const panel = panelsCreated[0];
    expect(panel).toBeDefined();
    expect(panel.html).toContain("default-src 'none'");
    expect(panel.html).toContain('img-src vscode-webview-test: data:');
    expect(panel.html).toContain("style-src vscode-webview-test: 'unsafe-inline'");
    expect(panel.html).toMatch(/script-src 'nonce-[0-9a-f]{24,}'/);
    expect(panel.html).toContain('src="vscode-webview://testfile:///ext/media/panel.js"');
    expect(panel.html).toContain('href="vscode-webview://testfile:///ext/media/panel.css"');
    expect(handle.sessionId).not.toBe('');
    handle.dispose();
  });

  it('两次 nonce 不同（每次创建随机）', () => {
    const h1 = createPanel('t1', { title: 'T' }, { onIntent: () => {} }, context);
    h1.dispose();
    const h2 = createPanel('t1', { title: 'T' }, { onIntent: () => {} }, context);
    const nonceOf = (html: string) => html.match(/nonce-([0-9a-f]+)/)?.[1];
    expect(nonceOf(panelsCreated[0].html)).not.toBe(nonceOf(panelsCreated[1].html));
    h2.dispose();
  });
});

describe('消息链路', () => {
  it('ready 后推送当前状态 render（幂等，隐藏重建同链路）', async () => {
    const intents: unknown[] = [];
    const handle = createPanel('t1', { title: 'T' }, { onIntent: (intent) => { intents.push(intent); } }, context);
    handle.update(state());
    const panel = panelsCreated[0];
    panel.posted.length = 0;
    await panel.receive({ type: 'ready', protocolVersion: 1 });
    const first = renderMessage(panel.posted) as { revision: number; html: string };
    expect(first.html).toContain('class="panel"');
    await panel.receive({ type: 'ready', protocolVersion: 1 });
    const second = renderMessage(panel.posted) as { revision: number };
    expect(second.revision).toBe(first.revision + 1);
    handle.dispose();
  });

  it('update 携带旧会话 ID 时丢弃（迟到结果不写入新目标）', () => {
    const handle = createPanel('t1', { title: 'T' }, { onIntent: () => {} }, context);
    handle.update(state(), 'wrong-session');
    expect(renderMessage(panelsCreated[0].posted)).toBeUndefined();
    handle.dispose();
  });

  it('dispose 后不再发送任何消息', () => {
    const handle = createPanel('t1', { title: 'T' }, { onIntent: () => {} }, context);
    handle.update(state());
    handle.dispose();
    panelsCreated[0].posted.length = 0;
    handle.update(state());
    expect(panelsCreated[0].posted).toHaveLength(0);
  });

  it('协议版本不兼容的 ready 弹错误 toast（不静默）', async () => {
    const handle = createPanel('t1', { title: 'T' }, { onIntent: () => {} }, context);
    const panel = panelsCreated[0];
    await panel.receive({ type: 'ready', protocolVersion: 99 });
    const toasts = toastMessages(panel.posted);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toContain('协议版本不兼容');
    handle.dispose();
  });
});

describe('意图校验', () => {
  async function setup() {
    const intents: unknown[] = [];
    const handle = createPanel('t1', { title: 'T' }, { onIntent: (intent) => { intents.push(intent); } }, context);
    handle.update(state({
      list: {
        id: 'l',
        columns: [],
        rows: [{ id: 'a.ts', cells: { path: 'a.ts', status: 'modified' } }],
        selection: { total: 0, visible: 0, hidden: 0 },
        empty: { title: 'e' },
      },
    }));
    const panel = panelsCreated[0];
    panel.posted.length = 0;
    return { handle, panel, intents };
  }

  it('合法意图转发控制器', async () => {
    const { handle, panel, intents } = await setup();
    await panel.receive({
      type: 'intent', protocolVersion: 1, sessionId: handle.sessionId, requestId: 'r1',
      intent: { kind: 'openDiff', itemId: 'a.ts' },
    });
    expect(intents).toEqual([{ kind: 'openDiff', itemId: 'a.ts' }]);
    handle.dispose();
  });

  it('旧会话意图被忽略', async () => {
    const { handle, panel, intents } = await setup();
    await panel.receive({
      type: 'intent', protocolVersion: 1, sessionId: 'stale', requestId: 'r1',
      intent: { kind: 'refresh' },
    });
    expect(intents).toHaveLength(0);
    handle.dispose();
  });

  it('重复 requestId 只处理一次', async () => {
    const { handle, panel, intents } = await setup();
    const message = {
      type: 'intent', protocolVersion: 1, sessionId: handle.sessionId, requestId: 'r1',
      intent: { kind: 'refresh' },
    };
    await panel.receive(message);
    await panel.receive(message);
    expect(intents).toHaveLength(1);
    handle.dispose();
  });

  it('条目不存在的条目意图被忽略（能力校验）', async () => {
    const { handle, panel, intents } = await setup();
    await panel.receive({
      type: 'intent', protocolVersion: 1, sessionId: handle.sessionId, requestId: 'r1',
      intent: { kind: 'openDiff', itemId: 'not-exist' },
    });
    expect(intents).toHaveLength(0);
    handle.dispose();
  });

  it('忙碌期间写意图被拒绝并 toast；syncInput 不受限', async () => {
    const { handle, panel, intents } = await setup();
    handle.update(state({
      busy: true,
      list: {
        id: 'l',
        columns: [],
        rows: [{ id: 'a.ts', cells: { path: 'a.ts', status: 'modified' } }],
        selection: { total: 0, visible: 0, hidden: 0 },
        empty: { title: 'e' },
      },
    }));
    panel.posted.length = 0;
    await panel.receive({
      type: 'intent', protocolVersion: 1, sessionId: handle.sessionId, requestId: 'r1',
      intent: { kind: 'refresh' },
    });
    expect(intents).toHaveLength(0);
    expect(toastMessages(panel.posted)[0]?.message).toContain('忽略重复请求');
    await panel.receive({
      type: 'intent', protocolVersion: 1, sessionId: handle.sessionId, requestId: 'r2',
      intent: { kind: 'syncInput', fieldId: 'message', value: 'x', inputRevision: 1 },
    });
    expect(intents).toEqual([{ kind: 'syncInput', fieldId: 'message', value: 'x', inputRevision: 1 }]);
    handle.dispose();
  });

  it('未知动作返回拒绝原因 toast', async () => {
    const { handle, panel } = await setup();
    await panel.receive({
      type: 'intent', protocolVersion: 1, sessionId: handle.sessionId, requestId: 'r1',
      intent: { kind: 'exec', command: 'rm -rf /' },
    });
    expect(toastMessages(panel.posted)[0]?.message).toContain('未知意图动作');
    handle.dispose();
  });
});

describe('复用与销毁', () => {
  it('同 panelId 再次 createPanel 复用并 reveal，不新建', () => {
    const h1 = createPanel('t1', { title: 'T' }, { onIntent: () => {} }, context);
    const h2 = createPanel('t1', { title: 'T' }, { onIntent: () => {} }, context);
    expect(panelsCreated).toHaveLength(1);
    expect(panelsCreated[0].revealed).toBe(1);
    h1.dispose();
    h2.dispose();
  });

  it('面板关闭（onDidDispose）后注册表清理，再创建是新面板', async () => {
    const h1 = createPanel('t1', { title: 'T' }, { onIntent: () => {} }, context);
    const panel = panelsCreated[0];
    panel.fireDispose();
    const h2 = createPanel('t1', { title: 'T' }, { onIntent: () => {} }, context);
    expect(panelsCreated).toHaveLength(2);
    expect(h2.sessionId).not.toBe(h1.sessionId);
    h2.dispose();
  });

  it('switchSession 忙碌时拒绝（返回 undefined）', () => {
    const handle = createPanel('t1', { title: 'T' }, { onIntent: () => {} }, context);
    handle.update(state());
    expect(handle.switchSession()).toBeTypeOf('string');
    handle.update(state({ busy: true }));
    expect(handle.switchSession()).toBeUndefined();
    handle.dispose();
  });

  it('switchSession 面板已销毁时返回 undefined（与忙碌分支同口径）', () => {
    const handle = createPanel('t1', { title: 'T' }, { onIntent: () => {} }, context);
    panelsCreated[0].fireDispose();
    expect(handle.switchSession()).toBeUndefined();
  });

  it('resetPanelRegistry 显式销毁 panel 本体并清空注册表', () => {
    createPanel('t1', { title: 'T' }, { onIntent: () => {} }, context);
    expect(panelsCreated[0].disposed).toBe(false);
    resetPanelRegistry();
    // panel 本体被显式 dispose，而非只做宿主侧条目清理。
    expect(panelsCreated[0].disposed).toBe(true);
    // 注册表已清空：同 panelId 再创建是全新面板而非复用 reveal。
    const h2 = createPanel('t1', { title: 'T' }, { onIntent: () => {} }, context);
    expect(panelsCreated).toHaveLength(2);
    expect(panelsCreated[1].revealed).toBe(0);
    h2.dispose();
  });
});

describe('panelHtmlTemplate', () => {
  it('CSP 四段约束齐全且不含 http(s) 源', () => {
    const html = panelHtmlTemplate(
      {
        asWebviewUri: (uri: { toString(): string }) => ({ toString: () => `wv://${uri.toString()}` }),
        cspSource: 'wv-src:',
      } as never,
      { toString: () => 'file:///ext' } as never,
    );
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('img-src wv-src: data:');
    expect(html).toContain("style-src wv-src: 'unsafe-inline'");
    expect(html).not.toMatch(/connect-src|http:/);
  });
});
