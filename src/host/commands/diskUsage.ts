/**
 * 「磁盘治理」命令：定位工作副本根并打开 P4 磁盘治理面板。
 *
 * 路径语义（方案 §10 命令入口矩阵）：右键副本内任意路径（文件/目录）
 * → findWorkingCopy 向上定位最近副本根（嵌套副本命中内层），右键路径
 * 所在目录作为本次打开子目录（面板页头「当前：」的基准）；右键副本外
 * 路径 → 提示「不在工作副本内」。命令面板无路径时优先活动编辑器
 * （须为本地文件）——活动编辑器文件不在任何工作副本内时直接提示、
 * 不回退选择框（磁盘治理需要副本内路径，与远端信息/检出的回退口径
 * 不同）；无活动编辑器（或非本地文件）弹目录选择框，选中后仍校验
 * 副本内；选择框取消静默返回。
 */
import * as vscode from 'vscode';
import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { findWorkingCopy } from '../../core/workspace';
import { strings } from '../i18n';
import { openDiskPanel } from '../panel/panels/disk';

export async function commandDiskUsage(uri?: vscode.Uri): Promise<void> {
  let fsPath = uri?.fsPath;
  if (!fsPath) {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === 'file') {
      fsPath = editor.document.uri.fsPath;
      // 活动编辑器文件不在任何工作副本内：直接提示，不回退选择框（§10）。
      const wcRoot = findWorkingCopy(fsPath);
      if (!wcRoot) {
        void vscode.window.showInformationMessage(strings.diskCommand.activeEditorNotWorkingCopy);
        return;
      }
      await openDiskPanel({ wcRoot, subPath: dirOf(fsPath) });
      return;
    }
    fsPath = (await pickDir())?.fsPath;
    if (!fsPath) {
      return;
    }
  }
  // 右键/选择框路径：向上定位副本根；定位不到提示「不在工作副本内」
  //（选择框形态同样不重弹选择框，取消语义由用户重新发起承载）。
  const wcRoot = findWorkingCopy(fsPath);
  if (!wcRoot) {
    void vscode.window.showInformationMessage(strings.diskCommand.notWorkingCopy);
    return;
  }
  await openDiskPanel({ wcRoot, subPath: dirOf(fsPath) });
}

/** 目录选择框（只可选目录；选中后仍校验副本内——不要求选择器预判）。 */
async function pickDir(): Promise<vscode.Uri | undefined> {
  const dirs = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: strings.diskCommand.pickDirTitle,
  });
  return dirs?.[0];
}

/** 路径的「本次打开子目录」：目录取自身，文件（含 stat 失败的消失路径）取所在目录。 */
function dirOf(fsPath: string): string {
  const st = statSync(fsPath, { throwIfNoEntry: false });
  return st?.isDirectory() ? fsPath : dirname(fsPath);
}
