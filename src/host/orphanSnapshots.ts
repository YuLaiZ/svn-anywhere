/**
 * 宿主重启后的孤儿快照清理（M3 技术方案 §2.2 快照段）。
 *
 * globalStorageUri 下与任何未终态操作记录都不对应的导入快照文件按
 * operationId 清除（此前终态删除失败/终态路径未走完的残留）。core 的
 * loadPending 只能 finish 掉记录、删不了 globalStorageUri 下的文件，
 * 清理由宿主侧在 activate 时（loadPending 折算完成后、命令注册前）执行：
 * 折算前清理会把待折算在途记录的证据误删；与 begin 的竞态由
 * registerAllCommands 的 await 时序消除——清理完成之前无任何命令可发起，
 * 「begin 前落盘的新快照（记录尚未写入）」不会被误判删除。
 */
import type * as vscode from 'vscode';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getOperationRegistry } from '../core/operations';

/**
 * 快照文件的文件名形态：randomOperationId 生成的 `op-` 前缀 + 时间戳段 +
 * 随机段（toString(36) 字符集）。文件名形态只是识别条件之一，还须内容
 * 匹配快照 schema 才视为快照文件。
 */
const OPERATION_ID_NAME_PATTERN = /^op-[0-9a-z]+-[0-9a-z]+$/;

/** 内容是否为快照 schema 形态的 JSON（{version, entries[], dirs[]}）。 */
function looksLikeSnapshot(content: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return false;
  }
  const candidate = parsed as Record<string, unknown>;
  return (
    typeof candidate.version === 'number' &&
    Array.isArray(candidate.entries) &&
    Array.isArray(candidate.dirs)
  );
}

/**
 * 清除 globalStorageUri 下的孤儿快照文件。识别双条件（op- 命名形态 ∧
 * 快照 schema 内容）同时满足才视为快照；删除集合 = 识别为快照 ∧ 文件名
 * 不在未终态记录的 operationId 集合中（对照数据源是 loadAllRecords 全量
 * 含终态——终态记录不保留快照，其同名残留即孤儿）。不匹配识别形态的
 * 文件一律不动（globalStorageUri 可能承载其他用途文件，防误删）。
 * 每次 activate 幂等执行；单文件读取/删除失败跳过（清理只是晚一次回收，
 * 不影响正确性）。
 */
export async function cleanupOrphanSnapshots(globalStorageUri: vscode.Uri | undefined): Promise<void> {
  if (!globalStorageUri) {
    return;
  }
  const dir = globalStorageUri.fsPath;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // 目录尚不存在：无快照可清理（首次 activate 的常态）。
    return;
  }
  const all = await getOperationRegistry().loadAllRecords();
  const live = new Set(
    all
      .filter((record) => record.phase !== 'done' && record.phase !== 'failed-unconfirmed')
      .map((record) => record.operationId),
  );
  for (const name of names) {
    if (!OPERATION_ID_NAME_PATTERN.test(name) || live.has(name)) {
      continue;
    }
    const filePath = join(dir, name);
    try {
      const content = await readFile(filePath, 'utf8');
      if (!looksLikeSnapshot(content)) {
        continue;
      }
      await rm(filePath, { force: true });
    } catch {
      // 读取/删除失败跳过该文件，继续处理其余候选。
    }
  }
}
