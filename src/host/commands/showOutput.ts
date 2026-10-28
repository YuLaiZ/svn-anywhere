/**
 * 「显示输出」命令：聚焦输出频道，不依赖工作副本，不需要目标解析。
 */
import { showOutput } from '../output';

export function commandShowOutput(): void {
  showOutput(false);
}
