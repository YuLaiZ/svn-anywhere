/**
 * 占用态放行表测试：判定顺序（先 busy、busy=false 才看 writeLocked）、
 * 基线表（提交/忽略面板现状集合）、P3/P4 表的条件放行（谓词注入）与
 * DOM 可交互集推导（与宿主守卫同表同源）。
 */
import { describe, expect, it } from 'vitest';
import {
  allowedActions,
  createP3Gates,
  createP4Gates,
  gateAllows,
  gatePermits,
  M2_PANEL_GATES,
  type P3GatePredicates,
  type P4GatePredicates,
} from '../src/host/panel/gates';

describe('gatePermits：判定顺序与横幅动作命名空间', () => {
  it('busy 与 writeLocked 皆假时不受放行表约束', () => {
    expect(gatePermits(M2_PANEL_GATES, false, false, { kind: 'submit' })).toBe(true);
  });

  it('busy=true 时只按 busy 行判（不看 writeLocked 行）——两态可同真', () => {
    // writeLocked 行放行 resolveUnknown，但 busy 行不放行：busy 优先。
    expect(gatePermits(M2_PANEL_GATES, true, true, { kind: 'resolveUnknown' })).toBe(false);
    expect(gatePermits(M2_PANEL_GATES, true, false, { kind: 'resolveUnknown' })).toBe(false);
  });

  it('busy=false 且 writeLocked=true 时按 writeLocked 行判', () => {
    expect(gatePermits(M2_PANEL_GATES, false, true, { kind: 'resolveUnknown' })).toBe(true);
    expect(gatePermits(M2_PANEL_GATES, false, true, { kind: 'submit' })).toBe(false);
  });

  it('bannerAction 按 actionId 查同一张表（与直接意图同命名空间）', () => {
    expect(
      gatePermits(M2_PANEL_GATES, false, true, { kind: 'bannerAction', actionId: 'resolveUnknown' }),
    ).toBe(true);
    expect(
      gatePermits(M2_PANEL_GATES, false, true, { kind: 'bannerAction', actionId: 'writeSomething' }),
    ).toBe(false);
  });

  it('gateAllows 对缺省规则集返回 false', () => {
    expect(gateAllows(undefined, 'syncInput')).toBe(false);
  });
});

describe('基线放行表（提交/忽略面板现状集合，改造前后不变）', () => {
  it('busy 只放行迟到输入同步', () => {
    expect(gatePermits(M2_PANEL_GATES, true, false, { kind: 'syncInput' })).toBe(true);
    for (const kind of ['refresh', 'submit', 'closePanel', 'resolveUnknown', 'setFilter']) {
      expect(gatePermits(M2_PANEL_GATES, true, false, { kind })).toBe(false);
    }
  });

  it('writeLocked 只放行核实与重读（含横幅按钮变体）', () => {
    expect(gatePermits(M2_PANEL_GATES, false, true, { kind: 'resolveUnknown' })).toBe(true);
    expect(gatePermits(M2_PANEL_GATES, false, true, { kind: 'refresh' })).toBe(true);
    for (const kind of ['syncInput', 'submit', 'clearFilters', 'toggleRow']) {
      expect(gatePermits(M2_PANEL_GATES, false, true, { kind })).toBe(false);
    }
  });
});

describe('P3 放行表（谓词由面板注入）', () => {
  function p3With(patch: Partial<P3GatePredicates> = {}): P3GatePredicates {
    return {
      taskPhase: () => 'running',
      canResume: () => true,
      isMergedOutcome: () => false,
      isSnapshotIncomplete: () => false,
      isResidueResultPage: () => false,
      ...patch,
    };
  }

  it('busy 放行取消仅运行段：connecting 准备段与 canceling 不放行，其余拒绝', () => {
    const gates = createP3Gates(p3With({ taskPhase: () => 'running' }));
    expect(gatePermits(gates, true, false, { kind: 'cancelTask' })).toBe(true);
    expect(gatePermits(gates, true, false, { kind: 'viewTaskLog' })).toBe(true);
    expect(gatePermits(gates, true, false, { kind: 'closePanel' })).toBe(true);

    const connecting = createP3Gates(p3With({ taskPhase: () => 'connecting' }));
    expect(gatePermits(connecting, true, false, { kind: 'cancelTask' })).toBe(false);
    expect(gatePermits(connecting, true, false, { kind: 'viewTaskLog' })).toBe(true);

    const canceling = createP3Gates(p3With({ taskPhase: () => 'canceling' }));
    expect(gatePermits(canceling, true, false, { kind: 'cancelTask' })).toBe(false);

    // 运行页无可编辑字段：迟到输入按拒绝处理。
    expect(gatePermits(gates, true, false, { kind: 'syncInput' })).toBe(false);
    expect(gatePermits(gates, true, false, { kind: 'startCheckout' })).toBe(false);
  });

  it('writeLocked 无条件放行核验/定位/日志/关闭与非写离页动作', () => {
    const gates = createP3Gates(p3With());
    for (const kind of [
      'verifyImport', 'verifyCheckout', 'revealResultDir', 'revealSourceDir',
      'viewTaskLog', 'closePanel', 'openCurrentWindow', 'openNewWindow',
      'addToWorkspace', 'newTask', 'handoffToCheckout', 'switchP3Mode',
    ]) {
      expect(gatePermits(gates, false, true, { kind }), kind).toBe(true);
    }
  });

  it('writeLocked 的条件放行：resumeCheckout 仅占用谓词通过', () => {
    const free = createP3Gates(p3With({ canResume: () => true }));
    expect(gatePermits(free, false, true, { kind: 'resumeCheckout' })).toBe(true);
    const occupied = createP3Gates(p3With({ canResume: () => false }));
    expect(gatePermits(occupied, false, true, { kind: 'resumeCheckout' })).toBe(false);
  });

  it('writeLocked 的条件放行：acknowledgeMerged 仅 merged 记录态', () => {
    const merged = createP3Gates(p3With({ isMergedOutcome: () => true }));
    expect(gatePermits(merged, false, true, { kind: 'acknowledgeMerged' })).toBe(true);
    const unmerged = createP3Gates(p3With({ isMergedOutcome: () => false }));
    expect(gatePermits(unmerged, false, true, { kind: 'acknowledgeMerged' })).toBe(false);
  });

  it('writeLocked 的条件放行：abandonUnknownImport 仅快照不完整分支', () => {
    const incomplete = createP3Gates(p3With({ isSnapshotIncomplete: () => true }));
    expect(gatePermits(incomplete, false, true, { kind: 'abandonUnknownImport' })).toBe(true);
    const intact = createP3Gates(p3With({ isSnapshotIncomplete: () => false }));
    expect(gatePermits(intact, false, true, { kind: 'abandonUnknownImport' })).toBe(false);
  });

  it('writeLocked 的条件放行：abandonResidue 仅 canceled/failed/interrupted/resumeBlocked 结果页', () => {
    const residue = createP3Gates(p3With({ isResidueResultPage: () => true }));
    expect(gatePermits(residue, false, true, { kind: 'abandonResidue' })).toBe(true);
    const elsewhere = createP3Gates(p3With({ isResidueResultPage: () => false }));
    expect(gatePermits(elsewhere, false, true, { kind: 'abandonResidue' })).toBe(false);
  });

  it('writeLocked 拒绝未列动作（含输入同步与写入口）', () => {
    const gates = createP3Gates(p3With());
    for (const kind of ['syncInput', 'startCheckout', 'startImport', 'retryImport', 'refresh']) {
      expect(gatePermits(gates, false, true, { kind }), kind).toBe(false);
    }
  });
});

describe('P4 放行表（谓词由面板注入）', () => {
  function p4With(patch: Partial<P4GatePredicates> = {}): P4GatePredicates {
    return { isUserScanning: () => true, ...patch };
  }

  it('busy 放行取消扫描（仅用户发起的扫描态）、日志、关闭、范围说明与表格只读意图', () => {
    const gates = createP4Gates(p4With());
    for (const kind of [
      'cancelScan', 'viewTaskLog', 'closePanel', 'showScopeHelp',
      'setSort', 'setFilter', 'setPage', 'revealFileInOS',
    ]) {
      expect(gatePermits(gates, true, false, { kind }), kind).toBe(true);
    }
  });

  it('busy 不放行取消（清理在途，无取消入口）与重新分析/清理确认；无输入同步', () => {
    const cleaning = createP4Gates(p4With({ isUserScanning: () => false }));
    expect(gatePermits(cleaning, true, false, { kind: 'cancelScan' })).toBe(false);

    const gates = createP4Gates(p4With());
    for (const kind of ['rescan', 'startScan', 'confirmVacuum', 'syncInput']) {
      expect(gatePermits(gates, true, false, { kind }), kind).toBe(false);
    }
  });

  it('writeLocked 放行重新检测/首次分析与只读路径、拒绝清理确认', () => {
    const gates = createP4Gates(p4With());
    for (const kind of [
      'rescan', 'startScan', 'showScopeHelp', 'viewTaskLog', 'closePanel',
      'setSort', 'setFilter', 'setPage', 'revealFileInOS',
    ]) {
      expect(gatePermits(gates, false, true, { kind }), kind).toBe(true);
    }
    expect(gatePermits(gates, false, true, { kind: 'confirmVacuum' })).toBe(false);
    expect(gatePermits(gates, false, true, { kind: 'syncInput' })).toBe(false);
  });
});

describe('DOM 可交互集推导（与宿主守卫同表同源）', () => {
  it('求值谓词后的动作列表：条件不满足的动作不出现', () => {
    const gates = createP4Gates({ isUserScanning: () => false });
    expect(allowedActions(gates.busy)).not.toContain('cancelScan');
    expect(allowedActions(gates.busy)).toEqual(
      expect.arrayContaining(['viewTaskLog', 'closePanel', 'showScopeHelp', 'setSort', 'setFilter', 'setPage', 'revealFileInOS']),
    );
  });

  it('谓词求值是即时的（每次推导重新读取面板状态）', () => {
    let scanning = true;
    const gates = createP4Gates({ isUserScanning: () => scanning });
    expect(allowedActions(gates.busy)).toContain('cancelScan');
    scanning = false;
    expect(allowedActions(gates.busy)).not.toContain('cancelScan');
  });
});
