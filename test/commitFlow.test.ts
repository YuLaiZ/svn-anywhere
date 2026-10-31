/**
 * 提交闭环（F22–F30）的宿主侧链路测试：mock vscode（含 createWebviewPanel
 * 替身与 globalState）与 core svn 模块，从 P1 面板意图驱动完整提交流程：
 * 默认勾选（unversioned 默认不选）、说明输入与空说明开关、missing 的
 * svn delete --force、提交内添加（先 add 再 commit）、提交参数（临时文件
 * + UTF-8）、结果反馈与提交后刷新、行内差异。
 */
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { runStatus } from '../src/core/status';
import { runUpdate } from '../src/core/update';
import { runRemoteStatus } from '../src/core/remoteStatus';
import { runOrThrow } from '../src/core/svnCli';
import { SvnError } from '../src/core/errors';
import { resetPanelRegistry } from '../src/host/panel/host';
import { disposeOutputChannel, getOutputChannel, resetOutputState } from '../src/host/output';
import { setOperationRegistryForTest } from '../src/core/operations';
import { strings } from '../src/host/i18n';

vi.mock('../src/core/status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/status')>();
  return { ...actual, runStatus: vi.fn() };
});
vi.mock('../src/core/update', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/update')>();
  return { ...actual, runUpdate: vi.fn() };
});
vi.mock('../src/core/remoteStatus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/remoteStatus')>();
  return { ...actual, runRemoteStatus: vi.fn() };
});
vi.mock('../src/core/svnCli', () => ({
  run: vi.fn(),
  runOrThrow: vi.fn(),
  DEFAULT_TIMEOUT_MS: 120_000,
  killAllActive: vi.fn(),
}));

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
  sendIntent(intent: Record<string, unknown>, requestId: string, sessionIdOverride?: string): void;
  lastSessionId(): string;
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
    sendIntent(intent, requestId, sessionIdOverride) {
      seq += 1;
      return panel.send({
        type: 'intent',
        protocolVersion: 1,
        sessionId: sessionIdOverride ?? sessionId,
        requestId: requestId || `req-${seq}`,
        intent,
      }) as void;
    },
    lastSessionId() {
      return sessionId;
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
  errorMessages: [] as string[],
  /** 单按钮模态（确认）返回值；undefined 表示取消。 */
  confirmResult: undefined as string | undefined,
  /** 三按钮模态（提交前检查）返回值。 */
  commitChoice: undefined as string | undefined,
  /** QuickPick 选择（label）。 */
  quickPickChoice: undefined as string | undefined,
  /** InputBox 输入（前缀管理）。 */
  inputResult: undefined as string | undefined,
  config: {} as Record<string, unknown>,
  executedCommands: [] as unknown[][],
  globalState: new Map<string, unknown>(),
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
      return Promise.resolve(items.length >= 3 ? vscodeMock.commitChoice : vscodeMock.confirmResult);
    },
    showErrorMessage: (message: string) => {
      vscodeMock.errorMessages.push(message);
      return Promise.resolve(undefined);
    },
    showOpenDialog: () => Promise.resolve(undefined),
    showInputBox: () => Promise.resolve(vscodeMock.inputResult),
    showQuickPick: async (items: Array<{ label: string }>) => {
      const picked = items.find((item) => item.label === vscodeMock.quickPickChoice);
      return Promise.resolve(picked ?? undefined);
    },
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
    executeCommand: async (command: string, ...args: unknown[]) => {
      vscodeMock.executedCommands.push([command, ...args]);
      return undefined;
    },
  },
  ProgressLocation: { Notification: 15 },
}));

import { commandCommit } from '../src/host/commands/commit';
import { setCommitPanelContext } from '../src/host/panel/panels/commit';

const makeUri = (fsPath: string): vscode.Uri => ({ fsPath, scheme: 'file' }) as unknown as vscode.Uri;

const channelLines = (): string[] => {
  const channel = getOutputChannel();
  if (!channel) {
    throw new Error('输出频道不存在');
  }
  return (channel as unknown as { lines: string[] }).lines;
};

vi.mocked(runRemoteStatus).mockResolvedValue({ against: 1, entries: [] });
vi.mocked(runUpdate).mockResolvedValue({
  stdout: '', stderr: '', exitCode: 0, items: [], conflicts: [],
});
vi.mocked(runOrThrow).mockResolvedValue({
  stdout: 'Sending        a.txt\nCommitted revision 5.\n', stderr: '', exitCode: 0,
});

let wcRoot = '';

function lastPanel(): FakePanel {
  const panel = vscodeMock.panels.at(-1);
  if (!panel) {
    throw new Error('面板未创建');
  }
  return panel;
}

/** 打开面板并等待数据帧（含条目路径）就绪。 */
async function openPanelAndWait(uriPath: string, expectPath: string): Promise<FakePanel> {
  await commandCommit(makeUri(uriPath));
  const panel = lastPanel();
  await vi.waitFor(() => {
    const dataRender = [...panel.posted].reverse().find((m) => m.type === 'render' && String(m.html ?? '').includes(expectPath));
    expect(dataRender).toBeDefined();
  });
  return panel;
}

function commitCalls() {
  return vi.mocked(runOrThrow).mock.calls.filter(([, args]) => args[0] === 'commit');
}

beforeEach(() => {
  disposeOutputChannel();
  resetOutputState();
  resetPanelRegistry();
  setOperationRegistryForTest(undefined);
  vscodeMock.panels.length = 0;
  vscodeMock.information.length = 0;
  vscodeMock.warning.length = 0;
  vscodeMock.errorMessages.length = 0;
  vscodeMock.confirmResult = undefined;
  vscodeMock.commitChoice = undefined;
  vscodeMock.quickPickChoice = undefined;
  vscodeMock.inputResult = undefined;
  vscodeMock.config = {};
  vscodeMock.executedCommands.length = 0;
  vscodeMock.globalState.clear();
  vscodeMock.outputChannels.length = 0;
  vi.mocked(runOrThrow).mockClear();
  vi.mocked(runStatus).mockReset();
  vi.mocked(runRemoteStatus).mockClear();
  setCommitPanelContext({
    extensionUri: { scheme: 'file', path: '/ext', fsPath: '/ext', toString: () => 'file:///ext' } as never,
    subscriptions: [],
    globalState: {
      get: <T>(key: string, defaultValue?: T) => (vscodeMock.globalState.has(key) ? vscodeMock.globalState.get(key) as T : defaultValue as T),
      update: async (key: string, value: unknown) => { vscodeMock.globalState.set(key, value); },
    } as never,
  });
  wcRoot = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-commitflow-')));
  mkdirSync(join(wcRoot, '.svn'), { recursive: true });
  writeFileSync(join(wcRoot, '.svn', 'wc.db'), 'fake');
  writeFileSync(join(wcRoot, 'a.txt'), 'x');
  vi.mocked(runStatus).mockResolvedValue({
    targetPath: '.',
    entries: [{ path: 'a.txt', wcStatus: 'modified', props: 'none', changelist: null }],
    externals: [],
  });
});

afterEach(() => {
  rmSync(wcRoot, { recursive: true, force: true });
  resetPanelRegistry();
});

describe('P1 提交面板 提交闭环', () => {
  it('普通提交：默认勾选本地项，参数含临时文件与 UTF-8，反馈新 revision，提交后刷新状态', async () => {
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'a.txt');
    const render = [...panel.posted].reverse().find((m) => m.type === 'render' && String(m.html ?? '').includes('a.txt'));
    // 默认勾选本地可提交项。
    expect(String(render?.html)).toMatch(/data-row-id="a\.txt"[^>]*checked/);

    panel.sendIntent({ kind: 'syncInput', fieldId: 'message', value: '提交说明', inputRevision: 1 }, 'input-1');
    panel.sendIntent({ kind: 'submit' }, 'submit-1');
    await vi.waitFor(() => expect(commitCalls().length).toBeGreaterThan(0));

    const args = commitCalls()[0]?.[1] ?? [];
    expect(args.slice(0, 6)).toEqual(['commit', '--non-interactive', '--file', expect.stringMatching(/message\.txt$/), '--encoding', 'UTF-8']);
    expect(args).toContain('a.txt');

    // 提交成功提示 + 提交后刷新（F30）。
    await vi.waitFor(() => expect(vscodeMock.information.some((m) => m.includes('提交成功'))).toBe(true));
    expect(vi.mocked(runStatus).mock.calls.length).toBeGreaterThanOrEqual(2);
    const output = channelLines().join('\n');
    expect(output).toContain('Committed revision 5.');
    expect(output).toContain('提交后状态：');
    // 成功卡片与 revision 回显。
    const successRender = [...panel.posted].reverse().find((m) => m.type === 'render' && String(m.html ?? '').includes('success-card'));
    expect(successRender).toBeDefined();
    expect(String(successRender?.html)).toContain('r5');
  });

  it('嵌套目录的 status 路径相对副本根，missing 与提交不重复拼接目标', async () => {
    mkdirSync(join(wcRoot, 'src'), { recursive: true });
    vi.mocked(runStatus).mockResolvedValue({
      targetPath: 'src',
      entries: [
        { path: 'src/item.txt', wcStatus: 'modified', props: 'none', changelist: null },
        { path: 'src/drop.txt', wcStatus: 'missing', props: 'none', changelist: null },
      ],
      externals: [],
    });
    const panel = await openPanelAndWait(join(wcRoot, 'src'), 'src/item.txt');
    vscodeMock.confirmResult = strings.commit.continueButton;
    panel.sendIntent({ kind: 'syncInput', fieldId: 'message', value: '提交', inputRevision: 1 }, 'in-1');
    panel.sendIntent({ kind: 'submit' }, 'sub-1');
    await vi.waitFor(() => expect(commitCalls().length).toBeGreaterThan(0));
    expect(vi.mocked(runOrThrow).mock.calls.find(([, args]) => args[0] === 'delete')?.[1]).toEqual(['delete', '--force', '--', 'src/drop.txt']);
    expect((commitCalls()[0]?.[1] ?? []).slice(6)).toEqual(expect.arrayContaining(['src/item.txt', 'src/drop.txt']));
  });

  it('unversioned 默认不勾选；勾选后提交先 add 再 commit，取消确认不 add', async () => {
    vi.mocked(runStatus).mockResolvedValue({
      targetPath: '.',
      entries: [
        { path: 'a.txt', wcStatus: 'modified', props: 'none', changelist: null },
        { path: 'new.txt', wcStatus: 'unversioned', props: 'none', changelist: null },
      ],
      externals: [],
    });
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'new.txt');
    const html = String([...panel.posted].reverse().find((m) => m.type === 'render' && String(m.html ?? '').includes('new.txt'))?.html);
    // 未版本控制默认不选，行可勾选（不带 disabled）。
    expect(html).toMatch(/data-row-id="new\.txt"(?![^>]*checked)[^>]*>/);

    // 勾选未版本控制项 → 待添加徽标。
    panel.sendIntent({ kind: 'toggleRow', rowId: 'new.txt', selected: true }, 't-1');
    await vi.waitFor(() => {
      const withBadge = [...panel.posted].reverse().find((m) => m.type === 'render' && String(m.html ?? '').includes('待添加'));
      expect(withBadge).toBeDefined();
    });

    // 提交确认取消：不 add。
    vscodeMock.confirmResult = undefined;
    panel.sendIntent({ kind: 'syncInput', fieldId: 'message', value: '加新文件', inputRevision: 1 }, 'in-1');
    panel.sendIntent({ kind: 'submit' }, 'sub-1');
    await vi.waitFor(() => expect(vscodeMock.warning.length).toBeGreaterThan(0));
    expect(vi.mocked(runOrThrow).mock.calls.some(([, args]) => args[0] === 'add')).toBe(false);
    expect(commitCalls().length).toBe(0);

    // 确认：先 add（--depth empty，不隐式递归）再 commit。
    vscodeMock.confirmResult = strings.commit.continueButton;
    panel.sendIntent({ kind: 'submit' }, 'sub-2');
    await vi.waitFor(() => expect(commitCalls().length).toBeGreaterThan(0));
    expect(vi.mocked(runOrThrow).mock.calls.find(([, args]) => args[0] === 'add')?.[1]).toEqual(['add', '--depth', 'empty', '--', 'new.txt']);
    expect((commitCalls()[0]?.[1] ?? []).slice(6)).toEqual(expect.arrayContaining(['new.txt']));
  });

  it('添加失败不继续提交，已添加项保留 A 状态并解释', async () => {
    vi.mocked(runStatus).mockResolvedValue({
      targetPath: '.',
      entries: [
        { path: 'a.txt', wcStatus: 'modified', props: 'none', changelist: null },
        { path: 'bad.txt', wcStatus: 'unversioned', props: 'none', changelist: null },
      ],
      externals: [],
    });
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'bad.txt');
    panel.sendIntent({ kind: 'toggleRow', rowId: 'bad.txt', selected: true }, 't-1');
    panel.sendIntent({ kind: 'syncInput', fieldId: 'message', value: '尝试添加', inputRevision: 1 }, 'in-1');
    vscodeMock.confirmResult = strings.commit.continueButton;
    vi.mocked(runOrThrow).mockImplementation(async (_svn, args) => {
      if (args[0] === 'add') {
        throw new SvnError({ message: 'svn: E200009: 不能添加', command: args, code: 'E200009' });
      }
      return { stdout: 'Committed revision 5.\n', stderr: '', exitCode: 0 };
    });
    panel.sendIntent({ kind: 'submit' }, 'sub-1');
    await vi.waitFor(() => {
      const failed = [...panel.posted].reverse().find((m) => m.type === 'render' && String(m.html ?? '').includes('添加失败'));
      expect(failed).toBeDefined();
    });
    expect(commitCalls().length).toBe(0);
  });

  it('多行说明：syncInput 同步后换行原样进入 --file 临时文件（F91）', async () => {
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'a.txt');
    let messageFile = '';
    vi.mocked(runOrThrow).mockImplementation(async (_svn, args) => {
      if (args[0] === 'commit') {
        const idx = args.indexOf('--file');
        messageFile = readFileSync(args[idx + 1] as string, 'utf8');
      }
      return { stdout: 'Committed revision 7.\n', stderr: '', exitCode: 0 };
    });
    panel.sendIntent({ kind: 'syncInput', fieldId: 'message', value: '第一行\n第二行', inputRevision: 1 }, 'in-1');
    panel.sendIntent({ kind: 'submit' }, 'sub-1');
    await vi.waitFor(() => expect(commitCalls().length).toBeGreaterThan(0));
    expect(messageFile).toBe('第一行\n第二行');
  });

  it('空说明且开关开启：二次确认后提交；历史在成功后按工作副本保存', async () => {
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'a.txt');
    vscodeMock.confirmResult = strings.commit.continueButton;
    panel.sendIntent({ kind: 'submit' }, 'sub-1');
    await vi.waitFor(() => expect(commitCalls().length).toBeGreaterThan(0));
    expect(vscodeMock.warning).toContainEqual(strings.commit.emptyMessageConfirm);

    // 成功提交非空说明 → 历史写入 globalState（按工作副本隔离）。
    // 已提交项从选择移除（mock status 仍返回 modified），重新勾选后再次提交。
    panel.sendIntent({ kind: 'toggleRow', rowId: 'a.txt', selected: true }, 't-re');
    const commitsBeforeSecond = commitCalls().length;
    panel.sendIntent({ kind: 'syncInput', fieldId: 'message', value: '留下历史', inputRevision: 2 }, 'in-2');
    panel.sendIntent({ kind: 'submit' }, 'sub-2');
    await vi.waitFor(() => {
      expect(commitCalls().length).toBeGreaterThan(commitsBeforeSecond);
      const history = vscodeMock.globalState.get('svnAnywhere.commitHistory') as Record<string, string[]> | undefined;
      expect(history?.[wcRoot]?.[0]).toBe('留下历史');
    });
  });

  it('空说明且开关关闭：提交按钮禁用并提示', async () => {
    vscodeMock.config = { allowEmptyCommitMessage: false };
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'a.txt');
    const html = String([...panel.posted].reverse().find((m) => m.type === 'render' && String(m.html ?? '').includes('a.txt'))?.html);
    expect(html).toMatch(/data-intent="submit"[^>]*disabled/);
    panel.sendIntent({ kind: 'submit' }, 'sub-1');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(commitCalls().length).toBe(0);
  });

  it('missing 处理取消：不登记删除不提交', async () => {
    vi.mocked(runStatus).mockResolvedValue({
      targetPath: '.',
      entries: [{ path: 'gone.txt', wcStatus: 'missing', props: 'none', changelist: null }],
      externals: [],
    });
    const panel = await openPanelAndWait(wcRoot, 'gone.txt');
    vscodeMock.confirmResult = undefined;
    panel.sendIntent({ kind: 'syncInput', fieldId: 'message', value: '删除', inputRevision: 1 }, 'in-1');
    panel.sendIntent({ kind: 'submit' }, 'sub-1');
    await vi.waitFor(() => expect(vscodeMock.warning.length).toBeGreaterThan(0));
    expect(vi.mocked(runOrThrow).mock.calls.some(([, args]) => args[0] === 'delete')).toBe(false);
    expect(commitCalls().length).toBe(0);
  });

  it('纯属性变更：面板展示属性修改徽标并作为提交目标', async () => {
    vi.mocked(runStatus).mockResolvedValue({
      targetPath: '.',
      entries: [{ path: '.', wcStatus: 'normal', props: 'modified', changelist: null }],
      externals: [],
    });
    const panel = await openPanelAndWait(wcRoot, '工作副本根');
    const html = String([...panel.posted].reverse().find((m) => m.type === 'render' && String(m.html ?? '').includes('工作副本根'))?.html);
    expect(html).toContain(strings.commit.propModified);
    panel.sendIntent({ kind: 'syncInput', fieldId: 'message', value: '属性', inputRevision: 1 }, 'in-1');
    panel.sendIntent({ kind: 'submit' }, 'sub-1');
    await vi.waitFor(() => expect(commitCalls().length).toBeGreaterThan(0));
    expect((commitCalls()[0]?.[1] ?? []).slice(6)).toContain('.');
  });

  it('提交失败：错误进 banner，说明与勾选保留', async () => {
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'a.txt');
    vi.mocked(runOrThrow).mockRejectedValueOnce(
      new SvnError({ message: 'svn: E170001: 认证失败', command: ['commit'], code: 'E170001' }),
    );
    panel.sendIntent({ kind: 'syncInput', fieldId: 'message', value: '会失败', inputRevision: 1 }, 'in-1');
    panel.sendIntent({ kind: 'submit' }, 'sub-1');
    await vi.waitFor(() => {
      const failed = [...panel.posted].reverse().find((m) => m.type === 'render' && String(m.html ?? '').includes('提交失败'));
      expect(failed).toBeDefined();
    });
    expect(vscodeMock.errorMessages.some((m) => m.includes('E170001'))).toBe(true);
  });

  it('行内差异：openDiff 意图走 BASE 读取并打开 vscode.diff', async () => {
    vi.mocked(runOrThrow).mockImplementation(async (_svn, args) => {
      if (args[0] === 'cat') {
        return { stdout: 'base content\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'a.txt');
    panel.sendIntent({ kind: 'openDiff', itemId: 'a.txt' }, 'diff-1');
    await vi.waitFor(() => {
      expect(vscodeMock.executedCommands.some(([command]) => command === 'vscode.diff')).toBe(true);
    });
  });

  it('行内还原：rowMore → 还原 → 范围确认后 svn revert 并刷新', async () => {
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'a.txt');
    vscodeMock.quickPickChoice = strings.panel.actRevert;
    vscodeMock.confirmResult = strings.commit.continueButton;
    panel.sendIntent({ kind: 'rowMore', itemId: 'a.txt' }, 'more-1');
    await vi.waitFor(() => {
      expect(vi.mocked(runOrThrow).mock.calls.some(([, args]) => args[0] === 'revert')).toBe(true);
    });
    const revertCall = vi.mocked(runOrThrow).mock.calls.find(([, args]) => args[0] === 'revert');
    expect(revertCall?.[1]).toEqual(['revert', '--', 'a.txt']);
  });

  it('行内操作中途切换目标：迟到重读被守卫放弃，不写入新会话（目标隔离）', async () => {
    // 行内操作进行中面板不置 busy、可被切换目标：操作开始时捕获会话与
    // 目标，完成后核对；已切换则放弃重读，避免旧目标数据覆盖新目标。
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'a.txt');
    let releaseRevert!: (value: { stdout: string; stderr: string; exitCode: number }) => void;
    vi.mocked(runOrThrow).mockImplementationOnce(
      () => new Promise((resolve) => { releaseRevert = resolve; }),
    );
    vscodeMock.quickPickChoice = strings.panel.actRevert;
    vscodeMock.confirmResult = strings.commit.continueButton;
    panel.sendIntent({ kind: 'rowMore', itemId: 'a.txt' }, 'more-race');
    await vi.waitFor(() => {
      expect(vi.mocked(runOrThrow).mock.calls.some(([, args]) => args[0] === 'revert')).toBe(true);
    });

    // 操作挂起期间切换到新目标（同副本不同子目录）。
    mkdirSync(join(wcRoot, 'sub-dir'));
    vi.mocked(runStatus).mockImplementation(async (_svn, target) =>
      String(target).includes('sub-dir')
        ? { targetPath: 'sub-dir', entries: [{ path: 'sub.txt', wcStatus: 'modified', props: 'none', changelist: null }], externals: [] }
        : { targetPath: '.', entries: [{ path: 'a.txt', wcStatus: 'modified', props: 'none', changelist: null }], externals: [] },
    );
    await commandCommit(makeUri(join(wcRoot, 'sub-dir')));
    await vi.waitFor(() => {
      const subRender = [...panel.posted].reverse().find((m) => m.type === 'render' && String(m.html ?? '').includes('sub.txt'));
      expect(subRender).toBeDefined();
    });
    const postedAfterSwitch = panel.posted.length;
    const statusCallsAfterSwitch = vi.mocked(runStatus).mock.calls.length;

    // 释放挂起的 revert：会话已切换，迟到重读必须被放弃。
    releaseRevert({ stdout: '', stderr: '', exitCode: 0 });
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(vi.mocked(runStatus).mock.calls.length).toBe(statusCallsAfterSwitch);
    const lateRenders = panel.posted.slice(postedAfterSwitch).filter((m) => m.type === 'render');
    expect(lateRenders.some((m) => String(m.html ?? '').includes('data-row-id="a.txt"'))).toBe(false);
  });

  it('关闭面板：草稿有变化时先确认，取消不关闭', async () => {
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'a.txt');
    panel.sendIntent({ kind: 'syncInput', fieldId: 'message', value: '草稿', inputRevision: 1 }, 'in-1');
    vscodeMock.confirmResult = undefined;
    panel.sendIntent({ kind: 'closePanel' }, 'close-1');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(panel.disposed).toBe(false);
    vscodeMock.confirmResult = strings.commit.continueButton;
    panel.sendIntent({ kind: 'closePanel' }, 'close-2');
    await vi.waitFor(() => expect(panel.disposed).toBe(true));
  });
});

describe('P1 提交面板 结果未知与核实', () => {
  it('进程级失败进入 unknown：写意图冻结，核实后解锁', async () => {
    vi.mocked(runStatus).mockResolvedValue({
      targetPath: '.',
      entries: [{ path: 'a.txt', wcStatus: 'modified', props: 'none', changelist: null }],
      externals: [],
    });
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'a.txt');
    // 提交超时（进程级失败，无法证明服务端未接受）。
    vi.mocked(runOrThrow).mockImplementation(async (_svn, args) => {
      if (args[0] === 'commit') {
        throw new SvnError({ message: 'svn commit 超时', command: args, code: 'TIMEOUT' });
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    panel.sendIntent({ kind: 'syncInput', fieldId: 'message', value: '会超时', inputRevision: 1 }, 'in-u1');
    panel.sendIntent({ kind: 'submit' }, 'sub-u1');
    await vi.waitFor(() => {
      const unknownRender = [...panel.posted].reverse().find((m) => m.type === 'render' && String(m.html ?? '').includes('提交结果未知'));
      expect(unknownRender).toBeDefined();
    });
    // unknown 期间全部写控件禁用（含目录聚合/折叠与提交）。
    const locked = String([...panel.posted].reverse().find((m) => m.type === 'render')?.html);
    expect(locked).toMatch(/data-intent="submit"[^>]*disabled/);
    // 写意图（勾选/筛选）被拒：reducer/host 双防线。
    panel.sendIntent({ kind: 'toggleRow', rowId: 'a.txt', selected: false }, 't-u1');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterToggle = String([...panel.posted].reverse().find((m) => m.type === 'render')?.html);
    expect(afterToggle).toMatch(/data-row-id="a\.txt"[^>]*checked/);

    // 核实：本地仍有修改 + 远端 HEAD 未前进 → 判定未提交，解锁允许重试。
    panel.sendIntent({ kind: 'resolveUnknown' }, 'verify-u1');
    await vi.waitFor(() => {
      const toast = [...panel.posted].reverse().find((m) => m.type === 'toast' && String(m.message ?? '').includes('已核实未提交'));
      expect(toast).toBeDefined();
    });
    // 解锁后提交按钮恢复可用（仍有选择）。
    const resumed = String([...panel.posted].reverse().find((m) => m.type === 'render' && String(m.html ?? '').includes('a.txt'))?.html);
    expect(resumed).not.toMatch(/data-intent="submit"[^>]*disabled/);
  });

  it('核实本地已干净 → 确认已提交并展示成功卡片，不重复提交', async () => {
    vi.mocked(runStatus).mockResolvedValue({
      targetPath: '.',
      entries: [{ path: 'a.txt', wcStatus: 'modified', props: 'none', changelist: null }],
      externals: [],
    });
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'a.txt');
    vi.mocked(runOrThrow).mockImplementation(async (_svn, args) => {
      if (args[0] === 'commit') {
        throw new SvnError({ message: 'svn commit 超时', command: args, code: 'TIMEOUT' });
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    panel.sendIntent({ kind: 'syncInput', fieldId: 'message', value: '超时后核实', inputRevision: 1 }, 'in-u2');
    panel.sendIntent({ kind: 'submit' }, 'sub-u2');
    await vi.waitFor(() => {
      expect([...panel.posted].reverse().some((m) => m.type === 'render' && String(m.html ?? '').includes('提交结果未知'))).toBe(true);
    });
    // 核实时本地已干净（提交实际成功）。
    vi.mocked(runStatus).mockResolvedValue({ targetPath: '.', entries: [] , externals: [] });
    panel.sendIntent({ kind: 'resolveUnknown' }, 'verify-u2');
    await vi.waitFor(() => {
      const toast = [...panel.posted].reverse().find((m) => m.type === 'toast' && String(m.message ?? '').includes('已核实提交成功'));
      expect(toast).toBeDefined();
    });
    const commitCallsForUnknown = vi.mocked(runOrThrow).mock.calls.filter(([, args]) => args[0] === 'commit');
    expect(commitCallsForUnknown.length).toBe(1);
  });
});

describe('P1 提交面板 部分成功与刷新失败', () => {
  it('拆批部分成功：记录每批 revision，重试不被自身记录阻塞', async () => {
    // 120 项拆两批：第一批成功、第二批失败 → 部分成功，操作登记释放。
    const entries = Array.from({ length: 120 }, (_, i) => ({
      path: `f${String(i).padStart(3, '0')}.txt`,
      wcStatus: 'modified',
      props: 'none',
      changelist: null,
    }));
    vi.mocked(runStatus).mockResolvedValue({ targetPath: '.', entries, externals: [] });
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'f119.txt');
    let commitCount = 0;
    vi.mocked(runOrThrow).mockImplementation(async (_svn, args) => {
      if (args[0] === 'commit') {
        commitCount += 1;
        if (commitCount === 1) {
          return { stdout: 'Committed revision 11.', stderr: '', exitCode: 0 };
        }
        throw new SvnError({ message: 'svn: E160028: pre-commit hook failed', command: args, code: 'E160028' });
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    panel.sendIntent({ kind: 'syncInput', fieldId: 'message', value: '拆批', inputRevision: 1 }, 'in-p1');
    panel.sendIntent({ kind: 'submit' }, 'sub-p1');
    await vi.waitFor(() => {
      const partialRender = [...panel.posted].reverse().find(
        (m) => m.type === 'render' && String(m.html ?? '').includes('部分成功'),
      );
      expect(partialRender).toBeDefined();
    });
    // 部分成功横幅含第一批 revision。
    const partialHtml = String([...panel.posted].reverse().find((m) => m.type === 'render')?.html);
    expect(partialHtml).toContain('r11');

    // 重试不被自身操作记录阻塞：修复失败注入后再次提交成功（第二批走通）。
    vi.mocked(runOrThrow).mockImplementation(async (_svn, args) => {
      if (args[0] === 'commit') {
        return { stdout: 'Committed revision 12.', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const commitsBeforeRetry = commitCalls().length;
    panel.sendIntent({ kind: 'submit' }, 'sub-p2');
    await vi.waitFor(() => {
      expect(commitCalls().length).toBeGreaterThan(commitsBeforeRetry);
    });
    await vi.waitFor(() => {
      const ok = [...panel.posted].reverse().find((m) => m.type === 'render' && String(m.html ?? '').includes('success-card'));
      expect(ok).toBeDefined();
    });
  });

  it('提交成功后刷新失败：进入 stale，明确已提交并要求重读，不盲目重提', async () => {
    vi.mocked(runStatus).mockResolvedValue({
      targetPath: '.',
      entries: [{ path: 'a.txt', wcStatus: 'modified', props: 'none', changelist: null }],
      externals: [],
    });
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'a.txt');
    let statusCalls = 0;
    vi.mocked(runStatus).mockImplementation(async () => {
      statusCalls += 1;
      // 提交前重读（第 1 次）成功；提交后刷新（第 2 次）失败 → stale。
      if (statusCalls <= 1) {
        return { targetPath: '.', entries: [{ path: 'a.txt', wcStatus: 'modified', props: 'none', changelist: null }] , externals: [] };
      }
      throw new SvnError({ message: 'svn: E155004: 工作副本已锁定', command: ['status'], code: 'E155004' });
    });
    panel.sendIntent({ kind: 'syncInput', fieldId: 'message', value: '会 stale', inputRevision: 1 }, 'in-s1');
    panel.sendIntent({ kind: 'submit' }, 'sub-s1');
    await vi.waitFor(() => {
      const staleRender = [...panel.posted].reverse().find(
        (m) => m.type === 'render' && String(m.html ?? '').includes('提交成功，刷新失败'),
      );
      expect(staleRender).toBeDefined();
    });
    // stale 期间提交按钮禁用（重读后才能再次提交）。
    const staleHtml = String([...panel.posted].reverse().find((m) => m.type === 'render')?.html);
    expect(staleHtml.match(/data-intent="submit"[^>]*>/)?.[0] ?? 'missing').toMatch(/disabled/);
    expect(vscodeMock.information.some((m) => m.includes('提交成功'))).toBe(true);
  });

  it('第二批结果未知：第一批 revision 已记录，进入 unknown 冻结写意图', async () => {
    const entries = Array.from({ length: 120 }, (_, i) => ({
      path: `f${String(i).padStart(3, '0')}.txt`,
      wcStatus: 'modified',
      props: 'none',
      changelist: null,
    }));
    vi.mocked(runStatus).mockResolvedValue({ targetPath: '.', entries, externals: [] });
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'f119.txt');
    let commitCount = 0;
    vi.mocked(runOrThrow).mockImplementation(async (_svn, args) => {
      if (args[0] === 'commit') {
        commitCount += 1;
        if (commitCount === 1) {
          return { stdout: 'Committed revision 21.', stderr: '', exitCode: 0 };
        }
        throw new SvnError({ message: 'svn commit 超时', command: args, code: 'TIMEOUT' });
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    panel.sendIntent({ kind: 'syncInput', fieldId: 'message', value: '第二批超时', inputRevision: 1 }, 'in-u3');
    panel.sendIntent({ kind: 'submit' }, 'sub-u3');
    await vi.waitFor(() => {
      const unknownRender = [...panel.posted].reverse().find(
        (m) => m.type === 'render' && String(m.html ?? '').includes('提交结果未知'),
      );
      expect(unknownRender).toBeDefined();
    });
    // 第一批已成功的 revision 在结果中可见（partial + unknown 并存）。
    const unknownHtml = String([...panel.posted].reverse().find((m) => m.type === 'render')?.html);
    expect(unknownHtml).toContain('r21');
    expect(unknownHtml).toMatch(/data-intent="submit"[^>]*disabled/);
  });
});
