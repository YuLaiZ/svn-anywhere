/**
 * 面板状态与纯 reducer。不依赖 vscode，可在 vitest 中直接测试。
 *
 * 状态形状是「渲染模型」：宿主把业务数据（status 解析结果等）转换成
 * ListSpec / FormSpec / BannerSpec，view.ts 只负责把它变成 HTML。
 * P1/P2 的业务状态（CommitPanelState / IgnorePanelState，见 fixture.ts）
 * 由各自控制器在阶段 1/2 落地时映射到这里，不在视图层出现第二份真相。
 *
 * 交互契约（交互状态清单）：
 * - 筛选只改变可见性，保留全局选择；
 * - busy 期间所有写意图（筛选、勾选、动作）一律拒绝——事件守卫与
 *   DOM 禁用必须一致，reducer 是最后一道防线；
 * - 输入同步按 formRevision 递增，普通输入不触发整段重绘。
 */

/** 行内或提示条上的动作按钮。意图经 data-intent 转发，不带路径。 */
export interface ActionSpec {
  id: string;
  label: string;
  icon?: string;
  disabled?: boolean;
  /** 禁用原因：可访问名称与 title 都用它，让不可用可解释。 */
  disabledReason?: string;
  /** 附加意图参数：渲染为 data-* 属性，视图转发时原样带上（如前缀序号）。 */
  payload?: Record<string, string>;
}

export interface RowSpec {
  id: string;
  group?: string;
  /** 稳定展示键 → 单元格文本；路径、状态等一律原值，不 trim。 */
  cells: Record<string, string>;
  /** 行显示名（树内文件名 / 目录条目类型名）；缺省由 cells.path 派生。 */
  label?: string;
  badges?: Array<{ text: string; kind?: 'muted' | 'warn' }>;
  selected?: boolean;
  /** 复选框半选态（目录聚合/组头的派生结果，渲染为 indeterminate）。 */
  indeterminate?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  actions?: ActionSpec[];
  /**
   * 导航目录节点：只组织路径，不是 SVN 提交目标；勾选是「聚合筛选后子树」
   * 的意图，展开/折叠是视图瞬时状态。折叠 key 用 id。
   */
  nav?: { path: string };
  /** M2 本地变更路径树；导航节点与条目行统一用 children 嵌套。 */
  children?: RowSpec[];
}

export interface FilterSpec {
  id: string;
  /** 筛选值；'all' 是基座约定的「不过滤」哨兵，业务值由宿主保证不与其冲突。 */
  value: string;
  options: Array<{ value: string; label: string }>;
  /** 该筛选匹配的单元格键：row.cells[cellKey] === value 视为命中。 */
  cellKey: string;
}

export interface ListSpec {
  id: string;
  columns: Array<{ key: string; label: string }>;
  groups?: Array<{
    id: string;
    label: string;
    /** 组条目数与选择态由渲染层从 rows+filters 派生（不保留第二份真相）；
     * 这里的静态值仅作为无 rows 时的兜底。 */
    count?: number;
    selection?: 'none' | 'some' | 'all' | 'disabled';
  }>;
  rows: RowSpec[];
  filters?: FilterSpec[];
  /** 渲染模式：树形（嵌套 + 导航目录）或平铺列表；切换不改变选择与筛选。 */
  viewMode?: 'tree' | 'list';
  /** 选择工具条上的链接动作（选择可见可提交项 / 清空 / 整组 changelist 选择）。 */
  selectionActions?: ActionSpec[];
  /** 选择计数（reducer 在筛选变化后重算）：全局已选、可见已选、被筛选隐藏的已选。 */
  selection: { total: number; visible: number; hidden: number };
  /** 无任何条目时的空态。 */
  empty: { title: string; detail?: string; action?: ActionSpec };
  /** 有条目但筛选后无匹配的空态；筛选保留全局选择。 */
  filterEmpty?: { title: string; detail?: string; action?: ActionSpec };
}

export interface FormFieldSpec {
  id: string;
  label: string;
  value: string;
  type: 'text' | 'textarea' | 'select';
  options?: Array<{ value: string; label: string }>;
  disabled?: boolean;
  error?: string;
  help?: string;
}

export interface FormSpec {
  id: string;
  fields: FormFieldSpec[];
  /** 说明区工具条动作（前缀 chips / 前缀管理 / 历史），意图经 formAction 转发。 */
  tools?: ActionSpec[];
  busy: boolean;
  /** 表单内容与读取/保存基线的比较结论；阶段 2（P2）启用。 */
  dirty?: boolean;
  /** 待加入输入存在尚未确认的模式；阶段 2（P2）启用。 */
  pendingInput?: boolean;
}

export interface BannerSpec {
  id: string;
  level: 'info' | 'success' | 'warn' | 'error';
  title: string;
  detail?: string;
  /** detail 按预格式文本展示（stderr 等原样输出）。 */
  preformatted?: boolean;
  actions?: ActionSpec[];
}

/** 页脚动作区：摘要 + 主按钮 + 次按钮（关闭/提交等）。 */
export interface FooterSpec {
  summary: string;
  primary?: ActionSpec;
  secondary?: ActionSpec[];
}

/** 宿主 → 视图的渲染状态。 */
export interface PanelState {
  /** 当前会话代次：目标切换即更换，异步结果须校验后才允许写入。 */
  sessionId: string;
  /** 面板标题区：目标展示名（宿主用 i18n 生成，非拼好的中文文案透传）。 */
  title: string;
  targetLabel: string;
  /** 界面更新序号：宿主每次成功渲染递增。 */
  revision: number;
  /** 表单输入序号：宿主确认一次输入同步后递增。 */
  formRevision: number;
  busy: boolean;
  /**
   * 写锁定：提交结果未知/待协调等期间，除核实/重读外的全部写意图被拒绝，
   * DOM 渲染同步禁用（含动态构建的目录聚合复选框与折叠按钮）。
   */
  writeLocked?: boolean;
  banners: BannerSpec[];
  list?: ListSpec;
  form?: FormSpec;
  footer?: FooterSpec;
}

/** reducer 的输入事件：视图意图（intent: 前缀）与宿主内部事件（host: 前缀）。 */
export type PanelEvent =
  | { type: 'intent:dismissBanner'; bannerId: string }
  | { type: 'intent:setFilter'; filterId: string; value: string }
  | { type: 'intent:toggleRow'; rowId: string; selected: boolean }
  | { type: 'intent:toggleGroup'; groupId: string; selected: boolean }
  | { type: 'intent:toggleTree'; nodeId: string; selected: boolean }
  | { type: 'intent:setView'; view: 'tree' | 'list' }
  | { type: 'intent:selectVisible' }
  | { type: 'intent:clearSelection' }
  | { type: 'intent:syncInput'; fieldId: string; value: string }
  | { type: 'host:beginBusy' }
  | { type: 'host:endBusy' }
  | { type: 'host:snapshot'; patch: Partial<Omit<PanelState, 'sessionId'>> };

export function reduce(state: PanelState, event: PanelEvent): PanelState {
  switch (event.type) {
    case 'intent:dismissBanner': {
      if (state.busy || state.writeLocked) {
        return state;
      }
      if (!state.banners.some((banner) => banner.id === event.bannerId)) {
        return state;
      }
      return { ...state, banners: state.banners.filter((banner) => banner.id !== event.bannerId) };
    }
    case 'intent:setFilter': {
      if (state.busy || state.writeLocked) {
        return state;
      }
      const list = state.list;
      if (!list?.filters?.some((filter) => filter.id === event.filterId)) {
        return state;
      }
      const filters = list.filters.map((filter) =>
        filter.id === event.filterId ? { ...filter, value: event.value } : filter,
      );
      const withFilters = { ...list, filters };
      return { ...state, list: { ...withFilters, selection: countSelection(withFilters) } };
    }
    case 'intent:toggleRow': {
      if (state.busy || state.writeLocked) {
        return state;
      }
      const list = state.list;
      const row = list && findRow(list.rows, event.rowId);
      if (!list || !row || row.nav || row.disabled) {
        return state;
      }
      const nextRows = mapRows(list.rows, (candidate) =>
        candidate.id === event.rowId ? { ...candidate, selected: event.selected } : candidate,
      );
      const nextList = { ...list, rows: nextRows };
      return { ...state, list: { ...nextList, selection: countSelection(nextList) } };
    }
    case 'intent:toggleGroup': {
      // 组头勾选只作用于「当前可见（命中筛选）且可提交」的行。
      const list = rejectWhenLocked(state);
      if (!list) {
        return state;
      }
      const nextRows = mapSelectableVisible(list.rows, list.filters, (row) =>
        row.group === event.groupId ? { ...row, selected: event.selected } : row,
      );
      const nextList = { ...list, rows: nextRows };
      return { ...state, list: { ...nextList, selection: countSelection(nextList) } };
    }
    case 'intent:toggleTree': {
      // 目录聚合勾选作用于筛选后子树内可提交的行；折叠不缩小其范围。
      const list = rejectWhenLocked(state);
      if (!list || !findRow(list.rows, event.nodeId)?.nav) {
        return state;
      }
      const applySubtree = (rows: RowSpec[]): RowSpec[] =>
        mapSelectableVisible(rows, list.filters, (row) => ({ ...row, selected: event.selected }));
      const nextRows = walkRows(list.rows, (row) =>
        row.id === event.nodeId && row.nav
          ? { ...row, children: applySubtree(row.children ?? []) }
          : undefined,
      );
      const nextList = { ...list, rows: nextRows };
      return { ...state, list: { ...nextList, selection: countSelection(nextList) } };
    }
    case 'intent:setView': {
      const list = rejectWhenLocked(state);
      if (!list) {
        return state;
      }
      return { ...state, list: { ...list, viewMode: event.view } };
    }
    case 'intent:selectVisible': {
      const list = rejectWhenLocked(state);
      if (!list) {
        return state;
      }
      const nextRows = mapSelectableVisible(list.rows, list.filters, (row) => ({ ...row, selected: true }));
      const nextList = { ...list, rows: nextRows };
      return { ...state, list: { ...nextList, selection: countSelection(nextList) } };
    }
    case 'intent:clearSelection': {
      const list = rejectWhenLocked(state);
      if (!list) {
        return state;
      }
      const nextRows = mapRows(list.rows, (row) => ({ ...row, selected: false }));
      const nextList = { ...list, rows: nextRows };
      return { ...state, list: { ...nextList, selection: countSelection(nextList) } };
    }
    case 'intent:syncInput': {
      if (state.writeLocked) {
        return state;
      }
      const form = state.form;
      const field = form?.fields.find((candidate) => candidate.id === event.fieldId);
      if (!form || !field || field.disabled) {
        return state;
      }
      const fields = form.fields.map((candidate) =>
        candidate.id === event.fieldId ? { ...candidate, value: event.value } : candidate,
      );
      return { ...state, form: { ...form, fields }, formRevision: state.formRevision + 1 };
    }
    case 'host:beginBusy': {
      if (state.busy) {
        return state;
      }
      return { ...state, busy: true };
    }
    case 'host:endBusy': {
      if (!state.busy) {
        return state;
      }
      return { ...state, busy: false };
    }
    case 'host:snapshot': {
      // 异步读取/刷新完成后整体替换数据；formRevision 不回退，视图侧
      // 用它防止未确认输入被旧序号覆盖。
      const merged = { ...state, ...event.patch, sessionId: state.sessionId };
      if (merged.list) {
        merged.list = { ...merged.list, selection: countSelection(merged.list) };
      }
      return merged;
    }
  }
}

/** 在（可能嵌套的）行集合中按 ID 查找；ID 即条目身份，保留原值。 */
export function findRow(rows: RowSpec[], id: string): RowSpec | undefined {
  for (const row of rows) {
    if (row.id === id) {
      return row;
    }
    if (row.children) {
      const hit = findRow(row.children, id);
      if (hit) {
        return hit;
      }
    }
  }
  return undefined;
}

/** 结构不变地变换（可能嵌套的）行集合。 */
export function mapRows(rows: RowSpec[], transform: (row: RowSpec) => RowSpec): RowSpec[] {
  return rows.map((row) => {
    const next = transform(row);
    return row.children ? { ...next, children: mapRows(row.children, transform) } : next;
  });
}

/**
 * 递归遍历行树：transform 返回 undefined 表示保持该节点原样（仍递归其子行）；
 * 返回新行则整体替换该节点（不再递归旧 children，由 transform 自行处理）。
 */
export function walkRows(rows: RowSpec[], transform: (row: RowSpec) => RowSpec | undefined): RowSpec[] {
  return rows.map((row) => {
    const replaced = transform(row);
    if (replaced) {
      return replaced;
    }
    return row.children ? { ...row, children: walkRows(row.children, transform) } : row;
  });
}

/** 变换「命中筛选且未禁用」的条目行（导航节点只递归不变换）。 */
function mapSelectableVisible(
  rows: RowSpec[],
  filters: FilterSpec[] | undefined,
  transform: (row: RowSpec) => RowSpec,
): RowSpec[] {
  return rows.map((row) => {
    if (row.nav) {
      return { ...row, children: mapSelectableVisible(row.children ?? [], filters, transform) };
    }
    const next = rowMatchesFilters(row, filters) && !row.disabled ? transform(row) : row;
    return row.children ? { ...next, children: mapSelectableVisible(row.children, filters, transform) } : next;
  });
}

/** 写/锁定期间返回 undefined，调用方据此保持原状态。 */
function rejectWhenLocked(state: PanelState): ListSpec | undefined {
  if (state.busy || state.writeLocked) {
    return undefined;
  }
  return state.list;
}

/** 行是否命中全部筛选（筛选叠加；'all' 哨兵不过滤）。筛选只改可见性。 */
export function rowMatchesFilters(row: RowSpec, filters?: FilterSpec[]): boolean {
  if (!filters || filters.length === 0) {
    return true;
  }
  if (row.nav) {
    // 导航节点自身不参与筛选（是否保留由「有命中后代」决定）。
    return true;
  }
  return filters.every((filter) => filter.value === 'all' || row.cells[filter.cellKey] === filter.value);
}

/**
 * 当前可见行（命中筛选的条目行，导航目录不计入；嵌套树中命中行会连同
 * 所在位置由渲染层保留祖先）。计数与组头勾选都以这里的语义为准。
 */
export function visibleRows(rows: RowSpec[], filters?: FilterSpec[]): RowSpec[] {
  return rows.flatMap((row) => {
    const own = !row.nav && rowMatchesFilters(row, filters) ? [row] : [];
    return row.children ? [...own, ...visibleRows(row.children, filters)] : own;
  });
}

/** 重算选择计数：全局已选 / 可见已选 / 被筛选隐藏的已选。 */
export function countSelection(list: ListSpec): ListSpec['selection'] {
  const selectedAll = collectSelected(list.rows).length;
  const selectedVisible = collectSelected(visibleRows(list.rows, list.filters)).length;
  return { total: selectedAll, visible: selectedVisible, hidden: selectedAll - selectedVisible };
}

/** 收集已选行（导航节点无选择态，天然跳过）。 */
export function collectSelectedRows(rows: RowSpec[]): RowSpec[] {
  return rows.flatMap((row) => {
    const own = row.selected ? [row] : [];
    return row.children ? [...own, ...collectSelectedRows(row.children)] : own;
  });
}

/** 递归收集全部条目行（非导航节点），供分组计数与平铺渲染。 */
export function collectLeafRows(rows: RowSpec[]): RowSpec[] {
  return rows.flatMap((row) => {
    const own = row.nav ? [] : [row];
    return row.children ? [...own, ...collectLeafRows(row.children)] : own;
  });
}

function collectSelected(rows: RowSpec[]): RowSpec[] {
  return collectSelectedRows(rows);
}
