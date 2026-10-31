/**
 * 「清理」命令（F59）：进度通知中执行 svn cleanup，输出原样进输出频道。
 */
import * as vscode from 'vscode';
import { statSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { runOrThrow } from '../../core/svnCli';
import { getOperationRegistry } from '../../core/operations';
import { escapePeg } from '../../core/workspace';
import { readSvnPath, readTimeoutMs } from '../config';
import { format, strings } from '../i18n';
import { createLineBuffer, logCommand, logExitCode, logLine, showOutput } from '../output';
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
  // 注册表互斥：同一副本有在途/受限操作（提交中/结果未知/待协调）时拒绝清理。
  const registry = getOperationRegistry();
  const held = registry.writeRestriction(target.wcRoot);
  if (held) {
    void vscode.window.showWarningMessage(format(strings.panel.operationHeldBusy, { phase: held.phase }));
    return;
  }
  const begin = await registry.begin({ wcRoot: target.wcRoot, targetRelPath: '.', nodeKind: 'dir' });
  if (!begin.ok) {
    void vscode.window.showWarningMessage(format(strings.panel.operationHeldBusy, { phase: begin.heldBy.phase }));
    return;
  }
  const targetArg = escapePeg(relative(target.wcRoot, cleanupTarget));
  const args = ['cleanup', targetArg];
  try {
    await runCleanup(svnPath, args, target, cleanupTarget);
  } finally {
    await registry.finish(begin.operationId);
  }
}

async function runCleanup(
  svnPath: string,
  args: string[],
  target: { targetPath: string; wcRoot: string },
  cleanupTarget: string,
): Promise<void> {
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
        onExit: logExitCode,
      });
    },
  );

  logLine(strings.cleanup.done);
  showOutput(false);
}
