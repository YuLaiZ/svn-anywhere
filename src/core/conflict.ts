/**
 * 冲突扫描与归一化。core 模块，不依赖 vscode。
 *
 * 职责（M4 技术方案 §5.1 / §5.2，阶段 0 V4 实测回填）：
 * - `svn status --xml --ignore-externals` 的三判据候选识别
 *   （item=conflicted / props=conflicted / tree-conflicted=true）、
 *   external 边界防御过滤与 wc-locked 透出；
 * - 候选路径批量 `svn info --xml`（每批 ≤32）与逐项补偿（≤4 并发），
 *   保留非零退出时的 stdout 部分结果；
 * - info 冲突节点归一化：source-left/right 三值、辅助文件、树冲突
 *   added/replaced/deleted 三形态、entry revision 非数字容错、重复节点去重；
 * - 属性冲突三值（本地/基线/传入）判定与 svn: 保留属性 autoUnsupported；
 * - resolvedLedger 合并（真实扫描的新冲突永远优先于台账已解决状态）；
 * - 缺失/移动树路径的最近存在祖先 realpath + 分段后缀与分段范围判定。
 *
 * 不返回用户可见文案：错误以 SvnError / 语义枚举表达，文案由 host/i18n 提供。
 */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative as pathRelative, sep } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { SvnError, assertSuccess, extractSvnErrorCodes, tailText } from './errors';
import { run, runOrThrow, urlWithPeg, type RunOptions, type RunResult } from './svnCli';
import { isCompleteStatusXml, parseStatusXml, type StatusEntry } from './status';
import { escapePeg } from './workspace';

/** 冲突类型（技术方案 §5.1 ConflictRecord.kinds）。 */
export type ConflictKind = 'text' | 'property' | 'tree';

/** 内容类型：二进制冲突在 info 中仍是 type=text，必须靠 mime/NUL 分类。 */
export type ConflictContentKind = 'text' | 'binary' | 'unknown';

/** 辅助文件的通用角色：不假定文件名总是 .rOLDREV（技术方案 §5.1）。 */
export type ConflictArtifactRole = 'base' | 'mine' | 'incoming' | 'reject';

export interface ConflictArtifact {
  role: ConflictArtifactRole;
  /** 工作副本相对路径（POSIX 分隔）；无法相对化时保留原始形态。 */
  path: string;
  /** .r<rev> 绑定到该 revision；.mine/.prej 无。 */
  revision?: number;
}

/** 冲突一侧版本（info `<version side=...>`）。 */
export interface ConflictVersion {
  side: 'source-left' | 'source-right';
  kind: 'file' | 'dir' | 'none';
  pathInRepos?: string;
  reposUrl?: string;
  revision?: number;
}

export interface TreeConflictInfo {
  operation: string;
  kind: 'file' | 'dir' | 'unknown';
  reason: string;
  action: string;
  /** victim 路径（工作副本相对路径）。 */
  victim: string;
  sourceLeft?: ConflictVersion;
  sourceRight?: ConflictVersion;
}

/** 单个属性的三方值。 */
export interface PropertyValue {
  exists: boolean;
  /** 解码后的原始字节；不存在时为 undefined。 */
  value?: Buffer;
}

export interface PropertyConflictValue {
  name: string;
  local: PropertyValue;
  base: PropertyValue;
  incoming: PropertyValue;
  /** svn: 命名空间保留属性：计入属性冲突但批量不可自动应用。 */
  autoUnsupported: boolean;
}

/**
 * 统一冲突记录（技术方案 §5.1 冻结契约）。
 * 同一路径的文件与属性冲突合并为一条记录的多个 kinds；
 * 摘要按 kinds 项计数，不按路径数掩盖混合冲突。
 */
export interface ConflictRecord {
  /** 路径与冲突指纹的稳定哈希（sha1 hex），不含凭据。 */
  id: string;
  /** 工作副本相对路径（POSIX 分隔，'.' 表示根）。 */
  path: string;
  kinds: ConflictKind[];
  /** 更新后节点 BASE（entry revision）；非数字（树冲突 victim）时缺省。 */
  nodeBaseRevision?: number;
  /** 冲突基线（source-left revision），不是更新后节点 BASE。 */
  baselineRevision?: number;
  /** 传入（source-right revision）。 */
  incomingRevision?: number;
  contentKind: ConflictContentKind;
  artifacts: ConflictArtifact[];
  propertyConflicts?: PropertyConflictValue[];
  treeConflict?: TreeConflictInfo;
  /** 记录含属性冲突且全部为 svn: 保留属性时 true。 */
  autoUnsupported?: boolean;
}

/** 摘要按 kinds 项计数：text 含二进制；mixed 路径贡献 text+property 各一。 */
export interface ConflictSummary {
  text: number;
  property: number;
  tree: number;
  total: number;
}

/** status 冲突候选条目（三判据命中）。 */
export interface ConflictStatusEntry {
  path: string;
  item: string;
  props?: string;
  kind?: string;
  revision?: number;
  treeConflicted: boolean;
}

export interface ConflictStatusScan {
  entries: ConflictStatusEntry[];
  /** item=external 的边界路径（外部副本成员不进入本副本冲突列表）。 */
  externals: string[];
  /** 根条目 wc-locked="true"：整副本写限制信号。 */
  wcLocked: boolean;
}

/** info `<conflict>` / `<tree-conflict>` 的原始解析形态。 */
export interface InfoXmlVersion {
  side?: string;
  kind?: string;
  'path-in-repos'?: string;
  'repos-url'?: string;
  revision?: string | number;
}

export interface InfoXmlConflict {
  operation?: string;
  type?: string;
  version?: InfoXmlVersion[];
  'prev-base-file'?: string;
  'prev-wc-file'?: string;
  'cur-base-file'?: string;
  'prop-file'?: string;
}

export interface InfoXmlTreeConflict {
  operation?: string;
  kind?: string;
  reason?: string;
  victim?: string;
  action?: string;
  version?: InfoXmlVersion[];
}

export interface InfoXmlEntry {
  path?: string;
  revision?: string | number;
  kind?: string;
  url?: string;
  'relative-url'?: string;
  conflict?: InfoXmlConflict[];
  'tree-conflict'?: InfoXmlTreeConflict[];
}

/** 单节点 info 摘要（historyUpdate 回读复用）。 */
export interface NodeInfoSummary {
  path?: string;
  revision?: number;
  kind: 'file' | 'dir' | 'unknown';
  url?: string;
  relativeUrl?: string;
}

export interface NormalizeInfoOptions {
  /** 工作副本根：把 info 的绝对辅助文件/entry 路径相对化。 */
  wcRoot?: string;
  /** 辅助文件存在性校验（prop-file 偏差回退用）；缺省不校验磁盘。 */
  artifactExists?: (relPath: string) => boolean;
  /** 属性冲突三值（按工作副本相对路径），由 readPropertyConflictValues 提供。 */
  propertyValuesByPath?: Readonly<Record<string, PropertyConflictValue[]>>;
  /** 内容类型分类结果（按工作副本相对路径）；缺省 unknown。 */
  contentKindByPath?: Readonly<Record<string, ConflictContentKind>>;
}

/** 已解决台账项（P7 会话内存，不参与未解决计数）。 */
export interface ResolvedLedgerEntry {
  /** 与 ConflictRecord.id 同源的冲突指纹。 */
  fingerprint: string;
  path: string;
  kinds: ConflictKind[];
  strategy: string;
  operationId: string;
  resolvedAt: number;
}

/** 推迟项（只改变面板状态，按冲突指纹保留到同一会话）。 */
export interface PostponedConflictEntry {
  fingerprint: string;
  path: string;
  kinds: ConflictKind[];
}

export type ConflictRowStatus = 'unresolved' | 'resolved' | 'postponed';

/** 面板列表行：真实扫描 + 台账合并结果。 */
export interface ConflictListRow {
  key: string;
  path: string;
  kinds: ConflictKind[];
  status: ConflictRowStatus;
  record?: ConflictRecord;
  resolved?: ResolvedLedgerEntry;
}

export interface ConflictScanOptions extends RunOptions {
  /** 扫描范围（工作副本相对路径或 '.'）；默认整个工作副本根。 */
  scope?: string;
  /** 读取属性三值（默认 true；仅属性冲突路径触发额外只读命令）。 */
  readPropertyValues?: boolean;
  /** 内容类型分类（默认不探测，contentKind='unknown'）。 */
  classifyContent?: (relPath: string) => Promise<ConflictContentKind | undefined>;
  /** 进度：已完成候选数 / 候选总数。 */
  onProgress?: (completed: number, total: number) => void;
  /** 批量 info 每批路径数，默认 32（阶段 0 实测）。 */
  infoBatchSize?: number;
  /** 逐项补偿并发，默认 4。 */
  compensationConcurrency?: number;
}

export interface ConflictScanFailure {
  path: string;
  message: string;
}

export interface ConflictScanResult {
  records: ConflictRecord[];
  summary: ConflictSummary;
  externals: string[];
  wcLocked: boolean;
  /** 详情读取失败但 status 已报告冲突的候选路径。 */
  failures: ConflictScanFailure[];
}

/** svn 保留属性命名空间：计入属性冲突但批量不可自动应用。 */
export const RESERVED_PROPERTY_PREFIX = 'svn:';

/* ------------------------------------------------------------------ *
 * status 冲突候选
 * ------------------------------------------------------------------ */

function toOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** 三判据之一（技术方案 §5.1）：item=conflicted / props=conflicted / tree-conflicted=true。 */
function isConflictCandidate(entry: StatusEntry): boolean {
  return entry.wcStatus === 'conflicted'
    || entry.props === 'conflicted'
    || entry.treeConflicted === true;
}

/**
 * 解析 `svn status --xml --ignore-externals` 输出中的冲突候选。
 * 行解析统一由 core/status 承载（M4 增补 tree-conflicted/wc-locked），
 * 本函数只做冲突候选筛选与 external 边界过滤：
 * - 树冲突只认 tree-conflicted=true，item 可能为 added/replaced/deleted；
 * - external 边界单独收集：边界内的成员即便出现冲突也不属于本副本冲突列表
 *   （--ignore-externals 正常不输出内部条目，这里是防御性分段过滤）；
 * - 辅助文件（item=unversioned 等）不能反向当作冲突候选；
 * - 截断的 status XML 视为扫描整体失败（抛 SvnError），不解析残片。
 */
export function parseConflictStatusXml(xml: string): ConflictStatusScan {
  if (!isCompleteStatusXml(xml)) {
    throw new SvnError({
      message: 'svn status XML 不完整（遍历可能中断），不能解析残片',
      command: ['status', '--xml', '--ignore-externals'],
      stderr: tailText(xml),
      code: 'STATUS_XML_TRUNCATED',
    });
  }
  let parsed: ReturnType<typeof parseStatusXml>;
  try {
    parsed = parseStatusXml(xml);
  } catch {
    throw new SvnError({
      message: 'svn status XML 解析失败',
      command: ['status', '--xml', '--ignore-externals'],
      stderr: tailText(xml),
      code: 'STATUS_XML_PARSE',
    });
  }
  const entries: ConflictStatusEntry[] = [];
  let wcLocked = false;
  for (const entry of parsed.entries) {
    if (entry.wcLocked === true) {
      wcLocked = true;
    }
    if (!isConflictCandidate(entry)) {
      continue;
    }
    // external 边界内的成员即便出现冲突也不属于本副本冲突列表。
    if (isUnderExternalBoundary(entry.path, parsed.externals)) {
      continue;
    }
    entries.push({
      path: entry.path,
      item: entry.wcStatus,
      props: entry.props,
      kind: entry.kind,
      revision: entry.revision,
      treeConflicted: entry.treeConflicted === true,
    });
  }
  return { entries, externals: parsed.externals, wcLocked };
}

/**
 * 路径是否位于 external 边界内（按路径分段判定）：
 * `/a/b` 是 `/a/bc` 的边界外；边界自身也命中（边界条目不会成为候选，
 * 这里用于防御内部成员混入）。
 */
export function isUnderExternalBoundary(path: string, externals: readonly string[]): boolean {
  const normalized = normalizePosixPath(path);
  return externals.some((boundary) => {
    const root = normalizePosixPath(boundary);
    return normalized === root || normalized.startsWith(`${root}/`);
  });
}

/* ------------------------------------------------------------------ *
 * info XML
 * ------------------------------------------------------------------ */

const infoParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: false,
  htmlEntities: true,
  // 文本保持原文（属性值 "123" 不变 number；路径与 revision 由调用方容错）。
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name === 'entry' || name === 'conflict' || name === 'tree-conflict' || name === 'version',
});

/** 解析 `svn info --xml` 的 entry 列表；截断/异常输入返回已解析的部分条目。 */
export function parseInfoXml(xml: string): InfoXmlEntry[] {
  if (xml.trim() === '') {
    return [];
  }
  try {
    const parsed = infoParser.parse(xml) as {
      info?: { entry?: InfoXmlEntry | InfoXmlEntry[] };
    };
    const entry = parsed.info?.entry;
    if (entry === undefined) {
      return [];
    }
    return Array.isArray(entry) ? entry : [entry];
  } catch {
    return [];
  }
}

/** 单节点 info 摘要：entry revision 非数字（树冲突 victim）时 revision 缺省。 */
export function parseNodeInfoXml(xml: string): NodeInfoSummary | undefined {
  const entry = parseInfoXml(xml)[0];
  if (!entry) {
    return undefined;
  }
  return {
    path: entry.path,
    revision: toOptionalNumber(entry.revision),
    kind: entry.kind === 'file' || entry.kind === 'dir' ? entry.kind : 'unknown',
    url: entry.url,
    relativeUrl: entry['relative-url'],
  };
}

/** 读单个目标的 info XML；非零退出作为业务失败返回，不抛进程错误。 */
export async function readNodeInfo(
  svnPath: string,
  target: string,
  options: RunOptions = {},
): Promise<{ summary?: NodeInfoSummary; result: RunResult }> {
  const args = ['info', '--xml', '--non-interactive', '--', escapePeg(target)];
  const result = await run(svnPath, args, options);
  return {
    summary: result.exitCode === 0 ? parseNodeInfoXml(result.stdout) : undefined,
    result,
  };
}

/* ------------------------------------------------------------------ *
 * 路径归一化
 * ------------------------------------------------------------------ */

/** POSIX 归一化：统一分隔符、去掉 './' 前缀；'.' 保持。 */
export function normalizePosixPath(path: string): string {
  const unified = path.replace(/\\/g, '/');
  const parts: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (parts.length > 0) {
        parts.pop();
      }
      continue;
    }
    parts.push(segment);
  }
  return parts.length === 0 ? '.' : parts.join('/');
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * 把 info/status 的路径归一为工作副本相对路径（POSIX 分隔）：
 * 绝对路径先按 wcRoot（原值与 realpath 各试一次）相对化；越界绝对路径
 * 保留原值供展示。相对路径只做 POSIX 归一化（保留首尾空格名称）。
 */
export function toWcRelativePath(wcRoot: string, raw: string): string {
  const unified = raw.replace(/\\/g, '/');
  const isAbsolute = unified.startsWith('/') || /^[A-Za-z]:\//.test(unified);
  if (!isAbsolute) {
    return normalizePosixPath(unified);
  }
  for (const root of [wcRoot, safeRealpath(wcRoot)]) {
    const rel = pathRelative(root, unified);
    if (rel === '') {
      return '.';
    }
    if (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('../')) {
      return rel.split(sep).join('/');
    }
  }
  return unified;
}

/* ------------------------------------------------------------------ *
 * 归一化
 * ------------------------------------------------------------------ */

function parseVersion(raw: InfoXmlVersion | undefined): ConflictVersion | undefined {
  if (!raw) {
    return undefined;
  }
  const side = raw.side === 'source-left' || raw.side === 'source-right' ? raw.side : undefined;
  if (!side) {
    return undefined;
  }
  const kind = raw.kind === 'file' || raw.kind === 'dir' || raw.kind === 'none' ? raw.kind : 'none';
  return {
    side,
    kind,
    pathInRepos: typeof raw['path-in-repos'] === 'string' ? raw['path-in-repos'] : undefined,
    reposUrl: typeof raw['repos-url'] === 'string' ? raw['repos-url'] : undefined,
    revision: toOptionalNumber(raw.revision),
  };
}

function findVersion(conflict: InfoXmlConflict | InfoXmlTreeConflict, side: ConflictVersion['side']): ConflictVersion | undefined {
  // 同一 side 理论上只出现一次；取首个可解析值。
  for (const version of conflict.version ?? []) {
    if (version.side === side) {
      return parseVersion(version);
    }
  }
  return undefined;
}

function textArtifacts(
  conflict: InfoXmlConflict,
  wcRoot: string | undefined,
): ConflictArtifact[] {
  const artifacts: ConflictArtifact[] = [];
  const add = (role: ConflictArtifactRole, raw: string | undefined) => {
    if (!raw) {
      return;
    }
    const path = wcRoot ? toWcRelativePath(wcRoot, raw) : normalizePosixPath(raw);
    const revisionMatch = /\.r(\d+)$/.exec(path);
    artifacts.push({ role, path, revision: revisionMatch ? Number(revisionMatch[1]) : undefined });
  };
  add('base', conflict['prev-base-file']);
  add('mine', conflict['prev-wc-file']);
  add('incoming', conflict['cur-base-file']);
  return artifacts;
}

function propertyArtifacts(
  entryPath: string,
  conflict: InfoXmlConflict,
  wcRoot: string | undefined,
  artifactExists: ((relPath: string) => boolean) | undefined,
  /** 同 entry 文本冲突的 cur-base-file（混合路径 prop-file 偏差判定）。 */
  knownIncomingPaths: ReadonlySet<string>,
): ConflictArtifact[] {
  const raw = conflict['prop-file'];
  if (!raw) {
    return [];
  }
  const path = wcRoot ? toWcRelativePath(wcRoot, raw) : normalizePosixPath(raw);
  // 阶段 0 实测偏差：mixed 文本+属性冲突的 prop-file 指向 cur-base-file
  // （传入文件内容），磁盘上真正的属性拒绝文件是 <path>.prej。
  if (knownIncomingPaths.has(path)) {
    return [{ role: 'reject', path: `${entryPath}.prej` }];
  }
  // prop-file 形态校验：声明存在但磁盘缺失时回退 <path>.prej（目录属性
  // 冲突的 dir_conflicts.prej 若真实存在则保留原值）。
  if (artifactExists && !artifactExists(path)) {
    const fallback = `${entryPath}.prej`;
    if (artifactExists(fallback)) {
      return [{ role: 'reject', path: fallback }];
    }
  }
  return [{ role: 'reject', path }];
}

function conflictDedupeKey(type: string, conflict: InfoXmlConflict): string {
  const sides = (conflict.version ?? [])
    .map((v) => `${v.side ?? ''}:${v.kind ?? ''}:${v.revision ?? ''}:${v['path-in-repos'] ?? ''}`)
    .sort()
    .join('|');
  return [
    type,
    conflict.operation ?? '',
    sides,
    conflict['prev-base-file'] ?? '',
    conflict['prev-wc-file'] ?? '',
    conflict['cur-base-file'] ?? '',
    conflict['prop-file'] ?? '',
  ].join('\u0000');
}

/** 记录指纹：路径 + 结构信息（不放凭据、不放属性值内容）。 */
function computeConflictId(input: {
  path: string;
  kinds: ConflictKind[];
  nodeBaseRevision?: number;
  baselineRevision?: number;
  incomingRevision?: number;
  artifacts: ConflictArtifact[];
  propertyNames: string[];
  treeConflict?: TreeConflictInfo;
  operations: string[];
}): string {
  const artifacts = input.artifacts
    .map((a) => `${a.role}:${a.path}:${a.revision ?? ''}`)
    .sort()
    .join('|');
  const tree = input.treeConflict
    ? [
        input.treeConflict.operation,
        input.treeConflict.kind,
        input.treeConflict.reason,
        input.treeConflict.action,
        input.treeConflict.victim,
        input.treeConflict.sourceLeft?.revision ?? '',
        input.treeConflict.sourceRight?.revision ?? '',
      ].join(':')
    : '';
  const fingerprint = [
    input.path,
    input.kinds.join(','),
    input.nodeBaseRevision ?? '',
    input.baselineRevision ?? '',
    input.incomingRevision ?? '',
    artifacts,
    input.propertyNames.slice().sort().join(','),
    tree,
    input.operations.slice().sort().join(','),
  ].join('\u0000');
  return createHash('sha1').update(fingerprint).digest('hex');
}

function makeTreeConflictInfo(
  raw: InfoXmlTreeConflict,
  wcRoot: string | undefined,
): TreeConflictInfo {
  const victim = typeof raw.victim === 'string' ? raw.victim : '';
  return {
    operation: typeof raw.operation === 'string' ? raw.operation : '',
    kind: raw.kind === 'file' || raw.kind === 'dir' ? raw.kind : 'unknown',
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    action: typeof raw.action === 'string' ? raw.action : '',
    victim: wcRoot ? toWcRelativePath(wcRoot, victim) : normalizePosixPath(victim),
    sourceLeft: findVersion(raw, 'source-left'),
    sourceRight: findVersion(raw, 'source-right'),
  };
}

/**
 * 把 info 条目归一为统一冲突记录：
 * - entry revision 非数字（树冲突 victim 的 "Resource is not under version
 *   control."）只让 nodeBaseRevision 缺省，记录照常生成；
 * - 重复冲突节点按 type+operation+source 双侧+辅助文件去重（阶段 0 实测
 *   mixed 4 个节点收敛为 text/property 各一条，multi 的两个属性节点收敛为
 *   一条属性记录）；
 * - 同 entry 的文本与属性冲突合并为一条记录的两个 kinds；
 * - baselineRevision 取 source-left、incomingRevision 取 source-right，
 *   与 nodeBaseRevision（更新后 BASE）严格分离。
 */
export function normalizeConflictRecords(
  entries: readonly InfoXmlEntry[],
  options: NormalizeInfoOptions = {},
): ConflictRecord[] {
  const records: ConflictRecord[] = [];
  const { wcRoot, artifactExists } = options;
  for (const entry of entries) {
    const entryPath = wcRoot
      ? toWcRelativePath(wcRoot, entry.path ?? '')
      : normalizePosixPath(entry.path ?? '');
    const conflicts = entry.conflict ?? [];
    const treeConflicts = entry['tree-conflict'] ?? [];
    if (conflicts.length === 0 && treeConflicts.length === 0) {
      continue;
    }

    const kinds: ConflictKind[] = [];
    const artifacts: ConflictArtifact[] = [];
    const seenKeys = new Set<string>();
    const operations: string[] = [];
    let baselineRevision: number | undefined;
    let incomingRevision: number | undefined;
    // 混合路径的 prop-file 偏差：先收集同 entry 文本冲突的 cur-base-file。
    const knownIncomingPaths = new Set<string>();
    for (const conflict of conflicts) {
      if (conflict.type === 'text' && conflict['cur-base-file']) {
        knownIncomingPaths.add(wcRoot
          ? toWcRelativePath(wcRoot, conflict['cur-base-file'])
          : normalizePosixPath(conflict['cur-base-file']));
      }
    }
    for (const conflict of conflicts) {
      const type = conflict.type;
      if (type !== 'text' && type !== 'property') {
        continue;
      }
      const key = conflictDedupeKey(type, conflict);
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      if (conflict.operation) {
        operations.push(conflict.operation);
      }
      const left = findVersion(conflict, 'source-left');
      const right = findVersion(conflict, 'source-right');
      baselineRevision = baselineRevision ?? left?.revision;
      incomingRevision = incomingRevision ?? right?.revision;
      if (type === 'text') {
        if (!kinds.includes('text')) {
          kinds.push('text');
        }
        for (const artifact of textArtifacts(conflict, wcRoot)) {
          if (!artifacts.some((a) => a.role === artifact.role && a.path === artifact.path)) {
            artifacts.push(artifact);
          }
        }
      } else {
        if (!kinds.includes('property')) {
          kinds.push('property');
        }
        for (const artifact of propertyArtifacts(entryPath, conflict, wcRoot, artifactExists, knownIncomingPaths)) {
          if (!artifacts.some((a) => a.role === artifact.role && a.path === artifact.path)) {
            artifacts.push(artifact);
          }
        }
      }
    }

    let treeConflict: TreeConflictInfo | undefined;
    if (treeConflicts.length > 0) {
      kinds.push('tree');
      treeConflict = makeTreeConflictInfo(treeConflicts[0], wcRoot);
      for (const raw of treeConflicts) {
        if (raw.operation) {
          operations.push(raw.operation);
        }
      }
      if (baselineRevision === undefined) {
        baselineRevision = treeConflict.sourceLeft?.revision;
      }
      if (incomingRevision === undefined) {
        incomingRevision = treeConflict.sourceRight?.revision;
      }
    }

    if (kinds.length === 0) {
      continue;
    }
    const propertyConflicts = options.propertyValuesByPath?.[entryPath];
    const autoUnsupported = propertyConflicts !== undefined
      && propertyConflicts.length > 0
      && propertyConflicts.every((property) => property.autoUnsupported);
    const record: ConflictRecord = {
      id: computeConflictId({
        path: entryPath,
        kinds,
        nodeBaseRevision: toOptionalNumber(entry.revision),
        baselineRevision,
        incomingRevision,
        artifacts,
        propertyNames: propertyConflicts?.map((property) => property.name) ?? [],
        treeConflict,
        operations,
      }),
      path: entryPath,
      kinds,
      nodeBaseRevision: toOptionalNumber(entry.revision),
      baselineRevision,
      incomingRevision,
      contentKind: options.contentKindByPath?.[entryPath] ?? 'unknown',
      artifacts,
    };
    if (propertyConflicts !== undefined) {
      record.propertyConflicts = propertyConflicts;
    }
    if (treeConflict) {
      record.treeConflict = treeConflict;
    }
    if (autoUnsupported) {
      record.autoUnsupported = true;
    }
    records.push(record);
  }
  return records;
}

/* ------------------------------------------------------------------ *
 * 摘要与台账合并
 * ------------------------------------------------------------------ */

/** 摘要按 kinds 项计数（text 含二进制、property/tree 按记录项）。 */
export function summarizeConflicts(records: readonly ConflictRecord[]): ConflictSummary {
  const summary: ConflictSummary = { text: 0, property: 0, tree: 0, total: 0 };
  for (const record of records) {
    for (const kind of record.kinds) {
      summary[kind] += 1;
      summary.total += 1;
    }
  }
  return summary;
}

function overlaps(a: readonly ConflictKind[], b: readonly ConflictKind[]): boolean {
  return a.some((kind) => b.includes(kind));
}

/**
 * 合并真实扫描与 P7 会话 resolvedLedger：
 * - 真实扫描仍报告的同一路径 + 冲突类型（kinds 有交集）永远以未解决为准，
 *   台账不得覆盖外部产生的新冲突；
 * - 真实扫描未再报告、但台账记录的已解决项以 resolved 行补出；
 * - postponed 只作用于真实记录（指纹或路径+kinds 匹配），扫描不再报告时
 *   自然消失，不单独补行。
 */
export function mergeResolvedLedger(
  records: readonly ConflictRecord[],
  ledger: readonly ResolvedLedgerEntry[],
  postponed: readonly PostponedConflictEntry[] = [],
): ConflictListRow[] {
  const rows: ConflictListRow[] = [];
  const realKeys = new Set<string>();
  for (const record of records) {
    realKeys.add(record.path);
    const isPostponed = postponed.some((entry) => entry.fingerprint === record.id
      || (entry.path === record.path && overlaps(entry.kinds, record.kinds)));
    rows.push({
      key: record.id,
      path: record.path,
      kinds: [...record.kinds],
      status: isPostponed ? 'postponed' : 'unresolved',
      record,
    });
  }
  for (const entry of ledger) {
    const coveredByReal = records.some((record) => record.path === entry.path
      && overlaps(record.kinds, entry.kinds));
    if (coveredByReal) {
      // 真实新冲突优先：不输出 resolved 行，也不保留台账状态。
      continue;
    }
    if (realKeys.has(entry.path)) {
      continue;
    }
    rows.push({
      key: entry.fingerprint,
      path: entry.path,
      kinds: [...entry.kinds],
      status: 'resolved',
      resolved: entry,
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * 内容类型与属性三值
 * ------------------------------------------------------------------ */

/**
 * 内容类型分类（技术方案 §5.2）：MIME 非 text/* 或前 8 KiB 含 NUL 即二进制。
 * 二进制冲突在 info 中仍是 type=text 且无 prev-wc-file，不能由冲突 type 推断。
 */
export function classifyContentKind(input: {
  isDir?: boolean;
  mimeType?: string;
  headBytes?: Buffer;
}): ConflictContentKind {
  if (input.isDir) {
    return 'unknown';
  }
  const mime = input.mimeType?.trim();
  const hasHead = input.headBytes !== undefined;
  const hasNul = hasHead && input.headBytes!.includes(0);
  if (mime) {
    const isTextMime = /^text\//i.test(mime);
    if (!isTextMime) {
      return 'binary';
    }
    return hasNul ? 'binary' : 'text';
  }
  if (!hasHead) {
    return 'unknown';
  }
  return hasNul ? 'binary' : 'text';
}

const propertyParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: false,
  htmlEntities: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name === 'property' || name === 'target',
});

/**
 * 解析 `svn proplist --xml --verbose` 输出为 名称→原始字节。
 * `encoding="base64"` 的值经 base64 解码（含控制字符的值如 `YQFi` → a\x01b）；
 * 其余按 UTF-8 原文（尾随换行原样保留，写回必须字节一致）。
 */
export function parsePropertyValuesXml(xml: string): Record<string, Buffer> {
  const result: Record<string, Buffer> = {};
  if (xml.trim() === '') {
    return result;
  }
  let parsed: {
    properties?: {
      target?: Array<{
        property?: Array<{ name?: string; encoding?: string; '#text'?: string }>;
      }>;
    };
  };
  try {
    parsed = propertyParser.parse(xml) as typeof parsed;
  } catch {
    return result;
  }
  for (const target of parsed.properties?.target ?? []) {
    for (const property of target.property ?? []) {
      if (typeof property.name !== 'string') {
        continue;
      }
      const text = typeof property['#text'] === 'string' ? property['#text'] : '';
      if (property.encoding === 'base64') {
        result[property.name] = Buffer.from(text.replace(/\s+/g, ''), 'base64');
      } else {
        result[property.name] = Buffer.from(text, 'utf8');
      }
    }
  }
  return result;
}

function propertyValue(map: Readonly<Record<string, Buffer>>, name: string): PropertyValue {
  const value = map[name];
  return value === undefined ? { exists: false } : { exists: true, value };
}

function samePropertyValue(a: PropertyValue, b: PropertyValue): boolean {
  if (a.exists !== b.exists) {
    return false;
  }
  if (!a.exists) {
    return true;
  }
  return (a.value ?? Buffer.alloc(0)).equals(b.value ?? Buffer.alloc(0));
}

/**
 * 属性冲突三值判定（技术方案 §5.2）：候选名取本地/基线/传入并集，只保留
 * local != base、incoming != base、local != incoming 三项同时成立的属性；
 * 只有一侧变化或两侧变成本地均不误列。svn: 保留属性带 autoUnsupported。
 */
export function classifyPropertyConflicts(
  local: Readonly<Record<string, Buffer>>,
  base: Readonly<Record<string, Buffer>>,
  incoming: Readonly<Record<string, Buffer>>,
): PropertyConflictValue[] {
  const names = new Set<string>([...Object.keys(local), ...Object.keys(base), ...Object.keys(incoming)]);
  const conflicts: PropertyConflictValue[] = [];
  for (const name of [...names].sort()) {
    const localValue = propertyValue(local, name);
    const baseValue = propertyValue(base, name);
    const incomingValue = propertyValue(incoming, name);
    const differsFromBase = !samePropertyValue(localValue, baseValue);
    const incomingDiffersFromBase = !samePropertyValue(incomingValue, baseValue);
    const localDiffersFromIncoming = !samePropertyValue(localValue, incomingValue);
    if (!(differsFromBase && incomingDiffersFromBase && localDiffersFromIncoming)) {
      continue;
    }
    conflicts.push({
      name,
      local: localValue,
      base: baseValue,
      incoming: incomingValue,
      autoUnsupported: name.startsWith(RESERVED_PROPERTY_PREFIX),
    });
  }
  return conflicts;
}

function sideVersionUrl(version: ConflictVersion | undefined): string | undefined {
  if (!version || version.kind === 'none' || version.revision === undefined) {
    return undefined;
  }
  if (!version.reposUrl || version.pathInRepos === undefined) {
    return undefined;
  }
  const base = version.reposUrl.endsWith('/') ? version.reposUrl.slice(0, -1) : version.reposUrl;
  const rel = version.pathInRepos.replace(/^\/+/, '');
  return urlWithPeg(rel === '' ? base : `${base}/${rel}`, version.revision);
}

async function readPropertyMap(
  svnPath: string,
  args: string[],
  options: RunOptions,
): Promise<Record<string, Buffer> | undefined> {
  try {
    const result = await runOrThrow(svnPath, args, options);
    return parsePropertyValuesXml(result.stdout);
  } catch {
    // 属性值读取失败：该路径属性冲突不提供自动处理（§5.2）。
    return undefined;
  }
}

/**
 * 读取一条属性冲突记录的本地/基线/传入三值集合（技术方案 §5.2）：
 * 本地为当前路径工作属性，基线取 source-left 的 path-in-repos + revision，
 * 传入取 source-right。任一侧读取失败返回 undefined，调用方据此不提供
 * 自动处理；属性名集合不依赖 info 冲突节点（节点不携带属性名）。
 */
export async function readPropertyConflictValues(
  svnPath: string,
  wcRoot: string,
  entry: InfoXmlEntry,
  options: RunOptions = {},
): Promise<PropertyConflictValue[] | undefined> {
  const first = (entry.conflict ?? []).find((conflict) => conflict.type === 'property');
  if (!first) {
    return undefined;
  }
  const relativePath = toWcRelativePath(wcRoot, entry.path ?? '');
  const local = await readPropertyMap(
    svnPath,
    ['proplist', '--xml', '--verbose', '--', escapePeg(relativePath)],
    { ...options, cwd: wcRoot },
  );
  if (!local) {
    return undefined;
  }
  const left = findVersion(first, 'source-left');
  const right = findVersion(first, 'source-right');
  const baseUrl = sideVersionUrl(left);
  const incomingUrl = sideVersionUrl(right);
  const base = left?.kind === 'none'
    ? {}
    : baseUrl
      ? await readPropertyMap(svnPath, ['proplist', '--xml', '--verbose', '--', baseUrl], options)
      : undefined;
  const incoming = right?.kind === 'none'
    ? {}
    : incomingUrl
      ? await readPropertyMap(svnPath, ['proplist', '--xml', '--verbose', '--', incomingUrl], options)
      : undefined;
  if (!base || !incoming) {
    return undefined;
  }
  return classifyPropertyConflicts(local, base, incoming);
}

export interface ConflictRecordReadOptions extends RunOptions {
  /** 读取属性三值（默认 true）：指纹与计划记录的属性名集合必须同口径。 */
  readPropertyValues?: boolean;
}

export interface ConflictRecordReadResult {
  /** 目标路径当前无冲突记录（已解决/非冲突路径）时缺省。 */
  record?: ConflictRecord;
  /** info 读取失败（回扫未知态依据）。 */
  error?: string;
}

/**
 * 读取单个工作副本路径的当前冲突记录（命令前指纹 / 命令后回读共用）：
 * 与本模块扫描使用同一归一化口径（含属性三值与辅助文件回退），保证
 * 指纹 id 在执行前后可直接比较。info 对已删除/移动树 victim 仍返回
 * entry；读取失败单独以 error 返回，不混同「无冲突」。
 */
export async function readConflictRecord(
  svnPath: string,
  wcRoot: string,
  relPath: string,
  options: ConflictRecordReadOptions = {},
): Promise<ConflictRecordReadResult> {
  const { readPropertyValues = true, ...runOptions } = options;
  const args = ['info', '--xml', '--non-interactive', '--', escapePeg(relPath)];
  const result = await run(svnPath, args, { cwd: wcRoot, ...runOptions });
  if (result.exitCode !== 0) {
    return { error: tailText(result.stderr.trim() || `svn info 退出码 ${result.exitCode}`) };
  }
  const target = toWcRelativePath(wcRoot, relPath);
  const entry = parseInfoXml(result.stdout)
    .find((candidate) => toWcRelativePath(wcRoot, candidate.path ?? '') === target);
  if (!entry) {
    return {};
  }
  const propertyValuesByPath: Record<string, PropertyConflictValue[]> = {};
  if (readPropertyValues && (entry.conflict ?? []).some((conflict) => conflict.type === 'property')) {
    const values = await readPropertyConflictValues(svnPath, wcRoot, entry, runOptions);
    if (values !== undefined) {
      propertyValuesByPath[target] = values;
    }
  }
  const records = normalizeConflictRecords([entry], {
    wcRoot,
    artifactExists: (candidate) => existsSync(join(wcRoot, ...candidate.split('/'))),
    propertyValuesByPath,
  });
  return { record: records[0] };
}

/* ------------------------------------------------------------------ *
 * realpath 与分段范围
 * ------------------------------------------------------------------ */
export interface RealPathResolution {
  /** 最近存在祖先的 realpath。 */
  realPath: string;
  /** 相对该祖先的路径分段（逐段保留原名称，不含分隔符）。 */
  suffix: string[];
}

/**
 * 缺失/移动树路径的 realpath 解析：不能直接对 victim realpath，向上找到
 * 最近存在祖先做 realpath，再拼回经校验的分段后缀。后缀只按路径分段保留，
 * 不做字符串前缀误判；任何分段为 '.'/'..' 时拒绝（越界防御）。
 */
export function resolveRealPathWithSuffix(fsPath: string): RealPathResolution | undefined {
  let current = fsPath;
  for (;;) {
    try {
      const realPath = realpathSync(current);
      if (!statSync(realPath).isDirectory() && current !== fsPath) {
        // 祖先必须是目录；文件不可能是目标的祖先。
        return undefined;
      }
      const relative = pathRelative(realPath, fsPath);
      const suffix = relative === '' ? [] : relative.split(sep);
      if (suffix.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        return undefined;
      }
      return { realPath, suffix };
    } catch {
      const next = dirname(current);
      if (next === current) {
        return undefined;
      }
      current = next;
    }
  }
}

/** 分段祖先判定：/a/b 包含 /a/b/c，但不包含 /a/bc。两侧须已 realpath 归一。 */
export function isWithinRealScope(scopeRealPath: string, targetRealPath: string): boolean {
  if (scopeRealPath === targetRealPath) {
    return true;
  }
  const relative = pathRelative(scopeRealPath, targetRealPath);
  if (relative === '' || relative === '..') {
    return false;
  }
  return !relative.startsWith(`..${sep}`) && !relative.startsWith('../') && !relative.startsWith('..\\');
}

/** 真实路径下某个工作副本相对路径的范围判定（缺失路径用最近存在祖先）。 */
export function isRelPathWithinScope(
  scopeRealPath: string,
  wcRoot: string,
  relPath: string,
): boolean {
  const resolution = resolveRealPathWithSuffix(join(wcRoot, ...relPath.split('/')));
  if (!resolution) {
    return false;
  }
  let target = resolution.realPath;
  if (resolution.suffix.length > 0) {
    target = join(target, ...resolution.suffix);
  }
  return isWithinRealScope(scopeRealPath, target);
}

/* ------------------------------------------------------------------ *
 * 扫描
 * ------------------------------------------------------------------ */

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function stripScanOptions(options: ConflictScanOptions): RunOptions {
  const { scope: _scope, readPropertyValues: _rpv, classifyContent: _cc, onProgress: _op, infoBatchSize: _ibs, compensationConcurrency: _ccn, ...runOptions } = options;
  return runOptions;
}

/**
 * 完整冲突扫描（技术方案 §5.1）：
 * 1. `status --xml --ignore-externals` 三判据取候选，external 边界防御过滤；
 * 2. 候选批量 `info --xml`（默认每批 32 条），`run()` 保留非零退出时的
 *    stdout，先解析已返回 entry；
 * 3. 未命中路径逐条补偿（默认 4 路并发），单条失败只影响该路径详情；
 * 4. 归一化摘要；属性冲突路径读取三值（默认开启）。
 *
 * status 遍历失败（exit 非零 / XML 截断）整次失败，不解析残片。
 */
export async function scanConflicts(
  svnPath: string,
  wcRoot: string,
  options: ConflictScanOptions = {},
): Promise<ConflictScanResult> {
  const runOptions = stripScanOptions(options);
  const scope = options.scope ?? '.';
  const statusArgs = ['status', '--xml', '--ignore-externals', '--', escapePeg(scope)];
  const statusResult = await run(svnPath, statusArgs, { cwd: wcRoot, ...runOptions });
  assertSuccess(statusResult, statusArgs, wcRoot);
  const statusScan = parseConflictStatusXml(statusResult.stdout);
  const total = statusScan.entries.length;
  let completed = 0;
  const progress = () => {
    completed += 1;
    options.onProgress?.(completed, total);
  };

  const batchSize = Math.max(1, options.infoBatchSize ?? 32);
  const concurrency = Math.max(1, options.compensationConcurrency ?? 4);
  const entriesByPath = new Map<string, InfoXmlEntry>();
  const failures: ConflictScanFailure[] = [];
  const pending: string[] = [];

  const remember = (entry: InfoXmlEntry | undefined): string | undefined => {
    if (!entry || entry.path === undefined) {
      return undefined;
    }
    const key = toWcRelativePath(wcRoot, entry.path);
    entriesByPath.set(key, entry);
    return key;
  };

  for (const batch of chunk(statusScan.entries, batchSize)) {
    const args = ['info', '--xml', '--non-interactive', '--', ...batch.map((entry) => escapePeg(entry.path))];
    const result = await run(svnPath, args, { cwd: wcRoot, ...runOptions });
    const entries = parseInfoXml(result.stdout);
    for (const entry of entries) {
      remember(entry);
    }
    for (const candidate of batch) {
      const key = toWcRelativePath(wcRoot, candidate.path);
      if (!entriesByPath.has(key)) {
        pending.push(candidate.path);
      } else {
        progress();
      }
    }
  }

  const queue = [...pending];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) {
        return;
      }
      const args = ['info', '--xml', '--non-interactive', '--', escapePeg(next)];
      let result: RunResult;
      try {
        result = await run(svnPath, args, { cwd: wcRoot, ...runOptions });
      } catch (err) {
        failures.push({ path: next, message: err instanceof Error ? err.message : String(err) });
        progress();
        continue;
      }
      const entry = parseInfoXml(result.stdout)[0];
      if (result.exitCode !== 0 || !entry) {
        failures.push({ path: next, message: tailText(result.stderr.trim() || `svn info 退出码 ${result.exitCode}`) });
      } else {
        remember(entry);
      }
      progress();
    }
  });
  await Promise.all(workers);

  // 按候选顺序排列条目（info 返回顺序不保证）。
  const orderedEntries: InfoXmlEntry[] = [];
  const seenPaths = new Set<string>();
  for (const candidate of statusScan.entries) {
    const key = toWcRelativePath(wcRoot, candidate.path);
    if (seenPaths.has(key)) {
      continue;
    }
    seenPaths.add(key);
    const entry = entriesByPath.get(key);
    if (entry) {
      orderedEntries.push(entry);
    }
  }

  const propertyValuesByPath: Record<string, PropertyConflictValue[]> = {};
  if (options.readPropertyValues !== false) {
    for (const entry of orderedEntries) {
      const hasProperty = (entry.conflict ?? []).some((conflict) => conflict.type === 'property');
      if (!hasProperty) {
        continue;
      }
      const values = await readPropertyConflictValues(svnPath, wcRoot, entry, runOptions);
      if (values !== undefined) {
        propertyValuesByPath[toWcRelativePath(wcRoot, entry.path ?? '')] = values;
      }
    }
  }

  const contentKindByPath: Record<string, ConflictContentKind> = {};
  const records = normalizeConflictRecords(orderedEntries, {
    wcRoot,
    artifactExists: (relPath) => existsSync(join(wcRoot, ...relPath.split('/'))),
    propertyValuesByPath,
  });
  if (options.classifyContent) {
    for (const record of records) {
      const kind = await options.classifyContent(record.path);
      if (kind) {
        contentKindByPath[record.path] = kind;
        record.contentKind = kind;
      }
    }
  }

  return {
    records,
    summary: summarizeConflicts(records),
    externals: statusScan.externals,
    wcLocked: statusScan.wcLocked,
    failures,
  };
}

/** 供 historyUpdate 等模块复用：从 svn info 错误文本判断目标缺失（非网络/认证）。 */
export function isAbsentInfoError(stderr: string): boolean {
  const codes = extractSvnErrorCodes(stderr);
  return codes.includes('E200009')
    || codes.includes('E160013')
    || /W170000|W160013/.test(stderr);
}
