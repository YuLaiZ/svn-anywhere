/**
 * 「导入本地目录」命令宿主侧单测：mock vscode 与面板控制器，覆盖源目录
 * 解析的入口矩阵（右键目录即源目录、已纳管目录不在此拦、右键文件提示
 * 「导入源必须是目录」并弹目录选择框、活动编辑器按文件形态处理、无路径
 * 回退弹目录选择框与取消静默）与入口键 realpath 归一（macOS tmpdir 是
 * 符号链接）。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

import { commandImportLocal } from '../src/host/commands/importDir';
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
  base = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-import-cmd-')));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('导入命令入口矩阵', () => {
  it('右键目录 uri：该目录即源目录，realpath 归一后以 import 模式打开面板，不弹选择框', async () => {
    const src = join(base, 'src-dir');
    mkdirSync(src, { recursive: true });
    await commandImportLocal(makeUri(src));
    expect(panelMock.openCheckoutPanel).toHaveBeenCalledWith({
      entryKey: realpathSync(src),
      mode: 'import',
      sourceDir: realpathSync(src),
    });
    expect(vscodeMock.openDialogCalls).toBe(0);
    expect(vscodeMock.information).toHaveLength(0);
  });

  it('已纳管目录不在入口拦截：sourceVersioned 由面板分支拦下，入口直接打开', async () => {
    const versioned = join(base, 'versioned');
    mkdirSync(join(versioned, '.svn'), { recursive: true });
    await commandImportLocal(makeUri(versioned));
    expect(panelMock.openCheckoutPanel).toHaveBeenCalledTimes(1);
    expect(vscodeMock.information).toHaveLength(0);
  });

  it('右键文件 uri：提示「导入源必须是目录」并弹目录选择框，选中后打开', async () => {
    const src = join(base, 'picked-src');
    mkdirSync(src, { recursive: true });
    const file = join(base, 'a.txt');
    writeFileSync(file, 'x');
    vscodeMock.openDialogResult = [{ fsPath: src }];
    await commandImportLocal(makeUri(file));
    expect(vscodeMock.information).toEqual([strings.importCommand.sourceMustBeDir]);
    expect(vscodeMock.openDialogCalls).toBe(1);
    expect(vscodeMock.openDialogOptions[0]).toMatchObject({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: strings.importCommand.pickSourceDirTitle,
    });
    expect(panelMock.openCheckoutPanel).toHaveBeenCalledWith({
      entryKey: realpathSync(src),
      mode: 'import',
      sourceDir: realpathSync(src),
    });
  });

  it('右键文件后选择框取消：不再打开面板（已提示一次，取消静默）', async () => {
    const file = join(base, 'b.txt');
    writeFileSync(file, 'x');
    await commandImportLocal(makeUri(file));
    expect(vscodeMock.information).toEqual([strings.importCommand.sourceMustBeDir]);
    expect(vscodeMock.openDialogCalls).toBe(1);
    expect(panelMock.openCheckoutPanel).not.toHaveBeenCalled();
    expect(vscodeMock.warning).toHaveLength(0);
  });

  it('活动编辑器是本地文件：仍按文件形态处理（提示 + 弹目录选择框）', async () => {
    const src = join(base, 'editor-pick');
    mkdirSync(src, { recursive: true });
    vscodeMock.activeTextEditor = { document: { uri: { scheme: 'file', fsPath: join(src, 'open.ts') } } };
    vscodeMock.openDialogResult = [{ fsPath: src }];
    await commandImportLocal();
    expect(vscodeMock.information).toEqual([strings.importCommand.sourceMustBeDir]);
    expect(vscodeMock.openDialogCalls).toBe(1);
    expect(panelMock.openCheckoutPanel.mock.calls[0]?.[0]).toMatchObject({
      entryKey: realpathSync(src),
      mode: 'import',
      sourceDir: realpathSync(src),
    });
  });

  it('活动编辑器是 untitled 文档：跳过编辑器弹目录选择框（无提示）', async () => {
    vscodeMock.activeTextEditor = { document: { uri: { scheme: 'untitled', fsPath: 'Untitled-1' } } };
    await commandImportLocal();
    expect(vscodeMock.openDialogCalls).toBe(1);
    expect(vscodeMock.information).toHaveLength(0);
    expect(panelMock.openCheckoutPanel).not.toHaveBeenCalled();
  });

  it('无 uri 无编辑器：弹目录选择框（只可选目录），选中后按该目录打开', async () => {
    const picked = join(base, 'picked-dir');
    mkdirSync(picked, { recursive: true });
    vscodeMock.openDialogResult = [{ fsPath: picked }];
    await commandImportLocal();
    expect(vscodeMock.openDialogCalls).toBe(1);
    expect(vscodeMock.openDialogOptions[0]).toMatchObject({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: strings.importCommand.pickSourceDirTitle,
    });
    expect(panelMock.openCheckoutPanel).toHaveBeenCalledWith({
      entryKey: realpathSync(picked),
      mode: 'import',
      sourceDir: realpathSync(picked),
    });
  });

  it('目录选择框取消：静默返回，不打开面板、不提示', async () => {
    await commandImportLocal();
    expect(vscodeMock.openDialogCalls).toBe(1);
    expect(panelMock.openCheckoutPanel).not.toHaveBeenCalled();
    expect(vscodeMock.information).toHaveLength(0);
    expect(vscodeMock.warning).toHaveLength(0);
  });

  it('路径已从磁盘消失（如活动编辑器指向已删除文件）：按文件形态提示并弹选择框', async () => {
    const src = join(base, 'vanishing-pick');
    mkdirSync(src, { recursive: true });
    const file = join(base, 'gone.txt');
    writeFileSync(file, 'x');
    rmSync(file);
    vscodeMock.openDialogResult = [{ fsPath: src }];
    await commandImportLocal(makeUri(file));
    expect(vscodeMock.information).toEqual([strings.importCommand.sourceMustBeDir]);
    expect(panelMock.openCheckoutPanel.mock.calls[0]?.[0]).toMatchObject({
      entryKey: realpathSync(src),
      mode: 'import',
      sourceDir: realpathSync(src),
    });
  });

  it('源目录经符号链接访问时入口键归一到真实路径', async () => {
    const real = join(base, 'real-src');
    mkdirSync(real, { recursive: true });
    const aliasRoot = join(base, 'alias-root');
    mkdirSync(aliasRoot, { recursive: true });
    const alias = join(aliasRoot, 'alias');
    symlinkSync(real, alias, 'dir');
    await commandImportLocal(makeUri(alias));
    expect(panelMock.openCheckoutPanel).toHaveBeenCalledWith({
      entryKey: real,
      mode: 'import',
      sourceDir: real,
    });
  });
});
