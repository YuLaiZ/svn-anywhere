/**
 * 「在 Finder 中显示」命令（F125）：直接转发 VSCode 内建 revealFileInOS，
 * 不新写实现；定位文件与 SVN 无关，不要求路径在工作副本内。
 * 右键未传 uri 时回退当前活动编辑器（须为本地文件）。
 */
import * as vscode from 'vscode';

export async function commandReveal(uri?: vscode.Uri): Promise<void> {
  const target =
    uri ??
    (vscode.window.activeTextEditor?.document.uri.scheme === 'file'
      ? vscode.window.activeTextEditor.document.uri
      : undefined);
  if (!target) {
    return;
  }
  await vscode.commands.executeCommand('revealFileInOS', target);
}
