/**
 * 命令统一入口与错误处理的宿主侧单测：mock vscode 模块，
 * 覆盖目标解析的来源回退与取消、工作副本提示、统一错误收口、
 * 以及同一实例二次注册命令的句柄释放。
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

const vscodeMock = vi.hoisted(() => ({
  channels: [] as Array<{ lines: string[]; shown: number; appendLine: (l: string) => void; show: () => void; dispose: () => void }>,
  information: [] as string[],
  warning: [] as string[],
  error: [] as Array<unknown[]>,
  errorMessageResult: undefined as string | undefined,
  openDialogCalls: 0,
  openDialogResult: undefined as Array<{ fsPath: string }> | undefined,
  activeTextEditor: undefined as { document: { uri: { scheme: string; fsPath: string } } } | undefined,
  showOutputOnError: true,
  registered: [] as Array<{ id: string; handler: (uri?: unknown) => unknown; disposable: { disposed: boolean; dispose: () => void } }>,
  activeCommandIds: new Set<string>(),
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
    showWarningMessage: (message: string) => {
      vscodeMock.warning.push(message);
      return Promise.resolve(undefined);
    },
    showErrorMessage: (message: string, item?: string) => {
      vscodeMock.error.push([message, item]);
      return Promise.resolve(vscodeMock.errorMessageResult);
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
      get: (key: string, fallback: unknown) =>
        key === 'showOutputOnError' ? vscodeMock.showOutputOnError : fallback,
    }),
  },
  commands: {
    // 模拟真实 VSCode：重复注册同一命令 ID 抛 already exists，dispose 后可重新注册。
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

import { SvnError, tailText } from '../src/core/errors';
import { resetOutputState, disposeOutputChannel, getOutputChannel } from '../src/host/output';
import { registerCommand, showCommandError } from '../src/host/commands/registry';
import { registerAllCommands } from '../src/host/commands';
import { resolveBatchTargetGroups, resolveWorkingCopyTarget } from '../src/host/commands/target';
import { strings } from '../src/host/i18n';

const makeUri = (fsPath: string): vscode.Uri => ({ fsPath, scheme: 'file' }) as unknown as vscode.Uri;

/** mock 频道的行缓冲取用；getOutputChannel 返回可空，断言前提是频道存在。 */
const channelLines = (): string[] => {
  const channel = getOutputChannel();
  if (!channel) {
    throw new Error('输出频道不存在（可能已 dispose）');
  }
  return (channel as unknown as { lines: string[] }).lines;
};

const makeWorkingCopy = (dir: string): void => {
  mkdirSync(join(dir, '.svn'), { recursive: true });
  writeFileSync(join(dir, '.svn', 'wc.db'), 'fake');
};

/** 等待错误处理的异步链（showErrorMessage promise 与按钮回调）落定。 */
const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let wcRoot = '';
let plainDir = '';
let context: vscode.ExtensionContext;

beforeEach(() => {
  disposeOutputChannel();
  resetOutputState();
  vscodeMock.channels.length = 0;
  vscodeMock.information.length = 0;
  vscodeMock.warning.length = 0;
  vscodeMock.error.length = 0;
  vscodeMock.errorMessageResult = undefined;
  vscodeMock.openDialogCalls = 0;
  vscodeMock.openDialogResult = undefined;
  vscodeMock.activeTextEditor = undefined;
  vscodeMock.showOutputOnError = true;
  vscodeMock.registered.length = 0;
  vscodeMock.activeCommandIds.clear();
  context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
  // macOS 的 tmpdir 是符号链接，findWorkingCopy 返回 realpath 后路径，这里同样解析。
  wcRoot = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-cmd-')));
  makeWorkingCopy(wcRoot);
  plainDir = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-plain-')));
});

afterEach(() => {
  rmSync(wcRoot, { recursive: true, force: true });
  rmSync(plainDir, { recursive: true, force: true });
});

describe('resolveWorkingCopyTarget', () => {
  it('右键 uri 在工作副本内：定位成功并写入定位日志，不弹提示', async () => {
    const filePath = join(wcRoot, 'file.txt');
    writeFileSync(filePath, 'x');
    const target = await resolveWorkingCopyTarget(makeUri(filePath), strings.command.update);
    expect(target?.wcRoot).toBe(wcRoot);
    expect(target?.targetPath).toBe(filePath);
    expect(vscodeMock.information).toHaveLength(0);
    expect(channelLines().join('\n')).toContain(wcRoot);
  });

  it('副本经符号链接访问时单选和多选均归一目标，missing 与符号链接项保留身份', async () => {
    const alias = join(plainDir, 'alias');
    symlinkSync(wcRoot, alias, 'dir');
    writeFileSync(join(wcRoot, 'file.txt'), 'x');
    symlinkSync('file.txt', join(wcRoot, 'link.txt'));
    const file = await resolveWorkingCopyTarget(makeUri(join(alias, 'file.txt')), strings.command.commit);
    expect(file).toEqual({ wcRoot, targetPath: join(wcRoot, 'file.txt') });
    const groups = resolveBatchTargetGroups(
      [makeUri(join(alias, 'missing', 'gone.txt')), makeUri(join(alias, 'link.txt'))],
      strings.command.commit,
    );
    expect(groups).toEqual([{ wcRoot, targetPaths: [join(wcRoot, 'missing', 'gone.txt'), join(wcRoot, 'link.txt')] }]);
    expect((await resolveWorkingCopyTarget(makeUri(alias), strings.command.commit))?.targetPath).toBe(wcRoot);
  });

  it('右键 uri 不在任何副本内：弹信息提示，返回 undefined', async () => {
    const target = await resolveWorkingCopyTarget(makeUri(plainDir), strings.command.update);
    expect(target).toBeUndefined();
    expect(vscodeMock.information).toEqual([strings.error.notWorkingCopy]);
  });

  it('无 uri 且无活动编辑器：走文件选择框，用户取消时静默返回', async () => {
    const target = await resolveWorkingCopyTarget(undefined, strings.command.update);
    expect(vscodeMock.openDialogCalls).toBe(1);
    expect(target).toBeUndefined();
    expect(vscodeMock.information).toHaveLength(0);
  });

  it('无 uri 且活动编辑器是 file 文档：直接用编辑器路径，不弹对话框', async () => {
    const openPath = join(wcRoot, 'open.ts');
    writeFileSync(openPath, 'x');
    vscodeMock.activeTextEditor = { document: { uri: { scheme: 'file', fsPath: openPath } } };
    const target = await resolveWorkingCopyTarget(undefined, strings.command.update);
    expect(target?.targetPath).toBe(openPath);
    expect(vscodeMock.openDialogCalls).toBe(0);
  });

  it('活动编辑器是 untitled 文档：跳过编辑器，走文件选择框', async () => {
    vscodeMock.activeTextEditor = { document: { uri: { scheme: 'untitled', fsPath: 'Untitled-1' } } };
    await resolveWorkingCopyTarget(undefined, strings.command.update);
    expect(vscodeMock.openDialogCalls).toBe(1);
  });

  it('文件选择框选中副本内路径：定位成功', async () => {
    const pickedPath = join(wcRoot, 'picked.txt');
    writeFileSync(pickedPath, 'x');
    vscodeMock.openDialogResult = [{ fsPath: pickedPath }];
    const target = await resolveWorkingCopyTarget(undefined, strings.command.update);
    expect(target?.wcRoot).toBe(wcRoot);
  });
});

describe('registerCommand 统一错误处理', () => {
  it('注册命令并挂到 context.subscriptions', () => {
    const disposable = registerCommand(context, 'svnAnywhere.update', () => undefined);
    expect(vscodeMock.registered.map((r) => r.id)).toEqual(['svnAnywhere.update']);
    expect(context.subscriptions).toEqual([disposable]);
  });

  it('handler 正常完成：不弹任何错误', async () => {
    registerCommand(context, 'svnAnywhere.update', () => Promise.resolve());
    await vscodeMock.registered[0]?.handler();
    expect(vscodeMock.error).toHaveLength(0);
    expect(vscodeMock.warning).toHaveLength(0);
  });

  it('handler 同步抛错：进统一收口，不向调用方冒泡', async () => {
    registerCommand(context, 'svnAnywhere.update', () => {
      throw new Error('同步失败');
    });
    await expect(vscodeMock.registered[0]?.handler()).resolves.toBeUndefined();
    expect(vscodeMock.error).toEqual([['同步失败', strings.error.buttonShowOutput]]);
  });

  it('handler 返回 rejected promise：同样进统一收口', async () => {
    registerCommand(context, 'svnAnywhere.cleanup', () => Promise.reject(new Error('异步失败')));
    await expect(vscodeMock.registered[0]?.handler()).resolves.toBeUndefined();
    expect(vscodeMock.error).toEqual([['异步失败', strings.error.buttonShowOutput]]);
  });

  it('用户取消（CANCELLED）：静默返回，不输出错误', async () => {
    registerCommand(context, 'svnAnywhere.update', () => {
      throw new SvnError({ message: '操作已取消', command: ['update'], code: 'CANCELLED' });
    });
    await vscodeMock.registered[0]?.handler();
    expect(vscodeMock.error).toHaveLength(0);
    expect(vscodeMock.warning).toHaveLength(0);
    expect(channelLines()).toHaveLength(0);
  });

  it('svn 缺失（ENOENT）：警告提示指向配置项，不弹错误框', async () => {
    registerCommand(context, 'svnAnywhere.update', () => {
      throw new SvnError({ message: 'spawn svn ENOENT', command: ['update'], code: 'ENOENT' });
    });
    await vscodeMock.registered[0]?.handler();
    expect(vscodeMock.warning).toEqual([strings.activation.svnMissing]);
    expect(vscodeMock.error).toHaveLength(0);
  });

  it('业务失败：弹首行摘要并附「显示输出」，完整 stderr 进输出频道，自动切输出面板', async () => {
    const stderr = 'svn: E170001: 认证失败\n附加上下文行';
    registerCommand(context, 'svnAnywhere.commit', () => {
      throw new SvnError({ message: 'svn: E170001: 认证失败', command: ['commit'], stderr, code: 'E170001' });
    });
    await vscodeMock.registered[0]?.handler();
    expect(vscodeMock.error).toEqual([['svn: E170001: 认证失败', strings.error.buttonShowOutput]]);
    const lines = channelLines().join('\n');
    expect(lines).toContain('svn: E170001: 认证失败');
    expect(lines).toContain('附加上下文行');
    expect(vscodeMock.channels.at(-1)?.shown).toBeGreaterThanOrEqual(1);
  });

  it('超长 stderr：频道只写一次完整 stderr，弹窗摘要为首行截短版', async () => {
    // 模拟 assertSuccess 的真实构造：message 与 stderr 各自经 tailText 截断，
    // 长输出下二者内容不再相等，去重不能依赖字符串比较。
    const stderr = `svn: E170001: 认证失败\n${'x'.repeat(200 * 1024)}\nsvn: E999999: 尾部唯一标记`;
    registerCommand(context, 'svnAnywhere.commit', () => {
      throw new SvnError({
        message: tailText(stderr.trim()),
        command: ['commit'],
        stderr: tailText(stderr),
        exitCode: 1,
        code: 'E170001',
      });
    });
    await vscodeMock.registered[0]?.handler();
    const lines = channelLines();
    expect(lines.filter((l) => l.includes('尾部唯一标记'))).toHaveLength(1);
    // 摘要行只是截短的首行：频道总量远小于「message 全文 + stderr」的重复堆积。
    const totalChars = lines.reduce((sum, l) => sum + l.length, 0);
    expect(totalChars).toBeLessThan(12 * 1024);
    const expectedSummary = `…（前文已截断）${'x'.repeat(300 - '…（前文已截断）'.length)}…`;
    expect(vscodeMock.error[0]?.[0]).toBe(expectedSummary);
  });

  it('点击「显示输出」按钮后聚焦输出频道', async () => {
    vscodeMock.errorMessageResult = strings.error.buttonShowOutput;
    showCommandError(new SvnError({ message: 'svn: E155007: 出错', command: ['info'], code: 'E155007' }));
    await flushAsync();
    expect(vscodeMock.error).toHaveLength(1);
    expect(vscodeMock.channels.at(-1)?.shown).toBe(2);
  });

  it('showOutputOnError 关闭时：只弹摘要，不自动切输出面板', async () => {
    vscodeMock.showOutputOnError = false;
    showCommandError(new SvnError({ message: 'svn: E155007: 出错', command: ['info'], code: 'E155007' }));
    await flushAsync();
    expect(vscodeMock.error).toHaveLength(1);
    expect(vscodeMock.channels.at(-1)?.shown).toBe(0);
  });

  it('输出频道已 dispose：错误处理不抛错，不重建频道，错误框仍弹出', async () => {
    getOutputChannel();
    disposeOutputChannel();
    const channelCount = vscodeMock.channels.length;
    showCommandError(new Error('停用后的错误'));
    await flushAsync();
    expect(vscodeMock.channels).toHaveLength(channelCount);
    expect(vscodeMock.error).toEqual([['停用后的错误', strings.error.buttonShowOutput]]);
  });

  it('非 SvnError 的异常：弹原错误消息，写入频道', async () => {
    showCommandError(new Error('意外失败'));
    await flushAsync();
    expect(vscodeMock.error).toEqual([['意外失败', strings.error.buttonShowOutput]]);
    expect(channelLines().join('\n')).toContain('意外失败');
  });
});

describe('registerAllCommands 二次激活', () => {
  it('同一实例二次注册：先释放上次句柄再重新注册，不触发重复 ID 报错', async () => {
    const globalState = {
      get: (_key: string, defaultValue?: unknown) => defaultValue,
      update: async () => undefined,
    };
    // registerAllCommands 已 async 化（首载折算 + 孤儿快照清理先于命令注册）：
    // 必须 await 后断言，同步断言会拿到未完成的注册计数。
    const firstContext = { subscriptions: [], globalState } as unknown as vscode.ExtensionContext;
    await registerAllCommands(firstContext);
    expect(vscodeMock.registered).toHaveLength(14);
    const firstHandles = vscodeMock.registered.map((r) => r.disposable);

    const secondContext = { subscriptions: [], globalState } as unknown as vscode.ExtensionContext;
    await expect(registerAllCommands(secondContext)).resolves.toBeUndefined();
    expect(firstHandles.every((d) => d.disposed)).toBe(true);
    expect(vscodeMock.registered).toHaveLength(28);
    expect(vscodeMock.activeCommandIds.size).toBe(14);
  });
});
