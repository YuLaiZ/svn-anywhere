/**
 * 「移动」命令（F117）：输入目标路径后执行 svn move，保留节点历史；
 * 检测到源已被文件系统移动/删除（status 为 missing）时提示先移回原
 * 位置再执行，让 svn move 记录为带历史的重命名。
 */
import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { buildMoveArgs } from '../../core/dailyOps';
import { runStatus } from '../../core/status';
import { runOrThrow } from '../../core/svnCli';
import { readSvnPath, readTimeoutMs } from '../config';
import { format, strings } from '../i18n';
import { createLineBuffer, logCommand, logExitCode, showOutput } from '../output';
import { resolveWorkingCopyTarget } from './target';
import { beginDailyWrite, finishDailyWrite, nodeKindOf, targetRelOf } from './dailyCommon';

export async function commandMove(uri?: vscode.Uri): Promise<void> {
  const target = await resolveWorkingCopyTarget(uri, strings.command.move);
  if (!target) {
    return;
  }

  const svnPath = readSvnPath();
  const relPath = targetRelOf(target);
  const runOptions = { cwd: target.wcRoot, timeoutMs: readTimeoutMs(), onExit: logExitCode };
  const status = await runStatus(svnPath, relPath, runOptions);
  const own = status.entries.find((entry) => entry.path === relPath);
  if (own && own.wcStatus === 'unversioned') {
    void vscode.window.showInformationMessage(format(strings.move.unversionedTarget, { path: relPath }));
    return;
  }
  if (own && own.wcStatus === 'missing') {
    // 文件系统移动检测：源不在本地时 svn move 无法执行。若用户刚用
    // Finder 等移动过，先移回原位置再用本命令，才能保留历史。
    void vscode.window.showWarningMessage(format(strings.move.fsMovedHint, { path: relPath }));
    return;
  }

  const input = await vscode.window.showInputBox({
    prompt: format(strings.move.inputPrompt, { path: relPath }),
    value: target.targetPath,
    ignoreFocusOut: true,
  });
  if (input === undefined || input.trim() === '') {
    return;
  }
  // 相对输入相对源所在目录解析；peg/选项保护在 buildMoveArgs 统一处理。
  const dstAbs = isAbsolute(input) ? input : resolve(dirname(target.targetPath), input);
  if (dstAbs === target.targetPath) {
    void vscode.window.showInformationMessage(strings.move.sameTarget);
    return;
  }
  if (existsSync(dstAbs)) {
    void vscode.window.showInformationMessage(format(strings.move.targetExists, { target: dstAbs }));
    return;
  }
  const dstRel = relative(target.wcRoot, dstAbs);
  if (!dstRel || dstRel.startsWith('..')) {
    void vscode.window.showInformationMessage(strings.move.outsideWorkingCopy);
    return;
  }

  const operationId = await beginDailyWrite(
    target.wcRoot,
    relPath,
    nodeKindOf(target.targetPath),
  );
  if (!operationId) {
    return;
  }
  const args = buildMoveArgs(relPath, dstRel);
  try {
    logCommand(svnPath, args, target.wcRoot);
    const buffer = createLineBuffer();
    await runOrThrow(svnPath, args, {
      ...runOptions,
      onOutput: (chunk) => buffer.push(chunk),
    });
  } finally {
    await finishDailyWrite(operationId);
  }
  void vscode.window.showInformationMessage(
    format(strings.move.done, { src: relPath, dst: dstRel }),
  );
  showOutput(false);
}
