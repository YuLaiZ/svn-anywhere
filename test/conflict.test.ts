/**
 * 冲突扫描与归一化测试（M4 阶段 1）：
 * - 纯解析样本取自阶段 0 V4 的 svn 1.15 真实输出（status/info/proplist），
 *   只裁剪重复的 wc-info/repository 块，属性与节点形态保持原样；
 * - 集成用例走本地 svnadmin + file:// 副本，真实构造文本/属性/树冲突。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  classifyContentKind,
  classifyPropertyConflicts,
  isRelPathWithinScope,
  isUnderExternalBoundary,
  isWithinRealScope,
  mergeResolvedLedger,
  normalizeConflictRecords,
  parseConflictStatusXml,
  parseInfoXml,
  parseNodeInfoXml,
  parsePropertyValuesXml,
  resolveRealPathWithSuffix,
  scanConflicts,
  summarizeConflicts,
  toWcRelativePath,
  type ConflictKind,
  type ConflictRecord,
} from '../src/core/conflict';
import { createSvnLab, writeFile } from './helpers';

const lab = createSvnLab('svn-anywhere-conflict-');
afterAll(() => lab.cleanup());

/* ------------------------------------------------------------------ *
 * status 三判据与 external 边界
 * ------------------------------------------------------------------ */

/** 阶段 0 V4 实测形态：三判据候选、树冲突三 item、辅助文件、external 边界。 */
const STATUS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<status>
<target path=".">
<entry path=".">
<wc-status wc-locked="true" item="incomplete" revision="21" props="none">
</wc-status>
</entry>
<entry path="text.txt">
<wc-status item="conflicted" revision="3" props="none">
</wc-status>
</entry>
<entry path="text.txt.mine">
<wc-status item="unversioned" props="none">
</wc-status>
</entry>
<entry path="multi.txt">
<wc-status item="normal" revision="3" props="conflicted">
</wc-status>
</entry>
<entry path="mixed.txt">
<wc-status item="conflicted" revision="3" props="conflicted">
</wc-status>
</entry>
<entry path="tree-add.txt">
<wc-status item="replaced" revision="3" props="none" tree-conflicted="true">
</wc-status>
</entry>
<entry path="tree-del.txt">
<wc-status item="added" copied="true" tree-conflicted="true" props="none">
</wc-status>
</entry>
<entry path="tree-dir">
<wc-status item="deleted" tree-conflicted="true" props="none">
</wc-status>
</entry>
<entry path="extdir/ext">
<wc-status item="external" props="none">
</wc-status>
</entry>
</target>
</status>
`;

describe('parseConflictStatusXml', () => {
  it('三判据命中：conflicted / props=conflicted / tree-conflicted，树冲突不依赖 item', () => {
    const result = parseConflictStatusXml(STATUS_SAMPLE);
    expect(result.entries.map((entry) => [entry.path, entry.item, entry.treeConflicted])).toEqual([
      ['text.txt', 'conflicted', false],
      ['multi.txt', 'normal', false],
      ['mixed.txt', 'conflicted', false],
      ['tree-add.txt', 'replaced', true],
      ['tree-del.txt', 'added', true],
      ['tree-dir', 'deleted', true],
    ]);
    // 辅助文件（unversioned）不反向当作候选。
    expect(result.entries.some((entry) => entry.path.endsWith('.mine'))).toBe(false);
    // external 边界条目单独收集，根条目 wc-locked 透出。
    expect(result.externals).toEqual(['extdir/ext']);
    expect(result.wcLocked).toBe(true);
  });

  it('external 内部成员即便带冲突也不进入本副本冲突列表（防御性分段过滤）', () => {
    const result = parseConflictStatusXml(`<status><target path=".">
<entry path="extdir/ext"><wc-status item="external" props="none"></wc-status></entry>
<entry path="extdir/ext/f.txt"><wc-status item="conflicted" revision="2" props="none"></wc-status></entry>
<entry path="extdir/ext2/f.txt"><wc-status item="conflicted" revision="2" props="none"></wc-status></entry>
<entry path="a.txt"><wc-status item="conflicted" props="none"></wc-status></entry>
</target></status>`);
    // extdir/ext2 不在 extdir/ext 边界内。
    expect(result.entries.map((entry) => entry.path)).toEqual(['extdir/ext2/f.txt', 'a.txt']);
  });

  it('无 wc-locked 时为 false；截断 XML 整次失败（不解析残片）', () => {
    expect(parseConflictStatusXml('<status><target path="."></target></status>').wcLocked).toBe(false);
    expect(() => parseConflictStatusXml('<status><target path="."><entry path="a.txt"><wc-status item="conflicted"')).toThrow(/status XML 不完整/);
  });

  it('isUnderExternalBoundary 按路径分段判定，/a/b 不匹配 /a/bc', () => {
    expect(isUnderExternalBoundary('ext/f.txt', ['ext'])).toBe(true);
    expect(isUnderExternalBoundary('ext2/f.txt', ['ext'])).toBe(false);
    expect(isUnderExternalBoundary('ext', ['ext'])).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * info 归一化（真实形态样本）
 * ------------------------------------------------------------------ */

const INFO_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<info>
<entry path="text.txt" revision="3" kind="file">
<url>file:///repo/text.txt</url>
<relative-url>^/text.txt</relative-url>
<conflict operation="update" type="text">
<version side="source-left" kind="file" path-in-repos="text.txt" repos-url="file:///repo" revision="2"/>
<version side="source-right" kind="file" path-in-repos="text.txt" repos-url="file:///repo" revision="3"/>
<prev-base-file>/wc/text.txt.r2</prev-base-file>
<prev-wc-file>/wc/text.txt.mine</prev-wc-file>
<cur-base-file>/wc/text.txt.r3</cur-base-file>
</conflict>
</entry>
<entry path="prop.txt" revision="3" kind="file">
<url>file:///repo/prop.txt</url>
<conflict operation="update" type="property">
<version side="source-left" kind="file" path-in-repos="prop.txt" repos-url="file:///repo" revision="2"/>
<version side="source-right" kind="file" path-in-repos="prop.txt" repos-url="file:///repo" revision="3"/>
<prop-file>/wc/prop.txt.prej</prop-file>
</conflict>
</entry>
<entry path="mixed.txt" revision="3" kind="file">
<url>file:///repo/mixed.txt</url>
<conflict operation="update" type="text">
<version side="source-left" kind="file" path-in-repos="mixed.txt" repos-url="file:///repo" revision="2"/>
<version side="source-right" kind="file" path-in-repos="mixed.txt" repos-url="file:///repo" revision="3"/>
<prev-base-file>/wc/mixed.txt.r2</prev-base-file>
<prev-wc-file>/wc/mixed.txt.mine</prev-wc-file>
<cur-base-file>/wc/mixed.txt.r3</cur-base-file>
</conflict>
<conflict operation="update" type="property">
<version side="source-left" kind="file" path-in-repos="mixed.txt" repos-url="file:///repo" revision="2"/>
<version side="source-right" kind="file" path-in-repos="mixed.txt" repos-url="file:///repo" revision="3"/>
<prop-file>/wc/mixed.txt.r3</prop-file>
</conflict>
<conflict operation="update" type="text">
<version side="source-left" kind="file" path-in-repos="mixed.txt" repos-url="file:///repo" revision="2"/>
<version side="source-right" kind="file" path-in-repos="mixed.txt" repos-url="file:///repo" revision="3"/>
<prev-base-file>/wc/mixed.txt.r2</prev-base-file>
<prev-wc-file>/wc/mixed.txt.mine</prev-wc-file>
<cur-base-file>/wc/mixed.txt.r3</cur-base-file>
</conflict>
<conflict operation="update" type="property">
<version side="source-left" kind="file" path-in-repos="mixed.txt" repos-url="file:///repo" revision="2"/>
<version side="source-right" kind="file" path-in-repos="mixed.txt" repos-url="file:///repo" revision="3"/>
<prop-file>/wc/mixed.txt.r3</prop-file>
</conflict>
</entry>
<entry path="multi.txt" revision="3" kind="file">
<url>file:///repo/multi.txt</url>
<conflict operation="update" type="property">
<version side="source-left" kind="file" path-in-repos="multi.txt" repos-url="file:///repo" revision="2"/>
<version side="source-right" kind="file" path-in-repos="multi.txt" repos-url="file:///repo" revision="3"/>
<prop-file>/wc/multi.txt.prej</prop-file>
</conflict>
<conflict operation="update" type="property">
<version side="source-left" kind="file" path-in-repos="multi.txt" repos-url="file:///repo" revision="2"/>
<version side="source-right" kind="file" path-in-repos="multi.txt" repos-url="file:///repo" revision="3"/>
<prop-file>/wc/multi.txt.prej</prop-file>
</conflict>
</entry>
<entry path="binary.bin" revision="3" kind="file">
<url>file:///repo/binary.bin</url>
<conflict operation="update" type="text">
<version side="source-left" kind="file" path-in-repos="binary.bin" repos-url="file:///repo" revision="2"/>
<version side="source-right" kind="file" path-in-repos="binary.bin" repos-url="file:///repo" revision="3"/>
<prev-base-file>/wc/binary.bin.r2</prev-base-file>
<cur-base-file>/wc/binary.bin.r3</cur-base-file>
</conflict>
</entry>
<entry path="tree-del.txt" revision="2" kind="file">
<url>file:///repo/tree-del.txt</url>
<tree-conflict operation="update" kind="file" reason="edit" victim="tree-del.txt" action="delete">
<version repos-url="file:///repo" revision="2" side="source-left" kind="file" path-in-repos="tree-del.txt"/>
<version side="source-right" kind="none" path-in-repos="tree-del.txt" repos-url="file:///repo" revision="3"/>
</tree-conflict>
</entry>
<entry path="tree-dir" revision="2" kind="dir">
<url>file:///repo/tree-dir</url>
<tree-conflict action="delete" operation="update" kind="dir" reason="edit" victim="tree-dir">
<version side="source-left" kind="dir" path-in-repos="tree-dir" repos-url="file:///repo" revision="2"/>
<version path-in-repos="tree-dir" repos-url="file:///repo" revision="3" side="source-right" kind="none"/>
</tree-conflict>
</entry>
<entry kind="file" path="tree-add.txt" revision="Resource is not under version control.">
<url>file:///repo/tree-add.txt</url>
<tree-conflict operation="update" kind="file" reason="add" victim="tree-add.txt" action="add">
<version kind="file" path-in-repos="tree-add.txt" repos-url="file:///repo" revision="3" side="source-right"/>
</tree-conflict>
</entry>
<entry path="dir" revision="4" kind="dir">
<url>file:///repo/dir</url>
<conflict operation="update" type="property">
<version side="source-left" kind="dir" path-in-repos="dir" repos-url="file:///repo" revision="3"/>
<version side="source-right" kind="dir" path-in-repos="dir" repos-url="file:///repo" revision="4"/>
<prop-file>/wc/dir_conflicts.prej</prop-file>
</conflict>
</entry>
</info>
`;

describe('normalizeConflictRecords', () => {
  const records = normalizeConflictRecords(parseInfoXml(INFO_SAMPLE), { wcRoot: '/wc' });
  const byPath = (path: string) => records.find((record) => record.path === path)!;

  it('文本冲突：三 revision 分离、辅助文件三角色相对化并绑定 revision', () => {
    const text = byPath('text.txt');
    expect(text.kinds).toEqual(['text']);
    expect(text.nodeBaseRevision).toBe(3);
    expect(text.baselineRevision).toBe(2);
    expect(text.incomingRevision).toBe(3);
    expect(text.artifacts).toEqual([
      { role: 'base', path: 'text.txt.r2', revision: 2 },
      { role: 'mine', path: 'text.txt.mine', revision: undefined },
      { role: 'incoming', path: 'text.txt.r3', revision: 3 },
    ]);
    expect(text.contentKind).toBe('unknown');
  });

  it('二进制文本冲突：info 无 prev-wc-file 时 artifacts 不含 mine', () => {
    const binary = byPath('binary.bin');
    expect(binary.kinds).toEqual(['text']);
    expect(binary.artifacts.map((artifact) => artifact.role)).toEqual(['base', 'incoming']);
  });

  it('混合路径：重复冲突节点去重后一条记录两个 kinds，prop-file 偏差回退 .prej', () => {
    const mixed = byPath('mixed.txt');
    expect(mixed.kinds).toEqual(['text', 'property']);
    expect(mixed.artifacts.filter((artifact) => artifact.role === 'reject')).toEqual([
      { role: 'reject', path: 'mixed.txt.prej', revision: undefined },
    ]);
    // 文本辅件不重复（4 个 info 节点收敛为 1 条 text + 1 条 property）。
    expect(mixed.artifacts.filter((artifact) => artifact.role === 'mine')).toHaveLength(1);
  });

  it('同路径多属性：两个属性节点合并为一条属性记录、一个 reject 辅件', () => {
    const multi = byPath('multi.txt');
    expect(multi.kinds).toEqual(['property']);
    expect(multi.artifacts).toEqual([{ role: 'reject', path: 'multi.txt.prej', revision: undefined }]);
  });

  it('树冲突 added/replaced/deleted 形态：entry revision 非数字容错、单侧 version', () => {
    const add = byPath('tree-add.txt');
    expect(add.kinds).toEqual(['tree']);
    expect(add.nodeBaseRevision).toBeUndefined();
    expect(add.treeConflict).toMatchObject({
      operation: 'update',
      kind: 'file',
      reason: 'add',
      action: 'add',
      victim: 'tree-add.txt',
      sourceRight: { side: 'source-right', kind: 'file', revision: 3 },
    });
    expect(add.treeConflict?.sourceLeft).toBeUndefined();

    const del = byPath('tree-del.txt');
    expect(del.treeConflict).toMatchObject({ reason: 'edit', action: 'delete' });
    expect(del.treeConflict?.sourceLeft).toMatchObject({ kind: 'file', revision: 2 });
    expect(del.treeConflict?.sourceRight).toMatchObject({ kind: 'none', revision: 3 });

    const dir = byPath('tree-dir');
    expect(dir.treeConflict).toMatchObject({ kind: 'dir', victim: 'tree-dir' });
  });

  it('目录属性冲突：prop-file 为 dir_conflicts.prej 时保留原值', () => {
    const dir = byPath('dir');
    expect(dir.kinds).toEqual(['property']);
    expect(dir.artifacts).toEqual([{ role: 'reject', path: 'dir_conflicts.prej', revision: undefined }]);
  });

  it('记录 id 稳定且区分路径；无冲突条目被跳过', () => {
    const again = normalizeConflictRecords(parseInfoXml(INFO_SAMPLE), { wcRoot: '/wc' });
    expect(again.map((record) => record.id)).toEqual(records.map((record) => record.id));
    const ids = new Set(records.map((record) => record.id));
    expect(ids.size).toBe(records.length);
    expect(parseNodeInfoXml('<info></info>')).toBeUndefined();
    expect(normalizeConflictRecords(parseInfoXml(INFO_SAMPLE).slice(0, 1))).toHaveLength(1);
  });

  it('summary 按 kinds 项计数：mixed 同时贡献 text 与 property', () => {
    expect(summarizeConflicts(records)).toEqual({
      text: 3,
      property: 4,
      tree: 3,
      total: 10,
    });
  });
});

/* ------------------------------------------------------------------ *
 * 属性三值与保留属性
 * ------------------------------------------------------------------ */

describe('属性冲突三值', () => {
  it('parsePropertyValuesXml：base64 解码控制字符、保留尾随换行与空元素', () => {
    const values = parsePropertyValuesXml(`<?xml version="1.0" encoding="UTF-8"?>
<properties>
<target path="prop.txt">
<property name="ctl" encoding="base64">YQFi</property>
<property name="weird">line1
line2 中文 &lt;&amp;&gt;</property>
<property name="empty"></property>
</target>
</properties>`);
    expect(values.ctl.equals(Buffer.from([0x61, 0x01, 0x62]))).toBe(true);
    expect(values.weird.toString('utf8')).toBe('line1\nline2 中文 <&>');
    expect(values.empty.toString('utf8')).toBe('');
    expect(Object.keys(values).sort()).toEqual(['ctl', 'empty', 'weird']);
  });

  it('只保留 local != base、incoming != base、local != incoming 三方冲突；svn: 属性 autoUnsupported', () => {
    const local = {
      p1: Buffer.from('local1'),
      p2: Buffer.from('localonly'),
      p3: Buffer.from('incoming3'),
      'svn:mergeinfo': Buffer.from('/branches/b1:18'),
    };
    const base = {
      p1: Buffer.from('base1'),
      p2: Buffer.from('base2'),
      p3: Buffer.from('base3'),
      'svn:mergeinfo': Buffer.from('/trunk:16'),
    };
    const incoming = {
      p1: Buffer.from('incoming1'),
      p2: Buffer.from('base2'),
      p3: Buffer.from('incoming3'),
      'svn:mergeinfo': Buffer.from('/trunk:20'),
    };
    const conflicts = classifyPropertyConflicts(local, base, incoming);
    expect(conflicts.map((property) => property.name)).toEqual(['p1', 'svn:mergeinfo']);
    expect(conflicts[0].autoUnsupported).toBe(false);
    expect(conflicts[1].autoUnsupported).toBe(true);
    expect(conflicts[0].local).toEqual({ exists: true, value: Buffer.from('local1') });
    expect(conflicts[0].base).toEqual({ exists: true, value: Buffer.from('base1') });
    expect(conflicts[0].incoming).toEqual({ exists: true, value: Buffer.from('incoming1') });
  });

  it('缺失的属性按不存在参与比较', () => {
    const conflicts = classifyPropertyConflicts({ a: Buffer.from('x') }, {}, { a: Buffer.from('y') });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].base).toEqual({ exists: false });
  });
});

/* ------------------------------------------------------------------ *
 * contentKind 与台账合并
 * ------------------------------------------------------------------ */

describe('classifyContentKind', () => {
  it('MIME 非 text/* 或前 8 KiB 含 NUL 即二进制；读不到头时 unknown', () => {
    expect(classifyContentKind({ mimeType: 'application/octet-stream', headBytes: Buffer.from('x') })).toBe('binary');
    expect(classifyContentKind({ mimeType: 'text/plain', headBytes: Buffer.from('a\0b') })).toBe('binary');
    expect(classifyContentKind({ mimeType: 'text/plain', headBytes: Buffer.from('abc') })).toBe('text');
    expect(classifyContentKind({ headBytes: Buffer.from('abc') })).toBe('text');
    expect(classifyContentKind({})).toBe('unknown');
    expect(classifyContentKind({ isDir: true, mimeType: 'text/plain' })).toBe('unknown');
  });
});

function fakeRecord(path: string, kinds: ConflictKind[], id = `id:${path}:${kinds.join(',')}`): ConflictRecord {
  return { id, path, kinds, contentKind: 'text', artifacts: [] };
}

describe('mergeResolvedLedger（真实新冲突优先）', () => {
  it('真实扫描仍报告的同一路径+类型覆盖台账；台账独有项以 resolved 补出', () => {
    const records = [fakeRecord('a.txt', ['text'], 'fp-a'), fakeRecord('b.txt', ['property'], 'fp-b')];
    const ledger = [
      { fingerprint: 'fp-a', path: 'a.txt', kinds: ['text' as const], strategy: 'theirs-full', operationId: 'op-1', resolvedAt: 1 },
      { fingerprint: 'fp-c', path: 'c.txt', kinds: ['text' as const], strategy: 'working', operationId: 'op-2', resolvedAt: 2 },
    ];
    const rows = mergeResolvedLedger(records, ledger);
    expect(rows.map((row) => [row.path, row.status])).toEqual([
      ['a.txt', 'unresolved'],
      ['b.txt', 'unresolved'],
      ['c.txt', 'resolved'],
    ]);
    // 真实优先：a.txt 不显示已解决，只有 c.txt 有台账引用。
    expect(rows[0].resolved).toBeUndefined();
    expect(rows[2].resolved?.operationId).toBe('op-2');
  });

  it('外部产生的新冲突（同路径不同类型）也不被台账覆盖', () => {
    const records = [fakeRecord('a.txt', ['tree'], 'fp-new-tree')];
    const ledger = [{ fingerprint: 'fp-old', path: 'a.txt', kinds: ['text' as const], strategy: 'base', operationId: 'op', resolvedAt: 1 }];
    const rows = mergeResolvedLedger(records, ledger);
    expect(rows).toEqual([
      { key: 'fp-new-tree', path: 'a.txt', kinds: ['tree'], status: 'unresolved', record: records[0] },
    ]);
  });

  it('postponed 只作用于真实记录；扫描不再报告时自然消失', () => {
    const records = [fakeRecord('a.txt', ['text'], 'fp-a'), fakeRecord('b.txt', ['text'], 'fp-b')];
    const rows = mergeResolvedLedger(records, [], [
      { fingerprint: 'fp-a', path: 'a.txt', kinds: ['text'] },
      { fingerprint: 'fp-gone', path: 'gone.txt', kinds: ['text'] },
    ]);
    expect(rows.map((row) => [row.path, row.status])).toEqual([
      ['a.txt', 'postponed'],
      ['b.txt', 'unresolved'],
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * realpath 与范围
 * ------------------------------------------------------------------ */

describe('缺失/移动路径的 realpath + 分段后缀', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-real-')));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('缺失路径用最近存在祖先 realpath 并保留分段后缀', () => {
    mkdirSync(join(root, 'a'), { recursive: true });
    const resolution = resolveRealPathWithSuffix(join(root, 'a', 'b', 'c'));
    expect(resolution?.realPath).toBe(join(root, 'a'));
    expect(resolution?.suffix).toEqual(['b', 'c']);
  });

  it('isWithinRealScope 按路径分段判定：/a/b 不匹配 /a/bc', () => {
    expect(isWithinRealScope(join(root, 'a', 'b'), join(root, 'a', 'b', 'c'))).toBe(true);
    expect(isWithinRealScope(join(root, 'a', 'b'), join(root, 'a', 'b'))).toBe(true);
    expect(isWithinRealScope(join(root, 'a', 'b'), join(root, 'a', 'bc'))).toBe(false);
    expect(isWithinRealScope(join(root, 'a', 'b'), join(root, 'a'))).toBe(false);
  });

  it('isRelPathWithinScope：缺失路径用最近存在祖先，分段避免 /a/b 与 /a/bc 误判', () => {
    mkdirSync(join(root, 'scope'), { recursive: true });
    expect(isRelPathWithinScope(join(root, 'scope'), root, 'scope/missing/file.txt')).toBe(true);
    expect(isRelPathWithinScope(join(root, 'scope'), root, 'scope2/file.txt')).toBe(false);
  });

  it('toWcRelativePath 相对化绝对路径、保留空格名称、POSIX 归一', () => {
    expect(toWcRelativePath('/wc', '/wc/a b/c.txt')).toBe('a b/c.txt');
    expect(toWcRelativePath('/wc', './a/../b.txt')).toBe('b.txt');
    expect(toWcRelativePath('/wc', '/elsewhere/x')).toBe('/elsewhere/x');
  });
});

/* ------------------------------------------------------------------ *
 * 真实扫描集成
 * ------------------------------------------------------------------ */

function makeTextConflict(name: string, relPath = `${name}.txt`): string {
  const base = lab.checkout(name);
  writeFile(base, relPath, 'line1\n', true);
  lab.svn(['commit', '-q', '-m', 'conflict base'], base);
  const other = lab.checkout(`${name}-other`);
  writeFile(other, relPath, 'line1\nremote\n');
  lab.svn(['commit', '-q', '-m', 'conflict remote'], other);
  writeFile(base, relPath, 'line1\nlocal\n');
  lab.svn(['update', '-q'], base);
  return base;
}

describe('scanConflicts 集成（本地 file:// 副本）', () => {
  it('文本冲突：记录 revision 三值、辅助文件真实存在、摘要按类型计数', async () => {
    const wc = makeTextConflict('scan-text');
    const result = await scanConflicts('svn', wc);
    expect(result.failures).toEqual([]);
    expect(result.wcLocked).toBe(false);
    expect(result.summary).toEqual({ text: 1, property: 0, tree: 0, total: 1 });
    const record = result.records.find((candidate) => candidate.path === 'scan-text.txt')!;
    expect(record).toBeDefined();
    expect(record.kinds).toEqual(['text']);
    expect(record.nodeBaseRevision).toBe(2);
    expect(record.baselineRevision).toBe(1);
    expect(record.incomingRevision).toBe(2);
    expect(record.artifacts.map((artifact) => artifact.role).sort()).toEqual(['base', 'incoming', 'mine']);
    expect(record.artifacts.find((artifact) => artifact.role === 'mine')?.path).toBe('scan-text.txt.mine');
    expect(record.artifacts.find((artifact) => artifact.role === 'base')?.revision).toBe(1);
    expect(record.artifacts.find((artifact) => artifact.role === 'incoming')?.revision).toBe(2);
  });

  it('干净副本：无冲突记录', async () => {
    const wc = lab.checkout('scan-clean');
    const result = await scanConflicts('svn', wc);
    expect(result.records).toEqual([]);
    expect(result.summary.total).toBe(0);
  });

  it('树冲突（本地编辑 vs 传入删除）：tree 记录、victim 与 action 来自 info', async () => {
    const wc = lab.checkout('scan-tree');
    writeFile(wc, 'gone.txt', 'v1\n', true);
    lab.svn(['commit', '-q', '-m', 'tree base'], wc);
    const other = lab.checkout('scan-tree-other');
    lab.svn(['rm', '-q', 'gone.txt'], other);
    lab.svn(['commit', '-q', '-m', 'tree remote delete'], other);
    writeFile(wc, 'gone.txt', 'local edit\n');
    lab.svn(['update', '-q'], wc);
    const result = await scanConflicts('svn', wc);
    const record = result.records.find((candidate) => candidate.path === 'gone.txt')!;
    expect(record).toBeDefined();
    expect(record.kinds).toEqual(['tree']);
    expect(record.treeConflict?.action).toBe('delete');
    expect(record.treeConflict?.victim).toBe('gone.txt');
    expect(result.summary.tree).toBe(1);
  });

  it('混合冲突（文本+属性）：一条记录两个 kinds，属性三值可读取', async () => {
    const wc = lab.checkout('scan-mixed');
    writeFile(wc, 'mixed.txt', 'line1\n', true);
    lab.svn(['propset', '-q', 'm', 'base', 'mixed.txt'], wc);
    lab.svn(['commit', '-q', '-m', 'mixed base'], wc);
    const other = lab.checkout('scan-mixed-other');
    writeFile(other, 'mixed.txt', 'line1\nremote\n');
    lab.svn(['propset', '-q', 'm', 'theirs', 'mixed.txt'], other);
    lab.svn(['commit', '-q', '-m', 'mixed remote'], other);
    writeFile(wc, 'mixed.txt', 'line1\nlocal\n');
    lab.svn(['propset', '-q', 'm', 'local', 'mixed.txt'], wc);
    lab.svn(['update', '-q'], wc);
    const result = await scanConflicts('svn', wc);
    const record = result.records.find((candidate) => candidate.path === 'mixed.txt')!;
    expect(record).toBeDefined();
    expect(record.kinds).toEqual(['text', 'property']);
    expect(record.propertyConflicts?.map((property) => property.name)).toEqual(['m']);
    const property = record.propertyConflicts![0];
    expect(property.autoUnsupported).toBe(false);
    expect(property.local.value?.toString('utf8')).toBe('local');
    expect(property.base.value?.toString('utf8')).toBe('base');
    expect(property.incoming.value?.toString('utf8')).toBe('theirs');
    expect(result.summary).toEqual({ text: 1, property: 1, tree: 0, total: 2 });
  });

  it('扫描范围限定：只返回目标目录内的冲突', async () => {
    const wc = makeTextConflict('scan-scope', 'sub/inner.txt');
    const subConflict = await scanConflicts('svn', wc, { scope: 'sub' });
    expect(subConflict.records.map((record) => record.path)).toEqual(['sub/inner.txt']);
    // 根扫描能看到同一冲突。
    const whole = await scanConflicts('svn', wc);
    expect(whole.records.some((record) => record.path === 'sub/inner.txt')).toBe(true);
  });

  it('进度回调按候选推进；属性读取可关闭', async () => {
    const wc = makeTextConflict('scan-progress');
    const progress: Array<[number, number]> = [];
    await scanConflicts('svn', wc, { readPropertyValues: false, onProgress: (done, total) => progress.push([done, total]) });
    expect(progress).toEqual([[1, 1]]);
  });
});
