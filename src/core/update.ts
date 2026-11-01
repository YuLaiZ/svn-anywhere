/**
 * svn update 的执行与文本输出解析。core 模块，不依赖 vscode。
 *
 * 关键约定：update 存在冲突时退出码仍为 0，冲突必须靠解析输出判断，
 * 不能依赖 exitCode。args 固定带 --non-interactive：spawn 无 tty，
 * 防止 svn 等待 stdin 挂起（不影响缓存凭据的静默使用）。
 */
import { runOrThrow, type RunOptions, type RunResult } from './svnCli';
import { escapePeg } from './workspace';

export interface UpdateItem {
  /** 明细状态字母（A/D/U/C/G/E/R/~ 或树冲突 C），svn 原词。 */
  status: string;
  path: string;
}

export interface ConflictSummaryCounts {
  text?: number;
  property?: number;
  tree?: number;
}

export interface UpdateResult {
  items: UpdateItem[];
  /**
   * 最终 revision（`Updated to revision N` / `At revision N`）；多目标输出
   * 多段时保留最后一段的值（兼容单目标消费方，单目标两者一致）。
   */
  finalRevision?: number;
  /** 按输出顺序收集的全部最终 revision（多目标一段一个）；无 revision 行时为 undefined。 */
  finalRevisions?: number[];
  /** 产生冲突的路径（明细状态 C 或树冲突行）。 */
  conflicts: string[];
  /**
   * `Summary of conflicts` 段的计数。svn 正常输出 C 行与计数一致；
   * 两者不一致时（C 行缺失但计数非零）宿主据总数提示，避免漏报冲突。
   */
  conflictSummary?: ConflictSummaryCounts;
}

export type UpdateRunResult = RunResult & UpdateResult;

/** 普通明细行：行首状态字母 + 空白 + 路径（如 `U    src/a.txt`）。 */
const ITEM_LINE = /^([A-Z~!?])\s+(.+)$/;
/**
 * 树冲突明细行：行首空白 + C + 空白 + 路径（如 `   C sub`），
 * 与行首字母的普通 C 行互斥；Svn 输出时树冲突占属性列。
 */
const TREE_CONFLICT_LINE = /^\s+C\s+(.+)$/;
/** 主副本最终 revision；externals 段的 `Updated external to revision N` 不匹配。 */
const FINAL_REVISION = /^(?:Updated to|At) revision (\d+)\./;
/** Summary of conflicts 段内的计数行（缩进两格）。 */
const SUMMARY_COUNT_LINE = /^\s+(Text|Property|Tree) conflicts: (\d+)$/;

export function parseUpdateOutput(text: string): UpdateResult {
  const items: UpdateItem[] = [];
  const finalRevisions: number[] = [];
  let conflictSummary: ConflictSummaryCounts | undefined;
  let inSummary = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');

    if (inSummary) {
      const count = SUMMARY_COUNT_LINE.exec(line);
      if (count) {
        const total = Number(count[2]);
        if (total > 0) {
          conflictSummary = conflictSummary ?? {};
          conflictSummary[count[1].toLowerCase() as keyof ConflictSummaryCounts] = total;
        }
        continue;
      }
      if (line.trim()) {
        inSummary = false;
      }
    }

    const item = ITEM_LINE.exec(line);
    if (item) {
      items.push({ status: item[1], path: item[2] });
      continue;
    }

    const treeConflict = TREE_CONFLICT_LINE.exec(line);
    if (treeConflict) {
      items.push({ status: 'C', path: treeConflict[1] });
      continue;
    }

    const revision = FINAL_REVISION.exec(line);
    if (revision) {
      finalRevisions.push(Number(revision[1]));
      continue;
    }

    if (line.trim() === 'Summary of conflicts:') {
      inSummary = true;
    }
  }

  return {
    items,
    finalRevision: finalRevisions.at(-1),
    finalRevisions: finalRevisions.length > 0 ? finalRevisions : undefined,
    conflicts: items.filter((item) => item.status === 'C').map((item) => item.path),
    conflictSummary,
  };
}

/**
 * 校验并归一化用户输入的更新版本号：十进制正整数或 `HEAD`（不区分大小写）。
 * 合法返回归一化值（正整数去前导零、HEAD 大写），非法返回 undefined。
 * 这是用户键盘输入的校验，允许首尾空白；与 SVN 数据解析的原值保留约定无关。
 */
export function normalizeUpdateRevision(input: string): string | undefined {
  const value = input.trim();
  if (/^\d+$/.test(value)) {
    const revision = Number(value);
    if (Number.isSafeInteger(revision) && revision > 0) {
      return String(revision);
    }
    return undefined;
  }
  if (value.toLowerCase() === 'head') {
    return 'HEAD';
  }
  return undefined;
}

/** 对目标路径执行 `svn update`（固定 --non-interactive）并解析结果；
 * revision 传入已归一化的正整数字符串或 `HEAD` 时追加 `-r <rev>`；
 * 批量操作传入数组时一次更新多个目标（输出按目标分段、明细路径相对 cwd）。 */
export async function runUpdate(
  svnPath: string,
  target: string | string[],
  options: RunOptions = {},
  revision?: string,
): Promise<UpdateRunResult> {
  const targets = typeof target === 'string' ? [target] : target;
  const args = ['update', '--non-interactive'];
  if (revision) {
    args.push('-r', revision);
  }
  for (const item of targets) {
    args.push(escapePeg(item));
  }
  const result = await runOrThrow(svnPath, args, options);
  return { ...result, ...parseUpdateOutput(result.stdout) };
}
