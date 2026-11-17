/**
 * 快速差异测试（host/quickDiff）：
 * - 零上下文 hunk 解析与行号映射（修改/新增/纯删除、count 缺省、clamp）；
 * - 命令参数：`--internal-diff`（覆盖 external diff 配置）、
 *   `--ignore-properties`、`-r BASE`、`-x -U0`、`--` 与原始字面路径
 *   （含 `@` 不追加尾 peg，与 blame/cat 语义相反）；
 * - 本地目标判定：versioned/exists/nonDir/nonBinary（真实 svnadmin +
 *   file:// 隔离仓库）：干净/修改/未版本控制/missing/目录/二进制；
 * - 真实 `svn diff -r BASE -x -U0` 的 hunk 采集与行映射；
 * - 开关状态机（mock vscode + 注入探测/执行）：开启装饰、再次关闭清空、
 *   保存刷新、切换编辑器撤销、无残留装饰。
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      setCalls: unknown[][];
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
        key: `decoration-${vscodeMock.nextDecorationKey++}`,
        setCalls: [] as unknown[][],
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

import {
  buildQuickDiffArgs,
  buildQuickDiffDecorations,
  collectQuickDiffHunks,
  createQuickDiffDecorationTypes,
  disableQuickDiff,
  getLastQuickDiffRefresh,
  isQuickDiffEnabled,
  mapQuickDiffHunksToLines,
  parseZeroContextDiffHunks,
  probeLocalEditorTarget,
  refreshQuickDiff,
  toggleQuickDiff,
  QUICK_DIFF_BASE_ARGS,
  type LocalEditorTarget,
  type QuickDiffDeps,
  type QuickDiffHunk,
} from '../src/host/quickDiff';
import { strings } from '../src/host/i18n';
import { disposeOutputChannel, resetOutputState } from '../src/host/output';
import { createSvnLab, writeFile, type SvnLab } from './helpers';

/* ------------------------------ 纯解析测试 ------------------------------ */

describe('quickDiff：零上下文 hunk 解析', () => {
  const DIFF = [
    'Index: diff-target.txt',
    '===================================================================',
    '--- diff-target.txt\t(revision 11)',
    '+++ diff-target.txt\t(working copy)',
    '@@ -5 +5 @@',
    '-dline05',
    '+dline05-local',
    '@@ -8 +7,0 @@',
    '-dline08',
    '@@ -14,0 +14,2 @@',
    '+inserted-a',
    '+inserted-b',
    '@@ -20,0 +22 @@',
    '+tail-added',
    '\\ No newline at end of file',
    '',
  ].join('\n');

  it('解析修改/纯删除/纯新增/尾部追加四类 hunk，count 缺省为 1', () => {
    expect(parseZeroContextDiffHunks(DIFF)).toEqual([
      { oldStart: 5, oldCount: 1, newStart: 5, newCount: 1 },
      { oldStart: 8, oldCount: 1, newStart: 7, newCount: 0 },
      { oldStart: 14, oldCount: 0, newStart: 14, newCount: 2 },
      { oldStart: 20, oldCount: 0, newStart: 22, newCount: 1 },
    ]);
  });

  it('空输出/属性-only 输出/二进制标记不产生 hunk', () => {
    expect(parseZeroContextDiffHunks('')).toEqual([]);
    expect(parseZeroContextDiffHunks('Cannot display: file marked as a binary type.\nsvn:mime-type = application/octet-stream\n')).toEqual([]);
  });

  it('默认 3 行上下文的 hunk 头（count 带逗号）同样可解析', () => {
    expect(parseZeroContextDiffHunks('@@ -4997,7 +4997,7 @@\n context\n')).toEqual([
      { oldStart: 4997, oldCount: 7, newStart: 4997, newCount: 7 },
    ]);
  });
});

describe('quickDiff：hunk 行号映射', () => {
  const hunks: QuickDiffHunk[] = [
    { oldStart: 5, oldCount: 1, newStart: 5, newCount: 1 },
    { oldStart: 8, oldCount: 1, newStart: 7, newCount: 0 },
    { oldStart: 14, oldCount: 0, newStart: 14, newCount: 2 },
    { oldStart: 20, oldCount: 0, newStart: 22, newCount: 1 },
  ];

  it('修改 → newStart；纯新增 → [newStart, newStart+newCount-1]；删除 → newStart 附近', () => {
    expect(mapQuickDiffHunksToLines(hunks, 22)).toEqual([
      { line: 5, kind: 'modified' },
      { line: 7, kind: 'deleted', deletedCount: 1 },
      { line: 14, kind: 'added' },
      { line: 15, kind: 'added' },
      { line: 22, kind: 'added' },
    ]);
  });

  it('纯删除 hunk newStart=0（删除文件开头）clamp 到第 1 行，不产生非法行号', () => {
    expect(mapQuickDiffHunksToLines([{ oldStart: 1, oldCount: 3, newStart: 0, newCount: 0 }], 10)).toEqual([
      { line: 1, kind: 'deleted', deletedCount: 3 },
    ]);
  });

  it('hunk 超出文档行数时 clamp 到末行；空文档（0 行）不生成标记', () => {
    expect(mapQuickDiffHunksToLines([{ oldStart: 1, oldCount: 0, newStart: 30, newCount: 2 }], 10)).toEqual([
      { line: 10, kind: 'added' },
    ]);
    expect(mapQuickDiffHunksToLines(hunks, 0)).toEqual([]);
  });

  it('一行同时命中删除与新增/修改时以新增/修改为准', () => {
    const markers = mapQuickDiffHunksToLines([
      { oldStart: 5, oldCount: 2, newStart: 5, newCount: 0 },
      { oldStart: 0, oldCount: 0, newStart: 5, newCount: 1 },
    ], 10);
    expect(markers).toEqual([{ line: 5, kind: 'added' }]);
  });
});

describe('quickDiff：命令参数与装饰构建', () => {
  it('完整命令固定 --internal-diff/--ignore-properties/-r BASE/-x -U0 并以 -- 结束', () => {
    expect(QUICK_DIFF_BASE_ARGS).toEqual([
      'diff', '--non-interactive', '--internal-diff', '--ignore-properties', '-r', 'BASE', '-x', '-U0',
    ]);
    expect(buildQuickDiffArgs('src/a@1.txt')).toEqual([
      'diff', '--non-interactive', '--internal-diff', '--ignore-properties', '-r', 'BASE', '-x', '-U0',
      '--', 'src/a@1.txt',
    ]);
    // @ 路径不追加尾 peg：追加会被 svn 当字面文件名（E155010）。
    expect(buildQuickDiffArgs('src/a@1.txt').at(-1)).toBe('src/a@1.txt');
  });

  it('装饰按行号建 Range；删除行带「已删除 N 行」after 文本', () => {
    const decorations = buildQuickDiffDecorations([
      { line: 2, kind: 'modified' },
      { line: 4, kind: 'added' },
      { line: 6, kind: 'deleted', deletedCount: 3 },
    ]);
    expect(decorations.modified).toHaveLength(1);
    expect(decorations.added).toHaveLength(1);
    expect(decorations.deleted).toHaveLength(1);
    const range = decorations.modified[0]?.range as unknown as { startLine: number; endLine: number };
    expect(range.startLine).toBe(1);
    expect(range.endLine).toBe(1);
    const after = (decorations.deleted[0] as { renderOptions?: { after?: { contentText?: string } } })
      .renderOptions?.after?.contentText;
    expect(after).toContain('3');
  });

  it('createQuickDiffDecorationTypes 创建三种装饰类型（修改/新增/删除）', () => {
    const types = createQuickDiffDecorationTypes();
    expect(types.modified.key).not.toBe(types.added.key);
    expect(types.added.key).not.toBe(types.deleted.key);
    expect(vscodeMock.decorationTypes).toHaveLength(3);
  });
});

/* ------------------------------ 真实 SVN 测试 ------------------------------ */

let hasSvn = false;
try {
  execSync('svn --version', { stdio: 'ignore' });
  hasSvn = true;
} catch {
  hasSvn = false;
}

let hasSvnadmin = false;
try {
  execSync('svnadmin --version', { stdio: 'ignore' });
  hasSvnadmin = true;
} catch {
  hasSvnadmin = false;
}

const realSvn = hasSvn && hasSvnadmin ? describe : describe.skip;

const makeUri = (fsPath: string): vscode.Uri => ({ scheme: 'file', fsPath }) as unknown as vscode.Uri;

realSvn('quickDiff：本地目标判定（真实 file:// 仓库）', () => {
  let lab: SvnLab;
  let wc: string;

  beforeEach(() => {
    lab = createSvnLab('svn-anywhere-quickdiff-');
    wc = lab.checkout('wc');
    writeFile(wc, 'target.txt', Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n');
    writeFile(wc, 'clean.txt', 'clean\n');
    writeFile(wc, 'a@1.txt', 'peg\n');
    lab.svn(['add', '-q', 'target.txt', 'clean.txt'], wc);
    // svn add 的路径参数也要 peg 转义（@1 不可裸传）。
    lab.svn(['add', '-q', 'a@1.txt@'], wc);
    lab.svn(['commit', '-q', '-m', 'base'], wc);
  });

  afterEach(() => {
    lab.cleanup();
  });

  it('干净/修改的版本文件通过；未版本控制、missing、目录、二进制分别拒绝', async () => {
    writeFileSync(join(wc, 'target.txt'), 'line1-local\n' + Array.from({ length: 19 }, (_, i) => `line${i + 2}`).join('\n'));
    const modified = await probeLocalEditorTarget(makeUri(join(wc, 'target.txt')), { svnPath: 'svn' });
    expect(modified.status).toBe('ok');
    if (modified.status === 'ok') {
      expect(modified.target.relPath).toBe('target.txt');
      expect(modified.target.wcRoot).toBeTruthy();
    }

    const clean = await probeLocalEditorTarget(makeUri(join(wc, 'clean.txt')), { svnPath: 'svn' });
    expect(clean.status).toBe('ok');

    writeFileSync(join(wc, 'unversioned.txt'), 'x');
    const unversioned = await probeLocalEditorTarget(makeUri(join(wc, 'unversioned.txt')), { svnPath: 'svn' });
    expect(unversioned).toEqual({ status: 'rejected', reason: 'unversioned' });

    writeFileSync(join(wc, 'rm-test.txt'), 'x');
    lab.svn(['add', '-q', 'rm-test.txt'], wc);
    // 已 schedule-add 的本地文件直接 rm 会被 local modifications 阻止。
    lab.svn(['rm', '--force', '-q', 'rm-test.txt'], wc);
    const missing = await probeLocalEditorTarget(makeUri(join(wc, 'rm-test.txt')), { svnPath: 'svn' });
    expect(missing).toEqual({ status: 'rejected', reason: 'missing' });

    mkdirSync(join(wc, 'dir-node'));
    lab.svn(['add', '-q', 'dir-node'], wc);
    const directory = await probeLocalEditorTarget(makeUri(join(wc, 'dir-node')), { svnPath: 'svn' });
    expect(directory).toEqual({ status: 'rejected', reason: 'directory' });

    lab.svn(['propset', '-q', 'svn:mime-type', 'application/octet-stream', 'target.txt'], wc);
    const binaryByMime = await probeLocalEditorTarget(makeUri(join(wc, 'target.txt')), { svnPath: 'svn' });
    expect(binaryByMime).toEqual({ status: 'rejected', reason: 'binary' });

    lab.svn(['propdel', '-q', 'svn:mime-type', 'target.txt'], wc);
    writeFileSync(join(wc, 'clean.txt'), Buffer.from([0x61, 0x00, 0x62]));
    const binaryByNul = await probeLocalEditorTarget(makeUri(join(wc, 'clean.txt')), { svnPath: 'svn' });
    expect(binaryByNul).toEqual({ status: 'rejected', reason: 'binary' });

    const notWorkingCopy = await probeLocalEditorTarget(makeUri('/tmp'), { svnPath: 'svn' });
    expect(notWorkingCopy).toEqual({ status: 'rejected', reason: 'notWorkingCopy' });
    const notFile = await probeLocalEditorTarget(
      { scheme: 'untitled', fsPath: 'Untitled-1' } as unknown as vscode.Uri,
      { svnPath: 'svn' },
    );
    expect(notFile).toEqual({ status: 'rejected', reason: 'notFile' });
  });

  it('collectQuickDiffHunks 解析修改/删除/新增/尾部追加，@ 路径用原始字面形态', async () => {
    const newLines = [
      'line1', 'line2', 'line3', 'line4', 'line5-local', 'line6', 'line7',
      ...Array.from({ length: 6 }, (_, i) => `line${i + 9}`), // line9-14
      'inserted-a', 'inserted-b',
      ...Array.from({ length: 6 }, (_, i) => `line${i + 15}`), // line15-20
      'tail-added',
    ];
    writeFileSync(join(wc, 'target.txt'), newLines.join('\n') + '\n');
    const modified = await collectQuickDiffHunks('svn', { wcRoot: wc, relPath: 'target.txt' });
    expect(modified.status).toBe('ok');
    if (modified.status === 'ok') {
      expect(modified.hunks).toEqual([
        { oldStart: 5, oldCount: 1, newStart: 5, newCount: 1 },
        { oldStart: 8, oldCount: 1, newStart: 7, newCount: 0 },
        { oldStart: 14, oldCount: 0, newStart: 14, newCount: 2 },
        { oldStart: 20, oldCount: 0, newStart: 22, newCount: 1 },
      ]);
    }

    writeFileSync(join(wc, 'a@1.txt'), 'peg-local\n');
    const peg = await collectQuickDiffHunks('svn', { wcRoot: wc, relPath: 'a@1.txt' });
    expect(peg).toEqual({
      status: 'ok',
      hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }],
    });

    // 未改动文件：空输出 → 0 个 hunk（不当作错误）。
    expect(await collectQuickDiffHunks('svn', { wcRoot: wc, relPath: 'clean.txt' })).toEqual({ status: 'ok', hunks: [] });
  });
});

/* ------------------------------ 状态机测试 ------------------------------ */

interface FakeDecorationType {
  key: string;
  setCalls: unknown[][];
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
    lineAt: (line: number) => ({ range: new vscodeMock.Range(line, 0, line, 0) }),
  };
  const editor = {
    document,
    setDecorations: (type: FakeDecorationType, options: unknown[]) => {
      calls.push({ type, options });
      type.setCalls.push(options);
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

function baseDeps(overrides: Partial<QuickDiffDeps> = {}): QuickDiffDeps {
  return {
    svnPath: 'svn',
    runOptions: {},
    probe: async () => ({ status: 'ok', target }),
    collect: async () => ({ status: 'ok', hunks: [{ oldStart: 3, oldCount: 1, newStart: 3, newCount: 1 }] }),
    ...overrides,
  };
}

const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  disableQuickDiff();
  resetOutputState();
  disposeOutputChannel();
  vscodeMock.information.length = 0;
  vscodeMock.warning.length = 0;
  vscodeMock.error.length = 0;
  vscodeMock.decorationTypes.length = 0;
  vscodeMock.nextDecorationKey = 1;
  vscodeMock.saveHandlers.length = 0;
  vscodeMock.activeEditorHandlers.length = 0;
});

describe('quickDiff：开关状态机', () => {
  it('开启后按 hunk 行号装饰；再次执行同一文件关闭并清除全部装饰、释放类型', async () => {
    const { editor, calls } = createFakeEditor('/repo/file.txt', 10);
    const enabled = await toggleQuickDiff(editor, baseDeps());
    expect(enabled).toEqual({ status: 'enabled', markerCount: 1 });
    expect(isQuickDiffEnabled()).toBe(true);
    expect(calls.map((call) => call.type.key)).toEqual(['decoration-1', 'decoration-2', 'decoration-3']);
    const modifiedOptions = calls[0]?.options as Array<{ range: { startLine: number } }>;
    expect(modifiedOptions).toHaveLength(1);
    expect(modifiedOptions[0]?.range.startLine).toBe(2);

    const disabled = await toggleQuickDiff(editor, baseDeps());
    expect(disabled).toEqual({ status: 'disabled' });
    expect(isQuickDiffEnabled()).toBe(false);
    // 关闭时三类装饰各清空一次（最后三次 setDecorations 均为空数组），随后 dispose。
    const lastThree = calls.slice(-3);
    expect(lastThree).toHaveLength(3);
    expect(lastThree.every((call) => call.options.length === 0)).toBe(true);
    expect(vscodeMock.decorationTypes.every((type) => type.disposed)).toBe(true);
    expect(vscodeMock.saveHandlers).toHaveLength(0);
    expect(vscodeMock.activeEditorHandlers).toHaveLength(0);
  });

  it('目标判定拒绝时不开启装饰；探测异常返回 failed', async () => {
    const { editor, calls } = createFakeEditor('/repo/unversioned.txt', 10);
    expect(await toggleQuickDiff(editor, baseDeps({
      probe: async () => ({ status: 'rejected', reason: 'unversioned' }),
    }))).toEqual({ status: 'rejected', reason: 'unversioned' });
    expect(calls).toHaveLength(0);
    expect(isQuickDiffEnabled()).toBe(false);

    const error = new Error('探测失败');
    expect(await toggleQuickDiff(editor, baseDeps({
      probe: async () => ({ status: 'error', error }),
    }))).toEqual({ status: 'failed', error });
  });

  it('无活动编辑器返回 noActiveEditor；diff 报告二进制按拒绝处理', async () => {
    expect(await toggleQuickDiff(undefined, baseDeps())).toEqual({ status: 'rejected', reason: 'noActiveEditor' });
    const { editor } = createFakeEditor('/repo/file.bin', 10);
    expect(await toggleQuickDiff(editor, baseDeps({
      collect: async () => ({ status: 'binary' }),
    }))).toEqual({ status: 'rejected', reason: 'binary' });
  });

  it('保存同一文档触发重新装饰；切换编辑器撤销且无残留', async () => {
    const { editor, calls } = createFakeEditor('/repo/file.txt', 10);
    const refreshedHunks: QuickDiffHunk[] = [
      { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 },
      { oldStart: 6, oldCount: 0, newStart: 6, newCount: 2 },
    ];
    const deps = baseDeps({ collect: async () => ({ status: 'ok', hunks: refreshedHunks }) });
    await toggleQuickDiff(editor, deps);
    expect(calls).toHaveLength(3);

    const saveHandler = vscodeMock.saveHandlers[0];
    expect(saveHandler).toBeDefined();
    saveHandler?.({ uri: { toString: () => 'file:///repo/file.txt' } });
    await flushAsync();
    // 刷新后三类装饰重新写入（3 次初始 + 3 次刷新）。
    expect(calls).toHaveLength(6);
    const modifiedOptions = calls[3]?.options as Array<{ range: { startLine: number } }>;
    expect(modifiedOptions[0]?.range.startLine).toBe(1);
    const addedOptions = calls[4]?.options as Array<{ range: { startLine: number } }>;
    expect(addedOptions.map((option) => option.range.startLine)).toEqual([5, 6]);

    // 其他文档保存不影响当前会话。
    saveHandler?.({ uri: { toString: () => 'file:///repo/other.txt' } });
    await flushAsync();
    expect(calls).toHaveLength(6);

    // 活动编辑器切走 → 撤销并清空（最后三次 setDecorations 均为空数组）。
    const activeHandler = vscodeMock.activeEditorHandlers[0];
    activeHandler?.({ document: { uri: { toString: () => 'file:///repo/other.txt' } } });
    expect(isQuickDiffEnabled()).toBe(false);
    const lastThree = calls.slice(-3);
    expect(lastThree).toHaveLength(3);
    expect(lastThree.every((call) => call.options.length === 0)).toBe(true);
  });

  it('编辑器重新激活同一文档：保持开启并按「重新激活刷新」重算装饰', async () => {
    const { editor, calls } = createFakeEditor('/repo/file.txt', 10);
    await toggleQuickDiff(editor, baseDeps());
    expect(calls).toHaveLength(3);
    vscodeMock.activeEditorHandlers[0]?.(editor);
    await flushAsync();
    expect(isQuickDiffEnabled()).toBe(true);
    expect(calls).toHaveLength(6);
  });

  it('并发开启：先发调用被取代，结果丢弃且不残留装饰类型与监听', async () => {
    const first = createFakeEditor('/repo/first.txt', 10);
    const second = createFakeEditor('/repo/second.txt', 10);
    let releaseFirst: (() => void) | undefined;
    const firstProbeGate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    const pendingFirst = toggleQuickDiff(first.editor, baseDeps({
      probe: async () => {
        await firstProbeGate;
        return { status: 'ok', target: { ...target, fsPath: '/repo/first.txt', relPath: 'first.txt' } };
      },
    }));
    // 第一次探测仍挂起时再次触发：后发者胜出，先发结果必须丢弃。
    const pendingSecond = toggleQuickDiff(second.editor, baseDeps({
      probe: async () => ({
        status: 'ok',
        target: { ...target, fsPath: '/repo/second.txt', relPath: 'second.txt' },
      }),
    }));
    await expect(pendingSecond).resolves.toEqual({ status: 'enabled', markerCount: 1 });
    releaseFirst?.();
    await expect(pendingFirst).resolves.toEqual({ status: 'superseded' });
    expect(isQuickDiffEnabled()).toBe(true);
    // 修复前两次调用各建会话：先完成的装饰类型与监听永不释放、装饰无法撤销。
    expect(first.calls).toHaveLength(0);
    expect(second.calls).toHaveLength(3);
    expect(vscodeMock.decorationTypes).toHaveLength(3);
    expect(vscodeMock.decorationTypes.every((type) => !type.disposed)).toBe(true);
    expect(vscodeMock.saveHandlers).toHaveLength(1);
    expect(vscodeMock.activeEditorHandlers).toHaveLength(1);
  });

  it('开启在途时执行关闭：开启结果过期，不重新点亮会话', async () => {
    const { editor, calls } = createFakeEditor('/repo/file.txt', 10);
    let releaseProbe: (() => void) | undefined;
    const gate = new Promise<void>((resolveGate) => {
      releaseProbe = resolveGate;
    });
    const pending = toggleQuickDiff(editor, baseDeps({
      probe: async () => {
        await gate;
        return { status: 'ok', target };
      },
    }));
    disableQuickDiff();
    releaseProbe?.();
    await expect(pending).resolves.toEqual({ status: 'superseded' });
    expect(isQuickDiffEnabled()).toBe(false);
    expect(calls).toHaveLength(0);
    expect(vscodeMock.decorationTypes).toHaveLength(0);
    expect(vscodeMock.saveHandlers).toHaveLength(0);
    expect(vscodeMock.activeEditorHandlers).toHaveLength(0);
  });

  it('最近刷新结果可回读：保存刷新后更新、失败记录错误、关闭清空（编辑器冒烟依赖）', async () => {
    const { editor } = createFakeEditor('/repo/file.txt', 10);
    await toggleQuickDiff(editor, baseDeps());
    expect(getLastQuickDiffRefresh()).toEqual({ uriKey: 'file:///repo/file.txt', markerCount: 1 });

    const before = getLastQuickDiffRefresh();
    const saveHandler = vscodeMock.saveHandlers[0];
    saveHandler?.({ uri: { toString: () => 'file:///repo/file.txt' } });
    await flushAsync();
    const after = getLastQuickDiffRefresh();
    expect(after).not.toBe(before);
    expect(after).toEqual({ uriKey: 'file:///repo/file.txt', markerCount: 1 });

    // 刷新命中拒绝（如文件变为未版本控制）：清空装饰并记录原因。
    await refreshQuickDiff(baseDeps({ probe: async () => ({ status: 'rejected', reason: 'unversioned' }) }));
    expect(getLastQuickDiffRefresh()).toEqual({
      uriKey: 'file:///repo/file.txt',
      markerCount: null,
      error: strings.editor.reasonUnversioned,
    });

    disableQuickDiff();
    expect(getLastQuickDiffRefresh()).toBeUndefined();
  });
});
