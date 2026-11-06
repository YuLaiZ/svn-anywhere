/**
 * Webview 视图侧应用：只做 DOM 挂载、事件委托与消息收发。
 * 本文件打包进 media/panel.js —— 任何业务对错判断都不写在这里，
 * 也不出现面向用户的文案字面量：界面文案全部来自宿主渲染好的 HTML。
 *
 * 状态保持（技术方案 §2.1/§2.2）：
 * - 宿主推送整段 render 时，先记录输入框值、焦点、光标与列表滚动位置，
 *   替换 DOM 后按稳定 data-focus 标识恢复；
 * - 待确认的较新输入不被旧 formRevision 覆盖：本地记录每个字段最后
 *   发送的 inputRevision，宿主 render 的 formRevision 更旧时保留本地值；
 *   宿主在 ready 握手递增 viewEpoch，视图收到新代次帧即重置确认空间
 *   （webview 重建后宿主旧的大 formRevision 不会误确认新视图的输入）；
 * - 输入事件同步值与输入序号，宿主随即回推整段渲染（加入按钮、字数等
 *   派生展示随输入更新）；输入法组合期间的渲染暂存到组合结束再应用，
 *   会话切换帧清空组合态（旧控件的 compositionend 不再冒泡到根）；
 * - 快捷动作不抢占输入法组合（compositionstart..end）；
 * - 事件守卫与 DOM 禁用一致：disabled 控件不产生意图。
 */

/** acquireVsCodeApi() 提供的最小接口（测试时注入替身）。 */
export interface WebviewApi {
  postMessage(message: unknown): void;
  getState?(): unknown;
  setState?(state: unknown): void;
}

interface PendingInput {
  value: string;
  inputRevision: number;
}

export interface PanelApp {
  /** 供宿主消息通道调用（window message 事件的适配入口）。 */
  handleHostMessage(raw: unknown): void;
  dispose(): void;
}

export function mountPanel(doc: Document, api: WebviewApi): PanelApp {
  const root = doc.getElementById('app');
  if (!root) {
    return { handleHostMessage: () => {}, dispose: () => {} };
  }

  let inputSequence = 0;
  let disposed = false;
  /** 视图已发送、宿主尚未在 render 中确认的输入（防旧序号回退）。 */
  const pendingInputs = new Map<string, PendingInput>();
  const toastTimers: number[] = [];

  const send = (message: unknown): void => {
    if (!disposed) {
      api.postMessage(message);
    }
  };

  const sendIntent = (intent: Record<string, unknown>): void => {
    inputSequence += 1;
    send({
      type: 'intent',
      protocolVersion: 1,
      sessionId: currentSessionId,
      requestId: `req-${inputSequence}`,
      intent,
    });
  };

  let currentSessionId = '';
  let lastFormRevision = -1;
  /** 当前视图代次（宿主 ready 握手递增）；跨代帧到达时重置输入确认空间。 */
  let currentViewEpoch: number | null = null;
  /** 已折叠的导航目录 key（data-nav-key）；视图瞬时状态，宿主重绘后恢复。 */
  const foldedNavKeys = new Set<string>();

  /* --------------------------- 事件委托 --------------------------- */

  const onTextInput = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    if (target instanceof HTMLInputElement && target.type === 'checkbox') {
      // 勾选控件的 value 属性是静态字符串（不随勾选变化），input 委托
      // 会发出恒定值；勾选态单通道由 change 事件派生（见 onChange）。
      return;
    }
    const fieldId = target.dataset.fieldId;
    if (!fieldId || target.hasAttribute('disabled')) {
      return;
    }
    const value = 'value' in target ? String(target.value) : '';
    syncFieldValue(fieldId, value);
  };

  /** 输入同步单通道：登记待确认输入并按序号发送（文本与勾选派生值共用）。 */
  const syncFieldValue = (fieldId: string, value: string): void => {
    inputSequence += 1;
    pendingInputs.set(fieldId, { value, inputRevision: inputSequence });
    send({
      type: 'intent',
      protocolVersion: 1,
      sessionId: currentSessionId,
      requestId: `req-${inputSequence}`,
      intent: { kind: 'syncInput', fieldId, value, inputRevision: inputSequence },
    });
  };

  /** 输入法组合态：compositionstart 置位、compositionend 复位；组合期间不触发快捷动作。 */
  let isComposing = false;
  /** 组合期间暂存的最新同会话渲染（宿主输入即回推后，组合中不整段替换 DOM）。 */
  let pendingComposingRender: string | null = null;

  /**
   * 点击类意图的通用转发：按 data-intent 组装载荷，参数取自 data-* 标记。
   * 这里只做标记转发，不判断任何业务对错。
   */
  const forwardClickIntent = (holder: HTMLElement): void => {
    const intent = holder.dataset.intent;
    if (!intent) {
      return;
    }
    switch (intent) {
      case 'toggleRow':
      case 'toggleGroup':
      case 'toggleTree':
      case 'setFilter':
      case 'syncInput':
        // 复选框/下拉/表格筛选的值变化由 change 事件负责；click 只做禁用守卫。
        return;
      case 'openDiff':
      case 'openFile':
      case 'rowMore':
        sendIntent({ kind: intent, itemId: holder.dataset.itemId ?? '' });
        return;
      case 'revealFileInOS':
        sendIntent({ kind: 'revealFileInOS', rowId: holder.dataset.rowId ?? '' });
        return;
      case 'dismissBanner':
        sendIntent({ kind: 'dismissBanner', bannerId: holder.dataset.bannerId ?? '' });
        return;
      case 'bannerAction':
        sendIntent({
          kind: 'bannerAction',
          bannerId: holder.dataset.bannerId ?? '',
          actionId: holder.dataset.actionId ?? '',
        });
        return;
      case 'applyPrefix':
      case 'applyHistory':
      case 'removeRule':
      case 'selectHistoryUrl':
        sendIntent({ kind: intent, index: Number(holder.dataset.index ?? 0) });
        return;
      case 'setSort': {
        const key = holder.dataset.sortKey;
        if (key !== undefined) {
          sendIntent({
            kind: 'setSort',
            key,
            direction: holder.dataset.sortDirection === 'desc' ? 'desc' : 'asc',
          });
        }
        return;
      }
      case 'setPage': {
        const page = Number(holder.dataset.page);
        if (Number.isFinite(page)) {
          sendIntent({ kind: 'setPage', page });
        }
        return;
      }
      case 'setView':
        sendIntent({ kind: 'setView', view: holder.dataset.view === 'list' ? 'list' : 'tree' });
        return;
      default:
        // refresh/clearFilters/selectVisible/clearSelection/selectChangelist/
        // managePrefixes/showHistory/submit/closePanel/resolveUnknown/
        // addRule/fillOriginName/saveIgnore/submitIgnore 与 P3/P4 的
        // 无参动作（目录选择、校验、取消、收口、日志等）统一转发。
        sendIntent({ kind: intent });
    }
  };

  const onClick = (event: MouseEvent): void => {
    if (isComposing) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    // 导航目录折叠是视图瞬时行为，不产生意图；禁用守卫与 DOM disabled 一致。
    const toggle = target?.closest<HTMLElement>('.tree-toggle');
    if (toggle && !toggle.hasAttribute('disabled')) {
      const key = toggle.dataset.navKey;
      if (key !== undefined) {
        const folded = !foldedNavKeys.has(key);
        if (folded) {
          foldedNavKeys.add(key);
        } else {
          foldedNavKeys.delete(key);
        }
        applyFold(toggle, folded);
      }
      return;
    }
    const holder = target?.closest<HTMLElement>('[data-intent]');
    if (!holder || holder.hasAttribute('disabled') || (holder instanceof HTMLInputElement && holder.disabled)) {
      return;
    }
    forwardClickIntent(holder);
  };

  const onChange = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.hasAttribute('disabled')) {
      return;
    }
    const intent = target.dataset.intent;
    if (target instanceof HTMLInputElement) {
      // 表单勾选字段（data-field-id、无 data-intent）：勾选态唯一同步通道——
      // 由 checked 派生 'true'|'false' 走输入同步（input 委托对勾选不发送）。
      const fieldId = target.dataset.fieldId;
      if (target.type === 'checkbox' && fieldId) {
        syncFieldValue(fieldId, target.checked ? 'true' : 'false');
        return;
      }
      if (intent === 'toggleRow') {
        sendIntent({ kind: 'toggleRow', rowId: target.dataset.rowId ?? '', selected: target.checked });
        return;
      }
      if (intent === 'toggleGroup') {
        sendIntent({ kind: 'toggleGroup', groupId: target.dataset.groupId ?? '', selected: target.checked });
        return;
      }
      if (intent === 'toggleTree') {
        sendIntent({ kind: 'toggleTree', nodeId: target.dataset.nodeId ?? '', selected: target.checked });
        return;
      }
    }
    // 表格文本筛选（无 data-field-id，不进输入同步通道）与下拉筛选同走
    // setFilter：值变化即发送，宿主重算切片后整帧重推。
    if (
      intent === 'setFilter' &&
      (target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && target.type === 'text'))
    ) {
      const filterId = target.dataset.filterId;
      if (filterId !== undefined) {
        sendIntent({ kind: 'setFilter', filterId, value: target.value });
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    // Enter 快捷动作不抢占输入法组合；组合期间事件交还给输入法。
    if (event.key === 'Enter' && (isComposing || event.isComposing)) {
      event.stopPropagation();
    }
  };

  const onCompositionStart = (): void => {
    isComposing = true;
  };

  const onCompositionEnd = (event: Event): void => {
    isComposing = false;
    // 组合结束后立即同步一次最终值（部分输入法不派发 input）。
    onTextInput(event);
    // 应用组合期间暂存的最新渲染：pendingInputs 已登记组合最终值，
    // applyRender 不会回退输入内容；宿主对该次 syncInput 的回推随后收敛。
    const pending = pendingComposingRender;
    pendingComposingRender = null;
    if (pending) {
      applyRender(pending, lastFormRevision);
    }
  };

  /* --------------------------- 渲染与状态保持 --------------------------- */

  interface FocusSnapshot {
    focusKey: string | null;
    selectionStart: number | null;
    selectionEnd: number | null;
    listScroll: number;
  }

  const captureState = (): FocusSnapshot => {
    const active = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    const editing =
      active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
    return {
      focusKey: active?.dataset.focus ?? null,
      selectionStart: editing ? editing.selectionStart : null,
      selectionEnd: editing ? editing.selectionEnd : null,
      listScroll: root.querySelector<HTMLElement>('.list')?.scrollTop ?? 0,
    };
  };

  const restoreState = (snapshot: FocusSnapshot): void => {
    const list = root.querySelector<HTMLElement>('.list');
    if (list) {
      list.scrollTop = snapshot.listScroll;
    }
    if (!snapshot.focusKey) {
      return;
    }
    const next = [...root.querySelectorAll<HTMLElement>('[data-focus]')].find(
      (element) => element.dataset.focus === snapshot.focusKey,
    );
    if (!next || (next instanceof HTMLInputElement && next.disabled)) {
      return;
    }
    next.focus({ preventScroll: true });
    if (
      (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement) &&
      snapshot.selectionStart !== null &&
      snapshot.selectionEnd !== null
    ) {
      try {
        next.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
      } catch {
        // 输入类型不支持光标 API 时保持默认。
      }
    }
  };

  const applyRender = (html: string, formRevision: number): void => {
    const snapshot = captureState();
    root.innerHTML = html;
    // 视图更新的输入不回退：宿主 formRevision 落后于本地未确认输入时，
    // 保留本地值并重新对齐光标。
    for (const field of pendingInputs.keys()) {
      const pending = pendingInputs.get(field);
      if (!pending || formRevision >= pending.inputRevision) {
        pendingInputs.delete(field);
        continue;
      }
      const control = root.querySelector<HTMLElement>(`[data-field-id="${cssEscape(field)}"]`);
      if (control instanceof HTMLInputElement && control.type === 'checkbox') {
        // 勾选字段的待确认值是 'true'|'false' 派生串：恢复到 checked 态。
        control.checked = pending.value === 'true';
      } else if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
        control.value = pending.value;
      }
    }
    // 派生半选态（组头/目录聚合）：宿主只输出 data-indeterminate 标记，
    // indeterminate 属性无法用 HTML 表达，这里统一落到 DOM。
    for (const box of root.querySelectorAll<HTMLInputElement>('[data-indeterminate="1"]')) {
      box.indeterminate = true;
    }
    // 恢复导航目录的折叠状态（视图瞬时状态，不因宿主重绘丢失）。
    for (const toggle of root.querySelectorAll<HTMLElement>('.tree-toggle')) {
      const key = toggle.dataset.navKey;
      if (key !== undefined && foldedNavKeys.has(key)) {
        applyFold(toggle, true);
      }
    }
    restoreState(snapshot);
  };

  /** 应用一个导航目录的折叠/展开状态到 DOM（符号、aria 与子树显隐）。 */
  const applyFold = (toggle: HTMLElement, folded: boolean): void => {
    toggle.textContent = folded ? '▸' : '▾';
    toggle.setAttribute('aria-expanded', folded ? 'false' : 'true');
    const branch = toggle.closest('.tree-branch');
    const children = branch?.querySelector<HTMLElement>(':scope > .tree-children');
    if (children) {
      children.hidden = folded;
    }
  };

  const showToast = (level: string, message: string): void => {
    const host = doc.createElement('div');
    host.className = `toast ${level === 'error' ? 'error' : 'info'}`;
    host.setAttribute('role', 'status');
    host.textContent = message;
    root.prepend(host);
    const timer = doc.defaultView?.setTimeout(() => {
      host.remove();
    }, 4000);
    if (timer !== undefined) {
      toastTimers.push(timer);
    }
  };

  const handleHostMessage = (raw: unknown): void => {
    if (disposed || typeof raw !== 'object' || raw === null) {
      return;
    }
    const message = raw as Record<string, unknown>;
    if (message.type === 'render') {
      const nextSessionId = String(message.sessionId ?? '');
      const sessionChanged = nextSessionId !== currentSessionId;
      if (sessionChanged) {
        // 目标切换：上一会话的折叠状态不带入新目标。
        foldedNavKeys.clear();
        // 旧输入控件已随 DOM 替换，其 compositionend 不会再冒泡到根节点：
        // 清除组合态并丢弃旧会话暂存帧，新目标后续渲染照常上屏。
        isComposing = false;
        pendingComposingRender = null;
      }
      currentSessionId = nextSessionId;
      // 视图代次变化（webview 重建握手）：输入确认空间随视图重启，
      // 旧代的确认序号与未确认输入不再可比，全部重置后从新基数开始。
      const viewEpoch = Number(message.viewEpoch);
      if (Number.isFinite(viewEpoch) && viewEpoch !== currentViewEpoch) {
        currentViewEpoch = viewEpoch;
        lastFormRevision = -1;
        pendingInputs.clear();
      }
      const formRevision = Number(message.formRevision ?? -1);
      if (Number.isFinite(formRevision) && formRevision >= lastFormRevision) {
        lastFormRevision = formRevision;
      }
      if (isComposing && !sessionChanged) {
        // 组合期间整段替换 DOM 会打断输入法组合：同会话渲染只暂存最新帧，
        // compositionend 后应用；会话切换帧不暂存，避免组合中切目标丢首帧。
        pendingComposingRender = String(message.html ?? '');
        return;
      }
      applyRender(String(message.html ?? ''), lastFormRevision);
      return;
    }
    if (message.type === 'toast') {
      // 与 render 分支同口径校验会话：首帧 render 之前 currentSessionId 为空串，
      // 握手期放行避免丢首个提示；其余旧会话的迟到 toast 直接丢弃，
      // 不落入目标切换后的新会话界面。
      const messageSessionId = String(message.sessionId ?? '');
      if (currentSessionId === '' || messageSessionId === currentSessionId) {
        showToast(String(message.level ?? 'info'), String(message.message ?? ''));
      }
    }
  };

  /* --------------------------- 挂载与握手 --------------------------- */

  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onTextInput);
  root.addEventListener('keydown', onKeyDown);
  root.addEventListener('compositionstart', onCompositionStart);
  root.addEventListener('compositionend', onCompositionEnd);

  send({ type: 'ready', protocolVersion: 1 });

  return {
    handleHostMessage,
    dispose() {
      disposed = true;
      root.removeEventListener('click', onClick);
      root.removeEventListener('change', onChange);
      root.removeEventListener('input', onTextInput);
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('compositionstart', onCompositionStart);
      root.removeEventListener('compositionend', onCompositionEnd);
      for (const timer of toastTimers) {
        doc.defaultView?.clearTimeout(timer);
      }
    },
  };
}

/** 属性选择器内的特殊字符转义（字段 id 可能含任意字符）。 */
function cssEscape(value: string): string {
  const view = typeof window !== 'undefined' && typeof window.CSS !== 'undefined' && window.CSS.escape;
  if (view) {
    return view.call(window.CSS, value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}
