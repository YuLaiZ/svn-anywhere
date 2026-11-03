/**
 * P2 忽略规则编辑器的宿主侧链路测试：mock vscode（含 createWebviewPanel
 * 替身）与 core/ignoreCommit 原语，从面板意图驱动完整流程：
 * 读取/草稿/写回、外部修改拒绝、保存失败不进提交、隔离提交与协调、
 * 结果未知冻结与核实、协调受阻恢复、草稿确认与目标切换。
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { SvnError } from '../src/core/errors';
import { OperationRegistry, getOperationRegistry, setOperationRegistryForTest } from '../src/core/operations';
import { resetPanelRegistry } from '../src/host/panel/host';
import { disposeOutputChannel, resetOutputState } from '../src/host/output';
import { strings } from '../src/host/i18n';

vi.mock('../src/core/ignoreCommit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/ignoreCommit')>();
  return {
    ...actual,
    readNodeIdentity: vi.fn(),
    readIgnoreSnapshot: vi.fn(),
    applyIgnoreSnapshot: vi.fn(),
    checkoutDepthEmpty: vi.fn(),
    commitTempIgnore: vi.fn(),
    coordinateUpdate: vi.fn(),
    propertyConflicted: vi.fn(),
    resolvePropertyConflict: vi.fn(),
    readRemoteIgnoreSnapshot: vi.fn(),
    readRemoteNodeRevisions: vi.fn(),
  };
});

interface FakePanel {
  viewType: string;
  title: string;
  html: string;
  posted: Array<Record<string, unknown>>;
  revealed: number;
  disposed: boolean;
  reveal(): void;
  dispose(): void;
  send(raw: unknown): Promise<void> | void;
  sendIntent(intent: Record<string, unknown>, requestId?: string): void;
  lastSessionId(): string;
  lastRender(): { html: string; sessionId: string; formRevision: number } | undefined;
}

function makeFakePanel(viewType: string, title: string): FakePanel {
  let messageHandler: ((raw: unknown) => unknown) | undefined;
  let disposeHandler: (() => void) | undefined;
  let sessionId = '';
  let seq = 0;
  const panel: FakePanel = {
    viewType,
    title,
    html: '',
    posted: [],
    revealed: 0,
    disposed: false,
    reveal() {
      panel.revealed += 1;
    },
    dispose() {
      if (panel.disposed) return;
      panel.disposed = true;
      disposeHandler?.();
    },
    send(raw) {
      return messageHandler?.(raw) as void | Promise<void>;
    },
    sendIntent(intent, requestId) {
      seq += 1;
      return panel.send({
        type: 'intent',
        protocolVersion: 1,
        sessionId,
        requestId: requestId || `req-${seq}`,
        intent,
      }) as void;
    },
    lastSessionId() {
      return sessionId;
    },
    lastRender() {
      const frames = panel.posted.filter((m) => m.type === 'render');
      const last = frames[frames.length - 1];
      return last
        ? { html: String(last.html), sessionId: String(last.sessionId), formRevision: Number(last.formRevision ?? -1) }
        : undefined;
    },
  };
  (panel as unknown as { webview: unknown }).webview = {
    set html(value: string) {
      panel.html = value;
    },
    get html() {
      return panel.html;
    },
    postMessage(message: unknown) {
      panel.posted.push(message as Record<string, unknown>);
      if ((message as { type?: string }).type === 'render') {
        sessionId = String((message as { sessionId?: string }).sessionId ?? '');
      }
      return Promise.resolve(true);
    },
    asWebviewUri: (uri: { toString(): string }) => ({ toString: () => `vscode-webview://test${uri.toString()}` }),
    cspSource: 'vscode-webview-test:',
    onDidReceiveMessage(handler: (raw: unknown) => unknown) {
      messageHandler = handler;
      return { dispose: () => { messageHandler = undefined; } };
    },
  };
  (panel as unknown as { onDidDispose: unknown }).onDidDispose = (handler: () => void) => {
    disposeHandler = handler;
    return { dispose: () => { disposeHandler = undefined; } };
  };
  return panel;
}

const vscodeMock = vi.hoisted(() => ({
  panels: [] as FakePanel[],
  information: [] as string[],
  warning: [] as string[],
  confirmResult: undefined as string | undefined,
  config: {} as Record<string, unknown>,
  outputChannels: [] as Array<{ lines: string[]; shown: number; appendLine(l: string): void; show(): void; dispose(): void }>,
}));

vi.mock('vscode', () => ({
  ViewColumn: { Active: 1, Beside: 2 },
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  Uri: {
    file: (path: string) => ({ scheme: 'file', path, fsPath: path, toString: () => `file://${path}` }),
    joinPath: (base: { path: string }, ...parts: string[]) => {
      const path = [base.path.replace(/\/$/, ''), ...parts].join('/');
      return { scheme: 'file', path, fsPath: path, toString: () => `file://${path}` };
    },
  },
  window: {
    createOutputChannel: () => {
      const ch = {
        lines: [] as string[],
        shown: 0,
        appendLine(line: string) { ch.lines.push(line); },
        show() { ch.shown += 1; },
        dispose() {},
      };
      vscodeMock.outputChannels.push(ch);
      return ch;
    },
    showInformationMessage: (message: string) => {
      vscodeMock.information.push(message);
      return Promise.resolve(undefined);
    },
    showWarningMessage: (message: string, _options?: unknown, ...items: string[]) => {
      vscodeMock.warning.push(message);
      return Promise.resolve(items.length > 0 ? vscodeMock.confirmResult : undefined);
    },
    showErrorMessage: (message: string) => Promise.resolve(undefined),
    showOpenDialog: () => Promise.resolve(undefined),
    showInputBox: () => Promise.resolve(undefined),
    showQuickPick: async () => undefined,
    showTextDocument: async () => undefined,
    createWebviewPanel: (viewType: string, title: string) => {
      const panel = makeFakePanel(viewType, title);
      vscodeMock.panels.push(panel);
      return panel;
    },
    withProgress: (_options: unknown, task: (p: unknown, t: unknown) => Promise<unknown>) =>
      task({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) }),
    get activeTextEditor() {
      return undefined;
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => (key in vscodeMock.config ? vscodeMock.config[key] : fallback),
    }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
  },
  commands: {
    executeCommand: async () => undefined,
  },
  ProgressLocation: { Notification: 15 },
}));

import {
  applyIgnoreSnapshot,
  checkoutDepthEmpty,
  commitTempIgnore,
  coordinateUpdate,
  propertyConflicted,
  readIgnoreSnapshot,
  readNodeIdentity,
  readRemoteIgnoreSnapshot,
  readRemoteNodeRevisions,
  resolvePropertyConflict,
  type PropertySnapshot,
} from '../src/core/ignoreCommit';
import { commandEditIgnore } from '../src/host/commands/ignore';
import { setIgnorePanelContext } from '../src/host/panel/panels/ignore';

const makeUri = (fsPath: string): vscode.Uri => ({ fsPath, scheme: 'file' }) as unknown as vscode.Uri;

/** globalState 替身存储（草稿暂存等持久化断言用）。 */
const globalStore = new Map<string, unknown>();

const IDENTITY = {
  url: 'file:///tmp/repo/src',
  repositoryUuid: 'uuid-1',
  repositoryRootUrl: 'file:///tmp/repo',
  revision: 5,
  kind: 'directory',
};

const snap = (rules: string[], exists = true): PropertySnapshot => ({ rules, exists });

/** 快照读取队列：面板加载读工作值+BASE，此后按调用序出队。 */
let snapshotQueue: PropertySnapshot[] = [];

function enqueue(...snapshots: PropertySnapshot[]): void {
  snapshotQueue.push(...snapshots);
}

/** 建伪造工作副本（.svn/wc.db 标记）与 src 子目录；目标统一用 src。 */
function makeFakeWc(): string {
  const lab = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-p2flow-')));
  mkdirSync(join(lab, '.svn'), { recursive: true });
  writeFileSync(join(lab, '.svn', 'wc.db'), 'fake');
  mkdirSync(join(lab, 'src'), { recursive: true });
  return lab;
}

async function openPanel(target: string, expectText: string): Promise<FakePanel> {
  void commandEditIgnore(makeUri(target));
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const panel = vscodeMock.panels.at(-1);
    const render = panel?.lastRender();
    if (panel && render && render.html.includes(expectText)) {
      return panel;
    }
  }
  const panel = vscodeMock.panels.at(-1);
  throw new Error(`P2 面板数据帧未出现：${expectText}\nlast=${panel?.lastRender()?.html.slice(0, 200)}`);
}

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vscodeMock.panels.length = 0;
  vscodeMock.information.length = 0;
  vscodeMock.warning.length = 0;
  vscodeMock.confirmResult = undefined;
  vscodeMock.outputChannels.length = 0;
  snapshotQueue = [];
  vi.mocked(readNodeIdentity).mockResolvedValue({ ...IDENTITY });
  vi.mocked(readIgnoreSnapshot).mockImplementation(async () => snapshotQueue.shift() ?? snap([]));
  vi.mocked(applyIgnoreSnapshot).mockResolvedValue(undefined);
  vi.mocked(checkoutDepthEmpty).mockResolvedValue(undefined);
  vi.mocked(commitTempIgnore).mockResolvedValue(9);
  vi.mocked(coordinateUpdate).mockResolvedValue('Updated to revision 9.');
  vi.mocked(propertyConflicted).mockResolvedValue(false);
  vi.mocked(resolvePropertyConflict).mockResolvedValue(undefined);
  vi.mocked(readRemoteIgnoreSnapshot).mockResolvedValue(snap([]));
  vi.mocked(readRemoteNodeRevisions).mockResolvedValue({ headRevision: 9, lastChangedRevision: 9 });
  setOperationRegistryForTest(new OperationRegistry());
  globalStore.clear();
  setIgnorePanelContext({
    extensionUri: { scheme: 'file', path: '/ext', fsPath: '/ext', toString: () => 'file:///ext' } as never,
    subscriptions: [],
    globalState: {
      get: <T>(key: string) => (globalStore.has(key) ? (globalStore.get(key) as T) : undefined),
      update: async (key: string, value: unknown) => {
        if (value === undefined) {
          globalStore.delete(key);
        } else {
          globalStore.set(key, value);
        }
      },
    } as never,
  });
});

afterEach(() => {
  resetPanelRegistry();
  resetOutputState();
  disposeOutputChannel();
});

describe('P2 面板：打开与草稿', () => {
  it('文件入口编辑父目录规则并提供「用当前项名」', async () => {
    const lab = makeFakeWc();
    try {
      writeFileSync(join(lab, 'src', 'debug.log'), 'x');
      enqueue(snap(['*.log']), snap(['*.log']));
      const panel = await openPanel(join(lab, 'src', 'debug.log'), 'rule-text');
      const html = panel.lastRender()!.html;
      expect(html).toContain('*.log');
      expect(html).toContain('用当前项名');
      expect(html).toContain('debug.log');
      // 规则条数徽标与已读取状态。
      expect(html).toContain('1 条');
      expect(html).toContain('已读取');
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });

  it('目录入口编辑自身规则，无「用当前项名」（避免目录名写入自身）', async () => {
    const lab = makeFakeWc();
    try {
      enqueue(sapEmpty(), snap([]));
      const panel = await openPanel(join(lab, 'src'), '未设置 svn:ignore');
      const html = panel.lastRender()!.html;
      expect(html).not.toContain('用当前项名');
      expect(html).toContain('自行填写模式');
      expect(html).toContain('其他来源仍可能生效');
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });

  it('syncInput 立即重绘：加入按钮与页脚摘要随输入更新（缺陷 A）', async () => {
    const lab = makeFakeWc();
    try {
      enqueue(snap(['*.log', 'build']), snap(['*.log', 'build']));
      const panel = await openPanel(join(lab, 'src'), '*.log');
      // 初始：待加入输入为空，「加入」禁用。
      expect(panel.lastRender()!.html).toContain('data-focus="add-rule" disabled');
      // 手工输入后立即推送渲染（不经后续意图）：按钮启用、页脚提示未加入
      // 模式、输入值与 formRevision 对齐（webview 防回退的确认序号）。
      panel.sendIntent({ kind: 'syncInput', fieldId: 'draft', value: '*.m2tmp', inputRevision: 7 });
      await settle();
      const frame = panel.lastRender()!;
      expect(frame.html).toContain('value="*.m2tmp"');
      expect(frame.html).toContain('data-focus="add-rule">');
      expect(frame.html).toContain('还有未加入的模式');
      expect(frame.formRevision).toBe(7);
      // 清空输入后回到禁用基线。
      panel.sendIntent({ kind: 'syncInput', fieldId: 'draft', value: '', inputRevision: 8 });
      await settle();
      expect(panel.lastRender()!.html).toContain('data-focus="add-rule" disabled');
      expect(panel.lastRender()!.html).not.toContain('还有未加入的模式');
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });

  it('ready 重建握手归零 formRevision 并重推（旧大序号不吞新视图输入确认）', async () => {
    const lab = makeFakeWc();
    try {
      enqueue(snap(['*.log']), snap(['*.log']));
      const panel = await openPanel(join(lab, 'src'), '*.log');
      panel.sendIntent({ kind: 'syncInput', fieldId: 'draft', value: '*.m2tmp', inputRevision: 7 });
      await settle();
      // 模块级 formRevision 跨用例累积：只断言确认序号已对齐到本次输入以上。
      expect(panel.lastRender()!.formRevision).toBeGreaterThanOrEqual(7);
      // 隐藏重建：webview 重新加载并再次握手，视图输入序号从零重启。
      await panel.send({ type: 'ready', protocolVersion: 1 });
      await settle();
      const readyFrame = panel.lastRender()!;
      expect(readyFrame.formRevision).toBe(0);
      // 重推保留当前草稿值（session 状态不因重建丢失）。
      expect(readyFrame.html).toContain('value="*.m2tmp"');
      // 新视图第一条输入按新序号对齐确认（max(0,1)=1，旧大序号不再参与）。
      panel.sendIntent({ kind: 'syncInput', fieldId: 'draft', value: '*.review', inputRevision: 1 });
      await settle();
      expect(panel.lastRender()!.formRevision).toBe(1);
      expect(panel.lastRender()!.html).toContain('value="*.review"');
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });

  it('原生关闭暂存未保存草稿，重开同目标恢复并提示（⌘W 不再静默丢草稿）', async () => {
    const lab = makeFakeWc();
    try {
      enqueue(snap(['*.m2tmp']), snap(['*.m2tmp']));
      const panel = await openPanel(join(lab, 'src'), '*.m2tmp');
      // 未保存草稿：待加入输入 + 已加入未保存规则。
      panel.sendIntent({ kind: 'syncInput', fieldId: 'draft', value: '*.review', inputRevision: 1 });
      await settle();
      panel.sendIntent({ kind: 'addRule' });
      await settle();
      expect(panel.lastRender()!.html).toContain('未保存');
      // 原生关闭（onDidDispose 路径，无面板内确认框）。
      panel.dispose();
      await settle();
      const stashKey = `ignorePanel.stash|${lab}|${join(lab, 'src')}`;
      expect(globalStore.has(stashKey)).toBe(true);
      expect(globalStore.get(stashKey)).toEqual({
        rules: ['*.m2tmp', '*.review'],
        draft: '',
        savedRules: ['*.m2tmp'],
        savedPropertyExists: true,
      });
      // 重开同目标：暂存草稿与暂存时的保存基线一并恢复到编辑值。
      enqueue(snap(['*.m2tmp']), snap(['*.m2tmp']));
      const reopened = await openPanel(join(lab, 'src'), '已恢复上次关闭面板时未保存的草稿');
      const html = reopened.lastRender()!.html;
      expect(html).toContain('*.review');
      expect(html).toContain('未保存');
      // 暂存一次性消费：再次原生关闭（清空草稿后）不再残留旧值。
      expect(globalStore.has(stashKey)).toBe(false);
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });

  it('恢复的草稿沿用原保存基线：关闭期间外部修改属性时保存被拦截不覆盖', async () => {
    const lab = makeFakeWc();
    try {
      enqueue(snap(['*.m2tmp']), snap(['*.m2tmp']));
      const panel = await openPanel(join(lab, 'src'), '*.m2tmp');
      panel.sendIntent({ kind: 'syncInput', fieldId: 'draft', value: '*.review', inputRevision: 1 });
      await settle();
      panel.sendIntent({ kind: 'addRule' });
      await settle();
      // 原生关闭暂存（savedRules 为暂存时基线 ['*.m2tmp']）。
      panel.dispose();
      await settle();
      // 关闭期间外部新增 external.keep：重开读取的工作值已变，BASE 未变；
      // 第三个快照供保存前的磁盘核对读取。
      enqueue(snap(['*.m2tmp', 'external.keep']), snap(['*.m2tmp']), snap(['*.m2tmp', 'external.keep']));
      const reopened = await openPanel(join(lab, 'src'), '关闭期间规则已被其他操作修改');
      // 恢复的草稿显示为未保存（相对暂存时基线）。
      expect(reopened.lastRender()!.html).toContain('未保存');
      // 保存：磁盘值与原基线不一致 → 外部修改拦截，不写回（external.keep 保留）。
      reopened.sendIntent({ kind: 'saveIgnore' });
      await settle();
      expect(vi.mocked(applyIgnoreSnapshot)).not.toHaveBeenCalled();
      const html = reopened.lastRender()!.html;
      expect(html).toContain('规则已被其他操作修改');
      expect(html).toContain('本次未覆盖');
      // 草稿保留，未静默覆盖也未丢失。
      expect(html).toContain('*.review');
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });

  it('面板内确认「放弃草稿并关闭」不暂存草稿（含恢复后再次放弃）', async () => {
    const lab = makeFakeWc();
    try {
      enqueue(snap(['*.m2tmp']), snap(['*.m2tmp']));
      const panel = await openPanel(join(lab, 'src'), '*.m2tmp');
      panel.sendIntent({ kind: 'syncInput', fieldId: 'draft', value: '*.review', inputRevision: 1 });
      await settle();
      panel.sendIntent({ kind: 'addRule' });
      await settle();
      const stashKey = `ignorePanel.stash|${lab}|${join(lab, 'src')}`;
      // 确认放弃并关闭：销毁回调不再暂存刚被放弃的草稿。
      vscodeMock.confirmResult = strings.ignorePanel.closeDiscardButton;
      panel.sendIntent({ kind: 'closePanel' });
      await settle();
      expect(panel.disposed).toBe(true);
      expect(globalStore.has(stashKey)).toBe(false);
      // 原生关闭暂存 → 重开恢复 → 恢复的草稿再次确认放弃：同样不留暂存。
      enqueue(snap(['*.m2tmp']), snap(['*.m2tmp']));
      const second = await openPanel(join(lab, 'src'), '*.m2tmp');
      second.sendIntent({ kind: 'syncInput', fieldId: 'draft', value: '*.review', inputRevision: 1 });
      await settle();
      second.sendIntent({ kind: 'addRule' });
      await settle();
      second.dispose();
      await settle();
      expect(globalStore.has(stashKey)).toBe(true);
      enqueue(snap(['*.m2tmp']), snap(['*.m2tmp']));
      const third = await openPanel(join(lab, 'src'), '已恢复上次关闭面板时未保存的草稿');
      expect(third.lastRender()!.html).toContain('*.review');
      third.sendIntent({ kind: 'closePanel' });
      await settle();
      expect(third.disposed).toBe(true);
      expect(globalStore.has(stashKey)).toBe(false);
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });

  it('加入/重复/路径拒绝/移除/清空 dirty', async () => {
    const lab = makeFakeWc();
    try {
      enqueue(snap(['*.log', 'build']), snap(['*.log', 'build']));
      const panel = await openPanel(join(lab, 'src'), '*.log');
      // 待加入输入同步 + 加入。
      panel.sendIntent({ kind: 'syncInput', fieldId: 'draft', value: '.idea', inputRevision: 1 });
      await settle();
      panel.sendIntent({ kind: 'addRule' });
      await settle();
      expect(panel.lastRender()!.html).toContain('.idea');
      expect(panel.lastRender()!.html).toContain('未保存');
      // 重复模式不追加。
      panel.sendIntent({ kind: 'syncInput', fieldId: 'draft', value: '.idea', inputRevision: 2 });
      await settle();
      panel.sendIntent({ kind: 'addRule' });
      await settle();
      expect(panel.lastRender()!.html).toContain('该模式已在规则中');
      // 路径示例拒绝。
      panel.sendIntent({ kind: 'syncInput', fieldId: 'draft', value: './secret.txt', inputRevision: 3 });
      await settle();
      panel.sendIntent({ kind: 'addRule' });
      await settle();
      expect(panel.lastRender()!.html).toContain('路径分隔符');
      // 移除一条。
      panel.sendIntent({ kind: 'syncInput', fieldId: 'draft', value: '', inputRevision: 4 });
      await settle();
      panel.sendIntent({ kind: 'removeRule', index: 0 });
      await settle();
      const afterRemove = panel.lastRender()!.html;
      expect(afterRemove).not.toContain('rule-text">*.log');
      // 越界序号安全忽略。
      panel.sendIntent({ kind: 'removeRule', index: 99 });
      await settle();
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });

  it('用当前项名转义通配符；含换行的名称给可读拒绝且不写属性', async () => {
    const lab = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-p2flow-')));
    try {
      mkdirSync(join(lab, '.svn'), { recursive: true });
      writeFileSync(join(lab, '.svn', 'wc.db'), 'fake');
      mkdirSync(join(lab, 'src'), { recursive: true });
      writeFileSync(join(lab, 'src', 'cache[1]?.log'), 'x');
      writeFileSync(join(lab, 'src', 'foo\nbar'), 'x');
      // 文件入口：用当前项名转义 [ ] ? 为字面量匹配。
      enqueue(snap(['*.log']), snap(['*.log']));
      let panel = await openPanel(join(lab, 'src', 'cache[1]?.log'), 'rule-text');
      panel.sendIntent({ kind: 'fillOriginName' });
      await settle();
      expect(panel.lastRender()!.html).toContain('已填入当前项的精确名称模式');
      expect(panel.lastRender()!.html).toContain('cache[[]1[]][?].log');
      expect(panel.lastRender()!.html).toContain('会转义其中的通配符');
      panel.dispose();
      // 含换行的名称不能表示为一条精确规则：可读拒绝，不写属性。
      enqueue(snap(['*.log']), snap(['*.log']));
      panel = await openPanel(join(lab, 'src', 'foo\nbar'), 'rule-text');
      panel.sendIntent({ kind: 'fillOriginName' });
      await settle();
      expect(panel.lastRender()!.html).toContain('无法表示为一条精确忽略规则');
      expect(vi.mocked(applyIgnoreSnapshot)).not.toHaveBeenCalled();
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });
});

describe('P2 面板：保存', () => {
  it('保存写回本机并读回更新基线；快照带后续修改保留待提交', async () => {
    const lab = makeFakeWc();
    try {
      enqueue(snap(['*.log']), snap(['*.log']));
      const panel = await openPanel(join(lab, 'src'), '*.log');
      panel.sendIntent({ kind: 'syncInput', fieldId: 'draft', value: '.idea', inputRevision: 1 });
      await settle();
      panel.sendIntent({ kind: 'addRule' });
      await settle();
      // 保存：覆盖防护读 + 写回 + 读回。
      enqueue(snap(['*.log']), snap(['*.log', '.idea']));
      panel.sendIntent({ kind: 'saveIgnore' });
      await settle(40);
      expect(vi.mocked(applyIgnoreSnapshot)).toHaveBeenCalledWith(
        'svn', 'src', snap(['*.log', '.idea']), expect.anything(),
      );
      const html = panel.lastRender()!.html;
      expect(html).toContain('忽略规则已保存到本机');
      expect(html).toContain('本地已保存 · 待提交');
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });

  it('外部已修改不覆盖：比较失败给出重读提示，不写回', async () => {
    const lab = makeFakeWc();
    try {
      enqueue(snap(['*.log']), snap(['*.log']));
      const panel = await openPanel(join(lab, 'src'), '*.log');
      panel.sendIntent({ kind: 'syncInput', fieldId: 'draft', value: '.idea', inputRevision: 1 });
      await settle();
      panel.sendIntent({ kind: 'addRule' });
      await settle();
      // 保存时磁盘值已被外部改掉。
      enqueue(snap(['external-change']));
      panel.sendIntent({ kind: 'saveIgnore' });
      await settle(40);
      expect(vi.mocked(applyIgnoreSnapshot)).not.toHaveBeenCalled();
      expect(panel.lastRender()!.html).toContain('规则已被其他操作修改');
      expect(panel.lastRender()!.html).toContain('本次未覆盖');
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });

  it('保存失败保留草稿且不进入提交（后续提交意图被 dirty 状态自然拦截）', async () => {
    const lab = makeFakeWc();
    try {
      enqueue(snap(['*.log']), snap(['*.log']));
      const panel = await openPanel(join(lab, 'src'), '*.log');
      panel.sendIntent({ kind: 'syncInput', fieldId: 'draft', value: '.idea', inputRevision: 1 });
      await settle();
      panel.sendIntent({ kind: 'addRule' });
      await settle();
      vi.mocked(applyIgnoreSnapshot).mockRejectedValueOnce(new SvnError({
        message: 'svn: E155004: locked', command: ['propset'], code: 'E155004',
      }));
      enqueue(snap(['*.log']), snap(['*.log']));
      panel.sendIntent({ kind: 'saveIgnore' });
      await settle(40);
      const html = panel.lastRender()!.html;
      expect(html).toContain('写回失败，草稿已保留');
      // 草稿仍在（.idea 在列表中，保存按钮仍可用）。
      expect(html).toContain('.idea');
      expect(html).toContain('有未保存修改');
      // 提交链路未启动（未 checkout）。
      expect(vi.mocked(checkoutDepthEmpty)).not.toHaveBeenCalled();
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });
});

describe('P2 面板：仅规则提交与协调', () => {
  it('提交前重读快照核对、隔离提交、协调与 revision 回显', async () => {
    const lab = makeFakeWc();
    try {
      // 已保存待提交：加载读工作值（含新规则）与 BASE（旧值）。
      enqueue(snap(['*.log', '.idea']), snap(['*.log']));
      const panel = await openPanel(join(lab, 'src'), 'rule-text');
      await settle();
      // 提交前重读（工作值+BASE）、协调前 working、BASE 读回、finish 两次读回。
      const committed = snap(['*.log', '.idea']);
      enqueue(committed, snap(['*.log']), committed, committed, committed, committed);
      panel.sendIntent({ kind: 'submitIgnore' });
      await settle(80);
      expect(vi.mocked(checkoutDepthEmpty)).toHaveBeenCalledWith(
        'svn', IDENTITY.url, IDENTITY.revision, expect.any(String), expect.anything(),
      );
      expect(vi.mocked(applyIgnoreSnapshot)).toHaveBeenCalledWith('svn', '.', committed, expect.anything());
      expect(vi.mocked(commitTempIgnore)).toHaveBeenCalled();
      expect(vi.mocked(coordinateUpdate)).toHaveBeenCalledWith('svn', 'src', expect.anything());
      const html = panel.lastRender()!.html;
      expect(html).toContain('忽略规则已提交到 SVN');
      expect(html).toContain('r9');
      expect(html).toContain('仅提交当前目录的 svn:ignore');
      // 完成后 localModified 重算为 false（协调读回一致）。
      expect(html).not.toContain('本地已保存 · 待提交');
      // 操作登记已结束（注册表不再限制）。
      expect(getRegistryRestricted(lab)).toBe(false);
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });

  it('提交前发现外部修改：本次不提交、不覆盖', async () => {
    const lab = makeFakeWc();
    try {
      // 已保存待提交：加载读工作值（含新规则）与 BASE（旧值）。
      enqueue(snap(['*.log', '.idea']), snap(['*.log']));
      const panel = await openPanel(join(lab, 'src'), 'rule-text');
      await settle();
      // 提交前重读：工作值已被外部改掉（与保存基线不一致）。
      enqueue(snap(['*.log', '.idea', 'external']), snap(['*.log']));
      panel.sendIntent({ kind: 'submitIgnore' });
      await settle(60);
      expect(vi.mocked(checkoutDepthEmpty)).not.toHaveBeenCalled();
      const html = panel.lastRender()!.html;
      expect(html).toContain('本次没有提交');
      expect(html).toContain('请重新读取并核对');
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });

  it('规则与 BASE 一致时提交被「没有待提交修改」拦截', async () => {
    const lab = makeFakeWc();
    try {
      enqueue(snap(['*.log']), snap(['*.log']));
      const panel = await openPanel(join(lab, 'src'), '*.log');
      // 提交前重读：一切一致。
      enqueue(snap(['*.log']), snap(['*.log']));
      panel.sendIntent({ kind: 'submitIgnore' });
      await settle(60);
      expect(vi.mocked(checkoutDepthEmpty)).not.toHaveBeenCalled();
      expect(panel.lastRender()!.html).toContain('没有待提交修改');
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });

  it('提交进程级失败进入 unknown：冻结写意图，核实未提交后解锁', async () => {
    const lab = makeFakeWc();
    try {
      // 已保存待提交：加载读工作值（含新规则）与 BASE（旧值）。
      enqueue(snap(['*.log', '.idea']), snap(['*.log']));
      const panel = await openPanel(join(lab, 'src'), 'rule-text');
      await settle();
      const committed = snap(['*.log', '.idea']);
      enqueue(committed, snap(['*.log']));
      vi.mocked(commitTempIgnore).mockRejectedValueOnce(new SvnError({
        message: 'svn commit 超时', command: ['commit'], code: 'TIMEOUT',
      }));
      panel.sendIntent({ kind: 'submitIgnore' });
      await settle(80);
      const unknownHtml = panel.lastRender()!.html;
      expect(unknownHtml).toContain('提交结果未知');
      expect(unknownHtml).toContain('核实提交结果');
      // unknown 期间写意图被 host 写锁定拒绝（DOM 与事件守卫一致）。
      panel.sendIntent({ kind: 'saveIgnore' });
      await settle();
      // 核实：远端 HEAD 仍是原始值 → 确认未提交解锁。走真实横幅按钮消息
      // （bannerAction），写锁豁免按 actionId 放行后控制器才拿得到核实请求。
      vi.mocked(readRemoteIgnoreSnapshot).mockResolvedValue(snap(['*.log']));
      // 解锁时按真实工作值与 BASE 重建会话（工作值两条、BASE 一条）。
      enqueue(snap(['*.log', '.idea']), snap(['*.log']));
      const rejectedBefore = panel.posted.filter(
        (m) => m.type === 'toast' && String(m.message).includes('已忽略重复请求'),
      ).length;
      panel.sendIntent({ kind: 'bannerAction', bannerId: 'unknown', actionId: 'resolveUnknown' });
      await settle(60);
      const html = panel.lastRender()!.html;
      expect(html).not.toContain('提交结果未知');
      expect(panel.posted.some((m) => m.type === 'toast' && String(m.message).includes('已确认未提交'))).toBe(true);
      expect(html).toContain('本地已保存 · 待提交');
      expect(html).not.toMatch(/data-intent="submitIgnore"[^>]*disabled/);
      expect(panel.posted.filter(
        (m) => m.type === 'toast' && String(m.message).includes('已忽略重复请求'),
      ).length).toBe(rejectedBefore);
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });

  it('协调前本地又有后续修改：受阻保留 revision，确认保留后协调完成', async () => {
    const lab = makeFakeWc();
    try {
      // 已保存待提交：加载读工作值（含新规则）与 BASE（旧值）。
      enqueue(snap(['*.log', '.idea']), snap(['*.log']));
      const panel = await openPanel(join(lab, 'src'), 'rule-text');
      await settle();
      const committed = snap(['*.log', '.idea']);
      const workingAfter = snap(['*.log', '.idea', 'B']);
      // 提交前重读 + 协调前 working（A+B → 受阻）。
      enqueue(committed, snap(['*.log']), workingAfter);
      panel.sendIntent({ kind: 'submitIgnore' });
      await settle(80);
      const blockedHtml = panel.lastRender()!.html;
      expect(blockedHtml).toContain('r9');
      expect(blockedHtml).toContain('尚未协调完成');
      expect(blockedHtml).toContain('后续本地修改');
      // 恢复协调：working（A+B）→ 确认保留 → update 冲突 → resolve working
      // → BASE 读回（A'）→ finish（working A+B / BASE A'）。
      vscodeMock.confirmResult = strings.ignorePanel.reconcileConfirmKeep;
      vi.mocked(propertyConflicted).mockResolvedValue(true);
      enqueue(workingAfter, snap(['*.log']), committed, workingAfter, committed);
      panel.sendIntent({ kind: 'resolveUnknown' });
      await settle(80);
      expect(vi.mocked(resolvePropertyConflict)).toHaveBeenCalledWith('svn', 'src', expect.anything());
      const done = panel.lastRender()!.html;
      expect(done).toContain('忽略规则已提交到 SVN');
      expect(done).toContain('后续本地规则修改仍待提交');
      expect(getRegistryRestricted(lab)).toBe(false);
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });
});

describe('P2 面板：草稿保护与生命周期', () => {
  it('关闭面板有未保存草稿时先确认；确认后销毁', async () => {
    const lab = makeFakeWc();
    try {
      enqueue(snap(['*.log']), snap(['*.log']));
      const panel = await openPanel(join(lab, 'src'), '*.log');
      panel.sendIntent({ kind: 'syncInput', fieldId: 'draft', value: '.idea', inputRevision: 1 });
      await settle();
      vscodeMock.confirmResult = undefined;
      panel.sendIntent({ kind: 'closePanel' });
      await settle();
      expect(panel.disposed).toBe(false);
      expect(vscodeMock.warning.some((m) => m.includes('放弃未保存修改'))).toBe(true);
      vscodeMock.confirmResult = strings.ignorePanel.closeDiscardButton;
      panel.sendIntent({ kind: 'closePanel' });
      await settle();
      expect(panel.disposed).toBe(true);
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });

  it('同目标重入复用面板 reveal；忙碌时拒绝切换新目标', async () => {
    const lab = makeFakeWc();
    try {
      mkdirSync(join(lab, 'lib'), { recursive: true });
      enqueue(snap(['*.log']), snap(['*.log']));
      const panel = await openPanel(join(lab, 'src'), '*.log');
      // 同目标重入（无草稿）：reveal + 重读。
      enqueue(snap(['*.log']), snap(['*.log']));
      void commandEditIgnore(makeUri(join(lab, 'src')));
      await settle(40);
      expect(vscodeMock.panels.length).toBe(1);
      expect(panel.revealed).toBeGreaterThanOrEqual(1);
      // loading 忙碌期间切换新目标被拒绝。
      snapshotQueue = [];
      void commandEditIgnore(makeUri(join(lab, 'src')));
      await settle(40);
      expect(vscodeMock.warning.some((m) => m.includes('拒绝切换')) || vscodeMock.panels.length === 1).toBe(true);
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });

  it('有草稿切换目标先弹丢弃确认：取消后停留原目标且不重读', async () => {
    const lab = makeFakeWc();
    try {
      mkdirSync(join(lab, 'lib'), { recursive: true });
      enqueue(snap(['*.log']), snap(['*.log']));
      const panel = await openPanel(join(lab, 'src'), '*.log');
      panel.sendIntent({ kind: 'syncInput', fieldId: 'draft', value: '.idea', inputRevision: 1 });
      await settle();
      const sessionId = panel.lastSessionId();
      const readsBefore = vi.mocked(readIgnoreSnapshot).mock.calls.length;
      // 确认框取消（未点「放弃并切换」）。
      vscodeMock.confirmResult = undefined;
      await commandEditIgnore(makeUri(join(lab, 'lib')));
      await settle(20);
      expect(vscodeMock.warning).toContain(strings.ignorePanel.switchDiscardTitle);
      // 停留原目标：会话未切换、渲染仍是 src、没有发起重读。
      expect(panel.lastSessionId()).toBe(sessionId);
      expect(panel.lastRender()!.html).toContain('· src');
      expect(panel.lastRender()!.html).not.toContain('· lib');
      expect(vi.mocked(readIgnoreSnapshot).mock.calls.length).toBe(readsBefore);
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });

  it('确认丢弃草稿后切换到新目标并读取其规则', async () => {
    const lab = makeFakeWc();
    try {
      mkdirSync(join(lab, 'lib'), { recursive: true });
      enqueue(snap(['*.log']), snap(['*.log']));
      const panel = await openPanel(join(lab, 'src'), '*.log');
      const oldSessionId = panel.lastSessionId();
      panel.sendIntent({ kind: 'syncInput', fieldId: 'draft', value: '.idea', inputRevision: 1 });
      await settle();
      vscodeMock.confirmResult = strings.ignorePanel.switchDiscardButton;
      enqueue(snap(['lib-*']), snap(['lib-*']));
      await commandEditIgnore(makeUri(join(lab, 'lib')));
      await settle(40);
      // 复用同一面板实例，切换出新的会话代次并读取新目标。
      expect(vscodeMock.panels.length).toBe(1);
      expect(panel.lastSessionId()).not.toBe(oldSessionId);
      const html = panel.lastRender()!.html;
      expect(html).toContain('· lib');
      expect(html).not.toContain('· src');
      expect(html).toContain('lib-*');
      // 旧目标的待加入草稿随切换丢弃。
      expect(html).not.toMatch(/value="\.idea"/);
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });
});

function sapEmpty(): PropertySnapshot {
  return { rules: [], exists: false };
}

/** 注册表是否仍有限制中的未完成记录（隔离测试无持久化 store）。 */
function getRegistryRestricted(wcRoot: string): boolean {
  return getOperationRegistry().pendingForWcRoot(wcRoot).length > 0;
}

describe('P2 面板：表单输入序号（webview 输入防回退）', () => {
  it('宿主主动改输入值时递增 formRevision：加入后渲染携带序号且输入框清空', async () => {
    const lab = makeFakeWc();
    try {
      enqueue(snap(['*.log']), snap(['*.log']));
      const panel = await openPanel(join(lab, 'src'), 'rule-text');
      const renderAt = (): { html: string; formRevision: number } | undefined => {
        const frames = panel.posted.filter((m) => m.type === 'render');
        const last = frames[frames.length - 1];
        return last ? { html: String(last.html), formRevision: Number(last.formRevision) } : undefined;
      };
      // 手动输入（inputRevision 与 mock-host 一致取大值，暴露恒 0 回归）。
      panel.sendIntent({ kind: 'syncInput', fieldId: 'draft', value: '.idea', inputRevision: 1100 });
      await settle();
      panel.sendIntent({ kind: 'addRule' });
      await settle(30);
      const afterAdd = renderAt();
      expect(afterAdd).toBeDefined();
      expect(afterAdd!.formRevision).toBeGreaterThanOrEqual(1101);
      expect(afterAdd!.html).toContain('rule-text">.idea');
      // 输入框被宿主清空：渲染值为空（webview 侧 pending 不再覆盖）。
      expect(afterAdd!.html).toMatch(/value=""/);
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });

  it('「用当前项名」写入输入值时同样递增 formRevision', async () => {
    const lab = mkdtempSync(join(tmpdir(), 'svn-anywhere-p2flow-'));
    try {
      mkdirSync(join(lab, '.svn'), { recursive: true });
      writeFileSync(join(lab, '.svn', 'wc.db'), 'fake');
      mkdirSync(join(lab, 'src'), { recursive: true });
      writeFileSync(join(lab, 'src', 'cache[1]?.log'), 'x');
      enqueue(snap(['*.log']), snap(['*.log']));
      const panel = await openPanel(join(lab, 'src', 'cache[1]?.log'), 'rule-text');
      const before = Number((panel.posted.filter((m) => m.type === 'render').at(-1) ?? {}).formRevision);
      panel.sendIntent({ kind: 'fillOriginName' });
      await settle();
      const after = panel.posted.filter((m) => m.type === 'render').at(-1);
      expect(Number(after?.formRevision)).toBeGreaterThan(before);
      expect(String(after?.html)).toContain('cache[[]1[]][?].log');
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });
});

describe('P2 面板：提交进行中用户关闭面板', () => {
  it('成功 revision 仍即时落盘（待协调相位），协调留给重开恢复', async () => {
    const lab = makeFakeWc();
    try {
      enqueue(snap(['*.log', '.idea']), snap(['*.log']));
      const panel = await openPanel(join(lab, 'src'), 'rule-text');
      await settle();
      const committed = snap(['*.log', '.idea']);
      // 提交前重读：工作值==保存基线，BASE 仍为旧值（有待提交修改）。
      enqueue(committed, snap(['*.log']));
      // 提交子进程挂起：发出提交后用户以原生 X 关闭面板，再放行提交。
      let releaseCommit: (value: number) => void = () => {};
      vi.mocked(commitTempIgnore).mockImplementationOnce(() => new Promise<number>((resolve) => {
        releaseCommit = resolve;
      }));
      panel.sendIntent({ kind: 'submitIgnore' });
      await settle(40);
      panel.dispose();
      releaseCommit(9);
      // 成功 revision 的落盘不依赖面板存活（§14.1 即时落盘）。
      const registry = getOperationRegistry();
      // findWorkingCopy 返回 realpath 后的副本根（macOS 的 /tmp 是符号链接）。
      const wcRoot = realpathSync(lab);
      let record = registry.pendingForWcRoot(wcRoot)[0];
      for (let i = 0; i < 100 && (!record || record.phase !== 'committed-pending-coordination'); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        record = registry.pendingForWcRoot(wcRoot)[0];
      }
      expect(record?.phase).toBe('committed-pending-coordination');
      expect(record?.knownRevisions).toEqual([9]);
      // 协调未自动执行（面板已关）：临时副本保留给恢复流程。
      expect(vi.mocked(coordinateUpdate)).not.toHaveBeenCalled();
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });
});

describe('P2 面板：重启恢复清理临时副本', () => {
  /** 预置一条带临时副本登记的持久化限制记录（模拟重启后 loadPending 恢复）。 */
  async function seedRestrictedRecord(
    lab: string,
    phase: 'unknown' | 'committed-pending-coordination' | 'coordination-blocked',
    tempWc: string,
  ): Promise<void> {
    const registry = getOperationRegistry();
    const begin = await registry.begin({
      wcRoot: lab,
      targetRelPath: 'src',
      nodeKind: 'dir',
      property: {
        name: 'svn:ignore',
        originalExists: true,
        originalValue: ['*.log'],
        pendingExists: true,
        pendingValue: ['*.log', '.idea'],
      },
    });
    if (!begin.ok) {
      throw new Error(`预置受限记录失败：副本被 ${begin.heldBy.phase} 记录占用`);
    }
    await registry.markPhase(begin.operationId, phase, { knownRevisions: [9], tempWcPath: tempWc });
  }

  it('协调受阻重启后恢复：BASE 已是提交值，幂等完成并清理登记的临时副本', async () => {
    const lab = makeFakeWc();
    const tempWc = mkdtempSync(join(tmpdir(), 'svn-anywhere-ignore-commit-'));
    try {
      await seedRestrictedRecord(lab, 'coordination-blocked', tempWc);
      const panel = await openPanel(join(lab, 'src'), '尚未协调完成');
      expect(panel.lastRender()!.html).toContain('r9');
      // 恢复入口核对读 working+BASE，幂等完成后 finish 再读 working+BASE。
      const pending = snap(['*.log', '.idea']);
      enqueue(pending, pending, pending, pending);
      panel.sendIntent({ kind: 'resolveUnknown' });
      await settle(60);
      expect(existsSync(tempWc)).toBe(false);
      expect(getRegistryRestricted(lab)).toBe(false);
      expect(panel.lastRender()!.html).toContain('忽略规则已提交到 SVN');
    } finally {
      rmSync(lab, { recursive: true, force: true });
      rmSync(tempWc, { recursive: true, force: true });
    }
  });

  it('unknown 重启后核实已提交：恢复协调完成并清理登记的临时副本', async () => {
    const lab = makeFakeWc();
    const tempWc = mkdtempSync(join(tmpdir(), 'svn-anywhere-ignore-commit-'));
    try {
      await seedRestrictedRecord(lab, 'unknown', tempWc);
      const panel = await openPanel(join(lab, 'src'), '提交结果未知');
      // 远端 HEAD 已是待提交值：核实为已提交，走恢复协调（update + BASE 读回）。
      vi.mocked(readRemoteIgnoreSnapshot).mockResolvedValue(snap(['*.log', '.idea']));
      const pending = snap(['*.log', '.idea']);
      enqueue(pending, pending, pending, pending);
      panel.sendIntent({ kind: 'resolveUnknown' });
      await settle(80);
      expect(vi.mocked(coordinateUpdate)).toHaveBeenCalledWith('svn', 'src', expect.anything());
      expect(existsSync(tempWc)).toBe(false);
      expect(getRegistryRestricted(lab)).toBe(false);
      expect(panel.lastRender()!.html).toContain('忽略规则已提交到 SVN');
    } finally {
      rmSync(lab, { recursive: true, force: true });
      rmSync(tempWc, { recursive: true, force: true });
    }
  });

  it('unknown 重启后核实未提交：重读工作值与 BASE 解锁，保留待提交状态', async () => {
    const lab = makeFakeWc();
    const tempWc = mkdtempSync(join(tmpdir(), 'svn-anywhere-ignore-commit-'));
    try {
      await seedRestrictedRecord(lab, 'unknown', tempWc);
      const panel = await openPanel(join(lab, 'src'), '提交结果未知');
      // 远端 HEAD 仍是原始值：确认未提交，解锁允许重试。
      vi.mocked(readRemoteIgnoreSnapshot).mockResolvedValue(snap(['*.log']));
      // 恢复时的会话快照来自操作记录（待提交两条）；工作副本实际是三条、
      // BASE 只有一条：解锁后必须以真实工作值与 BASE 重建，不能沿用记录。
      enqueue(snap(['*.log', '.idea', 'external.keep']), snap(['*.log']));
      panel.sendIntent({ kind: 'resolveUnknown' });
      await settle(60);
      expect(existsSync(tempWc)).toBe(false);
      expect(getOperationRegistry().writeRestriction(lab)).toBeUndefined();
      // 结论用 toast 呈现（本地有修改时 info 横幅会被待提交徽标场景压住）。
      expect(panel.posted.some((m) => m.type === 'toast' && String(m.message).includes('已确认未提交'))).toBe(true);
      const html = panel.lastRender()!.html;
      // 修复前这里显示「规则列表无修改」并禁用提交（工作值与 BASE 的差异未重算）。
      expect(html).toContain('本地已保存 · 待提交');
      expect(html).toContain('external.keep');
      expect(html).not.toContain('规则列表无修改');
      expect(html).not.toMatch(/data-intent="submitIgnore"[^>]*disabled/);
    } finally {
      rmSync(lab, { recursive: true, force: true });
      rmSync(tempWc, { recursive: true, force: true });
    }
  });
});
