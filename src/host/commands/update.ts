/**
 * 「更新」命令（F16/F17/F19）：执行前模态确认目标路径，确认后以进度通知
 * 执行 svn update（可取消），流式回显明细，完成后汇总最终 revision 与冲突。
 * 更新执行段（performUpdate）供提交前检查（F145）复用。
 */
import * as vscode from 'vscode';
import { relative } from 'node:path';
import { runUpdate, type UpdateRunResult } from '../../core/update';
import { getOperationRegistry } from '../../core/operations';
import { escapePeg } from '../../core/workspace';
import { readSvnPath, readTimeoutMs } from '../config';
import { format, strings } from '../i18n';
import { createLineBuffer, logCommand, logExitCode, logLine, showOutput } from '../output';
import { resolveWorkingCopyTarget, type WcTarget } from './target';
import { confirmModal } from '../ui/confirm';
import { promptForCredentials } from '../auth';

export async function commandUpdate(uri?: vscode.Uri): Promise<void> {
  const target = await resolveWorkingCopyTarget(uri, strings.command.update);
  if (!target) {
    return;
  }

  const svnPath = readSvnPath();
  const confirmed = await confirmModal(
    format(strings.update.confirmTitle, { target: target.targetPath }),
    strings.update.confirmButton,
  );
  if (!confirmed) {
    return;
  }

  await performUpdate(target, svnPath);
}

/**
 * 更新前的注册表互斥：同一工作副本有在途/受限操作（提交中、结果未知、
 * 待协调）时拒绝执行；返回登记的操作 ID（执行完须 finish）或 undefined。
 */
export async function beginUpdateOperation(wcRoot: string): Promise<string | undefined> {
  const registry = getOperationRegistry();
  const held = registry.writeRestriction(wcRoot);
  if (held) {
    void vscode.window.showWarningMessage(format(strings.panel.operationHeldBusy, { phase: held.phase }));
    return undefined;
  }
  const begin = await registry.begin({ wcRoot, targetRelPath: '.', nodeKind: 'dir' });
  if (!begin.ok) {
    void vscode.window.showWarningMessage(format(strings.panel.operationHeldBusy, { phase: begin.heldBy.phase }));
    return undefined;
  }
  return begin.operationId;
}

/** 更新操作登记释放（幂等）。 */
export async function finishUpdateOperation(operationId: string | undefined): Promise<void> {
  await getOperationRegistry().finish(operationId);
}

/**
 * 执行一次更新并完成回显：进度通知（可取消）、流式明细、最终 revision
 * 与冲突汇总都写输出频道；有冲突时弹警告列出文件。返回执行结果供
 * 提交流程判断是否继续。
 */
export async function performUpdate(target: WcTarget, svnPath: string): Promise<UpdateRunResult> {
  // 注册表互斥：同一副本有在途/受限操作时拒绝更新（含从资源管理器入口）。
  const operationId = await beginUpdateOperation(target.wcRoot);
  if (!operationId) {
    return { stdout: '', stderr: '', exitCode: 0, items: [], conflicts: [] };
  }
  try {
    return await executeUpdate(target, svnPath);
  } finally {
    await finishUpdateOperation(operationId);
  }
}

async function executeUpdate(target: WcTarget, svnPath: string): Promise<UpdateRunResult> {
  // 与终端 svn update 一致：以副本根为 cwd 传相对目标，明细路径为相对形态；
  // 目标是副本根时归一为 `.`，避免空参数。
  // core 的 runUpdate 内部做 peg 转义，这里日志记录转义后的实际命令。
  const targetArg = relative(target.wcRoot, target.targetPath) || '.';
  const args = ['update', '--non-interactive', escapePeg(targetArg)];

  // 进度通知的取消按钮桥接 AbortSignal，传给 core 的 svn 执行层。
  const abort = new AbortController();
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: format(strings.update.progress, { target: target.targetPath }),
      cancellable: true,
    },
    async (_progress, token) => {
      token.onCancellationRequested(() => abort.abort());
      const buffer = createLineBuffer();
      logCommand(svnPath, args, target.wcRoot);
      return runUpdate(svnPath, targetArg, {
        cwd: target.wcRoot,
        signal: abort.signal,
        timeoutMs: readTimeoutMs(),
        onOutput: (chunk) => buffer.push(chunk),
        onExit: logExitCode,
        // 认证失败时弹窗补录并重试一次（F67）；密码只在内存。
        getCredentials: promptForCredentials,
        // 重试命令回显到输出频道（logCommand 内置脱敏，密码不外泄）。
        onCredentialRetry: (args) => logCommand(svnPath, args, target.wcRoot),
      });
    },
  );

  // 明细行已随流式输出进频道，这里补最终 revision 与冲突汇总。
  logLine(
    result.finalRevision === undefined
      ? strings.update.doneNoRevision
      : format(strings.update.done, { revision: String(result.finalRevision) }),
  );
  showOutput(false);

  if (result.conflicts.length > 0) {
    void vscode.window.showWarningMessage(
      format(strings.update.conflicts, {
        count: String(result.conflicts.length),
        paths: result.conflicts.join('、'),
      }),
    );
    return result;
  }
  // 兜底：Summary 段报告了冲突但明细行未能定位到文件时，不静默放行。
  const summaryTotal = Object.values(result.conflictSummary ?? {}).reduce((sum, n) => sum + (n ?? 0), 0);
  if (summaryTotal > 0) {
    void vscode.window.showWarningMessage(format(strings.update.conflictsUnresolved, { count: String(summaryTotal) }));
  }
  return result;
}
