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
import { format, strings } from '../src/host/i18n';

vi.mock('../src/core/status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/status')>();
  return { ...actual, runStatus: vi.fn() };
});
vi.mock('../src/core/update', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/update')>();
  return { ...actual, runUpdate: vi.fn() };
});
vi.mock('../src/core/svnCli', () => ({
  run: vi.fn(),
  runOrThrow: vi.fn(),
  DEFAULT_TIMEOUT_MS: 120_000,
  killAllActive: vi.fn(),
}));

const vscodeMock = vi.hoisted(() => ({
  channels: [] as Array<{ lines: string[]; shown: number; appendLine: (l: string) => void; show: () => void; dispose: () => void }>,
  warning: [] as string[],
  information: [] as string[],
  /** 模态确认框返回的按钮；undefined 表示用户取消。 */
  confirmResult: undefined as string | undefined,
  /** 非模态警告消息（如冲突提示）按钮点击结果。 */
  warningChoice: undefined as string | undefined,
  /** 注入后：带按钮的非模态警告返回该挂起 promise（模拟用户未处理通知）。 */
  conflictWarningPending: undefined as Promise<string | undefined> | undefined,
  /** InputBox 返回值（单值语义）；inputQueue 优先逐个弹出（重试链路）。 */
  inputResult: undefined as string | undefined,
  inputQueue: [] as Array<string | undefined>,
  inputPrompts: [] as string[],
  /** showQuickPick 按 label 匹配返回的项；undefined 表示取消。 */
  quickPickChoice: undefined as string | undefined,
  quickPickPlaceholders: [] as string[],
  /** workspace.fs.stat 的类型表（fsPath → FileType）；不在表内视为不存在。 */
  fsTypes: new Map<string, number>(),
  /**
   * workspace.fs.stat 的注入错误表（fsPath → 模拟 FileSystemError）；
   * 优先于 fsTypes，用于权限等非 FileNotFound 失败的形态。
   */
  fsStatErrors: new Map<string, Error & { code?: string }>(),
  /** executeCommand 转发记录（vscode.open / revealFileInOS）。 */
  executedCommands: [] as Array<Array<unknown>>,
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
    showInformationMessage: (message: string) => {
      vscodeMock.information.push(message);
      return Promise.resolve(undefined);
    },
    showWarningMessage: (message: string, ...rest: unknown[]) => {
      vscodeMock.warning.push(message);
      const first = rest[0];
      // 模态确认框（第二参 { modal: true }）与带按钮的非模态警告分开驱动。
      if (first && typeof first === 'object' && 'modal' in (first as Record<string, unknown>)) {
        return Promise.resolve(vscodeMock.confirmResult);
      }
      if (typeof first === 'string' && vscodeMock.conflictWarningPending) {
        return vscodeMock.conflictWarningPending;
      }
      return Promise.resolve(vscodeMock.warningChoice);
    },
    showErrorMessage: () => Promise.resolve(undefined),
    showInputBox: (options: { prompt?: string }) => {
      vscodeMock.inputPrompts.push(options.prompt ?? '');
      const value = vscodeMock.inputQueue.length > 0 ? vscodeMock.inputQueue.shift() : vscodeMock.inputResult;
      return Promise.resolve(value);
    },
    showQuickPick: (items: Array<{ label: string }>, options: { placeHolder?: string }) => {
      vscodeMock.quickPickPlaceholders.push(options?.placeHolder ?? '');
      if (vscodeMock.quickPickChoice === undefined) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(items.find((item) => item.label === vscodeMock.quickPickChoice));
    },
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
    fs: {
      stat: async (uri: { fsPath: string }) => {
        const injected = vscodeMock.fsStatErrors.get(uri.fsPath);
        if (injected) {
          throw injected;
        }
        const type = vscodeMock.fsTypes.get(uri.fsPath);
        if (type === undefined) {
          // 对齐真实宿主行为：路径不存在抛 code 为 FileNotFound 的 FileSystemError。
          throw Object.assign(new Error('EntryNotFound (FileSystemError)'), { code: 'FileNotFound' });
        }
        return { type, ctime: 0, mtime: 0, size: 0 };
      },
    },
  },
  commands: {
    executeCommand: async (command: string, ...args: unknown[]) => {
      vscodeMock.executedCommands.push([command, ...args]);
      return undefined;
    },
  },
  Uri: {
    file: (path: string) => ({ scheme: 'file', path, fsPath: path }),
  },
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  ProgressLocation: { Notification: 15 },
}));

import { commandShowStatus } from '../src/host/commands/showStatus';
import { commandRefreshStatus } from '../src/host/commands/refreshStatus';
import { commandUpdate } from '../src/host/commands/update';
import { commandCleanup } from '../src/host/commands/cleanup';

const makeUri = (fsPath: string): vscode.Uri => ({ fsPath, scheme: 'file' }) as unknown as vscode.Uri;

const channelLines = (): string[] => {
  // 输出按操作域分频道（状态/更新/其它）：聚合全部频道行，断言语义不变。
  const all = vscodeMock.channels.flatMap((ch) => ch.lines);
  if (all.length === 0 && vscodeMock.channels.length === 0) {
    // 保持「频道必须存在」的强断言：命令执行后至少建有一个频道。
    const channel = getOutputChannel();
    if (!channel) {
      throw new Error('输出频道不存在');
    }
  }
  return all;
};

vi.mocked(runStatus).mockResolvedValue({ targetPath: '.', entries: [], externals: [] });
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
  vscodeMock.information.length = 0;
  vscodeMock.confirmResult = undefined;
  vscodeMock.warningChoice = undefined;
  vscodeMock.conflictWarningPending = undefined;
  vscodeMock.inputResult = undefined;
  vscodeMock.inputQueue.length = 0;
  vscodeMock.inputPrompts.length = 0;
  vscodeMock.quickPickChoice = undefined;
  vscodeMock.quickPickPlaceholders.length = 0;
  vscodeMock.fsTypes.clear();
  vscodeMock.fsStatErrors.clear();
  vscodeMock.executedCommands.length = 0;
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
        { path: 'src/a.txt', wcStatus: 'modified', props: 'none', revision: 3, changelist: null },
        { path: 'src/new.txt', wcStatus: 'unversioned', props: 'none', changelist: null },
      ],
      externals: [],
    });

    await commandShowStatus(makeUri(filePath));

    expect(vi.mocked(runStatus)).toHaveBeenCalledWith('svn', 'src/a.txt', expect.objectContaining({ cwd: wcRoot }));
    const output = channelLines().join('\n');
    expect(output).toContain('[modified] src/a.txt');
    expect(output).toContain('[unversioned] src/new.txt');
    expect(vscodeMock.channels.at(-1)?.shown).toBe(1);
  });

  it('干净副本：频道写「无本地变更」', async () => {
    vi.mocked(runStatus).mockResolvedValueOnce({ targetPath: '.', entries: [], externals: [] });
    await commandShowStatus(makeUri(wcRoot));
    expect(channelLines().join('\n')).toContain(strings.status.clean);
  });

  it('纯属性变更：状态行追加「属性修改」注记，不再裸显 normal', async () => {
    vi.mocked(runStatus).mockResolvedValueOnce({
      targetPath: '.',
      entries: [{ path: '.', wcStatus: 'normal', props: 'modified', changelist: null }],
      externals: [],
    });
    await commandShowStatus(makeUri(wcRoot));
    expect(channelLines().join('\n')).toContain('[normal] .（属性修改）');
  });

  it('状态命令向执行层传 onExit（输出频道记录退出码）', async () => {
    vi.mocked(runStatus).mockResolvedValueOnce({ targetPath: '.', entries: [], externals: [] });
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
    vi.mocked(runStatus).mockResolvedValueOnce({ targetPath: '.', entries: [], externals: [] });
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
    vscodeMock.inputResult = 'HEAD';
    vi.mocked(runUpdate).mockResolvedValueOnce({
      stdout: '', stderr: '', exitCode: 0,
      items: [{ status: 'U', path: 'a.txt' }],
      finalRevision: 5,
      conflicts: [],
    });

    await commandUpdate(makeUri(filePath));

    expect(vscodeMock.progressCalls).toEqual([
      strings.update.progressRevision.replace('{target}', filePath).replace('{revision}', 'HEAD'),
    ]);
    // core 的 runUpdate 内部负责 peg 转义，宿主传原始相对目标数组与归一化版本号。
    expect(vi.mocked(runUpdate)).toHaveBeenCalledWith(
      'svn',
      ['a.txt'],
      expect.objectContaining({ cwd: wcRoot }),
      'HEAD',
    );
    const output = channelLines().join('\n');
    expect(output).toContain('update --non-interactive -r HEAD');
    expect(output).toContain('更新完成，当前 revision 5');
  });

  it('输入指定版本号：-r 归一化后传给 core 并回显', async () => {
    const filePath = join(wcRoot, 'a.txt');
    writeFileSync(filePath, 'x');
    vscodeMock.confirmResult = strings.update.confirmButton;
    vscodeMock.inputResult = ' 012 ';
    vi.mocked(runUpdate).mockResolvedValueOnce({
      stdout: '', stderr: '', exitCode: 0,
      items: [], finalRevision: 12, conflicts: [],
    });

    await commandUpdate(makeUri(filePath));

    expect(vi.mocked(runUpdate)).toHaveBeenCalledWith(
      'svn',
      ['a.txt'],
      expect.objectContaining({ cwd: wcRoot }),
      '12',
    );
    expect(channelLines().join('\n')).toContain('update --non-interactive -r 12');
  });

  it('非法版本号提示后重试，合法值才执行更新', async () => {
    const filePath = join(wcRoot, 'a.txt');
    writeFileSync(filePath, 'x');
    vscodeMock.confirmResult = strings.update.confirmButton;
    vscodeMock.inputQueue = ['abc', '0', '-1', '3'];
    vi.mocked(runUpdate).mockResolvedValueOnce({
      stdout: '', stderr: '', exitCode: 0,
      items: [], finalRevision: 3, conflicts: [],
    });

    await commandUpdate(makeUri(filePath));

    expect(vscodeMock.warning.filter((m) => m === strings.update.revisionInvalid)).toHaveLength(3);
    expect(vscodeMock.inputPrompts).toHaveLength(4);
    expect(vi.mocked(runUpdate)).toHaveBeenCalledWith(
      'svn',
      ['a.txt'],
      expect.objectContaining({ cwd: wcRoot }),
      '3',
    );
  });

  it('资源管理器多选批量：第二参数 Uri[] 去重嵌套只保留最外层，一次携带多目标', async () => {
    const d1 = join(wcRoot, 'd1');
    const d2 = join(wcRoot, 'd2');
    mkdirSync(d1, { recursive: true });
    mkdirSync(d2, { recursive: true });
    writeFileSync(join(d1, 'a.txt'), 'x');
    vscodeMock.confirmResult = strings.update.confirmButton;
    vscodeMock.inputResult = 'HEAD';
    vi.mocked(runUpdate).mockResolvedValueOnce({
      stdout: '', stderr: '', exitCode: 0,
      items: [], finalRevision: 7, conflicts: [],
    });

    // 选区含嵌套（d1/a.txt、d1 内层）与并列目标 d2：去重后只剩 d1、d2。
    await commandUpdate(
      makeUri(join(d1, 'a.txt')),
      [makeUri(join(d1, 'a.txt')), makeUri(d1), makeUri(join(d1, 'sub')), makeUri(d2)],
    );

    // 确认框列出全部去重后目标，嵌套内层不出现。
    expect(vscodeMock.warning[0]).toContain(d1);
    expect(vscodeMock.warning[0]).toContain(d2);
    expect(vscodeMock.warning[0]).not.toContain(join(d1, 'a.txt'));
    expect(vi.mocked(runUpdate)).toHaveBeenCalledWith(
      'svn',
      ['d1', 'd2'],
      expect.objectContaining({ cwd: wcRoot }),
      'HEAD',
    );
  });

  it('多目标更新多段 revision：频道汇总逐个列出，不折叠为最后值', async () => {
    const d1 = join(wcRoot, 'd1');
    const d2 = join(wcRoot, 'd2');
    mkdirSync(d1, { recursive: true });
    mkdirSync(d2, { recursive: true });
    vscodeMock.confirmResult = strings.update.confirmButton;
    vscodeMock.inputResult = 'HEAD';
    vi.mocked(runUpdate).mockResolvedValueOnce({
      stdout: '', stderr: '', exitCode: 0,
      items: [], finalRevision: 7, finalRevisions: [5, 7], conflicts: [],
    });

    await commandUpdate(makeUri(d1), [makeUri(d1), makeUri(d2)]);

    const output = channelLines().join('\n');
    expect(output).toContain(format(strings.update.doneRevisions, { revisions: '5、7' }));
  });

  it('多目标更新 revision 全部相同：汇总折叠为单值文案', async () => {
    const d1 = join(wcRoot, 'd1');
    const d2 = join(wcRoot, 'd2');
    mkdirSync(d1, { recursive: true });
    mkdirSync(d2, { recursive: true });
    vscodeMock.confirmResult = strings.update.confirmButton;
    vscodeMock.inputResult = 'HEAD';
    vi.mocked(runUpdate).mockResolvedValueOnce({
      stdout: '', stderr: '', exitCode: 0,
      items: [], finalRevision: 7, finalRevisions: [7, 7], conflicts: [],
    });

    await commandUpdate(makeUri(d1), [makeUri(d1), makeUri(d2)]);

    const output = channelLines().join('\n');
    expect(output).toContain(format(strings.update.done, { revision: '7' }));
    expect(output).not.toContain(strings.update.doneRevisions.split('{revisions')[0]);
  });

  it('版本号输入取消（Esc）：不执行更新', async () => {
    const filePath = join(wcRoot, 'a.txt');
    writeFileSync(filePath, 'x');
    vscodeMock.confirmResult = strings.update.confirmButton;
    vscodeMock.inputResult = undefined;

    await commandUpdate(makeUri(filePath));

    expect(vi.mocked(runUpdate)).not.toHaveBeenCalled();
    expect(vscodeMock.progressCalls).toHaveLength(0);
  });

  it('模态确认取消：不弹版本号输入框，不执行更新', async () => {
    const filePath = join(wcRoot, 'a.txt');
    writeFileSync(filePath, 'x');
    vscodeMock.confirmResult = undefined;

    await commandUpdate(makeUri(filePath));

    expect(vscodeMock.inputPrompts).toHaveLength(0);
    expect(vi.mocked(runUpdate)).not.toHaveBeenCalled();
    expect(vscodeMock.progressCalls).toHaveLength(0);
  });

  it('更新产生冲突：频道汇总 revision，弹冲突警告列出文件', async () => {
    const filePath = join(wcRoot, 'a.txt');
    writeFileSync(filePath, 'x');
    vscodeMock.confirmResult = strings.update.confirmButton;
    vscodeMock.inputResult = 'HEAD';
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

  it('冲突提示点「打开冲突文件」：文件在编辑器打开（vscode.open）', async () => {
    const filePath = join(wcRoot, 'a.txt');
    writeFileSync(filePath, 'x');
    vscodeMock.confirmResult = strings.update.confirmButton;
    vscodeMock.inputResult = 'HEAD';
    vscodeMock.warningChoice = strings.update.openConflictButton;
    vscodeMock.fsTypes.set(filePath, 1 /* FileType.File */);
    vi.mocked(runUpdate).mockResolvedValueOnce({
      stdout: '', stderr: '', exitCode: 0,
      items: [{ status: 'C', path: 'a.txt' }],
      finalRevision: 6,
      conflicts: ['a.txt'],
    });

    await commandUpdate(makeUri(filePath));

    expect(vscodeMock.executedCommands).toContainEqual([
      'vscode.open',
      { scheme: 'file', path: filePath, fsPath: filePath },
      { preview: false },
    ]);
  });

  it('多个冲突先选文件再打开：QuickPick 按冲突路径选择', async () => {
    const filePath = join(wcRoot, 'b.txt');
    writeFileSync(filePath, 'x');
    vscodeMock.confirmResult = strings.update.confirmButton;
    vscodeMock.inputResult = 'HEAD';
    vscodeMock.warningChoice = strings.update.openConflictButton;
    vscodeMock.quickPickChoice = 'b.txt';
    vscodeMock.fsTypes.set(join(wcRoot, 'a.txt'), 1);
    vscodeMock.fsTypes.set(filePath, 1);
    vi.mocked(runUpdate).mockResolvedValueOnce({
      stdout: '', stderr: '', exitCode: 0,
      items: [],
      finalRevision: 6,
      conflicts: ['a.txt', 'b.txt'],
    });

    await commandUpdate(makeUri(join(wcRoot, 'a.txt')));

    expect(vscodeMock.quickPickPlaceholders).toEqual([strings.update.conflictPickPlaceholder]);
    expect(vscodeMock.executedCommands).toContainEqual([
      'vscode.open',
      { scheme: 'file', path: filePath, fsPath: filePath },
      { preview: false },
    ]);
  });

  it('树冲突目标是目录：在系统文件管理器定位（revealFileInOS）', async () => {
    const dirPath = join(wcRoot, 'dir');
    mkdirSync(dirPath);
    vscodeMock.confirmResult = strings.update.confirmButton;
    vscodeMock.inputResult = 'HEAD';
    vscodeMock.warningChoice = strings.update.openConflictButton;
    vscodeMock.fsTypes.set(dirPath, 2 /* FileType.Directory */);
    vi.mocked(runUpdate).mockResolvedValueOnce({
      stdout: '', stderr: '', exitCode: 0,
      items: [],
      finalRevision: 6,
      conflicts: ['dir'],
    });

    await commandUpdate(makeUri(wcRoot));

    expect(vscodeMock.executedCommands).toContainEqual([
      'revealFileInOS',
      { scheme: 'file', path: dirPath, fsPath: dirPath },
    ]);
  });

  it('冲突文件本地已缺失：给出提示不报错', async () => {
    vscodeMock.confirmResult = strings.update.confirmButton;
    vscodeMock.inputResult = 'HEAD';
    vscodeMock.warningChoice = strings.update.openConflictButton;
    vi.mocked(runUpdate).mockResolvedValueOnce({
      stdout: '', stderr: '', exitCode: 0,
      items: [],
      finalRevision: 6,
      conflicts: ['gone.txt'],
    });

    await commandUpdate(makeUri(wcRoot));

    expect(vscodeMock.executedCommands).toHaveLength(0);
    // stat 抛 FileNotFound 形态的 FileSystemError 时走「本地文件不存在」文案。
    expect(vscodeMock.information).toContain(
      format(strings.update.conflictMissingLocal, { path: 'gone.txt' }),
    );
  });

  it('冲突路径 stat 因权限等失败：提示无法访问并附原因，不误述为文件不存在', async () => {
    const lockedPath = join(wcRoot, 'locked.txt');
    writeFileSync(lockedPath, 'x');
    vscodeMock.confirmResult = strings.update.confirmButton;
    vscodeMock.inputResult = 'HEAD';
    vscodeMock.warningChoice = strings.update.openConflictButton;
    vscodeMock.fsStatErrors.set(
      lockedPath,
      Object.assign(new Error('Permission denied (FileSystemError)'), { code: 'NoPermissions' }),
    );
    vi.mocked(runUpdate).mockResolvedValueOnce({
      stdout: '', stderr: '', exitCode: 0,
      items: [],
      finalRevision: 6,
      conflicts: ['locked.txt'],
    });

    await commandUpdate(makeUri(wcRoot));

    expect(vscodeMock.executedCommands).toHaveLength(0);
    expect(vscodeMock.information).not.toContain(
      format(strings.update.conflictMissingLocal, { path: 'locked.txt' }),
    );
    expect(
      vscodeMock.information.some(
        (m) => m.includes('locked.txt') && m.includes('无法访问') && m.includes('Permission denied'),
      ),
    ).toBe(true);
  });

  it('冲突通知等待用户处理期间不持有副本互斥锁：同副本清理可立即执行', async () => {
    const filePath = join(wcRoot, 'a.txt');
    writeFileSync(filePath, 'x');
    vscodeMock.confirmResult = strings.update.confirmButton;
    vscodeMock.inputResult = 'HEAD';
    // 冲突警告挂起：模拟带按钮通知已弹出、用户尚未处理。
    let settleWarning: (value: string | undefined) => void = () => {};
    vscodeMock.conflictWarningPending = new Promise((resolve) => {
      settleWarning = resolve;
    });
    vi.mocked(runUpdate).mockResolvedValueOnce({
      stdout: '', stderr: '', exitCode: 0,
      items: [{ status: 'C', path: 'a.txt' }],
      finalRevision: 6,
      conflicts: ['a.txt'],
    });

    const updating = commandUpdate(makeUri(filePath));
    // 等待更新完成、冲突警告已弹出（挂起中）。
    await vi.waitFor(() => {
      expect(vscodeMock.warning.some((m) => m.includes('1 个冲突'))).toBe(true);
    });

    // 同一副本的清理命令不被「工作副本有未完成操作」拒绝，正常执行 svn cleanup
    // （断言用完整前缀，避免误命中 cleanup 确认框自身的「未完成操作日志」文案）。
    vscodeMock.confirmResult = strings.cleanup.confirmButton;
    const runCallsBefore = vi.mocked(runOrThrow).mock.calls.length;
    const warningBeforeCleanup = vscodeMock.warning.length;
    await commandCleanup(makeUri(wcRoot));
    expect(vi.mocked(runOrThrow).mock.calls.length).toBeGreaterThan(runCallsBefore);
    expect(
      vscodeMock.warning.slice(warningBeforeCleanup).some((m) => m.includes('工作副本有未完成操作')),
    ).toBe(false);
    expect(channelLines().join('\n')).toContain(strings.cleanup.done);

    // 用户关闭冲突通知后更新命令正常收尾。
    settleWarning(undefined);
    await updating;
  });

  it('svn 失败（SvnError CANCELLED 以外的取消由进度触发）：异常向上传播交给统一收口', async () => {
    const filePath = join(wcRoot, 'a.txt');
    writeFileSync(filePath, 'x');
    vscodeMock.confirmResult = strings.update.confirmButton;
    vscodeMock.inputResult = 'HEAD';
    vi.mocked(runUpdate).mockRejectedValueOnce(
      new SvnError({ message: '已被取消', command: ['update'], code: 'CANCELLED' }),
    );

    await expect(commandUpdate(makeUri(filePath))).rejects.toBeInstanceOf(SvnError);
  });
});

describe('commandCleanup（清理）', () => {
  it('模态确认后执行 cleanup：目标转义、频道写完成行', async () => {
    const filePath = join(wcRoot, 'dir@2');
    mkdirSync(join(wcRoot, 'dir@2'));
    vscodeMock.confirmResult = strings.cleanup.confirmButton;
    vi.mocked(runOrThrow).mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    await commandCleanup(makeUri(filePath));

    expect(vscodeMock.warning.some((m) => m.includes('svn cleanup'))).toBe(true);
    expect(vscodeMock.progressCalls).toEqual([strings.cleanup.progress.replace('{target}', filePath)]);
    expect(vi.mocked(runOrThrow)).toHaveBeenCalledWith(
      'svn',
      ['cleanup', 'dir@2@'],
      expect.objectContaining({ cwd: wcRoot }),
    );
    expect(channelLines().join('\n')).toContain(strings.cleanup.done);
  });

  it('模态确认取消：不执行 cleanup', async () => {
    vscodeMock.confirmResult = undefined;
    const before = vi.mocked(runOrThrow).mock.calls.length;
    await commandCleanup(makeUri(wcRoot));
    expect(vi.mocked(runOrThrow).mock.calls.length).toBe(before);
    expect(vscodeMock.progressCalls).toHaveLength(0);
  });

  it('svn 失败：异常向上传播交给统一收口', async () => {
    vscodeMock.confirmResult = strings.cleanup.confirmButton;
    vi.mocked(runOrThrow).mockRejectedValueOnce(
      new SvnError({ message: 'svn: E155007: 出错', command: ['cleanup'], code: 'E155007' }),
    );
    await expect(commandCleanup(makeUri(wcRoot))).rejects.toBeInstanceOf(SvnError);
  });
});
