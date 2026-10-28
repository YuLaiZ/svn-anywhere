/**
 * svn relocate 的读取与执行（F118）。core 模块，不依赖 vscode。
 */
import { runOrThrow, type RunOptions } from './svnCli';
import { escapePeg } from './workspace';

/** 读取目标的仓库地址（`svn info --show-item url`）。 */
export async function readRepositoryUrl(
  svnPath: string,
  target: string,
  options: RunOptions = {},
): Promise<string> {
  const result = await runOrThrow(
    svnPath,
    ['info', '--show-item', 'url', escapePeg(target)],
    options,
  );
  return result.stdout.trim();
}

/**
 * 构建 relocate 参数。relocate 会访问远端校验仓库 UUID，固定
 * --non-interactive；作用于副本根。
 */
export function buildRelocateArgs(newUrl: string, wcRoot: string): string[] {
  return ['relocate', '--non-interactive', newUrl, escapePeg(wcRoot)];
}
