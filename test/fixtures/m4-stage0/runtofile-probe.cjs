#!/usr/bin/env node
// svn cat 真 stdout 管道到临时文件的峰值内存与降级路径探针
// 场景:
//   pipe      正确的 runToFile 模型：spawn svn cat → stdout 直接 pipe 到 .part 文件，按字节计数，成功后 rename
//   accumulate 错误对照：把 stdout 累积到 Buffer[] 再拼接写文件（证明会随文件大小爆内存）
//   limit     把上限设为 --limit 字节，对超限文件立即终止子进程、删除 .part（OUTPUT_TOO_LARGE）
//   diskfree  fs.statfs 磁盘余量检查（需要 size + 64 MiB）
// 用法: node --expose-gc runtofile-probe.cjs <url> <pipe|accumulate|limit|diskfree> [--limit N] [--out DIR]
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const url = process.argv[2];
const mode = process.argv[3];
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
if (!url || !mode) { console.error('usage: runtofile-probe.cjs <url> <pipe|accumulate|limit|diskfree> [--limit N] [--out DIR]'); process.exit(2); }
const outDir = arg('--out', '/tmp/svn-anywhere-fixture-lab/tmpout');
const hardLimit = Number(arg('--limit', String(2 * 1024 * 1024 * 1024)));
fs.mkdirSync(outDir, { recursive: true });
const target = path.join(outDir, `probe-${Date.now()}-${Math.random().toString(36).slice(2)}.part`);
const t0 = Date.now();
const ru0 = process.resourceUsage();
const result = { mode, url: url.replace(/^.*repo-main\//, ''), limit: hardLimit };

function done(extra, err) {
  const m = process.memoryUsage();
  Object.assign(result, {
    elapsedMs: Date.now() - t0,
    exitCode: err ? 1 : 0, error: err ? String(err && err.message || err) : undefined,
    nodeMaxRssKiB: process.resourceUsage().maxRSS,
    rssDeltaKiB: process.resourceUsage().maxRSS - ru0.maxRSS,
    rssEndKiB: Math.round(m.rss / 1024),
    partExistsAfter: fs.existsSync(target),
    ...extra,
  });
  console.log(JSON.stringify(result));
  process.exit(err ? 1 : 0);
}

if (mode === 'diskfree') {
  const size = Number(arg('--size', '0'));
  fs.statfs(outDir, (e, st) => {
    if (e) return done({}, e);
    const free = st.bavail * st.bsize;
    const needed = size + 64 * 1024 * 1024;
    done({ statfsAvailable: true, freeBytes: free, freeGiB: +(free / 1024 / 1024 / 1024).toFixed(2), neededBytes: needed, allowed: free >= needed });
  });
} else if (mode === 'pipe' || mode === 'limit') {
  const ws = fs.createWriteStream(target);
  const child = spawn('svn', ['cat', '--non-interactive', url], { stdio: ['ignore', 'pipe', 'pipe'] });
  let bytes = 0, stderr = '', wsFinished = false, killedForLimit = false;
  child.stdout.on('data', (b) => {
    bytes += b.length;
    if (mode === 'limit' && bytes > hardLimit) {
      killedForLimit = true;
      child.kill('SIGTERM');
      ws.destroy();
      fs.rm(target, { force: true }, () => {});
      return;
    }
    ws.write(b);
  });
  child.stderr.on('data', (b) => { stderr += b.toString(); });
  child.on('close', (code, signal) => {
    if (killedForLimit) {
      return done({ bytes, killedForLimit, childExitCode: code, childSignal: signal, errorCode: 'OUTPUT_TOO_LARGE' });
    }
    ws.end(() => {
      if (code !== 0) { fs.rmSync(target, { force: true }); return done({ bytes, childExitCode: code, childSignal: signal, stderr: stderr.trim() }, new Error(`svn cat exit ${code}`)); }
      fs.renameSync(target, target.replace(/\.part$/, '.bin'));
      done({ bytes, childExitCode: code, childSignal: signal, finalPath: target.replace(/\.part$/, '.bin') });
    });
  });
} else if (mode === 'accumulate') {
  const child = spawn('svn', ['cat', '--non-interactive', url], { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  let stderr = '';
  child.stdout.on('data', (b) => chunks.push(b));
  child.stderr.on('data', (b) => { stderr += b.toString(); });
  child.on('close', (code) => {
    const buf = Buffer.concat(chunks);
    fs.writeFileSync(target.replace(/\.part$/, '.bin'), buf);
    done({ bytes: buf.length, chunks: chunks.length, childExitCode: code, stderr: stderr.trim() });
  });
}
