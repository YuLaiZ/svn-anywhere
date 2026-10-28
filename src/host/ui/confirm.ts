/**
 * 模态确认对话框。host/ui 模块。
 * 破坏性或耗时操作执行前统一走这里；只有点击确认按钮才继续。
 */
import * as vscode from 'vscode';

/**
 * 弹模态确认框，返回用户是否点击了确认按钮。
 * 关闭对话框（Esc）与点击取消都视为未确认。
 */
export async function confirmModal(message: string, confirmLabel: string): Promise<boolean> {
  const picked = await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel);
  return picked === confirmLabel;
}
