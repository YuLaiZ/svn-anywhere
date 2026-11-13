// M4 阶段 0 / V4 扫描性能实测：status + 32 路径批量 info + 4 路逐项补偿。
// 自建 svnadmin + file:// 临时仓库，不访问远端服务器。
// 用法：node test/fixtures/m4-stage0/v4-scan-bench.mjs [冲突文件数=120] [--keep]
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const fileCount = Number(args.find((a) => /^\d+$/.test(a)) ?? 120);
const root = mkdtempSync(join(tmpdir(), 'm4-v4-bench-'));
const env = { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
const cleanup = () => {
  if (keep) console.log(`kept: ${root}`);
  else rmSync(root, { recursive: true, force: true });
};

function svnSync(argv, cwd) {
  return execFileSync('svn', argv, { cwd, env, encoding: 'utf8' });
}
async function svn(argv, cwd) {
  const t0 = process.hrtime.bigint();
  const r = await execFileP('svn', argv, { cwd, env, maxBuffer: 64 * 1024 * 1024 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, stdout: r.stdout, stderr: r.stderr };
}

let maxDrift = 0;
let maxGap = 0;
let last = process.hrtime.bigint();
let samples = 0;
const timer = setInterval(() => {
  const now = process.hrtime.bigint();
  const gap = Number(now - last) / 1e6;
  last = now;
  if (gap - 10 > maxDrift) maxDrift = gap - 10;
  if (gap > maxGap) maxGap = gap;
  samples++;
}, 10);
function resetMonitor() {
  maxDrift = 0; maxGap = 0; samples = 0; last = process.hrtime.bigint();
}

const out = {
  machine: {
    platform: platform(),
    release: release(),
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    totalMemGiB: +(totalmem() / 1024 ** 3).toFixed(1),
  },
  fileCount,
  phases: {},
};

try {
  console.log(`== 构建 ${fileCount} 文件冲突仓库（${root}）==`);
  const repo = join(root, 'repo');
  execFileSync('svnadmin', ['create', repo]);
  svnSync(['checkout', '-q', `file://${repo}`, join(root, 'wc0')], root);
  const wc0 = join(root, 'wc0');
  for (let i = 1; i <= fileCount; i++) {
    const n = String(i).padStart(3, '0');
    writeFileSync(join(wc0, `f${n}.txt`), `file ${n} base line1\nline2\nline3\n`);
  }
  svnSync(['add', '-q', '--force', '.'], wc0);
  svnSync(['commit', '-q', '-m', 'bench base'], wc0);
  svnSync(['checkout', '-q', `file://${repo}`, join(root, 'wc1')], root);
  svnSync(['checkout', '-q', `file://${repo}`, join(root, 'wc2')], root);
  for (let i = 1; i <= fileCount; i++) {
    const n = String(i).padStart(3, '0');
    writeFileSync(join(root, 'wc1', `f${n}.txt`), `file ${n} theirs line1\nline2\nline3\n`);
  }
  svnSync(['commit', '-q', '-m', 'bench theirs'], join(root, 'wc1'));
  for (let i = 1; i <= fileCount; i++) {
    const n = String(i).padStart(3, '0');
    writeFileSync(join(root, 'wc2', `f${n}.txt`), `file ${n} local line1\nline2\nline3\n`);
  }
  const upd = await svn(['update', '--non-interactive'], join(root, 'wc2'));
  out.updateSummary = upd.stdout.trim().split('\n').slice(-3).join(' | ');
  if (!upd.stdout.includes(`Text conflicts: ${fileCount}`)) {
    throw new Error(`预期 ${fileCount} 个文本冲突，实际输出：${out.updateSummary}`);
  }

  const wc = join(root, 'wc2');
  const statusRuns = [];
  let statusXml = '';
  for (let i = 0; i < 3; i++) {
    const r = await svn(['status', '--xml', '--ignore-externals', '--non-interactive'], wc);
    statusRuns.push({ ms: +r.ms.toFixed(1), bytes: Buffer.byteLength(r.stdout) });
    statusXml = r.stdout;
  }
  out.phases.status = { runs: statusRuns, entries: (statusXml.match(/<entry\b/g) || []).length };

  const conflictPaths = [];
  for (const raw of statusXml.split(/<entry\b/).slice(1)) {
    const p = (raw.match(/path="([^"]+)"/) || [])[1];
    const wcStatus = (raw.match(/<wc-status\b[^>]*>/) || [''])[0];
    if (!p) continue;
    if (/item="conflicted"/.test(wcStatus) || /props="conflicted"/.test(wcStatus) || /tree-conflicted="true"/.test(wcStatus)) {
      conflictPaths.push(p);
    }
  }
  out.conflictPaths = conflictPaths.length;

  resetMonitor();
  const batches = [];
  let batchTotalMs = 0;
  let infoBytes = 0;
  for (let i = 0; i < conflictPaths.length; i += 32) {
    const chunk = conflictPaths.slice(i, i + 32);
    const r = await svn(['info', '--xml', '--non-interactive', '--', ...chunk], wc);
    batches.push({ count: chunk.length, ms: +r.ms.toFixed(1), bytes: Buffer.byteLength(r.stdout) });
    batchTotalMs += r.ms;
    infoBytes += Buffer.byteLength(r.stdout);
  }
  out.phases.batchInfo = {
    batches,
    totalMs: +batchTotalMs.toFixed(1),
    totalBytes: infoBytes,
    maxEventLoopDriftMs: +maxDrift.toFixed(1),
    maxEventLoopGapMs: +maxGap.toFixed(1),
    samples,
  };

  resetMonitor();
  const perItemTimes = [];
  let idx = 0;
  const CONCURRENCY = 4;
  async function worker() {
    while (idx < conflictPaths.length) {
      const p = conflictPaths[idx++];
      const r = await svn(['info', '--xml', '--non-interactive', '--', p], wc);
      perItemTimes.push(r.ms);
    }
  }
  const t0 = process.hrtime.bigint();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const perItemTotalMs = Number(process.hrtime.bigint() - t0) / 1e6;
  perItemTimes.sort((a, b) => a - b);
  out.phases.perItem4Way = {
    count: perItemTimes.length,
    totalMs: +perItemTotalMs.toFixed(1),
    minMs: +perItemTimes[0].toFixed(1),
    medianMs: +perItemTimes[Math.floor(perItemTimes.length / 2)].toFixed(1),
    maxMs: +perItemTimes[perItemTimes.length - 1].toFixed(1),
    maxEventLoopDriftMs: +maxDrift.toFixed(1),
    maxEventLoopGapMs: +maxGap.toFixed(1),
    samples,
  };

  resetMonitor();
  await new Promise((r) => setTimeout(r, 500));
  out.phases.idleBaseline = {
    maxEventLoopDriftMs: +maxDrift.toFixed(1),
    maxEventLoopGapMs: +maxGap.toFixed(1),
    samples,
  };

  console.log(JSON.stringify(out, null, 2));
} finally {
  clearInterval(timer);
  cleanup();
}
