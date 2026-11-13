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
  type ConflictBatchResultsSpec,
  type ConflictListSpec,
  type ConflictPanelRowStatus,
  type ConflictRowSpec,
  type ConfirmDialogSpec,
  type DetailArtifactSpec,
  type DetailCopyWindowSpec,
  type DetailPathChangeSpec,
  type DetailPropertySpec,
  type DetailSectionSpec,
  type DetailVariantOptionSpec,
  type FilterPanelSpec,
  type FilterSpec,
  type LazyTreeRowSpec,
  type ListSpec,
  type MasterDetailSpec,
  type PanelState,
  type ProgressState,
  type RowSpec,
  type TableRowSpec,
  type TableSpec,
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
    renderMetrics(state),
    renderSpaceBar(state),
    renderTabs(state),
    renderFilterPanel(state),
    renderProgress(state),
  ];
  if (state.form) {
    parts.push(renderForm(state, locked));
  }
  if (state.layout) {
    parts.push(renderMasterDetail(state, locked));
    if (state.ignoreEditor) {
      parts.push(renderIgnoreEditor(state.ignoreEditor));
    }
  } else {
    if (state.lazyTree) {
      parts.push(renderLazyTree(state));
    }
    if (state.table) {
      parts.push(renderTable(state));
    }
    if (state.conflictList) {
      parts.push(renderConflictList(state));
    }
    if (state.list) {
      parts.push(renderFilterBar(state, locked));
      parts.push(renderSelectionBar(state, locked));
      parts.push(renderList(state, locked));
    }
    if (state.ignoreEditor) {
      parts.push(renderIgnoreEditor(state.ignoreEditor));
    }
  }
  if (state.conflictBatch) {
    parts.push(renderConflictBatch(state));
  }
  parts.push(renderFooter(state, locked));
  if (busy) {
    parts.push('<div class="progress" role="status" aria-label="busy"><i></i></div>');
  }
  // P7 确认对话框：覆盖层最后渲染（fixed 定位，不在文档流中挤压面板）。
  parts.push(renderConfirmDialog(state));
  return `<main class="panel" data-busy="${busy ? '1' : '0'}" data-revision="${state.revision}">${parts.join('')}</main>`;
}

/**
 * 占用态下通用控件的禁用判定：与宿主守卫同一放行表推导（经
 * PanelState.gate 传入求值后的动作集）。未携带放行视图的面板保持
 * 「占用即全禁」的现状——守卫放行迟到输入不代表 DOM 解禁输入控件；
 * 携带视图的面板只禁用表中未放行的动作，避免「可点被拒」的假可用。
 */
function actionGated(
  state: Pick<PanelState, 'busy' | 'writeLocked' | 'gate'>,
  action: string,
): boolean {
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
 * 数值卡组（P4 空间概览与清理前后对比卡）：value 是宿主格式化后的成品
 * 文本（业务字节值不进消息），这里只做转义与排版；unit 可选拼在值尾。
 */
function renderMetrics(state: PanelState): string {
  const metrics = state.metrics ?? [];
  if (metrics.length === 0) {
    return '';
  }
  const items = metrics
    .map((metric) => {
      const unit = metric.unit ? `<span class="metric-unit">${escapeHtml(metric.unit)}</span>` : '';
      return `<div class="metric"><span class="metric-caption">${escapeHtml(metric.caption)}</span>` +
        `<span class="metric-value">${escapeHtml(metric.value)}${unit}</span></div>`;
    })
    .join('');
  return `<section class="metrics">${items}</section>`;
}

/** 占比条段内展示文字的最小宽度阈值（百分比）：过窄的段只保留 title。 */
const SPACE_SEG_LABEL_THRESHOLD = 12;

/**
 * 占比条：按 segments[].bytes / totalBytes 比例渲染分段宽度；宽度低于
 * 阈值的段隐藏段内文字（title 保留完整 label 与百分比），颜色按段序取
 * 主题 chart 色板（宿主可用 color 覆盖）。bytes 只用于比例计算。
 */
function renderSpaceBar(state: PanelState): string {
  const bar = state.spaceBar;
  if (!bar || bar.segments.length === 0) {
    return '';
  }
  const total = bar.totalBytes > 0 ? bar.totalBytes : 0;
  const segs = bar.segments
    .map((segment, index) => {
      const pct = total > 0 ? (segment.bytes / total) * 100 : 0;
      const colorOverride = segment.color ? `;background:${escapeHtml(segment.color)}` : '';
      const label = pct >= SPACE_SEG_LABEL_THRESHOLD
        ? `<span class="seg-label">${escapeHtml(segment.label)}</span>`
        : '';
      const title = `${segment.label} ${Math.round(pct)}%`;
      return `<span class="space-seg seg-${index % 6}" style="width:${pct.toFixed(3)}%${colorOverride}"` +
        ` title="${escapeHtml(title)}">${label}</span>`;
    })
    .join('');
  return `<section class="space-bar-block" role="img" aria-label="${escapeHtml(strings.panel.spaceBarLabel)}">` +
    `<div class="space-bar">${segs}</div></section>`;
}

/**
 * 分组 tab（P7 文件/属性/树）：只表达计数与当前 tab；切换意图只带 tab ID，
 * 宿主映射冲突分组语义。占用态按放行视图禁用。
 */
function renderTabs(state: PanelState): string {
  const tabs = state.tabs;
  if (!tabs || tabs.tabs.length === 0) {
    return '';
  }
  const intent = tabs.intent ?? 'setConflictTab';
  const gated = actionGated(state, intent);
  const buttons = tabs.tabs
    .map((tab) => {
      const current = tab.id === tabs.current;
      const count = tab.count !== undefined ? ` <span class="tab-count">${tab.count}</span>` : '';
      const disabled = tab.disabled || gated ? ' disabled' : '';
      const title = tab.disabledReason ?? tab.label;
      return (
        `<button type="button" class="tab${current ? ' current' : ''}" role="tab" aria-selected="${current}"` +
        ` data-intent="${escapeHtml(intent)}" data-tab-id="${escapeHtml(tab.id)}" data-focus="tab-${escapeHtml(tab.id)}"` +
        ` title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"${disabled}>${escapeHtml(tab.label)}${count}</button>`
      );
    })
    .join('');
  const aria = tabs.ariaLabel ? ` aria-label="${escapeHtml(tabs.ariaLabel)}"` : '';
  return `<div class="tabs" role="tablist"${aria}>${buttons}</div>`;
}

/**
 * 折叠筛选面板（P6）：文本/日期/select 字段与清空动作。字段值变化经
 * `setHistoryFilter(id, value)` 立即提交（输入短防抖由视图侧承担）；
 * 字段错误只显示、不改写用户输入。折叠用原生 details/summary。
 */
function renderFilterPanel(state: PanelState): string {
  const panel: FilterPanelSpec | undefined = state.filterPanel;
  if (!panel || (panel.fields.length === 0 && !panel.clearAction)) {
    return '';
  }
  const gated = actionGated(state, 'setHistoryFilter');
  const fields = panel.fields.map((field) => {
    const disabled = field.disabled || gated ? ' disabled' : '';
    const common =
      `data-intent="setHistoryFilter" data-filter-field-id="${escapeHtml(field.id)}"` +
      ` data-filter-panel-id="${escapeHtml(panel.id)}"` +
      ` data-focus="filter-field-${escapeHtml(field.id)}"` +
      ` aria-label="${escapeHtml(field.label)}"${disabled}`;
    let control: string;
    if (field.kind === 'select') {
      const options = (field.options ?? [])
        .map((option) =>
          `<option value="${escapeHtml(option.value)}"${option.value === field.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`,
        )
        .join('');
      control = `<select ${common}>${options}</select>`;
    } else {
      const placeholder = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : '';
      control = `<input type="${field.kind === 'date' ? 'date' : 'text'}" value="${escapeHtml(field.value)}"${placeholder} ${common}>`;
    }
    const error = field.error ? `<p class="field-error">${escapeHtml(field.error)}</p>` : '';
    return `<label class="filter-field ${escapeHtml(field.kind)}"><span>${escapeHtml(field.label)}</span>${control}</label>${error}`;
  }).join('');
  const clear = panel.clearAction
    ? `<div class="filter-panel-actions">${renderActionButton(panel.clearAction, {
        intent: panel.clearAction.id,
        argName: 'data-filter-panel',
        argValue: panel.id,
        extraId: '',
        gated: actionGated(state, panel.clearAction.id),
      })}</div>`
    : '';
  return (
    `<details class="filter-panel" data-filter-panel-id="${escapeHtml(panel.id)}"${panel.collapsed ? '' : ' open'}>` +
    `<summary>${escapeHtml(panel.title ?? '')}</summary>` +
    `<div class="filter-panel-body">${fields}${clear}</div>` +
    `</details>`
  );
}

/**
 * 长任务进度（P6/P7）：标题、明细与放行动作；ratio 缺省为不确定进度。
 * 与 busy 底部进度条分开：写入在途时动作集由宿主放行表决定（同源禁用）。
 */
function renderProgress(state: PanelState): string {
  const progress: ProgressState | undefined = state.progress;
  if (!progress) {
    return '';
  }
  const ratio =
    typeof progress.ratio === 'number' && Number.isFinite(progress.ratio)
      ? Math.min(1, Math.max(0, progress.ratio))
      : null;
  const bar = ratio === null
    ? `<div class="progress" aria-hidden="true"><i></i></div>`
    : `<div class="progress" aria-hidden="true" data-determinate="1"><i style="width:${(ratio * 100).toFixed(1)}%"></i></div>`;
  const detail = progress.detail ? `<p class="muted">${escapeHtml(progress.detail)}</p>` : '';
  const actions = (progress.actions ?? [])
    .map((action) =>
      renderActionButton(action, {
        intent: action.id,
        argName: 'data-progress-action',
        argValue: action.id,
        extraId: '',
        gated: actionGated(state, action.id),
      }),
    )
    .join('');
  return (
    `<section class="task-progress" role="status" aria-live="polite" aria-label="${escapeHtml(progress.title)}">` +
    `<div class="task-progress-head"><strong>${escapeHtml(progress.title)}</strong><div class="acts">${actions}</div></div>` +
    bar +
    detail +
    `</section>`
  );
}

/** 主从布局：主区（树/表格/列表）与详情区各自独立滚动，滚动键稳定。 */
function renderMasterDetail(state: PanelState, locked: boolean): string {
  const layout: MasterDetailSpec = state.layout!;
  const master = renderMasterContent(state, locked);
  const detail = state.detail ? renderDetail(state) : '';
  const masterHead = layout.masterLabel
    ? `<div class="pane-head"><strong>${escapeHtml(layout.masterLabel)}</strong></div>`
    : '';
  const detailHead = layout.detailLabel
    ? `<div class="pane-head"><strong>${escapeHtml(layout.detailLabel)}</strong></div>`
    : '';
  const masterAria = layout.masterLabel ? ` aria-label="${escapeHtml(layout.masterLabel)}"` : '';
  const detailAria = layout.detailLabel ? ` aria-label="${escapeHtml(layout.detailLabel)}"` : '';
  return (
    `<div class="split-layout layout-${layout.layout === 'balanced' ? 'balanced' : 'master-detail'}">` +
    `<section class="pane pane-master"${masterAria}>${masterHead}` +
    `<div class="pane-scroll" data-scroll-key="${escapeHtml(layout.masterScrollKey ?? 'master')}">${master}</div></section>` +
    `<section class="pane pane-detail"${detailAria}>${detailHead}` +
    `<div class="pane-scroll" data-scroll-key="${escapeHtml(layout.detailScrollKey ?? 'detail')}">${detail}</div></section>` +
    `</div>`
  );
}

/** 主区内容优先级：懒加载树 > 表格 > 冲突列表 > 列表；每帧只声明一种主组件。 */
function renderMasterContent(state: PanelState, locked: boolean): string {
  if (state.lazyTree) {
    return renderLazyTree(state);
  }
  if (state.table) {
    return renderTable(state);
  }
  if (state.conflictList) {
    return renderConflictList(state);
  }
  if (state.list) {
    return renderFilterBar(state, locked) + renderSelectionBar(state, locked) + renderList(state, locked);
  }
  return '';
}

/** 详情：标题/副标题 + 键值、文本、预格式、动作段；全部动态值预转义。 */
function renderDetail(state: PanelState): string {
  const detail = state.detail;
  if (!detail) {
    return '';
  }
  const title = detail.title ? `<div class="detail-title">${escapeHtml(detail.title)}</div>` : '';
  const subtitle = detail.subtitle
    ? `<div class="detail-subtitle">${escapeHtml(detail.subtitle)}</div>`
    : '';
  const sections = detail.sections
    .map((section) => renderDetailSection(section, state, detail.id))
    .join('');
  return `<div class="pane-detail">${title}${subtitle}${sections}</div>`;
}

function renderDetailSection(
  section: DetailSectionSpec,
  state: PanelState,
  detailId: string | undefined,
): string {
  if (section.kind === 'actions') {
    const actions = section.actions
      .map((action) => {
        // 详情层动作优先绑定稳定行 ID（copyHistoryText 等需要 ID 的意图）；
        // 动作 payload 已自带 row-id 时以 payload 为准，避免重复属性。
        const bindRowId = detailId !== undefined && action.payload?.['row-id'] === undefined
          ? detailId
          : undefined;
        return renderActionButton(action, {
          intent: action.id,
          // 无 detail.id 的既有面板保持 data-detail-action 无参转发。
          argName: bindRowId !== undefined ? 'data-row-id' : 'data-detail-action',
          argValue: bindRowId ?? action.id,
          extraId: '',
          gated: actionGated(state, action.id),
        });
      })
      .join('');
    return `<div class="detail-section"><div class="inline-actions">${actions}</div></div>`;
  }
  const heading = section.heading ? `<h2>${escapeHtml(section.heading)}</h2>` : '';
  if (section.kind === 'kv') {
    const entries = section.entries
      .map((entry) =>
        `<dt>${escapeHtml(entry.label)}</dt><dd${entry.mono ? ' class="mono"' : ''}>${escapeHtml(entry.value)}</dd>`,
      )
      .join('');
    return `<div class="detail-section">${heading}<dl class="kv">${entries}</dl></div>`;
  }
  if (section.kind === 'pre') {
    return `<div class="detail-section">${heading}<pre>${escapeHtml(section.text)}</pre></div>`;
  }
  if (section.kind === 'paths') {
    const body = renderChangedPaths(
      section.paths,
      section.emptyText,
      section.collapseAfter,
      section.moreLabel,
      state,
    );
    return `<div class="detail-section">${heading}${body}</div>`;
  }
  if (section.kind === 'copyWindow') {
    const body = renderCopyWindow(section.items, section.emptyText);
    return `<div class="detail-section">${heading}${body}</div>`;
  }
  if (section.kind === 'artifacts') {
    return renderArtifactsSection(section.artifacts, section.heading, section.emptyText, section.note);
  }
  if (section.kind === 'properties') {
    return renderPropertiesSection(section.properties, section.heading, section.note, state);
  }
  if (section.kind === 'variants') {
    return renderVariantsSection(section, state);
  }
  const paragraphs = section.paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join('');
  return `<div class="detail-section">${heading}${paragraphs}</div>`;
}

/**
 * P7 冲突辅助文件段：角色徽标 + 工作副本相对路径 + 可选 revision。
 * 路径来自当前冲突记录的 info 辅助文件字段（不是按后缀扫描整个副本），
 * 全部动态值转义，窄面板允许任意位置换行。
 */
function renderArtifactsSection(
  artifacts: DetailArtifactSpec[],
  heading: string | undefined,
  emptyText: string | undefined,
  note: string | undefined,
): string {
  const head = heading ? `<h2>${escapeHtml(heading)}</h2>` : '';
  const body = artifacts.length === 0
    ? (emptyText ? `<p class="muted">${escapeHtml(emptyText)}</p>` : '')
    : `<ul class="artifact-list">${artifacts.map((artifact) => {
        const revision = artifact.revision !== undefined
          ? `<span class="artifact-revision mono">r${escapeHtml(artifact.revision)}</span>`
          : '';
        return `<li class="artifact-item"><span class="artifact-role">${escapeHtml(artifact.roleLabel)}</span>` +
          `<span class="artifact-path mono" title="${escapeHtml(artifact.path)}">${escapeHtml(artifact.path)}</span>${revision}</li>`;
      }).join('')}</ul>`;
  const noteHtml = note ? `<p class="muted">${escapeHtml(note)}</p>` : '';
  return `<div class="detail-section">${head}${body}${noteHtml}</div>`;
}

/**
 * P7 属性冲突三值对照：每个属性一组「本地（working）/基线（source-left）/
 * 传入（source-right）」，选中值高亮；逐属性选择按钮由宿主 ActionSpec
 * 提供（意图参数走 data-* 载荷，视图不解释属性语义）。保留属性
 * （svn:mergeinfo 等）以 autoUnsupportedNote 标注且不渲染选择动作。
 */
function renderPropertiesSection(
  properties: DetailPropertySpec[],
  heading: string | undefined,
  note: string | undefined,
  state: PanelState,
): string {
  const head = heading ? `<h2>${escapeHtml(heading)}</h2>` : '';
  const items = properties.map((property) => {
    const unsupported = property.autoUnsupported === true;
    const badge = unsupported && property.autoUnsupportedNote
      ? `<span class="property-unsupported" title="${escapeHtml(property.autoUnsupportedNote)}">${escapeHtml(property.autoUnsupportedNote)}</span>`
      : '';
    const cell = (
      value: DetailPropertySpec['local'],
      selected: boolean,
    ): string => {
      const action = value.action && !unsupported
        ? renderActionButton(value.action, {
            intent: value.action.id,
            argName: '',
            argValue: '',
            extraId: '',
            gated: actionGated(state, value.action.id),
          })
        : '';
      // exists=false 表示该侧不存在该属性：文本仍由宿主提供，视图只附加
      // 弱化样式（不推断「不存在」文案，也不伪造空值）。
      const absent = value.exists === false ? ' absent' : '';
      return `<div class="property-value${selected ? ' selected' : ''}${absent}">` +
        `<code class="mono">${escapeHtml(value.text)}</code>${action}</div>`;
    };
    const mineLabel = strings.conflictPanel.propertyMine;
    const baseLabel = strings.conflictPanel.propertyBase;
    const incomingLabel = strings.conflictPanel.propertyIncoming;
    return `<div class="property-item" data-property-name="${escapeHtml(property.name)}">` +
      `<div class="property-head"><span class="property-name mono">${escapeHtml(property.name)}</span>${badge}</div>` +
      `<div class="property-grid">` +
      `<div class="property-cell"><strong>${escapeHtml(mineLabel)}</strong>${cell(property.local, property.selected === 'local')}</div>` +
      `<div class="property-cell"><strong>${escapeHtml(baseLabel)}</strong>${cell(property.base, property.selected === 'base')}</div>` +
      `<div class="property-cell"><strong>${escapeHtml(incomingLabel)}</strong>${cell(property.incoming, property.selected === 'incoming')}</div>` +
      `</div></div>`;
  }).join('');
  const noteHtml = note ? `<p class="muted">${escapeHtml(note)}</p>` : '';
  return `<div class="detail-section">${head}<div class="property-list">${items}</div>${noteHtml}</div>`;
}

/**
 * P7 处理结果变体：常用选项以 choice 卡渲染，其余收进「高级 SVN 变体」
 * details（视图瞬时折叠）。选择按钮只转发稳定枚举值（缺省
 * chooseConflictVariant + payload.value）；混合路径等禁止直接应用时由
 * 宿主给出 disabledReason 与 warn 说明，视图不自行判断动作对错。
 */
function renderVariantsSection(
  section: Extract<DetailSectionSpec, { kind: 'variants' }>,
  state: PanelState,
): string {
  const head = section.heading ? `<h2>${escapeHtml(section.heading)}</h2>` : '';
  const advancedEnabled = section.advancedLabel !== undefined;
  const common = section.options.filter((option) => !(advancedEnabled && option.advanced));
  const advanced = advancedEnabled ? section.options.filter((option) => option.advanced) : [];
  const choice = (option: DetailVariantOptionSpec): string => {
    const intent = option.action?.id ?? 'chooseConflictVariant';
    const payload = option.action?.payload ?? { value: option.value };
    const payloadAttrs = Object.entries(payload)
      .map(([key, value]) => ` data-${escapeHtml(key)}="${escapeHtml(value)}"`)
      .join('');
    const selected = option.selected === true;
    const disabled = option.disabled || actionGated(state, intent) ? ' disabled' : '';
    const title = option.disabledReason ?? option.description ?? option.label;
    const description = option.description
      ? `<span>${escapeHtml(option.description)}</span>`
      : '';
    return `<button type="button" class="choice${selected ? ' selected' : ''}" data-intent="${escapeHtml(intent)}"${payloadAttrs}` +
      ` data-focus="variant-${escapeHtml(option.value)}" aria-pressed="${selected}" title="${escapeHtml(title)}"${disabled}>` +
      `<strong>${escapeHtml(option.label)}</strong>${description}</button>`;
  };
  const grid = common.length > 0 ? `<div class="choice-grid">${common.map(choice).join('')}</div>` : '';
  const advancedHtml = advanced.length > 0 && section.advancedLabel !== undefined
    ? `<details class="advanced"><summary>${escapeHtml(section.advancedLabel)}</summary>` +
      `<div class="choice-grid advanced-grid">${advanced.map(choice).join('')}</div></details>`
    : '';
  const warn = section.warn
    ? `<p class="choice-warn" role="note">${escapeHtml(section.warn)}</p>`
    : '';
  const note = section.note ? `<p class="muted">${escapeHtml(section.note)}</p>` : '';
  return `<div class="detail-section">${head}${grid}${advancedHtml}${warn}${note}</div>`;
}

/**
 * P7 冲突列表：宿主已按 tab 过滤；每行是「选中查看详情」的稳定行 ID
 * 按钮（缺省 selectConflict，不携带路径）。行外层带 data-status，供
 * Webview 侧识别 resolved 状态变化并播放撤下动效；类型/内容子类型/
 * 可自动标记/状态徽标全部由宿主文案驱动，视图不推断冲突语义。
 */
function renderConflictList(state: PanelState): string {
  const list = state.conflictList;
  if (!list) {
    return '';
  }
  if (list.rows.length === 0) {
    const action = list.empty.action
      ? renderActionButton(list.empty.action, {
          intent: list.empty.action.id,
          argName: 'data-empty',
          argValue: '1',
          extraId: '',
          gated: actionGated(state, list.empty.action.id),
        })
      : '';
    return `<div class="conflict-list-block"><div class="empty"><h3>${escapeHtml(list.empty.title)}</h3>` +
      `${list.empty.detail ? `<p class="muted">${escapeHtml(list.empty.detail)}</p>` : ''}${action}</div></div>`;
  }
  const selectIntent = list.selectIntent ?? 'selectConflict';
  const rows = list.rows.map((row) => renderConflictRow(state, list, row, selectIntent)).join('');
  const aria = list.ariaLabel ? ` aria-label="${escapeHtml(list.ariaLabel)}"` : '';
  return `<div class="conflict-list" role="list" data-conflict-list-id="${escapeHtml(list.id)}"${aria}>${rows}</div>`;
}

/**
 * P7 批量计划/结果区（ConflictBatchSpec，阶段 7）：计划概要、策略选择
 * 按钮（planConflictBatch + strategy 枚举）、可执行/不适用/推迟三组与
 * 动作；结果页展示摘要 chips、停止位置、最终整范围回扫说明与逐项结果。
 * 视图只渲染宿主文案与稳定 payload，不判断冲突语义。
 */
function renderConflictBatch(state: PanelState): string {
  const batch = state.conflictBatch;
  if (!batch) {
    return '';
  }
  const summary = batch.summary
    .map((entry) =>
      `<dt>${escapeHtml(entry.label)}</dt><dd${entry.mono ? ' class="mono"' : ''}>${escapeHtml(entry.value)}</dd>`)
    .join('');
  const strategies = batch.strategies.length === 0
    ? ''
    : `<div class="batch-strategy" role="group" aria-label="${escapeHtml(batch.strategyLabel)}">` +
      `<span class="batch-label">${escapeHtml(batch.strategyLabel)}</span>` +
      batch.strategies
        .map((choice) => {
          // 占用态按 P7 放行表禁用（planConflictBatch 属写集）：DOM 禁用
          // 与宿主守卫同源，不出现可点被拒。
          const disabled = choice.disabled === true || actionGated(state, 'planConflictBatch');
          return `<button type="button" class="choice${choice.selected ? ' selected' : ''}" data-intent="planConflictBatch"` +
            ` data-strategy="${escapeHtml(choice.value)}" data-focus="batch-strategy-${escapeHtml(choice.value)}"` +
            ` aria-pressed="${choice.selected}"${disabled ? ' disabled' : ''}>${escapeHtml(choice.label)}</button>`;
        })
        .join('') +
      `</div>`;
  const groups = batch.groups
    .map((group) => {
      const items = group.items.length === 0
        ? ''
        : `<ul class="batch-items">${group.items
            .map((item) =>
              `<li><span class="mono batch-path">${escapeHtml(item.path)}</span>` +
              `${item.note ? `<span class="muted batch-note">${escapeHtml(item.note)}</span>` : ''}</li>`)
            .join('')}</ul>`;
      return `<section class="batch-group batch-group-${escapeHtml(group.id)}">` +
        `<h3>${escapeHtml(group.title)}</h3>${items}</section>`;
    })
    .join('');
  const actions = batch.actions
    .map((action) =>
      renderActionButton(action, {
        intent: action.id,
        argName: '',
        argValue: '',
        extraId: '',
        gated: actionGated(state, action.id),
      }))
    .join('');
  const blocked = batch.blockedReason
    ? `<p class="batch-blocked" role="note">${escapeHtml(batch.blockedReason)}</p>`
    : '';
  const results = batch.results ? renderConflictBatchResults(batch.results) : '';
  return `<section class="conflict-batch" data-batch-id="${escapeHtml(batch.id)}" data-batch-mode="${escapeHtml(batch.mode)}">` +
    `<h2>${escapeHtml(batch.heading)}</h2>` +
    `<dl class="batch-summary">${summary}</dl>` +
    `${strategies}${blocked}${groups}${results}` +
    `${actions ? `<div class="batch-actions">${actions}</div>` : ''}` +
    `</section>`;
}

/** 批量结果页：摘要 chips + 停止位置/回扫说明 + 逐项状态（宿主文案）。 */
function renderConflictBatchResults(results: ConflictBatchResultsSpec): string {
  const chips = results.chips
    .map((chip) =>
      `<span class="batch-chip batch-chip-${escapeHtml(chip.kind)}">${escapeHtml(chip.label)}</span>`)
    .join('');
  const items = results.items
    .map((item) =>
      `<li data-batch-item-state="${escapeHtml(item.state)}">` +
      `<span class="mono batch-path">${escapeHtml(item.path)}</span>` +
      `<span class="batch-state batch-state-${escapeHtml(item.state)}">${escapeHtml(item.stateLabel)}</span>` +
      `${item.detail ? `<span class="muted batch-note">${escapeHtml(item.detail)}</span>` : ''}</li>`)
    .join('');
  return `<div class="batch-results" role="status">` +
    `<div class="batch-chips">${chips}</div>` +
    `${results.stoppedNote ? `<p class="batch-stopped" role="note">${escapeHtml(results.stoppedNote)}</p>` : ''}` +
    `${results.rescanNote ? `<p class="muted batch-rescan">${escapeHtml(results.rescanNote)}</p>` : ''}` +
    `<ul class="batch-result-items">${items}</ul></div>`;
}

function conflictStatusLabel(row: ConflictRowSpec): string {
  if (row.statusLabel) {
    return row.statusLabel;
  }
  switch (row.status) {
    case 'resolved':
      return strings.conflictPanel.rowStatusResolved;
    case 'postponed':
      return strings.conflictPanel.rowStatusPostponed;
    default:
      // unknown 无通用默认：宿主应提供 statusLabel；缺省按未解决展示，
      // 不把未知状态伪装成已解决。
      return strings.conflictPanel.rowStatusUnresolved;
  }
}

function conflictContentKindLabel(kind: NonNullable<ConflictRowSpec['contentKind']>): string {
  switch (kind) {
    case 'binary':
      return strings.conflictPanel.contentKindBinary;
    case 'unknown':
      return strings.conflictPanel.contentKindUnknown;
    default:
      return strings.conflictPanel.contentKindText;
  }
}

function renderConflictRow(
  state: PanelState,
  list: ConflictListSpec,
  row: ConflictRowSpec,
  selectIntent: string,
): string {
  const status: ConflictPanelRowStatus = row.status;
  const selected = row.selected === true;
  const classes = ['conflict-item', `status-${status}`, selected ? 'selected' : ''].filter(Boolean).join(' ');
  const kindBadges = row.kinds
    .map((kind) => {
      const label = list.kindLabels?.[kind];
      return label
        ? `<span class="conflict-kind kind-${kind}">${escapeHtml(label)}</span>`
        : '';
    })
    .join('');
  const content = row.contentKind
    ? `<span class="conflict-content content-${row.contentKind}">${escapeHtml(conflictContentKindLabel(row.contentKind))}</span>`
    : '';
  const auto = row.auto
    ? `<span class="conflict-auto ${row.auto.kind === 'unsupported' ? 'unsupported' : 'applicable'}"` +
      `${row.auto.reason ? ` title="${escapeHtml(row.auto.reason)}"` : ''}>${escapeHtml(row.auto.label)}</span>`
    : '';
  const statusBadge = `<span class="conflict-status st-${status}">${escapeHtml(conflictStatusLabel(row))}</span>`;
  const actions = (row.actions ?? [])
    .map((action) =>
      renderActionButton(action, {
        intent: action.id,
        argName: 'data-row-id',
        argValue: row.id,
        extraId: '',
        gated: actionGated(state, action.id),
      }),
    )
    .join('');
  const acts = actions ? `<div class="acts">${actions}</div>` : '';
  const selectDisabled = actionGated(state, selectIntent) ? ' disabled' : '';
  return `<div class="${classes}" data-row-id="${escapeHtml(row.id)}" data-status="${status}" role="listitem">` +
    `<button type="button" class="conflict-select" data-intent="${escapeHtml(selectIntent)}" data-row-id="${escapeHtml(row.id)}"` +
    ` data-focus="conflict-row-${escapeHtml(row.id)}" aria-current="${selected ? 'true' : 'false'}"${selectDisabled}>` +
    `<span class="conflict-path mono" title="${escapeHtml(row.path)}">${escapeHtml(row.path)}</span>` +
    `<span class="conflict-badges">${kindBadges}${content}${auto}${statusBadge}</span></button>${acts}</div>`;
}

/**
 * P7 确认对话框（树冲突节点处理确认/二次确认）：覆盖层 + role=dialog
 * aria-modal；正文分段渲染（preformatted 原样）。确认按钮转发宿主给出的
 * 动作意图；取消按钮只带 data-dialog-dismiss（Webview 瞬时关闭，不发
 * 意图、不改宿主状态），宿主重新请求确认时应更换 id。
 */
function renderConfirmDialog(state: PanelState): string {
  const dialog: ConfirmDialogSpec | undefined = state.confirmDialog;
  if (!dialog) {
    return '';
  }
  const titleId = `confirm-dialog-title-${dialog.id}`;
  const detail = !dialog.detail
    ? ''
    : dialog.preformatted
      ? `<pre class="confirm-detail">${escapeHtml(dialog.detail)}</pre>`
      : dialog.detail
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => `<p>${escapeHtml(line)}</p>`)
        .join('');
  const cancelLabel = dialog.cancelLabel ?? strings.panel.dismiss;
  const level = dialog.level === 'warn' ? ' warn' : '';
  return (
    `<div class="modal-backdrop" data-confirm-dialog-id="${escapeHtml(dialog.id)}">` +
    `<section class="confirm-dialog${level}" role="dialog" aria-modal="true" aria-labelledby="${escapeHtml(titleId)}">` +
    `<h2 id="${escapeHtml(titleId)}">${escapeHtml(dialog.title)}</h2>${detail}` +
    `<div class="confirm-actions">` +
    `<button type="button" class="row-act" data-dialog-dismiss="${escapeHtml(dialog.id)}" data-focus="dialog-cancel-${escapeHtml(dialog.id)}">${escapeHtml(cancelLabel)}</button>` +
    `${renderActionButton(dialog.confirm, { intent: dialog.confirm.id, argName: '', argValue: '', extraId: '' })}` +
    `</div></section></div>`
  );
}

/**
 * 详情变更路径列表（P6 历史）：每项显示 SVN 动作原词、路径原值（含复制
 * 来源 copyfrom-path/rev）与宿主附加说明；行内动作只绑定稳定路径项 ID，
 * 视图不在意图里携带路径。超过 collapseAfter 且提供 moreLabel 时，其余
 * 路径收进「查看全部变更路径」details——折叠是视图瞬时状态，不发意图。
 * moreLabel 可含 `{count}` 占位符（由视图填入被收起条数）；不含时在
 * 文案后附加（N）。
 */
function renderChangedPaths(
  paths: DetailPathChangeSpec[],
  emptyText: string | undefined,
  collapseAfter: number | undefined,
  moreLabel: string | undefined,
  state: PanelState,
): string {
  if (paths.length === 0) {
    return emptyText ? `<p class="muted">${escapeHtml(emptyText)}</p>` : '';
  }
  const threshold = typeof collapseAfter === 'number' && Number.isFinite(collapseAfter)
    ? Math.max(0, Math.floor(collapseAfter))
    : paths.length;
  const fold = moreLabel !== undefined && paths.length > threshold;
  const direct = fold ? paths.slice(0, threshold) : paths;
  const rest = fold ? paths.slice(threshold) : [];
  const list = (items: DetailPathChangeSpec[]): string =>
    `<ul class="changed-paths">${items.map((item) => renderChangedPath(item, state)).join('')}</ul>`;
  const summaryText = moreLabel !== undefined && rest.length > 0
    ? (moreLabel.includes('{count}')
        ? format(moreLabel, { count: String(rest.length) })
        : `${moreLabel}（${rest.length}）`)
    : '';
  const more = rest.length > 0
    ? `<details class="detail-paths-more"><summary>${escapeHtml(summaryText)}</summary>${list(rest)}</details>`
    : '';
  const directHtml = direct.length > 0 ? list(direct) : '';
  return `${directHtml}${more}`;
}

function renderChangedPath(item: DetailPathChangeSpec, state: PanelState): string {
  const actionChip = item.action
    ? `<span class="path-action act-${escapeHtml(item.action)}">${escapeHtml(item.action)}</span>`
    : '';
  const path = `<span class="path-value mono" title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</span>`;
  const kind = item.kind ? `<span class="path-kind">${escapeHtml(item.kind)}</span>` : '';
  const copyfrom = item.copyfrom
    ? `<span class="path-copyfrom">${item.copyfrom.label ? `${escapeHtml(item.copyfrom.label)} ` : ''}` +
      `<span class="mono">${escapeHtml(item.copyfrom.path)}</span>` +
      `${item.copyfrom.revision !== undefined ? `<span class="mono">@r${escapeHtml(item.copyfrom.revision)}</span>` : ''}</span>`
    : '';
  const note = item.note ? `<span class="path-note muted">${escapeHtml(item.note)}</span>` : '';
  const pathId = item.id;
  const actions = pathId !== undefined && (item.actions?.length ?? 0) > 0
    ? `<span class="acts">${item.actions!.map((actionSpec) =>
      renderActionButton(actionSpec, {
        intent: actionSpec.id,
        // payload 已自带 row-id 时以 payload 为准，避免重复 data-row-id 属性。
        argName: actionSpec.payload?.['row-id'] === undefined ? 'data-row-id' : 'data-detail-action',
        argValue: pathId,
        extraId: '',
        gated: actionGated(state, actionSpec.id),
      })).join('')}</span>`
    : '';
  const itemId = pathId !== undefined ? ` data-path-id="${escapeHtml(pathId)}"` : '';
  return `<li class="path-item"${itemId}>${actionChip}${path}${kind}${actions}${copyfrom}${note}</li>`;
}

/**
 * 详情复制窗口（P6 历史）：目标路径 ← 复制来源路径@revision，逐层展示
 * 复制边界（嵌套复制按宿主给出的顺序排列）；boundaryRevision 标明复制
 * 发生的 revision。箭头是装饰符号，全部动态值转义。
 */
function renderCopyWindow(items: DetailCopyWindowSpec[], emptyText: string | undefined): string {
  if (items.length === 0) {
    return emptyText ? `<p class="muted">${escapeHtml(emptyText)}</p>` : '';
  }
  const rows = items.map((item) => {
    const target = `<span class="copy-window-path mono" title="${escapeHtml(item.targetPath)}">${escapeHtml(item.targetPath)}</span>`;
    const source = `<span class="copy-window-path mono" title="${escapeHtml(item.sourcePath)}">${escapeHtml(item.sourcePath)}</span>` +
      (item.sourceRevision !== undefined ? `<span class="mono">@r${escapeHtml(item.sourceRevision)}</span>` : '');
    const boundary = item.boundaryRevision !== undefined
      ? `<span class="copy-window-meta">r${escapeHtml(item.boundaryRevision)}</span>`
      : '';
    const note = item.note ? `<span class="copy-window-meta">${escapeHtml(item.note)}</span>` : '';
    return (
      `<div class="copy-window-item">${target}` +
      `<span class="copy-window-arrow" aria-hidden="true">←</span>${source}${boundary}${note}</div>`
    );
  }).join('');
  return `<div class="copy-window">${rows}</div>`;
}

/**
 * P5 节点行的扩展展示字段：宿主在 LazyTreeRowSpec 基础上按需提供，
 * 缺省时保持基础行、不渲染对应次级信息。所有文案（kindLabel/emptyText/
 * statusText/metadataCancelAction.label）由宿主经 i18n 生成，视图只排版
 * 与转义，不解释业务语义。
 *
 * 字段声明已上移到 state.ts 的 LazyTreeRowSpec（宿主按类型构建行）；
 * 此别名保留给既有渲染代码与测试使用。
 */
export type LazyTreeRowView = LazyTreeRowSpec;

/**
 * 懒树渲染只读取占用态与放行视图：整段渲染传完整 PanelState 即可，
 * 增量 append 片段可用同形状的轻量状态直接渲染，不必构建整帧状态。
 */
type LazyTreeRenderState = Pick<PanelState, 'busy' | 'writeLocked' | 'gate'>;

/**
 * P5 当前层懒加载树：节点行只承载已加载切片；展开/选择/重试是独立意图，
 * 展开不改变选中。行 DOM 复用既有转义与动作按钮，滚动由 pane 的
 * data-scroll-key 统一保持。
 *
 * 节点行结构（自上而下）：
 * 1. 主行：展开/选择、名称、类型徽标、自身元数据、加载状态、行内动作；
 * 2. 次级信息：`^/` 相对路径、原始节点 URL、最后修改（revision/author/date）；
 * 3. 状态行：两段式元数据补全占位/进度/取消、节点错误徽标、空目录徽标；
 * 4. tooLarge 降级说明（独立 alert 区）与已加载子节点切片。
 * 树容器与每个展开节点的子行容器都带 data-append-key：树容器用 tree.id，
 * 节点的 children 容器用 `${treeId}:${nodeId}`，宿主增量 append 消息据此
 * 只追加新增切片（每次 ≤40 个节点），不重复发送整棵树。
 */
function renderLazyTree(state: PanelState): string {
  const tree = state.lazyTree;
  if (!tree) {
    return '';
  }
  const rows = tree.rows.map((row) => renderLazyNode(state, row as LazyTreeRowView, tree.id)).join('');
  const empty = tree.rows.length === 0
    ? `<div class="empty"><h3>${escapeHtml(tree.empty.title)}</h3>${tree.empty.detail ? `<p class="muted">${escapeHtml(tree.empty.detail)}</p>` : ''}</div>`
    : '';
  // 加载更多的目标节点由宿主 payload[node-id] 提供；意图只带稳定节点 ID。
  const loadMoreNodeId = tree.loadMoreAction?.payload?.['node-id'] ?? '';
  const loadMore = tree.loadMoreAction
    ? `<div class="tree-load-more">${renderActionButton(
        withoutPayloadKey(tree.loadMoreAction, 'node-id'),
        {
          intent: tree.loadMoreAction.id,
          argName: 'data-node-id',
          argValue: loadMoreNodeId,
          extraId: '',
          gated: actionGated(state, tree.loadMoreAction.id),
        },
      )}</div>`
    : '';
  const busy = tree.busy ? `<div class="progress" role="status" aria-hidden="true"><i></i></div>` : '';
  const aria = tree.ariaLabel ? ` aria-label="${escapeHtml(tree.ariaLabel)}"` : '';
  return (
    `<div class="lazy-tree" role="tree" data-tree-id="${escapeHtml(tree.id)}"${aria}>` +
    `<div class="tree-rows" role="group" data-append-key="${escapeHtml(tree.id)}">${rows}</div>` +
    `${empty}${loadMore}${busy}</div>`
  );
}

/** 复制动作并去掉已提升为绑定参数的 payload 键（避免重复 data-* 属性）。 */
function withoutPayloadKey(action: ActionSpec, key: string): ActionSpec {
  if (!action.payload || !(key in action.payload)) {
    return action;
  }
  const payload = { ...action.payload };
  delete payload[key];
  return { ...action, payload };
}

/**
 * 渲染 P5 树节点追加片段（宿主 append 增量消息的 html 载荷）：
 * 调用方按宿主切片契约每次最多传 40 个新增节点，视图不再二次截断；
 * 片段只含节点行，不含树容器/空态/加载更多（它们由整段 render 维护）。
 * treeId 用于给片段内展开节点的 children 容器生成 `treeId:nodeId`
 * 定位键，保证后续 append 仍能唯一定位到该子树容器。
 */
export function renderLazyNodeSlice(
  state: LazyTreeRenderState,
  rows: LazyTreeRowSpec[],
  treeId: string,
): string {
  return rows.map((row) => renderLazyNode(state, row as LazyTreeRowView, treeId)).join('');
}

function renderLazyNode(state: LazyTreeRenderState, row: LazyTreeRowView, treeId: string): string {
  const id = escapeHtml(row.id);
  const isDir = row.kind === 'dir';
  const expanded = isDir && row.expanded === true;
  const selected = row.selected === true;
  const classes = [
    'tree-node',
    `kind-${row.kind}`,
    `phase-${row.phase}`,
    expanded ? 'expanded' : '',
    selected ? 'selected' : '',
  ].filter(Boolean).join(' ');
  const ariaExpanded = isDir ? ` aria-expanded="${expanded}"` : '';
  const indent = ` style="padding-left:${12 + row.depth * 16}px"`;
  const toggleLabel = row.expandLabel ? ` aria-label="${escapeHtml(row.expandLabel)}"` : '';
  const toggleGated = actionGated(state, 'toggleBrowserNode') || row.phase === 'loading';
  const toggle = isDir
    ? `<button type="button" class="node-toggle" data-intent="toggleBrowserNode" data-node-id="${id}" data-focus="node-toggle-${id}"${toggleLabel}${ariaExpanded}${toggleGated ? ' disabled' : ''}>${expanded ? '▾' : '▸'}</button>`
    : `<span class="node-spacer" aria-hidden="true"></span>`;
  const selectLabel = row.selectLabel ? ` aria-label="${escapeHtml(row.selectLabel)}"` : '';
  const label = `<button type="button" class="node-label" data-intent="selectBrowserNode" data-node-id="${id}" data-focus="node-select-${id}"${selectLabel}${actionGated(state, 'selectBrowserNode') ? ' disabled' : ''}>${escapeHtml(row.label)}</button>`;
  // 节点自身类型与元数据：kindLabel/metaText 均由宿主生成，缺省不渲染。
  const kind = row.kindLabel ? `<span class="node-kind">${escapeHtml(row.kindLabel)}</span>` : '';
  const size = row.metaText ? `<span class="node-size">${escapeHtml(row.metaText)}</span>` : '';
  const loading = row.phase === 'loading'
    ? `<span class="node-loading muted">${escapeHtml(strings.panel.nodeLoading)}</span>`
    : '';
  const status = row.statusText
    ? `<span class="node-status muted">${escapeHtml(row.statusText)}</span>`
    : '';
  const metadata = renderLazyMetadata(state, row);
  const actions = (row.actions ?? [])
    .map((action) =>
      renderActionButton(action, {
        intent: action.id,
        argName: 'data-node-id',
        argValue: row.id,
        extraId: '',
        gated: actionGated(state, action.id),
      }),
    )
    .join('');
  const acts = actions ? `<div class="acts">${actions}</div>` : '';
  const sub = renderLazyNodeSub(row);
  const flags = renderLazyNodeFlags(row, metadata);
  const children = expanded && row.children && row.children.length > 0
    ? `<div class="tree-node-children" role="group" data-append-key="${escapeHtml(`${treeId}:${row.id}`)}">${row.children.map((child) => renderLazyNode(state, child as LazyTreeRowView, treeId)).join('')}</div>`
    : '';
  return (
    `<div class="${classes}" role="treeitem" aria-level="${row.depth + 1}" aria-selected="${selected}" data-node-id="${id}"${indent}>` +
    `<div class="tree-node-row">${toggle}${label}${kind}${size}${loading}${status}${acts}</div>` +
    `${sub}${flags}${children}</div>`
  );
}

/**
 * 节点次级信息行：仓库相对路径、原始节点 URL、最后修改。
 * URL 与路径按原始值展示（不二次拼接），窄面板允许任意位置换行。
 */
function renderLazyNodeSub(row: LazyTreeRowView): string {
  const parts: string[] = [];
  if (row.repoPath) {
    parts.push(`<span class="node-repo-path mono">${escapeHtml(row.repoPath)}</span>`);
  }
  if (row.nodeUrl) {
    parts.push(
      `<span class="node-url mono" title="${escapeHtml(row.nodeUrl)}">${escapeHtml(row.nodeUrl)}</span>`,
    );
  }
  const changed = [row.lastChanged?.revision, row.lastChanged?.author, row.lastChanged?.date]
    .filter((value): value is string => Boolean(value));
  if (changed.length > 0) {
    const text = changed.join(' · ');
    parts.push(`<span class="node-last-changed">${escapeHtml(text)}</span>`);
  }
  if (parts.length === 0) {
    return '';
  }
  return `<div class="node-sub">${parts.join('')}</div>`;
}

/**
 * 节点状态行：两段式元数据补全占位/进度/取消、错误徽标与空目录徽标，
 * tooLarge 终态单独成块（role=alert），不把部分条目伪装成完整结果。
 * 空目录只由 ready + total=0 派生（协议语义：空目录不是错误）。
 */
function renderLazyNodeFlags(row: LazyTreeRowView, metadata: string): string {
  const emptyDir = row.phase === 'ready' && row.kind === 'dir' && row.total === 0;
  const badges: string[] = [];
  // tooLarge 是规模终态而非节点读取失败：只渲染降级说明，不叠加错误徽标。
  if (row.phase === 'error' && !row.tooLarge) {
    const detail = row.statusText ? ` title="${escapeHtml(row.statusText)}"` : '';
    badges.push(
      `<span class="node-error-badge"${detail}>${escapeHtml(strings.panel.nodeReadFailed)}</span>`,
    );
  }
  if (emptyDir && row.emptyText) {
    badges.push(`<span class="node-empty">${escapeHtml(row.emptyText)}</span>`);
  }
  const flags = [metadata, badges.join('')].filter(Boolean).join('');
  const tooLarge = row.tooLarge
    ? `<div class="node-limit" role="alert">${escapeHtml(row.statusText ?? '')}</div>`
    : '';
  if (!flags && !tooLarge) {
    return '';
  }
  return `${flags ? `<div class="node-flags">${flags}</div>` : ''}${tooLarge}`;
}

/**
 * 两段式加载的元数据占位/进度：只显示补全计数，不把首批数量当总数。
 * pending/filling/cancelled 都按宿主 i18n 文案展示；filling 时附加
 * 进度条与取消入口（取消动作由宿主提供，视图只附加稳定节点 ID）。
 */
function renderLazyMetadata(state: LazyTreeRenderState, row: LazyTreeRowView): string {
  const cancel = row.metadataCancelAction
    ? renderActionButton(row.metadataCancelAction, {
        intent: row.metadataCancelAction.id,
        argName: 'data-node-id',
        argValue: row.id,
        extraId: '',
        gated: actionGated(state, row.metadataCancelAction.id),
      })
    : '';
  if (row.metadata === 'pending') {
    // 未补全的行只显示占位符，完整说明放 title，避免逐行长文案挤压名称。
    return (
      `<span class="node-metadata pending" title="${escapeHtml(strings.panel.metadataPending)}">` +
      `<span class="node-pending muted" aria-hidden="true">—</span>${cancel}</span>`
    );
  }
  if (row.metadata === 'filling') {
    const progress = row.metadataProgress;
    const ratio = progress && progress.total > 0
      ? Math.min(1, Math.max(0, progress.completed / progress.total))
      : 0;
    const text = progress
      ? format(strings.panel.metadataFilling, {
          completed: String(progress.completed),
          total: String(progress.total),
        })
      : strings.panel.metadataPending;
    const numbers = progress
      ? `<span class="num">${progress.completed} / ${progress.total}</span>`
      : '';
    return (
      `<span class="node-metadata filling" title="${escapeHtml(text)}">` +
      `<span class="node-metadata-progress">` +
      `<span class="node-progress-bar" aria-hidden="true"><i style="width:${(ratio * 100).toFixed(1)}%"></i></span>` +
      `${numbers}</span>` +
      `<span class="node-metadata-text muted">${escapeHtml(text)}</span>${cancel}</span>`
    );
  }
  if (row.metadata === 'cancelled') {
    return (
      `<span class="node-metadata cancelled">` +
      `<span class="muted">${escapeHtml(strings.panel.metadataCancelled)}</span>${cancel}</span>`
    );
  }
  return '';
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
  const loadMore = renderTableLoadMore(state, table);
  if (table.rows.length === 0) {
    const filterActive = table.emptyMode !== undefined
      ? table.emptyMode === 'filterEmpty'
      : filters.some((filter) => (filter.kind === 'select' ? filter.value !== 'all' : filter.value !== ''));
    const empty = filterActive
      ? (table.filterEmpty ?? { title: strings.panel.filterEmptyTitle })
      : table.empty;
    const emptyNote = table.note ? `<p class="muted table-note">${escapeHtml(table.note)}</p>` : '';
    // append 模式下空态仍要保留“加载更多”：历史可能只是本页无匹配，
    // 后续原始批次尚未扫描（P6 noMatch 不允许丢失继续加载入口）。
    return `<section class="table-block" data-table-id="${escapeHtml(table.id)}">${filterBar}` +
      `<div class="empty"><h3>${escapeHtml(empty.title)}</h3>${empty.detail ? `<p class="muted">${escapeHtml(empty.detail)}</p>` : ''}</div>${loadMore}${emptyNote}</section>`;
  }
  const selectionEnabled = table.selection !== undefined;
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
  const allHeadCells = selectionEnabled
    ? `<th class="col select" scope="col"${table.selection?.ariaLabel ? ` aria-label="${escapeHtml(table.selection.ariaLabel)}"` : ''}></th>${headCells}`
    : headCells;
  const bodyRows = renderTableRows(state, table, table.rows);
  const append = pagination.mode === 'append';
  const hasPrev = pagination.page > 1;
  const hasNext = pagination.page < pagination.pageCount;
  // append 模式不渲染上一页/下一页：历史只能追加展示，不能翻页覆盖。
  const pager = !append && pagination.pageCount > 1
    ? `<div class="table-pager">` +
      `<button type="button" class="link" data-intent="setPage" data-page="${pagination.page - 1}" data-focus="table-page-prev"${!hasPrev || actionGated(state, 'setPage') ? ' disabled' : ''}>${escapeHtml(strings.panel.pagerPrev)}</button>` +
      `<span class="summary">${escapeHtml(format(strings.panel.pagerSummary, { page: String(pagination.page), pageCount: String(pagination.pageCount), total: String(pagination.total) }))}</span>` +
      `<button type="button" class="link" data-intent="setPage" data-page="${pagination.page + 1}" data-focus="table-page-next"${!hasNext || actionGated(state, 'setPage') ? ' disabled' : ''}>${escapeHtml(strings.panel.pagerNext)}</button>` +
      `</div>`
    : '';
  const note = table.note ? `<p class="muted table-note">${escapeHtml(table.note)}</p>` : '';
  // append 模式的 tbody 是增量追加目标：宿主经 append 消息按 table.id 定位，
  // 每次只追加 ≤historyPageSize 行，不重建表格、不丢滚动位置。
  const bodyKey = append ? ` data-append-key="${escapeHtml(table.id)}"` : '';
  return `<section class="table-block" data-table-id="${escapeHtml(table.id)}">${filterBar}` +
    `<div class="table-scroll" data-scroll-key="table-${escapeHtml(table.id)}"><table class="data-table">` +
    `<thead><tr>${allHeadCells}</tr></thead><tbody${bodyKey}>${bodyRows}</tbody></table></div>${pager}${loadMore}${note}</section>`;
}

/** 表格渲染只读取占用态与放行视图（append 片段与整表共用）。 */
export type TableRenderState = Pick<PanelState, 'busy' | 'writeLocked' | 'gate'>;

/**
 * 渲染表格行集合（整表 body 与 append 增量片段共用）：行点击只更新详情、
 * 勾选列只在 selection 存在时渲染；行内动作与行选中意图只带稳定行 ID。
 */
function renderTableRows(state: TableRenderState, table: TableSpec, rows: TableRowSpec[]): string {
  const selectionEnabled = table.selection !== undefined;
  return rows.map((row) => {
    const cells = table.columns.map((column) => {
      const align = column.align ? ` align-${column.align}` : '';
      const text = row.cells[column.key] ?? '';
      return `<td class="col${align}">${escapeHtml(text)}</td>`;
    }).join('');
    const selectionCell = selectionEnabled ? renderTableSelectionCell(state, row) : '';
    const actions = (row.actions ?? []).map((action) =>
      renderActionButton(action, {
        intent: action.id,
        argName: 'data-row-id',
        argValue: row.id,
        extraId: '',
        gated: actionGated(state, action.id),
      }),
    ).join('');
    const rowClass = row.selected ? ' class="selected"' : '';
    const ariaSelected = selectionEnabled ? ` aria-selected="${row.selected ? 'true' : 'false'}"` : '';
    const rowSelectIntent = table.rowSelectIntent ?? 'selectHistoryRevision';
    const selectIntent = actionGated(state, rowSelectIntent)
      ? ''
      : ` data-intent="${escapeHtml(rowSelectIntent)}" data-focus="table-row-${escapeHtml(row.id)}"`;
    return `<tr data-row-id="${escapeHtml(row.id)}"${rowClass}${ariaSelected}${selectIntent}>${selectionCell}${cells}${actions ? `<td class="col acts">${actions}</td>` : ''}</tr>`;
  }).join('');
}

/**
 * 渲染 P6 历史表格的追加行片段（宿主 append 增量消息的 html 载荷）：
 * 调用方按宿主切片契约每次最多传 historyPageSize 行，视图不再二次截断；
 * 片段只含 `<tr>`，不含 table/tbody/加载更多（它们由整段 render 维护）。
 */
export function renderTableRowSlice(
  state: TableRenderState,
  table: TableSpec,
  rows: TableRowSpec[],
): string {
  return renderTableRows(state, table, rows);
}

/**
 * append 模式“加载更多”页脚：按钮 + 本次/累计计数。
 * - summary / sessionSummary 是宿主 i18n 成品文本；summary 缺省时回退为
 *   「已展示 N 条 · 当前筛选可见 M 条」（N=当前展示前缀行数，
 *   M=TableSpec.pagination.total，即 visibleMatched），保证页脚始终显示
 *   累计计数而不依赖宿主额外字段；
 * - thisLoad 的原始回包数与本轮唯一 revision 数均为 0 时隐藏“本轮”行
 *   （pending-only 展示不得沿用上一次网络动作的值）；非 0 时用与宿主
 *   相同的 historyPanel 模板格式化。
 */
function renderTableLoadMore(state: TableRenderState, table: TableSpec): string {
  if (table.pagination.mode !== 'append' || !table.loadMoreAction) {
    return '';
  }
  const info = table.loadMoreInfo;
  const summary = info?.summary
    ? `<span class="load-more-summary">${escapeHtml(info.summary)}</span>`
    : `<span class="load-more-summary">` +
      `${escapeHtml(format(strings.historyPanel.displayedSummary, { displayed: String(table.rows.length) }))} · ` +
      `${escapeHtml(format(strings.historyPanel.visibleSummary, { visible: String(table.pagination.total) }))}</span>`;
  const session = info?.sessionSummary
    ? `<span class="load-more-session">${escapeHtml(info.sessionSummary)}</span>`
    : '';
  const thisLoad = info?.thisLoad;
  const showThisLoad = thisLoad !== undefined && (thisLoad.rawFetched > 0 || thisLoad.uniqueScanned > 0);
  const thisLoadHtml = showThisLoad
    ? `<span class="load-more-this-load">` +
      `${escapeHtml(format(strings.historyPanel.scannedThisLoad, { count: String(thisLoad.rawFetched) }))} · ` +
      `${escapeHtml(format(strings.historyPanel.uniqueRevisionsThisLoad, { count: String(thisLoad.uniqueScanned) }))}</span>`
    : '';
  const infoHtml = summary || session || thisLoadHtml
    ? `<span class="table-load-more-info">${summary}${session}${thisLoadHtml}</span>`
    : '';
  return `<div class="table-load-more">${renderActionButton(table.loadMoreAction, {
    intent: table.loadMoreAction.id,
    argName: 'data-table-id',
    argValue: table.id,
    extraId: '',
    gated: actionGated(state, table.loadMoreAction.id),
  })}${infoHtml}</div>`;
}

/** 表格行勾选单元格：maxSelected 上限由宿主与应用层共同保证，这里只渲染状态。 */
function renderTableSelectionCell(
  state: Pick<PanelState, 'busy' | 'writeLocked' | 'gate'>,
  row: TableSpec['rows'][number],
): string {
  const label = row.selectionLabel ?? row.id;
  const title = row.disabledReason ?? label;
  const disabled = row.disabled || actionGated(state, 'toggleHistoryRevision');
  return (
    `<td class="col select"><input type="checkbox" data-intent="toggleHistoryRevision"` +
    ` data-row-id="${escapeHtml(row.id)}" data-focus="table-select-${escapeHtml(row.id)}"` +
    ` aria-label="${escapeHtml(label)}" title="${escapeHtml(title)}"` +
    `${row.selected ? ' checked' : ''}${disabled ? ' disabled' : ''}></td>`
  );
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
  if (filterId === 'previewPath') {
    return strings.panel.filterPreviewPath;
  }
  if (filterId === 'previewState') {
    return strings.panel.filterPreviewState;
  }
  if (filterId === 'path') {
    return strings.panel.filterPreviewPath;
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
  return `<div class="list" data-focus="list" data-scroll-key="list" role="list">${body}</div>`;
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
  // 空 argName 表示动作参数完全来自 payload（P7 属性值选择/确认按钮等）：
  // 不输出绑定属性，data-focus 退化为意图名，避免空的 data-* 绑定。
  const bindingAttr = binding.argName
    ? ` ${binding.argName}="${escapeHtml(binding.argValue)}"`
    : '';
  const focusKey = binding.argName ? `${binding.intent}-${binding.argValue}` : binding.intent;
  return `<button type="button" class="row-act" data-intent="${escapeHtml(binding.intent)}"${bindingAttr}${extra}${payload} data-focus="${escapeHtml(focusKey)}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"${disabled}>${escapeHtml(action.label)}</button>`;
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
