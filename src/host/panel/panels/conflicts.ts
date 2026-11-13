/**
 * P7 冲突面板控制器（M4 阶段 5 任务 3/4）：面板生命周期、意图分发与
 * 单项冲突的写入执行链。状态机全部在 conflictModel（纯模型）；本文件只做
 * 调度、IO、任务槽、确认流程、操作记录与资源清理。
 *
 * 边界（技术方案 §5.1/§5.3/§5.6）：
 * - 扫描与单项 resolve 共用 conflicts 单任务槽（claimTask）：已有任务时
 *   只绑定/提示，不替换；批量任务属阶段 7，本阶段给出明确提示。
 * - 扫描：`scanConflictScope`（core 三判据 + 批量 info + 逐项补偿 +
 *   属性三值/内容分类注入）；模型代次（beginScan/applyScan/failScan）
 *   使关闭重开/取消后的在途回包过期；关闭面板只解除订阅，任务继续并
 *   在终态先写 m4SessionStore、再移除任务。
 * - 单项 resolve：写命令前 begin 固定意图（核心路径/冲突类型/指纹/
 *   策略）→ `executeResolve`（内部含命令前指纹重读与 status+info 联合
 *   回扫）→ 明确清除才写 resolvedLedger；命令失败或回扫矛盾记 unknown
 *   （operation record 保持 unknown 相位 = 跨面板写锁，重开只放行重新
 *   扫描/日志/关闭），绝不显示已解决。
 * - 树冲突必须用户确认文件系统节点已处理后才能 working；文本/二进制
 *   的「保留两者（working）」必须二次确认。确认入口经横幅动作
 *   （bannerAction 带 actionId）实现：详情按钮只负责弹出确认，真正执行
 *   只能由确认动作触发，用户取消不会绕过二次确认。
 * - 跨面板写锁与 P1-P6 共享：resolvePanelOccupancy('conflicts', wcRoot)
 *   折算 busy/writeLocked，P7 放行表（createP7Gates）同时驱动宿主守卫
 *   与 DOM 禁用。
 */
import * as vscode from 'vscode';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { ConflictRecord, ConflictSummary } from '../../../core/conflict';
import {
  isHistoryUpdateTaskContext,
  type HistoryUpdateTaskContext,
} from '../../../core/historyUpdate';
import {
  getOperationRegistry,
  kindOf,
  lockKeyOf,
  randomOperationId,
  type OperationRecord,
} from '../../../core/operations';
import {
  executeResolve,
  type ResolveSelection,
} from '../../../core/resolve';
import { credentialProvider } from '../../auth';
import { readSvnPath } from '../../config';
import { format, strings } from '../../i18n';
import { decodingRunOptions, logLine, showOutput } from '../../output';
import { clearM4TerminalPage, putM4ScopeSession, readM4ScopeSession } from '../../sessionResults';
import {
  claimTask,
  findTaskByScope,
  getActiveTask,
  hasActiveTask,
  onTaskRemoved,
  settleTask,
  type TaskObject,
  type TaskRemovedSubscription,
} from '../../taskRegistry';
import type { ConflictOpenTarget } from '../../commands/conflicts';
import {
  ConflictModel,
  conflictResultScopeOf,
  conflictScopeOf,
  conflictText,
  createRemoteAuthorizer,
  createWorkingCopyContentClassifier,
  persistConflictSession,
  resolveRejectText,
  restoreConflictSession,
  scanConflictScope,
  type ConflictPhase,
  type ConflictScopeTarget,
} from '../conflictModel';
import { allowedActions, createP7Gates, resolvePanelOccupancy } from '../gates';
import { createPanel, type PanelHandle } from '../host';
import type { Intent } from '../protocol';
import type { ActionSpec, BannerSpec, DetailPropertyValueSpec, DetailSectionSpec, DetailSpec, PanelState } from '../state';

const PANEL_ID = 'conflicts';

/** 失败提示横幅（verify 态）：重新扫描/查看日志/关闭是未知态唯一放行出口。 */
const RESOLVE_NOTICE_BANNER_ID = 'conflictResolveNotice';
/** 未决 resolve 操作记录横幅（写锁说明）。 */
const PENDING_OPERATION_BANNER_ID = 'conflictOperationPending';
/** 确认横幅（树节点确认 / working 二次确认；取消走独立 actionId）。 */
const TREE_CONFIRM_BANNER_ID = 'conflictTreeConfirm';
const WORKING_CONFIRM_BANNER_ID = 'conflictWorkingConfirm';

/* ---------------------------------------------------------------------------
 * 控制器补充文案（i18n 键优先；默认值与 i18n.conflictPanel 同键同值，见测试对账）
 * ------------------------------------------------------------------------- */

export const CONTROL_TEXT_DEFAULTS = {
  actionNotReady: '该动作将在后续版本接入。',
  resolveTargetMissing: '请先在冲突列表中选择一条冲突。',
  unknownWriteBlocked: '该冲突状态待核实，不能继续写入；请先重新扫描。',
  operationPending: '存在未完成的冲突解决操作（{operationId}），写操作受限；请重新扫描核实。',
  inspectHeading: '冲突检查器',
  versionUnavailable: '该冲突版本没有可打开的辅助文件（解决后辅助文件会随回扫撤下）。',
  binaryDiffUnavailable: '二进制冲突不打开文本差异；请使用「打开版本」。',
  terminalName: 'SVN 工作副本终端',
  resolveNoticeTitle: '冲突解决结果',
  confirmCancel: '取消',
  confirmStale: '确认请求已失效，请重新选择冲突后再操作。',
  taskHeld: '同一工作副本已有冲突任务在运行，请等待完成。',
  resolveStarted: '正在解决冲突：{path}',
} as const;

type ControlTextKey = keyof typeof CONTROL_TEXT_DEFAULTS;

/** 读取 P7 控制器文案：优先 host/i18n 的 conflictPanel 键，未落地时用默认值。 */
function controlText(key: ControlTextKey, params: Record<string, string> = {}): string {
  const table = strings.conflictPanel as unknown as Record<string, string | undefined>;
  return format(table[key] ?? CONTROL_TEXT_DEFAULTS[key], params);
}

/* ---------------------------------------------------------------------------
 * 任务对象
 * ------------------------------------------------------------------------- */

interface ConflictTaskCallbacks {
  /** 面板存活且仍绑定该模型时重推当前状态；否则空操作。 */
  render(): void;
  toast(level: 'info' | 'error', message: string): void;
}

interface ConflictTaskExtra {
  kind: 'scan' | 'resolve';
  scope: ConflictScopeTarget;
  /** 任务自带的模型实例：面板关闭后任务继续用它完成扫描/收口与持久化。 */
  model: ConflictModel;
  /** 扫描代次（scan 任务；resolve 任务不设）。 */
  epoch?: number;
  callbacks: ConflictTaskCallbacks;
  /** 进度节流：最近一次推送时间。 */
  lastProgressAt?: number;
  done: Promise<void>;
}

type ConflictTask = TaskObject<ConflictTaskExtra> & { extra: ConflictTaskExtra };

/** 任务终态页（m4SessionStore.terminalPage）：先写页、再移除任务。 */
interface ConflictTerminalPage {
  version: 1;
  kind: 'scan' | 'resolve';
  at: number;
  outcome: string;
  message?: string;
  path?: string;
  operationId?: string;
  summary?: ConflictSummary;
}

/* ---------------------------------------------------------------------------
 * 模块状态
 * ------------------------------------------------------------------------- */

interface PanelContext {
  extensionUri: vscode.Uri;
  subscriptions: vscode.Disposable[];
}

let panelContext: PanelContext | undefined;
let handle: PanelHandle | undefined;
let model: ConflictModel | undefined;
let entryTarget: ConflictOpenTarget | undefined;
let taskRemovalSub: TaskRemovedSubscription | undefined;
/**
 * P6 更新任务上下文（仅 source='update' 入口）：面板顶部展示请求
 * revision、更新前 BASE 与回读节点 BASE。只展示，不从它生成冲突记录；
 * 整副本扫描切到独立 local 作用域时清除。
 */
let updateTaskContext: HistoryUpdateTaskContext | undefined;
/** 扫描取消通道（关闭面板不取消；重新扫描/取消动作才中止旧扫描进程）。 */
let scanAbort: AbortController | undefined;
/** 待确认动作（横幅确认；key + 类型 + 每次新请求的 requestId）。 */
let pendingConfirm: { key: string; kind: 'tree' | 'working'; requestId: string } | undefined;
let confirmSeq = 0;
/** 最近一次 resolve 结果提示（未知/失败保留到重新扫描或关闭）。 */
let resolveNotice: { level: 'info' | 'warn' | 'error'; message: string } | undefined;

interface PendingConfirmMatcher {
  key: string;
  kind: 'tree' | 'working';
}

function currentScope(): ConflictScopeTarget | undefined {
  return model?.scope();
}

/** 作用域判等（任务绑定只在同一副本根 + 范围内发生）。 */
function sameConflictScope(a: ConflictScopeTarget, b: ConflictScopeTarget): boolean {
  return a.wcRoot === b.wcRoot && a.scopeRelPath === b.scopeRelPath;
}

function toast(level: 'info' | 'error', message: string): void {
  handle?.toast(level, message);
}

/* ---------------------------------------------------------------------------
 * 占用态与推送
 * ------------------------------------------------------------------------- */

/** 面板占用态：conflicts 任务槽 + 共享写锁（与 P1-P6 同一注册表）。 */
function occupancyOf(): { busy: boolean; writeLocked: boolean } {
  const scope = currentScope();
  if (scope === undefined) {
    return { busy: hasActiveTask('conflicts'), writeLocked: false };
  }
  return resolvePanelOccupancy('conflicts', scope.wcRoot);
}

function taskCallbacksFor(owner: ConflictModel): ConflictTaskCallbacks {
  return {
    render: () => {
      if (handle !== undefined && model === owner) {
        push();
      }
    },
    toast: (level, message) => {
      if (model === owner) {
        toast(level, message);
      }
    },
  };
}

/** 未决 resolve 操作记录（unknown 相位）：写锁说明横幅的数据源。 */
function pendingResolveRecord(): OperationRecord | undefined {
  const scope = currentScope();
  if (scope === undefined) {
    return undefined;
  }
  const held = getOperationRegistry().writeRestriction(scope.wcRoot);
  return held !== undefined && kindOf(held) === 'resolve' ? held : undefined;
}

/** 确认横幅（树节点确认 / working 二次确认）：确认与取消是独立 actionId。 */
function confirmBanner(pending: { key: string; kind: 'tree' | 'working' }): BannerSpec | undefined {
  const row = model?.rowByKey(pending.key);
  if (row === undefined) {
    return undefined;
  }
  if (pending.kind === 'tree') {
    return {
      id: TREE_CONFIRM_BANNER_ID,
      level: 'warn',
      title: conflictText('treeConfirmTitle'),
      detail: `${conflictText('treeConfirmDetail')} ${row.path}`,
      dismissable: false,
      actions: [
        { id: 'confirmTreePrepared', label: conflictText('treeConfirmButton') },
        { id: 'cancelConflictConfirm', label: controlText('confirmCancel') },
      ],
    };
  }
  return {
    id: WORKING_CONFIRM_BANNER_ID,
    level: 'warn',
    title: conflictText('workingConfirmTitle'),
    detail: `${conflictText('workingConfirmDetail')} ${row.path}`,
    dismissable: false,
    actions: [
      { id: 'confirmWorkingApply', label: conflictText('workingConfirmButton') },
      { id: 'cancelConflictConfirm', label: controlText('confirmCancel') },
    ],
  };
}

/** 控制器横幅：确认、resolve 结果、未决操作记录（模型横幅另行合并）。 */
function controllerBanners(locked: boolean): BannerSpec[] {
  const banners: BannerSpec[] = [];
  if (pendingConfirm !== undefined) {
    const banner = confirmBanner(pendingConfirm);
    if (banner !== undefined) {
      banners.push(banner);
    } else {
      pendingConfirm = undefined;
    }
  }
  if (resolveNotice !== undefined) {
    const actions: ActionSpec[] = [
      { id: 'rescanConflicts', label: conflictText('rescanAction'), payload: { scope: 'task' } },
      { id: 'viewTaskLog', label: strings.panel.taskProgressLog },
      { id: 'closePanel', label: strings.panel.taskProgressClose },
    ];
    banners.push({
      id: RESOLVE_NOTICE_BANNER_ID,
      level: resolveNotice.level,
      title: controlText('resolveNoticeTitle'),
      detail: resolveNotice.message,
      // 占用态下 dismissBanner 不在 P7 放行集内：不渲染可点被拒的 ×，
      // 关闭入口由横幅动作（重新扫描/日志/关闭面板）承担。
      dismissable: !locked,
      actions,
    });
  }
  const pendingRecord = pendingResolveRecord();
  if (pendingRecord !== undefined) {
    banners.push({
      id: PENDING_OPERATION_BANNER_ID,
      level: 'warn',
      title: controlText('operationPending', { operationId: pendingRecord.operationId }),
      dismissable: false,
      actions: [
        { id: 'rescanConflicts', label: conflictText('rescanAction'), payload: { scope: 'task' } },
        { id: 'viewTaskLog', label: strings.panel.taskProgressLog },
        { id: 'closePanel', label: strings.panel.taskProgressClose },
      ],
    });
  }
  return banners;
}

/**
 * 推送一帧：每帧渲染前先把模型会话写入 m4SessionStore（关闭重开恢复
 * 依据），占用态由共享任务槽 + 写锁折算，放行视图由 P7 表求值。
 */
function push(): void {
  if (handle === undefined || model === undefined) {
    return;
  }
  const scope = currentScope();
  if (scope === undefined) {
    return;
  }
  persistConflictSession(model, { current: conflictResultScopeOf(scope) });
  const occupancy = occupancyOf();
  const gates = createP7Gates();
  const gate = {
    busy: allowedActions(gates.busy),
    writeLocked: allowedActions(gates.writeLocked),
  };
  const state = model.buildPanelState(handle.sessionId, {
    busy: occupancy.busy,
    writeLocked: occupancy.writeLocked,
    gate,
  });
  const extra = controllerBanners(occupancy.busy || occupancy.writeLocked);
  if (extra.length > 0) {
    state.banners = [...extra, ...state.banners];
  }
  const contextBadges = updateTaskContextBadges();
  if (contextBadges.length > 0) {
    state.headerBadges = [...(state.headerBadges ?? []), ...contextBadges];
  }
  handle.update(state, handle.sessionId);
}

/**
 * P6 更新任务上下文顶部徽标（请求 revision / 更新前 BASE / 回读节点 BASE）：
 * 回读值缺失时明确显示「回读节点 BASE 未知」，不用预期值冒充。
 */
function updateTaskContextBadges(): NonNullable<PanelState['headerBadges']> {
  const context = updateTaskContext;
  if (context === undefined) {
    return [];
  }
  const badges: NonNullable<PanelState['headerBadges']> = [
    {
      text: format(strings.conflictPanel.updateContextRequested, {
        revision: String(context.requestedRevision),
      }),
    },
    {
      text: format(strings.conflictPanel.updateContextPreBase, {
        revision: String(context.preRevision),
      }),
    },
  ];
  badges.push(context.postNodeRevision !== undefined
    ? {
        text: format(strings.conflictPanel.updateContextPostBase, {
          revision: String(context.postNodeRevision),
        }),
      }
    : { text: strings.conflictPanel.updateContextPostUnknown, warn: true });
  return badges;
}

/* ---------------------------------------------------------------------------
 * 任务槽辅助
 * ------------------------------------------------------------------------- */

function makeTask(
  kind: 'scan' | 'resolve',
  scope: ConflictScopeTarget,
  owner: ConflictModel,
  phase: 'scanning' | 'connecting' | 'resolving',
  taskId: string,
): ConflictTask {
  return {
    taskId,
    panelKind: 'conflicts',
    phase,
    resultScope: conflictResultScopeOf(scope),
    lockKey: scope.wcRoot,
    initiatorSessionId: handle?.sessionId ?? '',
    abortController: new AbortController(),
    extra: {
      kind,
      scope,
      model: owner,
      callbacks: taskCallbacksFor(owner),
      done: Promise.resolve(),
    },
  };
}

/** 绑定运行中任务：模型切到任务实例，渲染回调重新指向当前面板。 */
function bindTask(task: TaskObject): boolean {
  const extra = task.extra as ConflictTaskExtra | undefined;
  if (extra === undefined || extra.model === undefined || extra.scope === undefined) {
    return false;
  }
  model = extra.model;
  extra.callbacks = taskCallbacksFor(extra.model);
  subscribeTaskRemoval();
  return true;
}

/** 绑定即订阅：任务移除（终态结算）后重跑恢复顺序；关闭面板时取消订阅。 */
function subscribeTaskRemoval(): void {
  taskRemovalSub?.dispose();
  taskRemovalSub = undefined;
  if (handle === undefined) {
    return;
  }
  const sessionId = handle.sessionId;
  taskRemovalSub = onTaskRemoved('conflicts', sessionId, () => {
    void recoverSession();
  });
}

/** 写任务终态页（先写会话缓存、再移除任务；settleTask 的写侧回调）。 */
function persistTaskTerminal(scope: ConflictScopeTarget, page: ConflictTerminalPage): void {
  putM4ScopeSession(conflictResultScopeOf(scope), { terminalPage: page });
}

/**
 * 环境选项：本地只读/写命令共用解码与日志口径；本地命令绝不携带凭据
 * （远端属性值补查由 scanConflictScope 的 authorizeRemote 单独补录）。
 * 扫描 status 是本地长遍历、resolve 写命令不可取消，两者都不限时。
 */
function conflictRunOptions(signal?: AbortSignal): ReturnType<typeof decodingRunOptions> & {
  timeoutMs: number;
  signal?: AbortSignal;
} {
  return {
    timeoutMs: 0,
    ...decodingRunOptions('conflict'),
    ...(signal !== undefined ? { signal } : {}),
  };
}

/* ---------------------------------------------------------------------------
 * 扫描任务
 * ------------------------------------------------------------------------- */

/**
 * 发起范围扫描：占 conflicts 单任务槽；已有任务时只绑定/提示，不替换。
 * 返回前已把模型置于 scanning 并推送一帧（进度条可见）。
 */
async function startScan(scope: ConflictScopeTarget, owner: ConflictModel): Promise<void> {
  const existing = getActiveTask('conflicts');
  if (existing !== undefined) {
    const extra = existing.extra as ConflictTaskExtra | undefined;
    // 只有同一作用域的任务才能绑定到当前面板；其他范围的任务在跑时
    // 只提示占用，不把面板模型切到他人作用域。
    if (extra !== undefined && sameConflictScope(extra.scope, scope)) {
      bindTask(existing);
    }
    toast('info', controlText('taskHeld'));
    push();
    return;
  }
  const registry = getOperationRegistry();
  if (registry.hasRunning(scope.wcRoot)) {
    // 其他面板（P1-P6）的命令正在写同一副本：等待，不抢任务槽。
    // 注意不能用 hasActive/writeRestriction 阻断：unknown 等限制态恰恰
    // 需要「重新扫描」作为回扫入口（P7 放行表在 writeLocked 时放行扫描）。
    toast('info', controlText('taskHeld'));
    push();
    return;
  }
  const task = makeTask('scan', scope, owner, 'scanning', randomOperationId());
  const claimed = claimTask(task);
  if (!claimed.ok) {
    toast('info', controlText('taskHeld'));
    push();
    return;
  }
  const epoch = owner.beginScan();
  task.extra.epoch = epoch;
  resolveNotice = undefined;
  pendingConfirm = undefined;
  logLine(`[scan] ${task.taskId} scope=${scope.scopeRelPath} wc=${scope.wcRoot}`, 'conflict');
  push();
  // 扫描后台执行：意图/命令入口不等待长遍历，进度与终态经回调推送。
  task.extra.done = runScanTask(task).catch((err: unknown) => {
    logLine(`[scan] ${task.taskId} executor error: ${err instanceof Error ? err.message : String(err)}`, 'conflict');
  });
}

/** 扫描执行器（面板关闭后继续）：完成后先写会话状态/终态页、再移除任务。 */
async function runScanTask(task: ConflictTask): Promise<void> {
  const extra = task.extra;
  const { model: owner, scope, epoch } = extra;
  const controller = new AbortController();
  scanAbort = controller;
  const runOptions = conflictRunOptions(controller.signal);
  const svnPath = readSvnPath();
  let outcome: 'scanned' | 'canceled' | 'failed' = 'failed';
  let failureMessage: string | undefined;
  try {
    const result = await scanConflictScope(
      {
        svnPath,
        localRunOptions: runOptions,
        classifyContent: createWorkingCopyContentClassifier(svnPath, scope.wcRoot, {
          ...runOptions,
          signal: controller.signal,
        }),
        authorizeRemote: createRemoteAuthorizer(credentialProvider()),
        onProgress: (completed, total) => {
          if (epoch === undefined) {
            return;
          }
          owner.updateProgress(epoch, completed, total);
          // 进度节流：≥100ms 或到达总数时才推送（阶段 0 实测 100ms 可更新）。
          const now = Date.now();
          if (completed >= total || now - (extra.lastProgressAt ?? 0) >= 100) {
            extra.lastProgressAt = now;
            extra.callbacks.render();
          }
        },
      },
      scope,
    );
    if (epoch !== undefined && owner.applyScan(epoch, result)) {
      outcome = 'scanned';
      logLine(
        `[scan] ${task.taskId} done records=${result.records.length}`
          + ` text=${result.summary.text} property=${result.summary.property}`
          + ` tree=${result.summary.tree} failures=${result.failures.length}`
          + ` wcLocked=${result.wcLocked}`,
        'conflict',
      );
    } else {
      outcome = 'canceled';
    }
  } catch (err) {
    failureMessage = err instanceof Error ? err.message : String(err);
    if (epoch !== undefined && owner.failScan(epoch, err)) {
      outcome = 'failed';
      logLine(`[scan] ${task.taskId} failed: ${failureMessage}`, 'conflict');
    } else {
      outcome = 'canceled';
    }
  } finally {
    if (outcome === 'scanned') {
      // 回扫是解除 resolve unknown 写锁的唯一读路径：按真实扫描结果收口。
      await reconcilePendingResolveRecords(scope, owner);
    }
    settleTask(task.taskId, () => {
      persistConflictSession(owner, { current: conflictResultScopeOf(scope) });
      persistTaskTerminal(scope, {
        version: 1,
        kind: 'scan',
        at: Date.now(),
        outcome,
        ...(failureMessage !== undefined ? { message: failureMessage } : {}),
        // 失败时保留的是旧快照，摘要只在本次扫描成功时写入终态页。
        ...(outcome === 'scanned' ? { summary: owner.summary() } : {}),
      });
    });
    if (scanAbort === controller) {
      scanAbort = undefined;
    }
    extra.callbacks.render();
  }
}

/**
 * 取消进行中的扫描（关闭面板不取消）：使在途回包因代次过期，并中止
 * 子进程；任务按终态页结算。协议层的取消入口随 P7 放行表后续补齐。
 */
export function cancelConflictScan(): boolean {
  const task = getActiveTask('conflicts');
  if (task === undefined) {
    return false;
  }
  const extra = task.extra as ConflictTaskExtra | undefined;
  if (extra === undefined || extra.kind !== 'scan') {
    return false;
  }
  if (extra.epoch !== undefined) {
    extra.model.cancelScan(extra.epoch);
  }
  scanAbort?.abort();
  logLine(`[scan] ${task.taskId} canceled`, 'conflict');
  settleTask(task.taskId, () => {
    persistConflictSession(extra.model, { current: conflictResultScopeOf(extra.scope) });
    persistTaskTerminal(extra.scope, {
      version: 1,
      kind: 'scan',
      at: Date.now(),
      outcome: 'canceled',
      message: strings.conflictPanel.scanCanceled,
    });
  });
  extra.callbacks.render();
  return true;
}

/**
 * 把未决（unknown）resolve 记录按最新真实扫描收口：
 * - 目标冲突已不再被扫描报告 → 视为回扫确认解决：写台账并以 done 收口；
 * - 扫描仍报告同一目标 → 结束未决记录（未证实执行成功，不写台账），
 *   释放写锁，让用户基于新扫描重新选择策略。
 * 两种情况都不可显示「已解决」，台账只在扫描明确清除时写入。
 */
async function reconcilePendingResolveRecords(
  scope: ConflictScopeTarget,
  owner: ConflictModel,
): Promise<void> {
  const registry = getOperationRegistry();
  const records = await registry.loadAllRecords();
  const pending = records.filter((record) => kindOf(record) === 'resolve'
    && lockKeyOf(record) === scope.wcRoot
    && record.phase === 'unknown');
  for (const record of pending) {
    const targets = record.resolveIntent?.targets ?? [];
    // 只按本次扫描范围内的目标判定；范围外目标不能因「快照里没有」被
    // 误判为回扫清除（记录保持 unknown，等待覆盖它的扫描）。
    const scoped = targets.filter((target) => scope.scopeRelPath === '.'
      || target.relPath === scope.scopeRelPath
      || target.relPath.startsWith(`${scope.scopeRelPath}/`));
    if (scoped.length === 0) {
      continue;
    }
    const stillReported = scoped.some((target) => owner.records().some((current) =>
      current.path === target.relPath
      && current.kinds.some((kind) => target.conflictKinds.includes(kind))));
    if (stillReported) {
      logLine(`[resolve] ${record.operationId} rescan still reports conflict; release write lock`, 'conflict');
      await registry.finalizeOperation(record.operationId, 'failed-unconfirmed');
      continue;
    }
    for (const target of scoped) {
      owner.recordResolved({
        fingerprint: target.fingerprint,
        path: target.relPath,
        kinds: [...target.conflictKinds],
        strategy: target.strategy,
        operationId: record.operationId,
        resolvedAt: Date.now(),
      });
    }
    logLine(`[resolve] ${record.operationId} rescan confirmed resolved`, 'conflict');
    await registry.finalizeOperation(record.operationId, 'done');
  }
}

/* ---------------------------------------------------------------------------
 * 单项 resolve 执行链
 * ------------------------------------------------------------------------- */

/** 详情按钮只负责弹出确认；真正执行只能由横幅确认动作触发。 */
function requestWorkingConfirm(key: string): void {
  pendingConfirm = { key, kind: 'working', requestId: `${key}-${++confirmSeq}` };
  push();
}

function requestTreeConfirm(key: string): void {
  pendingConfirm = { key, kind: 'tree', requestId: `${key}-${++confirmSeq}` };
  push();
}

function takeConfirm(match: PendingConfirmMatcher): boolean {
  if (pendingConfirm === undefined
    || pendingConfirm.key !== match.key
    || pendingConfirm.kind !== match.kind) {
    return false;
  }
  pendingConfirm = undefined;
  return true;
}

/** 选中冲突行（selectConflict 意图处理器；视图行校验见交付 cross_file_needs）。 */
export function selectConflictById(id: string): boolean {
  if (model === undefined) {
    return false;
  }
  if (!model.select(id)) {
    return false;
  }
  pendingConfirm = undefined;
  push();
  return true;
}

/** 当前选中行（apply/prepare/inspect/diff 等动作的共同目标）。 */
function selectedConflict(): ConflictRecord | undefined {
  const row = model?.selectedRow();
  return row?.status === 'resolved' ? undefined : row?.record;
}

/**
 * 「应用所选处理结果」意图：按动作矩阵与模型选择构造 ResolveSelection。
 * - 混合路径/类型未知/保留属性：不执行，提示原因或终端交互入口；
 * - 树：必须先确认节点已处理，确认后直接 working；
 * - 文本/二进制 working：只弹出二次确认（执行走 confirmWorkingApply）；
 * - 属性：全部属性都有明确选择后才执行一次 working；
 * - 其余 --accept 变体：直接执行。
 */
async function applySelectedResolution(): Promise<void> {
  if (handle === undefined || model === undefined) {
    return;
  }
  const row = model.selectedRow();
  if (row === undefined || row.status === 'resolved' || row.record === undefined) {
    toast('info', controlText('resolveTargetMissing'));
    return;
  }
  const key = row.key;
  const record = row.record;
  if (model.isUnknown(key)) {
    toast('info', controlText('unknownWriteBlocked'));
    push();
    return;
  }
  const matrix = model.actionMatrix(key);
  if (matrix === undefined) {
    return;
  }
  if (matrix.mixedPath || matrix.blocker === 'unknown-content') {
    // 混合路径不映射单一策略：交工作副本终端按 SVN 交互流程处理。
    toast('info', matrix.blockerText ?? conflictText('detailMixedNote'));
    return;
  }
  if (matrix.blocker !== undefined) {
    toast('info', matrix.blockerText ?? resolveRejectText(matrix.blocker));
    return;
  }
  if (record.kinds.includes('property')) {
    if (!model.propertySelectionComplete(key)) {
      toast('info', resolveRejectText('property-incomplete'));
      return;
    }
    const choices = model.propertyChoices(key);
    const selection: ResolveSelection = {
      kind: 'property',
      choices: Object.entries(choices).map(([name, choice]) => ({ name, choice })),
    };
    const strategy = `property: ${Object.entries(choices).map(([name, choice]) => `${name}=${choice}`).join(',')}`;
    await runResolve(record, selection, strategy);
    return;
  }
  if (record.kinds.includes('tree')) {
    if (!model.isTreePrepared(key)) {
      toast('info', resolveRejectText('tree-requires-confirmation'));
      return;
    }
    await runResolve(record, { kind: 'working', confirmed: true }, 'working');
    return;
  }
  const variant = model.selectedVariant(key);
  if (variant === undefined) {
    toast('info', conflictText('detailSelectVariantFirst'));
    return;
  }
  if (variant === 'working') {
    // 详情按钮只负责弹出二次确认（换新 requestId 重新弹），执行只能走
    // 确认横幅的 confirmWorkingApply——取消过确认的用户无法再次点详情绕过。
    requestWorkingConfirm(key);
    return;
  }
  await runResolve(record, { kind: 'accept', value: variant }, variant);
}

/** 确认横幅的「采用当前工作内容」：文本/二进制 working 的唯一执行入口。 */
async function confirmWorkingApply(): Promise<void> {
  const record = selectedConflict();
  if (record === undefined || model === undefined) {
    toast('info', controlText('resolveTargetMissing'));
    return;
  }
  const key = record.id;
  if (!takeConfirm({ key, kind: 'working' })) {
    toast('info', controlText('confirmStale'));
    push();
    return;
  }
  const variant = model.selectedVariant(key);
  if (variant !== 'working') {
    // 选择在确认期间被替换：不执行，要求重新选择。
    toast('info', conflictText('detailSelectVariantFirst'));
    push();
    return;
  }
  await runResolve(record, { kind: 'working', confirmed: true }, 'working');
}

/** 确认横幅的「确认节点已处理」：树冲突 prepare 的唯一执行入口。 */
function confirmTreePrepared(): void {
  const record = selectedConflict();
  if (record === undefined || model === undefined) {
    toast('info', controlText('resolveTargetMissing'));
    return;
  }
  if (!takeConfirm({ key: record.id, kind: 'tree' })) {
    toast('info', controlText('confirmStale'));
    push();
    return;
  }
  const result = model.prepareTreeConflict(record.id);
  if (result === 'prepared' || result === 'already') {
    toast('info', conflictText('detailTreePreparedNote'));
  }
  push();
}

/**
 * 单项 resolve 事务：
 * 1. 发起前检查任务槽与共享 operation 占用（正常路径已有任务时只提示）；
 * 2. begin 固定意图（路径/冲突类型/指纹/策略；不保存属性原值）；
 * 3. `executeResolve` 内部先重读指纹，再按计划执行 propset/propdel +
 *    路径级 `--depth empty`，最后 status+info 联合回扫；
 * 4. 明确清除才写 resolvedLedger 并 done 收口；失败/矛盾落 unknown 相位
 *    （跨面板写锁保持），回扫成功前不显示已解决。
 */
async function runResolve(
  record: ConflictRecord,
  selection: ResolveSelection,
  strategy: string,
): Promise<void> {
  if (handle === undefined || model === undefined) {
    return;
  }
  const owner = model;
  const scope = owner.scope();
  if (scope === undefined) {
    return;
  }
  if (hasActiveTask('conflicts')) {
    toast('info', controlText('taskHeld'));
    push();
    return;
  }
  const registry = getOperationRegistry();
  if (registry.hasActive(scope.wcRoot)
    || registry.hasRunning(scope.wcRoot)
    || registry.writeRestriction(scope.wcRoot) !== undefined) {
    toast('info', controlText('taskHeld'));
    push();
    return;
  }
  const key = record.id;
  const operationId = randomOperationId();
  // 写命令发出前为 connecting 准备态（该窗口不提供取消）；begin 成功后
  // 转 resolving（任务矩阵的写相位）。
  const task = makeTask('resolve', scope, owner, 'connecting', operationId);
  const claimed = claimTask(task);
  if (!claimed.ok) {
    toast('info', controlText('taskHeld'));
    push();
    return;
  }
  const begin = await registry.begin({
    wcRoot: scope.wcRoot,
    lockKey: scope.wcRoot,
    kind: 'resolve',
    operationId,
    targetRelPath: record.path,
    nodeKind: nodeKindOf(record, scope.wcRoot),
    resolveIntent: {
      scopeRoot: scope.wcRoot,
      targets: [{
        relPath: record.path,
        conflictKinds: [...record.kinds],
        fingerprint: key,
        strategy,
      }],
    },
  });
  if (!begin.ok) {
    // begin 被占用：任务槽回收（未写任何命令），不替换他人任务。
    settleTask(task.taskId, () => persistConflictSession(owner, { current: conflictResultScopeOf(scope) }));
    toast('info', controlText('taskHeld'));
    push();
    return;
  }
  task.phase = 'resolving';
  logLine(`[resolve] ${operationId} path=${record.path} strategy=${strategy}`, 'conflict');
  toast('info', controlText('resolveStarted', { path: record.path }));
  push();
  // 写命令不限时（技术方案 §5.3）：意图立即返回，任务后台执行并自行收口。
  task.extra.done = executeResolveTask(task, record, selection, strategy).catch((err: unknown) => {
    logLine(`[resolve] ${operationId} executor error: ${err instanceof Error ? err.message : String(err)}`, 'conflict');
  });
}

function nodeKindOf(record: ConflictRecord, wcRoot: string): 'file' | 'dir' {
  if (record.treeConflict?.kind === 'dir') {
    return 'dir';
  }
  try {
    return statSync(join(wcRoot, ...record.path.split('/'))).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'file';
  }
}

/** 单项 resolve 执行体（任务生命周期内）：命令、回扫、收口与持久化。 */
async function executeResolveTask(
  task: ConflictTask,
  record: ConflictRecord,
  selection: ResolveSelection,
  strategy: string,
): Promise<void> {
  const extra = task.extra;
  const { model: owner, scope } = extra;
  const registry = getOperationRegistry();
  const operationId = task.taskId;
  const key = record.id;
  const svnPath = readSvnPath();
  let page: ConflictTerminalPage = {
    version: 1,
    kind: 'resolve',
    at: Date.now(),
    outcome: 'unknown',
    path: record.path,
    operationId,
  };
  try {
    const result = await executeResolve(svnPath, scope.wcRoot, {
      record,
      selection,
      contentKind: record.contentKind,
    }, conflictRunOptions());
    const verificationDetail = result.verification?.detail
      ?? (result.verification?.statusItem !== undefined
        ? `status=${result.verification.statusItem}`
        : result.error);
    switch (result.outcome) {
      case 'resolved': {
        owner.recordResolved({
          fingerprint: key,
          path: record.path,
          kinds: [...record.kinds],
          strategy,
          operationId,
          resolvedAt: Date.now(),
        });
        owner.clearUnknown(key);
        resolveNotice = { level: 'info', message: strings.resolvePanel.outcomeResolved };
        toast('info', strings.resolvePanel.outcomeResolved);
        logLine(`[resolve] ${operationId} outcome=resolved`, 'conflict');
        await registry.finalizeOperation(operationId, 'done');
        page = { ...page, outcome: 'resolved', message: strings.resolvePanel.outcomeResolved };
        break;
      }
      case 'rejected': {
        const reasonText = result.reason !== undefined
          ? resolveRejectText(result.reason)
          : strings.resolvePanel.outcomeUnknown;
        if (result.reason === 'fingerprint-changed' || result.reason === 'conflict-not-found') {
          owner.markUnknown(key, reasonText);
        }
        resolveNotice = { level: 'warn', message: reasonText };
        toast('info', reasonText);
        logLine(`[resolve] ${operationId} rejected reason=${result.reason ?? 'unknown'}`, 'conflict');
        // 写命令未发出（计划/指纹检查阶段拒绝）：安全收口，不留写锁。
        await registry.finalizeOperation(operationId, 'failed-unconfirmed');
        page = { ...page, outcome: 'rejected', message: reasonText };
        break;
      }
      default: {
        const message = result.outcome === 'unresolved'
          ? format(strings.resolvePanel.outcomeUnresolved, { detail: verificationDetail ?? '' })
          : result.outcome === 'anomalous'
            ? format(strings.resolvePanel.outcomeAnomalous, { detail: verificationDetail ?? '' })
            : strings.resolvePanel.outcomeUnknown;
        owner.markUnknown(key, message);
        resolveNotice = { level: 'error', message };
        toast('error', message);
        logLine(`[resolve] ${operationId} outcome=${result.outcome}`, 'conflict');
        // 结果未决：operation record 保持 unknown 相位（写锁），只开放
        // 重新扫描/日志/关闭；下一次真实扫描按结果收口（见 reconcile）。
        await registry.markPhase(operationId, 'unknown');
        page = { ...page, outcome: result.outcome, message };
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    owner.markUnknown(key, message);
    resolveNotice = { level: 'error', message };
    toast('error', message);
    logLine(`[resolve] ${operationId} error: ${message}`, 'conflict');
    // 进程异常/失联：命令可能已发出，进入 unknown 写限制。
    await registry.markPhase(operationId, 'unknown');
    page = { ...page, outcome: 'unknown', message };
  } finally {
    settleTask(task.taskId, () => {
      persistConflictSession(owner, { current: conflictResultScopeOf(scope) });
      persistTaskTerminal(scope, page);
    });
    extra.callbacks.render();
  }
}

/* ---------------------------------------------------------------------------
 * 只读交互处理入口
 * ------------------------------------------------------------------------- */

function conflictFsPath(record: ConflictRecord): string | undefined {
  const scope = currentScope();
  if (scope === undefined || record.path === '.') {
    return undefined;
  }
  return join(scope.wcRoot, ...record.path.split('/'));
}

/** 辅助文件绝对路径（存在性校验；解决后随回扫撤下）。 */
function artifactFsPath(record: ConflictRecord, role: 'base' | 'incoming'): string | undefined {
  const scope = currentScope();
  if (scope === undefined) {
    return undefined;
  }
  const artifact = record.artifacts.find((candidate) => candidate.role === role);
  if (artifact === undefined) {
    return undefined;
  }
  const fsPath = join(scope.wcRoot, ...artifact.path.split('/'));
  return existsSync(fsPath) ? fsPath : undefined;
}

/** 打开冲突编辑（当前工作文件，保留冲突标记供人工合并）。 */
async function openConflictEditor(): Promise<void> {
  const record = selectedConflict();
  const fsPath = record === undefined ? undefined : conflictFsPath(record);
  if (record === undefined || fsPath === undefined || !existsSync(fsPath)) {
    toast('info', controlText('versionUnavailable'));
    return;
  }
  try {
    await vscode.window.showTextDocument(vscode.Uri.file(fsPath), { preview: false });
  } catch {
    toast('error', controlText('versionUnavailable'));
  }
}

/** 原生两文件差异：冲突基线（或传入内容）↔ 当前工作文件。 */
async function openConflictDiff(): Promise<void> {
  const record = selectedConflict();
  if (record === undefined) {
    return;
  }
  if (record.contentKind === 'binary') {
    toast('info', controlText('binaryDiffUnavailable'));
    return;
  }
  const localPath = conflictFsPath(record);
  const basePath = artifactFsPath(record, 'base') ?? artifactFsPath(record, 'incoming');
  if (localPath === undefined || basePath === undefined || !existsSync(localPath)) {
    toast('info', controlText('versionUnavailable'));
    return;
  }
  const title = format(strings.panel.diffTitle, { path: record.path });
  await vscode.commands.executeCommand(
    'vscode.diff',
    vscode.Uri.file(basePath),
    vscode.Uri.file(localPath),
    title,
    { preview: false },
  );
}

/** 打开冲突版本：local=工作文件（编辑器/系统应用），base/incoming=辅助文件。 */
async function openConflictVersion(role: 'local' | 'base' | 'incoming'): Promise<void> {
  const record = selectedConflict();
  if (record === undefined) {
    return;
  }
  if (role === 'local') {
    const fsPath = conflictFsPath(record);
    if (fsPath === undefined || !existsSync(fsPath)) {
      toast('info', controlText('versionUnavailable'));
      return;
    }
    if (record.contentKind === 'binary') {
      await vscode.env.openExternal(vscode.Uri.file(fsPath));
      return;
    }
    await openConflictEditor();
    return;
  }
  const fsPath = artifactFsPath(record, role);
  if (fsPath === undefined) {
    toast('info', controlText('versionUnavailable'));
    return;
  }
  // 版本副本交系统应用打开（二进制/文档类冲突不做文本编辑器假设）。
  await vscode.env.openExternal(vscode.Uri.file(fsPath));
}

/** 工作副本终端：混合路径/自定义流程的 SVN 交互处理入口。 */
function openWorkCopyTerminal(): void {
  const scope = currentScope();
  if (scope === undefined) {
    return;
  }
  const terminal = vscode.window.createTerminal({
    name: controlText('terminalName'),
    cwd: scope.wcRoot,
  });
  terminal.show();
}

/** 检查器：把当前冲突详情写入 conflict 输出频道（只读，不写工作副本）。 */
function inspectSelectedConflict(): void {
  const row = model?.selectedRow();
  const detail = model?.detail();
  if (row === undefined || detail === undefined) {
    return;
  }
  logLine(`[inspect] ${controlText('inspectHeading')} ${row.path}`, 'conflict');
  for (const line of flattenDetail(detail)) {
    logLine(`  ${line}`, 'conflict');
  }
  showOutput(false, 'conflict');
}

/** 详情 → 文本行（检查器输出；属性只输出名称/存在性/字节数，值原文只留在面板详情）。 */
function flattenDetail(detail: DetailSpec): string[] {
  const lines: string[] = [];
  if (detail.title !== undefined) {
    lines.push(detail.title);
  }
  if (detail.subtitle !== undefined) {
    lines.push(detail.subtitle);
  }
  for (const section of detail.sections) {
    for (const line of flattenSection(section)) {
      lines.push(line);
    }
  }
  return lines;
}

function flattenSection(section: DetailSectionSpec): string[] {
  if (section.kind === 'kv') {
    return section.entries.map((entry) => `${entry.label}: ${entry.value}`);
  }
  if (section.kind === 'text') {
    return section.paragraphs;
  }
  if (section.kind === 'pre') {
    return section.text.split('\n');
  }
  if (section.kind === 'properties') {
    // 检查器展示范围（技术方案 §5.3）：属性只给名称/存在性/字节数；
    // 属性值原文（含 base64/多值/空值）不写输出频道（§5.2 日志不记录属性值）。
    return section.properties.map((property) =>
      `${conflictText('inspectPropertyName')} ${property.name}: `
      + `${strings.conflictPanel.propertyMine}${propertySideSummary(property.local)}`
      + ` / ${strings.conflictPanel.propertyBase}${propertySideSummary(property.base)}`
      + ` / ${strings.conflictPanel.propertyIncoming}${propertySideSummary(property.incoming)}`);
  }
  if (section.kind === 'artifacts') {
    return section.artifacts.map((artifact) =>
      `${artifact.roleLabel}: ${artifact.path}${artifact.revision !== undefined ? ` @r${artifact.revision}` : ''}`);
  }
  if (section.kind === 'variants') {
    return section.options.map((option) =>
      `${option.label}${option.disabled ? ' (disabled)' : ''}${option.disabledReason !== undefined ? `: ${option.disabledReason}` : ''}`);
  }
  if (section.kind === 'actions') {
    return section.actions.map((action) => action.label);
  }
  return [];
}

/**
 * 检查器属性侧摘要：只输出存在性与原始字节数，绝不拼接属性值原文
 * （`text` 仅供面板详情展示）。exists 非 true 一律按缺失输出，避免
 * 未知形态绕过泄露。
 */
function propertySideSummary(value: DetailPropertyValueSpec): string {
  if (value.exists !== true) {
    return conflictText('inspectPropertyMissing');
  }
  return format(conflictText('inspectPropertyExists'), { bytes: String(value.bytes ?? 0) });
}

/** 复制当前冲突路径（工作副本相对路径）。 */
function copyConflictPath(): void {
  const row = model?.selectedRow();
  if (row === undefined) {
    toast('info', controlText('resolveTargetMissing'));
    return;
  }
  void vscode.env.clipboard.writeText(row.path);
}

/* ---------------------------------------------------------------------------
 * 打开与恢复
 * ------------------------------------------------------------------------- */

/** 注入宿主上下文（extension.activate）。 */
export function setConflictPanelContext(context: PanelContext): void {
  panelContext = context;
}

/**
 * P7 打开器（commands/conflicts.setConflictPanelOpener 与 P6 更新交接
 * 的注入点）：同类型面板切换目标时生成新会话；busy/写入在途拒绝切换。
 */
export async function openConflictPanel(target: ConflictOpenTarget): Promise<void> {
  if (panelContext === undefined) {
    logLine(strings.conflictCommand.panelNotReady, 'conflict');
    void vscode.window.showInformationMessage(strings.conflictCommand.panelNotReady);
    return;
  }
  if (handle !== undefined) {
    const sessionId = handle.switchSession();
    if (sessionId === undefined) {
      void vscode.window.showInformationMessage(strings.conflictPanel.busyHeld);
      return;
    }
  } else {
    handle = createPanel(
      PANEL_ID,
      {
        title: strings.conflictPanel.panelTitle,
        gates: createP7Gates(),
        blockSwitchWhenWriteLocked: true,
      },
      { onIntent, onViewReady, onDispose: onPanelDispose },
      panelContext,
    );
  }
  entryTarget = target;
  // P6 更新任务上下文（source='update'）：只接受通过形状校验的展示事实；
  // 普通入口与未知载荷一律清空，不从 taskContext 生成任何冲突记录。
  updateTaskContext = target.source === 'update' && isHistoryUpdateTaskContext(target.taskContext)
    ? target.taskContext
    : undefined;
  await recoverSession();
}

/**
 * 会话恢复（打开/切换目标/任务移除通知共用，顺序固定）：
 * ① 活动任务绑定（同一作用域的任务模型原样接管，扫描进度继续上屏）；
 * ② m4SessionStore 当前作用域快照/台账/推迟/browsable；
 * ③ 终态页转为一次性结果提示；
 * ④ fresh 时自动发起范围扫描（P7 打开即 scanning）。
 */
async function recoverSession(options: { forceScan?: boolean } = {}): Promise<void> {
  if (handle === undefined || entryTarget === undefined) {
    return;
  }
  const target = entryTarget;
  const scope = conflictScopeOf(target.wcRoot, target.scopeRelPath);
  // 旧会话的在途确认状态不跨目标保留；任务对象与模型不受影响。
  pendingConfirm = undefined;
  scanAbort = undefined;

  const existingTask = findTaskByScope('conflicts', conflictResultScopeOf(scope));
  if (existingTask !== undefined) {
    if (bindTask(existingTask)) {
      resolveNotice = undefined;
      push();
      return;
    }
  }

  const fresh = new ConflictModel();
  model = fresh;
  const restored = restoreConflictSession(fresh, scope);
  subscribeTaskRemoval();
  if (restored) {
    restoreNoticeFromTerminalPage(scope);
    push();
    // 显式扫描动作（整副本扫描等）即使有缓存也必须按真实 SVN 重新扫描；
    // 普通关闭重开只恢复缓存，不自动重扫。
    if (options.forceScan === true) {
      await startScan(scope, fresh);
    }
    return;
  }
  resolveNotice = undefined;
  push();
  await startScan(scope, fresh);
}

/** 终态页恢复为一次性结果提示（随后清除，避免每次重开重复展示旧消息）。 */
function restoreNoticeFromTerminalPage(scope: ConflictScopeTarget): void {
  const entry = readM4ScopeSession(conflictResultScopeOf(scope));
  const page = entry?.terminalPage as ConflictTerminalPage | undefined;
  if (page !== undefined && typeof page === 'object' && page.version === 1) {
    if (page.message !== undefined) {
      resolveNotice = {
        level: page.outcome === 'resolved' || page.outcome === 'scanned' ? 'info' : 'warn',
        message: page.message,
      };
    }
  }
  if (entry?.terminalPage !== undefined) {
    clearM4TerminalPage(conflictResultScopeOf(scope));
  }
}

/* ---------------------------------------------------------------------------
 * 意图分发
 * ------------------------------------------------------------------------- */

async function onIntent(intent: Intent, context: { sessionId: string; busy: boolean }): Promise<void> {
  if (handle === undefined || handle.sessionId !== context.sessionId || model === undefined) {
    return;
  }
  switch (intent.kind) {
    case 'rescanConflicts': {
      const scope = currentScope();
      if (scope === undefined) {
        return;
      }
      if (intent.scope === 'whole') {
        await scanWholeWorkCopy();
        return;
      }
      await startScan(scope, model);
      return;
    }
    case 'scanWholeWorkCopy': {
      await scanWholeWorkCopy();
      return;
    }
    case 'selectConflict': {
      selectConflictById(intent.id);
      return;
    }
    case 'setConflictTab': {
      if (model.setTab(intent.tab)) {
        push();
      }
      return;
    }
    case 'chooseConflictVariant': {
      const key = model.selectedKey();
      if (key === undefined) {
        return;
      }
      const result = model.chooseVariant(key, intent.value);
      if (result === 'disabled') {
        const matrix = model.actionMatrix(key);
        const option = matrix?.variants.find((variant) => variant.value === intent.value);
        if (option?.disabledReason !== undefined) {
          toast('info', option.disabledReason);
        }
        return;
      }
      if (result === 'selected') {
        pendingConfirm = undefined;
        push();
      }
      return;
    }
    case 'choosePropertyValue': {
      // 属性逐项选择：视图只带稳定属性名与枚举值；存在性/保留属性由模型判定。
      const key = model.selectedKey();
      if (key === undefined) {
        return;
      }
      const result = model.selectPropertyValue(key, intent.property, intent.choice);
      if (result === 'selected' || result === 'unchanged') {
        push();
      }
      return;
    }
    case 'applyConflictResolution': {
      await applySelectedResolution();
      return;
    }
    case 'prepareTreeConflict': {
      const record = selectedConflict();
      if (record === undefined) {
        toast('info', controlText('resolveTargetMissing'));
        return;
      }
      if (!record.kinds.includes('tree')) {
        toast('info', resolveRejectText('tree-invalid-strategy'));
        return;
      }
      if (model.isTreePrepared(record.id)) {
        return;
      }
      // 详情按钮只负责弹出确认；执行走横幅的 confirmTreePrepared。
      requestTreeConfirm(record.id);
      return;
    }
    case 'postponeConflict': {
      const row = model.selectedRow();
      if (row === undefined) {
        toast('info', controlText('resolveTargetMissing'));
        return;
      }
      const result = model.postpone(row.key);
      if (result === 'resolved') {
        toast('info', strings.conflictPanel.detailResolvedNote);
        return;
      }
      push();
      return;
    }
    case 'inspectConflict': {
      inspectSelectedConflict();
      return;
    }
    case 'openWorkCopyTerminal': {
      openWorkCopyTerminal();
      return;
    }
    case 'openConflictDiff': {
      await openConflictDiff();
      return;
    }
    case 'openConflictEditor': {
      await openConflictEditor();
      return;
    }
    case 'openConflictVersion': {
      await openConflictVersion(intent.role);
      return;
    }
    case 'copyConflictPath': {
      const row = model.rowByKey(intent.id);
      if (row !== undefined) {
        void vscode.env.clipboard.writeText(row.path);
      } else {
        copyConflictPath();
      }
      return;
    }
    case 'authenticateConflictSource': {
      // 远端属性值补查的认证入口：重新扫描触发 authorizeRemote 单飞补录。
      const scope = currentScope();
      if (scope !== undefined) {
        await startScan(scope, model);
      }
      return;
    }
    case 'viewTaskLog': {
      showOutput(false, 'conflict');
      return;
    }
    case 'closePanel': {
      handle?.dispose();
      return;
    }
    case 'dismissBanner': {
      if (intent.bannerId === RESOLVE_NOTICE_BANNER_ID) {
        resolveNotice = undefined;
        push();
        return;
      }
      // 模型可关闭横幅（external 边界提示）：只改会话内存，重新扫描保持关闭。
      if (model.dismissBanner(intent.bannerId)) {
        push();
      }
      return;
    }
    case 'bannerAction': {
      await handleBannerAction(intent.bannerId, intent.actionId);
      return;
    }
    case 'planConflictBatch':
    case 'startConflictBatch':
    case 'showConflictBatchResults': {
      // 批量属阶段 7：给出明确提示，不静默吞掉用户动作。
      toast('info', controlText('actionNotReady'));
      return;
    }
    default: {
      // 白名单之外的意图不会到达控制器（host.ts 已按 INTENT_KINDS 过滤），保留空兜底。
      return;
    }
  }
}

/** 横幅动作路由：确认/取消、扫描失败重试、未决记录回扫。 */
async function handleBannerAction(bannerId: string, actionId: string): Promise<void> {
  if (bannerId === TREE_CONFIRM_BANNER_ID) {
    if (actionId === 'confirmTreePrepared') {
      confirmTreePrepared();
    } else if (actionId === 'cancelConflictConfirm') {
      pendingConfirm = undefined;
      push();
    }
    return;
  }
  if (bannerId === WORKING_CONFIRM_BANNER_ID) {
    if (actionId === 'confirmWorkingApply') {
      await confirmWorkingApply();
    } else if (actionId === 'cancelConflictConfirm') {
      pendingConfirm = undefined;
      push();
    }
    return;
  }
  if (bannerId === RESOLVE_NOTICE_BANNER_ID || bannerId === PENDING_OPERATION_BANNER_ID) {
    if (actionId === 'rescanConflicts') {
      resolveNotice = undefined;
      const scope = currentScope();
      const owner = model;
      if (scope !== undefined && owner !== undefined) {
        await startScan(scope, owner);
      }
      return;
    }
    if (actionId === 'viewTaskLog') {
      showOutput(false, 'conflict');
      return;
    }
    if (actionId === 'closePanel') {
      handle?.dispose();
      return;
    }
    return;
  }
  if (bannerId === 'conflictScanFailed') {
    if (actionId === 'rescanConflicts') {
      const scope = currentScope();
      const owner = model;
      if (scope !== undefined && owner !== undefined) {
        await startScan(scope, owner);
      }
      return;
    }
    if (actionId === 'scanWholeWorkCopy') {
      await scanWholeWorkCopy();
      return;
    }
    return;
  }
}

/** 整副本扫描：同副本根、范围 '.'；当前已是整副本时直接重扫。 */
async function scanWholeWorkCopy(): Promise<void> {
  const scope = currentScope();
  if (scope === undefined || model === undefined) {
    return;
  }
  if (scope.scopeRelPath === '.') {
    await startScan(scope, model);
    return;
  }
  // 整副本扫描是写锁下也放行的独立回扫入口（不进 switchSession 的
  // busy/writeLocked 拒绝分支）：同面板换范围，旧目标回包由模型代次 +
  // 作用域守卫丢弃，并强制真实扫描（不因缓存恢复而跳过本次动作）。
  // 整副本是独立作用域页：P6 更新任务上下文只属于更新范围，切走后清除。
  entryTarget = { source: 'local', wcRoot: scope.wcRoot, scopeRelPath: '.' };
  updateTaskContext = undefined;
  await recoverSession({ forceScan: true });
}

/* ---------------------------------------------------------------------------
 * 生命周期与测试辅助
 * ------------------------------------------------------------------------- */

function onViewReady(): void {
  push();
}

/**
 * 关闭面板：只解除订阅并保存会话快照——扫描/resolve 任务继续运行，
 * 终态由执行器写 m4SessionStore 后再移除任务。
 */
function onPanelDispose(): void {
  if (model !== undefined) {
    const scope = model.scope();
    if (scope !== undefined) {
      persistConflictSession(model, { current: conflictResultScopeOf(scope) });
    }
    // 解绑任务回调：任务继续执行但不再向已销毁面板推送。
    const task = getActiveTask('conflicts');
    if (task !== undefined) {
      const extra = task.extra as ConflictTaskExtra | undefined;
      if (extra !== undefined && extra.model === model) {
        extra.callbacks = { render: () => undefined, toast: () => undefined };
      }
    }
  }
  taskRemovalSub?.dispose();
  taskRemovalSub = undefined;
  handle = undefined;
  model = undefined;
  entryTarget = undefined;
  updateTaskContext = undefined;
  pendingConfirm = undefined;
  resolveNotice = undefined;
  scanAbort = undefined;
}

/** 当前会话快照（测试断言用；真实宿主不需要）。 */
export function conflictsSessionSnapshot(): {
  scope?: ConflictScopeTarget;
  phase?: ConflictPhase;
  scanning: boolean;
  rows: number;
  selected?: string;
  ledger: number;
  postponed: number;
  unknown: number;
  pendingConfirm?: { key: string; kind: 'tree' | 'working' };
  busy: boolean;
  writeLocked: boolean;
  taskKind?: 'scan' | 'resolve';
  taskPhase?: string;
  resolveNotice?: string;
  pendingOperationId?: string;
  updateTaskContext?: {
    requestedRevision: number;
    preRevision: number;
    postNodeRevision?: number;
    outcome: string;
    conflictCount: number;
  };
} {
  const task = getActiveTask('conflicts');
  const extra = task?.extra as ConflictTaskExtra | undefined;
  const occupancy = occupancyOf();
  const owner = model;
  const scope = owner?.scope();
  const selected = owner?.selectedKey();
  const pendingRecord = pendingResolveRecord();
  return {
    ...(scope !== undefined ? { scope } : {}),
    ...(owner !== undefined ? { phase: owner.phase() } : {}),
    scanning: owner?.isScanning() ?? false,
    rows: owner?.rows().length ?? 0,
    ...(selected !== undefined ? { selected } : {}),
    ledger: owner?.ledger().length ?? 0,
    postponed: owner?.postponed().length ?? 0,
    unknown: owner === undefined
      ? 0
      : owner.rows().filter((row) => owner.isUnknown(row.key)).length,
    ...(pendingConfirm !== undefined
      ? { pendingConfirm: { key: pendingConfirm.key, kind: pendingConfirm.kind } }
      : {}),
    busy: occupancy.busy,
    writeLocked: occupancy.writeLocked,
    ...(task !== undefined ? { taskPhase: task.phase } : {}),
    ...(extra?.kind !== undefined ? { taskKind: extra.kind } : {}),
    ...(resolveNotice !== undefined ? { resolveNotice: resolveNotice.message } : {}),
    ...(pendingRecord !== undefined ? { pendingOperationId: pendingRecord.operationId } : {}),
    ...(updateTaskContext !== undefined
      ? {
          updateTaskContext: {
            requestedRevision: updateTaskContext.requestedRevision,
            preRevision: updateTaskContext.preRevision,
            ...(updateTaskContext.postNodeRevision !== undefined
              ? { postNodeRevision: updateTaskContext.postNodeRevision }
              : {}),
            outcome: updateTaskContext.outcome,
            conflictCount: updateTaskContext.conflictCount,
          },
        }
      : {}),
  };
}

/** 当前模型实例（测试断言详情/动作矩阵用；真实宿主不需要）。 */
export function conflictsModelForTest(): ConflictModel | undefined {
  return model;
}

/** 测试辅助：重置面板控制器（任务对象由任务注册表另行重置）。 */
export function resetConflictPanelController(): void {
  taskRemovalSub?.dispose();
  taskRemovalSub = undefined;
  scanAbort = undefined;
  handle?.dispose();
  handle = undefined;
  model = undefined;
  entryTarget = undefined;
  updateTaskContext = undefined;
  pendingConfirm = undefined;
  resolveNotice = undefined;
  confirmSeq = 0;
  panelContext = undefined;
}
