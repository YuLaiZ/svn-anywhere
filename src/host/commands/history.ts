/**
 * 「查看历史」命令（P6 历史入口，M4 阶段 3 任务 1）。
 *
 * 入口语义（技术方案 §7、交互设计 §三）：
 * - 资源管理器右键本地文件/目录：向上定位工作副本根，读取节点身份
 *   （URL/仓库根/UUID/kind）与本地 BASE revision（本地 `svn info`，
 *   不访问网络）；
 * - 活动编辑器 file 文档与命令面板（文件选择框）走同一解析路径；
 * - P5 任意节点的「查看变更日志」经 HistoryHandoffPayload（快照 revision）
 *   交接，本模块只注入/消费该载荷，不重复注册远端 URL 入口；
 * - 只读边界：P6 不产生任何 SVN 写命令（update/resolve 属阶段 6/5）。
 *
 * 解耦点（并行开发与阶段推进）：命令解析出 HistoryOpenTarget 后交给
 * setHistoryPanelOpener 注入的 P6 面板打开函数（面板控制器与模型由
 * panels/history.ts + historyModel.ts 实现）。
 */
import * as vscode from 'vscode';
import { SvnError } from '../../core/errors';
import { readNodeIdentity } from '../../core/nodeIdentity';
import { classifyInfoError } from '../../core/remoteInfo';
import type { RunOptions } from '../../core/svnCli';
import { findWorkingCopy } from '../../core/workspace';
import { readSvnPath, readTimeoutMs } from '../config';
import { strings } from '../i18n';
import { decodingRunOptions, logCommand, logLine } from '../output';
import { registerCommand, showCommandError } from './registry';
import { pickTargetFsPath } from './target';
import type { HistoryHandoffPayload } from './browse';

// ---------------------------------------------------------------------------
// 打开目标与注入点
// ---------------------------------------------------------------------------

/** 本地历史目标：节点身份 + 本地 BASE（会话上下文条与 base-fallback 能力）。 */
export interface LocalHistoryTarget {
  /** 向上定位到的工作副本根。 */
  wcRoot: string;
  /** 右键目标本地绝对路径（文件或目录）。 */
  localPath: string;
  /** 节点 URL（svn 输出的原始编码形态，命令与复制保留原值）。 */
  url: string;
  repositoryRootUrl: string;
  repositoryUuid: string;
  /** 仓库相对 POSIX 路径（逐段解码一次，不含 `^/`；根节点为空串）。 */
  relativePath: string;
  kind: 'file' | 'dir';
  /** 本地节点当前 revision（BASE/working；混合修订按目标节点取值）。 */
  baseRevision: number;
}

/**
 * P6 打开目标：本地工作副本节点（showHistory 命令）或 P5 节点交接
 * （HistoryHandoffPayload，快照 revision 固定）。
 */
export type HistoryOpenTarget =
  | ({ source: 'local' } & LocalHistoryTarget)
  | { source: 'handoff'; payload: HistoryHandoffPayload };

/** P6 面板打开器：由面板控制器注入（本入口只负责解析与交接）。 */
export type HistoryPanelOpener = (target: HistoryOpenTarget) => Promise<void> | void;

let historyPanelOpener: HistoryPanelOpener | undefined;

/** 注入 P6 面板打开器；传 undefined 恢复「历史面板未接入」提示（测试重置用）。 */
export function setHistoryPanelOpener(opener: HistoryPanelOpener | undefined): void {
  historyPanelOpener = opener;
}

/** 打开 P6 面板；面板控制器未接入时给出明确提示，不静默吞掉用户动作。 */
export async function openHistoryTarget(target: HistoryOpenTarget): Promise<void> {
  if (historyPanelOpener !== undefined) {
    await historyPanelOpener(target);
    return;
  }
  logLine(strings.historyCommand.panelNotReady, 'browse');
  void vscode.window.showInformationMessage(strings.historyCommand.panelNotReady);
}

// ---------------------------------------------------------------------------
// 本地入口：向上找工作副本并读节点身份/BASE
// ---------------------------------------------------------------------------

export type LocalHistoryTargetResult =
  | { status: 'ok'; target: LocalHistoryTarget }
  | { status: 'notWorkingCopy' }
  | { status: 'unversioned'; message: string }
  | { status: 'svnMissing'; message: string }
  | { status: 'error'; error: unknown };

/**
 * 节点 URL → 仓库相对路径：剥掉仓库根前缀，逐段解码一次（与原编码 URL
 * 的展示语义解耦）；不匹配根前缀时返回空串（不猜测身份）。
 */
export function relativePathOfUrl(url: string, repositoryRootUrl: string): string {
  const root = repositoryRootUrl.endsWith('/') ? repositoryRootUrl.slice(0, -1) : repositoryRootUrl;
  if (url === root) {
    return '';
  }
  if (!url.startsWith(`${root}/`)) {
    return '';
  }
  return url.slice(root.length + 1).split('/').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }).join('/');
}

/**
 * 解析本地历史目标：findWorkingCopy 向上定位副本根（嵌套副本命中最近），
 * 对右键目标本身执行本地 `svn info` 读取 URL/仓库根/UUID/kind/revision。
 *
 * 失败分类与 P5 入口同源（classifyInfoError）：不在任何副本内 →
 * notWorkingCopy；副本内但节点未纳管/不存在 → unversioned；svn 可执行
 * 缺失 → svnMissing；其余失败原样返回由命令层统一收口。目标必须是右键
 * 节点本身，不借父目录的 URL 误报成功。
 */
export async function resolveLocalHistoryTarget(
  fsPath: string,
  svnPath: string,
  runOptions: RunOptions = {},
): Promise<LocalHistoryTargetResult> {
  const wcRoot = findWorkingCopy(fsPath);
  if (wcRoot === undefined) {
    return { status: 'notWorkingCopy' };
  }
  try {
    const identity = await readNodeIdentity(svnPath, fsPath, {
      ...runOptions,
      onLog: (args, cwd) => logCommand(svnPath, args, cwd, 'browse'),
    });
    return {
      status: 'ok',
      target: {
        wcRoot,
        localPath: fsPath,
        url: identity.url,
        repositoryRootUrl: identity.repositoryRootUrl,
        repositoryUuid: identity.repositoryUuid,
        relativePath: relativePathOfUrl(identity.url, identity.repositoryRootUrl),
        // `svn info` 文本输出的 Node Kind 是 directory/file（XML 模式才是
        // dir/file）；统一成 P6 的 dir/file 两值。symlink 等其余节点按文件处理。
        kind: identity.kind === 'directory' || identity.kind === 'dir' ? 'dir' : 'file',
        baseRevision: identity.revision,
      },
    };
  } catch (err) {
    if (err instanceof SvnError) {
      const { reason, message } = classifyInfoError(err);
      if (reason === 'unversioned') {
        return { status: 'unversioned', message };
      }
      if (reason === 'svnMissing') {
        return { status: 'svnMissing', message };
      }
    }
    return { status: 'error', error: err };
  }
}

// ---------------------------------------------------------------------------
// 命令本体
// ---------------------------------------------------------------------------

/**
 * `svnAnywhere.showHistory`：右键本地节点 / 活动编辑器 / 命令面板（文件
 * 选择框）解析本地目标后打开 P6。可预期失败给信息/警告提示，其余失败
 * 交给统一错误收口（registerCommand 的异常分支）。
 */
export async function commandShowHistory(uri?: vscode.Uri): Promise<void> {
  // 只认 file scheme 的右键 uri（svn 等虚拟文档没有可定位的本地副本）；
  // 其余回退到活动编辑器/文件选择框。
  const fsPath = await pickTargetFsPath(uri !== undefined && uri.scheme === 'file' ? uri : undefined);
  if (fsPath === undefined) {
    return;
  }
  const svnPath = readSvnPath();
  const runOptions: RunOptions = { timeoutMs: readTimeoutMs(), ...decodingRunOptions('browse') };
  const resolved = await resolveLocalHistoryTarget(fsPath, svnPath, runOptions);
  switch (resolved.status) {
    case 'ok':
      await openHistoryTarget({ source: 'local', ...resolved.target });
      return;
    case 'notWorkingCopy':
      void vscode.window.showInformationMessage(strings.historyCommand.notWorkingCopy);
      return;
    case 'unversioned':
      void vscode.window.showInformationMessage(strings.historyCommand.unversioned);
      return;
    case 'svnMissing':
      void vscode.window.showWarningMessage(strings.activation.svnMissing);
      return;
    case 'error':
      showCommandError(resolved.error, 'browse');
      return;
  }
}

// ---------------------------------------------------------------------------
// 命令注册（extension.activate 的 M4 入口接线）
// ---------------------------------------------------------------------------

/** 本命令的注册句柄：二次 activate 先释放上一次再重新注册。 */
let registeredDisposables: vscode.Disposable[] = [];

/**
 * 注册 `svnAnywhere.showHistory`：由 extension.activate 在 registerAllCommands
 * 之后调用（与 browseRepository 同模式）。同一宿主实例二次激活时先释放
 * 上次句柄——VSCode 对已注册 ID 的 registerCommand 会抛 already exists。
 */
export function registerShowHistoryCommand(context: vscode.ExtensionContext): void {
  for (const disposable of registeredDisposables) {
    disposable.dispose();
  }
  registeredDisposables = [
    registerCommand(context, 'svnAnywhere.showHistory', commandShowHistory, 'browse'),
  ];
}

/** 测试辅助：释放本命令的注册句柄（不依赖 mock 的清空顺序）。 */
export function disposeShowHistoryCommandForTest(): void {
  for (const disposable of registeredDisposables) {
    disposable.dispose();
  }
  registeredDisposables = [];
}
