/**
 * 磁盘治理（P4）core 模块：工作副本磁盘占用扫描、pristine 缓存统计
 * 与 vacuum 参数构造。core 模块，不依赖 vscode。
 *
 * 计量口径：逻辑文件大小（lstat.size）求和；只累加普通文件与符号链接
 * 自身的 lstat.size，目录条目不参与字节合计（APFS 目录 inode 的几十
 * 字节不代表内容量，含大量空目录的副本不受虚增）；符号链接不跟随
 * （链接项自身大小计入业务文件）。总量 = 业务文件 + `.svn`；`.svn`
 * 内再分 pristine（`.svn/pristine/` 前缀）与其他，pristine 不重复
 * 计入总量。硬链接按路径计数。
 *
 * 排除边界：业务口径排除根 `.svn`（单独计量）、嵌套副本（目录的直接
 * 子项出现 `.svn` 即该目录是嵌套副本根、整棵排除）与 externals 本地
 * 落点子树；externals 定义点目录本身及其下其他文件属于本副本，照常
 * 计量。`excluded` 清单是「范围说明」弹窗的数据源，不进清单不进表格。
 */
import { existsSync, realpathSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { isInsideExternalPrefixes } from './dailyOps';
import { SvnError } from './errors';
import { run } from './svnCli';
import { escapePeg } from './workspace';

// ---------------------------------------------------------------------------
// 结果形状
// ---------------------------------------------------------------------------

/** 业务文件清单条目：大文件表格的数据源（不含 .svn 与 excluded 子树）。 */
export interface DiskUsageFile {
  /** 相对 wcRoot 的路径，`/` 分隔。 */
  path: string;
  /** file | symlink（表格「类型」列数据源；symlink 不跟随、计自身大小）。 */
  kind: 'file' | 'symlink';
  /** lstat.size（逻辑字节）。 */
  bytes: number;
}

export interface DiskUsageTotals {
  /** 业务文件字节合计（恒等于 files[].bytes 求和）。 */
  business: number;
  /** `.svn` 目录占用（递归文件与符号链接字节；目录条目不计；含 pristine）。 */
  svn: number;
  /** `.svn/pristine` 前缀字节（svn 的子集，不重复计入总量）。 */
  pristineBytes: number;
  /** business + svn（pristine 不重复计入）。 */
  total: number;
}

export interface ScanDiskUsageResult {
  /** complete = 完整扫描；partial = 取消/错误/externals 读取失败下的已扫部分。 */
  phase: 'complete' | 'partial';
  /** 业务文件全量清单（跨页合计口径；`.svn` 与 excluded 子树不在内）。 */
  files: DiskUsageFile[];
  totals: DiskUsageTotals;
  /** 范围说明数据源：externals 落点、嵌套副本目录、解析失败的定义点（带标注）。 */
  excluded: string[];
  /** 已读取条目数（非确定进度：总数未知，只报已遍历到的）。 */
  scanCount: number;
  /** partial 时的范围说明/原因（多原因以「；」连接）。 */
  partialReason?: string;
}

export interface ScanDiskUsageOptions {
  /** 取消信号：externals 读取（svn 子进程）与目录遍历都会即时响应。 */
  signal?: AbortSignal;
  /**
   * 扫描进度回调（非确定进度：只报已读取数与当前路径）。轻量不阻塞：
   * 与取消检查/事件循环让路同节奏（每 64 条目一次）、同步调用无返回值，
   * 面板侧再做渲染节流（diskModel.scanProgress 注释的分工）。
   */
  onProgress?: (progress: { scanCount: number; currentPath: string }) => void;
}

/**
 * pristine 缓存统计（`PRISTINE` 表）。
 *
 * 实测 wc.db PRISTINE 表结构（svn 1.15，sqlite3 查 schema）：
 * `checksum TEXT PRIMARY KEY`（形态 `$sha1$<40位hex>`）、
 * `compression INTEGER`（可空，实测本副本为空）、`size INTEGER NOT NULL`
 * （与 pristine 文件实际磁盘字节一致）、`refcount INTEGER NOT NULL`
 * （检出即引用 ≥1）、`md5_checksum TEXT NOT NULL`。
 * pristine 文件路径 = `.svn/pristine/<hex 前 2 位>/<hex>.svn-base`。
 */
export interface PristineStats {
  /** false = 不可用（宿主无 node:sqlite / 打开失败 / 无 PRISTINE 表），数值不冒充 0。 */
  available: boolean;
  /** 不可用原因（available=false 时给出，面板 F55「不可用」文案的数据源）。 */
  reason?: string;
  /** PRISTINE 表总条目数。 */
  totalCount?: number;
  /** refcount=0 的条目数（可清理的缓存行数，按 DB 行计数、不扣除缺失文件）。 */
  cacheCount?: number;
  /** refcount=0 行的 size 字段合计（DB 记录值为回收清单与预计量的真相源）。 */
  unreferencedBytes?: number;
  /** refcount=0 行抽查磁盘缺失的计数（null = 未抽查）。 */
  missingCount?: number | null;
}

// ---------------------------------------------------------------------------
// vacuum 参数
// ---------------------------------------------------------------------------

/**
 * 未引用 pristine 清理命令参数：仅 `cleanup --non-interactive
 * --vacuum-pristines <目标>`，不附加任何其他 cleanup 选项（安全约束：
 * 单测断言参数恒等于此清单）。目标走 escapePeg（cleanup 目标是解析型
 * 路径，含 `@` 时须补尾 `@`，与既有命令同一转义纪律）。
 */
export function buildVacuumArgs(wcRoot: string): string[] {
  return ['cleanup', '--non-interactive', '--vacuum-pristines', escapePeg(wcRoot)];
}

// ---------------------------------------------------------------------------
// externals 解析（svn:externals 属性值 → 本地落点前缀）
// ---------------------------------------------------------------------------

interface ExternalsResolution {
  /** 排除前缀（相对 wcRoot，`/` 分隔）：externals 落点与解析失败的
   * 定义点子树（后者整棵保守排除；`''` 表示根定义点被保守排除）。 */
  prefixes: string[];
  /** externals 本地落点（prefixes 的展示子集，排除范围说明重复列条目）。 */
  landingPrefixes: string[];
  /** 范围说明附加条目：解析失败的定义点（带标注文本）。 */
  notes: string[];
  /** 存在无法相对 wcRoot 归一的定义点（target path 逃出 wcRoot）：
   * externals 数据整体不可信，外层转 partial（与命令级失败同款保守）。 */
  definitionInvalid: boolean;
}

const externalsParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // 路径与属性值的首尾空格属于名字本身，不 trim。
  trimValues: false,
  htmlEntities: true,
  // target 与 property 一定按集合处理（propget -R 多定义点输出多个 target）。
  isArray: (name) => name === 'target' || name === 'property',
});

/**
 * 解析 `svn propget svn:externals -R --xml` 输出。
 *
 * 实测（svn 1.15）`--xml` 形态：每个 `<target path="...">` 的 path 是
 * 绝对路径（realpath 形态，如 `/private/tmp/.../wc`），属性值在
 * `<property>` 的文本节点内（多行值天然在同一节点；默认文本输出是
 * 「路径 - 值」逐行形态，多行值会跨行、不可用于解析——故必须用 --xml）。
 * 落点计算前先把定义点 path 相对 wcRoot 归一；wcRoot 本身是 symlink
 * 路径而 svn 返回 realpath 时用 realpath 重试归一。
 */
function parseExternalsXml(xml: string, wcRoot: string): ExternalsResolution {
  const parsed = externalsParser.parse(xml) as {
    properties?: {
      target?: Array<{ path?: string; property?: Array<{ name?: string; '#text'?: string }> }>;
    };
  };
  const prefixes: string[] = [];
  const landingPrefixes: string[] = [];
  const notes: string[] = [];
  let definitionInvalid = false;
  for (const target of parsed.properties?.target ?? []) {
    const defRel = relativizeDefinitionPath(target.path ?? '', wcRoot);
    if (defRel === undefined) {
      // -R 递归输出的 target 逃出 wcRoot：数据源异常，整体不可信。
      definitionInvalid = true;
      continue;
    }
    for (const property of target.property ?? []) {
      if (property.name !== 'svn:externals' || typeof property['#text'] !== 'string') {
        continue;
      }
      resolveExternalsValue(property['#text'], defRel, prefixes, landingPrefixes, notes);
    }
  }
  return { prefixes, landingPrefixes, notes, definitionInvalid };
}

/**
 * 定义点绝对路径 → 相对 wcRoot；逃出 wcRoot（含归一失败）返回 undefined。
 * 首选字符串相对化；两侧形态不一致（svn 输出 realpath 形态而调用方传
 * symlink 路径，或反之——实测 macOS `/tmp` 与 `/private/tmp` 的关系）
 * 时把 wcRoot 与 targetPath 都 realpath 归一后再相对化。
 */
function relativizeDefinitionPath(targetPath: string, wcRoot: string): string | undefined {
  let rel = relative(wcRoot, targetPath);
  if (!rel.startsWith('..')) {
    return rel;
  }
  try {
    rel = relative(realpathSync(wcRoot), realpathSync(targetPath));
  } catch {
    // realpath 失败（目录被移动等）保持原相对化结果，按逃出处理。
  }
  return rel.startsWith('..') ? undefined : rel;
}

/**
 * 解析单个定义点的 svn:externals 属性值（多行，每行一个定义）。
 *
 * 每行形态 `[-r N] URL[@PEGREV] [本地子路径]`（svn:externals 语法），
 * 跳过空行与 `#` 注释。取词规则（实测 svn 1.15）：URL 词与本地子路径
 * 都支持单引号/双引号包裹（只剥离成对的首尾引号、内部引号保留——
 * `^/l1 "my 'libs'"` 的真实落点是 `my 'libs'`，内部单引号是名字的一
 * 部分）与反斜杠转义（`my\ libs`）；URL 词亦可带成对引号（`"^/l1"
 * "my libs"` 合法）；未加引号未转义的空格子路径与 `../` 形态实测
 * propset 直接 E195005、不可构造（防御侧仍按解析失败保守排除）。
 * 落点 = path.join(定义点相对路径, 本地子路径)——一律 path.join，
 * `./libs` 合法且 join 消解 `./` 段（字符串拼接会得 `sub/./libs`）；
 * 无本地子路径时落点 = URL 末段（剥 @PEGREV；实测 svn 1.15 propset
 * 对裸 URL 词一律 E195005 拒绝，该分支是对历史/其他客户端写入属性的
 * 防御）。
 *
 * 解析失败的行保守处理：该定义点子树整棵排除并在说明中标注——宁可
 * 少统计也不把外部内容混进本副本口径。
 */
function resolveExternalsValue(
  value: string,
  defRel: string,
  prefixes: string[],
  landingPrefixes: string[],
  notes: string[],
): void {
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const parsed = parseExternalsLine(line);
    let landing: string | undefined = parsed === undefined ? undefined : toRelPath(join(defRel, parsed.localPath));
    if (landing !== undefined && landing.startsWith('..')) {
      // `../x` 形态实测不可构造；防御历史脏数据，按解析失败保守排除。
      landing = undefined;
    }
    if (landing === undefined) {
      // 解析失败的行保守处理：该定义点子树整棵排除（defRel 为 '' 的根
      // 定义点同样入前缀——由 isExcludedByPrefixes 的 '' 特判承载）。
      prefixes.push(defRel);
      notes.push(`${defRel || '.'}（存在无法解析的 externals 定义，已保守排除）`);
      continue;
    }
    prefixes.push(landing);
    landingPrefixes.push(landing);
  }
}

/**
 * 排除前缀判定：复用 dailyOps.isInsideExternalPrefixes 的路径前缀边界
 * 谓词口径（path === prefix || path 以 prefix/ 开头）；额外承载「根定义
 * 点被保守排除」的 `''` 前缀——空串前缀语义为排除一切（解析失败定义
 * 点是 wcRoot 本身时，其子树就是整个副本）。
 */
function isExcludedByPrefixes(rel: string, prefixes: string[]): boolean {
  return prefixes.includes('') || isInsideExternalPrefixes(rel, prefixes);
}

/**
 * 单行 → { localPath }（相对定义点的落点段）。不满足 svn:externals
 * 语法的行返回 undefined（词数不是 URL[+子路径]、引号未闭合、`-r` 缺
 * 修订号等）。
 */
function parseExternalsLine(line: string): { localPath: string } | undefined {
  const tokens = tokenizeExternalsLine(line);
  if (tokens === undefined || tokens.length === 0) {
    return undefined;
  }
  let i = 0;
  // 行首修订号前缀只参与取词、不参与落点计算：`-r N`、`-rN`。
  if (tokens[i] === '-r' || tokens[i] === '--revision') {
    if (i + 1 >= tokens.length) {
      return undefined;
    }
    i += 2;
  } else if (/^-r\d+$/.test(tokens[i]) || /^--revision=/.test(tokens[i])) {
    i += 1;
  }
  if (i >= tokens.length) {
    return undefined;
  }
  const url = tokens[i];
  const localPath = tokens[i + 1];
  if (localPath !== undefined) {
    // URL + 子路径之外还有多余词 = 未引号/未转义的空格等非法形态
    // （实测 propset 报 E195005，不可构造；防御侧按解析失败收口）。
    if (tokens.length > i + 2) {
      return undefined;
    }
    if (localPath.length === 0) {
      return undefined;
    }
    return { localPath };
  }
  // 裸 URL：缺省落点 = URL 末段（先剥 @PEGREV 后缀）。
  const urlBody = url.replace(/@(\d+|HEAD|BASE|COMMITTED|PREV|\{[^}/]*\})$/i, '');
  const lastSegment = urlBody.split('/').filter((seg) => seg.length > 0).at(-1);
  if (lastSegment === undefined || lastSegment.length === 0) {
    return undefined;
  }
  return { localPath: lastSegment };
}

/**
 * svn:externals 行内分词：空白分隔；支持单引号/双引号包裹（到下一个
 * 同种引号结束，只剥成对首尾引号、内部引号保留）与反斜杠转义（`\x`
 * 取 x 字面值，引号内外同规则——实测 `my\ libs` 与 `'my libs'`、
 * `"my libs"` 的真实落点都是 `my libs`）。引号未闭合返回 undefined。
 */
function tokenizeExternalsLine(line: string): string[] | undefined {
  const tokens: string[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && /\s/.test(line[i])) {
      i++;
    }
    if (i >= n) {
      break;
    }
    const quote = line[i];
    if (quote === '"' || quote === "'") {
      i++;
      let value = '';
      let closed = false;
      while (i < n) {
        const ch = line[i];
        if (ch === quote) {
          closed = true;
          i++;
          break;
        }
        if (ch === '\\' && i + 1 < n) {
          value += line[i + 1];
          i += 2;
        } else {
          value += ch;
          i++;
        }
      }
      if (!closed) {
        return undefined;
      }
      tokens.push(value);
    } else {
      let value = '';
      while (i < n && !/\s/.test(line[i])) {
        if (line[i] === '\\' && i + 1 < n) {
          value += line[i + 1];
          i += 2;
        } else {
          value += line[i];
          i++;
        }
      }
      tokens.push(value);
    }
  }
  return tokens;
}

/** join 结果统一为 `/` 分隔的相对路径形态（Windows 反斜杠归一）。 */
function toRelPath(joined: string): string {
  return joined.replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// scanDiskUsage
// ---------------------------------------------------------------------------

/** 每处理多少个条目检查一次取消并让路事件循环（不阻塞扩展宿主）。 */
const YIELD_EVERY = 64;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * 扫描工作副本磁盘占用。异步遍历（批处理 + setImmediate 让路），
 * 支持 AbortSignal 取消：取消/读取错误/externals 读取失败都返回已扫
 * 部分并标 `partial`（数值可看但禁清理），`partialReason` 记范围说明。
 *
 * externals 读取用 `svn propget svn:externals -R --xml`（不用默认文本
 * 输出）；命令级失败（exit 非零——如 wc.db 被锁）→ 全部 externals
 * 定义不可用：取不到落点、「保守排除」无从谈起，扫描照常完成但结果
 * 转 partial 并标注「外部子树可能被计入业务口径」。
 */
export async function scanDiskUsage(
  svnPath: string,
  wcRoot: string,
  options: ScanDiskUsageOptions = {},
): Promise<ScanDiskUsageResult> {
  // 阶段一：externals 定义读取与落点解析。
  let externals: ExternalsResolution = { prefixes: [], landingPrefixes: [], notes: [], definitionInvalid: false };
  let externalsFailed = false;
  let cancelled = false;
  try {
    const result = await run(
      svnPath,
      ['propget', 'svn:externals', '-R', '--xml', '--non-interactive', '--', escapePeg(wcRoot)],
      { signal: options.signal, cwd: wcRoot },
    );
    if (result.exitCode === 0) {
      externals = parseExternalsXml(result.stdout, wcRoot);
      if (externals.definitionInvalid) {
        externalsFailed = true;
      }
    } else {
      externalsFailed = true;
    }
  } catch (err) {
    if (err instanceof SvnError && err.code === 'CANCELLED') {
      cancelled = true;
    } else {
      // 进程级失败（找不到 svn 等）：与命令级失败同款保守路径。
      externalsFailed = true;
    }
  }

  // 阶段二：目录树遍历计量。
  const excludePrefixes = externals.prefixes;
  const excluded: string[] = [...externals.landingPrefixes, ...externals.notes];
  const errors: string[] = [];
  const files: DiskUsageFile[] = [];
  let business = 0;
  let svnBytes = 0;
  let pristineBytes = 0;
  let scanCount = 0;
  const pending: Array<{ abs: string; rel: string }> = [{ abs: wcRoot, rel: '' }];

  while (pending.length > 0 && !cancelled && !options.signal?.aborted) {
    const { abs, rel } = pending.shift()!;
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      errors.push(`${rel || '.'}：${(err as NodeJS.ErrnoException).message}`);
      continue;
    }
    if (rel !== '' && entries.some((ent) => ent.name === '.svn')) {
      // 嵌套副本：直接子项出现 .svn 的目录是嵌套副本根，整棵排除
      //（其下其他条目也属嵌套副本，不计量不入队）。
      excluded.push(rel);
      continue;
    }
    for (const ent of entries) {
      scanCount++;
      const childRel = rel === '' ? ent.name : `${rel}/${ent.name}`;
      if (scanCount % YIELD_EVERY === 0) {
        if (options.signal?.aborted) {
          cancelled = true;
          break;
        }
        // 进度回调与让路同节奏（每 64 条目）：同步轻量调用，渲染节流在面板侧。
        options.onProgress?.({ scanCount, currentPath: childRel });
        await yieldToEventLoop();
      }
      if (rel === '' && ent.name === '.svn') {
        // 本副本元数据目录：整棵排除出业务口径，单独计量（pristine
        // 前缀再单列，供空间概览分层）。`.svn` 内条目同样计入 scanCount
        // 并按同节奏报进度（onEntry 携带条目所在目录的 .svn 相对形态）。
        const measured = await measureSvnDir(join(wcRoot, '.svn'), {
          signal: options.signal,
          errors,
          onEntry: (entryDirRel) => {
            scanCount++;
            if (options.onProgress && scanCount % YIELD_EVERY === 0) {
              options.onProgress({
                scanCount,
                currentPath: entryDirRel === '.' ? '.svn' : `.svn/${entryDirRel}`,
              });
            }
          },
        });
        svnBytes = measured.total;
        pristineBytes = measured.pristine;
        continue;
      }
      // externals 本地落点子树（与解析失败的保守排除定义点）：文件与
      // 目录同规则排除（目录不入队、文件不计；定义点目录本身不在此
      // 列、照常计量）。
      if (isExcludedByPrefixes(childRel, excludePrefixes)) {
        continue;
      }
      let stat;
      try {
        stat = await lstat(join(abs, ent.name));
      } catch (err) {
        errors.push(`${childRel}：${(err as NodeJS.ErrnoException).message}`);
        continue;
      }
      if (stat.isDirectory()) {
        pending.push({ abs: join(abs, ent.name), rel: childRel });
      } else if (stat.isFile() || stat.isSymbolicLink()) {
        business += stat.size;
        files.push({
          path: childRel,
          kind: stat.isSymbolicLink() ? 'symlink' : 'file',
          bytes: stat.size,
        });
      }
      // 其他类型（FIFO/socket/device）不参与字节合计（口径只认普通
      // 文件与符号链接）。
    }
    if (!cancelled) {
      await yieldToEventLoop();
    }
  }
  if (options.signal?.aborted) {
    cancelled = true;
  }

  const reasons: string[] = [];
  if (cancelled) {
    reasons.push('扫描已取消，结果为已扫描部分');
  }
  if (externalsFailed) {
    reasons.push('externals 定义读取失败，外部子树可能被计入业务口径');
  }
  if (errors.length > 0) {
    reasons.push(`${errors.length} 个路径读取失败（如 ${errors[0]}）`);
  }

  return {
    phase: reasons.length > 0 ? 'partial' : 'complete',
    files,
    totals: {
      business,
      svn: svnBytes,
      pristineBytes,
      total: business + svnBytes,
    },
    excluded,
    scanCount,
    ...(reasons.length > 0 ? { partialReason: reasons.join('；') } : {}),
  };
}

/**
 * 递归计量 `.svn` 目录（含 pristine 前缀单列）。目录条目不参与字节
 * 合计；符号链接不跟随。读取失败按路径记入 errors（影响 partial 标注）
 * 并继续（该子树按已读部分计入）。
 */
async function measureSvnDir(
  svnAbs: string,
  context: {
    signal?: AbortSignal;
    errors: string[];
    /** 每读取一个条目调用一次，参数为条目所在目录相对 .svn 根的路径（目录级、供进度展示）。 */
    onEntry: (entryDirRel: string) => void;
  },
): Promise<{ total: number; pristine: number }> {
  let total = 0;
  let pristine = 0;
  const stack: Array<{ abs: string; inPristine: boolean }> = [{ abs: svnAbs, inPristine: false }];
  while (stack.length > 0) {
    if (context.signal?.aborted) {
      break;
    }
    const { abs: dir, inPristine } = stack.pop()!;
    // 目录级相对路径每目录计算一次（进度回调只在此节奏下取用，轻量）。
    const dirRel = relative(svnAbs, dir) || '.';
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      context.errors.push(`${dirRel}：${(err as NodeJS.ErrnoException).message}`);
      continue;
    }
    for (const ent of entries) {
      context.onEntry(dirRel);
      if (context.signal?.aborted) {
        break;
      }
      // pristine 前缀只在 .svn 顶层命中 pristine 目录名；其子孙目录
      // 按继承标记（`.svn/tmp/pristine` 之类同名目录不算 pristine 前缀）。
      const childInPristine = inPristine || (dir === svnAbs && ent.name === 'pristine');
      let stat;
      try {
        stat = await lstat(join(dir, ent.name));
      } catch (err) {
        context.errors.push(`${relative(svnAbs, join(dir, ent.name))}：${(err as NodeJS.ErrnoException).message}`);
        continue;
      }
      if (stat.isDirectory()) {
        stack.push({ abs: join(dir, ent.name), inPristine: childInPristine });
      } else if (stat.isFile() || stat.isSymbolicLink()) {
        total += stat.size;
        if (childInPristine) {
          pristine += stat.size;
        }
      }
    }
    await yieldToEventLoop();
  }
  return { total, pristine };
}

// ---------------------------------------------------------------------------
// readPristineStats
// ---------------------------------------------------------------------------

/**
 * `node:sqlite` 载入失败（宿主不支持）时 `PristineStats.reason` 的固定
 * 值：宿主侧以该常量判别 unsupported（能力缺失）与 unavailable（副本侧
 * 不可用）两态——单一来源导出，调用方不得复制文案字符串做比对。
 */
export const PRISTINE_UNSUPPORTED_REASON = '当前 VS Code 宿主不支持缓存检测';

/**
 * 只读统计 `.svn/wc.db` 的 PRISTINE 表。
 *
 * `node:sqlite` 以动态 `await import` 在 try/catch 内载入：engines
 * `^1.85.0` 覆盖 Node 18 宿主，而 node:sqlite 在 Node 22.5+ 才存在，
 * 静态 import 会在扩展加载期抛 ERR_UNKNOWN_BUILTIN_MODULE、连其他功
 * 能一起弄坏；动态载入把「宿主不支持」收敛为 available:false（实测
 * Node 24.22 宿主可用、Node 18 恒不可用——旧宿主动态 import 抛
 * ERR_UNKNOWN_BUILTIN_MODULE）。打开用 `new DatabaseSync(path,
 * { readOnly: true })`（实测 API 形态：readOnly 驼峰、写被拒
 * `attempt to write a readonly database`、打开不存在的文件被拒不误建）。
 *
 * 统计对象 = PRISTINE 表 refcount=0 的 DB 行（数量与 size 合计按 DB
 * 行计数、不扣除抽查发现的缺失文件——DB 行是回收清单与预计量的真相
 * 源，实测 size 与文件实际字节一致）；抽查 pristine 文件实际存在性，
 * 缺失单独计数 missingCount。载入失败、无 PRISTINE 表、打开失败（含
 * 被 svn 进程写占用）→ available:false + 原因，数值不冒充 0。
 */
export async function readPristineStats(wcRoot: string): Promise<PristineStats> {
  let DatabaseSyncCtor: typeof import('node:sqlite').DatabaseSync;
  try {
    // 动态载入纪律：旧宿主在此收敛 unsupported，不在模块顶层 import。
    ({ DatabaseSync: DatabaseSyncCtor } = await import('node:sqlite'));
  } catch {
    return { available: false, reason: PRISTINE_UNSUPPORTED_REASON };
  }

  const dbPath = join(wcRoot, '.svn', 'wc.db');
  let db: import('node:sqlite').DatabaseSync;
  try {
    db = new DatabaseSyncCtor(dbPath, { readOnly: true });
  } catch (err) {
    return { available: false, reason: `wc.db 打开失败：${(err as Error).message}` };
  }

  try {
    const tableRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'PRISTINE'")
      .get() as { name?: string } | undefined;
    if (tableRow?.name !== 'PRISTINE') {
      return { available: false, reason: '不支持的格式：wc.db 无 PRISTINE 表' };
    }

    const totalRow = db.prepare('SELECT COUNT(*) AS n FROM PRISTINE').get() as { n: number };
    const unreferencedRows = db
      .prepare('SELECT checksum, size FROM PRISTINE WHERE refcount = 0')
      .all() as Array<{ checksum: string; size: number }>;

    let unreferencedBytes = 0;
    let missingCount = 0;
    for (const row of unreferencedRows) {
      unreferencedBytes += row.size;
      if (!pristineFileExists(wcRoot, row.checksum)) {
        missingCount++;
      }
    }

    return {
      available: true,
      totalCount: totalRow.n,
      cacheCount: unreferencedRows.length,
      unreferencedBytes,
      missingCount,
    };
  } catch (err) {
    return { available: false, reason: `PRISTINE 表读取失败：${(err as Error).message}` };
  } finally {
    db.close();
  }
}

/**
 * pristine 文件存在性抽查：checksum 形态实测为 `$sha1$<40 位 hex>`，
 * 文件路径 = `.svn/pristine/<hex 前 2 位>/<hex>.svn-base`（svn 1.15
 * 实测布局）。取最后一个 `$` 之后的 hex 段，不假设摘要算法前缀格式。
 */
function pristineFileExists(wcRoot: string, checksum: string): boolean {
  const hex = checksum.slice(checksum.lastIndexOf('$') + 1);
  if (hex.length < 3) {
    return false;
  }
  const pristinePath = join(wcRoot, '.svn', 'pristine', hex.slice(0, 2), `${hex}.svn-base`);
  return existsSync(pristinePath);
}
