/**
 * P1 提交面板的渲染态构建与选择规则（纯函数，不依赖 vscode）。
 *
 * 真相模型：宿主控制器持有 CommitSessionState（SVN 条目元信息 + 用户
 * 选择/筛选/说明），本模块把会话状态转换为 PanelState（ListSpec 树、
 * 分组、筛选、徽标、页脚、横幅）；选择、筛选、树结构都只在此派生，
 * 视图层没有第二份真相。
 *
 * 关键规则（交互清单 / 技术方案 §4、§14.4）：
 * - 路径与 changelist 名称一律原值（含首尾空格），展示文本不反向当身份；
 * - 默认勾选本地可提交项；未版本控制默认不选、可勾选为待添加；
 *   冲突与仅远端项不可勾选（给可读原因）；
 * - 嵌套工作副本按副本边界隔离（不可勾选），符号链接是叶节点；
 * - 删除/missing 目录勾选联动完整影响子树；未版本控制子项勾选联动
 *   必要父目录（unversioned/added 目录）；
 * - 导航目录只组织路径，不是提交目标；聚合勾选作用于筛选后子树。
 */
import { basename, relative } from 'node:path';
import type { StatusEntry } from '../../core/status';
import type { RemoteStatusEntry } from '../../core/remoteStatus';
import { matchesIgnoreRules } from '../../core/ignore';
import { format, strings } from '../i18n';
import type { CommitGroup, CommitPhase, CommitResult } from './fixture';
import type { ActionSpec, BannerSpec, FilterSpec, FooterSpec, ListSpec, PanelState, RowSpec } from './state';

/** 筛选值编码：真实值带前缀，与哨兵 all/unassigned/none/directory 不冲突。 */
export const EXT_NONE = 'none';
export const EXT_DIRECTORY = 'directory';
export const EXT_VALUE_PREFIX = 'value:';
export const CHANGELIST_UNASSIGNED = 'unassigned';
export const CHANGELIST_VALUE_PREFIX = 'name:';
/** 状态筛选的属性伪值（svn 没有 props 状态词，不会与原词冲突）。 */
export const STATUS_PROPS = 'props';

export interface CommitEntryMeta {
  /** 相对副本根的原始路径（含首尾空格），同时是条目 ID 与提交目标身份。 */
  path: string;
  wcStatus: string;
  kind: 'file' | 'dir';
  props: string;
  changelist: string | null;
  /** 提交前检查得到的远端状态原词；本地条目也可能带（本地+远端都有变化）。 */
  reposStatus?: string;
  group: CommitGroup;
  isSymlink: boolean;
  /** 嵌套工作副本（unversioned 目录下存在 .svn），按副本边界隔离。 */
  isNestedWc: boolean;
  /** 未版本控制目录枚举出的直接子项需要忽略判定时使用的目录规则。 */
  ignoredByParent?: boolean;
}

export interface CommitSessionState {
  sessionId: string;
  wcRoot: string;
  targetPath: string;
  /** 相对副本根的执行目标（'.' 表示根）。 */
  targetArg: string;
  metas: CommitEntryMeta[];
  selectedPaths: Set<string>;
  viewMode: 'tree' | 'list';
  filters: { status: string; ext: string; changelist: string };
  message: string;
  allowEmpty: boolean;
  prefixes: string[];
  history: string[];
  phase: CommitPhase;
  error: string | null;
  /** 错误来源分类（add 阶段失败的说明与普通提交失败不同）。 */
  errorKind?: 'add' | 'commit';
  result: CommitResult | null;
  /** 已登记 SVN 添加但未提交成功的路径（失败解释）。 */
  addedPrepared: string[];
  /** 已登记 SVN 删除但未提交成功的路径（失败解释）。 */
  missingPrepared: string[];
  initialMessage: string;
  initialSelectionKey: string;
  /** 本次数据是否包含远端分组（提交前检查开启时）。 */
  remoteIncluded: boolean;
  /** externals 边界目录（相对副本根）：其内部条目按副本边界隔离，不进面板。 */
  externalPrefixes: string[];
}

/* ------------------------- 分组与默认选择规则 ------------------------- */

/** 条目是否属于「本地可提交」集合（含纯属性修改）。 */
export function isLocalCommittable(meta: CommitEntryMeta): boolean {
  return (
    meta.group === 'local' &&
    (['modified', 'added', 'deleted', 'missing', 'replaced'].includes(meta.wcStatus) || meta.props === 'modified')
  );
}

/** 条目可否勾选；不可勾选时给出可读原因。 */
export function selectionDisabledReason(meta: CommitEntryMeta): string | undefined {
  if (meta.group === 'conflict') {
    return strings.panel.disabledConflict;
  }
  if (meta.group === 'remote') {
    return strings.panel.disabledRemote;
  }
  if (meta.isNestedWc) {
    return strings.panel.disabledNestedWc;
  }
  return undefined;
}

/** 默认选择：本地可提交项全选；未版本控制默认不选（可勾选为待添加）。 */
export function defaultSelectedPaths(metas: CommitEntryMeta[]): Set<string> {
  const selected = new Set<string>();
  for (const meta of metas) {
    if (isLocalCommittable(meta)) {
      selected.add(meta.path);
    }
  }
  return applyDirectoryLinkage(metas, selected);
}

/* --------------------------- 目录选择联动 --------------------------- */

function dirPrefix(dirPath: string): string {
  return dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
}

/** 路径的全部祖先目录（不含根 '.'，保持由近及远）。 */
export function ancestorDirs(path: string): string[] {
  const parts = path.split('/');
  const result: string[] = [];
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    result.push(parts.slice(0, i).join('/'));
  }
  return result;
}

/**
 * 目录选择联动：
 * 1. 删除/missing 目录被选 → 完整影响子树内可提交项全部选中；
 * 2. 未版本控制/新增子项被选 → 其未版本控制/新增祖先目录自动列为依赖。
 */
export function applyDirectoryLinkage(metas: CommitEntryMeta[], selected: Set<string>): Set<string> {
  const byPath = new Map(metas.map((meta) => [meta.path, meta]));
  const next = new Set(selected);
  for (const meta of metas) {
    if (meta.kind !== 'dir' || !next.has(meta.path)) {
      continue;
    }
    if (meta.wcStatus === 'deleted' || meta.wcStatus === 'missing') {
      const prefix = dirPrefix(meta.path);
      for (const other of metas) {
        if (other.path.startsWith(prefix) && !selectionDisabledReason(other) && isSelectableEntry(other)) {
          next.add(other.path);
        }
      }
    }
  }
  for (const meta of metas) {
    if (!next.has(meta.path)) {
      continue;
    }
    for (const ancestor of ancestorDirs(meta.path)) {
      const ancMeta = byPath.get(ancestor);
      if (
        ancMeta &&
        ancMeta.kind === 'dir' &&
        (ancMeta.wcStatus === 'unversioned' || ancMeta.wcStatus === 'added') &&
        !selectionDisabledReason(ancMeta)
      ) {
        next.add(ancestor);
      }
    }
  }
  return next;
}

/** 可提交勾选条目（unversioned 待添加 + 本地可提交）。 */
export function isSelectableEntry(meta: CommitEntryMeta): boolean {
  return meta.group === 'unversioned' ? !meta.isNestedWc : isLocalCommittable(meta);
}

/* --------------------------- 筛选值编码 --------------------------- */

export function statusFilterValue(meta: CommitEntryMeta): string {
  if (meta.wcStatus === 'normal' && meta.props === 'modified') {
    return STATUS_PROPS;
  }
  if (meta.group === 'remote' && (meta.wcStatus === 'none' || meta.wcStatus === 'normal')) {
    // 仅远端条目按远端状态参与筛选，本地 none 不进选项集合的语义。
    return meta.reposStatus ?? meta.wcStatus;
  }
  return meta.wcStatus;
}

export function extFilterValue(path: string, kind: 'file' | 'dir'): string {
  if (kind === 'dir') {
    return EXT_DIRECTORY;
  }
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) {
    return EXT_NONE;
  }
  return `${EXT_VALUE_PREFIX}${name.slice(dot + 1)}`;
}

export function changelistFilterValue(changelist: string | null): string {
  return changelist === null ? CHANGELIST_UNASSIGNED : `${CHANGELIST_VALUE_PREFIX}${changelist}`;
}

/** 条目是否命中三条件叠加筛选（筛选只改可见性，不改选择）。 */
export function entryMatchesFilters(meta: CommitEntryMeta, filters: CommitSessionState['filters']): boolean {
  const statusOk = filters.status === 'all' || statusFilterValue(meta) === filters.status;
  const extOk = filters.ext === 'all' || extFilterValue(meta.path, meta.kind) === filters.ext;
  const clOk = filters.changelist === 'all' || changelistFilterValue(meta.changelist) === filters.changelist;
  return statusOk && extOk && clOk;
}

export function visibleMetas(session: CommitSessionState): CommitEntryMeta[] {
  return session.metas.filter((meta) => entryMatchesFilters(meta, session.filters));
}

/* ------------------------------ 树构建 ------------------------------ */

interface PathNode {
  name: string;
  path: string;
  children: Map<string, PathNode>;
  leaves: CommitEntryMeta[];
}

/**
 * 构建一个分组的嵌套行树：导航目录节点（nav 标记）+ 条目行。
 * 目录条目行挂在自身路径的导航节点下（原型口径）；根条目（'.'）直接置顶。
 */
export function buildGroupRows(
  groupId: CommitGroup,
  metas: CommitEntryMeta[],
  selectedPaths: Set<string>,
): RowSpec[] {
  const root: PathNode = { name: '', path: '', children: new Map(), leaves: [] };
  const rootLeaves: CommitEntryMeta[] = [];
  for (const meta of metas) {
    if (meta.path === '.') {
      rootLeaves.push(meta);
      continue;
    }
    const parts = meta.path.split('/');
    const parents = meta.kind === 'dir' ? parts : parts.slice(0, -1);
    let node = root;
    for (const name of parents) {
      const path = node.path ? `${node.path}/${name}` : name;
      let child = node.children.get(name);
      if (!child) {
        child = { name, path, children: new Map(), leaves: [] };
        node.children.set(name, child);
      }
      node = child;
    }
    node.leaves.push(meta);
  }

  const toRows = (node: PathNode): RowSpec[] => {
    const rows: RowSpec[] = [];
    for (const child of node.children.values()) {
      const hasContent =
        child.leaves.length > 0 || [...child.children.values()].some((descendant) => descendant.leaves.length > 0);
      if (!hasContent) {
        continue;
      }
      rows.push({
        id: `${groupId}|${child.path}`,
        group: groupId,
        nav: { path: child.path },
        children: toRows(child),
        cells: {},
      });
    }
    rows.push(...node.leaves.map((meta) => entryRow(meta, groupId, selectedPaths)));
    return rows;
  };

  const rows = toRows(root);
  // 根条目（'.'）在分组内置顶展示。
  return [...rootLeaves.map((meta) => entryRow(meta, groupId, selectedPaths)), ...rows];
}

function directoryLabel(meta: CommitEntryMeta): string {
  if (meta.path === '.') {
    return strings.panel.rootEntryLabel;
  }
  if (meta.wcStatus === 'unversioned') {
    return strings.panel.badgeDirToAdd;
  }
  if (meta.wcStatus === 'added') {
    return strings.panel.badgeDirAdded;
  }
  if (meta.wcStatus === 'deleted' || meta.wcStatus === 'missing') {
    return strings.panel.badgeDirToDelete;
  }
  if (meta.props === 'modified') {
    return strings.panel.badgeDirProperty;
  }
  // 无属性变化又出现在列表中的目录（防御分支）：展示目录名。
  return basename(meta.path);
}

function entryRow(meta: CommitEntryMeta, groupId: CommitGroup, selectedPaths: Set<string>): RowSpec {
  const disabledReason = selectionDisabledReason(meta);
  const badges: NonNullable<RowSpec['badges']> = [];
  if (meta.changelist !== null) {
    badges.push({ text: meta.changelist });
  }
  if (meta.props === 'modified') {
    badges.push({ text: strings.commit.propModified });
  }
  if (meta.group === 'unversioned' && selectedPaths.has(meta.path)) {
    badges.push({ text: strings.panel.badgePendingAdd, kind: 'warn' });
  }
  if (meta.wcStatus === 'missing') {
    badges.push({ text: strings.panel.badgePendingDelete, kind: 'warn' });
  }
  if (meta.kind === 'dir' && meta.path !== '.') {
    badges.push({ text: directoryLabel(meta) });
  }
  if (meta.isSymlink) {
    badges.push({ text: strings.panel.badgeSymlink });
  }
  if (meta.isNestedWc) {
    badges.push({ text: strings.panel.badgeNestedWc, kind: 'warn' });
  }
  if (meta.reposStatus && meta.group === 'local') {
    badges.push({ text: strings.panel.badgeRemoteUpdate, kind: 'warn' });
  }

  const diffDisabled =
    meta.wcStatus === 'unversioned' ||
    meta.wcStatus === 'missing' ||
    (meta.kind === 'dir' && meta.props !== 'modified');
  const diffReason = meta.wcStatus === 'unversioned'
    ? strings.panel.actDiffNoBase
    : meta.wcStatus === 'missing'
      ? strings.panel.actDiffMissing
      : meta.kind === 'dir'
        ? strings.panel.actDiffDir
        : undefined;
  const actions: ActionSpec[] = [
    { id: 'openDiff', label: strings.panel.actDiff, disabled: diffDisabled, disabledReason: diffReason ?? strings.panel.actDiff },
  ];
  actions.push({
    id: 'rowMore',
    label: strings.panel.actMoreLabel,
    disabledReason: format(strings.panel.actMore, { path: meta.path }),
  });

  return {
    id: meta.path,
    group: groupId,
    label: meta.kind === 'dir' ? directoryLabel(meta) : basename(meta.path),
    cells: {
      path: meta.path,
      status: meta.wcStatus,
      filterStatus: statusFilterValue(meta),
      ext: extFilterValue(meta.path, meta.kind),
      changelist: changelistFilterValue(meta.changelist),
    },
    badges,
    selected: selectedPaths.has(meta.path),
    disabled: disabledReason !== undefined,
    disabledReason,
    actions,
  };
}

/* --------------------------- 面板状态构建 --------------------------- */

const GROUP_ORDER: CommitGroup[] = ['local', 'unversioned', 'conflict', 'remote'];

export function buildFilterSpecs(session: CommitSessionState): FilterSpec[] {
  const statuses = new Set(session.metas.map((meta) => statusFilterValue(meta)));
  const exts = new Set(session.metas.map((meta) => extFilterValue(meta.path, meta.kind)));
  const cls = new Set(session.metas.map((meta) => meta.changelist).filter((cl): cl is string => cl !== null));
  const statusOrder = ['modified', 'added', 'deleted', 'missing', 'replaced', STATUS_PROPS, 'unversioned', 'conflicted'];
  const labels = strings.panel.statusFilterLabels as Record<string, string>;
  return [
    {
      id: 'status',
      cellKey: 'filterStatus',
      value: session.filters.status,
      options: [
        { value: 'all', label: strings.panel.filterStatusAll },
        ...statusOrder.filter((value) => statuses.has(value)).map((value) => ({
          value,
          label: labels[value] ?? value,
        })),
      ],
    },
    {
      id: 'ext',
      cellKey: 'ext',
      value: session.filters.ext,
      options: [
        { value: 'all', label: strings.panel.filterExtAll },
        { value: EXT_NONE, label: strings.panel.filterExtNone },
        { value: EXT_DIRECTORY, label: strings.panel.filterExtDirectory },
        ...[...exts]
          .filter((ext) => ext.startsWith(EXT_VALUE_PREFIX))
          .sort()
          .map((ext) => ({ value: ext, label: `.${ext.slice(EXT_VALUE_PREFIX.length)}` })),
      ],
    },
    {
      id: 'changelist',
      cellKey: 'changelist',
      value: session.filters.changelist,
      options: [
        { value: 'all', label: strings.panel.filterChangelistAll },
        { value: CHANGELIST_UNASSIGNED, label: strings.panel.filterChangelistUnassigned },
        ...[...cls].sort().map((cl) => ({ value: `${CHANGELIST_VALUE_PREFIX}${cl}`, label: cl })),
      ],
    },
  ];
}

/** 会话状态 → 宿主渲染状态（标题、树、分组、筛选、页脚、横幅全量派生）。 */
export function buildPanelState(session: CommitSessionState): PanelState {
  const busyPhase = session.phase === 'loading' || session.phase === 'refreshing' || session.phase === 'checking' || session.phase === 'committing';
  const locked = busyPhase || session.phase === 'unknown';
  const selectedMetas = session.metas.filter((meta) => session.selectedPaths.has(meta.path));
  const visible = visibleMetas(session);
  const hiddenSelected = selectedMetas.filter((meta) => !visible.some((v) => v.path === meta.path)).length;

  const groups = GROUP_ORDER.map((groupId) => {
    const groupMetas = session.metas.filter((meta) => meta.group === groupId);
    const label = groupLabel(groupId);
    const rows = buildGroupRows(groupId, groupMetas, session.selectedPaths);
    return { groupId, label, rows, groupMetas };
  }).filter((group) => group.groupMetas.length > 0);

  const rows: RowSpec[] = groups.flatMap((group) => group.rows);
  const selectionCount = selectedMetas.length;
  const conflictMetas = session.metas.filter((meta) => meta.group === 'conflict');

  const list: ListSpec = {
    id: 'commit',
    columns: [
      { key: 'status', label: strings.panel.filterStatus },
      { key: 'path', label: 'path' },
    ],
    groups: groups.map((group) => ({ id: group.groupId, label: group.label })),
    rows,
    viewMode: session.viewMode,
    filters: buildFilterSpecs(session),
    selectionActions: buildSelectionActions(session, selectionCount, locked),
    selection: { total: selectionCount, visible: selectionCount - hiddenSelected, hidden: hiddenSelected },
    empty: {
      title: strings.panel.emptyTitle,
      detail: strings.panel.emptyDetail,
      action: { id: 'refresh', label: strings.panel.refresh, disabled: locked },
    },
    filterEmpty: {
      title: strings.panel.filterEmptyTitle,
      detail: strings.panel.filterEmptyDetail,
      action: { id: 'clearFilters', label: strings.panel.clearFilter, disabled: locked },
    },
  };

  return {
    sessionId: session.sessionId,
    title: strings.panel.commitPanelTitle,
    targetLabel: targetLabelOf(session),
    revision: 0,
    formRevision: 0,
    busy: busyPhase,
    writeLocked: session.phase === 'unknown',
    banners: buildBanners(session, selectedMetas, conflictMetas),
    list,
    form: buildForm(session, locked),
    footer: buildFooter(session, selectedMetas, hiddenSelected, conflictMetas.length > 0, locked),
  };
}

function groupLabel(groupId: CommitGroup): string {
  switch (groupId) {
    case 'local':
      return strings.panel.groupLocal;
    case 'unversioned':
      return strings.panel.groupUnversioned;
    case 'conflict':
      return strings.panel.groupConflict;
    case 'remote':
      return strings.panel.groupRemote;
  }
}

export function targetLabelOf(session: CommitSessionState): string {
  const name = basename(session.wcRoot) || session.wcRoot;
  const rel = relative(session.wcRoot, session.targetPath) || '.';
  return rel === '.'
    ? format(strings.panel.targetLabelRoot, { name })
    : format(strings.panel.targetLabelPath, { name, rel });
}

function buildForm(session: CommitSessionState, locked: boolean): PanelState['form'] {
  const tools: ActionSpec[] = session.prefixes.slice(0, 3).map((prefix, index) => ({
    id: 'applyPrefix',
    label: prefix,
    payload: { index: String(index) },
  }));
  tools.push({ id: 'managePrefixes', label: strings.panel.prefixManage });
  tools.push({ id: 'showHistory', label: strings.panel.historyButton });
  return {
    id: 'message',
    busy: locked,
    fields: [
      {
        id: 'message',
        label: strings.panel.messageLabel,
        value: session.message,
        type: 'textarea',
        help: session.allowEmpty ? strings.panel.messagePolicyOptional : strings.panel.messagePolicyRequired,
        disabled: locked,
      },
    ],
    tools: tools.map((tool) => ({ ...tool, disabled: locked })),
  };
}

function buildSelectionActions(session: CommitSessionState, selectionCount: number, locked: boolean): ActionSpec[] {
  const actions: ActionSpec[] = [
    { id: 'selectVisible', label: strings.panel.selectVisible, disabled: locked },
  ];
  if (selectionCount > 0) {
    actions.push({ id: 'clearSelection', label: strings.panel.clearSelection, disabled: locked });
  }
  if (session.filters.changelist.startsWith(CHANGELIST_VALUE_PREFIX)) {
    const name = session.filters.changelist.slice(CHANGELIST_VALUE_PREFIX.length);
    actions.push({
      id: 'selectChangelist',
      label: format(strings.panel.selectChangelistGroup, { name }),
      disabled: locked,
    });
  }
  return actions;
}

function buildFooter(
  session: CommitSessionState,
  selectedMetas: CommitEntryMeta[],
  hiddenSelected: number,
  hasConflict: boolean,
  locked: boolean,
): FooterSpec {
  const pendingAdd = selectedMetas.filter((meta) => meta.group === 'unversioned').length;
  let summary: string;
  if (session.phase === 'unknown') {
    summary = strings.panel.footerUnknown;
  } else if (session.phase === 'checking') {
    summary = strings.panel.submitBusyChecking;
  } else if (session.phase === 'committing') {
    summary = strings.panel.submitBusyCommitting;
  } else if (session.phase === 'loading' || session.phase === 'refreshing') {
    summary = strings.panel.busy;
  } else {
    const pending = pendingAdd > 0 ? format(strings.panel.footerPendingAdd, { count: String(pendingAdd) }) : '';
    const hidden = hiddenSelected > 0 ? format(strings.panel.footerHidden, { count: String(hiddenSelected) }) : '';
    summary = format(strings.panel.footerSummary, {
      count: String(selectedMetas.length),
      pending,
      hidden,
      chars: String(session.message.length),
    });
  }

  const emptyMessageBlocked = !session.allowEmpty && session.message.trim() === '';
  let disabled = false;
  let reason: string | undefined;
  if (session.phase === 'unknown') {
    disabled = true;
    reason = strings.panel.submitDisabledUnknown;
  } else if (locked) {
    disabled = true;
  } else if (session.phase === 'stale' || session.phase === 'loadError') {
    disabled = true;
    reason = session.phase === 'stale' ? strings.panel.submitDisabledStale : undefined;
  } else if (hasConflict) {
    disabled = true;
    reason = strings.panel.submitDisabledConflict;
  } else if (selectedMetas.length === 0) {
    disabled = true;
    reason = strings.panel.submitDisabledNoSelection;
  } else if (emptyMessageBlocked) {
    disabled = true;
    reason = strings.panel.submitDisabledEmptyMessage;
  }

  return {
    summary,
    primary: {
      id: 'submit',
      label:
        session.phase === 'unknown'
          ? strings.panel.submitDisabledUnknown
          : format(strings.panel.submitLabel, { count: String(selectedMetas.length) }),
      disabled,
      disabledReason: reason,
    },
    secondary: [{ id: 'closePanel', label: strings.panel.closeButton, disabled: locked }],
  };
}

function buildBanners(
  session: CommitSessionState,
  selectedMetas: CommitEntryMeta[],
  conflictMetas: CommitEntryMeta[],
): BannerSpec[] {
  const banners: BannerSpec[] = [];
  if (session.phase === 'unknown') {
    banners.push({
      id: 'unknown',
      level: 'warn',
      title: strings.panel.unknownBannerTitle,
      detail: strings.panel.unknownBannerDetail,
      actions: [{ id: 'resolveUnknown', label: strings.panel.verifyAction }],
    });
  }
  if (session.result?.kind === 'success') {
    const revisions = session.result.revisions.join('、r');
    banners.push({
      id: 'commitSuccess',
      level: 'success',
      title: strings.panel.successCardTitle,
      detail: format(strings.panel.successCardDetail, {
        count: String(session.result.committedIds.length),
        revisions: `r${revisions}`,
      }),
    });
  } else if (session.result?.kind === 'partial') {
    const revisions = session.result.revisions.map((revision) => `r${revision}`).join('、');
    banners.push({
      id: 'partial',
      level: 'warn',
      title: format(strings.panel.partialBannerTitle, {
        committed: String(session.result.committedIds.length),
        remaining: String(selectedMetas.length),
      }),
      detail: format(strings.panel.partialBannerDetail, { revisions }),
    });
  }
  if (session.error) {
    banners.push({
      id: 'error',
      level: 'error',
      title:
        session.phase === 'stale'
          ? strings.panel.refreshFailedTitle
          : session.phase === 'loadError'
            ? format(strings.panel.loadFailed, { message: session.error.split('\n')[0] ?? '' })
            : session.errorKind === 'add'
              ? strings.panel.addFailedTitle
              : strings.panel.commitFailedTitle,
      detail: session.error,
      preformatted: true,
      actions: session.phase === 'stale' || session.phase === 'loadError'
        ? [{ id: 'refresh', label: strings.panel.refresh }]
        : undefined,
    });
  }
  if (session.phase === 'stale') {
    banners.push({
      id: 'stale',
      level: 'warn',
      title: strings.panel.refreshFailedTitle,
      detail: strings.panel.refreshFailedDetail,
      actions: [{ id: 'refresh', label: strings.panel.refresh }],
    });
  }
  if (conflictMetas.length > 0) {
    banners.push({
      id: 'conflict',
      level: 'warn',
      title: strings.panel.conflictBanner,
      detail: conflictMetas.map((meta) => meta.path).join('\n'),
      preformatted: true,
    });
  }
  const missingSelected = selectedMetas.filter((meta) => meta.wcStatus === 'missing');
  if (missingSelected.length > 0) {
    banners.push({
      id: 'missing',
      level: 'warn',
      title: format(strings.panel.missingBanner, { count: String(missingSelected.length) }),
    });
  }
  if (session.addedPrepared.length > 0) {
    banners.push({
      id: 'addedPrepared',
      level: 'warn',
      title: format(strings.panel.addedPreparedBanner, { count: String(session.addedPrepared.length) }),
    });
  }
  if (session.missingPrepared.length > 0) {
    banners.push({
      id: 'missingPrepared',
      level: 'warn',
      title: format(strings.panel.missingPreparedBanner, { count: String(session.missingPrepared.length) }),
    });
  }
  return banners;
}

/* --------------------------- 前缀与说明 --------------------------- */

/** 应用前缀：替换开头已应用的任何前缀，不叠加相同前缀。 */
export function applyPrefixToMessage(message: string, prefixes: string[], prefix: string): string {
  let rest = message;
  for (const candidate of prefixes) {
    for (const sep of ['：', ':']) {
      if (rest.startsWith(`${candidate}${sep}`)) {
        rest = rest.slice(candidate.length + sep.length);
        return `${prefix}${sep}${rest}`;
      }
    }
  }
  return `${prefix}：${message}`;
}

/** 未版本控制目录的直接子项名（枚举真实磁盘；忽略项按目录规则排除）。 */
export function filterIgnoredChildren(names: string[], ignoreRules: string[]): string[] {
  return names.filter((name) => !matchesIgnoreRules(name, ignoreRules));
}

/** 会话草稿是否相对打开时有变化（关闭前确认用）。 */
export function sessionChanged(session: CommitSessionState): boolean {
  if (session.message !== session.initialMessage) {
    return true;
  }
  return selectionKeyOf(session.selectedPaths) !== session.initialSelectionKey;
}

export function selectionKeyOf(paths: Set<string>): string {
  return [...paths].sort().join('|');
}

/* ------------------------- 本地/远端条目合并 ------------------------- */

/**
 * 把本地 status 条目与远端检查结果合并为面板条目：
 * - conflicted → 冲突组；unversioned → 未版本控制组；
 * - 本地有可提交变化 → 本地变更组（若同时远端有变化，附远端徽标）；
 * - 本地无变化而远端有 → 仅远端变更组（不可勾选）；
 * - 其余（本地远端都无变化）不进面板。
 */
export function mergeStatusEntries(
  local: StatusEntry[],
  remote: RemoteStatusEntry[] | undefined,
  externalPrefixes: string[] = [],
): CommitEntryMeta[] {
  // externals 边界：外部副本内部的条目（svn status 会递归列出）不进本面板，
  // 提交范围按副本边界隔离。
  const insideExternal = (path: string) =>
    externalPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  const remoteByPath = new Map<string, string>();
  if (remote) {
    for (const entry of remote) {
      if (entry.reposStatus && entry.reposStatus !== 'none' && entry.reposStatus !== 'external') {
        remoteByPath.set(entry.path, entry.reposStatus);
      }
    }
  }
  const metas: CommitEntryMeta[] = [];
  const seen = new Set<string>();
  for (const entry of local) {
    if (seen.has(entry.path) || insideExternal(entry.path)) {
      continue;
    }
    seen.add(entry.path);
    const reposStatus = remoteByPath.get(entry.path);
    const hasLocalChange =
      ['modified', 'added', 'deleted', 'missing', 'replaced', 'conflicted', 'unversioned'].includes(entry.wcStatus) ||
      entry.props === 'modified';
    let group: CommitGroup;
    if (entry.wcStatus === 'conflicted') {
      group = 'conflict';
    } else if (entry.wcStatus === 'unversioned') {
      group = 'unversioned';
    } else if (hasLocalChange) {
      group = 'local';
    } else if (reposStatus !== undefined) {
      group = 'remote';
    } else {
      continue;
    }
    metas.push({
      path: entry.path,
      wcStatus: entry.wcStatus,
      kind: entry.kind === 'dir' ? 'dir' : 'file',
      props: entry.props ?? 'none',
      changelist: entry.changelist ?? null,
      reposStatus,
      group,
      isSymlink: false,
      isNestedWc: false,
    });
  }
  if (remote) {
    for (const [path, reposStatus] of remoteByPath) {
      if (seen.has(path) || insideExternal(path)) {
        continue;
      }
      // 仅远端条目没有本地元信息，按文件行展示（不可勾选、无本地差异）。
      metas.push({
        path,
        wcStatus: 'none',
        kind: 'file',
        props: 'none',
        changelist: null,
        reposStatus,
        group: 'remote',
        isSymlink: false,
        isNestedWc: false,
      });
    }
  }
  return metas;
}
