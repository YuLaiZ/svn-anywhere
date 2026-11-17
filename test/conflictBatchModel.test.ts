/**
 * P7 批量冲突模型（conflictBatchModel.ts）与批量执行器
 * （panels/conflicts.ts runBatchTask）测试。
 *
 * 第一部分：纯模型单测——路径分组计划（可执行/不适用/推迟）、wcLocked
 * 与共享写锁的禁写原因、批量结果页（停止位置/未执行/回扫状态）、
 * 会话持久化形状与渲染规格。
 *
 * 第二部分：真实 `svnadmin + file://` lab（不 mock SVN 命令层）驱动
 * 面板控制器：批量成功、首项失败停止（余项未执行）、外部改动导致指纹
 * 变化后停止、失败后旧计划作废且必须重新扫描才能重跑、关闭重开恢复
 * 结果页、不适用项（属性冲突）不进入执行。wcLocked 的整体禁写在纯模型
 * 与 mock 面板测试覆盖（真实 SVN 的 wc-locked 需要中断进程制造，
 * 不在本文件覆盖）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import {
  mergeResolvedLedger,
  summarizeConflicts,
  type ConflictRecord,
  type PostponedConflictEntry,
} from '../src/core/conflict';
import {
  CONFLICT_BATCH_TEXT_DEFAULTS,
  buildConflictBatchSpec,
  createConflictBatchResult,
  isConflictBatchPersistState,
  planConflictBatch,
  settleConflictBatchResult,
  summarizeConflictBatchResult,
  type ConflictBatchScope,
} from '../src/host/panel/conflictBatchModel';

/* ================================================================================
 * 第一部分：纯模型
 * ================================================================================ */

let idSeq = 0;

function makeRecord(overrides: Partial<ConflictRecord> & { path: string }): ConflictRecord {
  idSeq += 1;
  const record = {
    id: overrides.id ?? `id-${overrides.path}-${idSeq}`,
    path: overrides.path,
    kinds: overrides.kinds ?? ['text'],
    contentKind: overrides.contentKind ?? 'text',
    artifacts: overrides.artifacts ?? [],
  } as ConflictRecord;
  return Object.assign(record, overrides);
}

const SCOPE: ConflictBatchScope = { wcRoot: '/wc', scopeRelPath: '.' };

function planFor(
  records: ConflictRecord[],
  extra: Partial<Parameters<typeof planConflictBatch>[0]> = {},
) {
  return planConflictBatch({
    planId: 'plan-1',
    scope: SCOPE,
    rows: mergeResolvedLedger(records, []),
    wcLocked: false,
    strategy: 'theirs-full',
    now: () => 100,
    ...extra,
  });
}

describe('planConflictBatch：路径分组计划', () => {
  it('文件冲突（文本/二进制）进可执行组；属性/树/混合/保留属性/未知类型进不适用', () => {
    const text = makeRecord({ path: 'a.txt' });
    const binary = makeRecord({ path: 'b.bin', contentKind: 'binary' });
    const property = makeRecord({
      path: 'p.txt',
      kinds: ['property'],
      propertyConflicts: [{
        name: 'k',
        local: { exists: true, value: Buffer.from('l') },
        base: { exists: true, value: Buffer.from('b') },
        incoming: { exists: true, value: Buffer.from('i') },
        autoUnsupported: false,
      }],
    });
    const reserved = makeRecord({
      path: 'svn-prop.txt',
      kinds: ['property'],
      propertyConflicts: [{
        name: 'svn:mergeinfo',
        local: { exists: true, value: Buffer.from('l') },
        base: { exists: false },
        incoming: { exists: true, value: Buffer.from('i') },
        autoUnsupported: true,
      }],
    });
    const tree = makeRecord({ path: 'tree.txt', kinds: ['tree'] });
    const mixed = makeRecord({
      path: 'mixed.txt',
      kinds: ['text', 'property'],
      propertyConflicts: [{
        name: 'm',
        local: { exists: true, value: Buffer.from('l') },
        base: { exists: true, value: Buffer.from('b') },
        incoming: { exists: true, value: Buffer.from('i') },
        autoUnsupported: false,
      }],
    });
    const unknownContent = makeRecord({ path: 'unknown.dat', contentKind: 'unknown' });
    const plan = planFor([text, binary, property, reserved, tree, mixed, unknownContent]);
    expect(plan.applicable.map((item) => item.path)).toEqual(['a.txt', 'b.bin']);
    expect(plan.applicable.every((item) => item.strategy === 'theirs-full')).toBe(true);
    const reasons = Object.fromEntries(plan.unsupported.map((item) => [item.path, item.reason]));
    expect(reasons).toEqual({
      'p.txt': 'property',
      'svn-prop.txt': 'auto-unsupported',
      'tree.txt': 'tree',
      'mixed.txt': 'mixed-path',
      'unknown.dat': 'unknown-content',
    });
    expect(plan.postponed).toEqual([]);
    expect(plan.writeBlocked).toBe(false);
    expect(plan.writeBlockedReason).toBeUndefined();
  });

  it('同路径多条单类型记录按同路径混合整组不执行', () => {
    const a = makeRecord({ path: 'dup.txt', kinds: ['text'], id: 'id-a' });
    const b = makeRecord({ path: 'dup.txt', kinds: ['tree'], id: 'id-b' });
    const plan = planFor([a, b]);
    expect(plan.applicable).toHaveLength(0);
    expect(plan.unsupported.map((item) => item.reason)).toEqual(['mixed-path', 'mixed-path']);
  });

  it('推迟项保留在推迟组（不执行、不改状态）；已解决行不进计划', () => {
    const postponed: PostponedConflictEntry[] = [];
    const text = makeRecord({ path: 'postponed.txt' });
    postponed.push({ fingerprint: text.id, path: text.path, kinds: [...text.kinds] });
    // 已解决行只存在于台账（真实扫描不再报告）：不进入任何计划分组。
    const rows = mergeResolvedLedger(
      [text],
      [{
        fingerprint: 'ledger-done',
        path: 'done.txt',
        kinds: ['text'],
        strategy: 'theirs-full',
        operationId: 'op-done',
        resolvedAt: 1,
      }],
      postponed,
    );
    expect(rows.some((row) => row.path === 'done.txt' && row.status === 'resolved')).toBe(true);
    const plan = planConflictBatch({
      planId: 'plan-2',
      scope: SCOPE,
      rows,
      wcLocked: false,
      strategy: 'mine-full',
    });
    expect(plan.applicable).toHaveLength(0);
    expect(plan.unsupported).toHaveLength(0);
    expect(plan.postponed).toEqual([{
      key: text.id,
      path: 'postponed.txt',
      kinds: ['text'],
    }]);
  });

  it('待核实项进不适用组（unknown-state），不执行', () => {
    const pending = makeRecord({ path: 'unknown.txt' });
    const plan = planFor([pending], { unknownKeys: new Set([pending.id]) });
    expect(plan.applicable).toHaveLength(0);
    expect(plan.unsupported[0]).toMatchObject({
      path: 'unknown.txt',
      reason: 'unknown-state',
    });
    expect(plan.unsupported[0].reasonText).toBe(CONFLICT_BATCH_TEXT_DEFAULTS.batchUnsupportedUnknownState);
  });

  it('wcLocked 整体禁写且原因为 wc-locked；共享写锁为 write-locked', () => {
    const text = makeRecord({ path: 'a.txt' });
    const locked = planFor([text], { wcLocked: true });
    expect(locked.writeBlocked).toBe(true);
    expect(locked.writeBlockedReason).toBe('wc-locked');
    expect(locked.applicable).toHaveLength(1);
    const held = planFor([text], { writeLocked: true });
    expect(held.writeBlocked).toBe(true);
    expect(held.writeBlockedReason).toBe('write-locked');
    // wcLocked 优先于共享写锁。
    const both = planFor([text], { wcLocked: true, writeLocked: true });
    expect(both.writeBlockedReason).toBe('wc-locked');
  });
});

describe('批量结果页模型', () => {
  const textA = makeRecord({ path: 'a.txt' });
  const textB = makeRecord({ path: 'b.txt' });

  it('结果初始只含可执行项且全部 pending', () => {
    const plan = planFor([textA, textB]);
    const result = createConflictBatchResult(plan, () => 10);
    expect(result.items.map((item) => [item.path, item.state])).toEqual([
      ['a.txt', 'pending'],
      ['b.txt', 'pending'],
    ]);
    expect(result.failed).toBe(false);
    expect(result.planInvalidated).toBe(false);
    expect(result.rescan.outcome).toBe('pending');
  });

  it('全部成功：failed=false 且不记录停止位置', () => {
    const plan = planFor([textA, textB]);
    const result = createConflictBatchResult(plan);
    result.items[0].state = 'resolved';
    result.items[1].state = 'resolved';
    settleConflictBatchResult(result, undefined, () => 20);
    expect(result.failed).toBe(false);
    expect(result.planInvalidated).toBe(false);
    expect(result.stoppedIndex).toBeUndefined();
    expect(result.finishedAt).toBe(20);
  });

  it('首项失败停止：记录停止位置，剩余项标记未执行，旧计划作废', () => {
    const plan = planFor([textA, textB]);
    const result = createConflictBatchResult(plan);
    result.items[0].state = 'failed';
    result.items[0].detail = '指纹变化';
    settleConflictBatchResult(result, { index: 0, reason: '指纹变化' });
    expect(result.failed).toBe(true);
    expect(result.planInvalidated).toBe(true);
    expect(result.stoppedIndex).toBe(0);
    expect(result.stoppedPath).toBe('a.txt');
    expect(result.stopReason).toBe('指纹变化');
    expect(result.items[1].state).toBe('not-run');
    expect(summarizeConflictBatchResult(result)).toMatchObject({ failed: 1, notRun: 1, resolved: 0 });
  });

  it('无停止但存在未完成项（异常路径）同样判定失败并作废计划', () => {
    const plan = planFor([textA, textB]);
    const result = createConflictBatchResult(plan);
    result.items[0].state = 'resolved';
    settleConflictBatchResult(result, undefined);
    expect(result.failed).toBe(true);
    expect(result.planInvalidated).toBe(true);
    expect(result.items[1].state).toBe('not-run');
  });

  it('持久化形状校验：合法计划/结果通过，未知版本或残缺形状拒绝', () => {
    const plan = planFor([textA]);
    const result = createConflictBatchResult(plan);
    expect(isConflictBatchPersistState({ version: 1, mode: 'plan', plan })).toBe(true);
    expect(isConflictBatchPersistState({ version: 1, mode: 'results', plan, result })).toBe(true);
    expect(isConflictBatchPersistState({ version: 2, mode: 'plan', plan })).toBe(false);
    expect(isConflictBatchPersistState({ version: 1, mode: 'other', plan })).toBe(false);
    expect(isConflictBatchPersistState({ version: 1, mode: 'plan' })).toBe(false);
    expect(isConflictBatchPersistState({ version: 1, mode: 'plan', plan: { planId: 1 } })).toBe(false);
  });
});

describe('buildConflictBatchSpec：计划/结果渲染规格', () => {
  const textA = makeRecord({ path: 'a.txt' });

  it('计划页：概要/策略按钮/三组与开始动作；策略与计数来自计划', () => {
    const plan = planFor([textA]);
    const spec = buildConflictBatchSpec({ plan, mode: 'plan' });
    expect(spec).toBeDefined();
    expect(spec!.mode).toBe('plan');
    expect(spec!.heading).toBe(CONFLICT_BATCH_TEXT_DEFAULTS.batchPlanHeading);
    expect(spec!.summary).toEqual([
      { label: CONFLICT_BATCH_TEXT_DEFAULTS.batchSummaryRoot, value: '/wc', mono: true },
      { label: CONFLICT_BATCH_TEXT_DEFAULTS.batchSummaryScope, value: CONFLICT_BATCH_TEXT_DEFAULTS.batchScopeWhole, mono: true },
      { label: CONFLICT_BATCH_TEXT_DEFAULTS.batchSummaryStrategy, value: CONFLICT_BATCH_TEXT_DEFAULTS.batchStrategyTheirs },
    ]);
    expect(spec!.strategies.map((choice) => [choice.value, choice.selected])).toEqual([
      ['theirs-full', true],
      ['mine-full', false],
    ]);
    expect(spec!.groups.find((group) => group.id === 'applicable')?.title)
      .toBe('将执行（1）');
    expect(spec!.groups.find((group) => group.id === 'applicable')?.items[0]).toEqual({
      path: 'a.txt',
      note: '整文件策略 使用传入内容（仅文件冲突）',
    });
    const start = spec!.actions.find((action) => action.id === 'startConflictBatch');
    expect(start?.disabled).toBe(false);
  });

  it('计划页：不可执行项、wcLocked 或计划作废时开始动作禁用并带原因', () => {
    const property = makeRecord({
      path: 'p.txt',
      kinds: ['property'],
      propertyConflicts: [],
    });
    const noApplicable = buildConflictBatchSpec({ plan: planFor([property]), mode: 'plan' });
    const startNoApplicable = noApplicable!.actions.find((action) => action.id === 'startConflictBatch');
    expect(startNoApplicable?.disabled).toBe(true);
    expect(startNoApplicable?.disabledReason).toBe(CONFLICT_BATCH_TEXT_DEFAULTS.batchStartDisabledNoApplicable);

    const locked = planFor([textA], { wcLocked: true });
    const lockedSpec = buildConflictBatchSpec({ plan: locked, mode: 'plan' });
    expect(lockedSpec!.blockedReason).toBe(CONFLICT_BATCH_TEXT_DEFAULTS.batchBlockedWcLocked);
    expect(lockedSpec!.actions.find((action) => action.id === 'startConflictBatch')?.disabled).toBe(true);

    const invalidatedPlan = planFor([textA]);
    const invalidated = createConflictBatchResult(invalidatedPlan);
    invalidated.planInvalidated = true;
    const invalidatedSpec = buildConflictBatchSpec({ plan: invalidatedPlan, result: invalidated, mode: 'plan' });
    expect(invalidatedSpec!.blockedReason).toBe(CONFLICT_BATCH_TEXT_DEFAULTS.batchPlanInvalidated);
    expect(invalidatedSpec!.actions.find((action) => action.id === 'startConflictBatch')?.disabled).toBe(true);
  });

  it('结果页：chips、停止位置、回扫状态与逐项状态标签', () => {
    const plan = planFor([textA]);
    const result = createConflictBatchResult(plan);
    result.items[0].state = 'resolved';
    result.stoppedIndex = 0;
    result.stoppedPath = 'a.txt';
    result.stopReason = '示例原因';
    result.failed = true;
    result.planInvalidated = true;
    result.rescan = { outcome: 'scanned', summary: summarizeConflicts([]) };
    const spec = buildConflictBatchSpec({ result, mode: 'results', remaining: 0 });
    expect(spec!.mode).toBe('results');
    expect(spec!.results!.chips.map((chip) => chip.label)).toEqual(['已解决 1', '仍冲突 0']);
    expect(spec!.results!.stoppedNote).toContain('在第 1/1 项停止：a.txt');
    expect(spec!.results!.stoppedNote).toContain('示例原因');
    expect(spec!.results!.rescanNote).toBe('最终范围回扫完成：仍冲突 0 项。');
    expect(spec!.results!.items[0]).toMatchObject({
      path: 'a.txt',
      state: 'resolved',
      stateLabel: '已解决（使用传入内容（仅文件冲突））',
    });

    result.rescan = { outcome: 'failed', message: '权限不足' };
    const failed = buildConflictBatchSpec({ result, mode: 'results' });
    expect(failed!.results!.rescanNote).toBe('最终范围未核实：权限不足');
  });

  it('无计划也无结果时不渲染批量区', () => {
    expect(buildConflictBatchSpec({ mode: 'plan' })).toBeUndefined();
  });
});

/* ================================================================================
 * 第二部分：真实 svn file:// lab 驱动批量执行器
 * ================================================================================ */

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
    createOutputChannel: () => ({
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

async function waitFor(check: () => boolean, attempts = 2000, interval = 10): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (check()) {
      return;
    }
    await delay(interval);
  }
  expect(check()).toBe(true);
}

/* ------------------------------ 模块导入（mock vscode 之后） ------------------------------ */

import {
  OperationRegistry,
  getOperationRegistry,
  setOperationRegistryForTest,
} from '../src/core/operations';
import { resetOutputState } from '../src/host/output';
import { resetPanelRegistry } from '../src/host/panel/host';
import {
  conflictsModelForTest,
  conflictsSessionSnapshot,
  openConflictPanel,
  resetConflictPanelController,
  setConflictPanelContext,
} from '../src/host/panel/panels/conflicts';
import { resetM4SessionStore, resetSessionResults } from '../src/host/sessionResults';
import { hasActiveTask, resetTaskRegistry } from '../src/host/taskRegistry';
import { createSvnLab, writeFile, type SvnLab } from './helpers';

async function waitIdle(): Promise<void> {
  await waitFor(() => !hasActiveTask('conflicts'));
  await delay(0);
}

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
}

function resetController(): void {
  resetConflictPanelController();
  resetPanelRegistry();
  resetTaskRegistry();
  resetSessionResults();
  resetM4SessionStore();
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
}

function sendIntent(intent: Record<string, unknown>): Promise<void> {
  return fakePanel().sendIntent(intent).then(() => delay(0));
}

async function openAndScan(wcRoot: string): Promise<void> {
  await openConflictPanel({ source: 'local', wcRoot, scopeRelPath: '.' });
  await waitIdle();
}

async function planBatch(strategy = 'theirs-full'): Promise<void> {
  await sendIntent({ kind: 'planConflictBatch', strategy });
}

async function startBatch(): Promise<void> {
  await sendIntent({ kind: 'startConflictBatch' });
  await waitIdle();
}

/* ------------------------------ 仓库构造 ------------------------------ */

const TEXT_BASE = 'line1\nline2\nline3\n';

function commitBase(lab: SvnLab, files: Array<{ path: string; content: string }>): string {
  const wc0 = lab.checkout('wc0');
  for (const file of files) {
    writeFile(wc0, file.path, file.content, true);
  }
  lab.svn(['commit', '-q', '-m', 'base'], wc0);
  return wc0;
}

/** 多文件文本冲突：双方改同一行。 */
function buildTextConflicts(lab: SvnLab, paths: string[]): string {
  commitBase(lab, paths.map((path) => ({ path, content: TEXT_BASE })));
  const wc1 = lab.checkout('wc1');
  const wc2 = lab.checkout('wc2');
  for (const path of paths) {
    writeFile(wc1, path, 'line1-theirs\nline2\nline3\n');
  }
  lab.svn(['commit', '-q', '-m', 'incoming'], wc1);
  for (const path of paths) {
    writeFile(wc2, path, 'line1-local\nline2\nline3\n');
  }
  lab.svn(['update'], wc2);
  return wc2;
}

/** 属性冲突：双方改同一属性（批量不适用项）；wc2 为已存在副本。 */
function addPropertyConflict(lab: SvnLab, wc2: string): void {
  const wc0 = lab.checkout('wc3');
  writeFile(wc0, 'prop.txt', 'prop content\n', true);
  lab.svn(['commit', '-q', '-m', 'base prop file'], wc0);
  lab.svn(['propset', '-q', 'k', 'base', 'prop.txt'], wc0);
  lab.svn(['commit', '-q', '-m', 'base prop'], wc0);
  // wc2 先同步到 base（含 prop.txt 与基线属性），再本地修改。
  lab.svn(['update'], wc2);
  const wc1 = lab.checkout('wc4');
  lab.svn(['propset', '-q', 'k', 'theirs', 'prop.txt'], wc1);
  lab.svn(['commit', '-q', '-m', 'incoming prop'], wc1);
  lab.svn(['propset', '-q', 'k', 'local', 'prop.txt'], wc2);
  lab.svn(['update'], wc2);
}

function readText(wc: string, path: string): string {
  return readFileSync(join(wc, path), 'utf8');
}

/**
 * 取 `svn status --xml` 中指定路径的 entry 片段（status 输出截断与
 * 冲突标记的防假通过口径）：
 * - entry 未闭合 → 输出被截断，直接抛断言错误；
 * - marker 缺失本身不是缺陷证据（resolve 后内容与更新后的 BASE 相同，
 *   路径会从 status 输出中消失）：只有 `svn diff` 能证明该路径内容与
 *   属性都与 BASE 完全一致（干净，不可能有冲突）时才返回 undefined；
 *   否则说明路径形态变化或输出截断，抛断言错误而不是静默当作无冲突。
 */
function statusEntryOf(lab: SvnLab, wc: string, path: string): string | undefined {
  const xml = lab.svn(['status', '--xml', '--ignore-externals'], wc);
  const marker = `path="${path}"`;
  const index = xml.indexOf(marker);
  if (index < 0) {
    const diff = lab.svn(['diff', '--', path], wc);
    if (diff.trim() === '') {
      return undefined;
    }
    throw new Error(`svn status --xml 输出缺少 ${marker} 且 svn diff 仍有变化：路径形态变化或输出被截断，无法判定冲突状态`);
  }
  const end = xml.indexOf('</entry>', index);
  if (end < 0) {
    throw new Error(`svn status --xml 输出中 ${marker} 的 entry 未闭合：输出被截断，无法判定冲突状态`);
  }
  return xml.slice(index, end);
}

/** `svn status --xml` 中 props=conflicted 是否仍存在（干净路径视为无冲突）。 */
function propertyStillConflicted(lab: SvnLab, wc: string, path: string): boolean {
  const entry = statusEntryOf(lab, wc, path);
  return entry !== undefined && /props="conflicted"/.test(entry);
}

/** `svn status --xml` 是否仍把路径报告为任意类型冲突（干净路径视为无冲突）。 */
function stillConflicted(lab: SvnLab, wc: string, path: string): boolean {
  const entry = statusEntryOf(lab, wc, path);
  return entry !== undefined
    && (/item="conflicted"/.test(entry) || /props="conflicted"/.test(entry) || /tree-conflicted="true"/.test(entry));
}

/* ------------------------------ 真实 lab 用例 ------------------------------ */

describe('批量执行器（真实 svn file:// lab）', () => {
  const labs: SvnLab[] = [];

  function makeLab(prefix: string): SvnLab {
    const lab = createSvnLab(prefix);
    labs.push(lab);
    return lab;
  }

  afterEach(() => {
    resetController();
    setOperationRegistryForTest(undefined);
    for (const lab of labs.splice(0)) {
      lab.cleanup();
    }
  });

  it('批量成功：逐项 begin/resolve/回读/收口，最终整范围回扫清空列表并写台账', async () => {
    const lab = makeLab('svn-anywhere-batch-ok-');
    const wcRoot = buildTextConflicts(lab, ['a.txt', 'b.txt']);
    setup();
    await openAndScan(wcRoot);
    expect(conflictsSessionSnapshot().rows).toBe(2);

    await planBatch('theirs-full');
    let snapshot = conflictsSessionSnapshot();
    expect(snapshot.batch).toMatchObject({
      mode: 'plan',
      applicable: 2,
      unsupported: 0,
      postponed: 0,
      writeBlocked: false,
    });
    expect(fakePanel().latestRenderHtml()).toContain(CONFLICT_BATCH_TEXT_DEFAULTS.batchPlanHeading);
    expect(fakePanel().latestRenderHtml()).toContain('a.txt');

    await startBatch();
    snapshot = conflictsSessionSnapshot();
    expect(snapshot.batch).toMatchObject({
      mode: 'results',
      items: 2,
      resolved: 2,
      failed: 0,
      notRun: 0,
      planInvalidated: false,
      rescan: 'scanned',
    });
    // 未解决计数清空；已解决项以台账行保留在列表中（不伪造「消失=解决」）。
    expect(conflictsModelForTest()?.summary().total).toBe(0);
    expect(conflictsModelForTest()?.tabCounts().all).toBe(0);
    expect(snapshot.ledger).toBe(2);
    expect(hasActiveTask('conflicts')).toBe(false);
    // 真实工作副本：theirs-full 后无冲突标记，内容为传入版本。
    expect(readText(wcRoot, 'a.txt')).toBe('line1-theirs\nline2\nline3\n');
    expect(readText(wcRoot, 'b.txt')).toBe('line1-theirs\nline2\nline3\n');
    expect(stillConflicted(lab, wcRoot, 'a.txt')).toBe(false);
    expect(stillConflicted(lab, wcRoot, 'b.txt')).toBe(false);
    // 结果页文案与摘要。
    expect(fakePanel().latestRenderHtml()).toContain(CONFLICT_BATCH_TEXT_DEFAULTS.batchResultsHeading);
    expect(fakePanel().latestRenderHtml()).toContain('已解决 2');
    // operation record 全部 done 并清理，无写锁残留。
    expect(getOperationRegistry().writeRestriction(wcRoot)).toBeUndefined();
  });

  it('首项失败停止：外部已解决的首项被指纹重读拒绝，余项未执行且不自动续跑', async () => {
    const lab = makeLab('svn-anywhere-batch-stop-');
    const wcRoot = buildTextConflicts(lab, ['a.txt', 'b.txt', 'c.txt']);
    setup();
    await openAndScan(wcRoot);
    await planBatch('theirs-full');
    expect(conflictsSessionSnapshot().batch?.applicable).toBe(3);

    // 计划生成后、开始前外部解决首项：旧计划不得按过期范围继续写。
    lab.svn(['resolve', '--non-interactive', '--accept', 'theirs-full', 'a.txt'], wcRoot);
    await startBatch();
    const snapshot = conflictsSessionSnapshot();
    expect(snapshot.batch).toMatchObject({
      items: 3,
      resolved: 0,
      failed: 1,
      notRun: 2,
      stoppedIndex: 0,
      planInvalidated: true,
      rescan: 'scanned',
    });
    expect(snapshot.batch?.stopReason).toContain('冲突状态在读取后发生变化');
    // 余项未被写入：b/c 保持本地内容与冲突状态。
    expect(readText(wcRoot, 'b.txt')).toContain('<<<<<<< .mine');
    expect(readText(wcRoot, 'c.txt')).toContain('<<<<<<< .mine');
    expect(stillConflicted(lab, wcRoot, 'b.txt')).toBe(true);
    expect(stillConflicted(lab, wcRoot, 'c.txt')).toBe(true);

    // 旧计划已作废：再次 start 被拒绝，不发任何写命令。批量结束后的最终
    // 回扫已清空计划，开始入口只能基于新生成的计划。
    const before = readText(wcRoot, 'b.txt');
    await sendIntent({ kind: 'startConflictBatch' });
    await delay(20);
    expect(fakePanel().toasts().some((message) => message.includes('请先生成批量处理计划'))).toBe(true);
    expect(readText(wcRoot, 'b.txt')).toBe(before);
  });

  it('失败后旧计划作废：重新扫描后才可生成新计划并解决剩余项', async () => {
    const lab = makeLab('svn-anywhere-batch-rescan-');
    const wcRoot = buildTextConflicts(lab, ['a.txt', 'b.txt']);
    setup();
    await openAndScan(wcRoot);
    await planBatch('theirs-full');
    lab.svn(['resolve', '--non-interactive', '--accept', 'theirs-full', 'a.txt'], wcRoot);
    await startBatch();
    expect(conflictsSessionSnapshot().batch?.planInvalidated).toBe(true);

    // 新扫描：旧计划被清空（结果记录保留），列表以真实 status/info 为准。
    await sendIntent({ kind: 'rescanConflicts', scope: 'task' });
    await waitIdle();
    let snapshot = conflictsSessionSnapshot();
    expect(snapshot.rows).toBe(1);
    expect(snapshot.batch?.applicable).toBe(0);
    expect(snapshot.batch?.items).toBe(2);

    // 重新生成计划（只剩 b.txt）并执行：旧计划未续跑，新计划成功。
    await planBatch('mine-full');
    snapshot = conflictsSessionSnapshot();
    expect(snapshot.batch).toMatchObject({ applicable: 1, mode: 'plan' });
    await startBatch();
    snapshot = conflictsSessionSnapshot();
    expect(snapshot.batch).toMatchObject({ resolved: 1, failed: 0, rescan: 'scanned' });
    expect(conflictsModelForTest()?.summary().total).toBe(0);
    expect(snapshot.ledger).toBe(1);
    expect(readText(wcRoot, 'b.txt')).toBe('line1-local\nline2\nline3\n');
  });

  it('关闭重开恢复：批量结果页从 m4SessionStore 恢复，不自动重扫', async () => {
    const lab = makeLab('svn-anywhere-batch-reopen-');
    const wcRoot = buildTextConflicts(lab, ['a.txt']);
    setup();
    await openAndScan(wcRoot);
    await planBatch('theirs-full');
    await startBatch();
    expect(conflictsSessionSnapshot().batch?.resolved).toBe(1);

    fakePanel().dispose();
    await openConflictPanel({ source: 'local', wcRoot, scopeRelPath: '.' });
    await delay(20);
    const snapshot = conflictsSessionSnapshot();
    expect(snapshot.batch).toMatchObject({
      mode: 'results',
      resolved: 1,
      failed: 0,
      rescan: 'scanned',
    });
    expect(fakePanel().latestRenderHtml()).toContain(CONFLICT_BATCH_TEXT_DEFAULTS.batchResultsHeading);
  });

  it('不适用项不进执行：属性冲突保留在列表中，只有文件冲突被执行', async () => {
    const lab = makeLab('svn-anywhere-batch-unsupported-');
    const wcRoot = buildTextConflicts(lab, ['a.txt']);
    addPropertyConflict(lab, wcRoot);
    setup();
    await openAndScan(wcRoot);
    const model = conflictsModelForTest()!;
    const summaryBefore = model.summary();
    expect(summaryBefore.text).toBe(1);
    expect(summaryBefore.property).toBe(1);

    await planBatch('theirs-full');
    const planSnapshot = conflictsSessionSnapshot();
    expect(planSnapshot.batch).toMatchObject({ applicable: 1, unsupported: 1 });
    expect(fakePanel().latestRenderHtml()).toContain(CONFLICT_BATCH_TEXT_DEFAULTS.batchUnsupportedProperty);

    await startBatch();
    const snapshot = conflictsSessionSnapshot();
    expect(snapshot.batch).toMatchObject({ resolved: 1, failed: 0, rescan: 'scanned' });
    // 文件冲突解决（台账行保留）；属性冲突仍在列表与工作副本中（未被批量执行）。
    expect(stillConflicted(lab, wcRoot, 'a.txt')).toBe(false);
    expect(stillConflicted(lab, wcRoot, 'prop.txt')).toBe(true);
    expect(propertyStillConflicted(lab, wcRoot, 'prop.txt')).toBe(true);
    expect(conflictsModelForTest()?.summary()).toMatchObject({ total: 1, property: 1 });
    expect(snapshot.ledger).toBe(1);
  });

  it('计划页渲染工作副本根、范围与策略；策略切换重新生成计划', async () => {
    const lab = makeLab('svn-anywhere-batch-plan-');
    const wcRoot = buildTextConflicts(lab, ['a.txt']);
    setup();
    await openAndScan(wcRoot);
    await planBatch('theirs-full');
    let html = fakePanel().latestRenderHtml();
    expect(html).toContain(wcRoot.replaceAll('&', '&amp;'));
    expect(html).toContain(CONFLICT_BATCH_TEXT_DEFAULTS.batchScopeWhole);
    expect(html).toContain(`data-intent="planConflictBatch" data-strategy="mine-full"`);
    // 策略切换：重新生成计划，选中项与执行策略随枚举更新。
    await planBatch('mine-full');
    const snapshot = conflictsSessionSnapshot();
    expect(snapshot.batch?.mode).toBe('plan');
    html = fakePanel().latestRenderHtml();
    expect(html).toContain(`data-intent="planConflictBatch" data-strategy="mine-full" data-focus="batch-strategy-mine-full" aria-pressed="true"`);
    // 查看批量结果在无结果时不改变视图（保持计划页）。
    await sendIntent({ kind: 'showConflictBatchResults' });
    expect(conflictsSessionSnapshot().batch?.mode).toBe('plan');
  });

  it('批量结果页可查看：执行后 showConflictBatchResults 切到结果页且不重扫', async () => {
    const lab = makeLab('svn-anywhere-batch-viewresults-');
    const wcRoot = buildTextConflicts(lab, ['a.txt']);
    setup();
    await openAndScan(wcRoot);
    await planBatch('theirs-full');
    await startBatch();
    // 执行后模型自动切到结果页；再切回计划（若存在）时结果仍可查看。
    expect(conflictsSessionSnapshot().batch?.mode).toBe('results');
    await sendIntent({ kind: 'showConflictBatchResults' });
    expect(conflictsSessionSnapshot().batch?.mode).toBe('results');
    expect(fakePanel().latestRenderHtml()).toContain(CONFLICT_BATCH_TEXT_DEFAULTS.batchResultsHeading);
  });
});
