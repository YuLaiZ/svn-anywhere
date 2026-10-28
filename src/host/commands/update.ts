/**
 * 「更新」命令。当前为占位实现，只走目标定位链路；后续在此实现
 * svn update 与结果解析。
 */
import type * as vscode from 'vscode';
import { strings } from '../i18n';
import { runPlaceholder } from './placeholder';

export function commandUpdate(uri?: vscode.Uri): Promise<void> {
  return runPlaceholder(uri, strings.command.update);
}
