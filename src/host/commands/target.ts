/**
 * 命令统一入口：目标路径解析与工作副本定位。host 模块。
 * 路径来源优先级：右键传入的 uri → 活动编辑器（仅 file scheme）→ 文件选择框。
 * 用户在任一步取消都静默返回 undefined；路径不在工作副本内时给出
 * 明确的信息提示（约定：可预期情况不弹错误对话框）。
 */
import * as vscode from 'vscode';
import { dedupeNestedPaths, findWorkingCopy } from '../../core/workspace';
import { format, strings } from '../i18n';
import { logLine, type OutputKind } from '../output';

export interface WcTarget {
  /** 命中的工作副本根（realpath 后）。 */
  wcRoot: string;
  /** 右键/选择的原始目标路径；传给 svn 前须经 escapePeg 转义。 */
  targetPath: string;
}

/** 批量命令解析结果：同一工作副本的去重目标为一组，保持选区顺序。 */
export interface WcTargetGroup {
  wcRoot: string;
  /** 去重嵌套后的绝对目标路径（最外层，含重复项收敛）。 */
  targetPaths: string[];
}

/**
 * 解析命令目标并定位工作副本；任一步不成立（取消、非副本）时返回 undefined，
 * 命令实现应直接返回。commandLabel 只用于输出频道与提示中的命令名；
 * kind 是该命令的输出频道分类（定位留痕写入同一频道）。
 */
export async function resolveWorkingCopyTarget(
  uri: vscode.Uri | undefined,
  commandLabel: string,
  kind: OutputKind = 'other',
): Promise<WcTarget | undefined> {
  const fsPath = await pickTargetFsPath(uri);
  if (!fsPath) {
    return undefined;
  }
  const wcRoot = findWorkingCopy(fsPath);
  if (!wcRoot) {
    void vscode.window.showInformationMessage(strings.error.notWorkingCopy);
    return undefined;
  }
  logLine(format(strings.target.resolved, { command: commandLabel, target: fsPath, wcRoot }), kind);
  return { wcRoot, targetPath: fsPath };
}

/**
 * 解析资源管理器多选选区：先做嵌套路径去重（只保留最外层），再按命中的
 * 工作副本分组。不在工作副本内的路径跳过并提示；全部无效时返回空数组，
 * 调用方应直接返回。定位留痕按组写入 kind 频道。
 */
export function resolveBatchTargetGroups(
  uris: readonly vscode.Uri[],
  commandLabel: string,
  kind: OutputKind = 'other',
): WcTargetGroup[] {
  const deduped = dedupeNestedPaths(uris.map((uri) => uri.fsPath));
  const groups: WcTargetGroup[] = [];
  let skipped = false;
  for (const fsPath of deduped) {
    const wcRoot = findWorkingCopy(fsPath);
    if (!wcRoot) {
      skipped = true;
      continue;
    }
    const group = groups.find((item) => item.wcRoot === wcRoot);
    if (group) {
      group.targetPaths.push(fsPath);
    } else {
      groups.push({ wcRoot, targetPaths: [fsPath] });
    }
  }
  if (skipped) {
    void vscode.window.showInformationMessage(strings.error.notWorkingCopy);
  }
  for (const group of groups) {
    logLine(
      format(strings.target.resolved, {
        command: commandLabel,
        target: group.targetPaths.join('、'),
        wcRoot: group.wcRoot,
      }),
      kind,
    );
  }
  return groups;
}

async function pickTargetFsPath(uri?: vscode.Uri): Promise<string | undefined> {
  if (uri) {
    return uri.fsPath;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file') {
    return editor.document.uri.fsPath;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: strings.dialog.openTarget,
  });
  return picked?.[0]?.fsPath;
}

/** 确认框/进度标题里的多目标展示：路径以「、」连接，超出上限截断为总数后缀。 */
export function summarizePaths(paths: string[], limit = 5): string {
  if (paths.length <= limit) {
    return paths.join('、');
  }
  const shown = paths.slice(0, limit).join('、');
  return `${shown}${format(strings.list.moreSuffix, { count: String(paths.length) })}`;
}
