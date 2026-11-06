/**
 * 结果代次：按面板类别维护的单调递增计数器，宿主侧内存单例。
 *
 * 作用：标记「当前结果上下文」。任何使面板离开当前结果上下文的显式
 * 用户动作（回表单、确认放弃、模式/目标切换、发起新任务或续检等）
 * 都应递增对应面板的计数器——递增点由面板任务接入，本模块只提供
 * 机制。发起只读核验/核实的控制器在发起时捕获当前值，结论返回后按
 * 「捕获值仍等于当前值」守卫结论写入；用户已执行递增动作（无论在
 * 原会话还是重开后的新会话）则丢弃迟到结论。
 *
 * 计数器跨面板会话持续：面板会话创建不初始化、dispose 不递增也不
 * 重置——dispose 不递增保住「关闭等待结论、重开恢复结论页」的语义；
 * 跨会话持续使新会话执行的递增动作同样令旧会话捕获的代次过期，旧
 * 控制器的迟到结论不得写回缓存。本模块因此不提供任何面板生命周期
 * 钩子，不依赖 vscode API。
 */
import type { PanelKind } from './taskRegistry';

const epochs = new Map<PanelKind, number>();

/** 递增指定面板的结果代次并返回新值（供发起方捕获）。 */
export function bumpResultEpoch(panelKind: PanelKind): number {
  const next = (epochs.get(panelKind) ?? 0) + 1;
  epochs.set(panelKind, next);
  return next;
}

/** 读取当前结果代次（该面板从未递增过为 0）。读取无副作用。 */
export function getResultEpoch(panelKind: PanelKind): number {
  return epochs.get(panelKind) ?? 0;
}

/** 测试辅助：清空全部代次（真实宿主不需要）。 */
export function resetResultEpochs(): void {
  epochs.clear();
}
