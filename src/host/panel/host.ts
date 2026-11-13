/**
 * 面板宿主：createWebviewPanel 在整个扩展里只出现在本文件。
 *
 * 生命周期（技术方案 §2.4）：
 * - Map<panelId, PanelEntry>：同 panelId 再次打开复用实例（reveal）；
 *   同类型面板不同目标切换会话（新 sessionId），忙碌时拒绝切换；
 * - onDidDispose 后从 Map 移除并释放监听；迟到结果不再更新已销毁视图；
 * - 关闭面板不宣称撤销已执行的 SVN 写入。
 *
 * 安全（技术方案 §2.5）：
 * - localResourceRoots 限定 media/；CSP default-src 'none'，
 *   script 只允许带随机 nonce 的资源，样式/图片走 cspSource；
 * - 入站消息经 parseViewMessage 运行时校验（版本、结构、动作白名单），
 *   意图再做会话代次、条目操作能力与 busy/请求去重校验；
 *   路径由宿主从当前状态映射，视图传来的 ID 不可能携带路径。
 */
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { format, strings } from '../i18n';
import { logLine } from '../output';
import {
  parseViewMessage,
  PROTOCOL_VERSION,
  type HostToViewMessage,
  type Intent,
  type ViewToHostMessage,
} from './protocol';
import { allowedActions, gatePermits, M2_PANEL_GATES, type PanelGates } from './gates';
import type { LazyTreeRowSpec, PanelState, RowSpec, TableRowSpec } from './state';
import { findRow } from './state';
import { render } from './view';

export interface PanelController {
  /** 视图意图通过全部校验后转发给控制器；路径映射等业务决策在控制器内。 */
  onIntent(intent: Intent, context: IntentContext): void | Promise<void>;
  /**
   * 视图重建握手（ready）时回调：webview 重载后视图输入序号从零重启，
   * 控制器须把表单确认序号（formRevision）归零并重推状态，避免旧大序号
   * 把新视图的待确认输入误判为已确认。
   */
  onViewReady?(): void;
  /** 面板销毁（用户关闭标签）时回调；宿主已完成自身清理。 */
  onDispose?(): void;
}

export interface IntentContext {
  sessionId: string;
  /** 意图送达时面板是否忙碌（宿主已按 busy 拒绝写意图，这里是同一事实）。 */
  busy: boolean;
}

export interface PanelEntryOptions {
  /** 面板标题（VSCode 标签标题）。 */
  title: string;
  /** 仅 P1 开启 retainContextWhenHidden；其余面板隐藏即销毁、重显时由宿主重推状态。 */
  retainContextWhenHidden?: boolean;
  viewColumn?: vscode.ViewColumn;
  /**
   * 占用态（busy/writeLocked）放行表：面板注册时注入，宿主守卫与 DOM
   * 禁用按同一张表推导。不携带时按基线表守卫（busy 只放行迟到输入同步、
   * writeLocked 只放行核实与重读，含横幅按钮按 actionId）——提交/忽略
   * 面板的放行集合与「占用即全禁」的 DOM 行为保持不变；携带自定义表
   * 的面板（任务与面板解耦、运行中需可取消/看日志/查看已有分析）同时
   * 获得按表推导的 DOM 可交互视图（随渲染注入 PanelState.gate）。
   */
  gates?: PanelGates;
  /**
   * writeLocked 时是否拒绝切换目标：M4 的 P6/P7 写入在途禁止切换目标
   * （技术方案 §7、交互基线「写入在途」行）；不携带时维持 M1-M3 行为
   * ——只有 busy 拒绝切换，写锁（结果未知/待协调记录）不阻止换目标。
   */
  blockSwitchWhenWriteLocked?: boolean;
}

interface PanelEntry {
  panel: vscode.WebviewPanel;
  controller: PanelController;
  options: PanelEntryOptions;
  /** 当前会话代次：目标切换即更换。 */
  sessionId: string;
  state: PanelState | undefined;
  revision: number;
  /** 视图代次：ready 握手递增（webview 重建即新代），随 render 下发。 */
  viewEpoch: number;
  /** 读请求代次：每次 beginReadRequest 递增，旧票据随之过期（目标切换归零重开）。 */
  readSeq: number;
  /** 已处理的请求 ID：同一请求重复送达直接忽略。 */
  handledRequests: Set<string>;
  messageDisposable: vscode.Disposable;
  disposeDisposable: vscode.Disposable;
  /** dispose 之后标记：迟到异步结果静默丢弃。 */
  disposed: boolean;
}

/** 扩展进程级面板注册表；测试通过 resetPanelRegistry 重置。 */
const panels = new Map<string, PanelEntry>();

function newSessionId(): string {
  return randomBytes(12).toString('hex');
}

/** 面板 HTML 骨架：CSP + nonce + asWebviewUri；结构只在此注入一次。 */
export function panelHtmlTemplate(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(24).toString('hex');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.css'));
  const cspSource = webview.cspSource;
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta http-equiv="Content-Security-Policy" content=' +
      `"default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">`,
    `<link rel="stylesheet" href="${styleUri}">`,
    '</head>',
    '<body>',
    '<div id="app"></div>',
    `<script nonce="${nonce}" src="${scriptUri}"></script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

export interface PanelHandle {
  readonly panelId: string;
  readonly sessionId: string;
  /** 更新状态并渲染推送；目标切换/销毁后的迟到结果被丢弃。 */
  update(next: PanelState, forSessionId?: string): void;
  /**
   * 追加 P5 懒加载树的新增节点片段（每次 ≤40 个节点）：只发已渲染的
   * 行 HTML，视图按 `data-append-key`（`treeId:nodeId`，节点的 children
   * 容器）追加、不重建整棵树；revision 与 render 共用同一会话单调序列。
   * snapshot 是本会话包含新增行后的完整状态快照，只更新宿主内部的意图
   * 校验/视图重建重推依据，不触发整帧渲染。尚无整段渲染（树容器不存在）
   * 或参数为空时静默丢弃，调用方随后用整帧 render 兜底。
   */
  appendTreeNodes(target: string, html: string, snapshot: PanelState): void;
  /** 推送瞬时提示。 */
  toast(level: 'info' | 'error', message: string): void;
  /** 切换目标：生成新会话代次；忙碌（或按面板配置的写锁）时返回 undefined 并提示。 */
  switchSession(): string | undefined;
  /**
   * 发起读请求：递增本会话读请求代次并返回票据。读结果回包时用
   * isReadRequestCurrent 判定归属，旧请求或旧会话的回包不得覆盖当前页面。
   */
  beginReadRequest(targetKey: string): ReadRequestTicket;
  /**
   * 读请求票据是否仍属于当前会话且未被更新的读请求取代。targetKey 的
   * 当前目标比对由控制器完成（宿主不理解目标键语义）；viewEpoch 变化
   * （视图重建）不使票据失效——宿主状态仍有效，重推即可上屏。
   */
  isReadRequestCurrent(ticket: ReadRequestTicket): boolean;
  reveal(): void;
  dispose(): void;
}

/**
 * 读请求票据（技术方案 §2.3）：读结果携带 targetKey + requestSeq +
 * viewEpoch，只写回同一目标会话。targetKey 供旧目标缓存寻址与控制器
 * 比对当前目标；requestSeq 由 beginReadRequest 递增，同目标的旧回包
 * 因代次过期被丢弃；viewEpoch 标记发起时的视图代次，供控制器在视图
 * 重建后决定滚动/焦点恢复策略（不参与归属判定）。
 */
export interface ReadRequestTicket {
  /** 发起时的面板会话：目标切换后旧会话票据全部过期。 */
  sessionId: string;
  /** 发起时的目标键（控制器定义的不透明字符串）。 */
  targetKey: string;
  /** 本会话读请求代次：发起更新的读请求后旧票据过期。 */
  requestSeq: number;
  /** 发起时的视图代次（ready 握手递增）。 */
  viewEpoch: number;
}

/**
 * 创建或复用面板。同 panelId 已存在时只 reveal 并保留当前会话与状态
 * （同目标草稿保留由状态不重置自然成立）；控制器负责判断同目标还是新目标。
 */
export function createPanel(
  panelId: string,
  options: PanelEntryOptions,
  controller: PanelController,
  context: { extensionUri: vscode.Uri; subscriptions: vscode.Disposable[] },
): PanelHandle {
  const existing = panels.get(panelId);
  if (existing && !existing.disposed) {
    existing.panel.reveal();
    return handleFor(existing);
  }

  // createWebviewPanel：全扩展唯一调用点（硬约束）。
  const panel = vscode.window.createWebviewPanel(
    `svn-anywhere-${panelId}`,
    options.title,
    options.viewColumn ?? vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: options.retainContextWhenHidden ?? false,
      enableCommandUris: false,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    },
  );
  panel.webview.html = panelHtmlTemplate(panel.webview, context.extensionUri);

  const entry: PanelEntry = {
    panel,
    controller,
    options,
    sessionId: newSessionId(),
    state: undefined,
    revision: 0,
    viewEpoch: 0,
    readSeq: 0,
    handledRequests: new Set(),
    messageDisposable: { dispose: () => {} },
    disposeDisposable: { dispose: () => {} },
    disposed: false,
  };

  entry.messageDisposable = panel.webview.onDidReceiveMessage((raw: unknown) => {
    void handleViewMessage(entry, raw);
  });
  entry.disposeDisposable = panel.onDidDispose(() => {
    entry.disposed = true;
    entry.messageDisposable.dispose();
    entry.disposeDisposable.dispose();
    if (panels.get(panelId) === entry) {
      panels.delete(panelId);
    }
    entry.controller.onDispose?.();
  });
  panels.set(panelId, entry);
  context.subscriptions.push({ dispose: () => disposeEntry(entry, panelId) });
  return handleFor(entry);
}

function handleFor(entry: PanelEntry): PanelHandle {
  const panelId = findPanelId(entry);
  return {
    get panelId() {
      return panelId;
    },
    get sessionId() {
      return entry.sessionId;
    },
    update(next: PanelState, forSessionId?: string) {
      if (entry.disposed) {
        return;
      }
      if (forSessionId !== undefined && forSessionId !== entry.sessionId) {
        // 目标已切换：旧会话的迟到结果不写入新目标。
        logLine(format(strings.panel.toastStaleSession, {}), 'commit');
        return;
      }
      if (next.sessionId !== entry.sessionId) {
        // 状态快照自身所属的会话也必须与面板当前会话一致：切换目标的窗口内，
        // 全局会话可能尚未重建，此时构建出的旧目标快照即使携带了新会话 ID
        // 也不得上屏（否则标题/列表会展示上一个目标的数据）。
        logLine(format(strings.panel.toastStaleSession, {}), 'commit');
        return;
      }
      entry.state = next;
      entry.revision += 1;
      postToView(entry, {
        type: 'render',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: entry.sessionId,
        revision: entry.revision,
        formRevision: next.formRevision,
        viewEpoch: entry.viewEpoch,
        html: render({ ...renderStateOf(entry, next), revision: entry.revision }),
      });
    },
    toast(level, message) {
      if (entry.disposed) {
        return;
      }
      postToView(entry, {
        type: 'toast',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: entry.sessionId,
        level,
        message,
      });
    },
    appendTreeNodes(target, html, snapshot) {
      if (entry.disposed || entry.state === undefined) {
        // 还没有整段渲染时树容器不存在，append 无目标可追加。
        return;
      }
      if (target === '' || html === '') {
        return;
      }
      if (snapshot.sessionId !== entry.sessionId) {
        // 旧会话快照不写入当前面板（与 update 的会话校验同口径）。
        return;
      }
      // 只更新校验/重推快照，不发送整帧：视图侧仅追加新增切片。
      entry.state = snapshot;
      entry.revision += 1;
      postToView(entry, {
        type: 'append',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: entry.sessionId,
        revision: entry.revision,
        target,
        html,
      });
    },
    switchSession() {
      if (entry.disposed) {
        // 面板已销毁：与忙碌分支一致返回 undefined，调用方能区分「切换成功」与「面板已死」。
        return undefined;
      }
      if (entry.state?.busy) {
        return undefined;
      }
      // M4 的 P6/P7：写入在途（writeLocked）禁止切换目标；M1-M3 面板不携带
      // 该选项，写锁不阻止换目标（既有行为）。
      if (entry.options.blockSwitchWhenWriteLocked && entry.state?.writeLocked) {
        return undefined;
      }
      entry.sessionId = newSessionId();
      entry.handledRequests.clear();
      entry.revision = 0;
      // 会话代次已换：归零读请求代次，旧会话票据因 sessionId 不匹配而过期。
      entry.readSeq = 0;
      return entry.sessionId;
    },
    beginReadRequest(targetKey: string) {
      entry.readSeq += 1;
      return {
        sessionId: entry.sessionId,
        targetKey,
        requestSeq: entry.readSeq,
        viewEpoch: entry.viewEpoch,
      };
    },
    isReadRequestCurrent(ticket: ReadRequestTicket) {
      if (entry.disposed) {
        return false;
      }
      // 视图重建（viewEpoch 变化）不让宿主状态失效，故只按会话与读代次判定。
      return ticket.sessionId === entry.sessionId && ticket.requestSeq === entry.readSeq;
    },
    reveal() {
      if (!entry.disposed) {
        entry.panel.reveal();
      }
    },
    dispose() {
      disposeEntry(entry, panelId);
      entry.panel.dispose();
    },
  };
}

function findPanelId(entry: PanelEntry): string {
  for (const [id, candidate] of panels) {
    if (candidate === entry) {
      return id;
    }
  }
  return '';
}

function disposeEntry(entry: PanelEntry, panelId: string): void {
  if (entry.disposed) {
    return;
  }
  entry.disposed = true;
  entry.messageDisposable.dispose();
  entry.disposeDisposable.dispose();
  if (panels.get(panelId) === entry) {
    panels.delete(panelId);
  }
  entry.controller.onDispose?.();
}

function postToView(entry: PanelEntry, message: HostToViewMessage): void {
  void entry.panel.webview.postMessage(message);
}

/** 入站消息处理：运行时校验 → 会话校验 → 能力校验 → 控制器。 */
async function handleViewMessage(entry: PanelEntry, raw: unknown): Promise<void> {
  if (entry.disposed) {
    return;
  }
  const parsed = parseViewMessage(raw);
  if (!parsed.ok) {
    // 协议错误不静默：弹 toast 让问题可见（文案经 i18n）。
    postToView(entry, {
      type: 'toast',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: entry.sessionId,
      level: 'error',
      message: format(strings.panel.toastInvalidMessage, { reason: parsed.reason }),
    });
    return;
  }
  const message: ViewToHostMessage = parsed.message;
  if (message.type === 'ready') {
    // 幂等：隐藏重建后视图重新加载会再握手，宿主重推当前状态。
    // 视图的请求序号随重建从 0 重启（retainContextWhenHidden=false 时隐藏即
    // 销毁 webview），旧去重集合会把新视图的 req-1… 当成重复请求静默吞掉，
    // 因此每次握手都清空重开（ready 只在全新视图上下文出现，清空无重放风险）。
    entry.handledRequests.clear();
    // 视图代次递增：新视图的输入确认空间（formRevision 对比 inputRevision）
    // 随重启从零开始，控制器同步归零已确认序号，旧大序号不再参与比较。
    entry.viewEpoch += 1;
    entry.controller.onViewReady?.();
    if (entry.state && entry.state.sessionId === entry.sessionId) {
      entry.revision += 1;
      postToView(entry, {
        type: 'render',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: entry.sessionId,
        revision: entry.revision,
        formRevision: entry.state.formRevision,
        viewEpoch: entry.viewEpoch,
        html: render({ ...renderStateOf(entry, entry.state), revision: entry.revision }),
      });
    }
    // 快照属于旧会话（切换目标后新会话尚未重建）时不重推：旧目标内容不得
    // 借视图重建回到界面，等待新会话加载后的正常帧覆盖。
    return;
  }

  if (message.sessionId !== entry.sessionId) {
    return;
  }
  if (entry.handledRequests.has(message.requestId)) {
    return;
  }
  entry.handledRequests.add(message.requestId);

  const intent = message.intent;
  const busy = entry.state?.busy ?? false;
  // 占用态守卫按面板放行表判定（busy 与 writeLocked 可同真，先按 busy 行
  // 判、busy=false 才看 writeLocked 行）：任务与面板同生命周期的面板维持
  // 「忙碌只收迟到输入、写锁只放行核实与重读」；任务与面板解耦的面板在
  // 运行中放行取消/日志/关闭/只读查看等动作。事件守卫与 DOM 禁用同表。
  if (!gatePermits(entry.options.gates ?? M2_PANEL_GATES, busy, entry.state?.writeLocked ?? false, intent)) {
    postToView(entry, {
      type: 'toast',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: entry.sessionId,
      level: 'info',
      message: strings.panel.toastBusyRejected,
    });
    return;
  }
  // 条目操作能力校验：意图引用的条目必须存在于当前状态（嵌套行递归查找）；
  // M4 意图另按稳定 ID 校验——节点在懒加载树、行在列表或表格中，避免
  // 控制器收到引用不存在节点/行的意图后再各自重复校验。
  if (entry.state) {
    const invalid =
      (intentRequiresItem(intent) && !entry.state.list?.rows.some((row) => findRow([row], intent.itemId))) ||
      (intentRequiresNode(intent) && !findLazyNode(entry.state.lazyTree?.rows, intent.nodeId)) ||
      (intentRequiresRow(intent) && !findStateRow(entry.state, intent.id));
    if (invalid) {
      return;
    }
    if (intent.kind === 'dismissBanner' && !entry.state.banners.some((banner) => banner.id === intent.bannerId)) {
      return;
    }
    if (
      intent.kind === 'bannerAction' &&
      !entry.state.banners.some((banner) => banner.id === intent.bannerId && banner.actions?.some((action) => action.id === intent.actionId))
    ) {
      return;
    }
  }
  try {
    await entry.controller.onIntent(intent, { sessionId: entry.sessionId, busy });
  } catch (err) {
    logLine(format(strings.error.failed, { message: err instanceof Error ? err.message : String(err) }), 'commit');
  }
}

function intentRequiresItem(intent: Intent): intent is Intent & { itemId: string } {
  return intent.kind === 'openDiff' || intent.kind === 'openFile' || intent.kind === 'rowMore';
}

/** 意图引用的 P5 稳定节点 ID（协议层只接受 nodeId，路径不进视图）。 */
function intentRequiresNode(intent: Intent): intent is Intent & { nodeId: string } {
  switch (intent.kind) {
    case 'toggleBrowserNode':
    case 'selectBrowserNode':
    case 'retryBrowserNode':
    case 'refreshBrowserNode':
    case 'loadMoreBrowserNode':
    case 'copyBrowserNodeUrl':
    case 'openRemoteNode':
    case 'openHistoryFromBrowser':
      return true;
    default:
      return false;
  }
}

/** 意图引用的 P6/P7 稳定行 ID（历史 revision 行、比较候选行、冲突行）。 */
function intentRequiresRow(intent: Intent): intent is Intent & { id: string } {
  switch (intent.kind) {
    case 'selectHistoryRevision':
    case 'toggleHistoryRevision':
    case 'selectCompareCandidate':
    case 'copyHistoryText':
    case 'selectConflict':
    case 'copyConflictPath':
      return true;
    default:
      return false;
  }
}

/** 懒加载树按稳定节点 ID 递归查找（只查已下发到视图的行）。 */
function findLazyNode(rows: LazyTreeRowSpec[] | undefined, nodeId: string): LazyTreeRowSpec | undefined {
  if (!rows) {
    return undefined;
  }
  for (const row of rows) {
    if (row.id === nodeId) {
      return row;
    }
    const child = findLazyNode(row.children, nodeId);
    if (child) {
      return child;
    }
  }
  return undefined;
}

/** 行 ID 在列表或表格中查找（M4 面板按数据形态二选一承载行）。 */
function findStateRow(state: PanelState, id: string): RowSpec | TableRowSpec | undefined {
  const listRow = state.list ? findRow(state.list.rows, id) : undefined;
  return listRow ?? state.table?.rows.find((row) => row.id === id);
}

/**
 * 渲染前的状态组装：携带自定义放行表的面板注入 DOM 可交互视图——
 * 同一张表求值谓词后的动作集（宿主守卫在意图送达时求值、DOM 禁用在
 * 渲染时求值，两侧同源）；未携带放行表的面板保持原状态（占用即全禁）。
 */
function renderStateOf(entry: PanelEntry, next: PanelState): PanelState {
  const gates = entry.options.gates;
  if (!gates) {
    return next;
  }
  return {
    ...next,
    gate: {
      busy: allowedActions(gates.busy),
      writeLocked: allowedActions(gates.writeLocked),
    },
  };
}

/** 测试辅助：重置面板注册表（真实宿主不需要）。 */
export function resetPanelRegistry(): void {
  for (const [panelId, entry] of panels) {
    // disposeEntry 只做宿主侧清理并置 disposed（其后再判 !disposed 恒假），
    // panel 本体必须在此显式关闭；重复 dispose 幂等无副作用。
    disposeEntry(entry, panelId);
    entry.panel.dispose();
  }
  panels.clear();
}
