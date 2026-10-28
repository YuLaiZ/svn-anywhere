/**
 * 配置读取。host 模块，集中处理 svnAnywhere.* 配置项。
 * 用户可能填入非法类型，读取处做防御，不让激活路径抛未处理异常。
 */
import * as vscode from 'vscode';
import { DEFAULT_TIMEOUT_MS } from '../core/svnCli';

export function getConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('svnAnywhere');
}

/** svn 可执行路径：配置为空或类型非法时回退到 PATH 里的 `svn`。 */
export function readSvnPath(): string {
  const raw: unknown = getConfiguration().get('svnPath', '');
  const configured = typeof raw === 'string' ? raw.trim() : '';
  return configured || 'svn';
}

/** 单条 svn 命令超时毫秒数；非正数或类型非法时用默认值。 */
export function readTimeoutMs(): number {
  const raw: unknown = getConfiguration().get('timeoutMs', DEFAULT_TIMEOUT_MS);
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  return DEFAULT_TIMEOUT_MS;
}

/** 命令失败时是否自动切到输出面板；类型非法时按开启处理。 */
export function readShowOutputOnError(): boolean {
  const raw: unknown = getConfiguration().get('showOutputOnError', true);
  return typeof raw === 'boolean' ? raw : true;
}

/** 提交前是否检查远端更新；类型非法时按开启处理（默认开启）。 */
export function readRemoteCheckBeforeCommit(): boolean {
  const raw: unknown = getConfiguration().get('remoteCheckBeforeCommit', true);
  return typeof raw === 'boolean' ? raw : true;
}

/** 是否允许空提交说明；类型非法时按开启处理（默认开启）。 */
export function readAllowEmptyCommitMessage(): boolean {
  const raw: unknown = getConfiguration().get('allowEmptyCommitMessage', true);
  return typeof raw === 'boolean' ? raw : true;
}
