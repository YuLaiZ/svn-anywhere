/**
 * 「添加」命令（F57）：对未版本控制路径执行 svn add；目录用 --parents
 * 补齐上级登记，与终端 svn add 递归语义一致（提交面板内的勾选添加在
 * 阶段 1 已交付，本命令是独立的右键入口）。
 */
import * as vscode from 'vscode';
import { buildAddArgs, isVersioned } from '../../core/dailyOps';
import { runStatus } from '../../core/status';
import { runOrThrow } from '../../core/svnCli';
import { readSvnPath, readTimeoutMs } from '../config';
import { format, strings } from '../i18n';
import { createLineBuffer, decodingRunOptions, logCommand, logExitCode, showOutput } from '../output';
import { resolveWorkingCopyTarget } from './target';
import { beginDailyWrite, finishDailyWrite, nodeKindFor, targetRelOf } from './dailyCommon';

export async function commandAdd(uri?: vscode.Uri): Promise<void> {
  const target = await resolveWorkingCopyTarget(uri, strings.command.add);
  if (!target) {
    return;
  }

  const svnPath = readSvnPath();
  const relPath = targetRelOf(target);
  const runOptions = { cwd: target.wcRoot, timeoutMs: readTimeoutMs(), ...decodingRunOptions('other'), onExit: logExitCode };
  const status = await runStatus(svnPath, relPath, runOptions);
  const own = status.entries.find((entry) => entry.path === relPath);
  if (own && own.wcStatus === 'missing') {
    // 本地文件缺失时 add 无从执行；missing 属于登记删除/还原的范畴。
    void vscode.window.showWarningMessage(format(strings.add.missingTarget, { path: relPath }));
    return;
  }
  if (own ? own.wcStatus !== 'unversioned' : await isVersioned(svnPath, target.wcRoot, relPath, runOptions)) {
    // status 对 normal 目标与深层未版本控制路径都不输出条目，后者靠
    // svn info 区分；条目存在且非 unversioned（modified/added 等）已受控。
    void vscode.window.showInformationMessage(format(strings.add.alreadyVersioned, { path: relPath }));
    return;
  }
  const kind = nodeKindFor(relPath, target.targetPath, status.entries);

  const operationId = await beginDailyWrite(target.wcRoot, relPath, kind);
  if (!operationId) {
    return;
  }
  // 目录递归添加（忽略模式由 svn 按 CLI 语义处理）；A 行流式进输出频道。
  const args = buildAddArgs(relPath, { parents: true });
  try {
    const buffer = createLineBuffer();
    await runOrThrow(svnPath, args, {
      ...runOptions,
      onOutput: (chunk) => buffer.push(chunk),
      onExit: logCommand(svnPath, args, target.wcRoot),
    });
  } finally {
    await finishDailyWrite(operationId);
  }
  void vscode.window.showInformationMessage(format(strings.add.done, { path: relPath }));
  showOutput(false);
}
