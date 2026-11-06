/**
 * 检出 core 原语测试：URL 校验矩阵、默认命名、peg 转义矩阵、表单显示
 * 值往返、远端检查（kind=dir 校验、失败分类、凭据注入分支）、检出与
 * 续检参数构建、可续检核验（三元组 + 深度 + revision + status 保守）。
 * svn 子进程经 mock runOrThrow 注入；真实 svn 的烟囱在 checkoutLab.test.ts。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCheckoutArgs,
  buildResumeArgs,
  checkRemote,
  defaultCheckoutName,
  editableURL,
  encodeEditableURL,
  escapeUrlPeg,
  normalizeCheckoutUrl,
  parseInfoXml,
  verifyResumable,
  type ResumableExpectation,
} from '../src/core/checkout';
import { SvnError } from '../src/core/errors';
import { runOrThrow, type RunResult } from '../src/core/svnCli';

vi.mock('../src/core/svnCli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/svnCli')>();
  return { ...actual, runOrThrow: vi.fn() };
});

const UUID = '11111111-2222-3333-4444-555555555555';

function okResult(stdout: string): RunResult {
  return { stdout, stderr: '', exitCode: 0 };
}

afterEach(() => {
  vi.mocked(runOrThrow).mockReset();
});

// ---------------------------------------------------------------------------
// URL 校验矩阵
// ---------------------------------------------------------------------------

describe('normalizeCheckoutUrl', () => {
  it.each([
    'http://host/repo',
    'https://host/repo',
    'svn://host/repo',
    'svn+ssh://host/repo',
    'file:///srv/svn/repo',
    'file://localhost/srv/svn/repo',
  ])('放行五种协议：%s', (url) => {
    expect(normalizeCheckoutUrl(url)).toEqual({ ok: true, url });
  });

  it.each([
    ['http://user:pass@host/repo', 'userinfo'],
    ['https://user@host/repo', 'userinfo'],
    ['svn://svn-user:secret@host/repo', 'userinfo'],
    ['svn+ssh://user@host/repo', 'userinfo'],
  ])('拒绝 authority 段内嵌用户信息：%s', (url, reason) => {
    const result = normalizeCheckoutUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(reason);
      expect(result.message).toContain('用户名');
    }
  });

  it('路径段中的 @ 合法放行（peg 由 escapeUrlPeg 处理）', () => {
    expect(normalizeCheckoutUrl('http://host/repo/a@b')).toEqual({ ok: true, url: 'http://host/repo/a@b' });
    expect(normalizeCheckoutUrl('https://host/a%40b/c@d')).toEqual({ ok: true, url: 'https://host/a%40b/c@d' });
  });

  it.each([
    ['http://host/repo?x=1', 'query'],
    ['https://host/repo#frag', 'fragment'],
    ['svn://host/repo/path?p=1', 'query'],
  ])('拒绝 query/fragment：%s', (url, reason) => {
    const result = normalizeCheckoutUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(reason);
    }
  });

  it.each([
    ['http://host/repo/中文', '非 ASCII'],
    ['http://host/repo/a b', '空格'],
    ['http://host/repo/a\tb', '控制字符'],
  ])('拒绝未编码字符：%s（%s）', (url) => {
    const result = normalizeCheckoutUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unencoded');
      expect(result.message).toContain('未编码');
    }
  });

  it.each([
    'ftp://host/repo',
    'svn+http://host/repo',
    'host/repo',
    'http:/host/repo',
    '',
  ])('拒绝不支持的协议形态：%s', (url) => {
    const result = normalizeCheckoutUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('scheme');
    }
  });
});

// ---------------------------------------------------------------------------
// 默认目录名
// ---------------------------------------------------------------------------

describe('defaultCheckoutName', () => {
  it.each([
    ['https://host/repo/trunk', 'trunk'],
    ['https://host/repo/trunk/', 'trunk'],
    ['https://host/repo/%E4%B8%AD%E6%96%87', '中文'],
    ['https://host/repo/a%20b', 'a b'],
    ['https://host/repo/a@b', 'a@b'],
    ['https://host/repo/a%23b', 'a#b'],
    ['file:///srv/svn/repo/trunk', 'trunk'],
  ])('末段单次解码：%s → %s', (url, expected) => {
    expect(defaultCheckoutName(url)).toBe(expected);
  });

  it('解码失败保留原样编码形态', () => {
    expect(defaultCheckoutName('https://host/repo/%D6%D0')).toBe('%D6%D0');
  });

  it.each([
    ['https://host/repo/..', '上引用'],
    ['https://host/repo/.', '当前目录'],
    ['https://host/repo/a%2Fb', '解码出路径分隔符'],
    ['https://host/repo/%20a%20', '首尾空白'],
    ['https://host/repo/a%01b', '控制字符'],
    ['https://host', '无路径段'],
    ['https://host/', '路径只有空段'],
  ])('非法名兜底返回 undefined：%s（%s）', (url) => {
    expect(defaultCheckoutName(url)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// peg 转义矩阵
// ---------------------------------------------------------------------------

describe('escapeUrlPeg', () => {
  it.each([
    ['https://h/r/a@b', 'https://h/r/a@b@'],
    ['https://h/r/a%40b', 'https://h/r/a%40b@'],
    ['https://h/r/dir%40x/file.txt', 'https://h/r/dir%40x/file.txt@'],
    ['https://h/r/a%2540b', 'https://h/r/a%2540b'],
    ['https://h/r/%D6%D0%40', 'https://h/r/%D6%D0%40@'],
    ['https://h/r/%E4%B8%AD%40x', 'https://h/r/%E4%B8%AD%40x@'],
    ['https://h/r/a%40B', 'https://h/r/a%40B@'],
  ])('peg 判定：%s', (url, expected) => {
    expect(escapeUrlPeg(url)).toBe(expected);
  });

  it('无 @ 与编码段的 URL 原样返回', () => {
    expect(escapeUrlPeg('https://h/repo/trunk')).toBe('https://h/repo/trunk');
    expect(escapeUrlPeg('https://h/r/%E4%B8%AD')).toBe('https://h/r/%E4%B8%AD');
  });

  it('已带尾 @ 的输入剥一补一，幂等不产生双重转义', () => {
    expect(escapeUrlPeg('https://h/r/a@b@')).toBe('https://h/r/a@b@');
    expect(escapeUrlPeg('https://h/r/a%40b@')).toBe('https://h/r/a%40b@');
    // 与未带尾 @ 的输入产出一致。
    expect(escapeUrlPeg('https://h/r/a@b@')).toBe(escapeUrlPeg('https://h/r/a@b'));
    // 尾 @ 剥除后无 @：按无 peg 处理返回剥除后形态（svn 中 abc@ 与 abc 同节点）。
    expect(escapeUrlPeg('https://h/r/abc@')).toBe('https://h/r/abc');
    // 输入双尾 @ 不膨胀（路径本身含尾 @ 的形态保持稳定）。
    expect(escapeUrlPeg('https://h/r/a@b@@')).toBe('https://h/r/a@b@@');
    // 对任意输入，重复应用结果稳定。
    for (const url of ['https://h/r/a@b', 'https://h/r/a%40b', 'https://h/r/abc@', 'https://h/r/x']) {
      expect(escapeUrlPeg(escapeUrlPeg(url))).toBe(escapeUrlPeg(url));
    }
  });

  it('解码失败段回退为段内不区分大小写查找 %40', () => {
    // %D6%D0 是无效 UTF-8 序列，整段 decodeURIComponent 抛错；
    // 段内无 %40 时不触发。
    expect(escapeUrlPeg('https://h/r/%D6%D0')).toBe('https://h/r/%D6%D0');
    expect(escapeUrlPeg('https://h/r/%d6%40')).toBe('https://h/r/%d6%40@');
  });
});

// ---------------------------------------------------------------------------
// 表单显示值与回写逆变换
// ---------------------------------------------------------------------------

describe('editableURL / encodeEditableURL', () => {
  it.each([
    ['https://h/%E4%B8%AD', 'https://h/中'],
    ['https://h/r/a%40b', 'https://h/r/a%40b'],
    ['https://h/r/a%20b', 'https://h/r/a%20b'],
    ['https://h/r/a%23b', 'https://h/r/a%23b'],
    ['https://h/%E4%B8%AD%40x', 'https://h/中%40x'],
    ['https://h/repo/trunk', 'https://h/repo/trunk'],
  ])('显示值：%s → %s', (url, expected) => {
    expect(editableURL(url)).toBe(expected);
  });

  it('解码失败段显示原样', () => {
    expect(editableURL('https://h/r/%D6%D0')).toBe('https://h/r/%D6%D0');
  });

  it.each([
    ['https://h/中', 'https://h/%E4%B8%AD'],
    ['https://h/中2', 'https://h/%E4%B8%AD2'],
    ['https://h/r/a%40b', 'https://h/r/a%40b'],
    ['https://h/repo/trunk', 'https://h/repo/trunk'],
    ['https://h/中/目录%40x', 'https://h/%E4%B8%AD/%E7%9B%AE%E5%BD%95%40x'],
  ])('回写逆变换：%s → %s', (value, expected) => {
    expect(encodeEditableURL(value)).toBe(expected);
  });

  it('显示带出的中文不编辑直接回写，规范值不变；追加 ASCII 不扰动中文段', () => {
    const url = 'https://h/%E4%B8%AD';
    const display = editableURL(url);
    expect(display).toBe('https://h/中');
    expect(encodeEditableURL(display)).toBe('https://h/%E4%B8%AD');
    expect(encodeEditableURL(`${display}2`)).toBe('https://h/%E4%B8%AD2');
  });
});

// ---------------------------------------------------------------------------
// svn info --xml 解析与连接检查
// ---------------------------------------------------------------------------

function infoXml(entry: {
  kind?: string;
  revision?: number;
  url?: string;
  relativeUrl?: string;
  root?: string;
  uuid?: string;
} = {}): string {
  const {
    kind = 'dir', revision = 3, url = 'file:///srv/repo/trunk',
    relativeUrl = '^/trunk', root = 'file:///srv/repo', uuid = UUID,
  } = entry;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<info>',
    `<entry\n   revision="${revision}"\n   kind="${kind}"\n   path="trunk">`,
    `<url>${url}</url>`,
    `<relative-url>${relativeUrl}</relative-url>`,
    '<repository>',
    `<root>${root}</root>`,
    `<uuid>${uuid}</uuid>`,
    '</repository>',
    '</entry>',
    '</info>',
  ].join('\n');
}

describe('parseInfoXml', () => {
  it('解析 entry 的类型、revision 与仓库身份', () => {
    expect(parseInfoXml(infoXml())).toEqual({
      kind: 'dir',
      revision: 3,
      url: 'file:///srv/repo/trunk',
      relativeUrl: '^/trunk',
      repositoryUuid: UUID,
      repositoryRootUrl: 'file:///srv/repo',
    });
  });

  it('无 entry（目标不存在时 svn 输出空 info）返回 undefined', () => {
    expect(parseInfoXml('<?xml version="1.0" encoding="UTF-8"?>\n<info>\n</info>')).toBeUndefined();
  });

  it('字段缺失返回 undefined', () => {
    expect(parseInfoXml('<info><entry kind="dir" revision="3"><url>u</url></entry></info>')).toBeUndefined();
  });
});

function svnError(stderr: string, code?: string): SvnError {
  return new SvnError({ message: stderr.trim(), command: ['info'], stderr, exitCode: 1, code });
}

describe('checkRemote', () => {
  it('dir 目标成功：返回固定 revision 与身份三元组', async () => {
    vi.mocked(runOrThrow).mockResolvedValue(okResult(infoXml({ revision: 7 })));
    const result = await checkRemote('svn', 'https://h/repo/trunk');
    expect(result).toEqual({
      ok: true,
      pinnedRevision: 7,
      identity: {
        repositoryUuid: UUID,
        repositoryRootUrl: 'file:///srv/repo',
        relativeUrl: '^/trunk',
      },
    });
    expect(vi.mocked(runOrThrow).mock.calls[0][1]).toEqual([
      'info', '--xml', '--non-interactive', '--', 'https://h/repo/trunk',
    ]);
  });

  it('revision 参数：具体值传 -r，HEAD 与缺省不传', async () => {
    vi.mocked(runOrThrow).mockResolvedValue(okResult(infoXml()));
    await checkRemote('svn', 'https://h/repo/trunk', { revision: 5 });
    expect(vi.mocked(runOrThrow).mock.calls[0][1]).toContain('-r');
    expect(vi.mocked(runOrThrow).mock.calls[0][1]).toEqual([
      'info', '--xml', '--non-interactive', '-r', '5', '--', 'https://h/repo/trunk',
    ]);
    vi.mocked(runOrThrow).mockClear();
    await checkRemote('svn', 'https://h/repo/trunk', { revision: 'HEAD' });
    expect(vi.mocked(runOrThrow).mock.calls[0][1]).not.toContain('-r');
  });

  it('URL 走 peg 规则：含 %40 时补尾 @', async () => {
    vi.mocked(runOrThrow).mockResolvedValue(okResult(infoXml()));
    await checkRemote('svn', 'https://h/repo/a%40b');
    expect(vi.mocked(runOrThrow).mock.calls[0][1].at(-1)).toBe('https://h/repo/a%40b@');
  });

  it('file 节点 info 成功但判「目标不是目录」', async () => {
    vi.mocked(runOrThrow).mockResolvedValue(okResult(infoXml({ kind: 'file' })));
    const result = await checkRemote('svn', 'https://h/repo/a.txt');
    expect(result).toEqual({ ok: false, failure: 'notDir', message: '目标不是目录' });
  });

  it.each([
    ['E200009', 'urlNotFound', 'svn: warning: W170000: URL non-existent\nsvn: E200009: Could not display info for all targets'],
    ['E160006', 'revisionNotFound', 'svn: E160006: No such revision 99'],
    ['E175002', 'connection', 'svn: E175002: Unable to connect to a repository'],
  ])('失败分类：%s → %s', async (_code, failure, stderr) => {
    vi.mocked(runOrThrow).mockRejectedValue(svnError(stderr));
    const result = await checkRemote('svn', 'https://h/repo/trunk');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe(failure);
    }
  });

  it('W170000 文本（无 E 码）也归 URL 不存在', async () => {
    vi.mocked(runOrThrow).mockRejectedValue(svnError('svn: warning: W170000: URL non-existent in revision 0'));
    const result = await checkRemote('svn', 'https://h/repo/trunk');
    expect(result).toMatchObject({ ok: false, failure: 'urlNotFound' });
  });

  it('认证失败文本归类 auth', async () => {
    vi.mocked(runOrThrow).mockRejectedValue(svnError('svn: E170001: Authorization failed'));
    const result = await checkRemote('svn', 'https://h/repo/trunk');
    expect(result).toMatchObject({ ok: false, failure: 'auth' });
  });

  it('不可归类错误兜底 unknown', async () => {
    vi.mocked(runOrThrow).mockRejectedValue(new Error('boom'));
    const result = await checkRemote('svn', 'https://h/repo/trunk');
    expect(result).toMatchObject({ ok: false, failure: 'unknown' });
  });

  it('退出码 0 但无 entry 判 URL 不存在', async () => {
    vi.mocked(runOrThrow).mockResolvedValue(okResult('<info>\n</info>'));
    const result = await checkRemote('svn', 'https://h/repo/trunk');
    expect(result).toMatchObject({ ok: false, failure: 'urlNotFound' });
  });

  it('凭据注入按协议分支：http/https/svn 透传，svn+ssh/file 剥离', async () => {
    const getCredentials = async () => ({ username: 'u', password: 'p' });
    vi.mocked(runOrThrow).mockResolvedValue(okResult(infoXml()));
    await checkRemote('svn', 'https://h/repo/trunk', { getCredentials });
    expect(vi.mocked(runOrThrow).mock.calls[0][2]?.getCredentials).toBe(getCredentials);
    vi.mocked(runOrThrow).mockClear();
    await checkRemote('svn', 'svn+ssh://h/repo/trunk', { getCredentials });
    expect(vi.mocked(runOrThrow).mock.calls[0][2]?.getCredentials).toBeUndefined();
    vi.mocked(runOrThrow).mockClear();
    await checkRemote('svn', 'file:///srv/repo', { getCredentials });
    expect(vi.mocked(runOrThrow).mock.calls[0][2]?.getCredentials).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 检出与续检参数构建
// ---------------------------------------------------------------------------

describe('buildCheckoutArgs', () => {
  it('命令形态：--non-interactive -r <pinned> --depth <depth>，URL 做 peg 处理、目标按字面路径', () => {
    expect(buildCheckoutArgs('https://h/repo/trunk', '/tmp/wc', { revision: 5, depth: 'immediates' })).toEqual([
      'checkout', '--non-interactive', '-r', '5', '--depth', 'immediates',
      'https://h/repo/trunk', '/tmp/wc',
    ]);
    expect(buildCheckoutArgs('https://h/repo/a%40b', '/tmp/wc', { revision: 1, depth: 'empty' })).toEqual([
      'checkout', '--non-interactive', '-r', '1', '--depth', 'empty',
      'https://h/repo/a%40b@', '/tmp/wc',
    ]);
    // checkout 的目标参数不做 peg 解析（实测补尾 @ 会建出以 @ 结尾的
    // 错误目录名），含 @ 的目标目录名原样传递。
    expect(buildCheckoutArgs('https://h/repo/trunk', '/tmp/wc@x', { revision: 2, depth: 'files' })).toEqual([
      'checkout', '--non-interactive', '-r', '2', '--depth', 'files',
      'https://h/repo/trunk', '/tmp/wc@x',
    ]);
    // 短横线开头的目标加 ./ 前缀防止被当作选项。
    expect(buildCheckoutArgs('https://h/repo/trunk', '-weird', { revision: 2, depth: 'infinity' })).toEqual([
      'checkout', '--non-interactive', '-r', '2', '--depth', 'infinity',
      'https://h/repo/trunk', './-weird',
    ]);
  });
});

describe('buildResumeArgs', () => {
  it('续检序列：先 cleanup 再 update --set-depth（深度口径与 checkout 的 --depth 区分）', () => {
    const { cleanupArgs, updateArgs } = buildResumeArgs('/tmp/wc', { pinnedRevision: 3, depth: 'immediates' });
    expect(cleanupArgs).toEqual(['cleanup', '/tmp/wc']);
    expect(updateArgs).toEqual([
      'update', '--non-interactive', '-r', '3', '--set-depth', 'immediates', '/tmp/wc',
    ]);
  });

  it('目标含 @ 时两侧命令都转义', () => {
    const { cleanupArgs, updateArgs } = buildResumeArgs('/tmp/wc@x', { pinnedRevision: 1, depth: 'infinity' });
    expect(cleanupArgs).toEqual(['cleanup', '/tmp/wc@x@']);
    expect(updateArgs.at(-1)).toBe('/tmp/wc@x@');
  });
});

// ---------------------------------------------------------------------------
// 可续检核验
// ---------------------------------------------------------------------------

const EMPTY_STATUS_XML = '<?xml version="1.0" encoding="UTF-8"?>\n<status>\n<target path=".">\n</target>\n</status>';

function infoText(overrides: { url?: string; uuid?: string; root?: string; revision?: string } = {}): string {
  return [
    'Path: wc',
    `URL: ${overrides.url ?? 'file:///srv/repo/trunk'}`,
    'Relative URL: ^/trunk',
    `Repository Root: ${overrides.root ?? 'file:///srv/repo'}`,
    `Repository UUID: ${overrides.uuid ?? UUID}`,
    `Revision: ${overrides.revision ?? '3'}`,
    'Node Kind: directory',
    'Schedule: normal',
  ].join('\n');
}

const DEFAULT_EXPECTATION: ResumableExpectation = {
  repositoryUuid: UUID,
  repositoryRootUrl: 'file:///srv/repo',
  relativeUrl: '^/trunk',
  depth: 'infinity',
  pinnedRevision: 3,
};

/** 默认核验链 mock：文本 info + relative-url ^/trunk + depth infinity + 空 status。 */
function mockVerifyWorkflow(overrides: {
  info?: () => RunResult;
  relativeUrl?: () => RunResult;
  depth?: () => RunResult;
  status?: () => RunResult;
} = {}): void {
  vi.mocked(runOrThrow).mockImplementation(async (_svnPath: string, args: string[]) => {
    if (args[0] === 'status') {
      return overrides.status ? overrides.status() : okResult(EMPTY_STATUS_XML);
    }
    if (args.includes('--show-item')) {
      const item = args[args.indexOf('--show-item') + 1];
      if (item === 'relative-url') {
        return overrides.relativeUrl ? overrides.relativeUrl() : okResult('^/trunk\n');
      }
      return overrides.depth ? overrides.depth() : okResult('infinity\n');
    }
    if (args[0] === 'info') {
      return overrides.info ? overrides.info() : okResult(infoText());
    }
    throw new Error(`测试未预期的 svn 调用: ${args.join(' ')}`);
  });
}

describe('verifyResumable', () => {
  it('三元组一致 ∧ 深度一致 ∧ 工作 revision ≤ 固定 revision → resumable', async () => {
    mockVerifyWorkflow();
    const report = await verifyResumable('svn', '/tmp/wc', DEFAULT_EXPECTATION);
    expect(report.kind).toBe('resumable');
    expect(report.identity).toMatchObject({
      url: 'file:///srv/repo/trunk',
      repositoryUuid: UUID,
      repositoryRootUrl: 'file:///srv/repo',
      relativeUrl: '^/trunk',
      depth: 'infinity',
      workingRevision: 3,
    });
    expect(report.status?.entries).toEqual([]);
  });

  it('不做 URL 字符串直比：副本 URL 字符串与记录不同但三元组一致仍可续', async () => {
    mockVerifyWorkflow({ info: () => okResult(infoText({ url: 'file:///srv/repo/trunk/' })) });
    const report = await verifyResumable('svn', '/tmp/wc', DEFAULT_EXPECTATION);
    expect(report.kind).toBe('resumable');
  });

  it('status 有 missing 等未完成条目不阻断（供展示，不据此自动清除）', async () => {
    const missingStatus = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<status>',
      '<target path=".">',
      '<entry path="sub/deep.txt">',
      '<wc-status item="missing" revision="3"></wc-status>',
      '</entry>',
      '</target>',
      '</status>',
    ].join('\n');
    mockVerifyWorkflow({ status: () => okResult(missingStatus) });
    const report = await verifyResumable('svn', '/tmp/wc', DEFAULT_EXPECTATION);
    expect(report.kind).toBe('resumable');
    expect(report.status?.entries[0]).toMatchObject({ path: 'sub/deep.txt', wcStatus: 'missing' });
  });

  it.each([
    ['uuid 不一致', { info: () => okResult(infoText({ uuid: '99999999-9999-9999-9999-999999999999' })) }, 'identityMismatch'],
    [
      'relative-url 不一致',
      { relativeUrl: () => okResult('^/branches/other\n') },
      'identityMismatch',
    ],
    ['深度不一致', { depth: () => okResult('immediates\n') }, 'depthMismatch'],
    ['工作 revision 超过固定 revision', { info: () => okResult(infoText({ revision: '9' })) }, 'revisionMismatch'],
  ])('%s → resumeBlocked（%s）', async (_name, overrides, reason) => {
    mockVerifyWorkflow(overrides);
    const report = await verifyResumable('svn', '/tmp/wc', DEFAULT_EXPECTATION);
    expect(report.kind).toBe('resumeBlocked');
    expect(report.blockReason).toBe(reason);
  });

  it('身份读取失败 → readFailed（无法核验即不放行）', async () => {
    vi.mocked(runOrThrow).mockRejectedValue(svnError('svn: E155004: Working copy locked', 'E155004'));
    const report = await verifyResumable('svn', '/tmp/wc', DEFAULT_EXPECTATION);
    expect(report).toMatchObject({ kind: 'resumeBlocked', blockReason: 'readFailed' });
  });

  it('status 读取失败 → statusFailed（保守阻断）', async () => {
    mockVerifyWorkflow({
      status: () => {
        throw svnError('svn: E155015: locked', 'E155015');
      },
    });
    const report = await verifyResumable('svn', '/tmp/wc', DEFAULT_EXPECTATION);
    expect(report).toMatchObject({ kind: 'resumeBlocked', blockReason: 'statusFailed' });
    // 已读到的身份仍随报告返回，供核验页展示差异。
    expect(report.identity?.repositoryUuid).toBe(UUID);
  });

  it('status 调用固定不限时（大副本本地遍历可超默认 120 秒）', async () => {
    mockVerifyWorkflow();
    await verifyResumable('svn', '/tmp/wc', DEFAULT_EXPECTATION);
    const statusCall = vi.mocked(runOrThrow).mock.calls.find(([, args]) => args[0] === 'status');
    expect(statusCall?.[2]?.timeoutMs).toBe(0);
  });
});
