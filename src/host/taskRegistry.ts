/**
 * 任务对象注册表：检出/导入与磁盘治理长任务的宿主侧内存态。
 *
 * 任务对象与面板会话生命周期解耦：任务由面板控制器在发起时创建并注册，
 * 此后即使发起面板已关闭，任务对象仍留在注册表——后台任务由执行器自行
 * 结算，面板重开时按目标作用域（resultScope）重新绑定运行中任务并回到
 * 其当前状态。注册表不持久化，扩展宿主重启后自然为空。
 *
 * 目标作用域在任务创建时由发起方一次性捕获（检出/导入面板 = 本次打开
 * 入口键 + 模式；磁盘治理面板 = 工作副本根），不从任务目标路径推导、
 * 也不读面板状态——后台结算时面板可能已销毁，作用域必须是任务对象
 * 自带的稳定值。互斥锁键（lockKey）与操作记录同值、独立携带：作用域
 * 只服务结果缓存寻址与会话绑定，锁键服务写限制判定，两者不是同一值
 * （检出任务的锁键按最终目标路径归一，与打开入口键不同源）。
 *
 * 本模块不依赖 vscode API（纯内存注册表），单例跨面板会话持续。
 */

/** 任务所属面板类别：检出/导入共用面板与磁盘治理面板。 */
export type PanelKind = 'checkout' | 'disk';

/**
 * 检出/导入面板的目标作用域：打开入口键 + 模式。入口键是入口路径的
 * 规范化值（realpath），与面板草稿键同源；它是打开时唯一确定的比对
 * 基准——表单内改过父目录等形态下，最终目标路径与打开入口不一致，
 * 结果缓存因此不用目标路径寻址。
 */
export interface CheckoutResultScope {
  entryKey: string;
  mode: 'checkout' | 'import';
}

/** 磁盘治理面板的目标作用域：工作副本根。 */
export interface DiskResultScope {
  wcRoot: string;
}

export type ResultScope = CheckoutResultScope | DiskResultScope;

/** 作用域判等：检出/导入比入口键与模式，磁盘治理比副本根；跨类别必不等。 */
export function sameResultScope(a: ResultScope, b: ResultScope): boolean {
  if ('entryKey' in a || 'entryKey' in b) {
    if (!('entryKey' in a && 'entryKey' in b)) {
      return false;
    }
    return a.entryKey === b.entryKey && a.mode === b.mode;
  }
  if (!('wcRoot' in a && 'wcRoot' in b)) {
    return false;
  }
  return a.wcRoot === b.wcRoot;
}

/**
 * 任务执行相位。检出/导入任务走 connecting → running → canceling，
 * 终态由执行器结算（成功/失败/取消等不在注册表枚举内——终态即移除）；
 * 磁盘治理任务走 scanning（扫描）或 connecting → cleaning（清理含自动
 * 复测；changed 等预命令出口同样移除任务对象）。connecting 是写命令
 * 发出前的通用准备态，该窗口不提供用户取消。
 */
export type TaskPhase = 'connecting' | 'running' | 'canceling' | 'scanning' | 'cleaning';

/**
 * 注册表中的任务对象。核心字段在任务创建时一次捕获、此后由执行器按
 * 相位推进；执行器私有数据（进程句柄、事件回调等业务字段）挂 extra，
 * 注册表不理解其内容——具体形状由各任务执行器定义。
 */
export interface TaskObject<TExtra = unknown> {
  /** 任务 ID：与对应操作记录的 operationId 同值（续检任务沿用原记录 ID）。 */
  taskId: string;
  panelKind: PanelKind;
  phase: TaskPhase;
  /** 任务创建时捕获的目标作用域：结果缓存寻址与面板重绑定的基准。 */
  resultScope: ResultScope;
  /** 互斥锁键：与操作记录同值；写限制判定与续检/放弃动作对象取它。 */
  lockKey: string;
  /** 磁盘治理任务：任务创建时的本次打开子目录（跨入口绑定页头的基准）。 */
  subPath?: string;
  /** 检出/导入任务：发起时全部表单字段快照（预命令终止出口草稿写回的数据源）。 */
  formSnapshot?: unknown;
  /** 创建（发起）该任务的面板会话标识：任务移除通知跳过该会话。 */
  initiatorSessionId: string;
  /** 取消通道：任务进入运行段后由取消流程触发（准备窗口无取消）。 */
  abortController: AbortController;
  /** 执行器扩展字段：由各任务执行器定义与读写，注册表只托管。 */
  extra?: TExtra;
}

/** 移除通知订阅记录：会话标识 + 回调。 */
interface RemovalSubscription {
  sessionId: string;
  callback: (task: TaskObject) => void;
}

/** 扩展进程级单例：每个面板类别至多一个活动任务（写操作互斥由面板 busy 与操作记录承载）。 */
const activeTasks = new Map<PanelKind, TaskObject>();
const removalSubscriptions = new Map<PanelKind, RemovalSubscription[]>();

/**
 * 注册任务。同类别已有残留任务（异常悬挂——出口未收口的任务对象）时，
 * 先按移除流程收口旧任务（通知其绑定会话重跑恢复）再注册新任务：注册表
 * 不得被悬挂任务堵死成永久 busy。正常运行流程中面板 busy 守卫使替换
 * 不可达，本分支只是防御收口。
 */
export function addTask(task: TaskObject): void {
  const existing = activeTasks.get(task.panelKind);
  if (existing && existing !== task) {
    removeTask(existing.taskId);
  }
  activeTasks.set(task.panelKind, task);
}

/**
 * 按目标作用域查询运行中任务（面板重开恢复第①段的绑定入口）：当前
 * 任务存在且其作用域与给定基准一致才返回——跨入口打开不绑定他人任务。
 */
export function findTaskByScope(panelKind: PanelKind, scope: ResultScope): TaskObject | undefined {
  const task = activeTasks.get(panelKind);
  if (!task || !sameResultScope(task.resultScope, scope)) {
    return undefined;
  }
  return task;
}

/** 按面板类别取当前活动任务（占用判定与「任务对象存在」识别用）。 */
export function getActiveTask(panelKind: PanelKind): TaskObject | undefined {
  return activeTasks.get(panelKind);
}

/** 按任务 ID 查询（跨面板类别；意向/恢复流程按记录 ID 定位任务）。 */
export function getTaskById(taskId: string): TaskObject | undefined {
  for (const task of activeTasks.values()) {
    if (task.taskId === taskId) {
      return task;
    }
  }
  return undefined;
}

/** 占用谓词：该面板类别存在活动任务（面板 busy 的注册表侧并集）。 */
export function hasActiveTask(panelKind: PanelKind): boolean {
  return activeTasks.has(panelKind);
}

/**
 * 移除任务并通知绑定会话。调用点是任务终态结算（先写结果缓存再移除）
 * 与预命令终止出口（先写回草稿再移除）——移除时缓存/草稿已就绪，重跑
 * 不会落在「已移除、未写缓存」的两步之间。
 *
 * 通知只投递非发起的绑定会话：发起会话的出口/终态转移由其自身流程完成，
 * 再通知会把该会话刚回到的页面再次顶走；发起会话销毁后重开的新会话是
 * 新的绑定会话，照常投递。回调收到被移除的任务对象（重跑恢复的作用域
 * 基准 = 该任务的 resultScope）。
 */
export function removeTask(taskId: string): boolean {
  const task = getTaskById(taskId);
  if (!task) {
    return false;
  }
  if (activeTasks.get(task.panelKind) === task) {
    activeTasks.delete(task.panelKind);
  }
  notifyRemoval(task);
  return true;
}

function notifyRemoval(task: TaskObject): void {
  const subs = removalSubscriptions.get(task.panelKind);
  if (!subs || subs.length === 0) {
    return;
  }
  for (const sub of [...subs]) {
    if (sub.sessionId === task.initiatorSessionId) {
      continue;
    }
    try {
      sub.callback(task);
    } catch (err) {
      console.error(
        `[svn-anywhere] 任务移除通知回调失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export interface TaskRemovedSubscription {
  /** 取消订阅（面板 dispose 时只取消订阅，不触碰任务对象）。 */
  dispose(): void;
}

/**
 * 订阅任务移除通知（「绑定即订阅」）：面板会话绑定运行中任务时以自身
 * 会话标识订阅；任务移除时收到回调并重跑恢复顺序。面板 dispose 时取消
 * 订阅——订阅存活即代表会话存活。
 */
export function onTaskRemoved(
  panelKind: PanelKind,
  sessionId: string,
  callback: (task: TaskObject) => void,
): TaskRemovedSubscription {
  const subs = removalSubscriptions.get(panelKind) ?? [];
  const sub: RemovalSubscription = { sessionId, callback };
  subs.push(sub);
  removalSubscriptions.set(panelKind, subs);
  return {
    dispose() {
      const list = removalSubscriptions.get(panelKind);
      if (!list) {
        return;
      }
      const index = list.indexOf(sub);
      if (index >= 0) {
        list.splice(index, 1);
      }
    },
  };
}

/** 测试辅助：清空注册表与订阅（真实宿主不需要）。 */
export function resetTaskRegistry(): void {
  activeTasks.clear();
  removalSubscriptions.clear();
}
