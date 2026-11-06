/**
 * P3 检出面板控制器（panels/checkout.ts）的 flow 测试：mock vscode（面板
 * 替身/globalState/确认框/命令执行）与 core svn 命令层，从面板意图驱动：
 * - 连接检查：迟到回包按发起代次丢弃、成功自动进核对页与目标状态展示；
 * - 放行表宿主/DOM 两侧一致：busy 运行页（running 取消可点、connecting
 *   禁、无 syncInput）；writeLocked 结果页（核验/放弃/打开动作放行、
 *   续检按钮 DOM 禁用与宿主守卫同谓词）；
 * - 取消竞态（确认期间任务终态不回改）；
 * - 五段恢复各段独立用例（任务态/缓存命中/缓存不一致丢弃/记录分诊
 *   interrupted/草稿/新表单）与跨入口绑定；
 * - 草稿恢复组（同父不同 URL 互不干扰、directMode 回填、nameMode manual
 *   联动不覆盖、错误字段不恢复）、abandonResidue 后关闭重开恢复原参数；
 * - 核验（匹配/深度不一致/等价 URL 变体）与「核验进行中」提示的重开送达；
 * - 续检执行中取消/失败/完成（含重核验失败 resumeBlocked 缓存、关闭重开
 *   不回退旧页）、URL 历史成功才记录、模式切换确认清缓存草稿、
 *   checkoutDefaultDepth 只影响新任务草稿初始深度。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { SvnError } from '../src/core/errors';
import {
  OperationRegistry,
  getOperationRegistry,
  resetRunningOperationsForTest,
  setOperationRegistryForTest,
  type OperationRecord,
  type OperationStore,
} from '../src/core/operations';
import { runOrThrow, type RunOptions, type RunResult } from '../src/core/svnCli';
import { runStatus } from '../src/core/status';
import { resetResultEpochs, getResultEpoch } from '../src/host/resultEpoch';
import { readSessionResult, resetSessionResults } from '../src/host/sessionResults';
import { getActiveTask, resetTaskRegistry } from '../src/host/taskRegistry';
import { resetPanelRegistry } from '../src/host/panel/host';
import { resetOutputState } from '../src/host/output';
import { setDraftStorage, type CheckoutFormDraft } from '../src/host/panel/drafts';
import { strings } from '../src/host/i18n';
import {
  openCheckoutPanel,
  resetCheckoutPanelController,
  setCheckoutPanelContext,
  canResumeCheckoutTarget,
} from '../src/host/panel/panels/checkout';

vi.mock('vscode', () => ({
  ViewColumn: { Active: 1, Beside: 2 },
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  Uri: {
    file: (path: string) => ({ scheme: 'file', path, fsPath: path, toString: () => `file://${path}` }),
    joinPath: (base: { path: string }, ...parts: string[]) => {
      const path = [base.path.replace(/\/$/, ''), ...parts].join('/');
      return { scheme: 'file', path, fsPath: path, toString: () => `file://${path}` };
    },
  },
  window: {
    createOutputChannel: () => ({
      lines: [] as string[],
      shown: 0,
      appendLine(line: string) {
        (this as { lines: string[] }).lines.push(line);
      },
      show() {
        (this as { shown: number }).shown += 1;
      },
      dispose() {},
    }),
    showInformationMessage: (message: string) => {
      vscodeMock.information.push(message);
      return Promise.resolve(undefined);
    },
    showWarningMessage: (message: string, _options?: unknown, ...items: string[]) => {
      vscodeMock.warning.push(message);
      if (vscodeMock.confirmImpl && items.length < 3) {
        return vscodeMock.confirmImpl(message);
      }
      return Promise.resolve(vscodeMock.confirmResult);
    },
    showErrorMessage: (message: string) => {
      vscodeMock.errorMessages.push(message);
      return Promise.resolve(undefined);
    },
    showOpenDialog: () => Promise.resolve(vscodeMock.openDialogResult),
    showInputBox: () => Promise.resolve(undefined),
    showQuickPick: () => Promise.resolve(undefined),
    createWebviewPanel: (viewType: string, title: string) => {
      const panel = makeFakePanel(viewType, title);
      vscodeMock.panels.push(panel);
      return panel;
    },
    withProgress: (_options: unknown, task: (p: unknown, t: unknown) => Promise<unknown>) =>
      task({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) }),
    get activeTextEditor() {
      return undefined;
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => (key in vscodeMock.config ? vscodeMock.config[key] : fallback),
    }),
    get workspaceFolders() {
      return vscodeMock.workspaceFolders;
    },
    updateWorkspaceFolders: () => vscodeMock.updateWorkspaceFoldersResult,
    onDidCloseTextDocument: () => ({ dispose() {} }),
  },
  commands: {
    executeCommand: async (command: string, ...args: unknown[]) => {
      vscodeMock.executedCommands.push([command, ...args]);
      return undefined;
    },
  },
  ProgressLocation: { Notification: 15 },
}));

vi.mock('../src/core/svnCli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/svnCli')>();
  return { ...actual, runOrThrow: vi.fn() };
});

vi.mock('../src/core/status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/status')>();
  return { ...actual, runStatus: vi.fn() };
});

interface FakePanel {
  viewType: string;
  title: string;
  html: string;
  posted: Array<Record<string, unknown>>;
  revealed: number;
  disposed: boolean;
  reveal(): void;
  dispose(): void;
  send(raw: unknown): Promise<void> | void;
  sendIntent(intent: Record<string, unknown>, requestId: string, sessionIdOverride?: string): void;
  lastSessionId(): string;
}

function makeFakePanel(viewType: string, title: string): FakePanel {
  let messageHandler: ((raw: unknown) => unknown) | undefined;
  let disposeHandler: (() => void) | undefined;
  let sessionId = '';
  let seq = 0;
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
      if (panel.disposed) return;
      panel.disposed = true;
      disposeHandler?.();
    },
    send(raw) {
      return messageHandler?.(raw) as void | Promise<void>;
    },
    sendIntent(intent, requestId, sessionIdOverride) {
      seq += 1;
      return panel.send({
        type: 'intent',
        protocolVersion: 1,
        sessionId: sessionIdOverride ?? sessionId,
        requestId: requestId || `req-${seq}`,
        intent,
      }) as void;
    },
    lastSessionId() {
      return sessionId;
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

const vscodeMock = vi.hoisted(() => ({
  panels: [] as FakePanel[],
  information: [] as string[],
  warning: [] as string[],
  errorMessages: [] as string[],
  confirmResult: undefined as string | undefined,
  confirmImpl: undefined as ((message: string) => Promise<string | undefined>) | undefined,
  openDialogResult: undefined as Array<{ fsPath: string }> | undefined,
  config: {} as Record<string, unknown>,
  executedCommands: [] as unknown[][],
  globalState: new Map<string, unknown>(),
  workspaceFolders: [] as Array<{ uri: { toString(): string } }>,
  updateWorkspaceFoldersResult: true,
}));

/* ------------------------------ 测试夹具 ------------------------------ */

const REPO_URL = 'file:///tmp/repo/trunk';
const IDENTITY = { repositoryUuid: 'uuid-1', repositoryRootUrl: 'file:///tmp/repo', relativeUrl: '^/trunk' };

const FORM: CheckoutFormDraft = {
  url: REPO_URL,
  urlInput: REPO_URL,
  nameMode: 'manual',
  parentDir: '/tmp/parent',
  dirName: 'trunk',
  directMode: false,
  directDir: '',
  revMode: 'number',
  rev: '5',
  depth: 'infinity',
  sourceDir: '',
  message: '',
};

let store: OperationStore & { records: Map<string, OperationRecord> };
let globalStateMap: Map<string, unknown>;
let labRoot: string;

function makeMemoryStore(): OperationStore & { records: Map<string, OperationRecord> } {
  const records = new Map<string, OperationRecord>();
  return {
    records,
    load: () => [...records.values()],
    async save(record) {
      records.set(record.operationId, record);
    },
    async remove(operationId) {
      records.delete(operationId);
    },
  };
}

/** runOrThrow mock：记录调用并分发到当前 handler。 */
const runCalls: Array<{ args: string[]; options: RunOptions }> = [];
function mockRun(handler: (args: string[], options: RunOptions) => Promise<RunResult>): void {
  runCalls.length = 0;
  vi.mocked(runOrThrow).mockImplementation(async (_svnPath: string, args: string[], options: RunOptions = {}) => {
    runCalls.push({ args, options });
    return handler(args, options);
  });
}

const okRun = (stdout = ''): RunResult => ({ stdout, stderr: '', exitCode: 0 });

const INFO_XML = (revision: number): string =>
  `<?xml version="1.0"?><info><entry kind="dir" revision="${revision}" path="." url="${REPO_URL}">` +
  `<commit revision="${revision}"/><repository><root>${IDENTITY.repositoryRootUrl}</root><uuid>${IDENTITY.repositoryUuid}</uuid></repository>` +
  `<relative-url>${IDENTITY.relativeUrl}</relative-url></entry></info>`;

/** verifyResumable 的只读命令链（info 文本 + 两个 --show-item）。 */
function mockVerifyCommands(options: { depth?: string; uuid?: string; relativeUrl?: string } = {}): void {
  const depth = options.depth ?? 'infinity';
  const uuid = options.uuid ?? IDENTITY.repositoryUuid;
  const relativeUrl = options.relativeUrl ?? IDENTITY.relativeUrl;
  mockRun(async (args) => {
    if (args[0] === 'info' && args[1] === '--') {
      return okRun(
        `URL: ${REPO_URL}/\nRepository UUID: ${uuid}\nRepository Root: ${IDENTITY.repositoryRootUrl}\nRevision: 3\nNode Kind: directory\n`,
      );
    }
    if (args[0] === 'info' && args[1] === '--show-item') {
      return okRun(args[2] === 'relative-url' ? relativeUrl : depth);
    }
    return okRun();
  });
}

/** 连接检查（info --xml URL）成功。 */
function mockCheckRemoteOk(revision = 5): void {
  mockRun(async (args) => {
    if (args[0] === 'info' && args[1] === '--xml') {
      return okRun(INFO_XML(revision));
    }
    return okRun();
  });
}

/** 挂起命令随 signal abort 拒绝（CANCELLED）：检出/续检运行页的统一 mock 形态。 */
function abortOnSignal(options: RunOptions, reject: (err: unknown) => void): void {
  options.signal?.addEventListener('abort', () => {
    reject(new SvnError({
      message: '操作已取消',
      command: [],
      stderr: '',
      code: 'CANCELLED',
    }));
  }, { once: true });
}

/** 连接检查成功 + 检出命令挂起（随 signal abort）：任务运行页用例的统一 mock。 */
function mockCheckoutHang(): void {
  mockRun(async (args, options) => {
    if (args[0] === 'info' && args[1] === '--xml') {
      return okRun(INFO_XML(5));
    }
    if (args[0] === 'checkout') {
      return new Promise<RunResult>((_, reject) => abortOnSignal(options, reject));
    }
    return okRun();
  });
}

/** 面板 toast 消息集合（宿主拒绝/业务提示都经 toast 通道）。 */
function toastMessages(panel: FakePanel): string[] {
  return panel.posted
    .filter((message) => message.type === 'toast')
    .map((message) => String(message.message ?? ''));
}

/** 等待任务相位镜像轮询（连接相位同步间隔 120ms）。 */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor(cond: () => boolean, ms = 1500): Promise<void> {
  for (let i = 0; i < Math.ceil(ms / 20); i += 1) {
    if (cond()) {
      return;
    }
    await sleep(20);
  }
  throw new Error('等待条件超时');
}
async function waitTaskRunning(): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    if (getActiveTask('checkout')?.phase === 'running') {
      await sleep(160);
      return;
    }
    await sleep(20);
  }
  throw new Error('任务未进入 running');
}

function lastPanel(): FakePanel {
  const panel = vscodeMock.panels.at(-1);
  if (!panel) {
    throw new Error('面板未创建');
  }
  return panel;
}

function rendersOf(panel: FakePanel): string[] {
  return panel.posted
    .filter((message) => message.type === 'render')
    .map((message) => String(message.html ?? ''));
}

function lastHtml(panel: FakePanel): string {
  return rendersOf(panel).at(-1) ?? '';
}

function findHtml(panel: FakePanel, needle: string): string | undefined {
  return rendersOf(panel).reverse().find((html) => html.includes(needle));
}

let intentSeq = 0;
function send(panel: FakePanel, intent: Record<string, unknown>): void {
  intentSeq += 1;
  panel.sendIntent(intent, `req-${intentSeq}`);
}

async function openPanel(entryKey: string, parentDir?: string): Promise<FakePanel> {
  await openCheckoutPanel({ entryKey, mode: 'checkout', parentDir: parentDir ?? entryKey });
  await sleep(0);
  return lastPanel();
}

/** 填 URL → 下一步（连接检查成功）→ 进入核对页。 */
async function fillToReview(panel: FakePanel, url = REPO_URL, parentDir?: string): Promise<void> {
  send(panel, { kind: 'syncInput', fieldId: 'url', value: url, inputRevision: 1 });
  await sleep(0);
  if (parentDir !== undefined) {
    send(panel, { kind: 'syncInput', fieldId: 'parentDir', value: parentDir, inputRevision: 2 });
    await sleep(0);
  }
  send(panel, { kind: 'checkoutNext' });
  await sleep(20);
}

/** 填表 → 核对页 → 开始检出（挂起命令，进入 running）。 */
async function startCheckoutRunning(panel: FakePanel, targetDir: string): Promise<void> {
  await fillToReview(panel);
  send(panel, { kind: 'startCheckout' });
  await waitTaskRunning();
  expect(runCalls.some(({ args }) => args[0] === 'checkout' && args.at(-1) === targetDir)).toBe(true);
}

function residueRecord(overrides: Partial<OperationRecord> = {}): OperationRecord {
  const target = join(labRoot, 'trunk');
  return {
    operationId: 'op-residue-1',
    wcRoot: target,
    lockKey: target,
    kind: 'checkout',
    targetRelPath: '.',
    nodeKind: 'dir',
    phase: 'residue-pending',
    knownRevisions: [],
    updatedAt: Date.now(),
    url: REPO_URL,
    targetPath: target,
    pinnedRevision: 5,
    depth: 'infinity',
    repositoryUuid: IDENTITY.repositoryUuid,
    repositoryRootUrl: IDENTITY.repositoryRootUrl,
    relativeUrl: IDENTITY.relativeUrl,
    ...overrides,
  };
}

async function presetRecord(record: OperationRecord): Promise<void> {
  store.records.set(record.operationId, record);
  await getOperationRegistry().loadPending();
}

/** 未终态 import 记录（默认 unknown；outcome='merged' 即 merged 形态，§2.2）。 */
function importRecord(overrides: Partial<OperationRecord> = {}): OperationRecord {
  const src = join(labRoot, 'src-import');
  return {
    operationId: 'op-import-1',
    wcRoot: src,
    lockKey: src,
    kind: 'import',
    targetRelPath: '.',
    nodeKind: 'dir',
    phase: 'unknown',
    knownRevisions: [],
    updatedAt: Date.now(),
    targetPath: src,
    importIntent: {
      targetUrl: REPO_URL,
      parentIdentity: {
        repositoryUuid: IDENTITY.repositoryUuid,
        repositoryRootUrl: IDENTITY.repositoryRootUrl,
        lastChangedRevision: 3,
      },
      message: '导入说明',
      nameMode: 'auto',
      messageHash: 'hash',
      startedAt: 1,
      summary: { fileCount: 1, totalBytes: 1 },
      snapshotDigest: 'digest',
      fileRefs: 'op-import-1',
    },
    ...overrides,
  };
}

/** 从源目录右键「导入」入口打开 P3（第③段分诊 → import unknown/merged 页）。 */
async function openImportPanelAt(src: string): Promise<FakePanel> {
  await openCheckoutPanel({ entryKey: src, mode: 'import', sourceDir: src });
  await sleep(0);
  return lastPanel();
}

beforeEach(async () => {
  vscodeMock.panels.length = 0;
  vscodeMock.information.length = 0;
  vscodeMock.warning.length = 0;
  vscodeMock.errorMessages.length = 0;
  vscodeMock.confirmResult = undefined;
  vscodeMock.confirmImpl = undefined;
  vscodeMock.openDialogResult = undefined;
  vscodeMock.config = {};
  vscodeMock.executedCommands.length = 0;
  vscodeMock.workspaceFolders = [];
  vscodeMock.globalState.clear();
  vscodeMock.panels.forEach((panel) => {
    panel.disposed = true;
  });
  resetCheckoutPanelController();
  resetPanelRegistry();
  resetTaskRegistry();
  resetSessionResults();
  resetResultEpochs();
  resetRunningOperationsForTest();
  resetOutputState();
  runCalls.length = 0;
  vi.mocked(runStatus).mockReset();
  vi.mocked(runStatus).mockResolvedValue({ targetPath: '', entries: [], externals: [] });
  store = makeMemoryStore();
  const registry = new OperationRegistry(store);
  await registry.loadPending();
  setOperationRegistryForTest(registry);
  globalStateMap = new Map<string, unknown>();
  const memento = {
    get: <T>(key: string, defaultValue?: T) => (globalStateMap.has(key) ? (globalStateMap.get(key) as T) : defaultValue as T),
    update: (key: string, value: unknown) => {
      globalStateMap.set(key, value);
      return Promise.resolve();
    },
    keys: () => [...globalStateMap.keys()],
  };
  setDraftStorage(memento);
  setCheckoutPanelContext({
    extensionUri: { scheme: 'file', path: '/ext' } as unknown as vscode.Uri,
    subscriptions: [],
    globalState: memento,
  });
  labRoot = realpathSync(mkdtempSync(join(tmpdir(), 'checkout-panel-')));
  mockCheckRemoteOk();
});

afterEach(() => {
  rmSync(labRoot, { recursive: true, force: true });
});

/* ------------------------------ 连接检查 ------------------------------ */

describe('P3 检出面板 flow', () => {
  it('连接检查成功自动进入核对页并展示目标状态；迟到回包按发起代次丢弃', async () => {
    let releaseFirst: (result: RunResult) => void = () => {};
    const firstCall = new Promise<RunResult>((resolve) => {
      releaseFirst = resolve;
    });
    mockRun(async (args) => {
      if (args[0] === 'info' && args[1] === '--xml') {
        // 两次检查：第一次挂起（迟到回包），第二次立即返回 r9。
        if (runCalls.filter(({ args: a }) => a[0] === 'info' && a[1] === '--xml').length <= 1) {
          return firstCall;
        }
        return okRun(INFO_XML(9));
      }
      return okRun();
    });
    const panel = await openPanel(labRoot);
    send(panel, { kind: 'syncInput', fieldId: 'url', value: REPO_URL, inputRevision: 1 });
    await sleep(0);
    send(panel, { kind: 'checkoutNext' });
    await sleep(10);
    send(panel, { kind: 'syncInput', fieldId: 'url', value: 'file:///tmp/repo/branch', inputRevision: 2 });
    await sleep(0);
    send(panel, { kind: 'checkoutNext' });
    await sleep(20);
    // 第二次检查通过：自动进核对页、固定 r9。
    let html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.stepReview);
    expect(html).toContain('r9');
    expect(html).toContain(strings.checkoutPanel.targetStateOk);
    // 第一次检查的迟到回包（r7）到达：被发起代次丢弃，固定 revision 不被回改。
    releaseFirst(okRun(INFO_XML(7).replaceAll(REPO_URL, 'file:///tmp/repo/trunk')));
    await sleep(10);
    html = lastHtml(panel);
    expect(html).toContain('r9');
    expect(html).not.toContain('r7');
  });

  it('urlInput 校验失败时下一步拒绝发起并留在表单（不拿旧 form.url 通过检查）', async () => {
    const panel = await openPanel(labRoot);
    send(panel, { kind: 'syncInput', fieldId: 'url', value: REPO_URL, inputRevision: 1 });
    await sleep(0);
    send(panel, { kind: 'checkoutNext' });
    await sleep(10);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.stepReview);
    send(panel, { kind: 'checkoutBack' });
    await sleep(0);
    // 改成非法输入（含用户信息）：urlInput 原样保留、form.url 保持旧值。
    send(panel, { kind: 'syncInput', fieldId: 'url', value: 'http://user:pass@example.com/svn', inputRevision: 3 });
    await sleep(0);
    send(panel, { kind: 'checkoutNext' });
    await sleep(10);
    const html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.stepForm);
    expect(html).toContain('field-error');
    expect(runCalls.filter(({ args }) => args[0] === 'info' && args[1] === '--xml')).toHaveLength(1);
  });

  /* --------------------------- 放行表两侧一致 --------------------------- */

  it('busy 运行页：running 取消可点、宿主拒绝迟到 syncInput', async () => {
    mockCheckoutHang();
    const panel = await openPanel(labRoot);
    await startCheckoutRunning(panel, join(labRoot, 'trunk'));
    const html = lastHtml(panel);
    // DOM：取消按钮可点（running）、无表单字段。
    expect(html).toContain('data-intent="cancelTask"');
    expect(html).not.toMatch(/data-intent="cancelTask"[^>]* disabled/);
    expect(html).not.toContain('data-field-id="url"');
    // 宿主：busy 行不放行 syncInput（迟到输入按拒绝处理）。
    send(panel, { kind: 'syncInput', fieldId: 'url', value: 'file:///x', inputRevision: 5 });
    await sleep(0);
    expect(toastMessages(panel).some((message) => message.includes(strings.panel.toastBusyRejected))).toBe(true);
  });

  it('writeLocked 结果页：核验/放弃放行，续检按钮 DOM 禁用与宿主守卫同谓词', async () => {
    // interrupted 页 + 他人 M2 unknown 记录锁定同目标路径 → writeLocked。
    const record = residueRecord();
    await presetRecord(record);
    const foreign = residueRecord({
      operationId: 'op-foreign',
      kind: 'commit',
      phase: 'unknown',
      updatedAt: Date.now() + 1,
    });
    await presetRecord(foreign);
    // 核验深度不一致 → resumeBlocked 结论页（residue 结果页——放弃动作的放行对象）。
    mockVerifyCommands({ depth: 'files' });
    const panel = await openPanel(labRoot);
    const html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.resultTitles.interrupted);
    // 宿主 writeLocked 行放行核验（他人 unknown 记录不冻结核验）。
    send(panel, { kind: 'verifyCheckout' });
    await sleep(30);
    const blockedHtml = findHtml(panel, strings.checkoutPanel.resultTitles.resumeBlocked);
    expect(blockedHtml).toBeDefined();
    // 他人记录占用：续检谓词不放行（DOM 侧 resumeBlocked 页本无续检按钮——
    // 谓词与宿主守卫同源，直接断言其求值）。
    expect(canResumeCheckoutTarget(record.targetPath!)).toBe(false);
    // 放弃动作放行（只改记录的收口动作，不被他人写锁连带冻结）：确认并收口。
    vscodeMock.confirmResult = strings.panel.switchDiscardButton;
    send(panel, { kind: 'abandonResidue' });
    await sleep(20);
    expect(vscodeMock.warning).toContain(strings.checkoutPanel.abandonConfirmTitle);
    expect(store.records.get('op-residue-1')).toBeUndefined();
    // 他人 M2 unknown 记录不受连带影响（相位与存在性不变）。
    expect(store.records.get('op-foreign')?.phase).toBe('unknown');
  });

  it('writeLocked success 页：打开动作与 newTask 放行（不向受限目标写入）', async () => {
    // 执行器写入 success 缓存页 + 他人记录锁定同路径。
    const target = join(labRoot, 'trunk');
    const { writeSessionResult } = await import('../src/host/sessionResults');
    writeSessionResult('checkout', { entryKey: labRoot, mode: 'checkout' }, {
      mode: 'checkout',
      kind: 'success',
      revision: 5,
      path: target,
    }, 'executor');
    const foreign = residueRecord({
      operationId: 'op-foreign',
      kind: 'commit',
      phase: 'unknown',
      updatedAt: Date.now() + 1,
    });
    await presetRecord(foreign);
    const panel = await openPanel(labRoot);
    const html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.resultTitles.success);
    send(panel, { kind: 'openCurrentWindow' });
    send(panel, { kind: 'openNewWindow' });
    send(panel, { kind: 'addToWorkspace' });
    send(panel, { kind: 'newTask' });
    await sleep(10);
    const openFolder = vscodeMock.executedCommands.filter(([command]) => command === 'vscode.openFolder');
    expect(openFolder).toHaveLength(2);
    expect((openFolder[0]?.[1] as { path: string }).path).toBe(target);
    expect(openFolder[0]?.[2]).toEqual({ openNewWindow: false });
    expect((openFolder[1]?.[1] as { path: string }).path).toBe(target);
    expect(openFolder[1]?.[2]).toEqual({ openNewWindow: true });
    // newTask 放行：回空白表单、清结果缓存。
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.stepForm);
    expect(readSessionResult('checkout', { entryKey: labRoot, mode: 'checkout' })).toBeUndefined();
  });

  /* ------------------------------ 取消竞态 ------------------------------ */

  it('取消确认期间任务自然结束：不回改终态，提示任务已结束', async () => {
    let releaseCheckout!: (result: RunResult) => void;
    mockRun(async (args, options) => {
      if (args[0] === 'info' && args[1] === '--xml') {
        return okRun(INFO_XML(5));
      }
      if (args[0] === 'checkout') {
        return new Promise<RunResult>((resolve, reject) => {
          releaseCheckout = (result) => resolve(result);
          abortOnSignal(options, reject);
        });
      }
      return okRun();
    });
    const panel = await openPanel(labRoot);
    await startCheckoutRunning(panel, join(labRoot, 'trunk'));
    // 确认框挂起期间任务成功结束。
    vscodeMock.confirmImpl = async () => {
      releaseCheckout(okRun('Checked out revision 5.\n'));
      await sleep(30);
      return strings.checkoutPanel.cancelConfirmButton;
    };
    send(panel, { kind: 'cancelTask' });
    await sleep(80);
    // 结果页为成功（终态不回改），toast 提示任务已结束。
    const html = findHtml(panel, strings.checkoutPanel.resultTitles.success);
    expect(html).toBeDefined();
    expect(toastMessages(panel)).toContain(strings.checkoutPanel.cancelRaceFinished);
  });

  it('取消请求确认后任务转 canceling 并落 canceled 结果页（文件保留语义由执行器承载）', async () => {
    mockCheckoutHang();
    const panel = await openPanel(labRoot);
    await startCheckoutRunning(panel, join(labRoot, 'trunk'));
    vscodeMock.confirmResult = strings.checkoutPanel.cancelConfirmButton;
    send(panel, { kind: 'cancelTask' });
    await sleep(60);
    const html = findHtml(panel, strings.checkoutPanel.resultTitles.canceled);
    expect(html).toBeDefined();
    // 取消结果页动作集：核验续检/改用新目录/Finder/日志。
    expect(html).toContain('data-intent="verifyCheckout"');
    expect(html).toContain('data-intent="abandonResidue"');
    expect(html).toContain('data-intent="revealResultDir"');
    // 记录保持 residue-pending（核验入口照常）。
    const checkoutRecord = [...store.records.values()].find((record) => record.kind === 'checkout');
    expect(checkoutRecord?.phase).toBe('residue-pending');
  });

  /* --------------------------- 核验：匹配/不匹配 --------------------------- */

  it('核验匹配产出 resumable 页并写入会话缓存（不改记录相位）', async () => {
    const record = residueRecord();
    await presetRecord(record);
    mockVerifyCommands();
    const panel = await openPanel(labRoot);
    send(panel, { kind: 'verifyCheckout' });
    await sleep(30);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.resultTitles.resumable);
    expect(store.records.get(record.operationId)?.phase).toBe('residue-pending');
    const cached = readSessionResult('checkout', { entryKey: labRoot, mode: 'checkout' });
    expect(cached).toBeDefined();
    expect((cached?.page as { kind: string }).kind).toBe('resumable');
  });

  it('核验深度不一致产出 resumeBlocked（blockReason=depthMismatch）', async () => {
    const record = residueRecord();
    await presetRecord(record);
    mockVerifyCommands({ depth: 'files' });
    const panel = await openPanel(labRoot);
    send(panel, { kind: 'verifyCheckout' });
    await sleep(30);
    const html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.resultTitles.resumeBlocked);
    expect(html).toContain('副本深度 files 与记录深度 infinity 不一致');
    // resumeBlocked 页动作集：改用新目录/重新核验/日志。
    expect(html).toContain('data-intent="verifyCheckout"');
    expect(html).toContain('data-intent="abandonResidue"');
  });

  it('核验等价 URL 变体（尾斜杠差异）按身份三元组判匹配', async () => {
    const record = residueRecord();
    await presetRecord(record);
    // info 文本 URL 带尾斜杠（与记录 url 字符串不同），三元组一致 → resumable。
    mockVerifyCommands();
    const panel = await openPanel(labRoot);
    send(panel, { kind: 'verifyCheckout' });
    await sleep(30);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.resultTitles.resumable);
  });

  it('核验进行中关闭重开：恢复页附「核验进行中」提示，结论写入后推送重跑自动转结论页', async () => {
    const record = residueRecord();
    await presetRecord(record);
    let releaseVerify!: (report: RunResult) => void;
    const verifyGate = new Promise<RunResult>((resolve) => {
      releaseVerify = resolve;
    });
    mockRun(async (args) => {
      if (args[0] === 'info' && args[1] === '--') {
        await verifyGate;
        return okRun(
          `URL: ${REPO_URL}\nRepository UUID: ${IDENTITY.repositoryUuid}\nRepository Root: ${IDENTITY.repositoryRootUrl}\nRevision: 3\nNode Kind: directory\n`,
        );
      }
      if (args[0] === 'info' && args[1] === '--show-item') {
        await verifyGate;
        return okRun(args[2] === 'relative-url' ? IDENTITY.relativeUrl : 'infinity');
      }
      return okRun();
    });
    const first = await openPanel(labRoot);
    send(first, { kind: 'verifyCheckout' });
    await sleep(10);
    first.dispose();
    await sleep(0);
    // 重开：③段记录分诊恢复 interrupted 页 + 进行中提示（dismissable:false 横幅）。
    const second = await openPanel(labRoot);
    const pendingHtml = lastHtml(second);
    expect(pendingHtml).toContain(strings.checkoutPanel.resultTitles.interrupted);
    expect(pendingHtml).toContain(strings.checkoutPanel.verifyPendingTitle);
    // 结论返回（resumable）：写缓存 + 推送重跑，重开会话自动转结论页。
    releaseVerify(okRun(''));
    await sleep(40);
    const conclusionHtml = findHtml(second, strings.checkoutPanel.resultTitles.resumable);
    expect(conclusionHtml).toBeDefined();
    expect(conclusionHtml).not.toContain(strings.checkoutPanel.verifyPendingTitle);
    // 面板关闭（旧会话）后结论仍写入缓存：再次重开按②段恢复 resumable 页。
    second.dispose();
    await sleep(0);
    const third = await openPanel(labRoot);
    expect(lastHtml(third)).toContain(strings.checkoutPanel.resultTitles.resumable);
  });

  /* --------------------------- 五段恢复各段 --------------------------- */

  it('五段①：运行中任务重开回到任务进度页（connecting 任务经移除通知重跑落缓存页）', async () => {
    mockCheckoutHang();
    const first = await openPanel(labRoot);
    await startCheckoutRunning(first, join(labRoot, 'trunk'));
    first.dispose();
    await sleep(0);
    const second = await openPanel(labRoot);
    const html = lastHtml(second);
    expect(html).toContain('data-intent="cancelTask"');
    expect(html).toContain(strings.checkoutPanel.progressCount.replace('{count}', '0'));
    // 任务终态（取消）：移除通知触发重跑，重开面板落缓存取消页（不停在进度页）。
    getActiveTask('checkout')?.abortController.abort();
    await sleep(200);
    const canceledHtml = findHtml(second, strings.checkoutPanel.resultTitles.canceled);
    expect(canceledHtml).toBeDefined();
  });

  it('五段②：缓存终态命中恢复结果页，缓存不一致（跨入口）丢弃落新表单', async () => {
    const { writeSessionResult } = await import('../src/host/sessionResults');
    writeSessionResult('checkout', { entryKey: labRoot, mode: 'checkout' }, {
      mode: 'checkout',
      kind: 'canceled',
      path: join(labRoot, 'trunk'),
      detail: '操作已取消',
    }, 'executor');
    // 同入口重开：恢复取消结果页。
    const same = await openPanel(labRoot);
    expect(lastHtml(same)).toContain(strings.checkoutPanel.resultTitles.canceled);
    same.dispose();
    await sleep(0);
    // 跨入口（/other 父目录）打开：缓存项作用域不一致即丢弃，落新表单。
    const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), 'checkout-other-')));
    try {
      const other = await openPanel(otherRoot);
      const html = lastHtml(other);
      expect(html).toContain(strings.checkoutPanel.stepForm);
      expect(html).not.toContain(strings.checkoutPanel.resultTitles.canceled);
      // 缓存项已被读侧丢弃。
      expect(readSessionResult('checkout', { entryKey: labRoot, mode: 'checkout' })).toBeUndefined();
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('五段③：重启后无缓存按记录分诊进入 interrupted 核验页（缓存终态优先于分诊）', async () => {
    const record = residueRecord();
    await presetRecord(record);
    const panel = await openPanel(labRoot);
    const html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.resultTitles.interrupted);
    // interrupted 页动作集：核验/改用新目录/日志（无 Finder）。
    expect(html).toContain('data-intent="verifyCheckout"');
    expect(html).toContain('data-intent="abandonResidue"');
    expect(html).not.toContain('data-intent="revealResultDir"');
    // 宿主未重启（缓存持有同记录终态）时缓存优先：预置 canceled 缓存后重开不再回 interrupted。
    const { writeSessionResult } = await import('../src/host/sessionResults');
    writeSessionResult('checkout', { entryKey: labRoot, mode: 'checkout' }, {
      mode: 'checkout',
      kind: 'failed',
      path: record.targetPath!,
      detail: 'x',
    }, 'executor');
    panel.dispose();
    await sleep(0);
    const reopened = await openPanel(labRoot);
    expect(lastHtml(reopened)).toContain(strings.checkoutPanel.resultTitles.failed);
  });

  it('五段④：草稿恢复回填表单（重算错误字段）；五段⑤：全新表单', async () => {
    const { saveDraft } = await import('../src/host/panel/drafts');
    saveDraft(labRoot, 'checkout', {
      ...FORM,
      parentDir: labRoot,
      urlInput: 'not a url',
      url: '',
    });
    const panel = await openPanel(labRoot);
    const html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.stepForm);
    // urlInput 原样回填、错误按恢复值重算。
    expect(html).toContain('value="not a url"');
    expect(html).toContain('field-error');
    panel.dispose();
    await sleep(0);
    // 清除草稿后重开：新表单（无回填）。
    const { clearDraft } = await import('../src/host/panel/drafts');
    clearDraft(labRoot, 'checkout');
    const fresh = await openPanel(labRoot);
    const freshHtml = lastHtml(fresh);
    expect(freshHtml).toContain(strings.checkoutPanel.stepForm);
    expect(freshHtml).not.toContain('not a url');
  });

  /* --------------------------- 草稿恢复组 --------------------------- */

  it('同父目录不同 URL 的草稿互不干扰（换入口不串键）', async () => {
    const dirA = realpathSync(mkdtempSync(join(tmpdir(), 'entry-a-')));
    const dirB = realpathSync(mkdtempSync(join(tmpdir(), 'entry-b-')));
    try {
      const { readDraft } = await import('../src/host/panel/drafts');
      const a = await openPanel(dirA);
      send(a, { kind: 'syncInput', fieldId: 'url', value: 'file:///tmp/repo/trunk', inputRevision: 1 });
      await sleep(0);
      a.dispose();
      await sleep(0);
      const b = await openPanel(dirB);
      send(b, { kind: 'syncInput', fieldId: 'url', value: 'file:///tmp/repo/branch', inputRevision: 1 });
      await sleep(0);
      b.dispose();
      await sleep(0);
      expect(readDraft(dirA, 'checkout')?.url).toBe('file:///tmp/repo/trunk');
      expect(readDraft(dirB, 'checkout')?.url).toBe('file:///tmp/repo/branch');
      // 重开 A：恢复 A 的 URL。
      const reopenedA = await openPanel(dirA);
      expect(lastHtml(reopenedA)).toContain('file:///tmp/repo/trunk');
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('directMode 草稿关闭重开恢复（directDir 回填、directMode 勾选）', async () => {
    const target = join(labRoot, 'direct-target');
    mkdirSync(target, { recursive: true });
    const panel = await openPanel(labRoot);
    send(panel, { kind: 'syncInput', fieldId: 'url', value: REPO_URL, inputRevision: 1 });
    await sleep(0);
    send(panel, { kind: 'syncInput', fieldId: 'directMode', value: 'true', inputRevision: 2 });
    await sleep(0);
    vscodeMock.openDialogResult = [{ fsPath: target }];
    send(panel, { kind: 'pickDirectDir' });
    await sleep(10);
    expect(lastHtml(panel)).toContain(`value="${target}"`);
    panel.dispose();
    await sleep(0);
    const reopened = await openPanel(labRoot);
    const html = lastHtml(reopened);
    expect(html).toMatch(/data-field-id="directMode"[^>]* checked/);
    expect(html).toContain(`value="${target}"`);
  });

  it('nameMode manual 草稿恢复后 URL 联动不覆盖手动目录名', async () => {
    const panel = await openPanel(labRoot);
    send(panel, { kind: 'syncInput', fieldId: 'url', value: REPO_URL, inputRevision: 1 });
    await sleep(0);
    send(panel, { kind: 'syncInput', fieldId: 'dirName', value: 'my-name', inputRevision: 2 });
    await sleep(0);
    panel.dispose();
    await sleep(0);
    const reopened = await openPanel(labRoot);
    let html = lastHtml(reopened);
    expect(html).toContain('value="my-name"');
    // 重开后改 URL：手动命名不被自动联动覆盖。
    send(reopened, { kind: 'syncInput', fieldId: 'url', value: 'file:///tmp/repo/branch', inputRevision: 3 });
    await sleep(0);
    html = lastHtml(reopened);
    expect(html).toContain('value="my-name"');
    expect(html).not.toContain('value="branch"');
  });

  /* --------------------------- abandon 与回表单 --------------------------- */

  it('abandonResidue 后关闭重开按任务入口键恢复原参数（草稿写回）', async () => {
    // 先经真实任务产生 canceled 结果页（缓存携带 formSnapshot）。
    mockCheckoutHang();
    const panel = await openPanel(labRoot);
    await startCheckoutRunning(panel, join(labRoot, 'trunk'));
    vscodeMock.confirmResult = strings.checkoutPanel.cancelConfirmButton;
    send(panel, { kind: 'cancelTask' });
    await sleep(60);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.resultTitles.canceled);
    // 改用新目录：记录收口 + 草稿写回（原参数）+ 回表单。
    vscodeMock.confirmResult = strings.panel.switchDiscardButton;
    send(panel, { kind: 'abandonResidue' });
    await sleep(20);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.stepForm);
    expect(lastHtml(panel)).toContain(REPO_URL);
    expect(store.records.get('op-residue-1')).toBeUndefined();
    // 预命令出口/abandon 写回的草稿：关闭重开按同入口键恢复原参数。
    panel.dispose();
    await sleep(0);
    const reopened = await openPanel(labRoot);
    const html = lastHtml(reopened);
    expect(html).toContain(REPO_URL);
    expect(html).toContain('value="trunk"');
  });

  it('interrupted 派生页无快照：abandonResidue 回空白表单（登记差异）', async () => {
    const record = residueRecord();
    await presetRecord(record);
    const panel = await openPanel(labRoot);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.resultTitles.interrupted);
    vscodeMock.confirmResult = strings.panel.switchDiscardButton;
    send(panel, { kind: 'abandonResidue' });
    await sleep(20);
    const html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.stepForm);
    expect(html).not.toContain(REPO_URL);
    expect(store.records.get(record.operationId)).toBeUndefined();
  });

  /* --------------------------- 续检执行链 --------------------------- */

  it('续检成功：面板转 running、完成落 success 并收口记录与缓存', async () => {
    const record = residueRecord();
    await presetRecord(record);
    // 先核验得 resumable，再续检。
    mockVerifyCommands();
    const panel = await openPanel(labRoot);
    send(panel, { kind: 'verifyCheckout' });
    await sleep(30);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.resultTitles.resumable);
    // 续检：重核验一致 → cleanup + update 成功（Updated to revision 5.）。
    mockRun(async (args, options) => {
      if (args[0] === 'info' && args[1] === '--') {
        return okRun(
          `URL: ${REPO_URL}\nRepository UUID: ${IDENTITY.repositoryUuid}\nRepository Root: ${IDENTITY.repositoryRootUrl}\nRevision: 3\nNode Kind: directory\n`,
        );
      }
      if (args[0] === 'info' && args[1] === '--show-item') {
        return okRun(args[2] === 'relative-url' ? IDENTITY.relativeUrl : 'infinity');
      }
      if (args[0] === 'cleanup') {
        return okRun();
      }
      if (args[0] === 'update') {
        return okRun('Updated to revision 5.\n');
      }
      return Promise.reject(new Error(`unexpected: ${args.join(' ')}`));
    });
    send(panel, { kind: 'resumeCheckout' });
    await sleep(60);
    const html = findHtml(panel, strings.checkoutPanel.resultTitles.success);
    expect(html).toBeDefined();
    expect(html).toContain('r5');
    expect(store.records.get(record.operationId)).toBeUndefined();
    const cached = readSessionResult('checkout', { entryKey: labRoot, mode: 'checkout' });
    expect((cached?.page as { kind: string }).kind).toBe('success');
  });

  it('续检重核验失败：resumeBlocked 转移写缓存，关闭重开恢复 resumeBlocked 不回退旧页', async () => {
    const record = residueRecord();
    await presetRecord(record);
    mockVerifyCommands();
    const panel = await openPanel(labRoot);
    send(panel, { kind: 'verifyCheckout' });
    await sleep(30);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.resultTitles.resumable);
    // 续检时的执行前重核验：深度不一致 → 不发写命令、记录回 residue-pending。
    mockVerifyCommands({ depth: 'files' });
    send(panel, { kind: 'resumeCheckout' });
    await sleep(60);
    const html = findHtml(panel, strings.checkoutPanel.resultTitles.resumeBlocked);
    expect(html).toBeDefined();
    expect(store.records.get(record.operationId)?.phase).toBe('residue-pending');
    // 无 cleanup/update 写命令发出。
    expect(runCalls.some(({ args }) => args[0] === 'cleanup' || args[0] === 'update')).toBe(false);
    // 关闭重开：恢复 resumeBlocked 页（不回退旧 resumable 页）。
    panel.dispose();
    await sleep(0);
    const reopened = await openPanel(labRoot);
    expect(lastHtml(reopened)).toContain(strings.checkoutPanel.resultTitles.resumeBlocked);
  });

  it('续检执行中取消：canceled 结果页 + 记录回 residue-pending', async () => {
    const record = residueRecord();
    await presetRecord(record);
    mockVerifyCommands();
    const panel = await openPanel(labRoot);
    send(panel, { kind: 'verifyCheckout' });
    await sleep(30);
    mockRun((args, options) => {
      if (args[0] === 'info') {
        return Promise.resolve(okRun(
          args[1] === '--show-item'
            ? (args[2] === 'relative-url' ? IDENTITY.relativeUrl : 'infinity')
            : `URL: ${REPO_URL}\nRepository UUID: ${IDENTITY.repositoryUuid}\nRepository Root: ${IDENTITY.repositoryRootUrl}\nRevision: 3\nNode Kind: directory\n`,
        ));
      }
      if (args[0] === 'cleanup') {
        return Promise.resolve(okRun());
      }
      if (args[0] === 'update') {
        return new Promise<RunResult>((_, reject) => abortOnSignal(options, reject));
      }
      return Promise.resolve(okRun());
    });
    send(panel, { kind: 'resumeCheckout' });
    await waitTaskRunning();
    vscodeMock.confirmResult = strings.checkoutPanel.cancelConfirmButton;
    send(panel, { kind: 'cancelTask' });
    await sleep(80);
    const html = findHtml(panel, strings.checkoutPanel.resultTitles.canceled);
    expect(html).toBeDefined();
    expect(store.records.get(record.operationId)?.phase).toBe('residue-pending');
  });

  it('续检占用拒绝按 kind 分列文案（M2 unknown → 到提交面板核实）', async () => {
    const record = residueRecord();
    await presetRecord(record);
    // 预置他人 M2 unknown 记录锁定同键——先核验得 resumable（核验不被连带冻结）。
    mockVerifyCommands();
    const foreign = residueRecord({
      operationId: 'op-foreign-commit',
      kind: 'commit',
      phase: 'unknown',
      updatedAt: Date.now() + 1,
    });
    await presetRecord(foreign);
    const panel = await openPanel(labRoot);
    send(panel, { kind: 'verifyCheckout' });
    await sleep(30);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.resultTitles.resumable);
    // 宿主守卫已按 canResume 谓词拦截（DOM 禁用 + gate 拒绝）；
    // 直接调用执行器路径验证分列文案（beginResume busy 分支）。
    const { resumeCheckoutTask } = await import('../src/host/panel/checkoutTask');
    const started = await resumeCheckoutTask({
      operationId: record.operationId,
      lockKey: record.targetPath!,
      targetDir: record.targetPath!,
      url: record.url!,
      pinnedRevision: 5,
      depth: 'infinity',
      identity: IDENTITY,
      entryKey: labRoot,
      formSnapshot: undefined,
      initiatorSessionId: 'direct-call',
    });
    expect(started.ok).toBe(false);
    if (!started.ok && started.reason === 'busy') {
      expect(started.heldBy.kind).toBe('commit');
      const { resumeBusyNotice } = await import('../src/host/panel/panels/checkout');
      expect(resumeBusyNotice(started.heldBy)).toBe(strings.checkoutPanel.resumeBusyCommitFrozen);
    }
  });

  /* --------------------------- 跨入口绑定 --------------------------- */

  it('跨入口绑定：A 入口任务运行中从 B 入口重开，绑定任务 scope、页头按目标路径，任务完成按 scope 恢复', async () => {
    mockCheckoutHang();
    const entryA = labRoot;
    const first = await openPanel(entryA);
    const target = join(entryA, 'trunk');
    await startCheckoutRunning(first, target);
    first.dispose();
    await sleep(0);
    // B 入口 fresh open：①段绑定 A 任务（页头按任务目标路径呈现）。
    const entryB = realpathSync(mkdtempSync(join(tmpdir(), 'entry-bind-')));
    try {
      const second = await openPanel(entryB);
      const html = lastHtml(second);
      expect(html).toContain('data-intent="cancelTask"');
      expect(html).toContain(strings.checkoutPanel.targetBound.replace('{path}', target));
      // 任务取消终态：执行器写缓存（scope=A）→ 移除通知重跑（基准=A scope）→ 落 canceled 页。
      getActiveTask('checkout')?.abortController.abort();
      await sleep(250);
      const canceledHtml = findHtml(second, strings.checkoutPanel.resultTitles.canceled);
      expect(canceledHtml).toBeDefined();
      expect(readSessionResult('checkout', { entryKey: entryA, mode: 'checkout' })).toBeDefined();
    } finally {
      rmSync(entryB, { recursive: true, force: true });
    }
  });

  /* ------------- 旧核验结论 vs 新任务已写缓存（§2.1 两层守卫组合形态） ------------- */

  /** 挂起核验（A 侧 info 命令延迟）+ B 侧检出可完成的统一 mock。 */
  function mockVerifyGatedWithCheckoutOk(gate: Promise<void>): void {
    mockRun(async (args) => {
      if (args[0] === 'info' && args[1] === '--') {
        await gate;
        return okRun(
          `URL: ${REPO_URL}\nRepository UUID: ${IDENTITY.repositoryUuid}\nRepository Root: ${IDENTITY.repositoryRootUrl}\nRevision: 3\nNode Kind: directory\n`,
        );
      }
      if (args[0] === 'info' && args[1] === '--show-item') {
        await gate;
        return okRun(args[2] === 'relative-url' ? IDENTITY.relativeUrl : 'infinity');
      }
      if (args[0] === 'info' && args[1] === '--xml') {
        return okRun(INFO_XML(5));
      }
      if (args[0] === 'checkout') {
        return okRun('Checked out revision 5.\n');
      }
      return okRun();
    });
  }

  it('旧核验结论 vs 新任务已写缓存（B 入口先写）：跨 scope 迟到结论不覆盖 B 成功页', async () => {
    const t = strings.checkoutPanel;
    const record = residueRecord();
    await presetRecord(record);
    let releaseVerify!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseVerify = resolve;
    });
    mockVerifyGatedWithCheckoutOk(gate);
    const first = await openPanel(labRoot);
    send(first, { kind: 'verifyCheckout' });
    await sleep(10);
    first.dispose();
    await sleep(0);
    const entryB = realpathSync(mkdtempSync(join(tmpdir(), 'entry-bwrite-')));
    try {
      // B 入口 fresh open（A 无缓存项）→ 发起并完成小检出（任务创建即递增
      // 代次、执行器终态以 scope B 写入成功页）。
      const second = await openPanel(entryB);
      await fillToReview(second, REPO_URL);
      send(second, { kind: 'startCheckout' });
      await waitFor(() => rendersOf(second).some((html) => html.includes(t.resultTitles.success)));
      const cached = readSessionResult('checkout', { entryKey: entryB, mode: 'checkout' });
      expect((cached?.page as { kind: string }).kind).toBe('success');
      // 旧核验结论返回：单槽缓存仍为 B 的成功页（任务启动递增 + 跨 scope
      // 写侧校验双层——即便递增遗漏，scope A ≠ B 的写入也被写侧拦下）。
      releaseVerify();
      await sleep(60);
      const after = readSessionResult('checkout', { entryKey: entryB, mode: 'checkout' });
      expect((after?.page as { kind: string }).kind).toBe('success');
      // 关闭并从 B 重开：恢复 B 成功页、不落空白新表单、不恢复 A 的结论页。
      second.dispose();
      await sleep(0);
      const third = await openPanel(entryB);
      const html = lastHtml(third);
      expect(html).toContain(t.resultTitles.success);
      expect(html).not.toContain(t.resultTitles.resumable);
    } finally {
      rmSync(entryB, { recursive: true, force: true });
    }
  });

  it('旧核验结论 vs 新任务已写缓存（同 scope 对照）：丢弃由任务启动递增承担（写侧放行）', async () => {
    const t = strings.checkoutPanel;
    const record = residueRecord();
    await presetRecord(record);
    let releaseVerify!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseVerify = resolve;
    });
    mockVerifyGatedWithCheckoutOk(gate);
    const first = await openPanel(labRoot);
    send(first, { kind: 'verifyCheckout' });
    await sleep(10);
    first.dispose();
    await sleep(0);
    // 同入口重开：③段分诊 interrupted 页（核验仍挂起、缓存无终态）。
    const second = await openPanel(labRoot);
    expect(lastHtml(second)).toContain(t.resultTitles.interrupted);
    // 经「改用新目录」回表单后同 scope 再次发起任务并完成（scope 一致，
    // 写侧校验放行——旧结论的丢弃只能由任务创建时的代次递增承担）。
    vscodeMock.confirmResult = strings.panel.switchDiscardButton;
    send(second, { kind: 'abandonResidue' });
    await sleep(20);
    expect(lastHtml(second)).toContain(t.stepForm);
    await fillToReview(second, REPO_URL);
    send(second, { kind: 'startCheckout' });
    await waitFor(() => rendersOf(second).some((html) => html.includes(t.resultTitles.success)));
    const cached = readSessionResult('checkout', { entryKey: labRoot, mode: 'checkout' });
    expect((cached?.page as { kind: string }).kind).toBe('success');
    // 旧核验结论返回：scope 一致、写侧会放行——若代次守卫缺失会覆盖新成功页。
    releaseVerify();
    await sleep(60);
    const after = readSessionResult('checkout', { entryKey: labRoot, mode: 'checkout' });
    expect((after?.page as { kind: string }).kind).toBe('success');
    second.dispose();
    await sleep(0);
    const third = await openPanel(labRoot);
    const html = lastHtml(third);
    expect(html).toContain(t.resultTitles.success);
    expect(html).not.toContain(t.resultTitles.resumable);
  });

  it('A-先到顺序对照：旧结论先占空槽，执行器终态写入不被写侧校验丢弃（模拟递增点遗漏）', async () => {
    const record = residueRecord();
    await presetRecord(record);
    let releaseVerify!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseVerify = resolve;
    });
    mockVerifyGatedWithCheckoutOk(gate);
    const first = await openPanel(labRoot);
    send(first, { kind: 'verifyCheckout' });
    await sleep(10);
    first.dispose();
    await sleep(0);
    const entryB = realpathSync(mkdtempSync(join(tmpdir(), 'entry-afirst-')));
    try {
      // B 入口打开过但面板已关（任务后台继续的形态——终态写入不依赖面板
      // 存活）；任务未发起，全程不递增代次（模拟任务启动递增点遗漏形态）。
      const second = await openPanel(entryB);
      second.dispose();
      await sleep(0);
      const epochBefore = getResultEpoch('checkout');
      // A 结论先返回（B 尚未写缓存）：代次一致 + 槽空 → 写入 scope A 结论页。
      releaseVerify();
      await sleep(40);
      const early = readSessionResult('checkout', { entryKey: labRoot, mode: 'checkout' });
      expect((early?.page as { kind: string }).kind).toBe('resumable');
      expect(getResultEpoch('checkout')).toBe(epochBefore);
      // B 的执行器终态随后写入：断言不被写侧校验丢弃、覆盖旧结论页（终槽
      // 为 B 的结果页——「执行器写入同受槽空/同 scope 约束」的实现会让 A
      // 先占空槽、B 的真实新结果被跨 scope 丢弃，本对照由此捕获）。
      const { writeSessionResult } = await import('../src/host/sessionResults');
      writeSessionResult('checkout', { entryKey: entryB, mode: 'checkout' }, {
        mode: 'checkout',
        kind: 'success',
        path: join(entryB, 'trunk'),
        revision: 5,
      }, 'executor');
      const final = readSessionResult('checkout', { entryKey: entryB, mode: 'checkout' });
      expect((final?.page as { kind: string }).kind).toBe('success');
    } finally {
      rmSync(entryB, { recursive: true, force: true });
    }
  });

  it('同 scope 新任务代次对照（送达）：新任务成功页不附「核验进行中」提示；旧结论返回后登记清除', async () => {
    const t = strings.checkoutPanel;
    const { matchReadonlyVerify } = await import('../src/host/sessionResults');
    // 先经真实任务产生 canceled 结果页（缓存终态 → 重开②段恢复 + 提示）。
    mockCheckoutHang();
    const first = await openPanel(labRoot);
    await startCheckoutRunning(first, join(labRoot, 'trunk'));
    vscodeMock.confirmResult = t.cancelConfirmButton;
    send(first, { kind: 'cancelTask' });
    await sleep(80);
    expect(lastHtml(first)).toContain(t.resultTitles.canceled);
    // 从 canceled 页发起核验（挂起）→ dispose → 同入口立即重开。
    let releaseVerify!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseVerify = resolve;
    });
    mockVerifyGatedWithCheckoutOk(gate);
    send(first, { kind: 'verifyCheckout' });
    await sleep(10);
    first.dispose();
    await sleep(0);
    const second = await openPanel(labRoot);
    const pendingHtml = lastHtml(second);
    expect(pendingHtml).toContain(t.resultTitles.canceled);
    expect(pendingHtml).toContain(t.verifyPendingTitle);
    // 同 scope（入口 A）发起并完成一个小检出：newTask（递增）→ 表单 →
    // startCheckout（任务创建再递增）→ 执行器终态写 success。
    send(second, { kind: 'newTask' });
    await sleep(0);
    await fillToReview(second, REPO_URL);
    send(second, { kind: 'startCheckout' });
    await waitFor(() => rendersOf(second).some((html) => html.includes(t.resultTitles.success)));
    second.dispose();
    await sleep(0);
    // 关闭再重开：②段恢复新任务成功页且不附「核验进行中」提示（登记仍
    // 存在且 scope 一致，但登记代次已过期——不带代次比对会把旧提示挂到新页）。
    const third = await openPanel(labRoot);
    const html = lastHtml(third);
    expect(html).toContain(t.resultTitles.success);
    expect(html).not.toContain(t.verifyPendingTitle);
    // 旧核验结论随后返回：按代次守卫丢弃、登记清除（重开会话不再显示提示）。
    releaseVerify();
    await sleep(60);
    expect(
      matchReadonlyVerify('checkout', { entryKey: labRoot, mode: 'checkout' }, getResultEpoch('checkout')),
    ).toBe(false);
  });

  /* ------------- 跨会话递增使迟到结论失效（§2.1 计数器跨面板会话持续） ------------- */

  it('跨会话递增（abandonResidue）：新会话确认后旧核验结论不重建单槽缓存', async () => {
    const t = strings.checkoutPanel;
    // 真实任务 canceled 页（缓存携带 formSnapshot）。
    mockCheckoutHang();
    const first = await openPanel(labRoot);
    await startCheckoutRunning(first, join(labRoot, 'trunk'));
    vscodeMock.confirmResult = t.cancelConfirmButton;
    send(first, { kind: 'cancelTask' });
    await sleep(80);
    expect(lastHtml(first)).toContain(t.resultTitles.canceled);
    // canceled 页发起核验（挂起）→ dispose → 同入口重开（②段恢复 + 提示）。
    let releaseVerify!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseVerify = resolve;
    });
    mockVerifyGatedWithCheckoutOk(gate);
    send(first, { kind: 'verifyCheckout' });
    await sleep(10);
    first.dispose();
    await sleep(0);
    const second = await openPanel(labRoot);
    const pendingHtml = lastHtml(second);
    expect(pendingHtml).toContain(t.resultTitles.canceled);
    expect(pendingHtml).toContain(t.verifyPendingTitle);
    // 新会话点「改用新目录」确认：递增（新会话的动作作用于同一计数器）+
    // 清缓存 + 记录收口 + 草稿写回。
    vscodeMock.confirmResult = strings.panel.switchDiscardButton;
    send(second, { kind: 'abandonResidue' });
    await sleep(20);
    expect(lastHtml(second)).toContain(t.stepForm);
    expect([...store.records.values()].some((item) => item.kind === 'checkout')).toBe(false);
    // 旧控制器的迟到核验结论返回：不写结果页与缓存（新会话已清缓存并终结
    // 记录，旧结论不得重建单槽——「重开后不动」的迟到结论本可写入的对照
    // 见上一条用例，新会话的递增动作才使其失效）。
    releaseVerify();
    await sleep(60);
    expect(readSessionResult('checkout', { entryKey: labRoot, mode: 'checkout' })).toBeUndefined();
    // 重开回表单/草稿恢复，不恢复 resumable 结论页。
    second.dispose();
    await sleep(0);
    const third = await openPanel(labRoot);
    const html = lastHtml(third);
    expect(html).toContain(t.stepForm);
    expect(html).toContain(REPO_URL);
    expect(html).not.toContain(t.resultTitles.resumable);
  });

  /* ------------- 续检任务的快照继承（§2.1 续检来源规则的组合形态） ------------- */

  it('续检任务的快照继承：缓存恢复 resumable 页发起续检 → 任务快照非空 → 失败页 abandon 后重开恢复原参数', async () => {
    const t = strings.checkoutPanel;
    // 真实任务 canceled 页（终态页携带 formSnapshot，指定版本形态）→ 核验
    // 转 resumable（透传）。
    mockCheckoutHang();
    const first = await openPanel(labRoot);
    // 指定版本形态：先填 revMode/rev 再发起连接检查（签名含版本——顺序颠倒会使检查失效）。
    send(first, { kind: 'syncInput', fieldId: 'url', value: REPO_URL, inputRevision: 1 });
    await sleep(0);
    send(first, { kind: 'syncInput', fieldId: 'revMode', value: 'number', inputRevision: 2 });
    await sleep(0);
    send(first, { kind: 'syncInput', fieldId: 'rev', value: '5', inputRevision: 3 });
    await sleep(0);
    send(first, { kind: 'checkoutNext' });
    await sleep(20);
    send(first, { kind: 'startCheckout' });
    await waitTaskRunning();
    vscodeMock.confirmResult = t.cancelConfirmButton;
    send(first, { kind: 'cancelTask' });
    await sleep(80);
    mockVerifyCommands();
    send(first, { kind: 'verifyCheckout' });
    await sleep(30);
    expect(lastHtml(first)).toContain(t.resultTitles.resumable);
    first.dispose();
    await sleep(0);
    // 重开：缓存恢复 resumable 页（会话内 form 已空——快照继承来源唯一）。
    const second = await openPanel(labRoot);
    expect(lastHtml(second)).toContain(t.resultTitles.resumable);
    // 续检：重核验一致 + cleanup ok + update 挂起（抓任务对象快照后注入失败）。
    let failUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => {
      failUpdate = resolve;
    });
    mockRun(async (args) => {
      if (args[0] === 'info') {
        return okRun(
          args[1] === '--show-item'
            ? (args[2] === 'relative-url' ? IDENTITY.relativeUrl : 'infinity')
            : `URL: ${REPO_URL}\nRepository UUID: ${IDENTITY.repositoryUuid}\nRepository Root: ${IDENTITY.repositoryRootUrl}\nRevision: 3\nNode Kind: directory\n`,
        );
      }
      if (args[0] === 'cleanup') {
        return okRun();
      }
      if (args[0] === 'update') {
        await updateGate;
        throw new SvnError({
          message: 'E175002: connection refused',
          command: [],
          stderr: 'svn: E175002: connection refused',
          code: 'E175002',
        });
      }
      return okRun();
    });
    send(second, { kind: 'resumeCheckout' });
    await waitTaskRunning();
    // 任务对象快照继承自 resumable 页（非空——「仅捕获任务发起时表单状态」
    // 的字面实现在此得空快照，续检终态页的 abandon 丢原参数）。
    const snapshot = getActiveTask('checkout')?.formSnapshot as CheckoutFormDraft | undefined;
    expect(snapshot?.url).toBe(REPO_URL);
    expect(snapshot?.revMode).toBe('number');
    expect(snapshot?.rev).toBe('5');
    // 注入 update 失败 → failed 页（快照随终态页写入缓存）。
    failUpdate();
    await waitFor(() => rendersOf(second).some((html) => html.includes(t.resultTitles.failed)));
    // abandon：草稿写回（数据源 = 结果页 formSnapshot）→ 关闭重开恢复原参数。
    vscodeMock.confirmResult = strings.panel.switchDiscardButton;
    send(second, { kind: 'abandonResidue' });
    await sleep(20);
    expect(lastHtml(second)).toContain(t.stepForm);
    second.dispose();
    await sleep(0);
    const third = await openPanel(labRoot);
    const html = lastHtml(third);
    expect(html).toContain(REPO_URL);
    expect(html).toContain('value="trunk"');
    expect(html).toContain('value="5"');
  });

  /* --------------------------- URL 历史 / 配置 / 模式切换 --------------------------- */

  it('URL 历史成功才记录（取消不记录），并去重置顶', async () => {
    mockCheckoutHang();
    const panel = await openPanel(labRoot);
    await startCheckoutRunning(panel, join(labRoot, 'trunk'));
    vscodeMock.confirmResult = strings.checkoutPanel.cancelConfirmButton;
    send(panel, { kind: 'cancelTask' });
    await sleep(60);
    expect(globalStateMap.get('svnAnywhere.checkoutUrlHistory')).toBeUndefined();
    // 新建任务后再跑一次成功任务：记录 URL。
    send(panel, { kind: 'newTask' });
    await sleep(0);
    mockRun(async (args) => {
      if (args[0] === 'info' && args[1] === '--xml') {
        return okRun(INFO_XML(5));
      }
      if (args[0] === 'checkout') {
        return okRun('A    a.txt\nChecked out revision 5.\n');
      }
      return okRun();
    });
    vscodeMock.confirmResult = undefined;
    await fillToReview(panel);
    send(panel, { kind: 'startCheckout' });
    await sleep(80);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.resultTitles.success);
    expect(globalStateMap.get('svnAnywhere.checkoutUrlHistory')).toEqual([REPO_URL]);
  });

  it('checkoutDefaultDepth 只影响新任务草稿初始深度、已编辑草稿不被覆盖', async () => {
    vscodeMock.config = { checkoutDefaultDepth: 'empty' };
    const { saveDraft } = await import('../src/host/panel/drafts');
    saveDraft(labRoot, 'checkout', { ...FORM, depth: 'files', parentDir: labRoot });
    const panel = await openPanel(labRoot);
    // 有草稿：按草稿深度恢复（files），不被配置（empty）覆盖。
    expect(lastHtml(panel)).toMatch(/<option value="files" selected/);
    panel.dispose();
    await sleep(0);
    const { clearDraft } = await import('../src/host/panel/drafts');
    clearDraft(labRoot, 'checkout');
    const fresh = await openPanel(labRoot);
    // 无草稿的新表单：按配置初始深度（empty）。
    expect(lastHtml(fresh)).toMatch(/<option value="empty" selected/);
  });

  it('模式切换确认后清当前键草稿与结果缓存并递增结果代次', async () => {
    const { saveDraft } = await import('../src/host/panel/drafts');
    saveDraft(labRoot, 'checkout', { ...FORM, parentDir: labRoot });
    const { writeSessionResult } = await import('../src/host/sessionResults');
    writeSessionResult('checkout', { entryKey: labRoot, mode: 'checkout' }, {
      mode: 'checkout',
      kind: 'failed',
      path: join(labRoot, 'trunk'),
    }, 'executor');
    const panel = await openPanel(labRoot);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.resultTitles.failed);
    const epochBefore = getResultEpoch('checkout');
    vscodeMock.confirmResult = strings.panel.switchDiscardButton;
    send(panel, { kind: 'switchP3Mode' });
    await sleep(20);
    expect(vscodeMock.warning).toContain(strings.panel.switchDiscardTitle);
    // 切到导入模式表单（源目录分组字段）+ 键 = 同入口 + import。
    const html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.sourceDirLabel);
    expect(getResultEpoch('checkout')).toBe(epochBefore + 1);
    expect(readSessionResult('checkout', { entryKey: labRoot, mode: 'checkout' })).toBeUndefined();
    const { readDraft } = await import('../src/host/panel/drafts');
    expect(readDraft(labRoot, 'checkout')).toBeUndefined();
  });

  it('运行中拒绝模式切换与新目标打开', async () => {
    mockCheckoutHang();
    const panel = await openPanel(labRoot);
    await startCheckoutRunning(panel, join(labRoot, 'trunk'));
    // 运行页 busy：switchP3Mode 不在 busy 放行表——宿主 gate 拒绝并 toast。
    send(panel, { kind: 'switchP3Mode' });
    await sleep(0);
    expect(toastMessages(panel)).toContain(strings.panel.toastBusyRejected);
    // 面板存在时新目标打开被控制器拒绝（运行中不切换）。
    const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), 'entry-busy-')));
    try {
      await openCheckoutPanel({ entryKey: otherRoot, mode: 'checkout', parentDir: otherRoot });
      await sleep(0);
      expect(toastMessages(panel).some((message) => message.includes(strings.panel.panelBusySwitchRejected.split('：')[0]))).toBe(true);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('导入 unknown 页：换目标与模式切换均拒绝并提示，面板保持、记录与核实入口不变', async () => {
    const src = join(labRoot, 'src-import');
    await presetRecord(importRecord());
    const panel = await openImportPanelAt(src);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.importResultTitles.unknown);
    const epochBefore = getResultEpoch('checkout');
    // 模式切换（switchP3Mode 等同换目标）：专门分支拒绝（§4），面板保持。
    send(panel, { kind: 'switchP3Mode' });
    await sleep(20);
    expect(toastMessages(panel)).toContain(strings.checkoutPanel.unresolvedImportSwitchRejected);
    let html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.importResultTitles.unknown);
    expect(html).toContain(strings.checkoutPanel.actVerifyImport);
    expect(getResultEpoch('checkout')).toBe(epochBefore);
    // 新目标入口打开（命令入口路径，不经放行表）：同样拒绝，reveal 当前面板。
    const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), 'entry-unknown-')));
    try {
      await openCheckoutPanel({ entryKey: otherRoot, mode: 'checkout', parentDir: otherRoot });
      await sleep(0);
      expect(toastMessages(panel).filter((message) => message === strings.checkoutPanel.unresolvedImportSwitchRejected).length).toBe(2);
      html = lastHtml(panel);
      expect(html).toContain(strings.checkoutPanel.importResultTitles.unknown);
      expect(html).toContain(strings.checkoutPanel.actVerifyImport);
      expect(panel.revealed).toBeGreaterThan(0);
      // 记录与缓存不受切换尝试影响：仍处 unknown、核实动作对象不变。
      expect(store.records.get('op-import-1')?.phase).toBe('unknown');
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('merged 未收口页换目标与模式切换拒绝；settled 后恢复确认切换', async () => {
    const src = join(labRoot, 'src-merged');
    await presetRecord(
      importRecord({
        operationId: 'op-import-merged',
        outcome: 'merged',
        resolvedRevision: 9,
        wcRoot: src,
        lockKey: src,
        targetPath: src,
      }),
    );
    const panel = await openImportPanelAt(src);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.importResultTitles.merged);
    // 模式切换拒绝：面板保持、收口与核实入口不变。
    send(panel, { kind: 'switchP3Mode' });
    await sleep(20);
    expect(toastMessages(panel)).toContain(strings.checkoutPanel.unresolvedImportSwitchRejected);
    let html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.importResultTitles.merged);
    expect(html).toContain(strings.checkoutPanel.actAckMerged);
    // 新目标打开拒绝：面板保持、记录仍在。
    const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), 'entry-merged-')));
    try {
      await openCheckoutPanel({ entryKey: otherRoot, mode: 'checkout', parentDir: otherRoot });
      await sleep(0);
      expect(toastMessages(panel).filter((message) => message === strings.checkoutPanel.unresolvedImportSwitchRejected).length).toBe(2);
      html = lastHtml(panel);
      expect(html).toContain(strings.checkoutPanel.importResultTitles.merged);
      expect(html).toContain(strings.checkoutPanel.actVerifyImport);
      expect(store.records.get('op-import-merged')?.phase).toBe('unknown');
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
    // acknowledgeMerged 收口后（记录移除、settled 页缓存承载）：恢复确认切换。
    panel.dispose();
    await sleep(0);
    await getOperationRegistry().finish('op-import-merged');
    const { writeSessionResult } = await import('../src/host/sessionResults');
    writeSessionResult('checkout', { entryKey: src, mode: 'import' }, {
      mode: 'import',
      kind: 'merged',
      path: src,
      settled: true,
    }, 'executor');
    const settledPanel = await openImportPanelAt(src);
    const settledHtml = lastHtml(settledPanel);
    expect(settledHtml).toContain(strings.checkoutPanel.importResultTitles.merged);
    expect(settledHtml).toContain(strings.checkoutPanel.actNewTask);
    const epochBefore = getResultEpoch('checkout');
    vscodeMock.confirmResult = strings.panel.switchDiscardButton;
    send(settledPanel, { kind: 'switchP3Mode' });
    await sleep(20);
    expect(vscodeMock.warning).toContain(strings.panel.switchDiscardTitle);
    // 确认后切到 checkout 模式表单、代次递增（离页动作）。
    expect(lastHtml(settledPanel)).toContain(strings.checkoutPanel.parentDirLabel);
    expect(getResultEpoch('checkout')).toBe(epochBefore + 1);
  });

  it('canceled 页因他人记录 writeLocked 时确认切换仍可用（对照：不按笼统 writeLocked 拒绝）', async () => {
    const target = join(labRoot, 'trunk');
    const { writeSessionResult } = await import('../src/host/sessionResults');
    writeSessionResult('checkout', { entryKey: labRoot, mode: 'checkout' }, {
      mode: 'checkout',
      kind: 'canceled',
      path: target,
    }, 'executor');
    // 他人记录（M2 commit unknown）占同键：canceled 结果页 writeLocked=true。
    await presetRecord({
      operationId: 'op-foreign-commit',
      wcRoot: target,
      lockKey: target,
      kind: 'commit',
      targetRelPath: '.',
      nodeKind: 'dir',
      phase: 'unknown',
      knownRevisions: [],
      updatedAt: Date.now(),
    });
    const panel = await openPanel(labRoot);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.resultTitles.canceled);
    // writeLocked 事实源：结果页目标键命中他人记录的写限制（§7.1 派生同源）。
    expect(getOperationRegistry().writeRestriction(target)?.operationId).toBe('op-foreign-commit');
    // switchP3Mode 过 writeLocked 放行表进处理器：unknown 判定不命中（结果页
    // 是 checkout canceled），照常走「放弃并切换」确认。
    const epochBefore = getResultEpoch('checkout');
    vscodeMock.confirmResult = strings.panel.switchDiscardButton;
    send(panel, { kind: 'switchP3Mode' });
    await sleep(20);
    expect(vscodeMock.warning).toContain(strings.panel.switchDiscardTitle);
    expect(toastMessages(panel)).not.toContain(strings.checkoutPanel.unresolvedImportSwitchRejected);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.sourceDirLabel);
    expect(getResultEpoch('checkout')).toBe(epochBefore + 1);
  });

  it('开始检出被同键在途记录占用（begin busy 预命令出口）：回核对页并提示换目标或等待', async () => {
    // 经 begin 预置真实 active 在途记录锁定同键（不走 loadPending——首载会把
    // 陈旧 prepared 折算成 residue-pending，构造不出占用形态）。
    const target = join(labRoot, 'trunk');
    const begin = await getOperationRegistry().begin({
      wcRoot: target,
      targetRelPath: '.',
      nodeKind: 'dir',
      kind: 'checkout',
      lockKey: target,
      url: REPO_URL,
      targetPath: target,
      pinnedRevision: 5,
      depth: 'infinity',
    });
    expect(begin.ok).toBe(true);
    const panel = await openPanel(labRoot);
    await fillToReview(panel);
    send(panel, { kind: 'startCheckout' });
    await sleep(40);
    const html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.stepReview);
    expect(toastMessages(panel)).toContain(strings.checkoutPanel.beginBusyNotice);
    // 预命令出口把表单快照写回草稿：关闭重开恢复 form 步（不落进度页）。
    panel.dispose();
    await sleep(0);
    const reopened = await openPanel(labRoot);
    const reopenedHtml = lastHtml(reopened);
    expect(reopenedHtml).toContain(strings.checkoutPanel.stepForm);
    expect(reopenedHtml).toContain(REPO_URL);
    expect(reopenedHtml).not.toContain('data-intent="cancelTask"');
  });
});
