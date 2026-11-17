/**
 * P6「更新到指定 revision」的写前检查、命令与回读。core 模块，不依赖 vscode。
 *
 * 边界（更新到指定 revision 契约，真实 svn update/冲突场景实测回填）：
 * - 只允许本地工作副本，且更新对象是当前路径在请求 revision 确实存在的
 *   节点；复制来源可以查看/导出，但不能把「更新新路径」解释为「切回来源
 *   路径」——目标在请求 revision 不存在（复制前）时阻止更新；
 * - 写前 `status --xml --ignore-externals` 阻止本地修改、属性修改、树冲突；
 *   external 内部改动不属于本副本更新范围；
 * - 固定意图 requestedRevision/preRevision/actual target，命令形态固定
 *   `svn update --non-interactive --ignore-externals -r <rev> -- <target>`
 *   （长任务不限时由调用方传入 timeoutMs）；
 * - 权威结果来自命令结束后的节点 info 回读与本次目标范围的冲突扫描；
 *   `parseUpdateOutput` 的 final revision 只作线索，不代替回读；
 * - 回读 revision 不等于请求 revision、节点身份变化或回读失败时保持
 *   unknown，不按预期值改写 BASE；未知回扫只有三种出口（仍未知/成功/冲突）。
 */
import { realpathSync, statSync } from 'node:fs';
import { join, relative as pathRelative } from 'node:path';
import {
  isAbsentInfoError,
  isUnderExternalBoundary,
  parseConflictStatusXml,
  parseNodeInfoXml,
  readNodeInfo,
  scanConflicts,
  summarizeConflicts,
  toWcRelativePath,
  type ConflictRecord,
  type ConflictStatusEntry,
  type ConflictSummary,
} from './conflict';
import { isAuthFailure, isNetworkFailure, SvnError, tailText } from './errors';
import type { HistoryUpdateIntent } from './operations';
import { run, runOrThrow, urlWithPeg, type RunOptions, type RunResult } from './svnCli';
import { parseStatusXml } from './status';
import { parseUpdateOutput } from './update';
import { escapePeg, findWorkingCopy } from './workspace';

/**
 * 固定意图的单一权威定义在 core/operations（OperationRecord.historyUpdateIntent
 * 的持久契约）；这里只重导出供既有调用方从本模块引用。
 */
export type { HistoryUpdateIntent };

/**
 * 命令输出初解析线索（复用 `core/update.ts` 的
 * `parseUpdateOutput`）。final revision 与冲突路径只用于结果页提示与
 * 交叉核对，**不参与** `decideOutcome` 的权威判定——权威类型、版本与
 * 辅助文件仍来自命令结束后的 status/info 归一化回读。
 */
export interface HistoryUpdateOutputHint {
  /** 命令输出的最终 revision（`Updated to revision N` / `At revision N`）。 */
  finalRevision?: number;
  /** 命令输出中的冲突路径（明细 C 行/树冲突行），用于与回读冲突集合交叉核对。 */
  conflicts: string[];
}

/** 更新结果对象（P6/P7 共用）。 */
export interface HistoryUpdateResult {
  targetRelPath: string;
  requestedRevision: number;
  preRevision: number;
  /** 权威回读的节点 BASE；读不到时缺省。 */
  postNodeRevision?: number;
  outcome: 'updated' | 'conflict' | 'unknown';
  /** 本次更新目标范围内的冲突记录（不是整副本扫描）。 */
  conflicts: ConflictRecord[];
  conflictSummary: ConflictSummary;
  /** 权威回读失败/不一致的原因（读不到时缺省）。 */
  readbackError?: string;
  /** 命令级失败（退出码非零/超时/进程错误）；结论仍以回读为准。 */
  commandError?: string;
  /**
   * 命令输出初解析线索；进程级失败（没有命令结果）时缺省。仅提示与
   * 交叉核对，不参与三态结算。
   */
  outputHint?: HistoryUpdateOutputHint;
}

/**
 * P6→P7 更新任务上下文：从 P6 更新任务进入 P7 时随
 * openConflictPanel(source='update') 内存传递，面板顶部展示更新目标、
 * 请求 revision、更新前 BASE 与回读节点 BASE。只承载展示事实，冲突集合
 * 始终由 P7 对真实 SVN 重新扫描，不从本对象伪造。
 */
export interface HistoryUpdateTaskContext {
  targetRelPath: string;
  targetKind: 'file' | 'dir';
  requestedRevision: number;
  /** 更新开始前已确认的节点 BASE（旧 BASE）。 */
  preRevision: number;
  /** 权威回读的节点 BASE（回读不可用时缺省）。 */
  postNodeRevision?: number;
  outcome: 'updated' | 'conflict' | 'unknown';
  conflictCount: number;
  readbackError?: string;
}

/** P7 收到的外部 taskContext 形状校验（未知来源一律拒绝，不猜测）。 */
export function isHistoryUpdateTaskContext(value: unknown): value is HistoryUpdateTaskContext {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.targetRelPath !== 'string'
    || (record.targetKind !== 'file' && record.targetKind !== 'dir')
    || !Number.isSafeInteger(record.requestedRevision)
    || (record.requestedRevision as number) <= 0
    || !Number.isSafeInteger(record.preRevision)
    || (record.preRevision as number) <= 0
    || (record.outcome !== 'updated' && record.outcome !== 'conflict' && record.outcome !== 'unknown')
    || !Number.isSafeInteger(record.conflictCount)
    || (record.conflictCount as number) < 0) {
    return false;
  }
  if (record.postNodeRevision !== undefined
    && (!Number.isSafeInteger(record.postNodeRevision) || (record.postNodeRevision as number) <= 0)) {
    return false;
  }
  if (record.readbackError !== undefined && typeof record.readbackError !== 'string') {
    return false;
  }
  return true;
}

/** 写前检查/准备失败原因（文案由 host/i18n 提供）。 */
export type HistoryUpdateBlockReason =
  | 'invalid-revision'
  | 'missing-local'
  | 'not-versioned'
  | 'not-in-working-copy'
  | 'nested-working-copy'
  | 'local-modifications'
  | 'target-absent-at-revision'
  | 'kind-mismatch'
  | 'info-error';

export interface LocalUpdateTargetCheck {
  ok: boolean;
  reason?: HistoryUpdateBlockReason;
  /** 本地目标的绝对路径（存在时）。 */
  absolutePath?: string;
  kind?: 'file' | 'dir';
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isPathInside(parent: string, child: string): boolean {
  const rel = pathRelative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

/**
 * 本地目标存在性检查：路径必须存在且属于目标工作副本本身。
 * 嵌套工作副本（findWorkingCopy 返回更内层根）不并入外层副本的更新范围。
 */
export function checkLocalUpdateTarget(wcRoot: string, relPath: string): LocalUpdateTargetCheck {
  const absolute = join(wcRoot, ...relPath.split('/'));
  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    return { ok: false, reason: 'missing-local' };
  }
  const kind = stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : undefined;
  if (!kind) {
    return { ok: false, reason: 'missing-local' };
  }
  const owningRoot = findWorkingCopy(absolute);
  if (!owningRoot) {
    return { ok: false, reason: 'not-versioned' };
  }
  const owning = safeRealpath(owningRoot);
  const root = safeRealpath(wcRoot);
  if (owning !== root) {
    return { ok: false, reason: isPathInside(root, owning) ? 'nested-working-copy' : 'not-in-working-copy' };
  }
  return { ok: true, absolutePath: absolute, kind };
}

export type HistoryUpdatePrepareResult =
  | { ok: true; intent: HistoryUpdateIntent }
  | {
      ok: false;
      reason: HistoryUpdateBlockReason;
      /**
       * 原始命令输出或系统错误文本（stderr / spawn 错误等），仅供诊断
       * detail 透传；面向用户的文案由宿主按 reason 映射 i18n 模板，
       * core 不返回叙述性的中文句子。
       */
      message?: string;
    };

function classifyInfoFailure(stderr: string): HistoryUpdateBlockReason {
  if (/E155007|E155010|E200009|W155010|W155007/.test(stderr)) {
    return 'not-versioned';
  }
  return 'info-error';
}

/**
 * 组装固定意图：本地存在性 + 节点 info（URL/kind/BASE revision）一次读取，
 * 失败时不产生可以发出写命令的意图。requestedRevision 必须是数字正整数
 * （HEAD 在调用前已解析为具体数字；不做第二次 HEAD 读取）。
 */
export async function prepareHistoryUpdate(
  svnPath: string,
  wcRoot: string,
  relPath: string,
  requestedRevision: number,
  options: RunOptions = {},
): Promise<HistoryUpdatePrepareResult> {
  if (!Number.isSafeInteger(requestedRevision) || requestedRevision <= 0) {
    return { ok: false, reason: 'invalid-revision' };
  }
  const local = checkLocalUpdateTarget(wcRoot, relPath);
  if (!local.ok) {
    return { ok: false, reason: local.reason! };
  }
  let info: Awaited<ReturnType<typeof readNodeInfo>>;
  try {
    info = await readNodeInfo(svnPath, relPath, { cwd: wcRoot, ...options });
  } catch (err) {
    return { ok: false, reason: 'info-error', message: errorMessage(err) };
  }
  if (!info.summary) {
    return {
      ok: false,
      reason: classifyInfoFailure(info.result.stderr),
      // 只透传必要原始输出；为空时由宿主按 reason 呈现文案。
      message: info.result.stderr.trim() === '' ? undefined : tailText(info.result.stderr.trim()),
    };
  }
  const infoKind = info.summary.kind === 'file' || info.summary.kind === 'dir' ? info.summary.kind : local.kind!;
  if (local.kind !== infoKind) {
    return { ok: false, reason: 'kind-mismatch' };
  }
  if (!info.summary.url) {
    return { ok: false, reason: 'info-error' };
  }
  if (info.summary.revision === undefined) {
    return { ok: false, reason: 'not-versioned' };
  }
  return {
    ok: true,
    intent: {
      wcRoot: safeRealpath(wcRoot),
      targetRelPath: relPath.replace(/^\.\//, ''),
      targetKind: infoKind,
      targetUrl: info.summary.url,
      requestedRevision,
      preRevision: info.summary.revision,
    },
  };
}

/** 本地修改/冲突阻断集合（写前检查第 1 项）。 */
const BLOCKING_STATUS_ITEMS = new Set(['modified', 'added', 'deleted', 'missing', 'replaced', 'conflicted']);

export interface HistoryUpdateBlockingEntry {
  path: string;
  wcStatus: string;
  props?: string;
}

export interface HistoryUpdatePreconditionResult {
  ok: boolean;
  reason?: HistoryUpdateBlockReason;
  /** reason='local-modifications' 时的阻断条目。 */
  blocking?: HistoryUpdateBlockingEntry[];
  /**
   * 原始命令输出或系统错误文本（stderr / spawn 错误等），仅供诊断
   * detail 透传；面向用户的文案由宿主按 reason 映射 i18n 模板，
   * core 不返回叙述性的中文句子。
   */
  message?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 复制前更新禁用：请求 revision 在该路径当前 URL 下不存在（含 pre-copy）
 * 时阻止；认证/权限/网络错误不进入 absent 判定（不冒充路径缺失）。
 *
 * 远端 info 必须经 runOrThrow 统一补录原语：调用方注入 getCredentials 时，
 * 首次执行的认证失败（E170001/E215004）会补录凭据并重试一次，重试结果与
 * 单次执行走同一套分类；不得用裸 run 绕过补录。
 */
async function checkTargetAtRevision(
  svnPath: string,
  intent: HistoryUpdateIntent,
  options: RunOptions,
): Promise<HistoryUpdatePreconditionResult> {
  const url = urlWithPeg(intent.targetUrl, intent.requestedRevision);
  let stdout: string;
  try {
    stdout = (await runOrThrow(svnPath, ['info', '--xml', '--non-interactive', '--', url], options)).stdout;
  } catch (err) {
    if (err instanceof SvnError) {
      const stderr = err.stderr;
      if (isAuthFailure(stderr) || isNetworkFailure(stderr)) {
        return { ok: false, reason: 'info-error', message: tailText(stderr) };
      }
      if (isAbsentInfoError(stderr)) {
        return { ok: false, reason: 'target-absent-at-revision', message: tailText(stderr) };
      }
      return { ok: false, reason: 'info-error', message: tailText(stderr) };
    }
    return { ok: false, reason: 'info-error', message: errorMessage(err) };
  }
  const summary = parseNodeInfoXml(stdout);
  if (!summary || !summary.path) {
    return { ok: false, reason: 'target-absent-at-revision' };
  }
  if (summary.kind !== 'unknown' && summary.kind !== intent.targetKind) {
    return { ok: false, reason: 'kind-mismatch' };
  }
  return { ok: true };
}

/**
 * 写前检查：
 * 1. 目标节点在请求 revision 存在（复制前更新禁用）；
 * 2. `status --xml --ignore-externals` 检查目标及目录范围：本地
 *    modified/added/deleted/missing/replaced/conflicted、属性修改或树冲突
 *    时阻止；external 内部改动不属于本副本更新范围（边界防御过滤）。
 * status 遍历失败（exit 非零 / XML 截断）按 info-error 阻止，不解析残片。
 */
export async function checkHistoryUpdatePreconditions(
  svnPath: string,
  intent: HistoryUpdateIntent,
  options: RunOptions = {},
): Promise<HistoryUpdatePreconditionResult> {
  const target = await checkTargetAtRevision(svnPath, intent, options);
  if (!target.ok) {
    return target;
  }
  const statusArgs = ['status', '--xml', '--ignore-externals', '--', escapePeg(intent.targetRelPath)];
  let statusResult: RunResult;
  try {
    statusResult = await run(svnPath, statusArgs, { cwd: intent.wcRoot, ...options });
  } catch (err) {
    return { ok: false, reason: 'info-error', message: errorMessage(err) };
  }
  if (statusResult.exitCode !== 0) {
    return {
      ok: false,
      reason: 'info-error',
      message: statusResult.stderr.trim() === '' ? undefined : tailText(statusResult.stderr.trim()),
    };
  }
  const parsed = parseStatusXml(statusResult.stdout);
  const blocking: HistoryUpdateBlockingEntry[] = [];
  const blockingKeys = new Set<string>();
  const addBlocking = (path: string, wcStatus: string, props?: string) => {
    const key = toWcRelativePath(intent.wcRoot, path);
    if (blockingKeys.has(key)) {
      return;
    }
    blockingKeys.add(key);
    blocking.push({ path, wcStatus, props });
  };
  for (const entry of parsed.entries) {
    if (isUnderExternalBoundary(entry.path, parsed.externals)) {
      continue;
    }
    if (BLOCKING_STATUS_ITEMS.has(entry.wcStatus) || entry.props === 'modified' || entry.props === 'conflicted') {
      addBlocking(entry.path, entry.wcStatus, entry.props);
    }
  }
  let treeEntries: ConflictStatusEntry[] = [];
  try {
    treeEntries = parseConflictStatusXml(statusResult.stdout).entries.filter((entry) => entry.treeConflicted);
  } catch {
    // XML 遍历中断（status 输出被截断）：不能解析残片，按 info-error 阻止。
    return { ok: false, reason: 'info-error' };
  }
  for (const entry of treeEntries) {
    addBlocking(entry.path, entry.item, entry.props);
  }
  if (blocking.length > 0) {
    return { ok: false, reason: 'local-modifications', blocking };
  }
  return { ok: true };
}

/**
 * 固定的 update 命令形态：`--non-interactive --ignore-externals -r <rev>
 * -- <target>`；不复用会覆盖 external 的普通 update 参数。
 */
export function buildHistoryUpdateArgs(intent: HistoryUpdateIntent): string[] {
  return [
    'update',
    '--non-interactive',
    '--ignore-externals',
    '-r',
    String(intent.requestedRevision),
    '--',
    escapePeg(intent.targetRelPath),
  ];
}

function sameUrl(a: string, b: string): boolean {
  const normalize = (url: string) => (url.endsWith('/') ? url.slice(0, -1) : url);
  return normalize(a) === normalize(b);
}

export interface HistoryUpdateReadback {
  /** info 与本次范围冲突扫描都成功。 */
  ok: boolean;
  postNodeRevision?: number;
  nodeUrl?: string;
  nodeKind?: 'file' | 'dir' | 'unknown';
  /** 本次目标范围内的冲突（不是整副本）。 */
  conflicts: ConflictRecord[];
  conflictSummary: ConflictSummary;
  readbackError?: string;
}

/**
 * 权威回读：节点 info（BASE revision / URL / kind）+ 本次更新目标范围冲突。
 * 单次 info 失败或范围扫描失败都记录 readbackError；调用方据此保持 unknown。
 */
export async function readHistoryUpdateReadback(
  svnPath: string,
  intent: HistoryUpdateIntent,
  options: RunOptions = {},
): Promise<HistoryUpdateReadback> {
  let info: Awaited<ReturnType<typeof readNodeInfo>>;
  try {
    info = await readNodeInfo(svnPath, intent.targetRelPath, { cwd: intent.wcRoot, ...options });
  } catch (err) {
    // 进程级失败（找不到 svn、超时等）：info 与范围扫描都不可读，保持未知。
    return {
      ok: false,
      conflicts: [],
      conflictSummary: summarizeConflicts([]),
      readbackError: errorMessage(err),
    };
  }
  let readbackError: string | undefined;
  let postNodeRevision: number | undefined;
  let nodeUrl: string | undefined;
  let nodeKind: 'file' | 'dir' | 'unknown' = 'unknown';
  if (!info.summary) {
    // 只透传必要原始输出；stderr 为空时给出机器可读的最简诊断，
    // 不返回面向用户的叙述性文案（宿主按语义状态映射 i18n）。
    readbackError = info.result.stderr.trim() === ''
      ? `svn info exit code ${info.result.exitCode}`
      : tailText(info.result.stderr.trim());
  } else {
    postNodeRevision = info.summary.revision;
    nodeUrl = info.summary.url;
    nodeKind = info.summary.kind;
  }
  let conflicts: ConflictRecord[] = [];
  let conflictSummary: ConflictSummary = summarizeConflicts([]);
  try {
    const scan = await scanConflicts(svnPath, intent.wcRoot, { ...options, scope: intent.targetRelPath });
    conflicts = scan.records;
    conflictSummary = scan.summary;
  } catch (err) {
    readbackError = readbackError ?? errorMessage(err);
  }
  return {
    ok: readbackError === undefined,
    postNodeRevision,
    nodeUrl,
    nodeKind,
    conflicts,
    conflictSummary,
    readbackError,
  };
}

function decideOutcome(
  intent: HistoryUpdateIntent,
  commandError: string | undefined,
  readback: HistoryUpdateReadback,
): 'updated' | 'conflict' | 'unknown' {
  // 进程失败/超时/取消/非零退出：不按请求 revision 改写 BASE，保持未知。
  if (commandError !== undefined) {
    return 'unknown';
  }
  if (!readback.ok) {
    return 'unknown';
  }
  if (readback.nodeUrl !== undefined && !sameUrl(readback.nodeUrl, intent.targetUrl)) {
    return 'unknown';
  }
  if (readback.nodeKind !== 'unknown' && readback.nodeKind !== intent.targetKind) {
    return 'unknown';
  }
  // 无冲突且回读 revision 等于请求 revision 才结算成功；不一致（如外部
  // SVN 客户端并发写入）保持未知。
  if (readback.postNodeRevision !== intent.requestedRevision) {
    return 'unknown';
  }
  return readback.conflicts.length > 0 ? 'conflict' : 'updated';
}

export interface HistoryUpdateRunOptions extends RunOptions {
  /**
   * 命令超时。默认 0（不限时：长任务可关面板但不取消）；
   * 宿主若显式传入则覆盖。
   */
  timeoutMs?: number;
}

/**
 * 执行 history-update：固定参数规则 → 命令（默认不限时）→ 权威回读 →
 * 三态结算。命令退出码不是结论；回读事实全部进入结果（含 unknown）。
 * operation record 的 begin/finish 由宿主负责，本函数不落盘。
 */
export async function runHistoryUpdate(
  svnPath: string,
  intent: HistoryUpdateIntent,
  options: HistoryUpdateRunOptions = {},
): Promise<HistoryUpdateResult> {
  const args = buildHistoryUpdateArgs(intent);
  let commandError: string | undefined;
  let outputHint: HistoryUpdateOutputHint | undefined;
  try {
    const result = await run(svnPath, args, { cwd: intent.wcRoot, timeoutMs: 0, ...options });
    // 命令输出线索复用 parseUpdateOutput 初解析；只作
    // 结果页提示与交叉核对，不参与 decideOutcome（权威结论仍来自回读）。
    const parsed = parseUpdateOutput(result.stdout);
    outputHint = {
      ...(parsed.finalRevision !== undefined ? { finalRevision: parsed.finalRevision } : {}),
      conflicts: parsed.conflicts,
    };
    if (result.exitCode !== 0) {
      // 只透传必要原始输出；stderr 为空时给出机器可读的最简诊断，
      // 不返回面向用户的叙述性文案（宿主按语义状态映射 i18n）。
      commandError = result.stderr.trim() === ''
        ? `svn update exit code ${result.exitCode}`
        : tailText(result.stderr.trim());
    }
  } catch (err) {
    commandError = errorMessage(err);
  }
  const readback = await readHistoryUpdateReadback(svnPath, intent, options);
  return {
    targetRelPath: intent.targetRelPath,
    requestedRevision: intent.requestedRevision,
    preRevision: intent.preRevision,
    postNodeRevision: readback.postNodeRevision,
    outcome: decideOutcome(intent, commandError, readback),
    conflicts: readback.conflicts,
    conflictSummary: readback.conflictSummary,
    readbackError: readback.readbackError,
    commandError,
    ...(outputHint !== undefined ? { outputHint } : {}),
  };
}

export interface HistoryUpdateRescan {
  outcome: 'still-unknown' | 'updated' | 'conflict';
  postNodeRevision?: number;
  conflicts: ConflictRecord[];
  conflictSummary: ConflictSummary;
  readbackError?: string;
}

/**
 * 未知回扫三出口：只读同一更新范围；
 * - info/范围扫描失败、身份不符、revision 不是请求值 → still-unknown；
 * - 回读请求 revision 且无冲突 → updated；
 * - 回读请求 revision 且有冲突 → conflict。
 * 取得明确且一致的证据后宿主才 finalizeOperation。
 */
export async function rescanHistoryUpdate(
  svnPath: string,
  intent: HistoryUpdateIntent,
  options: RunOptions = {},
): Promise<HistoryUpdateRescan> {
  const readback = await readHistoryUpdateReadback(svnPath, intent, options);
  const facts = {
    postNodeRevision: readback.postNodeRevision,
    conflicts: readback.conflicts,
    conflictSummary: readback.conflictSummary,
    readbackError: readback.readbackError,
  };
  if (!readback.ok) {
    return { outcome: 'still-unknown', ...facts };
  }
  if (readback.nodeUrl !== undefined && !sameUrl(readback.nodeUrl, intent.targetUrl)) {
    return { outcome: 'still-unknown', ...facts };
  }
  if (readback.nodeKind !== 'unknown' && readback.nodeKind !== intent.targetKind) {
    return { outcome: 'still-unknown', ...facts };
  }
  if (readback.postNodeRevision !== intent.requestedRevision) {
    return { outcome: 'still-unknown', ...facts };
  }
  return { outcome: readback.conflicts.length > 0 ? 'conflict' : 'updated', ...facts };
}
