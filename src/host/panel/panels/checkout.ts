/**
 * P3 检出/导入面板控制器（M3 阶段 1：mode=checkout 侧完整实现；import
 * 侧流程处理器在同面板扩展，本文件为其预留注册位）。
 *
 * 组织形态对齐 panels/commit.ts：模块级 handle/session 单例 + Intent 分发；
 * 处理器只做调度与 IO（确认框、目录选择器、svn 命令、globalState），
 * 状态变更全部经 checkoutModel 的 reducer 完成。
 *
 * 关键规则（技术方案 §2.1/§4.1/§4.3/§4.4/§9）：
 * - 打开按五段顺序恢复：①taskRegistry 运行任务（绑定即订阅任务移除通知，
 *   会话作用域基准 = 任务 resultScope）→ ②会话结果缓存（作用域一致才命中）
 *   → ③未终态记录分诊（两阶段查询阶段一：按入口匹配 targetPath）
 *   → ④草稿 → ⑤新表单；缓存终态优先于记录分诊；
 * - 结果代次（resultEpoch）：任务启动（startCheckout/resumeCheckout）、
 *   离页回表单动作（newTask/abandonResidue）、模式与同模式换目标确认放弃
 *   都递增；只读核验（verifyCheckout）不递增——结论按「捕获代次一致才写入」
 *   守卫，代次一致或面板已 dispose 照常写缓存与收口，不一致丢弃；
 * - 任务与面板生命周期解耦：终态缓存的写入者是执行器（checkoutTask），
 *   面板关闭后任务照常结算；onPanelDispose 只清面板 UI 状态（暂存表单
 *   草稿、取消订阅），任务与记录不受影响；
 * - busy/writeLocked 每次收到 intent 与重推时重算并整帧重推；放行表经
 *   createP3Gates 注入（宿主守卫与 DOM 禁用同一张表、同一批谓词）。
 */
import * as vscode from 'vscode';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';
import {
  checkRemote,
  escapeUrlPeg,
  schemeAcceptsCredentials,
  type CheckoutDepth,
  type RemoteIdentity,
} from '../../../core/checkout';
import {
  getOperationRegistry,
  kindOf,
  lockKeyOf,
  type OperationRecord,
} from '../../../core/operations';
import { readCheckoutDefaultDepth, readSvnPath, readTimeoutMs } from '../../config';
import { format, strings } from '../../i18n';
import { decodingRunOptions, logCommand, logLine, showOutput } from '../../output';
import { promptForCredentials } from '../../auth';
import { createPanel, type PanelHandle } from '../host';
import type { Intent } from '../protocol';
import type { PanelState } from '../state';
import {
  addHistoryUrl,
  backToForm,
  beginTask,
  buildCheckoutPanelState,
  buildInterruptedPage,
  connAuth,
  connAuthCancel,
  connAuthResume,
  connNext,
  connSettled,
  consumeIdentity,
  createCheckoutPanelState,
  enterReview,
  fromDraft,
  markRecovered,
  newTask,
  pickDirectDir,
  pickParentDir,
  selectHistoryUrl,
  setReviewInfo,
  setReviewError,
  setResult,
  setVerifyOutcome,
  switchMode,
  syncInput,
  taskPhase,
  taskProgress,
  toDraft,
  useDirName,
  useUrlName,
  URL_HISTORY_LIMIT,
  type CheckoutFormFieldId,
  type CheckoutPanelEntry,
  type CheckoutPanelState,
  type CheckoutTaskPhase,
  type P3Mode,
  type P3ResultPage,
} from '../checkoutModel';
import {
  cancelCheckoutTask,
  recheckCheckoutTarget,
  resumeCheckoutTask,
  startCheckoutTask,
  verifyCheckoutOnly,
  type CheckoutTaskCallbacks,
  type CheckoutTaskOutcome,
  type TargetRecheckFailure,
} from '../checkoutTask';
import {
  clearDraft,
  createEmptyFormDraft,
  containsSensitiveUrl,
  readDraft,
  saveDraft,
  type CheckoutFormDraft,
} from '../drafts';
import { createP3Gates } from '../gates';
import {
  bumpResultEpoch,
  getResultEpoch,
} from '../../resultEpoch';
import {
  clearSessionResult,
  matchReadonlyVerify,
  onSessionResultUpdated,
  readSessionResult,
  settleReadonlyVerify,
  writeSessionResult,
  type SessionResultUpdatedSubscription,
} from '../../sessionResults';
import {
  getActiveTask,
  getTaskById,
  hasActiveTask,
  onTaskRemoved,
  type CheckoutResultScope,
  type TaskRemovedSubscription,
} from '../../taskRegistry';

const PANEL_ID = 'checkout';
/** URL 历史（检出/导入共用，成功才记录）的 globalState 键。 */
const URL_HISTORY_KEY = 'svnAnywhere.checkoutUrlHistory';
/** 任务相位镜像的同步间隔：connecting→running 的转移由执行器直改任务对象，控制器轮询同步到渲染镜像。 */
const TASK_PHASE_POLL_MS = 120;
/** 流式进度的渲染节流间隔（拼帧推送，不逐行推 render）。 */
const PROGRESS_RENDER_THROTTLE_MS = 120;
/** 「改用新目录」放行的结果页类别（其余结果页不提供该动作）。 */
const RESIDUE_RESULT_KINDS: readonly string[] = ['canceled', 'failed', 'interrupted', 'resumeBlocked'];

interface PanelContext {
  extensionUri: vscode.Uri;
  subscriptions: vscode.Disposable[];
  globalState: vscode.Memento;
}

/** 面板打开入口（命令入口产物）：入口 realpath + 模式 + 模式专属目录。 */
export interface CheckoutOpenEntry {
  /** 入口路径 realpath（草稿键与 resultScope.entryKey 的基准）。 */
  entryKey: string;
  mode: P3Mode;
  /** 检出：打开入口的父目录；导入：源目录。 */
  parentDir?: string;
  sourceDir?: string;
}

let panelContext: PanelContext | undefined;
let handle: PanelHandle | undefined;
let session: CheckoutPanelState | undefined;
let formRevision = 0;
/** 任务移除通知订阅（绑定即订阅；面板 dispose 时取消，订阅存活即代表会话存活）。 */
let taskRemovalSub: TaskRemovedSubscription | undefined;
/** 只读结论写入后的重跑订阅（重开会话停在带提示的旧结果页时由推送自动转结论页）。 */
let resultUpdatedSub: SessionResultUpdatedSubscription | undefined;
/** 相位轮询定时器（任务移除自动退出；会话切换/面板 dispose 时清理）。 */
let phaseTimer: ReturnType<typeof setInterval> | undefined;

/** activate 时注入宿主上下文（extensionUri / subscriptions / globalState）。 */
export function setCheckoutPanelContext(context: PanelContext): void {
  panelContext = context;
}

/* ------------------------------ URL 历史存储 ------------------------------ */

function loadUrlHistory(): string[] {
  const raw = panelContext?.globalState.get<unknown>(URL_HISTORY_KEY);
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === 'string').slice(0, URL_HISTORY_LIMIT)
    : [];
}

function saveUrlHistory(history: readonly string[]): void {
  void panelContext?.globalState.update(URL_HISTORY_KEY, [...history].slice(0, URL_HISTORY_LIMIT));
}

/**
 * 成功后记录 URL 历史：写入前过滤含用户信息/query/fragment 的 URL
 * （form.url 虽已过校验，双层过滤保证任何调用形态都不落敏感值）。
 */
function recordUrlHistory(url: string): void {
  if (url === '' || containsSensitiveUrl(url)) {
    return;
  }
  saveUrlHistory(addHistoryUrl(loadUrlHistory(), url));
}

/* ------------------------- 会话作用域与占用求值 ------------------------- */

/** 当前会话的作用域基准：绑定运行中任务/结果页时取其 resultScope，否则本次打开入口 + 当前模式。 */
function sessionScopeBaseline(): CheckoutResultScope {
  if (session?.binding) {
    return session.binding.resultScope;
  }
  if (session) {
    return { entryKey: session.entry.entryKey, mode: session.mode };
  }
  return { entryKey: '', mode: 'checkout' };
}

/**
 * 结果页关联的互斥键（writeLocked 判定与续检/放弃动作对象）：运行中任务取
 * 任务 lockKey；checkout 结果页按目标路径（checkout 记录的 lockKey=目标路径）。
 */
function activeLockKeyOf(state: CheckoutPanelState): string | undefined {
  const result = state.result;
  if (result?.mode === 'checkout') {
    return result.path;
  }
  return undefined;
}

/** busy/writeLocked 重算：busy 先判（任务在途即真），writeLocked 仅在非 busy 时按结果页关联键查写限制。 */
function recomputeOccupation(state: CheckoutPanelState): CheckoutPanelState {
  const busy = hasActiveTask('checkout');
  let writeLocked = false;
  if (!busy) {
    const lockKey = activeLockKeyOf(state);
    if (lockKey) {
      writeLocked = getOperationRegistry().writeRestriction(lockKey) !== undefined;
    }
  }
  return { ...state, busy, writeLocked };
}

/**
 * 按目标路径取当前未收口的 residue-pending 检出记录（核验/续检/放弃的动作
 * 对象；pendingForWcRoot 同步读内存记录，checkout 记录的键即目标路径）。
 */
export function residueRecordFor(targetPath: string): OperationRecord | undefined {
  return getOperationRegistry()
    .pendingForWcRoot(targetPath)
    .filter((record) => kindOf(record) === 'checkout' && record.phase === 'residue-pending')
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

/**
 * 续检占用谓词（与 beginResume 的占用判定同一口径）：记录仍是本面板的
 * residue-pending 且同键无他人 active 持有、无写限制、无运行登记。
 * 「面板自己的 residue-pending」不构成写锁（restrictsWrite 不含该相位），
 * 他人持有则不放行——gates 的 canResume 与 resumeCheckout 处理器共用本谓词。
 */
export function canResumeCheckoutTarget(targetPath: string): boolean {
  const record = residueRecordFor(targetPath);
  if (!record) {
    return false;
  }
  const key = lockKeyOf(record);
  const registry = getOperationRegistry();
  return !registry.hasActive(key) && !registry.writeRestriction(key) && !registry.hasRunning(key);
}

/** 续检被占时的分列提示文案（按占用记录 kind×在途/冻结，同一张文案表）。 */
export function resumeBusyNotice(record: OperationRecord): string {
  const t = strings.checkoutPanel;
  const kind = kindOf(record);
  const frozen = ['unknown', 'committed-pending-coordination', 'coordination-blocked'].includes(record.phase);
  if (kind === 'commit') return frozen ? t.resumeBusyCommitFrozen : t.resumeBusyCommitRunning;
  if (kind === 'ignore') return frozen ? t.resumeBusyIgnoreFrozen : t.resumeBusyIgnoreRunning;
  if (kind === 'vacuum') return frozen ? t.resumeBusyVacuumFrozen : t.resumeBusyVacuumRunning;
  if (kind === 'checkout') return t.resumeBusyCheckoutRunning;
  if (kind === 'import') return frozen ? t.resumeBusyImportFrozen : t.resumeBusyImportRunning;
  return t.resumeBusyDefault;
}

/* ------------------------------ 放行表注册 ------------------------------ */

const gates = createP3Gates({
  taskPhase: () => session?.task?.phase,
  canResume: () => {
    const result = session?.result;
    return result?.mode === 'checkout' && result.kind === 'resumable'
      ? canResumeCheckoutTarget(result.path)
      : false;
  },
  isMergedOutcome: () => false, // 导入侧阶段 2 接入（检出侧恒 false）
  isSnapshotIncomplete: () => false, // 导入侧阶段 2 接入（检出侧恒 false）
  isResidueResultPage: () => {
    const result = session?.result;
    return result?.mode === 'checkout' && RESIDUE_RESULT_KINDS.includes(result.kind);
  },
});

/* ------------------------------ 渲染推送 ------------------------------ */

function pushRender(): void {
  if (!session || !handle) {
    return;
  }
  session = recomputeOccupation(session);
  const verifyPending =
    session.step === 'result' &&
    matchReadonlyVerify('checkout', sessionScopeBaseline(), getResultEpoch('checkout'));
  // resumable 页「继续原检出」的 DOM 禁用与宿主守卫共用同一占用谓词。
  const resumeAvailable =
    session.result?.mode === 'checkout' && session.result.kind === 'resumable'
      ? canResumeCheckoutTarget(session.result.path)
      : undefined;
  const state: PanelState = buildCheckoutPanelState(session, { verifyPending, resumeAvailable });
  handle.update({ ...state, formRevision }, handle.sessionId);
}

/* --------------------------- 命令入口与单实例 --------------------------- */

/** realpath 归一（目录不存在等失败形态回退原值——入口由选择器/资源管理器给出，通常存在）。 */
function normalizePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** 表单是否有用户输入（相对该入口的空白初始表单）：草稿暂存与切换确认的判定。 */
function draftDiffers(s: CheckoutPanelState): boolean {
  const current = toDraft(s);
  const fresh = createCheckoutPanelState({
    sessionId: s.sessionId,
    ...s.entry,
    history: s.history,
  });
  const baseline = toDraft(fresh);
  return (Object.keys(current) as Array<keyof CheckoutFormDraft>).some((key) => current[key] !== baseline[key]);
}

/** 切换确认条件：表单有输入或结果页正显示（等同换目标——确认后清草稿与缓存）。 */
function switchNeedsConfirm(): boolean {
  if (!session) {
    return false;
  }
  return session.result !== null || (session.step !== 'running' && draftDiffers(session));
}

/**
 * 打开 P3 面板（命令入口在阶段 1 任务 9 接入）：单实例与目标切换按 M2 口径——
 * 同入口同模式 reveal；新入口/模式切换在运行中（taskRegistry 任务）拒绝，
 * 有草稿或结果页时确认「放弃并切换」（清对应草稿与结果缓存）；面板不存在时
 * 按 §4.1 五段顺序恢复会话。
 */
export async function openCheckoutPanel(entry: CheckoutOpenEntry): Promise<void> {
  if (!panelContext) {
    return;
  }
  const entryKey = normalizePath(entry.entryKey);
  if (handle && session) {
    if (session.entry.entryKey === entryKey && session.mode === entry.mode) {
      // 同目标复用：reveal 即可（表单/任务态/结果页照常呈现）。
      handle.reveal();
      return;
    }
    // 新目标或模式切换：运行中拒绝（检出侧「运行中」= taskRegistry 任务）。
    if (hasActiveTask('checkout')) {
      handle.toast('info', format(strings.panel.panelBusySwitchRejected, { target: entryKey }));
      handle.reveal();
      return;
    }
    if (switchNeedsConfirm()) {
      const ok = await vscode.window.showWarningMessage(
        strings.panel.switchDiscardTitle,
        { modal: true, detail: strings.checkoutPanel.switchDiscardDetail },
        strings.panel.switchDiscardButton,
      );
      if (ok !== strings.panel.switchDiscardButton) {
        return;
      }
      // 确认等待期间面板被销毁（onPanelDispose 已清空 handle/session）：落到下方重建路径。
      if (handle && session) {
        if (hasActiveTask('checkout')) {
          handle.toast('info', format(strings.panel.panelBusySwitchRejected, { target: entryKey }));
          return;
        }
        // 放弃并切换：清当前键的草稿与结果缓存，递增结果代次（离页动作）。
        clearDraft(session.entry.entryKey, session.mode);
        clearSessionResult('checkout');
        bumpResultEpoch('checkout');
        if (!handle.switchSession()) {
          return;
        }
      }
    } else if (handle && !handle.switchSession()) {
      return;
    }
  }
  handle ??= createPanel(
    PANEL_ID,
    { title: strings.checkoutPanel.panelTitleCheckout, gates },
    { onIntent, onViewReady, onDispose: onPanelDispose },
    panelContext,
  );
  await recoverSession(handle.sessionId, entry, entryKey);
}

/** webview 重建握手：视图输入序号从零重启，宿主确认序号归零并重推。 */
function onViewReady(): void {
  formRevision = 0;
  pushRender();
}

/** 面板销毁：只清面板 UI 状态——暂存表单草稿（P2 模式 dispose 暂存）、取消订阅；任务与记录照常。 */
function onPanelDispose(): void {
  if (session && session.step === 'form' && draftDiffers(session)) {
    saveDraft(session.entry.entryKey, session.mode, toDraft(session));
  }
  handle = undefined;
  session = undefined;
  taskRemovalSub?.dispose();
  taskRemovalSub = undefined;
  resultUpdatedSub?.dispose();
  resultUpdatedSub = undefined;
  if (phaseTimer !== undefined) {
    clearInterval(phaseTimer);
    phaseTimer = undefined;
  }
}

/* ------------------------------ 五段恢复 ------------------------------ */

/**
 * 两阶段查询的阶段一匹配（§9）：未终态 checkout 记录的 targetPath 父目录
 * 等于入口键（普通模式），或 targetPath 为入口自身/入口之下（directMode 按
 * 目标路径前缀）。导出供阶段 2 与命令入口的恢复提示复用。
 */
export function matchCheckoutRecordToEntry(record: OperationRecord, entryKey: string): boolean {
  const targetPath = record.targetPath;
  if (!targetPath) {
    return false;
  }
  return (
    dirname(targetPath) === entryKey ||
    targetPath === entryKey ||
    targetPath.startsWith(entryKey + sep)
  );
}

/**
 * 阶段一候选：按入口键匹配的可恢复 checkout 记录（updatedAt 新者优先）。
 * 只认 residue-pending——重启折算后 checkout 未终态的唯一形态；prepared/
 * running 的在途记录必有①段任务对象（或经 loadPending 折算），不进分诊。
 */
export async function findCheckoutRecoveryRecords(entryKey: string): Promise<OperationRecord[]> {
  const records = await getOperationRegistry().loadAllRecords().catch(() => []);
  return records
    .filter(
      (record) =>
        kindOf(record) === 'checkout' &&
        record.phase === 'residue-pending' &&
        matchCheckoutRecordToEntry(record, entryKey),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 建立/重建会话并按五段顺序恢复（§4.1）：①运行任务（含跨入口绑定：会话
 * 绑定任务 resultScope、session.mode 随任务、绑定即订阅移除通知）→ ②结果
 * 缓存（作用域基准一致才命中）→ ③未终态记录分诊（interrupted 核验页，
 * 恢复态绑定记录目标）→ ④草稿 → ⑤新表单。
 */
async function recoverSession(sessionId: string, entry: CheckoutOpenEntry, entryKey: string): Promise<void> {
  subscribeSessionHooks(sessionId);
  const panelEntry: CheckoutPanelEntry = {
    sessionId,
    entryKey,
    mode: entry.mode,
    parentDir: entry.parentDir,
    sourceDir: entry.sourceDir,
    defaultDepth: readCheckoutDefaultDepth(),
    history: loadUrlHistory(),
  };

  // ① 运行中任务（taskRegistry 按面板类别单槽：任务存在即绑定——同入口与
  // 跨入口打开都回到任务当前状态；跨入口打开的会话绑定任务的 resultScope，
  // 页头/写限制/动作对象不以本次打开入口混判）。
  const task = getActiveTask('checkout');
  let baseline: CheckoutResultScope = { entryKey, mode: entry.mode };
  if (task) {
    const scope = task.resultScope as CheckoutResultScope;
    // 页头目标优先取记录 targetPath（begin 已落盘后可用），准备窗口回退锁键
    // （checkout 的锁键即目标绝对路径的归一值）。
    const record = (await getOperationRegistry().loadAllRecords().catch(() => []))
      .find((item) => item.operationId === task.taskId);
    let state = createCheckoutPanelState({ ...panelEntry, mode: scope.mode });
    state = beginTask(state, {
      opId: task.taskId,
      targetPath: record?.targetPath ?? task.lockKey,
      resultScope: scope,
    });
    state = markRecovered(state, 'task');
    if (isCheckoutPhase(task.phase)) {
      // 恢复时任务可能已推进到 running/canceling：相位镜像经 reducer 同步。
      state = taskPhase(state, task.phase);
    }
    session = state;
    baseline = scope;
    watchTaskPhase(task.taskId, sessionId);
    pushRender();
    return;
  }

  let state = createCheckoutPanelState(panelEntry);

  // ② 会话结果缓存（缓存项携带目标作用域：与基准不一致即丢弃并继续后续段）。
  const cached = readSessionResult('checkout', baseline);
  if (cached) {
    state = setResult(state, cached.page as P3ResultPage);
    state = markRecovered(state, 'cache');
    // 恢复态绑定：页头与动作对象按结果页的目标（缓存 scope 与基准一致才走到这里）。
    const page = cached.page as P3ResultPage;
    if (page.mode === 'checkout') {
      state = { ...state, binding: { resultScope: baseline, targetPath: page.path } };
    }
    session = state;
    pushRender();
    return;
  }

  // ③ 未终态记录分诊（缓存无对应终态——典型为宿主重启后）：按入口键列候选，
  // 命中最新者派生 interrupted 核验页；恢复态会话绑定记录自身的目标作用域
  // （缓存按本次打开入口写、记录的 lockKey 只用于动作对象）。
  const candidates = await findCheckoutRecoveryRecords(entryKey);
  const record = candidates[0];
  if (record?.targetPath) {
    const page = buildInterruptedPage({ path: record.targetPath });
    state = setResult(state, page);
    state = markRecovered(state, 'record');
    state = {
      ...state,
      mode: 'checkout',
      entry: { ...state.entry, mode: 'checkout' },
      binding: { resultScope: { entryKey, mode: 'checkout' }, targetPath: record.targetPath },
    };
    session = state;
    pushRender();
    return;
  }

  // ④ 本地草稿（读取键同作用域基准；恢复优先于新表单，错误字段不持久化、按值重算）。
  const draft = readDraft(baseline.entryKey, baseline.mode);
  if (draft) {
    session = fromDraft(state, draft);
    pushRender();
    return;
  }

  // ⑤ 新表单。
  session = state;
  pushRender();
}

/**
 * 绑定即订阅：任务移除通知（重开会话在出口/终态完成后重跑恢复，不停在已
 * 消失任务的进度页）与只读结论写入推送（带提示的旧结果页自动转结论页）。
 */
function subscribeSessionHooks(sessionId: string): void {
  taskRemovalSub?.dispose();
  resultUpdatedSub?.dispose();
  taskRemovalSub = onTaskRemoved('checkout', sessionId, () => {
    rerunRecovery();
  });
  resultUpdatedSub = onSessionResultUpdated('checkout', () => {
    rerunRecovery();
  });
}

/**
 * 重跑恢复（任务移除/结论写入推送）：重跑的会话作用域基准 = 会话绑定的
 * resultScope（跨入口绑定会话内任务完成按任务 scope 命中缓存页）；缓存/
 * 记录/草稿按序落位，绑定保留到离页动作解除。
 */
function rerunRecovery(): void {
  if (!handle || !session) {
    return;
  }
  const sessionId = handle.sessionId;
  const baseline = sessionScopeBaseline();
  const entryKey = baseline.entryKey;
  const mode = baseline.mode;
  const parentDir = session.entry.parentDir;
  const sourceDir = session.entry.sourceDir;
  void recoverSession(sessionId, { entryKey, mode, parentDir, sourceDir }, entryKey);
}

/* --------------------------- 任务相位镜像同步 --------------------------- */

/**
 * 轮询同步执行器任务相位到渲染镜像（connecting→running 的转移由执行器直改
 * 任务对象、无回调通道；镜像滞后会让取消按钮长时间停在准备段禁用态）。
 * 任务移除或会话失效即退出；终态渲染由 done 结算承担。
 */
function watchTaskPhase(taskId: string, sessionId: string): void {
  if (phaseTimer !== undefined) {
    clearInterval(phaseTimer);
  }
  phaseTimer = setInterval(() => {
    if (!handle || !session || handle.sessionId !== sessionId || session.sessionId !== sessionId) {
      if (phaseTimer !== undefined) {
        clearInterval(phaseTimer);
        phaseTimer = undefined;
      }
      return;
    }
    const task = getTaskById(taskId);
    if (!task) {
      if (phaseTimer !== undefined) {
        clearInterval(phaseTimer);
        phaseTimer = undefined;
      }
      return;
    }
    const phase = task.phase;
    if (session.task && session.task.phase !== phase && isCheckoutPhase(phase)) {
      session = taskPhase(session, phase);
      pushRender();
    }
  }, TASK_PHASE_POLL_MS);
}

function isCheckoutPhase(phase: string): phase is CheckoutTaskPhase {
  return phase === 'connecting' || phase === 'running' || phase === 'canceling';
}

/* ------------------------------ 意图分发 ------------------------------ */

async function onIntent(intent: Intent, context: { sessionId: string; busy: boolean }): Promise<void> {
  if (!handle || !session || handle.sessionId !== context.sessionId) {
    return;
  }
  switch (intent.kind) {
    case 'syncInput': {
      if (intent.inputRevision >= 0) {
        formRevision = Math.max(formRevision, intent.inputRevision);
      }
      session = syncInput(session, intent.fieldId as CheckoutFormFieldId, intent.value);
      pushRender();
      return;
    }
    case 'pickParentDir':
      await handlePickDir('parent');
      return;
    case 'pickDirectDir':
      await handlePickDir('direct');
      return;
    case 'useUrlName':
      session = useUrlName(session);
      pushRender();
      return;
    case 'useDirName':
      session = useDirName(session);
      pushRender();
      return;
    case 'selectHistoryUrl': {
      const url = session.history[intent.index];
      if (url === undefined) {
        return;
      }
      session = selectHistoryUrl(session, url);
      pushRender();
      return;
    }
    case 'checkoutBack':
      session = backToForm(session);
      pushRender();
      return;
    case 'checkoutNext':
      await handleCheckoutNext(context.sessionId);
      return;
    case 'startCheckout':
      await handleStartCheckout(context.sessionId);
      return;
    case 'cancelTask':
      await handleCancelTask(context.sessionId);
      return;
    case 'verifyCheckout':
      await handleVerifyCheckout(context.sessionId);
      return;
    case 'resumeCheckout':
      await handleResumeCheckout(context.sessionId);
      return;
    case 'abandonResidue':
      await handleAbandonResidue(context.sessionId);
      return;
    case 'newTask':
      clearSessionResult('checkout');
      bumpResultEpoch('checkout');
      session = newTask(session);
      pushRender();
      return;
    case 'openCurrentWindow':
      await openResultFolder(context.sessionId, false);
      return;
    case 'openNewWindow':
      await openResultFolder(context.sessionId, true);
      return;
    case 'addToWorkspace':
      await addResultToWorkspace(context.sessionId);
      return;
    case 'revealResultDir':
      revealResultDir();
      return;
    case 'viewTaskLog':
      showOutput(false, 'checkout');
      return;
    case 'switchP3Mode':
      await handleSwitchMode(context.sessionId);
      return;
    case 'closePanel':
      handle.dispose();
      return;
    /* 导入侧流程与 URL 历史清空（阶段 2 在同一面板扩展）：类型与白名单已
     * 先行登记，处理器留注册位——到达时不改变面板状态。 */
    case 'pickSourceDir':
    case 'importNext':
    case 'startImport':
    case 'refreshImportPreview':
    case 'verifyImport':
    case 'retryImport':
    case 'acknowledgeMerged':
    case 'abandonUnknownImport':
    case 'handoffToCheckout':
    case 'revealSourceDir':
    case 'clearUrlHistory':
      return;
    default:
      return;
  }
}

/* ------------------------------ 表单处理器 ------------------------------ */

/** 目录选择器（§7.2 基线 §五目录选择纪律：返回值须为绝对路径，取消保留原值）。 */
async function handlePickDir(which: 'parent' | 'direct'): Promise<void> {
  if (!handle || !session) {
    return;
  }
  const t = strings.checkoutPanel;
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: which === 'parent' ? t.pickParentDirTitle : t.pickDirectDirTitle,
  });
  if (!session || !handle) {
    return;
  }
  const dir = picked?.[0]?.fsPath;
  if (!dir) {
    // 取消（Esc/关闭选择框）：保留原值，不回写空串。
    return;
  }
  if (!isAbsolute(dir)) {
    handle.toast('error', format(strings.checkoutPanel.pickInvalidPath, { path: dir }));
    return;
  }
  session = which === 'parent' ? pickParentDir(session, dir) : pickDirectDir(session, dir);
  pushRender();
}

/* --------------------------- 连接检查与开始 --------------------------- */

/**
 * 「下一步」自动检查（§4.3）：connNext 模型守卫（urlInput 重校验失败拒绝
 * 发起）通过后异步执行 checkRemote；认证补录按 scheme 分支——svn+ssh/file
 * 不注入（认证失败按普通失败呈现），http/https/svn 注入补录并经 connAuth
 * 相位时序（转 auth → 弹窗 → 成功回 testing / 取消终止回 untested）。
 * 回包带发起代次 seq 调 connSettled——迟到回包由模型按代次丢弃。
 */
async function handleCheckoutNext(sessionId: string): Promise<void> {
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  const next = connNext(session);
  session = next.state;
  pushRender();
  if (!next.issued) {
    return;
  }
  const seq = next.seq;
  const url = session.form.url;
  const svnPath = readSvnPath();
  const applyIfLive = (mutate: (s: CheckoutPanelState) => CheckoutPanelState): void => {
    if (!handle || !session || handle.sessionId !== sessionId || session.sessionId !== sessionId) {
      return;
    }
    session = mutate(session);
    pushRender();
  };
  const getCredentials = schemeAcceptsCredentials(url)
    ? async () => {
        applyIfLive((s) => connAuth(s));
        const creds = await promptForCredentials();
        if (!creds) {
          // 补录取消：检查终止回 untested，迟到的失败回包被代次/相位校验丢弃。
          applyIfLive((s) => connAuthCancel(s));
          return undefined;
        }
        applyIfLive((s) => connAuthResume(s));
        return creds;
      }
    : undefined;
  const revision = session.form.revMode === 'number' ? Number(session.form.rev) : undefined;
  // 操作日志的命令回显与 checkRemote 内部构造保持同构（含 -r 与 peg 处理）。
  const args = ['info', '--xml', '--non-interactive'];
  if (revision !== undefined) {
    args.push('-r', String(revision));
  }
  args.push('--', escapeUrlPeg(url));
  const result = await checkRemote(svnPath, url, {
    revision,
    timeoutMs: readTimeoutMs(),
    getCredentials,
    ...decodingRunOptions('checkout'),
    onExit: logCommand(svnPath, args, undefined, 'checkout'),
  });
  const outcome = result.ok
    ? { ok: true as const, pinnedRevision: result.pinnedRevision, identity: result.identity }
    : { ok: false as const, failure: result.failure, message: result.message };
  applyIfLive((s) => connSettled(s, seq, outcome));
  // 成功自动进入核对页时补本地目标检查结论（「目标状态」行的数据源；开始
  // 前重查由执行器在 begin 落盘后执行，此处仅展示）。
  if (result.ok && session && session.step === 'review') {
    const targetDir = finalTargetDir(session);
    const recheck = targetDir ? recheckCheckoutTarget(targetDir) : undefined;
    session = setReviewInfo(session, recheck ? recheckTargetText(recheck) : '');
    pushRender();
  }
}

/** recheck 结论 → 核对页「目标状态」可读文本（i18n 映射，core 的 message 仅供日志）。 */
function recheckTargetText(recheck: { ok: boolean; reason?: TargetRecheckFailure }): string {
  const t = strings.checkoutPanel;
  if (recheck.ok) {
    return t.targetStateOk;
  }
  switch (recheck.reason) {
    case 'targetHasMetadata':
      return t.targetStateHasMetadata;
    case 'targetNotEmpty':
      return t.targetStateNotEmpty;
    case 'nestedWorkingCopy':
      return t.targetStateNested;
    default:
      return t.targetStateOk;
  }
}

/** 最终目标目录（realpath 归一；directMode 为 directDir，否则 join(父, 子目录名)）。 */
function finalTargetDir(s: CheckoutPanelState): string | undefined {
  const { form } = s;
  if (form.directMode) {
    return form.directDir === '' ? undefined : normalizePath(form.directDir);
  }
  if (form.parentDir === '' || form.dirName === '') {
    return undefined;
  }
  return join(normalizePath(form.parentDir), form.dirName);
}

/** 任务回调集合（检出与续检共用：认证弹窗、身份清除、进度节流、日志、预命令出口）。 */
function makeTaskCallbacks(sessionId: string): CheckoutTaskCallbacks {
  let lastPushAt = 0;
  return {
    getCredentials: () => promptForCredentials(),
    onIdentityConsumed: () => {
      if (!handle || !session || handle.sessionId !== sessionId || session.sessionId !== sessionId) {
        return;
      }
      session = consumeIdentity(session);
    },
    onProgress: (progress) => {
      if (!handle || !session || handle.sessionId !== sessionId || session.sessionId !== sessionId) {
        return;
      }
      if (!session.task) {
        return;
      }
      session = taskProgress(session, progress);
      const now = Date.now();
      if (now - lastPushAt >= PROGRESS_RENDER_THROTTLE_MS) {
        lastPushAt = now;
        pushRender();
      }
    },
    onLogLine: (text) => {
      logLine(text, 'checkout');
    },
    onPreCommandExit: (exit) => {
      if (!handle || !session || handle.sessionId !== sessionId || session.sessionId !== sessionId) {
        return;
      }
      if (exit.kind === 'beginBusy') {
        // busy 分支：回核对页（连接结论仍有效）+ toast 提示，不写错误横幅。
        session = enterReview(session);
        handle.toast('info', strings.checkoutPanel.beginBusyNotice);
      } else if (exit.kind === 'beginIdConflict') {
        session = setReviewError(session, strings.checkoutPanel.beginIdConflictNotice);
      } else if (exit.kind === 'targetRecheckFailed') {
        session = setReviewError(session, recheckTargetText({ ok: false, reason: exit.reason }));
      } else if (exit.kind === 'beginWriteFailed' || exit.kind === 'snapshotWriteFailed') {
        session = setReviewError(session, exit.message ?? strings.checkoutPanel.beginIdConflictNotice);
      } else {
        // 导入侧预命令出口（阶段 2 细分文案）：命令未发出的通用提示。
        session = setReviewError(session, strings.checkoutPanel.preCommandAbortedNotice);
      }
      pushRender();
    },
  };
}

/** 任务 done 结算：成功记 URL 历史（成功事实不因面板关闭改变）；发起会话仍存活时写结果页。 */
async function settleOnDone(
  done: Promise<CheckoutTaskOutcome>,
  sessionId: string,
  url: string,
): Promise<void> {
  const outcome = await done;
  if (outcome.outcome === 'finished' && outcome.result.mode === 'checkout' && outcome.result.kind === 'success') {
    recordUrlHistory(url);
    if (session && session.history[0] !== url) {
      // 会话仍存活时同步镜像（重开会话经缓存/记录恢复，历史在下次打开时装载）。
      session = { ...session, history: addHistoryUrl(session.history, url) };
    }
  }
  if (!handle || !session || handle.sessionId !== sessionId || session.sessionId !== sessionId) {
    return;
  }
  if (outcome.outcome === 'finished') {
    session = setResult(session, outcome.result);
    pushRender();
  }
  // preCommandExit 的 UI 转移由 onPreCommandExit 回调承担（出口即达），此处不重复。
}

/**
 * 开始检出（§4.3 时序）：任务启动递增结果代次并清除草稿（busy 开始之前），
 * startCheckoutTask 同步注册任务对象后模型转 running 步；终态由执行器写
 * 缓存、done 结算写结果页。
 */
async function handleStartCheckout(sessionId: string): Promise<void> {
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  const s = session;
  if (s.mode !== 'checkout' || s.step !== 'review' || s.conn.phase !== 'success' || !s.conn.identity || s.conn.pinnedRevision === null) {
    pushRender();
    return;
  }
  if (s.form.url === '' || s.form.urlError || s.form.nameError || s.form.revError) {
    pushRender();
    return;
  }
  const targetDir = finalTargetDir(s);
  if (!targetDir) {
    pushRender();
    return;
  }
  const scope: CheckoutResultScope = { entryKey: s.entry.entryKey, mode: 'checkout' };
  bumpResultEpoch('checkout');
  clearDraft(scope.entryKey, scope.mode);
  const formSnapshot = toDraft(s);
  const started = startCheckoutTask({
    url: s.form.url,
    pinnedRevision: s.conn.pinnedRevision,
    depth: s.form.depth,
    targetDir,
    parentDir: s.form.directMode ? normalizePath(s.form.directDir) : normalizePath(s.form.parentDir),
    dirName: s.form.dirName,
    directMode: s.form.directMode,
    directDir: normalizePath(s.form.directDir),
    identity: s.conn.identity,
    entryKey: scope.entryKey,
    initiatorSessionId: sessionId,
    formSnapshot,
    callbacks: makeTaskCallbacks(sessionId),
  });
  session = beginTask(s, { opId: started.taskId, targetPath: targetDir, resultScope: scope });
  pushRender();
  watchTaskPhase(started.taskId, sessionId);
  void settleOnDone(started.done, sessionId, s.form.url);
}

/* ------------------------------ 取消任务 ------------------------------ */

/** 取消（§2.1：仅 running 放行；确认期间任务终态不回改）。 */
async function handleCancelTask(sessionId: string): Promise<void> {
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  const taskId = session.task?.opId;
  if (!taskId) {
    pushRender();
    return;
  }
  const t = strings.checkoutPanel;
  const ok = await vscode.window.showWarningMessage(
    t.cancelConfirmTitle,
    { modal: true, detail: t.cancelConfirmDetail },
    t.cancelConfirmButton,
  );
  if (ok !== t.cancelConfirmButton) {
    return;
  }
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  const result = cancelCheckoutTask(taskId);
  if (result.ok) {
    session = taskPhase(session, 'canceling');
    pushRender();
    return;
  }
  if (result.reason === 'missing') {
    // 确认期间任务已终态（终态即移除）：不回改，结果页由 done 结算呈现。
    handle.toast('info', strings.checkoutPanel.cancelRaceFinished);
    return;
  }
  // notRunning：镜像滞后的准备段或已请求取消——提示即可，任务相位以执行器为准。
  handle.toast('info', strings.checkoutPanel.cancelNotRunning);
  pushRender();
}

/* ------------------------------ 核验与续检 ------------------------------ */

/** 从记录构造核验基准（记录固定字段缺失按不可核验处理——M3 记录随 begin 一次写齐）。 */
function expectationOf(record: OperationRecord): RemoteIdentity & { depth: CheckoutDepth; pinnedRevision: number } | undefined {
  if (
    record.repositoryUuid === undefined ||
    record.repositoryRootUrl === undefined ||
    record.relativeUrl === undefined ||
    record.depth === undefined ||
    record.pinnedRevision === undefined
  ) {
    return undefined;
  }
  return {
    repositoryUuid: record.repositoryUuid,
    repositoryRootUrl: record.repositoryRootUrl,
    relativeUrl: record.relativeUrl,
    depth: record.depth,
    pinnedRevision: record.pinnedRevision,
  };
}

/**
 * 核验（§4.4 两步分离的第一步）：只读命令链，不改记录（保持 residue-pending）。
 * 发起时捕获作用域与结果代次（核验不是递增点）；结论返回按代次守卫——一致
 * （或面板已 dispose）写结论页 + 控制器写缓存 + settleReadonlyVerify 推送
 * 重跑；不一致丢弃结论、settle 不推送。
 */
async function handleVerifyCheckout(sessionId: string): Promise<void> {
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  const result = session.result;
  if (!result || result.mode !== 'checkout') {
    pushRender();
    return;
  }
  const record = residueRecordFor(result.path);
  if (!record) {
    handle.toast('info', strings.checkoutPanel.recordUnavailable);
    return;
  }
  const expectation = expectationOf(record);
  if (!expectation) {
    handle.toast('info', strings.checkoutPanel.verifyRecordMissing);
    return;
  }
  const scope = sessionScopeBaseline();
  const epoch = getResultEpoch('checkout');
  const snapshotFrom = result.formSnapshot;
  try {
    const report = await verifyCheckoutOnly({
      targetDir: result.path,
      expectation,
      resultScope: scope,
      epoch,
    });
    let written = false;
    if (getResultEpoch('checkout') === epoch) {
      const page: P3ResultPage = {
        mode: 'checkout',
        kind: report.kind,
        path: result.path,
        verify: report,
        formSnapshot: snapshotFrom,
      };
      written = writeSessionResult('checkout', scope, page, 'controller');
      if (written && handle && session && handle.sessionId === sessionId && session.sessionId === sessionId) {
        session = setVerifyOutcome(session, { report, path: result.path, formSnapshot: snapshotFrom });
      }
    }
    // 结论写入或被守卫丢弃后结算登记：写入才向存活会话推送重跑。
    settleReadonlyVerify('checkout', written);
    if (handle && session && handle.sessionId === sessionId) {
      pushRender();
    }
  } catch (err) {
    // 命令异常终止：verifyCheckoutOnly 已清除登记（不推送），提示原因。
    handle?.toast('error', err instanceof Error ? err.message : String(err));
  }
}

/**
 * 续检（§4.4 第二步）：发起即递增结果代次并清除被运行态取代的旧 resumable
 * 页；beginResume 的占用拒绝按 kind 分列文案提示、recordUnavailable 提示
 * 重核验；成功后模型转 running 步（复用检出任务状态机），终态同款结算。
 */
async function handleResumeCheckout(sessionId: string): Promise<void> {
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  const result = session.result;
  if (!result || result.mode !== 'checkout' || result.kind !== 'resumable') {
    pushRender();
    return;
  }
  const record = residueRecordFor(result.path);
  if (!record || !record.targetPath) {
    handle.toast('info', strings.checkoutPanel.recordUnavailable);
    return;
  }
  const expectation = expectationOf(record);
  if (!expectation || record.url === undefined) {
    handle.toast('info', strings.checkoutPanel.verifyRecordMissing);
    return;
  }
  const scope = sessionScopeBaseline();
  // 发起即新结果上下文：递增代次 + 清旧 resumable 页（迟到核验结论随之失效）。
  bumpResultEpoch('checkout');
  clearSessionResult('checkout', scope);
  // formSnapshot 来源（§2.1 续检规则）：会话内 form 非空优先、否则继承
  // resumable 页携带快照、无快照按空表单。
  const formSnapshot =
    session.form.url !== '' || session.form.urlInput !== ''
      ? toDraft(session)
      : (result.formSnapshot ?? undefined);
  const started = await resumeCheckoutTask({
    operationId: record.operationId,
    lockKey: lockKeyOf(record),
    targetDir: record.targetPath,
    url: record.url,
    pinnedRevision: expectation.pinnedRevision,
    depth: expectation.depth,
    identity: {
      repositoryUuid: expectation.repositoryUuid,
      repositoryRootUrl: expectation.repositoryRootUrl,
      relativeUrl: expectation.relativeUrl,
    },
    entryKey: scope.entryKey,
    formSnapshot,
    initiatorSessionId: sessionId,
    callbacks: makeTaskCallbacks(sessionId),
  });
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  if (!started.ok) {
    if (started.reason === 'busy') {
      handle.toast('info', resumeBusyNotice(started.heldBy));
    } else {
      handle.toast('info', strings.checkoutPanel.recordUnavailable);
    }
    pushRender();
    return;
  }
  session = beginTask(session, {
    opId: started.taskId,
    targetPath: record.targetPath,
    resultScope: scope,
  });
  pushRender();
  watchTaskPhase(started.taskId, sessionId);
  void settleOnDone(started.done, sessionId, record.url);
}

/* ------------------------------ 改用新目录 ------------------------------ */

/**
 * 改用新目录（出口③）：确认后记录落 failed-unconfirmed 并 finish 收口
 * （解除限制语义）；按程序化回表单出口写回草稿（键 = 会话作用域基准——
 * 任务创建时入口键；数据源两层：会话 form 非空优先、否则结果页快照、无
 * 快照按空白表单——interrupted 派生页回空白为登记差异）；清缓存、递增代次、
 * 回表单。
 */
async function handleAbandonResidue(sessionId: string): Promise<void> {
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  const result = session.result;
  if (!result || result.mode !== 'checkout' || !RESIDUE_RESULT_KINDS.includes(result.kind)) {
    pushRender();
    return;
  }
  const t = strings.checkoutPanel;
  const ok = await vscode.window.showWarningMessage(
    t.abandonConfirmTitle,
    { modal: true, detail: t.abandonConfirmDetail },
    strings.panel.switchDiscardButton,
  );
  if (ok !== strings.panel.switchDiscardButton) {
    return;
  }
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  const record = residueRecordFor(result.path);
  if (record) {
    await getOperationRegistry().finalizeOperation(record.operationId, 'failed-unconfirmed');
  }
  const scope = sessionScopeBaseline();
  const fromSessionForm = session.form.url !== '' || session.form.urlInput !== '';
  const draft: CheckoutFormDraft = fromSessionForm
    ? toDraft(session)
    : (result.formSnapshot ?? emptyDraftForEntry(session));
  saveDraft(scope.entryKey, scope.mode, draft);
  clearSessionResult('checkout', scope);
  bumpResultEpoch('checkout');
  session = fromDraft(session, draft);
  pushRender();
}

/** 入口初始空白表单（保留入口父目录与默认深度——「空白」指无用户输入，不是抹掉入口值）。 */
function emptyDraftForEntry(s: CheckoutPanelState): CheckoutFormDraft {
  const draft = createEmptyFormDraft(s.entry.defaultDepth);
  return { ...draft, parentDir: s.entry.parentDir, sourceDir: s.entry.sourceDir };
}

/* ------------------------------ 成功动作 ------------------------------ */

function resultPathOf(): string | undefined {
  const result = session?.result;
  if (!result) {
    return undefined;
  }
  return result.mode === 'checkout' && result.kind === 'success' ? result.path : undefined;
}

/** 当前窗口/新窗口打开检出结果目录（V5 真机待验，代码按 vscode.openFolder 形态实现）。 */
async function openResultFolder(sessionId: string, openNewWindow: boolean): Promise<void> {
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  const path = resultPathOf();
  if (!path) {
    pushRender();
    return;
  }
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(path), { openNewWindow });
}

/** 加入当前工作区（追加不重复）。 */
async function addResultToWorkspace(sessionId: string): Promise<void> {
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  const path = resultPathOf();
  if (!path) {
    pushRender();
    return;
  }
  const uri = vscode.Uri.file(path);
  const existing = vscode.workspace.workspaceFolders?.some((folder) => folder.uri.toString() === uri.toString());
  if (existing) {
    return;
  }
  const start = vscode.workspace.workspaceFolders?.length ?? 0;
  const ok = vscode.workspace.updateWorkspaceFolders(start, 0, { uri });
  if (!ok) {
    handle.toast('info', strings.checkoutPanel.addWorkspaceFailed);
  }
}

/** 在 Finder 中显示检出结果目录（复用内建 revealFileInOS）。 */
function revealResultDir(): void {
  const path = resultPathOf();
  if (!path) {
    return;
  }
  void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path));
}

/* ------------------------------ 模式切换 ------------------------------ */

/**
 * 模式切换（§4：等同换目标）：运行中拒绝；有草稿或结果页确认「放弃并切换」
 * ——清当前键草稿与结果缓存、递增代次，模型按切换后模式重建表单（键 =
 * 打开入口路径 realpath + 切换后 mode）。导入流程处理器由阶段 2 接入。
 */
async function handleSwitchMode(sessionId: string): Promise<void> {
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  if (hasActiveTask('checkout')) {
    handle.toast('info', format(strings.panel.panelBusySwitchRejected, { target: session.entry.entryKey }));
    pushRender();
    return;
  }
  if (switchNeedsConfirm()) {
    const ok = await vscode.window.showWarningMessage(
      strings.panel.switchDiscardTitle,
      { modal: true, detail: strings.checkoutPanel.switchDiscardDetail },
      strings.panel.switchDiscardButton,
    );
    if (ok !== strings.panel.switchDiscardButton) {
      return;
    }
  }
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  if (hasActiveTask('checkout')) {
    handle.toast('info', format(strings.panel.panelBusySwitchRejected, { target: session.entry.entryKey }));
    return;
  }
  clearDraft(session.entry.entryKey, session.mode);
  clearSessionResult('checkout');
  bumpResultEpoch('checkout');
  session = switchMode(session);
  pushRender();
}

/** 测试辅助：重置面板控制器模块级状态（真实宿主不需要）。 */
export function resetCheckoutPanelController(): void {
  handle = undefined;
  session = undefined;
  formRevision = 0;
  taskRemovalSub?.dispose();
  taskRemovalSub = undefined;
  resultUpdatedSub?.dispose();
  resultUpdatedSub = undefined;
  if (phaseTimer !== undefined) {
    clearInterval(phaseTimer);
    phaseTimer = undefined;
  }
}
