/**
 * 「还原」命令（F58）：单文件与整目录递归还原；确认框列出将还原的
 * 文件数量与路径，明确丢弃本地修改的不可逆性。目录用 -R 递归（与
 * 提交面板行内「只还原目录节点登记」的范围差异在确认文案中写明）。
 */
import * as vscode from 'vscode';
import { buildRevertArgs, isInsideExternalPrefixes, revertableEntries } from '../../core/dailyOps';
import { runStatus } from '../../core/status';
import { runOrThrow } from '../../core/svnCli';
import { readSvnPath, readTimeoutMs } from '../config';
import { format, strings } from '../i18n';
import { createLineBuffer, logCommand, logExitCode, showOutput } from '../output';
import { confirmModal } from '../ui/confirm';
import { resolveWorkingCopyTarget } from './target';
import { beginDailyWrite, finishDailyWrite, nodeKindFor, targetRelOf } from './dailyCommon';

/** 确认框中路径清单的最大列举条目。 */
const REVERT_LIST_LIMIT = 50;

export async function commandRevert(uri?: vscode.Uri): Promise<void> {
  const target = await resolveWorkingCopyTarget(uri, strings.command.revert);
  if (!target) {
    return;
  }

  const svnPath = readSvnPath();
  const relPath = targetRelOf(target);
  const runOptions = { cwd: target.wcRoot, timeoutMs: readTimeoutMs(), onExit: logExitCode };
  const status = await runStatus(svnPath, relPath, runOptions);
  // externals 边界：目录递归还原不跨 external（实测 svn 1.15），主副本目标
  // 的确认清单须隔离 external 内部条目（status 会递归列出）；用户明确选中
  // 的路径在 external 内时不过滤——对具体路径的 svn revert 仍作用于该
  // external 工作副本，属用户显式意图。
  const targetInsideExternal =
    isInsideExternalPrefixes(relPath, status.externals) || status.externals.includes(relPath);
  const scopedEntries = targetInsideExternal
    ? status.entries
    : status.entries.filter((entry) => !isInsideExternalPrefixes(entry.path, status.externals));
  const pending = revertableEntries(scopedEntries);
  if (pending.length === 0) {
    void vscode.window.showInformationMessage(format(strings.revert.nothing, { path: relPath }));
    return;
  }
  // 干净目录 status 无条目，类型以 stat 为准；missing 时由子条目前缀兜底。
  const isDir = nodeKindFor(relPath, target.targetPath, status.entries) === 'dir';

  const listed = pending.slice(0, REVERT_LIST_LIMIT).map((entry) => `· ${entry.path}`);
  const overflow =
    pending.length > REVERT_LIST_LIMIT
      ? [`· ${format(strings.list.moreSuffix, { count: String(pending.length) })}`]
      : [];
  const impact = [
    format(strings.revert.confirmDetail, { count: String(pending.length) }),
    ...listed,
    ...overflow,
    isDir ? strings.revert.dirNote : '',
    strings.revert.irreversibleNote,
  ]
    .filter((line) => line.length > 0)
    .join('\n');
  const confirmed = await confirmModal(impact, strings.revert.confirmButton);
  if (!confirmed) {
    return;
  }

  const operationId = await beginDailyWrite(target.wcRoot, relPath, isDir ? 'dir' : 'file');
  if (!operationId) {
    return;
  }
  const args = buildRevertArgs(relPath, { recursive: isDir });
  try {
    logCommand(svnPath, args, target.wcRoot);
    const buffer = createLineBuffer();
    await runOrThrow(svnPath, args, {
      ...runOptions,
      onOutput: (chunk) => buffer.push(chunk),
    });
  } finally {
    await finishDailyWrite(operationId);
  }
  void vscode.window.showInformationMessage(
    format(strings.revert.done, { count: String(pending.length), path: relPath }),
  );
  showOutput(false);
}
