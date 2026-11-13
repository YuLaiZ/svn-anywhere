#!/usr/bin/env node
/**
 * M4 阶段 0 / V3：svn list --xml / diff --xml --summarize 的流式 SAX 解析与预算实测。
 * 依赖 saxes（在任意目录 `npm install saxes` 后以本目录为 cwd，或 NODE_PATH 指向已装目录）。
 * 用法：
 *   node stream-parse.js <doc:list|summarize> <mode:stream|buffer> <url> <rev> <maxEntries> <maxBytes> [oldUrl]
 * 输出一行 JSON：status(ok|tooLarge-entries|tooLarge-bytes|error)、entries、bytes、
 * elapsedMs、ttfbMs、firstEntryMs、base/peak/deltaRssMiB、itemCounts、firstPathSamples。
 * summarize 模式需给出 oldUrl（旧根，用于演示 path 以旧根为基准）。
 */
'use strict';
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { SaxesParser } = require('saxes');

const [doc, mode, url, rev, maxEntriesS, maxBytesS, oldUrl] = process.argv.slice(2);
const maxEntries = Number(maxEntriesS);
const maxBytes = Number(maxBytesS);
const svnEnv = { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };

const args = doc === 'list'
  ? ['list', '--xml', '--non-interactive', '--depth', 'infinity', '-r', rev, '--', url]
  : ['diff', '--xml', '--summarize', '--non-interactive', '--old', oldUrl ?? url, '--new', url];

const baseRss = process.memoryUsage().rss;
let peakRss = baseRss;
const sampler = setInterval(() => {
  const rss = process.memoryUsage().rss;
  if (rss > peakRss) peakRss = rss;
}, 10);

const started = process.hrtime.bigint();
let ttfbNs = null;
let bytes = 0;
let entries = 0;
let status = 'ok';
let errorText = '';
const itemCounts = Object.create(null);
const relSamples = [];
let firstEntryMs = null;

const child = spawn('svn', args, { env: svnEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let childClosed = false;
let stderrBuf = '';
child.stderr.on('data', (d) => { stderrBuf += d.toString('utf8'); });

const abortWith = (s) => {
  if (status === 'ok') {
    status = s;
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }
};

// ---------- 解析器（stream / buffer 共用） ----------
const parser = new SaxesParser({ xmlns: false });
let curEntry = null;
let curPath = null;
let textEl = null;
let textBuf = '';
const textElements = new Set(['name', 'size', 'author', 'date']);
parser.on('opentag', (tag) => {
  if (tag.name === 'entry') {
    curEntry = { kind: tag.attributes.kind };
  } else if (tag.name === 'path') {
    curPath = { item: tag.attributes.item, props: tag.attributes.props, kind: tag.attributes.kind };
    textBuf = '';
    textEl = 'path';
  } else if (textElements.has(tag.name)) {
    textEl = tag.name;
    textBuf = '';
  } else if (tag.name === 'commit' && curEntry) {
    curEntry.commitRevision = Number(tag.attributes.revision);
  }
});
parser.on('text', (t) => { if (textEl) textBuf += t; });
parser.on('cdata', (t) => { if (textEl) textBuf += t; });
parser.on('closetag', (tag) => {
  const name = typeof tag === 'string' ? tag : tag.name;
  if (name === 'entry' && curEntry) {
    entries += 1;
    if (firstEntryMs === null) firstEntryMs = Number(process.hrtime.bigint() - started) / 1e6;
    curEntry = null;
    if (entries > maxEntries) abortWith('tooLarge-entries');
  } else if (name === 'path' && curPath) {
    entries += 1;
    if (firstEntryMs === null) firstEntryMs = Number(process.hrtime.bigint() - started) / 1e6;
    itemCounts[curPath.item] = (itemCounts[curPath.item] ?? 0) + 1;
    if (relSamples.length < 3) {
      const prefix = ((oldUrl ?? url).replace(/@\d+$/, '').replace(/\/$/, '')) + '/';
      relSamples.push({ url: textBuf, rel: textBuf.startsWith(prefix) ? textBuf.slice(prefix.length) : null, ...curPath });
    }
    curPath = null;
    if (entries > maxEntries) abortWith('tooLarge-entries');
  } else if (textEl === name) {
    if (curEntry && name !== 'path') curEntry[name] = textBuf;
    textEl = null;
    textBuf = '';
  }
});
parser.on('error', (e) => { errorText = String((e && e.message) || e); });

// ---------- 读取 stdout ----------
const decoder = new StringDecoder('utf8');
const chunks = [];
child.stdout.on('data', (chunk) => {
  if (ttfbNs === null) ttfbNs = Number(process.hrtime.bigint() - started) / 1e6;
  bytes += chunk.length;
  if (mode === 'buffer') {
    chunks.push(chunk);
  } else {
    parser.write(decoder.write(chunk));
  }
  if (bytes > maxBytes) abortWith('tooLarge-bytes');
});

child.on('close', (code, signal) => {
  childClosed = true;
  if (mode === 'buffer' && status === 'ok') {
    const whole = Buffer.concat(chunks).toString('utf8');
    chunks.length = 0;
    parser.write(whole);
    parser.close();
  } else if (status === 'ok' && mode === 'stream') {
    parser.write(decoder.end());
    parser.close();
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  clearInterval(sampler);
  const peak = process.memoryUsage().rss > peakRss ? process.memoryUsage().rss : peakRss;
  console.log(JSON.stringify({
    doc, mode,
    status: status === 'ok' && code !== 0 ? 'error' : status,
    exitCode: code, signal,
    entries, bytes,
    elapsedMs: Math.round(elapsedMs),
    ttfbMs: ttfbNs === null ? null : Math.round(ttfbNs),
    firstEntryMs: firstEntryMs === null ? null : Math.round(firstEntryMs),
    baseRssMiB: +(baseRss / 1048576).toFixed(1),
    peakRssMiB: +(peak / 1048576).toFixed(1),
    deltaRssMiB: +((peak - baseRss) / 1048576).toFixed(1),
    itemCounts: doc === 'summarize' ? itemCounts : undefined,
    firstPathSamples: doc === 'summarize' ? relSamples : undefined,
    stderr: stderrBuf.trim().slice(0, 500) || undefined,
    parserError: errorText || undefined,
  }));
});
process.on('exit', () => { if (!childClosed) { try { child.kill('SIGKILL'); } catch { /* ignore */ } } });
