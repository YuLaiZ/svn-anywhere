/**
 * 结果代次测试：递增与读取、面板类别独立、跨面板会话持续（dispose 不
 * 递增不重置——模块无面板生命周期钩子，其他宿主单例的状态变化也不
 * 触碰代次）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { bumpResultEpoch, getResultEpoch, resetResultEpochs } from '../src/host/resultEpoch';
import { resetTaskRegistry } from '../src/host/taskRegistry';
import { resetSessionResults } from '../src/host/sessionResults';

beforeEach(() => {
  resetResultEpochs();
});

describe('结果代次', () => {
  it('未递增过为 0；递增返回新值', () => {
    expect(getResultEpoch('checkout')).toBe(0);
    expect(bumpResultEpoch('checkout')).toBe(1);
    expect(getResultEpoch('checkout')).toBe(1);
    expect(bumpResultEpoch('checkout')).toBe(2);
    expect(getResultEpoch('checkout')).toBe(2);
  });

  it('按面板类别独立维护', () => {
    bumpResultEpoch('checkout');
    bumpResultEpoch('checkout');
    expect(getResultEpoch('checkout')).toBe(2);
    expect(getResultEpoch('disk')).toBe(0);
    bumpResultEpoch('disk');
    expect(getResultEpoch('disk')).toBe(1);
    expect(getResultEpoch('checkout')).toBe(2);
  });

  it('跨面板会话持续：递增后不随面板会话更替回退（其他宿主单例重置也不触碰代次）', () => {
    bumpResultEpoch('checkout');
    bumpResultEpoch('checkout');
    // 面板 dispose 的语义是「不递增不重置」：本模块不提供生命周期钩子，
    // 这里以「任务注册表/结果缓存等其他单例的状态清空不改变代次」验证
    // 代次只被显式递增接口改动。
    resetTaskRegistry();
    resetSessionResults();
    expect(getResultEpoch('checkout')).toBe(2);
    // 再次递增从当前值继续（单调、不重建）。
    expect(bumpResultEpoch('checkout')).toBe(3);
  });

  it('resetResultEpochs 清零', () => {
    bumpResultEpoch('disk');
    resetResultEpochs();
    expect(getResultEpoch('disk')).toBe(0);
  });
});
