/**
 * svn status -u 的解析与执行测试（提交前远端检查，F145/F81）：
 * 解析纯函数用实测样本，runRemoteStatus 走本地 file:// 副本集成链路。
 */
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  parseRemoteStatusXml,
  remoteChangedEntries,
  runRemoteStatus,
} from '../src/core/remoteStatus';
import { createSvnLab, writeFile } from './helpers';

const lab = createSvnLab('svn-anywhere-rstatus-');
afterAll(() => lab.cleanup());

/** 实测样本：本地干净但远端有修改与新增，含 against 与 repos-status。 */
const SAMPLE_REMOTE_CHANGES = `<?xml version="1.0" encoding="UTF-8"?>
<status>
<target
   path=".">
<entry
   path="src/a.txt">
<wc-status
   item="normal"
   revision="1"
   props="none">
<commit
   revision="1">
<author>tester</author>
<date>2026-10-28T00:00:00.000000Z</date>
</commit>
</wc-status>
<repos-status
   item="modified"
   props="none">
</repos-status>
</entry>
<entry
   path="src/added.txt">
<wc-status
   props="none"
   item="none">
</wc-status>
<repos-status
   item="added"
   props="none">
</repos-status>
</entry>
<against
   revision="2"/>
</target>
</status>
`;

describe('parseRemoteStatusXml', () => {
  it('解析 against 对照 revision 与各条目 repos-status 原词', () => {
    const result = parseRemoteStatusXml(SAMPLE_REMOTE_CHANGES);
    expect(result.against).toBe(2);
    expect(result.entries).toEqual([
      { path: 'src/a.txt', wcStatus: 'normal', reposStatus: 'modified' },
      { path: 'src/added.txt', wcStatus: 'none', reposStatus: 'added' },
    ]);
    expect(remoteChangedEntries(result).map((e) => e.path)).toEqual(['src/a.txt', 'src/added.txt']);
  });

  it('本地变更远端无变化：repos-status 缺失，不计入远端更新', () => {
    const result = parseRemoteStatusXml(`<status><target path=".">
<entry path="src/a.txt"><wc-status item="modified" props="none"></wc-status></entry>
<entry path="ext"><wc-status item="external" props="none"></wc-status>
<repos-status item="external" props="none"></repos-status></entry>
</target></status>`);
    expect(result.against).toBeUndefined();
    expect(remoteChangedEntries(result)).toEqual([]);
  });

  it('结构异常输入不抛解析异常', () => {
    expect(parseRemoteStatusXml('')).toEqual({ against: undefined, entries: [] });
    expect(parseRemoteStatusXml('<not-svn/>')).toEqual({ against: undefined, entries: [] });
  });
});

describe('runRemoteStatus 集成（本地 file:// 副本）', () => {
  it('远端有新提交时能看到 repos-status 与对照 revision', async () => {
    const base = lab.checkout('r-base');
    writeFile(base, 'a.txt', 'v1', true);
    lab.svn(['commit', '-q', '-m', 'init'], base);

    const result = await runRemoteStatus('svn', '.', { cwd: base });
    expect(remoteChangedEntries(result)).toEqual([]);

    const other = lab.checkout('r-other');
    writeFile(other, 'remote-new.txt', 'x', true);
    lab.svn(['commit', '-q', '-m', 'remote add'], other);

    const after = await runRemoteStatus('svn', '.', { cwd: base });
    expect(after.against).toBe(headRevision());
    // 落后的目标目录自身（`.`）也会带 repos-status，忠实保留在结果里。
    expect(remoteChangedEntries(after).map((e) => e.path)).toEqual(['remote-new.txt', '.']);
  });

  it('检出目录名含 @2：escapePeg 转义后远端检查正常', async () => {
    const pegWc = lab.checkout('r-peg@2');
    writeFile(pegWc, 'p.txt', 'v1', true);
    lab.svn(['commit', '-q', '-m', 'peg init'], pegWc);

    const other = lab.checkout('r-peg-other');
    writeFile(other, 'p.txt', 'v1\nremote\n');
    lab.svn(['commit', '-q', '-m', 'peg remote'], other);

    const result = await runRemoteStatus('svn', join(pegWc, 'p.txt'), { cwd: pegWc });
    expect(remoteChangedEntries(result).map((e) => e.path)).toEqual([join(pegWc, 'p.txt')]);
  });
});

function headRevision(): number {
  return Number(lab.svn(['info', '--show-item', 'revision', lab.repoUrl]).trim());
}
