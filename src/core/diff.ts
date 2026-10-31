/**
 * 单文件差异的 BASE 读取。core 模块，不依赖 vscode。
 *
 * 口径（技术方案 §6）：
 * - 普通修改比较 BASE 与工作文件；新增项处理不存在的一端
 *   （svn cat -r BASE 对带历史复制的新增返回复制来源内容，
 *   纯新增则没有 BASE）；
 * - cat/info 与 diff 的路径转义语义不同（本地 SVN 1.15 实测）：
 *   cat -r BASE 与 info 不允许裸 peg，含 @ 的路径须尾部补 @ 转义
 *   （escapePeg）；svn diff 恰相反，必须用原始字面路径，追加尾 @ 会把
 *   a@1 指向 a@1@。两者都以 `--` 结束选项解析，短横线开头的相对路径
 *   由 escapePeg 的 `./` 前缀保护；
 * - 内容经统一执行层读取（UTF-8 文本）；二进制文件由宿主在打开前检测，
 *   不做文本差异。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOrThrow, type RunOptions } from './svnCli';
import { SvnError } from './errors';
import { escapePeg } from './workspace';

export type BaseContentResult =
  | { ok: true; tempDir: string; tempPath: string; content: string }
  /** 没有 BASE revision（未版本控制 / 纯新增）；不是读取失败。 */
  | { ok: false; reason: 'noBase' }
  | { ok: false; reason: 'error'; stderr: string };

/** svn 报告「无 BASE revision」的错误码（未版本控制、无历史新增等）。 */
const NO_BASE_CODES = ['E200009'];

/**
 * 读取目标文件的 BASE 内容并写入临时文件（随差异编辑器引用释放，
 * 由宿主管理清理）。返回临时目录，便于同目录放置空内容端。
 */
export async function readBaseContent(
  svnPath: string,
  wcRoot: string,
  relPath: string,
  options: RunOptions = {},
): Promise<BaseContentResult> {
  // cat 不允许裸 peg：含 @ 的路径经 escapePeg 尾部补 @ 转义（实测 a@1
  // 裸传报 E200009 peg not allowed；a@1@/a@1@@ 分别读到字面 a@1/a@1@）。
  const args = ['cat', '-r', 'BASE', '--', escapePeg(relPath)];
  let result;
  try {
    result = await runOrThrow(svnPath, args, { cwd: wcRoot, ...options });
  } catch (err) {
    const stderr = err instanceof SvnError ? err.stderr || err.message : err instanceof Error ? err.message : String(err);
    if (NO_BASE_CODES.some((code) => stderr.includes(code))) {
      return { ok: false, reason: 'noBase' };
    }
    return { ok: false, reason: 'error', stderr };
  }
  const tempDir = mkdtempSync(join(tmpdir(), 'svn-anywhere-diff-'));
  const tempPath = join(tempDir, 'base');
  writeFileSync(tempPath, result.stdout, 'utf8');
  return { ok: true, tempDir, tempPath, content: result.stdout };
}

/** 删除一次差异打开产生的临时目录；失败静默（临时目录随系统清理）。 */
export function removeDiffTempDir(tempDir: string): void {
  rmSync(tempDir, { recursive: true, force: true });
}

/** UTF-8 解码后的内容是否疑似二进制（含 NUL 字节即判定，与 svn 的启发一致）。 */
export function looksBinary(text: string): boolean {
  return text.includes('\0');
}

/** 从 svn info 输出提取 Copied From URL / Rev（带历史复制的新增识别）。 */
export function parseCopiedFrom(infoStdout: string): { url: string; revision: number } | undefined {
  let url: string | undefined;
  let revision: number | undefined;
  for (const line of infoStdout.split('\n')) {
    const copiedUrl = line.match(/^Copied From URL:\s*(\S+)/);
    if (copiedUrl) {
      url = copiedUrl[1];
    }
    const copiedRev = line.match(/^Copied From Rev:\s*(\d+)/);
    if (copiedRev) {
      revision = Number(copiedRev[1]);
    }
  }
  return url !== undefined && revision !== undefined ? { url, revision } : undefined;
}

/** 读取条目的 svn info 文本（带历史复制识别用）。 */
export async function readInfoText(
  svnPath: string,
  wcRoot: string,
  relPath: string,
  options: RunOptions = {},
): Promise<string> {
  // info 同 cat：裸 @ 路径会被当 peg 解析，须转义。
  const result = await runOrThrow(svnPath, ['info', '--', escapePeg(relPath)], { cwd: wcRoot, ...options });
  return result.stdout;
}
