/**
 * 编辑器集成命令入口（M4 阶段 4 任务 2/3）：`svnAnywhere.toggleQuickDiff`
 * 与 `svnAnywhere.toggleInlineBlame`。
 *
 * 命令只作用于当前活动文本文件：开关状态机与装饰由 host/quickDiff 与
 * host/inlineBlame 承担（先判 versioned/exists/nonDir/nonBinary，再执行
 * 内部 diff / 默认 blame），本模块负责活动编辑器取值与用户可见提示的
 * 统一映射。用户可见文案全部来自 host/i18n。
 */
import * as vscode from 'vscode';
import {
  toggleQuickDiff,
  type LocalEditorRejectReason,
  type QuickDiffOutcome,
} from '../quickDiff';
import {
  toggleInlineBlame,
  type InlineBlameOutcome,
  type InlineBlameRejectReason,
} from '../inlineBlame';
import { format, strings } from '../i18n';
import { registerCommand, showCommandError } from './registry';

export type EditorFeature = 'quickDiff' | 'inlineBlame';

function featureLabel(feature: EditorFeature): string {
  return feature === 'quickDiff' ? strings.editor.featureQuickDiff : strings.editor.featureInlineBlame;
}

/** 拒绝原因 → 用户提示（二进制/超大为警告，其余为信息提示）。 */
export function editorRejectNotice(
  reason: LocalEditorRejectReason | InlineBlameRejectReason | 'tooLarge',
  feature: EditorFeature,
): { level: 'info' | 'warning'; message: string } {
  const label = featureLabel(feature);
  switch (reason) {
    case 'noActiveEditor':
      return { level: 'info', message: strings.editor.noActiveEditor };
    case 'notFile':
      return { level: 'info', message: format(strings.editor.rejectedNotFile, { feature: label }) };
    case 'notWorkingCopy':
      return { level: 'info', message: format(strings.editor.rejectedNotWorkingCopy, { feature: label }) };
    case 'unversioned':
      return { level: 'info', message: format(strings.editor.rejectedUnversioned, { feature: label }) };
    case 'missing':
    case 'deleted':
      return { level: 'info', message: format(strings.editor.rejectedMissing, { feature: label }) };
    case 'directory':
      return { level: 'info', message: format(strings.editor.rejectedDirectory, { feature: label }) };
    case 'binary':
      return { level: 'warning', message: format(strings.editor.rejectedBinary, { feature: label }) };
    case 'tooLarge':
      return { level: 'warning', message: strings.editor.inlineBlameTooLarge };
  }
}

function showEditorRejectNotice(
  reason: LocalEditorRejectReason | InlineBlameRejectReason | 'tooLarge',
  feature: EditorFeature,
): void {
  const notice = editorRejectNotice(reason, feature);
  if (notice.level === 'warning') {
    void vscode.window.showWarningMessage(notice.message);
  } else {
    void vscode.window.showInformationMessage(notice.message);
  }
}

/** 命令可注入的开关函数（测试替身；默认使用真实实现）。 */
export interface EditorCommandDeps {
  toggleQuickDiff?: typeof toggleQuickDiff;
  toggleInlineBlame?: typeof toggleInlineBlame;
}

function handleQuickDiffOutcome(outcome: QuickDiffOutcome): void {
  if (outcome.status === 'rejected') {
    showEditorRejectNotice(outcome.reason, 'quickDiff');
    return;
  }
  if (outcome.status === 'failed') {
    showCommandError(outcome.error, 'other');
  }
}

function handleInlineBlameOutcome(outcome: InlineBlameOutcome): void {
  if (outcome.status === 'rejected') {
    showEditorRejectNotice(outcome.reason, 'inlineBlame');
    return;
  }
  if (outcome.status === 'failed') {
    showCommandError(outcome.error, 'other');
  }
}

/** `svnAnywhere.toggleQuickDiff`：开关当前活动文本文件的快速差异。 */
export async function commandToggleQuickDiff(deps: EditorCommandDeps = {}): Promise<void> {
  const toggle = deps.toggleQuickDiff ?? toggleQuickDiff;
  handleQuickDiffOutcome(await toggle(vscode.window.activeTextEditor));
}

/** `svnAnywhere.toggleInlineBlame`：开关当前活动文本文件的行内追溯。 */
export async function commandToggleInlineBlame(deps: EditorCommandDeps = {}): Promise<void> {
  const toggle = deps.toggleInlineBlame ?? toggleInlineBlame;
  handleInlineBlameOutcome(await toggle(vscode.window.activeTextEditor));
}

// ---------------------------------------------------------------------------
// 命令注册（extension.activate 的 M4 入口接线）
// ---------------------------------------------------------------------------

/** 本命令的注册句柄：二次 activate 先释放上一次再重新注册。 */
let registeredDisposables: vscode.Disposable[] = [];

/**
 * 注册编辑器集成命令（命令数 19→21）：由 extension.activate 在
 * registerAllCommands 之后调用（与 browseRepository/showHistory 同模式）。
 * 同一宿主实例二次激活时先释放上次句柄——VSCode 对已注册 ID 的
 * registerCommand 会抛 already exists。
 */
export function registerEditorCommands(context: vscode.ExtensionContext): void {
  for (const disposable of registeredDisposables) {
    disposable.dispose();
  }
  registeredDisposables = [
    registerCommand(context, 'svnAnywhere.toggleQuickDiff', () => commandToggleQuickDiff(), 'other'),
    registerCommand(context, 'svnAnywhere.toggleInlineBlame', () => commandToggleInlineBlame(), 'other'),
  ];
}

/** 测试辅助：释放本命令的注册句柄。 */
export function disposeEditorCommandsForTest(): void {
  for (const disposable of registeredDisposables) {
    disposable.dispose();
  }
  registeredDisposables = [];
}
