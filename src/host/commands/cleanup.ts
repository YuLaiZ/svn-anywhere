/**
 * 「清理」命令（F59）：进度通知中执行 svn cleanup，输出原样进输出频道。
 */
import * as vscode from 'vscode';
import { statSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { runOrThrow } from '../../core/svnCli';
import { escapePeg } from '../../core/workspace';
import { readSvnPath, readTimeoutMs } from '../config';
import { format, strings } from '../i18n';
import { createLineBuffer, logCommand, logLine, showOutput } from '../output';
import { resolveWorkingCopyTarget } from './target';

export async function commandCleanup(uri?: vscode.Uri): Promise<void> {
  const target = await resolveWorkingCopyTarget(uri, strings.command.cleanup);
  if (!target) {
    return;
  }

  const svnPath = readSvnPath();
  // svn cleanup 只接受目录：目标是文件时对所在目录执行。
  // stat 失败时保留原路径，让 svn 的错误原样呈现。
  let cleanupTarget = target.targetPath;
  try {
    if (statSync(cleanupTarget).isFile()) {
      cleanupTarget = dirname(cleanupTarget);
    }
  } catch {
    // 保留原路径
  }
  const targetArg = escapePeg(relative(target.wcRoot, cleanupTarget));
  const args = ['cleanup', targetArg];
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: format(strings.cleanup.progress, { target: target.targetPath }),
      cancellable: true,
    },
    async () => {
      const buffer = createLineBuffer();
      logCommand(svnPath, args, target.wcRoot);
      await runOrThrow(svnPath, args, {
        cwd: target.wcRoot,
        timeoutMs: readTimeoutMs(),
        onOutput: (chunk) => buffer.push(chunk),
      });
    },
  );

  logLine(strings.cleanup.done);
  showOutput(false);
}
