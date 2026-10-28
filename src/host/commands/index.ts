/**
 * 命令注册总表。命令 ID 与 package.json 贡献点一一对应，
 * 顺序按子菜单分组（信息、提交、更新、高级）排列。
 */
import type * as vscode from 'vscode';
import { commandCleanup } from './cleanup';
import { commandCommit } from './commit';
import { commandEditIgnore } from './ignore';
import { type CommandHandler, registerCommand } from './registry';
import { commandRelocate } from './relocate';
import { commandRefreshStatus } from './refreshStatus';
import { commandShowOutput } from './showOutput';
import { commandShowStatus } from './showStatus';
import { commandUpdate } from './update';

const COMMANDS: ReadonlyArray<{ id: string; handler: CommandHandler }> = [
  { id: 'svnAnywhere.showStatus', handler: commandShowStatus },
  { id: 'svnAnywhere.commit', handler: commandCommit },
  { id: 'svnAnywhere.update', handler: commandUpdate },
  { id: 'svnAnywhere.refreshStatus', handler: commandRefreshStatus },
  { id: 'svnAnywhere.cleanup', handler: commandCleanup },
  { id: 'svnAnywhere.relocate', handler: commandRelocate },
  { id: 'svnAnywhere.editIgnore', handler: commandEditIgnore },
  { id: 'svnAnywhere.showOutput', handler: commandShowOutput },
];

/**
 * 同一宿主实例内二次 activate（调试、自动化场景）时，先释放上一次注册的
 * 命令句柄再重新注册——VSCode 对已注册 ID 的 registerCommand 会抛
 * already exists，重复注册会让 activate 失败。
 */
let registeredDisposables: vscode.Disposable[] = [];

export function registerAllCommands(context: vscode.ExtensionContext): void {
  for (const disposable of registeredDisposables) {
    disposable.dispose();
  }
  registeredDisposables = [];
  for (const { id, handler } of COMMANDS) {
    registeredDisposables.push(registerCommand(context, id, handler));
  }
}
