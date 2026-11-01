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
import type { PanelState } from './state';
import { findRow } from './state';
import { render } from './view';

export interface PanelController {
  /** 视图意图通过全部校验后转发给控制器；路径映射等业务决策在控制器内。 */
  onIntent(intent: Intent, context: IntentContext): void | Promise<void>;
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
}

interface PanelEntry {
  panel: vscode.WebviewPanel;
  controller: PanelController;
  options: PanelEntryOptions;
  /** 当前会话代次：目标切换即更换。 */
  sessionId: string;
  state: PanelState | undefined;
  revision: number;
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
  /** 推送瞬时提示。 */
  toast(level: 'info' | 'error', message: string): void;
  /** 切换目标：生成新会话代次；忙碌时返回 undefined 并提示。 */
  switchSession(): string | undefined;
  reveal(): void;
  dispose(): void;
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
      entry.state = next;
      entry.revision += 1;
      postToView(entry, {
        type: 'render',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: entry.sessionId,
        revision: entry.revision,
        formRevision: next.formRevision,
        html: render({ ...next, revision: entry.revision }),
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
    switchSession() {
      if (entry.disposed) {
        return newSessionId();
      }
      if (entry.state?.busy) {
        return undefined;
      }
      entry.sessionId = newSessionId();
      entry.handledRequests.clear();
      entry.revision = 0;
      return entry.sessionId;
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
    if (entry.state) {
      entry.revision += 1;
      postToView(entry, {
        type: 'render',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: entry.sessionId,
        revision: entry.revision,
        formRevision: entry.state.formRevision,
        html: render({ ...entry.state, revision: entry.revision }),
      });
    }
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
  if (busy && intent.kind !== 'syncInput') {
    // 写意图在忙碌期间拒绝：事件守卫与 DOM 禁用保持一致。
    postToView(entry, {
      type: 'toast',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: entry.sessionId,
      level: 'info',
      message: strings.panel.toastBusyRejected,
    });
    return;
  }
  if (!busy && entry.state?.writeLocked && intent.kind !== 'resolveUnknown' && intent.kind !== 'refresh') {
    // 结果未知/待核实等写锁定期间，连同输入同步在内的全部写意图都被拒绝；
    // 只放行核实/恢复与重读动作（由控制器自行分发）。
    postToView(entry, {
      type: 'toast',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: entry.sessionId,
      level: 'info',
      message: strings.panel.toastBusyRejected,
    });
    return;
  }
  // 条目操作能力校验：意图引用的条目必须存在于当前状态（嵌套行递归查找）。
  if (entry.state) {
    const invalid =
      intentRequiresItem(intent) && !entry.state.list?.rows.some((row) => findRow([row], intent.itemId));
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

/** 测试辅助：重置面板注册表（真实宿主不需要）。 */
export function resetPanelRegistry(): void {
  for (const [panelId, entry] of panels) {
    disposeEntry(entry, panelId);
    if (!entry.disposed) {
      entry.panel.dispose();
    }
  }
  panels.clear();
}
