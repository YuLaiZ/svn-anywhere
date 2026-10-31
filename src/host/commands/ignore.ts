/**
 * 「编辑忽略规则」命令：入口只负责定位目标并打开 P2 忽略规则编辑器
 * 面板；规则读取、增删、写回与仅规则提交都在面板控制器
 * （src/host/panel/panels/ignore.ts）内完成。
 * 目录入口编辑目录自身规则，文件入口编辑父目录规则（含「用当前项名」）。
 */
import type * as vscode from 'vscode';
import { commandShowIgnorePanel } from '../panel/panels/ignore';

export async function commandEditIgnore(uri?: vscode.Uri): Promise<void> {
  await commandShowIgnorePanel(uri);
}
