#!/usr/bin/env node
// M4 阶段0 V1 压测：svn list --xml 解析基准
// 用法: node --expose-gc parse-bench.cjs <xml-file> <saxes|fxp>
// saxes 模式模拟 runStream：createReadStream 64 KiB 分块 + StringDecoder('utf8')，不预读整段。
// fxp 模式对照：整段 readFileSync + fast-xml-parser（项目 devDependency）。
'use strict';
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { SaxesParser } = require(process.env.M4_SAXES_PATH || '/tmp/m4-stage0-V1/nodetools/node_modules/saxes');

const file = process.argv[2];
const mode = process.argv[3] || 'saxes';
if (!file) { console.error('usage: parse-bench.cjs <xml-file> <saxes|fxp>'); process.exit(2); }

const kb = (n) => Math.round(n / 1024 * 10) / 10; // bytes -> KiB
const t0 = process.hrtime.bigint();
const peak = { rss: 0, heap: 0 };
const sampler = setInterval(() => {
  const m = process.memoryUsage();
  if (m.rss > peak.rss) peak.rss = m.rss;
  if (m.heapUsed > peak.heap) peak.heap = m.heapUsed;
}, 20);
sampler.unref();
const finish = (extra) => {
  clearInterval(sampler);
  const m = process.memoryUsage();
  const ru = process.resourceUsage();
  const out = {
    mode, file: path.basename(file), bytes: fs.statSync(file).size,
    elapsedMs: Number(process.hrtime.bigint() - t0) / 1e6,
    rssEndKiB: kb(m.rss), heapEndKiB: kb(m.heapUsed),
    peakSampledRssKiB: kb(peak.rss), peakSampledHeapKiB: kb(peak.heap),
    maxRssKiB_report: ru.maxRSS, // Node: KiB (macOS 上由 libuv 归一化)
    ...extra,
  };
  console.log(JSON.stringify(out));
};

if (mode === 'fxp') {
  const { XMLParser } = require(process.env.M4_FXP_PATH || require('path').join(__dirname, '..', '..', '..', 'node_modules', 'fast-xml-parser'));
  const xml = fs.readFileSync(file, 'utf8');
  const readMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', trimValues: false });
  const t1 = process.hrtime.bigint();
  const doc = parser.parse(xml);
  const parseMs = Number(process.hrtime.bigint() - t1) / 1e6;
  const entries = doc && doc.lists && doc.lists.list && doc.lists.list.entry ? [].concat(doc.lists.list.entry) : [];
  finish({ readMs, parseMs, entries: entries.length, retained: entries.length, sample: entries[0] });
} else {
  // saxes 流式：与 runStream 相同模型，宿主只保留紧凑条目
  const entries = [];
  let cur = null, curField = null, textBuf = '';
  const revisionCounts = Object.create(null);
  let listPath = null;
  const parser = new SaxesParser({ fragment: false });
  parser.on('opentag', (tag) => {
    if (tag.name === 'list') { listPath = tag.attributes.path || null; }
    else if (tag.name === 'entry') {
      cur = { kind: tag.attributes.kind || null, name: null, size: null, commitRevision: null, author: null, date: null };
    } else if (tag.name === 'name' && cur) curField = 'name';
    else if (tag.name === 'size' && cur) curField = 'size';
    else if (tag.name === 'commit' && cur) cur.commitRevision = tag.attributes.revision || null;
    else if (tag.name === 'author' && cur) curField = 'author';
    else if (tag.name === 'date' && cur) curField = 'date';
    else curField = null;
    textBuf = '';
  });
  parser.on('text', (t) => { if (cur && curField) textBuf += t; });
  parser.on('cdata', (t) => { if (cur && curField) textBuf += t; });
  parser.on('closetag', (tag) => {
    const name = typeof tag === 'string' ? tag : tag.name;
    if (!cur) return;
    if ((name === 'name' || name === 'size' || name === 'author' || name === 'date') && curField === name) {
      cur[name] = textBuf;
      curField = null;
    } else if (name === 'entry') {
      entries.push(cur);
      const r = cur.commitRevision || '?';
      revisionCounts[r] = (revisionCounts[r] || 0) + 1;
      cur = null;
    }
    textBuf = '';
  });
  parser.on('error', (e) => { console.error('SAX error:', e.message); process.exit(3); });
  const decoder = new StringDecoder('utf8');
  let chunks = 0, parseMs = 0, readMs = 0;
  const stream = fs.createReadStream(file, { highWaterMark: 64 * 1024 });
  stream.on('data', (buf) => {
    chunks++;
    const s = decoder.write(buf);
    const t = process.hrtime.bigint();
    parser.write(s);
    parseMs += Number(process.hrtime.bigint() - t) / 1e6;
  });
  stream.on('end', () => {
    const tail = decoder.end();
    if (tail) parser.write(tail);
    parser.close();
    readMs = Number(process.hrtime.bigint() - t0) / 1e6 - parseMs;
    const revs = Object.keys(revisionCounts).length;
    finish({ chunks, parseMs, readMs, entries: entries.length, listPath, distinctCommitRevisions: revs,
      bytesPerEntry: Math.round(fs.statSync(file).size / Math.max(entries.length, 1)), sample: entries[0] });
  });
  stream.on('error', (e) => { console.error(e); process.exit(4); });
}
