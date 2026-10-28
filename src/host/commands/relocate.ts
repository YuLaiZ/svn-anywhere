/**
 * 「重定位」命令。当前为占位实现；后续在此实现旧地址读取与 svn relocate。
 */
import type * as vscode from 'vscode';
import { strings } from '../i18n';
import { runPlaceholder } from './placeholder';

export function commandRelocate(uri?: vscode.Uri): Promise<void> {
  return runPlaceholder(uri, strings.command.relocate);
}
