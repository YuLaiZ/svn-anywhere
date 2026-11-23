import { existsSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OperationRegistry, type OperationRecord } from '../src/core/operations';
import { planSparseChanges, readSparseListing, readSparseSnapshot, sparseStepArgs } from '../src/core/sparse';
import { beginSparseTask, runSparseTask, verifySparseTask } from '../src/core/sparseTask';
import { createSvnLab, writeFile } from './helpers';

const lab = createSvnLab('svn-anywhere-sparse-');
let base: string;

beforeAll(() => {
  const seed = lab.checkout('seed');
  writeFile(seed, 'versions/V2.1.8/交付@包/app.war', 'r1', true);
  writeFile(seed, 'versions/归档/app.war', 'r1', true);
  writeFile(seed, 'versions/说明.txt', 'r1', true);
  lab.svn(['commit', '-m', 'r1'], seed);
  base = lab.svn(['info', '--show-item', 'revision', lab.repoUrl]).trim();
  writeFile(seed, 'versions/V2.1.8/交付@包/app.war', 'r2');
  writeFile(seed, 'versions/V2.1.9/heavy.war', 'r2', true);
  lab.svn(['commit', '-m', 'r2'], seed);
});
afterAll(() => lab.cleanup());

function oldCheckout(name: string): string {
  const wc = lab.checkout(name);
  lab.svn(['update', '-r', base], wc);
  return wc;
}

describe('P8 在真实 SVN 副本执行', () => {
  it('保留旧版本后，普通更新继续跳过远端同级新目录', async () => {
    const wc = oldCheckout('keep');
    const scope = join(wc, 'versions');
    const kept = join(scope, 'V2.1.8');
    const snapshot = await readSparseSnapshot('svn', scope, {});
    const plan = planSparseChanges(snapshot, new Map([[kept, 'infinity']]), true, wc);
    expect(plan.intent.steps.map((step) => step.depth)).toEqual(['files', 'infinity']);
    expect(plan.impacts[0].removed).toContain(kept);
    const outcome = await beginSparseTask(new OperationRegistry(), 'svn', wc, plan, async () => plan, {});
    expect(outcome).toEqual({ kind: 'done', count: 2 });
    lab.svn(['update'], wc);
    expect(existsSync(join(scope, 'V2.1.9'))).toBe(false);
    expect(existsSync(join(scope, '归档'))).toBe(false);
    expect(existsSync(join(kept, '交付@包', 'app.war'))).toBe(true);
    expect(existsSync(join(scope, '说明.txt'))).toBe(true);
  });

  it('先取目录本身再排除新目录，父目录深度维持 infinity', async () => {
    const wc = oldCheckout('exclude');
    const scope = join(wc, 'versions');
    const target = join(scope, 'V2.1.9');
    const initial = await readSparseListing('svn', scope, {});
    expect(initial.nodes.get(target)?.depth).toBeNull();
    const snapshot = await readSparseSnapshot('svn', scope, {});
    const plan = planSparseChanges(snapshot, new Map([[target, 'exclude']]), false, wc);
    expect(plan.intent.steps.map((step) => step.depth)).toEqual(['empty', 'exclude']);
    expect(plan.impacts[0].added).toEqual([target]);
    const outcome = await beginSparseTask(new OperationRegistry(), 'svn', wc, plan, async () => plan, {});
    expect(outcome).toEqual({ kind: 'done', count: 2 });
    const listing = await readSparseListing('svn', scope, {});
    expect(listing.root.depth).toBe('infinity');
    expect(listing.nodes.get(target)?.depth).toBe('exclude');
    lab.svn(['update'], wc);
    expect(existsSync(target)).toBe(false);
  });

  it('受保留目录中的被忽略文件也阻止临时移除', async () => {
    const wc = oldCheckout('ignored');
    const scope = join(wc, 'versions');
    const kept = join(scope, 'V2.1.8');
    lab.svn(['update'], wc);
    lab.svn(['propset', 'svn:ignore', '*.tmp', kept], wc);
    lab.svn(['commit', '-m', 'ignore fixture', kept], wc);
    writeFileSync(join(kept, 'private.tmp'), 'work');
    const snapshot = await readSparseSnapshot('svn', scope, {});
    expect(snapshot.protectedPaths.has(join(kept, 'private.tmp'))).toBe(true);
    expect(() => planSparseChanges(snapshot, new Map([[kept, 'infinity']]), true, wc)).toThrow('本地改动');
  });

  it('回扫已生效步骤后，只继续执行剩余排除', async () => {
    const wc = oldCheckout('resume');
    const scope = join(wc, 'versions');
    const target = join(scope, 'V2.1.9');
    const snapshot = await readSparseSnapshot('svn', scope, {});
    const plan = planSparseChanges(snapshot, new Map([[target, 'exclude']]), false, wc);
    const registry = new OperationRegistry();
    const begin = await registry.begin({ wcRoot: wc, targetRelPath: '.', nodeKind: 'dir', kind: 'depth-edit', depthIntent: plan.intent });
    if (!begin.ok) throw new Error('无法开始测试操作');
    await registry.markPhase(begin.operationId, 'running', { depthProgress: { verified: 0, dispatching: 0 } });
    lab.svn(sparseStepArgs(plan.intent.steps[0], plan.intent.revision), wc);
    expect(existsSync(join(target, 'heavy.war'))).toBe(false);
    const state = await registry.markPhase(begin.operationId, 'unknown');
    expect(state.ok).toBe(true);
    expect(await verifySparseTask(registry, 'svn', (state as { record: OperationRecord }).record, {})).toBe('applied');
    const resume = await registry.beginResume(begin.operationId, wc);
    if (!resume.ok) throw new Error('无法恢复测试操作');
    expect(resume.record.depthProgress?.verified).toBe(1);
    expect(await runSparseTask(registry, 'svn', resume.record, {})).toEqual({ kind: 'done', count: 2 });
  });

  it('子进程 cwd 为目标祖先时，目录列表仍按绝对路径加载', async () => {
    const wc = oldCheckout('cwd-ancestor');
    const scope = join(wc, 'versions');
    // 扩展宿主 cwd 为 `/`，或调用方把 cwd 设为目标父目录：svn info 对 cwd 之下的绝对目标
    // 回相对 cwd 的路径，列表与快照必须仍可加载，节点身份保持绝对路径。
    for (const cwd of ['/', dirname(scope)]) {
      const listing = await readSparseListing('svn', scope, { cwd });
      expect(listing.root.path).toBe(scope);
      expect(listing.root.depth).toBe('infinity');
      expect(listing.nodes.has(join(scope, 'V2.1.9'))).toBe(true);
      expect([...listing.nodes.keys()].every((path) => isAbsolute(path) && (path === scope || path.startsWith(scope + sep)))).toBe(true);
      expect([...listing.nodes.keys()].every((path) => listing.nodes.get(path)?.path === path)).toBe(true);
    }
    const snapshot = await readSparseSnapshot('svn', scope, { cwd: '/' });
    expect(snapshot.root.path).toBe(scope);
    expect(snapshot.protectedPaths.size).toBe(0);
    expect([...snapshot.remote.keys()].every((path) => isAbsolute(path))).toBe(true);
    const plan = planSparseChanges(snapshot, new Map([[join(scope, 'V2.1.9'), 'exclude']]), false, wc);
    expect(plan.intent.steps.map((step) => step.depth)).toEqual(['empty', 'exclude']);
    const outcome = await beginSparseTask(new OperationRegistry(), 'svn', wc, plan, async () => plan, { cwd: '/' });
    expect(outcome).toEqual({ kind: 'done', count: 2 });
    expect(existsSync(join(scope, 'V2.1.9', 'heavy.war'))).toBe(false);
  });
});
