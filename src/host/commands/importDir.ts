/**
 * 「导入本地目录」命令：解析导入源目录并以 mode='import' 打开 P3 面板。
 *
 * 源目录语义（方案 §10 命令入口矩阵）：右键目录 → 该目录即源目录（已纳管
 * 与否不在此拦——面板 sourceVersioned 分支会拦下并提示改用提交功能）；
 * 右键文件 → 文件不能作源，提示「导入源必须是目录」并弹目录选择框改选；
 * 命令面板无路径时优先活动编辑器（本地文件同样按文件形态处理），仍无则
 * 弹目录选择框；选择框取消静默返回。入口键与源目录统一 realpath 归一
 * （草稿/缓存键稳定，import 记录的 lockKey 同源目录 realpath）。
 */
import * as vscode from 'vscode';
import { realpathSync, statSync } from 'node:fs';
import { strings } from '../i18n';
import { openCheckoutPanel } from '../panel/panels/checkout';

export async function commandImportLocal(uri?: vscode.Uri): Promise<void> {
  let fsPath = uri?.fsPath;
  if (!fsPath) {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === 'file') {
      fsPath = editor.document.uri.fsPath;
    }
  }
  let sourceDir: string | undefined;
  if (fsPath) {
    const st = statSync(fsPath, { throwIfNoEntry: false });
    if (st?.isDirectory()) {
      sourceDir = fsPath;
    } else {
      // 文件（含 stat 失败的消失路径）不能作导入源：提示后弹目录选择框。
      void vscode.window.showInformationMessage(strings.importCommand.sourceMustBeDir);
      sourceDir = await pickSourceDir();
    }
  } else {
    sourceDir = await pickSourceDir();
  }
  if (!sourceDir) {
    return;
  }
  const normalized = realpathOrSelf(sourceDir);
  await openCheckoutPanel({ entryKey: normalized, mode: 'import', sourceDir: normalized });
}

/** 目录选择框（只可选目录，不要求未版本控制——已纳管由面板 sourceVersioned 分支拦下）。 */
async function pickSourceDir(): Promise<string | undefined> {
  const dirs = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: strings.importCommand.pickSourceDirTitle,
  });
  return dirs?.[0]?.fsPath;
}

/** realpath 归一（目录不存在等失败形态回退原值——入口通常来自选择器/资源管理器，存在）。 */
function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
