/**
 * 单文件差异的宿主打开逻辑：按条目状态决定差异两端与展示方式，
 * 用 vscode.diff 并排打开；临时资源随差异编辑器引用释放。
 *
 * 能力口径（技术方案 §6 / 交互清单）：
 * - 普通修改：BASE → 工作文件；
 * - 新增：无 BASE 时空内容 → 当前文件；带历史复制的新增先识别来源，
 *   BASE 端即复制来源内容（svn cat -r BASE 对 copied 节点返回来源），
 *   标题注明复制来源；
 * - 删除：BASE → 空内容；missing 本地缺失，明示不可比较（登记删除后可看）；
 * - 纯属性修改：属性差异独立展示（svn diff --properties 写输出频道），
 *   不用内容相同的文本 diff 假装没有变化；
 * - 二进制：明示能力并给打开文件入口，不做文本差异；
 * - 未版本控制：差异按钮禁用，走「打开文件」。
 */
import * as vscode from 'vscode';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { looksBinary, parseCopiedFrom, readBaseContent, readInfoText, removeDiffTempDir } from '../core/diff';
import { runOrThrow } from '../core/svnCli';
import { readTimeoutMs } from './config';
import { format, strings } from './i18n';
import { logCommand, logExitCode, logLine, showOutput } from './output';

export interface DiffTarget {
  svnPath: string;
  wcRoot: string;
  /** 相对副本根的原始路径（保留首尾空格；不能从展示文本反推）。 */
  relPath: string;
  wcStatus: string;
  props?: string;
  kind?: string;
}

export type DiffOutcome =
  | 'diffed'
  | 'addedNoBase'
  | 'deleted'
  | 'propertyDiffShown'
  | 'binaryNotified'
  | 'missingNotified'
  | 'unversionedNotified'
  | 'directoryNotified'
  | 'failed';

/** 临时文件 → 所在临时目录；一个目录的全部引用关闭后清理该目录。 */
const tempRefs = new Map<string, string>();

/** 关闭监听（首次打开差异时注册）。 */
let closeSubscription: vscode.Disposable | undefined;

/** 测试辅助：重置临时资源追踪。 */
export function resetDiffViewForTest(): void {
  for (const tempDir of new Set(tempRefs.values())) {
    removeDiffTempDir(tempDir);
  }
  tempRefs.clear();
  closeSubscription?.dispose();
  closeSubscription = undefined;
}

/**
 * 打开/展示单个条目的差异；返回结果分类（供测试与能力提示使用）。
 * relPath 由宿主从条目映射，视图侧不传路径。
 */
export async function openEntryDiff(target: DiffTarget): Promise<DiffOutcome> {
  const { svnPath, wcRoot, relPath, wcStatus, props, kind } = target;

  if (wcStatus === 'unversioned') {
    return 'unversionedNotified';
  }
  if (wcStatus === 'missing') {
    // 本地端不存在：登记删除后才能比较 BASE → 空内容。
    return 'missingNotified';
  }
  if (kind === 'dir') {
    // 目录节点没有文本差异；纯属性目录走属性差异，其余明示无文本差异。
    if (props === 'modified') {
      return showPropertyDiff(svnPath, wcRoot, relPath);
    }
    return 'directoryNotified';
  }
  // 纯属性修改：item 为 normal 而 props 为 modified。
  if (wcStatus === 'normal' && props === 'modified') {
    return showPropertyDiff(svnPath, wcRoot, relPath);
  }

  const base = await readBaseContent(svnPath, wcRoot, relPath);
  if (!base.ok && base.reason === 'error') {
    logLine(format(strings.error.failed, { message: (base.stderr.split('\n')[0] ?? '').trim() }));
    return 'failed';
  }

  const deleted = wcStatus === 'deleted';
  const currentPath = join(wcRoot, relPath);

  // 二进制检测：本地端存在读本地端；删除项本地端已不存在，读 BASE 端。
  const probe = deleted
    ? (base.ok ? base.content.slice(0, 8192) : '')
    : safeReadHead(currentPath);
  if (looksBinary(probe)) {
    return 'binaryNotified';
  }

  // 左端（BASE / 空）：右端（工作文件 / 删除后的空内容）。
  const tempDir = mkdtempSync(join(tmpdir(), 'svn-anywhere-diff-'));
  const baseTempPath = join(tempDir, 'base');
  writeFileSync(baseTempPath, base.ok ? base.content : '', 'utf8');
  registerTempRef(tempDir, baseTempPath);

  const rightPath = deleted ? join(tempDir, 'empty') : currentPath;
  if (deleted) {
    writeFileSync(rightPath, '', 'utf8');
    registerTempRef(tempDir, rightPath);
  }

  const title = await diffTitle(svnPath, wcRoot, relPath, wcStatus);
  await openDiffEditor(vscode.Uri.file(baseTempPath), vscode.Uri.file(rightPath), title);
  if (deleted) {
    return 'deleted';
  }
  return base.ok ? 'diffed' : 'addedNoBase';
}

/** 差异标题：带历史复制的新增标注来源；普通修改/替换用 BASE → 工作副本。 */
async function diffTitle(svnPath: string, wcRoot: string, relPath: string, wcStatus: string): Promise<string> {
  if (wcStatus === 'added') {
    try {
      const copied = parseCopiedFrom(await readInfoText(svnPath, wcRoot, relPath));
      if (copied) {
        return format(strings.panel.copiedFromTitle, {
          path: relPath,
          source: copied.url,
          revision: String(copied.revision),
        });
      }
    } catch {
      // info 失败不阻塞差异：退回普通新增标题。
    }
    return format(strings.panel.addedDiffTitle, { path: relPath });
  }
  return format(strings.panel.diffTitle, { path: relPath });
}

async function openDiffEditor(left: vscode.Uri, right: vscode.Uri, title: string): Promise<void> {
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: false });
}

/** 纯属性差异：svn diff 原样写入输出频道并展示（实测 1.15 无 --properties 选项；纯属性条目的 diff 输出只含属性段）。 */
async function showPropertyDiff(svnPath: string, wcRoot: string, relPath: string): Promise<DiffOutcome> {
  const args = ['diff', '--', relPath];
  logCommand(svnPath, args, wcRoot);
  try {
    const result = await runOrThrow(svnPath, args, {
      cwd: wcRoot,
      timeoutMs: readTimeoutMs(),
      onExit: logExitCode,
    });
    logLine(format(strings.panel.propDiffHeader, { path: relPath }));
    logLine(result.stdout.trim() || strings.commit.diffClean);
    showOutput(false);
    return 'propertyDiffShown';
  } catch (err) {
    logLine(format(strings.error.failed, {
      message: (err instanceof Error ? err.message.split('\n')[0] ?? '' : String(err)),
    }));
    return 'failed';
  }
}

function safeReadHead(path: string): string {
  try {
    return readFileSync(path, 'utf8').slice(0, 8192);
  } catch {
    return '';
  }
}

/** 登记临时文件引用：引用它的差异编辑器一侧文档关闭时释放整个临时目录。 */
function registerTempRef(tempDir: string, tempPath: string): void {
  tempRefs.set(vscode.Uri.file(tempPath).toString(), tempDir);
  ensureCloseListener();
}

function ensureCloseListener(): void {
  if (closeSubscription) {
    return;
  }
  closeSubscription = vscode.workspace.onDidCloseTextDocument((doc) => {
    const uri = doc.uri.toString();
    const tempDir = tempRefs.get(uri);
    if (tempDir === undefined) {
      return;
    }
    // 同一目录的全部引用文档都已关闭时清理（diff 两侧各算一个引用）。
    const siblings = [...tempRefs.entries()].filter(([, dir]) => dir === tempDir);
    for (const [key] of siblings) {
      tempRefs.delete(key);
    }
    removeDiffTempDir(tempDir);
  });
}

/** 差异打开的用户可见提示（二进制/缺失等能力明示）。 */
export function diffOutcomeNotice(outcome: DiffOutcome, target: DiffTarget): string | undefined {
  switch (outcome) {
    case 'binaryNotified':
      return format(strings.panel.binaryNotice, { path: target.relPath });
    case 'missingNotified':
      return format(strings.panel.missingNotice, { path: target.relPath });
    default:
      return undefined;
  }
}
