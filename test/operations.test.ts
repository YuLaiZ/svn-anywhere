/**
 * 操作级注册表与未完成记录测试（§14 + M3 §2.2）：
 * 同副本互斥、unknown/待协调限制跨面板保持、恢复加载与幂等；
 * M3 增量：kind×phase 限制矩阵、lockKey 统一索引与旧记录兜底、
 * residue-pending 不进 active、hasActive/hasRunning 口径分层、
 * 首载陈旧化分诊（按运行登记判定）、beginResume、operationId 预生成、
 * M3 固定字段落盘与终态收口。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  OperationRegistry,
  checkoutLockKey,
  resetRunningOperationsForTest,
  restrictsWrite,
  runWithRunningKey,
  type MarkPhasePatch,
  type OperationKind,
  type OperationPhase,
  type OperationRecord,
  type OperationStore,
} from '../src/core/operations';

// 运行登记是模块级单例：每个用例前清空，防失败路径残留键污染 loadPending 分诊。
beforeEach(() => {
  resetRunningOperationsForTest();
});

function memoryStore(): OperationStore & { data: Map<string, OperationRecord>; saves: number } {
  const data = new Map<string, OperationRecord>();
  let saves = 0;
  return {
    data,
    get saves() {
      return saves;
    },
    load: () => [...data.values()],
    save(record) {
      saves += 1;
      data.set(record.operationId, record);
    },
    remove(id) {
      data.delete(id);
    },
  };
}

/** 预置持久化记录的字面量兜底（模拟重启前落盘的旧/新记录形态）。 */
function seededRecord(overrides: Partial<OperationRecord> & { operationId: string; wcRoot: string }): OperationRecord {
  return {
    targetRelPath: '.',
    nodeKind: 'dir',
    phase: 'prepared',
    knownRevisions: [],
    updatedAt: 100,
    ...overrides,
  };
}

/** begin 成功后取操作 ID 的收窄辅助。 */
function operationIdOf(result: { ok: boolean; operationId?: string }): string {
  expect(result.ok).toBe(true);
  return (result as { operationId: string }).operationId;
}

describe('OperationRegistry：同副本互斥（M2 语义回归）', () => {
  it('同一工作副本第二个写操作被拒绝并返回持有者', async () => {
    const registry = new OperationRegistry();
    const first = await registry.begin({ wcRoot: '/wc/a', targetRelPath: 'src', nodeKind: 'dir' });
    expect(first.ok).toBe(true);
    const second = await registry.begin({ wcRoot: '/wc/a', targetRelPath: 'other', nodeKind: 'file' });
    expect(second.ok).toBe(false);
    if (!second.ok && second.reason === 'busy') {
      expect(second.heldBy.operationId).toBe(operationIdOf(first));
    } else {
      expect.unreachable('期望 busy 分支');
    }
  });

  it('不同工作副本互不影响（互斥键是副本根，不是仓库 UUID）', async () => {
    const registry = new OperationRegistry();
    await registry.begin({ wcRoot: '/wc/a', targetRelPath: '.', nodeKind: 'dir', repositoryUuid: 'uuid-1' });
    const other = await registry.begin({ wcRoot: '/wc/b', targetRelPath: '.', nodeKind: 'dir', repositoryUuid: 'uuid-1' });
    expect(other.ok).toBe(true);
  });

  it('begin 立即持久化（写入失败不发起提交由 store 抛错体现）', async () => {
    const store = memoryStore();
    const registry = new OperationRegistry(store);
    await registry.begin({ wcRoot: '/wc/a', targetRelPath: '.', nodeKind: 'dir' });
    expect(store.saves).toBe(1);
    expect(store.data.size).toBe(1);
  });
});

describe('OperationRegistry：状态与限制（M2 语义回归）', () => {
  it('结果未知与待协调限制写入；确认未提交失败与完成解除', async () => {
    const registry = new OperationRegistry();
    const operationId = operationIdOf(
      await registry.begin({ wcRoot: '/wc/a', targetRelPath: '.', nodeKind: 'dir' }),
    );

    await registry.markPhase(operationId, 'committing');
    expect(registry.writeRestriction('/wc/a')).toBeDefined();

    await registry.markPhase(operationId, 'unknown');
    expect(registry.writeRestriction('/wc/a')?.phase).toBe('unknown');
    // unknown 期间同副本新写操作仍被拒绝（跨面板关闭保持由单例+恢复加载保证）。
    const retry = await registry.begin({ wcRoot: '/wc/a', targetRelPath: '.', nodeKind: 'dir' });
    expect(retry.ok).toBe(false);

    await registry.markPhase(operationId, 'failed-unconfirmed');
    expect(registry.writeRestriction('/wc/a')).toBeUndefined();
    const afterFail = await registry.begin({ wcRoot: '/wc/a', targetRelPath: '.', nodeKind: 'dir' });
    expect(afterFail.ok).toBe(true);
  });

  it('每个已知成功批次追加 revision 并落盘', async () => {
    const store = memoryStore();
    const registry = new OperationRegistry(store);
    const operationId = operationIdOf(
      await registry.begin({ wcRoot: '/wc/a', targetRelPath: '.', nodeKind: 'dir' }),
    );
    await registry.markPhase(operationId, 'committing');
    await registry.markPhase(operationId, 'unknown', { knownRevisions: [128] });
    await registry.markPhase(operationId, 'committed-pending-coordination', { knownRevisions: [128, 129] });
    const record = store.data.get(operationId);
    expect(record?.knownRevisions).toEqual([128, 129]);
    expect(record?.phase).toBe('committed-pending-coordination');
    expect(registry.writeRestriction('/wc/a')?.knownRevisions).toEqual([128, 129]);
  });

  it('拆批提交的已成功路径随 revision 逐批追加落盘（committedPaths）', async () => {
    const store = memoryStore();
    const registry = new OperationRegistry(store);
    const operationId = operationIdOf(
      await registry.begin({ wcRoot: '/wc/a', targetRelPath: '.', nodeKind: 'dir' }),
    );
    await registry.markPhase(operationId, 'committing', { knownRevisions: [21], committedPaths: ['a.txt'] });
    await registry.markPhase(operationId, 'unknown', {
      knownRevisions: [21, 22],
      committedPaths: ['a.txt', 'b.txt'],
    });
    const record = store.data.get(operationId);
    expect(record?.committedPaths).toEqual(['a.txt', 'b.txt']);
    expect(registry.writeRestriction('/wc/a')?.committedPaths).toEqual(['a.txt', 'b.txt']);
  });

  it('finish 幂等并清理记录', async () => {
    const store = memoryStore();
    const registry = new OperationRegistry(store);
    const operationId = operationIdOf(
      await registry.begin({ wcRoot: '/wc/a', targetRelPath: '.', nodeKind: 'dir' }),
    );
    await registry.finish(operationId);
    await registry.finish(operationId);
    expect(store.data.size).toBe(0);
    expect(registry.pendingForWcRoot('/wc/a')).toHaveLength(0);
  });
});

describe('OperationRegistry：重启恢复（M2 语义回归）', () => {
  it('loadPending 恢复未完成记录并保持限制；已完成记录不进入限制', async () => {
    const store = memoryStore();
    store.data.set(
      'op-old',
      seededRecord({ operationId: 'op-old', wcRoot: '/wc/a', targetRelPath: 'src', phase: 'unknown', knownRevisions: [130] }),
    );
    store.data.set(
      'op-done',
      seededRecord({ operationId: 'op-done', wcRoot: '/wc/b', phase: 'done' }),
    );

    const registry = new OperationRegistry(store);
    await registry.loadPending();
    expect(registry.writeRestriction('/wc/a')?.operationId).toBe('op-old');
    expect(registry.writeRestriction('/wc/b')).toBeUndefined();
    expect(registry.pendingForWcRoot('/wc/a')[0].knownRevisions).toEqual([130]);
    // M2 kind 的终态记录维持源码现状：跳过但保留在 globalState。
    expect(store.data.has('op-done')).toBe(true);
  });
});

describe('restrictsWrite：kind×phase 矩阵', () => {
  const recordOf = (phase: OperationPhase, kind?: OperationKind): OperationRecord => ({
    operationId: 'x',
    wcRoot: '/w',
    targetRelPath: '.',
    nodeKind: 'file',
    phase,
    knownRevisions: [],
    updatedAt: 0,
    ...(kind ? { kind } : {}),
  });

  it('commit/ignore：维持 M2 集合（不含 prepared——prepared 由 busy 判定拦截）', () => {
    for (const kind of ['commit', 'ignore'] as const) {
      expect(restrictsWrite(recordOf('unknown', kind))).toBe(true);
      expect(restrictsWrite(recordOf('committed-pending-coordination', kind))).toBe(true);
      expect(restrictsWrite(recordOf('coordination-blocked', kind))).toBe(true);
      expect(restrictsWrite(recordOf('committing', kind))).toBe(true);
      expect(restrictsWrite(recordOf('saving', kind))).toBe(true);
      expect(restrictsWrite(recordOf('prepared', kind))).toBe(false);
      expect(restrictsWrite(recordOf('failed-unconfirmed', kind))).toBe(false);
      expect(restrictsWrite(recordOf('done', kind))).toBe(false);
    }
  });

  it('checkout：prepared/running 限制；residue-pending 与终态不限制', () => {
    expect(restrictsWrite(recordOf('prepared', 'checkout'))).toBe(true);
    expect(restrictsWrite(recordOf('running', 'checkout'))).toBe(true);
    expect(restrictsWrite(recordOf('residue-pending', 'checkout'))).toBe(false);
    expect(restrictsWrite(recordOf('failed-unconfirmed', 'checkout'))).toBe(false);
    expect(restrictsWrite(recordOf('done', 'checkout'))).toBe(false);
  });

  it('import/vacuum：prepared/running/unknown 限制（unknown 冻结沿用 M2 语义）', () => {
    for (const kind of ['import', 'vacuum'] as const) {
      expect(restrictsWrite(recordOf('prepared', kind))).toBe(true);
      expect(restrictsWrite(recordOf('running', kind))).toBe(true);
      expect(restrictsWrite(recordOf('unknown', kind))).toBe(true);
      expect(restrictsWrite(recordOf('failed-unconfirmed', kind))).toBe(false);
      expect(restrictsWrite(recordOf('done', kind))).toBe(false);
    }
  });

  it('update/cleanup/daily：恒不限制（M1 命令成功/失败都 finally finish）', () => {
    for (const kind of ['update', 'cleanup', 'daily'] as const) {
      for (const phase of ['prepared', 'saving', 'committing', 'unknown', 'running'] as const) {
        expect(restrictsWrite(recordOf(phase, kind))).toBe(false);
      }
    }
  });

  it('无 kind 旧记录按 commit 兜底（M2 的 unknown 冻结升级后原样保持）', () => {
    expect(restrictsWrite(recordOf('unknown'))).toBe(true);
    expect(restrictsWrite(recordOf('committed-pending-coordination'))).toBe(true);
    expect(restrictsWrite(recordOf('coordination-blocked'))).toBe(true);
    expect(restrictsWrite(recordOf('committing'))).toBe(true);
    expect(restrictsWrite(recordOf('saving'))).toBe(true);
    expect(restrictsWrite(recordOf('prepared'))).toBe(false);
    expect(restrictsWrite(recordOf('done'))).toBe(false);
  });
});

describe('lockKey 统一索引与旧记录兜底', () => {
  it('M3 记录按 lockKey 索引：writeRestriction/pendingForWcRoot 用 lockKey 命中', async () => {
    const registry = new OperationRegistry();
    const begun = await registry.begin({
      wcRoot: '/p/a/c',
      targetRelPath: '.',
      nodeKind: 'dir',
      kind: 'checkout',
      lockKey: '/p/a/c',
      targetPath: '/p/a/c',
      url: 'http://example.com/svn/trunk',
    });
    expect(begun.ok).toBe(true);
    expect(registry.writeRestriction('/p/a/c')?.kind).toBe('checkout');
    expect(registry.pendingForWcRoot('/p/a/c')).toHaveLength(1);
    // 记录 wcRoot 按 wcRoot=lockKey 约定写入。
    expect(registry.pendingForWcRoot('/p/a/c')[0].wcRoot).toBe('/p/a/c');
  });

  it('旧记录无 lockKey 按 wcRoot 兜底恢复限制', async () => {
    const store = memoryStore();
    store.data.set(
      'op-legacy',
      seededRecord({ operationId: 'op-legacy', wcRoot: '/wc/legacy', phase: 'unknown' }),
    );
    const registry = new OperationRegistry(store);
    await registry.loadPending();
    expect(registry.writeRestriction('/wc/legacy')?.operationId).toBe('op-legacy');
    expect(registry.pendingForWcRoot('/wc/legacy')).toHaveLength(1);
  });

  it('checkoutLockKey 用路径归一拼接：/p/ab+c 与 /p/a+bc 键互异', () => {
    expect(checkoutLockKey('/p/ab', 'c')).toBe('/p/ab/c');
    expect(checkoutLockKey('/p/a', 'bc')).toBe('/p/a/bc');
    expect(checkoutLockKey('/p/ab', 'c')).not.toBe(checkoutLockKey('/p/a', 'bc'));
  });
});

describe('residue-pending 不进 active', () => {
  it('运行期路径：markPhase 转 residue-pending 后同 lockKey 再次 begin 成功、记录仍在', async () => {
    const registry = new OperationRegistry();
    const first = await registry.begin({
      wcRoot: '/p/a/c',
      targetRelPath: '.',
      nodeKind: 'dir',
      kind: 'checkout',
      lockKey: '/p/a/c',
      targetPath: '/p/a/c',
    });
    const operationId = operationIdOf(first);
    await registry.markPhase(operationId, 'running');
    await registry.markPhase(operationId, 'residue-pending');
    expect(registry.hasActive('/p/a/c')).toBe(false);
    expect(registry.writeRestriction('/p/a/c')).toBeUndefined();
    const second = await registry.begin({
      wcRoot: '/p/a/c',
      targetRelPath: '.',
      nodeKind: 'dir',
      kind: 'checkout',
      lockKey: '/p/a/c',
      targetPath: '/p/a/c',
    });
    expect(second.ok).toBe(true);
    // 记录仍在（residue-pending 与新在途并存），可按 lockKey/targetPath 查询。
    const pending = registry.pendingForWcRoot('/p/a/c');
    expect(pending.some((record) => record.operationId === operationId && record.phase === 'residue-pending')).toBe(true);
    expect(pending.some((record) => record.targetPath === '/p/a/c' && record.phase === 'prepared')).toBe(true);
  });

  it('重启加载路径：checkout running 折算 residue-pending 后不占用、记录可查询', async () => {
    const store = memoryStore();
    store.data.set(
      'op-co',
      seededRecord({
        operationId: 'op-co',
        wcRoot: '/p/a/c',
        kind: 'checkout',
        lockKey: '/p/a/c',
        phase: 'running',
        targetPath: '/p/a/c',
        updatedAt: 200,
      }),
    );
    const registry = new OperationRegistry(store);
    await registry.loadPending();
    expect(registry.hasActive('/p/a/c')).toBe(false);
    expect(registry.writeRestriction('/p/a/c')).toBeUndefined();
    const again = await registry.begin({
      wcRoot: '/p/a/c',
      targetRelPath: '.',
      nodeKind: 'dir',
      kind: 'checkout',
      lockKey: '/p/a/c',
    });
    expect(again.ok).toBe(true);
    // 折算后的记录仍留在 records/globalState 供恢复查询。
    expect(registry.pendingForWcRoot('/p/a/c').some((record) => record.operationId === 'op-co')).toBe(true);
    expect(store.data.get('op-co')?.phase).toBe('residue-pending');
  });
});

describe('hasActive / hasRunning 口径分层', () => {
  it('hasActive 对 M1 update/cleanup 的 prepared 在途命中', async () => {
    for (const kind of ['update', 'cleanup', 'daily'] as const) {
      const registry = new OperationRegistry();
      await registry.begin({ wcRoot: `/wc/${kind}`, targetRelPath: '.', nodeKind: 'dir', kind });
      expect(registry.hasActive(`/wc/${kind}`)).toBe(true);
    }
  });

  it('hasActive 对 residue-pending 不命中', async () => {
    const registry = new OperationRegistry();
    const operationId = operationIdOf(
      await registry.begin({
        wcRoot: '/p/a/c', targetRelPath: '.', nodeKind: 'dir', kind: 'checkout', lockKey: '/p/a/c',
      }),
    );
    await registry.markPhase(operationId, 'residue-pending');
    expect(registry.hasActive('/p/a/c')).toBe(false);
  });

  it('链路①：begin → markPhase(unknown) 后 hasRunning=false、写限制仍在（P4 busy=false/writeLocked=true）', async () => {
    const registry = new OperationRegistry();
    const operationId = operationIdOf(
      await registry.begin({ wcRoot: '/wc/a', targetRelPath: '.', nodeKind: 'dir', kind: 'commit' }),
    );
    expect(registry.hasRunning('/wc/a')).toBe(true);
    await registry.markPhase(operationId, 'unknown');
    expect(registry.hasRunning('/wc/a')).toBe(false);
    expect(registry.writeRestriction('/wc/a')?.phase).toBe('unknown');
  });

  it('链路②：residue-pending → beginResume 转 running 后 true；done/回 residue-pending 后 false', async () => {
    const registry = new OperationRegistry();
    const operationId = operationIdOf(
      await registry.begin({
        wcRoot: '/p/a/c', targetRelPath: '.', nodeKind: 'dir', kind: 'checkout', lockKey: '/p/a/c',
      }),
    );
    await registry.markPhase(operationId, 'residue-pending');
    expect(registry.hasRunning('/p/a/c')).toBe(false);
    const resumed = await registry.beginResume(operationId, '/p/a/c');
    expect(resumed.ok).toBe(true);
    expect(registry.hasRunning('/p/a/c')).toBe(true);
    await registry.markPhase(operationId, 'residue-pending');
    expect(registry.hasRunning('/p/a/c')).toBe(false);
    const resumedAgain = await registry.beginResume(operationId, '/p/a/c');
    expect(resumedAgain.ok).toBe(true);
    await registry.markPhase(operationId, 'done');
    expect(registry.hasRunning('/p/a/c')).toBe(false);
  });

  it('链路③：markPhase 转协调态后 hasRunning=false', async () => {
    const registry = new OperationRegistry();
    const operationId = operationIdOf(
      await registry.begin({ wcRoot: '/wc/a', targetRelPath: '.', nodeKind: 'dir', kind: 'commit' }),
    );
    await registry.markPhase(operationId, 'committing');
    expect(registry.hasRunning('/wc/a')).toBe(true);
    await registry.markPhase(operationId, 'committed-pending-coordination', { knownRevisions: [9] });
    expect(registry.hasRunning('/wc/a')).toBe(false);
    await registry.markPhase(operationId, 'coordination-blocked');
    expect(registry.hasRunning('/wc/a')).toBe(false);
  });

  it('链路④：runWithRunningKey 执行期 true、结束（成功/失败）即 false', async () => {
    const registry = new OperationRegistry();
    let duringRun = false;
    await runWithRunningKey('/wc/r', async () => {
      duringRun = registry.hasRunning('/wc/r');
    });
    expect(duringRun).toBe(true);
    expect(registry.hasRunning('/wc/r')).toBe(false);
    let failed = false;
    await runWithRunningKey('/wc/r', async () => {
      throw new Error('boom');
    }).catch(() => {
      failed = true;
    });
    expect(failed).toBe(true);
    expect(registry.hasRunning('/wc/r')).toBe(false);
  });
});

describe('loadPending 首载分诊（重启模拟：新 registry + 同一 store）', () => {
  it('M1 kind=update 的 prepared → 转 failed-unconfirmed 并移除、同键 begin 直接可用', async () => {
    const store = memoryStore();
    store.data.set(
      'op-m1',
      seededRecord({ operationId: 'op-m1', wcRoot: '/wc/u', kind: 'update', phase: 'prepared' }),
    );
    const registry = new OperationRegistry(store);
    await registry.loadPending();
    expect(store.data.has('op-m1')).toBe(false);
    expect(registry.pendingForWcRoot('/wc/u')).toHaveLength(0);
    expect(registry.hasRunning('/wc/u')).toBe(false);
    const again = await registry.begin({ wcRoot: '/wc/u', targetRelPath: '.', nodeKind: 'dir', kind: 'update' });
    expect(again.ok).toBe(true);
  });

  it('M2（kind=commit 与无 kind）prepared/saving/committing → 转 unknown、begin 被 unknown 冻结拦截', async () => {
    for (const [id, kind, phase] of [
      ['op-c1', 'commit', 'prepared'],
      ['op-c2', 'commit', 'saving'],
      ['op-c3', 'commit', 'committing'],
      ['op-c4', undefined, 'prepared'],
      ['op-c5', undefined, 'saving'],
      ['op-c6', undefined, 'committing'],
      ['op-i1', 'ignore', 'committing'],
    ] as const) {
      // 每轮迭代模拟一次独立重启：进程内运行登记随进程终止清空。
      resetRunningOperationsForTest();
      const store = memoryStore();
      store.data.set(id, seededRecord({ operationId: id, wcRoot: '/wc/a', kind, phase }));
      const registry = new OperationRegistry(store);
      await registry.loadPending();
      expect(store.data.get(id)?.phase, `${id}（kind=${kind ?? '无'}）应折算 unknown`).toBe('unknown');
      expect(registry.hasRunning('/wc/a')).toBe(false);
      // unknown 冻结拦截新 begin（P4 不 busy、writeLocked=true）。
      const retry = await registry.begin({ wcRoot: '/wc/a', targetRelPath: '.', nodeKind: 'dir' });
      expect(retry.ok).toBe(false);
      if (!retry.ok && retry.reason === 'busy') {
        expect(retry.heldBy.phase).toBe('unknown');
      }
      // M2 核实「未提交」后 begin 恢复可用。
      await registry.markPhase(id, 'failed-unconfirmed');
      const after = await registry.begin({ wcRoot: '/wc/a', targetRelPath: '.', nodeKind: 'dir' });
      expect(after.ok).toBe(true);
    }
  });

  it('M3 三 kind 重启折算：checkout → residue-pending、import/vacuum → unknown（不依赖面板打开）', async () => {
    const cases: Array<[string, OperationKind, OperationPhase, OperationPhase]> = [
      ['op-ck1', 'checkout', 'prepared', 'residue-pending'],
      ['op-ck2', 'checkout', 'running', 'residue-pending'],
      ['op-im1', 'import', 'prepared', 'unknown'],
      ['op-im2', 'import', 'running', 'unknown'],
      ['op-va1', 'vacuum', 'prepared', 'unknown'],
      ['op-va2', 'vacuum', 'running', 'unknown'],
    ];
    for (const [id, kind, from, to] of cases) {
      const store = memoryStore();
      store.data.set(id, seededRecord({ operationId: id, wcRoot: '/wc/k', kind, phase: from }));
      const registry = new OperationRegistry(store);
      await registry.loadPending();
      expect(store.data.get(id)?.phase, `${kind} ${from} 应折算 ${to}`).toBe(to);
      expect(registry.hasRunning('/wc/k')).toBe(false);
    }
  });

  it('M3 终态残留（kill 落在 markPhase 终态与 finish 之间）由首载顺带清理；M2 终态保留', async () => {
    const store = memoryStore();
    store.data.set('op-m3-done', seededRecord({ operationId: 'op-m3-done', wcRoot: '/wc/x', kind: 'checkout', phase: 'done' }));
    store.data.set('op-m3-fail', seededRecord({ operationId: 'op-m3-fail', wcRoot: '/wc/x', kind: 'import', phase: 'failed-unconfirmed' }));
    store.data.set('op-va-fail', seededRecord({ operationId: 'op-va-fail', wcRoot: '/wc/x', kind: 'vacuum', phase: 'failed-unconfirmed' }));
    store.data.set('op-m2-done', seededRecord({ operationId: 'op-m2-done', wcRoot: '/wc/y', phase: 'done' }));
    const registry = new OperationRegistry(store);
    await registry.loadPending();
    expect(store.data.has('op-m3-done')).toBe(false);
    expect(store.data.has('op-m3-fail')).toBe(false);
    expect(store.data.has('op-va-fail')).toBe(false);
    expect(store.data.has('op-m2-done')).toBe(true);
  });
});

describe('陈旧化按运行登记判定（替代首载限定）', () => {
  it('①同进程 begin（登记命中）后新 registry loadPending 不改写在途记录', async () => {
    const store = memoryStore();
    const first = new OperationRegistry(store);
    const operationId = operationIdOf(
      await first.begin({ wcRoot: '/wc/a', targetRelPath: '.', nodeKind: 'dir', kind: 'commit' }),
    );
    // 二次 activate：新实例 + 同一 store，登记有键 → 只做 active 收窄。
    const second = new OperationRegistry(store);
    await second.loadPending();
    expect(store.data.get(operationId)?.phase).toBe('prepared');
    expect(second.pendingForWcRoot('/wc/a')[0].phase).toBe('prepared');
    expect(second.hasActive('/wc/a')).toBe(true);
    expect(second.hasRunning('/wc/a')).toBe(true);
  });

  it('②预置陈旧记录（登记无键）→ 新 registry loadPending 照常按 kind 折算', async () => {
    const store = memoryStore();
    store.data.set(
      'op-stale',
      seededRecord({ operationId: 'op-stale', wcRoot: '/wc/a', kind: 'commit', phase: 'committing' }),
    );
    const registry = new OperationRegistry(store);
    await registry.loadPending();
    expect(store.data.get('op-stale')?.phase).toBe('unknown');
  });

  it('③begin→finish 后登记键清除', async () => {
    const registry = new OperationRegistry();
    const operationId = operationIdOf(
      await registry.begin({ wcRoot: '/wc/a', targetRelPath: '.', nodeKind: 'dir' }),
    );
    expect(registry.hasRunning('/wc/a')).toBe(true);
    await registry.finish(operationId);
    expect(registry.hasRunning('/wc/a')).toBe(false);
  });
});

describe('beginResume：续检独占正门', () => {
  /** 构造「checkout residue-pending 记录 + 同 lockKey 他人占用」的形态。 */
  async function seedResidueWithHolder(
    registry: OperationRegistry,
    holderKind: 'commit' | 'vacuum',
    holderPhase: OperationPhase,
  ): Promise<{ residueId: string; holderId: string }> {
    const residue = await registry.begin({
      wcRoot: '/p/a/c', targetRelPath: '.', nodeKind: 'dir', kind: 'checkout', lockKey: '/p/a/c',
    });
    const residueId = operationIdOf(residue);
    await registry.markPhase(residueId, 'residue-pending');
    const holder = await registry.begin({
      wcRoot: '/p/a/c', targetRelPath: '.', nodeKind: 'dir', kind: holderKind,
    });
    const holderId = operationIdOf(holder);
    if (holderPhase !== 'prepared') {
      await registry.markPhase(holderId, holderPhase);
    }
    return { residueId, holderId };
  }

  it('占用组①：同 lockKey 预置 M2 记录（committing/unknown）→ busy 拒绝、双方不变', async () => {
    for (const holderPhase of ['committing', 'unknown'] as const) {
      const registry = new OperationRegistry();
      const { residueId, holderId } = await seedResidueWithHolder(registry, 'commit', holderPhase);
      const result = await registry.beginResume(residueId, '/p/a/c');
      expect(result.ok).toBe(false);
      if (!result.ok && result.reason === 'busy') {
        expect(result.heldBy.operationId).toBe(holderId);
        expect(result.heldBy.phase).toBe(holderPhase);
      } else {
        expect.unreachable('期望 busy 分支');
      }
      expect(registry.pendingForWcRoot('/p/a/c').find((r) => r.operationId === residueId)?.phase).toBe('residue-pending');
      expect(registry.pendingForWcRoot('/p/a/c').find((r) => r.operationId === holderId)?.phase).toBe(holderPhase);
      expect(registry.hasRunning('/p/a/c')).toBe(holderPhase === 'committing');
    }
  });

  it('占用组②：预置 vacuum（running/unknown）→ busy 拒绝、双方不变', async () => {
    for (const holderPhase of ['running', 'unknown'] as const) {
      const registry = new OperationRegistry();
      const { residueId, holderId } = await seedResidueWithHolder(registry, 'vacuum', holderPhase);
      const result = await registry.beginResume(residueId, '/p/a/c');
      expect(result.ok).toBe(false);
      if (!result.ok && result.reason === 'busy') {
        expect(result.heldBy.operationId).toBe(holderId);
        expect(result.heldBy.phase).toBe(holderPhase);
      } else {
        expect.unreachable('期望 busy 分支');
      }
      expect(registry.pendingForWcRoot('/p/a/c').find((r) => r.operationId === residueId)?.phase).toBe('residue-pending');
      expect(registry.pendingForWcRoot('/p/a/c').find((r) => r.operationId === holderId)?.phase).toBe(holderPhase);
    }
  });

  it('成功链路：占用全无 → 转 running + 登记运行键、同 lockKey begin 返回 busy', async () => {
    const registry = new OperationRegistry();
    const begun = await registry.begin({
      wcRoot: '/p/a/c', targetRelPath: '.', nodeKind: 'dir', kind: 'checkout', lockKey: '/p/a/c',
    });
    const operationId = operationIdOf(begun);
    await registry.markPhase(operationId, 'running');
    await registry.markPhase(operationId, 'residue-pending');
    const result = await registry.beginResume(operationId, '/p/a/c');
    expect(result.ok).toBe(true);
    expect(registry.pendingForWcRoot('/p/a/c')[0].phase).toBe('running');
    expect(registry.hasRunning('/p/a/c')).toBe(true);
    expect(registry.hasActive('/p/a/c')).toBe(true);
    const retry = await registry.begin({
      wcRoot: '/p/a/c', targetRelPath: '.', nodeKind: 'dir', kind: 'checkout', lockKey: '/p/a/c',
    });
    expect(retry.ok).toBe(false);
    if (!retry.ok && retry.reason === 'busy') {
      expect(retry.heldBy.phase).toBe('running');
    }
  });

  it('recordUnavailable 形态（不带 heldBy）：不存在 / 已终态 / ID 不匹配', async () => {
    const registry = new OperationRegistry();
    // 不存在。
    const missing = await registry.beginResume('op-nope', '/p/a/c');
    expect(missing).toEqual({ ok: false, reason: 'recordUnavailable' });
    // 已转终态。
    const begun = await registry.begin({
      wcRoot: '/p/a/c', targetRelPath: '.', nodeKind: 'dir', kind: 'checkout', lockKey: '/p/a/c',
    });
    const operationId = operationIdOf(begun);
    await registry.markPhase(operationId, 'residue-pending');
    await registry.markPhase(operationId, 'failed-unconfirmed');
    const terminal = await registry.beginResume(operationId, '/p/a/c');
    expect(terminal).toEqual({ ok: false, reason: 'recordUnavailable' });
    // ID 不匹配（lockKey 与记录不符）。
    const other = await registry.begin({
      wcRoot: '/p/b/c', targetRelPath: '.', nodeKind: 'dir', kind: 'checkout', lockKey: '/p/b/c',
    });
    const otherId = operationIdOf(other);
    await registry.markPhase(otherId, 'residue-pending');
    const mismatched = await registry.beginResume(otherId, '/p/zzz');
    expect(mismatched).toEqual({ ok: false, reason: 'recordUnavailable' });
  });

  it('markPhase 持有者防线：同键他人持有 → 拒绝改写返回冲突、双方不变', async () => {
    const registry = new OperationRegistry();
    const { residueId, holderId } = await seedResidueWithHolder(registry, 'commit', 'committing');
    // 裸 markPhase 转 running（限制相位）必须被防线拒绝，不静默覆盖他人持有。
    const result = await registry.markPhase(residueId, 'running');
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'conflict') {
      expect(result.heldBy.operationId).toBe(holderId);
    } else {
      expect.unreachable('期望 conflict 分支');
    }
    expect(registry.pendingForWcRoot('/p/a/c').find((r) => r.operationId === residueId)?.phase).toBe('residue-pending');
    expect(registry.pendingForWcRoot('/p/a/c').find((r) => r.operationId === holderId)?.phase).toBe('committing');
  });
});

describe('operationId 预生成', () => {
  it('冲突校验读全量：与预置 done 终态记录同 ID → idConflict（内存 records 不含终态，只查内存会漏）', async () => {
    const store = memoryStore();
    store.data.set('op-done', seededRecord({ operationId: 'op-done', wcRoot: '/wc/b', phase: 'done' }));
    const registry = new OperationRegistry(store);
    await registry.loadPending();
    const result = await registry.begin({
      wcRoot: '/wc/a', targetRelPath: '.', nodeKind: 'dir', operationId: 'op-done',
    });
    expect(result).toEqual({ ok: false, reason: 'idConflict' });
    expect(store.data.has('op-done')).toBe(true);
  });

  it('与在途记录同 ID → idConflict', async () => {
    const store = memoryStore();
    const registry = new OperationRegistry(store);
    const first = await registry.begin({ wcRoot: '/wc/a', targetRelPath: '.', nodeKind: 'dir' });
    const conflict = await registry.begin({
      wcRoot: '/wc/b', targetRelPath: '.', nodeKind: 'dir', operationId: operationIdOf(first),
    });
    expect(conflict).toEqual({ ok: false, reason: 'idConflict' });
  });

  it('传入 ID 沿用不另生成；不传则生成 op- 前缀 ID', async () => {
    const registry = new OperationRegistry();
    const preassigned = await registry.begin({
      wcRoot: '/wc/a', targetRelPath: '.', nodeKind: 'dir', operationId: 'op-pregen',
    });
    expect(preassigned.ok).toBe(true);
    if (preassigned.ok) {
      expect(preassigned.operationId).toBe('op-pregen');
    }
    const generated = await registry.begin({ wcRoot: '/wc/b', targetRelPath: '.', nodeKind: 'dir' });
    expect(generated.ok).toBe(true);
    if (generated.ok) {
      expect(generated.operationId.startsWith('op-')).toBe(true);
    }
  });
});

describe('M3 各 kind 固定字段随 begin 落盘（重启模拟后可读）', () => {
  it('checkout 全字段：url/targetPath/pinnedRevision/depth/身份三元组 + lockKey', async () => {
    const store = memoryStore();
    const first = new OperationRegistry(store);
    const begun = await first.begin({
      wcRoot: '/p/a/c',
      targetRelPath: '.',
      nodeKind: 'dir',
      kind: 'checkout',
      lockKey: '/p/a/c',
      url: 'http://example.com/svn/trunk@33',
      targetPath: '/p/a/c',
      pinnedRevision: 33,
      depth: 'infinity',
      repositoryUuid: 'uuid-1',
      repositoryRootUrl: 'http://example.com/svn',
      relativeUrl: '^/trunk',
    });
    expect(begun.ok).toBe(true);
    // 重启模拟：进程终止清空运行登记，新 registry + 同一 store 折算后全字段仍可读。
    resetRunningOperationsForTest();
    const second = new OperationRegistry(store);
    await second.loadPending();
    const record = second.pendingForWcRoot('/p/a/c').find((item) => item.operationId === operationIdOf(begun));
    expect(record?.phase).toBe('residue-pending');
    expect(record?.kind).toBe('checkout');
    expect(record?.lockKey).toBe('/p/a/c');
    expect(record?.url).toBe('http://example.com/svn/trunk@33');
    expect(record?.targetPath).toBe('/p/a/c');
    expect(record?.pinnedRevision).toBe(33);
    expect(record?.depth).toBe('infinity');
    expect(record?.repositoryUuid).toBe('uuid-1');
    expect(record?.repositoryRootUrl).toBe('http://example.com/svn');
    expect(record?.relativeUrl).toBe('^/trunk');
  });

  it('import：targetPath + importIntent（目标 URL 从 importIntent.targetUrl 读回，不设冗余顶层 url）', async () => {
    const store = memoryStore();
    const first = new OperationRegistry(store);
    const begun = await first.begin({
      wcRoot: '/src/dir',
      targetRelPath: '.',
      nodeKind: 'dir',
      kind: 'import',
      lockKey: '/src/dir',
      targetPath: '/src/dir',
      importIntent: {
        targetUrl: 'http://example.com/svn/trunk/imp',
        parentIdentity: { repositoryUuid: 'uuid-2', repositoryRootUrl: 'http://example.com/svn', lastChangedRevision: 88 },
        message: '导入说明',
        nameMode: 'manual',
        messageHash: 'sha-abc',
        startedAt: 1234,
        summary: { fileCount: 3, totalBytes: 100 },
        snapshotDigest: 'digest-1',
        fileRefs: 'op-import-1',
      },
    });
    // 重启模拟：清运行登记后新 registry 折算（import prepared → unknown）。
    resetRunningOperationsForTest();
    const second = new OperationRegistry(store);
    await second.loadPending();
    const record = second.pendingForWcRoot('/src/dir').find((item) => item.operationId === operationIdOf(begun));
    expect(record?.phase).toBe('unknown');
    expect(record?.targetPath).toBe('/src/dir');
    expect(record?.url).toBeUndefined();
    expect(record?.importIntent?.targetUrl).toBe('http://example.com/svn/trunk/imp');
    expect(record?.importIntent?.parentIdentity.lastChangedRevision).toBe(88);
    expect(record?.importIntent?.messageHash).toBe('sha-abc');
    expect(record?.importIntent?.fileRefs).toBe('op-import-1');
  });

  it('vacuum：targetPath（= 规范化 wcRoot）+ scanEpoch + pristineBefore', async () => {
    const store = memoryStore();
    const first = new OperationRegistry(store);
    const begun = await first.begin({
      wcRoot: '/wc/vac',
      targetRelPath: '.',
      nodeKind: 'dir',
      kind: 'vacuum',
      lockKey: '/wc/vac',
      targetPath: '/wc/vac',
      scanEpoch: 7,
      pristineBefore: { cacheCount: 12, unreferencedBytes: 3456, missingCount: null },
    });
    // 重启模拟：清运行登记后新 registry 折算（vacuum prepared → unknown）。
    resetRunningOperationsForTest();
    const second = new OperationRegistry(store);
    await second.loadPending();
    const record = second.pendingForWcRoot('/wc/vac').find((item) => item.operationId === operationIdOf(begun));
    expect(record?.phase).toBe('unknown');
    expect(record?.targetPath).toBe('/wc/vac');
    expect(record?.scanEpoch).toBe(7);
    expect(record?.pristineBefore).toEqual({ cacheCount: 12, unreferencedBytes: 3456, missingCount: null });
  });

  it('不传 lockKey 的 M1/M2 调用点：记录无 lockKey 字段、wcRoot 用入参（语义不变）', async () => {
    const store = memoryStore();
    const registry = new OperationRegistry(store);
    const begun = await registry.begin({ wcRoot: '/wc/a', targetRelPath: 'src', nodeKind: 'dir', kind: 'commit' });
    expect(begun.ok).toBe(true);
    if (begun.ok) {
      expect(begun.record.wcRoot).toBe('/wc/a');
      expect(begun.record.lockKey).toBeUndefined();
      expect(begun.record.kind).toBe('commit');
    }
  });
});

describe('markPhase patch 按 kind 白名单', () => {
  it('import 追加 outcome/resolvedRevision 落盘', async () => {
    const store = memoryStore();
    const registry = new OperationRegistry(store);
    const operationId = operationIdOf(
      await registry.begin({
        wcRoot: '/src/dir', targetRelPath: '.', nodeKind: 'dir', kind: 'import', lockKey: '/src/dir',
      }),
    );
    await registry.markPhase(operationId, 'running');
    await registry.markPhase(operationId, 'unknown', { outcome: 'merged', resolvedRevision: 42 });
    const record = store.data.get(operationId);
    expect(record?.phase).toBe('unknown');
    expect(record?.outcome).toBe('merged');
    expect(record?.resolvedRevision).toBe(42);
  });

  it('commit kind 的 patch 不含 outcome/resolvedRevision（白名单过滤）', async () => {
    const store = memoryStore();
    const registry = new OperationRegistry(store);
    const operationId = operationIdOf(
      await registry.begin({ wcRoot: '/wc/a', targetRelPath: '.', nodeKind: 'dir', kind: 'commit' }),
    );
    await registry.markPhase(operationId, 'unknown', { outcome: 'merged', resolvedRevision: 42 });
    const record = store.data.get(operationId);
    expect(record?.outcome).toBeUndefined();
    expect(record?.resolvedRevision).toBeUndefined();
  });

  it('固定字段不在 patch 白名单（无补写通道，运行时过滤）', async () => {
    const store = memoryStore();
    const registry = new OperationRegistry(store);
    const operationId = operationIdOf(
      await registry.begin({
        wcRoot: '/p/a/c', targetRelPath: '.', nodeKind: 'dir', kind: 'checkout',
        lockKey: '/p/a/c', targetPath: '/p/a/c',
      }),
    );
    // 模拟绕过类型的调用：固定字段必须被白名单拒收。
    await registry.markPhase(operationId, 'running', { targetPath: '/evil', url: 'http://evil' } as MarkPhasePatch);
    const record = store.data.get(operationId);
    expect(record?.targetPath).toBe('/p/a/c');
    expect(record?.url).toBeUndefined();
  });
});

describe('终态收口', () => {
  it('checkout/import/vacuum 出口 finalizeOperation 后记录不在 records/globalState', async () => {
    for (const [kind, phase] of [
      ['checkout', 'done'],
      ['checkout', 'failed-unconfirmed'],
      ['import', 'done'],
      ['import', 'failed-unconfirmed'],
      ['vacuum', 'done'],
    ] as const) {
      const store = memoryStore();
      const registry = new OperationRegistry(store);
      const begun = await registry.begin({
        wcRoot: '/wc/f', targetRelPath: '.', nodeKind: 'dir', kind, lockKey: '/wc/f',
      });
      const operationId = operationIdOf(begun);
      await registry.markPhase(operationId, 'running');
      await registry.finalizeOperation(operationId, phase);
      expect(registry.pendingForWcRoot('/wc/f'), `${kind} → ${phase} 后 records 应清空`).toHaveLength(0);
      expect(store.data.has(operationId), `${kind} → ${phase} 后 globalState 应移除`).toBe(false);
      expect(registry.hasActive('/wc/f')).toBe(false);
      expect(registry.hasRunning('/wc/f')).toBe(false);
    }
  });

  it('import 核实「已提交」经 finalizeOperation 携带 resolvedRevision 落盘后移除', async () => {
    const store = memoryStore();
    const registry = new OperationRegistry(store);
    const operationId = operationIdOf(
      await registry.begin({
        wcRoot: '/src/dir', targetRelPath: '.', nodeKind: 'dir', kind: 'import', lockKey: '/src/dir',
      }),
    );
    await registry.markPhase(operationId, 'unknown', { outcome: 'merged', resolvedRevision: 42 });
    await registry.finalizeOperation(operationId, 'done', { resolvedRevision: 42 });
    expect(store.data.has(operationId)).toBe(false);
    expect(registry.pendingForWcRoot('/src/dir')).toHaveLength(0);
  });

  it('vacuum 的 unknown/failed-unconfirmed 不随即 finish（保留至重新检测）', async () => {
    const registry = new OperationRegistry();
    const operationId = operationIdOf(
      await registry.begin({
        wcRoot: '/wc/vac', targetRelPath: '.', nodeKind: 'dir', kind: 'vacuum', lockKey: '/wc/vac',
      }),
    );
    await registry.markPhase(operationId, 'running');
    await registry.markPhase(operationId, 'unknown');
    expect(registry.pendingForWcRoot('/wc/vac')).toHaveLength(1);
    expect(registry.writeRestriction('/wc/vac')?.phase).toBe('unknown');
    // 重新检测完成（rescan 回调）→ finish 移除、writeRestriction 解除、可再次 begin。
    await registry.finish(operationId);
    expect(registry.writeRestriction('/wc/vac')).toBeUndefined();
    const again = await registry.begin({
      wcRoot: '/wc/vac', targetRelPath: '.', nodeKind: 'dir', kind: 'vacuum', lockKey: '/wc/vac',
    });
    expect(again.ok).toBe(true);
  });
});

describe('loadAllRecords：全量记录（含终态）', () => {
  it('宿主经注册表读全量，终态记录包含在内（idConflict 校验/孤儿清理数据源）', async () => {
    const store = memoryStore();
    store.data.set('op-done', seededRecord({ operationId: 'op-done', wcRoot: '/wc/b', phase: 'done' }));
    const registry = new OperationRegistry(store);
    const begun = await registry.begin({ wcRoot: '/wc/a', targetRelPath: '.', nodeKind: 'dir' });
    // begin 后 finish（records 已清）——loadAllRecords 仍应同时看到终态预置与 store 全量。
    await registry.finish(operationIdOf(begun));
    const all = await registry.loadAllRecords();
    expect(all.map((record) => record.operationId).sort()).toEqual(['op-done']);
    expect(registry.pendingForWcRoot('/wc/a')).toHaveLength(0);
  });
});
