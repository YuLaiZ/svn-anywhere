/**
 * core/snapshot 测试（M4 阶段 1，实施计划 §3 任务 2）：
 * - 纯解析：summarize/info/list 的 XML 语义（(item,kind) 二元组、item=none、
 *   URL 编码 path、不 trim、实体一次解码、预算超限）；
 * - 真实本地 SVN（svnadmin + file://）：端点 present/absent/notFoundAtRevision、
 *   删除前 revision（deletionRevision-1 与历史前序回退）、目录 summarize 的
 *   旧根剥离/新根重拼映射、单端 list 枚举（已删除路径的 peg + operative
 *   revision）、50k/64 MiB 预算的 tooLarge、文件比较与属性-only、
 *   类型替换的 deleted+added 双记录；
 * - 纯逻辑：相对路径映射、URL 拼接、端点排序、可用动作、差异分类。
 */
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SnapshotBudgetError,
  candidateDiffType,
  compareDirectorySnapshots,
  compareFileSnapshots,
  compareSnapshots,
  enumerateSnapshot,
  joinSnapshotUrl,
  orderSnapshotEndpoints,
  parseListXml,
  parseSummarizeXml,
  relativePathUnderRoot,
  resolveDeletionPrecedingRevision,
  resolveSnapshotNode,
  snapshotNodeActions,
  type RepoNodeRef,
  type SnapshotEndpointInput,
} from '../src/core/snapshot';
import { parseRemoteInfoXml } from '../src/core/remoteBrowse';
import { createSvnLab, writeFile, type SvnLab } from './helpers';

let hasSvn = false;
try {
  execSync('svn --version', { stdio: 'ignore' });
  hasSvn = true;
} catch {
  hasSvn = false;
}

let hasSvnadmin = false;
try {
  execSync('svnadmin --version', { stdio: 'ignore' });
  hasSvnadmin = true;
} catch {
  hasSvnadmin = false;
}

/* ------------------------------ 纯解析测试 ------------------------------ */

describe('core/snapshot：summarize XML 解析', () => {
  const XML = `<?xml version="1.0" encoding="UTF-8"?>
<diff>
<paths>
<path props="none" kind="file" item="modified">https://example.com/repo/trunk/a.txt</path>
<path props="modified" kind="file" item="none">https://example.com/repo/trunk/prop%20name.txt</path>
<path props="none" kind="file" item="deleted">https://example.com/repo/trunk/replace</path>
<path props="none" kind="dir" item="added">https://example.com/repo/trunk/replace</path>
<path props="modified" kind="dir" item="none">https://example.com/repo/trunk</path>
</paths>
</diff>
`;

  it('保留 (item, kind) 二元组：同 URL 的 deleted+added 两条都保留，item=none 原样', () => {
    const entries = parseSummarizeXml(XML);
    expect(entries).toHaveLength(5);
    expect(entries[0]).toEqual({
      path: 'https://example.com/repo/trunk/a.txt',
      item: 'modified',
      props: 'none',
      kind: 'file',
    });
    // 属性-only 的 item 字面值为 none；path 保留 URL 编码（%20），不 trim。
    expect(entries[1]).toEqual({
      path: 'https://example.com/repo/trunk/prop%20name.txt',
      item: 'none',
      props: 'modified',
      kind: 'file',
    });
    // 类型替换：同一 URL 的 deleted(file) 与 added(dir) 两条记录；不能按 URL 去重。
    const replace = entries.filter((entry) => entry.path.endsWith('/replace'));
    expect(replace).toEqual([
      { path: 'https://example.com/repo/trunk/replace', item: 'deleted', props: 'none', kind: 'file' },
      { path: 'https://example.com/repo/trunk/replace', item: 'added', props: 'none', kind: 'dir' },
    ]);
    // 目录根自身的属性变化也保留（相对路径为空串由映射层处理）。
    expect(entries[4]).toEqual({
      path: 'https://example.com/repo/trunk',
      item: 'none',
      props: 'modified',
      kind: 'dir',
    });
  });

  it('条目预算与字节预算独立触发，抛出带 limit 的 SnapshotBudgetError', () => {
    expect(() => parseSummarizeXml(XML, { maxEntries: 2 })).toThrowError(SnapshotBudgetError);
    try {
      parseSummarizeXml(XML, { maxEntries: 2 });
    } catch (err) {
      expect((err as SnapshotBudgetError).limit).toBe('entries');
    }
    try {
      parseSummarizeXml(XML, { maxBytes: 64 });
    } catch (err) {
      expect((err as SnapshotBudgetError).limit).toBe('bytes');
    }
  });
});

describe('core/snapshot：list XML 解析（原样名称转逐段编码）', () => {
  const XML = `<?xml version="1.0" encoding="UTF-8"?>
<lists>
<list path="https://example.com/repo/trunk">
<entry kind="file">
<name>spaced name.txt</name>
<size>12</size>
<commit revision="3"><author>A&amp;B</author><date>2026-01-01T00:00:00.000000Z</date></commit>
</entry>
<entry kind="dir">
<name>中文 目录</name>
</entry>
<entry kind="file">
<name>sub/a@b#c.txt</name>
</entry>
<entry kind="file">
<name> leading and trailing </name>
</entry>
</list>
</lists>
`;

  it('name 不 trim、实体解码一次，相对路径逐段百分号编码（空格/中文/@/#）', () => {
    const entries = parseListXml(XML);
    expect(entries.map((entry) => entry.relativePath)).toEqual([
      'spaced%20name.txt',
      '%E4%B8%AD%E6%96%87%20%E7%9B%AE%E5%BD%95',
      'sub/a%40b%23c.txt',
      '%20leading%20and%20trailing%20',
    ]);
    expect(entries[0]).toMatchObject({
      kind: 'file',
      size: 12,
      lastChangedRevision: 3,
      lastChangedAuthor: 'A&B',
      lastChangedDate: '2026-01-01T00:00:00.000000Z',
    });
    expect(entries[1]).toMatchObject({ kind: 'dir', size: undefined });
  });

  it('条目预算超限', () => {
    expect(() => parseListXml(XML, { maxEntries: 1 })).toThrowError(SnapshotBudgetError);
  });
});

describe('core/snapshot：info XML 解析（复用 remoteBrowse 冻结类型）', () => {
  it('字段齐全：原始 URL、解码相对路径、快照/最后修改 revision、size、缺省 author', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<info>
<entry kind="file" path="https://example.com/repo/trunk/a.txt" revision="5" size="42">
<url>https://example.com/repo/trunk/a.txt</url>
<relative-url>^/trunk/a%20b.txt</relative-url>
<repository>
<root>https://example.com/repo</root>
<uuid>uuid-1</uuid>
</repository>
<commit revision="4">
<date>2026-01-01T00:00:00.000000Z</date>
</commit>
</entry>
</info>`;
    const info = parseRemoteInfoXml(xml);
    expect(info?.node).toEqual({
      repositoryUuid: 'uuid-1',
      repositoryRootUrl: 'https://example.com/repo',
      rawUrl: 'https://example.com/repo/trunk/a.txt',
      // remoteBrowse 契约：relativePath 逐段解码一次。
      relativePath: 'trunk/a b.txt',
      snapshotRevision: 5,
      lastChangedRevision: 4,
      lastChangedAuthor: undefined,
      lastChangedDate: '2026-01-01T00:00:00.000000Z',
      kind: 'file',
    });
    expect(info?.sizeBytes).toBe(42);
  });

  it('缺必需字段返回 undefined；目录不取 size', () => {
    expect(parseRemoteInfoXml('<info></info>')).toBeUndefined();
    const dirXml = `<info><entry kind="dir" revision="2"><url>file:///r/trunk</url><repository><root>file:///r</root><uuid>u</uuid></repository><commit revision="1"><author>bob</author><date>d</date></commit></entry></info>`;
    const info = parseRemoteInfoXml(dirXml);
    expect(info?.node).toMatchObject({ kind: 'dir', relativePath: 'trunk' });
    expect(info?.sizeBytes).toBeUndefined();
  });
});

describe('core/snapshot：相对路径映射 / URL 拼接 / 端点排序', () => {
  it('旧根剥离：原样前缀、根自身、编码大小写回退、非本根', () => {
    expect(relativePathUnderRoot('file:///repo/trunk', 'file:///repo/trunk/a.txt')).toBe('a.txt');
    expect(relativePathUnderRoot('file:///repo/trunk/', 'file:///repo/trunk/a.txt')).toBe('a.txt');
    expect(relativePathUnderRoot('file:///repo/trunk', 'file:///repo/trunk')).toBe('');
    expect(relativePathUnderRoot('file:///repo/trunk', 'file:///repo/trunk/spaced%20name.txt'))
      .toBe('spaced%20name.txt');
    // 编码十六进制大小写不同：逐段解码比较后仍从输出路径取编码段。
    expect(relativePathUnderRoot('https://h/repo/%E4%B8%AD', 'https://h/repo/%e4%b8%ad/a.txt'))
      .toBe('a.txt');
    expect(relativePathUnderRoot('https://h/repo/trunk', 'https://h/repo/trunk2/a.txt'))
      .toBeUndefined();
    expect(relativePathUnderRoot('https://h/repo/trunk', 'https://h/repo')).toBeUndefined();
  });

  it('拼 URL：相对路径为空返回根，尾斜杠归一，不二次编码', () => {
    expect(joinSnapshotUrl('https://h/repo/trunk/', '')).toBe('https://h/repo/trunk');
    expect(joinSnapshotUrl('https://h/repo/trunk', 'a%20b/c.txt')).toBe('https://h/repo/trunk/a%20b/c.txt');
    expect(joinSnapshotUrl('file:///repo', 'a.txt')).toBe('file:///repo/a.txt');
  });

  it('orderSnapshotEndpoints：按 revision 数值定左右，与勾选顺序无关', () => {
    const a: SnapshotEndpointInput = { url: 'u-a', revision: 7 };
    const b: SnapshotEndpointInput = { url: 'u-b', revision: 2 };
    const ordered = orderSnapshotEndpoints(a, b);
    expect(ordered.left.revision).toBe(2);
    expect(ordered.right.revision).toBe(7);
    expect(orderSnapshotEndpoints(b, a)).toEqual(ordered);
  });
});

describe('core/snapshot：可用动作与差异分类', () => {
  const fileNode: RepoNodeRef = {
    repositoryUuid: 'u',
    repositoryRootUrl: 'file:///r',
    rawUrl: 'file:///r/f.txt',
    relativePath: 'f.txt',
    snapshotRevision: 3,
    lastChangedRevision: 2,
    kind: 'file',
  };
  const dirNode: RepoNodeRef = { ...fileNode, rawUrl: 'file:///r/d', relativePath: 'd', kind: 'dir' };

  it('present 文件/目录、absent、notFound 的动作集合', () => {
    expect(snapshotNodeActions({ state: 'present', node: fileNode }))
      .toEqual(['openContent', 'exportVersion', 'blame']);
    expect(snapshotNodeActions({ state: 'present', node: dirNode })).toEqual(['checkoutRevision']);
    expect(snapshotNodeActions({ state: 'absent', url: 'file:///r/f.txt', revision: 5 }))
      .toEqual(['exportPrecedingVersion']);
    expect(snapshotNodeActions({ state: 'notFoundAtRevision', url: 'file:///r/x', revision: 1 }))
      .toEqual([]);
  });

  it('属性-only 归 property，内容+属性归 content，新增/删除直映射', () => {
    const base = {
      relativePath: 'a.txt',
      leftPresent: true,
      rightPresent: true,
      props: 'none',
      kind: 'file',
    };
    expect(candidateDiffType({ ...base, item: 'none', props: 'modified' })).toBe('property');
    expect(candidateDiffType({ ...base, item: 'modified', props: 'modified' }, true)).toBe('property');
    expect(candidateDiffType({ ...base, item: 'modified', props: 'modified' })).toBe('content');
    expect(candidateDiffType({ ...base, item: 'added', leftPresent: false, rightPresent: true })).toBe('added');
    expect(candidateDiffType({ ...base, item: 'deleted', leftPresent: true, rightPresent: false })).toBe('deleted');
    expect(candidateDiffType({ ...base, item: 'modified' })).toBe('content');
  });
});

/* ------------------------------ 真实 SVN 集成 ------------------------------ */

interface Fixture {
  lab: SvnLab;
  wc: string;
  url(path: string): string;
}

/**
 * r1：trunk/a.txt、prop.txt、dir1/f1.txt、dir1/sub/f2.txt、spaced name.txt、
 *     p/deep.txt、p/other.txt；
 * r2：修改 a.txt + prop.txt 设置 test:color + trunk 目录设置 test:dirprop；
 * r3：复制 dir1 → dir2；
 * r4：修改 dir2/f1.txt；
 * r5：删除 dir2；
 * r6：a.txt 文件→目录类型替换（delete + mkdir + add inside.txt）；
 * r7：删除 p/deep.txt；
 * r8：删除 p（父目录删除后，deep.txt 的删除前回退需跨过 r7）。
 */
function buildFixture(): Fixture {
  const lab = createSvnLab('svn-anywhere-snapshot-');
  const wc = lab.checkout('wc');
  writeFile(wc, 'trunk/a.txt', 'one\n', true);
  writeFile(wc, 'trunk/prop.txt', 'same content\n', true);
  writeFile(wc, 'trunk/dir1/f1.txt', 'f1 v1\n', true);
  writeFile(wc, 'trunk/dir1/sub/f2.txt', 'f2\n', true);
  writeFile(wc, 'trunk/spaced name.txt', 'spaced\n', true);
  writeFile(wc, 'trunk/p/deep.txt', 'deep\n', true);
  writeFile(wc, 'trunk/p/other.txt', 'other\n', true);
  lab.svn(['commit', '-q', '-m', 'r1'], wc);

  writeFile(wc, 'trunk/a.txt', 'two\n');
  lab.svn(['propset', '-q', 'test:color', 'red', join('trunk', 'prop.txt')], wc);
  // 目录自身属性变化：比较 trunk 两端时 summarize 会输出相对路径为空的根记录。
  lab.svn(['propset', '-q', 'test:dirprop', 'x', 'trunk'], wc);
  lab.svn(['commit', '-q', '-m', 'r2'], wc);

  lab.svn(['copy', '-q', 'trunk/dir1', 'trunk/dir2'], wc);
  lab.svn(['commit', '-q', '-m', 'r3'], wc);

  writeFile(wc, 'trunk/dir2/f1.txt', 'f1 v4\n');
  lab.svn(['commit', '-q', '-m', 'r4'], wc);
  // 每次提交后统一到同一 revision，避免混合 revision 的删除提交报 out of date。
  lab.svn(['update', '-q'], wc);

  lab.svn(['delete', '-q', 'trunk/dir2'], wc);
  lab.svn(['commit', '-q', '-m', 'r5'], wc);
  lab.svn(['update', '-q'], wc);

  lab.svn(['delete', '-q', 'trunk/a.txt'], wc);
  writeFile(wc, 'trunk/a.txt/inside.txt', 'inside\n', true);
  lab.svn(['commit', '-q', '-m', 'r6'], wc);
  lab.svn(['update', '-q'], wc);

  lab.svn(['delete', '-q', join('trunk', 'p', 'deep.txt')], wc);
  lab.svn(['commit', '-q', '-m', 'r7'], wc);
  lab.svn(['update', '-q'], wc);

  lab.svn(['delete', '-q', 'trunk/p'], wc);
  lab.svn(['commit', '-q', '-m', 'r8'], wc);

  return {
    lab,
    wc,
    url: (path: string) => `${lab.repoUrl}/${path}`,
  };
}

/**
 * 集成用例均为只读（解析/枚举/比较），共享同一夹具，避免每个用例重建
 * 10 个 revision 的仓库；工作副本只在用例内读取，不改写。
 */
let sharedFixture: Fixture | undefined;

beforeAll(() => {
  if (hasSvn && hasSvnadmin) {
    sharedFixture = buildFixture();
  }
}, 120_000);

afterAll(() => {
  sharedFixture?.lab.cleanup();
}, 30_000);

const integration = { timeout: 60_000 };

describe('core/snapshot：端点解析（真实 SVN）', () => {
  it.runIf(hasSvn && hasSvnadmin)('present：URL、kind、快照 revision 与最后修改 revision 分字段', integration, async () => {
    const fixture = sharedFixture!;
    const resolved = await resolveSnapshotNode('svn', {
      url: fixture.url('trunk/a.txt'),
      revision: 2,
    });
    expect(resolved.state).toBe('present');
    if (resolved.state === 'present') {
      expect(resolved.node).toMatchObject({
        rawUrl: fixture.url('trunk/a.txt'),
        repositoryRootUrl: fixture.lab.repoUrl,
        relativePath: 'trunk/a.txt',
        snapshotRevision: 2,
        lastChangedRevision: 2,
        kind: 'file',
      });
      expect(resolved.node.lastChangedDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }

    // 同路径在 r6 是目录（类型替换）：快照 revision 与节点类型随 revision 变化。
    const asDir = await resolveSnapshotNode('svn', {
      url: fixture.url('trunk/a.txt'),
      revision: 6,
    });
    expect(asDir.state).toBe('present');
    if (asDir.state === 'present') {
      expect(asDir.node.kind).toBe('dir');
      expect(asDir.node.snapshotRevision).toBe(6);
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('删除提交：有 deletionRevision 提示为 absent，否则 notFoundAtRevision（不是网络错误）', integration, async () => {
    const fixture = sharedFixture!;
    const deleted = await resolveSnapshotNode('svn', {
      url: fixture.url('trunk/dir2'),
      revision: 5,
      deletionRevision: 5,
    });
    expect(deleted.state).toBe('absent');
    if (deleted.state === 'absent') {
      expect(deleted.deletedAtRevision).toBe(5);
    }

    const withoutHint = await resolveSnapshotNode('svn', {
      url: fixture.url('trunk/dir2'),
      revision: 5,
    });
    expect(withoutHint.state).toBe('notFoundAtRevision');

    // 删除前 revision 可读。
    const beforeDelete = await resolveSnapshotNode('svn', {
      url: fixture.url('trunk/dir2'),
      revision: 4,
    });
    expect(beforeDelete.state).toBe('present');
  });

  it.runIf(hasSvn && hasSvnadmin)('删除前 revision：deletionRevision-1 直接可读；跨父目录删除按历史前序回退', integration, async () => {
    const fixture = sharedFixture!;
    const direct = await resolveDeletionPrecedingRevision('svn', {
      url: fixture.url('trunk/dir2'),
      deletionRevision: 5,
    });
    expect(direct).toMatchObject({ state: 'present', revision: 4, viaHistoryFallback: false });
    if (direct.state === 'present') {
      expect(direct.node.kind).toBe('dir');
    }

    // r8 删除父目录 p；deep.txt 实际在 r7 已删除，deletionRevision-1=7 不可读，
    // 按历史前序候选（r6）回退并明确实际 revision。
    const fallback = await resolveDeletionPrecedingRevision('svn', {
      url: fixture.url('trunk/p/deep.txt'),
      deletionRevision: 8,
      fallbackRevisions: [6, 1],
    });
    expect(fallback).toMatchObject({ state: 'present', revision: 6, viaHistoryFallback: true });
    if (fallback.state === 'present') {
      expect(fallback.node.rawUrl).toBe(fixture.url('trunk/p/deep.txt'));
    }

    const missing = await resolveDeletionPrecedingRevision('svn', {
      url: fixture.url('trunk/never'),
      deletionRevision: 2,
      fallbackRevisions: [1],
    });
    expect(missing.state).toBe('notFound');
  });
});

describe('core/snapshot：summarize 与目录映射（真实 SVN）', () => {
  it.runIf(hasSvn && hasSvnadmin)('目录比较：输出路径按 --old 根剥离再拼右根，禁止直接用输出 URL', integration, async () => {
    const fixture = sharedFixture!;
    const result = await compareDirectorySnapshots('svn', {
      targetKind: 'dir',
      left: { url: fixture.url('trunk/dir1'), revision: 1 },
      right: { url: fixture.url('trunk/dir2'), revision: 4 },
    });
    expect(result.state).toBe('ready');
    if (result.state !== 'ready') {
      return;
    }
    expect(result.source).toBe('summarize');
    const modified = result.candidates.find((candidate) => candidate.relativePath === 'f1.txt');
    expect(modified).toMatchObject({
      item: 'modified',
      props: 'none',
      kind: 'file',
      leftPresent: true,
      rightPresent: true,
      leftRevision: 1,
      rightRevision: 4,
    });
    expect(modified?.leftUrl).toBe(fixture.url('trunk/dir1/f1.txt'));
    expect(modified?.rightUrl).toBe(fixture.url('trunk/dir2/f1.txt'));

    // 反证：旧根输出 URL 直接读会得到旧端内容；右根重拼才读到新端内容
    //（右端路径在主仓 HEAD 已随 dir2 删除，读取必须带明确 revision）。
    const leftContent = fixture.lab.svn(['cat', `${modified!.leftUrl!}@1`]);
    const rightContent = fixture.lab.svn(['cat', `${modified!.rightUrl!}@4`]);
    expect(leftContent).toBe('f1 v1\n');
    expect(rightContent).toBe('f1 v4\n');

    // 返回顺序不稳定（1.6.17 同请求两种顺序）：重复执行候选必须稳定排序且相等。
    const again = await compareDirectorySnapshots('svn', {
      targetKind: 'dir',
      left: { url: fixture.url('trunk/dir1'), revision: 1 },
      right: { url: fixture.url('trunk/dir2'), revision: 4 },
    });
    expect(again.state === 'ready' && again.candidates).toEqual(result.candidates);
  });

  it.runIf(hasSvn && hasSvnadmin)('类型替换保留 (item,kind) 两条；属性-only 的 item=none；根属性变化相对路径为空', integration, async () => {
    const fixture = sharedFixture!;
    const result = await compareDirectorySnapshots('svn', {
      targetKind: 'dir',
      left: { url: fixture.url('trunk'), revision: 1 },
      right: { url: fixture.url('trunk'), revision: 8 },
    });
    expect(result.state).toBe('ready');
    if (result.state !== 'ready') {
      return;
    }

    // r6 把 a.txt 从文件替换成目录：同相对路径两条记录，不能按 URL 去重。
    const replaced = result.candidates.filter((candidate) => candidate.relativePath === 'a.txt');
    expect(replaced).toHaveLength(2);
    expect(replaced[0]).toMatchObject({
      item: 'deleted',
      kind: 'file',
      leftPresent: true,
      rightPresent: false,
      rightUrl: undefined,
    });
    expect(replaced[1]).toMatchObject({
      item: 'added',
      kind: 'dir',
      leftPresent: false,
      rightPresent: true,
      leftUrl: undefined,
    });

    // 属性-only：prop.txt 内容未变、仅 test:color 变化 → item=none props=modified。
    const propertyOnly = result.candidates.find((candidate) => candidate.relativePath === 'prop.txt');
    expect(propertyOnly).toMatchObject({
      item: 'none',
      props: 'modified',
      kind: 'file',
      leftPresent: true,
      rightPresent: true,
    });
    expect(candidateDiffType(propertyOnly!)).toBe('property');

    // 根目录自身的属性变化：old 根剥离后相对路径为空，两端 URL 都是目录根。
    const rootProp = result.candidates.find((candidate) => candidate.relativePath === '');
    expect(rootProp).toMatchObject({
      item: 'none',
      props: 'modified',
      kind: 'dir',
      leftPresent: true,
      rightPresent: true,
      leftUrl: fixture.url('trunk'),
      rightUrl: fixture.url('trunk'),
    });

    // 候选相对路径稳定升序（不依赖返回顺序）。
    const paths = result.candidates.map((candidate) => candidate.relativePath);
    expect([...paths].sort()).toEqual(paths);
  });

  it.runIf(hasSvn && hasSvnadmin)('单端不存在：用 list 枚举存在端（已删除路径 peg + operative revision）', integration, async () => {
    const fixture = sharedFixture!;
    // 右端已删除（r5 之后 dir2 不存在）：用左端 r4 枚举整树删除。
    const deletedRight = await compareDirectorySnapshots('svn', {
      targetKind: 'dir',
      left: { url: fixture.url('trunk/dir2'), revision: 4 },
      right: { url: fixture.url('trunk/dir2'), revision: 5, deletionRevision: 5 },
    });
    expect(deletedRight.state).toBe('ready');
    if (deletedRight.state === 'ready') {
      expect(deletedRight.source).toBe('list-left');
      expect(deletedRight.candidates.length).toBeGreaterThanOrEqual(2);
      expect(deletedRight.candidates.every((candidate) => candidate.item === 'deleted')).toBe(true);
      expect(deletedRight.candidates.map((candidate) => candidate.relativePath))
        .toEqual(expect.arrayContaining(['f1.txt', 'sub/f2.txt']));
      expect(deletedRight.candidates[0].leftUrl).toMatch(/\/trunk\/dir2\//);
    }

    // 直接枚举已删除路径：URL@rev 与 -r rev 都等于快照 revision 才成功。
    const enumeration = await enumerateSnapshot('svn', {
      url: fixture.url('trunk/dir2'),
      revision: 4,
    });
    expect(enumeration.state).toBe('ready');
    if (enumeration.state === 'ready') {
      expect(enumeration.entries.map((entry) => entry.relativePath))
        .toEqual(expect.arrayContaining(['f1.txt', 'sub/f2.txt']));
    }

    // 左端从未存在：枚举右端生成新增。
    const neverLeft = await compareDirectorySnapshots('svn', {
      targetKind: 'dir',
      left: { url: fixture.url('trunk/never'), revision: 1 },
      right: { url: fixture.url('trunk/dir1'), revision: 1 },
    });
    expect(neverLeft.state).toBe('ready');
    if (neverLeft.state === 'ready') {
      expect(neverLeft.source).toBe('list-right');
      expect(neverLeft.candidates.every((candidate) => candidate.item === 'added')).toBe(true);
      expect(neverLeft.candidates[0].rightUrl).toMatch(/\/trunk\/dir1\//);
    }

    // 两端都不可读：无差异（不调用 summarize）。
    const bothMissing = await compareDirectorySnapshots('svn', {
      targetKind: 'dir',
      left: { url: fixture.url('trunk/never'), revision: 1 },
      right: { url: fixture.url('trunk/never'), revision: 2 },
    });
    expect(bothMissing).toMatchObject({ state: 'ready', source: 'none', candidates: [] });
  });

  it.runIf(hasSvn && hasSvnadmin)('单端枚举与 summarize 的条目预算返回 tooLarge（不展示部分候选）', integration, async () => {
    const fixture = sharedFixture!;
    const summarizeTooLarge = await compareDirectorySnapshots('svn', {
      targetKind: 'dir',
      left: { url: fixture.url('trunk'), revision: 1 },
      right: { url: fixture.url('trunk'), revision: 8 },
    }, {}, { maxEntries: 1 });
    expect(summarizeTooLarge).toMatchObject({ state: 'tooLarge', limit: 'entries', source: 'summarize' });

    const listTooLarge = await compareDirectorySnapshots('svn', {
      targetKind: 'dir',
      left: { url: fixture.url('trunk/dir2'), revision: 4 },
      right: { url: fixture.url('trunk/dir2'), revision: 5, deletionRevision: 5 },
    }, {}, { maxEntries: 1 });
    expect(listTooLarge).toMatchObject({ state: 'tooLarge', limit: 'entries', source: 'list-left' });

    const enumeration = await enumerateSnapshot('svn', {
      url: fixture.url('trunk/dir1'),
      revision: 1,
    }, {}, { maxBytes: 32 });
    expect(enumeration).toMatchObject({ state: 'tooLarge', limit: 'bytes' });
  });
});

describe('core/snapshot：文件比较（真实 SVN）', () => {
  it.runIf(hasSvn && hasSvnadmin)('两端存在：内容修改为 modified、属性-only 为 none（不开文本差异）', integration, async () => {
    const fixture = sharedFixture!;
    const content = await compareFileSnapshots('svn', {
      targetKind: 'file',
      left: { url: fixture.url('trunk/a.txt'), revision: 1 },
      right: { url: fixture.url('trunk/a.txt'), revision: 2 },
    });
    expect(content.state).toBe('ready');
    if (content.state === 'ready') {
      expect(content.source).toBe('summarize');
      expect(content.candidates).toHaveLength(1);
      expect(content.candidates[0]).toMatchObject({
        relativePath: '',
        item: 'modified',
        props: 'none',
        kind: 'file',
        leftPresent: true,
        rightPresent: true,
      });
      expect(candidateDiffType(content.candidates[0])).toBe('content');
    }

    const propertyOnly = await compareFileSnapshots('svn', {
      targetKind: 'file',
      left: { url: fixture.url('trunk/prop.txt'), revision: 1 },
      right: { url: fixture.url('trunk/prop.txt'), revision: 2 },
    });
    expect(propertyOnly.state).toBe('ready');
    if (propertyOnly.state === 'ready') {
      expect(propertyOnly.candidates[0]).toMatchObject({
        relativePath: '',
        item: 'none',
        props: 'modified',
        kind: 'file',
      });
      expect(candidateDiffType(propertyOnly.candidates[0])).toBe('property');
    }

    // 无差异：空候选。
    const same = await compareFileSnapshots('svn', {
      targetKind: 'file',
      left: { url: fixture.url('trunk/dir1/f1.txt'), revision: 1 },
      right: { url: fixture.url('trunk/dir1/f1.txt'), revision: 1 },
    });
    expect(same).toMatchObject({ state: 'ready', source: 'summarize', candidates: [] });
  });

  it.runIf(hasSvn && hasSvnadmin)('用户勾选顺序不影响比较方向：反向入参仍以较小 revision 为左/旧端', integration, async () => {
    const fixture = sharedFixture!;
    const reversed = await compareFileSnapshots('svn', {
      targetKind: 'file',
      // 故意把新 revision 放在 left、旧 revision 放在 right。
      left: { url: fixture.url('trunk/a.txt'), revision: 2 },
      right: { url: fixture.url('trunk/a.txt'), revision: 1 },
    });
    expect(reversed.state).toBe('ready');
    if (reversed.state === 'ready') {
      expect(reversed.left.state === 'present' && reversed.left.node.snapshotRevision).toBe(1);
      expect(reversed.right.state === 'present' && reversed.right.node.snapshotRevision).toBe(2);
      expect(reversed.candidates[0]).toMatchObject({
        item: 'modified',
        leftPresent: true,
        rightPresent: true,
        leftRevision: 1,
        rightRevision: 2,
      });
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('单端已删除：直接生成删除候选（不调 summarize），删除前可读版本可解析', integration, async () => {
    const fixture = sharedFixture!;
    const deleted = await compareFileSnapshots('svn', {
      targetKind: 'file',
      left: { url: fixture.url('trunk/dir2/f1.txt'), revision: 4 },
      right: { url: fixture.url('trunk/dir2/f1.txt'), revision: 5, deletionRevision: 5 },
    });
    expect(deleted.state).toBe('ready');
    if (deleted.state === 'ready') {
      expect(deleted.source).toBe('endpoint');
      expect(deleted.candidates).toHaveLength(1);
      expect(deleted.candidates[0]).toMatchObject({
        relativePath: '',
        item: 'deleted',
        kind: 'file',
        leftPresent: true,
        rightPresent: false,
      });
      expect(deleted.candidates[0].leftUrl).toBe(fixture.url('trunk/dir2/f1.txt'));
    }

    const preceding = await resolveDeletionPrecedingRevision('svn', {
      url: fixture.url('trunk/dir2/f1.txt'),
      deletionRevision: 5,
    });
    expect(preceding.state).toBe('present');
    if (preceding.state === 'present') {
      expect(preceding.revision).toBe(4);
      expect(fixture.lab.svn(['cat', `${preceding.node.rawUrl}@${preceding.revision}`]))
        .toBe('f1 v4\n');
    }

    // 复制目录内的修改：r3 复制时 f1.txt 已存在、r4 修改 → modified 候选。
    const modifiedInCopy = await compareFileSnapshots('svn', {
      targetKind: 'file',
      left: { url: fixture.url('trunk/dir2/f1.txt'), revision: 3 },
      right: { url: fixture.url('trunk/dir2/f1.txt'), revision: 4 },
    });
    expect(modifiedInCopy.state).toBe('ready');
    if (modifiedInCopy.state === 'ready') {
      expect(modifiedInCopy.candidates).toHaveLength(1);
      expect(modifiedInCopy.candidates[0]).toMatchObject({ item: 'modified', kind: 'file' });
    }

    // 左/旧端不存在（r2 时 dir2 尚未复制）：新增候选。
    const added = await compareFileSnapshots('svn', {
      targetKind: 'file',
      left: { url: fixture.url('trunk/dir2/f1.txt'), revision: 2 },
      right: { url: fixture.url('trunk/dir2/f1.txt'), revision: 4 },
    });
    expect(added.state).toBe('ready');
    if (added.state === 'ready') {
      expect(added.source).toBe('endpoint');
      expect(added.candidates[0]).toMatchObject({
        item: 'added',
        leftPresent: false,
        rightPresent: true,
      });
      expect(added.candidates[0].rightUrl).toBe(fixture.url('trunk/dir2/f1.txt'));
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('compareSnapshots 按 targetKind 分派', integration, async () => {
    const fixture = sharedFixture!;
    const file = await compareSnapshots('svn', {
      targetKind: 'file',
      left: { url: fixture.url('trunk/a.txt'), revision: 1 },
      right: { url: fixture.url('trunk/a.txt'), revision: 2 },
    });
    expect(file.state === 'ready' && file.source).toBe('summarize');

    const dir = await compareSnapshots('svn', {
      targetKind: 'dir',
      left: { url: fixture.url('trunk/dir1'), revision: 1 },
      right: { url: fixture.url('trunk/dir2'), revision: 4 },
    });
    expect(dir.state === 'ready' && dir.candidates.length).toBeGreaterThan(0);
  });
});
