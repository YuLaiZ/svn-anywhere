/**
 * 「显示状态」命令。当前为占位实现；后续在此实现 svn status 解析与展示。
 */
import type * as vscode from 'vscode';
import { strings } from '../i18n';
import { runPlaceholder } from './placeholder';

export function commandShowStatus(uri?: vscode.Uri): Promise<void> {
  return runPlaceholder(uri, strings.command.showStatus);
}
