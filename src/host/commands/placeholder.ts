/**
 * 占位命令模板：验证「右键 uri → 目标解析 → 副本定位」链路，命中的路径
 * 在输出频道留痕并弹信息提示；各命令的实际 svn 操作由后续实现在各自
 * 命令文件内替换本模板。
 */
import * as vscode from 'vscode';
import { format, strings } from '../i18n';
import { resolveWorkingCopyTarget, type WcTarget } from './target';

export async function runPlaceholder(uri: vscode.Uri | undefined, commandLabel: string): Promise<void> {
  const target = await resolveWorkingCopyTarget(uri, commandLabel);
  if (!target) {
    return;
  }
  noticePlaceholder(commandLabel, target);
}

export function noticePlaceholder(commandLabel: string, target: WcTarget): void {
  void vscode.window.showInformationMessage(
    format(strings.placeholder.notice, { command: commandLabel, wcRoot: target.wcRoot }),
  );
}
