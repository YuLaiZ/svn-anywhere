/**
 * 状态报告写入输出频道。host 模块。
 * 「显示状态」（F09）与「刷新状态」（F08）共用：明细一律用
 * svn wcStatus 原词展示（F15），与 `svn status --xml` 输出保持一致。
 */
import type { StatusResult, StatusEntry } from '../../core/status';
import { isPropertyModified } from '../../core/status';
import { format, strings } from '../i18n';
import { logLine, type OutputKind } from '../output';

/** 把状态结果写入输出频道；干净副本写「无本地变更」。 */
export function writeStatusReport(result: StatusResult, kind: OutputKind = 'status'): void {
  logLine(format(strings.status.header, { path: result.targetPath }), kind);
  if (result.entries.length === 0) {
    logLine(strings.status.clean, kind);
    return;
  }
  for (const entry of result.entries) {
    logLine(statusEntryLine(entry), kind);
  }
}

/** 属性修改的条目（item 可能为 normal）在行尾追加注记，避免被误读为无变更。 */
function statusEntryLine(entry: StatusEntry): string {
  const template = isPropertyModified(entry) ? strings.status.entryWithProps : strings.status.entry;
  return format(template, { status: entry.wcStatus, path: entry.path });
}
