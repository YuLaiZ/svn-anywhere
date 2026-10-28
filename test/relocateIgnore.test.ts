/**
 * svn:ignore 规则读写（F121）与 svn relocate（F118）的集成测试，
 * 走本地 svnadmin + file:// 副本；relocate 用「移动仓库目录」构造
 * UUID 一致的换地址场景。
 */
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildWriteArgs, mergeIgnoreRules, parseIgnoreRules, readIgnoreRules } from '../src/core/ignore';
import { buildRelocateArgs, readRepositoryUrl } from '../src/core/relocate';
import { runOrThrow } from '../src/core/svnCli';
import { createSvnLab, writeFile } from './helpers';

const lab = createSvnLab('svn-anywhere-relign-');
afterAll(() => lab.cleanup());

describe('svn:ignore 规则', () => {
  it('parseIgnoreRules 与 mergeIgnoreRules：去重、保序、新规则追加末尾', () => {
    expect(parseIgnoreRules('*.log\nbuild\n')).toEqual(['*.log', 'build']);
    expect(parseIgnoreRules('')).toEqual([]);
    expect(mergeIgnoreRules(['*.log', 'build'], ['dist', '*.log'], [])).toEqual(['*.log', 'build', 'dist']);
    expect(mergeIgnoreRules(['*.log', 'build'], [], ['*.log'])).toEqual(['build']);
    expect(mergeIgnoreRules(['build'], [], ['build'])).toEqual([]);
  });

  it('属性不存在时 readIgnoreRules 容错返回空规则（实测 W200017 退出码非 0）', async () => {
    const wc = lab.checkout('ig-empty');
    writeFile(wc, 'a.txt', 'v', true);
    lab.svn(['commit', '-q', '-m', 'init'], wc);
    // svn 1.15 对无属性 propget 报 W200017 且退出码非 0，属正常情形。
    await expect(readIgnoreRules('svn', '.', { cwd: wc })).resolves.toEqual([]);
  });

  it('propset 写回后 propget 可读，propdel 可清空；被忽略文件不再出现在 status', async () => {
    const wc = lab.checkout('ig-rw');
    writeFile(wc, 'keep.txt', 'v', true);
    lab.svn(['commit', '-q', '-m', 'init'], wc);

    // 加入 *.log 规则（经临时文件 propset -F）
    const rulesFile = join(lab.root, 'ignore-rules.txt');
    writeFileSync(rulesFile, '*.log\n', 'utf8');
    await runOrThrow('svn', buildWriteArgs(['*.log'], '.', rulesFile), { cwd: wc });
    await expect(readIgnoreRules('svn', '.', { cwd: wc })).resolves.toEqual(['*.log']);

    // 被忽略文件不再出现在 status（完成标志：加入忽略后 status 不再显示）
    writeFile(wc, 'debug.log', 'noise');
    expect(lab.svn(['status'], wc)).not.toContain('debug.log');

    // 追加第二条规则：*.log 保持在前，dist 追加末尾
    writeFileSync(rulesFile, '*.log\ndist\n', 'utf8');
    await runOrThrow('svn', buildWriteArgs(['*.log', 'dist'], '.', rulesFile), { cwd: wc });
    await expect(readIgnoreRules('svn', '.', { cwd: wc })).resolves.toEqual(['*.log', 'dist']);

    // 清空规则：propdel 后属性不存在，readIgnoreRules 容错返回空。
    await runOrThrow('svn', buildWriteArgs([], '.', rulesFile), { cwd: wc });
    await expect(readIgnoreRules('svn', '.', { cwd: wc })).resolves.toEqual([]);
  });

  it('buildWriteArgs：有规则时 propset -F，清空时 propdel；目录含 @ 转义', () => {
    expect(buildWriteArgs(['*.log'], 'src', '/tmp/rules.txt')).toEqual([
      'propset', 'svn:ignore', '-F', '/tmp/rules.txt', 'src',
    ]);
    expect(buildWriteArgs([], 'src', '/tmp/rules.txt')).toEqual(['propdel', 'svn:ignore', 'src']);
    expect(buildWriteArgs(['*.log'], 'dir@2', '/tmp/rules.txt')).toEqual([
      'propset', 'svn:ignore', '-F', '/tmp/rules.txt', 'dir@2@',
    ]);
  });
});

describe('svn relocate（F118）', () => {
  it('同仓库换地址（移动仓库目录保持 UUID）：relocate 后 info 显示新地址且能继续更新', async () => {
    const oldUrl = lab.repoUrl;
    const wc = lab.checkout('rel-wc');
    writeFile(wc, 'r.txt', 'v', true);
    lab.svn(['commit', '-q', '-m', 'init'], wc);
    const other = lab.checkout('rel-other');

    // 移动仓库目录：UUID 不变，URL 变化，relocate 的合法场景。
    const newUrl = `${lab.repoUrl}-moved`;
    renameSync(join(lab.root, 'repo'), join(lab.root, 'repo-moved'));

    expect(await readRepositoryUrl('svn', wc, { cwd: wc })).toBe(oldUrl);
    await runOrThrow('svn', buildRelocateArgs(newUrl, wc), { cwd: wc });
    expect(await readRepositoryUrl('svn', wc, { cwd: wc })).toBe(newUrl);

    // relocate 后仍能继续更新（完成标志：改地址后能继续更新）
    await runOrThrow('svn', buildRelocateArgs(newUrl, other), { cwd: other });
    writeFile(other, 'new-remote.txt', 'x', true);
    lab.svn(['commit', '-q', '-m', 'remote add'], other);
    const up = await runOrThrow('svn', ['update', '--non-interactive', '.'], { cwd: wc });
    expect(up.stdout).toContain('new-remote.txt');

    // 换到不同仓库（UUID 不同）：失败且报错
    const foreignLab = createSvnLab('svn-anywhere-relign-foreign-');
    try {
      await expect(
        runOrThrow('svn', buildRelocateArgs(`file://${foreignLab.root}/repo`, wc), { cwd: wc }),
      ).rejects.toThrow();
    } finally {
      foreignLab.cleanup();
    }
  });
});
