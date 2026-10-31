/**
 * P1 提交面板的渲染态构建与选择规则测试（commitModel 纯函数）：
 * 分组推导、默认勾选、目录联动、筛选值编码（真实值与哨兵不冲突）、
 * 树形嵌套、changelist 整组选择语义、前缀不叠加。
 */
import { describe, expect, it } from 'vitest';
import type { StatusEntry } from '../src/core/status';
import type { RemoteStatusEntry } from '../src/core/remoteStatus';
import {
  applyDirectoryLinkage,
  applyPrefixToMessage,
  buildGroupRows,
  buildPanelState,
  CHANGELIST_UNASSIGNED,
  CHANGELIST_VALUE_PREFIX,
  defaultSelectedPaths,
  entryMatchesFilters,
  extFilterValue,
  isSelectableEntry,
  mergeStatusEntries,
  statusFilterValue,
  visibleMetas,
  type CommitEntryMeta,
  type CommitSessionState,
} from '../src/host/panel/commitModel';

function meta(path: string, patch: Partial<CommitEntryMeta> = {}): CommitEntryMeta {
  return {
    path,
    wcStatus: 'modified',
    kind: 'file',
    props: 'none',
    changelist: null,
    group: 'local',
    isSymlink: false,
    isNestedWc: false,
    ...patch,
  };
}

function sessionOf(metas: CommitEntryMeta[], patch: Partial<CommitSessionState> = {}): CommitSessionState {
  return {
    sessionId: 's1',
    wcRoot: '/wc',
    targetPath: '/wc',
    targetArg: '.',
    metas,
    selectedPaths: new Set(),
    viewMode: 'tree',
    filters: { status: 'all', ext: 'all', changelist: 'all' },
    message: '',
    allowEmpty: true,
    prefixes: [],
    history: [],
    phase: 'ready',
    error: null,
    result: null,
    addedPrepared: [],
    missingPrepared: [],
    initialMessage: '',
    initialSelectionKey: '',
    remoteIncluded: false,
    externalPrefixes: [],
    ...patch,
  };
}

describe('mergeStatusEntries 分组推导', () => {
  const local: StatusEntry[] = [
    { path: 'm.txt', wcStatus: 'modified', props: 'none', changelist: null },
    { path: 'u.txt', wcStatus: 'unversioned', props: 'none', changelist: null },
    { path: 'c.txt', wcStatus: 'conflicted', props: 'none', changelist: null },
    { path: '.', wcStatus: 'normal', props: 'modified', changelist: null },
  ];
  const remote: RemoteStatusEntry[] = [
    { path: 'incoming.ts', wcStatus: 'none', reposStatus: 'added' },
    { path: 'm.txt', wcStatus: 'modified', reposStatus: 'modified' },
    { path: 'clean.txt', wcStatus: 'normal', reposStatus: 'none' },
  ];

  it('本地可提交 → local；unversioned/conflicted 独立分组；仅远端 → remote；无变化不进面板', () => {
    const metas = mergeStatusEntries(local, remote);
    const byPath = new Map(metas.map((item) => [item.path, item]));
    expect(byPath.get('m.txt')?.group).toBe('local');
    expect(byPath.get('m.txt')?.reposStatus).toBe('modified');
    expect(byPath.get('u.txt')?.group).toBe('unversioned');
    expect(byPath.get('c.txt')?.group).toBe('conflict');
    expect(byPath.get('.')?.group).toBe('local');
    expect(byPath.get('incoming.ts')?.group).toBe('remote');
    expect(byPath.has('clean.txt')).toBe(false);
  });
});

describe('默认选择与目录联动', () => {
  it('本地可提交默认全选；unversioned 默认不选、可勾选；嵌套副本不可勾选', () => {
    const metas = [
      meta('a.txt'),
      meta('b.txt', { wcStatus: 'unversioned', group: 'unversioned' }),
      meta('nested', { wcStatus: 'unversioned', kind: 'dir', group: 'unversioned', isNestedWc: true }),
    ];
    const selected = defaultSelectedPaths(metas);
    expect(selected.has('a.txt')).toBe(true);
    expect(selected.has('b.txt')).toBe(false);
    expect(isSelectableEntry(metas[1]!)).toBe(true);
    expect(isSelectableEntry(metas[2]!)).toBe(false);
  });

  it('删除/missing 目录勾选联动完整子树；unversioned 子项勾选联动必要父目录', () => {
    const metas = [
      meta('old', { kind: 'dir', wcStatus: 'deleted' }),
      meta('old/keep.txt'),
      meta('old/skip.txt', { wcStatus: 'unversioned', group: 'unversioned' }),
      meta('newdir', { kind: 'dir', wcStatus: 'unversioned', group: 'unversioned' }),
      meta('newdir/main.ts', { wcStatus: 'unversioned', group: 'unversioned' }),
      meta('newdir/other.ts', { wcStatus: 'unversioned', group: 'unversioned' }),
    ];
    const selected = applyDirectoryLinkage(metas, new Set(['old', 'newdir/main.ts']));
    // 删除目录：子树内可选行全部选中（含 unversioned，与原型一致；
    // 真实数据中 missing 目录下的子项只会是版本控制缺失项）。
    expect(selected.has('old/keep.txt')).toBe(true);
    expect(selected.has('old/skip.txt')).toBe(true);
    // 必要父目录自动选中；未选兄弟文件不带入选择。
    expect(selected.has('newdir')).toBe(true);
    expect(selected.has('newdir/other.ts')).toBe(false);
  });
});

describe('筛选值编码与叠加', () => {
  it('后缀/changelist 真实值带前缀，与哨兵不冲突（真实名可以是 all/<none>）', () => {
    expect(extFilterValue('a.ts', 'file')).toBe('value:ts');
    expect(extFilterValue('noext', 'file')).toBe('none');
    expect(extFilterValue('src', 'dir')).toBe('directory');
    const clAll = meta('x', { changelist: 'all' });
    const clNone = meta('y', { changelist: '<none>' });
    expect(statusFilterValue(clAll)).toBe('modified');
    expect(buildPanelState(sessionOf([clAll, clNone])).list!.filters![2]!.options.map((o) => o.value)).toContain(
      `${CHANGELIST_VALUE_PREFIX}all`,
    );
  });

  it('纯属性条目的状态筛选值是 props 伪值；三条件叠加只改可见性', () => {
    const propOnly = meta('.', { wcStatus: 'normal', props: 'modified', kind: 'dir' });
    const file = meta('a.ts', { changelist: 'mylist' });
    expect(statusFilterValue(propOnly)).toBe('props');
    const session = sessionOf([propOnly, file], {
      filters: { status: 'props', ext: 'all', changelist: `${CHANGELIST_VALUE_PREFIX}mylist` },
    });
    // 状态 props + changelist mylist 叠加：无命中（propOnly 未分组）。
    expect(visibleMetas(session)).toHaveLength(0);
    session.filters = { status: 'all', ext: 'all', changelist: CHANGELIST_UNASSIGNED };
    expect(visibleMetas(session).map((item) => item.path)).toEqual(['.']);
    expect(entryMatchesFilters(file, session.filters)).toBe(false);
  });
});

describe('buildGroupRows 树形构建', () => {
  it('导航目录组织路径，目录条目行挂自身路径下；根条目置顶', () => {
    const metas = [
      meta('src/core/a.ts'),
      meta('src', { kind: 'dir', props: 'modified' }),
      meta('.', { wcStatus: 'normal', props: 'modified', kind: 'dir' }),
    ];
    const rows = buildGroupRows('local', metas, new Set(['src/core/a.ts']));
    expect(rows[0]?.id).toBe('.');
    const nav = rows[1];
    expect(nav?.nav?.path).toBe('src');
    // src 导航下：先子导航 core，再 src 自身的目录属性行。
    const coreNav = nav?.children?.[0];
    expect(coreNav?.nav?.path).toBe('src/core');
    const leaf = coreNav?.children?.[0];
    expect(leaf?.id).toBe('src/core/a.ts');
    expect(leaf?.selected).toBe(true);
    const dirRow = nav?.children?.[1];
    expect(dirRow?.id).toBe('src');
    expect(dirRow?.cells.path).toBe('src');
  });

  it('渲染态含分组头、半选标记、待添加徽标与提交页脚', () => {
    const metas = [
      meta('a.txt', { changelist: 'mylist' }),
      meta('u.txt', { wcStatus: 'unversioned', group: 'unversioned' }),
    ];
    const session = sessionOf(metas, { selectedPaths: new Set(['a.txt', 'u.txt']) });
    const state = buildPanelState(session);
    const html = JSON.stringify(state);
    expect(state.list!.groups?.map((g) => g.id)).toEqual(['local', 'unversioned']);
    expect(state.footer?.primary?.label).toContain('2');
    expect(state.footer?.summary).toContain('待添加 1 项');
    // unversioned 勾选 → 待添加徽标。
    expect(html).toContain('待添加');
    // changelist 徽标按原值。
    expect(html).toContain('mylist');
  });

  it('空说明必填时提交按钮禁用；冲突存在时同样禁用', () => {
    const withConflict = sessionOf([meta('c', { wcStatus: 'conflicted', group: 'conflict' })], {
      selectedPaths: new Set(),
    });
    expect(buildPanelState(withConflict).footer?.primary?.disabled).toBe(true);

    const emptyBlocked = sessionOf([meta('a.txt')], {
      selectedPaths: new Set(['a.txt']),
      allowEmpty: false,
      message: '',
    });
    expect(buildPanelState(emptyBlocked).footer?.primary?.disabled).toBe(true);
    expect(buildPanelState(emptyBlocked).footer?.primary?.disabledReason).toContain('说明');
  });

  it('changelist 整组选择动作只在筛选为具体分组时出现', () => {
    const metas = [meta('a.txt', { changelist: 'mylist' })];
    const all = buildPanelState(sessionOf(metas));
    expect(all.list!.selectionActions?.some((a) => a.id === 'selectChangelist')).toBe(false);
    const filtered = buildPanelState(sessionOf(metas, { filters: { status: 'all', ext: 'all', changelist: 'name:mylist' } }));
    const action = filtered.list!.selectionActions?.find((a) => a.id === 'selectChangelist');
    expect(action?.label).toContain('mylist');
  });
});

describe('前缀应用', () => {
  it('前缀替换开头已有前缀，不叠加相同前缀', () => {
    const prefixes = ['修复', '功能'];
    expect(applyPrefixToMessage('修复：旧说明', prefixes, '功能')).toBe('功能：旧说明');
    expect(applyPrefixToMessage('功能:英文冒号', prefixes, '修复')).toBe('修复:英文冒号');
    expect(applyPrefixToMessage('无前缀', prefixes, '修复')).toBe('修复：无前缀');
    expect(applyPrefixToMessage('修复：一次', prefixes, '修复')).toBe('修复：一次');
  });
});
