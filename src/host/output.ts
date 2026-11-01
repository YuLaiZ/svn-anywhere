/**
 * 输出频道注册表与脱敏。host 模块。
 * 按操作域分频道（状态 / 更新 / 提交 / 其它）互不覆盖，另设独立的
 * 「操作日志」频道，每行记录 时间 | 命令（脱敏） | 退出码 | 耗时。
 * 所有写入经过 core/redact 的脱敏；命令回显逐条、stderr 原样的既有
 * 口径不变（解码收口在 core/svnCli，这里只消费已解码字符串）。
 */
import * as vscode from 'vscode';
import type { DecodingFallbackNotice } from '../core/encoding';
import { LineBuffer, redactArgs, sanitizeText } from '../core/redact';
import { readEncodingSettings } from './config';
import { format, strings } from './i18n';

/** 操作域频道分类；错误收口与探测等无明确域的输出归 other。 */
export type OutputKind = 'status' | 'update' | 'commit' | 'other';

function kindTitle(kind: OutputKind): string {
  switch (kind) {
    case 'status':
      return strings.output.titleStatus;
    case 'update':
      return strings.output.titleUpdate;
    case 'commit':
      return strings.output.titleCommit;
    default:
      return strings.output.title;
  }
}

const channels = new Map<OutputKind, vscode.OutputChannel>();
let operationLogChannel: vscode.OutputChannel | undefined;
/** dispose 之后的写入（如子进程迟到回调）直接丢弃，避免重建出无人释放的频道。 */
let disposed = false;

export function getOutputChannel(kind: OutputKind = 'other'): vscode.OutputChannel | undefined {
  let channel = channels.get(kind);
  if (!channel && !disposed) {
    channel = vscode.window.createOutputChannel(kindTitle(kind));
    channels.set(kind, channel);
  }
  return channel;
}

function getOperationLogChannel(): vscode.OutputChannel | undefined {
  if (!operationLogChannel && !disposed) {
    operationLogChannel = vscode.window.createOutputChannel(strings.output.titleOperationLog);
  }
  return operationLogChannel;
}

export function disposeOutputChannel(): void {
  for (const channel of channels.values()) {
    channel.dispose();
  }
  channels.clear();
  operationLogChannel?.dispose();
  operationLogChannel = undefined;
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

export function logLine(line: string, kind: OutputKind = 'other'): void {
  if (disposed) {
    return;
  }
  getOutputChannel(kind)?.appendLine(sanitize(line));
}

/** 命令回显行的展示格式（也用于操作日志的命令列）。 */
function commandDisplay(svnPath: string, args: string[], cwd?: string): string {
  return `${svnPath} ${redactArgs(args).join(' ')}${cwd ? `  (cwd: ${cwd})` : ''}`;
}

/** 操作日志的时间列：本地时间 HH:MM:SS.mmm（对应命令开始时刻）。 */
function formatLogTime(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/**
 * 记录一条即将执行的命令（`> <svnPath> <args>`，args 脱敏），并返回该
 * 命令的退出记录器：退出码行写入 kind 频道，同时把
 * `时间 | 命令 | 退出码 | 耗时` 写入操作日志频道。返回值用作
 * RunOptions.onExit，保证操作日志逐命令配对（不依赖完成顺序）。
 */
export function logCommand(
  svnPath: string,
  args: string[],
  cwd?: string,
  kind: OutputKind = 'other',
): (exitCode: number) => void {
  if (disposed) {
    return () => undefined;
  }
  const startedAt = new Date();
  const display = commandDisplay(svnPath, args, cwd);
  logLine(`> ${display}`, kind);
  return (exitCode: number) => {
    if (disposed) {
      return;
    }
    logExitCode(exitCode, kind);
    // 命令参数可能含换行（如特殊文件名）：操作日志一行一命令，换行归一为字面 \n。
    const singleLineCommand = display.replace(/\r?\n/g, '\\n');
    getOperationLogChannel()?.appendLine(format(strings.output.operationLogLine, {
      time: formatLogTime(startedAt),
      command: singleLineCommand,
      code: String(exitCode),
      duration: `${Date.now() - startedAt.getTime()}ms`,
    }));
  };
}

/** 记录命令退出码（成功与非零都记）；没有命令回显上下文的收口路径使用。 */
export function logExitCode(code: number, kind: OutputKind = 'other'): void {
  logLine(format(strings.output.exitCode, { code: String(code) }), kind);
}

/** 按行缓冲的流式写入器：解码后的输出先攒行、脱敏再进频道。 */
export function createLineBuffer(source?: string, kind: OutputKind = 'other'): LineBuffer {
  const prefix = source ? `[${source}] ` : '';
  return new LineBuffer((line) => logLine(prefix + line, kind));
}

export function showOutput(preserveFocus = false, kind: OutputKind = 'other'): void {
  if (disposed) {
    return;
  }
  getOutputChannel(kind)?.show(preserveFocus);
}

/**
 * 按当前配置组装解码选项（展开进 RunOptions）：主编码、回退链与
 * 「编码回退失败」标注回调（写入 kind 频道）。
 */
export function decodingRunOptions(kind: OutputKind): {
  encoding: string;
  encodingFallback: string[];
  onDecodingFallback: (notice: DecodingFallbackNotice) => void;
} {
  return {
    ...readEncodingSettings(),
    onDecodingFallback: (notice) => {
      const encodings = [notice.primary, ...notice.fallback].join('、');
      logLine(
        format(strings.output.decodingFallbackNotice, {
          source: notice.source === 'stdout' ? strings.output.sourceStdout : strings.output.sourceStderr,
          encodings,
        }),
        kind,
      );
    },
  };
}
