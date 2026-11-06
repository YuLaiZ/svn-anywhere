/**
 * 面板会话结果缓存测试：写入者分类（controller 写侧作用域校验 /
 * executor 一律写入）、读取命中校验（作用域基准不一致丢弃）、清除的
 * 作用域保护、只读命令进行中登记（发起/命中条件/结论结算的推送与
 * 守卫丢弃不推送）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginReadonlyVerify,
  clearReadonlyVerify,
  clearSessionResult,
  matchReadonlyVerify,
  onSessionResultUpdated,
  readSessionResult,
  resetSessionResults,
  settleReadonlyVerify,
  writeSessionResult,
} from '../src/host/sessionResults';
import type { CheckoutResultScope, DiskResultScope } from '../src/host/taskRegistry';

const scopeA: CheckoutResultScope = { entryKey: '/entry/a', mode: 'checkout' };
const scopeAImport: CheckoutResultScope = { entryKey: '/entry/a', mode: 'import' };
const scopeB: CheckoutResultScope = { entryKey: '/entry/b', mode: 'checkout' };
const diskScope: DiskResultScope = { wcRoot: '/wc/root' };

beforeEach(() => {
  resetSessionResults();
});

describe('写入者分类', () => {
  it('controller 空槽写入成功', () => {
    expect(writeSessionResult('checkout', scopeA, { kind: 'resumable' }, 'controller')).toBe(true);
    expect(readSessionResult('checkout', scopeA)?.page).toEqual({ kind: 'resumable' });
  });

  it('controller 同作用域覆盖', () => {
    writeSessionResult('checkout', scopeA, { v: 1 }, 'controller');
    expect(writeSessionResult('checkout', { entryKey: '/entry/a', mode: 'checkout' }, { v: 2 }, 'controller')).toBe(true);
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
    const entry = readSessionResult('checkout', { entryKey: '/entry/a', mode: 'checkout' });
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
