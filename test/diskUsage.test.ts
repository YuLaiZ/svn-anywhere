/**
 * 磁盘治理 core 的 mock 单测（构造目录树 + mock svnCli.run）：
 * - 计量口径：目录条目不入合计（大量空目录夹具）、.svn 排除但单独
 *   计量、pristine 前缀单列（含 `.svn/tmp/pristine` 同名目录不算）、
 *   symlink 不跟随计自身大小、business 恒等于清单字节合计；
 * - externals 解析矩阵（§6.1）：三种引号形态、嵌套引号只剥成对首尾、
 *   带引号 URL 词、缺省 URL 末段、`./libs` 的 path.join 落点、多行
 *   属性值、`-r N` 前缀、`--xml` 绝对路径相对 wcRoot 归一（含 wcRoot
 *   为符号链接的 realpath 归一）、propget 命令级失败转 partial、解析
 *   失败行保守排除；
 * - 嵌套副本排除（浅层与深层）；
 * - 取消 partial；
 * - buildVacuumArgs 安全断言（参数恒等于固定清单）；
 * - readPristineStats 的不可用收敛形态（readOnly 打开失败、无 PRISTINE
 *   表）；真实 wc.db 链路由 diskUsageLab.test.ts 承担。
 */
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, lstatSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/svnCli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/svnCli')>();
  return { ...actual, run: vi.fn() };
});

import { run } from '../src/core/svnCli';
import { buildVacuumArgs, readPristineStats, scanDiskUsage } from '../src/core/diskUsage';

const tempDirs: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of tempDirs.splice(0)) {
    cleanup();
  }
});

function makeWcRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 写文件（自动建父目录），返回内容字节数。 */
function put(root: string, relative: string, content: string): number {
  const path = join(root, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return Buffer.byteLength(content, 'utf8');
}

function makeSymlink(root: string, relative: string, target: string): number {
  const path = join(root, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  symlinkSync(target, path);
  return lstatSync(path).size;
}

function okPropgetXml(targets: Array<{ path: string; value: string }>): string {
  const body = targets
    .map((t) => `  <target path="${t.path}">\n    <property name="svn:externals">${t.value}</property>\n  </target>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<properties>\n${body}\n</properties>\n`;
}

function mockPropget(stdout: string): void {
  vi.mocked(run).mockResolvedValue({ stdout, stderr: '', exitCode: 0 });
}

function mockPropgetEmpty(): void {
  // 实测 svn 1.15 无 svn:externals 属性时 propget --xml 输出空
  // <properties> 容器（stdout 为空文本的形态也一并兼容）。
  mockPropget('<?xml version="1.0" encoding="UTF-8"?>\n<properties>\n</properties>\n');
}

beforeEach(() => {
  vi.mocked(run).mockReset();
  mockPropgetEmpty();
});

// ---------------------------------------------------------------------------
// 计量口径
// ---------------------------------------------------------------------------

describe('scanDiskUsage 计量口径', () => {
  it('目录条目不入合计（大量空目录）；business=清单求和；.svn 排除单独计量；total=business+svn', async () => {
    const wc = makeWcRoot('svn-anywhere-disk-plain-');
    const a = put(wc, 'a.txt', '0123456789');
    const b = put(wc, 'sub/b.bin', 'x'.repeat(100));
    // 大量空目录：目录 inode 的几十字节不得混进字节合计。
    for (let i = 0; i < 60; i++) {
      mkdirSync(join(wc, 'sub', `empty${i}`), { recursive: true });
    }
    const wcdb = put(wc, '.svn/wc.db', 'd'.repeat(500));
    const pristine = put(wc, '.svn/pristine/ab/abcd.svn-base', 'p'.repeat(200));
    const tmp = put(wc, '.svn/tmp/x', 't'.repeat(50));

    const result = await scanDiskUsage('svn', wc);

    expect(run).toHaveBeenCalledWith(
      'svn',
      ['propget', 'svn:externals', '-R', '--xml', '--non-interactive', '--', wc],
      expect.objectContaining({ cwd: wc }),
    );
    expect(result.phase).toBe('complete');
    expect(result.totals.business).toBe(a + b);
    expect(result.totals.svn).toBe(wcdb + pristine + tmp);
    expect(result.totals.pristineBytes).toBe(pristine);
    expect(result.totals.total).toBe(a + b + wcdb + pristine + tmp);
    // business 恒等于全量清单字节合计（跨页口径）。
    expect(result.files.map((f) => f.bytes).reduce((s, n) => s + n, 0)).toBe(result.totals.business);
    expect(result.files.map((f) => f.path).sort()).toEqual(['a.txt', 'sub/b.bin']);
    expect(result.files.every((f) => f.kind === 'file')).toBe(true);
    expect(result.scanCount).toBeGreaterThan(0);
  });

  it('符号链接不跟随、计入业务清单并按自身大小计量', async () => {
    const wc = makeWcRoot('svn-anywhere-disk-link-');
    const a = put(wc, 'a.txt', 'hello');
    const linkSize = makeSymlink(wc, 'sub/link', '../a.txt');

    const result = await scanDiskUsage('svn', wc);

    const link = result.files.find((f) => f.path === 'sub/link');
    expect(link).toMatchObject({ kind: 'symlink', bytes: linkSize });
    expect(result.totals.business).toBe(a + linkSize);
    // 链接目标内容不重复计入（不跟随）。
    expect(result.files.filter((f) => f.kind === 'file').map((f) => f.path)).toEqual(['a.txt']);
  });

  it('pristine 前缀只在 .svn 顶层命中（.svn/tmp/pristine 同名目录不算 pristine）', async () => {
    const wc = makeWcRoot('svn-anywhere-disk-prefix-');
    const pristine = put(wc, '.svn/pristine/ab/x.svn-base', 'p'.repeat(200));
    const fake = put(wc, '.svn/tmp/pristine/y.svn-base', 'q'.repeat(30));

    const result = await scanDiskUsage('svn', wc);

    expect(result.totals.pristineBytes).toBe(pristine);
    expect(result.totals.svn).toBe(pristine + fake);
    expect(result.totals.business).toBe(0);
  });

  it('嵌套副本（浅层）：目录直接子项出现 .svn 即整棵排除并列明', async () => {
    const wc = makeWcRoot('svn-anywhere-disk-nested-');
    const outer = put(wc, 'own.txt', 'o'.repeat(7));
    put(wc, 'nested/.svn/wc.db', 'x');
    const inner = put(wc, 'nested/inner.txt', 'i'.repeat(9));

    const result = await scanDiskUsage('svn', wc);

    expect(result.phase).toBe('complete');
    expect(result.totals.business).toBe(outer);
    expect(inner).toBe(9); // 夹具自检：嵌套内容真实存在
    expect(result.excluded).toContain('nested');
    expect(result.files.map((f) => f.path)).toEqual(['own.txt']);
  });

  it('嵌套副本（深层）：wc/outer/inner/.svn 只排除 inner，outer 照常计量', async () => {
    const wc = makeWcRoot('svn-anywhere-disk-deep-');
    const o = put(wc, 'outer/o.txt', 'o'.repeat(3));
    put(wc, 'outer/inner/.svn/wc.db', 'x');
    put(wc, 'outer/inner/f.txt', 'f'.repeat(11));

    const result = await scanDiskUsage('svn', wc);

    expect(result.totals.business).toBe(o);
    expect(result.excluded).toContain('outer/inner');
    expect(result.files.map((f) => f.path)).toEqual(['outer/o.txt']);
  });
});

// ---------------------------------------------------------------------------
// externals 解析矩阵
// ---------------------------------------------------------------------------

describe('scanDiskUsage externals 解析（propget --xml）', () => {
  it("三种引号形态 'my libs' / \"my libs\" / my\\ libs 的落点都是 my libs；落点子树排除、定义点目录照常计量", async () => {
    const wc = makeWcRoot('svn-anywhere-disk-ext-');
    const own = put(wc, 'own.txt', 'o'.repeat(5));
    const defPoint = put(wc, 'd1/defpoint-file.txt', 'd'.repeat(4));
    // 三个定义点分放不同目录（同一目录内多条定义落点同名会冲突——夹具纪律）。
    mockPropget(
      okPropgetXml([
        { path: wc, value: "^/l1 'my libs'\n" },
        { path: join(wc, 'd1'), value: '^/l1 "my libs"\n' },
        { path: join(wc, 'd2'), value: '^/l1 my\\ libs\n' },
      ]),
    );
    // 各落点子树内的文件：不进业务口径。
    const ext1 = put(wc, 'my libs/ext-file.txt', 'e'.repeat(21));
    const ext2 = put(wc, 'd1/my libs/ext-file.txt', 'e'.repeat(22));
    const ext3 = put(wc, 'd2/my libs/ext-file.txt', 'e'.repeat(23));

    const result = await scanDiskUsage('svn', wc);

    expect(result.phase).toBe('complete');
    expect(result.totals.business).toBe(own + defPoint);
    expect(ext1 + ext2 + ext3).toBeGreaterThan(0); // 夹具自检：外部子树真实存在
    expect(result.excluded).toEqual(expect.arrayContaining(['my libs', 'd1/my libs', 'd2/my libs']));
    expect(result.files.map((f) => f.path).sort()).toEqual(['d1/defpoint-file.txt', 'own.txt']);
  });

  it('嵌套引号形态只剥成对首尾引号：^/l1 "my \'libs\'" 落点为 my \'libs\'（内部引号保留）', async () => {
    const wc = makeWcRoot('svn-anywhere-disk-ext-nest-');
    mockPropget(okPropgetXml([{ path: wc, value: `^/l1 "my 'libs'"\n` }]));
    const ext = put(wc, "my 'libs'/ext.txt", 'e'.repeat(8));
    const own = put(wc, 'own.txt', 'o'.repeat(2));

    const result = await scanDiskUsage('svn', wc);

    expect(result.excluded).toEqual(["my 'libs'"]);
    expect(result.totals.business).toBe(own);
    expect(ext).toBe(8); // 夹具自检
  });

  it('URL 词可带成对引号："^/l1" "my libs" 落点仍由本地子路径决定', async () => {
    const wc = makeWcRoot('svn-anywhere-disk-ext-qurl-');
    mockPropget(okPropgetXml([{ path: wc, value: '"^/l1" "my libs"\n' }]));
    put(wc, 'my libs/ext.txt', 'e'.repeat(10));
    const own = put(wc, 'own.txt', 'o');

    const result = await scanDiskUsage('svn', wc);

    expect(result.excluded).toEqual(['my libs']);
    expect(result.totals.business).toBe(own);
  });

  it('缺省本地子路径时落点 = URL 末段（防御分支：svn 1.15 propset 对裸 URL 一律 E195005）', async () => {
    const wc = makeWcRoot('svn-anywhere-disk-ext-bare-');
    mockPropget(okPropgetXml([{ path: wc, value: '^/l1/target\n' }]));
    put(wc, 'target/ext.txt', 'e'.repeat(6));
    const own = put(wc, 'own.txt', 'oo');

    const result = await scanDiskUsage('svn', wc);

    expect(result.excluded).toEqual(['target']);
    expect(result.totals.business).toBe(own);
  });

  it('URL 的 @PEGREV 后缀不参与末段取词', async () => {
    const wc = makeWcRoot('svn-anywhere-disk-ext-peg-');
    mockPropget(okPropgetXml([{ path: wc, value: '^/l1/target@5\n' }]));
    put(wc, 'target/ext.txt', 'e'.repeat(6));
    const own = put(wc, 'own.txt', 'oo');

    const result = await scanDiskUsage('svn', wc);

    expect(result.excluded).toEqual(['target']);
    expect(result.totals.business).toBe(own);
  });

  it('本地子路径 ./ 前缀合法：path.join 消解 ./ 段，落点是 sub/libs 而非 sub/./libs', async () => {
    const wc = makeWcRoot('svn-anywhere-disk-ext-dot-');
    mockPropget(okPropgetXml([{ path: join(wc, 'sub'), value: '^/l1 ./libs\n' }]));
    put(wc, 'sub/libs/ext.txt', 'e'.repeat(12));
    const own = put(wc, 'sub/own.txt', 'o'.repeat(3));

    const result = await scanDiskUsage('svn', wc);

    expect(result.excluded).toEqual(['sub/libs']);
    expect(result.totals.business).toBe(own);
  });

  it('多行属性值在同一 property 文本节点内：每行一个定义、逐行解析', async () => {
    const wc = makeWcRoot('svn-anywhere-disk-ext-multi-');
    mockPropget(okPropgetXml([{ path: wc, value: '^/l1/liba dirA\n^/l1/libb dirB\n' }]));
    put(wc, 'dirA/x.txt', 'a');
    put(wc, 'dirB/y.txt', 'b');
    const own = put(wc, 'own.txt', 'c');

    const result = await scanDiskUsage('svn', wc);

    expect(result.excluded).toEqual(expect.arrayContaining(['dirA', 'dirB']));
    expect(result.totals.business).toBe(own);
  });

  it('行首 -r N 前缀只参与取词、不参与落点计算', async () => {
    const wc = makeWcRoot('svn-anywhere-disk-ext-rev-');
    mockPropget(okPropgetXml([{ path: wc, value: '-r 5 ^/l1/target lib\n' }]));
    put(wc, 'lib/ext.txt', 'e'.repeat(4));
    const own = put(wc, 'own.txt', 'o'.repeat(2));

    const result = await scanDiskUsage('svn', wc);

    expect(result.excluded).toEqual(['lib']);
    expect(result.totals.business).toBe(own);
  });

  it('--xml 的 target path 是绝对路径：相对 wcRoot 归一后参与落点计算；wcRoot 为符号链接时按 realpath 归一', async () => {
    // 真实目录 + 指向它的符号链接作为 wcRoot：svn 返回的 target path 是
    // realpath 形态（实测 /tmp 与 /private/tmp 的关系），归一须跨 symlink。
    const real = makeWcRoot('svn-anywhere-disk-ext-real-');
    const link = join(tmpdir(), `svn-anywhere-disk-ext-link-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    symlinkSync(real, link);
    tempDirs.push(() => rmSync(link, { force: true }));
    mockPropget(okPropgetXml([{ path: join(real, 'sub'), value: '^/l1 lib\n' }]));
    put(real, 'sub/lib/ext.txt', 'e'.repeat(9));
    const own = put(real, 'sub/own.txt', 'o'.repeat(6));

    const result = await scanDiskUsage('svn', link);

    expect(result.excluded).toEqual(['sub/lib']);
    expect(result.totals.business).toBe(own);
  });

  it('propget 命令级失败（exit 非零）→ 全部 externals 不可用、转 partial 并记范围说明', async () => {
    const wc = makeWcRoot('svn-anywhere-disk-ext-fail-');
    vi.mocked(run).mockResolvedValue({ stdout: '', stderr: 'svn: E155004: ...', exitCode: 1 });
    const own = put(wc, 'ext-looks-like/x.txt', 'e'.repeat(15));
    put(wc, 'more.txt', 'm'.repeat(1));

    const result = await scanDiskUsage('svn', wc);

    expect(result.phase).toBe('partial');
    expect(result.partialReason).toContain('externals 定义读取失败，外部子树可能被计入业务口径');
    // 外部子树无从排除：照常计入业务口径（宁可多计不误删，数值标注）。
    expect(result.totals.business).toBe(own + 1);
  });

  it('解析失败的行保守处理：定义点子树整棵排除并在范围说明标注（不转 partial）', async () => {
    const wc = makeWcRoot('svn-anywhere-disk-ext-unparsable-');
    // 引号未闭合：非法形态（真实属性 propset 不进去；防御历史脏数据）。
    mockPropget(okPropgetXml([{ path: join(wc, 'sub'), value: '^/l1 "unclosed\n' }]));
    const subOwn = put(wc, 'sub/own.txt', 's'.repeat(4));
    const rootOwn = put(wc, 'own.txt', 'r'.repeat(3));
    put(wc, 'sub/maybe-external.txt', 'm'.repeat(5));

    const result = await scanDiskUsage('svn', wc);

    expect(result.phase).toBe('complete');
    expect(result.excluded).toEqual(['sub（存在无法解析的 externals 定义，已保守排除）']);
    // 保守排除 = 定义点子树整棵不出业务口径（宁可少统计）。
    expect(result.totals.business).toBe(rootOwn);
    expect(subOwn).toBe(4); // 夹具自检：定义点内文件真实存在
  });

  it('未加引号未转义的空格子路径（三词形态）按解析失败保守处理', async () => {
    const wc = makeWcRoot('svn-anywhere-disk-ext-space-');
    mockPropget(okPropgetXml([{ path: wc, value: '^/l1 my libs\n' }]));
    const own = put(wc, 'own.txt', 'o'.repeat(2));
    put(wc, 'my libs/x.txt', 'x');

    const result = await scanDiskUsage('svn', wc);

    expect(result.phase).toBe('complete');
    expect(result.excluded).toEqual(['.（存在无法解析的 externals 定义，已保守排除）']);
    expect(result.totals.business).toBe(0);
    expect(own).toBe(2); // 夹具自检：定义点（根）整棵保守排除后 own 不计量
  });
});

// ---------------------------------------------------------------------------
// 取消与 partial
// ---------------------------------------------------------------------------

describe('scanDiskUsage 取消', () => {
  it('调用前已取消：直接返回已扫部分（空）+ partial 标记', async () => {
    const wc = makeWcRoot('svn-anywhere-disk-cancel-');
    put(wc, 'a.txt', 'a'.repeat(10));

    const controller = new AbortController();
    controller.abort();
    const result = await scanDiskUsage('svn', wc, { signal: controller.signal });

    expect(result.phase).toBe('partial');
    expect(result.partialReason).toContain('扫描已取消');
    expect(result.files).toEqual([]);
    expect(result.totals).toEqual({ business: 0, svn: 0, pristineBytes: 0, total: 0 });
  });

  it('externals 读取期间取消：propget 返回后遍历不再开始，partial 收口', async () => {
    const wc = makeWcRoot('svn-anywhere-disk-cancel2-');
    put(wc, 'a.txt', 'a'.repeat(10));
    const controller = new AbortController();
    // svnCli.run 被取消时抛 code=CANCELLED 的 SvnError；这里直接模拟该
    // 传播形态（run 的取消实现由 svnCli.test.ts 覆盖）。
    vi.mocked(run).mockImplementation(async () => {
      controller.abort();
      const { SvnError: SE } = await import('../src/core/errors');
      throw new SE({ message: 'svn propget 已被取消', command: [], code: 'CANCELLED' });
    });

    const result = await scanDiskUsage('svn', wc, { signal: controller.signal });

    expect(result.phase).toBe('partial');
    expect(result.partialReason).toContain('扫描已取消');
    expect(result.files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 进度回调
// ---------------------------------------------------------------------------

describe('scanDiskUsage 进度回调', () => {
  it('按让路节奏触发（每 64 条目）：scanCount 单调递增、currentPath 为相对路径、不超出最终计数', async () => {
    const wc = makeWcRoot('svn-anywhere-disk-progress-');
    put(wc, 'a.txt', 'a'.repeat(10));
    // 业务条目超过 YIELD_EVERY（64）：至少触发一次主循环进度。
    for (let i = 0; i < 70; i++) {
      put(wc, `f${i}.txt`, 'x');
    }
    // .svn 内条目也计入 scanCount 并按同节奏报进度（路径带 .svn/ 前缀）。
    for (let i = 0; i < 70; i++) {
      put(wc, `.svn/pristine/ab/f${i}.svn-base`, 'p');
    }

    const seen: Array<{ scanCount: number; currentPath: string }> = [];
    const result = await scanDiskUsage('svn', wc, {
      onProgress: (p) => seen.push({ ...p }),
    });

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((p) => p.scanCount > 0)).toBe(true);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].scanCount).toBeGreaterThan(seen[i - 1].scanCount);
    }
    // 触发点对齐让路节奏（每 64 条目一次），间隔恰为 64 的步进。
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].scanCount - seen[i - 1].scanCount).toBe(64);
    }
    // 末次进度不超过最终 scanCount（partial/取消下回调不超出已读部分）。
    expect(seen.at(-1)?.scanCount).toBeLessThanOrEqual(result.scanCount);
    expect(result.scanCount).toBeGreaterThanOrEqual(140);
    // currentPath 是相对 wcRoot 的形态（业务段无前缀、.svn 段带前缀）。
    expect(seen.some((p) => !p.currentPath.startsWith('/'))).toBe(true);
  });

  it('条目不足 64：不触发回调（结果仍完整），不传 onProgress 行为不变', async () => {
    const wc = makeWcRoot('svn-anywhere-disk-progress2-');
    put(wc, 'a.txt', 'a'.repeat(10));
    put(wc, '.svn/wc.db', 'd'.repeat(8));

    let calls = 0;
    const result = await scanDiskUsage('svn', wc, { onProgress: () => { calls += 1; } });
    expect(calls).toBe(0);
    expect(result.phase).toBe('complete');
    expect(result.totals.business).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// buildVacuumArgs 安全断言
// ---------------------------------------------------------------------------

describe('buildVacuumArgs', () => {
  it('参数恒等于 cleanup --non-interactive --vacuum-pristines <目标>，无其他选项', () => {
    expect(buildVacuumArgs('/work/wc')).toEqual([
      'cleanup',
      '--non-interactive',
      '--vacuum-pristines',
      '/work/wc',
    ]);
  });

  it('目标是解析型路径：含 @ 时补尾 @（escapePeg 同款转义）', () => {
    expect(buildVacuumArgs('/work/wc@1')).toEqual([
      'cleanup',
      '--non-interactive',
      '--vacuum-pristines',
      '/work/wc@1@',
    ]);
  });
});

// ---------------------------------------------------------------------------
// readPristineStats 不可用收敛形态（真实 wc.db 链路在 lab）
// ---------------------------------------------------------------------------

let hasNodeSqlite = false;
try {
  execSync('node -e "import(\'node:sqlite\').then(()=>0,()=>process.exit(1))"', { stdio: 'ignore' });
  hasNodeSqlite = true;
} catch {
  hasNodeSqlite = false;
}

describe('readPristineStats 收敛形态', () => {
  it('wc.db 不存在：readOnly 打开失败收敛 available:false（不误建文件）', async () => {
    const wc = makeWcRoot('svn-anywhere-disk-pristine-miss-');
    mkdirSync(join(wc, '.svn'), { recursive: true });

    const stats = await readPristineStats(wc);

    expect(stats.available).toBe(false);
    expect(stats.reason).toContain('wc.db 打开失败');
    expect(stats.cacheCount).toBeUndefined();
  });

  it.runIf(hasNodeSqlite)('真实 sqlite 文件但无 PRISTINE 表：不支持的格式收敛 available:false', async () => {
    const wc = makeWcRoot('svn-anywhere-disk-pristine-nopristine-');
    mkdirSync(join(wc, '.svn'), { recursive: true });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(wc, '.svn', 'wc.db'));
    db.exec('CREATE TABLE OTHER (x INTEGER)');
    db.close();

    const stats = await readPristineStats(wc);

    expect(stats.available).toBe(false);
    expect(stats.reason).toContain('PRISTINE');
  });
});
