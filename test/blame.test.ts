/**
 * core/blame 测试：
 * - 纯解析：entry/commit/author/date、空 entry（本地修改/新增行）、author
 *   缺失、实体一次解码、CDATA、任意字节分块（StringDecoder）、空文件
 *   （有 target 无 entry）、64 MiB 输出上限；
 * - 参数构造：本地工作文件必须**不带任何 -r**（实测任何 -r 都会按
 *   BASE 内容输出、与工作文件行号错位）；本地路径 escapePeg、远端 URL
 *   urlWithPeg；
 * - 真实本地 SVN：默认调用对齐工作文件（本地修改行无 commit）、URL 明确
 *   revision、空文件、二进制（空 <blame/> + 警告 → 不可追溯）、删除 revision、
 *   目录、未提交新增、@ 文件名、输出超限。
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  BLAME_XML_BYTE_LIMIT,
  BlameBudgetError,
  BlameXmlParser,
  buildBlameArgs,
  parseBlameXml,
  runBlame,
} from '../src/core/blame';
import { Utf8StreamDecoder } from '../src/core/svnCli';
import { SvnError } from '../src/core/errors';
import { createSvnLab, writeFile } from './helpers';

let hasSvn = false;
try {
  execFileSync('svn', ['--version'], { stdio: 'ignore' });
  hasSvn = true;
} catch {
  hasSvn = false;
}

let hasSvnadmin = false;
try {
  execFileSync('svnadmin', ['--version'], { stdio: 'ignore' });
  hasSvnadmin = true;
} catch {
  hasSvnadmin = false;
}

/* ------------------------------ 纯解析测试 ------------------------------ */

describe('core/blame：blame XML 解析', () => {
  const XML = `<?xml version="1.0" encoding="UTF-8"?>
<blame>
<target path="file.txt">
<entry line-number="1">
<commit revision="2">
<author>bob</author>
<date>2026-11-13T06:17:52.113537Z</date>
</commit>
</entry>
<entry line-number="2">
</entry>
<entry line-number="3">
<commit revision="9">
<author>A&amp;B &lt;C&gt;</author>
<date><![CDATA[2026-11-14T00:00:00.000000Z]]></date>
</commit>
</entry>
</target>
</blame>
`;

  it('逐行 revision/author/date；空 entry 无 commit；author 实体解码一次；CDATA 当文本', () => {
    const result = parseBlameXml(XML);
    expect(result.state).toBe('ready');
    expect(result.targetPath).toBe('file.txt');
    expect(result.lines).toEqual([
      { lineNumber: 1, revision: 2, author: 'bob', date: '2026-11-13T06:17:52.113537Z' },
      { lineNumber: 2 },
      { lineNumber: 3, revision: 9, author: 'A&B <C>', date: '2026-11-14T00:00:00.000000Z' },
    ]);
  });

  it('空文件：有 target 无 entry 是 ready + 0 行（不是不可追溯）', () => {
    const empty = parseBlameXml('<?xml version="1.0" encoding="UTF-8"?>\n<blame>\n<target path="empty.txt"></target>\n</blame>');
    expect(empty).toEqual({ state: 'ready', targetPath: 'empty.txt', lines: [] });
  });

  it('空 <blame/>（无 target）解析为 0 行，由调用方按 stderr 判定二进制', () => {
    expect(parseBlameXml('<?xml version="1.0" encoding="UTF-8"?><blame></blame>'))
      .toEqual({ state: 'ready', lines: [] });
  });

  it('author 中特殊字符跨任意字节分块仍正确（StringDecoder 跨 chunk）', () => {
    const xml = `<blame><target path="中文 文件.txt"><entry line-number="1"><commit revision="7"><author>作者 🚀 A&amp;B</author><date>2026-01-01T00:00:00Z</date></commit></entry></target></blame>`;
    const data = Buffer.from(xml, 'utf8');
    for (const sizes of [[1], [2], [3], [1, 2, 3, 5, 7, 11]]) {
      const parser = new BlameXmlParser();
      const decoder = new Utf8StreamDecoder();
      let offset = 0;
      let index = 0;
      while (offset < data.length) {
        const size = sizes[index % sizes.length] ?? 1;
        parser.feed(decoder.write(data.subarray(offset, Math.min(offset + size, data.length))));
        offset += size;
        index += 1;
      }
      parser.feed(decoder.end());
      const result = parser.end();
      expect(result.targetPath).toBe('中文 文件.txt');
      expect(result.lines).toEqual([
        { lineNumber: 1, revision: 7, author: '作者 🚀 A&B', date: '2026-01-01T00:00:00Z' },
      ]);
      expect(result.lines[0].author).not.toContain('�');
    }
  });

  it('输出字节上限：默认 64 MiB，超限抛 BlameBudgetError', () => {
    expect(BLAME_XML_BYTE_LIMIT).toBe(64 * 1024 * 1024);
    expect(() => parseBlameXml(XML, 32)).toThrowError(BlameBudgetError);
  });
});

describe('core/blame：命令参数构造', () => {
  it('本地工作文件不带任何 -r，@ 路径尾部补 peg', () => {
    const args = buildBlameArgs({ target: 'src/a.txt' });
    expect(args).toEqual(['blame', '--xml', '--non-interactive', '--', 'src/a.txt']);
    expect(args).not.toContain('-r');
    expect(buildBlameArgs({ target: 'a@1.txt' }).at(-1)).toBe('a@1.txt@');
  });

  it('本地工作文件指定 revision 直接拒绝（契约违规，不静默忽略）', () => {
    expect(() => buildBlameArgs({ target: 'a.txt', revision: 3 })).toThrow(/不带 -r/);
  });

  it('远端 URL：明确 revision 带 -r，URL 统一 urlWithPeg（无 revision 也补空 peg）', () => {
    const withRev = buildBlameArgs({ target: 'https://h/repo/f.txt', remote: true, revision: 5 });
    expect(withRev).toEqual([
      'blame', '--xml', '--non-interactive', '-r', '5', '--', 'https://h/repo/f.txt@5',
    ]);
    const withoutRev = buildBlameArgs({ target: 'https://h/repo/f.txt', remote: true });
    expect(withoutRev.at(-1)).toBe('https://h/repo/f.txt@');
    expect(withoutRev).not.toContain('-r');
    // 含字面 @ 的 URL 也由统一构造器补 peg。
    expect(buildBlameArgs({ target: 'https://h/repo/at@file.txt', remote: true, revision: 2 }).at(-1))
      .toBe('https://h/repo/at@file.txt@2');
  });
});

/* ------------------------------ 真实 SVN 集成 ------------------------------ */

interface BlameFixture {
  lab: ReturnType<typeof createSvnLab>;
  wc: string;
  deletionRevision: number;
}

/**
 * r1：file.txt（3 行）、a@1.txt、dir/child.txt；
 * r2：empty.txt（空文件）；
 * r3：复制 file.txt → copied.txt；
 * r4：binary.bin（NUL 内容 + svn:mime-type=application/octet-stream）；
 * r5：gone.txt；
 * r6：删除 gone.txt。
 */
function buildBlameFixture(): BlameFixture {
  const lab = createSvnLab('svn-anywhere-blame-');
  const wc = lab.checkout('wc');
  writeFile(wc, 'file.txt', 'line1\nline2\nline3\n', true);
  writeFile(wc, 'a@1.txt', 'at-file\n', true);
  writeFile(wc, 'dir/child.txt', 'child\n', true);
  lab.svn(['commit', '-q', '-m', 'r1'], wc);

  writeFile(wc, 'empty.txt', '', true);
  lab.svn(['commit', '-q', '-m', 'r2'], wc);

  lab.svn(['copy', '-q', 'file.txt', 'copied.txt'], wc);
  lab.svn(['commit', '-q', '-m', 'r3'], wc);

  writeFileSync(join(wc, 'binary.bin'), Buffer.from([0, 1, 2, 0, 3]));
  lab.svn(['add', '-q', 'binary.bin'], wc);
  lab.svn(['propset', '-q', 'svn:mime-type', 'application/octet-stream', 'binary.bin'], wc);
  lab.svn(['commit', '-q', '-m', 'r4'], wc);
  // 实测：同一 mime，旧 BASE 未 update 时可能不跳过；更新后再 blame 才稳定跳过。
  lab.svn(['update', '-q'], wc);

  writeFile(wc, 'gone.txt', 'gone\n', true);
  lab.svn(['commit', '-q', '-m', 'r5'], wc);
  lab.svn(['delete', '-q', 'gone.txt'], wc);
  lab.svn(['commit', '-q', '-m', 'r6'], wc);

  return { lab, wc, deletionRevision: 6 };
}

const integration = { timeout: 60_000 };

describe('core/blame：真实工作副本默认调用', () => {
  it.runIf(hasSvn && hasSvnadmin)('干净文件：行号 1..N，逐行 revision/author/date', integration, async () => {
    const fixture = buildBlameFixture();
    try {
      const result = await runBlame('svn', { target: 'file.txt' }, { cwd: fixture.wc });
      expect(result.state).toBe('ready');
      if (result.state !== 'ready') {
        return;
      }
      expect(result.targetPath).toBe('file.txt');
      expect(result.lines.map((line) => line.lineNumber)).toEqual([1, 2, 3]);
      expect(result.lines.every((line) => line.revision === 1)).toBe(true);
      expect(result.lines.every((line) => typeof line.author === 'string' && line.author !== '')).toBe(true);
      expect(result.lines.every((line) => /^\d{4}-\d{2}-\d{2}T/.test(line.date ?? ''))).toBe(true);
    } finally {
      fixture.lab.cleanup();
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('本地修改/新增行：默认调用对齐工作文件行数，修改行无 commit', integration, async () => {
    const fixture = buildBlameFixture();
    try {
      // 改第 2 行 + 末尾新增第 4 行：默认 blame 必须输出 4 行（=工作文件），
      // 而不是 -r BASE/1:HEAD 的 3 行（实测的行号错位场景）。
      writeFileSync(join(fixture.wc, 'file.txt'), 'line1\nCHANGED\nline3\nNEW\n');
      const result = await runBlame('svn', { target: 'file.txt' }, { cwd: fixture.wc });
      expect(result.state).toBe('ready');
      if (result.state !== 'ready') {
        return;
      }
      expect(result.lines.map((line) => line.lineNumber)).toEqual([1, 2, 3, 4]);
      expect(result.lines[0].revision).toBe(1);
      expect(result.lines[1].revision).toBeUndefined();
      expect(result.lines[1].author).toBeUndefined();
      expect(result.lines[2].revision).toBe(1);
      expect(result.lines[3].revision).toBeUndefined();
    } finally {
      fixture.lab.cleanup();
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('空文件是 ready + 0 行，与二进制空结果区分', integration, async () => {
    const fixture = buildBlameFixture();
    try {
      const result = await runBlame('svn', { target: 'empty.txt' }, { cwd: fixture.wc });
      expect(result).toEqual({ state: 'ready', targetPath: 'empty.txt', lines: [] });
    } finally {
      fixture.lab.cleanup();
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('@ 字面文件名经 escapePeg 正常追溯', integration, async () => {
    const fixture = buildBlameFixture();
    try {
      const result = await runBlame('svn', { target: 'a@1.txt' }, { cwd: fixture.wc });
      expect(result.state).toBe('ready');
      if (result.state === 'ready') {
        expect(result.lines).toHaveLength(1);
        expect(result.lines[0].revision).toBe(1);
      }
    } finally {
      fixture.lab.cleanup();
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('二进制：空 <blame/> + Skipping 警告映射为不可追溯（不是 0 行文件）', integration, async () => {
    const fixture = buildBlameFixture();
    try {
      const result = await runBlame('svn', { target: 'binary.bin' }, { cwd: fixture.wc });
      expect(result).toMatchObject({ state: 'notTraceable', reason: 'binary' });
      if (result.state === 'notTraceable') {
        expect(result.detail).toMatch(/Skipping binary file/i);
      }
    } finally {
      fixture.lab.cleanup();
    }
  });
});

describe('core/blame：真实 URL 与错误路径', () => {
  it.runIf(hasSvn && hasSvnadmin)('URL + 明确 revision：逐行追溯副本历史', integration, async () => {
    const fixture = buildBlameFixture();
    try {
      const fileUrl = `${fixture.lab.repoUrl}/file.txt`;
      const result = await runBlame('svn', { target: fileUrl, remote: true, revision: 1 });
      expect(result.state).toBe('ready');
      if (result.state === 'ready') {
        expect(result.targetPath).toBe(fileUrl);
        expect(result.lines).toHaveLength(3);
        expect(result.lines.every((line) => line.revision === 1)).toBe(true);
      }

      // 复制后的文件在 r3 的 blame 跟随历史（内容归属 r1）。
      const copied = await runBlame('svn', {
        target: `${fixture.lab.repoUrl}/copied.txt`,
        remote: true,
        revision: 3,
      });
      expect(copied.state).toBe('ready');
      if (copied.state === 'ready') {
        expect(copied.lines.every((line) => line.revision === 1)).toBe(true);
      }
    } finally {
      fixture.lab.cleanup();
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('删除 revision：W160013 + 未闭合 XML 按退出码分流为 notFound', integration, async () => {
    const fixture = buildBlameFixture();
    try {
      const result = await runBlame('svn', {
        target: `${fixture.lab.repoUrl}/gone.txt`,
        remote: true,
        revision: fixture.deletionRevision,
      });
      expect(result).toMatchObject({ state: 'notTraceable', reason: 'notFound' });
    } finally {
      fixture.lab.cleanup();
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('目录（W160017）与未提交新增（E195002）分别归类', integration, async () => {
    const fixture = buildBlameFixture();
    try {
      const directory = await runBlame('svn', { target: fixture.wc }, { cwd: fixture.wc });
      expect(directory).toMatchObject({ state: 'notTraceable', reason: 'directory' });

      // 未纳管路径：W155010 → notFound。
      writeFileSync(join(fixture.wc, 'untracked.txt'), 'x\n');
      const untracked = await runBlame('svn', { target: 'untracked.txt' }, { cwd: fixture.wc });
      expect(untracked).toMatchObject({ state: 'notTraceable', reason: 'notFound' });

      // 已 add 未提交：E195002 → noCommittedRevision。
      writeFile(fixture.wc, 'added.txt', 'added\n', true);
      const added = await runBlame('svn', { target: 'added.txt' }, { cwd: fixture.wc });
      expect(added).toMatchObject({ state: 'notTraceable', reason: 'noCommittedRevision' });
    } finally {
      fixture.lab.cleanup();
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('输出字节超限返回 tooLarge，不返回部分行', integration, async () => {
    const fixture = buildBlameFixture();
    try {
      const result = await runBlame(
        'svn',
        { target: 'file.txt', maxBytes: 64 },
        { cwd: fixture.wc },
      );
      expect(result).toMatchObject({ state: 'notTraceable', reason: 'tooLarge' });
    } finally {
      fixture.lab.cleanup();
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('XML 解析失败抛 SvnError(XML_PARSE)：消息为英文技术诊断', integration, async () => {
    const fixture = buildBlameFixture();
    try {
      const realSvn = execFileSync('which', ['svn'], { encoding: 'utf8' }).trim();
      const wrapper = join(fixture.lab.root, 'svn-blame-bad-xml.sh');
      writeFileSync(wrapper, [
        '#!/bin/bash',
        'if [ "$1" = "blame" ]; then',
        '  printf \'<blame><target path="file.txt"><entry line-number="1">\'',
        '  exit 0',
        'fi',
        `exec "${realSvn}" "$@"`,
        '',
      ].join('\n'));
      chmodSync(wrapper, 0o755);
      const err = await runBlame(wrapper, { target: 'file.txt' }, { cwd: fixture.wc })
        .catch((caught: unknown) => caught);
      expect(err).toBeInstanceOf(SvnError);
      // 稳定分类是 XML_PARSE；面向用户的文案由宿主映射。
      expect((err as SvnError).code).toBe('XML_PARSE');
      expect((err as Error).message).not.toMatch(/[一-鿿]/);
    } finally {
      fixture.lab.cleanup();
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('非零退出且 stderr 为空：消息为英文机器可读诊断（svn blame exit code N）', integration, async () => {
    const fixture = buildBlameFixture();
    try {
      const realSvn = execFileSync('which', ['svn'], { encoding: 'utf8' }).trim();
      const wrapper = join(fixture.lab.root, 'svn-blame-silent-fail.sh');
      writeFileSync(wrapper, [
        '#!/bin/bash',
        'if [ "$1" = "blame" ]; then',
        '  exit 3',
        'fi',
        `exec "${realSvn}" "$@"`,
        '',
      ].join('\n'));
      chmodSync(wrapper, 0o755);
      const err = await runBlame(wrapper, { target: 'file.txt' }, { cwd: fixture.wc })
        .catch((caught: unknown) => caught);
      expect(err).toBeInstanceOf(SvnError);
      expect((err as Error).message).toBe('svn blame exit code 3');
      expect((err as Error).message).not.toMatch(/[一-鿿]/);
    } finally {
      fixture.lab.cleanup();
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('认证失败（E170001）经统一补录重试：第一次半截 XML 不残留，重试得到完整行归属', integration, async () => {
    // runBlame 旧实现直接 runStream、不消费 getCredentials；
    // 修复后走 runOrThrowWithRunner，重试前重建解析器与解码器。
    const fixture = buildBlameFixture();
    try {
      const realSvn = execFileSync('which', ['svn'], { encoding: 'utf8' }).trim();
      const wrapper = join(fixture.lab.root, 'svn-blame-auth.sh');
      writeFileSync(wrapper, [
        '#!/bin/bash',
        'for arg in "$@"; do',
        '  if [ "$arg" = "--username" ]; then',
        `    exec "${realSvn}" "$@"`,
        '  fi',
        'done',
        'if [ "$1" = "blame" ]; then',
        '  printf \'<blame><target path="file.txt"><entry line-number="1"><commit revision="1"><author>half</author></commit></entry>\'',
        '  echo \'svn: E170001: Authentication failed\' >&2',
        '  exit 1',
        'fi',
        `exec "${realSvn}" "$@"`,
        '',
      ].join('\n'));
      chmodSync(wrapper, 0o755);

      const getCredentials = vi.fn().mockResolvedValue({ username: 'yu', password: 's3cret' });
      const result = await runBlame(wrapper, { target: 'file.txt' }, { cwd: fixture.wc, getCredentials });
      expect(getCredentials).toHaveBeenCalledTimes(1);
      expect(result.state).toBe('ready');
      if (result.state === 'ready') {
        // 真实 file.txt 三行；第一次尝试的半截 entry 不出现在结果里。
        expect(result.lines).toHaveLength(3);
        expect(result.lines.map((line) => line.lineNumber)).toEqual([1, 2, 3]);
        expect(result.lines[0]?.author).toBeTruthy();
        expect(result.lines[0]?.author).not.toBe('half');
      }
    } finally {
      fixture.lab.cleanup();
    }
  });
});
