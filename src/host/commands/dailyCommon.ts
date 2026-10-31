/**
 * 日常操作命令（添加/删除/还原/移动）的共享辅助。host 模块：
 * 工作副本目标的相对路径换算、节点类型判定与操作注册表互斥包裹。
 */
import * as vscode from 'vscode';
import { statSync } from 'node:fs';
import { relative } from 'node:path';
import { getOperationRegistry } from '../../core/operations';
import { format, strings } from '../i18n';
import type { WcTarget } from './target';

/** 目标相对副本根的路径；目标是副本根时归一为 `.`（与状态坐标系一致）。 */
export function targetRelOf(target: WcTarget): string {
  return relative(target.wcRoot, target.targetPath) || '.';
}

/** 节点类型：stat 失败（missing 等）时默认按文件处理，由状态条目纠正。 */
export function nodeKindOf(fsPath: string): 'file' | 'dir' {
  try {
    return statSync(fsPath).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'file';
  }
}

/**
 * 日常命令的节点类型判定：优先 stat 实际形态；目标缺失（missing）时
 * 用 status 条目兜底——自身 kind，或存在以其为前缀的子条目（目录子树）。
 * 干净目录（status 无条目）依赖 stat 命中，不会误判为文件。
 */
export function nodeKindFor(relPath: string, fsPath: string, entries: Array<{ path: string; kind?: string }>): 'file' | 'dir' {
  const byStat = nodeKindOf(fsPath);
  if (byStat === 'dir') {
    return 'dir';
  }
  const own = entries.find((entry) => entry.path === relPath);
  if (own?.kind === 'dir') {
    return 'dir';
  }
  const prefix = `${relPath}/`;
  return entries.some((entry) => entry.path.startsWith(prefix)) ? 'dir' : 'file';
}

/**
 * 日常写操作的注册表互斥：同一工作副本有在途/受限操作（提交中、结果
 * 未知、待协调）时拒绝；通过后登记，执行完须 finish。返回操作 ID。
 */
export async function beginDailyWrite(
  wcRoot: string,
  targetRelPath: string,
  nodeKind: 'file' | 'dir',
): Promise<string | undefined> {
  const registry = getOperationRegistry();
  const held = registry.writeRestriction(wcRoot);
  if (held) {
    void vscode.window.showWarningMessage(format(strings.panel.operationHeldBusy, { phase: held.phase }));
    return undefined;
  }
  const begin = await registry.begin({ wcRoot, targetRelPath, nodeKind });
  if (!begin.ok) {
    void vscode.window.showWarningMessage(format(strings.panel.operationHeldBusy, { phase: begin.heldBy.phase }));
    return undefined;
  }
  return begin.operationId;
}

/** 日常写操作登记释放（幂等）。 */
export async function finishDailyWrite(operationId: string | undefined): Promise<void> {
  await getOperationRegistry().finish(operationId);
}
