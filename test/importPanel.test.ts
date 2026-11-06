/**
 * P3 导入面板控制器（panels/checkout.ts 的 mode='import' 侧）flow 测试：
 * mock vscode（面板替身/globalState/确认框/凭据输入框）与 core svn 命令层，
 * 源目录用真实文件系统（枚举器/快照 digest 走真实实现），从面板意图驱动：
 * - 源预检分支（versioned 拒绝 / unversioned 放行 / svnMissing 阻止）；
 * - 连接检查（先父 info 后目标 ls）：父 kind≠dir / existing / auth 补录
 *   （成功带凭据重试、取消终止）/ connectError / 通过自动进 review 装载预览；
 * - 范围预览：global-ignores 解析失败阻止勾选确认与开始、修复后重新预览恢复；
 * - 三次快照比对（review 进入/点开始/确认后追加）与 sourceChanged 出口
 *   （任务对象不残留、busy 恢复、草稿写回、重新预览与再勾选可用）；
 * - 确认后重检 targetChanged 与网络失败分列（后者 review.error 横幅清确认
 *   保留参数、不进 result 失败页）；
 * - 双确认（空说明二次确认 + 仓库提交确认）与 Esc 不发起（confirmAborted
 *   出口：任务移除、草稿写回、无记录、无命令）；
 * - startImport 全链（importIntent 落盘断言、import 命令形态、成功页与
 *   URL 历史共用）；
 * - 证据三分类结果页（success / merged / 证据不可得 unknown）；
 * - verifyImport 三结论 + 代次守卫丢弃 + snapshotIncomplete 页 + abandon
 *   收口（回表单两层回填 + 记录收口）；
 * - acknowledgeMerged settled（递增先行、记录收口、settled 动作集）；
 * - retryImport 回填两层（会话 form 优先 / 重启形态按结果页 formSnapshot）；
 * - handoff 草稿键（源目录 + checkout）与关闭重开回填；
 * - 重启 unknown 记录恢复与冻结（writeLocked 呈现、核实入口可用）；
 * - 「重开先等出口」送达（确认框停留窗口关闭重开 → 出口完成 → 落草稿 form 步）。
 */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { SvnError } from '../src/core/errors';
import {
  OperationRegistry,
  getOperationRegistry,
  resetRunningOperationsForTest,
  setOperationRegistryForTest,
  type OperationRecord,
  type OperationStore,
} from '../src/core/operations';
import { runOrThrow, type RunOptions, type RunResult } from '../src/core/svnCli';
import { readSvnConfigGlobalIgnores } from '../src/core/svnConfig';
import { resetResultEpochs, getResultEpoch, bumpResultEpoch } from '../src/host/resultEpoch';
import { readSessionResult, resetSessionResults, writeSessionResult } from '../src/host/sessionResults';
import { getActiveTask, resetTaskRegistry } from '../src/host/taskRegistry';
import { resetPanelRegistry } from '../src/host/panel/host';
import { resetOutputState } from '../src/host/output';
import { setDraftStorage, readDraft } from '../src/host/panel/drafts';
import { strings } from '../src/host/i18n';
import {
  openCheckoutPanel,
  resetCheckoutPanelController,
  setCheckoutPanelContext,
} from '../src/host/panel/panels/checkout';

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
    createOutputChannel: () => ({
      lines: [] as string[],
      shown: 0,
      appendLine(line: string) {
        (this as { lines: string[] }).lines.push(line);
      },
      show() {
        (this as { shown: number }).shown += 1;
      },
      dispose() {},
    }),
    showInformationMessage: (message: string) => {
      vscodeMock.information.push(message);
      return Promise.resolve(undefined);
    },
    showWarningMessage: (message: string, _options?: unknown, ...items: string[]) => {
      vscodeMock.warning.push(message);
      if (vscodeMock.confirmImpl && items.length < 3) {
        return vscodeMock.confirmImpl(message);
      }
      return Promise.resolve(vscodeMock.confirmResult);
    },
    showErrorMessage: (message: string) => {
      vscodeMock.errorMessages.push(message);
      return Promise.resolve(undefined);
    },
    showOpenDialog: () => Promise.resolve(vscodeMock.openDialogResult),
    showInputBox: () => Promise.resolve(vscodeMock.inputBoxQueue.shift()),
    showQuickPick: () => Promise.resolve(undefined),
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
    get workspaceFolders() {
      return vscodeMock.workspaceFolders;
    },
    updateWorkspaceFolders: () => true,
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

vi.mock('../src/core/svnCli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/svnCli')>();
  return { ...actual, runOrThrow: vi.fn() };
});

vi.mock('../src/core/svnConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/svnConfig')>();
  return { ...actual, readSvnConfigGlobalIgnores: vi.fn() };
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
  confirmResult: undefined as string | undefined,
  confirmImpl: undefined as ((message: string) => Promise<string | undefined>) | undefined,
  openDialogResult: undefined as Array<{ fsPath: string }> | undefined,
  inputBoxQueue: [] as Array<string | undefined>,
  config: {} as Record<string, unknown>,
  executedCommands: [] as unknown[][],
  globalState: new Map<string, unknown>(),
  workspaceFolders: [] as Array<{ uri: { toString(): string } }>,
}));

/* ------------------------------ 测试夹具 ------------------------------ */

const REPO_URL = 'file:///tmp/repo';
const PARENT_URL = `${REPO_URL}/trunk`;
const TARGET_URL = `${PARENT_URL}/src`;
const UUID = 'uuid-1';

let store: OperationStore & { records: Map<string, OperationRecord>; savedRecords: OperationRecord[] };
let globalStateMap: Map<string, unknown>;
let labRoot: string;

function makeMemoryStore(): OperationStore & { records: Map<string, OperationRecord>; savedRecords: OperationRecord[] } {
  const records = new Map<string, OperationRecord>();
  const savedRecords: OperationRecord[] = [];
  return {
    records,
    savedRecords,
    load: () => [...records.values()],
    async save(record) {
      records.set(record.operationId, record);
      savedRecords.push(record);
    },
    async remove(operationId) {
      records.delete(operationId);
    },
  };
}

/** runOrThrow mock：记录调用并分发到当前 handler。 */
const runCalls: Array<{ args: string[]; options: RunOptions }> = [];
function mockRun(handler: (args: string[], options: RunOptions) => Promise<RunResult>): void {
  runCalls.length = 0;
  vi.mocked(runOrThrow).mockImplementation(async (_svnPath: string, args: string[], options: RunOptions = {}) => {
    runCalls.push({ args, options });
    const result = await handler(args, options);
    if (result.stdout !== '' && options.onStdoutChunk) {
      // 模拟流式输出：导入执行器的进度/尾行解析依赖 onStdoutChunk 喂数。
      options.onStdoutChunk(Buffer.from(result.stdout, 'utf8'));
    }
    return result;
  });
}

const okRun = (stdout = ''): RunResult => ({ stdout, stderr: '', exitCode: 0 });

const svnErr = (message: string, stderr: string, code = 'SVN_ERROR'): SvnError =>
  new SvnError({ message, command: [], stderr, code });

const AUTH_ERR = (): SvnError => svnErr('认证失败', 'svn: E170001: Authentication required');
const NOT_FOUND_ERR = (): SvnError => svnErr('目标不存在', 'svn: E200009: Url not found');

const PARENT_XML = (revision = 3, kind = 'dir'): string =>
  `<?xml version="1.0"?><info><entry kind="${kind}" path="." url="${PARENT_URL}">` +
  `<commit revision="${revision}"/><repository><root>${REPO_URL}</root><uuid>${UUID}</uuid></repository></entry></info>`;

/** 源目录夹具：真实文件系统（枚举与快照 digest 走真实实现）。 */
function makeSourceDir(name: string, files: Array<[string, string]> = [['a.txt', 'a'], ['sub/b.txt', 'b']]): string {
  const dir = join(labRoot, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of files) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function lastPanel(): FakePanel {
  const panel = vscodeMock.panels.at(-1);
  if (!panel) {
    throw new Error('面板未创建');
  }
  return panel;
}

function lastHtml(panel: FakePanel): string {
  const frames = panel.posted
    .filter((message) => message.type === 'render')
    .map((message) => String((message as { html?: string }).html ?? ''));
  return frames.at(-1) ?? '';
}

function toastMessages(panel: FakePanel): string[] {
  return panel.posted
    .filter((message) => message.type === 'toast')
    .map((message) => String(message.message ?? ''));
}

let intentSeq = 0;
function send(panel: FakePanel, intent: Record<string, unknown>): void {
  intentSeq += 1;
  panel.sendIntent(intent, `req-${intentSeq}`);
}

/** 打开导入面板（入口 = 源目录 realpath）。 */
async function openImportPanel(sourceDir: string): Promise<FakePanel> {
  await openCheckoutPanel({ entryKey: sourceDir, mode: 'import', sourceDir });
  await sleep(0);
  return lastPanel();
}

/** 填目标 URL → 下一步（连接检查通过）→ 自动进 review 并装载预览。 */
async function fillToReview(panel: FakePanel, sourceDir: string, url = TARGET_URL): Promise<void> {
  send(panel, { kind: 'syncInput', fieldId: 'url', value: url, inputRevision: 1 });
  await sleep(0);
  send(panel, { kind: 'importNext' });
  await sleep(30);
  expect(lastHtml(panel)).toContain(strings.checkoutPanel.stepReview);
  expect(lastHtml(panel)).toContain(strings.checkoutPanel.reviewCheckedLabel);
}

/** 勾选范围确认（预览已装载、无阻止条件时置位）。 */
async function checkScope(panel: FakePanel): Promise<void> {
  send(panel, { kind: 'syncInput', fieldId: 'checked', value: 'true', inputRevision: 2 });
  await sleep(0);
}

/** 填写说明并勾选（startImport 前的统一准备——有说明可跳过空说明二次确认）。 */
async function armStart(panel: FakePanel, message = '导入说明'): Promise<void> {
  send(panel, { kind: 'syncInput', fieldId: 'message', value: message, inputRevision: 2 });
  await sleep(0);
  await checkScope(panel);
}

/** 连接检查（父 info dir + 目标 ls 不存在）+ 重检同款通过的统一 mock。 */
function mockConnOk(opts: { targetExists?: () => boolean; parentRevision?: number } = {}): void {
  const revision = opts.parentRevision ?? 3;
  mockRun(async (args) => {
    if (args[0] === 'info' && args[1] === '--xml') {
      return okRun(PARENT_XML(revision));
    }
    if (args[0] === 'ls') {
      if (opts.targetExists?.()) {
        return okRun('src/\n');
      }
      throw NOT_FOUND_ERR();
    }
    return okRun();
  });
}

beforeEach(async () => {
  vscodeMock.panels.length = 0;
  vscodeMock.information.length = 0;
  vscodeMock.warning.length = 0;
  vscodeMock.errorMessages.length = 0;
  vscodeMock.confirmResult = undefined;
  vscodeMock.confirmImpl = undefined;
  vscodeMock.openDialogResult = undefined;
  vscodeMock.inputBoxQueue.length = 0;
  vscodeMock.config = {};
  vscodeMock.executedCommands.length = 0;
  vscodeMock.workspaceFolders = [];
  vscodeMock.globalState.clear();
  resetCheckoutPanelController();
  resetPanelRegistry();
  resetTaskRegistry();
  resetSessionResults();
  resetResultEpochs();
  resetRunningOperationsForTest();
  resetOutputState();
  runCalls.length = 0;
  store = makeMemoryStore();
  const registry = new OperationRegistry(store);
  await registry.loadPending();
  setOperationRegistryForTest(registry);
  globalStateMap = new Map<string, unknown>();
  const memento = {
    get: <T>(key: string, defaultValue?: T) => (globalStateMap.has(key) ? (globalStateMap.get(key) as T) : defaultValue as T),
    update: (key: string, value: unknown) => {
      globalStateMap.set(key, value);
      return Promise.resolve();
    },
    keys: () => [...globalStateMap.keys()],
  };
  setDraftStorage(memento);
  setCheckoutPanelContext({
    extensionUri: { scheme: 'file', path: '/ext' } as unknown as vscode.Uri,
    subscriptions: [],
    globalState: memento,
  });
  vi.mocked(readSvnConfigGlobalIgnores).mockReturnValue([]);
  labRoot = realpathSync(mkdtempSync(join(tmpdir(), 'import-panel-')));
  mockConnOk();
});

afterEach(() => {
  rmSync(labRoot, { recursive: true, force: true });
});

describe('P3 导入面板 flow', () => {
  /* ------------------------------ 源预检 ------------------------------ */

  it('pickSourceDir：versioned 拒绝并提示改用提交功能；unversioned 放行回 untested', async () => {
    const src = makeSourceDir('versioned-src');
    mockRun(async (args) => {
      if (args[0] === 'info' && !args.includes('--xml')) {
        // 源目录 svn info 成功 → 已纳管/副本根。
        return okRun();
      }
      return okRun();
    });
    vscodeMock.openDialogResult = [{ fsPath: src }];
    const panel = await openImportPanel(join(labRoot, 'entry'));
    send(panel, { kind: 'pickSourceDir' });
    await sleep(20);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.sourceVersionedNotice);
    expect(lastHtml(panel)).toContain(src);

    // 换成未纳管目录（E200009 副本内未纳管 → 放行）。
    const unversioned = makeSourceDir('unversioned-src');
    mockRun(async (args) => {
      if (args[0] === 'info' && !args.includes('--xml')) {
        throw NOT_FOUND_ERR();
      }
      return okRun();
    });
    vscodeMock.openDialogResult = [{ fsPath: unversioned }];
    send(panel, { kind: 'pickSourceDir' });
    await sleep(20);
    const html = lastHtml(panel);
    expect(html).toContain(unversioned);
    expect(html).not.toContain(strings.checkoutPanel.sourceVersionedNotice);
  });

  it('pickSourceDir：svn 可执行缺失（ENOENT）按「未纳管未被证明」阻止', async () => {
    const src = makeSourceDir('enoent-src');
    mockRun(async () => {
      throw svnErr('spawn enoent', '', 'ENOENT');
    });
    vscodeMock.openDialogResult = [{ fsPath: src }];
    const panel = await openImportPanel(join(labRoot, 'entry'));
    send(panel, { kind: 'pickSourceDir' });
    await sleep(20);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.connErrorTitle);
    expect(runCalls.some(({ args }) => args[0] === 'info' && args.at(-1) === src)).toBe(true);
  });

  /* --------------------------- 连接检查（importNext） --------------------------- */

  it('连接检查通过：自动进 review 装载预览（真实枚举）并写入父身份初读', async () => {
    const src = makeSourceDir('conn-ok');
    const panel = await openImportPanel(src);
    await fillToReview(panel, src);
    const html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.previewStateWillImport);
    expect(html).toContain('a.txt');
    // 命令顺序固定：先父 info、后目标 ls。
    const kinds = runCalls.map(({ args }) => `${args[0]}${args[1] === '--xml' ? '-xml' : ''}`);
    expect(kinds).toEqual(['info-xml', 'ls']);
  });

  it('连接检查：父 kind≠dir 拒绝（父路径不是目录）、目标已存在 existing 阻止', async () => {
    const src = makeSourceDir('conn-kind');
    const panel = await openImportPanel(src);
    mockRun(async (args) => {
      if (args[0] === 'info' && args[1] === '--xml') {
        return okRun(PARENT_XML(3, 'file'));
      }
      return okRun();
    });
    send(panel, { kind: 'syncInput', fieldId: 'url', value: TARGET_URL, inputRevision: 1 });
    await sleep(0);
    send(panel, { kind: 'importNext' });
    await sleep(20);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.importParentNotDirNotice);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.stepForm);

    // 目标 ls exit 0 → existing。
    mockConnOk({ targetExists: () => true });
    send(panel, { kind: 'importNext' });
    await sleep(20);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.importTargetExistsNotice);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.stepForm);
  });

  it('连接检查：认证失败弹补录，成功带凭据重试、取消终止回 untested', async () => {
    const src = makeSourceDir('conn-auth');
    const panel = await openImportPanel(src);
    mockRun(async (args, options) => {
      if (args[0] === 'info' && args[1] === '--xml') {
        return okRun(PARENT_XML(3));
      }
      if (args[0] === 'ls') {
        if (options.getCredentials) {
          // 第二轮（已补录，凭据经 getCredentials 注入）：目标不存在（通过）。
          throw NOT_FOUND_ERR();
        }
        throw AUTH_ERR();
      }
      return okRun();
    });
    vscodeMock.inputBoxQueue.push('user', 'pass');
    send(panel, { kind: 'syncInput', fieldId: 'url', value: 'http://example.com/svn/trunk/src', inputRevision: 1 });
    await sleep(0);
    send(panel, { kind: 'importNext' });
    await sleep(30);
    // 补录成功：进入 review（带凭据重试后的 ls 判不存在通过）。
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.stepReview);
    const credentialed = runCalls.find(({ args, options }) => args[0] === 'ls' && options.getCredentials);
    expect(credentialed).toBeDefined();

    // 取消形态：新面板、认证失败、输入框队列空（取消）→ untested 终止。
    const src2 = makeSourceDir('conn-auth-cancel');
    panel.dispose();
    const panel2 = await openImportPanel(src2);
    mockRun(async (args) => {
      if (args[0] === 'ls') {
        throw AUTH_ERR();
      }
      return okRun(PARENT_XML(3));
    });
    send(panel2, { kind: 'syncInput', fieldId: 'url', value: 'http://example.com/svn/trunk/src', inputRevision: 1 });
    await sleep(0);
    send(panel2, { kind: 'importNext' });
    await sleep(30);
    const html2 = lastHtml(panel2);
    expect(html2).toContain(strings.checkoutPanel.stepForm);
    expect(html2).not.toContain(strings.checkoutPanel.importTargetExistsNotice);
  });

  it('连接检查：网络失败原文进 conn.error（表单页 error 横幅）', async () => {
    const src = makeSourceDir('conn-net');
    const panel = await openImportPanel(src);
    mockRun(async (args) => {
      if (args[0] === 'ls') {
        throw svnErr('E175002 连接超时', 'svn: E175002');
      }
      return okRun(PARENT_XML(3));
    });
    send(panel, { kind: 'syncInput', fieldId: 'url', value: TARGET_URL, inputRevision: 1 });
    await sleep(0);
    send(panel, { kind: 'importNext' });
    await sleep(20);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.connErrorTitle);
    expect(lastHtml(panel)).toContain('E175002');
  });

  /* ------------------------------ 范围预览 ------------------------------ */

  it('global-ignores 解析失败：预览提示并阻止勾选确认与开始；修复后重新预览恢复', async () => {
    const src = makeSourceDir('preview-config');
    vi.mocked(readSvnConfigGlobalIgnores).mockImplementation(() => {
      throw new Error('config broken');
    });
    const panel = await openImportPanel(src);
    send(panel, { kind: 'syncInput', fieldId: 'url', value: TARGET_URL, inputRevision: 1 });
    await sleep(0);
    send(panel, { kind: 'importNext' });
    await sleep(30);
    let html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.importPreviewIgnoreFailedNotice);
    // 勾选被拒（setChecked 守卫同源）。
    await checkScope(panel);
    html = lastHtml(panel);
    expect(html.match(/data-field-id="checked"[^>]*/)?.[0]).toContain('disabled');
    // 开始按钮禁用（未勾选不能开始）。
    expect(html.match(/data-intent="startImport"[^>]*/)?.[0]).toContain('disabled');

    // 修复配置后重新预览：预览装载、勾选可用。
    vi.mocked(readSvnConfigGlobalIgnores).mockReturnValue([]);
    send(panel, { kind: 'refreshImportPreview' });
    await sleep(20);
    html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.previewStateWillImport);
    await checkScope(panel);
    expect(lastHtml(panel).match(/data-field-id="checked"[^>]*/)?.[0]).not.toContain('disabled=true');
  });

  it('分页视图状态由宿主持有（setPage 回喂 importPreviewPage）', async () => {
    const files: Array<[string, string]> = [];
    for (let i = 0; i < 55; i += 1) {
      files.push([`f${String(i).padStart(2, '0')}.txt`, 'x']);
    }
    const src = makeSourceDir('preview-page', files);
    const panel = await openImportPanel(src);
    await fillToReview(panel, src);
    // 第 1 页含 f00；翻到第 2 页含 f54。
    expect(lastHtml(panel)).toContain('f00.txt');
    send(panel, { kind: 'setPage', page: 2 });
    await sleep(0);
    const html = lastHtml(panel);
    expect(html).toContain('f54.txt');
    expect(html).not.toContain('f00.txt');
  });

  it('排序/筛选视图状态由宿主持有回喂：点表头切排序、文本筛选大小写不敏感、组合重置页码', async () => {
    // 文件 i 的内容长度随 i 递增（字节值与文件名同序），供 size 数值排序断言。
    const files: Array<[string, string]> = [];
    for (let i = 0; i < 55; i += 1) {
      files.push([`f${String(i).padStart(2, '0')}.txt`, 'x'.repeat(i + 1)]);
    }
    const src = makeSourceDir('preview-view', files);
    const panel = await openImportPanel(src);
    await fillToReview(panel, src);
    // 1) 点 size 表头降序：首行变最大文件 f54（默认路径升序首行是 f00，
    //    降序后 f00 掉出第 1 页——首页为 f54..f05）。
    send(panel, { kind: 'setSort', key: 'size', direction: 'desc' });
    await sleep(0);
    let html = lastHtml(panel);
    expect(html.indexOf('f54.txt')).toBeLessThan(html.indexOf('f10.txt'));
    expect(html).not.toContain('f00.txt');
    expect(html).toContain('↓'); // 当前列降序指示
    // 2) 翻到第 2 页后输入筛选「F5」（大写）：大小写不敏感匹配 f50..f54，
    //    行集收敛为一页且页码重置回第 1 页（组合重置页码）。
    send(panel, { kind: 'setPage', page: 2 });
    await sleep(0);
    send(panel, { kind: 'setFilter', filterId: 'previewPath', value: 'F5' });
    await sleep(0);
    html = lastHtml(panel);
    expect(html).toContain('f50.txt');
    // 匹配收敛为一页（5 行）且页码已重置回第 1 页（单页不渲染翻页器）。
    expect(html.match(/<tr data-row-id/g)?.length).toBe(5);
    expect(html).not.toContain('f00.txt');
    // 3) state select 精确筛选（「将导入」）：与文本筛选叠加后仍只含 f5x 行。
    send(panel, { kind: 'setFilter', filterId: 'previewState', value: strings.checkoutPanel.previewStateWillImport });
    await sleep(0);
    html = lastHtml(panel);
    expect(html).toContain('f52.txt');
    expect(html).not.toContain('f00.txt');
  });

  /* --------------------------- 开始：三次比对与出口 --------------------------- */

  it('点开始时源快照比对失败（第二次）：scopeChanged 清勾选、不发起、无任务对象', async () => {
    const src = makeSourceDir('scope-second');
    const panel = await openImportPanel(src);
    await fillToReview(panel, src);
    send(panel, { kind: 'syncInput', fieldId: 'message', value: '说明', inputRevision: 2 });
    await sleep(0);
    await checkScope(panel);
    // 点开始前向源目录新增文件 → 第二次比对 digest 不一致。
    writeFileSync(join(src, 'new.txt'), 'n');
    send(panel, { kind: 'startImport' });
    await sleep(30);
    const html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.importScopeChangedNotice);
    expect(getActiveTask('checkout')).toBeUndefined();
    expect(runCalls.some(({ args }) => args[0] === 'import')).toBe(false);
  });

  it('确认通过后第三次比对失败（sourceChanged）：任务对象移除、busy 恢复、草稿写回、重新预览后可再勾选', async () => {
    const src = makeSourceDir('scope-third');
    const panel = await openImportPanel(src);
    await fillToReview(panel, src);
    await armStart(panel);
    // 确认框打开期间向源目录新增文件（确认通过后、写命令前的第三次比对发现）。
    vscodeMock.confirmImpl = async (message: string) => {
      if (message === strings.checkoutPanel.importCommitConfirmTitle) {
        writeFileSync(join(src, 'late.txt'), 'late');
        return strings.checkoutPanel.importCommitConfirmButton;
      }
      return vscodeMock.confirmResult;
    };
    send(panel, { kind: 'startImport' });
    await sleep(40);
    const html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.importScopeChangedNotice);
    // 预命令出口：任务对象不残留、busy 恢复假值。
    expect(getActiveTask('checkout')).toBeUndefined();
    expect(runCalls.some(({ args }) => args[0] === 'import')).toBe(false);
    expect(store.records.size).toBe(0);
    // 草稿写回（哑任务捕获的表单快照）。
    const draft = readDraft(realpathSync(src), 'import');
    expect(draft?.url).toBe(TARGET_URL);
    // 重新预览 → 装载新快照（含 late.txt）→ 可再勾选。
    send(panel, { kind: 'refreshImportPreview' });
    await sleep(20);
    expect(lastHtml(panel)).toContain('late.txt');
    await checkScope(panel);
    expect(lastHtml(panel).match(/data-field-id="checked"[^>]*/)?.[0]).not.toContain('disabled=true');
  });

  it('确认后重检 targetChanged（目标已存在）：清勾选提示重新测试核对，不写记录不发起', async () => {
    const src = makeSourceDir('recheck-target');
    const panel = await openImportPanel(src);
    await fillToReview(panel, src);
    await armStart(panel);
    // 确认通过后目标被外部创建（重检 ls exit 0）。
    mockConnOk({ targetExists: () => true });
    vscodeMock.confirmResult = strings.checkoutPanel.importCommitConfirmButton;
    send(panel, { kind: 'startImport' });
    await sleep(40);
    const html = lastHtml(panel);
    expect(html).toContain('远端目标已存在');
    expect(getActiveTask('checkout')).toBeUndefined();
    expect(runCalls.some(({ args }) => args[0] === 'import')).toBe(false);
    expect(store.records.size).toBe(0);
  });

  it('确认后重检网络失败：review.error 横幅、清确认保留参数、不进 result 失败页', async () => {
    const src = makeSourceDir('recheck-net');
    const panel = await openImportPanel(src);
    await fillToReview(panel, src);
    await armStart(panel);
    // 重检的目标 ls 网络失败（连接检查已通过、进入重检窗口后切换 mock）。
    mockRun(async (args) => {
      if (args[0] === 'info' && args[1] === '--xml') {
        return okRun(PARENT_XML(3));
      }
      if (args[0] === 'ls') {
        throw svnErr('E175002 网络中断', 'svn: E175002');
      }
      return okRun();
    });
    vscodeMock.confirmResult = strings.checkoutPanel.importCommitConfirmButton;
    send(panel, { kind: 'startImport' });
    await sleep(40);
    const html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.reviewErrorTitle);
    expect(html).toContain('E175002');
    // 清确认（勾选清回）+ 参数保留（核对页 URL 行仍在）。
    expect(html).toContain(strings.checkoutPanel.reviewUrl);
    expect(html).not.toContain(strings.checkoutPanel.importResultTitles.failed);
    expect(getActiveTask('checkout')).toBeUndefined();
    expect(store.records.size).toBe(0);
    // 重新勾选后可再点开始（未勾选期间开始禁用）。
    const startDisabled = html.match(/data-intent="startImport"[^>]*/)?.[0];
    expect(startDisabled).toContain('disabled');
  });

  /* ------------------------------ 双确认与 Esc ------------------------------ */

  it('空说明配置关闭时直接拒绝；开启时先空说明二次确认再仓库确认', async () => {
    const src = makeSourceDir('confirm-empty');
    vscodeMock.config = { allowEmptyCommitMessage: false };
    const panel = await openImportPanel(src);
    await fillToReview(panel, src);
    await checkScope(panel);
    send(panel, { kind: 'startImport' });
    await sleep(20);
    expect(toastMessages(panel)).toContain(strings.commit.emptyMessageRejected);
    expect(vscodeMock.warning).not.toContain(strings.checkoutPanel.importCommitConfirmTitle);

    // 重新打开（配置默认开启）：先弹空说明确认、再弹仓库确认。
    panel.dispose();
    vscodeMock.config = {};
    const panel2 = await openImportPanel(src);
    await fillToReview(panel2, src);
    await checkScope(panel2);
    vscodeMock.confirmImpl = async (message: string) => {
      if (message === strings.commit.emptyMessageConfirm) {
        return strings.commit.continueButton;
      }
      return strings.checkoutPanel.importCommitConfirmButton;
    };
    send(panel2, { kind: 'startImport' });
    await sleep(40);
    expect(vscodeMock.warning).toEqual([
      strings.commit.emptyMessageConfirm,
      strings.checkoutPanel.importCommitConfirmTitle,
    ]);
  });

  it('仓库提交确认框 Esc 不发起（confirmAborted 出口）：任务移除、草稿写回、无记录无命令、勾选保留', async () => {
    const src = makeSourceDir('confirm-esc');
    const panel = await openImportPanel(src);
    await fillToReview(panel, src);
    await armStart(panel, '导入说明');
    // Esc（确认框返回 undefined）。
    vscodeMock.confirmImpl = async (message: string) => {
      if (message === strings.checkoutPanel.importCommitConfirmTitle) {
        return undefined;
      }
      return vscodeMock.confirmResult;
    };
    send(panel, { kind: 'startImport' });
    await sleep(40);
    expect(getActiveTask('checkout')).toBeUndefined();
    expect(runCalls.some(({ args }) => args[0] === 'import')).toBe(false);
    expect(store.records.size).toBe(0);
    // 出口草稿写回（表单值不丢——review 页关闭重开可恢复）。
    const draft = readDraft(realpathSync(src), 'import');
    expect(draft?.url).toBe(TARGET_URL);
    expect(draft?.message).toBe('导入说明');
    // 勾选保留可再次点开始（确认后回到 review、scopeChanged 仍为 null）。
    const html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.stepReview);
    expect(html.match(/data-intent="startImport"[^>]*/)?.[0]).not.toContain('disabled=true');
  });

  it('「重开先等出口」送达：确认框停留窗口关闭重开 → 出口完成 → 重开会话落草稿 form 步', async () => {
    const src = makeSourceDir('reopen-wait');
    const panel = await openImportPanel(src);
    await fillToReview(panel, src);
    await armStart(panel);
    // 确认框挂起期间：关闭发起面板并立即重开（重开会话五段①绑定 connecting 哑任务、进度页）。
    vscodeMock.confirmImpl = async (message: string) => {
      if (message === strings.checkoutPanel.importCommitConfirmTitle) {
        panel.dispose();
        await openCheckoutPanel({ entryKey: realpathSync(src), mode: 'import', sourceDir: src });
        await sleep(10);
        // 此刻重开会话绑定哑任务：进度页呈现（busy）。
        const reopened = lastPanel();
        expect(lastHtml(reopened)).toContain(strings.checkoutPanel.progressTotalUnknown);
        return undefined; // Esc：出口完成（草稿写回 + 哑任务移除）。
      }
      return vscodeMock.confirmResult;
    };
    send(panel, { kind: 'startImport' });
    await sleep(120);
    // 任务移除通知送达重开会话：重跑恢复落第④段草稿的 form 步（不在进度页停留）。
    const reopened = lastPanel();
    const html = lastHtml(reopened);
    expect(html).toContain(strings.checkoutPanel.stepForm);
    expect(html).toContain(TARGET_URL);
    expect(html).not.toContain(strings.checkoutPanel.progressTotalUnknown);
  });

  /* ------------------------------ startImport 全链 ------------------------------ */

  it('startImport 全链：importIntent 落盘、import 命令形态、成功页与 URL 历史共用', async () => {
    const src = makeSourceDir('full-ok');
    const snapshotDir = join(labRoot, 'snap-full');
    mkdirSync(snapshotDir, { recursive: true });
    const { setImportSnapshotDir } = await import('../src/host/panel/importTask');
    setImportSnapshotDir(snapshotDir);
    const panel = await openImportPanel(src);
    await fillToReview(panel, src);
    await armStart(panel, '全链说明');
    // 连接检查 + 重检通过；import 成功 + 证据 A。
    mockRun(async (args) => {
      if (args[0] === 'info' && args[1] === '--xml') {
        return okRun(PARENT_XML(3));
      }
      if (args[0] === 'ls') {
        throw NOT_FOUND_ERR();
      }
      if (args[0] === 'import') {
        return okRun('Adding a.txt\nAdding sub\nAdding sub/b.txt\nTransmitting file data ....\nCommitted revision 7.\n');
      }
      if (args[0] === 'info' && args[1] === '--show-item' && args[2] === 'relative-url') {
        return okRun('^/trunk/src');
      }
      if (args[0] === 'log') {
        return okRun(
          `<?xml version="1.0"?><log><logentry revision="7"><msg>全链说明</msg>` +
            `<paths><path action="A" kind="dir">/trunk/src</path>` +
            `<path action="A" kind="file">/trunk/src/a.txt</path></paths></logentry></log>`,
        );
      }
      return okRun();
    });
    vscodeMock.confirmResult = strings.checkoutPanel.importCommitConfirmButton;
    send(panel, { kind: 'startImport' });
    await sleep(60);
    const html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.importResultTitles.success);
    expect(html).toContain('r7');
    // import 命令形态：--file 临时说明 + --encoding UTF-8 + 目标 URL 原样 + 源目录。
    const importCall = runCalls.find(({ args }) => args[0] === 'import');
    expect(importCall).toBeDefined();
    expect(importCall!.args).toContain('--encoding');
    expect(importCall!.args).toContain('UTF-8');
    expect(importCall!.args.at(-2)).toBe(src);
    expect(importCall!.args.at(-1)).toBe(TARGET_URL);
    // importIntent 落盘断言（begin 的 save 形态；成功后记录已 finish 移除）。
    const begun = store.savedRecords.find((record) => record.kind === 'import');
    expect(begun?.importIntent?.targetUrl).toBe(TARGET_URL);
    expect(begun?.importIntent?.message).toBe('全链说明');
    expect(begun?.importIntent?.parentIdentity?.repositoryUuid).toBe(UUID);
    expect(begun?.importIntent?.snapshotDigest).toBeTruthy();
    expect(begun?.targetPath).toBe(realpathSync(src));
    expect(store.records.size).toBe(0);
    // 成功页动作集 + URL 历史共用（成功时点）。
    expect(html).toContain('data-intent="handoffToCheckout"');
    expect(globalStateMap.get('svnAnywhere.checkoutUrlHistory')).toEqual([TARGET_URL]);
    // 成功后快照删除（storage 无 op- 文件）。
    expect(readdirSync(snapshotDir).some((name) => name.startsWith('op-'))).toBe(false);
    setImportSnapshotDir(undefined);
  });

  it('证据三分类：目标根非 A → merged 页（记录 unknown ∧ outcome=merged）；证据不可得 → 普通 unknown', async () => {
    const snapshotDir = join(labRoot, 'snap-evidence');
    mkdirSync(snapshotDir, { recursive: true });
    const { setImportSnapshotDir } = await import('../src/host/panel/importTask');
    setImportSnapshotDir(snapshotDir);
    const src = makeSourceDir('evidence-merged');
    const panel = await openImportPanel(src);
    await fillToReview(panel, src);
    await armStart(panel, 'm');
    mockRun(async (args) => {
      if (args[0] === 'info' && args[1] === '--xml') {
        return okRun(PARENT_XML(3));
      }
      if (args[0] === 'ls') {
        throw NOT_FOUND_ERR();
      }
      if (args[0] === 'import') {
        return okRun('Adding m.txt\nCommitted revision 9.\n');
      }
      if (args[0] === 'info' && args[1] === '--show-item') {
        return okRun('^/trunk/src');
      }
      // 目标已有既有子路径变更（目标根本身无 action=A）→ 合并形态。
      if (args[0] === 'log') {
        return okRun(
          `<?xml version="1.0"?><log><logentry revision="9"><msg>m</msg>` +
            `<paths><path action="M" kind="file">/trunk/src/other.txt</path></paths></logentry></log>`,
        );
      }
      return okRun();
    });
    vscodeMock.confirmResult = strings.checkoutPanel.importCommitConfirmButton;
    send(panel, { kind: 'startImport' });
    await sleep(60);
    let html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.importResultTitles.merged);
    expect(html).toContain('r9');
    const mergedRecord = [...store.records.values()].find((record) => record.kind === 'import');
    expect(mergedRecord?.phase).toBe('unknown');
    expect(mergedRecord?.outcome).toBe('merged');
    expect(mergedRecord?.resolvedRevision).toBe(9);
    expect(getActiveTask('checkout')).toBeUndefined();

    // 证据不可得（log 命令失败）→ 普通 unknown（不写 outcome、不显示合并提示）。
    panel.dispose();
    const src2 = makeSourceDir('evidence-unknown');
    const panel2 = await openImportPanel(src2);
    await fillToReview(panel2, src2, `${PARENT_URL}/src2`);
    await armStart(panel2, 'u');
    mockRun(async (args) => {
      if (args[0] === 'info' && args[1] === '--xml') {
        return okRun(PARENT_XML(3));
      }
      if (args[0] === 'ls') {
        throw NOT_FOUND_ERR();
      }
      if (args[0] === 'import') {
        return okRun('Adding u.txt\nCommitted revision 11.\n');
      }
      if (args[0] === 'info' && args[1] === '--show-item') {
        return okRun('^/trunk/src2');
      }
      if (args[0] === 'log') {
        throw svnErr('E175002 证据命令失败', 'svn: E175002');
      }
      return okRun();
    });
    send(panel2, { kind: 'startImport' });
    await sleep(60);
    html = lastHtml(panel2);
    expect(html).toContain(strings.checkoutPanel.importResultTitles.unknown);
    const unknownRecord = [...store.records.values()].find((record) => record.kind === 'import' && record.targetPath === realpathSync(src2));
    expect(unknownRecord?.phase).toBe('unknown');
    expect(unknownRecord?.outcome).toBeUndefined();
    // 证据不可得形态的快照保留（unknown 未终态）。
    expect(readdirSync(snapshotDir).some((name) => name.startsWith('op-'))).toBe(true);
    setImportSnapshotDir(undefined);
  });

  /* ------------------------------ verifyImport ------------------------------ */

  /** 预置 unknown 导入记录 + 快照文件（重启/未知形态的核实对象）。 */
  async function presetUnknownRecord(src: string, url: string, withSnapshot: boolean, merged = false): Promise<string> {
    const operationId = 'op-verify-1';
    const snapshotDir = join(labRoot, 'snapshots');
    mkdirSync(snapshotDir, { recursive: true });
    if (withSnapshot) {
      writeFileSync(
        join(snapshotDir, operationId),
        JSON.stringify({
          version: 1,
          entries: [
            { path: 'a.txt', kind: 'file', size: 1, mtimeMs: 1, ignored: false, unreadable: false, nested: false, unsupported: false },
            { path: 'sub', kind: 'dir', size: 0, mtimeMs: 1, ignored: false, unreadable: false, nested: false, unsupported: false },
            { path: 'sub/b.txt', kind: 'file', size: 1, mtimeMs: 1, ignored: false, unreadable: false, nested: false, unsupported: false },
          ],
          dirs: ['sub'],
        }),
      );
    }
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256')
      .update(JSON.stringify({
        version: 1,
        entries: [
          { path: 'a.txt', kind: 'file', size: 1, mtimeMs: 1, ignored: false, unreadable: false, nested: false, unsupported: false },
          { path: 'sub', kind: 'dir', size: 0, mtimeMs: 1, ignored: false, unreadable: false, nested: false, unsupported: false },
          { path: 'sub/b.txt', kind: 'file', size: 1, mtimeMs: 1, ignored: false, unreadable: false, nested: false, unsupported: false },
        ].sort((a, b) => (a.path < b.path ? -1 : 1)),
        dirs: ['sub'],
      }), 'utf8')
      .digest('hex');
    store.records.set(operationId, {
      operationId,
      wcRoot: src,
      lockKey: src,
      kind: 'import',
      targetRelPath: '.',
      nodeKind: 'dir',
      phase: 'unknown',
      knownRevisions: [],
      updatedAt: Date.now(),
      targetPath: src,
      importIntent: {
        targetUrl: url,
        parentIdentity: { repositoryUuid: UUID, repositoryRootUrl: REPO_URL, lastChangedRevision: 3 },
        message: '核实说明',
        nameMode: 'manual',
        messageHash: createHash('sha256').update(Buffer.from('核实说明', 'utf8')).digest('hex'),
        startedAt: 1,
        summary: { fileCount: 2, totalBytes: 2 },
        snapshotDigest: digest,
        fileRefs: operationId,
      },
    });
    if (merged) {
      store.records.get(operationId)!.phase = 'unknown';
      store.records.get(operationId)!.outcome = 'merged';
      store.records.get(operationId)!.resolvedRevision = 9;
    }
    await getOperationRegistry().loadPending();
    return snapshotDir;
  }

  it('verifyImport committed：成功页 + URL 历史共用（核实时点）+ 记录 finish + 快照删除', async () => {
    const src = realpathSync(makeSourceDir('verify-committed'));
    const snapshotDir = await presetUnknownRecord(src, TARGET_URL, true);
    const { setImportSnapshotDir } = await import('../src/host/panel/importTask');
    setImportSnapshotDir(snapshotDir);
    // 先经成功导入路径触发一次 URL 历史（证明共用去重），再核实第二时点。
    globalStateMap.set('svnAnywhere.checkoutUrlHistory', ['file:///other']);
    mockRun(async (args) => {
      if (args[0] === 'info' && args[1] === '--xml') {
        // 核实第 1/2 步的父目录身份读取（uuid/root/last-changed 与锚点一致）。
        return okRun(PARENT_XML(3));
      }
      if (args[0] === 'ls') {
        return okRun('a.txt\n');
      }
      if (args[0] === 'info' && args[1] === '--show-item' && args[2] === 'last-changed-revision') {
        return okRun('7');
      }
      if (args[0] === 'info' && args[1] === '--show-item' && args[2] === 'relative-url') {
        return okRun('^/trunk/src');
      }
      if (args[0] === 'log') {
        return okRun(
          `<?xml version="1.0"?><log><logentry revision="7"><msg>核实说明</msg>` +
            `<paths><path action="A" kind="dir">/trunk/src</path>` +
            `<path action="A" kind="file">/trunk/src/a.txt</path>` +
            `<path action="A" kind="file">/trunk/src/sub/b.txt</path>` +
            `<path action="A" kind="dir">/trunk/src/sub</path></paths></logentry></log>`,
        );
      }
      return okRun();
    });
    const panel = await openImportPanel(src);
    // ③段记录分诊恢复 unknown 核实页；冻结呈现（writeLocked：宿主拒绝写
    // 动作——syncInput 不在放行表）+ 核实入口可用（按钮非禁用）。
    let html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.importResultTitles.unknown);
    expect(html.match(/data-intent="verifyImport"[^>]*/)?.[0]).not.toContain('disabled');
    send(panel, { kind: 'syncInput', fieldId: 'url', value: 'file://x', inputRevision: 5 });
    await sleep(0);
    expect(toastMessages(panel).some((message) => message.includes(strings.panel.toastBusyRejected))).toBe(true);
    send(panel, { kind: 'verifyImport' });
    await sleep(40);
    html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.importResultTitles.success);
    expect(html).toContain('r7');
    // 记录 finish 移除 + 快照删除 + URL 历史共用（核实 committed 时点、去重置顶）。
    expect(store.records.size).toBe(0);
    expect(readdirSync(snapshotDir).some((name) => name.startsWith('op-'))).toBe(false);
    expect(globalStateMap.get('svnAnywhere.checkoutUrlHistory')).toEqual([TARGET_URL, 'file:///other']);
    setImportSnapshotDir(undefined);
  });

  it('verifyImport notCommitted：失败页（retryImport 可用）；快照不完整：unknown 页提供放弃出口并收口回表单', async () => {
    const src = realpathSync(makeSourceDir('verify-notcommitted'));
    const snapshotDir = await presetUnknownRecord(src, TARGET_URL, true);
    const { setImportSnapshotDir } = await import('../src/host/panel/importTask');
    setImportSnapshotDir(snapshotDir);
    mockRun(async (args) => {
      if (args[0] === 'ls') {
        throw NOT_FOUND_ERR();
      }
      if (args[0] === 'info' && args[1] === '--xml') {
        return okRun(PARENT_XML(3));
      }
      return okRun();
    });
    const panel = await openImportPanel(src);
    send(panel, { kind: 'verifyImport' });
    await sleep(40);
    let html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.importResultTitles.failed);
    expect(html).toContain('data-intent="retryImport"');
    // 核实结论页写缓存（关闭重开恢复结论页）。
    expect(readSessionResult('checkout', { entryKey: src, mode: 'import' })).toBeDefined();
    expect(store.records.size).toBe(0);
    setImportSnapshotDir(undefined);

    // 快照不完整：记录在、快照文件缺失 → unknown 页 snapshotIncomplete + 放弃出口。
    panel.dispose();
    const src2 = realpathSync(makeSourceDir('verify-incomplete'));
    const snapshotDir2 = await presetUnknownRecord(src2, `${PARENT_URL}/src2`, false);
    setImportSnapshotDir(snapshotDir2);
    mockRun(async () => okRun());
    const panel2 = await openImportPanel(src2);
    html = lastHtml(panel2);
    expect(html).toContain(strings.checkoutPanel.importResultTitles.unknown);
    send(panel2, { kind: 'verifyImport' });
    await sleep(40);
    html = lastHtml(panel2);
    expect(html).toContain(strings.checkoutPanel.importResultTitles.unknown);
    expect(html).toContain('data-intent="abandonUnknownImport"');
    // 确认放弃：记录收口 + 回表单保留表单值（两层回填——会话 form 空按快照回填）。
    vscodeMock.confirmResult = strings.checkoutPanel.abandonVerifyConfirmButton;
    send(panel2, { kind: 'abandonUnknownImport' });
    await sleep(40);
    html = lastHtml(panel2);
    expect(html).toContain(strings.checkoutPanel.stepForm);
    expect(html).toContain(`${PARENT_URL}/src2`);
    expect(html).toContain('核实说明');
    expect(store.records.size).toBe(0);
    setImportSnapshotDir(undefined);
  });

  it('verifyImport 代次守卫：核实进行中递增代次（冲突动作）→ 结论丢弃不写入不推送', async () => {
    const src = realpathSync(makeSourceDir('verify-epoch'));
    const snapshotDir = await presetUnknownRecord(src, TARGET_URL, true);
    const { setImportSnapshotDir } = await import('../src/host/panel/importTask');
    setImportSnapshotDir(snapshotDir);
    let releaseVerify!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseVerify = resolve;
    });
    mockRun(async (args) => {
      if (args[0] === 'ls') {
        return okRun('a.txt\n');
      }
      if (args[0] === 'info' && args[1] === '--show-item' && args[2] === 'last-changed-revision') {
        await gate; // 核实挂起：期间执行递增代次的冲突动作。
        return okRun('7');
      }
      if (args[0] === 'log') {
        return okRun(
          `<?xml version="1.0"?><log><logentry revision="7"><msg>核实说明</msg>` +
            `<paths><path action="A" kind="dir">/trunk/src</path></paths></logentry></log>`,
        );
      }
      return okRun();
    });
    const panel = await openImportPanel(src);
    send(panel, { kind: 'verifyImport' });
    await sleep(20);
    const epochBefore = getResultEpoch('checkout');
    bumpResultEpoch('checkout'); // 冲突动作（如 acknowledgeMerged 的递增）。
    releaseVerify();
    await sleep(40);
    // 迟到结论被守卫丢弃：页面保持 unknown、缓存仍是发起时的 unknown 镜像
    // （结论页未写入）、记录不动。
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.importResultTitles.unknown);
    const cached = readSessionResult('checkout', { entryKey: src, mode: 'import' });
    expect((cached?.page as { kind?: string })?.kind).toBe('unknown');
    expect([...store.records.values()].some((record) => record.phase === 'unknown')).toBe(true);
    expect(getResultEpoch('checkout')).toBe(epochBefore + 1);
    setImportSnapshotDir(undefined);
  });

  /* ------------------------------ acknowledgeMerged ------------------------------ */

  it('acknowledgeMerged：确认后递增先行、记录 done 收口、settled 动作集（新建/日志）', async () => {
    const src = realpathSync(makeSourceDir('ack-merged'));
    // merged 页经缓存恢复（merged 记录保持 unknown ∧ outcome=merged）。
    const snapshotDir = await presetUnknownRecord(src, TARGET_URL, true, true);
    const { setImportSnapshotDir } = await import('../src/host/panel/importTask');
    setImportSnapshotDir(snapshotDir);
    writeSessionResult('checkout', { entryKey: src, mode: 'import' }, {
      mode: 'import',
      kind: 'merged',
      revision: 9,
      path: src,
    }, 'executor');
    mockRun(async () => okRun());
    const panel = await openImportPanel(src);
    let html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.importResultTitles.merged);
    expect(html).toContain('data-intent="acknowledgeMerged"');
    vscodeMock.confirmResult = strings.checkoutPanel.ackMergedConfirmButton;
    const epochBefore = getResultEpoch('checkout');
    send(panel, { kind: 'acknowledgeMerged' });
    await sleep(40);
    expect(getResultEpoch('checkout')).toBe(epochBefore + 1);
    // 记录 done 终态收口（finish 移除）+ 快照删除 + settled 页动作集。
    expect(store.records.size).toBe(0);
    expect(readdirSync(snapshotDir).some((name) => name.startsWith('op-'))).toBe(false);
    html = lastHtml(panel);
    expect(html).not.toContain('data-intent="acknowledgeMerged"');
    expect(html).toContain('data-intent="newTask"');
    // settled 页写缓存（关闭重开恢复 settled 形态）。
    const cached = readSessionResult('checkout', { entryKey: src, mode: 'import' });
    expect((cached?.page as { settled?: boolean }).settled).toBe(true);
    setImportSnapshotDir(undefined);
  });

  /* ------------------------------ retryImport 两层回填 ------------------------------ */

  it('retryImport：会话 form 非空优先 form；重启形态按结果页 formSnapshot 回填', async () => {
    // 会话内形态：发起失败页后会话 form 仍在 → retry 保留会话值。
    const src = realpathSync(makeSourceDir('retry-session'));
    writeSessionResult('checkout', { entryKey: src, mode: 'import' }, {
      mode: 'import',
      kind: 'failed',
      path: src,
      evidence: 'command',
      formSnapshot: { url: TARGET_URL, sourceDir: src, message: '快照说明', nameMode: 'manual' },
    }, 'executor');
    mockRun(async () => okRun());
    const panel = await openImportPanel(src);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.importResultTitles.failed);
    // 会话内修改 URL（用户在结果页不可改——以会话 form 原值优先断言）。
    send(panel, { kind: 'retryImport' });
    await sleep(20);
    let html = lastHtml(panel);
    expect(html).toContain(strings.checkoutPanel.stepForm);
    expect(html).toContain(TARGET_URL);
    // 缓存清除 + 代次递增 + 草稿写回（当前入口键）。
    expect(readSessionResult('checkout', { entryKey: src, mode: 'import' })).toBeUndefined();
    expect(readDraft(src, 'import')?.url).toBe(TARGET_URL);

    // 重启形态：缓存带 formSnapshot、会话 form 为空（新建会话）→ 按快照回填。
    panel.dispose();
    const src2 = realpathSync(makeSourceDir('retry-restart'));
    writeSessionResult('checkout', { entryKey: src2, mode: 'import' }, {
      mode: 'import',
      kind: 'failed',
      path: src2,
      evidence: 'verified',
      formSnapshot: { url: `${PARENT_URL}/src2`, sourceDir: src2, message: '重启回填说明', nameMode: 'manual' },
    }, 'controller');
    const panel2 = await openImportPanel(src2);
    expect(lastHtml(panel2)).toContain(strings.checkoutPanel.importResultTitles.failed);
    send(panel2, { kind: 'retryImport' });
    await sleep(20);
    html = lastHtml(panel2);
    expect(html).toContain(strings.checkoutPanel.stepForm);
    expect(html).toContain(`${PARENT_URL}/src2`);
    expect(html).toContain('重启回填说明');
    expect(readDraft(src2, 'import')?.nameMode).toBe('manual');
  });

  /* ------------------------------ handoff 草稿键 ------------------------------ */

  it('handoffToCheckout：切模式保留 URL/revMode=number/revision，草稿写「源目录+checkout」键，重开回填', async () => {
    const src = realpathSync(makeSourceDir('handoff'));
    writeSessionResult('checkout', { entryKey: src, mode: 'import' }, {
      mode: 'import',
      kind: 'success',
      revision: 12,
      path: src,
      targetUrl: TARGET_URL,
    }, 'executor');
    mockRun(async () => okRun());
    const panel = await openImportPanel(src);
    expect(lastHtml(panel)).toContain(strings.checkoutPanel.importResultTitles.success);
    expect(lastHtml(panel)).toContain('data-intent="handoffToCheckout"');
    send(panel, { kind: 'handoffToCheckout' });
    await sleep(20);
    // 切换后表单直填（checkout 模式、URL/revMode='number'/revision）。
    let html = lastHtml(panel);
    expect(html).toContain(TARGET_URL);
    expect(html.match(/data-field-id="revMode"[\s\S]*?option value="number" selected/)).toBeTruthy();
    expect(html).toContain('12');
    // 草稿写「源目录 + checkout」键；import 键无残留。
    const draft = readDraft(src, 'checkout');
    expect(draft?.url).toBe(TARGET_URL);
    expect(draft?.revMode).toBe('number');
    expect(draft?.rev).toBe('12');
    expect(readDraft(src, 'import')).toBeUndefined();
    // 关闭重开（从源目录以 checkout 模式打开——该目录作为检出的父目录）：
    // 草稿恢复表单（URL/revMode/revision 回填）。
    panel.dispose();
    await openCheckoutPanel({ entryKey: src, mode: 'checkout', parentDir: src });
    await sleep(10);
    const reopened = lastPanel();
    html = lastHtml(reopened);
    expect(html).toContain(TARGET_URL);
    expect(html).toContain('12');
  });

  /* ------------------------------ 成功页动作 ------------------------------ */

  it('revealSourceDir 与 clearUrlHistory：Finder 打开源目录、清空共用历史', async () => {
    const src = realpathSync(makeSourceDir('actions'));
    writeSessionResult('checkout', { entryKey: src, mode: 'import' }, {
      mode: 'import',
      kind: 'success',
      revision: 5,
      path: src,
    }, 'executor');
    globalStateMap.set('svnAnywhere.checkoutUrlHistory', [TARGET_URL]);
    mockRun(async () => okRun());
    const panel = await openImportPanel(src);
    send(panel, { kind: 'revealSourceDir' });
    send(panel, { kind: 'clearUrlHistory' });
    await sleep(20);
    expect(vscodeMock.executedCommands.some(([command, arg]) => command === 'revealFileInOS' && (arg as { path: string }).path === src)).toBe(true);
    expect(globalStateMap.get('svnAnywhere.checkoutUrlHistory')).toEqual([]);
  });
});
