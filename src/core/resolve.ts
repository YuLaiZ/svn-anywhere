/**
 * svn resolve 的参数、动作矩阵与回扫判定。core 模块，不依赖 vscode。
 *
 * 关键纪律（属性冲突处理与冲突解决回读契约，真实 svn 冲突场景实测回填）：
 * - `svn resolve` 固定路径级 `--depth empty --non-interactive`，绝不带
 *   infinity，也不波及同路径以外的冲突；
 * - `postpone` 不是 `svn resolve --accept` 合法值（E205000），只作为面板
 *   状态，不进入 CLI；
 * - 混合路径（同路径文本+属性/树）禁止把单个选择映射为路径级 `--accept`；
 * - 二进制 `--accept base` 会被 CLI 接受并恢复旧基线，必须应用层拒绝；
 * - 二进制冲突在 info 中仍是 type=text，动作矩阵必须由 contentKind 决定；
 * - `svn resolve` 对已解决/非冲突路径静默 exit 0、无输出，写命令前必须
 *   重读 info 指纹、命令后必须 status + info 联合回读，退出码不能证明成功。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readConflictRecord,
  parseConflictStatusXml,
  toWcRelativePath,
  type ConflictContentKind,
  type ConflictKind,
  type ConflictRecord,
  type ConflictRecordReadResult,
  type ConflictStatusScan,
} from './conflict';
import { SvnError, tailText } from './errors';
import type { ResolveIntent, ResolveIntentTarget } from './operations';
import { run, runOrThrow, type RunOptions, type RunResult } from './svnCli';
import { escapePeg } from './workspace';
// parseStatusXml 只用于回读时识别 missing/deleted/obstructed/incomplete 条目；
// 冲突判定仍走 conflict 的三判据投影。
import { parseStatusXml } from './status';

/** `svn resolve --accept` 的六个合法值（`svn help resolve` 枚举）。 */
export type SvnAcceptValue =
  | 'base'
  | 'working'
  | 'mine-conflict'
  | 'theirs-conflict'
  | 'mine-full'
  | 'theirs-full';

/** 冻结枚举：不包含 postpone（postpone 只改变面板状态，不写 SVN）。 */
export const SVN_ACCEPT_VALUES: readonly SvnAcceptValue[] = [
  'base',
  'working',
  'mine-conflict',
  'theirs-conflict',
  'mine-full',
  'theirs-full',
];

const TEXT_STRATEGIES: readonly SvnAcceptValue[] = [
  'base',
  'working',
  'mine-conflict',
  'theirs-conflict',
  'mine-full',
  'theirs-full',
];

const BINARY_STRATEGIES: readonly SvnAcceptValue[] = ['working', 'mine-full', 'theirs-full'];

/** 计划被拒绝的语义原因（文案由 host/i18n 提供）。 */
export type ResolveRejectReason =
  | 'invalid-accept'
  | 'postpone-not-cli'
  | 'mixed-path'
  | 'unknown-content'
  | 'binary-base'
  | 'binary-block-variant'
  | 'tree-invalid-strategy'
  | 'tree-requires-confirmation'
  | 'working-requires-confirmation'
  | 'property-not-applicable'
  | 'property-requires-selection'
  | 'property-values-unavailable'
  | 'property-auto-unsupported'
  | 'property-incomplete'
  | 'invalid-step'
  | 'conflict-not-found'
  | 'fingerprint-changed';

/** 属性冲突逐项选择：每个冲突属性选本地、基线或传入。 */
export interface PropertyChoice {
  name: string;
  choice: 'local' | 'base' | 'incoming';
}

export type ResolveSelection =
  | { kind: 'accept'; value: SvnAcceptValue }
  /** 人工处理后确认「采用当前工作内容」：working 策略必须二次确认。 */
  | { kind: 'working'; confirmed: boolean }
  | { kind: 'property'; choices: readonly PropertyChoice[] }
  /** 推迟：只改面板状态，不触发 SVN 写命令。 */
  | { kind: 'postpone' };

/**
 * 固定意图的单一权威定义在 core/operations（OperationRecord.resolveIntent
 * 的持久契约）；这里只重导出供既有调用方从 resolve 模块引用，不复制形状。
 */
export type { ResolveIntent, ResolveIntentTarget };

/** 单步执行计划；属性值只存在于运行期内存，不写操作记录。 */
export type ResolveStep =
  | { kind: 'propset'; relPath: string; name: string; value: Buffer }
  | { kind: 'propdel'; relPath: string; name: string }
  | { kind: 'resolve'; relPath: string; accept: SvnAcceptValue };

export type ResolvePlanResult =
  | { ok: true; steps: ResolveStep[] }
  | { ok: false; reason: ResolveRejectReason };

/** 面板动作集（能力矩阵的只读投影）。 */
export interface ConflictActionSet {
  /** 可直接执行的 --accept 值；working 出现时受 workingRequiresConfirmation 约束。 */
  strategies: SvnAcceptValue[];
  workingRequiresConfirmation: boolean;
  /** 属性冲突：需逐属性选择后统一 working。 */
  propertySelection: boolean;
  /** 树冲突：需先确认文件系统节点已处理。 */
  treeConfirmation: boolean;
  /** 无自动动作的原因；mixed/unknown/保留属性等只留下检查器与推迟。 */
  blocker?: ResolveRejectReason;
}

function hasKind(record: ConflictRecord, kind: ConflictKind): boolean {
  return record.kinds.includes(kind);
}

/**
 * 动作矩阵（属性冲突处理契约）：
 * - 纯文本：六种 --accept 值；working 走人工确认流程；
 * - 二进制：mine-full/theirs-full/working，禁用冲突块变体与 base；
 * - 纯属性：逐属性选择后 working（整值 accept 不开放）；
 * - 纯树：working（确认后）或推迟；
 * - 同路径混合：无自动动作（交 SVN 交互处理）；
 * - 类型未知：无自动动作，只回扫/检查器。
 */
export function availableResolveActions(
  record: ConflictRecord,
  contentKind: ConflictContentKind = record.contentKind,
): ConflictActionSet {
  const empty: ConflictActionSet = {
    strategies: [],
    workingRequiresConfirmation: false,
    propertySelection: false,
    treeConfirmation: false,
  };
  if (record.kinds.length > 1) {
    return { ...empty, blocker: 'mixed-path' };
  }
  if (hasKind(record, 'tree')) {
    return {
      ...empty,
      strategies: ['working'],
      workingRequiresConfirmation: true,
      treeConfirmation: true,
      blocker: record.treeConflict ? undefined : 'unknown-content',
    };
  }
  if (hasKind(record, 'property')) {
    const properties = record.propertyConflicts;
    if (!properties || properties.length === 0) {
      return { ...empty, blocker: 'property-values-unavailable' };
    }
    if (properties.some((property) => property.autoUnsupported)) {
      // 同路径含保留属性：working 会一次性清除全部属性冲突，不能部分自动处理。
      return { ...empty, blocker: 'property-auto-unsupported' };
    }
    return { ...empty, propertySelection: true };
  }
  if (contentKind === 'binary') {
    return {
      ...empty,
      strategies: [...BINARY_STRATEGIES],
      workingRequiresConfirmation: true,
    };
  }
  if (contentKind === 'text') {
    return {
      ...empty,
      strategies: [...TEXT_STRATEGIES],
      workingRequiresConfirmation: true,
    };
  }
  return { ...empty, blocker: 'unknown-content' };
}

/** 属性三值也参与策略：选择 base/incoming 时按存在性写回或删除属性。 */
function planPropertySelection(
  record: ConflictRecord,
  choices: readonly PropertyChoice[],
): ResolvePlanResult {
  const properties = record.propertyConflicts;
  if (!properties || properties.length === 0) {
    return { ok: false, reason: 'property-values-unavailable' };
  }
  if (properties.some((property) => property.autoUnsupported)) {
    return { ok: false, reason: 'property-auto-unsupported' };
  }
  const byName = new Map<string, PropertyChoice>();
  for (const choice of choices) {
    if (byName.has(choice.name)) {
      return { ok: false, reason: 'property-incomplete' };
    }
    byName.set(choice.name, choice);
  }
  // 全部冲突属性都必须有明确选择：working 会无条件清除该路径全部属性冲突。
  if (properties.some((property) => !byName.has(property.name))) {
    return { ok: false, reason: 'property-incomplete' };
  }
  if (choices.some((choice) => !properties.some((property) => property.name === choice.name))) {
    return { ok: false, reason: 'property-incomplete' };
  }
  const steps: ResolveStep[] = [];
  for (const property of [...properties].sort((a, b) => a.name.localeCompare(b.name))) {
    const choice = byName.get(property.name)!;
    if (choice.choice === 'local') {
      continue;
    }
    const value = choice.choice === 'base' ? property.base : property.incoming;
    if (value.exists) {
      steps.push({ kind: 'propset', relPath: record.path, name: property.name, value: value.value ?? Buffer.alloc(0) });
    } else {
      steps.push({ kind: 'propdel', relPath: record.path, name: property.name });
    }
  }
  steps.push({ kind: 'resolve', relPath: record.path, accept: 'working' });
  return { ok: true, steps };
}

/**
 * 生成执行计划（纯函数）：
 * - 混合路径拒绝一切单选择（包括 working），只能人工交互处理后回扫；
 * - postpone 不在 CLI 枚举，直接拒绝；
 * - 二进制 base / 冲突块变体、树冲突非 working、属性整值 accept 均拒绝；
 * - working 与树 confirmed 是二次确认语义的入口。
 */
export function planResolve(
  record: ConflictRecord,
  selection: ResolveSelection,
  contentKind: ConflictContentKind = record.contentKind,
): ResolvePlanResult {
  const actions = availableResolveActions(record, contentKind);
  if (selection.kind === 'postpone') {
    return { ok: false, reason: 'postpone-not-cli' };
  }
  if (actions.blocker === 'mixed-path' || actions.blocker === 'unknown-content') {
    return { ok: false, reason: actions.blocker };
  }
  if (hasKind(record, 'property')) {
    if (selection.kind !== 'property') {
      return { ok: false, reason: 'property-requires-selection' };
    }
    return planPropertySelection(record, selection.choices);
  }
  if (selection.kind === 'property') {
    return { ok: false, reason: 'property-not-applicable' };
  }
  if (hasKind(record, 'tree')) {
    if (selection.kind !== 'working') {
      return { ok: false, reason: 'tree-invalid-strategy' };
    }
    if (!selection.confirmed) {
      return { ok: false, reason: 'tree-requires-confirmation' };
    }
    return { ok: true, steps: [{ kind: 'resolve', relPath: record.path, accept: 'working' }] };
  }
  if (selection.kind === 'working') {
    if (!selection.confirmed) {
      return { ok: false, reason: 'working-requires-confirmation' };
    }
    return { ok: true, steps: [{ kind: 'resolve', relPath: record.path, accept: 'working' }] };
  }
  // accept 分支
  if (selection.value === 'working') {
    return { ok: false, reason: 'working-requires-confirmation' };
  }
  if (!SVN_ACCEPT_VALUES.includes(selection.value)) {
    return { ok: false, reason: 'invalid-accept' };
  }
  if (contentKind === 'binary') {
    if (selection.value === 'base') {
      return { ok: false, reason: 'binary-base' };
    }
    if (selection.value === 'mine-conflict' || selection.value === 'theirs-conflict') {
      return { ok: false, reason: 'binary-block-variant' };
    }
  }
  if (!actions.strategies.includes(selection.value)) {
    return { ok: false, reason: 'invalid-accept' };
  }
  return { ok: true, steps: [{ kind: 'resolve', relPath: record.path, accept: selection.value }] };
}

/**
 * 构造单步 svn 参数（固定路径级 --depth empty；propset 的值走临时文件，
 * 参数里不出现属性值）。`valueFilePath` 仅 propset 使用，供日志展示时
 * 使用真实临时路径。
 */
export function buildResolveArgs(step: ResolveStep, valueFilePath = '<value-file>'): string[] {
  switch (step.kind) {
    case 'propset':
      return ['propset', '-q', step.name, '-F', valueFilePath, '--', escapePeg(step.relPath)];
    case 'propdel':
      return ['propdel', '-q', step.name, '--', escapePeg(step.relPath)];
    case 'resolve':
      return ['resolve', '--non-interactive', '--accept', step.accept, '--depth', 'empty', '--', escapePeg(step.relPath)];
  }
}

export interface ResolveExecutionResult {
  ok: boolean;
  failedStep?: ResolveStep;
  error?: string;
}

/**
 * 按序执行计划步骤：属性写回先经临时文件精确写入（propset -F 原样保留
 * 尾随换行），最后统一路径级 working。任一步失败立即停止并返回失败步骤；
 * 属性值只在内存与临时文件中，不进入参数、日志与操作记录。
 */
export async function runResolveSteps(
  svnPath: string,
  wcRoot: string,
  steps: readonly ResolveStep[],
  options: RunOptions = {},
): Promise<ResolveExecutionResult> {
  for (const step of steps) {
    let tempDir: string | undefined;
    try {
      if (step.kind === 'propset') {
        tempDir = mkdtempSync(join(tmpdir(), 'svn-anywhere-resolve-'));
        const valueFile = join(tempDir, 'value');
        writeFileSync(valueFile, step.value);
        await runOrThrow(svnPath, buildResolveArgs(step, valueFile), { cwd: wcRoot, ...options });
      } else {
        await runOrThrow(svnPath, buildResolveArgs(step), { cwd: wcRoot, ...options });
      }
    } catch (err) {
      return {
        ok: false,
        failedStep: step,
        error: err instanceof SvnError ? err.message : err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }
  return { ok: true };
}

export type ResolveOutcome = 'resolved' | 'unresolved' | 'anomalous' | 'unknown';

export interface ResolveVerification {
  outcome: ResolveOutcome;
  /** unresolved 时为当前仍存在的冲突记录。 */
  record?: ConflictRecord;
  /** 回读到的 status item（诊断用；missing/deleted 异常判定依据）。 */
  statusItem?: string;
  detail?: string;
}

export interface VerifyResolveOptions extends RunOptions {
  /** 计划前的冲突类型：含 tree 时 deleted 条目是 working 的预期保留结果。 */
  previousKinds?: readonly ConflictKind[];
}

function errorMessage(err: unknown): string {
  return err instanceof SvnError ? err.message : err instanceof Error ? err.message : String(err);
}

/**
 * status 条目是否属于「路径状态异常」：即使 info 已无冲突节点也不能宣称
 * 已解决（status 出现 missing/deleted 等异常时不得宣称已解决）。
 * - missing（`!`）与 deleted（`D`）是外部删除路径的已知形态；
 * - obstructed（`~`）：版本化文件被同名非版本化节点（目录/文件）替换，
 *   svn resolve --accept working 后 info 仍 exit 0 且无 <conflict>，
 *   只看 info 会误判已解决（SVN 1.15 实测）；
 * - incomplete：遍历中断/未完成的条目，不能作为「已解决」证据；
 * - 树冲突 working 的预期结果可以是保留 D：previousKinds 含 tree 时
 *   deleted 不视为异常。
 */
export function isAnomalousResolveStatus(
  statusItem: string | undefined,
  previousKinds: readonly ConflictKind[] = [],
): boolean {
  if (statusItem === undefined) {
    return false;
  }
  if (statusItem === 'missing' || statusItem === 'obstructed' || statusItem === 'incomplete') {
    return true;
  }
  return statusItem === 'deleted' && !previousKinds.includes('tree');
}

/**
 * 命令后回读：status + info 联合判定。
 * - status 报 missing（`!`）、obstructed（`~`）、incomplete 或非树冲突场景
 *   的 deleted（`D`）→ anomalous：外部删除/替换路径后 info 仍 exit 0 且
 *   不返回冲突，只看 info 会误判已解决；
 * - status 三判据仍命中或 info 仍有冲突节点 → unresolved；
 * - info 回读失败或 status 整体失败 → unknown（不得凭退出码宣称成功）；
 * - 二者都明确清除才 resolved。
 */
export async function verifyResolveOutcome(
  svnPath: string,
  wcRoot: string,
  relPath: string,
  options: VerifyResolveOptions = {},
): Promise<ResolveVerification> {
  const { previousKinds, ...runOptions } = options;
  const target = toWcRelativePath(wcRoot, relPath);
  let statusResult: RunResult;
  try {
    statusResult = await run(svnPath, ['status', '--xml', '--ignore-externals', '--', escapePeg(relPath)], { cwd: wcRoot, ...runOptions });
  } catch (err) {
    return { outcome: 'unknown', detail: errorMessage(err) };
  }
  if (statusResult.exitCode !== 0) {
    return { outcome: 'unknown', detail: tailText(statusResult.stderr.trim() || `svn status exit code ${statusResult.exitCode}`) };
  }
  let scan: ConflictStatusScan;
  try {
    scan = parseConflictStatusXml(statusResult.stdout);
  } catch (err) {
    return { outcome: 'unknown', detail: errorMessage(err) };
  }
  const plain = parseStatusXml(statusResult.stdout);
  const statusEntry = plain.entries.find((entry) => toWcRelativePath(wcRoot, entry.path) === target);
  const stillConflicted = scan.entries.some((entry) => toWcRelativePath(wcRoot, entry.path) === target);

  const info = await readConflictRecord(svnPath, wcRoot, relPath, runOptions);
  if (info.error) {
    return { outcome: 'unknown', detail: info.error, statusItem: statusEntry?.wcStatus };
  }
  const statusItem = statusEntry?.wcStatus;
  if (isAnomalousResolveStatus(statusItem, previousKinds)) {
    return { outcome: 'anomalous', record: info.record, statusItem };
  }
  if (stillConflicted || info.record) {
    return { outcome: 'unresolved', record: info.record, statusItem };
  }
  return { outcome: 'resolved', statusItem };
}

export interface ExecuteResolveParams {
  /** 计划时的冲突记录（含指纹 id 与 kinds）。 */
  record: ConflictRecord;
  selection: ResolveSelection;
  contentKind?: ConflictContentKind;
  /**
   * 执行前重读的当前冲突记录（可选）。远端属性值需要认证时，宿主以与
   * 扫描同一口径（authorizeRemote 补录）重读并传入；提供时不再用无凭据
   * 选项重读——否则认证远端来源下属性名集合读取失败会让指纹误报变化。
   */
  preReadRecord?: ConflictRecord;
}

export interface ExecuteResolveResult {
  outcome: 'resolved' | 'unresolved' | 'anomalous' | 'unknown' | 'rejected';
  reason?: ResolveRejectReason;
  verification?: ResolveVerification;
  /** rejected（fingerprint-changed）时的当前记录。 */
  current?: ConflictRecord;
  error?: string;
}

/**
 * 单项 resolve 事务（不含 operation record 落盘，宿主负责 begin/finish）：
 * 1. 先按动作矩阵生成计划；被拒绝的选择不产生写命令；
 * 2. 写命令前重读 info 指纹：路径已无冲突（外部已解决/非冲突）或指纹
 *    变化时停止，不执行「静默 exit 0」的空动作；
 * 3. 按序执行后 status + info 回读，只有明确清除才返回 resolved。
 */
export async function executeResolve(
  svnPath: string,
  wcRoot: string,
  params: ExecuteResolveParams,
  options: RunOptions = {},
): Promise<ExecuteResolveResult> {
  const plan = planResolve(params.record, params.selection, params.contentKind);
  if (!plan.ok) {
    return { outcome: 'rejected', reason: plan.reason };
  }
  // 宿主已按扫描同口径（含远端认证补录）完成执行前重读时直接采用，
  // 不再用无凭据选项重读（认证远端来源的属性记录会因此误报指纹变化）。
  const pre: ConflictRecordReadResult = params.preReadRecord !== undefined
    ? { record: params.preReadRecord }
    : await readConflictRecord(svnPath, wcRoot, params.record.path, options);
  if (pre.error) {
    return { outcome: 'unknown', error: pre.error };
  }
  if (!pre.record) {
    return { outcome: 'rejected', reason: 'conflict-not-found' };
  }
  if (pre.record.id !== params.record.id) {
    return { outcome: 'rejected', reason: 'fingerprint-changed', current: pre.record };
  }
  const execution = await runResolveSteps(svnPath, wcRoot, plan.steps, options);
  const verification = await verifyResolveOutcome(svnPath, wcRoot, params.record.path, {
    ...options,
    previousKinds: params.record.kinds,
  });
  if (verification.outcome === 'resolved') {
    return { outcome: 'resolved', verification };
  }
  return { outcome: verification.outcome, verification, error: execution.error };
}
