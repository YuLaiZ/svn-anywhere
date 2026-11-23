import * as vscode from 'vscode';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { getOperationRegistry, kindOf, lockKeyOf, type OperationRecord } from '../../core/operations';
import { readNodeIdentity } from '../../core/nodeIdentity';
import { runStatus } from '../../core/status';
import { runOrThrow } from '../../core/svnCli';
import { escapePeg, findWorkingCopy } from '../../core/workspace';
import { readSvnPath, readTimeoutMs } from '../config';
import { decodingRunOptions, logLine, showOutput } from '../output';
import { openDepthPanel } from '../panel/panels/depth';
import { openConflictTarget } from './conflicts';

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

export async function commandRecoverOperation(uri?: vscode.Uri): Promise<void> {
  const registry = getOperationRegistry();
  const selectedRoot = uri?.scheme === 'file' ? findWorkingCopy(uri.fsPath) : undefined;
  const all = await registry.loadAllRecords();
  const relevant = all.filter((record) => record.phase !== 'done' && record.phase !== 'failed-unconfirmed' &&
    (!selectedRoot || lockKeyOf(record) === selectedRoot));
  if (!relevant.length) {
    void vscode.window.showInformationMessage('没有待恢复的 SVN 操作。');
    return;
  }
  const choice = await vscode.window.showQuickPick(relevant.map((record) => ({
    label: record.writeAction ?? kindOf(record), description: record.wcRoot,
    detail: record.targetRelPath + ' · ' + (record.phase === 'residue-pending' ? '有剩余步骤' : '待检查'),
    record,
  })), { placeHolder: '选择要查看或恢复的操作' });
  if (!choice) return;
  const key = lockKeyOf(choice.record);
  await registry.refreshWorkspace(key);
  const record = registry.pendingForWcRoot(key).find((item) => item.operationId === choice.record.operationId);
  if (!record) {
    void vscode.window.showInformationMessage('该操作已结束，请刷新状态。');
    return;
  }
  if (kindOf(record) === 'depth-edit' && record.depthIntent) {
    await openDepthPanel({ wcRoot: key, targetPath: record.depthIntent.scopePath });
    return;
  }
  const command = ownerCommand(record);
  if (command) {
    const target = record.historyUpdateIntent?.targetRelPath ?? record.targetRelPath;
    const uri = vscode.Uri.file(resolve(record.targetPath ?? key, target));
    await vscode.commands.executeCommand(command, uri);
    return;
  }
  if (record.phase !== 'unknown') {
    void vscode.window.showWarningMessage('该操作仍在执行，结束后可重新检查。');
    return;
  }
  const settled = await registry.withRecoveryLease(record.operationId, (latest) => reviewCurrentState(latest));
  if (settled === undefined) void vscode.window.showWarningMessage('暂时无法取得回扫权限，请稍后重试。');
}

function ownerCommand(record: OperationRecord): string | undefined {
  switch (kindOf(record)) {
    case 'commit': return 'svnAnywhere.commit';
    case 'ignore': return 'svnAnywhere.editIgnore';
    case 'checkout': return 'svnAnywhere.checkout';
    case 'import': return 'svnAnywhere.importLocal';
    case 'vacuum': return 'svnAnywhere.diskUsage';
    case 'history-update': return 'svnAnywhere.showHistory';
    case 'resolve': return 'svnAnywhere.scanConflicts';
    default: return undefined;
  }
}

async function reviewCurrentState(record: OperationRecord): Promise<boolean> {
  const root = record.wcRoot;
  if (findWorkingCopy(root) !== root) throw new Error('原工作副本身份无法确认，写入限制仍保留');
  const targets = (record.explicitPaths?.length ? record.explicitPaths : [record.targetRelPath])
    .map((path) => resolve(root, path));
  if (targets.some((target) => !within(root, target))) throw new Error('原操作目标超出工作副本');
  const svn = readSvnPath();
  const options = { cwd: root, timeoutMs: readTimeoutMs(), ...decodingRunOptions('other'), ignoreExternals: true };
  // 从副本根读取完整状态，包含已删除的目标，避免用一次无输出推断未生效。
  const identity = await readNodeIdentity(svn, root, options);
  if (record.repositoryUuid && identity.repositoryUuid !== record.repositoryUuid) throw new Error('原仓库身份已变化');
  let status = await runStatus(svn, root, options);
  if (status.entries.some((entry) => entry.wcLocked || entry.wcStatus === 'incomplete')) {
    const repair = await vscode.window.showWarningMessage(
      '工作副本有残留锁或未完成状态。确认外部 SVN 进程已退出后，可以在当前恢复操作中执行普通清理。',
      { modal: true }, '清理后重新回扫');
    if (repair !== '清理后重新回扫') return false;
    await runOrThrow(svn, ['cleanup', '--', escapePeg(root)], options);
    status = await runStatus(svn, root, options);
    if (status.entries.some((entry) => entry.wcLocked || entry.wcStatus === 'incomplete')) {
      throw new Error('清理后仍有未完成状态，写入限制仍保留');
    }
  }
  const touched = status.entries.filter((entry) => targets.some((target) => within(target, resolve(root, entry.path))));
  logLine('操作回扫 · ' + root + ' · r' + identity.revision);
  for (const entry of touched) logLine(entry.wcStatus + ' · ' + entry.path);
  showOutput(true);
  const proceed = await vscode.window.showWarningMessage(
    '工作副本当前状态已读取，原操作结果仍无法判定。确认后保留现状并结束恢复，已生效的变更会保留。',
    { modal: true }, '保留现状并结束恢复');
  if (proceed !== '保留现状并结束恢复') return false;
  await getOperationRegistry().finalizeOperation(record.operationId, 'done');
  if (touched.some((entry) => entry.treeConflicted || entry.wcStatus === 'conflicted' || entry.props === 'conflicted')) {
    void openConflictTarget({ wcRoot: root, scopeRelPath: '.', source: 'update' });
  }
  return true;
}
