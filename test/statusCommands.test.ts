/**
 * 状态与更新四条命令（显示状态/刷新状态/更新/清理）的宿主侧链路测试：
 * mock vscode 与 core svn 执行模块，验证目标解析到频道输出/确认/进度/
 * 冲突提示的完整链路，不依赖真实 svn 进程。
 */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { SvnError } from '../src/core/errors';
import { runStatus } from '../src/core/status';
import { runUpdate } from '../src/core/update';
import { runOrThrow } from '../src/core/svnCli';
import { disposeOutputChannel, getOutputChannel, resetOutputState } from '../src/host/output';
import { strings } from '../src/host/i18n';

vi.mock('../src/core/status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/status')>();
  return { ...actual, runStatus: vi.fn() };
});
vi.mock('../src/core/update', () => ({ runUpdate: vi.fn() }));
vi.mock('../src/core/svnCli', () => ({
  run: vi.fn(),
  runOrThrow: vi.fn(),
  DEFAULT_TIMEOUT_MS: 120_000,
  killAllActive: vi.fn(),
}));

const vscodeMock = vi.hoisted(() => ({
  channels: [] as Array<{ lines: string[]; shown: number; appendLine: (l: string) => void; show: () => void; dispose: () => void }>,
  warning: [] as string[],
  /** 模态确认框返回的按钮；undefined 表示用户取消。 */
  confirmResult: undefined as string | undefined,
  progressCalls: [] as string[],
  openDialogCalls: 0,
  openDialogResult: undefined as Array<{ fsPath: string }> | undefined,
  activeTextEditor: undefined as { document: { uri: { scheme: string; fsPath: string } } } | undefined,
}));

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => {
      const ch = {
        lines: [] as string[],
        shown: 0,
        appendLine(line: string) {
          ch.lines.push(line);
        },
        show() {
          ch.shown += 1;
        },
        dispose() {},
      };
      vscodeMock.channels.push(ch);
      return ch;
    },
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: (message: string) => {
      vscodeMock.warning.push(message);
      return Promise.resolve(vscodeMock.confirmResult);
    },
    showErrorMessage: () => Promise.resolve(undefined),
    showOpenDialog: () => {
      vscodeMock.openDialogCalls += 1;
      return Promise.resolve(vscodeMock.openDialogResult);
    },
    withProgress: (_options: unknown, task: (p: unknown, t: unknown) => Promise<unknown>) => {
      const options = _options as { title?: string };
      vscodeMock.progressCalls.push(options.title ?? '');
      return task({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) });
    },
    get activeTextEditor() {
      return vscodeMock.activeTextEditor;
    },
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
  ProgressLocation: { Notification: 15 },
}));

import { commandShowStatus } from '../src/host/commands/showStatus';
import { commandRefreshStatus } from '../src/host/commands/refreshStatus';
import { commandUpdate } from '../src/host/commands/update';
import { commandCleanup } from '../src/host/commands/cleanup';

const makeUri = (fsPath: string): vscode.Uri => ({ fsPath, scheme: 'file' }) as unknown as vscode.Uri;

const channelLines = (): string[] => {
  const channel = getOutputChannel();
  if (!channel) {
    throw new Error('输出频道不存在');
  }
  return (channel as unknown as { lines: string[] }).lines;
};

vi.mocked(runStatus).mockResolvedValue({ targetPath: '.', entries: [] });
vi.mocked(runUpdate).mockResolvedValue({
  stdout: '', stderr: '', exitCode: 0, items: [], conflicts: [],
});
vi.mocked(runOrThrow).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

let wcRoot = '';

beforeEach(() => {
  disposeOutputChannel();
  resetOutputState();
  vscodeMock.channels.length = 0;
  vscodeMock.warning.length = 0;
  vscodeMock.confirmResult = undefined;
  vscodeMock.progressCalls.length = 0;
  vscodeMock.openDialogCalls = 0;
  vscodeMock.openDialogResult = undefined;
  vscodeMock.activeTextEditor = undefined;
  wcRoot = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-stcmd-')));
  mkdirSync(join(wcRoot, '.svn'), { recursive: true });
  writeFileSync(join(wcRoot, '.svn', 'wc.db'), 'fake');
});

afterEach(() => {
  rmSync(wcRoot, { recursive: true, force: true });
});

describe('commandShowStatus（显示状态）', () => {
  it('对右键路径读状态：相对目标、wcStatus 原词进频道并展示', async () => {
    const filePath = join(wcRoot, 'src', 'a.txt');
    mkdirSync(join(wcRoot, 'src'));
    writeFileSync(filePath, 'x');
    vi.mocked(runStatus).mockResolvedValueOnce({
      targetPath: 'src/a.txt',
      entries: [
        { path: 'src/a.txt', wcStatus: 'modified', props: 'none', revision: 3 },
        { path: 'src/new.txt', wcStatus: 'unversioned', props: 'none' },
      ],
    });

    await commandShowStatus(makeUri(filePath));

    expect(vi.mocked(runStatus)).toHaveBeenCalledWith('svn', 'src/a.txt', expect.objectContaining({ cwd: wcRoot }));
    const output = channelLines().join('\n');
    expect(output).toContain('[modified] src/a.txt');
    expect(output).toContain('[unversioned] src/new.txt');
    expect(vscodeMock.channels.at(-1)?.shown).toBe(1);
  });

  it('干净副本：频道写「无本地变更」', async () => {
    vi.mocked(runStatus).mockResolvedValueOnce({ targetPath: '.', entries: [] });
    await commandShowStatus(makeUri(wcRoot));
    expect(channelLines().join('\n')).toContain(strings.status.clean);
  });

  it('纯属性变更：状态行追加「属性修改」注记，不再裸显 normal', async () => {
    vi.mocked(runStatus).mockResolvedValueOnce({
      targetPath: '.',
      entries: [{ path: '.', wcStatus: 'normal', props: 'modified' }],
    });
    await commandShowStatus(makeUri(wcRoot));
    expect(channelLines().join('\n')).toContain('[normal] .（属性修改）');
  });

  it('状态命令向执行层传 onExit（输出频道记录退出码）', async () => {
    vi.mocked(runStatus).mockResolvedValueOnce({ targetPath: '.', entries: [] });
    await commandShowStatus(makeUri(wcRoot));
    expect(vi.mocked(runStatus)).toHaveBeenCalledWith(
      'svn',
      expect.any(String),
      expect.objectContaining({ onExit: expect.any(Function) }),
    );
  });
});

describe('commandRefreshStatus（刷新状态）', () => {
  it('整副本刷新：目标固定为相对根 `.`', async () => {
    writeFileSync(join(wcRoot, 'any.txt'), 'x');
    vi.mocked(runStatus).mockResolvedValueOnce({ targetPath: '.', entries: [] });
    await commandRefreshStatus(makeUri(join(wcRoot, 'any.txt')));
    expect(vi.mocked(runStatus)).toHaveBeenCalledWith('svn', '.', expect.objectContaining({ cwd: wcRoot }));
  });

  it('用户在目标选择环节取消：不读状态', async () => {
    await commandRefreshStatus(undefined);
    expect(vscodeMock.openDialogCalls).toBe(1);
    expect(vi.mocked(runStatus)).not.toHaveBeenCalled();
  });
});

describe('commandUpdate（更新）', () => {
  it('确认后执行更新：进度通知、--non-interactive、频道汇总最终 revision', async () => {
    const filePath = join(wcRoot, 'a.txt');
    writeFileSync(filePath, 'x');
    vscodeMock.confirmResult = strings.update.confirmButton;
    vi.mocked(runUpdate).mockResolvedValueOnce({
      stdout: '', stderr: '', exitCode: 0,
      items: [{ status: 'U', path: 'a.txt' }],
      finalRevision: 5,
      conflicts: [],
    });

    await commandUpdate(makeUri(filePath));

    expect(vscodeMock.progressCalls).toEqual([strings.update.progress.replace('{target}', filePath)]);
    // core 的 runUpdate 内部负责 peg 转义，宿主传原始相对目标。
    expect(vi.mocked(runUpdate)).toHaveBeenCalledWith('svn', 'a.txt', expect.objectContaining({ cwd: wcRoot }));
    const output = channelLines().join('\n');
    expect(output).toContain('update --non-interactive');
    expect(output).toContain('更新完成，当前 revision 5');
  });

  it('模态确认取消：不执行更新', async () => {
    const filePath = join(wcRoot, 'a.txt');
    writeFileSync(filePath, 'x');
    vscodeMock.confirmResult = undefined;

    await commandUpdate(makeUri(filePath));

    expect(vi.mocked(runUpdate)).not.toHaveBeenCalled();
    expect(vscodeMock.progressCalls).toHaveLength(0);
  });

  it('更新产生冲突：频道汇总 revision，弹冲突警告列出文件', async () => {
    const filePath = join(wcRoot, 'a.txt');
    writeFileSync(filePath, 'x');
    vscodeMock.confirmResult = strings.update.confirmButton;
    vi.mocked(runUpdate).mockResolvedValueOnce({
      stdout: '', stderr: '', exitCode: 0,
      items: [{ status: 'C', path: 'a.txt' }],
      finalRevision: 6,
      conflicts: ['a.txt'],
    });

    await commandUpdate(makeUri(filePath));

    expect(channelLines().join('\n')).toContain('更新完成，当前 revision 6');
    expect(vscodeMock.warning.some((m) => m.includes('1 个冲突') && m.includes('a.txt'))).toBe(true);
  });

  it('svn 失败（SvnError CANCELLED 以外的取消由进度触发）：异常向上传播交给统一收口', async () => {
    const filePath = join(wcRoot, 'a.txt');
    writeFileSync(filePath, 'x');
    vscodeMock.confirmResult = strings.update.confirmButton;
    vi.mocked(runUpdate).mockRejectedValueOnce(
      new SvnError({ message: '已被取消', command: ['update'], code: 'CANCELLED' }),
    );

    await expect(commandUpdate(makeUri(filePath))).rejects.toBeInstanceOf(SvnError);
  });
});

describe('commandCleanup（清理）', () => {
  it('进度通知中执行 cleanup：目标转义、频道写完成行', async () => {
    const filePath = join(wcRoot, 'dir@2');
    mkdirSync(join(wcRoot, 'dir@2'));
    vi.mocked(runOrThrow).mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    await commandCleanup(makeUri(filePath));

    expect(vscodeMock.progressCalls).toEqual([strings.cleanup.progress.replace('{target}', filePath)]);
    expect(vi.mocked(runOrThrow)).toHaveBeenCalledWith(
      'svn',
      ['cleanup', 'dir@2@'],
      expect.objectContaining({ cwd: wcRoot }),
    );
    expect(channelLines().join('\n')).toContain(strings.cleanup.done);
  });

  it('svn 失败：异常向上传播交给统一收口', async () => {
    vi.mocked(runOrThrow).mockRejectedValueOnce(
      new SvnError({ message: 'svn: E155007: 出错', command: ['cleanup'], code: 'E155007' }),
    );
    await expect(commandCleanup(makeUri(wcRoot))).rejects.toBeInstanceOf(SvnError);
  });
});
