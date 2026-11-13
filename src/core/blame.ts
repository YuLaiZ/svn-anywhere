/**
 * F108 行内追溯 / P6 逐行追溯的 `svn blame --xml` 执行与解析。core 模块，
 * 不依赖 vscode。
 *
 * 口径（技术方案 §4.7 与阶段 0 V5/V6 实测）：
 * - 当前工作文件必须执行**不带任何 -r** 的默认调用，行号才与当前工作文件
 *   对齐；显式 `-r 1:HEAD`/`-r BASE` 对工作副本按 BASE 内容输出，本地修改/
 *   新增后行号错位。P6 历史 revision 对解析后的 URL 使用明确 revision。
 * - 本地路径按 workspace.escapePeg（尾部补 @）转义，远端 URL 按 svnCli.
 *   urlWithPeg 构造（含字面 @ 的 URL 必须补 peg，无 revision 也追加空 peg）。
 * - XML 每行 `<entry line-number>`；`<commit>` 可缺失（本地修改/新增行 →
 *   「未提交/未归属」），`<author>` 可整体缺失；`<date>` 为 ISO8601 UTC。
 * - 解析不得使用 fast-xml-parser 一次性 DOM（阶段 0：10 MiB XML 1.2 s，
 *   超 50 ms 阈值 24 倍）；这里用 runStream + StringDecoder('utf8') +
 *   saxes 流式分片解析，只在内存保留每行的小对象，进程管道块边界自然
 *   让出事件循环。
 * - blame XML 体积约为工作文件 2.18 倍，输出字节上限默认 64 MiB；超限
 *   不返回部分行，映射为 notTraceable('tooLarge')。2 GiB 临时文件上限仅
 *   适用远端 runToFile，不适用于本链路。
 * - 二进制 `blame` 为「空 <blame/> + rc0 + stderr Skipping binary file」
 *   的不可追溯结果，不能当作 0 行文件；空文件是「有 <target>、无 entry」。
 *   二进制跳过行为不稳定、`svn rm` 未提交的 missing 文件仍返回 BASE 归属，
 *   入口必须由宿先用 svn:mime-type/NUL 探测与 status 预判（remoteContent），
 *   本模块只按 stderr 警告做兜底映射。
 * - 错误路径的 stdout 多为未闭合 XML（本地新增 E195002、已删除 revision
 *   W160013、目录 W160017、路径不存在 W155010），必须先按退出码分流再
 *   解析，不能把半截 XML 当结果；认证/权限/网络错误原样抛 SvnError。
 */
import { SaxesParser } from 'saxes';
import { SvnError, extractSvnErrorCodes, tailText } from './errors';
import { runStream, urlWithPeg, Utf8StreamDecoder, type RunOptions, type RunStreamResult } from './svnCli';
import { escapePeg } from './workspace';

/** blame XML 默认输出字节上限：64 MiB（工作文件的约 2.18 倍）。 */
export const BLAME_XML_BYTE_LIMIT = 64 * 1024 * 1024;

/** 单行归属；本地修改/新增行没有 commit，revision/author/date 均缺省。 */
export interface BlameLine {
  /** 1-based 行号，来自 entry@line-number。 */
  lineNumber: number;
  /** `<commit revision>`；无 commit 的本地修改/新增行为 undefined。 */
  revision?: number;
  /** `<author>`；revprop 删除后整体缺失，为 undefined。 */
  author?: string;
  /** `<date>` 原始 ISO8601 字符串（UTC，展示时由宿主格式化）。 */
  date?: string;
}

/** 可追溯结果：空文件是 ready + 0 行（有 <target> 无 entry）。 */
export interface BlameReady {
  state: 'ready';
  /** `<target path>`；调用方据此核对目标（本地为工作副本相对路径，URL 为完整 URL）。 */
  targetPath?: string;
  lines: BlameLine[];
}

/** 不可追溯原因（二进制/无提交版本/不存在/非文件/超限）。 */
export type BlameNotTraceableReason =
  | 'binary'
  | 'noCommittedRevision'
  | 'notFound'
  | 'directory'
  | 'tooLarge';

export interface BlameNotTraceable {
  state: 'notTraceable';
  reason: BlameNotTraceableReason;
  /** 原始 stderr 诊断信息（截断后）。 */
  detail?: string;
}

export type BlameResult = BlameReady | BlameNotTraceable;

/** blame 调用入参。 */
export interface BlameParams {
  /** 本地工作文件路径，或 remote=true 时的原始 URL（不含 peg）。 */
  target: string;
  /** true 表示 target 是远端 URL（P6 历史快照）；false 为本地工作文件。 */
  remote?: boolean;
  /**
   * 远端明确 revision（P6 历史 revision）。本地工作文件必须省略：实测
   * 任何 -r 都会按 BASE 内容输出、与工作文件行号错位，因此本地传入
   * revision 直接拒绝（契约违规，不静默忽略）。
   */
  revision?: number;
  /** XML 输出字节上限，默认 BLAME_XML_BYTE_LIMIT（测试可调）。 */
  maxBytes?: number;
}

/**
 * 构造 blame 命令参数（导出供测试断言本地调用不含任何 -r）：
 * - 本地：`blame --xml --non-interactive -- <escapePeg(target)>`；
 * - 远端：`blame --xml --non-interactive [-r <rev>] -- <urlWithPeg(url, rev)>`。
 */
export function buildBlameArgs(params: BlameParams): string[] {
  const base = ['blame', '--xml', '--non-interactive'];
  if (params.remote) {
    const args = [...base];
    if (params.revision !== undefined) {
      args.push('-r', String(params.revision));
    }
    // 统一 peg 构造：无 revision 时也必须追加空 peg，含 @ 的 URL 不能裸露。
    args.push('--', urlWithPeg(params.target, params.revision));
    return args;
  }
  if (params.revision !== undefined) {
    throw new Error('本地工作文件 blame 不允许指定 revision：必须使用不带 -r 的默认调用，行号才与工作文件对齐');
  }
  return [...base, '--', escapePeg(params.target)];
}

interface BlameEntryState {
  lineNumber?: number;
  revision?: number;
  author?: string;
  date?: string;
}

/**
 * 流式 blame XML 解析器：`feed` 可接收任意分块的文本（调用方用
 * Utf8StreamDecoder 跨字节块解码）；只在内存保留每行小对象。
 * `end` 关闭 XML 文档并返回 target 路径与行归属。
 */
export class BlameXmlParser {
  private readonly parser = new SaxesParser({ xmlns: false });
  private readonly lines: BlameLine[] = [];
  private bytes = 0;
  private targetPath: string | undefined;
  private current: BlameEntryState | undefined;
  private activeField: 'author' | 'date' | undefined;
  private buffer = '';
  private readonly maxBytes: number;

  constructor(options: { maxBytes?: number } = {}) {
    this.maxBytes = options.maxBytes ?? BLAME_XML_BYTE_LIMIT;
    this.parser.on('opentag', (tag) => {
      switch (tag.name) {
        case 'target':
          if (tag.attributes.path !== undefined) {
            this.targetPath = tag.attributes.path;
          }
          break;
        case 'entry':
          this.current = { lineNumber: toNumber(tag.attributes['line-number']) };
          break;
        case 'commit':
          if (this.current) {
            this.current.revision = toNumber(tag.attributes.revision);
          }
          break;
        case 'author':
          this.activeField = 'author';
          this.buffer = '';
          break;
        case 'date':
          this.activeField = 'date';
          this.buffer = '';
          break;
        default:
          break;
      }
    });
    this.parser.on('text', (text) => {
      if (this.activeField !== undefined) {
        this.buffer += text;
      }
    });
    this.parser.on('cdata', (text) => {
      if (this.activeField !== undefined) {
        this.buffer += text;
      }
    });
    this.parser.on('closetag', (tag) => {
      switch (tag.name) {
        case 'author':
          if (this.current) {
            this.current.author = this.buffer;
          }
          this.activeField = undefined;
          break;
        case 'date':
          if (this.current) {
            this.current.date = this.buffer;
          }
          this.activeField = undefined;
          break;
        case 'entry':
          if (this.current) {
            this.push(this.current);
            this.current = undefined;
          }
          break;
        default:
          break;
      }
    });
  }

  private push(state: BlameEntryState): void {
    // line-number 应连续 1..N；缺失时按已收集行数顺序补齐，避免装饰错位。
    const lineNumber = state.lineNumber ?? this.lines.length + 1;
    const line: BlameLine = { lineNumber };
    if (state.revision !== undefined) {
      line.revision = state.revision;
    }
    if (state.author !== undefined) {
      line.author = state.author;
    }
    if (state.date !== undefined) {
      line.date = state.date;
    }
    this.lines.push(line);
  }

  /** 喂入一段已解码文本；累计字节超过上限时抛 BlameBudgetError。 */
  feed(text: string): void {
    this.bytes += Buffer.byteLength(text, 'utf8');
    if (this.bytes > this.maxBytes) {
      throw new BlameBudgetError();
    }
    this.parser.write(text);
  }

  end(): { targetPath?: string; lines: BlameLine[] } {
    this.parser.close();
    return { targetPath: this.targetPath, lines: this.lines };
  }
}

/** blame 输出超过字节上限；由驱动层映射为 notTraceable('tooLarge')。 */
export class BlameBudgetError extends Error {
  constructor() {
    super('blame XML 输出超过字节上限');
    this.name = 'BlameBudgetError';
  }
}

/** 解析整段 blame XML（小数据/测试用；生产走 BlameXmlParser 流式）。 */
export function parseBlameXml(xml: string, maxBytes = BLAME_XML_BYTE_LIMIT): BlameReady {
  const parser = new BlameXmlParser({ maxBytes });
  parser.feed(xml);
  const parsed = parser.end();
  const result: BlameReady = { state: 'ready', lines: parsed.lines };
  if (parsed.targetPath !== undefined) {
    result.targetPath = parsed.targetPath;
  }
  return result;
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** 是否属于「路径在该 revision 不存在」类失败（不是认证/网络/权限）。 */
function isNotExistFailure(text: string): boolean {
  return /\b(?:W155010|W160013|E160013)\b/.test(text);
}

/** 是否属于「目标是目录、不是文件」类失败（W160017 + E200009）。 */
function isDirectoryFailure(text: string): boolean {
  return /\bW160017\b/.test(text);
}

/**
 * 执行 `svn blame --xml` 并流式解析。
 *
 * 返回：
 * - ready：逐行 revision/author/date（本地修改/新增行缺 commit）；
 * - notTraceable：二进制（rc0 + Skipping 警告）、本地新增无提交版本
 *   (E195002)、删除 revision/不存在路径（W160013/W155010）、目录
 *   (W160017)、输出超过 maxBytes；
 * - 认证/权限/网络及其他非预期失败抛 SvnError（stderr/code 原样保留）。
 */
export async function runBlame(
  svnPath: string,
  params: BlameParams,
  options: RunOptions = {},
): Promise<BlameResult> {
  const args = buildBlameArgs(params);
  const parser = new BlameXmlParser({ maxBytes: params.maxBytes });
  const decoder = new Utf8StreamDecoder();
  let result: RunStreamResult;
  try {
    result = await runStream(svnPath, args, {
      ...options,
      onStdoutChunk: (chunk) => {
        parser.feed(decoder.write(chunk));
      },
    });
  } catch (err) {
    if (err instanceof BlameBudgetError) {
      return { state: 'notTraceable', reason: 'tooLarge', detail: err.message };
    }
    if (err instanceof SvnError) {
      throw err;
    }
    throw new SvnError({
      message: `blame XML 解析失败：${err instanceof Error ? err.message : String(err)}`,
      command: args,
      cwd: options.cwd,
      code: 'XML_PARSE',
    });
  }

  if (result.exitCode !== 0) {
    const text = `${result.stderr}\n`;
    if (text.includes('E195002')) {
      return {
        state: 'notTraceable',
        reason: 'noCommittedRevision',
        detail: tailText(result.stderr),
      };
    }
    if (isDirectoryFailure(text)) {
      return { state: 'notTraceable', reason: 'directory', detail: tailText(result.stderr) };
    }
    if (isNotExistFailure(text)) {
      return { state: 'notTraceable', reason: 'notFound', detail: tailText(result.stderr) };
    }
    throw new SvnError({
      message: tailText(result.stderr.trim() || `svn blame 退出码 ${result.exitCode}`),
      command: args,
      cwd: options.cwd,
      exitCode: result.exitCode,
      stderr: tailText(result.stderr),
      code: extractSvnErrorCodes(result.stderr)[0],
    });
  }

  let parsed: { targetPath?: string; lines: BlameLine[] };
  try {
    const tail = decoder.end();
    if (tail !== '') {
      parser.feed(tail);
    }
    parsed = parser.end();
  } catch (err) {
    if (err instanceof BlameBudgetError) {
      return { state: 'notTraceable', reason: 'tooLarge', detail: err.message };
    }
    throw new SvnError({
      message: `blame XML 解析失败：${err instanceof Error ? err.message : String(err)}`,
      command: args,
      cwd: options.cwd,
      code: 'XML_PARSE',
    });
  }

  // 二进制跳过是「成功但空结果 + 警告」：不能当作 0 行文件（阶段 0 V6）。
  if (/Skipping binary file/i.test(result.stderr)) {
    return { state: 'notTraceable', reason: 'binary', detail: tailText(result.stderr) };
  }

  const ready: BlameReady = { state: 'ready', lines: parsed.lines };
  if (parsed.targetPath !== undefined) {
    ready.targetPath = parsed.targetPath;
  }
  return ready;
}
