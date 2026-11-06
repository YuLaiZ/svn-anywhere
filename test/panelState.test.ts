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
  sliceTableRows,
  visibleRows,
  type PanelState,
  type RowSpec,
  type SortableTableRow,
  type TableColumnSpec,
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

describe('reduce：P1 树形与分组事件', () => {
  function treeState(): PanelState {
    // local 组：src 导航下 a(可选)、b(disabled)；unversioned 组：u1。
    const srcNav: RowSpec = {
      id: 'local|src',
      nav: { path: 'src' },
      cells: {},
      children: [
        row('src/a', { group: 'local' }),
        row('src/b', { group: 'local', disabled: true, disabledReason: '冲突' }),
      ],
    };
    const uNav: RowSpec = {
      id: 'unversioned|src',
      nav: { path: 'src' },
      cells: {},
      children: [row('src/u1', { group: 'unversioned', cells: { path: 'src/u1', status: 'unversioned', ext: 'none' } })],
    };
    const state = listState([srcNav, uNav], [
      { id: 'status', cellKey: 'status', value: 'all', options: [] },
    ]);
    state.list!.groups = [{ id: 'local', label: '本地' }, { id: 'unversioned', label: '未版本控制' }];
    state.list!.viewMode = 'tree';
    return state;
  }

  it('toggleGroup 只作用于该组可见可选行；disabled 行不受影响', () => {
    const state = treeState();
    const next = reduce(state, { type: 'intent:toggleGroup', groupId: 'local', selected: true });
    expect(findRow(next.list!.rows, 'src/a')?.selected).toBe(true);
    expect(findRow(next.list!.rows, 'src/b')?.selected).toBeFalsy();
    // 筛选后组头只作用于可见行。
    const filtered = reduce(next, { type: 'intent:setFilter', filterId: 'status', value: 'unversioned' });
    const back = reduce(filtered, { type: 'intent:toggleGroup', groupId: 'local', selected: false });
    expect(findRow(back.list!.rows, 'src/a')?.selected).toBe(true);
  });

  it('toggleTree 聚合勾选作用于筛选后子树；折叠（视图态）不改变选择', () => {
    const state = treeState();
    const next = reduce(state, { type: 'intent:toggleTree', nodeId: 'local|src', selected: true });
    expect(findRow(next.list!.rows, 'src/a')?.selected).toBe(true);
    expect(next.list!.selection.total).toBe(1);
    // unversioned 子树不受 local 导航节点聚合影响。
    expect(findRow(next.list!.rows, 'src/u1')?.selected).toBeFalsy();
    // 筛选隐藏 local 子树后，聚合只作用于仍可见的 unversioned 导航子树。
    const filtered = reduce(state, { type: 'intent:setFilter', filterId: 'status', value: 'unversioned' });
    const picked = reduce(filtered, { type: 'intent:toggleTree', nodeId: 'unversioned|src', selected: true });
    expect(findRow(picked.list!.rows, 'src/u1')?.selected).toBe(true);
  });

  it('setView 切换树/列表不改选择与筛选', () => {
    const state = reduce(treeState(), { type: 'intent:toggleRow', rowId: 'src/a', selected: true });
    const next = reduce(state, { type: 'intent:setView', view: 'list' });
    expect(next.list!.viewMode).toBe('list');
    expect(next.list!.selection.total).toBe(1);
    expect(next.list!.filters![0].value).toBe('all');
  });

  it('selectVisible 只选可见可选行；clearSelection 清空全部', () => {
    const state = treeState();
    const some = reduce(state, { type: 'intent:selectVisible' });
    // 可见可选行：src/a 与 src/u1（disabled 的 src/b 不选）。
    expect(findRow(some.list!.rows, 'src/a')?.selected).toBe(true);
    expect(findRow(some.list!.rows, 'src/u1')?.selected).toBe(true);
    expect(findRow(some.list!.rows, 'src/b')?.selected).toBeFalsy();
    const cleared = reduce(some, { type: 'intent:clearSelection' });
    expect(cleared.list!.selection.total).toBe(0);
  });

  it('writeLocked（结果未知）期间拒绝全部写事件', () => {
    const state = { ...treeState(), writeLocked: true };
    expect(reduce(state, { type: 'intent:toggleRow', rowId: 'src/a', selected: true })).toBe(state);
    expect(reduce(state, { type: 'intent:toggleGroup', groupId: 'local', selected: true })).toBe(state);
    expect(reduce(state, { type: 'intent:toggleTree', nodeId: 'local|src', selected: true })).toBe(state);
    expect(reduce(state, { type: 'intent:setView', view: 'list' })).toBe(state);
    expect(reduce(state, { type: 'intent:selectVisible' })).toBe(state);
    expect(reduce(state, { type: 'intent:clearSelection' })).toBe(state);
    expect(reduce(state, { type: 'intent:setFilter', filterId: 'status', value: 'x' })).toBe(state);
    expect(reduce(state, { type: 'intent:dismissBanner', bannerId: 'n' })).toBe(state);
  });

  it('嵌套行的可见计数：导航节点不计入，隐藏已选仍计入 hidden', () => {
    const state = treeState();
    const picked = reduce(state, { type: 'intent:toggleRow', rowId: 'src/a', selected: true });
    const filtered = reduce(picked, { type: 'intent:setFilter', filterId: 'status', value: 'unversioned' });
    expect(filtered.list!.selection).toEqual({ total: 1, visible: 0, hidden: 1 });
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

describe('sliceTableRows：宿主侧排序/筛选/分页切片', () => {
  const columns: TableColumnSpec[] = [
    { key: 'path', label: '路径', sortable: true },
    { key: 'size', label: '大小', sortable: true, sortType: 'number', align: 'right' },
    { key: 'ext', label: '类型' },
  ];

  /** 大文件场景：size 列展示文本是格式化容量，排序值是业务字节值。 */
  function items(): SortableTableRow[] {
    return [
      { row: { id: 'a', cells: { path: 'docs/Big.PNG', size: '100 B', ext: 'png' } }, sortValues: { size: 100 } },
      { row: { id: 'b', cells: { path: 'src/core.ts', size: '9 GiB', ext: 'ts' } }, sortValues: { size: 96636764160 } },
      { row: { id: 'c', cells: { path: 'bin/app.dmg', size: '512 KiB', ext: 'dmg' } }, sortValues: { size: 524288 } },
      { row: { id: 'd', cells: { path: 'src/util.ts', size: '2 KiB', ext: 'ts' } }, sortValues: { size: 2048 } },
    ];
  }

  it("sortType='number' 按业务数值排序：9 GiB 排在 100 B 前（不按展示字符串）", () => {
    const slice = sliceTableRows(items(), columns, { key: 'size', direction: 'desc' }, undefined, 1, 50);
    expect(slice.rows.map((row) => row.id)).toEqual(['b', 'c', 'd', 'a']);
    const asc = sliceTableRows(items(), columns, { key: 'size', direction: 'asc' }, undefined, 1, 50);
    expect(asc.rows.map((row) => row.id)).toEqual(['a', 'd', 'c', 'b']);
  });

  it('字符串列按单元格文本排序，同值保持原序（稳定）', () => {
    const stable: SortableTableRow[] = [
      { row: { id: 'x1', cells: { path: 'b.txt', size: '', ext: 'ts' } } },
      { row: { id: 'x2', cells: { path: 'a.txt', size: '', ext: 'ts' } } },
      { row: { id: 'x3', cells: { path: 'b.txt', size: '', ext: 'dmg' } } },
    ];
    const slice = sliceTableRows(stable, columns, { key: 'path', direction: 'asc' }, undefined, 1, 50);
    expect(slice.rows.map((row) => row.id)).toEqual(['x2', 'x1', 'x3']);
  });

  it("text 筛选：作用列单元格值的大小写不敏感子串匹配（cellKey 绑定列）", () => {
    const slice = sliceTableRows(
      items(), columns, { key: 'size', direction: 'desc' },
      [{ id: 'path', kind: 'text', cellKey: 'path', value: 'BIG' }], 1, 50,
    );
    expect(slice.rows.map((row) => row.id)).toEqual(['a']);
  });

  it("select 筛选：作用列精确匹配；'all' 哨兵不过滤；多筛选叠加", () => {
    const extFilter = { id: 'ext', kind: 'select' as const, cellKey: 'ext', value: 'ts' };
    expect(
      sliceTableRows(items(), columns, { key: 'size', direction: 'desc' }, [extFilter], 1, 50).rows.map((r) => r.id),
    ).toEqual(['b', 'd']);
    expect(
      sliceTableRows(items(), columns, { key: 'size', direction: 'desc' }, [{ ...extFilter, value: 'all' }], 1, 50).total,
    ).toBe(4);
    // 路径子串 + 类型精确叠加：src 目录下的 ts 文件。
    expect(
      sliceTableRows(items(), columns, { key: 'size', direction: 'asc' },
        [{ id: 'path', kind: 'text', cellKey: 'path', value: 'src/' }, extFilter], 1, 50).rows.map((r) => r.id),
    ).toEqual(['d', 'b']);
  });

  it('分页切片：页码从 1 起、total/pageCount 为筛选后计数、越界页收敛到最后一页', () => {
    // path 升序：bin/app.dmg(c) < docs/Big.PNG(a) < src/core.ts(b) < src/util.ts(d)。
    const slice = sliceTableRows(items(), columns, { key: 'path', direction: 'asc' }, undefined, 2, 2);
    expect(slice).toMatchObject({ total: 4, pageCount: 2, page: 2 });
    expect(slice.rows.map((row) => row.id)).toEqual(['b', 'd']);
    const overflow = sliceTableRows(items(), columns, { key: 'path', direction: 'asc' }, undefined, 9, 2);
    expect(overflow.page).toBe(2);
    const empty = sliceTableRows([], columns, { key: 'path', direction: 'asc' }, undefined, 1, 50);
    expect(empty).toMatchObject({ total: 0, pageCount: 1, page: 1, rows: [] });
  });

  it('数值列缺排序值时回退展示文本数值化（排序值不进消息的宿主兜底）', () => {
    const fallback: SortableTableRow[] = [
      { row: { id: 'f1', cells: { path: 'x', size: '10', ext: '' } } },
      { row: { id: 'f2', cells: { path: 'y', size: '9', ext: '' } } },
    ];
    const slice = sliceTableRows(fallback, columns, { key: 'size', direction: 'desc' }, undefined, 1, 50);
    expect(slice.rows.map((row) => row.id)).toEqual(['f1', 'f2']);
  });
});
