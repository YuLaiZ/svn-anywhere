/**
 * 任务注册表测试：注册与查询（按作用域/按 ID/占用谓词）、移除通知的
 * 发起会话跳过与绑定即订阅、订阅取消、残留任务防御收口、作用域判等；
 * M4 增量：显式 scopeKind 判别的 history/conflicts 作用域、P6/P7 任务
 * 相位、conflicts 单槽 claim（不替换已有任务）与「先写会话缓存再移除」
 * 的终态结算出口。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addTask,
  claimTask,
  findTaskByScope,
  getActiveTask,
  getTaskById,
  hasActiveTask,
  onTaskRemoved,
  removeTask,
  resetTaskRegistry,
  sameResultScope,
  settleTask,
  type CheckoutResultScope,
  type ConflictsResultScope,
  type DiskResultScope,
  type HistoryResultScope,
  type TaskObject,
} from '../src/host/taskRegistry';

const scopeA: CheckoutResultScope = { scopeKind: 'checkout', entryKey: '/entry/a', mode: 'checkout' };
const scopeAImport: CheckoutResultScope = { scopeKind: 'checkout', entryKey: '/entry/a', mode: 'import' };
const scopeB: CheckoutResultScope = { scopeKind: 'checkout', entryKey: '/entry/b', mode: 'checkout' };
const diskScope: DiskResultScope = { scopeKind: 'disk', wcRoot: '/wc/root' };
const historyScope: HistoryResultScope = { scopeKind: 'history', targetKey: '/repo/trunk/src', targetKind: 'file' };
const historyScopeDir: HistoryResultScope = { scopeKind: 'history', targetKey: '/repo/trunk/src', targetKind: 'dir' };
const conflictsScope: ConflictsResultScope = { scopeKind: 'conflicts', wcRoot: '/wc/root', scopeRelPath: 'sub/dir' };

function makeTask(patch: Partial<TaskObject> = {}): TaskObject {
  return {
    taskId: 'op-test',
    panelKind: 'checkout',
    phase: 'connecting',
    resultScope: scopeA,
    lockKey: '/entry/a/sub',
    initiatorSessionId: 'session-initiator',
    abortController: new AbortController(),
    ...patch,
  };
}

beforeEach(() => {
  resetTaskRegistry();
});

describe('任务注册与查询', () => {
  it('注册后按作用域命中同一任务；跨入口/跨模式不命中', () => {
    const task = makeTask();
    addTask(task);
    expect(findTaskByScope('checkout', scopeA)).toBe(task);
    expect(findTaskByScope('checkout', scopeB)).toBeUndefined();
    expect(findTaskByScope('checkout', scopeAImport)).toBeUndefined();
  });

  it('磁盘任务按副本根作用域命中，检出作用域不误命中', () => {
    const task = makeTask({ panelKind: 'disk', resultScope: diskScope, phase: 'cleaning', subPath: 'sub' });
    addTask(task);
    expect(findTaskByScope('disk', diskScope)).toBe(task);
    expect(findTaskByScope('disk', { scopeKind: 'disk', wcRoot: '/wc/other' })).toBeUndefined();
    expect(findTaskByScope('disk', scopeA)).toBeUndefined();
  });

  it('按任务 ID 跨面板类别查询；占用谓词按面板类别独立', () => {
    const checkoutTask = makeTask({ taskId: 'op-checkout' });
    const diskTask = makeTask({ taskId: 'op-disk', panelKind: 'disk', resultScope: diskScope });
    addTask(checkoutTask);
    addTask(diskTask);
    expect(getTaskById('op-disk')).toBe(diskTask);
    expect(getTaskById('op-checkout')).toBe(checkoutTask);
    expect(getTaskById('op-missing')).toBeUndefined();
    expect(getActiveTask('checkout')).toBe(checkoutTask);
    expect(getActiveTask('disk')).toBe(diskTask);
    expect(hasActiveTask('checkout')).toBe(true);
    expect(hasActiveTask('disk')).toBe(true);
  });

  it('移除后按 ID 与作用域查询为空，占用恢复假值', () => {
    const task = makeTask();
    addTask(task);
    expect(removeTask('op-test')).toBe(true);
    expect(getTaskById('op-test')).toBeUndefined();
    expect(findTaskByScope('checkout', scopeA)).toBeUndefined();
    expect(hasActiveTask('checkout')).toBe(false);
    expect(removeTask('op-test')).toBe(false);
  });

  it('任务对象携带发起时捕获的固定参数（锁键/子路径/表单快照/发起会话）', () => {
    const task = makeTask({
      panelKind: 'disk',
      resultScope: diskScope,
      lockKey: '/wc/root',
      subPath: 'deep/dir',
      initiatorSessionId: 'session-origin',
    });
    addTask(task);
    const found = getActiveTask('disk');
    expect(found?.lockKey).toBe('/wc/root');
    expect(found?.subPath).toBe('deep/dir');
    expect(found?.initiatorSessionId).toBe('session-origin');
    expect(found?.abortController).toBeInstanceOf(AbortController);
  });

  it('P6/P7 面板按各自作用域绑定任务、使用 M4 相位', () => {
    const historyTask = makeTask({
      taskId: 'op-history',
      panelKind: 'history',
      resultScope: historyScope,
      phase: 'updating',
      lockKey: '/wc/repo',
    });
    const conflictsTask = makeTask({
      taskId: 'op-conflicts',
      panelKind: 'conflicts',
      resultScope: conflictsScope,
      phase: 'resolving',
      lockKey: '/wc/root',
    });
    addTask(historyTask);
    addTask(conflictsTask);
    expect(findTaskByScope('history', historyScope)).toBe(historyTask);
    expect(findTaskByScope('history', historyScopeDir)).toBeUndefined();
    expect(findTaskByScope('conflicts', conflictsScope)).toBe(conflictsTask);
    expect(findTaskByScope('conflicts', { scopeKind: 'conflicts', wcRoot: '/wc/root', scopeRelPath: '.' })).toBeUndefined();
    expect(hasActiveTask('history')).toBe(true);
    expect(hasActiveTask('conflicts')).toBe(true);
  });

  it('P6 rescanning 与 P7 scanning 相位可用于同一任务槽', () => {
    const rescan = makeTask({ taskId: 'op-rescan', panelKind: 'history', resultScope: historyScope, phase: 'rescanning' });
    addTask(rescan);
    expect(getActiveTask('history')?.phase).toBe('rescanning');
    const scan = makeTask({ taskId: 'op-scan', panelKind: 'conflicts', resultScope: conflictsScope, phase: 'scanning' });
    addTask(scan);
    expect(getActiveTask('conflicts')?.phase).toBe('scanning');
  });
});

describe('conflicts 单任务槽 claim', () => {
  it('空槽时注册成功并原样返回任务', () => {
    const task = makeTask({ taskId: 'op-claim', panelKind: 'conflicts', resultScope: conflictsScope, phase: 'resolving' });
    const result = claimTask(task);
    expect(result).toEqual({ ok: true, task });
    expect(getActiveTask('conflicts')).toBe(task);
  });

  it('已有任务时不替换、不移除、不通知，返回原持有者', () => {
    const held = makeTask({ taskId: 'op-held', panelKind: 'conflicts', resultScope: conflictsScope, phase: 'scanning' });
    addTask(held);
    const bound = vi.fn();
    onTaskRemoved('conflicts', 'session-bound', bound);
    const challenger = makeTask({
      taskId: 'op-challenger',
      panelKind: 'conflicts',
      resultScope: conflictsScope,
      phase: 'resolving',
    });
    const result = claimTask(challenger);
    expect(result).toEqual({ ok: false, heldBy: held });
    expect(getActiveTask('conflicts')).toBe(held);
    expect(getTaskById('op-challenger')).toBeUndefined();
    expect(bound).not.toHaveBeenCalled();
  });

  it('同一批内子项不注册新任务：父任务槽保持唯一', () => {
    const parent = makeTask({ taskId: 'op-batch', panelKind: 'conflicts', resultScope: conflictsScope, phase: 'resolving' });
    expect(claimTask(parent).ok).toBe(true);
    // 批内每项只写 operation record 与任务 extra，不调用 addTask/claimTask；
    // 这里断言即使误调 claimTask 也不会挤掉父任务。
    const child = makeTask({ taskId: 'op-child', panelKind: 'conflicts', resultScope: conflictsScope, phase: 'resolving' });
    expect(claimTask(child).ok).toBe(false);
    expect(getActiveTask('conflicts')).toBe(parent);
  });

  it('claim 与 addTask 语义不同：addTask 仍按既有防御收口替换残留任务', () => {
    const stale = makeTask({ taskId: 'op-stale', panelKind: 'checkout' });
    addTask(stale);
    const fresh = makeTask({ taskId: 'op-fresh', panelKind: 'checkout' });
    const result = claimTask(fresh);
    expect(result).toEqual({ ok: false, heldBy: stale });
    expect(getActiveTask('checkout')).toBe(stale);
  });
});

describe('任务终态结算：先写会话缓存再移除', () => {
  it('writeSessionState 在任务仍可查询时执行，返回后任务移除并通知绑定会话', () => {
    const task = makeTask({ taskId: 'op-settle', panelKind: 'conflicts', resultScope: conflictsScope, phase: 'resolving' });
    addTask(task);
    const bound = vi.fn();
    onTaskRemoved('conflicts', 'session-bound', bound);
    let seenDuringWrite: TaskObject | undefined;
    expect(
      settleTask('op-settle', () => {
        seenDuringWrite = getTaskById('op-settle');
      }),
    ).toBe(true);
    expect(seenDuringWrite).toBe(task);
    expect(getTaskById('op-settle')).toBeUndefined();
    expect(hasActiveTask('conflicts')).toBe(false);
    expect(bound).toHaveBeenCalledWith(task);
  });

  it('写会话缓存抛错时任务保留（不出现「已移除、未写缓存」）', () => {
    const task = makeTask({ taskId: 'op-settle-fail', panelKind: 'history', resultScope: historyScope, phase: 'updating' });
    addTask(task);
    expect(() =>
      settleTask('op-settle-fail', () => {
        throw new Error('缓存写入失败');
      }),
    ).toThrow('缓存写入失败');
    expect(getActiveTask('history')).toBe(task);
  });

  it('任务不存在时返回 false 且不执行缓存写入', () => {
    const write = vi.fn();
    expect(settleTask('op-missing', write)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('任务移除通知', () => {
  it('通知只投递非发起的绑定会话；发起会话不收到', () => {
    const task = makeTask();
    addTask(task);
    const initiator = vi.fn();
    const rebound = vi.fn();
    onTaskRemoved('checkout', 'session-initiator', initiator);
    onTaskRemoved('checkout', 'session-rebound', rebound);
    removeTask('op-test');
    expect(initiator).not.toHaveBeenCalled();
    expect(rebound).toHaveBeenCalledTimes(1);
  });

  it('绑定即订阅：回调收到被移除任务对象，重跑基准（resultScope）随任务送达', () => {
    const task = makeTask({ resultScope: scopeB });
    addTask(task);
    const rebound = vi.fn();
    onTaskRemoved('checkout', 'session-rebound', rebound);
    removeTask('op-test');
    expect(rebound).toHaveBeenCalledWith(task);
    expect((rebound.mock.calls[0][0] as TaskObject).resultScope).toEqual(scopeB);
  });

  it('发起会话销毁后重开的新会话照常收到通知（新会话非发起会话）', () => {
    const task = makeTask();
    addTask(task);
    // 发起会话已 dispose：其订阅已取消，重开会话以新会话标识订阅。
    const stale = vi.fn();
    const initiatorSub = onTaskRemoved('checkout', 'session-initiator', stale);
    initiatorSub.dispose();
    const reopened = vi.fn();
    onTaskRemoved('checkout', 'session-reopened', reopened);
    removeTask('op-test');
    expect(stale).not.toHaveBeenCalled();
    expect(reopened).toHaveBeenCalledWith(task);
  });

  it('订阅 dispose 后不再投递；同面板类别多个绑定会话各自收到一次', () => {
    const task = makeTask();
    addTask(task);
    const first = vi.fn();
    const second = vi.fn();
    const third = vi.fn();
    const sub1 = onTaskRemoved('checkout', 'session-1', first);
    onTaskRemoved('checkout', 'session-2', second);
    onTaskRemoved('checkout', 'session-3', third);
    sub1.dispose();
    removeTask('op-test');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(third).toHaveBeenCalledTimes(1);
  });

  it('通知按面板类别隔离：磁盘任务移除不打扰检出面板订阅者', () => {
    const diskTask = makeTask({ taskId: 'op-disk', panelKind: 'disk', resultScope: diskScope });
    addTask(diskTask);
    const checkoutListener = vi.fn();
    onTaskRemoved('checkout', 'session-checkout', checkoutListener);
    removeTask('op-disk');
    expect(checkoutListener).not.toHaveBeenCalled();
  });

  it('P6/P7 任务移除只通知自身面板类别的订阅者', () => {
    const historyTask = makeTask({ taskId: 'op-h', panelKind: 'history', resultScope: historyScope, phase: 'updating' });
    addTask(historyTask);
    const historyListener = vi.fn();
    const conflictsListener = vi.fn();
    onTaskRemoved('history', 'session-history', historyListener);
    onTaskRemoved('conflicts', 'session-conflicts', conflictsListener);
    removeTask('op-h');
    expect(historyListener).toHaveBeenCalledWith(historyTask);
    expect(conflictsListener).not.toHaveBeenCalled();
  });

  it('订阅回调抛错不阻断其他订阅者', () => {
    const task = makeTask();
    addTask(task);
    const boom = vi.fn(() => {
      throw new Error('boom');
    });
    const after = vi.fn();
    onTaskRemoved('checkout', 'session-bad', boom);
    onTaskRemoved('checkout', 'session-good', after);
    expect(() => removeTask('op-test')).not.toThrow();
    expect(boom).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledWith(task);
  });
});

describe('残留任务防御收口与重置', () => {
  it('同类别残留任务被新注册收口：旧任务按移除流程通知其绑定会话', () => {
    const stale = makeTask({ taskId: 'op-stale', initiatorSessionId: 'session-old' });
    addTask(stale);
    const bound = vi.fn();
    onTaskRemoved('checkout', 'session-bound', bound);
    const fresh = makeTask({ taskId: 'op-fresh', initiatorSessionId: 'session-new' });
    addTask(fresh);
    expect(bound).toHaveBeenCalledWith(stale);
    expect(getActiveTask('checkout')).toBe(fresh);
    expect(hasActiveTask('checkout')).toBe(true);
  });

  it('resetTaskRegistry 清空任务与订阅（M4 面板同样清空）', () => {
    addTask(makeTask());
    addTask(makeTask({ taskId: 'op-conflicts', panelKind: 'conflicts', resultScope: conflictsScope }));
    const listener = vi.fn();
    onTaskRemoved('checkout', 'session-x', listener);
    resetTaskRegistry();
    // 重置后注册表为空；旧订阅随重置消失（不投递）。
    addTask(makeTask({ taskId: 'op-next' }));
    removeTask('op-next');
    expect(listener).not.toHaveBeenCalled();
    expect(hasActiveTask('checkout')).toBe(false);
    expect(hasActiveTask('conflicts')).toBe(false);
  });
});

describe('sameResultScope 判等', () => {
  it('检出作用域比入口键与模式；磁盘作用域比副本根', () => {
    expect(sameResultScope(scopeA, { scopeKind: 'checkout', entryKey: '/entry/a', mode: 'checkout' })).toBe(true);
    expect(sameResultScope(scopeA, scopeAImport)).toBe(false);
    expect(sameResultScope(scopeA, scopeB)).toBe(false);
    expect(sameResultScope(diskScope, { scopeKind: 'disk', wcRoot: '/wc/root' })).toBe(true);
    expect(sameResultScope(diskScope, { scopeKind: 'disk', wcRoot: '/wc/other' })).toBe(false);
  });

  it('history 作用域比目标身份键与节点类型', () => {
    expect(
      sameResultScope(historyScope, { scopeKind: 'history', targetKey: '/repo/trunk/src', targetKind: 'file' }),
    ).toBe(true);
    expect(sameResultScope(historyScope, historyScopeDir)).toBe(false);
    expect(
      sameResultScope(historyScope, { scopeKind: 'history', targetKey: '/repo/trunk/other', targetKind: 'file' }),
    ).toBe(false);
  });

  it('conflicts 作用域比副本根与范围相对路径', () => {
    expect(
      sameResultScope(conflictsScope, { scopeKind: 'conflicts', wcRoot: '/wc/root', scopeRelPath: 'sub/dir' }),
    ).toBe(true);
    expect(
      sameResultScope(conflictsScope, { scopeKind: 'conflicts', wcRoot: '/wc/root', scopeRelPath: 'sub' }),
    ).toBe(false);
    expect(
      sameResultScope(conflictsScope, { scopeKind: 'conflicts', wcRoot: '/wc/other', scopeRelPath: 'sub/dir' }),
    ).toBe(false);
  });

  it('跨类别必不等（含 M4 与既有类别）', () => {
    const scopes = [scopeA, diskScope, historyScope, conflictsScope];
    for (const a of scopes) {
      for (const b of scopes) {
        expect(sameResultScope(a, b), `${a.scopeKind} vs ${b.scopeKind}`).toBe(a === b);
      }
    }
    expect(sameResultScope(scopeA, diskScope)).toBe(false);
    expect(sameResultScope(diskScope, scopeA)).toBe(false);
    expect(sameResultScope(diskScope, conflictsScope)).toBe(false);
    expect(sameResultScope(historyScope, conflictsScope)).toBe(false);
  });
});
