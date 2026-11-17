#!/usr/bin/env node
// 远端文本/二进制分类探测矩阵
// 规则：repository 的 svn:mime-type 非 text/* → binary；否则前 8 KiB 含 NUL → binary；否则 text。
// mime 获取：svn propget svn:mime-type --non-interactive <url>（属性不存在时 exit 1 + W200017）。
// 方法：spawn svn cat，读满 8 KiB 后立即 kill，验证提前终止与部分流读取。
'use strict';
const { spawn, spawnSync } = require('child_process');

const url = process.argv[2];
if (!url) { console.error('usage: classify-probe.cjs <url>'); process.exit(2); }
const PROBE = 8192;

const prop = spawnSync('svn', ['propget', '--non-interactive', 'svn:mime-type', url], { encoding: 'utf8' });
const hasMime = prop.status === 0 && prop.stdout.trim() !== '';
const mime = hasMime ? prop.stdout.trim() : null;
const propMissing = /W200017|Property 'svn:mime-type' not found/.test(prop.stderr || '');
const propOtherError = !hasMime && !propMissing;

function readHead(cb) {
  const child = spawn('svn', ['cat', '--non-interactive', url], { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  let total = 0, stderr = '', done = false, killed = false;
  const finish = (why, code, signal) => {
    if (done) return; done = true;
    const buf = Buffer.concat(chunks);
    cb({ bytesRead: total, head: buf.subarray(0, PROBE), hasNulInProbe: buf.subarray(0, PROBE).includes(0), killed, why, exitCode: code, signal, stderr: stderr.trim() });
  };
  child.stdout.on('data', (b) => {
    if (done) return;
    chunks.push(b); total += b.length;
    if (total >= PROBE) { killed = true; child.kill('SIGTERM'); }
  });
  child.stderr.on('data', (b) => { stderr += b.toString(); });
  child.on('close', (code, signal) => finish('close', code, signal));
  child.on('error', (e) => { stderr += String(e); finish('error', null, null); });
}

readHead((head) => {
  const mimeBinary = hasMime && !/^text\//i.test(mime);
  const nulBinary = head.hasNulInProbe;
  const classification = mimeBinary || nulBinary ? 'binary' : 'text';
  console.log(JSON.stringify({
    url: url.replace(/^.*repo-main\//, ''),
    mime, mimeMissing: propMissing, propGetExit: prop.status, propOtherError,
    mimeBinary, probeBytes: Math.min(head.bytesRead, PROBE), catTotalReadStopAtKill: head.bytesRead,
    nulInFirst8KiB: nulBinary, killedAfterProbe: head.killed, catExitCode: head.exitCode, catSignal: head.signal,
    classification,
  }));
});
