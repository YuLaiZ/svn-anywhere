/**
 * P5 入口命令测试（M4 阶段 2，host/commands/browse）：
 * - 远端 URL 校验链：仅 http/https/svn、拒绝 userinfo/query/fragment 与
 *   未编码字符（编码问题给明确提示），中文显示值经 encodeEditableURL
 *   转成 %XX 后通过；
 * - 本地入口：真实 svnadmin + file:// 隔离仓库（test/helpers）向上定位
 *   工作副本并读取 URL/kind；副本外、未纳管节点、缺失 svn 的分支；
 * - 命令本体：右键节点与命令面板远端 URL 两条入口经注入的 opener 交接，
 *   取消与非法输入不触发打开；
 * - P6 交接载荷：任意节点「查看变更日志」只传节点身份与类型（kind、
 *   URL、仓库相对路径、revision），未接线时明确提示（不注册 showHistory）。
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

const vscodeMock = vi.hoisted(() => ({
  information: [] as string[],
  warning: [] as string[],
  error: [] as unknown[][],
  inputBoxCalls: 0,
  inputBoxResult: undefined as string | undefined,
  registered: [] as Array<{ id: string; handler: (uri?: unknown) => unknown }>,
  channels: [] as Array<{ lines: string[] }>,
}));

vi.mock('vscode', () => ({
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
    showInformationMessage: (message: string) => {
      vscodeMock.information.push(message);
      return Promise.resolve(undefined);
    },
    showWarningMessage: (message: string) => {
      vscodeMock.warning.push(message);
      return Promise.resolve(undefined);
    },
    showErrorMessage: (message: string) => {
      vscodeMock.error.push([message]);
      return Promise.resolve(undefined);
    },
    showInputBox: () => {
      vscodeMock.inputBoxCalls += 1;
      return Promise.resolve(vscodeMock.inputBoxResult);
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown) => fallback,
    }),
  },
  commands: {
    registerCommand: (id: string, handler: (uri?: unknown) => unknown) => {
      vscodeMock.registered.push({ id, handler });
      return { dispose: () => undefined };
    },
  },
}));

import type { RepoNodeRef } from '../src/core/remoteBrowse';
import {
  BROWSE_URL_SCHEMES,
  buildHistoryHandoff,
  commandBrowseRepository,
  openBrowseTarget,
  openHistoryFromNode,
  parseBrowseUrl,
  resetBrowseEntryForTest,
  resolveLocalBrowseTarget,
  setBrowsePanelOpener,
  setHistoryHandoffHandler,
  type BrowseOpenTarget,
} from '../src/host/commands/browse';
import { strings } from '../src/host/i18n';
import { disposeOutputChannel, resetOutputState } from '../src/host/output';
import { createSvnLab, writeFile, type SvnLab } from './helpers';

const makeUri = (fsPath: string, scheme = 'file'): vscode.Uri =>
  ({ fsPath, scheme }) as unknown as vscode.Uri;

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

beforeEach(() => {
  disposeOutputChannel();
  resetOutputState();
  resetBrowseEntryForTest();
  vscodeMock.information.length = 0;
  vscodeMock.warning.length = 0;
  vscodeMock.error.length = 0;
  vscodeMock.inputBoxCalls = 0;
  vscodeMock.inputBoxResult = undefined;
  vscodeMock.registered.length = 0;
  vscodeMock.channels.length = 0;
});

afterEach(() => {
  resetBrowseEntryForTest();
  disposeOutputChannel();
  resetOutputState();
});

// ---------------------------------------------------------------------------
// 远端 URL 校验链（纯逻辑）
// ---------------------------------------------------------------------------

describe('parseBrowseUrl（命令面板远端 URL 校验）', () => {
  it('只允许 http/https/svn 三种协议', () => {
    expect(BROWSE_URL_SCHEMES).toEqual(['http', 'https', 'svn']);
    for (const url of [
      'http://svn.example.com/repo',
      'https://svn.example.com/repo/trunk',
      'svn://svn.example.com/project',
    ]) {
      const parsed = parseBrowseUrl(url);
      expect(parsed, url).toEqual({ ok: true, url });
    }
  });

  it('其它协议拒绝并给 P5 专属提示（不借用检出侧五种协议的文案）', () => {
    for (const url of ['svn+ssh://host/repo', 'file:///tmp/repo', 'ftp://host/repo', 'https:/broken']) {
      const parsed = parseBrowseUrl(url);
      expect(parsed.ok, url).toBe(false);
      if (!parsed.ok) {
        expect(parsed.reason).toBe('scheme');
        expect(parsed.message).toBe(strings.browse.urlSchemeOnly);
      }
    }
  });

  it('空输入给出「URL 不能为空」', () => {
    expect(parseBrowseUrl('   ')).toEqual({
      ok: false,
      reason: 'empty',
      message: strings.browse.urlEmpty,
    });
  });

  it('拒绝 authority 内嵌 userinfo（user:pass@ 与 user@ 两种形态）', () => {
    for (const url of ['https://user:pw@host/repo', 'https://user@host/repo', 'svn://user@host/repo']) {
      const parsed = parseBrowseUrl(url);
      expect(parsed.ok, url).toBe(false);
      if (!parsed.ok) {
        expect(parsed.reason).toBe('userinfo');
      }
    }
  });

  it('拒绝 query 与 fragment（各自原因明确）', () => {
    const query = parseBrowseUrl('https://host/repo?rev=1');
    expect(query.ok).toBe(false);
    if (!query.ok) {
      expect(query.reason).toBe('query');
    }
    const fragment = parseBrowseUrl('https://host/repo#frag');
    expect(fragment.ok).toBe(false);
    if (!fragment.ok) {
      expect(fragment.reason).toBe('fragment');
    }
  });

  it('编码问题明确提示：未编码空格/控制字符按 unencoded 拒绝', () => {
    for (const url of ['https://host/repo with space', 'https://host/repo\tname']) {
      const parsed = parseBrowseUrl(url);
      expect(parsed.ok, url).toBe(false);
      if (!parsed.ok) {
        expect(parsed.reason).toBe('unencoded');
        expect(parsed.message).toContain('%XX');
      }
    }
  });

  it('中文显示值经 encodeEditableURL 转 %XX 后通过，原已编码的 URL 原样通过', () => {
    const zh = parseBrowseUrl('https://host/仓库/说明.txt');
    expect(zh.ok).toBe(true);
    if (zh.ok) {
      expect(zh.url).toBe(`https://host/${encodeURIComponent('仓库')}/${encodeURIComponent('说明.txt')}`);
    }
    const preEncoded = parseBrowseUrl('https://host/repo%20name/a%40b.txt');
    expect(preEncoded).toEqual({ ok: true, url: 'https://host/repo%20name/a%40b.txt' });
  });

  it('路径中的 @ 不当作 userinfo（authority 段才拒绝），交由 urlWithPeg 处理', () => {
    expect(parseBrowseUrl('https://host/repo/at@file.txt')).toEqual({
      ok: true,
      url: 'https://host/repo/at@file.txt',
    });
  });

  it('首尾空白先 trim 再校验', () => {
    expect(parseBrowseUrl('  https://host/repo  ')).toEqual({ ok: true, url: 'https://host/repo' });
  });
});

// ---------------------------------------------------------------------------
// 本地入口（真实 svn）
// ---------------------------------------------------------------------------

realSvn('resolveLocalBrowseTarget（真实 svnadmin + file://）', () => {
  let lab: SvnLab;
  let wc: string;

  beforeEach(() => {
    lab = createSvnLab('svn-anywhere-browse-');
    wc = lab.checkout('wc');
    writeFile(wc, 'docs/readme.txt', 'hello\n', true);
    writeFile(wc, 'top.txt', 'top\n', true);
    lab.svn(['commit', '-q', '-m', 'r1'], wc);
  });

  afterEach(() => {
    lab.cleanup();
  });

  it('右键目录：返回工作副本根、节点 URL、仓库根/UUID 与 kind=dir', async () => {
    const resolved = await resolveLocalBrowseTarget(join(wc, 'docs'), 'svn');
    expect(resolved.status).toBe('ok');
    if (resolved.status !== 'ok') {
      return;
    }
    const { target } = resolved;
    expect(target.source).toBe('local');
    expect(target.wcRoot).toBe(realpathSync(wc));
    expect(target.localPath).toBe(join(wc, 'docs'));
    expect(target.kind).toBe('dir');
    expect(target.url).toBe(`${lab.repoUrl}/docs`);
    expect(target.repositoryRootUrl).toBe(lab.repoUrl);
    expect(target.repositoryUuid).not.toBe('');
  });

  it('右键文件：kind=file，URL 指向文件节点', async () => {
    const resolved = await resolveLocalBrowseTarget(join(wc, 'top.txt'), 'svn');
    expect(resolved.status).toBe('ok');
    if (resolved.status === 'ok') {
      expect(resolved.target.kind).toBe('file');
      expect(resolved.target.url).toBe(`${lab.repoUrl}/top.txt`);
    }
  });

  it('副本外路径：不读 svn，直接 notWorkingCopy', async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-browse-plain-')));
    try {
      const resolved = await resolveLocalBrowseTarget(plain, 'svn');
      expect(resolved.status).toBe('notWorkingCopy');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('副本内未纳管文件：unversioned（不借父目录 URL 误报成功）', async () => {
    writeFile(wc, 'untracked.txt', 'x');
    const resolved = await resolveLocalBrowseTarget(join(wc, 'untracked.txt'), 'svn');
    expect(resolved.status).toBe('unversioned');
  });

  it('svn 可执行缺失：svnMissing（指向 svnPath 配置的提示由命令层给出）', async () => {
    const resolved = await resolveLocalBrowseTarget(join(wc, 'docs'), '/nonexistent/svn-binary-for-test');
    expect(resolved.status).toBe('svnMissing');
  });
});

// ---------------------------------------------------------------------------
// 命令本体与注入点
// ---------------------------------------------------------------------------

realSvn('commandBrowseRepository（真实 svn）', () => {
  let lab: SvnLab;
  let wc: string;

  beforeEach(() => {
    lab = createSvnLab('svn-anywhere-browse-cmd-');
    wc = lab.checkout('wc');
    writeFile(wc, 'docs/readme.txt', 'hello\n', true);
    lab.svn(['commit', '-q', '-m', 'r1'], wc);
  });

  afterEach(() => {
    lab.cleanup();
  });

  it('右键节点：opener 收到 local 目标（含 kind 与 URL）', async () => {
    const targets: BrowseOpenTarget[] = [];
    setBrowsePanelOpener((target) => {
      targets.push(target);
    });
    await commandBrowseRepository(makeUri(join(wc, 'docs')));
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      source: 'local',
      wcRoot: realpathSync(wc),
      localPath: join(wc, 'docs'),
      kind: 'dir',
      url: `${lab.repoUrl}/docs`,
    });
    expect(vscodeMock.information).toHaveLength(0);
  });

  it('副本外节点：提示「不在工作副本内」且不调用 opener', async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-browse-cmd-plain-')));
    const targets: BrowseOpenTarget[] = [];
    setBrowsePanelOpener((target) => {
      targets.push(target);
    });
    try {
      await commandBrowseRepository(makeUri(plain));
      expect(targets).toHaveLength(0);
      expect(vscodeMock.information).toEqual([strings.browse.notWorkingCopy]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('commandBrowseRepository（命令面板远端 URL）', () => {
  it('无路径：输入框确认后把规范化 URL 交给 opener', async () => {
    const targets: BrowseOpenTarget[] = [];
    setBrowsePanelOpener((target) => {
      targets.push(target);
    });
    vscodeMock.inputBoxResult = 'https://svn.example.com/repo/trunk';
    await commandBrowseRepository(undefined);
    expect(vscodeMock.inputBoxCalls).toBe(1);
    expect(targets).toEqual([{ source: 'remote', url: 'https://svn.example.com/repo/trunk' }]);
  });

  it('中文显示值：交接给 opener 的是 %XX 编码后的 URL', async () => {
    const targets: BrowseOpenTarget[] = [];
    setBrowsePanelOpener((target) => {
      targets.push(target);
    });
    vscodeMock.inputBoxResult = 'https://svn.example.com/仓库/说明.txt';
    await commandBrowseRepository(undefined);
    expect(targets).toEqual([{
      source: 'remote',
      url: `https://svn.example.com/${encodeURIComponent('仓库')}/${encodeURIComponent('说明.txt')}`,
    }]);
  });

  it('取消输入：不调用 opener', async () => {
    const targets: BrowseOpenTarget[] = [];
    setBrowsePanelOpener((target) => {
      targets.push(target);
    });
    vscodeMock.inputBoxResult = undefined;
    await commandBrowseRepository(undefined);
    expect(targets).toHaveLength(0);
  });

  it('非法输入（防御层）：不调用 opener', async () => {
    const targets: BrowseOpenTarget[] = [];
    setBrowsePanelOpener((target) => {
      targets.push(target);
    });
    vscodeMock.inputBoxResult = 'ftp://host/repo';
    await commandBrowseRepository(undefined);
    expect(targets).toHaveLength(0);
  });

  it('非 file scheme 的 uri 视同命令面板入口（走 URL 输入）', async () => {
    const targets: BrowseOpenTarget[] = [];
    setBrowsePanelOpener((target) => {
      targets.push(target);
    });
    vscodeMock.inputBoxResult = 'https://svn.example.com/repo';
    await commandBrowseRepository(makeUri('/virtual/path', 'vscode-remote'));
    expect(targets).toEqual([{ source: 'remote', url: 'https://svn.example.com/repo' }]);
  });
});

describe('opener 未接入时的提示', () => {
  it('openBrowseTarget：不静默吞动作，提示面板未接入', async () => {
    await openBrowseTarget({ source: 'remote', url: 'https://svn.example.com/repo' });
    expect(vscodeMock.information).toEqual([strings.browse.panelNotReady]);
  });
});

// ---------------------------------------------------------------------------
// P6 交接载荷（查看变更日志）
// ---------------------------------------------------------------------------

describe('P6 历史交接载荷', () => {
  const node: RepoNodeRef = {
    repositoryUuid: 'uuid-1',
    repositoryRootUrl: 'https://svn.example.com/repo',
    rawUrl: 'https://svn.example.com/repo/trunk/a%20b.txt',
    relativePath: 'trunk/a b.txt',
    snapshotRevision: 42,
    lastChangedRevision: 40,
    kind: 'file',
  };

  it('buildHistoryHandoff：只含节点身份与类型（kind/URL/相对路径/revision）', () => {
    expect(buildHistoryHandoff(node)).toEqual({
      kind: 'file',
      repositoryUuid: 'uuid-1',
      repositoryRootUrl: 'https://svn.example.com/repo',
      rawUrl: 'https://svn.example.com/repo/trunk/a%20b.txt',
      relativePath: 'trunk/a b.txt',
      snapshotRevision: 42,
    });
  });

  it('目录节点保留 kind=dir（P6 目录历史与文件历史不同）', () => {
    expect(buildHistoryHandoff({ ...node, kind: 'dir' }).kind).toBe('dir');
  });

  it('openHistoryFromNode：交给注入的 P6 打开器', async () => {
    const received: unknown[] = [];
    setHistoryHandoffHandler((payload) => {
      received.push(payload);
    });
    await openHistoryFromNode(node);
    expect(received).toEqual([buildHistoryHandoff(node)]);
    expect(vscodeMock.information).toHaveLength(0);
  });

  it('未接线（本阶段不注册 showHistory）：明确提示历史面板未提供', async () => {
    await openHistoryFromNode(node);
    expect(vscodeMock.information).toEqual([strings.browse.historyNotReady]);
  });
});
