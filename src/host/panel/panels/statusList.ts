/**
 * 冒烟只读列表面板（阶段 0 基座示例）：数据链路与「显示状态」同源
 * （runStatus，以副本根为 cwd 的相对目标），渲染进 Webview 面板。
 *
 * 用它验证：CSP/nonce、消息往返、会话代次、同目标复用、忙碌拒绝切换、
 * 隐藏重建、行内差异（视图只传条目 ID，路径由宿主映射）。
 * 列表行勾选在本面板只是界面状态（不产生任何 SVN 写）；
 * 说明输入用于验证输入同步与焦点/光标保持。
 */
import * as vscode from 'vscode';
import { basename, join, relative } from 'node:path';
import { runStatus, type StatusEntry } from '../../../core/status';
import { readSvnPath, readTimeoutMs } from '../../config';
import { format, strings } from '../../i18n';
import { logCommand, logExitCode } from '../../output';
import { diffOutcomeNotice, openEntryDiff, type DiffTarget } from '../../diffView';
import { resolveWorkingCopyTarget, type WcTarget } from '../../commands/target';
import { createPanel, type PanelHandle } from '../host';
import type { Intent } from '../protocol';
import { reduce, type FormSpec, type ListSpec, type PanelState, type RowSpec } from '../state';

const PANEL_ID = 'status-list';

/** 后缀筛选值编码：真实后缀带 value: 前缀，与哨兵 all/none/directory 不冲突。 */
const EXT_NONE = 'none';
const EXT_DIRECTORY = 'directory';
const EXT_VALUE_PREFIX = 'value:';

function extFilterValue(entry: StatusEntry): string {
  if (entry.kind === 'dir') {
    return EXT_DIRECTORY;
  }
  const name = basename(entry.path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) {
    return EXT_NONE;
  }
  return `${EXT_VALUE_PREFIX}${name.slice(dot + 1)}`;
}

/** 控制器持有的会话级数据：条目 ID → 原始路径的宿主侧映射。 */
interface SessionData {
  target: WcTarget;
  entries: StatusEntry[];
}

let handle: PanelHandle | undefined;
let panelState: PanelState | undefined;
let sessionData: SessionData | undefined;
let panelContext: { extensionUri: vscode.Uri; subscriptions: vscode.Disposable[] } | undefined;

/** activate 时注入宿主上下文（面板创建需要 extensionUri 与 subscriptions）。 */
export function setStatusPanelContext(context: { extensionUri: vscode.Uri; subscriptions: vscode.Disposable[] }): void {
  panelContext = context;
}

/** 面板命令入口：同目标复用；新目标先切换会话，忙碌时拒绝切换。 */
export async function commandShowStatusPanel(uri?: vscode.Uri): Promise<void> {
  const target = await resolveWorkingCopyTarget(uri, strings.command.showStatusPanel);
  if (!target || !panelContext) {
    return;
  }

  const sameTarget =
    sessionData?.target.targetPath === target.targetPath && sessionData?.target.wcRoot === target.wcRoot;
  if (handle && sameTarget) {
    // 同目标复用：reveal 并保留当前状态与输入草稿。
    handle.reveal();
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
    { title: strings.panel.statusListTitle, retainContextWhenHidden: false },
    { onIntent, onDispose: onPanelDispose },
    panelContext,
  );

  await loadSession(handle.sessionId, target, { initial: true });
}

function onPanelDispose(): void {
  handle = undefined;
  panelState = undefined;
  sessionData = undefined;
}

function entryById(itemId: string): StatusEntry | undefined {
  // ID 即条目原始路径（含首尾空格）；路径只从宿主侧映射取，不信任视图传值。
  return sessionData?.entries.find((entry) => entry.path === itemId);
}

/** 读取目标状态并推送渲染；initial 为 true 是会话首帧（先推忙碌态）。 */
async function loadSession(sessionId: string, target: WcTarget, options: { initial: boolean }): Promise<void> {
  if (options.initial) {
    pushState(reduce(blankState(sessionId, target), { type: 'host:beginBusy' }));
  } else {
    pushState(reduce(panelState ?? blankState(sessionId, target), { type: 'host:beginBusy' }));
  }
  const svnPath = readSvnPath();
  const targetArg = relative(target.wcRoot, target.targetPath) || '.';
  logCommand(svnPath, ['status', '--xml', targetArg], target.wcRoot);
  try {
    const result = await runStatus(svnPath, targetArg, {
      cwd: target.wcRoot,
      timeoutMs: readTimeoutMs(),
      onExit: logExitCode,
    });
    if (!handle || handle.sessionId !== sessionId) {
      return; // 目标已切换：迟到结果不写入新会话。
    }
    sessionData = { target, entries: result.entries };
    const fresh = buildState(sessionId, target, result.entries);
    pushState(reduce(mergeUserInputs(fresh), { type: 'host:endBusy' }));
  } catch (err) {
    if (!handle || handle.sessionId !== sessionId) {
      return;
    }
    sessionData ??= { target, entries: [] };
    const failed = reduce(mergeUserInputs(buildState(sessionId, target, sessionData.entries)), {
      type: 'host:endBusy',
    });
    pushState(withLoadError(failed, err));
  }
}

/** 刷新保留用户输入与筛选（读取失败 ≠ 无变更，也不清空已展示内容）。 */
function mergeUserInputs(fresh: PanelState): PanelState {
  if (!panelState) {
    return fresh;
  }
  const form = retainFormValues(fresh.form, panelState.form);
  const list = retainFilterValues(fresh.list, panelState.list);
  return { ...fresh, formRevision: Math.max(fresh.formRevision, panelState.formRevision), form, list };
}

function retainFormValues(fresh: FormSpec | undefined, previous: FormSpec | undefined): FormSpec | undefined {
  if (!fresh || !previous) {
    return fresh;
  }
  return {
    ...fresh,
    fields: fresh.fields.map((field) => ({
      ...field,
      value: previous.fields.find((candidate) => candidate.id === field.id)?.value ?? field.value,
    })),
  };
}

function retainFilterValues(fresh: ListSpec | undefined, previous: ListSpec | undefined): ListSpec | undefined {
  if (!fresh || !previous) {
    return fresh;
  }
  const filters = fresh.filters?.map((filter) => ({
    ...filter,
    value: previous.filters?.find((candidate) => candidate.id === filter.id)?.value ?? filter.value,
  }));
  return filters ? { ...fresh, filters } : fresh;
}

function withLoadError(state: PanelState, err: unknown): PanelState {
  const message = err instanceof Error ? err.message : String(err);
  return {
    ...state,
    banners: [
      ...state.banners.filter((banner) => banner.id !== 'loadError'),
      {
        id: 'loadError',
        level: 'error',
        title: format(strings.panel.loadFailed, { message: message.split('\n')[0] ?? '' }),
        preformatted: true,
        detail: message,
      },
    ],
  };
}

function blankState(sessionId: string, target: WcTarget): PanelState {
  return {
    sessionId,
    title: strings.panel.statusListTitle,
    targetLabel: labelFor(target),
    revision: 0,
    formRevision: 0,
    busy: false,
    banners: [],
  };
}

function labelFor(target: WcTarget): string {
  return basename(target.targetPath) || target.targetPath;
}

/** 由状态条目构造渲染状态（筛选选项、行内动作按条目能力推导）。 */
function buildState(sessionId: string, target: WcTarget, entries: StatusEntry[]): PanelState {
  const statuses = [...new Set(entries.map((entry) => entry.wcStatus))];
  const exts = [...new Set(entries.map((entry) => extFilterValue(entry)))];
  const rows: RowSpec[] = entries.map((entry) => ({
    id: entry.path,
    cells: { path: entry.path, status: entry.wcStatus, ext: extFilterValue(entry) },
    selected: false,
    badges: entry.props === 'modified' ? [{ text: strings.commit.propModified }] : undefined,
    actions: rowActions(entry),
  }));
  return {
    sessionId,
    title: strings.panel.statusListTitle,
    targetLabel: labelFor(target),
    revision: 0,
    formRevision: 0,
    busy: false,
    banners: [],
    form: {
      id: 'message',
      busy: false,
      fields: [
        {
          id: 'message',
          label: strings.panel.messageLabel,
          value: '',
          type: 'textarea',
          help: strings.panel.messageHelp,
        },
      ],
    },
    list: {
      id: 'status',
      columns: [
        { key: 'status', label: strings.panel.filterStatus },
        { key: 'path', label: 'path' },
      ],
      rows,
      filters: [
        {
          id: 'status',
          cellKey: 'status',
          value: 'all',
          options: [
            { value: 'all', label: strings.panel.filterAll },
            ...statuses.map((status) => ({ value: status, label: status })),
          ],
        },
        {
          id: 'ext',
          cellKey: 'ext',
          value: 'all',
          options: [
            { value: 'all', label: strings.panel.filterAll },
            { value: EXT_NONE, label: strings.panel.filterExtNone },
            { value: EXT_DIRECTORY, label: strings.panel.filterExtDirectory },
            ...exts
              .filter((ext) => ext.startsWith(EXT_VALUE_PREFIX))
              .sort()
              .map((ext) => ({ value: ext, label: ext.slice(EXT_VALUE_PREFIX.length) })),
          ],
        },
      ],
      selection: { total: 0, visible: 0, hidden: 0 },
      empty: { title: strings.panel.emptyTitle, detail: strings.panel.emptyDetail },
      filterEmpty: {
        title: strings.panel.filterEmptyTitle,
        detail: strings.panel.filterEmptyDetail,
        action: { id: 'clearFilters', label: strings.panel.clearFilter },
      },
    },
  };
}

/** 行内动作：常驻「差异 + 打开」；差异能力按条目状态禁用并给可读原因。 */
function rowActions(entry: StatusEntry): NonNullable<RowSpec['actions']> {
  const diffDisabled =
    entry.wcStatus === 'unversioned' ||
    entry.wcStatus === 'missing' ||
    (entry.kind === 'dir' && entry.props !== 'modified');
  const reason =
    entry.wcStatus === 'unversioned'
      ? strings.panel.actDiffNoBase
      : entry.wcStatus === 'missing'
        ? strings.panel.actDiffMissing
        : entry.kind === 'dir'
          ? strings.panel.actDiffDir
          : strings.panel.actDiff;
  const actions: NonNullable<RowSpec['actions']> = [
    { id: 'openDiff', label: strings.panel.actDiff, disabled: diffDisabled, disabledReason: reason },
  ];
  if (entry.wcStatus !== 'deleted' && entry.wcStatus !== 'missing') {
    actions.push({ id: 'openFile', label: strings.panel.actOpen });
  }
  return actions;
}

function pushState(next: PanelState): void {
  panelState = next;
  handle?.update(next);
}

/** 意图分发：写意图先过宿主 busy/能力校验（host.ts），这里做业务决策。 */
async function onIntent(intent: Intent, context: { sessionId: string; busy: boolean }): Promise<void> {
  if (!handle || !panelState || !sessionData) {
    return;
  }
  switch (intent.kind) {
    case 'refresh':
      await loadSession(context.sessionId, sessionData.target, { initial: false });
      return;
    case 'openDiff': {
      const entry = entryById(intent.itemId);
      if (!entry) {
        return;
      }
      const diffTarget: DiffTarget = {
        svnPath: readSvnPath(),
        wcRoot: sessionData.target.wcRoot,
        relPath: entry.path,
        wcStatus: entry.wcStatus,
        props: entry.props,
        kind: entry.kind,
      };
      const outcome = await openEntryDiff(diffTarget);
      const notice = diffOutcomeNotice(outcome, diffTarget);
      if (notice) {
        handle.toast('info', notice);
      }
      return;
    }
    case 'openFile': {
      const entry = entryById(intent.itemId);
      if (!entry || entry.wcStatus === 'deleted' || entry.wcStatus === 'missing') {
        return;
      }
      await vscode.commands.executeCommand(
        'vscode.open',
        vscode.Uri.file(join(sessionData.target.wcRoot, entry.path)),
        { preview: false },
      );
      return;
    }
    case 'toggleRow':
      pushState(reduce(panelState, { type: 'intent:toggleRow', rowId: intent.rowId, selected: intent.selected }));
      return;
    case 'setFilter':
      pushState(reduce(panelState, { type: 'intent:setFilter', filterId: intent.filterId, value: intent.value }));
      return;
    case 'clearFilters': {
      let next = panelState;
      for (const filter of panelState.list?.filters ?? []) {
        next = reduce(next, { type: 'intent:setFilter', filterId: filter.id, value: 'all' });
      }
      pushState(next);
      return;
    }
    case 'dismissBanner':
      pushState(reduce(panelState, { type: 'intent:dismissBanner', bannerId: intent.bannerId }));
      return;
    case 'syncInput':
      // 输入同步只更新状态与 formRevision，不逐键重绘。
      panelState = reduce(panelState, { type: 'intent:syncInput', fieldId: intent.fieldId, value: intent.value });
      return;
    case 'bannerAction':
      return;
  }
}
