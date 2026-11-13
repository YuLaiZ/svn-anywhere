/**
 * 面板宿主与视图之间的消息协议（传输封套）。纯类型与运行时校验，不依赖 vscode。
 *
 * 设计约束（技术方案 §2.1）：
 * - 协议版本、界面更新序号 revision、表单输入序号 formRevision 三者分开；
 * - 意图必须携带 sessionId / requestId，宿主据此校验会话代次并拒绝重复写请求；
 * - 意图里只允许出现条目 ID 等稳定标识，不允许出现文件路径——
 *   路径一律由宿主从当前状态映射取得，视图不能传任意路径执行；
 * - TypeScript 类型不替代消息校验：parseViewMessage 对每条入站消息做
 *   结构、类型与动作白名单的运行时检查，非法消息被拒绝并给出原因。
 * - M4 起新增 P5/P6/P7 意图（技术方案 §6 冻结动作对账表），意图仍只携带
 *   稳定 nodeId/行/ revision ID 或枚举值，不接收宿主路径；枚举参数在解析
 *   层按白名单拒绝（例如 refreshHistoryUpper.mode 只允许 head/base-fallback）。
 */
import { format, strings } from '../i18n';

export const PROTOCOL_VERSION = 1;

/* --------------------------------------------------------------------------------
 * M4 意图枚举取值（技术方案 §6：需要参数时只传稳定 ID 或枚举值）。
 * 导出供宿主控制器、放行表与测试共用，不在各面板重复定义。
 * -------------------------------------------------------------------------------- */

/** refreshHistoryUpper.mode 的合法值：协议层只接受这两种（其余在解析层拒绝）。 */
export const REFRESH_HISTORY_UPPER_MODES = ['head', 'base-fallback'] as const;
export type RefreshHistoryUpperMode = (typeof REFRESH_HISTORY_UPPER_MODES)[number];

/** P6 复制内容的类别：提交说明、revision、变更路径、节点 URL、当前目标路径。 */
export const HISTORY_COPY_KINDS = ['revision', 'message', 'changedPath', 'nodeUrl', 'targetPath'] as const;
export type HistoryCopyKind = (typeof HISTORY_COPY_KINDS)[number];

/** P7 冲突列表顶级 tab：文件、属性、树三类 + 全部。 */
export const CONFLICT_TABS = ['all', 'text', 'property', 'tree'] as const;
export type ConflictTab = (typeof CONFLICT_TABS)[number];

/** P7 svn resolve --accept 变体（postpone 是面板动作，不是 accept 值）。 */
export const CONFLICT_VARIANTS = [
  'mine-full',
  'theirs-full',
  'working',
  'base',
  'mine-conflict',
  'theirs-conflict',
] as const;
export type ConflictVariant = (typeof CONFLICT_VARIANTS)[number];

/** P7 扫描范围：本次更新任务范围 / 整个工作副本。 */
export const CONFLICT_RESCAN_SCOPES = ['task', 'whole'] as const;
export type ConflictRescanScope = (typeof CONFLICT_RESCAN_SCOPES)[number];

/** P7 打开冲突版本的角色：本地工作内容 / 冲突基线 / 传入内容。 */
export const CONFLICT_VERSION_ROLES = ['local', 'base', 'incoming'] as const;
export type ConflictVersionRole = (typeof CONFLICT_VERSION_ROLES)[number];

/**
 * 视图可发起的意图（已知动作的联合类型）。阶段 1 起覆盖 P1 提交面板，
 * 阶段 2 起覆盖 P2 忽略规则编辑器；后续阶段扩展 P3 检出/导入与 P4 磁盘
 * 治理的动作全集——类型与白名单先行登记（处理器由各面板落地时实现），
 * 意图里仍只允许条目 ID / 序号等稳定标识，路径一律由宿主映射。
 * M4 追加 P5 仓库浏览器、P6 历史与比较、P7 冲突处理动作。
 */
export type Intent =
  | { kind: 'refresh' }
  | { kind: 'openDiff'; itemId: string }
  | { kind: 'openFile'; itemId: string }
  | { kind: 'dismissBanner'; bannerId: string }
  | { kind: 'bannerAction'; bannerId: string; actionId: string }
  | { kind: 'setFilter'; filterId: string; value: string }
  | { kind: 'clearFilters' }
  | { kind: 'toggleRow'; rowId: string; selected: boolean }
  | { kind: 'syncInput'; fieldId: string; value: string; inputRevision: number }
  | { kind: 'toggleGroup'; groupId: string; selected: boolean }
  | { kind: 'toggleTree'; nodeId: string; selected: boolean }
  | { kind: 'setView'; view: 'tree' | 'list' }
  | { kind: 'selectVisible' }
  | { kind: 'clearSelection' }
  | { kind: 'selectChangelist' }
  | { kind: 'applyPrefix'; index: number }
  | { kind: 'managePrefixes' }
  | { kind: 'applyHistory'; index: number }
  | { kind: 'showHistory' }
  | { kind: 'rowMore'; itemId: string }
  | { kind: 'submit' }
  | { kind: 'closePanel' }
  | { kind: 'resolveUnknown' }
  | { kind: 'addRule' }
  | { kind: 'removeRule'; index: number }
  | { kind: 'fillOriginName' }
  | { kind: 'saveIgnore' }
  | { kind: 'submitIgnore' }
  /* ---------------- P3 检出/导入：表单 ---------------- */
  | { kind: 'pickParentDir' }
  | { kind: 'pickDirectDir' }
  | { kind: 'pickSourceDir' }
  | { kind: 'useUrlName' }
  | { kind: 'useDirName' }
  | { kind: 'selectHistoryUrl'; index: number }
  | { kind: 'clearUrlHistory' }
  | { kind: 'checkoutNext' }
  | { kind: 'importNext' }
  | { kind: 'checkoutBack' }
  /* ---------------- P3 检出/导入：执行与结果 ---------------- */
  | { kind: 'startCheckout' }
  | { kind: 'startImport' }
  | { kind: 'cancelTask' }
  | { kind: 'viewTaskLog' }
  | { kind: 'verifyCheckout' }
  | { kind: 'resumeCheckout' }
  | { kind: 'abandonResidue' }
  | { kind: 'refreshImportPreview' }
  | { kind: 'verifyImport' }
  | { kind: 'retryImport' }
  | { kind: 'switchP3Mode' }
  | { kind: 'acknowledgeMerged' }
  | { kind: 'abandonUnknownImport' }
  | { kind: 'openCurrentWindow' }
  | { kind: 'openNewWindow' }
  | { kind: 'addToWorkspace' }
  | { kind: 'revealResultDir' }
  | { kind: 'revealSourceDir' }
  | { kind: 'handoffToCheckout' }
  | { kind: 'newTask' }
  /* ---------------- P4 磁盘治理 ---------------- */
  | { kind: 'startScan' }
  | { kind: 'cancelScan' }
  | { kind: 'rescan' }
  | { kind: 'confirmVacuum' }
  | { kind: 'revealFileInOS'; rowId: string }
  | { kind: 'showScopeHelp' }
  /* ---------------- M4：P5 仓库浏览器（仅稳定 nodeId） ---------------- */
  | { kind: 'toggleBrowserNode'; nodeId: string }
  | { kind: 'selectBrowserNode'; nodeId: string }
  | { kind: 'retryBrowserNode'; nodeId: string }
  | { kind: 'refreshBrowserNode'; nodeId: string }
  | { kind: 'loadMoreBrowserNode'; nodeId: string }
  | { kind: 'copyBrowserNodeUrl'; nodeId: string }
  | { kind: 'openRemoteNode'; nodeId: string }
  | { kind: 'openHistoryFromBrowser'; nodeId: string }
  /* ---------------- M4：P6 历史与比较 ---------------- */
  | { kind: 'selectHistoryRevision'; id: string }
  | { kind: 'toggleHistoryRevision'; id: string }
  | { kind: 'loadMoreHistory' }
  | { kind: 'setHistoryFilter'; id: string; value: string }
  | { kind: 'clearHistoryFilters' }
  | { kind: 'resetHistorySession' }
  | { kind: 'refreshHistoryUpper'; mode: RefreshHistoryUpperMode }
  | { kind: 'compareHistoryRevisions' }
  | { kind: 'selectCompareCandidate'; id: string }
  | { kind: 'openHistoryDiff' }
  | { kind: 'comparePreviousVisible' }
  | { kind: 'compareBase' }
  | { kind: 'viewHistoryRevision' }
  | { kind: 'exportHistoryVersion' }
  | { kind: 'copyHistoryText'; copyKind: HistoryCopyKind; id: string }
  | { kind: 'blameHistoryRevision' }
  | { kind: 'updateToHistoryRevision' }
  | { kind: 'checkoutHistoryDirectory' }
  /* ---------------- M4：P7 冲突处理 ---------------- */
  | { kind: 'selectConflict'; id: string }
  | { kind: 'setConflictTab'; tab: ConflictTab }
  | { kind: 'chooseConflictVariant'; value: ConflictVariant }
  | { kind: 'applyConflictResolution' }
  | { kind: 'postponeConflict' }
  | { kind: 'prepareTreeConflict' }
  | { kind: 'rescanConflicts'; scope: ConflictRescanScope }
  | { kind: 'planConflictBatch' }
  | { kind: 'startConflictBatch' }
  | { kind: 'showConflictBatchResults' }
  | { kind: 'scanWholeWorkCopy' }
  | { kind: 'inspectConflict' }
  | { kind: 'openWorkCopyTerminal' }
  | { kind: 'openConflictDiff' }
  | { kind: 'openConflictEditor' }
  | { kind: 'openConflictVersion'; role: ConflictVersionRole }
  | { kind: 'copyConflictPath'; id: string }
  | { kind: 'authenticateConflictSource' }
  /* ---------------- 表格配套（通用） ---------------- */
  | { kind: 'setSort'; key: string; direction: 'asc' | 'desc' }
  | { kind: 'setPage'; page: number };

/** 宿主 → 视图：整段渲染（宿主已本地化并转义的 HTML）。 */
export interface RenderMessage {
  type: 'render';
  protocolVersion: number;
  sessionId: string;
  revision: number;
  formRevision: number;
  /** 视图代次：ready 握手递增（webview 重建即新代）；视图据此重置输入确认空间。 */
  viewEpoch: number;
  html: string;
}

/** 宿主 → 视图：瞬时提示（不参与整段渲染，视图侧短暂展示后自行移除）。 */
export interface ToastMessage {
  type: 'toast';
  protocolVersion: number;
  sessionId: string;
  level: 'info' | 'error';
  message: string;
}

/**
 * 宿主 → 视图：P5 懒加载树增量追加（每批 ≤40 个节点）。只携带新增节点
 * 行的已渲染片段，视图按 data-append-key 追加到对应树容器，不重建整棵
 * 树；revision 与 render 共用同一单调序列，旧帧/旧会话由视图丢弃。
 */
export interface AppendMessage {
  type: 'append';
  protocolVersion: number;
  sessionId: string;
  revision: number;
  /**
   * 目标节点的子行容器定位键：`${treeId}:${nodeId}`（如 `browse:b1`），
   * 对应视图 `.tree-node-children` 上的 data-append-key；树顶层容器仍用
   * LazyTreeSpec.id，不承载加载更多追加。
   */
  target: string;
  /** 宿主已本地化并转义的节点行 HTML 片段。 */
  html: string;
}

export type HostToViewMessage = RenderMessage | ToastMessage | AppendMessage;

/** 视图 → 宿主：加载完成握手，显式交换协议版本。 */
export interface ReadyMessage {
  type: 'ready';
  protocolVersion: number;
}

/** 视图 → 宿主：一次用户意图。 */
export interface IntentMessage {
  type: 'intent';
  protocolVersion: number;
  sessionId: string;
  requestId: string;
  intent: Intent;
}

export type ViewToHostMessage = ReadyMessage | IntentMessage;

/**
 * M4 冻结动作对账表（技术方案 §6）登记的 P5/P6/P7 全部意图 kind。
 * 独立导出供运行时白名单、放行表与单测交叉校验；新增动作必须同时进
 * 这里、Intent 联合与 parseIntent 分支，避免只登记一处。
 */
export const M4_INTENT_KINDS = [
  // P5 仓库浏览器
  'toggleBrowserNode',
  'selectBrowserNode',
  'retryBrowserNode',
  'refreshBrowserNode',
  'loadMoreBrowserNode',
  'copyBrowserNodeUrl',
  'openRemoteNode',
  'openHistoryFromBrowser',
  // P6 历史与比较
  'selectHistoryRevision',
  'toggleHistoryRevision',
  'loadMoreHistory',
  'setHistoryFilter',
  'clearHistoryFilters',
  'resetHistorySession',
  'refreshHistoryUpper',
  'compareHistoryRevisions',
  'selectCompareCandidate',
  'openHistoryDiff',
  'comparePreviousVisible',
  'compareBase',
  'viewHistoryRevision',
  'exportHistoryVersion',
  'copyHistoryText',
  'blameHistoryRevision',
  'updateToHistoryRevision',
  'checkoutHistoryDirectory',
  // P7 冲突处理
  'selectConflict',
  'setConflictTab',
  'chooseConflictVariant',
  'applyConflictResolution',
  'postponeConflict',
  'prepareTreeConflict',
  'rescanConflicts',
  'planConflictBatch',
  'startConflictBatch',
  'showConflictBatchResults',
  'scanWholeWorkCopy',
  'inspectConflict',
  'openWorkCopyTerminal',
  'openConflictDiff',
  'openConflictEditor',
  'openConflictVersion',
  'copyConflictPath',
  'authenticateConflictSource',
] as const;

export type M4IntentKind = (typeof M4_INTENT_KINDS)[number];

/** 意图动作白名单：新增动作必须同时登记在这里与 intent 校验分支。 */
const INTENT_KINDS = new Set<string>([
  'refresh', 'openDiff', 'openFile', 'dismissBanner', 'bannerAction',
  'setFilter', 'clearFilters', 'toggleRow', 'syncInput',
  'toggleGroup', 'toggleTree', 'setView', 'selectVisible', 'clearSelection',
  'selectChangelist', 'applyPrefix', 'managePrefixes', 'applyHistory', 'showHistory',
  'rowMore', 'submit', 'closePanel', 'resolveUnknown',
  'addRule', 'removeRule', 'fillOriginName', 'saveIgnore', 'submitIgnore',
  'pickParentDir', 'pickDirectDir', 'pickSourceDir', 'useUrlName', 'useDirName',
  'selectHistoryUrl', 'clearUrlHistory', 'checkoutNext', 'importNext', 'checkoutBack',
  'startCheckout', 'startImport', 'cancelTask', 'viewTaskLog',
  'verifyCheckout', 'resumeCheckout', 'abandonResidue', 'refreshImportPreview',
  'verifyImport', 'retryImport', 'switchP3Mode', 'acknowledgeMerged', 'abandonUnknownImport',
  'openCurrentWindow', 'openNewWindow', 'addToWorkspace', 'revealResultDir', 'revealSourceDir',
  'handoffToCheckout', 'newTask',
  'startScan', 'cancelScan', 'rescan', 'confirmVacuum', 'revealFileInOS', 'showScopeHelp',
  'setSort', 'setPage',
  ...M4_INTENT_KINDS,
]);

/** 提交面板视图切换的合法取值。 */
const VIEW_MODES = new Set(['tree', 'list']);

/** 表格排序方向的合法取值。 */
const SORT_DIRECTIONS = new Set(['asc', 'desc']);

export interface ParsedViewMessage {
  ok: true;
  message: ViewToHostMessage;
}

export interface RejectedViewMessage {
  ok: false;
  reason: string;
}

function isObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null;
}

/** 字段读取结果：值或本地化错误消息（不抛异常，供统一拒绝原因拼接）。 */
type FieldResult<T> = { ok: true; value: T } | { ok: false; message: string };

function readString(source: Record<string, unknown>, key: string, label: string): FieldResult<string> {
  const value = source[key];
  return typeof value === 'string'
    ? { ok: true, value }
    : { ok: false, message: format(strings.panel.validation.stringField, { label: `${label}.${key}` }) };
}

function readFiniteNumber(source: Record<string, unknown>, key: string, label: string): FieldResult<number> {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? { ok: true, value }
    : { ok: false, message: format(strings.panel.validation.numberField, { label: `${label}.${key}` }) };
}

/**
 * M4 新增枚举校验的 i18n key（`panel.validation.invalidEnum`）默认文案。
 * i18n 文件落地该键后自动优先取 i18n；未落地前用本默认值（同 i18n_keys），
 * 保证定向单测可运行。登记见本模块交付的 i18n_keys。
 */
const INVALID_ENUM_DEFAULT = '{label} 的取值非法：允许 {allowed}，收到 {value}';
const validationStrings: Record<string, string | undefined> = strings.panel.validation;
const INVALID_ENUM_TEMPLATE = validationStrings.invalidEnum ?? INVALID_ENUM_DEFAULT;

/** 枚举字段校验：值必须是允许集合内的字符串（白名单外的值直接拒绝）。 */
function readEnum<T extends string>(
  source: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  label: string,
): FieldResult<T> {
  const value = source[key];
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return { ok: true, value: value as T };
  }
  return {
    ok: false,
    message: format(INVALID_ENUM_TEMPLATE, {
      label: `${label}.${key}`,
      allowed: allowed.join(' | '),
      value: String(value),
    }),
  };
}

/** 校验 intent 载荷：动作白名单 + 字段类型（不校验条目存在性，那属于宿主侧能力校验）。 */
function parseIntent(raw: unknown): { ok: true; intent: Intent } | { ok: false; reason: string } {
  if (!isObject(raw)) {
    return { ok: false, reason: strings.panel.validation.intentObject };
  }
  const kind = raw.kind;
  if (typeof kind !== 'string' || !INTENT_KINDS.has(kind)) {
    return { ok: false, reason: format(strings.panel.validation.unknownIntent, { kind: String(kind) }) };
  }
  const label = `intent(${kind})`;
  switch (kind) {
    case 'refresh':
    case 'clearFilters':
    case 'selectVisible':
    case 'clearSelection':
    case 'selectChangelist':
    case 'managePrefixes':
    case 'showHistory':
    case 'submit':
    case 'closePanel':
    case 'resolveUnknown':
    case 'addRule':
    case 'fillOriginName':
    case 'saveIgnore':
    case 'submitIgnore':
    case 'pickParentDir':
    case 'pickDirectDir':
    case 'pickSourceDir':
    case 'useUrlName':
    case 'useDirName':
    case 'clearUrlHistory':
    case 'checkoutNext':
    case 'importNext':
    case 'checkoutBack':
    case 'startCheckout':
    case 'startImport':
    case 'cancelTask':
    case 'viewTaskLog':
    case 'verifyCheckout':
    case 'resumeCheckout':
    case 'abandonResidue':
    case 'refreshImportPreview':
    case 'verifyImport':
    case 'retryImport':
    case 'switchP3Mode':
    case 'acknowledgeMerged':
    case 'abandonUnknownImport':
    case 'openCurrentWindow':
    case 'openNewWindow':
    case 'addToWorkspace':
    case 'revealResultDir':
    case 'revealSourceDir':
    case 'handoffToCheckout':
    case 'newTask':
    case 'startScan':
    case 'cancelScan':
    case 'rescan':
    case 'confirmVacuum':
    case 'showScopeHelp':
    // M4：P6 无参动作。
    case 'loadMoreHistory':
    case 'clearHistoryFilters':
    case 'resetHistorySession':
    case 'compareHistoryRevisions':
    case 'openHistoryDiff':
    case 'comparePreviousVisible':
    case 'compareBase':
    case 'viewHistoryRevision':
    case 'exportHistoryVersion':
    case 'blameHistoryRevision':
    case 'updateToHistoryRevision':
    case 'checkoutHistoryDirectory':
    // M4：P7 无参动作。
    case 'applyConflictResolution':
    case 'postponeConflict':
    case 'prepareTreeConflict':
    case 'planConflictBatch':
    case 'startConflictBatch':
    case 'showConflictBatchResults':
    case 'scanWholeWorkCopy':
    case 'inspectConflict':
    case 'openWorkCopyTerminal':
    case 'openConflictDiff':
    case 'openConflictEditor':
    case 'authenticateConflictSource': {
      // 无参意图：case 标签联合到判别联合的直接构造在类型层不可表达
      // （宽 kind 无法匹配单一成员），此处集中一次断言；带载荷意图各有
      // 独立校验分支，白名单与单测双重覆盖此列表。
      return { ok: true, intent: { kind } as Intent };
    }
    case 'openDiff':
    case 'openFile':
    case 'rowMore': {
      const itemId = readString(raw, 'itemId', label);
      return itemId.ok
        ? { ok: true, intent: { kind: kind as 'openDiff' | 'openFile' | 'rowMore', itemId: itemId.value } }
        : { ok: false, reason: itemId.message };
    }
    case 'revealFileInOS': {
      const rowId = readString(raw, 'rowId', label);
      return rowId.ok
        ? { ok: true, intent: { kind, rowId: rowId.value } }
        : { ok: false, reason: rowId.message };
    }
    case 'dismissBanner': {
      const bannerId = readString(raw, 'bannerId', label);
      return bannerId.ok
        ? { ok: true, intent: { kind, bannerId: bannerId.value } }
        : { ok: false, reason: bannerId.message };
    }
    case 'bannerAction': {
      const bannerId = readString(raw, 'bannerId', label);
      if (!bannerId.ok) {
        return { ok: false, reason: bannerId.message };
      }
      const actionId = readString(raw, 'actionId', label);
      return actionId.ok
        ? { ok: true, intent: { kind, bannerId: bannerId.value, actionId: actionId.value } }
        : { ok: false, reason: actionId.message };
    }
    case 'setFilter': {
      const filterId = readString(raw, 'filterId', label);
      if (!filterId.ok) {
        return { ok: false, reason: filterId.message };
      }
      const value = readString(raw, 'value', label);
      return value.ok
        ? { ok: true, intent: { kind, filterId: filterId.value, value: value.value } }
        : { ok: false, reason: value.message };
    }
    case 'toggleRow': {
      const rowId = readString(raw, 'rowId', label);
      if (!rowId.ok) {
        return { ok: false, reason: rowId.message };
      }
      if (typeof raw.selected !== 'boolean') {
        return { ok: false, reason: format(strings.panel.validation.booleanField, { label }) };
      }
      return { ok: true, intent: { kind, rowId: rowId.value, selected: raw.selected } };
    }
    case 'toggleGroup': {
      const groupId = readString(raw, 'groupId', label);
      if (!groupId.ok) {
        return { ok: false, reason: groupId.message };
      }
      if (typeof raw.selected !== 'boolean') {
        return { ok: false, reason: format(strings.panel.validation.booleanField, { label }) };
      }
      return { ok: true, intent: { kind, groupId: groupId.value, selected: raw.selected } };
    }
    case 'toggleTree': {
      const nodeId = readString(raw, 'nodeId', label);
      if (!nodeId.ok) {
        return { ok: false, reason: nodeId.message };
      }
      if (typeof raw.selected !== 'boolean') {
        return { ok: false, reason: format(strings.panel.validation.booleanField, { label }) };
      }
      return { ok: true, intent: { kind, nodeId: nodeId.value, selected: raw.selected } };
    }
    case 'setView': {
      const view = raw.view;
      if (typeof view !== 'string' || !VIEW_MODES.has(view)) {
        return { ok: false, reason: format(strings.panel.validation.viewMode, { view: String(view) }) };
      }
      return { ok: true, intent: { kind, view: view as 'tree' | 'list' } };
    }
    case 'applyPrefix':
    case 'applyHistory':
    case 'removeRule':
    case 'selectHistoryUrl': {
      const index = readFiniteNumber(raw, 'index', label);
      if (!index.ok) {
        return { ok: false, reason: index.message };
      }
      if (!Number.isInteger(index.value) || index.value < 0) {
        return { ok: false, reason: format(strings.panel.validation.numberField, { label: `${label}.index` }) };
      }
      return { ok: true, intent: { kind, index: index.value } };
    }
    case 'setSort': {
      const key = readString(raw, 'key', label);
      if (!key.ok) {
        return { ok: false, reason: key.message };
      }
      const direction = raw.direction;
      if (typeof direction !== 'string' || !SORT_DIRECTIONS.has(direction)) {
        return { ok: false, reason: format(strings.panel.validation.sortDirection, { direction: String(direction) }) };
      }
      return { ok: true, intent: { kind, key: key.value, direction: direction as 'asc' | 'desc' } };
    }
    case 'setPage': {
      const page = readFiniteNumber(raw, 'page', label);
      if (!page.ok) {
        return { ok: false, reason: page.message };
      }
      if (!Number.isInteger(page.value) || page.value < 1) {
        return { ok: false, reason: format(strings.panel.validation.pageNumber, { label: `${label}.page` }) };
      }
      return { ok: true, intent: { kind, page: page.value } };
    }
    case 'syncInput': {
      const fieldId = readString(raw, 'fieldId', label);
      if (!fieldId.ok) {
        return { ok: false, reason: fieldId.message };
      }
      const value = readString(raw, 'value', label);
      if (!value.ok) {
        return { ok: false, reason: value.message };
      }
      const inputRevision = readFiniteNumber(raw, 'inputRevision', label);
      return inputRevision.ok
        ? {
            ok: true,
            intent: {
              kind,
              fieldId: fieldId.value,
              value: value.value,
              inputRevision: inputRevision.value,
            },
          }
        : { ok: false, reason: inputRevision.message };
    }
    /* ---------------- M4：P5 仓库浏览器（仅稳定 nodeId，不接受路径） ---------------- */
    case 'toggleBrowserNode':
    case 'selectBrowserNode':
    case 'retryBrowserNode':
    case 'refreshBrowserNode':
    case 'loadMoreBrowserNode':
    case 'copyBrowserNodeUrl':
    case 'openRemoteNode':
    case 'openHistoryFromBrowser': {
      const nodeId = readString(raw, 'nodeId', label);
      return nodeId.ok
        ? {
            ok: true,
            intent: {
              kind: kind as
                | 'toggleBrowserNode'
                | 'selectBrowserNode'
                | 'retryBrowserNode'
                | 'refreshBrowserNode'
                | 'loadMoreBrowserNode'
                | 'copyBrowserNodeUrl'
                | 'openRemoteNode'
                | 'openHistoryFromBrowser',
              nodeId: nodeId.value,
            },
          }
        : { ok: false, reason: nodeId.message };
    }
    /* ---------------- M4：P6 历史与比较 ---------------- */
    case 'selectHistoryRevision':
    case 'toggleHistoryRevision':
    case 'selectCompareCandidate': {
      const id = readString(raw, 'id', label);
      return id.ok
        ? {
            ok: true,
            intent: {
              kind: kind as 'selectHistoryRevision' | 'toggleHistoryRevision' | 'selectCompareCandidate',
              id: id.value,
            },
          }
        : { ok: false, reason: id.message };
    }
    case 'setHistoryFilter': {
      const id = readString(raw, 'id', label);
      if (!id.ok) {
        return { ok: false, reason: id.message };
      }
      const value = readString(raw, 'value', label);
      return value.ok
        ? { ok: true, intent: { kind, id: id.value, value: value.value } }
        : { ok: false, reason: value.message };
    }
    case 'refreshHistoryUpper': {
      // 协议层只接受 head/base-fallback：unresolved/live-head 等会话来源或
      // 其他任意值一律在解析层拒绝，宿主不会收到非法 mode。
      const mode = readEnum(raw, 'mode', REFRESH_HISTORY_UPPER_MODES, label);
      return mode.ok
        ? { ok: true, intent: { kind, mode: mode.value } }
        : { ok: false, reason: mode.message };
    }
    case 'copyHistoryText': {
      const copyKind = readEnum(raw, 'copyKind', HISTORY_COPY_KINDS, label);
      if (!copyKind.ok) {
        return { ok: false, reason: copyKind.message };
      }
      const id = readString(raw, 'id', label);
      return id.ok
        ? { ok: true, intent: { kind, copyKind: copyKind.value, id: id.value } }
        : { ok: false, reason: id.message };
    }
    /* ---------------- M4：P7 冲突处理 ---------------- */
    case 'selectConflict':
    case 'copyConflictPath': {
      const id = readString(raw, 'id', label);
      return id.ok
        ? { ok: true, intent: { kind: kind as 'selectConflict' | 'copyConflictPath', id: id.value } }
        : { ok: false, reason: id.message };
    }
    case 'setConflictTab': {
      const tab = readEnum(raw, 'tab', CONFLICT_TABS, label);
      return tab.ok
        ? { ok: true, intent: { kind, tab: tab.value } }
        : { ok: false, reason: tab.message };
    }
    case 'chooseConflictVariant': {
      const value = readEnum(raw, 'value', CONFLICT_VARIANTS, label);
      return value.ok
        ? { ok: true, intent: { kind, value: value.value } }
        : { ok: false, reason: value.message };
    }
    case 'rescanConflicts': {
      const scope = readEnum(raw, 'scope', CONFLICT_RESCAN_SCOPES, label);
      return scope.ok
        ? { ok: true, intent: { kind, scope: scope.value } }
        : { ok: false, reason: scope.message };
    }
    case 'openConflictVersion': {
      const role = readEnum(raw, 'role', CONFLICT_VERSION_ROLES, label);
      return role.ok
        ? { ok: true, intent: { kind, role: role.value } }
        : { ok: false, reason: role.message };
    }
  }
  // kind 已在 INTENT_KINDS 白名单过滤，这里不可达；保留兜底防御未来新增遗漏。
  return { ok: false, reason: format(strings.panel.validation.unknownIntent, { kind: String(kind) }) };
}

/**
 * 宿主侧入站消息运行时校验。返回拒绝原因时不静默处理：调用方应记录并提示。
 * 协议版本不匹配按错误处理，不做静默降级。
 */
export function parseViewMessage(raw: unknown): ParsedViewMessage | RejectedViewMessage {
  if (!isObject(raw)) {
    return { ok: false, reason: strings.panel.validation.messageObject };
  }
  if (raw.type !== 'ready' && raw.type !== 'intent') {
    return { ok: false, reason: format(strings.panel.validation.unknownType, { type: String(raw.type) }) };
  }
  if (raw.protocolVersion !== PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: format(strings.panel.validation.versionMismatch, {
        expected: String(PROTOCOL_VERSION),
        actual: String(raw.protocolVersion),
      }),
    };
  }
  if (raw.type === 'ready') {
    return { ok: true, message: { type: 'ready', protocolVersion: PROTOCOL_VERSION } };
  }
  const sessionId = readString(raw, 'sessionId', 'intent 消息');
  if (!sessionId.ok) {
    return { ok: false, reason: sessionId.message };
  }
  const requestId = readString(raw, 'requestId', 'intent 消息');
  if (!requestId.ok) {
    return { ok: false, reason: requestId.message };
  }
  const intent = parseIntent(raw.intent);
  if (!intent.ok) {
    return { ok: false, reason: intent.reason };
  }
  return {
    ok: true,
    message: {
      type: 'intent',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: sessionId.value,
      requestId: requestId.value,
      intent: intent.intent,
    },
  };
}
