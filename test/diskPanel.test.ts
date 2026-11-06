/**
 * P4 磁盘治理面板（panels/disk.ts + diskTask.ts）的 flow 测试：mock vscode
 * （面板替身/globalState/确认框/命令执行）与 core 扫描层（scanDiskUsage/
 * readPristineStats）+ svn 命令层（vacuum），从面板意图驱动：
 * - 扫描全链：开始/进度页/完成 ready、partial 禁清理、取消 scanCanceled
 *   不展示数值、失败 scanError、externals 排除进范围说明、pristine 不可用
 *   呈现（F55 数值 — + F56 禁清理）；
 * - 清理链：确认框内容（根路径/预计量/保留范围）、快照变化 changed 出口
 *   （缓存写入+任务移除+busy 恢复+重新检测入口、读取失败不冒充「检测到
 *   变化」）、begin 失败 toast、命令成功→复测→cleaned（cleanBeforeBytes
 *   更新为复测剩余值、代次递进）、复测失败三形态→refreshError、命令失败
 *   →cleanupFailed+记录 failed-unconfirmed 保留、重新检测完成 finish 解除；
 * - 重检窗口 busy（rescan/startScan/confirmVacuum 被拒、换副本被拒、关闭
 *   重开回清理中）与「重开先于重检完成」送达（changed 出口先写缓存再移除
 *   任务）；changed 代次守卫（测试内强行递增验证丢弃）；
 * - 三段恢复各段（任务绑定跨副本/缓存命中与不一致丢弃/记录分诊）与
 *   scanCanceled 缓存优先于 vacuum unknown 记录、重启标记（消费一次/
 *   idle 不误报/终态清除/优先级/复测中断标记保留）；
 * - busy/writeLocked 跨面板新鲜度（另一面板占用后下一次 intent 重算）
 *   与 writeLocked 按 kind 分列文案。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { SvnError } from '../src/core/errors';
import type { PristineStats, ScanDiskUsageResult } from '../src/core/diskUsage';
import {
  OperationRegistry,
  getOperationRegistry,
  resetRunningOperationsForTest,
  setOperationRegistryForTest,
  type OperationRecord,
  type OperationStore,
} from '../src/core/operations';
import { runOrThrow, type RunResult } from '../src/core/svnCli';
import { bumpResultEpoch, resetResultEpochs } from '../src/host/resultEpoch';
import { readSessionResult, resetSessionResults } from '../src/host/sessionResults';
import { getActiveTask, resetTaskRegistry } from '../src/host/taskRegistry';
import { resetPanelRegistry } from '../src/host/panel/host';
import { resetOutputState } from '../src/host/output';
import { strings } from '../src/host/i18n';
import {
  openDiskPanel,
  resetDiskPanelController,
  setDiskPanelContext,
  diskSessionSnapshot,
} from '../src/host/panel/panels/disk';
import { setDiskMarkerStorage } from '../src/host/panel/diskTask';

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
    showWarningMessage: (message: string, options?: { detail?: string }, ...items: string[]) => {
      // 确认框断言需要完整内容：消息与 detail 一并记录。
      vscodeMock.warning.push(options?.detail ? `${message}\n${String(options.detail)}` : message);
      return Promise.resolve(items.length > 0 ? vscodeMock.confirmResult : undefined);
    },
    showErrorMessage: (message: string) => {
      vscodeMock.errorMessages.push(message);
      return Promise.resolve(undefined);
    },
    showOpenDialog: () => Promise.resolve(undefined),
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
      return [];
    },
    updateWorkspaceFolders: () => true,
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

vi.mock('../src/core/diskUsage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/diskUsage')>();
  return { ...actual, scanDiskUsage: vi.fn(), readPristineStats: vi.fn() };
});

vi.mock('../src/core/svnCli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/svnCli')>();
  return { ...actual, runOrThrow: vi.fn() };
});

import { readPristineStats, scanDiskUsage } from '../src/core/diskUsage';

/* ------------------------------ 面板替身 ------------------------------ */

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
  sendIntent(intent: Record<string, unknown>, requestId?: string): void;
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
  config: {} as Record<string, unknown>,
  executedCommands: [] as unknown[][],
  globalState: new Map<string, unknown>(),
}));

/* ------------------------------ 扫描层 mock ------------------------------ */

const SCAN_FILES = [
  { path: 'a.txt', kind: 'file' as const, bytes: 100 },
  { path: 'sub/b.txt', kind: 'file' as const, bytes: 200 },
];

function scanComplete(overrides: Partial<ScanDiskUsageResult> = {}): ScanDiskUsageResult {
  return {
    phase: 'complete',
    files: SCAN_FILES,
    totals: { business: 300, svn: 2048, pristineBytes: 1024, total: 2348 },
    excluded: [],
    scanCount: 3,
    ...overrides,
  };
}

function pristineOk(overrides: Partial<PristineStats> = {}): PristineStats {
  return { available: true, totalCount: 3, cacheCount: 2, unreferencedBytes: 2048, missingCount: 0, ...overrides };
}

/** 顺序队列：第 N 次调用取第 N 个 handler；耗尽后取兜底（complete/ok）。 */
type ScanOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: { scanCount: number; currentPath: string }) => void;
};
let scanQueue: Array<(options: ScanOptions) => Promise<ScanDiskUsageResult>> = [];
let pristineQueue: Array<() => Promise<PristineStats>> = [];

function queueScan(...handlers: Array<(options: ScanOptions) => Promise<ScanDiskUsageResult>>): void {
  scanQueue = [...handlers];
}

function queuePristine(...handlers: Array<() => Promise<PristineStats>>): void {
  pristineQueue = [...handlers];
}

/** 手动放行的挂起值。 */
function pending<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitUntil(fn: () => boolean, attempts = 200, gap = 10): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    if (fn()) {
      return true;
    }
    await sleep(gap);
  }
  return fn();
}

/* ------------------------------ 面板辅助 ------------------------------ */

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

function toastMessages(panel: FakePanel): string[] {
  return panel.posted
    .filter((message) => message.type === 'toast')
    .map((message) => String(message.message ?? ''));
}

let intentSeq = 0;
function send(panel: FakePanel, intent: Record<string, unknown>): void {
  intentSeq += 1;
  panel.sendIntent(intent, `req-${intentSeq}`);
}

async function openDisk(wcRoot: string, subPath = wcRoot): Promise<FakePanel> {
  await openDiskPanel({ wcRoot, subPath });
  await sleep(0);
  return lastPanel();
}

/** 扫描到 ready（默认夹具：2 项未引用 / 2048 B）并等待结算。 */
async function scanToReady(panel: FakePanel): Promise<void> {
  send(panel, { kind: 'startScan' });
  expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'ready')).toBe(true);
}

/** 确认清理（确认框返回「清理」按钮）。 */
async function confirmVacuum(panel: FakePanel): Promise<void> {
  vscodeMock.confirmResult = strings.diskPanel.vacuumConfirmButton;
  send(panel, { kind: 'confirmVacuum' });
  await sleep(10);
}

/** 等待清理任务对象消失（出口/终态完成）。 */
async function waitTaskGone(): Promise<boolean> {
  return waitUntil(() => getActiveTask('disk') === undefined);
}

/* ------------------------------ 夹具与重置 ------------------------------ */

let store: OperationStore & { records: Map<string, OperationRecord>; saved: OperationRecord[] };
let globalStateMap: Map<string, unknown>;
let labRoot: string;
let wcA: string;
let wcB: string;

/** 内存存储：records 为当前集合，saved 保留全部落盘历史（终态收口后的断言用）。 */
function makeMemoryStore(): OperationStore & { records: Map<string, OperationRecord>; saved: OperationRecord[] } {
  const records = new Map<string, OperationRecord>();
  const saved: OperationRecord[] = [];
  return {
    records,
    saved,
    load: () => [...records.values()],
    async save(record) {
      records.set(record.operationId, record);
      saved.push({ ...record });
    },
    async remove(operationId) {
      records.delete(operationId);
    },
  };
}

const okRun = (stdout = ''): RunResult => ({ stdout, stderr: '', exitCode: 0 });

function vacuumRecords(): OperationRecord[] {
  return [...store.records.values()].filter((record) => record.kind === 'vacuum');
}

function makeRecord(overrides: Partial<OperationRecord>): OperationRecord {
  return {
    operationId: 'op-test-1',
    wcRoot: wcA,
    lockKey: wcA,
    targetRelPath: '.',
    nodeKind: 'dir',
    phase: 'unknown',
    knownRevisions: [],
    updatedAt: Date.now(),
    ...overrides,
  } as OperationRecord;
}

async function presetRecord(record: OperationRecord): Promise<void> {
  store.records.set(record.operationId, record);
  await getOperationRegistry().loadPending();
}

/** 重启模拟：内存态（面板/任务/缓存/代次/运行登记）清空，globalState 保留。 */
async function simulateRestart(): Promise<void> {
  for (const panel of vscodeMock.panels) {
    panel.disposed = true;
  }
  vscodeMock.panels.length = 0;
  resetPanelRegistry();
  resetDiskPanelController();
  resetTaskRegistry();
  resetSessionResults();
  resetResultEpochs();
  resetRunningOperationsForTest();
  const registry = new OperationRegistry(store);
  await registry.loadPending();
  setOperationRegistryForTest(registry);
}

function markerOf(wcRoot: string): unknown {
  return globalStateMap.get(`svnAnywhere.diskScanning|${wcRoot}`);
}

beforeEach(async () => {
  vscodeMock.panels.length = 0;
  vscodeMock.information.length = 0;
  vscodeMock.warning.length = 0;
  vscodeMock.errorMessages.length = 0;
  vscodeMock.confirmResult = undefined;
  vscodeMock.config = {};
  vscodeMock.executedCommands.length = 0;
  vscodeMock.globalState.clear();
  resetDiskPanelController();
  resetPanelRegistry();
  resetTaskRegistry();
  resetSessionResults();
  resetResultEpochs();
  resetRunningOperationsForTest();
  resetOutputState();
  scanQueue = [];
  pristineQueue = [];
  vi.mocked(scanDiskUsage).mockReset().mockImplementation(async (_svn: string, _wc: string, options) => {
    const handler = scanQueue.shift();
    if (handler) {
      return handler(options ?? {});
    }
    return scanComplete();
  });
  vi.mocked(readPristineStats).mockReset().mockImplementation(async () => {
    const handler = pristineQueue.shift();
    if (handler) {
      return handler();
    }
    return pristineOk();
  });
  vi.mocked(runOrThrow).mockReset().mockResolvedValue(okRun());
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
  setDiskMarkerStorage(memento);
  setDiskPanelContext({
    extensionUri: { scheme: 'file', path: '/ext' } as unknown as vscode.Uri,
    subscriptions: [],
    globalState: memento,
  });
  labRoot = realpathSync(mkdtempSync(join(tmpdir(), 'disk-panel-')));
  wcA = join(labRoot, 'wc-a');
  wcB = join(labRoot, 'wc-b');
  mkdirSync(wcA, { recursive: true });
  mkdirSync(wcB, { recursive: true });
});

afterEach(() => {
  rmSync(labRoot, { recursive: true, force: true });
});

/* ------------------------------ 扫描全链 ------------------------------ */

describe('P4 磁盘面板 flow：扫描', () => {
  it('开始扫描进入 scanning（横幅与取消入口），完成转 ready 回填数值并写入缓存、移除任务', async () => {
    const gate = pending<ScanDiskUsageResult>();
    queueScan(() => gate.promise);
    const panel = await openDisk(wcA);
    send(panel, { kind: 'startScan' });
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'scanning')).toBe(true);
    expect(getActiveTask('disk')?.phase).toBe('scanning');
    let html = lastHtml(panel);
    expect(html).toContain(strings.diskPanel.scanningBanner);
    expect(html).toContain(strings.diskPanel.actCancelScan);
    gate.resolve(scanComplete());
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'ready')).toBe(true);
    html = lastHtml(panel);
    expect(html).toContain(strings.diskPanel.metricReclaimable);
    const state = diskSessionSnapshot()!;
    expect(state.total).toBe(2348);
    expect(state.business).toBe(300);
    expect(state.svn).toBe(2048);
    expect(state.pristineBytes).toBe(1024);
    expect(state.pristine.cacheCount).toBe(2);
    expect(state.files).toHaveLength(2);
    expect(getActiveTask('disk')).toBeUndefined();
    // 执行器结算已写缓存（关闭重开恢复的承载）。
    const cached = readSessionResult('disk', { wcRoot: wcA });
    expect((cached?.page as { phase?: string }).phase).toBe('ready');
  });

  it('扫描进度回调透传到 scanning 页：已读取条目数与当前路径可见（core → 执行器 → 面板）', async () => {
    const gate = pending<ScanDiskUsageResult>();
    queueScan((options) => {
      // core 的进度回调形态（每 64 条目一次）：同步触发后扫描仍在进行。
      options.onProgress?.({ scanCount: 128, currentPath: 'trunk/big.bin' });
      return gate.promise;
    });
    const panel = await openDisk(wcA);
    send(panel, { kind: 'startScan' });
    expect(await waitUntil(() => diskSessionSnapshot()?.scanCurrentPath === 'trunk/big.bin')).toBe(true);
    const state = diskSessionSnapshot()!;
    expect(state.phase).toBe('scanning');
    expect(state.scanCount).toBe(128);
    // scanning 页渲染已读取条目数与「正在读取」路径（第一次回调立即整帧推送）。
    expect(lastHtml(panel)).toContain('128');
    expect(lastHtml(panel)).toContain('trunk/big.bin');
    gate.resolve(scanComplete());
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'ready')).toBe(true);
  });

  it('partial（目录不可读/externals 读取失败）转 partial 相位并禁清理（矩阵原因）', async () => {
    queueScan(() =>
      Promise.resolve(scanComplete({ phase: 'partial', partialReason: '2 个路径读取失败（如 sub：EACCES）' })),
    );
    const panel = await openDisk(wcA);
    send(panel, { kind: 'startScan' });
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'partial')).toBe(true);
    const state = diskSessionSnapshot()!;
    expect(state.scanComplete).toBe(false);
    expect(state.errors[0]).toContain('EACCES');
    expect(lastHtml(panel)).toContain(strings.diskPanel.vacuumReasonPartial);
  });

  it('取消扫描：scanCanceled 不展示任何已读数值（缓存同样不存部分数值）', async () => {
    queueScan(
      (options) =>
        new Promise<ScanDiskUsageResult>((resolve) => {
          if (options.signal?.aborted) {
            resolve(scanComplete({ phase: 'partial', partialReason: '扫描已取消，结果为已扫描部分' }));
            return;
          }
          options.signal?.addEventListener('abort', () => {
            resolve(scanComplete({ phase: 'partial', partialReason: '扫描已取消，结果为已扫描部分' }));
          }, { once: true });
        }),
    );
    const panel = await openDisk(wcA);
    send(panel, { kind: 'startScan' });
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'scanning')).toBe(true);
    send(panel, { kind: 'cancelScan' });
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'scanCanceled')).toBe(true);
    const state = diskSessionSnapshot()!;
    expect(state.total).toBeNull();
    expect(state.files).toHaveLength(0);
    expect(state.scanCount).toBe(0);
    const cached = readSessionResult('disk', { wcRoot: wcA });
    const page = cached?.page as { phase?: string; total?: number | null };
    expect(page.phase).toBe('scanCanceled');
    expect(page.total).toBeNull();
    // 扫描中断标记随结算清除（正常运行不残留）。
    expect(markerOf(wcA)).toBeUndefined();
  });

  it('扫描异常收口：scanError 显示原因、不把失败伪装成零缓存', async () => {
    queueScan(() => Promise.reject(new Error('svn 可执行文件不存在')));
    const panel = await openDisk(wcA);
    send(panel, { kind: 'startScan' });
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'scanError')).toBe(true);
    const state = diskSessionSnapshot()!;
    expect(state.errors[0]).toContain('svn 可执行文件不存在');
    expect(state.pristine.cacheCount).toBeNull();
    expect(lastHtml(panel)).toContain(strings.diskPanel.scanErrorTitle);
    expect(lastHtml(panel)).toContain('svn 可执行文件不存在');
  });

  it('externals 落点与嵌套副本进 excluded（范围说明弹窗数据源）', async () => {
    queueScan(() =>
      Promise.resolve(scanComplete({
        excluded: ['ext-lib', 'nested-wc', 'broken（存在无法解析的 externals 定义，已保守排除）'],
      })),
    );
    const panel = await openDisk(wcA);
    await scanToReady(panel);
    const state = diskSessionSnapshot()!;
    expect(state.excluded).toHaveLength(3);
    const broken = state.excluded.find((item) => item.path === 'broken');
    expect(broken?.reason).toContain('保守排除');
    send(panel, { kind: 'showScopeHelp' });
    expect(vscodeMock.information.at(-1) ?? '').toContain('ext-lib');
  });

  it('pristine 检测不可用（F55/F56）：数值显示 — 不冒充 0、清理禁用给原因', async () => {
    queuePristine(() => Promise.resolve({ available: false, reason: 'wc.db 打开失败：被占用' }));
    const panel = await openDisk(wcA);
    send(panel, { kind: 'startScan' });
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'ready')).toBe(true);
    const state = diskSessionSnapshot()!;
    expect(state.pristine.state).toBe('unavailable');
    expect(state.pristine.cacheCount).toBeNull();
    const html = lastHtml(panel);
    expect(html).toContain(strings.diskPanel.vacuumReasonUnsupported.replace('{reason}', 'wc.db 打开失败：被占用'));
    // 宿主不支持 node:sqlite 的 unsupported 形态同款（固定文案判别）。
    queuePristine(() => Promise.resolve({ available: false, reason: '当前 VS Code 宿主不支持缓存检测' }));
    send(panel, { kind: 'rescan' });
    expect(await waitUntil(() => diskSessionSnapshot()?.pristine.state === 'unsupported')).toBe(true);
  });
});

/* ------------------------------ 清理链 ------------------------------ */

describe('P4 磁盘面板 flow：清理链', () => {
  it('确认框列完整根路径/预计数量体积/保留范围；取消不发起（无任务无记录）', async () => {
    const panel = await openDisk(wcA);
    await scanToReady(panel);
    vscodeMock.confirmResult = undefined;
    send(panel, { kind: 'confirmVacuum' });
    await sleep(10);
    const message = vscodeMock.warning.at(-1) ?? '';
    expect(message).toContain(wcA);
    expect(message).toContain('2 项');
    expect(message).toContain('2.0 KiB');
    expect(message).toContain(strings.diskPanel.vacuumConfirmKeepScope);
    expect(getActiveTask('disk')).toBeUndefined();
    expect(vacuumRecords()).toHaveLength(0);
    expect(diskSessionSnapshot()?.phase).toBe('ready');
  });

  it('missingCount>0 时确认框标注预计量可能偏大', async () => {
    queuePristine(() => Promise.resolve(pristineOk({ missingCount: 1 })));
    const panel = await openDisk(wcA);
    send(panel, { kind: 'startScan' });
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'ready')).toBe(true);
    vscodeMock.confirmResult = undefined;
    send(panel, { kind: 'confirmVacuum' });
    await sleep(10);
    expect(vscodeMock.warning.at(-1) ?? '').toContain(strings.diskPanel.vacuumConfirmMissingSuffix.replace('{count}', '1'));
  });

  it('快照重检不一致 → changed 出口：控制器写缓存+任务移除+busy 恢复+重新检测入口', async () => {
    const panel = await openDisk(wcA);
    await scanToReady(panel);
    // 重检复读：未引用缓存数变化（外部检出新副本引入引用变化）。
    queuePristine(() => Promise.resolve(pristineOk({ cacheCount: 3, unreferencedBytes: 3072 })));
    await confirmVacuum(panel);
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'changed')).toBe(true);
    const state = diskSessionSnapshot()!;
    expect(state.changedReason).toContain(strings.diskPanel.changedReasonSnapshotPlain.slice(0, 6));
    expect(getActiveTask('disk')).toBeUndefined();
    expect(vacuumRecords()).toHaveLength(0);
    // changed 结果页由 P4 控制器写入（面板内结果转移，非任务终态）。
    const cached = readSessionResult('disk', { wcRoot: wcA });
    expect((cached?.page as { phase?: string }).phase).toBe('changed');
    const html = lastHtml(panel);
    expect(html).toContain(strings.diskPanel.changedBannerTitle);
    expect(html).toContain(strings.diskPanel.actRedetect);
    // 旧分析结果保留（数值与表格），changed 页不落回 idle。
    expect(state.total).toBe(2348);
  });

  it('重检读取失败（pristine 复读落 unavailable）→ changed 保守收口，不冒充「检测到变化」', async () => {
    const panel = await openDisk(wcA);
    await scanToReady(panel);
    queuePristine(() => Promise.resolve({ available: false, reason: 'wc.db 被外部进程占用' }));
    await confirmVacuum(panel);
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'changed')).toBe(true);
    const reason = diskSessionSnapshot()!.changedReason ?? '';
    expect(reason).toContain('无法读取磁盘状态');
    expect(reason).toContain('wc.db 被外部进程占用');
    expect(reason).not.toContain('检测快照已变化');
  });

  it('begin 失败（重检通过后外部占用）→ toast 等待提示 + 面板回清理前结果态，缓存不被改写', async () => {
    const panel = await openDisk(wcA);
    await scanToReady(panel);
    const gate = pending<PristineStats>();
    queuePristine(() => gate.promise);
    vscodeMock.confirmResult = strings.diskPanel.vacuumConfirmButton;
    send(panel, { kind: 'confirmVacuum' });
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'cleaning')).toBe(true);
    // 重检进行中：外部（另一面板流程）对同副本 begin 占用。
    const external = await getOperationRegistry().begin({
      wcRoot: wcA, targetRelPath: '.', nodeKind: 'dir', kind: 'commit',
    });
    expect(external.ok).toBe(true);
    gate.resolve(pristineOk());
    expect(await waitUntil(() => getActiveTask('disk') === undefined)).toBe(true);
    const state = diskSessionSnapshot()!;
    expect(state.phase).toBe('ready');
    expect(toastMessages(panel)).toContain(strings.diskPanel.vacuumBeginBusyNotice);
    // 缓存仍持清理前结果页（begin 失败不产生清理结果页）。
    expect((readSessionResult('disk', { wcRoot: wcA })?.page as { phase?: string }).phase).toBe('ready');
    await getOperationRegistry().finish(external.ok ? external.operationId : undefined);
  });

  it('命令成功→自动复测→cleaned：cleanBeforeBytes 更新为复测剩余值、代次递进、记录 finish 移除', async () => {
    const panel = await openDisk(wcA);
    await scanToReady(panel);
    const epochBefore = diskSessionSnapshot()!.scanEpoch;
    // 重检复读须与确认快照一致（2 项 / 2048 B），复测（命令成功后）剩余 1 项 / 1024 B。
    queuePristine(
      () => Promise.resolve(pristineOk()),
      () => Promise.resolve(pristineOk({ cacheCount: 1, unreferencedBytes: 1024, totalCount: 2 })),
    );
    queueScan(() => Promise.resolve(scanComplete({
      files: [{ path: 'a.txt', kind: 'file', bytes: 100 }],
      totals: { business: 100, svn: 1224, pristineBytes: 512, total: 1324 },
    })));
    await confirmVacuum(panel);
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'cleaned')).toBe(true);
    const state = diskSessionSnapshot()!;
    // cleaning 全程覆盖命令+复测：cleaned 数值全部来自复测实测。
    expect(state.clean.lastBeforeBytes).toBe(2348);
    expect(state.clean.lastAfterBytes).toBe(1324);
    expect(state.clean.releasedBytes).toBe(1024);
    expect(state.clean.cleanBeforeBytes).toBe(1024);
    expect(state.clean.cleanAfterBytes).toBe(1024);
    // 复测即新检测代次：scanEpoch 递增绑定复测值。
    expect(state.scanEpoch).toBe(epochBefore + 1);
    expect(state.pristine.cacheCount).toBe(1);
    expect(vacuumRecords()).toHaveLength(0);
    expect(markerOf(wcA)).toBeUndefined();
    expect(lastHtml(panel)).toContain(strings.diskPanel.cleanedBanner);
  });

  it('复测失败三形态（partial / pristine unavailable / scanError）由 cleaning 直转 refreshError', async () => {
    // 形态一：复测扫描 partial。
    {
      const panel = await openDisk(wcA);
      await scanToReady(panel);
      queueScan(() => Promise.resolve(scanComplete({ phase: 'partial', partialReason: 'externals 定义读取失败，外部子树可能被计入业务口径' })));
      await confirmVacuum(panel);
      expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'refreshError')).toBe(true);
      const state = diskSessionSnapshot()!;
      expect(state.clean.releasedBytes).toBeNull();
      expect(state.clean.cleanAfterBytes).toBeNull();
      expect(lastHtml(panel)).toContain(strings.diskPanel.refreshErrorBanner);
    }
    // 形态二：pristine 复测 unavailable（重检复读一致、复测落不可用）。
    {
      const panel = await openDisk(wcB);
      send(panel, { kind: 'startScan' });
      expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'ready')).toBe(true);
      queuePristine(
        () => Promise.resolve(pristineOk()),
        () => Promise.resolve({ available: false, reason: 'wc.db 打开失败：被占用' }),
      );
      await confirmVacuum(panel);
      expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'refreshError')).toBe(true);
    }
    // 形态三：复测扫描异常（runScanOnce 抛错收口）。
    {
      vscodeMock.panels.forEach((p) => {
        p.disposed = true;
      });
      resetPanelRegistry();
      resetDiskPanelController();
      const panel = await openDisk(wcA);
      await scanToReady(panel);
      queueScan(() => Promise.reject(new Error('扫描进程异常终止')));
      await confirmVacuum(panel);
      expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'refreshError')).toBe(true);
    }
    // 三形态的 vacuum 记录都已在出口⑨ finish（refreshError 无记录动作）。
    expect(vacuumRecords()).toHaveLength(0);
  });

  it('命令失败 → cleanupFailed：cleanupError 保留、记录 failed-unconfirmed 保留至重新检测完成', async () => {
    const panel = await openDisk(wcA);
    await scanToReady(panel);
    vi.mocked(runOrThrow).mockRejectedValue(new SvnError({
      message: 'svn: E155004 磁盘空间不足', command: [], stderr: 'E155004', exitCode: 1,
    }));
    await confirmVacuum(panel);
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'cleanupFailed')).toBe(true);
    const state = diskSessionSnapshot()!;
    expect(state.cleanupError).toContain('E155004');
    expect(state.clean.releasedBytes).toBeNull();
    // 记录 failed-unconfirmed 保留（先重新检测；不立即 finish）。
    const records = vacuumRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.phase).toBe('failed-unconfirmed');
    expect(records[0]?.scanEpoch).toBe(state.scanEpoch);
    expect(records[0]?.pristineBefore).toEqual({ cacheCount: 2, unreferencedBytes: 2048, missingCount: 0 });
    expect(records[0]?.targetPath).toBe(wcA);
    expect(records[0]?.lockKey).toBe(wcA);
    // 关闭重开：缓存命中 cleanupFailed 页、失败原因文本一致。
    panel.dispose();
    const reopened = await openDisk(wcA);
    await sleep(10);
    expect(diskSessionSnapshot()?.phase).toBe('cleanupFailed');
    expect(diskSessionSnapshot()?.cleanupError).toContain('E155004');
    // 重新检测完成 → 出口⑩终结 failed-unconfirmed 记录、转 ready。
    send(reopened, { kind: 'rescan' });
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'ready')).toBe(true);
    expect(vacuumRecords()).toHaveLength(0);
  });

  it('连续清理：cleaned 复测剩余 >0 时按复测代次直接再次清理（不要求先重新分析）', async () => {
    const panel = await openDisk(wcA);
    await scanToReady(panel);
    // 第一次清理：重检一致（2 项/2048 B）→ 复测剩余 1 项 / 1024 B。
    queuePristine(
      () => Promise.resolve(pristineOk()),
      () => Promise.resolve(pristineOk({ cacheCount: 1, unreferencedBytes: 1024 })),
    );
    queueScan(() => Promise.resolve(scanComplete({
      totals: { business: 300, svn: 1024, pristineBytes: 512, total: 1324 },
    })));
    await confirmVacuum(panel);
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'cleaned')).toBe(true);
    const firstEpoch = diskSessionSnapshot()!.scanEpoch;
    // 第二次确认框预计量 = 复测剩余值、绑定复测代次。
    queuePristine(
      () => Promise.resolve(pristineOk({ cacheCount: 1, unreferencedBytes: 1024 })),
      () => Promise.resolve(pristineOk({ cacheCount: 0, unreferencedBytes: 0, totalCount: 1 })),
    );
    queueScan(() => Promise.resolve(scanComplete({
      totals: { business: 300, svn: 512, pristineBytes: 300, total: 812 },
    })));
    vscodeMock.confirmResult = strings.diskPanel.vacuumConfirmButton;
    send(panel, { kind: 'confirmVacuum' });
    // mock 链路毫秒级完成：cleaning 瞬态可能跨不过轮询间隔，等待启动用
    // 「cleaning 或 cleaned」、随后等待终态 cleaned。
    expect(await waitUntil(() => {
      const phase = diskSessionSnapshot()?.phase;
      return phase === 'cleaning' || phase === 'cleaned';
    })).toBe(true);
    const secondConfirm = vscodeMock.warning.at(-1) ?? '';
    expect(secondConfirm).toContain('1 项');
    expect(secondConfirm).toContain('1.0 KiB');
    expect(secondConfirm).toContain(`检测代次 ${firstEpoch}`);
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'cleaned')).toBe(true);
    // 第二条 vacuum 记录按复测代次落盘（终态收口后已移除——从落盘历史断言）。
    const secondRecord = store.saved.filter((record) => record.kind === 'vacuum').at(-1);
    expect(secondRecord?.scanEpoch).toBe(firstEpoch);
    expect(secondRecord?.pristineBefore?.unreferencedBytes).toBe(1024);
    expect(vacuumRecords()).toHaveLength(0);
    // 归零后禁清理（zero 派生态）。
    expect(lastHtml(panel)).toContain(strings.diskPanel.vacuumReasonZero);
  });
});

/* ------------------------------ 重检窗口 ------------------------------ */

describe('P4 磁盘面板 flow：重检窗口 busy 与送达', () => {
  interface HangingClean {
    panel: FakePanel;
    gate: { promise: Promise<PristineStats>; resolve: (value: PristineStats) => void };
  }

  async function openCleanHanging(): Promise<HangingClean> {
    const panel = await openDisk(wcA);
    await scanToReady(panel);
    const gate = pending<PristineStats>();
    queuePristine(() => gate.promise);
    vscodeMock.confirmResult = strings.diskPanel.vacuumConfirmButton;
    send(panel, { kind: 'confirmVacuum' });
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'cleaning')).toBe(true);
    return { panel, gate };
  }

  it('重检窗口全程 busy：rescan/startScan/confirmVacuum 被拒、表格只读意图可用、换副本被拒', async () => {
    const { panel, gate } = await openCleanHanging();
    const rejected = strings.panel.toastBusyRejected;
    for (const intent of [{ kind: 'startScan' }, { kind: 'rescan' }, { kind: 'confirmVacuum' }]) {
      send(panel, intent);
      await sleep(5);
      expect(toastMessages(panel).at(-1)).toBe(rejected);
    }
    // 表格只读意图（busy 行放行）不弹拒绝。
    const toastsBefore = toastMessages(panel).length;
    send(panel, { kind: 'setPage', page: 2 });
    await sleep(5);
    expect(toastMessages(panel).length).toBe(toastsBefore);
    // 换副本被拒（清理运行中）。
    await openDiskPanel({ wcRoot: wcB, subPath: wcB });
    expect(toastMessages(panel).at(-1)).toContain(strings.panel.panelBusySwitchRejected.slice(0, 4));
    gate.resolve(pristineOk());
    expect(await waitTaskGone()).toBe(true);
  });

  it('重检窗口关闭重开：三段①绑定清理任务回清理中进度页', async () => {
    const { panel, gate } = await openCleanHanging();
    panel.dispose();
    const reopened = await openDisk(wcA);
    expect(diskSessionSnapshot()?.phase).toBe('cleaning');
    expect(diskSessionSnapshot()?.binding?.resultScope.wcRoot).toBe(wcA);
    expect(getActiveTask('disk')?.panelKind).toBe('disk');
    gate.resolve(pristineOk());
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'cleaned')).toBe(true);
    void reopened;
  });

  it('「重开先于重检完成」：changed 出口先写缓存再移除任务，重开会话经通知重跑落 changed 页', async () => {
    const { panel, gate } = await openCleanHanging();
    panel.dispose();
    const reopened = await openDisk(wcA);
    expect(diskSessionSnapshot()?.phase).toBe('cleaning');
    const framesBefore = reopened.posted.length;
    // 重检返回不一致 → changed 出口：控制器先写缓存、执行器随后移除任务；
    // 重开会话（非发起）经任务移除通知重跑三段、落到 changed 页。
    gate.resolve(pristineOk({ cacheCount: 9, unreferencedBytes: 9216 }));
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'changed')).toBe(true);
    expect(diskSessionSnapshot()?.binding).toBeNull();
    expect(getActiveTask('disk')).toBeUndefined();
    expect((readSessionResult('disk', { wcRoot: wcA })?.page as { phase?: string }).phase).toBe('changed');
    expect(reopened.posted.length).toBeGreaterThan(framesBefore);
    expect(lastHtml(reopened)).toContain(strings.diskPanel.changedBannerTitle);
    expect(lastHtml(reopened)).toContain(strings.diskPanel.actRedetect);
  });

  it('changed 代次守卫：测试内强行递增代次后，迟到的 changed 不写缓存（守卫防御完备）', async () => {
    const panel = await openDisk(wcA);
    await scanToReady(panel);
    const gate = pending<PristineStats>();
    queuePristine(() => gate.promise);
    await confirmVacuum(panel);
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'cleaning')).toBe(true);
    // 强行递增（模拟递增点遗漏/跨会话冲突的防御形态——重检窗口内用户不可达）。
    bumpResultEpoch('disk');
    gate.resolve(pristineOk({ cacheCount: 5, unreferencedBytes: 5120 }));
    expect(await waitTaskGone()).toBe(true);
    expect(vacuumRecords()).toHaveLength(0);
    // 缓存不被迟到 changed 覆盖：仍持清理前结果页。
    expect((readSessionResult('disk', { wcRoot: wcA })?.page as { phase?: string }).phase).toBe('ready');
    void panel;
  });
});

/* ------------------------------ 三段恢复 ------------------------------ */

describe('P4 磁盘面板 flow：三段恢复与重启', () => {
  it('三段①：A 扫描运行中从 B fresh open → 绑定 A 任务、页头取任务 subPath；完成后按 scope 恢复 A 结果页', async () => {
    const gate = pending<ScanDiskUsageResult>();
    queueScan(() => gate.promise);
    const panel = await openDisk(wcA, join(wcA, 'sub-x'));
    send(panel, { kind: 'startScan' });
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'scanning')).toBe(true);
    panel.dispose();
    // 从另一副本 B fresh open：不拒绝、不建 B 会话——绑定 A 的扫描任务。
    const reopened = await openDisk(wcB);
    const state = diskSessionSnapshot()!;
    expect(state.phase).toBe('scanning');
    expect(state.wcRoot).toBe(wcA);
    expect(state.binding?.resultScope.wcRoot).toBe(wcA);
    // 页头 subPath 取任务创建时记录的打开子目录（不显示本次打开的 B）。
    expect(state.binding?.subPath).toBe(join(wcA, 'sub-x'));
    gate.resolve(scanComplete());
    // 执行器写缓存（scope A）+移除任务 → 绑定会话（非发起）经通知重跑，
    // 按基准 A 命中 A 的结果页。
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'ready')).toBe(true);
    expect(diskSessionSnapshot()!.wcRoot).toBe(wcA);
    expect(diskSessionSnapshot()?.binding).toBeNull();
    expect(lastHtml(reopened)).toContain(strings.diskPanel.metricReclaimable);
  });

  it('三段①：A 清理运行中（重检窗口）从 B fresh open → 绑定回 A 的清理中', async () => {
    const panel = await openDisk(wcA);
    await scanToReady(panel);
    queuePristine(() => pending<PristineStats>().promise);
    await confirmVacuum(panel);
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'cleaning')).toBe(true);
    panel.dispose();
    await openDisk(wcB);
    expect(diskSessionSnapshot()?.phase).toBe('cleaning');
    expect(diskSessionSnapshot()!.wcRoot).toBe(wcA);
  });

  it('三段②：缓存命中恢复结果页，subPath 刷新为本次打开路径、tableView 重置默认', async () => {
    const panel = await openDisk(wcA, join(wcA, 'sub-old'));
    await scanToReady(panel);
    send(panel, { kind: 'setSort', key: 'path', direction: 'asc' });
    await sleep(5);
    expect(diskSessionSnapshot()!.tableView.sortKey).toBe('path');
    panel.dispose();
    // 同副本另一子目录打开：结果数据照常恢复、页头刷新为本次打开位置。
    await openDisk(wcA, join(wcA, 'sub-new'));
    const state = diskSessionSnapshot()!;
    expect(state.phase).toBe('ready');
    expect(state.subPath).toBe(join(wcA, 'sub-new'));
    expect(state.total).toBe(2348);
    expect(state.tableView.sortKey).toBe('size');
    expect(state.tableView.page).toBe(1);
  });

  it('三段②：fresh open 跨副本打开 → 缓存 wcRoot 不一致丢弃、新副本全新 idle 会话', async () => {
    const panel = await openDisk(wcA);
    await scanToReady(panel);
    expect(readSessionResult('disk', { wcRoot: wcA })).toBeDefined();
    panel.dispose();
    await openDisk(wcB);
    const state = diskSessionSnapshot()!;
    expect(state.phase).toBe('idle');
    expect(state.wcRoot).toBe(wcB);
    expect(state.total).toBeNull();
    // 不一致缓存项被读侧丢弃（不残留）。
    expect(readSessionResult('disk', { wcRoot: wcA })).toBeUndefined();
  });

  it('三段③：vacuum unknown 记录分诊派生 cleanupUnknown 页（不经缓存承载）+ writeLocked', async () => {
    await presetRecord(makeRecord({ kind: 'vacuum', phase: 'unknown' }));
    const panel = await openDisk(wcA);
    expect(diskSessionSnapshot()?.phase).toBe('cleanupUnknown');
    expect(diskSessionSnapshot()?.writeLocked).toBe(true);
    expect(lastHtml(panel)).toContain(strings.diskPanel.cleanupUnknownBanner);
    // 不经缓存承载：关闭重开仍由记录分诊派生同一页。
    panel.dispose();
    await openDisk(wcA);
    expect(diskSessionSnapshot()?.phase).toBe('cleanupUnknown');
  });

  it('scanCanceled 缓存与 vacuum unknown 记录并存：缓存优先呈现、记录保留 writeLocked；rescan 完成按出口⑩终结', async () => {
    await presetRecord(makeRecord({ kind: 'vacuum', phase: 'unknown' }));
    const panel = await openDisk(wcA);
    expect(diskSessionSnapshot()?.phase).toBe('cleanupUnknown');
    // 该页点「重新检测」→ 扫描中取消（scanCanceled 写缓存、记录未终结）。
    queueScan(
      (options) =>
        new Promise<ScanDiskUsageResult>((resolve) => {
          if (options.signal?.aborted) {
            resolve(scanComplete({ phase: 'partial', partialReason: '扫描已取消，结果为已扫描部分' }));
            return;
          }
          options.signal?.addEventListener('abort', () => {
            resolve(scanComplete({ phase: 'partial', partialReason: '扫描已取消，结果为已扫描部分' }));
          }, { once: true });
        }),
    );
    send(panel, { kind: 'rescan' });
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'scanning')).toBe(true);
    send(panel, { kind: 'cancelScan' });
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'scanCanceled')).toBe(true);
    expect(vacuumRecords()).toHaveLength(1);
    // 关闭重开：②段缓存命中 scanCanceled（优先于③段记录分诊），writeLocked 照常生效。
    panel.dispose();
    await openDisk(wcA);
    expect(diskSessionSnapshot()?.phase).toBe('scanCanceled');
    expect(diskSessionSnapshot()?.writeLocked).toBe(true);
    // 再次 rescan 完成 → ready + 记录按出口⑩终结（unknown 也终结）。
    send(lastPanel(), { kind: 'rescan' });
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'ready')).toBe(true);
    expect(vacuumRecords()).toHaveLength(0);
    expect(diskSessionSnapshot()?.writeLocked).toBe(false);
  });

  it('重启标记：扫描进行中宿主中断 → 重启读到显示 scanCanceled 并一次性消费，再开不误报', async () => {
    queueScan(() => pending<ScanDiskUsageResult>().promise);
    const panel = await openDisk(wcA);
    send(panel, { kind: 'startScan' });
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'scanning')).toBe(true);
    expect(markerOf(wcA)).toBe(true);
    await simulateRestart();
    await openDisk(wcA);
    expect(diskSessionSnapshot()?.phase).toBe('scanCanceled');
    expect(markerOf(wcA)).toBeUndefined();
    // 消费一次后重开不误报（无缓存无记录 → idle）。
    lastPanel().dispose();
    await openDisk(wcA);
    expect(diskSessionSnapshot()?.phase).toBe('idle');
  });

  it('复测中断标记保留（复测扫描未结算即中断）→ 重启按 scanCanceled 呈现并消费', async () => {
    const panel = await openDisk(wcA);
    await scanToReady(panel);
    // 清理命令成功、复测扫描挂起（kill 形态：标记残留）。
    queueScan(() => pending<ScanDiskUsageResult>().promise);
    await confirmVacuum(panel);
    expect(await waitUntil(() => markerOf(wcA) === true)).toBe(true);
    await simulateRestart();
    await openDisk(wcA);
    expect(diskSessionSnapshot()?.phase).toBe('scanCanceled');
    expect(markerOf(wcA)).toBeUndefined();
  });

  it('标记与 vacuum unknown 记录并存：标记优先呈现、记录保留（重新分析完成时同时终结）', async () => {
    queueScan(() => pending<ScanDiskUsageResult>().promise);
    const panel = await openDisk(wcA);
    send(panel, { kind: 'startScan' });
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'scanning')).toBe(true);
    await presetRecord(makeRecord({ kind: 'vacuum', phase: 'unknown' }));
    await simulateRestart();
    await openDisk(wcA);
    // 标记优先：先 scanCanceled 并消费标记；记录不因呈现而消费。
    expect(diskSessionSnapshot()?.phase).toBe('scanCanceled');
    expect(diskSessionSnapshot()?.writeLocked).toBe(true);
    expect(vacuumRecords()).toHaveLength(1);
    // 重新分析完成 → 同时终结 vacuum 记录并转 ready。
    send(lastPanel(), { kind: 'rescan' });
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'ready')).toBe(true);
    expect(vacuumRecords()).toHaveLength(0);
  });
});

/* ------------------------------ 占用与换副本 ------------------------------ */

describe('P4 磁盘面板 flow：占用新鲜度与换副本', () => {
  it('跨面板占用的新鲜度：另一面板 begin 后 busy 命中，下一次 intent 即重算（startScan 被拒）；结束后恢复可用', async () => {
    const panel = await openDisk(wcA);
    send(panel, { kind: 'startScan' });
    // 先完成本副本扫描（ready 页）。
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'ready')).toBe(true);
    // 另一面板对同副本发起 M2 提交（运行登记命中 hasRunning）。
    const external = await getOperationRegistry().begin({
      wcRoot: wcA, targetRelPath: '.', nodeKind: 'dir', kind: 'commit',
    });
    expect(external.ok).toBe(true);
    // 下一次 intent 触发占用重算与整帧重推：busy 期间重新分析与清理入口
    // 双双禁用（DOM 与宿主守卫同一合取——按钮 disabled 原因同源呈现）。
    send(panel, { kind: 'setPage', page: 1 });
    await sleep(5);
    let html = lastHtml(panel);
    expect(html).toContain(strings.diskPanel.scanBusyReason);
    expect(html).toContain(strings.diskPanel.vacuumReasonBusy);
    // startScan 被宿主守卫拒绝（busy 行不放行）。
    send(panel, { kind: 'startScan' });
    await sleep(5);
    expect(toastMessages(panel).at(-1)).toBe(strings.panel.toastBusyRejected);
    // 占用结束 → 下一次 intent 重算恢复可用。
    await getOperationRegistry().finish(external.ok ? external.operationId : undefined);
    send(panel, { kind: 'setPage', page: 1 });
    await sleep(5);
    html = lastHtml(panel);
    expect(html).not.toContain(strings.diskPanel.scanBusyReason);
    send(panel, { kind: 'rescan' });
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'scanning')).toBe(true);
  });

  it('M2 unknown（writeRestriction 命中、非运行登记）：busy=false、writeLocked=true，startScan 放行、confirmVacuum 被拒', async () => {
    const begin = await getOperationRegistry().begin({
      wcRoot: wcA, targetRelPath: '.', nodeKind: 'dir', kind: 'commit',
    });
    expect(begin.ok).toBe(true);
    if (begin.ok) {
      await getOperationRegistry().markPhase(begin.operationId, 'unknown');
    }
    const panel = await openDisk(wcA);
    const state = diskSessionSnapshot()!;
    expect(state.busy).toBe(false);
    expect(state.writeLocked).toBe(true);
    // writeLocked 行放行 startScan（重新检测/只读分析不受写锁限制）。
    send(panel, { kind: 'startScan' });
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'ready')).toBe(true);
    // writeLocked 行拒绝 confirmVacuum（含按钮禁用同源文案）。
    send(panel, { kind: 'confirmVacuum' });
    await sleep(5);
    expect(toastMessages(panel).at(-1)).toBe(strings.panel.toastBusyRejected);
    expect(lastHtml(panel)).toContain(strings.diskPanel.vacuumReasonLockCommit);
    if (begin.ok) {
      await getOperationRegistry().finish(begin.operationId);
    }
  });

  it('writeLocked 命中记录按 kind 分列文案（commit/ignore/vacuum/checkout）', async () => {
    const cases: Array<{ kind: 'commit' | 'ignore' | 'vacuum' | 'checkout'; text: string }> = [
      { kind: 'commit', text: strings.diskPanel.vacuumReasonLockCommit },
      { kind: 'ignore', text: strings.diskPanel.vacuumReasonLockIgnore },
      { kind: 'vacuum', text: strings.diskPanel.vacuumReasonLockVacuum },
      { kind: 'checkout', text: strings.diskPanel.vacuumReasonLockCheckout },
    ];
    for (const item of cases) {
      // 先扫描到 ready（避免「重新检测完成即终结 vacuum 记录」把预置记录
      // 收口——writeLocked 呈现须在检测结果就位之后预置）。
      const panel = await openDisk(wcA);
      await scanToReady(panel);
      const begin = await getOperationRegistry().begin({
        wcRoot: wcA, targetRelPath: '.', nodeKind: 'dir', kind: item.kind,
      });
      expect(begin.ok).toBe(true);
      if (begin.ok) {
        if (item.kind === 'checkout') {
          // checkout 的限制写相位与在途集合同集：先转 running 再清运行登记，
          // 构造「记录仍限制写但不在途」的防御形态（busy 不先判、落到
          // writeLocked 原因行）。
          await getOperationRegistry().markPhase(begin.operationId, 'running');
          resetRunningOperationsForTest();
        } else {
          await getOperationRegistry().markPhase(begin.operationId, 'unknown');
        }
      }
      // 任一 intent 触发占用重算与整帧重推（渲染与守卫同一分列文案）。
      send(panel, { kind: 'setPage', page: 1 });
      await sleep(5);
      const html = lastHtml(panel);
      expect(html).toContain(item.text);
      panel.dispose();
      resetDiskPanelController();
      if (begin.ok) {
        await getOperationRegistry().finish(begin.operationId);
      }
    }
  });

  it('换副本：结果态确认放弃后建立新副本 idle 会话；取消保持当前结果页', async () => {
    const panel = await openDisk(wcA);
    await scanToReady(panel);
    vscodeMock.confirmResult = undefined;
    await openDiskPanel({ wcRoot: wcB, subPath: wcB });
    expect(diskSessionSnapshot()?.phase).toBe('ready');
    expect(diskSessionSnapshot()?.wcRoot).toBe(wcA);
    vscodeMock.confirmResult = strings.panel.switchDiscardButton;
    await openDiskPanel({ wcRoot: wcB, subPath: wcB });
    expect(diskSessionSnapshot()?.phase).toBe('idle');
    expect(diskSessionSnapshot()?.wcRoot).toBe(wcB);
    // 确认放弃清缓存（旧副本结果页不再恢复）。
    expect(readSessionResult('disk', { wcRoot: wcA })).toBeUndefined();
    void panel;
  });

  it('cleanupUnknown（vacuum unknown 记录未决）拒绝换副本：重新检测完成后恢复可切换', async () => {
    await presetRecord(makeRecord({ kind: 'vacuum', phase: 'unknown' }));
    const panel = await openDisk(wcA);
    expect(diskSessionSnapshot()?.phase).toBe('cleanupUnknown');
    vscodeMock.confirmResult = strings.panel.switchDiscardButton;
    await openDiskPanel({ wcRoot: wcB, subPath: wcB });
    expect(toastMessages(panel).at(-1)).toContain('清理结果未知');
    expect(diskSessionSnapshot()?.wcRoot).toBe(wcA);
    // 重新检测完成 → 记录终结、恢复可切换。
    send(panel, { kind: 'rescan' });
    expect(await waitUntil(() => diskSessionSnapshot()?.phase === 'ready')).toBe(true);
    await openDiskPanel({ wcRoot: wcB, subPath: wcB });
    expect(diskSessionSnapshot()?.wcRoot).toBe(wcB);
  });
});
