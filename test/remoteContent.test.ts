/**
 * 远端文件内容 core 原语测试（core/remoteContent）：
 * - MIME/NUL 双重分类矩阵（text/*、非 text/*、NUL、UTF-16 已知边界、
 *   8 KiB 探测窗口）与打开方式规划（16 MiB 内嵌 / 2 GiB 临时文件）；
 * - 真实 svnadmin + file://：probe 读取 mime 与前 8 KiB、文本编码回退
 *   （GBK）、内嵌上限、空文件与不存在路径；
 * - runToFile 下载：成功原子改名无 .part、expectedBytes/运行中越限、
 *   磁盘余量不足、路径不存在与二进制字节一致。
 * XML/二进制 fixture 用内联字节；真实 svn 行为走 test/helpers。
 */
import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REMOTE_DISK_HEADROOM_BYTES,
  REMOTE_INLINE_TEXT_MAX_BYTES,
  REMOTE_TEMP_FILE_MAX_BYTES,
  buildRemoteCatArgs,
  classifyContentKind,
  downloadRemoteFile,
  planRemoteContentOpen,
  probeRemoteContent,
  readRemoteText,
} from '../src/core/remoteContent';
import { readRemoteNode } from '../src/core/remoteBrowse';
import { createSvnLab, writeFile } from './helpers';

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

/** 「中文」的 GBK 字节序列（D6 D0 CE C4），不是合法 UTF-8。 */
const GBK_ZHONGWEN = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);

/**
 * UTF-16LE 字节（含 BOM），混合中文与 ASCII：ASCII 字符的高字节为 0，
 * 字符间 NUL 会落入 8 KiB 探测窗口（纯中文的 UTF-16 两个字节都非零，
 * 不会被 NUL 判据命中）。
 */
const UTF16LE_SAMPLE = Buffer.concat([
  Buffer.from([0xff, 0xfe]),
  Buffer.from('中文 utf16', 'utf16le'),
]);

/** 写入任意字节内容（自动建父目录）。 */
function writeBytes(root: string, relative: string, bytes: Buffer): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

// ---------------------------------------------------------------------------
// MIME/NUL 双重分类（纯逻辑）
// ---------------------------------------------------------------------------

describe('classifyContentKind（MIME/NUL 双重分类）', () => {
  it.each([
    ['text/plain', Buffer.from('plain'), 'text', 'none'],
    [undefined, Buffer.from('plain'), 'text', 'none'],
    [undefined, Buffer.from('a\0b'), 'binary', 'nul'],
    ['text/plain', Buffer.from('a\0b'), 'binary', 'nul'],
    ['application/octet-stream', Buffer.from('plain'), 'binary', 'mime'],
    // SVG 等 image/* 按非 text/* 判二进制，不设例外。
    ['image/svg+xml', Buffer.from('<svg/>'), 'binary', 'mime'],
    ['TEXT/PLAIN', Buffer.from('plain'), 'text', 'none'],
    [undefined, Buffer.alloc(0), 'text', 'none'],
  ] as const)('mime=%s head=%j → %s/%s', (mimeType, head, kind, reason) => {
    expect(classifyContentKind(mimeType, head)).toMatchObject({ kind, reason });
  });

  it('UTF-16 文本因字符间 NUL 判二进制（已知边界）', () => {
    expect(classifyContentKind(undefined, UTF16LE_SAMPLE)).toMatchObject({
      kind: 'binary',
      reason: 'nul',
    });
  });

  it('NUL 只在前 8 KiB 窗口内识别：8183 字节后的 NUL 判文本', () => {
    const afterWindow = Buffer.alloc(8 * 1024 + 1, 0x61);
    afterWindow[8 * 1024] = 0;
    expect(classifyContentKind(undefined, afterWindow).kind).toBe('text');
    const insideWindow = Buffer.alloc(8 * 1024, 0x61);
    insideWindow[8 * 1024 - 1] = 0;
    expect(classifyContentKind(undefined, insideWindow)).toMatchObject({
      kind: 'binary',
      reason: 'nul',
    });
  });

  it('MIME 判二进制时 reason=mime 并回传 mimeType', () => {
    expect(classifyContentKind('image/png', Buffer.from('text'))).toEqual({
      kind: 'binary',
      reason: 'mime',
      mimeType: 'image/png',
    });
  });
});

describe('planRemoteContentOpen（16 MiB 内嵌 / 2 GiB 临时资源）', () => {
  it('默认阈值符合契约：16 MiB 内嵌 / 2 GiB 临时文件 / 64 MiB 磁盘余量', () => {
    expect(REMOTE_INLINE_TEXT_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(REMOTE_TEMP_FILE_MAX_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(REMOTE_DISK_HEADROOM_BYTES).toBe(64 * 1024 * 1024);
  });
  it('文本 ≤16 MiB（或大小未知）走内嵌只读预览', () => {
    expect(planRemoteContentOpen({ kind: 'text', sizeBytes: 15 * 1024 * 1024 }))
      .toMatchObject({ mode: 'inlineText' });
    expect(planRemoteContentOpen({ kind: 'text', sizeBytes: REMOTE_INLINE_TEXT_MAX_BYTES }))
      .toMatchObject({ mode: 'inlineText' });
    expect(planRemoteContentOpen({ kind: 'text' })).toMatchObject({ mode: 'inlineText' });
  });

  it('文本 >16 MiB 改为临时文件外部打开（textTooLarge）', () => {
    expect(planRemoteContentOpen({ kind: 'text', sizeBytes: 17 * 1024 * 1024 }))
      .toMatchObject({ mode: 'externalTempFile', reason: 'textTooLarge' });
  });

  it('二进制（含大小未知）改为临时文件外部打开（binary）', () => {
    expect(planRemoteContentOpen({ kind: 'binary', sizeBytes: 10 }))
      .toMatchObject({ mode: 'externalTempFile', reason: 'binary' });
    expect(planRemoteContentOpen({ kind: 'binary' }))
      .toMatchObject({ mode: 'externalTempFile', reason: 'binary' });
  });

  it('已知大小超过 2 GiB 返回 tooLarge（不启动 cat）', () => {
    expect(planRemoteContentOpen({ kind: 'binary', sizeBytes: REMOTE_TEMP_FILE_MAX_BYTES + 1 }))
      .toEqual({
        mode: 'tooLarge',
        sizeBytes: REMOTE_TEMP_FILE_MAX_BYTES + 1,
        limitBytes: REMOTE_TEMP_FILE_MAX_BYTES,
      });
    expect(planRemoteContentOpen({ kind: 'text', sizeBytes: REMOTE_TEMP_FILE_MAX_BYTES + 1 }).mode)
      .toBe('tooLarge');
  });
});

describe('buildRemoteCatArgs', () => {
  it('统一 peg 规则：固定 -r、--non-interactive 与 -- 分隔，含 @ 的 URL 尾部补 peg', () => {
    expect(buildRemoteCatArgs('https://h/repo/trunk/a@b.txt', 3)).toEqual([
      'cat',
      '-r',
      '3',
      '--non-interactive',
      '--',
      'https://h/repo/trunk/a@b.txt@3',
    ]);
    expect(buildRemoteCatArgs('https://h/repo/trunk/a%40b.txt', 3).at(-1))
      .toBe('https://h/repo/trunk/a%40b.txt@3');
  });
});

// ---------------------------------------------------------------------------
// 真实 svn（svnadmin + file:// 实验仓库）
// ---------------------------------------------------------------------------

interface ContentLab {
  trunkUrl: string;
  revisions: { afterProps: number };
  cleanup(): void;
}

/**
 * 构建内容分类夹具（r1 内容、r2 属性）：
 * - text.txt/empty.txt/big.txt/chinese.txt：无 mime 文本；
 * - bin.dat：svn add 自动 application/octet-stream；
 * - fake-text.bin：显式 text/plain 但内容含 NUL；
 * - utf16.txt：propdel 掉自动 mime 的 UTF-16LE 文本；
 * - svg.svg：显式 image/svg+xml 的纯文本内容。
 */
function buildContentLab(): ContentLab {
  const lab = createSvnLab('svn-anywhere-content-');
  const src = join(lab.root, 'src');
  writeBytes(src, 'text.txt', Buffer.from('hello 世界\n', 'utf8'));
  writeBytes(src, 'empty.txt', Buffer.alloc(0));
  writeBytes(src, 'big.txt', Buffer.from('a'.repeat(20 * 1024), 'utf8'));
  writeBytes(src, 'chinese.txt', Buffer.from('中文'.repeat(50_000), 'utf8'));
  writeBytes(src, 'bin.dat', Buffer.from([0x00, 0x01, 0x02, 0x03]));
  writeBytes(src, 'fake-text.bin', Buffer.from('a\0b', 'latin1'));
  writeBytes(src, 'utf16.txt', UTF16LE_SAMPLE);
  writeBytes(src, 'gbk.txt', GBK_ZHONGWEN);
  writeFile(src, 'svg.svg', '<svg/>');
  lab.svn(['import', '-q', '-m', 'init', src, `${lab.repoUrl}/trunk`]);

  const wc = lab.checkout('wc');
  // svn import 不保证套用 auto-props，显式设置 MIME 以覆盖各分类分支。
  lab.svn(['propset', '-q', 'svn:mime-type', 'application/octet-stream', 'trunk/bin.dat'], wc);
  lab.svn(['propset', '-q', 'svn:mime-type', 'text/plain', 'trunk/fake-text.bin'], wc);
  lab.svn(['propset', '-q', 'svn:mime-type', 'image/svg+xml', 'trunk/svg.svg'], wc);
  // 某些客户端/import 组合会对含 NUL 文件自动设置 octet-stream；删除以
  // 覆盖“无 mime 的 NUL 内容”分支（真实仓库里来自 propdel 或旧客户端）。
  lab.svn(['propdel', '-q', 'svn:mime-type', 'trunk/utf16.txt'], wc);
  lab.svn(['commit', '-q', '-m', 'props'], wc);
  const showItem = lab.svn(['info', '--show-item', 'revision', `${lab.repoUrl}/trunk`]).trim();
  const afterProps = Number(showItem);
  if (!Number.isFinite(afterProps)) {
    throw new Error(`无法读取属性提交 revision：${showItem}`);
  }
  return { trunkUrl: `${lab.repoUrl}/trunk`, revisions: { afterProps }, cleanup: () => lab.cleanup() };
}

describe('probeRemoteContent（真实 svn：mime + 前 8 KiB）', () => {
  it.runIf(hasSvn && hasSvnadmin)('MIME/NUL 分类矩阵、8 KiB 探测窗口与不存在路径', async () => {
    const lab = buildContentLab();
    try {
      const revision = lab.revisions.afterProps;
      const probe = (name: string) => probeRemoteContent('svn', `${lab.trunkUrl}/${name}`, { revision });

      const text = await probe('text.txt');
      expect(text.status).toBe('probed');
      if (text.status === 'probed') {
        expect(text.classification).toMatchObject({ kind: 'text', reason: 'none' });
        expect(text.headBytes).toBeGreaterThan(0);
        expect(text.headBytes).toBeLessThanOrEqual(8 * 1024);
      }

      // 20 KiB 文本：只读满 8 KiB 窗口即终止 cat。
      const big = await probe('big.txt');
      expect(big).toMatchObject({ status: 'probed', headBytes: 8 * 1024 });
      if (big.status === 'probed') {
        expect(big.classification.kind).toBe('text');
      }

      const empty = await probe('empty.txt');
      expect(empty).toMatchObject({ status: 'probed', headBytes: 0 });
      if (empty.status === 'probed') {
        expect(empty.classification.kind).toBe('text');
      }

      // 显式 octet-stream：MIME 已判二进制，不再 cat（headBytes=0）。
      const binaryMime = await probe('bin.dat');
      expect(binaryMime).toMatchObject({ status: 'probed', headBytes: 0 });
      if (binaryMime.status === 'probed') {
        expect(binaryMime.classification).toMatchObject({ kind: 'binary', reason: 'mime' });
      }

      // text/plain 但内容含 NUL：NUL 判据覆盖 text mime。
      const fakeText = await probe('fake-text.bin');
      expect(fakeText.status).toBe('probed');
      if (fakeText.status === 'probed') {
        expect(fakeText.classification).toMatchObject({ kind: 'binary', reason: 'nul' });
      }

      // UTF-16 文本（已 propdel mime）：字符间 NUL 判二进制（已知边界）。
      const utf16 = await probe('utf16.txt');
      expect(utf16.status).toBe('probed');
      if (utf16.status === 'probed') {
        expect(utf16.classification).toMatchObject({ kind: 'binary', reason: 'nul' });
      }

      // SVG 为 image/svg+xml：即使内容是纯文本也判二进制。
      const svg = await probe('svg.svg');
      expect(svg).toMatchObject({ status: 'probed', headBytes: 0 });
      if (svg.status === 'probed') {
        expect(svg.classification).toMatchObject({ kind: 'binary', reason: 'mime' });
      }

      const missing = await probeRemoteContent('svn', `${lab.trunkUrl}/nope.txt`, { revision });
      expect(missing.status).toBe('notFound');
    } finally {
      lab.cleanup();
    }
  });
});

describe('readRemoteText（真实 svn：编码回退与 16 MiB 兜底）', () => {
  it.runIf(hasSvn && hasSvnadmin)('UTF-8/GBK/空文件/大中文分块与不存在路径', async () => {
    const lab = buildContentLab();
    try {
      const revision = lab.revisions.afterProps;
      const read = (name: string, maxBytes?: number) => readRemoteText('svn', `${lab.trunkUrl}/${name}`, {
        revision,
        ...(maxBytes === undefined ? {} : { maxBytes }),
      });

      const text = await read('text.txt');
      expect(text).toMatchObject({
        status: 'text',
        text: 'hello 世界\n',
        bytes: Buffer.byteLength('hello 世界\n'),
        fellBack: false,
        lenient: false,
      });
      if (text.status === 'text') {
        expect(text.encoding.toLowerCase()).toBe('utf-8');
      }

      // GBK 字节不是合法 UTF-8：主编码失败后按回退链 gbk 解码。
      const gbk = await read('gbk.txt');
      expect(gbk).toEqual({
        status: 'text',
        text: '中文',
        bytes: GBK_ZHONGWEN.length,
        encoding: 'gbk',
        fellBack: true,
        lenient: false,
      });

      const empty = await read('empty.txt');
      expect(empty).toMatchObject({ status: 'text', text: '', bytes: 0 });

      // 300 KB 中文：跨任意 64 KiB 管道分块不产生替换符。
      const chinese = await read('chinese.txt');
      expect(chinese.status).toBe('text');
      if (chinese.status === 'text') {
        expect(chinese.text).toBe('中文'.repeat(50_000));
        expect(chinese.text).not.toContain('�');
      }

      // 内嵌上限：超过 maxBytes 立即终止并报告已读字节，不返回半截文本。
      const tooLarge = await read('text.txt', 4);
      expect(tooLarge.status).toBe('tooLarge');
      if (tooLarge.status === 'tooLarge') {
        expect(tooLarge.limitBytes).toBe(4);
        expect(tooLarge.bytesRead).toBeGreaterThan(4);
      }

      const missing = await read('nope.txt');
      expect(missing.status).toBe('notFound');
    } finally {
      lab.cleanup();
    }
  });
});

describe('downloadRemoteFile（真实 svn：runToFile 预检与降级）', () => {
  it.runIf(hasSvn && hasSvnadmin)('成功原子改名、无 .part、二进制字节一致', async () => {
    const lab = buildContentLab();
    const outDir = mkdtempSync(join(tmpdir(), 'svn-anywhere-content-out-'));
    try {
      const revision = lab.revisions.afterProps;

      const textTarget = join(outDir, 'text.txt');
      const text = await downloadRemoteFile('svn', `${lab.trunkUrl}/text.txt`, {
        revision,
        targetPath: textTarget,
        expectedBytes: Buffer.byteLength('hello 世界\n'),
      });
      expect(text.status).toBe('downloaded');
      if (text.status === 'downloaded') {
        expect(text.bytesWritten).toBe(Buffer.byteLength('hello 世界\n'));
        expect(text.filePath).toBe(textTarget);
      }
      expect(readFileSync(textTarget)).toEqual(Buffer.from('hello 世界\n', 'utf8'));
      // 成功路径只留下最终文件，没有 .part 残留。
      expect(readdirSync(outDir)).toEqual(['text.txt']);

      const binTarget = join(outDir, 'bin.dat');
      const bin = await downloadRemoteFile('svn', `${lab.trunkUrl}/bin.dat`, {
        revision,
        targetPath: binTarget,
      });
      expect(bin.status).toBe('downloaded');
      expect(readFileSync(binTarget)).toEqual(Buffer.from([0x00, 0x01, 0x02, 0x03]));
    } finally {
      lab.cleanup();
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('越限、磁盘余量与不存在路径的降级状态且不留半文件', async () => {
    const lab = buildContentLab();
    const outDir = mkdtempSync(join(tmpdir(), 'svn-anywhere-content-limit-'));
    try {
      const revision = lab.revisions.afterProps;
      const url = `${lab.trunkUrl}/text.txt`;

      // expectedBytes 已知且超过 maxBytes：启动前返回 tooLarge，不创建目标。
      const preTarget = join(outDir, 'pre.txt');
      const pre = await downloadRemoteFile('svn', url, {
        revision,
        targetPath: preTarget,
        expectedBytes: 100,
        maxBytes: 10,
      });
      expect(pre.status).toBe('tooLarge');
      if (pre.status === 'tooLarge') {
        expect(pre.limitBytes).toBe(10);
        expect(pre.expectedBytes).toBe(100);
      }
      expect(existsSync(preTarget)).toBe(false);

      // 大小未知、运行中超过 maxBytes：终止 cat、删除 .part、不留下半文件。
      const streamingTarget = join(outDir, 'streaming.txt');
      const streaming = await downloadRemoteFile('svn', url, {
        revision,
        targetPath: streamingTarget,
        maxBytes: 4,
      });
      expect(streaming.status).toBe('tooLarge');
      if (streaming.status === 'tooLarge') {
        expect(streaming.limitBytes).toBe(4);
      }
      expect(existsSync(streamingTarget)).toBe(false);
      expect(readdirSync(outDir)).toEqual([]);

      // 磁盘余量预检失败：不启动 cat，返回 insufficientDisk。
      const diskTarget = join(outDir, 'disk.txt');
      const disk = await downloadRemoteFile('svn', url, {
        revision,
        targetPath: diskTarget,
        headroomBytes: Number.MAX_SAFE_INTEGER,
      });
      expect(disk.status).toBe('insufficientDisk');
      expect(existsSync(diskTarget)).toBe(false);

      // 路径不存在：cat 的 W160013 + E200009 → notFound。
      const missingTarget = join(outDir, 'missing.txt');
      const missing = await downloadRemoteFile('svn', `${lab.trunkUrl}/nope.txt`, {
        revision,
        targetPath: missingTarget,
      });
      expect(missing.status).toBe('notFound');
      if (missing.status === 'notFound') {
        expect(missing.error.kind).toBe('notFound');
      }
      expect(existsSync(missingTarget)).toBe(false);
      expect(readdirSync(outDir)).toEqual([]);
    } finally {
      lab.cleanup();
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('GBK 文本下载后字节保持原样（runToFile 不做文本解码）', async () => {
    const lab = buildContentLab();
    const outDir = mkdtempSync(join(tmpdir(), 'svn-anywhere-content-gbk-'));
    try {
      const target = join(outDir, 'gbk.txt');
      const result = await downloadRemoteFile('svn', `${lab.trunkUrl}/gbk.txt`, {
        revision: lab.revisions.afterProps,
        targetPath: target,
        expectedBytes: GBK_ZHONGWEN.length,
      });
      expect(result.status).toBe('downloaded');
      expect(readFileSync(target)).toEqual(GBK_ZHONGWEN);
    } finally {
      lab.cleanup();
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 名称以 @ 结尾的节点（cat/probe 经字面尾 @ URL 读取）
// ---------------------------------------------------------------------------

describe('名称以 @ 结尾的节点（真实 svn file:// 内容读取）', () => {
  it.runIf(hasSvn && hasSvnadmin)('readRemoteText/probe 用 info 回包的字面尾 @ URL 读到自身内容', async () => {
    const lab = createSvnLab('svn-anywhere-content-tail-at-');
    try {
      const src = join(lab.root, 'src');
      writeFile(src, 'tail', 'brother\n');
      writeFile(src, 'tail@', 'self@\n');
      lab.svn(['import', '-q', '-m', 'init', src, `${lab.repoUrl}/trunk`]);

      // 入口 URL 走 %40 编码；info 回包的 <url> 原样还原字面尾 @。
      const info = await readRemoteNode('svn', `${lab.repoUrl}/trunk/tail%40`, { revision: 1 });
      expect(info.status).toBe('present');
      if (info.status !== 'present') {
        return;
      }
      const literalUrl = info.node.rawUrl;
      expect(literalUrl.endsWith('/tail@')).toBe(true);

      // 修复前 …/tail@1 被解析为路径 tail + peg 1，读到兄弟 tail 的内容。
      const text = await readRemoteText('svn', literalUrl, { revision: 1 });
      expect(text.status).toBe('text');
      if (text.status === 'text') {
        expect(text.text).toBe('self@\n');
      }

      const probe = await probeRemoteContent('svn', literalUrl, { revision: 1 });
      expect(probe.status).toBe('probed');
      if (probe.status === 'probed') {
        expect(probe.classification.kind).toBe('text');
        expect(probe.headBytes).toBe('self@\n'.length);
      }
    } finally {
      lab.cleanup();
    }
  });
});
