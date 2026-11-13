#!/usr/bin/env node
// M4 阶段0 V1：host 级认证单飞协调器原型验证（不弹真实凭据框，用受控 Promise 模拟）
// 语义：按 scheme+host+port 共享一次凭据 Promise；并发失败请求共享同一次补录；
//       取消则同源等待者统一失败；成功则各自重试原路径；不同源独立补录。
'use strict';

class CancelledError extends Error { constructor() { super('auth cancelled'); this.code = 'AUTH_CANCELLED'; } }

function createCoordinator(promptImpl) {
  const inflight = new Map();
  const stats = { prompts: 0, sharedWaiters: 0, settledCancelled: 0, settledSuccess: 0 };
  function getCredentials(scope) {
    const key = `${scope.scheme}://${scope.host}:${scope.port || ''}`;
    if (inflight.has(key)) { stats.sharedWaiters++; return inflight.get(key); }
    const p = (async () => {
      stats.prompts++;
      try {
        const cred = await promptImpl(scope);
        stats.settledSuccess++;
        return cred;
      } catch (e) {
        stats.settledCancelled++;
        throw e;
      } finally {
        // 结算后移除：后续新请求可重新补录；等待者已持有同一 Promise
        setImmediate(() => inflight.delete(key));
      }
    })();
    // 防止未处理拒绝告警：每个等待者自行 catch
    p.catch(() => {});
    inflight.set(key, p);
    return p;
  }
  return { getCredentials, stats };
}

async function readWithAuth(coordinator, scope, readImpl, failFirst) {
  let attempts = 0;
  try {
    if (failFirst) {
      attempts++;
      const cred = await coordinator.getCredentials(scope);
      attempts++;
      return { ok: true, attempts, result: await readImpl(cred) };
    }
    attempts++;
    return { ok: true, attempts, result: await readImpl(null) };
  } catch (e) {
    return { ok: false, attempts, error: e.code || e.message };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const scopeA = { scheme: 'http', host: '127.0.0.1', port: 9101 };
  const scopeB = { scheme: 'http', host: '127.0.0.1', port: 9081 };

  // 场景 1：4 个并发失败请求（同 scope），用户成功补录一次
  const co1 = createCoordinator(async () => { await sleep(30); return { username: 'u', password: 'p' }; });
  const reads1 = await Promise.all([1, 2, 3, 4].map((i) =>
    readWithAuth(co1, scopeA, async (cred) => { await sleep(5); return `node${i}:ok:${cred.username}`; }, true)));
  const r1 = { scenario: 'success-4-concurrent', prompts: co1.stats.prompts, sharedWaiters: co1.stats.sharedWaiters, results: reads1.map((r) => `${r.ok ? 'ok' : 'fail'}/${r.attempts}`) };

  // 场景 2：4 个并发，用户取消一次
  const co2 = createCoordinator(async () => { await sleep(20); throw new CancelledError(); });
  const reads2 = await Promise.all([1, 2, 3, 4].map((i) =>
    readWithAuth(co2, scopeA, async () => 'x', true)));
  const r2 = { scenario: 'cancel-4-concurrent', prompts: co2.stats.prompts, sharedWaiters: co2.stats.sharedWaiters, cancelled: co2.stats.settledCancelled, results: reads2.map((r) => (r.ok ? 'ok' : r.error)) };

  // 场景 3：两个不同 host 同时失败 → 各自一次补录
  const co3 = createCoordinator(async () => { await sleep(15); return { username: 'u', password: 'p' }; });
  const reads3 = await Promise.all([
    readWithAuth(co3, scopeA, async () => 'a', true),
    readWithAuth(co3, scopeB, async () => 'b', true),
    readWithAuth(co3, scopeA, async () => 'a2', true),
    readWithAuth(co3, scopeB, async () => 'b2', true),
  ]);
  const r3 = { scenario: 'two-scopes', prompts: co3.stats.prompts, sharedWaiters: co3.stats.sharedWaiters, results: reads3.map((r) => (r.ok ? 'ok' : r.error)) };

  console.log(JSON.stringify({ r1, r2, r3 }, null, 2));
})();
