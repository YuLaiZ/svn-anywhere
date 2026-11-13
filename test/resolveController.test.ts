/**
 * P7 单项冲突写入执行链（panels/conflicts.ts）真实 SVN 集成测试：
 * 本地 `svnadmin + file://` 隔离副本按阶段 0 V4 的构造方式产生文本、
 * 二进制、属性与树冲突，从面板入口与意图驱动，验证：
 * - 扫描 → 选择变体 → apply 的完整链路（真实 svn resolve --depth empty）；
 * - 文本/二进制/属性/树动作矩阵与回扫撤下（resolvedLedger）；
 * - 树冲突必须先确认节点；文本 working 必须二次确认（横幅确认）；
 * - 外部客户端先解决后旧计划被指纹重读拒绝，不冒充成功；
 * - operation record 的 begin/running/done 生命周期与固定 resolveIntent。
 * 不访问任何远端 SVN，不使用真实凭据。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

/* ------------------------------ vscode 替身 ------------------------------ */

interface VscodeMockState {
  information: string[];
  warning: string[];
  errors: string[];
  clipboard: string[];
  terminals: Array<{ name?: string; cwd?: string }>;
  opened: string[];
  diffCommands: Array<{ command: string; left: string; right: string; title: string }>;
  panels: FakePanel[];
  config: Record<string, unknown>;
}

const vscodeMock: VscodeMockState = {
  information: [],
  warning: [],
  errors: [],
  clipboard: [],
  terminals: [],
  opened: [],
  diffCommands: [],
  panels: [],
  config: {},
};

vi.mock('vscode', () => ({
  ViewColumn: { Active: 1, Beside: 2 },
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  Uri: {
    file: (path: string) => ({ scheme: 'file', path, fsPath: path, toString: () => `file://${path}` }),
    parse: (value: string) => ({ scheme: 'file', path: value, fsPath: value, toString: () => value }),
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
    showWarningMessage: (message: string) => {
      vscodeMock.warning.push(message);
      return Promise.resolve(undefined);
    },
    showErrorMessage: (message: string) => {
      vscodeMock.errors.push(message);
      return Promise.resolve(undefined);
    },
    showInputBox: () => Promise.resolve(undefined),
    showQuickPick: () => Promise.resolve(undefined),
    showTextDocument: (uri: { fsPath: string }) => {
      vscodeMock.opened.push(uri.fsPath);
      return Promise.resolve(undefined);
    },
    createTerminal: (options: { name?: string; cwd?: string }) => {
      vscodeMock.terminals.push(options);
      return { show() {} };
    },
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
    openExternal: (uri: { fsPath: string }) => {
      vscodeMock.opened.push(uri.fsPath);
      return Promise.resolve(true);
    },
  },
  commands: {
    executeCommand: async (command: string, left: { fsPath: string }, right: { fsPath: string }, title: string) => {
      vscodeMock.diffCommands.push({ command, left: left.fsPath, right: right.fsPath, title });
    },
  },
  ProgressLocation: { Notification: 15 },
}));

import {
  OperationRegistry,
  getOperationRegistry,
  setOperationRegistryForTest,
} from '../src/core/operations';
import { svnEnv } from '../src/core/svnCli';
import { resetOutputState } from '../src/host/output';
import { resetPanelRegistry } from '../src/host/panel/host';
import {
  CONTROL_TEXT_DEFAULTS,
  conflictsModelForTest,
  conflictsSessionSnapshot,
  openConflictPanel,
  resetConflictPanelController,
  setConflictPanelContext,
} from '../src/host/panel/panels/conflicts';
import { strings } from '../src/host/i18n';
import { resetM4SessionStore, resetSessionResults } from '../src/host/sessionResults';
import { hasActiveTask, resetTaskRegistry } from '../src/host/taskRegistry';
import { createSvnLab, writeFile, type SvnLab } from './helpers';

/* ------------------------------ 面板替身 ------------------------------ */

interface FakePanel {
  title: string;
  html: string;
  posted: Array<Record<string, unknown>>;
  disposed: boolean;
  reveal(): void;
  dispose(): void;
  send(raw: unknown): Promise<void> | void;
  sendIntent(intent: Record<string, unknown>, requestId?: string): Promise<void>;
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
    reveal() {},
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
    async sendIntent(intent, requestId) {
      seq += 1;
      await panel.send({
        type: 'intent',
        protocolVersion: 1,
        sessionId,
        requestId: requestId || `req-${seq}`,
        intent,
      });
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, attempts = 1000, interval = 10): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (check()) {
      return;
    }
    await delay(interval);
  }
  expect(check()).toBe(true);
}

async function waitIdle(): Promise<void> {
  await waitFor(() => !hasActiveTask('conflicts'));
  // 任务结算中的持久化/通知都在 removeTask 之前完成；再让一轮微任务收尾。
  await delay(0);
}

/* ------------------------------ 环境与操作记录 ------------------------------ */

function resetVscodeMock(): void {
  vscodeMock.information.length = 0;
  vscodeMock.warning.length = 0;
  vscodeMock.errors.length = 0;
  vscodeMock.clipboard.length = 0;
  vscodeMock.terminals.length = 0;
  vscodeMock.opened.length = 0;
  vscodeMock.diffCommands.length = 0;
  vscodeMock.panels.length = 0;
  vscodeMock.config = {};
}

function resetController(): void {
  resetConflictPanelController();
  resetPanelRegistry();
  resetTaskRegistry();
  resetSessionResults();
  resetM4SessionStore();
}

function setup(): void {
  resetVscodeMock();
  resetController();
  resetOutputState();
  setOperationRegistryForTest(new OperationRegistry());
  setConflictPanelContext({
    extensionUri: { path: '/ext', toString: () => 'file:///ext' } as unknown as vscode.Uri,
    subscriptions: [],
  });
}

afterEach(() => {
  resetController();
  setOperationRegistryForTest(undefined);
});

/* ------------------------------ 冲突夹具 ------------------------------ */

const TEXT_BASE = 'line1\nline2\nline3\n';

/** 打开 P7 并等待自动扫描结束。 */
async function openAndScan(wcRoot: string): Promise<void> {
  await openConflictPanel({ source: 'local', wcRoot, scopeRelPath: '.' });
  await waitIdle();
}

/** 发送意图并等待可能触发的任务结束。 */
async function sendIntent(intent: Record<string, unknown>): Promise<void> {
  await fakePanel().sendIntent(intent);
  await delay(0);
}

/** 行 ID：按路径查模型行（避开内部指纹哈希的具体值）。 */
function rowIdOf(path: string): string {
  const model = conflictsModelForTest();
  const row = model?.rows().find((candidate) => candidate.path === path);
  expect(row).toBeDefined();
  return row!.key;
}

/**
 * 选中路径并等待渲染（真实意图：宿主行校验查 conflictList 后转发控制器）。
 */
async function selectPath(path: string): Promise<void> {
  await sendIntent({ kind: 'selectConflict', id: rowIdOf(path) });
  expect(conflictsModelForTest()?.selectedKey()).toBe(rowIdOf(path));
  await delay(0);
}

async function chooseVariant(value: string): Promise<void> {
  await sendIntent({ kind: 'chooseConflictVariant', value });
}

async function apply(): Promise<void> {
  await sendIntent({ kind: 'applyConflictResolution' });
  await waitIdle();
}

/** 横幅确认动作（host 会校验横幅与 action 存在于当前渲染）。 */
async function confirmBanner(bannerId: string, actionId: string): Promise<void> {
  await sendIntent({ kind: 'bannerAction', bannerId, actionId });
  await waitIdle();
}

/* ------------------------------ 仓库构造 ------------------------------ */

function commitBase(lab: SvnLab, files: Array<{ path: string; content: string | Buffer }>): string {
  const wc0 = lab.checkout('wc0');
  for (const file of files) {
    if (typeof file.content === 'string') {
      writeFile(wc0, file.path, file.content, true);
    } else {
      const fsPath = join(wc0, file.path);
      writeFileSync(fsPath, file.content);
      lab.svn(['add', '-q', file.path], wc0);
    }
  }
  lab.svn(['commit', '-q', '-m', 'base'], wc0);
  return wc0;
}

function checkoutBoth(lab: SvnLab): { wc1: string; wc2: string } {
  const wc1 = lab.checkout('wc1');
  const wc2 = lab.checkout('wc2');
  return { wc1, wc2 };
}

/** 文本冲突：双方改同一行。 */
function buildTextConflict(lab: SvnLab): string {
  commitBase(lab, [{ path: 'text.txt', content: TEXT_BASE }]);
  const { wc1, wc2 } = checkoutBoth(lab);
  writeFile(wc1, 'text.txt', 'line1-theirs\nline2\nline3\n');
  lab.svn(['commit', '-q', '-m', 'incoming'], wc1);
  writeFile(wc2, 'text.txt', 'line1-local\nline2\nline3\n');
  lab.svn(['update'], wc2);
  return wc2;
}

/** 二进制冲突：双方改含 NUL 的文件。 */
function buildBinaryConflict(lab: SvnLab): string {
  commitBase(lab, [{ path: 'binary.bin', content: Buffer.from('binary base \u0000\u0001 data\n', 'binary') }]);
  const { wc1, wc2 } = checkoutBoth(lab);
  writeFileSync(join(wc1, 'binary.bin'), Buffer.from('binary theirs \u0000\u0002 data\n', 'binary'));
  lab.svn(['commit', '-q', '-m', 'incoming'], wc1);
  writeFileSync(join(wc2, 'binary.bin'), Buffer.from('binary local \u0000\u0003 data\n', 'binary'));
  lab.svn(['update'], wc2);
  return wc2;
}

/** 属性冲突：双方改同一属性。 */
function buildPropertyConflict(lab: SvnLab): string {
  const wc0 = commitBase(lab, [{ path: 'prop.txt', content: 'prop content\n' }]);
  lab.svn(['propset', '-q', 'k', 'base', 'prop.txt'], wc0);
  lab.svn(['commit', '-q', '-m', 'base prop'], wc0);
  const { wc1, wc2 } = checkoutBoth(lab);
  lab.svn(['propset', '-q', 'k', 'theirs', 'prop.txt'], wc1);
  lab.svn(['commit', '-q', '-m', 'incoming prop'], wc1);
  lab.svn(['propset', '-q', 'k', 'local', 'prop.txt'], wc2);
  lab.svn(['update'], wc2);
  return wc2;
}

/** 树冲突：本地编辑 vs 传入删除。 */
function buildTreeConflict(lab: SvnLab): string {
  commitBase(lab, [{ path: 'tree-del.txt', content: 'tree base\n' }]);
  const { wc1, wc2 } = checkoutBoth(lab);
  lab.svn(['rm', '-q', 'tree-del.txt'], wc1);
  lab.svn(['commit', '-q', '-m', 'incoming delete'], wc1);
  writeFile(wc2, 'tree-del.txt', 'tree local edit\n');
  lab.svn(['update'], wc2);
  return wc2;
}

function readText(wc: string, path: string): string {
  return readFileSync(join(wc, path), 'utf8');
}

/** `svn status --xml` 是否仍把路径报告为任意类型冲突。 */
function stillConflicted(wc: string, path: string): boolean {
  const xml = execSvn(['status', '--xml', '--ignore-externals', '--', path], wc);
  return /item="conflicted"|props="conflicted"|tree-conflicted="true"/.test(xml);
}

function execSvn(args: string[], cwd: string): string {
  // 复用产品子进程环境口径（测试 setup 已注入 locale）。
  return execFileSync('svn', args, { cwd, encoding: 'utf8', env: svnEnv() });
}

/* ------------------------------ 用例 ------------------------------ */

describe('P7 单项 resolve 执行链（真实 file:// 副本）', () => {
  it('文本冲突 theirs-full：apply 后文件为传入内容、台账 resolved、写锁释放', async () => {
    const lab = createSvnLab('svn-anywhere-resolve-text-');
    try {
      const wc = buildTextConflict(lab);
      setup();
      await openAndScan(wc);
      const snapshot = conflictsSessionSnapshot();
      expect(snapshot.rows).toBe(1);
      expect(snapshot.taskKind).toBeUndefined();

      await selectPath('text.txt');
      await chooseVariant('theirs-full');
      // apply 后 resolve 任务在后台执行；等待任务结束与回扫收口。
      await apply();
      expect(readText(wc, 'text.txt')).toBe('line1-theirs\nline2\nline3\n');
      expect(stillConflicted(wc, 'text.txt')).toBe(false);
      expect(conflictsSessionSnapshot().ledger).toBe(1);
      expect(getOperationRegistry().writeRestriction(wc)).toBeUndefined();
      expect(conflictsSessionSnapshot().resolveNotice).toContain('冲突已解决');
    } finally {
      lab.cleanup();
    }
  });

  it('文本 working：详情按钮只弹确认，确认横幅后才执行并保留冲突标记', async () => {
    const lab = createSvnLab('svn-anywhere-resolve-working-');
    try {
      const wc = buildTextConflict(lab);
      setup();
      await openAndScan(wc);
      await selectPath('text.txt');
      await chooseVariant('working');
      await sendIntent({ kind: 'applyConflictResolution' });
      // 未确认：没有写命令，文件保持含冲突标记的工作内容。
      expect(readText(wc, 'text.txt')).toContain('line1-local');
      expect(stillConflicted(wc, 'text.txt')).toBe(true);
      expect(conflictsSessionSnapshot().pendingConfirm?.kind).toBe('working');
      expect(hasActiveTask('conflicts')).toBe(false);

      await confirmBanner('conflictWorkingConfirm', 'confirmWorkingApply');
      expect(stillConflicted(wc, 'text.txt')).toBe(false);
      // working 保留冲突标记内容（含 <<<<<<<）。
      expect(readText(wc, 'text.txt')).toContain('<<<<<<<');
      expect(conflictsSessionSnapshot().ledger).toBe(1);
    } finally {
      lab.cleanup();
    }
  });

  it('尺寸不变：取消确认后再次点详情只重新弹确认，不直接执行', async () => {
    const lab = createSvnLab('svn-anywhere-resolve-cancel-');
    try {
      const wc = buildTextConflict(lab);
      setup();
      await openAndScan(wc);
      await selectPath('text.txt');
      await chooseVariant('working');
      await sendIntent({ kind: 'applyConflictResolution' });
      expect(conflictsSessionSnapshot().pendingConfirm?.kind).toBe('working');
      await sendIntent({ kind: 'bannerAction', bannerId: 'conflictWorkingConfirm', actionId: 'cancelConflictConfirm' });
      expect(conflictsSessionSnapshot().pendingConfirm).toBeUndefined();
      await sendIntent({ kind: 'applyConflictResolution' });
      expect(conflictsSessionSnapshot().pendingConfirm?.kind).toBe('working');
      expect(stillConflicted(wc, 'text.txt')).toBe(true);
    } finally {
      lab.cleanup();
    }
  });

  it('二进制冲突：base 变体被应用层禁用，theirs-full 回扫后撤下', async () => {
    const lab = createSvnLab('svn-anywhere-resolve-binary-');
    try {
      const wc = buildBinaryConflict(lab);
      setup();
      await openAndScan(wc);
      const model = conflictsModelForTest()!;
      const row = model.rows().find((candidate) => candidate.path === 'binary.bin');
      expect(row?.record?.contentKind).toBe('binary');
      await selectPath('binary.bin');
      // 模型 chooseVariant 对禁用变体返回 disabled，不记录选择。
      await chooseVariant('base');
      const chosen = model.selectedVariant(row!.key);
      expect(chosen).toBeUndefined();
      await sendIntent({ kind: 'applyConflictResolution' });
      expect(stillConflicted(wc, 'binary.bin')).toBe(true);
      expect(conflictsSessionSnapshot().ledger).toBe(0);

      await chooseVariant('theirs-full');
      await apply();
      expect(readFileSync(join(wc, 'binary.bin')).equals(Buffer.from('binary theirs \u0000\u0002 data\n', 'binary'))).toBe(true);
      expect(stillConflicted(wc, 'binary.bin')).toBe(false);
      expect(conflictsSessionSnapshot().ledger).toBe(1);
    } finally {
      lab.cleanup();
    }
  });

  it('属性冲突：逐属性选择后一次 working 写回选中值并清除冲突', async () => {
    const lab = createSvnLab('svn-anywhere-resolve-prop-');
    try {
      const wc = buildPropertyConflict(lab);
      setup();
      await openAndScan(wc);
      const model = conflictsModelForTest()!;
      const row = model.rows().find((candidate) => candidate.path === 'prop.txt');
      expect(row?.record?.kinds).toEqual(['property']);
      expect(row?.record?.propertyConflicts?.[0]).toMatchObject({
        name: 'k',
        local: { exists: true },
        base: { exists: true },
        incoming: { exists: true },
      });
      await selectPath('prop.txt');
      // 未选择任何属性：apply 被应用层拒绝，不发出 working。
      await sendIntent({ kind: 'applyConflictResolution' });
      expect(stillConflicted(wc, 'prop.txt')).toBe(true);
      // 逐项选择走真实协议意图（choosePropertyValue），与视图按钮同一入口。
      await sendIntent({ kind: 'choosePropertyValue', property: 'k', choice: 'incoming' });
      expect(model.propertyChoices(row!.key)).toEqual({ k: 'incoming' });
      await apply();
      expect(execSvn(['propget', 'k', 'prop.txt'], wc).trim()).toBe('theirs');
      expect(stillConflicted(wc, 'prop.txt')).toBe(false);
      expect(conflictsSessionSnapshot().ledger).toBe(1);
    } finally {
      lab.cleanup();
    }
  });

  it('树冲突：未确认时 apply 被拒；确认节点后 working 清除树冲突', async () => {
    const lab = createSvnLab('svn-anywhere-resolve-tree-');
    try {
      const wc = buildTreeConflict(lab);
      setup();
      await openAndScan(wc);
      const model = conflictsModelForTest()!;
      const row = model.rows().find((candidate) => candidate.path === 'tree-del.txt');
      expect(row?.record?.kinds).toEqual(['tree']);
      await selectPath('tree-del.txt');
      await sendIntent({ kind: 'applyConflictResolution' });
      expect(stillConflicted(wc, 'tree-del.txt')).toBe(true);
      expect(conflictsSessionSnapshot().ledger).toBe(0);

      await sendIntent({ kind: 'prepareTreeConflict' });
      expect(conflictsSessionSnapshot().pendingConfirm?.kind).toBe('tree');
      await confirmBanner('conflictTreeConfirm', 'confirmTreePrepared');
      expect(conflictsSessionSnapshot().pendingConfirm).toBeUndefined();
      expect(model.isTreePrepared(row!.key)).toBe(true);

      await apply();
      expect(stillConflicted(wc, 'tree-del.txt')).toBe(false);
      // working 保留本地内容（add-with-history）。
      expect(readText(wc, 'tree-del.txt')).toBe('tree local edit\n');
      expect(conflictsSessionSnapshot().ledger).toBe(1);
    } finally {
      lab.cleanup();
    }
  });

  it('外部客户端先解决：旧计划被命令前指纹重读拒绝，不写台账', async () => {
    const lab = createSvnLab('svn-anywhere-resolve-external-');
    try {
      const wc = buildTextConflict(lab);
      setup();
      await openAndScan(wc);
      // 面板扫描后，外部客户端直接解决同一冲突。
      execSvn(['resolve', '--non-interactive', '--accept', 'theirs-full', '--depth', 'empty', '--', 'text.txt'], wc);
      expect(stillConflicted(wc, 'text.txt')).toBe(false);
      await selectPath('text.txt');
      await chooseVariant('mine-full');
      await apply();
      // 旧计划不执行：内容保持 theirs；台账不写已解决（未由本面板回扫确认）。
      expect(readText(wc, 'text.txt')).toBe('line1-theirs\nline2\nline3\n');
      expect(conflictsSessionSnapshot().ledger).toBe(0);
      // 冲突已不存在于真实扫描：记录被标记待核实（不冒充已解决）。
      const model = conflictsModelForTest()!;
      expect(model.rows().length).toBe(1);
      expect(conflictsSessionSnapshot().unknown).toBe(1);
      expect(conflictsSessionSnapshot().resolveNotice).toBeDefined();
    } finally {
      lab.cleanup();
    }
  });

  it('操作记录固定意图：begin 写入路径/冲突类型/指纹/策略，成功 done 后移除', async () => {
    const lab = createSvnLab('svn-anywhere-resolve-record-');
    try {
      const wc = buildTextConflict(lab);
      setup();
      const saved: Array<Record<string, unknown>> = [];
      // 用带存储的注册表捕获 begin/finish 记录（验证固定意图字段）。
      setOperationRegistryForTest(new OperationRegistry({
        load: () => [],
        save: (record) => {
          saved.push(JSON.parse(JSON.stringify(record)) as Record<string, unknown>);
        },
        remove: () => undefined,
      }));
      await openAndScan(wc);
      await selectPath('text.txt');
      await chooseVariant('theirs-full');
      await apply();
      const resolved = saved.filter((record) => record.kind === 'resolve');
      expect(resolved.length).toBeGreaterThan(0);
      const beginRecord = resolved[0];
      expect(beginRecord.phase === 'prepared' || beginRecord.phase === 'running').toBe(true);
      const intent = beginRecord.resolveIntent as {
        scopeRoot: string;
        targets: Array<{ relPath: string; conflictKinds: string[]; fingerprint: string; strategy: string }>;
      };
      expect(intent.scopeRoot).toBe(wc);
      expect(intent.targets[0]).toMatchObject({
        relPath: 'text.txt',
        conflictKinds: ['text'],
        strategy: 'theirs-full',
      });
      expect(typeof intent.targets[0].fingerprint).toBe('string');
      // 不保存属性原值/文件内容/凭据。
      const serialized = JSON.stringify(intent);
      expect(serialized).not.toContain('line1');
      expect(serialized).not.toContain('strategy-local');
    } finally {
      lab.cleanup();
    }
  });

  it('控制器文案默认值与 i18n.conflictPanel 键值一致（全部按键走 i18n）', () => {
    const table = strings.conflictPanel as unknown as Record<string, string | undefined>;
    for (const [key, value] of Object.entries(CONTROL_TEXT_DEFAULTS)) {
      expect(table[key], key).toBe(value);
    }
  });
});
