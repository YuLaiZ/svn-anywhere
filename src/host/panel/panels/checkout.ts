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
  editableURL,
  escapeUrlPeg,
  schemeAcceptsCredentials,
  type CheckoutDepth,
  type RemoteIdentity,
} from '../../../core/checkout';
import { SvnError, extractSvnErrorCodes, isAuthFailure } from '../../../core/errors';
import {
  enumerateImportSource,
  enumerationToSnapshot,
  parseParentInfoXml,
  precheckImportSource,
  recheckImportTarget,
  snapshotDigest,
  type ImportEnumeration,
} from '../../../core/importDir';
import { readSvnConfigGlobalIgnores } from '../../../core/svnConfig';
import {
  getOperationRegistry,
  kindOf,
  lockKeyOf,
  randomOperationId,
  type OperationRecord,
} from '../../../core/operations';
import { runOrThrow, type AuthCredentials, type RunOptions } from '../../../core/svnCli';
import { readAllowEmptyCommitMessage, readCheckoutDefaultDepth, readSvnPath, readTimeoutMs } from '../../config';
import { format, strings } from '../../i18n';
import { decodingRunOptions, logCommand, logLine, showOutput } from '../../output';
import { promptForCredentials } from '../../auth';
import { createPanel, type PanelHandle } from '../host';
import type { Intent } from '../protocol';
import type { PanelState } from '../state';
import type { TableFilterSpec, TableSpec } from '../state';
import {
  IMPORT_PREVIEW_SORT_DEFAULT,
  abandonUnknownImportReducer,
  acknowledgeMergedReducer,
  addHistoryUrl,
  backToForm,
  beginImportTask,
  beginImportVerify,
  beginTask,
  buildCheckoutPanelState,
  buildInterruptedPage,
  checkImportScope,
  connAuth,
  connAuthCancel,
  connAuthResume,
  connNext,
  connSettled,
  consumeIdentity,
  consumeParentIdentity,
  createImportPreviewFilters,
  createCheckoutPanelState,
  enterReview,
  fromDraft,
  handoffReducer,
  importConnSettled,
  importConfirmBlockReason,
  importNextReducer,
  markRecovered,
  newTask,
  pickDirectDir,
  pickParentDir,
  pickSourceDirReducer,
  retryImportReducer,
  selectHistoryUrl,
  setConfirmState,
  setEmptyMessageConfirm,
  setPreview,
  setPreviewError,
  setRecheckOutcome,
  setReviewInfo,
  setReviewError,
  setResult,
  setSourcePrecheck,
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
  type ImportConnOutcome,
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
  abandonUnknownImportTask,
  acknowledgeImportTask,
  startImportTask,
  verifyImportTask,
  type ImportTaskCallbacks,
  type ImportTaskOutcome,
  type ImportVerifyTaskResult,
} from '../importTask';
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
  addTask,
  getActiveTask,
  getTaskById,
  hasActiveTask,
  onTaskRemoved,
  removeTask,
  type CheckoutResultScope,
  type TaskObject,
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
/** 导入核对页文件表的当前页码（表格视图状态由宿主唯一持有，模型按页码切片）。 */
let importPreviewPage = 1;
/** 导入核对页文件表的当前排序/筛选（同上由宿主唯一持有，渲染时回喂模型切片）。 */
let importPreviewSort: TableSpec['sort'] = IMPORT_PREVIEW_SORT_DEFAULT;
let importPreviewFilters: TableFilterSpec[] = createImportPreviewFilters();
/** merged 页核实第 0 步失败（快照不完整）的横幅标记——不转 unknown、不写 snapshotIncomplete（§5 第 0 步）。 */
let importVerifySnapshotFailed = false;
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
 * 任务 lockKey；checkout 结果页按目标路径（checkout 记录的 lockKey=目标
 * 路径）；import 结果页按源目录 realpath（import 记录的 lockKey=源目录，
 * 结果页 path 与之同值）。
 */
function activeLockKeyOf(state: CheckoutPanelState): string | undefined {
  const result = state.result;
  if (result?.mode === 'checkout' || result?.mode === 'import') {
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
  isMergedOutcome: () => {
    const result = session?.result;
    return result?.mode === 'import' && result.kind === 'merged' && result.settled !== true;
  },
  isSnapshotIncomplete: () => {
    const result = session?.result;
    return result?.mode === 'import' && result.kind === 'unknown' && result.snapshotIncomplete === true;
  },
  isResidueResultPage: () => {
    const result = session?.result;
    return result?.mode === 'checkout' && RESIDUE_RESULT_KINDS.includes(result.kind);
  },
});

/* ------------------------------ 渲染推送 ------------------------------ */

/**
 * 重置导入预览表的视图状态（页码/排序/筛选）：换源目录、装载新快照与
 * 离页回表单动作时调用——新数据集上旧筛选语义不保留（P4「tableView 不
 * 随缓存恢复」同口径）。
 */
function resetImportPreviewView(): void {
  importPreviewPage = 1;
  importPreviewSort = IMPORT_PREVIEW_SORT_DEFAULT;
  importPreviewFilters = createImportPreviewFilters();
}

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
  const state: PanelState = buildCheckoutPanelState(session, {
    verifyPending,
    resumeAvailable,
    importPreviewPage,
    importPreviewSort,
    importPreviewFilters,
    importVerifySnapshotFailed,
  });
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
 * 两阶段查询阶段一的 import 变体（§9）：未终态 import 记录按 lockKey
 * （= 源目录 realpath，targetPath 同值）与入口键精确命中——源目录在打开
 * 时即确定，命令入口（右键源目录）与面板恢复共用本匹配。
 */
export function matchImportRecordToEntry(record: OperationRecord, entryKey: string): boolean {
  return lockKeyOf(record) === entryKey || record.targetPath === entryKey;
}

/**
 * 阶段一候选（import）：入口键命中的 unknown 记录（updatedAt 新者优先）。
 * 重启折算后 import 未终态的唯一形态是 unknown（含 outcome='merged'——
 * 按 merged 页恢复并带回 resolvedRevision）；prepared/running 的在途记录
 * 由 loadPending 折算成 unknown，快照不完整由核实第 0 步发现、不在此判定。
 */
export async function findImportRecoveryRecords(entryKey: string): Promise<OperationRecord[]> {
  const records = await getOperationRegistry().loadAllRecords().catch(() => []);
  return records
    .filter(
      (record) =>
        kindOf(record) === 'import' &&
        record.phase === 'unknown' &&
        matchImportRecordToEntry(record, entryKey),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * import unknown/merged 记录 → 恢复结果页（§4.1 五段第③段的 import 分诊
 * 形态）：merged 记录按 merged 页恢复（revision 随记录读出不丢）；表单
 * 快照从 importIntent 派生（retryImport/abandonUnknownImport 的回填数据源，
 * 快照不完整分支的 abandon 出口由此可达）。记录字段缺失按不可恢复处理。
 */
export function buildImportRecoveryPage(record: OperationRecord): P3ResultPage | undefined {
  if (!record.targetPath || !record.importIntent) {
    return undefined;
  }
  const merged = record.outcome === 'merged';
  const page: P3ResultPage = {
    mode: 'import',
    kind: merged ? 'merged' : 'unknown',
    path: record.targetPath,
    resolution: 'unresolved',
    detail: merged ? strings.importTask.mergedDetail : undefined,
    formSnapshot: {
      url: record.importIntent.targetUrl,
      sourceDir: record.targetPath,
      message: record.importIntent.message,
      nameMode: record.importIntent.nameMode,
    },
  };
  if (merged && record.resolvedRevision !== undefined) {
    page.revision = record.resolvedRevision;
  }
  return page;
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
    // 恢复态绑定：页头与动作对象按结果页的目标（缓存 scope 与基准一致才走到这里；
    // merged 页横幅标记随缓存页恢复——settled 形态不依赖，标记仅第 0 步失败时置位）。
    const page = cached.page as P3ResultPage;
    if (page.mode === 'checkout' || page.mode === 'import') {
      state = { ...state, binding: { resultScope: baseline, targetPath: page.path } };
    }
    importVerifySnapshotFailed = false;
    session = state;
    pushRender();
    return;
  }

  // ③ 未终态记录分诊（缓存无对应终态——典型为宿主重启后）：checkout 与
  // import 记录合并按入口键列候选，命中 updatedAt 最新者分诊——checkout
  // 派生 interrupted 核验页、import 派生 unknown/merged 核实页（恢复态
  // session.mode 随记录 kind 设定；会话绑定记录自身的目标作用域，缓存按
  // 本次打开入口写、记录的 lockKey 只用于动作对象）。
  const candidates = (
    await Promise.all([findCheckoutRecoveryRecords(entryKey), findImportRecoveryRecords(entryKey)])
  )
    .flat()
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const record = candidates[0];
  if (record && kindOf(record) === 'import') {
    const page = buildImportRecoveryPage(record);
    if (page) {
      state = setResult(state, page);
      state = markRecovered(state, 'record');
      state = {
        ...state,
        mode: 'import',
        entry: { ...state.entry, mode: 'import' },
        binding: { resultScope: { entryKey, mode: 'import' }, targetPath: page.path },
      };
      importVerifySnapshotFailed = false;
      session = state;
      pushRender();
      return;
    }
  } else if (record?.targetPath) {
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
      // 导入任务日志走 import 频道（与执行器 onLogLine 同一频道）。
      showOutput(false, session?.mode === 'import' ? 'import' : 'checkout');
      return;
    case 'switchP3Mode':
      await handleSwitchMode(context.sessionId);
      return;
    case 'closePanel':
      handle.dispose();
      return;
    /* ---------------- 导入侧流程（§5：同一面板 mode='import'） ---------------- */
    case 'pickSourceDir':
      await handlePickSourceDir(context.sessionId);
      return;
    case 'importNext':
      await handleImportNext(context.sessionId);
      return;
    case 'startImport':
      await handleStartImport(context.sessionId);
      return;
    case 'refreshImportPreview':
      // 用户主动刷新：直接装载新快照（scopeChanged 提示下的出口）。
      await runImportPreview(context.sessionId, false);
      return;
    case 'verifyImport':
      await handleVerifyImport(context.sessionId);
      return;
    case 'retryImport':
      handleRetryImport(context.sessionId);
      return;
    case 'acknowledgeMerged':
      await handleAcknowledgeMerged(context.sessionId);
      return;
    case 'abandonUnknownImport':
      await handleAbandonUnknownImport(context.sessionId);
      return;
    case 'handoffToCheckout':
      handleHandoffToCheckout(context.sessionId);
      return;
    case 'revealSourceDir':
      revealSourceDir();
      return;
    case 'clearUrlHistory':
      handleClearUrlHistory();
      return;
    /* ---------------- 导入核对页表格视图（§7.1：排序/筛选/翻页由宿主持有回喂） ---------------- */
    case 'setPage':
      importPreviewPage = Math.max(1, Math.floor(intent.page));
      pushRender();
      return;
    case 'setSort':
      importPreviewSort = { key: intent.key, direction: intent.direction };
      importPreviewPage = 1;
      pushRender();
      return;
    case 'setFilter':
      importPreviewFilters = importPreviewFilters.map((filter) =>
        filter.id === intent.filterId ? { ...filter, value: intent.value } : filter,
      );
      importPreviewPage = 1;
      pushRender();
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

/* ------------------------------ 导入流程（§5） ------------------------------ */

/** 会话存活的守卫变更（await 返回后套用模型转移；面板销毁/会话切换时空转）。 */
function applyIfLive(sessionId: string, mutate: (s: CheckoutPanelState) => CheckoutPanelState): void {
  if (!handle || !session || handle.sessionId !== sessionId || session.sessionId !== sessionId) {
    return;
  }
  session = mutate(session);
  pushRender();
}

/**
 * 枚举入口（global-ignores 读取 + 源枚举）：预览装载与三次快照比对共用。
 * 配置解析失败与源不可枚举都按「无法完整确认范围」返回可读原因（阻止
 * 勾选确认与开始的基线）。
 */
function enumerateImport(sourceDir: string): { enumeration?: ImportEnumeration; error?: string } {
  let patterns: string[];
  try {
    patterns = readSvnConfigGlobalIgnores();
  } catch {
    return { error: strings.checkoutPanel.importPreviewIgnoreFailedNotice };
  }
  try {
    return { enumeration: enumerateImportSource(sourceDir, { ignorePatterns: patterns }) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** 源目录选择（pickSourceDir）：选择器 + realpath 归一 + 异步源预检回填。 */
async function handlePickSourceDir(sessionId: string): Promise<void> {
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  const t = strings.checkoutPanel;
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: t.pickSourceDirTitle,
  });
  if (!session || !handle) {
    return;
  }
  const dir = picked?.[0]?.fsPath;
  if (!dir) {
    // 取消（Esc/关闭选择框）：保留原值。
    return;
  }
  if (!isAbsolute(dir)) {
    handle.toast('error', format(t.pickInvalidPath, { path: dir }));
    return;
  }
  const normalized = normalizePath(dir);
  const next = pickSourceDirReducer(session, normalized);
  session = next.state;
  resetImportPreviewView();
  pushRender();
  // 源预检（只查源目录自身的版本控制形态）：回包带发起代次，迟到/参数已
  // 编辑的回包由 setSourcePrecheck 按代次与相位丢弃。
  const seq = next.seq;
  const result = await precheckImportSource(readSvnPath(), normalized, {
    timeoutMs: readTimeoutMs(),
    ...decodingRunOptions('import'),
  });
  applyIfLive(sessionId, (s) => setSourcePrecheck(s, seq, result));
}

/** 父 URL 构造（§5）：剥掉目标 URL 最后一个非空路径段；无路径段（仓库根）→ 父即根。 */
function parentUrlOfImport(targetUrl: string): string {
  const schemeEnd = targetUrl.indexOf('://');
  if (schemeEnd < 0) {
    return targetUrl;
  }
  const authorityEnd = targetUrl.indexOf('/', schemeEnd + 3);
  if (authorityEnd < 0) {
    return targetUrl;
  }
  const path = targetUrl.slice(authorityEnd + 1).replace(/\/+$/, '');
  if (path === '') {
    return targetUrl;
  }
  return targetUrl.slice(0, authorityEnd + 1 + path.lastIndexOf('/'));
}

/** E200009/W160009：URL 目标不存在（与 core 判定同口径）。 */
function isImportUrlNotFound(err: SvnError): boolean {
  return extractSvnErrorCodes(err.stderr).includes('E200009') || err.stderr.includes('W160009');
}

/** 命令失败分类：认证失败按 auth 上报（是否弹补录由调用方按协议分支决定）。 */
function classifyImportConnError(err: unknown, fallback: 'parentUnreachable' | 'connectError'): ImportConnOutcome {
  if (err instanceof SvnError && isAuthFailure(err.stderr)) {
    return { ok: false, failure: 'auth', message: err.message };
  }
  return { ok: false, failure: fallback, message: err instanceof Error ? err.message : String(err) };
}

/**
 * 导入连接检查的命令编排（§5：命令顺序固定——先父 info、后目标 ls）：
 * 父 info 校验 kind=dir 并读取身份快照（uuid/root/last-changed）；目标
 * ls exit 0 = 已存在（existing），E200009 = 不存在（通过）。
 */
async function runImportConnCheck(
  svnPath: string,
  parentUrl: string,
  targetUrl: string,
  options: RunOptions,
): Promise<ImportConnOutcome> {
  let infoXml: string;
  try {
    const result = await runOrThrow(svnPath, ['info', '--xml', '--non-interactive', '--', escapeUrlPeg(parentUrl)], options);
    infoXml = result.stdout;
  } catch (err) {
    return classifyImportConnError(err, 'parentUnreachable');
  }
  const parent = parseParentInfoXml(infoXml);
  if (!parent) {
    return { ok: false, failure: 'parentUnreachable', message: '父目录信息无法解析（svn info --xml 输出异常）' };
  }
  if (parent.kind !== 'dir') {
    return { ok: false, failure: 'parentNotDir' };
  }
  try {
    await runOrThrow(svnPath, ['ls', '--non-interactive', '--', escapeUrlPeg(targetUrl)], options);
    return { ok: false, failure: 'targetExists' };
  } catch (err) {
    if (err instanceof SvnError && isImportUrlNotFound(err)) {
      return {
        ok: true,
        parentIdentity: {
          repositoryUuid: parent.repositoryUuid,
          repositoryRootUrl: parent.repositoryRootUrl,
          lastChangedRevision: parent.lastChangedRevision,
        },
      };
    }
    return classifyImportConnError(err, 'connectError');
  }
}

/**
 * 导入「下一步」（连接检查）：先父 info 后目标 ls；认证失败按协议分支显式
 * 编排（模型 auth 相位：失败转 auth → 弹补录 → resume 后带凭据重试 /
 * cancel 终止回 untested——svn+ssh/file 不弹、按普通失败呈现）；通过写
 * review.parentIdentity 初读并自动进入核对页（范围预览随进入发起）。
 */
async function handleImportNext(sessionId: string): Promise<void> {
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  const next = importNextReducer(session);
  session = next.state;
  pushRender();
  if (!next.issued) {
    return;
  }
  const seq = next.seq;
  const url = session.form.url;
  const svnPath = readSvnPath();
  const options: RunOptions = {
    timeoutMs: readTimeoutMs(),
    ...decodingRunOptions('import'),
  };
  let credentials: AuthCredentials | undefined;
  for (;;) {
    const runOptions: RunOptions = credentials
      ? { ...options, getCredentials: async () => credentials }
      : options;
    const outcome = await runImportConnCheck(svnPath, parentUrlOfImport(url), url, runOptions);
    if (outcome.ok || outcome.failure !== 'auth' || !schemeAcceptsCredentials(url)) {
      // 非认证失败（或 svn+ssh/file 的认证形态）：直接结论。
      applyIfLive(sessionId, (s) => importConnSettled(s, seq, outcome));
      break;
    }
    // 认证失败：转 auth 相位 → 弹补录 → resume 带凭据重试 / cancel 终止。
    applyIfLive(sessionId, (s) => importConnSettled(s, seq, outcome));
    if (!handle || !session || handle.sessionId !== sessionId || session.sessionId !== sessionId) {
      break;
    }
    if (session.conn.phase !== 'auth') {
      // 期间参数已编辑（代次失效）或检查已被终止：不再弹补录。
      break;
    }
    const creds = await promptForCredentials();
    if (!handle || !session || handle.sessionId !== sessionId) {
      break;
    }
    if (!creds) {
      applyIfLive(sessionId, (s) => connAuthCancel(s));
      break;
    }
    credentials = creds;
    applyIfLive(sessionId, (s) => connAuthResume(s));
  }
  // 通过自动进入核对页：随进入发起范围预览（进入 review 那次做快照比对）。
  if (
    session &&
    session.sessionId === sessionId &&
    handle?.sessionId === sessionId &&
    session.step === 'review' &&
    session.mode === 'import' &&
    session.conn.phase === 'success'
  ) {
    await runImportPreview(sessionId, true);
  }
}

/**
 * 范围预览（§5）：枚举注入 global-ignores 模式；compare=true（随 review
 * 进入/流程比对）时先做快照比对——digest 不一致置 scopeChanged 并保留旧
 * 快照提示重新预览，一致（或首次无快照）时装载新快照并复位勾选。
 */
async function runImportPreview(sessionId: string, compare: boolean): Promise<void> {
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  const s = session;
  if (s.mode !== 'import') {
    return;
  }
  const enumerated = enumerateImport(s.form.sourceDir);
  if (enumerated.error) {
    session = setPreviewError(s, enumerated.error);
    pushRender();
    return;
  }
  const enumeration = enumerated.enumeration!;
  if (compare) {
    const checked = checkImportScope(session, enumeration);
    if (checked.review.scopeChanged === 'source') {
      session = checked;
      pushRender();
      return;
    }
    session = checked;
  }
  session = setPreview(session, enumeration);
  resetImportPreviewView();
  pushRender();
}

/**
 * 导入预命令出口的统一收口（哑任务窗口——仓库确认框停留与重检秒级窗口，
 * §2.1/§5）：先把任务创建时捕获的表单快照写回草稿（不读面板实例 state——
 * 面板可能已 dispose 或被重开会话取代）、再移除任务对象（顺序与任务终态
 * 「先写缓存、再移除任务」同款）；UI 转移由调用方按各分支口径执行。
 */
function importPreCommandExit(task: TaskObject): void {
  const scope = task.resultScope as CheckoutResultScope;
  const form = task.formSnapshot as CheckoutFormDraft | undefined;
  if (form) {
    saveDraft(scope.entryKey, scope.mode, form);
  }
  removeTask(task.taskId);
}

/** import unknown/merged 记录查询（核实/收口/放弃的动作对象；lockKey=源目录）。 */
function importUnknownRecordFor(sourceDir: string): OperationRecord | undefined {
  return getOperationRegistry()
    .pendingForWcRoot(sourceDir)
    .filter((record) => kindOf(record) === 'import' && record.phase === 'unknown')
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

/** 开始导入（§5 时序）：三次快照比对 + 双确认 + 哑任务承载确认/重检窗口 + 全链重检后发起。 */
async function handleStartImport(sessionId: string): Promise<void> {
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  const t = strings.checkoutPanel;
  let s = session;
  if (s.mode !== 'import' || s.step !== 'review') {
    pushRender();
    return;
  }
  if (!s.review.checked || importConfirmBlockReason(s.review) !== null) {
    pushRender();
    return;
  }
  if (s.form.url === '' || s.form.urlError !== null || s.form.sourceDir === '' || s.review.parentIdentity === null) {
    pushRender();
    return;
  }
  const sourceDir = normalizePath(s.form.sourceDir);
  const url = s.form.url;
  const message = s.form.message;
  const nameMode = s.form.nameMode;
  const parentUrl = parentUrlOfImport(url);
  const parentIdentity = s.review.parentIdentity;
  const scope: CheckoutResultScope = { entryKey: s.entry.entryKey, mode: 'import' };
  const basisSnapshot = s.review.snapshot;
  const basisDigest = basisSnapshot ? snapshotDigest(basisSnapshot) : null;

  // 第二次快照比对（点开始时；review 进入是第一次）。
  const second = enumerateImport(sourceDir);
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  if (second.error) {
    session = setPreviewError(session, second.error);
    pushRender();
    return;
  }
  s = checkImportScope(session, second.enumeration!);
  session = s;
  if (s.review.scopeChanged === 'source') {
    pushRender();
    return;
  }

  // 空说明口径（M1 同款语义）：开关关闭直接拒绝；开启时二次确认。
  if (s.form.message.trim() === '') {
    if (!readAllowEmptyCommitMessage()) {
      handle.toast('info', strings.commit.emptyMessageRejected);
      return;
    }
    session = setEmptyMessageConfirm(session, true);
    pushRender();
    const proceed = await vscode.window.showWarningMessage(
      strings.commit.emptyMessageConfirm,
      { modal: true },
      strings.commit.continueButton,
    );
    if (!handle || !session || handle.sessionId !== sessionId || session.sessionId !== sessionId) {
      return;
    }
    session = setEmptyMessageConfirm(session, false);
    if (proceed !== strings.commit.continueButton) {
      pushRender();
      return;
    }
  }

  // 任务启动递增（任务创建时点、busy 开始之前）+ 任务开始清草稿 + 哑任务
  // 创建（§5：确认框打开前进 taskRegistry——busy 承载确认框停留与重检
  // 窗口，一切未发起出口经任务移除收口）。
  bumpResultEpoch('checkout');
  clearDraft(scope.entryKey, scope.mode);
  const formSnapshot = toDraft(session);
  const placeholder: TaskObject = {
    taskId: randomOperationId(),
    panelKind: 'checkout',
    phase: 'connecting',
    resultScope: scope,
    lockKey: sourceDir,
    formSnapshot,
    initiatorSessionId: sessionId,
    abortController: new AbortController(),
  };
  addTask(placeholder);

  // 仓库提交确认框（模态：Esc 不发起 = confirmAborted 预命令出口）。
  session = setConfirmState(session, true);
  pushRender();
  const confirmed = await vscode.window.showWarningMessage(
    t.importCommitConfirmTitle,
    {
      modal: true,
      detail: format(t.importCommitConfirmDetail, {
        url: editableURL(url),
        count: String(session.review.previewSummary?.fileCount ?? 0),
        message: session.form.message.trim() === '' ? '（空）' : session.form.message,
      }),
    },
    t.importCommitConfirmButton,
  );
  const live = () =>
    Boolean(handle && session && handle.sessionId === sessionId && session.sessionId === sessionId);
  if (live()) {
    session = setConfirmState(session, false);
    pushRender();
  }
  if (confirmed !== t.importCommitConfirmButton) {
    // Esc/取消：出口收口（草稿写回 + 任务移除）；勾选保留可再次点开始。
    importPreCommandExit(placeholder);
    return;
  }

  // 第三次快照比对（确认通过后、与远端重检同时点；先于远端重检执行）。
  const third = enumerateImport(sourceDir);
  const thirdDigest = third.enumeration ? snapshotDigest(enumerationToSnapshot(third.enumeration)) : null;
  if (third.error) {
    // 源无法枚举：无法完整确认范围——按 sourceChanged 出口（清勾选经 setPreviewError）。
    if (live()) {
      session = setPreviewError(session, third.error);
    }
    importPreCommandExit(placeholder);
    if (live()) {
      pushRender();
    }
    return;
  }
  if (thirdDigest !== basisDigest) {
    if (live()) {
      session = checkImportScope(session, third.enumeration!);
    }
    importPreCommandExit(placeholder);
    if (live()) {
      pushRender();
    }
    return;
  }

  // 远端重检（先父 info 后目标 ls——recheckImportTarget 固定顺序；父身份
  // 比对与 lastChangedRevision 刷新）。targetChanged 与网络/认证失败分列。
  const recheck = await recheckImportTarget(readSvnPath(), parentUrl, url, parentIdentity, {
    timeoutMs: readTimeoutMs(),
    ...decodingRunOptions('import'),
  });
  if (live()) {
    session = setRecheckOutcome(session, recheck);
  }
  if (!recheck.ok) {
    // 两类分支的 UI 都由 setRecheckOutcome 承载（targetChanged 清勾选提示
    // 重新测试核对；网络/认证失败 review.error 横幅清确认保留参数）。
    importPreCommandExit(placeholder);
    if (live()) {
      pushRender();
    }
    return;
  }

  // 全通过 → 发起真实导入任务（执行器内部快照落盘 → begin → import →
  // 证据检查；addTask 自动替换哑任务——busy 连续、无窗口间隙）。
  const started = startImportTask({
    sourceDir,
    targetUrl: url,
    parentIdentity: recheck.parentIdentity,
    message,
    nameMode,
    snapshot: basisSnapshot!,
    entryKey: scope.entryKey,
    initiatorSessionId: sessionId,
    formSnapshot,
    callbacks: makeImportTaskCallbacks(sessionId),
  });
  if (live()) {
    session = beginImportTask(session, { opId: started.taskId, targetPath: sourceDir, resultScope: scope });
    pushRender();
  }
  watchTaskPhase(started.taskId, sessionId);
  void settleImportOnDone(started.done, sessionId);
}

/** 导入任务回调集合（认证弹窗、父身份清除、进度节流、日志、预命令出口、成功 URL 历史）。 */
function makeImportTaskCallbacks(sessionId: string): ImportTaskCallbacks {
  let lastPushAt = 0;
  return {
    getCredentials: () => promptForCredentials(),
    onParentIdentityConsumed: () => {
      applyIfLive(sessionId, (s) => consumeParentIdentity(s));
    },
    onProgress: (state) => {
      if (!handle || !session || handle.sessionId !== sessionId || session.sessionId !== sessionId) {
        return;
      }
      if (!session.task) {
        return;
      }
      session = taskProgress(session, { count: state.count, currentFile: state.currentFile });
      const now = Date.now();
      if (now - lastPushAt >= PROGRESS_RENDER_THROTTLE_MS) {
        lastPushAt = now;
        pushRender();
      }
    },
    onLogLine: (text) => {
      logLine(text, 'import');
    },
    onPreCommandExit: (exit) => {
      if (!handle || !session || handle.sessionId !== sessionId || session.sessionId !== sessionId) {
        return;
      }
      if (exit.kind === 'beginBusy') {
        // busy 分支：回核对页（连接结论仍有效）+ toast，不写错误横幅。
        session = enterReview(session);
        handle.toast('info', strings.checkoutPanel.beginBusyNotice);
      } else if (exit.kind === 'beginIdConflict') {
        session = setReviewError(session, strings.checkoutPanel.beginIdConflictNotice);
      } else if (exit.kind === 'targetChanged' || exit.kind === 'sourceChanged' || exit.kind === 'confirmAborted') {
        // 流程出口（面板侧已由 setRecheckOutcome/checkImportScope 承载）：
        // 到达执行器窗口的重复出口只回核对页通用提示。
        session = setReviewError(session, strings.checkoutPanel.preCommandAbortedNotice);
      } else {
        session = setReviewError(session, exit.message ?? strings.checkoutPanel.preCommandAbortedNotice);
      }
      pushRender();
    },
    onSucceeded: ({ targetUrl }) => {
      // 成功（证据①与核实 committed 两时点触发）：共用 URL 历史写入。
      recordUrlHistory(targetUrl);
      if (session && session.history[0] !== targetUrl) {
        session = { ...session, history: addHistoryUrl(session.history, targetUrl) };
      }
    },
  };
}

/** 导入任务 done 结算：终态写结果页（发起会话仍存活时）。 */
async function settleImportOnDone(done: Promise<ImportTaskOutcome>, sessionId: string): Promise<void> {
  const outcome = await done;
  if (outcome.outcome === 'preCommandExit') {
    // 出口的 UI 转移由 onPreCommandExit 回调承担（出口即达）。
    return;
  }
  if (!handle || !session || handle.sessionId !== sessionId || session.sessionId !== sessionId) {
    return;
  }
  const result: P3ResultPage = { ...outcome.result };
  session = setResult(session, result);
  importVerifySnapshotFailed = false;
  pushRender();
}

/** 核实结论 → 结果页（§5 三分类：committed → 成功页 / notCommitted → 失败页 / unknown 保持；merged 页保持 merged）。 */
function importVerifyPage(report: ImportVerifyTaskResult, prevPath: string, prevKind: string): P3ResultPage {
  if (report.conclusion === 'committed') {
    return {
      mode: 'import',
      kind: 'success',
      revision: report.revision,
      path: prevPath,
      evidence: 'verified',
      detail: format(strings.checkoutPanel.importVerifyCommittedDetail, {
        revision: String(report.revision ?? ''),
      }),
    };
  }
  if (report.conclusion === 'notCommitted') {
    return {
      mode: 'import',
      kind: 'failed',
      path: prevPath,
      evidence: 'verified',
      detail: format(strings.checkoutPanel.importVerifyNotCommittedDetail, {
        revision: String(report.evidence?.parentLastChangedRevision ?? ''),
      }),
      formSnapshot: report.formSnapshot,
    };
  }
  if (prevKind === 'merged') {
    // merged 页核实证据不唯一：保持 merged（不判成功也不降级为普通 unknown）。
    return { mode: 'import', kind: 'merged', path: prevPath };
  }
  const page: P3ResultPage = {
    mode: 'import',
    kind: 'unknown',
    path: prevPath,
    resolution: 'unresolved',
    detail: report.message,
    formSnapshot: report.formSnapshot,
  };
  if (report.snapshotIncomplete === true) {
    page.snapshotIncomplete = true;
  }
  return page;
}

/**
 * 核实仓库结果（§5 unknown 核实）：发起时重置快照不完整标记并同步缓存
 * 镜像（§5 第 0 步）；结论按结果代次守卫——一致（或面板已 dispose）写
 * 结论页 + 控制器写缓存 + settleReadonlyVerify 推送，不一致丢弃不推送。
 * 记录收口已由执行器做过记录校验（recordSettled=false 即跳过）。
 */
async function handleVerifyImport(sessionId: string): Promise<void> {
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  const result = session.result;
  if (!result || result.mode !== 'import' || (result.kind !== 'unknown' && result.kind !== 'merged')) {
    pushRender();
    return;
  }
  const record = importUnknownRecordFor(result.path);
  if (!record) {
    handle.toast('info', strings.importTask.recordUnavailable);
    return;
  }
  const prevPath = result.path;
  const prevKind = result.kind;
  const scope = sessionScopeBaseline();
  const epoch = getResultEpoch('checkout');
  // 发起：unknown 页重置 snapshotIncomplete（模型）+ merged 页横幅标记清除
  // + 缓存镜像同步（快照修复后的再核实、旧 true 残留会让页面错误保留放弃出口）。
  session = beginImportVerify(session);
  importVerifySnapshotFailed = false;
  if (session.result?.mode === 'import') {
    writeSessionResult('checkout', scope, session.result, 'controller');
  }
  pushRender();
  try {
    const report = await verifyImportTask({
      operationId: record.operationId,
      resultScope: scope,
      epoch,
      callbacks: {
        getCredentials: () => promptForCredentials(),
        onSucceeded: ({ targetUrl }) => {
          // 核实转 committed：URL 历史共用写入（成功第二时点）。
          recordUrlHistory(targetUrl);
          if (session && session.history[0] !== targetUrl) {
            session = { ...session, history: addHistoryUrl(session.history, targetUrl) };
          }
        },
      },
    });
    let written = false;
    if (getResultEpoch('checkout') === epoch) {
      const page = importVerifyPage(report, prevPath, prevKind);
      written = writeSessionResult('checkout', scope, page, 'controller');
      if (written && handle && session && handle.sessionId === sessionId && session.sessionId === sessionId) {
        session = setResult(session, page);
        // merged 页核实第 0 步失败：保持 merged、以页面横幅提示（不写
        // snapshotIncomplete——该字段仅 unknown 页合法）。
        importVerifySnapshotFailed =
          report.conclusion === 'unknown' && report.snapshotIncomplete === true && prevKind === 'merged';
      }
    }
    // 结论写入或被守卫丢弃后结算登记：写入才向存活会话推送重跑。
    settleReadonlyVerify('checkout', written);
    if (handle && session && handle.sessionId === sessionId) {
      pushRender();
    }
  } catch (err) {
    // 命令异常终止：verifyImportTask 已清除登记（不推送），提示原因。
    handle?.toast('error', err instanceof Error ? err.message : String(err));
  }
}

/** 「已人工核对，完成」（merged 页收口，出口⑧）：确认后递增代次（第一条同步语句）→ 记录收口 → settled 页。 */
async function handleAcknowledgeMerged(sessionId: string): Promise<void> {
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  const result = session.result;
  if (!result || result.mode !== 'import' || result.kind !== 'merged' || result.settled === true) {
    pushRender();
    return;
  }
  const t = strings.checkoutPanel;
  const ok = await vscode.window.showWarningMessage(
    t.ackMergedConfirmTitle,
    { modal: true, detail: t.ackMergedConfirmDetail },
    t.ackMergedConfirmButton,
  );
  if (ok !== t.ackMergedConfirmButton) {
    return;
  }
  // 递增时点 = 确认处理的第一条同步语句、任何 await 之前（§2.1）：核实
  // 进行中点收口的迟到结论按代次守卫丢弃、记录收口经执行器校验跳过。
  bumpResultEpoch('checkout');
  const scope = sessionScopeBaseline();
  const record = importUnknownRecordFor(result.path);
  if (record) {
    await acknowledgeImportTask(record.operationId);
  }
  // settled 页写缓存（不依赖面板存活）+ 活会话 UI 更新。
  const settledPage: P3ResultPage = { ...result, settled: true };
  writeSessionResult('checkout', scope, settledPage, 'controller');
  importVerifySnapshotFailed = false;
  if (handle && session && handle.sessionId === sessionId && session.sessionId === sessionId) {
    session = acknowledgeMergedReducer(session);
    pushRender();
  }
}

/** 快照快照（formSnapshot）→ 草稿形态（导入四字段 + 空表单默认；两层回填的快照侧数据源）。 */
function importDraftFromSnapshot(snapshot: { url: string; sourceDir: string; message: string; nameMode: 'auto' | 'manual' } | undefined): CheckoutFormDraft {
  const draft = createEmptyFormDraft();
  if (!snapshot) {
    return draft;
  }
  return {
    ...draft,
    url: snapshot.url,
    urlInput: editableURL(snapshot.url),
    sourceDir: snapshot.sourceDir,
    message: snapshot.message,
    nameMode: snapshot.nameMode,
  };
}

/** 「放弃核实并解除限制」（快照不完整 unknown 页，出口⑪）：确认 → 记录收口 → 回表单 + 清缓存 + 递增 + 草稿写回。 */
async function handleAbandonUnknownImport(sessionId: string): Promise<void> {
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  const result = session.result;
  if (!result || result.mode !== 'import' || result.kind !== 'unknown' || result.snapshotIncomplete !== true) {
    pushRender();
    return;
  }
  const t = strings.checkoutPanel;
  const ok = await vscode.window.showWarningMessage(
    t.abandonVerifyConfirmTitle,
    { modal: true, detail: t.abandonVerifyConfirmDetail },
    t.abandonVerifyConfirmButton,
  );
  if (ok !== t.abandonVerifyConfirmButton) {
    return;
  }
  const scope = sessionScopeBaseline();
  // 两层回填数据（await 前捕获——收口后面板可能已销毁，回填与写回不依赖面板存活）。
  const fromSessionForm = session.form.url !== '' || session.form.urlInput !== '';
  const fallbackDraft = fromSessionForm ? toDraft(session) : importDraftFromSnapshot(result.formSnapshot);
  const record = importUnknownRecordFor(result.path);
  if (record) {
    await abandonUnknownImportTask(record.operationId);
  }
  clearSessionResult('checkout', scope);
  bumpResultEpoch('checkout');
  importVerifySnapshotFailed = false;
  if (handle && session && handle.sessionId === sessionId && session.sessionId === sessionId) {
    // 回表单保留表单值（reducer 内两层回填）→ 回填后的当前 form 写回草稿（同一批）。
    session = abandonUnknownImportReducer(session);
    saveDraft(scope.entryKey, scope.mode, toDraft(session));
    resetImportPreviewView();
    pushRender();
  } else {
    saveDraft(scope.entryKey, scope.mode, fallbackDraft);
  }
}

/** 「返回填写并重试」（failed 页）：保留表单值回 form + 清缓存 + 递增 + 草稿写回（当前入口键）。 */
function handleRetryImport(sessionId: string): void {
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  const result = session.result;
  if (!result || result.mode !== 'import' || result.kind !== 'failed') {
    pushRender();
    return;
  }
  const scope = sessionScopeBaseline();
  clearSessionResult('checkout', scope);
  bumpResultEpoch('checkout');
  session = retryImportReducer(session);
  saveDraft(scope.entryKey, scope.mode, toDraft(session));
  resetImportPreviewView();
  pushRender();
}

/**
 * 「另选新目录检出」（success 页 handoff）：切 checkout 模式保留 URL/
 * revMode='number'/revision → 清缓存 + 递增 + 草稿写回（键 = 源目录
 * realpath + checkout——§9 程序化回表单出口的草稿写回，验收 10 的重开
 * 回填断言由此成立）。URL 优先取结果页携带的目标 URL（缓存恢复形态
 * 会话 form 为空——执行器结果页的 targetUrl 字段是模型外数据源）。
 */
function handleHandoffToCheckout(sessionId: string): void {
  if (!handle || !session || handle.sessionId !== sessionId) {
    return;
  }
  const result = session.result;
  if (!result || result.mode !== 'import' || result.kind !== 'success') {
    pushRender();
    return;
  }
  const scope = sessionScopeBaseline();
  // 关闭重开/缓存恢复形态：会话 form 为空，先把目标 URL 回填表单（经
  // syncInput 规范化），handoff 的「保留 URL」才有数据源。
  const targetUrl = (result as { targetUrl?: string }).targetUrl ?? session.form.url;
  if (targetUrl !== '' && session.form.url === '') {
    session = syncInput(session, 'url', editableURL(targetUrl));
  }
  clearSessionResult('checkout', scope);
  bumpResultEpoch('checkout');
  session = handoffReducer(session);
  // handoff 后入口不变（源目录 realpath）、mode=checkout：写「源目录 + checkout」键。
  saveDraft(scope.entryKey, 'checkout', toDraft(session));
  resetImportPreviewView();
  importVerifySnapshotFailed = false;
  pushRender();
}

/** 在 Finder 中显示导入源目录（success 页「查看原目录」）。 */
function revealSourceDir(): void {
  const result = session?.result;
  if (!result || result.mode !== 'import') {
    return;
  }
  void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(result.path));
}

/** 清空共用 URL 历史（检出/导入同一份；表单下拉与后续打开即时生效）。 */
function handleClearUrlHistory(): void {
  saveUrlHistory([]);
  if (session) {
    session = { ...session, history: [] };
    pushRender();
  }
}

/** 测试辅助：重置面板控制器模块级状态（真实宿主不需要）。 */
export function resetCheckoutPanelController(): void {
  handle = undefined;
  session = undefined;
  formRevision = 0;
  resetImportPreviewView();
  importVerifySnapshotFailed = false;
  taskRemovalSub?.dispose();
  taskRemovalSub = undefined;
  resultUpdatedSub?.dispose();
  resultUpdatedSub = undefined;
  if (phaseTimer !== undefined) {
    clearInterval(phaseTimer);
    phaseTimer = undefined;
  }
}
