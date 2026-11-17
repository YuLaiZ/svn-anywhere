/**
 * P7 批量冲突处理模型（M4 阶段 7 任务 1）：路径分组计划、批量结果页与
 * 计划/结果的会话持久化形状。纯模型，不依赖 vscode，也不执行任何 SVN
 * 命令——分组只看归一化冲突记录与会话状态，执行器在 panels/conflicts.ts。
 *
 * 边界（本地 SVN 实测回填）：
 * - 批量先按规范化路径分组：同路径存在多个冲突类型时整组不直接执行
 *   （mixed-path）；同一路径出现多条单类型记录也按同路径混合处理；
 * - 普通批量只对无同路径混合的文件冲突应用用户选择的整文件策略
 *   （mine-full/theirs-full）；kind=text 含二进制子类型；属性/树冲突
 *   进不适用组；
 * - 保留属性（svn:mergeinfo 等）记录带 autoUnsupported，进不适用组；
 * - 已推迟项保留在推迟组：只展示，不执行、不改状态；
 * - 待核实（unknown）项不执行——未知状态不得继续写；
 * - wcLocked 或共享写锁未决时计划整体禁写并给出原因：计划可以生成，
 *   但不能开始（W155004 的写命令在应用层预判，不依赖 CLI 退出码）；
 * - 结果页逐项记录已解决/失败/未执行，第一项失败即停止并记录停止位置；
 *   失败后旧计划作废（planInvalidated），必须重新扫描生成新计划；
 * - 最终整范围回扫是独立阶段：成功时列表现实扫描为准，失败时明确
 *   「最终范围未核实」并保留逐项已确认结果。
 *
 * 文案默认值在 CONFLICT_BATCH_TEXT_DEFAULTS：i18n.conflictPanel 落地同
 * 名键后自动优先（与 conflictModel 的模式一致）；本文件不写业务判断之外
 * 的用户句子。
 */
import type {
  ConflictContentKind,
  ConflictKind,
  ConflictListRow,
  ConflictRecord,
  ConflictSummary,
} from '../../core/conflict';
import type { SvnAcceptValue } from '../../core/resolve';
import {
  DEFAULT_CONFLICT_BATCH_STRATEGY,
  type ConflictBatchStrategy,
} from './protocol';
import type {
  ConflictBatchGroupSpec,
  ConflictBatchResultItemSpec,
  ConflictBatchResultsSpec,
  ConflictBatchSpec,
  ConflictBatchStrategyOptionSpec,
} from './state';
import { format, strings } from '../i18n';

/* ---------------------------------------------------------------------------
 * 常量与文案
 * ------------------------------------------------------------------------- */

/** 整文件批量策略：二进制不开放冲突块变体，文本也只开放整文件结果。 */
export const CONFLICT_BATCH_WHOLE_VARIANTS: readonly SvnAcceptValue[] = ['mine-full', 'theirs-full'];

/** 计划/结果持久化形状版本（结构变化时旧缓存按 fresh 处理）。 */
export const CONFLICT_BATCH_STATE_VERSION = 1;

/**
 * 批量文案默认值（i18n.conflictPanel 落地同名键后自动优先取 i18n；
 * 导出供文案漂移对账测试）。batchUnsupported* 与 conflictModel 旧表同键
 * 同值——批量适用性文案只在两处共享的 i18n 键上维护。
 */
export const CONFLICT_BATCH_TEXT_DEFAULTS = {
  batchPlanHeading: '批量处理计划',
  batchResultsHeading: '批量处理结果',
  batchStrategyLabel: '策略',
  batchStrategyTheirs: '使用传入内容（仅文件冲突）',
  batchStrategyMine: '保留本地内容（仅文件冲突）',
  batchSummaryRoot: '工作副本根',
  batchSummaryScope: '范围',
  batchSummaryStrategy: '策略',
  batchScopeWhole: '整个工作副本',
  batchGroupApplicable: '将执行（{count}）',
  batchGroupUnsupported: '不执行（{count}）',
  batchGroupPostponed: '已推迟（{count}）',
  batchApplicableNote: '整文件策略 {strategy}',
  batchStart: '开始批量处理',
  batchAction: '批量处理',
  batchStartDisabledNoApplicable: '没有可执行项，不能开始批量处理。',
  batchShowResults: '查看批量结果',
  batchPlanInvalidated: '本计划已作废；必须重新扫描并生成新计划后才能再次执行。',
  batchResultsChipResolved: '已解决 {count}',
  batchResultsChipFailed: '失败 {count}',
  batchResultsChipUnknown: '待核实 {count}',
  batchResultsChipNotRun: '未执行 {count}',
  batchResultsChipRemaining: '仍冲突 {count}',
  batchStoppedNote: '在第 {index}/{total} 项停止：{path}；原因：{reason}',
  batchRescanDoneNote: '最终范围回扫完成：仍冲突 {count} 项。',
  batchRescanFailedNote: '最终范围未核实：{message}',
  batchItemResolved: '已解决（{strategy}）',
  batchItemFailed: '失败',
  batchItemUnknown: '待核实',
  batchItemNotRun: '未执行',
  batchItemPending: '等待',
  batchItemRunning: '执行中',
  batchBlockedWcLocked: '工作副本被锁定：批量处理不能写入，请先执行「清理」。',
  batchBlockedWriteLocked: '存在未完成的写入操作：批量处理不能开始，请先重新扫描核实。',
  batchNeedPlan: '请先生成批量处理计划。',
  batchNoApplicable: '没有可执行项，不能开始批量处理。',
  batchStarted: '正在执行批量处理（{count} 项）…',
  batchFingerprintChanged: '冲突状态在读取后发生变化，批量已停止。',
  batchFingerprintReadFailed: '重新读取冲突指纹失败：{message}',
  batchBeginHeld: '写操作被其他任务占用，批量已停止。',
  batchUnknownStop: '当前项结果未知，写操作受限；请重新扫描核实。',
  batchRescanStale: '回扫结果已过期（会话已切换），最终范围未核实。',
  batchUnsupportedMixed: '不适用：同路径混合冲突需要交互处理',
  batchUnsupportedProperty: '不适用：属性冲突需要逐项选择',
  batchUnsupportedTree: '不适用：树冲突需要节点确认',
  batchUnsupportedAuto: '不适用：保留属性需要检查器处理',
  batchUnsupportedUnknown: '不适用：内容类型未知',
  batchUnsupportedUnknownState: '不适用：状态待核实',
} as const;

export type ConflictBatchTextKey = keyof typeof CONFLICT_BATCH_TEXT_DEFAULTS;

interface PanelStrings {
  readonly [key: string]: string | undefined;
}

function conflictPanelStrings(): PanelStrings | undefined {
  return (strings as unknown as { conflictPanel?: PanelStrings }).conflictPanel;
}

/** 取批量文案：优先 i18n.conflictPanel，回落本地默认中文；支持 {name} 占位。 */
export function conflictBatchText(key: ConflictBatchTextKey, params: Record<string, string> = {}): string {
  const override = conflictPanelStrings()?.[key];
  return format(override ?? CONFLICT_BATCH_TEXT_DEFAULTS[key], params);
}

/* ---------------------------------------------------------------------------
 * 批量适用性（阶段 5 模型已使用；阶段 7 计划的分组依据）
 * ------------------------------------------------------------------------- */

/** 批量不适用原因（unknown-state 为阶段 7 新增：待核实项不执行）。 */
export type ConflictBatchUnsupportedReason =
  | 'mixed-path'
  | 'property'
  | 'tree'
  | 'auto-unsupported'
  | 'unknown-content'
  | 'unknown-state';

export interface ConflictBatchApplicability {
  applicable: boolean;
  unsupportedReason?: ConflictBatchUnsupportedReason;
  /** 可执行项的整文件策略（文本/二进制都只开放 mine-full/theirs-full）。 */
  variants: readonly SvnAcceptValue[];
}

/** 批量适用性：混合路径/属性/树/保留属性/类型未知不进入自动批量。 */
export function batchApplicabilityOf(record: ConflictRecord): ConflictBatchApplicability {
  if (record.kinds.length > 1) {
    return { applicable: false, unsupportedReason: 'mixed-path', variants: [] };
  }
  if (record.kinds.includes('property')) {
    const autoUnsupported = record.propertyConflicts !== undefined
      && record.propertyConflicts.length > 0
      && record.propertyConflicts.every((property) => property.autoUnsupported);
    return {
      applicable: false,
      unsupportedReason: autoUnsupported ? 'auto-unsupported' : 'property',
      variants: [],
    };
  }
  if (record.kinds.includes('tree')) {
    return { applicable: false, unsupportedReason: 'tree', variants: [] };
  }
  if (record.contentKind === 'unknown') {
    return { applicable: false, unsupportedReason: 'unknown-content', variants: [] };
  }
  return { applicable: true, variants: [...CONFLICT_BATCH_WHOLE_VARIANTS] };
}

/** 批量不适用原因文案（计划与详情共用）。 */
export function batchUnsupportedText(reason: ConflictBatchUnsupportedReason): string {
  switch (reason) {
    case 'mixed-path':
      return conflictBatchText('batchUnsupportedMixed');
    case 'property':
      return conflictBatchText('batchUnsupportedProperty');
    case 'tree':
      return conflictBatchText('batchUnsupportedTree');
    case 'auto-unsupported':
      return conflictBatchText('batchUnsupportedAuto');
    case 'unknown-content':
      return conflictBatchText('batchUnsupportedUnknown');
    case 'unknown-state':
      return conflictBatchText('batchUnsupportedUnknownState');
  }
}

/* ---------------------------------------------------------------------------
 * 计划
 * ------------------------------------------------------------------------- */

/** 计划/结果共享的作用域形状（与任务注册表的 conflicts 作用域同字段）。 */
export interface ConflictBatchScope {
  wcRoot: string;
  scopeRelPath: string;
}

/** 可执行项：冲突指纹 + 整文件策略（执行前重读指纹比对用）。 */
export interface ConflictBatchPlanItem {
  key: string;
  path: string;
  kinds: ConflictKind[];
  contentKind: ConflictContentKind;
  strategy: ConflictBatchStrategy;
}

/** 不适用项：保留在计划中只作展示与解释，不进入执行。 */
export interface ConflictBatchUnsupportedItem {
  key: string;
  path: string;
  kinds: ConflictKind[];
  reason: ConflictBatchUnsupportedReason;
  reasonText: string;
}

/** 推迟项：保留在计划中只作展示，不执行、不改状态。 */
export interface ConflictBatchPostponedItem {
  key: string;
  path: string;
  kinds: ConflictKind[];
}

/** 计划整体禁写原因：wcLocked 优先于共享写锁。 */
export type ConflictBatchBlockReason = 'wc-locked' | 'write-locked';

/**
 * 批量执行计划（冻结会话状态）：三组路径 + 选中策略 + 整体禁写原因。
 * planId 同时作为批量父任务 ID 与批内 operation record 的 batchId。
 */
export interface ConflictBatchPlan {
  planId: string;
  scope: ConflictBatchScope;
  createdAt: number;
  strategy: ConflictBatchStrategy;
  applicable: ConflictBatchPlanItem[];
  unsupported: ConflictBatchUnsupportedItem[];
  postponed: ConflictBatchPostponedItem[];
  writeBlocked: boolean;
  writeBlockedReason?: ConflictBatchBlockReason;
}

export interface PlanConflictBatchInput {
  planId: string;
  scope: ConflictBatchScope;
  /** 模型当前列表行（含台账合并后的 resolved/postponed 状态）。 */
  rows: readonly ConflictListRow[];
  /** 本会话待核实行指纹（不执行；unknown-state）。 */
  unknownKeys?: ReadonlySet<string>;
  /** 最近一次真实扫描的 wc-locked 信号。 */
  wcLocked: boolean;
  /** 共享写锁未决（其他面板写入或本会话未决记录）：可生成计划但不可开始。 */
  writeLocked?: boolean;
  strategy: ConflictBatchStrategy;
  now?: () => number;
}

/**
 * 生成路径分组计划（纯函数）：
 * 1. 已解决行不进计划（台账不参与未解决批量）；推迟行保留到推迟组；
 * 2. 先按规范化路径分组，同路径多条记录（或单条多类型）整组不执行；
 * 3. 待核实项进不适用组（unknown-state）；
 * 4. 其余按 batchApplicabilityOf 分入可执行/不适用；
 * 5. wcLocked/共享写锁只标记 writeBlocked 与原因，不阻止生成计划
 *    （用户需要看到实际路径与不适用原因后再决定）。
 */
export function planConflictBatch(input: PlanConflictBatchInput): ConflictBatchPlan {
  const now = input.now ?? (() => Date.now());
  const groups = new Map<string, ConflictListRow[]>();
  for (const row of input.rows) {
    if (row.status === 'resolved') {
      continue;
    }
    const list = groups.get(row.path);
    if (list === undefined) {
      groups.set(row.path, [row]);
    } else {
      list.push(row);
    }
  }
  const applicable: ConflictBatchPlanItem[] = [];
  const unsupported: ConflictBatchUnsupportedItem[] = [];
  const postponed: ConflictBatchPostponedItem[] = [];
  for (const [path, group] of groups) {
    const samePathMixed = group.length > 1;
    for (const row of group) {
      if (row.status === 'postponed') {
        postponed.push({ key: row.key, path, kinds: [...row.kinds] });
        continue;
      }
      if (input.unknownKeys?.has(row.key) === true) {
        unsupported.push(unsupportedItem(path, row, 'unknown-state'));
        continue;
      }
      const record = row.record;
      if (record === undefined) {
        unsupported.push(unsupportedItem(path, row, 'unknown-state'));
        continue;
      }
      if (samePathMixed) {
        unsupported.push(unsupportedItem(path, row, 'mixed-path'));
        continue;
      }
      const applicability = batchApplicabilityOf(record);
      if (!applicability.applicable) {
        unsupported.push(unsupportedItem(path, row, applicability.unsupportedReason ?? 'unknown-content'));
        continue;
      }
      applicable.push({
        key: row.key,
        path,
        kinds: [...row.kinds],
        contentKind: record.contentKind,
        strategy: input.strategy,
      });
    }
  }
  const plan: ConflictBatchPlan = {
    planId: input.planId,
    scope: { ...input.scope },
    createdAt: now(),
    strategy: input.strategy,
    applicable,
    unsupported,
    postponed,
    writeBlocked: input.wcLocked || input.writeLocked === true,
  };
  if (input.wcLocked) {
    plan.writeBlockedReason = 'wc-locked';
  } else if (input.writeLocked === true) {
    plan.writeBlockedReason = 'write-locked';
  }
  return plan;
}

function unsupportedItem(
  path: string,
  row: ConflictListRow,
  reason: ConflictBatchUnsupportedReason,
): ConflictBatchUnsupportedItem {
  return {
    key: row.key,
    path,
    kinds: [...row.kinds],
    reason,
    reasonText: batchUnsupportedText(reason),
  };
}

/* ---------------------------------------------------------------------------
 * 结果
 * ------------------------------------------------------------------------- */

export type ConflictBatchItemState = 'pending' | 'running' | 'resolved' | 'failed' | 'unknown' | 'not-run';

/** 逐项结果：指纹 + 策略 + 终态；operationId 只在已 begin 的项上出现。 */
export interface ConflictBatchItemResult {
  key: string;
  path: string;
  kinds: ConflictKind[];
  strategy: ConflictBatchStrategy;
  state: ConflictBatchItemState;
  operationId?: string;
  /** 失败/未知/执行中说明（宿主文案；不含属性值或文件内容）。 */
  detail?: string;
}

/** 最终整范围回扫状态：pending → scanned/failed；失败时必须明确未核实。 */
export interface ConflictBatchRescan {
  outcome: 'pending' | 'scanned' | 'failed';
  summary?: ConflictSummary;
  message?: string;
}

/**
 * 批量结果页模型：逐项结果、停止位置与未执行项。执行器每完成一项
 * 就更新本对象；失败时 planInvalidated=true，旧计划不得自动续跑。
 */
export interface ConflictBatchResult {
  planId: string;
  scope: ConflictBatchScope;
  strategy: ConflictBatchStrategy;
  startedAt: number;
  finishedAt?: number;
  items: ConflictBatchItemResult[];
  /** 停止位置（items 下标，0 基）；全部完成时缺省。 */
  stoppedIndex?: number;
  stoppedPath?: string;
  stopReason?: string;
  /** 是否因失败停止（false=全部成功）。 */
  failed: boolean;
  /** 失败后旧计划作废：必须重新扫描生成新计划才能再次执行。 */
  planInvalidated: boolean;
  rescan: ConflictBatchRescan;
}

/** 新建结果对象：全部可执行项初始为 pending（不复制不适用/推迟项）。 */
export function createConflictBatchResult(plan: ConflictBatchPlan, now?: () => number): ConflictBatchResult {
  return {
    planId: plan.planId,
    scope: { ...plan.scope },
    strategy: plan.strategy,
    startedAt: (now ?? (() => Date.now()))(),
    items: plan.applicable.map((item) => ({
      key: item.key,
      path: item.path,
      kinds: [...item.kinds],
      strategy: item.strategy,
      state: 'pending',
    })),
    failed: false,
    planInvalidated: false,
    rescan: { outcome: 'pending' },
  };
}

/**
 * 停止/完成结算（幂等纯函数）：剩余 pending 项标记未执行，记录停止位置
 * 与原因；失败即作废旧计划。全部成功时不设置停止位置。
 */
export function settleConflictBatchResult(
  result: ConflictBatchResult,
  stop?: { index: number; reason: string },
  now?: () => number,
): ConflictBatchResult {
  for (const item of result.items) {
    if (item.state === 'pending') {
      item.state = 'not-run';
    }
  }
  if (stop !== undefined) {
    result.stoppedIndex = stop.index;
    result.stoppedPath = result.items[stop.index]?.path;
    result.stopReason = stop.reason;
    result.failed = true;
    result.planInvalidated = true;
  } else {
    delete result.stoppedIndex;
    delete result.stoppedPath;
    delete result.stopReason;
    result.failed = result.items.some((item) => item.state !== 'resolved');
    result.planInvalidated = result.failed;
  }
  result.finishedAt = (now ?? (() => Date.now()))();
  return result;
}

/** 结果摘要计数（chips 数据源；pending/running 只在执行中出现）。 */
export interface ConflictBatchResultCounts {
  resolved: number;
  failed: number;
  unknown: number;
  notRun: number;
  pending: number;
  running: number;
}

export function summarizeConflictBatchResult(result: ConflictBatchResult): ConflictBatchResultCounts {
  const counts: ConflictBatchResultCounts = {
    resolved: 0,
    failed: 0,
    unknown: 0,
    notRun: 0,
    pending: 0,
    running: 0,
  };
  for (const item of result.items) {
    switch (item.state) {
      case 'resolved':
        counts.resolved += 1;
        break;
      case 'failed':
        counts.failed += 1;
        break;
      case 'unknown':
        counts.unknown += 1;
        break;
      case 'not-run':
        counts.notRun += 1;
        break;
      case 'running':
        counts.running += 1;
        break;
      default:
        counts.pending += 1;
        break;
    }
  }
  return counts;
}

/* ---------------------------------------------------------------------------
 * 会话持久化形状（m4SessionStore.browsable.batch）
 * ------------------------------------------------------------------------- */

/**
 * 批量计划/结果随 browsable 一起持久化：关闭面板任务继续，重开后从
 * 任务注册表或本状态恢复；宿主重启后自然丢弃（真实 SVN 状态为准，
 * operation record 的 unknown 驱动回扫）。
 */
export interface ConflictBatchPersistState {
  version: number;
  mode: 'plan' | 'results';
  plan?: ConflictBatchPlan;
  result?: ConflictBatchResult;
}

/** 形状校验：只接受本版本、字段齐备的计划/结果（失败按 fresh 处理）。 */
export function isConflictBatchPersistState(value: unknown): value is ConflictBatchPersistState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<ConflictBatchPersistState>;
  if (record.version !== CONFLICT_BATCH_STATE_VERSION) {
    return false;
  }
  if (record.mode !== 'plan' && record.mode !== 'results') {
    return false;
  }
  if (record.plan !== undefined && !isPlanShape(record.plan)) {
    return false;
  }
  if (record.result !== undefined && !isResultShape(record.result)) {
    return false;
  }
  return record.plan !== undefined || record.result !== undefined;
}

function isScopeShape(value: unknown): value is ConflictBatchScope {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const scope = value as Partial<ConflictBatchScope>;
  return typeof scope.wcRoot === 'string' && typeof scope.scopeRelPath === 'string';
}

function isPlanShape(value: unknown): value is ConflictBatchPlan {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const plan = value as Partial<ConflictBatchPlan>;
  return typeof plan.planId === 'string'
    && isScopeShape(plan.scope)
    && (plan.strategy === 'mine-full' || plan.strategy === 'theirs-full')
    && Array.isArray(plan.applicable)
    && Array.isArray(plan.unsupported)
    && Array.isArray(plan.postponed)
    && typeof plan.writeBlocked === 'boolean';
}

function isResultShape(value: unknown): value is ConflictBatchResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const result = value as Partial<ConflictBatchResult>;
  return typeof result.planId === 'string'
    && isScopeShape(result.scope)
    && (result.strategy === 'mine-full' || result.strategy === 'theirs-full')
    && typeof result.startedAt === 'number'
    && Array.isArray(result.items)
    && typeof result.failed === 'boolean'
    && typeof result.planInvalidated === 'boolean'
    && typeof result.rescan === 'object'
    && result.rescan !== null;
}

/* ---------------------------------------------------------------------------
 * 渲染规格（计划/结果区）
 * ------------------------------------------------------------------------- */

export interface BuildConflictBatchSpecInput {
  plan?: ConflictBatchPlan;
  result?: ConflictBatchResult;
  mode: 'plan' | 'results';
  /** 最近真实扫描的未解决计数（结果页「仍冲突」chip；缺省不显示）。 */
  remaining?: number;
  /** 回扫尚未发生/进行中时结果页不显示回扫结论。 */
  now?: () => number;
}

const STRATEGY_TEXT_KEYS: Record<ConflictBatchStrategy, ConflictBatchTextKey> = {
  'theirs-full': 'batchStrategyTheirs',
  'mine-full': 'batchStrategyMine',
};

/** 策略枚举 → 展示标签（计划与结果共用；宿主 i18n）。 */
export function conflictBatchStrategyLabel(strategy: ConflictBatchStrategy): string {
  return conflictBatchText(STRATEGY_TEXT_KEYS[strategy]);
}

/**
 * 构建批量计划/结果区（纯函数）：
 * - mode='results' 且存在结果 → 结果页（逐项状态/停止位置/回扫说明）；
 * - 否则存在计划 → 计划页（概要/策略选择/三组/开始与查看结果动作）；
 * - 两者皆无 → undefined（面板不渲染批量区）。
 */
export function buildConflictBatchSpec(input: BuildConflictBatchSpecInput): ConflictBatchSpec | undefined {
  const { plan, result } = input;
  if (input.mode === 'results' && result !== undefined) {
    return resultsSpec(result, input.remaining);
  }
  if (plan !== undefined) {
    return planSpec(plan, result);
  }
  if (result !== undefined) {
    return resultsSpec(result, input.remaining);
  }
  return undefined;
}

function planSpec(plan: ConflictBatchPlan, result: ConflictBatchResult | undefined): ConflictBatchSpec {
  const strategies: ConflictBatchStrategyOptionSpec[] = (['theirs-full', 'mine-full'] as const).map((value) => ({
    value,
    label: conflictBatchStrategyLabel(value),
    selected: plan.strategy === value,
  }));
  const groups: ConflictBatchGroupSpec[] = [
    {
      id: 'applicable',
      title: format(conflictBatchText('batchGroupApplicable'), {
        count: String(plan.applicable.length),
      }),
      items: plan.applicable.map((item) => ({
        path: item.path,
        note: format(conflictBatchText('batchApplicableNote'), {
          strategy: conflictBatchStrategyLabel(item.strategy),
        }),
      })),
    },
    {
      id: 'unsupported',
      title: format(conflictBatchText('batchGroupUnsupported'), {
        count: String(plan.unsupported.length),
      }),
      items: plan.unsupported.map((item) => ({ path: item.path, note: item.reasonText })),
    },
    {
      id: 'postponed',
      title: format(conflictBatchText('batchGroupPostponed'), {
        count: String(plan.postponed.length),
      }),
      items: plan.postponed.map((item) => ({ path: item.path })),
    },
  ];
  // 失败后旧计划作废：开始入口保持禁用，必须重新扫描生成新计划。
  // 只有同一 planId 的结果才把当前计划标记为已作废（新计划不受旧结果阻塞）。
  const invalidated = result !== undefined && result.planInvalidated && result.planId === plan.planId;
  const startDisabled = plan.writeBlocked || plan.applicable.length === 0 || invalidated;
  const startReason = plan.writeBlocked
    ? blockReasonText(plan.writeBlockedReason)
    : plan.applicable.length === 0
      ? conflictBatchText('batchStartDisabledNoApplicable')
      : invalidated
        ? conflictBatchText('batchPlanInvalidated')
        : undefined;
  const start: ConflictBatchSpec['actions'][number] = {
    id: 'startConflictBatch',
    label: conflictBatchText('batchStart'),
    disabled: startDisabled,
  };
  if (startDisabled && startReason !== undefined) {
    start.disabledReason = startReason;
  }
  const actions: ConflictBatchSpec['actions'] = [start];
  if (result !== undefined) {
    actions.push({ id: 'showConflictBatchResults', label: conflictBatchText('batchShowResults') });
  }
  const spec: ConflictBatchSpec = {
    id: `conflict-batch-${plan.planId}`,
    heading: conflictBatchText('batchPlanHeading'),
    mode: 'plan',
    summary: summarizePlan(plan),
    strategyLabel: conflictBatchText('batchStrategyLabel'),
    strategies,
    groups,
    actions,
  };
  const blocked = plan.writeBlocked
    ? blockReasonText(plan.writeBlockedReason)
    : invalidated
      ? conflictBatchText('batchPlanInvalidated')
      : undefined;
  if (blocked !== undefined) {
    spec.blockedReason = blocked;
  }
  return spec;
}

function summarizePlan(plan: ConflictBatchPlan): ConflictBatchSpec['summary'] {
  return [
    { label: conflictBatchText('batchSummaryRoot'), value: plan.scope.wcRoot, mono: true },
    {
      label: conflictBatchText('batchSummaryScope'),
      value: plan.scope.scopeRelPath === '.' ? conflictBatchText('batchScopeWhole') : plan.scope.scopeRelPath,
      mono: true,
    },
    { label: conflictBatchText('batchSummaryStrategy'), value: conflictBatchStrategyLabel(plan.strategy) },
  ];
}

function blockReasonText(reason: ConflictBatchBlockReason | undefined): string {
  switch (reason) {
    case 'write-locked':
      return conflictBatchText('batchBlockedWriteLocked');
    case 'wc-locked':
    default:
      return conflictBatchText('batchBlockedWcLocked');
  }
}

function resultsSpec(result: ConflictBatchResult, remaining: number | undefined): ConflictBatchSpec {
  const counts = summarizeConflictBatchResult(result);
  const chips: ConflictBatchResultsSpec['chips'] = [];
  if (counts.resolved > 0) {
    chips.push({
      label: format(conflictBatchText('batchResultsChipResolved'), { count: String(counts.resolved) }),
      kind: 'ok',
    });
  }
  if (counts.failed > 0) {
    chips.push({
      label: format(conflictBatchText('batchResultsChipFailed'), { count: String(counts.failed) }),
      kind: 'error',
    });
  }
  if (counts.unknown > 0) {
    chips.push({
      label: format(conflictBatchText('batchResultsChipUnknown'), { count: String(counts.unknown) }),
      kind: 'warn',
    });
  }
  if (counts.notRun > 0) {
    chips.push({
      label: format(conflictBatchText('batchResultsChipNotRun'), { count: String(counts.notRun) }),
      kind: 'warn',
    });
  }
  if (remaining !== undefined) {
    chips.push({
      label: format(conflictBatchText('batchResultsChipRemaining'), { count: String(remaining) }),
      kind: remaining > 0 ? 'error' : 'ok',
    });
  }
  const items: ConflictBatchResultItemSpec[] = result.items.map((item) => ({
    path: item.path,
    state: item.state,
    stateLabel: itemStateLabel(item),
    ...(item.detail !== undefined ? { detail: item.detail } : {}),
  }));
  const results: ConflictBatchResultsSpec = {
    title: conflictBatchText('batchResultsHeading'),
    chips,
    items,
  };
  if (result.stoppedIndex !== undefined) {
    results.stoppedNote = format(conflictBatchText('batchStoppedNote'), {
      index: String(result.stoppedIndex + 1),
      total: String(result.items.length),
      path: result.stoppedPath ?? '',
      reason: result.stopReason ?? '',
    });
  }
  if (result.rescan.outcome === 'scanned') {
    results.rescanNote = format(conflictBatchText('batchRescanDoneNote'), {
      count: String(result.rescan.summary?.total ?? remaining ?? 0),
    });
  } else if (result.rescan.outcome === 'failed') {
    results.rescanNote = format(conflictBatchText('batchRescanFailedNote'), {
      message: result.rescan.message ?? '',
    });
  }
  return {
    id: `conflict-batch-${result.planId}`,
    heading: conflictBatchText('batchResultsHeading'),
    mode: 'results',
    summary: [
      { label: conflictBatchText('batchSummaryRoot'), value: result.scope.wcRoot, mono: true },
      {
        label: conflictBatchText('batchSummaryScope'),
        value: result.scope.scopeRelPath === '.' ? conflictBatchText('batchScopeWhole') : result.scope.scopeRelPath,
        mono: true,
      },
      { label: conflictBatchText('batchSummaryStrategy'), value: conflictBatchStrategyLabel(result.strategy) },
    ],
    strategyLabel: conflictBatchText('batchStrategyLabel'),
    strategies: [],
    groups: [],
    actions: [],
    results,
  };
}

function itemStateLabel(item: ConflictBatchItemResult): string {
  switch (item.state) {
    case 'resolved':
      return format(conflictBatchText('batchItemResolved'), {
        strategy: conflictBatchStrategyLabel(item.strategy),
      });
    case 'failed':
      return conflictBatchText('batchItemFailed');
    case 'unknown':
      return conflictBatchText('batchItemUnknown');
    case 'not-run':
      return conflictBatchText('batchItemNotRun');
    case 'running':
      return conflictBatchText('batchItemRunning');
    default:
      return conflictBatchText('batchItemPending');
  }
}

/** 默认批量策略（协议缺省时控制器使用）。 */
export function defaultConflictBatchStrategy(): ConflictBatchStrategy {
  return DEFAULT_CONFLICT_BATCH_STRATEGY;
}
