/**
 * 远端信息 core 原语测试：容错读取矩阵（全字段成功、根字段缺失时节点
 * URL 条目仍构造、未版本控制、svn 缺失、其他失败）、逐段解码
 * （@/#/中文/空格、控制字符重转义、解码失败段原样）、原始 URI 保留、
 * 四信息项构造（相对路径优先 Relative URL 字段、缺失回退计算）与含 @
 * 相对路径的 CLI 提示标记。svn 子进程经 mock runOrThrow 注入。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyInfoError,
  displayDecoded,
  isCredentialScheme,
  readNodeUrl,
  readRemoteInfo,
  type RemoteInfoEntry,
} from '../src/core/remoteInfo';
import { SvnError, extractSvnErrorCodes, tailText } from '../src/core/errors';
import { runOrThrow, type RunResult } from '../src/core/svnCli';

vi.mock('../src/core/svnCli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/svnCli')>();
  return { ...actual, runOrThrow: vi.fn() };
});

function okResult(stdout: string): RunResult {
  return { stdout, stderr: '', exitCode: 0 };
}

function svnError(stderr: string, code?: string): SvnError {
  return new SvnError({
    message: tailText(stderr.trim() || 'svn info 失败'),
    command: ['info'],
    stderr,
    exitCode: 1,
    code: code ?? extractSvnErrorCodes(stderr)[0],
  });
}

const asRaw = vi.mocked(runOrThrow);

afterEach(() => {
  asRaw.mockReset();
});

/** 真实 svn info 文本形态的夹具（字段可按用例裁剪）。 */
function infoStdout(fields: Partial<Record<'url' | 'rootUrl' | 'uuid' | 'relativeUrl', string>>): string {
  const lines: string[] = ['Path: src'];
  if (fields.url !== undefined) lines.push(`URL: ${fields.url}`);
  if (fields.relativeUrl !== undefined) lines.push(`Relative URL: ${fields.relativeUrl}`);
  if (fields.rootUrl !== undefined) lines.push(`Repository Root: ${fields.rootUrl}`);
  if (fields.uuid !== undefined) lines.push(`Repository UUID: ${fields.uuid}`);
  lines.push('Revision: 7', 'Node Kind: directory', 'Schedule: normal');
  return lines.join('\n');
}

const entryRaw = (entries: RemoteInfoEntry[], kind: string) => entries.find((e) => e.kind === kind)?.raw;

// ---------------------------------------------------------------------------
// 展示值逐段解码
// ---------------------------------------------------------------------------

describe('displayDecoded', () => {
  it.each([
    ['https://h/repo/%E4%B8%AD%E6%96%87/a.txt', 'https://h/repo/中文/a.txt'],
    ['https://h/repo/a%20b.txt', 'https://h/repo/a b.txt'],
    ['https://h/repo/a%40b.txt', 'https://h/repo/a@b.txt'],
    ['https://h/repo/a%23b.txt', 'https://h/repo/a#b.txt'],
  ])('单次逐段解码：%s', (value, expected) => {
    expect(displayDecoded(value)).toBe(expected);
  });

  it.each([
    ['%00', '%00'],
    ['%0A', '%0A'],
    ['%1F', '%1F'],
    ['%7F', '%7F'],
  ])('控制字符解码后重新转义：%s', (segment, expected) => {
    expect(displayDecoded(`https://h/a${segment}b`)).toBe(`https://h/a${expected}b`);
  });

  it('解码失败段（无效 UTF-8 序列）原样保留，其余段照常解码', () => {
    expect(displayDecoded('https://h/%D6%D0/%E4%B8%AD')).toBe('https://h/%D6%D0/中');
  });

  it('无百分号编码的值原样返回', () => {
    expect(displayDecoded('file:///srv/repo/trunk')).toBe('file:///srv/repo/trunk');
  });
});

// ---------------------------------------------------------------------------
// scheme 分支与失败分类
// ---------------------------------------------------------------------------

describe('isCredentialScheme', () => {
  it.each([
    ['http://h/repo', true],
    ['https://h/repo', true],
    ['svn://h/repo', true],
    ['svn+ssh://h/repo', false],
    ['file:///srv/repo', false],
    ['file://localhost/srv/repo', false],
    ['not-a-url', false],
  ])('%s → %s', (url, expected) => {
    expect(isCredentialScheme(url)).toBe(expected);
  });
});

describe('classifyInfoError', () => {
  it.each([
    ['svn: E200009: Target does not exist', 'unversioned'],
    ['svn: E155007: Path is not a working copy', 'unversioned'],
  ])('%s → 未版本控制', (stderr, reason) => {
    expect(classifyInfoError(svnError(stderr)).reason).toBe(reason);
  });

  it('spawn ENOENT → svn 缺失（不误报未版本控制）', () => {
    expect(classifyInfoError(svnError('spawn svn ENOENT', 'ENOENT')).reason).toBe('svnMissing');
  });

  it('其他失败原样分类为 failed', () => {
    expect(classifyInfoError(svnError('svn: E155004: Working copy locked')).reason).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// 容错读取
// ---------------------------------------------------------------------------

describe('readRemoteInfo', () => {
  it('全字段成功：四条目构造、原始 URI 保留、展示值解码', async () => {
    asRaw.mockResolvedValue(okResult(infoStdout({
      url: 'https://h/repo/%E4%B8%AD%E6%96%87/src',
      relativeUrl: '^/%E4%B8%AD%E6%96%87/src',
      rootUrl: 'https://h/repo',
      uuid: '11111111-2222-3333-4444-555555555555',
    })));
    const result = await readRemoteInfo('svn', '/wc/src');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.missing).toEqual([]);
    expect(result.entries.map((e) => e.kind)).toEqual(['nodeUrl', 'rootUrl', 'uuid', 'relativePath']);
    // 复制值是 svn 输出原样（编码形态），展示值才解码。
    expect(entryRaw(result.entries, 'nodeUrl')).toBe('https://h/repo/%E4%B8%AD%E6%96%87/src');
    expect(result.entries[0]?.display).toBe('https://h/repo/中文/src');
    expect(result.entries[1]?.raw).toBe('https://h/repo');
    expect(result.entries[2]?.raw).toBe('11111111-2222-3333-4444-555555555555');
    expect(entryRaw(result.entries, 'relativePath')).toBe('^/%E4%B8%AD%E6%96%87/src');
    expect(asRaw.mock.calls[0]?.[1]).toEqual(['info', '--', '/wc/src']);
  });

  it('目标路径含 @ 时按 peg 规则转义', async () => {
    asRaw.mockResolvedValue(okResult(infoStdout({ url: 'https://h/repo/a%40b' })));
    await readRemoteInfo('svn', '/wc/a@b');
    expect(asRaw.mock.calls[0]?.[1]).toEqual(['info', '--', '/wc/a@b@']);
  });

  it('根字段失败（输出缺 Repository Root）：节点 URL 条目仍可构造，根列为缺失', async () => {
    asRaw.mockResolvedValue(okResult(infoStdout({
      url: 'https://h/repo/src',
      relativeUrl: '^/src',
      uuid: '11111111-2222-3333-4444-555555555555',
    })));
    const result = await readRemoteInfo('svn', '/wc/src');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.missing).toEqual(['rootUrl']);
    expect(entryRaw(result.entries, 'nodeUrl')).toBe('https://h/repo/src');
    expect(entryRaw(result.entries, 'relativePath')).toBe('^/src');
  });

  it('Relative URL 字段缺失时回退「节点 URL 去根前缀」计算，编码段保留', async () => {
    asRaw.mockResolvedValue(okResult(infoStdout({
      url: 'https://h/repo/%E4%B8%AD/src',
      rootUrl: 'https://h/repo',
      uuid: '11111111-2222-3333-4444-555555555555',
    })));
    const result = await readRemoteInfo('svn', '/wc/src');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.missing).toEqual([]);
    expect(entryRaw(result.entries, 'relativePath')).toBe('^/%E4%B8%AD/src');
    expect(result.entries[3]?.display).toBe('^/中/src');
  });

  it('节点即仓库根时相对路径为 ^/', async () => {
    asRaw.mockResolvedValue(okResult(infoStdout({
      url: 'https://h/repo',
      rootUrl: 'https://h/repo',
    })));
    const result = await readRemoteInfo('svn', '/wc');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(entryRaw(result.entries, 'relativePath')).toBe('^/');
  });

  it('输出全空（退出码 0）：四项全部缺失、不视为失败', async () => {
    asRaw.mockResolvedValue(okResult(''));
    const result = await readRemoteInfo('svn', '/wc');
    expect(result).toEqual({ ok: true, entries: [], missing: ['nodeUrl', 'rootUrl', 'uuid', 'relativePath'] });
  });

  it.each([
    ['svn: E200009: Target does not exist', 'unversioned'],
    ['svn: E155007: Path is not a working copy', 'unversioned'],
  ])('未版本控制错误码 %s → %s', async (stderr, reason) => {
    asRaw.mockRejectedValue(svnError(stderr));
    const result = await readRemoteInfo('svn', '/wc/x');
    expect(result).toMatchObject({ ok: false, reason });
  });

  it('spawn ENOENT → svnMissing', async () => {
    asRaw.mockRejectedValue(svnError('spawn svn ENOENT', 'ENOENT'));
    const result = await readRemoteInfo('svn', '/wc/x');
    expect(result).toMatchObject({ ok: false, reason: 'svnMissing' });
  });

  it('其他失败原样带原因与原始错误', async () => {
    const error = svnError('svn: E155004: Working copy locked');
    asRaw.mockRejectedValue(error);
    const result = await readRemoteInfo('svn', '/wc/x');
    expect(result).toMatchObject({ ok: false, reason: 'failed' });
    if (!result.ok) {
      expect(result.error).toBe(error);
      expect(result.message).toContain('E155004');
    }
  });
});

// ---------------------------------------------------------------------------
// 含 @ 相对路径的 CLI 提示标记
// ---------------------------------------------------------------------------

describe('相对路径含 @ 的提示标记', () => {
  it('字面 @：needsPegHint 为 true，raw 原样复制', async () => {
    asRaw.mockResolvedValue(okResult(infoStdout({
      url: 'https://h/repo/trunk/imp@1',
      relativeUrl: '^/trunk/imp@1',
      rootUrl: 'https://h/repo',
      uuid: '11111111-2222-3333-4444-555555555555',
    })));
    const result = await readRemoteInfo('svn', '/wc/trunk/imp@1');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const relative = result.entries.find((e) => e.kind === 'relativePath');
    expect(relative?.raw).toBe('^/trunk/imp@1');
    expect(relative?.needsPegHint).toBe(true);
    // core 层的标记对含 @ 的条目中性置位（节点 URL 命令行使用同样触发
    // peg 语法）；宿主只对相对路径条目渲染提示文案。
    expect(result.entries[0]?.needsPegHint).toBe(true);
  });

  it('编码 %40 解码出 @ 同样标记；无 @ 不标记', async () => {
    asRaw.mockResolvedValue(okResult(infoStdout({
      url: 'https://h/repo/a%40b',
      relativeUrl: '^/a%40b',
      rootUrl: 'https://h/repo',
    })));
    const result = await readRemoteInfo('svn', '/wc/a@b');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.entries.find((e) => e.kind === 'relativePath')?.display).toBe('^/a@b');
    expect(result.entries.find((e) => e.kind === 'relativePath')?.needsPegHint).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 节点 URL 单字段读取（scheme 分支依据）
// ---------------------------------------------------------------------------

describe('readNodeUrl', () => {
  it('返回 --show-item url 的输出（trim 后）', async () => {
    asRaw.mockResolvedValue(okResult('https://h/repo/src\n'));
    await expect(readNodeUrl('svn', '/wc/src')).resolves.toBe('https://h/repo/src');
    expect(asRaw.mock.calls[0]?.[1]).toEqual(['info', '--show-item', 'url', '/wc/src']);
  });

  it('输出为空时抛解析错误', async () => {
    asRaw.mockResolvedValue(okResult(''));
    await expect(readNodeUrl('svn', '/wc/src')).rejects.toMatchObject({ code: 'INFO_PARSE' });
  });

  it('命令失败原样抛 SvnError（分类由调用方承担）', async () => {
    asRaw.mockRejectedValue(svnError('svn: E200009: Target does not exist'));
    await expect(readNodeUrl('svn', '/wc/x')).rejects.toMatchObject({ code: 'E200009' });
  });
});
