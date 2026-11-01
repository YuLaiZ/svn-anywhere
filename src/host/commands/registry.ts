/**
 * 命令注册与统一错误处理。host 模块。
 * 所有命令的错误在此统一收口：
 * - 用户取消（CANCELLED）：直接返回，不输出错误；
 * - svn 缺失（ENOENT）：警告提示并指向 svnAnywhere.svnPath 配置项；
 * - 其余失败：完整 stderr 进输出频道，弹首行摘要错误框并附「显示输出」。
 */
import * as vscode from 'vscode';
import { SvnError } from '../../core/errors';
import { readShowOutputOnError } from '../config';
import { format, strings } from '../i18n';
import { logExitCode, logLine, showOutput, type OutputKind } from '../output';

/**
 * 命令回调签名：资源管理器单选传 uri；多选时 VSCode 额外把完整选区作为
 * 第二个参数传入（Uri[]，含 uri 自身），需要批量的命令消费该数组。
 */
export type CommandHandler = (uri?: vscode.Uri, uris?: vscode.Uri[]) => unknown;

export function registerCommand(
  context: vscode.ExtensionContext,
  id: string,
  handler: CommandHandler,
  kind: OutputKind = 'other',
): vscode.Disposable {
  const disposable = vscode.commands.registerCommand(id, async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    // 回调必须 async：同步抛错也要进统一收口，否则会绕过 showCommandError。
    try {
      await handler(uri, uris);
    } catch (err) {
      showCommandError(err, kind);
    }
  });
  context.subscriptions.push(disposable);
  return disposable;
}

/**
 * 错误弹窗与频道摘要行的最大长度：超长 stderr 经 tailText 截断后首行
 * 仍可能有数 KB，再截短一次保证提示框可读。
 */
const SUMMARY_MAX_CHARS = 300;

/** 取消息首行做摘要，超长时截短加省略号。 */
function errorSummary(message: string): string {
  const first = message.split('\n')[0]?.trim() ?? '';
  return first.length > SUMMARY_MAX_CHARS ? `${first.slice(0, SUMMARY_MAX_CHARS)}…` : first;
}

export function showCommandError(err: unknown, kind: OutputKind = 'other'): void {
  if (err instanceof SvnError && err.code === 'CANCELLED') {
    return;
  }

  if (err instanceof SvnError) {
    // 频道写「摘要行 + 完整 stderr 一次」：业务失败时 message 就是 stderr 的
    // 截断版（tailText），若整段再写一遍 message 会造成最长 2×8K 的重复。
    // 命令以非零退出码结束时补记退出码行（成功路径由 onExit 记录）。
    if (err.exitCode !== undefined) {
      logExitCode(err.exitCode, kind);
    }
    logLine(format(strings.error.failed, { message: errorSummary(err.message) }), kind);
    if (err.stderr) {
      logLine(err.stderr, kind);
    }
    if (err.code === 'ENOENT') {
      void vscode.window.showWarningMessage(strings.activation.svnMissing);
      return;
    }
    showErrorSummary(errorSummary(err.message), kind);
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  logLine(format(strings.error.failed, { message: errorSummary(message) }), kind);
  showErrorSummary(errorSummary(message), kind);
}

/** 弹错误摘要；按配置决定是否先自动切到输出面板（不抢焦点）。 */
function showErrorSummary(summary: string, kind: OutputKind): void {
  if (readShowOutputOnError()) {
    showOutput(true, kind);
  }
  void vscode.window
    .showErrorMessage(summary, strings.error.buttonShowOutput)
    .then((picked) => {
      if (picked === strings.error.buttonShowOutput) {
        showOutput(false, kind);
      }
    });
}
