/**
 * 磁盘治理 core 的真实 svn 烟囱（svnadmin + file://，不碰远端服务器）：
 * - 检出副本 scanDiskUsage 端到端：业务/.svn/pristine 三值合理性
 *   （checkout 后 pristine 字节数 > 0、svn ⊇ pristine、business 精确
 *   等于本副本版本文件字节和）；
 * - externals 真实定义（svn propset）后排除生效：三种引号形态与嵌套
 *   引号形态分放不同定义点目录（同一目录多条定义落点同名会冲突），
 *   svn update 拉取后 external 落点子树不计量、定义点目录照常计量——
 *   落点由 svn 实际创建（夹具自检），断言我们的解析与 svn 一致；
 * - 嵌套副本（wc 内再 checkout）整棵排除；
 * - readPristineStats 真实 wc.db：检出后 refcount≥1；refcount=0 的
 *   构造方式以实测为准——`svn update --set-depth immediates` 缩浅目录
 *   后被移除文件的 pristine DB 行落 refcount=0 且磁盘文件保留（实测
 *   svn 1.15；删除文件 + svn status、svn delete + revert 均不产生
 *   refcount=0——revert 会恢复引用）；readOnly 打开失败收敛
 *   available:false。
 *
 * 实测 wc.db PRISTINE 表结构（svn 1.15）：checksum（`$sha1$<hex>`）、
 * compression（可空）、size（与 pristine 文件磁盘字节一致）、refcount、
 * md5_checksum；pristine 文件 = `.svn/pristine/<hex 前 2 位>/<hex>.svn-base`。
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPristineStats, scanDiskUsage } from '../src/core/diskUsage';
import { createSvnLab, type SvnLab } from './helpers';

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

let hasNodeSqlite = false;
try {
  // 与 readPristineStats 同款动态 import 探测：Node <22.5 抛
  // ERR_UNKNOWN_BUILTIN_MODULE，此处只做能力守卫（本机实测 Node 25 可用）。
  execSync('node -e "import(\'node:sqlite\').then(()=>0,()=>process.exit(1))"', { stdio: 'ignore' });
  hasNodeSqlite = true;
} catch {
  hasNodeSqlite = false;
}

const labs: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of labs.splice(0)) {
    cleanup();
  }
});

function makeLab(prefix: string): SvnLab {
  const lab = createSvnLab(prefix);
  labs.push(() => lab.cleanup());
  return lab;
}

/**
 * 仓库骨架：trunk（b.txt + lib1/libfile.txt，被检出为业务内容）与
 * l1/target（libfile.txt，externals 的拉取目标），返回内容字节数。
 */
function seedRepo(lab: SvnLab): { bTxt: number; libFile: number } {
  lab.svn(['mkdir', '-q', '--parents', '-m', 'r1', `${lab.repoUrl}/trunk/lib1`, `${lab.repoUrl}/l1/target`]);
  const seed = join(lab.root, 'seed');
  mkdirSync(seed);
  const bTxtContent = 'bbb';
  const libFileContent = 'lib content';
  writeFileSync(join(seed, 'b.txt'), bTxtContent, 'utf8');
  writeFileSync(join(seed, 'libfile.txt'), libFileContent, 'utf8');
  lab.svn(['import', '-q', '-m', 'r2', join(seed, 'b.txt'), `${lab.repoUrl}/trunk/b.txt`]);
  lab.svn(['import', '-q', '-m', 'r3', join(seed, 'libfile.txt'), `${lab.repoUrl}/trunk/lib1/libfile.txt`]);
  lab.svn(['import', '-q', '-m', 'r4', join(seed, 'libfile.txt'), `${lab.repoUrl}/l1/target/libfile.txt`]);
  return {
    bTxt: Buffer.byteLength(bTxtContent, 'utf8'),
    libFile: Buffer.byteLength(libFileContent, 'utf8'),
  };
}

/** 检出 trunk 为工作副本（在目录内用 `.` 检出，与 helpers 同款手法）。 */
function checkoutTrunk(lab: SvnLab): string {
  const wc = join(lab.root, 'wc');
  mkdirSync(wc);
  lab.svn(['checkout', '-q', `${lab.repoUrl}/trunk`, '.'], wc);
  return wc;
}

describe('scanDiskUsage 端到端（真实 svn）', () => {
  it('检出副本：业务/.svn/pristine 三值合理（checkout 后 pristine > 0）', async () => {
    if (!hasSvn || !hasSvnadmin) {
      return;
    }
    const lab = makeLab('svn-anywhere-disk-lab-e2e-');
    const bytes = seedRepo(lab);
    const wc = checkoutTrunk(lab);

    const result = await scanDiskUsage('svn', wc);

    expect(result.phase).toBe('complete');
    // 业务口径 = 本副本版本文件（b.txt + lib1/libfile.txt），目录条目
    // 不入合计（lib1 目录 inode 字节不计）。
    expect(result.totals.business).toBe(bytes.bTxt + bytes.libFile);
    // checkout 即写 pristine 缓存（每个文件一份，实测 size 与文件字节一致）。
    expect(result.totals.pristineBytes).toBeGreaterThanOrEqual(bytes.bTxt + bytes.libFile);
    // .svn 计量包含 pristine 与 wc.db 等（pristine 是其子集，不重复计入总量）。
    expect(result.totals.svn).toBeGreaterThan(result.totals.pristineBytes);
    expect(result.totals.total).toBe(result.totals.business + result.totals.svn);
    expect(result.files.map((f) => f.path).sort()).toEqual(['b.txt', 'lib1/libfile.txt']);
    // business 恒等于清单字节合计。
    expect(result.files.reduce((s, f) => s + f.bytes, 0)).toBe(result.totals.business);
    // 无 externals、无嵌套副本：范围说明为空。
    expect(result.excluded).toEqual([]);
  });

  it('externals 排除生效：三种引号形态 + 嵌套引号分放不同定义点；外部子树不计量、定义点目录照常计量', async () => {
    if (!hasSvn || !hasSvnadmin) {
      return;
    }
    const lab = makeLab('svn-anywhere-disk-lab-ext-');
    const bytes = seedRepo(lab);
    const wc = checkoutTrunk(lab);
    // 定义点目录先 svn add（未纳管目录 propset 报 E155010），各放一个
    // 已纳管文件验证「定义点目录本身照常计量」。
    const defPointBytes = Buffer.byteLength('keep', 'utf8');
    for (const dir of ['a1', 'a2', 'a3', 'a4']) {
      mkdirSync(join(wc, dir));
      writeFileSync(join(wc, dir, 'keep.txt'), 'keep', 'utf8');
      // add 目录默认递归：目录与 keep.txt 一并纳管。
      lab.svn(['add', '-q', dir], wc);
    }
    // 引号形态原值直接经 argv 传入（无 shell 转义损耗）：单引号包裹、
    // 双引号包裹、反斜杠转义、双引号包内部单引号（只剥成对首尾引号）。
    lab.svn(['propset', '-q', 'svn:externals', `^/l1/target 'my libs'`, 'a1'], wc);
    lab.svn(['propset', '-q', 'svn:externals', '^/l1/target "my libs"', 'a2'], wc);
    lab.svn(['propset', '-q', 'svn:externals', '^/l1/target my\\ libs', 'a3'], wc);
    lab.svn(['propset', '-q', 'svn:externals', `^/l1/target "my 'libs'"`, 'a4'], wc);
    lab.svn(['update', '-q'], wc);
    // 夹具自检：svn 实际创建的落点与解析规则一致（引号/反斜杠被 svn
    // 语法消去）——落点目录真实存在才证明「排除子树」对象存在。
    const fs = await import('node:fs');
    for (const landing of ['a1/my libs', 'a2/my libs', 'a3/my libs', "a4/my 'libs'"]) {
      expect(fs.statSync(join(wc, landing)).isDirectory()).toBe(true);
      expect(fs.existsSync(join(wc, landing, 'libfile.txt'))).toBe(true);
    }

    const result = await scanDiskUsage('svn', wc);

    expect(result.phase).toBe('complete');
    expect(result.excluded).toEqual([
      'a1/my libs',
      'a2/my libs',
      'a3/my libs',
      "a4/my 'libs'",
    ]);
    // external 内部文件（4 份 libfile.txt）不进业务口径；定义点目录里
    // 的已纳管文件照常计量。
    expect(result.totals.business).toBe(bytes.bTxt + bytes.libFile + 4 * defPointBytes);
    expect(result.files.map((f) => f.path).sort()).toEqual([
      'a1/keep.txt',
      'a2/keep.txt',
      'a3/keep.txt',
      'a4/keep.txt',
      'b.txt',
      'lib1/libfile.txt',
    ]);
  });

  it('嵌套副本（wc 内再 checkout）整棵排除并列明', async () => {
    if (!hasSvn || !hasSvnadmin) {
      return;
    }
    const lab = makeLab('svn-anywhere-disk-lab-nested-');
    const bytes = seedRepo(lab);
    const wc = checkoutTrunk(lab);
    // 嵌套副本根：wc/nested 内再检出同一仓库的 trunk（其内含 b.txt 与 .svn）。
    lab.svn(['checkout', '-q', `${lab.repoUrl}/trunk`, 'nested'], wc);

    const result = await scanDiskUsage('svn', wc);

    expect(result.phase).toBe('complete');
    expect(result.excluded).toEqual(['nested']);
    expect(result.totals.business).toBe(bytes.bTxt + bytes.libFile);
    expect(result.files.map((f) => f.path).sort()).toEqual(['b.txt', 'lib1/libfile.txt']);
  });
});

describe('readPristineStats（真实 wc.db）', () => {
  it.runIf(hasNodeSqlite)('检出后全部引用；set-depth 缩浅构造 refcount=0（实测有效方式）且磁盘文件保留', async () => {
    if (!hasSvn || !hasSvnadmin) {
      return;
    }
    const lab = makeLab('svn-anywhere-disk-lab-pristine-');
    const bytes = seedRepo(lab);
    const wc = checkoutTrunk(lab);

    const afterCheckout = await readPristineStats(wc);
    expect(afterCheckout.available).toBe(true);
    expect(afterCheckout.totalCount).toBeGreaterThanOrEqual(2);
    // 检出即引用：无未引用缓存行。
    expect(afterCheckout.cacheCount).toBe(0);
    expect(afterCheckout.unreferencedBytes).toBe(0);
    expect(afterCheckout.missingCount).toBe(0);

    // refcount=0 的构造实测：`svn update --set-depth immediates` 缩浅
    // 目录（lib1/libfile.txt 的 NODES 行移除、pristine DB 行落 refcount=0
    // 且磁盘文件保留到 cleanup 才回收——删除文件 + svn status、svn
    // delete + revert 均不产生 refcount=0，revert 会恢复引用）。
    lab.svn(['update', '-q', '--set-depth', 'immediates'], wc);

    const afterShallow = await readPristineStats(wc);
    expect(afterShallow.available).toBe(true);
    expect(afterShallow.cacheCount).toBeGreaterThanOrEqual(1);
    // 预计量按 DB 行 size（与文件实际字节一致），不扣除缺失——文件
    // 仍在 pristine store（missingCount=0），数值可精确对账。
    expect(afterShallow.unreferencedBytes).toBeGreaterThanOrEqual(bytes.libFile);
    expect(afterShallow.missingCount).toBe(0);

    // 扫描侧的 pristine 计量口径与 DB 行共存：缩浅后 pristine store 里
    // 的未引用文件仍占磁盘字节（scanDiskUsage 照常计入 pristineBytes，
    // 含未引用的 libfile 与仍引用的 b.txt 两份缓存）。
    const scan = await scanDiskUsage('svn', wc);
    expect(scan.totals.pristineBytes).toBeGreaterThanOrEqual(
      (afterShallow.unreferencedBytes ?? 0) + bytes.bTxt,
    );
  });

  it('readOnly 打开失败收敛 available:false（不存在的 wc.db）', async () => {
    if (!hasSvn || !hasSvnadmin) {
      return;
    }
    const lab = makeLab('svn-anywhere-disk-lab-pristine-miss-');
    // 目录存在但无 .svn/wc.db：readOnly 打开被拒（node:sqlite 实测不误建）。
    const stats = await readPristineStats(join(lab.root, 'no-wc'));
    expect(stats.available).toBe(false);
    expect(stats.reason).toContain('wc.db 打开失败');
  });

  it.runIf(!hasNodeSqlite)('宿主无 node:sqlite：收敛「不可用：宿主不支持」不冒充 0', async () => {
    const stats = await readPristineStats('/tmp');
    expect(stats.available).toBe(false);
    expect(stats.reason).toContain('宿主不支持');
  });
});
