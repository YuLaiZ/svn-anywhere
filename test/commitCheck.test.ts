/**
 * 提交前检查（F145/F81）的宿主侧链路测试：mock vscode（面板替身）与 core
 * svn 模块，从 P1 面板驱动：远端分组仅检查开启时出现、提交前三选模态、
 * 更新后重读、冲突阻止、无变更空态与关闭开关跳过。
 */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { runStatus } from '../src/core/status';
import { runUpdate } from '../src/core/update';
import { runRemoteStatus } from '../src/core/remoteStatus';
import { runOrThrow } from '../src/core/svnCli';
import { resetPanelRegistry } from '../src/host/panel/host';
import { disposeOutputChannel, resetOutputState } from '../src/host/output';
import { setOperationRegistryForTest } from '../src/core/operations';

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
  sendIntent(intent: Record<string, unknown>, requestId: string): void;
  lastSessionId(): string;
}

function makeFakePanel(viewType: string, title: string): FakePanel {
  let messageHandler: ((raw: unknown) => unknown) | undefined;
  let disposeHandler: (() => void) | undefined;
  let sessionId = '';
  let seq = 0;
  const panel: FakePanel = {
    viewType, title, html: '', posted: [], revealed: 0, disposed: false,
    reveal() { panel.revealed += 1; },
    dispose() {
      if (panel.disposed) return;
      panel.disposed = true;
      disposeHandler?.();
    },
    send(raw) { return messageHandler?.(raw) as void | Promise<void>; },
    sendIntent(intent, requestId) {
      seq += 1;
      return panel.send({ type: 'intent', protocolVersion: 1, sessionId, requestId: requestId || `req-${seq}`, intent }) as void;
    },
    lastSessionId() { return sessionId; },
  };
  (panel as unknown as { webview: unknown }).webview = {
    set html(value: string) { panel.html = value; },
    get html() { return panel.html; },
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
  confirmResult: undefined as string | undefined,
  commitChoice: undefined as string | undefined,
  quickPickChoice: undefined as string | undefined,
  inputResult: undefined as string | undefined,
  config: {} as Record<string, unknown>,
  executedCommands: [] as unknown[][],
  globalState: new Map<string, unknown>(),
}));

vi.mock('vscode', () => ({
  ViewColumn: { Active: 1, Beside: 2 },
  ThemeIcon: class { constructor(public id: string) {} },
  Uri: {
    file: (path: string) => ({ scheme: 'file', path, fsPath: path, toString: () => `file://${path}` }),
    joinPath: (base: { path: string }, ...parts: string[]) => {
      const path = [base.path.replace(/\/$/, ''), ...parts].join('/');
      return { scheme: 'file', path, fsPath: path, toString: () => `file://${path}` };
    },
  },
  window: {
    createOutputChannel: () => ({
      lines: [] as string[],
      shown: 0,
      appendLine(line: string) { (this as { lines: string[] }).lines.push(line); },
      show() { (this as { shown: number }).shown += 1; },
      dispose() {},
    }),
    showInformationMessage: (message: string) => { vscodeMock.information.push(message); return Promise.resolve(undefined); },
    showWarningMessage: (message: string, _options?: unknown, ...items: string[]) => {
      vscodeMock.warning.push(message);
      return Promise.resolve(items.length >= 3 ? vscodeMock.commitChoice : vscodeMock.confirmResult);
    },
    showErrorMessage: (message: string) => { vscodeMock.errorMessages.push(message); return Promise.resolve(undefined); },
    showOpenDialog: () => Promise.resolve(undefined),
    showInputBox: () => Promise.resolve(vscodeMock.inputResult),
    showQuickPick: async (items: Array<{ label: string }>) =>
      Promise.resolve(items.find((item) => item.label === vscodeMock.quickPickChoice) ?? undefined),
    showTextDocument: async () => undefined,
    createWebviewPanel: (viewType: string, title: string) => {
      const panel = makeFakePanel(viewType, title);
      vscodeMock.panels.push(panel);
      return panel;
    },
    withProgress: (_options: unknown, task: (p: unknown, t: unknown) => Promise<unknown>) =>
      task({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) }),
    get activeTextEditor() { return undefined; },
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
import { strings } from '../src/host/i18n';

const makeUri = (fsPath: string): vscode.Uri => ({ fsPath, scheme: 'file' }) as unknown as vscode.Uri;

vi.mocked(runRemoteStatus).mockResolvedValue({ against: 1, entries: [] });
vi.mocked(runStatus).mockResolvedValue({ targetPath: '.', entries: [] , externals: [] });
vi.mocked(runUpdate).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, items: [], conflicts: [] });
vi.mocked(runOrThrow).mockResolvedValue({ stdout: 'Committed revision 9.', stderr: '', exitCode: 0 });

let wcRoot = '';

function lastPanel(): FakePanel {
  const panel = vscodeMock.panels.at(-1);
  if (!panel) {
    throw new Error('面板未创建');
  }
  return panel;
}

async function openPanelAndWait(uriPath: string, expectText: string): Promise<FakePanel> {
  await commandCommit(makeUri(uriPath));
  const panel = lastPanel();
  await vi.waitFor(() => {
    const dataRender = [...panel.posted].reverse().find((m) => m.type === 'render' && String(m.html ?? '').includes(expectText));
    expect(dataRender).toBeDefined();
  });
  return panel;
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
  wcRoot = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-commitchk-')));
  mkdirSync(join(wcRoot, '.svn'), { recursive: true });
  writeFileSync(join(wcRoot, '.svn', 'wc.db'), 'fake');
  writeFileSync(join(wcRoot, 'a.txt'), 'x');
});

afterEach(() => {
  rmSync(wcRoot, { recursive: true, force: true });
  resetPanelRegistry();
});

describe('P1 提交面板 提交前检查', () => {
  it('开关默认开启：面板加载即含远端分组数据，频道写远端检查汇总', async () => {
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'a.txt');
    expect(vi.mocked(runRemoteStatus)).toHaveBeenCalledWith('svn', 'a.txt', expect.objectContaining({ cwd: wcRoot }));
    // 远端无变化：远端分组不渲染。
    const html = String([...panel.posted].reverse().find((m) => m.type === 'render')?.html);
    expect(html).not.toContain(strings.panel.groupRemote);
  });

  it('无远端更新：提交时不弹模态，直接进入提交流程', async () => {
    vi.mocked(runStatus).mockResolvedValue({
      targetPath: '.',
      entries: [{ path: 'a.txt', wcStatus: 'modified', props: 'none', changelist: null }],
      externals: [],
    });
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'a.txt');
    panel.sendIntent({ kind: 'syncInput', fieldId: 'message', value: '直接提交', inputRevision: 1 }, 'in-1');
    panel.sendIntent({ kind: 'submit' }, 'sub-1');
    await vi.waitFor(() => {
      expect(vi.mocked(runOrThrow).mock.calls.some(([, args]) => args[0] === 'commit')).toBe(true);
    });
    expect(vscodeMock.warning).toHaveLength(0);
  });

  it('有远端更新：「更新并继续」后执行更新并重读，提示再次提交（不自动重提）', async () => {
    vscodeMock.commitChoice = strings.commitCheck.updateAndContinue;
    vi.mocked(runRemoteStatus).mockResolvedValue({
      against: 2,
      entries: [{ path: 'a.txt', wcStatus: 'normal', reposStatus: 'modified' }],
    });
    vi.mocked(runStatus).mockResolvedValue({
      targetPath: '.',
      entries: [{ path: 'a.txt', wcStatus: 'modified', props: 'none', changelist: null }],
      externals: [],
    });
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'a.txt');
    panel.sendIntent({ kind: 'syncInput', fieldId: 'message', value: '提交', inputRevision: 1 }, 'in-1');
    const statusCallsBefore = vi.mocked(runStatus).mock.calls.length;
    panel.sendIntent({ kind: 'submit' }, 'sub-1');
    await vi.waitFor(() => {
      expect(vscodeMock.warning.some((m) => m.includes('1 个远端更新'))).toBe(true);
    });
    await vi.waitFor(() => expect(vi.mocked(runUpdate)).toHaveBeenCalled());
    // 更新后重读状态，但不自动再次提交（用户核对后再次点击提交）。
    await vi.waitFor(() => expect(vi.mocked(runStatus).mock.calls.length).toBeGreaterThan(statusCallsBefore));
    expect(vi.mocked(runOrThrow).mock.calls.some(([, args]) => args[0] === 'commit')).toBe(false);
  });

  it('「仅更新」：执行更新后不提交', async () => {
    vscodeMock.commitChoice = strings.commitCheck.updateOnly;
    vi.mocked(runRemoteStatus).mockResolvedValue({
      against: 2,
      entries: [{ path: 'a.txt', reposStatus: 'modified' }],
    });
    vi.mocked(runStatus).mockResolvedValue({
      targetPath: '.',
      entries: [{ path: 'a.txt', wcStatus: 'modified', props: 'none', changelist: null }],
      externals: [],
    });
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'a.txt');
    panel.sendIntent({ kind: 'syncInput', fieldId: 'message', value: '提交', inputRevision: 1 }, 'in-1');
    panel.sendIntent({ kind: 'submit' }, 'sub-1');
    await vi.waitFor(() => expect(vi.mocked(runUpdate)).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(vi.mocked(runOrThrow).mock.calls.some(([, args]) => args[0] === 'commit')).toBe(false);
  });

  it('「取消」或关闭模态：不执行更新也不提交', async () => {
    for (const choice of [strings.commitCheck.cancel, undefined]) {
      vscodeMock.commitChoice = choice;
      vi.mocked(runRemoteStatus).mockResolvedValue({
        against: 2,
        entries: [{ path: 'a.txt', reposStatus: 'modified' }],
      });
      vi.mocked(runStatus).mockResolvedValue({
        targetPath: '.',
        entries: [{ path: 'a.txt', wcStatus: 'modified', props: 'none', changelist: null }],
        externals: [],
      });
      const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'a.txt');
      panel.sendIntent({ kind: 'syncInput', fieldId: 'message', value: '提交', inputRevision: 1 }, 'in-1');
      panel.sendIntent({ kind: 'submit' }, 'sub-1');
      await vi.waitFor(() => expect(vscodeMock.warning.some((m) => m.includes('远端更新'))).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(vi.mocked(runUpdate)).not.toHaveBeenCalled();
      expect(vi.mocked(runOrThrow).mock.calls.some(([, args]) => args[0] === 'commit')).toBe(false);
    }
  });

  it('更新产生冲突：提示指向冲突文件，提交被阻止', async () => {
    vscodeMock.commitChoice = strings.commitCheck.updateAndContinue;
    vi.mocked(runRemoteStatus).mockResolvedValue({
      against: 2,
      entries: [{ path: 'a.txt', reposStatus: 'modified' }],
    });
    vi.mocked(runUpdate).mockResolvedValue({
      stdout: '', stderr: '', exitCode: 0,
      items: [{ status: 'C', path: 'a.txt' }],
      finalRevision: 3,
      conflicts: ['a.txt'],
    });
    vi.mocked(runStatus).mockResolvedValue({
      targetPath: '.',
      entries: [{ path: 'a.txt', wcStatus: 'modified', props: 'none', changelist: null }],
      externals: [],
    });
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'a.txt');
    panel.sendIntent({ kind: 'syncInput', fieldId: 'message', value: '提交', inputRevision: 1 }, 'in-1');
    panel.sendIntent({ kind: 'submit' }, 'sub-1');
    await vi.waitFor(() => {
      expect(vscodeMock.information.some((m) => m.includes('已停止提交') && m.includes('a.txt'))).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(vi.mocked(runOrThrow).mock.calls.some(([, args]) => args[0] === 'commit')).toBe(false);
  });

  it('关闭 remoteCheckBeforeCommit：面板无远端分组，提交时不做远端检查', async () => {
    vscodeMock.config = { remoteCheckBeforeCommit: false };
    vi.mocked(runStatus).mockResolvedValue({
      targetPath: '.',
      entries: [{ path: 'a.txt', wcStatus: 'modified', props: 'none', changelist: null }],
      externals: [],
    });
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'a.txt');
    expect(vi.mocked(runRemoteStatus)).not.toHaveBeenCalled();
    panel.sendIntent({ kind: 'syncInput', fieldId: 'message', value: '跳过检查', inputRevision: 1 }, 'in-1');
    panel.sendIntent({ kind: 'submit' }, 'sub-1');
    await vi.waitFor(() => {
      expect(vi.mocked(runOrThrow).mock.calls.some(([, args]) => args[0] === 'commit')).toBe(true);
    });
    expect(vi.mocked(runRemoteStatus)).not.toHaveBeenCalled();
  });

  it('远端有更新时面板出现仅远端分组（不可勾选）', async () => {
    vi.mocked(runRemoteStatus).mockResolvedValue({
      against: 2,
      entries: [{ path: 'incoming.ts', reposStatus: 'added' }],
    });
    vi.mocked(runStatus).mockResolvedValue({
      targetPath: '.',
      entries: [{ path: 'a.txt', wcStatus: 'modified', props: 'none', changelist: null }],
      externals: [],
    });
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), 'incoming.ts');
    const html = String([...panel.posted].reverse().find((m) => m.type === 'render' && String(m.html ?? '').includes('incoming.ts'))?.html);
    expect(html).toContain(strings.panel.groupRemote);
    expect(html).toMatch(/data-row-id="incoming\.ts"[^>]*disabled/);
  });

  it('无变更：面板空态展示（可刷新），提交无动作', async () => {
    vi.mocked(runStatus).mockResolvedValue({ targetPath: '.', entries: [] , externals: [] });
    const panel = await openPanelAndWait(join(wcRoot, 'a.txt'), strings.panel.emptyTitle);
    const html = String([...panel.posted].reverse().find((m) => m.type === 'render' && String(m.html ?? '').includes(strings.panel.emptyTitle))?.html);
    expect(html).toContain(strings.panel.emptyTitle);
    panel.sendIntent({ kind: 'submit' }, 'sub-1');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(vi.mocked(runOrThrow).mock.calls.some(([, args]) => args[0] === 'commit')).toBe(false);
  });
});
