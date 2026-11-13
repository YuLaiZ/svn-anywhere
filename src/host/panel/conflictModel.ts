/**
 * P7 冲突模型（M4 阶段 5 任务 1/2 的模型部分）：扫描编排、归一化视图、
 * 文件/属性/树 tab 与计数、详情、动作矩阵、resolvedLedger 会话合并。
 * 纯模型，不依赖 vscode（宿主控制器与任务执行器共用本模块）。
 *
 * 职责边界（技术方案 §5.1/§5.2/§5.3/§5.5，阶段 0 V4 实测回填）：
 * - 扫描以工作副本根为互斥与缓存范围：`scanConflictScope` 复用
 *   core/conflict 的 status 三判据、批量 info + 逐项补偿、external 边界
 *   过滤、重复节点去重、树冲突三形态容错与缺失路径最近存在祖先范围
 *   匹配；本模块只补两件 core 扫描不覆盖的编排：
 *   ① 属性三值按路径补查（远端来源只在补查时经注入的 authorizer 补认证，
 *   authScope/credentialProvider 由宿主提供，本地 status/info 命令绝不
 *   携带凭据）；
 *   ② 内容类型分类注入（svn:mime-type + 前 8 KiB NUL，默认实现
 *   createWorkingCopyContentClassifier 复用 core 判据）。
 * - 动作矩阵完全从 core/resolve.availableResolveActions 派生，不另写一套：
 *   文本六值、二进制三值（禁用 base 与冲突块变体）、属性逐项选择、
 *   树冲突确认后 working、混合路径禁用直接应用、类型未知只回扫；
 *   svn: 保留属性（mergeinfo 等）计入属性冲突但 autoUnsupported 且不进
 *   自动批量；批量适用性字段供阶段 7 计划使用。
 * - resolvedLedger 只在扩展宿主内存：真实扫描仍报告的同一路径 + 冲突
 *   类型永远以未解决为准（core mergeResolvedLedger）；台账不参与未解决
 *   计数。关闭重开经 m4SessionStore 的 conflictSnapshot/postponed/
 *   resolvedLedger/browsable 四层恢复，宿主重启后自然丢弃。
 * - 扫描代次：每次 beginScan 递增；迟到回包经 isScanCurrent 丢弃。关闭
 *   面板只解除订阅（控制器职责），不把未完成扫描误判为失败。
 *
 * 本模块不返回无出处的用户文案：默认中文在 CONFLICT_TEXT_DEFAULTS，
 * i18n.conflictPanel / resolvePanel 落地同名键后自动优先（与 historyModel
 * 的模式一致）。
 */
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  mergeResolvedLedger,
  normalizeConflictRecords,
  parseInfoXml,
  readPropertyConflictValues,
  scanConflicts,
  summarizeConflicts,
  toWcRelativePath,
  type ConflictContentKind,
  type ConflictKind,
  type ConflictListRow,
  type ConflictRecord,
  type ConflictScanFailure,
  type ConflictScanResult,
  type ConflictSummary,
  type InfoXmlEntry,
  type PostponedConflictEntry,
  type PropertyValue,
  type ResolvedLedgerEntry,
} from '../../core/conflict';
import { SvnError } from '../../core/errors';
import {
  availableResolveActions,
  type ResolveRejectReason,
  type SvnAcceptValue,
} from '../../core/resolve';
import {
  authScopeOfUrl,
  run,
  urlWithPeg,
  type AuthCredentials,
  type AuthScope,
  type RunOptions,
} from '../../core/svnCli';
import {
  BINARY_PROBE_BYTES,
  classifyContentKind as classifyRemoteContentKind,
} from '../../core/remoteBrowse';
import {
  isRelPathWithinScope,
  resolveRealPathWithSuffix,
} from '../../core/conflict';
import { escapePeg } from '../../core/workspace';
import type { ConflictsResultScope } from '../taskRegistry';
import {
  putM4ScopeSession,
  readM4ScopeSession,
  type M4ScopePutResult,
  type M4SessionStoreContext,
} from '../sessionResults';
import { format, strings } from '../i18n';
import { CONFLICT_TABS, type ConflictTab } from './protocol';
import {
  type ActionSpec,
  type BannerSpec,
  type ConflictListSpec,
  type ConflictRowSpec,
  type ConfirmDialogSpec,
  type DetailArtifactSpec,
  type DetailPropertySpec,
  type DetailPropertyValueSpec,
  type DetailSectionSpec,
  type DetailSpec,
  type DetailVariantOptionSpec,
  type PanelState,
  type ProgressState,
  type TabsSpec,
} from './state';

/* ---------------------------------------------------------------------------
 * 常量与文案
 * ------------------------------------------------------------------------- */

/** 冲突表格组件 ID。 */
export const CONFLICT_TABLE_ID = 'conflicts';

/** tab 容器 ID（意图 setConflictTab 的定位键）。 */
export const CONFLICT_TABS_ID = 'conflict-tabs';

/** 会话持久化形状版本（结构变化时旧缓存按 fresh 处理）。 */
export const CONFLICT_BROWSABLE_VERSION = 1;

/** 内容探测窗口：前 8 KiB（与 core/remoteBrowse.BINARY_PROBE_BYTES 同口径）。 */
export const CONFLICT_CONTENT_PROBE_BYTES = BINARY_PROBE_BYTES;

/** 整文件批量策略：二进制不开放冲突块变体，文本也只开放整文件结果。 */
export const CONFLICT_BATCH_WHOLE_VARIANTS: readonly SvnAcceptValue[] = ['mine-full', 'theirs-full'];

/** 六种变体的展示顺序：常用整文件结果 → 文本高级变体 → 冲突基线。 */
export const CONFLICT_VARIANT_ORDER: readonly SvnAcceptValue[] = [
  'mine-full',
  'theirs-full',
  'working',
  'mine-conflict',
  'theirs-conflict',
  'base',
];

/**
 * 模型本地文案默认值（i18n.conflictPanel 落地同名键后自动优先取
 * i18n；未落地前定向单测无需先改 i18n）。导出供文案漂移对账测试。
 */
export const CONFLICT_TEXT_DEFAULTS = {
  panelTitle: '冲突',
  masterLabel: '冲突列表',
  detailLabel: '冲突详情',
  tabAll: '全部',
  tabText: '文件',
  tabProperty: '属性',
  tabTree: '树',
  kindText: '文件',
  kindProperty: '属性',
  kindTree: '树',
  rowStatusUnresolved: '未解决',
  rowStatusResolved: '已解决',
  rowStatusPostponed: '已推迟',
  emptyTitle: '没有冲突',
  emptyDetail: '当前范围内没有需要处理的冲突。',
  filterEmptyTitle: '该分类没有冲突',
  filterEmptyDetail: '切换到其他分类查看。',
  detailEmptyTitle: '选择冲突查看详情',
  detailEmptyDetail: '左侧列表展示当前工作副本的冲突记录。',
  scopeLabel: '范围',
  scopeWhole: '整个工作副本',
  summaryLabel: '文本 {text} · 属性 {property} · 树 {tree}',
  summaryNone: '没有冲突',
  summaryText: '文本冲突 {count}',
  summaryProperty: '属性冲突 {count}',
  summaryTree: '树冲突 {count}',
  scanFailedTitle: '冲突扫描失败',
  scanFailedDetail: '冲突扫描失败：{message}',
  scanCanceled: '冲突扫描已取消，未改动任何文件。',
  busyHeld: '同一工作副本已有冲突任务在运行，请等待完成。',
  contentKindText: '文本',
  contentKindBinary: '二进制',
  contentKindUnknown: '未知类型',
  propertyMine: '本地',
  propertyBase: '基线',
  propertyIncoming: '传入',
  externalBoundaryNotice: '外部副本成员不进入本副本冲突列表。',
  detailMetadataHeading: '冲突信息',
  detailLabelPath: '路径',
  detailLabelKinds: '冲突类型',
  detailLabelContentKind: '内容类型',
  detailLabelNodeBase: '更新后节点 BASE',
  detailLabelBaseline: '冲突基线',
  detailLabelIncoming: '传入 revision',
  detailLabelStatus: '状态',
  valueNone: '无',
  detailPropertyHeading: '属性冲突（{count}）',
  propertyValueMissing: '（不存在）',
  propertyValueEmpty: '（空值）',
  propertyValueBinary: '（二进制值，{bytes} 字节）',
  propertyValueTruncated: '{value}…（已截断）',
  inspectPropertyName: '属性名',
  inspectPropertyExists: '存在({bytes} B)',
  inspectPropertyMissing: '缺失',
  detailArtifactHeading: 'SVN 辅助文件',
  artifactBase: '冲突基线',
  artifactMine: '本地工作内容',
  artifactIncoming: '传入内容',
  artifactReject: '属性拒绝文件',
  artifactEmpty: '没有辅助文件。',
  detailVariantsHeading: '整文件结果与变体',
  detailVariantRequiresConfirm: '（需要确认）',
  detailSelectVariantFirst: '请先选择处理结果。',
  detailBinaryNote: '二进制冲突只提供整文件结果与版本打开，不提供冲突块变体与 base。',
  detailAutoUnsupportedNote: '该属性冲突包含 svn: 保留属性，需要检查器处理，不提供自动应用。',
  detailMixedHeading: '混合路径',
  detailMixedNote: '同一路径同时存在文件、属性或树冲突，不能直接应用单一策略；请使用工作副本终端按 SVN 交互流程处理，完成后重新扫描。',
  detailTreeHeading: '树冲突',
  detailTreeLabelOperation: '树冲突操作',
  detailTreeLabelReason: '原因',
  detailTreeLabelAction: '节点动作',
  detailTreeLabelVictim: 'victim',
  detailTreeLabelSourceLeft: '冲突基线来源',
  detailTreeLabelSourceRight: '传入来源',
  detailTreePreparedNote: '已确认文件系统节点已处理，可以执行「采用当前工作内容」。',
  detailTreeConfirmNote: '树冲突需要先在文件系统中处理节点（移动、删除或保留），再由你确认；面板不会自动移动或删除节点。',
  detailInspector: '检查器',
  detailOpenDiff: '打开差异',
  detailOpenEditor: '打开编辑器',
  detailOpenVersion: '打开版本',
  detailCopyPath: '复制路径',
  detailPostpone: '推迟',
  detailPrepareTree: '确认节点已处理',
  detailApplyWorking: '采用当前工作内容',
  detailResolvedHeading: '已解决',
  detailResolvedStrategy: '策略',
  detailResolvedOperation: '操作编号',
  detailResolvedAt: '确认时间',
  detailResolvedNote: '该冲突已在本会话回扫确认解决；真实扫描再次报告时以新冲突为准。',
  detailVersionLocal: '本地工作内容',
  detailVersionBase: '冲突基线',
  detailVersionIncoming: '传入内容',
  variantBase: '恢复冲突基线',
  variantWorking: '保留两者（人工确认）',
  variantMineConflict: '仅冲突块取本地',
  variantTheirsConflict: '仅冲突块取传入',
  variantMineFull: '全部取本地',
  variantTheirsFull: '全部取传入',
  batchHeading: '批量处理适用性',
  batchApplicable: '可纳入批量整文件策略（{strategies}）',
  batchUnsupportedMixed: '不适用：同路径混合冲突需要交互处理',
  batchUnsupportedProperty: '不适用：属性冲突需要逐项选择',
  batchUnsupportedTree: '不适用：树冲突需要节点确认',
  batchUnsupportedAuto: '不适用：保留属性需要检查器处理',
  batchUnsupportedUnknown: '不适用：内容类型未知',
  progressScanning: '正在扫描冲突…',
  progressScanningDetail: '已完成 {completed} / {total} 个候选路径。',
  wcLockedTitle: '工作副本被锁定',
  wcLockedDetail: '扫描仍可读取，但工作副本处于锁定状态，不能继续写入；请先执行「清理」。',
  failuresTitle: '{count} 个路径的详情读取失败',
  failuresDetail: '已保留状态中的冲突类型与路径，未读取到完整详情：{paths}',
  propertyUnavailableNotice: '属性值读取不完整（可能需要在远端来源补查时认证），该记录不提供自动处理。',
  rescanAction: '重新扫描',
  rescanWholeAction: '扫描整个工作副本',
  /* ---------------- P7 专用组件（冲突列表/属性选择/确认对话框） ---------------- */
  conflictListAriaLabel: '冲突列表',
  autoApplicable: '可自动处理',
  autoUnsupported: '不适用：需检查器处理',
  advancedVariants: '高级 SVN 变体',
  propertySelectLocal: '选择本地值',
  propertySelectBase: '选择基线值',
  propertySelectIncoming: '选择传入值',
  unknownRowStatus: '待核实',
  treeConfirmTitle: '确认节点已处理？',
  treeConfirmDetail: '请先在文件系统中处理该树冲突节点（移动、删除或保留），确认后将采用当前工作副本的节点状态。',
  treeConfirmButton: '确认节点已处理',
  workingConfirmTitle: '确认采用当前工作内容？',
  workingConfirmDetail: '将清除该路径的冲突标记并保留当前工作内容。',
  workingConfirmButton: '采用当前工作内容',
} as const;

type ConflictTextKey = keyof typeof CONFLICT_TEXT_DEFAULTS;

interface PanelStrings {
  readonly [key: string]: string | undefined;
}

function conflictPanelStrings(): PanelStrings | undefined {
  return (strings as unknown as { conflictPanel?: PanelStrings }).conflictPanel;
}

function resolvePanelStrings(): PanelStrings | undefined {
  return (strings as unknown as { resolvePanel?: PanelStrings }).resolvePanel;
}

/** 取 P7 冲突文案：优先 i18n.conflictPanel，回落本地默认中文；支持 {name} 占位。 */
export function conflictText(key: ConflictTextKey, params: Record<string, string> = {}): string {
  const override = conflictPanelStrings()?.[key];
  return format(override ?? CONFLICT_TEXT_DEFAULTS[key], params);
}

/** core/resolve 拒绝原因 → i18n.resolvePanel 键名（模型与执行器共用一套文案；导出供对账）。 */
export const REJECT_TEXT_KEYS: Record<ResolveRejectReason, string> = {
  'invalid-accept': 'rejectInvalidAccept',
  'postpone-not-cli': 'rejectPostponeNotCli',
  'mixed-path': 'rejectMixedPath',
  'unknown-content': 'rejectUnknownContent',
  'binary-base': 'rejectBinaryBase',
  'binary-block-variant': 'rejectBinaryBlockVariant',
  'tree-invalid-strategy': 'rejectTreeInvalidStrategy',
  'tree-requires-confirmation': 'rejectTreeRequiresConfirmation',
  'working-requires-confirmation': 'rejectWorkingRequiresConfirmation',
  'property-not-applicable': 'rejectPropertyNotApplicable',
  'property-requires-selection': 'rejectPropertyRequiresSelection',
  'property-values-unavailable': 'rejectPropertyValuesUnavailable',
  'property-auto-unsupported': 'rejectPropertyAutoUnsupported',
  'property-incomplete': 'rejectPropertyIncomplete',
  'invalid-step': 'rejectInvalidStep',
  'conflict-not-found': 'rejectConflictNotFound',
  'fingerprint-changed': 'rejectFingerprintChanged',
};

/** 拒绝原因默认文案（i18n.resolvePanel 未落地时的兜底，与 i18n 同文；导出供对账）。 */
export const REJECT_TEXT_DEFAULTS: Record<ResolveRejectReason, string> = {
  'invalid-accept': '该策略不是 svn --accept 的合法取值。',
  'postpone-not-cli': '「推迟」不是 svn --accept 取值，只改变面板状态，不执行命令。',
  'mixed-path': '同一路径同时存在文本与属性冲突时不能直接执行单一策略。',
  'unknown-content': '内容类型未知，不能自动选择二进制安全策略。',
  'binary-base': '二进制冲突不能使用 base 策略。',
  'binary-block-variant': '二进制冲突不能使用含冲突块的变体策略。',
  'tree-invalid-strategy': '树冲突不支持该策略。',
  'tree-requires-confirmation': '树冲突需要先确认节点动作。',
  'working-requires-confirmation': '「采用当前工作内容」需要二次确认。',
  'property-not-applicable': '该策略不适用于属性冲突；请逐项选择属性值。',
  'property-requires-selection': '属性冲突需要为每个属性选择本地、基线或传入值。',
  'property-values-unavailable': '属性值读取不完整，无法自动处理。',
  'property-auto-unsupported': '保留属性（svn:）的冲突不支持自动处理。',
  'property-incomplete': '并非所有冲突属性都有明确选择，不能执行 working。',
  'invalid-step': '解决步骤不合法。',
  'conflict-not-found': '目标上已没有对应冲突。',
  'fingerprint-changed': '冲突状态在读取后发生变化，请重新扫描后再选择。',
};

/** 取 resolve 拒绝原因中文文案（模型动作矩阵与执行器共用；导出供阶段 5 其余模块）。 */
export function resolveRejectText(reason: ResolveRejectReason): string {
  const override = resolvePanelStrings()?.[REJECT_TEXT_KEYS[reason]];
  return override ?? REJECT_TEXT_DEFAULTS[reason];
}

/** 六种变体标签。 */
const VARIANT_TEXT_KEYS: Record<SvnAcceptValue, ConflictTextKey> = {
  base: 'variantBase',
  working: 'variantWorking',
  'mine-conflict': 'variantMineConflict',
  'theirs-conflict': 'variantTheirsConflict',
  'mine-full': 'variantMineFull',
  'theirs-full': 'variantTheirsFull',
};

/* ---------------------------------------------------------------------------
 * m4SessionStore 集成（关闭重开恢复）
 * ------------------------------------------------------------------------- */

/**
 * 把模型当前会话写入 m4SessionStore（冲突快照/browsable/台账/推迟四个
 * 槽位，按 wcRoot + scopeRelPath 作用域寻址）。面板关闭前、每次状态变更
 * 后由控制器调用；返回的淘汰动作供控制器清理对应视图。
 */
export function persistConflictSession(
  model: ConflictModel,
  context: M4SessionStoreContext = {},
): M4ScopePutResult | undefined {
  const scope = model.scope();
  const snapshot = model.serialize();
  if (!scope || !snapshot) {
    return undefined;
  }
  return putM4ScopeSession(conflictResultScopeOf(scope), {
    ...(snapshot.browsable !== undefined ? { browsable: snapshot.browsable } : {}),
    ...(snapshot.conflictSnapshot !== undefined ? { conflictSnapshot: snapshot.conflictSnapshot } : {}),
    resolvedLedger: snapshot.resolvedLedger,
    postponed: snapshot.postponed,
  }, context);
}

/**
 * 面板重开恢复：先 adoptScope，再按 m4SessionStore 当前作用域读取快照/
 * 台账/推迟/browsable。仅恢复缓存；真实 SVN 状态仍以重新扫描为准，冲突
 * 快照缺失时回到 fresh。
 */
export function restoreConflictSession(
  model: ConflictModel,
  scope: ConflictScopeTarget,
): boolean {
  model.adoptScope(scope);
  const entry = readM4ScopeSession(conflictResultScopeOf(scope));
  if (!entry) {
    return false;
  }
  return model.restore({
    browsable: entry.browsable,
    conflictSnapshot: entry.conflictSnapshot,
    resolvedLedger: entry.resolvedLedger,
    postponed: entry.postponed,
  });
}

/* ---------------------------------------------------------------------------
 * 扫描范围与运行时（注入点）
 * ------------------------------------------------------------------------- */

/**
 * P7 扫描范围：工作副本根 + 工作副本相对范围（'.' 表示整副本）。
 * 从 P6 更新任务进入时 scopeRelPath 是更新目标；普通入口为 '.'。
 */
export interface ConflictScopeTarget {
  wcRoot: string;
  scopeRelPath: string;
}

/** 归一化范围：空串/'.' 均表示整副本。 */
export function conflictScopeOf(wcRoot: string, scopeRelPath?: string): ConflictScopeTarget {
  const normalized = scopeRelPath === undefined || scopeRelPath === '' || scopeRelPath === '.'
    ? '.'
    : scopeRelPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return { wcRoot, scopeRelPath: normalized === '' ? '.' : normalized };
}

/** 扫描范围 → 任务注册表作用域（同一身份既寻址任务绑定又寻址会话页）。 */
export function conflictResultScopeOf(target: ConflictScopeTarget): ConflictsResultScope {
  return { scopeKind: 'conflicts', wcRoot: target.wcRoot, scopeRelPath: target.scopeRelPath };
}

/** 内容类型分类注入接口：返回 undefined 表示无法分类（按 unknown 处理）。 */
export type ConflictContentClassifier = (relPath: string) => Promise<ConflictContentKind | undefined>;

/**
 * 远端值补查认证钩子：只允许在属性三值/版本来源读取远端 URL 时调用。
 * 返回补充了 authScope + getCredentials 的运行选项；用户取消或不需要
 * 认证时返回 undefined（调用方按属性值不可用处理）。
 */
export type ConflictRemoteAuthorizer = (url: string, options: RunOptions) => Promise<RunOptions | undefined>;

/** 构造注入 RunOptions 的认证提供者（host 层用 credentialProvider 包装）。 */
export function createRemoteAuthorizer(
  provider: (scope?: AuthScope) => Promise<AuthCredentials | undefined>,
): ConflictRemoteAuthorizer {
  return async (url, options) => {
    const scope = authScopeOfUrl(url);
    if (!scope) {
      return undefined;
    }
    return { ...options, authScope: scope, getCredentials: provider };
  };
}

/** 扫描编排运行时（由面板控制器/任务执行器构造）。 */
export interface ConflictScanRuntime {
  svnPath: string;
  /**
   * 本地只读命令运行选项。不要携带 getCredentials/authScope——本地
   * status/info/proplist 命令不提供凭据；远端值补查经 authorizeRemote。
   */
  localRunOptions?: RunOptions;
  /** 内容类型分类（默认不探测，contentKind='unknown'）。 */
  classifyContent?: ConflictContentClassifier;
  /** 远端值补查认证（仅属性三值读取远端 source URL 时使用）。 */
  authorizeRemote?: ConflictRemoteAuthorizer;
  /** 属性三值补查开关（默认 true）。 */
  readPropertyValues?: boolean;
  /** 进度：已完成候选数 / 候选总数。 */
  onProgress?: (completed: number, total: number) => void;
}

/** 一次扫描的归一化结果（core 结果 + 范围/时间/补查失败路径）。 */
export interface ConflictScanOutcome extends ConflictScanResult {
  scope: ConflictScopeTarget;
  scannedAt: number;
  /** 属性三值补查失败（远端认证取消/读取不完整）的路径。 */
  propertyValueFailures: string[];
}

/**
 * 完整扫描编排（技术方案 §5.1）：
 * 1. core `scanConflicts`：status 三判据 + external 过滤 + 批量 info +
 *    逐项补偿 + 归一化（不读取属性值，避免远端读取带不上按 URL 的认证）；
 * 2. 属性三值补查：本地读取失败且存在可认证远端来源时才调用
 *    authorizeRemote 后重试——认证只发生在这里；
 * 3. 内容类型分类（注入接口）；
 * 4. 摘要按归一化记录重算。
 */
export async function scanConflictScope(
  runtime: ConflictScanRuntime,
  target: ConflictScopeTarget,
): Promise<ConflictScanOutcome> {
  const localOptions = runtime.localRunOptions ?? {};
  const base = await scanConflicts(runtime.svnPath, target.wcRoot, {
    ...localOptions,
    scope: target.scopeRelPath,
    readPropertyValues: false,
    ...(runtime.classifyContent !== undefined ? { classifyContent: runtime.classifyContent } : {}),
    ...(runtime.onProgress !== undefined ? { onProgress: runtime.onProgress } : {}),
  });
  const propertyValueFailures: string[] = [];
  const records = runtime.readPropertyValues === false
    ? [...base.records]
    : await applyPropertyValues(runtime, target, base.records, propertyValueFailures);
  return {
    ...base,
    records,
    summary: summarizeConflicts(records),
    scope: { ...target },
    scannedAt: Date.now(),
    propertyValueFailures,
  };
}

/** 逐条补查属性三值；单条失败只影响该记录的自动处理能力。 */
async function applyPropertyValues(
  runtime: ConflictScanRuntime,
  target: ConflictScopeTarget,
  records: readonly ConflictRecord[],
  failures: string[],
): Promise<ConflictRecord[]> {
  const patched: ConflictRecord[] = [];
  for (const record of records) {
    if (!record.kinds.includes('property')) {
      patched.push(record);
      continue;
    }
    const next = await readRecordPropertyValues(runtime, target, record);
    if (next === undefined) {
      failures.push(record.path);
      patched.push(record);
    } else {
      patched.push(next);
    }
  }
  return patched;
}

/**
 * 单条属性冲突记录的三值补查：
 * - 先以本地只读选项读取本地/基线/传入三值；
 * - 失败时只对可认证的远端 source URL 走 authorizeRemote，再重试一次；
 * - 成功后用与扫描同一归一化口径重算记录（指纹 id 与执行前重读一致）。
 */
async function readRecordPropertyValues(
  runtime: ConflictScanRuntime,
  target: ConflictScopeTarget,
  record: ConflictRecord,
): Promise<ConflictRecord | undefined> {
  const localOptions = runtime.localRunOptions ?? {};
  const infoResult = await run(
    runtime.svnPath,
    ['info', '--xml', '--non-interactive', '--', escapePeg(record.path)],
    { cwd: target.wcRoot, ...localOptions },
  );
  if (infoResult.exitCode !== 0) {
    return undefined;
  }
  const entry = parseInfoXml(infoResult.stdout)
    .find((candidate) => toWcRelativePath(target.wcRoot, candidate.path ?? '') === record.path);
  if (!entry) {
    return undefined;
  }
  let options = localOptions;
  let values = await readPropertyConflictValues(runtime.svnPath, target.wcRoot, entry, options);
  if (values === undefined && runtime.authorizeRemote !== undefined) {
    const remoteUrls = propertySourceUrls(entry);
    for (const url of remoteUrls) {
      const authorized = await runtime.authorizeRemote(url, options);
      if (authorized !== undefined) {
        options = authorized;
        break;
      }
    }
    if (options !== localOptions) {
      values = await readPropertyConflictValues(runtime.svnPath, target.wcRoot, entry, options);
    }
  }
  if (values === undefined) {
    return undefined;
  }
  const normalized = normalizeConflictRecords([entry], {
    wcRoot: target.wcRoot,
    artifactExists: (relPath) => pathExistsSafely(join(target.wcRoot, ...relPath.split('/'))),
    propertyValuesByPath: { [record.path]: values },
    contentKindByPath: { [record.path]: record.contentKind },
  });
  return normalized[0];
}

function pathExistsSafely(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 属性冲突记录的可认证远端来源 URL：只返回 http/https/svn 协议两侧
 * 来源（file:// 走文件系统权限，不补凭据；svn+ssh 由 SSH 配置承载）。
 */
function propertySourceUrls(entry: InfoXmlEntry): string[] {
  const conflict = (entry.conflict ?? []).find((candidate) => candidate.type === 'property');
  if (!conflict) {
    return [];
  }
  const urls: string[] = [];
  for (const version of conflict.version ?? []) {
    if (version.side !== 'source-left' && version.side !== 'source-right') {
      continue;
    }
    if (version.kind === 'none' || version.revision === undefined || version.revision === null) {
      continue;
    }
    const revision = Number(version.revision);
    if (!Number.isFinite(revision) || !version['repos-url'] || version['path-in-repos'] === undefined) {
      continue;
    }
    const base = version['repos-url'].endsWith('/')
      ? version['repos-url'].slice(0, -1)
      : version['repos-url'];
    const rel = version['path-in-repos'].replace(/^\/+/, '');
    const url = urlWithPeg(rel === '' ? base : `${base}/${rel}`, revision);
    if (authScopeOfUrl(url) !== undefined) {
      urls.push(url);
    }
  }
  return urls;
}

/* ---------------------------------------------------------------------------
 * 默认内容分类实现（svn:mime-type + 前 8 KiB NUL）
 * ------------------------------------------------------------------------- */

/**
 * 工作副本内容分类器：`svn:mime-type`（本地属性）+ 文件前 8 KiB NUL。
 * 目录、missing/树冲突 victim（文件不存在）返回 unknown；MIME 读取失败
 * 不阻断 NUL 判据（core/conflict.classifyContentKind 同口径）。
 */
export function createWorkingCopyContentClassifier(
  svnPath: string,
  wcRoot: string,
  options: RunOptions = {},
): ConflictContentClassifier {
  return async (relPath) => {
    const fsPath = join(wcRoot, ...relPath.split('/'));
    let headBytes: Buffer | undefined;
    try {
      const stat = statSync(fsPath);
      if (!stat.isFile()) {
        return 'unknown';
      }
      headBytes = readHeadBytes(fsPath, CONFLICT_CONTENT_PROBE_BYTES);
    } catch {
      return 'unknown';
    }
    const mimeType = await readLocalMimeType(svnPath, wcRoot, relPath, options);
    return classifyWorkingCopyContent(mimeType, headBytes);
  };
}

/** 前 8 KiB 读取（不整文件读入，避免大文件内存放大）。 */
function readHeadBytes(fsPath: string, limit: number): Buffer {
  const fd = openSync(fsPath, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    const read = readSync(fd, buffer, 0, limit, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** 本地 `svn:mime-type` 属性（缺失/读取失败返回 undefined）。 */
async function readLocalMimeType(
  svnPath: string,
  wcRoot: string,
  relPath: string,
  options: RunOptions,
): Promise<string | undefined> {
  try {
    const result = await run(
      svnPath,
      ['propget', '-q', 'svn:mime-type', '--', escapePeg(relPath)],
      { cwd: wcRoot, ...options },
    );
    if (result.exitCode !== 0) {
      return undefined;
    }
    const value = result.stdout.replace(/\r?\n$/, '');
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

/**
 * MIME/NUL 分类（导出供测试与面板复用，判据复用 core/remoteBrowse 原语）：
 * MIME 非 text/* 即二进制；否则前 8 KiB 含 NUL 即二进制；读不到内容头时
 * 无法做 NUL 判据，保守返回 unknown（不猜文本）。
 */
export function classifyWorkingCopyContent(
  mimeType: string | undefined,
  headBytes: Buffer | undefined,
): ConflictContentKind {
  if (headBytes === undefined) {
    if (mimeType === undefined) {
      return 'unknown';
    }
    return /^text\//i.test(mimeType.trim()) ? 'unknown' : 'binary';
  }
  return classifyRemoteContentKind(mimeType, headBytes).kind;
}

/* ---------------------------------------------------------------------------
 * 范围匹配（缺失/移动树路径用最近存在祖先 realpath + 分段后缀）
 * ------------------------------------------------------------------------- */

/**
 * 把扫描记录裁剪到范围：先对范围路径向上找最近存在祖先做 realpath，
 * 再对每条记录按分段祖先判定（`/a/b` 不匹配 `/a/bc`；缺失/移动 victim
 * 用最近存在祖先 + 分段后缀回拼）。整副本范围直接返回全部记录。
 * 入口先对 wcRoot 做 realpath 归一：调用方可能传入符号链接形态（如
 * macOS 的 /tmp、/var），祖先 realpath 与原始 fsPath 混算会得到无效
 * 后缀并误判为空范围。
 */
export function filterRecordsToConflictScope(
  target: ConflictScopeTarget,
  records: readonly ConflictRecord[],
): ConflictRecord[] {
  if (target.scopeRelPath === '.') {
    return [...records];
  }
  const wcRoot = realpathOrSelf(target.wcRoot);
  const resolution = resolveRealPathWithSuffix(join(wcRoot, ...target.scopeRelPath.split('/')));
  if (!resolution) {
    return [];
  }
  const scopeRealPath = resolution.suffix.length > 0
    ? join(resolution.realPath, ...resolution.suffix)
    : resolution.realPath;
  return records.filter((record) => isRelPathWithinScope(scopeRealPath, wcRoot, record.path));
}

/** realpath 归一（路径不存在等失败时保留原值，交由范围判定按越界处理）。 */
function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/* ---------------------------------------------------------------------------
 * 动作矩阵
 * ------------------------------------------------------------------------- */

/** 单条冲突记录的可用动作（每项可用/禁用原因）。 */
export interface ConflictVariantView {
  value: SvnAcceptValue;
  label: string;
  group: 'whole' | 'block' | 'baseline';
  enabled: boolean;
  disabledReason?: string;
}

/** 批量适用性（阶段 7 计划使用；阶段 5 模型只给出布尔与原因）。 */
export type ConflictBatchUnsupportedReason =
  | 'mixed-path'
  | 'property'
  | 'tree'
  | 'auto-unsupported'
  | 'unknown-content';

export interface ConflictBatchApplicability {
  applicable: boolean;
  unsupportedReason?: ConflictBatchUnsupportedReason;
  /** 可执行项的整文件策略（文本/二进制都只开放 mine-full/theirs-full）。 */
  variants: readonly SvnAcceptValue[];
}

/** 动作矩阵：从 core/resolve 的动作集派生，面板不另写判断。 */
export interface ConflictActionMatrix {
  kinds: ConflictKind[];
  contentKind: ConflictContentKind;
  mixedPath: boolean;
  autoUnsupported: boolean;
  /** 树冲突需要先确认文件系统节点已处理（prepareTreeConflict）。 */
  treeConfirmation: boolean;
  workingRequiresConfirmation: boolean;
  propertySelection: boolean;
  variants: ConflictVariantView[];
  /** 无自动动作的原因（混合/类型未知/保留属性）。 */
  blocker?: ResolveRejectReason;
  blockerText?: string;
  /** 过期属性值导致的降级说明（详情展示用）。 */
  propertyValuesUnavailable: boolean;
  batch: ConflictBatchApplicability;
}

function variantGroup(value: SvnAcceptValue): ConflictVariantView['group'] {
  if (value === 'mine-conflict' || value === 'theirs-conflict') {
    return 'block';
  }
  if (value === 'base') {
    return 'baseline';
  }
  return 'whole';
}

/** 禁用原因：优先矩阵 blocker，其次变体级矩阵规则。 */
function variantDisabledReason(
  value: SvnAcceptValue,
  record: ConflictRecord,
  contentKind: ConflictContentKind,
  blocker: ResolveRejectReason | undefined,
  actions: ReturnType<typeof availableResolveActions>,
): ResolveRejectReason | undefined {
  if (blocker !== undefined) {
    return blocker;
  }
  if (record.kinds.includes('tree')) {
    return value === 'working' ? undefined : 'tree-invalid-strategy';
  }
  if (record.kinds.includes('property')) {
    if (!record.propertyConflicts || record.propertyConflicts.length === 0) {
      return 'property-values-unavailable';
    }
    return 'property-requires-selection';
  }
  if (contentKind === 'unknown') {
    return 'unknown-content';
  }
  if (contentKind === 'binary') {
    if (value === 'base') {
      return 'binary-base';
    }
    if (value === 'mine-conflict' || value === 'theirs-conflict') {
      return 'binary-block-variant';
    }
  }
  if (!actions.strategies.includes(value)) {
    return 'invalid-accept';
  }
  return undefined;
}

/**
 * 动作矩阵（纯函数）：
 * - 文本：六种 --accept 值可用，working（保留两者）需二次确认；
 * - 二进制：mine-full/theirs-full/working；base 与冲突块变体禁用；
 * - 属性：不开放整值 accept，需逐属性选择后 working；保留属性
 *   （svn:mergeinfo 等）计入冲突但 autoUnsupported、不进自动批量；
 * - 树：确认节点已处理后 working；其余值禁用；
 * - 混合路径：全部禁用直接应用，只保留检查器/终端交互处理；
 * - 类型未知：全部禁用，只留推迟/检查器/回扫。
 */
export function buildConflictActionMatrix(record: ConflictRecord): ConflictActionMatrix {
  const contentKind = record.contentKind;
  const actions = availableResolveActions(record, contentKind);
  const mixedPath = record.kinds.length > 1;
  const autoUnsupported = record.propertyConflicts !== undefined
    && record.propertyConflicts.length > 0
    && record.propertyConflicts.every((property) => property.autoUnsupported);
  const blocker = actions.blocker;
  const variants: ConflictVariantView[] = CONFLICT_VARIANT_ORDER.map((value) => {
    const reason = variantDisabledReason(value, record, contentKind, blocker, actions);
    const option: ConflictVariantView = {
      value,
      label: conflictText(VARIANT_TEXT_KEYS[value]),
      group: variantGroup(value),
      enabled: reason === undefined,
    };
    if (reason !== undefined) {
      option.disabledReason = resolveRejectText(reason);
    }
    return option;
  });
  const matrix: ConflictActionMatrix = {
    kinds: [...record.kinds],
    contentKind,
    mixedPath,
    autoUnsupported,
    treeConfirmation: actions.treeConfirmation,
    workingRequiresConfirmation: actions.workingRequiresConfirmation,
    propertySelection: actions.propertySelection,
    variants,
    propertyValuesUnavailable: record.kinds.includes('property')
      && (record.propertyConflicts === undefined || record.propertyConflicts.length === 0),
    batch: batchApplicabilityOf(record),
  };
  if (blocker !== undefined) {
    matrix.blocker = blocker;
    matrix.blockerText = resolveRejectText(blocker);
  }
  return matrix;
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

/** 批量不适用原因文案（阶段 7 计划与详情共用）。 */
export function batchUnsupportedText(reason: ConflictBatchUnsupportedReason): string {
  switch (reason) {
    case 'mixed-path':
      return conflictText('batchUnsupportedMixed');
    case 'property':
      return conflictText('batchUnsupportedProperty');
    case 'tree':
      return conflictText('batchUnsupportedTree');
    case 'auto-unsupported':
      return conflictText('batchUnsupportedAuto');
    case 'unknown-content':
      return conflictText('batchUnsupportedUnknown');
  }
}

/* ---------------------------------------------------------------------------
 * 详情
 * ------------------------------------------------------------------------- */

function kindLabel(kind: ConflictKind): string {
  switch (kind) {
    case 'text':
      return conflictText('kindText');
    case 'property':
      return conflictText('kindProperty');
    case 'tree':
      return conflictText('kindTree');
  }
}

/** 内容类型标签（二进制子类型区分）。 */
export function contentKindLabel(kind: ConflictContentKind): string {
  switch (kind) {
    case 'text':
      return conflictText('contentKindText');
    case 'binary':
      return conflictText('contentKindBinary');
    default:
      return conflictText('contentKindUnknown');
  }
}

function rowStatusLabel(status: ConflictListRow['status']): string {
  switch (status) {
    case 'resolved':
      return conflictText('rowStatusResolved');
    case 'postponed':
      return conflictText('rowStatusPostponed');
    default:
      return conflictText('rowStatusUnresolved');
  }
}

const PROPERTY_TEXT_MAX_CHARS = 400;

/**
 * 属性值展示文本：存在性、空值、UTF-8 文本（含控制字符/非法编码按
 * 二进制值显示）、超长截断。属性值不写日志，本函数只服务详情展示。
 */
export function describePropertyValue(value: PropertyValue): string {
  if (!value.exists) {
    return conflictText('propertyValueMissing');
  }
  const buffer = value.value ?? Buffer.alloc(0);
  if (buffer.length === 0) {
    return conflictText('propertyValueEmpty');
  }
  const text = decodePropertyText(buffer);
  if (text === undefined) {
    return format(conflictText('propertyValueBinary'), { bytes: String(buffer.length) });
  }
  if (text.length > PROPERTY_TEXT_MAX_CHARS) {
    return format(conflictText('propertyValueTruncated'), {
      value: text.slice(0, PROPERTY_TEXT_MAX_CHARS),
    });
  }
  return text;
}

/** UTF-8 严格解码；控制字符（除 \n \t \r）视为二进制值，避免终端注入与乱码。 */
function decodePropertyText(buffer: Buffer): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (code < 0x20 && char !== '\n' && char !== '\t' && char !== '\r') {
        return undefined;
      }
      if (code === 0x7f) {
        return undefined;
      }
    }
    return text;
  } catch {
    return undefined;
  }
}

function revisionText(value: number | undefined): string {
  return value === undefined ? conflictText('valueNone') : `r${value}`;
}

function conflictStatusText(row: ConflictListRow): string {
  return row.status === 'resolved' && row.resolved
    ? `${conflictText('rowStatusResolved')} · ${row.resolved.strategy}`
    : rowStatusLabel(row.status);
}

/** 时间展示（本地时间，秒级；模型不依赖 locale 文案）。 */
function timestampText(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function artifactRoleLabel(role: 'base' | 'mine' | 'incoming' | 'reject'): string {
  switch (role) {
    case 'base':
      return conflictText('artifactBase');
    case 'mine':
      return conflictText('artifactMine');
    case 'incoming':
      return conflictText('artifactIncoming');
    default:
      return conflictText('artifactReject');
  }
}

/** 六种变体的详情选项：常用整文件结果直接展示，variants/base 收进高级折叠。 */
function variantOptions(matrix: ConflictActionMatrix): DetailVariantOptionSpec[] {
  return matrix.variants.map((variant) => {
    const advanced = variant.value === 'base'
      || variant.value === 'mine-conflict'
      || variant.value === 'theirs-conflict';
    const option: DetailVariantOptionSpec = {
      value: variant.value,
      label: variant.enabled && variant.value === 'working' && matrix.workingRequiresConfirmation
        ? `${variant.label}${conflictText('detailVariantRequiresConfirm')}`
        : variant.label,
      advanced,
      disabled: !variant.enabled,
    };
    if (!variant.enabled && variant.disabledReason !== undefined) {
      option.disabledReason = variant.disabledReason;
    }
    return option;
  });
}

/** 属性三值选项的逐项选择动作（意图 choosePropertyValue，参数走 data-property/data-choice）。 */
function propertyChoiceAction(name: string, choice: 'local' | 'base' | 'incoming'): ActionSpec {
  return {
    id: 'choosePropertyValue',
    label: choice === 'local'
      ? conflictText('propertySelectLocal')
      : choice === 'base'
        ? conflictText('propertySelectBase')
        : conflictText('propertySelectIncoming'),
    payload: { property: name, choice },
  };
}

/** 属性冲突三值对照（多属性逐项；保留属性不提供选择动作）。 */
function propertyDetails(
  record: ConflictRecord,
  choices: Readonly<Record<string, 'local' | 'base' | 'incoming'>> = {},
): DetailPropertySpec[] {
  return (record.propertyConflicts ?? []).map((property) => {
    const value = (side: PropertyValue, choice: 'local' | 'base' | 'incoming'): DetailPropertyValueSpec => {
      const spec: DetailPropertyValueSpec = {
        text: describePropertyValue(side),
        exists: side.exists,
        action: propertyChoiceAction(property.name, choice),
      };
      if (side.exists) {
        // 原始字节数：检查器只输出存在性与字节数，属性值原文只留在面板详情。
        spec.bytes = side.value?.length ?? 0;
      }
      return spec;
    };
    const spec: DetailPropertySpec = {
      name: property.name,
      local: value(property.local, 'local'),
      base: value(property.base, 'base'),
      incoming: value(property.incoming, 'incoming'),
    };
    const selected = choices[property.name];
    if (selected !== undefined) {
      spec.selected = selected;
    }
    if (property.autoUnsupported) {
      spec.autoUnsupported = true;
      spec.autoUnsupportedNote = conflictText('autoUnsupported');
    }
    return spec;
  });
}

function treeSections(record: ConflictRecord, treePrepared: boolean): DetailSectionSpec[] {
  const tree = record.treeConflict;
  if (!tree) {
    return [];
  }
  const sourceText = (version: typeof tree.sourceLeft): string => {
    if (!version) {
      return conflictText('valueNone');
    }
    const path = version.pathInRepos ?? '';
    return `${path === '' ? '' : path} @${revisionText(version.revision)}`;
  };
  return [
    {
      kind: 'kv',
      heading: conflictText('detailTreeHeading'),
      entries: [
        { label: conflictText('detailTreeLabelOperation'), value: tree.operation || conflictText('valueNone') },
        { label: conflictText('detailTreeLabelReason'), value: tree.reason || conflictText('valueNone') },
        { label: conflictText('detailTreeLabelAction'), value: tree.action || conflictText('valueNone') },
        { label: conflictText('detailTreeLabelVictim'), value: tree.victim || record.path, mono: true },
        { label: conflictText('detailTreeLabelSourceLeft'), value: sourceText(tree.sourceLeft) },
        { label: conflictText('detailTreeLabelSourceRight'), value: sourceText(tree.sourceRight) },
      ],
    },
    {
      kind: 'text',
      paragraphs: [
        treePrepared ? conflictText('detailTreePreparedNote') : conflictText('detailTreeConfirmNote'),
      ],
    },
  ];
}

/** 辅助文件段：角色 + 工作副本相对路径 + revision（不按后缀扫描推断）。 */
function artifactDetailSection(record: ConflictRecord): DetailSectionSpec {
  const artifacts: DetailArtifactSpec[] = record.artifacts.map((artifact) => {
    const spec: DetailArtifactSpec = {
      roleLabel: artifactRoleLabel(artifact.role),
      path: artifact.path,
    };
    if (artifact.revision !== undefined) {
      spec.revision = String(artifact.revision);
    }
    return spec;
  });
  return {
    kind: 'artifacts',
    heading: conflictText('detailArtifactHeading'),
    artifacts,
    emptyText: conflictText('artifactEmpty'),
  };
}

/**
 * 冲突详情（纯函数，面板每帧重建）：
 * - 记录字段（路径/类型/内容类型/节点 BASE/冲突基线/传入 revision）；
 * - 属性冲突逐属性三值（本地/基线/传入，多属性逐项展示）；
 * - 六种文本变体按钮（禁用项带原因）；二进制子类型说明；
 * - 树冲突元数据与确认状态；混合路径的只读交互处理说明；
 * - SVN 辅助文件（角色 + 路径 + revision，不假定文件名形态）；
 * - 检查器/终端/原生差异/版本入口/复制路径/推迟动作。
 */
export function buildConflictDetail(input: {
  row: ConflictListRow;
  treePrepared?: boolean;
  /** 属性逐项选择（属性名 → 选择侧）；缺省未选择。 */
  propertyChoices?: Readonly<Record<string, 'local' | 'base' | 'incoming'>>;
  /** 当前整文件变体选择（applyConflictResolution 的待执行策略）。 */
  selectedVariant?: SvnAcceptValue;
}): DetailSpec {
  const { row } = input;
  const treePrepared = input.treePrepared === true;
  if (row.status === 'resolved' && row.resolved) {
    const resolved = row.resolved;
    return {
      id: row.key,
      title: row.path,
      subtitle: `${row.kinds.map(kindLabel).join(' / ')} · ${conflictText('rowStatusResolved')}`,
      sections: [
        {
          kind: 'kv',
          heading: conflictText('detailResolvedHeading'),
          entries: [
            { label: conflictText('detailResolvedStrategy'), value: resolved.strategy },
            { label: conflictText('detailResolvedOperation'), value: resolved.operationId, mono: true },
            { label: conflictText('detailResolvedAt'), value: timestampText(resolved.resolvedAt) },
          ],
        },
        { kind: 'text', paragraphs: [conflictText('detailResolvedNote')] },
        {
          kind: 'actions',
          actions: [
            { id: 'copyConflictPath', label: conflictText('detailCopyPath') },
            { id: 'inspectConflict', label: conflictText('detailInspector') },
          ],
        },
      ],
    };
  }
  const record = row.record;
  if (!record) {
    return {
      id: row.key,
      title: row.path,
      subtitle: rowStatusLabel(row.status),
      sections: [
        {
          kind: 'actions',
          actions: [
            { id: 'copyConflictPath', label: conflictText('detailCopyPath') },
            { id: 'postponeConflict', label: conflictText('detailPostpone') },
          ],
        },
      ],
    };
  }
  const matrix = buildConflictActionMatrix(record);
  const sections: DetailSectionSpec[] = [
    {
      kind: 'kv',
      heading: conflictText('detailMetadataHeading'),
      entries: [
        { label: conflictText('detailLabelPath'), value: record.path, mono: true },
        {
          label: conflictText('detailLabelKinds'),
          value: record.kinds.map(kindLabel).join(' / '),
        },
        {
          label: conflictText('detailLabelContentKind'),
          value: contentKindLabel(record.contentKind),
        },
        { label: conflictText('detailLabelNodeBase'), value: revisionText(record.nodeBaseRevision) },
        { label: conflictText('detailLabelBaseline'), value: revisionText(record.baselineRevision) },
        { label: conflictText('detailLabelIncoming'), value: revisionText(record.incomingRevision) },
        { label: conflictText('detailLabelStatus'), value: conflictStatusText(row) },
      ],
    },
  ];
  if (record.kinds.includes('property')) {
    sections.push({
      kind: 'properties',
      heading: format(conflictText('detailPropertyHeading'), {
        count: String(record.propertyConflicts?.length ?? 0),
      }),
      properties: propertyDetails(record, input.propertyChoices ?? {}),
      ...(matrix.propertyValuesUnavailable
        ? { note: conflictText('propertyUnavailableNotice') }
        : record.autoUnsupported === true
          ? { note: conflictText('detailAutoUnsupportedNote') }
          : {}),
    });
  }
  if (record.kinds.includes('tree')) {
    sections.push(...treeSections(record, treePrepared));
  }
  if (record.kinds.includes('text')) {
    const variants: Extract<DetailSectionSpec, { kind: 'variants' }> = {
      kind: 'variants',
      heading: conflictText('detailVariantsHeading'),
      options: variantOptions(matrix).map((option) => ({
        ...option,
        selected: input.selectedVariant === option.value,
      })),
      advancedLabel: conflictText('advancedVariants'),
    };
    if (record.contentKind === 'binary') {
      variants.note = conflictText('detailBinaryNote');
    }
    if (!matrix.mixedPath && matrix.blockerText !== undefined) {
      variants.warn = matrix.blockerText;
    } else if (matrix.mixedPath) {
      variants.warn = conflictText('detailMixedNote');
    }
    sections.push(variants);
  }
  if (matrix.mixedPath && !record.kinds.includes('text')) {
    // 含文本的混合路径已在 variants.warn 说明；无文本变体段时单独提示。
    sections.push({
      kind: 'text',
      heading: conflictText('detailMixedHeading'),
      paragraphs: [conflictText('detailMixedNote')],
    });
  }
  sections.push(artifactDetailSection(record));
  const actions: ActionSpec[] = [];
  if (record.kinds.includes('tree')) {
    actions.push({
      id: 'prepareTreeConflict',
      label: conflictText('detailPrepareTree'),
      disabled: treePrepared,
      ...(treePrepared ? { disabledReason: conflictText('detailTreePreparedNote') } : {}),
    });
    actions.push({
      id: 'applyConflictResolution',
      label: conflictText('detailApplyWorking'),
      disabled: !treePrepared,
      ...(treePrepared ? {} : { disabledReason: conflictText('detailTreeConfirmNote') }),
    });
  } else if (record.kinds.includes('text') && !matrix.mixedPath) {
    const hasVariant = input.selectedVariant !== undefined;
    actions.push({
      id: 'applyConflictResolution',
      label: conflictText('detailApplyWorking'),
      disabled: !hasVariant,
      ...(hasVariant ? {} : { disabledReason: conflictText('detailSelectVariantFirst') }),
    });
  }
  actions.push(
    { id: 'openConflictDiff', label: conflictText('detailOpenDiff') },
    { id: 'openConflictEditor', label: conflictText('detailOpenEditor') },
    {
      id: 'openConflictVersion',
      label: `${conflictText('detailOpenVersion')}：${conflictText('detailVersionLocal')}`,
      payload: { role: 'local' },
    },
    {
      id: 'openConflictVersion',
      label: `${conflictText('detailOpenVersion')}：${conflictText('detailVersionBase')}`,
      payload: { role: 'base' },
    },
    {
      id: 'openConflictVersion',
      label: `${conflictText('detailOpenVersion')}：${conflictText('detailVersionIncoming')}`,
      payload: { role: 'incoming' },
    },
    { id: 'openWorkCopyTerminal', label: '工作副本终端' },
    { id: 'inspectConflict', label: conflictText('detailInspector') },
    { id: 'copyConflictPath', label: conflictText('detailCopyPath') },
    { id: 'postponeConflict', label: conflictText('detailPostpone') },
  );
  sections.push({ kind: 'actions', actions });
  const batch = matrix.batch;
  sections.push({
    kind: 'text',
    heading: conflictText('batchHeading'),
    paragraphs: [
      batch.applicable
        ? format(conflictText('batchApplicable'), { strategies: batch.variants.join(' / ') })
        : batchUnsupportedText(batch.unsupportedReason ?? 'unknown-content'),
    ],
  });
  return {
    id: row.key,
    title: record.path,
    subtitle: `${record.kinds.map(kindLabel).join(' / ')} · ${contentKindLabel(record.contentKind)}`,
    sections,
  };
}

/* ---------------------------------------------------------------------------
 * 确认对话框（树冲突节点确认 / working 二次确认）
 * ------------------------------------------------------------------------- */

export interface ConflictConfirmDialogInput {
  row: ConflictListRow;
  /** tree：确认文件系统节点已处理；working：「采用当前工作内容」二次确认。 */
  kind: 'tree' | 'working';
  /**
   * 确认请求编号：宿主每次重新请求确认应更换（视图对同一 id 的用户取消
   * 保持关闭，直到该 id 从渲染中消失或宿主换新 id）。
   */
  requestId?: string;
}

/**
 * P7 确认对话框：面板不执行移动/重命名/删除节点，树确认只记录「用户
 * 已处理节点」；working 二次确认在用户完成外部处理后显式采用当前内容。
 * 确认动作意图固定为 prepareTreeConflict / applyConflictResolution。
 */
export function buildConflictConfirmDialog(
  input: ConflictConfirmDialogInput,
): ConfirmDialogSpec | undefined {
  const record = input.row.record;
  if (!record || input.row.status === 'resolved') {
    return undefined;
  }
  const requestId = input.requestId ?? record.id;
  if (input.kind === 'tree') {
    if (!record.kinds.includes('tree')) {
      return undefined;
    }
    return {
      id: `tree-confirm-${requestId}`,
      title: conflictText('treeConfirmTitle'),
      detail: `${conflictText('treeConfirmDetail')}\n${record.path}`,
      level: 'warn',
      confirm: { id: 'prepareTreeConflict', label: conflictText('treeConfirmButton') },
    };
  }
  return {
    id: `working-confirm-${requestId}`,
    title: conflictText('workingConfirmTitle'),
    detail: `${conflictText('workingConfirmDetail')}\n${record.path}`,
    confirm: { id: 'applyConflictResolution', label: conflictText('workingConfirmButton') },
  };
}

/* ---------------------------------------------------------------------------
 * 会话持久化形状
 * ------------------------------------------------------------------------- */

/** conflictSnapshot 持久化形状（m4SessionStore.conflictSnapshot）。 */
export interface ConflictSnapshotPayload {
  version: number;
  scope: ConflictScopeTarget;
  records: ConflictRecord[];
  summary: ConflictSummary;
  externals: string[];
  wcLocked: boolean;
  failures: ConflictScanFailure[];
  propertyValueFailures: string[];
  scannedAt: number;
}

/** browsable 持久化形状（列表筛选/选择，m4SessionStore.browsable）。 */
export interface ConflictBrowsableState {
  version: number;
  scope: ConflictScopeTarget;
  tab: ConflictTab;
  selectedKey?: string;
}

/** serialize 输出：四个字段分别写入 m4SessionStore 的对应槽位。 */
export interface ConflictModelSnapshot {
  browsable?: ConflictBrowsableState;
  conflictSnapshot?: ConflictSnapshotPayload;
  resolvedLedger: ResolvedLedgerEntry[];
  postponed: PostponedConflictEntry[];
}

/** restore 输入（直接从 readM4ScopeSession 的字段取）。 */
export interface ConflictModelRestoreInput {
  browsable?: unknown;
  conflictSnapshot?: unknown;
  resolvedLedger?: unknown;
  postponed?: unknown;
}

/* ---------------------------------------------------------------------------
 * 模型
 * ------------------------------------------------------------------------- */

export type ConflictPhase = 'idle' | 'scanning' | 'ready' | 'error';

export interface ConflictModelOptions {
  /** 时间源（测试注入）。 */
  now?: () => number;
}

/**
 * P7 会话模型（纯内存）：
 * - 扫描代次：beginScan 递增；applyScan/failScan 只接受当前代次；
 * - 列表 = 真实扫描记录 + resolvedLedger（真实新冲突优先）；
 * - tab 计数只统计真实扫描项（台账已解决项不参与未解决计数）；
 * - 推迟只改面板状态（按指纹保留到同一会话），不写 SVN；
 * - 树确认绑定「记录指纹 + 扫描代次」：任一变化需重新确认。
 */
export class ConflictModel {
  private scopeValue: ConflictScopeTarget | undefined;
  private phaseValue: ConflictPhase = 'idle';
  private epochValue = 0;
  private snapshotValue: ConflictSnapshotPayload | undefined;
  private errorValue: string | undefined;
  private progressValue: { completed: number; total: number } | undefined;
  private tabValue: ConflictTab = 'all';
  private selectedKeyValue: string | undefined;
  private ledgerValue: ResolvedLedgerEntry[] = [];
  private postponedValue: PostponedConflictEntry[] = [];
  private treePreparedValue: { key: string; fingerprint: string; epoch: number } | undefined;
  /** 整文件变体选择（按行 ID；应用后或扫描变化时清空）。 */
  private variantSelections = new Map<string, SvnAcceptValue>();
  /** 属性逐项选择（行 ID → 属性名 → 选择侧）。 */
  private propertySelections = new Map<string, Record<string, 'local' | 'base' | 'incoming'>>();
  /** 回扫未决/命令失败的 unknown 行（不得伪装成已解决）。 */
  private unknownRows = new Map<string, string | undefined>();
  /** 会话内已关闭的可关闭横幅（external 边界提示等一次性告知；重新扫描保持关闭）。 */
  private dismissedBanners = new Set<string>();
  private readonly now: () => number;

  constructor(options: ConflictModelOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /* ------------------------- 生命周期 ------------------------- */

  /** 设置当前作用域（打开面板/切换目标时调用；不触发扫描）。 */
  adoptScope(target: ConflictScopeTarget): void {
    if (this.scopeValue !== undefined) {
      const same = this.scopeValue.wcRoot === target.wcRoot
        && this.scopeValue.scopeRelPath === target.scopeRelPath;
      if (!same) {
        this.resetSessionState();
      }
    }
    this.scopeValue = { ...target };
  }

  scope(): ConflictScopeTarget | undefined {
    return this.scopeValue === undefined ? undefined : { ...this.scopeValue };
  }

  /** 开始一次扫描：返回新代次；旧代次回包不得写入。 */
  beginScan(target?: ConflictScopeTarget): number {
    if (target !== undefined) {
      this.adoptScope(target);
    }
    this.epochValue += 1;
    this.phaseValue = 'scanning';
    this.errorValue = undefined;
    this.progressValue = undefined;
    return this.epochValue;
  }

  isScanCurrent(epoch: number): boolean {
    return epoch === this.epochValue && this.phaseValue === 'scanning';
  }

  /** 扫描进度（旧代次忽略）。 */
  updateProgress(epoch: number, completed: number, total: number): void {
    if (epoch !== this.epochValue) {
      return;
    }
    this.progressValue = { completed, total };
  }

  /**
   * 应用扫描结果：代次不符或作用域不符时丢弃并返回 false（关闭面板/切换
   * 目标后的迟到回包不覆盖当前会话）。真实扫描记录与台账在此合并。
   */
  applyScan(epoch: number, outcome: ConflictScanOutcome): boolean {
    if (epoch !== this.epochValue) {
      return false;
    }
    if (this.scopeValue !== undefined
      && (outcome.scope.wcRoot !== this.scopeValue.wcRoot
        || outcome.scope.scopeRelPath !== this.scopeValue.scopeRelPath)) {
      return false;
    }
    this.snapshotValue = {
      version: CONFLICT_BROWSABLE_VERSION,
      scope: { ...outcome.scope },
      records: [...outcome.records],
      summary: { ...outcome.summary },
      externals: [...outcome.externals],
      wcLocked: outcome.wcLocked,
      failures: outcome.failures.map((failure) => ({ ...failure })),
      propertyValueFailures: [...outcome.propertyValueFailures],
      scannedAt: outcome.scannedAt,
    };
    this.phaseValue = 'ready';
    this.errorValue = undefined;
    this.progressValue = undefined;
    this.treePreparedValue = undefined;
    // 新扫描代次：变体/属性选择与 unknown 行状态以真实扫描为准重置。
    this.variantSelections.clear();
    this.propertySelections.clear();
    this.unknownRows.clear();
    this.pruneSelection();
    return true;
  }

  /** 扫描失败：保留旧快照，仅进入 error（不把未完成扫描误判为空列表）。 */
  failScan(epoch: number, error: unknown): boolean {
    if (epoch !== this.epochValue) {
      return false;
    }
    this.phaseValue = 'error';
    this.errorValue = errorText(error);
    this.progressValue = undefined;
    return true;
  }

  /** 取消扫描（用户动作）：使在途回包过期，不把取消结果当失败。 */
  cancelScan(epoch: number): boolean {
    if (epoch !== this.epochValue) {
      return false;
    }
    // 递增代次：取消后仍在途的 status/info 回包不得再写入面板。
    this.epochValue += 1;
    this.phaseValue = this.snapshotValue === undefined ? 'idle' : 'ready';
    this.progressValue = undefined;
    return true;
  }

  private resetSessionState(): void {
    this.snapshotValue = undefined;
    this.phaseValue = 'idle';
    this.errorValue = undefined;
    this.progressValue = undefined;
    this.tabValue = 'all';
    this.selectedKeyValue = undefined;
    this.ledgerValue = [];
    this.postponedValue = [];
    this.treePreparedValue = undefined;
    this.variantSelections.clear();
    this.propertySelections.clear();
    this.unknownRows.clear();
    this.dismissedBanners.clear();
  }

  /* ------------------------- 查询 ------------------------- */

  phase(): ConflictPhase {
    return this.phaseValue;
  }

  scanEpoch(): number {
    return this.epochValue;
  }

  isScanning(): boolean {
    return this.phaseValue === 'scanning';
  }

  errorMessage(): string | undefined {
    return this.errorValue;
  }

  scannedAt(): number | undefined {
    return this.snapshotValue?.scannedAt;
  }

  wcLocked(): boolean {
    return this.snapshotValue?.wcLocked ?? false;
  }

  externals(): readonly string[] {
    return this.snapshotValue?.externals ?? [];
  }

  failures(): readonly ConflictScanFailure[] {
    return this.snapshotValue?.failures ?? [];
  }

  propertyValueFailures(): readonly string[] {
    return this.snapshotValue?.propertyValueFailures ?? [];
  }

  records(): readonly ConflictRecord[] {
    return this.snapshotValue?.records ?? [];
  }

  /** 未解决摘要（真实扫描记录按 kinds 项计数；台账已解决项不计入）。 */
  summary(): ConflictSummary {
    return this.snapshotValue?.summary ?? summarizeConflicts([]);
  }

  tab(): ConflictTab {
    return this.tabValue;
  }

  setTab(tab: ConflictTab): boolean {
    if (!CONFLICT_TABS.includes(tab) || tab === this.tabValue) {
      return false;
    }
    this.tabValue = tab;
    return true;
  }

  /** 列表行：真实扫描 + 台账（真实新冲突优先，core 同口径）。 */
  rows(): ConflictListRow[] {
    return mergeResolvedLedger(this.snapshotValue?.records ?? [], this.ledgerValue, this.postponedValue)
      .sort((a, b) => a.path.localeCompare(b.path) || a.key.localeCompare(b.key));
  }

  /** 当前 tab 的可见行（resolved 行按 kinds 进入对应分类）。 */
  visibleRows(): ConflictListRow[] {
    const rows = this.rows();
    const tab = this.tabValue;
    if (tab === 'all') {
      return rows;
    }
    return rows.filter((row) => (row.kinds as readonly string[]).includes(tab));
  }

  rowByKey(key: string): ConflictListRow | undefined {
    return this.rows().find((row) => row.key === key);
  }

  select(key: string): boolean {
    const row = this.rowByKey(key);
    if (!row) {
      return false;
    }
    this.selectedKeyValue = key;
    return true;
  }

  clearSelection(): void {
    this.selectedKeyValue = undefined;
  }

  selectedKey(): string | undefined {
    return this.selectedKeyValue;
  }

  selectedRow(): ConflictListRow | undefined {
    return this.selectedKeyValue === undefined ? undefined : this.rowByKey(this.selectedKeyValue);
  }

  /** 选中行已不在列表（解决/新扫描移除）时清除选择。 */
  private pruneSelection(): void {
    if (this.selectedKeyValue === undefined) {
      return;
    }
    if (!this.rowByKey(this.selectedKeyValue)) {
      this.selectedKeyValue = undefined;
    }
  }

  /** tab 计数：all/text/property/tree（text 含二进制；按记录项计数）。 */
  tabCounts(): Record<ConflictTab, number> {
    const summary = this.summary();
    return { all: summary.total, text: summary.text, property: summary.property, tree: summary.tree };
  }

  /* ------------------------- 台账与推迟 ------------------------- */

  /** 回扫确认解决后写入台账（同一路径 + 类型只保留最新一条）。 */
  recordResolved(entry: ResolvedLedgerEntry): void {
    this.ledgerValue = this.ledgerValue.filter((existing) => !(
      existing.path === entry.path && existing.kinds.some((kind) => entry.kinds.includes(kind))
    ));
    this.ledgerValue.push({
      ...entry,
      kinds: [...entry.kinds],
      resolvedAt: entry.resolvedAt === 0 ? this.now() : entry.resolvedAt,
    });
    this.pruneSelection();
  }

  ledger(): readonly ResolvedLedgerEntry[] {
    return [...this.ledgerValue];
  }

  /**
   * 推迟：只改面板状态，不写 SVN；按冲突指纹保留到同一会话。对已解决
   * 行拒绝；重复推迟幂等。
   */
  postpone(key: string): 'postponed' | 'already' | 'not-found' | 'resolved' {
    const row = this.rowByKey(key);
    if (!row) {
      return 'not-found';
    }
    if (row.status === 'resolved') {
      return 'resolved';
    }
    if (row.status === 'postponed') {
      return 'already';
    }
    const record = row.record;
    if (!record) {
      return 'not-found';
    }
    this.postponedValue = this.postponedValue.filter((entry) => !(
      entry.fingerprint === record.id
      || (entry.path === record.path && entry.kinds.some((kind) => record.kinds.includes(kind)))
    ));
    this.postponedValue.push({ fingerprint: record.id, path: record.path, kinds: [...record.kinds] });
    return 'postponed';
  }

  /** 取消推迟（回到未解决）。 */
  unpostpone(key: string): boolean {
    const row = this.rowByKey(key);
    if (!row || row.status !== 'postponed') {
      return false;
    }
    const record = row.record;
    const before = this.postponedValue.length;
    this.postponedValue = this.postponedValue.filter((entry) => !(
      record !== undefined
        ? entry.fingerprint === record.id
          || (entry.path === record.path && entry.kinds.some((kind) => record.kinds.includes(kind)))
        : entry.fingerprint === row.key
    ));
    return this.postponedValue.length !== before;
  }

  postponed(): readonly PostponedConflictEntry[] {
    return [...this.postponedValue];
  }

  /* ------------------------- 树确认 ------------------------- */

  /**
   * 树冲突节点确认：绑定「记录指纹 + 扫描代次」。节点内容/扫描代次
   * 变化后必须重新确认（技术方案 §5.3「树冲突的最终确认使用当前工作
   * 副本的节点状态」）。
   */
  prepareTreeConflict(key: string): 'prepared' | 'already' | 'not-found' | 'not-tree' | 'resolved' {
    const row = this.rowByKey(key);
    if (!row) {
      return 'not-found';
    }
    if (row.status === 'resolved') {
      return 'resolved';
    }
    const record = row.record;
    if (!record || !record.kinds.includes('tree')) {
      return 'not-tree';
    }
    if (this.isTreePrepared(key)) {
      return 'already';
    }
    this.treePreparedValue = { key, fingerprint: record.id, epoch: this.epochValue };
    return 'prepared';
  }

  isTreePrepared(key: string): boolean {
    const prepared = this.treePreparedValue;
    if (!prepared || prepared.key !== key) {
      return false;
    }
    const record = this.rowByKey(key)?.record;
    return record !== undefined
      && prepared.fingerprint === record.id
      && prepared.epoch === this.epochValue;
  }

  /* ------------------------- 动作矩阵与详情 ------------------------- */

  /** 选中行/指定行的动作矩阵（resolved 行无自动动作）。 */
  actionMatrix(key: string): ConflictActionMatrix | undefined {
    const record = this.rowByKey(key)?.record;
    return record === undefined ? undefined : buildConflictActionMatrix(record);
  }

  /* ------------------------- 变体与属性选择 ------------------------- */

  /**
   * 选择整文件变体：只接受动作矩阵中可用（enabled）的六值之一；混合路径、
   * 保留属性等禁用变体不改变选择。working 仍需执行入口的二次确认。
   */
  chooseVariant(key: string, value: SvnAcceptValue): 'selected' | 'unchanged' | 'not-found' | 'disabled' {
    const row = this.rowByKey(key);
    if (!row || !row.record || row.status === 'resolved') {
      return 'not-found';
    }
    const matrix = buildConflictActionMatrix(row.record);
    const option = matrix.variants.find((variant) => variant.value === value);
    if (!option || !option.enabled) {
      return 'disabled';
    }
    if (this.variantSelections.get(key) === value) {
      return 'unchanged';
    }
    this.variantSelections.set(key, value);
    return 'selected';
  }

  selectedVariant(key: string): SvnAcceptValue | undefined {
    return this.variantSelections.get(key);
  }

  /** 属性逐项选择：只接受该记录实际冲突且非保留属性的一方；重复选择幂等。 */
  selectPropertyValue(
    key: string,
    name: string,
    choice: 'local' | 'base' | 'incoming',
  ): 'selected' | 'unchanged' | 'not-found' | 'not-property' | 'unsupported' {
    const row = this.rowByKey(key);
    if (!row || !row.record || row.status === 'resolved') {
      return 'not-found';
    }
    const property = row.record.propertyConflicts?.find((candidate) => candidate.name === name);
    if (!property) {
      return 'not-property';
    }
    if (property.autoUnsupported) {
      return 'unsupported';
    }
    const current = this.propertySelections.get(key) ?? {};
    if (current[name] === choice) {
      return 'unchanged';
    }
    this.propertySelections.set(key, { ...current, [name]: choice });
    return 'selected';
  }

  propertyChoices(key: string): Readonly<Record<string, 'local' | 'base' | 'incoming'>> {
    return { ...(this.propertySelections.get(key) ?? {}) };
  }

  /**
   * 属性选择是否覆盖该记录全部可自动处理的冲突属性（执行 working 前的
   * 应用层前置条件）。保留属性（svn:）不可选择也不计入：含保留属性的
   * 路径整体不可自动处理，由动作矩阵 blocker 另行阻止。
   */
  propertySelectionComplete(key: string): boolean {
    const record = this.rowByKey(key)?.record;
    const selectable = (record?.propertyConflicts ?? []).filter((property) => !property.autoUnsupported);
    if (selectable.length === 0) {
      return false;
    }
    const chosen = this.propertySelections.get(key) ?? {};
    return selectable.every((property) => chosen[property.name] !== undefined);
  }

  /* ------------------------- unknown 行状态 ------------------------- */

  /**
   * 标记回扫未决/命令失败的 unknown 行（不伪装成已解决）：命令失败或
   * 回扫矛盾时由执行器调用；下一次成功扫描以真实状态覆盖并清空。
   */
  markUnknown(key: string, reason?: string): boolean {
    if (!this.rowByKey(key)) {
      return false;
    }
    this.unknownRows.set(key, reason);
    return true;
  }

  clearUnknown(key: string): boolean {
    return this.unknownRows.delete(key);
  }

  unknownReason(key: string): string | undefined {
    return this.unknownRows.get(key);
  }

  isUnknown(key: string): boolean {
    return this.unknownRows.has(key);
  }

  detail(key?: string): DetailSpec | undefined {
    const row = key === undefined ? this.selectedRow() : this.rowByKey(key);
    if (!row) {
      return undefined;
    }
    return buildConflictDetail({
      row,
      treePrepared: this.isTreePrepared(row.key),
      propertyChoices: this.propertyChoices(row.key),
      ...(this.variantSelections.has(row.key)
        ? { selectedVariant: this.variantSelections.get(row.key) }
        : {}),
    });
  }

  /** 树确认/working 二次确认对话框（控制器决定展示时机与请求编号）。 */
  confirmDialog(
    key: string,
    kind: 'tree' | 'working',
    requestId?: string,
  ): ConfirmDialogSpec | undefined {
    const row = this.rowByKey(key);
    if (!row) {
      return undefined;
    }
    return buildConflictConfirmDialog({ row, kind, ...(requestId !== undefined ? { requestId } : {}) });
  }

  /* ------------------------- 持久化 ------------------------- */

  /** 持久化快照（m4SessionStore 四槽位；宿主重启后自然丢弃）。 */
  serialize(): ConflictModelSnapshot | undefined {
    const scope = this.scopeValue;
    if (scope === undefined) {
      return undefined;
    }
    const browsable: ConflictBrowsableState = {
      version: CONFLICT_BROWSABLE_VERSION,
      scope: { ...scope },
      tab: this.tabValue,
      ...(this.selectedKeyValue !== undefined ? { selectedKey: this.selectedKeyValue } : {}),
    };
    return {
      browsable,
      ...(this.snapshotValue !== undefined
        ? {
            conflictSnapshot: {
              ...this.snapshotValue,
              scope: { ...this.snapshotValue.scope },
              records: [...this.snapshotValue.records],
              summary: { ...this.snapshotValue.summary },
              externals: [...this.snapshotValue.externals],
              failures: this.snapshotValue.failures.map((failure) => ({ ...failure })),
              propertyValueFailures: [...this.snapshotValue.propertyValueFailures],
            },
          }
        : {}),
      resolvedLedger: this.ledgerValue.map((entry) => ({ ...entry, kinds: [...entry.kinds] })),
      postponed: this.postponedValue.map((entry) => ({ ...entry, kinds: [...entry.kinds] })),
    };
  }

  /**
   * 关闭重开恢复：只接受同一作用域、同版本形状的数据；冲突快照缺失时
   * 回到 fresh（真实 SVN 是唯一真相，不从台账反推未解决项）。切换工作
   * 副本后旧作用域的台账/推迟一律丢弃（技术方案 §5.5：随作用域项淘汰）。
   */
  restore(input: ConflictModelRestoreInput | undefined): boolean {
    if (!input) {
      return false;
    }
    const scope = this.scopeValue;
    if (scope === undefined) {
      return false;
    }
    const browsable = isConflictBrowsable(input.browsable) ? input.browsable : undefined;
    const snapshot = isConflictSnapshot(input.conflictSnapshot) ? input.conflictSnapshot : undefined;
    const dataScope = browsable?.scope ?? snapshot?.scope;
    if (dataScope !== undefined && !sameScope(dataScope, scope)) {
      return false;
    }
    let restored = false;
    if (browsable) {
      this.tabValue = browsable.tab;
      this.selectedKeyValue = browsable.selectedKey;
      restored = true;
    }
    if (snapshot) {
      this.snapshotValue = {
        ...snapshot,
        records: [...snapshot.records],
        summary: { ...snapshot.summary },
        externals: [...snapshot.externals],
        failures: snapshot.failures.map((failure) => ({ ...failure })),
        propertyValueFailures: [...snapshot.propertyValueFailures],
      };
      if (this.phaseValue === 'idle') {
        this.phaseValue = 'ready';
      }
      restored = true;
    }
    if (Array.isArray(input.resolvedLedger)) {
      this.ledgerValue = input.resolvedLedger.filter(isLedgerEntry).map((entry) => ({
        ...entry,
        kinds: [...entry.kinds],
      }));
      restored = true;
    }
    if (Array.isArray(input.postponed)) {
      this.postponedValue = input.postponed.filter(isPostponedEntry).map((entry) => ({
        ...entry,
        kinds: [...entry.kinds],
      }));
      restored = true;
    }
    this.pruneSelection();
    return restored;
  }

  /* ------------------------- 渲染 ------------------------- */

  /** 渲染占用态（由面板控制器按 gates 计算后传入；模型只合并，不重算放行表）。 */
  buildPanelState(sessionId: string, occupancy: {
    busy?: boolean;
    writeLocked?: boolean;
    gate?: { busy: string[]; writeLocked: string[] };
  } = {}): PanelState {
    const busy = occupancy.busy ?? this.isScanning();
    const state: PanelState = {
      sessionId,
      title: conflictText('panelTitle'),
      targetLabel: this.targetLabelText(),
      revision: 0,
      formRevision: 0,
      busy,
      ...(occupancy.writeLocked !== undefined ? { writeLocked: occupancy.writeLocked } : {}),
      banners: this.buildBanners(),
      headerBadges: this.buildHeaderBadges(),
      hint: this.buildHint(),
      tabs: this.buildTabs(),
      layout: {
        layout: 'balanced',
        masterLabel: conflictText('masterLabel'),
        detailLabel: conflictText('detailLabel'),
        masterScrollKey: 'conflict-table',
        detailScrollKey: 'conflict-detail',
      },
      footer: this.buildFooter(),
    };
    if (occupancy.gate !== undefined) {
      state.gate = occupancy.gate;
    }
    state.conflictList = this.buildConflictList();
    const detail = this.detail();
    if (detail !== undefined) {
      state.detail = detail;
    } else {
      state.detail = {
        title: conflictText('detailEmptyTitle'),
        sections: [{ kind: 'text', paragraphs: [conflictText('detailEmptyDetail')] }],
      };
    }
    const progress = this.buildProgress();
    if (progress !== undefined) {
      state.progress = progress;
    }
    return state;
  }

  private targetLabelText(): string {
    const scope = this.scopeValue;
    if (!scope) {
      return conflictText('panelTitle');
    }
    const range = scope.scopeRelPath === '.'
      ? conflictText('scopeWhole')
      : scope.scopeRelPath;
    return `${scope.wcRoot} · ${conflictText('scopeLabel')}：${range}`;
  }

  private buildHint(): string {
    const scope = this.scopeValue;
    if (!scope) {
      return '';
    }
    return `${scope.wcRoot} · ${conflictText('scopeLabel')}：`
      + `${scope.scopeRelPath === '.' ? conflictText('scopeWhole') : scope.scopeRelPath}`;
  }

  private buildHeaderBadges(): NonNullable<PanelState['headerBadges']> {
    const badges: NonNullable<PanelState['headerBadges']> = [];
    const summary = this.summary();
    badges.push({ text: summary.total === 0 ? conflictText('summaryNone') : conflictText('summaryLabel', {
      text: String(summary.text),
      property: String(summary.property),
      tree: String(summary.tree),
    }) });
    if (this.wcLocked()) {
      badges.push({ text: conflictText('wcLockedTitle'), warn: true });
    }
    return badges;
  }

  private buildBanners(): BannerSpec[] {
    const banners: BannerSpec[] = [];
    if (this.phaseValue === 'error' && this.errorValue !== undefined) {
      banners.push({
        id: 'conflictScanFailed',
        level: 'error',
        title: conflictText('scanFailedTitle'),
        detail: format(conflictText('scanFailedDetail'), { message: this.errorValue }),
        dismissable: false,
        actions: [
          { id: 'rescanConflicts', label: conflictText('rescanAction'), payload: { scope: 'task' } },
          { id: 'scanWholeWorkCopy', label: conflictText('rescanWholeAction') },
        ],
      });
    }
    if (this.wcLocked()) {
      banners.push({
        id: 'conflictWcLocked',
        level: 'warn',
        title: conflictText('wcLockedTitle'),
        detail: conflictText('wcLockedDetail'),
        dismissable: false,
      });
    }
    const failures = this.failures();
    if (failures.length > 0) {
      banners.push({
        id: 'conflictDetailFailures',
        level: 'warn',
        title: format(conflictText('failuresTitle'), { count: String(failures.length) }),
        detail: format(conflictText('failuresDetail'), {
          paths: failures.slice(0, 5).map((failure) => failure.path).join('、'),
        }),
        dismissable: false,
      });
    }
    if (this.externals().length > 0 && !this.dismissedBanners.has('conflictExternalBoundary')) {
      banners.push({
        id: 'conflictExternalBoundary',
        level: 'info',
        title: conflictText('externalBoundaryNotice'),
        dismissable: true,
      });
    }
    return banners;
  }

  /**
   * 关闭可关闭的横幅（只改会话内存；重新扫描保持关闭，切换目标后恢复展示）。
   * 返回 false 表示横幅不存在或不可关闭，调用方不得因此改任何状态。
   */
  dismissBanner(id: string): boolean {
    const banner = this.buildBanners().find((candidate) => candidate.id === id);
    if (banner === undefined || !banner.dismissable) {
      return false;
    }
    this.dismissedBanners.add(id);
    return true;
  }

  private buildTabs(): TabsSpec {
    const counts = this.tabCounts();
    const label = (key: ConflictTextKey): string => conflictText(key);
    return {
      id: CONFLICT_TABS_ID,
      ariaLabel: conflictText('detailLabelKinds'),
      tabs: [
        { id: 'all', label: label('tabAll'), count: counts.all },
        { id: 'text', label: label('tabText'), count: counts.text },
        { id: 'property', label: label('tabProperty'), count: counts.property },
        { id: 'tree', label: label('tabTree'), count: counts.tree },
      ],
      current: this.tabValue,
    };
  }

  private buildConflictList(): ConflictListSpec {
    const rows = this.visibleRows();
    const listRows: ConflictRowSpec[] = rows.map((row) => this.conflictRow(row));
    return {
      id: CONFLICT_TABLE_ID,
      ariaLabel: conflictText('conflictListAriaLabel'),
      kindLabels: {
        text: conflictText('kindText'),
        property: conflictText('kindProperty'),
        tree: conflictText('kindTree'),
      },
      rows: listRows,
      selectIntent: 'selectConflict',
      empty: {
        title: this.tabValue === 'all' ? conflictText('emptyTitle') : conflictText('filterEmptyTitle'),
        detail: this.tabValue === 'all' ? conflictText('emptyDetail') : conflictText('filterEmptyDetail'),
        action: { id: 'rescanConflicts', label: conflictText('rescanAction'), payload: { scope: 'task' } },
      },
    };
  }

  /** 单行展示：类型/内容子类型/可自动标记/状态徽标全部由宿主文案驱动。 */
  private conflictRow(row: ConflictListRow): ConflictRowSpec {
    const unknown = this.unknownRows.has(row.key);
    const spec: ConflictRowSpec = {
      id: row.key,
      path: row.path,
      kinds: [...row.kinds],
      status: unknown ? 'unknown' : row.status,
      selected: row.key === this.selectedKeyValue,
    };
    if (unknown) {
      spec.statusLabel = conflictText('unknownRowStatus');
    }
    if (row.status !== 'resolved' && row.record !== undefined) {
      spec.contentKind = row.record.kinds.includes('text') ? row.record.contentKind : undefined;
      const batch = batchApplicabilityOf(row.record);
      spec.auto = batch.applicable
        ? { kind: 'applicable', label: conflictText('autoApplicable') }
        : {
            kind: 'unsupported',
            label: conflictText('autoUnsupported'),
            reason: batchUnsupportedText(batch.unsupportedReason ?? 'unknown-content'),
          };
      spec.actions = [
        {
          // 行 ID 由视图 renderConflictRow 自动绑定（data-row-id），payload 不重复携带。
          id: 'copyConflictPath',
          label: conflictText('detailCopyPath'),
        },
      ];
    }
    return spec;
  }

  private buildFooter(): PanelState['footer'] {
    const summary = this.summary();
    const parts: string[] = [];
    if (summary.text > 0) {
      parts.push(format(conflictText('summaryText'), { count: String(summary.text) }));
    }
    if (summary.property > 0) {
      parts.push(format(conflictText('summaryProperty'), { count: String(summary.property) }));
    }
    if (summary.tree > 0) {
      parts.push(format(conflictText('summaryTree'), { count: String(summary.tree) }));
    }
    const secondary: ActionSpec[] = [
      {
        id: 'rescanConflicts',
        label: conflictText('rescanAction'),
        payload: { scope: 'task' },
      },
      { id: 'scanWholeWorkCopy', label: conflictText('rescanWholeAction') },
    ];
    return {
      summary: parts.length === 0 ? conflictText('summaryNone') : parts.join(' · '),
      secondary,
    };
  }

  private buildProgress(): ProgressState | undefined {
    if (!this.isScanning()) {
      return undefined;
    }
    const progress = this.progressValue;
    const state: ProgressState = {
      title: conflictText('progressScanning'),
      ...(progress !== undefined
        ? {
            detail: format(conflictText('progressScanningDetail'), {
              completed: String(progress.completed),
              total: String(progress.total),
            }),
            ...(progress.total > 0 ? { ratio: progress.completed / progress.total } : {}),
          }
        : {}),
      actions: [
        { id: 'closePanel', label: '关闭' },
        { id: 'viewTaskLog', label: '查看日志' },
      ],
    };
    return state;
  }
}

/* ---------------------------------------------------------------------------
 * 形状校验
 * ------------------------------------------------------------------------- */

function sameScope(a: ConflictScopeTarget, b: ConflictScopeTarget): boolean {
  return a.wcRoot === b.wcRoot && a.scopeRelPath === b.scopeRelPath;
}

function isConflictBrowsable(value: unknown): value is ConflictBrowsableState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<ConflictBrowsableState>;
  return record.version === CONFLICT_BROWSABLE_VERSION
    && isScopeTarget(record.scope)
    && typeof record.tab === 'string'
    && (CONFLICT_TABS as readonly string[]).includes(record.tab);
}

function isScopeTarget(value: unknown): value is ConflictScopeTarget {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<ConflictScopeTarget>;
  return typeof record.wcRoot === 'string' && typeof record.scopeRelPath === 'string';
}

function isConflictSnapshot(value: unknown): value is ConflictSnapshotPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<ConflictSnapshotPayload>;
  return record.version === CONFLICT_BROWSABLE_VERSION
    && isScopeTarget(record.scope)
    && Array.isArray(record.records)
    && typeof record.summary === 'object'
    && record.summary !== null
    && Array.isArray(record.externals)
    && Array.isArray(record.failures)
    && Array.isArray(record.propertyValueFailures)
    && typeof record.scannedAt === 'number';
}

function isLedgerEntry(value: unknown): value is ResolvedLedgerEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<ResolvedLedgerEntry>;
  return typeof record.fingerprint === 'string'
    && typeof record.path === 'string'
    && Array.isArray(record.kinds)
    && typeof record.strategy === 'string'
    && typeof record.operationId === 'string'
    && typeof record.resolvedAt === 'number';
}

function isPostponedEntry(value: unknown): value is PostponedConflictEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<PostponedConflictEntry>;
  return typeof record.fingerprint === 'string'
    && typeof record.path === 'string'
    && Array.isArray(record.kinds);
}

function errorText(error: unknown): string {
  return error instanceof SvnError
    ? error.message
    : error instanceof Error
      ? error.message
      : String(error);
}
