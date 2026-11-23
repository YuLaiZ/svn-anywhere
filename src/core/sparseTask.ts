import type { OperationRecord, OperationRegistry } from './operations';
import { observeSparseStep, sparseStepArgs, type SparsePlan } from './sparse';
import { runOrThrow, type RunOptions } from './svnCli';

export type SparseTaskResult =
  | { kind: 'done'; count: number }
  | { kind: 'unknown'; message: string }
  | { kind: 'notRun'; message: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function beginSparseTask(
  registry: OperationRegistry, svn: string, wcRoot: string, plan: SparsePlan,
  recheck: () => Promise<SparsePlan>, options: RunOptions,
): Promise<SparseTaskResult> {
  if (!plan.intent.steps.length) return { kind: 'notRun', message: '没有待应用的深度调整' };
  const begin = await registry.begin({
    wcRoot, targetRelPath: '.', nodeKind: 'dir', kind: 'depth-edit', depthIntent: plan.intent,
  });
  if (!begin.ok) return { kind: 'notRun', message: '此工作副本已有操作正在执行或需要回扫' };
  let fresh: SparsePlan;
  try {
    fresh = await recheck();
  } catch (error) {
    await registry.finish(begin.operationId);
    return { kind: 'notRun', message: message(error) };
  }
  if (fresh.fingerprint !== plan.fingerprint) {
    await registry.finish(begin.operationId);
    return { kind: 'notRun', message: '已检测到目录状态变化，请刷新并重新预览' };
  }
  return runSparseTask(registry, svn, begin.record, options);
}

export async function runSparseTask(
  registry: OperationRegistry, svn: string, record: OperationRecord, options: RunOptions,
): Promise<SparseTaskResult> {
  const { operationId, depthIntent: intent } = record;
  if (!intent) return { kind: 'unknown', message: '未找到深度操作的原始计划' };
  let verified = record.depthProgress?.verified ?? 0;
  for (let index = verified; index < intent.steps.length; index++) {
    const step = intent.steps[index];
    let dispatched = false;
    try {
      const before = await observeSparseStep(svn, step, intent.revision, options, true);
      if (before !== 'unchanged') throw new Error('写入前目标已变化：' + step.path);
      const sending = await registry.markPhase(operationId, 'running', {
        depthProgress: { verified, dispatching: index },
      });
      if (!sending.ok) throw new Error('无法登记深度操作的派发状态');
      dispatched = true;
      await runOrThrow(svn, sparseStepArgs(step, intent.revision), {
        ...options, cwd: record.wcRoot, getCredentials: undefined, retryReadOnly: undefined,
      });
      const after = await observeSparseStep(svn, step, intent.revision, options);
      if (after !== 'applied') throw new Error('命令结束后未能核实目标深度：' + step.path);
      const verifiedStep = await registry.markPhase(operationId, 'running', {
        depthProgress: { verified: index + 1 },
      });
      if (!verifiedStep.ok) throw new Error('无法保存深度操作的回读结果');
      verified = index + 1;
    } catch (error) {
      const phase = dispatched ? 'unknown' : 'residue-pending';
      const progress = dispatched ? { verified, dispatching: index } : { verified };
      await registry.markPhase(operationId, phase, { depthProgress: progress });
      return { kind: dispatched ? 'unknown' : 'notRun', message: message(error) };
    }
  }
  await registry.finalizeOperation(operationId, 'done');
  return { kind: 'done', count: verified };
}

export async function verifySparseTask(
  registry: OperationRegistry, svn: string, record: OperationRecord, options: RunOptions,
): Promise<'applied' | 'unchanged' | 'unknown' | 'done'> {
  const outcome = await registry.withRecoveryLease(record.operationId, async (latest) => {
    const intent = latest.depthIntent;
    const progress = latest.depthProgress;
    const pending = progress?.dispatching;
    if (!intent || pending === undefined || !intent.steps[pending] || pending !== progress?.verified) return 'unknown';
    const observed = await observeSparseStep(svn, intent.steps[pending], intent.revision, options).catch(() => 'unknown' as const);
    if (observed === 'unknown') return 'unknown';
    const verified = observed === 'applied' ? pending + 1 : pending;
    if (verified === intent.steps.length) {
      await registry.finalizeOperation(record.operationId, 'done', { depthProgress: { verified } });
      return 'done';
    }
    const stored = await registry.markPhase(record.operationId, 'residue-pending', { depthProgress: { verified } });
    return stored.ok ? observed : 'unknown';
  });
  return outcome ?? 'unknown';
}
