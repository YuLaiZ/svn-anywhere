/**
 * P4 磁盘治理任务执行链（M3 技术方案 §2.1 磁盘任务状态机、§6.1 扫描与
 * pristine 检测、§6.2 清理链、§6.3/§9 扫描中断标记）。
 *
 * 执行器与面板会话生命周期解耦（对齐 checkoutTask 先例）：任务对象注册
 * taskRegistry 后由本模块推进与结算，面板（发起或重开绑定）经注入回调
 * 感知进度与出口；终态结果页由执行器按「先写会话缓存（executor）、再
 * 移除任务对象」的结算顺序写入——运行中关闭面板后台完成仍有写入者。
 *
 * 两条任务链：
 * - 扫描（startDiskScan）：任务对象 phase='scanning'（扫描是本地 readdir
 *   遍历、无写命令准备窗口，不经 connecting）；结算 complete→ready /
 *   partial→partial / 取消→scanCanceled / 异常→scanError；结算同时按
 *   出口⑩终结保留中的 vacuum 未决记录（unknown 与 failed-unconfirmed
 *   都终结——重新检测完成即 finish，scanCanceled 未完成不终结）；
 * - 清理（startVacuumTask）：确认后（快照重检开始前）创建任务对象
 *   phase='connecting'（任务执行器通用准备态；面板 DiskPanelState.phase
 *   已按 cleaning 呈现——两套 phase 分列）→ 快照重检（pristine 复读 +
 *   wc.db mtime 对照）→ begin 落盘（kind='vacuum'，scanEpoch/
 *   pristineBefore 随参数面一次写入）→ svn cleanup --vacuum-pristines
 *   （timeoutMs=0、不可取消）→ 命令成功（出口⑨：done+finish）后自动
 *   复测（复测全程面板保持 cleaning；复测经同一底层扫描链 runScanOnce
 *   执行、不另建任务对象——清理任务对象已持有本面板槽位）→ 复测成功
 *   结算 cleaned / 三形态失败由 cleaning 直转 refreshError / 命令失败
 *   落 cleanupFailed（记录 failed-unconfirmed 保留至重新检测完成⑩）。
 *   changed（快照比对不一致或重检读取失败保守收口）与 begin 失败是
 *   预命令出口：不写任务终态缓存（changed 结果页由 P4 控制器经回调
 *   写入——面板内结果转移、结果代次守卫在控制器侧）、一律移除任务
 *   对象（busy 恢复假值）。
 *
 * 扫描中断持久化标记（globalState 按 wcRoot 键控的「扫描进行中」）：
 * 扫描开始写入（清理的自动复测同样走 runScanOnce、同机制写标记），
 * 清除挂底层扫描链的正常返回/异常收口（finally——kill 宿主是唯一残留
 * 形态，重启后重开读到标记显示 scanCanceled 并一次性消费）。标记写入/
 * 清除失败不阻塞扫描本身（降级为日志一行，§6.3 边界）。
 */
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { buildVacuumArgs, readPristineStats, scanDiskUsage } from '../../core/diskUsage';
import type { PristineStats, ScanDiskUsageResult } from '../../core/diskUsage';
import {
  getOperationRegistry,
  kindOf,
  randomOperationId,
  type BeginResult,
  type MementoLike,
  type PristineBefore,
} from '../../core/operations';
import { runOrThrow, type RunOptions } from '../../core/svnCli';
import { readSvnPath } from '../config';
import { format, strings } from '../i18n';
import { createLineBuffer, decodingRunOptions, logCommand, logLine } from '../output';
import { writeSessionResult } from '../sessionResults';
import {
  addTask,
  getTaskById,
  removeTask,
  type DiskResultScope,
  type TaskObject,
} from '../taskRegistry';
import {
  cleanFailed,
  cleanSettled,
  excludedFromScan,
  formatBytes,
  pristineFromStats,
  refreshFailed,
  toDiskCache,
  type DiskPanelCache,
  type DiskPanelState,
} from './diskModel';

/* ---------------------------------------------------------------------------
 * 扫描中断持久化标记（§6.3/§9）
 * ------------------------------------------------------------------------- */

let markerStorage: MementoLike | undefined;

/** activate 时注入宿主 globalState（或测试替身）；传 undefined 卸载。 */
export function setDiskMarkerStorage(memento: MementoLike | undefined): void {
  markerStorage = memento;
}

const scanMarkerKey = (wcRoot: string) => `svnAnywhere.diskScanning|${wcRoot}`;

function updateMarker(wcRoot: string, value: true | undefined, failText: string): void {
  if (!markerStorage) {
    return;
  }
  try {
    void Promise.resolve(markerStorage.update(scanMarkerKey(wcRoot), value)).catch(
      () => logLine(failText, 'disk'),
    );
  } catch {
    logLine(failText, 'disk');
  }
}

/** 扫描开始写入标记（写失败降级为日志，不阻塞扫描）。 */
export function markScanStarted(wcRoot: string): void {
  updateMarker(wcRoot, true, format(strings.diskPanel.scanMarkerWriteFailedLog, { wcRoot }));
}

/** 扫描结算清除标记（清除失败至多重启误报一次 scanCanceled，§6.3 边界）。 */
export function clearScanMarker(wcRoot: string): void {
  updateMarker(wcRoot, undefined, format(strings.diskPanel.scanMarkerClearFailedLog, { wcRoot }));
}

/** 重启后读取并一次性消费标记：true = 上次扫描未结算（按 scanCanceled 呈现）。 */
export function consumeScanMarker(wcRoot: string): boolean {
  if (!markerStorage) {
    return false;
  }
  const marked = markerStorage.get<boolean>(scanMarkerKey(wcRoot), false) === true;
  if (marked) {
    updateMarker(wcRoot, undefined, format(strings.diskPanel.scanMarkerClearFailedLog, { wcRoot }));
  }
  return marked;
}

/* ---------------------------------------------------------------------------
 * 底层扫描链（手动扫描与清理复测共用）
 * ------------------------------------------------------------------------- */

export interface ScanOnceResult {
  scan: ScanDiskUsageResult;
  pristine: PristineStats;
}

/**
 * 单次「扫描 + pristine 检测」：扫描开始写「扫描进行中」标记，正常返回
 * 或异常收口都在 finally 清除（kill 宿主是标记唯一残留形态）。清理任务
 * 的自动复测不经任务对象、直接调用本函数——复测与手动扫描同机制写/
 * 清标记，「复测中断有感知」由此成立（§6.3）。
 */
async function runScanOnce(
  svnPath: string,
  wcRoot: string,
  signal?: AbortSignal,
  onProgress?: (progress: { scanCount: number; currentPath: string }) => void,
): Promise<ScanOnceResult> {
  markScanStarted(wcRoot);
  try {
    const scan = await scanDiskUsage(svnPath, wcRoot, { signal, onProgress });
    const pristine = await readPristineStats(wcRoot);
    return { scan, pristine };
  } finally {
    clearScanMarker(wcRoot);
  }
}

/* ---------------------------------------------------------------------------
 * 扫描任务（§2.1：scanning → {ready | scanCanceled | scanError | partial}）
 * ------------------------------------------------------------------------- */

export type DiskScanOutcome =
  | { kind: 'ready'; scan: ScanDiskUsageResult; pristine: PristineStats }
  | { kind: 'partial'; scan: ScanDiskUsageResult; pristine: PristineStats }
  | { kind: 'scanCanceled' }
  | { kind: 'scanError'; reason: string };

export interface DiskScanCallbacks {
  /** 未识别行/命令输出日志（面板任务日志视图可用）。 */
  onLogLine?(text: string): void;
  /**
   * 扫描进度（已读取条目数与当前路径，core 每 64 条目触发一次）：
   * 面板 scanning 页进度数值的数据源；仅用户扫描任务接入（清理的自动
   * 复测保持 cleaning 相位、无进度 UI，不传回调）。
   */
  onProgress?(progress: { scanCount: number; currentPath: string }): void;
}

interface ScanTaskExtra {
  /** 用户发起的扫描（可取消）；清理复测不经任务对象、无 false 形态，字段留给判定收口。 */
  userScan: boolean;
  resolveDone: (outcome: DiskScanOutcome) => void;
  done: Promise<DiskScanOutcome>;
}

export type DiskScanTask = TaskObject<ScanTaskExtra> & { extra: ScanTaskExtra };

/** 用户扫描判定（gates 的 cancelScan 谓词与控制器取消入口共用）。 */
export function isUserScanTask(task: TaskObject | undefined): boolean {
  const extra = task?.panelKind === 'disk' ? (task.extra as ScanTaskExtra | undefined) : undefined;
  return task?.phase === 'scanning' && extra?.userScan === true;
}

export interface StartDiskScanInput {
  /** 测试注入用；缺省读配置 svnPath。 */
  svnPath?: string;
  wcRoot: string;
  /** 任务创建时的本次打开子目录（跨入口绑定页头的固定参数）。 */
  subPath: string;
  /** 模型侧扫描代次（scanStarted 递增后的值）：缓存页与后续清理确认绑定同一代次。 */
  scanEpoch: number;
  initiatorSessionId: string;
  /** 用户扫描（取消入口仅对该形态放行）；缺省 true。 */
  userScan?: boolean;
  callbacks?: DiskScanCallbacks;
}

export interface StartedDiskScan {
  taskId: string;
  /** 发起面板 await 它做 UI 转移；缓存写入与记录收口在执行器结算内完成（不依赖面板存活）。 */
  done: Promise<DiskScanOutcome>;
}

/**
 * 发起扫描任务（startScan/rescan 的同一执行入口）：同步创建任务对象
 * （scanning）注册 taskRegistry 并返回 taskId 与终态 promise，扫描链
 * 后台推进。扫描无操作记录（vacuum 清理才 begin 记录），任务 ID 仅作
 * 任务对象标识。
 */
export function startDiskScan(input: StartDiskScanInput): StartedDiskScan {
  let resolveDone!: (outcome: DiskScanOutcome) => void;
  const done = new Promise<DiskScanOutcome>((resolve) => {
    resolveDone = resolve;
  });
  const task: DiskScanTask = {
    taskId: randomOperationId(),
    panelKind: 'disk',
    phase: 'scanning',
    resultScope: { wcRoot: input.wcRoot },
    lockKey: input.wcRoot,
    subPath: input.subPath,
    initiatorSessionId: input.initiatorSessionId,
    abortController: new AbortController(),
    extra: { userScan: input.userScan ?? true, resolveDone, done },
  };
  addTask(task);
  void runScanTaskFlow(task, input, input.svnPath ?? readSvnPath()).catch((err: unknown) => {
    // 防御兜底（理论不可达——流程内部已收口全部异常）：done 必定结算。
    task.extra.resolveDone({ kind: 'scanError', reason: err instanceof Error ? err.message : String(err) });
  });
  return { taskId: task.taskId, done: task.extra.done };
}

async function runScanTaskFlow(task: DiskScanTask, input: StartDiskScanInput, svnPath: string): Promise<void> {
  const registry = getOperationRegistry();
  let outcome: DiskScanOutcome;
  try {
    const result = await runScanOnce(svnPath, input.wcRoot, task.abortController.signal, input.callbacks?.onProgress);
    if (task.abortController.signal.aborted) {
      outcome = { kind: 'scanCanceled' };
    } else if (result.scan.phase === 'partial') {
      outcome = { kind: 'partial', scan: result.scan, pristine: result.pristine };
    } else {
      outcome = { kind: 'ready', scan: result.scan, pristine: result.pristine };
    }
  } catch (err) {
    outcome = { kind: 'scanError', reason: errorMessage(err) };
  }
  // 结算顺序（§2.1）：先写结果缓存（executor 一律写入）、再按出口⑩终结
  // 保留中的 vacuum 未决记录、最后移除任务对象（同一结算段内完成——重开
  // 绑定会话经任务移除通知重跑三段时缓存已就绪）。
  writeSessionResult('disk', { wcRoot: input.wcRoot }, scanOutcomeCache(outcome, input.scanEpoch), 'executor');
  if (outcome.kind !== 'scanCanceled') {
    // 重新检测完成（ready/partial/scanError）即终结记录（§2.2 vacuum 行：
    // unknown 与 failed-unconfirmed 都终结；scanCanceled 未完成检测、记录保留）。
    for (const record of registry.pendingForWcRoot(input.wcRoot)) {
      if (
        kindOf(record) === 'vacuum' &&
        (record.phase === 'unknown' || record.phase === 'failed-unconfirmed')
      ) {
        await registry.finish(record.operationId).catch(() => undefined);
      }
    }
  }
  removeTask(task.taskId);
  task.extra.resolveDone(outcome);
}

/** 空数值形态（scanCanceled/scanError 页不展示已读数值）。 */
const EMPTY_CACHE_VALUES = {
  scanComplete: false,
  scanCount: 0,
  total: null,
  business: null,
  svn: null,
  pristineBytes: null,
  files: [] as never[],
  excluded: [] as never[],
} as const;

/** 扫描结算 → 缓存页（执行器不持面板 state，从任务参数与扫描结果构建）。 */
function scanOutcomeCache(outcome: DiskScanOutcome, scanEpoch: number): DiskPanelCache {
  if (outcome.kind === 'ready' || outcome.kind === 'partial') {
    return {
      phase: outcome.kind,
      scanEpoch,
      scanComplete: outcome.kind === 'ready',
      scanCount: outcome.scan.scanCount,
      total: outcome.scan.totals.total,
      business: outcome.scan.totals.business,
      svn: outcome.scan.totals.svn,
      pristineBytes: outcome.scan.totals.pristineBytes,
      pristine: pristineFromStats(outcome.pristine),
      clean: { cleanBeforeBytes: null, cleanAfterBytes: null, lastBeforeBytes: null, lastAfterBytes: null, releasedBytes: null },
      files: outcome.scan.files,
      excluded: excludedFromScan(outcome.scan.excluded),
      errors: outcome.scan.partialReason ? [outcome.scan.partialReason] : [],
      changedReason: null,
      cleanupError: null,
    };
  }
  if (outcome.kind === 'scanError') {
    return { phase: 'scanError', scanEpoch, ...EMPTY_CACHE_VALUES, errors: [outcome.reason], pristine: emptyPristine(), clean: emptyClean(), changedReason: null, cleanupError: null };
  }
  return { phase: 'scanCanceled', scanEpoch, ...EMPTY_CACHE_VALUES, errors: [], pristine: emptyPristine(), clean: emptyClean(), changedReason: null, cleanupError: null };
}

function emptyPristine(): DiskPanelCache['pristine'] {
  return { state: 'ok', reason: null, cacheCount: null, unreferencedBytes: null, missingCount: null };
}

function emptyClean(): DiskPanelCache['clean'] {
  return { cleanBeforeBytes: null, cleanAfterBytes: null, lastBeforeBytes: null, lastAfterBytes: null, releasedBytes: null };
}

/**
 * 取消扫描：仅用户发起的扫描任务放行（清理的复测无取消入口——复测异常
 * 由任务结算直转失败态，不经用户取消）。missing = 任务已终态（不回改）。
 */
export function cancelDiskScan(taskId: string): { ok: true } | { ok: false; reason: 'missing' | 'notUserScan' } {
  const task = getTaskById(taskId);
  if (!task || task.panelKind !== 'disk') {
    return { ok: false, reason: 'missing' };
  }
  if (!isUserScanTask(task)) {
    return { ok: false, reason: 'notUserScan' };
  }
  task.abortController.abort();
  return { ok: true };
}

/* ---------------------------------------------------------------------------
 * 清理任务（§6.2：确认后重检 → begin → 命令 → 复测结算）
 * ------------------------------------------------------------------------- */

/** changed 出口的两种来源（§6.3：读取失败不冒充「检测到变化」）。 */
export type VacuumChangedSource = 'snapshotChanged' | 'readFailed';

/** begin 失败分支（busy 等待提示 / 写失败稍后重试——idConflict 归写失败文案的防御路径）。 */
export type VacuumBeginFailure = 'busy' | 'writeFailed';

export type VacuumOutcome =
  | { kind: 'cleaned'; scan: ScanDiskUsageResult; pristine: PristineStats }
  | { kind: 'cleanupFailed'; message: string }
  | { kind: 'refreshError' };

export interface VacuumTaskCallbacks {
  /**
   * changed 出口（快照比对不一致 / 重检读取失败保守收口）：由 P4 控制器
   * 回调内先写 changed 结果页缓存（结果代次守卫与 UI 转移在控制器），
   * 回调返回后执行器移除任务对象——「先写缓存、再移除任务」的结算顺序
   * 由该调用次序承载，重开会话经任务移除通知重跑时缓存已就绪。
   */
  onChanged(source: VacuumChangedSource, detail: string): void;
  /**
   * begin 失败出口（任务对象已移除、缓存仍持清理前结果页）：原因呈现
   * 为宿主 toast + 输出频道日志（不复用 cleanupError——其语义限定清理
   * 命令失败相位），面板回清理前结果态由控制器完成。
   */
  onBeginFailed(reason: VacuumBeginFailure): void;
  /** 任务终态（缓存已写、任务对象已移除）：控制器应用 reducer 更新 UI。 */
  onSettled(outcome: VacuumOutcome): void;
}

export interface StartVacuumTaskInput {
  svnPath?: string;
  wcRoot: string;
  /**
   * 确认后（beginClean 定格）的面板状态快照：终态缓存页经 diskModel
   * reducer（cleanSettled/cleanFailed/refreshFailed）在其上构建——执行器
   * 不读面板实例 state（重检进行中面板可能已 dispose）。
   */
  baseState: DiskPanelState;
  /** 确认时的 pristine 快照（与 begin 记录的 pristineBefore 同值）。 */
  pristineBefore: PristineBefore;
  /** 确认时 wc.db 的 mtime 基线（读取失败为 null——重检跳过该项对照）。 */
  wcDbMtimeMs: number | null;
  initiatorSessionId: string;
  callbacks: VacuumTaskCallbacks;
}

interface VacuumTaskExtra {
  callbacks: VacuumTaskCallbacks;
  resolveDone: () => void;
  done: Promise<void>;
}

type VacuumTask = TaskObject<VacuumTaskExtra> & { extra: VacuumTaskExtra };

export interface StartedVacuumTask {
  taskId: string;
  /** 全部出口（changed/begin 失败/终态）完成后的收尾信号（自动化驱动用）。 */
  done: Promise<void>;
}

/**
 * 发起清理任务：确认后（快照重检开始前）由 P4 控制器调用——任务对象以
 * phase='connecting'（预命令准备态）注册，重检窗口全程 busy=true（面板
 * 侧已按 cleaning 呈现）；执行链后台推进。
 */
export function startVacuumTask(input: StartVacuumTaskInput): StartedVacuumTask {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const task: VacuumTask = {
    // 预生成 operationId（begin 沿用同 ID 落盘）。
    taskId: randomOperationId(),
    panelKind: 'disk',
    phase: 'connecting',
    resultScope: { wcRoot: input.wcRoot },
    lockKey: input.wcRoot,
    subPath: input.baseState.subPath,
    initiatorSessionId: input.initiatorSessionId,
    abortController: new AbortController(),
    extra: { callbacks: input.callbacks, resolveDone, done },
  };
  addTask(task);
  // done 的收尾挂在流程 finally（全部出口——changed/begin 失败/终态/防御
  // 收口——都必定结算，自动化驱动方 await 不悬挂）。
  void runVacuumFlow(task, input, input.svnPath ?? readSvnPath()).finally(() => {
    task.extra.resolveDone();
  });
  return { taskId: task.taskId, done: task.extra.done };
}

async function runVacuumFlow(task: VacuumTask, input: StartVacuumTaskInput, svnPath: string): Promise<void> {
  const registry = getOperationRegistry();
  const wcRoot = input.wcRoot;
  const callbacks = task.extra.callbacks;
  try {
    // ① 快照重检（确认后、begin 前；扩展内部只读复读，数万文件副本可达
    //    数秒——进行中允许关闭面板，changed 缓存写入走控制器回调的代次
    //    守卫，本流程不依赖面板存活）。对照内容：pristine 复读（回收
    //    清单真相源：cacheCount/unreferencedBytes 与确认时快照比对）+
    //    wc.db mtime（确认时捕获基线）；读取失败（复读落 unavailable 或
    //    stat 失败）按 changed 保守收口——无法确认「快照未变」即不批准。
    const stats = await readPristineStats(wcRoot);
    if (!stats.available) {
      callbacks.onChanged('readFailed', stats.reason ?? strings.diskPanel.changedReadFailureGeneric);
      removeTask(task.taskId);
      return;
    }
    let wcDbMtime: number | null = null;
    try {
      wcDbMtime = lstatSync(join(wcRoot, '.svn', 'wc.db')).mtimeMs;
    } catch {
      wcDbMtime = null;
    }
    if (input.wcDbMtimeMs !== null && wcDbMtime === null) {
      callbacks.onChanged('readFailed', strings.diskPanel.changedReadFailureWcDb);
      removeTask(task.taskId);
      return;
    }
    if (wcDbMtime !== null && input.wcDbMtimeMs !== null && wcDbMtime !== input.wcDbMtimeMs) {
      callbacks.onChanged('snapshotChanged', strings.diskPanel.changedDetailWcDb);
      removeTask(task.taskId);
      return;
    }
    if (
      stats.cacheCount !== input.pristineBefore.cacheCount ||
      stats.unreferencedBytes !== input.pristineBefore.unreferencedBytes
    ) {
      callbacks.onChanged(
        'snapshotChanged',
        format(strings.diskPanel.changedDetailPristine, {
          before: format(strings.diskPanel.changedDetailPristinePair, {
            count: String(input.pristineBefore.cacheCount),
            size: formatBytes(input.pristineBefore.unreferencedBytes),
          }),
          after: format(strings.diskPanel.changedDetailPristinePair, {
            count: String(stats.cacheCount ?? 0),
            size: formatBytes(stats.unreferencedBytes ?? 0),
          }),
        }),
      );
      removeTask(task.taskId);
      return;
    }

    // ② begin 落盘（kind='vacuum'，lockKey/targetPath=规范化 wcRoot，
    //    scanEpoch/pristineBefore 经参数面一次写入；写失败不发起命令）。
    let begin: BeginResult;
    try {
      begin = await registry.begin({
        wcRoot,
        targetRelPath: '.',
        nodeKind: 'dir',
        kind: 'vacuum',
        lockKey: wcRoot,
        operationId: task.taskId,
        targetPath: wcRoot,
        scanEpoch: input.baseState.scanEpoch,
        pristineBefore: input.pristineBefore,
      });
    } catch {
      removeTask(task.taskId);
      callbacks.onBeginFailed('writeFailed');
      return;
    }
    if (!begin.ok) {
      removeTask(task.taskId);
      callbacks.onBeginFailed(begin.reason === 'busy' ? 'busy' : 'writeFailed');
      return;
    }

    // ③ 清理命令（timeoutMs=0——回收可能涉及数十 GiB；不可取消；关闭
    //    面板后台继续——任务对象在 taskRegistry）。进程已 spawn 即命令
    //    已发出：任务相位转 cleaning（记录侧 markPhase('running')）。
    const args = buildVacuumArgs(wcRoot);
    task.phase = 'cleaning';
    const buffer = createLineBuffer('vacuum', 'disk');
    const runOptions: RunOptions = {
      timeoutMs: 0,
      signal: task.abortController.signal,
      onOutput: (text) => buffer.push(text),
      onExit: logCommand(svnPath, args, wcRoot, 'disk'),
      ...decodingRunOptions('disk'),
    };
    // 进程已 spawn 即视为命令已发出（§2.1 映射表）：记录转 running 后再等待结束。
    const runPromise = runOrThrow(svnPath, args, runOptions).then(
      () => undefined as unknown,
      (err: unknown) => err as unknown,
    );
    await registry.markPhase(task.taskId, 'running').catch(() => undefined);
    const commandError = await runPromise;
    if (commandError !== undefined) {
      // 命令失败（可能部分完成）：failed-unconfirmed 保留至重新检测完成
      // （出口⑩）；面板转 cleanupFailed（cleanupError 承载原因、须重新检测）。
      await registry.markPhase(task.taskId, 'failed-unconfirmed').catch(() => undefined);
      settleVacuum(task, cleanFailed(input.baseState, errorMessage(commandError)));
      callbacks.onSettled({ kind: 'cleanupFailed', message: errorMessage(commandError) });
      return;
    }

    // ④ 出口⑨：命令成功 → done + finish（记录随即移除）；随后自动复测
    //    （复测全程面板保持 cleaning，复测成功结算才转 cleaned——数值无
    //    陈旧窗口；refreshError 无记录动作）。
    await registry.finalizeOperation(task.taskId, 'done').catch(() => undefined);
    let retest: ScanOnceResult;
    try {
      retest = await runScanOnce(svnPath, wcRoot, task.abortController.signal);
    } catch {
      settleVacuum(task, refreshFailed(input.baseState));
      callbacks.onSettled({ kind: 'refreshError' });
      return;
    }
    const pristine = pristineFromStats(retest.pristine);
    if (retest.scan.phase !== 'complete' || pristine.state !== 'ok') {
      // 复测失败三形态（复测扫描 scanError/partial、pristine 复测
      // unavailable）一律由 cleaning 直转 refreshError：差值 —、禁再次
      // 清理、须重新检测（runScanOnce 异常收口对应 scanError 形态，已由
      // 上方 catch 承载；此处覆盖 partial 与 unavailable）。
      settleVacuum(task, refreshFailed(input.baseState));
      callbacks.onSettled({ kind: 'refreshError' });
      return;
    }
    const settled = cleanSettled(input.baseState, { scan: retest.scan, pristine });
    settleVacuum(task, settled);
    callbacks.onSettled({ kind: 'cleaned', scan: retest.scan, pristine: retest.pristine });
  } catch (err) {
    // 防御收口（理论不可达）：按命令失败同款结算——记录尽量转
    // failed-unconfirmed（记录未建/已收口时跳过），任务对象不悬挂、done 必定结算。
    await registry.markPhase(task.taskId, 'failed-unconfirmed').catch(() => undefined);
    settleVacuum(task, cleanFailed(input.baseState, errorMessage(err)));
    callbacks.onSettled({ kind: 'cleanupFailed', message: errorMessage(err) });
  }
}

/**
 * 清理终态结算：先写结果缓存（executor）、再移除任务对象（同一同步步骤
 * 内完成，重开绑定会话经任务移除通知重跑三段时缓存已就绪）。reducer
 * 结果相位必在缓存承载集（cleaned/cleanupFailed/refreshError），null
 * 分支不可达——防御性跳过写入（不产生坏缓存），任务对象照常移除。
 */
function settleVacuum(task: VacuumTask, settled: DiskPanelState): void {
  const page = toDiskCache(settled);
  if (page) {
    writeSessionResult('disk', task.resultScope as DiskResultScope, page, 'executor');
  }
  removeTask(task.taskId);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
