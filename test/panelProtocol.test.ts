/**
 * 面板消息协议的运行时校验测试：协议版本、消息结构、动作白名单、
 * 字段类型与「视图不能携带路径」的意图边界。
 */
import { describe, expect, it } from 'vitest';
import {
  M4_INTENT_KINDS,
  parseViewMessage,
  PROTOCOL_VERSION,
  type IntentMessage,
} from '../src/host/panel/protocol';

const intentMessage = (patch: Record<string, unknown>): Record<string, unknown> => ({
  type: 'intent',
  protocolVersion: PROTOCOL_VERSION,
  sessionId: 'session-a',
  requestId: 'req-1',
  intent: { kind: 'refresh' },
  ...patch,
});

describe('parseViewMessage', () => {
  it('接受合法 ready 消息', () => {
    const parsed = parseViewMessage({ type: 'ready', protocolVersion: PROTOCOL_VERSION });
    expect(parsed).toEqual({ ok: true, message: { type: 'ready', protocolVersion: PROTOCOL_VERSION } });
  });

  it('接受合法 intent 消息并保留字段', () => {
    const parsed = parseViewMessage(
      intentMessage({ intent: { kind: 'openDiff', itemId: 'src/ report.txt ' } }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const message = parsed.message as IntentMessage;
      expect(message.intent).toEqual({ kind: 'openDiff', itemId: 'src/ report.txt ' });
      expect(message.sessionId).toBe('session-a');
    }
  });

  it('拒绝非对象与未知消息类型', () => {
    expect(parseViewMessage('render').ok).toBe(false);
    expect(parseViewMessage({ type: 'evil', protocolVersion: PROTOCOL_VERSION }).ok).toBe(false);
  });

  it('协议版本不兼容按错误处理，不静默降级', () => {
    const parsed = parseViewMessage(intentMessage({ protocolVersion: 99 }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain('协议版本不兼容');
      expect(parsed.reason).toContain('99');
    }
  });

  it('拒绝未知意图动作（白名单外）', () => {
    const parsed = parseViewMessage(intentMessage({ intent: { kind: 'runCommand', path: '/etc' } }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain('未知意图动作');
    }
  });

  it('拒绝字段类型错误（itemId 非字符串 / selected 非布尔 / inputRevision 非数字）', () => {
    expect(parseViewMessage(intentMessage({ intent: { kind: 'openDiff', itemId: 42 } })).ok).toBe(false);
    expect(
      parseViewMessage(intentMessage({ intent: { kind: 'toggleRow', rowId: 'a', selected: 'yes' } })).ok,
    ).toBe(false);
    expect(
      parseViewMessage(
        intentMessage({ intent: { kind: 'syncInput', fieldId: 'm', value: 'x', inputRevision: 'n' } }),
      ).ok,
    ).toBe(false);
  });

  it('拒绝缺失 sessionId / requestId 的意图', () => {
    expect(parseViewMessage(intentMessage({ sessionId: undefined })).ok).toBe(false);
    expect(parseViewMessage(intentMessage({ requestId: undefined })).ok).toBe(false);
  });

  it('意图载荷里不存在路径类字段（视图不能传任意路径执行）', () => {
    // 白名单动作的已知字段集合；若新增含路径字段会在类型层暴露，这里保护运行时边界。
    const parsed = parseViewMessage(
      intentMessage({ intent: { kind: 'openFile', itemId: 'x', path: '/tmp/evil' } }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const intent = (parsed.message as IntentMessage).intent;
      expect(Object.keys(intent)).not.toContain('path');
    }
  });

  it('P2 意图：addRule/fillOriginName/saveIgnore/submitIgnore 无参放行，removeRule 校验 index', () => {
    for (const kind of ['addRule', 'fillOriginName', 'saveIgnore', 'submitIgnore']) {
      const parsed = parseViewMessage(intentMessage({ intent: { kind } }));
      expect(parsed.ok, kind).toBe(true);
    }
    const ok = parseViewMessage(intentMessage({ intent: { kind: 'removeRule', index: 2 } }));
    expect(ok.ok).toBe(true);
    expect(parseViewMessage(intentMessage({ intent: { kind: 'removeRule', index: -1 } })).ok).toBe(false);
    expect(parseViewMessage(intentMessage({ intent: { kind: 'removeRule', index: 1.5 } })).ok).toBe(false);
    expect(parseViewMessage(intentMessage({ intent: { kind: 'removeRule', index: '0' } })).ok).toBe(false);
  });
});

describe('parseViewMessage：P3/P4/表格动作全集校验', () => {
  const parameterlessKinds = [
    'pickParentDir', 'pickDirectDir', 'pickSourceDir', 'useUrlName', 'useDirName',
    'clearUrlHistory', 'checkoutNext', 'importNext', 'checkoutBack',
    'startCheckout', 'startImport', 'cancelTask', 'viewTaskLog',
    'verifyCheckout', 'resumeCheckout', 'abandonResidue', 'refreshImportPreview',
    'verifyImport', 'retryImport', 'switchP3Mode', 'acknowledgeMerged', 'abandonUnknownImport',
    'openCurrentWindow', 'openNewWindow', 'addToWorkspace', 'revealResultDir', 'revealSourceDir',
    'handoffToCheckout', 'newTask',
    'startScan', 'cancelScan', 'rescan', 'confirmVacuum', 'showScopeHelp',
  ];

  it('无参动作全部放行', () => {
    for (const kind of parameterlessKinds) {
      const parsed = parseViewMessage(intentMessage({ intent: { kind } }));
      expect(parsed.ok, kind).toBe(true);
      if (parsed.ok) {
        expect((parsed.message as IntentMessage).intent).toEqual({ kind });
      }
    }
  });

  it('无参动作不接受多余载荷字段（载荷字段被丢弃，不进意图）', () => {
    const parsed = parseViewMessage(intentMessage({ intent: { kind: 'startScan', path: '/tmp/evil' } }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(Object.keys((parsed.message as IntentMessage).intent)).toEqual(['kind']);
    }
  });

  it('selectHistoryUrl 校验非负整数 index', () => {
    expect(parseViewMessage(intentMessage({ intent: { kind: 'selectHistoryUrl', index: 0 } })).ok).toBe(true);
    expect(parseViewMessage(intentMessage({ intent: { kind: 'selectHistoryUrl', index: -1 } })).ok).toBe(false);
    expect(parseViewMessage(intentMessage({ intent: { kind: 'selectHistoryUrl', index: '0' } })).ok).toBe(false);
  });

  it('revealFileInOS 校验 rowId 字符串', () => {
    expect(parseViewMessage(intentMessage({ intent: { kind: 'revealFileInOS', rowId: 'row-1' } })).ok).toBe(true);
    expect(parseViewMessage(intentMessage({ intent: { kind: 'revealFileInOS', rowId: 42 } })).ok).toBe(false);
  });

  it('setSort 校验 key 与方向枚举', () => {
    expect(parseViewMessage(intentMessage({ intent: { kind: 'setSort', key: 'size', direction: 'desc' } })).ok).toBe(true);
    expect(parseViewMessage(intentMessage({ intent: { kind: 'setSort', key: 'size', direction: 'DESC' } })).ok).toBe(false);
    expect(parseViewMessage(intentMessage({ intent: { kind: 'setSort', key: 'size' } })).ok).toBe(false);
  });

  it('setPage 校验不小于 1 的整数页码（页码从 1 起）', () => {
    expect(parseViewMessage(intentMessage({ intent: { kind: 'setPage', page: 1 } })).ok).toBe(true);
    expect(parseViewMessage(intentMessage({ intent: { kind: 'setPage', page: 0 } })).ok).toBe(false);
    expect(parseViewMessage(intentMessage({ intent: { kind: 'setPage', page: -2 } })).ok).toBe(false);
    expect(parseViewMessage(intentMessage({ intent: { kind: 'setPage', page: 1.5 } })).ok).toBe(false);
    expect(parseViewMessage(intentMessage({ intent: { kind: 'setPage', page: '2' } })).ok).toBe(false);
  });
});

/* ================================================================================
 * M4：P5/P6/P7 意图（技术方案 §6 冻结动作对账表）
 * ================================================================================ */

/** 冻结对账表全集：每个动作配一份合法载荷（无参动作不带载荷）。 */
const M4_LEGAL_INTENTS: Array<Record<string, unknown>> = [
  // P5 仓库浏览器：只传稳定 nodeId。
  { kind: 'toggleBrowserNode', nodeId: 'node-1' },
  { kind: 'selectBrowserNode', nodeId: 'node-1' },
  { kind: 'retryBrowserNode', nodeId: 'node-1' },
  { kind: 'refreshBrowserNode', nodeId: 'node-1' },
  { kind: 'loadMoreBrowserNode', nodeId: 'node-1' },
  { kind: 'copyBrowserNodeUrl', nodeId: 'node-1' },
  { kind: 'openRemoteNode', nodeId: 'node-1' },
  { kind: 'openHistoryFromBrowser', nodeId: 'node-1' },
  // P6 历史与比较。
  { kind: 'selectHistoryRevision', id: 'r1281' },
  { kind: 'toggleHistoryRevision', id: 'r1281' },
  { kind: 'loadMoreHistory' },
  { kind: 'setHistoryFilter', id: 'author', value: '林舟' },
  { kind: 'clearHistoryFilters' },
  { kind: 'resetHistorySession' },
  { kind: 'refreshHistoryUpper', mode: 'head' },
  { kind: 'compareHistoryRevisions' },
  { kind: 'selectCompareCandidate', id: 'cand-1' },
  { kind: 'openHistoryDiff' },
  { kind: 'comparePreviousVisible' },
  { kind: 'compareBase' },
  { kind: 'viewHistoryRevision' },
  { kind: 'exportHistoryVersion' },
  { kind: 'copyHistoryText', copyKind: 'message', id: 'r1281' },
  { kind: 'blameHistoryRevision' },
  { kind: 'updateToHistoryRevision' },
  { kind: 'rescanHistoryUpdate' },
  { kind: 'checkoutHistoryDirectory' },
  // P7 冲突处理。
  { kind: 'selectConflict', id: 'conflict-1' },
  { kind: 'setConflictTab', tab: 'property' },
  { kind: 'chooseConflictVariant', value: 'mine-conflict' },
  { kind: 'choosePropertyValue', property: 'svn:mime-type', choice: 'incoming' },
  { kind: 'applyConflictResolution' },
  { kind: 'postponeConflict' },
  { kind: 'prepareTreeConflict' },
  { kind: 'rescanConflicts', scope: 'task' },
  { kind: 'planConflictBatch' },
  { kind: 'startConflictBatch' },
  { kind: 'showConflictBatchResults' },
  { kind: 'scanWholeWorkCopy' },
  { kind: 'inspectConflict' },
  { kind: 'openWorkCopyTerminal' },
  { kind: 'openConflictDiff' },
  { kind: 'openConflictEditor' },
  { kind: 'openConflictVersion', role: 'base' },
  { kind: 'copyConflictPath', id: 'conflict-1' },
  { kind: 'authenticateConflictSource' },
];

const parseIntentOf = (intent: Record<string, unknown>) => parseViewMessage(intentMessage({ intent }));

describe('parseViewMessage：M4 冻结动作对账表全集', () => {
  it('全部 M4 动作按合法载荷解析成功且载荷字段原样保留', () => {
    for (const intent of M4_LEGAL_INTENTS) {
      const parsed = parseIntentOf(intent);
      expect(parsed.ok, String(intent.kind)).toBe(true);
      if (parsed.ok) {
        expect((parsed.message as IntentMessage).intent, String(intent.kind)).toEqual(intent);
      }
    }
  });

  it('导出白名单与对账表测试全集一一对应（防漏登记/多登记）', () => {
    const declared = [...M4_INTENT_KINDS].sort();
    const covered = M4_LEGAL_INTENTS.map((intent) => String(intent.kind)).sort();
    expect(covered).toEqual(declared);
  });

  it('白名单外相近动作仍被拒绝（不因前缀相似放行）', () => {
    for (const kind of ['loadMore', 'refreshHistory', 'resolveConflict', 'beginResolve', 'scan', 'copyConflict']) {
      expect(parseIntentOf({ kind }).ok, kind).toBe(false);
    }
  });
});

describe('parseViewMessage：M4 参数校验', () => {
  it('nodeId 必须是字符串；稳定 ID 不接受数字/null', () => {
    expect(parseIntentOf({ kind: 'toggleBrowserNode', nodeId: 42 }).ok).toBe(false);
    expect(parseIntentOf({ kind: 'refreshBrowserNode' }).ok).toBe(false);
    expect(parseIntentOf({ kind: 'selectHistoryRevision', id: null }).ok).toBe(false);
    expect(parseIntentOf({ kind: 'selectConflict', id: 'c-1' }).ok).toBe(true);
  });

  it('setHistoryFilter 要求 id/value 都是字符串（字段名 id，不接收路径）', () => {
    expect(parseIntentOf({ kind: 'setHistoryFilter', id: 'path', value: 'src/' }).ok).toBe(true);
    expect(parseIntentOf({ kind: 'setHistoryFilter', id: 'author' }).ok).toBe(false);
    expect(parseIntentOf({ kind: 'setHistoryFilter', id: 'author', value: 3 }).ok).toBe(false);
    expect(parseIntentOf({ kind: 'setHistoryFilter', value: 'x' }).ok).toBe(false);
  });

  it('refreshHistoryUpper.mode 只允许 head/base-fallback，其余枚举在解析层拒绝', () => {
    expect(parseIntentOf({ kind: 'refreshHistoryUpper', mode: 'head' }).ok).toBe(true);
    expect(parseIntentOf({ kind: 'refreshHistoryUpper', mode: 'base-fallback' }).ok).toBe(true);
    for (const mode of ['unresolved', 'live-head', 'HEAD', 'base', '', 42, undefined]) {
      const parsed = parseIntentOf({ kind: 'refreshHistoryUpper', mode });
      expect(parsed.ok, `mode=${String(mode)}`).toBe(false);
      if (!parsed.ok) {
        expect(parsed.reason).toContain('refreshHistoryUpper');
        expect(parsed.reason).toContain('head');
        expect(parsed.reason).toContain('base-fallback');
      }
    }
  });

  it('copyHistoryText 校验 copyKind 枚举与 id', () => {
    for (const copyKind of ['revision', 'message', 'changedPath', 'nodeUrl', 'targetPath']) {
      expect(parseIntentOf({ kind: 'copyHistoryText', copyKind, id: 'r1' }).ok, copyKind).toBe(true);
    }
    expect(parseIntentOf({ kind: 'copyHistoryText', copyKind: 'url', id: 'r1' }).ok).toBe(false);
    expect(parseIntentOf({ kind: 'copyHistoryText', copyKind: 'message' }).ok).toBe(false);
    expect(parseIntentOf({ kind: 'copyHistoryText', id: 'r1' }).ok).toBe(false);
  });

  it('setConflictTab 只允许 all/text/property/tree', () => {
    for (const tab of ['all', 'text', 'property', 'tree']) {
      expect(parseIntentOf({ kind: 'setConflictTab', tab }).ok, tab).toBe(true);
    }
    for (const tab of ['files', 'conflicts', 'binary', '']) {
      expect(parseIntentOf({ kind: 'setConflictTab', tab }).ok, tab).toBe(false);
    }
  });

  it('chooseConflictVariant 只允许六种 svn resolve --accept 变体（postpone 不是 accept 值）', () => {
    for (const value of ['mine-full', 'theirs-full', 'working', 'base', 'mine-conflict', 'theirs-conflict']) {
      expect(parseIntentOf({ kind: 'chooseConflictVariant', value }).ok, value).toBe(true);
    }
    for (const value of ['postpone', 'theirs', 'mine', 'postpone-conflict']) {
      expect(parseIntentOf({ kind: 'chooseConflictVariant', value }).ok, value).toBe(false);
    }
  });

  it('planConflictBatch.strategy 只允许 theirs-full/mine-full；缺省不携带策略字段', () => {
    const without = parseIntentOf({ kind: 'planConflictBatch' });
    expect(without.ok).toBe(true);
    if (without.ok) {
      expect((without.message as IntentMessage).intent).toEqual({ kind: 'planConflictBatch' });
    }
    for (const strategy of ['theirs-full', 'mine-full']) {
      const parsed = parseIntentOf({ kind: 'planConflictBatch', strategy });
      expect(parsed.ok, strategy).toBe(true);
      if (parsed.ok) {
        expect((parsed.message as IntentMessage).intent).toEqual({ kind: 'planConflictBatch', strategy });
      }
    }
    for (const strategy of ['postpone', 'working', 'base', 'mine-conflict', 'theirs', '', 42, null]) {
      const parsed = parseIntentOf({ kind: 'planConflictBatch', strategy });
      expect(parsed.ok, `strategy=${String(strategy)}`).toBe(false);
      if (!parsed.ok) {
        expect(parsed.reason).toContain('planConflictBatch');
      }
    }
  });

  it('rescanConflicts.scope 只允许 task/whole', () => {
    expect(parseIntentOf({ kind: 'rescanConflicts', scope: 'task' }).ok).toBe(true);
    expect(parseIntentOf({ kind: 'rescanConflicts', scope: 'whole' }).ok).toBe(true);
    for (const scope of ['current', 'all', 'default', '']) {
      expect(parseIntentOf({ kind: 'rescanConflicts', scope }).ok, scope).toBe(false);
    }
  });

  it('choosePropertyValue 只允许 local/base/incoming 且属性名必须是字符串', () => {
    for (const choice of ['local', 'base', 'incoming']) {
      expect(parseIntentOf({ kind: 'choosePropertyValue', property: 'svn:ignore', choice }).ok, choice).toBe(true);
    }
    for (const choice of ['mine', 'theirs', 'LOCAL', 'working', '']) {
      expect(parseIntentOf({ kind: 'choosePropertyValue', property: 'k', choice }).ok, choice).toBe(false);
    }
    expect(parseIntentOf({ kind: 'choosePropertyValue', property: 42, choice: 'local' }).ok).toBe(false);
    expect(parseIntentOf({ kind: 'choosePropertyValue', choice: 'local' }).ok).toBe(false);
    expect(parseIntentOf({ kind: 'choosePropertyValue', property: 'k' }).ok).toBe(false);
  });

  it('openConflictVersion.role 只允许 local/base/incoming', () => {
    for (const role of ['local', 'base', 'incoming']) {
      expect(parseIntentOf({ kind: 'openConflictVersion', role }).ok, role).toBe(true);
    }
    for (const role of ['mine', 'theirs', 'left', 'right']) {
      expect(parseIntentOf({ kind: 'openConflictVersion', role }).ok, role).toBe(false);
    }
  });

  it('M4 意图载荷里同样不存在路径类字段（视图不能传任意路径）', () => {
    const parsed = parseIntentOf({ kind: 'openRemoteNode', nodeId: 'n-1', path: '/tmp/evil' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(Object.keys((parsed.message as IntentMessage).intent).sort()).toEqual(['kind', 'nodeId']);
    }
    const filtered = parseIntentOf({ kind: 'setHistoryFilter', id: 'path', value: 'x', targetPath: '/evil' });
    expect(filtered.ok).toBe(true);
    if (filtered.ok) {
      expect(Object.keys((filtered.message as IntentMessage).intent).sort()).toEqual(['id', 'kind', 'value']);
    }
  });

  it('M4 无参动作忽略多余载荷字段（只回传 kind）', () => {
    for (const kind of ['scanWholeWorkCopy', 'loadMoreHistory', 'startConflictBatch', 'updateToHistoryRevision', 'rescanHistoryUpdate']) {
      const parsed = parseIntentOf({ kind, path: '/tmp/evil', id: 'x' });
      expect(parsed.ok, kind).toBe(true);
      if (parsed.ok) {
        expect((parsed.message as IntentMessage).intent).toEqual({ kind });
      }
    }
  });
});
