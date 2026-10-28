/**
 * 输出频道生命周期的宿主侧单测：mock vscode 模块验证频道复用、
 * dispose 后写入丢弃、二次激活（resetOutputState）后输出恢复。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => ({
  channels: [] as Array<{
    title: string;
    lines: string[];
    shown: number;
    disposed: boolean;
    appendLine: (line: string) => void;
    show: () => void;
    dispose: () => void;
  }>,
}));

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: (title: string) => {
      const ch = {
        title,
        lines: [] as string[],
        shown: 0,
        disposed: false,
        appendLine(line: string) {
          ch.lines.push(line);
        },
        show() {
          ch.shown += 1;
        },
        dispose() {
          ch.disposed = true;
        },
      };
      vscodeMock.channels.push(ch);
      return ch;
    },
  },
}));

import { disposeOutputChannel, getOutputChannel, logLine, resetOutputState, showOutput } from '../src/host/output';

describe('输出频道生命周期（宿主侧）', () => {
  beforeEach(() => {
    disposeOutputChannel();
    resetOutputState();
    vscodeMock.channels.length = 0;
  });

  it('getOutputChannel 复用同一频道实例', () => {
    const first = getOutputChannel();
    const second = getOutputChannel();
    expect(first).toBe(second);
    expect(vscodeMock.channels).toHaveLength(1);
  });

  it('dispose 后迟到写入被丢弃，不重建频道', () => {
    getOutputChannel();
    disposeOutputChannel();
    expect(() => logLine('停用后的迟到写入')).not.toThrow();
    expect(() => showOutput()).not.toThrow();
    expect(vscodeMock.channels).toHaveLength(1);
    expect(vscodeMock.channels[0]?.lines).toHaveLength(0);
    expect(vscodeMock.channels[0]?.disposed).toBe(true);
  });

  it('resetOutputState 后二次激活输出恢复（新频道可写入）', () => {
    const first = getOutputChannel();
    disposeOutputChannel();
    resetOutputState();
    logLine('二次激活后的输出');
    expect(vscodeMock.channels).toHaveLength(2);
    expect(vscodeMock.channels[1]?.lines).toEqual(['二次激活后的输出']);
    expect(getOutputChannel()).not.toBe(first);
  });
});
