/**
 * P4 磁盘治理面板控制器（M3 阶段 3：panels/disk.ts）。
 *
 * 组织形态对齐 panels/checkout.ts：模块级 handle/session 单例 + Intent
 * 分发；处理器只做调度与 IO（确认框、范围说明弹窗、svn 配置读取），
 * 状态变更全部经 diskModel 的 reducer 完成。
 *
 * 关键规则（技术方案 §6/§6.2/§6.3/§7.2/§9）：
 * - 打开按三段顺序恢复（P4 无草稿/新表单段）：①taskRegistry 运行任务
 *   （按「任务对象存在」判定——扫描任务的 scanning 与清理任务的
 *   connecting 准备态都命中；绑定即订阅任务移除通知，会话作用域基准 =
 *   任务 resultScope）→ 扫描中断标记（重启折算 scanCanceled、一次性
 *   消费；优先于记录分诊）→ ②会话结果缓存（除 cleanupUnknown 外全部
 *   结果态；作用域一致才命中，subPath 刷新为本次打开路径、tableView
 *   不恢复）→ ③记录分诊（vacuum unknown 记录派生 cleanupUnknown 页，
 *   不经缓存承载）；
 * - 换副本：面板存在时扫描/清理运行中拒绝；未决 vacuum unknown 记录
 *   （清理结果未知）同样拒绝；其余结果态确认放弃（清缓存+递增代次）；
 *   fresh open（面板已 dispose）从另一副本打开不拒绝——缓存项 wcRoot
 *   不一致即丢弃、新副本全新 idle 会话；运行中任务按①段绑定回发起副本；
 * - 结果代次（resultEpoch）：startScan/rescan/confirmVacuum 与换副本
 *   确认放弃都递增（confirmVacuum 的递增在确认处理第一条同步语句、
 *   清理任务对象创建之前）；changed 结论（确认后快照重检的唯一回包）
 *   按「捕获代次一致才写缓存」守卫——重检窗口内无用户可达的递增动作
 *   （清理任务对象全程在 taskRegistry、busy=true），守卫为防御完备；
 * - busy = OperationRegistry.hasRunning(wcRoot) ∪ taskRegistry 本面板
 *   任务；writeLocked = writeRestriction(wcRoot) 命中（busy 先判）。
 *   两者每次收到 intent 与面板重显时重算并整帧重推（跨面板占用的新
 *   鲜度）；清理可用性 = 矩阵 ∧ 非占用的同一合取，DOM 禁用与宿主守卫
 *   调用同一函数。
 */
import * as vscode from 'vscode';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { getOperationRegistry, kindOf } from '../../../core/operations';
import type { PristineBefore } from '../../../core/operations';
import { format, strings } from '../../i18n';
import { logLine, showOutput } from '../../output';
import { createPanel, type PanelHandle } from '../host';
import type { Intent } from '../protocol';
import type { TableFilterSpec, TableSpec } from '../state';
import {
  beginClean,
  bindRunningTask,
  buildDiskPanelState,
  buildVacuumAvailability,
  cleanFailed,
  cleanSettled,
  createDiskPanelState,
  createDiskTableFilters,
  DISK_TABLE_SORT_DEFAULT,
  enterCleanupUnknown,
  formatBytes,
  fromDiskCache,
  pristineFromStats,
  refreshFailed,
  scanCanceled,
  scanCompleted,
  scanError,
  scanProgress,
  scanStarted,
  setChangedFromReadFailure,
  setChangedFromSnapshot,
  setOccupancy,
  toDiskCache,
  updateTableView,
  type DiskPanelCache,
  type DiskPanelState,
  type DiskTableView,
  type VacuumOccupancy,
} from '../diskModel';
import {
  cancelDiskScan,
  consumeScanMarker,
  isUserScanTask,
  startDiskScan,
  startVacuumTask,
  type DiskScanOutcome,
  type VacuumBeginFailure,
  type VacuumChangedSource,
  type VacuumOutcome,
} from '../diskTask';
import { createP4Gates } from '../gates';
import { bumpResultEpoch, getResultEpoch } from '../../resultEpoch';
import {
  clearSessionResult,
  readSessionResult,
  writeSessionResult,
  type SessionResultEntry,
} from '../../sessionResults';
import {
  getActiveTask,
  hasActiveTask,
  onTaskRemoved,
  type DiskResultScope,
  type TaskRemovedSubscription,
} from '../../taskRegistry';

const PANEL_ID = 'disk';

interface PanelContext {
  extensionUri: vscode.Uri;
  subscriptions: vscode.Disposable[];
  globalState: vscode.Memento;
}

/** 面板打开入口（命令入口在阶段 3 任务 6 接入）：副本根 + 本次打开子目录。 */
export interface DiskOpenEntry {
  wcRoot: string;
  subPath: string;
}

let panelContext: PanelContext | undefined;
let handle: PanelHandle | undefined;
let session: DiskPanelState | undefined;
/** 本次打开入口（重跑恢复的缓存基准与页头刷新源；换副本时更新）。 */
let currentEntry: DiskOpenEntry | undefined;
/** 表格视图状态（宿主唯一持有，渲染时回喂切片；换会话/新扫描重置默认）。 */
let tableSort: TableSpec['sort'] = DISK_TABLE_SORT_DEFAULT;
let tableFilters: TableFilterSpec[] = createDiskTableFilters();
let tablePage = 1;
/** 任务移除通知订阅（绑定即订阅；面板 dispose 时取消）。 */
let taskRemovalSub: TaskRemovedSubscription | undefined;

/** activate 时注入宿主上下文（extensionUri / subscriptions / globalState）。 */
export function setDiskPanelContext(context: PanelContext): void {
  panelContext = context;
}

/* ------------------------- 会话作用域与占用求值 ------------------------- */

/** 当前会话的作用域基准：绑定运行中任务时取任务 resultScope，否则本次打开副本。 */
function sessionScopeBaseline(): DiskResultScope {
  if (session?.binding) {
    return session.binding.resultScope;
  }
  return { wcRoot: currentEntry?.wcRoot ?? session?.wcRoot ?? '' };
}

/** 结果页/会话关联的互斥键（writeLocked 判定的查询键）：P4 恒为副本根。 */
function occupancyWcRoot(): string | undefined {
  return session?.binding?.resultScope.wcRoot ?? session?.wcRoot ?? currentEntry?.wcRoot;
}

/**
 * busy/writeLocked 重算（跨面板新鲜度）：busy 先判 = hasRunning（进程内
 * 运行登记，不从记录 phase 推断——不含 unknown/协调态）∪ 本面板任务；
 * busy=false 才按副本根查 writeRestriction（命中记录按 kind 分列文案）。
 */
function currentOccupancy(): VacuumOccupancy {
  const wcRoot = occupancyWcRoot();
  if (!wcRoot) {
    return { busy: false, writeLocked: false, heldKind: null };
  }
  const registry = getOperationRegistry();
  const busy = registry.hasRunning(wcRoot) || hasActiveTask('disk');
  if (busy) {
    return { busy: true, writeLocked: false, heldKind: null };
  }
  const held = registry.writeRestriction(wcRoot);
  return { busy: false, writeLocked: held !== undefined, heldKind: held ? kindOf(held) : null };
}

/* ------------------------------ 放行表注册 ------------------------------ */

const gates = createP4Gates({
  // 取消仅对用户发起的扫描放行：清理（含其收尾复测）没有取消入口，
  // 复测异常由任务结算直转失败态（§7.2 P4 busy 行）。
  isUserScanning: () => isUserScanTask(getActiveTask('disk')),
});

/* ------------------------------ 渲染推送 ------------------------------ */

function resetTableView(): void {
  tableSort = { ...DISK_TABLE_SORT_DEFAULT };
  tableFilters = createDiskTableFilters();
  tablePage = 1;
}

function pushRender(): void {
  if (!session || !handle) {
    return;
  }
  const occupancy = currentOccupancy();
  session = setOccupancy(session, occupancy);
  const state = buildDiskPanelState(session, {
    busy: occupancy.busy,
    writeLocked: occupancy.writeLocked,
    heldKind: occupancy.heldKind,
    tableView: { sort: tableSort, filters: tableFilters, page: tablePage },
  });
  handle.update(state, handle.sessionId);
}

/* --------------------------- 命令入口与单实例 --------------------------- */

/** realpath 归一（目录不存在等失败形态回退原值）。 */
function normalizePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** 该副本根是否存在未决的 vacuum unknown 记录（清理结果未知——换副本拒绝的判定）。 */
function hasCleanupUnknownRecord(wcRoot: string): boolean {
  return getOperationRegistry()
    .pendingForWcRoot(wcRoot)
    .some((record) => kindOf(record) === 'vacuum' && record.phase === 'unknown');
}

/**
 * 打开 P4 面板（命令入口在阶段 3 任务 6 接入）：单实例——同副本 reveal；
 * 换副本在扫描/清理运行中或清理结果未知（vacuum unknown 记录未决）时拒绝，
 * 其余结果态确认放弃后建立新副本 idle 会话；面板不存在时按三段顺序恢复。
 */
export async function openDiskPanel(entry: DiskOpenEntry): Promise<void> {
  if (!panelContext) {
    return;
  }
  const wcRoot = normalizePath(entry.wcRoot);
  const subPath = normalizePath(entry.subPath);
  if (handle && session) {
    if (session.wcRoot === wcRoot || session.binding?.resultScope.wcRoot === wcRoot) {
      // 同副本复用：reveal 即可（占用态随重推重算——跨面板新鲜度）。
      handle.reveal();
      pushRender();
      return;
    }
    // 换副本：运行中拒绝（扫描/清理不能被切换动作打断，也不可并存）。
    if (hasActiveTask('disk')) {
      handle.toast('info', format(strings.panel.panelBusySwitchRejected, { target: wcRoot }));
      handle.reveal();
      return;
    }
    // 清理结果未知（vacuum unknown 记录未决）时拒绝：未知结果不被新目标
    // 覆盖，重新检测完成即恢复可切换（与 P3 unknown 同口径）。
    if (hasCleanupUnknownRecord(sessionScopeBaseline().wcRoot)) {
      handle.toast('info', strings.diskPanel.cleanupUnknownBanner);
      handle.reveal();
      return;
    }
    if (session.phase !== 'idle') {
      const ok = await vscode.window.showWarningMessage(
        strings.panel.switchDiscardTitle,
        { modal: true, detail: strings.diskPanel.switchDiscardDetail },
        strings.panel.switchDiscardButton,
      );
      if (ok !== strings.panel.switchDiscardButton) {
        return;
      }
      if (!handle || !session) {
        return;
      }
      if (hasActiveTask('disk')) {
        handle.toast('info', format(strings.panel.panelBusySwitchRejected, { target: wcRoot }));
        return;
      }
    }
    if (!handle.switchSession()) {
      return;
    }
    // 确认放弃：清结果缓存（换副本的离页动作）并递增结果代次。
    clearSessionResult('disk');
    bumpResultEpoch('disk');
  }
  handle ??= createPanel(
    PANEL_ID,
    { title: strings.diskPanel.panelTitle, gates },
    { onIntent, onViewReady, onDispose: onPanelDispose },
    panelContext,
  );
  currentEntry = { wcRoot, subPath };
  recoverDiskSession(handle.sessionId);
}

/** webview 重建握手：视图输入序号归零并重推（占用态随重推重算）。 */
function onViewReady(): void {
  pushRender();
}

/** 面板销毁：只清面板 UI 状态与订阅；扫描/清理任务与记录照常。 */
function onPanelDispose(): void {
  handle = undefined;
  session = undefined;
  taskRemovalSub?.dispose();
  taskRemovalSub = undefined;
}

/* ------------------------------ 三段恢复 ------------------------------ */

/** 重启折算的 scanCanceled 缓存页（不展示任何已读数值——标记只证明「扫描曾进行」）。 */
function scanCanceledCache(scanEpoch: number): DiskPanelCache {
  return {
    phase: 'scanCanceled',
    scanEpoch,
    scanComplete: false,
    scanCount: 0,
    total: null,
    business: null,
    svn: null,
    pristineBytes: null,
    pristine: { state: 'ok', reason: null, cacheCount: null, unreferencedBytes: null, missingCount: null },
    clean: { cleanBeforeBytes: null, cleanAfterBytes: null, lastBeforeBytes: null, lastAfterBytes: null, releasedBytes: null },
    files: [],
    excluded: [],
    errors: [],
    changedReason: null,
    cleanupError: null,
  };
}

/**
 * 建立/重建会话并按 P4 重开顺序恢复（§6.3 三段；重跑的作用域基准 =
 * 会话绑定的任务 resultScope——跨副本绑定会话在任务完成后按任务副本
 * 命中其终态缓存页）：①运行任务（含跨副本绑定）→ 扫描中断标记（重启
 * 折算）→ ②会话结果缓存 → ③vacuum unknown 记录分诊（cleanupUnknown
 * 页不经缓存承载）→ idle。
 */
function recoverDiskSession(sessionId: string): void {
  subscribeSessionHooks(sessionId);
  const entry = currentEntry ?? { wcRoot: '', subPath: '' };
  const base = createDiskPanelState({ sessionId, wcRoot: entry.wcRoot, subPath: entry.subPath });

  // ① 运行中任务（按「任务对象存在」判定，不对照 task.phase 相位枚举——
  // 扫描任务的 scanning 与清理任务的 connecting 准备态都命中；跨副本打开
  // 绑定任务的 resultScope，页头 subPath 取任务创建时记录的打开子目录）。
  const task = getActiveTask('disk');
  if (task) {
    const scope = task.resultScope as DiskResultScope;
    const subPath = task.subPath ?? entry.subPath;
    session = bindRunningTask(base, {
      kind: task.phase === 'scanning' ? 'scan' : 'clean',
      wcRoot: scope.wcRoot,
      subPath,
    });
    resetTableView();
    pushRender();
    return;
  }

  // ①.5 扫描中断标记（重启折算）：读到显示 scanCanceled 并一次性消费——
  // 与 vacuum unknown 记录并存时标记优先（记录不因呈现而消费，重新分析
  // 完成时同时终结）；无标记不误报。缓存是内存态、重启必空，与标记无并
  // 存形态，检查位次即承载优先级。
  if (consumeScanMarker(entry.wcRoot)) {
    session = fromDiskCache(base, scanCanceledCache(base.scanEpoch), entry.subPath);
    resetTableView();
    pushRender();
    return;
  }

  // ② 会话结果缓存（缓存项携带 wcRoot：与基准不一致即丢弃并继续后续段；
  // 命中恢复结果页并把 subPath 刷新为本次打开路径、tableView 不随缓存恢复）。
  const cached = readSessionResult('disk', { wcRoot: entry.wcRoot }) as SessionResultEntry | undefined;
  if (cached) {
    session = fromDiskCache(base, cached.page as DiskPanelCache, entry.subPath);
    resetTableView();
    pushRender();
    return;
  }

  // ③ 记录分诊：vacuum unknown 记录派生 cleanupUnknown 页（「先重新检
  // 测」；writeLocked 同步生效——重新检测入口在放行表内）。
  if (hasCleanupUnknownRecord(entry.wcRoot)) {
    session = enterCleanupUnknown(base);
    resetTableView();
    pushRender();
    return;
  }

  session = base;
  resetTableView();
  pushRender();
}

/** 绑定即订阅：任务移除通知（出口/终态完成后重跑三段，不停在进度页/清理中页）。 */
function subscribeSessionHooks(sessionId: string): void {
  taskRemovalSub?.dispose();
  taskRemovalSub = onTaskRemoved('disk', sessionId, () => {
    rerunRecovery();
  });
}

/** 重跑恢复（任务移除通知触发）：基准 = 会话绑定的任务 resultScope，否则本次打开副本。 */
function rerunRecovery(): void {
  if (!handle || !session) {
    return;
  }
  const baseline = sessionScopeBaseline();
  currentEntry = { wcRoot: baseline.wcRoot, subPath: currentEntry?.subPath ?? baseline.wcRoot };
  recoverDiskSession(handle.sessionId);
}

/* ------------------------------ 意图分发 ------------------------------ */

async function onIntent(intent: Intent, context: { sessionId: string; busy: boolean }): Promise<void> {
  if (!handle || !session || handle.sessionId !== context.sessionId) {
    return;
  }
  // 跨面板占用的新鲜度：每次收到 intent 重算占用并整帧重推（§6.2）。
  switch (intent.kind) {
    case 'startScan':
    case 'rescan':
      // startScan/rescan 是同一扫描任务启动入口的两个 Intent 名，不做两套分支。
      handleStartScan(context.sessionId);
      return;
    case 'cancelScan':
      handleCancelScan();
      return;
    case 'confirmVacuum':
      await handleConfirmVacuum(context.sessionId);
      return;
    case 'showScopeHelp':
      handleShowScopeHelp();
      return;
    case 'viewTaskLog':
      // P4 任务日志（扫描/清理）走磁盘治理专属频道（F128 按操作类型分频道）。
      showOutput(false, 'disk');
      pushRender();
      return;
    case 'closePanel':
      handle.dispose();
      return;
    case 'revealFileInOS':
      handleRevealFile(intent.rowId);
      return;
    case 'setSort':
      tableSort = { key: intent.key, direction: intent.direction };
      applyTableView();
      return;
    case 'setFilter':
      tableFilters = tableFilters.map((filter) =>
        filter.id === intent.filterId ? { ...filter, value: intent.value } : filter,
      );
      applyTableView();
      return;
    case 'setPage':
      tablePage = Math.max(1, Math.floor(intent.page));
      applyTableView();
      return;
    default:
      return;
  }
}

/** 表格视图变更：回写模型镜像并重推（真相源是宿主视图状态，模型只读镜像）。 */
function applyTableView(): void {
  if (!session) {
    return;
  }
  const view: DiskTableView = {
    sortKey: tableSort.key === 'path' ? 'path' : 'size',
    sortDesc: tableSort.direction === 'desc',
    filter: tableFilters.find((filter) => filter.id === 'path')?.value ?? '',
    type: tableFilters.find((filter) => filter.id === 'ext')?.value ?? 'all',
    page: tablePage,
  };
  session = updateTableView(session, view);
  pushRender();
}

/** 会话存活的守卫变更（await 返回后套用模型转移；面板销毁/会话切换时空转）。 */
function applyIfLive(sessionId: string, mutate: (s: DiskPanelState) => DiskPanelState): void {
  if (!handle || !session || handle.sessionId !== sessionId || session.sessionId !== sessionId) {
    return;
  }
  session = mutate(session);
  pushRender();
}

/* ------------------------------ 扫描意图 ------------------------------ */

/**
 * 开始/重新分析/重新检测（同一扫描任务入口）：递增结果代次（新扫描即新
 * 结果上下文——迟到的 changed 结论不得覆盖新扫描结果页）→ 模型转
 * scanning → 发起扫描任务。扫描进度（core 每 64 条目一次）经
 * scanProgress 更新会话数值，整帧重推按 ≥100ms 时间节流（十万级副本
 * 上千次回调不放大渲染量；终态结算照常整帧刷新，节流只影响中间帧）。
 * 终态缓存与记录收口（出口⑩终结未决 vacuum 记录）由执行器结算完成，
 * 不依赖面板存活；发起会话的 UI 转移经 done 回调按模型代次守卫应用。
 */
function handleStartScan(sessionId: string): void {
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  if (hasActiveTask('disk')) {
    // 放行表 busy 行已拦（防御：任务存在时不重复发起）。
    pushRender();
    return;
  }
  bumpResultEpoch('disk');
  session = scanStarted(session);
  const scanEpoch = session.scanEpoch;
  const wcRoot = session.wcRoot;
  pushRender();
  let lastProgressRender = 0;
  const started = startDiskScan({
    wcRoot,
    subPath: session.subPath,
    scanEpoch,
    initiatorSessionId: sessionId,
    callbacks: {
      // 进度回调（非确定进度：已读取条目与当前路径）：会话守卫与
      // applyIfLive 同款，但重推走独立节流（applyIfLive 每次都整帧推送）。
      onProgress: (progress) => {
        if (!handle || !session || handle.sessionId !== sessionId || session.sessionId !== sessionId) {
          return;
        }
        session = scanProgress(session, { count: progress.scanCount, currentPath: progress.currentPath });
        const now = Date.now();
        if (now - lastProgressRender >= 100) {
          lastProgressRender = now;
          pushRender();
        }
      },
    },
  });
  void started.done.then((outcome) => {
    applyScanOutcome(sessionId, scanEpoch, outcome);
  });
}

/** 扫描终态 → 发起会话 UI（模型按扫描代次与相位守卫丢弃迟到回包；缓存由执行器写入）。 */
function applyScanOutcome(sessionId: string, epoch: number, outcome: DiskScanOutcome): void {
  applyIfLive(sessionId, (s) => {
    switch (outcome.kind) {
      case 'ready':
      case 'partial':
        return scanCompleted(s, epoch, outcome.scan, pristineFromStats(outcome.pristine));
      case 'scanCanceled':
        return scanCanceled(s, epoch);
      case 'scanError':
        return scanError(s, epoch, outcome.reason);
    }
  });
}

/** 取消扫描：仅用户扫描放行（清理复测无取消入口）；竞态（已终态）不回改。 */
function handleCancelScan(): void {
  const task = getActiveTask('disk');
  if (!task) {
    pushRender();
    return;
  }
  const result = cancelDiskScan(task.taskId);
  if (!result.ok) {
    // 任务已终态或为清理任务：结果页由 done 结算呈现，不回改。
    pushRender();
  }
}

/* ------------------------------ 清理意图 ------------------------------ */

/** 确认时捕获的 wc.db mtime 基线（重检对照；读取失败为 null）。 */
function wcDbMtimeOf(wcRoot: string): number | null {
  try {
    return lstatSync(join(wcRoot, '.svn', 'wc.db')).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 确认清理（§6.2 完整链）：
 * ① 确认处理第一条同步语句递增结果代次（任何 await 之前——迟到的 changed
 *    结论不得覆盖已进入清理流程的结果上下文）；
 * ② 最终可用性合取守卫（矩阵 ∧ 非占用，与 DOM 禁用同一函数）；
 * ③ 确认框（完整根路径/预计数量体积/保留范围，missingCount>0 标注偏大）；
 * ④ 确认后先转 cleaning 再创建清理任务对象（重检开始前——重检窗口全程
 *    busy=true），执行链后台推进；
 * ⑤ changed/begin 失败/终态出口经执行器回调：changed 由本控制器写缓存
 *    （代次守卫）+UI；begin 失败 toast+日志、面板回清理前结果态；终态
 *    应用 reducer（cleanSettled/cleanFailed/refreshFailed）。
 */
async function handleConfirmVacuum(sessionId: string): Promise<void> {
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  // ① 递增结果代次（第一条同步语句、在任何 await 之前）。
  const epoch = bumpResultEpoch('disk');
  // ② 最终合取守卫（与 DOM 禁用同一结果——不出现「按钮可点、点击被拒」）。
  const occupancy = currentOccupancy();
  const availability = buildVacuumAvailability(session, occupancy);
  if (!availability.available) {
    handle.toast('info', availability.reason ?? strings.diskPanel.vacuumReasonUndetected);
    pushRender();
    return;
  }
  const wcRoot = session.wcRoot;
  const pristine = session.pristine;
  const count = pristine.cacheCount ?? 0;
  const size = formatBytes(pristine.unreferencedBytes);
  let detail = format(strings.diskPanel.vacuumConfirmDetail, {
    wcRoot,
    count: String(count),
    size,
    keepScope: strings.diskPanel.vacuumConfirmKeepScope,
  });
  if ((pristine.missingCount ?? 0) > 0) {
    detail += format(strings.diskPanel.vacuumConfirmMissingSuffix, { count: String(pristine.missingCount) });
  }
  // ③ 确认框（绑定当前 scanEpoch 的预计量——数值即确认时快照）。
  const confirmed = await vscode.window.showWarningMessage(
    format(strings.diskPanel.vacuumConfirmTitle, { epoch: String(session.scanEpoch) }),
    { modal: true, detail },
    strings.diskPanel.vacuumConfirmButton,
  );
  if (confirmed !== strings.diskPanel.vacuumConfirmButton) {
    return;
  }
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  if (hasActiveTask('disk')) {
    handle.toast('info', strings.diskPanel.vacuumReasonBusy);
    pushRender();
    return;
  }
  const preCleanState = session;
  const pristineBefore: PristineBefore = {
    cacheCount: pristine.cacheCount ?? 0,
    unreferencedBytes: pristine.unreferencedBytes ?? 0,
    missingCount: pristine.missingCount ?? null,
  };
  const wcDbMtimeMs = wcDbMtimeOf(wcRoot);
  // ④ 面板转 cleaning（cleaning 覆盖「清理命令 + 自动复测」全程），
  //    baseState 定格 beginClean 后快照（终态缓存页经 reducer 在其上构建）。
  const baseState = beginClean(session);
  session = baseState;
  pushRender();
  startVacuumTask({
    wcRoot,
    baseState,
    pristineBefore,
    wcDbMtimeMs,
    initiatorSessionId: sessionId,
    callbacks: {
      // changed 出口（快照比对不一致/重检读取失败保守收口）：结果页由 P4
      // 控制器写入（面板内结果转移）——先按结果代次守卫写缓存、执行器随
      // 后移除任务对象；守卫不一致（重检窗口内无用户可达递增动作，防御
      // 完备）或写侧跨作用域校验拒绝时仅丢结论，任务照常移除。
      onChanged: (source: VacuumChangedSource, detailText: string) => {
        if (getResultEpoch('disk') === epoch) {
          const changed =
            source === 'snapshotChanged'
              ? setChangedFromSnapshot(baseState, detailText)
              : setChangedFromReadFailure(baseState, detailText);
          const page = toDiskCache(changed);
          if (page) {
            writeSessionResult('disk', { wcRoot }, page, 'controller');
          }
          applyIfLive(sessionId, () => changed);
        }
      },
      // begin 失败（busy/写失败）：不复用 cleanupError（语义限定清理命令
      // 失败相位），以宿主 toast + 输出频道日志承载；面板回清理前结果态
      //（缓存仍持清理前结果页）。
      onBeginFailed: (reason: VacuumBeginFailure) => {
        const notice =
          reason === 'busy'
            ? strings.diskPanel.vacuumBeginBusyNotice
            : strings.diskPanel.vacuumBeginWriteFailedNotice;
        logLine(notice, 'disk');
        handle?.toast('info', notice);
        applyIfLive(sessionId, () => preCleanState);
      },
      // 任务终态（缓存已由执行器写入、任务对象已移除）：应用 reducer 更新 UI。
      onSettled: (outcome: VacuumOutcome) => {
        applyIfLive(sessionId, () => {
          switch (outcome.kind) {
            case 'cleaned':
              return cleanSettled(baseState, {
                scan: outcome.scan,
                pristine: pristineFromStats(outcome.pristine),
              });
            case 'cleanupFailed':
              return cleanFailed(baseState, outcome.message);
            case 'refreshError':
              return refreshFailed(baseState);
          }
        });
      },
    },
  });
}

/* ------------------------------ 只读意图 ------------------------------ */

/** 范围说明（excluded 清单：嵌套副本/externals 落点/解析失败保守排除）。 */
function handleShowScopeHelp(): void {
  if (!session) {
    return;
  }
  const title = format(strings.diskPanel.scopeHelpTitle, { wcRoot: session.wcRoot });
  const body =
    session.excluded.length === 0
      ? strings.diskPanel.scopeHelpEmpty
      : session.excluded
          .map((item) => format(strings.diskPanel.scopeHelpItem, { path: item.path, reason: item.reason }))
          .join('\n');
  // showInformationMessage 的其余参数是按钮项——清单内容并入消息本体展示。
  void vscode.window.showInformationMessage(`${title}\n${body}`);
  pushRender();
}

/** 表格行内「在 Finder 中显示」：行 ID（file:<相对路径>）→ 绝对路径映射。 */
function handleRevealFile(rowId: string): void {
  if (!session) {
    return;
  }
  const rel = rowId.startsWith('file:') ? rowId.slice('file:'.length) : '';
  const file = session.files.find((item) => item.path === rel);
  if (!file) {
    return;
  }
  void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(join(session.wcRoot, file.path)));
  pushRender();
}

/** 测试辅助：重置面板控制器模块级状态（真实宿主不需要）。 */
export function resetDiskPanelController(): void {
  handle = undefined;
  session = undefined;
  currentEntry = undefined;
  resetTableView();
  taskRemovalSub?.dispose();
  taskRemovalSub = undefined;
}

/** 测试与自动化辅助：读取当前会话状态快照（mock-host 断言用）。 */
export function diskSessionSnapshot(): DiskPanelState | undefined {
  return session;
}

/** 测试与自动化辅助：读取 P4 会话结果缓存（mock-host 断言「后台终态写缓存」用）。 */
export function readDiskCachedResult(wcRoot: string): SessionResultEntry | undefined {
  return readSessionResult('disk', { wcRoot });
}
