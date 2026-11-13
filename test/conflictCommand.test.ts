/**
 * P7 冲突命令入口（commands/conflicts.ts）单测：
 * - 本地目标解析：工作副本内文件/目录、missing 路径、符号链接、非副本；
 * - 入口来源：资源管理器右键 / 活动编辑器 / 文件选择框，取消静默；
 * - openConflictTarget 的注入点与「面板未接入」提示；
 * - 命令注册与二次激活句柄释放；定位日志写入 conflict 输出频道。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

const vscodeMock = vi.hoisted(() => ({
  channels: [] as Array<{ title: string; lines: string[]; shown: number }>,
  information: [] as string[],
  warning: [] as string[],
  errors: [] as string[],
  openDialogCalls: 0,
  openDialogResult: undefined as Array<{ fsPath: string }> | undefined,
  activeTextEditor: undefined as { document: { uri: { scheme: string; fsPath: string } } } | undefined,
  registered: [] as Array<{ id: string; handler: (uri?: unknown) => unknown; disposable: { disposed: boolean; dispose: () => void } }>,
  activeCommandIds: new Set<string>(),
}));

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: (title: string) => {
      const channel = {
        title,
        lines: [] as string[],
        shown: 0,
        appendLine(line: string) {
          channel.lines.push(line);
        },
        show() {
          channel.shown += 1;
        },
        dispose() {},
      };
      vscodeMock.channels.push(channel);
      return channel;
    },
    showInformationMessage: (message: string) => {
      vscodeMock.information.push(message);
      return Promise.resolve(undefined);
    },
    showWarningMessage: (message: string) => {
      vscodeMock.warning.push(message);
      return Promise.resolve(undefined);
    },
    showErrorMessage: (message: string) => {
      vscodeMock.errors.push(message);
      return Promise.resolve(undefined);
    },
    showOpenDialog: () => {
      vscodeMock.openDialogCalls += 1;
      return Promise.resolve(vscodeMock.openDialogResult);
    },
    get activeTextEditor() {
      return vscodeMock.activeTextEditor;
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => (key === 'showOutputOnError' ? true : fallback),
    }),
  },
  commands: {
    registerCommand: (id: string, handler: (uri?: unknown) => unknown) => {
      if (vscodeMock.activeCommandIds.has(id)) {
        throw new Error(`command '${id}' already exists`);
      }
      vscodeMock.activeCommandIds.add(id);
      const disposable = {
        disposed: false,
        dispose() {
          vscodeMock.activeCommandIds.delete(id);
          disposable.disposed = true;
        },
      };
      vscodeMock.registered.push({ id, handler, disposable });
      return disposable;
    },
  },
}));

import { disposeOutputChannel, getOutputChannel, resetOutputState } from '../src/host/output';
import { strings } from '../src/host/i18n';
import {
  commandScanConflicts,
  disposeScanConflictsCommandForTest,
  openConflictTarget,
  registerScanConflictsCommand,
  resolveLocalConflictTarget,
  setConflictPanelOpener,
  type ConflictOpenTarget,
} from '../src/host/commands/conflicts';

const makeUri = (fsPath: string): vscode.Uri => ({ fsPath, scheme: 'file' }) as unknown as vscode.Uri;

const makeWorkingCopy = (dir: string): void => {
  mkdirSync(join(dir, '.svn'), { recursive: true });
  writeFileSync(join(dir, '.svn', 'wc.db'), 'fake');
};

let wcRoot = '';
let plainDir = '';
let context: vscode.ExtensionContext;

beforeEach(() => {
  disposeOutputChannel();
  resetOutputState();
  disposeScanConflictsCommandForTest();
  vscodeMock.channels.length = 0;
  vscodeMock.information.length = 0;
  vscodeMock.warning.length = 0;
  vscodeMock.errors.length = 0;
  vscodeMock.openDialogCalls = 0;
  vscodeMock.openDialogResult = undefined;
  vscodeMock.activeTextEditor = undefined;
  vscodeMock.registered.length = 0;
  vscodeMock.activeCommandIds.clear();
  context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
  // macOS tmpdir 是符号链接，findWorkingCopy 返回 realpath 后的路径。
  wcRoot = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-conflict-cmd-')));
  makeWorkingCopy(wcRoot);
  plainDir = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-conflict-plain-')));
});

afterEach(() => {
  rmSync(wcRoot, { recursive: true, force: true });
  rmSync(plainDir, { recursive: true, force: true });
  setConflictPanelOpener(undefined);
  disposeScanConflictsCommandForTest();
});

describe('resolveLocalConflictTarget', () => {
  it('副本内文件与目录都定位到副本根，缺失路径回退到最近存在父目录', () => {
    const file = join(wcRoot, 'sub', 'file.txt');
    mkdirSync(join(wcRoot, 'sub'), { recursive: true });
    writeFileSync(file, 'x');
    expect(resolveLocalConflictTarget(file)).toEqual({
      status: 'ok',
      wcRoot,
      localPath: file,
    });
    expect(resolveLocalConflictTarget(join(wcRoot, 'sub'))).toEqual({
      status: 'ok',
      wcRoot,
      localPath: join(wcRoot, 'sub'),
    });
    expect(resolveLocalConflictTarget(join(wcRoot, 'missing', 'gone.txt'))).toEqual({
      status: 'ok',
      wcRoot,
      localPath: join(wcRoot, 'missing', 'gone.txt'),
    });
  });

  it('经符号链接访问时归一为真实副本根；非副本返回 notWorkingCopy', () => {
    const alias = join(plainDir, 'alias');
    symlinkSync(wcRoot, alias, 'dir');
    const file = join(wcRoot, 'file.txt');
    writeFileSync(file, 'x');
    expect(resolveLocalConflictTarget(join(alias, 'file.txt'))).toEqual({
      status: 'ok',
      wcRoot,
      localPath: join(alias, 'file.txt'),
    });
    expect(resolveLocalConflictTarget(plainDir)).toEqual({ status: 'notWorkingCopy' });
  });
});

describe('commandScanConflicts 入口', () => {
  it('资源管理器 uri：解析副本根后交给注入的 P7 打开器（整副本范围）', async () => {
    const received: ConflictOpenTarget[] = [];
    setConflictPanelOpener((target) => {
      received.push(target);
    });
    const file = join(wcRoot, 'file.txt');
    writeFileSync(file, 'x');
    await commandScanConflicts(makeUri(file));
    expect(received).toEqual([{
      source: 'local',
      wcRoot,
      scopeRelPath: '.',
      localPath: file,
    }]);
    expect(vscodeMock.information).toHaveLength(0);
  });

  it('不在副本内：信息提示，不调用打开器', async () => {
    const received: ConflictOpenTarget[] = [];
    setConflictPanelOpener((target) => {
      received.push(target);
    });
    await commandScanConflicts(makeUri(plainDir));
    expect(received).toEqual([]);
    expect(vscodeMock.information).toEqual([strings.conflictCommand.notWorkingCopy]);
  });

  it('无 uri：活动编辑器 file 文档可用；untitled 走文件选择框；取消静默', async () => {
    const received: ConflictOpenTarget[] = [];
    setConflictPanelOpener((target) => {
      received.push(target);
    });
    const openPath = join(wcRoot, 'open.ts');
    writeFileSync(openPath, 'x');
    vscodeMock.activeTextEditor = { document: { uri: { scheme: 'file', fsPath: openPath } } };
    await commandScanConflicts(undefined);
    expect(received[0]?.source).toBe('local');
    expect(vscodeMock.openDialogCalls).toBe(0);

    received.length = 0;
    vscodeMock.activeTextEditor = { document: { uri: { scheme: 'untitled', fsPath: 'Untitled-1' } } };
    await commandScanConflicts(undefined);
    expect(vscodeMock.openDialogCalls).toBe(1);
    expect(received).toEqual([]);

    vscodeMock.openDialogResult = [{ fsPath: openPath }];
    await commandScanConflicts(undefined);
    expect(received).toHaveLength(1);
  });

  it('定位日志写入 conflict 输出频道', async () => {
    setConflictPanelOpener(() => undefined);
    const file = join(wcRoot, 'file.txt');
    writeFileSync(file, 'x');
    await commandScanConflicts(makeUri(file));
    const channel = getOutputChannel('conflict');
    expect(channel).toBeDefined();
    const lines = (channel as unknown as { lines: string[] }).lines.join('\n');
    expect(lines).toContain(wcRoot);
    expect(lines).toContain(strings.command.scanConflicts);
  });
});

describe('openConflictTarget 注入点', () => {
  it('面板未接入：写日志并提示，不静默吞掉动作', async () => {
    await openConflictTarget({ source: 'local', wcRoot, scopeRelPath: '.' });
    expect(vscodeMock.information).toEqual([strings.conflictCommand.panelNotReady]);
    const channel = getOutputChannel('conflict');
    const lines = (channel as unknown as { lines: string[] }).lines.join('\n');
    expect(lines).toContain(strings.conflictCommand.panelNotReady);
  });

  it('更新任务交接目标原样透传（含任务范围）', async () => {
    const received: ConflictOpenTarget[] = [];
    setConflictPanelOpener((target) => {
      received.push(target);
    });
    const taskContext = { requestedRevision: 5, wcRoot };
    await openConflictTarget({ source: 'update', wcRoot, scopeRelPath: 'sub/dir', taskContext });
    expect(received).toEqual([{ source: 'update', wcRoot, scopeRelPath: 'sub/dir', taskContext }]);
  });
});

describe('registerScanConflictsCommand', () => {
  it('注册命令并挂到 context.subscriptions；二次注册先释放旧句柄', () => {
    registerScanConflictsCommand(context);
    expect(vscodeMock.registered.map((entry) => entry.id)).toEqual(['svnAnywhere.scanConflicts']);
    expect(context.subscriptions).toHaveLength(1);
    const first = vscodeMock.registered[0]!.disposable;
    expect(() => registerScanConflictsCommand(context)).not.toThrow();
    expect(first.disposed).toBe(true);
    expect(vscodeMock.activeCommandIds.size).toBe(1);
  });

  it('注册后的命令回调执行入口解析（handler 经统一错误收口）', async () => {
    const received: ConflictOpenTarget[] = [];
    setConflictPanelOpener((target) => {
      received.push(target);
    });
    registerScanConflictsCommand(context);
    const file = join(wcRoot, 'file.txt');
    writeFileSync(file, 'x');
    await vscodeMock.registered[0]!.handler(makeUri(file));
    expect(received).toHaveLength(1);
    expect(vscodeMock.errors).toHaveLength(0);
  });
});
