/**
 * state → HTML 字符串的纯渲染函数。不依赖 vscode；文案全部来自 i18n.ts。
 *
 * DOM 结构与 class 命名沿用交互原型的信息层级（panel-header / banners /
 * filter-bar / message-block / list / row / footer / progress …），不另起结构。
 * 交互标记统一用 data-intent + data-* 参数：视图侧事件委托据此转发意图，
 * 禁止内联 onclick；意图里只有条目 ID 等稳定标识，没有路径。
 *
 * 转义规则：所有进入文本与属性上下文的动态值（路径、状态原词、说明、
 * stderr 等）都经 escapeHtml（覆盖属性上下文需要的引号转义）。
 */
import { format, strings } from '../i18n';
import { STATUS_LETTERS } from './fixture';
import { visibleRows, type ActionSpec, type BannerSpec, type PanelState, type RowSpec } from './state';

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
  const parts: string[] = [
    `<header class="panel-header">`,
    `<span class="panel-title">${escapeHtml(state.title)}</span>`,
    `<span class="panel-target" title="${escapeHtml(state.targetLabel)}">${escapeHtml(state.targetLabel)}</span>`,
    `<span class="counts">${escapeHtml(renderCounts(state))}</span>`,
    `</header>`,
    renderBanners(state.banners),
  ];
  if (state.form) {
    parts.push(renderForm(state.form, busy));
  }
  if (state.list) {
    parts.push(renderFilterBar(state));
    parts.push(renderList(state));
  }
  parts.push(renderFooter(state));
  if (busy) {
    parts.push('<div class="progress" role="status" aria-label="busy"><i></i></div>');
  }
  return `<main class="panel" data-busy="${busy ? '1' : '0'}" data-revision="${state.revision}">${parts.join('')}</main>`;
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

function renderBanners(banners: BannerSpec[]): string {
  if (banners.length === 0) {
    return '';
  }
  const items = banners.map((banner) => renderBanner(banner));
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
  const dismissHtml = [
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

function renderForm(form: PanelState['form'], busy: boolean): string {
  if (!form) {
    return '';
  }
  const fields = form.fields.map((field) => {
    const disabled = busy || field.disabled ? ' disabled' : '';
    const common = `data-field-id="${escapeHtml(field.id)}" data-focus="field-${escapeHtml(field.id)}" id="field-${escapeHtml(field.id)}"`;
    let control: string;
    if (field.type === 'textarea') {
      control = `<textarea class="message-input" rows="4" ${common}${disabled} aria-label="${escapeHtml(field.label)}">${escapeHtml(field.value)}</textarea>`;
    } else if (field.type === 'select') {
      const options = (field.options ?? []).map((option) =>
        `<option value="${escapeHtml(option.value)}"${option.value === field.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`,
      ).join('');
      control = `<select ${common}${disabled} aria-label="${escapeHtml(field.label)}">${options}</select>`;
    } else {
      control = `<input type="text" value="${escapeHtml(field.value)}" ${common}${disabled} aria-label="${escapeHtml(field.label)}">`;
    }
    const help = field.help ? `<p class="muted">${escapeHtml(field.help)}</p>` : '';
    const error = field.error ? `<p class="field-error">${escapeHtml(field.error)}</p>` : '';
    return `<div class="message-row"><label class="message-label" for="field-${escapeHtml(field.id)}">${escapeHtml(field.label)}</label></div>${control}${help}${error}`;
  });
  return `<section class="message-block">${fields.join('')}</section>`;
}

function renderFilterBar(state: PanelState): string {
  const filters = state.list?.filters ?? [];
  if (filters.length === 0) {
    return '';
  }
  const selects = filters.map((filter) => {
    const options = filter.options.map((option) =>
      `<option value="${escapeHtml(option.value)}"${option.value === filter.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`,
    ).join('');
    return `<label class="filter"><span>${escapeHtml(filterLabel(filter.id))}</span><select data-intent="setFilter" data-filter-id="${escapeHtml(filter.id)}" data-focus="filter-${escapeHtml(filter.id)}"${state.busy ? ' disabled' : ''}>${options}</select></label>`;
  });
  return `<div class="filter-bar">${selects.join('')}</div>`;
}

function filterLabel(filterId: string): string {
  if (filterId === 'status') {
    return strings.panel.filterStatus;
  }
  if (filterId === 'ext') {
    return strings.panel.filterExt;
  }
  return filterId;
}

function renderList(state: PanelState): string {
  const list = state.list;
  if (!list) {
    return '';
  }
  const visible = visibleRows(list.rows, list.filters);
  if (list.rows.length === 0) {
    const empty = list.empty;
    const action = empty.action ? renderActionButton(empty.action, { intent: empty.action.id, argName: 'data-empty', argValue: '1', extraId: '' }) : '';
    return `<div class="empty"><h3>${escapeHtml(empty.title)}</h3>${empty.detail ? `<p class="muted">${escapeHtml(empty.detail)}</p>` : ''}${action}</div>`;
  }
  if (visible.length === 0) {
    const empty = list.filterEmpty ?? { title: strings.panel.filterEmptyTitle };
    const action = empty.action ? renderActionButton(empty.action, { intent: empty.action.id, argName: 'data-empty', argValue: '1', extraId: '' }) : '';
    return `<div class="empty"><h3>${escapeHtml(empty.title)}</h3>${empty.detail ? `<p class="muted">${escapeHtml(empty.detail)}</p>` : ''}${action}</div>`;
  }
  // 阶段 0 冒烟面板为扁平行 + 可选分组头；分组头选择（半选）阶段 1 启用。
  const body = visible.map((row) => renderRow(row, state.busy)).join('');
  return `<div class="list" data-focus="list" role="list">${body}</div>`;
}

function renderRow(row: RowSpec, busy: boolean): string {
  const status = row.cells.status ?? '';
  const letter = STATUS_LETTERS[status] ?? (status.slice(0, 1) || '·');
  // class 用可作 CSS 选择器的状态名（missing 的字母 '!' 不能作 class）。
  const statusClass = status === 'missing' ? 'missing' : letter;
  const path = row.cells.path ?? row.id;
  const disabled = busy || row.disabled ? ' disabled' : '';
  const checked = row.selected ? ' checked' : '';
  const ariaReason = row.disabledReason ? `（${row.disabledReason}）` : '';
  const selectLabel = format(strings.panel.rowSelectLabel, { path: `${path}${ariaReason}` });
  const badges = (row.badges ?? []).map((badge) =>
    `<span class="badge${badge.kind === 'warn' ? ' warn' : ''}" title="${escapeHtml(badge.text)}">${escapeHtml(badge.text)}</span>`,
  ).join('');
  const acts = (row.actions ?? []).map((action) =>
    renderActionButton(action, { intent: action.id, argName: 'data-item-id', argValue: row.id, extraId: '' }),
  ).join('');
  return (
    `<div class="row" data-row-id="${escapeHtml(row.id)}" role="listitem">` +
    `<input type="checkbox" data-intent="toggleRow" data-row-id="${escapeHtml(row.id)}" data-focus="row-${escapeHtml(row.id)}" aria-label="${escapeHtml(selectLabel)}"${checked}${disabled}>` +
    `<span class="st ${escapeHtml(statusClass)}" title="${escapeHtml(status)}">${escapeHtml(letter)}</span>` +
    `<div class="path-block"><span class="path mono" title="${escapeHtml(path)}">${escapeHtml(path)}</span><div class="badges">${badges}</div></div>` +
    `<div class="acts">${acts}</div>` +
    `</div>`
  );
}

interface ActionBinding {
  intent: string;
  argName: string;
  argValue: string;
  extraId: string;
}

function renderActionButton(action: ActionSpec, binding: ActionBinding): string {
  const disabled = action.disabled ? ' disabled' : '';
  const title = action.disabledReason ?? action.label;
  const extra = binding.extraId ? ` data-action-id="${escapeHtml(binding.extraId)}"` : '';
  return `<button type="button" class="row-act" data-intent="${escapeHtml(binding.intent)}" ${binding.argName}="${escapeHtml(binding.argValue)}"${extra} data-focus="${escapeHtml(`${binding.intent}-${binding.argValue}`)}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"${disabled}>${escapeHtml(action.label)}</button>`;
}

function renderFooter(state: PanelState): string {
  const refresh = `<button type="button" class="primary" data-intent="refresh" data-focus="refresh"${state.busy ? ' disabled' : ''}>${escapeHtml(strings.panel.refresh)}</button>`;
  const summary = state.busy ? escapeHtml(strings.panel.busy) : escapeHtml(renderCounts(state));
  return `<footer class="footer"><span class="summary">${summary}</span><div class="footer-actions">${refresh}</div></footer>`;
}
