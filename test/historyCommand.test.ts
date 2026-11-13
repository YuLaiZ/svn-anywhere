/**
 * P6 历史命令入口（commands/history.ts）单测：本地目标解析（真实 SVN
 * 本地 info，不访问网络）、资源管理器/活动编辑器/命令面板三种入口，
 * 以及 openHistoryTarget 的注入点与 P5 交接载荷传递。
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

const vscodeMock = vi.hoisted(() => ({
  information: [] as string[],
  warning: [] as string[],
  errors: [] as string[],
  openDialogCalls: 0,
  openDialogResult: undefined as Array<{ fsPath: string }> | undefined,
  activeTextEditor: undefined as { document: { uri: { scheme: string; fsPath: string } } } | undefined,
  registered: [] as Array<{ id: string; handler: (uri?: unknown) => unknown; disposable: { disposed: boolean; dispose: () => void } }>,
  activeCommandIds: new Set<string>(),
  executed: [] as unknown[][],
  saveDialogResult: undefined as string | undefined,
}));

interface FakePanel {
  posted: Array<Record<string, unknown>>;
  disposed: boolean;
  reveal(): void;
  dispose(): void;
  sendIntent(intent: Record<string, unknown>, requestId?: string): void;
  latestRenderHtml(): string;
  toasts(): string[];
}

const webviewPanels: FakePanel[] = [];

function makeFakePanel(title: string): FakePanel {
  void title;
  let messageHandler: ((raw: unknown) => unknown) | undefined;
  let disposeHandler: (() => void) | undefined;
  let sessionId = '';
  let seq = 0;
  const panel: FakePanel = {
    posted: [],
    disposed: false,
    reveal() {},
    dispose() {
      if (panel.disposed) {
        return;
      }
      panel.disposed = true;
      disposeHandler?.();
    },
    sendIntent(intent, requestId) {
      seq += 1;
      void messageHandler?.({
        type: 'intent',
        protocolVersion: 1,
        sessionId,
        requestId: requestId || `req-${seq}`,
        intent,
      });
    },
    latestRenderHtml() {
      for (let index = panel.posted.length - 1; index >= 0; index -= 1) {
        const message = panel.posted[index];
        if (message.type === 'render') {
          return String(message.html ?? '');
        }
      }
      return '';
    },
    toasts() {
      return panel.posted
        .filter((message) => message.type === 'toast')
        .map((message) => String(message.message ?? ''));
    },
  };
  (panel as unknown as { webview: unknown }).webview = {
    set html(value: string) {
      void value;
    },
    get html() {
      return '';
    },
    postMessage(message: unknown) {
      panel.posted.push(message as Record<string, unknown>);
      if ((message as { type?: string }).type === 'render') {
        sessionId = String((message as { sessionId?: string }).sessionId ?? '');
      }
      return Promise.resolve(true);
    },
    asWebviewUri: (uri: { toString(): string }) => ({ toString: () => `vscode-webview://test${uri.toString()}` }),
    cspSource: 'vscode-webview-test:',
    onDidReceiveMessage(handler: (raw: unknown) => unknown) {
      messageHandler = handler;
      return { dispose: () => { messageHandler = undefined; } };
    },
  };
  (panel as unknown as { onDidDispose: unknown }).onDidDispose = (handler: () => void) => {
    disposeHandler = handler;
    return { dispose: () => { disposeHandler = undefined; } };
  };
  return panel;
}

vi.mock('vscode', () => ({
  ViewColumn: { Active: 1, Beside: 2 },
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  Uri: {
    file: (path: string) => ({ scheme: 'file', path, fsPath: path, toString: () => `file://${path}` }),
    parse: (value: string) => ({ scheme: 'svn-anywhere-snapshot', path: value, toString: () => value }),
    joinPath: (base: { path: string }, ...parts: string[]) => {
      const path = [base.path.replace(/\/$/, ''), ...parts].join('/');
      return { scheme: 'file', path, fsPath: path, toString: () => `file://${path}` };
    },
  },
  window: {
    createOutputChannel: () => ({
      lines: [] as string[],
      appendLine() {},
      show() {},
      dispose() {},
    }),
    showInformationMessage: (message: string) => {
      vscodeMock.information.push(message);
      return Promise.resolve(undefined);
    },
    showWarningMessage: (message: string) => {
      vscodeMock.warning.push(message);
      return Promise.resolve(undefined);
    },
    showErrorMessage: (message: string) => {
      vscodeMock.errors.push(message);
      return Promise.resolve(undefined);
    },
    showOpenDialog: () => {
      vscodeMock.openDialogCalls += 1;
      return Promise.resolve(vscodeMock.openDialogResult);
    },
    showSaveDialog: () => Promise.resolve(
      vscodeMock.saveDialogResult === undefined
        ? undefined
        : { fsPath: vscodeMock.saveDialogResult, path: vscodeMock.saveDialogResult },
    ),
    get activeTextEditor() {
      return vscodeMock.activeTextEditor;
    },
    showOutput: () => Promise.resolve(undefined),
    createWebviewPanel: (_viewType: string, title: string) => {
      const panel = makeFakePanel(title);
      webviewPanels.push(panel);
      return panel;
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => (key === 'showOutputOnError' ? true : fallback),
    }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
  },
  commands: {
    registerCommand: (id: string, handler: (uri?: unknown) => unknown) => {
      if (vscodeMock.activeCommandIds.has(id)) {
        throw new Error(`command '${id}' already exists`);
      }
      vscodeMock.activeCommandIds.add(id);
      const disposable = {
        disposed: false,
        dispose() {
          vscodeMock.activeCommandIds.delete(id);
          disposable.disposed = true;
        },
      };
      vscodeMock.registered.push({ id, handler, disposable });
      return disposable;
    },
    executeCommand: async (command: string, ...args: unknown[]) => {
      vscodeMock.executed.push([command, ...args]);
      return undefined;
    },
  },
}));

import { createSvnLab, writeFile, type SvnLab } from './helpers';
import { resetOutputState } from '../src/host/output';
import { strings } from '../src/host/i18n';
import { resetPanelRegistry } from '../src/host/panel/host';
import { resetM4SessionStore } from '../src/host/sessionResults';
import {
  historyCompareForTest,
  historyModelForTest,
  historySessionSnapshot,
  openHistoryPanel,
  resetHistoryPanelController,
  setHistoryPanelContext,
} from '../src/host/panel/panels/history';
import {
  commandShowHistory,
  disposeShowHistoryCommandForTest,
  openHistoryTarget,
  registerShowHistoryCommand,
  resolveLocalHistoryTarget,
  setHistoryPanelOpener,
  type HistoryOpenTarget,
} from '../src/host/commands/history';
import type { HistoryHandoffPayload } from '../src/host/commands/browse';

const makeUri = (fsPath: string): vscode.Uri => ({ fsPath, scheme: 'file' }) as unknown as vscode.Uri;

let lab: SvnLab;
let wc: string;
let plainDir: string;
let context: vscode.ExtensionContext;

beforeEach(() => {
  resetOutputState();
  disposeShowHistoryCommandForTest();
  vscodeMock.information.length = 0;
  vscodeMock.warning.length = 0;
  vscodeMock.errors.length = 0;
  vscodeMock.openDialogCalls = 0;
  vscodeMock.openDialogResult = undefined;
  vscodeMock.activeTextEditor = undefined;
  vscodeMock.registered.length = 0;
  vscodeMock.activeCommandIds.clear();
  vscodeMock.executed.length = 0;
  vscodeMock.saveDialogResult = undefined;
  webviewPanels.length = 0;
  resetPanelRegistry();
  resetHistoryPanelController();
  resetM4SessionStore();
  context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

  lab = createSvnLab('svn-anywhere-history-cmd-');
  wc = lab.checkout('wc');
  writeFile(wc, 'dir/a.txt', 'line1\n', true);
  lab.svn(['commit', '-q', '-m', 'init'], wc);
  plainDir = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-history-plain-')));
});

afterEach(() => {
  resetHistoryPanelController();
  resetPanelRegistry();
  lab.cleanup();
  rmSync(plainDir, { recursive: true, force: true });
  setHistoryPanelOpener(undefined);
  disposeShowHistoryCommandForTest();
});

async function waitFor(check: () => boolean, attempts = 100): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(check()).toBe(true);
}

describe('resolveLocalHistoryTarget（本地真实 info）', () => {
  it('文件节点：URL/仓库根/UUID/相对路径/kind/BASE 齐备', async () => {
    const file = join(wc, 'dir', 'a.txt');
    const result = await resolveLocalHistoryTarget(file, 'svn');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      return;
    }
    const target = result.target;
    expect(target.wcRoot).toBe(realpathSync(wc));
    expect(target.localPath).toBe(file);
    expect(target.url.endsWith('/dir/a.txt')).toBe(true);
    expect(target.repositoryRootUrl.startsWith('file://')).toBe(true);
    expect(target.repositoryUuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(target.relativePath).toBe('dir/a.txt');
    expect(target.kind).toBe('file');
    expect(target.baseRevision).toBe(1);
  });

  it('目录节点 kind=dir；仓库根相对路径为空串', async () => {
    const dirResult = await resolveLocalHistoryTarget(join(wc, 'dir'), 'svn');
    expect(dirResult.status).toBe('ok');
    if (dirResult.status === 'ok') {
      expect(dirResult.target.kind).toBe('dir');
      expect(dirResult.target.relativePath).toBe('dir');
    }
    const rootResult = await resolveLocalHistoryTarget(wc, 'svn');
    expect(rootResult.status).toBe('ok');
    if (rootResult.status === 'ok') {
      expect(rootResult.target.relativePath).toBe('');
      expect(rootResult.target.kind).toBe('dir');
    }
  });

  it('不在任何工作副本内 → notWorkingCopy', async () => {
    const result = await resolveLocalHistoryTarget(plainDir, 'svn');
    expect(result.status).toBe('notWorkingCopy');
  });

  it('副本内未纳入版本控制的文件 → unversioned', async () => {
    writeFile(wc, 'plain.txt', 'x');
    const result = await resolveLocalHistoryTarget(join(wc, 'plain.txt'), 'svn');
    expect(result.status).toBe('unversioned');
    if (result.status === 'unversioned') {
      expect(result.message).toBeTruthy();
    }
  });
});

describe('commandShowHistory 入口', () => {
  it('资源管理器 uri：解析本地目标并交给注入的 P6 打开器', async () => {
    const received: HistoryOpenTarget[] = [];
    setHistoryPanelOpener((target) => {
      received.push(target);
    });
    await commandShowHistory(makeUri(join(wc, 'dir', 'a.txt')));
    expect(received).toHaveLength(1);
    expect(received[0].source).toBe('local');
    if (received[0].source === 'local') {
      expect(received[0].relativePath).toBe('dir/a.txt');
      expect(received[0].baseRevision).toBe(1);
    }
    expect(vscodeMock.information).toHaveLength(0);
  });

  it('无 uri 且活动编辑器是 file 文档：用编辑器路径，不弹选择框', async () => {
    const received: HistoryOpenTarget[] = [];
    setHistoryPanelOpener((target) => {
      received.push(target);
    });
    vscodeMock.activeTextEditor = {
      document: { uri: { scheme: 'file', fsPath: join(wc, 'dir', 'a.txt') } },
    };
    await commandShowHistory(undefined);
    expect(received).toHaveLength(1);
    expect(vscodeMock.openDialogCalls).toBe(0);
  });

  it('命令面板（无 uri/无编辑器）：选择框取消则静默返回', async () => {
    const received: HistoryOpenTarget[] = [];
    setHistoryPanelOpener((target) => {
      received.push(target);
    });
    await commandShowHistory(undefined);
    expect(vscodeMock.openDialogCalls).toBe(1);
    expect(received).toHaveLength(0);
    expect(vscodeMock.information).toHaveLength(0);
  });

  it('不在副本内：信息提示且不调用打开器', async () => {
    const received: HistoryOpenTarget[] = [];
    setHistoryPanelOpener((target) => {
      received.push(target);
    });
    await commandShowHistory(makeUri(plainDir));
    expect(received).toHaveLength(0);
    expect(vscodeMock.information).toEqual([strings.historyCommand.notWorkingCopy]);
  });

  it('未接入打开器：给出明确提示，不静默吞掉动作', async () => {
    await commandShowHistory(makeUri(join(wc, 'dir', 'a.txt')));
    expect(vscodeMock.information).toEqual([strings.historyCommand.panelNotReady]);
  });
});

describe('openHistoryTarget 与 P5 交接载荷', () => {
  it('handoff 载荷原样交给打开器（仅节点身份与快照 revision）', async () => {
    const received: HistoryOpenTarget[] = [];
    setHistoryPanelOpener((target) => {
      received.push(target);
    });
    const payload: HistoryHandoffPayload = {
      kind: 'file',
      repositoryUuid: 'uuid-1',
      repositoryRootUrl: 'https://example.com/repo',
      rawUrl: 'https://example.com/repo/trunk/a.txt',
      relativePath: 'trunk/a.txt',
      snapshotRevision: 30,
    };
    await openHistoryTarget({ source: 'handoff', payload });
    expect(received).toEqual([{ source: 'handoff', payload }]);
  });

  it('注册 showHistory 命令：重复注册先释放上次句柄', () => {
    registerShowHistoryCommand(context);
    expect(vscodeMock.registered.map((entry) => entry.id)).toEqual(['svnAnywhere.showHistory']);
    expect(context.subscriptions).toHaveLength(1);
    const first = vscodeMock.registered[0];
    registerShowHistoryCommand(context);
    expect(first.disposable.disposed).toBe(true);
    expect(vscodeMock.activeCommandIds.size).toBe(1);
    expect(vscodeMock.registered).toHaveLength(2);
  });
});

describe('本地目标端到端（真实 svn file:// 仓库）', () => {
  it('打开 → 首批 → 选择历史 revision 详情 → reset 重读', async () => {
    writeFile(wc, 'dir/a.txt', 'line2\n');
    lab.svn(['commit', '-q', '-m', 'second'], wc);
    const file = join(wc, 'dir', 'a.txt');
    const resolved = await resolveLocalHistoryTarget(file, 'svn');
    expect(resolved.status).toBe('ok');
    if (resolved.status !== 'ok') {
      return;
    }
    setHistoryPanelContext({
      extensionUri: { scheme: 'file', path: '/extension' } as unknown as vscode.Uri,
      subscriptions: [],
    });
    await openHistoryPanel({ source: 'local', ...resolved.target });
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);

    // HEAD=2，目标在该 revision 存在：target 源直接返回 r2、r1。
    expect(historySessionSnapshot()).toMatchObject({
      upperRevision: 2,
      upperSource: 'live-head',
      headState: 'available',
      loadedMatchedCount: 2,
    });
    const panel = webviewPanels[webviewPanels.length - 1];
    const html = panel.latestRenderHtml();
    expect(html).toContain('>r2<');
    expect(html).toContain('>r1<');
    expect(html).toContain('BASE r2');

    // 选择 r1：真实 info 解析为 present。
    panel.sendIntent({ kind: 'selectHistoryRevision', id: 'r1' });
    await waitFor(() => historyModelForTest()?.detailState()?.resolution.status === 'present');
    expect(historyModelForTest()?.detailState()?.revision).toBe(1);

    // reset：upper 三字段保持、重读首批。
    const before = historySessionSnapshot();
    panel.sendIntent({ kind: 'resetHistorySession' });
    await waitFor(() => historySessionSnapshot().phase === 'ready'
      && historySessionSnapshot().loadedMatchedCount === 2);
    const after = historySessionSnapshot();
    expect(after.upperRevision).toBe(before.upperRevision);
    expect(after.upperSource).toBe(before.upperSource);
    expect(after.headState).toBe(before.headState);
  });

  it('勾选两项比较 → 候选表 → 选中候选 → 原生文本差异 → 关闭比较', async () => {
    writeFile(wc, 'dir/a.txt', 'line2\n');
    lab.svn(['commit', '-q', '-m', 'second'], wc);
    const file = join(wc, 'dir', 'a.txt');
    const resolved = await resolveLocalHistoryTarget(file, 'svn');
    expect(resolved.status).toBe('ok');
    if (resolved.status !== 'ok') {
      return;
    }
    setHistoryPanelContext({
      extensionUri: { scheme: 'file', path: '/extension' } as unknown as vscode.Uri,
      subscriptions: [],
    });
    await openHistoryPanel({ source: 'local', ...resolved.target });
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);
    const panel = webviewPanels[webviewPanels.length - 1];

    // 勾选 r2/r1 后比较：两端实际快照 summarize 产生一个内容变更候选。
    panel.sendIntent({ kind: 'toggleHistoryRevision', id: 'r2' });
    panel.sendIntent({ kind: 'toggleHistoryRevision', id: 'r1' });
    await waitFor(() => historySessionSnapshot().selection.length === 2);
    panel.sendIntent({ kind: 'compareHistoryRevisions' });
    await waitFor(() => historyCompareForTest()?.phase === 'ready');
    expect(historyCompareForTest()).toMatchObject({
      phase: 'ready',
      leftRevision: 1,
      rightRevision: 2,
      candidates: 1,
      selectedId: null,
    });
    expect(panel.latestRenderHtml()).toContain('data-table-id="snapshotCandidates"');
    expect(panel.latestRenderHtml()).toContain('内容变更');

    // 选择候选：只更新选中与候选详情（不重新请求比较）。
    panel.sendIntent({ kind: 'selectCompareCandidate', id: 'c0' });
    await waitFor(() => historyCompareForTest()?.selectedId === 'c0');
    expect(panel.latestRenderHtml()).toContain('打开差异');

    // 打开差异：真实内容经只读 provider 交给 vscode.diff。
    panel.sendIntent({ kind: 'openHistoryDiff' });
    await waitFor(() => vscodeMock.executed.some((call) => call[0] === 'vscode.diff'));

    // 关闭比较：回到历史列表（比较状态清空）。
    panel.sendIntent({ kind: 'bannerAction', bannerId: 'historyCompare', actionId: 'historyCompareClose' });
    await waitFor(() => historyCompareForTest() === undefined);
    expect(panel.latestRenderHtml()).toContain('data-table-id="history"');
  });

  it('导出历史版本：真实 svn export 写到保存对话框选择的目标', async () => {
    writeFile(wc, 'dir/a.txt', 'line2\n');
    lab.svn(['commit', '-q', '-m', 'second'], wc);
    const file = join(wc, 'dir', 'a.txt');
    const resolved = await resolveLocalHistoryTarget(file, 'svn');
    expect(resolved.status).toBe('ok');
    if (resolved.status !== 'ok') {
      return;
    }
    setHistoryPanelContext({
      extensionUri: { scheme: 'file', path: '/extension' } as unknown as vscode.Uri,
      subscriptions: [],
    });
    await openHistoryPanel({ source: 'local', ...resolved.target });
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);
    const panel = webviewPanels[webviewPanels.length - 1];

    panel.sendIntent({ kind: 'selectHistoryRevision', id: 'r2' });
    await waitFor(() => historyModelForTest()?.detailState()?.resolution.status === 'present');
    const targetPath = join(plainDir, 'exported-a.txt');
    vscodeMock.saveDialogResult = targetPath;
    panel.sendIntent({ kind: 'exportHistoryVersion' });
    for (let index = 0; index < 100; index += 1) {
      if (existsSync(targetPath)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await waitFor(() => readFileSync(targetPath, 'utf8') === 'line2\n');
    expect(panel.toasts().some((message) => message.includes('已导出到'))).toBe(true);
  });
});
