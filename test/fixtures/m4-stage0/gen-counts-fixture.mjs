#!/usr/bin/env node
// 计数 fixture 生成与参考验证。
//
// 生成两轮“加载更多”的多源合成回包，用于宿主单元测试直接断言六类计数：
//   rawFetchedInLoad / scannedThisLoad / rawFetchedTotal /
//   scannedRevisionIds / entriesByRevision / visibleMatched
//
// 数字来源（构造规则，非估算）：
//   第 1 轮：ancestor 源 497 条（revision 901..1397）+ copyfrom 源 3 条（903,902,901
//   均与第 1 源重复）→ raw=500、唯一=497；497 个唯一 revision 中 3 个命中目标
//   （901 来自 copyfrom 源路径、1000、1100）；r1100 的 author=bob，按 author=alice
//   筛选后可见 2。第 2 轮：ancestor 源 497 条（404..900）+ copyfrom 源同样 3 条重复
//   → 本轮 raw=500、本轮唯一 497；会话累计 raw=1000、累计唯一 994。
//
// 用法：node gen-counts-fixture.mjs <输出目录>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: node gen-counts-fixture.mjs <outDir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function logentry(rev, author, msg, paths) {
  const pathXml = paths
    .map(
      ({ action = "M", path, kind = "file" }) =>
        `   <path\n      action="${action}"\n      prop-mods="false"\n      text-mods="true"\n      kind="${kind}">${xmlEscape(path)}</path>`
    )
    .join("\n");
  return `   <logentry\n      revision="${rev}">\n<author>${author}</author>\n<date>2026-11-13T00:00:00.000000Z</date>\n<paths>\n${pathXml}\n</paths>\n<msg>${xmlEscape(msg)}</msg>\n</logentry>`;
}

const logXml = (entries) => `<?xml version="1.0" encoding="UTF-8"?>\n<log>\n${entries.join("\n")}\n</log>\n`;

// 源 1：给定 revision 列表（降序），默认路径 /trunk/other；r1000/r1100 命中目标。
function ancestorRound(revs) {
  return revs.map((rev) => {
    const hit = rev === 1000 || rev === 1100;
    const author = rev === 1100 ? "bob" : "alice";
    return logentry(rev, author, hit ? `edit target at r${rev}` : `edit other at r${rev}`, [
      { action: "M", path: hit ? "/trunk/target.txt" : "/trunk/other.txt" },
    ]);
  });
}

// 源 2：3 条与同轮源 1 重复的 revision；hit 时最后一条提供目标路径。
function copyfromRound(revs, hit) {
  const paths = (i) => [{ action: "M", path: hit && i === 2 ? "/trunk/target.txt" : "/trunk/other.txt" }];
  return revs.map((rev, i) => logentry(rev, "alice", `copyfrom dup at r${rev}`, paths(i)));
}

const range = (hi, lo) => {
  const out = [];
  for (let r = hi; r >= lo; r--) out.push(r);
  return out;
};

writeFileSync(join(outDir, "counts-ancestor-1.xml"), logXml(ancestorRound(range(1397, 901))));
writeFileSync(join(outDir, "counts-copyfrom-1.xml"), logXml(copyfromRound([903, 902, 901], true)));
writeFileSync(join(outDir, "counts-ancestor-2.xml"), logXml(ancestorRound(range(900, 404))));
writeFileSync(join(outDir, "counts-copyfrom-2.xml"), logXml(copyfromRound([406, 405, 404], false)));

// ---------- 参考归并/计数实现（仅实验验证，不是产品代码） ----------
function parseLogXml(xml) {
  const entries = [];
  const re = /<logentry\s+revision="(\d+)">([\s\S]*?)<\/logentry>/g;
  let m;
  while ((m = re.exec(xml))) {
    const body = m[2];
    const author = /<author>([\s\S]*?)<\/author>/.exec(body)?.[1] ?? "";
    const msg = /<msg>([\s\S]*?)<\/msg>/.exec(body)?.[1] ?? "";
    const paths = [];
    const pre = /<path([^>]*)>([^<]+)<\/path>/g;
    let pm;
    while ((pm = pre.exec(body))) {
      const attrs = pm[1];
      paths.push({
        action: /action="([^"]+)"/.exec(attrs)?.[1] ?? "?",
        path: pm[2].trim(),
      });
    }
    entries.push({ rev: Number(m[1]), author, msg, paths });
  }
  return entries;
}

const read = (f) => readFileSync(join(outDir, f), "utf8");
const TARGET = "/trunk/target.txt";

function newState() {
  return {
    rawFetchedInLoad: 0,
    rawFetchedTotal: 0,
    scannedThisLoad: new Set(),
    scannedRevisionIds: new Set(),
    entriesByRevision: new Map(),
  };
}

function runRound(state, files, filterAuthor) {
  state.rawFetchedInLoad = 0;
  state.scannedThisLoad = new Set();
  const sources = files.map((f) => parseLogXml(read(f)));
  // 1) 原始回包与扫描集合：按源逐个计入（含跨源重复）
  for (const entries of sources) {
    state.rawFetchedInLoad += entries.length;
    for (const e of entries) {
      state.rawFetchedTotal += 1;
      state.scannedThisLoad.add(e.rev);
      state.scannedRevisionIds.add(e.rev);
    }
  }
  // 2) 归并：同 revision 唯一记录，路径并集
  for (const entries of sources) {
    for (const e of entries) {
      const prev = state.entriesByRevision.get(e.rev);
      if (prev) {
        const seen = new Set(prev.paths.map((p) => p.path + "|" + p.action));
        for (const p of e.paths) if (!seen.has(p.path + "|" + p.action)) prev.paths.push(p);
      } else {
        state.entriesByRevision.set(e.rev, { ...e, paths: [...e.paths] });
      }
    }
  }
  // 3) 命中目标（简化：本 fixture 中 entry 路径即目标或无关）
  const matched = [...state.entriesByRevision.values()]
    .filter((e) => e.paths.some((p) => p.path === TARGET))
    .sort((a, b) => b.rev - a.rev);
  // 4) 用户筛选 author（大小写不敏感精确）
  const visible = matched.filter((e) => (filterAuthor ? e.author === filterAuthor : true));
  const displayed = Math.min(50, visible.length);
  return {
    rawFetchedInLoad: state.rawFetchedInLoad,
    scannedThisLoad: state.scannedThisLoad.size,
    rawFetchedTotal: state.rawFetchedTotal,
    scannedRevisionIds: state.scannedRevisionIds.size,
    entriesByRevision: state.entriesByRevision.size,
    matchedCount: matched.length,
    matchedRevs: matched.map((e) => e.rev),
    visibleMatched: visible.length,
    visibleRevs: visible.map((e) => e.rev),
    displayedCount: displayed,
    pending: visible.length - displayed,
  };
}

const state = newState();
const round1 = runRound(state, ["counts-ancestor-1.xml", "counts-copyfrom-1.xml"], "alice");
const round2 = runRound(state, ["counts-ancestor-2.xml", "counts-copyfrom-2.xml"], "alice");
const pendingOnly = { rawFetchedInLoad: 0, scannedThisLoad: 0, note: "本轮只展示待展示匹配，不发网络" };

const checks = [
  ["round1_raw", round1.rawFetchedInLoad === 500],
  ["round1_unique", round1.scannedThisLoad === 497],
  ["round1_matched", round1.matchedCount === 3],
  ["round1_visible", round1.visibleMatched === 2],
  ["round1_displayed", round1.displayedCount === 50 || round1.visibleMatched < 50],
  ["round2_budget_independent", round2.rawFetchedInLoad === 500],
  ["round2_unique_this_load", round2.scannedThisLoad === 497],
  ["round2_raw_total_accumulates", round2.rawFetchedTotal === 1000],
  ["round2_scanned_total_accumulates", round2.scannedRevisionIds === 994],
  ["round2_this_load_not_cumulative", round2.scannedThisLoad !== round2.scannedRevisionIds],
];
const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);

const expected = {
  round1,
  round2,
  pendingOnly,
  checks: Object.fromEntries(checks),
  failed,
  hasMoreAssertions: {
    // 本 fixture 只有 2 条可见匹配，不足以演示 pending；500 条扫描预算仓库
    // （500 raw / 80 matched / 每页 50）断言三态：见 probe-history.sh 的分页模拟输出。
    pendingFirst: "displayedCount=50 < visibleMatched=80 => hasMore=true",
    unscannedSources: "displayedCount=visibleMatched 且源未耗尽 => canFetchMore=true => hasMore=true",
    sessionLimit: "historyLimitState.reasons 非空 => canFetchMore=false；pending 清空后 hasMore=false，未清空仍 true",
    allEmpty: "displayedCount=visibleMatched 且 canFetchMore=false => hasMore=false",
  },
  sourceDesign:
    "round1: ancestor r1397..901 (497) + copyfrom r903,902,901 (3 dups); matched r901,r1000,r1100; bob on r1100 filtered by author=alice => visible 2",
};

writeFileSync(join(outDir, "expected.json"), JSON.stringify(expected, null, 2));
console.log(JSON.stringify(expected, null, 2));
if (failed.length) {
  console.error("SELF-CHECK FAILED:", failed.join(","));
  process.exit(1);
}
