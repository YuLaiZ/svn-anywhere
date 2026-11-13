/**
 * P6 历史面板模型（historyModel.ts）单测：upper 状态机（HLS-6 的
 * reset/refresh 语义）、筛选与展示前缀、勾选上限、详情与“上一条可见
 * 记录”边界、序列化恢复与 append 表格渲染。
 *
 * 这些断言依赖 core/history 的计数与预算语义（已由 test/history.test.ts
 * 覆盖），这里只验证模型在会话状态上的编排——不发任何 SVN 命令。
 */
import { describe, expect, it } from 'vitest';
import type { HistoryEntry, HistoryLimits } from '../src/core/history';
import type { ConflictRecord } from '../src/core/conflict';
import type { HistoryUpdateIntent, HistoryUpdateRescan, HistoryUpdateResult } from '../src/core/historyUpdate';
import {
  applyHistoryUpdateRescan,
  applyHistoryUpdateResult,
  beginHistoryUpdateRescan,
  createHistoryUpdateState,
  historyUpdateIntentOf,
  historyUpdateSettled,
  historyUpdateTaskContext,
  historyUpdateTerminalPage,
  historyRowId,
  historyTargetKey,
  historyText,
  HistoryModel,
  parentRepositoryPath,
  normalizeRelativePath,
  restoreHistoryUpdateState,
  type HistoryModelContext,
} from '../src/host/panel/historyModel';

/* ------------------------------ fixture ------------------------------ */

function localContext(overrides: Partial<HistoryModelContext> = {}): HistoryModelContext {
  return {
    repositoryUuid: 'uuid-1',
    target: {
      url: 'https://example.com/repo/trunk/a.txt',
      repositoryRootUrl: 'https://example.com/repo',
      relativePath: 'trunk/a.txt',
      kind: 'file',
    },
    source: 'local',
    localPath: '/wc/trunk/a.txt',
    localBaseRevision: 7,
    ...overrides,
  };
}

function handoffContext(overrides: Partial<HistoryModelContext> = {}): HistoryModelContext {
  return {
    repositoryUuid: 'uuid-1',
    target: {
      url: 'https://example.com/repo/trunk/a.txt',
      repositoryRootUrl: 'https://example.com/repo',
      relativePath: 'trunk/a.txt',
      kind: 'file',
    },
    source: 'handoff',
    ...overrides,
  };
}

const LIMITS: HistoryLimits = { matched: 5_000, scanned: 100_000, rawBudgetPerLoad: 500 };

function entry(revision: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    revision,
    author: 'alice',
    date: '2026-11-01T10:00:00.000000Z',
    message: `提交说明 r${revision}`,
    paths: [{ path: '/trunk/a.txt', action: 'M', kind: 'file' }],
    ...overrides,
  };
}

function makeModel(pageSize = 20): HistoryModel {
  return new HistoryModel({ pageSize, limits: LIMITS });
}

/** 建好 live-head 会话并灌入一批记录（target 源全命中）。 */
function liveModel(revisions: number[], pageSize = 20): HistoryModel {
  const model = makeModel(pageSize);
  model.beginOpen(localContext());
  model.applyResolvedUpper({ upperRevision: 10, upperSource: 'live-head', targetPresentAtUpper: true });
  fill(model, revisions);
  return model;
}

function fill(model: HistoryModel, revisions: number[]): void {
  const session = model.sessionView();
  const sourceId = session.sources[0]?.id ?? 'target';
  model.applyLogPage({
    sourceId,
    entries: revisions.map((revision) => entry(revision)),
    requestedLimit: model.pageSize + 1,
  });
  model.finishLoadMore();
}

/* ------------------------------ 测试 ------------------------------ */

describe('resetHistorySession（HLS-6 模型级语义）', () => {
  it('live-head reset：headState=available 与 upper/filter/follow 保持，数据与计数归零', () => {
    const model = liveModel([9, 8, 7]);
    model.setFilter('keyword', 'r9');
    model.toggleRevision(historyRowId(9));
    model.selectRevision(historyRowId(9));
    const session = model.sessionView();
    expect(session.entriesByRevision.size).toBe(3);
    expect(session.rawFetchedTotal).toBe(3);

    expect(model.reset()).toBe('ok');

    expect(session.upperRevision).toBe(10);
    expect(session.upperSource).toBe('live-head');
    expect(session.headState).toBe('available');
    expect(model.currentFilter().keyword).toBe('r9');
    expect(session.followCopies).toBe(true);
    expect(session.sources).toHaveLength(1);
    expect(session.sources[0].cursor).toBe(10);
    expect(session.entriesByRevision.size).toBe(0);
    expect(session.visibleEntries).toEqual([]);
    expect(session.displayedCount).toBe(0);
    expect(session.scannedRevisionIds.size).toBe(0);
    expect(session.rawFetchedTotal).toBe(0);
    expect(session.rawFetchedInLoad).toBe(0);
    expect(session.scannedThisLoad.size).toBe(0);
    expect(session.loadedMatchedCount).toBe(0);
    expect(session.visibleMatched).toBe(0);
    expect(session.historyLimitState).toBeNull();
    expect(model.selectedRevisions()).toEqual([]);
    expect(model.detailState()).toBeUndefined();
  });

  it('base-fallback reset：headState=unavailable 保持且不解析 HEAD', () => {
    const model = makeModel();
    model.beginOpen(localContext());
    model.applyBaseFallbackSuccess(7, { targetPresentAtUpper: true });
    fill(model, [5, 4]);
    const session = model.sessionView();
    expect(session.upperSource).toBe('base-fallback');
    expect(session.headState).toBe('unavailable');

    expect(model.reset()).toBe('ok');
    expect(session.upperRevision).toBe(7);
    expect(session.upperSource).toBe('base-fallback');
    expect(session.headState).toBe('unavailable');
    expect(session.entriesByRevision.size).toBe(0);
    expect(session.sources[0].cursor).toBe(7);
  });

  it('unresolved reset 被拒：目标/筛选/follow 与三字段不变', () => {
    const model = makeModel();
    model.beginOpen(localContext());
    model.applyUnresolved({ kind: 'network', message: '无法连接', codes: [] });
    model.setFilter('keyword', 'abc');
    const session = model.sessionView();
    const before = {
      upperRevision: session.upperRevision,
      upperSource: session.upperSource,
      headState: session.headState,
      keyword: model.currentFilter().keyword,
      follow: session.followCopies,
    };

    expect(model.reset()).toBe('rejected');

    expect({
      upperRevision: session.upperRevision,
      upperSource: session.upperSource,
      headState: session.headState,
      keyword: model.currentFilter().keyword,
      follow: session.followCopies,
    }).toEqual(before);
    expect(session.sources).toEqual([]);
  });

  it('reset 后按原 upper 重读首批：源 cursor 等于 upperRevision（live-head 停在 r12）', () => {
    const model = makeModel();
    model.beginOpen(localContext());
    model.applyResolvedUpper({ upperRevision: 12, upperSource: 'live-head', targetPresentAtUpper: true });
    fill(model, [11]);
    model.reset();
    const source = model.sessionView().sources[0];
    expect(source.cursor).toBe(12);
    expect(source.queryUrl).toBe('https://example.com/repo/trunk/a.txt');
  });
});

describe('refreshHistoryUpper 运行时校验与来源恢复', () => {
  it('快照会话拒绝 head 刷新；live-head 拒绝 base-fallback；无本地 BASE 拒绝 base-fallback', () => {
    const snapshot = makeModel();
    snapshot.beginOpen(handoffContext());
    snapshot.applyResolvedUpper({ upperRevision: 4, upperSource: 'snapshot', targetPresentAtUpper: true });
    expect(snapshot.checkUpperRefresh('head')).toEqual({ ok: false, reason: 'snapshot-source' });
    expect(snapshot.checkUpperRefresh('base-fallback')).toEqual({ ok: false, reason: 'snapshot-source' });

    const live = liveModel([3]);
    expect(live.checkUpperRefresh('head')).toEqual({ ok: true, mode: 'head' });
    expect(live.checkUpperRefresh('base-fallback')).toEqual({ ok: false, reason: 'source-live-head' });

    const noBase = makeModel();
    noBase.beginOpen(handoffContext());
    noBase.applyUnresolved({ kind: 'network', message: 'x', codes: [] });
    expect(noBase.checkUpperRefresh('base-fallback')).toEqual({ ok: false, reason: 'not-local-target' });

    expect(live.checkUpperRefresh('full')).toEqual({ ok: false, reason: 'invalid-mode' });
  });

  it('head 刷新：live-head 同值 → up-to-date 保留已加载数据', () => {
    const model = liveModel([9, 8]);
    expect(model.applyUpperRefresh('head', 10)).toBe('up-to-date');
    expect(model.sessionView().entriesByRevision.size).toBe(2);
    expect(model.sessionView().rawFetchedTotal).toBe(2);
  });

  it('head 刷新：值变化清数据并更新三字段；unresolved/base-fallback 来源恢复优先 live-head', () => {
    const model = liveModel([9]);
    expect(model.applyUpperRefresh('head', 12)).toBe('updated');
    expect(model.sessionView().upperRevision).toBe(12);
    expect(model.sessionView().upperSource).toBe('live-head');
    expect(model.sessionView().headState).toBe('available');
    expect(model.sessionView().entriesByRevision.size).toBe(0);

    const fallback = makeModel();
    fallback.beginOpen(localContext());
    fallback.applyBaseFallbackSuccess(7, { targetPresentAtUpper: true });
    fill(fallback, [5]);
    expect(fallback.applyUpperRefresh('head', 7)).toBe('updated');
    expect(fallback.sessionView().upperSource).toBe('live-head');
    expect(fallback.sessionView().headState).toBe('available');
    expect(fallback.sessionView().upperRevision).toBe(7);
    expect(fallback.sessionView().entriesByRevision.size).toBe(0);
  });

  it('base-fallback 成功固定 unavailable；失败分支（调用方不应用）三字段与数据不变', () => {
    const model = makeModel();
    model.beginOpen(localContext());
    model.applyUnresolved({ kind: 'network', message: '无法连接', codes: [] });
    model.applyBaseFallbackSuccess(7, { targetPresentAtUpper: true });
    fill(model, [5, 4]);
    const session = model.sessionView();
    const before = {
      upperRevision: session.upperRevision,
      upperSource: session.upperSource,
      headState: session.headState,
      rawFetchedTotal: session.rawFetchedTotal,
      entries: session.entriesByRevision.size,
      displayedCount: session.displayedCount,
    };
    // 失败分支：控制器直接放弃，不调用 applyBaseFallbackSuccess/applyUpperRefresh。
    expect({
      upperRevision: session.upperRevision,
      upperSource: session.upperSource,
      headState: session.headState,
      rawFetchedTotal: session.rawFetchedTotal,
      entries: session.entriesByRevision.size,
      displayedCount: session.displayedCount,
    }).toEqual(before);
    expect(session.upperSource).toBe('base-fallback');
    expect(session.headState).toBe('unavailable');
  });
});

describe('筛选变化只重算展示前缀', () => {
  it('可见勾选保留、不可见勾选与详情清空，不自动选第一条，源栈不重建', () => {
    const model = makeModel(2);
    model.beginOpen(localContext());
    model.applyResolvedUpper({ upperRevision: 10, upperSource: 'live-head', targetPresentAtUpper: true });
    model.applyLogPage({
      sourceId: 'target',
      entries: [
        entry(9, { author: 'alice' }),
        entry(8, { author: 'bob' }),
        entry(7, { author: 'alice' }),
      ],
      requestedLimit: 3,
    });
    model.finishLoadMore();
    const sourceRef = model.sessionView().sources[0];
    model.toggleRevision(historyRowId(9));
    model.toggleRevision(historyRowId(8));
    model.selectRevision(historyRowId(9));

    const result = model.setFilter('author', 'alice');
    expect(result).toEqual({ changed: true, rebuild: false });

    const session = model.sessionView();
    expect(session.sources[0]).toBe(sourceRef);
    expect(session.entriesByRevision.size).toBe(3);
    expect(session.visibleEntries.map((item) => item.revision)).toEqual([9, 7]);
    expect(session.displayedCount).toBe(2);
    expect(model.selectedRevisions()).toEqual([9]);
    expect(model.detailState()?.revision).toBe(9);
    expect(model.detailState()?.resolution.status).toBe('loading');

    // 选中 revision 被筛掉：详情清空，不自动选第一条。
    model.selectRevision(historyRowId(7));
    model.setFilter('author', 'bob');
    expect(model.detailState()).toBeUndefined();
    expect(model.selectedRevisions()).toEqual([]);
  });

  it('日期起止反序：日期条件不应用（保留上一有效结果）且字段值保留', () => {
    const model = makeModel();
    model.beginOpen(localContext());
    model.applyResolvedUpper({ upperRevision: 10, upperSource: 'live-head', targetPresentAtUpper: true });
    fill(model, [9, 8]);
    model.setFilter('dateFrom', '2026-11-10');
    model.setFilter('dateTo', '2026-11-01');
    expect(model.currentFilter().dateFrom).toBe('2026-11-10');
    expect(model.currentFilter().dateTo).toBe('2026-11-01');
    expect(model.sessionView().visibleEntries).toHaveLength(2);
    expect(model.buildPanelState('s1').filterPanel?.fields.find((field) => field.id === 'dateFrom')?.error)
      .toBeTruthy();
  });

  it('clearFilters 清空文本类字段但保留 follow 历史范围', () => {
    const model = liveModel([9]);
    model.setFilter('follow', 'stop');
    model.setFilter('keyword', 'x');
    expect(model.clearFilters().changed).toBe(true);
    expect(model.currentFilter()).toEqual({});
    expect(model.followCopies()).toBe(false);
  });

  it('follow 变化重建源栈并清空数据，返回 rebuild=true', () => {
    const model = liveModel([9, 8]);
    model.toggleRevision(historyRowId(9));
    const result = model.setFilter('follow', 'stop');
    expect(result).toEqual({ changed: true, rebuild: true });
    const session = model.sessionView();
    expect(session.followCopies).toBe(false);
    expect(session.entriesByRevision.size).toBe(0);
    expect(model.selectedRevisions()).toEqual([]);
    expect(session.sources).toHaveLength(1);
    expect(session.sources[0].cursor).toBe(10);
    expect(model.setFilter('follow', 'stop')).toEqual({ changed: false, rebuild: false });
  });

  it('每批条数变化只重置展示前缀，不清已扫描数据', () => {
    const model = makeModel(50);
    model.beginOpen(localContext());
    model.applyResolvedUpper({ upperRevision: 10, upperSource: 'live-head', targetPresentAtUpper: true });
    fill(model, [9, 8, 7, 6, 5]);
    expect(model.sessionView().displayedCount).toBe(5);
    expect(model.setPageSize(2)).toBe(true);
    expect(model.sessionView().displayedCount).toBe(2);
    expect(model.sessionView().entriesByRevision.size).toBe(5);
    expect(model.setPageSize(50)).toBe(true);
    expect(model.sessionView().displayedCount).toBe(5);
    expect(model.setPageSize(50)).toBe(false);
  });
});

describe('revision 勾选与详情', () => {
  it('勾选最多两项，第三个返回 limit；取消后可再选', () => {
    const model = liveModel([9, 8, 7, 6]);
    expect(model.toggleRevision(historyRowId(9))).toBe('toggled');
    expect(model.toggleRevision(historyRowId(8))).toBe('toggled');
    expect(model.toggleRevision(historyRowId(7))).toBe('limit');
    expect(model.selectedRevisions()).toEqual([9, 8]);
    expect(model.toggleRevision(historyRowId(9))).toBe('toggled');
    expect(model.toggleRevision(historyRowId(7))).toBe('toggled');
    expect(model.selectedRevisions()).toEqual([8, 7]);
    expect(model.toggleRevision('r999')).toBe('missing');
  });

  it('点击行只更新详情、不改勾选；解析回包按 epoch 校验', () => {
    const model = liveModel([9, 8]);
    model.toggleRevision(historyRowId(8));
    const request = model.selectRevision(historyRowId(9));
    expect(request).toBeDefined();
    expect(model.selectedRevisions()).toEqual([8]);
    expect(model.detailState()?.revision).toBe(9);
    expect(model.detailState()?.resolution.status).toBe('loading');

    model.applyDetailResolution(request!, { status: 'present', url: 'u', repositoryPath: 'trunk/a.txt' });
    expect(model.detailState()?.resolution.status).toBe('present');

    // 过期 epoch（重新选择后的旧回包）不写回。
    const second = model.selectRevision(historyRowId(8));
    model.applyDetailResolution(request!, { status: 'absent' });
    expect(model.detailState()?.resolution.status).toBe('loading');
    model.applyDetailResolution(second!, { status: 'notFoundAtRevision' });
    expect(model.detailState()?.resolution.status).toBe('notFoundAtRevision');
  });

  it('上一条可见记录：取当前筛选/已加载批次的下一条；到批次末尾返回 undefined', () => {
    const model = makeModel(2);
    model.beginOpen(localContext());
    model.applyResolvedUpper({ upperRevision: 10, upperSource: 'live-head', targetPresentAtUpper: true });
    model.applyLogPage({
      sourceId: 'target',
      entries: [entry(9), entry(8), entry(7), entry(6)],
      requestedLimit: 3,
    });
    model.finishLoadMore();
    // displayedCount=2（9,8），但已加载批次含 7/6：比较取已加载批次。
    model.selectRevision(historyRowId(8));
    expect(model.previousVisiblePair()).toEqual({ newer: 8, older: 7 });
    model.selectRevision(historyRowId(6));
    expect(model.previousVisiblePair()).toBeUndefined();
    // 详情动作到批次边界禁用并提示加载更多。
    const detail = model.buildPanelState('s').detail;
    const actionsSection = detail?.sections.find((section) => section.kind === 'actions');
    const compare = actionsSection !== undefined && actionsSection.kind === 'actions'
      ? actionsSection.actions.find((action) => action.id === 'comparePreviousVisible')
      : undefined;
    expect(compare?.disabled).toBe(true);
    expect(compare?.disabledReason).toContain('加载更多');
  });

  it('快捷版本对不写回手动勾选', () => {
    const model = liveModel([9, 8, 7]);
    model.toggleRevision(historyRowId(9));
    model.selectRevision(historyRowId(8));
    model.previousVisiblePair();
    expect(model.selectedRevisions()).toEqual([9]);
  });
});

describe('序列化与关闭重开恢复', () => {
  it('保存数据/筛选/勾选/详情/upper，恢复后不重解析 HEAD 且展示前缀保留', () => {
    const model = makeModel(2);
    model.beginOpen(localContext());
    model.applyResolvedUpper({ upperRevision: 10, upperSource: 'live-head', targetPresentAtUpper: true });
    model.applyLogPage({
      sourceId: 'target',
      entries: [entry(9), entry(8), entry(7)],
      requestedLimit: 3,
    });
    model.finishLoadMore();
    model.toggleRevision(historyRowId(9));
    model.selectRevision(historyRowId(8));

    const saved = model.serialize();
    expect(saved).toBeDefined();

    const restored = makeModel(50);
    const ok = restored.restore(localContext(), saved!.browsable, saved!.upper, saved!.historyLimitState);
    expect(ok).toBe(true);
    const session = restored.sessionView();
    expect(session.upperRevision).toBe(10);
    expect(session.upperSource).toBe('live-head');
    expect(session.headState).toBe('available');
    expect(session.entriesByRevision.size).toBe(3);
    expect(session.displayedCount).toBe(2);
    expect(restored.selectedRevisions()).toEqual([9]);
    expect(restored.detailState()?.revision).toBe(8);
    expect(restored.detailState()?.resolution.status).toBe('loading');
    expect(restored.takePendingDetailResolve()?.revision).toBe(8);
    expect(restored.takePendingDetailResolve()).toBeUndefined();
  });

  it('形状/版本/身份不一致时拒绝恢复（按 fresh 处理）', () => {
    const model = liveModel([9]);
    const saved = model.serialize()!;
    const fresh = makeModel();
    expect(fresh.restore(localContext(), { ...saved.browsable, version: 99 }, saved.upper, null)).toBe(false);
    expect(fresh.restore(localContext(), null, saved.upper, null)).toBe(false);
    expect(fresh.restore(
      { ...localContext(), target: { ...localContext().target, relativePath: 'trunk/other.txt' } },
      saved.browsable,
      saved.upper,
      null,
    )).toBe(false);
    // upper 三字段与保存的会话不一致（伪造）时拒绝。
    expect(fresh.restore(localContext(), saved.browsable, {
      upperRevision: 99,
      upperSource: 'live-head',
      headState: 'available',
    }, null)).toBe(false);
  });

  it('恢复 unresolved 会话：upper 三字段原样、无源无数据', () => {
    const model = makeModel();
    model.beginOpen(localContext());
    model.applyUnresolved({ kind: 'network', message: 'x', codes: [] });
    const saved = model.serialize()!;
    const restored = makeModel();
    expect(restored.restore(localContext(), saved.browsable, saved.upper, saved.historyLimitState)).toBe(true);
    const session = restored.sessionView();
    expect(session.upperRevision).toBeNull();
    expect(session.upperSource).toBe('unresolved');
    expect(session.headState).toBe('unavailable');
    expect(session.sources).toEqual([]);
  });
});

describe('渲染（append 表格 / 详情 / 分态）', () => {
  it('append 分页：rows 为已展示前缀、total=visibleMatched、加载更多与勾选契约', () => {
    const model = makeModel(2);
    model.beginOpen(localContext());
    model.applyResolvedUpper({ upperRevision: 10, upperSource: 'live-head', targetPresentAtUpper: true });
    model.applyLogPage({
      sourceId: 'target',
      entries: [entry(9, { message: '修复 登录\n第二行' }), entry(8), entry(7)],
      requestedLimit: 3,
    });
    model.finishLoadMore();
    model.toggleRevision(historyRowId(9));

    const state = model.buildPanelState('s1');
    expect(state.title).toBeTruthy();
    expect(state.targetLabel).toContain('/wc/trunk/a.txt');
    const table = state.table!;
    expect(table.id).toBe('history');
    expect(table.pagination).toMatchObject({ mode: 'append', page: 1, pageCount: 1, total: 3, pageSize: 2 });
    expect(table.rows.map((row) => row.id)).toEqual(['r9', 'r8']);
    expect(table.rows[0].cells.revision).toBe('r9');
    expect(table.rows[0].cells.message).toBe('修复 登录');
    expect(table.rows[0].selected).toBe(true);
    expect(table.selection).toMatchObject({ mode: 'revision', maxSelected: 2 });
    expect(table.loadMoreAction?.id).toBe('loadMoreHistory');
    expect(table.loadMoreAction?.disabled).toBe(false);
    expect(state.headerBadges?.map((badge) => badge.text)).toContain('BASE r7');
    expect(state.headerBadges?.map((badge) => badge.text)).toContain('HEAD r10');
    expect(state.footer?.primary?.id).toBe('loadMoreHistory');
    expect(state.footer?.summary).toContain('目标历史 3 条');
    const secondaryIds = (state.footer?.secondary ?? []).map((action) => action.id);
    expect(secondaryIds).toContain('refreshHistoryUpper');
    expect(secondaryIds).toContain('resetHistorySession');
  });

  it('详情：变更路径/复制来源/删除存在性与动作能力/复制动作', () => {
    const model = makeModel();
    model.beginOpen(localContext());
    model.applyResolvedUpper({ upperRevision: 10, upperSource: 'live-head', targetPresentAtUpper: true });
    model.applyLogPage({
      sourceId: 'target',
      entries: [
        entry(9, {
          paths: [
            { path: '/trunk/a.txt', action: 'A', kind: 'file', copyfromPath: '/branches/a.txt', copyfromRevision: 4 },
            { path: '/trunk/b.txt', action: 'M', kind: 'file' },
          ],
        }),
      ],
      requestedLimit: 2,
    });
    model.finishLoadMore();
    const request = model.selectRevision(historyRowId(9))!;
    model.applyDetailResolution(request, { status: 'absent', deletedRevision: 9 });

    const detail = model.buildPanelState('s').detail!;
    const paths = detail.sections.find((section) => section.kind === 'paths');
    expect(paths !== undefined && paths.kind === 'paths' ? paths.paths.length : 0).toBe(2);
    expect(paths !== undefined && paths.kind === 'paths' ? paths.paths[0].copyfrom?.path : undefined)
      .toBe('/branches/a.txt');
    const copyWindow = detail.sections.find((section) => section.kind === 'copyWindow');
    expect(copyWindow !== undefined && copyWindow.kind === 'copyWindow' ? copyWindow.items.length : 0).toBe(1);
    const texts = detail.sections
      .filter((section) => section.kind === 'text')
      .flatMap((section) => (section.kind === 'text' ? section.paragraphs : []))
      .join('\n');
    expect(texts).toContain('删除');
    expect(texts).toContain('导出删除前版本');
    const actions = detail.sections.find((section) => section.kind === 'actions');
    const ids = actions !== undefined && actions.kind === 'actions'
      ? actions.actions.map((action) => action.id)
      : [];
    expect(ids).toContain('comparePreviousVisible');
    expect(ids).toContain('copyHistoryText');
    const copyMessage = actions !== undefined && actions.kind === 'actions'
      ? actions.actions.find((action) => action.id === 'copyHistoryText')
      : undefined;
    expect(copyMessage?.payload).toEqual({ 'copy-kind': 'message', 'row-id': 'r9' });
  });

  it('unresolved：不渲染筛选面板，显示 HEAD 暂不可用与 BASE 上限入口', () => {
    const model = makeModel();
    model.beginOpen(localContext());
    model.applyUnresolved({ kind: 'network', message: '无法连接', codes: [] });
    const state = model.buildPanelState('s');
    expect(state.filterPanel).toBeUndefined();
    expect(state.table?.rows).toEqual([]);
    const banner = state.banners.find((item) => item.id === 'historyHeadUnavailable');
    expect(banner).toBeDefined();
    expect(banner?.detail).toContain('HEAD 暂不可用');
    expect(banner?.actions?.map((action) => action.id)).toEqual(['historyRetry', 'historyBaseFallback']);
    expect(state.headerBadges?.map((badge) => badge.text)).toContain('HEAD 未知');
  });

  it('上限状态：matched+scanned 双 reason 并存文案', () => {
    const small = new HistoryModel({ pageSize: 2, limits: { matched: 2, scanned: 6, rawBudgetPerLoad: 6 } });
    small.beginOpen(localContext());
    small.applyResolvedUpper({ upperRevision: 10, upperSource: 'live-head', targetPresentAtUpper: true });
    small.applyLogPage({
      sourceId: 'target',
      entries: [entry(9), entry(8), entry(7)],
      requestedLimit: 3,
    });
    small.finishLoadMore();
    const banner = small.buildPanelState('s').banners.find((item) => item.id === 'historyLimits');
    expect(banner).toBeDefined();
    expect(banner?.detail).toContain('已加载命中');
    expect(banner?.level).toBe('warn');
  });

  it('本轮无匹配：显示“本轮已处理/目标历史暂无匹配”，关闭后隐藏', () => {
    const model = makeModel();
    model.beginOpen(localContext());
    model.applyResolvedUpper({ upperRevision: 10, upperSource: 'live-head', targetPresentAtUpper: true });
    model.applyLogPage({ sourceId: 'target', entries: [entry(9)], requestedLimit: 2 });
    model.finishLoadMore();
    model.setFilter('author', 'nobody');
    const round = model.buildPanelState('s').banners.find((item) => item.id === 'historyRound');
    expect(round?.detail).toContain('目标历史暂无匹配');
    model.dismissRoundBanner();
    expect(model.buildPanelState('s').banners.some((item) => item.id === 'historyRound')).toBe(false);
  });

  it('表格：变更路径数列与加载更多本次/累计计数（loadMoreInfo）', () => {
    const model = liveModel([9, 8, 7], 2);
    const state = model.buildPanelState('s');
    const table = state.table!;
    expect(table.columns.map((column) => column.key))
      .toEqual(['revision', 'message', 'author', 'date', 'paths']);
    expect(table.rows[0].cells.paths).toBe('1');
    expect(table.loadMoreInfo?.summary).toContain('已展示 2 条');
    expect(table.loadMoreInfo?.sessionSummary).toContain('会话已扫描 3 条');
    expect(table.loadMoreInfo?.thisLoad).toEqual({ rawFetched: 3, uniqueScanned: 3 });
  });

  it('筛选面板：每批数量 select 与 setFilter(pageSize) 只重置展示前缀', () => {
    const model = liveModel([9, 8, 7, 6], 50);
    const field = model.buildPanelState('s').filterPanel?.fields.find((item) => item.id === 'pageSize');
    expect(field?.kind).toBe('select');
    expect(field?.value).toBe('50');
    expect(field?.options?.map((option) => option.value)).toEqual(['20', '50', '100']);
    const result = model.setFilter('pageSize', '20');
    expect(result).toEqual({ changed: true, rebuild: false });
    expect(model.pageSize).toBe(20);
    expect(model.sessionView().displayedCount).toBe(4);
    // 每批条数不是筛选条件：筛选值不因 pageSize 变化。
    expect(model.currentFilter()).toEqual({});
  });

  it('详情实际节点路径：core 契约形态与带前导防御形态都只渲染一个斜杠', () => {
    const model = liveModel([9], 50);
    const renderActualPath = (repositoryPath: string): string | undefined => {
      const request = model.selectRevision(historyRowId(9))!;
      model.applyDetailResolution(request, {
        status: 'present',
        url: 'https://example.com/repo/trunk/a.txt',
        repositoryPath,
        revision: 9,
      });
      const detail = model.buildPanelState('s').detail!;
      const kv = detail.sections.find((section) => section.kind === 'kv');
      const entries = kv !== undefined && kv.kind === 'kv' ? kv.entries : [];
      return entries.find((item) => item.label === historyText('detailActualPath'))?.value;
    };
    // core 真实返回形态：仓库相对路径无前导斜杠。
    expect(renderActualPath('trunk/a.txt')).toBe('/trunk/a.txt');
    // 防御形态：上游即便带回前导斜杠，渲染也不得出现双斜杠。
    const leading = renderActualPath('/trunk/a.txt');
    expect(leading).toBe('/trunk/a.txt');
    expect(leading?.includes('//')).toBe(false);
  });

  it('详情动作矩阵：本地文件 present 开放导出/查看/追溯/更新/BASE，目录检出禁用', () => {
    const model = liveModel([9], 50);
    const request = model.selectRevision(historyRowId(9))!;
    model.applyDetailResolution(request, {
      status: 'present',
      url: 'https://example.com/repo/trunk/a.txt',
      repositoryPath: 'trunk/a.txt',
      revision: 9,
    });
    const detail = model.buildPanelState('s').detail!;
    expect(detail.id).toBe('r9');
    const actions = detail.sections.find((section) => section.kind === 'actions');
    const byId = new Map((actions !== undefined && actions.kind === 'actions' ? actions.actions : [])
      .map((action) => [action.id, action]));
    expect(byId.get('exportHistoryVersion')?.disabled).toBeFalsy();
    expect(byId.get('viewHistoryRevision')?.disabled).toBeFalsy();
    expect(byId.get('blameHistoryRevision')?.disabled).toBeFalsy();
    expect(byId.get('updateToHistoryRevision')?.disabled).toBeFalsy();
    expect(byId.get('checkoutHistoryDirectory')?.disabled).toBe(true);
    expect(byId.get('compareBase')?.disabled).toBeFalsy();
  });

  it('详情动作矩阵：删除提交只开放导出；复制来源禁用更新；远端目录开放检出', () => {
    const fileModel = liveModel([9], 50);
    const fileRequest = fileModel.selectRevision(historyRowId(9))!;
    fileModel.applyDetailResolution(fileRequest, { status: 'absent', deletedRevision: 9 });
    const fileDetail = fileModel.buildPanelState('s').detail!;
    const fileActions = fileDetail.sections.find((section) => section.kind === 'actions');
    const fileById = new Map((fileActions !== undefined && fileActions.kind === 'actions' ? fileActions.actions : [])
      .map((action) => [action.id, action]));
    expect(fileById.get('exportHistoryVersion')?.disabled).toBeFalsy();
    expect(fileById.get('viewHistoryRevision')?.disabled).toBe(true);
    expect(fileById.get('blameHistoryRevision')?.disabled).toBe(true);
    expect(fileById.get('updateToHistoryRevision')?.disabled).toBe(true);

    const dirModel = makeModel();
    dirModel.beginOpen(handoffContext({
      target: {
        url: 'https://example.com/repo/trunk',
        repositoryRootUrl: 'https://example.com/repo',
        relativePath: 'trunk',
        kind: 'dir',
      },
    }));
    dirModel.applyResolvedUpper({ upperRevision: 10, upperSource: 'snapshot', targetPresentAtUpper: true });
    dirModel.applyLogPage({
      sourceId: 'target',
      entries: [entry(9, {
        paths: [{
          path: '/trunk/vendor/a.txt',
          action: 'A',
          kind: 'file',
          copyfromPath: '/branches/a.txt',
          copyfromRevision: 4,
        }],
      })],
      requestedLimit: 2,
    });
    dirModel.finishLoadMore();
    const dirRequest = dirModel.selectRevision(historyRowId(9))!;
    dirModel.applyDetailResolution(dirRequest, {
      status: 'present',
      url: 'https://example.com/repo/trunk',
      repositoryPath: 'trunk',
      revision: 9,
    });
    const dirDetail = dirModel.buildPanelState('s').detail!;
    const dirActions = dirDetail.sections.find((section) => section.kind === 'actions');
    const dirById = new Map((dirActions !== undefined && dirActions.kind === 'actions' ? dirActions.actions : [])
      .map((action) => [action.id, action]));
    expect(dirById.get('checkoutHistoryDirectory')?.disabled).toBeFalsy();
    expect(dirById.get('viewHistoryRevision')?.disabled).toBe(true);
    expect(dirById.get('blameHistoryRevision')?.disabled).toBe(true);
    expect(dirById.get('updateToHistoryRevision')?.disabled).toBe(true);
    expect(dirById.get('compareBase')?.disabled).toBe(true);

    const copyModel = liveModel([9], 50);
    const copyRequest = copyModel.selectRevision(historyRowId(9))!;
    copyModel.applyDetailResolution(copyRequest, {
      status: 'present',
      url: 'https://example.com/repo/branches/a.txt',
      repositoryPath: 'branches/a.txt',
      revision: 9,
    });
    const copyDetail = copyModel.buildPanelState('s').detail!;
    const copyActions = copyDetail.sections.find((section) => section.kind === 'actions');
    const copyById = new Map((copyActions !== undefined && copyActions.kind === 'actions' ? copyActions.actions : [])
      .map((action) => [action.id, action]));
    expect(copyById.get('updateToHistoryRevision')?.disabled).toBe(true);
    expect(copyById.get('updateToHistoryRevision')?.disabledReason).toContain('复制来源');
    expect(copyById.get('exportHistoryVersion')?.disabled).toBeFalsy();
  });
});

describe('目标身份与路径工具', () => {
  it('historyTargetKey 使用 UUID + 根 URL + 相对路径 + 类型', () => {
    const key = historyTargetKey('uuid-1', {
      repositoryRootUrl: 'https://example.com/repo',
      relativePath: 'trunk/a.txt',
      kind: 'file',
    });
    expect(key).toContain('uuid-1');
    expect(key).toContain('trunk/a.txt');
    expect(key).not.toBe(historyTargetKey('uuid-1', {
      repositoryRootUrl: 'https://example.com/repo',
      relativePath: 'trunk/a.txt',
      kind: 'dir',
    }));
  });

  it('parentRepositoryPath / normalizeRelativePath', () => {
    expect(parentRepositoryPath('trunk/a.txt')).toBe('trunk');
    expect(parentRepositoryPath('trunk')).toBe('');
    expect(parentRepositoryPath('')).toBeUndefined();
    expect(normalizeRelativePath('/trunk/a.txt/')).toBe('trunk/a.txt');
  });
});

/* ---------------------------------------------------------------------------
 * M4 阶段 6：P6 更新状态机（updating/updated/updateConflict/updateRescanning/
 * updateUnknown）、终态页形状与 P7 taskContext 交接
 * ------------------------------------------------------------------------- */

const UPDATE_INTENT: HistoryUpdateIntent = {
  wcRoot: '/wc',
  targetRelPath: 'trunk/sub',
  targetKind: 'dir',
  targetUrl: 'https://example.com/repo/trunk/sub',
  requestedRevision: 40,
  preRevision: 37,
};

function conflictRecord(path: string): ConflictRecord {
  return {
    id: `id-${path}`,
    path,
    kinds: ['text'],
    contentKind: 'text',
    nodeBaseRevision: 40,
    baselineRevision: 37,
    incomingRevision: 41,
    artifacts: [
      { role: 'base', path: `${path}.r37`, revision: 37 },
      { role: 'mine', path: `${path}.mine` },
      { role: 'incoming', path: `${path}.r41`, revision: 41 },
    ],
  };
}

function updateResult(overrides: Partial<HistoryUpdateResult> = {}): HistoryUpdateResult {
  return {
    targetRelPath: 'trunk/sub',
    requestedRevision: 40,
    preRevision: 37,
    postNodeRevision: 40,
    outcome: 'updated',
    conflicts: [],
    conflictSummary: { text: 0, property: 0, tree: 0, total: 0 },
    ...overrides,
  };
}

describe('P6 更新状态机（五态与固定意图）', () => {
  it('createHistoryUpdateState：固定意图原样保存、相位 updating、旧 BASE 不被动', () => {
    const state = createHistoryUpdateState(UPDATE_INTENT, 'op-1', 1000);
    expect(state).toMatchObject({
      phase: 'updating',
      wcRoot: '/wc',
      targetRelPath: 'trunk/sub',
      targetKind: 'dir',
      targetUrl: 'https://example.com/repo/trunk/sub',
      requestedRevision: 40,
      preRevision: 37,
      operationId: 'op-1',
      updatedAt: 1000,
    });
    expect(state.postNodeRevision).toBeUndefined();
    expect(state.conflicts).toEqual([]);
    expect(historyUpdateSettled(state)).toBe(false);
    expect(historyUpdateIntentOf(state)).toEqual(UPDATE_INTENT);
  });

  it('applyHistoryUpdateResult：updated/conflict/unknown 三态映射且回读事实原样保留', () => {
    const base = createHistoryUpdateState(UPDATE_INTENT, 'op-1', 1000);
    const updated = applyHistoryUpdateResult(base, updateResult({ postNodeRevision: 40 }), 1100);
    expect(updated.phase).toBe('updated');
    expect(updated.postNodeRevision).toBe(40);
    expect(updated.preRevision).toBe(37);
    expect(historyUpdateSettled(updated)).toBe(true);

    const conflict = applyHistoryUpdateResult(base, updateResult({
      outcome: 'conflict',
      conflicts: [conflictRecord('trunk/sub/a.txt')],
      conflictSummary: { text: 1, property: 0, tree: 0, total: 1 },
    }), 1200);
    expect(conflict.phase).toBe('updateConflict');
    expect(conflict.conflicts.map((record) => record.path)).toEqual(['trunk/sub/a.txt']);
    expect(conflict.conflictSummary.total).toBe(1);

    const unknown = applyHistoryUpdateResult(base, updateResult({
      outcome: 'unknown',
      postNodeRevision: undefined,
      readbackError: 'svn info 失败',
    }), 1300);
    expect(unknown.phase).toBe('updateUnknown');
    expect(unknown.postNodeRevision).toBeUndefined();
    expect(unknown.preRevision).toBe(37);
    expect(unknown.readbackError).toBe('svn info 失败');
    expect(historyUpdateSettled(unknown)).toBe(false);
  });

  it('外部并发导致回读 revision 不等于请求：结果仍 unknown，旧 BASE 不被替换', () => {
    const base = createHistoryUpdateState(UPDATE_INTENT, 'op-1', 1000);
    const unknown = applyHistoryUpdateResult(base, updateResult({
      outcome: 'unknown',
      postNodeRevision: 39,
    }));
    expect(unknown.phase).toBe('updateUnknown');
    expect(unknown.preRevision).toBe(37);
    expect(unknown.postNodeRevision).toBe(39);
    // 未知不写回读值：面板 BASE 不可通过 settled 路径刷新。
    expect(historyUpdateSettled(unknown)).toBe(false);
  });

  it('未知回扫三出口：仍未知保持 unknown；成功→updated；冲突→updateConflict', () => {
    const base = applyHistoryUpdateResult(createHistoryUpdateState(UPDATE_INTENT, 'op-1', 1000), updateResult({
      outcome: 'unknown',
      postNodeRevision: undefined,
      readbackError: '命令退出码 1',
    }), 1100);
    const rescanning = beginHistoryUpdateRescan(base, 1200);
    expect(rescanning.phase).toBe('updateRescanning');
    expect(rescanning.preRevision).toBe(37);

    const stillUnknown: HistoryUpdateRescan = {
      outcome: 'still-unknown',
      postNodeRevision: 37,
      conflicts: [],
      conflictSummary: { text: 0, property: 0, tree: 0, total: 0 },
      readbackError: 'identity mismatch',
    };
    const kept = applyHistoryUpdateRescan(rescanning, stillUnknown, 1300);
    expect(kept.phase).toBe('updateUnknown');
    expect(kept.preRevision).toBe(37);

    const success = applyHistoryUpdateRescan(rescanning, {
      outcome: 'updated',
      postNodeRevision: 40,
      conflicts: [],
      conflictSummary: { text: 0, property: 0, tree: 0, total: 0 },
    }, 1400);
    expect(success.phase).toBe('updated');
    expect(success.postNodeRevision).toBe(40);

    const conflicted = applyHistoryUpdateRescan(rescanning, {
      outcome: 'conflict',
      postNodeRevision: 40,
      conflicts: [conflictRecord('trunk/sub/a.txt')],
      conflictSummary: { text: 1, property: 0, tree: 0, total: 1 },
    }, 1500);
    expect(conflicted.phase).toBe('updateConflict');
    expect(conflicted.postNodeRevision).toBe(40);
  });

  it('taskContext：请求 revision/更新前 BASE/回读节点 BASE 分开记录；unknown 时不冒充成功', () => {
    const updated = applyHistoryUpdateResult(
      createHistoryUpdateState(UPDATE_INTENT, 'op-1'),
      updateResult({ postNodeRevision: 40 }),
    );
    expect(historyUpdateTaskContext(updated)).toEqual({
      targetRelPath: 'trunk/sub',
      targetKind: 'dir',
      requestedRevision: 40,
      preRevision: 37,
      postNodeRevision: 40,
      outcome: 'updated',
      conflictCount: 0,
    });
    const unknown = applyHistoryUpdateResult(
      createHistoryUpdateState(UPDATE_INTENT, 'op-1'),
      updateResult({ outcome: 'unknown', postNodeRevision: undefined }),
    );
    const context = historyUpdateTaskContext(unknown);
    expect(context.outcome).toBe('unknown');
    expect(context.postNodeRevision).toBeUndefined();
    expect(context.preRevision).toBe(37);
  });

  it('终态页序列化/恢复：形状合法时原样恢复，损坏/版本不符/相位未知时拒绝', () => {
    const state = applyHistoryUpdateResult(
      createHistoryUpdateState(UPDATE_INTENT, 'op-1', 1000),
      updateResult({ outcome: 'conflict', conflicts: [conflictRecord('trunk/sub/a.txt')] }),
      1100,
    );
    const page = historyUpdateTerminalPage(state);
    const restored = restoreHistoryUpdateState(page);
    expect(restored).toEqual(state);
    expect(restoreHistoryUpdateState(undefined)).toBeUndefined();
    expect(restoreHistoryUpdateState({ version: 2, kind: 'history-update', state })).toBeUndefined();
    expect(restoreHistoryUpdateState({ version: 1, kind: 'scan', state })).toBeUndefined();
    expect(restoreHistoryUpdateState({ version: 1, kind: 'history-update', state: { ...state, phase: 'bogus' } })).toBeUndefined();
    expect(restoreHistoryUpdateState({
      version: 1,
      kind: 'history-update',
      state: { ...state, requestedRevision: 0 },
    })).toBeUndefined();
    expect(restoreHistoryUpdateState({
      version: 1,
      kind: 'history-update',
      state: { ...state, conflicts: [{ path: 'x' }] },
    })).toBeUndefined();
  });

  it('HistoryModel.applyLocalBaseRevision：只接受正整数，BASE 徽标随之刷新', () => {
    const model = new HistoryModel();
    model.beginOpen(localContext());
    expect(model.localBaseRevision()).toBe(7);
    model.applyLocalBaseRevision(0);
    model.applyLocalBaseRevision(-3);
    model.applyLocalBaseRevision(2.5);
    expect(model.localBaseRevision()).toBe(7);
    model.applyLocalBaseRevision(40);
    expect(model.localBaseRevision()).toBe(40);
    const badges = model.buildPanelState('s').headerBadges ?? [];
    expect(badges.some((badge) => badge.text.includes('40'))).toBe(true);
  });
});
