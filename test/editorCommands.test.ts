/**
 * 编辑器集成命令入口测试（M4 阶段 4 任务 2/3，host/commands/editor）：
 * - 当前活动文本文件语义：无活动编辑器/非 file 文档的明确提示；
 * - 拒绝原因 → 用户提示映射（信息 vs 警告、feature 名称）；
 * - 执行失败交统一错误收口；开启/关闭成功不弹提示；
 * - 命令注册（toggleQuickDiff/toggleInlineBlame）与二次注册句柄释放。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

const vscodeMock = vi.hoisted(() => ({
  activeTextEditor: undefined as { document: { uri: { scheme?: string; fsPath?: string; toString(): string } } } | undefined,
  information: [] as string[],
  warning: [] as string[],
  error: [] as Array<unknown[]>,
  channels: [] as Array<{ lines: string[]; shown: number; appendLine(line: string): void; show(): void; dispose(): void }>,
  registered: [] as Array<{ id: string; handler: () => unknown; disposable: { dispose(): void } }>,
  activeCommandIds: new Set<string>(),
}));

vi.mock('vscode', () => ({
  window: {
    get activeTextEditor() {
      return vscodeMock.activeTextEditor;
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
    createOutputChannel: () => {
      const channel = {
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
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown) => fallback,
    }),
  },
  commands: {
    registerCommand: (id: string, handler: () => unknown) => {
      if (vscodeMock.activeCommandIds.has(id)) {
        throw new Error(`command '${id}' already exists`);
      }
      vscodeMock.activeCommandIds.add(id);
      const disposable = {
        dispose() {
          vscodeMock.activeCommandIds.delete(id);
        },
      };
      vscodeMock.registered.push({ id, handler, disposable });
      return disposable;
    },
  },
}));

import {
  commandToggleInlineBlame,
  commandToggleQuickDiff,
  disposeEditorCommandsForTest,
  editorRejectNotice,
  registerEditorCommands,
} from '../src/host/commands/editor';
import { strings } from '../src/host/i18n';
import { disableInlineBlame } from '../src/host/inlineBlame';
import { disposeOutputChannel, resetOutputState } from '../src/host/output';
import { disableQuickDiff } from '../src/host/quickDiff';

const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const makeEditor = (scheme: string, fsPath: string): vscode.TextEditor =>
  ({
    document: {
      uri: { scheme, fsPath, toString: () => `${scheme}://${fsPath}` },
      lineCount: 3,
      lineAt: (line: number) => ({ range: { startLine: line, startCharacter: 0, endLine: line, endCharacter: 0 } }),
    },
    setDecorations: () => undefined,
  }) as unknown as vscode.TextEditor;

beforeEach(() => {
  disableQuickDiff();
  disableInlineBlame();
  disposeEditorCommandsForTest();
  disposeOutputChannel();
  resetOutputState();
  vscodeMock.activeTextEditor = undefined;
  vscodeMock.information.length = 0;
  vscodeMock.warning.length = 0;
  vscodeMock.error.length = 0;
  vscodeMock.channels.length = 0;
  vscodeMock.registered.length = 0;
  vscodeMock.activeCommandIds.clear();
});

describe('editorRejectNotice：拒绝原因 → 用户提示', () => {
  it('无活动编辑器是信息提示；未版本控制/缺失/目录带 feature 名称', () => {
    expect(editorRejectNotice('noActiveEditor', 'quickDiff')).toEqual({
      level: 'info',
      message: strings.editor.noActiveEditor,
    });
    expect(editorRejectNotice('unversioned', 'quickDiff').message).toContain(strings.editor.featureQuickDiff);
    expect(editorRejectNotice('missing', 'inlineBlame').message).toContain(strings.editor.featureInlineBlame);
    expect(editorRejectNotice('deleted', 'quickDiff').level).toBe('info');
    expect(editorRejectNotice('directory', 'inlineBlame').level).toBe('info');
  });

  it('二进制与超过 16 MiB 是警告提示', () => {
    expect(editorRejectNotice('binary', 'quickDiff')).toEqual({
      level: 'warning',
      message: expect.stringContaining(strings.editor.featureQuickDiff),
    });
    expect(editorRejectNotice('binary', 'inlineBlame').level).toBe('warning');
    expect(editorRejectNotice('tooLarge', 'inlineBlame')).toEqual({
      level: 'warning',
      message: strings.editor.inlineBlameTooLarge,
    });
  });
});

describe('commandToggleQuickDiff/commandToggleInlineBlame', () => {
  it('无活动编辑器：走真实控制器返回 noActiveEditor 并弹信息提示', async () => {
    await commandToggleQuickDiff();
    expect(vscodeMock.information).toEqual([strings.editor.noActiveEditor]);
    await commandToggleInlineBlame();
    expect(vscodeMock.information).toEqual([strings.editor.noActiveEditor, strings.editor.noActiveEditor]);
  });

  it('二进制拒绝：弹警告提示（不弹错误框）', async () => {
    await commandToggleQuickDiff({ toggleQuickDiff: async () => ({ status: 'rejected', reason: 'binary' }) });
    expect(vscodeMock.warning).toEqual([expect.stringContaining(strings.editor.featureQuickDiff)]);
    expect(vscodeMock.error).toHaveLength(0);

    await commandToggleInlineBlame({ toggleInlineBlame: async () => ({ status: 'rejected', reason: 'tooLarge' }) });
    expect(vscodeMock.warning).toEqual([
      expect.stringContaining(strings.editor.featureQuickDiff),
      strings.editor.inlineBlameTooLarge,
    ]);
  });

  it('执行失败交统一错误收口：弹摘要并写输出频道', async () => {
    await commandToggleQuickDiff({
      toggleQuickDiff: async () => ({ status: 'failed', error: new Error('diff 命令失败') }),
    });
    await flushAsync();
    expect(vscodeMock.error).toEqual([['diff 命令失败', strings.error.buttonShowOutput]]);
    expect(vscodeMock.channels[0]?.lines.join('\n')).toContain('diff 命令失败');
  });

  it('开启/关闭成功不弹任何提示', async () => {
    await commandToggleQuickDiff({ toggleQuickDiff: async () => ({ status: 'enabled', markerCount: 3 }) });
    await commandToggleQuickDiff({ toggleQuickDiff: async () => ({ status: 'disabled' }) });
    await commandToggleInlineBlame({
      toggleInlineBlame: async () => ({ status: 'enabled', availability: 'auto', lineCount: 3 }),
    });
    await commandToggleInlineBlame({ toggleInlineBlame: async () => ({ status: 'disabled' }) });
    expect(vscodeMock.information).toHaveLength(0);
    expect(vscodeMock.warning).toHaveLength(0);
    expect(vscodeMock.error).toHaveLength(0);
  });

  it('默认接线使用当前活动编辑器（untitled 文档按 notFile 提示，不启动 svn 命令）', async () => {
    vscodeMock.activeTextEditor = makeEditor('untitled', 'Untitled-1') as unknown as typeof vscodeMock.activeTextEditor;
    await commandToggleQuickDiff();
    expect(vscodeMock.information).toEqual([strings.editor.rejectedNotFile]);
    expect(vscodeMock.error).toHaveLength(0);
  });
});

describe('registerEditorCommands', () => {
  it('注册两个命令；二次注册先释放旧句柄，不触发重复 ID 报错', () => {
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    registerEditorCommands(context);
    expect(vscodeMock.registered.map((item) => item.id)).toEqual([
      'svnAnywhere.toggleQuickDiff',
      'svnAnywhere.toggleInlineBlame',
    ]);
    expect(vscodeMock.activeCommandIds.size).toBe(2);

    registerEditorCommands(context);
    expect(vscodeMock.registered).toHaveLength(4);
    expect(vscodeMock.activeCommandIds.size).toBe(2);
  });

  it('命令 handler 包装统一错误收口（同步抛错不冒泡）', async () => {
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    registerEditorCommands(context);
    const handler = vscodeMock.registered[0]?.handler;
    // 无活动编辑器时 handler 正常完成（提示而非异常）。
    await expect(handler?.()).resolves.toBeUndefined();
    expect(vscodeMock.information).toEqual([strings.editor.noActiveEditor]);
  });
});
