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
  /**
   * checkbox 是布尔勾选控件：value 仍为 string、取值 'true'/'false'
   * （勾选态由 value 派生，不引入 boolean 字段造成两份真相）；勾选
   * 变化经输入同步通道以派生值发送，disabled/error/help 语义沿用。
   */
  type: 'text' | 'textarea' | 'select' | 'checkbox';
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
  /**
   * 是否渲染关闭 ×（默认 true，既有横幅渲染行为不变）。持久的判定性提示
   * （如 P1 foreign 分流指引）设 false：不渲染 ×——writeLocked 态渲染可点
   * 被拒的关闭按钮与「事件守卫和 DOM 禁用一致」纪律冲突，且该类提示由
   * loadSession 判定重写、无手动关闭需求。
   */
  dismissable?: boolean;
}

/** 页脚动作区：摘要 + 主按钮 + 次按钮（关闭/提交等）。 */
export interface FooterSpec {
  summary: string;
  primary?: ActionSpec;
  secondary?: ActionSpec[];
}

/** 标题区状态徽标（P2：未保存/待提交/待核实等）。 */
export interface HeaderBadgeSpec {
  text: string;
  warn?: boolean;
}

/**
 * P2 规则编辑器：规则列表与待加入输入分开（交互清单 P2）。
 * 规则按行原样展示（含首尾空格），移除按行序号定位；待加入输入经
 * syncInput 同步、addRule 确认入列，未处理前不保存/提交。
 */
export interface IgnoreEditorSpec {
  /** 规则行：index 为当前列表序号（意图 removeRule 的载荷）。 */
  rules: Array<{ index: number; text: string }>;
  /** 规则列表容器 aria-label。 */
  listLabel: string;
  /** 移除一行的可访问名称（含规则文本）。 */
  removeLabel: string;
  /** 无规则时的空态（未设置属性、已清空待删除、读取失败三种由宿主区分）。 */
  empty: { title: string; detail?: string; extra?: string };
  /** 待加入输入（fieldId 参与输入同步与序号防回退）。 */
  draft: {
    fieldId: string;
    label: string;
    value: string;
    placeholder: string;
    disabled?: boolean;
  };
  /** 输入区下方说明：通配符与路径限制。 */
  addNote: string;
  /** 有 originName 时的「用当前项名」说明；与 noOriginNote 二选一。 */
  originNote?: string;
  noOriginNote?: string;
  /** 加入按钮：draft 为空或锁定时禁用（宿主派生并给出原因）。 */
  addAction: ActionSpec;
  /** 用当前项名：目录入口无 originName 时不渲染（避免目录名写入自身的歧义动作）。 */
  fillAction?: ActionSpec;
  /** 编辑区整体忙碌/锁定（busy/writeLocked 时禁用全部控件）。 */
  busy?: boolean;
}

/** 表格列：sortable 缺省不可排序；sortType 声明排序值类型（见 TableSpec.rows）。 */
export interface TableColumnSpec {
  key: string;
  label: string;
  align?: 'left' | 'right';
  /** 是否渲染列头排序按钮（缺省不排序）。 */
  sortable?: boolean;
  /**
   * 排序值类型：'number' 列宿主按业务数值排序（如大文件的字节值），
   * 不按 cells 展示字符串（否则「100 B」会排在「9 GiB」前）；缺省 'string'。
   * 排序值只存在于宿主侧（见 SortableTableRow.sortValues），不进消息。
   */
  sortType?: 'string' | 'number';
}

/** 表格筛选：kind 决定匹配方式，cellKey 绑定作用列（columns.key）。 */
export interface TableFilterSpec {
  id: string;
  /**
   * 'text'：作用列单元格值的大小写不敏感子串匹配（宿主侧执行）；
   * 'select'：作用列单元格值精确匹配（'all' 哨兵不过滤）。
   */
  kind: 'text' | 'select';
  cellKey: string;
  value: string;
  /** kind='select' 必填。 */
  options?: Array<{ value: string; label: string }>;
}

/** 表格行：cells 恒为展示文本；行内动作按行 ID 由宿主映射目标。 */
export interface TableRowSpec {
  id: string;
  cells: Record<string, string>;
  actions?: ActionSpec[];
}

/**
 * 表格组件：与 list（树/勾选语义）并列的展示组件——排序/筛选/分页
 * 的语义都在表格上。宿主持有全量数据并完成排序/筛选/分页切片
 * （sliceTableRows），视图只收当前页行：消息体积与总行数无关。
 */
export interface TableSpec {
  id: string;
  columns: Array<TableColumnSpec>;
  /** 当前排序（渲染指示用；切片在宿主侧完成）。 */
  sort: { key: string; direction: 'asc' | 'desc' };
  filters?: TableFilterSpec[];
  /** 分页：page 从 1 起；total 为筛选后总数、pageCount 为筛选后总页数。 */
  pagination: { page: number; pageSize: number; total: number; pageCount: number };
  rows: TableRowSpec[];
  /** 无任何条目时的空态。 */
  empty: { title: string; detail?: string };
  /** 有条目但筛选后无匹配的空态。 */
  filterEmpty?: { title: string; detail?: string };
  /** 表格下方标注（如「部分结果」）。 */
  note?: string;
}

/**
 * 宿主侧表格切片的输入行：在渲染行之上补充按列的业务排序值——
 * 数值列（sortType='number'）给业务数值（如字节值），使排序不依赖
 * 展示文本；sortValues 只存在于宿主内存，不随 TableSpec 进消息。
 */
export interface SortableTableRow<R extends TableRowSpec = TableRowSpec> {
  row: R;
  /** 列 key → 业务排序值；缺省回退该列展示文本按字符串比较。 */
  sortValues?: Record<string, string | number>;
}

/** 表格切片结果：携带收敛后的页码与筛选后计数，供 TableSpec.pagination 填写。 */
export interface TableSlice<R extends TableRowSpec = TableRowSpec> {
  rows: R[];
  /** 筛选后总行数。 */
  total: number;
  /** 筛选后总页数（无行时为 1，空态仍占一页）。 */
  pageCount: number;
  /** 收敛后的当前页码（越界回收到最后一页）。 */
  page: number;
}

/**
 * 数值卡（P4 空间概览与清理前后对比卡的承载组件）：value 是宿主完成
 * MiB/GiB 换算后的成品展示文本，业务字节值留在宿主模型内、不进消息；
 * unit 可选（value 已并入单位时不填）。
 */
export interface MetricSpec {
  caption: string;
  value: string;
  unit?: string;
}

/**
 * 占比条分段：bytes 原始值仅用于比例计算（webview 按 bytes / totalBytes
 * 占比渲染分段宽度），从属分层（如 .svn 内再分 pristine/其他）由宿主
 * 组段表达；color 可选覆盖（缺省按段序取主题 chart 色板）。
 */
export interface SpaceBarSegment {
  /** 稳定段标识（可选，供测试定位）。 */
  key?: string;
  label: string;
  bytes: number;
  color?: string;
}

/** 占比条组件：与 metrics 并列的 P4 基线组件（不自造 webview 结构）。 */
export interface SpaceBarSpec {
  segments: SpaceBarSegment[];
  /** 比例计算基准（通常为总量合计）；<= 0 时各段宽度按 0 渲染。 */
  totalBytes: number;
}

/**
 * 表格排序/筛选/分页切片（宿主侧执行）：
 * - 筛选按 filters 顺序叠加——text 为作用列单元格值的大小写不敏感
 *   子串匹配，select 为精确匹配（'all' 哨兵不过滤）；
 * - 排序先按声明列的排序值（sortValues 优先、回退展示文本）比较，
 *   同值保持原序（稳定排序）；
 * - 分页从 1 起计，请求页越界时收敛到最后一页。
 */
export function sliceTableRows<R extends TableRowSpec>(
  items: readonly SortableTableRow<R>[],
  columns: readonly TableColumnSpec[],
  sort: { key: string; direction: 'asc' | 'desc' },
  filters: readonly TableFilterSpec[] | undefined,
  page: number,
  pageSize: number,
): TableSlice<R> {
  const active = (filters ?? []).filter((filter) =>
    filter.kind === 'select' ? filter.value !== 'all' : filter.value !== '',
  );
  const matched = items.filter(({ row }) =>
    active.every((filter) => {
      const cell = row.cells[filter.cellKey] ?? '';
      return filter.kind === 'select'
        ? cell === filter.value
        : cell.toLowerCase().includes(filter.value.toLowerCase());
    }),
  );
  const column = columns.find((candidate) => candidate.key === sort.key);
  const direction = sort.direction === 'desc' ? -1 : 1;
  const sorted = matched
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const compared = compareByColumn(left.item, right.item, sort.key, column?.sortType);
      return compared !== 0 ? compared * direction : left.index - right.index;
    })
    .map(({ item }) => item);
  const safePageSize = pageSize > 0 ? pageSize : 1;
  const pageCount = Math.max(1, Math.ceil(sorted.length / safePageSize));
  const safePage = Math.min(Math.max(1, Math.floor(page)), pageCount);
  const start = (safePage - 1) * safePageSize;
  return {
    rows: sorted.slice(start, start + safePageSize).map(({ row }) => row),
    total: sorted.length,
    pageCount,
    page: safePage,
  };
}

function compareByColumn(
  left: SortableTableRow,
  right: SortableTableRow,
  key: string,
  sortType: TableColumnSpec['sortType'] | undefined,
): number {
  if (sortType === 'number') {
    const leftValue = toNumber(left.sortValues?.[key] ?? left.row.cells[key]);
    const rightValue = toNumber(right.sortValues?.[key] ?? right.row.cells[key]);
    return leftValue - rightValue;
  }
  const leftValue = String(left.sortValues?.[key] ?? left.row.cells[key] ?? '');
  const rightValue = String(right.sortValues?.[key] ?? right.row.cells[key] ?? '');
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

/** 数值列的排序值兜底：非有限数值按 0 参与比较（保持顺序确定）。 */
function toNumber(value: string | number | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
  /** 标题区状态徽标（P2；P1 未用）。 */
  headerBadges?: HeaderBadgeSpec[];
  /** 标题区动作（如 P2「重新读取」）。 */
  headerActions?: ActionSpec[];
  /** 标题区与横幅之间的固定说明（P2 规则作用范围）。 */
  hint?: string;
  /** P2 规则编辑区（规则列表 + 待加入输入）。 */
  ignoreEditor?: IgnoreEditorSpec;
  /** 表格（与大文件/导入核对文件列表并列的展示组件；宿主已切片）。 */
  table?: TableSpec;
  /**
   * 数值卡组（P4 空间概览与清理前后对比卡）：宿主完成格式化后填入，
   * 清理前后对比用同一组件、不另设 before-after 组件；M2 面板不引用。
   */
  metrics?: MetricSpec[];
  /** 占比条（P4 空间构成）：按 segments[].bytes 比例分段渲染；M2 面板不引用。 */
  spaceBar?: SpaceBarSpec;
  /**
   * 向导步骤条：labels 为各步名称、current 为当前步下标（0 起）。
   * 当前步高亮由步骤条自身承载，不用 headerBadges（其只有 text/warn，
   * 表达不了正常态高亮）。
   */
  steps?: { labels: string[]; current: number };
  /**
   * 占用态（busy/writeLocked）下的可交互动作集：宿主渲染前从面板
   * 放行表求值谓词后推导（同源生成）。视图据此禁用通用控件；未携带
   * 时占用态一律禁用（提交/忽略面板现状——守卫放行迟到输入不代表
   * DOM 解禁输入控件）。
   */
  gate?: { busy: string[]; writeLocked: string[] };
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
