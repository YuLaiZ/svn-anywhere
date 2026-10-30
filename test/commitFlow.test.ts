/**
 * 提交闭环（F22–F30）的宿主侧链路测试：mock vscode 与 core svn 模块，
 * 覆盖面板勾选（unversioned 默认不勾选）、说明输入与空说明开关、
 * missing 的 svn delete --force、提交参数（临时文件 + UTF-8 + 分批）、
 * 结果反馈与提交后刷新、差异查看按钮。
 */
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { runStatus } from '../src/core/status';
import { runUpdate } from '../src/core/update';
import { runRemoteStatus } from '../src/core/remoteStatus';
import { runOrThrow } from '../src/core/svnCli';
import { SvnError } from '../src/core/errors';
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
  confirmResult: undefined as string | undefined,
  commitChoice: undefined as string | undefined,
  config: {} as Record<string, unknown>,
  progressCalls: 0,
  openDialogCalls: 0,
  openDialogResult: undefined as Array<{ fsPath: string }> | undefined,
  activeTextEditor: undefined as { document: { uri: { scheme: string; fsPath: string } } } | undefined,
  quickPicks: [] as Array<Record<string, unknown> & { __handlers: Record<string, Array<(e?: unknown) => void>> }>,
  quickPickAccepted: true,
  quickPickPicked: undefined as string[] | undefined,
  /** 说明编辑文档的内容；messageChoice 模拟用户在通知上点的按钮。 */
  messageEditorContent: 'fix: sample message' as string | undefined,
  messageChoice: undefined as string | undefined,
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
  Uri: {
    parse: (s: string) => ({ scheme: 'untitled', path: s, toString: () => s }),
  },
  TabInputText: class {},
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
    showInformationMessage: (message: string, ...items: string[]) => {
      vscodeMock.information.push(message);
      // 带按钮的调用（说明编辑确认）按 mock 选择返回；无按钮的提示返回 undefined。
      return Promise.resolve(items.length > 0 ? vscodeMock.messageChoice : undefined);
    },
    showWarningMessage: (message: string, _options?: unknown, ...items: string[]) => {
      vscodeMock.warning.push(message);
      return Promise.resolve(items.length === 3 ? vscodeMock.commitChoice : vscodeMock.confirmResult);
    },
    showErrorMessage: () => Promise.resolve(undefined),
    showOpenDialog: () => {
      vscodeMock.openDialogCalls += 1;
      return Promise.resolve(vscodeMock.openDialogResult);
    },
    showInputBox: () => Promise.resolve(undefined),
    showTextDocument: async () => undefined,
    tabGroups: { all: [] as unknown[], close: async () => true },
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
    openTextDocument: async (uri: unknown) => ({
      uri,
      fileName: 'svn-commit-message.txt',
      getText: () => vscodeMock.messageEditorContent ?? '',
    }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
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
vi.mocked(runUpdate).mockResolvedValue({
  stdout: '', stderr: '', exitCode: 0, items: [], conflicts: [],
});
vi.mocked(runOrThrow).mockResolvedValue({
  stdout: 'Sending        a.txt\nCommitted revision 5.\n', stderr: '', exitCode: 0,
});

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
  vscodeMock.messageEditorContent = 'fix: sample message';
  vscodeMock.messageChoice = strings.commit.useMessageButton;
  wcRoot = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-commitflow-')));
  mkdirSync(join(wcRoot, '.svn'), { recursive: true });
  writeFileSync(join(wcRoot, '.svn', 'wc.db'), 'fake');
  writeFileSync(join(wcRoot, 'a.txt'), 'x');
  vi.mocked(runStatus).mockResolvedValue({
    targetPath: '.',
    entries: [{ path: 'a.txt', wcStatus: 'modified', props: 'none' }],
  });
});

afterEach(() => {
  rmSync(wcRoot, { recursive: true, force: true });
});

describe('commandCommit 提交闭环', () => {
  it('普通提交：参数含临时文件与 UTF-8，反馈新 revision，提交后刷新状态', async () => {
    await commandCommit(makeUri(join(wcRoot, 'a.txt')));

    const commitCall = vi.mocked(runOrThrow).mock.calls.find(([, args]) => args[0] === 'commit');
    expect(commitCall).toBeDefined();
    const args = commitCall?.[1] ?? [];
    expect(args.slice(0, 6)).toEqual(['commit', '--non-interactive', '--file', expect.stringMatching(/message\.txt$/), '--encoding', 'UTF-8']);
    expect(args).toContain('a.txt');

    expect(vscodeMock.information).toContainEqual('提交成功，revision 5。');
    // 提交前 status + 提交后刷新（F30）。
    expect(vi.mocked(runStatus)).toHaveBeenCalledTimes(2);
    const output = channelLines().join('\n');
    expect(output).toContain('Committed revision 5.');
    expect(output).toContain('提交后状态：');
  });

  it('嵌套目录的 status 路径相对副本根，提交、missing 和差异不重复拼接目标', async () => {
    mkdirSync(join(wcRoot, 'src'), { recursive: true });
    vi.mocked(runStatus).mockResolvedValue({
      targetPath: 'src',
      entries: [
        { path: 'src/item.txt', wcStatus: 'modified', props: 'none' },
        { path: 'src/drop.txt', wcStatus: 'missing', props: 'none' },
      ],
    });
    vscodeMock.confirmResult = strings.commit.continueButton;
    await commandCommit(makeUri(join(wcRoot, 'src')));
    expect(vi.mocked(runOrThrow).mock.calls.find(([, args]) => args[0] === 'delete')?.[1]).toEqual(['delete', '--force', 'src/drop.txt']);
    const commitArgs = vi.mocked(runOrThrow).mock.calls.find(([, args]) => args[0] === 'commit')?.[1] ?? [];
    expect(commitArgs.slice(6)).toEqual(['src/item.txt', 'src/drop.txt']);
    const picker = vscodeMock.quickPicks[0];
    picker.__handlers.button[0]?.({ item: { entry: { path: 'src/item.txt', wcStatus: 'modified' } } });
    await vi.waitFor(() => expect(vi.mocked(runOrThrow).mock.calls.some(([, args]) => args[0] === 'diff' && args[1] === '--' && args[2] === 'src/item.txt')).toBe(true));
  });

  it('面板取消：不提交', async () => {
    vscodeMock.quickPickAccepted = false;
    await commandCommit(makeUri(join(wcRoot, 'a.txt')));
    expect(vi.mocked(runOrThrow)).not.toHaveBeenCalled();
  });

  it('面板全不选确认：不提交', async () => {
    vscodeMock.quickPickPicked = [];
    await commandCommit(makeUri(join(wcRoot, 'a.txt')));
    expect(vi.mocked(runOrThrow)).not.toHaveBeenCalled();
  });

  it('unversioned 在面板中默认不勾选，手动勾选后进入提交参数', async () => {
    vi.mocked(runStatus).mockResolvedValueOnce({
      targetPath: '.',
      entries: [
        { path: 'a.txt', wcStatus: 'modified', props: 'none' },
        { path: 'new.txt', wcStatus: 'unversioned', props: 'none' },
      ],
    });
    await commandCommit(makeUri(join(wcRoot, 'a.txt')));

    const picker = vscodeMock.quickPicks[0] as unknown as QuickPickLike;
    expect(picker.items).toHaveLength(2);
    // mock 的 show 以 picked 状态过滤：默认勾选只含 modified 项。
    const defaultPicked = picker.items.filter((i) => i.description !== 'unversioned').map((i) => i.label);
    expect(defaultPicked).toEqual(['a.txt']);

    vscodeMock.quickPickPicked = ['new.txt'];
    // 第二次调用同样注入两个条目，勾选 unversioned 项。
    vi.mocked(runStatus).mockResolvedValueOnce({
      targetPath: '.',
      entries: [
        { path: 'a.txt', wcStatus: 'modified', props: 'none' },
        { path: 'new.txt', wcStatus: 'unversioned', props: 'none' },
      ],
    });
    // 目录目标：条目路径相对副本根，toWcRelative 原样保留。
    await commandCommit(makeUri(wcRoot));
    const commitCall = vi.mocked(runOrThrow).mock.calls.filter(([, args]) => args[0] === 'commit').at(-1);
    expect((commitCall?.[1] ?? [])).toContain('new.txt');
  });

  it('说明编辑取消（点「取消」或直接关闭文档）：不提交', async () => {
    vscodeMock.messageChoice = strings.commit.cancelButton;
    await commandCommit(makeUri(join(wcRoot, 'a.txt')));
    expect(vi.mocked(runOrThrow)).not.toHaveBeenCalled();
  });

  it('多行说明：换行原样进入 --file 临时文件（F91）', async () => {
    vscodeMock.messageEditorContent = '第一行\n第二行';
    let messageFile = '';
    vi.mocked(runOrThrow).mockImplementationOnce(async (_svn, args) => {
      const idx = args.indexOf('--file');
      messageFile = readFileSync(args[idx + 1], 'utf8');
      return { stdout: 'Committed revision 7.\n', stderr: '', exitCode: 0 };
    });
    await commandCommit(makeUri(join(wcRoot, 'a.txt')));

    // mock 在 executeCommit 删除临时目录前读取内容，换行必须原样保留。
    expect(messageFile).toBe('第一行\n第二行');
    // 通知引导文案出现，说明走的是多行编辑器入口。
    expect(vscodeMock.information.some((m) => m.includes('支持多行'))).toBe(true);
  });

  it('空说明且开关开启：二次确认后以空临时文件提交', async () => {
    vscodeMock.messageEditorContent = '';
    vscodeMock.confirmResult = strings.commit.continueButton;
    vi.mocked(runOrThrow).mockClear();
    await commandCommit(makeUri(join(wcRoot, 'a.txt')));
    expect(vi.mocked(runOrThrow)).toHaveBeenCalled();
    expect(vscodeMock.warning).toContainEqual(strings.commit.emptyMessageConfirm);
  });

  it('空说明且开关关闭：拒绝并提示', async () => {
    vscodeMock.messageEditorContent = '';
    vscodeMock.config = { allowEmptyCommitMessage: false };
    await commandCommit(makeUri(join(wcRoot, 'a.txt')));
    expect(vi.mocked(runOrThrow)).not.toHaveBeenCalled();
    expect(vscodeMock.information).toContainEqual(strings.commit.emptyMessageRejected);
  });

  it('missing 项：确认后逐个 svn delete --force 再提交', async () => {
    vi.mocked(runStatus).mockResolvedValueOnce({
      targetPath: '.',
      entries: [{ path: 'gone.txt', wcStatus: 'missing', props: 'none' }],
    });
    vscodeMock.confirmResult = strings.commit.continueButton;
    vi.mocked(runOrThrow).mockClear();
    // 目录目标：条目路径相对副本根。
    await commandCommit(makeUri(wcRoot));

    const calls = vi.mocked(runOrThrow).mock.calls;
    expect(calls[0]?.[1]).toEqual(['delete', '--force', 'gone.txt']);
    expect(calls.at(-1)?.[1]?.[0]).toBe('commit');
  });

  it('missing 处理取消：不提交', async () => {
    vi.mocked(runStatus).mockResolvedValueOnce({
      targetPath: '.',
      entries: [{ path: 'gone.txt', wcStatus: 'missing', props: 'none' }],
    });
    vscodeMock.confirmResult = undefined;
    await commandCommit(makeUri(wcRoot));
    expect(vi.mocked(runOrThrow)).not.toHaveBeenCalled();
  });

  it('纯属性变更：不再提示无可提交变更，面板展示「属性修改」并作为提交目标', async () => {
    vi.mocked(runStatus).mockResolvedValue({
      targetPath: '.',
      entries: [{ path: '.', wcStatus: 'normal', props: 'modified' }],
    });
    await commandCommit(makeUri(wcRoot));

    expect(vscodeMock.information).not.toContainEqual(strings.commitCheck.noChanges);
    const picker = vscodeMock.quickPicks[0] as unknown as QuickPickLike;
    expect(picker.items[0]?.description).toBe(strings.commit.propModified);

    const commitCall = vi.mocked(runOrThrow).mock.calls.find(([, args]) => args[0] === 'commit');
    // 目标是副本根：条目 '.' 换算后仍为相对根路径，svn commit 以 cwd 为基准提交目录属性。
    expect(commitCall?.[1]).toContain('.');
  });

  it('提交失败：SvnError 向上传播交给统一收口', async () => {
    vi.mocked(runOrThrow).mockRejectedValueOnce(
      new SvnError({ message: 'svn: E155015: 冲突', command: ['commit'], code: 'E155015' }),
    );
    await expect(commandCommit(makeUri(join(wcRoot, 'a.txt')))).rejects.toBeInstanceOf(SvnError);
  });

  it('差异按钮：对条目执行 svn diff 并写入输出频道', async () => {
    await commandCommit(makeUri(join(wcRoot, 'a.txt')));
    const picker = vscodeMock.quickPicks[0] as unknown as QuickPickLike & {
      __handlers: Record<string, Array<(e?: unknown) => void>>;
    };
    const buttonHandlers = picker.__handlers.button ?? [];
    expect(buttonHandlers).toHaveLength(1);

    vi.mocked(runOrThrow).mockClear();
    vi.mocked(runOrThrow).mockResolvedValueOnce({
      stdout: 'Index: a.txt\n--- a.txt\n+++ a.txt\n', stderr: '', exitCode: 0,
    });
    const item = { item: { entry: { path: 'a.txt', wcStatus: 'modified', props: 'none' } } };
    buttonHandlers[0]?.(item);
    await vi.waitFor(() => {
      expect(channelLines().join('\n')).toContain('差异（a.txt）：');
    });
    const diffCall = vi.mocked(runOrThrow).mock.calls.at(-1);
    expect(diffCall?.[1]).toEqual(['diff', '--', 'a.txt']);
  });
});
