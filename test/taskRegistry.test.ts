/**
 * 任务注册表测试：注册与查询（按作用域/按 ID/占用谓词）、移除通知的
 * 发起会话跳过与绑定即订阅、订阅取消、残留任务防御收口、作用域判等。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addTask,
  findTaskByScope,
  getActiveTask,
  getTaskById,
  hasActiveTask,
  onTaskRemoved,
  removeTask,
  resetTaskRegistry,
  sameResultScope,
  type CheckoutResultScope,
  type DiskResultScope,
  type TaskObject,
} from '../src/host/taskRegistry';

const scopeA: CheckoutResultScope = { entryKey: '/entry/a', mode: 'checkout' };
const scopeAImport: CheckoutResultScope = { entryKey: '/entry/a', mode: 'import' };
const scopeB: CheckoutResultScope = { entryKey: '/entry/b', mode: 'checkout' };
const diskScope: DiskResultScope = { wcRoot: '/wc/root' };

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
    expect(findTaskByScope('disk', { wcRoot: '/wc/other' })).toBeUndefined();
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

  it('resetTaskRegistry 清空任务与订阅', () => {
    addTask(makeTask());
    const listener = vi.fn();
    onTaskRemoved('checkout', 'session-x', listener);
    resetTaskRegistry();
    // 重置后注册表为空；旧订阅随重置消失（不投递）。
    addTask(makeTask({ taskId: 'op-next' }));
    removeTask('op-next');
    expect(listener).not.toHaveBeenCalled();
    expect(hasActiveTask('checkout')).toBe(false);
  });
});

describe('sameResultScope 判等', () => {
  it('检出作用域比入口键与模式；磁盘作用域比副本根', () => {
    expect(sameResultScope(scopeA, { entryKey: '/entry/a', mode: 'checkout' })).toBe(true);
    expect(sameResultScope(scopeA, scopeAImport)).toBe(false);
    expect(sameResultScope(scopeA, scopeB)).toBe(false);
    expect(sameResultScope(diskScope, { wcRoot: '/wc/root' })).toBe(true);
    expect(sameResultScope(diskScope, { wcRoot: '/wc/other' })).toBe(false);
  });

  it('跨类别必不等', () => {
    expect(sameResultScope(scopeA, diskScope)).toBe(false);
    expect(sameResultScope(diskScope, scopeA)).toBe(false);
  });
});
