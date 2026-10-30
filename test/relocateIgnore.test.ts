/**
 * svn:ignore 规则读写（F121）与 svn relocate（F118）的集成测试，
 * 走本地 svnadmin + file:// 副本；relocate 用「移动仓库目录」构造
 * UUID 一致的换地址场景。
 */
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import { buildWriteArgs, literalIgnorePattern, mergeIgnoreRules, parseIgnoreRules, readIgnoreRules } from '../src/core/ignore';
import { buildRelocateArgs, readRepositoryUrl } from '../src/core/relocate';
import { runOrThrow } from '../src/core/svnCli';
import { createSvnLab, writeFile } from './helpers';

const lab = createSvnLab('svn-anywhere-relign-');
afterAll(() => lab.cleanup());

describe('svn:ignore 规则', () => {
  it('无法表示为单条规则的换行/回车名称被拒绝', () => {
    for (const name of ['foo\nbar', 'foo\rbar', 'foo\r\nbar']) {
      expect(() => literalIgnorePattern(name)).toThrow(RangeError);
    }
  });

  it('parseIgnoreRules 与 mergeIgnoreRules：去重、保序、新规则追加末尾', () => {
    expect(parseIgnoreRules('*.log\nbuild\n')).toEqual(['*.log', 'build']);
    expect(parseIgnoreRules('')).toEqual([]);
    expect(mergeIgnoreRules(['*.log', 'build'], ['dist', '*.log'], [])).toEqual(['*.log', 'build', 'dist']);
    expect(mergeIgnoreRules(['*.log', 'build'], [], ['*.log'])).toEqual(['build']);
    expect(mergeIgnoreRules(['build'], [], ['build'])).toEqual([]);
  });

  it('解析规则保留名称首尾空格，仅去除空行和 CRLF 分隔符', () => {
    expect(parseIgnoreRules(' report.txt \r\ninside space.txt\r\n \n\n')).toEqual([
      ' report.txt ', 'inside space.txt', ' ',
    ]);
  });

  it('带首尾空格的规则读写往返后仍只忽略精确名称', async () => {
    const wc = lab.checkout('ig-spaces');
    writeFile(wc, 'space-baseline.txt', 'v', true);
    lab.svn(['commit', '-q', '-m', 'baseline'], wc);
    writeFile(wc, ' report.txt ', 'spaced');
    writeFile(wc, 'report.txt', 'plain');
    lab.svn(['propset', 'svn:ignore', ' report.txt ', '.'], wc);
    const rules = await readIgnoreRules('svn', '.', { cwd: wc });
    expect(rules).toEqual([' report.txt ']);
    const rulesFile = join(lab.root, 'space-rules.txt');
    writeFileSync(rulesFile, `${rules.join('\n')}\n`, 'utf8');
    lab.svn(buildWriteArgs(rules, '.', rulesFile), wc);
    const status = lab.svn(['status', '--no-ignore', '--xml'], wc);
    expect(status).toMatch(/path=" report\.txt "[\s\S]*?item="ignored"/);
    expect(status).toMatch(/path="report\.txt"[\s\S]*?item="unversioned"/);
  });

  it('精确名称模式只忽略目标，不把反斜杠或通配符当作模式语法', async () => {
    const wc = lab.checkout('ig-literal');
    const names = ['slash\\x', 'double\\\\x', ' mix\\[1]*?.log ', 'star*.tmp', 'question?.tmp', 'bracket[1].tmp'];
    const near = ['slashx', 'double\\x', ' mix[1]abcx.log ', 'star-other.tmp', 'questionx.tmp', 'bracket1.tmp'];
    for (const name of [...names, ...near]) writeFile(wc, name, 'unversioned');
    const rules = names.map(literalIgnorePattern);
    const rulesFile = join(lab.root, 'literal-rules.txt');
    writeFileSync(rulesFile, `${rules.join('\n')}\n`, 'utf8');
    lab.svn(buildWriteArgs(rules, '.', rulesFile), wc);
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', trimValues: false, isArray: (name) => name === 'entry' });
    const entries = parser.parse(lab.svn(['status', '--no-ignore', '--xml'], wc)).status.target.entry;
    for (const name of names) expect(entries.find((entry: { path: string }) => entry.path === name)?.['wc-status'].item, name).toBe('ignored');
    for (const name of near) expect(entries.find((entry: { path: string }) => entry.path === name)?.['wc-status'].item, name).toBe('unversioned');
    await expect(readIgnoreRules('svn', '.', { cwd: wc })).resolves.toEqual(rules);
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
