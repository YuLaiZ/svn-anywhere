/**
 * P6 快照比较、BASE 比较、单文件导出与 P6→P3 交接的宿主模型（M4 阶段 3
 * 任务 4/5/6）。纯 TypeScript + core 调用，不依赖 vscode，可在 vitest 中
 * 直接驱动；对话框/原生 diff 的宿主壳在 host/diffView.ts。
 *
 * 口径（本地 SVN 实测）：
 * - 左右方向只看用户选择的 revision 数值（较小者为左/旧端），勾选顺序无
 *   影响；每端先按历史复制窗口解析「所选 revision 的实际节点」，再以实际
 *   URL + 实际 revision 交给 core/snapshot 比较（不拿删除后的 URL 读内容，
 *   也不把 info 的「不存在」误报成网络错误）；
 * - 目录目标两端分别解析目标目录根（复制目录在复制点两侧得到不同实际
 *   根），summarize 输出路径固定从 `--old` 根剥离相对路径再拼右根；单端
 *   不存在时枚举另一端（core/snapshot 的 list 流式分支）；父目录比较只取
 *   两端实际快照的交并差异，**不放宽到两条提交记录路径的并集**；
 * - 候选全量留在宿主内存，Webview 每页最多 100 条；筛选/翻页只重算宿主
 *   切片，绝不重新请求 SVN；
 * - 候选状态区分新增/删除/修改/属性/二进制/无差异；内容是否二进制由
 *   宿主在选中候选时经 remoteContent 探测后回填，未探测前不伪造二进制
 *   判定；
 * - 导出只写用户选择的目标路径：svn 先导出到同目录临时文件再原子替换；
 *   导出源 URL 与含字面 `@` 的本地目标路径都必须 peg 转义（实测
 *   实测 `E200009`）；删除提交导出 `deletionRevision - 1` 的实际节点，
 *   不可读时按已加载历史前序回退并明确实际导出版本；目录导出仍归 M6；
 * - BASE 比较：文件目标复用单文件 BASE diff 的数据形态；目录目标先以
 *   `svn status --xml` 得实际本地变化，再由调用方逐项复用 BASE diff；
 * - P6→P3 交接契约为「已解析的实际目录 URL + 数字 revision +
 *   nodeKind='dir'」；文件目标在宿主入口直接拒绝，P3 侧仍重新执行 URL
 *   校验、连接检查、空目标检查与确认，交接不绕过任何写前检查。
 */
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { SvnError } from '../../core/errors';
import {
  resolveHistoryNodeAtRevision,
  type HistoryEntry,
  type HistoryTarget,
} from '../../core/history';
import { classifyBrowseFailure } from '../../core/remoteBrowse';
import {
  candidateDiffType,
  compareDirectorySnapshots,
  compareFileSnapshots,
  orderSnapshotEndpoints,
  resolveDeletionPrecedingRevision,
  resolveSnapshotNode,
  type SnapshotCompareResult,
  type SnapshotDiffCandidate,
  type SnapshotDiffSource,
  type SnapshotNodeState,
} from '../../core/snapshot';
import { runStatus } from '../../core/status';
import { runOrThrow, urlWithPeg, type RunOptions } from '../../core/svnCli';
import { normalizeCheckoutUrl } from '../../core/checkout';
import { escapePeg } from '../../core/workspace';
import { format, strings } from '../i18n';
import type { TableFilterSpec, TableSpec } from './state';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 比较候选每页最多条数（Webview TableSpec 每页最多 100）。 */
export const SNAPSHOT_CANDIDATE_PAGE_SIZE = 100;

/** 删除前历史前序回退候选的最大数量（core/snapshot 内部另有 8 次尝试上限）。 */
export const SNAPSHOT_DELETION_FALLBACK_MAX = 8;

// ---------------------------------------------------------------------------
// 本地文案（i18n.snapshotPanel 落地前用本地默认值；落地后自动优先取 i18n，
// 与 browseModel 的本地文案模式一致。新键集合登记见交付的 i18n_keys）
// ---------------------------------------------------------------------------

/**
 * 模型本地文案默认值（i18n.snapshotPanel 落地同名键后自动优先取 i18n）。
 * 导出供文案漂移对账测试（同键同值；漂移视为回归）。
 */
export const SNAPSHOT_TEXT_DEFAULTS = {
  statePresent: '存在',
  stateAbsent: '该 revision 不存在（与删除相关）',
  stateNotFoundAtRevision: '无法在该 revision 定位实际节点',
  diffAdded: '新增',
  diffDeleted: '删除',
  diffProperty: '属性变更',
  diffContent: '内容变更',
  diffBinary: '二进制',
  diffSame: '无差异',
  tooLarge: '快照条目超出读取上限（50,000 条 / 64 MiB），请缩小比较范围后重试。',
  /** 差异一端不存在时的编辑器标签（snapshotDisplayName 兜底）。 */
  displayNameAbsent: '（不存在）',
  /** 宿主缺少 showSaveDialog 时导出失败的原因。 */
  exportNoSaveDialog: '宿主缺少保存对话框',
  binaryNotice: '二进制文件不做文本差异；可查看版本或导出。',
  specialNotice: '该节点是符号链接（svn:special），不进入文本差异；可导出或外部打开。',
  /** 临时资源打开失败：磁盘余量不足（原始诊断只进输出频道日志）。 */
  insufficientDisk: '磁盘剩余空间不足，未写出临时文件；请清理磁盘后重试。',
  /** 「查看此版本」失败：按 BrowserError.kind 映射，原始诊断只进日志。 */
  openFailedNotFound: '目标在该 revision 不存在。',
  openFailedRevisionNotFound: '该 revision 在仓库中不存在。',
  openFailedAuth: '读取该版本内容需要认证，认证未完成；请重试并补录凭据。',
  openFailedPermission: '没有读取该版本内容的权限。',
  openFailedNetwork: '读取该版本内容时网络错误：{message}',
  openFailedParse: '读取该版本内容的响应无法解析，已中止；请重试。',
  openFailedCancelled: '读取该版本内容已取消。',
  openFailedUnknown: '读取该版本内容失败：{message}',
  /** 快照比较失败：按 SvnError.code / 错误分类映射（不直出英文技术诊断）。 */
  compareXmlParse: '快照 XML 解析失败，未能生成比较结果；请重试。',
  compareSummarizeMapping: '差异输出路径不在旧端根下，无法映射相对路径；本次比较已中止。',
  compareSummarizeNotFound: '两端节点都存在，但差异命令报告目标缺失；未展示不完整结果，请重试。',
  compareEnumerationNotFound: '目录枚举未找到节点信息声称存在的路径；请重试。',
  compareAuthFailed: '读取快照需要认证，认证未完成；请重新比较并补录凭据。',
  comparePermissionFailed: '没有读取该快照目标的权限。',
  compareNetworkFailed: '读取快照时网络错误：{message}',
  compareNotFoundFailed: '比较目标在某端 revision 不存在。',
  compareRevisionNotFoundFailed: '所选 revision 在仓库中不存在。',
  compareCancelledFailed: '快照读取已取消。',
  compareUnknownFailed: '读取快照时发生未分类错误：{message}',
  exportSaved: '已导出到：{path}',
  exportDeletedNotice: '已导出删除前版本 r{revision}（请求 r{requested}）：{path}',
  exportFallbackNotice: '请求的 revision 不可读，已按历史前序回退到 r{revision} 导出：{path}',
  exportExistsTitle: '目标文件已存在，覆盖？',
  exportExistsDetail: '将覆盖目标路径的现有内容：{path}',
  exportExistsConfirm: '覆盖',
  exportCanceled: '已取消导出。',
  exportFailed: '导出失败：{message}',
  exportDialogTitle: '导出文件版本',
  exportPrecedingDialogTitle: '导出删除前版本',
  exportDirectoryBlocked: '目录快照导出不属于当前版本能力（目录导出见后续版本）。',
  exportNotFound: '所选 revision 上没有可导出的实际节点。',
  baseNoChanges: '本地没有需要比较的变化。',
  baseChangesSummary: '本地实际变化 {count} 项（目录目标逐项复用 BASE 差异）。',
  baseCompareConfirmWithin: '本地实际变化 {count} 项（目录目标逐项复用 BASE 差异）；确认后逐项打开差异。',
  baseCompareConfirmLimited: '本地实际变化 {count} 项（目录目标逐项复用 BASE 差异）；一次最多打开 {limit} 个差异，确认后打开前 {limit} 个。',
  baseCompareConfirmButton: '打开差异',
  baseCompareCanceled: '已取消打开 BASE 差异（本地实际变化 {count} 项）。',
  baseCompareTruncated: '已打开前 {limit} 个差异（共 {count} 项）；其余未打开，请缩小范围后重试。',
  baseCompareFailed: '读取本地状态失败：{message}',
  candidateTableTitle: '差异候选',
  columnPath: '路径',
  columnStatus: '状态',
  columnLeftRevision: '左 revision',
  columnRightRevision: '右 revision',
  noCandidates: '两个快照之间没有差异',
  noCandidatesDetail: '内容与属性均未变化（仅元数据变化不产生差异候选）。',
  filterEmpty: '没有匹配当前筛选的候选',
  filterEmptyDetail: '已加载候选保持不变；清空筛选可恢复。',
  candidateFilterPath: '按路径或 URL 筛选',
  pageSummary: '第 {page} / {pageCount} 页，共 {total} 个候选',
  handoffFileRejected: '文件目标不能检出；请在历史中导出该版本。',
  handoffInvalidRevision: '检出此版本需要明确的数字 revision。',
  handoffEmptyUrl: '检出此版本需要已解析的目录 URL。',
  handoffInvalidUrl: '目录 URL 校验失败：{message}',
  handoffKindNotDir: '只有目录历史目标可以检出此版本。',
  handoffOpened: '已在检出面板预填该目录与 revision；请在检出面板中确认连接与空目录后开始。',
  handoffPanelNotReady: '检出面板尚未接入本版本。',
} as const;

type SnapshotTextKey = keyof typeof SNAPSHOT_TEXT_DEFAULTS;

interface SnapshotPanelStrings {
  readonly [key: string]: string | undefined;
}

/** i18n 已落地的 P6 快照比较文案（strings.snapshotPanel）；未落地时用本地默认。 */
function snapshotPanelStrings(): SnapshotPanelStrings | undefined {
  return (strings as unknown as { snapshotPanel?: SnapshotPanelStrings }).snapshotPanel;
}

/** 取快照比较文案：优先 i18n.snapshotPanel，回落本地默认中文；支持 {name} 占位。 */
export function snapshotText(key: SnapshotTextKey, params: Record<string, string> = {}): string {
  const override = snapshotPanelStrings()?.[key];
  return format(override ?? SNAPSHOT_TEXT_DEFAULTS[key], params);
}

// ---------------------------------------------------------------------------
// 候选状态与宿主切片（纯模型）
// ---------------------------------------------------------------------------

/** 候选的展示状态（交互设计「删除、新增、二进制、属性和无差异使用不同状态」）。 */
export type SnapshotCandidateStatus = 'added' | 'deleted' | 'modified' | 'property' | 'binary' | 'same';

/** 候选的内容类型探测结果（宿主在需要时探测后回填）。 */
export type SnapshotCandidateContentKind = 'text' | 'binary';

/** 单条候选的宿主状态（全量留在宿主，不整批进入 Webview）。 */
export interface SnapshotCandidateState {
  /** 稳定 ID（比较结果固定后不变；意图 selectCompareCandidate 只带它）。 */
  id: string;
  /** 相对比较目标根的逐段编码路径（文件目标与目录根自身为 ''）。 */
  relativePath: string;
  /** 展示用解码路径（逐段解码一次；空串表示目标根自身）。 */
  displayPath: string;
  /** svn summarize 原 item 词（added/deleted/modified/none；list 分支为 added/deleted）。 */
  item: string;
  /** svn summarize 原 props 词（none/modified）。 */
  props: string;
  /** 节点类型原词（file/dir）；与 item 组成二元组，同 URL 两条不去重。 */
  kind: string;
  leftPresent: boolean;
  rightPresent: boolean;
  leftUrl?: string;
  rightUrl?: string;
  leftRevision?: number;
  rightRevision?: number;
  /** 内容探测结果；undefined 表示宿主尚未探测（不伪造二进制判定）。 */
  contentKind?: SnapshotCandidateContentKind;
  /** 两端内容是否相同（属性-only 且内容相同 → property；未探测为 undefined）。 */
  contentsEqual?: boolean;
  /** 展示状态（由 item/props/contentKind 派生）。 */
  status: SnapshotCandidateStatus;
  /** 可打开原生文本差异（二进制/特殊文件/无差异时为 false）。 */
  canOpenTextDiff: boolean;
  /** 可导出该候选某端的实际文件版本。 */
  canExport: boolean;
}

/** 比较会话相位：idle → loading → ready/tooLarge/error。 */
export type SnapshotComparePhase = 'idle' | 'loading' | 'ready' | 'tooLarge' | 'error';

/** 一次快照比较的宿主状态。 */
export interface SnapshotCompareState {
  target: HistoryTarget;
  /** 左/旧端（较小 revision）。 */
  leftRevision: number;
  /** 右/新端（较大 revision）。 */
  rightRevision: number;
  phase: SnapshotComparePhase;
  left: SnapshotNodeState | null;
  right: SnapshotNodeState | null;
  source: SnapshotDiffSource | null;
  /** 全量候选（稳定排序；宿主唯一真相源）。 */
  candidates: SnapshotCandidateState[];
  /** 文本筛选值（大小写不敏感子串，作用路径与两端 URL）。 */
  filterText: string;
  /** 筛选后的候选下标（顺序与 candidates 一致）。 */
  filteredIndexes: number[];
  /** 当前页（1 起）。 */
  page: number;
  /** 选中候选 ID（openHistoryDiff 的对象）。 */
  selectedId: string | null;
  tooLargeLimit: 'entries' | 'bytes' | null;
  errorMessage: string | null;
}

function decodeLoose(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 逐段解码相对路径（不猜编码；非法段原样保留）。 */
export function decodeSnapshotRelativePath(relativePath: string): string {
  if (relativePath === '') {
    return '';
  }
  return relativePath.split('/').map(decodeLoose).join('/');
}

/** 由 summarize 结果与内容探测推导展示状态（二进制优先于文本差异）。 */
export function deriveSnapshotCandidateStatus(input: {
  item: string;
  props: string;
  contentKind?: SnapshotCandidateContentKind;
  contentsEqual?: boolean;
}): SnapshotCandidateStatus {
  // 复用 core/snapshot 的差异大类判定（内容是否相同由探测结果给出）。
  const diffType = candidateDiffType({
    relativePath: '',
    item: input.item,
    props: input.props,
    kind: 'file',
    leftPresent: true,
    rightPresent: true,
  }, input.contentsEqual === true);
  if (diffType === 'property' || diffType === 'same') {
    return diffType;
  }
  if (input.contentKind === 'binary') {
    return 'binary';
  }
  return diffType === 'content' ? 'modified' : diffType;
}

function candidateCanOpenTextDiff(status: SnapshotCandidateStatus, contentKind?: SnapshotCandidateContentKind): boolean {
  if (status === 'property' || status === 'same' || status === 'binary') {
    return false;
  }
  // 未探测时允许发起打开：宿主打开前仍会按 mime/NUL 与 svn:special 复核。
  return contentKind !== 'binary';
}

function candidateCanExport(candidate: { leftPresent: boolean; rightPresent: boolean; leftUrl?: string; rightUrl?: string }): boolean {
  return (candidate.rightPresent && candidate.rightUrl !== undefined)
    || (candidate.leftPresent && candidate.leftUrl !== undefined);
}

function toCandidateState(candidate: SnapshotDiffCandidate, index: number): SnapshotCandidateState {
  const base = {
    id: `c${index}`,
    relativePath: candidate.relativePath,
    displayPath: decodeSnapshotRelativePath(candidate.relativePath),
    item: candidate.item,
    props: candidate.props,
    kind: candidate.kind,
    leftPresent: candidate.leftPresent,
    rightPresent: candidate.rightPresent,
    leftUrl: candidate.leftUrl,
    rightUrl: candidate.rightUrl,
    leftRevision: candidate.leftRevision,
    rightRevision: candidate.rightRevision,
  };
  const status = deriveSnapshotCandidateStatus(base);
  return {
    ...base,
    status,
    canOpenTextDiff: candidateCanOpenTextDiff(status, undefined),
    canExport: candidateCanExport(base),
  };
}

/** 创建比较状态：按 revision 数值定左右（勾选顺序无影响），初始为 idle。 */
export function createSnapshotCompareState(
  target: HistoryTarget,
  firstRevision: number,
  secondRevision: number,
): SnapshotCompareState {
  const ordered = orderSnapshotEndpoints(
    { url: target.url, revision: firstRevision },
    { url: target.url, revision: secondRevision },
  );
  return {
    target,
    leftRevision: ordered.left.revision,
    rightRevision: ordered.right.revision,
    phase: 'idle',
    left: null,
    right: null,
    source: null,
    candidates: [],
    filterText: '',
    filteredIndexes: [],
    page: 1,
    selectedId: null,
    tooLargeLimit: null,
    errorMessage: null,
  };
}

/** 标记一次比较开始（控制器随后解析端点并执行比较）。 */
export function beginSnapshotCompare(state: SnapshotCompareState): SnapshotCompareState {
  return {
    ...state,
    phase: 'loading',
    left: null,
    right: null,
    source: null,
    candidates: [],
    filteredIndexes: [],
    page: 1,
    selectedId: null,
    tooLargeLimit: null,
    errorMessage: null,
  };
}

function filterMatches(candidate: SnapshotCandidateState, filterText: string): boolean {
  if (filterText === '') {
    return true;
  }
  const needle = filterText.toLowerCase();
  return candidate.displayPath.toLowerCase().includes(needle)
    || (candidate.leftUrl ?? '').toLowerCase().includes(needle)
    || (candidate.rightUrl ?? '').toLowerCase().includes(needle);
}

function computeFilteredIndexes(candidates: SnapshotCandidateState[], filterText: string): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    if (filterMatches(candidates[index], filterText)) {
      indexes.push(index);
    }
  }
  return indexes;
}

function pageCountOf(state: SnapshotCompareState): number {
  return Math.max(1, Math.ceil(state.filteredIndexes.length / SNAPSHOT_CANDIDATE_PAGE_SIZE));
}

/** 应用比较成功结果：候选全量留在宿主，筛选/页码复位，不自动选中第一条。 */
export function applySnapshotCompareResult(
  state: SnapshotCompareState,
  result: Extract<SnapshotCompareResult, { state: 'ready' }>,
): SnapshotCompareState {
  const candidates = result.candidates.map((candidate, index) => toCandidateState(candidate, index));
  return {
    ...state,
    phase: 'ready',
    left: result.left,
    right: result.right,
    source: result.source,
    candidates,
    filterText: '',
    filteredIndexes: candidates.map((_candidate, index) => index),
    page: 1,
    selectedId: null,
    tooLargeLimit: null,
    errorMessage: null,
  };
}

/** 应用预算超限：不展示部分候选冒充完整差异（candidates 清空）。 */
export function applySnapshotCompareTooLarge(
  state: SnapshotCompareState,
  result: Extract<SnapshotCompareResult, { state: 'tooLarge' }>,
): SnapshotCompareState {
  return {
    ...state,
    phase: 'tooLarge',
    left: result.left,
    right: result.right,
    source: result.source,
    candidates: [],
    filterText: '',
    filteredIndexes: [],
    page: 1,
    selectedId: null,
    tooLargeLimit: result.limit,
    errorMessage: null,
  };
}

/**
 * 比较失败的用户文案：优先按 SvnError.code（XML_PARSE / SUMMARIZE_* /
 * ENUMERATION_NOT_FOUND）映射专属语义，其余按 classifyBrowseFailure 的
 * 认证/权限/网络/不存在分类映射；英文技术诊断只作为网络/未知类模板的
 * 补充信息，不直出为主文案。
 */
export function snapshotCompareErrorText(error: unknown): string {
  if (error instanceof SvnError) {
    switch (error.code) {
      case 'XML_PARSE':
        return snapshotText('compareXmlParse');
      case 'SUMMARIZE_MAPPING':
        return snapshotText('compareSummarizeMapping');
      case 'SUMMARIZE_NOT_FOUND':
        return snapshotText('compareSummarizeNotFound');
      case 'ENUMERATION_NOT_FOUND':
        return snapshotText('compareEnumerationNotFound');
      default:
        break;
    }
  }
  const classified = classifyBrowseFailure(error);
  switch (classified.kind) {
    case 'auth':
      return snapshotText('compareAuthFailed');
    case 'permission':
      return snapshotText('comparePermissionFailed');
    case 'network':
      return snapshotText('compareNetworkFailed', { message: classified.message });
    case 'notFound':
      return snapshotText('compareNotFoundFailed');
    case 'revisionNotFound':
      return snapshotText('compareRevisionNotFoundFailed');
    case 'cancelled':
      return snapshotText('compareCancelledFailed');
    default:
      return snapshotText('compareUnknownFailed', { message: classified.message });
  }
}

/** 应用比较失败（错误文案按语义分类映射，不直出 core 技术诊断）。 */
export function applySnapshotCompareError(
  state: SnapshotCompareState,
  error: unknown,
): SnapshotCompareState {
  const message = snapshotCompareErrorText(error);
  return {
    ...state,
    phase: 'error',
    left: null,
    right: null,
    source: null,
    candidates: [],
    filterText: '',
    filteredIndexes: [],
    page: 1,
    selectedId: null,
    tooLargeLimit: null,
    errorMessage: message,
  };
}

/**
 * 回填候选内容探测结果（控制器按需探测：远端内容类型 / 两端内容是否相同）。
 * status 与可打开文本差异标志随之重算；未提供的候选保持原状。
 */
export function applySnapshotCandidateProbes(
  state: SnapshotCompareState,
  probes: ReadonlyMap<string, { contentKind?: SnapshotCandidateContentKind; contentsEqual?: boolean }>,
): SnapshotCompareState {
  if (probes.size === 0) {
    return state;
  }
  let changed = false;
  const candidates = state.candidates.map((candidate) => {
    const probe = probes.get(candidate.id);
    if (probe === undefined) {
      return candidate;
    }
    changed = true;
    const contentKind = probe.contentKind ?? candidate.contentKind;
    const contentsEqual = probe.contentsEqual ?? candidate.contentsEqual;
    const status = deriveSnapshotCandidateStatus({
      item: candidate.item,
      props: candidate.props,
      contentKind,
      contentsEqual,
    });
    return {
      ...candidate,
      contentKind,
      contentsEqual,
      status,
      canOpenTextDiff: candidateCanOpenTextDiff(status, contentKind),
    };
  });
  return changed ? { ...state, candidates } : state;
}

/**
 * 设置候选文本筛选：只重算宿主切片（不发起任何 SVN 请求），页码回 1；
 * 选中候选被筛掉时清空选中（不自动改选第一条）。
 */
export function setSnapshotCompareFilter(state: SnapshotCompareState, filterText: string): SnapshotCompareState {
  const filteredIndexes = computeFilteredIndexes(state.candidates, filterText);
  const selectedVisible = state.selectedId !== null
    && filteredIndexes.some((index) => state.candidates[index].id === state.selectedId);
  return {
    ...state,
    filterText,
    filteredIndexes,
    page: 1,
    selectedId: selectedVisible ? state.selectedId : null,
  };
}

/** 翻页：只改宿主切片页码，clamp 到有效范围，不重新请求 SVN。 */
export function setSnapshotComparePage(state: SnapshotCompareState, page: number): SnapshotCompareState {
  const maxPage = pageCountOf(state);
  const normalized = Number.isFinite(page) ? Math.min(Math.max(1, Math.trunc(page)), maxPage) : 1;
  return { ...state, page: normalized };
}

/** 选择候选（意图 selectCompareCandidate 的宿主映射）；未知 ID 忽略。 */
export function selectSnapshotCandidate(state: SnapshotCompareState, id: string): SnapshotCompareState {
  if (!state.candidates.some((candidate) => candidate.id === id)) {
    return state;
  }
  return { ...state, selectedId: id };
}

/** 当前选中候选（openHistoryDiff 读取）。 */
export function selectedSnapshotCandidate(state: SnapshotCompareState): SnapshotCandidateState | undefined {
  if (state.selectedId === null) {
    return undefined;
  }
  return state.candidates.find((candidate) => candidate.id === state.selectedId);
}

/**
 * 候选内容探测目标（宿主对选中候选做 mime/NUL 探测时使用）：
 * 右/新端优先（展示当前 revision 的内容类型），右端不存在时退回左端；
 * 两端都不存在（枚举不留此形态）返回 undefined。
 */
export function snapshotCandidateProbeSide(
  candidate: SnapshotCandidateState,
): { url: string; revision: number } | undefined {
  if (candidate.rightPresent && candidate.rightUrl !== undefined && candidate.rightRevision !== undefined) {
    return { url: candidate.rightUrl, revision: candidate.rightRevision };
  }
  if (candidate.leftPresent && candidate.leftUrl !== undefined && candidate.leftRevision !== undefined) {
    return { url: candidate.leftUrl, revision: candidate.leftRevision };
  }
  return undefined;
}

/** 当前页切片与分页信息（宿主唯一真相源，Webview 每页最多 100 条）。 */
export function snapshotCandidatePage(state: SnapshotCompareState): {
  page: number;
  pageCount: number;
  total: number;
  candidates: SnapshotCandidateState[];
} {
  const start = (state.page - 1) * SNAPSHOT_CANDIDATE_PAGE_SIZE;
  const indexes = state.filteredIndexes.slice(start, start + SNAPSHOT_CANDIDATE_PAGE_SIZE);
  return {
    page: state.page,
    pageCount: pageCountOf(state),
    total: state.filteredIndexes.length,
    candidates: indexes.map((index) => state.candidates[index]),
  };
}

/** 候选状态计数（比较结果摘要；二进制按展示状态单独计数）。 */
export function snapshotCompareSummary(state: SnapshotCompareState): Record<SnapshotCandidateStatus, number> {
  const summary: Record<SnapshotCandidateStatus, number> = {
    added: 0,
    deleted: 0,
    modified: 0,
    property: 0,
    binary: 0,
    same: 0,
  };
  for (const candidate of state.candidates) {
    summary[candidate.status] += 1;
  }
  return summary;
}

/** 候选状态展示文案。 */
export function snapshotCandidateStatusText(status: SnapshotCandidateStatus): string {
  switch (status) {
    case 'added':
      return snapshotText('diffAdded');
    case 'deleted':
      return snapshotText('diffDeleted');
    case 'property':
      return snapshotText('diffProperty');
    case 'binary':
      return snapshotText('diffBinary');
    case 'same':
      return snapshotText('diffSame');
    case 'modified':
      return snapshotText('diffContent');
  }
}

/** 两端解析状态的展示文案（状态见 SnapshotNodeState）。 */
export function snapshotNodeStateText(node: SnapshotNodeState | null): string {
  if (node === null) {
    return '';
  }
  switch (node.state) {
    case 'present':
      return snapshotText('statePresent');
    case 'absent':
      return snapshotText('stateAbsent');
    case 'notFoundAtRevision':
      return snapshotText('stateNotFoundAtRevision');
  }
}

/**
 * 构建比较候选表格（宿主已切片：rows 为当前页最多 100 条）。
 * rowSelectIntent 固定 selectCompareCandidate：点行只更新选中，不触发
 * 新的读取；打开差异由 openHistoryDiff 读取选中项。
 */
export function buildSnapshotCandidateTable(
  state: SnapshotCompareState,
  options: { filters?: TableFilterSpec[]; sort?: TableSpec['sort'] } = {},
): TableSpec {
  const slice = snapshotCandidatePage(state);
  const rows = slice.candidates.map((candidate) => ({
    id: candidate.id,
    cells: {
      path: candidate.displayPath === '' ? '.' : candidate.displayPath,
      status: snapshotCandidateStatusText(candidate.status),
      leftRevision: candidate.leftRevision === undefined ? '—' : `r${candidate.leftRevision}`,
      rightRevision: candidate.rightRevision === undefined ? '—' : `r${candidate.rightRevision}`,
    },
    selected: candidate.id === state.selectedId,
  }));
  return {
    id: 'snapshotCandidates',
    columns: [
      { key: 'path', label: snapshotText('columnPath') },
      { key: 'status', label: snapshotText('columnStatus') },
      { key: 'leftRevision', label: snapshotText('columnLeftRevision') },
      { key: 'rightRevision', label: snapshotText('columnRightRevision') },
    ],
    sort: options.sort ?? { key: 'path', direction: 'asc' },
    ...(options.filters !== undefined ? { filters: options.filters } : {}),
    pagination: {
      page: slice.page,
      pageSize: SNAPSHOT_CANDIDATE_PAGE_SIZE,
      total: slice.total,
      pageCount: slice.pageCount,
      mode: 'page',
    },
    rows,
    rowSelectIntent: 'selectCompareCandidate',
    empty: {
      title: snapshotText('noCandidates'),
      detail: snapshotText('noCandidatesDetail'),
    },
    filterEmpty: {
      title: snapshotText('filterEmpty'),
      detail: snapshotText('filterEmptyDetail'),
    },
    note: snapshotText('pageSummary', {
      page: String(slice.page),
      pageCount: String(slice.pageCount),
      total: String(slice.total),
    }),
  };
}

// ---------------------------------------------------------------------------
// 比较端点解析与执行（core 编排）
// ---------------------------------------------------------------------------

/** 快照比较入参：目标身份、两端所选 revision 与已加载历史（复制窗口）。 */
export interface SnapshotCompareRequest {
  target: HistoryTarget;
  /** 用户选择的一端 revision（顺序无影响）。 */
  firstRevision: number;
  /** 用户选择的另一端 revision。 */
  secondRevision: number;
  /** 已加载历史（复制窗口）：提供复制点与删除记录。 */
  entries: Iterable<HistoryEntry>;
  /** 该端所选的 revision 是删除提交时显式提供（会话已知的删除提交）。 */
  firstDeletionRevision?: number;
  secondDeletionRevision?: number;
  /** 比较预算覆盖（测试用小参数；生产用 core 默认 50k/64 MiB）。 */
  budget?: { maxEntries?: number; maxBytes?: number };
}

/** 端点解析结果（左右按 revision 数值排序）。 */
export interface ResolvedSnapshotEndpoints {
  left: SnapshotNodeState;
  right: SnapshotNodeState;
}

/**
 * 解析一端在所选 revision 的实际节点：
 * 1. 先按历史复制窗口解析（resolveHistoryNodeAtRevision）——复制在所选
 *    revision 本身发生时用新路径，早于复制时切到 copyfrom 来源；
 * 2. present 时再次 info 取得完整节点信息（URL/根/UUID/kind/lastChanged），
 *    后续 summarize/list 都以该实际节点为准；
 * 3. 明确 absent 时用目标当前 URL + 所选 revision 如实标记（deletedAtRevision
 *    取历史删除提交或调用方提供的 deletionRevision）；
 * 4. 无法覆盖时 notFoundAtRevision，不拿删除后的 URL 读取内容。
 */
async function resolveCompareEndpoint(
  svnPath: string,
  target: HistoryTarget,
  revision: number,
  entries: HistoryEntry[],
  deletionRevision: number | undefined,
  options: RunOptions,
): Promise<SnapshotNodeState> {
  const resolution = await resolveHistoryNodeAtRevision(
    svnPath,
    { target, revision, entries },
    options,
  );
  switch (resolution.status) {
    case 'present': {
      const node = await resolveSnapshotNode(
        svnPath,
        { url: resolution.url, revision: resolution.revision },
        options,
      );
      if (node.state === 'present') {
        return node;
      }
      // 身份解析报告存在而再次 info 报告不存在：证据自相矛盾，如实返回该
      // 端点状态（absent/notFoundAtRevision），由比较层按「单端不存在」处理。
      return node;
    }
    case 'absent':
      return {
        state: 'absent',
        url: target.url,
        revision,
        deletedAtRevision: deletionRevision ?? resolution.deletedRevision,
      };
    case 'notFoundAtRevision': {
      if (deletionRevision !== undefined && revision >= deletionRevision) {
        // 删除提交本身可由调用方已知的删除 revision 解释为该 revision 不存在。
        return { state: 'absent', url: target.url, revision, deletedAtRevision: deletionRevision };
      }
      return { state: 'notFoundAtRevision', url: target.url, revision };
    }
  }
}

/** 按 revision 数值定左右并解析两端实际节点（不执行 summarize）。 */
export async function resolveSnapshotCompareEndpoints(
  svnPath: string,
  request: SnapshotCompareRequest,
  options: RunOptions = {},
): Promise<{ left: SnapshotNodeState; right: SnapshotNodeState; leftRevision: number; rightRevision: number }> {
  const ordered = orderSnapshotEndpoints(
    { url: request.target.url, revision: request.firstRevision },
    { url: request.target.url, revision: request.secondRevision },
  );
  // 用户选择的 revision 决定左右方向；deletionRevision 跟随它所在的一端
  // （按 revision 数值对应，勾选顺序无关）。
  const entries = [...request.entries];
  const leftDeletion = ordered.left.revision === request.firstRevision
    ? request.firstDeletionRevision
    : request.secondDeletionRevision;
  const rightDeletion = ordered.right.revision === request.firstRevision
    ? request.firstDeletionRevision
    : request.secondDeletionRevision;
  const left = await resolveCompareEndpoint(
    svnPath, request.target, ordered.left.revision, entries, leftDeletion, options,
  );
  const right = await resolveCompareEndpoint(
    svnPath, request.target, ordered.right.revision, entries, rightDeletion, options,
  );
  return { left, right, leftRevision: ordered.left.revision, rightRevision: ordered.right.revision };
}

/**
 * 执行快照比较：文件目标用 compareFileSnapshots，目录目标用
 * compareDirectorySnapshots；两端以实际节点 URL/revision + 已解析状态传入，
 * 核心不会再次 info、也不会把端点 sort 成与用户选择相反的方向。
 * 只采用两端实际快照的差异（summarize 或单端 list 枚举），不使用提交
 * 记录路径并集。
 */
export async function runSnapshotCompare(
  svnPath: string,
  request: SnapshotCompareRequest,
  options: RunOptions = {},
): Promise<{ leftRevision: number; rightRevision: number; result: SnapshotCompareResult }> {
  const resolved = await resolveSnapshotCompareEndpoints(svnPath, request, options);
  const compare = request.target.kind === 'dir' ? compareDirectorySnapshots : compareFileSnapshots;
  const result = await compare(
    svnPath,
    {
      targetKind: request.target.kind,
      left: {
        url: request.target.url,
        revision: resolved.leftRevision,
        resolved: resolved.left,
      },
      right: {
        url: request.target.url,
        revision: resolved.rightRevision,
        resolved: resolved.right,
      },
    },
    options,
    request.budget,
  );
  return { leftRevision: resolved.leftRevision, rightRevision: resolved.rightRevision, result };
}

/** 便捷入口：创建状态 → 执行比较 → 应用结果/超限/错误（控制器可直接用）。 */
export async function loadSnapshotCompare(
  svnPath: string,
  state: SnapshotCompareState,
  request: Omit<SnapshotCompareRequest, 'target' | 'firstRevision' | 'secondRevision'>,
  options: RunOptions = {},
): Promise<SnapshotCompareState> {
  const loading = beginSnapshotCompare(state);
  try {
    const { leftRevision, rightRevision, result } = await runSnapshotCompare(
      svnPath,
      {
        target: state.target,
        firstRevision: state.leftRevision,
        secondRevision: state.rightRevision,
        ...request,
      },
      options,
    );
    const oriented = { ...loading, leftRevision, rightRevision };
    return result.state === 'ready'
      ? applySnapshotCompareResult(oriented, result)
      : applySnapshotCompareTooLarge(oriented, result);
  } catch (err) {
    return applySnapshotCompareError(loading, err);
  }
}

// ---------------------------------------------------------------------------
// 导出：删除前版本解析与写盘（单文件）
// ---------------------------------------------------------------------------

/** 导出计划：回答「哪个实际节点 URL 在哪个 revision 可导出」。 */
export type SnapshotExportPlan =
  | {
      status: 'present';
      /** 实际节点 URL（复制场景为来源路径）。 */
      url: string;
      /** 实际可读 revision。 */
      revision: number;
      repositoryPath: string;
      nodeKind: 'file' | 'dir';
      sizeBytes?: number;
      /** svn:special 符号链接：导出会恢复为真实（可能 broken）符号链接，需显式提示。 */
      special?: boolean;
    }
  | {
      status: 'preceding';
      url: string;
      revision: number;
      repositoryPath: string;
      /** 请求的删除前 revision（deletionRevision - 1）。 */
      requestedRevision: number;
      /** deletionRevision-1 不可读、按历史前序回退得到。 */
      viaHistoryFallback: boolean;
      /** svn:special 符号链接（同 present 分支）。 */
      special?: boolean;
    }
  | { status: 'notFound'; requestedRevision: number; deletionRevision?: number }
  /** 目录导出仍归 M6：文件导出入口不处理目录节点。 */
  | { status: 'directoryNotSupported'; url: string; revision: number };

export interface PlanSnapshotExportParams {
  target: HistoryTarget;
  /** 用户在历史中选择的 revision。 */
  revision: number;
  /** 已加载历史（复制窗口 + 删除前历史前序候选）。 */
  entries: Iterable<HistoryEntry>;
  /** 所选 revision 是删除提交时显式提供。 */
  deletionRevision?: number;
}

/** 已加载历史中早于删除提交的 revision（降序；供删除前版本回退）。 */
export function snapshotPrecedingRevisions(
  entries: Iterable<HistoryEntry>,
  deletionRevision: number,
): number[] {
  const revisions = new Set<number>();
  for (const entry of entries) {
    if (entry.revision >= 1 && entry.revision < deletionRevision) {
      revisions.add(entry.revision);
    }
  }
  return [...revisions].sort((a, b) => b - a).slice(0, SNAPSHOT_DELETION_FALLBACK_MAX);
}

/**
 * svn:special 探测：属性存在且非空即符号链接（实测 cat 返回
 * `link <target>` 原文、info/list 只报 kind=file，不能靠大小/扩展名区分）。
 * 属性读取失败不阻塞调用方（按普通文件继续），导出/打开由 SVN 自身语义
 * 兜底。
 */
export async function probeSnapshotSpecial(
  svnPath: string,
  url: string,
  revision: number,
  options: RunOptions = {},
): Promise<boolean> {
  const args = [
    'propget', '--non-interactive',
    '-r', String(revision),
    'svn:special', '--',
    urlWithPeg(url, revision),
  ];
  try {
    const result = await runOrThrow(svnPath, args, options);
    return result.stdout.trim() !== '';
  } catch {
    return false;
  }
}

async function planPrecedingExport(
  svnPath: string,
  target: HistoryTarget,
  deletionRevision: number,
  entries: HistoryEntry[],
  options: RunOptions,
): Promise<SnapshotExportPlan> {
  const preceding = await resolveDeletionPrecedingRevision(
    svnPath,
    {
      url: target.url,
      deletionRevision,
      fallbackRevisions: snapshotPrecedingRevisions(entries, deletionRevision),
    },
    options,
  );
  if (preceding.state === 'notFound') {
    return { status: 'notFound', requestedRevision: deletionRevision - 1, deletionRevision };
  }
  if (preceding.node.kind === 'dir') {
    // 目录快照导出仍归 M6（任务 5：单文件导出）。
    return { status: 'directoryNotSupported', url: preceding.node.rawUrl, revision: preceding.revision };
  }
  const special = await probeSnapshotSpecial(svnPath, preceding.node.rawUrl, preceding.revision, options);
  return {
    status: 'preceding',
    url: preceding.node.rawUrl,
    revision: preceding.revision,
    repositoryPath: preceding.node.relativePath,
    requestedRevision: deletionRevision - 1,
    viaHistoryFallback: preceding.viaHistoryFallback,
    special,
  };
}

/**
 * 解析导出目标（任务 5）：
 * - 删除提交（revision 已知 >= deletionRevision）：以 `deletionRevision - 1`
 *   解析实际节点；不可读时按已加载历史前序回退，并返回实际导出版本；
 * - 普通 revision：复制窗口解析实际节点；present 直接用该实际 URL（复制
 *   场景导出复制前来源），absent（已删除）转删除前版本解析；
 * - 不拿删除后的 URL 读空内容，也不猜测来源。
 */
export async function planSnapshotExport(
  svnPath: string,
  params: PlanSnapshotExportParams,
  options: RunOptions = {},
): Promise<SnapshotExportPlan> {
  const entries = [...params.entries];
  if (params.deletionRevision !== undefined && params.revision >= params.deletionRevision) {
    return planPrecedingExport(svnPath, params.target, params.deletionRevision, entries, options);
  }
  const resolution = await resolveHistoryNodeAtRevision(
    svnPath,
    { target: params.target, revision: params.revision, entries },
    options,
  );
  switch (resolution.status) {
    case 'present': {
      const node = await resolveSnapshotNode(
        svnPath,
        { url: resolution.url, revision: resolution.revision },
        options,
      );
      if (node.state !== 'present') {
        return { status: 'notFound', requestedRevision: params.revision };
      }
      if (node.node.kind === 'dir') {
        return { status: 'directoryNotSupported', url: node.node.rawUrl, revision: node.node.snapshotRevision };
      }
      const special = await probeSnapshotSpecial(svnPath, node.node.rawUrl, node.node.snapshotRevision, options);
      return {
        status: 'present',
        url: node.node.rawUrl,
        revision: node.node.snapshotRevision,
        repositoryPath: node.node.relativePath,
        nodeKind: node.node.kind,
        sizeBytes: node.sizeBytes,
        special,
      };
    }
    case 'absent': {
      const deletionRevision = params.deletionRevision ?? resolution.deletedRevision ?? params.revision;
      return planPrecedingExport(svnPath, params.target, deletionRevision, entries, options);
    }
    case 'notFoundAtRevision':
      return { status: 'notFound', requestedRevision: params.revision };
  }
}

export interface WriteSnapshotExportParams {
  /** 实际节点 URL（planSnapshotExport 的结果）。 */
  url: string;
  /** 实际可读 revision。 */
  revision: number;
  /** 用户选择的目标文件绝对路径。 */
  targetPath: string;
  /** 目标已存在时必须显式确认（对话框覆盖确认后的值）。 */
  overwrite?: boolean;
  /** 超时（毫秒）；缺省不限时（大文件导出是长任务）。 */
  timeoutMs?: number;
}

export type WriteSnapshotExportResult =
  | { status: 'exported'; path: string }
  | { status: 'exists'; path: string }
  | { status: 'failed'; message: string; error?: SvnError };

/**
 * 导出单文件到用户选择的目标路径（任务 5）：
 * - 先导出到目标同目录的 `.part` 临时文件（保证 rename 在同一文件系统），
 *   成功后原子替换目标；`svn export --force` 不会清理目录旧文件，不能拿
 *   它冒充干净覆盖；
 * - 导出源 URL 经统一 peg 构造器；**本地目标路径含字面 `@` 时同样要补
 *   尾随 `@`**，否则 svn 报 `E200009: a peg revision is not allowed here`；
 * - 失败删除半成品临时文件，不把半文件留在目标路径。
 */
export async function writeSnapshotExport(
  svnPath: string,
  params: WriteSnapshotExportParams,
  options: RunOptions = {},
): Promise<WriteSnapshotExportResult> {
  try {
    statSync(params.targetPath);
    if (params.overwrite !== true) {
      return { status: 'exists', path: params.targetPath };
    }
  } catch {
    // 目标不存在：直接导出。
  }
  const dir = dirname(params.targetPath);
  const tempPath = `${dir}${sep}.${basename(params.targetPath)}.${randomBytes(6).toString('hex')}.part`;
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return {
      status: 'failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const args = [
    'export', '--non-interactive',
    '-r', String(params.revision),
    '--',
    urlWithPeg(params.url, params.revision),
    escapePeg(tempPath),
  ];
  const runOptions: RunOptions = { ...options };
  if (runOptions.timeoutMs === undefined) {
    // 导出大文件是长任务：默认不限时，取消由 signal 承担。
    runOptions.timeoutMs = params.timeoutMs ?? 0;
  }
  try {
    await runOrThrow(svnPath, args, runOptions);
    renameSync(tempPath, params.targetPath);
    return { status: 'exported', path: params.targetPath };
  } catch (err) {
    try {
      rmSync(tempPath, { recursive: true, force: true });
    } catch {
      // 清理失败只是残留临时文件，不影响本次导出结论。
    }
    return {
      status: 'failed',
      message: err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err),
      ...(err instanceof SvnError ? { error: err } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// BASE 比较计划（目录目标先 status 得实际变化；文件目标单条）
// ---------------------------------------------------------------------------

/** 单条本地实际变化：字段与 host/diffView.ts 的 DiffTarget 对齐，可直接复用 BASE diff。 */
export interface SnapshotBaseCompareEntry {
  /** 相对工作副本根的原始路径（不 trim）。 */
  relPath: string;
  /** svn status 原词（modified/added/deleted/missing/replaced/conflicted…）。 */
  wcStatus: string;
  /** 属性状态原词（none/normal/modified）。 */
  props?: string;
  /** 节点类型原词（file/dir）。 */
  kind?: string;
}

export type SnapshotBaseComparePlan =
  | { status: 'ready'; entries: SnapshotBaseCompareEntry[] }
  | { status: 'unchanged'; entries: SnapshotBaseCompareEntry[] }
  | { status: 'error'; message: string };

/** status 条目 → 相对 wcRoot 的路径（绝对路径取相对部分；相对路径原样）。 */
function statusRelPath(wcRoot: string, entryPath: string): string {
  if (!isAbsolute(entryPath)) {
    return entryPath;
  }
  const rel = relative(wcRoot, entryPath);
  return rel === '' ? '.' : rel.split(sep).join('/');
}

/** 目录变化是否值得比较：unversioned/external 没有 BASE，不进 BASE 比较。 */
const BASE_COMPARE_HIDDEN = new Set(['unversioned', 'external', 'ignored', 'normal']);

/**
 * 计划 BASE 比较（任务 5）：
 * - 文件目标：`svn status --xml` 该路径，得到实际 wc-status/props/kind
 *   （无变化时返回 unchanged，不打开伪差异）；
 * - 目录目标：`svn status --xml --depth infinity` 列出目录范围的实际本地
 *   变化，过滤 unversioned/external 等无 BASE 条目与 normal 条目（属性
 *   modified 的 normal 条目保留，属性变化单独展示）；
 * - 不把 remote 历史与本地工作内容混在一起，也不修改工作副本。
 */
export async function planSnapshotBaseCompare(
  svnPath: string,
  params: { wcRoot: string; relPath: string; kind: 'file' | 'dir' },
  options: RunOptions = {},
): Promise<SnapshotBaseComparePlan> {
  // runStatus 内部对目标做 escapePeg；这里传未转义的本地绝对路径。
  const targetPath = params.relPath === '.'
    ? params.wcRoot
    : join(params.wcRoot, ...params.relPath.split('/'));
  try {
    // 外部副本内部变更不属于本副本的 BASE 比较范围（与 M4 更新/扫描同口径）。
    const result = await runStatus(svnPath, targetPath, { ...options, ignoreExternals: true });
    const entries: SnapshotBaseCompareEntry[] = [];
    for (const entry of result.entries) {
      if (BASE_COMPARE_HIDDEN.has(entry.wcStatus) && entry.props !== 'modified') {
        continue;
      }
      entries.push({
        relPath: statusRelPath(params.wcRoot, entry.path),
        wcStatus: entry.wcStatus,
        props: entry.props,
        kind: entry.kind,
      });
    }
    if (entries.length === 0) {
      return { status: 'unchanged', entries: [] };
    }
    return { status: 'ready', entries };
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err),
    };
  }
}

/** status 原词是否可交给 openEntryDiff 直接复用 BASE 语义（展示辅助）。 */
export function isBaseComparableStatus(entry: SnapshotBaseCompareEntry): boolean {
  return entry.kind !== 'dir'
    ? ['modified', 'added', 'deleted', 'missing', 'replaced', 'conflicted', 'normal'].includes(entry.wcStatus)
    : entry.props === 'modified' || ['modified', 'added', 'deleted', 'replaced', 'conflicted'].includes(entry.wcStatus);
}

// ---------------------------------------------------------------------------
// P6→P3 交接契约
// ---------------------------------------------------------------------------

/**
 * P6→P3 交接参数（冻结契约）：只把已解析的实际目录 URL、明确数字 revision
 * 与目录类型交给 P3；文件目标不进入 P3。P3 侧仍重新执行 URL/连接/空目标/
 * 确认，交接不绕过任何写前检查，也不直接执行 checkout。
 */
export interface CheckoutHistoryHandoff {
  source: 'history';
  /** 已解析的实际目录 URL（不重复拼仓库根）。 */
  sourceUrl: string;
  /** 已确认的数字 revision。 */
  pinnedRevision: number;
  /** 文件交接在宿主入口直接拒绝。 */
  nodeKind: 'dir';
}

export type CheckoutHistoryHandoffCheck =
  | { ok: true; handoff: CheckoutHistoryHandoff }
  | { ok: false; reason: 'file-target' | 'invalid-revision' | 'empty-url' | 'invalid-url'; message: string };

/**
 * 校验 P6→P3 交接（宿主入口的最后一道防线，Webview 不渲染按钮不能替代）：
 * - 文件目标/非 dir 直接拒绝；
 * - revision 必须是正整数；
 * - URL 仍经 normalizeCheckoutUrl 重新校验（归一化后的值才进交接）。
 */
export function validateCheckoutHistoryHandoff(input: {
  sourceUrl: string;
  pinnedRevision: number;
  nodeKind: 'file' | 'dir';
}): CheckoutHistoryHandoffCheck {
  if (input.nodeKind !== 'dir') {
    return { ok: false, reason: 'file-target', message: snapshotText('handoffFileRejected') };
  }
  if (!Number.isInteger(input.pinnedRevision) || input.pinnedRevision < 1) {
    return { ok: false, reason: 'invalid-revision', message: snapshotText('handoffInvalidRevision') };
  }
  if (input.sourceUrl.trim() === '') {
    return { ok: false, reason: 'empty-url', message: snapshotText('handoffEmptyUrl') };
  }
  const normalized = normalizeCheckoutUrl(input.sourceUrl);
  if (!normalized.ok) {
    return {
      ok: false,
      reason: 'invalid-url',
      message: snapshotText('handoffInvalidUrl', { message: normalized.message }),
    };
  }
  return {
    ok: true,
    handoff: {
      source: 'history',
      sourceUrl: normalized.url,
      pinnedRevision: input.pinnedRevision,
      nodeKind: 'dir',
    },
  };
}

/** 交接入口的会话/草稿键：URL 本身稳定且与本地路径入口不冲突。 */
export function checkoutHandoffEntryKey(handoff: CheckoutHistoryHandoff): string {
  return `history:${handoff.sourceUrl}`;
}
