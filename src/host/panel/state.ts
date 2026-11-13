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
  /** 行勾选态（仅在 TableSpec.selection 存在时渲染复选框）。 */
  selected?: boolean;
  /** 不可勾选的行（如 revision 节点不存在/无权限）；原因给 title 与 aria-label。 */
  disabled?: boolean;
  disabledReason?: string;
  /** 勾选框的可访问名称（宿主 i18n；缺省回退行 ID，不伪造业务语义）。 */
  selectionLabel?: string;
}

/**
 * 表格选择契约（P6 revision 勾选）：
 * - 'revision' 允许最多两项（硬上限 2，第三个选择由宿主提示）；
 * - 'single' 只允许一项，选新行自动清旧行。
 * 纯函数 applyTableSelection 是勾选上限的最后一道防线，视图与宿主共用。
 */
export interface TableSelectionSpec {
  mode: 'revision' | 'single';
  /** 最大可选数：revision 模式缺省 2 且不超过 2；single 模式固定 1。 */
  maxSelected?: number;
  /** 勾选列头的可访问名称（宿主 i18n；缺省只渲染空表头）。 */
  ariaLabel?: string;
}

/**
 * append 模式“加载更多”页脚的计数信息（P6 历史）：
 * - summary / sessionSummary 是宿主经 i18n 格式化的成品文本（已显示前缀、
 *   会话累计扫描/命中），视图只排版不重算业务计数；
 * - thisLoad 是本轮网络统计（rawFetchedInLoad / scannedThisLoad.size）：
 *   两个字段都为 0 时视图隐藏“本轮”行——pending-only 展示不得沿用上一次
 *   网络动作的值，也不显示全 0 的空行。
 */
export interface TableLoadMoreInfo {
  /** 当前展示前缀摘要（宿主 i18n，如「已显示 50 / 共 120 条」）。 */
  summary?: string;
  /** 会话累计摘要（宿主 i18n，如「会话已扫描 1,000 条 revision」）。 */
  sessionSummary?: string;
  /** 本轮网络统计；缺省或全 0 时隐藏“本轮”行。 */
  thisLoad?: { rawFetched: number; uniqueScanned: number };
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
  /**
   * 分页：page 从 1 起；total 为筛选后总数、pageCount 为筛选后总页数。
   * mode='append'（P6 历史累计展示）固定 page=1/pageCount=1，rows 为当前
   * 已展示前缀，total=visibleMatched，pageSize=max(1, displayedCount)；
   * renderer 不渲染上一页/下一页，只渲染外部“加载更多”动作，历史列表
   * 不因翻页覆盖已展示记录。缺省 'page' 保持既有表格行为。
   */
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    pageCount: number;
    mode?: 'page' | 'append';
  };
  rows: TableRowSpec[];
  /** 勾选契约（P6 revision 勾选）；缺省不渲染勾选列。 */
  selection?: TableSelectionSpec;
  /**
   * 行点击选中/查看详情的意图名（缺省 selectHistoryRevision：P6 历史行
   * 只更新详情）。比较候选表等复用同一表格时可覆盖为对应冻结动作。
   */
  rowSelectIntent?: string;
  /** append 模式的“加载更多”外部动作（意图只带稳定 ID，宿主自行切片）。 */
  loadMoreAction?: ActionSpec;
  /** append 模式加载更多旁的本次/累计计数（缺省只渲染按钮）。 */
  loadMoreInfo?: TableLoadMoreInfo;
  /** 无任何条目时的空态。 */
  empty: { title: string; detail?: string };
  /** 有条目但筛选后无匹配的空态。 */
  filterEmpty?: { title: string; detail?: string };
  /**
   * 无行时选择哪个空态：缺省按 TableSpec.filters 是否活跃推导（既有表格）。
   * P6 历史筛选在宿主侧完成、不使用 TableSpec.filters，由会话分类
   * （empty/noMatch）显式指定，保证两种空态不互相冒充。
   */
  emptyMode?: 'empty' | 'filterEmpty';
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
  const sorted = filteredSortedRows(items, columns, sort, filters);
  const safePageSize = pageSize > 0 ? pageSize : 1;
  const pageCount = Math.max(1, Math.ceil(sorted.length / safePageSize));
  const safePage = Math.min(Math.max(1, Math.floor(page)), pageCount);
  const start = (safePage - 1) * safePageSize;
  return {
    rows: sorted.slice(start, start + safePageSize),
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

/** 筛选与排序后的完整行序列（append 切片与宿主计数共用的纯逻辑）。 */
function filteredSortedRows<R extends TableRowSpec>(
  items: readonly SortableTableRow<R>[],
  columns: readonly TableColumnSpec[],
  sort: { key: string; direction: 'asc' | 'desc' },
  filters: readonly TableFilterSpec[] | undefined,
): R[] {
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
  return matched
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const compared = compareByColumn(left.item, right.item, sort.key, column?.sortType);
      return compared !== 0 ? compared * direction : left.index - right.index;
    })
    .map(({ item }) => item.row);
}

/**
 * append 模式切片（P6 历史累计展示）：rows 恒为当前已展示前缀
 * （displayedCount 条），total 为筛选后总数；page/pageCount 固定 1，
 * pageSize=max(1, displayedCount)。历史列表不能退化成翻页覆盖。
 */
export function appendTableRows<R extends TableRowSpec>(
  items: readonly SortableTableRow<R>[],
  columns: readonly TableColumnSpec[],
  sort: { key: string; direction: 'asc' | 'desc' },
  filters: readonly TableFilterSpec[] | undefined,
  displayedCount: number,
): TableSlice<R> {
  const sorted = filteredSortedRows(items, columns, sort, filters);
  const shown = Number.isFinite(displayedCount) ? Math.max(0, Math.floor(displayedCount)) : 0;
  return {
    rows: sorted.slice(0, shown),
    total: sorted.length,
    pageCount: 1,
    page: 1,
  };
}

/**
 * append 模式的 TableSpec.pagination 构造：固定 page=1/pageCount=1，
 * pageSize=max(1, displayedCount)，模式标记 append（renderer 据此不渲染
 * 上一页/下一页，只渲染外部“加载更多”）。
 */
export function appendPagination(total: number, displayedCount: number): TableSpec['pagination'] {
  return {
    page: 1,
    pageCount: 1,
    total,
    pageSize: Math.max(1, Math.floor(displayedCount)),
    mode: 'append',
  };
}

/** 表格选择上限：revision 模式硬上限 2；single 固定 1。 */
export function tableSelectionLimit(selection: TableSelectionSpec): number {
  if (selection.mode === 'single') {
    return 1;
  }
  const declared = selection.maxSelected ?? 2;
  return Math.max(1, Math.min(2, Math.floor(declared)));
}

export interface TableSelectionResult {
  table: TableSpec;
  /** 状态是否变化（未变化返回原 TableSpec 引用，便于 reducer 保持幂等）。 */
  changed: boolean;
  /** 是否因超过选择上限被拒绝（宿主据此提示，不改勾选与详情）。 */
  limitReached: boolean;
}

/**
 * 表格行勾选（纯函数，视图事件与宿主共用同一上限规则）：
 * - single 模式选中新行自动取消旧行；
 * - revision 模式最多两项，第三个选择返回 limitReached 且状态不变；
 * - 未知行、disabled 行与重复状态不改变状态。
 */
export function applyTableSelection(table: TableSpec, rowId: string, selected: boolean): TableSelectionResult {
  const selection = table.selection;
  if (!selection) {
    return { table, changed: false, limitReached: false };
  }
  const row = table.rows.find((candidate) => candidate.id === rowId);
  if (!row || row.disabled) {
    return { table, changed: false, limitReached: false };
  }
  if ((row.selected ?? false) === selected) {
    return { table, changed: false, limitReached: false };
  }
  if (selected) {
    // single 模式是替换语义：即使已有一项也允许选新行（旧行自动取消）。
    if (selection.mode === 'single') {
      return {
        table: {
          ...table,
          rows: table.rows.map((candidate) =>
            candidate.id === rowId
              ? { ...candidate, selected: true }
              : candidate.selected
                ? { ...candidate, selected: false }
                : candidate,
          ),
        },
        changed: true,
        limitReached: false,
      };
    }
    const limit = tableSelectionLimit(selection);
    const selectedCount = table.rows.filter((candidate) => candidate.selected && !candidate.disabled).length;
    if (selectedCount >= limit) {
      return { table, changed: false, limitReached: true };
    }
  }
  return {
    table: {
      ...table,
      rows: table.rows.map((candidate) =>
        candidate.id === rowId ? { ...candidate, selected } : candidate,
      ),
    },
    changed: true,
    limitReached: false,
  };
}

/** 当前勾选的表格行 ID（按行序），宿主据此构建比较对。 */
export function selectedTableRowIds(table: TableSpec): string[] {
  return table.rows.filter((row) => row.selected).map((row) => row.id);
}

/* ------------------------- M4 通用面板组件契约 ------------------------- */

/**
 * P5 懒加载树节点：只承载当前层已加载节点（宿主每次最多发送 40 项），
 * 展开、选中、重试分别是独立意图；展开不等于选中，选中才更新详情。
 */
export interface LazyTreeRowSpec {
  /** 稳定节点 ID（宿主派生，不含凭据；视图回传时不带路径）。 */
  id: string;
  /** 条目展示名（原始名称，不 trim）。 */
  label: string;
  kind: 'dir' | 'file' | 'symlink' | 'unknown';
  /** 层级（0 起，仅影响缩进）。 */
  depth: number;
  phase: 'idle' | 'loading' | 'ready' | 'error';
  /** 已加载子项数（目录 ready；不得用首批数量冒充总数）。 */
  loaded?: number;
  /** 精确直属总数（目录 ready；与 loaded 分开显示）。 */
  total?: number;
  /** 两段式元数据补全状态（大目录：名称首屏 + 元数据按需/后台补全）。 */
  metadata?: 'complete' | 'pending' | 'filling' | 'cancelled';
  /** 元数据补全进度（filling 时；completed / total）。 */
  metadataProgress?: { completed: number; total: number };
  expanded?: boolean;
  selected?: boolean;
  /** 节点状态文案（宿主 i18n：加载中/读取失败/已读取 40 / 总计 1,284）。 */
  statusText?: string;
  /** 展开按钮可访问名称（宿主 i18n；缺省不设置 aria-label）。 */
  expandLabel?: string;
  /** 选择按钮可访问名称（宿主 i18n；缺省用展示名）。 */
  selectLabel?: string;
  /** 节点行内动作（重试/刷新/复制 URL 等，意图只带稳定 ID）。 */
  actions?: ActionSpec[];
  /** 节点 URL 展示值（宿主可逐段解码；复制动作仍由宿主使用原始 URI）。 */
  nodeUrl?: string;
  /** 仓库相对路径（`^/` 前缀的展示值，原始名称不做重编码）。 */
  repoPath?: string;
  /** 节点最后修改：宿主已格式化的 revision/author/date 展示文本，缺省项不显示。 */
  lastChanged?: { revision?: string; author?: string; date?: string };
  /** 节点自身元数据（文件大小、目录条目数等宿主格式化文本）。 */
  metaText?: string;
  /** 节点自身类型展示名（宿主 i18n：目录/文件/符号链接/未知）。 */
  kindLabel?: string;
  /** 空目录徽标文案（ready + total=0；宿主 i18n，空目录不是错误）。 */
  emptyText?: string;
  /** 超出完整读取上限（tooLarge）终态；说明文字由 statusText 提供。 */
  tooLarge?: boolean;
  /** 两段式元数据补全的取消动作（意图由宿主提供，视图附加节点 ID）。 */
  metadataCancelAction?: ActionSpec;
  /** 已加载子节点（仅展开层的切片，不递归未读取内容）。 */
  children?: LazyTreeRowSpec[];
}

/** P5 当前层懒加载树（无复选框选择树：行 DOM/转义/滚动复用既有实现）。 */
export interface LazyTreeSpec {
  id: string;
  /** 树容器可访问名称（宿主 i18n）。 */
  ariaLabel?: string;
  rows: LazyTreeRowSpec[];
  /** 无节点空态。 */
  empty: { title: string; detail?: string };
  /** “加载更多”动作（宿主切片，每次最多 40 项；意图只带稳定 ID）。 */
  loadMoreAction?: ActionSpec;
  /** 根目录首读进行中（不确定进度条）。 */
  busy?: boolean;
}

/**
 * 主从布局：只负责左右/上下（窄容器）布局，不承载业务语义；
 * 主区内容来自 lazyTree/table/list，详情内容由 DetailSpec 生成。
 * P5/P6 用 master-detail（左主右窄详情），P7 用 balanced（左右对半）。
 */
export interface MasterDetailSpec {
  layout: 'master-detail' | 'balanced';
  /** 主区标题（宿主 i18n）。 */
  masterLabel?: string;
  /** 详情区标题（宿主 i18n）。 */
  detailLabel?: string;
  /** 主区滚动保持键（data-scroll-key；缺省 'master'）。 */
  masterScrollKey?: string;
  /** 详情区滚动保持键（data-scroll-key；缺省 'detail'）。 */
  detailScrollKey?: string;
}

export interface DetailKeyValueSpec {
  label: string;
  value: string;
  /** 值按等宽字体展示（URL、路径、revision 原值）。 */
  mono?: boolean;
}

/**
 * 详情中的一条变更路径（P6 历史）：路径 + SVN 动作/节点类型 + 复制来源。
 * - action/kind 是 SVN 原词（A/M/D/R、file/dir），视图不翻译、不推断语义；
 * - copyfrom 是复制来源（copyfrom-path/rev）；label 为宿主 i18n 的成品
 *   前缀（如「复制自」），缺省只显示 `path@revision`；
 * - id 是稳定路径项 ID：行内动作（复制路径等）只回传它，视图不在意图里
 *   携带路径；无 id 时不渲染该行动作。
 */
export interface DetailPathChangeSpec {
  id?: string;
  path: string;
  action?: string;
  kind?: string;
  copyfrom?: { path: string; revision?: string; label?: string };
  /** 附加说明（宿主 i18n，如「当前节点复制点」）。 */
  note?: string;
  /** 行内动作（意图只带稳定 ID；由宿主映射到路径）。 */
  actions?: ActionSpec[];
}

/**
 * 详情中的一条复制窗口记录（P6 历史）：目标路径 ← 复制来源路径@revision。
 * 用于展示目标身份的复制边界（含嵌套复制的每一层）；所有字段是展示值，
 * boundaryRevision 标明复制发生的 revision。
 */
export interface DetailCopyWindowSpec {
  targetPath: string;
  sourcePath: string;
  sourceRevision?: string;
  boundaryRevision?: string;
  /** 附加说明（宿主 i18n，如「复制点之前的历史停在来源节点」）。 */
  note?: string;
}

/** 详情段：键值段、文本段、预格式段、动作、变更路径与复制窗口；动态值全部预转义。 */
export type DetailSectionSpec =
  | { kind: 'kv'; heading?: string; entries: DetailKeyValueSpec[] }
  | { kind: 'text'; heading?: string; paragraphs: string[] }
  | { kind: 'pre'; heading?: string; text: string }
  | { kind: 'actions'; actions: ActionSpec[] }
  | {
    kind: 'paths';
    heading?: string;
    paths: DetailPathChangeSpec[];
    /** 无路径时的说明（宿主 i18n；缺省不渲染任何内容）。 */
    emptyText?: string;
    /**
     * 折叠阈值：paths 数量超过该值时，前 collapseAfter 条直接展示，其余
     * 收进「查看全部变更路径」details（summary 文案由 moreLabel 提供）。
     * 缺省或 moreLabel 缺省时全部直接展示。
     */
    collapseAfter?: number;
    moreLabel?: string;
  }
  | {
    kind: 'copyWindow';
    heading?: string;
    items: DetailCopyWindowSpec[];
    emptyText?: string;
  };

/** 节点、revision、冲突详情（宿主生成全部文案；视图只排版与转义）。 */
export interface DetailSpec {
  title?: string;
  subtitle?: string;
  /**
   * 当前详情对应的稳定行 ID（P6 revision 行 ID）。详情层动作按钮（如
   * copyHistoryText 复制 revision/提交说明）据此绑定 data-row-id：视图
   * 不在意图里携带路径或 revision 原值，宿主按 ID 映射目标。缺省时
   * 动作按无参意图转发（既有 P5 详情行为不变）。
   */
  id?: string;
  sections: DetailSectionSpec[];
}

export interface FilterPanelFieldSpec {
  id: string;
  kind: 'text' | 'date' | 'select';
  label: string;
  value: string;
  /** kind='select' 必填。 */
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  /** 字段级错误（如日期起止反序）：显示错误但保留用户输入。 */
  error?: string;
  disabled?: boolean;
}

/**
 * 折叠筛选面板（P6）：文本/日期/select 字段与清空动作；字段值变化即
 * 提交（`setHistoryFilter(id, value)`），Webview 不解释业务条件。
 * 折叠用原生 details/summary，展开状态是视图瞬时状态。
 */
export interface FilterPanelSpec {
  id: string;
  /** 折叠区标题（宿主 i18n）。 */
  title?: string;
  /** 初始折叠（缺省展开）。 */
  collapsed?: boolean;
  fields: FilterPanelFieldSpec[];
  /** 清空动作（宿主提供标签，视图不发业务判断）。 */
  clearAction?: ActionSpec;
}

/** 分组 tab（P7 文件/属性/树）：仅表达计数与当前 tab，不承载冲突语义。 */
export interface TabsSpec {
  id: string;
  /** tab 容器可访问名称（宿主 i18n）。 */
  ariaLabel?: string;
  tabs: Array<{ id: string; label: string; count?: number; disabled?: boolean; disabledReason?: string }>;
  /** 当前 tab ID。 */
  current: string;
  /** 切换意图（冻结动作名由宿主给出；意图只带 tab ID，缺省 setConflictTab）。 */
  intent?: string;
}

/**
 * 长任务进度（P6/P7）：标题、明细、可关闭；写入在途仅保留关闭/日志等
 * 放行动作（动作集由宿主按放行表传入）。ratio 缺省为不确定进度动画。
 */
export interface ProgressState {
  title: string;
  detail?: string;
  /** 确定进度 0..1；缺省不确定进度。 */
  ratio?: number;
  /** 放行动作（关闭/查看日志等）。 */
  actions?: ActionSpec[];
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
  /** P5 当前层懒加载树（与主从布局配合；不递归发送未读取内容）。 */
  lazyTree?: LazyTreeSpec;
  /** 主从布局（P5/P6 左主右详情、P7 对半）；缺省不改变既有面板结构。 */
  layout?: MasterDetailSpec;
  /** 主从布局的详情内容（节点/revision/冲突详情）。 */
  detail?: DetailSpec;
  /** 折叠筛选面板（P6 关键词/作者/日期/路径；变化立即提交）。 */
  filterPanel?: FilterPanelSpec;
  /** 分组 tab（P7 文件/属性/树；仅计数与当前 tab）。 */
  tabs?: TabsSpec;
  /** 长任务进度（P6/P7；与 busy 进度条分开，带标题/明细/放行动作）。 */
  progress?: ProgressState;
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
  | { type: 'intent:toggleTableSelection'; rowId: string; selected: boolean }
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
    case 'intent:toggleTableSelection': {
      // P6 revision 勾选：最多两项；第三个选择被拒绝（宿主据此提示）。
      if (state.busy || state.writeLocked) {
        return state;
      }
      const table = state.table;
      if (!table) {
        return state;
      }
      const result = applyTableSelection(table, event.rowId, event.selected);
      return result.changed ? { ...state, table: result.table } : state;
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
