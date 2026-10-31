/**
 * 日常操作 core 层测试：命令参数构造（peg/选项保护与扩展位）、
 * 可还原条目枚举，以及基于本地 svnadmin + file:// 临时仓库的真实
 * 执行链路（添加/删除/还原/移动的命令封装与终端行为一致）。
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildAddArgs,
  buildDeleteArgs,
  buildMoveArgs,
  buildRevertArgs,
  isInsideExternalPrefixes,
  isVersioned,
  listVersionedSubtree,
  revertableEntries,
} from '../src/core/dailyOps';
import { runStatus, parseStatusXml, type StatusEntry } from '../src/core/status';
import { runOrThrow } from '../src/core/svnCli';
import { createSvnLab, type SvnLab } from './helpers';

describe('buildAddArgs / buildDeleteArgs / buildRevertArgs / buildMoveArgs', () => {
  it('add：普通路径加 -- 保护；目录补 --parents', () => {
    expect(buildAddArgs('a.txt')).toEqual(['add', '--', 'a.txt']);
    expect(buildAddArgs('newdir', { parents: true })).toEqual(['add', '--parents', '--', 'newdir']);
  });

  it('delete：force 组合与 --keep-local 扩展位', () => {
    expect(buildDeleteArgs('a.txt')).toEqual(['delete', '--', 'a.txt']);
    expect(buildDeleteArgs('mod.txt', { force: true })).toEqual(['delete', '--force', '--', 'mod.txt']);
    expect(buildDeleteArgs('a.txt', { keepLocal: true })).toEqual([
      'delete',
      '--keep-local',
      '--',
      'a.txt',
    ]);
  });

  it('revert：整目录递归加 -R', () => {
    expect(buildRevertArgs('a.txt')).toEqual(['revert', '--', 'a.txt']);
    expect(buildRevertArgs('tree', { recursive: true })).toEqual(['revert', '-R', '--', 'tree']);
  });

  it('move：源与目标各自转义', () => {
    expect(buildMoveArgs('a.txt', 'b.txt')).toEqual(['move', '--', 'a.txt', 'b.txt']);
  });

  it('短横线开头的路径前置 ./ 防选项注入；含 @ 的路径尾部补 peg 分隔符', () => {
    expect(buildAddArgs('--targets=manifest')).toEqual(['add', '--', './--targets=manifest']);
    expect(buildDeleteArgs('a@1', { force: true })).toEqual(['delete', '--force', '--', 'a@1@']);
    expect(buildRevertArgs('-weird')).toEqual(['revert', '--', './-weird']);
    expect(buildMoveArgs('a@1', 'a@1@')).toEqual(['move', '--', 'a@1@', 'a@1@@']);
  });

  it('isInsideExternalPrefixes：边界目录与其内部路径命中，相似前缀不误伤', () => {
    const prefixes = ['vendor', 'ext-holder/ext'];
    expect(isInsideExternalPrefixes('vendor', prefixes)).toBe(true);
    expect(isInsideExternalPrefixes('vendor/lib/a.txt', prefixes)).toBe(true);
    expect(isInsideExternalPrefixes('ext-holder/ext/s.txt', prefixes)).toBe(true);
    // 前缀相同开头但不是目录边界的不命中（vendor-x ≠ vendor/…）。
    expect(isInsideExternalPrefixes('vendor-x/a.txt', prefixes)).toBe(false);
    expect(isInsideExternalPrefixes('a.txt', prefixes)).toBe(false);
    expect(isInsideExternalPrefixes('ext-holder', prefixes)).toBe(false);
  });
});

describe('revertableEntries', () => {
  const entry = (path: string, wcStatus: string, props = 'none'): StatusEntry => ({
    path,
    wcStatus,
    props,
    changelist: null,
  });

  it('保留 modified/added/deleted/missing/replaced/conflicted 与纯属性修改', () => {
    const entries = [
      entry('m.txt', 'modified'),
      entry('a.txt', 'added'),
      entry('d.txt', 'deleted'),
      entry('x.txt', 'missing'),
      entry('r.txt', 'replaced'),
      entry('c.txt', 'conflicted'),
      entry('prop.txt', 'normal', 'modified'),
    ];
    expect(revertableEntries(entries).map((e) => e.path)).toEqual([
      'm.txt',
      'a.txt',
      'd.txt',
      'x.txt',
      'r.txt',
      'c.txt',
      'prop.txt',
    ]);
  });

  it('排除 unversioned 与无修改的 normal 条目', () => {
    const entries = [entry('u.txt', 'unversioned'), entry('n.txt', 'normal')];
    expect(revertableEntries(entries)).toEqual([]);
  });
});

describe('真实 SVN 执行链路（本地 file:// 临时仓库）', () => {
  let lab: SvnLab;
  let wc: string;

  const statusOf = (target: string) =>
    runStatus('svn', target, { cwd: wc }).then((r) => r.entries);
  const run = (args: string[]) => runOrThrow('svn', args, { cwd: wc });
  const rawStatus = () =>
    execFileSync('svn', ['status'], { cwd: wc, encoding: 'utf8' });
  const writeFile = (rel: string, content: string) =>
    execFileSync('sh', ['-c', `printf ${JSON.stringify(content)} > ${JSON.stringify(join(wc, rel))}`]);

  beforeAll(() => {
    lab = createSvnLab('svn-anywhere-daily-');
    wc = lab.checkout('wc');
    execFileSync('svn', ['mkdir', '-q', '--parents', 'tree/inner'], { cwd: wc });
    writeFile('tree/inner/f.txt', 'v1\n');
    writeFile('tree/g.txt', 'v1\n');
    execFileSync('svn', ['add', '-q', '--parents', 'tree/inner/f.txt', 'tree/g.txt'], { cwd: wc });
    execFileSync('svn', ['commit', '-q', '-m', 'init'], { cwd: wc });
  });

  afterAll(() => {
    lab.cleanup();
  });

  it('buildAddArgs 真实登记未版本控制文件与目录（--parents 补上级）', async () => {
    writeFile('new.txt', 'v1\n');
    await run(buildAddArgs('new.txt'));
    let entries = await statusOf('new.txt');
    expect(entries.find((e) => e.path === 'new.txt')?.wcStatus).toBe('added');

    // 深层未版本控制目录：中间目录一并登记。
    execFileSync('sh', ['-c', `mkdir -p ${JSON.stringify(join(wc, 'deep/inner'))} && printf x > ${JSON.stringify(join(wc, 'deep/inner/f.txt'))}`]);
    await run(buildAddArgs('deep/inner/f.txt', { parents: true }));
    entries = await statusOf('.');
    expect(entries.find((e) => e.path === 'deep')?.wcStatus).toBe('added');
    expect(entries.find((e) => e.path === 'deep/inner')?.wcStatus).toBe('added');
    expect(entries.find((e) => e.path === 'deep/inner/f.txt')?.wcStatus).toBe('added');
    await run(buildRevertArgs('.', { recursive: true }));
  });

  it('buildDeleteArgs 真实删除本地文件并登记；keepLocal 只登记不删本地', async () => {
    // 基线已提交的文件：delete 默认同时删除本地并登记 SVN 删除。
    await run(buildDeleteArgs('tree/g.txt', { force: true }));
    const entries = await statusOf('tree/g.txt');
    expect(entries.find((e) => e.path === 'tree/g.txt')?.wcStatus).toBe('deleted');
    expect(rawStatus()).not.toMatch(/^!\s/m); // 本地文件已被删除，无 missing 残留
    await run(buildRevertArgs('tree/g.txt'));

    // --keep-local 扩展位：登记删除但保留本地文件。
    await run(buildDeleteArgs('tree/g.txt', { force: true, keepLocal: true }));
    const after = await statusOf('tree/g.txt');
    expect(after.find((e) => e.path === 'tree/g.txt')?.wcStatus).toBe('deleted');
    expect(rawStatus()).not.toMatch(/^!\s/m); // 本地文件仍在（非 missing）
    await run(buildRevertArgs('tree/g.txt'));
  });

  it('buildRevertArgs 撤销修改；目录递归还原子文件修改与目录属性', async () => {
    writeFile('tree/inner/f.txt', 'v2\n');
    await run(buildRevertArgs('tree/inner/f.txt'));
    expect(revertableEntries(await statusOf('tree'))).toEqual([]);

    // 目录递归：子文件修改与目录属性一并还原。
    writeFile('tree/inner/f.txt', 'v3\n');
    execFileSync('svn', ['propset', '-q', 'svn:ignore', 'zzz', 'tree'], { cwd: wc });
    await run(buildRevertArgs('tree', { recursive: true }));
    expect(revertableEntries(await statusOf('tree'))).toEqual([]);
  });

  it('buildMoveArgs 真实移动并保留历史（commit 后 log 显示改名来源）', async () => {
    writeFile('move.txt', 'v1\n');
    await run(buildAddArgs('move.txt'));
    execFileSync('svn', ['commit', '-q', '-m', 'add move.txt'], { cwd: wc });
    await run(buildMoveArgs('move.txt', 'moved.txt'));
    const entries = await statusOf('.');
    expect(entries.find((e) => e.path === 'move.txt')?.wcStatus).toBe('deleted');
    expect(entries.find((e) => e.path === 'moved.txt')?.wcStatus).toBe('added');
    execFileSync('svn', ['commit', '-q', '-m', 'rename move.txt'], { cwd: wc });
    const log = lab.svn(['log', '--verbose', '-r', 'HEAD'], wc);
    expect(log).toContain('(from /move.txt:');
  });

  it('listVersionedSubtree 只列文件行；目录不存在时返回空清单', async () => {
    const subtree = await listVersionedSubtree('svn', wc, 'tree', {});
    expect(subtree).toEqual(expect.arrayContaining(['g.txt', 'inner/f.txt']));
    expect(subtree.every((line) => !line.endsWith('/'))).toBe(true);
    expect(await listVersionedSubtree('svn', wc, 'no-such-dir', {})).toEqual([]);
  });

  it('isVersioned：normal 与深层 unversioned（status 均无条目）可靠区分', async () => {
    // normal 已提交文件：status 无条目，svn info 成功。
    expect(await isVersioned('svn', wc, 'tree/g.txt', {})).toBe(true);
    // 深层未版本控制：status 同样无条目（父目录未纳管时 svn 不进入）。
    execFileSync('sh', ['-c', `mkdir -p ${JSON.stringify(join(wc, 'far/inner'))} && printf x > ${JSON.stringify(join(wc, 'far/inner/n.txt'))}`]);
    expect(await isVersioned('svn', wc, 'far/inner/n.txt', {})).toBe(false);
    expect(await isVersioned('svn', wc, 'fresh-u.txt', {})).toBe(false);
  });
});

describe('parseStatusXml 目标条目识别（右键命令状态预检依据）', () => {
  it('unversioned 单目标产生一条 entry；normal 目标无条目', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<status>
<target path="u.txt">
<entry path="u.txt"><wc-status item="unversioned" props="none"></wc-status></entry>
</target>
</status>`;
    const parsed = parseStatusXml(xml);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.wcStatus).toBe('unversioned');
  });
});
