/**
 * P6 历史面板控制器（panels/history.ts）flow 测试：mock vscode（面板替身/
 * 剪贴板/配置）与 SVN 命令层（runOrThrow 供控制器、run 供 core/history 的
 * 节点解析），从面板打开与意图驱动：
 * - 本地入口：HEAD → 目标存在性 → 首批 log；请求参数（-l pageSize+1、
 *   -r upper:1、URL@upper）与请发命令次序；
 * - HEAD 失败且有本地 BASE → unresolved（HEAD 暂不可用 + BASE 上限入口）；
 * - base-fallback 成功进入结果、log 失败保留三字段与已加载数据（HLS-6）；
 * - reset：live-head 保持 available 且不重读 HEAD、重读首批；unresolved 被拒；
 * - refresh head：已最新保留数据、前进重读、失败保留数据、来源恢复；
 * - P5 快照会话不读 HEAD、reset 不收新 HEAD、refresh 被模型校验拒绝；
 * - 筛选/勾选/详情/复制/比较接线/关闭重开恢复/旧目标回包丢弃/加载更多。
 * 远端命令的 `--non-interactive` 由 core 原语测试覆盖；本文件校验控制器
 * 传入的 revision/cursor 与命令形态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

/* ------------------------------ vscode 替身 ------------------------------ */

interface VscodeMockState {
  information: string[];
  warning: string[];
  errors: string[];
  clipboard: string[];
  panels: FakePanel[];
  config: Record<string, unknown>;
}

const vscodeMock: VscodeMockState = {
  information: [],
  warning: [],
  errors: [],
  clipboard: [],
  panels: [],
  config: {},
};

vi.mock('vscode', () => ({
  ViewColumn: { Active: 1, Beside: 2 },
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  Uri: {
    file: (path: string) => ({ scheme: 'file', path, fsPath: path, toString: () => `file://${path}` }),
    parse: (value: string) => ({ scheme: 'file', path: value, toString: () => value }),
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
    showInputBox: () => Promise.resolve(undefined),
    showQuickPick: () => Promise.resolve(undefined),
    showTextDocument: () => Promise.resolve(undefined),
    createWebviewPanel: (_viewType: string, title: string) => {
      const panel = makeFakePanel(title);
      vscodeMock.panels.push(panel);
      return panel;
    },
    get activeTextEditor() {
      return undefined;
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => (key in vscodeMock.config ? vscodeMock.config[key] : fallback),
    }),
    get workspaceFolders() {
      return [];
    },
    onDidCloseTextDocument: () => ({ dispose() {} }),
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
  },
  env: {
    clipboard: {
      writeText: (value: string) => {
        vscodeMock.clipboard.push(value);
        return Promise.resolve();
      },
    },
    openExternal: () => Promise.resolve(true),
  },
  commands: {
    executeCommand: async () => undefined,
  },
  ProgressLocation: { Notification: 15 },
}));

vi.mock('../src/core/svnCli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/svnCli')>();
  return { ...actual, run: vi.fn(), runOrThrow: vi.fn() };
});

vi.mock('../src/host/auth', () => ({
  credentialProvider: () => vi.fn(),
}));

// 比较结果区/导出/检出交接的外部依赖：控制器接线只断言「按契约调用」，
// 真实 svn 快照比较与导出由 snapshotModel/snapshotView 与 historyCommand
// 的真实 file:// 端到端用例覆盖。
vi.mock('../src/host/panel/snapshotModel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/panel/snapshotModel')>();
  return {
    ...actual,
    loadSnapshotCompare: vi.fn(),
    planSnapshotBaseCompare: vi.fn(),
    planSnapshotExport: vi.fn(),
  };
});

vi.mock('../src/host/diffView', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/diffView')>();
  return {
    ...actual,
    openSnapshotTextDiff: vi.fn(),
    openSnapshotNodeContent: vi.fn(),
    openSnapshotBaseCompareEntry: vi.fn(),
    promptSnapshotExport: vi.fn(),
  };
});

vi.mock('../src/host/panel/panels/checkout', () => ({
  openCheckoutPanelFromHistory: vi.fn(),
}));

import { run, runOrThrow } from '../src/core/svnCli';
import { SvnError, extractSvnErrorCodes } from '../src/core/errors';
import { openSnapshotBaseCompareEntry } from '../src/host/diffView';
import { openCheckoutPanelFromHistory } from '../src/host/panel/panels/checkout';
import { planSnapshotBaseCompare } from '../src/host/panel/snapshotModel';
import { resetPanelRegistry } from '../src/host/panel/host';
import { resetM4SessionStore } from '../src/host/sessionResults';
import { resetOutputState } from '../src/host/output';
import {
  historyModelForTest,
  historySessionSnapshot,
  openHistoryPanel,
  resetHistoryPanelController,
  setHistoryComparisonRunner,
  setHistoryPanelContext,
} from '../src/host/panel/panels/history';
import type { HistoryOpenTarget } from '../src/host/commands/history';

/* ------------------------------ 面板替身 ------------------------------ */

interface FakePanel {
  title: string;
  html: string;
  posted: Array<Record<string, unknown>>;
  revealed: number;
  disposed: boolean;
  reveal(): void;
  dispose(): void;
  send(raw: unknown): Promise<void> | void;
  sendIntent(intent: Record<string, unknown>, requestId?: string): void;
  latestRenderHtml(): string;
  toasts(): string[];
}

function makeFakePanel(title: string): FakePanel {
  let messageHandler: ((raw: unknown) => unknown) | undefined;
  let disposeHandler: (() => void) | undefined;
  let sessionId = '';
  let seq = 0;
  const panel: FakePanel = {
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
    send(raw) {
      return messageHandler?.(raw) as void | Promise<void>;
    },
    sendIntent(intent, requestId) {
      seq += 1;
      return panel.send({
        type: 'intent',
        protocolVersion: 1,
        sessionId,
        requestId: requestId || `req-${seq}`,
        intent,
      }) as void;
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
      panel.html = value;
    },
    get html() {
      return panel.html;
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

function fakePanel(): FakePanel {
  const panel = vscodeMock.panels[vscodeMock.panels.length - 1];
  expect(panel).toBeDefined();
  return panel;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(check: () => boolean, attempts = 80): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBe(true);
}

/* ------------------------------ SVN 命令替身 ------------------------------ */

interface ParsedCommand {
  kind: 'info' | 'log' | 'other';
  url: string;
  revision?: number;
  limit?: number;
  cursor?: number;
}

function parseCommand(args: string[]): ParsedCommand {
  const kind = args[0] === 'info' ? 'info' : args[0] === 'log' ? 'log' : 'other';
  const separator = args.lastIndexOf('--');
  let url = separator >= 0 ? (args[separator + 1] ?? '') : '';
  // urlWithPeg 构造为 `url@peg`（无 revision 时也追加空 peg）：剥掉尾部
  // peg 再按节点 URL 匹配（字面 @ 在路径中间，不影响尾部锚定）。
  url = url.replace(/@\d*$/, '');
  const revisionIndex = args.indexOf('-r');
  const range = revisionIndex >= 0 ? args[revisionIndex + 1] : undefined;
  const parsed: ParsedCommand = { kind, url };
  if (kind === 'info' && range !== undefined) {
    parsed.revision = Number(range);
  }
  if (kind === 'log') {
    const limitIndex = args.indexOf('-l');
    if (limitIndex >= 0) {
      parsed.limit = Number(args[limitIndex + 1]);
    }
    if (range !== undefined) {
      parsed.cursor = Number(range.split(':')[0]);
    }
  }
  return parsed;
}

type Reply = { ok: true; xml: string } | { ok: false; stderr: string };

const svnCalls: ParsedCommand[] = [];
let infoHandler: (request: ParsedCommand) => Reply;
let logHandler: (request: ParsedCommand) => Reply | Promise<Reply>;
let detailInfoHandler: (request: ParsedCommand) => Reply | Promise<Reply>;

function failStderr(codes: string[]): string {
  return codes.map((code) => `svn: ${code}: 模拟失败`).join('\n');
}

function svnError(args: string[], stderr: string): SvnError {
  return new SvnError({
    message: stderr.split('\n')[0] ?? 'svn 失败',
    command: args,
    stderr,
    exitCode: 1,
    code: extractSvnErrorCodes(stderr)[0],
  });
}

function resetSvnStub(): void {
  svnCalls.length = 0;
  infoHandler = () => ({ ok: false, stderr: failStderr(['E170013', 'E180001']) });
  logHandler = () => ({ ok: true, xml: '<log></log>' });
  detailInfoHandler = () => ({ ok: false, stderr: failStderr(['W170000', 'E200009']) });
  vi.mocked(runOrThrow).mockImplementation(async (_svnPath, args) => {
    const request = parseCommand(args);
    svnCalls.push(request);
    const reply = request.kind === 'info' ? infoHandler(request) : await logHandler(request);
    if (!reply.ok) {
      throw svnError(args, reply.stderr);
    }
    return { stdout: reply.xml, stderr: '', exitCode: 0 };
  });
  vi.mocked(run).mockImplementation(async (_svnPath, args) => {
    const request = parseCommand(args);
    const reply = await detailInfoHandler(request);
    return reply.ok
      ? { stdout: reply.xml, stderr: '', exitCode: 0 }
      : { stdout: '', stderr: reply.stderr, exitCode: 1 };
  });
}

/* ------------------------------ fixture ------------------------------ */

const ROOT = 'https://example.com/repo';
const NODE = `${ROOT}/trunk/a.txt`;

function infoXml(url: string, revision: number, kind: 'file' | 'dir' = 'file'): string {
  return `<info><entry kind="${kind}" path="x" revision="${revision}">` +
    `<url>${url}</url>` +
    `<repository><root>${ROOT}</root><uuid>uuid-1</uuid></repository>` +
    `<commit revision="${revision}"><author>alice</author><date>2026-11-01T10:00:00.000000Z</date></commit>` +
    `</entry></info>`;
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function logXml(entries: Array<{
  revision: number;
  author?: string;
  message?: string;
  paths?: Array<{ path: string; action?: string; copyfrom?: string; copyfromRev?: number }>;
}>): string {
  const items = entries.map((entry) => {
    const paths = (entry.paths ?? [{ path: '/trunk/a.txt' }]).map((change) =>
      `<path action="${change.action ?? 'M'}" kind="file"` +
      `${change.copyfrom !== undefined ? ` copyfrom-path="${change.copyfrom}" copyfrom-rev="${change.copyfromRev ?? 1}"` : ''}` +
      `>${change.path}</path>`).join('');
    return `<logentry revision="${entry.revision}">` +
      `<author>${entry.author ?? 'alice'}</author>` +
      `<date>2026-11-01T10:00:00.000000Z</date>` +
      `<msg>${escapeXml(entry.message ?? `提交 r${entry.revision}`)}</msg>` +
      `<paths>${paths}</paths></logentry>`;
  }).join('');
  return `<log>${entries.length > 0 ? items : ''}</log>`;
}

function localTarget(overrides: Partial<Extract<HistoryOpenTarget, { source: 'local' }>> = {}): HistoryOpenTarget {
  return {
    source: 'local',
    wcRoot: '/wc',
    localPath: '/wc/trunk/a.txt',
    url: NODE,
    repositoryRootUrl: ROOT,
    repositoryUuid: 'uuid-1',
    relativePath: 'trunk/a.txt',
    kind: 'file',
    baseRevision: 40,
    ...overrides,
  };
}

function handoffTarget(snapshotRevision = 30): HistoryOpenTarget {
  return {
    source: 'handoff',
    payload: {
      kind: 'file',
      repositoryUuid: 'uuid-1',
      repositoryRootUrl: ROOT,
      rawUrl: NODE,
      relativePath: 'trunk/a.txt',
      snapshotRevision,
    },
  };
}

function handoffDirTarget(snapshotRevision = 30): HistoryOpenTarget {
  return {
    source: 'handoff',
    payload: {
      kind: 'dir',
      repositoryUuid: 'uuid-1',
      repositoryRootUrl: ROOT,
      rawUrl: `${ROOT}/trunk`,
      relativePath: 'trunk',
      snapshotRevision,
    },
  };
}

/** 标准 HEAD/目标存在性响应（HEAD=42、目标存在）。 */
function standardInfo(head = 42): (request: ParsedCommand) => Reply {
  return (request) => {
    if (request.url === ROOT || request.url === `${ROOT}/`) {
      return { ok: true, xml: infoXml(ROOT, head, 'dir') };
    }
    if (request.url === NODE) {
      return { ok: true, xml: infoXml(NODE, request.revision ?? head) };
    }
    return { ok: false, stderr: failStderr(['W170000', 'E200009']) };
  };
}

function commandNames(): string[] {
  return svnCalls.map((call) => call.kind);
}

/* ------------------------------ 用例环境 ------------------------------ */

beforeEach(() => {
  resetPanelRegistry();
  resetHistoryPanelController();
  resetM4SessionStore();
  resetOutputState();
  vscodeMock.information.length = 0;
  vscodeMock.warning.length = 0;
  vscodeMock.errors.length = 0;
  vscodeMock.clipboard.length = 0;
  vscodeMock.panels.length = 0;
  vscodeMock.config = {};
  resetSvnStub();
  vi.mocked(planSnapshotBaseCompare).mockReset();
  vi.mocked(openSnapshotBaseCompareEntry).mockReset();
  vi.mocked(openCheckoutPanelFromHistory).mockReset();
  vi.mocked(openCheckoutPanelFromHistory).mockResolvedValue({ ok: true });
  setHistoryPanelContext({
    extensionUri: { scheme: 'file', path: '/extension' } as unknown as vscode.Uri,
    subscriptions: [],
  });
});

afterEach(() => {
  resetHistoryPanelController();
  resetPanelRegistry();
});

/* ------------------------------ 打开 ------------------------------ */

describe('本地入口打开', () => {
  it('HEAD → 目标存在性 → 首批 log：请求参数与表格上屏', async () => {
    infoHandler = standardInfo(42);
    logHandler = () => ({ ok: true, xml: logXml([{ revision: 41 }, { revision: 40 }]) });

    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);

    expect(commandNames()).toEqual(['info', 'info', 'log']);
    expect(svnCalls[0].url).toBe(ROOT);
    expect(svnCalls[0].revision).toBeUndefined();
    expect(svnCalls[1].url).toBe(NODE);
    expect(svnCalls[1].revision).toBe(42);
    expect(svnCalls[2]).toMatchObject({ kind: 'log', cursor: 42, limit: 51 });

    const snapshot = historySessionSnapshot();
    expect(snapshot).toMatchObject({
      phase: 'ready',
      upperRevision: 42,
      upperSource: 'live-head',
      headState: 'available',
      loadedMatchedCount: 2,
      displayedCount: 2,
    });
    const html = fakePanel().latestRenderHtml();
    expect(html).toContain('data-intent="selectHistoryRevision"');
    expect(html).toContain('>r41<');
    expect(html).toContain('>r40<');
    expect(html).toContain('HEAD r42');
    expect(html).toContain('BASE r40');
    expect(html).toContain(`data-intent="loadMoreHistory"`);
  });

  it('空历史（目标存在、log 成功但零记录）显示空态', async () => {
    infoHandler = standardInfo(42);
    logHandler = () => ({ ok: true, xml: logXml([]) });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().phase === 'ready');
    expect(historySessionSnapshot().hasLoadedData).toBe(false);
    expect(fakePanel().latestRenderHtml()).toContain('没有历史记录');
  });

  it('HEAD 失败且有本地 BASE：unresolved 会话、HEAD 暂不可用与 BASE 上限入口', async () => {
    infoHandler = () => ({ ok: false, stderr: failStderr(['E170013', 'E120108']) });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().phase === 'ready');

    expect(historySessionSnapshot()).toMatchObject({
      upperRevision: null,
      upperSource: 'unresolved',
      headState: 'unavailable',
      hasLoadedData: false,
    });
    const html = fakePanel().latestRenderHtml();
    expect(html).toContain('HEAD 暂不可用');
    expect(html).toContain('尝试按 BASE 上限查看');
    expect(html).toContain('HEAD 未知');
    // 只有 HEAD info 一次，不进入目标存在性与 log。
    expect(commandNames()).toEqual(['info']);

    // 消息层直接构造非法 mode：协议层拒绝（不会到达控制器）。
    fakePanel().sendIntent({ kind: 'refreshHistoryUpper', mode: 'full' });
    await flush();
    expect(svnCalls).toHaveLength(1);
  });
});

describe('base-fallback（HLS-6）', () => {
  it('成功：三字段固定 BASEr/unavailable 并进入结果', async () => {
    infoHandler = (request) => {
      if (request.url === ROOT) {
        return { ok: false, stderr: failStderr(['E170013', 'E120108']) };
      }
      return { ok: true, xml: infoXml(NODE, request.revision ?? 40) };
    };
    logHandler = () => ({ ok: true, xml: logXml([{ revision: 39 }, { revision: 38 }]) });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().phase === 'ready');

    fakePanel().sendIntent({ kind: 'refreshHistoryUpper', mode: 'base-fallback' });
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);

    expect(historySessionSnapshot()).toMatchObject({
      upperRevision: 40,
      upperSource: 'base-fallback',
      headState: 'unavailable',
      loadedMatchedCount: 2,
    });
    const html = fakePanel().latestRenderHtml();
    expect(html).toContain('BASE 上限 r40');
    // 探测 info 带 BASE revision，log cursor=BASE。
    expect(svnCalls.some((call) => call.kind === 'info' && call.revision === 40)).toBe(true);
    expect(svnCalls.some((call) => call.kind === 'log' && call.cursor === 40)).toBe(true);
  });

  it('第二次 base-fallback 的 log 失败：三字段与已加载数据不变', async () => {
    let logFails = false;
    infoHandler = (request) => {
      if (request.url === ROOT) {
        return { ok: false, stderr: failStderr(['E170013', 'E120108']) };
      }
      return { ok: true, xml: infoXml(NODE, request.revision ?? 40) };
    };
    logHandler = () => (logFails
      ? { ok: false, stderr: failStderr(['E170013', 'E120108']) }
      : { ok: true, xml: logXml([{ revision: 39 }, { revision: 38 }]) });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().phase === 'ready');
    fakePanel().sendIntent({ kind: 'refreshHistoryUpper', mode: 'base-fallback' });
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);
    const before = historySessionSnapshot();

    logFails = true;
    fakePanel().sendIntent({ kind: 'refreshHistoryUpper', mode: 'base-fallback' });
    await waitFor(() => fakePanel().toasts().some((message) => message.includes('按 BASE 上限读取失败')));

    const after = historySessionSnapshot();
    expect(after.upperRevision).toBe(before.upperRevision);
    expect(after.upperSource).toBe(before.upperSource);
    expect(after.headState).toBe(before.headState);
    expect(after.loadedMatchedCount).toBe(before.loadedMatchedCount);
    expect(after.displayedCount).toBe(before.displayedCount);
    expect(after.hasLoadedData).toBe(true);
  });

  it('live-head 会话拒绝 base-fallback（不发 info/log）', async () => {
    infoHandler = standardInfo(42);
    logHandler = () => ({ ok: true, xml: logXml([{ revision: 41 }]) });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);
    const callsBefore = svnCalls.length;

    fakePanel().sendIntent({ kind: 'refreshHistoryUpper', mode: 'base-fallback' });
    await waitFor(() => fakePanel().toasts().some((message) => message.includes('不能按 BASE 上限查看')));
    expect(svnCalls).toHaveLength(callsBefore);
    expect(historySessionSnapshot().upperSource).toBe('live-head');
  });
});

describe('resetHistorySession（HLS-6）', () => {
  it('live-head reset：headState=available 保持、不重读 HEAD、重读首批', async () => {
    infoHandler = standardInfo(42);
    logHandler = () => ({ ok: true, xml: logXml([{ revision: 41 }, { revision: 40 }]) });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);
    const infoCalls = svnCalls.filter((call) => call.kind === 'info').length;

    fakePanel().sendIntent({ kind: 'resetHistorySession' });
    await waitFor(() => historySessionSnapshot().hasLoadedData === true
      && svnCalls.filter((call) => call.kind === 'log').length === 2);

    const snapshot = historySessionSnapshot();
    expect(snapshot).toMatchObject({
      upperRevision: 42,
      upperSource: 'live-head',
      headState: 'available',
      loadedMatchedCount: 2,
      displayedCount: 2,
    });
    // reset 不重新解析 HEAD：info 调用数不变，只新增一次 log。
    expect(svnCalls.filter((call) => call.kind === 'info').length).toBe(infoCalls);
    const lastLog = svnCalls.filter((call) => call.kind === 'log').at(-1)!;
    expect(lastLog.cursor).toBe(42);
  });

  it('unresolved reset 被拒：toast 提示且三字段不变', async () => {
    infoHandler = () => ({ ok: false, stderr: failStderr(['E170013', 'E120108']) });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().phase === 'ready');
    const callsBefore = svnCalls.length;

    fakePanel().sendIntent({ kind: 'resetHistorySession' });
    await waitFor(() => fakePanel().toasts().some((message) => message.includes('暂不能重置')));
    expect(svnCalls).toHaveLength(callsBefore);
    expect(historySessionSnapshot()).toMatchObject({
      upperRevision: null,
      upperSource: 'unresolved',
      headState: 'unavailable',
    });
  });
});

describe('refreshHistoryUpper（head）', () => {
  it('live-head 同 HEAD：提示已最新且保留已加载数据', async () => {
    infoHandler = standardInfo(42);
    logHandler = () => ({ ok: true, xml: logXml([{ revision: 41 }]) });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);

    fakePanel().sendIntent({ kind: 'refreshHistoryUpper', mode: 'head' });
    await waitFor(() => fakePanel().toasts().some((message) => message.includes('已是最新')));
    expect(historySessionSnapshot()).toMatchObject({ upperRevision: 42, loadedMatchedCount: 1 });
  });

  it('HEAD 前进：更新 upper 并重读首批（保留筛选）', async () => {
    let head = 42;
    infoHandler = (request) => {
      if (request.url === ROOT) {
        return { ok: true, xml: infoXml(ROOT, head, 'dir') };
      }
      return { ok: true, xml: infoXml(NODE, request.revision ?? head) };
    };
    logHandler = () => ({ ok: true, xml: logXml([{ revision: head - 1, message: '修复 登录' }]) });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);
    fakePanel().sendIntent({ kind: 'setHistoryFilter', id: 'keyword', value: '登录' });
    await flush();

    head = 45;
    fakePanel().sendIntent({ kind: 'refreshHistoryUpper', mode: 'head' });
    await waitFor(() => historySessionSnapshot().upperRevision === 45
      && historySessionSnapshot().hasLoadedData === true);

    const snapshot = historySessionSnapshot();
    expect(snapshot.upperSource).toBe('live-head');
    expect(snapshot.filter?.keyword).toBe('登录');
    expect(svnCalls.filter((call) => call.kind === 'log').at(-1)?.cursor).toBe(45);
  });

  it('HEAD 失败：保留 rN 与已加载数据并提示可重试错误', async () => {
    let headFails = false;
    infoHandler = (request) => {
      if (request.url === ROOT) {
        return headFails
          ? { ok: false, stderr: failStderr(['E170013', 'E120108']) }
          : { ok: true, xml: infoXml(ROOT, 42, 'dir') };
      }
      return { ok: true, xml: infoXml(NODE, request.revision ?? 42) };
    };
    logHandler = () => ({ ok: true, xml: logXml([{ revision: 41 }]) });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);

    headFails = true;
    fakePanel().sendIntent({ kind: 'refreshHistoryUpper', mode: 'head' });
    await waitFor(() => fakePanel().toasts().some((message) => message.includes('HEAD 刷新失败')));
    expect(historySessionSnapshot()).toMatchObject({ upperRevision: 42, loadedMatchedCount: 1 });
  });

  it('base-fallback 来源恢复到 live-head（同值也更新来源并清数据重读）', async () => {
    let headFails = true;
    infoHandler = (request) => {
      if (request.url === ROOT) {
        return headFails
          ? { ok: false, stderr: failStderr(['E170013', 'E120108']) }
          : { ok: true, xml: infoXml(ROOT, 40, 'dir') };
      }
      return { ok: true, xml: infoXml(NODE, request.revision ?? 40) };
    };
    logHandler = () => ({ ok: true, xml: logXml([{ revision: 39 }]) });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().phase === 'ready');
    fakePanel().sendIntent({ kind: 'refreshHistoryUpper', mode: 'base-fallback' });
    await waitFor(() => historySessionSnapshot().upperSource === 'base-fallback'
      && historySessionSnapshot().hasLoadedData === true);

    headFails = false;
    fakePanel().sendIntent({ kind: 'refreshHistoryUpper', mode: 'head' });
    await waitFor(() => historySessionSnapshot().upperSource === 'live-head'
      && historySessionSnapshot().headState === 'available');
    expect(historySessionSnapshot().upperRevision).toBe(40);
    expect(fakePanel().toasts().some((message) => message.includes('已按 HEAD 刷新'))).toBe(true);
  });
});

describe('P5 快照交接', () => {
  it('固定 snapshotRevision、不读 HEAD；footer 无 refreshHistoryUpper', async () => {
    infoHandler = (request) => {
      if (request.url === NODE) {
        return { ok: true, xml: infoXml(NODE, request.revision ?? 30) };
      }
      return { ok: false, stderr: failStderr(['W170000', 'E200009']) };
    };
    logHandler = () => ({ ok: true, xml: logXml([{ revision: 29 }]) });
    await openHistoryPanel(handoffTarget(30));
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);

    const snapshot = historySessionSnapshot();
    expect(snapshot).toMatchObject({
      source: 'handoff',
      upperRevision: 30,
      upperSource: 'snapshot',
      headState: 'unknown',
    });
    // 没有对仓库根的无 revision info（HEAD）请求。
    expect(svnCalls.some((call) => call.kind === 'info' && call.url === ROOT)).toBe(false);
    expect(svnCalls.filter((call) => call.kind === 'log')[0]?.cursor).toBe(30);
    const html = fakePanel().latestRenderHtml();
    expect(html).toContain('快照 r30');
    expect(html).not.toContain('data-intent="refreshHistoryUpper"');
    expect(html).toContain('data-intent="resetHistorySession"');
  });

  it('快照会话 refreshHistoryUpper(head) 被模型校验拒绝且不发命令', async () => {
    infoHandler = (request) => ({ ok: true, xml: infoXml(NODE, request.revision ?? 30) });
    logHandler = () => ({ ok: true, xml: logXml([{ revision: 29 }]) });
    await openHistoryPanel(handoffTarget(30));
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);
    const callsBefore = svnCalls.length;

    fakePanel().sendIntent({ kind: 'refreshHistoryUpper', mode: 'head' });
    await flush();
    expect(svnCalls).toHaveLength(callsBefore);
    expect(historySessionSnapshot().upperSource).toBe('snapshot');
  });

  it('快照会话 reset：upper 仍为原快照并重读首批', async () => {
    infoHandler = (request) => ({ ok: true, xml: infoXml(NODE, request.revision ?? 30) });
    logHandler = () => ({ ok: true, xml: logXml([{ revision: 29 }]) });
    await openHistoryPanel(handoffTarget(30));
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);

    fakePanel().sendIntent({ kind: 'resetHistorySession' });
    await waitFor(() => svnCalls.filter((call) => call.kind === 'log').length === 2
      && historySessionSnapshot().loadedMatchedCount === 1);
    expect(historySessionSnapshot()).toMatchObject({
      upperRevision: 30,
      upperSource: 'snapshot',
      loadedMatchedCount: 1,
    });
  });
});

describe('筛选、勾选与详情', () => {
  async function openWithEntries(): Promise<void> {
    infoHandler = standardInfo(42);
    logHandler = () => ({
      ok: true,
      xml: logXml([
        { revision: 41, author: 'alice', message: '修复 登录' },
        { revision: 40, author: 'bob', message: '初始化' },
        { revision: 39, author: 'alice', message: '文档' },
      ]),
    });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);
  }

  it('筛选变化：清不可见勾选与详情、不发网络、不自动选第一条', async () => {
    await openWithEntries();
    fakePanel().sendIntent({ kind: 'toggleHistoryRevision', id: 'r41' });
    fakePanel().sendIntent({ kind: 'toggleHistoryRevision', id: 'r40' });
    fakePanel().sendIntent({ kind: 'selectHistoryRevision', id: 'r41' });
    await waitFor(() => historySessionSnapshot().selection.length === 2);
    const logCalls = svnCalls.filter((call) => call.kind === 'log').length;

    fakePanel().sendIntent({ kind: 'setHistoryFilter', id: 'author', value: 'bob' });
    await waitFor(() => historySessionSnapshot().filter?.author === 'bob');

    const snapshot = historySessionSnapshot();
    // r41（alice）被筛掉 → 勾选清空；r40（bob）仍可见 → 保留勾选。
    expect(snapshot.selection).toEqual([40]);
    expect(snapshot.visibleMatched).toBe(1);
    expect(snapshot.displayedCount).toBe(1);
    expect(historyModelDetailRevision()).toBeUndefined();
    // 不发网络。
    expect(svnCalls.filter((call) => call.kind === 'log').length).toBe(logCalls);
    // 不自动选第一条：详情为空态提示，没有被自动选中的记录详情。
    expect(fakePanel().latestRenderHtml()).toContain('选择左侧 revision 查看提交详情');
  });

  it('第三个勾选被拒并提示', async () => {
    await openWithEntries();
    fakePanel().sendIntent({ kind: 'toggleHistoryRevision', id: 'r41' });
    fakePanel().sendIntent({ kind: 'toggleHistoryRevision', id: 'r40' });
    fakePanel().sendIntent({ kind: 'toggleHistoryRevision', id: 'r39' });
    await waitFor(() => fakePanel().toasts().some((message) => message.includes('最多选择两个')));
    expect(historySessionSnapshot().selection).toEqual([41, 40]);
  });

  it('点击行解析实际节点并展示详情（present）', async () => {
    await openWithEntries();
    detailInfoHandler = () => ({ ok: true, xml: infoXml(NODE, 41) });
    fakePanel().sendIntent({ kind: 'selectHistoryRevision', id: 'r41' });
    await waitFor(() => historyModelDetailRevision() === 41);
    await waitFor(() => {
      const html = fakePanel().latestRenderHtml();
      return html.includes('实际节点路径') && html.includes('/trunk/a.txt');
    });
    const html = fakePanel().latestRenderHtml();
    expect(html).toContain('可用动作');
    // core 返回的仓库相对路径无前导斜杠；真实渲染链路不得出现双斜杠。
    expect(html).not.toContain('//trunk/a.txt');
    expect(html).toContain('data-intent="comparePreviousVisible"');
    expect(html).toContain('data-intent="copyHistoryText"');
  });
});

/** 模型详情 revision（测试辅助；读取模型当前详情状态）。 */
function historyModelDetailRevision(): number | undefined {
  return historyModelForTest()?.detailState()?.revision;
}

describe('复制与比较接线', () => {
  async function openLive(): Promise<void> {
    infoHandler = standardInfo(42);
    logHandler = () => ({ ok: true, xml: logXml([{ revision: 41 }, { revision: 40 }]) });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);
  }

  it('copyHistoryText：提交说明/变更路径/节点 URL 写剪贴板', async () => {
    await openLive();
    fakePanel().sendIntent({ kind: 'copyHistoryText', copyKind: 'message', id: 'r41' });
    await waitFor(() => vscodeMock.clipboard.length === 1);
    expect(vscodeMock.clipboard[0]).toBe('提交 r41');

    fakePanel().sendIntent({ kind: 'copyHistoryText', copyKind: 'changedPath', id: 'r41' });
    await waitFor(() => vscodeMock.clipboard.length === 2);
    expect(vscodeMock.clipboard[1]).toBe('/trunk/a.txt');

    fakePanel().sendIntent({ kind: 'copyHistoryText', copyKind: 'nodeUrl', id: 'r41' });
    await waitFor(() => vscodeMock.clipboard.length === 3);
    expect(vscodeMock.clipboard[2]).toBe(NODE);
  });

  it('comparePreviousVisible：执行器收到下一条可见记录版本对', async () => {
    await openLive();
    fakePanel().sendIntent({ kind: 'selectHistoryRevision', id: 'r41' });
    await waitFor(() => historyModelDetailRevision() === 41);

    const runner = vi.fn();
    setHistoryComparisonRunner(runner);
    fakePanel().sendIntent({ kind: 'comparePreviousVisible' });
    await waitFor(() => runner.mock.calls.length === 1);
    expect(runner.mock.calls[0][0]).toEqual({ origin: 'previous-visible', revisions: [41, 40] });

    // 最后一条已加载记录：边界拒绝（不调用执行器，提示加载更多）。
    fakePanel().sendIntent({ kind: 'selectHistoryRevision', id: 'r40' });
    await waitFor(() => historyModelDetailRevision() === 40);
    fakePanel().sendIntent({ kind: 'comparePreviousVisible' });
    await waitFor(() => fakePanel().toasts().some((message) => message.includes('加载更多')));
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('compareHistoryRevisions：勾选两项后执行器收到手动勾选对', async () => {
    await openLive();
    const runner = vi.fn();
    setHistoryComparisonRunner(runner);
    fakePanel().sendIntent({ kind: 'compareHistoryRevisions' });
    await waitFor(() => fakePanel().toasts().some((message) => message.includes('勾选两个 revision')));
    fakePanel().sendIntent({ kind: 'toggleHistoryRevision', id: 'r41' });
    fakePanel().sendIntent({ kind: 'toggleHistoryRevision', id: 'r40' });
    await waitFor(() => historySessionSnapshot().selection.length === 2);
    fakePanel().sendIntent({ kind: 'compareHistoryRevisions' });
    await waitFor(() => runner.mock.calls.length === 1);
    expect(runner.mock.calls[0][0]).toEqual({ origin: 'selected', revisions: [41, 40] });
  });
});

describe('加载更多', () => {
  it('首轮按预算连续分页；pending-only 轮只推进展示游标且不发网络', async () => {
    vscodeMock.config = { historyPageSize: 20 };
    infoHandler = standardInfo(42);
    const logCalls: Array<{ cursor: number; limit: number }> = [];
    logHandler = (request) => {
      logCalls.push({ cursor: request.cursor ?? 0, limit: request.limit ?? 0 });
      // 服务端分页模拟：cursor=42 返回 21 条（41..21），cursor=20 返回空。
      return request.cursor === 42
        ? { ok: true, xml: logXml(Array.from({ length: 21 }, (_, index) => ({ revision: 41 - index }))) }
        : { ok: true, xml: logXml([]) };
    };
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().loadedMatchedCount === 21);
    // 同一轮 loadMore 内按 500 预算连续请求：第一批 21 条（=pageSize+1），
    // 第二批空回包结束源；展示游标停在 20，pending 1 条。
    await waitFor(() => logCalls.length === 2);
    expect(logCalls[0]).toEqual({ cursor: 42, limit: 21 });
    expect(logCalls[1]).toEqual({ cursor: 20, limit: 21 });
    expect(historySessionSnapshot().displayedCount).toBe(20);
    expect(historySessionSnapshot().loadedMatchedCount).toBe(21);
    expect(historyModelForTest()?.sessionView().canFetchMore).toBe(false);

    // 下一次 loadMore：pending-only 只推进展示游标，不发网络（本轮行隐藏）。
    fakePanel().sendIntent({ kind: 'loadMoreHistory' });
    await waitFor(() => historySessionSnapshot().displayedCount === 21);
    expect(logCalls).toHaveLength(2);
    const html = fakePanel().latestRenderHtml();
    expect(html).not.toContain('本轮已处理');

    // 再下一次：无待展示匹配且源已耗尽 → 不再发请求，加载更多禁用。
    fakePanel().sendIntent({ kind: 'loadMoreHistory' });
    await flush();
    expect(logCalls).toHaveLength(2);
    expect(html).toContain('data-intent="loadMoreHistory"');
    expect(fakePanel().latestRenderHtml()).toContain('disabled');
  });

  it('网络轮加载更多使用 append 增量（只追加新增行片段，不分片超页大小）', async () => {
    vscodeMock.config = { historyPageSize: 20 };
    infoHandler = standardInfo(42);
    // 首轮：每页返回同一批 revision（41..21），可见命中 21 条但 500 条预算
    // 被逐页耗尽 → displayed 停在 20、pending 1。下一次 loadMore 先 pending
    // 展示，再发起新的网络轮（cursor=24 起）产生新命中 → append 增量。
    logHandler = (request) => {
      const cursor = request.cursor ?? 0;
      if (cursor === 42 || cursor === 20) {
        return { ok: true, xml: logXml(Array.from({ length: 21 }, (_, index) => ({ revision: 41 - index }))) };
      }
      if (cursor >= 5 && cursor < 25) {
        return { ok: true, xml: logXml(Array.from({ length: 21 }, (_, index) => ({ revision: cursor - index }))) };
      }
      return { ok: true, xml: logXml([]) };
    };
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().phase === 'ready'
      && historySessionSnapshot().displayedCount === 20
      && (historySessionSnapshot().loadedMatchedCount ?? 0) === 21);

    // 先展示 pending（整帧），再发起新的网络轮：新增展示行走 append 增量。
    fakePanel().sendIntent({ kind: 'loadMoreHistory' });
    await waitFor(() => historySessionSnapshot().displayedCount === 21);
    fakePanel().sendIntent({ kind: 'loadMoreHistory' });
    await waitFor(() => fakePanel().posted.some((message) => message.type === 'append'));

    const appended = fakePanel().posted.filter((message) => message.type === 'append');
    expect(appended[0].target).toBe('history');
    expect(String(appended[0].html)).toContain('data-row-id="r');
    expect(String(appended[0].html)).not.toContain('<table');
    expect(String(appended[0].html)).not.toContain('table-load-more');
  });
});

describe('详情动作接线：检出交接与 BASE 比较', () => {
  it('远端目录详情「检出此版本」交给 P3 预填（实际 URL 与实际 revision）', async () => {
    infoHandler = (request) => {
      if (request.url === `${ROOT}/trunk`) {
        return { ok: true, xml: infoXml(`${ROOT}/trunk`, request.revision ?? 30, 'dir') };
      }
      return { ok: false, stderr: failStderr(['W170000', 'E200009']) };
    };
    logHandler = () => ({ ok: true, xml: logXml([{ revision: 29 }]) });
    detailInfoHandler = () => ({ ok: true, xml: infoXml(`${ROOT}/trunk`, 29, 'dir') });
    await openHistoryPanel(handoffDirTarget());
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);

    fakePanel().sendIntent({ kind: 'selectHistoryRevision', id: 'r29' });
    await waitFor(() => historyModelForTest()?.detailState()?.resolution.status === 'present');
    fakePanel().sendIntent({ kind: 'checkoutHistoryDirectory' });
    await waitFor(() => vi.mocked(openCheckoutPanelFromHistory).mock.calls.length === 1);
    expect(vi.mocked(openCheckoutPanelFromHistory).mock.calls[0][0]).toEqual({
      sourceUrl: `${ROOT}/trunk`,
      pinnedRevision: 29,
      nodeKind: 'dir',
    });
    await waitFor(() => fakePanel().toasts().some((message) => message.includes('预填')));
  });

  it('本地目标「与本地 BASE 比较」按 status 变化逐项复用 BASE diff', async () => {
    infoHandler = standardInfo(42);
    logHandler = () => ({ ok: true, xml: logXml([{ revision: 41 }, { revision: 40 }]) });
    detailInfoHandler = () => ({ ok: true, xml: infoXml(NODE, 41) });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);
    fakePanel().sendIntent({ kind: 'selectHistoryRevision', id: 'r41' });
    await waitFor(() => historyModelForTest()?.detailState()?.resolution.status === 'present');

    vi.mocked(planSnapshotBaseCompare).mockResolvedValue({
      status: 'ready',
      entries: [{ relPath: 'trunk/a.txt', wcStatus: 'modified', props: 'none', kind: 'file' }],
    });
    vi.mocked(openSnapshotBaseCompareEntry).mockResolvedValue('diffed');
    fakePanel().sendIntent({ kind: 'compareBase' });
    await waitFor(() => vi.mocked(openSnapshotBaseCompareEntry).mock.calls.length === 1);
    expect(vi.mocked(planSnapshotBaseCompare).mock.calls[0][1]).toEqual({
      wcRoot: '/wc',
      relPath: 'trunk/a.txt',
      kind: 'file',
    });
  });
});

describe('关闭重开与目标切换', () => {
  it('关闭重开恢复：LRU 未淘汰时直接恢复数据与 upper，不再发网络', async () => {
    infoHandler = standardInfo(42);
    logHandler = () => ({ ok: true, xml: logXml([{ revision: 41 }]) });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);
    const callsBefore = svnCalls.length;

    fakePanel().dispose();
    await flush();
    expect(historySessionSnapshot().phase).toBeUndefined();

    await openHistoryPanel(localTarget());
    const snapshot = historySessionSnapshot();
    expect(snapshot).toMatchObject({
      upperRevision: 42,
      upperSource: 'live-head',
      loadedMatchedCount: 1,
    });
    expect(svnCalls).toHaveLength(callsBefore);
  });

  it('加载中切换目标被拒绝（busy 门禁保持一致）', async () => {
    let release: (() => void) | undefined;
    let pending = false;
    infoHandler = standardInfo(42);
    logHandler = () => new Promise<Reply>((resolve) => {
      pending = true;
      release = () => resolve({ ok: true, xml: logXml([{ revision: 41 }]) });
    });
    const openingA = openHistoryPanel(localTarget());
    await waitFor(() => pending);

    await openHistoryPanel(localTarget({
      localPath: '/wc/trunk/b.txt',
      url: `${ROOT}/trunk/b.txt`,
      relativePath: 'trunk/b.txt',
    }));
    expect(vscodeMock.information.some((message) => message.includes('已拒绝切换到新目标'))).toBe(true);
    expect(historyModelForTest()?.target?.relativePath).toBe('trunk/a.txt');

    release?.();
    await openingA;
    expect(historySessionSnapshot().loadedMatchedCount).toBe(1);
    expect(historyModelForTest()?.target?.relativePath).toBe('trunk/a.txt');
  });

  it('unresolved 点重试：重新解析 HEAD，成功后进入 live-head', async () => {
    let headFails = true;
    infoHandler = (request) => {
      if (request.url === ROOT) {
        return headFails
          ? { ok: false, stderr: failStderr(['E170013', 'E120108']) }
          : { ok: true, xml: infoXml(ROOT, 42, 'dir') };
      }
      return { ok: true, xml: infoXml(NODE, request.revision ?? 42) };
    };
    logHandler = () => ({ ok: true, xml: logXml([{ revision: 41 }]) });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().upperSource === 'unresolved');

    headFails = false;
    fakePanel().sendIntent({
      kind: 'bannerAction',
      bannerId: 'historyHeadUnavailable',
      actionId: 'historyRetry',
    });
    await waitFor(() => historySessionSnapshot().upperSource === 'live-head'
      && historySessionSnapshot().hasLoadedData === true);
    expect(historySessionSnapshot()).toMatchObject({
      upperRevision: 42,
      headState: 'available',
      loadedMatchedCount: 1,
    });
  });

  it('切回旧目标：恢复其筛选与勾选且不重读历史', async () => {
    infoHandler = (request) => (request.url === ROOT
      ? { ok: true, xml: infoXml(ROOT, 42, 'dir') }
      : { ok: true, xml: infoXml(request.url, request.revision ?? 42) });
    logHandler = (request) => ({
      ok: true,
      xml: logXml(request.url === NODE
        ? [{ revision: 41 }, { revision: 40 }]
        : [{ revision: 44 }, { revision: 43 }]),
    });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().loadedMatchedCount === 2);
    fakePanel().sendIntent({ kind: 'toggleHistoryRevision', id: 'r41' });
    fakePanel().sendIntent({ kind: 'setHistoryFilter', id: 'keyword', value: '41' });
    await waitFor(() => historySessionSnapshot().filter?.keyword === '41');

    await openHistoryPanel(localTarget({
      localPath: '/wc/trunk/b.txt',
      url: `${ROOT}/trunk/b.txt`,
      relativePath: 'trunk/b.txt',
    }));
    await waitFor(() => historyModelForTest()?.target?.relativePath === 'trunk/b.txt'
      && historySessionSnapshot().hasLoadedData === true);
    const callsBefore = svnCalls.length;

    // 切回 A：命中 m4SessionStore 的可浏览状态，恢复筛选/勾选/数据，不重读。
    await openHistoryPanel(localTarget());
    const snapshot = historySessionSnapshot();
    expect(snapshot.filter?.keyword).toBe('41');
    expect(snapshot.selection).toEqual([41]);
    expect(snapshot.loadedMatchedCount).toBe(2);
    expect(snapshot.visibleMatched).toBe(1);
    expect(svnCalls).toHaveLength(callsBefore);
  });

  it('旧目标的在途详情回包不写入新目标', async () => {
    const OTHER = `${ROOT}/trunk/b.txt`;
    infoHandler = (request) => {
      if (request.url === ROOT) {
        return { ok: true, xml: infoXml(ROOT, 42, 'dir') };
      }
      return { ok: true, xml: infoXml(request.url, request.revision ?? 42) };
    };
    logHandler = (request) => ({
      ok: true,
      xml: logXml([{ revision: request.url === NODE ? 41 : 44 }]),
    });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);

    // A 的详情解析挂起（详情解析不设置 busy）：随后切换目标允许，但旧回包必须丢弃。
    let releaseDetail: (() => void) | undefined;
    let detailPending = false;
    detailInfoHandler = () => new Promise<Reply>((resolve) => {
      detailPending = true;
      releaseDetail = () => resolve({ ok: true, xml: infoXml(NODE, 41) });
    });
    fakePanel().sendIntent({ kind: 'selectHistoryRevision', id: 'r41' });
    await waitFor(() => detailPending);

    await openHistoryPanel(localTarget({
      localPath: '/wc/trunk/b.txt',
      url: OTHER,
      relativePath: 'trunk/b.txt',
    }));
    await waitFor(() => historyModelForTest()?.target?.relativePath === 'trunk/b.txt'
      && historySessionSnapshot().loadedMatchedCount === 1);
    expect(fakePanel().latestRenderHtml()).toContain('>r44<');
    expect(fakePanel().latestRenderHtml()).not.toContain('>r41<');

    // 释放 A 的旧详情回包：不得写入 B 的详情。
    releaseDetail?.();
    await flush();
    await flush();
    expect(historyModelForTest()?.target?.relativePath).toBe('trunk/b.txt');
    expect(historyModelForTest()?.detailState()).toBeUndefined();
    expect(fakePanel().latestRenderHtml()).not.toContain('/trunk/a.txt');
  });
});
