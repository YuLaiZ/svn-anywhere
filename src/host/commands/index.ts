/**
 * 命令注册总表。命令 ID 与 package.json 贡献点一一对应，
 * 顺序按子菜单分组（信息、提交、日常操作、更新、高级）排列。
 */
import type * as vscode from 'vscode';
import { commandAdd } from './add';
import { commandCleanup } from './cleanup';
import { commandCommit } from './commit';
import { commandDelete } from './delete';
import { commandEditIgnore } from './ignore';
import { commandMove } from './move';
import { type CommandHandler, registerCommand } from './registry';
import { commandRelocate } from './relocate';
import { commandShowRemoteInfo } from './remoteInfo';
import { commandRefreshStatus } from './refreshStatus';
import { commandReveal } from './reveal';
import { commandRevert } from './revert';
import { commandShowOutput } from './showOutput';
import { commandShowStatus } from './showStatus';
import { commandUpdate } from './update';
import { setCommitPanelContext } from '../panel/panels/commit';
import { setIgnorePanelContext } from '../panel/panels/ignore';
import { initializeOperationStore } from '../../core/operations';
import { cleanupOrphanSnapshots } from '../orphanSnapshots';
import { logLine } from '../output';
import type { OutputKind } from '../output';

/** 命令的输出频道分类：状态 / 更新 / 提交（含 P1/P2 面板入口）/ 其它。 */
const COMMANDS: ReadonlyArray<{ id: string; handler: CommandHandler; kind: OutputKind }> = [
  { id: 'svnAnywhere.showStatus', handler: commandShowStatus, kind: 'status' },
  { id: 'svnAnywhere.showRemoteInfo', handler: commandShowRemoteInfo, kind: 'other' },
  { id: 'svnAnywhere.commit', handler: commandCommit, kind: 'commit' },
  { id: 'svnAnywhere.update', handler: commandUpdate, kind: 'update' },
  { id: 'svnAnywhere.refreshStatus', handler: commandRefreshStatus, kind: 'status' },
  { id: 'svnAnywhere.cleanup', handler: commandCleanup, kind: 'other' },
  { id: 'svnAnywhere.relocate', handler: commandRelocate, kind: 'other' },
  { id: 'svnAnywhere.editIgnore', handler: commandEditIgnore, kind: 'commit' },
  { id: 'svnAnywhere.showOutput', handler: commandShowOutput, kind: 'other' },
  { id: 'svnAnywhere.add', handler: commandAdd, kind: 'other' },
  { id: 'svnAnywhere.delete', handler: commandDelete, kind: 'other' },
  { id: 'svnAnywhere.revert', handler: commandRevert, kind: 'other' },
  { id: 'svnAnywhere.move', handler: commandMove, kind: 'other' },
  { id: 'svnAnywhere.revealInFinder', handler: commandReveal, kind: 'other' },
];

/**
 * 同一宿主实例内二次 activate（调试、自动化场景）时，先释放上一次注册的
 * 命令句柄再重新注册——VSCode 对已注册 ID 的 registerCommand 会抛
 * already exists，重复注册会让 activate 失败。
 */
let registeredDisposables: vscode.Disposable[] = [];

/**
 * 注册全部命令。async 化（M3 §2.2 首载时序）：先 await 操作记录首载
 * （loadPending 的陈旧化折算/终态残留清理/M1 记录移除都写盘，未完成前
 * 命令拿到的限制集合是陈旧的），随后 await 孤儿快照清理（异常降级为日志
 * 一行、不阻塞注册），两者完成后才进入命令注册循环——清理完成之前无任何
 * 命令可发起，「begin 前落盘的新快照被误判删除」的竞态由该时序消除。
 */
export async function registerAllCommands(context: vscode.ExtensionContext): Promise<void> {
  for (const disposable of registeredDisposables) {
    disposable.dispose();
  }
  registeredDisposables = [];
  // 面板创建需要 extensionUri / subscriptions / globalState；activate 注入一次。
  setCommitPanelContext(context);
  setIgnorePanelContext(context);
  // 未完成操作记录跨会话恢复限制（写锁在面板打开时生效）。
  // 每次 activate 都重载：记录可能被另一窗口写入同一 globalState，
  // 重跑 loadPending 是幂等的（active 收窄幂等、对运行登记中的键跳过陈旧化）。
  await initializeOperationStore(context.globalState);
  try {
    await cleanupOrphanSnapshots(context.globalStorageUri);
  } catch (err) {
    // 清理失败只是晚一次回收，不影响正确性；降级为日志一行。
    logLine(`[svn-anywhere] 孤儿快照清理失败：${err instanceof Error ? err.message : String(err)}`, 'other');
  }
  for (const { id, handler, kind } of COMMANDS) {
    registeredDisposables.push(registerCommand(context, id, handler, kind));
  }
}
