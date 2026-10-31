/**
 * P2 忽略规则编辑器纯逻辑测试：四层值比较、草稿校验、渲染态派生
 * （徽标/页脚禁用/横幅/空态/成功卡片）与操作记录恢复分类。
 */
import { describe, expect, it } from 'vitest';
import {
  buildIgnorePanelState,
  checkDraft,
  dirtyOf,
  draftPending,
  hasUnsavedDraft,
  localModifiedOf,
  removeRuleAt,
  restrictionPhase,
  type IgnoreSessionState,
} from '../src/host/panel/ignoreModel';
import type { OperationRecord } from '../src/core/operations';
import { strings } from '../src/host/i18n';

function session(patch: Partial<IgnoreSessionState> = {}): IgnoreSessionState {
  const rules = ['*.log', 'build'];
  return {
    sessionId: 's1',
    wcRoot: '/tmp/wc',
    targetDir: '/tmp/wc/src',
    dirArg: 'src',
    originName: 'debug.log',
    identity: null,
    rules: [...rules],
    savedRules: [...rules],
    savedPropertyExists: true,
    workingSnapshot: { rules: [...rules], exists: true },
    repositoryRules: [...rules],
    repositoryPropertyExists: true,
    draft: '',
    phase: 'ready',
    error: null,
    notice: null,
    localModified: false,
    submittedRevision: null,
    successVisible: true,
    operation: null,
    ...patch,
  };
}

describe('P2 四层值比较', () => {
  it('dirty：清空列表与未修改不同（属性存在性参与比较）', () => {
    expect(dirtyOf(session())).toBe(false);
    expect(dirtyOf(session({ rules: ['*.log', 'build', '.idea'] }))).toBe(true);
    // 清空：rules=[] 且基线存在 → dirty。
    expect(dirtyOf(session({ rules: [] }))).toBe(true);
    // 基线本来就没有属性、列表也为空 → 不 dirty。
    expect(dirtyOf(session({
      rules: [],
      savedRules: [],
      savedPropertyExists: false,
    }))).toBe(false);
  });

  it('localModified：保存基线与 BASE 比较（外部改动只更新实际快照，不写 BASE）', () => {
    expect(localModifiedOf(session())).toBe(false);
    expect(localModifiedOf(session({ repositoryRules: ['*.log'] }))).toBe(true);
    expect(localModifiedOf(session({
      workingSnapshot: { rules: ['*.log', 'build', 'ext'], exists: true },
    }))).toBe(false);
  });

  it('hasUnsavedDraft 含待加入输入；draftPending 独立判断', () => {
    expect(hasUnsavedDraft(session())).toBe(false);
    expect(draftPending(session())).toBe(false);
    expect(hasUnsavedDraft(session({ draft: '.idea' }))).toBe(true);
    expect(draftPending(session({ draft: '.idea' }))).toBe(true);
    expect(hasUnsavedDraft(session({ rules: [] }))).toBe(true);
  });
});

describe('P2 草稿校验与规则操作', () => {
  it('checkDraft：空 / 路径分隔符与换行 / 重复 / 可加入', () => {
    expect(checkDraft('', ['*.log'])).toBe('empty');
    expect(checkDraft('./secret.txt', [])).toBe('pathLike');
    expect(checkDraft('a/b', [])).toBe('pathLike');
    expect(checkDraft('a\nb', [])).toBe('pathLike');
    expect(checkDraft('*.log', ['*.log'])).toBe('duplicate');
    expect(checkDraft('*.tmp', ['*.log'])).toBe('ok');
    // 首尾空格按原值处理，不 trim。
    expect(checkDraft(' build ', ['build'])).toBe('ok');
  });

  it('removeRuleAt 按序号移除，越界保持原列表', () => {
    expect(removeRuleAt(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
    expect(removeRuleAt(['a'], -1)).toEqual(['a']);
    expect(removeRuleAt(['a'], 1)).toEqual(['a']);
  });
});

describe('P2 渲染态派生', () => {
  it('ready：徽标、条数、hint、页脚与输入区', () => {
    const state = buildIgnorePanelState(session());
    expect(state.headerBadges?.map((b) => b.text)).toEqual(['已读取', '2 条']);
    expect(state.hint).toContain('svn:ignore');
    expect(state.headerActions?.[0]?.label).toBe('重新读取');
    expect(state.ignoreEditor?.rules.map((r) => r.text)).toEqual(['*.log', 'build']);
    expect(state.ignoreEditor?.draft.value).toBe('');
    // 无修改：保存与提交都禁用。
    expect(state.footer?.secondary?.find((a) => a.id === 'saveIgnore')?.disabled).toBe(true);
    expect(state.footer?.primary?.disabled).toBe(true);
    expect(state.footer?.summary).toBe('规则列表无修改');
  });

  it('dirty：徽标「未保存」、保存可用、提交可用、清空时空态为删除属性', () => {
    const dirty = buildIgnorePanelState(session({ rules: ['*.log', 'build', '.idea'] }));
    expect(dirty.headerBadges?.[0]).toEqual({ text: '未保存', warn: true });
    expect(dirty.footer?.secondary?.find((a) => a.id === 'saveIgnore')?.disabled).toBe(false);
    expect(dirty.footer?.primary?.disabled).toBe(false);
    expect(dirty.footer?.summary).toBe('有未保存修改');
    const cleared = buildIgnorePanelState(session({ rules: [] }));
    expect(cleared.footer?.summary).toBe('保存将删除 svn:ignore 属性');
    expect(cleared.ignoreEditor?.empty.title).toBe('当前列表已清空');
  });

  it('draft 未处理：保存与提交禁用并给出原因', () => {
    const state = buildIgnorePanelState(session({ draft: '.idea' }));
    expect(state.footer?.secondary?.find((a) => a.id === 'saveIgnore')?.disabled).toBe(true);
    expect(state.footer?.primary?.disabled).toBe(true);
    expect(state.footer?.primary?.disabledReason).toBe(strings.ignorePanel.saveBlockedByDraft);
    expect(state.footer?.summary).toBe(strings.ignorePanel.summaryPendingDraft);
  });

  it('localModified：本地已保存待提交，提交可用；成功卡片为本机保存版', () => {
    const state = buildIgnorePanelState(session({
      savedRules: ['*.log', 'build', '.idea'],
      rules: ['*.log', 'build', '.idea'],
      workingSnapshot: { rules: ['*.log', 'build', '.idea'], exists: true },
      repositoryRules: ['*.log', 'build'],
      localModified: true,
    }));
    expect(state.headerBadges?.[0]?.text).toBe('本地已保存 · 待提交');
    expect(state.footer?.primary?.disabled).toBe(false);
    expect(state.footer?.summary).toBe('本地已保存，尚未提交到 SVN');
    const success = state.banners.find((b) => b.id === 'commitSuccess');
    expect(success?.title).toBe('忽略规则已保存到本机');
    expect(success?.detail).toContain('尚未提交到 SVN');
  });

  it('submittedRevision：提交版成功卡片含 revision 与范围说明', () => {
    const state = buildIgnorePanelState(session({ submittedRevision: 128, localModified: false }));
    const success = state.banners.find((b) => b.id === 'commitSuccess');
    expect(success?.title).toBe('忽略规则已提交到 SVN');
    expect(success?.detail).toContain('r128');
    expect(success?.detail).toContain('仅提交当前目录的 svn:ignore');
  });

  it('unknown：写锁定、横幅核实入口、保存/提交/输入全禁用', () => {
    const state = buildIgnorePanelState(session({
      phase: 'unknown',
      operation: { knownRevisions: [] } as unknown as OperationRecord,
    }));
    expect(state.writeLocked).toBe(true);
    expect(state.busy).toBe(false);
    const banner = state.banners.find((b) => b.id === 'unknown');
    expect(banner?.title).toContain('提交结果未知');
    expect(banner?.actions?.[0]?.id).toBe('resolveUnknown');
    expect(state.footer?.primary?.disabled).toBe(true);
    expect(state.footer?.secondary?.find((a) => a.id === 'saveIgnore')?.disabled).toBe(true);
    expect(state.footer?.secondary?.find((a) => a.id === 'closePanel')?.disabled).toBe(true);
    expect(state.ignoreEditor?.draft.disabled).toBe(true);
  });

  it('coordinationBlocked：待协调徽标与横幅（含已知 revision）', () => {
    const state = buildIgnorePanelState(session({
      phase: 'coordinationBlocked',
      submittedRevision: 130,
      operation: { knownRevisions: [130] } as unknown as OperationRecord,
    }));
    expect(state.writeLocked).toBe(true);
    expect(state.headerBadges?.[0]?.text).toBe('待协调');
    const banner = state.banners.find((b) => b.id === 'reconcile');
    expect(banner?.title).toContain('r130');
    expect(banner?.actions?.[0]?.id).toBe('resolveUnknown');
  });

  it('loadError：读取失败空态独立于空规则，保存/提交禁用', () => {
    const state = buildIgnorePanelState(session({
      phase: 'loadError',
      error: 'svn: E155007',
      rules: [],
    }));
    expect(state.ignoreEditor?.empty.title).toBe('无法读取当前目录规则');
    expect(state.ignoreEditor?.empty.detail).toContain('读取失败不等于空规则');
    expect(state.footer?.primary?.disabled).toBe(true);
    expect(state.footer?.secondary?.find((a) => a.id === 'saveIgnore')?.disabled).toBe(true);
    expect(state.banners.find((b) => b.id === 'error')?.title).toBe('读取失败');
  });

  it('空属性与未设置属性：空态区分其他忽略来源说明', () => {
    const state = buildIgnorePanelState(session({
      rules: [],
      savedRules: [],
      savedPropertyExists: false,
      workingSnapshot: { rules: [], exists: false },
      repositoryRules: [],
      repositoryPropertyExists: false,
    }));
    expect(state.ignoreEditor?.empty.title).toBe('此目录未设置 svn:ignore');
    expect(state.ignoreEditor?.empty.extra).toContain('svn:global-ignores');
  });

  it('originName：目录入口（null）不渲染「用当前项名」并提供说明', () => {
    const withOrigin = buildIgnorePanelState(session());
    expect(withOrigin.ignoreEditor?.fillAction?.label).toBe('用当前项名');
    expect(withOrigin.ignoreEditor?.originNote).toContain('debug.log');
    const dirEntry = buildIgnorePanelState(session({ originName: null }));
    expect(dirEntry.ignoreEditor?.fillAction).toBeUndefined();
    expect(dirEntry.ignoreEditor?.noOriginNote).toContain('自行填写');
  });

  it('忙碌相位：saving/committing/coordinating 呈现进度与对应摘要', () => {
    expect(buildIgnorePanelState(session({ phase: 'saving', draft: '' })).busy).toBe(true);
    expect(buildIgnorePanelState(session({ phase: 'saving' })).footer?.summary).toBe('正在写回工作副本…');
    expect(buildIgnorePanelState(session({ phase: 'committing' })).footer?.summary).toBe('正在提交忽略规则…');
    expect(buildIgnorePanelState(session({ phase: 'coordinating' })).footer?.summary).toBe('正在协调原副本…');
  });
});

describe('P2 操作记录恢复分类', () => {
  const record = (phase: OperationRecord['phase'], property = true): OperationRecord => ({
    operationId: 'op-1',
    wcRoot: '/tmp/wc',
    targetRelPath: 'src',
    nodeKind: 'dir',
    phase,
    knownRevisions: [],
    updatedAt: 0,
    property: property ? { name: 'svn:ignore' } : undefined,
  });

  it('unknown/saving/committing → unknown；待协调态 → coordinationBlocked', () => {
    expect(restrictionPhase(record('unknown'))).toBe('unknown');
    expect(restrictionPhase(record('saving'))).toBe('unknown');
    expect(restrictionPhase(record('committing'))).toBe('unknown');
    expect(restrictionPhase(record('committed-pending-coordination'))).toBe('coordinationBlocked');
    expect(restrictionPhase(record('coordination-blocked'))).toBe('coordinationBlocked');
  });

  it('非 P2 属性记录归为 foreign（提交面板的在途操作）', () => {
    expect(restrictionPhase(record('unknown', false))).toBe('foreign');
  });
});
