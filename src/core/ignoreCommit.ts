/**
 * P2 忽略规则编辑器的单属性读取与隔离提交原语。core 模块，不依赖 vscode。
 *
 * 隔离提交口径（技术方案 §5/§14.3，本地 SVN 1.15 实测）：
 * - `svn commit --depth empty <dir>` 不能保证只提交 svn:ignore（该节点的
 *   其他属性修改会一起提交），因此改用临时副本：基于目标节点 URL 与
 *   BASE revision 做 `svn checkout --depth empty`，在临时副本上仅应用
 *   svn:ignore 的新值/删除，再 `svn commit --depth empty`；
 * - 临时副本基于 BASE 检出，仓库中该节点的后续远端变化会让提交报
 *   out of date（E160028），天然阻止覆盖他人修改，须提示重读；
 * - 提交成功后对原副本做 `svn update --depth empty <dir>` 协调：本地
 *   同属性另有修改时 update 必然产生属性冲突（props=conflicted，
 *   退出码仍为 0），须保留冲突现场，经用户核对后 resolve --accept working；
 * - 属性不存在（本地与 -r BASE/HEAD 皆同）报 W200017，与「存在但值为空」
 *   （输出空串、退出码 0）分开。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommitOutput } from './commit';
import { SvnError, extractSvnErrorCodes, tailText } from './errors';
import { parseIgnoreRules } from './ignore';
import { runStatus } from './status';
import { run, runOrThrow, type RunOptions } from './svnCli';
import { escapePeg } from './workspace';

/** 属性快照：是否存在与值（规则按行原样保留，不 trim）。 */
export interface PropertySnapshot {
  rules: string[];
  exists: boolean;
}

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

/** 读取目标节点身份（`svn info`，路径含 @ 时转义）。 */
export async function readNodeIdentity(
  svnPath: string,
  target: string,
  options: RunOptions & { onLog?: IgnoreCommandLog } = {},
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

/**
 * 宿主注入的命令回显钩子：每条实际执行的 svn 命令前回调真实 args（含
 * 临时文件路径）。返回值（若提供）作为该命令的 onExit 记录器，宿主用它
 * 绑定退出码与耗时（操作日志逐命令配对，不依赖完成顺序）。
 */
export type IgnoreCommandLog = (
  args: string[],
  cwd: string | undefined,
) => ((exitCode: number) => void) | undefined;

/** onLog 返回的退出记录器优先于外层 onExit。 */
function loggedRunOptions(runOptions: RunOptions, exitLog?: (exitCode: number) => void): RunOptions {
  return exitLog ? { ...runOptions, onExit: exitLog } : runOptions;
}

/**
 * 读取目标的 svn:ignore 快照。revision 省略读工作值，'BASE'/'HEAD' 或
 * 数字读对应修订；URL 目标读远端。属性不存在（W200017）返回
 * `{ rules: [], exists: false }`；存在但值为空返回 `{ rules: [], exists: true }`。
 * 其余失败（非副本、网络等）原样抛出，调用方不得把读取失败当空属性。
 */
export async function readIgnoreSnapshot(
  svnPath: string,
  target: string,
  options: RunOptions & { revision?: string; onLog?: IgnoreCommandLog } = {},
): Promise<PropertySnapshot> {
  const { onLog, ...runOptions } = options;
  const args = ['propget', 'svn:ignore'];
  if (options.revision !== undefined) {
    args.push('-r', options.revision);
  }
  args.push('--', escapePeg(target));
  const result = await run(svnPath, args, loggedRunOptions(runOptions, onLog?.(args, runOptions.cwd)));
  if (result.exitCode !== 0) {
    if (result.stderr.includes('W200017')) {
      return { rules: [], exists: false };
    }
    throw new SvnError({
      message: tailText(result.stderr.trim() || `svn propget 退出码 ${result.exitCode}`),
      command: args,
      cwd: options.cwd,
      exitCode: result.exitCode,
      stderr: tailText(result.stderr),
      code: extractSvnErrorCodes(result.stderr)[0],
    });
  }
  return { rules: parseIgnoreRules(result.stdout), exists: true };
}

/** 把规则写入临时文件（写回与临时副本应用共用；行原样、末尾补换行）。 */
export function writeRulesTempFile(rules: string[]): { tempDir: string; rulesFile: string } {
  const tempDir = mkdtempSync(join(tmpdir(), 'svn-anywhere-ignore-'));
  const rulesFile = join(tempDir, 'ignore.txt');
  writeFileSync(rulesFile, `${rules.join('\n')}\n`, 'utf8');
  return { tempDir, rulesFile };
}

/** 删除一次规则写回产生的临时目录；失败静默（随系统清理）。 */
export function removeRulesTempDir(tempDir: string): void {
  rmSync(tempDir, { recursive: true, force: true });
}

/**
 * 把 svn:ignore 快照应用到目标：仍有规则 propset 从临时文件读入，
 * 规则清空改 propdel（空列表表示删除属性）。
 */
export async function applyIgnoreSnapshot(
  svnPath: string,
  target: string,
  snapshot: PropertySnapshot,
  options: RunOptions & { rulesFile?: string; onLog?: IgnoreCommandLog } = {},
): Promise<void> {
  const { onLog, ...runOptions } = options;
  if (!snapshot.exists || snapshot.rules.length === 0) {
    const delArgs = ['propdel', 'svn:ignore', '--', escapePeg(target)];
    await runOrThrow(svnPath, delArgs, loggedRunOptions(runOptions, onLog?.(delArgs, runOptions.cwd)));
    return;
  }
  const temp = options.rulesFile === undefined ? writeRulesTempFile(snapshot.rules) : undefined;
  const rulesFile = options.rulesFile ?? temp?.rulesFile ?? '';
  const setArgs = ['propset', 'svn:ignore', '-F', rulesFile, '--', escapePeg(target)];
  try {
    await runOrThrow(svnPath, setArgs, loggedRunOptions(runOptions, onLog?.(setArgs, runOptions.cwd)));
  } finally {
    if (temp) {
      removeRulesTempDir(temp.tempDir);
    }
  }
}

/** 基于目标节点 URL 与 BASE revision 创建限深临时工作副本（只检出节点自身）。 */
export async function checkoutDepthEmpty(
  svnPath: string,
  url: string,
  revision: number,
  destDir: string,
  options: RunOptions & { onLog?: IgnoreCommandLog } = {},
): Promise<void> {
  const { onLog, ...runOptions } = options;
  const args = ['checkout', '--depth', 'empty', '-r', String(revision), escapePeg(url), destDir];
  await runOrThrow(svnPath, args, loggedRunOptions(runOptions, onLog?.(args, runOptions.cwd)));
}

/**
 * 提交临时副本根节点的 svn:ignore（`--depth empty` 固定单节点范围；
 * 说明经临时文件 UTF-8 传入）。返回新 revision；svn 确认失败原样抛出。
 */
export async function commitTempIgnore(
  svnPath: string,
  tempWc: string,
  messageFile: string,
  options: RunOptions & { onLog?: IgnoreCommandLog } = {},
): Promise<number> {
  const { onLog, ...runOptions } = options;
  const args = ['commit', '--non-interactive', '--depth', 'empty', '--file', messageFile, '--encoding', 'UTF-8', '.'];
  const result = await runOrThrow(svnPath, args, { cwd: tempWc, ...loggedRunOptions(runOptions, onLog?.(args, tempWc)) });
  const revision = parseCommitOutput(result.stdout).revision;
  if (revision === undefined) {
    throw new SvnError({
      message: result.stdout.trim() || 'svn commit 输出未包含新 revision',
      command: ['commit', '--depth', 'empty', '.'],
      cwd: tempWc,
      stderr: result.stderr,
      code: 'COMMIT_PARSE',
    });
  }
  return revision;
}

/** 读取目标节点当前 revision（`svn info`，混合修订按目标节点取值）。 */
export async function readNodeRevision(
  svnPath: string,
  target: string,
  options: RunOptions = {},
): Promise<number> {
  return (await readNodeIdentity(svnPath, target, options)).revision;
}

/**
 * 对原副本目标节点做限深协调更新（`svn update --depth empty`）。
 * 返回输出文本；属性冲突时 svn 退出码仍为 0，冲突状态由
 * {@link propertyConflicted} 用 status 检查，不能只看退出码。
 */
export async function coordinateUpdate(
  svnPath: string,
  target: string,
  options: RunOptions & { onLog?: IgnoreCommandLog } = {},
): Promise<string> {
  const { onLog, ...runOptions } = options;
  const args = ['update', '--depth', 'empty', '--non-interactive', '--', escapePeg(target)];
  const result = await runOrThrow(svnPath, args, loggedRunOptions(runOptions, onLog?.(args, runOptions.cwd)));
  return result.stdout;
}

/** 目标节点的属性是否处于冲突状态（协调 update 后保留现场判定）。 */
export async function propertyConflicted(
  svnPath: string,
  target: string,
  options: RunOptions = {},
): Promise<boolean> {
  const status = await runStatus(svnPath, target, options);
  const entry = status.entries.find((item) => item.path === target || item.path === '.');
  return entry?.props === 'conflicted';
}

/**
 * 以「保留工作值」解决目标节点的属性冲突（用户已核对合并结果后调用；
 * BASE 保持已提交值，工作值原样保留为后续未提交修改）。
 */
export async function resolvePropertyConflict(
  svnPath: string,
  target: string,
  options: RunOptions & { onLog?: IgnoreCommandLog } = {},
): Promise<void> {
  const { onLog, ...runOptions } = options;
  const args = ['resolve', '--accept', 'working', '--depth', 'empty', '--', escapePeg(target)];
  onLog?.(args, runOptions.cwd);
  await runOrThrow(svnPath, args, runOptions);
}

/** 快照相等：属性存在性与规则值都一致（规则按原值比较，不 trim）。 */
export function snapshotEqual(a: PropertySnapshot, b: PropertySnapshot): boolean {
  return a.exists === b.exists && a.rules.length === b.rules.length
    && a.rules.every((rule, index) => rule === b.rules[index]);
}

/** 读远端 HEAD 的 svn:ignore（结果未知核实用；URL 目标直读仓库）。 */
export async function readRemoteIgnoreSnapshot(
  svnPath: string,
  url: string,
  options: RunOptions & { onLog?: IgnoreCommandLog } = {},
): Promise<PropertySnapshot> {
  return readIgnoreSnapshot(svnPath, url, { ...options, revision: 'HEAD' });
}

/** 读远端 HEAD 上目标节点的 revision 与最后变更修订（核实关联用）。 */
export async function readRemoteNodeRevisions(
  svnPath: string,
  url: string,
  options: RunOptions = {},
): Promise<{ headRevision: number; lastChangedRevision: number }> {
  const result = await runOrThrow(
    svnPath,
    ['info', '-r', 'HEAD', '--show-item', 'revision', '--', escapePeg(url)],
    options,
  );
  const headRevision = Number(result.stdout.trim());
  const changed = await runOrThrow(
    svnPath,
    ['info', '-r', 'HEAD', '--show-item', 'last-changed-revision', '--', escapePeg(url)],
    options,
  );
  const lastChangedRevision = Number(changed.stdout.trim());
  if (!Number.isFinite(headRevision) || !Number.isFinite(lastChangedRevision)) {
    throw new SvnError({
      message: 'svn info -r HEAD 输出无法解析 revision',
      command: ['info', '-r', 'HEAD', url],
      cwd: options.cwd,
      stderr: result.stdout,
      code: 'INFO_PARSE',
    });
  }
  return { headRevision, lastChangedRevision };
}
