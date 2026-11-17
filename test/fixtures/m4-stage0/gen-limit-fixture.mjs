#!/usr/bin/env node
// 历史上限语义参考验证。
//
// 产品上限为 5,000 个唯一命中 revision 与 100,000 个唯一扫描 revision；
// 这里用同构的小参数（matched=3、scanned=6、pageSize=2、单轮原始回包预算=6）
// 验证历史分页契约：到达上限停止请求、越过时完整保留整页与 lookahead、
// reasons 记录 matched/scanned、同一轮可两项并存、页内记录不截断、清理重置会话。
//
// 用法：node gen-limit-fixture.mjs
// 输出：JSON 断言；失败时 exit 1。
//
// 合成源（降序）：r108 other, r107 other, r106 HIT, r105 HIT, r104 other,
//                  r103 HIT, r102 HIT, r101 other —— 共 8 条，4 条命中。
const PAGE = 2; // 产品 50
const MATCHED_LIMIT = 2; // 产品 5000；此处取 2 以便让最后一批越过上限（1 -> 3）验证「保留整页」
const SCANNED_LIMIT = 6; // 产品 100000
const RAW_BUDGET = 6; // 产品 500
const LOOKAHEAD = PAGE + 1;

const source = [
  { rev: 108, hit: false },
  { rev: 107, hit: false },
  { rev: 106, hit: true },
  { rev: 105, hit: true },
  { rev: 104, hit: false },
  { rev: 103, hit: true },
  { rev: 102, hit: true },
  { rev: 101, hit: false },
];

function newSession() {
  return {
    entriesByRevision: new Map(), // rev -> {hit}
    scannedRevisionIds: new Set(),
    rawFetchedTotal: 0,
    rawFetchedInLoad: 0,
    scannedThisLoad: new Set(),
    displayedCount: 0,
    visibleEntries: [],
    historyLimitState: null,
    canFetchMore: true,
  };
}

// 参考 loadMore：先展示 pending，再从源按 page+1 请求，每轮最多 RAW_BUDGET 条原始回包；
// 每次请求前检查上限；越过也保留整页。
function loadMore(s, cursor) {
  s.rawFetchedInLoad = 0;
  s.scannedThisLoad = new Set();
  const reasons = [];
  // 1) 先展示已加载未展示匹配
  const pending = s.visibleEntries.length - s.displayedCount;
  if (pending > 0) {
    s.displayedCount = Math.min(s.displayedCount + PAGE, s.visibleEntries.length);
    return { mode: "pending-only", reasons: [] };
  }
  // 2) 网络：检查上限
  while (cursor >= 1 && s.rawFetchedInLoad < RAW_BUDGET) {
    const matched = [...s.entriesByRevision.values()].filter((e) => e.hit).length;
    const scanned = s.scannedRevisionIds.size;
    if (matched >= MATCHED_LIMIT) {
      reasons.push({ kind: "matched", limit: MATCHED_LIMIT, actual: matched });
      break;
    }
    if (scanned >= SCANNED_LIMIT) {
      reasons.push({ kind: "scanned", limit: SCANNED_LIMIT, actual: scanned });
      break;
    }
    const batch = source.filter((e) => e.rev <= cursor).slice(0, LOOKAHEAD);
    if (!batch.length) break;
    const take = Math.min(batch.length, RAW_BUDGET - s.rawFetchedInLoad);
    for (const e of batch.slice(0, take)) {
      s.rawFetchedTotal += 1;
      s.rawFetchedInLoad += 1;
      s.scannedThisLoad.add(e.rev);
      s.scannedRevisionIds.add(e.rev);
      if (!s.entriesByRevision.has(e.rev)) {
        s.entriesByRevision.set(e.rev, e);
        if (e.hit) s.visibleEntries.push(e);
      }
    }
    cursor = batch[Math.min(take, batch.length) - 1].rev - 1;
  }
  // 到达上限也记 reason（等于或越过都记录）
  const matched = [...s.entriesByRevision.values()].filter((e) => e.hit).length;
  const scanned = s.scannedRevisionIds.size;
  if (matched >= MATCHED_LIMIT && !reasons.some((r) => r.kind === "matched")) {
    reasons.push({ kind: "matched", limit: MATCHED_LIMIT, actual: matched });
  }
  if (scanned >= SCANNED_LIMIT && !reasons.some((r) => r.kind === "scanned")) {
    reasons.push({ kind: "scanned", limit: SCANNED_LIMIT, actual: scanned });
  }
  if (reasons.length) {
    s.historyLimitState = { reasons };
    s.canFetchMore = false;
  }
  // 展示首批
  s.displayedCount = Math.min(PAGE, s.visibleEntries.length);
  return { mode: "network", reasons, cursor };
}

const s = newSession();
const r1 = loadMore(s, 108);
const checks = {
  round1_raw_budget: s.rawFetchedInLoad === RAW_BUDGET,
  round1_scanned_reaches_limit: s.scannedRevisionIds.size === SCANNED_LIMIT,
  round1_matched_over_limit_kept: [...s.entriesByRevision.values()].filter((e) => e.hit).length === 3,
  round1_reasons_both: r1.reasons.map((r) => r.kind).sort().join(",") === "matched,scanned",
  round1_reason_values:
    r1.reasons.find((r) => r.kind === "matched").limit === MATCHED_LIMIT &&
    r1.reasons.find((r) => r.kind === "matched").actual === 3 &&
    r1.reasons.find((r) => r.kind === "scanned").actual === SCANNED_LIMIT,
  round1_page_kept_whole: s.entriesByRevision.size === 6,
  round1_displayed: s.displayedCount === PAGE,
  round1_pending: s.visibleEntries.length - s.displayedCount === 1,
  round1_cannot_fetch: s.canFetchMore === false,
  round1_has_more_due_pending: s.displayedCount < s.visibleEntries.length,
  // 第二轮：先展示 pending，不发网络
  round2_pending_only: (() => {
    const before = s.rawFetchedTotal;
    const r2 = loadMore(s, 101);
    return r2.mode === "pending-only" && s.rawFetchedTotal === before;
  })(),
  round2_pending_cleared: s.displayedCount === s.visibleEntries.length,
  round2_no_more: s.canFetchMore === false && s.displayedCount === s.visibleEntries.length,
  // 清理/关闭重开：新 session 全部归零
  reset_clears: (() => {
    const t = newSession();
    return t.entriesByRevision.size === 0 && t.scannedRevisionIds.size === 0 && t.historyLimitState === null && t.canFetchMore === true;
  })(),
};
const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(JSON.stringify({ checks, failed, state: {
  rawFetchedInLoad: s.rawFetchedInLoad,
  rawFetchedTotal: s.rawFetchedTotal,
  scannedRevisionIds: [...s.scannedRevisionIds].sort((a, b) => b - a),
  entriesByRevision: s.entriesByRevision.size,
  visibleEntries: s.visibleEntries.map((e) => e.rev),
  displayedCount: s.displayedCount,
  historyLimitState: s.historyLimitState,
  canFetchMore: s.canFetchMore,
} }, null, 2));
if (failed.length) {
  console.error("SELF-CHECK FAILED:", failed.join(","));
  process.exit(1);
}
