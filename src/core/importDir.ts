/**
 * svn import 的 core 原语：源目录枚举与快照、目标 URL 构建与规范化、
 * 提交说明 hash、导入参数构建、开始前远端重检与结果核实（服务器侧证据
 * 三分类）。core 模块，不依赖 vscode；快照文件写入 globalStorageUri 等
 * 宿主职责不在本模块。
 *
 * 实测口径（svn 1.15，本地 file:// 仓库实验固化）：
 * - import 的目标 URL 不解析 peg 语法——原样传入（不追加尾 @、不做
 *   peg 转义），`…/a%40b` 创建目录 `a@b`；而核实用的 ls/info/log 支持
 *   peg，URL 必须走 escapeUrlPeg（含 %40 的 URL 不转义直接跑 info 报
 *   E205000「Syntax error parsing peg revision」）；
 * - 符号链接作为 kind="file"、prop-mods="true" 提交（计入核实期望文件
 *   集合）；空目录提交节点（不存在「空目录跳过」）；FIFO 等特殊节点
 *   import 报 E145000 exit 1；global-ignores 目录命中跳过整棵子树；
 * - 存储侧把说明中的 CRLF 规范化为 LF，svn log --xml 的 <msg> 是 LF
 *   形态（含尾换行；空说明是空文本）且 &、<、> 输出为 XML 实体；
 * - 父目录的 last-changed revision 随子节点创建/删除各递增一次。
 */
import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { escapeUrlPeg, encodeEditableURL, normalizeCheckoutUrl, schemeAcceptsCredentials } from './checkout';
import { SvnError, extractSvnErrorCodes, isAuthFailure } from './errors';
import { runOrThrow, type RunOptions } from './svnCli';
import { escapePeg } from './workspace';
import { matchesGlobalIgnores } from './svnConfig';

/** 快照 schema 版本（digest 输入含版本号，schema 演进时递增）。 */
export const IMPORT_SNAPSHOT_VERSION = 1;

// ---------------------------------------------------------------------------
// 源目录枚举
// ---------------------------------------------------------------------------

/** 条目类型：lstat 三分类之外的节点（FIFO、socket、块/字符设备等）。 */
export type ImportEntryKind = 'file' | 'dir' | 'symlink' | 'special';

/** 快照条目：path 为相对源目录的解码形态路径、分隔符 `/`。 */
export interface ImportSourceEntry {
  path: string;
  kind: ImportEntryKind;
  size: number;
  mtimeMs: number;
  /** global-ignores 命中（目录命中时整棵子树递归标注）。 */
  ignored: boolean;
  /** 不可读（readdir/lstat 失败或文件无读权限）——阻止导入。 */
  unreadable: boolean;
  /** 嵌套工作副本标志（子树出现 .svn）——阻止导入。 */
  nested: boolean;
  /** 不可导入节点：kind=special 或名称含控制字符——阻止导入。 */
  unsupported: boolean;
}

/** 枚举摘要：fileCount/totalBytes 只计 file|symlink 且 ignored=false 的条目。 */
export interface ImportSourceSummary {
  fileCount: number;
  totalBytes: number;
  /** kind='special' 条目数（单列，不与四类分列计数混用）。 */
  specialItemCount: number;
  symlinkCount: number;
  unreadableCount: number;
  nestedCount: number;
  unsupportedCount: number;
}

/** 存在任一即阻止勾选确认与开始的原因集合。 */
export type ImportBlockReason = 'unreadable' | 'nested' | 'unsupported';

export interface ImportEnumeration {
  entries: ImportSourceEntry[];
  /** 目录相对路径清单（含空目录、剔除 ignored；核实的目录子集断言以此为准）。 */
  dirs: string[];
  summary: ImportSourceSummary;
  /** 去重后的阻止原因（空数组 = 可导入）。 */
  blockers: ImportBlockReason[];
}

export interface EnumerateOptions {
  /** global-ignores 模式列表（通常来自 svnConfig.readSvnConfigGlobalIgnores）。 */
  ignorePatterns?: readonly string[];
}

/** 名称含控制字符（\u0000-\u001f、\u007f）——SVN 拒绝此类名称（与既有提交侧口径一致）。 */
function hasControlChar(name: string): boolean {
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function classifyKind(stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): ImportEntryKind {
  if (stats.isFile()) {
    return 'file';
  }
  if (stats.isDirectory()) {
    return 'dir';
  }
  if (stats.isSymbolicLink()) {
    return 'symlink';
  }
  return 'special';
}

/**
 * 递归枚举导入源目录（readdir + lstat，不跟随符号链接——链接自身以
 * kind='symlink' 单列）。标注规则：
 * - global-ignores 按 basename 匹配，目录命中时整棵子树递归标注
 *   ignored（与 import 实际跳过同口径）；ignored 子树内不再检测
 *   unreadable/nested/unsupported 与控制字符——这些条目不进导入集合，
 *   不影响「预览 = 实际」的完整性；
 * - 子树出现 .svn → 该条目标 nested 并阻止导入（保守拒绝，无法完整
 *   确认范围时不允许「跳过标注、全部列为将导入」）；.svn 内部不再深入；
 * - lstat 三分类之外的节点 → kind='special' + unsupported（实测 import
 *   对 FIFO 报 E145000 exit 1）；名称含控制字符的任意类型条目同样
 *   unsupported——存在任一 unsupported 即阻止，绝不「列为将导入、import
 *   才失败」也不静默跳过；
 * - 目录 readdir 失败 → unreadable；文件无读权限（access R_OK）→
 *   unreadable；符号链接不做读权限检测（import 只需 readlink）。
 *
 * 源目录自身不存在、不是目录或不可读时抛 Error（连「范围」都无法
 * 建立，由宿主呈现为预览失败）；源预检（是否已在工作副本内等 svn 侧
 * 形态）见 precheckImportSource，枚举器只负责标注。
 */
export function enumerateImportSource(sourceDir: string, options: EnumerateOptions = {}): ImportEnumeration {
  const patterns = options.ignorePatterns ?? [];
  let rootStats;
  try {
    rootStats = lstatSync(sourceDir);
  } catch (err) {
    throw new Error(`无法读取源目录 ${sourceDir}：${(err as Error).message}`);
  }
  if (!rootStats.isDirectory()) {
    throw new Error(`源路径不是目录：${sourceDir}`);
  }

  const entries: ImportSourceEntry[] = [];
  const dirs: string[] = [];

  /**
   * 递归枚举一层目录。dirEntry 是当前目录自身的条目（顶层为 undefined）：
   * readdir 失败时非 ignored 目录标注 unreadable 并停止深入（阻止导入），
   * 顶层不可读则连「范围」都无法建立、抛错由宿主呈现预览失败。
   */
  function walk(absDir: string, relDir: string, parentIgnored: boolean, dirEntry: ImportSourceEntry | undefined): void {
    let names: string[];
    try {
      names = readdirSync(absDir);
    } catch (err) {
      if (dirEntry === undefined) {
        throw new Error(`源目录不可读：${absDir}（${(err as Error).message}）`);
      }
      if (!parentIgnored) {
        dirEntry.unreadable = true;
      }
      return;
    }
    for (const name of names) {
      const rel = relDir === '' ? name : `${relDir}/${name}`;
      const ignored = parentIgnored || matchesGlobalIgnores(patterns, name);
      const absPath = join(absDir, name);
      let kind: ImportEntryKind = 'special';
      let size = 0;
      let mtimeMs = 0;
      let lstatFailed = false;
      try {
        const stats = lstatSync(absPath);
        kind = classifyKind(stats);
        size = stats.size;
        mtimeMs = stats.mtimeMs;
      } catch {
        // lstat 失败：无法分类，kind 以 special 占位；非 ignored 时标不可读。
        lstatFailed = true;
      }
      const entry: ImportSourceEntry = {
        path: rel,
        kind,
        size,
        mtimeMs,
        ignored,
        unreadable: false,
        nested: false,
        unsupported: false,
      };
      if (!ignored) {
        if (lstatFailed) {
          entry.unreadable = true;
        } else if (name === '.svn') {
          // 嵌套工作副本标志；.svn 内部是副本元数据，不属于导入语义，
          // 不再深入（其存在本身即阻止导入）。
          entry.nested = true;
        } else if (kind === 'special' || hasControlChar(name)) {
          entry.unsupported = true;
        } else if (kind === 'file') {
          try {
            accessSync(absPath, constants.R_OK);
          } catch {
            entry.unreadable = true;
          }
        }
      }
      entries.push(entry);
      if (kind === 'dir' && !entry.nested) {
        if (!ignored) {
          dirs.push(rel);
        }
        walk(absPath, rel, ignored, entry);
      }
    }
  }

  walk(sourceDir, '', false, undefined);

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  dirs.sort();

  let fileCount = 0;
  let totalBytes = 0;
  let specialItemCount = 0;
  let symlinkCount = 0;
  let unreadableCount = 0;
  let nestedCount = 0;
  let unsupportedCount = 0;
  const blockers = new Set<ImportBlockReason>();
  for (const entry of entries) {
    if ((entry.kind === 'file' || entry.kind === 'symlink') && !entry.ignored) {
      fileCount += 1;
      totalBytes += entry.size;
    }
    if (entry.kind === 'special') {
      specialItemCount += 1;
    }
    if (entry.kind === 'symlink') {
      symlinkCount += 1;
    }
    if (entry.unreadable) {
      unreadableCount += 1;
      blockers.add('unreadable');
    }
    if (entry.nested) {
      nestedCount += 1;
      blockers.add('nested');
    }
    if (entry.unsupported) {
      unsupportedCount += 1;
      blockers.add('unsupported');
    }
  }

  return {
    entries,
    dirs,
    summary: { fileCount, totalBytes, specialItemCount, symlinkCount, unreadableCount, nestedCount, unsupportedCount },
    blockers: [...blockers],
  };
}

/** 枚举结果 → 快照数据（快照 = 全量条目清单 + 目录清单，摘要不入快照）。 */
export function enumerationToSnapshot(enumeration: ImportEnumeration): ImportSnapshot {
  return { version: IMPORT_SNAPSHOT_VERSION, entries: enumeration.entries, dirs: enumeration.dirs };
}

// ---------------------------------------------------------------------------
// 源目录预检（工作副本形态判定）
// ---------------------------------------------------------------------------

export type ImportSourcePrecheck =
  /** 未受版本控制（副本内未纳管或不在任何副本内）——合法源目录。 */
  | { status: 'unversioned' }
  /** 自身是工作副本根或已被纳管（svn info 成功）——拒绝并提示改用提交功能。 */
  | { status: 'versioned' }
  /** 源路径不存在 / 不是目录。 */
  | { status: 'missing' | 'notDir'; message: string }
  /** svn 可执行缺失（提示指向 svnPath 配置）。 */
  | { status: 'svnMissing'; message: string }
  /** 其他失败（超时、wc.db 被锁等）——「未纳管」未被证明，阻止导入。 */
  | { status: 'unknown'; message: string };

/**
 * 源目录预检（只查源目录自身）：`svn info <源目录>` 成功返回 → 已纳管
 * 或副本根，拒绝；失败按错误码分层——E200009（副本内未纳管）与
 * E155007（不在任何工作副本内）都是「未版本控制」成立、放行（实测两种
 * 形态 exit 1 + 对应错误码）；spawn ENOENT、超时与其他失败 → 状态读
 * 取失败，不把读不出当未纳管。
 */
export async function precheckImportSource(
  svnPath: string,
  sourceDir: string,
  options: RunOptions = {},
): Promise<ImportSourcePrecheck> {
  let stats;
  try {
    stats = lstatSync(sourceDir);
  } catch (err) {
    return { status: 'missing', message: `源目录不存在：${(err as Error).message}` };
  }
  if (!stats.isDirectory()) {
    return { status: 'notDir', message: `源路径不是目录：${sourceDir}` };
  }
  const args = ['info', '--non-interactive', '--', escapePeg(sourceDir)];
  try {
    await runOrThrow(svnPath, args, options);
    return { status: 'versioned' };
  } catch (err) {
    if (!(err instanceof SvnError)) {
      return { status: 'unknown', message: err instanceof Error ? err.message : String(err) };
    }
    if (err.code === 'SPAWN_ERROR' || err.code === 'ENOENT') {
      return { status: 'svnMissing', message: err.message };
    }
    const codes = extractSvnErrorCodes(err.stderr);
    if (codes.includes('E200009') || codes.includes('E155007')) {
      return { status: 'unversioned' };
    }
    return { status: 'unknown', message: err.message };
  }
}

// ---------------------------------------------------------------------------
// 快照序列化与 digest
// ---------------------------------------------------------------------------

/** 快照数据（持久化 schema）：{ version, entries[], dirs[] }。 */
export interface ImportSnapshot {
  version: number;
  entries: ImportSourceEntry[];
  dirs: string[];
}

/** 规范化：entries 按 path 字典序、dirs 按 path 字典序、字段按声明序。 */
function canonicalSnapshot(snapshot: ImportSnapshot): ImportSnapshot {
  const sortedEntries = [...snapshot.entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      ignored: entry.ignored,
      unreadable: entry.unreadable,
      nested: entry.nested,
      unsupported: entry.unsupported,
    }));
  return { version: snapshot.version, entries: sortedEntries, dirs: [...snapshot.dirs].sort() };
}

/** 快照的规范化序列化文本（digest 的唯一输入形态，顺序固定）。 */
export function serializeSnapshot(snapshot: ImportSnapshot): string {
  return JSON.stringify(canonicalSnapshot(snapshot));
}

/** 快照 digest：规范化序列化文本的 UTF-8 字节 sha256（十六进制）。 */
export function snapshotDigest(snapshot: ImportSnapshot): string {
  return createHash('sha256').update(serializeSnapshot(snapshot), 'utf8').digest('hex');
}

export type SnapshotLoadFailure = 'invalidJson' | 'invalidSchema' | 'digestMismatch';

export type SnapshotLoadResult =
  | { ok: true; snapshot: ImportSnapshot }
  | { ok: false; reason: SnapshotLoadFailure; message: string };

const SNAPSHOT_KINDS = new Set<ImportEntryKind>(['file', 'dir', 'symlink', 'special']);

function isValidEntry(value: unknown): value is ImportSourceEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return typeof entry.path === 'string'
    && typeof entry.kind === 'string' && SNAPSHOT_KINDS.has(entry.kind as ImportEntryKind)
    && typeof entry.size === 'number' && Number.isFinite(entry.size)
    && typeof entry.mtimeMs === 'number' && Number.isFinite(entry.mtimeMs)
    && typeof entry.ignored === 'boolean'
    && typeof entry.unreadable === 'boolean'
    && typeof entry.nested === 'boolean'
    && typeof entry.unsupported === 'boolean';
}

/**
 * 读取快照文本并校验：JSON 可解析、字段符合 schema 形态；提供
 * expectedDigest 时对规范化序列化重算 digest 比对（仅篡改 dirs[] 而
 * entries 不动同样不匹配——目录清单参与 digest 输入）。校验通过返回
 * 规范化后的快照。
 */
export function loadSnapshot(text: string, expectedDigest?: string): SnapshotLoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: 'invalidJson', message: `快照不是合法 JSON：${(err as Error).message}` };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'invalidSchema', message: '快照根不是对象' };
  }
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.version !== 'number' || !Array.isArray(raw.entries) || !Array.isArray(raw.dirs)
    || !raw.entries.every(isValidEntry) || !raw.dirs.every((d): d is string => typeof d === 'string')) {
    return { ok: false, reason: 'invalidSchema', message: '快照字段不符合 { version, entries[], dirs[] } 形态' };
  }
  const snapshot = canonicalSnapshot(raw as unknown as ImportSnapshot);
  if (expectedDigest !== undefined && snapshotDigest(snapshot) !== expectedDigest) {
    return { ok: false, reason: 'digestMismatch', message: '快照内容与记录的摘要不一致（文件损坏或被篡改）' };
  }
  return { ok: true, snapshot };
}

// ---------------------------------------------------------------------------
// 目标 URL 构建
// ---------------------------------------------------------------------------

/**
 * 目标 URL 默认值：父 URL 末尾拼接 `encodeURIComponent(目录名)` 编码一次
 * 的源目录名（中文、@、空格、#、?、% 都编码；源目录名是单个目录名、
 * 不含 /）。产物中的 @ 为 %40——后续对它的 ls/info/log 必须走
 * escapeUrlPeg。父 URL 的尾斜杠先剥除。
 */
export function buildImportTargetUrl(parentUrl: string, sourceName: string): string {
  const parent = parentUrl.endsWith('/') ? parentUrl.slice(0, -1) : parentUrl;
  return `${parent}/${encodeURIComponent(sourceName)}`;
}

export type ImportTargetResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'scheme' | 'userinfo' | 'query' | 'fragment' | 'unencoded'; message: string };

/**
 * 导入目标 URL 的表单规范化（三步一体，不可拆开）：
 * 1. 编辑回写逆变换（非 ASCII 编回 %XX，复用检出侧 encodeEditableURL，
 *    不区分显示带出的中文与新输入的中文）；
 * 2. 导入专属规则：末尾字面 `@` 编码为 `%40`——import 目标原样传入不剥
 *    尾 @（svn 对 import 不解析 peg），而检查/核实 URL 走 escapeUrlPeg
 *    会剥单个尾 @，不编码会让两条路径指向不同节点；
 * 3. URL 校验（五种 scheme、authority 拒绝内嵌用户信息、query/fragment/
 *    未编码字符拒绝，复用检出侧校验器）。
 */
export function normalizeImportTarget(raw: string): ImportTargetResult {
  let url = encodeEditableURL(raw);
  if (url.endsWith('@')) {
    url = `${url.slice(0, -1)}%40`;
  }
  const result = normalizeCheckoutUrl(url);
  if (result.ok) {
    return { ok: true, url: result.url };
  }
  return { ok: false, reason: result.reason, message: result.message };
}

// ---------------------------------------------------------------------------
// 提交说明 hash（两侧同口径）
// ---------------------------------------------------------------------------

/** LF 归一视图：CRLF 与孤立 CR 都归一为 LF（存储侧同样把 CRLF 规范化为 LF）。 */
function normalizeLf(text: string): string {
  return text.replace(/\r\n|\r/g, '\n');
}

/**
 * 记录侧说明 hash：输入 = 实际写入 --file 临时文件的 UTF-8 字节的 LF
 * 归一视图（尾换行保留、不归一；空说明 = 空字节串）。归一只作用于 hash
 * 计算的视图，不改动写入临时文件的内容。
 */
export function messageDigest(message: string): string {
  return createHash('sha256').update(Buffer.from(normalizeLf(message), 'utf8')).digest('hex');
}

/**
 * 核实侧说明 hash：参数为 `svn log --xml` 经 XML 解析（实体解码）后的
 * <msg> 文本，按 UTF-8 重编码取字节、与记录侧同一 LF 归一口径计算
 * hash（实测 &、<、> 在 XML 输出中是 &amp;/&lt;/&gt;，按原始标记文本
 * 比较会漏判；CRLF 由归一吸收）。与 importIntent 记录的说明 hash 相等
 * 才算一致。
 */
export function verifyMessageFromXml(xmlMsgText: string): string {
  return createHash('sha256').update(Buffer.from(normalizeLf(xmlMsgText), 'utf8')).digest('hex');
}

// ---------------------------------------------------------------------------
// 导入参数构建（说明临时文件 + 目标 URL 原样）
// ---------------------------------------------------------------------------

/** 一次说明临时文件的产物（tempDir 供 removeMessageTempDir 清理）。 */
export interface ImportMessageTemp {
  tempDir: string;
  messageFile: string;
}

/**
 * 说明临时文件：创建 UTF-8 临时文件承载提交说明（多行/特殊字符不经
 * shell 与命令行编码问题），svn import 经 --file + --encoding UTF-8 读入。
 * 内容原样写入（说明 hash 的 LF 归一只作用于计算视图）。
 */
export function writeMessageTempFile(message: string): ImportMessageTemp {
  const tempDir = mkdtempSync(join(tmpdir(), 'svn-anywhere-import-'));
  const messageFile = join(tempDir, 'message.txt');
  writeFileSync(messageFile, message, 'utf8');
  return { tempDir, messageFile };
}

/** 删除一次说明临时文件产生的临时目录；失败静默（随系统清理）。 */
export function removeMessageTempDir(tempDir: string): void {
  rmSync(tempDir, { recursive: true, force: true });
}

/**
 * 导入命令参数：`svn import --non-interactive --file <说明文件>
 * --encoding UTF-8 <源目录> <目标URL>`。目标 URL 原样传入——不加尾 @、
 * 不做 peg 转义（实测 svn 对 import 目标不解析 peg，追加尾 @ 反而创建
 * 出以 @ 结尾的错误目录名）；源目录是本地路径，走本地路径 peg 转义。
 * 执行时必须传 timeoutMs=0（大目录导入是长任务，默认 120 秒超时会杀掉
 * 进程并被误判为失败；取消由调用方经 AbortSignal 承担）。
 */
export function buildImportArgs(targetUrl: string, sourceDir: string, messageFile: string): string[] {
  return [
    'import',
    '--non-interactive',
    '--file',
    messageFile,
    '--encoding',
    'UTF-8',
    escapePeg(sourceDir),
    targetUrl,
  ];
}

// ---------------------------------------------------------------------------
// svn 输出解析（父目录 info 与 log）
// ---------------------------------------------------------------------------

const importXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // 路径与说明的首尾空格属于内容，不能改变身份。
  trimValues: false,
  // 说明中的 &、<、> 输出为 XML 实体，解码一次。
  htmlEntities: true,
  isArray: (name) => name === 'entry' || name === 'logentry' || name === 'path',
});

/** 父目录身份快照（连接检查/重检定格，核实与重检的比对基准）。 */
export interface ParentIdentitySnapshot {
  repositoryUuid: string;
  repositoryRootUrl: string;
  /**
   * 快照锚点：最后一次远端确认目标不存在时的父目录 last-changed
   * revision（目录 revision 随子节点创建/删除递增；锚点之后递增即无法
   * 排除「目标创建后被外部删除」）。
   */
  lastChangedRevision: number;
}

/** `svn info --xml` 输出的父目录摘要（URL 目标；commit revision 为 last-changed）。 */
export interface ParentInfoSummary extends ParentIdentitySnapshot {
  kind: string;
}

interface InfoXmlEntry {
  kind?: string;
  repository?: { root?: string; uuid?: string };
  commit?: { revision?: string | number };
}

/** 解析 `svn info --xml` 输出取第一个 entry 的父目录摘要；字段缺失返回 undefined。 */
export function parseParentInfoXml(xml: string): ParentInfoSummary | undefined {
  const parsed = importXmlParser.parse(xml) as { info?: { entry?: InfoXmlEntry[] } };
  const entry = parsed.info?.entry?.[0];
  if (!entry) {
    return undefined;
  }
  const lastChanged = Number(entry.commit?.revision);
  const repositoryUuid = typeof entry.repository?.uuid === 'string' ? entry.repository.uuid : undefined;
  const repositoryRootUrl = typeof entry.repository?.root === 'string' ? entry.repository.root : undefined;
  if (repositoryUuid === undefined || repositoryRootUrl === undefined || !Number.isFinite(lastChanged)) {
    return undefined;
  }
  return {
    kind: entry.kind ?? '',
    repositoryUuid,
    repositoryRootUrl,
    lastChangedRevision: lastChanged,
  };
}

/** log 的单个 changed path（文本为仓库绝对路径的解码形态）。 */
export interface ImportLogPath {
  path: string;
  action: string;
  kind: string;
}

export interface ImportLogEntry {
  revision: number;
  message: string;
  paths: ImportLogPath[];
}

/** changed path 节点：属性与文本并存时文本在 #text 键（ignoreAttributes 形态）。 */
interface LogXmlPath {
  '#text'?: string;
  action?: string;
  kind?: string;
}

/** 解析 `svn log --xml -v` 输出取第一个 logentry；空说明是空文本。 */
export function parseImportLogXml(xml: string): ImportLogEntry | undefined {
  const parsed = importXmlParser.parse(xml) as { log?: { logentry?: Array<Record<string, unknown>> } };
  const entry = parsed.log?.logentry?.[0];
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }
  const revision = Number(entry.revision);
  if (!Number.isFinite(revision)) {
    return undefined;
  }
  const message = typeof entry.msg === 'string' ? entry.msg : '';
  const rawPaths = (entry.paths as { path?: LogXmlPath[] } | undefined)?.path ?? [];
  const paths = rawPaths
    .filter((p): p is LogXmlPath & { '#text': string } => typeof p?.['#text'] === 'string')
    .map((p) => ({ path: p['#text'], action: p.action ?? '', kind: p.kind ?? '' }));
  return { revision, message, paths };
}

/** 逐段 decodeURIComponent（失败段原样）：info 的编码形态与 log 的解码形态统一。 */
export function decodePathSegments(path: string): string {
  return path.split('/').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }).join('/');
}

/** 期望文件集合：快照 entries 中 file|symlink 且非 ignored 的相对路径（symlink 实测作为文件提交）。 */
export function expectedFilePathsFromSnapshot(snapshot: ImportSnapshot): Set<string> {
  return new Set(snapshot.entries
    .filter((entry) => (entry.kind === 'file' || entry.kind === 'symlink') && !entry.ignored)
    .map((entry) => entry.path));
}

// ---------------------------------------------------------------------------
// 远端命令的小封装（URL 走 peg 规则；凭据注入按协议分支）
// ---------------------------------------------------------------------------

function credentialedOptions(url: string, options: RunOptions): RunOptions {
  return schemeAcceptsCredentials(url) ? options : { ...options, getCredentials: undefined };
}

/** E200009：URL 目标不存在（ls 对不存在路径 W160013 + E200009、exit 1）。 */
function isUrlNotFound(err: SvnError): boolean {
  return extractSvnErrorCodes(err.stderr).includes('E200009') || err.stderr.includes('W160009');
}

async function runInfoXml(svnPath: string, url: string, options: RunOptions): Promise<ParentInfoSummary> {
  const result = await runOrThrow(svnPath, ['info', '--xml', '--non-interactive', '--', escapeUrlPeg(url)], credentialedOptions(url, options));
  const summary = parseParentInfoXml(result.stdout);
  if (!summary) {
    throw new SvnError({
      message: 'svn info --xml 输出无法解析父目录摘要',
      command: ['info', '--xml'],
      stderr: result.stdout,
      code: 'INFO_PARSE',
    });
  }
  return summary;
}

// ---------------------------------------------------------------------------
// 开始前远端重检（确认通过后、写命令前）
// ---------------------------------------------------------------------------

export type ImportRecheckFailure =
  /** 父目录不可达（网络/认证失败、被删除等）。 */
  | 'parentUnreachable'
  /** 父节点不是目录（URL 被换成文件节点）。 */
  | 'parentNotDir'
  /** 父目录 UUID/root 与身份快照不一致（relocate 或仓库重建）→ targetChanged。 */
  | 'identityChanged'
  /** 目标已存在 → targetChanged。 */
  | 'targetExists'
  /** 目标 ls 失败但非「不存在」（网络/认证等）——无法确认目标状态。 */
  | 'targetCheckFailed';

export type ImportRecheckResult =
  | { ok: true; parentIdentity: ParentIdentitySnapshot }
  | { ok: false; failure: ImportRecheckFailure; message: string };

/**
 * 开始前远端重检（命令顺序固定：先父 info、后目标 ls）。父目录 info
 * 校验 kind=dir、UUID/root 与身份快照一致（revision 不参与拦截——父目录
 * 的无关提交同样递增 revision，按其拦截导入是误拦）；目标 ls exit 0 =
 * 已存在（E200009 = 不存在，通过）。通过时把父目录 last-changed
 * revision 刷新为本次读取值返回（此刻是「最后一次远端确认目标不存在」
 * 的锚点，随 begin 定格）。
 */
export async function recheckImportTarget(
  svnPath: string,
  parentUrl: string,
  targetUrl: string,
  expected: ParentIdentitySnapshot,
  options: RunOptions = {},
): Promise<ImportRecheckResult> {
  let parent: ParentInfoSummary;
  try {
    parent = await runInfoXml(svnPath, parentUrl, options);
  } catch (err) {
    return { ok: false, failure: 'parentUnreachable', message: err instanceof Error ? err.message : String(err) };
  }
  if (parent.kind !== 'dir') {
    return { ok: false, failure: 'parentNotDir', message: '父路径不是目录' };
  }
  if (parent.repositoryUuid !== expected.repositoryUuid || parent.repositoryRootUrl !== expected.repositoryRootUrl) {
    return { ok: false, failure: 'identityChanged', message: '父目录仓库身份与记录不一致，请重新测试核对' };
  }
  try {
    await runOrThrow(svnPath, ['ls', '--non-interactive', '--', escapeUrlPeg(targetUrl)], credentialedOptions(targetUrl, options));
  } catch (err) {
    if (err instanceof SvnError && isUrlNotFound(err)) {
      return {
        ok: true,
        parentIdentity: {
          repositoryUuid: parent.repositoryUuid,
          repositoryRootUrl: parent.repositoryRootUrl,
          lastChangedRevision: parent.lastChangedRevision,
        },
      };
    }
    return { ok: false, failure: 'targetCheckFailed', message: err instanceof Error ? err.message : String(err) };
  }
  return { ok: false, failure: 'targetExists', message: '远端目标已存在，请返回修改 URL 重新测试核对' };
}

// ---------------------------------------------------------------------------
// 结果核实（服务器侧证据三分类）
// ---------------------------------------------------------------------------

export type ImportVerifyReason =
  /** 快照缺失/损坏/digest 不匹配——证据不足，不重建期望集合。 */
  | 'snapshotIncomplete'
  /** 目标 ls 失败且非「不存在」（网络/认证失败等）。 */
  | 'targetLsFailed'
  /** 父目录不可达或不存在（仓库结构已变化，无法区分「未提交」与「仓库已迁」）。 */
  | 'parentUnreachable'
  /** 父目录 UUID/root 与身份快照不一致。 */
  | 'parentIdentityChanged'
  /** 父目录 last-changed revision 超过快照锚点——无法排除「目标创建后被外部删除」。 */
  | 'parentRevisionAdvanced'
  /** 目标 last-changed revision 读取失败。 */
  | 'revisionReadFailed'
  /** svn log -r R --xml -v 读取失败。 */
  | 'logFailed'
  /** 说明 hash 与记录不一致（可能并发同名提交）。 */
  | 'msgMismatch'
  /** 目标根 action≠A 或不在 changed paths（目标已存在/内容被合并）。 */
  | 'rootNotAdded'
  /** kind=file 节点集合与期望文件集合不精确一致。 */
  | 'fileSetMismatch'
  /** kind=dir 节点不在快照目录清单中。 */
  | 'dirNotInSnapshot'
  /** 证据字段/XML 无法解析。 */
  | 'evidenceUnparsable';

export type ImportVerifyOutcome =
  | { kind: 'committed'; revision: number }
  | { kind: 'notCommitted'; evidence: { parentLastChangedRevision: number } }
  | { kind: 'unknown'; reason: ImportVerifyReason; message: string };

export interface ImportVerifyInput {
  /** 快照 JSON 文本（宿主从存储读出）；与 snapshot 二选一。 */
  snapshotText?: string;
  /** 已解析的快照对象。 */
  snapshot?: ImportSnapshot;
  /** 记录定格的快照 digest（importIntent.snapshotDigest）。 */
  expectedSnapshotDigest: string;
  /** 导入目标 URL（规范形态）。 */
  targetUrl: string;
  /** 父目录 URL。 */
  parentUrl: string;
  /** 记录定格的父目录身份快照。 */
  parentIdentity: ParentIdentitySnapshot;
  /** 记录定格的说明 hash（importIntent 的 messageDigest）。 */
  expectedMessageDigest: string;
}

function unknown(reason: ImportVerifyReason, message: string): ImportVerifyOutcome {
  return { kind: 'unknown', reason, message };
}

/**
 * 导入结果核实（服务器侧证据为主，不依赖客户端时钟时间窗；URL 一律走
 * escapeUrlPeg）。三分类：
 * - notCommitted：目标 ls 判不存在（E200009）后补查父目录仍存在、
 *   UUID/root 与快照一致、last-changed revision 与快照锚点一致——三项
 *   全过才确认（revision 递增 = 无法排除「导入成功后被外部删除再误判
 *   未提交」，保持 unknown）；
 * - committed：目标存在时父目录身份比对 → 取目标 last-changed
 *   revision R → svn log -r R --xml -v → 说明 hash 同口径比对 + changed
 *   paths 归一化（前缀两侧逐段解码、文件集合精确、目录子集、目标根须
 *   action="A"、期望集合从快照重建）全部通过；
 * - unknown：以上任一证据不唯一、不吻合或读取失败（带原因）。
 *
 * 证据命令与导入本体同属长任务收尾，调用方应传 timeoutMs=0。
 */
export async function verifyImportOutcome(
  svnPath: string,
  input: ImportVerifyInput,
  options: RunOptions = {},
): Promise<ImportVerifyOutcome> {
  // 第 0 步：快照完整性——digest 不匹配/缺失不重建期望集合、不冒充可核实。
  let snapshot: ImportSnapshot | undefined;
  if (input.snapshotText !== undefined) {
    const loaded = loadSnapshot(input.snapshotText, input.expectedSnapshotDigest);
    if (!loaded.ok) {
      return unknown('snapshotIncomplete', `导入快照不完整，无法核实：${loaded.message}`);
    }
    snapshot = loaded.snapshot;
  } else if (input.snapshot !== undefined) {
    if (snapshotDigest(input.snapshot) !== input.expectedSnapshotDigest) {
      return unknown('snapshotIncomplete', '导入快照不完整，无法核实：快照内容与记录的摘要不一致');
    }
    snapshot = input.snapshot;
  } else {
    return unknown('snapshotIncomplete', '导入快照不完整，无法核实：未提供快照');
  }

  // 第 1 步：目标存在性（ls 按退出码/错误码判定，已存在的空目录 exit 0）。
  let targetExists: boolean;
  try {
    await runOrThrow(svnPath, ['ls', '--non-interactive', '--', escapeUrlPeg(input.targetUrl)], credentialedOptions(input.targetUrl, options));
    targetExists = true;
  } catch (err) {
    if (!(err instanceof SvnError)) {
      return unknown('targetLsFailed', err instanceof Error ? err.message : String(err));
    }
    if (isUrlNotFound(err)) {
      targetExists = false;
    } else {
      return unknown('targetLsFailed', isAuthFailure(err.stderr) ? `认证失败，无法核实：${err.message}` : err.message);
    }
  }

  // 父目录身份读取（两条分支共用：notCommitted 的三项补查与 committed 的前置比对）。
  let parent: ParentInfoSummary;
  try {
    parent = await runInfoXml(svnPath, input.parentUrl, options);
  } catch (err) {
    return unknown('parentUnreachable', `父目录不可达，无法核实：${err instanceof Error ? err.message : String(err)}`);
  }
  if (parent.repositoryUuid !== input.parentIdentity.repositoryUuid
    || parent.repositoryRootUrl !== input.parentIdentity.repositoryRootUrl) {
    return unknown('parentIdentityChanged', '父目录仓库身份与导入记录不一致，请重新测试核对');
  }

  if (!targetExists) {
    if (parent.lastChangedRevision !== input.parentIdentity.lastChangedRevision) {
      return unknown(
        'parentRevisionAdvanced',
        `父目录在导入后有新提交（last-changed revision ${input.parentIdentity.lastChangedRevision} → ${parent.lastChangedRevision}），无法排除目标创建后被删除`,
      );
    }
    return { kind: 'notCommitted', evidence: { parentLastChangedRevision: parent.lastChangedRevision } };
  }

  // 第 2 步：已提交判定。R = 创建目标的提交（新建目录场景下即其最后变更）。
  let revisionText: string;
  try {
    const result = await runOrThrow(
      svnPath,
      ['info', '--show-item', 'last-changed-revision', '--non-interactive', '--', escapeUrlPeg(input.targetUrl)],
      credentialedOptions(input.targetUrl, options),
    );
    revisionText = result.stdout.trim();
  } catch (err) {
    return unknown('revisionReadFailed', err instanceof Error ? err.message : String(err));
  }
  const revision = Number(revisionText);
  if (!/^\d+$/.test(revisionText) || !Number.isFinite(revision)) {
    return unknown('evidenceUnparsable', `目标 last-changed-revision 输出无法解析：${revisionText}`);
  }

  let relativeUrl: string;
  try {
    const result = await runOrThrow(
      svnPath,
      ['info', '--show-item', 'relative-url', '--non-interactive', '--', escapeUrlPeg(input.targetUrl)],
      credentialedOptions(input.targetUrl, options),
    );
    relativeUrl = result.stdout.trim();
  } catch (err) {
    return unknown('evidenceUnparsable', `目标 relative-url 读取失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!relativeUrl.startsWith('^/')) {
    return unknown('evidenceUnparsable', `目标 relative-url 形态异常：${relativeUrl}`);
  }

  let logXml: string;
  try {
    const result = await runOrThrow(
      svnPath,
      ['log', '-r', String(revision), '--xml', '-v', '--non-interactive', '--', escapeUrlPeg(input.targetUrl)],
      credentialedOptions(input.targetUrl, options),
    );
    logXml = result.stdout;
  } catch (err) {
    return unknown('logFailed', err instanceof Error ? err.message : String(err));
  }
  const logEntry = parseImportLogXml(logXml);
  if (!logEntry) {
    return unknown('evidenceUnparsable', 'svn log --xml 输出无法解析');
  }
  if (logEntry.revision !== revision) {
    return unknown('evidenceUnparsable', `svn log 返回的 revision ${logEntry.revision} 与目标 last-changed revision ${revision} 不一致`);
  }

  if (verifyMessageFromXml(logEntry.message) !== input.expectedMessageDigest) {
    return unknown('msgMismatch', '远端提交说明与导入记录不一致（可能存在并发同名提交）');
  }

  // changed paths 归一化：前缀两侧先逐段解码再去前缀（info 侧保留百分号
  // 编码、log 侧是解码形态，不统一则中文/空格/#/% 的前缀永远去不掉）。
  const prefix = decodePathSegments(relativeUrl.slice(1)).replace(/^\//, '');
  const expectedFiles = expectedFilePathsFromSnapshot(snapshot);
  const dirSet = new Set(snapshot.dirs);
  let rootAction = '';
  const logFiles = new Set<string>();
  for (const changed of logEntry.paths) {
    const decoded = decodePathSegments(changed.path.replace(/^\//, ''));
    let relative: string;
    if (decoded === prefix) {
      relative = '';
    } else if (decoded.startsWith(`${prefix}/`)) {
      relative = decoded.slice(prefix.length + 1);
    } else {
      return unknown('evidenceUnparsable', `changed path 不在目标子树内：${changed.path}`);
    }
    if (relative === '') {
      rootAction = changed.action;
      continue;
    }
    if (changed.kind === 'file') {
      logFiles.add(relative);
    } else if (changed.kind === 'dir') {
      if (!dirSet.has(relative)) {
        return unknown('dirNotInSnapshot', `远端新建目录不在快照目录清单中：${relative}`);
      }
    } else {
      return unknown('evidenceUnparsable', `changed path 的 kind 无法识别：${changed.path}（${changed.kind}）`);
    }
  }
  if (rootAction !== 'A') {
    return unknown('rootNotAdded', `目标根在本次提交中的 action 不是 A（${rootAction || '不在 changed paths'}），导入内容可能与既有内容合并，请人工核对仓库`);
  }
  if (logFiles.size !== expectedFiles.size || [...expectedFiles].some((path) => !logFiles.has(path))) {
    return unknown('fileSetMismatch', '远端文件集合与快照期望集合不一致（可能存在并发同名提交）');
  }
  return { kind: 'committed', revision };
}
