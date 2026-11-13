/**
 * P7 冲突面板控制器（panels/conflicts.ts）flow 测试：mock vscode 与 SVN
 * 命令层（run/runOrThrow 由内存冲突状态机应答），验证：
 * - 打开即扫描（status 三判据 + 批量 info）、任务槽 claim/结算与关闭重开；
 * - 扫描中关闭面板：任务继续、完成后写 m4SessionStore、重开恢复不重扫；
 * - 扫描失败进 error/loadError；取消扫描使在途回包过期；
 * - tab/选择/推迟与手动确认（working 二次确认、树节点确认）；
 * - 回扫矛盾 → unknown 写锁（不写台账、不显示已解决），重新扫描按真实
 *   结果收口（仍冲突释放写锁；已清除写入 resolvedLedger）；
 * - 混合路径不直接应用；跨面板写锁经 P7 放行表拒绝写意图；
 * - 只读交互入口（工作副本终端、打开版本）。
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

/* ------------------------------ vscode 替身 ------------------------------ */

interface VscodeMockState {
  information: string[];
  warning: string[];
  errors: string[];
  clipboard: string[];
  terminals: Array<{ name?: string; cwd?: string }>;
  opened: string[];
  diffCommands: Array<{ command: string; left: string; right: string; title: string }>;
  panels: FakePanel[];
  config: Record<string, unknown>;
  outputLines: Array<{ title: string; line: string }>;
}

const vscodeMock: VscodeMockState = {
  information: [],
  warning: [],
  errors: [],
  clipboard: [],
  terminals: [],
  opened: [],
  diffCommands: [],
  panels: [],
  config: {},
  outputLines: [],
};

vi.mock('vscode', () => ({
  ViewColumn: { Active: 1, Beside: 2 },
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  Uri: {
    file: (path: string) => ({ scheme: 'file', path, fsPath: path, toString: () => `file://${path}` }),
    parse: (value: string) => ({ scheme: 'file', path: value, fsPath: value, toString: () => value }),
    joinPath: (base: { path: string }, ...parts: string[]) => {
      const path = [base.path.replace(/\/$/, ''), ...parts].join('/');
      return { scheme: 'file', path, fsPath: path, toString: () => `file://${path}` };
    },
  },
  window: {
    createOutputChannel: (title: string) => ({
      title,
      appendLine(line: string) {
        vscodeMock.outputLines.push({ title, line });
      },
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
    showTextDocument: (uri: { fsPath: string }) => {
      vscodeMock.opened.push(uri.fsPath);
      return Promise.resolve(undefined);
    },
    createTerminal: (options: { name?: string; cwd?: string }) => {
      vscodeMock.terminals.push(options);
      return { show() {} };
    },
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
    openExternal: (uri: { fsPath: string }) => {
      vscodeMock.opened.push(uri.fsPath);
      return Promise.resolve(true);
    },
  },
  commands: {
    executeCommand: async (command: string, left: { fsPath: string }, right: { fsPath: string }, title: string) => {
      vscodeMock.diffCommands.push({ command, left: left.fsPath, right: right.fsPath, title });
    },
  },
  ProgressLocation: { Notification: 15 },
}));

vi.mock('../src/core/svnCli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/svnCli')>();
  return { ...actual, run: vi.fn(), runOrThrow: vi.fn() };
});

import { run, runOrThrow, type RunResult } from '../src/core/svnCli';
import { SvnError } from '../src/core/errors';
import {
  OperationRegistry,
  getOperationRegistry,
  setOperationRegistryForTest,
} from '../src/core/operations';
import { format, strings } from '../src/host/i18n';
import { resetOutputState } from '../src/host/output';
import { resetPanelRegistry } from '../src/host/panel/host';
import {
  cancelConflictScan,
  conflictsModelForTest,
  conflictsSessionSnapshot,
  openConflictPanel,
  resetConflictPanelController,
  setConflictPanelContext,
} from '../src/host/panel/panels/conflicts';
import {
  conflictResultScopeOf,
  conflictScopeOf,
} from '../src/host/panel/conflictModel';
import { CONFLICT_BATCH_TEXT_DEFAULTS } from '../src/host/panel/conflictBatchModel';
import {
  putM4ScopeSession,
  readM4ScopeSession,
  resetM4SessionStore,
  resetSessionResults,
} from '../src/host/sessionResults';
import { hasActiveTask, resetTaskRegistry } from '../src/host/taskRegistry';
import { resetRunningOperationsForTest } from '../src/core/operations';

/* ------------------------------ 面板替身 ------------------------------ */

interface FakePanel {
  title: string;
  html: string;
  posted: Array<Record<string, unknown>>;
  disposed: boolean;
  reveal(): void;
  dispose(): void;
  send(raw: unknown): Promise<void> | void;
  sendIntent(intent: Record<string, unknown>, requestId?: string): Promise<void>;
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
    disposed: false,
    reveal() {},
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
    async sendIntent(intent, requestId) {
      seq += 1;
      await panel.send({
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, attempts = 1000, interval = 5): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (check()) {
      return;
    }
    await delay(interval);
  }
  expect(check()).toBe(true);
}

async function waitIdle(): Promise<void> {
  await waitFor(() => !hasActiveTask('conflicts'));
  await delay(0);
}

/* ------------------------------ SVN 状态机 ------------------------------ */

type MockKind = 'text' | 'property' | 'tree';

/** 属性三值之一：null=缺失，空串=空值，base64=true 表示 XML 以 base64 编码传输。 */
type MockPropertyValue = { value: string; base64?: boolean } | null;

interface MockPropertyConflict {
  name: string;
  local: MockPropertyValue;
  base: MockPropertyValue;
  incoming: MockPropertyValue;
}

interface MockConflict {
  path: string;
  kinds: MockKind[];
  nodeRevision: number | string;
  baselineRevision?: number;
  incomingRevision?: number;
  tree?: { reason: string; action: string; kind: 'file' | 'dir'; item: string; copied?: boolean };
  /** 属性冲突三值（proplist 读取桩按侧返回；未声明时属性读取失败）。 */
  properties?: MockPropertyConflict[];
}

const wcRoot = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-p7-mock-')));
let conflicts: MockConflict[] = [];
let statusCalls: string[][] = [];
let infoCalls: string[][] = [];
let resolveCalls: string[][] = [];
let statusDelayMs = 0;
let resolveDelayMs = 0;
let statusFailure: string | undefined;
let persistConflictAfterResolve = false;
/** 模拟 WC 锁定：status 根条目带 wc-locked="true"（阶段 0 实测形态）。 */
let wcLockedFlag = false;

function resetSvnState(): void {
  conflicts = [];
  statusCalls = [];
  infoCalls = [];
  resolveCalls = [];
  statusDelayMs = 0;
  resolveDelayMs = 0;
  statusFailure = undefined;
  persistConflictAfterResolve = false;
  wcLockedFlag = false;
}

function textConflict(path: string, extra: Partial<MockConflict> = {}): MockConflict {
  return { path, kinds: ['text'], nodeRevision: 3, baselineRevision: 2, incomingRevision: 3, ...extra };
}

function treeConflict(path: string, item = 'deleted'): MockConflict {
  return {
    path,
    kinds: ['tree'],
    nodeRevision: 2,
    incomingRevision: 3,
    tree: { reason: 'delete', action: 'edit', kind: 'file', item },
  };
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function buildStatusXml(): string {
  const entries = conflicts.map((conflict) => {
    if (conflict.kinds.includes('tree') && conflict.tree !== undefined) {
      const copied = conflict.tree.copied === true ? ' copied="true"' : '';
      return `<entry path="${escapeXml(conflict.path)}">`
        + `<wc-status item="${conflict.tree.item}" revision="3" props="none"${copied} tree-conflicted="true">`
        + '</wc-status></entry>';
    }
    const item = conflict.kinds.includes('text') ? 'conflicted' : 'normal';
    const props = conflict.kinds.includes('property') ? 'conflicted' : 'none';
    return `<entry path="${escapeXml(conflict.path)}">`
      + `<wc-status item="${item}" revision="${String(conflict.nodeRevision)}" props="${props}">`
      + '</wc-status></entry>';
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<status><target path=".">'
    + `<entry path="."><wc-status item="normal" revision="3" props="none"${wcLockedFlag ? ' wc-locked="true"' : ''}></wc-status></entry>`
    + entries
    + '<entry path="extdir/ext"><wc-status item="external" props="none"></wc-status></entry>'
    + '</target></status>';
}

function buildInfoXml(targets: readonly string[]): string {
  const entries = targets.map((target) => {
    const conflict = conflicts.find((candidate) => candidate.path === target);
    if (conflict === undefined) {
      return '';
    }
    if (conflict.kinds.includes('tree') && conflict.tree !== undefined) {
      return `<entry kind="${conflict.tree.kind}" path="${escapeXml(target)}" revision="${String(conflict.nodeRevision)}">`
        + `<tree-conflict operation="update" kind="${conflict.tree.kind}" reason="${conflict.tree.reason}"`
        + ` victim="${escapeXml(target)}" action="${conflict.tree.action}">`
        + `<version side="source-right" kind="file" path-in-repos="${escapeXml(target)}" repos-url="file:///repo" revision="${String(conflict.incomingRevision ?? 3)}"/>`
        + '</tree-conflict></entry>';
    }
    const nodes: string[] = [];
    if (conflict.kinds.includes('text')) {
      nodes.push(
        '<conflict operation="update" type="text">'
        + `<version side="source-left" kind="file" path-in-repos="${escapeXml(target)}" repos-url="file:///repo" revision="${String(conflict.baselineRevision ?? 2)}"/>`
        + `<version side="source-right" kind="file" path-in-repos="${escapeXml(target)}" repos-url="file:///repo" revision="${String(conflict.incomingRevision ?? 3)}"/>`
        + `<prev-base-file>${escapeXml(join(wcRoot, `${target}.r2`))}</prev-base-file>`
        + `<prev-wc-file>${escapeXml(join(wcRoot, `${target}.mine`))}</prev-wc-file>`
        + `<cur-base-file>${escapeXml(join(wcRoot, `${target}.r3`))}</cur-base-file>`
        + '</conflict>',
      );
    }
    if (conflict.kinds.includes('property')) {
      nodes.push(
        '<conflict operation="update" type="property">'
        + `<version side="source-left" kind="file" path-in-repos="${escapeXml(target)}" repos-url="file:///repo" revision="${String(conflict.baselineRevision ?? 2)}"/>`
        + `<version side="source-right" kind="file" path-in-repos="${escapeXml(target)}" repos-url="file:///repo" revision="${String(conflict.incomingRevision ?? 3)}"/>`
        + `<prop-file>${escapeXml(join(wcRoot, `${target}.prej`))}</prop-file>`
        + '</conflict>',
      );
    }
    return `<entry kind="file" path="${escapeXml(target)}" revision="${String(conflict.nodeRevision)}">`
      + `<url>file:///repo/${escapeXml(target)}</url>${nodes.join('')}</entry>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<info>${entries}</info>`;
}

function runResult(stdout: string, stderr = '', exitCode = 0): RunResult {
  return { stdout, stderr, exitCode };
}

/** proplist 目标 → 冲突记录与侧：本地=工作副本相对路径；基线/传入=file:///repo/<path>@rev。 */
function resolveProplistTarget(
  target: string,
): { conflict: MockConflict; side: 'local' | 'base' | 'incoming' } | undefined {
  const remotePrefix = 'file:///repo/';
  const isRemote = target.startsWith(remotePrefix);
  const at = target.lastIndexOf('@');
  const path = isRemote && at > remotePrefix.length ? target.slice(remotePrefix.length, at) : target;
  const conflict = conflicts.find((candidate) => candidate.path === path);
  if (conflict === undefined || conflict.properties === undefined) {
    return undefined;
  }
  if (!isRemote) {
    return { conflict, side: 'local' };
  }
  const revision = Number(target.slice(at + 1));
  return { conflict, side: revision === (conflict.incomingRevision ?? 3) ? 'incoming' : 'base' };
}

/** 按侧生成 `proplist --xml --verbose` 输出；缺失侧不输出 property 节点。 */
function buildPropertyValuesXml(
  properties: MockPropertyConflict[],
  side: 'local' | 'base' | 'incoming',
): string {
  const items = properties.map((property) => {
    const value = property[side];
    if (value === null) {
      return '';
    }
    const encoding = value.base64 === true ? ' encoding="base64"' : '';
    const text = value.base64 === true
      ? Buffer.from(value.value, 'utf8').toString('base64')
      : escapeXml(value.value);
    return `<property name="${escapeXml(property.name)}"${encoding}>${text}</property>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<properties><target path="">${items}</target></properties>`;
}

function installSvnStub(): void {
  vi.mocked(run).mockImplementation(async (_svnPath, args, options) => {
    const command = args[0];
    if (command === 'status') {
      statusCalls.push([...args]);
      if (statusDelayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, statusDelayMs);
          options?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new SvnError({ message: 'aborted', command: [...args], stderr: '', exitCode: 1, code: 'ABORTED' }));
          }, { once: true });
        });
      }
      if (statusFailure !== undefined) {
        return runResult('', statusFailure, 1);
      }
      return runResult(buildStatusXml());
    }
    if (command === 'info') {
      infoCalls.push([...args]);
      const separator = args.lastIndexOf('--');
      const targets = args.slice(separator + 1);
      return runResult(buildInfoXml(targets));
    }
    if (command === 'propget' || command === 'proplist') {
      return runResult('', 'svn: E200009: none', 1);
    }
    return runResult('');
  });
  vi.mocked(runOrThrow).mockImplementation(async (_svnPath, args) => {
    if (args[0] === 'resolve') {
      resolveCalls.push([...args]);
      if (resolveDelayMs > 0) {
        await delay(resolveDelayMs);
      }
      const separator = args.lastIndexOf('--');
      const target = args[separator + 1] ?? '';
      if (!persistConflictAfterResolve) {
        conflicts = conflicts.filter((conflict) => conflict.path !== target);
      }
      return runResult('');
    }
    if (args[0] === 'propset' || args[0] === 'propdel') {
      return runResult('');
    }
    if (args[0] === 'proplist') {
      const resolved = resolveProplistTarget(args[args.lastIndexOf('--') + 1] ?? '');
      if (resolved === undefined) {
        return runResult('', 'svn: E200009: none', 1);
      }
      return runResult(buildPropertyValuesXml(resolved.conflict.properties!, resolved.side));
    }
    return runResult('');
  });
}

/* ------------------------------ 环境 ------------------------------ */

function resetVscodeMock(): void {
  vscodeMock.information.length = 0;
  vscodeMock.warning.length = 0;
  vscodeMock.errors.length = 0;
  vscodeMock.clipboard.length = 0;
  vscodeMock.terminals.length = 0;
  vscodeMock.opened.length = 0;
  vscodeMock.diffCommands.length = 0;
  vscodeMock.panels.length = 0;
  vscodeMock.config = {};
  vscodeMock.outputLines.length = 0;
}

function resetController(): void {
  resetConflictPanelController();
  resetPanelRegistry();
  resetTaskRegistry();
  resetSessionResults();
  resetM4SessionStore();
  resetRunningOperationsForTest();
}

function setup(): void {
  resetVscodeMock();
  resetController();
  resetOutputState();
  setOperationRegistryForTest(new OperationRegistry());
  setConflictPanelContext({
    extensionUri: { path: '/ext', toString: () => 'file:///ext' } as unknown as vscode.Uri,
    subscriptions: [],
  });
  installSvnStub();
}

afterEach(() => {
  resetController();
  resetSvnState();
  setOperationRegistryForTest(undefined);
});

/* ------------------------------ 辅助 ------------------------------ */

function writeWorkFile(path: string, content = 'line1\nline2\n'): void {
  const fsPath = join(wcRoot, path);
  mkdirSync(join(fsPath, '..'), { recursive: true });
  writeFileSync(fsPath, content);
}

/** row key 从模型取（冲突指纹哈希）。 */
function rowIdOf(path: string): string {
  const model = conflictsModelForTest();
  const row = model?.rows().find((candidate) => candidate.path === path);
  expect(row).toBeDefined();
  return row!.key;
}

async function selectPath(path: string): Promise<void> {
  // 真实意图：宿主行校验查 conflictList 后转发控制器。
  await sendIntent({ kind: 'selectConflict', id: rowIdOf(path) });
  expect(conflictsModelForTest()?.selectedKey()).toBe(rowIdOf(path));
  await delay(0);
}

async function sendIntent(intent: Record<string, unknown>): Promise<void> {
  await fakePanel().sendIntent(intent);
  await delay(0);
}

/** 打开面板并等待自动扫描结束。 */
async function openAndScan(): Promise<void> {
  await openConflictPanel({ source: 'local', wcRoot, scopeRelPath: '.' });
  await waitIdle();
}

function readSnapshotStore() {
  return readM4ScopeSession(conflictResultScopeOf(conflictScopeOf(wcRoot, '.')));
}

/* ------------------------------ 用例 ------------------------------ */

describe('P7 面板控制器（mock SVN）', () => {
  it('打开即扫描：status 三判据 + 批量 info，列表与分类计数上屏', async () => {
    writeWorkFile('text.txt');
    conflicts = [textConflict('text.txt')];
    setup();
    await openAndScan();
    expect(statusCalls.length).toBe(1);
    expect(statusCalls[0]).toEqual(['status', '--xml', '--ignore-externals', '--', '.']);
    expect(infoCalls.length).toBeGreaterThan(0);
    expect(infoCalls[0]).toContain('text.txt');
    const snapshot = conflictsSessionSnapshot();
    expect(snapshot.phase).toBe('ready');
    expect(snapshot.rows).toBe(1);
    expect(snapshot.scanning).toBe(false);
    expect(hasActiveTask('conflicts')).toBe(false);
    const model = conflictsModelForTest()!;
    expect(model.tabCounts()).toEqual({ all: 1, text: 1, property: 0, tree: 0 });
    expect(fakePanel().latestRenderHtml()).toContain('text.txt');
    // 集中存储：扫描完成写入快照。
    expect(readSnapshotStore()?.conflictSnapshot).toBeDefined();
  });

  it('扫描中关闭面板：任务继续并写会话缓存，重开恢复不重新扫描', async () => {
    writeWorkFile('text.txt');
    conflicts = [textConflict('text.txt')];
    statusDelayMs = 80;
    setup();
    await openConflictPanel({ source: 'local', wcRoot, scopeRelPath: '.' });
    expect(hasActiveTask('conflicts')).toBe(true);
    expect(conflictsSessionSnapshot().scanning).toBe(true);
    const panel = fakePanel();
    panel.dispose();
    expect(hasActiveTask('conflicts')).toBe(true);
    await waitIdle();
    // 关闭期间任务完成：快照已写入 m4SessionStore。
    const stored = readSnapshotStore();
    expect(stored?.conflictSnapshot).toBeDefined();
    const statusBefore = statusCalls.length;

    await openConflictPanel({ source: 'local', wcRoot, scopeRelPath: '.' });
    await delay(10);
    expect(statusCalls.length).toBe(statusBefore);
    const snapshot = conflictsSessionSnapshot();
    expect(snapshot.rows).toBe(1);
    expect(snapshot.phase).toBe('ready');
  });

  it('扫描中关闭后立即重开：绑定同一任务模型，完成后状态转 ready', async () => {
    writeWorkFile('text.txt');
    conflicts = [textConflict('text.txt')];
    statusDelayMs = 60;
    setup();
    await openConflictPanel({ source: 'local', wcRoot, scopeRelPath: '.' });
    const firstModel = conflictsModelForTest();
    expect(hasActiveTask('conflicts')).toBe(true);
    fakePanel().dispose();
    // 立即重开：findTaskByScope 命中运行中任务，模型切到任务实例。
    await openConflictPanel({ source: 'local', wcRoot, scopeRelPath: '.' });
    expect(conflictsModelForTest()).toBe(firstModel);
    expect(conflictsSessionSnapshot().scanning).toBe(true);
    expect(conflictsSessionSnapshot().taskKind).toBe('scan');
    await waitIdle();
    await delay(10);
    expect(conflictsSessionSnapshot().phase).toBe('ready');
    expect(conflictsSessionSnapshot().rows).toBe(1);
  });

  it('空结果：没有冲突时区分空态而不是扫描失败', async () => {
    setup();
    await openAndScan();
    const snapshot = conflictsSessionSnapshot();
    expect(snapshot.phase).toBe('ready');
    expect(snapshot.rows).toBe(0);
    expect(fakePanel().latestRenderHtml()).toContain(strings.conflictPanel.emptyTitle);
  });

  it('扫描完成后关闭重开：恢复快照与选择，不自动重扫', async () => {
    writeWorkFile('text.txt');
    conflicts = [textConflict('text.txt')];
    setup();
    await openAndScan();
    await selectPath('text.txt');
    const statusBefore = statusCalls.length;
    fakePanel().dispose();
    await openConflictPanel({ source: 'local', wcRoot, scopeRelPath: '.' });
    await delay(10);
    expect(statusCalls.length).toBe(statusBefore);
    const snapshot = conflictsSessionSnapshot();
    expect(snapshot.rows).toBe(1);
    expect(snapshot.selected).toBe(rowIdOf('text.txt'));
  });

  it('扫描失败：错误态与失败文案进面板，任务按终态移除', async () => {
    conflicts = [textConflict('text.txt')];
    statusFailure = 'svn: E000013: Can\'t check path: Permission denied';
    setup();
    await openAndScan();
    const snapshot = conflictsSessionSnapshot();
    expect(snapshot.phase).toBe('error');
    expect(snapshot.rows).toBe(0);
    expect(fakePanel().latestRenderHtml()).toContain(strings.conflictPanel.scanFailedTitle);
  });

  it('取消扫描：在途回包因代次过期，状态回到未扫描而不是失败', async () => {
    writeWorkFile('text.txt');
    conflicts = [textConflict('text.txt')];
    statusDelayMs = 120;
    setup();
    await openConflictPanel({ source: 'local', wcRoot, scopeRelPath: '.' });
    expect(hasActiveTask('conflicts')).toBe(true);
    expect(cancelConflictScan()).toBe(true);
    expect(hasActiveTask('conflicts')).toBe(false);
    expect(conflictsSessionSnapshot().scanning).toBe(false);
    expect(conflictsSessionSnapshot().phase).toBe('idle');
    // 迟到的 status 回包到达后不得把状态改成 ready/error。
    await delay(200);
    expect(conflictsSessionSnapshot().phase).toBe('idle');
    expect(conflictsSessionSnapshot().rows).toBe(0);
  });

  it('tab/选择/推迟：会话状态意图不发 SVN 写命令', async () => {
    writeWorkFile('text.txt');
    conflicts = [textConflict('text.txt')];
    setup();
    await openAndScan();
    await sendIntent({ kind: 'setConflictTab', tab: 'text' });
    expect(conflictsModelForTest()!.tab()).toBe('text');
    await selectPath('text.txt');
    await sendIntent({ kind: 'postponeConflict' });
    const row = conflictsModelForTest()!.rows()[0];
    expect(row.status).toBe('postponed');
    expect(resolveCalls.length).toBe(0);
    expect(conflictsSessionSnapshot().postponed).toBe(1);
  });

  it('working 二次确认：确认前不发 resolve，确认后按 --depth empty 执行并回扫撤下', async () => {
    writeWorkFile('text.txt');
    conflicts = [textConflict('text.txt')];
    setup();
    await openAndScan();
    await selectPath('text.txt');
    await sendIntent({ kind: 'chooseConflictVariant', value: 'working' });
    await sendIntent({ kind: 'applyConflictResolution' });
    expect(resolveCalls.length).toBe(0);
    expect(conflictsSessionSnapshot().pendingConfirm?.kind).toBe('working');
    expect(fakePanel().latestRenderHtml()).toContain(strings.conflictPanel.workingConfirmTitle);

    await sendIntent({ kind: 'bannerAction', bannerId: 'conflictWorkingConfirm', actionId: 'confirmWorkingApply' });
    await waitIdle();
    expect(resolveCalls.length).toBe(1);
    expect(resolveCalls[0]).toEqual([
      'resolve', '--non-interactive', '--accept', 'working', '--depth', 'empty', '--', 'text.txt',
    ]);
    const snapshot = conflictsSessionSnapshot();
    expect(snapshot.ledger).toBe(1);
    expect(snapshot.resolveNotice).toBe(strings.resolvePanel.outcomeResolved);
  });

  it('树冲突：必须先确认节点；确认后 working 才执行', async () => {
    conflicts = [treeConflict('tree-del.txt')];
    setup();
    await openAndScan();
    await selectPath('tree-del.txt');
    await sendIntent({ kind: 'applyConflictResolution' });
    expect(resolveCalls.length).toBe(0);
    expect(conflictsSessionSnapshot().ledger).toBe(0);

    await sendIntent({ kind: 'prepareTreeConflict' });
    expect(conflictsSessionSnapshot().pendingConfirm?.kind).toBe('tree');
    // 取消确认不改变 prepared 状态。
    await sendIntent({ kind: 'bannerAction', bannerId: 'conflictTreeConfirm', actionId: 'cancelConflictConfirm' });
    expect(conflictsModelForTest()!.isTreePrepared(rowIdOf('tree-del.txt'))).toBe(false);

    await sendIntent({ kind: 'prepareTreeConflict' });
    await sendIntent({ kind: 'bannerAction', bannerId: 'conflictTreeConfirm', actionId: 'confirmTreePrepared' });
    expect(conflictsModelForTest()!.isTreePrepared(rowIdOf('tree-del.txt'))).toBe(true);
    await sendIntent({ kind: 'applyConflictResolution' });
    await waitIdle();
    expect(resolveCalls.length).toBe(1);
    expect(resolveCalls[0]?.includes('working')).toBe(true);
    expect(conflictsSessionSnapshot().ledger).toBe(1);
  });

  it('resolve 中关闭面板：写任务继续并收口，重开读到台账与结果', async () => {
    writeWorkFile('text.txt');
    conflicts = [textConflict('text.txt')];
    resolveDelayMs = 80;
    setup();
    await openAndScan();
    await selectPath('text.txt');
    await sendIntent({ kind: 'chooseConflictVariant', value: 'theirs-full' });
    await sendIntent({ kind: 'applyConflictResolution' });
    expect(hasActiveTask('conflicts')).toBe(true);
    expect(conflictsSessionSnapshot().taskKind).toBe('resolve');
    fakePanel().dispose();
    expect(hasActiveTask('conflicts')).toBe(true);
    await waitIdle();
    // 关闭期间完成：终态写入 m4SessionStore（冲突快照 + 台账）。
    const stored = readSnapshotStore();
    expect((stored?.resolvedLedger as unknown[] | undefined)?.length).toBe(1);
    expect(stored?.terminalPage).toBeDefined();

    await openConflictPanel({ source: 'local', wcRoot, scopeRelPath: '.' });
    await delay(10);
    expect(conflictsSessionSnapshot().ledger).toBe(1);
    expect(conflictsSessionSnapshot().writeLocked).toBe(false);
  });

  it('成功提示可关闭：dismissBanner 只清除控制器提示，不改冲突状态', async () => {
    writeWorkFile('text.txt');
    conflicts = [textConflict('text.txt')];
    setup();
    await openAndScan();
    await selectPath('text.txt');
    await sendIntent({ kind: 'chooseConflictVariant', value: 'theirs-full' });
    await sendIntent({ kind: 'applyConflictResolution' });
    await waitIdle();
    expect(conflictsSessionSnapshot().resolveNotice).toBeDefined();
    await sendIntent({ kind: 'dismissBanner', bannerId: 'conflictResolveNotice' });
    expect(conflictsSessionSnapshot().resolveNotice).toBeUndefined();
    expect(conflictsSessionSnapshot().ledger).toBe(1);
  });

  it('回扫矛盾 → unknown 写锁：不写台账、apply 被放行表拒绝；重新扫描仍冲突后释放', async () => {
    writeWorkFile('text.txt');
    conflicts = [textConflict('text.txt')];
    persistConflictAfterResolve = true;
    setup();
    await openAndScan();
    await selectPath('text.txt');
    await sendIntent({ kind: 'chooseConflictVariant', value: 'theirs-full' });
    await sendIntent({ kind: 'applyConflictResolution' });
    await waitIdle();
    expect(resolveCalls.length).toBe(1);
    let snapshot = conflictsSessionSnapshot();
    expect(snapshot.ledger).toBe(0);
    expect(snapshot.unknown).toBe(1);
    expect(snapshot.writeLocked).toBe(true);
    expect(snapshot.pendingOperationId).toBeDefined();
    // 写锁下 apply 被 P7 放行表拒绝（宿主 toast 占用提示，不进入控制器写链）。
    const before = resolveCalls.length;
    await selectPath('text.txt');
    await sendIntent({ kind: 'chooseConflictVariant', value: 'mine-full' });
    await sendIntent({ kind: 'applyConflictResolution' });
    expect(resolveCalls.length).toBe(before);

    // 重新扫描仍报告同一冲突：结束未决记录、释放写锁，但不写台账。
    await sendIntent({ kind: 'rescanConflicts', scope: 'task' });
    await waitIdle();
    snapshot = conflictsSessionSnapshot();
    expect(snapshot.writeLocked).toBe(false);
    expect(snapshot.ledger).toBe(0);
    expect(getOperationRegistry().writeRestriction(wcRoot)).toBeUndefined();
  });

  it('回扫矛盾后外部解决并经重新扫描确认：按固定意图策略写入 resolvedLedger', async () => {
    writeWorkFile('text.txt');
    conflicts = [textConflict('text.txt')];
    persistConflictAfterResolve = true;
    setup();
    await openAndScan();
    await selectPath('text.txt');
    await sendIntent({ kind: 'chooseConflictVariant', value: 'theirs-full' });
    await sendIntent({ kind: 'applyConflictResolution' });
    await waitIdle();
    expect(conflictsSessionSnapshot().writeLocked).toBe(true);

    // 外部完成解决（mock 清空冲突）后重新扫描：回扫确认清除。
    conflicts = [];
    await sendIntent({ kind: 'rescanConflicts', scope: 'task' });
    await waitIdle();
    const snapshot = conflictsSessionSnapshot();
    expect(snapshot.writeLocked).toBe(false);
    expect(snapshot.ledger).toBe(1);
    const ledger = conflictsModelForTest()!.ledger();
    expect(ledger[0]).toMatchObject({ path: 'text.txt', kinds: ['text'], strategy: 'theirs-full' });
    expect(getOperationRegistry().writeRestriction(wcRoot)).toBeUndefined();
  });

  it('混合路径：不直接应用单一策略，无写命令', async () => {
    writeWorkFile('mixed.txt');
    conflicts = [{
      path: 'mixed.txt',
      kinds: ['text', 'property'],
      nodeRevision: 3,
      baselineRevision: 2,
      incomingRevision: 3,
    }];
    setup();
    await openAndScan();
    await selectPath('mixed.txt');
    await sendIntent({ kind: 'chooseConflictVariant', value: 'theirs-full' });
    await sendIntent({ kind: 'applyConflictResolution' });
    expect(resolveCalls.length).toBe(0);
    expect(conflictsSessionSnapshot().ledger).toBe(0);
    expect(fakePanel().toasts().some((message) => message.includes('同一路径'))).toBe(true);
  });

  it('跨面板写锁：他人 unknown 记录存在时 apply 被放行表拒绝', async () => {
    writeWorkFile('text.txt');
    conflicts = [textConflict('text.txt')];
    setup();
    // 预置一个 history-update 未决记录（P1-P6 与 P7 共用 wcRoot 写锁）。
    const registry = getOperationRegistry();
    const begin = await registry.begin({
      wcRoot,
      lockKey: wcRoot,
      kind: 'history-update',
      operationId: 'op-history-unknown',
      targetRelPath: '.',
      nodeKind: 'dir',
      historyUpdateIntent: {
        wcRoot,
        targetRelPath: '.',
        targetKind: 'dir',
        targetUrl: 'file:///repo',
        requestedRevision: 1,
        preRevision: 3,
      },
    });
    expect(begin.ok).toBe(true);
    await registry.markPhase('op-history-unknown', 'unknown');
    await openAndScan();
    expect(conflictsSessionSnapshot().writeLocked).toBe(true);
    await selectPath('text.txt');
    await sendIntent({ kind: 'chooseConflictVariant', value: 'theirs-full' });
    await sendIntent({ kind: 'applyConflictResolution' });
    expect(resolveCalls.length).toBe(0);
  });

  it('只读交互入口：原生差异、编辑器、工作副本终端与打开版本', async () => {
    writeWorkFile('text.txt');
    writeFileSync(join(wcRoot, 'text.txt.r2'), 'line1\n');
    conflicts = [textConflict('text.txt')];
    setup();
    await openAndScan();
    await selectPath('text.txt');
    await sendIntent({ kind: 'openConflictDiff' });
    expect(vscodeMock.diffCommands.length).toBe(1);
    expect(vscodeMock.diffCommands[0]).toMatchObject({
      command: 'vscode.diff',
      left: join(wcRoot, 'text.txt.r2'),
      right: join(wcRoot, 'text.txt'),
    });
    await sendIntent({ kind: 'openConflictEditor' });
    expect(vscodeMock.opened).toContain(join(wcRoot, 'text.txt'));
    await sendIntent({ kind: 'openWorkCopyTerminal' });
    expect(vscodeMock.terminals[0]?.cwd).toBe(wcRoot);
    await sendIntent({ kind: 'openConflictVersion', role: 'base' });
    expect(vscodeMock.opened).toContain(join(wcRoot, 'text.txt.r2'));
  });

  it('检查器输出只含属性名/存在性/字节数：输出频道不含属性值原文（含 base64/空值/缺失）', async () => {
    writeWorkFile('prop.txt');
    // 独特标记：属性值原文任何形态都不得出现在输出频道。
    const localMark = 'P7-INSPECT-SECRET-LOCAL-7f3a9c';
    const baseMark = 'P7-INSPECT-SECRET-BASE-91c2d4';
    const base64Mark = 'P7-INSPECT-SECRET-BASE64-5d8e1b';
    conflicts = [{
      path: 'prop.txt',
      kinds: ['property'],
      nodeRevision: 3,
      baselineRevision: 2,
      incomingRevision: 3,
      properties: [
        // p1：文本值 + 传入缺失。
        { name: 'p1', local: { value: localMark }, base: { value: baseMark }, incoming: null },
        // p2：base64 传输 + 空值 + 缺失（多属性逐项形态）。
        { name: 'p2', local: { value: base64Mark, base64: true }, base: { value: '' }, incoming: null },
      ],
    }];
    setup();
    await openAndScan();
    await selectPath('prop.txt');
    // 属性值原文只保留在面板详情（只读展示，不写回）。
    expect(fakePanel().latestRenderHtml()).toContain(localMark);
    expect(fakePanel().latestRenderHtml()).toContain(base64Mark);

    vscodeMock.outputLines.length = 0;
    await sendIntent({ kind: 'inspectConflict' });
    const conflictOutput = vscodeMock.outputLines
      .filter((entry) => entry.title === strings.output.titleConflict)
      .map((entry) => entry.line)
      .join('\n');
    expect(conflictOutput).toContain('prop.txt');
    const existsText = (bytes: number) =>
      format(strings.conflictPanel.inspectPropertyExists, { bytes: String(bytes) });
    const missing = strings.conflictPanel.inspectPropertyMissing;
    // 检查器按「属性名 + 三侧存在性/字节数」输出（不含任何值文本）。
    expect(conflictOutput).toContain(
      `${strings.conflictPanel.inspectPropertyName} p1: `
      + `${strings.conflictPanel.propertyMine}${existsText(Buffer.byteLength(localMark))}`
      + ` / ${strings.conflictPanel.propertyBase}${existsText(Buffer.byteLength(baseMark))}`
      + ` / ${strings.conflictPanel.propertyIncoming}${missing}`,
    );
    expect(conflictOutput).toContain(
      `${strings.conflictPanel.inspectPropertyName} p2: `
      + `${strings.conflictPanel.propertyMine}${existsText(Buffer.byteLength(base64Mark))}`
      + ` / ${strings.conflictPanel.propertyBase}${existsText(0)}`
      + ` / ${strings.conflictPanel.propertyIncoming}${missing}`,
    );
    for (const rawValue of [
      localMark,
      baseMark,
      base64Mark,
      Buffer.from(base64Mark, 'utf8').toString('base64'),
    ]) {
      expect(conflictOutput).not.toContain(rawValue);
    }
  });

  it('整副本扫描：整副本范围直接重扫，非整副本范围切换到整副本', async () => {
    writeWorkFile('text.txt');
    conflicts = [textConflict('text.txt')];
    setup();
    await openAndScan();
    const callsBefore = statusCalls.length;
    await sendIntent({ kind: 'scanWholeWorkCopy' });
    await waitIdle();
    expect(statusCalls.length).toBe(callsBefore + 1);

    // 从更新任务范围进入（scopeRelPath=sub），整副本扫描切到 '.'。
    fakePanel().dispose();
    await openConflictPanel({ source: 'update', wcRoot, scopeRelPath: 'sub' });
    await waitIdle();
    expect(conflictsSessionSnapshot().scope?.scopeRelPath).toBe('sub');
    expect(statusCalls[statusCalls.length - 1]).toEqual(['status', '--xml', '--ignore-externals', '--', 'sub']);
    await sendIntent({ kind: 'scanWholeWorkCopy' });
    await waitIdle();
    expect(conflictsSessionSnapshot().scope?.scopeRelPath).toBe('.');
    expect(statusCalls[statusCalls.length - 1]).toEqual(['status', '--xml', '--ignore-externals', '--', '.']);
  });

  it('更新任务上下文：顶部展示请求 revision、更新前 BASE 与回读节点 BASE；非法载荷不展示', async () => {
    writeWorkFile('sub/text.txt');
    conflicts = [textConflict('sub/text.txt')];
    setup();
    await openConflictPanel({
      source: 'update',
      wcRoot,
      scopeRelPath: 'sub',
      taskContext: {
        targetRelPath: 'sub',
        targetKind: 'dir',
        requestedRevision: 5,
        preRevision: 3,
        postNodeRevision: 4,
        outcome: 'conflict',
        conflictCount: 1,
      },
    });
    await waitIdle();
    expect(conflictsSessionSnapshot().updateTaskContext).toMatchObject({
      requestedRevision: 5,
      preRevision: 3,
      postNodeRevision: 4,
      outcome: 'conflict',
      conflictCount: 1,
    });
    const html = fakePanel().latestRenderHtml();
    expect(html).toContain('更新请求 r5');
    expect(html).toContain('更新前 BASE r3');
    expect(html).toContain('回读节点 BASE r4');
    // 范围仍是更新任务范围（保留任务范围，整副本是独立动作）。
    expect(conflictsSessionSnapshot().scope?.scopeRelPath).toBe('sub');

    // 回读缺失：显示明确的未知徽标，不用请求 revision 冒充。
    fakePanel().dispose();
    await openConflictPanel({
      source: 'update',
      wcRoot,
      scopeRelPath: 'sub',
      taskContext: {
        targetRelPath: 'sub',
        targetKind: 'dir',
        requestedRevision: 5,
        preRevision: 3,
        outcome: 'unknown',
        conflictCount: 0,
      },
    });
    await waitIdle();
    expect(fakePanel().latestRenderHtml()).toContain('回读节点 BASE 未知');

    // 非法载荷：整段拒绝，不展示任何更新上下文徽标。
    fakePanel().dispose();
    await openConflictPanel({
      source: 'update',
      wcRoot,
      scopeRelPath: 'sub',
      taskContext: { requestedRevision: 5 },
    });
    await waitIdle();
    expect(conflictsSessionSnapshot().updateTaskContext).toBeUndefined();
    expect(fakePanel().latestRenderHtml()).not.toContain('更新请求 r5');
  });

  it('终态页恢复：resolve 结果提示在重开后一次性展示', async () => {
    writeWorkFile('text.txt');
    conflicts = [textConflict('text.txt')];
    setup();
    await openAndScan();
    await selectPath('text.txt');
    await sendIntent({ kind: 'chooseConflictVariant', value: 'theirs-full' });
    await sendIntent({ kind: 'applyConflictResolution' });
    await waitIdle();
    expect(conflictsSessionSnapshot().resolveNotice).toBe(strings.resolvePanel.outcomeResolved);
    fakePanel().dispose();
    // 清掉扫描快照但保留终态页的形态由存储层保证；这里仅验证重开时
    // 终态页提示不会丢失（读取后清除）。
    putM4ScopeSession(conflictResultScopeOf(conflictScopeOf(wcRoot, '.')), {
      terminalPage: {
        version: 1,
        kind: 'resolve',
        at: Date.now(),
        outcome: 'resolved',
        message: strings.resolvePanel.outcomeResolved,
        path: 'text.txt',
      },
    });
    conflicts = [];
    await openConflictPanel({ source: 'local', wcRoot, scopeRelPath: '.' });
    await delay(10);
    expect(conflictsSessionSnapshot().resolveNotice).toBe(strings.resolvePanel.outcomeResolved);
    // 恢复后终态页被清除：再次重开不再重复提示。
    expect(readSnapshotStore()?.terminalPage).toBeUndefined();
  });

  it('格式化文案与 i18n 键存在（控制器补充键交付对账）', () => {
    expect(format(strings.conflictPanel.busyHeld, {})).toContain('冲突任务');
    expect(format(strings.resolvePanel.outcomeResolved, {})).toBeDefined();
  });
});

/* ================================================================================
 * P7 批量计划与执行（mock SVN）：三组计划、逐项 begin/resolve/回读/收口、
 * 中途失败停止（余项未执行）、关闭重开恢复、wcLocked 整体禁写与单任务槽。
 * ================================================================================ */

describe('P7 批量计划与执行（mock SVN）', () => {
  function mockPropertyConflict(path: string): MockConflict {
    return {
      path,
      kinds: ['property'],
      nodeRevision: 3,
      baselineRevision: 2,
      incomingRevision: 3,
      properties: [{
        name: 'k',
        local: { value: 'local' },
        base: { value: 'base' },
        incoming: { value: 'theirs' },
      }],
    };
  }

  async function planBatch(strategy = 'theirs-full'): Promise<void> {
    await sendIntent({ kind: 'planConflictBatch', strategy });
  }

  async function startBatch(): Promise<void> {
    await sendIntent({ kind: 'startConflictBatch' });
    await waitIdle();
  }

  it('planConflictBatch：可执行/不适用/推迟三组上屏，不执行任何写命令', async () => {
    writeWorkFile('text.txt');
    writeWorkFile('prop.txt');
    conflicts = [textConflict('text.txt'), mockPropertyConflict('prop.txt'), treeConflict('tree-del.txt')];
    setup();
    await openAndScan();
    await selectPath('tree-del.txt');
    await sendIntent({ kind: 'postponeConflict' });
    const before = resolveCalls.length;
    await planBatch('theirs-full');
    const snapshot = conflictsSessionSnapshot();
    expect(snapshot.batch).toMatchObject({
      mode: 'plan',
      applicable: 1,
      unsupported: 1,
      postponed: 1,
      writeBlocked: false,
      planInvalidated: false,
    });
    expect(resolveCalls.length).toBe(before);
    const html = fakePanel().latestRenderHtml();
    expect(html).toContain(CONFLICT_BATCH_TEXT_DEFAULTS.batchPlanHeading);
    expect(html).toContain(wcRoot.replaceAll('&', '&amp;'));
    expect(html).toContain(CONFLICT_BATCH_TEXT_DEFAULTS.batchUnsupportedProperty);
    expect(html).toContain('data-intent="startConflictBatch"');
    // 策略切换重新生成计划（新 planId），仍不发写命令。
    const firstPlanId = snapshot.batch?.planId;
    await planBatch('mine-full');
    expect(conflictsSessionSnapshot().batch?.planId).not.toBe(firstPlanId);
    expect(resolveCalls.length).toBe(before);
  });

  it('startConflictBatch：逐项 resolve + 回读 + 最终回扫；成功后台账与结果页一致', async () => {
    writeWorkFile('a.txt');
    writeWorkFile('b.txt');
    conflicts = [textConflict('a.txt'), textConflict('b.txt')];
    setup();
    await openAndScan();
    await planBatch('theirs-full');
    const statusBefore = statusCalls.length;
    await startBatch();
    expect(resolveCalls.length).toBe(2);
    for (const call of resolveCalls) {
      expect(call.slice(0, 4)).toEqual(['resolve', '--non-interactive', '--accept', 'theirs-full']);
      expect(call).toContain('--depth');
      expect(['a.txt', 'b.txt']).toContain(call[call.length - 1]);
    }
    // 每项都有独立 operation record（batchId 归组）并已 done 收口。
    const snapshot = conflictsSessionSnapshot();
    expect(snapshot.batch).toMatchObject({
      mode: 'results',
      items: 2,
      resolved: 2,
      failed: 0,
      unknown: 0,
      notRun: 0,
      planInvalidated: false,
      rescan: 'scanned',
    });
    expect(snapshot.ledger).toBe(2);
    // 最终整范围回扫真实执行了 status（扫描 + 回扫）。
    expect(statusCalls.length).toBeGreaterThan(statusBefore);
    expect(getOperationRegistry().writeRestriction(wcRoot)).toBeUndefined();
    expect(fakePanel().latestRenderHtml()).toContain(CONFLICT_BATCH_TEXT_DEFAULTS.batchResultsHeading);
    expect(fakePanel().latestRenderHtml()).toContain('已解决 2');
  });

  it('中途失败停止：首项回读矛盾进 unknown，余项未执行，最终回扫后旧计划作废', async () => {
    writeWorkFile('a.txt');
    writeWorkFile('b.txt');
    writeWorkFile('c.txt');
    conflicts = [textConflict('a.txt'), textConflict('b.txt'), textConflict('c.txt')];
    setup();
    await openAndScan();
    await planBatch('theirs-full');
    persistConflictAfterResolve = true;
    await startBatch();
    expect(resolveCalls.length).toBe(1);
    const snapshot = conflictsSessionSnapshot();
    expect(snapshot.batch).toMatchObject({
      items: 3,
      resolved: 0,
      failed: 0,
      unknown: 1,
      notRun: 2,
      stoppedIndex: 0,
      planInvalidated: true,
      rescan: 'scanned',
    });
    expect(snapshot.batch?.stopReason).toBeDefined();
    // 最终回扫仍报告冲突：未决记录按真实扫描收口并释放写锁（不写台账）。
    expect(snapshot.ledger).toBe(0);
    expect(snapshot.writeLocked).toBe(false);
    // 旧计划作废：再次 start 被拒绝，不发第二次 resolve。
    const resolveBefore = resolveCalls.length;
    await sendIntent({ kind: 'startConflictBatch' });
    await delay(20);
    expect(resolveCalls.length).toBe(resolveBefore);
  });

  it('最终回扫失败：逐项结果保留且明确未核实，写锁保持到重新扫描收口', async () => {
    writeWorkFile('a.txt');
    writeWorkFile('b.txt');
    conflicts = [textConflict('a.txt'), textConflict('b.txt')];
    setup();
    await openAndScan();
    await planBatch('theirs-full');
    statusFailure = 'svn: E000013: Permission denied';
    await startBatch();
    let snapshot = conflictsSessionSnapshot();
    expect(snapshot.batch).toMatchObject({
      items: 2,
      unknown: 1,
      notRun: 1,
      stoppedIndex: 0,
      planInvalidated: true,
      rescan: 'failed',
    });
    expect(snapshot.batch?.stopReason).toBeDefined();
    // 结果未知：operation record 保持 unknown 相位，写锁保持。
    expect(snapshot.writeLocked).toBe(true);
    expect(snapshot.pendingOperationId).toBeDefined();
    // 重新扫描（回扫）按真实状态收口未决记录并释放写锁。
    statusFailure = undefined;
    await sendIntent({ kind: 'rescanConflicts', scope: 'task' });
    await waitIdle();
    snapshot = conflictsSessionSnapshot();
    expect(snapshot.writeLocked).toBe(false);
    expect(getOperationRegistry().writeRestriction(wcRoot)).toBeUndefined();
  });

  it('批量执行中关闭面板：任务继续并写会话缓存，重开恢复逐项结果', async () => {
    writeWorkFile('a.txt');
    writeWorkFile('b.txt');
    conflicts = [textConflict('a.txt'), textConflict('b.txt')];
    resolveDelayMs = 80;
    setup();
    await openAndScan();
    await planBatch('theirs-full');
    await sendIntent({ kind: 'startConflictBatch' });
    expect(hasActiveTask('conflicts')).toBe(true);
    expect(conflictsSessionSnapshot().taskKind).toBe('batch');
    fakePanel().dispose();
    expect(hasActiveTask('conflicts')).toBe(true);
    await waitIdle();
    const stored = readSnapshotStore();
    const storedBatch = (stored?.browsable as {
      batch?: { result?: { items?: unknown[]; planInvalidated?: boolean } };
    } | undefined)?.batch;
    expect(storedBatch?.result?.items).toHaveLength(2);
    expect(storedBatch?.result?.planInvalidated).toBe(false);
    // 重开：恢复结果页，不自动重扫（批量结束时的最终回扫已更新快照）。
    await openConflictPanel({ source: 'local', wcRoot, scopeRelPath: '.' });
    await delay(10);
    const snapshot = conflictsSessionSnapshot();
    expect(snapshot.batch).toMatchObject({ mode: 'results', resolved: 2, rescan: 'scanned' });
    expect(fakePanel().latestRenderHtml()).toContain(CONFLICT_BATCH_TEXT_DEFAULTS.batchResultsHeading);
  });

  it('批量执行中关闭后立即重开：绑定同一任务模型并继续逐项进度', async () => {
    writeWorkFile('a.txt');
    conflicts = [textConflict('a.txt')];
    resolveDelayMs = 80;
    setup();
    await openAndScan();
    await planBatch('theirs-full');
    await sendIntent({ kind: 'startConflictBatch' });
    expect(hasActiveTask('conflicts')).toBe(true);
    const taskModel = conflictsModelForTest();
    fakePanel().dispose();
    await openConflictPanel({ source: 'local', wcRoot, scopeRelPath: '.' });
    // 运行中任务按作用域绑定：模型切到任务实例，任务槽与相位保持。
    expect(conflictsModelForTest()).toBe(taskModel);
    expect(conflictsSessionSnapshot().taskKind).toBe('batch');
    await waitIdle();
    const snapshot = conflictsSessionSnapshot();
    expect(snapshot.batch).toMatchObject({ mode: 'results', resolved: 1, rescan: 'scanned' });
  });

  it('wcLocked：计划整体禁写并给出原因，start 被拒绝且不发写命令', async () => {
    writeWorkFile('a.txt');
    conflicts = [textConflict('a.txt')];
    wcLockedFlag = true;
    setup();
    await openAndScan();
    expect(conflictsModelForTest()?.wcLocked()).toBe(true);
    await planBatch('theirs-full');
    let snapshot = conflictsSessionSnapshot();
    expect(snapshot.batch).toMatchObject({ applicable: 1, writeBlocked: true, mode: 'plan' });
    expect(fakePanel().latestRenderHtml()).toContain(CONFLICT_BATCH_TEXT_DEFAULTS.batchBlockedWcLocked);
    const resolveBefore = resolveCalls.length;
    await sendIntent({ kind: 'startConflictBatch' });
    await delay(20);
    expect(resolveCalls.length).toBe(resolveBefore);
    expect(fakePanel().toasts().some((message) => message.includes('工作副本被锁定'))).toBe(true);
    expect(hasActiveTask('conflicts')).toBe(false);
  });

  it('批量与扫描共用 conflicts 单任务槽：执行中 plan 意图被放行表拒绝', async () => {
    writeWorkFile('a.txt');
    conflicts = [textConflict('a.txt')];
    resolveDelayMs = 100;
    setup();
    await openAndScan();
    await planBatch('theirs-full');
    const planId = conflictsSessionSnapshot().batch?.planId;
    await sendIntent({ kind: 'startConflictBatch' });
    expect(hasActiveTask('conflicts')).toBe(true);
    expect(conflictsSessionSnapshot().taskKind).toBe('batch');
    // busy 期间 planConflictBatch 属于写集：宿主放行表拒绝（不生成第二份计划）。
    await sendIntent({ kind: 'planConflictBatch', strategy: 'mine-full' });
    expect(fakePanel().toasts().some((message) => message.includes('已忽略重复请求'))).toBe(true);
    expect(conflictsSessionSnapshot().batch?.planId).toBe(planId);
    await waitIdle();
  });
});
