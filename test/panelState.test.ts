/**
 * 面板基座 reducer 测试：勾选/筛选/输入同步/忙碌拒绝/快照合并，
 * 以及 0a typed fixture 的场景数据复用（映射表 §3.1 字段组合）。
 */
import { describe, expect, it } from 'vitest';
import { commitFixture, ignoreFixture } from '../src/host/panel/fixture';
import {
  countSelection,
  findRow,
  reduce,
  visibleRows,
  type PanelState,
  type RowSpec,
} from '../src/host/panel/state';

function row(id: string, patch: Partial<RowSpec> = {}): RowSpec {
  return { id, cells: { path: id, status: 'modified', ext: 'value:ts' }, selected: false, ...patch };
}

function baseState(patch: Partial<PanelState> = {}): PanelState {
  return {
    sessionId: 'session-a',
    title: 'T',
    targetLabel: 'wc',
    revision: 1,
    formRevision: 0,
    busy: false,
    banners: [],
    ...patch,
  };
}

function listState(rows: RowSpec[], filters?: PanelState['list'] extends infer L ? L extends { filters?: infer F } ? F : never : never): PanelState {
  return baseState({
    list: {
      id: 'l',
      columns: [{ key: 'path', label: 'path' }],
      rows,
      filters: filters ?? [
        { id: 'status', cellKey: 'status', value: 'all', options: [] },
      ],
      selection: { total: 0, visible: 0, hidden: 0 },
      empty: { title: 'empty' },
    },
  });
}

describe('reduce：勾选', () => {
  it('勾选与取消更新行并重算计数', () => {
    const state = listState([row('a'), row('b')]);
    const next = reduce(state, { type: 'intent:toggleRow', rowId: 'a', selected: true });
    expect(findRow(next.list!.rows, 'a')?.selected).toBe(true);
    expect(next.list!.selection).toEqual({ total: 1, visible: 1, hidden: 0 });
  });

  it('busy 期间拒绝勾选（事件守卫与 DOM 禁用一致的最后一道防线）', () => {
    const state = { ...listState([row('a')]), busy: true };
    const next = reduce(state, { type: 'intent:toggleRow', rowId: 'a', selected: true });
    expect(next).toBe(state);
  });

  it('disabled 行与未知行保持不变', () => {
    const state = listState([row('a', { disabled: true, disabledReason: '冲突' }), row('b')]);
    expect(reduce(state, { type: 'intent:toggleRow', rowId: 'a', selected: true })).toBe(state);
    expect(reduce(state, { type: 'intent:toggleRow', rowId: 'zzz', selected: true })).toBe(state);
  });
});

describe('reduce：筛选', () => {
  const rows = [
    row('a', { selected: true }),
    row('b', { cells: { path: 'b', status: 'unversioned', ext: 'none' } }),
    row('c', { selected: true, cells: { path: 'c', status: 'unversioned', ext: 'none' } }),
  ];

  it('筛选只改变可见性，保留全局选择并提示隐藏已选数', () => {
    const state = listState(rows);
    const next = reduce(state, { type: 'intent:setFilter', filterId: 'status', value: 'unversioned' });
    expect(next.list!.filters![0].value).toBe('unversioned');
    expect(visibleRows(next.list!.rows, next.list!.filters).map((r) => r.id)).toEqual(['b', 'c']);
    // 全局选择保留：a、c 仍选中；隐藏的 a 计入 hidden。
    expect(next.list!.selection).toEqual({ total: 2, visible: 1, hidden: 1 });
  });

  it('未知筛选 ID 不生效；busy 拒绝筛选', () => {
    const state = listState(rows);
    expect(reduce(state, { type: 'intent:setFilter', filterId: 'zzz', value: 'x' })).toBe(state);
    const busyState = { ...state, busy: true };
    expect(reduce(busyState, { type: 'intent:setFilter', filterId: 'status', value: 'x' })).toBe(busyState);
  });
});

describe('reduce：输入同步与忙碌', () => {
  it('syncInput 更新字段值并递增 formRevision', () => {
    const state = baseState({
      form: { id: 'f', busy: false, fields: [{ id: 'message', label: 'm', value: '', type: 'textarea' }] },
    });
    const next = reduce(state, { type: 'intent:syncInput', fieldId: 'message', value: '第一行\n第二行' });
    expect(next.form!.fields[0].value).toBe('第一行\n第二行');
    expect(next.formRevision).toBe(1);
  });

  it('disabled 字段与未知字段的输入被拒绝', () => {
    const state = baseState({
      form: { id: 'f', busy: false, fields: [{ id: 'message', label: 'm', value: '', type: 'textarea', disabled: true }] },
    });
    expect(reduce(state, { type: 'intent:syncInput', fieldId: 'message', value: 'x' })).toBe(state);
    expect(reduce(state, { type: 'intent:syncInput', fieldId: 'zzz', value: 'x' })).toBe(state);
  });

  it('beginBusy/endBusy 幂等', () => {
    const state = baseState();
    const busy = reduce(state, { type: 'host:beginBusy' });
    expect(busy.busy).toBe(true);
    expect(reduce(busy, { type: 'host:beginBusy' })).toBe(busy);
    const idle = reduce(busy, { type: 'host:endBusy' });
    expect(idle.busy).toBe(false);
    expect(reduce(idle, { type: 'host:endBusy' })).toBe(idle);
  });
});

describe('reduce：提示条与快照', () => {
  it('dismissBanner 移除目标条目；未知 ID 幂等', () => {
    const state = baseState({ banners: [{ id: 'n1', level: 'error', title: 'x' }] });
    const next = reduce(state, { type: 'intent:dismissBanner', bannerId: 'n1' });
    expect(next.banners).toHaveLength(0);
    expect(reduce(next, { type: 'intent:dismissBanner', bannerId: 'n1' })).toBe(next);
  });

  it('host:snapshot 整体替换并重算选择计数，不回退 formRevision', () => {
    const state = { ...listState([row('a')]), formRevision: 7 };
    const next = reduce(state, {
      type: 'host:snapshot',
      patch: { list: { ...state.list!, rows: [row('a', { selected: true }), row('b')] } },
    });
    expect(next.list!.rows).toHaveLength(2);
    expect(next.list!.selection.total).toBe(1);
    expect(next.formRevision).toBe(7);
    expect(next.sessionId).toBe('session-a');
  });
});

describe('0a typed fixture 复用', () => {
  it('P1 场景 fixture 按 §3.1 字段组合落成正式字段', () => {
    const normal = commitFixture('normal');
    expect(normal.phase).toBe('ready');
    expect(normal.items.some((item) => item.group === 'unversioned' && !item.selected)).toBe(true);

    const conflict = commitFixture('conflict');
    const conflicted = conflict.items.find((item) => item.id === 'c1');
    expect(conflicted).toMatchObject({ wcStatus: 'conflicted', group: 'conflict', selected: false });

    const missing = commitFixture('missing');
    expect(missing.items.some((item) => item.wcStatus === 'missing')).toBe(true);

    const changelist = commitFixture('changelist');
    expect(changelist.filters.changelist).toEqual({ kind: 'name', value: 'mylist' });

    const committing = commitFixture('committing');
    expect(committing.busy).toBe(true);
    expect(committing.phase).toBe('committing');

    const success = commitFixture('success');
    expect(success.result).toEqual({
      kind: 'success',
      revisions: [128],
      committedIds: ['s1', 's2', 's3', 's4', 's5', 's6'],
    });

    const large = commitFixture('large');
    expect(large.items).toHaveLength(200);

    // 不进正式类型的原型字段不出现。
    expect(Object.keys(commitFixture('normal'))).not.toContain('notice');
    expect(commitFixture('normal').items[0]).not.toHaveProperty('simulatedOutcome');
  });

  it('P2 fixture 四层值分开且无剥离字段', () => {
    const p2 = ignoreFixture();
    expect(p2.workingSnapshot.rules).toEqual(p2.savedRules);
    expect(p2.otherProperties[0]).toEqual({ name: 'custom:keep', modified: false });
    expect(Object.keys(p2)).not.toContain('successVisible');
    expect(Object.keys(p2)).not.toContain('externalRules');
  });

  it('countSelection 与 visibleRows 的组合语义', () => {
    const list = {
      id: 'l',
      columns: [] as Array<{ key: string; label: string }>,
      rows: [row('a', { selected: true }), row('b')],
      filters: [{ id: 'status', cellKey: 'status', value: 'modified', options: [] }],
      selection: { total: 0, visible: 0, hidden: 0 },
      empty: { title: 'e' },
    };
    expect(countSelection(list)).toEqual({ total: 1, visible: 1, hidden: 0 });
  });
});
