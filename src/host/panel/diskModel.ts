/**
 * P4 磁盘治理面板的会话状态机与渲染态构建（纯函数，不依赖 vscode）。
 *
 * 状态形状对照技术方案 §6.3（DiskPanelState 全字段）与交互状态清单 §四
 * 全部状态行：zero/busy 不是独立 phase（分别是 cacheCount=0 与占用判定的
 * 派生态）、closed 是宿主视图态不进模型；cleanupUnknown 不经会话缓存承载
 * （唯一产生路径是宿主重启后的 vacuum unknown 记录折算，见 §9）。
 *
 * 关键规则（§6.1/§6.2/§6.3/§7.1/§9）：
 * - 扫描代次 scanEpoch：每次扫描递增、清理确认绑定代次；复测结算同步
 *   递增并把 cleanBeforeBytes 更新为复测剩余值——cleaned 页不出现未复测
 *   的旧数值（cleaning 覆盖「清理命令 + 自动复测」全程，数值无陈旧窗口）；
 * - scanCanceled 不展示已读数值（缓存也不存被取消扫描的部分数值）；
 * - changedReason 两来源分列（快照比对不一致 / 重检读取失败——后者不
 *   冒充「检测到变化」），rescan/startScan 开始时清除、跨关闭重开保留；
 * - 清理可用性 = 业务矩阵 ∧ 放行表非占用（busy=false ∧ writeLocked=false）
 *   的同一合取——DOM 禁用与宿主 confirmVacuum 守卫调用同一函数；
 * - 空间概览经 metrics/spaceBar 组件承载（宿主完成 MiB/GiB 格式化后进
 *   MetricSpec），清理前后对比卡用同一 metrics 组件。
 */
import type { OperationKind } from '../../core/operations';
import type { DiskUsageFile, PristineStats, ScanDiskUsageResult } from '../../core/diskUsage';
import { format, strings } from '../i18n';
import { sliceTableRows } from './state';
import type {
  ActionSpec,
  BannerSpec,
  FooterSpec,
  MetricSpec,
  PanelState,
  SpaceBarSpec,
  TableFilterSpec,
  TableSpec,
} from './state';

/* ---------------------------------------------------------------------------
 * 状态形状（§6.3）
 * ------------------------------------------------------------------------- */

/**
 * 面板相位。运行态：scanning/cleaning；结果态：ready/partial/scanCanceled/
 * scanError/changed/cleaned/cleanupFailed/refreshError（会话缓存承载除
 * cleanupUnknown 外的全部结果态）；idle 为未扫描。
 */
export type DiskPhase =
  | 'idle'
  | 'scanning'
  | 'scanCanceled'
  | 'scanError'
  | 'partial'
  | 'ready'
  | 'changed'
  | 'cleaning'
  | 'cleaned'
  | 'cleanupFailed'
  | 'cleanupUnknown'
  | 'refreshError';

/** pristine 缓存检测结论：检测不可用不冒充 0（数值显示 —、禁清理）。 */
export interface DiskPristineState {
  state: 'ok' | 'unsupported' | 'unavailable';
  reason: string | null;
  cacheCount: number | null;
  unreferencedBytes: number | null;
  /** 抽查缺失单独计数（>0 时确认框标注「预计量可能偏大」；null = 未抽查）。 */
  missingCount?: number | null;
}

/** 排除清单条目：「范围说明」弹窗的数据源（不进清单不进表格）。 */
export interface DiskExcludedEntry {
  path: string;
  reason: string;
}

/**
 * 清理的前后数值（命名对齐交互状态清单 §六）：cleanBeforeBytes 是检测
 * 快照的预计量（复测结算时更新为剩余值）、lastBefore/lastAfter 是工作
 * 副本总占用的前后复测值、releasedBytes 是总占用实测差值（复测失败为
 * null，显示 —）——两个「前后」语义不同，不许混淆。
 */
export interface DiskCleanState {
  cleanBeforeBytes: number | null;
  cleanAfterBytes: number | null;
  lastBeforeBytes: number | null;
  lastAfterBytes: number | null;
  releasedBytes: number | null;
}

/** 运行中任务绑定（跨入口打开与重开恢复第①段）：页头按任务呈现。 */
export interface DiskPanelBinding {
  resultScope: { wcRoot: string };
  /** 任务创建时记录的打开子目录（运行中任务的页头反映任务发起位置）。 */
  subPath: string;
}

/** 表格视图参数的只读镜像（真相源是宿主 TableSpec 实例，reducer 不独立演化）。 */
export interface DiskTableView {
  sortKey: 'path' | 'size';
  sortDesc: boolean;
  filter: string;
  type: string;
  page: number;
}

/** P4 面板完整状态（§6.3）。 */
export interface DiskPanelState {
  sessionId: string;
  phase: DiskPhase;
  /** 实际工作副本根（findWorkingCopy 定位）。 */
  wcRoot: string;
  /** 本次打开子目录（缓存恢复时刷新为本次打开路径）。 */
  subPath: string;
  scanEpoch: number;
  /** 扫描完整性（partial/canceled 为 false）。 */
  scanComplete: boolean;
  /** 已读取条目数（非确定进度；重开后与关闭前一致）。 */
  scanCount: number;
  /** 扫描中的当前路径（仅 scanning 态展示）。 */
  scanCurrentPath: string | null;
  total: number | null;
  business: number | null;
  svn: number | null;
  pristineBytes: number | null;
  pristine: DiskPristineState;
  /** 同副本命令在途占用（hasRunning ∪ taskRegistry，由宿主求值喂入）。 */
  busy: boolean;
  /** writeRestriction 命中（与 busy 独立维度，可同时为真）。 */
  writeLocked: boolean;
  /** writeLocked 命中记录的类别（禁用原因按 kind 分列文案）。 */
  heldKind: OperationKind | null;
  clean: DiskCleanState;
  /** 业务文件全量清单（business 合计恒等于本清单字节合计；消息只发当前页）。 */
  files: DiskUsageFile[];
  tableView: DiskTableView;
  excluded: DiskExcludedEntry[];
  /** 扫描错误列表（partial 的依据；不含清理失败原因）。 */
  errors: string[];
  /** changed 页可读原因（两种来源都写入；跨关闭重开保留）。 */
  changedReason: string | null;
  /** 清理命令失败原因（仅 cleanupFailed 相位；跨关闭重开保留）。 */
  cleanupError: string | null;
  binding: DiskPanelBinding | null;
  /** 恢复来源段标记（P4 重开三段：task/cache/record）。 */
  recovered: 'task' | 'cache' | 'record' | null;
}

/** 打开入口（创建会话的最小输入）。 */
export interface DiskPanelEntry {
  sessionId: string;
  wcRoot: string;
  subPath: string;
}

/** 表格视图镜像的默认值（重开重置默认：大小降序、无筛选、第 1 页）。 */
export const DISK_TABLE_VIEW_DEFAULT: DiskTableView = {
  sortKey: 'size',
  sortDesc: true,
  filter: '',
  type: 'all',
  page: 1,
};

function freshPristine(): DiskPristineState {
  return { state: 'ok', reason: null, cacheCount: null, unreferencedBytes: null, missingCount: null };
}

function freshClean(): DiskCleanState {
  return { cleanBeforeBytes: null, cleanAfterBytes: null, lastBeforeBytes: null, lastAfterBytes: null, releasedBytes: null };
}

/** 创建初始状态：idle、未扫描、无数值。 */
export function createDiskPanelState(entry: DiskPanelEntry): DiskPanelState {
  return {
    sessionId: entry.sessionId,
    phase: 'idle',
    wcRoot: entry.wcRoot,
    subPath: entry.subPath,
    scanEpoch: 0,
    scanComplete: false,
    scanCount: 0,
    scanCurrentPath: null,
    total: null,
    business: null,
    svn: null,
    pristineBytes: null,
    pristine: freshPristine(),
    busy: false,
    writeLocked: false,
    heldKind: null,
    clean: freshClean(),
    files: [],
    tableView: { ...DISK_TABLE_VIEW_DEFAULT },
    excluded: [],
    errors: [],
    changedReason: null,
    cleanupError: null,
    binding: null,
    recovered: null,
  };
}

/** 清空「已读数值」：scanCanceled/scanError 等不展示部分数值的相位共用。 */
function clearScanData(state: DiskPanelState): DiskPanelState {
  return {
    ...state,
    scanComplete: false,
    scanCount: 0,
    scanCurrentPath: null,
    total: null,
    business: null,
    svn: null,
    pristineBytes: null,
    pristine: freshPristine(),
    files: [],
    excluded: [],
  };
}

/* ---------------------------------------------------------------------------
 * core 结果映射（diskUsage.ts 返回形态 → 模型形状）
 * ------------------------------------------------------------------------- */

/** readPristineStats 的宿主不支持固定文案（core 硬编码，映射 unsupported 的判别基准）。 */
const PRISTINE_UNSUPPORTED_REASON = '当前 VS Code 宿主不支持缓存检测';

/**
 * PristineStats → 模型 pristine 形状：available=true → ok；不可用时按
 * 固定文案区分 unsupported（宿主无 node:sqlite——能力缺失）与 unavailable
 * （打开失败/无 PRISTINE 表等——副本侧不可用），数值不冒充 0。
 */
export function pristineFromStats(stats: PristineStats): DiskPristineState {
  if (stats.available) {
    return {
      state: 'ok',
      reason: null,
      cacheCount: stats.cacheCount ?? null,
      unreferencedBytes: stats.unreferencedBytes ?? null,
      missingCount: stats.missingCount ?? null,
    };
  }
  return {
    state: stats.reason === PRISTINE_UNSUPPORTED_REASON ? 'unsupported' : 'unavailable',
    reason: stats.reason ?? null,
    cacheCount: null,
    unreferencedBytes: null,
    missingCount: null,
  };
}

/**
 * core 的 excluded 字符串清单 → { path, reason }：externals 解析失败的
 * 保守排除条目带「（标注）」后缀，拆出可读理由；其余（externals 落点、
 * 嵌套副本目录）给默认理由。
 */
export function excludedFromScan(list: readonly string[]): DiskExcludedEntry[] {
  return list.map((item) => {
    const open = item.indexOf('（');
    if (open > 0 && item.endsWith('）')) {
      return { path: item.slice(0, open), reason: item.slice(open + 1, -1) };
    }
    return { path: item, reason: strings.diskPanel.excludedDefaultReason };
  });
}

/**
 * 字节数展示文本（B/KiB/MiB/GiB/TiB，一位小数）：宿主格式化后进
 * MetricSpec.value 的唯一出口；null/负数/非有限值显示 —。
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  const rounded = value >= 100 ? `${Math.round(value)}` : value.toFixed(1);
  return `${rounded} ${units[unit]}`;
}

/* ---------------------------------------------------------------------------
 * 扫描 reducer（§6.1/§6.3：开始 → 进度 → 完成/取消/失败，代次守卫）
 * ------------------------------------------------------------------------- */

/**
 * 开始扫描（startScan/rescan 的模型侧转移，同一入口）：代次递增、进入
 * scanning、清空旧数值与错误（changedReason/cleanupError 随离开清除——
 * 旧结论不得批准新扫描）。
 */
export function scanStarted(state: DiskPanelState): DiskPanelState {
  return {
    ...clearScanData(state),
    phase: 'scanning',
    scanEpoch: state.scanEpoch + 1,
    errors: [],
    changedReason: null,
    cleanupError: null,
  };
}

/** 扫描进度（非确定进度：只报已读取数与当前路径；节流由控制器承担）。 */
export function scanProgress(state: DiskPanelState, progress: { count: number; currentPath: string | null }): DiskPanelState {
  if (state.phase !== 'scanning') {
    return state;
  }
  return { ...state, scanCount: progress.count, scanCurrentPath: progress.currentPath };
}

/**
 * 扫描完成（代次一致且仍处 scanning 才生效——迟到回包丢弃）：complete →
 * ready、partial → partial；pristine 检测结论与空间概览四字段、files、
 * excluded、scanCount 全量回填；errors 为 partial 的依据。
 */
export function scanCompleted(
  state: DiskPanelState,
  epoch: number,
  result: ScanDiskUsageResult,
  pristine: DiskPristineState,
): DiskPanelState {
  if (state.scanEpoch !== epoch || state.phase !== 'scanning') {
    return state;
  }
  return {
    ...state,
    phase: result.phase === 'complete' ? 'ready' : 'partial',
    scanComplete: result.phase === 'complete',
    scanCurrentPath: null,
    total: result.totals.total,
    business: result.totals.business,
    svn: result.totals.svn,
    pristineBytes: result.totals.pristineBytes,
    pristine,
    files: result.files,
    excluded: excludedFromScan(result.excluded),
    scanCount: result.scanCount,
    errors: result.partialReason ? [result.partialReason] : [],
  };
}

/** 扫描取消：转 scanCanceled，不展示任何已读数值（允许重新分析）。 */
export function scanCanceled(state: DiskPanelState, epoch: number): DiskPanelState {
  if (state.scanEpoch !== epoch || state.phase !== 'scanning') {
    return state;
  }
  return { ...clearScanData(state), phase: 'scanCanceled' };
}

/** 扫描失败：转 scanError、记录原因、不展示部分数值。 */
export function scanError(state: DiskPanelState, epoch: number, reason: string): DiskPanelState {
  if (state.scanEpoch !== epoch || state.phase !== 'scanning') {
    return state;
  }
  return { ...clearScanData(state), phase: 'scanError', errors: [reason] };
}

/* ---------------------------------------------------------------------------
 * 清理链 reducer（§6.2：确认后重检 → begin → 命令 → 复测结算）
 * ------------------------------------------------------------------------- */

/**
 * changed（快照比对不一致来源）：确认后重检发现检测快照变化——未执行
 * 清理、禁止沿用旧批准；保留旧分析结果（数值与表格），页面提供重新
 * 检测入口。
 */
export function setChangedFromSnapshot(state: DiskPanelState, detail?: string): DiskPanelState {
  const base = detail ? format(strings.diskPanel.changedReasonSnapshot, { detail }) : strings.diskPanel.changedReasonSnapshotPlain;
  return { ...state, phase: 'changed', changedReason: base };
}

/**
 * changed（重检读取失败来源）：pristine 复读落 unavailable 或目录不可读
 * ——无法确认「快照未变」即不批准清理，同按 changed 保守收口，但不冒充
 * 「检测到变化」（可读原因列明读取失败）。
 */
export function setChangedFromReadFailure(state: DiskPanelState, reason: string): DiskPanelState {
  return { ...state, phase: 'changed', changedReason: format(strings.diskPanel.changedReasonReadFailure, { reason }) };
}

/**
 * 清理开始（确认后、写命令前）：cleaning 覆盖「清理命令 + 自动复测」
 * 全程；cleanBeforeBytes 定格检测快照的预计量、lastBeforeBytes 定格
 * 清理前总占用，后值字段清空（数值无陈旧窗口）。
 */
export function beginClean(state: DiskPanelState): DiskPanelState {
  return {
    ...state,
    phase: 'cleaning',
    clean: {
      cleanBeforeBytes: state.pristine.unreferencedBytes,
      cleanAfterBytes: null,
      lastBeforeBytes: state.total,
      lastAfterBytes: null,
      releasedBytes: null,
    },
  };
}

/** 清理命令失败（可能部分完成）：收益未核实（后值显示 —），须先重新检测。 */
export function cleanFailed(state: DiskPanelState, message: string): DiskPanelState {
  return {
    ...state,
    phase: 'cleanupFailed',
    cleanupError: message,
    clean: { ...state.clean, cleanAfterBytes: null, lastAfterBytes: null, releasedBytes: null },
  };
}

/**
 * 复测失败（scanError/partial/unavailable 三形态都由 cleaning 直转）：
 * 命令已成功但实际收益未核实——差值显示 —，不拿预计值冒充；须重新检测。
 */
export function refreshFailed(state: DiskPanelState): DiskPanelState {
  return {
    ...state,
    phase: 'refreshError',
    clean: { ...state.clean, cleanAfterBytes: null, lastAfterBytes: null, releasedBytes: null },
  };
}

/**
 * 复测成功结算（仅 cleaning 相位且复测完整才生效）：转 cleaned，数值
 * 全部来自复测实测——cleanAfterBytes/概览四字段/pristine/files 以复测
 * 结果回填、releasedBytes = 前后总占用差值；cleanBeforeBytes 更新为
 * 复测剩余值、scanEpoch 递增绑定复测代次（第二次确认框按复测剩余值
 * 预计，连续清理不回滚旧数值）。
 *
 * 复测失败三形态（scanError/partial/unavailable）不经本函数结算——
 * 控制器判定后显式调 refreshFailed（cleaning 直转）；不完整的复测结果
 * 传入时原样返回，模型层不产生「cleaned 页持未复验数值」的形态。
 */
export function cleanSettled(
  state: DiskPanelState,
  settled: { scan: ScanDiskUsageResult; pristine: DiskPristineState },
): DiskPanelState {
  if (state.phase !== 'cleaning' || settled.scan.phase !== 'complete' || settled.pristine.state !== 'ok') {
    return state;
  }
  const remainBytes = settled.pristine.state === 'ok' ? settled.pristine.unreferencedBytes : null;
  const lastAfter = settled.scan.totals.total;
  const released = state.clean.lastBeforeBytes !== null && lastAfter !== null
    ? state.clean.lastBeforeBytes - lastAfter
    : null;
  return {
    ...state,
    phase: 'cleaned',
    scanEpoch: state.scanEpoch + 1,
    scanComplete: settled.scan.phase === 'complete',
    scanCurrentPath: null,
    total: lastAfter,
    business: settled.scan.totals.business,
    svn: settled.scan.totals.svn,
    pristineBytes: settled.scan.totals.pristineBytes,
    pristine: settled.pristine,
    files: settled.scan.files,
    excluded: excludedFromScan(settled.scan.excluded),
    scanCount: settled.scan.scanCount,
    errors: settled.scan.partialReason ? [settled.scan.partialReason] : [],
    clean: {
      cleanBeforeBytes: remainBytes,
      cleanAfterBytes: remainBytes,
      lastBeforeBytes: state.clean.lastBeforeBytes,
      lastAfterBytes: lastAfter,
      releasedBytes: released,
    },
  };
}

/**
 * cleanupUnknown（宿主重启后的 vacuum unknown 记录折算派生态）：不经
 * 会话缓存承载、每次打开由记录分诊段派生；页面只给「先重新检测」。
 */
export function enterCleanupUnknown(state: DiskPanelState): DiskPanelState {
  return {
    ...clearScanData(state),
    phase: 'cleanupUnknown',
    clean: freshClean(),
    errors: [],
    changedReason: null,
    cleanupError: null,
    binding: null,
    recovered: 'record',
  };
}

/* ---------------------------------------------------------------------------
 * 绑定与占用（P4 重开三段第①段 / 跨面板新鲜度）
 * ------------------------------------------------------------------------- */

/**
 * 绑定运行中任务（重开三段第①段，按「任务对象存在」判定）：页头 wcRoot/
 * subPath 取任务固定参数（运行中任务的页头反映任务发起位置，不显示本次
 * 打开的另一子目录）。
 */
export function bindRunningTask(
  state: DiskPanelState,
  task: { kind: 'scan' | 'clean'; wcRoot: string; subPath: string },
): DiskPanelState {
  return {
    ...state,
    phase: task.kind === 'scan' ? 'scanning' : 'cleaning',
    wcRoot: task.wcRoot,
    subPath: task.subPath,
    binding: { resultScope: { wcRoot: task.wcRoot }, subPath: task.subPath },
    recovered: 'task',
  };
}

/**
 * 占用重算写入（跨面板新鲜度）：宿主在每次收到 P4 intent 与面板重显时
 * 重算 hasRunning/writeRestriction 后喂入——busy/writeLocked 的呈现不由
 * webview 缓存，另一面板发起占用后下一次 intent 即刷新。
 */
export function setOccupancy(
  state: DiskPanelState,
  occupancy: { busy: boolean; writeLocked: boolean; heldKind?: OperationKind | null },
): DiskPanelState {
  return {
    ...state,
    busy: occupancy.busy,
    writeLocked: occupancy.writeLocked,
    heldKind: occupancy.writeLocked ? (occupancy.heldKind ?? null) : null,
  };
}

/** 表格视图镜像回写（真相源是宿主 TableSpec 实例，镜像不参与判定）。 */
export function updateTableView(state: DiskPanelState, view: DiskTableView): DiskPanelState {
  return { ...state, tableView: { ...view } };
}

/* ---------------------------------------------------------------------------
 * 清理可用性矩阵（§6.2：业务条件 ∧ 放行表非占用的同一合取）
 * ------------------------------------------------------------------------- */

/** 禁用原因的结构化类别（测试与呈现分列；null cause = 可用）。 */
export type VacuumUnavailableCause =
  | 'busy'
  | 'writeLocked'
  | 'idle'
  | 'scanning'
  | 'scanCanceled'
  | 'scanError'
  | 'partial'
  | 'unsupported'
  | 'unavailable'
  | 'undetected'
  | 'zero'
  | 'changed'
  | 'cleaning'
  | 'cleanupFailed'
  | 'cleanupUnknown'
  | 'refreshError';

export interface VacuumAvailability {
  available: boolean;
  /** 禁用原因的可读文案（available=true 时为 null）；DOM title 与宿主拒绝提示同源。 */
  reason: string | null;
  cause: VacuumUnavailableCause | null;
}

/** 占用输入：宿主按放行表维度求值后喂入（与 state.busy/writeLocked 分离，守卫侧不读陈旧值）。 */
export interface VacuumOccupancy {
  busy: boolean;
  writeLocked: boolean;
  /** writeLocked 命中记录的类别（无 kind 旧记录按 commit 兜底）。 */
  heldKind?: OperationKind | null;
}

/** writeLocked 命中记录按 kind 分列的禁用原因（§6.2：不得把 ignore 记录指到提交面板）。 */
function writeLockedReason(heldKind: OperationKind | null | undefined): string {
  const t = strings.diskPanel;
  switch (heldKind ?? 'commit') {
    case 'ignore':
      return t.vacuumReasonLockIgnore;
    case 'vacuum':
      return t.vacuumReasonLockVacuum;
    case 'checkout':
      return t.vacuumReasonLockCheckout;
    case 'import':
      return t.vacuumReasonLockImport;
    case 'update':
    case 'cleanup':
    case 'daily':
      return t.vacuumReasonLockOther;
    default:
      return t.vacuumReasonLockCommit;
  }
}

/**
 * 清理可用性矩阵：最终可用性 = 业务条件（phase=ready/cleaned ∧ scanComplete
 * ∧ pristine.state='ok' ∧ cacheCount>0；cleaned 的再次清理是唯一例外——
 * 复测已刷新全部判定输入，允许按复测代次直接再次清理）∧ 放行表非占用
 * （busy=false ∧ writeLocked=false）的同一合取。DOM 禁用与宿主
 * confirmVacuum 守卫必须调用本函数取同一结果（M2 §14.6 同源纪律）。
 *
 * 判定顺序：busy（先判，与放行表宿主判定顺序一致）→ 未完成/未决相位 →
 * partial → pristine 检测不可用 → writeLocked → 统计未就绪（防御）→ 零缓存。
 */
export function buildVacuumAvailability(state: DiskPanelState, occupancy: VacuumOccupancy): VacuumAvailability {
  const t = strings.diskPanel;
  const deny = (cause: VacuumUnavailableCause, reason: string): VacuumAvailability => ({ available: false, reason, cause });
  if (occupancy.busy) {
    return deny('busy', t.vacuumReasonBusy);
  }
  switch (state.phase) {
    case 'idle':
      return deny('idle', t.vacuumReasonIdle);
    case 'scanning':
      return deny('scanning', t.vacuumReasonScanning);
    case 'scanCanceled':
      return deny('scanCanceled', t.vacuumReasonScanCanceled);
    case 'scanError':
      return deny('scanError', t.vacuumReasonScanError);
    case 'changed':
      return deny('changed', t.vacuumReasonChanged);
    case 'cleaning':
      return deny('cleaning', t.vacuumReasonCleaning);
    case 'cleanupFailed':
      return deny('cleanupFailed', t.vacuumReasonCleanupFailed);
    case 'cleanupUnknown':
      return deny('cleanupUnknown', t.vacuumReasonCleanupUnknown);
    case 'refreshError':
      return deny('refreshError', t.vacuumReasonRefreshError);
    case 'partial':
      return deny('partial', t.vacuumReasonPartial);
    default:
      break;
  }
  if (state.pristine.state !== 'ok') {
    const reason = format(t.vacuumReasonUnsupported, { reason: state.pristine.reason ?? '' });
    return deny(state.pristine.state === 'unsupported' ? 'unsupported' : 'unavailable', reason);
  }
  if (occupancy.writeLocked) {
    return deny('writeLocked', writeLockedReason(occupancy.heldKind));
  }
  if (state.pristine.cacheCount === null || state.pristine.unreferencedBytes === null) {
    return deny('undetected', t.vacuumReasonUndetected);
  }
  if (state.pristine.cacheCount === 0) {
    return deny('zero', t.vacuumReasonZero);
  }
  // ready/cleaned 到达此处时 scanComplete 已由相位转移保证；防御性复核。
  if (!state.scanComplete) {
    return deny('undetected', t.vacuumReasonUndetected);
  }
  return { available: true, reason: null, cause: null };
}

/* ---------------------------------------------------------------------------
 * 会话结果缓存投影（§9：恢复字段全集，scanCanceled 例外不存部分数值）
 * ------------------------------------------------------------------------- */

/** 缓存承载的结果态（§6.3 phase 枚举去掉运行态、idle 与 cleanupUnknown）。 */
export type DiskCachePhase =
  | 'ready'
  | 'partial'
  | 'scanCanceled'
  | 'scanError'
  | 'changed'
  | 'cleaned'
  | 'cleanupFailed'
  | 'refreshError';

/** P4 会话结果缓存项（sessionResults 的 page 形状；作用域由缓存项 resultScope 承载）。 */
export interface DiskPanelCache {
  phase: DiskCachePhase;
  /** 重开后再清理的确认框绑定复测代次（§9 恢复字段全集）。 */
  scanEpoch: number;
  scanComplete: boolean;
  scanCount: number;
  total: number | null;
  business: number | null;
  svn: number | null;
  pristineBytes: number | null;
  pristine: DiskPristineState;
  clean: DiskCleanState;
  files: DiskUsageFile[];
  excluded: DiskExcludedEntry[];
  errors: string[];
  changedReason: string | null;
  cleanupError: string | null;
}

const CACHE_PHASES: ReadonlySet<DiskPhase> = new Set<DiskPhase>([
  'ready', 'partial', 'scanCanceled', 'scanError', 'changed', 'cleaned', 'cleanupFailed', 'refreshError',
]);

/** 结果相位判定（toDiskCache 的产出条件；类型守卫收窄到缓存相位联合）。 */
function isCachePhase(phase: DiskPhase): phase is DiskCachePhase {
  return CACHE_PHASES.has(phase);
}

/**
 * 模型 → 缓存投影：仅结果态产出（运行态/idle/cleanupUnknown 返回 null，
 * 后者不经缓存承载——其唯一产生路径是宿主重启后的记录折算）。恢复字段
 * 全集逐项落盘（含空间概览四字段与 scanCount——total/svn/pristineBytes
 * 不可从 files/pristine 反推）；scanCanceled 防御性强制不存部分数值。
 */
export function toDiskCache(state: DiskPanelState): DiskPanelCache | null {
  if (!isCachePhase(state.phase)) {
    return null;
  }
  const canceled = state.phase === 'scanCanceled';
  return {
    phase: state.phase,
    scanEpoch: state.scanEpoch,
    scanComplete: canceled ? false : state.scanComplete,
    scanCount: canceled ? 0 : state.scanCount,
    total: canceled ? null : state.total,
    business: canceled ? null : state.business,
    svn: canceled ? null : state.svn,
    pristineBytes: canceled ? null : state.pristineBytes,
    pristine: canceled ? freshPristine() : state.pristine,
    clean: canceled ? freshClean() : state.clean,
    files: canceled ? [] : state.files,
    excluded: canceled ? [] : state.excluded,
    errors: canceled ? [] : state.errors,
    changedReason: state.changedReason,
    cleanupError: state.cleanupError,
  };
}

/**
 * 缓存 → 模型恢复（重开三段第②段，作用域命中校验在 sessionResults 层）：
 * 全字段回填；subPath 刷新为本次打开路径（结果数据是副本级的、页头反映
 * 本次打开位置）；busy/writeLocked 重置假值（宿主渲染前重算）；tableView
 * 不随缓存恢复（重置默认）；scanCurrentPath 仅 scanning 运行态、不恢复。
 */
export function fromDiskCache(base: DiskPanelState, cache: DiskPanelCache, subPath: string): DiskPanelState {
  return {
    ...base,
    phase: cache.phase,
    subPath,
    scanEpoch: cache.scanEpoch,
    scanComplete: cache.scanComplete,
    scanCount: cache.scanCount,
    scanCurrentPath: null,
    total: cache.total,
    business: cache.business,
    svn: cache.svn,
    pristineBytes: cache.pristineBytes,
    pristine: cache.pristine,
    clean: cache.clean,
    files: cache.files,
    excluded: cache.excluded,
    errors: cache.errors,
    changedReason: cache.changedReason,
    cleanupError: cache.cleanupError,
    busy: false,
    writeLocked: false,
    heldKind: null,
    binding: null,
    tableView: { ...DISK_TABLE_VIEW_DEFAULT },
    recovered: 'cache',
  };
}

/* ---------------------------------------------------------------------------
 * 渲染态构建（§7.1：metrics/spaceBar/表格/各页动作集）
 * ------------------------------------------------------------------------- */

/** 大文件表页大小（§7.1：导入/磁盘表格默认 50 行一页）。 */
export const DISK_TABLE_PAGE_SIZE = 50;

/** 大文件表默认排序（重开重置默认：大小降序）。 */
export const DISK_TABLE_SORT_DEFAULT: TableSpec['sort'] = { key: 'size', direction: 'desc' };

/**
 * 大文件表筛选器骨架（§7.1）：path 列文本子串筛选 + ext 列精确筛选
 * （'all' 哨兵不过滤；value 是宿主持有的视图状态，options 由渲染时
 * 从 files 派生注入）。
 */
export function createDiskTableFilters(pathValue = '', extValue = 'all'): TableFilterSpec[] {
  return [
    { id: 'path', kind: 'text', cellKey: 'path', value: pathValue },
    { id: 'ext', kind: 'select', cellKey: 'ext', value: extValue, options: [{ value: 'all', label: strings.panel.filterAll }] },
  ];
}

/** P4 放行表（§7.2）：busy 行不含 rescan/startScan/confirmVacuum（须等待）；writeLocked 行放行重新检测。 */
export const DISK_PANEL_GATE: { busy: string[]; writeLocked: string[] } = {
  busy: ['cancelScan', 'viewTaskLog', 'closePanel', 'showScopeHelp', 'setSort', 'setFilter', 'setPage', 'revealFileInOS'],
  writeLocked: ['rescan', 'startScan', 'showScopeHelp', 'viewTaskLog', 'closePanel', 'setSort', 'setFilter', 'setPage', 'revealFileInOS'],
};

/** buildDiskPanelState 的宿主侧输入（占用与表格视图由控制器求值喂入）。 */
export interface BuildDiskPanelOptions {
  /** 占用重算结果（每次 intent/重显喂入；缺省读 state 内值））。 */
  busy?: boolean;
  writeLocked?: boolean;
  heldKind?: OperationKind | null;
  /** 表格视图参数（宿主 TableSpec 实例回喂；缺省默认大小降序/无筛选/第 1 页）。 */
  tableView?: { sort?: TableSpec['sort']; filters?: TableFilterSpec[]; page?: number };
}

/** 会话状态 → 宿主渲染态（空间概览/占比条/大文件表/各页动作集全量派生）。 */
export function buildDiskPanelState(state: DiskPanelState, options: BuildDiskPanelOptions = {}): PanelState {
  const t = strings.diskPanel;
  const occupancy: VacuumOccupancy = {
    busy: options.busy ?? state.busy,
    writeLocked: options.writeLocked ?? state.writeLocked,
    heldKind: options.heldKind ?? state.heldKind,
  };
  const availability = buildVacuumAvailability(state, occupancy);
  const busy = state.phase === 'scanning' || state.phase === 'cleaning' || occupancy.busy;

  let metrics: MetricSpec[] | undefined;
  let spaceBar: SpaceBarSpec | undefined;
  let table: TableSpec | undefined;
  let footer: FooterSpec;
  let hint: string | undefined;

  if (state.phase === 'idle') {
    hint = t.idleHint;
    footer = buildFooter({ primary: scanAction(state, occupancy, 'startScan', t.actStartScan) });
  } else if (state.phase === 'scanning') {
    metrics = [{ caption: t.metricScanCount, value: String(state.scanCount) }];
    hint = state.scanCurrentPath ? format(t.hintCurrentPath, { path: state.scanCurrentPath }) : undefined;
    footer = buildFooter({
      primary: { id: 'cancelScan', label: t.actCancelScan },
      secondary: [logAction(), closeAction()],
    });
  } else if (state.phase === 'scanCanceled' || state.phase === 'scanError') {
    // 不展示已读数值（无数值、无表格）；动作 = 重新分析 + 日志 + 关闭。
    footer = buildFooter({
      primary: scanAction(state, occupancy, 'rescan', t.actRescan),
      secondary: [logAction(), closeAction()],
    });
  } else if (state.phase === 'cleaning') {
    footer = buildFooter({ secondary: [logAction(), closeAction()] });
  } else if (state.phase === 'cleanupFailed' || state.phase === 'cleanupUnknown' || state.phase === 'refreshError') {
    footer = buildFooter({
      primary: scanAction(state, occupancy, 'rescan', t.actRedetect),
      secondary: [logAction(), closeAction()],
    });
  } else {
    // 结果态（partial/ready/changed/cleaned）：概览 + 占比条 + 大文件表。
    metrics = buildOverviewMetrics(state);
    spaceBar = buildSpaceBar(state);
    table = buildDiskFilesTable(state, options.tableView);
    const vacuum: ActionSpec = vacuumAction(availability);
    if (state.phase === 'partial' || state.phase === 'changed') {
      // partial/changed：清理入口存在但禁用（先走各自后续动作——partial 重分析、changed 重新检测后再确认）。
      footer = buildFooter({
        primary: scanAction(state, occupancy, 'rescan', state.phase === 'changed' ? t.actRedetect : t.actRescan),
        secondary: [vacuum, scopeAction(), logAction(), closeAction()],
      });
    } else if (state.phase === 'cleaned') {
      footer = buildFooter({
        primary: vacuum,
        secondary: [scanAction(state, occupancy, 'rescan', t.actRescan), scopeAction(), logAction(), closeAction()],
      });
    } else {
      footer = buildFooter({
        primary: vacuum,
        secondary: [scanAction(state, occupancy, 'rescan', t.actRescan), scopeAction(), logAction(), closeAction()],
      });
    }
  }

  return {
    sessionId: state.sessionId,
    title: t.panelTitle,
    targetLabel: format(t.targetLabel, {
      subPath: state.binding?.subPath ?? state.subPath,
      wcRoot: state.binding?.resultScope.wcRoot ?? state.wcRoot,
    }),
    revision: 0,
    formRevision: 0,
    busy,
    writeLocked: occupancy.writeLocked,
    banners: buildBanners(state),
    metrics,
    spaceBar,
    table,
    footer,
    hint,
    gate: DISK_PANEL_GATE,
  };
}

/** 各相位横幅（§四对照；过程态与判定性提示不渲染关闭 ×）。 */
function buildBanners(state: DiskPanelState): BannerSpec[] {
  const t = strings.diskPanel;
  switch (state.phase) {
    case 'scanning':
      return [{ id: 'diskScanning', level: 'info', title: t.scanningBanner, dismissable: false }];
    case 'scanCanceled':
      return [{ id: 'diskScanCanceled', level: 'warn', title: t.scanCanceledBanner }];
    case 'scanError':
      return [{
        id: 'diskScanError',
        level: 'error',
        title: t.scanErrorTitle,
        detail: state.errors[0],
        preformatted: true,
      }];
    case 'partial':
      return [{
        id: 'diskPartial',
        level: 'warn',
        title: t.partialBannerTitle,
        detail: state.errors.join('；') || undefined,
      }];
    case 'changed':
      return [{ id: 'diskChanged', level: 'warn', title: t.changedBannerTitle, detail: state.changedReason ?? undefined }];
    case 'cleaning':
      return [{ id: 'diskCleaning', level: 'info', title: t.cleaningBanner, dismissable: false }];
    case 'cleaned':
      return [{ id: 'diskCleaned', level: 'success', title: t.cleanedBanner }];
    case 'cleanupFailed':
      return [{
        id: 'diskCleanupFailed',
        level: 'error',
        title: t.cleanupFailedTitle,
        detail: state.cleanupError ?? undefined,
        preformatted: true,
      }];
    case 'cleanupUnknown':
      return [{ id: 'diskCleanupUnknown', level: 'warn', title: t.cleanupUnknownBanner, dismissable: false }];
    case 'refreshError':
      return [{ id: 'diskRefreshError', level: 'warn', title: t.refreshErrorBanner, dismissable: false }];
    default:
      return [];
  }
}

/** 空间概览数值卡：四值 + 已读取条目 + 缓存快照（检测不可用显示 —，不冒充 0）。 */
function buildOverviewMetrics(state: DiskPanelState): MetricSpec[] {
  const t = strings.diskPanel;
  const pristineOk = state.pristine.state === 'ok';
  const metrics: MetricSpec[] = [
    { caption: t.metricTotal, value: formatBytes(state.total) },
    { caption: t.metricBusiness, value: formatBytes(state.business) },
    { caption: t.metricSvn, value: formatBytes(state.svn) },
    { caption: t.metricPristine, value: formatBytes(state.pristineBytes) },
    { caption: t.metricScanCount, value: String(state.scanCount) },
    {
      caption: t.metricCacheCount,
      value: pristineOk && state.pristine.cacheCount !== null
        ? format(t.metricCacheCountUnit, { count: String(state.pristine.cacheCount) })
        : '—',
    },
    { caption: t.metricReclaimable, value: pristineOk ? formatBytes(state.pristine.unreferencedBytes) : '—' },
  ];
  if ((state.pristine.missingCount ?? 0) > 0) {
    metrics.push({
      caption: t.metricMissing,
      value: format(t.metricMissingUnit, { count: String(state.pristine.missingCount) }),
    });
  }
  if (state.phase === 'cleaned') {
    // 清理前后对比卡（同一 metrics 组件）：前后总占用、实测差值与剩余可清理。
    metrics.push(
      { caption: t.metricLastBefore, value: formatBytes(state.clean.lastBeforeBytes) },
      { caption: t.metricLastAfter, value: formatBytes(state.clean.lastAfterBytes) },
      { caption: t.metricReleased, value: formatBytes(state.clean.releasedBytes) },
      { caption: t.metricRemainCleanable, value: formatBytes(state.clean.cleanAfterBytes) },
    );
  }
  return metrics;
}

/** 占比条：business / SVN 其他（svn 去除 pristine）/ pristine 三段平铺。 */
function buildSpaceBar(state: DiskPanelState): SpaceBarSpec | undefined {
  if (state.total === null || state.business === null || state.svn === null || state.pristineBytes === null) {
    return undefined;
  }
  const t = strings.diskPanel;
  return {
    segments: [
      { key: 'business', label: t.segBusiness, bytes: state.business },
      { key: 'svnOther', label: t.segSvnOther, bytes: Math.max(0, state.svn - state.pristineBytes) },
      { key: 'pristine', label: t.segPristine, bytes: state.pristineBytes },
    ],
    totalBytes: state.total,
  };
}

/** 路径的后缀展示值（点开头隐藏文件不算后缀；无后缀为空串）。 */
function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

/**
 * 大文件表（§7.1 TableSpec）：行 = 业务文件清单（不含 .svn 与 excluded
 * 子树）；size 列 sortType='number' 按字节值排序（sortValues 不进消息）；
 * 行内动作「在 Finder 中显示」按行 ID 映射路径；宿主传入当前排序/筛选/
 * 页码经 sliceTableRows 切片（消息只发当前页）。
 */
function buildDiskFilesTable(
  state: DiskPanelState,
  view: BuildDiskPanelOptions['tableView'],
): TableSpec | undefined {
  const t = strings.diskPanel;
  const columns: TableSpec['columns'] = [
    { key: 'path', label: t.columnPath, sortable: true },
    { key: 'size', label: t.columnSize, align: 'right', sortable: true, sortType: 'number' },
    { key: 'ext', label: t.columnExt, sortable: true },
  ];
  const reveal: ActionSpec = { id: 'revealFileInOS', label: t.actRevealFile };
  const items = state.files.map((file) => ({
    row: {
      id: `file:${file.path}`,
      cells: { path: file.path, size: formatBytes(file.bytes), ext: extOf(file.path) },
      actions: [reveal],
    },
    sortValues: { size: file.bytes },
  }));
  const sort = view?.sort ?? DISK_TABLE_SORT_DEFAULT;
  // ext 筛选 options 由当前清单派生（宿主实例只持 value，不持第二份选项真相）。
  const exts = [...new Set(state.files.map((file) => extOf(file.path)))].sort((a, b) =>
    a === '' ? 1 : b === '' ? -1 : a < b ? -1 : a > b ? 1 : 0,
  );
  const baseFilters = view?.filters ?? createDiskTableFilters();
  const filters = baseFilters.map((filter) =>
    filter.id === 'ext'
      ? {
          ...filter,
          options: [
            { value: 'all', label: strings.panel.filterAll },
            ...exts.map((ext) => ({ value: ext, label: ext === '' ? strings.panel.filterExtNone : ext })),
          ],
        }
      : filter,
  );
  const slice = sliceTableRows(items, columns, sort, filters, view?.page ?? 1, DISK_TABLE_PAGE_SIZE);
  return {
    id: 'diskFiles',
    columns,
    sort,
    filters,
    pagination: {
      page: slice.page,
      pageSize: DISK_TABLE_PAGE_SIZE,
      total: slice.total,
      pageCount: slice.pageCount,
    },
    rows: slice.rows,
    empty: { title: t.tableEmptyTitle, detail: t.tableEmptyDetail },
    filterEmpty: { title: strings.panel.filterEmptyTitle },
    ...(state.phase === 'partial' ? { note: strings.diskPanel.partialBannerTitle } : {}),
  };
}

/** 扫描/重新分析/重新检测入口（同一扫描任务启动入口，Intent 名按场景分列）。 */
function scanAction(state: DiskPanelState, occupancy: VacuumOccupancy, id: 'startScan' | 'rescan', label: string): ActionSpec {
  // busy 期间不放行 startScan/rescan（§7.2 P4 busy 行）；writeLocked 行放行（重新检测不受写锁限制）。
  if (!occupancy.busy) {
    return { id, label };
  }
  return { id, label, disabled: true, disabledReason: strings.diskPanel.scanBusyReason };
}

/** 清理入口：禁用态与宿主 confirmVacuum 守卫用同一矩阵结果（合取含非占用）。 */
function vacuumAction(availability: VacuumAvailability): ActionSpec {
  const t = strings.diskPanel;
  return {
    id: 'confirmVacuum',
    label: t.actConfirmVacuum,
    disabled: !availability.available,
    disabledReason: availability.reason ?? undefined,
  };
}

function scopeAction(): ActionSpec {
  return { id: 'showScopeHelp', label: strings.diskPanel.actScopeHelp };
}

function logAction(): ActionSpec {
  return { id: 'viewTaskLog', label: strings.diskPanel.actLog };
}

function closeAction(): ActionSpec {
  return { id: 'closePanel', label: strings.panel.closeButton };
}

function buildFooter(actions: { primary?: ActionSpec; secondary?: ActionSpec[] }): FooterSpec {
  return { summary: '', primary: actions.primary, secondary: actions.secondary };
}
