/**
 * 工作副本定位与路径转义。core 模块，不依赖 vscode。
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 从给定路径向上逐级查找最近的 SVN 工作副本根（1.7+ 单 `.svn` 目录格式，
 * 以 `.svn/wc.db` 存在为准）。传入路径是文件时从其父目录开始找；
 * 是目录时从自身开始找（目录本身可能是副本根）。
 * 嵌套副本天然命中最近的一个。每次命令重新查找，不做缓存。
 */
export function findWorkingCopy(fsPath: string): string | undefined {
  let resolved: string;
  try {
    resolved = realpathSync(fsPath);
  } catch {
    return undefined;
  }

  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    return undefined;
  }

  let dir = stat.isDirectory() ? resolved : dirname(resolved);
  for (;;) {
    if (isWorkingCopyRoot(dir)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function isWorkingCopyRoot(dir: string): boolean {
  const svnDir = join(dir, '.svn');
  return existsSync(svnDir) && existsSync(join(svnDir, 'wc.db'));
}

/**
 * SVN 把路径里的 `@` 当 peg revision 分隔符；路径含 `@` 时在末尾补一个 `@`
 * 让 svn 把整段当作路径解析。
 *
 * 契约：所有传给 svn 的文件系统路径参数（target、副本根、文件路径）都必须
 * 经过本函数；阶段 3 起由命令封装层统一调用，调用方不再自行拼接裸路径。
 */
export function escapePeg(path: string): string {
  return path.includes('@') ? `${path}@` : path;
}
