/**
 * 面板占用态放行表：busy / writeLocked 两行规则，按面板注入。
 *
 * 背景：任务与面板解耦后（检出/导入/磁盘治理的长任务在面板外运行），
 * 「取消、看日志、关闭、查看已有分析」在运行中必须可用；而提交/忽略
 * 面板的任务与面板同生命周期，沿用「busy 只收迟到输入、writeLocked
 * 只放行核实与重读」的既有集合。放行判定因此不能全局一刀切，改为
 * 面板注册时携带自己的表；本模块只提供表结构与按表判定，不含业务。
 *
 * 动作名统一命名空间：直接意图取 intent.kind；横幅按钮（bannerAction）
 * 按其 actionId 查同一张表（横幅动作与同名直接意图共用放行规则，
 * 与既有「核实/重读按 actionId 豁免」同口径）。
 *
 * 条件放行（谓词）：动作是否可用取决于面板业务状态时（如「取消」仅在
 * 任务运行段、「确认合并」仅在 merged 记录态），规则携带 when 谓词——
 * 谓词由面板注册时注入实现，宿主守卫在每次意图送达时求值，DOM 禁用
 * 在每次渲染前求值同一谓词：两侧同表同源，不出现「可点被拒」。
 */
import { getOperationRegistry, kindOf, type OperationKind } from '../../core/operations';
import { hasActiveTask, type PanelKind } from '../taskRegistry';

/** 一条放行规则：动作名 + 可选条件谓词（求值为 false 时按不放行处理）。 */
export interface GateRule {
  /** Intent kind，或横幅按钮的 actionId（同一命名空间）。 */
  action: string;
  /** 条件放行谓词：由面板注入业务判定（如任务相位、记录态）。 */
  when?: () => boolean;
}

/** 一张放行表：busy 行与 writeLocked 行（判定顺序见 gatePermits）。 */
export interface PanelGates {
  /** busy=true 时放行的动作。 */
  busy: readonly GateRule[];
  /** busy=false 且 writeLocked=true 时放行的动作。 */
  writeLocked: readonly GateRule[];
}

/** 意图在放行表视角下的动作名（bannerAction 按 actionId 判定）。 */
export function gateActionOf(intent: { kind: string; actionId?: string }): string {
  return intent.kind === 'bannerAction' ? (intent.actionId ?? '') : intent.kind;
}

/** 单行规则判定：动作名匹配且谓词（若有）通过。 */
export function gateAllows(rules: readonly GateRule[] | undefined, action: string): boolean {
  if (!rules) {
    return false;
  }
  return rules.some((rule) => rule.action === action && (rule.when ? rule.when() : true));
}

/**
 * 占用态守卫判定：busy 与 writeLocked 可同真，先按 busy 行判，
 * busy=false 才看 writeLocked 行（命令在途时等待是基线要求）；
 * 两者皆假时不受放行表约束。
 */
export function gatePermits(
  gates: PanelGates,
  busy: boolean,
  writeLocked: boolean,
  intent: { kind: string; actionId?: string },
): boolean {
  const action = gateActionOf(intent);
  if (busy) {
    return gateAllows(gates.busy, action);
  }
  if (writeLocked) {
    return gateAllows(gates.writeLocked, action);
  }
  return true;
}

/**
 * 求值谓词通过的动作名列表：渲染前从同一张表推导 DOM 可交互集，
 * 与宿主守卫同源（守卫每次意图求值、DOM 每次渲染求值，跨面板占用的
 * 新鲜度由两次求值自然覆盖）。
 */
export function allowedActions(rules: readonly GateRule[]): string[] {
  return rules.filter((rule) => (rule.when ? rule.when() : true)).map((rule) => rule.action);
}

/**
 * 基线放行表（提交/忽略面板现状集合）：busy 只放行迟到输入同步，
 * writeLocked 只放行核实与重读（含横幅按钮变体，按 actionId 判定）。
 * 面板注册时不携带放行表即按本表守卫——替换硬编码集合前后行为不变。
 */
export const M2_PANEL_GATES: PanelGates = {
  busy: [{ action: 'syncInput' }],
  writeLocked: [{ action: 'resolveUnknown' }, { action: 'refresh' }],
};

/* ---------------- P3 检出/导入面板放行表 ---------------- */

/** P3 条件放行谓词：由面板侧注入实现（宿主守卫与 DOM 禁用共用）。 */
export interface P3GatePredicates {
  /**
   * 当前任务相位：仅 running 放行取消——connecting 是准备段（写命令尚未
   * 发出，无用户取消入口），canceling 是「已请求取消、等待退出」（不重复
   * 发取消请求）。
   */
  taskPhase(): 'connecting' | 'running' | 'canceling' | undefined;
  /**
   * 续检占用判定（与发起续检的占用检查是同一谓词）：续检目标无他人
   * 占用记录时通过；「面板自己的未收口残留」不构成对本面板续检的写锁，
   * 他人持有则不放行。
   */
  canResume(): boolean;
  /** 当前记录是否 merged 态（结果未知且人工判定已合并）：仅该态放行收口确认。 */
  isMergedOutcome(): boolean;
  /** 当前 unknown 结果页是否「快照不完整」分支（核实第 0 步失败）：仅该分支放行放弃核实。 */
  isSnapshotIncomplete(): boolean;
  /** 当前页是否 canceled/failed/interrupted/resumeBlocked 结果页：仅该类页放行「改用新目录」。 */
  isResidueResultPage(): boolean;
}

/**
 * P3 放行表：busy 放行 取消（仅运行段）/日志/关闭——运行页无可编辑
 * 字段、任务参数冻结，迟到输入按拒绝处理；writeLocked 放行核验/核实/
 * 续检（占用谓词）/定位/日志/关闭/只改记录的收口动作（条件见各行）与
 * 非写离页动作（打开目录、新建任务、交接检出不向受限目标写入）。
 */
export function createP3Gates(predicates: P3GatePredicates): PanelGates {
  return {
    busy: [
      { action: 'cancelTask', when: () => predicates.taskPhase() === 'running' },
      { action: 'viewTaskLog' },
      { action: 'closePanel' },
    ],
    writeLocked: [
      { action: 'verifyImport' },
      { action: 'verifyCheckout' },
      { action: 'resumeCheckout', when: () => predicates.canResume() },
      { action: 'revealResultDir' },
      { action: 'revealSourceDir' },
      { action: 'viewTaskLog' },
      { action: 'closePanel' },
      { action: 'acknowledgeMerged', when: () => predicates.isMergedOutcome() },
      { action: 'abandonUnknownImport', when: () => predicates.isSnapshotIncomplete() },
      { action: 'abandonResidue', when: () => predicates.isResidueResultPage() },
      { action: 'openCurrentWindow' },
      { action: 'openNewWindow' },
      { action: 'addToWorkspace' },
      { action: 'newTask' },
      { action: 'handoffToCheckout' },
      // 模式切换放行进处理器、由控制器专门分支精确判定（§4「unknown 未终态
      // → 拒绝」；不靠放行表一刀切——canceled/failed 等终态页可能因他人记录
      // writeLocked，基线允许该形态确认切换，与 abandonResidue/newTask 同族）。
      { action: 'switchP3Mode' },
    ],
  };
}

/* ---------------- P4 磁盘治理面板放行表 ---------------- */

/** P4 条件放行谓词：由面板侧注入实现。 */
export interface P4GatePredicates {
  /**
   * 是否用户发起的扫描进行中：仅该态放行取消扫描——清理（含其收尾
   * 复测）没有取消入口，复测异常由任务结算直转失败态，不经用户取消。
   */
  isUserScanning(): boolean;
}

/**
 * P4 放行表：busy 放行 取消扫描（仅用户发起的扫描态）/日志/关闭/
 * 范围说明与表格只读意图（排序/筛选/翻页/定位——扫描或清理中仍可
 * 查看已有分析）；重新分析与清理确认必须等待，不放行 rescan/
 * startScan/confirmVacuum；面板无表单字段，任何 busy 态都不放行
 * 输入同步。writeLocked 放行重新检测与只读路径、拒绝清理确认。
 */
export function createP4Gates(predicates: P4GatePredicates): PanelGates {
  const tableReadonlyRules: readonly GateRule[] = [
    { action: 'setSort' },
    { action: 'setFilter' },
    { action: 'setPage' },
    { action: 'revealFileInOS' },
  ];
  return {
    busy: [
      { action: 'cancelScan', when: () => predicates.isUserScanning() },
      { action: 'viewTaskLog' },
      { action: 'closePanel' },
      { action: 'showScopeHelp' },
      ...tableReadonlyRules,
    ],
    writeLocked: [
      { action: 'rescan' },
      { action: 'startScan' },
      { action: 'showScopeHelp' },
      { action: 'viewTaskLog' },
      { action: 'closePanel' },
      ...tableReadonlyRules,
    ],
  };
}

/* ---------------- M4：P5/P6/P7 放行表 ----------------
 *
 * M4 不另建门禁机制：三张表与 M1-M3 共用本模块的 PanelGates/gatePermits
 * 判定，busy/writeLocked 也由同一套既有注册表折算——面板自身的活动任务
 * （TaskRegistry 槽）给出 busy，OperationRegistry 的 lockKey 写限制给出
 * writeLocked（history-update/resolve 与 M1-M3 写操作同用 wcRoot 锁键，
 * 见 resolvePanelOccupancy）。因此这里只声明各面板的动作放行集，不读写
 * 锁状态本身。
 */

/** 面板占用态：busy 时等待（命令在途），否则 writeLocked 按放行表判定。 */
export interface PanelOccupancy {
  busy: boolean;
  writeLocked: boolean;
  /** writeLocked 命中记录的类别（禁用原因按 kind 分列文案；无则 null）。 */
  heldKind: OperationKind | null;
}

/**
 * P6/P7 的占用态派生：与 M1-M3 共享同一写锁注册表，不新建 M4 写锁。
 * - busy：面板类别存在活动任务（P6 history-update/rescan、P7 扫描/
 *   resolve/批量），或共享 OperationRegistry 在 lockKey 上有命令在途
 *   （其他面板正在写同一副本时，M4 面板同样等待）；
 * - writeLocked：共享 OperationRegistry 在 lockKey 上有写限制记录
 *   （prepared/running/unknown 与协调态等，含 M1-M3 与 M4 记录）。
 * lockKey=null（远端目标无本地副本）时只看任务槽与真实 SVN 状态。
 * P5 只读面板没有任务槽与副本写锁，一般不调用本函数。
 */
export function resolvePanelOccupancy(panelKind: PanelKind, lockKey: string | null): PanelOccupancy {
  const registry = getOperationRegistry();
  const busy = hasActiveTask(panelKind) || (lockKey !== null && registry.hasRunning(lockKey));
  if (busy) {
    return { busy: true, writeLocked: false, heldKind: null };
  }
  const held = lockKey === null ? undefined : registry.writeRestriction(lockKey);
  return { busy: false, writeLocked: held !== undefined, heldKind: held ? kindOf(held) : null };
}

/* ---------------- P5 仓库浏览器放行表 ---------------- */

/**
 * P5 只读意图全集（冻结动作对账表）：展开/选中/刷新/重试/加载更多、
 * 复制 URL、只读打开远端内容、转交 P6 历史。P5 在 M4 不发写命令，
 * 全部意图都是读请求。
 */
const P5_READONLY_INTENTS: readonly GateRule[] = [
  { action: 'toggleBrowserNode' },
  { action: 'selectBrowserNode' },
  { action: 'retryBrowserNode' },
  { action: 'refreshBrowserNode' },
  { action: 'loadMoreBrowserNode' },
  { action: 'copyBrowserNodeUrl' },
  { action: 'openRemoteNode' },
  { action: 'openHistoryFromBrowser' },
  { action: 'viewTaskLog' },
  { action: 'closePanel' },
];

/**
 * P5 放行表：读请求一般不受 busy/writeLocked 阻止（技术方案 §7）。
 * busy 只可能来自元数据补全任务或等待态，writeLocked 来自与其他面板
 * 共享的写操作锁——两者都不改变「浏览只读」的事实，因此两行放行全部
 * P5 意图；P5 没有写入口需要拒绝。
 */
export function createP5Gates(): PanelGates {
  return { busy: P5_READONLY_INTENTS, writeLocked: P5_READONLY_INTENTS };
}

/* ---------------- P6 历史面板放行表 ---------------- */

/**
 * P6 只读查看意图：选中/勾选/筛选/比较/复制/查看/导出/追溯与日志关闭。
 * 更新任务在途或写锁未决时仍允许查看已有分析；这些动作不推进会话
 * 网络读取、不写工作副本，不会与更新任务结果页交错。
 */
const P6_READONLY_INTENTS: readonly GateRule[] = [
  { action: 'selectHistoryRevision' },
  { action: 'toggleHistoryRevision' },
  { action: 'setHistoryFilter' },
  { action: 'clearHistoryFilters' },
  { action: 'compareHistoryRevisions' },
  { action: 'selectCompareCandidate' },
  { action: 'openHistoryDiff' },
  { action: 'comparePreviousVisible' },
  { action: 'compareBase' },
  { action: 'blameHistoryRevision' },
  { action: 'copyHistoryText' },
  { action: 'viewHistoryRevision' },
  { action: 'exportHistoryVersion' },
  // 比较结果区的会话状态动作：关闭比较只改面板状态，占用态仍可退出。
  { action: 'historyCompareClose' },
  // 比较候选表的通用控件（筛选/翻页/排序）：只重算宿主切片，不请求 SVN。
  { action: 'setFilter' },
  { action: 'setPage' },
  { action: 'setSort' },
  { action: 'viewTaskLog' },
  { action: 'closePanel' },
];

/** P6 会话重读与写意图：占用态必须等待。 */
const P6_BLOCKED_IN_OCCUPANCY: readonly GateRule[] = [
  // 推进会话网络读取：与更新任务结果页/会话交错。
  { action: 'loadMoreHistory' },
  // 清会话重读与刷新上限：HLS-6 要求 reset 与 refresh 同组禁用。
  { action: 'resetHistorySession' },
  { action: 'refreshHistoryUpper' },
  // 写工作副本与检出交接：写入在途禁止重复写入与切换目标。
  { action: 'updateToHistoryRevision' },
  { action: 'checkoutHistoryDirectory' },
];

/**
 * P6 放行表：busy（history-update 在途）与 writeLocked（写锁未决）
 * 均「禁止刷新、重复写入与切换目标，可关闭面板查看已有数据」——
 * 放行只读查看集，拒绝会话重读/刷新/写/检出交接集。未知结果时
 * 的重新扫描入口由阶段 3 的控制器在业务层提供，不混入本表。
 */
export function createP6Gates(): PanelGates {
  return {
    busy: [...P6_READONLY_INTENTS],
    writeLocked: [...P6_READONLY_INTENTS],
  };
}

/** P6 占用态下必须等待的动作名（供面板模型构建禁用原因与测试对账）。 */
export function p6BlockedInOccupancyActions(): string[] {
  return P6_BLOCKED_IN_OCCUPANCY.map((rule) => rule.action);
}

/* ---------------- P7 冲突面板放行表 ---------------- */

/**
 * P7 只读查看意图：选择/tab/检查器/终端/原生差异与合并入口/打开版本/
 * 复制路径/批量结果/远端来源补查认证/日志关闭。扫描或写入在途时仍可
 * 查看已有分析，不改变冲突快照与写入状态。
 */
const P7_READONLY_INTENTS: readonly GateRule[] = [
  { action: 'selectConflict' },
  { action: 'setConflictTab' },
  { action: 'showConflictBatchResults' },
  { action: 'inspectConflict' },
  { action: 'openWorkCopyTerminal' },
  { action: 'openConflictDiff' },
  { action: 'openConflictEditor' },
  { action: 'openConflictVersion' },
  { action: 'copyConflictPath' },
  { action: 'authenticateConflictSource' },
  { action: 'viewTaskLog' },
  { action: 'closePanel' },
];

/**
 * P7 会话状态意图：只在宿主内存改面板状态（策略选择、属性值选择、推迟），
 * 不发 SVN 写命令，占用态放行。
 */
const P7_SESSION_STATE_INTENTS: readonly GateRule[] = [
  { action: 'chooseConflictVariant' },
  { action: 'choosePropertyValue' },
  { action: 'postponeConflict' },
];

/** P7 写与批量意图：占用态必须等待（禁止重复写入与批量处理）。 */
const P7_WRITE_INTENTS: readonly GateRule[] = [
  { action: 'applyConflictResolution' },
  { action: 'prepareTreeConflict' },
  { action: 'planConflictBatch' },
  { action: 'startConflictBatch' },
];

/** P7 扫描意图：busy 时拒绝（重复扫描）；写锁（unknown）时放行作为回扫入口。 */
const P7_SCAN_INTENTS: readonly GateRule[] = [
  { action: 'rescanConflicts' },
  { action: 'scanWholeWorkCopy' },
];

/**
 * P7 放行表：
 * - busy（扫描/resolve/批量在途）：放行只读查看与会话状态动作、
 *   日志与关闭——写入在途禁止刷新、重复写入与批量处理；扫描在途
 *   拒绝重复扫描。
 * - writeLocked（operation record 未决、含结果未知）：放行重新扫描
 *   与整副本扫描——「结果未知只开放核实/重新扫描/查看日志」，回扫
 *   是解除未知的唯一读路径；写与批量仍拒绝。
 */
export function createP7Gates(): PanelGates {
  return {
    busy: [...P7_READONLY_INTENTS, ...P7_SESSION_STATE_INTENTS],
    writeLocked: [
      ...P7_READONLY_INTENTS,
      ...P7_SESSION_STATE_INTENTS,
      ...P7_SCAN_INTENTS,
    ],
  };
}

/** P7 busy 态下必须等待的动作名（写/批量/重复扫描；供模型与测试对账）。 */
export function p7BlockedWhileBusyActions(): string[] {
  return [...P7_WRITE_INTENTS, ...P7_SCAN_INTENTS].map((rule) => rule.action);
}
