#!/usr/bin/env node
// 合成大 XML 的 SAX 流式字节上限验证（tooLarge 路径可行性）
// 用法: node sax-limit-probe.cjs <xml-file> <limit-bytes> [--synthetic-mb N]
// 若文件不存在则先合成 N MiB 的合法 <lists> XML（条目名 200 字节），并写盘。
'use strict';
const fs = require('fs');
const { StringDecoder } = require('string_decoder');
const { SaxesParser } = require(process.env.M4_SAXES_PATH || require('path').join(__dirname, '..', '..', '..', 'node_modules', 'saxes'));

const file = process.argv[2];
const limit = Number(process.argv[3] || 64 * 1024 * 1024);
const synIdx = process.argv.indexOf('--synthetic-mb');
if (!file) { console.error('usage: sax-limit-probe.cjs <xml-file> <limit-bytes> [--synthetic-mb N]'); process.exit(2); }

if (synIdx > 0 && !fs.existsSync(file)) {
  const mb = Number(process.argv[synIdx + 1] || 100);
  const name = 'x'.repeat(200);
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>\n<lists>\n<list path="file:///synthetic">\n'];
  let size = Buffer.byteLength(parts[0]);
  const entry = `<entry kind="file">\n<name>${name}${name.slice(0, 20)}</name>\n<size>0</size>\n<commit revision="1"><author>a</author><date>2026-01-01T00:00:00.000000Z</date></commit>\n</entry>\n`;
  const entryBytes = Buffer.byteLength(entry);
  while (size < mb * 1024 * 1024) { parts.push(entry); size += entryBytes; }
  parts.push('</list>\n</lists>\n');
  fs.writeFileSync(file, parts.join(''));
}

const t0 = process.hrtime.bigint();
let entries = 0, bytes = 0, aborted = false, firstAbortMs = null;
let cur = false, textBuf = '';
const parser = new SaxesParser({ fragment: false });
parser.on('opentag', (tag) => {
  if (tag.name === 'entry') { cur = true; }
  textBuf = '';
});
parser.on('text', (t) => { if (cur) textBuf += t; });
parser.on('closetag', (tag) => {
  const name = typeof tag === 'string' ? tag : tag.name;
  if (name === 'entry') { entries++; cur = false; }
  textBuf = '';
});

const decoder = new StringDecoder('utf8');
const stream = fs.createReadStream(file, { highWaterMark: 64 * 1024 });
stream.on('data', (buf) => {
  if (aborted) return;
  bytes += buf.length;
  if (bytes > limit) {
    aborted = true;
    firstAbortMs = Number(process.hrtime.bigint() - t0) / 1e6;
    stream.destroy();
    finish();
    return;
  }
  parser.write(decoder.write(buf));
});
stream.on('end', () => { if (!aborted) { parser.write(decoder.end()); parser.close(); finish(); } });

function finish() {
  const m = process.memoryUsage();
  console.log(JSON.stringify({
    file: file.split('/').pop(), fileBytes: fs.statSync(file).size, limit,
    abortedAtLimit: aborted, bytesReadBeforeAbort: bytes, firstAbortMs: firstAbortMs && +firstAbortMs.toFixed(1),
    entriesParsedBeforeAbort: entries,
    totalMs: +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1),
    nodeMaxRssKiB: process.resourceUsage().maxRSS, rssEndKiB: Math.round(m.rss / 1024), heapEndKiB: Math.round(m.heapUsed / 1024),
    retainedEntries: aborted ? 0 : entries,
    note: aborted ? '上限触发后立即 destroy 流，不保留已收条目（tooLarge）' : '完整流式解析，仅计数与紧凑条目',
  }));
}
