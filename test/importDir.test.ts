/**
 * importDir core 测试：源目录枚举标注矩阵（symlink/special/控制字符名/
 * 不可读/嵌套副本/global-ignores 子树递归/摘要口径/阻止判定）、快照
 * digest（规范化序列化稳定、篡改 entries/dirs 任一不匹配、load 校验）、
 * 目标 URL 构建与规范化、说明 hash 两侧同口径、导入参数构建、源预检与
 * 开始前重检、结果核实三分类矩阵。svn 子进程经 mock runOrThrow 注入；
 * 真实 svn 的烟囱在 importDirLab.test.ts。
 */
import { execSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildImportArgs,
  buildImportTargetUrl,
  decodePathSegments,
  enumerateImportSource,
  enumerationToSnapshot,
  expectedFilePathsFromSnapshot,
  loadSnapshot,
  messageDigest,
  normalizeImportTarget,
  parseImportLogXml,
  parseParentInfoXml,
  precheckImportSource,
  recheckImportTarget,
  serializeSnapshot,
  snapshotDigest,
  verifyImportOutcome,
  verifyMessageFromXml,
  writeMessageTempFile,
  type ImportSourceEntry,
  type ImportSnapshot,
  type ParentIdentitySnapshot,
} from '../src/core/importDir';
import { SvnError } from '../src/core/errors';
import { runOrThrow, type RunResult } from '../src/core/svnCli';

vi.mock('../src/core/svnCli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/svnCli')>();
  return { ...actual, runOrThrow: vi.fn() };
});

const tempDirs: string[] = [];
const chmodRestore: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const path of chmodRestore.splice(0)) {
    try {
      chmodSync(path, 0o755);
    } catch {
      // 目录可能已被删除。
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.mocked(runOrThrow).mockReset();
});

function entryOf(enumeration: ReturnType<typeof enumerateImportSource>, path: string): ImportSourceEntry {
  const entry = enumeration.entries.find((e) => e.path === path);
  expect(entry, `缺少条目 ${path}`).toBeDefined();
  return entry as ImportSourceEntry;
}

// ---------------------------------------------------------------------------
// 源目录枚举
// ---------------------------------------------------------------------------

describe('enumerateImportSource', () => {
  it('目录清单含空目录；entries 全字段 schema；摘要计数口径（ignored 不入 fileCount/totalBytes）', () => {
    const dir = makeTempDir('svn-anywhere-imp-enum-');
    writeFileSync(join(dir, 'a.txt'), 'hello');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'b.txt'), 'world!');
    mkdirSync(join(dir, 'empty'));
    writeFileSync(join(dir, 'ignored.log'), 'xxx');

    const result = enumerateImportSource(dir, { ignorePatterns: ['*.log'] });

    expect(result.dirs).toEqual(['empty', 'sub']);
    expect(result.entries.map((e) => e.path)).toEqual(['a.txt', 'empty', 'ignored.log', 'sub', 'sub/b.txt']);
    const file = entryOf(result, 'a.txt');
    expect(file).toMatchObject({ kind: 'file', ignored: false, unreadable: false, nested: false, unsupported: false });
    expect(file.size).toBe(5);
    expect(typeof file.mtimeMs).toBe('number');
    expect(entryOf(result, 'empty')).toMatchObject({ kind: 'dir', ignored: false });
    expect(entryOf(result, 'ignored.log')).toMatchObject({ kind: 'file', ignored: true });
    // fileCount/totalBytes 只计 file|symlink 且 ignored=false。
    expect(result.summary.fileCount).toBe(2);
    expect(result.summary.totalBytes).toBe(11);
    expect(result.summary).toMatchObject({ symlinkCount: 0, unreadableCount: 0, nestedCount: 0, unsupportedCount: 0 });
    expect(result.blockers).toEqual([]);
  });

  it('符号链接单列 kind=symlink（不跟随、计入 fileCount）', () => {
    const dir = makeTempDir('svn-anywhere-imp-sym-');
    writeFileSync(join(dir, 'target.txt'), 'data');
    symlinkSync('target.txt', join(dir, 'link'));
    const result = enumerateImportSource(dir);
    expect(entryOf(result, 'link')).toMatchObject({ kind: 'symlink', unsupported: false });
    expect(result.summary.symlinkCount).toBe(1);
    expect(result.summary.fileCount).toBe(2);
    expect(result.blockers).toEqual([]);
  });

  it('FIFO 等特殊节点 → kind=special + unsupported → 阻止导入', () => {
    const dir = makeTempDir('svn-anywhere-imp-fifo-');
    let hasMkfifo = true;
    try {
      execSync('mkfifo --version', { stdio: 'ignore' });
    } catch {
      hasMkfifo = false;
    }
    if (hasMkfifo) {
      execSync(`mkfifo ${JSON.stringify(join(dir, 'pipe'))}`);
    }
    const result = enumerateImportSource(dir);
    if (hasMkfifo) {
      expect(entryOf(result, 'pipe')).toMatchObject({ kind: 'special', unsupported: true });
      expect(result.summary.specialItemCount).toBe(1);
      expect(result.summary.unsupportedCount).toBe(1);
      expect(result.blockers).toContain('unsupported');
    }
  });

  it('名称含控制字符的任意类型条目 → unsupported（不标 kind=special）', () => {
    const dir = makeTempDir('svn-anywhere-imp-ctrl-');
    writeFileSync(join(dir, 'ctrl\u0001name'), 'x');
    writeFileSync(join(dir, 'del\u007f'), 'y');
    const result = enumerateImportSource(dir);
    expect(entryOf(result, 'ctrl\u0001name')).toMatchObject({ kind: 'file', unsupported: true });
    expect(entryOf(result, 'del\u007f')).toMatchObject({ kind: 'file', unsupported: true });
    expect(result.summary.specialItemCount).toBe(0);
    expect(result.summary.unsupportedCount).toBe(2);
    expect(result.blockers).toEqual(['unsupported']);
  });

  it('子树出现 .svn → 嵌套副本标注并阻止；.svn 内部不深入', () => {
    const dir = makeTempDir('svn-anywhere-imp-nested-');
    writeFileSync(join(dir, 'a.txt'), 'x');
    mkdirSync(join(dir, 'inner'));
    mkdirSync(join(dir, 'inner', '.svn'));
    writeFileSync(join(dir, 'inner', '.svn', 'wc.db'), 'meta');
    const result = enumerateImportSource(dir);
    expect(entryOf(result, 'inner/.svn')).toMatchObject({ kind: 'dir', nested: true });
    // .svn 内部条目不进清单。
    expect(result.entries.some((e) => e.path.startsWith('inner/.svn/'))).toBe(false);
    expect(result.summary.nestedCount).toBe(1);
    expect(result.blockers).toEqual(['nested']);
  });

  it('不可读目录 → unreadable 标注并阻止；不可读文件 → unreadable 标注并阻止', () => {
    const dir = makeTempDir('svn-anywhere-imp-unread-');
    mkdirSync(join(dir, 'locked-dir'));
    writeFileSync(join(dir, 'locked-dir', 'x.txt'), 'x');
    writeFileSync(join(dir, 'locked-file.txt'), 'y');
    chmodSync(join(dir, 'locked-dir'), 0o000);
    chmodSync(join(dir, 'locked-file.txt'), 0o000);
    chmodRestore.push(join(dir, 'locked-dir'), join(dir, 'locked-file.txt'));

    const result = enumerateImportSource(dir);
    expect(entryOf(result, 'locked-dir')).toMatchObject({ kind: 'dir', unreadable: true });
    expect(result.entries.some((e) => e.path === 'locked-dir/x.txt')).toBe(false);
    expect(entryOf(result, 'locked-file.txt')).toMatchObject({ kind: 'file', unreadable: true });
    expect(result.summary.unreadableCount).toBe(2);
    expect(result.blockers).toContain('unreadable');
  });

  it('global-ignores 目录命中：整棵子树递归标注 ignored、不计入计数、不阻断', () => {
    const dir = makeTempDir('svn-anywhere-imp-sub-');
    mkdirSync(join(dir, 'build'));
    writeFileSync(join(dir, 'build', 'out.txt'), 'x');
    mkdirSync(join(dir, 'build', 'deep'));
    writeFileSync(join(dir, 'build', 'deep', 'out2.txt'), 'y');
    mkdirSync(join(dir, 'build', 'empty-child'));
    writeFileSync(join(dir, 'keep.txt'), 'z');

    const result = enumerateImportSource(dir, { ignorePatterns: ['build'] });

    for (const path of ['build', 'build/out.txt', 'build/deep', 'build/deep/out2.txt', 'build/empty-child']) {
      expect(entryOf(result, path).ignored).toBe(true);
    }
    expect(entryOf(result, 'keep.txt').ignored).toBe(false);
    // ignored 目录不进目录清单（核实的目录子集断言以此为准）。
    expect(result.dirs).toEqual([]);
    expect(result.summary.fileCount).toBe(1);
    expect(result.summary.totalBytes).toBe(1);
    expect(result.blockers).toEqual([]);
  });

  it('ignored 子树内不再检测 nested/unsupported（不进导入集合，不影响预览=实际）', () => {
    const dir = makeTempDir('svn-anywhere-imp-ignnested-');
    mkdirSync(join(dir, 'build'), { recursive: true });
    mkdirSync(join(dir, 'build', '.svn'));
    writeFileSync(join(dir, 'build', 'ctrl\u0001'), 'x');
    const result = enumerateImportSource(dir, { ignorePatterns: ['build'] });
    expect(entryOf(result, 'build/.svn').nested).toBe(false);
    expect(entryOf(result, 'build/ctrl\u0001').unsupported).toBe(false);
    expect(result.blockers).toEqual([]);
  });

  it('源目录不存在 / 不是目录 / 自身不可读时抛错', () => {
    expect(() => enumerateImportSource(join(tmpdir(), 'svn-anywhere-no-such-dir-xyz')))
      .toThrow(/无法读取源目录|不存在/);
    const dir = makeTempDir('svn-anywhere-imp-notdir-');
    const filePath = join(dir, 'plain.txt');
    writeFileSync(filePath, 'x');
    expect(() => enumerateImportSource(filePath)).toThrow(/不是目录/);
  });

  it('枚举产物按 path 字典序稳定排序', () => {
    const dir = makeTempDir('svn-anywhere-imp-order-');
    writeFileSync(join(dir, 'b.txt'), 'x');
    writeFileSync(join(dir, 'a.txt'), 'x');
    mkdirSync(join(dir, 'z'));
    const first = enumerateImportSource(dir);
    const second = enumerateImportSource(dir);
    expect(first.entries.map((e) => e.path)).toEqual(['a.txt', 'b.txt', 'z']);
    expect(serializeSnapshot(enumerationToSnapshot(first))).toBe(serializeSnapshot(enumerationToSnapshot(second)));
  });
});

// ---------------------------------------------------------------------------
// 快照 digest 与 load
// ---------------------------------------------------------------------------

describe('快照 digest', () => {
  function sampleSnapshot(): ImportSnapshot {
    return {
      version: 1,
      entries: [
        { path: 'sub/b.txt', kind: 'file', size: 6, mtimeMs: 1, ignored: false, unreadable: false, nested: false, unsupported: false },
        { path: 'sub', kind: 'dir', size: 96, mtimeMs: 2, ignored: false, unreadable: false, nested: false, unsupported: false },
        { path: 'a.txt', kind: 'file', size: 5, mtimeMs: 3, ignored: false, unreadable: false, nested: false, unsupported: false },
      ],
      dirs: ['sub', 'z'],
    };
  }

  it('规范化序列化稳定：条目顺序无关，字段序固定', () => {
    const snapshot = sampleSnapshot();
    const shuffled: ImportSnapshot = {
      version: 1,
      entries: [...snapshot.entries].reverse(),
      dirs: [...snapshot.dirs].reverse(),
    };
    const text = serializeSnapshot(snapshot);
    expect(text).toBe(serializeSnapshot(shuffled));
    // 字段按 schema 声明序。
    expect(text.indexOf('"path"')).toBeLessThan(text.indexOf('"kind"'));
    expect(text.indexOf('"kind"')).toBeLessThan(text.indexOf('"size"'));
    expect(text).toContain('"unsupported":false');
  });

  it('篡改 entries 任一字段 → digest 不匹配；仅篡改 dirs 亦不匹配', () => {
    const snapshot = sampleSnapshot();
    const digest = snapshotDigest(snapshot);
    const tamperedEntry: ImportSnapshot = {
      ...snapshot,
      entries: snapshot.entries.map((e) => (e.path === 'a.txt' ? { ...e, size: 999 } : e)),
    };
    expect(snapshotDigest(tamperedEntry)).not.toBe(digest);
    const tamperedDirs: ImportSnapshot = { ...snapshot, dirs: ['sub'] };
    expect(snapshotDigest(tamperedDirs)).not.toBe(digest);
    expect(snapshotDigest({ ...snapshot, version: 2 })).not.toBe(digest);
  });

  it('loadSnapshot：合法文本通过并返回规范化快照；digest 校验拦截篡改', () => {
    const snapshot = sampleSnapshot();
    const text = JSON.stringify(snapshot);
    const digest = snapshotDigest(snapshot);

    const loaded = loadSnapshot(text, digest);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.snapshot.entries.map((e) => e.path)).toEqual(['a.txt', 'sub', 'sub/b.txt']);
      expect(loaded.snapshot.dirs).toEqual(['sub', 'z']);
    }

    const tampered = JSON.stringify({ ...snapshot, dirs: ['sub'] });
    expect(loadSnapshot(tampered, digest)).toMatchObject({ ok: false, reason: 'digestMismatch' });
    expect(loadSnapshot(text, 'deadbeef')).toMatchObject({ ok: false, reason: 'digestMismatch' });
  });

  it('loadSnapshot：非法 JSON 与 schema 形态拒绝', () => {
    expect(loadSnapshot('not json')).toMatchObject({ ok: false, reason: 'invalidJson' });
    expect(loadSnapshot('{"version":1,"entries":[{"path":"a"}],"dirs":[]}'))
      .toMatchObject({ ok: false, reason: 'invalidSchema' });
    expect(loadSnapshot('{"entries":[],"dirs":[]}')).toMatchObject({ ok: false, reason: 'invalidSchema' });
    expect(loadSnapshot('{"version":1,"entries":[],"dirs":["ok"]}')).toMatchObject({ ok: true });
  });

  it('期望文件集合：file|symlink 且非 ignored（symlink 计入、ignored 剔除、dir 不计）', () => {
    const snapshot: ImportSnapshot = {
      version: 1,
      entries: [
        { path: 'a.txt', kind: 'file', size: 1, mtimeMs: 0, ignored: false, unreadable: false, nested: false, unsupported: false },
        { path: 'link', kind: 'symlink', size: 1, mtimeMs: 0, ignored: false, unreadable: false, nested: false, unsupported: false },
        { path: 'skip.log', kind: 'file', size: 1, mtimeMs: 0, ignored: true, unreadable: false, nested: false, unsupported: false },
        { path: 'sub', kind: 'dir', size: 1, mtimeMs: 0, ignored: false, unreadable: false, nested: false, unsupported: false },
      ],
      dirs: ['sub'],
    };
    expect([...expectedFilePathsFromSnapshot(snapshot)].sort()).toEqual(['a.txt', 'link']);
  });
});

// ---------------------------------------------------------------------------
// 目标 URL 与说明 hash
// ---------------------------------------------------------------------------

describe('buildImportTargetUrl / normalizeImportTarget', () => {
  it('目录名 encodeURIComponent 编码一次：中文、@、空格、#、?', () => {
    const parent = 'file:///srv/repo/trunk';
    expect(buildImportTargetUrl(parent, '中 文')).toBe(`file:///srv/repo/trunk/${encodeURIComponent('中 文')}`);
    expect(buildImportTargetUrl(parent, 'a@b')).toBe('file:///srv/repo/trunk/a%40b');
    expect(buildImportTargetUrl(parent, 'a#b')).toBe('file:///srv/repo/trunk/a%23b');
    expect(buildImportTargetUrl(parent, 'a?b')).toBe('file:///srv/repo/trunk/a%3Fb');
    expect(buildImportTargetUrl(parent, 'a%b')).toBe('file:///srv/repo/trunk/a%25b');
    expect(buildImportTargetUrl('file:///srv/repo/trunk/', 'x')).toBe('file:///srv/repo/trunk/x');
  });

  it('normalizeImportTarget：中文显示值编回 %XX、ASCII 与既有 %XX 原样', () => {
    expect(normalizeImportTarget('file:///srv/trunk/中')).toEqual({ ok: true, url: 'file:///srv/trunk/%E4%B8%AD' });
    expect(normalizeImportTarget('file:///srv/trunk/%E4%B8%AD')).toEqual({ ok: true, url: 'file:///srv/trunk/%E4%B8%AD' });
    expect(normalizeImportTarget('file:///srv/trunk/%40code')).toEqual({ ok: true, url: 'file:///srv/trunk/%40code' });
  });

  it('normalizeImportTarget：末尾字面 @ 编码为 %40（不加尾 @ 的对偶口径）', () => {
    expect(normalizeImportTarget('file:///srv/trunk/c@d@')).toEqual({ ok: true, url: 'file:///srv/trunk/c@d%40' });
    expect(normalizeImportTarget('file:///srv/trunk/c%40d')).toEqual({ ok: true, url: 'file:///srv/trunk/c%40d' });
  });

  it('normalizeImportTarget：非法形态拒绝（query/fragment/userinfo/协议/空格）', () => {
    expect(normalizeImportTarget('file:///srv/trunk/a b')).toMatchObject({ ok: false, reason: 'unencoded' });
    expect(normalizeImportTarget('file:///srv/trunk/a?b')).toMatchObject({ ok: false, reason: 'query' });
    expect(normalizeImportTarget('file:///srv/trunk/a#b')).toMatchObject({ ok: false, reason: 'fragment' });
    expect(normalizeImportTarget('http://user@host/trunk')).toMatchObject({ ok: false, reason: 'userinfo' });
    expect(normalizeImportTarget('ftp://host/trunk')).toMatchObject({ ok: false, reason: 'scheme' });
  });
});

describe('messageDigest / verifyMessageFromXml', () => {
  const sha256 = (text: string) => messageDigest(text);

  it('空说明 = 空字节串', () => {
    expect(messageDigest('')).toBe(sha256(''));
  });

  it('CRLF 与孤立 CR 归一为 LF；尾换行保留不归一', () => {
    expect(messageDigest('a\r\nb\r\n')).toBe(messageDigest('a\nb\n'));
    expect(messageDigest('a\rb')).toBe(messageDigest('a\nb'));
    expect(messageDigest('a\n')).not.toBe(messageDigest('a'));
  });

  it('XML <msg> 侧同口径：实体解码 + CRLF 两侧归一后 hash 相等', () => {
    const fileMessage = 'line1 & <tag>\r\nline2\r\n';
    // 解析器（htmlEntities）解码实体后的 <msg> 文本与临时文件内容同口径。
    const logEntry = parseImportLogXml(
      '<log><logentry revision="1"><msg>line1 &amp; &lt;tag&gt;\nline2\n</msg></logentry></log>',
    );
    expect(logEntry?.message).toBe('line1 & <tag>\nline2\n');
    expect(verifyMessageFromXml(logEntry?.message ?? '')).toBe(messageDigest(fileMessage));
    // 按原始标记文本（实体未解码）比较会漏判。
    expect(verifyMessageFromXml('line1 &amp; &lt;tag&gt;\nline2\n')).not.toBe(messageDigest(fileMessage));
    // 空说明两侧一致。
    expect(verifyMessageFromXml('')).toBe(messageDigest(''));
  });
});

// ---------------------------------------------------------------------------
// 导入参数构建
// ---------------------------------------------------------------------------

describe('writeMessageTempFile / buildImportArgs', () => {
  it('说明临时文件存在且内容为 UTF-8 原文（LF 归一只作用于 hash 视图）', () => {
    const message = '说明\r\n第二行\n';
    const temp = writeMessageTempFile(message);
    expect(existsSync(temp.messageFile)).toBe(true);
    expect(readFileSync(temp.messageFile, 'utf8')).toBe(message);
    expect(messageDigest(readFileSync(temp.messageFile, 'utf8'))).toBe(messageDigest(message));
    rmSync(temp.tempDir, { recursive: true, force: true });
  });

  it('导入参数：--file/--encoding/--non-interactive、源路径 peg 转义、目标 URL 原样', () => {
    const temp = writeMessageTempFile('msg');
    const args = buildImportArgs('file:///srv/trunk/a%40b', '/src/dir@x', temp.messageFile);
    expect(args).toEqual([
      'import',
      '--non-interactive',
      '--file',
      temp.messageFile,
      '--encoding',
      'UTF-8',
      '/src/dir@x@',
      'file:///srv/trunk/a%40b',
    ]);
    rmSync(temp.tempDir, { recursive: true, force: true });
  });

  it('目标 URL 不加尾 @、不调 escapeUrlPeg（字面 @ 原样）', () => {
    const temp = writeMessageTempFile('m');
    const args = buildImportArgs('file:///srv/trunk/c@d@', '/s', temp.messageFile);
    expect(args.at(-1)).toBe('file:///srv/trunk/c@d@');
    rmSync(temp.tempDir, { recursive: true, force: true });
  });

  it('源路径 - 开头加 ./ 前缀（本地路径 peg 规则；绝对路径不触发）', () => {
    const temp = writeMessageTempFile('m');
    const args = buildImportArgs('file:///u', '-weird', temp.messageFile);
    expect(args).toContain('./-weird');
    rmSync(temp.tempDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// XML 解析原语
// ---------------------------------------------------------------------------

describe('parseParentInfoXml / parseImportLogXml / decodePathSegments', () => {
  it('父目录 info：commit revision 为 last-changed（属性跨行形态可解析）', () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<info><entry\n   revision="5"\n   kind="dir"\n   path="trunk">',
      '<url>file:///tmp/repo/trunk</url><relative-url>^/trunk</relative-url>',
      '<repository><root>file:///tmp/repo</root><uuid>uuid-1</uuid></repository>',
      '<commit\n   revision="3"><author>y</author><date>2026-11-06T00:00:00Z</date></commit>',
      '</entry></info>',
    ].join('\n');
    expect(parseParentInfoXml(xml)).toEqual({
      kind: 'dir',
      repositoryUuid: 'uuid-1',
      repositoryRootUrl: 'file:///tmp/repo',
      lastChangedRevision: 3,
    });
    expect(parseParentInfoXml('<info></info>')).toBeUndefined();
  });

  it('log 解析：changed paths 属性、实体说明、空说明、paths 缺失', () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<log><logentry\n   revision="2"><author>y</author><date>d</date>',
      '<paths><path text-mods="false" kind="dir" action="A" prop-mods="false">/trunk/c@d</path>',
      '<path text-mods="true" kind="file" action="A" prop-mods="true">/trunk/c@d/link</path></paths>',
      '<msg>line1 &amp; &lt;tag&gt;\nline2\n</msg></logentry></log>',
    ].join('\n');
    expect(parseImportLogXml(xml)).toEqual({
      revision: 2,
      message: 'line1 & <tag>\nline2\n',
      paths: [
        { path: '/trunk/c@d', action: 'A', kind: 'dir' },
        { path: '/trunk/c@d/link', action: 'A', kind: 'file' },
      ],
    });
    expect(parseImportLogXml('<log><logentry revision="1"><msg></msg></logentry></log>'))
      .toEqual({ revision: 1, message: '', paths: [] });
    expect(parseImportLogXml('<log><logentry revision="1"></logentry></log>'))
      .toEqual({ revision: 1, message: '', paths: [] });
    expect(parseImportLogXml('<log/>')).toBeUndefined();
  });

  it('decodePathSegments：逐段解码、失败段原样', () => {
    expect(decodePathSegments('trunk/%E4%B8%AD%20%E6%96%87/a%23b')).toBe('trunk/中 文/a#b');
    expect(decodePathSegments('trunk/%D6%D0/x')).toBe('trunk/%D6%D0/x');
    expect(decodePathSegments('trunk/a@b')).toBe('trunk/a@b');
  });
});

// ---------------------------------------------------------------------------
// 源预检与开始前重检（mock svn）
// ---------------------------------------------------------------------------

const UUID = '11111111-2222-3333-4444-555555555555';
const ROOT = 'file:///tmp/repo';
const PARENT_URL = `${ROOT}/trunk`;
const TARGET_URL = `${PARENT_URL}/c%40d`;

const parentIdentity: ParentIdentitySnapshot = {
  repositoryUuid: UUID,
  repositoryRootUrl: ROOT,
  lastChangedRevision: 3,
};

function okResult(stdout = ''): RunResult {
  return { stdout, stderr: '', exitCode: 0 };
}

function parentInfoXml(uuid = UUID, root = ROOT, commitRevision = 3, kind = 'dir'): string {
  return `<info><entry kind="${kind}" revision="9"><url>${PARENT_URL}</url><relative-url>^/trunk</relative-url>`
    + `<repository><root>${root}</root><uuid>${uuid}</uuid></repository>`
    + `<commit revision="${commitRevision}"><author>y</author></commit></entry></info>`;
}

describe('precheckImportSource', () => {
  it('源路径不存在 / 不是目录', async () => {
    expect(await precheckImportSource('svn', '/no/such/path/xyz')).toMatchObject({ status: 'missing' });
    const dir = makeTempDir('svn-anywhere-imp-pre-');
    const file = join(dir, 'f.txt');
    writeFileSync(file, 'x');
    expect(await precheckImportSource('svn', file)).toMatchObject({ status: 'notDir' });
  });

  it('svn info 成功 → 已纳管（拒绝并改用提交功能）', async () => {
    const dir = makeTempDir('svn-anywhere-imp-pre-');
    vi.mocked(runOrThrow).mockResolvedValue(okResult('Path: x\n'));
    expect(await precheckImportSource('svn', dir)).toMatchObject({ status: 'versioned' });
  });

  it('E200009（副本内未纳管）与 E155007（副本外）→ 未版本控制放行', async () => {
    const dir = makeTempDir('svn-anywhere-imp-pre-');
    vi.mocked(runOrThrow).mockRejectedValueOnce(svnFailureStub('svn: E200009: Could not display info'));
    expect(await precheckImportSource('svn', dir)).toMatchObject({ status: 'unversioned' });
    vi.mocked(runOrThrow).mockRejectedValueOnce(svnFailureStub('svn: E155007: not a working copy'));
    expect(await precheckImportSource('svn', dir)).toMatchObject({ status: 'unversioned' });
  });

  it('spawn 失败 → svnMissing；其他失败 → unknown（不把读不出当未纳管）', async () => {
    const dir = makeTempDir('svn-anywhere-imp-pre-');
    vi.mocked(runOrThrow).mockRejectedValueOnce(new SvnError({
      message: '无法启动 svn', command: [], code: 'SPAWN_ERROR',
    }));
    expect(await precheckImportSource('svn', dir)).toMatchObject({ status: 'svnMissing' });
    vi.mocked(runOrThrow).mockRejectedValueOnce(svnFailureStub('svn: E155004: Working copy locked'));
    expect(await precheckImportSource('svn', dir)).toMatchObject({ status: 'unknown' });
  });
});

function svnFailureStub(stderr: string, code?: string): SvnError {
  return new SvnError({ message: stderr, command: [], stderr, code: code ?? stderr.match(/E\d{6}/)?.[0] });
}

describe('recheckImportTarget', () => {
  it('父 info + 目标不存在 → 通过并刷新 revision 锚点；URL 走 peg 转义', async () => {
    vi.mocked(runOrThrow).mockImplementation(async (_svnPath, args) => {
      if (args[0] === 'info') {
        return okResult(parentInfoXml(UUID, ROOT, 7));
      }
      if (args[0] === 'ls') {
        throw svnFailureStub('svn: E200009: Could not list all targets');
      }
      return okResult();
    });
    const result = await recheckImportTarget('svn', PARENT_URL, TARGET_URL, parentIdentity);
    expect(result).toEqual({ ok: true, parentIdentity: { ...parentIdentity, lastChangedRevision: 7 } });
    const lsCall = vi.mocked(runOrThrow).mock.calls.find(([, args]) => args[0] === 'ls');
    expect(lsCall?.[1].at(-1)).toBe(`${TARGET_URL}@`);
  });

  it('父身份不一致 → identityChanged；目标已存在 → targetExists', async () => {
    vi.mocked(runOrThrow).mockImplementation(async (_svnPath, args) => {
      if (args[0] === 'info') {
        return okResult(parentInfoXml('other-uuid', ROOT, 3));
      }
      return okResult();
    });
    expect(await recheckImportTarget('svn', PARENT_URL, TARGET_URL, parentIdentity))
      .toMatchObject({ ok: false, failure: 'identityChanged' });

    vi.mocked(runOrThrow).mockImplementation(async (_svnPath, args) => {
      if (args[0] === 'info') {
        return okResult(parentInfoXml());
      }
      return okResult();
    });
    expect(await recheckImportTarget('svn', PARENT_URL, TARGET_URL, parentIdentity))
      .toMatchObject({ ok: false, failure: 'targetExists' });
  });

  it('父不是目录 → parentNotDir；父不可达 → parentUnreachable；ls 其他失败 → targetCheckFailed', async () => {
    vi.mocked(runOrThrow).mockImplementation(async (_svnPath, args) => {
      if (args[0] === 'info') {
        return okResult(parentInfoXml(UUID, ROOT, 3, 'file'));
      }
      return okResult();
    });
    expect(await recheckImportTarget('svn', PARENT_URL, TARGET_URL, parentIdentity))
      .toMatchObject({ ok: false, failure: 'parentNotDir' });

    vi.mocked(runOrThrow).mockRejectedValue(svnFailureStub('svn: E175002: connection refused'));
    expect(await recheckImportTarget('svn', PARENT_URL, TARGET_URL, parentIdentity))
      .toMatchObject({ ok: false, failure: 'parentUnreachable' });

    vi.mocked(runOrThrow).mockImplementation(async (_svnPath, args) => {
      if (args[0] === 'info') {
        return okResult(parentInfoXml());
      }
      throw svnFailureStub('svn: E175002: connection refused');
    });
    expect(await recheckImportTarget('svn', PARENT_URL, TARGET_URL, parentIdentity))
      .toMatchObject({ ok: false, failure: 'targetCheckFailed' });
  });
});

// ---------------------------------------------------------------------------
// 结果核实三分类矩阵（mock svn）
// ---------------------------------------------------------------------------

function committedSnapshot(): ImportSnapshot {
  return {
    version: 1,
    entries: [
      { path: 'a.txt', kind: 'file', size: 5, mtimeMs: 1, ignored: false, unreadable: false, nested: false, unsupported: false },
      { path: 'link', kind: 'symlink', size: 9, mtimeMs: 2, ignored: false, unreadable: false, nested: false, unsupported: false },
      { path: 'skip.log', kind: 'file', size: 3, mtimeMs: 3, ignored: true, unreadable: false, nested: false, unsupported: false },
      { path: 'sub', kind: 'dir', size: 96, mtimeMs: 4, ignored: false, unreadable: false, nested: false, unsupported: false },
      { path: 'sub/b.txt', kind: 'file', size: 6, mtimeMs: 5, ignored: false, unreadable: false, nested: false, unsupported: false },
      { path: 'emptydir', kind: 'dir', size: 64, mtimeMs: 6, ignored: false, unreadable: false, nested: false, unsupported: false },
    ],
    dirs: ['emptydir', 'sub'],
  };
}

const MESSAGE = '导入说明\n';
const MESSAGE_DIGEST = messageDigest(MESSAGE);

function committedLogXml(opts: {
  rootAction?: string;
  paths?: Array<{ path: string; action: string; kind: string }>;
  msg?: string;
}): string {
  const paths = opts.paths ?? [
    { path: '/trunk/c@d', action: opts.rootAction ?? 'A', kind: 'dir' },
    { path: '/trunk/c@d/a.txt', action: 'A', kind: 'file' },
    { path: '/trunk/c@d/link', action: 'A', kind: 'file' },
    { path: '/trunk/c@d/sub', action: 'A', kind: 'dir' },
    { path: '/trunk/c@d/sub/b.txt', action: 'A', kind: 'file' },
    { path: '/trunk/c@d/emptydir', action: 'A', kind: 'dir' },
  ];
  const msg = opts.msg ?? '导入说明\n';
  const body = paths
    .map((p) => `<path kind="${p.kind}" action="${p.action}">${p.path
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</path>`)
    .join('');
  return `<log><logentry revision="2"><author>y</author><paths>${body}</paths>`
    + `<msg>${msg.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</msg></logentry></log>`;
}

interface VerifyFixture {
  snapshotText?: string;
  snapshot?: ImportSnapshot;
  expectedSnapshotDigest?: string;
  targetExists?: boolean;
  parentUuid?: string;
  parentCommitRevision?: number;
  lastChangedRevision?: string;
  relativeUrl?: string;
  logXml?: string;
  logFailure?: boolean;
}

function setupVerify(fixture: VerifyFixture): void {
  const snapshot = fixture.snapshot ?? committedSnapshot();
  const snapshotText = fixture.snapshotText ?? JSON.stringify(snapshot);
  const digest = fixture.expectedSnapshotDigest ?? snapshotDigest(snapshot);
  vi.mocked(runOrThrow).mockImplementation(async (_svnPath, args) => {
    if (args[0] === 'ls') {
      if (fixture.targetExists === false) {
        throw svnFailureStub('svn: W160013: Path not found\nsvn: E200009: Could not list all targets', 'E200009');
      }
      return okResult();
    }
    if (args[0] === 'info' && args.includes('--xml')) {
      return okResult(parentInfoXml(fixture.parentUuid ?? UUID, ROOT, fixture.parentCommitRevision ?? 3));
    }
    if (args[0] === 'info' && args.includes('last-changed-revision')) {
      return okResult(`${fixture.lastChangedRevision ?? '2'}\n`);
    }
    if (args[0] === 'info' && args.includes('relative-url')) {
      return okResult(fixture.relativeUrl ?? '^/trunk/c@d');
    }
    if (args[0] === 'log') {
      if (fixture.logFailure) {
        throw svnFailureStub('svn: E175002: connection refused');
      }
      return okResult(fixture.logXml ?? committedLogXml({ msg: MESSAGE }));
    }
    return okResult();
  });
  fixtureInput = {
    snapshotText,
    expectedSnapshotDigest: digest,
    targetUrl: TARGET_URL,
    parentUrl: PARENT_URL,
    parentIdentity,
    expectedMessageDigest: MESSAGE_DIGEST,
  };
}

let fixtureInput: Parameters<typeof verifyImportOutcome>[1];

describe('verifyImportOutcome', () => {
  it('快照缺失 / digest 不匹配 → unknown（snapshotIncomplete，不重建期望集合）', async () => {
    setupVerify({ targetExists: true });
    const digestFail = await verifyImportOutcome('svn', {
      ...fixtureInput,
      snapshotText: JSON.stringify({ ...committedSnapshot(), dirs: ['sub'] }),
    });
    expect(digestFail).toMatchObject({ kind: 'unknown', reason: 'snapshotIncomplete' });
    const missing = await verifyImportOutcome('svn', { ...fixtureInput, snapshotText: undefined, snapshot: undefined });
    expect(missing).toMatchObject({ kind: 'unknown', reason: 'snapshotIncomplete' });
    expect(vi.mocked(runOrThrow)).not.toHaveBeenCalled();
  });

  it('目标不存在 + 父目录三项全一致（UUID/root/revision 锚点）→ notCommitted', async () => {
    setupVerify({ targetExists: false, parentCommitRevision: 3 });
    const result = await verifyImportOutcome('svn', fixtureInput);
    expect(result).toEqual({ kind: 'notCommitted', evidence: { parentLastChangedRevision: 3 } });
  });

  it('父目录 revision 超过锚点（目标创建后被外部删除的甄别）→ unknown', async () => {
    setupVerify({ targetExists: false, parentCommitRevision: 5 });
    const result = await verifyImportOutcome('svn', fixtureInput);
    expect(result).toMatchObject({ kind: 'unknown', reason: 'parentRevisionAdvanced' });
    expect((result as { message?: string }).message).toContain('5');
  });

  it('父目录身份不一致 / 父不可达 / 目标 ls 其他失败 → unknown', async () => {
    setupVerify({ targetExists: false, parentUuid: 'other' });
    expect(await verifyImportOutcome('svn', fixtureInput)).toMatchObject({ kind: 'unknown', reason: 'parentIdentityChanged' });

    vi.mocked(runOrThrow).mockImplementation(async (_svnPath, args) => {
      if (args[0] === 'ls') {
        throw svnFailureStub('svn: E200009: Could not list all targets', 'E200009');
      }
      throw svnFailureStub('svn: E175002: connection refused');
    });
    expect(await verifyImportOutcome('svn', fixtureInput)).toMatchObject({ kind: 'unknown', reason: 'parentUnreachable' });

    vi.mocked(runOrThrow).mockImplementation(async (_svnPath, args) => {
      if (args[0] === 'ls') {
        throw svnFailureStub('svn: E175002: connection refused');
      }
      return okResult();
    });
    expect(await verifyImportOutcome('svn', fixtureInput)).toMatchObject({ kind: 'unknown', reason: 'targetLsFailed' });
  });

  it('全匹配（msg hash + 文件集合精确 + 目录子集 + 根 action=A）→ committed', async () => {
    setupVerify({ targetExists: true });
    const result = await verifyImportOutcome('svn', fixtureInput);
    expect(result).toEqual({ kind: 'committed', revision: 2 });
    // %40 目标的核实命令 URL 走 peg 转义（补尾 @）。
    const logCall = vi.mocked(runOrThrow).mock.calls.find(([, args]) => args[0] === 'log');
    expect(logCall?.[1].at(-1)).toBe(`${TARGET_URL}@`);
    const infoCall = vi.mocked(runOrThrow).mock.calls.find(([, args]) => args[0] === 'info' && args.includes('--xml'));
    expect(infoCall?.[1].at(-1)).toBe(`${PARENT_URL}`);
  });

  it('说明 hash 不符（可能并发同名提交）→ unknown', async () => {
    setupVerify({ targetExists: true, logXml: committedLogXml({ msg: '别人的提交\n' }) });
    expect(await verifyImportOutcome('svn', fixtureInput)).toMatchObject({ kind: 'unknown', reason: 'msgMismatch' });
  });

  it('目标根 action≠A（已存在/合并形态）→ unknown rootNotAdded', async () => {
    setupVerify({ targetExists: true, logXml: committedLogXml({ rootAction: 'M' }) });
    const result = await verifyImportOutcome('svn', fixtureInput);
    expect(result).toMatchObject({ kind: 'unknown', reason: 'rootNotAdded' });
    expect((result as { message?: string }).message).toContain('合并');
  });

  it('文件集合不精确（缺 symlink / 多文件 / ignored 混入）→ unknown fileSetMismatch', async () => {
    // 缺 symlink：log 文件少一条 link。
    setupVerify({
      targetExists: true,
      logXml: committedLogXml({
        paths: [
          { path: '/trunk/c@d', action: 'A', kind: 'dir' },
          { path: '/trunk/c@d/a.txt', action: 'A', kind: 'file' },
          { path: '/trunk/c@d/sub', action: 'A', kind: 'dir' },
          { path: '/trunk/c@d/sub/b.txt', action: 'A', kind: 'file' },
          { path: '/trunk/c@d/emptydir', action: 'A', kind: 'dir' },
        ],
      }),
    });
    expect(await verifyImportOutcome('svn', fixtureInput)).toMatchObject({ kind: 'unknown', reason: 'fileSetMismatch' });

    // 多一条 ignored 之外的文件（skip.log 实际不会被提交，若出现在 log 说明集合不精确）。
    setupVerify({
      targetExists: true,
      logXml: committedLogXml({
        paths: [
          { path: '/trunk/c@d', action: 'A', kind: 'dir' },
          { path: '/trunk/c@d/a.txt', action: 'A', kind: 'file' },
          { path: '/trunk/c@d/link', action: 'A', kind: 'file' },
          { path: '/trunk/c@d/extra.txt', action: 'A', kind: 'file' },
          { path: '/trunk/c@d/sub', action: 'A', kind: 'dir' },
          { path: '/trunk/c@d/sub/b.txt', action: 'A', kind: 'file' },
          { path: '/trunk/c@d/emptydir', action: 'A', kind: 'dir' },
        ],
      }),
    });
    expect(await verifyImportOutcome('svn', fixtureInput)).toMatchObject({ kind: 'unknown', reason: 'fileSetMismatch' });
  });

  it('dir 节点不在快照目录清单 → unknown dirNotInSnapshot', async () => {
    setupVerify({
      targetExists: true,
      logXml: committedLogXml({
        paths: [
          { path: '/trunk/c@d', action: 'A', kind: 'dir' },
          { path: '/trunk/c@d/a.txt', action: 'A', kind: 'file' },
          { path: '/trunk/c@d/link', action: 'A', kind: 'file' },
          { path: '/trunk/c@d/other-dir', action: 'A', kind: 'dir' },
          { path: '/trunk/c@d/sub', action: 'A', kind: 'dir' },
          { path: '/trunk/c@d/sub/b.txt', action: 'A', kind: 'file' },
          { path: '/trunk/c@d/emptydir', action: 'A', kind: 'dir' },
        ],
      }),
    });
    expect(await verifyImportOutcome('svn', fixtureInput)).toMatchObject({ kind: 'unknown', reason: 'dirNotInSnapshot' });
  });

  it('log 读取失败 / revision 输出异常 → unknown', async () => {
    setupVerify({ targetExists: true, logFailure: true });
    expect(await verifyImportOutcome('svn', fixtureInput)).toMatchObject({ kind: 'unknown', reason: 'logFailed' });

    setupVerify({ targetExists: true, lastChangedRevision: 'not-a-number' });
    expect(await verifyImportOutcome('svn', fixtureInput)).toMatchObject({ kind: 'unknown', reason: 'evidenceUnparsable' });
  });

  it('中文/空格前缀两侧解码归一（relative-url 编码形态 vs log 解码形态）', async () => {
    setupVerify({
      targetExists: true,
      relativeUrl: '^/trunk/%E4%B8%AD%20%E6%96%87',
      logXml: committedLogXml({
        paths: [
          { path: '/trunk/中 文', action: 'A', kind: 'dir' },
          { path: '/trunk/中 文/a.txt', action: 'A', kind: 'file' },
          { path: '/trunk/中 文/link', action: 'A', kind: 'file' },
          { path: '/trunk/中 文/sub', action: 'A', kind: 'dir' },
          { path: '/trunk/中 文/sub/b.txt', action: 'A', kind: 'file' },
          { path: '/trunk/中 文/emptydir', action: 'A', kind: 'dir' },
        ],
      }),
    });
    const result = await verifyImportOutcome('svn', { ...fixtureInput, targetUrl: `${PARENT_URL}/%E4%B8%AD%20%E6%96%87` });
    expect(result).toEqual({ kind: 'committed', revision: 2 });
  });
});
