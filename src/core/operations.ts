/**
 * 操作级注册表与未完成操作记录。core 模块，不依赖 vscode。
 *
 * 职责（技术方案 §14.1/§14.2、M3 §2.2）：
 * - 以互斥锁键（lockKey）实现同键单在途写操作：M1/M2 记录 = 规范化
 *   工作副本根路径（旧记录无 lockKey 字段时按 wcRoot 兜底），M3 记录按
 *   kind 各自约定（checkout = 检出目标路径、import = 源目录 realpath、
 *   vacuum = 副本根）；仓库 UUID 只用于节点身份核对，不作为互斥键；
 * - 结果未知（unknown）、已提交待协调、协调被阻止的操作在面板关闭后
 *   仍保持写限制（注册表是进程级单例，限制跨面板生命周期）；
 * - 发出 SVN 写命令前先持久化操作记录；每个已知成功批次立即落盘；
 *   持久化由注入的 OperationStore 承接（globalState / 文件由宿主决定），
 *   写入失败不发起提交；
 * - M3 增量：kind×phase 限制矩阵（begin/loadPending/markPhase/
 *   writeRestriction/pendingFor* 统一按 lockKey 索引）、active 收窄
 *   （residue-pending 与终态记录不产生 busy、记录保留供恢复查询）、
 *   进程内运行登记（hasRunning 专用，模块级单例）、续检正门 beginResume
 *   与 markPhase 持有者防线、终态收口路径与首载陈旧化分诊。
 */
import { join } from 'node:path';

/** 操作状态机：M2 提交语义相位 + M3 新增的命令执行与残留核验相位。 */
export type OperationPhase =
  | 'prepared'
  | 'running'
  | 'residue-pending'
  | 'saving'
  | 'committing'
  | 'failed-unconfirmed'
  | 'unknown'
  | 'committed-pending-coordination'
  | 'coordination-blocked'
  | 'done';

/**
 * 操作类别（M3）：恢复分诊与限制矩阵的维度。
 * checkout = 检出/续检；import = 导入；vacuum = 磁盘清理（P4）；
 * commit/ignore = M2 提交面板/忽略面板；update/cleanup/daily = M1 日常命令。
 * 旧记录无 kind 字段，读取时按 commit 兜底（kindOf）。
 */
export type OperationKind =
  | 'checkout'
  | 'import'
  | 'vacuum'
  | 'commit'
  | 'ignore'
  | 'update'
  | 'cleanup'
  | 'daily';

/** P2 单属性提交的属性载荷：原始/待提交属性的存在与值（值按行原样保留）。 */
export interface PropertyRecord {
  name: string;
  originalExists?: boolean;
  originalValue?: string[];
  pendingExists?: boolean;
  pendingValue?: string[];
}

/** 导入意图的父目录仓库身份快照（连接检查/重检时读取，随 begin 一次定格）。 */
export interface ImportIntentParentIdentity {
  repositoryUuid: string;
  repositoryRootUrl: string;
  lastChangedRevision: number;
}

/**
 * 导入意图（OperationRecord.importIntent 的类型，§4.1）：目标 URL、父目录
 * 身份快照、提交说明原文/hash、命名模式与源快照摘要/引用。内部字段全部
 * 必填（随 begin 一次成型）；OperationRecord.importIntent 本身可选。
 */
export interface ImportIntent {
  /** 目标新目录完整 URL（编码形态）；核实与恢复一律读本字段，不设顶层冗余 url。 */
  targetUrl: string;
  parentIdentity: ImportIntentParentIdentity;
  message: string;
  nameMode: 'auto' | 'manual';
  messageHash: string;
  startedAt: number;
  summary: { fileCount: number; totalBytes: number };
  snapshotDigest: string;
  /** 快照文件相对路径（基准 = globalStorageUri 根，文件名即 operationId）。 */
  fileRefs: string;
}

/** 清理确认时快照（vacuum 专用，随 begin 一次写入）。 */
export interface PristineBefore {
  cacheCount: number;
  unreferencedBytes: number;
  /** 抽查缺失计数（null = 未抽查）。 */
  missingCount: number | null;
}

/** 持久化的操作记录。不含密码/凭据。M3 新增字段一律可选（旧记录没有）。 */
export interface OperationRecord {
  operationId: string;
  /** 规范化工作副本根（realpath 解析符号链接）；M3 记录按 wcRoot=lockKey 约定写入。 */
  wcRoot: string;
  /** 互斥锁键独立字段（M3）：旧记录无此字段时按 wcRoot 兜底读取（lockKeyOf）。 */
  lockKey?: string;
  /** 操作类别（M3）：旧记录无此字段时按 commit 兜底读取（kindOf）。 */
  kind?: OperationKind;
  /** 仓库 UUID：仅用于节点身份核对，不作为互斥键。 */
  repositoryUuid?: string;
  /** 目标相对路径（相对 wcRoot）或 URL。保留原值，不 trim。M3 记录约定为 '.'。 */
  targetRelPath: string;
  nodeKind: 'file' | 'dir';
  /** 发起操作时目标节点的 BASE 修订。 */
  baseRevision?: number;
  property?: PropertyRecord;
  /** P1 批次与显式路径。 */
  explicitPaths?: string[];
  /** 拆批提交中已确认成功的路径（每批追加，与 knownRevisions 同步落盘）：
   * 结果未知核实「已提交」时据此精确回显，不随全量显式路径夸大。 */
  committedPaths?: string[];
  phase: OperationPhase;
  /** 隔离提交用的临时副本位置；临时副本登记为原操作的资源。 */
  tempWcPath?: string;
  /** 已知成功的 revision 列表（每批一个，确认后追加）。 */
  knownRevisions: number[];
  updatedAt: number;
  /* ---------------- M3 固定字段（仅经 BeginOperationParams 随 begin 一次
   * 写入、此后不可变——markPhase 的 patch 白名单不含这些字段） ---------------- */
  /** 仅 checkout：检出源 URL。import 的目标 URL 由 importIntent.targetUrl 承载。 */
  url?: string;
  /** 目标路径（三 kind 统一语义）：checkout 检出目标 / import 源目录 / vacuum 副本根。 */
  targetPath?: string;
  /** 仅 checkout：固定检出修订（执行与续检都用，不重取 HEAD）。 */
  pinnedRevision?: number;
  /** 仅 checkout：检出深度。 */
  depth?: 'empty' | 'files' | 'immediates' | 'infinity';
  /** 仅 checkout：连接检查时快照的仓库身份三元组（与 repositoryUuid 同批落盘）。 */
  repositoryRootUrl?: string;
  relativeUrl?: string;
  /** 仅 import：导入意图（含目标 URL、快照摘要与文件引用）。 */
  importIntent?: ImportIntent;
  /** 仅 vacuum：清理绑定的扫描代次。 */
  scanEpoch?: number;
  /** 仅 vacuum：确认时的 pristine 快照。 */
  pristineBefore?: PristineBefore;
  /** 仅 import：成功路径证据检查发现目标根 action 非 A 时经 markPhase 写入。 */
  outcome?: 'merged';
  /** 仅 import：确认提交的 revision（成功路径证据检查或 unknown 核实，经 markPhase 写入）。 */
  resolvedRevision?: number;
}

/** 持久化接口：宿主注入实现；写失败须抛错，调用方据此不发起提交。 */
export interface OperationStore {
  load(): OperationRecord[] | Promise<OperationRecord[]>;
  save(record: OperationRecord): void | Promise<void>;
  remove(operationId: string): void | Promise<void>;
}

/** 旧记录兜底：无 kind 一律按 commit（提交/忽略共用限制集，语义等价）。 */
export function kindOf(record: Pick<OperationRecord, 'kind'>): OperationKind {
  return record.kind ?? 'commit';
}

/** 旧记录兜底：无 lockKey 按 wcRoot（M1/M2 记录互斥键即副本根）。 */
export function lockKeyOf(record: Pick<OperationRecord, 'lockKey' | 'wcRoot'>): string {
  return record.lockKey ?? record.wcRoot;
}

/**
 * checkout 的互斥锁键：父目录与子目录名经路径归一拼接（path.join），
 * 不是字符串 `+` 拼接——`/p/ab`+`c` 与 `/p/a`+`bc` 字符串拼接会撞成
 * 同一键 `/p/abc`，不同目标共用锁键导致误 busy 与错误恢复匹配。
 * 宿主在 begin 前用本 helper 归一（realpath(父目录) 由调用方先行处理）。
 */
export function checkoutLockKey(parentDir: string, dirName: string): string {
  return join(parentDir, dirName);
}

/** kind → 限制写的相位集合（writeRestriction 口径，§2.2 完整矩阵）。 */
const WRITE_RESTRICTED_PHASES: Readonly<Record<OperationKind, ReadonlySet<OperationPhase>>> = {
  // M2 语义不回归：restrictsWrite 维持源码集合，不含 prepared（prepared 由 busy 判定拦截）。
  commit: new Set(['saving', 'committing', 'unknown', 'committed-pending-coordination', 'coordination-blocked']),
  ignore: new Set(['saving', 'committing', 'unknown', 'committed-pending-coordination', 'coordination-blocked']),
  checkout: new Set(['prepared', 'running']),
  import: new Set(['prepared', 'running', 'unknown']),
  vacuum: new Set(['prepared', 'running', 'unknown']),
  // M1 命令成功/失败都 finally finish、无未知态相位：恒空。
  update: new Set(),
  cleanup: new Set(),
  daily: new Set(),
};

/** kind → 在途相位集合（进程内运行登记与首载陈旧化分诊的判定口径）。 */
const RUNNING_PHASES: Readonly<Record<OperationKind, ReadonlySet<OperationPhase>>> = {
  commit: new Set(['prepared', 'saving', 'committing']),
  ignore: new Set(['prepared', 'saving', 'committing']),
  checkout: new Set(['prepared', 'running']),
  import: new Set(['prepared', 'running']),
  vacuum: new Set(['prepared', 'running']),
  update: new Set(['prepared']),
  cleanup: new Set(['prepared']),
  daily: new Set(['prepared']),
};

/** kind → begin busy 拦截口径（active 收窄维度）= 在途相位 ∪ 限制写相位。 */
const BUSY_PHASES: Readonly<Record<OperationKind, ReadonlySet<OperationPhase>>> = {
  commit: new Set([
    'prepared', 'saving', 'committing', 'unknown', 'committed-pending-coordination', 'coordination-blocked',
  ]),
  ignore: new Set([
    'prepared', 'saving', 'committing', 'unknown', 'committed-pending-coordination', 'coordination-blocked',
  ]),
  checkout: new Set(['prepared', 'running']),
  import: new Set(['prepared', 'running', 'unknown']),
  vacuum: new Set(['prepared', 'running', 'unknown']),
  update: new Set(['prepared']),
  cleanup: new Set(['prepared']),
  daily: new Set(['prepared']),
};

/** markPhase patch 按 kind 的可变字段白名单（M2 基础集合 + import 增量）。 */
const PATCHABLE_FIELDS: Readonly<Record<OperationKind, ReadonlySet<string>>> = {
  // M2 白名单对全部 kind 保留（M1/M2 既有调用不变）。
  commit: new Set(['knownRevisions', 'tempWcPath', 'baseRevision', 'committedPaths']),
  ignore: new Set(['knownRevisions', 'tempWcPath', 'baseRevision', 'committedPaths']),
  update: new Set(['knownRevisions', 'tempWcPath', 'baseRevision', 'committedPaths']),
  cleanup: new Set(['knownRevisions', 'tempWcPath', 'baseRevision', 'committedPaths']),
  daily: new Set(['knownRevisions', 'tempWcPath', 'baseRevision', 'committedPaths']),
  checkout: new Set(['knownRevisions', 'tempWcPath', 'baseRevision', 'committedPaths']),
  // import 追加 outcome/resolvedRevision（成功路径证据检查与 unknown 核实的结论落盘）。
  import: new Set(['knownRevisions', 'tempWcPath', 'baseRevision', 'committedPaths', 'outcome', 'resolvedRevision']),
  vacuum: new Set(['knownRevisions', 'tempWcPath', 'baseRevision', 'committedPaths']),
};

/** 该记录是否限制同一互斥键上的新写操作（按 kind×phase 矩阵判定）。 */
export function restrictsWrite(record: OperationRecord): boolean {
  return WRITE_RESTRICTED_PHASES[kindOf(record)].has(record.phase);
}

/** 该记录是否以 busy 口径拦截同键 begin（active 收窄维度）。 */
function blocksBegin(record: OperationRecord): boolean {
  return BUSY_PHASES[kindOf(record)].has(record.phase);
}

/* --------------------------------------------------------------------------------
 * 进程内运行登记（模块级单例，不随 registry 实例重建丢失——initializeOperationStore
 * 每次 activate 都 new OperationRegistry，实例字段会随实例重建丢失）。
 * 「在途」只按 RUNNING_PHASES 显式集合判定，不从持久化记录 phase 推断：
 * 重启后登记为空，上一会话残留的在途记录不判 busy（由 loadPending 首载
 * 按 kind 分诊承担）。不含 unknown/协调态（结果未决冻结只进 writeLocked）。
 * -------------------------------------------------------------------------------- */
const runningOperations = new Set<string>();

/**
 * 第三种登记点：命令执行期临时登记（如 M2 忽略协调的 svn update 实际
 * 运行窗口）。执行期登记、结束（成功/失败）清除；协调态相位本身不判
 * busy（在途集合不变），只是命令实际运行的几秒 hasRunning=true。
 */
export async function runWithRunningKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  runningOperations.add(key);
  try {
    return await fn();
  } finally {
    runningOperations.delete(key);
  }
}

/** 测试专用：清空进程内运行登记。vitest 用例在 beforeEach 调用，
 * 防止失败路径的残留键污染后续 loadPending 分诊用例。 */
export function resetRunningOperationsForTest(): void {
  runningOperations.clear();
}

export interface BeginOperationParams {
  wcRoot: string;
  targetRelPath: string;
  nodeKind: 'file' | 'dir';
  repositoryUuid?: string;
  baseRevision?: number;
  property?: OperationRecord['property'];
  explicitPaths?: string[];
  now?: number;
  /* ---------------- M3 接口增量：kind/lockKey/operationId 与全部固定字段。
   * begin 把传入 lockKey 与各固定字段原样复制进记录（可选参数不传即不写
   * 该字段），并按 wcRoot=lockKey 约定写记录 wcRoot；不传 lockKey 的
   * M1/M2 调用点记录 wcRoot 用入参 wcRoot，行为不变。 ---------------- */
  kind?: OperationKind;
  lockKey?: string;
  /** 宿主预生成的记录 ID：begin 沿用（不另生成）并与全量记录做唯一性校验。 */
  operationId?: string;
  url?: string;
  targetPath?: string;
  pinnedRevision?: number;
  depth?: OperationRecord['depth'];
  repositoryRootUrl?: string;
  relativeUrl?: string;
  importIntent?: ImportIntent;
  scanEpoch?: number;
  pristineBefore?: PristineBefore;
}

/**
 * begin/beginResume 的结果。失败分支按 reason 判别：
 * - busy：同键被在途/受限记录占用（带 heldBy）；
 * - idConflict：传入 operationId 与既有记录撞车（仅 begin 返回；
 *   调用方收到即删除已落盘快照、不发起命令）；
 * - recordUnavailable：记录不存在/已终态/ID 不匹配（仅 beginResume 返回，
 *   非占用、无 heldBy 可带）。
 * 不写成可选 heldBy 的单一形态——否则 busy 读取点读 heldBy.phase 会被
 * TS 判 possibly undefined。
 */
export type BeginResult =
  | { ok: true; operationId: string; record: OperationRecord }
  | { ok: false; reason: 'busy'; heldBy: OperationRecord }
  | { ok: false; reason: 'idConflict' }
  | { ok: false; reason: 'recordUnavailable' };

/** markPhase 的 patch 白名单全集（按 kind 过滤后生效）。 */
export interface MarkPhasePatch {
  knownRevisions?: number[];
  tempWcPath?: string;
  baseRevision?: number;
  committedPaths?: string[];
  outcome?: 'merged';
  resolvedRevision?: number;
}

/** markPhase 结果：成功返回改写后记录；占用冲突带持有者；记录缺失为 missing。 */
export type MarkPhaseResult =
  | { ok: true; record: OperationRecord }
  | { ok: false; reason: 'conflict'; heldBy: OperationRecord }
  | { ok: false; reason: 'missing' };

/** 记录 ID 生成器（`op-` 前缀 + 时间戳/随机段）；宿主预生成 operationId 时共用。 */
export function randomOperationId(): string {
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 按 kind 白名单过滤 patch：白名单外字段（如 M3 固定字段）无补写通道。 */
function filterPatch(kind: OperationKind, patch: MarkPhasePatch): MarkPhasePatch {
  const allowed = PATCHABLE_FIELDS[kind];
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (allowed.has(key) && value !== undefined) {
      filtered[key] = value;
    }
  }
  return filtered as MarkPhasePatch;
}

/**
 * 进程级操作注册表。同键互斥 + 未完成记录；重复 finish/remove 幂等。
 * 互斥范围只覆盖本扩展发起的操作：外部 SVN 客户端无法由注册表互斥，
 * 各流程仍须在关键步骤前重读节点身份（由调用方负责，见 §14.2）。
 */
export class OperationRegistry {
  private readonly store?: OperationStore;
  /** 互斥键（lockKey，旧记录兜底 wcRoot）→ 在途或限制写的记录（active 收窄后）。 */
  private readonly active = new Map<string, OperationRecord>();
  /** 全部未完成记录（含历史限制与 residue-pending），供恢复与查询。 */
  private readonly records = new Map<string, OperationRecord>();

  constructor(store?: OperationStore) {
    this.store = store;
  }

  /**
   * 启动/重新打开目标时调用：加载未完成记录、恢复限制并做首载分诊。
   * active 收窄幂等、对运行登记中的键跳过陈旧化（同进程二次 activate 的
   * 在途记录不被改写）；重启模拟/预置记录（登记无键）照常按 kind 折算：
   * - update/cleanup/daily 的 prepared → failed-unconfirmed 后随即移除
   *   （可安全重跑，不经 M2 面板核实、不冒充结论）+ 日志一行；
   * - commit/ignore（含无 kind 兜底）的 prepared/saving/committing →
   *   unknown 落盘（命令可能已发出，不以相位猜测「未发出」；不直接移除）；
   * - checkout 的 prepared/running → residue-pending；
   * - import/vacuum 的 prepared/running → unknown。
   * residue-pending 与 done/failed-unconfirmed 不进 active（记录仍留
   * records/globalState 供恢复查询）；M3 kind 的终态残留（kill 落在
   * markPhase 终态与 finish 之间）顺带 finish 清理——M2 kind 的终态记录
   * 维持源码现状（跳过但保留在 globalState）。
   */
  async loadPending(): Promise<void> {
    if (!this.store) {
      return;
    }
    // 新→旧排序：同键多条陈旧在途记录（跨窗口并发的脏数据）时，最新者先
    // 折算并持有 active，较旧者折算会被 markPhase 持有者防线拒绝而跳过。
    const loaded = [...(await this.store.load())].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const record of loaded) {
      const kind = kindOf(record);
      const key = lockKeyOf(record);
      if (record.phase === 'done' || record.phase === 'failed-unconfirmed') {
        if (kind === 'checkout' || kind === 'import' || kind === 'vacuum') {
          // M3 终态收口的残留清理（幂等）：终态记录不保留在 globalState。
          await this.store.remove(record.operationId);
        }
        continue;
      }
      this.records.set(record.operationId, record);
      const inFlight = RUNNING_PHASES[kind].has(record.phase);
      if (inFlight && !runningOperations.has(key)) {
        if (kind === 'update' || kind === 'cleanup' || kind === 'daily') {
          // M1 命令可安全重跑：转终态后随即移除，不冒充任何结论。
          await this.markPhase(record.operationId, 'failed-unconfirmed');
          await this.finish(record.operationId);
          const line = `[svn-anywhere] 重启分诊：${kind} 操作 ${record.operationId}（${key}）未完成，已按可安全重跑移除记录`;
          (triageLogSink ?? ((message: string) => console.log(message)))(line);
          continue;
        }
        const folded: OperationPhase = kind === 'checkout' ? 'residue-pending' : 'unknown';
        const result = await this.markPhase(record.operationId, folded);
        if (!result.ok && result.reason === 'conflict') {
          // 同键已有更新的持有者：较旧记录跳过折算（保留在 records 供查询）。
          continue;
        }
        continue;
      }
      // active 收窄（幂等）：只有按矩阵产生 busy/写限制的记录进入 active。
      if (blocksBegin(record)) {
        const held = this.active.get(key);
        if (!held || held.updatedAt < record.updatedAt) {
          this.active.set(key, record);
        }
      }
    }
  }

  /**
   * 开始一个写操作：同键有在途/受限记录（busy 口径）时拒绝；传入
   * operationId 时先与全量记录（含终态——内存 records 不含，必须读
   * store 全量）做唯一性校验，冲突返回 idConflict；通过后立即持久化。
   * M3 记录按 wcRoot=lockKey 约定写记录 wcRoot，lockKey 与各固定字段
   * 原样复制（此后不可变）。
   */
  async begin(params: BeginOperationParams): Promise<BeginResult> {
    const key = params.lockKey ?? params.wcRoot;
    const heldBy = this.active.get(key);
    if (heldBy && blocksBegin(heldBy)) {
      return { ok: false, reason: 'busy', heldBy };
    }
    let operationId = params.operationId;
    if (operationId) {
      const existing = this.store ? await this.store.load() : [...this.records.values()];
      if (existing.some((item) => item.operationId === operationId) || this.records.has(operationId)) {
        return { ok: false, reason: 'idConflict' };
      }
    } else {
      operationId = randomOperationId();
    }
    const record: OperationRecord = {
      operationId,
      // 传 lockKey 时记录 wcRoot=lockKey（互斥键与 wcRoot 同值，P4 的
      // writeRestriction(wcRoot) 对 M3 记录照常命中）；不传时用入参 wcRoot。
      wcRoot: params.lockKey ?? params.wcRoot,
      repositoryUuid: params.repositoryUuid,
      targetRelPath: params.targetRelPath,
      nodeKind: params.nodeKind,
      baseRevision: params.baseRevision,
      property: params.property,
      explicitPaths: params.explicitPaths,
      phase: 'prepared',
      knownRevisions: [],
      updatedAt: params.now ?? Date.now(),
      kind: params.kind,
      lockKey: params.lockKey,
      url: params.url,
      targetPath: params.targetPath,
      pinnedRevision: params.pinnedRevision,
      depth: params.depth,
      repositoryRootUrl: params.repositoryRootUrl,
      relativeUrl: params.relativeUrl,
      importIntent: params.importIntent,
      scanEpoch: params.scanEpoch,
      pristineBefore: params.pristineBefore,
    };
    await this.store?.save(record);
    this.records.set(record.operationId, record);
    this.active.set(key, record);
    // prepared 是全部 kind 的在途相位：begin 成功即登记运行键。
    runningOperations.add(key);
    return { ok: true, operationId: record.operationId, record };
  }

  /**
   * 更新阶段与增量字段；结果未知/待协调等限制态记录同样落盘。
   * patch 按 kind 白名单过滤（固定字段无补写通道）。目标相位不产生
   * busy/写限制（residue-pending/done/failed-unconfirmed）时从 active
   * 删除该持有记录（记录保留在 records/globalState 并照常 save）；
   * 产生 busy/写限制时先过持有者防线——该键 active 已持有另一个
   * operationId 则拒绝改写返回冲突（杜绝任何路径静默覆盖他人记录）。
   */
  async markPhase(
    operationId: string,
    phase: OperationPhase,
    patch: MarkPhasePatch = {},
    now?: number,
  ): Promise<MarkPhaseResult> {
    const record = this.records.get(operationId);
    if (!record) {
      return { ok: false, reason: 'missing' };
    }
    const kind = kindOf(record);
    const filtered = filterPatch(kind, patch);
    const next: OperationRecord = {
      ...record,
      ...filtered,
      knownRevisions: filtered.knownRevisions ?? record.knownRevisions,
      phase,
      updatedAt: now ?? Date.now(),
    };
    const key = lockKeyOf(next);
    const restrictedTarget = blocksBegin(next);
    if (restrictedTarget) {
      const held = this.active.get(key);
      if (held && held.operationId !== operationId) {
        return { ok: false, reason: 'conflict', heldBy: held };
      }
    }
    this.records.set(operationId, next);
    if (restrictedTarget) {
      this.active.set(key, next);
    } else if (this.active.get(key)?.operationId === operationId) {
      this.active.delete(key);
    }
    // 运行登记双向挂钩：转入在途相位补登记（覆盖续检 markPhase('running')——
    // residue-pending 期间登记已清）；转出在途相位清除（同会话进入 unknown/
    // 协调态后不调 finish，清除必须挂 markPhase，否则键残留、P4 永久 busy）。
    const wasRunning = RUNNING_PHASES[kind].has(record.phase);
    const isRunning = RUNNING_PHASES[kind].has(phase);
    if (isRunning) {
      runningOperations.add(key);
    } else if (wasRunning) {
      // 仅当该记录确在在途时清除：residue-pending 等非在途记录本就未登记，
      // 不会误清同键另一在途记录的登记（在途必在 active、同键唯一持有）。
      runningOperations.delete(key);
    }
    await this.store?.save(next);
    return { ok: true, record: next };
  }

  /**
   * 终态收口路径（M3 通用规则）：凡出口落 done 或落 failed-unconfirmed
   * 且语义为「解除限制、允许重新发起」，markPhase 落终态后随即 finish
   * 移除记录（active 与 records 双清、store.remove）。M3 各业务出口经
   * 本方法一步完成；kill 落在 markPhase 与 finish 之间的残留由
   * loadPending 顺带清理。M2 记录的终态保留语义不受影响（M2 调用方
   * 不走本路径）。
   */
  async finalizeOperation(
    operationId: string,
    phase: 'done' | 'failed-unconfirmed',
    patch: MarkPhasePatch = {},
    now?: number,
  ): Promise<void> {
    await this.markPhase(operationId, phase, patch, now);
    await this.finish(operationId);
  }

  /** 操作彻底结束（协调完成等）后移除记录；幂等；未登记的 ID 忽略。 */
  async finish(operationId: string | undefined): Promise<void> {
    if (!operationId) {
      return;
    }
    const record = this.records.get(operationId);
    if (record) {
      const key = lockKeyOf(record);
      if (this.active.get(key)?.operationId === operationId) {
        this.active.delete(key);
      }
      if (RUNNING_PHASES[kindOf(record)].has(record.phase)) {
        runningOperations.delete(key);
      }
      this.records.delete(operationId);
    }
    await this.store?.remove(operationId);
  }

  /** 查询互斥键当前是否处于写限制（unknown/待协调/在途提交等，按 kind×phase）。 */
  writeRestriction(wcRoot: string): OperationRecord | undefined {
    const held = this.active.get(wcRoot);
    return held && restrictsWrite(held) ? held : undefined;
  }

  /** 互斥键上未完成的全部记录（含限制态与 residue-pending），供恢复入口展示。 */
  pendingForWcRoot(wcRoot: string): OperationRecord[] {
    return [...this.records.values()].filter((record) => lockKeyOf(record) === wcRoot && record.phase !== 'done');
  }

  /** 该键是否存在 busy 拦截口径的在途/受限记录（与 begin 的 busy 判定一致）。 */
  hasActive(wcRoot: string): boolean {
    const held = this.active.get(wcRoot);
    return held !== undefined && blocksBegin(held);
  }

  /** 该键是否在本宿主进程的运行登记中（P4 busy 专用；不含 unknown/协调态）。 */
  hasRunning(wcRoot: string): boolean {
    return runningOperations.has(wcRoot);
  }

  /**
   * 全量记录（含终态）：idConflict 唯一性校验与宿主孤儿快照清理的对照
   * 数据源。注册表现有查询都按键取、无全量入口，宿主经本方法获取，
   * 不自造第二条存储读取路径。
   */
  async loadAllRecords(): Promise<OperationRecord[]> {
    return this.store ? await this.store.load() : [...this.records.values()];
  }

  /**
   * 续检转 running 相位的唯一正门：原子完成「记录核验（存在且
   * residue-pending 且 ID 匹配）∧ hasActive 无他人持有 ∧ writeRestriction
   * 未命中 ∧ hasRunning 未命中 → markPhase('running')（登记由挂钩补上）」。
   * 占用返回 busy（带 heldBy）且不改相位不登记；记录不可用（不存在/已
   * 终态/ID 不匹配，非占用）返回 recordUnavailable（不带 heldBy）。
   * 同步临界区内先判后改即原子；不经裸 markPhase('running') 改相位。
   */
  async beginResume(operationId: string, lockKey: string): Promise<BeginResult> {
    const record = this.records.get(operationId);
    if (!record || record.phase !== 'residue-pending' || lockKeyOf(record) !== lockKey) {
      return { ok: false, reason: 'recordUnavailable' };
    }
    const held = this.active.get(lockKey);
    if (held && blocksBegin(held)) {
      return { ok: false, reason: 'busy', heldBy: held };
    }
    const restriction = this.writeRestriction(lockKey);
    if (restriction) {
      return { ok: false, reason: 'busy', heldBy: restriction };
    }
    if (runningOperations.has(lockKey)) {
      // 运行登记命中（如忽略协调 update 的命令执行期临时登记）。
      // 临时登记窗口内同键通常仍有记录（协调态），以最新者充当 heldBy。
      const fallback =
        held ??
        [...this.records.values()]
          .filter((item) => lockKeyOf(item) === lockKey)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      return { ok: false, reason: 'busy', heldBy: fallback ?? record };
    }
    const result = await this.markPhase(operationId, 'running');
    if (!result.ok) {
      // 判定与改写之间理论上的并发窗口：按对应失败分支返回，相位未改。
      return result.reason === 'conflict'
        ? { ok: false, reason: 'busy', heldBy: result.heldBy }
        : { ok: false, reason: 'recordUnavailable' };
    }
    return { ok: true, operationId, record: result.record };
  }
}

/** 进程级单例：面板与命令入口共用同一注册表。 */
let globalRegistry: OperationRegistry | undefined;

export function getOperationRegistry(): OperationRegistry {
  globalRegistry ??= new OperationRegistry();
  return globalRegistry;
}

/** 宿主注入持久化实现并加载未完成记录（恢复写限制）。 */
export function setGlobalOperationRegistry(registry: OperationRegistry): void {
  globalRegistry = registry;
}

/** 测试用：替换/重置进程级注册表（运行登记另见 resetRunningOperationsForTest）。 */
export function setOperationRegistryForTest(registry?: OperationRegistry): void {
  globalRegistry = registry;
}

/** globalState 风格的最小持久化接口（不依赖 vscode 类型）。 */
export interface MementoLike {
  get<T>(key: string, defaultValue?: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

const OPERATIONS_KEY = 'svnAnywhere.operations';

/**
 * M1 分诊日志的注入钩子（core 不依赖 vscode，输出频道由 host 注入——
 * activate 时接到 update 频道的 logLine；未注入（单测/无宿主）回退
 * console，保持既有可观测性下限）。
 */
let triageLogSink: ((line: string) => void) | undefined;

/** 注入/卸载分诊日志出口（传 undefined 卸载）。 */
export function setOperationTriageLogSink(sink: ((line: string) => void) | undefined): void {
  triageLogSink = sink;
}

/**
 * 用宿主 globalState 构造操作存储并初始化全局注册表：activate 时调用。
 * loadPending 的 active 收窄幂等、对运行登记中的键跳过陈旧化，重跑无害。
 */
export async function initializeOperationStore(memento: MementoLike): Promise<void> {
  const store: OperationStore = {
    load: () => memento.get<OperationRecord[]>(OPERATIONS_KEY, []),
    async save(record) {
      const records = memento.get<OperationRecord[]>(OPERATIONS_KEY, []);
      const index = records.findIndex((item) => item.operationId === record.operationId);
      if (index >= 0) {
        records[index] = record;
      } else {
        records.push(record);
      }
      await memento.update(OPERATIONS_KEY, records);
    },
    async remove(operationId) {
      const records = memento.get<OperationRecord[]>(OPERATIONS_KEY, []);
      await memento.update(OPERATIONS_KEY, records.filter((item) => item.operationId !== operationId));
    },
  };
  const registry = new OperationRegistry(store);
  await registry.loadPending();
  setGlobalOperationRegistry(registry);
}
