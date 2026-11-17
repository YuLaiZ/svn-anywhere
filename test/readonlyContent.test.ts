/**
 * P5 远端只读内容测试（host/readonlyContent）：
 * - 文档 URI 携带仓库 UUID、原始 URL、revision 与一次性内容键（解析可还原）；
 * - provider 按内容键返回缓存文本，文档关闭即释放（diffView 关闭释放模式）；
 * - 真实 svnadmin + file:// 隔离仓库（test/helpers）：文本 ≤16 MiB 内嵌、
 *   中文/空格名称、二进制经 runToFile 临时资源 + 系统默认应用、文本实际
 *   超过内嵌上限的降级、已知大小 >2 GiB 不启动 cat、路径不存在不伪装空内容、
 *   svn:special 符号链接返回显式状态且不进入内嵌文本预览；
 * - 受管临时目录：停用清理只删本进程资源、过期回收按 mtime 移除、
 *   系统默认应用打开失败的降级状态。
 */
import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

const vscodeMock = vi.hoisted(() => ({
  channels: [] as Array<{ lines: string[] }>,
  shownDocuments: [] as Array<{ uri: { scheme?: string; path?: string; query?: string }; options?: unknown }>,
  openedExternal: [] as Array<{ scheme?: string; fsPath?: string; path?: string }>,
  openExternalResult: true,
  /** 非空时 showTextDocument 以该消息 reject（宿主 API 异常场景）。 */
  showTextDocumentError: undefined as string | undefined,
  providers: new Map<string, { provideTextDocumentContent(uri: unknown): string }>(),
  closeHandlers: [] as Array<(doc: { uri: unknown }) => void>,
  providerDisposals: 0,
  closeDisposals: 0,
}));

vi.mock('vscode', () => ({
  Uri: {
    file: (fsPath: string) => ({ scheme: 'file', path: fsPath, fsPath, toString: () => `file://${fsPath}` }),
    from: (components: { scheme: string; path?: string; query?: string }) => ({
      scheme: components.scheme,
      path: components.path ?? '',
      query: components.query ?? '',
      toString: () =>
        `${components.scheme}:${components.path ?? ''}${components.query ? `?${components.query}` : ''}`,
    }),
    parse: (value: string) => {
      const match = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(value);
      const scheme = match?.[1] ?? 'untitled';
      const rest = match?.[2] ?? value;
      const queryIndex = rest.indexOf('?');
      return {
        scheme,
        path: queryIndex >= 0 ? rest.slice(0, queryIndex) : rest,
        query: queryIndex >= 0 ? rest.slice(queryIndex + 1) : '',
        toString: () => value,
      };
    },
  },
  window: {
    createOutputChannel: () => {
      const channel = {
        lines: [] as string[],
        appendLine(line: string) {
          channel.lines.push(line);
        },
        show() {},
        dispose() {},
      };
      vscodeMock.channels.push(channel);
      return channel;
    },
    showTextDocument: (uri: unknown, options?: unknown) => {
      vscodeMock.shownDocuments.push({ uri: uri as { scheme?: string; path?: string }, options });
      if (vscodeMock.showTextDocumentError !== undefined) {
        return Promise.reject(new Error(vscodeMock.showTextDocumentError));
      }
      return Promise.resolve(undefined);
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown) => fallback,
    }),
    registerTextDocumentContentProvider: (scheme: string, provider: { provideTextDocumentContent(uri: unknown): string }) => {
      vscodeMock.providers.set(scheme, provider);
      return {
        dispose: () => {
          vscodeMock.providerDisposals += 1;
        },
      };
    },
    onDidCloseTextDocument: (handler: (doc: { uri: unknown }) => void) => {
      vscodeMock.closeHandlers.push(handler);
      return {
        dispose: () => {
          vscodeMock.closeDisposals += 1;
          const index = vscodeMock.closeHandlers.indexOf(handler);
          if (index >= 0) {
            vscodeMock.closeHandlers.splice(index, 1);
          }
        },
      };
    },
  },
  env: {
    openExternal: (uri: unknown) => {
      vscodeMock.openedExternal.push(uri as { scheme?: string; fsPath?: string });
      return Promise.resolve(vscodeMock.openExternalResult);
    },
  },
}));

import type { RepoNodeRef } from '../src/core/remoteBrowse';
import { readRemoteNode } from '../src/core/remoteBrowse';
import { REMOTE_TEMP_FILE_MAX_BYTES } from '../src/core/remoteContent';
import {
  buildRemoteDocumentUri,
  cleanupExpiredRemoteResources,
  disposeRemoteContent,
  initializeRemoteContent,
  openRemoteContent,
  parseRemoteDocumentUri,
  REMOTE_DOCUMENT_SCHEME,
  REMOTE_RESOURCE_DIR_NAME,
  resetRemoteContentForTest,
  type OpenRemoteContentOptions,
} from '../src/host/readonlyContent';
import { strings } from '../src/host/i18n';
import { disposeOutputChannel, resetOutputState } from '../src/host/output';
import { createSvnLab, writeFile, type SvnLab } from './helpers';

let hasSvn = false;
try {
  execSync('svn --version', { stdio: 'ignore' });
  hasSvn = true;
} catch {
  hasSvn = false;
}

let hasSvnadmin = false;
try {
  execSync('svnadmin --version', { stdio: 'ignore' });
  hasSvnadmin = true;
} catch {
  hasSvnadmin = false;
}

const realSvn = hasSvn && hasSvnadmin ? describe : describe.skip;

const makeContext = (): vscode.ExtensionContext => ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;

beforeEach(() => {
  disposeOutputChannel();
  resetOutputState();
  resetRemoteContentForTest();
  vscodeMock.channels.length = 0;
  vscodeMock.shownDocuments.length = 0;
  vscodeMock.openedExternal.length = 0;
  vscodeMock.openExternalResult = true;
  vscodeMock.showTextDocumentError = undefined;
  vscodeMock.providers.clear();
  vscodeMock.closeHandlers.length = 0;
  vscodeMock.providerDisposals = 0;
  vscodeMock.closeDisposals = 0;
});

afterEach(() => {
  resetRemoteContentForTest();
  disposeOutputChannel();
  resetOutputState();
});

// ---------------------------------------------------------------------------
// 文档 URI（纯逻辑）
// ---------------------------------------------------------------------------

describe('远端只读文档 URI', () => {
  it('携带仓库 UUID、revision、一次性内容键与原始 URL，解析可还原', () => {
    const uri = buildRemoteDocumentUri(
      { repositoryUuid: 'uuid-1', rawUrl: 'https://host/repo/中文.txt', revision: 7 },
      '中文.txt',
      'key-abc123',
    );
    expect(uri.scheme).toBe(REMOTE_DOCUMENT_SCHEME);
    expect(parseRemoteDocumentUri(uri)).toEqual({
      repositoryUuid: 'uuid-1',
      rawUrl: 'https://host/repo/中文.txt',
      revision: 7,
      contentKey: 'key-abc123',
    });
  });

  it('原始 URL 中的 %40/@/# 编码形态经 query 编码后可还原', () => {
    const rawUrl = 'https://host/repo/at%40file%231.txt';
    const uri = buildRemoteDocumentUri({ repositoryUuid: 'u', rawUrl, revision: 3 }, 'at@file#1.txt', 'k');
    expect(parseRemoteDocumentUri(uri)?.rawUrl).toBe(rawUrl);
  });

  it('非本 scheme 或形状不符返回 undefined', () => {
    expect(parseRemoteDocumentUri({ scheme: 'file', path: '/a/b/c/d', query: '' } as unknown as vscode.Uri)).toBeUndefined();
    expect(parseRemoteDocumentUri({
      scheme: REMOTE_DOCUMENT_SCHEME,
      path: '/only-one-segment',
      query: 'url=x',
    } as unknown as vscode.Uri)).toBeUndefined();
    expect(parseRemoteDocumentUri({
      scheme: REMOTE_DOCUMENT_SCHEME,
      path: '/uuid/not-a-number/key/name',
      query: 'url=x',
    } as unknown as vscode.Uri)).toBeUndefined();
    expect(parseRemoteDocumentUri({
      scheme: REMOTE_DOCUMENT_SCHEME,
      path: '/uuid/1/key/name',
      query: '',
    } as unknown as vscode.Uri)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// provider 注册与关闭释放（无 svn 依赖）
// ---------------------------------------------------------------------------

describe('只读 provider 生命周期', () => {
  it('initializeRemoteContent 注册 provider 与关闭监听；dispose 释放句柄', () => {
    initializeRemoteContent(makeContext());
    expect(vscodeMock.providers.has(REMOTE_DOCUMENT_SCHEME)).toBe(true);
    expect(vscodeMock.closeHandlers).toHaveLength(1);
    disposeRemoteContent();
    expect(vscodeMock.providerDisposals).toBe(1);
    expect(vscodeMock.closeDisposals).toBe(1);
  });

  it('未缓存的内容键返回「已释放」提示，非法 URI 返回「无法识别」', () => {
    initializeRemoteContent(makeContext());
    const provider = vscodeMock.providers.get(REMOTE_DOCUMENT_SCHEME);
    expect(provider).toBeDefined();
    const uri = buildRemoteDocumentUri({ repositoryUuid: 'u', rawUrl: 'https://host/x', revision: 1 }, 'x', 'missing');
    expect(provider?.provideTextDocumentContent(uri)).toBe(strings.browse.documentReleased);
    const invalid = { scheme: REMOTE_DOCUMENT_SCHEME, path: '/bad', query: '' } as unknown as vscode.Uri;
    expect(provider?.provideTextDocumentContent(invalid)).toBe(strings.browse.documentInvalid);
  });
});

// ---------------------------------------------------------------------------
// 过期回收（受管临时目录）
// ---------------------------------------------------------------------------

describe('受管临时资源回收', () => {
  it('按 mtime 删除过期目录，保留未过期目录并跳过普通文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'svn-anywhere-remote-gc-'));
    try {
      const staleDir = join(root, '1-stale');
      const freshDir = join(root, '1-fresh');
      mkdirSync(staleDir);
      mkdirSync(freshDir);
      writeFileSync(join(root, 'plain-file'), 'x');
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(staleDir, twoHoursAgo, twoHoursAgo);
      const removed = cleanupExpiredRemoteResources(60 * 60 * 1000, Date.now(), root);
      expect(removed).toBe(1);
      expect(existsSync(staleDir)).toBe(false);
      expect(existsSync(freshDir)).toBe(true);
      expect(existsSync(join(root, 'plain-file'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('受管根不存在时返回 0，不抛错', () => {
    const missing = join(tmpdir(), `svn-anywhere-remote-missing-${process.pid}`);
    expect(cleanupExpiredRemoteResources(0, Date.now(), missing)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 打开远端内容（真实 svn）
// ---------------------------------------------------------------------------

realSvn('openRemoteContent（真实 svnadmin + file://）', () => {
  let lab: SvnLab;

  const urlOf = (relative: string): string =>
    `${lab.repoUrl}/${relative.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`;

  async function openNode(
    relative: string,
    options: Partial<OpenRemoteContentOptions> = {},
  ): Promise<{ node: RepoNodeRef; outcome: Awaited<ReturnType<typeof openRemoteContent>> }> {
    const nodeResult = await readRemoteNode('svn', urlOf(relative), {});
    if (nodeResult.status !== 'present') {
      throw new Error(`fixture 节点不可读：${relative}`);
    }
    const sizeBytes = options.sizeBytes ?? nodeResult.sizeBytes;
    const outcome = await openRemoteContent('svn', nodeResult.node, {
      ...options,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    });
    return { node: nodeResult.node, outcome };
  }

  beforeEach(() => {
    initializeRemoteContent(makeContext());
    lab = createSvnLab('svn-anywhere-remote-content-');
    const wc = lab.checkout('wc');
    writeFile(wc, 'hello.txt', '你好，SVN\n', true);
    // 中文/空格文件名保持 ASCII 文本内容：SVN 1.15 的 add 自动探测会把
    // 「非可打印字节占比过高」的纯中文短文本标成 application/octet-stream
    //（svn add 自动 MIME 探测的既定规则），本用例只验证名称与 URL 编码。
    writeFile(wc, '中文 名称.txt', 'plain text\n', true);
    writeFile(wc, 'sub/child.txt', 'child\n', true);
    writeFile(wc, 'big.txt', 'B'.repeat(200), true);
    // 含 NUL 的二进制：svn add（1.15 默认）自动设置 application/octet-stream。
    const binaryPath = join(wc, 'bin.dat');
    mkdirSync(dirname(binaryPath), { recursive: true });
    writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00]));
    lab.svn(['add', '-q', 'bin.dat'], wc);
    lab.svn(['commit', '-q', '-m', 'r1'], wc);
  });

  afterEach(() => {
    lab.cleanup();
  });

  it('文本 ≤16 MiB：经只读 provider 打开，内容与编码回退链原文一致', async () => {
    const { outcome } = await openNode('hello.txt');
    expect(outcome.status).toBe('openedText');
    if (outcome.status !== 'openedText') {
      return;
    }
    expect(outcome.bytes).toBe(Buffer.byteLength('你好，SVN\n'));
    expect(vscodeMock.shownDocuments).toHaveLength(1);
    expect(vscodeMock.shownDocuments[0]?.uri).toBe(outcome.uri);
    const provider = vscodeMock.providers.get(REMOTE_DOCUMENT_SCHEME);
    expect(provider?.provideTextDocumentContent(outcome.uri)).toBe('你好，SVN\n');
    const parsed = parseRemoteDocumentUri(outcome.uri);
    expect(parsed?.revision).toBe(1);
    expect(parsed?.rawUrl).toBe(urlOf('hello.txt'));
  });

  it('showTextDocument 抛错：回收一次性内容键并返回 error（不泄漏 ≤16 MiB 文本）', async () => {
    vscodeMock.showTextDocumentError = 'webview host failure';
    const { outcome } = await openNode('hello.txt');
    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') {
      return;
    }
    expect(outcome.error.kind).toBe('unknown');
    expect(outcome.error.message).toContain('webview host failure');
    // 文档从未打开：关闭事件不会触发，入口必须自行回收内容条目。
    expect(vscodeMock.shownDocuments).toHaveLength(1);
    const uri = vscodeMock.shownDocuments[0]?.uri;
    const provider = vscodeMock.providers.get(REMOTE_DOCUMENT_SCHEME);
    expect(provider?.provideTextDocumentContent(uri)).toBe(strings.browse.documentReleased);
  });

  it('中文/空格名称：URI 保存展示名，原始 URL 保持 %XX 编码', async () => {
    const { outcome } = await openNode('中文 名称.txt');
    expect(outcome.status).toBe('openedText');
    if (outcome.status !== 'openedText') {
      return;
    }
    expect(outcome.uri.path).toContain('中文 名称.txt');
    expect(parseRemoteDocumentUri(outcome.uri)?.rawUrl).toBe(urlOf('中文 名称.txt'));
    expect(vscodeMock.providers.get(REMOTE_DOCUMENT_SCHEME)?.provideTextDocumentContent(outcome.uri))
      .toBe('plain text\n');
  });

  it('文档关闭：释放内容缓存，重开显示「已释放」而非旧内容', async () => {
    const { outcome } = await openNode('hello.txt');
    expect(outcome.status).toBe('openedText');
    if (outcome.status !== 'openedText') {
      return;
    }
    const provider = vscodeMock.providers.get(REMOTE_DOCUMENT_SCHEME);
    expect(provider?.provideTextDocumentContent(outcome.uri)).toBe('你好，SVN\n');
    for (const handler of vscodeMock.closeHandlers) {
      handler({ uri: outcome.uri });
    }
    expect(provider?.provideTextDocumentContent(outcome.uri)).toBe(strings.browse.documentReleased);
  });

  it('二进制（mime 判据）：runToFile 临时资源写入受管目录并经系统默认应用打开', async () => {
    const { outcome } = await openNode('bin.dat');
    expect(outcome.status).toBe('openedExternal');
    if (outcome.status !== 'openedExternal') {
      return;
    }
    expect(outcome.reason).toBe('binary');
    expect(outcome.bytesWritten).toBe(6);
    expect(readFileSync(outcome.filePath).equals(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00]))).toBe(true);
    expect(outcome.filePath.startsWith(join(tmpdir(), REMOTE_RESOURCE_DIR_NAME))).toBe(true);
    expect(outcome.filePath.endsWith('bin.dat')).toBe(true);
    expect(vscodeMock.openedExternal).toHaveLength(1);
    expect(vscodeMock.openedExternal[0]?.fsPath).toBe(outcome.filePath);
    expect(vscodeMock.shownDocuments).toHaveLength(0);
  });

  it('svn:special 符号链接：返回 special 状态，不进入内嵌文本预览与外部打开', async () => {
    // 真实符号链接：svn add 自动设置 svn:special，cat 输出 `link <target>`
    // 原文且无 mime/NUL；调用方据 special 状态提示，不把它当普通文本打开。
    const wc = join(lab.root, 'wc');
    execSync(`mkdir -p ${join(wc, 'trunk')} && ln -s target.txt ${join(wc, 'trunk', 'link.txt')}`);
    lab.svn(['add', '-q', '--parents', 'trunk/link.txt'], wc);
    lab.svn(['commit', '-q', '-m', 'r2 special'], wc);

    const nodeResult = await readRemoteNode('svn', urlOf('trunk/link.txt'), {});
    expect(nodeResult.status).toBe('present');
    if (nodeResult.status !== 'present') {
      return;
    }
    const outcome = await openRemoteContent('svn', nodeResult.node, {});
    expect(outcome.status).toBe('special');
    // 不打开文本编辑器、不交系统默认应用。
    expect(vscodeMock.shownDocuments).toHaveLength(0);
    expect(vscodeMock.openedExternal).toHaveLength(0);
  });

  it('文本实际超过内嵌上限（等价小阈值）：降级为临时资源外部打开', async () => {
    const { outcome } = await openNode('big.txt', { inlineTextMaxBytes: 32 });
    expect(outcome.status).toBe('openedExternal');
    if (outcome.status !== 'openedExternal') {
      return;
    }
    expect(outcome.reason).toBe('textTooLarge');
    expect(readFileSync(outcome.filePath, 'utf8')).toBe('B'.repeat(200));
    expect(vscodeMock.shownDocuments).toHaveLength(0);
  });

  it('已知大小 > 2 GiB：直接 tooLarge，不启动任何 cat 与外部打开', async () => {
    const { outcome } = await openNode('hello.txt', { sizeBytes: REMOTE_TEMP_FILE_MAX_BYTES + 1 });
    expect(outcome.status).toBe('tooLarge');
    if (outcome.status === 'tooLarge') {
      expect(outcome.limitBytes).toBe(REMOTE_TEMP_FILE_MAX_BYTES);
    }
    expect(vscodeMock.openedExternal).toHaveLength(0);
    expect(vscodeMock.shownDocuments).toHaveLength(0);
  });

  it('系统默认应用打开失败：externalOpenFailed 且文件保留供手动打开', async () => {
    vscodeMock.openExternalResult = false;
    const { outcome } = await openNode('bin.dat');
    expect(outcome.status).toBe('externalOpenFailed');
    if (outcome.status !== 'externalOpenFailed') {
      return;
    }
    expect(existsSync(outcome.filePath)).toBe(true);
    expect(readFileSync(outcome.filePath).length).toBe(6);
  });

  it('路径不存在：notFound（不把空骨架伪装成空内容）', async () => {
    const node: RepoNodeRef = {
      repositoryUuid: 'uuid-x',
      repositoryRootUrl: lab.repoUrl,
      rawUrl: urlOf('missing.txt'),
      relativePath: 'missing.txt',
      snapshotRevision: 1,
      lastChangedRevision: 1,
      kind: 'file',
    };
    const outcome = await openRemoteContent('svn', node, {});
    expect(outcome.status).toBe('notFound');
  });

  it('停用清理：删除本进程创建的临时资源文件', async () => {
    const { outcome } = await openNode('bin.dat');
    expect(outcome.status).toBe('openedExternal');
    if (outcome.status !== 'openedExternal') {
      return;
    }
    expect(existsSync(outcome.filePath)).toBe(true);
    disposeRemoteContent();
    expect(existsSync(outcome.filePath)).toBe(false);
  });
});
