/**
 * 「提交」命令。当前为占位实现；后续在此实现提交前远端检查与提交流程。
 */
import type * as vscode from 'vscode';
import { strings } from '../i18n';
import { runPlaceholder } from './placeholder';

export function commandCommit(uri?: vscode.Uri): Promise<void> {
  return runPlaceholder(uri, strings.command.commit);
}
