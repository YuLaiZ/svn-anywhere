/**
 * 占用态放行表测试：判定顺序（先 busy、busy=false 才看 writeLocked）、
 * 基线表（提交/忽略面板现状集合）、P3/P4 表的条件放行（谓词注入）与
 * DOM 可交互集推导（与宿主守卫同表同源）。
 *
 * M4 增补 P5/P6/P7 表：P5 读请求不受占用态阻止；P6 更新在途/写锁
 * 拒绝刷新、重复写入与切换目标；P7 写入在途拒绝写/批量/重复扫描、
 * 写锁（unknown）放行重新扫描；三表与 M1-M3 共用同一判定机制。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  allowedActions,
  createP3Gates,
  createP4Gates,
  createP5Gates,
  createP6Gates,
  createP7Gates,
  gateAllows,
  gatePermits,
  M2_PANEL_GATES,
  p6BlockedInOccupancyActions,
  p7BlockedWhileBusyActions,
  resolvePanelOccupancy,
  type P3GatePredicates,
  type P4GatePredicates,
} from '../src/host/panel/gates';
import {
  getOperationRegistry,
  OperationRegistry,
  resetRunningOperationsForTest,
  runWithRunningKey,
  setOperationRegistryForTest,
} from '../src/core/operations';
import { M4_INTENT_KINDS } from '../src/host/panel/protocol';
import { addTask, resetTaskRegistry, type PanelKind, type TaskObject } from '../src/host/taskRegistry';

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

/* ---------------- M4：P5/P6/P7 放行表 ---------------- */

describe('P5 放行表（读请求不受占用态阻止）', () => {
  const gates = createP5Gates();
  const readIntents = [
    'toggleBrowserNode', 'selectBrowserNode', 'retryBrowserNode',
    'refreshBrowserNode', 'loadMoreBrowserNode', 'copyBrowserNodeUrl',
    'openRemoteNode', 'openHistoryFromBrowser', 'viewTaskLog', 'closePanel',
  ];

  it('busy 与 writeLocked 均放行全部 P5 读意图', () => {
    for (const kind of readIntents) {
      expect(gatePermits(gates, true, false, { kind }), `busy ${kind}`).toBe(true);
      expect(gatePermits(gates, false, true, { kind }), `writeLocked ${kind}`).toBe(true);
    }
  });

  it('P5 无写入口：未列动作（输入同步/提交/冲突写入）在占用态仍被拒绝', () => {
    for (const kind of ['syncInput', 'submit', 'applyConflictResolution']) {
      expect(gatePermits(gates, true, false, { kind }), `busy ${kind}`).toBe(false);
      expect(gatePermits(gates, false, true, { kind }), `writeLocked ${kind}`).toBe(false);
    }
  });

  it('无占用态时不受表约束（基线放行由控制器业务校验）', () => {
    expect(gatePermits(gates, false, false, { kind: 'toggleBrowserNode' })).toBe(true);
    expect(gatePermits(gates, false, false, { kind: 'anythingElse' })).toBe(true);
  });
});

describe('P6 放行表（history-update 在途与写锁）', () => {
  const gates = createP6Gates();
  const readonlyIntents = [
    'selectHistoryRevision', 'toggleHistoryRevision', 'setHistoryFilter',
    'clearHistoryFilters', 'compareHistoryRevisions', 'selectCompareCandidate',
    'openHistoryDiff', 'comparePreviousVisible', 'compareBase',
    'blameHistoryRevision', 'copyHistoryText', 'viewHistoryRevision',
    'exportHistoryVersion', 'historyCompareClose', 'setFilter', 'setPage',
    'setSort', 'viewTaskLog', 'closePanel',
  ];

  it('busy 与 writeLocked 放行只读查看（查看已有数据不被写入在途阻止）', () => {
    for (const kind of readonlyIntents) {
      expect(gatePermits(gates, true, false, { kind }), `busy ${kind}`).toBe(true);
      expect(gatePermits(gates, false, true, { kind }), `writeLocked ${kind}`).toBe(true);
    }
  });

  it('busy 与 writeLocked 拒绝刷新、会话重读、重复写入与检出交接', () => {
    const blocked = [
      'loadMoreHistory', 'resetHistorySession', 'refreshHistoryUpper',
      'updateToHistoryRevision', 'checkoutHistoryDirectory',
    ];
    for (const kind of blocked) {
      expect(gatePermits(gates, true, false, { kind }), `busy ${kind}`).toBe(false);
      expect(gatePermits(gates, false, true, { kind }), `writeLocked ${kind}`).toBe(false);
    }
  });

  it('拒绝集与放行表对账：占用态必须等待的动作不出现在任何一行', () => {
    const blocked = p6BlockedInOccupancyActions();
    expect(blocked).toEqual([
      'loadMoreHistory', 'resetHistorySession', 'refreshHistoryUpper',
      'updateToHistoryRevision', 'checkoutHistoryDirectory',
    ]);
    for (const kind of blocked) {
      expect(gateAllows(gates.busy, kind), `busy ${kind}`).toBe(false);
      expect(gateAllows(gates.writeLocked, kind), `writeLocked ${kind}`).toBe(false);
    }
  });
});

describe('P7 放行表（扫描/写入在途与写锁）', () => {
  const gates = createP7Gates();
  const readonlyIntents = [
    'selectConflict', 'setConflictTab', 'showConflictBatchResults',
    'inspectConflict', 'openWorkCopyTerminal', 'openConflictDiff',
    'openConflictEditor', 'openConflictVersion', 'copyConflictPath',
    'authenticateConflictSource', 'viewTaskLog', 'closePanel',
  ];
  const sessionIntents = ['chooseConflictVariant', 'postponeConflict'];
  const writeIntents = [
    'applyConflictResolution', 'prepareTreeConflict',
    'planConflictBatch', 'startConflictBatch',
  ];
  const scanIntents = ['rescanConflicts', 'scanWholeWorkCopy'];

  it('busy 放行只读查看与会话状态动作（策略选择/推迟只改宿主内存）', () => {
    for (const kind of [...readonlyIntents, ...sessionIntents]) {
      expect(gatePermits(gates, true, false, { kind }), `busy ${kind}`).toBe(true);
    }
  });

  it('busy 拒绝写、批量与重复扫描（写入在途禁止刷新、重复写入和批量处理）', () => {
    for (const kind of [...writeIntents, ...scanIntents]) {
      expect(gatePermits(gates, true, false, { kind }), `busy ${kind}`).toBe(false);
    }
  });

  it('writeLocked 放行重新扫描与整副本扫描（unknown 只开放回扫/查看/日志），写与批量仍拒绝', () => {
    for (const kind of [...readonlyIntents, ...sessionIntents, ...scanIntents]) {
      expect(gatePermits(gates, false, true, { kind }), `writeLocked ${kind}`).toBe(true);
    }
    for (const kind of writeIntents) {
      expect(gatePermits(gates, false, true, { kind }), `writeLocked ${kind}`).toBe(false);
    }
  });

  it('busy 优先于 writeLocked：同真时按 busy 行拒绝重复扫描', () => {
    expect(gatePermits(gates, true, true, { kind: 'rescanConflicts' })).toBe(false);
    expect(gatePermits(gates, false, true, { kind: 'rescanConflicts' })).toBe(true);
  });

  it('busy 等待集与放行表对账：写/批量/扫描动作按 busy 行全部拒绝', () => {
    const blocked = p7BlockedWhileBusyActions();
    expect(blocked).toEqual([...writeIntents, ...scanIntents]);
    for (const kind of blocked) {
      expect(gateAllows(gates.busy, kind), `busy ${kind}`).toBe(false);
    }
  });
});

describe('M4 三表与 M1-M3 共用同一判定机制', () => {
  it('bannerAction 按 actionId 查 M4 表（P7 横幅回扫按钮与直接意图同命名空间）', () => {
    const gates = createP7Gates();
    expect(
      gatePermits(gates, false, true, { kind: 'bannerAction', actionId: 'rescanConflicts' }),
    ).toBe(true);
    expect(
      gatePermits(gates, false, true, { kind: 'bannerAction', actionId: 'applyConflictResolution' }),
    ).toBe(false);
  });

  it('allowedActions 对 M4 表推导 DOM 可交互集（与宿主守卫同源）', () => {
    const p6 = createP6Gates();
    expect(allowedActions(p6.busy)).toEqual(expect.arrayContaining(['selectHistoryRevision', 'closePanel']));
    expect(allowedActions(p6.busy)).not.toContain('refreshHistoryUpper');
    const p7 = createP7Gates();
    expect(allowedActions(p7.writeLocked)).toEqual(
      expect.arrayContaining(['rescanConflicts', 'scanWholeWorkCopy', 'selectConflict']),
    );
    expect(allowedActions(p7.writeLocked)).not.toContain('startConflictBatch');
  });

  it('各表只放行自己面板的动作：P5 表不放行 P6/P7 动作，反之亦然', () => {
    const p5 = createP5Gates();
    expect(gatePermits(p5, true, false, { kind: 'refreshHistoryUpper' })).toBe(false);
    expect(gatePermits(p5, true, false, { kind: 'applyConflictResolution' })).toBe(false);
    expect(gatePermits(createP6Gates(), true, false, { kind: 'toggleBrowserNode' })).toBe(false);
    expect(gatePermits(createP7Gates(), true, false, { kind: 'selectHistoryRevision' })).toBe(false);
  });
});

describe('M4 占用态派生（与 M1-M3 共享写锁注册表）', () => {
  beforeEach(() => {
    setOperationRegistryForTest(new OperationRegistry());
    resetTaskRegistry();
    resetRunningOperationsForTest();
  });

  function taskOf(panelKind: PanelKind, lockKey = '/wc/root'): TaskObject {
    return {
      taskId: `task-${panelKind}`,
      panelKind,
      phase: 'updating',
      resultScope: { scopeKind: 'history', targetKey: '/repo/file.ts', targetKind: 'file' },
      lockKey,
      initiatorSessionId: 'session-1',
      abortController: new AbortController(),
    };
  }

  it('无任务、无记录：busy=false、writeLocked=false', () => {
    expect(resolvePanelOccupancy('history', '/wc/root')).toEqual({
      busy: false,
      writeLocked: false,
      heldKind: null,
    });
  });

  it('面板类别活动任务 → busy（P6/P7 各自的槽互不串扰）', () => {
    addTask(taskOf('history'));
    expect(resolvePanelOccupancy('history', '/wc/root').busy).toBe(true);
    expect(resolvePanelOccupancy('conflicts', '/wc/root').busy).toBe(false);
  });

  it('共享注册表在 lockKey 上有命令在途 → busy（其他面板正在写同一副本）', async () => {
    await runWithRunningKey('/wc/root', async () => {
      expect(resolvePanelOccupancy('conflicts', '/wc/root').busy).toBe(true);
      // 其他副本键不受影响。
      expect(resolvePanelOccupancy('conflicts', '/wc/other').busy).toBe(false);
    });
    expect(resolvePanelOccupancy('conflicts', '/wc/root').busy).toBe(false);
  });

  it('共享注册表写限制记录（M4 history-update unknown）→ writeLocked 并携带记录类别', async () => {
    const begin = await getOperationRegistry().begin({
      wcRoot: '/wc/root',
      targetRelPath: '.',
      nodeKind: 'dir',
      kind: 'history-update',
    });
    expect(begin.ok).toBe(true);
    if (!begin.ok) {
      return;
    }
    await getOperationRegistry().markPhase(begin.operationId, 'unknown');
    expect(resolvePanelOccupancy('history', '/wc/root')).toEqual({
      busy: false,
      writeLocked: true,
      heldKind: 'history-update',
    });
    await getOperationRegistry().finish(begin.operationId);
    expect(resolvePanelOccupancy('history', '/wc/root').writeLocked).toBe(false);
  });

  it('M1-M3 写记录同样折算 writeLocked（共享注册表，不区分 M4 与既有 kind）', async () => {
    const begin = await getOperationRegistry().begin({
      wcRoot: '/wc/root',
      targetRelPath: '.',
      nodeKind: 'dir',
      kind: 'commit',
    });
    expect(begin.ok).toBe(true);
    if (!begin.ok) {
      return;
    }
    await getOperationRegistry().markPhase(begin.operationId, 'unknown');
    expect(resolvePanelOccupancy('conflicts', '/wc/root').writeLocked).toBe(true);
    expect(resolvePanelOccupancy('conflicts', '/wc/root').heldKind).toBe('commit');
    await getOperationRegistry().finish(begin.operationId);
  });

  it('busy 优先于 writeLocked：运行登记与写限制同真时只报 busy', async () => {
    const begin = await getOperationRegistry().begin({
      wcRoot: '/wc/root',
      targetRelPath: '.',
      nodeKind: 'dir',
      kind: 'resolve',
    });
    expect(begin.ok).toBe(true);
    if (!begin.ok) {
      return;
    }
    await getOperationRegistry().markPhase(begin.operationId, 'unknown');
    await runWithRunningKey('/wc/root', async () => {
      expect(resolvePanelOccupancy('conflicts', '/wc/root')).toEqual({
        busy: true,
        writeLocked: false,
        heldKind: null,
      });
    });
    await getOperationRegistry().finish(begin.operationId);
  });

  it('lockKey=null（远端目标无本地副本）：只看任务槽，不因本地副本写锁而等待', async () => {
    const begin = await getOperationRegistry().begin({
      wcRoot: '/wc/root',
      targetRelPath: '.',
      nodeKind: 'dir',
      kind: 'commit',
    });
    expect(begin.ok).toBe(true);
    if (begin.ok) {
      await getOperationRegistry().markPhase(begin.operationId, 'unknown');
    }
    expect(resolvePanelOccupancy('history', null)).toEqual({
      busy: false,
      writeLocked: false,
      heldKind: null,
    });
    if (begin.ok) {
      await getOperationRegistry().finish(begin.operationId);
    }
  });
});

describe('M4 意图全量对账（放行表与协议白名单同源）', () => {
  it('44 个 M4 意图每个都在某张 P5/P6/P7 表的放行或显式阻塞集中有归宿', () => {
    expect(M4_INTENT_KINDS).toHaveLength(44);
    const p5 = createP5Gates();
    const p6 = createP6Gates();
    const p7 = createP7Gates();
    const handled = new Set<string>();
    for (const rule of [...p5.busy, ...p5.writeLocked]) {
      handled.add(rule.action);
    }
    for (const rule of [...p6.busy, ...p6.writeLocked]) {
      handled.add(rule.action);
    }
    for (const action of p6BlockedInOccupancyActions()) {
      handled.add(action);
    }
    for (const rule of [...p7.busy, ...p7.writeLocked]) {
      handled.add(rule.action);
    }
    for (const action of p7BlockedWhileBusyActions()) {
      handled.add(action);
    }
    const missing = M4_INTENT_KINDS.filter((kind) => !handled.has(kind));
    expect(missing).toEqual([]);
  });
});
