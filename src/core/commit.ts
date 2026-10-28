/**
 * svn commit 的参数构建与结果解析。core 模块，不依赖 vscode。
 */
import { escapePeg } from './workspace';

/** 单批提交的路径数上限；超过时分批提交（技术方案 8）。 */
export const COMMIT_BATCH_SIZE = 100;

export interface CommitResult {
  /** 新 revision（`Committed revision N`）。 */
  revision?: number;
}

/** 解析 `svn commit` 输出中的新 revision。 */
export function parseCommitOutput(text: string): CommitResult {
  const match = /Committed revision (\d+)\./.exec(text);
  return { revision: match ? Number(match[1]) : undefined };
}

/**
 * 构建一条 commit 命令参数：说明经临时文件传入并声明 UTF-8，
 * 避免多行/特殊字符的 shell 与编码问题；路径以副本根为基准的相对路径，
 * 含 @ 的路径做 peg 转义。
 */
export function buildCommitArgs(messageFile: string, paths: string[]): string[] {
  return [
    'commit',
    '--non-interactive',
    '--file',
    messageFile,
    '--encoding',
    'UTF-8',
    ...paths.map((p) => escapePeg(p)),
  ];
}
