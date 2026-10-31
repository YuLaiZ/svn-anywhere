/**
 * P2 忽略规则编辑器的会话状态与渲染态构建（纯函数，不依赖 vscode）。
 *
 * 四层值分离（技术方案 §5.6）：编辑草稿（rules）、已保存/读取基线
 * （savedRules / savedPropertyExists）、工作副本实际快照（workingSnapshot）、
 * 仓库 BASE（repositoryRules / repositoryPropertyExists）。
 * - dirty 比较草稿与保存基线；localModified 比较保存基线与 BASE；
 * - 提交前再比较实际快照与保存基线（外部修改防护），不只在 dirty 时核对；
 * - 规则按行原样保留（含首尾空格），不逐行 trim。
 */
import type { OperationRecord, PropertyRecord } from '../../core/operations';
import type { NodeIdentity, PropertySnapshot } from '../../core/ignoreCommit';
import { snapshotEqual } from '../../core/ignoreCommit';
import { format, strings } from '../i18n';
import type { BannerSpec, FooterSpec, HeaderBadgeSpec, IgnoreEditorSpec, PanelState } from './state';

/** P2 会话相位：读取 → 就绪/保存/提交 → 协调 → 受阻/未知 → 完成回到就绪。 */
export type IgnoreSessionPhase =
  | 'loading'
  | 'loadError'
  | 'ready'
  | 'saving'
  | 'committing'
  | 'unknown'
  | 'coordinating'
  | 'coordinationBlocked';

export interface IgnoreSessionState {
  sessionId: string;
  wcRoot: string;
  /** 规则编辑目标的绝对目录路径（文件入口已折算到父目录）。 */
  targetDir: string;
  /** 相对副本根的执行目标（'.' 表示根）。 */
  dirArg: string;
  /** 打开命令的原始目标名（文件入口提供「用当前项名」；目录入口为 null）。 */
  originName: string | null;
  /** 目标节点身份（URL/UUID/BASE 修订/类型），提交与协调前重读核对。 */
  identity: NodeIdentity | null;
  /** 编辑草稿：当前规则列表（原值，不 trim）。 */
  rules: string[];
  /** 保存/读取基线：最后一次保存成功或读取时确认的值。 */
  savedRules: string[];
  savedPropertyExists: boolean;
  /** 工作副本实际快照（外部修改只更新这里，不写基线）。 */
  workingSnapshot: PropertySnapshot;
  /** 仓库 BASE 快照（-r BASE 显式读取；本地外部改动不写这里）。 */
  repositoryRules: string[];
  repositoryPropertyExists: boolean;
  /** 待加入输入草稿（未确认入列前不参与保存/提交）。 */
  draft: string;
  phase: IgnoreSessionPhase;
  error: string | null;
  /** 错误分类（横幅标题与后续动作派生用）。 */
  errorKind?: 'save' | 'commit' | 'external' | 'identity';
  /** 信息性提示（info 横幅，如重复模式、重读完成）。 */
  notice: string | null;
  localModified: boolean;
  submittedRevision: number | null;
  /** 成功卡片显示开关（用户可收起；新操作开始时复位）。 */
  successVisible: boolean;
  /** 结果未知/待协调期间保留的操作记录（恢复入口数据）。 */
  operation: OperationRecord | null;
}

/** 会话是否处于不可打断/受限阶段（读取/保存/提交/协调/未知冻结/协调受阻）。 */
export function recoveryBusy(session: IgnoreSessionState): boolean {
  return ['loading', 'saving', 'committing', 'coordinating', 'unknown', 'coordinationBlocked'].includes(session.phase);
}

/** 是否有未保存草稿（规则修改或待加入输入），关闭/重读/切换前确认用。 */
export function hasUnsavedDraft(session: IgnoreSessionState): boolean {
  return dirtyOf(session) || session.draft.length > 0;
}

/** 草稿与保存基线比较（含属性存在性：清空列表 ≠ 未修改）。 */
export function dirtyOf(session: IgnoreSessionState): boolean {
  return !snapshotEqual(
    { rules: session.rules, exists: session.rules.length > 0 },
    { rules: session.savedRules, exists: session.savedPropertyExists },
  );
}

/** 保存基线与仓库 BASE 比较（本地待提交修改）。 */
export function localModifiedOf(session: IgnoreSessionState): boolean {
  return !snapshotEqual(
    { rules: session.savedRules, exists: session.savedPropertyExists },
    { rules: session.repositoryRules, exists: session.repositoryPropertyExists },
  );
}

/** 待加入输入是否存在尚未确认的模式。 */
export function draftPending(session: IgnoreSessionState): boolean {
  return session.draft.length > 0;
}

/** 待加入输入校验：空 / 含路径分隔符或换行 / 重复 / 可加入。 */
export function checkDraft(value: string, rules: string[]): 'empty' | 'pathLike' | 'duplicate' | 'ok' {
  if (value.length === 0) {
    return 'empty';
  }
  if (/[/\r\n]/.test(value)) {
    return 'pathLike';
  }
  return rules.includes(value) ? 'duplicate' : 'ok';
}

/** 按行序号移除一条规则（越界返回原列表；返回新数组）。 */
export function removeRuleAt(rules: string[], index: number): string[] {
  if (index < 0 || index >= rules.length) {
    return [...rules];
  }
  return [...rules.slice(0, index), ...rules.slice(index + 1)];
}

/** 目标目录展示名（副本根目录名 + 相对路径）。 */
export function ignoreTargetLabel(session: IgnoreSessionState): string {
  const rel = session.dirArg === '.' ? '' : session.dirArg;
  const rootName = session.wcRoot.split('/').filter(Boolean).slice(-1)[0] ?? session.wcRoot;
  return rel === ''
    ? format(strings.panel.targetLabelRoot, { name: rootName })
    : format(strings.panel.targetLabelPath, { name: rootName, rel });
}

/* ------------------------------ 渲染态构建 ------------------------------ */

function headerBadges(session: IgnoreSessionState, dirty: boolean): HeaderBadgeSpec[] {
  const badges: HeaderBadgeSpec[] = [];
  const t = strings.ignorePanel;
  if (session.phase === 'unknown') {
    badges.push({ text: t.badgeUnknown, warn: true });
  } else if (session.phase === 'coordinationBlocked') {
    badges.push({ text: t.badgeReconcile, warn: true });
  } else if (session.phase === 'loading') {
    badges.push({ text: t.badgeLoading });
  } else if (session.phase === 'saving') {
    badges.push({ text: t.badgeSaving });
  } else if (session.phase === 'committing') {
    badges.push({ text: t.badgeCommitting });
  } else if (session.phase === 'coordinating') {
    badges.push({ text: t.badgeCoordinating });
  } else if (session.phase === 'loadError') {
    badges.push({ text: t.badgeLoadError });
  } else if (dirty) {
    badges.push({ text: t.badgeDirty, warn: true });
  } else if (session.localModified) {
    badges.push({ text: t.badgeSavedPending });
  } else if (session.submittedRevision !== null) {
    badges.push({ text: t.badgeCommitted });
  } else {
    badges.push({ text: t.badgeReady });
  }
  badges.push({ text: format(t.rulesCount, { count: String(session.rules.length) }) });
  return badges;
}

function footerSummary(session: IgnoreSessionState, dirty: boolean): string {
  const t = strings.ignorePanel;
  switch (session.phase) {
    case 'unknown':
      return t.summaryUnknown;
    case 'coordinationBlocked':
      return t.summaryReconcile;
    case 'loading':
      return t.summaryLoading;
    case 'saving':
      return t.summarySaving;
    case 'committing':
      return t.summaryCommitting;
    case 'coordinating':
      return t.summaryCoordinating;
    default:
      break;
  }
  if (draftPending(session)) {
    return t.summaryPendingDraft;
  }
  if (dirty) {
    return session.rules.length > 0 ? t.summaryDirty : t.summaryDirtyCleared;
  }
  if (session.localModified) {
    return t.summaryLocalModified;
  }
  if (session.submittedRevision !== null) {
    return format(t.summaryCommitted, { revision: String(session.submittedRevision) });
  }
  return t.summaryClean;
}

function buildFooter(
  session: IgnoreSessionState,
  dirty: boolean,
  locked: boolean,
  loadError: boolean,
): FooterSpec {
  const t = strings.ignorePanel;
  const pendingDraft = draftPending(session);
  const commitDisabled = locked || loadError || pendingDraft || (!dirty && !session.localModified);
  const saveDisabled = locked || loadError || pendingDraft || !dirty;
  return {
    summary: footerSummary(session, dirty),
    primary: {
      id: 'submitIgnore',
      label: session.phase === 'committing' ? t.commitButtonBusy : t.commitButton,
      disabled: commitDisabled,
      disabledReason: commitDisabled && pendingDraft && !locked && !loadError
        ? t.saveBlockedByDraft
        : t.commitButtonReason,
    },
    secondary: [
      { id: 'closePanel', label: t.closeButton, disabled: locked },
      {
        id: 'saveIgnore',
        label: t.saveButton,
        disabled: saveDisabled,
        disabledReason: saveDisabled && pendingDraft && !locked && !loadError
          ? t.saveBlockedByDraft
          : t.saveButtonReason,
      },
    ],
  };
}

function buildEditor(
  session: IgnoreSessionState,
  dirty: boolean,
  locked: boolean,
  loadError: boolean,
): IgnoreEditorSpec {
  const t = strings.ignorePanel;
  const empty = loadError
    ? { title: t.emptyLoadError, detail: t.emptyLoadErrorDetail }
    : dirty
      ? { title: t.emptyCleared, detail: t.emptyClearedDetail, extra: t.emptyOtherSources }
      : { title: t.emptyUnset, detail: t.emptyUnsetDetail, extra: t.emptyOtherSources };
  const disableInput = locked || loadError;
  return {
    rules: session.rules.map((text, index) => ({ index, text })),
    listLabel: t.panelTitle,
    removeLabel: t.removeRuleLabel,
    empty,
    draft: {
      fieldId: 'draft',
      label: t.draftLabel,
      value: session.draft,
      placeholder: t.draftPlaceholder,
      disabled: disableInput,
    },
    addNote: t.addNote,
    originNote: session.originName !== null ? format(t.originNote, { name: session.originName }) : undefined,
    noOriginNote: session.originName === null ? t.noOriginNote : undefined,
    addAction: {
      id: 'addRule',
      label: t.addRule,
      disabled: disableInput || session.draft.length === 0,
      disabledReason: t.addRuleEmptyReason,
    },
    fillAction: session.originName !== null
      ? { id: 'fillOriginName', label: t.fillOriginName, disabled: disableInput }
      : undefined,
    busy: locked,
  };
}

function buildBanners(session: IgnoreSessionState, dirty: boolean): BannerSpec[] {
  const t = strings.ignorePanel;
  const banners: BannerSpec[] = [];
  const recoveryLocked = session.phase === 'unknown' || session.phase === 'coordinationBlocked';
  if (session.phase === 'unknown') {
    banners.push({
      id: 'unknown',
      level: 'warn',
      title: t.unknownBannerTitle,
      detail: t.unknownBannerDetail,
      actions: [{ id: 'resolveUnknown', label: t.verifyAction }],
    });
  }
  if (session.phase === 'coordinationBlocked') {
    banners.push({
      id: 'reconcile',
      level: 'warn',
      title: format(t.reconcileBannerTitle, { revision: String(session.operation?.knownRevisions[0] ?? session.submittedRevision ?? 0) }),
      detail: t.reconcileBannerDetail,
      actions: [{ id: 'resolveUnknown', label: t.reconcileResumeAction }],
    });
  }
  // 成功卡片：提交成功优先（含 revision 与范围说明），否则本机保存卡片。
  if (session.successVisible && session.submittedRevision !== null) {
    banners.push({
      id: 'commitSuccess',
      level: 'success',
      title: t.committedCardTitle,
      detail: format(
        session.localModified ? t.committedCardPendingDetail : t.committedCardDetail,
        { revision: String(session.submittedRevision) },
      ),
    });
  } else if (session.successVisible && session.localModified && !dirty && !recoveryLocked) {
    banners.push({
      id: 'commitSuccess',
      level: 'success',
      title: t.savedCardTitle,
      detail: t.savedCardDetail,
    });
  }
  if (session.error) {
    const title = session.phase === 'loadError'
      ? t.loadFailedTitle
      : session.errorKind === 'commit'
        ? t.commitFailedTitle
        : session.errorKind === 'external'
          ? t.externalModifiedTitle
          : t.saveFailedTitle;
    banners.push({
      id: 'error',
      level: 'error',
      title,
      detail: session.error,
      preformatted: true,
      actions: session.phase === 'loadError' ? [{ id: 'refresh', label: t.reload }] : undefined,
    });
  }
  if (session.notice && (!session.localModified || dirty || recoveryLocked)) {
    banners.push({ id: 'notice', level: 'info', title: session.notice });
  }
  return banners;
}

/** 会话状态 → P2 渲染态（徽标、页脚、编辑区、横幅全量派生）。 */
export function buildIgnorePanelState(session: IgnoreSessionState): PanelState {
  const dirty = dirtyOf(session);
  const busyPhase = ['loading', 'saving', 'committing', 'coordinating'].includes(session.phase);
  const locked = busyPhase || session.phase === 'unknown' || session.phase === 'coordinationBlocked';
  const loadError = session.phase === 'loadError';
  return {
    sessionId: session.sessionId,
    title: strings.ignorePanel.panelTitle,
    targetLabel: ignoreTargetLabel(session),
    revision: 0,
    formRevision: 0,
    busy: busyPhase,
    writeLocked: session.phase === 'unknown' || session.phase === 'coordinationBlocked',
    banners: buildBanners(session, dirty),
    headerBadges: headerBadges(session, dirty),
    headerActions: [
      { id: 'refresh', label: strings.ignorePanel.reload, disabled: locked },
    ],
    hint: strings.ignorePanel.hint,
    ignoreEditor: buildEditor(session, dirty, locked, loadError),
    footer: buildFooter(session, dirty, locked, loadError),
  };
}

/** 从操作记录恢复 P2 会话受限状态（打开面板时注册表仍限制该副本）。
 *  非 svn:ignore 的记录（提交面板的在途操作）归为 foreign：本面板只锁
 *  定保存/提交，核实入口在对应面板。 */
export function restrictionPhase(record: OperationRecord): 'unknown' | 'coordinationBlocked' | 'foreign' {
  if (!propertyOf(record)) {
    return 'foreign';
  }
  if (record.phase === 'unknown' || record.phase === 'saving' || record.phase === 'committing' || record.phase === 'prepared') {
    return 'unknown';
  }
  if (record.phase === 'committed-pending-coordination' || record.phase === 'coordination-blocked') {
    return 'coordinationBlocked';
  }
  return 'foreign';
}

/** 操作记录中的属性载荷（P2 单属性提交记录）；无属性的是其他面板的操作。 */
export function propertyOf(record: OperationRecord): PropertyRecord | undefined {
  return record.property?.name === 'svn:ignore' ? record.property : undefined;
}

/** 提交前的待提交快照（保存基线）。 */
export function pendingSnapshot(session: IgnoreSessionState): PropertySnapshot {
  return { rules: [...session.savedRules], exists: session.savedPropertyExists };
}
