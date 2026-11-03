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
    handle.update(state({ sessionId: handle.sessionId }));
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
    handle.update(state({ sessionId: handle.sessionId }), 'wrong-session');
    expect(renderMessage(panelsCreated[0].posted)).toBeUndefined();
    handle.dispose();
  });

  it('update 的状态快照属于其他会话时丢弃（切换窗口内旧快照不上屏）', () => {
    const handle = createPanel('t1', { title: 'T' }, { onIntent: () => {} }, context);
    handle.update(state());
    expect(renderMessage(panelsCreated[0].posted)).toBeUndefined();
    handle.dispose();
  });

  it('switchSession 后 ready 不重推上一个目标的旧快照', async () => {
    const handle = createPanel('t1', { title: 'T' }, { onIntent: () => {} }, context);
    handle.update(state({ sessionId: handle.sessionId, targetLabel: '旧目标' }));
    const panel = panelsCreated[0];
    const nextSessionId = handle.switchSession();
    expect(nextSessionId).toBeTypeOf('string');
    panel.posted.length = 0;
    await panel.receive({ type: 'ready', protocolVersion: 1 });
    expect(renderMessage(panel.posted)).toBeUndefined();
    // 新会话的帧照常上屏。
    handle.update(state({ sessionId: nextSessionId!, targetLabel: '新目标' }));
    expect(String((renderMessage(panel.posted) as { html?: string }).html)).toContain('新目标');
    handle.dispose();
  });

  it('dispose 后不再发送任何消息', () => {
    const handle = createPanel('t1', { title: 'T' }, { onIntent: () => {} }, context);
    handle.update(state({ sessionId: handle.sessionId }));
    handle.dispose();
    panelsCreated[0].posted.length = 0;
    handle.update(state({ sessionId: handle.sessionId }));
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
      sessionId: handle.sessionId,
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

  it('ready 重握手清空请求去重集合（视图重建后 req-1 重启不被吞）', async () => {
    const { handle, panel, intents } = await setup();
    await panel.receive({
      type: 'intent', protocolVersion: 1, sessionId: handle.sessionId, requestId: 'req-1',
      intent: { kind: 'refresh' },
    });
    expect(intents).toHaveLength(1);
    // 隐藏销毁后重显：视图脚本重新加载并再次握手，请求序号空间随视图重启。
    await panel.receive({ type: 'ready', protocolVersion: 1 });
    await panel.receive({
      type: 'intent', protocolVersion: 1, sessionId: handle.sessionId, requestId: 'req-1',
      intent: { kind: 'refresh' },
    });
    expect(intents).toHaveLength(2);
    // 重握手同时重推当前状态。
    const renders = panel.posted.filter((m) => (m as { type?: string }).type === 'render');
    expect(renders.length).toBeGreaterThan(0);
    handle.dispose();
  });

  it('ready 重握手递增 viewEpoch、回调 onViewReady，重推与后续帧携带新代次', async () => {
    const onViewReady = vi.fn();
    const handle = createPanel(
      't-epoch',
      { title: 'T' },
      { onIntent: () => {}, onViewReady },
      context,
    );
    handle.update(state({ sessionId: handle.sessionId, formRevision: 12 }));
    const panel = panelsCreated[0];
    const epoch = () => (renderMessage(panel.posted) as { viewEpoch?: number }).viewEpoch;
    expect(epoch()).toBe(0);
    panel.posted.length = 0;
    await panel.receive({ type: 'ready', protocolVersion: 1 });
    expect(onViewReady).toHaveBeenCalledTimes(1);
    // 控制器先于宿主重推收到回调（此时归零 formRevision 重推才有效）。
    const readyFrame = renderMessage(panel.posted) as { viewEpoch: number };
    expect(readyFrame.viewEpoch).toBe(1);
    panel.posted.length = 0;
    handle.update(state({ sessionId: handle.sessionId, formRevision: 0 }));
    // 同一视图代次内后续帧沿用新 epoch。
    expect((renderMessage(panel.posted) as { viewEpoch: number }).viewEpoch).toBe(1);
    panel.posted.length = 0;
    await panel.receive({ type: 'ready', protocolVersion: 1 });
    expect((renderMessage(panel.posted) as { viewEpoch: number }).viewEpoch).toBe(2);
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
      sessionId: handle.sessionId,
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

  it('写锁定期间横幅的核实/重读动作按 actionId 放行，其他横幅动作仍拒绝', async () => {
    const { handle, panel, intents } = await setup();
    handle.update(state({
      sessionId: handle.sessionId,
      writeLocked: true,
      banners: [
        { id: 'unknown', level: 'warn', title: '提交结果未知', actions: [{ id: 'resolveUnknown', label: '核实提交结果' }] },
        { id: 'other', level: 'warn', title: '其他横幅', actions: [{ id: 'writeSomething', label: '写入' }] },
      ],
    }));
    panel.posted.length = 0;
    // 重启恢复后视图点击横幅按钮，发出的是 bannerAction 而非内部 resolveUnknown：
    // 写锁豁免必须按 actionId 判定，否则真实按钮会被当作写意图拒绝。
    await panel.receive({
      type: 'intent', protocolVersion: 1, sessionId: handle.sessionId, requestId: 'r-verify',
      intent: { kind: 'bannerAction', bannerId: 'unknown', actionId: 'resolveUnknown' },
    });
    expect(intents).toEqual([{ kind: 'bannerAction', bannerId: 'unknown', actionId: 'resolveUnknown' }]);
    expect(toastMessages(panel.posted)).toHaveLength(0);
    // 非豁免的横幅动作仍被写锁拒绝，不进入控制器。
    await panel.receive({
      type: 'intent', protocolVersion: 1, sessionId: handle.sessionId, requestId: 'r-write',
      intent: { kind: 'bannerAction', bannerId: 'other', actionId: 'writeSomething' },
    });
    expect(intents).toHaveLength(1);
    expect(toastMessages(panel.posted)[0]?.message).toContain('忽略重复请求');
    // 放行不等于无校验：横幅上不存在的动作仍被能力校验拦截。
    await panel.receive({
      type: 'intent', protocolVersion: 1, sessionId: handle.sessionId, requestId: 'r-forged',
      intent: { kind: 'bannerAction', bannerId: 'unknown', actionId: 'refresh' },
    });
    expect(intents).toHaveLength(1);
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
    handle.update(state({ sessionId: handle.sessionId }));
    expect(handle.switchSession()).toBeTypeOf('string');
    handle.update(state({ sessionId: handle.sessionId, busy: true }));
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
