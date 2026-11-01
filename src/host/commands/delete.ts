/**
 * 「删除」命令（F57）：对已版本控制路径执行 svn delete，默认同时删除
 * 本地文件并登记 SVN 删除（与 TortoiseSVN 一致，确认框写明）；missing
 * 目标视为「补登记删除」。--keep-local 仅为后续扩展位，当前无入口。
 * 目录删除是结构性删除：确认框枚举完整影响子树。
 */
import * as vscode from 'vscode';
import { buildDeleteArgs, listVersionedSubtree } from '../../core/dailyOps';
import { runStatus } from '../../core/status';
import { runOrThrow } from '../../core/svnCli';
import { readSvnPath, readTimeoutMs } from '../config';
import { format, strings } from '../i18n';
import { createLineBuffer, decodingRunOptions, logCommand, logExitCode, showOutput } from '../output';
import { confirmModal } from '../ui/confirm';
import { resolveWorkingCopyTarget } from './target';
import { beginDailyWrite, finishDailyWrite, nodeKindFor, targetRelOf } from './dailyCommon';

/** 确认框中影响子树的最大列举条目（与提交面板行内删除一致）。 */
const SUBTREE_LIST_LIMIT = 50;

export async function commandDelete(uri?: vscode.Uri): Promise<void> {
  const target = await resolveWorkingCopyTarget(uri, strings.command.delete);
  if (!target) {
    return;
  }

  const svnPath = readSvnPath();
  const relPath = targetRelOf(target);
  const runOptions = { cwd: target.wcRoot, timeoutMs: readTimeoutMs(), ...decodingRunOptions('other'), onExit: logExitCode };
  const status = await runStatus(svnPath, relPath, runOptions);
  const own = status.entries.find((entry) => entry.path === relPath);
  if (own && own.wcStatus === 'unversioned') {
    // SVN 删除仅适用于已版本控制路径；未版本控制文件不走本命令。
    void vscode.window.showInformationMessage(format(strings.deleteOp.unversionedTarget, { path: relPath }));
    return;
  }
  // 干净目录 status 无条目，类型以 stat 为准；missing 时由子条目前缀兜底。
  const kind = nodeKindFor(relPath, target.targetPath, status.entries);
  const missing = own?.wcStatus === 'missing';

  // 目录删除是结构性删除：确认框枚举版本控制子树（missing 目录同样枚举仓库侧清单）。
  let subtree: string[] = [];
  if (kind === 'dir') {
    subtree = await listVersionedSubtree(svnPath, target.wcRoot, relPath, {
      ...runOptions,
      onExit: logCommand(svnPath, ['list', '-R', '--', relPath], target.wcRoot),
    });
  }
  const subtreeLines = subtree.length
    ? subtree
        .slice(0, SUBTREE_LIST_LIMIT)
        .map((path) => `· ${relPath}/${path}`)
        .join('\n') +
      (subtree.length > SUBTREE_LIST_LIMIT
        ? `\n· ${format(strings.list.moreSuffix, { count: String(subtree.length) })}`
        : '')
    : '';

  const detail = missing
    ? format(strings.deleteOp.confirmDetailMissing, { path: relPath })
    : `${strings.deleteOp.confirmDetail}\n${relPath}`;
  const impact =
    `${detail}${subtreeLines ? `\n${subtreeLines}` : ''}` +
    (kind === 'dir' ? `\n${strings.deleteOp.dirNote}` : '') +
    `\n${strings.deleteOp.irreversibleNote}`;
  const confirmed = await confirmModal(impact, strings.deleteOp.confirmButton);
  if (!confirmed) {
    return;
  }

  const operationId = await beginDailyWrite(target.wcRoot, relPath, kind);
  if (!operationId) {
    return;
  }
  // --force：允许删除本地有修改的条目（确认框已列出影响，与面板行内删除一致）。
  const args = buildDeleteArgs(relPath, { force: true });
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
  void vscode.window.showInformationMessage(format(strings.deleteOp.done, { path: relPath }));
  showOutput(false);
}
