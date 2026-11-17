/**
 * P6 历史与版本比较：面板模型（纯状态机与渲染，不依赖 vscode）。
 *
 * 语义来源（本地 SVN 实测回填）：
 * - 会话状态机复用 core/history：首批 / 加载更多、每批 historyPageSize、
 *   单源 cursor、多源 source 栈、每轮独立的 500 条原始回包预算、
 *   六类计数、5,000 命中 / 100,000 扫描上限与 pending 展示；
 * - upper 三字段（upperRevision/upperSource/headState）只由本模型的
 *   applyResolvedUpper / applyUnresolved / applyUpperRefresh /
 *   applyBaseFallbackSuccess 写入；resetHistorySession 从不改变三字段，
 *   unresolved 状态下拒绝；
 * - 筛选变化只重算已加载记录的展示前缀（不重建源栈、不重发网络），
 *   同时清空不可见勾选与详情、不自动选第一条；follow（跟随复制/停在
 *   复制点）变化才重建源栈并重读首批；
 * - 表格使用 append 分页（displayedCount 条展示前缀，total=visibleMatched），
 *   勾选最多两项；点击行只更新详情，详情异步解析「所选 revision 的实际
 *   节点」（resolution 由控制器注入）；
 * - 「与上一条可见记录比较」只取当前筛选、当前已加载批次中的下一条
 *   可见记录，到批次边界禁用并提示加载更多；快捷版本对不改写手动勾选。
 *
 * 模型只持有业务状态与渲染数据；SVN IO、读请求票据、面板生命周期与
 * m4SessionStore 持久化由 panels/history.ts 控制器承担。
 */
import {
  applyHistoryLogPage,
  applyHistoryUpperRefresh,
  beginHistoryLoadMore,
  canRefreshHistoryUpper,
  classifyHistoryOutcome,
  clearHistorySessionData,
  createAncestorFilterSource,
  createHistorySession,
  createTargetSource,
  createUnresolvedHistorySession,
  finishHistoryLoadMore,
  formatLogDate,
  historyEntryMatches,
  HISTORY_PAGE_SIZES,
  isHistoryDateRangeReversed,
  nextHistoryLogRequest,
  normalizeHistoryPageSize,
  recomputeHistoryView,
  resetHistorySession,
  updateHistoryDerivedCounters,
  type HistoryEntry,
  type HistoryFilter,
  type HistoryHeadState,
  type HistoryLimits,
  type HistoryLimitReason,
  type HistoryLoadMode,
  type HistoryLogPage,
  type HistoryLogRequest,
  type HistoryOutcome,
  type HistorySession,
  type HistorySource,
  type HistoryTarget,
  type HistoryUpperRefreshCheck,
  type HistoryUpperRefreshMode,
  type HistoryUpperSource,
} from '../../core/history';
import type { BrowserError } from '../../core/remoteBrowse';
import type { ConflictRecord, ConflictSummary } from '../../core/conflict';
import type {
  HistoryUpdateIntent,
  HistoryUpdateOutputHint,
  HistoryUpdateRescan,
  HistoryUpdateResult,
  HistoryUpdateTaskContext,
} from '../../core/historyUpdate';
import { format, strings } from '../i18n';
import {
  appendPagination,
  type ActionSpec,
  type BannerSpec,
  type DetailSectionSpec,
  type DetailSpec,
  type FilterPanelFieldSpec,
  type PanelState,
  type TableRowSpec,
  type TableSpec,
} from './state';

/* ---------------------------------------------------------------------------
 * 常量与文案
 * ------------------------------------------------------------------------- */

/** 历史表格组件 ID（append 分页 + revision 勾选）。 */
export const HISTORY_TABLE_ID = 'history';

/** 筛选面板 ID（意图 setHistoryFilter 的面板定位键）。 */
export const HISTORY_FILTER_PANEL_ID = 'history-filters';

/** 详情变更路径折叠阈值：超过后其余收进「查看全部变更路径」。 */
export const HISTORY_PATHS_COLLAPSE_AFTER = 12;

/** 会话持久化形状版本（结构变化时旧缓存按 fresh 处理）。 */
export const HISTORY_BROWSABLE_VERSION = 1;

/**
 * 模型本地文案（i18n.historyPanel 落地前的默认值；落地后自动优先取
 * i18n，与 P5 browseModel 的 BROWSE_TEXT_DEFAULTS 同一模式）。导出供
 * 文案漂移对账测试（同键同值；漂移视为回归）。
 */
export const HISTORY_TEXT_DEFAULTS = {
  panelTitle: '历史',
  masterLabel: '历史记录',
  detailLabel: '提交详情',
  columnRevision: 'Revision',
  columnMessage: '提交说明',
  columnAuthor: '作者',
  columnDate: '日期',
  columnChangedPaths: '变更路径',
  selectionAriaLabel: '选择 revision 进行比较（最多两个）',
  loadMore: '加载更多',
  loadMoreLoading: '正在加载更多历史…',
  loadMoreAllLoaded: '已加载全部匹配记录',
  resetSession: '清除该目标历史会话并重新读取',
  refreshHead: '刷新 HEAD',
  tryBaseUpper: '尝试按 BASE 上限查看',
  retry: '重试',
  retryLoad: '重试读取',
  clearFilters: '清空筛选',
  filterTitle: '筛选与历史范围',
  filterKeyword: '关键词',
  filterAuthor: '作者',
  filterDateFrom: '起始日期',
  filterDateTo: '结束日期',
  filterPath: '路径',
  filterFollow: '复制历史',
  filterPageSize: '每批数量',
  pageSizeOption: '{count} 条',
  followOptionFollow: '跟随复制历史',
  followOptionStop: '停在复制点',
  filterAllAuthors: '全部作者',
  dateRangeReversed: '起始日期晚于结束日期，日期筛选未应用；请修正后重试',
  selectionLimit: '最多选择两个 revision；请先取消一个再选择',
  openingTitle: '正在读取历史…',
  openingDetail: '正在解析仓库 HEAD 与目标在该 revision 的存在性。',
  detailEmpty: '选择左侧 revision 查看提交详情。',
  detailLoading: '正在解析该 revision 的实际节点…',
  targetKindFile: '文件',
  targetKindDir: '目录',
  baseBadge: 'BASE r{revision}',
  headBadge: 'HEAD r{revision}',
  snapshotBadge: '快照 r{revision}',
  baseUpperBadge: 'BASE 上限 r{revision}',
  headUnknownBadge: 'HEAD 未知',
  detailRevision: 'revision',
  detailAuthor: '作者',
  detailDate: '时间',
  detailMessageHeading: '提交说明',
  detailNodeState: '节点存在性',
  detailNodePresent: '存在于该 revision',
  detailNodeAbsent: '该 revision 不存在（删除提交 r{revision}）',
  detailNodeAbsentUnknown: '该 revision 不存在',
  detailNodeNotFound: '无法在该 revision 定位实际节点',
  detailNodeError: '节点解析失败：{message}',
  detailActualPath: '实际节点路径',
  detailActualUrl: '实际节点 URL',
  detailActionsHeading: '可用动作',
  detailActionsFile: '可打开此版本内容、导出此版本、逐行追溯。',
  detailActionsDir: '可检出此版本（远端目录）；目录不提供逐行追溯。',
  detailActionsDeleted: '可导出删除前版本；不能打开内容、追溯或更新。',
  detailActionsNotFound: '不提供打开、导出或更新动作。',
  detailActionsCopySource: '该 revision 经由复制来源 {path}；复制来源可查看/导出，当前新路径更新禁用。',
  detailActionsLocalUpdate: '本地目标可更新到此版本（更新将改变工作副本）。',
  detailActionsLoading: '解析完成后给出可用动作。',
  detailActionsError: '解析失败期间动作不可用。',
  detailPathsHeading: '变更路径（{count}）',
  detailPathsEmpty: '该记录没有变更路径信息。',
  detailPathsMore: '查看全部变更路径',
  detailPathCopyFrom: '复制自',
  detailCopyWindowHeading: '复制窗口',
  copyMessage: '复制提交说明',
  copyRevision: '复制 revision',
  copyPaths: '复制变更路径',
  copyNodeUrl: '复制节点 URL',
  copyTargetPath: '复制当前目标路径',
  copied: '已复制：{value}',
  copyFailed: '复制到剪贴板失败：{message}',
  previousCompare: '与上一条可见记录比较',
  previousBoundary: '已是最后一条已加载记录；加载更多后可继续比较',
  compareNotReady: '版本比较功能将在后续阶段接入。',
  compareNeedsTwo: '请在列表中勾选两个 revision 后再比较。',
  compareSelected: '比较所选版本',
  actionNotReady: '该动作将在后续阶段接入。',
  detailActionExport: '导出此版本',
  detailActionView: '查看此版本',
  detailActionBlame: '逐行追溯',
  detailActionUpdate: '更新到此版本',
  detailActionCheckout: '检出此版本',
  detailActionCompareBase: '与本地 BASE 比较',
  detailActionDisabledDir: '目录不提供该动作',
  detailActionDisabledNotLocal: '仅本地目标可用',
  detailActionDisabledCopySource: '复制来源路径不能执行该动作',
  detailActionDisabledDeleted: '删除提交没有可执行的内容动作',
  compareClose: '关闭比较',
  compareLoading: '正在解析两端快照与候选差异…',
  compareSummary: '比较 r{left} ↔ r{right}：候选 {count} 个',
  compareError: '比较失败：{message}',
  candidateDetailEmpty: '选择候选查看两端版本与打开差异。',
  candidateHeading: '候选详情',
  candidateStatusLabel: '状态',
  candidatePathLabel: '候选路径',
  candidateLeftHeading: '左端 r{revision}',
  candidateRightHeading: '右端 r{revision}',
  candidateOpenDiff: '打开差异',
  candidateOpenExternal: '外部打开此版本',
  candidateDiffUnavailable: '该候选不提供文本差异（二进制、属性或无差异）。',
  candidateOpenFailed: '打开差异失败：{message}',
  roundNoMatch: '本轮已处理 {count} 条原始记录（本轮唯一 {unique} 个 revision），目标历史暂无匹配',
  scannedSummary: '会话已扫描 {scanned} 条',
  matchedSummary: '目标历史 {matched} 条',
  visibleSummary: '当前筛选可见 {visible} 条',
  displayedSummary: '已展示 {displayed} 条',
  unresolvedTitle: 'HEAD 暂不可用',
  unresolvedDetail: '无法读取仓库 HEAD。可重试，或按本地 BASE 上限查看（只有随后 svn log 成功才显示结果）。',
  notFoundTitle: '没有找到该目标的历史记录',
  notFoundDetail: '目标在历史上限 revision 不存在，来源栈耗尽后仍找不到该路径的提交记录。',
  notFoundScanningTitle: '已扫描 {scanned} 条，暂无匹配',
  notFoundScanningDetail: '可以继续加载原始提交批次。',
  authFailedTitle: '认证失败',
  permissionFailedTitle: '没有访问该目标的权限',
  networkFailedTitle: '网络错误',
  unknownFailedTitle: '历史读取失败',
  baseFallbackFailed: '按 BASE 上限读取失败，保留原会话：{message}',
  baseFallbackNotAllowed: '当前上限来源为 {source}，不能按 BASE 上限查看。',
  refreshInProgress: '刷新正在进行中，请稍候再试。',
  updateConfirmInProgress: '更新确认正在进行中，完成后再刷新。',
  missingTargetContext: '缺少历史目标上下文',
  headInfoIncomplete: 'svn info --xml 输出缺少 HEAD 必需字段',
  ancestorMissing: '目标路径的祖先在 revision {revision} 均不存在',
  baseSourceUnavailable: '没有可用的 BASE 历史源',
} as const;

type HistoryTextKey = keyof typeof HISTORY_TEXT_DEFAULTS;

interface HistoryPanelStrings {
  readonly [key: string]: string | undefined;
}

/**
 * i18n 已落地的 P6 文案（strings.historyPanel）；未落地的键回退本地默认值
 * （与 P5 browseModel 的取用方式一致，定向单测无需先改 i18n）。
 */
function historyPanelStrings(): HistoryPanelStrings | undefined {
  return (strings as unknown as { historyPanel?: HistoryPanelStrings }).historyPanel;
}

/** 取 P6 文案：优先 i18n.historyPanel，回落本地默认中文；支持 {name} 占位。 */
export function historyText(key: HistoryTextKey, params: Record<string, string> = {}): string {
  const override = historyPanelStrings()?.[key];
  return format(override ?? HISTORY_TEXT_DEFAULTS[key], params);
}

/* ---------------------------------------------------------------------------
 * 对外类型：目标上下文、相位、详情与持久化形状
 * ------------------------------------------------------------------------- */

/** 入口来源：本地工作副本（showHistory 命令）或 P5 节点交接（快照）。 */
export type HistoryEntrySource = 'local' | 'handoff';

/** 历史目标上下文（由命令层/交接载荷构造，含展示用本地路径与 BASE）。 */
export interface HistoryModelContext {
  /** 仓库 UUID（会话作用域身份的一部分；来自本地 info 或 P5 交接载荷）。 */
  repositoryUuid: string;
  /** 冻结的目标身份（URL/仓库根/相对路径/类型）。 */
  target: HistoryTarget;
  source: HistoryEntrySource;
  /** 本地目标路径（本地入口；handoff 无）。 */
  localPath?: string;
  /** 本地目标节点 BASE revision（本地入口；handoff 无）。 */
  localBaseRevision?: number;
}

/** 面板会话相位：opening（解析 HEAD/存在性）→ ready ⇄ loading；error 为可重试终态。 */
export type HistoryPhase = 'opening' | 'ready' | 'loading' | 'error';

/** 所选 revision 的实际节点解析视图（控制器异步写入）。 */
export type HistoryDetailResolutionView =
  | { status: 'loading' }
  | { status: 'present'; url: string; repositoryPath: string; revision?: number }
  | { status: 'absent'; deletedRevision?: number }
  | { status: 'notFoundAtRevision' }
  | { status: 'error'; message: string };

/** 详情状态：选中 revision 的提交记录 + 实际节点解析进度。 */
export interface HistoryDetailState {
  revision: number;
  entry: HistoryEntry;
  /** 模型自增的解析代次：控制器回包必须与当前值一致才写回。 */
  epoch: number;
  resolution: HistoryDetailResolutionView;
}

/** 序列化后的会话数据（关闭重开恢复；LRU 淘汰后丢弃重新解析）。 */
export interface SerializedHistorySession {
  upperRevision: number | null;
  upperSource: HistoryUpperSource;
  headState: HistoryHeadState;
  sources: HistorySource[];
  activeSourceIndex: number;
  entries: HistoryEntry[];
  scannedRevisionIds: number[];
  /** 会话累计扫描原始批次作者（作者下拉数据源；恢复时校验形状）。 */
  scannedAuthors: string[];
  rawFetchedTotal: number;
  displayedCount: number;
  followCopies: boolean;
  historyLimitState: { reasons: HistoryLimitReason[] } | null;
}

/**
 * P6 可浏览状态（m4SessionStore.browsable）：目标/筛选/勾选/详情与已加载
 * 会话数据。upper 三字段与 historyLimitState 按 store 的顶层字段单独保存
 * （阶段 1 冻结形状），本结构不重复保存，避免两份真相。
 */
export interface HistoryBrowsableState {
  version: typeof HISTORY_BROWSABLE_VERSION;
  repositoryUuid: string;
  target: HistoryTarget;
  filter: HistoryFilter;
  followCopies: boolean;
  /** 目标在 upperRevision 是否存在与最近存在祖先（reset 重建源栈用）。 */
  targetPresentAtUpper: boolean;
  nearestExistingAncestor?: string;
  session: SerializedHistorySession;
  /** 手动勾选（revision 值，最多两项）。 */
  selection: number[];
  /** 当前详情 revision（恢复后重新解析实际节点）。 */
  detailRevision?: number;
}

/**
 * 会话作用域身份键（HistoryResultScope.targetKey）：仓库 UUID + 根 URL +
 * 规范化相对路径 + 节点类型，JSON 数组编码避免分隔符冲突。
 */
export function historyTargetKey(
  repositoryUuid: string,
  target: Pick<HistoryTarget, 'repositoryRootUrl' | 'relativePath' | 'kind'>,
): string {
  return JSON.stringify([
    'history-target',
    repositoryUuid,
    target.repositoryRootUrl,
    target.relativePath,
    target.kind,
  ]);
}

/** 模型构造选项：pageSize 为配置归一后的批次大小，limits 供同构小参数单测。 */
export interface HistoryModelOptions {
  pageSize?: number;
  limits?: HistoryLimits;
}

/* ---------------------------------------------------------------------------
 * P6 更新到历史 revision 的状态机（M4 阶段 6，交互状态清单冻结五态）
 *
 * 五态：updating（命令在途）/ updated（回读确认成功）/ updateConflict
 * （回读确认冲突）/ updateRescanning（未知后的只读回扫）/ updateUnknown
 * （结果未决）。状态只由控制器在执行链的权威回读事实之上推进：
 * - 旧 BASE（preRevision）在命令与回扫期间始终保留，不被请求 revision
 *   或预期值覆盖；只有 updated/updateConflict（回读与固定请求一致）才
 *   把回读的 postNodeRevision 作为新 BASE 交给面板刷新；
 * - 记录中的固定意图（路径/revision/目标 URL）随状态保存，未知回扫只
 *   复用同一意图（只读），不重新解析 HEAD、不发起第二次写入；
 * - 终态页形状经 version 校验后恢复；损坏/未知形态按无恢复处理。
 * ------------------------------------------------------------------------- */

/** 更新状态形状版本（结构变化时旧终态页按无恢复处理）。 */
export const HISTORY_UPDATE_STATE_VERSION = 1;

/** P6 更新状态机相位（交互状态清单 §P6）。 */
export type HistoryUpdatePhase = 'updating' | 'updated' | 'updateConflict' | 'updateRescanning' | 'updateUnknown';

/** P6 更新状态：固定意图 + 权威回读事实 + 本次范围冲突（P7 共用结果对象）。 */
export interface HistoryUpdateState {
  version: typeof HISTORY_UPDATE_STATE_VERSION;
  phase: HistoryUpdatePhase;
  /** 规范化工作副本根（operation record 锁键同值；P7 交接需要）。 */
  wcRoot: string;
  targetRelPath: string;
  targetKind: 'file' | 'dir';
  targetUrl: string;
  requestedRevision: number;
  /** 更新开始前已确认的节点 BASE（旧 BASE；未知期间保持原值）。 */
  preRevision: number;
  /** 权威回读的节点 BASE；回读失败时缺省（不按预期值伪造）。 */
  postNodeRevision?: number;
  /** 本次更新目标范围内的冲突记录（未知时也保留回读事实）。 */
  conflicts: ConflictRecord[];
  conflictSummary: ConflictSummary;
  readbackError?: string;
  /** 命令级失败原因（退出码非零/超时/进程错误；仅作未知页说明）。 */
  commandError?: string;
  /**
   * 命令输出初解析线索：final revision 与冲突路径只作
   * 结果页提示与交叉核对，不参与三态结算；进程级失败时缺省。
   */
  outputHint?: HistoryUpdateOutputHint;
  /** operation record ID（写锁、日志与回扫收口定位）。 */
  operationId?: string;
  updatedAt: number;
}

/** 更新终态页（m4SessionStore.terminalPage 的 P6 形状）。 */
export interface HistoryUpdateTerminalPage {
  version: typeof HISTORY_UPDATE_STATE_VERSION;
  kind: 'history-update';
  state: HistoryUpdateState;
}

function validPositiveRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function cloneConflicts(conflicts: readonly ConflictRecord[]): ConflictRecord[] {
  return conflicts.map((record) => ({
    ...record,
    kinds: [...record.kinds],
    artifacts: Array.isArray(record.artifacts)
      ? record.artifacts.map((artifact) => ({ ...artifact }))
      : [],
  }));
}

/** 命令输出线索的防御性副本（会话状态不得与结果对象共享数组）。 */
function cloneOutputHint(hint: HistoryUpdateOutputHint): HistoryUpdateOutputHint {
  return {
    ...(hint.finalRevision !== undefined ? { finalRevision: hint.finalRevision } : {}),
    conflicts: [...hint.conflicts],
  };
}

function emptyConflictSummary(): ConflictSummary {
  return { text: 0, property: 0, tree: 0, total: 0 };
}

/** 摘要恢复：非数字字段按 0 处理（损坏终态页不产生 NaN 计数）。 */
function sanitizeConflictSummary(value: unknown): ConflictSummary {
  const source = typeof value === 'object' && value !== null
    ? value as Partial<Record<keyof ConflictSummary, unknown>>
    : {};
  const count = (input: unknown): number =>
    typeof input === 'number' && Number.isFinite(input) && input >= 0 ? input : 0;
  const text = count(source.text);
  const property = count(source.property);
  const tree = count(source.tree);
  const total = count(source.total);
  return { text, property, tree, total: total > 0 ? total : text + property + tree };
}

/** 固定意图 → 初始 updating 状态（begin 成功后、命令发出前调用）。 */
export function createHistoryUpdateState(
  intent: HistoryUpdateIntent,
  operationId?: string,
  now: number = Date.now(),
): HistoryUpdateState {
  return {
    version: HISTORY_UPDATE_STATE_VERSION,
    phase: 'updating',
    wcRoot: intent.wcRoot,
    targetRelPath: intent.targetRelPath,
    targetKind: intent.targetKind,
    targetUrl: intent.targetUrl,
    requestedRevision: intent.requestedRevision,
    preRevision: intent.preRevision,
    conflicts: [],
    conflictSummary: emptyConflictSummary(),
    ...(operationId !== undefined ? { operationId } : {}),
    updatedAt: now,
  };
}

/** 从状态重建固定意图（未知回扫只读复用；不重新解析 HEAD）。 */
export function historyUpdateIntentOf(state: HistoryUpdateState): HistoryUpdateIntent {
  return {
    wcRoot: state.wcRoot,
    targetRelPath: state.targetRelPath,
    targetKind: state.targetKind,
    targetUrl: state.targetUrl,
    requestedRevision: state.requestedRevision,
    preRevision: state.preRevision,
  };
}

/**
 * 命令结束后的状态推进：outcome='updated' → updated；'conflict' →
 * updateConflict；'unknown' → updateUnknown。回读事实（postNodeRevision/
 * conflicts/readbackError）原样保留，旧 BASE 在 unknown 时不被替换。
 */
export function applyHistoryUpdateResult(
  state: HistoryUpdateState,
  result: HistoryUpdateResult,
  now: number = Date.now(),
): HistoryUpdateState {
  const phase: HistoryUpdatePhase = result.outcome === 'updated'
    ? 'updated'
    : result.outcome === 'conflict'
      ? 'updateConflict'
      : 'updateUnknown';
  return {
    ...state,
    phase,
    ...(result.postNodeRevision !== undefined ? { postNodeRevision: result.postNodeRevision } : { postNodeRevision: undefined }),
    conflicts: cloneConflicts(result.conflicts),
    conflictSummary: { ...result.conflictSummary },
    ...(result.readbackError !== undefined ? { readbackError: result.readbackError } : { readbackError: undefined }),
    ...(result.commandError !== undefined ? { commandError: result.commandError } : { commandError: undefined }),
    ...(result.outputHint !== undefined ? { outputHint: cloneOutputHint(result.outputHint) } : { outputHint: undefined }),
    updatedAt: now,
  };
}

/** 进入未知回扫：只读回读同一更新范围，不发起第二次写命令。 */
export function beginHistoryUpdateRescan(
  state: HistoryUpdateState,
  now: number = Date.now(),
): HistoryUpdateState {
  return { ...state, phase: 'updateRescanning', updatedAt: now };
}

/**
 * 未知回扫结果推进（三出口）：仍未知 → updateUnknown（保留上次事实）；
 * 成功 → updated；冲突 → updateConflict。回扫以真实回读为准，不以预期值
 * 冒充成功。
 */
export function applyHistoryUpdateRescan(
  state: HistoryUpdateState,
  rescan: HistoryUpdateRescan,
  now: number = Date.now(),
): HistoryUpdateState {
  const phase: HistoryUpdatePhase = rescan.outcome === 'updated'
    ? 'updated'
    : rescan.outcome === 'conflict'
      ? 'updateConflict'
      : 'updateUnknown';
  return {
    ...state,
    phase,
    ...(rescan.postNodeRevision !== undefined ? { postNodeRevision: rescan.postNodeRevision } : { postNodeRevision: undefined }),
    conflicts: cloneConflicts(rescan.conflicts),
    conflictSummary: { ...rescan.conflictSummary },
    ...(rescan.readbackError !== undefined ? { readbackError: rescan.readbackError } : { readbackError: undefined }),
    updatedAt: now,
  };
}

/** 已结算（updated/updateConflict）：回读到与固定请求一致的权威事实。 */
export function historyUpdateSettled(state: HistoryUpdateState): boolean {
  return state.phase === 'updated' || state.phase === 'updateConflict';
}

/** P7 交接上下文：只取展示事实，冲突集合由 P7 重新真实扫描。 */
export function historyUpdateTaskContext(state: HistoryUpdateState): HistoryUpdateTaskContext {
  return {
    targetRelPath: state.targetRelPath,
    targetKind: state.targetKind,
    requestedRevision: state.requestedRevision,
    preRevision: state.preRevision,
    ...(state.postNodeRevision !== undefined ? { postNodeRevision: state.postNodeRevision } : {}),
    outcome: state.phase === 'updated' ? 'updated' : state.phase === 'updateConflict' ? 'conflict' : 'unknown',
    conflictCount: state.conflicts.length,
    ...(state.readbackError !== undefined ? { readbackError: state.readbackError } : {}),
  };
}

/** 状态 → 终态页（先写会话缓存、再移除任务的载荷）。 */
export function historyUpdateTerminalPage(
  state: HistoryUpdateState,
): HistoryUpdateTerminalPage {
  return { version: HISTORY_UPDATE_STATE_VERSION, kind: 'history-update', state };
}

/**
 * 终态页恢复：形状/版本/相位/字段不合法时返回 undefined（按无恢复处理，
 * 不猜测半截数据）。冲突记录只校验稳定字段，其余保持原样。
 */
export function restoreHistoryUpdateState(page: unknown): HistoryUpdateState | undefined {
  if (typeof page !== 'object' || page === null) {
    return undefined;
  }
  const terminal = page as Partial<HistoryUpdateTerminalPage>;
  if (terminal.version !== HISTORY_UPDATE_STATE_VERSION || terminal.kind !== 'history-update') {
    return undefined;
  }
  const state = terminal.state as Partial<HistoryUpdateState> | undefined;
  if (typeof state !== 'object' || state === null || state.version !== HISTORY_UPDATE_STATE_VERSION) {
    return undefined;
  }
  const phases: readonly HistoryUpdatePhase[] = [
    'updating', 'updated', 'updateConflict', 'updateRescanning', 'updateUnknown',
  ];
  if (!phases.includes(state.phase as HistoryUpdatePhase)) {
    return undefined;
  }
  if (typeof state.wcRoot !== 'string'
    || typeof state.targetRelPath !== 'string'
    || (state.targetKind !== 'file' && state.targetKind !== 'dir')
    || typeof state.targetUrl !== 'string'
    || !validPositiveRevision(state.requestedRevision)
    || !validPositiveRevision(state.preRevision)
    || typeof state.updatedAt !== 'number') {
    return undefined;
  }
  if (state.postNodeRevision !== undefined && !validPositiveRevision(state.postNodeRevision)) {
    return undefined;
  }
  if (!Array.isArray(state.conflicts)
    || !state.conflicts.every((record) =>
      typeof record === 'object' && record !== null
      && typeof (record as { path?: unknown }).path === 'string'
      && Array.isArray((record as { kinds?: unknown }).kinds))) {
    return undefined;
  }
  if (typeof state.conflictSummary !== 'object' || state.conflictSummary === null) {
    return undefined;
  }
  if (state.readbackError !== undefined && typeof state.readbackError !== 'string') {
    return undefined;
  }
  if (state.commandError !== undefined && typeof state.commandError !== 'string') {
    return undefined;
  }
  if (state.outputHint !== undefined) {
    if (typeof state.outputHint !== 'object' || state.outputHint === null) {
      return undefined;
    }
    const hint = state.outputHint as Partial<HistoryUpdateOutputHint>;
    if (hint.finalRevision !== undefined && !validPositiveRevision(hint.finalRevision)) {
      return undefined;
    }
    if (!Array.isArray(hint.conflicts) || !hint.conflicts.every((path) => typeof path === 'string')) {
      return undefined;
    }
  }
  if (state.operationId !== undefined && typeof state.operationId !== 'string') {
    return undefined;
  }
  return {
    version: HISTORY_UPDATE_STATE_VERSION,
    phase: state.phase as HistoryUpdatePhase,
    wcRoot: state.wcRoot,
    targetRelPath: state.targetRelPath,
    targetKind: state.targetKind,
    targetUrl: state.targetUrl,
    requestedRevision: state.requestedRevision,
    preRevision: state.preRevision,
    ...(state.postNodeRevision !== undefined ? { postNodeRevision: state.postNodeRevision } : {}),
    conflicts: cloneConflicts(state.conflicts as ConflictRecord[]),
    conflictSummary: sanitizeConflictSummary(state.conflictSummary),
    ...(state.readbackError !== undefined ? { readbackError: state.readbackError } : {}),
    ...(state.commandError !== undefined ? { commandError: state.commandError } : {}),
    ...(state.outputHint !== undefined
      ? { outputHint: cloneOutputHint(state.outputHint as HistoryUpdateOutputHint) }
      : {}),
    ...(state.operationId !== undefined ? { operationId: state.operationId } : {}),
    updatedAt: state.updatedAt,
  };
}

/* ---------------------------------------------------------------------------
 * 通用小工具
 * ------------------------------------------------------------------------- */

/** 表格行 ID 与 revision 的互转（行 ID 是稳定视图标识，不带路径）。 */
export function historyRowId(revision: number): string {
  return `r${revision}`;
}

export function historyRevisionOfRowId(rowId: string): number | undefined {
  const match = /^r(\d+)$/.exec(rowId);
  if (match === null) {
    return undefined;
  }
  const revision = Number(match[1]);
  return Number.isInteger(revision) && revision >= 1 ? revision : undefined;
}

/** 按 revision 降序（同 revision 唯一）。 */
function sortedEntries(entries: Iterable<HistoryEntry>): HistoryEntry[] {
  return [...entries].sort((a, b) => b.revision - a.revision);
}

/** 列内单行展示：提交说明取首行（完整说明在详情）。 */
function messageFirstLine(message: string): string {
  return message.split('\n')[0] ?? '';
}

/** 仓库相对路径的父目录（'' 为仓库根，根的父返回 undefined）。 */
export function parentRepositoryPath(path: string): string | undefined {
  const normalized = normalizeRelativePath(path);
  if (normalized === '') {
    return undefined;
  }
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '' : normalized.slice(0, index);
}

/** 仓库相对路径归一：去前导与尾随斜杠（'' 表示仓库根）。 */
export function normalizeRelativePath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

/* ---------------------------------------------------------------------------
 * 模型主体
 * ------------------------------------------------------------------------- */

export class HistoryModel {
  private readonly defaultPageSize: number;
  private readonly limits: HistoryLimits;
  private pageSizeValue: number;

  private ctx: HistoryModelContext | undefined;
  private phaseValue: HistoryPhase = 'opening';
  private sessionValue: HistorySession = createUnresolvedHistorySession({ followCopies: true });
  private filterValue: HistoryFilter = {};
  private followCopiesValue = true;
  private selectionValue = new Set<number>();
  private detailValue: HistoryDetailState | undefined;
  private detailSeq = 0;
  private errorValue: BrowserError | undefined;
  /** HEAD 读取失败原因（unresolved 会话展示「HEAD 暂不可用」）。 */
  private headErrorValue: BrowserError | undefined;
  /** 目标在 upperRevision 是否存在（reset 重建源栈用）。 */
  private targetPresentAtUpper = true;
  private nearestExistingAncestor: string | undefined;
  /** 已建立会话（upper 已解析或明确 unresolved）。 */
  private sessionReady = false;
  /** 本轮进入网络的原始回包数（0 表示 pending-only 轮，页面隐藏本轮行）。 */
  private roundFetched = 0;
  /** 本轮唯一 revision 数（scannedThisLoad.size 快照）。 */
  private roundUnique = 0;
  /** 控制器推送到面板的持久提示（认证取消等）。 */
  private notices: BannerSpec[] = [];
  private noticeSeq = 0;
  /** ready 相位下的 load 失败（可重试横幅）。 */
  private loadErrorValue: BrowserError | undefined;
  /** 恢复后尚待重新解析的详情（控制器在恢复后触发）。 */
  private pendingDetailResolve = false;

  constructor(options: HistoryModelOptions = {}) {
    this.defaultPageSize = options.pageSize ?? 50;
    this.pageSizeValue = this.defaultPageSize;
    this.limits = options.limits ?? {
      matched: 5_000,
      scanned: 100_000,
      rawBudgetPerLoad: 500,
    };
  }

  /* ------------------------- 只读访问器（控制器/测试） ------------------------- */

  get pageSize(): number {
    return this.pageSizeValue;
  }

  get phase(): HistoryPhase {
    return this.phaseValue;
  }

  get target(): HistoryTarget | undefined {
    return this.ctx?.target;
  }

  get context(): HistoryModelContext | undefined {
    return this.ctx;
  }

  /** 会话状态（测试断言三字段/计数用；控制器只读）。 */
  sessionView(): HistorySession {
    return this.sessionValue;
  }

  hasSession(): boolean {
    return this.sessionReady;
  }

  isLoading(): boolean {
    return this.phaseValue === 'opening' || this.phaseValue === 'loading';
  }

  hasLoadedData(): boolean {
    return this.sessionValue.entriesByRevision.size > 0;
  }

  /** 当前筛选（含用户输入的日期原值；计算时用 effectiveFilter）。 */
  currentFilter(): HistoryFilter {
    return { ...this.filterValue };
  }

  /** 手动勾选的 revision（按勾选顺序）。 */
  selectedRevisions(): number[] {
    return [...this.selectionValue];
  }

  detailState(): HistoryDetailState | undefined {
    return this.detailValue;
  }

  /**
   * 作者下拉数据源：当前会话已扫描原始批次中的实际作者。
   * 会话累计口径（含未命中目标身份的提交、按首次出现顺序去重），
   * 不是仅命中记录的作者集合。
   */
  authors(): string[] {
    return [...this.sessionValue.scannedAuthors];
  }

  /** 本轮网络计数（页面“本轮已处理/本轮唯一”行）。 */
  roundCounters(): { fetched: number; unique: number } {
    return { fetched: this.roundFetched, unique: this.roundUnique };
  }

  /** 最近一次 load 失败（ready 相位的可重试横幅）。 */
  loadFailure(): BrowserError | undefined {
    return this.loadErrorValue;
  }

  /** follow 模式当前值（跟随复制历史 / 停在复制点）。 */
  followCopies(): boolean {
    return this.followCopiesValue;
  }

  /** 本地 BASE revision（仅本地入口；handoff 无）。 */
  localBaseRevision(): number | undefined {
    return this.ctx?.localBaseRevision;
  }

  /**
   * 更新权威回读确认后同步本地 BASE（M4 阶段 6）：只有 updated/updateConflict
   * 的 postNodeRevision 允许调用；unknown 不得用请求 revision 或外部并发值
   * 覆盖旧 BASE。同步后 BASE 徽标与 base-fallback 上限刷新都以新值为准。
   */
  applyLocalBaseRevision(revision: number): void {
    if (this.ctx === undefined || !Number.isSafeInteger(revision) || revision <= 0) {
      return;
    }
    this.ctx.localBaseRevision = revision;
  }

  /* ------------------------- 生命周期：打开与 upper ------------------------- */

  /** 打开入口：重置全部状态为 opening 相位（控制器随后解析 HEAD/存在性）。 */
  beginOpen(ctx: HistoryModelContext): void {
    this.ctx = {
      repositoryUuid: ctx.repositoryUuid,
      target: { ...ctx.target },
      source: ctx.source,
      ...(ctx.localPath !== undefined ? { localPath: ctx.localPath } : {}),
      ...(ctx.localBaseRevision !== undefined ? { localBaseRevision: ctx.localBaseRevision } : {}),
    };
    this.phaseValue = 'opening';
    this.sessionValue = createUnresolvedHistorySession({ followCopies: true });
    this.filterValue = {};
    this.followCopiesValue = true;
    this.selectionValue.clear();
    this.detailValue = undefined;
    this.detailSeq = 0;
    this.errorValue = undefined;
    this.headErrorValue = undefined;
    this.targetPresentAtUpper = true;
    this.nearestExistingAncestor = undefined;
    this.sessionReady = false;
    this.roundFetched = 0;
    this.roundUnique = 0;
    this.notices = [];
    this.loadErrorValue = undefined;
    this.pendingDetailResolve = false;
  }

  /**
   * 关闭重开恢复：校验并重建会话数据（不解析 HEAD、不伪造旧 upper）。
   * 恢复成功后控制器按需重读首批（仅在恢复时无已加载数据时）。
   * 形状/版本/身份不一致返回 false，调用方按 fresh 处理。
   */
  restore(
    ctx: HistoryModelContext,
    browsable: unknown,
    upper: { upperRevision: number | null; upperSource: HistoryUpperSource; headState: HistoryHeadState } | undefined,
    limitState: { reasons: HistoryLimitReason[] } | null | undefined,
  ): boolean {
    if (browsable === null || typeof browsable !== 'object') {
      return false;
    }
    const saved = browsable as Partial<HistoryBrowsableState>;
    if (saved.version !== HISTORY_BROWSABLE_VERSION) {
      return false;
    }
    if (saved.target === null || typeof saved.target !== 'object') {
      return false;
    }
    if (saved.target.repositoryRootUrl !== ctx.target.repositoryRootUrl
      || saved.target.relativePath !== ctx.target.relativePath
      || saved.target.kind !== ctx.target.kind) {
      return false;
    }
    // 同一根 URL + 相对路径但仓库 UUID 不同 = 不同仓库（地址被重定向等）：
    // 不把旧仓库的会话状态套到新仓库上。
    if (typeof saved.repositoryUuid === 'string' && saved.repositoryUuid !== ctx.repositoryUuid) {
      return false;
    }
    if (upper === undefined || (upper.upperRevision === null && upper.upperSource !== 'unresolved')) {
      return false;
    }
    const session = saved.session;
    if (session === null || typeof session !== 'object') {
      return false;
    }
    if (session.upperRevision !== upper.upperRevision || session.upperSource !== upper.upperSource
      || session.headState !== upper.headState) {
      return false;
    }
    // 入口上下文以本次打开为准：交接入口不借用保存的本地 BASE，本地入口
    // 也不会因上次从 P5 进入而丢失 BASE 能力（同一目标身份，不伪造身份）。
    this.beginOpen(ctx);
    this.followCopiesValue = saved.followCopies !== false;
    this.filterValue = sanitizeFilter(saved.filter);
    this.targetPresentAtUpper = saved.targetPresentAtUpper !== false;
    this.nearestExistingAncestor = typeof saved.nearestExistingAncestor === 'string'
      ? saved.nearestExistingAncestor
      : undefined;
    const restored = this.sessionValue;
    restored.upperRevision = upper.upperRevision;
    restored.upperSource = upper.upperSource;
    restored.headState = upper.headState;
    restored.sources = Array.isArray(session.sources)
      ? session.sources.filter(isHistorySource).map((source) => ({ ...source }))
      : [];
    restored.activeSourceIndex = Number.isInteger(session.activeSourceIndex) ? Number(session.activeSourceIndex) : 0;
    restored.entriesByRevision.clear();
    for (const entry of Array.isArray(session.entries) ? session.entries : []) {
      if (isHistoryEntry(entry)) {
        restored.entriesByRevision.set(entry.revision, entry);
      }
    }
    restored.scannedRevisionIds.clear();
    for (const revision of Array.isArray(session.scannedRevisionIds) ? session.scannedRevisionIds : []) {
      if (typeof revision === 'number' && Number.isFinite(revision)) {
        restored.scannedRevisionIds.add(revision);
      }
    }
    // 旧持久化数据可能没有 scannedAuthors（该字段后来新增）：
    // 形状不合法时清空，后续 applyLogPage 仍会按原始回包继续累计。
    restored.scannedAuthors = Array.isArray(session.scannedAuthors)
      ? session.scannedAuthors.filter((author): author is string => typeof author === 'string' && author !== '')
      : [];
    restored.rawFetchedTotal = finiteNumber(session.rawFetchedTotal, 0);
    restored.rawFetchedInLoad = 0;
    restored.scannedThisLoad = new Set();
    restored.followCopies = this.followCopiesValue;
    restored.historyLimitState = limitState !== undefined && limitState !== null && Array.isArray(limitState.reasons)
      ? { reasons: limitState.reasons.filter(isLimitReason).map((reason) => ({ ...reason })) }
      : null;
    this.sessionValue = restored;
    this.sessionReady = true;
    this.phaseValue = 'ready';
    // 可见列表按当前筛选重算；展示前缀保留保存值（截断到可见长度）。
    this.sessionValue.visibleEntries = this.computeVisibleEntries();
    this.sessionValue.displayedCount = Math.min(
      Math.max(0, Math.floor(finiteNumber(session.displayedCount, 0))),
      this.sessionValue.visibleEntries.length,
    );
    updateHistoryDerivedCounters(this.sessionValue);
    // 勾选只保留仍可见的记录；详情恢复后由控制器重新解析实际节点。
    const visible = this.visibleRevisionSet();
    this.selectionValue = new Set(
      (Array.isArray(saved.selection) ? saved.selection : [])
        .filter((revision): revision is number => typeof revision === 'number' && visible.has(revision))
        .slice(0, 2),
    );
    if (typeof saved.detailRevision === 'number' && visible.has(saved.detailRevision)) {
      const entry = this.sessionValue.entriesByRevision.get(saved.detailRevision);
      if (entry !== undefined) {
        this.detailSeq += 1;
        this.detailValue = {
          revision: entry.revision,
          entry,
          epoch: this.detailSeq,
          resolution: { status: 'loading' },
        };
        this.pendingDetailResolve = true;
      }
    }
    // 恢复的会话没有已知的 HEAD 错误详情：unresolved 用通用说明。
    return true;
  }

  /** 恢复后是否需要控制器重新解析详情（模型只给判定，不执行 IO）。 */
  takePendingDetailResolve(): HistoryDetailState | undefined {
    if (!this.pendingDetailResolve) {
      return undefined;
    }
    this.pendingDetailResolve = false;
    return this.detailValue;
  }

  /** 已解析 upper：建立初始源（target 或 ancestor-filter）并进入 ready。 */
  applyResolvedUpper(params: {
    upperRevision: number;
    upperSource: 'live-head' | 'snapshot' | 'base-fallback';
    targetPresentAtUpper: boolean;
    nearestExistingAncestor?: string;
    targetKind?: 'file' | 'dir';
  }): void {
    const ctx = this.requireContext();
    if (params.targetKind !== undefined) {
      ctx.target.kind = params.targetKind;
    }
    this.targetPresentAtUpper = params.targetPresentAtUpper;
    this.nearestExistingAncestor = params.nearestExistingAncestor;
    this.sessionValue = createHistorySession({
      upperRevision: params.upperRevision,
      upperSource: params.upperSource,
      followCopies: this.followCopiesValue,
      targetPresentAtUpper: params.targetPresentAtUpper,
      target: ctx.target,
      ...(params.nearestExistingAncestor !== undefined
        ? { nearestExistingAncestor: params.nearestExistingAncestor }
        : {}),
    });
    this.sessionReady = true;
    this.errorValue = undefined;
    this.headErrorValue = undefined;
    this.loadErrorValue = undefined;
    this.roundFetched = 0;
    this.roundUnique = 0;
    this.phaseValue = 'ready';
  }

  /** 初始 HEAD 解析失败：固定 unresolved 会话（upperRevision=null）。 */
  applyUnresolved(error: BrowserError): void {
    this.sessionValue = createUnresolvedHistorySession({ followCopies: this.followCopiesValue });
    this.sessionReady = true;
    this.errorValue = undefined;
    this.headErrorValue = error;
    this.phaseValue = 'ready';
  }

  /** 打开阶段的解析失败（HEAD/info 非 absent 错误）：error 相位可重试。 */
  applyOpenError(error: BrowserError): void {
    this.errorValue = error;
    this.sessionReady = false;
    this.phaseValue = 'error';
  }

  /** HEAD 读取失败原因（unresolved 会话）。 */
  headFailure(): BrowserError | undefined {
    return this.headErrorValue;
  }

  /** refreshHistoryUpper 的运行时能力校验（控制器在发任何命令前调用）。 */
  checkUpperRefresh(mode: string): HistoryUpperRefreshCheck {
    return canRefreshHistoryUpper(this.sessionValue, mode, {
      hasLocalBase: this.localBaseRevision() !== undefined,
    });
  }

  /**
   * 应用一次成功的 upper 刷新（失败分支由控制器直接返回，不调用本方法）：
   * - live-head 同值 → 'up-to-date'（保留已加载数据）；
   * - 其余成功 → 清历史数据，返回 'updated'；控制器随后重新探测目标
   *   存在性并调用 establishInitialSources 重建源栈、重读首批。
   */
  applyUpperRefresh(mode: HistoryUpperRefreshMode, revision: number): 'updated' | 'up-to-date' {
    const result = applyHistoryUpperRefresh(this.sessionValue, mode, revision);
    if (result === 'updated') {
      this.selectionValue.clear();
      this.detailValue = undefined;
      this.loadErrorValue = undefined;
      this.headErrorValue = undefined;
      this.roundFetched = 0;
      this.roundUnique = 0;
      this.sessionReady = true;
      this.phaseValue = 'ready';
    }
    return result;
  }

  /** upper 刷新成功后按探测结果重建初始源（清空后的源栈）。 */
  establishInitialSources(params: {
    targetPresentAtUpper: boolean;
    nearestExistingAncestor?: string;
    targetKind?: 'file' | 'dir';
  }): void {
    const ctx = this.requireContext();
    if (params.targetKind !== undefined) {
      ctx.target.kind = params.targetKind;
    }
    this.targetPresentAtUpper = params.targetPresentAtUpper;
    this.nearestExistingAncestor = params.nearestExistingAncestor;
    this.rebuildSources();
    this.phaseValue = 'ready';
  }

  /**
   * base-fallback 成功：三字段固定 upperRevision=BASE、upperSource=base-fallback、
   * headState=unavailable，清历史数据并按探测结果重建源（控制器随后应用
   * 已成功取得的首批记录）。失败分支不得调用本方法（三字段与数据不变）。
   */
  applyBaseFallbackSuccess(
    revision: number,
    presence: { targetPresentAtUpper: boolean; nearestExistingAncestor?: string; targetKind?: 'file' | 'dir' },
  ): void {
    this.applyUpperRefresh('base-fallback', revision);
    this.establishInitialSources(presence);
  }

  /* ------------------------- 加载状态机 ------------------------- */

  /**
   * 开始一轮“加载更多”（首批与后续批次共用）：
   * - 会话未建立（unresolved 或被拒绝）→ 'exhausted'；
   * - 有未展示匹配 → 'pending-only'（不进入网络）；
   * - 无待展示但有可扫描源 → 'network'（控制器进入网络循环）；
   * - 其余 → 'exhausted'。
   */
  startLoadMore(): HistoryLoadMode {
    if (!this.sessionReady) {
      return 'exhausted';
    }
    const mode = beginHistoryLoadMore(this.sessionValue, this.limits);
    this.loadErrorValue = undefined;
    // 本轮计数随 begin 重置：pending-only 轮 rawFetchedInLoad=0 且
    // scannedThisLoad 为空，页面隐藏“本轮已处理/本轮唯一”行。
    this.roundFetched = this.sessionValue.rawFetchedInLoad;
    this.roundUnique = this.sessionValue.scannedThisLoad.size;
    if (mode === 'network') {
      this.phaseValue = 'loading';
    }
    return mode;
  }

  /** 取下一张应发送的单页请求（本轮预算/上限耗尽时 undefined）。 */
  takeNextRequest(): HistoryLogRequest | undefined {
    return nextHistoryLogRequest(this.sessionValue, this.pageSizeValue, this.limits);
  }

  /** 应用一页 log 回包（预算截断/去重/复制边界由 core 处理）。 */
  applyLogPage(page: HistoryLogPage): void {
    const ctx = this.requireContext();
    applyHistoryLogPage(this.sessionValue, ctx.target, page, {
      limits: this.limits,
      filter: this.effectiveFilter(),
    });
    this.roundFetched = this.sessionValue.rawFetchedInLoad;
    this.roundUnique = this.sessionValue.scannedThisLoad.size;
  }

  /** 结束一轮加载：推进展示前缀（最多 pageSize 条）、检查上限并重算计数。 */
  finishLoadMore(): HistoryOutcome {
    finishHistoryLoadMore(this.sessionValue, {
      pageSize: this.pageSizeValue,
      filter: this.effectiveFilter(),
      limits: this.limits,
    });
    this.phaseValue = 'ready';
    this.loadErrorValue = undefined;
    return classifyHistoryOutcome(this.sessionValue, {
      targetPresentAtUpper: this.targetPresentAtUpper,
    });
  }

  /** 标记进入网络加载（控制器在发首个请求前调用，用于 busy/禁用重复请求）。 */
  markLoading(): void {
    this.phaseValue = 'loading';
    this.loadErrorValue = undefined;
  }

  /**
   * 一轮加载失败（认证/网络/权限/未知）：保留已加载数据；会话未建立时
   * 进入 error 相位，其余回到 ready 并保留可重试横幅。
   */
  failLoad(error: BrowserError): void {
    this.loadErrorValue = error;
    this.roundFetched = this.sessionValue.rawFetchedInLoad;
    this.roundUnique = this.sessionValue.scannedThisLoad.size;
    this.phaseValue = this.sessionReady ? 'ready' : 'error';
  }

  /** 推送一个持久提示（认证取消等；dismissBanner 可清除）。 */
  pushNotice(level: BannerSpec['level'], title: string, detail?: string): string {
    this.noticeSeq += 1;
    const id = `historyNotice-${this.noticeSeq}`;
    this.notices.push({ id, level, title, ...(detail !== undefined ? { detail } : {}) });
    return id;
  }

  /** 清除一个提示（banner 关闭）。 */
  dismissNotice(id: string): boolean {
    const before = this.notices.length;
    this.notices = this.notices.filter((banner) => banner.id !== id);
    return this.notices.length !== before;
  }

  /** 关闭“本轮已处理”行（下一次 loadMore 重新出现）。 */
  dismissRoundBanner(): void {
    this.roundFetched = 0;
    this.roundUnique = 0;
  }

  /* ------------------------- 筛选 ------------------------- */

  /** 有效筛选：起止日期反序时日期条件不应用（保留上一有效结果）。 */
  effectiveFilter(): HistoryFilter {
    const filter = this.filterValue;
    if (isHistoryDateRangeReversed(filter)) {
      const { dateFrom: _from, dateTo: _to, ...rest } = filter;
      return rest;
    }
    return { ...filter };
  }

  /**
   * 设置一个筛选字段（意图 setHistoryFilter(id, value) 的模型入口）：
   * - follow（'follow'|'stop'）是历史范围二选一：变化才重建源栈并重读
   *   首批（清空数据/勾选/详情；重读由控制器负责）；
   * - 其余字段只重算已加载记录的展示前缀，不发网络；不可见勾选与详情
   *   立即清空，不自动选第一条。
   * 返回 changed（值是否变化）与 rebuild（控制器是否需要重读首批）。
   */
  setFilter(fieldId: string, value: string): { changed: boolean; rebuild: boolean } {
    if (fieldId === 'pageSize') {
      // 每批条数不是筛选条件：只重置展示前缀，不重发网络（代理清单接线项）。
      return { changed: this.setPageSize(Number(value)), rebuild: false };
    }
    if (fieldId === 'follow') {
      const next = value !== 'stop';
      if (next === this.followCopiesValue) {
        return { changed: false, rebuild: false };
      }
      this.followCopiesValue = next;
      this.sessionValue.followCopies = next;
      this.selectionValue.clear();
      this.detailValue = undefined;
      this.roundFetched = 0;
      this.roundUnique = 0;
      this.phaseValue = 'ready';
      if (this.sessionReady && this.sessionValue.upperRevision !== null) {
        clearHistorySessionData(this.sessionValue);
        this.rebuildSources();
        return { changed: true, rebuild: true };
      }
      return { changed: true, rebuild: false };
    }
    const next = { ...this.filterValue };
    switch (fieldId) {
      case 'keyword':
        next.keyword = value;
        break;
      case 'author':
        next.author = value === '__all__' ? '' : value;
        break;
      case 'dateFrom':
        next.dateFrom = value;
        break;
      case 'dateTo':
        next.dateTo = value;
        break;
      case 'path':
        next.path = value;
        break;
      default:
        return { changed: false, rebuild: false };
    }
    if (sameFilter(this.filterValue, next)) {
      return { changed: false, rebuild: false };
    }
    this.filterValue = next;
    if (this.sessionReady) {
      this.applyFilterToLoadedData();
    }
    return { changed: true, rebuild: false };
  }

  /** 清空全部筛选字段（follow 是历史范围，不随「清空筛选」改变）。 */
  clearFilters(): { changed: boolean } {
    const changed = ['keyword', 'author', 'dateFrom', 'dateTo', 'path']
      .some((key) => (this.filterValue[key as keyof HistoryFilter] ?? '') !== '');
    if (!changed) {
      return { changed: false };
    }
    this.filterValue = {};
    if (this.sessionReady) {
      this.applyFilterToLoadedData();
    }
    return { changed: true };
  }

  /**
   * 每批条数变化：只重置展示前缀，不清已扫描数据、不重发网络。
   * 取值与配置读取同口径归一（仅 20/50/100，其余回退默认 50）：协议可传
   * 任意大整数，不能让它一次渲染全部已加载匹配（违反单帧渲染预算）。
   */
  setPageSize(size: number): boolean {
    const normalized = normalizeHistoryPageSize(size);
    if (normalized === this.pageSizeValue) {
      return false;
    }
    this.pageSizeValue = normalized;
    if (this.sessionReady) {
      this.sessionValue.displayedCount = Math.min(normalized, this.sessionValue.visibleEntries.length);
      updateHistoryDerivedCounters(this.sessionValue);
    }
    return true;
  }

  /** 筛选变化后的统一重算：可见列表/展示前缀 + 清空不可见勾选与详情。 */
  private applyFilterToLoadedData(): void {
    recomputeHistoryView(this.sessionValue, this.effectiveFilter(), this.pageSizeValue);
    const visible = this.visibleRevisionSet();
    for (const revision of [...this.selectionValue]) {
      if (!visible.has(revision)) {
        this.selectionValue.delete(revision);
      }
    }
    if (this.detailValue !== undefined && !visible.has(this.detailValue.revision)) {
      this.detailValue = undefined;
    }
  }

  private computeVisibleEntries(): HistoryEntry[] {
    return sortedEntries(this.sessionValue.entriesByRevision.values())
      .filter((entry) => historyEntryMatches(entry, this.effectiveFilter()));
  }

  private visibleRevisionSet(): Set<number> {
    return new Set(this.sessionValue.visibleEntries.map((entry) => entry.revision));
  }

  /* ------------------------- 选择与详情 ------------------------- */

  /**
   * 点击行只更新详情：返回需要控制器解析实际节点的 {revision, epoch}。
   * 不改变勾选集合。
   */
  selectRevision(rowId: string): { revision: number; epoch: number } | undefined {
    const revision = historyRevisionOfRowId(rowId);
    if (revision === undefined) {
      return undefined;
    }
    const entry = this.sessionValue.entriesByRevision.get(revision);
    if (entry === undefined) {
      return undefined;
    }
    this.detailSeq += 1;
    this.detailValue = {
      revision,
      entry,
      epoch: this.detailSeq,
      resolution: { status: 'loading' },
    };
    return { revision, epoch: this.detailSeq };
  }

  /**
   * 勾选切换（最多两项）：'toggled' | 'limit'（第三个选择被拒绝）| 'missing'。
   * 勾选集合以当前可见批次为准（视图只渲染已展示前缀，宿主校验行存在）。
   */
  toggleRevision(rowId: string): 'toggled' | 'limit' | 'missing' {
    const revision = historyRevisionOfRowId(rowId);
    if (revision === undefined || !this.visibleRevisionSet().has(revision)) {
      return 'missing';
    }
    if (this.selectionValue.has(revision)) {
      this.selectionValue.delete(revision);
      return 'toggled';
    }
    if (this.selectionValue.size >= 2) {
      return 'limit';
    }
    this.selectionValue.add(revision);
    return 'toggled';
  }

  /** 详情解析回包写入（代次 + revision 双重校验；过期回包丢弃）。 */
  applyDetailResolution(request: { revision: number; epoch: number }, resolution: HistoryDetailResolutionView): void {
    const detail = this.detailValue;
    if (detail === undefined || detail.epoch !== request.epoch || detail.revision !== request.revision) {
      return;
    }
    detail.resolution = resolution;
  }

  /**
   * 「与上一条可见记录比较」的版本对：当前详情 revision 在当前筛选、
   * 当前已加载批次中的下一条可见记录（列表按 revision 降序，下一条更旧）。
   * 到批次边界（已是最后一条已加载记录）返回 undefined，调用方禁用并提示
   * 加载更多；不跨批、不从复制来源补取。
   */
  previousVisiblePair(): { newer: number; older: number } | undefined {
    const detail = this.detailValue;
    if (detail === undefined) {
      return undefined;
    }
    const entries = this.sessionValue.visibleEntries;
    const index = entries.findIndex((entry) => entry.revision === detail.revision);
    if (index < 0 || index + 1 >= entries.length) {
      return undefined;
    }
    return { newer: detail.revision, older: entries[index + 1].revision };
  }

  /** 手动勾选的两个 revision（不足两项时 undefined）。 */
  selectedPair(): { a: number; b: number } | undefined {
    const values = [...this.selectionValue];
    return values.length === 2 ? { a: values[0], b: values[1] } : undefined;
  }

  /* ------------------------- reset 与源栈重建 ------------------------- */

  /**
   * 清除当前目标历史会话并重读首批（resetHistorySession 的模型入口）：
   * - unresolved 拒绝（返回 'rejected'，不改变任何状态）；
   * - 保留 target/filter/follow 与已解析的 upper 三字段，不重新解析 HEAD；
   * - 清 source 栈/原始/扫描/命中/可见集合、勾选、详情与上限状态，
   *   全部计数归零，并按原 upper 重建初始源（调用方随后重读首批）。
   */
  reset(): 'ok' | 'rejected' {
    if (!this.sessionReady || this.sessionValue.upperSource === 'unresolved') {
      return 'rejected';
    }
    if (!resetHistorySession(this.sessionValue)) {
      return 'rejected';
    }
    this.rebuildSources();
    this.selectionValue.clear();
    this.detailValue = undefined;
    this.roundFetched = 0;
    this.roundUnique = 0;
    this.loadErrorValue = undefined;
    this.phaseValue = 'ready';
    return 'ok';
  }

  /** 按已记录的 upper 与目标存在性重建初始源（不发起任何 IO）。 */
  private rebuildSources(): void {
    const ctx = this.requireContext();
    const upper = this.sessionValue.upperRevision;
    if (upper === null) {
      this.sessionValue.sources = [];
      updateHistoryDerivedCounters(this.sessionValue);
      return;
    }
    const source = this.targetPresentAtUpper
      ? createTargetSource(ctx.target, upper)
      : this.nearestExistingAncestor !== undefined
        ? createAncestorFilterSource(ctx.target, this.nearestExistingAncestor, upper)
        : undefined;
    this.sessionValue.sources = source !== undefined ? [source] : [];
    this.sessionValue.activeSourceIndex = 0;
    this.sessionValue.visibleEntries = [];
    this.sessionValue.displayedCount = 0;
    updateHistoryDerivedCounters(this.sessionValue);
  }

  /* ------------------------- 序列化 ------------------------- */

  /** 持久化快照（upper/limitState 作为 store 顶层字段单独写，与阶段 1 冻结形状一致）。 */
  serialize(): {
    browsable: HistoryBrowsableState;
    upper: { upperRevision: number | null; upperSource: HistoryUpperSource; headState: HistoryHeadState };
    historyLimitState: { reasons: HistoryLimitReason[] } | null;
  } | undefined {
    const ctx = this.ctx;
    if (ctx === undefined) {
      return undefined;
    }
    const session = this.sessionValue;
    const browsable: HistoryBrowsableState = {
      version: HISTORY_BROWSABLE_VERSION,
      repositoryUuid: ctx.repositoryUuid,
      target: { ...ctx.target },
      filter: { ...this.filterValue },
      followCopies: this.followCopiesValue,
      targetPresentAtUpper: this.targetPresentAtUpper,
      ...(this.nearestExistingAncestor !== undefined
        ? { nearestExistingAncestor: this.nearestExistingAncestor }
        : {}),
      session: {
        upperRevision: session.upperRevision,
        upperSource: session.upperSource,
        headState: session.headState,
        sources: session.sources.map((source) => ({ ...source })),
        activeSourceIndex: session.activeSourceIndex,
        entries: [...session.entriesByRevision.values()],
        scannedRevisionIds: [...session.scannedRevisionIds],
        scannedAuthors: [...session.scannedAuthors],
        rawFetchedTotal: session.rawFetchedTotal,
        displayedCount: session.displayedCount,
        followCopies: session.followCopies,
        historyLimitState: session.historyLimitState !== null
          ? { reasons: session.historyLimitState.reasons.map((reason) => ({ ...reason })) }
          : null,
      },
      selection: [...this.selectionValue],
      ...(this.detailValue !== undefined ? { detailRevision: this.detailValue.revision } : {}),
    };
    return {
      browsable,
      upper: {
        upperRevision: session.upperRevision,
        upperSource: session.upperSource,
        headState: session.headState,
      },
      historyLimitState: session.historyLimitState !== null
        ? { reasons: session.historyLimitState.reasons.map((reason) => ({ ...reason })) }
        : null,
    };
  }

  /* ------------------------- 渲染 ------------------------- */

  /** 构建完整面板状态（宿主每帧推送；busy/writeLocked 由控制器合并占用态）。 */
  buildPanelState(sessionId: string): PanelState {
    const state: PanelState = {
      sessionId,
      title: historyText('panelTitle'),
      targetLabel: this.targetLabelText(),
      revision: 0,
      formRevision: 0,
      busy: this.isLoading(),
      banners: this.buildBanners(),
      layout: {
        layout: 'master-detail',
        masterLabel: historyText('masterLabel'),
        detailLabel: historyText('detailLabel'),
        masterScrollKey: 'history-table',
        detailScrollKey: 'history-detail',
      },
      headerBadges: this.buildHeaderBadges(),
      hint: this.buildHint(),
      footer: this.buildFooter(),
    };
    const table = this.buildTable();
    if (table !== undefined) {
      state.table = table;
    }
    const filterPanel = this.buildFilterPanel();
    if (filterPanel !== undefined) {
      state.filterPanel = filterPanel;
    }
    const detail = this.buildDetail();
    if (detail !== undefined) {
      state.detail = detail;
    }
    return state;
  }

  private requireContext(): HistoryModelContext {
    if (this.ctx === undefined) {
      throw new Error('历史会话尚未打开（缺少目标上下文）');
    }
    return this.ctx;
  }

  private targetLabelText(): string {
    const ctx = this.ctx;
    if (ctx === undefined) {
      return historyText('panelTitle');
    }
    const kind = ctx.target.kind === 'dir' ? historyText('targetKindDir') : historyText('targetKindFile');
    const shown = ctx.localPath ?? (ctx.target.relativePath === ''
      ? ctx.target.repositoryRootUrl
      : `^/${ctx.target.relativePath}`);
    return `${kind} ${shown}`;
  }

  private buildHint(): string {
    const ctx = this.ctx;
    if (ctx === undefined) {
      return '';
    }
    return [
      format(strings.historyPanel.repositoryUrl, { url: ctx.target.repositoryRootUrl }),
      format(strings.historyPanel.nodeUrl, { url: ctx.target.url }),
      format(strings.historyPanel.relativePath, { path: ctx.target.relativePath }),
    ].join(' · ');
  }

  private buildHeaderBadges(): PanelState['headerBadges'] {
    const ctx = this.ctx;
    if (ctx === undefined) {
      return [];
    }
    const badges: NonNullable<PanelState['headerBadges']> = [];
    if (ctx.localBaseRevision !== undefined) {
      badges.push({ text: historyText('baseBadge', { revision: String(ctx.localBaseRevision) }) });
    }
    if (!this.sessionReady) {
      return badges;
    }
    const session = this.sessionValue;
    if (session.upperRevision === null) {
      badges.push({ text: historyText('headUnknownBadge'), warn: true });
    } else if (session.upperSource === 'snapshot') {
      badges.push({ text: historyText('snapshotBadge', { revision: String(session.upperRevision) }) });
    } else if (session.upperSource === 'base-fallback') {
      badges.push({ text: historyText('baseUpperBadge', { revision: String(session.upperRevision) }), warn: true });
    } else {
      badges.push({ text: historyText('headBadge', { revision: String(session.upperRevision) }) });
    }
    return badges;
  }

  private buildBanners(): BannerSpec[] {
    const banners: BannerSpec[] = [...this.notices];
    if (this.phaseValue === 'error') {
      banners.unshift({
        id: 'historyOpenError',
        level: 'error',
        title: historyText('unknownFailedTitle'),
        detail: this.describeError(this.errorValue),
        dismissable: false,
        actions: [{ id: 'historyRetry', label: historyText('retry') }],
      });
      return banners;
    }
    if (this.sessionReady && this.sessionValue.upperRevision === null) {
      const actions: ActionSpec[] = [{ id: 'historyRetry', label: historyText('retry') }];
      if (this.localBaseRevision() !== undefined) {
        actions.push({ id: 'historyBaseFallback', label: historyText('tryBaseUpper') });
      }
      banners.push({
        id: 'historyHeadUnavailable',
        level: 'warn',
        title: historyText('unresolvedTitle'),
        detail: this.headErrorValue !== undefined
          ? format(strings.historyPanel.headUnavailable, { message: this.headErrorValue.message })
          : historyText('unresolvedDetail'),
        dismissable: false,
        actions,
      });
      return banners;
    }
    if (this.loadErrorValue !== undefined) {
      banners.push({
        id: 'historyLoadError',
        level: 'error',
        title: this.errorTitle(this.loadErrorValue),
        detail: this.describeError(this.loadErrorValue),
        dismissable: false,
        actions: [{ id: 'historyRetry', label: historyText('retryLoad') }],
      });
    }
    const limits = this.sessionValue.historyLimitState;
    if (limits !== null && limits.reasons.length > 0) {
      banners.push({
        id: 'historyLimits',
        level: 'warn',
        title: historyText('panelTitle'),
        detail: this.describeLimits(limits.reasons),
        dismissable: false,
      });
    }
    if (this.roundFetched > 0) {
      banners.push({
        id: 'historyRound',
        level: 'info',
        title: format(strings.historyPanel.scannedThisLoad, { count: String(this.roundFetched) }),
        detail: this.sessionValue.visibleMatched === 0
          ? historyText('roundNoMatch', {
              count: String(this.roundFetched),
              unique: String(this.roundUnique),
            })
          : format(strings.historyPanel.uniqueRevisionsThisLoad, { count: String(this.roundUnique) }),
        dismissable: true,
      });
    }
    return banners;
  }

  private describeLimits(reasons: HistoryLimitReason[]): string {
    const matched = reasons.find((reason) => reason.kind === 'matched');
    const scanned = reasons.find((reason) => reason.kind === 'scanned');
    if (matched !== undefined && scanned !== undefined) {
      return format(strings.historyPanel.limitBoth, {
        matchedActual: String(matched.actual),
        matchedLimit: String(matched.limit),
        scannedActual: String(scanned.actual),
        scannedLimit: String(scanned.limit),
      });
    }
    if (matched !== undefined) {
      return format(strings.historyPanel.limitMatched, {
        limit: String(matched.limit),
        actual: String(matched.actual),
      });
    }
    return format(strings.historyPanel.limitScanned, {
      limit: String(scanned!.limit),
      actual: String(scanned!.actual),
    });
  }

  private errorTitle(error: BrowserError): string {
    switch (error.kind) {
      case 'auth':
        return historyText('authFailedTitle');
      case 'permission':
        return historyText('permissionFailedTitle');
      case 'network':
        return historyText('networkFailedTitle');
      default:
        return historyText('unknownFailedTitle');
    }
  }

  private describeError(error: BrowserError | undefined): string {
    return format(strings.historyPanel.loadFailedDetail, { message: error?.message ?? '' });
  }

  private buildFooter(): PanelState['footer'] {
    const session = this.sessionValue;
    const summary = this.sessionReady
      ? [
          historyText('scannedSummary', { scanned: String(session.scannedUniqueRevisions) }),
          historyText('matchedSummary', { matched: String(session.loadedMatchedCount) }),
          historyText('visibleSummary', { visible: String(session.visibleMatched) }),
          historyText('displayedSummary', { displayed: String(session.displayedCount) }),
        ].join(' · ')
      : historyText('panelTitle');
    const secondary: ActionSpec[] = [];
    if (this.ctx !== undefined && this.sessionReady && this.phaseValue !== 'error') {
      // 「比较所选版本」是冻结动作 compareHistoryRevisions 的稳定入口：
      // 恰好勾选两项时可用，其余情况禁用并给出 compareNeedsTwo 原因。
      const pair = this.selectedPair();
      secondary.push({
        id: 'compareHistoryRevisions',
        label: historyText('compareSelected'),
        disabled: pair === undefined,
        ...(pair === undefined ? { disabledReason: historyText('compareNeedsTwo') } : {}),
      });
      if (session.upperSource === 'snapshot') {
        // 快照会话不显示 refreshHistoryUpper；reset 仍可重读同一快照。
        secondary.push({ id: 'resetHistorySession', label: historyText('resetSession') });
      } else if (session.upperRevision !== null) {
        secondary.push({ id: 'refreshHistoryUpper', label: historyText('refreshHead'), payload: { mode: 'head' } });
        secondary.push({ id: 'resetHistorySession', label: historyText('resetSession') });
      }
    }
    if (this.phaseValue === 'error') {
      secondary.push({ id: 'refresh', label: historyText('retry') });
    }
    // 加载中禁用“加载更多”：与控制器 isLoading 的重复请求守卫同一事实，
    // 避免出现「可点被拒」的假可用按钮；禁用原因按真实原因给出（未建立
    // 会话/加载中/已加载全部），不能复用面板标题充当 tooltip。
    const loadMoreDisabled = !this.sessionReady || !session.hasMore || this.isLoading();
    const loadMoreDisabledReason = !this.sessionReady
      ? historyText('openingTitle')
      : !session.hasMore
        ? historyText('loadMoreAllLoaded')
        : historyText('loadMoreLoading');
    return {
      summary,
      primary: {
        id: 'loadMoreHistory',
        label: historyText('loadMore'),
        disabled: loadMoreDisabled,
        ...(loadMoreDisabled ? { disabledReason: loadMoreDisabledReason } : {}),
      },
      ...(secondary.length > 0 ? { secondary } : {}),
    };
  }

  private buildFilterPanel(): PanelState['filterPanel'] {
    if (!this.sessionReady || this.sessionValue.upperRevision === null) {
      // unresolved 不开放 filter-scoped history actions。
      return undefined;
    }
    const filter = this.filterValue;
    const authors = this.authors();
    const authorOptions = [
      { value: '__all__', label: historyText('filterAllAuthors') },
      ...authors.map((author) => ({ value: author, label: author })),
    ];
    if ((filter.author ?? '') !== '' && !authors.includes(filter.author!)) {
      authorOptions.push({ value: filter.author!, label: filter.author! });
    }
    const dateError = isHistoryDateRangeReversed(filter) ? historyText('dateRangeReversed') : undefined;
    const fields: FilterPanelFieldSpec[] = [
      { id: 'keyword', kind: 'text', label: historyText('filterKeyword'), value: filter.keyword ?? '' },
      {
        id: 'author',
        kind: 'select',
        label: historyText('filterAuthor'),
        value: filter.author ?? '__all__',
        options: authorOptions,
      },
      {
        id: 'dateFrom',
        kind: 'date',
        label: historyText('filterDateFrom'),
        value: filter.dateFrom ?? '',
        ...(dateError !== undefined ? { error: dateError } : {}),
      },
      {
        id: 'dateTo',
        kind: 'date',
        label: historyText('filterDateTo'),
        value: filter.dateTo ?? '',
        ...(dateError !== undefined ? { error: dateError } : {}),
      },
      { id: 'path', kind: 'text', label: historyText('filterPath'), value: filter.path ?? '' },
      {
        id: 'pageSize',
        kind: 'select',
        label: historyText('filterPageSize'),
        value: String(this.pageSizeValue),
        options: HISTORY_PAGE_SIZES.map((size) => ({
          value: String(size),
          label: format(historyText('pageSizeOption'), { count: String(size) }),
        })),
      },
      {
        id: 'follow',
        kind: 'select',
        label: historyText('filterFollow'),
        value: this.followCopiesValue ? 'follow' : 'stop',
        options: [
          { value: 'follow', label: historyText('followOptionFollow') },
          { value: 'stop', label: historyText('followOptionStop') },
        ],
      },
    ];
    return {
      id: HISTORY_FILTER_PANEL_ID,
      title: historyText('filterTitle'),
      fields,
      clearAction: { id: 'clearHistoryFilters', label: historyText('clearFilters') },
    };
  }

  /** 当前表格行（已展示前缀，按 revision 降序）。 */
  buildTableRows(): TableRowSpec[] {
    return this.sessionValue.visibleEntries.slice(0, this.sessionValue.displayedCount).map((entry) => ({
      id: historyRowId(entry.revision),
      cells: {
        revision: `r${entry.revision}`,
        message: messageFirstLine(entry.message),
        author: entry.author ?? '',
        date: formatLogDate(entry.date),
        paths: String(entry.paths.length),
      },
      selected: this.selectionValue.has(entry.revision),
      selectionLabel: `r${entry.revision}`,
    }));
  }

  private buildTable(): TableSpec | undefined {
    if (this.ctx === undefined) {
      return undefined;
    }
    const session = this.sessionValue;
    const runnable = this.sessionReady && session.upperRevision !== null;
    return {
      id: HISTORY_TABLE_ID,
      columns: [
        { key: 'revision', label: historyText('columnRevision') },
        { key: 'message', label: historyText('columnMessage') },
        { key: 'author', label: historyText('columnAuthor') },
        { key: 'date', label: historyText('columnDate') },
        { key: 'paths', label: historyText('columnChangedPaths') },
      ],
      sort: { key: 'revision', direction: 'desc' },
      pagination: appendPagination(session.visibleMatched, session.displayedCount),
      rows: runnable ? this.buildTableRows() : [],
      selection: {
        mode: 'revision',
        maxSelected: 2,
        ariaLabel: historyText('selectionAriaLabel'),
      },
      rowSelectIntent: 'selectHistoryRevision',
      loadMoreAction: {
        id: 'loadMoreHistory',
        label: historyText('loadMore'),
        disabled: !runnable || !session.hasMore || this.isLoading(),
      },
      loadMoreInfo: {
        // 加载更多旁的累计计数：已展示前缀 / 当前筛选可见 / 会话扫描与
        // 命中 / 本轮回包（thisLoad 全 0 时视图隐藏“本轮”行，pending-only
        // 不沿用旧值）。
        summary: [
          historyText('displayedSummary', { displayed: String(session.displayedCount) }),
          historyText('visibleSummary', { visible: String(session.visibleMatched) }),
        ].join(' · '),
        sessionSummary: [
          historyText('scannedSummary', { scanned: String(session.scannedUniqueRevisions) }),
          historyText('matchedSummary', { matched: String(session.loadedMatchedCount) }),
        ].join(' · '),
        thisLoad: { rawFetched: this.roundFetched, uniqueScanned: this.roundUnique },
      },
      empty: this.buildTableEmpty(),
      filterEmpty: {
        title: strings.historyPanel.noMatchTitle,
        detail: strings.historyPanel.noMatchDetail,
      },
      note: [
        historyText('scannedSummary', { scanned: String(session.scannedUniqueRevisions) }),
        historyText('matchedSummary', { matched: String(session.loadedMatchedCount) }),
      ].join(' · '),
    };
  }

  private buildTableEmpty(): { title: string; detail?: string } {
    if (!this.sessionReady || this.phaseValue === 'opening') {
      return { title: historyText('openingTitle'), detail: historyText('openingDetail') };
    }
    if (this.phaseValue === 'error') {
      return { title: historyText('unknownFailedTitle'), detail: this.describeError(this.errorValue) };
    }
    if (this.sessionValue.upperRevision === null) {
      return { title: historyText('unresolvedTitle'), detail: historyText('unresolvedDetail') };
    }
    const outcome = classifyHistoryOutcome(this.sessionValue, {
      targetPresentAtUpper: this.targetPresentAtUpper,
    });
    if (outcome === 'notFound') {
      return { title: historyText('notFoundTitle'), detail: historyText('notFoundDetail') };
    }
    if (outcome === 'noMatch') {
      return { title: strings.historyPanel.noMatchTitle, detail: strings.historyPanel.noMatchDetail };
    }
    if (this.sessionValue.canFetchMore) {
      return {
        title: historyText('notFoundScanningTitle', {
          scanned: String(this.sessionValue.scannedUniqueRevisions),
        }),
        detail: historyText('notFoundScanningDetail'),
      };
    }
    return { title: strings.historyPanel.emptyTitle, detail: strings.historyPanel.emptyDetail };
  }

  private buildDetail(): DetailSpec | undefined {
    const detail = this.detailValue;
    if (detail === undefined) {
      if (this.phaseValue !== 'ready' && this.phaseValue !== 'loading') {
        return undefined;
      }
      return { title: historyText('detailEmpty'), sections: [] };
    }
    const entry = detail.entry;
    const resolution = detail.resolution;
    const sections: DetailSectionSpec[] = [];
    const kv: Array<{ label: string; value: string; mono?: boolean }> = [
      { label: historyText('detailRevision'), value: `r${entry.revision}`, mono: true },
      { label: historyText('detailAuthor'), value: entry.author ?? '—' },
      { label: historyText('detailDate'), value: formatLogDate(entry.date) || '—' },
      { label: historyText('detailNodeState'), value: this.describeResolution(resolution) },
    ];
    if (resolution.status === 'present') {
      // repositoryPath 契约无前导斜杠；先归一再拼展示前缀，避免上游形态回退出双斜杠。
      kv.push({
        label: historyText('detailActualPath'),
        value: `/${normalizeRelativePath(resolution.repositoryPath)}`,
        mono: true,
      });
      kv.push({ label: historyText('detailActualUrl'), value: resolution.url, mono: true });
    }
    sections.push({ kind: 'kv', entries: kv });
    sections.push({
      kind: 'text',
      heading: historyText('detailMessageHeading'),
      paragraphs: [entry.message === '' ? '—' : entry.message],
    });
    sections.push({
      kind: 'paths',
      heading: format(historyText('detailPathsHeading'), { count: String(entry.paths.length) }),
      paths: entry.paths.map((change) => ({
        path: change.path,
        action: change.action,
        ...(change.kind !== undefined ? { kind: change.kind } : {}),
        ...(change.copyfromPath !== undefined
          ? {
              copyfrom: {
                path: change.copyfromPath,
                ...(change.copyfromRevision !== undefined
                  ? { revision: String(change.copyfromRevision) }
                  : {}),
                label: historyText('detailPathCopyFrom'),
              },
            }
          : {}),
      })),
      emptyText: historyText('detailPathsEmpty'),
      collapseAfter: HISTORY_PATHS_COLLAPSE_AFTER,
      moreLabel: historyText('detailPathsMore'),
    });
    const copyWindow = this.buildCopyWindow();
    if (copyWindow.length > 0) {
      sections.push({
        kind: 'copyWindow',
        heading: historyText('detailCopyWindowHeading'),
        items: copyWindow,
      });
    }
    sections.push({
      kind: 'text',
      heading: historyText('detailActionsHeading'),
      paragraphs: [this.describeActions(resolution)],
    });
    sections.push({ kind: 'actions', actions: this.buildDetailActions(detail) });
    return { id: historyRowId(entry.revision), title: `r${entry.revision}`, sections };
  }

  private describeResolution(resolution: HistoryDetailResolutionView): string {
    switch (resolution.status) {
      case 'loading':
        return historyText('detailLoading');
      case 'present':
        return historyText('detailNodePresent');
      case 'absent':
        return resolution.deletedRevision !== undefined
          ? historyText('detailNodeAbsent', { revision: String(resolution.deletedRevision) })
          : historyText('detailNodeAbsentUnknown');
      case 'notFoundAtRevision':
        return historyText('detailNodeNotFound');
      case 'error':
        return historyText('detailNodeError', { message: resolution.message });
    }
  }

  private describeActions(resolution: HistoryDetailResolutionView): string {
    const ctx = this.requireContext();
    switch (resolution.status) {
      case 'loading':
        return historyText('detailActionsLoading');
      case 'error':
        return historyText('detailActionsError');
      case 'absent':
        return historyText('detailActionsDeleted');
      case 'notFoundAtRevision':
        return historyText('detailActionsNotFound');
      case 'present': {
        const parts: string[] = [
          ctx.target.kind === 'dir' ? historyText('detailActionsDir') : historyText('detailActionsFile'),
        ];
        const targetPath = normalizeRelativePath(ctx.target.relativePath);
        const actualPath = normalizeRelativePath(resolution.repositoryPath);
        if (targetPath !== actualPath) {
          parts.push(historyText('detailActionsCopySource', { path: `/${actualPath}` }));
        } else if (ctx.source === 'local') {
          parts.push(historyText('detailActionsLocalUpdate'));
        }
        return parts.join(' ');
      }
    }
  }

  /**
   * 复制窗口：已加载历史中覆盖目标路径的复制记录（新→旧，含嵌套复制），
   * 用于详情展示目标身份的复制边界。
   */
  private buildCopyWindow(): Array<{
    targetPath: string;
    sourcePath: string;
    sourceRevision?: string;
    boundaryRevision?: string;
  }> {
    const ctx = this.requireContext();
    const tracked = normalizeRelativePath(ctx.target.relativePath);
    const items: Array<{
      targetPath: string;
      sourcePath: string;
      sourceRevision?: string;
      boundaryRevision?: string;
    }> = [];
    for (const entry of sortedEntries(this.sessionValue.entriesByRevision.values())) {
      for (const change of entry.paths) {
        if (change.action !== 'A' && change.action !== 'R') {
          continue;
        }
        if (change.copyfromPath === undefined || change.copyfromRevision === undefined) {
          continue;
        }
        const path = normalizeRelativePath(change.path);
        if (path !== tracked && !tracked.startsWith(`${path}/`)) {
          continue;
        }
        if (ctx.target.kind === 'dir' && tracked !== '' && path.startsWith(`${tracked}/`)) {
          continue;
        }
        items.push({
          targetPath: `/${path}`,
          sourcePath: `/${normalizeRelativePath(change.copyfromPath)}`,
          sourceRevision: String(change.copyfromRevision),
          boundaryRevision: String(entry.revision),
        });
      }
    }
    return items;
  }

  private buildDetailActions(detail: HistoryDetailState): ActionSpec[] {
    const rowId = historyRowId(detail.revision);
    const ctx = this.requireContext();
    const resolution = detail.resolution;
    const present = resolution.status === 'present';
    const deleted = resolution.status === 'absent';
    const actualPath = present ? normalizeRelativePath(resolution.repositoryPath) : undefined;
    const targetPath = normalizeRelativePath(ctx.target.relativePath);
    const copySource = present && actualPath !== targetPath;
    const local = ctx.source === 'local';
    const isDir = ctx.target.kind === 'dir';
    const blocked = (reason: string): { disabled: true; disabledReason: string } => ({
      disabled: true,
      disabledReason: reason,
    });
    /** 解析未就绪/不可用时的统一原因（加载中/失败/不存在/删除）。 */
    const resolutionBlock = resolution.status === 'loading'
      ? historyText('detailActionsLoading')
      : resolution.status === 'error'
        ? historyText('detailActionsError')
        : resolution.status === 'notFoundAtRevision'
          ? historyText('detailActionsNotFound')
          : historyText('detailActionDisabledDeleted');
    const actions: ActionSpec[] = [];
    const pair = this.previousVisiblePair();
    actions.push({
      id: 'comparePreviousVisible',
      label: historyText('previousCompare'),
      disabled: pair === undefined,
      ...(pair === undefined ? { disabledReason: historyText('previousBoundary') } : {}),
    });
    // 导出：present 导出该版本；删除提交导出 deletionRevision-1 前版本；
    // 加载/失败/无法定位时不可用。
    const exportable = present || deleted;
    actions.push({
      id: 'exportHistoryVersion',
      label: historyText('detailActionExport'),
      ...(exportable ? {} : blocked(resolutionBlock)),
    });
    // 查看/追溯只对存在的文件；目录不提供。
    const filePresent = present && !isDir;
    const fileBlock = present && isDir ? historyText('detailActionDisabledDir') : resolutionBlock;
    actions.push({
      id: 'viewHistoryRevision',
      label: historyText('detailActionView'),
      ...(filePresent ? {} : blocked(fileBlock)),
    });
    actions.push({
      id: 'blameHistoryRevision',
      label: historyText('detailActionBlame'),
      ...(filePresent ? {} : blocked(fileBlock)),
    });
    // 更新只对本地目标且实际路径就是目标路径（复制来源路径不能更新新路径）。
    const updatable = local && present && !copySource;
    const updateBlock = !local
      ? historyText('detailActionDisabledNotLocal')
      : copySource
        ? historyText('detailActionDisabledCopySource')
        : resolutionBlock;
    actions.push({
      id: 'updateToHistoryRevision',
      label: historyText('detailActionUpdate'),
      ...(updatable ? {} : blocked(updateBlock)),
    });
    // 检出此版本只对存在的远端目录（文件目标走导出）。
    const checkoutable = isDir && present;
    actions.push({
      id: 'checkoutHistoryDirectory',
      label: historyText('detailActionCheckout'),
      ...(checkoutable ? {} : blocked(present && !isDir ? historyText('detailActionDisabledDir') : resolutionBlock)),
    });
    // BASE 比较针对本地工作副本当前变化，与所选 revision 解耦。
    actions.push({
      id: 'compareBase',
      label: historyText('detailActionCompareBase'),
      ...(local ? {} : blocked(historyText('detailActionDisabledNotLocal'))),
    });
    const copies: Array<{ kind: string; label: string }> = [
      { kind: 'message', label: historyText('copyMessage') },
      { kind: 'revision', label: historyText('copyRevision') },
      { kind: 'changedPath', label: historyText('copyPaths') },
      { kind: 'nodeUrl', label: historyText('copyNodeUrl') },
      { kind: 'targetPath', label: historyText('copyTargetPath') },
    ];
    for (const copy of copies) {
      actions.push({
        id: 'copyHistoryText',
        label: copy.label,
        payload: { 'copy-kind': copy.kind, 'row-id': rowId },
      });
    }
    return actions;
  }
}

/* ---------------------------------------------------------------------------
 * 内部小工具
 * ------------------------------------------------------------------------- */

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sameFilter(a: HistoryFilter, b: HistoryFilter): boolean {
  return (a.keyword ?? '') === (b.keyword ?? '')
    && (a.author ?? '') === (b.author ?? '')
    && (a.dateFrom ?? '') === (b.dateFrom ?? '')
    && (a.dateTo ?? '') === (b.dateTo ?? '')
    && (a.path ?? '') === (b.path ?? '');
}

function sanitizeFilter(filter: unknown): HistoryFilter {
  if (filter === null || typeof filter !== 'object') {
    return {};
  }
  const candidate = filter as Record<string, unknown>;
  const result: HistoryFilter = {};
  for (const key of ['keyword', 'author', 'dateFrom', 'dateTo', 'path'] as const) {
    const value = candidate[key];
    if (typeof value === 'string') {
      result[key] = value;
    }
  }
  return result;
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<HistoryEntry>;
  return typeof candidate.revision === 'number' && Array.isArray(candidate.paths);
}

function isHistorySource(value: unknown): value is HistorySource {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<HistorySource>;
  return typeof candidate.id === 'string'
    && typeof candidate.queryUrl === 'string'
    && typeof candidate.cursor === 'number';
}

function isLimitReason(value: unknown): value is HistoryLimitReason {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<HistoryLimitReason>;
  return (candidate.kind === 'matched' || candidate.kind === 'scanned')
    && typeof candidate.limit === 'number'
    && typeof candidate.actual === 'number';
}
