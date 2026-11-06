/**
 * 「检出」命令：解析检出父目录并打开 P3 检出面板。
 *
 * 父目录语义（方案 §10 命令入口矩阵）：右键目录 → 该目录即父目录；
 * 右键文件 → 取所在目录为父目录（等价于在该目录右键）。命令面板无
 * 路径时回退活动编辑器（须为本地文件，取其所在目录），仍无则弹目录
 * 选择框（只可选目录，不要求在工作副本内）；选择框取消静默返回。
 * 面板打开入口键与父目录统一 realpath 归一（草稿/缓存键稳定）。
 */
import * as vscode from 'vscode';
import { realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { strings } from '../i18n';
import { openCheckoutPanel } from '../panel/panels/checkout';

export async function commandCheckout(uri?: vscode.Uri): Promise<void> {
  const picked = await resolveParentDir(uri);
  if (!picked) {
    return;
  }
  const parentDir = realpathOrSelf(picked);
  await openCheckoutPanel({ entryKey: parentDir, mode: 'checkout', parentDir });
}

/**
 * 路径来源：右键 uri → 活动编辑器（仅 file scheme）→ 目录选择框。
 * 目录路径父目录即自身；文件路径取所在目录。stat 失败（路径已从磁盘
 * 消失，如活动编辑器指向已删除文件）按文件处理——其父目录通常仍在，
 * 面板照常可开。
 */
async function resolveParentDir(uri?: vscode.Uri): Promise<string | undefined> {
  let fsPath = uri?.fsPath;
  if (!fsPath) {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === 'file') {
      fsPath = editor.document.uri.fsPath;
    }
  }
  if (fsPath) {
    return parentDirOf(fsPath);
  }
  const dirs = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: strings.checkoutCommand.pickParentDirTitle,
  });
  return dirs?.[0]?.fsPath;
}

function parentDirOf(fsPath: string): string {
  const st = statSync(fsPath, { throwIfNoEntry: false });
  return st?.isDirectory() ? fsPath : dirname(fsPath);
}

/** realpath 归一（目录不存在等失败形态回退原值——入口通常来自选择器/资源管理器，存在）。 */
function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
