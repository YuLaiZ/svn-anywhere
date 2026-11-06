/**
 * 导入任务执行器（M3 技术方案 §2.1 任务模型、§2.2 操作记录扩展与快照
 * 生命周期、§4.3 ② 执行期认证「先补录、后查远端」四态、§5 导入执行与
 * 结果未知核实）。
 *
 * 执行器与面板会话生命周期解耦（与 checkoutTask 同款形态）：任务对象
 * 创建后由本模块推进状态机（connecting → running → canceling →
 * success/failed/unknown）并结算，面板（后续任务接入）经注入回调感知进度
 * 与出口、经返回的 done promise 等待终态。取消动作复用 checkoutTask 的
 * cancelCheckoutTask（任务对象的 phase 与 AbortSignal 是注册表通用字段，
 * 导入任务同样仅 running 放行）。本模块不直接 import vscode：认证弹窗经
 * 注入回调，快照目录经 setImportSnapshotDir（activate 挂 globalStorageUri）
 * 或调用参数注入，输出频道经 host/output（无窗口 UI）。
 *
 * 时序硬约束（§2.2 快照段/§5 执行段）：
 * - 快照写入时点 = 第三次源快照比对与远端重检全部通过后（由调用方完成，
 *   本函数假定通过——失败出口由调用方走预命令出口）、紧邻 begin：此前的
 *   早退不产生待清理文件；写失败清理半成品、不发起 begin；
 * - begin 的任何失败（busy/idConflict/写失败）一律经统一删除 helper 删
 *   快照（同源目录占用反复尝试不累积无主文件）后走预命令出口；
 * - begin 成功 → onParentIdentityConsumed（面板清 review.parentIdentity）
 *   → svn import（timeoutMs=0、AbortSignal 取消、目标 URL 原样不 peg、
 *   Adding 前缀流式计数）→ 成功路径先过证据检查三分类再落终态；
 * - 记录终态收口（§2.2 清单）：done 与 failed-unconfirmed（解除限制语义）
 *   随即 finish 移除并删快照；unknown（含 merged）未终态保留、快照保留。
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { escapeUrlPeg, schemeAcceptsCredentials } from '../../core/checkout';
import { SvnError, extractSvnErrorCodes, isAuthFailure } from '../../core/errors';
import {
  buildImportArgs,
  decodePathSegments,
  messageDigest,
  parseImportLogXml,
  removeMessageTempDir,
  serializeSnapshot,
  snapshotDigest,
  verifyImportOutcome,
  writeMessageTempFile,
  type ImportSnapshot,
  type ImportVerifyOutcome,
  type ImportVerifyReason,
  type ParentIdentitySnapshot,
} from '../../core/importDir';
import {
  getOperationRegistry,
  kindOf,
  randomOperationId,
  type BeginResult,
  type OperationRecord,
} from '../../core/operations';
import { runOrThrow, type AuthCredentials, type RunOptions } from '../../core/svnCli';
import { readSvnPath, readTimeoutMs } from '../config';
import { strings } from '../i18n';
import { createLineBuffer, decodingRunOptions, logCommand } from '../output';
import { beginReadonlyVerify, clearReadonlyVerify, writeSessionResult } from '../sessionResults';
import { addTask, removeTask, type CheckoutResultScope, type TaskObject } from '../taskRegistry';
import { saveDraft, type CheckoutFormDraft } from './drafts';
import type { PreCommandExit } from './checkoutTask';

/* ---------------------------------------------------------------------------
 * 快照目录注入（globalStorageUri.fsPath；activate 挂载，测试/驱动注入可覆盖）
 * ------------------------------------------------------------------------- */

let hostSnapshotDir: string | undefined;

/** activate 时注入快照落盘目录（context.globalStorageUri?.fsPath）；传 undefined 卸载。 */
export function setImportSnapshotDir(dir: string | undefined): void {
  hostSnapshotDir = dir;
}

function resolveSnapshotDir(override?: string): string | undefined {
  return override ?? hostSnapshotDir;
}

/** 快照文件名形态：文件名即 operationId（op- 前缀 + 时间戳/随机段，无扩展名）——与孤儿快照清理的识别形态一致。 */
function snapshotFilePath(dir: string, operationId: string): string {
  return join(dir, operationId);
}

/** 写入完成时记录的文件归属指纹（idConflict 删快照的归属校验——不匹配即跳过删除，不误删同 ID 既有记录的快照）。 */
interface SnapshotOwnership {
  mtimeMs: number;
  size: number;
}

type SnapshotWriteResult =
  | { ok: true; ownership: SnapshotOwnership }
  | { ok: false; message: string };

/**
 * 快照文件落盘（半写清理）：先建目录再整体写入；写失败删除半成品文件
 * （不留无主文件），返回可读原因（调用方按快照写失败的预命令出口呈现）。
 */
async function writeSnapshotFile(
  dir: string | undefined,
  operationId: string,
  snapshot: ImportSnapshot,
): Promise<SnapshotWriteResult> {
  if (!dir) {
    return { ok: false, message: strings.importTask.snapshotDirMissing };
  }
  const filePath = snapshotFilePath(dir, operationId);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, serializeSnapshot(snapshot), 'utf8');
    const stats = await stat(filePath);
    return { ok: true, ownership: { mtimeMs: stats.mtimeMs, size: stats.size } };
  } catch (err) {
    await rm(filePath, { force: true }).catch(() => undefined);
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 快照删除统一 helper（§2.2 快照生命周期：直接失败/证据 done/核实两结论/
 * acknowledge/abandon/begin 失败各出口共用）。带归属指纹时先比对目标文件
 * 的 mtime/size——不是本次任务写入的那份即跳过（idConflict 分支防误删同
 * ID 既有记录的核实证据）；删除失败静默（孤儿快照清理兜底回收）。
 */
export async function deleteImportSnapshot(
  operationId: string,
  dir: string | undefined,
  ownership?: SnapshotOwnership,
): Promise<boolean> {
  if (!dir) {
    return false;
  }
  const filePath = snapshotFilePath(dir, operationId);
  try {
    if (ownership) {
      const stats = await stat(filePath);
      if (stats.mtimeMs !== ownership.mtimeMs || stats.size !== ownership.size) {
        return false;
      }
    }
    await rm(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------------
 * 流式进度解析（字节层行缓冲，形态对齐 checkoutTask；导入仅 Adding 前缀、
 * 尾行为 Committed revision N.）
 * ------------------------------------------------------------------------- */

/** 字节层行缓冲：按 0x0A 分行（多字节字符不含 0x0A，按字节拆行不截断），跨块拼出完整行。 */
class ByteLineBuffer {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const lines: Buffer[] = [];
    for (;;) {
      const idx = this.pending.indexOf(0x0a);
      if (idx < 0) {
        return lines;
      }
      lines.push(this.pending.subarray(0, idx));
      this.pending = this.pending.subarray(idx + 1);
    }
  }

  flush(): Buffer | null {
    if (this.pending.length === 0) {
      return null;
    }
    const rest = this.pending;
    this.pending = Buffer.alloc(0);
    return rest;
  }
}

/** 展示用宽松解码：UTF-8 非法字节替换为 U+FFFD，不做编码回退链。 */
function lenientUtf8(line: Buffer): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(line);
}

/** 字节层前缀匹配（前缀为 ASCII 字节，直接比对原始字节，不依赖行内容解码）。 */
function startsWithBytes(line: Buffer, prefix: string): boolean {
  const prefixBuf = Buffer.from(prefix, 'utf8');
  return line.subarray(0, prefixBuf.length).equals(prefixBuf);
}

/** svn 1.15 实测导入条目前缀：`Adding `（文件与目录都是条目，计数语义是「项」）。 */
export const IMPORT_ENTRY_PREFIX = 'Adding ';

/** 命令尾行：`Committed revision N.`。 */
const IMPORT_TAIL_REVISION_RE = /^Committed revision (\d+)\.$/;

/** 流式进度的累计状态（「已发送 N 项」文案与当前路径的数据源）。 */
export interface ImportProgressState {
  count: number;
  currentFile: string | null;
  /** 尾行捕获的提交 revision（未出现为 null；exit 0 仍为 null 即回显不可识别形态）。 */
  revision: number | null;
}

/**
 * 导入的流式进度解析器：`Adding ` 前缀计数（字节层，不依赖解码）、当前
 * 路径宽松 UTF-8 解码显示、`Committed revision N.` 尾行捕获；未识别行
 * （`Transmitting file data ...` 进度点、阶段行等）不计数、交日志回调。
 */
export class ImportProgressParser {
  readonly state: ImportProgressState = { count: 0, currentFile: null, revision: null };
  private readonly buffer = new ByteLineBuffer();

  constructor(
    private readonly onUnknownLine: (text: string) => void,
    private readonly onProgress?: (state: ImportProgressState) => void,
  ) {}

  feed(chunk: Buffer): void {
    for (const line of this.buffer.push(chunk)) {
      this.handleLine(line);
    }
  }

  finish(): void {
    const tail = this.buffer.flush();
    if (tail) {
      this.handleLine(tail);
    }
  }

  private handleLine(line: Buffer): void {
    if (startsWithBytes(line, IMPORT_ENTRY_PREFIX)) {
      this.state.count += 1;
      this.state.currentFile = lenientUtf8(line.subarray(Buffer.from(IMPORT_ENTRY_PREFIX, 'utf8').length)).trim();
      this.onProgress?.(this.state);
      return;
    }
    const text = lenientUtf8(line);
    if (IMPORT_TAIL_REVISION_RE.test(text)) {
      this.state.revision = Number(IMPORT_TAIL_REVISION_RE.exec(text)?.[1]);
      return;
    }
    this.onUnknownLine(text);
  }
}

/* ---------------------------------------------------------------------------
 * 执行器对外类型（结果页与出口回调接口）
 * ------------------------------------------------------------------------- */

/** 导入结果页的表单快照（retryImport/abandonUnknownImport 回填数据源；§4.1 result import formSnapshot）。 */
export interface ImportFormSnapshot {
  url: string;
  sourceDir: string;
  message: string;
  nameMode: 'auto' | 'manual';
}

/**
 * 导入任务的结果页（§4.1 result 判别联合 import 分支中由执行器产生的
 * 子集；settled 形态由控制器在 acknowledge 收口后置位，不在执行器）。
 * targetUrl 是成功/结论页的目标 URL 数据源（handoff 与共用 URL 历史），
 * 面板模型侧不消费该字段，由控制器接线时读取。
 */
export interface ImportResultPage {
  mode: 'import';
  kind: 'success' | 'failed' | 'unknown' | 'merged';
  revision?: number;
  /** 源目录路径（结果页 path 字段 = 任务的 targetPath）。 */
  path: string;
  detail?: string;
  /** kind='success'/'failed' 的结论来源：命令直接结束 / unknown 核实转结论。 */
  evidence?: 'command' | 'verified';
  /** 仅 kind='unknown' 合法（核实不唯一的唯一结论）。 */
  resolution?: 'unresolved';
  /** kind='failed'/'unknown' 页的表单快照（merged/success 页不设）。 */
  formSnapshot?: ImportFormSnapshot;
  /** 仅 kind='unknown' 合法：核实第 0 步快照不完整（abandonUnknownImport 的判定载体）。 */
  snapshotIncomplete?: true;
  /** 目标 URL（成功与 merged 页携带；模型外数据源）。 */
  targetUrl?: string;
}

/** startImportTask 的 done 结算：终态或预命令出口。 */
export type ImportTaskOutcome =
  | { outcome: 'finished'; result: ImportResultPage }
  | { outcome: 'preCommandExit'; exit: PreCommandExit };

/** 面板注入的出口回调集合（面板控制器后续接入；全部可选）。 */
export interface ImportTaskCallbacks {
  /**
   * 执行期认证补录弹窗（宿主注入；仅 http/https/svn 注入——svn+ssh/file
   * 不注入，认证类失败按普通失败呈现）。回调内按 §4.3 ②「先补录、后查
   * 远端」四态判定（E200009 才带凭据重试）。
   */
  getCredentials?: () => Promise<AuthCredentials | undefined>;
  /** begin 成功且记录落盘后、紧邻写命令发出前清除面板 review.parentIdentity（身份归面板持有）。 */
  onParentIdentityConsumed?: () => void;
  /** 流式进度（Adding 条目计数与当前路径）；渲染节流由面板完成。 */
  onProgress?: (state: ImportProgressState) => void;
  /** 未识别行日志（不计数；面板任务日志视图可用）。 */
  onLogLine?: (text: string) => void;
  /** 预命令终止出口通知（面板 busy 恢复、回 review 页口径）。 */
  onPreCommandExit?: (exit: PreCommandExit) => void;
  /**
   * 成功结算（成功路径证据检查结论①与核实 committed 两个时点触发）：
   * 控制器据此把目标 URL 写入检出/导入共用的 URL 历史并刷新会话 history。
   */
  onSucceeded?: (info: { revision: number; targetUrl: string }) => void;
}

/** startImportTask 的输入：任务固定参数一次捕获（第三次源快照比对与远端重检已由调用方完成）。 */
export interface StartImportTaskInput {
  /** 测试注入用；缺省读配置 svnPath。 */
  svnPath?: string;
  /** 快照落盘目录（缺省用 activate 挂载的 globalStorageUri.fsPath）。 */
  snapshotDir?: string;
  /** 源目录绝对路径（realpath 规范化：lockKey 与记录 targetPath 同值）。 */
  sourceDir: string;
  /** 目标新目录完整 URL（编码形态、原样传入 import——不 peg 追加）。 */
  targetUrl: string;
  /** 父目录身份快照（重检刷新后的 lastChangedRevision 随 begin 定格为锚点）。 */
  parentIdentity: ParentIdentitySnapshot;
  /** 提交说明原文（begin 时一次写入 importIntent.message）。 */
  message: string;
  /** 目标 URL 命名模式（begin 时一次写入 importIntent.nameMode）。 */
  nameMode: 'auto' | 'manual';
  /** 第三次源快照比对使用的快照数据（落盘与 digest 的唯一来源，不重新枚举）。 */
  snapshot: ImportSnapshot;
  /** 打开入口键（= 源目录 realpath；resultScope 与草稿键的基准）。 */
  entryKey: string;
  initiatorSessionId: string;
  /** 任务创建时捕获的全部表单字段快照（预命令出口草稿写回的数据源）。 */
  formSnapshot?: CheckoutFormDraft;
  callbacks?: ImportTaskCallbacks;
}

export interface StartedImportTask {
  taskId: string;
  /** 任务终态结果页或预命令出口（发起面板 await 它完成 result/review 转移）。 */
  done: Promise<ImportTaskOutcome>;
}

/** verifyImportTask 的输入。 */
export interface VerifyImportTaskInput {
  svnPath?: string;
  snapshotDir?: string;
  /** unknown 导入记录的 operationId（核实对象）。 */
  operationId: string;
  /** 只读命令进行中登记的作用域与代次（发起时捕获，由调用方传入）。 */
  resultScope: CheckoutResultScope;
  epoch: number;
  callbacks?: Pick<ImportTaskCallbacks, 'getCredentials' | 'onSucceeded'>;
}

/**
 * verifyImportTask 的核实结论：三分类 + 记录收口是否执行（记录校验不过即
 * 跳过收口、结论照常返回）+ 结论页构造数据（formSnapshot/targetUrl——
 * 控制器按代次守卫写缓存，本函数不做 UI）。
 */
export type ImportVerifyTaskResult = {
  conclusion: 'committed' | 'notCommitted' | 'unknown';
  /** committed：确认的 revision；notCommitted：无；unknown：无。 */
  revision?: number;
  /** notCommitted 的证据（§5 第 1 步三项全过的父目录锚点）；unknown 可为空。 */
  evidence?: { parentLastChangedRevision: number };
  /** unknown 的原因（含 snapshotIncomplete 与记录不可用形态）。 */
  reason?: ImportVerifyReason | 'recordUnavailable';
  message?: string;
  /** 仅 unknown：核实第 0 步快照不完整（结果页 snapshotIncomplete 的判定载体）。 */
  snapshotIncomplete?: boolean;
  /** 结论页构造数据：从 importIntent/targetPath 派生的表单快照。 */
  formSnapshot?: ImportFormSnapshot;
  /** 目标 URL（handoff 与共用 URL 历史的数据源）。 */
  targetUrl?: string;
  /** 记录收口是否真正执行（false = 校验不过跳过，如核实进行中已 acknowledge）。 */
  recordSettled: boolean;
};

/* ---------------------------------------------------------------------------
 * 任务对象与结算
 * ------------------------------------------------------------------------- */

interface ImportTaskExtra {
  callbacks: ImportTaskCallbacks;
  resolveDone: (outcome: ImportTaskOutcome) => void;
  done: Promise<ImportTaskOutcome>;
  /** 快照目录与归属指纹（begin 失败删快照的归属校验数据）。 */
  snapshotDir: string | undefined;
  snapshotOwnership: SnapshotOwnership | undefined;
}

/** 本模块的任务对象形态：extra 收窄为必填（注册表类型不因此改动）。 */
type ImportTask = TaskObject<ImportTaskExtra> & { extra: ImportTaskExtra };

function createImportTask(
  taskId: string,
  lockKey: string,
  resultScope: CheckoutResultScope,
  initiatorSessionId: string,
  formSnapshot: CheckoutFormDraft | undefined,
  callbacks: ImportTaskCallbacks,
  snapshotDir: string | undefined,
): ImportTask {
  let resolveDone!: (outcome: ImportTaskOutcome) => void;
  const done = new Promise<ImportTaskOutcome>((resolve) => {
    resolveDone = resolve;
  });
  return {
    taskId,
    // P3 检出/导入共用面板类别：注册表与结果缓存都以 'checkout' 键控。
    panelKind: 'checkout',
    phase: 'connecting',
    resultScope,
    lockKey,
    formSnapshot,
    initiatorSessionId,
    abortController: new AbortController(),
    extra: { callbacks, resolveDone, done, snapshotDir, snapshotOwnership: undefined },
  };
}

/**
 * 预命令终止出口的统一收口（§2.1 完整出口枚举，枚举类型复用 checkoutTask
 * 的 PreCommandExit——sourceChanged/targetChanged/confirmAborted 位供面板
 * 控制器在 startImportTask 之前的流程出口使用）：先把任务创建时捕获的
 * formSnapshot 写回草稿、再 removeTask（出口顺序与任务终态「先写缓存、
 * 再移除任务」同款）、不写会话缓存、不产生 result；最后通知出口回调
 * （面板 busy 恢复/回 review）。
 */
function preCommandExit(task: ImportTask, exit: PreCommandExit): void {
  // 任务创建时 resultScope 恒为 import 模式的 P3 作用域（收窄供草稿键使用）。
  const scope = task.resultScope as CheckoutResultScope;
  const form = task.formSnapshot as CheckoutFormDraft | undefined;
  if (form) {
    saveDraft(scope.entryKey, scope.mode, form);
  }
  removeTask(task.taskId);
  task.extra.callbacks.onPreCommandExit?.(exit);
  task.extra.resolveDone({ outcome: 'preCommandExit', exit });
}

/**
 * 任务终态结算（§2.1 结算顺序）：记录侧收口与快照删除已由调用方完成，
 * 此处同步完成「先 writeSessionResult(executor)、再 removeTask」——同一
 * 同步步骤内无 await，重开面板不会落在两步之间；随后 resolve 发起面板
 * await 的 done。
 */
function settleFinalResult(task: ImportTask, page: ImportResultPage): void {
  writeSessionResult('checkout', task.resultScope, page, 'executor');
  removeTask(task.taskId);
  task.extra.resolveDone({ outcome: 'finished', result: page });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 快照摘要（§4.1 口径：fileCount/totalBytes 只计 file|symlink 且非 ignored 的条目）。 */
function summaryOfSnapshot(snapshot: ImportSnapshot): { fileCount: number; totalBytes: number } {
  let fileCount = 0;
  let totalBytes = 0;
  for (const entry of snapshot.entries) {
    if ((entry.kind === 'file' || entry.kind === 'symlink') && !entry.ignored) {
      fileCount += 1;
      totalBytes += entry.size;
    }
  }
  return { fileCount, totalBytes };
}

/** 导入结果页的表单快照（从任务固定参数/记录派生——直接失败与 unknown 页的数据源）。 */
function formSnapshotOf(input: StartImportTaskInput): ImportFormSnapshot {
  return { url: input.targetUrl, sourceDir: input.sourceDir, message: input.message, nameMode: input.nameMode };
}

/* ---------------------------------------------------------------------------
 * 发起导入任务（§5 执行段）
 * ------------------------------------------------------------------------- */

/**
 * 发起导入任务：同步创建任务对象（connecting）注册 taskRegistry 并返回
 * taskId 与终态 promise，执行流（快照落盘 → begin → import → 证据检查 →
 * 结算）后台推进——面板发起后立即可渲染进度页、取消与订阅任务移除通知。
 * 第三次源快照比对与远端重检由调用方在调用前完成（失败出口由调用方走
 * 预命令出口，本函数假定通过）。
 */
export function startImportTask(input: StartImportTaskInput): StartedImportTask {
  const svnPath = input.svnPath ?? readSvnPath();
  const lockKey = input.sourceDir;
  const resultScope: CheckoutResultScope = { entryKey: input.entryKey, mode: 'import' };
  // 预生成 operationId（begin 沿用、快照文件名同源）；与既有记录的撞车由
  // 执行流在快照落盘前做可用性前置检查（§2.2）。
  const taskId = randomOperationId();
  const task = createImportTask(
    taskId, lockKey, resultScope, input.initiatorSessionId, input.formSnapshot, input.callbacks ?? {},
    resolveSnapshotDir(input.snapshotDir),
  );
  addTask(task);
  void runImportFlow(task, input, svnPath);
  return { taskId, done: task.extra.done };
}

/**
 * 导入执行流（§2.2/§5 时序硬约束）：快照落盘（半写清理）→ begin 落盘
 * （importIntent 全字段经参数面一次写入）→ 清除面板 parentIdentity →
 * import 执行（流式 + 认证四态）→ 终态结算。任何意外异常按 unknown 收口
 * （不能证明提交结果即冻结核实，不悬挂任务对象）。
 */
async function runImportFlow(task: ImportTask, input: StartImportTaskInput, svnPath: string): Promise<void> {
  const registry = getOperationRegistry();
  const { extra } = task;
  // 每次任务开始时重置四态判定外带值：防止上一次任务认证补录的结论
  // 残留到本次任务的失败文案（本次未发生认证失败时标注应为空）。
  lastLsProbe = undefined;
  try {
    // ③ 快照落盘：紧邻 begin（前置检查的早退不产生待清理文件）；对
    // operationId 做可用性前置检查（全量记录含终态，撞车即换 ID 重查，
    // 任务 ID 同步更新保持「任务 ID = operationId」）。
    let operationId = task.taskId;
    for (;;) {
      const existing = await registry.loadAllRecords();
      if (!existing.some((record) => record.operationId === operationId)) {
        break;
      }
      operationId = randomOperationId();
    }
    task.taskId = operationId;
    const digest = snapshotDigest(input.snapshot);
    const written = await writeSnapshotFile(extra.snapshotDir, operationId, input.snapshot);
    if (!written.ok) {
      // 快照写失败（含半写，已清理）：不发起 begin，按预命令出口收口。
      preCommandExit(task, { kind: 'snapshotWriteFailed', message: written.message });
      return;
    }
    extra.snapshotOwnership = written.ownership;

    // ④ begin 落盘：kind/lockKey 与 importIntent 全字段一次写入（此后不可变；
    // 目标 URL 由 importIntent.targetUrl 唯一承载，不设顶层 url）。
    let begin: BeginResult;
    try {
      begin = await registry.begin({
        wcRoot: task.lockKey,
        targetRelPath: '.',
        nodeKind: 'dir',
        kind: 'import',
        lockKey: task.lockKey,
        operationId,
        targetPath: input.sourceDir,
        importIntent: {
          targetUrl: input.targetUrl,
          parentIdentity: input.parentIdentity,
          message: input.message,
          nameMode: input.nameMode,
          messageHash: messageDigest(input.message),
          startedAt: Date.now(),
          summary: summaryOfSnapshot(input.snapshot),
          snapshotDigest: digest,
          fileRefs: operationId,
        },
      });
    } catch (err) {
      // 写盘失败：删快照（统一 helper）后按预命令出口收口。
      await deleteImportSnapshot(operationId, extra.snapshotDir, extra.snapshotOwnership);
      preCommandExit(task, { kind: 'beginWriteFailed', message: errorMessage(err) });
      return;
    }
    if (!begin.ok) {
      // begin 的任何失败（busy/idConflict）都删快照——同源目录占用反复
      // 尝试不累积无主文件；idConflict 分支的删除经归属校验防误删。
      await deleteImportSnapshot(operationId, extra.snapshotDir, extra.snapshotOwnership);
      preCommandExit(
        task,
        begin.reason === 'busy' ? { kind: 'beginBusy', heldBy: begin.heldBy } : { kind: 'beginIdConflict' },
      );
      return;
    }

    // ⑤ begin 成功 → 清除面板 review.parentIdentity（身份已随记录落盘定格；
    // 失败保留供同页重试的口径在 begin 之前，此处已过该时点）。
    extra.callbacks.onParentIdentityConsumed?.();

    // ⑥ svn import 执行：说明临时文件 + 目标 URL 原样（不 peg 追加）、
    // timeoutMs=0（长任务不设超时，取消只靠 AbortSignal）、流式 Adding 计数。
    const messageTemp = writeMessageTempFile(input.message);
    const args = buildImportArgs(input.targetUrl, input.sourceDir, messageTemp.messageFile);
    const parser = new ImportProgressParser(
      (text) => extra.callbacks.onLogLine?.(text),
      (state) => extra.callbacks.onProgress?.(state),
    );
    const outputBuffer = createLineBuffer(undefined, 'import');
    const runOptions: RunOptions = {
      timeoutMs: 0,
      signal: task.abortController.signal,
      onStdoutChunk: (chunk) => parser.feed(chunk),
      onOutput: (text) => outputBuffer.push(text),
      onExit: logCommand(svnPath, args, undefined, 'import'),
      onCredentialRetry: (retryArgs) => logCommand(svnPath, retryArgs, undefined, 'import'),
      ...decodingRunOptions('import'),
    };
    const getCredentials = importCredentialProvider(svnPath, input.targetUrl, extra.callbacks);
    if (getCredentials) {
      runOptions.getCredentials = getCredentials;
    }
    // 进程已 spawn 即视为命令已发出（§2.1 映射表）：task 与记录转 running。
    task.phase = 'running';
    const runPromise = runOrThrow(svnPath, args, runOptions).then(
      () => undefined as unknown,
      (err: unknown) => err as unknown,
    );
    await registry.markPhase(operationId, 'running');
    const err = await runPromise;
    parser.finish();
    removeMessageTempDir(messageTemp.tempDir);
    await settleImportOutcome(task, operationId, err, parser, input, svnPath);
  } catch (err) {
    // 防御收口：流程意外异常不能证明提交结果——记录转 unknown（可能尚未
    // begin 或已收口，markPhase missing 时跳过）、任务对象不悬挂、done 必定结算。
    await getOperationRegistry().markPhase(task.taskId, 'unknown').catch(() => undefined);
    settleFinalResult(task, {
      mode: 'import',
      kind: 'unknown',
      path: input.sourceDir,
      resolution: 'unresolved',
      detail: errorMessage(err),
      formSnapshot: formSnapshotOf(input),
    });
  }
}

/* ---------------------------------------------------------------------------
 * 命令结果出口分发（§2.2 import 出口与 §5 证据检查三分类）
 * ------------------------------------------------------------------------- */

/** svn 明确拒绝、事务未建成的错误码白名单（其余失败保守按结果未知处理）。 */
const PROVEN_UNCOMMITTED_CODES: ReadonlySet<string> = new Set([
  'E160020', // 目标内已有同名文件（File already exists）——实测事务未提交。
  'E160016', // 父路径不是目录。
  'E200009', // 目标/父目录不存在。
  'E145000', // 不可导入节点类型（枚举预检已拦，防御）。
]);

/**
 * 直接失败的「可证明未提交」判定：svn 明确拒绝发生在事务建立前（认证
 * 拒绝、同名冲突、父路径形态错误、svn 可执行缺失——进程从未启动）；
 * 网络中断/超时/进程异常等无法区分「已提交但响应未回」的形态一律按
 * 结果未知（unknown）处理，不冒充失败结论。
 */
function provenUncommitted(err: unknown): boolean {
  if (!(err instanceof SvnError)) {
    return false;
  }
  if (err.code === 'SPAWN_ERROR' || err.code === 'ENOENT') {
    return true;
  }
  if (isAuthFailure(err.stderr)) {
    return true;
  }
  const codes = extractSvnErrorCodes(err.stderr);
  return codes.some((code) => PROVEN_UNCOMMITTED_CODES.has(code));
}

/**
 * 成功路径证据检查（§5：解析到 Committed revision 后、标记 done 前的轻量
 * 检查）：`svn info --show-item relative-url` + `svn log -r R --xml -v`，
 * 复用 unknown 核实第 2 步的 changed paths 归一化口径（前缀两侧逐段解码）
 * 判定目标根 action。三分类：added / missingRoot（证据命令成功但目标根
 * 非 A 或不在 changed paths——合并形态）/ unavailable（证据命令失败或
 * 无法解析——证据不可得，不断言合并）。证据命令与导入本体同 timeoutMs=0。
 */
async function evidenceCheckImportRoot(
  svnPath: string,
  targetUrl: string,
  revision: number,
  callbacks: ImportTaskCallbacks,
): Promise<{ kind: 'added' | 'missingRoot' | 'unavailable'; message?: string }> {
  const baseOptions: RunOptions = { timeoutMs: 0, ...decodingRunOptions('import') };
  if (schemeAcceptsCredentials(targetUrl) && callbacks.getCredentials) {
    baseOptions.getCredentials = callbacks.getCredentials;
  }
  let relativeUrl: string;
  try {
    const result = await runOrThrow(
      svnPath,
      ['info', '--show-item', 'relative-url', '--non-interactive', '--', escapeUrlPeg(targetUrl)],
      baseOptions,
    );
    relativeUrl = result.stdout.trim();
  } catch (err) {
    return { kind: 'unavailable', message: errorMessage(err) };
  }
  if (!relativeUrl.startsWith('^/')) {
    return { kind: 'unavailable', message: `目标 relative-url 形态异常：${relativeUrl}` };
  }
  let logXml: string;
  try {
    const result = await runOrThrow(
      svnPath,
      ['log', '-r', String(revision), '--xml', '-v', '--non-interactive', '--', escapeUrlPeg(targetUrl)],
      baseOptions,
    );
    logXml = result.stdout;
  } catch (err) {
    return { kind: 'unavailable', message: errorMessage(err) };
  }
  const entry = parseImportLogXml(logXml);
  if (!entry) {
    // log 成功返回但无 logentry：目标在该 revision 无变更（不在 changed
    // paths 的形态）——按证据成功处理，落 merged 分类。
    return { kind: 'missingRoot' };
  }
  if (entry.revision !== revision) {
    return { kind: 'unavailable', message: `svn log 返回的 revision ${entry.revision} 与提交 revision ${revision} 不一致` };
  }
  const prefix = decodePathSegments(relativeUrl.slice(1)).replace(/^\//, '');
  let rootAction = '';
  for (const changed of entry.paths) {
    const decoded = decodePathSegments(changed.path.replace(/^\//, ''));
    if (decoded === prefix) {
      rootAction = changed.action;
      break;
    }
  }
  return rootAction === 'A' ? { kind: 'added' } : { kind: 'missingRoot' };
}

/**
 * 命令结束后的终态结算：
 * - exit 0 + Committed revision 尾行 → 成功路径证据检查三分类：
 *   ① 目标根 A → done（finalizeOperation 移除）+ 快照删除 + 成功页 +
 *      onSucceeded（URL 历史回调）；
 *   ② 目标根非 A/缺失 → unknown + outcome='merged'/resolvedRevision 同一
 *      markPhase 落盘（未终态保留、快照保留、merged 页呈现）；
 *   ③ 证据不可得 → unknown 不写 outcome（普通 unknown 页「无法读取仓库
 *      证据，请核实」）；
 * - exit 0 无 Committed revision 尾行 → 同转 unknown（回显不可识别不冒充成功）；
 * - 取消/进程异常/失联 → unknown 冻结（证据不可得形态）；
 * - 直接失败且可证明未提交 → failed-unconfirmed + finish 移除 + 快照删除
 *   + 失败页（formSnapshot 携带，出口⑦）。
 */
async function settleImportOutcome(
  task: ImportTask,
  operationId: string,
  err: unknown,
  parser: ImportProgressParser,
  input: StartImportTaskInput,
  svnPath: string,
): Promise<void> {
  const registry = getOperationRegistry();
  const formSnapshot = formSnapshotOf(input);
  if (err === undefined) {
    const revision = parser.state.revision;
    if (revision === null) {
      await registry.markPhase(operationId, 'unknown');
      settleFinalResult(task, {
        mode: 'import',
        kind: 'unknown',
        path: input.sourceDir,
        resolution: 'unresolved',
        detail: strings.importTask.noRevisionTail,
        formSnapshot,
        targetUrl: input.targetUrl,
      });
      return;
    }
    const evidence = await evidenceCheckImportRoot(
      svnPath, input.targetUrl, revision, task.extra.callbacks,
    );
    if (evidence.kind === 'added') {
      // ① 目标根 A → done 终态收口（出口④）：finish 移除 + 快照删除。
      await registry.finalizeOperation(operationId, 'done');
      await deleteImportSnapshot(operationId, task.extra.snapshotDir);
      task.extra.callbacks.onSucceeded?.({ revision, targetUrl: input.targetUrl });
      settleFinalResult(task, {
        mode: 'import',
        kind: 'success',
        revision,
        path: input.sourceDir,
        evidence: 'command',
        targetUrl: input.targetUrl,
      });
      return;
    }
    if (evidence.kind === 'missingRoot') {
      // ② 目标根非 A/缺失：unknown + outcome='merged'（含 resolvedRevision，
      // 同一 markPhase 落盘）——未终态保留至核实/acknowledge，快照保留。
      await registry.markPhase(operationId, 'unknown', { outcome: 'merged', resolvedRevision: revision });
      settleFinalResult(task, {
        mode: 'import',
        kind: 'merged',
        revision,
        path: input.sourceDir,
        detail: strings.importTask.mergedDetail,
        targetUrl: input.targetUrl,
      });
      return;
    }
    // ③ 证据不可得：同转 unknown 但不写 outcome（不断言合并）。
    await registry.markPhase(operationId, 'unknown');
    settleFinalResult(task, {
      mode: 'import',
      kind: 'unknown',
      path: input.sourceDir,
      resolution: 'unresolved',
      detail: strings.importTask.evidenceUnavailable,
      formSnapshot,
      targetUrl: input.targetUrl,
    });
    return;
  }
  const canceled = err instanceof SvnError && err.code === 'CANCELLED';
  if (canceled) {
    await registry.markPhase(operationId, 'unknown');
    settleFinalResult(task, {
      mode: 'import',
      kind: 'unknown',
      path: input.sourceDir,
      resolution: 'unresolved',
      detail: strings.importTask.canceledUnknown,
      formSnapshot,
      targetUrl: input.targetUrl,
    });
    return;
  }
  if (provenUncommitted(err)) {
    // 直接失败且可证明未提交（出口⑦）：failed-unconfirmed 随即 finish 移除
    // + 快照删除；失败页携带 formSnapshot（retryImport 回填数据源）。
    await registry.finalizeOperation(operationId, 'failed-unconfirmed');
    await deleteImportSnapshot(operationId, task.extra.snapshotDir);
    settleFinalResult(task, {
      mode: 'import',
      kind: 'failed',
      path: input.sourceDir,
      detail: lsAnnotatedMessage(err),
      evidence: 'command',
      formSnapshot,
      targetUrl: input.targetUrl,
    });
    return;
  }
  // 网络中断/进程异常等不能证明结果 → unknown 冻结。
  await registry.markPhase(operationId, 'unknown');
  settleFinalResult(task, {
    mode: 'import',
    kind: 'unknown',
    path: input.sourceDir,
    resolution: 'unresolved',
    detail: errorMessage(err),
    formSnapshot,
    targetUrl: input.targetUrl,
  });
}

/* ---------------------------------------------------------------------------
 * 执行期认证「先补录、后查远端」（§4.3 ② 四态）
 * ------------------------------------------------------------------------- */

/** 补录回调内目标 ls 的超时上限（配置 0/非法不作用于它——补录流程必须有限时间返回）。 */
const LS_TIMEOUT_CAP_MS = 120_000;

function boundedLsTimeoutMs(): number {
  const configured = readTimeoutMs();
  return configured > 0 ? Math.min(configured, LS_TIMEOUT_CAP_MS) : LS_TIMEOUT_CAP_MS;
}

/** 四态判定的外带结论（svnCli 按原认证错误抛出后，执行器据此生成失败页 detail）。 */
type LsProbeOutcome = 'notFound' | 'targetExists' | 'lsAuthFailed' | 'lsOtherFailed';

/** E200009/W160009：URL 目标不存在（与 core/importDir 的判定同口径）。 */
function isLsNotFound(err: SvnError): boolean {
  return extractSvnErrorCodes(err.stderr).includes('E200009') || err.stderr.includes('W160009');
}

/**
 * 四态标注的失败文案：认证失败原错误之外，按补录回调内 svn ls 的判定
 * 结论附加可读原因（目标已存在/凭据不可用/无法确认远端目标状态）。
 */
function lsAnnotatedMessage(err: unknown): string {
  const base = errorMessage(err);
  if (lastLsProbe === 'targetExists') {
    return `${base}（${strings.importTask.lsTargetExists}）`;
  }
  if (lastLsProbe === 'lsAuthFailed') {
    return `${base}（${strings.importTask.lsAuthFailed}）`;
  }
  if (lastLsProbe === 'lsOtherFailed') {
    return `${base}（${strings.importTask.lsOtherFailed}）`;
  }
  return base;
}

/**
 * 最近一次四态判定的结论（模块级：svnCli 的重试判定在回调返回值层面，
 * 判定原因经本变量外带给出口分发的失败文案；同一时刻只有一个导入任务
 * 在途，无并发覆盖）。
 */
let lastLsProbe: LsProbeOutcome | undefined;

/**
 * 导入的执行期认证提供者（§4.3 ②「先补录、后查远端」，顺序不可倒置）：
 * svn+ssh/file 或未注入弹窗回调时不注入（认证失败按普通失败呈现）；否则
 * 返回包装回调——认证失败发生在传输前（事务未建立），先弹补录，拿到凭据
 * 后用该凭据 `svn ls <目标URL>`（--non-interactive、escapeUrlPeg、显式有
 * 界超时 ≤120s、不注入 getCredentials 防递归弹窗）四态判定：
 * - E200009（目标不存在）→ 返回凭据，svnCli 带 --username/--password 重试一次；
 * - 目标已存在（ls 成功）→ 返回空值放弃重试（按原错误抛出、可证明未提交
 *   直接失败出口⑦，不向既有目录重试——重试可能静默合并）；
 * - ls 自身认证失败 → 返回空值放弃重试，按认证失败处理（不误归目标已出现）；
 * - ls 其他失败（网络/代理/超时等）→ 无法确认目标状态：返回空值放弃重试，
 *   按可证明未提交直接失败（出口⑦）并提示「无法确认远端目标状态」。
 */
function importCredentialProvider(
  svnPath: string,
  targetUrl: string,
  callbacks: ImportTaskCallbacks,
): (() => Promise<AuthCredentials | undefined>) | undefined {
  if (!schemeAcceptsCredentials(targetUrl) || !callbacks.getCredentials) {
    return undefined;
  }
  const prompt = callbacks.getCredentials;
  return async () => {
    lastLsProbe = undefined;
    // 先补录：认证失败发生在传输前、事务未建立，可证明本次未提交。
    const credentials = await prompt();
    if (!credentials) {
      return undefined;
    }
    // 后查远端：用刚拿到的凭据显式执行 svn ls 四态判定。
    try {
      await runOrThrow(
        svnPath,
        [
          'ls', '--non-interactive', '--', escapeUrlPeg(targetUrl),
          '--username', credentials.username, '--password', credentials.password,
        ],
        {
          timeoutMs: boundedLsTimeoutMs(),
          ...decodingRunOptions('import'),
          // 回调内不注入 getCredentials：注入会让 svnCli 再次调回调、递归弹窗。
        },
      );
      lastLsProbe = 'targetExists';
      return undefined;
    } catch (err) {
      if (err instanceof SvnError && isLsNotFound(err)) {
        lastLsProbe = 'notFound';
        return credentials;
      }
      lastLsProbe = err instanceof SvnError && isAuthFailure(err.stderr) ? 'lsAuthFailed' : 'lsOtherFailed';
      return undefined;
    }
  };
}

/* ---------------------------------------------------------------------------
 * unknown 核实（§5 结果未知：verifyImportOutcome 三分类 + 记录收口）
 * ------------------------------------------------------------------------- */

/** 目标 URL 的父 URL（去最后一段；尾斜杠已由表单规范化剥除）。 */
function parentUrlOf(targetUrl: string): string {
  const idx = targetUrl.lastIndexOf('/');
  return idx > 0 ? targetUrl.slice(0, idx) : targetUrl;
}

async function findRecord(operationId: string): Promise<OperationRecord | undefined> {
  const all = await getOperationRegistry().loadAllRecords();
  return all.find((record) => record.operationId === operationId);
}

/**
 * unknown 页核实（§5 核实流程，只读命令链）：登记「只读命令进行中」
 * （scope/epoch 由调用方捕获传入）→ 读记录与快照文件 → core 的
 * verifyImportOutcome（服务器侧证据三分类，快照 digest 校验在第 0 步）。
 * 记录收口按结论执行（先过「记录仍为该 operationId 且仍处 unknown」校验，
 * 校验不过即跳过——如核实进行中已 acknowledge 收口）：
 * - committed → done（resolvedRevision 落盘）+ finish 移除 + 快照删除（出口⑤）；
 * - notCommitted → failed-unconfirmed + finish 移除 + 快照删除（出口⑥）；
 * - unknown（含快照不完整）→ 保持 unknown 不动记录。
 * 结论页构造数据（formSnapshot/targetUrl）随结论返回，控制器按结果代次
 * 守卫写缓存——本函数不做 UI；核实时长不依赖面板存活。命令异常终止等未
 * 产出结论的出口清除登记（不推送重跑）。onSucceeded 在 committed 时触发
 * （成功含核实转 committed 的共用 URL 历史写入）。
 */
export async function verifyImportTask(input: VerifyImportTaskInput): Promise<ImportVerifyTaskResult> {
  const svnPath = input.svnPath ?? readSvnPath();
  const registry = getOperationRegistry();
  const snapshotDir = resolveSnapshotDir(input.snapshotDir);
  beginReadonlyVerify('checkout', input.resultScope, input.epoch);
  try {
    const record = await findRecord(input.operationId);
    if (!record || kindOf(record) !== 'import' || !record.importIntent) {
      return {
        conclusion: 'unknown',
        reason: 'recordUnavailable',
        message: strings.importTask.recordUnavailable,
        recordSettled: false,
      };
    }
    const intent = record.importIntent;
    const formSnapshot: ImportFormSnapshot = {
      url: intent.targetUrl,
      sourceDir: record.targetPath ?? '',
      message: intent.message,
      nameMode: intent.nameMode,
    };
    // 快照文件缺失时传 undefined：core 第 0 步按「未提供快照」返回
    // snapshotIncomplete（不重建期望集合、不冒充可核实）。
    let snapshotText: string | undefined;
    if (snapshotDir) {
      try {
        snapshotText = await readFile(snapshotFilePath(snapshotDir, intent.fileRefs), 'utf8');
      } catch {
        snapshotText = undefined;
      }
    }
    const runOptions: RunOptions = { timeoutMs: 0, ...decodingRunOptions('import') };
    if (schemeAcceptsCredentials(intent.targetUrl) && input.callbacks?.getCredentials) {
      runOptions.getCredentials = input.callbacks.getCredentials;
    }
    const outcome: ImportVerifyOutcome = await verifyImportOutcome(
      svnPath,
      {
        snapshotText,
        expectedSnapshotDigest: intent.snapshotDigest,
        targetUrl: intent.targetUrl,
        parentUrl: parentUrlOf(intent.targetUrl),
        parentIdentity: intent.parentIdentity,
        expectedMessageDigest: intent.messageHash,
      },
      runOptions,
    );
    if (outcome.kind === 'unknown') {
      // 证据不足保持 unknown：记录不动、快照保留（快照不完整分支的
      // abandonUnknownImport 出口仍可达）。
      return {
        conclusion: 'unknown',
        reason: outcome.reason,
        message: outcome.message,
        snapshotIncomplete: outcome.reason === 'snapshotIncomplete',
        formSnapshot,
        targetUrl: intent.targetUrl,
        recordSettled: false,
      };
    }
    // 记录收口校验：仍为该 operationId 且仍处 unknown（acknowledge 冲突
    // 收口后记录已删除/相位已变，跳过二次收口）。
    const current = await findRecord(input.operationId);
    const eligible = current !== undefined && kindOf(current) === 'import' && current.phase === 'unknown';
    if (eligible) {
      if (outcome.kind === 'committed') {
        await registry.finalizeOperation(input.operationId, 'done', { resolvedRevision: outcome.revision });
      } else {
        await registry.finalizeOperation(input.operationId, 'failed-unconfirmed');
      }
      await deleteImportSnapshot(input.operationId, snapshotDir);
      if (outcome.kind === 'committed') {
        input.callbacks?.onSucceeded?.({ revision: outcome.revision, targetUrl: intent.targetUrl });
      }
    }
    return outcome.kind === 'committed'
      ? {
        conclusion: 'committed',
        revision: outcome.revision,
        formSnapshot,
        targetUrl: intent.targetUrl,
        recordSettled: eligible,
      }
      : {
        conclusion: 'notCommitted',
        evidence: outcome.evidence,
        formSnapshot,
        targetUrl: intent.targetUrl,
        recordSettled: eligible,
      };
  } catch (err) {
    clearReadonlyVerify('checkout');
    throw err;
  }
}

/* ---------------------------------------------------------------------------
 * merged 确认收口与快照不完整分支的放弃（出口⑧/⑪）
 * ------------------------------------------------------------------------- */

/**
 * merged 页「已人工核对，完成」收口（出口⑧）：markPhase('done')（patch
 * 不含 outcome——记录的 outcome='merged'/resolvedRevision 原样保留）→
 * 终态收口 finish 移除 + 快照删除（不存在即略过）。返回 settled 标记
 * （记录缺失或已非 unknown 时 false，控制器按已收口呈现）。
 */
export async function acknowledgeImportTask(
  operationId: string,
  snapshotDir?: string,
): Promise<{ settled: boolean }> {
  const registry = getOperationRegistry();
  const record = await findRecord(operationId);
  if (!record || kindOf(record) !== 'import' || record.phase !== 'unknown') {
    return { settled: false };
  }
  await registry.finalizeOperation(operationId, 'done');
  await deleteImportSnapshot(operationId, resolveSnapshotDir(snapshotDir));
  return { settled: true };
}

/**
 * 快照不完整分支 unknown 页「放弃核实并解除限制」（出口⑪）：记录
 * markPhase('failed-unconfirmed')（解除限制语义、不是断言未提交）→ 终态
 * 收口 finish 移除 + 快照删除。返回 abandoned 标记（回表单由控制器执行，
 * 保留表单值经结论页 formSnapshot/两层回填规则承载）。
 */
export async function abandonUnknownImportTask(
  operationId: string,
  snapshotDir?: string,
): Promise<{ abandoned: boolean }> {
  const registry = getOperationRegistry();
  const record = await findRecord(operationId);
  if (!record || kindOf(record) !== 'import' || record.phase !== 'unknown') {
    return { abandoned: false };
  }
  await registry.finalizeOperation(operationId, 'failed-unconfirmed');
  await deleteImportSnapshot(operationId, resolveSnapshotDir(snapshotDir));
  return { abandoned: true };
}
