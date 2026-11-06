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
 */
import { sameResultScope, type PanelKind, type ResultScope } from './taskRegistry';

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

/** 测试辅助：清空缓存、登记与重跑回调（真实宿主不需要）。 */
export function resetSessionResults(): void {
  results.clear();
  pendingVerifies.clear();
  resultUpdatedCallbacks.clear();
}
