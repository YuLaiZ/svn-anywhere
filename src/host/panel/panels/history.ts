/**
 * P6 历史面板控制器（M4 阶段 3 任务 1/2/3）：面板生命周期、意图分发与
 * 只读 SVN IO 编排。状态机全部在 historyModel（纯模型）；本文件只做
 * 调度、IO、票据、认证与资源清理。
 *
 * 只读边界（技术方案 §4/§7）：P6 不产生任何 SVN 写命令（update/resolve
 * 属阶段 6/5）；历史读取只执行 info/log/cat 类只读命令。
 *
 * 读请求代次（技术方案 §2.3）：
 * - 会话级：面板打开/切换目标/reset/refresh 时 handle.beginReadRequest
 *   重新取票据；任何回包先经 isSessionCurrent 校验（面板/模型/票据三元
 *   组），旧目标或旧代次的回包一律丢弃——旧目标状态已在切换前的每次
 *   push 持久化到 m4SessionStore，旧目标筛选/详情不丢；
 * - 详情解析另按模型 epoch 校验（selectRevision 递增），过期回包不写回；
 * - 远端命令一律 `--non-interactive`，认证经 authScope +
 *   credentialProvider 单飞协调器（同源并发只弹一次凭据框），凭据补录
 *   成功后重试原命令。
 *
 * upper 状态（§4.1/§6、HLS-6）：
 * - 本地入口先读 HEAD（失败且有本地 BASE → unresolved + “HEAD 暂不可用”
 *   + base-fallback 入口）；P5 交接固定 snapshotRevision，不读 HEAD；
 * - resetHistorySession 只在模型层未 resolved（unresolved）时拒绝，
 *   不重新解析 HEAD；refreshHistoryUpper(mode) 先做运行时能力校验，
 *   非法组合不触发任何 HEAD/info/log 命令；两者在 busy/writeLocked
 *   期间与 refresh 同组被放行表拒绝（gates 的 P6 表）。
 */
import * as vscode from 'vscode';
import { relative, sep } from 'node:path';
import type { HistoryOpenTarget } from '../../commands/history';
import {
  buildHistoryLogArgs,
  createAncestorFilterSource,
  createTargetSource,
  parseLogXml,
  resolveHistoryNodeAtRevision,
  urlForRepositoryPath,
  type HistoryFilter,
  type HistoryEntry,
  type HistoryTarget,
  type HistoryUpperRefreshMode,
} from '../../../core/history';
import { SvnError } from '../../../core/errors';
import {
  classifyBrowseFailure,
  extractSvnStatusCodes,
  parseRemoteInfoXml,
  type BrowserError,
} from '../../../core/remoteBrowse';
import { probeRemoteContent, readRemoteText } from '../../../core/remoteContent';
import { authScopeOfUrl, runOrThrow, urlWithPeg, type AuthScope, type RunOptions } from '../../../core/svnCli';
import { credentialProvider } from '../../auth';
import { readHistoryPageSize, readSvnPath, readTimeoutMs } from '../../config';
import {
  diffOutcomeNotice,
  openSnapshotBaseCompareEntry,
  openSnapshotNodeContent,
  openSnapshotTextDiff,
  promptSnapshotExport,
  type DiffTarget,
} from '../../diffView';
import { format, strings } from '../../i18n';
import { decodingRunOptions, logCommand, logLine } from '../../output';
import {
  putM4ScopeSession,
  readM4ScopeSession,
  type M4SessionScope,
} from '../../sessionResults';
import type { HistoryResultScope } from '../../taskRegistry';
import { createP6Gates, resolvePanelOccupancy, type PanelOccupancy } from '../gates';
import { createPanel, type PanelHandle, type ReadRequestTicket } from '../host';
import type { Intent } from '../protocol';
import {
  historyTargetKey,
  historyText,
  HistoryModel,
  parentRepositoryPath,
  type HistoryDetailResolutionView,
  type HistoryModelContext,
  type HistoryPhase,
} from '../historyModel';
import {
  applySnapshotCandidateProbes,
  buildSnapshotCandidateTable,
  createSnapshotCompareState,
  loadSnapshotCompare,
  planSnapshotBaseCompare,
  planSnapshotExport,
  selectSnapshotCandidate,
  selectedSnapshotCandidate,
  setSnapshotCompareFilter,
  setSnapshotComparePage,
  snapshotCandidateProbeSide,
  snapshotCandidateStatusText,
  snapshotCompareSummary,
  snapshotText,
  type SnapshotCandidateContentKind,
  type SnapshotCandidateState,
  type SnapshotCompareState,
} from '../snapshotModel';
import type { ActionSpec, BannerSpec, DetailSectionSpec, DetailSpec, PanelState } from '../state';
import { renderTableRowSlice } from '../view';
import { openCheckoutPanelFromHistory } from './checkout';

const PANEL_ID = 'history';

interface HistoryPanelContext {
  extensionUri: vscode.Uri;
  subscriptions: vscode.Disposable[];
}

interface CapturedSession {
  handle: PanelHandle;
  model: HistoryModel;
  ticket: ReadRequestTicket;
}

/** 比较执行器接口：快照比较由阶段 3 后续任务实现并注入（解耦点）。 */
export interface HistoryComparisonRequest {
  /** 比较来源：手动勾选两项 / 上一条可见记录快捷对。 */
  origin: 'selected' | 'previous-visible';
  /** 两个 revision（顺序保持来源；比较实现按 revision 数值定左右/新旧端）。 */
  revisions: [number, number];
}

export type HistoryComparisonRunner = (
  request: HistoryComparisonRequest,
  context: { target: HistoryTarget },
) => Promise<void> | void;

let panelContext: HistoryPanelContext | undefined;
let handle: PanelHandle | undefined;
let model: HistoryModel | undefined;
let entryTarget: HistoryOpenTarget | undefined;
let sessionTicket: ReadRequestTicket | undefined;
let loadController: AbortController | undefined;
let detailController: AbortController | undefined;
let comparisonRunner: HistoryComparisonRunner | undefined;
/** 当前比较结果区（快照候选）：undefined 表示历史列表模式。 */
let compareState: SnapshotCompareState | undefined;
/** 比较候选表的当前排序（宿主内存；只重排切片，不重新请求）。 */
let compareSort: { key: string; direction: 'asc' | 'desc' } | undefined;
/** 比较端点解析/候选探测在途请求（reset/切换目标/关闭时取消）。 */
let compareController: AbortController | undefined;

/** activate 时注入宿主上下文（extensionUri / subscriptions）。 */
export function setHistoryPanelContext(context: HistoryPanelContext): void {
  panelContext = context;
}

/**
 * 注入版本比较执行器（阶段 3 任务 4/5 的接线点）：未注入时比较意图给出
 * 「后续阶段接入」提示，不静默吞掉用户动作。
 */
export function setHistoryComparisonRunner(runner: HistoryComparisonRunner | undefined): void {
  comparisonRunner = runner;
}

/* ------------------------- 会话捕获与票据 ------------------------- */

function captureSession(): CapturedSession | undefined {
  if (handle === undefined || model === undefined || sessionTicket === undefined) {
    return undefined;
  }
  return { handle, model, ticket: sessionTicket };
}

/**
 * 会话是否仍然有效：面板未销毁、模型未被替换、读请求票据未被更新的
 * beginReadRequest 取代（打开/切换目标/reset/refresh 都会换票据）。
 */
function isSessionCurrent(captured: CapturedSession): boolean {
  return handle === captured.handle
    && model === captured.model
    && sessionTicket === captured.ticket
    && captured.handle.isReadRequestCurrent(captured.ticket);
}

/** 作用域：稳定身份键（仓库 UUID + 根 URL + 相对路径 + 类型）。 */
function scopeOfContext(context: HistoryModelContext): HistoryResultScope {
  return {
    scopeKind: 'history',
    targetKey: historyTargetKey(context.repositoryUuid, context.target),
    targetKind: context.target.kind,
  };
}

function currentScope(): HistoryResultScope | undefined {
  const context = model?.context;
  return context === undefined ? undefined : scopeOfContext(context);
}

/** 读请求票据的目标键：作用域键的稳定序列化。 */
function scopeTicketKey(scope: M4SessionScope): string {
  return JSON.stringify(scope);
}

/**
 * 递增读代次并重新捕获会话（reset/refresh/open 重试后旧回包必须过期）。
 * 读请求目标键与作用域一致，旧票据因 requestSeq 过期被丢弃。
 */
function advanceTicket(): CapturedSession | undefined {
  if (handle === undefined) {
    return undefined;
  }
  const scope = currentScope();
  if (scope === undefined) {
    return undefined;
  }
  sessionTicket = handle.beginReadRequest(scopeTicketKey(scope));
  return captureSession();
}

/* ------------------------- 持久化 ------------------------- */

/** 每次推送把可浏览状态/upper 三字段/上限状态写入 m4SessionStore。 */
function persist(): void {
  if (model === undefined) {
    return;
  }
  const snapshot = model.serialize();
  const scope = currentScope();
  if (snapshot === undefined || scope === undefined) {
    return;
  }
  putM4ScopeSession(scope, {
    browsable: snapshot.browsable,
    upper: snapshot.upper,
    historyLimitState: snapshot.historyLimitState,
  }, { current: scope });
}

/* ------------------------- 推送与占用态 ------------------------- */

/** 面板占用态：history-update 任务槽 + 共享写锁（技术方案 §7）。 */
function occupancyOf(): PanelOccupancy {
  const lockKey = entryTarget?.source === 'local' ? entryTarget.wcRoot : null;
  return resolvePanelOccupancy('history', lockKey);
}

/* ------------------------- 比较结果区（快照候选） ------------------------- */

function compareCloseAction(): ActionSpec {
  return { id: 'historyCompareClose', label: historyText('compareClose') };
}

/** 比较横幅：加载/失败/超限/成功摘要（成功时附各状态计数与关闭入口）。 */
function compareBanner(compare: SnapshotCompareState): BannerSpec {
  const close = compareCloseAction();
  switch (compare.phase) {
    case 'loading':
      return { id: 'historyCompare', level: 'info', title: historyText('compareLoading'), dismissable: false, actions: [close] };
    case 'error':
      return {
        id: 'historyCompare',
        level: 'error',
        title: historyText('compareError', { message: compare.errorMessage ?? '' }),
        dismissable: false,
        actions: [close],
      };
    case 'tooLarge':
      return { id: 'historyCompare', level: 'warn', title: snapshotText('tooLarge'), dismissable: false, actions: [close] };
    default:
      break;
  }
  return {
    id: 'historyCompare',
    level: 'info',
    title: historyText('compareSummary', {
      left: String(compare.leftRevision),
      right: String(compare.rightRevision),
      count: String(compare.candidates.length),
    }),
    ...(compareSummaryDetail(compare) !== undefined ? { detail: compareSummaryDetail(compare)! } : {}),
    dismissable: false,
    actions: [close],
  };
}

/** 候选状态计数摘要（只列出非零状态）。 */
function compareSummaryDetail(compare: SnapshotCompareState): string | undefined {
  if (compare.phase !== 'ready') {
    return undefined;
  }
  const summary = snapshotCompareSummary(compare);
  const statuses = ['added', 'deleted', 'modified', 'property', 'binary', 'same'] as const;
  const parts = statuses
    .filter((status) => summary[status] > 0)
    .map((status) => `${snapshotCandidateStatusText(status)} ${summary[status]}`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * 候选排序（表头 setSort 的宿主映射）：只重排宿主候选数组并按新顺序
 * 重算筛选下标与页码，不发起任何 SVN 请求。
 */
function sortCompareCandidates(
  state: SnapshotCompareState,
  key: string,
  direction: 'asc' | 'desc',
): SnapshotCompareState {
  const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  const valueOf = (candidate: SnapshotCandidateState): number | string => {
    switch (key) {
      case 'status':
        return snapshotCandidateStatusText(candidate.status);
      case 'leftRevision':
        return candidate.leftRevision ?? -1;
      case 'rightRevision':
        return candidate.rightRevision ?? -1;
      default:
        return candidate.displayPath;
    }
  };
  const sorted = [...state.candidates].sort((a, b) => {
    const left = valueOf(a);
    const right = valueOf(b);
    const compared = typeof left === 'number' && typeof right === 'number'
      ? left - right
      : collator.compare(String(left), String(right));
    return direction === 'desc' ? -compared : compared;
  });
  return setSnapshotCompareFilter({ ...state, candidates: sorted }, state.filterText);
}

/** 候选详情：两端实际 URL/存在性与打开动作；未选中时给出选择提示。 */
function buildCandidateDetail(compare: SnapshotCompareState): DetailSpec {
  const candidate = selectedSnapshotCandidate(compare);
  if (candidate === undefined) {
    return {
      title: historyText('candidateHeading'),
      sections: [{ kind: 'text', paragraphs: [historyText('candidateDetailEmpty')] }],
    };
  }
  const sideText = (present: boolean, url: string | undefined): string =>
    present ? (url ?? '') : snapshotText('stateAbsent');
  const sections: DetailSectionSpec[] = [{
    kind: 'kv',
    entries: [
      {
        label: historyText('candidatePathLabel'),
        value: candidate.displayPath === '' ? '.' : candidate.displayPath,
        mono: true,
      },
      { label: historyText('candidateStatusLabel'), value: snapshotCandidateStatusText(candidate.status) },
      {
        label: historyText('candidateLeftHeading', { revision: String(compare.leftRevision) }),
        value: sideText(candidate.leftPresent, candidate.leftUrl),
        mono: candidate.leftPresent,
      },
      {
        label: historyText('candidateRightHeading', { revision: String(compare.rightRevision) }),
        value: sideText(candidate.rightPresent, candidate.rightUrl),
        mono: candidate.rightPresent,
      },
    ],
  }];
  const probeSide = snapshotCandidateProbeSide(candidate);
  const actions: ActionSpec[] = [{
    id: 'openHistoryDiff',
    label: historyText('candidateOpenDiff'),
    ...(candidate.canOpenTextDiff
      ? {}
      : { disabled: true, disabledReason: historyText('candidateDiffUnavailable') }),
  }, {
    id: 'viewHistoryRevision',
    label: historyText('candidateOpenExternal'),
    ...(probeSide === undefined
      ? { disabled: true, disabledReason: snapshotText('stateNotFoundAtRevision') }
      : {}),
  }];
  sections.push({ kind: 'actions', actions });
  return { id: candidate.id, title: historyText('candidateHeading'), sections };
}

/**
 * 比较结果覆盖层：ready 时用候选表（每页 ≤100）替换历史主表并把候选详情
 * 放到右栏；加载中/失败/超限只加横幅，保留历史列表可继续查看。
 * 候选全量留在宿主，筛选/翻页只重算切片，不发起任何 SVN 请求。
 */
function applyCompareOverlay(state: PanelState): void {
  const compare = compareState;
  if (compare === undefined) {
    return;
  }
  state.banners = [compareBanner(compare), ...state.banners];
  if (compare.phase !== 'ready') {
    return;
  }
  state.table = buildSnapshotCandidateTable(compare, {
    ...(compareSort !== undefined ? { sort: compareSort } : {}),
    filters: [{ id: 'path', kind: 'text', cellKey: 'path', value: compare.filterText }],
  });
  state.detail = buildCandidateDetail(compare);
  state.filterPanel = undefined;
  state.footer = {
    summary: historyText('compareSummary', {
      left: String(compare.leftRevision),
      right: String(compare.rightRevision),
      count: String(compare.candidates.length),
    }),
    secondary: [compareCloseAction()],
  };
}

function buildStateWithOccupancy(): PanelState | undefined {
  if (model === undefined || handle === undefined) {
    return undefined;
  }
  // 配置变化（historyPageSize）只重置展示前缀，不清已扫描数据。
  model.setPageSize(readHistoryPageSize());
  const state = model.buildPanelState(handle.sessionId);
  const occupancy = occupancyOf();
  state.busy = state.busy || occupancy.busy;
  state.writeLocked = occupancy.writeLocked;
  applyCompareOverlay(state);
  return state;
}

function push(): void {
  const state = buildStateWithOccupancy();
  if (state === undefined || handle === undefined) {
    return;
  }
  handle.update(state, handle.sessionId);
  persist();
}

function pushIfCurrent(captured: CapturedSession): void {
  if (isSessionCurrent(captured)) {
    push();
  }
}

/**
 * 加载完成后的推送：历史列表模式且已有展示行时走 append 增量（只追加
 * 新增行片段，保持滚动位置，每次 ≤historyPageSize 行，与整帧 render 共用
 * 同一 revision 单调序列）；首屏/筛选重建/比较模式走整帧 render。
 */
function pushAfterLoad(captured: CapturedSession, previousDisplayed: number): void {
  if (!isSessionCurrent(captured) || handle === undefined || model === undefined) {
    return;
  }
  const session = model.sessionView();
  if (compareState !== undefined
    || previousDisplayed <= 0
    || session.displayedCount <= previousDisplayed
    || model.phase === 'opening'
    || session.upperRevision === null) {
    push();
    return;
  }
  const state = buildStateWithOccupancy();
  if (state === undefined || state.table === undefined) {
    push();
    return;
  }
  const table = state.table;
  const newRows = model.buildTableRows().slice(previousDisplayed, session.displayedCount);
  if (newRows.length === 0 || table.pagination.mode !== 'append') {
    push();
    return;
  }
  const renderState = { busy: state.busy, writeLocked: state.writeLocked, gate: state.gate };
  const pageSize = Math.max(1, model.pageSize);
  for (let start = 0; start < newRows.length; start += pageSize) {
    const chunk = newRows.slice(start, start + pageSize);
    handle.appendTreeNodes(table.id, renderTableRowSlice(renderState, table, chunk), state);
  }
  persist();
}

function toast(level: 'info' | 'error', message: string): void {
  handle?.toast(level, message);
}

/* ------------------------- 运行选项（认证单飞） ------------------------- */

function historyRunOptions(url: string): RunOptions {
  const svnPath = readSvnPath();
  const scope: AuthScope | undefined = authScopeOfUrl(url);
  const options: RunOptions = {
    timeoutMs: readTimeoutMs(),
    ...decodingRunOptions('browse'),
    onCredentialRetry: (args) => logCommand(svnPath, args, undefined, 'browse'),
  };
  if (scope !== undefined) {
    options.authScope = scope;
    options.getCredentials = credentialProvider(scope);
  }
  return options;
}

/* ------------------------- 打开面板 ------------------------- */

/** P6 打开器（命令层与 P5 交接经 setHistoryPanelOpener/setHistoryHandoffHandler 注入）。 */
export async function openHistoryPanel(target: HistoryOpenTarget): Promise<void> {
  if (panelContext === undefined) {
    logLine(strings.historyCommand.panelNotReady, 'browse');
    void vscode.window.showInformationMessage(strings.historyCommand.panelNotReady);
    return;
  }
  if (handle !== undefined) {
    // 同面板切换目标：生成新会话代次；busy 或写入在途时拒绝（P6 冻结规则）。
    const sessionId = handle.switchSession();
    if (sessionId === undefined) {
      void vscode.window.showInformationMessage(format(strings.panel.panelBusySwitchRejected, {
        target: displayTargetOf(target),
      }));
      return;
    }
  } else {
    handle = createPanel(
      PANEL_ID,
      {
        title: strings.historyPanel.panelTitle,
        gates: createP6Gates(),
        blockSwitchWhenWriteLocked: true,
      },
      { onIntent, onViewReady, onDispose: onPanelDispose },
      panelContext,
    );
  }
  await resetAndOpen(target);
}

function displayTargetOf(target: HistoryOpenTarget): string {
  return target.source === 'handoff'
    ? (target.payload.relativePath === '' ? target.payload.rawUrl : `^/${target.payload.relativePath}`)
    : target.localPath;
}

/** 目标 → 模型上下文（身份 + 本地 BASE/snapshot 语义来自入口）。 */
function modelContextOf(target: HistoryOpenTarget): HistoryModelContext {
  if (target.source === 'handoff') {
    return {
      repositoryUuid: target.payload.repositoryUuid,
      target: {
        url: target.payload.rawUrl,
        repositoryRootUrl: target.payload.repositoryRootUrl,
        relativePath: target.payload.relativePath,
        kind: target.payload.kind,
      },
      source: 'handoff',
    };
  }
  return {
    repositoryUuid: target.repositoryUuid,
    target: {
      url: target.url,
      repositoryRootUrl: target.repositoryRootUrl,
      relativePath: target.relativePath,
      kind: target.kind,
    },
    source: 'local',
    localPath: target.localPath,
    localBaseRevision: target.baseRevision,
  };
}

async function resetAndOpen(target: HistoryOpenTarget): Promise<void> {
  if (handle === undefined) {
    return;
  }
  cancelAllInflight();
  resetCompareState();
  entryTarget = target;
  const context = modelContextOf(target);
  const scope = scopeOfContext(context);
  model = new HistoryModel({ pageSize: readHistoryPageSize() });
  sessionTicket = handle.beginReadRequest(scopeTicketKey(scope));
  // 关闭重开恢复：LRU 未淘汰时恢复目标/筛选/勾选/详情与已加载数据，
  // 不重解析 HEAD、不伪造旧 upper；恢复无数据时才重读首批。
  const stored = readM4ScopeSession(scope);
  const restored = stored !== undefined
    && model.restore(context, stored.browsable, stored.upper, stored.historyLimitState);
  if (!restored) {
    model.beginOpen(context);
  }
  push();
  const captured = captureSession();
  if (captured === undefined) {
    return;
  }
  if (restored) {
    const pending = model.takePendingDetailResolve();
    if (pending !== undefined) {
      void resolveDetail(captured, pending);
    }
    if (!model.hasLoadedData() && model.sessionView().upperRevision !== null) {
      await runLoad(captured);
    }
    return;
  }
  await openFresh(captured);
}

/* ------------------------- HEAD / 目标存在性探测 ------------------------- */

/** `svn info --xml`（HEAD 或指定 revision；URL 经统一 peg 构造）。 */
async function runInfoAt(url: string, revision: number | undefined, options: RunOptions): Promise<string> {
  const args = [
    'info', '--xml', '--non-interactive',
    ...(revision !== undefined ? ['-r', String(revision)] : []),
    '--',
    urlWithPeg(url, revision),
  ];
  return (await runOrThrow(readSvnPath(), args, options)).stdout;
}

/** 由 RunResult 形态的失败分类（runOrThrow 已抛 SvnError，这里兜底构造）。 */
function classifyFailure(err: unknown, url: string): BrowserError {
  return classifyBrowseFailure(err, url);
}

/** 解析失败转 BrowserError（parse 形态）。 */
function parseFailure(message: string): BrowserError {
  return { kind: 'parse', message, codes: [] };
}

/**
 * 路径在 revision 不存在判定（阶段 0 C11）：`W170000` 与 `E200009` 同时
 * 出现。runOrThrow 抛出的 SvnError 只保留 stderr/message（不含 stdout），
 * 因此以错误码组合为准——C11 实测所有 absent 均为这组码；单独 E200009、
 * E160013 或 E170013+认证/网络错误都不是 absent 证据，必须进入 error。
 */
function isInfoAbsentFailure(err: SvnError): boolean {
  const codes = extractSvnStatusCodes(`${err.stderr}\n${err.message}`);
  return codes.includes('W170000') && codes.includes('E200009');
}

/** HEAD 解析结果。 */
type HeadProbe = { status: 'ok'; revision: number } | { status: 'error'; error: BrowserError };

/** 读取仓库 HEAD（`svn info --xml <rootUrl>`，不带 revision = HEAD）。 */
async function readHeadRevision(
  captured: CapturedSession,
  options: RunOptions,
): Promise<HeadProbe> {
  const context = captured.model.context;
  if (context === undefined) {
    return { status: 'error', error: parseFailure('缺少历史目标上下文') };
  }
  const rootUrl = context.target.repositoryRootUrl;
  let stdout: string;
  try {
    stdout = await runInfoAt(rootUrl, undefined, options);
  } catch (err) {
    return { status: 'error', error: classifyFailure(err, rootUrl) };
  }
  const parsed = parseRemoteInfoXml(stdout);
  if (parsed === undefined) {
    return { status: 'error', error: parseFailure('svn info --xml 输出缺少 HEAD 必需字段') };
  }
  return { status: 'ok', revision: parsed.node.snapshotRevision };
}

/** 目标在 upper revision 的存在性探测结果。 */
type PresenceProbe =
  | { status: 'present'; kind?: 'file' | 'dir' }
  | { status: 'absent'; ancestor: string }
  | { status: 'error'; error: BrowserError };

/**
 * 目标在 upperRevision 的存在性：先 info 目标 URL@upper；只有明确 absent
 * （W170000+E200009+空 entry）才沿仓库相对路径向上查找最近存在的祖先
 * 目录（ancestor-filter 源）；认证/网络/权限错误进入 error，不得误报删除。
 */
async function probePresence(
  captured: CapturedSession,
  upper: number,
  options: RunOptions,
): Promise<PresenceProbe> {
  const context = captured.model.context;
  if (context === undefined) {
    return { status: 'error', error: parseFailure('缺少历史目标上下文') };
  }
  const target = context.target;
  const attempt = async (url: string): Promise<
    { kind: 'ok'; stdout: string } | { kind: 'absent' } | { kind: 'error'; error: BrowserError }
  > => {
    try {
      return { kind: 'ok', stdout: await runInfoAt(url, upper, options) };
    } catch (err) {
      if (err instanceof SvnError && isInfoAbsentFailure(err)) {
        return { kind: 'absent' };
      }
      return { kind: 'error', error: classifyFailure(err, url) };
    }
  };

  const direct = await attempt(target.url);
  if (direct.kind === 'ok') {
    const parsed = parseRemoteInfoXml(direct.stdout);
    return parsed !== undefined
      ? { status: 'present', kind: parsed.node.kind }
      : { status: 'present' };
  }
  if (direct.kind === 'error') {
    return { status: 'error', error: direct.error };
  }

  let ancestor = parentRepositoryPath(target.relativePath);
  while (ancestor !== undefined) {
    const ancestorUrl = urlForRepositoryPath(target.repositoryRootUrl, ancestor);
    const result = await attempt(ancestorUrl);
    if (result.kind === 'ok') {
      return { status: 'absent', ancestor };
    }
    if (result.kind === 'error') {
      return { status: 'error', error: result.error };
    }
    ancestor = parentRepositoryPath(ancestor);
  }
  return {
    status: 'error',
    error: { kind: 'unknown', message: `目标路径的祖先在 revision ${upper} 均不存在`, codes: [] },
  };
}

/* ------------------------- 打开（fresh） ------------------------- */

/**
 * fresh 打开：handoff 固定 snapshotRevision；local 先读 HEAD（失败且有
 * 本地 BASE → unresolved，只开放 refresh/base-fallback/关闭）；随后探测
 * 目标存在性、建立初始源并读取首批。
 */
async function openFresh(captured: CapturedSession): Promise<void> {
  const target = entryTarget;
  if (target === undefined) {
    return;
  }
  const context = captured.model.context;
  if (context === undefined) {
    return;
  }
  const controller = new AbortController();
  loadController?.abort();
  loadController = controller;
  const options: RunOptions = {
    ...historyRunOptions(context.target.repositoryRootUrl),
    signal: controller.signal,
  };
  try {
    let upper: number;
    let upperSource: 'live-head' | 'snapshot';
    if (target.source === 'handoff') {
      // P5 进入：upper 固定为浏览快照 revision，不读 HEAD（snapshot 不刷新）。
      upper = target.payload.snapshotRevision;
      upperSource = 'snapshot';
    } else {
      const head = await readHeadRevision(captured, options);
      if (!isSessionCurrent(captured) || controller.signal.aborted) {
        return;
      }
      if (head.status === 'error') {
        // 本地目标有 BASE：HEAD 暂不可用，只开放 refresh/base-fallback/关闭；
        // 纯远端目标没有本地 BASE，不承诺离线历史（进入可重试错误）。
        if (captured.model.localBaseRevision() !== undefined) {
          captured.model.applyUnresolved(head.error);
        } else {
          captured.model.applyOpenError(head.error);
        }
        pushIfCurrent(captured);
        return;
      }
      upper = head.revision;
      upperSource = 'live-head';
    }
    const presence = await probePresence(captured, upper, options);
    if (!isSessionCurrent(captured) || controller.signal.aborted) {
      return;
    }
    if (presence.status === 'error') {
      captured.model.applyOpenError(presence.error);
      pushIfCurrent(captured);
      return;
    }
    captured.model.applyResolvedUpper({
      upperRevision: upper,
      upperSource,
      targetPresentAtUpper: presence.status === 'present',
      ...(presence.status === 'absent' ? { nearestExistingAncestor: presence.ancestor } : {}),
      ...(presence.status === 'present' && presence.kind !== undefined
        ? { targetKind: presence.kind }
        : {}),
    });
    pushIfCurrent(captured);
    await runLoad(captured);
  } finally {
    if (loadController === controller) {
      loadController = undefined;
    }
  }
}

/* ------------------------- 加载（首批/加载更多） ------------------------- */

/**
 * 一轮加载：pending-only 只推进展示游标；network 进入请求循环（每轮
 * 独立 500 条预算、每页 pageSize+1、上限前置检查都在 core 状态机里）。
 */
async function runLoad(captured: CapturedSession): Promise<void> {
  if (!isSessionCurrent(captured)) {
    return;
  }
  const before = captured.model.sessionView().displayedCount;
  const mode = captured.model.startLoadMore();
  if (mode === 'pending-only') {
    captured.model.finishLoadMore();
    // pending-only 只推进本地展示游标：整帧推送让「本轮」横幅与页脚计数
    // 按新一轮归零（本轮没有网络回包，不能沿用上一轮统计）。
    pushIfCurrent(captured);
    return;
  }
  if (mode === 'exhausted') {
    pushIfCurrent(captured);
    return;
  }
  captured.model.markLoading();
  pushIfCurrent(captured);
  const controller = new AbortController();
  loadController?.abort();
  loadController = controller;
  try {
    await pumpNetwork(captured, controller, before);
  } finally {
    if (loadController === controller) {
      loadController = undefined;
    }
  }
}

/** 网络请求循环：takeNextRequest → 执行 log → 应用回包，直到无请求。 */
async function pumpNetwork(
  captured: CapturedSession,
  controller: AbortController,
  previousDisplayed: number,
): Promise<void> {
  const context = captured.model.context;
  if (context === undefined) {
    return;
  }
  const options: RunOptions = {
    ...historyRunOptions(context.target.repositoryRootUrl),
    signal: controller.signal,
  };
  for (;;) {
    const request = captured.model.takeNextRequest();
    if (request === undefined) {
      break;
    }
    let stdout: string;
    try {
      stdout = (await runOrThrow(readSvnPath(), request.args, options)).stdout;
    } catch (err) {
      if (!isSessionCurrent(captured)) {
        return;
      }
      captured.model.failLoad(classifyFailure(err, request.source.queryUrl));
      pushIfCurrent(captured);
      return;
    }
    if (!isSessionCurrent(captured)) {
      return;
    }
    captured.model.applyLogPage({
      sourceId: request.source.id,
      entries: parseLogXml(stdout),
      requestedLimit: captured.model.pageSize + 1,
    });
  }
  captured.model.finishLoadMore();
  pushAfterLoad(captured, previousDisplayed);
}

/* ------------------------- 详情解析 ------------------------- */

/**
 * 解析所选 revision 的实际节点（present/absent/notFoundAtRevision/error），
 * 复制窗口来自当前已加载历史；回包按模型 epoch 校验，过期丢弃。
 */
async function resolveDetail(
  captured: CapturedSession,
  request: { revision: number; epoch: number },
): Promise<void> {
  const context = captured.model.context;
  if (context === undefined || !isSessionCurrent(captured)) {
    return;
  }
  detailController?.abort();
  const controller = new AbortController();
  detailController = controller;
  try {
    const resolution = await resolveHistoryNodeAtRevision(
      readSvnPath(),
      {
        target: context.target,
        revision: request.revision,
        entries: captured.model.sessionView().entriesByRevision.values(),
      },
      { ...historyRunOptions(context.target.repositoryRootUrl), signal: controller.signal },
    );
    if (!isSessionCurrent(captured)) {
      return;
    }
    const view: HistoryDetailResolutionView = resolution.status === 'present'
      ? { status: 'present', url: resolution.url, repositoryPath: resolution.repositoryPath }
      : resolution.status === 'absent'
        ? {
            status: 'absent',
            ...(resolution.deletedRevision !== undefined
              ? { deletedRevision: resolution.deletedRevision }
              : {}),
          }
        : { status: 'notFoundAtRevision' };
    captured.model.applyDetailResolution(request, view);
    pushIfCurrent(captured);
  } catch (err) {
    if (!isSessionCurrent(captured)) {
      return;
    }
    captured.model.applyDetailResolution(request, {
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
    pushIfCurrent(captured);
  } finally {
    if (detailController === controller) {
      detailController = undefined;
    }
  }
}

/* ------------------------- upper 刷新 ------------------------- */

function rejectText(check: { reason: string }, mode: HistoryUpperRefreshMode): string {
  if (check.reason === 'invalid-mode') {
    return format(strings.historyPanel.refreshModeRejected, { mode });
  }
  return format(historyText('baseFallbackNotAllowed'), {
    source: model?.sessionView().upperSource ?? 'unresolved',
  });
}

/** refreshHistoryUpper(mode='head')：重新解析 HEAD，按来源恢复/更新/已最新分支。 */
async function refreshHead(captured: CapturedSession): Promise<void> {
  const context = captured.model.context;
  if (context === undefined) {
    return;
  }
  const controller = new AbortController();
  loadController?.abort();
  loadController = controller;
  const options: RunOptions = {
    ...historyRunOptions(context.target.repositoryRootUrl),
    signal: controller.signal,
  };
  const previousUpper = captured.model.sessionView().upperRevision;
  try {
    const head = await readHeadRevision(captured, options);
    if (!isSessionCurrent(captured) || controller.signal.aborted) {
      return;
    }
    if (head.status === 'error') {
      toast('error', format(strings.historyPanel.headRefreshFailed, {
        revision: String(previousUpper ?? 0),
        message: head.error.message,
      }));
      return;
    }
    const result = captured.model.applyUpperRefresh('head', head.revision);
    if (result === 'up-to-date') {
      // 仅 live-head 且同 HEAD：提示已最新并保留已加载数据。
      toast('info', format(strings.historyPanel.headUpToDate, { revision: String(head.revision) }));
      pushIfCurrent(captured);
      return;
    }
    pushIfCurrent(captured);
    // updated：重新探测目标存在性并重建源、重读首批（保留 target/filter/follow）。
    const presence = await probePresence(captured, head.revision, options);
    if (!isSessionCurrent(captured) || controller.signal.aborted) {
      return;
    }
    if (presence.status === 'error') {
      captured.model.failLoad(presence.error);
      pushIfCurrent(captured);
      return;
    }
    captured.model.establishInitialSources({
      targetPresentAtUpper: presence.status === 'present',
      ...(presence.status === 'absent' ? { nearestExistingAncestor: presence.ancestor } : {}),
      ...(presence.status === 'present' && presence.kind !== undefined
        ? { targetKind: presence.kind }
        : {}),
    });
    toast('info', format(strings.historyPanel.headRefreshed, { revision: String(head.revision) }));
    pushIfCurrent(captured);
    const next = advanceTicket();
    if (next !== undefined) {
      await runLoad(next);
    }
  } finally {
    if (loadController === controller) {
      loadController = undefined;
    }
  }
}

/**
 * refreshHistoryUpper(mode='base-fallback')：只有随后的 BASE 上限 `svn log`
 * 成功才进入结果；任一失败保持原会话（三字段与已加载数据不变）。
 */
async function refreshBaseFallback(captured: CapturedSession): Promise<void> {
  const context = captured.model.context;
  const base = captured.model.localBaseRevision();
  if (context === undefined || base === undefined) {
    return;
  }
  const controller = new AbortController();
  loadController?.abort();
  loadController = controller;
  const options: RunOptions = {
    ...historyRunOptions(context.target.repositoryRootUrl),
    signal: controller.signal,
  };
  try {
    const presence = await probePresence(captured, base, options);
    if (!isSessionCurrent(captured) || controller.signal.aborted) {
      return;
    }
    if (presence.status === 'error') {
      toast('error', format(historyText('baseFallbackFailed'), { message: presence.error.message }));
      return;
    }
    const probeSource = presence.status === 'present'
      ? createTargetSource(context.target, base)
      : presence.ancestor !== undefined
        ? createAncestorFilterSource(context.target, presence.ancestor, base)
        : undefined;
    if (probeSource === undefined) {
      toast('error', format(historyText('baseFallbackFailed'), { message: '没有可用的 BASE 历史源' }));
      return;
    }
    const args = buildHistoryLogArgs(probeSource, captured.model.pageSize, captured.model.followCopies());
    let stdout: string;
    try {
      stdout = (await runOrThrow(readSvnPath(), args, options)).stdout;
    } catch (err) {
      if (!isSessionCurrent(captured) || controller.signal.aborted) {
        return;
      }
      const error = classifyFailure(err, probeSource.queryUrl);
      toast('error', format(historyText('baseFallbackFailed'), { message: error.message }));
      return;
    }
    if (!isSessionCurrent(captured)) {
      return;
    }
    const entries = parseLogXml(stdout);
    // log 成功：三字段固定 base-fallback/unavailable（upper=BASE）并重建源。
    captured.model.applyBaseFallbackSuccess(base, {
      targetPresentAtUpper: presence.status === 'present',
      ...(presence.status === 'absent' ? { nearestExistingAncestor: presence.ancestor } : {}),
      ...(presence.status === 'present' && presence.kind !== undefined
        ? { targetKind: presence.kind }
        : {}),
    });
    const mode = captured.model.startLoadMore();
    captured.model.markLoading();
    pushIfCurrent(captured);
    if (mode === 'network') {
      // 把已取得的首批回包应用后继续按同一轮预算推进。
      captured.model.applyLogPage({
        sourceId: probeSource.id,
        entries,
        requestedLimit: captured.model.pageSize + 1,
      });
      const before = captured.model.sessionView().displayedCount;
      await pumpNetwork(captured, controller, before);
    } else {
      captured.model.finishLoadMore();
      pushIfCurrent(captured);
    }
  } finally {
    if (loadController === controller) {
      loadController = undefined;
    }
  }
}

/* ------------------------- 复制 ------------------------- */

/** 复制历史文本（提交说明/revision/变更路径/节点 URL/当前目标路径）。 */
async function copyHistoryText(
  captured: CapturedSession,
  copyKind: string,
  id: string,
): Promise<void> {
  const context = captured.model.context;
  if (context === undefined) {
    return;
  }
  let value: string | undefined;
  if (copyKind === 'nodeUrl') {
    value = context.target.url;
  } else if (copyKind === 'targetPath') {
    value = context.localPath
      ?? (context.target.relativePath === '' ? context.target.repositoryRootUrl : `^/${context.target.relativePath}`);
  } else {
    const revision = Number(/^r(\d+)$/.exec(id)?.[1]);
    const entry = Number.isInteger(revision)
      ? captured.model.sessionView().entriesByRevision.get(revision)
      : undefined;
    if (entry !== undefined) {
      if (copyKind === 'message') {
        value = entry.message;
      } else if (copyKind === 'revision') {
        value = `r${entry.revision}`;
      } else if (copyKind === 'changedPath') {
        value = entry.paths.map((change) => change.path).join('\n');
      }
    }
  }
  if (value === undefined) {
    return;
  }
  try {
    await vscode.env.clipboard.writeText(value);
    toast('info', historyText('copied', { value: value.length > 120 ? `${value.slice(0, 120)}…` : value }));
  } catch (err) {
    toast('error', historyText('copyFailed', {
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

/* ------------------------- 比较 ------------------------- */

/**
 * 比较意图统一入口：显式注入的比较执行器优先（阶段 3 任务 4 的解耦点），
 * 未注入时使用内置快照比较（snapshotModel + core/snapshot）：按 revision
 * 数值定左右端、两端经历史复制窗口解析实际节点，候选全量留在宿主。
 */
async function runComparison(
  captured: CapturedSession,
  origin: HistoryComparisonRequest['origin'],
  revisions: [number, number] | undefined,
): Promise<void> {
  if (revisions === undefined) {
    toast('info', origin === 'previous-visible'
      ? historyText('previousBoundary')
      : historyText('compareNeedsTwo'));
    return;
  }
  const context = captured.model.context;
  if (context === undefined) {
    return;
  }
  if (comparisonRunner !== undefined) {
    try {
      await comparisonRunner({ origin, revisions }, { target: context.target });
    } catch (err) {
      toast('error', err instanceof Error ? err.message : String(err));
    }
    pushIfCurrent(captured);
    return;
  }
  await runSnapshotComparison(captured, context.target, revisions);
}

/** 内置快照比较：创建比较状态 → 解析两端并生成候选 → 覆盖结果区。 */
async function runSnapshotComparison(
  captured: CapturedSession,
  target: HistoryTarget,
  revisions: [number, number],
): Promise<void> {
  const context = captured.model.context;
  if (context === undefined) {
    return;
  }
  const state = createSnapshotCompareState(target, revisions[0], revisions[1]);
  compareState = state;
  compareSort = { key: 'path', direction: 'asc' };
  pushIfCurrent(captured);
  compareController?.abort();
  const controller = new AbortController();
  compareController = controller;
  try {
    const entries: HistoryEntry[] = [...captured.model.sessionView().entriesByRevision.values()];
    const next = await loadSnapshotCompare(
      readSvnPath(),
      state,
      { entries },
      { ...historyRunOptions(context.target.repositoryRootUrl), signal: controller.signal },
    );
    if (!isSessionCurrent(captured) || compareState !== state || controller.signal.aborted) {
      return;
    }
    compareState = next;
    pushIfCurrent(captured);
  } catch (err) {
    if (!isSessionCurrent(captured) || compareState !== state) {
      return;
    }
    compareState = {
      ...state,
      phase: 'error',
      errorMessage: err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err),
    };
    pushIfCurrent(captured);
  } finally {
    if (compareController === controller) {
      compareController = undefined;
    }
  }
}

/* ------------------------- 比较候选 ------------------------- */

/** 退出比较结果区，回到历史列表（只改面板状态，不发 SVN 命令）。 */
function closeCompare(captured: CapturedSession): void {
  if (compareState === undefined) {
    return;
  }
  compareController?.abort();
  compareState = undefined;
  compareSort = undefined;
  pushIfCurrent(captured);
}

/** 清空比较状态（reset/refresh/切换目标/重开前调用，不发渲染）。 */
function resetCompareState(): void {
  compareController?.abort();
  compareController = undefined;
  compareState = undefined;
  compareSort = undefined;
}

/** 选择候选：只更新选中并触发一次内容类型探测（不重新请求比较）。 */
async function selectCompareCandidate(captured: CapturedSession, id: string): Promise<void> {
  const compare = compareState;
  if (compare === undefined) {
    return;
  }
  const next = selectSnapshotCandidate(compare, id);
  if (next === compare) {
    return;
  }
  compareState = next;
  pushIfCurrent(captured);
  await probeCandidateContent(captured, id);
}

/**
 * 候选内容探测（选中时惰性执行一次）：右/新端优先，经远端 mime/NUL 探测
 * 判定二进制；属性-only（item=none + props=modified）且两端可读文本时比较
 * 内容是否相同，用于把「内容相同仅属性变化」归为 property。探测失败保留
 * 未探测状态，不阻塞候选浏览。
 */
async function probeCandidateContent(captured: CapturedSession, id: string): Promise<void> {
  const compare = compareState;
  const context = captured.model.context;
  if (compare === undefined || context === undefined) {
    return;
  }
  const candidate = compare.candidates.find((entry) => entry.id === id);
  if (candidate === undefined || candidate.contentKind !== undefined) {
    return;
  }
  const side = snapshotCandidateProbeSide(candidate);
  if (side === undefined) {
    return;
  }
  compareController?.abort();
  const controller = new AbortController();
  compareController = controller;
  const options: RunOptions = {
    ...historyRunOptions(context.target.repositoryRootUrl),
    signal: controller.signal,
  };
  try {
    const probe = await probeRemoteContent(readSvnPath(), side.url, { ...options, revision: side.revision });
    if (!isSessionCurrent(captured) || compareState !== compare || controller.signal.aborted) {
      return;
    }
    const probes = new Map<string, { contentKind?: SnapshotCandidateContentKind; contentsEqual?: boolean }>();
    if (probe.status === 'probed') {
      if (probe.classification.kind === 'binary') {
        probes.set(id, { contentKind: 'binary' });
      } else if (candidate.item === 'none' && candidate.props === 'modified'
        && candidate.leftPresent && candidate.rightPresent
        && candidate.leftUrl !== undefined && candidate.leftRevision !== undefined
        && candidate.rightUrl !== undefined && candidate.rightRevision !== undefined) {
        const left = await readRemoteText(readSvnPath(), candidate.leftUrl, {
          ...options,
          revision: candidate.leftRevision,
        });
        const right = await readRemoteText(readSvnPath(), candidate.rightUrl, {
          ...options,
          revision: candidate.rightRevision,
        });
        if (!isSessionCurrent(captured) || compareState !== compare || controller.signal.aborted) {
          return;
        }
        probes.set(id, left.status === 'text' && right.status === 'text'
          ? { contentKind: 'text', contentsEqual: left.text === right.text }
          : { contentKind: 'text' });
      } else {
        probes.set(id, { contentKind: 'text' });
      }
    }
    if (probes.size > 0) {
      compareState = applySnapshotCandidateProbes(compare, probes);
      pushIfCurrent(captured);
    }
  } catch {
    // 探测是辅助信息：失败保持未探测，不打断候选选择与差异打开。
  } finally {
    if (compareController === controller) {
      compareController = undefined;
    }
  }
}

/** 打开选中候选的原生文本差异（单端不存在用空内容端；二进制/特殊/超限提示）。 */
async function openCandidateDiff(captured: CapturedSession): Promise<void> {
  const compare = compareState;
  const context = captured.model.context;
  if (compare === undefined || context === undefined) {
    return;
  }
  const candidate = selectedSnapshotCandidate(compare);
  if (candidate === undefined) {
    toast('info', historyText('candidateDetailEmpty'));
    return;
  }
  if (!candidate.canOpenTextDiff) {
    toast('info', historyText('candidateDiffUnavailable'));
    return;
  }
  const left = {
    ...(candidate.leftPresent && candidate.leftUrl !== undefined
      ? { rawUrl: candidate.leftUrl }
      : {}),
    revision: compare.leftRevision,
    ...(candidate.displayPath !== '' ? { displayName: candidate.displayPath } : {}),
  };
  const right = {
    ...(candidate.rightPresent && candidate.rightUrl !== undefined
      ? { rawUrl: candidate.rightUrl }
      : {}),
    revision: compare.rightRevision,
    ...(candidate.displayPath !== '' ? { displayName: candidate.displayPath } : {}),
  };
  const outcome = await openSnapshotTextDiff({
    svnPath: readSvnPath(),
    title: candidate.displayPath === '' ? '.' : candidate.displayPath,
    left,
    right,
    runOptions: historyRunOptions(context.target.repositoryRootUrl),
  }).catch((err: unknown) => ({
    status: 'failed' as const,
    message: err instanceof Error ? err.message : String(err),
  }));
  if (!isSessionCurrent(captured)) {
    return;
  }
  if (outcome.status === 'opened') {
    return;
  }
  if (outcome.status === 'binary') {
    toast('info', snapshotText('binaryNotice'));
    return;
  }
  if (outcome.status === 'special') {
    toast('info', snapshotText('specialNotice'));
    return;
  }
  if (outcome.status === 'tooLarge') {
    toast('error', snapshotText('tooLarge'));
    return;
  }
  if (outcome.status === 'failed') {
    toast('error', historyText('candidateOpenFailed', { message: outcome.message }));
    return;
  }
  toast('error', outcome.error.message);
}

/* ------------------------- 详情动作：导出 / 查看 / 检出 / BASE ------------------------- */

/** 详情动作的目标：优先使用当前详情解析出的实际节点。 */
interface DetailActionTarget {
  revision: number;
  url?: string;
  actualRevision?: number;
  repositoryPath?: string;
}

function detailActionTarget(): DetailActionTarget | undefined {
  const detail = model?.detailState();
  if (detail === undefined) {
    return undefined;
  }
  const resolution = detail.resolution;
  return {
    revision: detail.revision,
    ...(resolution.status === 'present'
      ? {
          url: resolution.url,
          ...(resolution.revision !== undefined ? { actualRevision: resolution.revision } : {}),
          repositoryPath: resolution.repositoryPath,
        }
      : {}),
  };
}

/** 导出当前详情 revision（删除提交导出 deletionRevision-1 前版本）。 */
async function exportHistoryVersion(captured: CapturedSession): Promise<void> {
  const context = captured.model.context;
  const target = detailActionTarget();
  if (context === undefined || target === undefined) {
    return;
  }
  const detail = model?.detailState();
  const deletionRevision = detail?.resolution.status === 'absent'
    ? detail.resolution.deletedRevision
    : undefined;
  try {
    const plan = await planSnapshotExport(
      readSvnPath(),
      {
        target: context.target,
        revision: target.revision,
        entries: [...captured.model.sessionView().entriesByRevision.values()],
        ...(deletionRevision !== undefined ? { deletionRevision } : {}),
      },
      historyRunOptions(context.target.repositoryRootUrl),
    );
    if (!isSessionCurrent(captured)) {
      return;
    }
    if (plan.status === 'notFound') {
      toast('error', snapshotText('exportNotFound'));
      return;
    }
    if (plan.status === 'directoryNotSupported') {
      toast('info', snapshotText('exportDirectoryBlocked'));
      return;
    }
    const suggested = plan.repositoryPath.split('/').filter((segment) => segment !== '').pop() ?? 'svn-export';
    const outcome = await promptSnapshotExport({
      svnPath: readSvnPath(),
      plan,
      suggestedName: suggested,
      runOptions: historyRunOptions(context.target.repositoryRootUrl),
    });
    if (!isSessionCurrent(captured)) {
      return;
    }
    if (outcome.status === 'exported') {
      toast('info', outcome.viaHistoryFallback
        ? format(snapshotText('exportFallbackNotice'), {
            revision: String(outcome.revision),
            path: outcome.path,
          })
        : plan.status === 'preceding'
          ? format(snapshotText('exportDeletedNotice'), {
              revision: String(outcome.revision),
              requested: String(plan.requestedRevision),
              path: outcome.path,
            })
          : format(snapshotText('exportSaved'), { path: outcome.path }));
      return;
    }
    if (outcome.status === 'failed') {
      toast('error', format(snapshotText('exportFailed'), { message: outcome.message }));
      return;
    }
    toast('info', snapshotText('exportCanceled'));
  } catch (err) {
    if (!isSessionCurrent(captured)) {
      return;
    }
    toast('error', format(snapshotText('exportFailed'), {
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * 查看所选版本内容：比较模式下打开选中候选的实际节点（右端优先），
 * 历史详情模式打开实际节点 URL@实际 revision（文本内嵌/二进制外部打开）。
 */
async function viewHistoryRevision(captured: CapturedSession): Promise<void> {
  const context = captured.model.context;
  if (context === undefined) {
    return;
  }
  const compare = compareState;
  let url: string | undefined;
  let revision: number | undefined;
  let relativePath = context.target.relativePath;
  if (compare !== undefined) {
    const candidate = selectedSnapshotCandidate(compare);
    const side = candidate === undefined ? undefined : snapshotCandidateProbeSide(candidate);
    url = side?.url;
    revision = side?.revision;
    if (candidate !== undefined) {
      relativePath = candidate.displayPath;
    }
  } else {
    const target = detailActionTarget();
    url = target?.url;
    revision = target?.actualRevision ?? target?.revision;
    relativePath = target?.repositoryPath ?? relativePath;
  }
  if (url === undefined || revision === undefined) {
    toast('info', snapshotText('stateNotFoundAtRevision'));
    return;
  }
  const outcome = await openSnapshotNodeContent(
    readSvnPath(),
    {
      repositoryUuid: context.repositoryUuid,
      repositoryRootUrl: context.target.repositoryRootUrl,
      rawUrl: url,
      relativePath,
      snapshotRevision: revision,
      lastChangedRevision: revision,
      kind: 'file',
    },
    revision,
    historyRunOptions(context.target.repositoryRootUrl),
  );
  if (!isSessionCurrent(captured)) {
    return;
  }
  switch (outcome.status) {
    case 'openedText':
    case 'openedExternal':
      return;
    case 'externalOpenFailed':
      toast('error', format(snapshotText('exportFailed'), { message: outcome.filePath }));
      return;
    case 'tooLarge':
      toast('error', snapshotText('tooLarge'));
      return;
    case 'insufficientDisk':
      toast('error', outcome.message);
      return;
    default:
      toast('error', outcome.status === 'notFound' || outcome.status === 'error'
        ? outcome.error.message
        : String(outcome));
  }
}

/** 本地目标相对工作副本根的 POSIX 路径（'.' 表示副本根本身）。 */
function relativePathWithin(wcRoot: string, targetPath: string): string {
  const rel = relative(wcRoot, targetPath);
  return rel === '' ? '.' : rel.split(sep).join('/');
}

/** P6→P3：把实际目录 URL 与明确 revision 交给检出面板预填（不执行 checkout）。 */
async function checkoutHistoryDirectory(captured: CapturedSession): Promise<void> {
  const context = captured.model.context;
  const target = detailActionTarget();
  if (context === undefined || target === undefined) {
    return;
  }
  const url = target.url;
  const revision = target.actualRevision ?? target.revision;
  if (url === undefined || context.target.kind !== 'dir') {
    toast('info', snapshotText('handoffKindNotDir'));
    return;
  }
  const result = await openCheckoutPanelFromHistory({
    sourceUrl: url,
    pinnedRevision: revision,
    nodeKind: 'dir',
  });
  if (!isSessionCurrent(captured)) {
    return;
  }
  if (!result.ok) {
    toast('error', result.message);
    return;
  }
  toast('info', snapshotText('handoffOpened'));
}

/** 本地工作副本当前变化与 BASE 比较（目录逐项复用单文件 BASE diff）。 */
async function compareBase(captured: CapturedSession): Promise<void> {
  const context = captured.model.context;
  if (context === undefined || entryTarget?.source !== 'local') {
    toast('info', historyText('detailActionDisabledNotLocal'));
    return;
  }
  const wcRoot = entryTarget.wcRoot;
  const localPath = context.localPath ?? wcRoot;
  const relative = relativePathWithin(wcRoot, localPath);
  const plan = await planSnapshotBaseCompare(
    readSvnPath(),
    { wcRoot, relPath: relative, kind: context.target.kind },
    historyRunOptions(context.target.repositoryRootUrl),
  );
  if (!isSessionCurrent(captured)) {
    return;
  }
  if (plan.status === 'error') {
    toast('error', format(snapshotText('baseCompareFailed'), { message: plan.message }));
    return;
  }
  if (plan.status === 'unchanged') {
    toast('info', snapshotText('baseNoChanges'));
    return;
  }
  for (const entry of plan.entries) {
    const diffTarget: DiffTarget = {
      svnPath: readSvnPath(),
      wcRoot,
      relPath: entry.relPath,
      wcStatus: entry.wcStatus,
      ...(entry.props !== undefined ? { props: entry.props } : {}),
      ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
    };
    const outcome = await openSnapshotBaseCompareEntry(readSvnPath(), wcRoot, entry);
    if (!isSessionCurrent(captured)) {
      return;
    }
    const notice = diffOutcomeNotice(outcome, diffTarget);
    if (notice !== undefined) {
      toast('error', notice);
    }
  }
}

/* ------------------------- 意图分发 ------------------------- */

async function onIntent(intent: Intent, context: { sessionId: string; busy: boolean }): Promise<void> {
  if (handle === undefined || handle.sessionId !== context.sessionId) {
    return;
  }
  const captured = captureSession();
  if (captured === undefined) {
    return;
  }
  switch (intent.kind) {
    case 'loadMoreHistory': {
      // 加载中禁止重复请求（模型相位 + host 请求去重双重保证）。
      if (!captured.model.hasSession() || captured.model.isLoading()) {
        return;
      }
      if (captured.model.sessionView().upperRevision === null) {
        return;
      }
      await runLoad(captured);
      return;
    }
    case 'setHistoryFilter': {
      if (!captured.model.hasSession() || captured.model.sessionView().upperRevision === null) {
        return;
      }
      const result = captured.model.setFilter(intent.id, intent.value);
      if (!result.changed) {
        return;
      }
      if (result.rebuild) {
        resetCompareState();
        loadController?.abort();
        const next = advanceTicket();
        push();
        if (next !== undefined) {
          await runLoad(next);
        }
        return;
      }
      pushIfCurrent(captured);
      return;
    }
    case 'setFilter': {
      // 比较候选表的路径筛选：只重算宿主切片，不重新请求 SVN。
      const compare = compareState;
      if (compare === undefined || compare.phase !== 'ready' || intent.filterId !== 'path') {
        return;
      }
      compareState = setSnapshotCompareFilter(compare, intent.value);
      pushIfCurrent(captured);
      return;
    }
    case 'setPage': {
      const compare = compareState;
      if (compare === undefined || compare.phase !== 'ready') {
        return;
      }
      compareState = setSnapshotComparePage(compare, intent.page);
      pushIfCurrent(captured);
      return;
    }
    case 'setSort': {
      const compare = compareState;
      if (compare === undefined || compare.phase !== 'ready') {
        return;
      }
      compareState = sortCompareCandidates(compare, intent.key, intent.direction);
      compareSort = { key: intent.key, direction: intent.direction };
      pushIfCurrent(captured);
      return;
    }
    case 'clearHistoryFilters': {
      if (!captured.model.hasSession() || captured.model.sessionView().upperRevision === null) {
        return;
      }
      if (!captured.model.clearFilters().changed) {
        return;
      }
      pushIfCurrent(captured);
      return;
    }
    case 'selectHistoryRevision': {
      const request = captured.model.selectRevision(intent.id);
      if (request === undefined) {
        return;
      }
      pushIfCurrent(captured);
      await resolveDetail(captured, request);
      return;
    }
    case 'toggleHistoryRevision': {
      const result = captured.model.toggleRevision(intent.id);
      if (result === 'limit') {
        toast('info', historyText('selectionLimit'));
        return;
      }
      if (result === 'toggled') {
        pushIfCurrent(captured);
      }
      return;
    }
    case 'compareHistoryRevisions': {
      const pair = captured.model.selectedPair();
      await runComparison(captured, 'selected', pair === undefined ? undefined : [pair.a, pair.b]);
      return;
    }
    case 'comparePreviousVisible': {
      const pair = captured.model.previousVisiblePair();
      await runComparison(captured, 'previous-visible', pair === undefined ? undefined : [pair.newer, pair.older]);
      return;
    }
    case 'selectCompareCandidate': {
      await selectCompareCandidate(captured, intent.id);
      return;
    }
    case 'openHistoryDiff': {
      await openCandidateDiff(captured);
      return;
    }
    case 'exportHistoryVersion': {
      await exportHistoryVersion(captured);
      return;
    }
    case 'viewHistoryRevision': {
      await viewHistoryRevision(captured);
      return;
    }
    case 'checkoutHistoryDirectory': {
      await checkoutHistoryDirectory(captured);
      return;
    }
    case 'compareBase': {
      await compareBase(captured);
      return;
    }
    case 'copyHistoryText': {
      await copyHistoryText(captured, intent.copyKind, intent.id);
      return;
    }
    case 'resetHistorySession': {
      // busy/writeLocked 已由 P6 放行表与 refresh 同组拒绝；模型层再拒 unresolved。
      const result = captured.model.reset();
      if (result === 'rejected') {
        toast('info', strings.historyPanel.resetRejected);
        return;
      }
      resetCompareState();
      loadController?.abort();
      const next = advanceTicket();
      push();
      if (next !== undefined) {
        await runLoad(next);
      }
      return;
    }
    case 'refreshHistoryUpper': {
      const check = captured.model.checkUpperRefresh(intent.mode);
      if (!check.ok) {
        toast('info', rejectText(check, intent.mode));
        return;
      }
      resetCompareState();
      if (check.mode === 'head') {
        await refreshHead(captured);
      } else {
        await refreshBaseFallback(captured);
      }
      return;
    }
    case 'bannerAction': {
      if (intent.actionId === 'historyRetry') {
        // 打开失败（error 相位）与 HEAD 未解析（unresolved）的重试都重新
        // 解析 HEAD/存在性；其余情况重试当前会话的加载。
        if (captured.model.phase === 'error'
          || captured.model.sessionView().upperRevision === null) {
          await rerunOpen(captured);
        } else if (captured.model.hasSession()) {
          await runLoad(captured);
        }
        return;
      }
      if (intent.actionId === 'historyBaseFallback') {
        const check = captured.model.checkUpperRefresh('base-fallback');
        if (!check.ok) {
          toast('info', rejectText(check, 'base-fallback'));
          return;
        }
        resetCompareState();
        await refreshBaseFallback(captured);
        return;
      }
      if (intent.actionId === 'historyCompareClose') {
        closeCompare(captured);
        return;
      }
      return;
    }
    case 'dismissBanner': {
      if (intent.bannerId === 'historyRound') {
        captured.model.dismissRoundBanner();
      } else {
        captured.model.dismissNotice(intent.bannerId);
      }
      pushIfCurrent(captured);
      return;
    }
    case 'refresh': {
      // 页脚默认刷新（错误态重试）：重走 HEAD/存在性/首批解析。
      await rerunOpen(captured);
      return;
    }
    case 'closePanel': {
      handle?.dispose();
      return;
    }
    default:
      // 追溯（阶段 4）与更新（阶段 6）尚未接线：给出明确提示，不静默吞掉
      // 用户动作；其余未登记动作沿用协议层白名单拒绝。
      if (intent.kind === 'blameHistoryRevision' || intent.kind === 'updateToHistoryRevision') {
        toast('info', historyText('actionNotReady'));
      }
      return;
  }
}

/** 重新走打开流程（错误态重试；不切换目标、不换会话代次）。 */
async function rerunOpen(captured: CapturedSession): Promise<void> {
  const context = captured.model.context;
  if (context === undefined) {
    return;
  }
  loadController?.abort();
  detailController?.abort();
  resetCompareState();
  captured.model.beginOpen(context);
  const next = advanceTicket();
  push();
  if (next !== undefined) {
    await openFresh(next);
  }
}

function onViewReady(): void {
  push();
}

function onPanelDispose(): void {
  cancelAllInflight();
  resetCompareState();
  handle = undefined;
  model = undefined;
  entryTarget = undefined;
  sessionTicket = undefined;
}

/* ------------------------- 在途请求清理 ------------------------- */

function cancelAllInflight(): void {
  loadController?.abort();
  loadController = undefined;
  detailController?.abort();
  detailController = undefined;
}

/* ------------------------- 测试辅助 ------------------------- */

/** 当前会话快照（测试断言用；真实宿主不需要）。 */
export function historySessionSnapshot(): {
  source?: 'local' | 'handoff';
  phase?: HistoryPhase;
  upperRevision?: number | null;
  upperSource?: string;
  headState?: string;
  loadedMatchedCount?: number;
  visibleMatched?: number;
  displayedCount?: number;
  scannedUniqueRevisions?: number;
  selection: number[];
  filter?: HistoryFilter;
  hasLoadedData?: boolean;
} {
  const context = model?.context;
  const session = model?.sessionView();
  return {
    ...(context !== undefined ? { source: context.source } : {}),
    ...(model !== undefined ? { phase: model.phase } : {}),
    ...(session !== undefined
      ? {
          upperRevision: session.upperRevision,
          upperSource: session.upperSource,
          headState: session.headState,
          loadedMatchedCount: session.loadedMatchedCount,
          visibleMatched: session.visibleMatched,
          displayedCount: session.displayedCount,
          scannedUniqueRevisions: session.scannedUniqueRevisions,
        }
      : {}),
    selection: model?.selectedRevisions() ?? [],
    ...(model !== undefined ? { filter: model.currentFilter() } : {}),
    ...(model !== undefined ? { hasLoadedData: model.hasLoadedData() } : {}),
  };
}

/** 当前模型实例（测试断言详情/作者等用；真实宿主不需要）。 */
export function historyModelForTest(): HistoryModel | undefined {
  return model;
}

/** 当前比较结果状态（测试断言候选/选中/筛选用；真实宿主不需要）。 */
export function historyCompareForTest(): {
  phase: string;
  leftRevision: number;
  rightRevision: number;
  candidates: number;
  selectedId: string | null;
  filterText: string;
  page: number;
  errorMessage: string | null;
} | undefined {
  if (compareState === undefined) {
    return undefined;
  }
  return {
    phase: compareState.phase,
    leftRevision: compareState.leftRevision,
    rightRevision: compareState.rightRevision,
    candidates: compareState.candidates.length,
    selectedId: compareState.selectedId,
    filterText: compareState.filterText,
    page: compareState.page,
    errorMessage: compareState.errorMessage,
  };
}

/** 测试辅助：重置面板控制器（清空会话与在途请求）。 */
export function resetHistoryPanelController(): void {
  cancelAllInflight();
  resetCompareState();
  handle?.dispose();
  handle = undefined;
  model = undefined;
  entryTarget = undefined;
  sessionTicket = undefined;
  panelContext = undefined;
  comparisonRunner = undefined;
}
