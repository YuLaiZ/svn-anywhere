/**
 * 「提交」命令（F22/F145/F81）：提交前按配置检查远端更新，提示先更新再提交，
 * 冲突时阻止提交；更新后重新读取状态，把可提交项交给提交面板（阶段 5 实装）。
 */
import * as vscode from 'vscode';
import { commitableEntries, runStatus } from '../../core/status';
import { remoteChangedEntries, runRemoteStatus } from '../../core/remoteStatus';
import { relative } from 'node:path';
import { readRemoteCheckBeforeCommit, readSvnPath, readTimeoutMs } from '../config';
import { format, strings } from '../i18n';
import { logCommand, logLine } from '../output';
import { resolveWorkingCopyTarget } from './target';
import { performUpdate } from './update';

export async function commandCommit(uri?: vscode.Uri): Promise<void> {
  const target = await resolveWorkingCopyTarget(uri, strings.command.commit);
  if (!target) {
    return;
  }

  const svnPath = readSvnPath();
  const runOptions = { cwd: target.wcRoot, timeoutMs: readTimeoutMs() };
  // 与状态命令一致：以副本根为 cwd 传相对目标。
  const targetArg = relative(target.wcRoot, target.targetPath);

  if (readRemoteCheckBeforeCommit()) {
    logCommand(svnPath, ['status', '-u', '--non-interactive', '--xml', targetArg], target.wcRoot);
    const remote = await runRemoteStatus(svnPath, targetArg, runOptions);
    const remoteChanges = remoteChangedEntries(remote);
    logLine(
      format(strings.commitCheck.remoteSummary, {
        count: String(remoteChanges.length),
        against: remote.against === undefined ? '—' : String(remote.against),
      }),
    );
    if (remoteChanges.length > 0) {
      const choice = await vscode.window.showWarningMessage(
        format(strings.commitCheck.confirmTitle, { count: String(remoteChanges.length) }),
        { modal: true },
        strings.commitCheck.updateAndContinue,
        strings.commitCheck.updateOnly,
        strings.commitCheck.cancel,
      );
      if (choice === undefined || choice === strings.commitCheck.cancel) {
        return;
      }

      // 更新并继续 / 仅更新 都先执行更新；冲突时停止，不再进入提交。
      const result = await performUpdate(target, svnPath);
      const unresolvedConflicts =
        result.conflicts.length === 0 &&
        Object.values(result.conflictSummary ?? {}).some((n) => (n ?? 0) > 0);
      if (result.conflicts.length > 0 || unresolvedConflicts) {
        void vscode.window.showInformationMessage(
          format(strings.commitCheck.blockedByConflicts, {
            paths: result.conflicts.length > 0 ? result.conflicts.join('、') : '见输出面板',
          }),
        );
        return;
      }
      if (choice === strings.commitCheck.updateOnly) {
        return;
      }
      // 更新并继续：下方重新执行 status，不复用检查前的结果。
    }
  }

  logCommand(svnPath, ['status', '--xml', targetArg], target.wcRoot);
  const status = await runStatus(svnPath, targetArg, runOptions);
  const changes = commitableEntries(status);
  if (changes.length === 0) {
    void vscode.window.showInformationMessage(strings.commitCheck.noChanges);
    return;
  }

  // 提交面板（文件多选、说明输入、commit 执行）在提交闭环阶段实装；
  // 到达此处即完成提交前检查链路。
  void vscode.window.showInformationMessage(
    format(strings.placeholder.notice, {
      command: strings.command.commit,
      wcRoot: target.wcRoot,
    }),
  );
}
