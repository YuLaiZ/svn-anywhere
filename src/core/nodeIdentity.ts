/**
 * 目标节点身份读取原语（`svn info` 文本输出一次读全）。core 模块，不依赖
 * vscode。
 *
 * 口径说明：本模块只做「目标节点身份」的完整文本解析（URL/UUID/根/修订/
 * 类型）；远端 HEAD 的 revision/last-changed 读取走 `--show-item` 数值
 * 输出、不经文本解析，且只服务隔离提交的结果未知核实，留在 ignoreCommit
 * （避免通用身份模块反向承接提交流程原语）。
 */
import { SvnError } from './errors';
import { runOrThrow, type RunOptions } from './svnCli';
import { escapePeg } from './workspace';

/** 目标节点身份：协调与提交前重读核对（URL/UUID/类型/BASE 修订）。 */
export interface NodeIdentity {
  url: string;
  repositoryUuid: string;
  repositoryRootUrl: string;
  revision: number;
  kind: string;
}

/** 从 `svn info` 文本输出解析目标节点身份（一次子进程读全部字段）。 */
export function parseNodeIdentity(infoStdout: string): NodeIdentity | undefined {
  let url: string | undefined;
  let repositoryUuid: string | undefined;
  let repositoryRootUrl: string | undefined;
  let revision: number | undefined;
  let kind: string | undefined;
  for (const line of infoStdout.split('\n')) {
    let match = /^URL:\s*(\S+)/.exec(line);
    if (match) {
      url = match[1];
    }
    match = /^Repository UUID:\s*(\S+)/.exec(line);
    if (match) {
      repositoryUuid = match[1];
    }
    match = /^Repository Root:\s*(\S+)/.exec(line);
    if (match) {
      repositoryRootUrl = match[1];
    }
    match = /^Revision:\s*(\d+)/.exec(line);
    if (match) {
      revision = Number(match[1]);
    }
    match = /^Node Kind:\s*(\S+)/.exec(line);
    if (match) {
      kind = match[1];
    }
  }
  if (url === undefined || repositoryUuid === undefined || repositoryRootUrl === undefined
    || revision === undefined || kind === undefined) {
    return undefined;
  }
  return { url, repositoryUuid, repositoryRootUrl, revision, kind };
}

/** 命令回显钩子（结构同 ignoreCommit 的 IgnoreCommandLog，不互相导入）。 */
type CommandLog = (
  args: string[],
  cwd: string | undefined,
) => ((exitCode: number) => void) | undefined;

/** onLog 返回的退出记录器优先于外层 onExit。 */
function loggedRunOptions(runOptions: RunOptions, exitLog?: (exitCode: number) => void): RunOptions {
  return exitLog ? { ...runOptions, onExit: exitLog } : runOptions;
}

/** 读取目标节点身份（`svn info`，路径含 @ 时转义）。 */
export async function readNodeIdentity(
  svnPath: string,
  target: string,
  options: RunOptions & { onLog?: CommandLog } = {},
): Promise<NodeIdentity> {
  const { onLog, ...runOptions } = options;
  const args = ['info', '--', escapePeg(target)];
  const result = await runOrThrow(svnPath, args, loggedRunOptions(runOptions, onLog?.(args, runOptions.cwd)));
  const identity = parseNodeIdentity(result.stdout);
  if (!identity) {
    throw new SvnError({
      message: 'svn info 输出无法解析目标节点身份',
      command: ['info', '--', escapePeg(target)],
      cwd: options.cwd,
      stderr: result.stdout,
      code: 'INFO_PARSE',
    });
  }
  return identity;
}

/** 读取目标节点当前 revision（`svn info`，混合修订按目标节点取值）。 */
export async function readNodeRevision(
  svnPath: string,
  target: string,
  options: RunOptions = {},
): Promise<number> {
  return (await readNodeIdentity(svnPath, target, options)).revision;
}
