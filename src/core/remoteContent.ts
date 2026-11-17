/**
 * 远端文件内容的 core 原语：MIME/NUL 双重分类、文本内嵌读取、runToFile
 * 临时资源与降级状态。core 模块，不依赖 vscode。
 *
 * 口径（远端资源纪律，真实 svn 实测）：
 * - `svn cat` 必须真流式：文本内嵌读取经 runStream 不累计整段、按字节
 *   计数到 16 MiB 上限即终止；二进制/大文本经 runToFile 直接管道到
 *   `.part`，宿主内存峰值与文件大小无关（256 MiB 实测父进程约 24 MiB
 *   增量）；不得先把内容累计为 Buffer[] 或字符串。
 * - 分类规则：`svn info --xml`/`list --xml` 都不返回仓库属性，先经
 *   remoteBrowse.readRemoteMimeType 读取 `svn:mime-type`（缺失为
 *   正常的“无 mime”）；MIME 非 `text/*` 即二进制（MIME 判据）；否则读
 *   内容前 8 KiB，含 NUL 即二进制（NUL 判据）；两项都不命中才是文本。
 *   已知限制：NUL 探测窗口为前 8 KiB，UTF-16 文本因字符间 NUL 判二进制；
 *   任一判据命中都禁用文本差异与逐行追溯。
 * - 文本且不大于 16 MiB：用现有编码回退链（core/encoding）解码，交给
 *   只读 TextDocumentContentProvider；文本大于 16 MiB 不加载内置文本
 *   编辑器，改为临时文件并给系统应用打开入口。
 * - 二进制或大文本临时文件上限 2 GiB，且目标目录可用空间至少为文件
 *   大小 + 64 MiB；超过上限不启动 cat，运行中越限立即终止并删除半文件；
 *   降级状态为 OUTPUT_TOO_LARGE / INSUFFICIENT_DISK，取消/超时沿用既有
 *   错误码。
 * - 失败分类复用 remoteBrowse.classifyBrowseFailure，与浏览界面同一套
 *   auth/permission/network/notFound 语义。
 */
import { DEFAULT_ENCODING_FALLBACK, DEFAULT_OUTPUT_ENCODING, decodeBuffer } from './encoding';
import {
  INSUFFICIENT_DISK,
  OUTPUT_TOO_LARGE,
  SvnError,
  assertSuccess,
  classifyAuthFailure,
} from './errors';
import {
  BINARY_PROBE_BYTES,
  classifyBrowseFailure,
  classifyContentKind,
  mimeTypeIsBinary,
  readRemoteMimeType,
  withRemoteAuthScope,
  type BrowserError,
  type ContentClassification,
  type RemoteContentKind,
} from './remoteBrowse';
import {
  DEFAULT_DISK_HEADROOM_BYTES,
  DEFAULT_MAX_OUTPUT_FILE_BYTES,
  runOrThrowWithRunner,
  runStream,
  runToFile,
  urlWithPeg,
  type AuthCredentials,
  type RunOptions,
  type RunToFileOptions,
  type RunToFileResult,
} from './svnCli';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 文本内嵌预览上限：16 MiB（超过则改用临时文件外部打开）。 */
export const REMOTE_INLINE_TEXT_MAX_BYTES = 16 * 1024 * 1024;

/** 远端临时文件上限：2 GiB（复用 svnCli 的 runToFile 默认值）。 */
export const REMOTE_TEMP_FILE_MAX_BYTES = DEFAULT_MAX_OUTPUT_FILE_BYTES;

/** 临时目录磁盘余量要求：文件大小 + 64 MiB（复用 svnCli 默认值）。 */
export const REMOTE_DISK_HEADROOM_BYTES = DEFAULT_DISK_HEADROOM_BYTES;

/** 内容探测窗口：前 8 KiB（与 remoteBrowse.BINARY_PROBE_BYTES 同一口径）。 */
export const REMOTE_CONTENT_PROBE_BYTES = BINARY_PROBE_BYTES;

// 分类判据与类型定义在 remoteBrowse（浏览详情与内容打开共用同一套语义），
// 这里原样转出，调用方从本模块导入即可。
export { classifyContentKind };
export type { ContentClassification, RemoteContentKind };

// ---------------------------------------------------------------------------
// svn cat 命令形态
// ---------------------------------------------------------------------------

/** `svn cat -r <rev> -- <URL@rev>` 命令参数。 */
export function buildRemoteCatArgs(url: string, revision: number): string[] {
  return ['cat', '-r', String(revision), '--non-interactive', '--', urlWithPeg(url, revision)];
}

// ---------------------------------------------------------------------------
// 内容探测（mime + 前 8 KiB）
// ---------------------------------------------------------------------------

export interface ProbeRemoteContentOptions extends RunOptions {
  /** 快照 revision（浏览快照固定值）。 */
  revision: number;
  /** 探测窗口字节数，默认 8 KiB。 */
  probeBytes?: number;
}

export type RemoteContentProbeResult =
  | {
      status: 'probed';
      classification: ContentClassification;
      /** 实际读取的内容头字节数；MIME 已判二进制时为 0（不再 cat）。 */
      headBytes: number;
    }
  | { status: 'notFound'; error: BrowserError }
  | { status: 'error'; error: BrowserError };

/** 探测窗口读满后用于主动终止 svn cat 的哨兵错误（不作为失败上报）。 */
class ProbeWindowReached extends Error {
  constructor() {
    super('内容探测窗口已读满');
    this.name = 'ProbeWindowReached';
  }
}

/**
 * 读取远端文件的前 limit 字节：读满窗口立即抛哨兵终止 cat（既有的
 * 探测方式），整文件小于窗口时随进程正常结束返回全部字节。非零退出
 * 由 runOrThrowWithRunner 转成 SvnError，交给调用方分类；认证补录重试
 * 前清空已读字节。
 */
async function readRemoteHeadBytes(
  svnPath: string,
  url: string,
  revision: number,
  limit: number,
  runOptions: RunOptions,
): Promise<Buffer> {
  const args = buildRemoteCatArgs(url, revision);
  const marker = new ProbeWindowReached();
  const chunks: Buffer[] = [];
  let total = 0;
  const scoped = withRemoteAuthScope(url, runOptions);
  const streamOptions: RunOptions = {
    ...scoped,
    onCredentialRetry: (retryArgs) => {
      chunks.length = 0;
      total = 0;
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
        onStdoutChunk: (chunk) => {
          const remaining = limit - total;
          if (remaining > 0) {
            const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
            // 复制切片，避免保留整个 64 KiB 级 stdout 块。
            chunks.push(Buffer.from(slice));
            total += slice.length;
          }
          if (total >= limit) {
            throw marker;
          }
        },
      }),
    );
    return Buffer.concat(chunks, total);
  } catch (err) {
    if (err === marker) {
      return Buffer.concat(chunks, total);
    }
    throw err;
  }
}

/**
 * 远端文件内容探测：先读 `svn:mime-type`（属性缺失视为无 mime），MIME
 * 已判二进制时不再 cat；否则读前 8 KiB 做 NUL 判定。
 */
export async function probeRemoteContent(
  svnPath: string,
  url: string,
  options: ProbeRemoteContentOptions,
): Promise<RemoteContentProbeResult> {
  const { revision, probeBytes, ...runOptions } = options;
  const mime = await readRemoteMimeType(svnPath, url, { ...runOptions, revision });
  if (mime.status === 'error') {
    return mime.error.kind === 'notFound'
      ? { status: 'notFound', error: mime.error }
      : { status: 'error', error: mime.error };
  }
  const mimeType = mime.status === 'present' ? mime.value : undefined;
  if (mimeType !== undefined && mimeTypeIsBinary(mimeType)) {
    return {
      status: 'probed',
      classification: { kind: 'binary', reason: 'mime', mimeType },
      headBytes: 0,
    };
  }
  const limit = probeBytes ?? REMOTE_CONTENT_PROBE_BYTES;
  try {
    const head = await readRemoteHeadBytes(svnPath, url, revision, limit, runOptions);
    return {
      status: 'probed',
      classification: classifyContentKind(mimeType, head),
      headBytes: head.length,
    };
  } catch (err) {
    const error = classifyBrowseFailure(err, url);
    return error.kind === 'notFound'
      ? { status: 'notFound', error }
      : { status: 'error', error };
  }
}

// ---------------------------------------------------------------------------
// 文本内嵌读取（runStream + 编码回退链）
// ---------------------------------------------------------------------------

/** 文本读取超过内嵌上限：从 stdout 回调抛出以终止 svn cat。 */
class RemoteTextTooLargeError extends Error {
  readonly limitBytes: number;
  readonly bytesRead: number;

  constructor(limitBytes: number, bytesRead: number) {
    super(`远端文本超过 ${limitBytes} 字节内嵌上限，已终止读取`);
    this.name = 'RemoteTextTooLargeError';
    this.limitBytes = limitBytes;
    this.bytesRead = bytesRead;
  }
}

/** 内嵌文本的字节累积器：按块计数，越限立即抛错（不保留越限块）。 */
class TextChunkAccumulator {
  private chunks: Buffer[] = [];
  private total = 0;
  private readonly limitBytes: number;

  constructor(limitBytes: number) {
    this.limitBytes = limitBytes;
  }

  get bytesRead(): number {
    return this.total;
  }

  reset(): void {
    this.chunks = [];
    this.total = 0;
  }

  write(chunk: Buffer): void {
    if (this.total + chunk.length > this.limitBytes) {
      throw new RemoteTextTooLargeError(this.limitBytes, this.total + chunk.length);
    }
    this.chunks.push(Buffer.from(chunk));
    this.total += chunk.length;
  }

  buffer(): Buffer {
    return Buffer.concat(this.chunks, this.total);
  }
}

export interface ReadRemoteTextOptions extends RunOptions {
  /** 快照 revision（浏览快照固定值）。 */
  revision: number;
  /** 内嵌文本字节上限，默认 16 MiB。 */
  maxBytes?: number;
}

export type RemoteTextResult =
  | {
      status: 'text';
      text: string;
      bytes: number;
      /** 实际解码成功的编码 label（回退命中时为回退编码）。 */
      encoding: string;
      fellBack: boolean;
      /** 回退链全部失败、按 UTF-8 宽松解码（文本含 U+FFFD）。 */
      lenient: boolean;
    }
  | { status: 'tooLarge'; limitBytes: number; bytesRead: number }
  | { status: 'notFound'; error: BrowserError }
  | { status: 'error'; error: BrowserError };

/**
 * 读取远端文本内容（≤ maxBytes）：stdout 不累计整段，只在内存保留
 * 不超过上限的字节；成功后用现有编码回退链解码（与 svnCli 整段输出同一
 * 语义）。认证失败经补录重试，重试前清空已累计字节。
 */
export async function readRemoteText(
  svnPath: string,
  url: string,
  options: ReadRemoteTextOptions,
): Promise<RemoteTextResult> {
  const { revision, maxBytes, ...runOptions } = options;
  const limitBytes = maxBytes ?? REMOTE_INLINE_TEXT_MAX_BYTES;
  const accumulator = new TextChunkAccumulator(limitBytes);
  const args = buildRemoteCatArgs(url, revision);
  const scoped = withRemoteAuthScope(url, runOptions);
  const streamOptions: RunOptions = {
    ...scoped,
    onCredentialRetry: (retryArgs) => {
      accumulator.reset();
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
        onStdoutChunk: (chunk) => accumulator.write(chunk),
      }),
    );
  } catch (err) {
    if (err instanceof RemoteTextTooLargeError) {
      return { status: 'tooLarge', limitBytes: err.limitBytes, bytesRead: err.bytesRead };
    }
    const error = classifyBrowseFailure(err, url);
    return error.kind === 'notFound'
      ? { status: 'notFound', error }
      : { status: 'error', error };
  }
  const buffer = accumulator.buffer();
  const primary = runOptions.encoding ?? DEFAULT_OUTPUT_ENCODING;
  const fallback = runOptions.encodingFallback ?? DEFAULT_ENCODING_FALLBACK;
  const decoded = decodeBuffer(buffer, primary, fallback);
  if (decoded.lenient) {
    runOptions.onDecodingFallback?.({ source: 'stdout', primary, fallback });
  }
  return {
    status: 'text',
    text: decoded.text,
    bytes: buffer.length,
    encoding: decoded.encoding,
    fellBack: decoded.fellBack,
    lenient: decoded.lenient,
  };
}

// ---------------------------------------------------------------------------
// 打开方式规划（内嵌文本 / 临时文件外部打开 / 超过上限）
// ---------------------------------------------------------------------------

export interface RemoteContentOpenInput {
  kind: RemoteContentKind;
  /** 已知文件大小（info 的 entry@size / list 的 size）；未知时省略。 */
  sizeBytes?: number;
}

export type RemoteContentOpenPlan =
  | { mode: 'inlineText'; maxInlineBytes: number }
  | {
      mode: 'externalTempFile';
      reason: 'binary' | 'textTooLarge';
      sizeBytes?: number;
      maxFileBytes: number;
    }
  | { mode: 'tooLarge'; sizeBytes: number; limitBytes: number };

/**
 * 根据内容分类与已知大小选择打开方式：
 * - 二进制（任意大小，含大小未知）→ 临时文件交系统应用（2 GiB 上限内
 *   runToFile 运行中兜底）；
 * - 文本 > 16 MiB → 临时文件，页面明确“文件过大，未使用内置文本预览”；
 * - 文本 ≤ 16 MiB（或大小未知）→ 内嵌只读文本，读取时按 16 MiB 兜底；
 * - 已知大小 > 2 GiB → tooLarge，不启动 cat。
 */
export function planRemoteContentOpen(input: RemoteContentOpenInput): RemoteContentOpenPlan {
  const { kind, sizeBytes } = input;
  if (sizeBytes !== undefined && sizeBytes > REMOTE_TEMP_FILE_MAX_BYTES) {
    return { mode: 'tooLarge', sizeBytes, limitBytes: REMOTE_TEMP_FILE_MAX_BYTES };
  }
  if (kind === 'binary') {
    return {
      mode: 'externalTempFile',
      reason: 'binary',
      sizeBytes,
      maxFileBytes: REMOTE_TEMP_FILE_MAX_BYTES,
    };
  }
  if (sizeBytes !== undefined && sizeBytes > REMOTE_INLINE_TEXT_MAX_BYTES) {
    return {
      mode: 'externalTempFile',
      reason: 'textTooLarge',
      sizeBytes,
      maxFileBytes: REMOTE_TEMP_FILE_MAX_BYTES,
    };
  }
  return { mode: 'inlineText', maxInlineBytes: REMOTE_INLINE_TEXT_MAX_BYTES };
}

// ---------------------------------------------------------------------------
// runToFile 下载（2 GiB / 磁盘余量预检与降级状态）
// ---------------------------------------------------------------------------

export interface DownloadRemoteFileOptions
  extends Omit<RunToFileOptions, 'expectedBytes' | 'maxBytes' | 'headroomBytes'> {
  /** 快照 revision（浏览快照固定值）。 */
  revision: number;
  /** 已知文件大小（info 的 entry@size）；提供时启动前做精确预算与磁盘预检。 */
  expectedBytes?: number;
  /** 输出字节上限，默认 2 GiB。 */
  maxBytes?: number;
  /** 磁盘余量要求，默认 64 MiB。 */
  headroomBytes?: number;
}

export type RemoteFileDownloadResult =
  | { status: 'downloaded'; filePath: string; bytesWritten: number }
  | { status: 'tooLarge'; limitBytes: number; expectedBytes?: number; message: string }
  | { status: 'insufficientDisk'; message: string }
  | { status: 'notFound'; error: BrowserError }
  | { status: 'error'; error: BrowserError };

/** 凭据按 runOrThrow 的同一规则注入：`--` 之前，保持位置参数在尾部。 */
function injectCredentialArgs(args: string[], credentials: AuthCredentials): string[] {
  const pair = ['--username', credentials.username, '--password', credentials.password];
  const separator = args.indexOf('--');
  return separator >= 0
    ? [...args.slice(0, separator), ...pair, ...args.slice(separator)]
    : [...args, ...pair];
}

/**
 * runToFile + 认证补录：runToFile 把非零退出码当业务结果返回，认证失败
 * 也走该分支；仅在 classifyAuthFailure 判为 auth 且调用方提供
 * getCredentials 时注入凭据重试一次。重试前 runToFile 已删除首个 .part。
 */
async function runToFileWithAuthRetry(
  svnPath: string,
  args: string[],
  options: RunToFileOptions,
): Promise<RunToFileResult> {
  const first = await runToFile(svnPath, args, options);
  if (first.exitCode === 0 || options.getCredentials === undefined) {
    return first;
  }
  if (classifyAuthFailure(first.stderr, options.authScope?.scheme) !== 'auth') {
    return first;
  }
  const credentials = await options.getCredentials(options.authScope);
  if (!credentials) {
    return first;
  }
  const retryArgs = injectCredentialArgs(args, credentials);
  // 与 svnCli.runOrThrowWithRunner 一致：宿主 logCommand 可返回重试执行的
  // 退出记录器（命令行脱敏与真实耗时用重试命令那一行）。
  const retryExit = options.onCredentialRetry?.(retryArgs);
  const retryOptions = typeof retryExit === 'function'
    ? { ...options, onExit: retryExit }
    : options;
  return runToFile(svnPath, retryArgs, retryOptions);
}

/**
 * 把远端文件流式下载到目标临时文件（`.part` 成功后原子改名）。
 *
 * - 已知 expectedBytes 超过 maxBytes 或磁盘余量不足：不启动 cat，直接
 *   返回 tooLarge / insufficientDisk；
 * - 运行中超过 maxBytes：终止进程组、删除 `.part` 并返回 tooLarge；
 * - 写盘 ENOSPC/EDQUOT：返回 insufficientDisk；
 * - 路径不存在（cat 的 W160013 + E200009）→ notFound；
 * - 取消/超时与其他失败 → error（BrowserError 分类）。
 */
export async function downloadRemoteFile(
  svnPath: string,
  url: string,
  options: DownloadRemoteFileOptions,
): Promise<RemoteFileDownloadResult> {
  const { revision, expectedBytes, maxBytes, headroomBytes, ...rest } = options;
  const limitBytes = maxBytes ?? REMOTE_TEMP_FILE_MAX_BYTES;
  const args = buildRemoteCatArgs(url, revision);
  const fileOptions: RunToFileOptions = {
    ...withRemoteAuthScope(url, rest),
    targetPath: rest.targetPath,
    maxBytes: limitBytes,
    headroomBytes: headroomBytes ?? REMOTE_DISK_HEADROOM_BYTES,
  };
  if (expectedBytes !== undefined) {
    fileOptions.expectedBytes = expectedBytes;
  }
  try {
    const result = await runToFileWithAuthRetry(svnPath, args, fileOptions);
    assertSuccess(result, args, rest.cwd);
    return {
      status: 'downloaded',
      filePath: result.filePath ?? rest.targetPath,
      bytesWritten: result.bytesWritten,
    };
  } catch (err) {
    if (err instanceof SvnError) {
      if (err.code === OUTPUT_TOO_LARGE) {
        return { status: 'tooLarge', limitBytes, expectedBytes, message: err.message };
      }
      if (err.code === INSUFFICIENT_DISK) {
        return { status: 'insufficientDisk', message: err.message };
      }
    }
    const error = classifyBrowseFailure(err, url);
    return error.kind === 'notFound'
      ? { status: 'notFound', error }
      : { status: 'error', error };
  }
}
