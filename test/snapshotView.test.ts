/**
 * P6 快照差异宿主层测试（M4 阶段 3）：
 * - 快照只读文档 URI：revision 与一次性内容键可解析，非法形状拒绝；
 * - openSnapshotTextDiff：两端文本经 provider 打开原生 vscode.diff、文档
 *   关闭即释放；单端不存在用空内容端；二进制与 svn:special 不进入文本
 *   差异；超过内嵌上限返回 tooLarge；vscode.diff 失败回收已写入内容键；
 * - promptSnapshotExport：原生保存对话框、覆盖确认（拒绝即取消）、
 *   导出产物内容与删除前版本明示字段；
 * - openSnapshotBaseCompareEntry：目录 BASE 比较逐项复用单文件 BASE diff。
 * 全部使用本地 svnadmin + file:// 隔离仓库，不访问网络。
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const vscodeMock = vi.hoisted(() => ({
  executedCommands: [] as unknown[][],
  executeCommandError: undefined as Error | undefined,
  providers: new Map<string, { provideTextDocumentContent(uri: unknown): string }>(),
  closeHandlers: [] as Array<(doc: { uri: unknown }) => void>,
  saveDialogResult: undefined as { fsPath?: string; path?: string } | undefined,
  warningResult: undefined as string | undefined,
  warnings: [] as string[],
  shownDocuments: [] as unknown[],
}));

vi.mock('vscode', () => ({
  Uri: {
    file: (fsPath: string) => ({ scheme: 'file', path: fsPath, fsPath, toString: () => `file://${fsPath}` }),
    from: (components: { scheme: string; path?: string; query?: string }) => ({
      scheme: components.scheme,
      path: components.path ?? '',
      query: components.query ?? '',
      toString: () =>
        `${components.scheme}:${components.path ?? ''}${components.query ? `?${components.query}` : ''}`,
    }),
    parse: (value: string) => {
      const match = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(value);
      const scheme = match?.[1] ?? 'untitled';
      const rest = match?.[2] ?? value;
      const queryIndex = rest.indexOf('?');
      return {
        scheme,
        path: queryIndex >= 0 ? rest.slice(0, queryIndex) : rest,
        query: queryIndex >= 0 ? rest.slice(queryIndex + 1) : '',
        toString: () => value,
      };
    },
    joinPath: (base: { path: string }, ...parts: string[]) => {
      const path = [base.path.replace(/\/$/, ''), ...parts].join('/');
      return { scheme: 'file', path, fsPath: path, toString: () => `file://${path}` };
    },
  },
  window: {
    createOutputChannel: () => ({
      lines: [] as string[],
      appendLine() {},
      show() {},
      dispose() {},
    }),
    showSaveDialog: async () => vscodeMock.saveDialogResult,
    showWarningMessage: async (message: string, _options?: unknown, _items?: string[]) => {
      vscodeMock.warnings.push(message);
      return vscodeMock.warningResult;
    },
    showTextDocument: async (uri: unknown) => {
      vscodeMock.shownDocuments.push(uri);
      return undefined;
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown) => fallback,
    }),
    registerTextDocumentContentProvider: (
      scheme: string,
      provider: { provideTextDocumentContent(uri: unknown): string },
    ) => {
      vscodeMock.providers.set(scheme, provider);
      return { dispose: () => { vscodeMock.providers.delete(scheme); } };
    },
    onDidCloseTextDocument: (handler: (doc: { uri: unknown }) => void) => {
      vscodeMock.closeHandlers.push(handler);
      return {
        dispose: () => {
          const index = vscodeMock.closeHandlers.indexOf(handler);
          if (index >= 0) {
            vscodeMock.closeHandlers.splice(index, 1);
          }
        },
      };
    },
  },
  commands: {
    executeCommand: async (command: string, ...args: unknown[]) => {
      if (vscodeMock.executeCommandError !== undefined) {
        throw vscodeMock.executeCommandError;
      }
      vscodeMock.executedCommands.push([command, ...args]);
      return undefined;
    },
  },
  env: {
    openExternal: async () => true,
  },
}));

vi.mock('../src/host/output', () => ({
  logCommand: () => () => {},
  logExitCode: () => {},
  logLine: () => {},
  showOutput: () => {},
  resetOutputState: () => {},
  disposeOutputChannel: () => {},
  decodingRunOptions: () => ({ encoding: 'UTF-8', encodingFallback: [], onDecodingFallback: () => {} }),
}));

vi.mock('../src/host/config', () => ({ readTimeoutMs: () => 1000 }));

import { planSnapshotExport, snapshotText } from '../src/host/panel/snapshotModel';
import {
  buildSnapshotDocumentUri,
  openSnapshotBaseCompareEntry,
  openSnapshotTextDiff,
  parseSnapshotDocumentUri,
  promptSnapshotExport,
  resetDiffViewForTest,
  SNAPSHOT_DOCUMENT_SCHEME,
  snapshotContentCountForTest,
} from '../src/host/diffView';
import { createSvnLab, writeFile, type SvnLab } from './helpers';

let hasSvn = false;
try {
  execSync('svn --version', { stdio: 'ignore' });
  hasSvn = true;
} catch {
  hasSvn = false;
}

let lab: SvnLab | undefined;
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  resetDiffViewForTest();
  vscodeMock.executedCommands.length = 0;
  vscodeMock.executeCommandError = undefined;
  vscodeMock.providers.clear();
  vscodeMock.closeHandlers.length = 0;
  vscodeMock.saveDialogResult = undefined;
  vscodeMock.warningResult = undefined;
  vscodeMock.warnings.length = 0;
  vscodeMock.shownDocuments.length = 0;
  lab?.cleanup();
  lab = undefined;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('快照只读文档 URI（revision 随 URI 携带）', () => {
  it('构造/解析往返：scheme、revision、内容键与原始 URL', () => {
    const uri = buildSnapshotDocumentUri(
      { rawUrl: 'file:///repo/trunk/a%20b.txt', revision: 7 },
      'a b.txt',
      'key-1',
    );
    expect(uri.scheme).toBe(SNAPSHOT_DOCUMENT_SCHEME);
    const parsed = parseSnapshotDocumentUri(uri as never);
    expect(parsed).toEqual({
      rawUrl: 'file:///repo/trunk/a%20b.txt',
      revision: 7,
      contentKey: 'key-1',
    });
  });

  it('非法 scheme / 形状 / revision 返回 undefined', () => {
    expect(parseSnapshotDocumentUri({
      scheme: 'other', path: '/1/key/name', query: 'url=x',
    } as never)).toBeUndefined();
    expect(parseSnapshotDocumentUri({
      scheme: SNAPSHOT_DOCUMENT_SCHEME, path: '/x/key/name', query: 'url=x',
    } as never)).toBeUndefined();
    expect(parseSnapshotDocumentUri({
      scheme: SNAPSHOT_DOCUMENT_SCHEME, path: '/1/key', query: 'url=x',
    } as never)).toBeUndefined();
    expect(parseSnapshotDocumentUri({
      scheme: SNAPSHOT_DOCUMENT_SCHEME, path: '/1/key/name', query: '',
    } as never)).toBeUndefined();
  });
});

describe.skipIf(!hasSvn)('openSnapshotTextDiff：原生 vscode.diff 接线', () => {
  function buildRepo(): SvnLab {
    const local = createSvnLab('svn-anywhere-snapshot-view-');
    const wc = local.checkout('wc');
    writeFile(wc, 'trunk/a.txt', 'line1\n', true);
    local.svn(['commit', '-q', '-m', 'r1'], wc);
    writeFileSync(join(wc, 'trunk', 'a.txt'), 'line2\n');
    local.svn(['commit', '-q', '-m', 'r2'], wc);
    return local;
  }

  function lastDiff(): { left: unknown; right: unknown; title?: string } | undefined {
    const call = vscodeMock.executedCommands.find((args) => args[0] === 'vscode.diff');
    if (!call) {
      return undefined;
    }
    return { left: call[1], right: call[2], title: call[3] as string | undefined };
  }

  it('两端文本 → provider URI 打开 vscode.diff；关闭文档即释放内容', async () => {
    lab = buildRepo();
    const url = `${lab.repoUrl}/trunk/a.txt`;
    const outcome = await openSnapshotTextDiff({
      svnPath: 'svn',
      title: '比较 r1 与 r2',
      left: { rawUrl: url, revision: 1, displayName: 'a.txt（r1）' },
      right: { rawUrl: url, revision: 2, displayName: 'a.txt（r2）' },
    });
    expect(outcome.status).toBe('opened');
    if (outcome.status !== 'opened') {
      return;
    }
    const diff = lastDiff();
    expect(diff).toBeDefined();
    expect(diff?.title).toBe('比较 r1 与 r2');

    const provider = vscodeMock.providers.get(SNAPSHOT_DOCUMENT_SCHEME);
    expect(provider).toBeDefined();
    const leftUri = diff!.left as { scheme: string; path: string; query: string };
    const rightUri = diff!.right as { scheme: string; path: string; query: string };
    expect(parseSnapshotDocumentUri(leftUri as never)?.revision).toBe(1);
    expect(parseSnapshotDocumentUri(rightUri as never)?.revision).toBe(2);
    expect(provider!.provideTextDocumentContent(leftUri)).toBe('line1\n');
    expect(provider!.provideTextDocumentContent(rightUri)).toBe('line2\n');

    // 关闭左端文档 → 该内容键释放（右侧仍保留）。
    for (const handler of vscodeMock.closeHandlers) {
      handler({ uri: leftUri });
    }
    expect(provider!.provideTextDocumentContent(leftUri)).toContain('已释放');
    expect(provider!.provideTextDocumentContent(rightUri)).toBe('line2\n');
  });

  it('单端不存在：用空内容文档作为该端，不传不存在的 file URI', async () => {
    lab = buildRepo();
    const url = `${lab.repoUrl}/trunk/a.txt`;
    const outcome = await openSnapshotTextDiff({
      svnPath: 'svn',
      title: '新增',
      left: { revision: 1 },
      right: { rawUrl: url, revision: 1 },
    });
    expect(outcome.status).toBe('opened');
    const diff = lastDiff();
    expect(diff).toBeDefined();
    const provider = vscodeMock.providers.get(SNAPSHOT_DOCUMENT_SCHEME)!;
    const leftUri = diff!.left as { scheme: string; path: string; query: string };
    const rightUri = diff!.right as { scheme: string; path: string; query: string };
    expect(leftUri.scheme).toBe(SNAPSHOT_DOCUMENT_SCHEME);
    expect(provider.provideTextDocumentContent(leftUri)).toBe('');
    expect(provider.provideTextDocumentContent(rightUri)).toBe('line1\n');
    // 不存在一端的编辑器标签取 i18n 文案（不再是 '(absent)'）。
    expect(leftUri.path.endsWith(`/${snapshotText('displayNameAbsent')}`)).toBe(true);
    expect(leftUri.path).not.toContain('(absent)');
  });

  it('二进制端不进入文本差异（返回 binary 状态，不打开 diff）', async () => {
    lab = createSvnLab('svn-anywhere-snapshot-bin-');
    const wc = lab.checkout('wc');
    const binDir = tempDir('svn-anywhere-snapshot-bin-src-');
    writeFileSync(join(binDir, 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]));
    execSync(`mkdir -p ${join(wc, 'trunk')} && cp ${join(binDir, 'image.bin')} ${join(wc, 'trunk', 'image.bin')}`);
    lab.svn(['add', '-q', '--parents', 'trunk/image.bin'], wc);
    lab.svn(['commit', '-q', '-m', 'r1 binary'], wc);
    writeFileSync(join(wc, 'trunk', 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x0b]));
    lab.svn(['commit', '-q', '-m', 'r2 binary'], wc);

    const url = `${lab.repoUrl}/trunk/image.bin`;
    const outcome = await openSnapshotTextDiff({
      svnPath: 'svn',
      title: '二进制',
      left: { rawUrl: url, revision: 1 },
      right: { rawUrl: url, revision: 2 },
    });
    expect(outcome).toEqual({ status: 'binary', side: 'left' });
    expect(lastDiff()).toBeUndefined();
  });

  it('svn:special 符号链接显式识别，不进入文本差异', async () => {
    lab = createSvnLab('svn-anywhere-snapshot-special-');
    const wc = lab.checkout('wc');
    // 真实符号链接：svn add 自动设置 svn:special（普通文件 + propset 会报
    // E145001 节点类型意外变化）。
    execSync(`mkdir -p ${join(wc, 'trunk')} && ln -s target.txt ${join(wc, 'trunk', 'link.txt')}`);
    lab.svn(['add', '-q', '--parents', 'trunk/link.txt'], wc);
    lab.svn(['commit', '-q', '-m', 'r1 special'], wc);

    const url = `${lab.repoUrl}/trunk/link.txt`;
    const outcome = await openSnapshotTextDiff({
      svnPath: 'svn',
      title: '符号链接',
      left: { rawUrl: url, revision: 1 },
      right: { rawUrl: url, revision: 1 },
    });
    expect(outcome).toEqual({ status: 'special', side: 'left' });
    expect(lastDiff()).toBeUndefined();

    // 导出计划显式标记 svn:special（导出会恢复为真实符号链接，UI 需提示）。
    const plan = await planSnapshotExport('svn', {
      target: {
        url,
        repositoryRootUrl: lab.repoUrl,
        relativePath: 'trunk/link.txt',
        kind: 'file',
      },
      revision: 1,
      entries: [],
    });
    expect(plan).toMatchObject({ status: 'present', revision: 1, special: true });
  });

  it('文本实际超过内嵌上限：tooLarge 且不打开半读内容', async () => {
    lab = buildRepo();
    const url = `${lab.repoUrl}/trunk/a.txt`;
    const outcome = await openSnapshotTextDiff({
      svnPath: 'svn',
      title: '过大',
      left: { rawUrl: url, revision: 1 },
      right: { rawUrl: url, revision: 2 },
      inlineTextMaxBytes: 4,
    });
    expect(outcome).toMatchObject({ status: 'tooLarge', side: 'left' });
    expect(lastDiff()).toBeUndefined();
  });

  it('vscode.diff 失败：回收已写入的快照内容键，不残留内存文本', async () => {
    lab = buildRepo();
    const url = `${lab.repoUrl}/trunk/a.txt`;
    // 对照：成功打开期间两侧内容键各一条，关闭文档后清零（计数辅助可信）。
    const opened = await openSnapshotTextDiff({
      svnPath: 'svn',
      title: '对照',
      left: { rawUrl: url, revision: 1 },
      right: { rawUrl: url, revision: 2 },
    });
    expect(opened.status).toBe('opened');
    expect(snapshotContentCountForTest()).toBe(2);
    const diff = lastDiff()!;
    for (const handler of vscodeMock.closeHandlers) {
      handler({ uri: diff.left });
    }
    for (const handler of vscodeMock.closeHandlers) {
      handler({ uri: diff.right });
    }
    expect(snapshotContentCountForTest()).toBe(0);

    // 注入命令失败：结果 failed，已写入的内容键回收，不滞留到停用清理。
    vscodeMock.executeCommandError = new Error('vscode.diff 不可用');
    const outcome = await openSnapshotTextDiff({
      svnPath: 'svn',
      title: '失败',
      left: { rawUrl: url, revision: 1 },
      right: { rawUrl: url, revision: 2 },
    });
    expect(outcome).toMatchObject({ status: 'failed', message: 'vscode.diff 不可用' });
    expect(snapshotContentCountForTest()).toBe(0);
  });

  it('BASE 比较逐项复用：目录变化条目交给单文件 BASE diff', async () => {
    lab = buildRepo();
    const wc = join(lab.root, 'wc');
    writeFileSync(join(wc, 'trunk', 'a.txt'), 'work\n');
    const outcome = await openSnapshotBaseCompareEntry('svn', wc, {
      relPath: 'trunk/a.txt',
      wcStatus: 'modified',
      props: 'normal',
      kind: 'file',
    });
    expect(outcome).toBe('diffed');
    expect(lastDiff()).toBeDefined();
  });
});

describe.skipIf(!hasSvn)('promptSnapshotExport：保存对话框与覆盖确认', () => {
  function buildRepo(): { lab: SvnLab; url: string } {
    const local = createSvnLab('svn-anywhere-snapshot-save-');
    const wc = local.checkout('wc');
    writeFile(wc, 'trunk/file.txt', 'v1\n', true);
    local.svn(['commit', '-q', '-m', 'r1'], wc);
    writeFileSync(join(wc, 'trunk', 'file.txt'), 'v2\n');
    local.svn(['commit', '-q', '-m', 'r2'], wc);
    return { lab: local, url: `${local.repoUrl}/trunk/file.txt` };
  }

  it('宿主缺少保存对话框：返回 failed 并明示 exportNoSaveDialog', async () => {
    const plan = {
      status: 'present' as const,
      url: 'file:///repo/trunk/file.txt',
      revision: 2,
      repositoryPath: 'trunk/file.txt',
      nodeKind: 'file' as const,
    };
    const windowApi = vscode.window as unknown as { showSaveDialog?: unknown };
    const original = windowApi.showSaveDialog;
    windowApi.showSaveDialog = undefined;
    try {
      const outcome = await promptSnapshotExport({ svnPath: 'svn', plan, suggestedName: 'file.txt' });
      expect(outcome.status).toBe('failed');
      if (outcome.status === 'failed') {
        expect(outcome.message).toContain(snapshotText('exportNoSaveDialog'));
        expect(outcome.message).toContain('宿主缺少保存对话框');
      }
    } finally {
      windowApi.showSaveDialog = original;
    }
  });

  it('对话框取消：不写文件、不弹覆盖确认', async () => {
    const built = buildRepo();
    lab = built.lab;
    const outDir = tempDir('svn-anywhere-snapshot-save-out-');
    const outPath = join(outDir, 'file.txt');
    vscodeMock.saveDialogResult = undefined;
    const plan = await planSnapshotExport('svn', {
      target: { url: built.url, repositoryRootUrl: built.lab.repoUrl, relativePath: 'trunk/file.txt', kind: 'file' },
      revision: 2,
      entries: [],
    });
    expect(plan.status).toBe('present');
    if (plan.status !== 'present') {
      return;
    }
    const outcome = await promptSnapshotExport({
      svnPath: 'svn',
      plan,
      suggestedName: 'file.txt',
    });
    expect(outcome).toEqual({ status: 'canceled' });
    expect(vscodeMock.warnings).toEqual([]);
    expect(() => readFileSync(outPath, 'utf8')).toThrow();
  });

  it('导出成功：实际 revision 与产物内容；目标已存在时需显式覆盖确认', async () => {
    const built = buildRepo();
    lab = built.lab;
    const outDir = tempDir('svn-anywhere-snapshot-save-out-');
    const outPath = join(outDir, 'file.txt');
    const plan = await planSnapshotExport('svn', {
      target: { url: built.url, repositoryRootUrl: built.lab.repoUrl, relativePath: 'trunk/file.txt', kind: 'file' },
      revision: 2,
      entries: [],
    });
    expect(plan.status).toBe('present');
    if (plan.status !== 'present') {
      return;
    }
    vscodeMock.saveDialogResult = { fsPath: outPath };
    vscodeMock.warningResult = '覆盖';
    const first = await promptSnapshotExport({ svnPath: 'svn', plan, suggestedName: 'file.txt' });
    expect(first).toMatchObject({ status: 'exported', revision: 2, path: outPath });
    expect(readFileSync(outPath, 'utf8')).toBe('v2\n');

    // 第二次：目标已存在 → 模态确认（拒绝即取消，文件保持原内容）。
    writeFileSync(outPath, 'keep-original\n');
    vscodeMock.warningResult = undefined; // 选择第一个按钮之外的取消分支
    const second = await promptSnapshotExport({ svnPath: 'svn', plan, suggestedName: 'file.txt' });
    expect(second).toEqual({ status: 'canceled' });
    expect(vscodeMock.warnings.length).toBe(1);
    expect(readFileSync(outPath, 'utf8')).toBe('keep-original\n');

    // 确认覆盖 → 原子替换为目标版本内容。
    vscodeMock.warningResult = '覆盖';
    const third = await promptSnapshotExport({ svnPath: 'svn', plan, suggestedName: 'file.txt' });
    expect(third).toMatchObject({ status: 'exported', revision: 2 });
    expect(readFileSync(outPath, 'utf8')).toBe('v2\n');
  });

  it('删除前版本导出：返回实际 revision 与历史前序回退标记', async () => {
    lab = createSvnLab('svn-anywhere-snapshot-save-del-');
    const wc = lab.checkout('wc');
    writeFile(wc, 'trunk/gone.txt', 'v1\n', true);
    lab.svn(['commit', '-q', '-m', 'r1'], wc);
    writeFileSync(join(wc, 'trunk', 'gone.txt'), 'v2\n');
    lab.svn(['commit', '-q', '-m', 'r2'], wc);
    lab.svn(['update', '-q'], wc);
    lab.svn(['delete', '-q', '--', 'trunk/gone.txt'], wc);
    lab.svn(['commit', '-q', '-m', 'r3 delete'], wc);

    const target = {
      url: `${lab.repoUrl}/trunk/gone.txt`,
      repositoryRootUrl: lab.repoUrl,
      relativePath: 'trunk/gone.txt',
      kind: 'file' as const,
    };
    const plan = await planSnapshotExport('svn', { target, revision: 3, entries: [], deletionRevision: 3 });
    expect(plan.status).toBe('preceding');
    if (plan.status !== 'preceding') {
      return;
    }
    const outDir = tempDir('svn-anywhere-snapshot-save-del-out-');
    const outPath = join(outDir, 'gone.txt');
    vscodeMock.saveDialogResult = { fsPath: outPath };
    const outcome = await promptSnapshotExport({ svnPath: 'svn', plan, suggestedName: 'gone.txt' });
    expect(outcome).toEqual({
      status: 'exported',
      path: outPath,
      revision: 2,
      viaHistoryFallback: false,
    });
    expect(readFileSync(outPath, 'utf8')).toBe('v2\n');
  });
});
