/**
 * 「刷新状态」命令（F08）：对副本根执行整副本 svn status --xml 并写入输出频道。
 * 与「显示状态」的区别：始终以副本根为目标，不限定右键子路径。
 */
import type * as vscode from 'vscode';
import { runStatus } from '../../core/status';
import { readSvnPath, readTimeoutMs } from '../config';
import { strings } from '../i18n';
import { logCommand, showOutput } from '../output';
import { resolveWorkingCopyTarget } from './target';
import { writeStatusReport } from './statusReport';

export async function commandRefreshStatus(uri?: vscode.Uri): Promise<void> {
  const target = await resolveWorkingCopyTarget(uri, strings.command.refreshStatus);
  if (!target) {
    return;
  }
  const svnPath = readSvnPath();
  // 整副本刷新：相对目标固定为 `.`，条目路径为相对形态（F15）。
  logCommand(svnPath, ['status', '--xml', '.'], target.wcRoot);
  const result = await runStatus(svnPath, '.', {
    cwd: target.wcRoot,
    timeoutMs: readTimeoutMs(),
  });
  writeStatusReport(result);
  showOutput(false);
}
