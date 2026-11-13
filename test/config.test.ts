/**
 * 配置读取防御：合法值原样返回、非法类型/越界值/缺失回退默认。
 * readHistoryPageSize 与 core/history 的 normalizeHistoryPageSize 同口径
 * （只接受 20/50/100，其他一律 50），此处验证 host 读取层接线。
 */
import { describe, expect, it, vi } from 'vitest';

const configValues = vi.hoisted(() => new Map<string, unknown>());

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) =>
        configValues.has(key) ? configValues.get(key) : fallback,
    }),
  },
}));

import { DEFAULT_HISTORY_PAGE_SIZE } from '../src/core/history';
import { readHistoryPageSize } from '../src/host/config';

describe('readHistoryPageSize', () => {
  it('合法值 20/50/100 原样返回', () => {
    for (const value of [20, 50, 100]) {
      configValues.set('historyPageSize', value);
      expect(readHistoryPageSize()).toBe(value);
    }
  });

  it('越界数值、非数值与缺失都回退默认 50', () => {
    for (const value of [0, 10, 51, 1000, -20, '100', null, undefined, Number.NaN]) {
      configValues.set('historyPageSize', value);
      expect(readHistoryPageSize()).toBe(DEFAULT_HISTORY_PAGE_SIZE);
    }
    configValues.delete('historyPageSize');
    expect(readHistoryPageSize()).toBe(DEFAULT_HISTORY_PAGE_SIZE);
  });
});
