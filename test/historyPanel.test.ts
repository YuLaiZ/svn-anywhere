/**
 * P6 历史面板控制器（panels/history.ts）flow 测试：mock vscode（面板替身/
 * 剪贴板/配置）与 SVN 命令层（runOrThrow 供控制器、run 供 core/history 的
 * 节点解析），从面板打开与意图驱动：
 * - 本地入口：HEAD → 目标存在性 → 首批 log；请求参数（-l pageSize+1、
 *   -r upper:1、URL@upper）与请发命令次序；
 * - HEAD 失败且有本地 BASE → unresolved（HEAD 暂不可用 + BASE 上限入口）；
 * - base-fallback 成功进入结果、log 失败保留三字段与已加载数据（会话重置语义）；
 * - reset：live-head 保持 available 且不重读 HEAD、重读首批；unresolved 被拒；
 * - refresh head：已最新保留数据、前进重读、失败保留数据、来源恢复；
 * - P5 快照会话不读 HEAD、reset 不收新 HEAD、refresh 被模型校验拒绝；
 * - 筛选/勾选/详情/复制/比较接线/关闭重开恢复/旧目标回包丢弃/加载更多。
 * 远端命令的 `--non-interactive` 由 core 原语测试覆盖；本文件校验控制器
 * 传入的 revision/cursor 与命令形态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
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

/* ---------------- P6 逐行追溯（F46）装饰替身 ---------------- */

interface FakeDecorationOption {
  range?: unknown;
  renderOptions?: { after?: { contentText?: string } };
}

interface FakeTextEditor {
  /** 每次 setDecorations 的入参（type + options）。 */
  decorations: Array<{ type: unknown; options: FakeDecorationOption[] }>;
  setDecorations(type: unknown, options: FakeDecorationOption[]): void;
}

const blameMock: {
  editor?: FakeTextEditor;
  closeHandlers: Array<(document: { uri: { toString(): string } }) => void>;
  decorationDisposed: number;
  openedDocuments: string[];
} = {
  closeHandlers: [],
  decorationDisposed: 0,
  openedDocuments: [],
};

function makeFakeBlameEditor(): FakeTextEditor {
  const editor: FakeTextEditor = {
    decorations: [],
    setDecorations(type, options) {
      editor.decorations.push({ type, options });
    },
  };
  return editor;
}

vi.mock('vscode', () => ({
  ViewColumn: { Active: 1, Beside: 2 },
  DecorationRangeBehavior: { ClosedClosed: 1, OpenOpen: 2, OpenClosed: 3, ClosedOpen: 4 },
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
    showTextDocument: () => Promise.resolve(blameMock.editor),
    createTextEditorDecorationType: () => ({
      dispose: () => {
        blameMock.decorationDisposed += 1;
      },
    }),
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
    openTextDocument: (uri: { toString(): string }) => {
      blameMock.openedDocuments.push(uri.toString());
      return Promise.resolve({
        uri,
        lineCount: 10_000,
        lineAt: (line: number) => ({ range: { start: { line }, end: { line } } }),
      });
    },
    onDidCloseTextDocument: (handler: (document: { uri: { toString(): string } }) => void) => {
      blameMock.closeHandlers.push(handler);
      return {
        dispose() {
          const index = blameMock.closeHandlers.indexOf(handler);
          if (index >= 0) {
            blameMock.closeHandlers.splice(index, 1);
          }
        },
      };
    },
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

// 逐行追溯入口的内容类型探测：默认文本；二进制入口禁用用例按需切换。
vi.mock('../src/core/remoteContent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/remoteContent')>();
  return { ...actual, probeRemoteContent: vi.fn() };
});

vi.mock('../src/host/panel/panels/checkout', () => ({
  openCheckoutPanelFromHistory: vi.fn(),
}));

// P6 更新（M4 阶段 6）编排测试：core 写前检查/执行/回扫由本文件 mock
// 控制返回值与时序；真实 prepare/update/回读链路由 historyUpdate.test.ts
// （真实 svnadmin+file://）与 historyUpdateController.test.ts 覆盖。
vi.mock('../src/core/historyUpdate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/historyUpdate')>();
  return {
    ...actual,
    prepareHistoryUpdate: vi.fn(),
    checkHistoryUpdatePreconditions: vi.fn(),
    runHistoryUpdate: vi.fn(),
    rescanHistoryUpdate: vi.fn(),
  };
});

vi.mock('../src/host/ui/confirm', () => ({
  confirmModal: vi.fn(),
}));

vi.mock('../src/host/commands/conflicts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/commands/conflicts')>();
  return { ...actual, openConflictTarget: vi.fn() };
});

vi.mock('../src/host/output', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/output')>();
  return {
    ...actual,
    showOutput: vi.fn(),
    // 频道断言：保留真实实现，仅记录调用参数供用例核对频道。
    decodingRunOptions: vi.fn(actual.decodingRunOptions),
    logCommand: vi.fn(actual.logCommand),
    logLine: vi.fn(actual.logLine),
  };
});

import { run, runOrThrow } from '../src/core/svnCli';
import { SvnError, extractSvnErrorCodes } from '../src/core/errors';
import { strings } from '../src/host/i18n';
import type { ConflictRecord } from '../src/core/conflict';
import { historyTargetKey } from '../src/host/panel/historyModel';
import {
  checkHistoryUpdatePreconditions,
  prepareHistoryUpdate,
  rescanHistoryUpdate,
  runHistoryUpdate,
  type HistoryUpdateIntent,
  type HistoryUpdateResult,
  type HistoryUpdateRescan,
} from '../src/core/historyUpdate';
import {
  getOperationRegistry,
  OperationRegistry,
  resetRunningOperationsForTest,
  setOperationRegistryForTest,
  type OperationRecord,
  type OperationStore,
} from '../src/core/operations';
import { getActiveTask, resetTaskRegistry } from '../src/host/taskRegistry';
import { confirmModal } from '../src/host/ui/confirm';
import { openConflictTarget } from '../src/host/commands/conflicts';
import { openSnapshotBaseCompareEntry, openSnapshotNodeContent, openSnapshotTextDiff } from '../src/host/diffView';
import { openCheckoutPanelFromHistory } from '../src/host/panel/panels/checkout';
import { loadSnapshotCompare, planSnapshotBaseCompare } from '../src/host/panel/snapshotModel';
import { probeRemoteContent } from '../src/core/remoteContent';
import { createSvnLab, writeFile as writeLabFile, type SvnLab } from './helpers';
import { resetPanelRegistry } from '../src/host/panel/host';
import { readM4ScopeSession, resetM4SessionStore } from '../src/host/sessionResults';
import { decodingRunOptions, logCommand, logLine, resetOutputState, showOutput } from '../src/host/output';
import {
  historyCompareForTest,
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
let infoHandler: (request: ParsedCommand) => Reply | Promise<Reply>;
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
    const reply = request.kind === 'info' ? await infoHandler(request) : await logHandler(request);
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

function infoXml(url: string, revision: number, kind: 'file' | 'dir' = 'file', root = ROOT): string {
  return `<info><entry kind="${kind}" path="x" revision="${revision}">` +
    `<url>${url}</url>` +
    `<repository><root>${root}</root><uuid>uuid-1</uuid></repository>` +
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
  resetTaskRegistry();
  resetRunningOperationsForTest();
  setOperationRegistryForTest(new OperationRegistry());
  vscodeMock.information.length = 0;
  vscodeMock.warning.length = 0;
  vscodeMock.errors.length = 0;
  vscodeMock.clipboard.length = 0;
  vscodeMock.panels.length = 0;
  vscodeMock.config = {};
  blameMock.editor = undefined;
  blameMock.closeHandlers.length = 0;
  blameMock.decorationDisposed = 0;
  blameMock.openedDocuments.length = 0;
  vi.mocked(probeRemoteContent).mockReset();
  vi.mocked(probeRemoteContent).mockResolvedValue({
    status: 'probed',
    classification: { kind: 'text', reason: 'none' },
    headBytes: 0,
  });
  resetSvnStub();
  vi.mocked(planSnapshotBaseCompare).mockReset();
  vi.mocked(openSnapshotBaseCompareEntry).mockReset();
  vi.mocked(openCheckoutPanelFromHistory).mockReset();
  vi.mocked(openCheckoutPanelFromHistory).mockResolvedValue({ ok: true });
  vi.mocked(prepareHistoryUpdate).mockReset();
  vi.mocked(checkHistoryUpdatePreconditions).mockReset();
  vi.mocked(runHistoryUpdate).mockReset();
  vi.mocked(rescanHistoryUpdate).mockReset();
  vi.mocked(showOutput).mockReset();
  vi.mocked(confirmModal).mockReset();
  vi.mocked(confirmModal).mockResolvedValue(true);
  vi.mocked(openConflictTarget).mockReset();
  vi.mocked(openConflictTarget).mockResolvedValue(undefined);
  setHistoryPanelContext({
    extensionUri: { scheme: 'file', path: '/extension' } as unknown as vscode.Uri,
    subscriptions: [],
  });
});

afterEach(() => {
  resetHistoryPanelController();
  resetPanelRegistry();
  resetTaskRegistry();
  resetRunningOperationsForTest();
  setOperationRegistryForTest(undefined);
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

  it('P6 只读历史的运行选项与命令日志走 history 频道（不再复用 browse）', async () => {
    infoHandler = standardInfo(42);
    logHandler = () => ({ ok: true, xml: logXml([{ revision: 41 }]) });
    vi.mocked(decodingRunOptions).mockClear();
    vi.mocked(logCommand).mockClear();
    vi.mocked(logLine).mockClear();
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);
    // 解码提示与凭据重试回显的频道全部是 history；不得再写 P5 浏览频道。
    const decodingKinds = vi.mocked(decodingRunOptions).mock.calls.map((call) => call[0]);
    expect(decodingKinds.length).toBeGreaterThan(0);
    expect(decodingKinds.filter((kind) => kind !== 'history')).toEqual([]);
    const logKinds = vi.mocked(logCommand).mock.calls.map((call) => call[3]);
    expect(logKinds.filter((kind) => kind !== 'history')).toEqual([]);
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

describe('base-fallback', () => {
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

  it('base-fallback 的 log 回包为畸形 XML：toast 错误、三字段与已扫描数据不变、不再续发请求', async () => {
    let logMode: 'ok' | 'malformed' = 'ok';
    infoHandler = (request) => {
      if (request.url === ROOT) {
        return { ok: false, stderr: failStderr(['E170013', 'E120108']) };
      }
      return { ok: true, xml: infoXml(NODE, request.revision ?? 40) };
    };
    logHandler = () => (logMode === 'ok'
      ? { ok: true, xml: logXml([{ revision: 39 }, { revision: 38 }]) }
      : { ok: true, xml: '<log><logentry revision="41"><author>alice</author>' });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().phase === 'ready');
    fakePanel().sendIntent({ kind: 'refreshHistoryUpper', mode: 'base-fallback' });
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);
    const before = historySessionSnapshot();
    const logCallsBefore = svnCalls.filter((call) => call.kind === 'log').length;

    logMode = 'malformed';
    fakePanel().sendIntent({ kind: 'refreshHistoryUpper', mode: 'base-fallback' });
    await waitFor(() => fakePanel().toasts().some((message) => message.includes('按 BASE 上限读取失败')));

    const after = historySessionSnapshot();
    expect(after.upperRevision).toBe(before.upperRevision);
    expect(after.upperSource).toBe(before.upperSource);
    expect(after.headState).toBe(before.headState);
    expect(after.loadedMatchedCount).toBe(before.loadedMatchedCount);
    expect(after.displayedCount).toBe(before.displayedCount);
    expect(after.scannedUniqueRevisions).toBe(before.scannedUniqueRevisions);
    // 畸形回包只发那一次请求：不进入 startLoadMore/pumpNetwork 续发。
    await flush();
    expect(svnCalls.filter((call) => call.kind === 'log')).toHaveLength(logCallsBefore + 1);
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

describe('resetHistorySession', () => {
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

describe('占用态：刷新在途与更新确认窗口', () => {
  it('刷新在途：加载更多与更新被占用态拒绝且刷新结果不被中止', async () => {
    let head = 42;
    let refreshPending = false;
    let releaseRefresh: (() => void) | undefined;
    infoHandler = (request) => {
      if (request.url === ROOT) {
        if (head === 45) {
          // 刷新 HEAD 探测挂起：模拟慢网络下刷新在途的窗口。
          refreshPending = true;
          return new Promise<Reply>((resolve) => {
            releaseRefresh = () => resolve({ ok: true, xml: infoXml(ROOT, 45, 'dir') });
          });
        }
        return { ok: true, xml: infoXml(ROOT, head, 'dir') };
      }
      return { ok: true, xml: infoXml(NODE, request.revision ?? head) };
    };
    logHandler = () => ({ ok: true, xml: logXml([{ revision: 41 }]) });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);
    const logsBefore = svnCalls.filter((call) => call.kind === 'log').length;

    head = 45;
    fakePanel().sendIntent({ kind: 'refreshHistoryUpper', mode: 'head' });
    await waitFor(() => refreshPending);
    await flush();

    // 刷新在途进入占用态：刷新按钮本身与加载更多按同一张放行表禁用。
    const refreshButton = (): string =>
      /<button[^>]*data-intent="refreshHistoryUpper"[^>]*>/.exec(fakePanel().latestRenderHtml())?.[0] ?? '';
    expect(refreshButton()).toContain('disabled');

    // 加载更多被宿主门禁拒绝（明确提示），不中止刷新、不发多余 log。
    fakePanel().sendIntent({ kind: 'loadMoreHistory' });
    await waitFor(() => fakePanel().toasts().some((message) => message.includes(strings.panel.toastBusyRejected)));
    expect(svnCalls.filter((call) => call.kind === 'log').length).toBe(logsBefore);

    // 更新开始同样被占用态拒绝：不进入写前检查。
    fakePanel().sendIntent({ kind: 'updateToHistoryRevision' });
    await flush();
    expect(vi.mocked(prepareHistoryUpdate)).not.toHaveBeenCalled();

    // 释放 HEAD：刷新继续完成（未被加载更多静默丢弃），数据按新 HEAD 重读。
    releaseRefresh?.();
    await waitFor(() => historySessionSnapshot().upperRevision === 45);
    expect(fakePanel().toasts().some((message) => message.includes('已按 HEAD 刷新'))).toBe(true);
    // 刷新链收尾（重读首批的 log 完成 + finally 恢复占用态）后，加载更多
    // 不再命中 busy 门禁。
    await waitFor(() => svnCalls.filter((call) => call.kind === 'log').length === logsBefore + 1);
    await flush();
    const busyToasts = (): number => fakePanel().toasts()
      .filter((message) => message.includes(strings.panel.toastBusyRejected)).length;
    const busyBefore = busyToasts();
    fakePanel().sendIntent({ kind: 'loadMoreHistory' });
    await flush();
    await flush();
    expect(busyToasts()).toBe(busyBefore);
  });

  it('更新确认窗口在途：刷新被占用态拒绝且已确认的更新继续执行', async () => {
    await openWithDetail();
    let preparePending = false;
    let releasePrepare: (() => void) | undefined;
    vi.mocked(prepareHistoryUpdate).mockImplementation(() => new Promise((resolve) => {
      preparePending = true;
      releasePrepare = () => resolve({ ok: true, intent: updateIntent() });
    }));
    vi.mocked(checkHistoryUpdatePreconditions).mockResolvedValue({ ok: true });
    vi.mocked(runHistoryUpdate).mockResolvedValue(updateResult());
    const headInfoBefore = svnCalls.filter((call) => call.kind === 'info' && call.url === ROOT).length;

    fakePanel().sendIntent({ kind: 'updateToHistoryRevision' });
    await waitFor(() => preparePending);
    await flush();

    // 写前检查/确认窗口在途：刷新被 busy 门禁拒绝并提示，不发起 HEAD 探测。
    fakePanel().sendIntent({ kind: 'refreshHistoryUpper', mode: 'head' });
    await waitFor(() => fakePanel().toasts().some((message) =>
      message.includes(strings.panel.toastBusyRejected)
      || message.includes(strings.historyPanel.updateConfirmInProgress)));
    expect(svnCalls.filter((call) => call.kind === 'info' && call.url === ROOT).length).toBe(headInfoBefore);

    // 释放写前检查：确认后更新照常执行（不因刷新推进票据被静默丢弃）。
    releasePrepare?.();
    await waitFor(() => historySessionSnapshot().updatePhase === 'updated');
    await waitFor(() => getActiveTask('history') === undefined);
    expect(vi.mocked(confirmModal)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runHistoryUpdate)).toHaveBeenCalledTimes(1);
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

  it('每批条数下拉选择不被配置值覆盖：一次 push 后仍保留用户选择', async () => {
    vscodeMock.config['historyPageSize'] = 50;
    await openWithEntries();
    expect(historyModelForTest()?.pageSize).toBe(50);

    fakePanel().sendIntent({ kind: 'setHistoryFilter', id: 'pageSize', value: '20' });
    await flush();
    expect(historyModelForTest()?.pageSize).toBe(20);

    // 任意后续 push（关键词筛选重算整帧）：用户选择不被配置值静默回退。
    fakePanel().sendIntent({ kind: 'setHistoryFilter', id: 'keyword', value: '初始化' });
    await flush();
    expect(historyModelForTest()?.pageSize).toBe(20);
    const state = historyModelForTest()!.buildPanelState('t');
    const pageSizeField = state.filterPanel?.fields.find((field) => field.id === 'pageSize');
    expect(pageSizeField?.value).toBe('20');

    // 配置值本身变化时才重新应用到模型。
    vscodeMock.config['historyPageSize'] = 100;
    fakePanel().sendIntent({ kind: 'setHistoryFilter', id: 'keyword', value: '目标' });
    await flush();
    expect(historyModelForTest()?.pageSize).toBe(100);
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

  it('详情复制在展示前缀缩小后仍生效：按稳定 ID 从会话数据取，不被宿主丢弃', async () => {
    infoHandler = standardInfo(42);
    // 25 条记录：展示全部时选中较深的 r17，再缩小每批条数让其离开展示前缀。
    const revisions = Array.from({ length: 25 }, (_, index) => 41 - index);
    logHandler = () => ({ ok: true, xml: logXml(revisions.map((revision) => ({ revision }))) });
    detailInfoHandler = () => ({ ok: true, xml: infoXml(NODE, 17) });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);

    fakePanel().sendIntent({ kind: 'setHistoryFilter', id: 'pageSize', value: '100' });
    await flush();
    fakePanel().sendIntent({ kind: 'selectHistoryRevision', id: 'r17' });
    await waitFor(() => historyModelDetailRevision() === 17);
    fakePanel().sendIntent({ kind: 'setHistoryFilter', id: 'pageSize', value: '20' });
    await flush();
    expect(historySessionSnapshot().displayedCount).toBe(20);

    // 详情仍渲染（独立于表格展示前缀存活）：复制动作按稳定 ID 从已加载
    // 会话数据解析，宿主不因行不在展示前缀而静默丢弃意图。
    expect(fakePanel().latestRenderHtml()).toContain('data-intent="copyHistoryText"');
    fakePanel().sendIntent({ kind: 'copyHistoryText', copyKind: 'message', id: 'r17' });
    await waitFor(() => vscodeMock.clipboard.length === 1);
    expect(vscodeMock.clipboard[0]).toBe('提交 r17');
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
    // 冻结动作有稳定 DOM 入口（页脚「比较所选版本」），不是仅协议可达。
    expect(fakePanel().latestRenderHtml()).toContain('data-intent="compareHistoryRevisions"');
    expect(fakePanel().latestRenderHtml()).toContain('比较所选版本');
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

  it('比较候选打开差异与详情标题使用复制窗口映射后的实际 revision', async () => {
    await openLive();
    // 复制窗口场景：用户选择 r40（compare.leftRevision），左端实际节点经
    // 复制解析落在另一来源路径的 r4（candidate.leftRevision）。
    vi.mocked(loadSnapshotCompare).mockReset();
    vi.mocked(loadSnapshotCompare).mockImplementation(async (_svnPath, state) => ({
      ...state,
      phase: 'ready',
      candidates: [{
        id: 'c0',
        relativePath: 'trunk/a.txt',
        displayPath: 'trunk/a.txt',
        item: 'modified',
        props: 'none',
        kind: 'file',
        leftPresent: true,
        rightPresent: true,
        leftUrl: `${ROOT}/branches/b.txt`,
        rightUrl: NODE,
        leftRevision: 4,
        rightRevision: 41,
        status: 'modified',
        canOpenTextDiff: true,
        canExport: true,
      }],
      filteredIndexes: [0],
      selectedId: 'c0',
    }));
    fakePanel().sendIntent({ kind: 'toggleHistoryRevision', id: 'r41' });
    fakePanel().sendIntent({ kind: 'toggleHistoryRevision', id: 'r40' });
    await waitFor(() => historySessionSnapshot().selection.length === 2);
    fakePanel().sendIntent({ kind: 'compareHistoryRevisions' });
    await waitFor(() => historyCompareForTest()?.phase === 'ready');
    expect(historyCompareForTest()?.leftRevision).toBe(40);
    expect(historyCompareForTest()?.selectedId).toBe('c0');

    // 详情标题按候选实际 revision 呈现（左端 r4，而不是用户选择的 r40）。
    const html = fakePanel().latestRenderHtml();
    expect(html).toContain('左端 r4');
    expect(html).not.toContain('左端 r40');

    vi.mocked(openSnapshotTextDiff).mockReset();
    vi.mocked(openSnapshotTextDiff).mockResolvedValue({ status: 'opened' } as never);
    fakePanel().sendIntent({ kind: 'openHistoryDiff' });
    await waitFor(() => vi.mocked(openSnapshotTextDiff).mock.calls.length === 1);
    const request = vi.mocked(openSnapshotTextDiff).mock.calls[0][0];
    expect(request.left).toMatchObject({
      rawUrl: `${ROOT}/branches/b.txt`,
      revision: 4,
    });
    expect(request.right).toMatchObject({ rawUrl: NODE, revision: 41 });
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

  it('log 回包畸形 XML：进入错误态（可重试横幅）而非空历史，不续发请求', async () => {
    infoHandler = standardInfo(42);
    logHandler = () => ({ ok: true, xml: '<log><logentry revision="41"><author>alice</author>' });
    await openHistoryPanel(localTarget());
    await waitFor(() => historyModelForTest()?.loadFailure() !== undefined);
    const failure = historyModelForTest()!.loadFailure();
    expect(failure?.message).toContain('XML');
    expect(historySessionSnapshot().hasLoadedData).toBe(false);
    expect(historySessionSnapshot().phase).toBe('ready');
    // 错误态呈现（可重试横幅），不是「空历史」。
    expect(fakePanel().latestRenderHtml()).toContain('data-banner-id="historyLoadError"');
    await flush();
    expect(svnCalls.filter((call) => call.kind === 'log')).toHaveLength(1);
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
    // 单条目目标保持直接打开，不弹汇总确认。
    expect(vi.mocked(confirmModal)).not.toHaveBeenCalled();
  });

  it('目录 BASE 比较超过上限：汇总确认后只打开前 10 个差异并提示其余未打开', async () => {
    infoHandler = standardInfo(42);
    logHandler = () => ({ ok: true, xml: logXml([{ revision: 41 }, { revision: 40 }]) });
    detailInfoHandler = () => ({ ok: true, xml: infoXml(`${ROOT}/trunk`, 41, 'dir') });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);
    fakePanel().sendIntent({ kind: 'selectHistoryRevision', id: 'r41' });
    await waitFor(() => historyModelForTest()?.detailState()?.resolution.status === 'present');

    vi.mocked(planSnapshotBaseCompare).mockResolvedValue({
      status: 'ready',
      entries: Array.from({ length: 12 }, (_, index) => ({
        relPath: `trunk/f${index}.txt`,
        wcStatus: 'modified',
        props: 'none',
        kind: 'file',
      })),
    });
    vi.mocked(openSnapshotBaseCompareEntry).mockResolvedValue('diffed');
    fakePanel().sendIntent({ kind: 'compareBase' });
    await waitFor(() => vi.mocked(openSnapshotBaseCompareEntry).mock.calls.length === 10);

    // 汇总确认先于打开：消息含总项数与一次打开上限。
    expect(vi.mocked(confirmModal)).toHaveBeenCalledTimes(1);
    const message = String(vi.mocked(confirmModal).mock.calls[0][0]);
    expect(message).toContain('12');
    expect(message).toContain('10');
    // 汇总提示与截断提示均可见；打开数被上限锁定。
    expect(fakePanel().toasts().some((toast) => toast.includes('本地实际变化 12 项'))).toBe(true);
    expect(fakePanel().toasts().some((toast) => toast.includes('其余未打开'))).toBe(true);
    await flush();
    expect(vi.mocked(openSnapshotBaseCompareEntry)).toHaveBeenCalledTimes(10);
  });

  it('目录 BASE 比较取消确认：不打开任何差异并提示已取消', async () => {
    infoHandler = standardInfo(42);
    logHandler = () => ({ ok: true, xml: logXml([{ revision: 41 }, { revision: 40 }]) });
    detailInfoHandler = () => ({ ok: true, xml: infoXml(`${ROOT}/trunk`, 41, 'dir') });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);
    fakePanel().sendIntent({ kind: 'selectHistoryRevision', id: 'r41' });
    await waitFor(() => historyModelForTest()?.detailState()?.resolution.status === 'present');

    vi.mocked(planSnapshotBaseCompare).mockResolvedValue({
      status: 'ready',
      entries: [
        { relPath: 'trunk/a.txt', wcStatus: 'modified', props: 'none', kind: 'file' },
        { relPath: 'trunk/b.txt', wcStatus: 'modified', props: 'none', kind: 'file' },
      ],
    });
    vi.mocked(confirmModal).mockResolvedValue(false);
    fakePanel().sendIntent({ kind: 'compareBase' });
    await waitFor(() => fakePanel().toasts().some((message) => message.includes('已取消打开 BASE 差异')));
    expect(vi.mocked(openSnapshotBaseCompareEntry)).not.toHaveBeenCalled();
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

  it('已有后台历史面板再次打开目标时先 reveal', async () => {
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
    const panel = fakePanel();
    const revealedBefore = panel.revealed;

    await openHistoryPanel(localTarget({
      localPath: '/wc/trunk/b.txt',
      url: `${ROOT}/trunk/b.txt`,
      relativePath: 'trunk/b.txt',
    }));
    await waitFor(() => historyModelForTest()?.target?.relativePath === 'trunk/b.txt'
      && historySessionSnapshot().hasLoadedData === true);

    expect(panel.revealed).toBe(revealedBefore + 1);
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

/* ---------------------------------------------------------------------------
 * M4 阶段 6：P6 更新到历史 revision 的控制器编排
 * （写前检查 → 确认 → begin/写锁 → 更新任务状态机 → 回扫三出口 →
 *  P7 交接 → 关闭重开/宿主重启恢复）
 * ------------------------------------------------------------------------- */

const UPDATE_SCOPE = {
  scopeKind: 'history' as const,
  targetKey: historyTargetKey('uuid-1', {
    repositoryRootUrl: ROOT,
    relativePath: 'trunk/a.txt',
    kind: 'file',
  }),
  targetKind: 'file' as const,
};

function updateIntent(overrides: Partial<HistoryUpdateIntent> = {}): HistoryUpdateIntent {
  return {
    wcRoot: '/wc',
    targetRelPath: 'trunk/a.txt',
    targetKind: 'file',
    targetUrl: NODE,
    requestedRevision: 41,
    preRevision: 40,
    ...overrides,
  };
}

function updateConflictRecord(): ConflictRecord {
  return {
    id: 'conflict-1',
    path: 'trunk/a.txt',
    kinds: ['text'],
    contentKind: 'text',
    nodeBaseRevision: 41,
    baselineRevision: 40,
    incomingRevision: 41,
    artifacts: [],
  };
}

function updateResult(overrides: Partial<HistoryUpdateResult> = {}): HistoryUpdateResult {
  return {
    targetRelPath: 'trunk/a.txt',
    requestedRevision: 41,
    preRevision: 40,
    postNodeRevision: 41,
    outcome: 'updated',
    conflicts: [],
    conflictSummary: { text: 0, property: 0, tree: 0, total: 0 },
    ...overrides,
  };
}

function updateRescan(overrides: Partial<HistoryUpdateRescan> = {}): HistoryUpdateRescan {
  return {
    outcome: 'updated',
    postNodeRevision: 41,
    conflicts: [],
    conflictSummary: { text: 0, property: 0, tree: 0, total: 0 },
    ...overrides,
  };
}

/** 内存操作存储（宿主 globalState 的测试替身）。 */
function memoryStore(): OperationStore & { records: OperationRecord[] } {
  const records: OperationRecord[] = [];
  return {
    records,
    load: () => records.map((record) => ({ ...record })),
    save(record) {
      const index = records.findIndex((item) => item.operationId === record.operationId);
      if (index >= 0) {
        records[index] = { ...record };
      } else {
        records.push({ ...record });
      }
    },
    remove(operationId) {
      const index = records.findIndex((item) => item.operationId === operationId);
      if (index >= 0) {
        records.splice(index, 1);
      }
    },
  };
}

/** 打开面板并让详情解析到 r41（更新动作的目标）。 */
async function openWithDetail(): Promise<void> {
  infoHandler = standardInfo(42);
  logHandler = () => ({
    ok: true,
    xml: logXml([
      { revision: 41, author: 'alice', message: '目标提交' },
      { revision: 40, author: 'bob', message: '基线' },
    ]),
  });
  await openHistoryPanel(localTarget());
  await waitFor(() => historySessionSnapshot().hasLoadedData === true);
  detailInfoHandler = () => ({ ok: true, xml: infoXml(NODE, 41) });
  fakePanel().sendIntent({ kind: 'selectHistoryRevision', id: 'r41' });
  await waitFor(() => historyModelForTest()?.detailState()?.revision === 41);
}

describe('P6 更新：执行链与状态机', () => {
  it('成功：写前检查→确认→begin(running)→updated；BASE/终态页/记录收口正确', async () => {
    await openWithDetail();
    vi.mocked(prepareHistoryUpdate).mockResolvedValue({ ok: true, intent: updateIntent() });
    vi.mocked(checkHistoryUpdatePreconditions).mockResolvedValue({ ok: true });
    let releaseUpdate: ((result: HistoryUpdateResult) => void) | undefined;
    vi.mocked(runHistoryUpdate).mockImplementation(() => new Promise<HistoryUpdateResult>((resolve) => {
      releaseUpdate = resolve;
    }));

    fakePanel().sendIntent({ kind: 'updateToHistoryRevision' });
    await waitFor(() => historySessionSnapshot().updatePhase === 'updating');

    // 固定意图来自详情实际 revision 与 prepare 快照；确认框只在检查通过后出现。
    expect(vi.mocked(prepareHistoryUpdate)).toHaveBeenCalledWith(
      'svn',
      '/wc',
      'trunk/a.txt',
      41,
      expect.anything(),
    );
    expect(vi.mocked(confirmModal)).toHaveBeenCalledTimes(1);
    const records = await getOperationRegistry().loadAllRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'history-update',
      phase: 'running',
      lockKey: '/wc',
      historyUpdateIntent: updateIntent(),
    });
    expect(getActiveTask('history')?.phase).toBe('updating');
    expect(historySessionSnapshot()).toMatchObject({
      updatePhase: 'updating',
      updateRequestedRevision: 41,
      updatePreRevision: 40,
      updateOperationId: records[0].operationId,
    });
    expect(fakePanel().latestRenderHtml()).toContain('正在更新到 revision 41');
    expect(fakePanel().latestRenderHtml()).toContain('更新前 BASE r40');

    releaseUpdate?.(updateResult());
    await waitFor(() => historySessionSnapshot().updatePhase === 'updated');
    await waitFor(() => getActiveTask('history') === undefined);

    expect(await getOperationRegistry().loadAllRecords()).toEqual([]);
    expect(historySessionSnapshot()).toMatchObject({
      updatePostRevision: 41,
      updateConflicts: 0,
    });
    // 回读确认后 BASE 徽标按新值刷新；终态页写入当前作用域。
    expect(historyModelForTest()?.localBaseRevision()).toBe(41);
    const page = readM4ScopeSession(UPDATE_SCOPE)?.terminalPage;
    expect(page).toMatchObject({ version: 1, kind: 'history-update' });
    expect(fakePanel().latestRenderHtml()).toContain('更新完成');
    expect(fakePanel().latestRenderHtml()).toContain('回读节点 BASE r41');
  });

  it('updating 横幅出口：「查看日志」打开 history 频道，「关闭面板」关闭界面且任务继续', async () => {
    await openWithDetail();
    vi.mocked(prepareHistoryUpdate).mockResolvedValue({ ok: true, intent: updateIntent() });
    vi.mocked(checkHistoryUpdatePreconditions).mockResolvedValue({ ok: true });
    let releaseUpdate: ((result: HistoryUpdateResult) => void) | undefined;
    vi.mocked(runHistoryUpdate).mockImplementation(() => new Promise<HistoryUpdateResult>((resolve) => {
      releaseUpdate = resolve;
    }));

    fakePanel().sendIntent({ kind: 'updateToHistoryRevision' });
    await waitFor(() => historySessionSnapshot().updatePhase === 'updating');
    const panel = fakePanel();

    // 在途页「查看日志」：打开 P6 命令频道，不再落到裸 return。
    fakePanel().sendIntent({ kind: 'bannerAction', bannerId: 'historyUpdate', actionId: 'viewTaskLog' });
    await waitFor(() => vi.mocked(showOutput).mock.calls.length === 1);
    expect(vi.mocked(showOutput)).toHaveBeenLastCalledWith(false, 'history');

    // 在途页「关闭面板」：只关界面，任务继续（可关面板但不取消）。
    fakePanel().sendIntent({ kind: 'bannerAction', bannerId: 'historyUpdate', actionId: 'closePanel' });
    await waitFor(() => panel.disposed === true);
    expect(getActiveTask('history')?.phase).toBe('updating');

    releaseUpdate?.(updateResult());
    await waitFor(() => getActiveTask('history') === undefined);
    expect(readM4ScopeSession(UPDATE_SCOPE)?.terminalPage).toMatchObject({ kind: 'history-update' });
  });

  it('updateUnknown 横幅出口：「查看日志」打开 history 频道，「关闭面板」可关闭', async () => {
    await openWithDetail();
    vi.mocked(prepareHistoryUpdate).mockResolvedValue({ ok: true, intent: updateIntent() });
    vi.mocked(checkHistoryUpdatePreconditions).mockResolvedValue({ ok: true });
    vi.mocked(runHistoryUpdate).mockResolvedValue(updateResult({
      outcome: 'unknown',
      postNodeRevision: undefined,
      readbackError: 'svn update 退出码 1',
    }));

    fakePanel().sendIntent({ kind: 'updateToHistoryRevision' });
    await waitFor(() => historySessionSnapshot().updatePhase === 'updateUnknown');
    const panel = fakePanel();

    fakePanel().sendIntent({ kind: 'bannerAction', bannerId: 'historyUpdate', actionId: 'viewTaskLog' });
    await waitFor(() => vi.mocked(showOutput).mock.calls.length === 1);
    expect(vi.mocked(showOutput)).toHaveBeenLastCalledWith(false, 'history');

    fakePanel().sendIntent({ kind: 'bannerAction', bannerId: 'historyUpdate', actionId: 'closePanel' });
    await waitFor(() => panel.disposed === true);
    // 关闭面板不改变写锁：未知记录保持到回扫收口。
    expect(getOperationRegistry().writeRestriction('/wc')?.phase).toBe('unknown');
  });

  it('未知：保持旧 BASE、记录 unknown 写锁；回扫仍未知保持，成功出口收口并释放写锁', async () => {
    await openWithDetail();
    vi.mocked(prepareHistoryUpdate).mockResolvedValue({ ok: true, intent: updateIntent() });
    vi.mocked(checkHistoryUpdatePreconditions).mockResolvedValue({ ok: true });
    vi.mocked(runHistoryUpdate).mockResolvedValue(updateResult({
      outcome: 'unknown',
      postNodeRevision: undefined,
      readbackError: 'svn update 退出码 1',
    }));

    fakePanel().sendIntent({ kind: 'updateToHistoryRevision' });
    await waitFor(() => historySessionSnapshot().updatePhase === 'updateUnknown');
    const unknownRecord = getOperationRegistry().writeRestriction('/wc');
    expect(unknownRecord?.phase).toBe('unknown');
    expect(historySessionSnapshot()).toMatchObject({
      updatePreRevision: 40,
      updateReadbackError: 'svn update 退出码 1',
    });
    // 旧 BASE 不被预期值覆盖。
    expect(historyModelForTest()?.localBaseRevision()).toBe(40);
    expect(fakePanel().latestRenderHtml()).toContain('更新结果未知');
    expect(fakePanel().latestRenderHtml()).toContain('data-action-id="rescanHistoryUpdate"');

    // 回扫仍未知：记录保持 unknown，页面保持 updateUnknown。
    vi.mocked(rescanHistoryUpdate).mockResolvedValue(updateRescan({
      outcome: 'still-unknown',
      postNodeRevision: 40,
      readbackError: 'revision 不符',
    }));
    fakePanel().sendIntent({ kind: 'rescanHistoryUpdate' });
    await waitFor(() => historySessionSnapshot().updatePhase === 'updateUnknown'
      && getActiveTask('history') === undefined);
    expect(vi.mocked(rescanHistoryUpdate)).toHaveBeenCalledTimes(1);
    expect(getOperationRegistry().writeRestriction('/wc')?.phase).toBe('unknown');
    expect(historyModelForTest()?.localBaseRevision()).toBe(40);

    // 回扫成功出口：回读请求 revision 且无冲突 → updated，记录 finalize。
    vi.mocked(rescanHistoryUpdate).mockResolvedValue(updateRescan({ outcome: 'updated', postNodeRevision: 41 }));
    fakePanel().sendIntent({ kind: 'rescanHistoryUpdate' });
    await waitFor(() => historySessionSnapshot().updatePhase === 'updated');
    await waitFor(() => getActiveTask('history') === undefined);
    expect(getOperationRegistry().writeRestriction('/wc')).toBeUndefined();
    expect(await getOperationRegistry().loadAllRecords()).toEqual([]);
    expect(historyModelForTest()?.localBaseRevision()).toBe(41);
  });

  it('冲突：updateConflict 展示回读 BASE 与冲突；横幅动作把同一结果对象交给 P7', async () => {
    await openWithDetail();
    vi.mocked(prepareHistoryUpdate).mockResolvedValue({ ok: true, intent: updateIntent() });
    vi.mocked(checkHistoryUpdatePreconditions).mockResolvedValue({ ok: true });
    vi.mocked(runHistoryUpdate).mockResolvedValue(updateResult({
      outcome: 'conflict',
      conflicts: [updateConflictRecord()],
      conflictSummary: { text: 1, property: 0, tree: 0, total: 1 },
    }));

    fakePanel().sendIntent({ kind: 'updateToHistoryRevision' });
    await waitFor(() => historySessionSnapshot().updatePhase === 'updateConflict');
    expect(historySessionSnapshot()).toMatchObject({
      updatePostRevision: 41,
      updateConflicts: 1,
    });
    expect(historyModelForTest()?.localBaseRevision()).toBe(41);
    expect(fakePanel().latestRenderHtml()).toContain('更新完成，存在冲突');
    expect(fakePanel().latestRenderHtml()).toContain('data-intent="bannerAction"');
    expect(fakePanel().latestRenderHtml()).toContain('openUpdateConflicts');

    fakePanel().sendIntent({ kind: 'bannerAction', bannerId: 'historyUpdate', actionId: 'openUpdateConflicts' });
    await waitFor(() => vi.mocked(openConflictTarget).mock.calls.length === 1);
    expect(vi.mocked(openConflictTarget)).toHaveBeenCalledWith({
      source: 'update',
      wcRoot: '/wc',
      scopeRelPath: 'trunk/a.txt',
      taskContext: {
        targetRelPath: 'trunk/a.txt',
        targetKind: 'file',
        requestedRevision: 41,
        preRevision: 40,
        postNodeRevision: 41,
        outcome: 'conflict',
        conflictCount: 1,
      },
    });
  });

  it('写前阻断：本地修改阻止时不确认、不 begin、不发写命令', async () => {
    await openWithDetail();
    vi.mocked(prepareHistoryUpdate).mockResolvedValue({ ok: true, intent: updateIntent() });
    vi.mocked(checkHistoryUpdatePreconditions).mockResolvedValue({
      ok: false,
      reason: 'local-modifications',
      blocking: [{ path: 'trunk/a.txt', wcStatus: 'modified' }],
    });
    fakePanel().sendIntent({ kind: 'updateToHistoryRevision' });
    await flush();
    await flush();
    expect(vi.mocked(confirmModal)).not.toHaveBeenCalled();
    expect(vi.mocked(runHistoryUpdate)).not.toHaveBeenCalled();
    expect(await getOperationRegistry().loadAllRecords()).toEqual([]);
    expect(getActiveTask('history')).toBeUndefined();
    expect(fakePanel().toasts().join('\n')).toContain('本地存在修改');
  });

  it('更新成功后历史会话按新 BASE 刷新：base-fallback 上限随之更新并重读首批', async () => {
    infoHandler = (request) => {
      if (request.url === ROOT) {
        return { ok: false, stderr: failStderr(['E170013', 'E120108']) };
      }
      return { ok: true, xml: infoXml(NODE, request.revision ?? 40) };
    };
    logHandler = (request) => ({
      ok: true,
      xml: logXml([
        { revision: (request.cursor ?? 40) - 1 },
        { revision: (request.cursor ?? 40) - 2 },
      ]),
    });
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().phase === 'ready');
    fakePanel().sendIntent({ kind: 'refreshHistoryUpper', mode: 'base-fallback' });
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);
    expect(historySessionSnapshot()).toMatchObject({ upperRevision: 40, upperSource: 'base-fallback' });

    detailInfoHandler = () => ({ ok: true, xml: infoXml(NODE, 39) });
    fakePanel().sendIntent({ kind: 'selectHistoryRevision', id: 'r39' });
    await waitFor(() => historyModelForTest()?.detailState()?.revision === 39);

    vi.mocked(prepareHistoryUpdate).mockResolvedValue({
      ok: true,
      intent: updateIntent({ requestedRevision: 39 }),
    });
    vi.mocked(checkHistoryUpdatePreconditions).mockResolvedValue({ ok: true });
    vi.mocked(runHistoryUpdate).mockResolvedValue(updateResult({
      requestedRevision: 39,
      postNodeRevision: 39,
      outcome: 'updated',
    }));

    fakePanel().sendIntent({ kind: 'updateToHistoryRevision' });
    await waitFor(() => historySessionSnapshot().updatePhase === 'updated');
    await waitFor(() => historySessionSnapshot().upperRevision === 39);
    expect(historySessionSnapshot()).toMatchObject({
      upperSource: 'base-fallback',
      updatePostRevision: 39,
    });
    expect(svnCalls.some((call) => call.kind === 'log' && call.cursor === 39)).toBe(true);
    expect(historyModelForTest()?.localBaseRevision()).toBe(39);
    expect(fakePanel().latestRenderHtml()).toContain('BASE r39');
  });

  it('复制前更新禁用：prepare 返回 target-absent-at-revision 时给出阻断提示', async () => {
    await openWithDetail();
    vi.mocked(prepareHistoryUpdate).mockResolvedValue({ ok: false, reason: 'target-absent-at-revision' });
    fakePanel().sendIntent({ kind: 'updateToHistoryRevision' });
    await flush();
    await flush();
    expect(fakePanel().toasts().join('\n')).toContain('该 revision 上目标不存在');
    expect(vi.mocked(checkHistoryUpdatePreconditions)).not.toHaveBeenCalled();
    expect(vi.mocked(runHistoryUpdate)).not.toHaveBeenCalled();
  });
});

describe('P6 更新：关闭重开与宿主重启恢复', () => {
  it('在途关闭面板：任务继续；重开绑定同一任务，完成后按终态页恢复 updated', async () => {
    await openWithDetail();
    vi.mocked(prepareHistoryUpdate).mockResolvedValue({ ok: true, intent: updateIntent() });
    vi.mocked(checkHistoryUpdatePreconditions).mockResolvedValue({ ok: true });
    let releaseUpdate: ((result: HistoryUpdateResult) => void) | undefined;
    vi.mocked(runHistoryUpdate).mockImplementation(() => new Promise<HistoryUpdateResult>((resolve) => {
      releaseUpdate = resolve;
    }));

    fakePanel().sendIntent({ kind: 'updateToHistoryRevision' });
    await waitFor(() => historySessionSnapshot().updatePhase === 'updating');
    const taskId = getActiveTask('history')?.taskId;
    expect(taskId).toBeDefined();

    fakePanel().dispose();
    // 关闭面板不取消任务。
    expect(getActiveTask('history')?.taskId).toBe(taskId);

    // 重开：绑定仍在运行的任务，回到 updating 页（不重复登记新任务）。
    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().updatePhase === 'updating');
    expect(getActiveTask('history')?.taskId).toBe(taskId);
    expect(fakePanel().latestRenderHtml()).toContain('正在更新到 revision 41');

    releaseUpdate?.(updateResult());
    await waitFor(() => historySessionSnapshot().updatePhase === 'updated');
    await waitFor(() => getActiveTask('history') === undefined);
    expect(fakePanel().latestRenderHtml()).toContain('更新完成');
    expect(historyModelForTest()?.localBaseRevision()).toBe(41);
    expect(await getOperationRegistry().loadAllRecords()).toEqual([]);
  });

  it('宿主重启：预置 history-update running 记录分诊为 unknown，打开面板进入 updateUnknown 且回扫可收口', async () => {
    const store = memoryStore();
    const first = new OperationRegistry(store);
    const begin = await first.begin({
      wcRoot: '/wc',
      lockKey: '/wc',
      kind: 'history-update',
      operationId: 'op-pre',
      targetRelPath: 'trunk/a.txt',
      nodeKind: 'file',
      baseRevision: 40,
      historyUpdateIntent: updateIntent(),
    });
    expect(begin.ok).toBe(true);
    await first.markPhase('op-pre', 'running');
    // 模拟宿主重启：运行登记清空，新注册表重新加载并按 kind 分诊。
    resetRunningOperationsForTest();
    const restarted = new OperationRegistry(store);
    await restarted.loadPending();
    const folded = store.records.find((record) => record.operationId === 'op-pre');
    expect(folded?.phase).toBe('unknown');
    expect(folded?.historyUpdateIntent).toEqual(updateIntent());
    setOperationRegistryForTest(restarted);

    await openHistoryPanel(localTarget());
    await waitFor(() => historySessionSnapshot().updatePhase === 'updateUnknown');
    expect(historySessionSnapshot()).toMatchObject({
      updateOperationId: 'op-pre',
      updateRequestedRevision: 41,
      updatePreRevision: 40,
    });
    expect(fakePanel().latestRenderHtml()).toContain('更新结果未知');
    expect(fakePanel().latestRenderHtml()).toContain('data-action-id="rescanHistoryUpdate"');

    vi.mocked(rescanHistoryUpdate).mockResolvedValue(updateRescan({ outcome: 'updated', postNodeRevision: 41 }));
    fakePanel().sendIntent({ kind: 'rescanHistoryUpdate' });
    await waitFor(() => historySessionSnapshot().updatePhase === 'updated');
    await waitFor(() => getActiveTask('history') === undefined);
    expect(store.records).toEqual([]);
    expect(historyModelForTest()?.localBaseRevision()).toBe(41);
  });

  it('同一工作副本另一目标的更新任务结算后 busy 自动恢复（跨目标任务移除通知）', async () => {
    await openWithDetail();
    vi.mocked(prepareHistoryUpdate).mockResolvedValue({ ok: true, intent: updateIntent() });
    vi.mocked(checkHistoryUpdatePreconditions).mockResolvedValue({ ok: true });
    let releaseUpdate: ((result: HistoryUpdateResult) => void) | undefined;
    vi.mocked(runHistoryUpdate).mockImplementation(() => new Promise<HistoryUpdateResult>((resolve) => {
      releaseUpdate = resolve;
    }));
    fakePanel().sendIntent({ kind: 'updateToHistoryRevision' });
    await waitFor(() => historySessionSnapshot().updatePhase === 'updating');

    // 关闭目标 A 面板（任务继续），打开同一 wcRoot 的目标 B 面板。
    fakePanel().dispose();
    const nodeB = `${ROOT}/trunk/b.txt`;
    infoHandler = (request) => {
      if (request.url === ROOT || request.url === `${ROOT}/`) {
        return { ok: true, xml: infoXml(ROOT, 42, 'dir') };
      }
      if (request.url === nodeB) {
        return { ok: true, xml: infoXml(nodeB, request.revision ?? 42) };
      }
      return { ok: false, stderr: failStderr(['W170000', 'E200009']) };
    };
    logHandler = () => ({
      ok: true,
      xml: logXml([{ revision: 41, paths: [{ path: '/trunk/b.txt' }] }]),
    });
    await openHistoryPanel(localTarget({
      wcRoot: '/wc',
      localPath: '/wc/trunk/b.txt',
      url: nodeB,
      relativePath: 'trunk/b.txt',
    }));
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);
    // B 面板没有本作用域任务，只经占用态呈现 busy。
    expect(getActiveTask('history')?.phase).toBe('updating');
    expect(fakePanel().latestRenderHtml()).toContain('data-busy="1"');

    // A 的任务结算：B 收到跨目标任务移除通知，重算占用并推送（busy 恢复）。
    releaseUpdate?.(updateResult());
    await waitFor(() => getActiveTask('history') === undefined);
    await flush();
    expect(fakePanel().latestRenderHtml()).toContain('data-busy="0"');
  });

  it('同一工作副本另一目标的 unknown 记录经当前面板回扫成功：当前目标 BASE 与终态页不被改写', async () => {
    // 预置目标 A（trunk/a.txt）的未知更新记录（同一 wcRoot /wc）。
    const store = memoryStore();
    const registry = new OperationRegistry(store);
    const begin = await registry.begin({
      wcRoot: '/wc',
      lockKey: '/wc',
      kind: 'history-update',
      operationId: 'op-target-a',
      targetRelPath: 'trunk/a.txt',
      nodeKind: 'file',
      baseRevision: 40,
      historyUpdateIntent: updateIntent(),
    });
    expect(begin.ok).toBe(true);
    await registry.markPhase('op-target-a', 'unknown');
    setOperationRegistryForTest(registry);

    // 打开同一工作副本的目标 B 面板：未知记录经写锁展示回扫出口。
    const nodeB = `${ROOT}/trunk/b.txt`;
    infoHandler = (request) => {
      if (request.url === ROOT || request.url === `${ROOT}/`) {
        return { ok: true, xml: infoXml(ROOT, 42, 'dir') };
      }
      if (request.url === nodeB) {
        return { ok: true, xml: infoXml(nodeB, request.revision ?? 42) };
      }
      return { ok: false, stderr: failStderr(['W170000', 'E200009']) };
    };
    logHandler = () => ({
      ok: true,
      xml: logXml([{ revision: 41, paths: [{ path: '/trunk/b.txt' }] }]),
    });
    await openHistoryPanel(localTarget({
      wcRoot: '/wc',
      localPath: '/wc/trunk/b.txt',
      url: nodeB,
      relativePath: 'trunk/b.txt',
      baseRevision: 38,
    }));
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);
    expect(historySessionSnapshot()).toMatchObject({
      updatePhase: 'updateUnknown',
      updateTargetRelPath: 'trunk/a.txt',
    });
    expect(historyModelForTest()?.localBaseRevision()).toBe(38);

    // 在当前面板回扫 A 的记录并成功：记录 finalize 释放写锁，但 A 的回读
    // BASE 不得应用到 B 的 BASE 徽标/base-fallback 历史。
    vi.mocked(rescanHistoryUpdate).mockResolvedValue(updateRescan({ outcome: 'updated', postNodeRevision: 41 }));
    fakePanel().sendIntent({ kind: 'rescanHistoryUpdate' });
    await waitFor(() => historySessionSnapshot().updatePhase === 'updated');
    await waitFor(() => getActiveTask('history') === undefined);
    expect(historySessionSnapshot().updateTargetRelPath).toBe('trunk/a.txt');
    expect(historyModelForTest()?.localBaseRevision()).toBe(38);
    expect(getOperationRegistry().writeRestriction('/wc')).toBeUndefined();
    expect(await getOperationRegistry().loadAllRecords()).toEqual([]);

    // 终态页不写当前作用域（重开 B 不得按 A 的终态还原）。
    const bScope = {
      scopeKind: 'history' as const,
      targetKey: historyTargetKey('uuid-1', {
        repositoryRootUrl: ROOT,
        relativePath: 'trunk/b.txt',
        kind: 'file',
      }),
      targetKind: 'file' as const,
    };
    expect(readM4ScopeSession(bScope)?.terminalPage).toBeUndefined();
  });
});

describe('P6 逐行追溯（F46）', () => {
  const blameDocumentUri = {
    scheme: 'svn-anywhere-remote',
    path: '/uuid-lab/2/key/a.txt',
    query: '',
    toString: () => 'svn-anywhere-remote:/uuid-lab/2/key/a.txt',
  };

  let lab: SvnLab | undefined;
  afterEach(() => {
    lab?.cleanup();
    lab = undefined;
  });

  /** 真实 svnadmin + file:// 仓库：打开 r2 的历史并选中详情。 */
  async function openRealLabHistory(): Promise<void> {
    lab = createSvnLab('svn-anywhere-p6-blame-');
    const wc = lab.checkout('wc');
    writeLabFile(wc, 'a.txt', 'line1\nline2\n', true);
    lab.svn(['commit', '-q', '-m', 'c1'], wc);
    writeLabFile(wc, 'a.txt', 'line1 changed\nline2\n');
    lab.svn(['commit', '-q', '-m', 'c2'], wc);
    const nodeUrl = `${lab.repoUrl}/a.txt`;
    const repoRoot = lab.repoUrl;
    infoHandler = (request) => {
      if (request.url === repoRoot || request.url === `${repoRoot}/`) {
        return { ok: true, xml: infoXml(repoRoot, 2, 'dir', repoRoot) };
      }
      if (request.url === nodeUrl) {
        return { ok: true, xml: infoXml(nodeUrl, request.revision ?? 2, 'file', repoRoot) };
      }
      return { ok: false, stderr: failStderr(['W170000', 'E200009']) };
    };
    logHandler = () => ({
      ok: true,
      xml: logXml([
        { revision: 2, author: 'alice', paths: [{ path: '/a.txt' }] },
        { revision: 1, author: 'bob', paths: [{ path: '/a.txt', action: 'A' }] },
      ]),
    });
    await openHistoryPanel({
      source: 'local',
      wcRoot: wc,
      localPath: join(wc, 'a.txt'),
      url: nodeUrl,
      repositoryRootUrl: lab.repoUrl,
      repositoryUuid: 'uuid-lab',
      relativePath: 'a.txt',
      kind: 'file',
      baseRevision: 2,
    });
    await waitFor(() => historySessionSnapshot().hasLoadedData === true);
    detailInfoHandler = () => ({ ok: true, xml: infoXml(nodeUrl, 2, 'file', repoRoot) });
    fakePanel().sendIntent({ kind: 'selectHistoryRevision', id: 'r2' });
    await waitFor(() => historyModelForTest()?.detailState()?.resolution.status === 'present');
  }

  it('真实 svn lab：打开所选 revision 的只读快照并附加行尾归属，关闭文档即撤下', async () => {
    await openRealLabHistory();
    vi.mocked(openSnapshotNodeContent).mockReset();
    vi.mocked(openSnapshotNodeContent).mockResolvedValue({
      status: 'openedText',
      uri: blameDocumentUri as unknown as vscode.Uri,
      bytes: 20,
      encoding: 'utf-8',
      fellBack: false,
      lenient: false,
    });
    blameMock.editor = makeFakeBlameEditor();

    fakePanel().sendIntent({ kind: 'blameHistoryRevision' });
    // 真实 svn blame 进程（file:// 仓库）可能超过默认等待窗口。
    await waitFor(() => (blameMock.editor?.decorations.length ?? 0) > 0, 600);

    // 打开的是该 revision 的只读内容（解析后实际 URL + 明确 revision）。
    expect(vi.mocked(openSnapshotNodeContent)).toHaveBeenCalledTimes(1);
    const openArgs = vi.mocked(openSnapshotNodeContent).mock.calls[0];
    expect(openArgs[1]).toMatchObject({ rawUrl: expect.stringMatching(/\/a\.txt$/), relativePath: 'a.txt' });
    expect(openArgs[2]).toBe(2);

    // 真实 `svn blame --xml -r 2`：第一行归属 r2、第二行归属 r1（author
    // 为提交用户，断言 revision 前缀即可）。
    const applied = blameMock.editor!.decorations[0].options;
    expect(applied).toHaveLength(2);
    expect(applied[0].renderOptions?.after?.contentText).toMatch(/^r2 · /);
    expect(applied[1].renderOptions?.after?.contentText).toMatch(/^r1 · /);
    // 只读快照文档由 provider 承载（不是工作副本文件）。
    expect(blameMock.openedDocuments).toEqual(['svn-anywhere-remote:/uuid-lab/2/key/a.txt']);

    // 关闭只读文档：装饰撤下并释放装饰类型（视图只在编辑器存活期间存在）。
    const disposedBefore = blameMock.decorationDisposed;
    expect(blameMock.closeHandlers.length).toBeGreaterThan(0);
    for (const handler of [...blameMock.closeHandlers]) {
      handler({ uri: blameDocumentUri });
    }
    expect(blameMock.decorationDisposed).toBe(disposedBefore + 1);
    expect(blameMock.editor!.decorations.at(-1)?.options).toEqual([]);
  });

  it('删除 revision：详情不存在时入口拒绝，不打开内容也不执行 blame', async () => {
    await openRealLabHistory();
    const model = historyModelForTest()!;
    const detail = model.detailState()!;
    model.applyDetailResolution(
      { revision: detail.revision, epoch: detail.epoch },
      { status: 'absent', deletedRevision: 2 },
    );
    vi.mocked(openSnapshotNodeContent).mockReset();
    blameMock.editor = makeFakeBlameEditor();
    fakePanel().sendIntent({ kind: 'blameHistoryRevision' });
    await flush();
    expect(vi.mocked(openSnapshotNodeContent)).not.toHaveBeenCalled();
    expect(blameMock.editor.decorations).toHaveLength(0);
    expect(fakePanel().toasts().length).toBeGreaterThan(0);
  });

  it('二进制内容：入口探测拒绝，不打开文本编辑器也不执行 blame', async () => {
    await openRealLabHistory();
    vi.mocked(probeRemoteContent).mockResolvedValue({
      status: 'probed',
      classification: { kind: 'binary', reason: 'nul' },
      headBytes: 8,
    });
    vi.mocked(openSnapshotNodeContent).mockReset();
    blameMock.editor = makeFakeBlameEditor();
    fakePanel().sendIntent({ kind: 'blameHistoryRevision' });
    await waitFor(() => fakePanel().toasts().some((message) => message.includes(strings.blamePanel.binary)));
    expect(vi.mocked(openSnapshotNodeContent)).not.toHaveBeenCalled();
    expect(blameMock.editor.decorations).toHaveLength(0);
  });
});
