import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { FileOperationStore, WorkspaceLocks } from '../src/core/workspaceLock';
import { OperationRegistry, getOperationRegistry, initializeOperationStore, type OperationRecord } from '../src/core/operations';
import { createSvnLab, writeFile } from './helpers';

const supported = process.platform === 'darwin' || process.platform === 'linux';

it.skipIf(!supported)('SVN 子进程跨宿主退出窗口持锁，切斷后仍须核实操作记录', async () => {
  const lab = createSvnLab('svn-anywhere-lock-');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-lock-state-')));
  const helper = join(dir, 'workspace-lock');
  const reached = join(dir, 'commit-reached');
  const release = join(dir, 'continue');
  const quote = (path: string) => "'" + path.replaceAll("'", "'\\''") + "'";
  let childExited: Promise<unknown> | undefined;
  try {
    execFileSync(process.env.CC || 'cc', ['src/native/workspace-lock.c', '-o', helper]);
    const wc = lab.checkout('main');
    const sibling = lab.checkout('another');
    const nested = join(wc, 'some-directory');
    mkdirSync(nested);
    writeFile(wc, 'seed.txt', 'x', true);
    const hook = join(fileURLToPath(lab.repoUrl), 'hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\n: > ${quote(reached)}\nwhile [ ! -f ${quote(release)} ]; do sleep 0.08; done\n`, { mode: 0o700 });
    const locks = new WorkspaceLocks(join(dir, 'locks'), helper);
    const store = new FileOperationStore(join(dir, 'ops'));
    const lease = locks.acquire(wc);
    expect(lease).toBeDefined();
    if (!lease) return;
    const actual = spawn(helper, ['run', 'svn', 'commit', '-m', 'lock-fixture', '--', wc], {
      cwd: wc,
      stdio: ['ignore', 'ignore', 'ignore', ...lease.fds],
    });
    childExited = new Promise((resolve) => actual.once('exit', resolve));
    try {
      for (let index = 0; index < 70 && !existsSync(reached); index++) await delay(50);
      expect(existsSync(reached)).toBe(true);
    } finally {
      lease.close();
    }
    expect(locks.acquire(wc)).toBeUndefined();
    expect(locks.acquire(nested)).toBeUndefined();
    const unrelated = locks.acquire(sibling);
    expect(unrelated).toBeDefined();
    unrelated?.close();
    // Kill only the supervisor. The real svn process also inherited the descriptors.
    actual.kill('SIGKILL');
    await childExited;
    expect(locks.acquire(wc)).toBeUndefined();
    writeFileSync(release, '');
    let next = locks.acquire(wc);
    for (let index = 0; index < 70 && !next; index++) {
      await delay(50);
      next = locks.acquire(wc);
    }
    expect(next).toBeDefined();
    next?.close();

    await store.save({
      operationId: 'crashed-depth', phase: 'running', kind: 'depth-edit', updatedAt: 100, wcRoot: wc,
      depthProgress: { verified: 0, dispatching: 0 }, targetRelPath: '.', nodeKind: 'dir', knownRevisions: [],
    });
    const registry = new OperationRegistry(store, locks);
    await registry.loadPending();
    expect(registry.writeRestriction(wc)?.phase).toBe('unknown');
    await expect(registry.begin({ wcRoot: wc, targetRelPath: '.', nodeKind: 'dir', kind: 'daily' }))
      .resolves.toMatchObject({ ok: false, reason: 'busy' });
  } finally {
    writeFileSync(release, '');
    await childExited;
    lab.cleanup();
    rmSync(dir, { recursive: true });
  }
}, 15_000);

it.skipIf(!supported)('旧 Profile 独立迁移记录，另一个窗口可读且已结算记录不会复活', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-migration-')));
  try {
    const helper = join(dir, 'workspace-lock');
    execFileSync(process.env.CC || 'cc', ['src/native/workspace-lock.c', '-o', helper]);
    const current = { directory: join(dir, 'shared'), helper };
    const record: OperationRecord = {
      operationId: 'legacy-commit', phase: 'unknown', updatedAt: 100,
      wcRoot: join(dir, 'target'), targetRelPath: '.', nodeKind: 'dir', knownRevisions: [],
    };
    function profile(legacy: OperationRecord[]) {
      const state = new Map<string, unknown>([['svnAnywhere.operations', legacy]]);
      return {
        get<T>(key: string, fallback?: T) { return (state.get(key) ?? fallback) as T; },
        async update(key: string, value: unknown) { state.set(key, value); },
      };
    }
    const first = profile([record]);
    const second = profile([]);
    await initializeOperationStore(first, current);
    expect(getOperationRegistry().writeRestriction(record.wcRoot)?.operationId).toBe(record.operationId);
    await initializeOperationStore(second, current);
    const crossWindow = getOperationRegistry();
    expect(crossWindow.writeRestriction(record.wcRoot)?.kind).toBeUndefined();
    await crossWindow.withRecoveryLease(record.operationId, async () => {
      await crossWindow.finalizeOperation(record.operationId, 'done');
    });
    await initializeOperationStore(first, current);
    expect(await getOperationRegistry().loadAllRecords()).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
