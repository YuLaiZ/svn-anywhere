/**
 * 「刷新状态」命令。当前为占位实现；后续在此实现重读 svn status 并写入输出频道。
 */
import type * as vscode from 'vscode';
import { strings } from '../i18n';
import { runPlaceholder } from './placeholder';

export function commandRefreshStatus(uri?: vscode.Uri): Promise<void> {
  return runPlaceholder(uri, strings.command.refreshStatus);
}
