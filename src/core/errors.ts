/**
 * SVN 错误对象与错误码识别。core 模块，不依赖 vscode。
 */
import { redactArgs } from './redact';

/** 认证失败相关的 svn 错误码（阶段 7 补录流程的触发条件）。 */
export const AUTH_ERROR_CODES = ['E170001', 'E215004'] as const;

/** 认证失败的兜底文本（匹配不区分大小写）。 */
export const AUTH_ERROR_TEXTS = ['authorization failed', 'Authentication failed'] as const;

export interface SvnErrorParams {
  message: string;
  command: string[];
  cwd?: string;
  exitCode?: number;
  stderr?: string;
  code?: string;
}

export class SvnError extends Error {
  readonly command: string[];
  readonly cwd?: string;
  readonly exitCode?: number;
  readonly stderr: string;
  readonly code?: string;

  constructor(params: SvnErrorParams) {
    super(params.message);
    this.name = 'SvnError';
    // command 可能含 --password，构造时统一脱敏，任何打印 err.command 的路径都不会泄露。
    this.command = redactArgs(params.command);
    this.cwd = params.cwd;
    this.exitCode = params.exitCode;
    this.stderr = params.stderr ?? '';
    this.code = params.code;
  }
}

/** 错误展示时 stderr 保留的尾部字符数，避免超大输出撑爆提示框。 */
export const MAX_ERROR_TAIL_CHARS = 8192;

/** 只保留文本尾部，超长时加前缀省略号。 */
export function tailText(text: string, maxChars = MAX_ERROR_TAIL_CHARS): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `…（前文已截断）${text.slice(-maxChars)}`;
}

/** 从 svn 输出中提取全部 E 开头的 6 位错误码，如 `svn: E155007: ...`。 */
export function extractSvnErrorCodes(text: string): string[] {
  return [...text.matchAll(/\bE\d{6}\b/g)].map((m) => m[0]);
}

/** 判断输出是否为认证失败（错误码或兜底文本命中，文本匹配不区分大小写）。 */
export function isAuthFailure(text: string): boolean {
  const codes = extractSvnErrorCodes(text);
  if (codes.some((code) => (AUTH_ERROR_CODES as readonly string[]).includes(code))) {
    return true;
  }
  const lower = text.toLowerCase();
  return AUTH_ERROR_TEXTS.some((t) => lower.includes(t.toLowerCase()));
}

/** 命令退出码非零时抛出 SvnError；错误消息与 stderr 都做尾部截断。 */
export function assertSuccess(result: {
  stdout: string;
  stderr: string;
  exitCode: number;
}, command: string[], cwd?: string): { stdout: string; stderr: string; exitCode: number } {
  if (result.exitCode !== 0) {
    throw new SvnError({
      message: tailText(result.stderr.trim() || `svn ${command[0]} 退出码 ${result.exitCode}`),
      command,
      cwd,
      exitCode: result.exitCode,
      stderr: tailText(result.stderr),
      code: extractSvnErrorCodes(result.stderr)[0],
    });
  }
  return result;
}
