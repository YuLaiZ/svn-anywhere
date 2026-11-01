/**
 * svn 命令执行层。core 模块，不依赖 vscode。
 *
 * 约定：
 * - 永远用参数数组 spawn，不拼 shell 字符串；
 * - 环境统一 UTF-8，避免 svn 输出本地化与编码问题；
 * - run 只在进程级失败（找不到可执行文件、超时、被取消）时抛 SvnError，
 *   退出码非零属于业务结果，由调用方用 runOrThrow/assertSuccess 决定是否中断；
 * - 所有包含命令与 args 的错误消息都经过 redactArgs，--password 不进明文。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { DEFAULT_ENCODING_FALLBACK, DEFAULT_OUTPUT_ENCODING, decodeBuffer, type DecodingFallbackNotice } from './encoding';
import { SvnError, assertSuccess, isAuthFailure, tailText } from './errors';
import { redactArgs } from './redact';

export const DEFAULT_TIMEOUT_MS = 120_000;

/** 超时/取消后先 SIGTERM，进程仍未退出时再等这么久发 SIGKILL。 */
const SIGKILL_GRACE_MS = 3_000;

export interface AuthCredentials {
  username: string;
  password: string;
}

export interface RunOptions {
  /** 工作目录，默认继承当前进程。 */
  cwd?: string;
  /** 超时毫秒数；超时后 kill 进程并抛 SvnError。默认 120 秒，0 表示不限时。 */
  timeoutMs?: number;
  /** 取消信号；宿主负责从 vscode.CancellationToken 桥接。 */
  signal?: AbortSignal;
  /**
   * 输出回调：进程结束后按编码回退链解码出的整段文本（stdout、stderr
   * 各一次；解码收口在 svnCli，面板与命令拿到的都是已解码字符串）。
   * 建议配合 LineBuffer 按行脱敏。
   */
  onOutput?: (chunk: string, source: 'stdout' | 'stderr') => void;
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
   */
  getCredentials?: () => Promise<AuthCredentials | undefined>;
  /**
   * 认证补录重试执行前的回调，参数为追加 --username/--password 后的重试
   * args（含明文密码）；宿主用于回显命令行，记录前必须脱敏
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
 * 执行一条 svn 命令。返回退出码与完整 stdout/stderr（业务解析需要全量；
 * 错误展示由 SvnError 侧做尾部截断）。进程级失败抛 SvnError。
 */
export function run(svnPath: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(svnPath, args, {
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
    // 输出收集原始字节：解码统一在本函数收口（编码回退链必须看到全量
    // 字节才能判定），回调与结果拿到的都是已解码字符串。
    stdoutStream.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    stderrStream.on('data', (chunk: Buffer) => {
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
      const stdoutDecoded = decodeBuffer(Buffer.concat(stdoutChunks), primary, fallback);
      const stderrDecoded = decodeBuffer(Buffer.concat(stderrChunks), primary, fallback);
      if (stdoutDecoded.lenient) {
        options.onDecodingFallback?.({ source: 'stdout', primary, fallback });
      }
      if (stderrDecoded.lenient) {
        options.onDecodingFallback?.({ source: 'stderr', primary, fallback });
      }
      if (stdoutDecoded.text) {
        options.onOutput?.(stdoutDecoded.text, 'stdout');
      }
      if (stderrDecoded.text) {
        options.onOutput?.(stderrDecoded.text, 'stderr');
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
      resolve({ stdout: stdoutDecoded.text, stderr: stderrDecoded.text, exitCode });
    });
  });
}

/**
 * 非零退出码视为失败的常用封装；成功时原样返回结果。
 * 提供 getCredentials 时，认证失败（E170001/E215004 等）弹窗补录凭据，
 * 保留原始 args 追加 --username/--password 重试一次（重试执行前经
 * onCredentialRetry 回调，宿主可回显脱敏后的命令行）；补录取消或重试
 * 仍失败都按原错误抛出（SvnError.command 构造时脱敏，明文不外泄）。
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
  try {
    const result = await runner(svnPath, args, options);
    return assertSuccess(result, args, options.cwd);
  } catch (err) {
    if (!options.getCredentials || !(err instanceof SvnError) || !isAuthFailure(err.stderr)) {
      throw err;
    }
    const credentials = await options.getCredentials();
    if (!credentials) {
      throw err;
    }
    const retryArgs = [...args, '--username', credentials.username, '--password', credentials.password];
    // onCredentialRetry 返回退出记录器时（host 层 logCommand 的返回值），
    // 重试执行改用它作为 onExit：操作日志第二行记录重试命令（脱敏）与
    // 各自真实耗时；否则维持复用外层 onExit 的既有行为。
    const retryExit = options.onCredentialRetry?.(retryArgs);
    const retryOptions = typeof retryExit === 'function' ? { ...options, onExit: retryExit } : options;
    const result = await runner(svnPath, retryArgs, retryOptions);
    return assertSuccess(result, retryArgs, options.cwd);
  }
}
