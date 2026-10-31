/**
 * 操作级注册表与未完成操作记录（框架）。core 模块，不依赖 vscode。
 *
 * 职责（技术方案 §14.1/§14.2）：
 * - 以「规范化的本地工作副本根路径」为互斥键：同一工作副本同时只允许
 *   一个在途写操作；仓库 UUID 只用于节点身份核对，不作为互斥键；
 * - 结果未知（unknown）、已提交待协调、协调被阻止的操作在面板关闭后
 *   仍保持写限制（注册表是进程级单例，限制跨面板生命周期）；
 * - 发出 SVN 写命令前先持久化操作记录；每个已知成功批次立即落盘；
 *   持久化由注入的 OperationStore 承接（globalState / 文件由宿主决定），
 *   写入失败不发起提交。
 *
 * 阶段 0 落框架与内存语义；P1/P2 在阶段 1/2 接入真实流程与恢复加载。
 */

/** 操作状态机：准备/本地保存 → 提交中 → 确认未提交的失败 / 结果未知 / 已提交待协调 / 协调被阻止 / 已完成。 */
export type OperationPhase =
  | 'prepared'
  | 'saving'
  | 'committing'
  | 'failed-unconfirmed'
  | 'unknown'
  | 'committed-pending-coordination'
  | 'coordination-blocked'
  | 'done';

/** 持久化的操作记录。不含密码/凭据。 */
export interface OperationRecord {
  operationId: string;
  /** 规范化工作副本根（realpath 解析符号链接后的互斥键）。 */
  wcRoot: string;
  /** 仓库 UUID：仅用于节点身份核对，不作为互斥键。 */
  repositoryUuid?: string;
  /** 目标相对路径（相对 wcRoot）或 URL。保留原值，不 trim。 */
  targetRelPath: string;
  nodeKind: 'file' | 'dir';
  /** 发起操作时目标节点的 BASE 修订。 */
  baseRevision?: number;
  /** P2 单属性提交：原始/待提交属性的存在与值（值按行原样保留）。 */
  property?: { name: string; originalExists?: boolean; originalValue?: string[]; pendingExists?: boolean; pendingValue?: string[] };
  /** P1 批次与显式路径。 */
  explicitPaths?: string[];
  phase: OperationPhase;
  /** 隔离提交用的临时副本位置；临时副本登记为原操作的资源。 */
  tempWcPath?: string;
  /** 已知成功的 revision 列表（每批一个，确认后追加）。 */
  knownRevisions: number[];
  updatedAt: number;
}

/** 持久化接口：宿主注入实现；写失败须抛错，调用方据此不发起提交。 */
export interface OperationStore {
  load(): OperationRecord[] | Promise<OperationRecord[]>;
  save(record: OperationRecord): void | Promise<void>;
  remove(operationId: string): void | Promise<void>;
}

/** 该记录是否限制同一工作副本上的新写操作。 */
export function restrictsWrite(record: OperationRecord): boolean {
  return (
    record.phase === 'unknown' ||
    record.phase === 'committed-pending-coordination' ||
    record.phase === 'coordination-blocked' ||
    record.phase === 'saving' ||
    record.phase === 'committing'
  );
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
}

export type BeginResult =
  | { ok: true; operationId: string; record: OperationRecord }
  | { ok: false; reason: 'busy'; heldBy: OperationRecord };

function randomOperationId(): string {
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 进程级操作注册表。同键互斥 + 未完成记录；重复 finish/remove 幂等。
 * 互斥范围只覆盖本扩展发起的操作：外部 SVN 客户端无法由注册表互斥，
 * 各流程仍须在关键步骤前重读节点身份（由调用方负责，见 §14.2）。
 */
export class OperationRegistry {
  private readonly store?: OperationStore;
  /** 互斥键（规范化 wcRoot）→ 在途或限制写的记录。 */
  private readonly active = new Map<string, OperationRecord>();
  /** 全部未完成记录（含历史限制），供恢复与查询。 */
  private readonly records = new Map<string, OperationRecord>();

  constructor(store?: OperationStore) {
    this.store = store;
  }

  /**
   * 启动/重新打开目标时调用：加载未完成记录并恢复限制。
   * 已完成（done / 确认未提交的失败）的记录不进入限制集合。
   */
  async loadPending(): Promise<void> {
    if (!this.store) {
      return;
    }
    const loaded = await this.store.load();
    for (const record of loaded) {
      if (record.phase === 'done' || record.phase === 'failed-unconfirmed') {
        continue;
      }
      this.records.set(record.operationId, record);
      const held = this.active.get(record.wcRoot);
      if (!held || held.updatedAt < record.updatedAt) {
        this.active.set(record.wcRoot, record);
      }
    }
  }

  /** 开始一个写操作：同副本有在途/受限操作时拒绝；通过后立即持久化。 */
  async begin(params: BeginOperationParams): Promise<BeginResult> {
    const heldBy = this.active.get(params.wcRoot);
    if (heldBy && heldBy.phase !== 'done' && heldBy.phase !== 'failed-unconfirmed') {
      return { ok: false, reason: 'busy', heldBy };
    }
    const record: OperationRecord = {
      operationId: randomOperationId(),
      wcRoot: params.wcRoot,
      repositoryUuid: params.repositoryUuid,
      targetRelPath: params.targetRelPath,
      nodeKind: params.nodeKind,
      baseRevision: params.baseRevision,
      property: params.property,
      explicitPaths: params.explicitPaths,
      phase: 'prepared',
      knownRevisions: [],
      updatedAt: params.now ?? Date.now(),
    };
    await this.store?.save(record);
    this.records.set(record.operationId, record);
    this.active.set(params.wcRoot, record);
    return { ok: true, operationId: record.operationId, record };
  }

  /** 更新阶段与增量字段；结果未知/待协调等限制态记录同样落盘。 */
  async markPhase(
    operationId: string,
    phase: OperationPhase,
    patch: Partial<Pick<OperationRecord, 'knownRevisions' | 'tempWcPath' | 'baseRevision'>> = {},
    now?: number,
  ): Promise<OperationRecord | undefined> {
    const record = this.records.get(operationId);
    if (!record) {
      return undefined;
    }
    const next: OperationRecord = {
      ...record,
      ...patch,
      knownRevisions: patch.knownRevisions ?? record.knownRevisions,
      phase,
      updatedAt: now ?? Date.now(),
    };
    this.records.set(operationId, next);
    // done / 确认未提交失败才解除互斥；unknown 等限制态保留在 active。
    if (phase === 'done' || phase === 'failed-unconfirmed') {
      if (this.active.get(next.wcRoot)?.operationId === operationId) {
        this.active.delete(next.wcRoot);
      }
    } else {
      this.active.set(next.wcRoot, next);
    }
    await this.store?.save(next);
    return next;
  }

  /** 操作彻底结束（协调完成等）后移除记录；幂等。 */
  async finish(operationId: string): Promise<void> {
    const record = this.records.get(operationId);
    if (record) {
      if (this.active.get(record.wcRoot)?.operationId === operationId) {
        this.active.delete(record.wcRoot);
      }
      this.records.delete(operationId);
    }
    await this.store?.remove(operationId);
  }

  /** 查询副本当前是否处于写限制（unknown/待协调/在途提交等）。 */
  writeRestriction(wcRoot: string): OperationRecord | undefined {
    const held = this.active.get(wcRoot);
    return held && restrictsWrite(held) ? held : undefined;
  }

  /** 副本上未完成的全部记录（含限制态），供恢复入口展示。 */
  pendingForWcRoot(wcRoot: string): OperationRecord[] {
    return [...this.records.values()].filter((record) => record.wcRoot === wcRoot && record.phase !== 'done');
  }
}

/** 进程级单例：面板与命令入口共用同一注册表。 */
let globalRegistry: OperationRegistry | undefined;

export function getOperationRegistry(): OperationRegistry {
  globalRegistry ??= new OperationRegistry();
  return globalRegistry;
}

/** 测试用：替换/重置进程级注册表。 */
export function setOperationRegistryForTest(registry?: OperationRegistry): void {
  globalRegistry = registry;
}
