/**
 * 0a「状态与 fixture 字段映射」的 typed fixture：原型模拟状态到正式类型的
 * 落地。先通过类型检查，再复用为 vitest / mock-host 的测试数据。
 *
 * 边界：
 * - 只保留映射表认定的正式字段；原型的工具条状态、模拟结果注入、
 *   successVisible、missingPrepared/addedPrepared 独立数组等一律不进类型；
 * - fixture 中的 /workspace/wc-a、s1… 与示例 revision 是测试数据，
 *   不是运行时状态；路径与 changelist 名称按原值保留（含首尾空格场景）；
 * - 本文件不 import vscode。
 */
import type { OperationRecord } from '../../core/operations';
import type { BannerSpec } from './state';

/* ---------------------------- P1 提交面板类型 ---------------------------- */

export type ExtensionFilter =
  | { kind: 'all' }
  | { kind: 'none' }
  | { kind: 'directory' }
  | { kind: 'extension'; value: string };

export type ChangelistFilter =
  | { kind: 'all' }
  | { kind: 'unassigned' }
  | { kind: 'name'; value: string };

/** P1 分组：由本地状态、冲突与远端状态完整推导，不是 wcStatus 的别名。 */
export type CommitGroup = 'local' | 'unversioned' | 'conflict' | 'remote';

export type CommitPhase =
  | 'loading'
  | 'loadError'
  | 'ready'
  | 'refreshing'
  | 'checking'
  | 'committing'
  | 'stale'
  | 'unknown'
  | 'coordinationBlocked';

/** 条目级徽标：changelist、目录属性等多枚标记（技术方案 §2.3）。 */
export interface CommitBadge {
  text: string;
  kind?: 'muted' | 'warn';
}

export interface CommitItem {
  /** 稳定 ID：意图只带 ID，路径由宿主从条目映射取得。 */
  id: string;
  /** 相对副本根的原始路径，保留首尾空格，不 trim。 */
  path: string;
  /** svn 工作副本状态原词（modified / unversioned / conflicted …）。 */
  wcStatus: string;
  kind: 'file' | 'dir';
  /** 属性状态原词（none / normal / modified）；纯属性变更识别依据。 */
  props: string;
  changelist: string | null;
  group: CommitGroup;
  selected: boolean;
  /** 不可勾选等原因（冲突/仅远端等）。 */
  disabledReason?: string;
  badges?: CommitBadge[];
}

export interface CommitFilters {
  status: string;
  ext: ExtensionFilter;
  changelist: ChangelistFilter;
}

export interface CommitResult {
  kind: 'success' | 'partial';
  revisions: number[];
  committedIds: string[];
}

export interface CommitPanelState {
  sessionId: string;
  wcRoot: string;
  targetLabel: string;
  targetPath: string;
  items: CommitItem[];
  filters: CommitFilters;
  message: string;
  prefixes: string[];
  history: string[];
  allowEmpty: boolean;
  busy: boolean;
  phase: CommitPhase;
  error: string | null;
  banners: BannerSpec[];
  result: CommitResult | null;
  operation: OperationRecord | null;
}

/* -------------------------- P2 忽略规则编辑器类型 -------------------------- */

/** P2 会话相位（正式定义在 ignoreModel；此处保留导出供既有引用）。 */
export type { IgnoreSessionPhase as IgnorePhase } from './ignoreModel';

/** 工作副本实际快照：与编辑草稿、保存基线、仓库 BASE 分开。 */
export interface WorkingSnapshot {
  rules: string[];
  exists: boolean;
}

export interface IgnorePanelState {
  sessionId: string;
  wcRoot: string;
  targetPath: string;
  targetLabel: string;
  originName: string | null;
  rules: string[];
  propertyExists: boolean;
  savedRules: string[];
  savedPropertyExists: boolean;
  workingSnapshot: WorkingSnapshot;
  repositoryRules: string[];
  repositoryPropertyExists: boolean;
  draft: string;
  busy: boolean;
  phase: import('./ignoreModel').IgnoreSessionPhase;
  error: string | null;
  banners: BannerSpec[];
  localModified: boolean;
  submittedRevision: number | null;
  operation: OperationRecord | null;
  externalChanged: boolean;
  /** 其他属性只存键名与是否有变更标记，不把属性值写进面板状态或日志。 */
  otherProperties: Array<{ name: string; modified: boolean }>;
}

/* ------------------------------ P1 fixture ------------------------------ */

function commitItem(
  id: string,
  path: string,
  wcStatus: string,
  patch: Partial<CommitItem> = {},
): CommitItem {
  return {
    id,
    path,
    wcStatus,
    kind: 'file',
    props: 'normal',
    changelist: null,
    group: 'local',
    selected: !['unversioned', 'conflicted'].includes(wcStatus),
    ...patch,
  };
}

/** 原型 normal 场景的条目集合，按原值翻译为正式字段。 */
export const FIXTURE_COMMIT_ITEMS: CommitItem[] = [
  commitItem('s1', 'src/core/status.ts', 'modified', { changelist: 'mylist' }),
  commitItem('s2', 'src/host/commit.ts', 'modified', { changelist: 'mylist' }),
  commitItem('s3', 'src/host/panel/host.ts', 'added'),
  commitItem('s4', 'src/host/legacy-picker.ts', 'deleted'),
  commitItem('s5', 'package.json', 'modified', { changelist: 'other', props: 'modified' }),
  commitItem('s6', 'src/', 'normal', { kind: 'dir', props: 'modified' }),
  commitItem('u1', 'notes.txt', 'unversioned', { group: 'unversioned' }),
  commitItem('u2', 'tmp/scratch.md', 'unversioned', { group: 'unversioned' }),
];

function commitBase(patch: Partial<CommitPanelState> = {}): CommitPanelState {
  return {
    sessionId: 'session-fixture',
    wcRoot: '/workspace/wc-a',
    targetLabel: 'wc-a · 工作副本根',
    targetPath: '/workspace/wc-a',
    items: structuredClone(FIXTURE_COMMIT_ITEMS),
    filters: { status: 'all', ext: { kind: 'all' }, changelist: { kind: 'all' } },
    message: '',
    prefixes: ['修复', '功能', '重构'],
    history: ['修复提交说明换行被展平', '完成面板基座\n\n验证列表与表单的共用协议'],
    allowEmpty: true,
    busy: false,
    phase: 'ready',
    error: null,
    banners: [],
    result: null,
    operation: null,
    ...patch,
  };
}

/** 15 个场景的字段组合（映射表 §3.1）；异常分支由 phase/result 组合表达。 */
export function commitFixture(scene: string): CommitPanelState {
  switch (scene) {
    case 'loading':
      return commitBase({ phase: 'loading', busy: true, items: [] });
    case 'loadError':
      return commitBase({
        phase: 'loadError',
        items: [],
        error: 'svn: E155004: 工作副本已锁定\n请检查工作副本状态后重新读取。',
      });
    case 'empty':
      return commitBase({ items: [] });
    case 'filtered':
      return commitBase({ filters: { status: 'replaced', ext: { kind: 'all' }, changelist: { kind: 'all' } } });
    case 'conflict':
      return commitBase({
        items: [
          ...structuredClone(FIXTURE_COMMIT_ITEMS),
          commitItem('c1', 'merged/conflict.ts', 'conflicted', { group: 'conflict', selected: false }),
        ],
      });
    case 'missing':
      return commitBase({
        items: [
          ...structuredClone(FIXTURE_COMMIT_ITEMS),
          commitItem('m1', 'old/removed.txt', 'missing'),
          commitItem('m2', 'old/unused.json', 'missing'),
        ],
      });
    case 'changelist':
      return commitBase({
        filters: { status: 'all', ext: { kind: 'all' }, changelist: { kind: 'name', value: 'mylist' } },
        items: structuredClone(FIXTURE_COMMIT_ITEMS).map((item) => ({
          ...item,
          selected: item.changelist === 'mylist',
        })),
      });
    case 'remote':
      return commitBase({
        items: [
          ...structuredClone(FIXTURE_COMMIT_ITEMS),
          commitItem('r1', 'remote/incoming.ts', 'normal', { group: 'remote', selected: false }),
        ],
      });
    case 'committing':
      return commitBase({ message: '调整提交面板交互', busy: true, phase: 'committing' });
    case 'error':
      return commitBase({
        message: '修复：保留本次输入\n\n失败后可修改说明并重试。',
        error: 'svn: E170001: 认证失败\nsvn: E170013: 无法连接仓库',
      });
    case 'success':
      return commitBase({
        items: structuredClone(FIXTURE_COMMIT_ITEMS).filter((item) => !item.selected),
        result: { kind: 'success', revisions: [128], committedIds: ['s1', 's2', 's3', 's4', 's5', 's6'] },
      });
    case 'partial':
      return commitBase({
        items: [commitItem('p1', 'src/remaining.ts', 'modified'), commitItem('p2', 'src/later.ts', 'modified')],
        message: '调整模块逻辑',
        result: { kind: 'partial', revisions: [128], committedIds: [] },
        error: '第二批提交失败。已重新读取状态，成功项已从列表移除。',
      });
    case 'directories':
      return commitBase({
        items: [
          commitItem('nd', 'newdir/', 'unversioned', { kind: 'dir', group: 'unversioned' }),
          commitItem('nf', 'newdir/main.ts', 'unversioned', { group: 'unversioned' }),
          commitItem('ns', 'newdir/sub/', 'unversioned', { kind: 'dir', group: 'unversioned' }),
          commitItem('nc', 'newdir/sub/child.txt', 'unversioned', { group: 'unversioned' }),
          commitItem('nl', 'newdir/link', 'unversioned', { group: 'unversioned' }),
          commitItem('ad', 'added-dir/', 'added', { kind: 'dir' }),
          commitItem('dd', 'deleted-dir/', 'deleted', { kind: 'dir' }),
          commitItem('dc', 'deleted-dir/old.txt', 'deleted'),
        ],
      });
    case 'large': {
      const items = Array.from({ length: 200 }, (_, i): CommitItem =>
        commitItem(`n${i}`, `src/module-${String(i % 12).padStart(2, '0')}/file-${String(i).padStart(3, '0')}.ts`, i % 17 === 0 ? 'unversioned' : 'modified', {
          group: i % 17 === 0 ? 'unversioned' : 'local',
          changelist: i % 5 === 0 ? 'mylist' : null,
        }),
      );
      return commitBase({ items });
    }
    default:
      return commitBase();
  }
}

/* --------------------------- P2 fixture（12 场景样例） --------------------------- */

const IGNORE_RULES = ['*.log', 'node_modules', '.DS_Store'];

function ignoreBase(patch: Partial<IgnorePanelState> = {}): IgnorePanelState {
  return {
    sessionId: 'session-fixture',
    wcRoot: '/workspace/wc-a',
    targetPath: '/workspace/wc-a/src',
    targetLabel: 'wc-a · src/',
    originName: 'debug.log',
    rules: [...IGNORE_RULES],
    propertyExists: true,
    savedRules: [...IGNORE_RULES],
    savedPropertyExists: true,
    workingSnapshot: { rules: [...IGNORE_RULES], exists: true },
    repositoryRules: [...IGNORE_RULES],
    repositoryPropertyExists: true,
    draft: '',
    busy: false,
    phase: 'ready',
    error: null,
    banners: [],
    localModified: false,
    submittedRevision: null,
    operation: null,
    externalChanged: false,
    otherProperties: [{ name: 'custom:keep', modified: false }],
    ...patch,
  };
}

/** P2 原型 12 场景的字段组合；异常分支由 phase/error/notice 组合表达。 */
export function ignoreFixture(scene = 'normal'): IgnorePanelState {
  switch (scene) {
    case 'loading':
      return ignoreBase({ phase: 'loading', busy: true, rules: [] });
    case 'loadError':
      return ignoreBase({
        phase: 'loadError',
        rules: [],
        error: 'svn: E155007: 目标不是有效工作副本（样例）',
      });
    case 'empty':
      return ignoreBase({
        rules: [],
        propertyExists: false,
        savedRules: [],
        savedPropertyExists: false,
        repositoryRules: [],
        repositoryPropertyExists: false,
        workingSnapshot: { rules: [], exists: false },
      });
    case 'dirty':
      return ignoreBase({ rules: [...IGNORE_RULES, '.idea'] });
    case 'draft':
      return ignoreBase({ draft: '.idea' });
    case 'duplicate':
      return ignoreBase({ draft: '.DS_Store', banners: [{ id: 'notice', level: 'info', title: '该模式已在规则中，未重复加入。' }] });
    case 'saving':
      return ignoreBase({ busy: true, phase: 'saving', rules: [...IGNORE_RULES, '.idea'] });
    case 'error':
      return ignoreBase({
        rules: [...IGNORE_RULES, '.idea'],
        error: 'svn: E155004: 工作副本已锁定（样例）\n写回失败；编辑内容已保留。',
      });
    case 'saved':
      return ignoreBase({
        rules: [...IGNORE_RULES, '.idea'],
        savedRules: [...IGNORE_RULES, '.idea'],
        savedPropertyExists: true,
        workingSnapshot: { rules: [...IGNORE_RULES, '.idea'], exists: true },
        repositoryRules: [...IGNORE_RULES],
        localModified: true,
      });
    case 'external':
      return ignoreBase({
        rules: [...IGNORE_RULES, '.idea'],
        externalChanged: true,
        banners: [{ id: 'notice', level: 'info', title: '另一处已修改 svn:ignore；保存时会比较读取基线，避免覆盖。' }],
      });
    case 'literal':
      return ignoreBase({ originName: 'cache[1]?.log' });
    default:
      return ignoreBase();
  }
}

/* ---------------------------- 冒烟列表面板 fixture ---------------------------- */

/** 状态字母缩写（与终端 svn status 一致的视觉映射，title 保留原词）。 */
export const STATUS_LETTERS: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  missing: '!',
  replaced: 'R',
  normal: '·',
  unversioned: '?',
  conflicted: 'C',
};
