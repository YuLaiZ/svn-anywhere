/**
 * 单文件差异链路测试：
 * - core 层用真实本地 SVN（svnadmin + file://）验证 BASE 读取、无 BASE 判定、
 *   带历史复制识别与二进制检测；
 * - host 层 openEntryDiff 用替身 vscode/runner 验证决策矩阵与临时资源释放。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { looksBinary, parseCopiedFrom, readBaseContent } from '../src/core/diff';
import { createSvnLab, writeFile } from './helpers';

const labs: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of labs.splice(0)) {
    cleanup();
  }
});

describe('core/diff：真实 SVN 的 BASE 读取', () => {
  it('修改项的 BASE 内容是上次提交版本', async () => {
    const lab = createSvnLab('svn-anywhere-diff-');
    labs.push(() => lab.cleanup());
    const wc = lab.checkout('wc');
    writeFile(wc, 'a.txt', 'base line\n', true);
    lab.svn(['commit', '-q', '-m', 'init'], wc);
    writeFileSync(join(wc, 'a.txt'), 'work line\n');

    const result = await readBaseContent('svn', wc, 'a.txt');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(readFileSync(result.tempPath, 'utf8')).toBe('base line\n');
      rmSync(result.tempDir, { recursive: true, force: true });
    }
  });

  it('未版本控制与纯新增没有 BASE（noBase 而非错误）', async () => {
    const lab = createSvnLab('svn-anywhere-diff-');
    labs.push(() => lab.cleanup());
    const wc = lab.checkout('wc');
    writeFileSync(join(wc, 'untracked.txt'), 'x');
    const unversioned = await readBaseContent('svn', wc, 'untracked.txt');
    expect(unversioned).toEqual({ ok: false, reason: 'noBase' });

    writeFile(wc, 'added.txt', 'new file', true);
    const added = await readBaseContent('svn', wc, 'added.txt');
    expect(added).toEqual({ ok: false, reason: 'noBase' });
  });

  it('带历史复制的新增：BASE 端返回复制来源内容', async () => {
    const lab = createSvnLab('svn-anywhere-diff-');
    labs.push(() => lab.cleanup());
    const wc = lab.checkout('wc');
    writeFile(wc, 'src.txt', 'origin content\n', true);
    lab.svn(['commit', '-q', '-m', 'origin'], wc);
    lab.svn(['copy', '-q', 'src.txt', 'copied.txt'], wc);
    writeFileSync(join(wc, 'copied.txt'), 'modified after copy\n');

    const result = await readBaseContent('svn', wc, 'copied.txt');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe('origin content\n');
      rmSync(result.tempDir, { recursive: true, force: true });
    }

    const info = lab.svn(['info', 'copied.txt'], wc);
    expect(parseCopiedFrom(info)).toMatchObject({ url: expect.stringContaining('src.txt'), revision: expect.any(Number) });
  });

  it('删除项仍有 BASE；@ 邻名不串扰（-- 后字面路径）', async () => {
    const lab = createSvnLab('svn-anywhere-diff-');
    labs.push(() => lab.cleanup());
    const wc = lab.checkout('wc');
    writeFile(wc, 'a@1', 'at-selected\n', true);
    writeFile(wc, 'a@1@', 'at-neighbor\n', true);
    lab.svn(['commit', '-q', '-m', 'ats'], wc);
    // 删除字面 a@1@ 需尾 @ 转义（delete 与 cat 同为 peg 敏感子命令）。
    lab.svn(['delete', '-q', '--', 'a@1@@'], wc);

    const result = await readBaseContent('svn', wc, 'a@1@');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe('at-neighbor\n');
      rmSync(result.tempDir, { recursive: true, force: true });
    }
    // 未删除的 a@1（字面）仍可读取自己的 BASE。
    const neighbor = await readBaseContent('svn', wc, 'a@1');
    expect(neighbor.ok && neighbor.content === 'at-selected\n').toBe(true);
    if (neighbor.ok) {
      rmSync(neighbor.tempDir, { recursive: true, force: true });
    }
  });
});

describe('core/diff：纯函数', () => {
  it('looksBinary 用 NUL 判定', () => {
    expect(looksBinary('text\0binary')).toBe(true);
    expect(looksBinary('普通文本\n')).toBe(false);
  });

  it('parseCopiedFrom 解析 info 输出', () => {
    const info = 'Path: copied.txt\nURL: file://repo/copied.txt\nCopied From URL: file://repo/src.txt\nCopied From Rev: 12\n';
    expect(parseCopiedFrom(info)).toEqual({ url: 'file://repo/src.txt', revision: 12 });
    expect(parseCopiedFrom('Path: plain.txt\n')).toBeUndefined();
  });
});

/* ----------------------- host 层决策矩阵（替身） ----------------------- */

const hostMock = vi.hoisted(() => {
  const executedCommands: unknown[][] = [];
  let closeHandler: ((doc: { uri: { toString(): string } }) => void) | undefined;
  return {
    executedCommands,
    fireClose(doc: { uri: { toString(): string } }) {
      closeHandler?.(doc);
    },
    vscode: () => ({
      Uri: { file: (path: string) => ({ scheme: 'file', path, toString: () => `file://${path}` }) },
      workspace: {
        onDidCloseTextDocument: (handler: (doc: { uri: { toString(): string } }) => void) => {
          closeHandler = handler;
          return { dispose: () => { closeHandler = undefined; } };
        },
      },
      commands: {
        executeCommand: async (command: string, ...args: unknown[]) => {
          executedCommands.push([command, ...args]);
        },
      },
      window: {},
    }),
  };
});

vi.mock('vscode', () => hostMock.vscode());

vi.mock('../src/host/output', () => ({
  logCommand: () => () => {},
  logExitCode: () => {},
  logLine: (line: string) => { hostMock.executedCommands.push(['log', line]); },
  showOutput: () => {},
  resetOutputState: () => {},
  disposeOutputChannel: () => {},
  decodingRunOptions: () => ({ encoding: 'UTF-8', encodingFallback: [], onDecodingFallback: () => {} }),
}));

vi.mock('../src/host/config', () => ({ readTimeoutMs: () => 1000 }));

import { openEntryDiff, resetDiffViewForTest, type DiffTarget } from '../src/host/diffView';
import { resetOutputState, disposeOutputChannel } from '../src/host/output';

const diffTarget = (patch: Partial<DiffTarget> = {}): DiffTarget => ({
  svnPath: 'svn',
  wcRoot: '/wc',
  relPath: 'a.txt',
  wcStatus: 'modified',
  props: 'normal',
  kind: 'file',
  ...patch,
});

/** 执行 vscode.diff 的左右两端内容（从临时文件读取）。 */
function lastDiffUris(): { left: string; right: string; title?: string } | undefined {
  const call = hostMock.executedCommands.find((args) => args[0] === 'vscode.diff');
  if (!call) {
    return undefined;
  }
  const left = call[1] as { toString(): string };
  const right = call[2] as { toString(): string };
  return { left: left.toString(), right: right.toString(), title: call[3] as string | undefined };
}

function readViaUri(uri: string): string {
  return readFileSync(uri.replace('file://', ''), 'utf8');
}

let svnLabHost: ReturnType<typeof createSvnLab> | undefined;

beforeEach(() => {
  hostMock.executedCommands.length = 0;
  resetDiffViewForTest();
  resetOutputState();
  disposeOutputChannel();
});

afterEach(() => {
  resetDiffViewForTest();
  svnLabHost?.cleanup();
  svnLabHost = undefined;
});

describe('openEntryDiff：决策矩阵（真实 SVN 数据）', () => {
  it('修改项打开 BASE → 工作文件；关闭差异后临时资源释放', async () => {
    svnLabHost = createSvnLab('svn-anywhere-diffhost-');
    const wc = svnLabHost.checkout('wc');
    writeFile(wc, 'a.txt', 'base\n', true);
    svnLabHost.svn(['commit', '-q', '-m', 'init'], wc);
    writeFileSync(join(wc, 'a.txt'), 'work\n');

    const outcome = await openEntryDiff(diffTarget({ wcRoot: wc, relPath: 'a.txt' }));
    expect(outcome).toBe('diffed');
    const diff = lastDiffUris();
    expect(diff).toBeDefined();
    expect(readViaUri(diff!.left)).toBe('base\n');
    expect(readViaUri(diff!.right)).toBe('work\n');
    expect(diff!.title).toContain('BASE');

    // 关闭差异编辑器引用的文档 → 临时目录删除。
    const tempLeft = diff!.left;
    hostMock.fireClose({ uri: { toString: () => tempLeft } });
    expect(() => readViaUri(tempLeft)).toThrow();
  });

  it('纯新增比较空内容与当前文件（不读取不存在的 BASE）', async () => {
    svnLabHost = createSvnLab('svn-anywhere-diffhost-');
    const wc = svnLabHost.checkout('wc');
    writeFile(wc, 'brand-new.ts', 'new content\n');
    svnLabHost.svn(['add', '-q', '--parents', 'brand-new.ts'], wc);

    const outcome = await openEntryDiff(diffTarget({ wcRoot: wc, relPath: 'brand-new.ts', wcStatus: 'added' }));
    expect(outcome).toBe('addedNoBase');
    const diff = lastDiffUris();
    expect(readViaUri(diff!.left)).toBe('');
    expect(readViaUri(diff!.right)).toBe('new content\n');
    expect(diff!.title).toContain('新增');
  });

  it('带历史复制的新增标题标注复制来源', async () => {
    svnLabHost = createSvnLab('svn-anywhere-diffhost-');
    const wc = svnLabHost.checkout('wc');
    writeFile(wc, 'src.txt', 'origin\n', true);
    svnLabHost.svn(['commit', '-q', '-m', 'origin'], wc);
    svnLabHost.svn(['copy', '-q', 'src.txt', 'copied.txt'], wc);

    const outcome = await openEntryDiff(diffTarget({ wcRoot: wc, relPath: 'copied.txt', wcStatus: 'added' }));
    expect(outcome).toBe('diffed');
    const diff = lastDiffUris();
    expect(readViaUri(diff!.left)).toBe('origin\n');
    expect(diff!.title).toContain('复制自');
  });

  it('删除项比较 BASE 与空内容', async () => {
    svnLabHost = createSvnLab('svn-anywhere-diffhost-');
    const wc = svnLabHost.checkout('wc');
    writeFile(wc, 'gone.txt', 'old\n', true);
    svnLabHost.svn(['commit', '-q', '-m', 'init'], wc);
    svnLabHost.svn(['delete', '-q', '--', 'gone.txt'], wc);

    const outcome = await openEntryDiff(diffTarget({ wcRoot: wc, relPath: 'gone.txt', wcStatus: 'deleted' }));
    expect(outcome).toBe('deleted');
    const diff = lastDiffUris();
    expect(readViaUri(diff!.left)).toBe('old\n');
    expect(readViaUri(diff!.right)).toBe('');
  });

  it('纯属性修改走属性差异（svn diff --properties 输出进频道），不做文本 diff', async () => {
    svnLabHost = createSvnLab('svn-anywhere-diffhost-');
    const wc = svnLabHost.checkout('wc');
    writeFile(wc, 'dir/.keep', '', true);
    svnLabHost.svn(['commit', '-q', '-m', 'init'], wc);
    svnLabHost.svn(['propset', '-q', 'svn:ignore', 'build', 'dir'], wc);

    const outcome = await openEntryDiff(diffTarget({ wcRoot: wc, relPath: 'dir', wcStatus: 'normal', props: 'modified', kind: 'dir' }));
    expect(outcome).toBe('propertyDiffShown');
    expect(lastDiffUris()).toBeUndefined();
    const logged = hostMock.executedCommands.filter((args) => args[0] === 'log').map((args) => String(args[1]));
    expect(logged.some((line) => line.includes('属性差异'))).toBe(true);
  });

  it('二进制文件明示能力，不打开文本差异', async () => {
    svnLabHost = createSvnLab('svn-anywhere-diffhost-');
    const wc = svnLabHost.checkout('wc');
    const bin = mkdtempSync(join(tmpdir(), 'svn-anywhere-bin-'));
    labs.push(() => rmSync(bin, { recursive: true, force: true }));
    writeFileSync(join(bin, 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]));
    const { execFileSync } = await import('node:child_process');
    execFileSync('cp', [join(bin, 'image.bin'), join(wc, 'image.bin')]);
    svnLabHost.svn(['add', '-q', '--parents', 'image.bin'], wc);
    svnLabHost.svn(['commit', '-q', '-m', 'binary'], wc);
    execFileSync('cp', [join(bin, 'image.bin'), join(wc, 'image.bin')]);
    const { utimesSync } = await import('node:fs');
    utimesSync(join(wc, 'image.bin'), new Date(), new Date());

    const outcome = await openEntryDiff(diffTarget({ wcRoot: wc, relPath: 'image.bin' }));
    expect(outcome).toBe('binaryNotified');
    expect(lastDiffUris()).toBeUndefined();
  });

  it('missing 明示不可比较；unversioned 与普通目录不打开差异', async () => {
    expect(await openEntryDiff(diffTarget({ wcStatus: 'missing' }))).toBe('missingNotified');
    expect(await openEntryDiff(diffTarget({ wcStatus: 'unversioned' }))).toBe('unversionedNotified');
    expect(await openEntryDiff(diffTarget({ kind: 'dir', wcStatus: 'modified' }))).toBe('directoryNotified');
  });
});
