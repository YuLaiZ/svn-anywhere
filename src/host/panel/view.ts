/**
 * state → HTML 字符串的纯渲染函数。不依赖 vscode；文案全部来自 i18n.ts。
 *
 * DOM 结构与 class 命名沿用交互原型的信息层级（panel-header / banners /
 * filter-bar / message-block / list / row / footer / progress …），不另起结构。
 * 交互标记统一用 data-intent + data-* 参数：视图侧事件委托据此转发意图，
 * 禁止内联 onclick；意图里只有条目 ID 等稳定标识，没有路径。
 *
 * 树形渲染（P1）：导航目录节点只组织路径（聚合勾选作用于筛选后子树，
 * 展开折叠是视图瞬时状态）；目录条目行（属性/待添加/待删除目录等）是
 * 独立可选行。组的计数与半选态、导航聚合态都在渲染时从 rows+filters
 * 派生，不保留第二份真相。
 *
 * 转义规则：所有进入文本与属性上下文的动态值（路径、状态原词、说明、
 * stderr 等）都经 escapeHtml（覆盖属性上下文需要的引号转义）。
 */
import { format, strings } from '../i18n';
import { STATUS_LETTERS } from './fixture';
import {
  collectLeafRows,
  rowMatchesFilters,
  visibleRows,
  type ActionSpec,
  type BannerSpec,
  type FilterSpec,
  type ListSpec,
  type PanelState,
  type RowSpec,
} from './state';

/** 文本与属性上下文共用的转义（属性值统一用双引号包裹）。 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 面板整体 HTML（.panel 容器内；宿主骨架只包 #app 挂载点）。 */
export function render(state: PanelState): string {
  const busy = state.busy;
  const locked = busy || (state.writeLocked ?? false);
  const parts: string[] = [
    `<header class="panel-header">`,
    `<span class="panel-title">${escapeHtml(state.title)}</span>`,
    `<span class="panel-target" title="${escapeHtml(state.targetLabel)}">${escapeHtml(state.targetLabel)}</span>`,
    `<span class="spacer"></span>`,
    renderHeaderBadges(state),
    `<span class="counts">${escapeHtml(renderCounts(state))}</span>`,
    renderHeaderActions(state),
    `</header>`,
    renderSteps(state),
    renderSuccessCard(state),
    state.hint ? `<div class="hint">${escapeHtml(state.hint)}</div>` : '',
    renderBanners(state.banners),
  ];
  if (state.form) {
    parts.push(renderForm(state, locked));
  }
  if (state.table) {
    parts.push(renderTable(state));
  }
  if (state.list) {
    parts.push(renderFilterBar(state, locked));
    parts.push(renderSelectionBar(state, locked));
    parts.push(renderList(state, locked));
  }
  if (state.ignoreEditor) {
    parts.push(renderIgnoreEditor(state.ignoreEditor));
  }
  parts.push(renderFooter(state, locked));
  if (busy) {
    parts.push('<div class="progress" role="status" aria-label="busy"><i></i></div>');
  }
  return `<main class="panel" data-busy="${busy ? '1' : '0'}" data-revision="${state.revision}">${parts.join('')}</main>`;
}

/**
 * 占用态下通用控件的禁用判定：与宿主守卫同一放行表推导（经
 * PanelState.gate 传入求值后的动作集）。未携带放行视图的面板保持
 * 「占用即全禁」的现状——守卫放行迟到输入不代表 DOM 解禁输入控件；
 * 携带视图的面板只禁用表中未放行的动作，避免「可点被拒」的假可用。
 */
function actionGated(state: PanelState, action: string): boolean {
  if (!state.busy && !(state.writeLocked ?? false)) {
    return false;
  }
  const gate = state.gate;
  if (!gate) {
    return true;
  }
  const allowed = state.busy ? gate.busy : gate.writeLocked;
  return !allowed.includes(action);
}

/** 标题区状态徽标（P2：未保存/待提交/待核实/待协调等）。 */
function renderHeaderBadges(state: PanelState): string {
  return (state.headerBadges ?? [])
    .map((badge) => `<span class="badge${badge.warn ? ' warn' : ''}">${escapeHtml(badge.text)}</span>`)
    .join('');
}

/** 标题区动作（P2「重新读取」、P3「日志」等；占用态按放行视图禁用）。 */
function renderHeaderActions(state: PanelState): string {
  return (state.headerActions ?? [])
    .map((action) => {
      const disabled = actionGated(state, action.id) || action.disabled ? ' disabled' : '';
      const title = action.disabledReason ?? action.label;
      return `<button type="button" class="link" data-intent="${escapeHtml(action.id)}" data-focus="header-${escapeHtml(action.id)}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"${disabled}>${escapeHtml(action.label)}</button>`;
    })
    .join('');
}

/** 向导步骤条：当前步高亮、已过步弱化；labels 与 current 由宿主维护。 */
function renderSteps(state: PanelState): string {
  const steps = state.steps;
  if (!steps || steps.labels.length === 0) {
    return '';
  }
  const items = steps.labels.map((label, index) => {
    const stage = index < steps.current ? ' done' : index === steps.current ? ' current' : '';
    return `<li class="step${stage}"><span class="step-index" aria-hidden="true">${index + 1}</span><span class="step-label">${escapeHtml(label)}</span></li>`;
  });
  return `<ol class="steps" role="list">${items.join('')}</ol>`;
}

function renderCounts(state: PanelState): string {
  const selection = state.list?.selection;
  const counts = selection
    ? format(strings.panel.countsSelected, { selected: String(selection.visible), total: String(selection.total) })
    : '';
  const hidden = selection && selection.hidden > 0
    ? format(strings.panel.countsHidden, { count: String(selection.hidden) })
    : '';
  return counts + hidden;
}

/** 成功卡片：level=success 的 banner 用独立卡片样式（标题区下方、可收起）。
 *  detail 含换行时按多段渲染（P2 提交卡片需同时说明范围与保留项）。 */
function renderSuccessCard(state: PanelState): string {
  const success = state.banners.find((banner) => banner.id === 'commitSuccess' && banner.level === 'success');
  if (!success) {
    return '';
  }
  const detailHtml = (success.detail ?? '')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('');
  const dismissLabel = strings.panel.dismiss;
  return (
    `<section class="success-card" role="status" aria-live="polite">` +
    `<span class="success-icon" aria-hidden="true">✓</span>` +
    `<div class="success-content"><strong>${escapeHtml(success.title)}</strong>` +
    detailHtml +
    `</div>` +
    `<button type="button" class="dismiss-success" data-intent="dismissBanner" data-banner-id="${escapeHtml(success.id)}" aria-label="${escapeHtml(dismissLabel)}" title="${escapeHtml(dismissLabel)}" ${lockedDisabled(state.busy || (state.writeLocked ?? false))}>×</button>` +
    `</section>`
  );
}

function renderBanners(banners: BannerSpec[]): string {
  const rest = banners.filter((banner) => !(banner.id === 'commitSuccess' && banner.level === 'success'));
  if (rest.length === 0) {
    return '';
  }
  const items = rest.map((banner) => renderBanner(banner));
  return `<div class="banners">${items.join('')}</div>`;
}

function renderBanner(banner: BannerSpec): string {
  const detailHtml = !banner.detail
    ? ''
    : banner.preformatted
      ? `<pre>${escapeHtml(banner.detail)}</pre>`
      : `<p>${escapeHtml(banner.detail)}</p>`;
  const actionsHtml = (banner.actions ?? [])
    .map((action) => renderActionButton(action, {
      intent: 'bannerAction',
      argName: 'data-banner-id',
      argValue: banner.id,
      extraId: action.id,
    }))
    .join('');
  const dismissLabel = strings.panel.dismiss;
  // dismissable:false 的横幅不渲染 ×（判定性持久提示，无关闭需求）；
  // 其余横幅保持默认渲染（M2 既有行为不变）。
  const dismissHtml = banner.dismissable === false
    ? ''
    : [
      '<button type="button" class="row-act" data-intent="dismissBanner"',
      ` data-banner-id="${escapeHtml(banner.id)}"`,
      ` aria-label="${escapeHtml(dismissLabel)}" title="${escapeHtml(dismissLabel)}">×</button>`,
    ].join('');
  const role = banner.level === 'error' ? 'alert' : 'status';
  return [
    `<div class="banner ${escapeHtml(banner.level)}" role="${role}">`,
    '<div class="banner-body">',
    `<b>${escapeHtml(banner.title)}</b>`,
    detailHtml,
    actionsHtml,
    '</div>',
    dismissHtml,
    '</div>',
  ].join('');
}

function lockedDisabled(locked: boolean): string {
  return locked ? ' disabled' : '';
}

/**
 * P2 规则编辑区：规则列表（.rules/.rule-row，含行内移除）与待加入输入
 * （.add-area：输入 + 加入 + 用当前项名）分开；DOM 结构沿用原型基线。
 */
function renderIgnoreEditor(editor: NonNullable<PanelState['ignoreEditor']>): string {
  const locked = editor.busy ?? false;
  const listHtml = editor.rules.length > 0
    ? `<div class="rules" aria-label="${escapeHtml(editor.listLabel)}">` +
      editor.rules.map((rule) =>
        `<div class="rule-row">` +
        `<span class="rule-text">${escapeHtml(rule.text)}</span>` +
        `<button type="button" class="row-act" data-intent="removeRule" data-index="${rule.index}" data-focus="remove-${rule.index}" aria-label="${escapeHtml(format(strings.ignorePanel.ignoreRemoveRule, { rule: rule.text }))}" title="${escapeHtml(editor.removeLabel)}"${locked ? ' disabled' : ''}>${escapeHtml(editor.removeLabel)}</button>` +
        `</div>`,
      ).join('') +
      `</div>`
    : `<div class="empty"><h3>${escapeHtml(editor.empty.title)}</h3>` +
      (editor.empty.detail ? `<p class="muted">${escapeHtml(editor.empty.detail)}</p>` : '') +
      (editor.empty.extra ? `<p class="muted">${escapeHtml(editor.empty.extra)}</p>` : '') +
      `</div>`;
  const draft = editor.draft;
  const draftDisabled = locked || draft.disabled ? ' disabled' : '';
  const fillHtml = editor.fillAction
    ? `<button type="button" data-intent="fillOriginName" title="${escapeHtml(editor.fillAction.disabledReason ?? editor.fillAction.label)}"${editor.fillAction.disabled || locked ? ' disabled' : ''}>${escapeHtml(editor.fillAction.label)}</button>`
    : '';
  const originNote = editor.originNote ?? editor.noOriginNote ?? '';
  return (
    `${listHtml}` +
    `<section class="add-area">` +
    `<div class="add-row">` +
    `<label for="field-${escapeHtml(draft.fieldId)}">${escapeHtml(draft.label)}</label>` +
    `<input type="text" id="field-${escapeHtml(draft.fieldId)}" data-field-id="${escapeHtml(draft.fieldId)}" data-focus="field-${escapeHtml(draft.fieldId)}" placeholder="${escapeHtml(draft.placeholder)}" value="${escapeHtml(draft.value)}" aria-describedby="add-note"${draftDisabled}>` +
    `<button type="button" data-intent="addRule" title="${escapeHtml(editor.addAction.disabledReason ?? editor.addAction.label)}" data-focus="add-rule"${editor.addAction.disabled || locked ? ' disabled' : ''}>${escapeHtml(editor.addAction.label)}</button>` +
    fillHtml +
    `</div>` +
    `<div id="add-note" class="add-note">${escapeHtml(editor.addNote)}${originNote ? `<br>${escapeHtml(originNote)}` : ''}</div>` +
    `</section>`
  );
}

function renderForm(state: PanelState, locked: boolean): string {
  const form = state.form;
  if (!form) {
    return '';
  }
  const fields = form.fields.map((field) => {
    const disabled = actionGated(state, 'syncInput') || field.disabled ? ' disabled' : '';
    const common = `data-field-id="${escapeHtml(field.id)}" data-focus="field-${escapeHtml(field.id)}" id="field-${escapeHtml(field.id)}"`;
    let control: string;
    let fieldHtml: string;
    if (field.type === 'textarea') {
      const placeholder = field.help ? ` placeholder="${escapeHtml(field.help)}"` : '';
      control = `<textarea class="message-input" rows="4"${placeholder} ${common}${disabled} aria-label="${escapeHtml(field.label)}">${escapeHtml(field.value)}</textarea>`;
      fieldHtml = `<div class="message-row"><label class="message-label" for="field-${escapeHtml(field.id)}">${escapeHtml(field.label)}</label></div>${control}`;
    } else if (field.type === 'select') {
      const options = (field.options ?? []).map((option) =>
        `<option value="${escapeHtml(option.value)}"${option.value === field.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`,
      ).join('');
      control = `<select ${common}${disabled} aria-label="${escapeHtml(field.label)}">${options}</select>`;
      fieldHtml = `<div class="message-row"><label class="message-label" for="field-${escapeHtml(field.id)}">${escapeHtml(field.label)}</label></div>${control}`;
    } else if (field.type === 'checkbox') {
      // 勾选态由 value 派生（'true' 即勾选）；勾选变化经 change 事件走
      // 输入同步通道（视图侧单通道派生 'true'|'false'，不经 input 委托）。
      control = `<input type="checkbox" ${common}${field.value === 'true' ? ' checked' : ''}${disabled} aria-label="${escapeHtml(field.label)}">`;
      fieldHtml = `<div class="check-field">${control}<label class="message-label" for="field-${escapeHtml(field.id)}">${escapeHtml(field.label)}</label></div>`;
    } else {
      control = `<input type="text" value="${escapeHtml(field.value)}" ${common}${disabled} aria-label="${escapeHtml(field.label)}">`;
      fieldHtml = `<div class="message-row"><label class="message-label" for="field-${escapeHtml(field.id)}">${escapeHtml(field.label)}</label></div>${control}`;
    }
    const help = field.type !== 'textarea' && field.help ? `<p class="muted">${escapeHtml(field.help)}</p>` : '';
    const error = field.error ? `<p class="field-error">${escapeHtml(field.error)}</p>` : '';
    return fieldHtml + help + error;
  });
  const tools = (form.tools ?? [])
    .map((tool) => {
      const disabled = locked || tool.disabled ? ' disabled' : '';
      const title = tool.disabledReason ?? tool.label;
      const payload = Object.entries(tool.payload ?? {})
        .map(([key, value]) => ` data-${escapeHtml(key)}="${escapeHtml(value)}"`)
        .join('');
      return `<button type="button" class="chip" data-intent="${escapeHtml(tool.id)}"${payload} data-focus="tool-${escapeHtml(tool.id)}-${tool.payload?.index ?? ''}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"${disabled}>${escapeHtml(tool.label)}</button>`;
    })
    .join('');
  const toolsBar = tools ? `<div class="message-tools">${tools}</div>` : '';
  return `<section class="message-block">${fields.join('')}${toolsBar}</section>`;
}

/**
 * 表格：宿主已完成排序/筛选/分页切片，这里只渲染当前页。通用控件
 * （排序头、筛选、翻页）在占用态按放行视图禁用——扫描或清理进行中
 * 表格仍可交互的形态由面板放行表表达；行内动作意图只带行 ID。
 * 窄面板时容器横向滚动（.table-scroll），页面本身不横向溢出。
 */
function renderTable(state: PanelState): string {
  const table = state.table;
  if (!table) {
    return '';
  }
  const { columns, sort, pagination } = table;
  const filters = table.filters ?? [];
  const filterBar = filters.length > 0
    ? `<div class="table-filter-bar">${filters.map((filter) => {
        if (filter.kind === 'text') {
          return `<label class="table-filter text"><span>${escapeHtml(filterLabel(filter.id))}</span>` +
            `<input type="text" data-intent="setFilter" data-filter-id="${escapeHtml(filter.id)}" data-focus="table-filter-${escapeHtml(filter.id)}" value="${escapeHtml(filter.value)}"${lockedDisabled(actionGated(state, 'setFilter'))}></label>`;
        }
        const options = (filter.options ?? []).map((option) =>
          `<option value="${escapeHtml(option.value)}"${option.value === filter.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`,
        ).join('');
        return `<label class="table-filter"><span>${escapeHtml(filterLabel(filter.id))}</span>` +
          `<select data-intent="setFilter" data-filter-id="${escapeHtml(filter.id)}" data-focus="table-filter-${escapeHtml(filter.id)}"${lockedDisabled(actionGated(state, 'setFilter'))}>${options}</select></label>`;
      }).join('')}</div>`
    : '';
  if (table.rows.length === 0) {
    const filterActive = filters.some((filter) => (filter.kind === 'select' ? filter.value !== 'all' : filter.value !== ''));
    const empty = filterActive
      ? (table.filterEmpty ?? { title: strings.panel.filterEmptyTitle })
      : table.empty;
    const emptyNote = table.note ? `<p class="muted table-note">${escapeHtml(table.note)}</p>` : '';
    return `<section class="table-block" data-table-id="${escapeHtml(table.id)}">${filterBar}` +
      `<div class="empty"><h3>${escapeHtml(empty.title)}</h3>${empty.detail ? `<p class="muted">${escapeHtml(empty.detail)}</p>` : ''}</div>${emptyNote}</section>`;
  }
  const headCells = columns.map((column) => {
    const align = column.align ? ` align-${column.align}` : '';
    if (!column.sortable) {
      return `<th class="col${align}" scope="col">${escapeHtml(column.label)}</th>`;
    }
    const isCurrent = sort.key === column.key;
    // 点击后目标方向：当前列翻转、其余列从升序开始。
    const nextDirection = isCurrent && sort.direction === 'asc' ? 'desc' : 'asc';
    const indicator = isCurrent ? `<span class="sort-indicator" aria-hidden="true">${sort.direction === 'asc' ? '↑' : '↓'}</span>` : '';
    const ariaLabel = format(
      nextDirection === 'asc' ? strings.panel.sortAscLabel : strings.panel.sortDescLabel,
      { label: column.label },
    );
    return `<th class="col${align}" scope="col">` +
      `<button type="button" class="th-sort${isCurrent ? ' active' : ''}" data-intent="setSort" data-sort-key="${escapeHtml(column.key)}" data-sort-direction="${nextDirection}" data-focus="table-sort-${escapeHtml(column.key)}" aria-label="${escapeHtml(ariaLabel)}"${lockedDisabled(actionGated(state, 'setSort'))}>` +
      `${escapeHtml(column.label)}${indicator}</button></th>`;
  }).join('');
  const bodyRows = table.rows.map((row) => {
    const cells = columns.map((column) => {
      const align = column.align ? ` align-${column.align}` : '';
      const text = row.cells[column.key] ?? '';
      return `<td class="col${align}">${escapeHtml(text)}</td>`;
    }).join('');
    const actions = (row.actions ?? []).map((action) =>
      renderActionButton(action, {
        intent: action.id,
        argName: 'data-row-id',
        argValue: row.id,
        extraId: '',
        gated: actionGated(state, action.id),
      }),
    ).join('');
    return `<tr data-row-id="${escapeHtml(row.id)}">${cells}${actions ? `<td class="col acts">${actions}</td>` : ''}</tr>`;
  }).join('');
  const hasPrev = pagination.page > 1;
  const hasNext = pagination.page < pagination.pageCount;
  const pager = pagination.pageCount > 1
    ? `<div class="table-pager">` +
      `<button type="button" class="link" data-intent="setPage" data-page="${pagination.page - 1}" data-focus="table-page-prev"${!hasPrev || actionGated(state, 'setPage') ? ' disabled' : ''}>${escapeHtml(strings.panel.pagerPrev)}</button>` +
      `<span class="summary">${escapeHtml(format(strings.panel.pagerSummary, { page: String(pagination.page), pageCount: String(pagination.pageCount), total: String(pagination.total) }))}</span>` +
      `<button type="button" class="link" data-intent="setPage" data-page="${pagination.page + 1}" data-focus="table-page-next"${!hasNext || actionGated(state, 'setPage') ? ' disabled' : ''}>${escapeHtml(strings.panel.pagerNext)}</button>` +
      `</div>`
    : '';
  const note = table.note ? `<p class="muted table-note">${escapeHtml(table.note)}</p>` : '';
  return `<section class="table-block" data-table-id="${escapeHtml(table.id)}">${filterBar}` +
    `<div class="table-scroll"><table class="data-table">` +
    `<thead><tr>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>${pager}${note}</section>`;
}

function renderFilterBar(state: PanelState, locked: boolean): string {
  const list = state.list;
  if (!list) {
    return '';
  }
  const parts: string[] = [];
  if (list.viewMode) {
    const treePressed = list.viewMode === 'tree';
    parts.push(
      `<span class="view-switch" role="group" aria-label="${escapeHtml(strings.panel.viewSwitchLabel)}">` +
      `<button type="button" data-intent="setView" data-view="tree" aria-pressed="${treePressed}"${lockedDisabled(locked)}>${escapeHtml(strings.panel.viewTree)}</button>` +
      `<button type="button" data-intent="setView" data-view="list" aria-pressed="${!treePressed}"${lockedDisabled(locked)}>${escapeHtml(strings.panel.viewList)}</button>` +
      `</span>`,
    );
  }
  const selects = (list.filters ?? []).map((filter) => {
    const options = filter.options.map((option) =>
      `<option value="${escapeHtml(option.value)}"${option.value === filter.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`,
    ).join('');
    return `<label class="filter"><span>${escapeHtml(filterLabel(filter.id))}</span><select data-intent="setFilter" data-filter-id="${escapeHtml(filter.id)}" data-focus="filter-${escapeHtml(filter.id)}"${lockedDisabled(locked)}>${options}</select></label>`;
  });
  parts.push(...selects);
  const totalLeaves = collectLeafRows(list.rows).length;
  const visibleLeaves = visibleRows(list.rows, list.filters).length;
  const hasFilter = (list.filters ?? []).some((filter) => filter.value !== 'all');
  if (hasFilter) {
    parts.push(
      `<span class="filter-right"><span class="summary">${escapeHtml(format(strings.panel.showCount, { visible: String(visibleLeaves), total: String(totalLeaves) }))}</span>` +
      `<button type="button" class="link" data-intent="clearFilters"${lockedDisabled(locked)}>${escapeHtml(strings.panel.clearFilter)}</button></span>`,
    );
  }
  return `<div class="filter-bar">${parts.join('')}</div>`;
}

function filterLabel(filterId: string): string {
  if (filterId === 'status') {
    return strings.panel.filterStatus;
  }
  if (filterId === 'ext') {
    return strings.panel.filterExt;
  }
  if (filterId === 'changelist') {
    return strings.panel.filterChangelist;
  }
  return filterId;
}

/** 选择工具条：全局已选计数（含筛选隐藏提示）+ 选择可见/清空/整组选择动作。 */
function renderSelectionBar(state: PanelState, locked: boolean): string {
  const list = state.list;
  if (!list?.selectionActions || list.rows.length === 0) {
    return '';
  }
  const selection = list.selection;
  const hiddenPart = selection.hidden > 0
    ? format(strings.panel.hiddenSelected, { count: String(selection.hidden) })
    : '';
  const summary = format(strings.panel.selectedCount, { count: String(selection.total) }) + hiddenPart;
  const actions = list.selectionActions
    .map((action) => renderActionButton(action, { intent: action.id, argName: 'data-selection', argValue: action.id, extraId: '' }))
    .join('');
  return `<div class="selection-bar"><span>${escapeHtml(summary)}</span>${actions}</div>`;
}

function renderList(state: PanelState, locked: boolean): string {
  const list = state.list;
  if (!list) {
    return '';
  }
  const leaves = collectLeafRows(list.rows);
  if (leaves.length === 0) {
    const empty = list.empty;
    const action = empty.action ? renderActionButton(empty.action, { intent: empty.action.id, argName: 'data-empty', argValue: '1', extraId: '' }) : '';
    return `<div class="empty"><h3>${escapeHtml(empty.title)}</h3>${empty.detail ? `<p class="muted">${escapeHtml(empty.detail)}</p>` : ''}${action}</div>`;
  }
  const visible = visibleRows(list.rows, list.filters);
  if (visible.length === 0) {
    const empty = list.filterEmpty ?? { title: strings.panel.filterEmptyTitle };
    const action = empty.action ? renderActionButton(empty.action, { intent: empty.action.id, argName: 'data-empty', argValue: '1', extraId: '' }) : '';
    return `<div class="empty"><h3>${escapeHtml(empty.title)}</h3>${empty.detail ? `<p class="muted">${escapeHtml(empty.detail)}</p>` : ''}${action}</div>`;
  }
  const groups = list.groups ?? [{ id: '', label: '' }];
  const body = groups
    .map((group) => renderGroup(list, group.id, group.label, locked))
    .filter((chunk) => chunk !== '')
    .join('');
  return `<div class="list" data-focus="list" role="list">${body}</div>`;
}

/** 渲染一个分组：组头（派生半选态）+ 组内行（树形嵌套或平铺）。 */
function renderGroup(list: ListSpec, groupId: string, groupLabel: string, locked: boolean): string {
  const tree = list.viewMode !== 'list';
  const rows = tree
    ? list.rows.filter((row) => groupMatches(row, groupId))
    : collectLeafRows(list.rows.filter((row) => groupMatches(row, groupId)));
  if (rows.length === 0) {
    return '';
  }
  const visibleInGroup = visibleRows(list.rows, list.filters).filter((row) => row.group === groupId);
  const eligible = visibleInGroup.filter((row) => !row.disabled);
  const selectedCount = eligible.filter((row) => row.selected).length;
  const head =
    groupId === '' && !groupLabel
      ? ''
      : renderGroupHead(groupId, groupLabel, visibleInGroup.length, eligible, selectedCount, locked);
  const body = tree
    ? renderTreeNodes(rows, list.filters, 0, locked)
    : rows.map((row) => renderRow(row, locked, false, 0)).join('');
  return head + body;
}

function groupMatches(row: RowSpec, groupId: string): boolean {
  if (row.nav) {
    // 导航节点归属由其子树决定；构建时导航节点 id 带 groupId 前缀。
    return groupId === '' || row.id.startsWith(`${groupId}|`);
  }
  return row.group === groupId || (groupId === '' && row.group === undefined);
}

function renderGroupHead(
  groupId: string,
  label: string,
  count: number,
  eligible: RowSpec[],
  selectedCount: number,
  locked: boolean,
): string {
  const disabled = locked || eligible.length === 0;
  const checked = eligible.length > 0 && selectedCount === eligible.length;
  const indeterminate = selectedCount > 0 && selectedCount < eligible.length;
  const selectLabel = format(strings.panel.groupSelectLabel, { label });
  const countText = eligible.length
    ? format(strings.panel.groupCountSelected, { count: String(count), selected: String(selectedCount) })
    : format(strings.panel.groupCountViewOnly, { count: String(count) });
  return (
    `<div class="group-head">` +
    `<label><input type="checkbox" data-intent="toggleGroup" data-group-id="${escapeHtml(groupId)}" data-focus="group-${escapeHtml(groupId)}" aria-label="${escapeHtml(selectLabel)}"${checked ? ' checked' : ''}${indeterminate ? ' data-indeterminate="1"' : ''}${lockedDisabled(disabled)}>` +
    `<span>${escapeHtml(label)}</span></label><span class="num">${escapeHtml(countText)}</span></div>`
  );
}

/** 树形渲染：导航目录节点 + 条目行；导航节点仅在有命中后代时保留。 */
function renderTreeNodes(rows: RowSpec[], filters: FilterSpec[] | undefined, level: number, locked: boolean): string {
  const chunks: string[] = [];
  for (const row of rows) {
    if (row.nav) {
      const visibleLeaves = visibleRows(row.children ?? [], filters).filter((leaf) => !leaf.nav);
      if (visibleLeaves.length === 0) {
        continue;
      }
      const eligible = visibleLeaves.filter((leaf) => !leaf.disabled);
      const selectedCount = eligible.filter((leaf) => leaf.selected).length;
      const checked = eligible.length > 0 && selectedCount === eligible.length;
      const indeterminate = selectedCount > 0 && selectedCount < eligible.length;
      const selectLabel = format(strings.panel.treeSelectLabel, { path: row.nav.path });
      const foldLabel = format(strings.panel.treeFoldLabel, { path: row.nav.path });
      const countText = `${selectedCount} / ${eligible.length}`;
      chunks.push(
        `<div class="tree-branch">` +
        `<div class="tree-folder" style="padding-left:${12 + level * 16}px">` +
        `<input type="checkbox" data-intent="toggleTree" data-node-id="${escapeHtml(row.id)}" data-focus="tree-select-${escapeHtml(row.id)}" aria-label="${escapeHtml(selectLabel)}"${checked ? ' checked' : ''}${indeterminate ? ' data-indeterminate="1"' : ''}${lockedDisabled(locked || eligible.length === 0)}>` +
        `<button type="button" class="tree-toggle" data-nav-key="${escapeHtml(row.id)}" data-focus="tree-fold-${escapeHtml(row.id)}" aria-label="${escapeHtml(foldLabel)}" aria-expanded="true"${lockedDisabled(locked)}>▾</button>` +
        `<span class="tree-name" title="${escapeHtml(row.nav.path)}">${escapeHtml(row.nav.path.split('/').pop() ?? row.nav.path)}</span>` +
        `<span class="muted">${escapeHtml(countText)}</span>` +
        `</div>` +
        `<div class="tree-children" role="group">${renderTreeNodes(row.children ?? [], filters, level + 1, locked)}</div>` +
        `</div>`,
      );
      continue;
    }
    if (!rowMatchesFilters(row, filters)) {
      continue;
    }
    chunks.push(renderRow(row, locked, true, level));
  }
  return chunks.join('');
}

function renderRow(row: RowSpec, locked: boolean, tree: boolean, level: number): string {
  const status = row.cells.status ?? '';
  const letter = STATUS_LETTERS[status] ?? (status.slice(0, 1) || '·');
  // class 用可作 CSS 选择器的状态名（missing 的字母 '!' 不能作 class）。
  const statusClass = status === 'missing' ? 'missing' : letter;
  const path = row.cells.path ?? row.id;
  const display = tree
    ? (row.label ?? basenameOf(path))
    : path;
  const disabled = locked || row.disabled ? ' disabled' : '';
  const checked = row.selected ? ' checked' : '';
  const ariaReason = row.disabledReason ? `（${row.disabledReason}）` : '';
  const selectLabel = format(strings.panel.rowSelectLabel, { path: `${path}${ariaReason}` });
  const badges = (row.badges ?? []).map((badge) =>
    `<span class="badge${badge.kind === 'warn' ? ' warn' : ''}" title="${escapeHtml(badge.text)}">${escapeHtml(badge.text)}</span>`,
  ).join('');
  const acts = (row.actions ?? []).map((action) =>
    renderActionButton(action, { intent: action.id, argName: 'data-item-id', argValue: row.id, extraId: '' }),
  ).join('');
  const indent = tree ? ` style="padding-left:${12 + level * 16}px"` : '';
  return (
    `<div class="row" data-row-id="${escapeHtml(row.id)}" role="listitem"${indent}>` +
    `<input type="checkbox" data-intent="toggleRow" data-row-id="${escapeHtml(row.id)}" data-focus="row-${escapeHtml(row.id)}" aria-label="${escapeHtml(selectLabel)}"${checked}${disabled}>` +
    `<span class="st ${escapeHtml(statusClass)}" title="${escapeHtml(status)}">${escapeHtml(letter)}</span>` +
    `<div class="path-block"><span class="path mono" title="${escapeHtml(path)}">${escapeHtml(display)}</span><div class="badges">${badges}</div></div>` +
    `<div class="acts">${acts}</div>` +
    `</div>`
  );
}

/** 显示名取路径最后一段；路径本身就是文件名（或目录条目带类型 label）。 */
function basenameOf(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

interface ActionBinding {
  intent: string;
  argName: string;
  argValue: string;
  extraId: string;
  /** 占用态按放行视图禁用（表格等通用组件的行内动作；缺省不参与）。 */
  gated?: boolean;
}

function renderActionButton(action: ActionSpec, binding: ActionBinding): string {
  const disabled = action.disabled || binding.gated ? ' disabled' : '';
  const title = action.disabledReason ?? action.label;
  const extra = binding.extraId ? ` data-action-id="${escapeHtml(binding.extraId)}"` : '';
  const payload = Object.entries(action.payload ?? {})
    .map(([key, value]) => ` data-${escapeHtml(key)}="${escapeHtml(value)}"`)
    .join('');
  return `<button type="button" class="row-act" data-intent="${escapeHtml(binding.intent)}" ${binding.argName}="${escapeHtml(binding.argValue)}"${extra}${payload} data-focus="${escapeHtml(`${binding.intent}-${binding.argValue}`)}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"${disabled}>${escapeHtml(action.label)}</button>`;
}

function renderFooter(state: PanelState, locked: boolean): string {
  if (state.footer) {
    const secondary = (state.footer.secondary ?? [])
      .map((action) => renderActionButton(action, { intent: action.id, argName: 'data-footer', argValue: action.id, extraId: '' }))
      .join('');
    const primary = state.footer.primary
      ? renderPrimaryButton(state.footer.primary)
      : '';
    return `<footer class="footer"><span class="summary" aria-live="polite">${escapeHtml(state.footer.summary)}</span><div class="footer-actions">${secondary}${primary}</div></footer>`;
  }
  const refresh = `<button type="button" class="primary" data-intent="refresh" data-focus="refresh"${lockedDisabled(locked)}>${escapeHtml(strings.panel.refresh)}</button>`;
  const summary = state.busy ? escapeHtml(strings.panel.busy) : escapeHtml(renderCounts(state));
  return `<footer class="footer"><span class="summary">${summary}</span><div class="footer-actions">${refresh}</div></footer>`;
}

function renderPrimaryButton(action: ActionSpec): string {
  const disabled = action.disabled ? ' disabled' : '';
  const title = action.disabledReason ?? action.label;
  return `<button type="button" class="primary" data-intent="${escapeHtml(action.id)}" data-focus="submit" title="${escapeHtml(title)}"${disabled}>${escapeHtml(action.label)}</button>`;
}
