/**
 * 「检出」命令宿主侧单测：mock vscode 与面板控制器，覆盖父目录解析的
 * 入口矩阵（右键目录即父目录、右键文件取所在目录、活动编辑器回退、
 * 目录选择框回退与取消静默）、入口键 realpath 归一（macOS tmpdir 是
 * 符号链接）与目录选择框只可选目录的参数形态。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

const vscodeMock = vi.hoisted(() => ({
  information: [] as string[],
  warning: [] as string[],
  openDialogCalls: 0,
  openDialogOptions: [] as Array<Record<string, unknown>>,
  openDialogResult: undefined as Array<{ fsPath: string }> | undefined,
  activeTextEditor: undefined as { document: { uri: { scheme: string; fsPath: string } } } | undefined,
}));

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: (message: string) => {
      vscodeMock.information.push(message);
      return Promise.resolve(undefined);
    },
    showWarningMessage: (message: string) => {
      vscodeMock.warning.push(message);
      return Promise.resolve(undefined);
    },
    showOpenDialog: (options: Record<string, unknown>) => {
      vscodeMock.openDialogCalls += 1;
      vscodeMock.openDialogOptions.push(options);
      return Promise.resolve(vscodeMock.openDialogResult);
    },
    get activeTextEditor() {
      return vscodeMock.activeTextEditor;
    },
  },
}));

const panelMock = vi.hoisted(() => ({
  openCheckoutPanel: vi.fn(),
}));

vi.mock('../src/host/panel/panels/checkout', () => ({
  openCheckoutPanel: panelMock.openCheckoutPanel,
}));

import { commandCheckout } from '../src/host/commands/checkout';
import { strings } from '../src/host/i18n';

const makeUri = (fsPath: string): vscode.Uri => ({ fsPath, scheme: 'file' }) as unknown as vscode.Uri;

let base = '';

beforeEach(() => {
  vscodeMock.information.length = 0;
  vscodeMock.warning.length = 0;
  vscodeMock.openDialogCalls = 0;
  vscodeMock.openDialogOptions = [];
  vscodeMock.openDialogResult = undefined;
  vscodeMock.activeTextEditor = undefined;
  panelMock.openCheckoutPanel.mockReset();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-checkout-cmd-')));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('检出命令入口矩阵', () => {
  it('右键目录 uri：该目录即父目录，realpath 归一后打开面板，不弹选择框', async () => {
    const parent = join(base, 'parent');
    mkdirSync(parent, { recursive: true });
    await commandCheckout(makeUri(parent));
    expect(panelMock.openCheckoutPanel).toHaveBeenCalledWith({
      entryKey: realpathSync(parent),
      mode: 'checkout',
      parentDir: realpathSync(parent),
    });
    expect(vscodeMock.openDialogCalls).toBe(0);
  });

  it('右键文件 uri：取所在目录为父目录（等价于在该目录右键）', async () => {
    const parent = join(base, 'docs');
    mkdirSync(parent, { recursive: true });
    const file = join(parent, 'a.txt');
    writeFileSync(file, 'x');
    await commandCheckout(makeUri(file));
    expect(panelMock.openCheckoutPanel).toHaveBeenCalledWith({
      entryKey: realpathSync(parent),
      mode: 'checkout',
      parentDir: realpathSync(parent),
    });
    expect(vscodeMock.openDialogCalls).toBe(0);
  });

  it('无 uri 且活动编辑器是 file 文档：取编辑器文件所在目录，不弹选择框', async () => {
    const parent = join(base, 'editor-dir');
    mkdirSync(parent, { recursive: true });
    vscodeMock.activeTextEditor = { document: { uri: { scheme: 'file', fsPath: join(parent, 'open.ts') } } };
    await commandCheckout();
    expect(panelMock.openCheckoutPanel).toHaveBeenCalledTimes(1);
    expect(panelMock.openCheckoutPanel.mock.calls[0]?.[0]).toMatchObject({
      entryKey: realpathSync(parent),
      parentDir: realpathSync(parent),
      mode: 'checkout',
    });
    expect(vscodeMock.openDialogCalls).toBe(0);
  });

  it('活动编辑器是 untitled 文档：跳过编辑器走目录选择框', async () => {
    vscodeMock.activeTextEditor = { document: { uri: { scheme: 'untitled', fsPath: 'Untitled-1' } } };
    await commandCheckout();
    expect(vscodeMock.openDialogCalls).toBe(1);
    expect(panelMock.openCheckoutPanel).not.toHaveBeenCalled();
  });

  it('无 uri 无编辑器：弹目录选择框（只可选目录），选中后按该目录打开', async () => {
    const picked = join(base, 'picked-dir');
    mkdirSync(picked, { recursive: true });
    vscodeMock.openDialogResult = [{ fsPath: picked }];
    await commandCheckout();
    expect(vscodeMock.openDialogCalls).toBe(1);
    expect(vscodeMock.openDialogOptions[0]).toMatchObject({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: strings.checkoutCommand.pickParentDirTitle,
    });
    expect(panelMock.openCheckoutPanel).toHaveBeenCalledWith({
      entryKey: realpathSync(picked),
      mode: 'checkout',
      parentDir: realpathSync(picked),
    });
  });

  it('目录选择框取消：静默返回，不打开面板、不提示', async () => {
    await commandCheckout();
    expect(vscodeMock.openDialogCalls).toBe(1);
    expect(panelMock.openCheckoutPanel).not.toHaveBeenCalled();
    expect(vscodeMock.information).toHaveLength(0);
    expect(vscodeMock.warning).toHaveLength(0);
  });

  it('路径已从磁盘消失（如活动编辑器指向已删除文件）：按文件处理取其父目录', async () => {
    const parent = join(base, 'vanishing');
    mkdirSync(parent, { recursive: true });
    const file = join(parent, 'gone.txt');
    writeFileSync(file, 'x');
    rmSync(file);
    await commandCheckout(makeUri(file));
    expect(panelMock.openCheckoutPanel).toHaveBeenCalledTimes(1);
    expect(panelMock.openCheckoutPanel.mock.calls[0]?.[0]).toMatchObject({
      entryKey: realpathSync(parent),
      parentDir: realpathSync(parent),
    });
  });

  it('父目录经符号链接访问时入口键归一到真实路径', async () => {
    const real = join(base, 'real-parent');
    mkdirSync(real, { recursive: true });
    const aliasRoot = join(base, 'alias-root');
    mkdirSync(aliasRoot, { recursive: true });
    const alias = join(aliasRoot, 'alias');
    symlinkSync(real, alias, 'dir');
    await commandCheckout(makeUri(alias));
    expect(panelMock.openCheckoutPanel).toHaveBeenCalledWith({
      entryKey: real,
      mode: 'checkout',
      parentDir: real,
    });
  });

  it('右键文件的父目录即 dirname：与直接右键该目录的入口键一致', async () => {
    const parent = join(base, 'same');
    mkdirSync(parent, { recursive: true });
    const file = join(parent, 'f.txt');
    writeFileSync(file, 'x');
    await commandCheckout(makeUri(file));
    await commandCheckout(makeUri(parent));
    const keys = panelMock.openCheckoutPanel.mock.calls.map((call) => call[0]?.entryKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toBe(dirname(file));
  });
});
