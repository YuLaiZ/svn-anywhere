/**
 * 工作副本定位与路径转义。core 模块，不依赖 vscode。
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 从给定路径向上逐级查找最近的 SVN 工作副本根（1.7+ 单 `.svn` 目录格式，
 * 以 `.svn/wc.db` 存在为准）。传入路径是文件时从其父目录开始找；
 * 是目录时从自身开始找（目录本身可能是副本根）。
 * 路径本身已缺失（missing：本地删除未登记/文件系统移动）时退到最近的
 * 现存父目录继续定位，还原/登记删除/移动检测才能解析这类目标。
 * 嵌套副本天然命中最近的一个。每次命令重新查找，不做缓存。
 */
export function findWorkingCopy(fsPath: string): string | undefined {
  let resolved: string;
  try {
    resolved = realpathSync(fsPath);
  } catch {
    const parent = dirname(fsPath);
    if (parent === fsPath) {
      return undefined;
    }
    return findWorkingCopy(parent);
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
  // 相对路径以短横线开头时先明确为路径，避免被 SVN 解释为命令选项。
  const target = path.startsWith('-') ? `./${path}` : path;
  return target.includes('@') ? `${target}@` : target;
}

/**
 * 批量操作的嵌套路径去重：任一路径已经是集合中另一路径的祖先（按路径
 * 分段前缀判定，`/a/b` 包含 `/a/b/c` 但不包含 `/a/bb`）时丢弃内层，
 * 只保留最外层；重复路径只保留一份。返回顺序与输入一致。
 * 输入是本地文件系统绝对路径（VSCode 选区 Uri 的 fsPath），去除末尾
 * 分隔符仅用于包含判定，不影响返回的原值。
 */
export function dedupeNestedPaths(paths: string[]): string[] {
  // 去重 + 保持顺序的包含判定基元：末尾分隔符不影响祖先关系。
  const keys = [...new Set(paths)].map((path) => ({
    original: path,
    key: path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path,
  }));
  return keys
    .filter(({ key }) => !keys.some(({ key: other }) => other !== key && key.startsWith(`${other}/`)))
    .map(({ original }) => original);
}
