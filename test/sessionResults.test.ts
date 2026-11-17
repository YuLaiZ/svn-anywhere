/**
 * 面板会话结果缓存测试：写入者分类（controller 写侧作用域校验 /
 * executor 一律写入）、读取命中校验（作用域基准不一致丢弃）、清除的
 * 作用域保护、只读命令进行中登记（发起/命中条件/结论结算的推送与
 * 守卫丢弃不推送）。
 *
 * M4 增补 m4SessionStore（多作用域 LRU ≤24）：作用域隔离与合并、恢复
 * 顺序（活动任务→终态页→可浏览→fresh）、淘汰顺序（先清最旧
 * 非当前终态页、随后整体淘汰最旧非活动作用域）、当前/活动任务不淘汰、
 * 淘汰后重开 fresh。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginReadonlyVerify,
  clearM4ScopeSession,
  clearM4TerminalPage,
  clearReadonlyVerify,
  clearSessionResult,
  listM4ScopeSessions,
  m4SessionStoreSize,
  matchReadonlyVerify,
  onSessionResultUpdated,
  planM4SessionRestore,
  putM4ScopeSession,
  readM4ScopeSession,
  readSessionResult,
  resetM4SessionStore,
  resetSessionResults,
  sameM4SessionScope,
  settleReadonlyVerify,
  writeSessionResult,
  type BrowseSessionScope,
  type HistoryUpperState,
  type M4SessionScope,
} from '../src/host/sessionResults';
import type {
  CheckoutResultScope,
  ConflictsResultScope,
  DiskResultScope,
  HistoryResultScope,
  TaskObject,
} from '../src/host/taskRegistry';
import { addTask, resetTaskRegistry } from '../src/host/taskRegistry';

const scopeA: CheckoutResultScope = { scopeKind: 'checkout', entryKey: '/entry/a', mode: 'checkout' };
const scopeAImport: CheckoutResultScope = { scopeKind: 'checkout', entryKey: '/entry/a', mode: 'import' };
const scopeB: CheckoutResultScope = { scopeKind: 'checkout', entryKey: '/entry/b', mode: 'checkout' };
const diskScope: DiskResultScope = { scopeKind: 'disk', wcRoot: '/wc/root' };

beforeEach(() => {
  resetSessionResults();
  resetTaskRegistry();
});

describe('写入者分类', () => {
  it('controller 空槽写入成功', () => {
    expect(writeSessionResult('checkout', scopeA, { kind: 'resumable' }, 'controller')).toBe(true);
    expect(readSessionResult('checkout', scopeA)?.page).toEqual({ kind: 'resumable' });
  });

  it('controller 同作用域覆盖', () => {
    writeSessionResult('checkout', scopeA, { v: 1 }, 'controller');
    expect(writeSessionResult('checkout', { scopeKind: 'checkout', entryKey: '/entry/a', mode: 'checkout' }, { v: 2 }, 'controller')).toBe(true);
    expect(readSessionResult('checkout', scopeA)?.page).toEqual({ v: 2 });
  });

  it('controller 跨作用域丢弃：返回 false 且槽内其他作用域的结果页不被覆盖', () => {
    writeSessionResult('checkout', scopeB, { kind: 'success' }, 'executor');
    expect(writeSessionResult('checkout', scopeA, { kind: 'resumable' }, 'controller')).toBe(false);
    expect(readSessionResult('checkout', scopeB)?.page).toEqual({ kind: 'success' });
  });

  it('executor 一律写入：空槽、同作用域、跨作用域旧页均写入/覆盖', () => {
    expect(writeSessionResult('checkout', scopeA, { v: 1 }, 'executor')).toBe(true);
    expect(writeSessionResult('checkout', scopeA, { v: 2 }, 'executor')).toBe(true);
    // 槽内已有其他作用域的过期结论页时，执行器终态（真实新结果）仍覆盖。
    writeSessionResult('checkout', scopeB, { kind: 'stale-verify' }, 'controller');
    expect(writeSessionResult('checkout', scopeA, { kind: 'success' }, 'executor')).toBe(true);
    expect(readSessionResult('checkout', scopeA)?.page).toEqual({ kind: 'success' });
  });

  it('缓存按面板类别单槽键控：检出与磁盘互不挤占', () => {
    writeSessionResult('checkout', scopeA, { p: 'p3' }, 'executor');
    writeSessionResult('disk', diskScope, { p: 'p4' }, 'executor');
    expect(readSessionResult('checkout', scopeA)?.page).toEqual({ p: 'p3' });
    expect(readSessionResult('disk', diskScope)?.page).toEqual({ p: 'p4' });
  });
});

describe('读取命中校验', () => {
  it('基准一致返回缓存项（含作用域与结果页）', () => {
    writeSessionResult('checkout', scopeA, { kind: 'canceled' }, 'executor');
    const entry = readSessionResult('checkout', { scopeKind: 'checkout', entryKey: '/entry/a', mode: 'checkout' });
    expect(entry?.resultScope).toEqual(scopeA);
    expect(entry?.page).toEqual({ kind: 'canceled' });
  });

  it('入口键不一致：丢弃该缓存项并返回 undefined，后续读取也不再命中', () => {
    writeSessionResult('checkout', scopeA, { kind: 'canceled' }, 'executor');
    expect(readSessionResult('checkout', scopeB)).toBeUndefined();
    expect(readSessionResult('checkout', scopeA)).toBeUndefined();
  });

  it('模式不一致同样丢弃', () => {
    writeSessionResult('checkout', scopeA, { kind: 'canceled' }, 'executor');
    expect(readSessionResult('checkout', scopeAImport)).toBeUndefined();
  });

  it('绑定会话基准：按任务作用域读取可命中跨入口写入的缓存', () => {
    // 从入口 B 打开、绑定 resultScope=A 的任务：任务终态按 A 写入缓存，
    // 会话以任务作用域 A 为基准命中（跨入口绑定的结果页不因本次打开
    // 入口不一致被丢弃）。
    writeSessionResult('checkout', scopeA, { kind: 'success' }, 'executor');
    const entry = readSessionResult('checkout', scopeA);
    expect(entry?.page).toEqual({ kind: 'success' });
  });

  it('空槽返回 undefined', () => {
    expect(readSessionResult('checkout', scopeA)).toBeUndefined();
  });
});

describe('清除', () => {
  it('不带作用域无条件清空该面板槽', () => {
    writeSessionResult('checkout', scopeA, { v: 1 }, 'executor');
    expect(clearSessionResult('checkout')).toBe(true);
    expect(readSessionResult('checkout', scopeA)).toBeUndefined();
    expect(clearSessionResult('checkout')).toBe(false);
  });

  it('带作用域仅清匹配项；不匹配不动槽（防跨作用域误清）', () => {
    writeSessionResult('checkout', scopeA, { v: 1 }, 'executor');
    expect(clearSessionResult('checkout', scopeB)).toBe(false);
    expect(readSessionResult('checkout', scopeA)?.page).toEqual({ v: 1 });
    expect(clearSessionResult('checkout', scopeA)).toBe(true);
    expect(readSessionResult('checkout', scopeA)).toBeUndefined();
  });
});

describe('只读命令进行中登记', () => {
  it('发起后按作用域与代次命中', () => {
    beginReadonlyVerify('checkout', scopeA, 3);
    expect(matchReadonlyVerify('checkout', scopeA, 3)).toBe(true);
  });

  it('作用域不一致不命中，且登记保留（匹配条件恢复后仍可命中）', () => {
    beginReadonlyVerify('checkout', scopeA, 3);
    expect(matchReadonlyVerify('checkout', scopeB, 3)).toBe(false);
    expect(matchReadonlyVerify('checkout', scopeAImport, 3)).toBe(false);
    // 不一致的比对不清除登记：A 的结论仍送 A。
    expect(matchReadonlyVerify('checkout', scopeA, 3)).toBe(true);
  });

  it('代次不一致不命中（同作用域新任务结果页不挂旧核验提示）', () => {
    beginReadonlyVerify('checkout', scopeA, 3);
    expect(matchReadonlyVerify('checkout', scopeA, 4)).toBe(false);
    expect(matchReadonlyVerify('checkout', scopeA, 2)).toBe(false);
  });

  it('无登记不命中', () => {
    expect(matchReadonlyVerify('checkout', scopeA, 0)).toBe(false);
  });

  it('登记按面板类别隔离', () => {
    beginReadonlyVerify('checkout', scopeA, 1);
    expect(matchReadonlyVerify('disk', diskScope, 1)).toBe(false);
  });

  it('结论写入缓存后结算：清除登记并向同面板存活会话推送一次重跑', () => {
    beginReadonlyVerify('checkout', scopeA, 2);
    const rerun = vi.fn();
    const otherPanel = vi.fn();
    onSessionResultUpdated('checkout', rerun);
    onSessionResultUpdated('disk', otherPanel);
    const written = writeSessionResult('checkout', scopeA, { kind: 'success' }, 'controller');
    expect(written).toBe(true);
    settleReadonlyVerify('checkout', true);
    expect(rerun).toHaveBeenCalledTimes(1);
    expect(otherPanel).not.toHaveBeenCalled();
    // 登记已清除：任何条件都不再命中。
    expect(matchReadonlyVerify('checkout', scopeA, 2)).toBe(false);
  });

  it('守卫丢弃的结算：清除登记、不推送', () => {
    beginReadonlyVerify('checkout', scopeA, 2);
    const rerun = vi.fn();
    onSessionResultUpdated('checkout', rerun);
    settleReadonlyVerify('checkout', false);
    expect(rerun).not.toHaveBeenCalled();
    expect(matchReadonlyVerify('checkout', scopeA, 2)).toBe(false);
  });

  it('无登记时结算不推送', () => {
    const rerun = vi.fn();
    onSessionResultUpdated('checkout', rerun);
    settleReadonlyVerify('checkout', true);
    expect(rerun).not.toHaveBeenCalled();
  });

  it('clearReadonlyVerify 清除登记且不推送（异常出口）', () => {
    beginReadonlyVerify('checkout', scopeA, 1);
    const rerun = vi.fn();
    onSessionResultUpdated('checkout', rerun);
    clearReadonlyVerify('checkout');
    expect(rerun).not.toHaveBeenCalled();
    expect(matchReadonlyVerify('checkout', scopeA, 1)).toBe(false);
  });

  it('重跑订阅 dispose 后不再推送；多次结算只按各自登记投递', () => {
    const stale = vi.fn();
    const sub = onSessionResultUpdated('checkout', stale);
    sub.dispose();
    beginReadonlyVerify('checkout', scopeA, 1);
    settleReadonlyVerify('checkout', true);
    expect(stale).not.toHaveBeenCalled();
  });
});

/* --------------------- m4SessionStore：多作用域 LRU --------------------- */

function historyScope(targetKey: string, targetKind: 'file' | 'dir' = 'file'): HistoryResultScope {
  return { scopeKind: 'history', targetKey, targetKind };
}

function conflictsScope(wcRoot: string, scopeRelPath = '.'): ConflictsResultScope {
  return { scopeKind: 'conflicts', wcRoot, scopeRelPath };
}

function browseScope(targetKey: string): BrowseSessionScope {
  return { scopeKind: 'browse', targetKey };
}

/**
 * 预置 N 个 history 作用域（t1 最旧 → tN 最新）：每项都有可浏览状态，
 * terminalAt 指定的序号额外带终态页、limitAt 指定的序号带 historyLimitState。
 * N≤24 时插入不触发淘汰。
 */
function seedHistoryScopes(
  count: number,
  options: { terminalAt?: number[]; limitAt?: number[] } = {},
): HistoryResultScope[] {
  const scopes: HistoryResultScope[] = [];
  for (let index = 1; index <= count; index += 1) {
    const scope = historyScope(`t${index}`);
    scopes.push(scope);
    putM4ScopeSession(scope, {
      browsable: { target: `t${index}` },
      ...(options.terminalAt?.includes(index) ? { terminalPage: { target: `t${index}` } } : {}),
      ...(options.limitAt?.includes(index) ? { historyLimitState: { reasons: [] } } : {}),
    });
  }
  return scopes;
}

describe('m4SessionStore：作用域隔离与字段读写', () => {
  it('不同作用域隔离：P6 upper/historyLimitState 与 P7 冲突快照/推迟/台账各存各项', () => {
    const history = historyScope('repo/a/b.ts', 'file');
    const upper: HistoryUpperState = {
      upperRevision: 42,
      upperSource: 'live-head',
      headState: 'available',
    };
    putM4ScopeSession(history, {
      browsable: { filter: '关键词' },
      upper,
      historyLimitState: { reasons: [{ kind: 'matched', limit: 5000, actual: 5001 }] },
    });
    const conflicts = conflictsScope('/wc/root');
    putM4ScopeSession(conflicts, {
      conflictSnapshot: ['conflict-1'],
      postponed: ['fingerprint-1'],
      resolvedLedger: ['fingerprint-0'],
    });

    expect(readM4ScopeSession(history)?.upper).toEqual(upper);
    expect(readM4ScopeSession(history)?.historyLimitState?.reasons).toEqual([
      { kind: 'matched', limit: 5000, actual: 5001 },
    ]);
    expect(readM4ScopeSession(conflicts)?.conflictSnapshot).toEqual(['conflict-1']);
    expect(readM4ScopeSession(conflicts)?.postponed).toEqual(['fingerprint-1']);
    expect(readM4ScopeSession(conflicts)?.resolvedLedger).toEqual(['fingerprint-0']);
    expect(readM4ScopeSession(conflicts)?.upper).toBeUndefined();
    expect(m4SessionStoreSize()).toBe(2);
  });

  it('同作用域合并补丁：未提供字段保留，提供字段覆盖（终态页与可浏览状态并存）', () => {
    const scope = historyScope('repo/a');
    putM4ScopeSession(scope, { browsable: { page: 1 } });
    putM4ScopeSession(scope, { terminalPage: { kind: 'success' } });
    const entry = readM4ScopeSession(scope);
    expect(entry?.browsable).toEqual({ page: 1 });
    expect(entry?.terminalPage).toEqual({ kind: 'success' });
    putM4ScopeSession(scope, { terminalPage: { kind: 'updated' } });
    expect(readM4ScopeSession(scope)?.terminalPage).toEqual({ kind: 'updated' });
  });

  it('identity 区分：同 targetKey 不同 targetKind 是两个项；browse/conflicts 各自成项', () => {
    putM4ScopeSession(historyScope('same', 'file'), { browsable: 'file' });
    putM4ScopeSession(historyScope('same', 'dir'), { browsable: 'dir' });
    putM4ScopeSession(browseScope('same'), { browsable: 'browse' });
    putM4ScopeSession(conflictsScope('same'), { browsable: 'conflicts' });
    expect(m4SessionStoreSize()).toBe(4);
    expect(readM4ScopeSession(historyScope('same', 'file'))?.browsable).toBe('file');
    expect(readM4ScopeSession(historyScope('same', 'dir'))?.browsable).toBe('dir');
    expect(readM4ScopeSession(browseScope('same'))?.browsable).toBe('browse');
    expect(readM4ScopeSession(conflictsScope('same'))?.browsable).toBe('conflicts');
  });

  it('sameM4SessionScope：按 scopeKind 判别比较 identity，跨类别必不等', () => {
    expect(sameM4SessionScope(historyScope('a'), historyScope('a'))).toBe(true);
    expect(sameM4SessionScope(historyScope('a', 'file'), historyScope('a', 'dir'))).toBe(false);
    expect(sameM4SessionScope(browseScope('a'), browseScope('a'))).toBe(true);
    expect(sameM4SessionScope(conflictsScope('/wc', 'src'), conflictsScope('/wc', 'src'))).toBe(true);
    expect(sameM4SessionScope(conflictsScope('/wc', 'src'), conflictsScope('/wc', 'lib'))).toBe(false);
    expect(sameM4SessionScope(browseScope('a'), historyScope('a'))).toBe(false);
    expect(sameM4SessionScope(historyScope('a'), conflictsScope('a'))).toBe(false);
  });

  it('read 返回拷贝：调用方修改返回值不影响存储内容', () => {
    const scope = historyScope('repo/a');
    putM4ScopeSession(scope, { terminalPage: { v: 1 } });
    const copy = readM4ScopeSession(scope);
    expect(copy).toBeDefined();
    (copy as { terminalPage?: unknown }).terminalPage = { v: 2 };
    expect(readM4ScopeSession(scope)?.terminalPage).toEqual({ v: 1 });
  });

  it('clearM4TerminalPage 只清页不减少项数；clearM4ScopeSession 删除整项', () => {
    const scope = historyScope('repo/a');
    putM4ScopeSession(scope, { browsable: 'b', terminalPage: 'p' });
    expect(clearM4TerminalPage(scope)).toBe(true);
    expect(clearM4TerminalPage(scope)).toBe(false);
    expect(m4SessionStoreSize()).toBe(1);
    expect(readM4ScopeSession(scope)?.browsable).toBe('b');
    expect(readM4ScopeSession(scope)?.terminalPage).toBeUndefined();
    expect(clearM4ScopeSession(scope)).toBe(true);
    expect(readM4ScopeSession(scope)).toBeUndefined();
    expect(m4SessionStoreSize()).toBe(0);
  });

  it('historyLimitState 支持显式写入 null（无提示）与淘汰时整项丢弃', () => {
    const scope = historyScope('repo/a');
    putM4ScopeSession(scope, { historyLimitState: { reasons: [] } });
    expect(readM4ScopeSession(scope)?.historyLimitState).toEqual({ reasons: [] });
    putM4ScopeSession(scope, { historyLimitState: null });
    expect(readM4ScopeSession(scope)?.historyLimitState).toBeNull();
  });
});

describe('m4SessionStore：控制器恢复顺序（活动任务→终态页→可浏览→fresh）', () => {
  const scope = historyScope('repo/recover');

  it('活动任务绑定优先于任何缓存层', () => {
    putM4ScopeSession(scope, { terminalPage: 'p', browsable: 'b' });
    expect(planM4SessionRestore({ hasActiveTask: true, scope })).toEqual({ layer: 'active-task' });
  });

  it('当前作用域终态页优先于可浏览状态', () => {
    putM4ScopeSession(scope, { terminalPage: { kind: 'conflict' }, browsable: { filter: '' } });
    expect(planM4SessionRestore({ hasActiveTask: false, scope })).toEqual({
      layer: 'terminal-page',
      page: { kind: 'conflict' },
    });
  });

  it('无终态页时恢复到可浏览状态', () => {
    putM4ScopeSession(scope, { browsable: { filter: 'x' } });
    expect(planM4SessionRestore({ hasActiveTask: false, scope })).toEqual({
      layer: 'browsable',
      browsable: { filter: 'x' },
    });
  });

  it('无缓存项落到 fresh（不伪造旧状态）', () => {
    expect(planM4SessionRestore({ hasActiveTask: false, scope })).toEqual({ layer: 'fresh' });
  });

  it('终态页清除后恢复层降级为可浏览状态', () => {
    putM4ScopeSession(scope, { terminalPage: 'p', browsable: 'b' });
    clearM4TerminalPage(scope);
    expect(planM4SessionRestore({ hasActiveTask: false, scope })).toEqual({
      layer: 'browsable',
      browsable: 'b',
    });
  });

  it('显式写入 null 清空一层：恢复计划跳过该层（null 与本层无内容同义）', () => {
    putM4ScopeSession(scope, { terminalPage: 'p', browsable: 'b' });
    putM4ScopeSession(scope, { terminalPage: null });
    expect(planM4SessionRestore({ hasActiveTask: false, scope })).toEqual({
      layer: 'browsable',
      browsable: 'b',
    });
    putM4ScopeSession(scope, { browsable: null });
    expect(planM4SessionRestore({ hasActiveTask: false, scope })).toEqual({ layer: 'fresh' });
  });
});

describe('m4SessionStore：24 项容量与淘汰顺序', () => {
  it('第 25 项先清最旧非当前终态页（清页不减少项数），随后整体淘汰最旧非活动作用域', () => {
    const scopes = seedHistoryScopes(24, { terminalAt: [1] });
    const result = putM4ScopeSession(
      historyScope('t25'),
      { browsable: 'new' },
      { current: scopes[23] },
    );
    // 两个动作按序发生：先 terminal-page（项仍在），后 scope（整体淘汰）。
    expect(result.evictions).toEqual([
      { kind: 'terminal-page', scope: historyScope('t1') },
      { kind: 'scope', scope: historyScope('t1') },
    ]);
    expect(m4SessionStoreSize()).toBe(24);
    expect(readM4ScopeSession(scopes[0])).toBeUndefined();
    expect(readM4ScopeSession(scopes[23])).toBeDefined();
    expect(readM4ScopeSession(historyScope('t25'))).toBeDefined();
  });

  it('无可清终态页时跳过清页、直接整体 LRU 到 24', () => {
    const scopes = seedHistoryScopes(24);
    const result = putM4ScopeSession(historyScope('t25'), { browsable: 'new' }, { current: scopes[23] });
    expect(result.evictions).toEqual([{ kind: 'scope', scope: historyScope('t1') }]);
    expect(m4SessionStoreSize()).toBe(24);
  });

  it('清页与整体淘汰可以选中不同项：清终态页只清页、项数仍由整体 LRU 收回', () => {
    const scopes = seedHistoryScopes(24, { terminalAt: [3] });
    // t1 是当前作用域（无终态页）：清页跳过 t1/t2 找到 t3；整体淘汰最旧非活动 t2。
    const result = putM4ScopeSession(historyScope('t25'), { browsable: 'new' }, { current: scopes[0] });
    expect(result.evictions).toEqual([
      { kind: 'terminal-page', scope: historyScope('t3') },
      { kind: 'scope', scope: historyScope('t2') },
    ]);
    // t3 项保留（还有可浏览状态），但终态页已被清除。
    expect(readM4ScopeSession(scopes[2])?.terminalPage).toBeUndefined();
    expect(readM4ScopeSession(scopes[2])?.browsable).toEqual({ target: 't3' });
    expect(readM4ScopeSession(scopes[1])).toBeUndefined();
    expect(m4SessionStoreSize()).toBe(24);
  });

  it('当前作用域不被清页也不被淘汰（即使最旧）', () => {
    const scopes = seedHistoryScopes(24, { terminalAt: [1, 2] });
    const result = putM4ScopeSession(historyScope('t25'), {}, { current: scopes[0] });
    // 清页跳过当前 t1，命中 t2；整体淘汰跳过 t1，淘汰 t2。
    expect(result.evictions).toEqual([
      { kind: 'terminal-page', scope: historyScope('t2') },
      { kind: 'scope', scope: historyScope('t2') },
    ]);
    expect(readM4ScopeSession(scopes[0])?.terminalPage).toEqual({ target: 't1' });
  });

  it('活动任务作用域不被清页也不被淘汰（当前作用域之后的最旧非活动项被选中）', () => {
    const scopes = seedHistoryScopes(24, { terminalAt: [1, 3] });
    const result = putM4ScopeSession(historyScope('t25'), { browsable: 'new' }, {
      current: scopes[1],
      isActiveScope: (scope: M4SessionScope) => sameM4SessionScope(scope, scopes[0]),
    });
    // 清页跳过活动 t1 与当前 t2，命中 t3；整体淘汰同样跳过 t1/t2，淘汰 t3。
    expect(result.evictions).toEqual([
      { kind: 'terminal-page', scope: historyScope('t3') },
      { kind: 'scope', scope: historyScope('t3') },
    ]);
    expect(readM4ScopeSession(scopes[0])?.terminalPage).toEqual({ target: 't1' });
    expect(readM4ScopeSession(scopes[1])).toBeDefined();
    expect(readM4ScopeSession(scopes[2])).toBeUndefined();
  });

  it('活动任务作用域默认从共享任务注册表派生保护：不传 isActiveScope 也不清页/不淘汰', () => {
    const scopes = seedHistoryScopes(24, { terminalAt: [1, 3] });
    // 任务执行器写终态页时任务仍在共享注册表中：该作用域自动受保护。
    const active: TaskObject = {
      taskId: 'task-history',
      panelKind: 'history',
      phase: 'updating',
      resultScope: scopes[0],
      lockKey: '/wc/root',
      initiatorSessionId: 'session-1',
      abortController: new AbortController(),
    };
    addTask(active);
    const result = putM4ScopeSession(historyScope('t25'), { browsable: 'new' }, { current: scopes[1] });
    expect(result.evictions).toEqual([
      { kind: 'terminal-page', scope: historyScope('t3') },
      { kind: 'scope', scope: historyScope('t3') },
    ]);
    // 活动任务作用域保留终态页：任务移除后重开能恢复该页。
    expect(readM4ScopeSession(scopes[0])?.terminalPage).toEqual({ target: 't1' });
    expect(readM4ScopeSession(scopes[2])).toBeUndefined();
  });

  it('更新已存在项使其成为最近使用：淘汰最旧的其他项', () => {
    const scopes = seedHistoryScopes(24);
    putM4ScopeSession(scopes[0], { browsable: { refreshed: true } });
    const result = putM4ScopeSession(historyScope('t25'), { browsable: 'new' });
    expect(result.evictions).toEqual([{ kind: 'scope', scope: historyScope('t2') }]);
    expect(readM4ScopeSession(scopes[0])).toBeDefined();
  });

  it('全部项受保护时永不淘汰：受保护优先于容量，不删任何项', () => {
    seedHistoryScopes(24);
    const result = putM4ScopeSession(historyScope('t25'), {}, {
      current: historyScope('t24'),
      isActiveScope: () => true,
    });
    expect(result.evictions).toEqual([]);
    expect(m4SessionStoreSize()).toBe(25);
  });

  it('P5/P6/P7 混合作用域共同参与同一 LRU 与淘汰（可浏览状态与终态页组合）', () => {
    const scopes: M4SessionScope[] = [];
    for (let index = 1; index <= 8; index += 1) {
      const scope = browseScope(`b${index}`);
      scopes.push(scope);
      putM4ScopeSession(scope, {
        browsable: `b${index}`,
        ...(index === 1 ? { terminalPage: `p${index}` } : {}),
      });
    }
    for (let index = 1; index <= 8; index += 1) {
      const scope = historyScope(`h${index}`);
      scopes.push(scope);
      putM4ScopeSession(scope, { historyLimitState: { reasons: [] } });
    }
    for (let index = 1; index <= 8; index += 1) {
      const scope = conflictsScope(`/wc${index}`);
      scopes.push(scope);
      putM4ScopeSession(scope, { conflictSnapshot: [`c${index}`] });
    }
    expect(m4SessionStoreSize()).toBe(24);
    const oldest = scopes[0];
    const result = putM4ScopeSession(historyScope('h-new'), {}, { current: scopes[23] });
    // 最旧的 P5 项带终态页：先清页、随后整体淘汰，同一项两条动作按序发生。
    expect(result.evictions).toEqual([
      { kind: 'terminal-page', scope: browseScope('b1') },
      { kind: 'scope', scope: browseScope('b1') },
    ]);
    expect(readM4ScopeSession(oldest)).toBeUndefined();
    expect(m4SessionStoreSize()).toBe(24);
  });

  it('被淘汰作用域重开 fresh：不显示旧终态页或旧 historyLimitState', () => {
    const scopes = seedHistoryScopes(24, { terminalAt: [1], limitAt: [1] });
    putM4ScopeSession(historyScope('t25'), {}, { current: scopes[23] });
    expect(readM4ScopeSession(scopes[0])).toBeUndefined();
    expect(planM4SessionRestore({ hasActiveTask: false, scope: scopes[0] })).toEqual({ layer: 'fresh' });
  });

  it('作用域项按 LRU 顺序列出（旧→新，诊断用）', () => {
    putM4ScopeSession(browseScope('a'), {});
    putM4ScopeSession(browseScope('b'), {});
    putM4ScopeSession(browseScope('c'), {});
    putM4ScopeSession(browseScope('a'), {});
    expect(listM4ScopeSessions()).toEqual([browseScope('b'), browseScope('c'), browseScope('a')]);
  });
});

describe('reset 辅助', () => {
  it('resetSessionResults 同时清空 M3 单槽与 M4 多作用域存储', () => {
    writeSessionResult('checkout', scopeA, { v: 1 }, 'executor');
    putM4ScopeSession(historyScope('a'), { browsable: 'x' });
    resetSessionResults();
    expect(readSessionResult('checkout', scopeA)).toBeUndefined();
    expect(m4SessionStoreSize()).toBe(0);
  });

  it('resetM4SessionStore 只清 M4，不影响 M3 单槽', () => {
    writeSessionResult('checkout', scopeA, { v: 1 }, 'executor');
    putM4ScopeSession(historyScope('a'), { browsable: 'x' });
    resetM4SessionStore();
    expect(m4SessionStoreSize()).toBe(0);
    expect(readSessionResult('checkout', scopeA)?.page).toEqual({ v: 1 });
  });
});
