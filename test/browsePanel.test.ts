/**
 * P5 仓库浏览面板控制器（panels/browse.ts）flow 测试：mock vscode（面板
 * 替身/剪贴板/环境）、core/remoteBrowse 读原语与 readonlyContent /
 * commands/browse 的交接入口，从面板打开与意图驱动：
 * - 打开远端入口：入口 info 固定浏览 revision → 名称探测 → 常规目录
 *   XML 元数据 → 树 ready；只读面板不出现任何写命令；
 * - 两段式：超过阈值只用无元数据名称列表首屏，不调用 XML；元数据补全
 *   走单节点 info 并显示进度 banner；取消后旧回包不再写入；
 * - 意图路由：展开/选择分离、加载更多、复制原始 URL、打开远端文件、
 *   P6 历史交接、关闭面板；页脚 refresh 等价根刷新（读新 HEAD）；
 * - 错误：根 info 失败 → 错误 banner；节点 tooLarge → 行内终态与 banner，
 *   父级/兄弟不受影响；认证取消 → 认证错误终态；
 * - 旧会话回包丢弃：根刷新后旧节点读取回包不覆盖新树；
 * - 关闭重开恢复：第二次打开同一入口按存储的浏览 revision 先读 info。
 * 远端调用断言 `--non-interactive` 由 core 原语测试覆盖，本文件校验
 * controller 传入的 authScope 与 revision。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

/* ------------------------------ vscode 替身 ------------------------------ */

interface VscodeMockState {
  information: string[];
  warning: string[];
  errors: string[];
  clipboard: string[];
  openedExternal: string[];
  executedCommands: string[][];
  panels: FakePanel[];
  config: Record<string, unknown>;
}

const vscodeMock: VscodeMockState = {
  information: [],
  warning: [],
  errors: [],
  clipboard: [],
  openedExternal: [],
  executedCommands: [],
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
    showTextDocument: () => Promise.resolve(undefined),
    createWebviewPanel: (viewType: string, title: string) => {
      const panel = makeFakePanel(viewType, title);
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
    openExternal: (uri: { fsPath?: string; path?: string }) => {
      vscodeMock.openedExternal.push(uri.fsPath ?? uri.path ?? '');
      return Promise.resolve(true);
    },
  },
  commands: {
    executeCommand: async (command: string, ...args: unknown[]) => {
      vscodeMock.executedCommands.push([command, ...args.map(String)]);
      return undefined;
    },
  },
  ProgressLocation: { Notification: 15 },
}));

vi.mock('../src/core/remoteBrowse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/remoteBrowse')>();
  return {
    ...actual,
    readRemoteNode: vi.fn(),
    readRemoteDirectory: vi.fn(),
    readRemoteDirectoryNames: vi.fn(),
  };
});

vi.mock('../src/host/readonlyContent', () => ({
  openRemoteContent: vi.fn(),
}));

vi.mock('../src/host/commands/browse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/commands/browse')>();
  return { ...actual, openHistoryFromNode: vi.fn() };
});

import {
  readRemoteDirectory,
  readRemoteDirectoryNames,
  readRemoteNode,
  type BrowseDirectoryListing,
  type BrowseDirectoryNames,
  type RepoNodeRef,
} from '../src/core/remoteBrowse';
import { openHistoryFromNode } from '../src/host/commands/browse';
import { openRemoteContent } from '../src/host/readonlyContent';
import { resetPanelRegistry } from '../src/host/panel/host';
import { resetM4SessionStore } from '../src/host/sessionResults';
import { resetOutputState } from '../src/host/output';
import {
  browseSessionSnapshot,
  openBrowsePanel,
  resetBrowsePanelController,
  setBrowsePanelContext,
} from '../src/host/panel/panels/browse';

/* ------------------------------ 面板替身 ------------------------------ */

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
  latestRenderHtml(): string;
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

/* ------------------------------ fixture ------------------------------ */

const ROOT_URL = 'https://example.com/repo/trunk';

function rootRef(overrides: Partial<RepoNodeRef> = {}): RepoNodeRef {
  return {
    repositoryUuid: 'uuid-1',
    repositoryRootUrl: 'https://example.com/repo',
    rawUrl: ROOT_URL,
    relativePath: 'trunk',
    snapshotRevision: 42,
    lastChangedRevision: 40,
    lastChangedAuthor: 'alice',
    lastChangedDate: '2026-11-01T10:00:00Z',
    kind: 'dir',
    ...overrides,
  };
}

function fileRef(name: string): RepoNodeRef {
  return {
    ...rootRef(),
    rawUrl: `${ROOT_URL}/${encodeURIComponent(name)}`,
    relativePath: `trunk/${name}`,
    kind: 'file',
    lastChangedRevision: 41,
  };
}

function namesOf(entries: Array<{ name: string; kind?: 'dir' | 'file' }>, total = entries.length): BrowseDirectoryNames {
  return {
    entries: entries.map((entry) => ({ name: entry.name, kind: entry.kind ?? 'file' })),
    total,
    bytes: 100,
  };
}

function listingOf(entries: Array<{ name: string; kind?: 'dir' | 'file' }>): BrowseDirectoryListing {
  return {
    listPath: `${ROOT_URL}/`,
    entries: entries.map((entry) => ({
      name: entry.name,
      kind: entry.kind ?? 'file',
      lastChangedRevision: 10,
      lastChangedAuthor: 'bob',
      lastChangedDate: '2026-11-01T09:00:00Z',
      ...(entry.kind === 'dir' ? {} : { sizeBytes: 12 }),
    })),
    total: entries.length,
    xmlBytes: 1000,
  };
}

function present(node: RepoNodeRef, sizeBytes?: number): { status: 'present'; node: RepoNodeRef; sizeBytes?: number } {
  return sizeBytes !== undefined ? { status: 'present', node, sizeBytes } : { status: 'present', node };
}

function fakePanel(): FakePanel {
  const panel = vscodeMock.panels[vscodeMock.panels.length - 1];
  expect(panel).toBeDefined();
  return panel;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(check: () => boolean, attempts = 50): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBe(true);
}

/** 从 HTML 提取某意图按钮的 data-node-id 列表（树行按渲染顺序）。 */
function nodeIdsOf(html: string, intent: string): string[] {
  // 同一按钮标签内 data-intent 与 data-node-id 之间可能还有 data-detail-action
  // 等绑定参数（详情动作），限制在单个标签内匹配。
  const pattern = new RegExp(`data-intent="${intent}"[^>]*data-node-id="([^"]*)"`, 'g');
  return [...html.matchAll(pattern)].map((match) => match[1]);
}

/** 树行按渲染顺序：根在前，展开目录的子行随后。 */
function nodeIdOf(html: string, intent: string, index = 0): string | undefined {
  return nodeIdsOf(html, intent)[index];
}

/* ------------------------------ 用例环境 ------------------------------ */

beforeEach(() => {
  resetPanelRegistry();
  resetBrowsePanelController();
  resetM4SessionStore();
  resetOutputState();
  vscodeMock.information.length = 0;
  vscodeMock.warning.length = 0;
  vscodeMock.errors.length = 0;
  vscodeMock.clipboard.length = 0;
  vscodeMock.openedExternal.length = 0;
  vscodeMock.executedCommands.length = 0;
  vscodeMock.panels.length = 0;
  vscodeMock.config = {};
  vi.mocked(readRemoteNode).mockReset();
  vi.mocked(readRemoteDirectory).mockReset();
  vi.mocked(readRemoteDirectoryNames).mockReset();
  vi.mocked(openRemoteContent).mockReset();
  vi.mocked(openHistoryFromNode).mockReset();
  setBrowsePanelContext({
    extensionUri: { scheme: 'file', path: '/extension' } as unknown as vscode.Uri,
    subscriptions: [],
  });
});

afterEach(() => {
  resetBrowsePanelController();
  resetPanelRegistry();
});

/** 常规目录（≤5,000）：入口 info + names 探测 + XML 元数据。 */
async function openRegularDir(entries: Array<{ name: string; kind?: 'dir' | 'file' }>): Promise<FakePanel> {
  vi.mocked(readRemoteNode).mockResolvedValue(present(rootRef()));
  vi.mocked(readRemoteDirectoryNames).mockResolvedValue({ status: 'ready', listing: namesOf(entries) });
  vi.mocked(readRemoteDirectory).mockResolvedValue({ status: 'ready', listing: listingOf(entries) });
  await openBrowsePanel({ source: 'remote', url: ROOT_URL });
  await waitFor(() => fakePanel().latestRenderHtml().includes('data-intent="selectBrowserNode"'));
  return fakePanel();
}

/* ------------------------------ 打开 ------------------------------ */

describe('打开仓库面板', () => {
  it('远端入口：入口 info 固定浏览 revision，名称探测后常规目录一次性 XML 上屏', async () => {
    const panel = await openRegularDir([{ name: 'docs', kind: 'dir' }, { name: 'a.txt' }]);
    const html = panel.latestRenderHtml();
    expect(html).toContain('仓库浏览');
    expect(html).toContain('浏览 revision r42');
    expect(html).toContain('>trunk<');
    expect(html).toContain('>docs<');
    expect(html).toContain('>a.txt<');
    // 根 info 请求带 --non-interactive 与 authScope 由 core 覆盖；控制器
    // 至少要对 https 目标声明 authScope。
    const infoCall = vi.mocked(readRemoteNode).mock.calls[0];
    expect(infoCall?.[0]).toBe('svn');
    expect(infoCall?.[1]).toBe(ROOT_URL);
    const options = infoCall?.[2] as
      | { authScope?: { scheme: string }; getCredentials?: unknown }
      | undefined;
    expect(options?.authScope?.scheme).toBe('https');
    expect(options?.getCredentials).toBeTypeOf('function');
    // 名称列表与 XML 各一次（常规目录行为不变）。
    expect(vi.mocked(readRemoteDirectoryNames)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(readRemoteDirectory)).toHaveBeenCalledTimes(1);
    const snapshot = browseSessionSnapshot();
    expect(snapshot).toMatchObject({ rootPhase: 'ready', snapshotRevision: 42 });
  });

  it('大目录两段式：超过阈值只读无元数据名称列表，不发 XML；元数据补全走单节点 info', async () => {
    const bigEntries = Array.from({ length: 6000 }, (_, index) => ({
      name: `file-${String(index).padStart(5, '0')}.txt`,
    }));
    vi.mocked(readRemoteNode).mockImplementation(async (_svn, url) => {
      // 入口 info 与补全 info 都返回 present；补全目标为根目录下的条目。
      if (url === ROOT_URL) {
        return present(rootRef());
      }
      const name = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
      return present(fileRef(name), 12);
    });
    vi.mocked(readRemoteDirectoryNames).mockResolvedValue({
      status: 'ready',
      listing: namesOf(bigEntries, 6000),
    });
    await openBrowsePanel({ source: 'remote', url: ROOT_URL });
    await waitFor(() => fakePanel().latestRenderHtml().includes('>file-00000.txt<'));
    const html = fakePanel().latestRenderHtml();
    // 首屏只含首批 40 行；总数显示精确值。
    expect(html).toContain('已读取 6000 / 总计 6000');
    // 根行 + 首批 40 个子行。
    expect((html.match(/data-intent="selectBrowserNode"/g) ?? []).length).toBe(41);
    expect(vi.mocked(readRemoteDirectory)).not.toHaveBeenCalled();
    // 元数据补全 banner 与单节点 info 调用（每片 4 并发 × 批次）。
    await waitFor(() => vi.mocked(readRemoteNode).mock.calls.length > 1);
    expect(vi.mocked(readRemoteNode).mock.calls.length).toBeGreaterThan(1);
    const firstInfo = vi.mocked(readRemoteNode).mock.calls[0];
    expect(firstInfo?.[1]).toBe(ROOT_URL);
    // 补全 info 携带浏览快照 revision。
    const completionCall = vi.mocked(readRemoteNode).mock.calls.find((call) => call[1] !== ROOT_URL);
    expect(completionCall).toBeDefined();
    expect((completionCall?.[2] as { revision?: number }).revision).toBe(42);
  });

  it('文件入口：不读取目录，直接选中并显示文件详情', async () => {
    const fileUrl = `${ROOT_URL}/a.txt`;
    vi.mocked(readRemoteNode).mockResolvedValue(present(fileRef('a.txt'), 21));
    await openBrowsePanel({ source: 'remote', url: fileUrl });
    await waitFor(() => browseSessionSnapshot().rootPhase === 'ready');
    const html = fakePanel().latestRenderHtml();
    expect(html).toContain('节点 URL');
    expect(browseSessionSnapshot().selectedKey).toBe(fileUrl);
    expect(vi.mocked(readRemoteDirectoryNames)).not.toHaveBeenCalled();
    // 文件详情动作含打开远端文件。
    expect(html).toContain('data-intent="openRemoteNode"');
  });

  it('本地入口复用同一打开器：目标 URL 已由命令层解析，面板不再读工作副本', async () => {
    vi.mocked(readRemoteNode).mockResolvedValue(present(rootRef()));
    vi.mocked(readRemoteDirectoryNames).mockResolvedValue({ status: 'ready', listing: namesOf([{ name: 'a.txt' }]) });
    vi.mocked(readRemoteDirectory).mockResolvedValue({ status: 'ready', listing: listingOf([{ name: 'a.txt' }]) });
    await openBrowsePanel({
      source: 'local',
      wcRoot: '/work',
      localPath: '/work/trunk',
      url: ROOT_URL,
      repositoryRootUrl: 'https://example.com/repo',
      repositoryUuid: 'uuid-1',
      kind: 'dir',
    });
    await waitFor(() => browseSessionSnapshot().rootPhase === 'ready');
    expect(vi.mocked(readRemoteNode).mock.calls[0]?.[1]).toBe(ROOT_URL);
  });
});

/* ------------------------------ 意图路由 ------------------------------ */

describe('意图路由', () => {
  it('展开与选中分离：展开子目录触发其名称读取；选中走详情（XML 模式不发 info）', async () => {
    const panel = await openRegularDir([{ name: 'docs', kind: 'dir' }, { name: 'a.txt' }]);
    const html = panel.latestRenderHtml();
    // 树行顺序：[根 dir, docs, a.txt]。
    const docsToggle = nodeIdOf(html, 'toggleBrowserNode', 1);
    expect(docsToggle).toBeDefined();
    vi.mocked(readRemoteDirectoryNames).mockResolvedValue({ status: 'ready', listing: namesOf([{ name: 'deep.txt' }]) });
    vi.mocked(readRemoteDirectory).mockResolvedValue({ status: 'ready', listing: listingOf([{ name: 'deep.txt' }]) });
    const infoCallsBefore = vi.mocked(readRemoteNode).mock.calls.length;
    panel.sendIntent({ kind: 'toggleBrowserNode', nodeId: docsToggle });
    await waitFor(() => fakePanel().latestRenderHtml().includes('>deep.txt<'));
    expect(vi.mocked(readRemoteDirectoryNames).mock.calls.length).toBe(2);
    // 展开不改变选中；XML 模式选中已有元数据的条目不需要 info。
    const latest = fakePanel().latestRenderHtml();
    const selectId = nodeIdOf(latest, 'selectBrowserNode', 2);
    expect(selectId).toBeDefined();
    panel.sendIntent({ kind: 'selectBrowserNode', nodeId: selectId });
    await waitFor(() => fakePanel().latestRenderHtml().includes('节点 URL'));
    expect(vi.mocked(readRemoteNode).mock.calls.length).toBe(infoCallsBefore);
  });

  it('加载更多：只发新增 ≤40 行的 append 到目标节点子容器，连续两次累积', async () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({ name: `f${String(index).padStart(3, '0')}.txt` }));
    const panel = await openRegularDir(entries);
    const typeOf = (message: Record<string, unknown>) => String(message.type ?? '');
    const renders = () => panel.posted.filter((message) => typeOf(message) === 'render');
    const appends = () => panel.posted.filter((message) => typeOf(message) === 'append') as Array<{
      target: string;
      html: string;
      revision: number;
    }>;
    const initialRenders = renders().length;
    let html = panel.latestRenderHtml();
    // 根行 + 首批 40 个子行。
    expect((html.match(/data-intent="selectBrowserNode"/g) ?? []).length).toBe(41);
    const loadMoreId = nodeIdOf(html, 'loadMoreBrowserNode');
    expect(loadMoreId).toBeDefined();

    panel.sendIntent({ kind: 'loadMoreBrowserNode', nodeId: loadMoreId });
    await waitFor(() => appends().length === 1);
    // 增量通道：不追加整帧 render，append 只带本次新增的 40 行。
    expect(renders().length).toBe(initialRenders);
    const first = appends()[0];
    expect(first.target).toBe(`browse:${loadMoreId}`);
    expect((first.html.match(/role="treeitem"/g) ?? []).length).toBe(40);
    expect(first.html).toContain('>f040.txt<');
    expect(first.html).toContain('>f079.txt<');
    // 不重复发送已有行，也不含树容器/加载更多等整段结构。
    expect(first.html).not.toContain('>f000.txt<');
    expect(first.html).not.toContain('>f039.txt<');
    expect(first.html).not.toContain('class="lazy-tree"');
    expect(first.html).not.toContain('tree-load-more');

    // 第二次加载更多：继续只发 20 个新增行，累积到总数。
    panel.sendIntent({ kind: 'loadMoreBrowserNode', nodeId: loadMoreId });
    await waitFor(() => appends().length === 2);
    const second = appends()[1];
    expect(second.target).toBe(`browse:${loadMoreId}`);
    expect((second.html.match(/role="treeitem"/g) ?? []).length).toBe(20);
    expect(second.html).toContain('>f080.txt<');
    expect(second.html).toContain('>f099.txt<');
    expect(second.html).not.toContain('>f040.txt<');
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(renders().length).toBe(initialRenders);

    // 宿主意图校验快照随 append 同步：新增行上的节点可以被选中并上屏
    // （快照若仍停在首批，宿主会按旧树丢弃该意图）。
    const newRowId = /data-intent="selectBrowserNode"[^>]*data-node-id="([^"]+)"/.exec(first.html)?.[1];
    expect(newRowId).toBeDefined();
    panel.sendIntent({ kind: 'selectBrowserNode', nodeId: newRowId });
    await waitFor(() => renders().length === initialRenders + 1);
    expect(panel.latestRenderHtml()).toContain('节点 URL');
  });

  it('复制原始 URL、打开远端文件与 P6 历史交接', async () => {
    const panel = await openRegularDir([{ name: 'a.txt' }]);
    const html = panel.latestRenderHtml();
    // 树行顺序 [根 dir, a.txt]。
    const selectId = nodeIdOf(html, 'selectBrowserNode', 1);
    panel.sendIntent({ kind: 'selectBrowserNode', nodeId: selectId });
    await waitFor(() => fakePanel().latestRenderHtml().includes('data-intent="copyBrowserNodeUrl"'));
    const detailHtml = fakePanel().latestRenderHtml();
    const copyId = nodeIdOf(detailHtml, 'copyBrowserNodeUrl');
    const openId = nodeIdOf(detailHtml, 'openRemoteNode');
    const historyId = nodeIdOf(detailHtml, 'openHistoryFromBrowser');
    expect(copyId).toBeDefined();
    expect(openId).toBeDefined();
    expect(historyId).toBeDefined();

    panel.sendIntent({ kind: 'copyBrowserNodeUrl', nodeId: copyId });
    await waitFor(() => vscodeMock.clipboard.length === 1);
    expect(vscodeMock.clipboard[0]).toBe(`${ROOT_URL}/a.txt`);

    vi.mocked(openRemoteContent).mockResolvedValue({ status: 'openedText', uri: {} as vscode.Uri, bytes: 12, encoding: 'utf8', fellBack: false, lenient: false });
    panel.sendIntent({ kind: 'openRemoteNode', nodeId: openId });
    await waitFor(() => vi.mocked(openRemoteContent).mock.calls.length === 1);
    const openCall = vi.mocked(openRemoteContent).mock.calls[0];
    expect(openCall?.[1].rawUrl).toBe(`${ROOT_URL}/a.txt`);
    expect(openCall?.[2]?.sizeBytes).toBe(12);

    panel.sendIntent({ kind: 'openHistoryFromBrowser', nodeId: historyId });
    await waitFor(() => vi.mocked(openHistoryFromNode).mock.calls.length === 1);
    const ref = vi.mocked(openHistoryFromNode).mock.calls[0]?.[0];
    expect(ref).toMatchObject({ rawUrl: `${ROOT_URL}/a.txt`, snapshotRevision: 42, kind: 'file' });
  });

  it('行内刷新：重新读取该目录并取消旧回包（旧 names 回包不覆盖新树）', async () => {
    let resolveOld: ((value: Awaited<ReturnType<typeof readRemoteDirectoryNames>>) => void) | undefined;
    const oldPromise = new Promise<Awaited<ReturnType<typeof readRemoteDirectoryNames>>>((resolve) => {
      resolveOld = resolve;
    });
    vi.mocked(readRemoteNode).mockResolvedValue(present(rootRef()));
    vi.mocked(readRemoteDirectoryNames)
      .mockResolvedValueOnce({ status: 'ready', listing: namesOf([{ name: 'docs', kind: 'dir' }, { name: 'a.txt' }]) })
      .mockResolvedValueOnce({ status: 'ready', listing: namesOf([{ name: 'docs', kind: 'dir' }, { name: 'a.txt' }]) })
      .mockReturnValueOnce(oldPromise);
    vi.mocked(readRemoteDirectory).mockResolvedValue({ status: 'ready', listing: listingOf([{ name: 'docs', kind: 'dir' }, { name: 'a.txt' }]) });
    await openBrowsePanel({ source: 'remote', url: ROOT_URL });
    await waitFor(() => fakePanel().latestRenderHtml().includes('>docs<'));

    // 展开 docs：读取挂起（树行顺序 [根, docs, a.txt]）。
    const html = fakePanel().latestRenderHtml();
    const docsToggle = nodeIdOf(html, 'toggleBrowserNode', 1);
    vi.mocked(readRemoteDirectoryNames).mockReturnValueOnce(oldPromise);
    fakePanel().sendIntent({ kind: 'toggleBrowserNode', nodeId: docsToggle });
    await flush();
    // 刷新根：新票据使旧回包过期；旧 names 回包随后返回也不得覆盖。
    const rootRefresh = nodeIdOf(fakePanel().latestRenderHtml(), 'refreshBrowserNode');
    expect(rootRefresh).toBeDefined();
    vi.mocked(readRemoteDirectoryNames).mockResolvedValue({ status: 'ready', listing: namesOf([{ name: 'fresh.txt' }]) });
    vi.mocked(readRemoteDirectory).mockResolvedValue({ status: 'ready', listing: listingOf([{ name: 'fresh.txt' }]) });
    fakePanel().sendIntent({ kind: 'refreshBrowserNode', nodeId: rootRefresh });
    resolveOld?.({ status: 'ready', listing: namesOf([{ name: 'stale.txt' }]) });
    await waitFor(() => fakePanel().latestRenderHtml().includes('>fresh.txt<'));
    expect(fakePanel().latestRenderHtml()).not.toContain('stale.txt');
  });

  it('页脚刷新按钮（refresh 意图）等价根刷新：重新读取 HEAD 并更新浏览 revision', async () => {
    const panel = await openRegularDir([{ name: 'a.txt' }]);
    vi.mocked(readRemoteNode).mockResolvedValue(present(rootRef({ snapshotRevision: 50, lastChangedRevision: 50 })));
    panel.sendIntent({ kind: 'refresh' });
    await waitFor(() => fakePanel().latestRenderHtml().includes('浏览 revision r50'));
    expect(browseSessionSnapshot().snapshotRevision).toBe(50);
  });

  it('取消元数据补全：banner 动作停止任务，后续 info 回包不改变已取消状态', async () => {
    const bigEntries = Array.from({ length: 6000 }, (_, index) => ({ name: `big-${String(index).padStart(5, '0')}.txt` }));
    let resolveCompletion: ((value: Awaited<ReturnType<typeof readRemoteNode>>) => void) | undefined;
    const completion = new Promise<Awaited<ReturnType<typeof readRemoteNode>>>((resolve) => {
      resolveCompletion = resolve;
    });
    vi.mocked(readRemoteNode).mockImplementation(async (_svn, url) => {
      if (url === ROOT_URL) {
        return present(rootRef());
      }
      // 第一批补全 info 挂起，等待取消后返回。
      return completion;
    });
    vi.mocked(readRemoteDirectoryNames).mockResolvedValue({ status: 'ready', listing: namesOf(bigEntries, 6000) });
    await openBrowsePanel({ source: 'remote', url: ROOT_URL });
    await waitFor(() => fakePanel().latestRenderHtml().includes('取消元数据补全'));
    const bannerHtml = fakePanel().latestRenderHtml();
    expect(bannerHtml).toContain('data-intent="bannerAction"');
    expect(bannerHtml).toContain('data-action-id="cancelBrowserMetadata"');
    fakePanel().sendIntent({
      kind: 'bannerAction',
      bannerId: 'browseMetadata',
      actionId: 'cancelBrowserMetadata',
    });
    await waitFor(() => !fakePanel().latestRenderHtml().includes('取消元数据补全'));
    resolveCompletion?.({ status: 'present', node: fileRef('big-00000.txt'), sizeBytes: 5 });
    await flush();
    // 取消后的旧补全回包不产生新的元数据 banner，也不把状态改回 filling。
    expect(fakePanel().latestRenderHtml()).not.toContain('取消元数据补全');
    expect(fakePanel().latestRenderHtml()).toContain('元数据补全已取消');
  });

  it('行内取消补全：refreshBrowserNode 在补全中的目录只取消补全，不重读目录', async () => {
    const bigEntries = Array.from({ length: 6000 }, (_, index) => ({ name: `big-${String(index).padStart(5, '0')}.txt` }));
    let resolveCompletion: ((value: Awaited<ReturnType<typeof readRemoteNode>>) => void) | undefined;
    const completion = new Promise<Awaited<ReturnType<typeof readRemoteNode>>>((resolve) => {
      resolveCompletion = resolve;
    });
    vi.mocked(readRemoteNode).mockImplementation(async (_svn, url) => {
      if (url === ROOT_URL) {
        return present(rootRef());
      }
      return completion;
    });
    vi.mocked(readRemoteDirectoryNames).mockResolvedValue({ status: 'ready', listing: namesOf(bigEntries, 6000) });
    await openBrowsePanel({ source: 'remote', url: ROOT_URL });
    await waitFor(() => fakePanel().latestRenderHtml().includes('取消元数据补全'));
    const html = fakePanel().latestRenderHtml();
    // 行内取消按钮复用 refreshBrowserNode 意图承载取消语义，位于根行；
    // 页脚的 refresh 意图与树级加载更多使用其他动作 ID，不会混淆。
    const cancelNodeId = nodeIdOf(html, 'refreshBrowserNode');
    expect(cancelNodeId).toBeDefined();
    const namesCallsBefore = vi.mocked(readRemoteDirectoryNames).mock.calls.length;
    const infoCallsBefore = vi.mocked(readRemoteNode).mock.calls.length;
    fakePanel().sendIntent({ kind: 'refreshBrowserNode', nodeId: cancelNodeId });
    await waitFor(() => fakePanel().latestRenderHtml().includes('元数据补全已取消'));
    expect(fakePanel().latestRenderHtml()).not.toContain('取消元数据补全');
    // 只取消补全：不重读目录、不发起新的单节点 info。
    expect(vi.mocked(readRemoteDirectoryNames).mock.calls.length).toBe(namesCallsBefore);
    expect(vi.mocked(readRemoteNode).mock.calls.length).toBe(infoCallsBefore);
    resolveCompletion?.({ status: 'present', node: fileRef('big-00000.txt'), sizeBytes: 5 });
    await flush();
    expect(fakePanel().latestRenderHtml()).toContain('元数据补全已取消');
    expect(fakePanel().latestRenderHtml()).not.toContain('取消元数据补全');
  });

  it('关闭面板：dispose 后面板从注册表移除，后续意图不再触达控制器', async () => {
    const panel = await openRegularDir([{ name: 'a.txt' }]);
    panel.sendIntent({ kind: 'closePanel' });
    await flush();
    expect(panel.disposed).toBe(true);
    expect(browseSessionSnapshot().entryUrl).toBeUndefined();
  });
});

/* ------------------------------ 错误与恢复 ------------------------------ */

describe('错误与恢复', () => {
  it('入口 info 失败（auth）：根错误 banner 带重试入口，重试成功后可浏览', async () => {
    vi.mocked(readRemoteNode).mockResolvedValueOnce({
      status: 'error',
      error: { kind: 'auth', message: 'Authentication failed', codes: ['E170013', 'E215004'] },
    });
    await openBrowsePanel({ source: 'remote', url: ROOT_URL });
    await waitFor(() => fakePanel().latestRenderHtml().includes('data-action-id="retryBrowseRoot"'));
    const html = fakePanel().latestRenderHtml();
    expect(html).toContain('无法打开仓库');
    expect(html).toContain('认证已取消');
    // 重试：入口 info 成功 → 正常加载。
    vi.mocked(readRemoteNode).mockResolvedValue(present(rootRef()));
    vi.mocked(readRemoteDirectoryNames).mockResolvedValue({ status: 'ready', listing: namesOf([{ name: 'a.txt' }]) });
    vi.mocked(readRemoteDirectory).mockResolvedValue({ status: 'ready', listing: listingOf([{ name: 'a.txt' }]) });
    fakePanel().sendIntent({
      kind: 'bannerAction',
      bannerId: 'browseRootError',
      actionId: 'retryBrowseRoot',
    });
    await waitFor(() => fakePanel().latestRenderHtml().includes('>a.txt<'));
    expect(browseSessionSnapshot().rootPhase).toBe('ready');
  });

  it('节点 tooLarge：只写该节点终态与 banner，父级/兄弟保持 ready', async () => {
    const panel = await openRegularDir([{ name: 'huge', kind: 'dir' }, { name: 'a.txt' }]);
    const hugeToggle = (() => {
      const html = panel.latestRenderHtml();
      const pattern = /data-intent="toggleBrowserNode" data-node-id="([^"]+)"/g;
      const ids = [...html.matchAll(pattern)].map((match) => match[1]);
      // 第一个目录行是根（trunk）；第二个是 huge。
      return ids[1];
    })();
    expect(hugeToggle).toBeDefined();
    vi.mocked(readRemoteDirectoryNames).mockResolvedValue({
      status: 'tooLarge',
      reason: 'entries',
      limit: 100_000,
      bytesRead: 123,
      entriesParsed: 100_001,
      error: { kind: 'tooLarge', message: 'too large', codes: [] },
    });
    panel.sendIntent({ kind: 'toggleBrowserNode', nodeId: hugeToggle });
    await waitFor(() => fakePanel().latestRenderHtml().includes('目录超出当前完整读取上限'));
    const html = fakePanel().latestRenderHtml();
    expect(html).toContain('>a.txt<');
    expect(html).toContain('data-intent="retryBrowserNode"');
    // 根目录行仍 ready。
    expect(html).toContain('已读取 2 / 总计 2');
  });

  it('节点读取错误：行内重试入口保留原路径，错误不替换父级', async () => {
    const panel = await openRegularDir([{ name: 'bad', kind: 'dir' }, { name: 'a.txt' }]);
    const html = panel.latestRenderHtml();
    const pattern = /data-intent="toggleBrowserNode" data-node-id="([^"]+)"/g;
    const ids = [...html.matchAll(pattern)].map((match) => match[1]);
    vi.mocked(readRemoteDirectoryNames).mockResolvedValue({
      status: 'notFound',
      error: { kind: 'notFound', message: 'gone', codes: ['W160013'] },
    });
    panel.sendIntent({ kind: 'toggleBrowserNode', nodeId: ids[1] });
    await waitFor(() => fakePanel().latestRenderHtml().includes('data-intent="retryBrowserNode"'));
    expect(fakePanel().latestRenderHtml()).toContain('>a.txt<');
    expect(fakePanel().latestRenderHtml()).toContain('路径在当前浏览 revision 不存在');
    // 重试原路径：再次调用该节点的 names 读取。
    const retryId = nodeIdOf(fakePanel().latestRenderHtml(), 'retryBrowserNode');
    vi.mocked(readRemoteDirectoryNames).mockResolvedValue({ status: 'ready', listing: namesOf([{ name: 'deep.txt' }]) });
    vi.mocked(readRemoteDirectory).mockResolvedValue({ status: 'ready', listing: listingOf([{ name: 'deep.txt' }]) });
    panel.sendIntent({ kind: 'retryBrowserNode', nodeId: retryId });
    await waitFor(() => fakePanel().latestRenderHtml().includes('>deep.txt<'));
    const lastNamesCall = vi.mocked(readRemoteDirectoryNames).mock.calls.at(-1);
    expect(lastNamesCall?.[1]).toBe(`${ROOT_URL}/bad`);
  });

  it('关闭重开恢复：同一入口第二次打开先按存储的浏览 revision 读 info', async () => {
    await openRegularDir([{ name: 'a.txt' }]);
    vi.mocked(readRemoteNode).mockClear();
    vi.mocked(readRemoteNode).mockResolvedValue(present(rootRef()));
    vi.mocked(readRemoteDirectoryNames).mockResolvedValue({ status: 'ready', listing: namesOf([{ name: 'a.txt' }]) });
    vi.mocked(readRemoteDirectory).mockResolvedValue({ status: 'ready', listing: listingOf([{ name: 'a.txt' }]) });
    // 模拟关闭面板后重新打开（不重置会话存储）。
    resetBrowsePanelController();
    setBrowsePanelContext({
      extensionUri: { scheme: 'file', path: '/extension' } as unknown as vscode.Uri,
      subscriptions: [],
    });
    await openBrowsePanel({ source: 'remote', url: ROOT_URL });
    await waitFor(() => browseSessionSnapshot().rootPhase === 'ready');
    const firstInfo = vi.mocked(readRemoteNode).mock.calls[0];
    expect((firstInfo?.[2] as { revision?: number }).revision).toBe(42);
  });

  it('旧浏览 revision 下入口不存在时回落 HEAD（先按旧 revision absent，再读 HEAD）', async () => {
    await openRegularDir([{ name: 'a.txt' }]);
    vi.mocked(readRemoteNode).mockReset();
    vi.mocked(readRemoteNode)
      .mockResolvedValueOnce({ status: 'absent', error: { kind: 'notFound', message: 'gone', codes: ['W170000'] } })
      .mockResolvedValue(present(rootRef({ snapshotRevision: 60, lastChangedRevision: 60 })));
    vi.mocked(readRemoteDirectoryNames).mockResolvedValue({ status: 'ready', listing: namesOf([{ name: 'a.txt' }]) });
    vi.mocked(readRemoteDirectory).mockResolvedValue({ status: 'ready', listing: listingOf([{ name: 'a.txt' }]) });
    resetBrowsePanelController();
    setBrowsePanelContext({
      extensionUri: { scheme: 'file', path: '/extension' } as unknown as vscode.Uri,
      subscriptions: [],
    });
    await openBrowsePanel({ source: 'remote', url: ROOT_URL });
    await waitFor(() => browseSessionSnapshot().rootPhase === 'ready');
    expect(vi.mocked(readRemoteNode).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(browseSessionSnapshot().snapshotRevision).toBe(60);
  });
});
