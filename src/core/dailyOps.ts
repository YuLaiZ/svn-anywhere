/**
 * 日常操作（添加/删除/还原/移动）的命令构造与范围枚举。core 模块，
 * 不依赖 vscode；右键命令层与提交面板行内操作共用本模块，不复制流程。
 *
 * 约定（workspace.ts escapePeg）：所有传给 svn 的文件系统路径参数都在
 * 这里统一转义（`--` 防选项注入 + peg `@` 保护），调用方不再自行拼接。
 */
import { run, runOrThrow, type RunOptions } from './svnCli';
import { escapePeg } from './workspace';
import type { StatusEntry } from './status';

/** `svn add` 参数：--parents 为未版本控制的中间目录补齐上级登记。 */
export function buildAddArgs(target: string, options: { parents?: boolean } = {}): string[] {
  return ['add', ...(options.parents ? ['--parents'] : []), '--', escapePeg(target)];
}

/**
 * `svn delete` 参数：默认同时删除本地文件并登记 SVN 删除（与 TortoiseSVN
 * 一致）；keepLocal 保留为扩展位（只登记删除、保留本地文件），当前无入口。
 */
export function buildDeleteArgs(
  target: string,
  options: { force?: boolean; keepLocal?: boolean } = {},
): string[] {
  return [
    'delete',
    ...(options.force ? ['--force'] : []),
    ...(options.keepLocal ? ['--keep-local'] : []),
    '--',
    escapePeg(target),
  ];
}

/** `svn revert` 参数：recursive 对整目录递归还原全部本地修改。 */
export function buildRevertArgs(target: string, options: { recursive?: boolean } = {}): string[] {
  return ['revert', ...(options.recursive ? ['-R'] : []), '--', escapePeg(target)];
}

/** `svn move` 参数：工作副本内移动/重命名，保留节点历史。 */
export function buildMoveArgs(src: string, dst: string): string[] {
  return ['move', '--', escapePeg(src), escapePeg(dst)];
}

/**
 * 删除目录的影响子树清单：`svn list -R` 列版本控制条目，只保留文件行
 * （目录行以 `/` 结尾，由父目录删除天然覆盖）。枚举失败时返回空清单，
 * 由调用方决定确认框是否继续。
 */
export async function listVersionedSubtree(
  svnPath: string,
  wcRoot: string,
  dirRelPath: string,
  options: RunOptions = {},
): Promise<string[]> {
  const args = ['list', '-R', '--', escapePeg(dirRelPath)];
  try {
    const result = await runOrThrow(svnPath, args, { ...options, cwd: wcRoot, timeoutMs: 10_000 });
    return result.stdout
      .split('\n')
      // 按行协议解析：只剥离行尾 CR（Windows 换行），保留名称首尾空格
      // 原值——svn list 对含首尾空格的文件名原样输出且不包裹引号，
      // trim 会让删除确认框展示与真实文件名不一致的路径。
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line.length > 0 && !line.endsWith('/'));
  } catch {
    return [];
  }
}

/**
 * externals 边界谓词：`svn status --xml` 会递归列出 external 内部条目
 * （如 vendor/lib 内的修改），但这些属于外部工作副本；整目录的递归操作
 * （revert -R 等）实测不跨 external。主副本目标的范围计算须按
 * `status.externals` 前缀隔离这些条目，与提交面板的边界过滤同一逻辑。
 */
export function isInsideExternalPrefixes(path: string, externalPrefixes: string[]): boolean {
  return externalPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** revert 可还原的 wc-status 集合（unversioned/ignored 无登记可还原）。 */
const REVERTABLE_ITEMS = new Set(['modified', 'added', 'deleted', 'missing', 'replaced', 'conflicted']);

/**
 * 从 status 条目中筛出 revert 将还原的清单：文本修改、属性修改（含
 * item=normal 的纯属性）、added 的登记撤销、missing 的文件恢复。
 */
export function revertableEntries(entries: StatusEntry[]): StatusEntry[] {
  return entries.filter((entry) => REVERTABLE_ITEMS.has(entry.wcStatus) || entry.props === 'modified');
}

/**
 * 目标是否已受版本控制：`svn info` 成功即受控。status 对 normal 目标与
 * 「父目录未版本控制的深层路径」都不输出条目，二者靠本判定区分。
 * 进程级失败（找不到 svn 等）同样按未纳管返回，由后续真实写命令暴露。
 */
export async function isVersioned(
  svnPath: string,
  wcRoot: string,
  relPath: string,
  options: RunOptions = {},
): Promise<boolean> {
  const args = ['info', '--show-item', 'schedule', '--', escapePeg(relPath)];
  try {
    const result = await run(svnPath, args, { ...options, cwd: wcRoot });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
