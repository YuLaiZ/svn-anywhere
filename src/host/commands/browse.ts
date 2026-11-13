/**
 * 「浏览仓库」命令（P5 仓库浏览器入口，M4 阶段 2 任务 1/5）。
 *
 * 入口语义（技术方案 §3.1）：
 * - 资源管理器右键本地文件或目录：向上定位工作副本根，读取节点 URL、
 *   仓库根、UUID 与 kind（本地 `svn info` 元数据查询，不访问网络）；
 * - 命令面板无本地目标：原生输入框接收远端 URL，显示值经
 *   encodeEditableURL 逆变换编码后过检出侧同一 URL 校验；P5 只接受
 *   http/https/svn 三种可补录凭据的协议，userinfo、query、fragment 与
 *   未编码字符（空格/控制字符）给出明确提示。
 *
 * 只读边界：本入口不产生任何 SVN 写命令，也不在工作副本产生本地文件；
 * 远端内容读取全部经 readonlyContent 的只读 provider / 临时资源通道。
 *
 * 解耦点（并行开发与阶段推进）：
 * - 命令解析出 BrowseOpenTarget 后交给 setBrowsePanelOpener 注入的 P5
 *   面板打开函数（面板控制器与 Webview 由阶段 2 其余任务实现）；
 * - 任意节点的「查看变更日志」不直接注册 showHistory 命令（阶段 3
 *   实现），只把节点身份与类型经 buildHistoryHandoff 构造为 P6 交接
 *   载荷，交给 setHistoryHandoffHandler 注入的 P6 打开函数。载荷不含
 *   HTML、不含展示文本；repo 相对路径与原始 URL 分开保存。
 */
import * as vscode from 'vscode';
import { encodeEditableURL, normalizeCheckoutUrl } from '../../core/checkout';
import { SvnError } from '../../core/errors';
import { readNodeIdentity } from '../../core/nodeIdentity';
import type { RepoNodeRef } from '../../core/remoteBrowse';
import { classifyInfoError } from '../../core/remoteInfo';
import type { RunOptions } from '../../core/svnCli';
import { findWorkingCopy } from '../../core/workspace';
import { readSvnPath, readTimeoutMs } from '../config';
import { strings } from '../i18n';
import { decodingRunOptions, logCommand, logLine } from '../output';
import { registerCommand, showCommandError } from './registry';

// ---------------------------------------------------------------------------
// 打开目标与注入点
// ---------------------------------------------------------------------------

/** P5 打开目标：本地工作副本节点或命令面板输入的远端 URL。 */
export type BrowseOpenTarget =
  | {
      source: 'local';
      /** 向上定位到的工作副本根。 */
      wcRoot: string;
      /** 右键目标本地绝对路径（文件或目录）。 */
      localPath: string;
      /** 节点 URL（svn 输出的原始编码形态，命令与复制保留原值）。 */
      url: string;
      repositoryRootUrl: string;
      repositoryUuid: string;
      kind: 'file' | 'dir';
    }
  | {
      source: 'remote';
      /** 已校验并规范化编码的远端 URL（http/https/svn）。 */
      url: string;
    };

/** P5 面板打开器：由面板控制器注入（本入口只负责解析与交接）。 */
export type BrowsePanelOpener = (target: BrowseOpenTarget) => Promise<void> | void;

let browsePanelOpener: BrowsePanelOpener | undefined;

/** 注入 P5 面板打开器；传 undefined 恢复「面板未接入」提示（测试重置用）。 */
export function setBrowsePanelOpener(opener: BrowsePanelOpener | undefined): void {
  browsePanelOpener = opener;
}

/** 打开 P5 面板；面板控制器未接入时给出明确提示，不静默吞掉用户动作。 */
export async function openBrowseTarget(target: BrowseOpenTarget): Promise<void> {
  if (browsePanelOpener !== undefined) {
    await browsePanelOpener(target);
    return;
  }
  logLine(strings.browse.panelNotReady, 'browse');
  void vscode.window.showInformationMessage(strings.browse.panelNotReady);
}

// ---------------------------------------------------------------------------
// 本地入口：向上找工作副本并读 URL/kind
// ---------------------------------------------------------------------------

export type LocalBrowseTargetResult =
  | { status: 'ok'; target: Extract<BrowseOpenTarget, { source: 'local' }> }
  | { status: 'notWorkingCopy' }
  | { status: 'unversioned'; message: string }
  | { status: 'svnMissing'; message: string }
  | { status: 'error'; error: unknown };

/**
 * 解析本地浏览目标：findWorkingCopy 向上定位副本根（嵌套副本命中最近），
 * 对右键目标本身执行 `svn info` 读取 URL/仓库根/UUID/kind。
 *
 * 失败分类：不在任何副本内 → notWorkingCopy（不读 svn）；副本内但节点
 * 未纳管/不存在（E200009/E155007）→ unversioned；svn 可执行缺失 →
 * svnMissing；其余失败原样返回由命令层统一收口。目标必须是右键节点
 * 本身，不借父目录的 URL 误报成功。
 */
export async function resolveLocalBrowseTarget(
  fsPath: string,
  svnPath: string,
  runOptions: RunOptions = {},
): Promise<LocalBrowseTargetResult> {
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
        source: 'local',
        wcRoot,
        localPath: fsPath,
        url: identity.url,
        repositoryRootUrl: identity.repositoryRootUrl,
        repositoryUuid: identity.repositoryUuid,
        // `svn info` 文本输出的 Node Kind 是 directory/file（XML 模式才是
        // dir/file）；统一成 P5 的 dir/file 两值。symlink 等其余节点按文件处理。
        kind: identity.kind === 'directory' || identity.kind === 'dir' ? 'dir' : 'file',
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
// 命令面板入口：远端 URL 输入与校验
// ---------------------------------------------------------------------------

/** P5 命令面板远端入口允许的协议（仅可补录 HTTP 凭据的三种）。 */
export const BROWSE_URL_SCHEMES: readonly string[] = ['http', 'https', 'svn'];

export type BrowseUrlRejectReason = 'empty' | 'scheme' | 'userinfo' | 'query' | 'fragment' | 'unencoded';

export type BrowseUrlParseResult =
  | { ok: true; url: string }
  | { ok: false; reason: BrowseUrlRejectReason; message: string };

/**
 * 远端 URL 校验链（技术方案 §3.1）：
 * 1. 空输入给「URL 不能为空」；
 * 2. 先按 P5 白名单拒绝其它协议（file/svn+ssh/ftp 等）——检出侧的
 *    通用校验允许五种协议，P5 浏览入口只接受 http/https/svn；
 * 3. 显示值经 encodeEditableURL 逆变换（中文 → %XX，`@`/`#` 等既有
 *    转义保留），再过 normalizeCheckoutUrl：userinfo、query、fragment
 *    与未编码字符（空格/控制字符）按检出侧同一文案拒绝。
 *
 * 编码问题（如直接粘贴含空格的显示文本）必须暴露为可读错误，不能把
 * 未编码字符塞给 svn 后按底层报错呈现。
 */
export function parseBrowseUrl(raw: string): BrowseUrlParseResult {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'empty', message: strings.browse.urlEmpty };
  }
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(trimmed);
  if (schemeMatch === null || !BROWSE_URL_SCHEMES.includes(schemeMatch[1].toLowerCase())) {
    return { ok: false, reason: 'scheme', message: strings.browse.urlSchemeOnly };
  }
  const encoded = encodeEditableURL(trimmed);
  const result = normalizeCheckoutUrl(encoded);
  return result.ok
    ? { ok: true, url: result.url }
    : { ok: false, reason: result.reason, message: result.message };
}

/** 命令面板输入框：validateInput 实时校验，取消或非法输入返回 undefined。 */
export async function promptRemoteBrowseUrl(): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({
    prompt: strings.browse.urlPrompt,
    placeHolder: strings.browse.urlPlaceholder,
    ignoreFocusOut: true,
    validateInput: (value: string) => {
      const parsed = parseBrowseUrl(value);
      return parsed.ok ? undefined : parsed.message;
    },
  });
  if (input === undefined) {
    return undefined;
  }
  const parsed = parseBrowseUrl(input);
  return parsed.ok ? parsed.url : undefined;
}

// ---------------------------------------------------------------------------
// 命令本体
// ---------------------------------------------------------------------------

/**
 * `svnAnywhere.browseRepository`：右键本地节点走本地解析；命令面板
 * （无 file uri）弹出远端 URL 输入框。可预期失败给信息/警告提示，其余
 * 失败交给统一错误收口（registerCommand 的异常分支）。
 */
export async function commandBrowseRepository(uri?: vscode.Uri): Promise<void> {
  const svnPath = readSvnPath();
  const runOptions: RunOptions = { timeoutMs: readTimeoutMs(), ...decodingRunOptions('browse') };

  if (uri !== undefined && uri.scheme === 'file') {
    const resolved = await resolveLocalBrowseTarget(uri.fsPath, svnPath, runOptions);
    switch (resolved.status) {
      case 'ok':
        await openBrowseTarget(resolved.target);
        return;
      case 'notWorkingCopy':
        void vscode.window.showInformationMessage(strings.browse.notWorkingCopy);
        return;
      case 'unversioned':
        void vscode.window.showInformationMessage(strings.browse.unversioned);
        return;
      case 'svnMissing':
        void vscode.window.showWarningMessage(strings.activation.svnMissing);
        return;
      case 'error':
        showCommandError(resolved.error, 'browse');
        return;
    }
  }

  const url = await promptRemoteBrowseUrl();
  if (url === undefined) {
    return;
  }
  await openBrowseTarget({ source: 'remote', url });
}

// ---------------------------------------------------------------------------
// P6 历史交接载荷（本阶段不注册 showHistory）
// ---------------------------------------------------------------------------

/**
 * P6 历史交接载荷（阶段 3 任务 1「P5 进入时固定节点类型、URL、仓库
 * 相对路径和 HEAD」的冻结输入）：
 * - kind 与仓库相对路径来自同一节点身份，不随展示文本漂移；
 * - snapshotRevision 作为 P6 首批历史 upperRevision，跳转时不静默改读
 *   另一个 HEAD；
 * - 载荷只含身份与类型，不含 HTML 参数或界面文案。
 */
export interface HistoryHandoffPayload {
  kind: 'file' | 'dir';
  repositoryUuid: string;
  repositoryRootUrl: string;
  /** 原始编码节点 URL（命令与复制保留原值）。 */
  rawUrl: string;
  /** 仓库相对 POSIX 路径（逐段解码一次，不含 `^/`；根节点为空串）。 */
  relativePath: string;
  /** 本次浏览快照 revision（P6 首批历史的上界）。 */
  snapshotRevision: number;
}

/** P6 打开器：阶段 3 注册 showHistory 后由该命令接线吸收交接载荷。 */
export type HistoryHandoffHandler = (payload: HistoryHandoffPayload) => Promise<void> | void;

let historyHandoffHandler: HistoryHandoffHandler | undefined;

/** 注入 P6 打开器；传 undefined 恢复「历史面板未接入」提示（测试重置用）。 */
export function setHistoryHandoffHandler(handler: HistoryHandoffHandler | undefined): void {
  historyHandoffHandler = handler;
}

/** 从浏览节点构造 P6 交接载荷（纯函数，供 P5 控制器逐字段取值）。 */
export function buildHistoryHandoff(node: RepoNodeRef): HistoryHandoffPayload {
  return {
    kind: node.kind,
    repositoryUuid: node.repositoryUuid,
    repositoryRootUrl: node.repositoryRootUrl,
    rawUrl: node.rawUrl,
    relativePath: node.relativePath,
    snapshotRevision: node.snapshotRevision,
  };
}

/**
 * 任意节点的「查看变更日志」入口：构造交接载荷并交给 P6 打开器。
 * 本阶段不注册 showHistory 命令（阶段 3 实现）；未接线时明确提示。
 */
export async function openHistoryFromNode(node: RepoNodeRef): Promise<void> {
  const payload = buildHistoryHandoff(node);
  if (historyHandoffHandler !== undefined) {
    await historyHandoffHandler(payload);
    return;
  }
  logLine(strings.browse.historyNotReady, 'browse');
  void vscode.window.showInformationMessage(strings.browse.historyNotReady);
}

/** 测试辅助：清空两个注入点，避免用例间互相影响。 */
export function resetBrowseEntryForTest(): void {
  browsePanelOpener = undefined;
  historyHandoffHandler = undefined;
}

// ---------------------------------------------------------------------------
// 命令注册（extension.activate 的 M4 入口接线）
// ---------------------------------------------------------------------------

/** 本命令的注册句柄：二次 activate 先释放上一次再重新注册。 */
let registeredDisposables: vscode.Disposable[] = [];

/**
 * 注册 `svnAnywhere.browseRepository`：由 extension.activate 在
 * registerAllCommands 之后调用。同一宿主实例二次激活（调试、自动化场景）
 * 时先释放上次句柄——VSCode 对已注册 ID 的 registerCommand 会抛
 * already exists，重复注册会让 activate 失败。
 */
export function registerBrowseRepositoryCommand(context: vscode.ExtensionContext): void {
  for (const disposable of registeredDisposables) {
    disposable.dispose();
  }
  registeredDisposables = [
    registerCommand(context, 'svnAnywhere.browseRepository', commandBrowseRepository, 'browse'),
  ];
}

/** 测试辅助：释放本命令的注册句柄（不依赖 mock 的清空顺序）。 */
export function disposeBrowseRepositoryCommandForTest(): void {
  for (const disposable of registeredDisposables) {
    disposable.dispose();
  }
  registeredDisposables = [];
}
