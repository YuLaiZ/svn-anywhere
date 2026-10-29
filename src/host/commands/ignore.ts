/**
 * 「忽略设置」命令（F121）：读取目标目录的 svn:ignore 规则，
 * 通过 QuickPick 选择加入当前名称、输入自定义模式或移除已有规则，
 * 经临时文件写回；属性修改是本地变更，需提交后才对团队生效。
 */
import * as vscode from 'vscode';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import {
  buildWriteArgs,
  mergeIgnoreRules,
  readIgnoreRules,
} from '../../core/ignore';
import { runOrThrow } from '../../core/svnCli';
import { readSvnPath, readTimeoutMs } from '../config';
import { format, strings } from '../i18n';
import { logCommand, logExitCode, logLine, showOutput } from '../output';
import { resolveWorkingCopyTarget } from './target';

interface IgnoreAction {
  label: string;
  // 属性名避开 QuickPickItem.kind（其类型是 Separator/Default 字面量，会破坏重载解析）。
  action: 'addName' | 'addPattern' | 'remove';
  rule?: string;
}

export async function commandEditIgnore(uri?: vscode.Uri): Promise<void> {
  const target = await resolveWorkingCopyTarget(uri, strings.command.editIgnore);
  if (!target) {
    return;
  }

  const svnPath = readSvnPath();
  const runOptions = { cwd: target.wcRoot, timeoutMs: readTimeoutMs(), onExit: logExitCode };

  // 属性作用于目录：目标是文件时取所在目录，目录取自身。
  let dirPath = target.targetPath;
  try {
    if (statSync(dirPath).isFile()) {
      dirPath = dirname(dirPath);
    }
  } catch {
    // stat 失败保留原路径，让 svn 报错原样呈现。
  }
  const dirArg = relative(target.wcRoot, dirPath);

  // 读取现有规则；属性不存在（W200017）按空规则处理。
  const propgetArgs = ['propget', 'svn:ignore', dirArg === '' ? '.' : dirArg];
  logCommand(svnPath, propgetArgs, target.wcRoot);
  const existing = await readIgnoreRules(svnPath, dirArg === '' ? '.' : dirArg, runOptions);

  const actions: IgnoreAction[] = [
    {
      label: format(strings.ignore.addCurrentName, { name: basename(target.targetPath) }),
      action: 'addName',
    },
    { label: strings.ignore.addCustomPattern, action: 'addPattern' },
    ...existing.map(
      (rule): IgnoreAction => ({
        label: format(strings.ignore.removeExisting, { rule }),
        action: 'remove',
        rule,
      }),
    ),
  ];
  const picked = await vscode.window.showQuickPick(actions, {
    title: format(strings.ignore.currentRulesHeader, { dir: dirPath }),
    placeHolder: strings.ignore.pickPlaceholder,
  });
  if (!picked) {
    return;
  }

  let additions: string[] = [];
  let removals: string[] = [];
  if (picked.action === 'addName') {
    additions = [basename(target.targetPath)];
  } else if (picked.action === 'addPattern') {
    const pattern = await vscode.window.showInputBox({
      prompt: strings.ignore.customPatternPrompt,
      ignoreFocusOut: true,
    });
    if (pattern === undefined || pattern.trim() === '') {
      return;
    }
    additions = [pattern.trim()];
  } else {
    removals = [picked.rule ?? ''];
  }

  const merged = mergeIgnoreRules(existing, additions, removals);
  const tmpDir = mkdtempSync(join(tmpdir(), 'svn-anywhere-ignore-'));
  try {
    const rulesFile = join(tmpDir, 'ignore.txt');
    if (merged.length > 0) {
      writeFileSync(rulesFile, `${merged.join('\n')}\n`, 'utf8');
    }
    const args = buildWriteArgs(merged, dirArg === '' ? '.' : dirArg, rulesFile);
    logCommand(svnPath, args, target.wcRoot);
    await runOrThrow(svnPath, args, runOptions);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  logLine(
    merged.length > 0
      ? format(strings.ignore.written, { rules: merged.join('、') })
      : strings.ignore.removed,
  );
  showOutput(false);
  void vscode.window.showInformationMessage(strings.ignore.localChange);
}
