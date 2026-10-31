/**
 * P1 提交面板控制器：宿主侧业务决策（读写 SVN、确认对话框、历史存储）。
 *
 * 数据流：命令入口 → 复用/切换面板会话 → 读取本地（和可选的远端）状态 →
 * commitModel 构建渲染态 → host 推送。意图只带条目 ID（即原始路径），
 * 路径映射、能力判断、范围确认与提交执行全部在这里。
 *
 * 提交口径（保留 M1 + 交互清单）：
 * - allowEmptyCommitMessage 开关、空说明二次确认；
 * - missing 确认后先 svn delete --force 再提交，失败保留登记；
 * - 未版本控制勾选仅记录意图，确认提交才 add（目录 --depth empty，
 *   只登记勾选子项与必要父目录，忽略项不加入、链接不跟随）；
 * - 提交前远端检查（三选模态）与冲突阻止；
 * - >100 项按 COMMIT_BATCH_SIZE 拆批，每批 revision 即时记录（操作注册表
 *   落盘），结果区分成功/部分成功/失败/成功后刷新失败；进程级失败
 *   （超时/取消/启动失败）进入结果未知，冻结全部写意图只允许核实。
 */
import * as vscode from 'vscode';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { matchesIgnoreRules, parseIgnoreRules } from '../../../core/ignore';
import { buildCommitArgs, COMMIT_BATCH_SIZE, parseCommitOutput } from '../../../core/commit';
import { buildDeleteArgs, buildRevertArgs, listVersionedSubtree } from '../../../core/dailyOps';
import { runStatus } from '../../../core/status';
import { remoteChangedEntries, runRemoteStatus, type RemoteStatusResult } from '../../../core/remoteStatus';
import { runOrThrow, type RunOptions } from '../../../core/svnCli';
import { SvnError } from '../../../core/errors';
import { escapePeg } from '../../../core/workspace';
import { getOperationRegistry, type OperationRegistry } from '../../../core/operations';
import {
  readAllowEmptyCommitMessage,
  readRemoteCheckBeforeCommit,
  readSvnPath,
  readTimeoutMs,
} from '../../config';
import { format, strings } from '../../i18n';
import { logCommand, logExitCode, logLine, showOutput } from '../../output';
import { promptForCredentials } from '../../auth';
import { confirmModal } from '../../ui/confirm';
import { resolveWorkingCopyTarget, type WcTarget } from '../../commands/target';
import { performUpdate } from '../../commands/update';
import { writeStatusReport } from '../../commands/statusReport';
import { diffOutcomeNotice, openEntryDiff, type DiffTarget } from '../../diffView';
import { createPanel, type PanelHandle } from '../host';
import type { Intent } from '../protocol';
import type { PanelState } from '../state';
import {
  applyDirectoryLinkage,
  applyPrefixToMessage,
  buildPanelState,
  defaultSelectedPaths,
  entryMatchesFilters,
  isSelectableEntry,
  mergeStatusEntries,
  selectionKeyOf,
  sessionChanged,
  visibleMetas,
  type CommitEntryMeta,
  type CommitSessionState,
} from '../commitModel';

const execFileAsync = promisify(execFile);

const PANEL_ID = 'commit';
const HISTORY_KEY = 'svnAnywhere.commitHistory';
const PREFIX_KEY = 'svnAnywhere.commitPrefixes';
const MAX_PREFIXES = 10;
const MAX_HISTORY = 20;
/** 未版本控制目录递归枚举的防御上限（超出部分不进面板，避免巨型目录卡死）。 */
const UNVERSIONED_ENUM_LIMIT = 500;
/** 删除目录确认框中影响子树的最大列举条数。 */
const SUBTREE_LIST_LIMIT = 50;

interface PanelContext {
  extensionUri: vscode.Uri;
  subscriptions: vscode.Disposable[];
  globalState: vscode.Memento;
}

let panelContext: PanelContext | undefined;
let handle: PanelHandle | undefined;
let session: CommitSessionState | undefined;
let formRevision = 0;
/** 当次提交在途的操作登记；结果未知期间保留供核实。 */
let activeOperationId: string | undefined;
/** 提交前远端检查看到的 HEAD（against），核实结果未知时作对照。 */
let commitBaseAgainst: number | undefined;

/** activate 时注入宿主上下文（extensionUri / subscriptions / globalState）。 */
export function setCommitPanelContext(context: PanelContext): void {
  panelContext = context;
}

/* ------------------------------ 命令入口 ------------------------------ */

/** 会话是否处于不可打断的操作阶段（读取/检查/提交/未知冻结）。 */
function sessionBusy(): boolean {
  if (!session) {
    return false;
  }
  return ['loading', 'refreshing', 'checking', 'committing', 'unknown'].includes(session.phase);
}

/** 「提交」命令：打开 P1 面板；同目标复用，新目标切换会话，忙碌时拒绝。 */
export async function commandShowCommitPanel(uri?: vscode.Uri): Promise<void> {
  const target = await resolveWorkingCopyTarget(uri, strings.command.commit);
  if (!target || !panelContext) {
    return;
  }
  const sameTarget =
    session?.wcRoot === target.wcRoot && session?.targetPath === target.targetPath;
  if (handle && sameTarget && session) {
    // 同目标复用：reveal 并重读状态（保留说明与仍有效的勾选），
    // 保证命令入口与面板入口看到同一份工作副本实际状态。
    handle.reveal();
    if (!sessionBusy()) {
      await loadSession(handle.sessionId, target, { initial: false });
    }
    return;
  }
  if (handle && !sameTarget && !handle.switchSession()) {
    void vscode.window.showWarningMessage(
      format(strings.panel.panelBusySwitchRejected, { target: target.targetPath }),
    );
    return;
  }
  handle ??= createPanel(
    PANEL_ID,
    { title: strings.panel.commitPanelTitle, retainContextWhenHidden: true },
    { onIntent, onDispose: onPanelDispose },
    panelContext,
  );
  await loadSession(handle.sessionId, target, { initial: true });
}

function onPanelDispose(): void {
  handle = undefined;
  session = undefined;
  activeOperationId = undefined;
}

/* ------------------------------ 会话读取 ------------------------------ */

function runOptions(cwd: string): RunOptions {
  return { cwd, timeoutMs: readTimeoutMs(), onExit: logExitCode };
}

function metaByPath(path: string): CommitEntryMeta | undefined {
  return session?.metas.find((meta) => meta.path === path);
}

/** loadSession 世代号：并发交错时只有最新一次加载有权写 session 与推帧。 */
let loadSessionGeneration = 0;

/** 读取目标状态（含可选远端分组与未版本控制目录枚举）并推送渲染。 */
async function loadSession(
  sessionId: string,
  target: WcTarget,
  options: { initial: boolean },
): Promise<void> {
  // 入口立即校验会话：调用点求值（sessionId/target）与真正执行之间可能
  // 跨过一次目标切换，旧会话的迟到重读在覆盖 session 前直接放弃。
  if (handle && handle.sessionId !== sessionId) {
    return;
  }
  // 世代化：同副本的重复重读与目标切换的加载可能并发交错，先进入者
  // 在 await 恢复点发现自己已被更新的一次加载取代时立即放弃，不再
  // 覆盖 session（否则旧目标的迟到数据会写进新会话）。
  const generation = ++loadSessionGeneration;
  const isStale = () =>
    generation !== loadSessionGeneration || handle?.sessionId !== sessionId;
  // 会话/目标切换后旧的对照基准失效，防止跨副本残留脏值。
  commitBaseAgainst = undefined;
  const keepDraft = !options.initial && session !== undefined;
  const previous = session;
  const svnPath = readSvnPath();
  const targetArg = relative(target.wcRoot, target.targetPath) || '.';

  // 操作注册表限制（unknown/待协调）跨面板保持：受限时进入写锁定会话。
  const restriction = getOperationRegistry().writeRestriction(target.wcRoot);

  const prefixes = await loadPrefixes();
  const history = await loadHistory(target.wcRoot);
  if (isStale()) {
    return;
  }
  session = {
    sessionId,
    wcRoot: target.wcRoot,
    targetPath: target.targetPath,
    targetArg,
    metas: [],
    selectedPaths: new Set(),
    viewMode: keepDraft ? (previous?.viewMode ?? 'tree') : 'tree',
    filters: keepDraft ? { ...(previous?.filters ?? allFilters()) } : allFilters(),
    message: keepDraft ? (previous?.message ?? '') : '',
    allowEmpty: readAllowEmptyCommitMessage(),
    prefixes,
    history,
    phase: 'loading',
    error: null,
    result: null,
    addedPrepared: keepDraft ? (previous?.addedPrepared ?? []) : [],
    missingPrepared: keepDraft ? (previous?.missingPrepared ?? []) : [],
    initialMessage: keepDraft ? (previous?.initialMessage ?? '') : '',
    initialSelectionKey: keepDraft ? (previous?.initialSelectionKey ?? '') : '',
    remoteIncluded: readRemoteCheckBeforeCommit(),
    externalPrefixes: keepDraft ? (previous?.externalPrefixes ?? []) : [],
  };
  if (restriction) {
    session.phase = 'unknown';
    activeOperationId = restriction.operationId;
  }
  pushRender();

  try {
    logCommand(svnPath, ['status', '--xml', targetArg], target.wcRoot);
    const status = await runStatus(svnPath, targetArg, runOptions(target.wcRoot));
    if (isStale()) {
      return;
    }
    let remote: RemoteStatusResult | undefined;
    if (session.remoteIncluded) {
      remote = await runRemoteStatusWithAuth(svnPath, targetArg, target);
      if (isStale()) {
        return;
      }
    }
    session.externalPrefixes = status.externals ?? [];
    const metas = mergeStatusEntries(status.entries, remote?.entries, session.externalPrefixes);
    enrichMetas(metas, target.wcRoot);
    if (restriction) {
      // 结果未知恢复：不重置选择（核实流程读取实际状态判断）。
      session.metas = metas;
      session.selectedPaths = previous?.selectedPaths
        ? new Set([...previous.selectedPaths].filter((path) => metas.some((meta) => meta.path === path)))
        : new Set();
      pushRender();
      return;
    }
    const retained = keepDraft && previous
      ? new Set([...previous.selectedPaths].filter((path) => metas.some((meta) => meta.path === path)))
      : undefined;
    session.metas = metas;
    session.selectedPaths = retained ? applyDirectoryLinkage(metas, retained) : defaultSelectedPaths(metas);
    session.phase = 'ready';
    session.error = null;
    if (!keepDraft) {
      session.initialMessage = session.message;
      session.initialSelectionKey = selectionKeyOf(session.selectedPaths);
    }
    pushRender();
  } catch (err) {
    if (isStale()) {
      return;
    }
    session.phase = 'loadError';
    session.error = err instanceof Error ? err.message : String(err);
    pushRender();
  }
}

function allFilters(): CommitSessionState['filters'] {
  return { status: 'all', ext: 'all', changelist: 'all' };
}

async function runRemoteStatusWithAuth(
  svnPath: string,
  targetArg: string,
  target: WcTarget,
): Promise<RemoteStatusResult> {
  logCommand(svnPath, ['status', '-u', '--non-interactive', '--xml', targetArg], target.wcRoot);
  return runRemoteStatus(svnPath, targetArg, {
    ...runOptions(target.wcRoot),
    getCredentials: promptForCredentials,
    onCredentialRetry: (args) => logCommand(svnPath, args, target.wcRoot),
  });
}

/**
 * 元信息补齐（真实磁盘枚举）：
 * - 符号链接标记为叶节点（不跟随）；
 * - 嵌套工作副本（unversioned 且其下有 .svn）按副本边界隔离、不可勾选；
 * - svn status 不进入未版本控制目录，这里递归枚举其子项（忽略项按该目录
 *   的 svn:ignore 规则排除；嵌套副本目录整棵隔离不再展开）。
 */
function enrichMetas(metas: CommitEntryMeta[], wcRoot: string): void {
  const svnPath = readSvnPath();
  const queue = [...metas];
  let enumerated = 0;
  while (queue.length > 0) {
    const meta = queue.shift();
    if (!meta) {
      break;
    }
    const abs = join(wcRoot, meta.path);
    if (meta.path !== '.' && existsSync(abs)) {
      try {
        const stat = lstatSync(abs);
        if (stat.isSymbolicLink()) {
          meta.isSymlink = true;
          continue;
        }
        if (stat.isDirectory()) {
          meta.kind = 'dir';
          meta.isNestedWc = existsSync(join(abs, '.svn'));
        }
      } catch {
        // 磁盘访问失败（权限等）：保持 status 元信息，不阻塞面板。
      }
    }
    if (meta.group !== 'unversioned' || meta.kind !== 'dir' || meta.isNestedWc) {
      continue;
    }
    if (enumerated >= UNVERSIONED_ENUM_LIMIT) {
      continue;
    }
    // 未版本控制目录：枚举真实子项（svn status 不会进入）。
    let names: string[] = [];
    try {
      names = readdirSync(abs);
    } catch {
      continue;
    }
    let rules: string[] = [];
    try {
      rules = readIgnoreRulesSync(svnPath, meta.path, wcRoot);
    } catch {
      rules = [];
    }
    for (const name of names) {
      if (name === '.svn') {
        continue;
      }
      if (matchesIgnoreRules(name, rules)) {
        continue;
      }
      const childPath = meta.path === '.' ? name : `${meta.path}/${name}`;
      if (metas.some((existing) => existing.path === childPath) || enumerated >= UNVERSIONED_ENUM_LIMIT) {
        continue;
      }
      let childKind: 'file' | 'dir' = 'file';
      let childSymlink = false;
      let childNestedWc = false;
      try {
        const childStat = lstatSync(join(wcRoot, childPath));
        childSymlink = childStat.isSymbolicLink();
        if (childStat.isDirectory() && !childSymlink) {
          childKind = 'dir';
          childNestedWc = existsSync(join(wcRoot, childPath, '.svn'));
        }
      } catch {
        // 保留 file 兜底。
      }
      const child: CommitEntryMeta = {
        path: childPath,
        wcStatus: 'unversioned',
        kind: childKind,
        props: 'none',
        changelist: null,
        group: 'unversioned',
        isSymlink: childSymlink,
        isNestedWc: childNestedWc,
      };
      metas.push(child);
      queue.push(child);
      enumerated += 1;
    }
  }
}

/** 同步读 svn:ignore（enrichMetas 是同步路径，用子进程一次读取）。 */
function readIgnoreRulesSync(svnPath: string, dirPath: string, wcRoot: string): string[] {
  try {
    const out = execFileSync(svnPath, ['propget', 'svn:ignore', '--', escapePeg(dirPath)], {
      cwd: wcRoot,
      encoding: 'utf8',
      env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
    });
    return parseIgnoreRules(out);
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err);
    // 属性不存在（W200017）与目标未纳管（E200005）都按空规则处理。
    if (stderr.includes('W200017') || stderr.includes('E200005')) {
      return [];
    }
    throw err;
  }
}

/* ------------------------------ 渲染推送 ------------------------------ */

function pushRender(): void {
  if (!session || !handle) {
    return;
  }
  const state: PanelState = buildPanelState(session);
  handle.update({ ...state, formRevision }, handle.sessionId);
}

/* ------------------------------ 意图分发 ------------------------------ */

async function onIntent(intent: Intent, context: { sessionId: string; busy: boolean }): Promise<void> {
  if (!handle || !session || handle.sessionId !== context.sessionId) {
    return;
  }
  switch (intent.kind) {
    case 'refresh':
      await loadSession(context.sessionId, targetOf(session), { initial: false });
      return;
    case 'setFilter': {
      if (intent.filterId in session.filters) {
        (session.filters as Record<string, string>)[intent.filterId] = intent.value;
        pushRender();
      }
      return;
    }
    case 'clearFilters':
      session.filters = allFilters();
      pushRender();
      return;
    case 'toggleRow': {
      const meta = metaByPath(intent.rowId);
      if (!meta || !isSelectableEntry(meta)) {
        pushRender();
        return;
      }
      if (intent.selected) {
        session.selectedPaths.add(meta.path);
      } else {
        session.selectedPaths.delete(meta.path);
      }
      session.selectedPaths = applyDirectoryLinkage(session.metas, session.selectedPaths);
      pushRender();
      return;
    }
    case 'toggleGroup': {
      for (const meta of visibleMetas(session)) {
        if (meta.group === intent.groupId && isSelectableEntry(meta)) {
          if (intent.selected) {
            session.selectedPaths.add(meta.path);
          } else {
            session.selectedPaths.delete(meta.path);
          }
        }
      }
      session.selectedPaths = applyDirectoryLinkage(session.metas, session.selectedPaths);
      pushRender();
      return;
    }
    case 'toggleTree': {
      const prefix = intent.nodeId.split('|').slice(1).join('|');
      for (const meta of session.metas) {
        const inSubtree = meta.path === prefix || meta.path.startsWith(`${prefix}/`);
        if (inSubtree && entryMatchesFilters(meta, session.filters) && isSelectableEntry(meta)) {
          if (intent.selected) {
            session.selectedPaths.add(meta.path);
          } else {
            session.selectedPaths.delete(meta.path);
          }
        }
      }
      session.selectedPaths = applyDirectoryLinkage(session.metas, session.selectedPaths);
      pushRender();
      return;
    }
    case 'setView':
      session.viewMode = intent.view;
      pushRender();
      return;
    case 'selectVisible':
      for (const meta of visibleMetas(session)) {
        if (isSelectableEntry(meta)) {
          session.selectedPaths.add(meta.path);
        }
      }
      session.selectedPaths = applyDirectoryLinkage(session.metas, session.selectedPaths);
      pushRender();
      return;
    case 'clearSelection':
      session.selectedPaths = new Set();
      pushRender();
      return;
    case 'selectChangelist': {
      const name = session.filters.changelist.startsWith('name:')
        ? session.filters.changelist.slice('name:'.length)
        : undefined;
      if (name === undefined) {
        return;
      }
      const next = new Set<string>();
      for (const meta of session.metas) {
        if (isSelectableEntry(meta) && meta.changelist === name) {
          next.add(meta.path);
        }
      }
      session.selectedPaths = applyDirectoryLinkage(session.metas, next);
      session.filters = allFilters();
      handle.toast('info', strings.panel.selectChangelistNotice);
      pushRender();
      return;
    }
    case 'syncInput':
      if (intent.fieldId === 'message') {
        // 输入序号防回退：宿主确认后递增 formRevision。
        if (intent.inputRevision >= 0) {
          formRevision = Math.max(formRevision, intent.inputRevision);
        }
        session.message = intent.value;
      }
      return;
    case 'applyPrefix': {
      const prefix = session.prefixes[intent.index];
      if (prefix !== undefined) {
        session.message = applyPrefixToMessage(session.message, session.prefixes, prefix);
        pushRender();
      }
      return;
    }
    case 'managePrefixes':
      await managePrefixes();
      return;
    case 'applyHistory': {
      const value = session.history[intent.index];
      if (value !== undefined) {
        await applyHistoryMessage(value);
      }
      return;
    }
    case 'showHistory':
      await showHistoryPicker();
      return;
    case 'openDiff': {
      const meta = metaByPath(intent.itemId);
      if (!meta) {
        return;
      }
      const diffTarget: DiffTarget = {
        svnPath: readSvnPath(),
        wcRoot: session.wcRoot,
        relPath: meta.path,
        wcStatus: meta.wcStatus,
        props: meta.props,
        kind: meta.kind,
      };
      const outcome = await openEntryDiff(diffTarget);
      const notice = diffOutcomeNotice(outcome, diffTarget);
      if (notice) {
        handle.toast('info', notice);
      }
      return;
    }
    case 'openFile': {
      const meta = metaByPath(intent.itemId);
      if (!meta || meta.wcStatus === 'deleted' || meta.wcStatus === 'missing') {
        return;
      }
      await vscode.commands.executeCommand(
        'vscode.open',
        vscode.Uri.file(join(session.wcRoot, meta.path)),
        { preview: false },
      );
      return;
    }
    case 'rowMore':
      await rowMoreActions(intent.itemId);
      return;
    case 'submit':
      await performCommit(context.sessionId);
      return;
    case 'closePanel':
      await closePanel();
      return;
    case 'resolveUnknown':
      await resolveUnknown(context.sessionId);
      return;
    case 'dismissBanner':
    case 'bannerAction':
      if (intent.kind === 'bannerAction' && intent.actionId === 'refresh') {
        await loadSession(context.sessionId, targetOf(session), { initial: false });
        return;
      }
      pushRender();
      return;
  }
}

function targetOf(current: CommitSessionState): WcTarget {
  return { wcRoot: current.wcRoot, targetPath: current.targetPath };
}

/* --------------------------- 前缀与历史存储 --------------------------- */

async function loadPrefixes(): Promise<string[]> {
  const raw = panelContext?.globalState.get<unknown>(PREFIX_KEY);
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string').slice(0, MAX_PREFIXES) : [];
}

async function loadHistory(wcRoot: string): Promise<string[]> {
  const all = panelContext?.globalState.get<Record<string, unknown>>(HISTORY_KEY, {});
  const raw = all?.[wcRoot];
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string').slice(0, MAX_HISTORY) : [];
}

async function saveHistory(wcRoot: string, history: string[]): Promise<void> {
  const all = panelContext?.globalState.get<Record<string, unknown>>(HISTORY_KEY, {}) ?? {};
  await panelContext?.globalState.update(HISTORY_KEY, { ...all, [wcRoot]: history.slice(0, MAX_HISTORY) });
}

async function managePrefixes(): Promise<void> {
  if (!session) {
    return;
  }
  const value = await vscode.window.showInputBox({
    prompt: format(strings.panel.prefixAddPrompt, { max: String(MAX_PREFIXES) }),
  });
  if (value === undefined || value.trim() === '') {
    return;
  }
  const prefix = value.trim();
  session.prefixes = [prefix, ...session.prefixes.filter((item) => item !== prefix)].slice(0, MAX_PREFIXES);
  await panelContext?.globalState.update(PREFIX_KEY, session.prefixes);
  pushRender();
}

async function showHistoryPicker(): Promise<void> {
  if (!session) {
    return;
  }
  if (session.history.length === 0) {
    handle?.toast('info', strings.panel.historyEmpty);
    return;
  }
  const items = session.history.map((message, index) => ({
    label: message.split('\n')[0] ?? message,
    description: message.includes('\n') ? '…' : '',
    detail: message,
    index,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: format(strings.panel.historyPlaceholder, { max: String(MAX_HISTORY) }),
    ignoreFocusOut: true,
  });
  if (!picked) {
    return;
  }
  await applyHistoryMessage(session.history[picked.index] ?? '');
}

async function applyHistoryMessage(value: string): Promise<void> {
  if (!session) {
    return;
  }
  if (session.message && session.message !== value) {
    const ok = await vscode.window.showWarningMessage(
      strings.panel.historyReplaceTitle,
      { modal: true, detail: strings.panel.historyReplaceDetail },
      strings.commit.continueButton,
    );
    if (ok !== strings.commit.continueButton) {
      return;
    }
  }
  session.message = value;
  formRevision += 1;
  pushRender();
}

/* ------------------------------ 行内操作 ------------------------------ */

async function rowMoreActions(itemId: string): Promise<void> {
  const meta = metaByPath(itemId);
  if (!session || !meta) {
    return;
  }
  const items: Array<{ label: string; action: string }> = [
    { label: strings.panel.actOpen, action: 'open' },
  ];
  if (meta.group === 'local' || meta.group === 'conflict') {
    items.push({ label: strings.panel.actRevert, action: 'revert' });
  }
  const deletable =
    meta.group !== 'remote' &&
    meta.group !== 'conflict' &&
    meta.wcStatus !== 'deleted' &&
    meta.wcStatus !== 'missing' &&
    !meta.isNestedWc;
  if (deletable) {
    items.push({
      label: meta.group === 'unversioned' ? strings.panel.actTrash : strings.panel.actDelete,
      action: meta.group === 'unversioned' ? 'trash' : 'delete',
    });
  }
  const picked = await vscode.window.showQuickPick(items.map((item) => ({ ...item })), {
    title: `${strings.panel.rowMoreMenuTitle} ${meta.path}`,
    ignoreFocusOut: true,
  });
  if (!picked) {
    return;
  }
  if (picked.action === 'open') {
    await onIntent({ kind: 'openFile', itemId }, { sessionId: handle?.sessionId ?? '', busy: false });
    return;
  }
  if (picked.action === 'revert') {
    await revertEntry(meta);
    return;
  }
  if (picked.action === 'delete') {
    await deleteEntry(meta);
    return;
  }
  if (picked.action === 'trash') {
    await trashEntry(meta);
  }
}

/**
 * 行内写操作（还原/删除/回收站）的注册表包裹：同一工作副本有在途或
 * 受限操作（提交中/结果未知/待协调）时拒绝；本操作执行期间登记互斥。
 */
async function beginInlineOperation(path: string, kind: 'file' | 'dir'): Promise<string | undefined> {
  const registry = getOperationRegistry();
  const held = registry.writeRestriction(session!.wcRoot);
  if (held) {
    handle?.toast('info', format(strings.panel.operationHeldBusy, { phase: held.phase }));
    return undefined;
  }
  const begin = await registry.begin({
    wcRoot: session!.wcRoot,
    targetRelPath: session!.targetArg,
    nodeKind: kind,
    explicitPaths: [path],
  });
  if (!begin.ok) {
    handle?.toast('info', format(strings.panel.operationHeldBusy, { phase: begin.heldBy.phase }));
    return undefined;
  }
  return begin.operationId;
}

async function finishInlineOperation(operationId: string | undefined): Promise<void> {
  await getOperationRegistry().finish(operationId);
}

/** 删除目录的影响子树清单（svn list -R 的版本控制条目，截断到上限）。 */
async function listDeletionSubtree(svnPath: string, dirPath: string): Promise<string[]> {
  logCommand(svnPath, ['list', '-R', '--', escapePeg(dirPath)], session!.wcRoot);
  // 子树枚举失败不阻塞删除确认：core 返回空清单，确认框仍列目录本身。
  return listVersionedSubtree(svnPath, session!.wcRoot, dirPath, runOptions(session!.wcRoot));
}

async function revertEntry(meta: CommitEntryMeta): Promise<void> {
  if (!session) {
    return;
  }
  const svnPath = readSvnPath();
  // 行内操作进行中面板不置 busy、可被切换目标：重读的目标与会话在操作
  // 开始时捕获，完成后核对会话未变再重读，避免旧目标数据写入新会话。
  const startedSessionId = handle?.sessionId;
  const startedTarget = targetOf(session);
  const impact =
    meta.kind === 'dir'
      ? `${strings.panel.revertConfirmDetail}\n${meta.path}\n${strings.panel.revertDirNote}`
      : `${strings.panel.revertConfirmDetail}\n${meta.path}`;
  const confirmed = await confirmModal(impact, strings.commit.continueButton);
  if (!confirmed) {
    return;
  }
  const operationId = await beginInlineOperation(meta.path, meta.kind);
  if (!operationId) {
    return;
  }
  // 行内还原不递归（只还原目录节点登记），整目录递归还原走右键「还原」命令。
  const args = buildRevertArgs(meta.path);
  logCommand(svnPath, args, session.wcRoot);
  try {
    await runOrThrow(svnPath, args, runOptions(session.wcRoot));
    handle?.toast('info', format(strings.panel.revertDoneNotice, { path: meta.path }));
  } catch (err) {
    showErrorBanner(err);
    return;
  } finally {
    await finishInlineOperation(operationId);
  }
  if (!handle || handle.sessionId !== startedSessionId) {
    return;
  }
  await loadSession(handle.sessionId, startedTarget, { initial: false });
}

async function deleteEntry(meta: CommitEntryMeta): Promise<void> {
  if (!session) {
    return;
  }
  const svnPath = readSvnPath();
  // 与 revertEntry 相同：会话与目标在操作开始时捕获，完成后核对再重读。
  const startedSessionId = handle?.sessionId;
  const startedTarget = targetOf(session);
  // 目录删除是结构性删除：确认框枚举完整影响子树（版本控制条目清单）。
  let subtree: string[] = [];
  if (meta.kind === 'dir') {
    subtree = await listDeletionSubtree(svnPath, meta.path);
  }
  const subtreeLines = subtree.length
    ? subtree.slice(0, SUBTREE_LIST_LIMIT).map((path) => `· ${meta.path}/${path}`).join('\n') +
      (subtree.length > SUBTREE_LIST_LIMIT
        ? `\n· ${format(strings.list.moreSuffix, { count: String(subtree.length) })}`
        : '')
    : '';
  const impact =
    meta.kind === 'dir'
      ? `${strings.panel.deleteConfirmDetail}\n${meta.path}\n${subtreeLines}\n${strings.panel.deleteDirNote}`
      : `${strings.panel.deleteConfirmDetail}\n${meta.path}`;
  const confirmed = await confirmModal(impact, strings.commit.continueButton);
  if (!confirmed) {
    return;
  }
  const operationId = await beginInlineOperation(meta.path, meta.kind);
  if (!operationId) {
    return;
  }
  const args = buildDeleteArgs(meta.path, { force: true });
  logCommand(svnPath, args, session.wcRoot);
  try {
    await runOrThrow(svnPath, args, runOptions(session.wcRoot));
    handle?.toast('info', format(strings.panel.deleteDoneNotice, { path: meta.path }));
  } catch (err) {
    showErrorBanner(err);
    return;
  } finally {
    await finishInlineOperation(operationId);
  }
  if (!handle || handle.sessionId !== startedSessionId) {
    return;
  }
  await loadSession(handle.sessionId, startedTarget, { initial: false });
}

/** 未版本控制删除：优先 /usr/bin/trash，失败回退 osascript 交 Finder 删除。 */
async function trashEntry(meta: CommitEntryMeta): Promise<void> {
  if (!session) {
    return;
  }
  // 与 revertEntry 相同：会话与目标在操作开始时捕获，完成后核对再重读。
  const startedSessionId = handle?.sessionId;
  const startedTarget = targetOf(session);
  const confirmed = await confirmModal(
    `${strings.panel.trashConfirmDetail}\n${meta.path}`,
    strings.commit.continueButton,
  );
  if (!confirmed) {
    return;
  }
  const operationId = await beginInlineOperation(meta.path, meta.kind);
  if (!operationId) {
    return;
  }
  const absPath = join(startedTarget.wcRoot, meta.path);
  const ok = await moveToTrash(absPath);
  if (!ok) {
    handle?.toast('error', format(strings.panel.trashFailedNotice, { message: absPath }));
    await finishInlineOperation(operationId);
    return;
  }
  handle?.toast('info', format(strings.panel.trashDoneNotice, { path: meta.path }));
  await finishInlineOperation(operationId);
  if (!handle || handle.sessionId !== startedSessionId) {
    return;
  }
  await loadSession(handle.sessionId, startedTarget, { initial: false });
}

async function moveToTrash(absPath: string): Promise<boolean> {
  try {
    await execFileAsync('/usr/bin/trash', [absPath]);
    return true;
  } catch {
    // 回退：交 Finder 删除（进回收站）；路径里的引号与反斜杠做 AppleScript 转义。
    const escaped = absPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    try {
      await execFileAsync('osascript', ['-e', `tell application "Finder" to delete (POSIX file "${escaped}")`]);
      return true;
    } catch {
      return false;
    }
  }
}

function showErrorBanner(err: unknown): void {
  if (!session) {
    return;
  }
  session.error = err instanceof Error ? err.message : String(err);
  session.phase = 'ready';
  pushRender();
  showOutput(false);
}

/* ------------------------------ 提交链路 ------------------------------ */

function selectedCommittable(): CommitEntryMeta[] {
  const current = session;
  if (!current) {
    return [];
  }
  return current.metas.filter((meta) => current.selectedPaths.has(meta.path) && isSelectableEntry(meta));
}

async function performCommit(sessionId: string): Promise<void> {
  if (!session || !handle || session.phase === 'unknown') {
    return;
  }
  // 闭包内引用收窄后的会话（模块级 let 在 await 后不再保留流收窄）。
  const s = session;
  let selected = selectedCommittable();
  if (selected.length === 0) {
    return;
  }
  const target = targetOf(session);
  const svnPath = readSvnPath();

  // 空说明口径（M1 保留）：开关关闭直接拒绝；开启时二次确认。
  if (session.message.trim() === '') {
    if (!session.allowEmpty) {
      handle.toast('info', strings.commit.emptyMessageRejected);
      return;
    }
    const again = await confirmModal(strings.commit.emptyMessageConfirm, strings.commit.continueButton);
    if (!again) {
      return;
    }
  }

  // 提交范围确认（含待添加、missing、隐藏项与目录时列出明细）。
  const visible = visibleMetas(session);
  const hidden = selected.filter((meta) => !visible.some((v) => v.path === meta.path)).length;
  const hasUnversioned = selected.some((meta) => meta.group === 'unversioned');
  const hasMissing = selected.some((meta) => meta.wcStatus === 'missing');
  const hasDir = selected.some((meta) => meta.kind === 'dir');
  if (hasUnversioned || hasMissing || hidden > 0 || hasDir) {
    const review = buildReviewMessage(selected, hidden, hasUnversioned, hasMissing, hasDir);
    const ok = await confirmModal(review, strings.commit.continueButton);
    if (!ok) {
      return; // 取消不 add、不 delete。
    }
  }

  session.phase = 'checking';
  session.error = null;
  session.result = null;
  pushRender();

  try {
    // 提交前重读本地实际状态：外部客户端可能在面板加载后修改了工作副本
    // （missing 登记、待添加范围都必须以当前事实为准，不信任打开时的快照）。
    logCommand(svnPath, ['status', '--xml', session.targetArg], session.wcRoot);
    const freshStatus = await runStatus(svnPath, session.targetArg, runOptions(session.wcRoot));
    if (handle.sessionId !== sessionId) {
      return;
    }
    const freshMetas = mergeStatusEntries(freshStatus.entries, undefined, session.externalPrefixes);
    enrichMetas(freshMetas, session.wcRoot);
    session.metas = freshMetas;
    session.selectedPaths = new Set([...session.selectedPaths].filter((path) =>
      freshMetas.some((meta) => meta.path === path && isSelectableEntry(meta)),
    ));
    // missing 登记/待添加判断以重读后的状态为准（选择集合按路径身份保留）。
    const retainedPaths = s.selectedPaths;
    selected = freshMetas.filter((meta) => retainedPaths.has(meta.path) && isSelectableEntry(meta));
    if (selected.length === 0) {
      session.phase = 'ready';
      pushRender();
      return;
    }

    // 提交前远端检查与冲突阻止（M1 口径）。
    const registry = getOperationRegistry();
    if (session.remoteIncluded) {
      const outcome = await remoteCheckBeforeCommitPanel(target, svnPath);
      if (outcome !== 'checked') {
        // 更新/取消/冲突都不发起提交：释放操作登记，避免阻塞同副本后续提交。
        session.phase = 'ready';
        pushRender();
        if (outcome === 'updateOnly' || outcome === 'conflict' || outcome === 'updated') {
          await loadSession(handle.sessionId, target, { initial: false });
        }
        return;
      }
    }

    // 操作登记：同副本互斥；写入失败（持久化异常）不发起提交。
    const begin = await registry.begin({
      wcRoot: session.wcRoot,
      targetRelPath: session.targetArg,
      nodeKind: 'dir',
      baseRevision: commitBaseAgainst,
      explicitPaths: selected.map((meta) => meta.path),
    });
    if (!begin.ok) {
      session.phase = 'ready';
      session.error = format(strings.panel.operationHeldBusy, { phase: begin.heldBy.phase });
      pushRender();
      return;
    }
    activeOperationId = begin.operationId;

    // missing → svn delete --force（确认已涵盖在范围确认中）。
    for (const meta of selected.filter((item) => item.wcStatus === 'missing')) {
      const args = ['delete', '--force', '--', escapePeg(meta.path)];
      logCommand(svnPath, args, session.wcRoot);
      await runOrThrow(svnPath, args, {
        ...runOptions(session.wcRoot),
        getCredentials: promptForCredentials,
        onCredentialRetry: (retryArgs) => logCommand(svnPath, retryArgs, s.wcRoot),
      });
      session.missingPrepared.push(meta.path);
    }

    // 待添加：目录 --depth empty 只登记节点，勾选子项逐个登记；父目录先加。
    const toAdd = selected.filter((meta) => meta.group === 'unversioned');
    if (toAdd.length > 0) {
      const plan = [...toAdd]
        .map((meta) => meta.path)
        .sort((a, b) => segmentCount(a) - segmentCount(b) || (a < b ? -1 : a > b ? 1 : 0));
      for (const path of plan) {
        const args = ['add', '--depth', 'empty', '--', escapePeg(path)];
        logCommand(svnPath, args, session.wcRoot);
        try {
          await runOrThrow(svnPath, args, runOptions(session.wcRoot));
          session.addedPrepared.push(path);
        } catch (err) {
          // 添加失败不继续提交；已添加项保留 A 状态并解释。
          await registry.finish(activeOperationId);
          activeOperationId = undefined;
          const failureText = `${err instanceof Error ? err.message : String(err)}\n${strings.panel.addFailedDetail}`;
          await loadSession(handle.sessionId, target, { initial: false });
          if (session) {
            session.phase = 'ready';
            session.error = failureText;
            session.errorKind = 'add';
            pushRender();
          }
          showOutput(false);
          return;
        }
      }
    }

    // 分批提交：每批成功即时记录 revision（操作注册表持久化）。
    session.phase = 'committing';
    pushRender();
    const paths = selected.map((meta) => meta.path);
    const revisions: number[] = [];
    const committed: string[] = [];
    let failure: unknown;
    let unknown = false;
    const tmpDir = mkdtempSync(join(tmpdir(), 'svn-anywhere-commit-'));
    try {
      const messageFile = join(tmpDir, 'message.txt');
      writeFileSync(messageFile, session.message, 'utf8');
      for (let offset = 0; offset < paths.length; offset += COMMIT_BATCH_SIZE) {
        const batch = paths.slice(offset, offset + COMMIT_BATCH_SIZE);
        const args = buildCommitArgs(messageFile, batch);
        logCommand(svnPath, args, session.wcRoot);
        try {
          const result = await runOrThrow(svnPath, args, {
            ...runOptions(session.wcRoot),
            getCredentials: promptForCredentials,
            onCredentialRetry: (retryArgs) => logCommand(svnPath, retryArgs, s.wcRoot),
          });
          logLine(result.stdout.trimEnd());
          const revision = parseCommitOutput(result.stdout).revision;
          if (revision !== undefined) {
            revisions.push(revision);
            committed.push(...batch);
            await registry.markPhase(activeOperationId ?? begin.operationId, 'committing', { knownRevisions: [...revisions] });
          }
        } catch (err) {
          if (err instanceof SvnError && (err.code === 'TIMEOUT' || err.code === 'SPAWN_ERROR' || err.code === 'CANCELLED')) {
            unknown = true;
          } else if (
            session.message.trim() === '' &&
            err instanceof SvnError &&
            /empty commit|空日志/i.test(err.message)
          ) {
            // 空说明兜底（M1 保留）：-m "" 重试一次。
            const retryArgs = ['commit', '--non-interactive', '-m', '', ...batch.map((p) => escapePeg(p))];
            logCommand(svnPath, retryArgs, session.wcRoot);
            try {
              const result = await runOrThrow(svnPath, retryArgs, {
                ...runOptions(session.wcRoot),
                getCredentials: promptForCredentials,
                onCredentialRetry: (retryArgs2) => logCommand(svnPath, retryArgs2, s.wcRoot),
              });
              logLine(result.stdout.trimEnd());
              const revision = parseCommitOutput(result.stdout).revision;
              if (revision !== undefined) {
                revisions.push(revision);
                committed.push(...batch);
                await registry.markPhase(activeOperationId ?? begin.operationId, 'committing', { knownRevisions: [...revisions] });
              }
              continue;
            } catch (retryErr) {
              if (retryErr instanceof SvnError && (retryErr.code === 'TIMEOUT' || retryErr.code === 'SPAWN_ERROR' || retryErr.code === 'CANCELLED')) {
                unknown = true;
              } else {
                failure = retryErr;
              }
              break;
            }
          } else {
            failure = err;
          }
          if (unknown || failure !== undefined) {
            break;
          }
        }
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }

    if (unknown) {
      // 结果未知：保留操作记录并冻结写意图，只允许核实。
      await registry.markPhase(activeOperationId ?? begin.operationId, 'unknown', { knownRevisions: [...revisions] });
      session.phase = 'unknown';
      session.error = null;
      if (committed.length > 0) {
        session.result = { kind: 'partial', revisions, committedIds: committed.map((path) => path) };
      }
      pushRender();
      showOutput(false);
      return;
    }

    if (failure !== undefined && committed.length === 0) {
      // 确认失败（服务端拒绝）：说明与勾选保留，可重试。
      await registry.finish(activeOperationId);
      activeOperationId = undefined;
      session.phase = 'ready';
      const failureText = failure instanceof Error ? failure.message : String(failure);
      session.error = failureText;
      pushRender();
      showOutput(false);
      void vscode.window.showErrorMessage(errorFirstLine(failureText));
      return;
    }

    if (failure !== undefined && committed.length > 0) {
      // 部分成功：记录每批 revision；重试前先刷新实际状态。
      session.result = { kind: 'partial', revisions, committedIds: committed };
      session.phase = 'ready';
      session.error = failure instanceof Error ? failure.message : String(failure);
      await finishCommitRefresh(registry, false);
      return;
    }

    // 全部成功：记录历史、清空说明、成功卡片、提交后刷新。
    if (s.message.trim() !== '') {
      s.history = [s.message, ...s.history.filter((item) => item !== s.message)].slice(0, MAX_HISTORY);
      await saveHistory(s.wcRoot, s.history);
    }
    s.message = '';
    s.result = { kind: 'success', revisions, committedIds: committed };
    s.addedPrepared = [];
    s.missingPrepared = [];
    await finishCommitRefresh(registry, true);
  } catch (err) {
    if (handle.sessionId !== sessionId) {
      return;
    }
    if (activeOperationId) {
      const registry = getOperationRegistry();
      if (err instanceof SvnError && (err.code === 'TIMEOUT' || err.code === 'SPAWN_ERROR' || err.code === 'CANCELLED')) {
        // 准备阶段（missing 登记/添加）进程级失败无法证明未提交，按结果未知冻结。
        await registry.markPhase(activeOperationId, 'unknown');
      } else {
        await registry.finish(activeOperationId);
        activeOperationId = undefined;
      }
    }
    session.phase = err instanceof SvnError && (err.code === 'TIMEOUT' || err.code === 'SPAWN_ERROR' || err.code === 'CANCELLED') ? 'unknown' : 'ready';
    const failureText = err instanceof Error ? err.message : String(err);
    session.error = failureText;
    pushRender();
    showOutput(false);
    if (session.phase !== 'unknown') {
      void vscode.window.showErrorMessage(errorFirstLine(failureText));
    }
  }
}

function segmentCount(path: string): number {
  return path === '.' ? 0 : path.split('/').length;
}

function errorFirstLine(message: string): string {
  return message.split('\n')[0]?.slice(0, 300) ?? message;
}

/** 提交后的刷新与结果回显；刷新失败进入 stale（不引导盲目重提）。 */
async function finishCommitRefresh(registry: OperationRegistry, success: boolean): Promise<void> {
  if (!session || !handle) {
    return;
  }
  const svnPath = readSvnPath();
  logLine(strings.commit.refreshHeader);
  try {
    const after = await runStatus(svnPath, session.targetArg, runOptions(session.wcRoot));
    writeStatusReport(after);
    const committedPaths = new Set(session.result?.committedIds ?? []);
    session.selectedPaths = new Set([...session.selectedPaths].filter((path) => !committedPaths.has(path)));
    session.missingPrepared = session.missingPrepared.filter((path) =>
      after.entries.some((entry) => entry.path === path && entry.wcStatus === 'missing'),
    );
    session.addedPrepared = session.addedPrepared.filter((path) =>
      after.entries.some((entry) => entry.path === path && entry.wcStatus !== 'normal'),
    );
    // 全部成功与部分成功都结束本次操作登记：成功批次 revision 已逐批落盘
    // 并在结果中回显，剩余项作为新的提交重试，不得被自身记录以 busy 阻塞。
    if (success || session.result?.kind === 'partial') {
      await registry.finish(activeOperationId);
      activeOperationId = undefined;
    }
    // 用重读数据重建面板（保留说明与仍有效的勾选）。
    const keepResult = session.result;
    const keepPrepared = { added: session.addedPrepared, missing: session.missingPrepared };
    await loadSession(handle.sessionId, targetOf(session), { initial: false });
    if (session) {
      session.result = keepResult;
      session.addedPrepared = keepPrepared.added;
      session.missingPrepared = keepPrepared.missing;
      if (!success) {
        session.phase = 'ready';
      }
      pushRender();
    }
    showOutput(false);
    if (keepResult) {
      const revisions = (keepResult.revisions ?? []).map((revision) => `r${revision}`).join('、');
      void vscode.window.showInformationMessage(
        revisions
          ? format(strings.panel.commitSuccessToast, { revisions })
          : strings.commit.committedNoRevision,
      );
    }
  } catch (err) {
    // 提交成功（含部分成功）但刷新失败：明确已提交，重读后才能再次提交。
    session.phase = 'stale';
    session.error = err instanceof Error ? err.message : String(err);
    if (success || session.result?.kind === 'partial') {
      await registry.finish(activeOperationId);
      activeOperationId = undefined;
    }
    pushRender();
    showOutput(false);
    // 提交本身已成功：即使刷新失败也要回显 revision，不把刷新失败误读为提交失败。
    const committedResult = session.result;
    if (committedResult) {
      const revisions = (committedResult.revisions ?? []).map((revision) => `r${revision}`).join('、');
      void vscode.window.showInformationMessage(
        revisions ? format(strings.panel.commitSuccessToast, { revisions }) : strings.commit.committedNoRevision,
      );
    }
  }
}

/** 面板内提交前远端检查：返回 cancelled/updateOnly/conflict/updated/checked。 */
async function remoteCheckBeforeCommitPanel(
  target: WcTarget,
  svnPath: string,
): Promise<'cancelled' | 'updateOnly' | 'conflict' | 'updated' | 'checked'> {
  if (!session || !handle) {
    return 'cancelled';
  }
  const targetArg = session.targetArg;
  const remote = await runRemoteStatusWithAuth(svnPath, targetArg, target);
  const remoteChanges = remoteChangedEntries(remote);
  commitBaseAgainst = remote.against;
  logLine(
    format(strings.commitCheck.remoteSummary, {
      count: String(remoteChanges.length),
      against: remote.against === undefined ? '—' : String(remote.against),
    }),
  );
  if (remoteChanges.length === 0) {
    return 'checked';
  }
  const choice = await vscode.window.showWarningMessage(
    format(strings.commitCheck.confirmTitle, { count: String(remoteChanges.length) }),
    { modal: true },
    strings.commitCheck.updateAndContinue,
    strings.commitCheck.updateOnly,
    strings.commitCheck.cancel,
  );
  if (choice === undefined || choice === strings.commitCheck.cancel) {
    return 'cancelled';
  }
  const result = await performUpdate(target, svnPath);
  const unresolved =
    result.conflicts.length === 0 && Object.values(result.conflictSummary ?? {}).some((n) => (n ?? 0) > 0);
  if (result.conflicts.length > 0 || unresolved) {
    void vscode.window.showInformationMessage(
      format(strings.commitCheck.blockedByConflicts, {
        paths: result.conflicts.length > 0 ? result.conflicts.join('、') : strings.commitCheck.conflictPathsFallback,
      }),
    );
    return 'conflict';
  }
  return choice === strings.commitCheck.updateAndContinue ? 'updated' : 'updateOnly';
}

function buildReviewMessage(
  selected: CommitEntryMeta[],
  hidden: number,
  hasUnversioned: boolean,
  hasMissing: boolean,
  hasDir: boolean,
): string {
  const lines: string[] = [strings.panel.reviewTitle];
  lines.push(format(strings.panel.reviewTotal, { count: String(selected.length) }));
  if (hidden > 0) {
    lines.push(format(strings.panel.reviewHiddenSuffix, { count: String(hidden) }));
  }
  lines.push('');
  for (const meta of selected) {
    lines.push(`· ${meta.path}`);
  }
  lines.push('');
  if (hasUnversioned) {
    lines.push(strings.panel.reviewAddNote);
  }
  if (selected.some((meta) => meta.kind === 'dir' && meta.props === 'modified')) {
    lines.push(strings.panel.reviewDirPropNote);
  }
  if (selected.some((meta) => meta.kind === 'dir' && ['unversioned', 'added'].includes(meta.wcStatus))) {
    lines.push(strings.panel.reviewDirAddNote);
  }
  if (selected.some((meta) => meta.kind === 'dir' && ['deleted', 'missing'].includes(meta.wcStatus))) {
    lines.push(strings.panel.reviewDirDeleteNote);
  }
  if (hasMissing) {
    lines.push(strings.panel.reviewMissingNote);
  }
  return lines.join('\n');
}

/* --------------------------- 结果未知核实 --------------------------- */

/**
 * 核实结果未知：重读本地与远端状态对照操作记录。
 * 判定不依赖提交前基准（remoteCheck 关闭时无 against 基准），改用
 * 「显式路径的远端状态」对照：若我们的提交已入库，这些路径必然在
 * 远端出现新变化（本地 BASE 仍落后）。
 * - 本地全部显式路径已无变更 → 确认已提交（成功卡片，不重复提交）；
 * - 远端可读且显式路径无远端变化、本地仍是提交时修改 → 确认未提交，
 *   解锁允许重试（已登记的添加/删除可能已生效，提示核对）；
 * - 远端不可读，或显式路径出现远端变化但本地修改仍在（可能是本次
 *   提交已入库也可能是他人提交）→ 证据不唯一，继续冻结。
 */
async function resolveUnknown(sessionId: string): Promise<void> {
  if (!session || !handle || session.phase !== 'unknown') {
    return;
  }
  const registry = getOperationRegistry();
  const restriction = registry.writeRestriction(session.wcRoot);
  const svnPath = readSvnPath();
  const target = targetOf(session);
  session.phase = 'refreshing';
  pushRender();
  try {
    logCommand(svnPath, ['status', '--xml', session.targetArg], session.wcRoot);
    const status = await runStatus(svnPath, session.targetArg, runOptions(session.wcRoot));
    const explicit = restriction?.explicitPaths ?? [...session.selectedPaths];
    const stillDirty = explicit.filter((path) =>
      status.entries.some((entry) => entry.path === path && (entry.wcStatus !== 'normal' || entry.props === 'modified')),
    );
    let remoteChangedOnExplicit = false;
    let remoteReachable = false;
    try {
      const remote = await runRemoteStatusWithAuth(svnPath, session.targetArg, target);
      remoteReachable = true;
      const changedPaths = new Set(remoteChangedEntries(remote).map((entry) => entry.path));
      remoteChangedOnExplicit = explicit.some((path) => changedPaths.has(path));
    } catch {
      remoteReachable = false;
    }
    if (handle.sessionId !== sessionId) {
      return;
    }
    if (stillDirty.length === 0) {
      // 本地确认：显式路径全部干净说明客户端已确认提交结果。
      const revisions = restriction?.knownRevisions ?? [];
      await registry.finish(restriction?.operationId ?? activeOperationId ?? '');
      activeOperationId = undefined;
      handle.toast(
        'info',
        format(strings.panel.verifyCommitted, { revisions: revisions.map((r) => `r${r}`).join('、r') || '—' }),
      );
      const verified: CommitSessionState['result'] = { kind: 'success', revisions, committedIds: explicit };
      // unknown 期 busy=false、目标可切换：用已核对的会话 ID 重读，
      // loadSession 入口校验拦截切换后的迟到执行。
      await loadSession(sessionId, target, { initial: false });
      if (session) {
        session.result = verified;
        pushRender();
      }
      return;
    }
    if (remoteReachable && !remoteChangedOnExplicit) {
      // 远端可读且显式路径无远端变化：本次提交未入库，确认未提交，解锁重试。
      await registry.markPhase(restriction?.operationId ?? activeOperationId ?? '', 'failed-unconfirmed');
      activeOperationId = undefined;
      session.phase = 'ready';
      handle.toast('info', strings.panel.verifyNotCommitted);
      await loadSession(sessionId, target, { initial: false });
      return;
    }
    // 远端不可读，或显式路径出现远端变化但本地修改仍在：证据不唯一，继续冻结。
    handle.toast('info', strings.panel.verifyStillUnknown);
    session.phase = 'unknown';
    pushRender();
  } catch (err) {
    if (handle.sessionId !== sessionId) {
      return;
    }
    session.phase = 'unknown';
    session.error = err instanceof Error ? err.message : String(err);
    pushRender();
  }
}

/* ------------------------------ 关闭面板 ------------------------------ */

async function closePanel(): Promise<void> {
  if (!session) {
    handle?.dispose();
    return;
  }
  if (sessionChanged(session)) {
    const ok = await vscode.window.showWarningMessage(
      strings.panel.closeDiscardTitle,
      { modal: true, detail: strings.panel.closeDiscardDetail },
      strings.commit.continueButton,
    );
    if (ok !== strings.commit.continueButton) {
      return;
    }
  }
  handle?.dispose();
}
