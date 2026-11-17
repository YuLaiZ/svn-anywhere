/**
 * 行内追溯测试（host/inlineBlame）：
 * - 大小/行数降级：≤10 MiB 自动刷新、>10 MiB 或 >100k 行按需刷新、
 *   >16 MiB 禁用；
 * - blame 行归属 → after 文本：`rN · author`、author 缺失 `rN`、无 commit
 *   显示「未提交/未归属」、超出文档行数裁剪；
 * - 开关状态机（mock vscode + 注入探测/blame）：开启装饰、再次关闭清空、
 *   保存自动刷新、大文件保存只提示按需刷新、点击「立即刷新」重跑、
 *   切换编辑器撤销、不可追溯原因与异常状态。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

const vscodeMock = vi.hoisted(() => {
  class FakeRange {
    constructor(
      public startLine: number,
      public startCharacter: number,
      public endLine: number,
      public endCharacter: number,
    ) {}
  }
  const state = {
    Range: FakeRange,
    information: [] as string[],
    warning: [] as string[],
    error: [] as Array<unknown[]>,
    decorationTypes: [] as Array<{
      key: string;
      setCalls: Array<Array<{ range: { startLine: number }; renderOptions?: { after?: { contentText?: string } } }>>;
      disposed: boolean;
      dispose(): void;
    }>,
    saveHandlers: [] as Array<(document: { uri: { toString(): string } }) => void>,
    activeEditorHandlers: [] as Array<(editor: unknown) => void>,
    nextDecorationKey: 1,
  };
  return state;
});

vi.mock('vscode', () => ({
  Range: vscodeMock.Range,
  OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
  DecorationRangeBehavior: { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 },
  window: {
    createTextEditorDecorationType: () => {
      const type = {
        key: `inline-decoration-${vscodeMock.nextDecorationKey++}`,
        setCalls: [] as Array<Array<{ range: { startLine: number } }>>,
        disposed: false,
        dispose() {
          type.disposed = true;
        },
      };
      vscodeMock.decorationTypes.push(type);
      return type;
    },
    showInformationMessage: (message: string) => {
      vscodeMock.information.push(message);
      return Promise.resolve(undefined);
    },
    showWarningMessage: (message: string) => {
      vscodeMock.warning.push(message);
      return Promise.resolve(undefined);
    },
    showErrorMessage: (message: string, item?: string) => {
      vscodeMock.error.push([message, item]);
      return Promise.resolve(undefined);
    },
    onDidChangeActiveTextEditor: (handler: (editor: unknown) => void) => {
      vscodeMock.activeEditorHandlers.push(handler);
      return {
        dispose: () => {
          const index = vscodeMock.activeEditorHandlers.indexOf(handler);
          if (index >= 0) {
            vscodeMock.activeEditorHandlers.splice(index, 1);
          }
        },
      };
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown) => fallback,
    }),
    onDidSaveTextDocument: (handler: (document: { uri: { toString(): string } }) => void) => {
      vscodeMock.saveHandlers.push(handler);
      return {
        dispose: () => {
          const index = vscodeMock.saveHandlers.indexOf(handler);
          if (index >= 0) {
            vscodeMock.saveHandlers.splice(index, 1);
          }
        },
      };
    },
  },
}));

import type { BlameLine, BlameResult } from '../src/core/blame';
import {
  buildInlineBlameDecorationOptions,
  buildInlineBlameDecorations,
  disableInlineBlame,
  INLINE_BLAME_AUTO_REFRESH_MAX_BYTES,
  INLINE_BLAME_AUTO_REFRESH_MAX_LINES,
  INLINE_BLAME_DISABLE_MAX_BYTES,
  inlineBlameAvailability,
  isInlineBlameEnabled,
  refreshInlineBlame,
  toggleInlineBlame,
  type InlineBlameDeps,
} from '../src/host/inlineBlame';
import { strings } from '../src/host/i18n';
import { disposeOutputChannel, resetOutputState } from '../src/host/output';
import type { LocalEditorTarget } from '../src/host/quickDiff';

/* ------------------------------ 纯逻辑测试 ------------------------------ */

describe('inlineBlame：大小/行数降级', () => {
  it('≤10 MiB 且 ≤100k 行自动刷新；>10 MiB 或 >100k 行按需刷新；>16 MiB 禁用', () => {
    expect(inlineBlameAvailability(1024, 100)).toBe('auto');
    expect(inlineBlameAvailability(INLINE_BLAME_AUTO_REFRESH_MAX_BYTES, 100)).toBe('auto');
    expect(inlineBlameAvailability(INLINE_BLAME_AUTO_REFRESH_MAX_BYTES + 1, 100)).toBe('manualRefresh');
    expect(inlineBlameAvailability(1024, INLINE_BLAME_AUTO_REFRESH_MAX_LINES + 1)).toBe('manualRefresh');
    expect(inlineBlameAvailability(INLINE_BLAME_DISABLE_MAX_BYTES, 100)).toBe('manualRefresh');
    expect(inlineBlameAvailability(INLINE_BLAME_DISABLE_MAX_BYTES + 1, 100)).toBe('disabled');
  });
});

describe('inlineBlame：行归属 → after 文本', () => {
  const lines: BlameLine[] = [
    { lineNumber: 1, revision: 2, author: 'bob', date: '2026-11-13T06:17:52.113537Z' },
    { lineNumber: 2 },
    { lineNumber: 3, revision: 9, date: '2026-11-14T00:00:00.000000Z' },
    { lineNumber: 4, revision: 5, author: 'A&B <C>' },
    // 超出当前文档行数（blame 与工作文件应对齐，防御性裁剪）。
    { lineNumber: 99, revision: 1, author: 'ghost' },
  ];

  it('有 commit 显示 rN · author；author 缺失只显示 rN；无 commit 显示未提交', () => {
    expect(buildInlineBlameDecorations(lines, 4)).toEqual([
      { line: 1, text: 'r2 · bob' },
      { line: 2, text: strings.editor.inlineBlameUncommitted },
      { line: 3, text: 'r9' },
      { line: 4, text: 'r5 · A&B <C>' },
    ]);
  });

  it('空文件（0 行）不产生装饰', () => {
    expect(buildInlineBlameDecorations([{ lineNumber: 1, revision: 1 }], 0)).toEqual([]);
  });

  it('DecorationOptions 使用整行范围并把文本放进 after', () => {
    const document = {
      lineAt: (line: number) => ({ range: new vscodeMock.Range(line, 0, line, 5) }),
    } as unknown as vscode.TextDocument;
    const options = buildInlineBlameDecorationOptions(document, [{ line: 2, text: 'r7 · amy' }]);
    expect(options).toHaveLength(1);
    expect((options[0]?.range as unknown as { startLine: number }).startLine).toBe(1);
    expect(options[0]?.renderOptions?.after?.contentText).toBe('r7 · amy');
  });
});

/* ------------------------------ 状态机测试 ------------------------------ */

interface FakeDecorationType {
  key: string;
  setCalls: Array<Array<{ range: { startLine: number }; renderOptions?: { after?: { contentText?: string } } }>>;
  disposed: boolean;
  dispose(): void;
}

function createFakeEditor(fsPath: string, lineCount: number): {
  editor: vscode.TextEditor;
  calls: Array<{ type: FakeDecorationType; options: unknown[] }>;
} {
  const calls: Array<{ type: FakeDecorationType; options: unknown[] }> = [];
  const document = {
    uri: { scheme: 'file', fsPath, toString: () => `file://${fsPath}` },
    lineCount,
    lineAt: (line: number) => ({ range: new vscodeMock.Range(line, 0, line, 5) }),
  };
  const editor = {
    document,
    setDecorations: (type: FakeDecorationType, options: unknown[]) => {
      calls.push({ type, options });
      type.setCalls.push(options as FakeDecorationType['setCalls'][number]);
    },
  } as unknown as vscode.TextEditor;
  return { editor, calls };
}

const target: LocalEditorTarget = {
  wcRoot: '/repo',
  fsPath: '/repo/file.txt',
  relPath: 'file.txt',
  sizeBytes: 100,
};

const BLAME_LINES: BlameLine[] = [
  { lineNumber: 1, revision: 2, author: 'bob' },
  { lineNumber: 2 },
  { lineNumber: 3, revision: 9, author: 'amy' },
];

function blameReady(lines: BlameLine[] = BLAME_LINES): BlameResult {
  return { state: 'ready', lines };
}

function baseDeps(overrides: Partial<InlineBlameDeps> = {}): InlineBlameDeps {
  return {
    svnPath: 'svn',
    runOptions: {},
    probe: async () => ({ status: 'ok', target }),
    blame: async () => blameReady(),
    notify: async () => undefined,
    ...overrides,
  };
}

const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  disableInlineBlame();
  resetOutputState();
  disposeOutputChannel();
  vscodeMock.information.length = 0;
  vscodeMock.warning.length = 0;
  vscodeMock.error.length = 0;
  vscodeMock.decorationTypes.length = 0;
  vscodeMock.saveHandlers.length = 0;
  vscodeMock.activeEditorHandlers.length = 0;
});

describe('inlineBlame：开关状态机', () => {
  it('开启后逐行装饰 revision/author；再次执行关闭并清除全部装饰、释放类型', async () => {
    const { editor, calls } = createFakeEditor('/repo/file.txt', 3);
    const enabled = await toggleInlineBlame(editor, baseDeps());
    expect(enabled).toEqual({ status: 'enabled', availability: 'auto', lineCount: 3 });
    expect(isInlineBlameEnabled()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toHaveLength(3);
    const options = calls[0]?.options as Array<{ renderOptions?: { after?: { contentText?: string } } }>;
    expect(options.map((option) => option.renderOptions?.after?.contentText)).toEqual([
      'r2 · bob',
      strings.editor.inlineBlameUncommitted,
      'r9 · amy',
    ]);

    expect(await toggleInlineBlame(editor, baseDeps())).toEqual({ status: 'disabled' });
    expect(isInlineBlameEnabled()).toBe(false);
    expect(calls.filter((call) => call.options.length === 0)).toHaveLength(1);
    expect(vscodeMock.decorationTypes[0]?.disposed).toBe(true);
    expect(vscodeMock.saveHandlers).toHaveLength(0);
    expect(vscodeMock.activeEditorHandlers).toHaveLength(0);
  });

  it('无活动编辑器/目标拒绝/二进制/超过 16 MiB/不可追溯原因分别返回明确状态', async () => {
    expect(await toggleInlineBlame(undefined, baseDeps())).toEqual({ status: 'rejected', reason: 'noActiveEditor' });

    const { editor } = createFakeEditor('/repo/file.txt', 3);
    expect(await toggleInlineBlame(editor, baseDeps({
      probe: async () => ({ status: 'rejected', reason: 'binary' }),
    }))).toEqual({ status: 'rejected', reason: 'binary' });

    expect(await toggleInlineBlame(editor, baseDeps({
      probe: async () => ({ status: 'ok', target: { ...target, sizeBytes: INLINE_BLAME_DISABLE_MAX_BYTES + 1 } }),
    }))).toEqual({ status: 'rejected', reason: 'tooLarge' });
    expect(isInlineBlameEnabled()).toBe(false);

    expect(await toggleInlineBlame(editor, baseDeps({
      blame: async () => ({ state: 'notTraceable', reason: 'noCommittedRevision' }),
    }))).toEqual({ status: 'rejected', reason: 'noCommittedRevision' });
    expect(await toggleInlineBlame(editor, baseDeps({
      blame: async () => ({ state: 'notTraceable', reason: 'tooLarge' }),
    }))).toEqual({ status: 'rejected', reason: 'tooLarge' });

    const error = new Error('blame 网络失败');
    expect(await toggleInlineBlame(editor, baseDeps({
      blame: async () => {
        throw error;
      },
    }))).toEqual({ status: 'failed', error });
  });

  it('小文件保存自动刷新；其他文档保存不触发', async () => {
    const { editor, calls } = createFakeEditor('/repo/file.txt', 3);
    let blameCalls = 0;
    await toggleInlineBlame(editor, baseDeps({
      blame: async () => {
        blameCalls += 1;
        return blameReady();
      },
    }));
    expect(blameCalls).toBe(1);
    const saveHandler = vscodeMock.saveHandlers[0];
    saveHandler?.({ uri: { toString: () => 'file:///repo/file.txt' } });
    await flushAsync();
    expect(blameCalls).toBe(2);
    expect(calls).toHaveLength(2);

    saveHandler?.({ uri: { toString: () => 'file:///repo/other.txt' } });
    await flushAsync();
    expect(blameCalls).toBe(2);
  });

  it('>10 MiB 文件保存不自动刷新，只弹「立即刷新」；点击后重跑 blame', async () => {
    const { editor, calls } = createFakeEditor('/repo/file.txt', 3);
    const notifications: Array<{ message: string; action: string }> = [];
    let blameCalls = 0;
    let refreshAction: string | undefined;
    await toggleInlineBlame(editor, baseDeps({
      probe: async () => ({ status: 'ok', target: { ...target, sizeBytes: INLINE_BLAME_AUTO_REFRESH_MAX_BYTES + 1 } }),
      blame: async () => {
        blameCalls += 1;
        return blameReady();
      },
      notify: async (message, action) => {
        notifications.push({ message, action });
        return refreshAction;
      },
    }));
    const enabled = await toggleInlineBlame(editor, baseDeps());
    // 上一步同一文件再次 toggle 是关闭：重新开启大文件会话。
    expect(enabled).toEqual({ status: 'disabled' });

    const big = createFakeEditor('/repo/file.txt', 3);
    const bigEnabled = await toggleInlineBlame(big.editor, baseDeps({
      probe: async () => ({ status: 'ok', target: { ...target, sizeBytes: INLINE_BLAME_AUTO_REFRESH_MAX_BYTES + 1 } }),
      blame: async () => {
        blameCalls += 1;
        return blameReady();
      },
      notify: async (message, action) => {
        notifications.push({ message, action });
        return refreshAction;
      },
    }));
    expect(bigEnabled).toEqual({ status: 'enabled', availability: 'manualRefresh', lineCount: 3 });
    // calls 为第一个编辑器的调用：开启 1 次 + 关闭清空 1 次。
    expect(calls).toHaveLength(2);

    const saveHandler = vscodeMock.saveHandlers[0];
    saveHandler?.({ uri: { toString: () => 'file:///repo/file.txt' } });
    await flushAsync();
    // 保存只提示不刷新；blame 仍是开启两次（原始大文件一次 + 重新开启一次）。
    expect(notifications).toEqual([{
      message: strings.editor.inlineBlameManualRefresh,
      action: strings.editor.inlineBlameRefreshNow,
    }]);
    expect(blameCalls).toBe(2);
    expect(big.calls).toHaveLength(1);

    refreshAction = strings.editor.inlineBlameRefreshNow;
    saveHandler?.({ uri: { toString: () => 'file:///repo/file.txt' } });
    await flushAsync();
    expect(blameCalls).toBe(3);
    expect(big.calls).toHaveLength(2);
  });

  it('切换编辑器撤销且无残留装饰；refreshInlineBlame 在关闭后为空操作', async () => {
    const { editor, calls } = createFakeEditor('/repo/file.txt', 3);
    await toggleInlineBlame(editor, baseDeps());
    vscodeMock.activeEditorHandlers[0]?.({ document: { uri: { toString: () => 'file:///repo/other.txt' } } });
    expect(isInlineBlameEnabled()).toBe(false);
    expect(calls.filter((call) => call.options.length === 0)).toHaveLength(1);
    await refreshInlineBlame(baseDeps());
    expect(calls).toHaveLength(2);

    // 切回同一文档不撤销（身份保持）。
    const same = createFakeEditor('/repo/file.txt', 3);
    await toggleInlineBlame(same.editor, baseDeps());
    vscodeMock.activeEditorHandlers[0]?.(same.editor);
    expect(isInlineBlameEnabled()).toBe(true);
  });

  it('保存时文件增长跨过 16 MiB：禁用行内追溯、清空装饰并提示', async () => {
    const { editor, calls } = createFakeEditor('/repo/file.txt', 3);
    let sizeBytes = 100;
    let blameCalls = 0;
    await toggleInlineBlame(editor, baseDeps({
      probe: async () => ({ status: 'ok', target: { ...target, sizeBytes } }),
      blame: async () => {
        blameCalls += 1;
        return blameReady();
      },
    }));
    expect(isInlineBlameEnabled()).toBe(true);
    expect(blameCalls).toBe(1);

    // 修复前保存处理按开启时冻结的 availability=auto 自动重跑 blame。
    sizeBytes = INLINE_BLAME_DISABLE_MAX_BYTES + 1;
    vscodeMock.saveHandlers[0]?.({ uri: { toString: () => 'file:///repo/file.txt' } });
    await flushAsync();
    expect(isInlineBlameEnabled()).toBe(false);
    expect(blameCalls).toBe(1);
    expect(calls.at(-1)?.options).toEqual([]);
    expect(vscodeMock.decorationTypes[0]?.disposed).toBe(true);
    expect(vscodeMock.warning).toContain(strings.editor.inlineBlameTooLarge);
    expect(vscodeMock.saveHandlers).toHaveLength(0);
    expect(vscodeMock.activeEditorHandlers).toHaveLength(0);
  });

  it('保存时文件增长跨过 10 MiB 或 100k 行：不再自动 blame，只弹「立即刷新」', async () => {
    const { editor } = createFakeEditor('/repo/file.txt', 3);
    let sizeBytes = 100;
    let blameCalls = 0;
    const notifications: string[] = [];
    await toggleInlineBlame(editor, baseDeps({
      probe: async () => ({ status: 'ok', target: { ...target, sizeBytes } }),
      blame: async () => {
        blameCalls += 1;
        return blameReady();
      },
      notify: async (message) => {
        notifications.push(message);
        return undefined;
      },
    }));
    sizeBytes = INLINE_BLAME_AUTO_REFRESH_MAX_BYTES + 1;
    vscodeMock.saveHandlers[0]?.({ uri: { toString: () => 'file:///repo/file.txt' } });
    await flushAsync();
    // 修复前保存分支只看开启时冻结的 availability=auto，会直接重跑 blame。
    expect(blameCalls).toBe(1);
    expect(notifications).toEqual([strings.editor.inlineBlameManualRefresh]);
    expect(isInlineBlameEnabled()).toBe(true);

    // 行数增长跨过 100k 同样转为按需刷新（大小已回落）。
    sizeBytes = 100;
    (editor.document as unknown as { lineCount: number }).lineCount = INLINE_BLAME_AUTO_REFRESH_MAX_LINES + 1;
    vscodeMock.saveHandlers[0]?.({ uri: { toString: () => 'file:///repo/file.txt' } });
    await flushAsync();
    expect(blameCalls).toBe(1);
    expect(notifications).toHaveLength(2);
  });

  it('refreshInlineBlame 开头按最新探测重算：文件已超 16 MiB 时关闭会话并提示', async () => {
    const { editor } = createFakeEditor('/repo/file.txt', 3);
    let sizeBytes = 100;
    let blameCalls = 0;
    await toggleInlineBlame(editor, baseDeps({
      probe: async () => ({ status: 'ok', target: { ...target, sizeBytes } }),
      blame: async () => {
        blameCalls += 1;
        return blameReady();
      },
    }));
    expect(isInlineBlameEnabled()).toBe(true);

    sizeBytes = INLINE_BLAME_DISABLE_MAX_BYTES + 1;
    await refreshInlineBlame(baseDeps({
      probe: async () => ({ status: 'ok', target: { ...target, sizeBytes } }),
      blame: async () => {
        blameCalls += 1;
        return blameReady();
      },
    }));
    expect(blameCalls).toBe(1);
    expect(isInlineBlameEnabled()).toBe(false);
    expect(vscodeMock.decorationTypes[0]?.disposed).toBe(true);
    expect(vscodeMock.warning).toContain(strings.editor.inlineBlameTooLarge);
  });

  it('并发开启：先发调用被取代，不残留装饰类型与监听', async () => {
    const first = createFakeEditor('/repo/first.txt', 3);
    const second = createFakeEditor('/repo/second.txt', 3);
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    const pendingFirst = toggleInlineBlame(first.editor, baseDeps({
      probe: async () => {
        await gate;
        return { status: 'ok', target: { ...target, fsPath: '/repo/first.txt', relPath: 'first.txt' } };
      },
    }));
    const pendingSecond = toggleInlineBlame(second.editor, baseDeps({
      probe: async () => ({
        status: 'ok',
        target: { ...target, fsPath: '/repo/second.txt', relPath: 'second.txt' },
      }),
    }));
    await expect(pendingSecond).resolves.toEqual({ status: 'enabled', availability: 'auto', lineCount: 3 });
    releaseFirst?.();
    await expect(pendingFirst).resolves.toEqual({ status: 'superseded' });
    expect(first.calls).toHaveLength(0);
    expect(second.calls).toHaveLength(1);
    expect(vscodeMock.decorationTypes).toHaveLength(1);
    expect(vscodeMock.decorationTypes[0]?.disposed).toBe(false);
    expect(vscodeMock.saveHandlers).toHaveLength(1);
    expect(vscodeMock.activeEditorHandlers).toHaveLength(1);
  });

  it('开启在途时执行关闭：开启结果过期，不重新点亮会话', async () => {
    const { editor, calls } = createFakeEditor('/repo/file.txt', 3);
    let releaseProbe: (() => void) | undefined;
    const gate = new Promise<void>((resolveGate) => {
      releaseProbe = resolveGate;
    });
    const pending = toggleInlineBlame(editor, baseDeps({
      probe: async () => {
        await gate;
        return { status: 'ok', target };
      },
    }));
    disableInlineBlame();
    releaseProbe?.();
    await expect(pending).resolves.toEqual({ status: 'superseded' });
    expect(isInlineBlameEnabled()).toBe(false);
    expect(calls).toHaveLength(0);
    expect(vscodeMock.decorationTypes).toHaveLength(0);
    expect(vscodeMock.saveHandlers).toHaveLength(0);
  });
});
