/**
 * 日常操作命令（添加/删除/还原/移动/Finder 显示）的宿主侧链路测试：
 * mock vscode（确认框、输入框、命令转发），core 层走真实 svn 与本地
 * file:// 临时仓库，验证预检分支、模态确认与互斥、真实执行结果。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { setOperationRegistryForTest, getOperationRegistry } from '../src/core/operations';
import { disposeOutputChannel, resetOutputState, getOutputChannel } from '../src/host/output';
import { strings } from '../src/host/i18n';
import { createSvnLab, type SvnLab } from './helpers';

const vscodeMock = vi.hoisted(() => ({
  information: [] as string[],
  warning: [] as string[],
  /** 模态确认框返回的按钮；undefined 表示用户取消。 */
  confirmResult: undefined as string | undefined,
  /** InputBox 返回值（移动目标路径）。 */
  inputResult: undefined as string | undefined,
  inputPrompts: [] as string[],
  /** executeCommand 转发记录（revealFileInOS）。 */
  executedCommands: [] as Array<Array<unknown>>,
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
      return ch;
    },
    showInformationMessage: (message: string) => {
      vscodeMock.information.push(message);
      return Promise.resolve(undefined);
    },
    showWarningMessage: (message: string) => {
      vscodeMock.warning.push(message);
      return Promise.resolve(vscodeMock.confirmResult);
    },
    showErrorMessage: () => Promise.resolve(undefined),
    showInputBox: (options: { prompt?: string; value?: string }) => {
      vscodeMock.inputPrompts.push(options.prompt ?? '');
      return Promise.resolve(vscodeMock.inputResult);
    },
    showOpenDialog: () => Promise.resolve(undefined),
    get activeTextEditor() {
      return vscodeMock.activeTextEditor;
    },
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
  commands: {
    executeCommand: async (command: string, ...args: unknown[]) => {
      vscodeMock.executedCommands.push([command, ...args]);
      return undefined;
    },
  },
}));

import { commandAdd } from '../src/host/commands/add';
import { resolveBatchTargetGroups } from '../src/host/commands/target';
import { commandDelete } from '../src/host/commands/delete';
import { commandRevert } from '../src/host/commands/revert';
import { commandMove } from '../src/host/commands/move';
import { commandReveal } from '../src/host/commands/reveal';

const makeUri = (fsPath: string): vscode.Uri => ({ fsPath, scheme: 'file' }) as unknown as vscode.Uri;
const channelText = (): string => {
  const channel = getOutputChannel();
  return channel ? (channel as unknown as { lines: string[] }).lines.join('\n') : '';
};

let lab: SvnLab;
let wc: string;

const svnCli = (args: string[], cwd = wc) => execFileSync('svn', args, { cwd, encoding: 'utf8' });
const writeFile = (rel: string, content: string) =>
  execFileSync('sh', ['-c', `printf ${JSON.stringify(content)} > ${JSON.stringify(join(wc, rel))}`]);
const writeFileAbs = (abs: string, content: string) =>
  execFileSync('sh', ['-c', `printf ${JSON.stringify(content)} > ${JSON.stringify(abs)}`]);

beforeAll(() => {
  lab = createSvnLab('svn-anywhere-dailycmd-');
  wc = lab.checkout('wc');
  execFileSync('svn', ['mkdir', '-q', '--parents', 'tree/inner'], { cwd: wc });
  writeFile('tree/inner/f.txt', 'v1\n');
  writeFile('tree/g.txt', 'v1\n');
  writeFile('mod.txt', 'v1\n');
  execFileSync(
    'svn',
    ['add', '-q', '--parents', 'tree/inner/f.txt', 'tree/g.txt', 'mod.txt'],
    { cwd: wc },
  );
  execFileSync('svn', ['commit', '-q', '-m', 'init'], { cwd: wc });
});

afterAll(() => {
  lab.cleanup();
});

beforeEach(() => {
  disposeOutputChannel();
  resetOutputState();
  vscodeMock.information.length = 0;
  vscodeMock.warning.length = 0;
  vscodeMock.confirmResult = undefined;
  vscodeMock.inputResult = undefined;
  vscodeMock.inputPrompts.length = 0;
  vscodeMock.executedCommands.length = 0;
  vscodeMock.activeTextEditor = undefined;
});

afterEach(async () => {
  // 回到基线：撤销一切登记与修改，删掉未版本控制残留。
  try {
    execFileSync('svn', ['revert', '-q', '-R', '.'], { cwd: wc });
    for (const rel of ['new.txt', 'moved.txt', 'renamed.txt', 'u.txt', 'exists.txt', 'held.txt', 'stash.tmp']) {
      const abs = join(wc, rel);
      if (existsSync(abs)) {
        execFileSync('sh', ['-c', `rm ${JSON.stringify(abs)}`]);
      }
    }
    if (existsSync(join(wc, 'deep'))) {
      execFileSync('sh', ['-c', `rm -rf ${JSON.stringify(join(wc, 'deep'))}`]);
    }
  } catch {
    // 基线恢复失败不阻塞后续断言（下一条用例自行重置）。
  }
  setOperationRegistryForTest(undefined);
});

describe('commandAdd（添加）', () => {
  it('unversioned 文件：登记添加成功（status A），提示含路径', async () => {
    writeFile('new.txt', 'v1\n');
    await commandAdd(makeUri(join(wc, 'new.txt')));
    expect(svnCli(['status'])).toMatch(/^A\s+new\.txt/m);
    expect(vscodeMock.information.some((m) => m.includes('new.txt'))).toBe(true);
  });

  it('深层路径：--parents 补齐未版本控制上级目录', async () => {
    execFileSync('sh', ['-c', `mkdir -p ${JSON.stringify(join(wc, 'deep/inner'))}`]);
    writeFile('deep/inner/n.txt', 'x\n');
    await commandAdd(makeUri(join(wc, 'deep/inner/n.txt')));
    const status = svnCli(['status']);
    expect(status).toMatch(/^A\s+deep$/m);
    expect(status).toMatch(/^A\s+deep\/inner$/m);
  });

  it('已版本控制目标：提示且不执行 add', async () => {
    await commandAdd(makeUri(join(wc, 'mod.txt')));
    expect(vscodeMock.information.some((m) => m.includes('已在版本控制'))).toBe(true);
    expect(channelText()).not.toContain('> svn add');
  });

  it('副本上有未完成操作（unknown）时拒绝执行', async () => {
    writeFile('held.txt', 'x\n');
    const registry = getOperationRegistry();
    const begin = await registry.begin({ wcRoot: wc, targetRelPath: '.', nodeKind: 'dir' });
    await registry.markPhase(begin.ok ? begin.operationId : '', 'unknown');
    await commandAdd(makeUri(join(wc, 'held.txt')));
    expect(vscodeMock.warning.some((m) => m.includes('未完成操作'))).toBe(true);
    expect(svnCli(['status'])).not.toMatch(/^A\s+held\.txt/m);
    if (begin.ok) {
      await registry.finish(begin.operationId);
    }
  });
});

describe('commandDelete（删除）', () => {
  it('确认框写明删除本地文件与不可逆性；确认后本地文件消失并登记删除', async () => {
    vscodeMock.confirmResult = strings.deleteOp.confirmButton;
    await commandDelete(makeUri(join(wc, 'mod.txt')));
    const confirm = vscodeMock.warning.find((m) => m.includes('mod.txt'));
    expect(confirm).toContain('删除本地文件并登记 SVN 删除');
    expect(confirm).toContain(strings.deleteOp.irreversibleNote);
    expect(existsSync(join(wc, 'mod.txt'))).toBe(false);
    expect(svnCli(['status'])).toMatch(/^D\s+mod\.txt/m);
  });

  it('取消确认：不执行删除', async () => {
    vscodeMock.confirmResult = undefined;
    await commandDelete(makeUri(join(wc, 'mod.txt')));
    expect(existsSync(join(wc, 'mod.txt'))).toBe(true);
    expect(svnCli(['status'])).not.toMatch(/^D\s+mod\.txt/m);
  });

  it('目录删除：确认框枚举完整影响子树', async () => {
    vscodeMock.confirmResult = strings.deleteOp.confirmButton;
    await commandDelete(makeUri(join(wc, 'tree')));
    const confirm = vscodeMock.warning.find((m) => m.includes('tree'));
    expect(confirm).toContain('tree/g.txt');
    expect(confirm).toContain('tree/inner/f.txt');
    expect(confirm).toContain(strings.deleteOp.dirNote);
    expect(existsSync(join(wc, 'tree'))).toBe(false);
    expect(svnCli(['status'])).toMatch(/^D\s+tree$/m);
  });

  it('unversioned 目标：提示不走 SVN 删除，不弹确认', async () => {
    writeFile('u.txt', 'x\n');
    await commandDelete(makeUri(join(wc, 'u.txt')));
    expect(vscodeMock.information.some((m) => m.includes('未纳入版本控制'))).toBe(true);
    expect(existsSync(join(wc, 'u.txt'))).toBe(true);
  });
});

describe('commandRevert（还原）', () => {
  it('确认框列出数量与路径；确认后修改被丢弃', async () => {
    writeFile('mod.txt', 'v2\n');
    vscodeMock.confirmResult = strings.revert.confirmButton;
    await commandRevert(makeUri(join(wc, 'mod.txt')));
    const confirm = vscodeMock.warning.find((m) => m.includes('mod.txt'));
    expect(confirm).toContain('1 个路径');
    expect(confirm).toContain(strings.revert.irreversibleNote);
    expect(svnCli(['status'])).not.toMatch(/^M\s+mod\.txt/m);
    expect(readFileSync(join(wc, 'mod.txt'), 'utf8')).toBe('v1\n');
  });

  it('整目录递归还原：确认含子项数量与递归说明', async () => {
    writeFile('tree/inner/f.txt', 'v2\n');
    execFileSync('svn', ['propset', '-q', 'svn:ignore', 'zzz', 'tree'], { cwd: wc });
    vscodeMock.confirmResult = strings.revert.confirmButton;
    await commandRevert(makeUri(join(wc, 'tree')));
    const confirm = vscodeMock.warning.find((m) => m.includes('tree'));
    expect(confirm).toContain('2 个路径');
    expect(confirm).toContain(strings.revert.dirNote);
    expect(svnCli(['status'])).toBe('');
  });

  it('无本地修改：提示无可还原，不弹确认', async () => {
    await commandRevert(makeUri(join(wc, 'mod.txt')));
    expect(vscodeMock.information.some((m) => m.includes('没有可还原'))).toBe(true);
    expect(vscodeMock.warning).toHaveLength(0);
  });

  it('取消确认：不执行还原', async () => {
    writeFile('mod.txt', 'v2\n');
    vscodeMock.confirmResult = undefined;
    await commandRevert(makeUri(join(wc, 'mod.txt')));
    expect(readFileSync(join(wc, 'mod.txt'), 'utf8')).toBe('v2\n');
  });

  it('missing 文件（本地已删未登记）：可定位副本并确认后恢复文件', async () => {
    execFileSync('sh', ['-c', `rm ${JSON.stringify(join(wc, 'mod.txt'))}`]);
    vscodeMock.confirmResult = strings.revert.confirmButton;
    await commandRevert(makeUri(join(wc, 'mod.txt')));
    const confirm = vscodeMock.warning.find((m) => m.includes('mod.txt'));
    expect(confirm).toContain('1 个路径');
    expect(readFileSync(join(wc, 'mod.txt'), 'utf8')).toBe('v1\n');
  });

  it('externals 边界：目录递归清单不含 external 内条目；external 内文件可单独还原', async () => {
    // 独立实验场：主仓库 + external 仓库（svn:externals 指向）。
    const extLab = createSvnLab('svn-anywhere-revext-');
    const extSeed = extLab.checkout('seed');
    execFileSync('svn', ['mkdir', '-q', 'ext'], { cwd: extSeed });
    execFileSync('sh', ['-c', `printf v1 > ${JSON.stringify(join(extSeed, 'ext/s.txt'))}`]);
    execFileSync('svn', ['add', '-q', '--parents', 'ext/s.txt'], { cwd: extSeed });
    execFileSync('svn', ['commit', '-q', '-m', 'ext init'], { cwd: extSeed });
    const mainWc = extLab.checkout('main');
    execFileSync('svn', ['mkdir', '-q', 'holder'], { cwd: mainWc });
    execFileSync('sh', ['-c', `printf v1 > ${JSON.stringify(join(mainWc, 'a.txt'))}`]);
    execFileSync('svn', ['add', '-q', '--parents', 'a.txt'], { cwd: mainWc });
    execFileSync('svn', ['commit', '-q', '-m', 'init'], { cwd: mainWc });
    execFileSync('svn', ['propset', '-q', 'svn:externals', `ext ${extLab.repoUrl}/ext`, 'holder'], { cwd: mainWc });
    execFileSync('svn', ['commit', '-q', '-m', 'add external'], { cwd: mainWc });
    execFileSync('svn', ['update', '-q'], { cwd: mainWc });
    try {
      writeFileAbs(join(mainWc, 'a.txt'), 'v2\n');
      writeFileAbs(join(mainWc, 'holder/ext/s.txt'), 'v2\n');
      // 目标是主副本根目录：svn revert -R 不跨 external，确认清单须隔离。
      vscodeMock.confirmResult = strings.revert.confirmButton;
      const warnBefore = vscodeMock.warning.length;
      await commandRevert(makeUri(mainWc));
      const confirm = vscodeMock.warning.slice(warnBefore).find((m) => m.includes('a.txt'));
      expect(confirm).toBeDefined();
      expect(confirm).toContain('1 个路径');
      expect(confirm).not.toContain('holder/ext/s.txt');
      expect(readFileSync(join(mainWc, 'a.txt'), 'utf8')).toBe('v1');
      expect(readFileSync(join(mainWc, 'holder/ext/s.txt'), 'utf8')).toBe('v2\n');
      // 用户明确选中 external 内具体文件：svn revert 作用于该 external 副本。
      await commandRevert(makeUri(join(mainWc, 'holder/ext/s.txt')));
      expect(readFileSync(join(mainWc, 'holder/ext/s.txt'), 'utf8')).toBe('v1');
    } finally {
      extLab.cleanup();
    }
  });
});

describe('commandMove（移动）', () => {
  it('输入目标后执行 svn move：登记 A/D 且提交后保留历史', async () => {
    vscodeMock.inputResult = join(wc, 'renamed.txt');
    await commandMove(makeUri(join(wc, 'mod.txt')));
    expect(existsSync(join(wc, 'renamed.txt'))).toBe(true);
    expect(existsSync(join(wc, 'mod.txt'))).toBe(false);
    const status = svnCli(['status']);
    expect(status).toMatch(/^D\s+mod\.txt/m);
    expect(status).toMatch(/^A\s+\+\s+renamed\.txt/m);
    execFileSync('svn', ['commit', '-q', '-m', 'rename mod'], { cwd: wc });
    expect(svnCli(['log', '--verbose', '-r', 'HEAD'])).toContain('(from /mod.txt:');
    // 基线恢复：把改名提交撤销不了，改为重建基线（move 回原名）。
    execFileSync('svn', ['move', '-q', 'renamed.txt', 'mod.txt'], { cwd: wc });
    execFileSync('svn', ['commit', '-q', '-m', 'restore mod name'], { cwd: wc });
  });

  it('源被文件系统移动（missing）：提示改用 svn move，不执行任何操作', async () => {
    execFileSync('sh', ['-c', `mv ${JSON.stringify(join(wc, 'mod.txt'))} ${JSON.stringify(join(wc, 'stash.tmp'))}`]);
    try {
      await commandMove(makeUri(join(wc, 'mod.txt')));
      expect(vscodeMock.warning.some((m) => m.includes('文件系统移动') || m.includes('移回原位置'))).toBe(true);
      expect(vscodeMock.inputPrompts).toHaveLength(0);
      expect(channelText()).not.toContain('> svn move');
    } finally {
      execFileSync('sh', ['-c', `mv ${JSON.stringify(join(wc, 'stash.tmp'))} ${JSON.stringify(join(wc, 'mod.txt'))}`]);
    }
  });

  it('unversioned 源：提示先添加', async () => {
    writeFile('u.txt', 'x\n');
    await commandMove(makeUri(join(wc, 'u.txt')));
    expect(vscodeMock.information.some((m) => m.includes('未纳入版本控制'))).toBe(true);
    expect(vscodeMock.inputPrompts).toHaveLength(0);
  });

  it('目标与源相同：提示并终止', async () => {
    vscodeMock.inputResult = join(wc, 'mod.txt');
    await commandMove(makeUri(join(wc, 'mod.txt')));
    expect(vscodeMock.information.some((m) => m.includes('与源相同'))).toBe(true);
    expect(channelText()).not.toContain('> svn move');
  });

  it('目标路径已存在：提示并终止', async () => {
    writeFile('exists.txt', 'x\n');
    vscodeMock.inputResult = join(wc, 'exists.txt');
    await commandMove(makeUri(join(wc, 'mod.txt')));
    expect(vscodeMock.information.some((m) => m.includes('已存在'))).toBe(true);
    expect(channelText()).not.toContain('> svn move');
  });
});

describe('commandReveal（在 Finder 中显示）', () => {
  it('右键 uri：直接转发 revealFileInOS，不要求工作副本', async () => {
    const uri = makeUri('/outside/any/file.txt');
    await commandReveal(uri);
    expect(vscodeMock.executedCommands).toEqual([['revealFileInOS', uri]]);
  });

  it('无 uri 时回退活动编辑器（file 文档）', async () => {
    const editorUri = { scheme: 'file', fsPath: join(wc, 'mod.txt') };
    vscodeMock.activeTextEditor = { document: { uri: editorUri } };
    await commandReveal(undefined);
    expect(vscodeMock.executedCommands).toEqual([['revealFileInOS', editorUri]]);
  });

  it('无 uri 且无本地文件编辑器：静默返回', async () => {
    await commandReveal(undefined);
    expect(vscodeMock.executedCommands).toHaveLength(0);
  });
});

describe('resolveBatchTargetGroups（多选选区分组与去重）', () => {
  // 独立实验场：外层副本 + 其内部 checkout 的独立嵌套副本（外层 status 中
  // 为 unversioned，外层 update/commit 均不作用于嵌套副本——svn 1.15 实测）。
  const labGroups = createSvnLab('svn-anywhere-batchgroup-');
  const outer = labGroups.checkout('outer');
  const nestedWc = join(outer, 'nested-wc');
  execFileSync('svn', ['checkout', '-q', labGroups.repoUrl, nestedWc]);
  afterAll(() => {
    labGroups.cleanup();
  });

  it('同一副本内的嵌套选区：去重只保留最外层，一组多目标', () => {
    const groups = resolveBatchTargetGroups(
      [makeUri(join(outer, 'd1/a.txt')), makeUri(join(outer, 'd1')), makeUri(join(outer, 'd2'))],
      strings.command.update,
      'update',
    );
    expect(groups).toEqual([
      { wcRoot: outer, targetPaths: [join(outer, 'd1'), join(outer, 'd2')] },
    ]);
  });

  it('跨副本嵌套选区：独立嵌套副本不被字符串去重吞掉，自成一组', () => {
    const groups = resolveBatchTargetGroups(
      [makeUri(outer), makeUri(nestedWc)],
      strings.command.update,
      'update',
    );
    expect(groups).toEqual([
      { wcRoot: outer, targetPaths: [outer] },
      { wcRoot: nestedWc, targetPaths: [nestedWc] },
    ]);
  });

  it('嵌套副本内的深层路径归嵌套组（findWorkingCopy 命中最近副本）', () => {
    const groups = resolveBatchTargetGroups(
      [makeUri(outer), makeUri(join(nestedWc, 'sub/f.txt'))],
      strings.command.commit,
      'commit',
    );
    expect(groups).toHaveLength(2);
    expect(groups[1]).toEqual({ wcRoot: nestedWc, targetPaths: [join(nestedWc, 'sub/f.txt')] });
  });

  it('非副本路径跳过并提示；两组各写一条定位留痕', () => {
    const infoBefore = vscodeMock.information.length;
    const groups = resolveBatchTargetGroups(
      [makeUri(join(outer, 'd1')), makeUri('/definitely/not/exist/path')],
      strings.command.update,
      'update',
    );
    expect(groups).toEqual([{ wcRoot: outer, targetPaths: [join(outer, 'd1')] }]);
    expect(vscodeMock.information.slice(infoBefore)).toEqual([strings.error.notWorkingCopy]);
    // 定位留痕写入传入 kind 的频道（与命令的输出频道一致）。
    const updateChannel = getOutputChannel('update') as unknown as { lines: string[] };
    expect(updateChannel?.lines.join('\n')).toContain(`[定位] 更新：目标 ${join(outer, 'd1')}`);
  });
});
