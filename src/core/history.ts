/**
 * P6 历史与版本比较 core 模块：`svn log --xml -v` 解析、单源 cursor、
 * 多源源栈（ancestor-filter / copyfrom）、每轮加载独立的 500 条扫描预算、
 * 筛选、5,000 命中 / 100,000 扫描上限与 upper 状态语义。core 模块，
 * 不依赖 vscode。
 *
 * 语义来源（历史分页、作者口径与节点解析契约，真实 svn 实测；关键结论）：
 * - 单页请求固定 `-l <historyPageSize + 1> -r <cursor>:1`，+1 只用于判断
 *   是否还有下一批、不多展示一条；
 * - 下一批 cursor 取「上一批最小 revision − 1」；cursor < 1 本地停止，
 *   不能发 `-r 0:1`（实测 svn 把 0 视为起点、会重复返回 r1）；
 * - 默认跟随复制（target 源不传 --stop-on-copy，由服务端默认跟随）；
 *   ancestor-filter 与 copyfrom 源始终传 --stop-on-copy，遇到带
 *   copyfrom-path/rev 的结构变更时由客户端压入来源源；
 * - 一次 loadMore 最多处理 500 条原始回包（跨源重复计入），下一次
 *   loadMore 重新获得独立预算；每页请求返回的 51 条中若有超出预算的
 *   尾部，只处理预算内前缀，cursor 按最后处理条目的 revision 推进
 *   （500 条扫描场景 fixture：单轮 500 扫描 → 80 命中 → 展示 50、pending 30、
 *   next cursor=60）；
 * - 三个集合语义不混用：scannedRevisionIds 是各源回包中出现过的全部
 *   revision（含未命中），entriesByRevision 是其中命中目标身份的记录，
 *   visibleEntries 是再经当前筛选后的可见记录；
 * - ancestor-filter 采用实测固定的严格规则：目标路径自身记录命中；
 *   祖先 D 命中；祖先 A/R 带 copyfrom 命中；祖先 A 无 copyfrom 只通过
 *   「同 revision 存在目标路径自身记录」间接命中，避免把「祖先目录首次
 *   创建」误当成从未存在的目标的历史；目录目标另命中任意后代路径变更；
 * - 上限检查在每次发出单页请求前；到达上限即停止请求并记录
 *   historyLimitState.reasons（actual=当前值）；最后一批越过时完整保留
 *   整页（actual>limit）不截断；同一轮可同时记录 matched/scanned；
 *   pending 未清空时 hasMore 仍为 true，清空后转 false。
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
  SvnError,
  extractSvnErrorCodes,
  tailText,
} from './errors';
import { run, runOrThrowWithRunner, urlWithPeg, type RunOptions, type RunResult } from './svnCli';

// ---------------------------------------------------------------------------
// 常量与冻结契约类型（历史分页契约）
// ---------------------------------------------------------------------------

/** 配置项 svnAnywhere.historyPageSize 的可选值（非法值回退 50）。 */
export const HISTORY_PAGE_SIZES = [20, 50, 100] as const;

/** 默认每批历史条数。 */
export const DEFAULT_HISTORY_PAGE_SIZE = 50;

/** 每次 loadMore 的原始回包扫描预算（下一次 loadMore 独立重置）。 */
export const HISTORY_RAW_BUDGET_PER_LOAD = 500;

/** 每目标保留的唯一命中 revision 上限。 */
export const HISTORY_MATCHED_LIMIT = 5_000;

/** 扫描去重集合（scannedRevisionIds）上限。 */
export const HISTORY_SCANNED_LIMIT = 100_000;

/** 会话历史上限参数；单测用同构小参数验证语义。 */
export interface HistoryLimits {
  matched: number;
  scanned: number;
  rawBudgetPerLoad: number;
}

export const DEFAULT_HISTORY_LIMITS: HistoryLimits = {
  matched: HISTORY_MATCHED_LIMIT,
  scanned: HISTORY_SCANNED_LIMIT,
  rawBudgetPerLoad: HISTORY_RAW_BUDGET_PER_LOAD,
};

/** 历史上限来源（历史分页契约的冻结枚举）。 */
export type HistoryUpperSource = 'unresolved' | 'live-head' | 'snapshot' | 'base-fallback';

/** HEAD 状态（历史分页契约的冻结枚举）。 */
export type HistoryHeadState = 'available' | 'unavailable' | 'unknown';

/** 日志源类型。 */
export type HistorySourceKind = 'target' | 'ancestor-filter' | 'copyfrom';

/** 单个变更路径（`log --xml -v` 的 <path>）。 */
export interface HistoryPathChange {
  /** 仓库绝对路径（以 / 开头，XML 原文，不 trim）。 */
  path: string;
  /** A/M/D/R 原词（不做自造字母映射）。 */
  action: string;
  /** 节点类型；部分 svn 版本/记录不输出。 */
  kind?: 'file' | 'dir';
  /** 复制来源路径（仓库绝对路径）；仅 A/R 复制记录有。 */
  copyfromPath?: string;
  copyfromRevision?: number;
  /** 1.8+ 服务端才有；1.6.17 缺失，历史行不依赖这两个字段。 */
  textMods?: boolean;
  propMods?: boolean;
}

/** 单条历史记录：一个 revision 的提交（同 revision 跨源只保留一条）。 */
export interface HistoryEntry {
  revision: number;
  author?: string;
  /** svn 原始 ISO 8601 UTC 时间字符串；展示/筛选统一经 formatLogDate。 */
  date?: string;
  message: string;
  paths: HistoryPathChange[];
}

/** 串行源栈中的一条日志源（历史分页契约的冻结字段）。 */
export interface HistorySource {
  id: string;
  kind: HistorySourceKind;
  queryUrl: string;
  pegRevision?: number;
  /** 该源内被跟踪的仓库绝对路径（target 源为目标自身，来源源为来源路径）。 */
  pathFilter?: string;
  cursor: number;
  scannedRaw: number;
  exhausted: boolean;
}

/** historyLimitState.reasons 单项。 */
export interface HistoryLimitReason {
  kind: 'matched' | 'scanned';
  limit: number;
  actual: number;
}

/** 会话状态（历史分页契约的冻结字段）。 */
export interface HistorySession {
  upperRevision: number | null;
  upperSource: HistoryUpperSource;
  headState: HistoryHeadState;
  sources: HistorySource[];
  activeSourceIndex: number;
  entriesByRevision: Map<number, HistoryEntry>;
  visibleEntries: HistoryEntry[];
  displayedCount: number;
  scannedRevisionIds: Set<number>;
  /**
   * 会话累计「已扫描原始批次中的实际作者」（作者下拉数据源）：
   * 收录各源原始回包中的全部作者（含未命中目标身份的提交），按首次
   * 出现顺序去重；不能从 fixture 或命中记录之外预先编造作者全集。
   */
  scannedAuthors: string[];
  rawFetchedTotal: number;
  rawFetchedInLoad: number;
  scannedThisLoad: Set<number>;
  scannedUniqueRevisions: number;
  loadedMatchedCount: number;
  visibleMatched: number;
  hasMore: boolean;
  canFetchMore: boolean;
  followCopies: boolean;
  historyLimitState: null | { reasons: HistoryLimitReason[] };
}

/**
 * 历史目标身份：远端命令以原始 URL 执行；仓库相对路径统一约定为
 * 「不含 ^/、无前导斜杠的未百分号编码原文」，命令 URL 由 rootUrl 逐段
 * 编码拼成（copyfrom-path 来自 XML 原文，同样经此构造）。
 */
export interface HistoryTarget {
  /** 目标实际 URL（原始编码，来自 info/list）。 */
  url: string;
  /** 仓库根 URL（原始编码，不二次编码）。 */
  repositoryRootUrl: string;
  /** 仓库相对路径（无前导斜杠；中文/空格/@ 为原文）。 */
  relativePath: string;
  kind: 'file' | 'dir';
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

/** 配置值归一：仅接受 20/50/100，其余（含 undefined/字符串/浮点）回退 50。 */
export function normalizeHistoryPageSize(value: unknown): number {
  return (HISTORY_PAGE_SIZES as readonly number[]).includes(value as number)
    ? (value as number)
    : DEFAULT_HISTORY_PAGE_SIZE;
}

/** 仓库路径归一：补前导 /、去尾随 /（根保留 /）。 */
function normalizeRepoPath(path: string): string {
  let p = path.startsWith('/') ? path : `/${path}`;
  p = p.replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

/** 内部规范化路径（带前导 /）转对外契约：无前导斜杠，根为 ''。 */
function toHistoryRelativePath(normalized: string): string {
  return normalized === '/' ? '' : normalized.slice(1);
}

/** 仓库相对目录/文件 URL：rootUrl + 逐段 encodeURIComponent（rootUrl 原样）。 */
export function urlForRepositoryPath(rootUrl: string, repositoryPath: string): string {
  const base = rootUrl.endsWith('/') ? rootUrl.slice(0, -1) : rootUrl;
  const normalized = normalizeRepoPath(repositoryPath);
  if (normalized === '/') {
    return base;
  }
  const segments = normalized.slice(1).split('/').map((segment) => encodeURIComponent(segment));
  return `${base}/${segments.join('/')}`;
}

// ---------------------------------------------------------------------------
// log --xml -v 解析
// ---------------------------------------------------------------------------

const logParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // 提交说明、作者与路径的首尾空格属于原文，不 trim。
  trimValues: false,
  // SVN 用冒号实体/数字实体表示路径字符；只解码一次。
  htmlEntities: true,
  // 纯数字的提交说明/路径保持字符串，不自动转 number。
  parseTagValue: false,
  parseAttributeValue: false,
  // logentry 与 path 一定按集合处理（单条目也保持数组）。
  isArray: (name) => name === 'logentry' || name === 'path',
});

interface RawLogPath {
  action?: unknown;
  kind?: unknown;
  'copyfrom-path'?: unknown;
  'copyfrom-rev'?: unknown;
  'text-mods'?: unknown;
  'prop-mods'?: unknown;
  /** 带属性的元素文本（路径）落在 #text；纯文本元素直接是字符串。 */
  '#text'?: unknown;
}

interface RawLogEntry {
  revision?: unknown;
  author?: unknown;
  date?: unknown;
  msg?: unknown;
  paths?: { path?: RawLogPath[] } | Array<{ path?: RawLogPath[] }>;
}

/** XML 文本值：字符串原样；数字（防御）转字符串；缺失为空串。 */
function xmlText(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return String(value);
}

/** XML 可选文本值：缺失返回 undefined（空元素算空串）。 */
function xmlOptionalText(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === 'string' ? value : String(value);
}

/** `true`/`false` 布尔文本（缺失返回 undefined）。 */
function xmlOptionalBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return undefined;
}

function xmlOptionalNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** <path> 可能带属性（kind/action/copyfrom-*）与文本路径；无属性时是纯字符串。 */
function parseLogPath(raw: RawLogPath | string): HistoryPathChange {
  if (typeof raw === 'string') {
    return { path: raw, action: '' };
  }
  return {
    path: xmlText(raw['#text']),
    action: xmlText(raw.action),
    kind: raw.kind === 'file' || raw.kind === 'dir' ? raw.kind : undefined,
    copyfromPath: xmlOptionalText(raw['copyfrom-path']),
    copyfromRevision: xmlOptionalNumber(raw['copyfrom-rev']),
    textMods: xmlOptionalBool(raw['text-mods']),
    propMods: xmlOptionalBool(raw['prop-mods']),
  };
}

/**
 * 解析 `svn log --xml -v` 输出。返回按 XML 顺序（服务端 revision 降序）
 * 的提交记录；revision 缺失或非法的条目丢弃（不伪造记录）。
 * 不依赖 text-mods/prop-mods（SVN 1.6.17 缺失），字段存在时保留原值。
 *
 * 畸形/截断 XML 不静默吞掉：抛 SvnError（code=XML_PARSE），与 snapshot/
 * blame 的 XML_PARSE 口径一致，宿主按错误态呈现而不是「空历史」。
 * 空输出（无任何记录）与空 <log> 仍返回空数组。
 */
export function parseLogXml(xml: string): HistoryEntry[] {
  if (xml.trim() === '') {
    return [];
  }
  // fast-xml-parser 的 XMLParser 容错很强（截断文档/纯文本会静默产出
  // 空对象）；先做结构校验，把截断、未闭合标签与非 XML 输出归为
  // XML_PARSE，与 snapshot/blame 的 XML_PARSE 口径一致。
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new SvnError({
      // 机器可读的英文技术诊断；面向用户的文案由宿主按错误分类映射。
      message: `svn log XML parse failed: ${validation.err.msg} (line ${validation.err.line}, col ${validation.err.col})`,
      command: ['log', '--xml'],
      stderr: tailText(xml),
      code: 'XML_PARSE',
    });
  }
  let parsed: { log?: { logentry?: RawLogEntry[] } };
  try {
    parsed = logParser.parse(xml) as { log?: { logentry?: RawLogEntry[] } };
  } catch (err) {
    throw new SvnError({
      message: `svn log XML parse failed: ${err instanceof Error ? err.message : String(err)}`,
      command: ['log', '--xml'],
      stderr: tailText(xml),
      code: 'XML_PARSE',
    });
  }
  const entries = parsed.log?.logentry;
  if (!Array.isArray(entries)) {
    return [];
  }
  const result: HistoryEntry[] = [];
  for (const raw of entries) {
    const revision = xmlOptionalNumber(raw.revision);
    if (revision === undefined || !Number.isInteger(revision) || revision < 1) {
      continue;
    }
    const pathContainers = Array.isArray(raw.paths) ? raw.paths : raw.paths ? [raw.paths] : [];
    const paths: HistoryPathChange[] = [];
    for (const container of pathContainers) {
      for (const rawPath of container.path ?? []) {
        const change = parseLogPath(rawPath);
        if (change.path !== '') {
          paths.push(change);
        }
      }
    }
    result.push({
      revision,
      author: xmlOptionalText(raw.author),
      date: xmlOptionalText(raw.date),
      message: xmlText(raw.msg),
      paths,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// 命令参数
// ---------------------------------------------------------------------------

/**
 * 单页 log 请求参数。
 * - `-l <pageSize + 1>`：+1 只用于判断是否还有下一批，不多展示；
 * - `-r <cursor>:1`：cursor 由上一批最小 revision − 1 推进；
 * - `--stop-on-copy`：target 源仅在「停在复制点」（followCopies=false）
 *   时传，跟随复制交给服务端默认行为；ancestor-filter 与 copyfrom 源
 *   始终传（由客户端在复制边界压入显式来源源）；
 * - URL 一律经统一 peg 构造器（含 @ 的 URL 也不能裸露），`--` 收尾防
 *   peg 误解析。
 */
export function buildHistoryLogArgs(
  source: HistorySource,
  pageSize: number,
  followCopies: boolean,
): string[] {
  const stopOnCopy = source.kind !== 'target' || !followCopies;
  return [
    'log',
    '--xml',
    '-v',
    '--non-interactive',
    '-l',
    String(pageSize + 1),
    '-r',
    `${source.cursor}:1`,
    ...(stopOnCopy ? ['--stop-on-copy'] : []),
    '--',
    urlWithPeg(source.queryUrl, source.pegRevision),
  ];
}

// ---------------------------------------------------------------------------
// 会话创建与源栈
// ---------------------------------------------------------------------------

/** 建立一条 target 源（目标在 upperRevision 存在时使用）。 */
export function createTargetSource(target: HistoryTarget, upperRevision: number): HistorySource {
  return {
    id: 'target',
    kind: 'target',
    queryUrl: target.url,
    pegRevision: upperRevision,
    pathFilter: normalizeRepoPath(target.relativePath),
    cursor: upperRevision,
    scannedRaw: 0,
    exhausted: false,
  };
}

/**
 * 建立 ancestor-filter 源（目标在 upperRevision 不存在时，对最近存在的
 * 祖先目录取 `-v --stop-on-copy` 日志，再按目标相对路径严格筛选）。
 */
export function createAncestorFilterSource(
  target: HistoryTarget,
  ancestorPath: string,
  upperRevision: number,
): HistorySource {
  return {
    id: 'ancestor-filter',
    kind: 'ancestor-filter',
    queryUrl: urlForRepositoryPath(target.repositoryRootUrl, ancestorPath),
    pegRevision: upperRevision,
    pathFilter: normalizeRepoPath(target.relativePath),
    cursor: upperRevision,
    scannedRaw: 0,
    exhausted: false,
  };
}

/** 建立 copyfrom 来源源（来源路径 @ copyfrom-rev，初始 cursor=copyfromRev）。 */
export function createCopyfromSource(params: {
  id: string;
  target: HistoryTarget;
  /** copyfrom-path 原文（查询 URL 基准）。 */
  queryPath: string;
  /** 来源路径 + 目标相对后缀（该源内被跟踪的路径）。 */
  pathFilter: string;
  copyRevision: number;
}): HistorySource {
  return {
    id: params.id,
    kind: 'copyfrom',
    queryUrl: urlForRepositoryPath(params.target.repositoryRootUrl, params.queryPath),
    pegRevision: params.copyRevision,
    pathFilter: normalizeRepoPath(params.pathFilter),
    cursor: params.copyRevision,
    scannedRaw: 0,
    exhausted: false,
  };
}

export interface HistorySessionInit {
  upperRevision: number;
  upperSource: 'live-head' | 'snapshot' | 'base-fallback';
  followCopies: boolean;
  /** 目标在 upperRevision 是否存在（由 info 分类决定，只有明确 absent 才为 false）。 */
  targetPresentAtUpper: boolean;
  target: HistoryTarget;
  /** targetPresentAtUpper=false 时：目标在 upperRevision 最近存在的祖先（仓库相对路径）。 */
  nearestExistingAncestor?: string;
}

/** upperSource 与初始 headState 的冻结对应关系。 */
function headStateForUpperSource(source: HistoryUpperSource): HistoryHeadState {
  if (source === 'live-head') {
    return 'available';
  }
  if (source === 'base-fallback') {
    return 'unavailable';
  }
  return 'unknown';
}

/**
 * 建立已解析 upper 的历史会话：按目标在 upperRevision 是否存在选择
 * target 源或 ancestor-filter 源；其余计数一律从 0 开始。
 */
export function createHistorySession(init: HistorySessionInit): HistorySession {
  if (!Number.isInteger(init.upperRevision) || init.upperRevision < 1) {
    throw new Error(`非法历史 upperRevision：${String(init.upperRevision)}`);
  }
  let source: HistorySource;
  if (init.targetPresentAtUpper) {
    source = createTargetSource(init.target, init.upperRevision);
  } else {
    if (init.nearestExistingAncestor === undefined) {
      throw new Error('目标在 upperRevision 不存在时必须提供最近存在的祖先路径');
    }
    source = createAncestorFilterSource(init.target, init.nearestExistingAncestor, init.upperRevision);
  }
  const session: HistorySession = {
    upperRevision: init.upperRevision,
    upperSource: init.upperSource,
    headState: headStateForUpperSource(init.upperSource),
    sources: [source],
    activeSourceIndex: 0,
    entriesByRevision: new Map(),
    visibleEntries: [],
    displayedCount: 0,
    scannedRevisionIds: new Set(),
    scannedAuthors: [],
    rawFetchedTotal: 0,
    rawFetchedInLoad: 0,
    scannedThisLoad: new Set(),
    scannedUniqueRevisions: 0,
    loadedMatchedCount: 0,
    visibleMatched: 0,
    hasMore: false,
    canFetchMore: false,
    followCopies: init.followCopies,
    historyLimitState: null,
  };
  updateHistoryDerivedCounters(session);
  return session;
}

/**
 * 初始 HEAD 解析失败时的固定会话：upperRevision=null、unresolved、
 * headState=unavailable、sources 为空。只开放 refresh head / 条件满足
 * 时的 base-fallback / 关闭，不开放 load-more 与 reset。
 */
export function createUnresolvedHistorySession(params: { followCopies: boolean }): HistorySession {
  return {
    upperRevision: null,
    upperSource: 'unresolved',
    headState: 'unavailable',
    sources: [],
    activeSourceIndex: 0,
    entriesByRevision: new Map(),
    visibleEntries: [],
    displayedCount: 0,
    scannedRevisionIds: new Set(),
    scannedAuthors: [],
    rawFetchedTotal: 0,
    rawFetchedInLoad: 0,
    scannedThisLoad: new Set(),
    scannedUniqueRevisions: 0,
    loadedMatchedCount: 0,
    visibleMatched: 0,
    hasMore: false,
    canFetchMore: false,
    followCopies: params.followCopies,
    historyLimitState: null,
  };
}

/**
 * 清除会话的历史数据，保留目标外的全部会话配置（upperRevision/
 * upperSource/headState/followCopies 由调用方保留，本函数不动）。
 * resetHistorySession 与 upper 刷新成功后共用。
 */
export function clearHistorySessionData(session: HistorySession): void {
  session.sources = [];
  session.activeSourceIndex = 0;
  session.entriesByRevision.clear();
  session.visibleEntries = [];
  session.displayedCount = 0;
  session.scannedRevisionIds.clear();
  session.scannedAuthors = [];
  session.rawFetchedTotal = 0;
  session.rawFetchedInLoad = 0;
  session.scannedThisLoad = new Set();
  session.scannedUniqueRevisions = 0;
  session.loadedMatchedCount = 0;
  session.visibleMatched = 0;
  session.hasMore = false;
  session.canFetchMore = false;
  session.historyLimitState = null;
}

// ---------------------------------------------------------------------------
// 严格命中规则（ancestor-filter / copyfrom 源）
// ---------------------------------------------------------------------------

/** path 是否等于 target 或为 target 的祖先（两者均为规范化仓库绝对路径）。 */
function isAncestorOrSelf(candidate: string, target: string): boolean {
  if (candidate === target) {
    return true;
  }
  if (candidate === '/') {
    return true;
  }
  return target.startsWith(`${candidate}/`);
}

/**
 * ancestor-filter 严格命中规则（本地实测口径 / probe_lib.relevant_strict）：
 * - 目标路径自身记录命中；
 * - 祖先目录 D 命中（目标被删除）；
 * - 祖先目录 A/R 带 copyfrom 命中（复制映射是否真正带入目标由来源源确认）；
 * - 祖先目录 A/R 无 copyfrom 不单独命中（只有同 revision 存在目标路径
 *   自身记录时，那条记录使该 revision 命中，由本条与单条记录 OR 达成）；
 * - 目录目标另命中任意后代路径变更。
 * 若按 basename 而非完整仓库路径前缀匹配，`/branches/base/x.txt` 会被
 * 误归给 `/trunk/x.txt`（本地实测），因此这里只做完整前缀判定。
 */
export function revisionMatchesHistoryTrackedPath(
  entry: HistoryEntry,
  trackedPath: string,
  kind: 'file' | 'dir',
): boolean {
  const tracked = normalizeRepoPath(trackedPath);
  for (const change of entry.paths) {
    const path = normalizeRepoPath(change.path);
    if (path === tracked) {
      return true;
    }
    if (kind === 'dir' && tracked !== '/' && path.startsWith(`${tracked}/`)) {
      // 目录目标：任意后代路径变更命中。
      return true;
    }
    if (isAncestorOrSelf(path, tracked)) {
      if (change.action === 'D') {
        return true;
      }
      if ((change.action === 'A' || change.action === 'R') && change.copyfromPath !== undefined) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 复制边界：压入 copyfrom 来源源
// ---------------------------------------------------------------------------

/** 由复制记录推导出的来源源信息。 */
export interface HistoryCopySourceInfo {
  /** copyfrom-path 原文（查询 URL 基准）。 */
  queryPath: string;
  /** 来源路径 + 目标相对后缀（该源内被跟踪的路径）。 */
  pathFilter: string;
  copyRevision: number;
  /** 触发映射的记录 revision。 */
  recordRevision: number;
}

/**
 * 在回包中找「目标路径或最近祖先的 A/R 复制点」，推导来源源：
 * - 目标自身或更近祖先的复制记录优先（change.path 越深越具体），
 *   避免把来源目录里的同名相对路径误归给当前目标；
 * - 同深度多条时取 revision 最大（当前身份链上最近一次复制）；
 * - 相对后缀从复制目标带到 copyfrom-path 上（如来源 /branches/base，
 *   后缀 x.txt）。
 * 无复制记录（例如无 copyfrom 的首次 A）返回 undefined，身份链结束。
 */
export function findCopySource(
  entries: Iterable<HistoryEntry>,
  trackedPath: string,
  kind: 'file' | 'dir',
): HistoryCopySourceInfo | undefined {
  const tracked = normalizeRepoPath(trackedPath);
  let best: HistoryCopySourceInfo | undefined;
  let bestDepth = -1;
  for (const entry of entries) {
    for (const change of entry.paths) {
      if (change.action !== 'A' && change.action !== 'R') {
        continue;
      }
      if (change.copyfromPath === undefined || change.copyfromRevision === undefined) {
        continue;
      }
      if (change.copyfromRevision < 1) {
        // 防御非法来源 revision（svn 输出不会出现 0）。
        continue;
      }
      const path = normalizeRepoPath(change.path);
      if (!isAncestorOrSelf(path, tracked)) {
        continue;
      }
      if (kind === 'dir' && tracked !== '/' && path.startsWith(`${tracked}/`)) {
        // 后代目录自身的复制不建立当前目录身份的来源。
        continue;
      }
      const suffix = path === tracked ? '' : tracked.slice(path.length);
      const sourcePath = `${normalizeRepoPath(change.copyfromPath)}${suffix}`;
      const candidate: HistoryCopySourceInfo = {
        queryPath: normalizeRepoPath(change.copyfromPath),
        pathFilter: sourcePath,
        copyRevision: change.copyfromRevision,
        recordRevision: entry.revision,
      };
      const depth = path.length;
      if (
        best === undefined
        || depth > bestDepth
        || (depth === bestDepth && candidate.recordRevision > best.recordRevision)
      ) {
        best = candidate;
        bestDepth = depth;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 筛选（只在已加载记录上重算展示前缀）
// ---------------------------------------------------------------------------

/** P6 历史筛选条件；字段缺省/空串表示不启用该条件，组合关系为 AND。 */
export interface HistoryFilter {
  /** 关键词：大小写不敏感匹配说明、作者、revision（含 rN）与全部变更路径（含复制来源）。 */
  keyword?: string;
  /** 作者：大小写不敏感精确匹配。 */
  author?: string;
  /** 起止日期（本地时区 YYYY-MM-DD，含端点）。 */
  dateFrom?: string;
  dateTo?: string;
  /** 路径：大小写不敏感子串，包含复制来源路径。 */
  path?: string;
}

/** 起止日期反序（起始晚于结束）：调用方不应用日期条件、保留上一有效结果。 */
export function isHistoryDateRangeReversed(filter: HistoryFilter): boolean {
  return filter.dateFrom !== undefined
    && filter.dateTo !== undefined
    && filter.dateFrom !== ''
    && filter.dateTo !== ''
    && filter.dateFrom > filter.dateTo;
}

/**
 * 日志时间的本地日期键（YYYY-MM-DD）：列表展示与筛选共用同一转换，
 * 先按扩展宿主本地时区转换再取日期，避免列表显示本地日期、筛选却按
 * UTC 字符串比较（实测日期边界）。无效/缺失日期返回 undefined。
 */
export function localDateKey(dateIso: string | undefined): string | undefined {
  if (dateIso === undefined || dateIso === '') {
    return undefined;
  }
  const date = new Date(dateIso);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 历史列表的日期展示值（本地时区 `YYYY-MM-DD HH:mm`）；无效/缺失返回空串。 */
export function formatLogDate(dateIso: string | undefined): string {
  const day = localDateKey(dateIso);
  if (day === undefined || dateIso === undefined) {
    return '';
  }
  const date = new Date(dateIso);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${day} ${hours}:${minutes}`;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** 单条记录是否命中当前筛选（组合 AND；大小写不敏感）。 */
export function historyEntryMatches(entry: HistoryEntry, filter: HistoryFilter): boolean {
  const keyword = nonEmpty(filter.keyword)?.toLowerCase();
  if (keyword !== undefined) {
    const revision = String(entry.revision);
    const haystacks = [
      entry.message,
      entry.author ?? '',
      revision,
      `r${revision}`,
      ...entry.paths.flatMap((change) => [change.path, change.copyfromPath ?? '']),
    ];
    if (!haystacks.some((text) => text.toLowerCase().includes(keyword))) {
      return false;
    }
  }
  const author = nonEmpty(filter.author);
  if (author !== undefined) {
    if ((entry.author ?? '').toLowerCase() !== author.toLowerCase()) {
      return false;
    }
  }
  const path = nonEmpty(filter.path)?.toLowerCase();
  if (path !== undefined) {
    const hit = entry.paths.some((change) =>
      change.path.toLowerCase().includes(path)
      || (change.copyfromPath ?? '').toLowerCase().includes(path));
    if (!hit) {
      return false;
    }
  }
  if (!isHistoryDateRangeReversed(filter)) {
    const dateFrom = nonEmpty(filter.dateFrom);
    const dateTo = nonEmpty(filter.dateTo);
    if (dateFrom !== undefined || dateTo !== undefined) {
      const day = localDateKey(entry.date);
      if (day === undefined) {
        return false;
      }
      if (dateFrom !== undefined && day < dateFrom) {
        return false;
      }
      if (dateTo !== undefined && day > dateTo) {
        return false;
      }
    }
  }
  return true;
}

/** 按 revision 降序（同一 revision 在 Map 中唯一）。 */
function sortedHistoryEntries(entries: Iterable<HistoryEntry>): HistoryEntry[] {
  return [...entries].sort((a, b) => b.revision - a.revision);
}

/**
 * 会话累计扫描原始批次作者（作者下拉数据源）：按首次出现顺序去重，
 * 收录原始回包中的全部作者（含未命中目标身份的提交）。作者匹配本身
 * 大小写不敏感，但下拉选项保留实际出现过的原值。
 */
function recordScannedAuthor(session: HistorySession, author: string | undefined): void {
  if (author === undefined || author === '') {
    return;
  }
  if (!session.scannedAuthors.includes(author)) {
    session.scannedAuthors.push(author);
  }
}

/**
 * 收集一组历史记录中的作者（按首次出现顺序去重），保留给需要从任意
 * 记录集合取作者的调用方。作者下拉必须使用会话累计的扫描作者口径
 * （已扫描原始批次中的实际作者），即 `session.scannedAuthors`。
 */
export function collectHistoryAuthors(entries: Iterable<HistoryEntry>): string[] {
  const seen = new Set<string>();
  const authors: string[] = [];
  for (const entry of entries) {
    const author = entry.author;
    if (author !== undefined && author !== '' && !seen.has(author)) {
      seen.add(author);
      authors.push(author);
    }
  }
  return authors;
}

/**
 * 按当前筛选重算可见列表（保留已扫描源栈与原始记录，不发网络）：
 * 展示游标回到起点，displayedCount = min(pageSize, visibleEntries.length)。
 * 筛选变化时调用；apply/finish 内部只刷新列表、不重置展示游标。
 * pageSize 由调用方按配置归一后传入（配置值经 normalizeHistoryPageSize）。
 */
export function recomputeHistoryView(
  session: HistorySession,
  filter: HistoryFilter,
  pageSize: number,
): void {
  session.visibleEntries = sortedHistoryEntries(session.entriesByRevision.values())
    .filter((entry) => historyEntryMatches(entry, filter));
  session.displayedCount = Math.min(pageSize, session.visibleEntries.length);
  updateHistoryDerivedCounters(session);
}

/** apply/finish 内部：按筛选刷新可见列表，保留当前展示游标（超长时截断）。 */
function refreshVisibleEntries(session: HistorySession, filter: HistoryFilter): void {
  session.visibleEntries = sortedHistoryEntries(session.entriesByRevision.values())
    .filter((entry) => historyEntryMatches(entry, filter));
  if (session.displayedCount > session.visibleEntries.length) {
    session.displayedCount = session.visibleEntries.length;
  }
}

// ---------------------------------------------------------------------------
// 派生计数与上限
// ---------------------------------------------------------------------------

/**
 * 重算派生计数：
 * - scannedUniqueRevisions = scannedRevisionIds.size（会话级扫描去重）；
 * - loadedMatchedCount = entriesByRevision.size（已加载命中目标的历史）；
 * - visibleMatched = visibleEntries.length（当前筛选下已加载记录数）；
 * - canFetchMore = 还有未耗尽源且未触发上限（definite error 由宿主叠加）；
 * - hasMore = displayedCount < visibleMatched || canFetchMore。
 */
export function updateHistoryDerivedCounters(session: HistorySession): void {
  session.scannedUniqueRevisions = session.scannedRevisionIds.size;
  session.loadedMatchedCount = session.entriesByRevision.size;
  session.visibleMatched = session.visibleEntries.length;
  const limitActive = session.historyLimitState !== null && session.historyLimitState.reasons.length > 0;
  const hasSource = session.upperRevision !== null && session.sources.some((source) => !source.exhausted);
  session.canFetchMore = hasSource && !limitActive;
  session.hasMore = session.displayedCount < session.visibleMatched || session.canFetchMore;
}

/**
 * 检查两个会话上限（每次发出单页请求前与一轮结束时都调用）：
 * - 到达上限即停止后续请求并记录 reason（actual=当前值）；
 * - 最后一批越过时保留整页（actual>limit），不截断、不淘汰已加载记录；
 * - 同一状态可同时包含 matched/scanned 两项，各自保存 limit/actual；
 * - 已记录过的 kind 不重复添加（保留首次触发时的 actual）。
 * 返回本次检查命中的 reason 列表（UI 本轮提示用）。
 */
export function checkHistoryLimits(
  session: HistorySession,
  limits: HistoryLimits = DEFAULT_HISTORY_LIMITS,
): HistoryLimitReason[] {
  const triggered: HistoryLimitReason[] = [];
  const matched = session.entriesByRevision.size;
  const scanned = session.scannedRevisionIds.size;
  if (matched >= limits.matched) {
    triggered.push({ kind: 'matched', limit: limits.matched, actual: matched });
  }
  if (scanned >= limits.scanned) {
    triggered.push({ kind: 'scanned', limit: limits.scanned, actual: scanned });
  }
  if (triggered.length > 0) {
    const reasons = session.historyLimitState?.reasons ?? [];
    for (const reason of triggered) {
      if (!reasons.some((existing) => existing.kind === reason.kind)) {
        reasons.push(reason);
      }
    }
    session.historyLimitState = { reasons };
    session.canFetchMore = false;
  }
  return triggered;
}

// ---------------------------------------------------------------------------
// 加载更多状态机
// ---------------------------------------------------------------------------

/** 一轮“加载更多”的模式。 */
export type HistoryLoadMode = 'pending-only' | 'network' | 'exhausted';

/**
 * 开始一轮“加载更多”：先把 rawFetchedInLoad 置 0、scannedThisLoad 清空
 * （每轮独立 500 条预算），再判断本轮模式：
 * - pending-only：visibleEntries 中已有超出 displayedCount 的匹配，先展示；
 * - network：没有待展示匹配且仍有可扫描源；
 * - exhausted：unresolved、无源可扫或上限已触发（无待展示时）。
 */
export function beginHistoryLoadMore(
  session: HistorySession,
  limits: HistoryLimits = DEFAULT_HISTORY_LIMITS,
): HistoryLoadMode {
  session.rawFetchedInLoad = 0;
  session.scannedThisLoad = new Set();
  if (session.upperRevision === null) {
    return 'exhausted';
  }
  if (session.displayedCount < session.visibleEntries.length) {
    return 'pending-only';
  }
  checkHistoryLimits(session, limits);
  updateHistoryDerivedCounters(session);
  if (!session.canFetchMore) {
    return 'exhausted';
  }
  return 'network';
}

/** 一条待发送的单页请求。 */
export interface HistoryLogRequest {
  source: HistorySource;
  args: string[];
  /** 本请求最多处理的原始回包条数（本轮 500 预算的剩余量）。 */
  budgetRemaining: number;
}

/** 推进到下一个未耗尽的源（复制边界压入的来源源在末尾）。 */
function activateNextAvailableSource(session: HistorySession): HistorySource | undefined {
  for (let index = session.activeSourceIndex; index < session.sources.length; index += 1) {
    if (!session.sources[index].exhausted) {
      session.activeSourceIndex = index;
      return session.sources[index];
    }
  }
  return undefined;
}

/**
 * 取下一张应发送的单页请求；无请求时返回 undefined（预算用尽、
 * 所有源耗尽或上限触发）。上限在每次发请求前检查，因此到达上限后
 * 不会再发出新的 log 命令。
 */
export function nextHistoryLogRequest(
  session: HistorySession,
  pageSize: number,
  limits: HistoryLimits = DEFAULT_HISTORY_LIMITS,
): HistoryLogRequest | undefined {
  if (session.upperRevision === null) {
    return undefined;
  }
  if (session.rawFetchedInLoad >= limits.rawBudgetPerLoad) {
    return undefined;
  }
  if (checkHistoryLimits(session, limits).length > 0) {
    updateHistoryDerivedCounters(session);
    return undefined;
  }
  const source = activateNextAvailableSource(session);
  if (source === undefined) {
    updateHistoryDerivedCounters(session);
    return undefined;
  }
  return {
    source,
    args: buildHistoryLogArgs(source, pageSize, session.followCopies),
    budgetRemaining: limits.rawBudgetPerLoad - session.rawFetchedInLoad,
  };
}

/** 应用一页 log 回包时需要的上下文。 */
export interface HistoryLogPage {
  sourceId: string;
  /** 解析后的回包（服务端 revision 降序），条数可多于本轮预算剩余。 */
  entries: HistoryEntry[];
  /** 发出该请求时的 `-l` 值（pageSize + 1），用于判定源是否结束。 */
  requestedLimit: number;
}

/** 路径并集：同 revision 跨源重复记录合并变更路径（去重，保持顺序）。 */
function unionHistoryPaths(existing: HistoryPathChange[], incoming: HistoryPathChange[]): HistoryPathChange[] {
  const result = [...existing];
  const seen = new Set(existing.map((change) =>
    [change.action, change.path, change.kind ?? '', change.copyfromPath ?? '', change.copyfromRevision ?? ''].join('\u0000')));
  for (const change of incoming) {
    const key = [change.action, change.path, change.kind ?? '', change.copyfromPath ?? '', change.copyfromRevision ?? ''].join('\u0000');
    if (!seen.has(key)) {
      seen.add(key);
      result.push(change);
    }
  }
  return result;
}

/**
 * 身份链终止判定：跟踪路径自身或祖先的 A/R 若没有 copyfrom，
 * 说明该身份链在此首次创建/重建，更早的 revision 属于另一个身份，
 * 不再进入更早历史（本轮之后把源标记为耗尽）。
 * 目录目标的后代路径首次新增不终止当前目录身份。
 */
function entryEndsIdentityChain(entry: HistoryEntry, trackedPath: string): boolean {
  const tracked = normalizeRepoPath(trackedPath);
  for (const change of entry.paths) {
    if (change.action !== 'A' && change.action !== 'R') {
      continue;
    }
    if (change.copyfromPath !== undefined) {
      continue;
    }
    if (isAncestorOrSelf(normalizeRepoPath(change.path), tracked)) {
      return true;
    }
  }
  return false;
}

/**
 * 应用一页 `svn log --xml -v` 回包（只处理本轮预算内的前缀）：
 * - rawFetchedInLoad / rawFetchedTotal / 源 scannedRaw 按原始条数累计
 *   （跨源重复也计入，用于预算与累计统计）；
 * - scannedThisLoad / scannedRevisionIds 按唯一 revision 去重；
 * - 命中判定：target 源全命中（服务端跟随语义）；ancestor-filter 与
 *   copyfrom 源按严格规则；
 * - 同 revision 跨源只保留一条，变更路径做并集；
 * - cursor 按最后处理条目的 revision − 1 推进；cursor < 1 或回包条数
 *   小于请求数（且未被预算截断）时源耗尽；
 * - ancestor-filter / copyfrom 源遇到「无 copyfrom 的首次 A/R」时身份链
 *   结束：该记录照常判定，更早记录不再命中且源标记耗尽；
 * - followCopies 下 ancestor-filter / copyfrom 源在回包中发现复制点时
 *   压入 copyfrom 来源源（初始 cursor=copyfromRev）。
 * 返回已处理条数与新增命中 revision 数。
 */
export function applyHistoryLogPage(
  session: HistorySession,
  target: HistoryTarget,
  page: HistoryLogPage,
  options: { limits?: HistoryLimits; filter?: HistoryFilter } = {},
): { processed: number; newMatches: number } {
  const limits = options.limits ?? DEFAULT_HISTORY_LIMITS;
  const source = session.sources.find((candidate) => candidate.id === page.sourceId);
  if (source === undefined) {
    return { processed: 0, newMatches: 0 };
  }
  const budgetRemaining = Math.max(0, limits.rawBudgetPerLoad - session.rawFetchedInLoad);
  const take = Math.min(page.entries.length, budgetRemaining);
  const processedEntries = page.entries.slice(0, take);
  const trackedPath = source.pathFilter ?? target.relativePath;
  let newMatches = 0;
  let chainEnded = false;
  /** 身份链终止前已处理的记录：复制点只应在这部分里找。 */
  const identityWindow: HistoryEntry[] = [];
  for (const entry of processedEntries) {
    session.rawFetchedInLoad += 1;
    session.rawFetchedTotal += 1;
    source.scannedRaw += 1;
    session.scannedThisLoad.add(entry.revision);
    session.scannedRevisionIds.add(entry.revision);
    // 作者下拉口径：原始批次中出现的全部作者，未命中身份的提交
    // 同样计入（它们确实被扫描过），按首次出现顺序追加。
    recordScannedAuthor(session, entry.author);
    if (chainEnded) {
      // 更早 revision 属于另一个身份：仍算原始回包/扫描，但不进入历史。
      continue;
    }
    identityWindow.push(entry);
    const matched = source.kind === 'target'
      || revisionMatchesHistoryTrackedPath(entry, trackedPath, target.kind);
    if (matched) {
      const existing = session.entriesByRevision.get(entry.revision);
      if (existing === undefined) {
        session.entriesByRevision.set(entry.revision, entry);
        newMatches += 1;
      } else {
        existing.paths = unionHistoryPaths(existing.paths, entry.paths);
      }
    }
    if (source.kind !== 'target' && entryEndsIdentityChain(entry, trackedPath)) {
      chainEnded = true;
    }
  }
  if (chainEnded) {
    source.exhausted = true;
  }
  if (processedEntries.length > 0) {
    const lastRevision = processedEntries[processedEntries.length - 1].revision;
    source.cursor = lastRevision - 1;
    if (source.cursor < 1) {
      source.exhausted = true;
    }
  }
  // 源结束判定：空回包；或服务端返回数小于请求数且整页都被处理
  // （预算截断说明还有未处理记录，下一轮从 cursor 继续，不能判结束）。
  if (page.entries.length === 0) {
    source.exhausted = true;
  } else if (page.entries.length < page.requestedLimit && take === page.entries.length) {
    source.exhausted = true;
  }
  // 复制边界：ancestor-filter / copyfrom 源在跟随模式下遇到复制点压入来源源。
  if (session.followCopies && source.kind !== 'target' && identityWindow.length > 0) {
    const copy = findCopySource(identityWindow, trackedPath, target.kind);
    if (copy !== undefined) {
      const duplicate = session.sources.some((candidate) =>
        candidate.kind === 'copyfrom'
        && candidate.pegRevision === copy.copyRevision
        && candidate.pathFilter === normalizeRepoPath(copy.pathFilter));
      if (!duplicate) {
        const copyCount = session.sources.filter((candidate) => candidate.kind === 'copyfrom').length;
        session.sources.push(createCopyfromSource({
          id: `copyfrom-${copyCount + 1}`,
          target,
          queryPath: copy.queryPath,
          pathFilter: copy.pathFilter,
          copyRevision: copy.copyRevision,
        }));
      }
    }
  }
  refreshVisibleEntries(session, options.filter ?? {});
  updateHistoryDerivedCounters(session);
  return { processed: take, newMatches };
}

/**
 * 结束一轮“加载更多”：按当前筛选刷新可见列表，展示前缀最多推进
 * historyPageSize 条经过筛选的归并记录，再检查上限并重算派生计数。
 */
export function finishHistoryLoadMore(
  session: HistorySession,
  options: { pageSize: number; filter?: HistoryFilter; limits?: HistoryLimits } = { pageSize: DEFAULT_HISTORY_PAGE_SIZE },
): void {
  const limits = options.limits ?? DEFAULT_HISTORY_LIMITS;
  refreshVisibleEntries(session, options.filter ?? {});
  session.displayedCount = Math.min(
    session.displayedCount + options.pageSize,
    session.visibleEntries.length,
  );
  checkHistoryLimits(session, limits);
  updateHistoryDerivedCounters(session);
}

// ---------------------------------------------------------------------------
// resetHistorySession 与 refreshHistoryUpper
// ---------------------------------------------------------------------------

/**
 * 清空当前目标的历史会话并重读首批（冻结意图）：
 * - 保留已解析的 upperRevision/upperSource/headState 与 followCopies；
 * - 清 source 栈、entriesByRevision/visibleEntries、scannedRevisionIds、
 *   rawFetchedTotal/rawFetchedInLoad、scannedThisLoad、displayedCount、
 *   historyLimitState，全部计数归零；
 * - upperSource='unresolved' 时拒绝（返回 false，不改任何状态）。
 * 返回 true 时调用方负责重建初始源（按同一 upperRevision）并重读首批；
 * 读请求代次递增由宿主完成。
 */
export function resetHistorySession(session: HistorySession): boolean {
  if (session.upperSource === 'unresolved') {
    return false;
  }
  clearHistorySessionData(session);
  return true;
}

/** refreshHistoryUpper 协议层只接受的两个 mode。 */
export type HistoryUpperRefreshMode = 'head' | 'base-fallback';

/** refreshHistoryUpper 运行时校验的拒绝原因。 */
export type HistoryUpperRefreshRejection =
  | 'invalid-mode'
  | 'snapshot-source'
  | 'source-live-head'
  | 'head-available'
  | 'not-local-target';

export type HistoryUpperRefreshCheck =
  | { ok: true; mode: HistoryUpperRefreshMode }
  | { ok: false; reason: HistoryUpperRefreshRejection };

/**
 * refreshHistoryUpper 的运行时能力校验（Webview 不渲染按钮不能替代）：
 * - 非法 mode 拒绝（协议层白名单之外的枚举在解析层就应拒绝）；
 * - snapshot 会话不刷新 HEAD；
 * - mode='head'：unresolved/live-head/base-fallback 可用；
 * - mode='base-fallback'：仅本地目标、已有 BASE、headState='unavailable'
 *   且 upperSource 为 unresolved/base-fallback 时可用。
 * 拒绝时不得触发 HEAD/info/log 命令，保持原会话。
 */
export function canRefreshHistoryUpper(
  session: HistorySession,
  mode: string,
  capabilities: { hasLocalBase: boolean },
): HistoryUpperRefreshCheck {
  if (mode !== 'head' && mode !== 'base-fallback') {
    return { ok: false, reason: 'invalid-mode' };
  }
  if (session.upperSource === 'snapshot') {
    return { ok: false, reason: 'snapshot-source' };
  }
  if (mode === 'head') {
    return { ok: true, mode };
  }
  if (session.upperSource === 'live-head') {
    return { ok: false, reason: 'source-live-head' };
  }
  if (session.headState !== 'unavailable') {
    return { ok: false, reason: 'head-available' };
  }
  if (!capabilities.hasLocalBase) {
    return { ok: false, reason: 'not-local-target' };
  }
  return { ok: true, mode };
}

/**
 * 应用一次成功的 upper 刷新（失败时调用方不调用本函数，三字段与已加载
 * 数据保持不变）：
 * - mode='head'：原来源为 live-head 且 revision 未变 → 'up-to-date'，
 *   保留已加载数据；否则更新为 live-head/available 并清历史数据重读
 *   （unresolved/base-fallback 只要 HEAD 解析成功就恢复 live-head，
 *   即使数值等于 BASE 也属于来源恢复）；
 * - mode='base-fallback'：更新 upperRevision=BASE、固定
 *   upperSource='base-fallback'/headState='unavailable' 并清历史数据。
 * 两者都保留 target/filter/follow（target/filter 由调用方持有）。
 */
export function applyHistoryUpperRefresh(
  session: HistorySession,
  mode: HistoryUpperRefreshMode,
  revision: number,
): 'updated' | 'up-to-date' {
  if (mode !== 'head' && mode !== 'base-fallback') {
    // 运行时防御：协议层之外传入的非法枚举不得按 head/base-fallback 分支执行。
    throw new Error(`非法 history upper 刷新模式：${String(mode)}`);
  }
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error(`非法历史 upperRevision：${String(revision)}`);
  }
  if (mode === 'head') {
    if (session.upperSource === 'live-head' && session.upperRevision === revision) {
      return 'up-to-date';
    }
    session.upperRevision = revision;
    session.upperSource = 'live-head';
    session.headState = 'available';
    clearHistorySessionData(session);
    return 'updated';
  }
  session.upperRevision = revision;
  session.upperSource = 'base-fallback';
  session.headState = 'unavailable';
  clearHistorySessionData(session);
  return 'updated';
}

// ---------------------------------------------------------------------------
// revision 节点解析（实际节点映射与 notFoundAtRevision）
// ---------------------------------------------------------------------------

/** 在复制窗口中解析一层映射的结果。 */
export type HistoryPathMapping =
  | { kind: 'copy'; sourcePath: string; sourceRevision: number }
  | { kind: 'same-revision'; revision: number }
  | { kind: 'deleted'; revision: number }
  | { kind: 'unknown' };

/**
 * 在已加载复制窗口中为「路径 + 所选 revision」解析一层实际位置：
 * 1. 同 revision 发生覆盖该路径的 A/R 复制 → 使用新路径（same-revision）；
 * 2. 由新到旧找覆盖该路径的 A/R 复制记录：复制晚于所选 revision 时，
 *    把相对后缀带到 copyfrom-path 上并继续解析来源 revision；
 * 3. 没有复制可解释时，删除记录（D，含祖先目录被删）把该 revision
 *    解析为 deleted；
 * 4. 否则 unknown（无法覆盖，调用方返回 notFoundAtRevision）。
 * 调用方对来源路径继续 info，info 成功即止（嵌套复制逐层推进）。
 */
export function findRevisionPathMapping(
  entries: Iterable<HistoryEntry>,
  targetPath: string,
  kind: 'file' | 'dir',
  revision: number,
): HistoryPathMapping {
  const tracked = normalizeRepoPath(targetPath);
  interface CopyCandidate {
    path: string;
    copyfromPath: string;
    copyfromRevision: number;
    recordRevision: number;
  }
  const copies: CopyCandidate[] = [];
  let sameRevisionCopy = false;
  const deletes: number[] = [];
  for (const entry of entries) {
    for (const change of entry.paths) {
      const path = normalizeRepoPath(change.path);
      const covers = isAncestorOrSelf(path, tracked)
        && !(kind === 'dir' && tracked !== '/' && path.startsWith(`${tracked}/`));
      if (!covers) {
        continue;
      }
      if (change.action === 'D') {
        if (entry.revision <= revision) {
          deletes.push(entry.revision);
        }
        continue;
      }
      if (change.action !== 'A' && change.action !== 'R') {
        continue;
      }
      if (change.copyfromPath === undefined || change.copyfromRevision === undefined) {
        continue;
      }
      if (change.copyfromRevision < 1) {
        continue;
      }
      if (entry.revision === revision) {
        sameRevisionCopy = true;
        continue;
      }
      copies.push({
        path,
        copyfromPath: normalizeRepoPath(change.copyfromPath),
        copyfromRevision: change.copyfromRevision,
        recordRevision: entry.revision,
      });
    }
  }
  if (sameRevisionCopy) {
    return { kind: 'same-revision', revision };
  }
  // 由新到旧；同深度更具体的复制目标优先（更近祖先 / 目标自身）。
  copies.sort((a, b) => (b.path.length - a.path.length) || (b.recordRevision - a.recordRevision));
  for (const candidate of copies) {
    if (candidate.recordRevision > revision) {
      const suffix = candidate.path === tracked ? '' : tracked.slice(candidate.path.length);
      return {
        kind: 'copy',
        sourcePath: `${candidate.copyfromPath}${suffix}`,
        sourceRevision: candidate.copyfromRevision,
      };
    }
  }
  if (deletes.length > 0) {
    deletes.sort((a, b) => b - a);
    return { kind: 'deleted', revision: deletes[0] };
  }
  return { kind: 'unknown' };
}

/**
 * 实际节点解析结果：present(url) / absent(deleted) / notFoundAtRevision。
 * present.repositoryPath 与 HistoryTarget.relativePath 同契约：仓库相对
 * POSIX 路径，无前导斜杠（'' 表示仓库根），中文/空格/@ 为未编码原文。
 */
export type HistoryNodeResolution =
  | { status: 'present'; repositoryPath: string; url: string; revision: number }
  | { status: 'absent'; deletedRevision?: number }
  | { status: 'notFoundAtRevision' };

export interface ResolveHistoryNodeParams {
  target: HistoryTarget;
  /** 用户在历史列表中选择的 revision。 */
  revision: number;
  /** 已加载历史（复制窗口）：提供复制点与删除记录，供 absent 后逐层解析。 */
  entries: Iterable<HistoryEntry>;
}

/** XML 实体单遍解码（一次解码：`&amp;lt;` 保持 `&lt;`，不二次解码）。 */
function decodeXmlEntitiesOnce(text: string): string {
  return text.replace(
    /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g,
    (entity) => {
      switch (entity) {
        case '&amp;':
          return '&';
        case '&lt;':
          return '<';
        case '&gt;':
          return '>';
        case '&quot;':
          return '"';
        case '&apos;':
          return "'";
        default: {
          const hex = /^&#x([0-9a-fA-F]+);$/.exec(entity);
          if (hex !== null) {
            return String.fromCodePoint(parseInt(hex[1], 16));
          }
          const dec = /^&#(\d+);$/.exec(entity);
          return dec !== null ? String.fromCodePoint(Number(dec[1])) : entity;
        }
      }
    },
  );
}

/** info XML 中的 URL（实体解码一次）；缺失返回 undefined。 */
function parseInfoUrl(xml: string): string | undefined {
  const match = /<url>([\s\S]*?)<\/url>/.exec(xml);
  if (match === null) {
    return undefined;
  }
  return decodeXmlEntitiesOnce(match[1]);
}

/**
 * info 路径不存在判定：`W170000` + `E200009` 且 stdout
 * 为合法空骨架（无 <entry>）。单独 E200009、E160013 或
 * E170013+E215004/E175013/网络错误都不是 absent 证据。
 * W170000 是警告码（W 前缀），extractSvnErrorCodes 只收集 E 码，这里
 * 单独提取。
 */
function isInfoAbsent(result: RunResult): boolean {
  const warningCodes = [...result.stderr.matchAll(/\bW\d{6}\b/g)].map((match) => match[0]);
  const codes = extractSvnErrorCodes(result.stderr);
  return warningCodes.includes('W170000')
    && codes.includes('E200009')
    && !/<entry\b/.test(result.stdout);
}

/**
 * 解析「历史 revision 的实际节点」：
 * 1. 先对当前路径执行 `svn info --xml <url>@<revision>`，成功即 present；
 * 2. 仅当失败被分类为 absent（W170000+E200009+空 entry）时，在复制窗口
 *    中逐层解析（嵌套复制继续对来源 revision info）；
 * 3. 复制在所选 revision 本身发生时使用新路径；所选 revision 早于复制
 *    时切换到 copyfrom 来源；删除记录解析为 absent；
 * 4. 无法覆盖目标 revision 时返回 notFoundAtRevision，不拿删除后的 URL
 *    读取内容，也不静默猜测来源。
 * 非 absent 的 info 失败原样抛出（auth/permission/network/error 不进入
 * 删除历史推定）。
 */
export async function resolveHistoryNodeAtRevision(
  svnPath: string,
  params: ResolveHistoryNodeParams,
  options: RunOptions = {},
): Promise<HistoryNodeResolution> {
  const entries = [...params.entries];
  let path = normalizeRepoPath(params.target.relativePath);
  let revision = params.revision;
  const visited = new Set<string>();
  for (let hop = 0; hop < 64; hop += 1) {
    const key = `${path}@${revision}`;
    if (visited.has(key)) {
      return { status: 'notFoundAtRevision' };
    }
    visited.add(key);
    const url = urlForRepositoryPath(params.target.repositoryRootUrl, path);
    const args = ['info', '--xml', '--non-interactive', '--', urlWithPeg(url, revision)];
    // 认证失败（E170001/E215004）必须经统一补录原语：options.getCredentials
    // 由宿主注入，失效凭据时弹补录框并重试一次。runner 显式传模块内 run
    // （保持测试对 run 的替身注入）；命令结果另存，absent（W170000+E200009
    // + 空骨架）是业务结果，不是命令失败。
    let lastResult: RunResult | undefined;
    let result: RunResult | undefined;
    try {
      result = await runOrThrowWithRunner(svnPath, args, options, async (runnerPath, runnerArgs, runnerOptions = {}) => {
        lastResult = await run(runnerPath, runnerArgs, runnerOptions);
        return lastResult;
      });
    } catch (err) {
      if (!(err instanceof SvnError) || lastResult === undefined || !isInfoAbsent(lastResult)) {
        // 非 absent 错误（认证/权限/网络/revision 不存在等）原样抛出。
        throw err;
      }
    }
    if (result !== undefined) {
      return {
        status: 'present',
        repositoryPath: toHistoryRelativePath(path),
        url: parseInfoUrl(result.stdout) ?? url,
        revision,
      };
    }
    const mapping = findRevisionPathMapping(entries, path, params.target.kind, revision);
    if (mapping.kind === 'copy') {
      path = mapping.sourcePath;
      revision = mapping.sourceRevision;
      continue;
    }
    if (mapping.kind === 'same-revision') {
      // 复制解析步骤 4：复制在该 revision 本身发生时使用新路径。
      return { status: 'present', repositoryPath: toHistoryRelativePath(path), url, revision };
    }
    if (mapping.kind === 'deleted') {
      return { status: 'absent', deletedRevision: mapping.revision };
    }
    return { status: 'notFoundAtRevision' };
  }
  return { status: 'notFoundAtRevision' };
}

// ---------------------------------------------------------------------------
// 结果分类
// ---------------------------------------------------------------------------

/** 历史上层结果分类（ready/noMatch 之上区分 empty 与 notFound）。 */
export type HistoryOutcome = 'ready' | 'empty' | 'noMatch' | 'notFound';

/**
 * 结果分类：
 * - 已加载命中且当前筛选有可见记录 → ready；
 * - 已加载命中但筛选零匹配 → noMatch（不是 empty）；
 * - 尚无命中且仍有可扫描源 → ready（页面显示“已扫描 N 条，暂无匹配”）；
 * - 源耗尽仍无命中：目标在 upperRevision 存在 → empty；不存在
 *   （ancestor-filter 严格规则 HITS 为空）→ notFound。
 */
export function classifyHistoryOutcome(
  session: HistorySession,
  options: { targetPresentAtUpper: boolean },
): HistoryOutcome {
  if (session.entriesByRevision.size > 0) {
    return session.visibleMatched > 0 ? 'ready' : 'noMatch';
  }
  if (session.canFetchMore) {
    return 'ready';
  }
  return options.targetPresentAtUpper ? 'empty' : 'notFound';
}
