/**
 * 「清理」命令（F59）：模态确认（写明影响范围）后在进度通知中执行
 * svn cleanup，输出原样进输出频道。
 */
import * as vscode from 'vscode';
import { statSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { runOrThrow } from '../../core/svnCli';
import { beginDailyWrite, executeRecordedWrite } from './dailyCommon';
import { escapePeg } from '../../core/workspace';
import { readSvnPath, readTimeoutMs } from '../config';
import { format, strings } from '../i18n';
import { createLineBuffer, decodingRunOptions, logCommand, logLine, showOutput } from '../output';
import { resolveWorkingCopyTarget } from './target';
import { confirmModal } from '../ui/confirm';

export async function commandCleanup(uri?: vscode.Uri): Promise<void> {
  const target = await resolveWorkingCopyTarget(uri, strings.command.cleanup);
  if (!target) {
    return;
  }

  // 二次确认：cleanup 会清理工作副本锁与未完成的操作日志，统一走模态确认。
  const confirmed = await confirmModal(
    format(strings.cleanup.confirmTitle, { target: target.targetPath }),
    strings.cleanup.confirmButton,
  );
  if (!confirmed) {
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
  const rel = relative(target.wcRoot, cleanupTarget) || '.';
  const operationId = await beginDailyWrite(target.wcRoot, rel, 'dir', 'cleanup', [rel], 'cleanup');
  if (!operationId) return;
  await executeRecordedWrite(operationId, () =>
    runCleanup(svnPath, ['cleanup', escapePeg(rel)], target, cleanupTarget));
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
    async (_progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      if (token.isCancellationRequested) abort.abort();
      const buffer = createLineBuffer();
      await runOrThrow(svnPath, args, {
        cwd: target.wcRoot,
        signal: abort.signal,
        timeoutMs: readTimeoutMs(),
        ...decodingRunOptions('other'),
        onOutput: (chunk) => buffer.push(chunk),
        onExit: logCommand(svnPath, args, target.wcRoot),
      });
    },
  );

  logLine(strings.cleanup.done);
  showOutput(false);
}
