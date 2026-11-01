/**
 * svn status 的解析与执行测试：解析纯函数用主会话实测的真实输出样本；
 * runStatus 走本地 svnadmin + file:// 副本集成链路，并验证含 @ 的检出
 * 目录（escapePeg 契约）与纯文本 svn status 输出的一致性（F15）。
 */
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildCommitArgs } from '../src/core/commit';
import { parseRemoteStatusXml, runRemoteStatus } from '../src/core/remoteStatus';
import { commitableEntries, parseStatusXml, runStatus } from '../src/core/status';
import { createSvnLab, writeFile } from './helpers';

const lab = createSvnLab('svn-anywhere-status-');
afterAll(() => lab.cleanup());

/** 主会话采集的多行属性格式真实样本（svn 1.15.0）。 */
const SAMPLE_WITH_ENTRIES = `<?xml version="1.0" encoding="UTF-8"?>
<status>
<target
   path=".">
<entry
   path="src/a.txt">
<wc-status
   item="modified"
   revision="3"
   props="none">
<commit revision="3"><author>tester</author><date>2026-10-28T00:00:00.000000Z</date></commit>
</wc-status>
</entry>
<entry path="src/new.txt">
<wc-status item="unversioned" props="none">
</wc-status>
</entry>
</target>
</status>
`;

describe('parseStatusXml', () => {
  it('解析多行属性格式的真实样本，保留 wcStatus 原词', () => {
    const result = parseStatusXml(SAMPLE_WITH_ENTRIES);
    expect(result.targetPath).toBe('.');
    expect(result.entries).toEqual([
      { path: 'src/a.txt', wcStatus: 'modified', kind: undefined, revision: 3, props: 'none', changelist: null },
      { path: 'src/new.txt', wcStatus: 'unversioned', kind: undefined, revision: undefined, props: 'none', changelist: null },
    ]);
  });

  it('数字实体只解码一次，保留字面实体与普通 XML 字符', () => {
    const paths = ['foo&#10;bar', 'foo&#x9;bar', 'foo&#13;bar', 'foo&amp;#10;bar', 'a&amp;lt;b', 'a&lt;b&amp;&quot;&apos;'];
    const expected = ['foo\nbar', 'foo\tbar', 'foo\rbar', 'foo&#10;bar', 'a&lt;b', "a<b&\"'"];
    for (let index = 0; index < paths.length; index += 1) {
      const xml = `<status><target path="."><entry path="${paths[index]}"><wc-status item="modified" props="none"/></entry></target></status>`;
      expect(parseStatusXml(xml).entries[0]?.path).toBe(expected[index]);
      expect(parseRemoteStatusXml(xml).entries[0]?.path).toBe(expected[index]);
    }
  });

  it('干净副本：只有 target 没有 entry，结果为空数组', () => {
    const result = parseStatusXml(`<?xml version="1.0" encoding="UTF-8"?>
<status>
<target
   path=".">
</target>
</status>
`);
    expect(result.targetPath).toBe('.');
    expect(result.entries).toEqual([]);
  });

  it('过滤 ignored 与 external 占位条目（M1 不展示）', () => {
    const result = parseStatusXml(`<status><target path=".">
<entry path="vendor/lib"><wc-status item="external" props="none"></wc-status></entry>
<entry path="debug.log"><wc-status item="ignored" props="none"></wc-status></entry>
<entry path="src/a.txt"><wc-status item="modified" props="none"></wc-status></entry>
</target></status>`);
    expect(result.entries.map((e) => e.path)).toEqual(['src/a.txt']);
  });

  it('树冲突条目保留原词；结构异常输入不抛解析异常', () => {
    const conflict = parseStatusXml(`<status><target path=".">
<entry path="sub"><wc-status item="added" props="none" copied="true" tree-conflicted="true"></wc-status></entry>
</target></status>`);
    expect(conflict.entries.map((e) => e.wcStatus)).toEqual(['added']);

    expect(parseStatusXml('')).toEqual({ targetPath: '', entries: [], externals: [] });
    expect(parseStatusXml('<not-svn/>')).toEqual({ targetPath: '', entries: [], externals: [] });
  });

  it('纯属性变更样本：item 为 normal、props 为 modified，条目保留原词', () => {
    const result = parseStatusXml(`<status><target path=".">
<entry path="."><wc-status item="normal" revision="1" props="modified">
<commit revision="1"><author>tester</author><date>2026-10-28T00:00:00.000000Z</date></commit>
</wc-status></entry>
</target></status>`);
    expect(result.entries).toEqual([
      { path: '.', wcStatus: 'normal', kind: undefined, revision: 1, props: 'modified', changelist: null },
    ]);
  });
});


describe('commitableEntries', () => {
  it('纯属性变更（normal + props modified）属于可提交项', () => {
    const result = parseStatusXml(`<status><target path=".">
<entry path="."><wc-status item="normal" props="modified"></wc-status></entry>
</target></status>`);
    expect(commitableEntries(result).map((e) => e.path)).toEqual(['.']);
  });

  it('unversioned 与无属性修改的条目不计入可提交项', () => {
    const result = parseStatusXml(`<status><target path=".">
<entry path="new.txt"><wc-status item="unversioned" props="none"></wc-status></entry>
<entry path="ok.txt"><wc-status item="modified" props="none"></wc-status></entry>
<entry path="."><wc-status item="normal" props="none"></wc-status></entry>
</target></status>`);
    expect(commitableEntries(result).map((e) => e.path)).toEqual(['ok.txt']);
  });
});

describe('runStatus 集成（本地 file:// 副本）', () => {
  it('修改条目按 wcStatus 原词读到，revision 来自 XML', async () => {
    const wc = lab.checkout('wc-main');
    writeFile(wc, 'a.txt', 'v1', true);
    lab.svn(['commit', '-q', '-m', 'init'], wc);
    writeFile(wc, 'a.txt', 'v2');

    // 与终端 svn status 一致：目标传相对路径，条目路径为相对形态。
    const result = await runStatus('svn', 'a.txt', { cwd: wc });
    expect(result.entries).toEqual([
      { path: 'a.txt', wcStatus: 'modified', kind: undefined, revision: 1, props: 'none', changelist: null },
    ]);
  });

  it('干净副本返回空条目', async () => {
    const wc = lab.checkout('wc-clean');
    const result = await runStatus('svn', '.', { cwd: wc });
    expect(result.entries).toEqual([]);
  });

  it('纯 svn:ignore 属性变更：读到 normal + props modified，且可单独提交', async () => {
    const wc = lab.checkout('wc-props');
    // 文件名避开其它用例（lab 仓库共享，检出会带出已提交的同名文件）。
    writeFile(wc, 'props.txt', 'v1', true);
    lab.svn(['commit', '-q', '-m', 'init'], wc);
    lab.svn(['propset', '-q', 'svn:ignore', 'debug.log', '.'], wc);

    const result = await runStatus('svn', '.', { cwd: wc });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ path: '.', wcStatus: 'normal', props: 'modified' });
    expect(commitableEntries(result).map((e) => e.path)).toEqual(['.']);

    // 端到端：只有属性变更时 svn commit 目标目录可提交成功，随后状态干净。
    // 目录属性提交要求目录处于 HEAD（检出于 r0、随后才提交过文件），先更新。
    lab.svn(['update', '-q'], wc);
    lab.svn(['commit', '-q', '-m', 'ignore debug.log', '.'], wc);
    expect((await runStatus('svn', '.', { cwd: wc })).entries).toEqual([]);
  });

  it('仅首尾空格不同的文件保持独立，差异和提交只作用于选中路径', async () => {
    const wc = lab.checkout('wc-space-targets');
    const spaced = ' report.txt ';
    const plain = 'report.txt';
    writeFile(wc, spaced, 'spaced-v1', true);
    writeFile(wc, plain, 'plain-v1', true);
    lab.svn(['commit', '-q', '-m', 'space paths baseline'], wc);
    writeFile(wc, spaced, 'spaced-v2');
    writeFile(wc, plain, 'plain-v2');
    const result = await runStatus('svn', '.', { cwd: wc });
    expect(commitableEntries(result).map((entry) => entry.path).sort()).toEqual([spaced, plain].sort());
    const target = (await runStatus('svn', join(wc, spaced), { cwd: wc }));
    expect(target.targetPath).toBe(join(wc, spaced));
    expect(target.entries.map((entry) => entry.path)).toEqual([join(wc, spaced)]);
    const remote = await runRemoteStatus('svn', '.', { cwd: wc });
    expect(remote.entries.filter((entry) => entry.wcStatus === 'modified').map((entry) => entry.path).sort()).toEqual([spaced, plain].sort());
    const selected = result.entries.find((entry) => entry.path === spaced)!.path;
    const diff = lab.svn(['diff', selected], wc);
    expect(diff).toContain('+spaced-v2');
    expect(diff).not.toContain('+plain-v2');
    const message = join(lab.root, 'space-path-message.txt');
    writeFileSync(message, 'commit selected spaced path', 'utf8');
    lab.svn(buildCommitArgs(message, [selected]), wc);
    expect((await runStatus('svn', '.', { cwd: wc })).entries.map((entry) => entry.path)).toEqual([plain]);
    expect(lab.svn(['cat', '-r', 'HEAD', spaced], wc)).toBe('spaced-v2');
    expect(lab.svn(['cat', '-r', 'HEAD', plain], wc)).toBe('plain-v1');
  });

  it('真实控制字符与字面数字实体名称不碰撞，选择提交不改变邻名', async () => {
    const wc = lab.checkout('wc-entities');
    const names = ['entity\nname', 'entity&#10;name', 'tab\tname', 'tab&#9;name', 'cr\rname', 'cr&#13;name'];
    for (const [index, name] of names.entries()) writeFile(wc, name, 'baseline', index % 2 === 1);
    lab.svn(['commit', '-q', '-m', 'entity names baseline'], wc);
    for (const name of names) writeFile(wc, name, 'modified');
    expect((await runStatus('svn', '.', { cwd: wc })).entries.map((entry) => entry.path).sort()).toEqual([...names].sort());
    expect((await runRemoteStatus('svn', '.', { cwd: wc })).entries.filter((entry) => ['modified', 'none', 'unversioned'].includes(entry.wcStatus ?? '')).map((entry) => entry.path).filter((path) => names.includes(path)).sort()).toEqual([...names].sort());
    const message = join(lab.root, 'entity-message.txt');
    writeFileSync(message, 'commit newline path', 'utf8');
    // SVN 不接受控制字符路径纳管；失败不能转而提交字面实体邻名。
    expect(() => lab.svn(buildCommitArgs(message, [names[0]]), wc)).toThrow();
    expect(lab.svn(['cat', '-r', 'HEAD', names[1]], wc)).toBe('baseline');
    lab.svn(buildCommitArgs(message, [names[1]]), wc);
    expect(lab.svn(['cat', '-r', 'HEAD', names[1]], wc)).toBe('modified');
    expect(lab.svn(['cat', '-r', 'HEAD', names[3]], wc)).toBe('baseline');
    expect((await runStatus('svn', '.', { cwd: wc })).entries.map((entry) => entry.path).sort()).toEqual(names.filter((_, index) => index !== 1).sort());
  });

  it('检出目录名含 @2（严格 peg 语法）：escapePeg 转义后状态读取正常', async () => {
    const wc = lab.checkout('wc@2');
    writeFile(wc, 'peg.txt', 'x', true);
    lab.svn(['commit', '-q', '-m', 'peg'], wc);
    writeFile(wc, 'peg.txt', 'y');

    // 对照：svn 只在参数末尾解析 peg——副本根路径以 @2 结尾且不转义时必然报错。
    expect(() => execFileSync('svn', ['status', '--xml', wc], { cwd: wc, encoding: 'utf8' })).toThrow();

    // 副本根自身（末尾 @2）经 escapePeg 转义后可正常读取。
    const root = await runStatus('svn', wc, { cwd: wc });
    expect(root.targetPath).toBe(wc);

    const result = await runStatus('svn', join(wc, 'peg.txt'), { cwd: wc });
    expect(result.entries.map((e) => e.wcStatus)).toEqual(['modified']);
  });

  it('与 svn status 纯文本输出的条目集合一致（F15）', async () => {
    const wc = lab.checkout('wc-consistency');
    writeFile(wc, 'm.txt', 'v1', true);
    writeFile(wc, 'd.txt', 'v1', true);
    lab.svn(['commit', '-q', '-m', 'base'], wc);
    writeFile(wc, 'm.txt', 'v2');
    lab.svn(['delete', '-q', 'd.txt'], wc);
    writeFile(wc, 'unversioned.txt', 'x');

    const xml = await runStatus('svn', '.', { cwd: wc });
    const plain = execFileSync('svn', ['status'], { cwd: wc, encoding: 'utf8' });

    const fromXml = new Set(xml.entries.map((e) => `${e.wcStatus} ${e.path}`));
    const fromPlain = new Set(
      plain
        .split('\n')
        .filter((line) => line.trim())
        // 纯文本格式：状态字母 + 7 空格 + 相对路径；字母与 XML item 词对照。
        .map((line) => `${PLAIN_CODE_TO_ITEM[line[0].trim()]} ${line.slice(8).trim()}`),
    );
    expect([...fromXml].sort()).toEqual([...fromPlain].sort());
  });
});

describe('parseStatusXml changelist 容器', () => {
  it('changelist 容器条目带名称原值，未分组条目直挂 target 且 changelist 为 null', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<status>
<target path=".">
<entry path="plain.txt">
<wc-status item="modified" props="none"></wc-status>
</entry>
</target>
<changelist name=" spaced ">
<entry path="grouped.txt">
<wc-status item="modified" props="none"></wc-status>
</entry>
</changelist>
<changelist name="all">
<entry path="sentinel.txt">
<wc-status item="unversioned" props="none"></wc-status>
</entry>
</changelist>
</status>
`;
    const result = parseStatusXml(xml);
    expect(result.entries).toEqual([
      { path: 'plain.txt', wcStatus: 'modified', kind: undefined, revision: undefined, props: 'none', changelist: null },
      { path: 'grouped.txt', wcStatus: 'modified', kind: undefined, revision: undefined, props: 'none', changelist: ' spaced ' },
      { path: 'sentinel.txt', wcStatus: 'unversioned', kind: undefined, revision: undefined, props: 'none', changelist: 'all' },
    ]);
  });

  it('真实副本：分组条目与未分组条目同时读取，changelist 名保留首尾空格', async () => {
    const wc = lab.checkout('cl-wc');
    writeFile(wc, 'cl-grouped.txt', 'v1');
    writeFile(wc, 'cl-plain.txt', 'v1');
    lab.svn(['add', '-q', 'cl-grouped.txt', 'cl-plain.txt'], wc);
    lab.svn(['commit', '-q', '-m', 'cl init'], wc);
    writeFile(wc, 'cl-grouped.txt', 'v2');
    writeFile(wc, 'cl-plain.txt', 'v2');
    lab.svn(['changelist', '-q', ' x ', 'cl-grouped.txt'], wc);
    const result = await runStatus('svn', '.', { cwd: wc });
    const a = result.entries.find((entry) => entry.path === 'cl-grouped.txt');
    const b = result.entries.find((entry) => entry.path === 'cl-plain.txt');
    expect(a?.changelist).toBe(' x ');
    expect(b?.changelist).toBeNull();
    // 远端解析同样读取 changelist 容器（-u 输出与 target 平级）。
    const remote = await runRemoteStatus('svn', '.', { cwd: wc });
    expect(remote.entries.some((entry) => entry.path === 'cl-grouped.txt')).toBe(true);
  });
});

/** 纯文本状态字母与 XML wc-status item 词的对照（仅测试用）。 */
const PLAIN_CODE_TO_ITEM: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  C: 'conflicted',
  '!': 'missing',
  '?': 'unversioned',
  R: 'replaced',
};

describe('多目标 status（资源管理器多选批量）', () => {
  it('多 <target> 段条目合并；顶层 changelist 容器跨目标收拢；targetPath 拼接展示', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<status>
<target path="dir1">
<entry path="dir1/b.txt">
<wc-status item="modified" props="none"></wc-status>
</entry>
</target>
<target path="dir2">
<entry path="dir2/c.txt">
<wc-status item="modified" props="none"></wc-status>
</entry>
</target>
<changelist name="cl-x">
<entry path="dir1/a.txt">
<wc-status item="modified" props="none"></wc-status>
</entry>
</changelist>
</status>
`;
    const result = parseStatusXml(xml);
    expect(result.targetPath).toBe('dir1、dir2');
    expect(result.entries.map((entry) => entry.path)).toEqual(['dir1/b.txt', 'dir2/c.txt', 'dir1/a.txt']);
    expect(result.entries[2]?.changelist).toBe('cl-x');
  });

  it('单目标样本行为不变：targetPath 保持原值', () => {
    const result = parseStatusXml(SAMPLE_WITH_ENTRIES);
    expect(result.targetPath).toBe('.');
    expect(result.entries).toHaveLength(2);
  });

  it('runStatus 数组目标一次查询两个不相邻目录：条目合并、路径相对副本根', async () => {
    const wc = lab.checkout('multi-target-wc');
    writeFile(wc, 'd1/a.txt', 'v1', true);
    writeFile(wc, 'd1/inner/b.txt', 'v1', true);
    writeFile(wc, 'd2/c.txt', 'v1', true);
    writeFile(wc, 'outside.txt', 'v1', true);
    lab.svn(['commit', '-q', '-m', 'init'], wc);
    writeFile(wc, 'd1/a.txt', 'v2');
    writeFile(wc, 'd1/inner/b.txt', 'v2');
    writeFile(wc, 'd2/c.txt', 'v2');
    writeFile(wc, 'outside.txt', 'v2');
    const result = await runStatus('svn', ['d1', 'd2'], { cwd: wc });
    expect(result.entries.map((entry) => entry.path).sort()).toEqual([
      'd1/a.txt',
      'd1/inner/b.txt',
      'd2/c.txt',
    ]);
    // 目标外的修改不混入（批量会话范围 = 选区目标范围）。
    expect(result.entries.some((entry) => entry.path === 'outside.txt')).toBe(false);
  });
});
