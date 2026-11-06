/**
 * 「远端信息」命令宿主侧单测：mock vscode 与 core 读取原语，覆盖
 * 入口回退矩阵（右键 uri → 活动编辑器 → 文件选择框、取消静默）、
 * 读取失败的分类呈现（未版本控制 / svn 缺失 / 普通失败）、认证补录的
 * scheme 分支（http/https/svn 注入、svn+ssh/file 不注入）、QuickPick
 * 条目构造（根缺失时节点 URL 仍可复制、含 @ 相对路径提示）、复制成功
 * 回显原始 URI 与复制失败重开输入框。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  quickPickItems: [] as Array<Record<string, unknown>>,
  quickPickIndex: undefined as number | undefined,
  inputBox: [] as Array<{ prompt?: string; value?: string }>,
  clipboardText: [] as string[],
  clipboardError: undefined as Error | undefined,
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
    showQuickPick: (items: Array<Record<string, unknown>>) => {
      vscodeMock.quickPickItems = items;
      const index = vscodeMock.quickPickIndex;
      return Promise.resolve(index === undefined ? undefined : items[index]);
    },
    showInputBox: (options: { prompt?: string; value?: string }) => {
      vscodeMock.inputBox.push(options);
      return Promise.resolve(undefined);
    },
    get activeTextEditor() {
      return vscodeMock.activeTextEditor;
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown) => fallback,
    }),
  },
  commands: {
    registerCommand: () => ({ dispose: () => undefined }),
  },
  env: {
    clipboard: {
      writeText: async (text: string) => {
        if (vscodeMock.clipboardError) {
          throw vscodeMock.clipboardError;
        }
        vscodeMock.clipboardText.push(text);
      },
    },
  },
}));

const remoteInfoMock = vi.hoisted(() => ({
  readNodeUrl: vi.fn(),
  readRemoteInfo: vi.fn(),
}));

vi.mock('../src/core/remoteInfo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/remoteInfo')>();
  return { ...actual, ...remoteInfoMock };
});

import { SvnError } from '../src/core/errors';
import { promptForCredentials } from '../src/host/auth';
import { commandShowRemoteInfo } from '../src/host/commands/remoteInfo';
import { disposeOutputChannel, resetOutputState } from '../src/host/output';
import { format, strings } from '../src/host/i18n';
import type { RemoteInfoEntry, RemoteInfoReadResult } from '../src/core/remoteInfo';

const makeUri = (fsPath: string): vscode.Uri => ({ fsPath, scheme: 'file' }) as unknown as vscode.Uri;

const entry = (kind: RemoteInfoEntry['kind'], raw: string, display: string, needsPegHint = false): RemoteInfoEntry => ({
  kind,
  raw,
  display,
  needsPegHint,
});

/** 全字段可用的标准读取结果。 */
function fullRead(url = 'https://h/repo/trunk/src'): RemoteInfoReadResult {
  return {
    ok: true,
    entries: [
      entry('nodeUrl', url, url),
      entry('rootUrl', 'https://h/repo', 'https://h/repo'),
      entry('uuid', '11111111-2222-3333-4444-555555555555', '11111111-2222-3333-4444-555555555555'),
      entry('relativePath', '^/trunk/src', '^/trunk/src'),
    ],
    missing: [],
  };
}

/** 等待错误处理与提示的异步链落定。 */
const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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
  vscodeMock.quickPickItems = [];
  vscodeMock.quickPickIndex = undefined;
  vscodeMock.inputBox = [];
  vscodeMock.clipboardText = [];
  vscodeMock.clipboardError = undefined;
  remoteInfoMock.readNodeUrl.mockReset();
  remoteInfoMock.readRemoteInfo.mockReset();
  remoteInfoMock.readNodeUrl.mockResolvedValue('https://h/repo/trunk/src');
  remoteInfoMock.readRemoteInfo.mockResolvedValue(fullRead());
});

// ---------------------------------------------------------------------------
// 入口与回退矩阵
// ---------------------------------------------------------------------------

describe('目标路径来源', () => {
  it('右键文件 uri 直接支持：对 uri 路径读取，不弹选择框', async () => {
    await commandShowRemoteInfo(makeUri('/wc/trunk/src.txt'));
    expect(remoteInfoMock.readNodeUrl.mock.calls[0]?.[1]).toBe('/wc/trunk/src.txt');
    expect(vscodeMock.openDialogCalls).toBe(0);
    expect(vscodeMock.quickPickItems.length).toBeGreaterThan(0);
  });

  it('无 uri 且活动编辑器是 file 文档：用编辑器路径，不弹选择框', async () => {
    vscodeMock.activeTextEditor = { document: { uri: { scheme: 'file', fsPath: '/wc/a.ts' } } };
    await commandShowRemoteInfo();
    expect(remoteInfoMock.readNodeUrl.mock.calls[0]?.[1]).toBe('/wc/a.ts');
    expect(vscodeMock.openDialogCalls).toBe(0);
  });

  it('无 uri 无编辑器：弹文件选择框，取消时静默返回（不读 svn）', async () => {
    await commandShowRemoteInfo();
    expect(vscodeMock.openDialogCalls).toBe(1);
    expect(remoteInfoMock.readNodeUrl).not.toHaveBeenCalled();
    expect(vscodeMock.quickPickItems).toHaveLength(0);
    expect(vscodeMock.information).toHaveLength(0);
  });

  it('选择框选中路径后按该路径读取', async () => {
    vscodeMock.openDialogResult = [{ fsPath: '/wc/picked' }];
    await commandShowRemoteInfo();
    expect(remoteInfoMock.readNodeUrl.mock.calls[0]?.[1]).toBe('/wc/picked');
  });

  it('活动编辑器是 untitled 文档：跳过编辑器走选择框', async () => {
    vscodeMock.activeTextEditor = { document: { uri: { scheme: 'untitled', fsPath: 'Untitled-1' } } };
    await commandShowRemoteInfo();
    expect(vscodeMock.openDialogCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 读取失败的分类呈现
// ---------------------------------------------------------------------------

describe('读取失败呈现', () => {
  it('未版本控制（E200009/E155007）：信息提示、不弹 QuickPick', async () => {
    remoteInfoMock.readNodeUrl.mockRejectedValue(
      new SvnError({ message: 'svn: E155007', command: ['info'], stderr: 'svn: E155007: Path is not a working copy', code: 'E155007' }),
    );
    await commandShowRemoteInfo(makeUri('/plain'));
    expect(vscodeMock.information).toEqual([strings.remoteInfo.unversioned]);
    expect(vscodeMock.quickPickItems).toHaveLength(0);
    expect(vscodeMock.error).toHaveLength(0);
  });

  it('svn 缺失（ENOENT）：警告指向配置项', async () => {
    remoteInfoMock.readNodeUrl.mockRejectedValue(
      new SvnError({ message: 'spawn svn ENOENT', command: ['info'], code: 'ENOENT' }),
    );
    await commandShowRemoteInfo(makeUri('/wc'));
    expect(vscodeMock.warning).toEqual([strings.activation.svnMissing]);
    expect(vscodeMock.error).toHaveLength(0);
  });

  it('其他失败：走统一错误收口（频道 + 错误摘要框）', async () => {
    remoteInfoMock.readNodeUrl.mockRejectedValue(
      new SvnError({ message: 'svn: E155004: Working copy locked', command: ['info'], stderr: 'svn: E155004: Working copy locked', exitCode: 1, code: 'E155004' }),
    );
    await commandShowRemoteInfo(makeUri('/wc'));
    expect(vscodeMock.error).toHaveLength(1);
    expect(String(vscodeMock.error[0]?.[0])).toContain('E155004');
    expect(vscodeMock.information).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 认证补录的 scheme 分支
// ---------------------------------------------------------------------------

describe('认证补录 scheme 分支', () => {
  it.each(['http://h/repo', 'https://h/repo', 'svn://h/repo'])('%s：注入凭据补录回调', async (url) => {
    remoteInfoMock.readNodeUrl.mockResolvedValue(url);
    remoteInfoMock.readRemoteInfo.mockResolvedValue(fullRead(url));
    await commandShowRemoteInfo(makeUri('/wc'));
    const options = remoteInfoMock.readRemoteInfo.mock.calls[0]?.[2];
    expect(options?.getCredentials).toBe(promptForCredentials);
    expect(typeof options?.onCredentialRetry).toBe('function');
  });

  it.each(['svn+ssh://h/repo', 'file:///srv/repo'])('%s：不注入凭据补录（认证失败按普通失败呈现）', async (url) => {
    remoteInfoMock.readNodeUrl.mockResolvedValue(url);
    remoteInfoMock.readRemoteInfo.mockResolvedValue(fullRead(url));
    await commandShowRemoteInfo(makeUri('/wc'));
    const options = remoteInfoMock.readRemoteInfo.mock.calls[0]?.[2];
    expect(options?.getCredentials).toBeUndefined();
    expect(options?.onCredentialRetry).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// QuickPick 条目与复制
// ---------------------------------------------------------------------------

describe('QuickPick 展示与复制', () => {
  it('条目 = 本地路径 + 四信息项；选中节点 URL 复制原始 URI 并回显原样', async () => {
    const read = fullRead('https://h/repo/%E4%B8%AD%E6%96%87/src');
    remoteInfoMock.readRemoteInfo.mockResolvedValue(read);
    vscodeMock.quickPickIndex = 1; // 节点 URL 条目
    await commandShowRemoteInfo(makeUri('/wc/src'));
    expect(vscodeMock.quickPickItems.map((item) => item.label)).toEqual([
      strings.remoteInfo.labelLocalPath,
      strings.remoteInfo.labelNodeUrl,
      strings.remoteInfo.labelRootUrl,
      strings.remoteInfo.labelUuid,
      strings.remoteInfo.labelRelativePath,
    ]);
    expect(vscodeMock.quickPickItems[0]?.detail).toBe('/wc/src');
    expect(vscodeMock.clipboardText).toEqual(['https://h/repo/%E4%B8%AD%E6%96%87/src']);
    expect(vscodeMock.information).toEqual([
      format(strings.remoteInfo.copied, { value: 'https://h/repo/%E4%B8%AD%E6%96%87/src' }),
    ]);
  });

  it('仓库根读取失败（rootError）：节点 URL 条目仍可复制，根条目标记不可用', async () => {
    remoteInfoMock.readRemoteInfo.mockResolvedValue({
      ok: true,
      entries: [
        entry('nodeUrl', 'https://h/repo/src', 'https://h/repo/src'),
        entry('uuid', '11111111-2222-3333-4444-555555555555', '11111111-2222-3333-4444-555555555555'),
        entry('relativePath', '^/src', '^/src'),
      ],
      missing: ['rootUrl'],
    });
    vscodeMock.quickPickIndex = 1;
    await commandShowRemoteInfo(makeUri('/wc/src'));
    expect(vscodeMock.quickPickItems[2]?.detail).toBe(strings.remoteInfo.unavailableDetail);
    expect(vscodeMock.quickPickItems[2]?.unavailable).toBe('rootUrl');
    expect(vscodeMock.clipboardText).toEqual(['https://h/repo/src']);
  });

  it('选中不可用条目：提示原因，不写剪贴板', async () => {
    remoteInfoMock.readRemoteInfo.mockResolvedValue({
      ok: true,
      entries: [entry('nodeUrl', 'https://h/repo/src', 'https://h/repo/src')],
      missing: ['rootUrl', 'uuid', 'relativePath'],
    });
    vscodeMock.quickPickIndex = 2; // 仓库根 URL（不可用）
    await commandShowRemoteInfo(makeUri('/wc/src'));
    expect(vscodeMock.clipboardText).toHaveLength(0);
    expect(vscodeMock.information).toEqual([
      format(strings.remoteInfo.unavailableNotice, { label: strings.remoteInfo.labelRootUrl }),
    ]);
  });

  it('相对路径含 @：条目说明给出命令行补尾 @ 提示', async () => {
    remoteInfoMock.readRemoteInfo.mockResolvedValue({
      ok: true,
      entries: [
        entry('nodeUrl', 'https://h/repo/trunk/imp@1', 'https://h/repo/trunk/imp@1'),
        entry('rootUrl', 'https://h/repo', 'https://h/repo'),
        entry('uuid', '11111111-2222-3333-4444-555555555555', '11111111-2222-3333-4444-555555555555'),
        entry('relativePath', '^/trunk/imp@1', '^/trunk/imp@1', true),
      ],
      missing: [],
    });
    await commandShowRemoteInfo(makeUri('/wc/trunk/imp@1'));
    expect(vscodeMock.quickPickItems[4]?.description).toBe(strings.remoteInfo.pegHint);
    // 提示只挂相对路径条目：含 @ 的节点 URL 不重复提示。
    expect(vscodeMock.quickPickItems[1]?.description).toBeUndefined();
  });

  it('本地路径条目为纯展示：选中不复制', async () => {
    vscodeMock.quickPickIndex = 0;
    await commandShowRemoteInfo(makeUri('/wc/src'));
    expect(vscodeMock.clipboardText).toHaveLength(0);
    expect(vscodeMock.information).toHaveLength(0);
  });

  it('复制失败：提示失败并以原始 URI 为初值重开输入框，不显示成功', async () => {
    vscodeMock.clipboardError = new Error('clipboard busy');
    vscodeMock.quickPickIndex = 1;
    await commandShowRemoteInfo(makeUri('/wc/src'));
    await flushAsync();
    expect(vscodeMock.information).toHaveLength(0);
    expect(vscodeMock.warning).toHaveLength(1);
    expect(vscodeMock.warning[0]).toContain('clipboard busy');
    expect(vscodeMock.inputBox).toEqual([
      { prompt: strings.remoteInfo.copyManualPrompt, value: 'https://h/repo/trunk/src', ignoreFocusOut: true },
    ]);
  });

  it('用户在 QuickPick 按 Esc：静默返回', async () => {
    vscodeMock.quickPickIndex = undefined;
    await commandShowRemoteInfo(makeUri('/wc/src'));
    expect(vscodeMock.clipboardText).toHaveLength(0);
    expect(vscodeMock.information).toHaveLength(0);
  });
});
