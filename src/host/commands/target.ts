/**
 * 命令统一入口：目标路径解析与工作副本定位。host 模块。
 * 路径来源优先级：右键传入的 uri → 活动编辑器（仅 file scheme）→ 文件选择框。
 * 用户在任一步取消都静默返回 undefined；路径不在工作副本内时给出
 * 明确的信息提示（约定：可预期情况不弹错误对话框）。
 */
import * as vscode from 'vscode';
import { findWorkingCopy } from '../../core/workspace';
import { format, strings } from '../i18n';
import { logLine, type OutputKind } from '../output';

export interface WcTarget {
  /** 命中的工作副本根（realpath 后）。 */
  wcRoot: string;
  /** 右键/选择的原始目标路径；传给 svn 前须经 escapePeg 转义。 */
  targetPath: string;
}

/**
 * 解析命令目标并定位工作副本；任一步不成立（取消、非副本）时返回 undefined，
 * 命令实现应直接返回。commandLabel 只用于输出频道与提示中的命令名；
 * kind 是该命令的输出频道分类（定位留痕写入同一频道）。
 */
export async function resolveWorkingCopyTarget(
  uri: vscode.Uri | undefined,
  commandLabel: string,
  kind: OutputKind = 'other',
): Promise<WcTarget | undefined> {
  const fsPath = await pickTargetFsPath(uri);
  if (!fsPath) {
    return undefined;
  }
  const wcRoot = findWorkingCopy(fsPath);
  if (!wcRoot) {
    void vscode.window.showInformationMessage(strings.error.notWorkingCopy);
    return undefined;
  }
  logLine(format(strings.target.resolved, { command: commandLabel, target: fsPath, wcRoot }), kind);
  return { wcRoot, targetPath: fsPath };
}

async function pickTargetFsPath(uri?: vscode.Uri): Promise<string | undefined> {
  if (uri) {
    return uri.fsPath;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file') {
    return editor.document.uri.fsPath;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: strings.dialog.openTarget,
  });
  return picked?.[0]?.fsPath;
}
