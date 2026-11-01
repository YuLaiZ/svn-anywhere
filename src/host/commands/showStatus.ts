/**
 * 「显示状态」命令（F09/F15）：对右键路径执行 svn status --xml，
 * 结果按 wcStatus 原词写入输出频道并展示。
 */
import type * as vscode from 'vscode';
import { relative } from 'node:path';
import { runStatus } from '../../core/status';
import { readSvnPath, readTimeoutMs } from '../config';
import { strings } from '../i18n';
import { decodingRunOptions, logCommand, showOutput } from '../output';
import { resolveWorkingCopyTarget } from './target';
import { writeStatusReport } from './statusReport';

export async function commandShowStatus(uri?: vscode.Uri): Promise<void> {
  const target = await resolveWorkingCopyTarget(uri, strings.command.showStatus, 'status');
  if (!target) {
    return;
  }
  const svnPath = readSvnPath();
  // 以副本根为 cwd 传相对目标：条目路径与终端 svn status 的相对形态一致（F15）；
  // 目标是副本根时归一为 `.`，避免空参数。
  const targetArg = relative(target.wcRoot, target.targetPath) || '.';
  const result = await runStatus(svnPath, targetArg, {
    cwd: target.wcRoot,
    timeoutMs: readTimeoutMs(),
    ...decodingRunOptions('status'),
    onExit: logCommand(svnPath, ['status', '--xml', targetArg], target.wcRoot, 'status'),
  });
  writeStatusReport(result, 'status');
  showOutput(false, 'status');
}
