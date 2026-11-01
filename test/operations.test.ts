/**
 * 操作级注册表与未完成记录框架测试（§14）：
 * 同副本互斥、unknown/待协调限制跨面板保持、恢复加载与幂等。
 */
import { describe, expect, it } from 'vitest';
import {
  OperationRegistry,
  restrictsWrite,
  type OperationRecord,
  type OperationStore,
} from '../src/core/operations';

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

describe('OperationRegistry：同副本互斥', () => {
  it('同一工作副本第二个写操作被拒绝并返回持有者', async () => {
    const registry = new OperationRegistry();
    const first = await registry.begin({ wcRoot: '/wc/a', targetRelPath: 'src', nodeKind: 'dir' });
    expect(first.ok).toBe(true);
    const second = await registry.begin({ wcRoot: '/wc/a', targetRelPath: 'other', nodeKind: 'file' });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('busy');
      expect(second.heldBy.operationId).toBe((first as { operationId: string }).operationId);
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

describe('OperationRegistry：状态与限制', () => {
  it('结果未知与待协调限制写入；确认未提交失败与完成解除', async () => {
    const registry = new OperationRegistry();
    const begun = await registry.begin({ wcRoot: '/wc/a', targetRelPath: '.', nodeKind: 'dir' });
    const operationId = (begun as { operationId: string }).operationId;

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
    const begun = await registry.begin({ wcRoot: '/wc/a', targetRelPath: '.', nodeKind: 'dir' });
    const operationId = (begun as { operationId: string }).operationId;
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
    const begun = await registry.begin({ wcRoot: '/wc/a', targetRelPath: '.', nodeKind: 'dir' });
    const operationId = (begun as { operationId: string }).operationId;
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
    const begun = await registry.begin({ wcRoot: '/wc/a', targetRelPath: '.', nodeKind: 'dir' });
    const operationId = (begun as { operationId: string }).operationId;
    await registry.finish(operationId);
    await registry.finish(operationId);
    expect(store.data.size).toBe(0);
    expect(registry.pendingForWcRoot('/wc/a')).toHaveLength(0);
  });
});

describe('OperationRegistry：重启恢复', () => {
  it('loadPending 恢复未完成记录并保持限制；已完成记录不进入限制', async () => {
    const store = memoryStore();
    const pending: OperationRecord = {
      operationId: 'op-old',
      wcRoot: '/wc/a',
      targetRelPath: 'src',
      nodeKind: 'dir',
      phase: 'unknown',
      knownRevisions: [130],
      updatedAt: 100,
    };
    const done: OperationRecord = {
      operationId: 'op-done',
      wcRoot: '/wc/b',
      targetRelPath: '.',
      nodeKind: 'dir',
      phase: 'done',
      knownRevisions: [],
      updatedAt: 100,
    };
    store.data.set(pending.operationId, pending);
    store.data.set(done.operationId, done);

    const registry = new OperationRegistry(store);
    await registry.loadPending();
    expect(registry.writeRestriction('/wc/a')?.operationId).toBe('op-old');
    expect(registry.writeRestriction('/wc/b')).toBeUndefined();
    expect(registry.pendingForWcRoot('/wc/a')[0].knownRevisions).toEqual([130]);
  });
});

describe('restrictsWrite', () => {
  it('限制态集合覆盖在途与未知/待协调；失败与完成不限制', () => {
    const record = (phase: OperationRecord['phase']): OperationRecord => ({
      operationId: 'x', wcRoot: '/w', targetRelPath: '.', nodeKind: 'file',
      phase, knownRevisions: [], updatedAt: 0,
    });
    expect(restrictsWrite(record('unknown'))).toBe(true);
    expect(restrictsWrite(record('committed-pending-coordination'))).toBe(true);
    expect(restrictsWrite(record('coordination-blocked'))).toBe(true);
    expect(restrictsWrite(record('committing'))).toBe(true);
    expect(restrictsWrite(record('saving'))).toBe(true);
    expect(restrictsWrite(record('prepared'))).toBe(false);
    expect(restrictsWrite(record('failed-unconfirmed'))).toBe(false);
    expect(restrictsWrite(record('done'))).toBe(false);
  });
});
