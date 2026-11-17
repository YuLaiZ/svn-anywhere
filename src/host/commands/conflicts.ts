/**
 * 「扫描冲突」命令（P7 冲突入口，M4 阶段 5 任务 1）。
 *
 * 入口语义：
 * - 资源管理器右键本地文件/目录、活动编辑器 file 文档与命令面板（文件
 *   选择框）统一解析：向上定位工作副本根，P7 按当前工作副本根处理，
 *   不汇总多个副本；普通入口的扫描范围固定为整副本（'.'）。
 * - 从 P6 更新任务进入时由宿主直接把同一更新结果（目标路径 + 冲突集合）
 *   交给 openConflictTarget，不经过 URL 参数重拼；本模块只提供入口类型
 *   与注入点，扫描/交互在面板控制器与模型（conflictModel）中完成。
 * - 只读边界：本命令不执行任何 SVN 写命令；扫描由面板按 operation
 *   record 与 conflicts 单任务槽驱动。
 *
 * 解耦点（并行开发与阶段推进）：命令解析出 ConflictOpenTarget 后交给
 * setConflictPanelOpener 注入的 P7 面板打开函数（面板控制器与 UI 由
 * panels/conflicts.ts 实现）。
 */
import * as vscode from 'vscode';
import { findWorkingCopy } from '../../core/workspace';
import { format, strings } from '../i18n';
import { logLine } from '../output';
import { registerCommand } from './registry';
import { pickTargetFsPath } from './target';

// ---------------------------------------------------------------------------
// 打开目标与注入点
// ---------------------------------------------------------------------------

/**
 * P7 打开目标：
 * - local：资源管理器/编辑器/命令面板入口，范围是工作副本根；
 * - update：P6 更新任务交接，范围是本次更新目标路径（任务范围），
 *   taskContext 只承载面板顶部展示用的更新上下文（请求 revision、
 *   更新前 BASE、回读节点 BASE 等），冲突集合由真实扫描重新读取。
 */
export type ConflictOpenTarget =
  | {
    source: 'local';
    wcRoot: string;
    /** 扫描范围（工作副本相对路径；普通入口固定 '.'）。 */
    scopeRelPath: string;
    /** 入口本地路径（右键目标；仅用于展示与定位）。 */
    localPath?: string;
  }
  | {
    source: 'update';
    wcRoot: string;
    /** 本次更新目标路径（工作副本相对路径；目录更新可为路径本身）。 */
    scopeRelPath: string;
    /** 更新任务上下文（阶段 6 定义形状；面板只展示，不据此伪造冲突）。 */
    taskContext?: unknown;
  };

/** P7 面板打开器：由面板控制器注入（本入口只负责解析与交接）。 */
export type ConflictPanelOpener = (target: ConflictOpenTarget) => Promise<void> | void;

let conflictPanelOpener: ConflictPanelOpener | undefined;

/** 注入 P7 面板打开器；传 undefined 恢复「冲突面板未接入」提示（测试重置用）。 */
export function setConflictPanelOpener(opener: ConflictPanelOpener | undefined): void {
  conflictPanelOpener = opener;
}

/** 打开 P7 面板；面板控制器未接入时给出明确提示，不静默吞掉用户动作。 */
export async function openConflictTarget(target: ConflictOpenTarget): Promise<void> {
  if (conflictPanelOpener !== undefined) {
    await conflictPanelOpener(target);
    return;
  }
  logLine(strings.conflictCommand.panelNotReady, 'conflict');
  void vscode.window.showInformationMessage(strings.conflictCommand.panelNotReady);
}

// ---------------------------------------------------------------------------
// 本地入口：向上找工作副本
// ---------------------------------------------------------------------------

export type LocalConflictTargetResult =
  | { status: 'ok'; wcRoot: string; localPath: string }
  | { status: 'notWorkingCopy' };

/**
 * 解析本地 P7 目标：与 P5/P6 入口同源向上定位副本根（嵌套副本命中最近），
 * 不读取节点身份（冲突扫描只需要副本根 + 范围）。目标可以是不存在的
 * missing 路径——findWorkingCopy 会回退到最近存在的父目录继续向上。
 */
export function resolveLocalConflictTarget(fsPath: string): LocalConflictTargetResult {
  const wcRoot = findWorkingCopy(fsPath);
  if (wcRoot === undefined) {
    return { status: 'notWorkingCopy' };
  }
  return { status: 'ok', wcRoot, localPath: fsPath };
}

// ---------------------------------------------------------------------------
// 命令本体
// ---------------------------------------------------------------------------

/**
 * `svnAnywhere.scanConflicts`：右键本地节点 / 活动编辑器 / 命令面板解析
 * 工作副本根后打开 P7；可预期失败（不在副本内）给信息提示，其余失败交给
 * 统一错误收口（registerCommand 的异常分支）。
 */
export async function commandScanConflicts(uri?: vscode.Uri): Promise<void> {
  // 只认 file scheme 的右键 uri（svn 等虚拟文档没有可定位的本地副本）。
  const fsPath = await pickTargetFsPath(uri !== undefined && uri.scheme === 'file' ? uri : undefined);
  if (fsPath === undefined) {
    return;
  }
  const resolved = resolveLocalConflictTarget(fsPath);
  if (resolved.status === 'notWorkingCopy') {
    void vscode.window.showInformationMessage(strings.conflictCommand.notWorkingCopy);
    return;
  }
  logLine(
    format(strings.target.resolved, {
      command: strings.command.scanConflicts,
      target: fsPath,
      wcRoot: resolved.wcRoot,
    }),
    'conflict',
  );
  await openConflictTarget({
    source: 'local',
    wcRoot: resolved.wcRoot,
    scopeRelPath: '.',
    localPath: resolved.localPath,
  });
}

// ---------------------------------------------------------------------------
// 命令注册（extension.activate 的 M4 入口接线）
// ---------------------------------------------------------------------------

/** 本命令的注册句柄：二次 activate 先释放上一次再重新注册。 */
let registeredDisposables: vscode.Disposable[] = [];

/**
 * 注册 `svnAnywhere.scanConflicts`：由 extension.activate 在 registerAllCommands
 * 之后调用（与 browseRepository/showHistory 同模式）。同一宿主实例二次激活
 * 时先释放上次句柄——VSCode 对已注册 ID 的 registerCommand 会抛 already exists。
 */
export function registerScanConflictsCommand(context: vscode.ExtensionContext): void {
  for (const disposable of registeredDisposables) {
    disposable.dispose();
  }
  registeredDisposables = [
    registerCommand(context, 'svnAnywhere.scanConflicts', commandScanConflicts, 'conflict'),
  ];
}

/** 测试辅助：释放本命令的注册句柄（不依赖 mock 的清空顺序）。 */
export function disposeScanConflictsCommandForTest(): void {
  for (const disposable of registeredDisposables) {
    disposable.dispose();
  }
  registeredDisposables = [];
}
