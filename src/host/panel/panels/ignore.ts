/**
 * P2 忽略规则编辑器控制器：宿主侧业务决策（属性读写、隔离提交、协调、
 * 结果未知核实）。整个流程留在 P2，不跳 P1、不带同目录其他属性或子文件。
 *
 * 语义（技术方案 §5/§14.3，交互清单 P2）：
 * - 保存只写本机（propset -F 临时文件 / 清空 propdel），保存失败不进提交；
 * - 提交先保存，再仅提交当前目录 svn:ignore：基于目标节点 URL 与 BASE
 *   revision 的限深临时工作副本提交该单个属性，成功后 update --depth
 *   empty 协调原副本；其他属性与文件修改全程不参与；
 * - 每次提交前及协调前都比较当前工作副本与已保存快照（不只在 dirty 时），
 *   重读后重算 localModified 并清理过期成功 revision；
 * - 超时/断连/进程退出属结果未知：持久化操作记录并核实，核实前禁止重提；
 *   提交发出后本地变化不能证明未提交（已知成功保留 revision 进入协调
 *   受阻，未知保持 unknown）；
 * - 外部属性基线变化不覆盖：比较失败即停止并要求重读，保留双方快照。
 */
import * as vscode from 'vscode';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { literalIgnorePattern } from '../../../core/ignore';
import {
  applyIgnoreSnapshot,
  checkoutDepthEmpty,
  commitTempIgnore,
  coordinateUpdate,
  propertyConflicted,
  readIgnoreSnapshot,
  readNodeIdentity,
  readRemoteIgnoreSnapshot,
  readRemoteNodeRevisions,
  resolvePropertyConflict,
  snapshotEqual,
  type NodeIdentity,
  type PropertySnapshot,
} from '../../../core/ignoreCommit';
import { SvnError } from '../../../core/errors';
import { getOperationRegistry, type OperationRecord } from '../../../core/operations';
import { readSvnPath, readTimeoutMs } from '../../config';
import { format, strings } from '../../i18n';
import { decodingRunOptions, logCommand, logExitCode, logLine, showOutput } from '../../output';
import { promptForCredentials } from '../../auth';
import { confirmModal } from '../../ui/confirm';
import { resolveWorkingCopyTarget } from '../../commands/target';
import { createPanel, type PanelHandle } from '../host';
import type { Intent } from '../protocol';
import {
  buildIgnorePanelState,
  checkDraft,
  dirtyOf,
  draftPending,
  hasUnsavedDraft,
  localModifiedOf,
  propertyOf,
  recoveryBusy,
  removeRuleAt,
  restrictionPhase,
  type IgnoreSessionState,
} from '../ignoreModel';

const PANEL_ID = 'ignore';

interface PanelContext {
  extensionUri: vscode.Uri;
  subscriptions: vscode.Disposable[];
  globalState: vscode.Memento;
}

let panelContext: PanelContext | undefined;
let handle: PanelHandle | undefined;
let session: IgnoreSessionState | undefined;
let formRevision = 0;
/** 当次提交在途的操作登记；结果未知/待协调期间保留供核实与恢复。 */
let activeOperationId: string | undefined;
/** 隔离提交的临时副本目录（协调完成/确认失败后清理）。 */
let activeTempDir: string | undefined;

/** activate 时注入宿主上下文。 */
export function setIgnorePanelContext(context: PanelContext): void {
  panelContext = context;
}

/** 面板可能已被用户关闭（执行中按 X）：瞬时提示静默跳过，不中断状态机。 */
function toastSafely(level: 'info' | 'error', message: string): void {
  handle?.toast(level, message);
}

function runOptions(cwd: string) {
  return {
    cwd,
    timeoutMs: readTimeoutMs(),
    // 无 onLog 的命令（远端 revision 读取）走外层退出码兜底。
    onExit: (code: number) => logExitCode(code, 'commit'),
    ...decodingRunOptions('commit'),
    // 命令回显逐条（M1 口径）：core 原语在执行前回调真实 args；返回值绑定
    // 该命令的退出记录器（操作日志逐命令配对）。
    onLog: (args: string[], at?: string) => logCommand(readSvnPath(), args, at ?? cwd, 'commit'),
  };
}

/** 会话是否处于不可打断或受限阶段。 */
function sessionBusy(): boolean {
  return session !== undefined && recoveryBusy(session);
}

/* ------------------------------ 命令入口 ------------------------------ */

/**
 * 「编辑忽略规则」命令：打开 P2 面板。目标是文件时编辑父目录规则，
 * 是目录时编辑自身规则；同目标复用，新目标切换会话（草稿确认），
 * 忙碌时拒绝切换。目录入口不提供「用当前项名」（避免把目录名写入
 * 目录自身规则的歧义动作）。
 */
export async function commandShowIgnorePanel(uri?: vscode.Uri): Promise<void> {
  const target = await resolveWorkingCopyTarget(uri, strings.command.editIgnore, 'commit');
  if (!target || !panelContext) {
    return;
  }
  // 属性作用于目录：文件目标折算到父目录。
  let dirPath = target.targetPath;
  try {
    if (statSync(dirPath).isFile()) {
      dirPath = dirname(dirPath);
    }
  } catch {
    // stat 失败保留原路径，让 svn 报错原样呈现。
  }
  const originName = basename(target.targetPath) !== basename(dirPath) || target.targetPath !== dirPath
    ? basename(target.targetPath)
    : null;
  const sameTarget = session?.wcRoot === target.wcRoot && session?.targetDir === dirPath;
  if (handle && sameTarget && session) {
    handle.reveal();
    // 同目标重入：无未保存草稿时重读刷新（originName 更新为本次命令目标，
    // 供「用当前项名」使用）；有草稿只 reveal（重读经确认框）。
    if (!sessionBusy() && !hasUnsavedDraft(session)) {
      await loadSession(handle.sessionId, session.wcRoot, session.targetDir, originName);
    }
    return;
  }
  if (handle && !sameTarget && session?.phase !== undefined) {
    if (sessionBusy()) {
      void vscode.window.showWarningMessage(
        format(strings.panel.panelBusySwitchRejected, { target: dirPath }),
      );
      return;
    }
    if (hasUnsavedDraft(session)) {
      const ok = await vscode.window.showWarningMessage(
        strings.ignorePanel.switchDiscardTitle,
        { modal: true, detail: strings.ignorePanel.switchDiscardDetail },
        strings.ignorePanel.switchDiscardButton,
      );
      if (ok !== strings.ignorePanel.switchDiscardButton) {
        return;
      }
    }
    if (!handle.switchSession()) {
      void vscode.window.showWarningMessage(
        format(strings.panel.panelBusySwitchRejected, { target: dirPath }),
      );
      return;
    }
  }
  handle ??= createPanel(
    PANEL_ID,
    { title: strings.ignorePanel.editIgnoreTitle, retainContextWhenHidden: false },
    { onIntent, onDispose: onPanelDispose },
    panelContext,
  );
  await loadSession(handle.sessionId, target.wcRoot, dirPath, originName);
}

function onPanelDispose(): void {
  handle = undefined;
  session = undefined;
  activeOperationId = undefined;
  // 隐藏/关闭不撤销任何已执行的 SVN 写入；临时副本留给恢复流程清理。
}

/* ------------------------------ 会话读取 ------------------------------ */

/**
 * 读取目标目录的四层值并推送渲染。读取失败独立于空属性（W200017 为
 * 属性不存在；其余失败进入 loadError，不允许写回）。
 */
async function loadSession(
  sessionId: string,
  wcRoot: string,
  targetDir: string,
  originName: string | null,
): Promise<void> {
  const svnPath = readSvnPath();
  const dirArg = relative(wcRoot, targetDir) || '.';
  session = {
    sessionId,
    wcRoot,
    targetDir,
    dirArg,
    originName,
    identity: null,
    rules: [],
    savedRules: [],
    savedPropertyExists: false,
    workingSnapshot: { rules: [], exists: false },
    repositoryRules: [],
    repositoryPropertyExists: false,
    draft: '',
    phase: 'loading',
    error: null,
    notice: null,
    localModified: false,
    submittedRevision: null,
    successVisible: true,
    operation: null,
  };
  // 会话读取重置输入草稿：递增输入序号让 webview 的未确认本地输入被空值覆盖。
  formRevision += 1;
  pushRender();

  // 操作注册表限制（unknown/待协调）跨面板关闭保持。
  const restriction = getOperationRegistry().writeRestriction(wcRoot);
  if (restriction) {
    const kind = restrictionPhase(restriction);
    const property = propertyOf(restriction);
    if (kind === 'unknown' && property) {
      session.phase = 'unknown';
      session.operation = restriction;
      activeOperationId = restriction.operationId;
      // 受限期间保留既有快照展示（从持久化记录恢复待提交值）。
      session.savedRules = [...(property.pendingValue ?? [])];
      session.savedPropertyExists = property.pendingExists ?? session.savedRules.length > 0;
      session.rules = [...session.savedRules];
      pushRender();
      return;
    }
    if (kind === 'coordinationBlocked' && property) {
      session.phase = 'coordinationBlocked';
      session.operation = restriction;
      activeOperationId = restriction.operationId;
      session.submittedRevision = restriction.knownRevisions[0] ?? null;
      session.savedRules = [...(property.pendingValue ?? [])];
      session.savedPropertyExists = property.pendingExists ?? session.savedRules.length > 0;
      session.rules = [...session.savedRules];
      pushRender();
      return;
    }
    // 其他面板（P1）的在途/受限操作同样锁住本副本的保存与提交。
    session.phase = 'unknown';
    session.operation = restriction;
    session.error = strings.ignorePanel.noticeForeignOperation;
    activeOperationId = restriction.operationId;
    pushRender();
    return;
  }

  try {
    const [identity, working, base] = await Promise.all([
      readNodeIdentity(svnPath, dirArg, runOptions(wcRoot)),
      readIgnoreSnapshot(svnPath, dirArg, runOptions(wcRoot)),
      readIgnoreSnapshot(svnPath, dirArg, { ...runOptions(wcRoot), revision: 'BASE' }),
    ]);
    if (handle?.sessionId !== sessionId) {
      return;
    }
    session.identity = identity;
    session.workingSnapshot = working;
    session.savedRules = [...working.rules];
    session.savedPropertyExists = working.exists;
    session.rules = [...working.rules];
    session.repositoryRules = [...base.rules];
    session.repositoryPropertyExists = base.exists;
    session.localModified = localModifiedOf(session);
    session.phase = 'ready';
    session.error = null;
    session.successVisible = true;
    pushRender();
  } catch (err) {
    if (handle?.sessionId !== sessionId) {
      return;
    }
    session.phase = 'loadError';
    session.error = err instanceof Error ? err.message : String(err);
    pushRender();
  }
}

/* ------------------------------ 渲染推送 ------------------------------ */

function pushRender(): void {
  if (!session || !handle) {
    return;
  }
  // 表单输入序号随渲染合入：webview 据此判断本地未确认输入是否已被
  // 宿主确认/覆盖（宿主主动改值前须递增，见 addRule/fillOriginName）。
  handle.update({ ...buildIgnorePanelState(session), formRevision }, handle.sessionId);
}

/* ------------------------------ 意图分发 ------------------------------ */

async function onIntent(intent: Intent, context: { sessionId: string; busy: boolean }): Promise<void> {
  if (!handle || !session || handle.sessionId !== context.sessionId) {
    return;
  }
  switch (intent.kind) {
    case 'refresh':
      if (recoveryBusy(session)) {
        // 结果未知/协调期间不重读（保留操作快照现场）。
        return;
      }
      if (hasUnsavedDraft(session)) {
        const ok = await confirmModal(
          `${strings.ignorePanel.reloadDiscardTitle}\n${strings.ignorePanel.reloadDiscardDetail}`,
          strings.ignorePanel.reloadDiscardButton,
        );
        if (!ok) {
          return;
        }
      }
      await loadSession(context.sessionId, session.wcRoot, session.targetDir, session.originName);
      if (session && session.phase === 'ready') {
        session.notice = strings.ignorePanel.noticeReloaded;
        pushRender();
      }
      return;
    case 'syncInput':
      if (intent.fieldId === 'draft') {
        if (intent.inputRevision >= 0) {
          formRevision = Math.max(formRevision, intent.inputRevision);
        }
        session.draft = intent.value;
      }
      return;
    case 'addRule': {
      if (session.phase !== 'ready') {
        return;
      }
      const issue = checkDraft(session.draft, session.rules);
      if (issue === 'empty') {
        return;
      }
      if (issue === 'pathLike') {
        session.notice = strings.ignorePanel.noticePathLike;
        pushRender();
        return;
      }
      if (issue === 'duplicate') {
        session.notice = strings.ignorePanel.noticeDuplicate;
        pushRender();
        return;
      }
      session.rules = [...session.rules, session.draft];
      session.draft = '';
      session.notice = null;
      session.submittedRevision = null;
      // 宿主清空了输入值：递增序号让渲染的空值覆盖 webview 本地未确认输入。
      formRevision += 1;
      pushRender();
      return;
    }
    case 'removeRule': {
      if (session.phase !== 'ready') {
        return;
      }
      if (intent.index < 0 || intent.index >= session.rules.length) {
        return;
      }
      session.rules = removeRuleAt(session.rules, intent.index);
      session.submittedRevision = null;
      pushRender();
      return;
    }
    case 'fillOriginName': {
      if (session.phase !== 'ready' || session.originName === null) {
        return;
      }
      try {
        session.draft = literalIgnorePattern(session.originName);
        session.notice = strings.ignorePanel.noticeFilled;
        // 宿主写入了输入值：递增序号让渲染值覆盖 webview 本地未确认输入。
        formRevision += 1;
      } catch (err) {
        if (!(err instanceof RangeError)) {
          throw err;
        }
        session.notice = strings.ignorePanel.noticeUnrepresentable;
      }
      pushRender();
      return;
    }
    case 'saveIgnore':
      await saveIgnore(context.sessionId);
      return;
    case 'submitIgnore':
      await submitIgnore(context.sessionId);
      return;
    case 'resolveUnknown':
      await resolveUnknown(context.sessionId);
      return;
    case 'closePanel':
      await closePanel();
      return;
    case 'dismissBanner':
    case 'bannerAction':
      if (intent.kind === 'bannerAction' && intent.actionId === 'refresh') {
        await onIntent({ kind: 'refresh' }, context);
        return;
      }
      if (intent.kind === 'bannerAction' && intent.actionId === 'resolveUnknown') {
        await resolveUnknown(context.sessionId);
        return;
      }
      if (intent.kind === 'dismissBanner' && intent.bannerId === 'notice') {
        session.notice = null;
      }
      pushRender();
      return;
    default:
      return;
  }
}

/* ------------------------------ 保存（本机） ------------------------------ */

/**
 * 保存规则到本机工作副本。写回前比较磁盘实际值与保存基线（外部修改不
 * 覆盖）；成功后读回实际值更新实际快照与保存基线。返回是否成功。
 */
async function saveIgnore(sessionId: string): Promise<boolean> {
  if (!session || !handle || session.phase !== 'ready' || draftPending(session) || !dirtyOf(session)) {
    return false;
  }
  const s = session;
  const svnPath = readSvnPath();
  const registry = getOperationRegistry();
  const begin = await registry.begin({
    wcRoot: s.wcRoot,
    targetRelPath: s.dirArg,
    nodeKind: 'dir',
    baseRevision: s.identity?.revision,
    property: {
      name: 'svn:ignore',
      originalExists: s.repositoryPropertyExists,
      originalValue: [...s.repositoryRules],
      pendingExists: s.rules.length > 0,
      pendingValue: [...s.rules],
    },
  });
  if (!begin.ok) {
    handle.toast('info', format(strings.panel.operationHeldBusy, { phase: begin.heldBy.phase }));
    return false;
  }
  // 局部引用：面板销毁会把模块级 activeOperationId 置空，finish 不能依赖它。
  const operationId = begin.operationId;
  activeOperationId = operationId;
  await registry.markPhase(operationId, 'saving');
  s.phase = 'saving';
  s.error = null;
  s.notice = null;
  pushRender();
  try {
    // 覆盖防护：磁盘实际值与保存基线不一致说明外部修改过，不覆盖。
    const current = await readIgnoreSnapshot(svnPath, s.dirArg, runOptions(s.wcRoot));
    if (handle && handle.sessionId !== sessionId) {
      return false;
    }
    if (!snapshotEqual(current, { rules: s.savedRules, exists: s.savedPropertyExists })) {
      s.workingSnapshot = current;
      s.phase = 'ready';
      s.error = strings.ignorePanel.externalSaveDetail;
      s.errorKind = 'external';
      await registry.finish(operationId);
      if (activeOperationId === operationId) {
        activeOperationId = undefined;
      }
      pushRender();
      showOutput(false, 'commit');
      return false;
    }
    const target: PropertySnapshot = { rules: [...s.rules], exists: s.rules.length > 0 };
    await applyIgnoreSnapshot(svnPath, s.dirArg, target, runOptions(s.wcRoot));
    // 保存成功后读回实际值，再更新实际快照与保存基线。
    const actual = await readIgnoreSnapshot(svnPath, s.dirArg, runOptions(s.wcRoot));
    if (handle && handle.sessionId !== sessionId) {
      return false;
    }
    s.workingSnapshot = actual;
    s.savedRules = [...s.rules];
    s.savedPropertyExists = s.rules.length > 0;
    s.localModified = localModifiedOf(s);
    s.submittedRevision = null;
    s.successVisible = true;
    s.phase = 'ready';
    s.notice = s.localModified ? null : strings.ignorePanel.noticeNoPendingChange;
    await registry.finish(operationId);
    if (activeOperationId === operationId) {
      activeOperationId = undefined;
    }
    pushRender();
    return true;
  } catch (err) {
    if (handle && handle.sessionId !== sessionId) {
      return false;
    }
    // 本地写进程级失败：重读实际值即可证明结果（属性是本地状态，无服务端未知）。
    if (err instanceof SvnError && (err.code === 'TIMEOUT' || err.code === 'SPAWN_ERROR' || err.code === 'CANCELLED')) {
      try {
        const actual = await readIgnoreSnapshot(svnPath, s.dirArg, runOptions(s.wcRoot));
        if (snapshotEqual(actual, { rules: s.rules, exists: s.rules.length > 0 })) {
          s.workingSnapshot = actual;
          s.savedRules = [...s.rules];
          s.savedPropertyExists = s.rules.length > 0;
          s.localModified = localModifiedOf(s);
          s.successVisible = true;
          s.phase = 'ready';
          await registry.finish(operationId);
          if (activeOperationId === operationId) {
            activeOperationId = undefined;
          }
          pushRender();
          return true;
        }
      } catch {
        // 重读也失败：按普通失败呈现（编辑内容已保留，可重试）。
      }
    }
    s.phase = 'ready';
    s.error = err instanceof Error ? err.message : String(err);
    s.errorKind = 'save';
    await registry.finish(operationId);
    if (activeOperationId === operationId) {
      activeOperationId = undefined;
    }
    pushRender();
    showOutput(false, 'commit');
    return false;
  }
}

/* ------------------------------ 隔离提交 ------------------------------ */

/** svn 进程级失败（结果未知候选）：超时/取消/启动失败。 */
function isProcessFailure(err: unknown): boolean {
  return err instanceof SvnError && (err.code === 'TIMEOUT' || err.code === 'SPAWN_ERROR' || err.code === 'CANCELLED');
}

/**
 * 仅提交当前目录 svn:ignore：有未保存编辑先保存，再在限深临时工作副本
 * 上提交该单个属性，成功后协调原副本。其他属性与文件修改不参与。
 */
async function submitIgnore(sessionId: string): Promise<void> {
  if (!session || !handle || session.phase !== 'ready' || draftPending(session)) {
    return;
  }
  const s = session;
  const svnPath = readSvnPath();
  const registry = getOperationRegistry();

  // 提交先保存；保存失败不进入提交（saveIgnore 内部保持 phase=ready）。
  if (dirtyOf(s)) {
    const saved = await saveIgnore(sessionId);
    if (!saved || session !== s || s.phase !== 'ready') {
      return;
    }
  }

  // 每次提交前比较当前工作副本与已保存快照（不只在 dirty 时核对）。
  s.phase = 'committing';
  s.error = null;
  s.notice = null;
  pushRender();
  let identity: NodeIdentity;
  let working: PropertySnapshot;
  let base: PropertySnapshot;
  try {
    [identity, working, base] = await Promise.all([
      readNodeIdentity(svnPath, s.dirArg, runOptions(s.wcRoot)),
      readIgnoreSnapshot(svnPath, s.dirArg, runOptions(s.wcRoot)),
      readIgnoreSnapshot(svnPath, s.dirArg, { ...runOptions(s.wcRoot), revision: 'BASE' }),
    ]);
    if (handle && handle.sessionId !== sessionId) {
      return;
    }
  } catch (err) {
    s.phase = 'ready';
    s.error = err instanceof Error ? err.message : String(err);
    s.errorKind = 'commit';
    pushRender();
    showOutput(false, 'commit');
    return;
  }
  // 节点身份核对：URL/UUID 变化（switch/relocate）时不能沿用旧基线。
  if (s.identity && (s.identity.url !== identity.url || s.identity.repositoryUuid !== identity.repositoryUuid)) {
    s.phase = 'ready';
    s.error = strings.ignorePanel.identityChangedDetail;
    s.errorKind = 'identity';
    pushRender();
    return;
  }
  s.identity = identity;
  s.workingSnapshot = working;
  s.repositoryRules = [...base.rules];
  s.repositoryPropertyExists = base.exists;
  s.localModified = localModifiedOf(s);
  // 重读后清理过期成功 revision（保存值与 BASE 一致时旧提交卡片不再成立）。
  if (snapshotEqual(
    { rules: s.savedRules, exists: s.savedPropertyExists },
    { rules: base.rules, exists: base.exists },
  )) {
    s.submittedRevision = null;
  }
  if (!snapshotEqual(working, { rules: s.savedRules, exists: s.savedPropertyExists })) {
    // 外部已修改：本次没有提交，也没有覆盖外部内容。
    s.phase = 'ready';
    s.error = strings.ignorePanel.externalDetail;
    s.errorKind = 'external';
    pushRender();
    showOutput(false, 'commit');
    return;
  }
  if (!s.localModified) {
    s.phase = 'ready';
    s.notice = strings.ignorePanel.noticeNoPendingChange;
    pushRender();
    return;
  }

  const begin = await registry.begin({
    wcRoot: s.wcRoot,
    targetRelPath: s.dirArg,
    nodeKind: 'dir',
    repositoryUuid: identity.repositoryUuid,
    baseRevision: identity.revision,
    property: {
      name: 'svn:ignore',
      originalExists: base.exists,
      originalValue: [...base.rules],
      pendingExists: s.savedPropertyExists,
      pendingValue: [...s.savedRules],
    },
  });
  if (!begin.ok) {
    s.phase = 'ready';
    handle.toast('info', format(strings.panel.operationHeldBusy, { phase: begin.heldBy.phase }));
    pushRender();
    return;
  }
  // 局部引用：面板销毁会把模块级 activeOperationId 置空，落盘不能依赖它。
  const operationId = begin.operationId;
  activeOperationId = operationId;
  s.operation = begin.record;
  s.submittedRevision = null;
  s.successVisible = false;
  await registry.markPhase(operationId, 'committing');
  logLine(strings.ignorePanel.commitStartedNotice, 'commit');
  pushRender();

  const tempDir = mkdtempSync(join(tmpdir(), 'svn-anywhere-ignore-commit-'));
  activeTempDir = tempDir;
  try {
    const tempWc = join(tempDir, 'wc');
    await checkoutDepthEmpty(svnPath, identity.url, identity.revision, tempWc, {
      ...runOptions(s.wcRoot),
      getCredentials: promptForCredentials,
      onCredentialRetry: (args) => logCommand(svnPath, args, s.wcRoot, 'commit'),
    });
    const pending: PropertySnapshot = { rules: [...s.savedRules], exists: s.savedPropertyExists };
    await applyIgnoreSnapshot(svnPath, '.', pending, { ...runOptions(tempWc) });
    // 提交说明由此专用操作生成，不引入通用说明表单。
    const messageFile = join(tempDir, 'message.txt');
    writeFileSync(messageFile, strings.ignorePanel.commitMessage, 'utf8');
    const revision = await commitTempIgnore(svnPath, tempWc, messageFile, {
      ...runOptions(tempWc),
      getCredentials: promptForCredentials,
      onCredentialRetry: (args) => logCommand(svnPath, args, s.wcRoot, 'commit'),
    });
    // 成功 revision 先落盘（与面板是否存活无关），再考虑协调：
    // 面板已被用户关闭（handle 置空）时不再自动协调原副本，恢复入口
    // 由重开面板时的待协调记录提供（§14.1 不能跳过即时落盘）。
    await registry.markPhase(operationId, 'committed-pending-coordination', {
      knownRevisions: [revision],
      tempWcPath: tempDir,
    });
    logLine(format(strings.commit.committed, { revision: String(revision) }), 'commit');
    if (!handle || handle.sessionId !== sessionId) {
      return;
    }
    await coordinateAfterCommit(sessionId, operationId, revision, pending, tempDir);
  } catch (err) {
    if (handle && handle.sessionId !== sessionId) {
      return;
    }
    if (isProcessFailure(err)) {
      // 结果未知：保留操作记录并冻结写意图，只允许核实（面板销毁同样落盘）。
      await registry.markPhase(operationId, 'unknown', { tempWcPath: tempDir });
      s.phase = 'unknown';
      s.operation = registry.writeRestriction(s.wcRoot) ?? s.operation;
      s.error = null;
      pushRender();
      showOutput(false, 'commit');
      return;
    }
    await confirmCommitFailure(operationId, err);
  }
}

/** 确认未提交的失败：结束操作登记，保留本地规则，可核对后重试。
 *  面板已销毁（用户以原生 X 关闭）时同样完成 finish，操作记录不得滞留。 */
async function confirmCommitFailure(operationId: string, err: unknown): Promise<void> {
  const s = session;
  await getOperationRegistry().finish(operationId);
  if (activeOperationId === operationId) {
    activeOperationId = undefined;
  }
  cleanupTempDir();
  if (!s) {
    return;
  }
  s.phase = 'ready';
  const message = err instanceof Error ? err.message : String(err);
  const outOfDate = err instanceof SvnError && /E160028|out of date/i.test(err.stderr || err.message);
  s.error = outOfDate ? `${message}\n${strings.ignorePanel.outOfDateHint}` : message;
  s.errorKind = 'commit';
  s.successVisible = true;
  pushRender();
  showOutput(false, 'commit');
  void vscode.window.showErrorMessage(message.split('\n')[0]?.slice(0, 300) ?? message);
}

function cleanupTempDir(): void {
  if (activeTempDir) {
    rmSync(activeTempDir, { recursive: true, force: true });
    activeTempDir = undefined;
  }
}

/** 清理操作记录登记的临时副本目录：unknown/协调受阻经重启恢复并完成的
 *  路径上，现场参数 activeTempDir 已丢失，目录位置只能从持久化记录读取；
 *  记录未登记或目录已不存在时静默（rmSync force 幂等）。 */
function cleanupRecordedTempDir(record: OperationRecord | null | undefined): void {
  if (record?.tempWcPath) {
    rmSync(record.tempWcPath, { recursive: true, force: true });
  }
}

/* ------------------------------ 协调 ------------------------------ */

/**
 * 提交成功后协调原副本：核对身份与规则快照 → update --depth empty →
 * BASE 读回确认。受阻进入 coordinationBlocked（保留 revision 与操作记录，
 * 不重提、不覆盖）；完成时更新基线并保留后续本地修改。
 */
async function coordinateAfterCommit(
  sessionId: string,
  operationId: string,
  revision: number,
  pending: PropertySnapshot,
  tempDir: string,
): Promise<void> {
  const s = session;
  if (!s) {
    return;
  }
  s.phase = 'coordinating';
  pushRender();
  const svnPath = readSvnPath();
  try {
    // 协调前再次核对原副本身份和规则（本地后续修改不自动覆盖）。
    const identity = await readNodeIdentity(svnPath, s.dirArg, runOptions(s.wcRoot));
    const working = await readIgnoreSnapshot(svnPath, s.dirArg, runOptions(s.wcRoot));
    if (handle && handle.sessionId !== sessionId) {
      return;
    }
    if (s.identity && (s.identity.url !== identity.url || s.identity.repositoryUuid !== identity.repositoryUuid)) {
      await blockCoordination(operationId, revision, pending, strings.ignorePanel.reconcileBlockedIdentity);
      return;
    }
    s.workingSnapshot = working;
    if (!snapshotEqual(working, pending)) {
      await blockCoordination(operationId, revision, pending, strings.ignorePanel.reconcileBlockedLocalEdit);
      return;
    }
    await runCoordinationUpdate(sessionId, operationId, revision, pending, working, false, tempDir);
  } catch (err) {
    if (handle && handle.sessionId !== sessionId) {
      return;
    }
    // 协调失败：已知成功保留 revision，进入受阻（不重复提交）。
    const detail = err instanceof Error ? err.message : String(err);
    await blockCoordination(operationId, revision, pending, `${strings.ignorePanel.reconcileBlockedUpdate}\n${detail}`);
  }
}

/** 执行协调 update（含冲突处理与 BASE 读回确认），成功则完成操作。 */
async function runCoordinationUpdate(
  sessionId: string,
  operationId: string,
  revision: number,
  pending: PropertySnapshot,
  working: PropertySnapshot,
  keepWorkingValue: boolean,
  tempDir: string,
): Promise<void> {
  const s = session;
  if (!s) {
    return;
  }
  const svnPath = readSvnPath();
  await coordinateUpdate(svnPath, s.dirArg, {
    ...runOptions(s.wcRoot),
    getCredentials: promptForCredentials,
    onCredentialRetry: (args) => logCommand(svnPath, args, s.wcRoot, 'commit'),
  });
  if (handle && handle.sessionId !== sessionId) {
    return;
  }
  if (await propertyConflicted(svnPath, s.dirArg, runOptions(s.wcRoot))) {
    if (keepWorkingValue) {
      // 用户已核对并决定保留当前工作值：清冲突标记，工作值保留为待提交修改。
      await resolvePropertyConflict(svnPath, s.dirArg, runOptions(s.wcRoot));
    } else {
      await blockCoordination(operationId, revision, pending, strings.ignorePanel.reconcileBlockedConflict);
      return;
    }
  }
  // BASE 读回确认：目标节点 BASE 已更新到本次已知提交结果。
  const base = await readIgnoreSnapshot(svnPath, s.dirArg, { ...runOptions(s.wcRoot), revision: 'BASE' });
  if (!snapshotEqual(base, pending)) {
    await blockCoordination(operationId, revision, pending, strings.ignorePanel.reconcileBlockedBase);
    return;
  }
  await finishCoordination(operationId, revision, tempDir);
}

/** 协调受阻：保留 revision 与操作记录，写锁定，只允许恢复协调。 */
async function blockCoordination(
  operationId: string,
  revision: number,
  pending: PropertySnapshot,
  reason: string,
): Promise<void> {
  const s = session;
  if (!s) {
    return;
  }
  await getOperationRegistry().markPhase(operationId, 'coordination-blocked', { knownRevisions: [revision] });
  s.phase = 'coordinationBlocked';
  s.operation = getOperationRegistry().writeRestriction(s.wcRoot) ?? s.operation;
  s.submittedRevision = revision;
  s.successVisible = false;
  s.error = null;
  s.notice = reason;
  pushRender();
  showOutput(false, 'commit');
}

/** 协调完成：BASE 已确认，工作值（含后续修改）保留为新的草稿基线。 */
async function finishCoordination(operationId: string, revision: number, tempDir?: string): Promise<void> {
  const s = session;
  if (!s) {
    return;
  }
  const svnPath = readSvnPath();
  const [working, base] = await Promise.all([
    readIgnoreSnapshot(svnPath, s.dirArg, runOptions(s.wcRoot)),
    readIgnoreSnapshot(svnPath, s.dirArg, { ...runOptions(s.wcRoot), revision: 'BASE' }),
  ]);
  s.workingSnapshot = working;
  s.repositoryRules = [...base.rules];
  s.repositoryPropertyExists = base.exists;
  s.savedRules = [...working.rules];
  s.savedPropertyExists = working.exists;
  s.rules = [...working.rules];
  s.localModified = localModifiedOf(s);
  s.submittedRevision = revision;
  s.successVisible = true;
  s.phase = 'ready';
  s.notice = null;
  s.error = null;
  await getOperationRegistry().finish(operationId);
  if (activeOperationId === operationId) {
    activeOperationId = undefined;
  }
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  if (activeTempDir && (activeTempDir === tempDir || activeOperationId === undefined)) {
    rmSync(activeTempDir, { recursive: true, force: true });
    activeTempDir = undefined;
  }
  pushRender();
}

/* --------------------------- 结果未知核实 / 协调恢复 --------------------------- */

/**
 * unknown：经远端 HEAD 属性值核实（已提交→进入协调；未提交→解锁重试；
 * 证据不唯一或仓库不可达→继续冻结）。coordinationBlocked：重新核对身份
 * 与规则后恢复协调（必要时确认保留后续本地修改）。
 */
async function resolveUnknown(sessionId: string): Promise<void> {
  if (!session || !handle) {
    return;
  }
  const s = session;
  const svnPath = readSvnPath();
  const registry = getOperationRegistry();
  if (s.phase === 'unknown') {
    const restriction = registry.writeRestriction(s.wcRoot);
    const property = restriction ? propertyOf(restriction) : undefined;
    if (!restriction || !property) {
      // 其他面板的在途操作：本面板只提示，核实入口在对应面板。
      toastSafely('info', strings.ignorePanel.noticeForeignOperation);
      return;
    }
    s.phase = 'coordinating';
    pushRender();
    const pending: PropertySnapshot = {
      rules: [...(property.pendingValue ?? [])],
      exists: property.pendingExists ?? (property.pendingValue ?? []).length > 0,
    };
    const original: PropertySnapshot = {
      rules: [...(property.originalValue ?? [])],
      exists: property.originalExists ?? false,
    };
    try {
      const identity = await readNodeIdentity(svnPath, s.dirArg, runOptions(s.wcRoot));
      if (s.identity && (s.identity.url !== identity.url || s.identity.repositoryUuid !== identity.repositoryUuid)) {
        s.phase = 'unknown';
        s.notice = strings.ignorePanel.reconcileBlockedIdentity;
        pushRender();
        return;
      }
      s.identity = identity;
      const head = await readRemoteIgnoreSnapshot(svnPath, identity.url, {
        ...runOptions(s.wcRoot),
        getCredentials: promptForCredentials,
        onCredentialRetry: (args) => logCommand(svnPath, args, s.wcRoot, 'commit'),
      });
      if (handle && handle.sessionId !== sessionId) {
        return;
      }
      if (snapshotEqual(head, pending)) {
        // 已提交：以远端该节点最后变更 revision 关联本次操作，仅协调不重提。
        const { lastChangedRevision } = await readRemoteNodeRevisions(svnPath, identity.url, runOptions(s.wcRoot));
        await registry.markPhase(restriction.operationId, 'committed-pending-coordination', {
          knownRevisions: [lastChangedRevision],
        });
        toastSafely('info', format(strings.ignorePanel.noticeVerifyCommitted, { revision: String(lastChangedRevision) }));
        await coordinateAfterCommit(sessionId, restriction.operationId, lastChangedRevision, pending, restriction.tempWcPath ?? '');
        return;
      }
      if (snapshotEqual(head, original)) {
        // 远端仍是原始值：确认未提交，解锁允许重试。
        await registry.markPhase(restriction.operationId, 'failed-unconfirmed');
        activeOperationId = undefined;
        cleanupTempDir();
        // 重启恢复的路径上 activeTempDir 已丢失：按记录登记位置清理临时副本。
        cleanupRecordedTempDir(restriction);
        s.phase = 'ready';
        s.notice = strings.ignorePanel.noticeVerifyNotCommitted;
        s.successVisible = true;
        pushRender();
        // 成功卡片在场时 info 横幅会被压住，核实结论用 toast 保证可见。
        toastSafely('info', strings.ignorePanel.noticeVerifyNotCommitted);
        return;
      }
      // 值变化但不匹配任何一方（他人提交或状态复杂）：证据不唯一，继续冻结。
      s.phase = 'unknown';
      s.notice = strings.ignorePanel.noticeVerifyStillUnknown;
      pushRender();
    } catch (err) {
      if (handle && handle.sessionId !== sessionId) {
        return;
      }
      s.phase = 'unknown';
      s.notice = strings.ignorePanel.noticeVerifyStillUnknown;
      s.error = err instanceof Error ? err.message : String(err);
      pushRender();
    }
    return;
  }
  if (s.phase === 'coordinationBlocked') {
    const restriction = registry.writeRestriction(s.wcRoot);
    const property = restriction ? propertyOf(restriction) : undefined;
    if (!restriction || !property) {
      toastSafely('info', strings.ignorePanel.noticeForeignOperation);
      return;
    }
    const revision = restriction.knownRevisions[0] ?? s.submittedRevision ?? 0;
    const pending: PropertySnapshot = {
      rules: [...(property.pendingValue ?? [])],
      exists: property.pendingExists ?? (property.pendingValue ?? []).length > 0,
    };
    s.phase = 'coordinating';
    s.notice = null;
    pushRender();
    try {
      const identity = await readNodeIdentity(svnPath, s.dirArg, runOptions(s.wcRoot));
      const [working, base] = await Promise.all([
        readIgnoreSnapshot(svnPath, s.dirArg, runOptions(s.wcRoot)),
        readIgnoreSnapshot(svnPath, s.dirArg, { ...runOptions(s.wcRoot), revision: 'BASE' }),
      ]);
      if (handle && handle.sessionId !== sessionId) {
        return;
      }
      if (s.identity && (s.identity.url !== identity.url || s.identity.repositoryUuid !== identity.repositoryUuid)) {
        await blockCoordination(restriction.operationId, revision, pending, strings.ignorePanel.reconcileBlockedIdentity);
        return;
      }
      s.identity = identity;
      s.workingSnapshot = working;
      s.repositoryRules = [...base.rules];
      s.repositoryPropertyExists = base.exists;
      if (snapshotEqual(base, pending)) {
        // BASE 已是已提交值：协调幂等完成（不重复 update、不重复提交）。
        await finishCoordination(restriction.operationId, revision, restriction.tempWcPath);
        return;
      }
      if (!snapshotEqual(working, pending)) {
        // 同一忽略属性存在后续本地修改：核对后保留修改再完成协调。
        const confirmed = await confirmKeepWorkingValue(revision, pending, working);
        if (!confirmed) {
          await blockCoordination(restriction.operationId, revision, pending, strings.ignorePanel.reconcileBlockedLocalEdit);
          return;
        }
        await runCoordinationUpdate(sessionId, restriction.operationId, revision, pending, working, true, restriction.tempWcPath ?? '');
        return;
      }
      await runCoordinationUpdate(sessionId, restriction.operationId, revision, pending, working, false, restriction.tempWcPath ?? '');
    } catch (err) {
      if (handle && handle.sessionId !== sessionId) {
        return;
      }
      const detail = err instanceof Error ? err.message : String(err);
      await blockCoordination(restriction.operationId, revision, pending, `${strings.ignorePanel.reconcileBlockedUpdate}\n${detail}`);
    }
  }
}

/** 协调受阻时「保留后续本地修改并完成协调」的核对确认（列双方值）。 */
async function confirmKeepWorkingValue(
  revision: number,
  pending: PropertySnapshot,
  working: PropertySnapshot,
): Promise<boolean> {
  const t = strings.ignorePanel;
  const body = [
    format(t.reconcileConfirmCommitted, { revision: String(revision) }),
    '',
    `${pending.exists ? t.reconcileConfirmCommittedValue : t.reconcileConfirmCommittedAbsent}：`,
    pending.rules.join('\n') || '（空）',
    '',
    `${working.exists ? t.reconcileConfirmWorkingValue : t.reconcileConfirmWorkingAbsent}：`,
    working.rules.join('\n') || '（空）',
    '',
    t.reconcileConfirmDetail,
  ].join('\n');
  return confirmModal(body, t.reconcileConfirmKeep);
}

/* ------------------------------ 关闭面板 ------------------------------ */

async function closePanel(): Promise<void> {
  if (!session) {
    handle?.dispose();
    return;
  }
  if (recoveryBusy(session)) {
    return;
  }
  if (hasUnsavedDraft(session)) {
    const ok = await vscode.window.showWarningMessage(
      strings.ignorePanel.closeDiscardTitle,
      { modal: true, detail: strings.ignorePanel.closeDiscardDetail },
      strings.ignorePanel.closeDiscardButton,
    );
    if (ok !== strings.ignorePanel.closeDiscardButton) {
      return;
    }
  }
  handle?.dispose();
}
