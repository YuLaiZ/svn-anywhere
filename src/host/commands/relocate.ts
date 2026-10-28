/**
 * 「重定位」命令（F118）：读取当前仓库地址，输入新地址并确认后执行
 * svn relocate；失败时给出「仅同一仓库换地址可用」的针对性提示。
 */
import * as vscode from 'vscode';
import { buildRelocateArgs, readRepositoryUrl } from '../../core/relocate';
import { runOrThrow } from '../../core/svnCli';
import { SvnError } from '../../core/errors';
import { escapePeg } from '../../core/workspace';
import { readSvnPath, readTimeoutMs } from '../config';
import { format, strings } from '../i18n';
import { logCommand, logLine, showOutput } from '../output';
import { resolveWorkingCopyTarget } from './target';
import { confirmModal } from '../ui/confirm';
import { promptForCredentials } from '../auth';

export async function commandRelocate(uri?: vscode.Uri): Promise<void> {
  const target = await resolveWorkingCopyTarget(uri, strings.command.relocate);
  if (!target) {
    return;
  }

  const svnPath = readSvnPath();
  const runOptions = { cwd: target.wcRoot, timeoutMs: readTimeoutMs() };

  // relocate 作用于副本根，从副本根读当前地址。
  logCommand(svnPath, ['info', '--show-item', 'url', escapePeg(target.wcRoot)], target.wcRoot);
  const oldUrl = await readRepositoryUrl(svnPath, target.wcRoot, runOptions);

  const newUrl = await vscode.window.showInputBox({
    prompt: format(strings.relocate.inputPrompt, { oldUrl }),
    value: oldUrl,
    ignoreFocusOut: true,
  });
  if (newUrl === undefined) {
    return;
  }
  const trimmedUrl = newUrl.trim();
  if (trimmedUrl === '' || trimmedUrl === oldUrl) {
    void vscode.window.showInformationMessage(strings.relocate.sameUrlRejected);
    return;
  }

  const confirmed = await confirmModal(
    format(strings.relocate.confirmTitle, {
      wcRoot: target.wcRoot,
      oldUrl,
      newUrl: trimmedUrl,
    }),
    strings.relocate.confirmButton,
  );
  if (!confirmed) {
    return;
  }

  const args = buildRelocateArgs(trimmedUrl, target.wcRoot);
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: format(strings.relocate.progress, { wcRoot: target.wcRoot }),
        cancellable: false,
      },
      async () => {
        logCommand(svnPath, args, target.wcRoot);
        const result = await runOrThrow(svnPath, args, {
          ...runOptions,
          getCredentials: promptForCredentials,
        });
        logLine(result.stdout.trim());
      },
    );
  } catch (err) {
    // 换仓库是最常见的失败原因，给出针对性提示而不是泛用错误框。
    const message = err instanceof Error ? err.message : String(err);
    logLine(message);
    if (err instanceof SvnError && err.stderr) {
      logLine(err.stderr);
    }
    showOutput(false);
    void vscode.window.showWarningMessage(
      format(strings.relocate.failureHint, { message: message.split('\n')[0] ?? message }),
    );
    return;
  }

  logLine(strings.relocate.done);
  showOutput(false);
  void vscode.window.showInformationMessage(strings.relocate.done);
}
