/**
 * svn 命令执行层。core 模块，不依赖 vscode。
 *
 * 约定：
 * - 永远用参数数组 spawn，不拼 shell 字符串；
 * - 环境统一 UTF-8，避免 svn 输出本地化与编码问题；
 * - run/runStream/runToFile 只在进程级失败（找不到可执行文件、超时、被取消、
 *   输出超限、磁盘不足）时抛 SvnError；退出码非零属于业务结果，由调用方用
 *   runOrThrow/assertSuccess 决定是否中断；
 * - 所有包含命令与 args 的错误消息都经过 redactArgs，--password 不进明文。
 */
import { workspaceLeasesForCommand } from './workspaceLock';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_ENCODING_FALLBACK, DEFAULT_OUTPUT_ENCODING, decodeBuffer, type DecodingFallbackNotice } from './encoding';
import { INSUFFICIENT_DISK, OUTPUT_TOO_LARGE, SvnError, assertSuccess, classifyAuthFailure, extractSvnErrorCodes, tailText } from './errors';
import { redactArgs } from './redact';

export const DEFAULT_TIMEOUT_MS = 120_000;

/** runToFile 的默认输出上限：2 GiB（远端 cat 临时资源）。 */
export const DEFAULT_MAX_OUTPUT_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/** runToFile 的默认磁盘余量：目标目录可用空间至少为预期大小加 64 MiB。 */
export const DEFAULT_DISK_HEADROOM_BYTES = 64 * 1024 * 1024;

/** 超时/取消后先 SIGTERM，进程仍未退出时再等这么久发 SIGKILL。 */
const SIGKILL_GRACE_MS = 3_000;

export interface AuthCredentials {
  username: string;
  password: string;
}

/**
 * 凭据补录的作用域：host 级单飞协调器按
 * scheme + host + port 共享同一凭据 Promise，同源并发失败只弹一次框。
 * port 为显式或协议默认端口（见 authScopeOfUrl），保证同源 key 稳定。
 */
export interface AuthScope {
  scheme: 'http' | 'https' | 'svn';
  host: string;
  port?: number;
}

export interface RunOptions {
  /** 工作目录，默认继承当前进程。 */
  cwd?: string;
  /** 超时毫秒数；超时后 kill 进程并抛 SvnError。默认 120 秒，0 表示不限时。 */
  timeoutMs?: number;
  /** 远端只读查询的有限传输重试。仅 info/list/log 可以启用。 */
  retryReadOnly?: { delayMs?: number; onRetry?: (error: SvnError) => void };
  /** 取消信号；宿主负责从 vscode.CancellationToken 桥接。 */
  signal?: AbortSignal;
  /**
   * 输出回调：进程结束后按编码回退链解码出的整段文本（stdout、stderr
   * 各一次；解码收口在 svnCli，面板与命令拿到的都是已解码字符串）。
   * 建议配合 LineBuffer 按行脱敏。runStream/runToFile 不累计 stdout，
   * 该回调只会收到 stderr 整段。
   */
  onOutput?: (chunk: string, source: 'stdout' | 'stderr') => void;
  /**
   * 进程运行中 stdout 逐块回调：spawn 的 data 事件每块触发一次，参数为
   * 原始字节。svnCli 不在此做行缓冲与解码——编码回退链依赖全量字节，
   * 进程结束前不可用；调用方在回调内自行按 \n 分行（GBK 双字节的尾字节
   * 不会产生 0x0A，行首 ASCII 前缀不受多字节字符影响），「当前文件名」
   * 类展示用 UTF-8 宽松解码（GBK 名称可能显示替换符，可接受），条目
   * 计数与前缀匹配在字节层即可判定。整段 onOutput 行为不受影响，两者
   * 可同时使用；stderr 无逐块回调（错误呈现由整段回调承担）。
   * runStream 模式（见 runStream）下这是 stdout 的唯一出口：回调抛出的
   * 错误会终止子进程并作为 runStream 的 reject 原因。
   */
  onStdoutChunk?: (chunk: Buffer) => void;
  /** 输出解码主编码（严格解码），默认 UTF-8；详见 core/encoding。 */
  encoding?: string;
  /**
   * 主编码严格解码失败后的回退编码链（按序尝试）；未传时默认回退
   * DEFAULT_ENCODING_FALLBACK（gbk→gb2312→big5），传空数组可显式关闭回退
   * （严格解码失败即按 UTF-8 宽松兜底并触发 onDecodingFallback）。
   */
  encodingFallback?: readonly string[];
  /** 任一输出流回退链全部失败、按 UTF-8 宽松解码时回调（宿主写频道标注）。 */
  onDecodingFallback?: (notice: DecodingFallbackNotice) => void;
  /**
   * 命令正常结束（含非零退出码）时的回调，宿主用于在输出频道记录退出码；
   * 超时、取消、启动失败不回调。认证补录重试是第二次执行，会再次回调。
   */
  onExit?: (exitCode: number) => void;
  /**
   * 认证失败时的凭据补录回调（宿主弹窗，密码只在内存）。
   * 提供后 runOrThrow 在识别到认证失败时补录并保留原始 args 重试一次；
   * 只读的本地命令不应提供。注入本回调的调用方必须同时注入
   * onCredentialRetry 并经 logCommand 脱敏回显，保持输出频道完整可解释。
   *
   * 参数为本次命令的 authScope（RunOptions.authScope 原样传入），host 级
   * 单飞协调器据此按 scheme + host + port 共享凭据 Promise；未传
   * authScope 的旧调用点收到 undefined，行为与既有实现一致。
   */
  getCredentials?: (scope?: AuthScope) => Promise<AuthCredentials | undefined>;
  /**
   * 凭据补录的作用域：远端命令的调用点必须显式传入（由目标 URL 经
   * authScopeOfUrl 构造），不能只靠闭包猜 key。runOrThrow 把它原样传给
   * getCredentials，并在识别认证失败时用它细分 auth/permission：
   * svn:// 的 `E170001 Authorization failed` 是权限拒绝，不弹补录框；
   * HTTP 的 `E175013` 同样归 permission。未传时保持 M1–M3 的按码判定行为。
   */
  authScope?: AuthScope;
  /**
   * 认证补录重试执行前的回调，参数为注入 --username/--password 后的重试
   * args（含明文密码；注入位置见 runOrThrowWithRunner——`--` 之前或尾部）；
   * 宿主用于回显命令行，记录前必须脱敏
   * （host 层 logCommand 已内置 redactArgs）。未提供或未发生重试不调用。
   * 返回值（若为函数）将作为重试执行的 onExit：宿主 logCommand 返回的
   * 退出记录器借此让操作日志第二行使用重试命令行（脱敏后）与真实耗时，
   * 而不是复用首执行记录器导致命令行失真。
   */
  onCredentialRetry?: (args: string[]) => ((exitCode: number) => void) | void;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** svn 子进程统一环境：强制 UTF-8，其余继承。 */
export function svnEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
}

/**
 * 进行中的子进程注册表：deactivate 时统一终止，
 * 避免扩展卸载后 svn 进程残留（命令与配置清单「激活与生命周期」）。
 */
const activeChildren = new Set<ChildProcess>();

/** 被 killAllActive 终止过的子进程：close 时按「取消」处理，不让命令层误报退出码。 */
const deactivatedChildren = new WeakSet<ChildProcess>();

/** 先 SIGTERM，宽限期后无条件对整组 SIGKILL（即使 leader 已退出）；计时器不阻止进程退出。 */
function killChild(child: ChildProcess): void {
  killTree(child, 'SIGTERM');
  const timer = setTimeout(() => {
    // 无条件组杀：leader 可能已退出（exitCode 非 null）而孙进程仍持有管道，
    // 按 leader 状态判断会漏杀；组不存在时 killTree 已回退单进程信号，无害。
    killTree(child, 'SIGKILL');
  }, SIGKILL_GRACE_MS);
  timer.unref();
}

/**
 * 对进程组发信号（spawn 用 detached 建组）：svn 的 shell 包装、
 * 孙进程持有 stdio 管道时，只杀直接子进程会让 close 永不触发。
 * 进程组不存在（已退出）时退回对单进程发信号。
 * pid 必须大于 0：`process.kill(-0)` 等价于 `process.kill(0)`，会误伤当前进程组。
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined && pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // ESRCH：进程组已不存在，退回单进程信号。
    }
  }
  child.kill(signal);
}

export function killAllActive(): void {
  for (const child of activeChildren) {
    deactivatedChildren.add(child);
    killChild(child);
  }
  activeChildren.clear();
}

/**
 * 执行内核：run/runStream/runToFile 共用同一套生命周期（spawn、超时、取消、
 * 卸载终止、stderr 解码与回调）。collectStdout 决定是否累计 stdout 并在
 * 结束后整段解码；不累计时 stdout 结果恒为空串，数据只经 onStdoutChunk
 * 逐块交给调用方（回调抛错即终止子进程并以该错误结算）。
 */
function spawnSvn(
  svnPath: string,
  args: string[],
  options: RunOptions,
  collectStdout: boolean,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new SvnError({ message: 'SVN 操作已取消', command: args, cwd: options.cwd, code: 'CANCELLED' }));
      return;
    }
    let child: ChildProcess;
    try {
      const leases = workspaceLeasesForCommand(args, options.cwd);
      const helper = leases[0]?.helper;
      const descriptors = [...new Set(leases.flatMap((lease) => lease.fds))];
      child = spawn(helper ?? svnPath, helper ? ['run', svnPath, ...args] : args, {
        ...(helper ? { stdio: ['pipe', 'pipe', 'pipe', ...descriptors] } : {}),
        cwd: options.cwd,
        env: svnEnv(),
        windowsHide: true,
        // 建立独立进程组，kill 时整组终止，避免孙进程持有管道导致 close 不触发。
        detached: true,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      reject(new SvnError({
        message: `无法启动 svn（${svnPath}）：${e.message}`,
        command: args,
        cwd: options.cwd,
        stderr: String(err),
        code: e.code ?? 'SPAWN_ERROR',
      }));
      return;
    }
    activeChildren.add(child);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let aborted = false;
    let settled = false;
    /** onStdoutChunk 同步抛出的错误：终止子进程并作为最终 reject 原因。 */
    let stdoutChunkError: unknown;
    let stdoutChunkFailed = false;

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener('abort', onAbort);
    };
    const settleError = (error: SvnError) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      activeChildren.delete(child);
      reject(error);
    };

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killChild(child);
      }, timeoutMs);
    }

    const onAbort = () => {
      aborted = true;
      killChild(child);
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (!stdoutStream || !stderrStream) {
      killChild(child);
      settleError(new SvnError({
        message: `svn 子进程 stdio 配置异常（${svnPath}）`,
        command: args,
        cwd: options.cwd,
        code: 'SPAWN_ERROR',
      }));
      return;
    }
    // 输出收集原始字节：整段解码统一在本函数收口（编码回退链必须看到
    // 全量字节才能判定），整段回调与结果拿到的都是已解码字符串；逐块
    // 回调 onStdoutChunk 是唯一例外——运行中透传原始字节，行缓冲与
    // 解码由调用方收口（见 RunOptions 注释），此处不掺和。
    // 不累计模式（runStream/runToFile）下 stdout 只经回调消费；回调抛错
    // 视为调用方主动要求终止（如 SAX 预算超限、写盘失败），kill 后按该
    // 错误结算，而不是把不完整的 stdout 当正常结果返回。
    stdoutStream.on('data', (chunk: Buffer) => {
      if (collectStdout) {
        stdoutChunks.push(chunk);
      }
      if (stdoutChunkFailed || !options.onStdoutChunk) {
        return;
      }
      try {
        options.onStdoutChunk(chunk);
      } catch (err) {
        stdoutChunkFailed = true;
        stdoutChunkError = err;
        killChild(child);
      }
    });
    stderrStream.on('data', (chunk: Buffer) => {
      // stderr 整段保留：错误呈现与错误码分类依赖全量文本（体积小）。
      stderrChunks.push(chunk);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      settleError(new SvnError({
        message: `无法启动 svn（${svnPath}）：${err.message}`,
        command: args,
        cwd: options.cwd,
        stderr: String(err),
        code: err.code ?? 'SPAWN_ERROR',
      }));
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      activeChildren.delete(child);
      // 收口解码：主编码严格解码 → 回退链 → UTF-8 宽松兜底。
      const primary = options.encoding ?? DEFAULT_OUTPUT_ENCODING;
      const fallback = options.encodingFallback ?? DEFAULT_ENCODING_FALLBACK;
      let stdoutText = '';
      if (collectStdout) {
        const stdoutDecoded = decodeBuffer(Buffer.concat(stdoutChunks), primary, fallback);
        if (stdoutDecoded.lenient) {
          options.onDecodingFallback?.({ source: 'stdout', primary, fallback });
        }
        if (stdoutDecoded.text) {
          options.onOutput?.(stdoutDecoded.text, 'stdout');
        }
        stdoutText = stdoutDecoded.text;
      }
      const stderrDecoded = decodeBuffer(Buffer.concat(stderrChunks), primary, fallback);
      if (stderrDecoded.lenient) {
        options.onDecodingFallback?.({ source: 'stderr', primary, fallback });
      }
      if (stderrDecoded.text) {
        options.onOutput?.(stderrDecoded.text, 'stderr');
      }
      if (stdoutChunkFailed) {
        // 回调抛错（超限/写盘失败等）是主动终止的根因，优先于超时/取消结算。
        reject(stdoutChunkError);
        return;
      }
      if (timedOut) {
        reject(new SvnError({
          message: `svn ${redactArgs(args).join(' ')} 超时（${timeoutMs} 毫秒），进程已终止`,
          command: args,
          cwd: options.cwd,
          stderr: tailText(stderrDecoded.text),
          code: 'TIMEOUT',
        }));
        return;
      }
      if (aborted || deactivatedChildren.has(child)) {
        reject(new SvnError({
          message: `svn ${redactArgs(args).join(' ')} 已被取消`,
          command: args,
          cwd: options.cwd,
          stderr: tailText(stderrDecoded.text),
          code: 'CANCELLED',
        }));
        return;
      }
      const exitCode = code ?? -1;
      options.onExit?.(exitCode);
      resolve({ stdout: stdoutText, stderr: stderrDecoded.text, exitCode });
    });
  });
}

/**
 * 执行一条 svn 命令。返回退出码与完整 stdout/stderr（业务解析需要全量；
 * 错误展示由 SvnError 侧做尾部截断）。进程级失败抛 SvnError。
 */
export function run(svnPath: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return spawnSvn(svnPath, args, options, true);
}

export interface RunStreamOptions extends RunOptions {
  /**
   * stdout 逐块回调（必填）：runStream 不累计整段 stdout，结果中的 stdout
   * 恒为空串。XML 调用侧必须用 StringDecoder('utf8') 跨 chunk 解码后再喂
   * SAX（见 Utf8StreamDecoder），逐块 toString 会在分块边界产生 U+FFFD。
   * 回调抛出的错误会终止子进程并成为 runStream 的 reject 原因（预算超限、
   * 写盘失败等主动中止走这一入口）。
   */
  onStdoutChunk: (chunk: Buffer) => void;
}

export interface RunStreamResult {
  /** 流式模式不累计 stdout，恒为空串；解析由 onStdoutChunk 负责。 */
  stdout: '';
  stderr: string;
  exitCode: number;
}

/**
 * 流式执行：stdout 逐块交给 onStdoutChunk、不在内存累计整段，stderr 仍
 * 整段保留用于错误呈现与分类。超时/取消/卸载终止语义与 run 完全一致；
 * 退出码非零仍作为业务结果返回（由调用方 assertSuccess 决定是否中断）。
 *
 * 远程命令的调用方必须显式携带 `--non-interactive` 与统一的 URL peg
 * （urlWithPeg），本地路径用 core/workspace.escapePeg。
 */
export function runStream(
  svnPath: string,
  args: string[],
  options: RunStreamOptions,
): Promise<RunStreamResult> {
  return spawnSvn(svnPath, args, options, false) as Promise<RunStreamResult>;
}

export interface RunToFileOptions extends Omit<RunOptions, 'onStdoutChunk'> {
  /**
   * 最终目标文件路径（通常位于受管临时目录）。实际写入的是同目录下带
   * 随机名的 `<targetPath>.<random>.part`，成功（退出码 0）后才原子改名
   * 为目标路径；任何失败分支（超时、取消、非零退出、超限、写盘失败）
   * 都会删除 .part，不留下半文件。
   */
  targetPath: string;
  /**
   * 预期输出字节数（已知文件大小时由 info --xml 的 entry@size 等提供）：
   * 提供时在启动 svn 前做预算与磁盘余量预检（超过 maxBytes 或可用空间
   * 不足直接失败，不启动 cat）；未知时省略，运行中按实时字节计数与
   * 写盘错误兜底。
   */
  expectedBytes?: number;
  /** stdout 字节上限，默认 DEFAULT_MAX_OUTPUT_FILE_BYTES（2 GiB）。 */
  maxBytes?: number;
  /** 磁盘余量要求，默认 DEFAULT_DISK_HEADROOM_BYTES（64 MiB）。 */
  headroomBytes?: number;
  /** 实时字节计数回调：每写入一块触发一次，参数为累计字节数。 */
  onProgress?: (bytesWritten: number) => void;
}

export interface RunToFileResult {
  /** 流式模式不累计 stdout，恒为空串。 */
  stdout: '';
  stderr: string;
  exitCode: number;
  /** 已写入 .part 的字节数（失败时同样返回已写入量，供诊断）。 */
  bytesWritten: number;
  /** 仅退出码为 0 时存在：.part 已原子改名为该路径。 */
  filePath?: string;
}

/** 磁盘余量不足的错误码集合（跨平台：Linux/macOS ENOSPC、配额超限 EDQUOT）。 */
const DISK_FULL_CODES = new Set(['ENOSPC', 'EDQUOT']);

/** 查询目录可用字节数；statfs 不可用或失败时返回 undefined（跳过预检）。 */
async function availableDiskBytes(dir: string): Promise<number | undefined> {
  try {
    const stats = await statfs(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return undefined;
  }
}

/**
 * 直接写目标文件的流式执行原语（远端 `svn cat` 等二进制内容下载）。
 *
 * 资源纪律：
 * - 已知 expectedBytes 时先做预算（> maxBytes）与磁盘余量预检
 *   （可用空间 < expectedBytes + headroom），任一不足都不启动 svn，
 *   错误码分别为 OUTPUT_TOO_LARGE / INSUFFICIENT_DISK；
 * - 运行中按块实时计数，写入前检查下一块是否会超过 maxBytes，超过则
 *   立即终止进程组并删除 .part（OUTPUT_TOO_LARGE），不把半文件当结果；
 * - 写盘 ENOSPC/EDQUOT 映射 INSUFFICIENT_DISK，其余写盘错误保留系统码；
 * - 超时/取消沿用现有 TIMEOUT/CANCELLED 错误码。
 *
 * 写入采用块级同步写（stdout data 块为 64 KiB 级）：字节计数、上限判定
 * 与 ENOSPC 错误都在同一回调内同步完成，不需要异步流的背压协调，也
 * 不会在慢盘时把成千上万块缓冲进内存；单次同步写远小于宿主事件循环的
 * 响应预算。stdout 内容不回传，Parse/展示由调用方读取最终文件。
 *
 * 退出码非零属于业务结果（返回 exitCode 非 0 且 filePath 缺省，.part
 * 已删除），由调用方 assertSuccess 中断；成功（exitCode 0）时 .part
 * 原子改名为 targetPath。
 */
export async function runToFile(
  svnPath: string,
  args: string[],
  options: RunToFileOptions,
): Promise<RunToFileResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_OUTPUT_FILE_BYTES;
  const headroom = options.headroomBytes ?? DEFAULT_DISK_HEADROOM_BYTES;
  const targetPath = options.targetPath;
  const targetDir = dirname(targetPath);

  // 启动前预检：已知大小才做精确预算；未知大小时只要求最低余量，
  // 实际大小由运行中的字节计数与写盘错误兜底。
  if (options.expectedBytes !== undefined && options.expectedBytes > maxBytes) {
    throw new SvnError({
      message: `expected output size ${options.expectedBytes} exceeds limit ${maxBytes}; svn was not started`,
      command: args,
      cwd: options.cwd,
      code: OUTPUT_TOO_LARGE,
    });
  }
  const requiredBytes = (options.expectedBytes ?? 0) + headroom;
  const freeBytes = await availableDiskBytes(targetDir);
  if (freeBytes !== undefined && freeBytes < requiredBytes) {
    throw new SvnError({
      message: `insufficient disk space in target directory: need at least ${requiredBytes} bytes, ${freeBytes} available`,
      command: args,
      cwd: options.cwd,
      code: INSUFFICIENT_DISK,
    });
  }

  const partPath = `${targetPath}.${randomBytes(8).toString('hex')}.part`;
  let fd: number | undefined;
  try {
    fd = openSync(partPath, 'wx');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new SvnError({
      message: `failed to create temporary file ${partPath}: ${e.message}`,
      command: args,
      cwd: options.cwd,
      stderr: String(err),
      code: e.code ?? 'FILE_CREATE_ERROR',
    });
  }
  const partFd = fd;

  let bytesWritten = 0;
  let fdClosed = false;
  const closePart = () => {
    if (fdClosed) {
      return;
    }
    fdClosed = true;
    try {
      closeSync(partFd);
    } catch {
      // close 失败不影响后续清理（文件描述符随进程回收）。
    }
  };
  try {
    const result = await spawnSvn(svnPath, args, {
      ...options,
      onStdoutChunk: (chunk: Buffer) => {
        if (bytesWritten + chunk.length > maxBytes) {
          throw new SvnError({
            message: `svn output exceeds limit ${maxBytes} bytes; process terminated and temporary file removed`,
            command: args,
            cwd: options.cwd,
            code: OUTPUT_TOO_LARGE,
          });
        }
        try {
          writeSync(partFd, chunk);
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          throw new SvnError({
            message: `failed to write temporary file (${e.code ?? 'UNKNOWN'}): ${e.message}`,
            command: args,
            cwd: options.cwd,
            stderr: String(err),
            code: e.code !== undefined && DISK_FULL_CODES.has(e.code) ? INSUFFICIENT_DISK : (e.code ?? 'FILE_WRITE_ERROR'),
          });
        }
        bytesWritten += chunk.length;
        options.onProgress?.(bytesWritten);
      },
    }, false);
    closePart();
    if (result.exitCode !== 0) {
      // 非零退出码是业务失败：删除半文件，结果交由调用方 assertSuccess 中断。
      rmSync(partPath, { force: true });
      return { stdout: '', stderr: result.stderr, exitCode: result.exitCode, bytesWritten };
    }
    renameSync(partPath, targetPath);
    return {
      stdout: '',
      stderr: result.stderr,
      exitCode: 0,
      bytesWritten,
      filePath: targetPath,
    };
  } catch (err) {
    closePart();
    rmSync(partPath, { force: true });
    throw err;
  }
}

/** 常用协议默认端口：authScopeOfUrl 补齐到 scope.port，保证同源 key 稳定。 */
const DEFAULT_SCHEME_PORTS: Record<AuthScope['scheme'], number> = {
  http: 80,
  https: 443,
  svn: 3690,
};

/**
 * 从远端 URL 构造凭据作用域（AuthScope）。
 * 只支持 http/https/svn 三种可补录凭据的协议；file/svn+ssh 返回
 * undefined（file 走文件系统权限，svn+ssh 的认证由 SSH 配置承载）。
 * host 统一小写，端口取显式值或协议默认端口（http 80 / https 443 /
 * svn 3690），保证 `…:443` 与省略端口两种写法得到同一单飞 key。
 */
export function authScopeOfUrl(url: string): AuthScope | undefined {
  const match = /^(https?|svn):\/\/([^/?#]*)/i.exec(url);
  if (!match) {
    return undefined;
  }
  const scheme = match[1].toLowerCase() as AuthScope['scheme'];
  let authority = match[2] ?? '';
  // 规范 URL 不应携带 userinfo（core/checkout 校验拒绝）；防御性剥除后取主机。
  const at = authority.lastIndexOf('@');
  if (at >= 0) {
    authority = authority.slice(at + 1);
  }
  if (authority === '') {
    return undefined;
  }
  let host: string;
  let port: number | undefined;
  const ipv6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority);
  if (ipv6) {
    host = `[${ipv6[1]}]`;
    port = ipv6[2] !== undefined ? Number(ipv6[2]) : undefined;
  } else {
    const colon = authority.lastIndexOf(':');
    if (colon >= 0) {
      const parsed = Number(authority.slice(colon + 1));
      if (Number.isInteger(parsed) && parsed > 0) {
        host = authority.slice(0, colon);
        port = parsed;
      } else {
        // 非数字端口不会出现在校验过的 URL 中；保守保留原 authority。
        host = authority;
      }
    } else {
      host = authority;
    }
  }
  if (host === '') {
    return undefined;
  }
  return { scheme, host: host.toLowerCase(), port: port ?? DEFAULT_SCHEME_PORTS[scheme] };
}

/**
 * 统一 URL peg 构造：固定 `url + '@' + (peg ?? '')`。
 *
 * - 任何含字面 `@` 或 `%40` 的 URL 直接执行会被 svn 按 peg 分隔符解析并
 *   报 `E205000: Syntax error parsing peg revision`（实测），因此
 *   M4 起所有远端命令都经本函数拼接，禁止调用点手写 `@`；
 * - 无 revision 时必须追加空 peg（`…/trunk@`），不得裸露用户 URL；
 * - 以字面 `@` 结尾的合法节点名（如 `…/tail@`）不剥除：svn 的 `<url>`
 *   原样回显该 `@`，固定拼接为 `…/tail@@<rev>` 才能定位节点本身；
 * - 调用点保证传入的 rawUrl 不含 peg（不把本函数输出再次传入），
 *   幂等由调用点负责。本地文件系统路径不要用本函数，用
 *   core/workspace.escapePeg。
 */
export function urlWithPeg(url: string, peg?: number | string | null): string {
  const suffix = peg === undefined || peg === null ? '' : String(peg);
  return `${url}@${suffix}`;
}

/**
 * XML 流式解析的跨 chunk UTF-8 解码器。
 *
 * `node:string_decoder` 的 StringDecoder 会保留分块边界上不完整的多字节
 * 序列，直到下一块补齐；逐块 `Buffer.toString('utf8')` 会把中文/emoji 在
 * 分块处解码成 U+FFFD（实测）。所有 runStream 的 XML 调用侧都必须
 * 先用本解码器转成字符串再喂 SAX，flush 时调用 end() 取回尾段。
 */
export class Utf8StreamDecoder {
  private readonly decoder = new StringDecoder('utf8');

  /** 解码一块原始字节，返回可立即喂给 SAX 的字符串（可能为空串）。 */
  write(chunk: Buffer): string {
    return this.decoder.write(chunk);
  }

  /** 进程结束后取回缓冲的尾段（无残留时为空串）。 */
  end(): string {
    return this.decoder.end();
  }
}

/**
 * 非零退出码视为失败的常用封装；成功时原样返回结果。
 * 提供 getCredentials 时，认证失败经 classifyAuthFailure 细分：只有 auth
 * （可补录的认证失败）才弹窗补录凭据，permission（E175013、svn:// 的
 * `E170001 Authorization failed`）按原错误抛出，不弹无意义凭据框。
 * 补录后在原始 args 的 `--` 分隔符之前（无 `--` 时在尾部）注入
 * --username/--password 重试一次（重试执行前经 onCredentialRetry 回调，
 * 宿主可回显脱敏后的命令行）；getCredentials 收到 options.authScope
 * 原样传入的作用域；补录取消或重试仍失败都按原错误抛出
 * （SvnError.command 构造时脱敏，明文不外泄）。
 */
export async function runOrThrow(
  svnPath: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return runOrThrowWithRunner(svnPath, args, options, run);
}

/** runOrThrow 的可注入变体：测试用替身 runner 验证认证重试决策逻辑。 */
export async function runOrThrowWithRunner(
  svnPath: string,
  args: string[],
  options: RunOptions,
  runner: typeof run,
): Promise<RunResult> {
  let currentArgs = args;
  let currentOptions = options;
  let authenticated = false;
  let retried = false;
  const retry = ['info', 'list', 'log'].includes(args[0]) ? options.retryReadOnly : undefined;
  const checkCancelled = () => {
    if (options.signal?.aborted) {
      throw new SvnError({ message: 'SVN 操作已取消', command: args, cwd: options.cwd, code: 'CANCELLED' });
    }
  };
  for (;;) {
    checkCancelled();
    try {
      const result = await runner(svnPath, currentArgs, currentOptions);
      return assertSuccess(result, currentArgs, options.cwd);
    } catch (error) {
      if (!(error instanceof SvnError)) throw error;
      checkCancelled();
      const authKind = classifyAuthFailure(error.stderr, options.authScope?.scheme);
      if (authKind === 'auth' && options.getCredentials && !authenticated) {
        const credentials = await options.getCredentials(options.authScope);
        checkCancelled();
        if (!credentials) throw error;
        authenticated = true;
        const credentialArgs = ['--username', credentials.username, '--password', credentials.password];
        const separator = args.indexOf('--');
        currentArgs = separator < 0
          ? [...args, ...credentialArgs]
          : [...args.slice(0, separator), ...credentialArgs, ...args.slice(separator)];
        const onExit = options.onCredentialRetry?.(currentArgs);
        currentOptions = typeof onExit === 'function' ? { ...options, onExit } : options;
        continue;
      }
      if (!retry || retried || authKind || !isTransientReadFailure(error)) throw error;
      retried = true;
      retry.onRetry?.(error);
      try {
        await delay(retry.delayMs ?? 400, undefined, { signal: options.signal });
      } catch (delayError) {
        checkCancelled();
        throw delayError;
      }
    }
  }
}

function isTransientReadFailure(error: SvnError): boolean {
  if (error.code === 'TIMEOUT') return true;
  const codes = extractSvnErrorCodes(error.stderr);
  const permitted = new Set(['E170013', 'E175002', 'E175012', 'E120108', 'E000104']);
  const transient = new Set(['E175012', 'E120108', 'E000104']);
  return codes.some((code) => transient.has(code)) && codes.every((code) => permitted.has(code));
}
