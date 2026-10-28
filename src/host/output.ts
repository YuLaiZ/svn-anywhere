/**
 * 输出频道与脱敏。host 模块。
 * 单一 `SVN Anywhere` 频道；所有写入经过 core/redact 的脱敏，
 * 流式输出（阶段 3）用 LineBuffer 按行缓冲后再写。
 */
import * as vscode from 'vscode';
import { LineBuffer, redactArgs, sanitizeText } from '../core/redact';
import { strings } from './i18n';

let channel: vscode.OutputChannel | undefined;
/** dispose 之后的写入（如子进程迟到回调）直接丢弃，避免重建出无人释放的频道。 */
let disposed = false;

export function getOutputChannel(): vscode.OutputChannel {
  if (!channel && !disposed) {
    channel = vscode.window.createOutputChannel(strings.output.title);
  }
  return channel!;
}

export function disposeOutputChannel(): void {
  channel?.dispose();
  channel = undefined;
  disposed = true;
}

/** activate 时重置：同一宿主实例内二次激活（调试重载）后输出恢复正常。 */
export function resetOutputState(): void {
  disposed = false;
}

/** 整段文本写入前的统一脱敏（流式请用 createLineBuffer）。 */
export function sanitize(text: string): string {
  return sanitizeText(text);
}

export function logLine(line: string): void {
  if (disposed) {
    return;
  }
  getOutputChannel().appendLine(sanitize(line));
}

/** 记录一条即将执行的命令，格式 `> <svnPath> <args>`，args 脱敏。 */
export function logCommand(svnPath: string, args: string[], cwd?: string): void {
  logLine(`> ${svnPath} ${redactArgs(args).join(' ')}${cwd ? `  (cwd: ${cwd})` : ''}`);
}

/** 按行缓冲的流式写入器：stdout/stderr chunk 先攒行、脱敏再进频道。 */
export function createLineBuffer(source?: string): LineBuffer {
  const prefix = source ? `[${source}] ` : '';
  return new LineBuffer((line) => logLine(prefix + line));
}

export function showOutput(preserveFocus = false): void {
  if (disposed) {
    return;
  }
  getOutputChannel().show(preserveFocus);
}
