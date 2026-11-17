/**
 * 远端仓库浏览的 core 原语：svn info/list XML、仓库节点、目录直属条目与
 * 远端属性读取。core 模块，不依赖 vscode。
 *
 * 口径（URL 目标身份、目录读取与取消语义契约，真实 svn 实测）：
 * - 节点身份：`svn info --xml --non-interactive -r <rev> -- <URL@rev>`；
 *   `entry@revision` 是快照 revision，`commit@revision` 是节点最后修改
 *   revision，两者分字段保存；文件大小只在 `entry@size`（list 中为
 *   `<size>`），`svn info --show-item` 不提供 size。
 * - 直属条目：`svn list --xml --non-interactive --depth immediates -r <rev> -- <URL@rev>`，
 *   经 runStream 不累计 stdout、`StringDecoder('utf8')` 跨 chunk 解码后交给
 *   saxes 流式解析，宿主只保留紧凑条目。解析预算 100,000 条目 / 64 MiB
 *   原始 XML，任一越限立即中止节点读取并返回 tooLarge，不把已收到的部分
 *   条目伪装成总数。
 * - 空目录与不存在路径的 stdout 都是合法空骨架（`<info/>`、
 *   `<lists><list/></lists>`）：空目录为 exit 0 且 stderr 空；不存在为
 *   exit 1 + `W160013`/`W170000` + `E200009`。因此 ready + total=0 只能
 *   建立在 exit 0 上，notFound 必须由退出码与 stderr 判定，不能只看空 XML；
 *   非零退出时 stdout 可能含内嵌告警的半截 XML，一律不解析。
 * - `<name>` 原样保留 UTF-8 与首尾空格，不 trim；节点 URL 由父节点原始
 *   URL + 条目原始名称逐段 URL 编码得到；命令、复制与剪贴板保留原始 URL。
 * - 远端仓库属性不在 info/list XML 中：`svn propget --xml svn:mime-type`
 *   属性存在 exit 0；缺失 exit 1 + `W200017` + `E200000`，视为“无 mime”
 *   而不是读取错误。
 * - 任何 `URL@REV` 都经 svnCli.urlWithPeg 统一构造（含字面 `@` 或 `%40`
 *   的 URL 直接执行会报 E205000），调用点不手写 `@`。
 */
import { XMLParser } from 'fast-xml-parser';
import { SaxesParser } from 'saxes';
import {
  SvnError,
  classifyAuthFailure,
  isNetworkFailure,
} from './errors';
import {
  authScopeOfUrl,
  runOrThrow,
  runOrThrowWithRunner,
  runStream,
  urlWithPeg,
  Utf8StreamDecoder,
  type RunOptions,
} from './svnCli';

// ---------------------------------------------------------------------------
// 常量与冻结类型
// ---------------------------------------------------------------------------

/** 目录直属条目解析硬上限（目录读取契约）。 */
export const REMOTE_BROWSE_MAX_ENTRIES = 100_000;

/** 目录 XML 原始字节硬上限：64 MiB（目录读取契约）。 */
export const REMOTE_BROWSE_MAX_XML_BYTES = 64 * 1024 * 1024;

/**
 * 大目录两段式加载的直属条目数阈值：超过该值时
 * 先用无元数据 `svn list` 取得名称与精确总数并立即首屏，`list --xml`
 * 元数据改由选中节点 `svn info` 与可取消后台任务按可见片补全。
 */
export const REMOTE_BROWSE_METADATA_THRESHOLD = 5_000;

/**
 * 二进制内容探测窗口：前 8 KiB 含 NUL 判二进制。已知限制：窗口之后的
 * NUL 不识别；UTF-16 文本会因字符间 NUL 被判二进制。
 */
export const BINARY_PROBE_BYTES = 8 * 1024;

/**
 * 共享目标身份。所有远端命令以它作为
 * 结构化输入，不在 Webview 拼 URL。
 */
export interface RepoNodeRef {
  repositoryUuid: string;
  /** svn 输出的原始编码仓库根 URL。 */
  repositoryRootUrl: string;
  /** 不二次解码；复制与命令使用。 */
  rawUrl: string;
  /** 仓库相对 POSIX 路径，不含 `^/`（根节点为空串），路径段已逐段解码。 */
  relativePath: string;
  /** 本次读取/比较固定到的具体 revision（info 的 entry@revision）。 */
  snapshotRevision: number;
  /** 节点最后修改 revision（info/list 的 commit@revision）。 */
  lastChangedRevision: number;
  lastChangedAuthor?: string;
  lastChangedDate?: string;
  kind: 'file' | 'dir';
}

/** 目录直属条目：紧凑形态，只在宿主内存中保留必要字段。 */
export interface BrowseEntry {
  /** 原样名称：保留原始 UTF-8 与首尾空格，不 trim。 */
  name: string;
  kind: 'file' | 'dir';
  /** 文件大小（字节）；目录与缺失时为空。 */
  sizeBytes?: number;
  /** 最后修改 revision（`<commit revision>`）；缺失时为空。 */
  lastChangedRevision?: number;
  lastChangedAuthor?: string;
  lastChangedDate?: string;
}

/** 一次完整目录读取的结果（ready 时 total 为精确条目数）。 */
export interface BrowseDirectoryListing {
  /** `list@path` 原始值（svn 回显输入 URL 的形态，不用于节点身份）。 */
  listPath: string;
  entries: BrowseEntry[];
  total: number;
  /** 本次读取的原始 XML 字节数（流式累计）。 */
  xmlBytes: number;
}

/** 浏览失败的分类（host 据此选择凭据补录、重试或终态提示）。 */
export type BrowserErrorKind =
  | 'auth'
  | 'permission'
  | 'network'
  | 'notFound'
  | 'revisionNotFound'
  | 'tooLarge'
  | 'cancelled'
  | 'parse'
  | 'unknown';

export interface BrowserError {
  kind: BrowserErrorKind;
  message: string;
  /** 输出中出现的 svn 状态码（E/W 开头 6 位），按出现顺序去重。 */
  codes: string[];
  exitCode?: number;
}

/** 目录解析越限：由 SAX 流中途抛出，用于立即终止 svn 进程。 */
export class BrowseLimitExceededError extends Error {
  readonly reason: 'entries' | 'bytes';
  readonly limit: number;

  constructor(reason: 'entries' | 'bytes', limit: number) {
    super(reason === 'entries'
      ? `directory has more than ${limit} entries; read aborted`
      : `directory XML exceeds ${limit} bytes; read aborted`);
    this.name = 'BrowseLimitExceededError';
    this.reason = reason;
    this.limit = limit;
  }
}

// ---------------------------------------------------------------------------
// 错误分类
// ---------------------------------------------------------------------------

/** svn 状态码（E=错误、W=警告）均为字母 + 6 位数字。 */
const SVN_STATUS_CODE = /\b[EW]\d{6}\b/g;

/** 提取输出中的全部 svn 状态码（E/W），保留出现顺序并去重。 */
export function extractSvnStatusCodes(text: string): string[] {
  return [...new Set([...text.matchAll(SVN_STATUS_CODE)].map((match) => match[0]))];
}

/**
 * 浏览失败分类：退出码与 stderr/消息中的 6 位状态码是唯一依据，不依赖
 * 本地化文本（产品固定 en_US.UTF-8，其他 locale 只按错误码保守处理）。
 * - `W160013`/`W170000`（list/info 路径不存在）与 `E150000`（propget 对
 *   不存在的目标）→ notFound；
 * - `E160006`/`E195012` → revisionNotFound（快照 revision 不存在）；
 * - 认证/权限沿用 errors.classifyAuthFailure（svn:// 的 E170001 按固定
 *   文本细分；E175013 恒为 permission）；网络类按 NETWORK_ERROR_CODES；
 * - 进程级取消/超时错误码沿用 svnCli 的 CANCELLED/TIMEOUT。
 */
export function classifyBrowseFailure(err: unknown, url?: string): BrowserError {
  if (err instanceof BrowseLimitExceededError) {
    return { kind: 'tooLarge', message: err.message, codes: [] };
  }
  if (err instanceof SvnError) {
    const text = `${err.stderr}\n${err.message}`;
    const codes = extractSvnStatusCodes(text);
    const base = { message: err.message, codes, exitCode: err.exitCode };
    if (err.code === 'CANCELLED') {
      return { kind: 'cancelled', ...base };
    }
    if (err.code === 'TIMEOUT') {
      return { kind: 'network', ...base };
    }
    const scheme = url === undefined ? undefined : authScopeOfUrl(url)?.scheme;
    const authKind = classifyAuthFailure(text, scheme);
    if (authKind === 'permission') {
      return { kind: 'permission', ...base };
    }
    if (authKind === 'auth') {
      return { kind: 'auth', ...base };
    }
    if (codes.includes('E160006') || codes.includes('E195012')) {
      return { kind: 'revisionNotFound', ...base };
    }
    // W160013/W170000 是 info/list 的路径不存在；propget 对不存在的目标
    // 输出 E150000（`... does not exist in revision N`，补充实测）。
    if (codes.includes('W160013') || codes.includes('W170000') || codes.includes('E150000')) {
      return { kind: 'notFound', ...base };
    }
    if (isNetworkFailure(text)) {
      return { kind: 'network', ...base };
    }
    return { kind: 'unknown', ...base };
  }
  return {
    kind: 'unknown',
    message: err instanceof Error ? err.message : String(err),
    codes: [],
  };
}

/**
 * 远端命令的凭据作用域兜底：调用点未显式传 authScope 时由目标 URL 推导
 * （authScopeOfUrl），保证 host 单飞协调器按 scheme + host + port 共享
 * 同一凭据 Promise；file/svn+ssh 无凭据作用域（认证由文件系统/SSH 配置
 * 承载），同时移除 getCredentials，避免误弹 HTTP 凭据框。
 */
export function withRemoteAuthScope(url: string, options: RunOptions): RunOptions {
  if (options.authScope !== undefined) {
    return options;
  }
  const scope = authScopeOfUrl(url);
  if (scope === undefined) {
    if (options.getCredentials === undefined) {
      return options;
    }
    return { ...options, getCredentials: undefined };
  }
  return { ...options, authScope: scope };
}

// ---------------------------------------------------------------------------
// 节点信息（svn info --xml）
// ---------------------------------------------------------------------------

const infoParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // 路径与 URL 中的首尾空格属于名称，不能改变身份。
  trimValues: false,
  // SVN 用数字实体表示路径字符；解码一次，保留 &amp; 编码的字面实体。
  htmlEntities: true,
  // 文本/属性保持字符串原文（纯数字名称不转 number）。
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name === 'entry',
});

interface InfoXmlEntry {
  kind?: string;
  path?: string;
  revision?: string;
  size?: string;
  url?: string;
  'relative-url'?: string;
  repository?: { root?: string; uuid?: string };
  commit?: { revision?: string; author?: string; date?: string };
}

/** info 解析结果：冻结节点身份 + 文件大小（目录无 size）。 */
export interface RemoteNodeInfo {
  node: RepoNodeRef;
  sizeBytes?: number;
}

/** 逐段百分号解码路径段；非法 UTF-8 段原样保留（不猜编码）。 */
function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * `relative-url`（`^/trunk/a%20b.txt`）→ 仓库相对 POSIX 路径：剥掉 `^/`，
 * 逐段解码一次。根节点 `^/` 得到空串。条目名称来自 list 的原始 `<name>`
 * （已解码），两者保持同一形态便于比较与拼接。
 */
export function relativePathFromRelativeUrl(relativeUrl: string): string {
  let body = relativeUrl;
  if (body.startsWith('^/')) {
    body = body.slice(2);
  } else if (body.startsWith('^')) {
    body = body.slice(1).replace(/^\//, '');
  }
  if (body === '') {
    return '';
  }
  return body.split('/').map(decodePathSegment).join('/');
}

/** 缺 `relative-url` 时由原始 URL 与仓库根推导 `^/…`；不匹配返回 undefined。 */
function deriveRelativeUrl(url: string, repositoryRootUrl: string): string | undefined {
  const root = repositoryRootUrl.endsWith('/')
    ? repositoryRootUrl.slice(0, -1)
    : repositoryRootUrl;
  if (url === root) {
    return '^/';
  }
  if (!url.startsWith(`${root}/`)) {
    return undefined;
  }
  return `^/${url.slice(root.length + 1)}`;
}

/**
 * 解析 `svn info --xml` 输出，取第一个 entry。字段缺失（url、仓库根/UUID、
 * entry revision、kind）时返回 undefined，由调用方按解析失败处理；commit
 * 缺失时 lastChangedRevision 回退为快照 revision。
 */
export function parseRemoteInfoXml(xml: string): RemoteNodeInfo | undefined {
  const parsed = infoParser.parse(xml) as { info?: { entry?: InfoXmlEntry[] } };
  const entry = parsed.info?.entry?.[0];
  if (!entry) {
    return undefined;
  }
  const rawUrl = entry.url;
  const rootUrl = entry.repository?.root;
  const repositoryUuid = entry.repository?.uuid;
  const snapshotRevision = Number(entry.revision);
  const kind = entry.kind;
  if (typeof rawUrl !== 'string' || typeof rootUrl !== 'string'
    || typeof repositoryUuid !== 'string' || !Number.isFinite(snapshotRevision)
    || (kind !== 'file' && kind !== 'dir')) {
    return undefined;
  }
  const relativeUrl = entry['relative-url']
    ?? deriveRelativeUrl(rawUrl, rootUrl);
  if (relativeUrl === undefined) {
    return undefined;
  }
  const lastChangedRevision = entry.commit?.revision !== undefined
    ? Number(entry.commit.revision)
    : snapshotRevision;
  if (!Number.isFinite(lastChangedRevision)) {
    return undefined;
  }
  const node: RepoNodeRef = {
    repositoryUuid,
    repositoryRootUrl: rootUrl,
    rawUrl,
    relativePath: relativePathFromRelativeUrl(relativeUrl),
    snapshotRevision,
    lastChangedRevision,
    kind,
  };
  const author = entry.commit?.author;
  if (typeof author === 'string') {
    node.lastChangedAuthor = author;
  }
  const date = entry.commit?.date;
  if (typeof date === 'string') {
    node.lastChangedDate = date;
  }
  let sizeBytes: number | undefined;
  if (entry.size !== undefined) {
    const parsedSize = Number(entry.size);
    if (Number.isFinite(parsedSize) && parsedSize >= 0) {
      sizeBytes = parsedSize;
    }
  }
  return sizeBytes === undefined ? { node } : { node, sizeBytes };
}

/** `svn info --xml` 命令参数；快照 revision 同时作为 peg 与 -r。 */
export function buildRemoteInfoArgs(url: string, revision?: number): string[] {
  const args = ['info', '--xml', '--non-interactive'];
  if (revision !== undefined) {
    args.push('-r', String(revision));
  }
  args.push('--', urlWithPeg(url, revision));
  return args;
}

export interface ReadRemoteNodeOptions extends RunOptions {
  /** 快照 revision；缺省读取 HEAD，并由返回的 snapshotRevision 固定。 */
  revision?: number;
}

export type RemoteNodeReadResult =
  | { status: 'present'; node: RepoNodeRef; sizeBytes?: number }
  | { status: 'absent'; error: BrowserError }
  | { status: 'error'; error: BrowserError };

/**
 * 读取远端节点身份：`svn info --xml -r <rev> -- <URL@rev>`。
 * 路径在该 revision 不存在（含已删除、pre-copy）返回 absent（由退出码 +
 * W160013/W170000 判定）；其余读取失败按 BrowserError 分类，不抛进程错误。
 */
export async function readRemoteNode(
  svnPath: string,
  url: string,
  options: ReadRemoteNodeOptions = {},
): Promise<RemoteNodeReadResult> {
  const { revision, ...runOptions } = options;
  const args = buildRemoteInfoArgs(url, revision);
  try {
    const result = await runOrThrow(svnPath, args, withRemoteAuthScope(url, runOptions));
    const parsed = parseRemoteInfoXml(result.stdout);
    if (!parsed) {
      return {
        status: 'error',
        error: {
          kind: 'parse',
          message: 'svn info --xml output is missing required fields',
          codes: [],
          exitCode: result.exitCode,
        },
      };
    }
    return { status: 'present', ...parsed };
  } catch (err) {
    const error = classifyBrowseFailure(err, url);
    return error.kind === 'notFound' ? { status: 'absent', error } : { status: 'error', error };
  }
}

// ---------------------------------------------------------------------------
// 目录直属条目（svn list --xml + saxes 流式解析）
// ---------------------------------------------------------------------------

export interface DirectoryListLimits {
  maxEntries?: number;
  maxXmlBytes?: number;
}

interface TextTarget {
  tag: 'name' | 'size' | 'author' | 'date';
}

/**
 * `svn list --xml` 的流式 SAX 解析器：调用方把原始字节块依次喂给
 * write（内部用 StringDecoder 跨 chunk 解码，中文/emoji 在分块边界不会
 * 变成替换符），进程成功结束后调用 end 取结果。
 *
 * - 字节预算按原始 XML 字节累计，在解码前检查；越限抛
 *   BrowseLimitExceededError（回调抛错会让 svnCli 终止子进程）；
 * - 条目预算在每条 entry 闭合时检查，超过上限立即抛错；
 * - 文本值不 trim（`<name>` 的首尾空格属于名称）、实体解码一次、CDATA
 *   当作文本（saxes 的 cdata 事件并入当前文本）；
 * - 认证补录重试前调用 reset 清空已解析内容，旧尝试的数据不进入结果；
 * - write 期间的非预算解析错误先暂存，end 时再抛，避免把非零退出的
 *   半截 XML 误报成解析错误（调用方先按退出码分类）。
 */
export class DirectoryListParser {
  private parser: SaxesParser;
  private readonly decoder = new Utf8StreamDecoder();
  private readonly maxEntries: number;
  private readonly maxXmlBytes: number;
  private entries: BrowseEntry[] = [];
  private listPath: string | undefined;
  private currentEntry: BrowseEntry | undefined;
  private currentEntryHasName = false;
  private textTarget: TextTarget | undefined;
  private textValue = '';
  private bytes = 0;
  private writeError: unknown;

  constructor(limits: DirectoryListLimits = {}) {
    this.maxEntries = limits.maxEntries ?? REMOTE_BROWSE_MAX_ENTRIES;
    this.maxXmlBytes = limits.maxXmlBytes ?? REMOTE_BROWSE_MAX_XML_BYTES;
    this.parser = this.createParser();
  }

  /** 已读取的原始 XML 字节数（含触发越限的块）。 */
  get bytesRead(): number {
    return this.bytes;
  }

  /** 已解析出的条目数（越限中止时为部分计数，仅用于诊断）。 */
  get entryCount(): number {
    return this.entries.length;
  }

  /** 清空全部状态（认证补录重试前调用，避免两次尝试的数据混合）。 */
  reset(): void {
    this.parser = this.createParser();
    this.entries = [];
    this.listPath = undefined;
    this.currentEntry = undefined;
    this.currentEntryHasName = false;
    this.textTarget = undefined;
    this.textValue = '';
    this.bytes = 0;
    this.writeError = undefined;
  }

  /** 喂入一块原始 stdout 字节。 */
  write(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxXmlBytes) {
      throw new BrowseLimitExceededError('bytes', this.maxXmlBytes);
    }
    if (this.writeError !== undefined) {
      // 已记录解析错误：继续计数但不再喂 SAX，由 end 统一抛出。
      return;
    }
    try {
      this.parser.write(this.decoder.write(chunk));
    } catch (err) {
      if (err instanceof BrowseLimitExceededError) {
        throw err;
      }
      this.writeError = err;
    }
  }

  /** 进程成功结束后收口解析并返回结果；解析不完整/缺根元素时抛错。 */
  end(): BrowseDirectoryListing {
    if (this.writeError !== undefined) {
      throw this.writeError;
    }
    this.parser.write(this.decoder.end());
    this.parser.close();
    if (this.listPath === undefined) {
      throw new Error('svn list --xml output is missing the <list> root element');
    }
    return {
      listPath: this.listPath,
      entries: this.entries,
      total: this.entries.length,
      xmlBytes: this.bytes,
    };
  }

  private createParser(): SaxesParser {
    const parser = new SaxesParser({ xmlns: false });
    parser.on('opentag', (tag) => {
      switch (tag.name) {
        case 'list':
          if (this.listPath === undefined) {
            this.listPath = tag.attributes.path ?? '';
          }
          break;
        case 'entry':
          this.currentEntry = {
            name: '',
            kind: tag.attributes.kind === 'dir' ? 'dir' : 'file',
          };
          this.currentEntryHasName = false;
          break;
        case 'commit': {
          // 条目最后修改 revision 在 <commit revision>；和快照 revision 分开。
          const revision = Number(tag.attributes.revision);
          if (this.currentEntry && Number.isFinite(revision)) {
            this.currentEntry.lastChangedRevision = revision;
          }
          break;
        }
        case 'name':
        case 'size':
        case 'author':
        case 'date':
          this.textTarget = { tag: tag.name };
          this.textValue = '';
          break;
        default:
          break;
      }
    });
    parser.on('text', (text) => {
      if (this.textTarget !== undefined) {
        this.textValue += text;
      }
    });
    parser.on('cdata', (text) => {
      if (this.textTarget !== undefined) {
        this.textValue += text;
      }
    });
    parser.on('closetag', (tag) => {
      switch (tag.name) {
        case 'name':
          if (this.currentEntry) {
            this.currentEntry.name = this.textValue;
            this.currentEntryHasName = true;
          }
          this.clearText();
          break;
        case 'size':
          if (this.currentEntry) {
            const size = Number(this.textValue);
            if (Number.isFinite(size) && size >= 0) {
              this.currentEntry.sizeBytes = size;
            }
          }
          this.clearText();
          break;
        case 'author':
          if (this.currentEntry) {
            this.currentEntry.lastChangedAuthor = this.textValue;
          }
          this.clearText();
          break;
        case 'date':
          if (this.currentEntry) {
            this.currentEntry.lastChangedDate = this.textValue;
          }
          this.clearText();
          break;
        case 'entry':
          if (this.currentEntry && this.currentEntryHasName) {
            this.entries.push(this.currentEntry);
            if (this.entries.length > this.maxEntries) {
              throw new BrowseLimitExceededError('entries', this.maxEntries);
            }
          }
          this.currentEntry = undefined;
          this.currentEntryHasName = false;
          break;
        default:
          break;
      }
    });
    return parser;
  }

  private clearText(): void {
    this.textTarget = undefined;
    this.textValue = '';
  }
}

/**
 * 纯解析入口：把内联 fixture 或已读字节按任意分块喂给 DirectoryListParser。
 * 越限抛 BrowseLimitExceededError，XML 不完整/畸形抛解析错误。
 */
export function parseDirectoryListXml(
  input: string | Buffer | readonly Buffer[],
  limits: DirectoryListLimits = {},
): BrowseDirectoryListing {
  const parser = new DirectoryListParser(limits);
  const chunks: readonly Buffer[] = typeof input === 'string'
    ? [Buffer.from(input, 'utf8')]
    : Buffer.isBuffer(input)
      ? [input]
      : input;
  for (const chunk of chunks) {
    parser.write(chunk);
  }
  return parser.end();
}

/** `svn list --xml --depth immediates` 命令参数；peg 与 -r 同为快照 revision。 */
export function buildRemoteListArgs(url: string, revision: number): string[] {
  return [
    'list',
    '--xml',
    '--non-interactive',
    '--depth',
    'immediates',
    '-r',
    String(revision),
    '--',
    urlWithPeg(url, revision),
  ];
}

export interface ReadRemoteDirectoryOptions extends RunOptions {
  /** 浏览快照 revision（来自节点 info 的 snapshotRevision）。 */
  revision: number;
  maxEntries?: number;
  maxXmlBytes?: number;
}

export type BrowseDirectoryResult =
  | { status: 'ready'; listing: BrowseDirectoryListing }
  | { status: 'notFound'; error: BrowserError }
  | {
      status: 'tooLarge';
      reason: 'entries' | 'bytes';
      limit: number;
      xmlBytes: number;
      entriesParsed: number;
      error: BrowserError;
    }
  | { status: 'error'; error: BrowserError };

/**
 * 读取远端目录的直属条目（不递归）。runStream 不累计 stdout，SAX 解析
 * 只保留紧凑条目；认证失败经 runOrThrowWithRunner 的补录重试重新执行，
 * 重试前 reset 解析器。
 *
 * 返回语义：
 * - exit 0 且零条目 → ready（空目录，total=0）；
 * - 路径不存在（exit 1 + W160013/W170000 + E200009）→ notFound，绝不
 *   当成空目录；
 * - 条目/字节越限 → tooLarge，不返回部分条目与伪总数；
 * - 其余失败按 BrowserError 分类。
 */
export async function readRemoteDirectory(
  svnPath: string,
  url: string,
  options: ReadRemoteDirectoryOptions,
): Promise<BrowseDirectoryResult> {
  const { revision, maxEntries, maxXmlBytes, ...runOptions } = options;
  const parser = new DirectoryListParser({ maxEntries, maxXmlBytes });
  const args = buildRemoteListArgs(url, revision);
  const scoped = withRemoteAuthScope(url, runOptions);
  const streamOptions: RunOptions = {
    ...scoped,
    onCredentialRetry: (retryArgs) => {
      parser.reset();
      return scoped.onCredentialRetry?.(retryArgs);
    },
  };
  try {
    await runOrThrowWithRunner(
      svnPath,
      args,
      streamOptions,
      (runnerPath, runnerArgs, runnerOptions = {}) => runStream(runnerPath, runnerArgs, {
        ...runnerOptions,
        onStdoutChunk: (chunk) => parser.write(chunk),
      }),
    );
    let listing: BrowseDirectoryListing;
    try {
      listing = parser.end();
    } catch (err) {
      // 尾块在 end 收口时才完成的条目同样可能触发条目预算。
      if (err instanceof BrowseLimitExceededError) {
        throw err;
      }
      return {
        status: 'error',
        error: {
          kind: 'parse',
          message: err instanceof Error ? err.message : String(err),
          codes: [],
        },
      };
    }
    return { status: 'ready', listing };
  } catch (err) {
    if (err instanceof BrowseLimitExceededError) {
      return {
        status: 'tooLarge',
        reason: err.reason,
        limit: err.limit,
        xmlBytes: parser.bytesRead,
        entriesParsed: parser.entryCount,
        error: { kind: 'tooLarge', message: err.message, codes: [] },
      };
    }
    const error = classifyBrowseFailure(err, url);
    return error.kind === 'notFound' ? { status: 'notFound', error } : { status: 'error', error };
  }
}

// ---------------------------------------------------------------------------
// 目录直属名称列表（无元数据 svn list，大目录两段式第一段）
// ---------------------------------------------------------------------------

/** 名称模式条目：只有名称与 kind，元数据由按需 info/后台补全得到。 */
export interface BrowseNameEntry {
  /** 原样名称：UTF-8、不 trim（SVN 禁止路径中的控制字符，故不存在内嵌换行）。 */
  name: string;
  /** 目录以输出行末尾的 `/` 判定，其余按文件。 */
  kind: 'file' | 'dir';
}

/** 一次无元数据目录读取的结果（total 为精确直属条目数）。 */
export interface BrowseDirectoryNames {
  entries: BrowseNameEntry[];
  total: number;
  /** 已读取的原始 stdout 字节数。 */
  bytes: number;
}

/**
 * 无元数据 `svn list` 输出解析器：每行一个条目，目录行以 `/` 结尾。
 *
 * 事实依据（本机 SVN 1.15 file:// 实测）：文件/目录名称原样 UTF-8 输出
 * （空格、`&`、中文、`@`、`#` 均不转义）；空目录输出为空；不存在路径
 * exit 1 + `W160013` + `E200009`，由调用方按退出码分类；SVN 禁止路径
 * 含控制字符（含换行，`E160005`），因此按 `\n` 分行是安全的——若真出现
 * 空行（输出损坏/异常），end 时按解析错误拒绝，不静默少计条目。
 *
 * 预算与 XML 模式一致（100k 条目 / 64 MiB 原始字节），越限抛
 * BrowseLimitExceededError；认证补录重试前调用 reset 清空状态。
 */
export class DirectoryNameListParser {
  private readonly decoder = new Utf8StreamDecoder();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private entries: BrowseNameEntry[] = [];
  private partial = '';
  private bytes = 0;
  private malformedLines = 0;

  constructor(limits: DirectoryListLimits = {}) {
    this.maxEntries = limits.maxEntries ?? REMOTE_BROWSE_MAX_ENTRIES;
    this.maxBytes = limits.maxXmlBytes ?? REMOTE_BROWSE_MAX_XML_BYTES;
  }

  /** 已读取的原始 stdout 字节数（含触发越限的块）。 */
  get bytesRead(): number {
    return this.bytes;
  }

  /** 已解析出的条目数（越限中止时为部分计数，仅用于诊断）。 */
  get entryCount(): number {
    return this.entries.length;
  }

  /** 清空全部状态（认证补录重试前调用，避免两次尝试的数据混合）。 */
  reset(): void {
    this.entries = [];
    this.partial = '';
    this.bytes = 0;
    this.malformedLines = 0;
  }

  /** 喂入一块原始 stdout 字节。 */
  write(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      throw new BrowseLimitExceededError('bytes', this.maxBytes);
    }
    this.consume(this.decoder.write(chunk));
  }

  /** 进程成功结束后收口：返回名称列表；异常空行按解析失败抛错。 */
  end(): BrowseDirectoryNames {
    this.consume(this.decoder.end());
    // 防御：最后一行未以换行结束时同样收口（正常 svn 会输出末尾换行）。
    if (this.partial.length > 0) {
      const tail = this.partial;
      this.partial = '';
      this.finishLine(tail);
    }
    if (this.malformedLines > 0) {
      throw new Error(`svn list output contains ${this.malformedLines} malformed empty line(s); refusing to parse as a name list`);
    }
    return { entries: this.entries, total: this.entries.length, bytes: this.bytes };
  }

  private consume(text: string): void {
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 0x0a) {
        this.finishLine(this.partial + text.slice(start, index));
        this.partial = '';
        start = index + 1;
      }
    }
    this.partial += text.slice(start);
  }

  private finishLine(rawLine: string): void {
    // Windows 客户端可能输出 CRLF；SVN 禁止名称含控制字符，尾部 CR 只可能
    // 来自行结束符，剥离后再判定目录后缀。
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      // 正常输出不会出现空行（名称不可能是空串、不能含换行）；记录后由
      // end 统一拒绝，避免把损坏输出当成完整精确总数。
      this.malformedLines += 1;
      return;
    }
    const isDir = line.endsWith('/');
    const name = isDir ? line.slice(0, -1) : line;
    if (name === '') {
      this.malformedLines += 1;
      return;
    }
    this.entries.push({ name, kind: isDir ? 'dir' : 'file' });
    if (this.entries.length > this.maxEntries) {
      throw new BrowseLimitExceededError('entries', this.maxEntries);
    }
  }
}

/** 纯解析入口：把内联 fixture 或已读字节按任意分块喂给名称列表解析器。 */
export function parseDirectoryNameList(
  input: string | Buffer | readonly Buffer[],
  limits: DirectoryListLimits = {},
): BrowseDirectoryNames {
  const parser = new DirectoryNameListParser(limits);
  const chunks: readonly Buffer[] = typeof input === 'string'
    ? [Buffer.from(input, 'utf8')]
    : Buffer.isBuffer(input)
      ? [input]
      : input;
  for (const chunk of chunks) {
    parser.write(chunk);
  }
  return parser.end();
}

/** 无元数据 `svn list --depth immediates` 命令参数；peg 与 -r 同为快照 revision。 */
export function buildRemoteNameListArgs(url: string, revision: number): string[] {
  return [
    'list',
    '--non-interactive',
    '--depth',
    'immediates',
    '-r',
    String(revision),
    '--',
    urlWithPeg(url, revision),
  ];
}

export interface ReadRemoteDirectoryNamesOptions extends RunOptions {
  /** 浏览快照 revision（来自节点 info 的 snapshotRevision）。 */
  revision: number;
  maxEntries?: number;
  maxXmlBytes?: number;
}

export type BrowseNameListResult =
  | { status: 'ready'; listing: BrowseDirectoryNames }
  | { status: 'notFound'; error: BrowserError }
  | {
      status: 'tooLarge';
      reason: 'entries' | 'bytes';
      limit: number;
      bytesRead: number;
      entriesParsed: number;
      error: BrowserError;
    }
  | { status: 'error'; error: BrowserError };

/**
 * 读取远端目录的直属名称与精确总数（无元数据 `svn list`，不加载
 * last-changed/author/date/size；实测 100k 条目 0.16 s）。
 *
 * 返回语义与 readRemoteDirectory 对齐：exit 0 且零条目 → ready（空目录，
 * total=0）；路径不存在（W160013/W170000 + E200009）→ notFound；条目或
 * 字节越限 → tooLarge，不返回部分名称与伪总数；其余失败按 BrowserError
 * 分类。认证失败经补录重试，重试前 reset 解析器。
 */
export async function readRemoteDirectoryNames(
  svnPath: string,
  url: string,
  options: ReadRemoteDirectoryNamesOptions,
): Promise<BrowseNameListResult> {
  const { revision, maxEntries, maxXmlBytes, ...runOptions } = options;
  const parser = new DirectoryNameListParser({ maxEntries, maxXmlBytes });
  const args = buildRemoteNameListArgs(url, revision);
  const scoped = withRemoteAuthScope(url, runOptions);
  const streamOptions: RunOptions = {
    ...scoped,
    onCredentialRetry: (retryArgs) => {
      parser.reset();
      return scoped.onCredentialRetry?.(retryArgs);
    },
  };
  try {
    await runOrThrowWithRunner(
      svnPath,
      args,
      streamOptions,
      (runnerPath, runnerArgs, runnerOptions = {}) => runStream(runnerPath, runnerArgs, {
        ...runnerOptions,
        onStdoutChunk: (chunk) => parser.write(chunk),
      }),
    );
    let listing: BrowseDirectoryNames;
    try {
      listing = parser.end();
    } catch (err) {
      // 末行无换行时条目在 end 收口才完成，同样可能触发条目/字节预算；
      // 与 readRemoteDirectory 同口径：越限不能被降级为 parse 错误。
      if (err instanceof BrowseLimitExceededError) {
        throw err;
      }
      return {
        status: 'error',
        error: {
          kind: 'parse',
          message: err instanceof Error ? err.message : String(err),
          codes: [],
        },
      };
    }
    return { status: 'ready', listing };
  } catch (err) {
    if (err instanceof BrowseLimitExceededError) {
      return {
        status: 'tooLarge',
        reason: err.reason,
        limit: err.limit,
        bytesRead: parser.bytesRead,
        entriesParsed: parser.entryCount,
        error: { kind: 'tooLarge', message: err.message, codes: [] },
      };
    }
    const error = classifyBrowseFailure(err, url);
    return error.kind === 'notFound' ? { status: 'notFound', error } : { status: 'error', error };
  }
}

// ---------------------------------------------------------------------------
// 节点 URL 构造（父节点原始 URL + 条目原始名称）
// ---------------------------------------------------------------------------

/**
 * 父节点原始 URL 追加一个条目名称：名称整段 encodeURIComponent（`@`→%40、
 * `#`→%23、空格→%20、中文→UTF-8 %XX），父 URL 末尾有/无 `/` 都正确拼接。
 * 结果仍是原始 URL；后续命令必须再经 urlWithPeg（%40 同样触发 peg 解析）。
 */
export function appendUrlSegment(parentRawUrl: string, name: string): string {
  const encoded = encodeURIComponent(name);
  return parentRawUrl.endsWith('/')
    ? `${parentRawUrl}${encoded}`
    : `${parentRawUrl}/${encoded}`;
}

/** 父节点仓库相对路径追加原始名称（POSIX 路径，不编码；根节点空串）。 */
export function appendRelativePath(parentRelativePath: string, name: string): string {
  return parentRelativePath === '' ? name : `${parentRelativePath}/${name}`;
}

/**
 * 由父节点身份与 list 条目构造子节点 RepoNodeRef：条目自身没有快照
 * revision，继承父节点；lastChangedRevision 缺失时回退父快照。
 */
export function entryNodeRef(parent: RepoNodeRef, entry: BrowseEntry): RepoNodeRef {
  const node: RepoNodeRef = {
    repositoryUuid: parent.repositoryUuid,
    repositoryRootUrl: parent.repositoryRootUrl,
    rawUrl: appendUrlSegment(parent.rawUrl, entry.name),
    relativePath: appendRelativePath(parent.relativePath, entry.name),
    snapshotRevision: parent.snapshotRevision,
    lastChangedRevision: entry.lastChangedRevision ?? parent.snapshotRevision,
    kind: entry.kind,
  };
  if (entry.lastChangedAuthor !== undefined) {
    node.lastChangedAuthor = entry.lastChangedAuthor;
  }
  if (entry.lastChangedDate !== undefined) {
    node.lastChangedDate = entry.lastChangedDate;
  }
  return node;
}

// ---------------------------------------------------------------------------
// 远端仓库属性（svn propget --xml）
// ---------------------------------------------------------------------------

const propertiesParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: false,
  htmlEntities: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name === 'target' || name === 'property',
});

interface PropertyXml {
  properties?: {
    target?: Array<{
      property?: Array<{ name?: string; '#text'?: string }>;
    }>;
  };
}

/** 属性读取结果：present 为属性值（可为空串）；absent 为属性不存在。 */
export type RemotePropertyRead =
  | { status: 'present'; value: string }
  | { status: 'absent' };

/** 解析 `svn propget --xml` 输出；未找到目标属性返回 undefined。 */
export function parseRemotePropertyXml(xml: string, propertyName: string): RemotePropertyRead | undefined {
  const parsed = propertiesParser.parse(xml) as PropertyXml;
  for (const target of parsed.properties?.target ?? []) {
    for (const property of target.property ?? []) {
      if (property.name === propertyName) {
        return { status: 'present', value: property['#text'] ?? '' };
      }
    }
  }
  return undefined;
}

/** `svn propget --xml <name>` 命令参数；快照 revision 同时作为 peg 与 -r。 */
export function buildRemotePropgetArgs(url: string, propertyName: string, revision?: number): string[] {
  const args = ['propget', '--xml', '--non-interactive'];
  if (revision !== undefined) {
    args.push('-r', String(revision));
  }
  args.push(propertyName, '--', urlWithPeg(url, revision));
  return args;
}

export interface ReadRemotePropertyOptions extends RunOptions {
  revision?: number;
}

export type RemotePropertyResult =
  | { status: 'present'; value: string }
  | { status: 'absent' }
  | { status: 'error'; error: BrowserError };

/**
 * 读取远端仓库属性（不读工作副本属性）。属性缺失是正常结果：
 * exit 1 + `W200017` + `E200000` → absent；其他非零退出按 BrowserError
 * 分类（info/list XML 都不返回仓库属性，mime 分类必须走本入口）。
 */
export async function readRemoteProperty(
  svnPath: string,
  url: string,
  propertyName: string,
  options: ReadRemotePropertyOptions = {},
): Promise<RemotePropertyResult> {
  const { revision, ...runOptions } = options;
  const args = buildRemotePropgetArgs(url, propertyName, revision);
  try {
    const result = await runOrThrow(svnPath, args, withRemoteAuthScope(url, runOptions));
    const parsed = parseRemotePropertyXml(result.stdout, propertyName);
    if (!parsed) {
      return {
        status: 'error',
        error: {
          kind: 'parse',
          message: `svn propget --xml output does not contain property ${propertyName}`,
          codes: [],
          exitCode: result.exitCode,
        },
      };
    }
    return parsed;
  } catch (err) {
    if (err instanceof SvnError) {
      const codes = extractSvnStatusCodes(`${err.stderr}\n${err.message}`);
      if (codes.includes('W200017')) {
        return { status: 'absent' };
      }
    }
    return { status: 'error', error: classifyBrowseFailure(err, url) };
  }
}

/** 读取 `svn:mime-type`（远端文件内容分类的第一判据）。 */
export function readRemoteMimeType(
  svnPath: string,
  url: string,
  options: ReadRemotePropertyOptions = {},
): Promise<RemotePropertyResult> {
  return readRemoteProperty(svnPath, url, 'svn:mime-type', options);
}

// ---------------------------------------------------------------------------
// 内容分类判据（纯逻辑）
// ---------------------------------------------------------------------------

/**
 * MIME 判据：`svn:mime-type` 存在且不以 `text/` 开头即二进制（大小写
 * 不敏感）。SVG 等 `image/*` 按非 text/* 判二进制，不设例外。
 */
export function mimeTypeIsBinary(mimeType: string): boolean {
  return !/^text\//i.test(mimeType);
}

/**
 * NUL 判据：传入字节的前 limit 字节（默认 8 KiB 探测窗口）内出现 0x00
 * 即二进制。UTF-16 文本因字符间 NUL 会在此判二进制（已知边界）。
 */
export function hasNulByte(data: Uint8Array, limit = BINARY_PROBE_BYTES): boolean {
  return data.subarray(0, limit).includes(0);
}

// ---------------------------------------------------------------------------
// 内容分类（MIME 判据 + NUL 判据）
// ---------------------------------------------------------------------------

export type RemoteContentKind = 'text' | 'binary';

/** 内容分类结果；reason 记录判定依据（mime/nul），none 表示两项都未命中。 */
export interface ContentClassification {
  kind: RemoteContentKind;
  reason: 'mime' | 'nul' | 'none';
  mimeType?: string;
}

/**
 * MIME/NUL 双重分类：MIME 非 `text/*` 直接二进制；否则看前 8 KiB 是否
 * 含 NUL。head 只应传探测窗口内的字节（调用方负责截断），UTF-16 文本
 * 会因字符间 NUL 判二进制。
 */
export function classifyContentKind(
  mimeType: string | undefined,
  head: Buffer | undefined,
): ContentClassification {
  if (mimeType !== undefined && mimeTypeIsBinary(mimeType)) {
    return { kind: 'binary', reason: 'mime', mimeType };
  }
  if (head !== undefined && hasNulByte(head)) {
    return { kind: 'binary', reason: 'nul', mimeType };
  }
  return { kind: 'text', reason: 'none', mimeType };
}
