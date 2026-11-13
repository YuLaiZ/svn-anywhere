/**
 * P6 更新到历史 revision 的控制器全链（真实 svnadmin + file:// lab）：
 * - 面板内选择 revision → 真实写前检查 → 模态确认 → operation record
 *   begin → `svn update --ignore-externals -r` → 权威回读 → 五态结算；
 * - 更新成功：文件内容/节点 revision/BASE 徽标/终态页/记录收口一致；
 * - 更新冲突：确认窗口后的外部并发本地修改真实产生冲突，结果对象经
 *   内存快照交给 P7（source='update' + taskContext 顶部展示事实）；
 * - 更新未知：wrapper 让 update 实际写入但退出码非零，记录保持 unknown
 *   写锁；只读回扫真实收口到 updated；
 * - 宿主重启：预置 history-update running 记录经 loadPending 分诊为
 *   unknown，打开面板进入 updateUnknown 且回扫可收口；
 * - 关闭面板任务继续与三出口编排由 historyPanel.test.ts（mock 执行器）
 *   覆盖，本文件验证真实 SVN 链路。
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

/* ------------------------------ vscode 替身 ------------------------------ */

interface VscodeMockState {
  information: string[];
  warning: string[];
  errors: string[];
  clipboard: string[];
  panels: FakePanel[];
  config: Record<string, unknown>;
}

const vscodeMock: VscodeMockState = {
  information: [],
  warning: [],
  errors: [],
  clipboard: [],
  panels: [],
  config: {},
};

/** 模态确认前的测试钩子（模拟「用户确认后、命令发出前」的外部并发修改）。 */
let beforeConfirm: (() => void | Promise<void>) | undefined;

vi.mock('vscode', () => ({
  ViewColumn: { Active: 1, Beside: 2 },
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  Uri: {
    file: (path: string) => ({ scheme: 'file', path, fsPath: path, toString: () => `file://${path}` }),
    parse: (value: string) => ({ scheme: 'file', path: value, toString: () => value }),
    joinPath: (base: { path: string }, ...parts: string[]) => {
      const path = [base.path.replace(/\/$/, ''), ...parts].join('/');
      return { scheme: 'file', path, fsPath: path, toString: () => `file://${path}` };
    },
  },
  window: {
    createOutputChannel: () => ({
      lines: [] as string[],
      appendLine() {},
      show() {},
      dispose() {},
    }),
    showInformationMessage: (message: string) => {
      vscodeMock.information.push(message);
      return Promise.resolve(undefined);
    },
    showWarningMessage: async (...args: unknown[]) => {
      vscodeMock.warning.push(String(args[0] ?? ''));
      const modal = typeof args[1] === 'object' && args[1] !== null;
      const last = args[args.length - 1];
      if (modal && typeof last === 'string') {
        await beforeConfirm?.();
        return last;
      }
      return undefined;
    },
    showErrorMessage: (message: string) => {
      vscodeMock.errors.push(message);
      return Promise.resolve(undefined);
    },
    showInputBox: () => Promise.resolve(undefined),
    showQuickPick: () => Promise.resolve(undefined),
    showTextDocument: () => Promise.resolve(undefined),
    createWebviewPanel: (_viewType: string, title: string) => {
      const panel = makeFakePanel(title);
      vscodeMock.panels.push(panel);
      return panel;
    },
    get activeTextEditor() {
      return undefined;
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => (key in vscodeMock.config ? vscodeMock.config[key] : fallback),
    }),
    get workspaceFolders() {
      return [];
    },
    onDidCloseTextDocument: () => ({ dispose() {} }),
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
  },
  env: {
    clipboard: {
      writeText: (value: string) => {
        vscodeMock.clipboard.push(value);
        return Promise.resolve();
      },
    },
    openExternal: () => Promise.resolve(true),
  },
  commands: {
    executeCommand: async () => undefined,
  },
  ProgressLocation: { Notification: 15 },
}));

vi.mock('../src/host/auth', () => ({
  credentialProvider: () => vi.fn(),
}));

// P7 交接只验证「传参契约」；P7 面板自身的扫描/展示由 conflictPanel.test.ts 覆盖。
vi.mock('../src/host/commands/conflicts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/commands/conflicts')>();
  return { ...actual, openConflictTarget: vi.fn() };
});

import type { OperationRecord, OperationStore } from '../src/core/operations';
import {
  getOperationRegistry,
  OperationRegistry,
  resetRunningOperationsForTest,
  setOperationRegistryForTest,
} from '../src/core/operations';
import { openConflictTarget } from '../src/host/commands/conflicts';
import type { HistoryOpenTarget } from '../src/host/commands/history';
import { resetPanelRegistry } from '../src/host/panel/host';
import {
  historyModelForTest,
  historySessionSnapshot,
  openHistoryPanel,
  resetHistoryPanelController,
  setHistoryPanelContext,
} from '../src/host/panel/panels/history';
import { resetOutputState } from '../src/host/output';
import { readM4ScopeSession, resetM4SessionStore } from '../src/host/sessionResults';
import { getActiveTask, resetTaskRegistry } from '../src/host/taskRegistry';
import { createSvnLab, writeFile, type SvnLab } from './helpers';

/* ------------------------------ 面板替身 ------------------------------ */

interface FakePanel {
  title: string;
  html: string;
  posted: Array<Record<string, unknown>>;
  disposed: boolean;
  dispose(): void;
  send(raw: unknown): Promise<void> | void;
  sendIntent(intent: Record<string, unknown>, requestId?: string): void;
  latestRenderHtml(): string;
  toasts(): string[];
}

function makeFakePanel(title: string): FakePanel {
  let messageHandler: ((raw: unknown) => unknown) | undefined;
  let disposeHandler: (() => void) | undefined;
  let sessionId = '';
  let seq = 0;
  const panel: FakePanel = {
    title,
    html: '',
    posted: [],
    disposed: false,
    dispose() {
      if (panel.disposed) {
        return;
      }
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
    latestRenderHtml() {
      for (let index = panel.posted.length - 1; index >= 0; index -= 1) {
        const message = panel.posted[index];
        if (message.type === 'render') {
          return String(message.html ?? '');
        }
      }
      return '';
    },
    toasts() {
      return panel.posted
        .filter((message) => message.type === 'toast')
        .map((message) => String(message.message ?? ''));
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

function fakePanel(): FakePanel {
  const panel = vscodeMock.panels[vscodeMock.panels.length - 1];
  expect(panel).toBeDefined();
  return panel;
}

async function waitFor(check: () => boolean, attempts = 400): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(check()).toBe(true);
}

/* ------------------------------ 真实 SVN lab ------------------------------ */

const lab: SvnLab = createSvnLab('svn-anywhere-history-update-controller-');
afterAll(() => lab.cleanup());

interface LocalTargetInput {
  wcRoot: string;
  relativePath: string;
  baseRevision?: number;
}

function repositoryUuid(): string {
  return lab.svn(['info', '--show-item', 'repos-uuid', lab.repoUrl]).trim();
}

function localTargetOf(input: LocalTargetInput): Extract<HistoryOpenTarget, { source: 'local' }> {
  const url = lab.svn(['info', '--show-item', 'url', input.relativePath], input.wcRoot).trim();
  const baseRevision = input.baseRevision
    ?? Number(lab.svn(['info', '--show-item', 'revision', input.relativePath], input.wcRoot).trim());
  const absolute = join(input.wcRoot, ...input.relativePath.split('/'));
  const kind = execFileSync('svn', ['info', '--show-item', 'kind', input.relativePath], {
    cwd: input.wcRoot,
    encoding: 'utf8',
  }).trim() === 'dir' ? 'dir' : 'file';
  return {
    source: 'local',
    wcRoot: input.wcRoot,
    localPath: absolute,
    url,
    repositoryRootUrl: lab.repoUrl,
    repositoryUuid: repositoryUuid(),
    relativePath: input.relativePath,
    kind,
    baseRevision,
  };
}

/** 在主仓库提交一个唯一文件/目录基线。 */
function seed(relative: string, content = 'v1\n'): { revision: number; wc: string } {
  const seeder = lab.checkout(`seed-${relative.replace(/[/.]/g, '-')}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  writeFile(seeder, relative, content, true);
  lab.svn(['commit', '-q', '-m', `seed ${relative}`], seeder);
  const revision = Number(lab.svn(['info', '--show-item', 'revision', relative], seeder).trim());
  return { revision, wc: seeder };
}

function memoryStore(): OperationStore & { records: OperationRecord[] } {
  const records: OperationRecord[] = [];
  return {
    records,
    load: () => records.map((record) => ({ ...record })),
    save(record) {
      const index = records.findIndex((item) => item.operationId === record.operationId);
      if (index >= 0) {
        records[index] = { ...record };
      } else {
        records.push({ ...record });
      }
    },
    remove(operationId) {
      const index = records.findIndex((item) => item.operationId === operationId);
      if (index >= 0) {
        records.splice(index, 1);
      }
    },
  };
}

/** 让 update 实际执行但退出码非零的 svn wrapper（未知态真实链路）。 */
function createFailingUpdateSvn(): string {
  const realSvn = execFileSync('which', ['svn'], { encoding: 'utf8' }).trim();
  const wrapper = join(lab.root, `svn-update-fails-${process.pid}-${Date.now()}.sh`);
  writeFileSync(wrapper, `#!/bin/sh\n"${realSvn}" "$@"\nrc=$?\nif [ "$1" = "update" ]; then\n  exit 1\nfi\nexit $rc\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

/** 打开 P6 并选择 revision 行，等待详情解析完成。 */
async function openAndSelect(target: HistoryOpenTarget, revision: number): Promise<void> {
  await openHistoryPanel(target);
  await waitFor(() => historySessionSnapshot().hasLoadedData === true);
  fakePanel().sendIntent({ kind: 'selectHistoryRevision', id: `r${revision}` });
  await waitFor(() => historyModelForTest()?.detailState()?.revision === revision);
  await waitFor(() => historyModelForTest()?.detailState()?.resolution.status === 'present');
}

beforeEach(() => {
  resetPanelRegistry();
  resetHistoryPanelController();
  resetM4SessionStore();
  resetOutputState();
  resetTaskRegistry();
  resetRunningOperationsForTest();
  setOperationRegistryForTest(new OperationRegistry());
  vscodeMock.information.length = 0;
  vscodeMock.warning.length = 0;
  vscodeMock.errors.length = 0;
  vscodeMock.clipboard.length = 0;
  vscodeMock.panels.length = 0;
  vscodeMock.config = {};
  beforeConfirm = undefined;
  vi.mocked(openConflictTarget).mockReset();
  vi.mocked(openConflictTarget).mockResolvedValue(undefined);
  setHistoryPanelContext({
    extensionUri: { scheme: 'file', path: '/extension' } as unknown as vscode.Uri,
    subscriptions: [],
  });
});

afterEach(() => {
  resetHistoryPanelController();
  resetPanelRegistry();
  resetTaskRegistry();
  resetRunningOperationsForTest();
  setOperationRegistryForTest(undefined);
});

describe('P6 更新控制器（真实 file:// lab）', () => {
  it('更新成功：真实更新 → updated；文件/节点 revision/BASE/终态页/记录收口一致', async () => {
    const seeded = seed('ctl/ok.txt', 'v1\n');
    const wc = lab.checkout(`ctl-ok-${Date.now()}`);
    lab.svn(['update', '-q', '-r', String(seeded.revision)], wc);
    const remote = lab.checkout(`ctl-ok-remote-${Date.now()}`);
    writeFile(remote, 'ctl/ok.txt', 'v2\n');
    lab.svn(['commit', '-q', '-m', 'remote v2'], remote);
    const targetRev = Number(lab.svn(['info', '--show-item', 'revision', 'ctl/ok.txt'], remote).trim());

    const target = localTargetOf({ wcRoot: wc, relativePath: 'ctl/ok.txt', baseRevision: seeded.revision });
    await openAndSelect(target, targetRev);
    // 真实写前检查（目标存在、status --ignore-externals 干净）通过后点击更新。
    fakePanel().sendIntent({ kind: 'updateToHistoryRevision' });
    await waitFor(() => historySessionSnapshot().updatePhase === 'updated');
    await waitFor(() => getActiveTask('history') === undefined);

    expect(lab.svn(['info', '--show-item', 'revision', 'ctl/ok.txt'], wc).trim()).toBe(String(targetRev));
    expect(lab.svn(['status', '--xml'], wc)).not.toContain('item="conflicted"');
    expect(historySessionSnapshot()).toMatchObject({
      updateRequestedRevision: targetRev,
      updatePreRevision: seeded.revision,
      updatePostRevision: targetRev,
      updateConflicts: 0,
    });
    expect(historyModelForTest()?.localBaseRevision()).toBe(targetRev);
    expect(await getOperationRegistry().loadAllRecords()).toEqual([]);
    const scope = {
      scopeKind: 'history' as const,
      targetKey: JSON.stringify([
        'history-target',
        target.repositoryUuid,
        target.repositoryRootUrl,
        target.relativePath,
        target.kind,
      ]),
      targetKind: 'file' as const,
    };
    expect(readM4ScopeSession(scope)?.terminalPage).toMatchObject({ version: 1, kind: 'history-update' });
    expect(fakePanel().latestRenderHtml()).toContain('更新完成');
  });

  it('更新冲突：确认窗口后的外部并发修改真实产生冲突；结果对象与 taskContext 交给 P7', async () => {
    const seeded = seed('ctl/conflict.txt', 'v1\n');
    const wc = lab.checkout(`ctl-conflict-${Date.now()}`);
    lab.svn(['update', '-q', '-r', String(seeded.revision)], wc);
    const remote = lab.checkout(`ctl-conflict-remote-${Date.now()}`);
    writeFile(remote, 'ctl/conflict.txt', 'v1\nremote\n');
    lab.svn(['commit', '-q', '-m', 'remote conflict'], remote);
    const targetRev = Number(lab.svn(['info', '--show-item', 'revision', 'ctl/conflict.txt'], remote).trim());

    const target = localTargetOf({ wcRoot: wc, relativePath: 'ctl/conflict.txt', baseRevision: seeded.revision });
    await openAndSelect(target, targetRev);
    // 写前检查在确认前读取（干净）；确认按钮按下时发生外部并发本地修改。
    beforeConfirm = () => {
      writeFile(wc, 'ctl/conflict.txt', 'v1\nlocal\n');
    };
    fakePanel().sendIntent({ kind: 'updateToHistoryRevision' });
    await waitFor(() => historySessionSnapshot().updatePhase === 'updateConflict');
    await waitFor(() => getActiveTask('history') === undefined);

    expect(historySessionSnapshot()).toMatchObject({
      updateRequestedRevision: targetRev,
      updatePreRevision: seeded.revision,
      updatePostRevision: targetRev,
      updateConflicts: 1,
    });
    expect(lab.svn(['status', '--xml'], wc)).toContain('item="conflicted"');
    expect(historyModelForTest()?.localBaseRevision()).toBe(targetRev);
    expect(fakePanel().latestRenderHtml()).toContain('更新完成，存在冲突');

    fakePanel().sendIntent({ kind: 'bannerAction', bannerId: 'historyUpdate', actionId: 'openUpdateConflicts' });
    await waitFor(() => vi.mocked(openConflictTarget).mock.calls.length === 1);
    const handed = vi.mocked(openConflictTarget).mock.calls[0][0];
    expect(handed).toMatchObject({
      source: 'update',
      wcRoot: wc,
      scopeRelPath: 'ctl/conflict.txt',
      taskContext: {
        targetRelPath: 'ctl/conflict.txt',
        targetKind: 'file',
        requestedRevision: targetRev,
        preRevision: seeded.revision,
        postNodeRevision: targetRev,
        outcome: 'conflict',
        conflictCount: 1,
      },
    });
  });

  it('更新未知：update 实际写入但退出码非零 → unknown 写锁；真实只读回扫收口 updated', async () => {
    const seeded = seed('ctl/unknown.txt', 'v1\n');
    const wc = lab.checkout(`ctl-unknown-${Date.now()}`);
    lab.svn(['update', '-q', '-r', String(seeded.revision)], wc);
    const remote = lab.checkout(`ctl-unknown-remote-${Date.now()}`);
    writeFile(remote, 'ctl/unknown.txt', 'v2\n');
    lab.svn(['commit', '-q', '-m', 'unknown remote v2'], remote);
    const targetRev = Number(lab.svn(['info', '--show-item', 'revision', 'ctl/unknown.txt'], remote).trim());

    vscodeMock.config = { svnPath: createFailingUpdateSvn() };
    const target = localTargetOf({ wcRoot: wc, relativePath: 'ctl/unknown.txt', baseRevision: seeded.revision });
    await openAndSelect(target, targetRev);
    fakePanel().sendIntent({ kind: 'updateToHistoryRevision' });
    await waitFor(() => historySessionSnapshot().updatePhase === 'updateUnknown');
    await waitFor(() => getActiveTask('history') === undefined);

    // 命令被记为失败但写入实际已发生：旧 BASE 保持，记录 unknown 写锁。
    expect(lab.svn(['info', '--show-item', 'revision', 'ctl/unknown.txt'], wc).trim()).toBe(String(targetRev));
    expect(historySessionSnapshot()).toMatchObject({
      updatePreRevision: seeded.revision,
      updatePostRevision: targetRev,
      updateCommandError: expect.any(String),
    });
    expect(historyModelForTest()?.localBaseRevision()).toBe(seeded.revision);
    const unknownRecord = getOperationRegistry().writeRestriction(wc);
    expect(unknownRecord?.phase).toBe('unknown');
    expect(unknownRecord?.kind).toBe('history-update');
    expect(fakePanel().latestRenderHtml()).toContain('更新结果未知');

    fakePanel().sendIntent({ kind: 'rescanHistoryUpdate' });
    await waitFor(() => historySessionSnapshot().updatePhase === 'updated');
    await waitFor(() => getActiveTask('history') === undefined);
    expect(getOperationRegistry().writeRestriction(wc)).toBeUndefined();
    expect(await getOperationRegistry().loadAllRecords()).toEqual([]);
    expect(historyModelForTest()?.localBaseRevision()).toBe(targetRev);
  });

  it('宿主重启分诊：预置 running 记录 → unknown；打开面板 updateUnknown；回扫真实收口', async () => {
    const seeded = seed('ctl/restart.txt', 'v1\n');
    const wc = lab.checkout(`ctl-restart-${Date.now()}`);
    lab.svn(['update', '-q', '-r', String(seeded.revision)], wc);
    const remote = lab.checkout(`ctl-restart-remote-${Date.now()}`);
    writeFile(remote, 'ctl/restart.txt', 'v2\n');
    lab.svn(['commit', '-q', '-m', 'restart remote v2'], remote);
    const targetRev = Number(lab.svn(['info', '--show-item', 'revision', 'ctl/restart.txt'], remote).trim());
    const targetUrl = lab.svn(['info', '--show-item', 'url', 'ctl/restart.txt'], wc).trim();

    // 模拟「写命令实际已执行、宿主在收口前被 kill」：预置 running 记录，
    // 真实执行一次 update 把工作副本推进到请求 revision，再重启注册表。
    const store = memoryStore();
    const first = new OperationRegistry(store);
    const begin = await first.begin({
      wcRoot: wc,
      lockKey: wc,
      kind: 'history-update',
      operationId: 'op-restart',
      targetRelPath: 'ctl/restart.txt',
      nodeKind: 'file',
      baseRevision: seeded.revision,
      historyUpdateIntent: {
        wcRoot: wc,
        targetRelPath: 'ctl/restart.txt',
        targetKind: 'file',
        targetUrl,
        requestedRevision: targetRev,
        preRevision: seeded.revision,
      },
    });
    expect(begin.ok).toBe(true);
    await first.markPhase('op-restart', 'running');
    lab.svn(['update', '-q', '-r', String(targetRev), 'ctl/restart.txt'], wc);
    resetRunningOperationsForTest();
    const restarted = new OperationRegistry(store);
    await restarted.loadPending();
    expect(store.records.find((record) => record.operationId === 'op-restart')?.phase).toBe('unknown');
    setOperationRegistryForTest(restarted);

    const target = localTargetOf({ wcRoot: wc, relativePath: 'ctl/restart.txt', baseRevision: seeded.revision });
    await openHistoryPanel(target);
    await waitFor(() => historySessionSnapshot().updatePhase === 'updateUnknown');
    expect(historySessionSnapshot()).toMatchObject({
      updateOperationId: 'op-restart',
      updateRequestedRevision: targetRev,
      updatePreRevision: seeded.revision,
    });
    expect(fakePanel().latestRenderHtml()).toContain('更新结果未知');

    fakePanel().sendIntent({ kind: 'rescanHistoryUpdate' });
    await waitFor(() => historySessionSnapshot().updatePhase === 'updated');
    await waitFor(() => getActiveTask('history') === undefined);
    expect(store.records).toEqual([]);
    expect(historyModelForTest()?.localBaseRevision()).toBe(targetRev);
  });
});
