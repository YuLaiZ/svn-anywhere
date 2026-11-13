#!/usr/bin/env node
// M4 阶段0 V1 渲染耗时估算（无隔离 VS Code 宿主时的等价方法）
// 方法：用项目现有 Webview 的等价 DOM 片段（jsdom + 与 src/host/panel/view.ts 树行同构的 div.row）
// 估算“首批 40 项上屏”和“每片 40 项追加”的纯 Webview 侧构建/插入耗时；不含 VS Code IPC 与真实 Chromium 合成。
// 用法: node render-bench.cjs <xml-file> [rounds]
'use strict';
const fs = require('fs');
const { JSDOM } = require(process.env.M4_JSDOM_PATH || require('path').join(__dirname, '..', '..', '..', 'node_modules', 'jsdom'));
const { SaxesParser } = require(process.env.M4_SAXES_PATH || '/tmp/m4-stage0-V1/nodetools/node_modules/saxes');

const file = process.argv[2];
const rounds = Number(process.argv[3] || 20);
if (!file) { console.error('usage: render-bench.cjs <xml-file> [rounds]'); process.exit(2); }

// 先流式解析出紧凑条目（复用与 parse-bench 相同的 SAX 语义）
function parseEntries(xmlFile) {
  const entries = [];
  let cur = null, curField = null, textBuf = '';
  const parser = new SaxesParser({ fragment: false });
  parser.on('opentag', (tag) => {
    if (tag.name === 'entry') cur = { kind: tag.attributes.kind || null, name: null, size: null, commitRevision: null, author: null, date: null };
    else if (tag.name === 'name' && cur) curField = 'name';
    else if (tag.name === 'size' && cur) curField = 'size';
    else if (tag.name === 'commit' && cur) cur.commitRevision = tag.attributes.revision || null;
    else if (tag.name === 'author' && cur) curField = 'author';
    else if (tag.name === 'date' && cur) curField = 'date';
    else curField = null;
    textBuf = '';
  });
  parser.on('text', (t) => { if (cur && curField) textBuf += t; });
  parser.on('closetag', (tag) => {
    const name = typeof tag === 'string' ? tag : tag.name;
    if (!cur) return;
    if ((name === 'name' || name === 'size' || name === 'author' || name === 'date') && curField === name) { cur[name] = textBuf; curField = null; }
    else if (name === 'entry') { entries.push(cur); cur = null; }
    textBuf = '';
  });
  parser.write(fs.readFileSync(xmlFile, 'utf8'));
  parser.close();
  return entries;
}

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (kind) => (kind === 'dir' ? '[D]' : '[F]');

// 与 view.ts:643 的树行结构同构：div.row[data-row-id][role=listitem] > 若干 span + 操作按钮
function rowHtml(e, i) {
  const id = `${e.kind}:${e.name}`;
  return `<div class="row" data-row-id="${escapeHtml(id)}" role="listitem" tabindex="0">` +
    `<span class="row-icon" aria-hidden="true">${icon(e.kind)}</span>` +
    `<span class="row-name">${escapeHtml(e.name)}</span>` +
    `<span class="row-meta">r${escapeHtml(e.commitRevision || '?')}</span>` +
    `<span class="row-meta">${escapeHtml(e.author || '')}</span>` +
    `<span class="row-meta">${escapeHtml(e.date || '')}</span>` +
    (e.size != null ? `<span class="row-meta">${escapeHtml(e.size)} B</span>` : '') +
    `<button type="button" class="row-act" data-intent="copyBrowseUrl" data-row="${escapeHtml(id)}" aria-label="复制 URL">复制</button>` +
    `</div>`;
}

const entries = parseEntries(file);
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="tree" class="tree" role="list"></div></body></html>');
const doc = dom.window.document;
const tree = doc.getElementById('tree');

const measure = (fn) => {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
};
const sliced = [];
const sliceOps = [];
const jsonBytes = [];
const firstScreen = [];
const appendSlice = [];

for (let r = 0; r < rounds; r++) {
  tree.innerHTML = '';
  // 数据分片操作：slice(0,40) + 视图模型映射 + JSON（Webview 消息载荷）
  sliceOps.push(measure(() => {
    const page = entries.slice(0, 40);
    const vm = page.map((e) => ({ id: `${e.kind}:${e.name}`, name: e.name, kind: e.kind, rev: e.commitRevision, author: e.author, date: e.date, size: e.size }));
    const payload = JSON.stringify({ type: 'nodes', items: vm });
    jsonBytes.push(Buffer.byteLength(payload));
    sliced.push(vm);
  }));
  // 首批 40 项上屏：一次 innerHTML 赋值（与 app.ts:325 相同方式）
  firstScreen.push(measure(() => { tree.innerHTML = entries.slice(0, 40).map(rowHtml).join(''); }));
  // 每片 40 项追加：insertAdjacentHTML('beforeend')
  appendSlice.push(measure(() => { tree.insertAdjacentHTML('beforeend', entries.slice(40, 80).map((e, i) => rowHtml(e, i + 40)).join('')); }));
  // 简单交互：查询第 80 行 → 选中类切换
  measure(() => {
    const row = tree.querySelectorAll('.row')[79];
    if (row) { row.classList.add('selected'); row.setAttribute('aria-selected', 'true'); }
  });
}
const stat = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return { median: +s[Math.floor(s.length / 2)].toFixed(3), p95: +s[Math.min(s.length - 1, Math.floor(s.length * 0.95))].toFixed(3), max: +s[s.length - 1].toFixed(3) };
};
const rowsInDom = tree.querySelectorAll('.row').length;
console.log(JSON.stringify({
  file: require('path').basename(file), entries: entries.length, rounds,
  first40RowsBuilt: Math.min(40, entries.length), rowsInDomAfterAppend: rowsInDom,
  payload40Bytes: jsonBytes[0] || 0,
  dataSliceMs: stat(sliceOps), firstScreenMs: stat(firstScreen), appendSlice40Ms: stat(appendSlice),
  method: 'jsdom 等价 DOM（div.row 与 view.ts 树行同构）+ innerHTML/insertAdjacentHTML；不含 VS Code IPC/Chromium 布局绘制',
}));
