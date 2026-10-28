/**
 * 「忽略设置」命令。当前为占位实现；后续在此实现 svn:ignore 规则读写。
 */
import type * as vscode from 'vscode';
import { strings } from '../i18n';
import { runPlaceholder } from './placeholder';

export function commandEditIgnore(uri?: vscode.Uri): Promise<void> {
  return runPlaceholder(uri, strings.command.editIgnore);
}
