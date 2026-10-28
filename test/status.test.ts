/**
 * svn status 的解析与执行测试：解析纯函数用主会话实测的真实输出样本；
 * runStatus 走本地 svnadmin + file:// 副本集成链路，并验证含 @ 的检出
 * 目录（escapePeg 契约）与纯文本 svn status 输出的一致性（F15）。
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseStatusXml, runStatus } from '../src/core/status';
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
      { path: 'src/a.txt', wcStatus: 'modified', kind: undefined, revision: 3, props: 'none' },
      { path: 'src/new.txt', wcStatus: 'unversioned', kind: undefined, revision: undefined, props: 'none' },
    ]);
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

    expect(parseStatusXml('')).toEqual({ targetPath: '', entries: [] });
    expect(parseStatusXml('<not-svn/>')).toEqual({ targetPath: '', entries: [] });
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
      { path: 'a.txt', wcStatus: 'modified', kind: undefined, revision: 1, props: 'none' },
    ]);
  });

  it('干净副本返回空条目', async () => {
    const wc = lab.checkout('wc-clean');
    const result = await runStatus('svn', '.', { cwd: wc });
    expect(result.entries).toEqual([]);
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
