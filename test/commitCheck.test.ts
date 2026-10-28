/**
 * 提交前检查（F145/F81）的宿主侧链路测试：mock vscode 与 core svn 模块，
 * 覆盖远端检查开关、三选模态、更新后重读状态、冲突阻止与无变更提示。
 */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { runStatus } from '../src/core/status';
import { runUpdate } from '../src/core/update';
import { runRemoteStatus } from '../src/core/remoteStatus';
import { runOrThrow } from '../src/core/svnCli';
import { disposeOutputChannel, getOutputChannel, resetOutputState } from '../src/host/output';
import { strings } from '../src/host/i18n';

vi.mock('../src/core/status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/status')>();
  return { ...actual, runStatus: vi.fn() };
});
vi.mock('../src/core/update', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/update')>();
  return { ...actual, runUpdate: vi.fn() };
});
vi.mock('../src/core/remoteStatus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/remoteStatus')>();
  return { ...actual, runRemoteStatus: vi.fn() };
});
vi.mock('../src/core/svnCli', () => ({
  run: vi.fn(),
  runOrThrow: vi.fn(),
  DEFAULT_TIMEOUT_MS: 120_000,
  killAllActive: vi.fn(),
}));

const vscodeMock = vi.hoisted(() => ({
  channels: [] as Array<{ lines: string[]; shown: number; appendLine: (l: string) => void; show: () => void; dispose: () => void }>,
  information: [] as string[],
  warning: [] as string[],
  /** 单按钮模态（更新命令确认）返回值；undefined 表示取消。 */
  confirmResult: undefined as string | undefined,
  /** 三按钮模态（提交前检查）返回值；undefined 表示取消/关闭。 */
  commitChoice: undefined as string | undefined,
  config: {} as Record<string, unknown>,
  progressCalls: 0,
  openDialogCalls: 0,
  openDialogResult: undefined as Array<{ fsPath: string }> | undefined,
  activeTextEditor: undefined as { document: { uri: { scheme: string; fsPath: string } } } | undefined,
  quickPicks: [] as Array<Record<string, unknown> & { __handlers: Record<string, Array<(e?: unknown) => void>> }>,
  quickPickAccepted: true,
  quickPickPicked: undefined as string[] | undefined,
  inputResult: 'fix: sample message' as string | undefined,
}));

interface QuickPickLike {
  title?: string;
  placeholder?: string;
  canSelectMany: boolean;
  matchOnDescription: boolean;
  items: Array<{ label: string; description?: string; entry: unknown }>;
  selectedItems: Array<{ label: string }>;
  onDidAccept(cb: () => void): unknown;
  onDidHide(cb: () => void): unknown;
  onDidTriggerItemButton(cb: (e: unknown) => void): unknown;
  show(): void;
  hide(): void;
  dispose(): void;
}

vi.mock('vscode', () => ({
  ThemeIcon: class {
    constructor(public id: string) {}
  },
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
    showInformationMessage: (message: string) => {
      vscodeMock.information.push(message);
      return Promise.resolve(undefined);
    },
    showWarningMessage: (message: string, _options?: unknown, ...items: string[]) => {
      vscodeMock.warning.push(message);
      // 三个按钮的是提交前检查三选；一个按钮的是更新命令确认。
      return Promise.resolve(items.length === 3 ? vscodeMock.commitChoice : vscodeMock.confirmResult);
    },
    showErrorMessage: () => Promise.resolve(undefined),
    showOpenDialog: () => {
      vscodeMock.openDialogCalls += 1;
      return Promise.resolve(vscodeMock.openDialogResult);
    },
    showInputBox: () => Promise.resolve(vscodeMock.inputResult),
    createQuickPick: (): QuickPickLike => {
      const handlers: Record<string, Array<(e?: unknown) => void>> = {};
      const qp = {
        title: '',
        placeholder: '',
        canSelectMany: false,
        matchOnDescription: false,
        items: [] as Array<{ label: string; description?: string; entry: unknown }>,
        selectedItems: [] as Array<{ label: string }>,
        onDidAccept(cb: () => void) {
          (handlers.accept ??= []).push(cb);
          return { dispose() {} };
        },
        onDidHide(cb: () => void) {
          (handlers.hide ??= []).push(cb);
          return { dispose() {} };
        },
        onDidTriggerItemButton(cb: (e: unknown) => void) {
          (handlers.button ??= []).push(cb);
          return { dispose() {} };
        },
        show() {
          if (vscodeMock.quickPickAccepted) {
            qp.selectedItems = vscodeMock.quickPickPicked
              ? qp.items.filter((i) => vscodeMock.quickPickPicked?.includes(i.label))
              : qp.items.filter((i) => i.description !== 'unversioned');
            handlers.accept?.forEach((cb) => cb());
          }
          handlers.hide?.forEach((cb) => cb());
        },
        hide() {
          handlers.hide?.forEach((cb) => cb());
        },
        dispose() {},
      };
      Object.assign(qp, { __handlers: handlers });
      vscodeMock.quickPicks.push(qp as unknown as Record<string, unknown> & { __handlers: Record<string, Array<(e?: unknown) => void>> });
      return qp;
    },
    withProgress: (_options: unknown, task: (p: unknown, t: unknown) => Promise<unknown>) => {
      vscodeMock.progressCalls += 1;
      return task({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) });
    },
    get activeTextEditor() {
      return vscodeMock.activeTextEditor;
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => (key in vscodeMock.config ? vscodeMock.config[key] : fallback),
    }),
  },
  ProgressLocation: { Notification: 15 },
}));

import { commandCommit } from '../src/host/commands/commit';

const makeUri = (fsPath: string): vscode.Uri => ({ fsPath, scheme: 'file' }) as unknown as vscode.Uri;

const channelLines = (): string[] => {
  const channel = getOutputChannel();
  if (!channel) {
    throw new Error('输出频道不存在');
  }
  return (channel as unknown as { lines: string[] }).lines;
};

vi.mocked(runRemoteStatus).mockResolvedValue({ against: 1, entries: [] });
vi.mocked(runStatus).mockResolvedValue({ targetPath: '.', entries: [] });
vi.mocked(runUpdate).mockResolvedValue({
  stdout: '', stderr: '', exitCode: 0, items: [], conflicts: [],
});
vi.mocked(runOrThrow).mockResolvedValue({ stdout: 'Committed revision 9.', stderr: '', exitCode: 0 });

let wcRoot = '';

beforeEach(() => {
  disposeOutputChannel();
  resetOutputState();
  vscodeMock.channels.length = 0;
  vscodeMock.information.length = 0;
  vscodeMock.warning.length = 0;
  vscodeMock.confirmResult = undefined;
  vscodeMock.commitChoice = undefined;
  vscodeMock.config = {};
  vscodeMock.progressCalls = 0;
  vscodeMock.openDialogCalls = 0;
  vscodeMock.openDialogResult = undefined;
  vscodeMock.activeTextEditor = undefined;
  vscodeMock.quickPicks.length = 0;
  vscodeMock.quickPickAccepted = true;
  vscodeMock.quickPickPicked = undefined;
  vscodeMock.inputResult = 'fix: sample message';
  wcRoot = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-commitchk-')));
  mkdirSync(join(wcRoot, '.svn'), { recursive: true });
  writeFileSync(join(wcRoot, '.svn', 'wc.db'), 'fake');
  writeFileSync(join(wcRoot, 'a.txt'), 'x');
});

afterEach(() => {
  rmSync(wcRoot, { recursive: true, force: true });
});

describe('commandCommit 提交前检查', () => {
  it('开关默认开启：先做远端检查并写入频道汇总', async () => {
    await commandCommit(makeUri(join(wcRoot, 'a.txt')));
    expect(vi.mocked(runRemoteStatus)).toHaveBeenCalledWith('svn', 'a.txt', expect.objectContaining({ cwd: wcRoot }));
    expect(channelLines().join('\n')).toContain('远端检查：0 个远端更新');
  });

  it('无远端更新：不弹模态，直接读取可提交项并进入提交入口', async () => {
    vi.mocked(runStatus).mockResolvedValueOnce({
      targetPath: '.',
      entries: [{ path: 'a.txt', wcStatus: 'modified', props: 'none' }],
    });
    await commandCommit(makeUri(join(wcRoot, 'a.txt')));
    expect(vscodeMock.warning).toHaveLength(0);
    expect(vscodeMock.quickPicks).toHaveLength(1);
    expect(String(vscodeMock.quickPicks[0]?.title)).toContain('选择要提交的变更');
  });

  it('有远端更新：弹三选模态；「更新并继续」后执行更新并重新读取状态', async () => {
    vscodeMock.commitChoice = strings.commitCheck.updateAndContinue;
    vi.mocked(runRemoteStatus).mockResolvedValueOnce({
      against: 2,
      entries: [{ path: 'a.txt', wcStatus: 'normal', reposStatus: 'modified' }],
    });
    vi.mocked(runStatus).mockResolvedValueOnce({
      targetPath: '.',
      entries: [{ path: 'a.txt', wcStatus: 'modified', props: 'none' }],
    });

    await commandCommit(makeUri(join(wcRoot, 'a.txt')));

    expect(vscodeMock.warning).toContainEqual(expect.stringContaining('1 个远端更新'));
    // 更新（performUpdate）与提交（executeCommit）各一次进度通知。
    expect(vscodeMock.progressCalls).toBe(2);
    expect(vi.mocked(runUpdate)).toHaveBeenCalledWith('svn', 'a.txt', expect.objectContaining({ cwd: wcRoot }));
    // 更新后必须重新读取状态，不能复用检查前的结果；提交后刷新再加一次。
    expect(vi.mocked(runStatus)).toHaveBeenCalledTimes(2);
    expect(vscodeMock.quickPicks).toHaveLength(1);
  });

  it('「仅更新」：执行更新后结束，不读取可提交项', async () => {
    vscodeMock.commitChoice = strings.commitCheck.updateOnly;
    vi.mocked(runRemoteStatus).mockResolvedValueOnce({
      against: 2,
      entries: [{ path: 'a.txt', reposStatus: 'modified' }],
    });

    await commandCommit(makeUri(join(wcRoot, 'a.txt')));

    expect(vscodeMock.progressCalls).toBe(1);
    expect(vi.mocked(runStatus)).not.toHaveBeenCalled();
    expect(vscodeMock.information).toHaveLength(0);
  });

  it('「取消」或关闭模态：不执行更新', async () => {
    for (const choice of [strings.commitCheck.cancel, undefined]) {
      vscodeMock.commitChoice = choice;
      vi.mocked(runRemoteStatus).mockResolvedValueOnce({
        against: 2,
        entries: [{ path: 'a.txt', reposStatus: 'modified' }],
      });
      await commandCommit(makeUri(join(wcRoot, 'a.txt')));
    }
    expect(vi.mocked(runUpdate)).not.toHaveBeenCalled();
    expect(vi.mocked(runStatus)).not.toHaveBeenCalled();
  });

  it('更新产生冲突：提示指向冲突文件，提交被阻止', async () => {
    vscodeMock.commitChoice = strings.commitCheck.updateAndContinue;
    vi.mocked(runRemoteStatus).mockResolvedValueOnce({
      against: 2,
      entries: [{ path: 'a.txt', reposStatus: 'modified' }],
    });
    vi.mocked(runUpdate).mockResolvedValueOnce({
      stdout: '', stderr: '', exitCode: 0,
      items: [{ status: 'C', path: 'a.txt' }],
      finalRevision: 3,
      conflicts: ['a.txt'],
    });

    await commandCommit(makeUri(join(wcRoot, 'a.txt')));

    expect(vscodeMock.information.some((m) => m.includes('已停止提交') && m.includes('a.txt'))).toBe(true);
    expect(vi.mocked(runStatus)).not.toHaveBeenCalled();
  });

  it('Summary 段报告冲突但无 C 行：同样阻止提交', async () => {
    vscodeMock.commitChoice = strings.commitCheck.updateAndContinue;
    vi.mocked(runRemoteStatus).mockResolvedValueOnce({
      against: 2,
      entries: [{ path: 'a.txt', reposStatus: 'modified' }],
    });
    vi.mocked(runUpdate).mockResolvedValueOnce({
      stdout: '', stderr: '', exitCode: 0,
      items: [],
      finalRevision: 3,
      conflicts: [],
      conflictSummary: { tree: 1 },
    });

    await commandCommit(makeUri(join(wcRoot, 'a.txt')));

    expect(vscodeMock.information.some((m) => m.includes('已停止提交'))).toBe(true);
  });

  it('关闭 remoteCheckBeforeCommit：跳过远端检查直接进入提交入口', async () => {
    vscodeMock.config = { remoteCheckBeforeCommit: false };
    vi.mocked(runStatus).mockResolvedValueOnce({
      targetPath: '.',
      entries: [{ path: 'a.txt', wcStatus: 'modified', props: 'none' }],
    });

    await commandCommit(makeUri(join(wcRoot, 'a.txt')));

    expect(vi.mocked(runRemoteStatus)).not.toHaveBeenCalled();
    // 提交前读取 + 提交后刷新（F30）各一次。
    expect(vi.mocked(runStatus)).toHaveBeenCalledTimes(2);
    expect(vscodeMock.quickPicks).toHaveLength(1);
  });

  it('无可提交项（仅 unversioned）：提示无变更并结束', async () => {
    vi.mocked(runStatus).mockResolvedValueOnce({
      targetPath: '.',
      entries: [{ path: 'log.txt', wcStatus: 'unversioned', props: 'none' }],
    });

    await commandCommit(makeUri(join(wcRoot, 'a.txt')));

    expect(vscodeMock.information).toEqual([strings.commitCheck.noChanges]);
  });
});
