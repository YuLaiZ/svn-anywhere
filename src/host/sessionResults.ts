/**
 * 面板会话结果缓存与只读命令进行中登记：宿主侧独立内存态。
 *
 * 结果缓存是「当前结果页的镜像」，不是任务终态的一次性快照：任务终态
 * 与面板内的结果转移（核验/核实结论、确认合并后的收尾页、续检前重核验
 * 失败的阻止页等）都写入；离开结果页回到表单的动作清除。缓存按面板
 * 类别单槽键控（检出/导入共用面板不互删缓存），缓存项显式携带目标
 * 作用域——单槽只隔离面板类别，不等于可跨目标/跨模式恢复：恢复读取
 * 先过作用域一致性校验，不一致即丢弃该缓存项。
 *
 * 缓存不挂面板控制器实例、不写持久化存储：面板关闭后任务后台完成仍有
 * 写入者（执行器与面板生命周期解耦）；扩展宿主重启后随内存消失。
 *
 * 只读命令进行中登记承载「重开先于结论完成」的送达：核验/核实（只读
 * 但可能数十秒的命令链）发起时登记，重开会话恢复到旧结果页时按登记
 * 附「进行中」提示，用户可保持打开等待自动转结论页。
 *
 * M4 增补 m4SessionStore：P5/P6/P7 的目标状态不能塞进上面的 M3 单槽
 * （单槽按面板类别键控，会互相覆盖），改按 scopeKind + identity 多槽
 * 保存并设 LRU 上限（24 项）。M3 的 checkout/disk 单槽规则不变，两套
 * 存储互不影响：M4 的 P6/P7 终态页、可浏览状态、upper 三字段与
 * historyLimitState、P7 冲突快照/推迟/已解决台账全部落在 m4SessionStore。
 */
import {
  findTaskByScope,
  sameResultScope,
  type ConflictsResultScope,
  type HistoryResultScope,
  type PanelKind,
  type ResultScope,
} from './taskRegistry';

/** 缓存项：结果页数据 + 写入时的目标作用域。结果页形状由面板任务定义。 */
export interface SessionResultEntry {
  resultScope: ResultScope;
  page: unknown;
}

/**
 * 写入者分类：
 * - controller：面板内结果转移的控制器写入——可能是迟到的过期结论，
 *   受写侧作用域校验约束（见 writeSessionResult）；
 * - executor：任务执行器的终态写入——当前真实运行任务的结算，一律写入。
 */
export type SessionResultWriter = 'controller' | 'executor';

const results = new Map<PanelKind, SessionResultEntry>();

/**
 * 写入结果缓存（执行器终态结算与面板内结果转移的同一接口）。
 *
 * 写侧作用域校验（按写入者分类）：controller 写入仅当缓存槽为空、或槽
 * 内项的作用域与本次捕获的作用域一致才写入——槽内已有其他作用域的
 * 结果页（新任务终态或新会话已写入）时丢弃本次写入，迟到结论不得跨
 * 作用域覆盖他人结果。executor 写入不受该校验限制、一律写入：任务
 * 真实运行期间面板 busy、无用户可达的冲突动作，终态必为最新结果上下
 * 文，槽内旧页只能是更早的过期结论。
 *
 * 返回是否真正写入（controller 可据此区分送达与守卫丢弃）。
 */
export function writeSessionResult(
  panelKind: PanelKind,
  resultScope: ResultScope,
  page: unknown,
  writer: SessionResultWriter,
): boolean {
  if (writer === 'controller') {
    const existing = results.get(panelKind);
    if (existing && !sameResultScope(existing.resultScope, resultScope)) {
      return false;
    }
  }
  results.set(panelKind, { resultScope, page });
  return true;
}

/**
 * 读取结果缓存（会话恢复第②段）：缓存命中先过作用域一致性校验。
 * 作用域基准 = 会话绑定任务时取任务的 resultScope、否则本次打开入口
 * （面板任务负责传入正确基准）。不一致说明缓存属于另一目标/模式，
 * 丢弃该缓存项并返回 undefined——恢复流程继续走后续段（未终态记录
 * 分诊、草稿、新表单）。
 */
export function readSessionResult(
  panelKind: PanelKind,
  baseline: ResultScope,
): SessionResultEntry | undefined {
  const entry = results.get(panelKind);
  if (!entry) {
    return undefined;
  }
  if (!sameResultScope(entry.resultScope, baseline)) {
    results.delete(panelKind);
    return undefined;
  }
  return entry;
}

/**
 * 清除结果缓存（离开结果页回表单的动作、以及续检发起时清除被运行态
 * 取代的旧结果页）。不带作用域时无条件清空该面板的槽；带作用域时仅
 * 当槽内项与之匹配才清——跨作用域不清（与写侧校验对称，防误清其他
 * 目标已写入的结果页）。返回是否发生了清除。
 */
export function clearSessionResult(panelKind: PanelKind, scope?: ResultScope): boolean {
  if (scope) {
    const entry = results.get(panelKind);
    if (!entry || !sameResultScope(entry.resultScope, scope)) {
      return false;
    }
  }
  return results.delete(panelKind);
}

/* --------------------- 只读命令进行中登记与结论送达 --------------------- */

/**
 * 只读核验/核实（如 verifyCheckout/verifyImport）进行中登记项：发起时
 * 捕获的目标作用域与结果代次。作用域防止把 A 入口发起的核验提示挂到
 * 从 B 入口恢复的结果页；代次防止把旧核验的进行中提示挂到同作用域新
 * 任务的结果页（新任务发起会递增代次，旧登记的代次随之过期）。
 */
export interface ReadonlyVerifyPending {
  resultScope: ResultScope;
  epoch: number;
}

const pendingVerifies = new Map<PanelKind, ReadonlyVerifyPending>();
const resultUpdatedCallbacks = new Map<PanelKind, Array<() => void>>();

/**
 * 登记只读命令进行中（发起核验/核实时写入）。同面板类别同时只有一个
 * 登记位：结果页动作集保证不可达并发，重复登记按覆盖处理。
 */
export function beginReadonlyVerify(panelKind: PanelKind, resultScope: ResultScope, epoch: number): void {
  pendingVerifies.set(panelKind, { resultScope, epoch });
}

/**
 * 登记命中判定（重开会话恢复结果页时附「核验/核实进行中」提示的条件）：
 * 登记作用域与恢复页的作用域基准一致，且登记代次与恢复页当前结果代次
 * 一致。作用域或代次不一致的登记既不附提示、也不清除——其结论仍会
 * 返回并送达所属作用域。提示横幅的构造由面板任务完成，本接口只给布尔。
 */
export function matchReadonlyVerify(
  panelKind: PanelKind,
  baseline: ResultScope,
  currentEpoch: number,
): boolean {
  const pending = pendingVerifies.get(panelKind);
  if (!pending) {
    return false;
  }
  return sameResultScope(pending.resultScope, baseline) && pending.epoch === currentEpoch;
}

/**
 * 结算只读命令登记（结论写入缓存或被守卫丢弃后调用）：
 * - conclusionWritten=true（结论已写入缓存）：清除登记，并向当前同
 *   面板类别存活会话推送一次重跑（重开会话正停在带提示的旧结果页，
 *   重跑后落缓存中的结论页）；
 * - conclusionWritten=false（结论被代次守卫丢弃）：只清除登记、不推送
 *   ——丢弃即无新页可送，登记清除后重开会话不再显示进行中提示。
 */
export function settleReadonlyVerify(panelKind: PanelKind, conclusionWritten: boolean): void {
  const had = pendingVerifies.delete(panelKind);
  if (!had || !conclusionWritten) {
    return;
  }
  notifyResultUpdated(panelKind);
}

/**
 * 清除只读命令登记（命令异常终止等未产出结论的出口）：不推送重跑。
 * 正常结论路径（写入或守卫丢弃）走 settleReadonlyVerify。
 */
export function clearReadonlyVerify(panelKind: PanelKind): void {
  pendingVerifies.delete(panelKind);
}

export interface SessionResultUpdatedSubscription {
  /** 取消订阅（面板 dispose 时取消；订阅存活即代表会话存活）。 */
  dispose(): void;
}

/**
 * 注册结果更新重跑回调：结论写入缓存并结算登记后，向同面板类别的全部
 * 注册会话各推送一次。回调内由面板任务重跑恢复顺序（读缓存落结论页）。
 */
export function onSessionResultUpdated(
  panelKind: PanelKind,
  callback: () => void,
): SessionResultUpdatedSubscription {
  const list = resultUpdatedCallbacks.get(panelKind) ?? [];
  list.push(callback);
  resultUpdatedCallbacks.set(panelKind, list);
  return {
    dispose() {
      const current = resultUpdatedCallbacks.get(panelKind);
      if (!current) {
        return;
      }
      const index = current.indexOf(callback);
      if (index >= 0) {
        current.splice(index, 1);
      }
    },
  };
}

function notifyResultUpdated(panelKind: PanelKind): void {
  const list = resultUpdatedCallbacks.get(panelKind);
  if (!list || list.length === 0) {
    return;
  }
  for (const callback of [...list]) {
    try {
      callback();
    } catch (err) {
      console.error(
        `[svn-anywhere] 结果更新重跑回调失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/* --------------------- M4 多作用域会话存储（m4SessionStore） --------------------- */

/** P6 upper 三字段（技术方案冻结形状）：upperRevision=null 只与 unresolved 同时出现。 */
export interface HistoryUpperState {
  upperRevision: number | null;
  upperSource: 'unresolved' | 'live-head' | 'snapshot' | 'base-fallback';
  headState: 'available' | 'unavailable' | 'unknown';
}

/** P6 historyLimitState：非阻塞提示，只停止新增网络数据，不截断已加载记录。 */
export interface HistoryLimitReason {
  kind: 'matched' | 'scanned';
  limit: number;
  actual: number;
}

export interface HistoryLimitState {
  reasons: HistoryLimitReason[];
}

/**
 * P5 浏览目标的会话作用域：技术方案只冻结了 P6/P7 的任务结果作用域
 * 形状，P5 树缓存作为单个作用域项参与 LRU，身份由 P5 控制器给出
 * （本模块把它当作不透明稳定键，例如仓库 UUID + 规范化根 URL）。
 */
export interface BrowseSessionScope {
  scopeKind: 'browse';
  targetKey: string;
}

/**
 * 会话作用域判别联合：P6/P7 直接复用任务注册表的 ResultScope 形状
 * （同一身份既寻址任务绑定又寻址会话页，不另造第二套字段），P5 树
 * 缓存补 browse 类别参与同一 LRU。
 */
export type M4SessionScope = BrowseSessionScope | ConflictsResultScope | HistoryResultScope;

/**
 * 一个作用域项的内容。所有载荷字段由各面板控制器定义形状（本模块不
 * 理解业务结构）：字段为 undefined 表示「该层未写入/已清除」。
 */
export interface M4ScopeSession {
  /** 作用域身份（保存时的拷贝）。 */
  scope: M4SessionScope;
  /** 可浏览状态：P5 树缓存 / P6 筛选勾选详情 / P7 列表筛选选择。 */
  browsable?: unknown;
  /** P6 upper 三字段（upperRevision/upperSource/headState）。 */
  upper?: HistoryUpperState;
  /** P6 历史会话上限状态（null=无提示，属已写入的显式值）。 */
  historyLimitState?: HistoryLimitState | null;
  /** P7 冲突快照（归一化冲突记录，控制器定义）。 */
  conflictSnapshot?: unknown;
  /** P7 推迟集合（按冲突指纹，控制器定义）。 */
  postponed?: unknown;
  /** P7 已解决台账（随作用域项淘汰，不写持久层）。 */
  resolvedLedger?: unknown;
  /** 最近终态页（P6/P7 任务终态；任务执行器先写页再移除任务）。 */
  terminalPage?: unknown;
}

/**
 * 作用域项更新补丁：只写入出现在补丁里的字段（undefined=不修改），
 * 其余字段保留。要显式清空可写 null；整项删除用 clearM4ScopeSession。
 */
export interface M4ScopeSessionPatch {
  browsable?: unknown;
  upper?: HistoryUpperState;
  historyLimitState?: HistoryLimitState | null;
  conflictSnapshot?: unknown;
  postponed?: unknown;
  resolvedLedger?: unknown;
  terminalPage?: unknown;
}

/** 一次写入触发的淘汰动作：先清终态页（项保留），后整体淘汰作用域项。 */
export interface M4ScopeEviction {
  kind: 'scope' | 'terminal-page';
  scope: M4SessionScope;
}

export interface M4ScopePutResult {
  /** 按发生顺序记录的淘汰动作（空数组=未触发淘汰）。 */
  evictions: M4ScopeEviction[];
}

/** 淘汰判定上下文：当前打开作用域与活动任务作用域不计入可淘汰集合。 */
export interface M4SessionStoreContext {
  /** 当前打开的作用域（面板正在显示的目标）。 */
  current?: M4SessionScope;
  /**
   * 追加的活动作用域谓词（可选）：活动任务作用域默认从共享任务注册表
   * 派生（见 isActiveTaskScope），本谓词只用于补充保护、不替换默认判定。
   */
  isActiveScope?(scope: M4SessionScope): boolean;
}

/** 作用域项容量上限（技术方案冻结值）。 */
export const M4_SESSION_STORE_CAPACITY = 24;

/** LRU 序：Map 迭代顺序即最近使用序（旧→新），写入时 delete+set 移到最新。 */
const m4SessionStore = new Map<string, M4ScopeSession>();

/** 作用域判等：browse 比目标键，P6/P7 复用任务注册表的 switch 判等，跨类别必不等。 */
export function sameM4SessionScope(a: M4SessionScope, b: M4SessionScope): boolean {
  if (a.scopeKind === 'browse' || b.scopeKind === 'browse') {
    return a.scopeKind === 'browse' && b.scopeKind === 'browse' && a.targetKey === b.targetKey;
  }
  return sameResultScope(a, b);
}

/** 稳定键：JSON 数组避免路径分隔符与 identity 字段内容冲突。 */
function m4ScopeKeyOf(scope: M4SessionScope): string {
  switch (scope.scopeKind) {
    case 'browse':
      return JSON.stringify(['browse', scope.targetKey]);
    case 'history':
      return JSON.stringify(['history', scope.targetKind, scope.targetKey]);
    case 'conflicts':
      return JSON.stringify(['conflicts', scope.wcRoot, scope.scopeRelPath]);
  }
}

function applyM4ScopePatch(target: M4ScopeSession, patch: M4ScopeSessionPatch): void {
  if (patch.browsable !== undefined) {
    target.browsable = patch.browsable;
  }
  if (patch.upper !== undefined) {
    target.upper = patch.upper;
  }
  if (patch.historyLimitState !== undefined) {
    target.historyLimitState = patch.historyLimitState;
  }
  if (patch.conflictSnapshot !== undefined) {
    target.conflictSnapshot = patch.conflictSnapshot;
  }
  if (patch.postponed !== undefined) {
    target.postponed = patch.postponed;
  }
  if (patch.resolvedLedger !== undefined) {
    target.resolvedLedger = patch.resolvedLedger;
  }
  if (patch.terminalPage !== undefined) {
    target.terminalPage = patch.terminalPage;
  }
}

/**
 * 活动任务作用域判定：从与 M1-M3 共享的任务注册表派生（P6/P7 的任务
 * 对象存在且其 resultScope 与候选一致）。任务执行器写入终态页时任务
 * 仍在注册表中，该作用域据此自动受保护——清页或整体淘汰都不会丢掉
 * 即将由重开恢复的结果页。P5 树缓存没有任务槽，不受任务保护。
 */
function isActiveTaskScope(scope: M4SessionScope): boolean {
  if (scope.scopeKind === 'browse') {
    return false;
  }
  return findTaskByScope(scope.scopeKind, scope) !== undefined;
}

/**
 * 写入/更新一个作用域项（任务执行器与面板控制器的同一接口）。
 *
 * 已存在的项合并补丁并移到 LRU 最新；新项插入后若超过 24 项，按技术
 * 方案固定顺序修剪：① 先清除最旧的非当前（且非活动任务）终态页——
 * 只清页不删项，减少敏感/陈旧数据；② 随后仍整体淘汰最旧非活动作用域
 * 直到项数回到 24；若没有终态页可清则跳过 ① 直接整体 LRU。当前作用域
 * 与活动任务作用域永不淘汰（即使全部项都受保护、无法降到 24 也不删）。
 *
 * 返回按发生顺序的淘汰动作，供调用方清理对应面板的视图/提示。
 */
export function putM4ScopeSession(
  scope: M4SessionScope,
  patch: M4ScopeSessionPatch = {},
  context: M4SessionStoreContext = {},
): M4ScopePutResult {
  const key = m4ScopeKeyOf(scope);
  const existing = m4SessionStore.get(key);
  if (existing) {
    applyM4ScopePatch(existing, patch);
    m4SessionStore.delete(key);
    m4SessionStore.set(key, existing);
  } else {
    const entry: M4ScopeSession = { scope: { ...scope } };
    applyM4ScopePatch(entry, patch);
    m4SessionStore.set(key, entry);
  }

  const evictions: M4ScopeEviction[] = [];
  if (m4SessionStore.size <= M4_SESSION_STORE_CAPACITY) {
    return { evictions };
  }
  const isProtected = (candidate: M4ScopeSession): boolean =>
    (context.current !== undefined && sameM4SessionScope(candidate.scope, context.current)) ||
    isActiveTaskScope(candidate.scope) ||
    (context.isActiveScope?.(candidate.scope) ?? false);

  // ① 清除最旧的非当前终态页（若存在）：终态页清除不减少作用域项数。
  for (const candidate of m4SessionStore.values()) {
    if (isProtected(candidate)) {
      continue;
    }
    if (candidate.terminalPage !== undefined) {
      candidate.terminalPage = undefined;
      evictions.push({ kind: 'terminal-page', scope: { ...candidate.scope } });
      break;
    }
  }

  // ② 整体淘汰最旧非活动作用域，把项数维持回容量上限。
  while (m4SessionStore.size > M4_SESSION_STORE_CAPACITY) {
    let removed = false;
    for (const [candidateKey, candidate] of m4SessionStore) {
      if (isProtected(candidate)) {
        continue;
      }
      m4SessionStore.delete(candidateKey);
      evictions.push({ kind: 'scope', scope: { ...candidate.scope } });
      removed = true;
      break;
    }
    if (!removed) {
      // 全部项都是当前/活动任务作用域：永不淘汰优先于容量约束。
      break;
    }
  }
  return { evictions };
}

/**
 * 读取作用域项（会话恢复入口）。读取不改变 LRU 序、无副作用；返回浅
 * 拷贝（含 scope），调用方修改请走 putM4ScopeSession。淘汰后的作用域
 * 读不到，控制器按恢复顺序落到 fresh，重新读取真实 SVN。
 */
export function readM4ScopeSession(scope: M4SessionScope): M4ScopeSession | undefined {
  const entry = m4SessionStore.get(m4ScopeKeyOf(scope));
  if (!entry) {
    return undefined;
  }
  return { ...entry, scope: { ...entry.scope } };
}

/** 删除整个作用域项（切换目标放弃会话、或用户显式清理当前目标）。 */
export function clearM4ScopeSession(scope: M4SessionScope): boolean {
  return m4SessionStore.delete(m4ScopeKeyOf(scope));
}

/**
 * 清除单个作用域项的终态页（保留可浏览状态与项本身）：用于离页动作
 * 或未知结果收口后不再展示旧终态页。返回是否发生了清除。
 */
export function clearM4TerminalPage(scope: M4SessionScope): boolean {
  const entry = m4SessionStore.get(m4ScopeKeyOf(scope));
  if (!entry || entry.terminalPage === undefined) {
    return false;
  }
  entry.terminalPage = undefined;
  return true;
}

/** 当前作用域项（LRU 旧→新，诊断与测试用）。 */
export function listM4ScopeSessions(): M4SessionScope[] {
  return [...m4SessionStore.values()].map((entry) => ({ ...entry.scope }));
}

/** 当前作用域项数。 */
export function m4SessionStoreSize(): number {
  return m4SessionStore.size;
}

/**
 * 控制器恢复计划（技术方案固定顺序）：活动任务绑定 → 当前作用域终态页
 * → 可浏览状态 → fresh。hasActiveTask 由调用方用共享任务注册表按
 * resultScope 判定；本函数只按存储值分层，不从一层反推另一层的业务真相。
 */
export type M4SessionRestorePlan =
  | { layer: 'active-task' }
  | { layer: 'terminal-page'; page: unknown }
  | { layer: 'browsable'; browsable: unknown }
  | { layer: 'fresh' };

export interface M4SessionRestoreInput {
  /** 当前目标存在绑定的活动任务（活动任务层优先于任何缓存页）。 */
  hasActiveTask: boolean;
  /** 本次打开的当前作用域。 */
  scope: M4SessionScope;
}

export function planM4SessionRestore(input: M4SessionRestoreInput): M4SessionRestorePlan {
  if (input.hasActiveTask) {
    return { layer: 'active-task' };
  }
  const entry = readM4ScopeSession(input.scope);
  // null 与 undefined 都视为该层无内容（控制器可用 null 显式清空一层）。
  if (entry?.terminalPage !== undefined && entry.terminalPage !== null) {
    return { layer: 'terminal-page', page: entry.terminalPage };
  }
  if (entry?.browsable !== undefined && entry.browsable !== null) {
    return { layer: 'browsable', browsable: entry.browsable };
  }
  return { layer: 'fresh' };
}

/** 测试辅助：清空 M4 多作用域存储（真实宿主不需要）。 */
export function resetM4SessionStore(): void {
  m4SessionStore.clear();
}

/** 测试辅助：清空缓存、登记与重跑回调（真实宿主不需要）。 */
export function resetSessionResults(): void {
  results.clear();
  pendingVerifies.clear();
  resultUpdatedCallbacks.clear();
  resetM4SessionStore();
}
