/**
 * 扩展入口。激活时探测 svn、注册命令，并把版本与工作区副本地址写入输出频道。
 */
import * as vscode from 'vscode';
import { run, runOrThrow, killAllActive } from './core/svnCli';
import { SvnError, tailText } from './core/errors';
import { escapePeg, findWorkingCopy } from './core/workspace';
import { readSvnPath, readTimeoutMs } from './host/config';
import { registerAllCommands } from './host/commands';
import { format, strings } from './host/i18n';
import { decodingRunOptions, disposeOutputChannel, getOutputChannel, logCommand, logLine, resetOutputState } from './host/output';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  resetOutputState();
  context.subscriptions.push({ dispose: disposeOutputChannel });
  getOutputChannel();
  registerAllCommands(context);
  probeSvn().catch((err: unknown) => {
    logLine(format(strings.activation.probeFailed, {
      message: err instanceof Error ? err.message : String(err),
    }));
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 启动探测：`svn --version` 写入输出频道并校验输出特征（防止配置成
 * 其它可执行文件时误判可用）；随后对工作区目录逐一探测副本地址。
 * 找不到 svn 或路径配置错误时提示并指向配置项。
 */
async function probeSvn(): Promise<void> {
  const svnPath = readSvnPath();
  try {
    const result = await run(svnPath, ['--version'], {
      timeoutMs: readTimeoutMs(),
      ...decodingRunOptions('other'),
      onExit: logCommand(svnPath, ['--version']),
    });
    if (result.exitCode !== 0 || !result.stdout.includes('svn, version')) {
      const detail = tailText((result.stderr.trim() || result.stdout.trim()).split('\n')[0] ?? '');
      logLine(format(strings.activation.invalidSvnDetail, { detail }));
      logLine(format(strings.activation.invalidSvnPath, { path: svnPath }));
      void vscode.window.showWarningMessage(format(strings.activation.invalidSvnPath, { path: svnPath }));
      return;
    }
    logLine(`${strings.activation.svnVersionPrefix}${result.stdout.split('\n')[0]?.trim() ?? ''}`);
  } catch (err) {
    logLine(errorMessage(err));
    // ENOENT 是「没装/路径错」；EACCES 等其它进程级错误原样呈现，不误导为未安装。
    const code = err instanceof SvnError ? err.code : undefined;
    void vscode.window.showWarningMessage(
      code === 'ENOENT'
        ? strings.activation.svnMissing
        : format(strings.activation.probeFailed, { message: errorMessage(err) }),
    );
    return;
  }

  await probeWorkspace(svnPath);
}

/** 对每个工作区目录向上找副本；命中的逐个执行 `svn info --show-item url`。 */
async function probeWorkspace(svnPath: string): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    logLine(strings.activation.noWorkspaceFolder);
    return;
  }

  logLine(strings.activation.workspaceProbeHeader);
  let foundCount = 0;
  for (const folder of folders) {
    const wcRoot = findWorkingCopy(folder.uri.fsPath);
    if (!wcRoot) {
      logLine(format(strings.activation.notWorkingCopy, { path: folder.uri.fsPath }));
      continue;
    }
    foundCount += 1;
    const args = ['info', '--show-item', 'url', escapePeg(wcRoot)];
    try {
      const result = await runOrThrow(svnPath, args, {
        cwd: wcRoot,
        timeoutMs: readTimeoutMs(),
        ...decodingRunOptions('other'),
        onExit: logCommand(svnPath, args, wcRoot),
      });
      logLine(format(strings.activation.infoUrl, { url: result.stdout.trim(), path: wcRoot }));
    } catch (err) {
      logLine(format(strings.activation.infoFailed, { message: errorMessage(err) }));
    }
  }
  if (foundCount === 0) {
    logLine(strings.activation.noWorkingCopyFound);
  }
}

export function deactivate(): void {
  killAllActive();
  disposeOutputChannel();
}
