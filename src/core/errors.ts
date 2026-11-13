/**
 * SVN 错误对象与错误码识别。core 模块，不依赖 vscode。
 */
import { redactArgs } from './redact';

/** 认证失败相关的 svn 错误码（阶段 7 补录流程的触发条件）。 */
export const AUTH_ERROR_CODES = ['E170001', 'E215004'] as const;

/** 认证失败的兜底文本（匹配不区分大小写）。 */
export const AUTH_ERROR_TEXTS = ['authorization failed', 'Authentication failed'] as const;

/**
 * 授权/权限拒绝相关的 svn 错误码：HTTP authz 拒绝为 E175013（阶段 0
 * 实测 `E170013` + `E175013`），不得触发凭据弹窗补录。
 */
export const PERMISSION_ERROR_CODES = ['E175013'] as const;

/**
 * 连接/网络类错误码（可重试，不进入 ancestor-filter 等存在性判断）：
 * E170013 为错误链首位（仓库不可达/认证/权限/网络共用），第二级细分见
 * classifyAuthFailure；E175012 为超时（阶段 0 实测 `http-timeout=2` →
 * `E170013 + E175012`），E120108 为连接中断（服务端突然关闭），
 * E180001/E000061 为连接拒绝/无法连接，E175002/E000104/E670003 为
 * 网络/代理类（沿用 core/checkout 的既有连接集合）。
 */
export const NETWORK_ERROR_CODES = [
  'E170013',
  'E175002',
  'E175012',
  'E180001',
  'E000061',
  'E120108',
  'E000104',
  'E670003',
] as const;

/** 认证类失败的细分：可弹窗补录（auth）或授权拒绝（permission）。 */
export type AuthFailureKind = 'auth' | 'permission';

/** runToFile 输出超过字节上限时的固定错误码。 */
export const OUTPUT_TOO_LARGE = 'OUTPUT_TOO_LARGE';

/** 临时目录磁盘余量不足时的固定错误码。 */
export const INSUFFICIENT_DISK = 'INSUFFICIENT_DISK';

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

/**
 * 认证类失败细分（仅在知道目标 scheme 时启用细化规则）：
 * - 任何 scheme 下出现 E175013 都归 permission（HTTP authz 拒绝）；
 * - scheme 为 svn 时，E170001 按固定 en_US.UTF-8 消息细分（阶段 0 实测
 *   同一错误码同时表示两种语义）：`Authorization failed` 归 permission，
 *   `Can't get username or password` / `Authentication failed` 归 auth；
 * - 其余情况沿用 isAuthFailure：命中为 auth，未命中返回 undefined。
 *
 * 未提供 scheme 时不做文本细分（除 E175013 外），保证 M1–M3 未显式传
 * authScope 的调用点行为与既有 isAuthFailure 一致。
 */
export function classifyAuthFailure(text: string, scheme?: string): AuthFailureKind | undefined {
  const codes = extractSvnErrorCodes(text);
  if (codes.some((code) => (PERMISSION_ERROR_CODES as readonly string[]).includes(code))) {
    return 'permission';
  }
  if (scheme?.toLowerCase() === 'svn' && codes.includes('E170001') && /authorization failed/i.test(text)) {
    return 'permission';
  }
  return isAuthFailure(text) ? 'auth' : undefined;
}

/** 判断输出是否属于连接/网络类失败（按 6 位错误码，不依赖错误文本）。 */
export function isNetworkFailure(text: string): boolean {
  return extractSvnErrorCodes(text).some((code) => (NETWORK_ERROR_CODES as readonly string[]).includes(code));
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
