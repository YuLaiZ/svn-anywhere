/**
 * 「更新」命令（F16/F17/F19）：执行前模态确认目标路径，确认后用原生
 * InputBox 输入目标版本号（正整数或 HEAD，非法输入提示后重试），再以进度
 * 通知执行 svn update（可取消），流式回显明细，完成后汇总最终 revision
 * 与冲突。更新执行段（performUpdate）供提交前检查（F145）复用。
 */
import * as vscode from 'vscode';
import { join, relative } from 'node:path';
import { normalizeUpdateRevision, runUpdate, type UpdateRunResult } from '../../core/update';
import { getOperationRegistry } from '../../core/operations';
import { escapePeg } from '../../core/workspace';
import { readSvnPath, readTimeoutMs } from '../config';
import { format, strings } from '../i18n';
import { createLineBuffer, decodingRunOptions, logCommand, logLine, showOutput } from '../output';
import { resolveBatchTargetGroups, resolveWorkingCopyTarget, summarizePaths, type WcTarget } from './target';
import { confirmModal } from '../ui/confirm';
import { promptForCredentials } from '../auth';

export async function commandUpdate(uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
  const svnPath = readSvnPath();

  // 资源管理器多选批量：选区先去重嵌套路径（只保留最外层）再按工作副本分组，
  // 一次确认与一次版本号输入，逐组执行多目标更新（输出按目标逐项可见）。
  if (uris && uris.length > 0) {
    const groups = resolveBatchTargetGroups(uris, strings.command.update, 'update');
    if (groups.length === 0) {
      return;
    }
    const allTargets = groups.flatMap((group) => group.targetPaths);
    const confirmed = await confirmModal(
      format(strings.update.confirmTitle, { target: summarizePaths(allTargets) }),
      strings.update.confirmButton,
    );
    if (!confirmed) {
      return;
    }
    const revision = await promptUpdateRevision();
    if (revision === undefined) {
      return;
    }
    for (const group of groups) {
      await performUpdatePaths(
        group.wcRoot,
        group.targetPaths.map((path) => relative(group.wcRoot, path) || '.'),
        summarizePaths(group.targetPaths),
        svnPath,
        { revision, conflictPrompt: true },
      );
    }
    return;
  }

  const target = await resolveWorkingCopyTarget(uri, strings.command.update, 'update');
  if (!target) {
    return;
  }

  const confirmed = await confirmModal(
    format(strings.update.confirmTitle, { target: target.targetPath }),
    strings.update.confirmButton,
  );
  if (!confirmed) {
    return;
  }

  const revision = await promptUpdateRevision();
  if (revision === undefined) {
    return;
  }

  await performUpdate(target, svnPath, { revision, conflictPrompt: true });
}

/**
 * 原生 InputBox 输入更新目标版本号：输入框内实时校验（validateInput），
 * 归一化失败时提示后重试（覆盖 validateInput 不生效的宿主路径）；
 * 取消（Esc）返回 undefined，调用方应中止更新。
 */
export async function promptUpdateRevision(): Promise<string | undefined> {
  for (;;) {
    const input = await vscode.window.showInputBox({
      prompt: strings.update.revisionPrompt,
      value: 'HEAD',
      validateInput: (value) =>
        normalizeUpdateRevision(value) === undefined ? strings.update.revisionInvalid : undefined,
    });
    if (input === undefined) {
      return undefined;
    }
    const revision = normalizeUpdateRevision(input);
    if (revision !== undefined) {
      return revision;
    }
    void vscode.window.showWarningMessage(strings.update.revisionInvalid);
  }
}

/**
 * 更新前的注册表互斥：同一工作副本有在途/受限操作（提交中、结果未知、
 * 待协调）时拒绝执行；返回登记的操作 ID（执行完须 finish）或 undefined。
 */
export async function beginUpdateOperation(wcRoot: string): Promise<string | undefined> {
  const registry = getOperationRegistry();
  const held = registry.writeRestriction(wcRoot);
  if (held) {
    void vscode.window.showWarningMessage(format(strings.panel.operationHeldBusy, { phase: held.phase }));
    return undefined;
  }
  const begin = await registry.begin({ wcRoot, targetRelPath: '.', nodeKind: 'dir' });
  if (!begin.ok) {
    void vscode.window.showWarningMessage(format(strings.panel.operationHeldBusy, { phase: begin.heldBy.phase }));
    return undefined;
  }
  return begin.operationId;
}

/** 更新操作登记释放（幂等）。 */
export async function finishUpdateOperation(operationId: string | undefined): Promise<void> {
  await getOperationRegistry().finish(operationId);
}

export interface UpdateRunOptions {
  /** 已归一化的目标版本号（正整数字符串或 HEAD）；缺省为不传 -r。 */
  revision?: string;
  /**
   * 冲突提示形态：直接更新命令入口为 true，互斥锁释放后弹带「打开冲突
   * 文件」按钮的警告并等待用户处理（通知会停留，不能在持锁期间等待）；
   * 提交前检查链路为 false，保持无按钮的即时警告（面板自身会展示冲突
   * 分组，不阻塞返回）。
   */
  conflictPrompt?: boolean;
}

/**
 * 执行一次更新并完成回显：进度通知（可取消）、流式明细、最终 revision
 * 与冲突汇总都写输出频道；有冲突时弹警告列出文件。返回执行结果供
 * 提交流程判断是否继续。单目标形态，内部走多目标实现。
 */
export async function performUpdate(
  target: WcTarget,
  svnPath: string,
  options: UpdateRunOptions = {},
): Promise<UpdateRunResult> {
  const targetArg = relative(target.wcRoot, target.targetPath) || '.';
  return performUpdatePaths(target.wcRoot, [targetArg], target.targetPath, svnPath, options);
}

/**
 * 多目标更新执行（批量与单目标共用）：同一副本一次 svn update 携带全部
 * 目标，输出按目标逐项回显；注册表互斥按副本粒度登记，冲突提示在锁
 * 释放后弹出。targetArgs 须相对同一 wcRoot。
 */
export async function performUpdatePaths(
  wcRoot: string,
  targetArgs: string[],
  displayTarget: string,
  svnPath: string,
  options: UpdateRunOptions = {},
): Promise<UpdateRunResult> {
  // 注册表互斥：同一副本有在途/受限操作时拒绝更新（含从资源管理器入口）。
  const operationId = await beginUpdateOperation(wcRoot);
  if (!operationId) {
    return { stdout: '', stderr: '', exitCode: 0, items: [], conflicts: [] };
  }
  let result: UpdateRunResult;
  try {
    result = await executeUpdate(wcRoot, targetArgs, displayTarget, svnPath, options);
  } finally {
    await finishUpdateOperation(operationId);
  }
  // 带按钮的冲突提示在互斥锁释放后进行：通知会停留到用户处理，等待期间
  // 不能持有同副本写锁（否则还原/清理/提交等会被「未完成操作」拒绝）。
  if (options.conflictPrompt && result.conflicts.length > 0) {
    await promptConflictOpen(wcRoot, result.conflicts);
  }
  return result;
}

async function executeUpdate(
  wcRoot: string,
  targetArgs: string[],
  displayTarget: string,
  svnPath: string,
  options: UpdateRunOptions = {},
): Promise<UpdateRunResult> {
  // 与终端 svn update 一致：以副本根为 cwd 传相对目标，明细路径为相对形态；
  // 目标是副本根时归一为 `.`，避免空参数。
  // core 的 runUpdate 内部做 peg 转义，这里日志记录转义后的实际命令。
  const args = ['update', '--non-interactive'];
  if (options.revision) {
    args.push('-r', options.revision);
  }
  for (const targetArg of targetArgs) {
    args.push(escapePeg(targetArg));
  }

  // 进度通知的取消按钮桥接 AbortSignal，传给 core 的 svn 执行层。
  const abort = new AbortController();
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: options.revision
        ? format(strings.update.progressRevision, { target: displayTarget, revision: options.revision })
        : format(strings.update.progress, { target: displayTarget }),
      cancellable: true,
    },
    async (_progress, token) => {
      token.onCancellationRequested(() => abort.abort());
      const buffer = createLineBuffer(undefined, 'update');
      return runUpdate(svnPath, targetArgs, {
        cwd: wcRoot,
        signal: abort.signal,
        timeoutMs: readTimeoutMs(),
        ...decodingRunOptions('update'),
        onOutput: (chunk) => buffer.push(chunk),
        onExit: logCommand(svnPath, args, wcRoot, 'update'),
        // 认证失败时弹窗补录并重试一次（F67）；密码只在内存。
        getCredentials: promptForCredentials,
        // 重试命令回显到输出频道（logCommand 内置脱敏，密码不外泄）。
        onCredentialRetry: (retryArgs) => logCommand(svnPath, retryArgs, wcRoot, 'update'),
      }, options.revision);
    },
  );

  // 明细行已随流式输出进频道，这里补最终 revision 与冲突汇总。
  // 多目标更新按目标分段输出 revision：全部相同展示单值，不同则逐个列出。
  const uniqueRevisions = [
    ...new Set(result.finalRevisions ?? (result.finalRevision === undefined ? [] : [result.finalRevision])),
  ];
  logLine(
    uniqueRevisions.length === 0
      ? strings.update.doneNoRevision
      : uniqueRevisions.length === 1
        ? format(strings.update.done, { revision: String(uniqueRevisions[0]) })
        : format(strings.update.doneRevisions, {
            revisions: uniqueRevisions.map(String).join('、'),
          }),
    'update',
  );
  showOutput(false, 'update');

  if (result.conflicts.length > 0) {
    // conflictPrompt 形态的带按钮警告由 performUpdate 在释放互斥锁后弹出
    // （通知等待期间不能持锁）；提交前检查链路保持无按钮的即时警告。
    if (!options.conflictPrompt) {
      void vscode.window.showWarningMessage(
        format(strings.update.conflicts, {
          count: String(result.conflicts.length),
          paths: result.conflicts.join('、'),
        }),
      );
    }
    return result;
  }
  // 兜底：Summary 段报告了冲突但明细行未能定位到文件时，不静默放行。
  const summaryTotal = Object.values(result.conflictSummary ?? {}).reduce((sum, n) => sum + (n ?? 0), 0);
  if (summaryTotal > 0) {
    void vscode.window.showWarningMessage(format(strings.update.conflictsUnresolved, { count: String(summaryTotal) }));
  }
  return result;
}

/**
 * 冲突警告（带「打开冲突文件」按钮）与打开交互。必须在互斥锁释放后
 * 调用：带按钮的通知会停留到用户处理，等待期间不应阻塞同副本其他操作。
 */
async function promptConflictOpen(wcRoot: string, conflicts: string[]): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    format(strings.update.conflicts, {
      count: String(conflicts.length),
      paths: conflicts.join('、'),
    }),
    strings.update.openConflictButton,
  );
  if (choice === strings.update.openConflictButton) {
    await openConflictFiles(wcRoot, conflicts);
  }
}

/**
 * 定位并打开冲突路径：单个冲突直接打开；多个冲突先让用户选择。
 * 文件在编辑器打开，目录（树冲突常见形态）在系统文件管理器定位；
 * 本地已缺失时给出提示，不报错。
 */
async function openConflictFiles(wcRoot: string, conflicts: string[]): Promise<void> {
  let relPath: string | undefined;
  if (conflicts.length === 1) {
    relPath = conflicts[0];
  } else {
    const picked = await vscode.window.showQuickPick(
      conflicts.map((label) => ({ label })),
      { placeHolder: strings.update.conflictPickPlaceholder },
    );
    relPath = picked?.label;
  }
  if (!relPath) {
    return;
  }
  // 冲突路径是 update 明细的副本根相对路径，按原值拼接，不做修剪。
  const absPath = join(wcRoot, relPath);
  const uri = vscode.Uri.file(absPath);
  let stat: vscode.FileStat | undefined;
  let statFailure: { code?: string; message?: string } | undefined;
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch (err) {
    stat = undefined;
    statFailure = err as { code?: string; message?: string };
  }
  if (!stat) {
    // 按 FileSystemError.code 区分：仅 FileNotFound 判「本地文件不存在」；
    // 权限（NoPermissions）等其他失败照实提示，不得误述为文件缺失。
    if (statFailure && statFailure.code !== 'FileNotFound') {
      void vscode.window.showInformationMessage(
        format(strings.update.conflictInaccessibleLocal, {
          path: relPath,
          message: statFailure.message ?? String(statFailure),
        }),
      );
      return;
    }
    void vscode.window.showInformationMessage(
      format(strings.update.conflictMissingLocal, { path: relPath }),
    );
    return;
  }
  if (stat.type === vscode.FileType.Directory) {
    await vscode.commands.executeCommand('revealFileInOS', uri);
    return;
  }
  await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
}
