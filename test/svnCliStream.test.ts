/**
 * svnCli 流式回调（onStdoutChunk）测试：
 * - 回调时机：进程运行中逐块触发（分段输出 + sleep 注入），非结束后一次性；
 * - 行缓冲跨块：一行输出被拆成多块时，字节层按 \n 分行的缓冲能拼出完整行；
 * - GBK 字节流：宽松 UTF-8 解码出现替换符（乱码可接受），但 ASCII 前缀
 *   匹配与条目计数不受影响（计数不依赖行内容解码；整段编码回退链仍可
 *   在进程结束后恢复准确名称）；
 * - 既有整段 onOutput 与逐块回调可同时使用且内容一致（整段行为不回归）；
 * - timeoutMs=0 表示不限时（超时器仅在 timeoutMs > 0 时设置）；
 * - 真实 svn 的 checkout/import 输出行形态（svnadmin + file:// 临时仓库，
 *   svn 1.15.0 实测）：检出条目行 `A    <绝对路径>`（A + 4 空格）、尾行
 *   `Checked out revision N.`；导入条目行 `Adding         <源绝对路径>`
 *   （Adding + 9 空格），另有 `Committing transaction...` 阶段行（非条目，
 *   不计数）、尾行 `Committed revision N.`；目录与文件同为条目行。
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Utf8StreamDecoder, run, runStream, runToFile, urlWithPeg } from '../src/core/svnCli';
import { decodeBuffer } from '../src/core/encoding';
import { OUTPUT_TOO_LARGE, INSUFFICIENT_DISK } from '../src/core/errors';
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

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * 字节层行缓冲：按 0x0A 分行（GBK 双字节的尾字节不会产生 0x0A，
 * UTF-8 多字节字符也不含 0x0A，按字节拆行不会截断多字节字符），
 * 跨块拼接完整行；进程结束后用 flush 取回无换行结尾的残留尾段。
 * 这类缓冲属于调用方职责：svnCli 的逐块回调只透传原始字节。
 */
class ByteLineBuffer {
  private pending: Buffer = Buffer.alloc(0);

  /** 喂入一块，返回由这块完成的完整行（不含换行符）。 */
  push(chunk: Buffer): Buffer[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const lines: Buffer[] = [];
    for (;;) {
      const idx = this.pending.indexOf(0x0a);
      if (idx < 0) {
        return lines;
      }
      lines.push(this.pending.subarray(0, idx));
      this.pending = this.pending.subarray(idx + 1);
    }
  }

  /** 取回不完整的尾段（进程结束后的残留），无残留返回 null。 */
  flush(): Buffer | null {
    if (this.pending.length === 0) {
      return null;
    }
    const rest = this.pending;
    this.pending = Buffer.alloc(0);
    return rest;
  }
}

/** 流式阶段的显示解码：UTF-8 宽松（非法字节替换为 U+FFFD），不做编码回退链。 */
function lenientUtf8(line: Buffer): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(line);
}

/** svn 1.15.0 实测条目前缀：检出 A + 4 空格，导入 Adding + 9 空格。 */
const CHECKOUT_ENTRY_PREFIX = 'A    ';
const IMPORT_ENTRY_PREFIX = 'Adding         ';

/**
 * 字节层前缀匹配：前缀为 ASCII 字节，直接比对原始字节即可，不依赖
 * 行内容解码（新版 Node 的 Buffer 已无字符串式 startsWith，用子序列比较）。
 */
function startsWithBytes(line: Buffer, prefix: string): boolean {
  const prefixBuf = Buffer.from(prefix, 'utf8');
  return line.subarray(0, prefixBuf.length).equals(prefixBuf);
}

describe('onStdoutChunk（包装脚本，不依赖 svn）', () => {
  it('进程运行中逐块触发：块在命令结束前到达，且回调时进程未结束', async () => {
    // 分三段输出，段间 sleep 0.4 秒：块到达时间差由脚本保证，可区分
    // 「运行中逐块」与「结束后一次性」。
    const script = "printf 'A    one.txt\\n'; sleep 0.4; printf 'A    two.txt\\n'; sleep 0.4; printf 'Checked out revision 5.\\n'";
    const chunks: Buffer[] = [];
    const chunkAt: number[] = [];
    const chunkAfterSettle: boolean[] = [];
    let settled = false;
    const promise = run('sh', ['-c', script], {
      onStdoutChunk: (chunk) => {
        chunks.push(chunk);
        chunkAt.push(Date.now());
        chunkAfterSettle.push(settled);
      },
    }).then((result) => {
      settled = true;
      return result;
    });
    const result = await promise;
    const finishedAt = Date.now();

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // 所有块都在 run 结束前回调（data 事件先于 close/resolve）。
    expect(chunkAfterSettle.every((after) => !after)).toBe(true);
    // 前两段的到达时间早于进程结束：第一段 ≥600ms、第二段 ≥300ms（段间 400ms，留余量）。
    expect(chunkAt[0]).toBeLessThanOrEqual(finishedAt - 600);
    expect(chunkAt[1]).toBeLessThanOrEqual(finishedAt - 300);
    // 块的拼接与整段结果一致。
    expect(Buffer.concat(chunks).toString('utf8')).toBe(result.stdout);
  });

  it('一行被拆成多块时，字节层行缓冲能拼出完整行', async () => {
    // 每段间隔 0.2 秒，块边界稳定：第一块是不完整行（无换行），
    // 第二块补完第一行并留下新的不完整行，第三块收尾。
    const script = "printf 'A    fi'; sleep 0.2; printf 'le.txt\\nAdding         ne'; sleep 0.2; printf 'xt.txt\\nCommitted revision 3.\\n'";
    const buffer = new ByteLineBuffer();
    const linesPerChunk: number[] = [];
    const chunks: Buffer[] = [];
    const lines: Buffer[] = [];
    await run('sh', ['-c', script], {
      onStdoutChunk: (chunk) => {
        chunks.push(chunk);
        const completed = buffer.push(chunk);
        lines.push(...completed);
        linesPerChunk.push(completed.length);
      },
    });
    const tail = buffer.flush();
    const allLines = [...lines, ...(tail ? [tail] : [])].map((line) => line.toString('utf8'));
    expect(allLines).toEqual(['A    file.txt', 'Adding         next.txt', 'Committed revision 3.']);
    // 存在跨块不完整行：至少一块到达时行缓冲没有产出任何完整行。
    expect(linesPerChunk.some((count) => count === 0)).toBe(true);
  });

  it('GBK 字节流：宽松解码乱码不影响前缀匹配与计数，整段回退链仍可恢复名称', async () => {
    // 「中文a」的 GBK 字节 D6 D0 CE C4 61、「新建b」的 GBK 字节 D0 C2 BD A8 62：
    // 双字节的尾字节均不含 0x0A，按字节分行不会误拆；宽松 UTF-8 解码会
    // 产生替换符（流式显示乱码可接受），但 ASCII 前缀完好。
    const gbkNameA = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x61, 0x2e, 0x74, 0x78, 0x74]);
    const gbkNameB = Buffer.from([0xd0, 0xc2, 0xbd, 0xa8, 0x62, 0x2e, 0x74, 0x78, 0x74]);
    const dir = makeTempDir('svn-anywhere-gbk-stream-');
    const fixture = join(dir, 'output.bin');
    try {
      writeFileSync(fixture, Buffer.concat([
        Buffer.from(CHECKOUT_ENTRY_PREFIX), gbkNameA, Buffer.from('\n'),
        Buffer.from(IMPORT_ENTRY_PREFIX), gbkNameB, Buffer.from('\n'),
        Buffer.from('Checked out revision 9.\n'),
      ]));
      const buffer = new ByteLineBuffer();
      const allChunks: Buffer[] = [];
      const lines: Buffer[] = [];
      await run('sh', ['-c', `cat ${JSON.stringify(fixture)}`], {
        onStdoutChunk: (chunk) => {
          allChunks.push(chunk);
          lines.push(...buffer.push(chunk));
        },
      });
      const tail = buffer.flush();

      // 按 \n 分行恰好 3 行：GBK 字节流没有被误拆。
      expect(lines.length).toBe(3);
      expect(tail).toBeNull();

      // 字节层前缀匹配：计数与识别不依赖行内容解码。
      const checkoutEntries = lines.filter((line) => startsWithBytes(line, CHECKOUT_ENTRY_PREFIX));
      const importEntries = lines.filter((line) => startsWithBytes(line, IMPORT_ENTRY_PREFIX));
      expect(checkoutEntries.length).toBe(1);
      expect(importEntries.length).toBe(1);
      // 宽松解码文本层的前缀匹配与字节层等价（前缀是 ASCII）。
      const lenientLines = lines.map(lenientUtf8);
      expect(lenientLines.filter((text) => text.startsWith(CHECKOUT_ENTRY_PREFIX)).length).toBe(1);
      expect(lenientLines.filter((text) => text.startsWith(IMPORT_ENTRY_PREFIX)).length).toBe(1);
      expect(lenientLines[2]).toBe('Checked out revision 9.');
      // 宽松解码对 GBK 名称产生替换符（乱码可接受），前缀不受影响。
      expect(lenientLines[0]).toContain('\uFFFD');
      expect(lenientLines[0].startsWith(CHECKOUT_ENTRY_PREFIX)).toBe(true);

      // 对照：整段字节经编码回退链（主编码 UTF-8 严格失败 → gbk）可恢复准确名称。
      const decoded = decodeBuffer(Buffer.concat(allChunks));
      expect(decoded.fellBack).toBe(true);
      expect(decoded.text).toContain('中文a.txt');
      expect(decoded.text).toContain('新建b.txt');
    } finally {
      cleanupDir(dir);
    }
  });

  it('逐块回调与整段 onOutput 可同时使用且内容一致（整段行为不回归）', async () => {
    const script = "printf 'A    目录/文件.txt\\n'; sleep 0.2; printf 'Checked out revision 2.\\n'";
    const chunks: Buffer[] = [];
    let fullOutput = '';
    const result = await run('sh', ['-c', script], {
      onStdoutChunk: (chunk) => {
        chunks.push(chunk);
      },
      onOutput: (text, source) => {
        if (source === 'stdout') {
          fullOutput = text;
        }
      },
    });
    const joined = Buffer.concat(chunks).toString('utf8');
    expect(fullOutput).toBe(result.stdout);
    expect(joined).toBe(result.stdout);
    expect(result.stdout).toContain('目录/文件.txt');
    expect(result.stdout).toContain('Checked out revision 2.');
  });

  it('timeoutMs=0 时长任务正常运行（0 表示不限时，超时器仅在 >0 时设置）', async () => {
    const script = "printf 'A    a.txt\\n'; sleep 1; printf 'Checked out revision 1.\\n'; sleep 0.2";
    const chunks: Buffer[] = [];
    const startedAt = Date.now();
    const result = await run('sh', ['-c', script], {
      timeoutMs: 0,
      onStdoutChunk: (chunk) => {
        chunks.push(chunk);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // 进程持续运行超过 1.2 秒仍未被杀：0 不会被当作「立即超时」或短超时。
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1200);
  });
});

describe('onStdoutChunk（真实 svn 行形态，svnadmin + file://）', () => {
  it.runIf(hasSvn && hasSvnadmin)('svn import：Adding 条目行（含目录）、Committing transaction 阶段行与 Committed 尾行', async () => {
    const lab = createSvnLab('svn-anywhere-stream-import-');
    try {
      const src = join(lab.root, 'src');
      writeFile(src, 'a.txt', 'a\n');
      writeFile(src, 'c.md', 'c\n');
      writeFile(src, 'sub/b.txt', 'b\n');
      // 源含 2 文件 + 1 子目录（内 1 文件）：导入条目 = 3 文件 + 1 目录 = 4 行。
      const buffer = new ByteLineBuffer();
      const lines: Buffer[] = [];
      const result = await run('svn', ['import', '-m', 'init', src, `${lab.repoUrl}/trunk`], {
        onStdoutChunk: (chunk) => {
          lines.push(...buffer.push(chunk));
        },
      });
      expect(result.exitCode).toBe(0);
      const textLines = lines.map((line) => line.toString('utf8'));
      const adding = textLines.filter((text) => text.startsWith(IMPORT_ENTRY_PREFIX));
      expect(adding.length).toBe(4);
      // 条目行携带源绝对路径（目录与文件同为条目行）。
      for (const text of adding) {
        expect(text).toContain(src);
      }
      // 阶段行不是条目（不匹配条目前缀），尾行固定形态。
      expect(textLines).toContain('Committing transaction...');
      expect(textLines[textLines.length - 1]).toBe('Committed revision 1.');
      expect(buffer.flush()).toBeNull();
    } finally {
      lab.cleanup();
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('svn checkout：A 条目行（A + 4 空格）与 Checked out 尾行', async () => {
    const lab = createSvnLab('svn-anywhere-stream-co-');
    try {
      const src = join(lab.root, 'src');
      writeFile(src, 'a.txt', 'a\n');
      writeFile(src, 'sub/b.txt', 'b\n');
      const imported = await run('svn', ['import', '-m', 'init', src, `${lab.repoUrl}/trunk`]);
      expect(imported.exitCode).toBe(0);

      const target = join(lab.root, 'wc');
      const buffer = new ByteLineBuffer();
      const lines: Buffer[] = [];
      const result = await run('svn', ['checkout', `${lab.repoUrl}/trunk`, target], {
        onStdoutChunk: (chunk) => {
          lines.push(...buffer.push(chunk));
        },
      });
      expect(result.exitCode).toBe(0);
      const textLines = lines.map((line) => line.toString('utf8'));
      const entries = textLines.filter((text) => text.startsWith(CHECKOUT_ENTRY_PREFIX));
      // 2 文件 + 1 子目录 = 3 条目；条目行携带检出目标下的绝对路径。
      expect(entries.length).toBe(3);
      for (const text of entries) {
        expect(text).toContain(target);
      }
      expect(textLines[textLines.length - 1]).toBe('Checked out revision 1.');
      expect(buffer.flush()).toBeNull();
    } finally {
      lab.cleanup();
    }
  });
});

describe('runStream（不累计 stdout 的流式原语）', () => {
  it('stdout 逐块回调且不累计整段：结果 stdout 恒为空串，回调拼接与真实输出一致', async () => {
    const chunks: Buffer[] = [];
    const result = await runStream('sh', ['-c', "printf 'aaa'; sleep 0.2; printf 'bbb'"], {
      onStdoutChunk: (chunk) => {
        chunks.push(chunk);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(Buffer.concat(chunks).toString('utf8')).toBe('aaabbb');
    // 至少两块（分段输出 + sleep 确保块在运行中到达）。
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('回调在进程结束前逐块触发（非结束后一次性）', async () => {
    const chunkAt: number[] = [];
    let settled = false;
    const finished = runStream('sh', ['-c', "printf 'one'; sleep 0.3; printf 'two'"], {
      onStdoutChunk: () => {
        chunkAt.push(settled ? -1 : Date.now());
      },
    }).then((result) => {
      settled = true;
      return result;
    });
    await finished;
    expect(chunkAt.length).toBeGreaterThanOrEqual(2);
    // 所有回调都在结算前触发（未命中 -1）。
    expect(chunkAt.every((at) => at > 0)).toBe(true);
  });

  it('回调抛错即终止子进程并以该错误 reject（预算超限/写盘失败等主动中止入口）', async () => {
    const boom = new Error('budget exceeded');
    const startedAt = Date.now();
    await expect(
      runStream('sh', ['-c', "printf 'x'; sleep 5"], {
        onStdoutChunk: () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
    // SIGTERM 组杀通常立即生效；极端时序下（进程组未就绪命中 SIGKILL
    // 兜底）耗时为 3 秒宽限期。上界只排除「等待命令自然结束」的 5 秒。
    expect(Date.now() - startedAt).toBeLessThan(4500);
  });

  it('超时与取消语义与 run 一致', async () => {
    await expect(
      runStream('sleep', ['5'], { timeoutMs: 200, onStdoutChunk: () => {} }),
    ).rejects.toMatchObject({ name: 'SvnError', code: 'TIMEOUT' });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await expect(
      runStream('sleep', ['5'], { signal: controller.signal, onStdoutChunk: () => {} }),
    ).rejects.toMatchObject({ name: 'SvnError', code: 'CANCELLED' });
  });

  it('Utf8StreamDecoder 跨分块解码中文：分块边界落在多字节字符中间也不产生 U+FFFD', async () => {
    // 「中」UTF-8 为 E4 B8 AD：第一块只发首字节，100ms 后补齐剩余两字节，
    // 用真实管道复现「逐块 toString 产生替换符」的场景。
    const script = `${JSON.stringify(process.execPath)} -e "process.stdout.write(Buffer.from([0xe4]));setTimeout(()=>process.stdout.write(Buffer.from([0xb8,0xad])),100)"`;
    const decoder = new Utf8StreamDecoder();
    let decoded = '';
    const naiveChunks: string[] = [];
    await runStream('sh', ['-c', script], {
      onStdoutChunk: (chunk) => {
        decoded += decoder.write(chunk);
        naiveChunks.push(chunk.toString('utf8'));
      },
    });
    decoded += decoder.end();
    expect(decoded).toBe('中');
    // 对照：逐块 toString 拼接会把边界上的多字节字符解码成替换符。
    expect(naiveChunks.join('')).toContain('�');
  });

  it.runIf(hasSvn && hasSvnadmin)('真实 svn list --xml 流式喂入 SAX 解析入口（跨 chunk 解码）', async () => {
    const lab = createSvnLab('svn-anywhere-runstream-list-');
    try {
      const src = join(lab.root, 'src');
      writeFile(src, '中文 文件.txt', 'x\n');
      writeFile(src, 'at@name.txt', 'y\n');
      const imported = await run('svn', ['import', '-m', 'init', src, `${lab.repoUrl}/trunk`]);
      expect(imported.exitCode).toBe(0);

      // 整段对照（run 保持既有整段文本行为）。
      const full = await run('svn', [
        'list', '--xml', '--non-interactive', '--depth', 'immediates', '-r', 'HEAD',
        '--', urlWithPeg(`${lab.repoUrl}/trunk`),
      ]);
      expect(full.exitCode).toBe(0);
      expect(full.stdout).toContain('<lists>');

      // 流式：同命令经 runStream 逐块解码，拼接结果必须与整段完全一致。
      const decoder = new Utf8StreamDecoder();
      let streamed = '';
      const streamResult = await runStream('svn', [
        'list', '--xml', '--non-interactive', '--depth', 'immediates', '-r', 'HEAD',
        '--', urlWithPeg(`${lab.repoUrl}/trunk`),
      ], {
        onStdoutChunk: (chunk) => {
          streamed += decoder.write(chunk);
        },
      });
      streamed += decoder.end();
      expect(streamResult.stdout).toBe('');
      expect(streamResult.exitCode).toBe(0);
      expect(streamed).toBe(full.stdout);
      // 中文与含 @ 的名称在 XML 中原样（UTF-8）出现，且无替换符。
      expect(streamed).toContain('中文 文件.txt');
      expect(streamed).not.toContain('�');
    } finally {
      lab.cleanup();
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('退出码非零仍作为业务结果返回（供 assertSuccess 分流）', async () => {
    const lab = createSvnLab('svn-anywhere-runstream-missing-');
    try {
      const decoder = new Utf8StreamDecoder();
      let streamed = '';
      const result = await runStream('svn', [
        'list', '--xml', '--non-interactive', '--depth', 'immediates', '-r', 'HEAD',
        '--', urlWithPeg(`${lab.repoUrl}/no-such-path`),
      ], {
        onStdoutChunk: (chunk) => {
          streamed += decoder.write(chunk);
        },
      });
      streamed += decoder.end();
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('E200009');
    } finally {
      lab.cleanup();
    }
  });
});

describe('runToFile（直接写目标临时文件的流式原语）', () => {
  it('成功：.part 原子改名为目标文件，字节计数准确，无残留', async () => {
    const dir = makeTempDir('svn-anywhere-runtofile-ok-');
    try {
      const target = join(dir, 'out.bin');
      const progress: number[] = [];
      const result = await runToFile('sh', ['-c', "printf 'hello world'"], {
        targetPath: target,
        onProgress: (bytes) => progress.push(bytes),
      });
      expect(result.exitCode).toBe(0);
      expect(result.filePath).toBe(target);
      expect(result.stdout).toBe('');
      expect(result.bytesWritten).toBe(11);
      expect(readFileSync(target, 'utf8')).toBe('hello world');
      expect(readdirSync(dir)).toEqual(['out.bin']);
      expect(progress[progress.length - 1]).toBe(11);
    } finally {
      cleanupDir(dir);
    }
  });

  it('超过 maxBytes：OUTPUT_TOO_LARGE，进程终止且目标/半文件都不存在', async () => {
    const dir = makeTempDir('svn-anywhere-runtofile-limit-');
    try {
      const target = join(dir, 'out.bin');
      await expect(
        runToFile('sh', ['-c', "printf '0123456789'; sleep 5"], {
          targetPath: target,
          maxBytes: 5,
        }),
      ).rejects.toMatchObject({ name: 'SvnError', code: OUTPUT_TOO_LARGE });
      expect(existsSync(target)).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      cleanupDir(dir);
    }
  });

  it('expectedBytes 超过 maxBytes：不启动 svn（OUTPUT_TOO_LARGE）', async () => {
    const dir = makeTempDir('svn-anywhere-runtofile-budget-');
    try {
      const target = join(dir, 'out.bin');
      const marker = join(dir, 'marker');
      await expect(
        runToFile('sh', ['-c', `touch ${JSON.stringify(marker)}`], {
          targetPath: target,
          expectedBytes: 10,
          maxBytes: 5,
        }),
      ).rejects.toMatchObject({ name: 'SvnError', code: OUTPUT_TOO_LARGE });
      // 预检失败不启动命令：命令副作用不存在。
      expect(existsSync(marker)).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      cleanupDir(dir);
    }
  });

  it('磁盘余量预检失败：INSUFFICIENT_DISK，不启动 svn', async () => {
    const dir = makeTempDir('svn-anywhere-runtofile-disk-');
    try {
      const target = join(dir, 'out.bin');
      const marker = join(dir, 'marker');
      // 预期 1 PiB + 64 MiB 余量必然超过任何测试机可用空间；预算上限放宽
      // 到 2 PiB，使该用例只命中磁盘预检分支而不是字节上限分支。
      await expect(
        runToFile('sh', ['-c', `touch ${JSON.stringify(marker)}`], {
          targetPath: target,
          expectedBytes: 1024 ** 5,
          maxBytes: 2 * 1024 ** 5,
        }),
      ).rejects.toMatchObject({ name: 'SvnError', code: INSUFFICIENT_DISK });
      expect(existsSync(marker)).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      cleanupDir(dir);
    }
  });

  it('退出码非零：删除半文件并以业务结果返回（.part 不残留）', async () => {
    const dir = makeTempDir('svn-anywhere-runtofile-exit-');
    try {
      const target = join(dir, 'out.bin');
      const result = await runToFile('sh', ['-c', "printf 'partial'; exit 3"], {
        targetPath: target,
      });
      expect(result.exitCode).toBe(3);
      expect(result.filePath).toBeUndefined();
      expect(result.bytesWritten).toBe(7);
      expect(existsSync(target)).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      cleanupDir(dir);
    }
  });

  it('超时与取消：沿用 TIMEOUT/CANCELLED 错误码并删除半文件', async () => {
    const dir = makeTempDir('svn-anywhere-runtofile-cancel-');
    try {
      const target = join(dir, 'out.bin');
      await expect(
        runToFile('sleep', ['5'], { targetPath: target, timeoutMs: 200 }),
      ).rejects.toMatchObject({ name: 'SvnError', code: 'TIMEOUT' });
      expect(readdirSync(dir)).toEqual([]);

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      await expect(
        runToFile('sleep', ['5'], { targetPath: target, signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'SvnError', code: 'CANCELLED' });
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      cleanupDir(dir);
    }
  });

  it('目标目录不存在：抛 SvnError（FILE_CREATE_ERROR/ENOENT），不误报成功', async () => {
    const dir = makeTempDir('svn-anywhere-runtofile-nodir-');
    try {
      const target = join(dir, 'no-such-subdir', 'out.bin');
      await expect(
        runToFile('sh', ['-c', "printf 'x'"], { targetPath: target }),
      ).rejects.toMatchObject({ name: 'SvnError' });
    } finally {
      cleanupDir(dir);
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('真实 svn cat：仓库原始字节写入临时文件并与源内容一致', async () => {
    const lab = createSvnLab('svn-anywhere-runtofile-cat-');
    try {
      const src = join(lab.root, 'src');
      const content = 'line1\n中文内容\nline3\n';
      writeFile(src, '文档 目录/文件.txt', content);
      const imported = await run('svn', ['import', '-m', 'init', src, `${lab.repoUrl}/trunk`]);
      expect(imported.exitCode).toBe(0);

      const dir = makeTempDir('svn-anywhere-runtofile-cat-out-');
      try {
        const target = join(dir, 'cat.bin');
        const result = await runToFile('svn', [
          'cat', '-r', 'HEAD', '--non-interactive',
          '--', urlWithPeg(`${lab.repoUrl}/trunk/文档 目录/文件.txt`),
        ], { targetPath: target });
        expect(result.exitCode).toBe(0);
        expect(result.filePath).toBe(target);
        expect(result.bytesWritten).toBe(Buffer.byteLength(content, 'utf8'));
        expect(readFileSync(target, 'utf8')).toBe(content);
      } finally {
        cleanupDir(dir);
      }
    } finally {
      lab.cleanup();
    }
  });
});
