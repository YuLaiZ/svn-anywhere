/**
 * 「磁盘治理」命令宿主侧单测：mock vscode 与面板控制器，覆盖 §10 入口
 * 矩阵：右键副本内目录/文件向上定位根（嵌套副本命中内层）、右键副本外
 * 提示、活动编辑器文件在副本内直接打开 / 不在副本内直接提示（不回退
 * 选择框——磁盘治理与远端信息/检出的回退口径差异）、无 uri 无编辑器
 * 弹目录选择框且选中后仍校验副本内、选择框取消静默。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  openDiskPanel: vi.fn(),
}));

vi.mock('../src/host/panel/panels/disk', () => ({
  openDiskPanel: panelMock.openDiskPanel,
}));

import { commandDiskUsage } from '../src/host/commands/diskUsage';
import { strings } from '../src/host/i18n';

const makeUri = (fsPath: string): vscode.Uri => ({ fsPath, scheme: 'file' }) as unknown as vscode.Uri;

/** 假工作副本根：findWorkingCopy 以 .svn/wc.db 存在为准。 */
function makeWorkingCopy(dir: string): void {
  mkdirSync(join(dir, '.svn'), { recursive: true });
  writeFileSync(join(dir, '.svn', 'wc.db'), 'fake');
}

let wcRoot = '';
let nestedRoot = '';
let plainDir = '';

beforeEach(() => {
  vscodeMock.information.length = 0;
  vscodeMock.warning.length = 0;
  vscodeMock.openDialogCalls = 0;
  vscodeMock.openDialogOptions = [];
  vscodeMock.openDialogResult = undefined;
  vscodeMock.activeTextEditor = undefined;
  panelMock.openDiskPanel.mockReset();
  // macOS tmpdir 是符号链接，findWorkingCopy 返回 realpath 后路径，同样解析。
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-disk-cmd-')));
  wcRoot = join(base, 'wc');
  makeWorkingCopy(wcRoot);
  // 嵌套副本：外层 wc 内的 inner 自成副本根（定位命中最近的一个）。
  nestedRoot = join(wcRoot, 'vendor', 'inner');
  makeWorkingCopy(nestedRoot);
  plainDir = join(base, 'plain');
  mkdirSync(plainDir, { recursive: true });
});

afterEach(() => {
  rmSync(join(wcRoot, '..'), { recursive: true, force: true });
});

describe('磁盘治理命令入口矩阵', () => {
  it('右键副本内目录：定位该副本根，目录自身即本次打开子目录，不弹选择框', async () => {
    const sub = join(wcRoot, 'trunk', 'sub');
    mkdirSync(sub, { recursive: true });
    await commandDiskUsage(makeUri(sub));
    expect(panelMock.openDiskPanel).toHaveBeenCalledWith({ wcRoot, subPath: sub });
    expect(vscodeMock.openDialogCalls).toBe(0);
  });

  it('右键副本内文件：向上定位根，所在目录为打开子目录（等价于在该目录右键）', async () => {
    const dir = join(wcRoot, 'docs');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'x');
    await commandDiskUsage(makeUri(file));
    expect(panelMock.openDiskPanel).toHaveBeenCalledWith({ wcRoot, subPath: dir });
    expect(vscodeMock.openDialogCalls).toBe(0);
  });

  it('右键副本根自身：根即打开子目录', async () => {
    await commandDiskUsage(makeUri(wcRoot));
    expect(panelMock.openDiskPanel).toHaveBeenCalledWith({ wcRoot, subPath: wcRoot });
  });

  it('嵌套副本内路径：向上定位命中最近的内层根', async () => {
    const file = join(nestedRoot, 'lib.js');
    writeFileSync(file, 'x');
    await commandDiskUsage(makeUri(file));
    expect(panelMock.openDiskPanel).toHaveBeenCalledWith({ wcRoot: nestedRoot, subPath: nestedRoot });
  });

  it('右键副本外路径：提示不在工作副本内，不打开面板、不弹选择框', async () => {
    await commandDiskUsage(makeUri(plainDir));
    expect(vscodeMock.information).toEqual([strings.diskCommand.notWorkingCopy]);
    expect(panelMock.openDiskPanel).not.toHaveBeenCalled();
    expect(vscodeMock.openDialogCalls).toBe(0);
  });

  it('命令面板 + 活动编辑器文件在副本内：直接定位打开，不弹选择框', async () => {
    const dir = join(wcRoot, 'src');
    mkdirSync(dir, { recursive: true });
    vscodeMock.activeTextEditor = { document: { uri: { scheme: 'file', fsPath: join(dir, 'open.ts') } } };
    await commandDiskUsage();
    expect(panelMock.openDiskPanel).toHaveBeenCalledWith({ wcRoot, subPath: dir });
    expect(vscodeMock.openDialogCalls).toBe(0);
    expect(vscodeMock.information).toHaveLength(0);
  });

  it('命令面板 + 活动编辑器文件不在任何副本内：直接提示，不回退选择框（§10 回退矩阵）', async () => {
    vscodeMock.activeTextEditor = { document: { uri: { scheme: 'file', fsPath: join(plainDir, 'open.ts') } } };
    await commandDiskUsage();
    expect(vscodeMock.information).toEqual([strings.diskCommand.activeEditorNotWorkingCopy]);
    expect(vscodeMock.openDialogCalls).toBe(0);
    expect(panelMock.openDiskPanel).not.toHaveBeenCalled();
  });

  it('活动编辑器是 untitled 文档：跳过编辑器走目录选择框', async () => {
    vscodeMock.activeTextEditor = { document: { uri: { scheme: 'untitled', fsPath: 'Untitled-1' } } };
    await commandDiskUsage();
    expect(vscodeMock.openDialogCalls).toBe(1);
    expect(panelMock.openDiskPanel).not.toHaveBeenCalled();
  });

  it('无 uri 无编辑器：弹目录选择框（只可选目录），选中副本内目录后打开面板', async () => {
    const sub = join(wcRoot, 'picked');
    mkdirSync(sub, { recursive: true });
    vscodeMock.openDialogResult = [{ fsPath: sub }];
    await commandDiskUsage();
    expect(vscodeMock.openDialogCalls).toBe(1);
    expect(vscodeMock.openDialogOptions[0]).toMatchObject({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: strings.diskCommand.pickDirTitle,
    });
    expect(panelMock.openDiskPanel).toHaveBeenCalledWith({ wcRoot, subPath: sub });
  });

  it('目录选择框选中副本外目录：仍校验副本内并提示，不打开面板', async () => {
    vscodeMock.openDialogResult = [{ fsPath: plainDir }];
    await commandDiskUsage();
    expect(vscodeMock.information).toEqual([strings.diskCommand.notWorkingCopy]);
    expect(panelMock.openDiskPanel).not.toHaveBeenCalled();
  });

  it('目录选择框取消：静默返回，不打开面板、不提示', async () => {
    await commandDiskUsage();
    expect(vscodeMock.openDialogCalls).toBe(1);
    expect(panelMock.openDiskPanel).not.toHaveBeenCalled();
    expect(vscodeMock.information).toHaveLength(0);
    expect(vscodeMock.warning).toHaveLength(0);
  });

  it('路径已从磁盘消失（如活动编辑器指向已删除文件）：从现存父目录继续定位', async () => {
    const dir = join(wcRoot, 'vanishing');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'gone.txt');
    writeFileSync(file, 'x');
    rmSync(file);
    await commandDiskUsage(makeUri(file));
    expect(panelMock.openDiskPanel).toHaveBeenCalledWith({ wcRoot, subPath: dir });
  });
});
