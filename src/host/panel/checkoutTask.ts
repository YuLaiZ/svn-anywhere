/**
 * 检出/续检任务执行器（M3 技术方案 §2.1 任务模型、§4.3 检出执行、
 * §4.4 续检核验）。
 *
 * 执行器与面板会话生命周期解耦：任务对象创建后由本模块推进状态机
 * （connecting → running → canceling → success/canceled/failed）并结算，
 * 面板（后续任务接入）经注入回调感知进度与出口、经返回的 done promise
 * 等待终态。本模块不直接 import vscode：弹窗（认证补录、conn.identity
 * 清除）经注入回调，草稿经 drafts 模块的注入存储，输出频道经
 * host/output（无窗口 UI）。
 *
 * 时序硬约束（§2.1/§4.3）：
 * - 检出：任务对象（connecting）→ begin 落盘（固定字段经参数面一次写入）
 *   → 开始前目标重查（begin 落盘后的最后一步业务校验）→ 重查通过、
 *   紧邻写命令发出前清除面板 conn.identity → 命令发出（timeoutMs=0、
 *   AbortSignal 取消、onStdoutChunk 流式）→ 终态结算；
 * - 终态结算顺序：记录侧收口（done → finalizeOperation 移除 / 取消与
 *   失败 → markPhase residue-pending 保留）→ 构建结果页 → 先
 *   writeSessionResult(executor)、再 removeTask（同一同步步骤，运行中
 *   关闭面板后台完成仍有写入者）；
 * - 预命令终止出口（begin 任何失败/重查失败/导入与 P4 预留枚举）一律：
 *   先把任务创建时捕获的 formSnapshot 写回草稿、再 removeTask、不写
 *   会话缓存、不产生 result、通知出口回调（面板 busy 恢复/回 review）。
 */
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  buildCheckoutArgs,
  buildResumeArgs,
  schemeAcceptsCredentials,
  verifyResumable,
  type CheckoutDepth,
  type RemoteIdentity,
  type ResumableExpectation,
  type VerifyReport,
} from '../../core/checkout';
import { SvnError } from '../../core/errors';
import {
  checkoutLockKey,
  getOperationRegistry,
  randomOperationId,
  type BeginResult,
  type OperationRecord,
} from '../../core/operations';
import { runOrThrow, type AuthCredentials, type RunOptions } from '../../core/svnCli';
import { findWorkingCopy } from '../../core/workspace';
import { readSvnPath } from '../config';
import { createLineBuffer, decodingRunOptions, logCommand } from '../output';
import { beginReadonlyVerify, clearReadonlyVerify, writeSessionResult } from '../sessionResults';
import {
  addTask,
  getTaskById,
  removeTask,
  type CheckoutResultScope,
  type ResultScope,
  type TaskObject,
  type TaskPhase,
} from '../taskRegistry';
import { saveDraft, type CheckoutFormDraft } from './drafts';

/* ---------------------------------------------------------------------------
 * 流式进度解析（字节层，形态对齐 test/svnCliStream.test.ts 的行缓冲）
 * ------------------------------------------------------------------------- */

/**
 * 字节层行缓冲：按 0x0A 分行（GBK 双字节的尾字节不会产生 0x0A，UTF-8
 * 多字节字符也不含 0x0A，按字节拆行不会截断多字节字符），跨块拼接完整
 * 行；进程结束后用 flush 取回无换行结尾的残留尾段。
 */
class ByteLineBuffer {
  private pending: Buffer = Buffer.alloc(0);

  /** 喂入一块，返回由这块完成的完整行（不含换行符）。 */
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

  /** 取回不完整的尾段（进程结束后的残留），无残留返回 null。 */
  flush(): Buffer | null {
    if (this.pending.length === 0) {
      return null;
    }
    const rest = this.pending;
    this.pending = Buffer.alloc(0);
    return rest;
  }
}

/** 流式阶段的显示解码：UTF-8 宽松（非法字节替换为 U+FFFD），不做编码回退链。 */
function lenientUtf8(line: Buffer): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(line);
}

/** 字节层前缀匹配：前缀为 ASCII 字节，直接比对原始字节，不依赖行内容解码。 */
function startsWithBytes(line: Buffer, prefix: string): boolean {
  const prefixBuf = Buffer.from(prefix, 'utf8');
  return line.subarray(0, prefixBuf.length).equals(prefixBuf);
}

/** svn 1.15 实测条目前缀：检出为 `A ` + 4 空格；续检 update 另有 U/D/G。 */
export const CHECKOUT_ENTRY_PREFIXES: readonly string[] = ['A    '];
export const UPDATE_ENTRY_PREFIXES: readonly string[] = ['A    ', 'U    ', 'D    ', 'G    '];

/** 命令尾行：检出 `Checked out revision N.`、续检 update `Updated to revision N.`。 */
const TAIL_REVISION_RE = /^(?:Checked out|Updated to) revision (\d+)\.$/;

/** 流式进度的累计状态（任务进度页与「已取得 N 项」文案的数据源）。 */
export interface CheckoutProgressState {
  count: number;
  currentFile: string | null;
  /** 命令尾行捕获的 revision（未出现为 null）。 */
  revision: number | null;
}

/**
 * 检出/续检的流式进度解析器：条目前缀计数、当前文件名宽松 UTF-8 解码
 * 显示、尾行 revision 捕获；未识别行不计数、交日志回调（面板任务日志
 * 视图可用）。计数与前缀匹配在字节层完成，不依赖行内容解码结果。
 */
export class CheckoutProgressParser {
  readonly state: CheckoutProgressState = { count: 0, currentFile: null, revision: null };
  private readonly buffer = new ByteLineBuffer();

  constructor(
    private readonly prefixes: readonly string[],
    private readonly onUnknownLine: (text: string) => void,
    private readonly onProgress?: (state: CheckoutProgressState) => void,
  ) {}

  /** 喂入一个 stdout 原始块（跨块行由行缓冲拼出）。 */
  feed(chunk: Buffer): void {
    for (const line of this.buffer.push(chunk)) {
      this.handleLine(line);
    }
  }

  /** 进程结束后取回无换行结尾的残留尾段并解析。 */
  finish(): void {
    const tail = this.buffer.flush();
    if (tail) {
      this.handleLine(tail);
    }
  }

  private handleLine(line: Buffer): void {
    for (const prefix of this.prefixes) {
      if (startsWithBytes(line, prefix)) {
        this.state.count += 1;
        // 当前文件名按 UTF-8 宽松解码显示（GBK 名称可能乱码可接受），
        // 截掉前缀后去除首尾空白。
        this.state.currentFile = lenientUtf8(line.subarray(Buffer.from(prefix, 'utf8').length)).trim();
        this.onProgress?.(this.state);
        return;
      }
    }
    const text = lenientUtf8(line);
    const match = TAIL_REVISION_RE.exec(text);
    if (match) {
      this.state.revision = Number(match[1]);
      return;
    }
    // 未识别行（阶段行、空行等）：不计数，交日志回调。
    this.onUnknownLine(text);
  }
}

/* ---------------------------------------------------------------------------
 * 开始前目标重查（§4.2/§4.3：begin 落盘后的最后一步业务校验）
 * ------------------------------------------------------------------------- */

export type TargetRecheckFailure =
  /** 目标目录非空（不提供 --force）。 */
  | 'targetNotEmpty'
  /** 目标已含 .svn（目标自身是工作副本，含 directMode 选中工作副本形态）。 */
  | 'targetHasMetadata'
  /** 目标任一祖先为工作副本（嵌套副本）。 */
  | 'nestedWorkingCopy';

export type TargetRecheckResult =
  | { ok: true }
  | { ok: false; reason: TargetRecheckFailure; message: string };

/**
 * 开始前目标重查：目标不存在或为空目录放行；目标含 .svn 拒绝；非空
 * 拒绝；目标的任一祖先为工作副本（findWorkingCopy 从目标父目录向上找）
 * 拒绝并提示另选副本外目录。占用拒绝不在此列——同 lockKey 的在途/受限
 * 记录已由紧邻其前的 begin 返回 busy 承担（时序见 §4.3），不重复判定。
 */
export function recheckCheckoutTarget(targetDir: string): TargetRecheckResult {
  let entries: string[];
  try {
    entries = readdirSync(targetDir);
  } catch {
    // 目标不存在：创建型目标，放行前仍要查祖先（父目录是副本即嵌套）。
    return ancestorRecheck(targetDir);
  }
  if (entries.includes('.svn')) {
    return { ok: false, reason: 'targetHasMetadata', message: `目标目录已包含 .svn（${targetDir}），不能在其上检出` };
  }
  if (entries.length > 0) {
    return { ok: false, reason: 'targetNotEmpty', message: `目标目录不为空（${targetDir}），请换一个空目录或新目录名` };
  }
  return ancestorRecheck(targetDir);
}

function ancestorRecheck(targetDir: string): TargetRecheckResult {
  // findWorkingCopy 从目标父目录向上找：目标自身不算祖先（自身是副本的
  // 形态已由 .svn 分支拦截）。
  const ancestor = findWorkingCopy(dirname(targetDir));
  if (ancestor !== undefined) {
    return {
      ok: false,
      reason: 'nestedWorkingCopy',
      message: `目标位于工作副本内（${ancestor}），不能创建嵌套副本，请另选副本外目录`,
    };
  }
  return { ok: true };
}

/**
 * 执行期认证重试的半成品边界判定（§4.3 ①）：目标仍不存在或为空且无
 * .svn（认证失败发生在传输开始前的可证明零写入形态）才允许弹窗补录；
 * 目标已出现任何文件或 .svn → 放弃补录与重试（svnCli 对空凭据按原错误
 * 抛出），按失败路径落 residue-pending，杜绝「重试叠加半成品」。
 */
function targetVirginForCredentialRetry(targetDir: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(targetDir);
  } catch {
    return true;
  }
  if (entries.includes('.svn')) {
    return false;
  }
  return entries.length === 0;
}

/* ---------------------------------------------------------------------------
 * 执行器对外类型（面板后续接入的出口回调接口与结果页形状）
 * ------------------------------------------------------------------------- */

/**
 * 预命令终止出口的完整枚举（§2.1：任务创建到写命令发出之间的一切未发起
 * 终止；导入与 P4 的枚举位本批预留，后续任务接入时经同一收口 helper）。
 */
export type PreCommandExit =
  /** begin 返回 busy（同 lockKey 在途/受限记录占用）。 */
  | { kind: 'beginBusy'; heldBy: OperationRecord }
  /** begin 返回 idConflict（预生成 operationId 与既有记录撞车）。 */
  | { kind: 'beginIdConflict' }
  /** begin 写盘失败（store.save 抛错）。 */
  | { kind: 'beginWriteFailed'; message: string }
  /** 检出开始前目标重查失败（记录已 failed-unconfirmed + finish 收口）。 */
  | { kind: 'targetRecheckFailed'; reason: TargetRecheckFailure; message: string }
  /** 导入确认后第三次源快照比对失败（阶段 2 接入）。 */
  | { kind: 'sourceChanged' }
  /** 导入确认后远端重检 targetChanged（阶段 2 接入）。 */
  | { kind: 'targetChanged' }
  /** 导入快照写失败（阶段 2 接入）。 */
  | { kind: 'snapshotWriteFailed'; message?: string }
  /** 仓库提交确认框 Esc/取消（阶段 2 接入）。 */
  | { kind: 'confirmAborted' };

/**
 * 检出任务的结果页（§4.1 result 判别联合的 checkout 分支中由执行器产生
 * 的子集：resumable/interrupted 由面板核验结论与重启分诊产生，不在执行器）。
 */
export interface CheckoutResultPage {
  mode: 'checkout';
  kind: 'success' | 'canceled' | 'failed' | 'resumeBlocked';
  revision?: number;
  /** 检出/续检目标绝对路径。 */
  path: string;
  /** 取消/失败的可读原因。 */
  detail?: string;
  /** resumeBlocked 附带的核验报告（§4.4 续检执行前重核验）。 */
  verify?: VerifyReport;
  /** canceled/failed/resumeBlocked 页的表单快照（abandonResidue 的数据源）。 */
  formSnapshot?: CheckoutFormDraft;
}

/** startCheckoutTask/resumeCheckoutTask 的 done 结算：终态或预命令出口。 */
export type CheckoutTaskOutcome =
  | { outcome: 'finished'; result: CheckoutResultPage }
  | { outcome: 'preCommandExit'; exit: PreCommandExit };

/** 面板注入的出口回调集合（面板控制器后续接入；全部可选）。 */
export interface CheckoutTaskCallbacks {
  /**
   * 执行期认证补录弹窗（宿主注入；仅 http/https/svn 会接到调用——
   * svn+ssh/file 不注入）。检出回调内先做目标半成品边界判定。
   */
  getCredentials?: () => Promise<AuthCredentials | undefined>;
  /** 检出重查通过、紧邻写命令发出前清除面板 conn.identity（身份归面板持有）。 */
  onIdentityConsumed?: () => void;
  /** 流式进度（条目计数与当前文件名）；渲染节流由面板完成。 */
  onProgress?: (state: CheckoutProgressState) => void;
  /** 未识别行日志（不计数；面板任务日志视图可用）。 */
  onLogLine?: (text: string) => void;
  /**
   * 预命令终止出口通知：面板 busy 恢复、回 review 页——busy 分支提示
   * 「换目标或等待」，其余分支以 review.error 横幅呈现原因。
   */
  onPreCommandExit?: (exit: PreCommandExit) => void;
}

/** startCheckoutTask 的输入：任务固定参数一次捕获。 */
export interface StartCheckoutTaskInput {
  /** 测试注入用；缺省读配置 svnPath。 */
  svnPath?: string;
  /** 检出源 URL（规范编码形态）。 */
  url: string;
  /** 连接检查固定下来的 revision（执行与续检都用它，不重取 HEAD）。 */
  pinnedRevision: number;
  depth: CheckoutDepth;
  /** 检出目标绝对路径（普通 = join(parentDir, dirName)、直接模式 = directDir；面板已归一）。 */
  targetDir: string;
  /** 普通模式父目录（realpath 后，锁键拼接用；directMode 时忽略）。 */
  parentDir: string;
  dirName: string;
  directMode: boolean;
  /** 直接模式所选目标目录（realpath 后；锁键 = 本值）。 */
  directDir: string;
  /** 连接检查快照的仓库身份三元组（随 begin 一次落盘）。 */
  identity: RemoteIdentity;
  /** 打开入口键（草稿/结果缓存的作用域基准，面板从本次打开入口捕获）。 */
  entryKey: string;
  /** 发起会话标识：任务移除通知跳过该会话。 */
  initiatorSessionId: string;
  /** 任务创建时捕获的全部表单字段快照（预命令出口草稿写回的唯一数据源）。 */
  formSnapshot: CheckoutFormDraft;
  callbacks?: CheckoutTaskCallbacks;
}

export interface StartedCheckoutTask {
  taskId: string;
  /** 任务终态结果页或预命令出口（发起面板 await 它完成 result/review 转移）。 */
  done: Promise<CheckoutTaskOutcome>;
}

/** resumeCheckoutTask 的输入。 */
export interface ResumeCheckoutTaskInput {
  svnPath?: string;
  /** 既有 residue-pending 记录的 operationId（续检任务 ID 沿用）。 */
  operationId: string;
  lockKey: string;
  /** 残留副本目标绝对路径。 */
  targetDir: string;
  /** 记录冻结的核验基准（url/pinnedRevision/depth/identity 由调用方从记录读取）。 */
  url: string;
  pinnedRevision: number;
  depth: CheckoutDepth;
  identity: RemoteIdentity;
  /** 打开入口键（resultScope 捕获基准）。 */
  entryKey: string;
  /**
   * 续检任务的表单快照：§2.1 续检来源规则（会话内 form 非空优先 form、
   * 否则继承 resumable 页携带快照、无快照按空表单）由调用方完成后传入。
   */
  formSnapshot?: CheckoutFormDraft;
  initiatorSessionId: string;
  callbacks?: CheckoutTaskCallbacks;
}

/** resume 启动结果：busy 分支带占用记录（面板按 kind 分列文案），recordUnavailable 提示重核验。 */
export type ResumeCheckoutStart =
  | { ok: true; taskId: string; done: Promise<CheckoutTaskOutcome> }
  | { ok: false; reason: 'busy'; heldBy: OperationRecord }
  | { ok: false; reason: 'recordUnavailable' };

/** verifyCheckoutOnly 的输入。 */
export interface VerifyCheckoutOnlyInput {
  svnPath?: string;
  targetDir: string;
  /** 核验基准（记录冻结的三元组 + 深度 + pinnedRevision）。 */
  expectation: ResumableExpectation;
  /** 只读命令进行中登记的作用域与代次（发起时捕获，由调用方传入）。 */
  resultScope: ResultScope;
  epoch: number;
}

/** 取消结果：missing = 任务已终态（确认竞态不回改）；notRunning = connecting/canceling 拒绝。 */
export type CancelCheckoutTaskResult =
  | { ok: true }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'notRunning'; phase: TaskPhase };

/* ---------------------------------------------------------------------------
 * 任务对象与结算
 * ------------------------------------------------------------------------- */

interface CheckoutTaskExtra {
  callbacks: CheckoutTaskCallbacks;
  resolveDone: (outcome: CheckoutTaskOutcome) => void;
  done: Promise<CheckoutTaskOutcome>;
}

/**
 * 本模块的任务对象形态：交叉类型把可选的 extra 收窄为必填（创建时总是
 * 填入，注册表类型不因此改动），全部引用点无需逐处判空。
 */
type CheckoutTask = TaskObject<CheckoutTaskExtra> & { extra: CheckoutTaskExtra };

function createCheckoutTask(
  taskId: string,
  lockKey: string,
  resultScope: CheckoutResultScope,
  initiatorSessionId: string,
  formSnapshot: CheckoutFormDraft | undefined,
  callbacks: CheckoutTaskCallbacks,
): CheckoutTask {
  let resolveDone!: (outcome: CheckoutTaskOutcome) => void;
  const done = new Promise<CheckoutTaskOutcome>((resolve) => {
    resolveDone = resolve;
  });
  return {
    taskId,
    panelKind: 'checkout',
    phase: 'connecting',
    resultScope,
    lockKey,
    formSnapshot,
    initiatorSessionId,
    abortController: new AbortController(),
    extra: { callbacks, resolveDone, done },
  };
}

/**
 * 预命令终止出口的统一收口（§2.1 完整出口枚举，导入/P4 位预留）：先把
 * 任务创建时捕获的 formSnapshot 写回草稿（键 = 任务入口键，不读面板实例
 * state——面板已 dispose 或已被重开会话取代时仍写出完整草稿）、再
 * removeTask（出口顺序与任务终态「先写缓存、再移除任务」同款——绑定会话
 * 重跑恢复时草稿已就绪）；不写会话缓存、不产生 result、不登记运行键
 * （begin 失败本就无登记）；最后通知出口回调（面板 busy 恢复/回 review）。
 */
function preCommandExit(task: CheckoutTask, exit: PreCommandExit): void {
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
 * 任务终态结算（§2.1 结算顺序）：记录侧收口（done → finalizeOperation
 * 移除 / residue-pending 保留）已由调用方完成，此处同步完成「先
 * writeSessionResult(executor)、再 removeTask」——同一同步步骤内无 await，
 * 重开面板不会落在「已移除、未写缓存」的两步之间；随后 resolve 发起
 * 面板 await 的 done。
 */
function settleFinalResult(task: CheckoutTask, page: CheckoutResultPage): void {
  writeSessionResult('checkout', task.resultScope, page, 'executor');
  removeTask(task.taskId);
  task.extra.resolveDone({ outcome: 'finished', result: page });
}

/** 错误信息归一（取消的 detail 由调用方按 code 生成，此处只取可读文本）。 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/* ---------------------------------------------------------------------------
 * 检出任务（§4.3 开始检出）
 * ------------------------------------------------------------------------- */

/**
 * 发起检出任务：同步创建任务对象（connecting）注册 taskRegistry 并返回
 * taskId 与终态 promise，执行流（begin → 重查 → 命令 → 结算）后台推进
 * ——面板发起后立即可渲染进度页、取消与订阅任务移除通知，不等待终态。
 */
export function startCheckoutTask(input: StartCheckoutTaskInput): StartedCheckoutTask {
  const svnPath = input.svnPath ?? readSvnPath();
  const lockKey = input.directMode
    ? input.directDir
    : checkoutLockKey(input.parentDir, input.dirName);
  const resultScope: CheckoutResultScope = { entryKey: input.entryKey, mode: 'checkout' };
  // ① 任务对象（connecting）注册 taskRegistry；ID 预生成（begin 沿用）。
  const taskId = randomOperationId();
  const task = createCheckoutTask(
    taskId, lockKey, resultScope, input.initiatorSessionId, input.formSnapshot, input.callbacks ?? {},
  );
  addTask(task);
  void runCheckoutFlow(task, input, svnPath, lockKey);
  return { taskId, done: task.extra.done };
}

/**
 * 检出执行流（§4.3 时序硬约束）：begin 落盘 → 开始前目标重查 → 清除
 * 面板 conn.identity → 命令发出（流式）→ 终态结算。任何意外异常按失败
 * 路径收口（residue-pending 保留），不让任务悬挂在 connecting/running。
 */
async function runCheckoutFlow(
  task: CheckoutTask,
  input: StartCheckoutTaskInput,
  svnPath: string,
  lockKey: string,
): Promise<void> {
  const { taskId } = task;
  const registry = getOperationRegistry();
  try {
    // ③ begin 落盘：kind/lockKey 与全部固定字段经参数面一次写入（此后不可变）。
    let begin: BeginResult;
    try {
      begin = await registry.begin({
        wcRoot: lockKey,
        targetRelPath: '.',
        nodeKind: 'dir',
        kind: 'checkout',
        lockKey,
        operationId: taskId,
        url: input.url,
        targetPath: input.targetDir,
        pinnedRevision: input.pinnedRevision,
        depth: input.depth,
        repositoryUuid: input.identity.repositoryUuid,
        repositoryRootUrl: input.identity.repositoryRootUrl,
        relativeUrl: input.identity.relativeUrl,
      });
    } catch (err) {
      // 写盘失败：不发起命令，任务对象按预命令出口收口。
      preCommandExit(task, { kind: 'beginWriteFailed', message: errorMessage(err) });
      return;
    }
    if (!begin.ok) {
      if (begin.reason === 'busy') {
        preCommandExit(task, { kind: 'beginBusy', heldBy: begin.heldBy });
      } else {
        preCommandExit(task, { kind: 'beginIdConflict' });
      }
      return;
    }

    // ④ begin 成功后目标重查（最后一步业务校验；占用拒绝已由 begin busy 承担）。
    const recheck = recheckCheckoutTarget(input.targetDir);
    if (!recheck.ok) {
      // 命令未发出、可证明零写入：failed-unconfirmed + finish 终态收口
      // （解除限制、允许重新发起），随后预命令出口（面板回 review 错误
      // 横幅，不产生 result 失败页）。
      await registry.finalizeOperation(taskId, 'failed-unconfirmed');
      preCommandExit(task, { kind: 'targetRecheckFailed', reason: recheck.reason, message: recheck.message });
      return;
    }

    // ⑤ 重查通过、紧邻写命令发出前清除面板 conn.identity（身份归面板持有，
    // begin 失败与重查失败均保留供同页重试）。
    task.extra.callbacks.onIdentityConsumed?.();

    // ⑥ 命令发出（timeoutMs=0，取消只靠 AbortSignal）+ ⑦ 流式进度解析。
    const args = buildCheckoutArgs(input.url, input.targetDir, {
      revision: input.pinnedRevision,
      depth: input.depth,
    });
    const parser = new CheckoutProgressParser(
      CHECKOUT_ENTRY_PREFIXES,
      (text) => task.extra.callbacks.onLogLine?.(text),
      (state) => task.extra.callbacks.onProgress?.(state),
    );
    // 执行期认证注入按 scheme 分支（§4.3）：svn+ssh/file 不注入；http/https/
    // svn 注入并在回调内做半成品边界判定（目标已写入即放弃补录与重试）。
    const getCredentials = checkoutCredentialProvider(input.url, input.targetDir, task.extra.callbacks);
    const outputBuffer = createLineBuffer(undefined, 'checkout');
    const runOptions: RunOptions = {
      timeoutMs: 0,
      signal: task.abortController.signal,
      onStdoutChunk: (chunk) => parser.feed(chunk),
      onOutput: (text) => outputBuffer.push(text),
      onExit: logCommand(svnPath, args, undefined, 'checkout'),
      onCredentialRetry: (retryArgs) => logCommand(svnPath, retryArgs, undefined, 'checkout'),
      ...decodingRunOptions('checkout'),
    };
    if (getCredentials) {
      runOptions.getCredentials = getCredentials;
    }
    // 进程已 spawn 即视为命令已发出（§2.1 映射表）：task 与记录转 running。
    task.phase = 'running';
    const runPromise = runOrThrow(svnPath, args, runOptions).then(
      () => undefined as unknown,
      (err: unknown) => err as unknown,
    );
    await registry.markPhase(taskId, 'running');
    const err = await runPromise;
    parser.finish();
    await settleCommandOutcome(task, taskId, err, input.targetDir, parser, input.formSnapshot, input.pinnedRevision);
  } catch (err) {
    // 防御收口：流程意外异常（理论不可达）按失败路径结算——记录尽量回
    // residue-pending（记录可能尚未 begin 或已被收口，markPhase missing
    // 时跳过），任务对象不悬挂、done 必定结算。
    await registry.markPhase(taskId, 'residue-pending').catch(() => undefined);
    settleFinalResult(task, {
      mode: 'checkout',
      kind: 'failed',
      path: input.targetDir,
      detail: errorMessage(err),
      formSnapshot: input.formSnapshot,
    });
  }
}

/**
 * 命令结束后的终态结算（检出与续检共用）：成功 → done + finish 移除；
 * 取消/失败 → residue-pending（未终态保留，核验入口照常）。
 * 记录收口完成后构建结果页并按结算顺序写缓存、移除任务。
 */
async function settleCommandOutcome(
  task: CheckoutTask,
  operationId: string,
  err: unknown,
  targetDir: string,
  parser: CheckoutProgressParser,
  formSnapshot: CheckoutFormDraft | undefined,
  fallbackRevision: number,
): Promise<void> {
  const registry = getOperationRegistry();
  if (err === undefined) {
    const revision = parser.state.revision ?? fallbackRevision;
    await registry.finalizeOperation(operationId, 'done');
    settleFinalResult(task, {
      mode: 'checkout',
      kind: 'success',
      revision,
      path: targetDir,
    });
    return;
  }
  const canceled = err instanceof SvnError && err.code === 'CANCELLED';
  await registry.markPhase(operationId, 'residue-pending');
  settleFinalResult(task, {
    mode: 'checkout',
    kind: canceled ? 'canceled' : 'failed',
    path: targetDir,
    detail: errorMessage(err),
    formSnapshot,
  });
}

/**
 * 检出的执行期认证提供者（§4.3 ①半成品边界）：svn+ssh/file 或未注入弹窗
 * 回调时返回 undefined（不注入，认证失败按普通失败呈现）；否则返回包装
 * 回调——目标仍不存在或为空且无 .svn 才弹窗补录，目标已写入返回空值
 * 放弃补录与重试。
 */
function checkoutCredentialProvider(
  url: string,
  targetDir: string,
  callbacks: CheckoutTaskCallbacks,
): (() => Promise<AuthCredentials | undefined>) | undefined {
  if (!schemeAcceptsCredentials(url) || !callbacks.getCredentials) {
    return undefined;
  }
  const prompt = callbacks.getCredentials;
  return async () => (targetVirginForCredentialRetry(targetDir) ? prompt() : undefined);
}

/* ---------------------------------------------------------------------------
 * 取消（§2.1：仅 running 放行，canceling 禁重复取消）
 * ------------------------------------------------------------------------- */

export function cancelCheckoutTask(taskId: string): CancelCheckoutTaskResult {
  const task = getTaskById(taskId);
  if (!task) {
    // 确认期间任务已终态（终态即移除）：不回改，返回 missing 供调用方
    // 按已终态呈现（迟到取消动作不改变已成功/失败的结果）。
    return { ok: false, reason: 'missing' };
  }
  // 宿主放行表同源守卫：connecting 准备段不提供用户取消、canceling 期间
  // 禁重复取消请求。
  if (task.phase !== 'running') {
    return { ok: false, reason: 'notRunning', phase: task.phase };
  }
  task.phase = 'canceling';
  task.abortController.abort();
  return { ok: true };
}

/* ---------------------------------------------------------------------------
 * 续检（§4.4 续检执行：beginResume 独占 → 完整重核验 → cleanup + update）
 * ------------------------------------------------------------------------- */

export async function resumeCheckoutTask(input: ResumeCheckoutTaskInput): Promise<ResumeCheckoutStart> {
  const svnPath = input.svnPath ?? readSvnPath();
  const registry = getOperationRegistry();
  // ① 续检独占正门（§2.2 写命令纪律）：busy 分支带占用记录（面板按 kind
  // 分列文案提示）、recordUnavailable 提示记录已不可用；均不改相位不登记。
  const resume = await registry.beginResume(input.operationId, input.lockKey);
  if (!resume.ok) {
    if (resume.reason === 'busy') {
      return { ok: false, reason: 'busy', heldBy: resume.heldBy };
    }
    return { ok: false, reason: 'recordUnavailable' };
  }

  // ② 新任务对象（ID 沿用记录 operationId；connecting 覆盖 beginResume
  // 成功后、写命令发出前的准备段，记录侧此刻已是 running）。
  const resultScope: CheckoutResultScope = { entryKey: input.entryKey, mode: 'checkout' };
  const task = createCheckoutTask(
    input.operationId, input.lockKey, resultScope, input.initiatorSessionId,
    input.formSnapshot, input.callbacks ?? {},
  );
  addTask(task);
  // 重核验与写命令链后台推进（面板立即获得 taskId 渲染运行页）。
  void runResumeFlow(task, input, svnPath);
  return { ok: true, taskId: task.taskId, done: task.extra.done };
}

/**
 * 续检执行流（§4.4）：写命令发出前重跑完整核验 → 不一致回 residue-pending
 * 并落 resumeBlocked 结果页；一致则 cleanup + update --set-depth 执行并按
 * 终态结算。任何意外异常按失败路径收口（回 residue-pending，不悬挂）。
 */
async function runResumeFlow(task: CheckoutTask, input: ResumeCheckoutTaskInput, svnPath: string): Promise<void> {
  const registry = getOperationRegistry();
  try {
    // ③ 写命令发出前重跑完整核验（复用 core 同一 verifyResumable，含
    // svn status——status 也 timeoutMs=0，失败保守 resumeBlocked；不新造
    // 核验项子集函数，两套核验逻辑会口径漂移）。
    const expectation: ResumableExpectation = {
      repositoryUuid: input.identity.repositoryUuid,
      repositoryRootUrl: input.identity.repositoryRootUrl,
      relativeUrl: input.identity.relativeUrl,
      depth: input.depth,
      pinnedRevision: input.pinnedRevision,
    };
    const report = await verifyResumable(svnPath, input.targetDir, expectation, {
      timeoutMs: 0,
      ...decodingRunOptions('checkout'),
    });
    if (report.kind !== 'resumable') {
      // 不一致：不发写命令、记录经 markPhase 回 residue-pending（运行登记
      // 随之清除）、resumeBlocked 结果页（VerifyReport 附带、formSnapshot
      // 从任务对象写入）按镜像规则写缓存后移除任务；不产生任务终态 result
      // （success/canceled/failed 不发生）。
      await registry.markPhase(input.operationId, 'residue-pending');
      settleFinalResult(task, {
        mode: 'checkout',
        kind: 'resumeBlocked',
        path: input.targetDir,
        verify: report,
        formSnapshot: input.formSnapshot,
      });
      return;
    }

    // ④ 核验一致 → 先 svn cleanup（解除中断锁）再 svn update -r pinned
    // --set-depth depth。两个命令都 timeoutMs=0、共用任务的 AbortSignal
    // （取消覆盖整个续检执行）。update 是网络命令按 scheme 注入认证——
    // 续检显式豁免「零写入」前置（svn update 幂等，回调不做目标 emptiness
    // 检查直接弹窗补录重试一次）。
    const { cleanupArgs, updateArgs } = buildResumeArgs(input.targetDir, {
      pinnedRevision: input.pinnedRevision,
      depth: input.depth,
    });
    const parser = new CheckoutProgressParser(
      UPDATE_ENTRY_PREFIXES,
      (text) => task.extra.callbacks.onLogLine?.(text),
      (state) => task.extra.callbacks.onProgress?.(state),
    );
    const sharedOptions = {
      timeoutMs: 0,
      signal: task.abortController.signal,
      ...decodingRunOptions('checkout'),
    } satisfies RunOptions;
    const cleanupBuffer = createLineBuffer(undefined, 'checkout');
    const updateBuffer = createLineBuffer(undefined, 'checkout');
    const updateOptions: RunOptions = {
      ...sharedOptions,
      onStdoutChunk: (chunk) => parser.feed(chunk),
      onOutput: (text) => updateBuffer.push(text),
      onExit: logCommand(svnPath, updateArgs, undefined, 'checkout'),
      onCredentialRetry: (retryArgs) => logCommand(svnPath, retryArgs, undefined, 'checkout'),
    };
    if (schemeAcceptsCredentials(input.url) && task.extra.callbacks.getCredentials) {
      updateOptions.getCredentials = task.extra.callbacks.getCredentials;
    }
    // 命令发出（cleanup 先行）→ task 转 running；记录已由 beginResume 转
    // running，不重复 markPhase（§2.1 续检例外）。
    task.phase = 'running';
    const runPromise = (async () => {
      await runOrThrow(svnPath, cleanupArgs, {
        ...sharedOptions,
        onOutput: (text) => cleanupBuffer.push(text),
        onExit: logCommand(svnPath, cleanupArgs, undefined, 'checkout'),
      });
      await runOrThrow(svnPath, updateArgs, updateOptions);
    })().then(
      () => undefined as unknown,
      (err: unknown) => err as unknown,
    );
    const err = await runPromise;
    parser.finish();
    await settleCommandOutcome(
      task, input.operationId, err, input.targetDir, parser, input.formSnapshot, input.pinnedRevision,
    );
  } catch (err) {
    // 防御收口：意外异常按失败路径回 residue-pending（记录可能已收口，
    // markPhase missing 时跳过），任务对象不悬挂、done 必定结算。
    await registry.markPhase(input.operationId, 'residue-pending').catch(() => undefined);
    settleFinalResult(task, {
      mode: 'checkout',
      kind: 'failed',
      path: input.targetDir,
      detail: errorMessage(err),
      formSnapshot: input.formSnapshot,
    });
  }
}

/* ---------------------------------------------------------------------------
 * 只读核验（§4.4 verifyCheckout：不改记录，结论由调用方按代次守卫处理）
 * ------------------------------------------------------------------------- */

/**
 * 只读核验链：发起时登记「只读命令进行中」（resultScope/epoch 由调用方
 * 捕获传入），执行 verifyResumable 并返回报告。核验不改记录（保持
 * residue-pending，续检/放弃仍以该记录为对象）；结论写入结果页与缓存、
 * 代次守卫与登记结算由调用方（面板控制器）完成——本函数纯执行并返回。
 * 命令异常终止等未产出结论的出口清除登记（不推送重跑）。
 */
export async function verifyCheckoutOnly(input: VerifyCheckoutOnlyInput): Promise<VerifyReport> {
  const svnPath = input.svnPath ?? readSvnPath();
  beginReadonlyVerify('checkout', input.resultScope, input.epoch);
  try {
    return await verifyResumable(svnPath, input.targetDir, input.expectation, {
      timeoutMs: 0,
      ...decodingRunOptions('checkout'),
    });
  } catch (err) {
    clearReadonlyVerify('checkout');
    throw err;
  }
}
