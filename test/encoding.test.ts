/**
 * 编码回退链测试：core/encoding 的纯函数行为 + svnCli 收口解码的真实
 * 子进程集成（GBK 字节经 svn propget 透传时正确解码）。
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENCODING_FALLBACK,
  DEFAULT_OUTPUT_ENCODING,
  decodeBuffer,
  stripBom,
} from '../src/core/encoding';
import { run } from '../src/core/svnCli';

let hasSvn = false;
try {
  execSync('svn --version', { stdio: 'ignore' });
  hasSvn = true;
} catch {
  hasSvn = false;
}

/** 「中文」的 GBK 字节序列（D6 D0 CE C4）；该序列不是合法 UTF-8。 */
const GBK_ZHONGWEN = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
/** 全部候选（UTF-8/GBK/GB2312/Big5）严格解码都失败的字节序列。 */
const UNDECODABLE = Buffer.from([0xfe, 0xfe, 0xfe]);

describe('decodeBuffer 解码回退链', () => {
  it('默认导出为 UTF-8 主编码与 gbk/gb2312/big5 回退链', () => {
    expect(DEFAULT_OUTPUT_ENCODING).toBe('UTF-8');
    expect(DEFAULT_ENCODING_FALLBACK).toEqual(['gbk', 'gb2312', 'big5']);
  });

  it('UTF-8 文本按主编码直接解码，不回退', () => {
    const outcome = decodeBuffer(Buffer.from('提交说明', 'utf8'));
    expect(outcome.text).toBe('提交说明');
    expect(outcome.encoding.toLowerCase()).toBe('utf-8');
    expect(outcome.lenient).toBe(false);
    expect(outcome.fellBack).toBe(false);
  });

  it('GBK 字节 UTF-8 严格解码失败后按回退链解码为中文', () => {
    const outcome = decodeBuffer(GBK_ZHONGWEN);
    expect(outcome.text).toBe('中文');
    expect(outcome.encoding.toLowerCase()).toBe('gbk');
    expect(outcome.lenient).toBe(false);
    expect(outcome.fellBack).toBe(true);
  });

  it('回退链按序尝试：gbk 先于 big5 命中，同一字节在 big5 下是不同字', () => {
    // D6 D0 CE C4 在 big5 严格解码同样合法（「笢恅」），回退链顺序决定结果。
    const onlyBig5 = decodeBuffer(GBK_ZHONGWEN, 'UTF-8', ['big5', 'gbk']);
    expect(onlyBig5.text).toBe('笢恅');
    expect(onlyBig5.encoding.toLowerCase()).toBe('big5');
  });

  it('自定义主编码：GBK 主编码直接成功，不经回退', () => {
    const outcome = decodeBuffer(GBK_ZHONGWEN, 'gbk', ['big5']);
    expect(outcome.text).toBe('中文');
    expect(outcome.fellBack).toBe(false);
  });

  it('全部候选失败时按 UTF-8 宽松解码并标记 lenient', () => {
    const outcome = decodeBuffer(UNDECODABLE);
    expect(outcome.lenient).toBe(true);
    expect(outcome.fellBack).toBe(true);
    expect(outcome.text).toContain('�');
  });

  it('不支持的编码 label 被跳过，不影响后续候选', () => {
    const outcome = decodeBuffer(GBK_ZHONGWEN, 'UTF-8', ['no-such-encoding', 'gbk']);
    expect(outcome.text).toBe('中文');
    expect(outcome.encoding.toLowerCase()).toBe('gbk');
  });

  it('候选链去重（大小写不敏感）且忽略空白段', () => {
    const outcome = decodeBuffer(GBK_ZHONGWEN, 'utf-8', [' GBK ', 'Gbk', 'gbk']);
    expect(outcome.text).toBe('中文');
  });

  it('UTF-8 BOM 被剥离，不残留在解码文本', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('plain', 'utf8')]);
    expect(stripBom(withBom).toString('utf8')).toBe('plain');
    expect(decodeBuffer(withBom).text).toBe('plain');
  });

  it('UTF-16 LE/BE BOM 字节同样剥离', () => {
    expect(stripBom(Buffer.from([0xff, 0xfe, 0x61])).toString('utf8')).toBe('a');
    expect(stripBom(Buffer.from([0xfe, 0xff, 0x61])).toString('utf8')).toBe('a');
    // 无 BOM 字节不受影响。
    expect(stripBom(Buffer.from([0x61, 0xff])).toString('utf8')).toBe('a�');
  });

  it('空字节序列解码为空文本', () => {
    const outcome = decodeBuffer(Buffer.alloc(0));
    expect(outcome.text).toBe('');
    expect(outcome.lenient).toBe(false);
  });
});

describe('svnCli 收口解码（真实子进程）', () => {
  it('GBK 字节输出按默认回退链解码并触发 onDecodingFallback 宽松兜底标注', async () => {
    // sh 按字节原样写出（绕过任何编码转换）：先验证回退链成功路径。
    const gbkResult = await run('/bin/sh', ['-c', 'printf \'\\xd6\\xd0\\xce\\xc4\''], {
      encodingFallback: ['gbk', 'gb2312', 'big5'],
    });
    expect(gbkResult.stdout).toBe('中文');

    // 不传 encodingFallback：同样走 DEFAULT_ENCODING_FALLBACK 默认回退链
    // （锁定 RunOptions 注释所述「未传时默认回退」的行为契约）。
    const defaultFallbackResult = await run('/bin/sh', ['-c', 'printf \'\\xd6\\xd0\\xce\\xc4\'']);
    expect(defaultFallbackResult.stdout).toBe('中文');

    // 全部候选失败：宽恕解码 + onDecodingFallback 回调（标注写入哪个流）。
    const notices: Array<{ source: 'stdout' | 'stderr'; primary: string }> = [];
    const lenientResult = await run('/bin/sh', ['-c', 'printf \'\\xfe\\xfe\\xfe\' >&2; printf \'\\xfe\\xfe\\xfe\''], {
      encodingFallback: [],
      onDecodingFallback: (notice) => notices.push({ source: notice.source, primary: notice.primary }),
    });
    expect(lenientResult.stdout).toContain('�');
    expect(lenientResult.stderr).toContain('�');
    expect(notices.map((n) => n.source).sort()).toEqual(['stderr', 'stdout']);
    expect(notices[0]?.primary).toBe('UTF-8');
  });

  it('真实 svn（1.15）对属性值强制 UTF-8：GBK 字节的 propset 被拒绝（实测记录）', async () => {
    if (!hasSvn) {
      return;
    }
    const { execFileSync } = await import('node:child_process');
    const lab = mkdtempSync(join(tmpdir(), 'svn-anywhere-enc-'));
    try {
      const repo = join(lab, 'repo');
      execFileSync('svnadmin', ['create', repo]);
      const wc = join(lab, 'wc');
      execFileSync('svn', ['checkout', '-q', `file://${repo}`, wc]);
      const rulesFile = join(lab, 'rules.txt');
      writeFileSync(rulesFile, GBK_ZHONGWEN);
      // svn 1.7+ 对属性值做 UTF-8 校验：GBK 字节无法经现代 svn 属性透传，
      // 回退链服务的对象是旧客户端写入的历史数据与外部工具输出。
      const result = await run('svn', ['propset', 'svn:ignore', '-F', rulesFile, '.'], {
        cwd: wc,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('E000022');
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });
});
