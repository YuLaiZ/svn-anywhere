/**
 * Webview 视图侧应用：只做 DOM 挂载、事件委托与消息收发。
 * 本文件打包进 media/panel.js —— 任何业务对错判断都不写在这里，
 * 也不出现面向用户的文案字面量：界面文案全部来自宿主渲染好的 HTML。
 *
 * 状态保持（整段渲染、增量追加与输入确认的协调口径）：
 * - 宿主推送整段 render 时，先记录输入框值、焦点、光标与全部
 *   `data-scroll-key` 容器的滚动位置（P5 树、P6/P7 左右 pane、表格与
 *   现有 .list 共用一条通道，不保留第二套列表滚动恢复），替换 DOM 后
 *   按稳定标识恢复；目标切换时丢弃旧目标的滚动记忆；
 * - P5 加载更多可走 append 增量消息：宿主只发新增切片（每次 ≤40 个节点）
 *   的已渲染片段，视图按 data-append-key 追加而不整段重绘，保持滚动与
 *   焦点；同一会话内 revision 严格更旧的 render/append 帧一律丢弃，旧
 *   回包不覆盖当前树；
 * - 待确认的较新输入不被旧 formRevision 覆盖：本地记录每个字段最后
 *   发送的 inputRevision，宿主 render 的 formRevision 更旧时保留本地值；
 *   宿主在 ready 握手递增 viewEpoch，视图收到新代次帧即重置确认空间
 *   （webview 重建后宿主旧的大 formRevision 不会误确认新视图的输入）；
 * - 筛选面板文本输入做短防抖后发送 setHistoryFilter(id, value)，select/
 *   date 变化立即提交；组合输入期间不发送中间值；
 * - 输入事件同步值与输入序号，宿主随即回推整段渲染（加入按钮、字数等
 *   派生展示随输入更新）；输入法组合期间的渲染暂存到组合结束再应用，
 *   会话切换帧清空组合态（旧控件的 compositionend 不再冒泡到根）；
 * - 快捷动作不抢占输入法组合（compositionstart..end）；
 * - toast 是纯提示：pointer-events:none 且位于页脚之前，不拦截页脚按钮；
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
  /**
   * 滚动位置快照：按 data-scroll-key 统一管理 P5 树、P6/P7 左右 pane、
   * 历史表格与现有 .list（不保留第二套列表滚动恢复）。键在同一会话内
   * 跨整段重绘保持；切换目标时清空，避免旧目标的滚动落到新目标。
   */
  const scrollPositions = new Map<string, { top: number; left: number }>();
  /** 筛选字段输入短防抖：键 = 字段 ID；值变化最终发送稳定 id/value。 */
  const filterTimers = new Map<string, number>();
  /** 防抖期间待发送的字段值：整段重绘后与宿主值不一致则丢弃（宿主权威）。 */
  const pendingFilters = new Map<string, string>();
  const FILTER_DEBOUNCE_MS = 200;

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
  /**
   * 已应用的最新界面 revision：同一会话内宿主 revision 单调递增。
   * 低于已应用值的迟到帧（旧目标缓存回包被误推等）不得覆盖当前树。
   * 目标切换时重置（新会话从较小 revision 重新计数）。
   */
  let lastAppliedRevision = -1;
  /** 当前视图代次（宿主 ready 握手递增）；跨代帧到达时重置输入确认空间。 */
  let currentViewEpoch: number | null = null;
  /** 已折叠的导航目录 key（data-nav-key）；视图瞬时状态，宿主重绘后恢复。 */
  const foldedNavKeys = new Set<string>();
  /**
   * 用户已取消的确认对话框 id（P7 树冲突确认等）：取消只做视图瞬时关闭，
   * 不发意图、不改宿主状态；同一 id 的对话框在后续整帧重绘中保持关闭，
   * 直到某一帧不再包含对话框（宿主已关闭确认）或宿主更换 id 重新请求。
   */
  let dismissedDialogId: string | null = null;
  /**
   * 冲突行状态记忆（P7）：仅用于识别 unresolved/postponed → resolved 的
   * 状态变化并播放一次撤下动效；整帧重绘后重建，会话切换清空。
   */
  const conflictRowStatuses = new Map<string, string>();

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
    // 折叠筛选文本字段：短防抖后发送 setHistoryFilter（组合期间不发中间值）。
    const filterFieldId = target.dataset.filterFieldId;
    if (filterFieldId !== undefined) {
      if (target.dataset.intent === 'setHistoryFilter' && !target.hasAttribute('disabled') && !isComposing) {
        scheduleFilterValue(filterFieldId, 'value' in target ? String(target.value) : '');
      }
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

  /**
   * 折叠筛选字段（P6）：文本输入做短防抖，select/date 变化立即提交。
   * 视图只发送稳定字段 ID 与值，不解释筛选业务条件；输入法组合期间不
   * 发送中间值（compositionend 后按最终值调度）。
   */
  const cancelFilterTimer = (fieldId: string): void => {
    const timer = filterTimers.get(fieldId);
    if (timer !== undefined) {
      doc.defaultView?.clearTimeout(timer);
      filterTimers.delete(fieldId);
    }
  };

  const flushFilterValue = (fieldId: string, value: string): void => {
    cancelFilterTimer(fieldId);
    pendingFilters.delete(fieldId);
    sendIntent({ kind: 'setHistoryFilter', id: fieldId, value });
  };

  const scheduleFilterValue = (fieldId: string, value: string): void => {
    cancelFilterTimer(fieldId);
    pendingFilters.set(fieldId, value);
    const timer = doc.defaultView?.setTimeout(() => {
      filterTimers.delete(fieldId);
      if (pendingFilters.get(fieldId) !== value) {
        return;
      }
      pendingFilters.delete(fieldId);
      sendIntent({ kind: 'setHistoryFilter', id: fieldId, value });
    }, FILTER_DEBOUNCE_MS);
    if (timer !== undefined) {
      filterTimers.set(fieldId, timer);
    }
  };

  /**
   * 面板级筛选动作（如清空筛选）是宿主权威操作：取消该面板所有待发
   * 防抖，避免迟到输入把刚清空的筛选又改回去。
   */
  const cancelFilterPanelDebounces = (panelId: string): void => {
    for (const fieldId of [...pendingFilters.keys()]) {
      const selector =
        `[data-filter-field-id="${cssEscape(fieldId)}"]` +
        `[data-filter-panel-id="${cssEscape(panelId)}"]`;
      if (root.querySelector(selector)) {
        cancelFilterTimer(fieldId);
        pendingFilters.delete(fieldId);
      }
    }
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
      case 'toggleHistoryRevision':
      case 'setFilter':
      case 'setHistoryFilter':
      case 'syncInput':
        // 复选框/下拉/表格筛选的值变化由 change 事件负责；click 只做禁用守卫。
        return;
      case 'selectBrowserNode':
      case 'toggleBrowserNode':
      case 'retryBrowserNode':
      case 'refreshBrowserNode':
      case 'loadMoreBrowserNode':
      case 'copyBrowserNodeUrl':
      case 'openRemoteNode':
      case 'openHistoryFromBrowser':
        // P5 节点动作只带稳定节点 ID；宿主映射目标与请求代次。
        sendIntent({ kind: intent, nodeId: holder.dataset.nodeId ?? '' });
        return;
      case 'selectHistoryRevision':
        // P6 行选中只更新详情，不改变勾选集合。
        sendIntent({ kind: 'selectHistoryRevision', id: holder.dataset.rowId ?? '' });
        return;
      case 'setDepthTab':
        sendIntent({ kind: intent, tab: holder.dataset.tabId ?? '' });
        return;
      case 'toggleDepthNode':
        sendIntent({ kind: intent, nodeId: holder.dataset.nodeId ?? '' });
        return;
      case 'applyDepthPreview':
        sendIntent({ kind: intent, previewId: holder.dataset.previewId ?? '' });
        return;
      case 'setConflictTab':
        // P7 分组 tab 只传 tab ID（协议字段 tab），冲突分组语义由宿主解释。
        sendIntent({ kind: 'setConflictTab', tab: holder.dataset.tabId ?? '' });
        return;
      case 'refreshHistoryUpper':
        // 枚举参数只转发稳定值（head/base-fallback）；非法值由协议层拒绝。
        sendIntent({ kind: 'refreshHistoryUpper', mode: holder.dataset.mode ?? '' });
        return;
      case 'chooseConflictVariant':
        sendIntent({ kind: 'chooseConflictVariant', value: holder.dataset.value ?? '' });
        return;
      case 'planConflictBatch': {
        // 批量策略只转发整文件枚举（theirs-full/mine-full）；非法值由协议层拒绝。
        const strategy = holder.dataset.strategy;
        sendIntent(strategy === undefined
          ? { kind: 'planConflictBatch' }
          : { kind: 'planConflictBatch', strategy });
        return;
      }
      case 'choosePropertyValue':
        // 属性逐项选择：只转发稳定属性名与枚举选择（local/base/incoming）。
        sendIntent({
          kind: 'choosePropertyValue',
          property: holder.dataset.property ?? '',
          choice: holder.dataset.choice ?? '',
        });
        return;
      case 'rescanConflicts':
        sendIntent({ kind: 'rescanConflicts', scope: holder.dataset.scope ?? '' });
        return;
      case 'openConflictVersion':
        sendIntent({ kind: 'openConflictVersion', role: holder.dataset.role ?? '' });
        return;
      case 'selectConflict':
      case 'selectCompareCandidate':
        sendIntent({
          kind: intent as 'selectConflict' | 'selectCompareCandidate',
          id: holder.dataset.rowId ?? holder.dataset.itemId ?? '',
        });
        return;
      case 'copyConflictPath':
        sendIntent({ kind: 'copyConflictPath', id: holder.dataset.rowId ?? holder.dataset.itemId ?? '' });
        return;
      case 'copyHistoryText':
        sendIntent({
          kind: 'copyHistoryText',
          copyKind: holder.dataset.copyKind ?? '',
          id: holder.dataset.rowId ?? holder.dataset.itemId ?? '',
        });
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

  /**
   * 关闭确认对话框（视图瞬时）：记住被取消的 id 并隐藏当前覆盖层。
   * 不发送意图——宿主状态（待确认动作）不变，下一次更换 id 的渲染才会
   * 再次请求确认。
   */
  const dismissDialog = (dialogId: string): void => {
    dismissedDialogId = dialogId;
    const backdrop = root.querySelector<HTMLElement>(
      `[data-confirm-dialog-id="${cssEscape(dialogId)}"]`,
    );
    if (backdrop) {
      backdrop.hidden = true;
      const focusIntent = backdrop.dataset.cancelFocusIntent;
      if (focusIntent) {
        root.querySelector<HTMLButtonElement>(
          `button[data-intent="${cssEscape(focusIntent)}"]:enabled`,
        )?.focus();
      }
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
    // P7 确认对话框取消：纯视图瞬时行为，不发意图（宿主状态不变）。
    const dismiss = target?.closest<HTMLElement>('[data-dialog-dismiss]');
    if (dismiss && !dismiss.hasAttribute('disabled')) {
      const dialogId = dismiss.dataset.dialogDismiss;
      if (dialogId) {
        dismissDialog(dialogId);
      }
      return;
    }
    const holder = target?.closest<HTMLElement>('[data-intent]');
    if (!holder || holder.hasAttribute('disabled') || (holder instanceof HTMLInputElement && holder.disabled)) {
      return;
    }
    // 面板级筛选动作（清空筛选等）优先取消该面板的待发防抖输入。
    if (holder.dataset.filterPanel !== undefined) {
      cancelFilterPanelDebounces(holder.dataset.filterPanel);
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
      if (intent === 'toggleHistoryRevision') {
        // 协议契约为 toggleHistoryRevision(id)：宿主按 id 切换，视图不回传
        // selected（勾选态以宿主渲染为准，避免两份真相）。
        sendIntent({ kind: 'toggleHistoryRevision', id: target.dataset.rowId ?? '' });
        return;
      }
    }
    // 折叠筛选的 select/date 变化：清除同字段防抖并立即提交最终值。
    if (intent === 'setHistoryFilter') {
      const filterFieldId = target.dataset.filterFieldId;
      if (filterFieldId !== undefined) {
        const value = 'value' in target ? String(target.value) : '';
        flushFilterValue(filterFieldId, value);
      }
      return;
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
    // Escape 关闭可见的确认对话框（与取消按钮同一条视图瞬时通道）。
    if (event.key === 'Escape' && !isComposing) {
      const backdrop = root.querySelector<HTMLElement>('[data-confirm-dialog-id]');
      if (backdrop && !backdrop.hidden) {
        const dialogId = backdrop.dataset.confirmDialogId;
        if (dialogId) {
          dismissDialog(dialogId);
          event.stopPropagation();
        }
      }
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
  }

  /**
   * 重绘前记录所有 data-scroll-key 容器的滚动位置（P5 树、P6/P7 左右
   * pane、历史表格与现有 .list 统一走这一条通道，不保留第二套列表滚动）。
   */
  const captureScrollPositions = (): void => {
    for (const element of root.querySelectorAll<HTMLElement>('[data-scroll-key]')) {
      const key = element.dataset.scrollKey;
      if (!key) {
        continue;
      }
      scrollPositions.set(key, { top: element.scrollTop, left: element.scrollLeft });
    }
  };

  const restoreScrollPositions = (): void => {
    for (const element of root.querySelectorAll<HTMLElement>('[data-scroll-key]')) {
      const key = element.dataset.scrollKey;
      const point = key ? scrollPositions.get(key) : undefined;
      if (!key || !point) {
        continue;
      }
      element.scrollTop = point.top;
      element.scrollLeft = point.left;
    }
  };

  const captureState = (): FocusSnapshot => {
    captureScrollPositions();
    const active = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    const editing =
      active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
    return {
      focusKey: active?.dataset.focus ?? null,
      selectionStart: editing ? editing.selectionStart : null,
      selectionEnd: editing ? editing.selectionEnd : null,
    };
  };

  const restoreState = (snapshot: FocusSnapshot): void => {
    restoreScrollPositions();
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

  /**
   * 整帧重绘后的确认对话框状态：没有对话框的帧清空取消记忆；同一 id
   * 若已被用户取消则保持关闭；新 id 或新帧正常展示并聚焦取消按钮。
   */
  const applyDialogVisibility = (): void => {
    const backdrop = root.querySelector<HTMLElement>('[data-confirm-dialog-id]');
    if (!backdrop) {
      dismissedDialogId = null;
      return;
    }
    const dialogId = backdrop.dataset.confirmDialogId ?? '';
    if (dialogId !== '' && dialogId === dismissedDialogId) {
      backdrop.hidden = true;
      return;
    }
    // 模态确认打开时焦点落在取消按钮（安全默认），避免背景控件继续输入。
    backdrop.querySelector<HTMLElement>('[data-dialog-dismiss]')?.focus?.({ preventScroll: true });
  };

  /**
   * 冲突行状态变化（P7）：整帧重绘后按行 ID 对比上一帧状态，把
   * unresolved/postponed → resolved 的行标为 just-resolved，播放一次
   * 撤下动效（行本身保留在列表中，不伪造「消失=已解决」）。
   */
  const applyConflictRowTransitions = (): void => {
    const seen = new Set<string>();
    for (const item of root.querySelectorAll<HTMLElement>('.conflict-item[data-row-id]')) {
      const rowId = item.dataset.rowId ?? '';
      const status = item.dataset.status ?? '';
      if (!rowId) {
        continue;
      }
      seen.add(rowId);
      const previous = conflictRowStatuses.get(rowId);
      if (status === 'resolved' && previous !== undefined && previous !== 'resolved') {
        item.classList.add('just-resolved');
      }
      conflictRowStatuses.set(rowId, status);
    }
    for (const rowId of [...conflictRowStatuses.keys()]) {
      if (!seen.has(rowId)) {
        conflictRowStatuses.delete(rowId);
      }
    }
  };

  const applyRender = (html: string, formRevision: number, sessionChanged = false): void => {
    const snapshot = captureState();
    if (sessionChanged) {
      // 目标切换：捕获只是为了新旧 DOM 对齐，旧目标的滚动记忆必须丢弃。
      scrollPositions.clear();
      // 旧目标的已取消确认与冲突行状态不带入新目标。
      dismissedDialogId = null;
      conflictRowStatuses.clear();
    }
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
    // 防抖窗口内的筛选文本同样以本地值为准，避免宿主较早回显覆盖用户输入；
    // 面板级清空动作会先取消 pendingFilters，不再回填。
    for (const [fieldId, value] of pendingFilters) {
      const control = root.querySelector<HTMLElement>(`[data-filter-field-id="${cssEscape(fieldId)}"]`);
      if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
        control.value = value;
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
    // P7：冲突行状态撤下动效与确认对话框的取消记忆（均在整帧替换后应用）。
    applyConflictRowTransitions();
    applyDialogVisibility();
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
    // 纯提示不拦截鼠标：pointer-events:none 让页脚主按钮等下层控件立即可点；
    // 元素放在页脚之前的文档流里，提示出现在页脚上方且不遮挡按钮命中区。
    host.style.pointerEvents = 'none';
    const footer = root.querySelector<HTMLElement>('.footer');
    if (footer?.parentElement) {
      footer.parentElement.insertBefore(host, footer);
    } else {
      root.prepend(host);
    }
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
        // 目标切换：上一会话的折叠状态与待发筛选值不带入新目标
        // （滚动记忆在 applyRender 捕获旧 DOM 后清空）；新会话 revision
        // 从较小值重新计数，旧会话的已应用 revision 不再可比。
        foldedNavKeys.clear();
        lastAppliedRevision = -1;
        for (const timer of filterTimers.values()) {
          doc.defaultView?.clearTimeout(timer);
        }
        filterTimers.clear();
        // 待发筛选值（防抖窗口内的本地输入）同属旧目标：只清定时器会让
        // 值留在 pendingFilters，下一次整帧渲染按字段 ID 回填到新目标。
        pendingFilters.clear();
        // 旧输入控件已随 DOM 替换，其 compositionend 不会再冒泡到根节点：
        // 清除组合态并丢弃旧会话暂存帧，新目标后续渲染照常上屏。
        isComposing = false;
        pendingComposingRender = null;
      }
      // 旧帧防护（P5 树刷新/取消补全的迟到回包）：同一会话内 revision
      // 单调递增，严格更旧的帧不得覆盖已渲染的当前树与详情。
      const revision = Number(message.revision);
      if (Number.isFinite(revision)) {
        if (revision < lastAppliedRevision) {
          return;
        }
        lastAppliedRevision = Math.max(lastAppliedRevision, revision);
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
      applyRender(String(message.html ?? ''), lastFormRevision, sessionChanged);
      return;
    }
    if (message.type === 'append') {
      // 增量追加：宿主只发新增切片（P5 每次 ≤40 个节点、P6 每次
      // ≤historyPageSize 行）的已渲染片段，视图按 `data-append-key` 定位
      // 目标容器后追加，不重建整棵树/整张表、不打断滚动位置、焦点与输入法。
      // 容器只有两族：P5 节点子行容器（.tree-node-children）与 P6 历史
      // 表格 tbody；目标切换后的旧 append 与更旧 revision 的迟到帧一律
      // 丢弃；容器不存在（已重绘为另一目标/形状）也丢弃。
      const messageSessionId = String(message.sessionId ?? '');
      if (currentSessionId === '' || messageSessionId !== currentSessionId) {
        return;
      }
      const revision = Number(message.revision);
      if (Number.isFinite(revision)) {
        if (revision < lastAppliedRevision) {
          return;
        }
        lastAppliedRevision = Math.max(lastAppliedRevision, revision);
      }
      const target = String(message.target ?? '');
      const html = String(message.html ?? '');
      if (!target || !html) {
        return;
      }
      // 只追加到节点的子行容器或历史表格 tbody；不能回退到树顶层
      // .tree-rows，也不能把行追加到表格之外的任意容器。
      const container = root.querySelector<HTMLElement>(
        `.tree-node-children[data-append-key="${cssEscape(target)}"], tbody[data-append-key="${cssEscape(target)}"]`,
      );
      if (!container) {
        return;
      }
      container.insertAdjacentHTML('beforeend', html);
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
      for (const timer of filterTimers.values()) {
        doc.defaultView?.clearTimeout(timer);
      }
      filterTimers.clear();
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
