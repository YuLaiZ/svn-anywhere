/**
 * P5 仓库浏览器控制器（M4 阶段 2 任务 2/4）：面板生命周期、意图分发与
 * 远端只读 IO 编排。状态机全部在 browseModel（纯模型）；本文件只做
 * 调度、IO、票据与资源清理。
 *
 * 只读边界（技术方案 §3.1）：P5 只执行 info/list/propget/cat 读命令，
 * 不产生 SVN 写命令，不在工作副本产生本地文件；远端内容经
 * host/readonlyContent 的只读 provider 或受管临时资源打开。
 *
 * 读请求代次（技术方案 §2.3/§3.3，阶段 1 host API）：
 * - 会话级：面板打开/切换目标/刷新根时 handle.beginReadRequest(入口 URL)
 *   重新取票据；任何回包先经 handle.isReadRequestCurrent(ticket) 校验，
 *   旧目标或根刷新前的回包一律丢弃；
 * - 节点级：模型为每个目录请求/详情 info/补全任务维护自增代次，回包
 *   必须与当前值一致——不同目录的请求互不取消，父目录刷新/折叠只会
 *   让其后代请求过期，兄弟目录回包照常生效；
 * - 远端命令一律 `--non-interactive`，认证经 authScope +
 *   credentialProvider 单飞协调器（同源并发只弹一次凭据框），凭据补录
 *   成功后重试原路径。
 */
import * as vscode from 'vscode';
import type { BrowseOpenTarget } from '../../commands/browse';
import { openHistoryFromNode } from '../../commands/browse';
import {
  readRemoteDirectory,
  readRemoteDirectoryNames,
  readRemoteNode,
} from '../../../core/remoteBrowse';
import { authScopeOfUrl, type AuthScope, type RunOptions } from '../../../core/svnCli';
import { credentialProvider } from '../../auth';
import { readSvnPath, readTimeoutMs } from '../../config';
import { format, strings } from '../../i18n';
import { decodingRunOptions, logCommand, logLine } from '../../output';
import { openRemoteContent } from '../../readonlyContent';
import {
  planM4SessionRestore,
  putM4ScopeSession,
  type M4SessionScope,
} from '../../sessionResults';
import {
  browseText,
  BrowseModel,
  BROWSE_TREE_ID,
  formatBytes,
  type BrowseBrowsableState,
  type BrowseDetailRequest,
  type BrowseMetadataTask,
} from '../browseModel';
import { createP5Gates } from '../gates';
import { createPanel, type PanelHandle, type ReadRequestTicket } from '../host';
import type { Intent } from '../protocol';
import { renderLazyNodeSlice } from '../view';

const PANEL_ID = 'browse';

interface BrowsePanelContext {
  extensionUri: vscode.Uri;
  subscriptions: vscode.Disposable[];
}

interface CapturedSession {
  handle: PanelHandle;
  model: BrowseModel;
  ticket: ReadRequestTicket;
}

let panelContext: BrowsePanelContext | undefined;
let handle: PanelHandle | undefined;
let model: BrowseModel | undefined;
let entryTarget: BrowseOpenTarget | undefined;
let sessionTicket: ReadRequestTicket | undefined;

/** 在途请求代次登记：节点目录读取、详情 info、元数据补全各一组。 */
const loadControllers = new Map<string, AbortController>();
const detailControllers = new Map<string, AbortController>();
const metadataControllers = new Map<string, AbortController>();
/** 入口 info 请求的取消句柄（刷新根/重试/关闭面板时终止）。 */
let rootController: AbortController | undefined;
let metadataPumpActive = false;
let pushTimer: NodeJS.Timeout | undefined;

/** activate 时注入宿主上下文（extensionUri / subscriptions）。 */
export function setBrowsePanelContext(context: BrowsePanelContext): void {
  panelContext = context;
}

/* ------------------------- 会话捕获与票据 ------------------------- */

function captureSession(): CapturedSession | undefined {
  if (handle === undefined || model === undefined || sessionTicket === undefined) {
    return undefined;
  }
  return { handle, model, ticket: sessionTicket };
}

/**
 * 会话是否仍然有效：面板未销毁、模型未被替换、读请求票据未被更新的
 * beginReadRequest 取代（打开新目标/切换目标/刷新根都会换票据）。
 */
function isSessionCurrent(captured: CapturedSession): boolean {
  return handle === captured.handle
    && model === captured.model
    && sessionTicket === captured.ticket
    && captured.handle.isReadRequestCurrent(captured.ticket);
}

/** 作用域键：入口 URL 规范化（去尾部斜杠）——同一入口重开命中同一项。 */
function browseScopeOf(url: string): M4SessionScope {
  const normalized = url.endsWith('/') ? url.slice(0, -1) : url;
  return { scopeKind: 'browse', targetKey: normalized };
}

/** 从 m4SessionStore 读取可浏览状态（P5 无任务/终态页，命中 browsable 层）。 */
function restoreStateFor(url: string): BrowseBrowsableState | undefined {
  const scope = browseScopeOf(url);
  const plan = planM4SessionRestore({ hasActiveTask: false, scope });
  if (plan.layer !== 'browsable') {
    return undefined;
  }
  const candidate = plan.browsable as Partial<BrowseBrowsableState> | null | undefined;
  if (candidate === null || candidate === undefined || typeof candidate !== 'object') {
    return undefined;
  }
  if (typeof candidate.entryUrl !== 'string' || candidate.snapshotRevision === undefined
    || typeof candidate.snapshotRevision !== 'number' || !Number.isFinite(candidate.snapshotRevision)) {
    return undefined;
  }
  const expandedPaths = Array.isArray(candidate.expandedPaths)
    ? candidate.expandedPaths.filter((path): path is string => typeof path === 'string')
    : [];
  const restore: BrowseBrowsableState = {
    entryUrl: url,
    snapshotRevision: candidate.snapshotRevision,
    expandedPaths,
  };
  if (typeof candidate.selectedPath === 'string') {
    restore.selectedPath = candidate.selectedPath;
  }
  return restore;
}

function persistBrowsable(): void {
  if (model === undefined) {
    return;
  }
  const browsable = model.browsableState();
  if (browsable === undefined) {
    return;
  }
  const scope = browseScopeOf(browsable.entryUrl);
  putM4ScopeSession(scope, { browsable }, { current: scope });
}

/* ------------------------- 推送 ------------------------- */

function push(): void {
  if (model === undefined || handle === undefined) {
    return;
  }
  const sessionId = handle.sessionId;
  handle.update(model.buildPanelState(sessionId), sessionId);
  persistBrowsable();
}

function pushIfCurrent(captured: CapturedSession): void {
  if (isSessionCurrent(captured)) {
    push();
  }
}

/** 元数据补全批量回包时合并推送（40ms 窗口），避免逐条 info 整帧重绘。 */
function schedulePush(): void {
  if (pushTimer !== undefined) {
    return;
  }
  pushTimer = setTimeout(() => {
    pushTimer = undefined;
    push();
  }, 40);
  pushTimer.unref?.();
}

/* ------------------------- 在途请求清理 ------------------------- */

function abortKey(key: string): void {
  const controller = loadControllers.get(key);
  if (controller !== undefined) {
    controller.abort();
    loadControllers.delete(key);
  }
}

function abortKeys(keys: readonly string[]): void {
  for (const key of keys) {
    abortKey(key);
  }
}

/** 删除后代/刷新时终止这些节点的元数据补全在途 info。 */
function cancelMetadataFor(keys: readonly string[]): void {
  if (model === undefined) {
    return;
  }
  for (const key of keys) {
    model.cancelMetadata(key);
    for (const [taskKey, controller] of [...metadataControllers]) {
      if (taskKey.startsWith(`${key}#`)) {
        controller.abort();
        metadataControllers.delete(taskKey);
      }
    }
  }
}

function cancelAllInflight(): void {
  rootController?.abort();
  rootController = undefined;
  for (const controller of loadControllers.values()) {
    controller.abort();
  }
  loadControllers.clear();
  for (const controller of detailControllers.values()) {
    controller.abort();
  }
  detailControllers.clear();
  for (const controller of metadataControllers.values()) {
    controller.abort();
  }
  metadataControllers.clear();
  metadataPumpActive = false;
  if (pushTimer !== undefined) {
    clearTimeout(pushTimer);
    pushTimer = undefined;
  }
}

/* ------------------------- 远端运行选项 ------------------------- */

/** 认证作用域：http/https/svn 可补录；file/svn+ssh 无 scope（不注入凭据框）。 */
function browseRunOptions(url: string): RunOptions {
  const svnPath = readSvnPath();
  const scope: AuthScope | undefined = authScopeOfUrl(url);
  const options: RunOptions = {
    timeoutMs: readTimeoutMs(),
    ...decodingRunOptions('browse'),
    onCredentialRetry: (args) => logCommand(svnPath, args, undefined, 'browse'),
  };
  if (scope !== undefined) {
    options.authScope = scope;
    options.getCredentials = credentialProvider(scope);
  }
  return options;
}

/* ------------------------- 打开面板 ------------------------- */

/** P5 打开器（命令层 setBrowsePanelOpener 注入的目标入口）。 */
export async function openBrowsePanel(target: BrowseOpenTarget): Promise<void> {
  if (panelContext === undefined) {
    logLine(strings.browse.panelNotReady, 'browse');
    void vscode.window.showInformationMessage(strings.browse.panelNotReady);
    return;
  }
  if (handle !== undefined) {
    // 同面板切换目标：P5 只读，busy 恒 false，不弹确认。
    const sessionId = handle.switchSession();
    if (sessionId === undefined) {
      void vscode.window.showInformationMessage(format(strings.panel.panelBusySwitchRejected, {
        target: target.url,
      }));
      return;
    }
  } else {
    handle = createPanel(
      PANEL_ID,
      { title: strings.output.titleBrowse, gates: createP5Gates() },
      { onIntent, onViewReady, onDispose: onPanelDispose },
      panelContext,
    );
  }
  await resetAndOpen(target);
}

async function resetAndOpen(target: BrowseOpenTarget): Promise<void> {
  if (handle === undefined) {
    return;
  }
  cancelAllInflight();
  entryTarget = target;
  const entryUrl = target.url;
  const restore = restoreStateFor(entryUrl);
  model = new BrowseModel();
  model.beginOpen(entryUrl, restore);
  sessionTicket = handle.beginReadRequest(entryUrl);
  push();
  const captured = captureSession();
  if (captured !== undefined) {
    await loadRootInfo(captured, entryUrl, restore);
  }
}

/**
 * 读取入口节点身份：重开恢复时先按旧浏览 revision 读；入口在旧 revision
 * 不存在（已删除/复制窗口未覆盖）时回落到当前 HEAD 重新读取。HEAD 读取
 * 得到的 snapshotRevision 固定为本次浏览 revision（用户刷新才更新）。
 */
async function loadRootInfo(
  captured: CapturedSession,
  url: string,
  restore: BrowseBrowsableState | undefined,
): Promise<void> {
  const svnPath = readSvnPath();
  const controller = new AbortController();
  rootController = controller;
  const runOptions: RunOptions = { ...browseRunOptions(url), signal: controller.signal };
  let result = restore !== undefined
    ? await readRemoteNode(svnPath, url, { ...runOptions, revision: restore.snapshotRevision })
    : await readRemoteNode(svnPath, url, runOptions);
  if (restore !== undefined && result.status === 'absent' && !controller.signal.aborted) {
    result = await readRemoteNode(svnPath, url, runOptions);
  }
  if (rootController === controller) {
    rootController = undefined;
  }
  if (!isSessionCurrent(captured)) {
    return;
  }
  if (result.status === 'present') {
    captured.model.applyRootInfo(result.node);
    pushIfCurrent(captured);
    advanceRestoreAndContinue(captured);
    pumpLoads();
    return;
  }
  captured.model.failOpen(result.error);
  pushIfCurrent(captured);
}

/* ------------------------- 目录读取 ------------------------- */

/** 消费模型的待读目录队列（不同目录可并行；模型按节点代次归属回包）。 */
function pumpLoads(): void {
  const captured = captureSession();
  if (captured === undefined) {
    return;
  }
  for (const key of captured.model.takeLoadRequests()) {
    void runNodeLoad(captured, key);
  }
}

async function runNodeLoad(captured: CapturedSession, key: string): Promise<void> {
  if (!isSessionCurrent(captured)) {
    return;
  }
  const requestSeq = captured.model.beginNodeLoad(key);
  if (requestSeq === undefined) {
    return;
  }
  const node = captured.model.nodeByKey(key);
  const revision = captured.model.snapshotRevisionValue;
  if (node === undefined || revision === undefined) {
    return;
  }
  pushIfCurrent(captured);
  const controller = new AbortController();
  loadControllers.set(key, controller);
  const svnPath = readSvnPath();
  const runOptions: RunOptions = { ...browseRunOptions(node.ref.rawUrl), signal: controller.signal };
  try {
    // 第一段：无元数据名称列表（100k 条目亚秒级），拿精确总数。
    const names = await readRemoteDirectoryNames(svnPath, node.ref.rawUrl, { ...runOptions, revision });
    if (!isSessionCurrent(captured) || !captured.model.isNodeRequestCurrent(key, requestSeq)) {
      return;
    }
    switch (names.status) {
      case 'ready': {
        const branch = captured.model.completeNodeNames(key, requestSeq, names.listing);
        if (branch === 'stale') {
          return;
        }
        if (branch === 'done') {
          pushIfCurrent(captured);
          advanceRestoreAndContinue(captured);
          pumpMetadataIfNeeded();
          return;
        }
        // 不超过阈值：常规目录继续一次性读完整元数据（行为与既有验收一致）。
        const listing = await readRemoteDirectory(svnPath, node.ref.rawUrl, { ...runOptions, revision });
        if (!isSessionCurrent(captured) || !captured.model.isNodeRequestCurrent(key, requestSeq)) {
          return;
        }
        if (listing.status === 'ready') {
          captured.model.completeNodeListing(key, requestSeq, listing.listing);
        } else if (listing.status === 'tooLarge') {
          captured.model.completeNodeTooLarge(key, requestSeq, {
            reason: listing.reason,
            limit: listing.limit,
          });
        } else {
          captured.model.failNode(key, requestSeq, listing.error);
        }
        break;
      }
      case 'tooLarge':
        captured.model.completeNodeTooLarge(key, requestSeq, {
          reason: names.reason,
          limit: names.limit,
        });
        break;
      case 'notFound':
      case 'error':
        captured.model.failNode(key, requestSeq, names.error);
        break;
      default:
        break;
    }
    advanceRestoreAndContinue(captured);
  } catch (err) {
    if (isSessionCurrent(captured) && captured.model.isNodeRequestCurrent(key, requestSeq)) {
      captured.model.failNode(key, requestSeq, {
        kind: 'unknown',
        message: err instanceof Error ? err.message : String(err),
        codes: [],
      });
      pushIfCurrent(captured);
    }
  } finally {
    if (loadControllers.get(key) === controller) {
      loadControllers.delete(key);
    }
  }
}

/** 目录 ready 后推进重开恢复（展开链/选中路径）。 */
function advanceRestoreAndContinue(captured: CapturedSession): void {
  if (!isSessionCurrent(captured)) {
    return;
  }
  const progress = captured.model.advanceRestore();
  if (progress.detail !== undefined) {
    void runDetailInfo(captured, progress.detail);
  }
  pushIfCurrent(captured);
  pumpLoads();
}

/* ------------------------- 详情 info ------------------------- */

async function runDetailInfo(captured: CapturedSession, request: BrowseDetailRequest): Promise<void> {
  if (!isSessionCurrent(captured)) {
    return;
  }
  const node = captured.model.nodeByKey(request.nodeKey);
  const revision = captured.model.snapshotRevisionValue;
  if (node === undefined || revision === undefined) {
    return;
  }
  const previous = detailControllers.get(request.nodeKey);
  if (previous !== undefined) {
    previous.abort();
  }
  const controller = new AbortController();
  detailControllers.set(request.nodeKey, controller);
  try {
    const result = await readRemoteNode(readSvnPath(), node.ref.rawUrl, {
      ...browseRunOptions(node.ref.rawUrl),
      revision,
      signal: controller.signal,
    });
    if (!isSessionCurrent(captured) || !captured.model.isDetailRequestCurrent(request.nodeKey, request.detailSeq)) {
      return;
    }
    if (result.status === 'present') {
      captured.model.applyDetailInfo(request.nodeKey, request.detailSeq, result.sizeBytes !== undefined
        ? { ref: result.node, sizeBytes: result.sizeBytes }
        : { ref: result.node });
    } else {
      captured.model.applyDetailInfo(request.nodeKey, request.detailSeq, { error: result.error });
    }
    pushIfCurrent(captured);
  } finally {
    if (detailControllers.get(request.nodeKey) === controller) {
      detailControllers.delete(request.nodeKey);
    }
  }
}

/* ------------------------- 元数据补全 ------------------------- */

function pumpMetadataIfNeeded(): void {
  if (model !== undefined && model.hasMetadataWork()) {
    pumpMetadata();
  }
}

/**
 * 元数据补全泵：模型按并发上限发任务（单节点 info），批量完成后再次取
 * 任务直到队列清空。取消/刷新通过模型补全代次使在途回包过期。
 */
function pumpMetadata(): void {
  if (metadataPumpActive) {
    return;
  }
  const captured = captureSession();
  if (captured === undefined) {
    return;
  }
  const tasks = captured.model.metadataTasks();
  if (tasks.length === 0) {
    return;
  }
  metadataPumpActive = true;
  void runMetadataBatch(captured, tasks);
}

async function runMetadataBatch(captured: CapturedSession, tasks: BrowseMetadataTask[]): Promise<void> {
  await Promise.all(tasks.map((task) => runMetadataTask(captured, task)));
  metadataPumpActive = false;
  if (!isSessionCurrent(captured)) {
    return;
  }
  schedulePush();
  if (captured.model.hasMetadataWork()) {
    pumpMetadata();
  }
}

async function runMetadataTask(captured: CapturedSession, task: BrowseMetadataTask): Promise<void> {
  const revision = captured.model.snapshotRevisionValue;
  if (revision === undefined) {
    return;
  }
  const taskKey = `${task.nodeKey}#${task.entryIndex}`;
  const controller = new AbortController();
  metadataControllers.set(taskKey, controller);
  try {
    const result = await readRemoteNode(readSvnPath(), task.url, {
      ...browseRunOptions(task.url),
      revision,
      signal: controller.signal,
    });
    if (!isSessionCurrent(captured) || !captured.model.isMetadataTaskCurrent(task.nodeKey, task.metadataSeq)) {
      return;
    }
    if (result.status === 'present') {
      const meta = {
        lastChangedRevision: result.node.lastChangedRevision,
        ...(result.node.lastChangedAuthor !== undefined
          ? { lastChangedAuthor: result.node.lastChangedAuthor }
          : {}),
        ...(result.node.lastChangedDate !== undefined
          ? { lastChangedDate: result.node.lastChangedDate }
          : {}),
        ...(result.sizeBytes !== undefined ? { sizeBytes: result.sizeBytes } : {}),
      };
      captured.model.applyMetadata(task.nodeKey, task.entryIndex, task.metadataSeq, meta);
    } else {
      captured.model.applyMetadata(task.nodeKey, task.entryIndex, task.metadataSeq, {
        error: result.error,
      });
    }
  } finally {
    if (metadataControllers.get(taskKey) === controller) {
      metadataControllers.delete(taskKey);
    }
  }
}

function cancelMetadata(): void {
  if (model === undefined) {
    return;
  }
  const cancelled = model.cancelMetadata();
  for (const nodeKey of cancelled) {
    for (const [taskKey, controller] of [...metadataControllers]) {
      if (taskKey.startsWith(`${nodeKey}#`)) {
        controller.abort();
        metadataControllers.delete(taskKey);
      }
    }
  }
  metadataPumpActive = false;
  push();
}

/* ------------------------- 刷新 / 重试 ------------------------- */

async function reloadNode(captured: CapturedSession, key: string): Promise<void> {
  if (!isSessionCurrent(captured)) {
    return;
  }
  const result = captured.model.reloadNode(key);
  abortKey(key);
  abortKeys(result.removed);
  cancelMetadataFor(result.removed);
  pushIfCurrent(captured);
  switch (result.kind) {
    case 'root': {
      // 根刷新读取新的 HEAD：重新取会话票据，旧回包全部失效。
      const url = captured.model.rootUrlValue;
      sessionTicket = captured.handle.beginReadRequest(url);
      const next = captureSession();
      if (next !== undefined) {
        await loadRootInfo(next, url, undefined);
      }
      return;
    }
    case 'node':
      pumpLoads();
      pumpMetadataIfNeeded();
      return;
    case 'detail':
      if (result.detail !== undefined) {
        await runDetailInfo(captured, result.detail);
      }
      return;
    default:
      return;
  }
}

/** 根错误横幅/页脚刷新：重新读取入口 info（HEAD）并重载根目录。 */
async function retryRoot(captured: CapturedSession): Promise<void> {
  if (!isSessionCurrent(captured)) {
    return;
  }
  const url = captured.model.rootUrlValue;
  const rootKey = captured.model.rootKeyValue;
  cancelAllInflight();
  if (rootKey !== undefined) {
    captured.model.reloadNode(rootKey);
  } else {
    captured.model.beginOpen(url);
  }
  sessionTicket = captured.handle.beginReadRequest(url);
  push();
  const next = captureSession();
  if (next !== undefined) {
    await loadRootInfo(next, url, undefined);
  }
}

/* ------------------------- 节点动作 ------------------------- */

async function copyNodeUrl(captured: CapturedSession, key: string): Promise<void> {
  const node = captured.model.nodeByKey(key);
  if (node === undefined) {
    return;
  }
  await vscode.env.clipboard.writeText(node.ref.rawUrl);
  handle?.toast('info', format(browseText('copyUrlDone'), { url: node.ref.rawUrl }));
  logLine(format(browseText('urlCopiedLog'), { url: node.ref.rawUrl }), 'browse');
}

async function openNode(captured: CapturedSession, key: string): Promise<void> {
  const node = captured.model.nodeByKey(key);
  if (node === undefined || node.kind !== 'file') {
    return;
  }
  const meta = captured.model.entryMeta(key);
  const outcome = await openRemoteContent(readSvnPath(), node.ref, {
    ...browseRunOptions(node.ref.rawUrl),
    ...(meta.sizeBytes !== undefined ? { sizeBytes: meta.sizeBytes } : {}),
  });
  if (!isSessionCurrent(captured)) {
    return;
  }
  switch (outcome.status) {
    case 'openedText':
      return;
    case 'openedExternal':
      handle?.toast('info', outcome.reason === 'binary'
        ? strings.browse.binaryNotice
        : strings.browse.textTooLargeNotice);
      return;
    case 'externalOpenFailed':
      handle?.toast('error', format(strings.browse.openExternalFailed, { path: outcome.filePath }));
      return;
    case 'tooLarge':
      handle?.toast('error', format(browseText('openFileTooLarge'), {
        size: formatBytes(outcome.sizeBytes),
        limit: formatBytes(outcome.limitBytes),
      }));
      return;
    case 'insufficientDisk':
      handle?.toast('error', outcome.message);
      return;
    case 'notFound':
      captured.model.pushNotice('error', browseText('loadFailedTitle'), browseText('notFoundMessage'));
      pushIfCurrent(captured);
      return;
    default:
      captured.model.pushNotice('error', browseText('loadFailedTitle'), captured.model.errorTitle(outcome.error));
      pushIfCurrent(captured);
      return;
  }
}

async function handoffHistory(captured: CapturedSession, key: string): Promise<void> {
  const ref = captured.model.nodeRefOf(key);
  if (ref === undefined) {
    return;
  }
  await openHistoryFromNode(ref);
}

/* ------------------------- 意图分发 ------------------------- */

async function onIntent(intent: Intent, context: { sessionId: string; busy: boolean }): Promise<void> {
  if (handle === undefined || handle.sessionId !== context.sessionId) {
    return;
  }
  const captured = captureSession();
  if (captured === undefined) {
    return;
  }
  switch (intent.kind) {
    case 'toggleBrowserNode': {
      const node = captured.model.nodeById(intent.nodeId);
      if (node === undefined) {
        return;
      }
      const result = captured.model.toggleNode(node.key);
      if (result.action === 'collapse') {
        abortKey(node.key);
        abortKeys(result.removed);
        cancelMetadataFor(result.removed);
      }
      if (result.needLoad) {
        pumpLoads();
      } else if (captured.model.hasMetadataWork()) {
        pumpMetadata();
      }
      pushIfCurrent(captured);
      return;
    }
    case 'selectBrowserNode': {
      const node = captured.model.nodeById(intent.nodeId);
      if (node === undefined) {
        return;
      }
      const result = captured.model.selectNode(node.key);
      if (result.detail !== undefined) {
        void runDetailInfo(captured, result.detail);
      }
      pushIfCurrent(captured);
      return;
    }
    case 'retryBrowserNode': {
      const node = captured.model.nodeById(intent.nodeId);
      if (node === undefined) {
        return;
      }
      await reloadNode(captured, node.key);
      return;
    }
    case 'refreshBrowserNode': {
      const node = captured.model.nodeById(intent.nodeId);
      if (node === undefined) {
        return;
      }
      const dir = node.dir;
      if (node.kind === 'dir' && dir !== undefined
        && (dir.metadata === 'pending' || dir.metadata === 'filling')) {
        // 行内「取消补全」复用 refreshBrowserNode 意图承载取消语义（协议
        // 无专用意图）：只取消该目录的补全任务，保留已补全条目，不重读。
        cancelMetadataFor([node.key]);
        pushIfCurrent(captured);
        return;
      }
      await reloadNode(captured, node.key);
      return;
    }
    case 'loadMoreBrowserNode': {
      const node = captured.model.nodeById(intent.nodeId);
      if (node === undefined) {
        return;
      }
      const previousVisible = node.dir?.visible ?? 0;
      const result = captured.model.loadMore(node.key);
      if (result.added > 0) {
        // 增量通道（技术方案 §3.2 冻结条款）：只发送本次新增的 ≤40 行
        // 片段，按 `treeId:nodeId` 定位目标节点的 .tree-node-children
        // 容器，不重复发送整棵树；附带的完整快照只更新宿主意图校验与
        // 视图重建重推依据，不触发整帧渲染。行内已读取计数等随下一次
        // 整段 render（选中/展开/补全回包）同步。
        const snapshot = captured.model.buildPanelState(captured.handle.sessionId);
        const rows = captured.model.buildNodeSlice(node.key, previousVisible, result.added);
        if (rows.length > 0) {
          const html = renderLazyNodeSlice(snapshot, rows, BROWSE_TREE_ID);
          captured.handle.appendTreeNodes(`${BROWSE_TREE_ID}:${node.id}`, html, snapshot);
        }
      }
      pumpMetadataIfNeeded();
      return;
    }
    case 'copyBrowserNodeUrl': {
      const node = captured.model.nodeById(intent.nodeId);
      if (node !== undefined) {
        await copyNodeUrl(captured, node.key);
      }
      return;
    }
    case 'openRemoteNode': {
      const node = captured.model.nodeById(intent.nodeId);
      if (node !== undefined) {
        await openNode(captured, node.key);
      }
      return;
    }
    case 'openHistoryFromBrowser': {
      const node = captured.model.nodeById(intent.nodeId);
      if (node !== undefined) {
        await handoffHistory(captured, node.key);
      }
      return;
    }
    case 'bannerAction': {
      if (intent.actionId === 'cancelBrowserMetadata') {
        cancelMetadata();
        return;
      }
      if (intent.actionId === 'retryBrowseRoot') {
        await retryRoot(captured);
        return;
      }
      return;
    }
    case 'dismissBanner': {
      if (intent.bannerId === 'browseTooLargeNode') {
        captured.model.clearLimitNotice();
      } else {
        captured.model.dismissNotice(intent.bannerId);
      }
      pushIfCurrent(captured);
      return;
    }
    case 'refresh': {
      // 页脚默认“刷新”按钮的兼容入口：等价于根刷新。
      await retryRoot(captured);
      return;
    }
    case 'closePanel': {
      handle?.dispose();
      return;
    }
    default:
      return;
  }
}

function onViewReady(): void {
  push();
}

function onPanelDispose(): void {
  cancelAllInflight();
  handle = undefined;
  model = undefined;
  entryTarget = undefined;
  sessionTicket = undefined;
}

/* ------------------------- 测试辅助 ------------------------- */

/** 当前会话快照（测试断言用；真实宿主不需要）。 */
export function browseSessionSnapshot(): {
  entryUrl?: string;
  rootUrl?: string;
  snapshotRevision?: number;
  rootPhase?: string;
  nodeCount?: number;
  selectedKey?: string;
} {
  return {
    entryUrl: entryTarget?.url,
    rootUrl: model?.rootUrlValue,
    snapshotRevision: model?.snapshotRevisionValue,
    rootPhase: model?.rootPhaseValue,
    nodeCount: model?.nodeCount(),
    selectedKey: model?.selectedNodeKey,
  };
}

/** 测试辅助：重置面板控制器（清空会话与在途请求）。 */
export function resetBrowsePanelController(): void {
  cancelAllInflight();
  handle?.dispose();
  handle = undefined;
  model = undefined;
  entryTarget = undefined;
  sessionTicket = undefined;
  panelContext = undefined;
}
