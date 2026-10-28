/**
 * 「提交」命令（F22–F30、F145/F81）：提交前按配置检查远端更新；文件多选、
 * 说明输入、missing 登记删除、临时文件传说明、结果反馈与提交后刷新。
 */
import * as vscode from 'vscode';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { buildCommitArgs, parseCommitOutput, COMMIT_BATCH_SIZE } from '../../core/commit';
import { commitableEntries, runStatus } from '../../core/status';
import { remoteChangedEntries, runRemoteStatus } from '../../core/remoteStatus';
import { runOrThrow, type RunResult } from '../../core/svnCli';
import { SvnError } from '../../core/errors';
import { escapePeg } from '../../core/workspace';
import {
  readAllowEmptyCommitMessage,
  readRemoteCheckBeforeCommit,
  readSvnPath,
  readTimeoutMs,
} from '../config';
import { format, strings } from '../i18n';
import { logCommand, logLine, showOutput } from '../output';
import { resolveWorkingCopyTarget, type WcTarget } from './target';
import { performUpdate } from './update';
import { promptForCredentials } from '../auth';
import { confirmModal } from '../ui/confirm';
import { inputCommitMessage, pickCommitFiles } from '../ui/commitQuickPick';
import { writeStatusReport } from './statusReport';

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
    const proceed = await remoteCheckBeforeCommit(target, svnPath, targetArg, runOptions);
    if (!proceed) {
      return;
    }
  }

  logCommand(svnPath, ['status', '--xml', targetArg], target.wcRoot);
  const status = await runStatus(svnPath, targetArg, runOptions);
  const changes = commitableEntries(status);
  if (changes.length === 0) {
    void vscode.window.showInformationMessage(strings.commitCheck.noChanges);
    return;
  }

  // 文件多选：条目路径相对目标；差异查看与提交参数都需要换算成相对副本根。
  const toWcRelative = (entryPath: string): string =>
    relative(target.wcRoot, entryPath === targetArg ? target.targetPath : join(target.targetPath, entryPath));

  const picked = await pickCommitFiles(status.entries, {
    title: format(strings.commit.pickTitle, { target: target.targetPath }),
    placeholder: strings.commit.pickPlaceholder,
    onDiff: (entry) => void showDiff(target, svnPath, toWcRelative(entry.path)),
  });
  if (!picked || picked.length === 0) {
    return;
  }

  const message = await inputCommitMessage(
    format(strings.commit.messagePrompt, { count: String(picked.length), target: target.targetPath }),
  );
  if (message === undefined) {
    return;
  }
  if (message.trim() === '') {
    if (!readAllowEmptyCommitMessage()) {
      void vscode.window.showInformationMessage(strings.commit.emptyMessageRejected);
      return;
    }
    const again = await confirmModal(strings.commit.emptyMessageConfirm, strings.commit.continueButton);
    if (!again) {
      return;
    }
  }

  // missing（F25）：本地已删除但未登记 SVN 删除的文件，确认后逐个 svn delete --force。
  const missing = picked.filter((item) => item.wcStatus === 'missing');
  if (missing.length > 0) {
    const ok = await confirmModal(
      format(strings.commit.missingConfirm, { count: String(missing.length) }),
      strings.commit.continueButton,
    );
    if (!ok) {
      return;
    }
    for (const item of missing) {
      const missingPath = escapePeg(toWcRelative(item.path));
      logCommand(svnPath, ['delete', '--force', missingPath], target.wcRoot);
      await runOrThrow(svnPath, ['delete', '--force', missingPath], runOptions);
    }
  }

  const revision = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: format(strings.commit.commitProgress, { count: String(picked.length) }),
      cancellable: false,
    },
    () => executeCommit(target, svnPath, picked.map((item) => toWcRelative(item.path)), message),
  );

  logLine(
    revision === undefined
      ? strings.commit.committedNoRevision
      : format(strings.commit.committed, { revision: String(revision) }),
  );
  showOutput(false);
  void vscode.window.showInformationMessage(
    revision === undefined
      ? strings.commit.committedNoRevision
      : format(strings.commit.committed, { revision: String(revision) }),
  );

  // 提交后刷新（F30）：重新读取状态写入频道。
  logLine(strings.commit.refreshHeader);
  const after = await runStatus(svnPath, targetArg, runOptions);
  writeStatusReport(after);
}

/** 阶段 4 的远端检查流程；返回 false 表示用户放弃继续（或冲突阻止）。 */
async function remoteCheckBeforeCommit(
  target: WcTarget,
  svnPath: string,
  targetArg: string,
  runOptions: { cwd: string; timeoutMs: number },
): Promise<boolean> {
  logCommand(svnPath, ['status', '-u', '--non-interactive', '--xml', targetArg], target.wcRoot);
  const remote = await runRemoteStatus(svnPath, targetArg, {
    ...runOptions,
    // 远端检查遇认证失败同样弹窗补录（F67）。
    getCredentials: promptForCredentials,
  });
  const remoteChanges = remoteChangedEntries(remote);
  logLine(
    format(strings.commitCheck.remoteSummary, {
      count: String(remoteChanges.length),
      against: remote.against === undefined ? '—' : String(remote.against),
    }),
  );
  if (remoteChanges.length === 0) {
    return true;
  }

  const choice = await vscode.window.showWarningMessage(
    format(strings.commitCheck.confirmTitle, { count: String(remoteChanges.length) }),
    { modal: true },
    strings.commitCheck.updateAndContinue,
    strings.commitCheck.updateOnly,
    strings.commitCheck.cancel,
  );
  if (choice === undefined || choice === strings.commitCheck.cancel) {
    return false;
  }

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
    return false;
  }
  // 仅更新：到此结束；更新并继续：返回后重新执行 status。
  return choice === strings.commitCheck.updateAndContinue;
}

/**
 * 执行提交：说明写入临时文件，路径分批（>100 拆批）执行；
 * 全部批次成功后返回最后一批的新 revision。失败以 SvnError 抛出，
 * 由统一错误收口展示完整 stderr。
 */
async function executeCommit(
  target: WcTarget,
  svnPath: string,
  paths: string[],
  message: string,
): Promise<number | undefined> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'svn-anywhere-commit-'));
  try {
    const messageFile = join(tmpDir, 'message.txt');
    writeFileSync(messageFile, message, 'utf8');

    let lastResult: RunResult | undefined;
    let lastRevision: number | undefined;
    for (let offset = 0; offset < paths.length; offset += COMMIT_BATCH_SIZE) {
      const batch = paths.slice(offset, offset + COMMIT_BATCH_SIZE);
      const args = buildCommitArgs(messageFile, batch);
      logCommand(svnPath, args, target.wcRoot);
      lastResult = await runOrThrow(svnPath, args, {
        cwd: target.wcRoot,
        timeoutMs: readTimeoutMs(),
        getCredentials: promptForCredentials,
      });
      logLine(lastResult.stdout.trimEnd());
      lastRevision = parseCommitOutput(lastResult.stdout).revision ?? lastRevision;
    }
    return lastRevision;
  } catch (err) {
    // 空说明兜底：个别 svn 配置拒绝空日志时回退为 -m "" 重试一次。
    if (
      message.trim() === '' &&
      err instanceof SvnError &&
      /empty commit|空日志/i.test(err.message)
    ) {
      const args = ['commit', '--non-interactive', '-m', '', ...paths.map((p) => escapePeg(p))];
      logCommand(svnPath, args, target.wcRoot);
      const result = await runOrThrow(svnPath, args, {
        cwd: target.wcRoot,
        timeoutMs: readTimeoutMs(),
        getCredentials: promptForCredentials,
      });
      logLine(result.stdout.trimEnd());
      return parseCommitOutput(result.stdout).revision;
    }
    throw err;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** 把 svn diff 文本写入输出频道（M1 不引入 vscode.diff）。 */
async function showDiff(target: WcTarget, svnPath: string, wcRelativePath: string): Promise<void> {
  const args = ['diff', escapePeg(wcRelativePath)];
  logCommand(svnPath, args, target.wcRoot);
  const result = await runOrThrow(svnPath, args, { cwd: target.wcRoot, timeoutMs: readTimeoutMs() });
  logLine(format(strings.commit.diffHeader, { path: wcRelativePath }));
  logLine(result.stdout.trim() || strings.commit.diffClean);
  showOutput(false);
}
