/**
 * 远端仓库浏览 core 原语测试（core/remoteBrowse）：
 * - info --xml 解析：快照 revision 与最后修改 revision 分字段、文件 size、
 *   原始 URL 保留、相对路径逐段解码、缺字段判解析失败；
 * - list --xml 流式 SAX：不 trim、实体一次解码、CDATA、中文/emoji 任意
 *   分块、commit 元数据；100k/64 MiB 预算以小参数复现 tooLarge；
 * - 空目录与不存在路径同为 XML 空骨架时，必须按 exit code + stderr 区分
 *   （真实 svnadmin + file://：空目录 ready+0、不存在 notFound）；
 * - 节点 URL 由父原始 URL + 条目名称逐段编码（@/#/空格/中文/&）；
 * - 远端属性 propget --xml：属性存在/缺失（W200017）/路径不存在；
 * - 错误分类矩阵（auth/permission/network/notFound/revisionNotFound）。
 * XML fixture 全部内联；真实 svn 行为用 test/helpers 的本地实验仓库。
 */
import { execSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLogXml, buildHistoryLogArgs, createTargetSource } from '../src/core/history';
import { run } from '../src/core/svnCli';
import {
  BINARY_PROBE_BYTES,
  BrowseLimitExceededError,
  DirectoryListParser,
  REMOTE_BROWSE_MAX_ENTRIES,
  REMOTE_BROWSE_MAX_XML_BYTES,
  appendRelativePath,
  appendUrlSegment,
  buildRemoteInfoArgs,
  buildRemoteListArgs,
  buildRemoteNameListArgs,
  buildRemotePropgetArgs,
  classifyBrowseFailure,
  entryNodeRef,
  extractSvnStatusCodes,
  hasNulByte,
  mimeTypeIsBinary,
  parseDirectoryListXml,
  parseDirectoryNameList,
  parseRemoteInfoXml,
  parseRemotePropertyXml,
  readRemoteDirectory,
  readRemoteDirectoryNames,
  readRemoteMimeType,
  readRemoteNode,
  relativePathFromRelativeUrl,
  withRemoteAuthScope,
  type RepoNodeRef,
} from '../src/core/remoteBrowse';
import { SvnError } from '../src/core/errors';
import { createSvnLab, writeFile } from './helpers';

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

function svnFailure(stderr: string, code?: string, exitCode = 1): SvnError {
  return new SvnError({
    message: stderr.trim() || 'svn 失败',
    command: ['info'],
    stderr,
    exitCode,
    code: code ?? /\bE\d{6}\b/.exec(stderr)?.[0],
  });
}

/** 把 Buffer 按给定块长循环切分（模拟管道任意分块边界）。 */
function chunkBuffer(data: Buffer, sizes: readonly number[]): Buffer[] {
  const chunks: Buffer[] = [];
  let offset = 0;
  let index = 0;
  while (offset < data.length) {
    const size = sizes[index % sizes.length] ?? 1;
    chunks.push(data.subarray(offset, Math.min(offset + size, data.length)));
    offset += size;
    index += 1;
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// info --xml 解析
// ---------------------------------------------------------------------------

const INFO_FILE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<info>
<entry
   size="7"
   path="with space &amp; 中文.txt"
   revision="7"
   kind="file">
<url>https://example.com/repo/trunk/with%20space%20&amp;%20%E4%B8%AD%E6%96%87.txt</url>
<relative-url>^/trunk/with%20space%20&amp;%20%E4%B8%AD%E6%96%87.txt</relative-url>
<repository>
<root>https://example.com/repo</root>
<uuid>uuid-1</uuid>
</repository>
<commit
   revision="3">
<author>alice</author>
<date>2026-11-01T10:00:00.000000Z</date>
</commit>
</entry>
</info>`;

const INFO_ROOT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<info>
<entry path="" revision="5" kind="dir">
<url>https://example.com/repo</url>
<relative-url>^/</relative-url>
<repository><root>https://example.com/repo</root><uuid>uuid-1</uuid></repository>
<commit revision="5"><author>bob</author><date>DT</date></commit>
</entry>
</info>`;

describe('parseRemoteInfoXml', () => {
  it('快照 revision 与最后修改 revision 分字段，size/作者/时间/原始 URL 保留', () => {
    const parsed = parseRemoteInfoXml(INFO_FILE_XML);
    expect(parsed).toBeDefined();
    const node = parsed!.node;
    expect(node.snapshotRevision).toBe(7);
    expect(node.lastChangedRevision).toBe(3);
    expect(node.lastChangedAuthor).toBe('alice');
    expect(node.lastChangedDate).toBe('2026-11-01T10:00:00.000000Z');
    expect(node.kind).toBe('file');
    expect(parsed!.sizeBytes).toBe(7);
    // 原始 URL 保留百分号编码与字面 &（XML 实体只解码一次）。
    expect(node.rawUrl).toBe(
      'https://example.com/repo/trunk/with%20space%20&%20%E4%B8%AD%E6%96%87.txt',
    );
    expect(node.repositoryRootUrl).toBe('https://example.com/repo');
    expect(node.repositoryUuid).toBe('uuid-1');
    // 相对路径逐段解码，与 list 的原始 <name> 同一形态。
    expect(node.relativePath).toBe('trunk/with space & 中文.txt');
  });

  it('仓库根节点：relative-url ^/ 得到空相对路径，目录无 size', () => {
    const parsed = parseRemoteInfoXml(INFO_ROOT_XML);
    expect(parsed).toBeDefined();
    expect(parsed!.node.relativePath).toBe('');
    expect(parsed!.node.kind).toBe('dir');
    expect(parsed!.sizeBytes).toBeUndefined();
  });

  it('缺 relative-url 时由 URL 与仓库根推导（不二次解码原始 URL）', () => {
    const xml = INFO_FILE_XML.replace(
      '<relative-url>^/trunk/with%20space%20&amp;%20%E4%B8%AD%E6%96%87.txt</relative-url>',
      '',
    );
    expect(parseRemoteInfoXml(xml)?.node.relativePath).toBe('trunk/with space & 中文.txt');
  });

  it('URL 不在仓库根下且缺 relative-url 时判解析失败', () => {
    const xml = INFO_FILE_XML
      .replace(
        '<url>https://example.com/repo/trunk/with%20space%20&amp;%20%E4%B8%AD%E6%96%87.txt</url>',
        '<url>https://other.example.com/elsewhere.txt</url>',
      )
      .replace(
        '<relative-url>^/trunk/with%20space%20&amp;%20%E4%B8%AD%E6%96%87.txt</relative-url>',
        '',
      );
    expect(parseRemoteInfoXml(xml)).toBeUndefined();
  });

  it('关键字段缺失（uuid/kind/entry revision）判解析失败', () => {
    expect(parseRemoteInfoXml(INFO_FILE_XML.replace('<uuid>uuid-1</uuid>', ''))).toBeUndefined();
    expect(parseRemoteInfoXml(INFO_FILE_XML.replace(' kind="file"', ''))).toBeUndefined();
    expect(parseRemoteInfoXml(INFO_FILE_XML.replace(' revision="7"', ''))).toBeUndefined();
    expect(parseRemoteInfoXml('<info></info>')).toBeUndefined();
  });

  it('空骨架 <info/> 不产生条目（absent 必须由退出码判定，不靠空 XML）', () => {
    expect(parseRemoteInfoXml('<?xml version="1.0"?><info></info>')).toBeUndefined();
  });

  it('含字面 @ 的 URL 与相对路径原样保留（再由 urlWithPeg 统一补 peg）', () => {
    const xml = `<?xml version="1.0"?>
<info><entry kind="file" revision="4"><url>https://h/repo/trunk/at@file#1.txt</url>
<relative-url>^/trunk/at@file#1.txt</relative-url>
<repository><root>https://h/repo</root><uuid>u</uuid></repository>
<commit revision="4"><author>a</author><date>d</date></commit></entry></info>`;
    const node = parseRemoteInfoXml(xml)!.node;
    expect(node.rawUrl).toBe('https://h/repo/trunk/at@file#1.txt');
    expect(node.relativePath).toBe('trunk/at@file#1.txt');
  });
});

// ---------------------------------------------------------------------------
// list --xml 流式解析
// ---------------------------------------------------------------------------

const LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<lists>
<list path=" https://example.com/repo/ trunk ">
<entry kind="file">
<name> leading and trailing </name>
<size>12</size>
<commit revision="3"><author>alice</author><date>2026-11-01T10:00:00Z</date></commit>
</entry>
<entry kind="file">
<name>a&amp;b &lt;tag&gt; &#20013;&#25991; &#x4E2D;</name>
</entry>
<entry kind="file">
<name><![CDATA[raw <tag> & text]]></name>
</entry>
<entry kind="dir">
<name>中文 目录/at@file#1.txt</name>
<commit revision="4"><author>bot</author><date>D</date></commit>
</entry>
<entry kind="file">
<name>emoji 🚀 名称.txt</name>
<size>0</size>
</entry>
</list>
</lists>`;

describe('parseDirectoryListXml（saxes 流式）', () => {
  it('名称不 trim、实体一次解码、CDATA 当文本、commit/size 元数据齐全', () => {
    const listing = parseDirectoryListXml(LIST_XML);
    expect(listing.listPath).toBe(' https://example.com/repo/ trunk ');
    expect(listing.total).toBe(5);
    expect(listing.entries).toEqual([
      {
        name: ' leading and trailing ',
        kind: 'file',
        sizeBytes: 12,
        lastChangedRevision: 3,
        lastChangedAuthor: 'alice',
        lastChangedDate: '2026-11-01T10:00:00Z',
      },
      { name: 'a&b <tag> 中文 中', kind: 'file' },
      { name: 'raw <tag> & text', kind: 'file' },
      {
        name: '中文 目录/at@file#1.txt',
        kind: 'dir',
        lastChangedRevision: 4,
        lastChangedAuthor: 'bot',
        lastChangedDate: 'D',
      },
      { name: 'emoji 🚀 名称.txt', kind: 'file', sizeBytes: 0 },
    ]);
  });

  it('任意字节分块（切在多字节字符中间）与整段结果一致且无替换符', () => {
    const data = Buffer.from(LIST_XML, 'utf8');
    const whole = parseDirectoryListXml(data);
    for (const sizes of [[1], [2], [3], [1, 2, 3, 5, 7], [64 * 1024]]) {
      expect(parseDirectoryListXml(chunkBuffer(data, sizes))).toEqual(whole);
    }
    for (const entry of whole.entries) {
      expect(entry.name).not.toContain('�');
    }
  });

  it('流式写入累计原始字节数（bytesRead）', () => {
    const parser = new DirectoryListParser();
    const data = Buffer.from(LIST_XML, 'utf8');
    for (const chunk of chunkBuffer(data, [7])) {
      parser.write(chunk);
    }
    const listing = parser.end();
    expect(listing.xmlBytes).toBe(data.length);
    expect(parser.bytesRead).toBe(data.length);
  });

  it('空目录骨架：<lists><list/></lists> 解析为 0 条目（ready 判定由 exit 0 承担）', () => {
    const listing = parseDirectoryListXml(
      '<?xml version="1.0"?><lists><list path="https://h/repo/trunk/empty"></list></lists>',
    );
    expect(listing.total).toBe(0);
    expect(listing.entries).toEqual([]);
  });

  it('缺 <list> 根元素或 XML 不完整时抛解析错误', () => {
    expect(() => parseDirectoryListXml('<lists></lists>')).toThrow();
    expect(() => parseDirectoryListXml('<lists><list path="x"><entry>')).toThrow();
  });

  it('条目预算：超过 maxEntries 立即以 entries 原因中止（不返回部分条目）', () => {
    try {
      parseDirectoryListXml(LIST_XML, { maxEntries: 2 });
      expect.unreachable('应当抛出 BrowseLimitExceededError');
    } catch (err) {
      expect(err).toBeInstanceOf(BrowseLimitExceededError);
      const limit = err as BrowseLimitExceededError;
      expect(limit.reason).toBe('entries');
      expect(limit.limit).toBe(2);
    }
    // 恰好等于上限时成功（预算是“超过”才中止）。
    expect(parseDirectoryListXml(LIST_XML, { maxEntries: 5 }).total).toBe(5);
  });

  it('字节预算：原始 XML 超过 maxXmlBytes 立即以 bytes 原因中止', () => {
    try {
      parseDirectoryListXml(LIST_XML, { maxXmlBytes: 128 });
      expect.unreachable('应当抛出 BrowseLimitExceededError');
    } catch (err) {
      expect(err).toBeInstanceOf(BrowseLimitExceededError);
      expect((err as BrowseLimitExceededError).reason).toBe('bytes');
    }
  });

  it('预算常量符合契约（100k 条目 / 64 MiB）', () => {
    expect(REMOTE_BROWSE_MAX_ENTRIES).toBe(100_000);
    expect(REMOTE_BROWSE_MAX_XML_BYTES).toBe(64 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// URL 与节点构造
// ---------------------------------------------------------------------------

describe('节点 URL 构造', () => {
  it('名称整段编码：空格/%/中文/@/# 都转百分号编码', () => {
    expect(appendUrlSegment('https://h/repo/trunk', 'with space & 中文.txt'))
      .toBe('https://h/repo/trunk/with%20space%20%26%20%E4%B8%AD%E6%96%87.txt');
    expect(appendUrlSegment('https://h/repo/trunk/', 'a@b#c.txt'))
      .toBe('https://h/repo/trunk/a%40b%23c.txt');
  });

  it('仓库相对路径按 POSIX 拼接（根节点空串）', () => {
    expect(appendRelativePath('', 'a.txt')).toBe('a.txt');
    expect(appendRelativePath('trunk', 'dir')).toBe('trunk/dir');
  });

  it('relativePathFromRelativeUrl 逐段解码且根节点为空串', () => {
    expect(relativePathFromRelativeUrl('^/')).toBe('');
    expect(relativePathFromRelativeUrl('^/trunk/a%20b/%E4%B8%AD.txt')).toBe('trunk/a b/中.txt');
    // 非法 UTF-8 段原样保留。
    expect(relativePathFromRelativeUrl('^/trunk/%D6%D0')).toBe('trunk/%D6%D0');
  });

  it('entryNodeRef 继承仓库身份与快照 revision，URL/相对路径按条目名称构造', () => {
    const parent: RepoNodeRef = {
      repositoryUuid: 'u',
      repositoryRootUrl: 'https://h/repo',
      rawUrl: 'https://h/repo/trunk',
      relativePath: 'trunk',
      snapshotRevision: 9,
      lastChangedRevision: 4,
      kind: 'dir',
    };
    const node = entryNodeRef(parent, {
      name: 'a b@c.txt',
      kind: 'file',
      lastChangedRevision: 7,
      lastChangedAuthor: 'alice',
    });
    expect(node.rawUrl).toBe('https://h/repo/trunk/a%20b%40c.txt');
    expect(node.relativePath).toBe('trunk/a b@c.txt');
    expect(node.snapshotRevision).toBe(9);
    expect(node.lastChangedRevision).toBe(7);
    expect(node.lastChangedAuthor).toBe('alice');
    // 条目缺 commit 时回退父快照 revision。
    const fallback = entryNodeRef(parent, { name: 'x', kind: 'dir' });
    expect(fallback.lastChangedRevision).toBe(9);
  });
});

describe('命令参数与 peg', () => {
  it('info/list 的 peg 与 -r 都固定到快照 revision；含 @ 的 URL 统一追加 peg', () => {
    const info = buildRemoteInfoArgs('https://h/repo/at@file#1.txt', 3);
    expect(info).toEqual(['info', '--xml', '--non-interactive', '-r', '3', '--', 'https://h/repo/at@file#1.txt@3']);
    // 无 revision 时仍追加空 peg，不裸露用户 URL。
    expect(buildRemoteInfoArgs('https://h/repo/x').at(-1)).toBe('https://h/repo/x@');
    // 编码的 %40 与字面 @ 都只补一个 peg 分隔符。
    expect(buildRemoteInfoArgs('https://h/repo/a%40b.txt', 3).at(-1))
      .toBe('https://h/repo/a%40b.txt@3');
    const list = buildRemoteListArgs('https://h/repo/trunk', 3);
    expect(list.slice(0, 7)).toEqual(['list', '--xml', '--non-interactive', '--depth', 'immediates', '-r', '3']);
    expect(list.at(-1)).toBe('https://h/repo/trunk@3');
  });

  it('propget 参数：属性名在 -- 之前，属性缺失场景仍使用同一 peg 规则', () => {
    const args = buildRemotePropgetArgs('https://h/repo/trunk/a.txt', 'svn:mime-type', 2);
    expect(args.slice(0, 6)).toEqual(['propget', '--xml', '--non-interactive', '-r', '2', 'svn:mime-type']);
    expect(args.at(-1)).toBe('https://h/repo/trunk/a.txt@2');
  });
});

// ---------------------------------------------------------------------------
// 错误分类
// ---------------------------------------------------------------------------

describe('classifyBrowseFailure', () => {
  it('HTTP 401/403 与 svn:// E170001 的 auth/permission 细分', () => {
    const http401 = 'svn: E170013: Unable to connect to a repository at URL\n'
      + 'svn: E215004: No more credentials or we tried too many times.';
    expect(classifyBrowseFailure(svnFailure(http401), 'https://h/repo').kind).toBe('auth');

    const http403 = 'svn: E170013: Unable to connect to a repository at URL\n'
      + 'svn: E175013: Access to /repo forbidden';
    expect(classifyBrowseFailure(svnFailure(http403), 'https://h/repo').kind).toBe('permission');

    const svnAuthz = 'svn: E170001: Authorization failed';
    expect(classifyBrowseFailure(svnFailure(svnAuthz), 'svn://h/repo').kind).toBe('permission');

    const svnAnon = "svn: E170001: Can't get username or password";
    expect(classifyBrowseFailure(svnFailure(svnAnon), 'svn://h/repo').kind).toBe('auth');
  });

  it('网络类：E170013 + E000061/E175012/E120108 归 network（可重试）', () => {
    for (const stderr of [
      'svn: E170013: Unable to connect\nsvn: E000061: Connection refused',
      'svn: E170013: Unable to connect\nsvn: E175012: Connection timed out',
      'svn: E170013: Unable to connect\nsvn: E120108: Error retrieving response',
    ]) {
      expect(classifyBrowseFailure(svnFailure(stderr), 'https://h/repo').kind).toBe('network');
    }
  });

  it('notFound 只由 W160013/W170000 判定，E200009 单独不构成不存在证据', () => {
    expect(classifyBrowseFailure(
      svnFailure("svn: warning: W160013: Path '/trunk/nope' not found\nsvn: E200009: Could not list all targets"),
      'https://h/repo',
    ).kind).toBe('notFound');
    expect(classifyBrowseFailure(
      svnFailure("svn: warning: W170000: URL 'x' non-existent in revision 2\nsvn: E200009: Could not display info"),
      'https://h/repo',
    ).kind).toBe('notFound');
    // propget 对不存在的目标输出 E150000（`... does not exist in revision N`）。
    expect(classifyBrowseFailure(
      svnFailure("svn: E150000: 'x' does not exist in revision 2"),
      'https://h/repo',
    ).kind).toBe('notFound');
    expect(classifyBrowseFailure(svnFailure('svn: E200009: Could not display info'), 'https://h/repo').kind)
      .toBe('unknown');
  });

  it('revision 不存在、取消、超时与未知错误分类', () => {
    expect(classifyBrowseFailure(svnFailure('svn: E160006: No such revision 999'), 'https://h/repo').kind)
      .toBe('revisionNotFound');
    expect(classifyBrowseFailure(svnFailure('svn: E195012: Unable to find repository'), 'https://h/repo').kind)
      .toBe('revisionNotFound');
    expect(classifyBrowseFailure(svnFailure('killed', 'CANCELLED'), 'https://h/repo').kind).toBe('cancelled');
    expect(classifyBrowseFailure(svnFailure('timeout', 'TIMEOUT'), 'https://h/repo').kind).toBe('network');
    const unknown = classifyBrowseFailure(svnFailure('svn: E205000: Syntax error parsing peg revision'), 'https://h/repo');
    expect(unknown.kind).toBe('unknown');
    expect(unknown.codes).toContain('E205000');
  });

  it('BrowseLimitExceededError 映射 tooLarge；非 Error 值兜底 unknown', () => {
    expect(classifyBrowseFailure(new BrowseLimitExceededError('bytes', 64)).kind).toBe('tooLarge');
    expect(classifyBrowseFailure('boom').kind).toBe('unknown');
  });

  it('extractSvnStatusCodes 同时提取 E/W 状态码并去重', () => {
    expect(extractSvnStatusCodes('W160013 x E200009 y W160013 z E170001'))
      .toEqual(['W160013', 'E200009', 'E170001']);
  });

  it('withRemoteAuthScope：http(s)/svn 推导作用域，file/svn+ssh 移除凭据回调', () => {
    const credentials = async () => undefined;
    expect(withRemoteAuthScope('https://h/repo', { getCredentials: credentials }).authScope)
      .toEqual({ scheme: 'https', host: 'h', port: 443 });
    expect(withRemoteAuthScope('svn://h:3690/repo', {}).authScope)
      .toEqual({ scheme: 'svn', host: 'h', port: 3690 });
    expect(withRemoteAuthScope('file:///srv/repo', { getCredentials: credentials }).getCredentials)
      .toBeUndefined();
    expect(withRemoteAuthScope('svn+ssh://h/repo', { getCredentials: credentials }).getCredentials)
      .toBeUndefined();
    // 调用方显式传入的 authScope 原样保留。
    const explicit = { scheme: 'https' as const, host: 'other', port: 8443 };
    expect(withRemoteAuthScope('https://h/repo', { authScope: explicit }).authScope).toBe(explicit);
  });
});

// ---------------------------------------------------------------------------
// propget 解析（纯）
// ---------------------------------------------------------------------------

describe('parseRemotePropertyXml', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<properties>
<target path="https://h/repo/trunk/a.txt">
<property name="svn:custom"> value with spaces </property>
<property name="svn:mime-type">text/plain</property>
</target>
</properties>`;

  it('按属性名取值，首尾空格不 trim', () => {
    expect(parseRemotePropertyXml(xml, 'svn:mime-type')).toEqual({ status: 'present', value: 'text/plain' });
    expect(parseRemotePropertyXml(xml, 'svn:custom')).toEqual({ status: 'present', value: ' value with spaces ' });
  });

  it('未命中属性返回 undefined；空值属性返回空串', () => {
    expect(parseRemotePropertyXml(xml, 'svn:special')).toBeUndefined();
    expect(parseRemotePropertyXml(
      '<properties><target path="u"><property name="svn:mime-type"></property></target></properties>',
      'svn:mime-type',
    )).toEqual({ status: 'present', value: '' });
  });
});

// ---------------------------------------------------------------------------
// 真实 svn（svnadmin + file:// 实验仓库）
// ---------------------------------------------------------------------------

describe('真实 svn 浏览（file:// 实验仓库）', () => {
  it.runIf(hasSvn && hasSvnadmin)('空目录 ready+0、不存在 notFound、条目与编码名称完整', async () => {
    const lab = createSvnLab('svn-anywhere-browse-');
    try {
      const src = join(lab.root, 'src');
      mkdirSync(join(src, 'empty'), { recursive: true });
      writeFile(src, 'dir/child.txt', 'child\n');
      writeFile(src, 'plain.txt', 'hello\n');
      writeFile(src, 'with space & 中文.txt', 'x\n');
      writeFile(src, 'at@name.txt', 'y\n');
      writeFile(src, 'hash#name.txt', 'z\n');
      lab.svn(['import', '-q', '-m', 'init', src, `${lab.repoUrl}/trunk`]);
      const trunkUrl = `${lab.repoUrl}/trunk`;

      const info = await readRemoteNode('svn', trunkUrl, { revision: 1 });
      expect(info.status).toBe('present');
      if (info.status !== 'present') {
        return;
      }
      expect(info.node.kind).toBe('dir');
      expect(info.node.snapshotRevision).toBe(1);
      expect(info.node.lastChangedRevision).toBe(1);
      expect(info.node.repositoryRootUrl).toBe(lab.repoUrl);
      expect(info.node.relativePath).toBe('trunk');
      expect(info.node.repositoryUuid).not.toBe('');
      expect(info.sizeBytes).toBeUndefined();

      // 缺省 revision 读取 HEAD，并由返回的 snapshotRevision 固定。
      const headInfo = await readRemoteNode('svn', trunkUrl);
      expect(headInfo.status).toBe('present');
      if (headInfo.status === 'present') {
        expect(headInfo.node.snapshotRevision).toBe(1);
      }

      const listing = await readRemoteDirectory('svn', trunkUrl, { revision: 1 });
      expect(listing.status).toBe('ready');
      if (listing.status !== 'ready') {
        return;
      }
      expect(listing.listing.total).toBe(6);
      const names = listing.listing.entries.map((entry) => entry.name).sort();
      expect(names).toEqual([
        'at@name.txt',
        'dir',
        'empty',
        'hash#name.txt',
        'plain.txt',
        'with space & 中文.txt',
      ].sort());
      const plain = listing.listing.entries.find((entry) => entry.name === 'plain.txt');
      expect(plain).toMatchObject({ kind: 'file', sizeBytes: 6, lastChangedRevision: 1 });
      expect(listing.listing.entries.find((entry) => entry.name === 'dir')?.kind).toBe('dir');

      // 空目录是 ready + total=0（exit 0），不是错误。
      const empty = await readRemoteDirectory('svn', `${trunkUrl}/empty`, { revision: 1 });
      expect(empty.status).toBe('ready');
      if (empty.status === 'ready') {
        expect(empty.listing.total).toBe(0);
        expect(empty.listing.entries).toEqual([]);
      }

      // 不存在路径的 stdout 也是空骨架，必须按退出码/stderr 判 notFound。
      const missing = await readRemoteDirectory('svn', `${trunkUrl}/nope`, { revision: 1 });
      expect(missing.status).toBe('notFound');
      if (missing.status === 'notFound') {
        expect(missing.error.kind).toBe('notFound');
        expect(missing.error.codes).toEqual(expect.arrayContaining(['W160013', 'E200009']));
      }

      // 条目 URL 可直接回读：空格/&/中文/@/# 都经逐段编码与空 peg 规则。
      const spaced = listing.listing.entries.find((entry) => entry.name === 'with space & 中文.txt');
      expect(spaced).toBeDefined();
      const spacedNode = entryNodeRef(info.node, spaced!);
      expect(spacedNode.rawUrl).not.toContain(' ');
      const spacedInfo = await readRemoteNode('svn', spacedNode.rawUrl, { revision: 1 });
      expect(spacedInfo.status).toBe('present');
      if (spacedInfo.status === 'present') {
        expect(spacedInfo.sizeBytes).toBe(2);
        expect(spacedInfo.node.relativePath).toBe('trunk/with space & 中文.txt');
      }
      const atEntry = listing.listing.entries.find((entry) => entry.name === 'at@name.txt');
      const atInfo = await readRemoteNode('svn', entryNodeRef(info.node, atEntry!).rawUrl, { revision: 1 });
      expect(atInfo.status).toBe('present');
    } finally {
      lab.cleanup();
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('快照 revision 与条目最后修改 revision 分离；文件 URL 返回单条目', async () => {
    const lab = createSvnLab('svn-anywhere-browse-rev-');
    try {
      const src = join(lab.root, 'src');
      writeFile(src, 'plain.txt', 'hello\n');
      writeFile(src, 'other.txt', 'other\n');
      lab.svn(['import', '-q', '-m', 'init', src, `${lab.repoUrl}/trunk`]);
      const wc = lab.checkout('wc');
      writeFile(wc, 'trunk/plain.txt', 'hello again\n');
      lab.svn(['commit', '-q', '-m', 'modify'], wc);
      const trunkUrl = `${lab.repoUrl}/trunk`;

      const at1 = await readRemoteNode('svn', `${trunkUrl}/plain.txt`, { revision: 1 });
      expect(at1.status).toBe('present');
      if (at1.status === 'present') {
        expect(at1.node.snapshotRevision).toBe(1);
        expect(at1.node.lastChangedRevision).toBe(1);
      }
      const at2 = await readRemoteNode('svn', `${trunkUrl}/plain.txt`, { revision: 2 });
      expect(at2.status).toBe('present');
      if (at2.status === 'present') {
        expect(at2.node.snapshotRevision).toBe(2);
        expect(at2.node.lastChangedRevision).toBe(2);
        expect(at2.sizeBytes).toBe('hello again\n'.length);
      }

      const listing = await readRemoteDirectory('svn', trunkUrl, { revision: 2 });
      expect(listing.status).toBe('ready');
      if (listing.status === 'ready') {
        const plain = listing.listing.entries.find((entry) => entry.name === 'plain.txt');
        const other = listing.listing.entries.find((entry) => entry.name === 'other.txt');
        expect(plain?.lastChangedRevision).toBe(2);
        // 未改动条目在快照 2 下仍报告最后修改 revision 1。
        expect(other?.lastChangedRevision).toBe(1);
      }

      // 文件 URL 的 list 返回文件自身单条 entry。
      const fileListing = await readRemoteDirectory('svn', `${trunkUrl}/plain.txt`, { revision: 2 });
      expect(fileListing.status).toBe('ready');
      if (fileListing.status === 'ready') {
        expect(fileListing.listing.total).toBe(1);
        expect(fileListing.listing.entries[0]).toMatchObject({ name: 'plain.txt', kind: 'file' });
      }
    } finally {
      lab.cleanup();
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('条目/字节预算越限：真实 svn 进程被中止并返回 tooLarge', async () => {
    const lab = createSvnLab('svn-anywhere-browse-limit-');
    try {
      const src = join(lab.root, 'src');
      for (let index = 0; index < 8; index += 1) {
        writeFile(src, `f${index}.txt`, 'x\n');
      }
      lab.svn(['import', '-q', '-m', 'init', src, `${lab.repoUrl}/trunk`]);
      const trunkUrl = `${lab.repoUrl}/trunk`;

      const entriesLimit = await readRemoteDirectory('svn', trunkUrl, { revision: 1, maxEntries: 2 });
      expect(entriesLimit.status).toBe('tooLarge');
      if (entriesLimit.status === 'tooLarge') {
        expect(entriesLimit.reason).toBe('entries');
        expect(entriesLimit.limit).toBe(2);
        expect(entriesLimit.entriesParsed).toBeGreaterThan(2);
        expect(entriesLimit.xmlBytes).toBeGreaterThan(0);
      }

      const bytesLimit = await readRemoteDirectory('svn', trunkUrl, { revision: 1, maxXmlBytes: 128 });
      expect(bytesLimit.status).toBe('tooLarge');
      if (bytesLimit.status === 'tooLarge') {
        expect(bytesLimit.reason).toBe('bytes');
        expect(bytesLimit.limit).toBe(128);
        expect(bytesLimit.xmlBytes).toBeGreaterThan(128);
      }
    } finally {
      lab.cleanup();
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('propget --xml：属性存在、缺失（W200017→absent）、路径不存在', async () => {
    const lab = createSvnLab('svn-anywhere-browse-mime-');
    try {
      const src = join(lab.root, 'src');
      writeFile(src, 'plain.txt', 'hello\n');
      writeFile(src, 'mime.txt', 'plain\n');
      lab.svn(['import', '-q', '-m', 'init', src, `${lab.repoUrl}/trunk`]);
      const wc = lab.checkout('wc');
      lab.svn(['propset', '-q', 'svn:mime-type', 'text/plain', 'trunk/mime.txt'], wc);
      lab.svn(['commit', '-q', '-m', 'props'], wc);
      const trunkUrl = `${lab.repoUrl}/trunk`;

      // 属性缺失是正常结果（exit 1 + W200017 + E200000），不是错误。
      const absent = await readRemoteMimeType('svn', `${trunkUrl}/plain.txt`, { revision: 2 });
      expect(absent).toEqual({ status: 'absent' });

      const present = await readRemoteMimeType('svn', `${trunkUrl}/mime.txt`, { revision: 2 });
      expect(present).toEqual({ status: 'present', value: 'text/plain' });

      // 快照 revision 早于属性写入时同样 absent。
      expect(await readRemoteMimeType('svn', `${trunkUrl}/mime.txt`, { revision: 1 }))
        .toEqual({ status: 'absent' });

      // 路径不存在不是“无 mime”。
      const missing = await readRemoteMimeType('svn', `${trunkUrl}/nope.txt`, { revision: 2 });
      expect(missing.status).toBe('error');
      if (missing.status === 'error') {
        expect(missing.error.kind).toBe('notFound');
      }
    } finally {
      lab.cleanup();
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('readRemoteNode 对不存在路径返回 absent 而不是异常', async () => {
    const lab = createSvnLab('svn-anywhere-browse-absent-');
    try {
      const src = join(lab.root, 'src');
      writeFile(src, 'a.txt', 'a\n');
      lab.svn(['import', '-q', '-m', 'init', src, `${lab.repoUrl}/trunk`]);
      const absent = await readRemoteNode('svn', `${lab.repoUrl}/trunk/nope.txt`, { revision: 1 });
      expect(absent.status).toBe('absent');
      if (absent.status === 'absent') {
        expect(absent.error.kind).toBe('notFound');
        expect(absent.error.codes).toEqual(expect.arrayContaining(['W170000', 'E200009']));
      }
      // 已删除路径在删除后的 revision 同样 absent。
      const wc = lab.checkout('wc');
      lab.svn(['delete', '-q', 'trunk/a.txt'], wc);
      lab.svn(['commit', '-q', '-m', 'delete'], wc);
      const deleted = await readRemoteNode('svn', `${lab.repoUrl}/trunk/a.txt`, { revision: 2 });
      expect(deleted.status).toBe('absent');
      const beforeDelete = await readRemoteNode('svn', `${lab.repoUrl}/trunk/a.txt`, { revision: 1 });
      expect(beforeDelete.status).toBe('present');
    } finally {
      lab.cleanup();
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('info 输出缺必要字段判 parse：错误消息为英文技术诊断', async () => {
    const lab = createSvnLab('svn-anywhere-browse-parse-');
    try {
      const wrapper = join(lab.root, 'svn-info-missing-fields.sh');
      writeFileSync(wrapper, [
        '#!/bin/bash',
        'if [ "$1" = "info" ]; then',
        '  printf \'<?xml version="1.0"?><info><entry kind="file" path="a.txt" revision="1"></entry></info>\'',
        '  exit 0',
        'fi',
        `exec "${execSync('which svn', { encoding: 'utf8' }).trim()}" "$@"`,
        '',
      ].join('\n'));
      chmodSync(wrapper, 0o755);
      const result = await readRemoteNode(wrapper, `${lab.repoUrl}/trunk/a.txt`, { revision: 1 });
      expect(result.status).toBe('error');
      if (result.status === 'error') {
        // 稳定分类是 parse；面向用户的文案由宿主按 kind 映射 i18n。
        expect(result.error.kind).toBe('parse');
        expect(result.error.message).not.toMatch(/[一-鿿]/);
      }
    } finally {
      lab.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 内容分类判据（纯逻辑）
// ---------------------------------------------------------------------------

describe('MIME/NUL 判据', () => {
  it('mimeTypeIsBinary：仅 text/* 视为文本（大小写不敏感），SVG 不例外', () => {
    expect(mimeTypeIsBinary('text/plain')).toBe(false);
    expect(mimeTypeIsBinary('TEXT/PLAIN')).toBe(false);
    expect(mimeTypeIsBinary('image/svg+xml')).toBe(true);
    expect(mimeTypeIsBinary('application/octet-stream')).toBe(true);
    expect(mimeTypeIsBinary('')).toBe(true);
  });

  it('hasNulByte 只检查前 8 KiB 窗口（窗口之后的 NUL 不识别）', () => {
    const afterWindow = Buffer.alloc(BINARY_PROBE_BYTES + 1, 0x61);
    afterWindow[BINARY_PROBE_BYTES] = 0;
    expect(hasNulByte(afterWindow)).toBe(false);
    const insideWindow = Buffer.alloc(BINARY_PROBE_BYTES, 0x61);
    insideWindow[BINARY_PROBE_BYTES - 1] = 0;
    expect(hasNulByte(insideWindow)).toBe(true);
    // UTF-16LE BOM + 字符间 NUL 落在窗口内。
    expect(hasNulByte(Buffer.from([0xff, 0xfe, 0x61, 0x00]))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 无元数据名称列表（大目录两段式第一段）
// ---------------------------------------------------------------------------

describe('parseDirectoryNameList（无元数据 svn list）', () => {
  it('目录行以 / 结尾、文件行原样；名称不 trim，空行/仅斜杠行按解析失败拒绝', () => {
    const listing = parseDirectoryNameList('dir/\n leading.txt\ntrail \nwith space & 中文.txt\nat@name.txt\nhash#name.txt\n');
    expect(listing.total).toBe(6);
    expect(listing.entries).toEqual([
      { name: 'dir', kind: 'dir' },
      { name: ' leading.txt', kind: 'file' },
      { name: 'trail ', kind: 'file' },
      { name: 'with space & 中文.txt', kind: 'file' },
      { name: 'at@name.txt', kind: 'file' },
      { name: 'hash#name.txt', kind: 'file' },
    ]);
    expect(listing.bytes).toBeGreaterThan(0);
    // 空输出 = 空目录（ready 判定由 exit 0 承担）。
    expect(parseDirectoryNameList('').total).toBe(0);
    // 空行（输出损坏/名称异常）不静默少计条目。
    expect(() => parseDirectoryNameList('a.txt\n\nb.txt\n')).toThrow(/malformed empty line/);
    expect(() => parseDirectoryNameList('/\n')).toThrow(/malformed empty line/);
  });

  it('任意字节分块（切在多字节字符中间）与整段结果一致；CRLF 行结束符被剥离', () => {
    const text = '中文目录/\n名称 & emoji 🚀.txt\nplain.txt\n';
    const data = Buffer.from(text, 'utf8');
    const whole = parseDirectoryNameList(data);
    for (const sizes of [[1], [2], [3], [5, 7, 11]]) {
      expect(parseDirectoryNameList(chunkBuffer(data, sizes))).toEqual(whole);
    }
    for (const entry of whole.entries) {
      expect(entry.name).not.toContain('�');
      expect(entry.name).not.toContain('\r');
    }
    expect(parseDirectoryNameList('win-dir/\r\nwin.txt\r\n').entries).toEqual([
      { name: 'win-dir', kind: 'dir' },
      { name: 'win.txt', kind: 'file' },
    ]);
  });

  it('条目预算：超过 maxEntries 立即以 entries 原因中止', () => {
    try {
      parseDirectoryNameList('a\nb\nc\n', { maxEntries: 2 });
      expect.unreachable('应当抛出 BrowseLimitExceededError');
    } catch (err) {
      expect(err).toBeInstanceOf(BrowseLimitExceededError);
      expect((err as BrowseLimitExceededError).reason).toBe('entries');
    }
    expect(parseDirectoryNameList('a\nb\nc\n', { maxEntries: 3 }).total).toBe(3);
  });

  it('字节预算：原始 stdout 超过 maxXmlBytes 立即以 bytes 原因中止', () => {
    try {
      parseDirectoryNameList('a-very-long-name.txt\n', { maxXmlBytes: 4 });
      expect.unreachable('应当抛出 BrowseLimitExceededError');
    } catch (err) {
      expect((err as BrowseLimitExceededError).reason).toBe('bytes');
    }
  });

  it('名称列表命令形态：--depth immediates 且 peg 与 -r 同为快照 revision', () => {
    expect(buildRemoteNameListArgs('https://h/repo/at@file#1', 7)).toEqual([
      'list',
      '--non-interactive',
      '--depth',
      'immediates',
      '-r',
      '7',
      '--',
      'https://h/repo/at@file#1@7',
    ]);
  });
});

describe('真实 svn 名称列表（file:// 实验仓库）', () => {
  it.runIf(hasSvn && hasSvnadmin)('名称与目录 kind、空目录 exit0、不存在 notFound、文件目标单条', async () => {
    const lab = createSvnLab('svn-anywhere-namelist-');
    try {
      const src = join(lab.root, 'src');
      mkdirSync(join(src, 'dir'), { recursive: true });
      mkdirSync(join(src, 'empty'), { recursive: true });
      writeFile(src, 'plain.txt', 'hello\n');
      writeFile(src, 'with space & 中文.txt', 'x\n');
      writeFile(src, 'at@name.txt', 'y\n');
      writeFile(src, 'hash#name.txt', 'z\n');
      lab.svn(['import', '-q', '-m', 'init', src, `${lab.repoUrl}/trunk`]);
      const trunkUrl = `${lab.repoUrl}/trunk`;

      const names = await readRemoteDirectoryNames('svn', trunkUrl, { revision: 1 });
      expect(names.status).toBe('ready');
      if (names.status !== 'ready') {
        return;
      }
      expect(names.listing.total).toBe(6);
      expect(names.listing.entries.map((entry) => entry.name).sort()).toEqual([
        'at@name.txt',
        'dir',
        'empty',
        'hash#name.txt',
        'plain.txt',
        'with space & 中文.txt',
      ].sort());
      expect(names.listing.entries.find((entry) => entry.name === 'dir')?.kind).toBe('dir');
      expect(names.listing.entries.find((entry) => entry.name === 'plain.txt')?.kind).toBe('file');

      const empty = await readRemoteDirectoryNames('svn', `${trunkUrl}/empty`, { revision: 1 });
      expect(empty.status).toBe('ready');
      if (empty.status === 'ready') {
        expect(empty.listing.total).toBe(0);
      }

      const missing = await readRemoteDirectoryNames('svn', `${trunkUrl}/nope`, { revision: 1 });
      expect(missing.status).toBe('notFound');
      if (missing.status === 'notFound') {
        expect(missing.error.codes).toEqual(expect.arrayContaining(['W160013', 'E200009']));
      }

      const fileTarget = await readRemoteDirectoryNames('svn', `${trunkUrl}/plain.txt`, { revision: 1 });
      expect(fileTarget.status).toBe('ready');
      if (fileTarget.status === 'ready') {
        expect(fileTarget.listing.entries).toEqual([{ name: 'plain.txt', kind: 'file' }]);
      }
    } finally {
      lab.cleanup();
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('名称列表条目预算越限：真实 svn 进程被中止并返回 tooLarge', async () => {
    const lab = createSvnLab('svn-anywhere-namelist-limit-');
    try {
      const src = join(lab.root, 'src');
      for (let index = 0; index < 8; index += 1) {
        writeFile(src, `f${index}.txt`, 'x\n');
      }
      lab.svn(['import', '-q', '-m', 'init', src, `${lab.repoUrl}/trunk`]);
      const limited = await readRemoteDirectoryNames('svn', `${lab.repoUrl}/trunk`, {
        revision: 1,
        maxEntries: 2,
      });
      expect(limited.status).toBe('tooLarge');
      if (limited.status === 'tooLarge') {
        expect(limited.reason).toBe('entries');
        expect(limited.limit).toBe(2);
      }
    } finally {
      lab.cleanup();
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('末行无换行且恰好越限：end 收口的越限返回 tooLarge，不降级为 parse', async () => {
    // readRemoteDirectoryNames 内层 catch 曾把 end() 收口时
    // 抛出的 BrowseLimitExceededError 一并转成 kind:'parse'。用 wrapper
    // 伪造「exit 0 + 末行无换行 + 恰好超过 maxEntries」的输出。
    const lab = createSvnLab('svn-anywhere-namelist-end-limit-');
    try {
      const wrapper = join(lab.root, 'svn-list-tail-noeol.sh');
      writeFileSync(wrapper, [
        '#!/bin/bash',
        'if [ "$1" = "list" ]; then',
        '  printf \'a\\nb\\nc\'',
        '  exit 0',
        'fi',
        `exec "${execSync('which svn', { encoding: 'utf8' }).trim()}" "$@"`,
        '',
      ].join('\n'));
      chmodSync(wrapper, 0o755);

      const limited = await readRemoteDirectoryNames(wrapper, `${lab.repoUrl}/trunk`, {
        revision: 1,
        maxEntries: 2,
      });
      // 修复前：status='error', error.kind='parse'；修复后 tooLarge(entries)。
      expect(limited.status).toBe('tooLarge');
      if (limited.status === 'tooLarge') {
        expect(limited.reason).toBe('entries');
        expect(limited.limit).toBe(2);
        expect(limited.error.kind).toBe('tooLarge');
      }
    } finally {
      lab.cleanup();
    }
  });

  it.runIf(hasSvn && hasSvnadmin)('异常空行的名称列表判 parse：错误消息为英文技术诊断', async () => {
    const lab = createSvnLab('svn-anywhere-namelist-parse-');
    try {
      const wrapper = join(lab.root, 'svn-list-blank-lines.sh');
      writeFileSync(wrapper, [
        '#!/bin/bash',
        'if [ "$1" = "list" ]; then',
        "  printf 'a\\n\\nb\\n'",
        '  exit 0',
        'fi',
        `exec "${execSync('which svn', { encoding: 'utf8' }).trim()}" "$@"`,
        '',
      ].join('\n'));
      chmodSync(wrapper, 0o755);
      const result = await readRemoteDirectoryNames(wrapper, `${lab.repoUrl}/trunk`, { revision: 1 });
      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error.kind).toBe('parse');
        expect(result.error.message).not.toMatch(/[一-鿿]/);
      }
    } finally {
      lab.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 名称以 @ 结尾的节点（urlWithPeg 固定拼接，不剥除字面尾 @）
// ---------------------------------------------------------------------------

/**
 * 真实 svn 实测：仓库可提交名称 `tail@`，`svn info`
 * 回包的 `<url>` 原样保留字面尾 `@`（不编码 `%40`）。旧构造器剥除尾 `@`
 * 后拼 peg（`…/tail@1`），svn 会解析为路径 `tail` + peg 1——指向同名兄弟
 * 节点；无 revision 时原样 `…/tail@` 被解析为路径 `tail` + 空 peg 并报
 * W170000。本用例断言 info/list/log 都经 info 回包的字面 URL 读回自身。
 */
describe('名称以 @ 结尾的节点（真实 svn file:// 回读）', () => {
  it.runIf(hasSvn && hasSvnadmin)('info/list/log 以字面尾 @ URL 读回自身而不是同名兄弟', async () => {
    const lab = createSvnLab('svn-anywhere-tail-at-');
    try {
      const src = join(lab.root, 'src');
      writeFile(src, 'tail', 'brother\n');
      writeFile(src, 'tail@', 'self@\n');
      writeFile(src, 'dir@/inner.txt', 'inner@\n');
      lab.svn(['import', '-q', '-m', 'init', src, `${lab.repoUrl}/trunk`]);
      const trunkUrl = `${lab.repoUrl}/trunk`;

      const trunk = await readRemoteNode('svn', trunkUrl, { revision: 1 });
      expect(trunk.status).toBe('present');
      if (trunk.status !== 'present') {
        return;
      }
      const listing = await readRemoteDirectory('svn', trunkUrl, { revision: 1 });
      expect(listing.status).toBe('ready');
      if (listing.status !== 'ready') {
        return;
      }
      const names = listing.listing.entries.map((entry) => entry.name).sort();
      expect(names).toEqual(['dir@', 'tail', 'tail@'].sort());

      // 条目 URL 逐段编码为 %40；info 回包 <url> 原样还原字面尾 @。
      const tailAtEntry = listing.listing.entries.find((entry) => entry.name === 'tail@')!;
      const viaEntry = await readRemoteNode('svn', entryNodeRef(trunk.node, tailAtEntry).rawUrl, { revision: 1 });
      expect(viaEntry.status).toBe('present');
      if (viaEntry.status !== 'present') {
        return;
      }
      const literalUrl = viaEntry.node.rawUrl;
      expect(literalUrl.endsWith('/tail@')).toBe(true);
      expect(viaEntry.node.relativePath).toBe('trunk/tail@');

      // 无 revision：修复前原样 …/tail@ 被解析为「路径 tail + 空 peg」报 W170000。
      const noRevision = await readRemoteNode('svn', literalUrl);
      expect(noRevision.status).toBe('present');
      if (noRevision.status === 'present') {
        expect(noRevision.node.relativePath).toBe('trunk/tail@');
        expect(noRevision.node.kind).toBe('file');
      }

      // 带 revision：修复前 …/tail@1 指向同名兄弟 tail（present 但身份错误）。
      const withRevision = await readRemoteNode('svn', literalUrl, { revision: 1 });
      expect(withRevision.status).toBe('present');
      if (withRevision.status === 'present') {
        expect(withRevision.node.relativePath).toBe('trunk/tail@');
      }

      // list 文件 URL 返回单条目：必须是 tail@ 自身，不是兄弟 tail。
      const fileList = await readRemoteDirectory('svn', literalUrl, { revision: 1 });
      expect(fileList.status).toBe('ready');
      if (fileList.status === 'ready') {
        expect(fileList.listing.entries.map((entry) => entry.name)).toEqual(['tail@']);
      }

      // log 走同一 peg 构造：历史路径必须落在 /trunk/tail@ 上。
      const log = await run('svn', buildHistoryLogArgs(createTargetSource({
        url: literalUrl,
        repositoryRootUrl: lab.repoUrl,
        relativePath: 'trunk/tail@',
        kind: 'file',
      }, 1), 50, false));
      expect(log.exitCode).toBe(0);
      const entries = parseLogXml(log.stdout);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.flatMap((entry) => entry.paths.map((change) => change.path))).toContain('/trunk/tail@');
    } finally {
      lab.cleanup();
    }
  });
});
