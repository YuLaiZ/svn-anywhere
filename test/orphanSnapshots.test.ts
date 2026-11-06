/**
 * 宿主孤儿快照清理单测（M3 §2.2 快照段）：
 * - 识别双条件：op- 命名形态 ∧ 内容为 {version, entries[], dirs[]} 快照
 *   schema 的 JSON，两者同时满足才视为快照文件；
 * - 删除集合：识别为快照 ∧ 不在未终态记录的 operationId 集合中——
 *   终态记录不保留快照（其同名残留即孤儿），未终态记录（含「begin 前落盘、
 *   记录已写」的在途导入）的快照不被误删；
 * - 不匹配识别形态的文件一律不动（防误删 globalStorageUri 下其他文件）；
 * - 每次 activate 幂等；globalStorageUri 缺失/目录不存在时静默跳过。
 */
import { mkdirSync, mkdtempSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import {
  OperationRegistry,
  resetRunningOperationsForTest,
  setOperationRegistryForTest,
  type OperationRecord,
  type OperationStore,
} from '../src/core/operations';
import { cleanupOrphanSnapshots } from '../src/host/orphanSnapshots';

const SNAPSHOT_JSON = JSON.stringify({ version: 1, entries: [{ path: 'a.txt' }], dirs: [] });

function memoryStore(): OperationStore & { data: Map<string, OperationRecord> } {
  const data = new Map<string, OperationRecord>();
  return {
    data,
    load: () => [...data.values()],
    save(record) {
      data.set(record.operationId, record);
    },
    remove(id) {
      data.delete(id);
    },
  };
}

function recordOf(overrides: Partial<OperationRecord> & { operationId: string }): OperationRecord {
  return {
    wcRoot: '/wc/a',
    targetRelPath: '.',
    nodeKind: 'dir',
    phase: 'unknown',
    knownRevisions: [],
    updatedAt: 100,
    ...overrides,
  };
}

const asUri = (fsPath: string): vscode.Uri => ({ fsPath }) as unknown as vscode.Uri;

let storageDir = '';

beforeEach(() => {
  resetRunningOperationsForTest();
  storageDir = mkdtempSync(join(tmpdir(), 'svn-anywhere-orphan-'));
});

afterEach(() => {
  rmSync(storageDir, { recursive: true, force: true });
  setOperationRegistryForTest(undefined);
});

describe('cleanupOrphanSnapshots：识别与删除集合', () => {
  it('识别双条件：op- 命名 ∧ 快照 schema 的 JSON 才删；不匹配形态一律不动', async () => {
    const store = memoryStore();
    setOperationRegistryForTest(new OperationRegistry(store));
    writeFileSync(join(storageDir, 'op-abc123-deadbee'), SNAPSHOT_JSON);
    writeFileSync(join(storageDir, 'op-abc123-notjson'), 'not json at all');
    writeFileSync(join(storageDir, 'op-abc123-schema2'), JSON.stringify({ hello: 'world' }));
    writeFileSync(join(storageDir, 'op-abc123-entries'), JSON.stringify({ version: 1, entries: [] }));
    writeFileSync(join(storageDir, 'op-abc123-dirs'), JSON.stringify({ version: 1, dirs: [] }));
    writeFileSync(join(storageDir, 'opless-snapshot'), SNAPSHOT_JSON);
    writeFileSync(join(storageDir, 'notes.txt'), 'unrelated');

    await cleanupOrphanSnapshots(asUri(storageDir));

    const left = readdirSync(storageDir).sort();
    expect(left).toEqual([
      'notes.txt',
      'op-abc123-dirs',
      'op-abc123-entries',
      'op-abc123-notjson',
      'op-abc123-schema2',
      'opless-snapshot',
    ]);
  });

  it('未终态记录的快照保留（含 begin 前落盘、记录已写的在途导入）；终态记录同名残留删除', async () => {
    const store = memoryStore();
    store.data.set('op-live-1', recordOf({ operationId: 'op-live-1', kind: 'import', phase: 'unknown' }));
    store.data.set('op-live-2', recordOf({ operationId: 'op-live-2', kind: 'commit', phase: 'unknown' }));
    store.data.set('op-done-1', recordOf({ operationId: 'op-done-1', kind: 'import', phase: 'done' }));
    store.data.set('op-fail-1', recordOf({ operationId: 'op-fail-1', kind: 'import', phase: 'failed-unconfirmed' }));
    setOperationRegistryForTest(new OperationRegistry(store));
    for (const name of ['op-live-1', 'op-live-2', 'op-done-1', 'op-fail-1']) {
      writeFileSync(join(storageDir, name), SNAPSHOT_JSON);
    }
    writeFileSync(join(storageDir, 'op-ghost-9'), SNAPSHOT_JSON);

    await cleanupOrphanSnapshots(asUri(storageDir));

    const left = readdirSync(storageDir).sort();
    // 未终态（unknown/在途）记录的快照是核实证据，不得误删；
    // 终态与无记录对应的快照即孤儿，按 operationId 清除。
    expect(left).toEqual(['op-live-1', 'op-live-2']);
  });

  it('每次 activate 幂等：二次执行无新删除、结果稳定', async () => {
    const store = memoryStore();
    setOperationRegistryForTest(new OperationRegistry(store));
    writeFileSync(join(storageDir, 'op-once-1'), SNAPSHOT_JSON);
    writeFileSync(join(storageDir, 'keep.txt'), 'x');

    await cleanupOrphanSnapshots(asUri(storageDir));
    expect(readdirSync(storageDir)).toEqual(['keep.txt']);

    await cleanupOrphanSnapshots(asUri(storageDir));
    expect(readdirSync(storageDir)).toEqual(['keep.txt']);
  });

  it('globalStorageUri 缺失或目录不存在时静默跳过（首次 activate 常态）', async () => {
    const store = memoryStore();
    setOperationRegistryForTest(new OperationRegistry(store));
    await expect(cleanupOrphanSnapshots(undefined)).resolves.toBeUndefined();
    await expect(cleanupOrphanSnapshots(asUri(join(storageDir, 'not-exist-dir')))).resolves.toBeUndefined();
  });

  it('空目录（mkdir 后无文件）正常完成', async () => {
    const store = memoryStore();
    setOperationRegistryForTest(new OperationRegistry(store));
    const emptyDir = join(storageDir, 'empty');
    mkdirSync(emptyDir);
    await expect(cleanupOrphanSnapshots(asUri(emptyDir))).resolves.toBeUndefined();
    expect(existsSync(emptyDir)).toBe(true);
  });
});
