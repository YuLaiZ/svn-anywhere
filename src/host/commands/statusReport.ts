/**
 * 状态报告写入输出频道。host 模块。
 * 「显示状态」（F09）与「刷新状态」（F08）共用：明细一律用
 * svn wcStatus 原词展示（F15），与 `svn status --xml` 输出保持一致。
 */
import type { StatusResult } from '../../core/status';
import { format, strings } from '../i18n';
import { logLine } from '../output';

/** 把状态结果写入输出频道；干净副本写「无本地变更」。 */
export function writeStatusReport(result: StatusResult): void {
  logLine(format(strings.status.header, { path: result.targetPath }));
  if (result.entries.length === 0) {
    logLine(strings.status.clean);
    return;
  }
  for (const entry of result.entries) {
    logLine(format(strings.status.entry, { status: entry.wcStatus, path: entry.path }));
  }
}
