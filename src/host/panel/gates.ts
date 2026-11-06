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
