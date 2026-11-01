/**
 * 「提交」命令（F13/F22–F30、F145/F81）：入口只负责定位目标并打开
 * P1 提交面板；选择、说明、添加、范围确认与提交执行都在面板控制器
 * （src/host/panel/panels/commit.ts）内完成，命令入口与面板共用同一状态。
 * 资源管理器多选时把完整选区（第二参数 Uri[]）转交面板建立多目标会话。
 */
import type * as vscode from 'vscode';
import { commandShowCommitPanel } from '../panel/panels/commit';

export async function commandCommit(uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
  await commandShowCommitPanel(uri, uris);
}
