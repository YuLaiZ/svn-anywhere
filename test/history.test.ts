/**
 * 历史 core（P6）单测：`svn log --xml -v` 解析、单源 cursor、多源源栈、
 * 每轮独立 500 条扫描预算、严格命中规则、筛选、六类计数、
 * 5,000/100,000 上限与 historyLimitState.reasons、upper 状态语义与
 * resetHistorySession/refreshHistoryUpper、实际节点映射与 notFoundAtRevision。
 *
 * 期望值来源（真实 svn 实测，与历史分页/节点解析契约一致）：
 * - 500 条扫描预算：「500 扫描 80 匹配 50 展示 30 pending、next cursor=60」；
 * - 同构小参数（pageSize=2、matched limit=2、scanned limit=6、
 *   单轮预算 6）验证到达上限停止请求、最后一批越过完整保留、双 reason
 *   并存、pending 清空后 hasMore 转 false；
 * - 连续两轮各 500 条独立预算、跨源同 revision 去重、累计计数；
 * - ancestor-filter 严格规则与「同名来源路径不误归因」；
 * - info absent 判定只认 W170000+E200009+空 entry。
 * svn 命令用 mock（vi.mock ../src/core/svnCli 的 run），XML 全部内联；
 * 不访问真实 SVN。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/svnCli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/svnCli')>();
  return { ...actual, run: vi.fn() };
});

import { run } from '../src/core/svnCli';
import { SvnError } from '../src/core/errors';
import {
  DEFAULT_HISTORY_LIMITS,
  DEFAULT_HISTORY_PAGE_SIZE,
  HISTORY_MATCHED_LIMIT,
  HISTORY_PAGE_SIZES,
  HISTORY_RAW_BUDGET_PER_LOAD,
  HISTORY_SCANNED_LIMIT,
  applyHistoryLogPage,
  applyHistoryUpperRefresh,
  beginHistoryLoadMore,
  buildHistoryLogArgs,
  canRefreshHistoryUpper,
  checkHistoryLimits,
  classifyHistoryOutcome,
  clearHistorySessionData,
  collectHistoryAuthors,
  createAncestorFilterSource,
  createHistorySession,
  createUnresolvedHistorySession,
  findCopySource,
  findRevisionPathMapping,
  finishHistoryLoadMore,
  formatLogDate,
  historyEntryMatches,
  isHistoryDateRangeReversed,
  localDateKey,
  nextHistoryLogRequest,
  normalizeHistoryPageSize,
  parseLogXml,
  recomputeHistoryView,
  resetHistorySession,
  resolveHistoryNodeAtRevision,
  revisionMatchesHistoryTrackedPath,
  updateHistoryDerivedCounters,
  urlForRepositoryPath,
  type HistoryEntry,
  type HistoryFilter,
  type HistoryLimits,
  type HistoryPathChange,
  type HistorySession,
  type HistorySource,
  type HistoryTarget,
} from '../src/core/history';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const FILE_TARGET: HistoryTarget = {
  url: 'https://svn.example.com/repo/trunk/target.txt',
  repositoryRootUrl: 'https://svn.example.com/repo',
  relativePath: 'trunk/target.txt',
  kind: 'file',
};

/** 构造一条历史记录；默认给目标路径自身记录。 */
function makeEntry(
  revision: number,
  options: {
    paths?: HistoryPathChange[];
    author?: string;
    date?: string;
    message?: string;
  } = {},
): HistoryEntry {
  return {
    revision,
    author: options.author,
    date: options.date,
    message: options.message ?? `r${revision}`,
    paths: options.paths ?? [{ path: '/trunk/target.txt', action: 'M' }],
  };
}

/** 目标自身路径命中记录；other 路径用于构造未命中。 */
function hitEntry(revision: number, extra: Partial<HistoryEntry> = {}): HistoryEntry {
  return makeEntry(revision, extra);
}

function otherEntry(revision: number, targetPath = '/trunk/target.txt'): HistoryEntry {
  return makeEntry(revision, { paths: [{ path: '/trunk/other.txt', action: 'M' }] });
}

interface LoadDriverServers {
  /** 主链（target 或 ancestor-filter）日志服务端。 */
  primary(cursor: number, limit: number): HistoryEntry[];
  /** copyfrom 来源源日志服务端；缺省返回空页。 */
  copyfrom?(source: HistorySource, cursor: number, limit: number): HistoryEntry[];
}

interface LoadDriverResult {
  mode: ReturnType<typeof beginHistoryLoadMore>;
  requests: number;
}

/**
 * 驱动一轮“加载更多”：按 nextHistoryLogRequest 的源与 cursor 调假服务端
 * 并应用回包，直到无请求可发。pageSize+1 即每页请求上限。
 */
function driveLoadMore(
  session: HistorySession,
  servers: LoadDriverServers,
  options: {
    pageSize?: number;
    limits?: HistoryLimits;
    filter?: HistoryFilter;
    target?: HistoryTarget;
  } = {},
): LoadDriverResult {
  const pageSize = options.pageSize ?? DEFAULT_HISTORY_PAGE_SIZE;
  const limits = options.limits ?? DEFAULT_HISTORY_LIMITS;
  const target = options.target ?? FILE_TARGET;
  const mode = beginHistoryLoadMore(session, limits);
  if (mode !== 'network') {
    if (mode === 'pending-only') {
      finishHistoryLoadMore(session, { pageSize, limits, filter: options.filter });
    }
    return { mode, requests: 0 };
  }
  let requests = 0;
  for (;;) {
    const request = nextHistoryLogRequest(session, pageSize, limits);
    if (request === undefined) {
      break;
    }
    requests += 1;
    const page = request.source.kind === 'copyfrom' && servers.copyfrom !== undefined
      ? servers.copyfrom(request.source, request.source.cursor, pageSize + 1)
      : servers.primary(request.source.cursor, pageSize + 1);
    applyHistoryLogPage(
      session,
      target,
      { sourceId: request.source.id, entries: page, requestedLimit: pageSize + 1 },
      { limits, filter: options.filter },
    );
  }
  finishHistoryLoadMore(session, { pageSize, limits, filter: options.filter });
  return { mode, requests };
}

/** 按 revision 降序、遵守 -l 的分页服务端（模拟 svn log 的区间语义）。 */
function rowsServer(rows: HistoryEntry[]): (cursor: number, limit: number) => HistoryEntry[] {
  const sorted = [...rows].sort((a, b) => b.revision - a.revision);
  return (cursor, limit) => sorted.filter((entry) => entry.revision <= cursor).slice(0, limit);
}

beforeEach(() => {
  vi.mocked(run).mockReset();
});

// ---------------------------------------------------------------------------
// 配置与常量
// ---------------------------------------------------------------------------

describe('historyPageSize 与上限常量', () => {
  it('仅接受 20/50/100，其余回退 50', () => {
    expect(HISTORY_PAGE_SIZES).toEqual([20, 50, 100]);
    expect(normalizeHistoryPageSize(20)).toBe(20);
    expect(normalizeHistoryPageSize(50)).toBe(50);
    expect(normalizeHistoryPageSize(100)).toBe(100);
    expect(normalizeHistoryPageSize(0)).toBe(DEFAULT_HISTORY_PAGE_SIZE);
    expect(normalizeHistoryPageSize(21)).toBe(DEFAULT_HISTORY_PAGE_SIZE);
    expect(normalizeHistoryPageSize(50.5)).toBe(DEFAULT_HISTORY_PAGE_SIZE);
    expect(normalizeHistoryPageSize('50')).toBe(DEFAULT_HISTORY_PAGE_SIZE);
    expect(normalizeHistoryPageSize(undefined)).toBe(DEFAULT_HISTORY_PAGE_SIZE);
    expect(normalizeHistoryPageSize(null)).toBe(DEFAULT_HISTORY_PAGE_SIZE);
  });

  it('产品默认值固定为 500/5,000/100,000', () => {
    expect(HISTORY_RAW_BUDGET_PER_LOAD).toBe(500);
    expect(HISTORY_MATCHED_LIMIT).toBe(5_000);
    expect(HISTORY_SCANNED_LIMIT).toBe(100_000);
    expect(DEFAULT_HISTORY_LIMITS).toEqual({
      matched: 5_000,
      scanned: 100_000,
      rawBudgetPerLoad: 500,
    });
  });
});

// ---------------------------------------------------------------------------
// log XML 解析
// ---------------------------------------------------------------------------

describe('parseLogXml', () => {
  it('解析多行说明、复制来源、kind/action 与缺失字段', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<log>
<logentry revision="7">
<author>alice</author>
<date>2026-11-12T23:30:00.000000Z</date>
<paths>
<path kind="file" action="A" copyfrom-path="/branches/b/x.txt" copyfrom-rev="4">/trunk/c/x.txt</path>
<path kind="dir" action="M">/trunk/c</path>
</paths>
<msg>修复登录 &amp; 标签
第二行</msg>
</logentry>
<logentry revision="6">
<paths>
<path kind="file" action="M" text-mods="true" prop-mods="false"> /trunk/spaced.txt </path>
</paths>
<msg>12345</msg>
</logentry>
<logentry revision="5">
<msg><![CDATA[CDATA 说明 & 原样]]></msg>
</logentry>
<logentry revision="4">
<author>A&amp;B</author>
<paths><path action="D">/trunk/x @1.txt</path></paths>
</logentry>
</log>`;
    const entries = parseLogXml(xml);
    expect(entries.map((entry) => entry.revision)).toEqual([7, 6, 5, 4]);
    const first = entries[0];
    expect(first.author).toBe('alice');
    expect(first.date).toBe('2026-11-12T23:30:00.000000Z');
    expect(first.message).toBe('修复登录 & 标签\n第二行');
    expect(first.paths).toEqual([
      {
        path: '/trunk/c/x.txt',
        action: 'A',
        kind: 'file',
        copyfromPath: '/branches/b/x.txt',
        copyfromRevision: 4,
        textMods: undefined,
        propMods: undefined,
      },
      {
        path: '/trunk/c',
        action: 'M',
        kind: 'dir',
        copyfromPath: undefined,
        copyfromRevision: undefined,
        textMods: undefined,
        propMods: undefined,
      },
    ]);
    // 数字说明保持字符串；首尾空格路径不 trim（XML 语义共测）。
    expect(entries[1].message).toBe('12345');
    expect(entries[1].author).toBeUndefined();
    expect(entries[1].paths[0].path).toBe(' /trunk/spaced.txt ');
    expect(entries[1].paths[0].textMods).toBe(true);
    expect(entries[1].paths[0].propMods).toBe(false);
    // CDATA 当作文本、实体只解码一次。
    expect(entries[2].message).toBe('CDATA 说明 & 原样');
    expect(entries[3].author).toBe('A&B');
    expect(entries[3].paths[0].path).toBe('/trunk/x @1.txt');
  });

  it('空输出与空 <log> 返回空数组，非法 revision 条目丢弃', () => {
    expect(parseLogXml('')).toEqual([]);
    expect(parseLogXml('<?xml version="1.0"?><log></log>')).toEqual([]);
    const entries = parseLogXml(
      '<log><logentry revision="x"><msg>bad</msg></logentry><logentry revision="2"><msg>ok</msg></logentry></log>',
    );
    expect(entries.map((entry) => entry.revision)).toEqual([2]);
  });

  it('1.6.17 形态（缺 text-mods/prop-mods）不改变历史行可用字段', () => {
    const entries = parseLogXml(
      '<log><logentry revision="3"><paths><path kind="file" action="M">/trunk/a.txt</path></paths><msg>m</msg></logentry></log>',
    );
    expect(entries[0].paths[0]).toMatchObject({
      path: '/trunk/a.txt',
      action: 'M',
      kind: 'file',
      textMods: undefined,
      propMods: undefined,
    });
  });

  it('畸形/截断/非 XML 输出抛 XML_PARSE，不静默返回空历史', () => {
    // fast-xml-parser 的 XMLParser 对截断文档会静默产出空对象，
    // 旧实现 catch 返回 []，宿主按 empty/noMatch 呈现；修复后必须抛
    // SvnError(code=XML_PARSE)，与 snapshot/blame 的解析失败口径一致。
    const malformed = [
      '<log><logentry revision="1">', // 截断：未闭合标签
      '<log', // 未闭合起始标签
      'not xml at all', // 非 XML 文本
      '<log></log><extra>', // 尾部未闭合
    ];
    for (const xml of malformed) {
      let caught: unknown;
      try {
        parseLogXml(xml);
      } catch (err) {
        caught = err;
      }
      expect(caught, xml).toBeInstanceOf(SvnError);
      expect((caught as SvnError).code).toBe('XML_PARSE');
      // 原始输出保留在 stderr 供诊断；message 不含凭据（此处也无）。
      expect((caught as SvnError).stderr.length).toBeGreaterThan(0);
      // core 不返回面向用户的中文叙述句（与 snapshot/blame 同口径）。
      expect((caught as Error).message).not.toMatch(/[一-鿿]/);
      expect((caught as Error).message).toContain('svn log XML parse failed');
    }
  });
});

// ---------------------------------------------------------------------------
// 命令参数与 URL 构造
// ---------------------------------------------------------------------------

describe('buildHistoryLogArgs', () => {
  const targetSource: HistorySource = {
    id: 'target',
    kind: 'target',
    queryUrl: 'https://svn.example.com/repo/trunk/target.txt',
    pegRevision: 560,
    pathFilter: '/trunk/target.txt',
    cursor: 560,
    scannedRaw: 0,
    exhausted: false,
  };

  it('target 源跟随复制时不传 --stop-on-copy，-l 为 pageSize+1 且 URL 带 peg', () => {
    expect(buildHistoryLogArgs(targetSource, 50, true)).toEqual([
      'log',
      '--xml',
      '-v',
      '--non-interactive',
      '-l',
      '51',
      '-r',
      '560:1',
      '--',
      'https://svn.example.com/repo/trunk/target.txt@560',
    ]);
  });

  it('target 源停在复制点时传 --stop-on-copy', () => {
    const args = buildHistoryLogArgs(targetSource, 20, false);
    expect(args).toContain('--stop-on-copy');
    expect(args[args.indexOf('-l') + 1]).toBe('21');
  });

  it('ancestor-filter 与 copyfrom 源始终传 --stop-on-copy，copyfrom 初始 cursor=copyfromRev', () => {
    const ancestor = createAncestorFilterSource(FILE_TARGET, 'trunk', 560);
    expect(ancestor.queryUrl).toBe('https://svn.example.com/repo/trunk');
    const ancestorArgs = buildHistoryLogArgs(ancestor, 50, true);
    expect(ancestorArgs).toContain('--stop-on-copy');
    expect(ancestorArgs[ancestorArgs.indexOf('-r') + 1]).toBe('560:1');

    const copy = {
      id: 'copyfrom-1',
      kind: 'copyfrom' as const,
      queryUrl: 'https://svn.example.com/repo/branches/base',
      pegRevision: 4,
      pathFilter: '/branches/base/x.txt',
      cursor: 4,
      scannedRaw: 0,
      exhausted: false,
    };
    const copyArgs = buildHistoryLogArgs(copy, 50, true);
    expect(copyArgs).toContain('--stop-on-copy');
    expect(copyArgs[copyArgs.indexOf('-r') + 1]).toBe('4:1');
    expect(copyArgs[copyArgs.length - 1]).toBe('https://svn.example.com/repo/branches/base@4');
  });

  it('含字面 @ 的 URL 也经统一 peg 构造器追加 peg', () => {
    const source: HistorySource = {
      ...targetSource,
      queryUrl: 'https://svn.example.com/repo/文档 目录/at@file#1.txt',
      pegRevision: 3,
      cursor: 3,
    };
    const args = buildHistoryLogArgs(source, 50, true);
    expect(args[args.length - 1]).toBe('https://svn.example.com/repo/文档 目录/at@file#1.txt@3');
  });
});

describe('urlForRepositoryPath', () => {
  it('仓库相对路径逐段编码（中文/空格/@/#），rootUrl 不二次编码', () => {
    expect(urlForRepositoryPath('https://svn.example.com/repo', 'trunk/文档 目录/at@file#1.txt'))
      .toBe('https://svn.example.com/repo/trunk/%E6%96%87%E6%A1%A3%20%E7%9B%AE%E5%BD%95/at%40file%231.txt');
    expect(urlForRepositoryPath('https://svn.example.com/repo/', '/trunk/a.txt')).toBe('https://svn.example.com/repo/trunk/a.txt');
    expect(urlForRepositoryPath('https://svn.example.com/repo', '')).toBe('https://svn.example.com/repo');
    expect(urlForRepositoryPath('https://svn.example.com/repo%20x', 'trunk')).toBe('https://svn.example.com/repo%20x/trunk');
  });
});

// ---------------------------------------------------------------------------
// ancestor-filter 严格命中规则（本地实测口径）
// ---------------------------------------------------------------------------

describe('revisionMatchesHistoryTrackedPath 严格规则', () => {
  const tracked = '/trunk/sub/file.txt';

  it('目标路径自身记录命中（任意 action）', () => {
    for (const action of ['A', 'M', 'D', 'R']) {
      expect(revisionMatchesHistoryTrackedPath(
        makeEntry(10, { paths: [{ path: tracked, action }] }),
        tracked,
        'file',
      )).toBe(true);
    }
  });

  it('祖先 D 命中；祖先 A/R 带 copyfrom 命中；祖先 A 无 copyfrom 不命中', () => {
    expect(revisionMatchesHistoryTrackedPath(
      makeEntry(9, { paths: [{ path: '/trunk/sub', action: 'D' }] }),
      tracked,
      'file',
    )).toBe(true);
    expect(revisionMatchesHistoryTrackedPath(
      makeEntry(8, {
        paths: [{ path: '/trunk', action: 'A', copyfromPath: '/branches/base', copyfromRevision: 3 }],
      }),
      tracked,
      'file',
    )).toBe(true);
    // 祖先目录首次创建（A 无 copyfrom、同 revision 未添加目标路径）不得命中，
    // 否则「目标从未存在」会被误判为有历史。
    expect(revisionMatchesHistoryTrackedPath(
      makeEntry(1, { paths: [{ path: '/trunk', action: 'A' }] }),
      tracked,
      'file',
    )).toBe(false);
  });

  it('同 revision 存在目标自身记录时该 revision 命中（严格规则的覆盖分支）', () => {
    const entry = makeEntry(1, {
      paths: [
        { path: '/trunk', action: 'A' },
        { path: tracked, action: 'A' },
      ],
    });
    expect(revisionMatchesHistoryTrackedPath(entry, tracked, 'file')).toBe(true);
  });

  it('目录目标命中任意后代；文件目标不因后代命中；兄弟路径不命中', () => {
    const entry = makeEntry(5, { paths: [{ path: '/trunk/sub/child.txt', action: 'M' }] });
    expect(revisionMatchesHistoryTrackedPath(entry, '/trunk/sub', 'dir')).toBe(true);
    expect(revisionMatchesHistoryTrackedPath(entry, '/trunk/sub/file.txt', 'file')).toBe(false);
    expect(revisionMatchesHistoryTrackedPath(
      makeEntry(5, { paths: [{ path: '/trunk/submarine.txt', action: 'M' }] }),
      '/trunk/sub',
      'dir',
    )).toBe(false);
    // 路径分段边界：/trunk/sub 不是 /trunk/submarine 的祖先。
    expect(revisionMatchesHistoryTrackedPath(
      makeEntry(5, { paths: [{ path: '/trunk/submarine.txt', action: 'M' }] }),
      '/trunk/submarine/file.txt',
      'file',
    )).toBe(false);
  });

  it('来源目录里的同名相对路径不误归给目标（按完整仓库路径前缀）', () => {
    const branchRecord = makeEntry(1, {
      paths: [{ path: '/branches/base/x.txt', action: 'M' }],
    });
    expect(revisionMatchesHistoryTrackedPath(branchRecord, '/trunk/x.txt', 'file')).toBe(false);
    // 目标祖先 /trunk 的任意记录也不因 basename 误归。
    expect(revisionMatchesHistoryTrackedPath(branchRecord, '/trunk', 'dir')).toBe(false);
  });

  it('根目录记录是任意路径的祖先结构变更', () => {
    expect(revisionMatchesHistoryTrackedPath(
      makeEntry(2, { paths: [{ path: '/', action: 'D' }] }),
      tracked,
      'file',
    )).toBe(true);
  });
});

describe('findCopySource 复制边界', () => {
  it('优先最具体（文件级）复制记录并把相对后缀带到来源', () => {
    const entries = [
      makeEntry(3, {
        paths: [
          { path: '/trunk', action: 'A', copyfromPath: '/branches/base', copyfromRevision: 1 },
          {
            path: '/trunk/x.txt',
            action: 'R',
            copyfromPath: '/branches/base/x.txt',
            copyfromRevision: 2,
          },
        ],
      }),
    ];
    expect(findCopySource(entries, '/trunk/x.txt', 'file')).toEqual({
      queryPath: '/branches/base/x.txt',
      pathFilter: '/branches/base/x.txt',
      copyRevision: 2,
      recordRevision: 3,
    });
  });

  it('目录目标的祖先复制按相对后缀映射来源（如 /branches/base + x.txt）', () => {
    const entries = [
      makeEntry(3, {
        paths: [{ path: '/trunk', action: 'A', copyfromPath: '/branches/base', copyfromRevision: 1 }],
      }),
    ];
    expect(findCopySource(entries, '/trunk/x.txt', 'file')).toMatchObject({
      queryPath: '/branches/base',
      pathFilter: '/branches/base/x.txt',
      copyRevision: 1,
    });
  });

  it('目录自身复制（A /C copyfrom /B@4）', () => {
    const entries = [
      makeEntry(5, {
        paths: [{ path: '/C', action: 'A', copyfromPath: '/B', copyfromRevision: 4 }],
      }),
    ];
    expect(findCopySource(entries, '/C', 'dir')).toMatchObject({
      queryPath: '/B',
      pathFilter: '/B',
      copyRevision: 4,
      recordRevision: 5,
    });
  });

  it('无 copyfrom 的首次 A 不建立来源（身份链结束）', () => {
    expect(findCopySource(
      [makeEntry(1, { paths: [{ path: '/A', action: 'A' }] })],
      '/A',
      'dir',
    )).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 身份链终止（无 copyfrom 的首次 A/R）
// ---------------------------------------------------------------------------

describe('身份链终止（无 copyfrom 的首次 A/R）', () => {
  it('跟踪路径自身首次重建后不再进入更早历史（更早记录不算命中）', () => {
    const session = createHistorySession({
      upperRevision: 12,
      upperSource: 'live-head',
      followCopies: true,
      targetPresentAtUpper: false,
      target: FILE_TARGET,
      nearestExistingAncestor: 'trunk',
    });
    applyHistoryLogPage(session, FILE_TARGET, {
      sourceId: 'ancestor-filter',
      entries: [
        // r12 重建（无 copyfrom）：命中并终止链。
        makeEntry(12, { paths: [{ path: '/trunk/target.txt', action: 'A' }] }),
        // 更早的删除/创建属于另一个身份：不进入历史。
        makeEntry(7, { paths: [{ path: '/trunk/target.txt', action: 'D' }] }),
        makeEntry(3, { paths: [{ path: '/trunk/target.txt', action: 'A' }] }),
      ],
      requestedLimit: 51,
    }, {});
    expect([...session.entriesByRevision.keys()]).toEqual([12]);
    // 回包中出现过的 revision 仍然计入扫描集合与原始预算。
    expect(session.scannedRevisionIds.size).toBe(3);
    expect(session.rawFetchedInLoad).toBe(3);
    expect(session.sources[0].exhausted).toBe(true);
    expect(nextHistoryLogRequest(session, 50)).toBeUndefined();
  });

  it('祖先目录首次创建（A 无 copyfrom）终止链：同页更早的目标记录不命中', () => {
    const session = createHistorySession({
      upperRevision: 5,
      upperSource: 'live-head',
      followCopies: true,
      targetPresentAtUpper: false,
      target: FILE_TARGET,
      nearestExistingAncestor: 'trunk',
    });
    applyHistoryLogPage(session, FILE_TARGET, {
      sourceId: 'ancestor-filter',
      entries: [
        makeEntry(5, { paths: [{ path: '/trunk', action: 'A' }] }),
        // 更早 revision 的目标自身记录也不属于当前身份链。
        makeEntry(3, { paths: [{ path: '/trunk/target.txt', action: 'M' }] }),
      ],
      requestedLimit: 51,
    }, {});
    expect(session.entriesByRevision.size).toBe(0);
    expect(session.sources[0].exhausted).toBe(true);
  });

  it('停在复制点（followCopies=false）：不压入 copyfrom 来源源', () => {
    const session = createHistorySession({
      upperRevision: 5,
      upperSource: 'live-head',
      followCopies: false,
      targetPresentAtUpper: false,
      target: FILE_TARGET,
      nearestExistingAncestor: 'trunk',
    });
    applyHistoryLogPage(session, FILE_TARGET, {
      sourceId: 'ancestor-filter',
      entries: [
        makeEntry(5, {
          paths: [{
            path: '/trunk/target.txt',
            action: 'A',
            copyfromPath: '/branches/base/target.txt',
            copyfromRevision: 4,
          }],
        }),
      ],
      requestedLimit: 51,
    }, {});
    expect(session.sources).toHaveLength(1);
    expect(session.entriesByRevision.has(5)).toBe(true);
  });

  it('目录目标的后代新增不终止当前目录身份', () => {
    const dirTarget: HistoryTarget = {
      ...FILE_TARGET,
      url: 'https://svn.example.com/repo/trunk/dir',
      relativePath: 'trunk/dir',
      kind: 'dir',
    };
    const session = createHistorySession({
      upperRevision: 5,
      upperSource: 'live-head',
      followCopies: true,
      targetPresentAtUpper: false,
      target: dirTarget,
      nearestExistingAncestor: 'trunk',
    });
    applyHistoryLogPage(session, dirTarget, {
      sourceId: 'ancestor-filter',
      entries: [
        makeEntry(5, { paths: [{ path: '/trunk/dir/child.txt', action: 'A' }] }),
        makeEntry(3, { paths: [{ path: '/trunk/dir/old.txt', action: 'M' }] }),
      ],
      // 页尾即源尾会按正常规则耗尽；这里让返回数等于请求数以只验证链终止。
      requestedLimit: 2,
    }, {});
    expect(session.entriesByRevision.size).toBe(2);
    expect(session.sources[0].exhausted).toBe(false);
  });

  it('未知 sourceId 的回包不改变会话', () => {
    const session = createHistorySession({
      upperRevision: 5,
      upperSource: 'live-head',
      followCopies: true,
      targetPresentAtUpper: true,
      target: FILE_TARGET,
    });
    const result = applyHistoryLogPage(session, FILE_TARGET, {
      sourceId: 'not-a-source',
      entries: [hitEntry(3)],
      requestedLimit: 51,
    }, {});
    expect(result).toEqual({ processed: 0, newMatches: 0 });
    expect(session.rawFetchedTotal).toBe(0);
    expect(session.entriesByRevision.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 单源 cursor 与批次
// ---------------------------------------------------------------------------

describe('单源 cursor 与批次', () => {
  it('下一批 cursor = 上一批最小 revision − 1，末页 cursor<1 不再请求 -r 0:1', () => {
    // 56 条线性历史；pageSize=50、每轮预算 21：每轮请求 -l 51，只处理 21 条。
    const rows: HistoryEntry[] = [];
    for (let revision = 56; revision >= 1; revision -= 1) {
      rows.push(hitEntry(revision));
    }
    const session = createHistorySession({
      upperRevision: 56,
      upperSource: 'live-head',
      followCopies: true,
      targetPresentAtUpper: true,
      target: FILE_TARGET,
    });
    const limits: HistoryLimits = { matched: 5_000, scanned: 100_000, rawBudgetPerLoad: 21 };
    const first = driveLoadMore(session, { primary: rowsServer(rows) }, {
      pageSize: 50,
      limits,
    });
    expect(first).toEqual({ mode: 'network', requests: 1 });
    expect(session.rawFetchedInLoad).toBe(21);
    expect(session.sources[0].cursor).toBe(35); // 36 - 1
    expect(session.displayedCount).toBe(21);

    // 后续轮独立预算 21：从 35 继续 21 条（35..15），cursor=14，源未耗尽。
    const second = driveLoadMore(session, { primary: rowsServer(rows) }, {
      pageSize: 50,
      limits,
    });
    expect(second).toEqual({ mode: 'network', requests: 1 });
    expect(session.rawFetchedInLoad).toBe(21);
    expect(session.sources[0].cursor).toBe(14);
    expect(session.sources[0].exhausted).toBe(false);

    // 第三轮：14..1 共 14 条（小于请求数 51）→ 源耗尽，cursor<1 本地停止。
    const third = driveLoadMore(session, { primary: rowsServer(rows) }, {
      pageSize: 50,
      limits,
    });
    expect(third).toEqual({ mode: 'network', requests: 1 });
    expect(session.rawFetchedInLoad).toBe(14);
    expect(session.sources[0].exhausted).toBe(true);
    expect(session.sources[0].cursor).toBe(0);
    // 56 条唯一 revision 全部进入扫描集合；命中全部 56 条。
    expect(session.scannedRevisionIds.size).toBe(56);
    expect(session.loadedMatchedCount).toBe(56);
    expect(session.displayedCount).toBe(56);
    // 不再发 -r 0:1：源耗尽后无请求。
    expect(nextHistoryLogRequest(session, 50, limits)).toBeUndefined();
  });

  it('空回包结束源；不会对已耗尽源继续请求', () => {
    const session = createHistorySession({
      upperRevision: 10,
      upperSource: 'snapshot',
      followCopies: true,
      targetPresentAtUpper: true,
      target: FILE_TARGET,
    });
    const result = driveLoadMore(session, { primary: () => [] }, { pageSize: 50 });
    expect(result.requests).toBe(1);
    expect(session.sources[0].exhausted).toBe(true);
    expect(session.rawFetchedTotal).toBe(0);
    expect(session.canFetchMore).toBe(false);
    expect(session.hasMore).toBe(false);
    expect(classifyHistoryOutcome(session, { targetPresentAtUpper: true })).toBe('empty');
  });

  it('目标在 upperRevision 不存在时建立 ancestor-filter 源，严格规则下 HITS 为空判 notFound', () => {
    const session = createHistorySession({
      upperRevision: 6,
      upperSource: 'live-head',
      followCopies: true,
      targetPresentAtUpper: false,
      target: { ...FILE_TARGET, relativePath: 'trunk/gone.txt', url: 'https://svn.example.com/repo/trunk/gone.txt' },
      nearestExistingAncestor: 'trunk',
    });
    expect(session.sources).toHaveLength(1);
    expect(session.sources[0]).toMatchObject({
      id: 'ancestor-filter',
      kind: 'ancestor-filter',
      queryUrl: 'https://svn.example.com/repo/trunk',
      pegRevision: 6,
      pathFilter: '/trunk/gone.txt',
      cursor: 6,
    });
    // 祖先目录首次创建（A /trunk 无 copyfrom）不得命中 gone.txt。
    const rows = [
      makeEntry(1, { paths: [{ path: '/trunk', action: 'A' }] }),
      otherEntry(2),
      otherEntry(3),
    ];
    driveLoadMore(session, { primary: rowsServer(rows) }, {
      target: { ...FILE_TARGET, relativePath: 'trunk/gone.txt' },
    });
    expect(session.loadedMatchedCount).toBe(0);
    expect(session.sources[0].exhausted).toBe(true);
    expect(classifyHistoryOutcome(session, { targetPresentAtUpper: false })).toBe('notFound');
  });
});

// ---------------------------------------------------------------------------
// 500 条扫描预算 → 80 匹配 → 50 展示 / 30 pending / next cursor=60
// ---------------------------------------------------------------------------

describe('500 条扫描预算（同构 fixture）', () => {
  /** budget 仓库：r560 删除目标；r481..r559 共 79 次修改；r1 创建。 */
  function buildBudgetRows(): HistoryEntry[] {
    const rows: HistoryEntry[] = [
      makeEntry(560, { paths: [{ path: '/trunk/target.txt', action: 'D' }] }),
    ];
    for (let revision = 559; revision >= 481; revision -= 1) {
      rows.push(hitEntry(revision));
    }
    for (let revision = 480; revision >= 61; revision -= 1) {
      rows.push(otherEntry(revision));
    }
    for (let revision = 60; revision >= 2; revision -= 1) {
      rows.push(otherEntry(revision));
    }
    rows.push(makeEntry(1, { paths: [{ path: '/trunk/target.txt', action: 'A' }] }));
    return rows;
  }

  it('单轮 500 扫描产出 80 命中、展示 50、pending 30、next cursor=60', () => {
    const rows = buildBudgetRows();
    const session = createHistorySession({
      upperRevision: 560,
      upperSource: 'live-head',
      followCopies: true,
      targetPresentAtUpper: false,
      target: FILE_TARGET,
      nearestExistingAncestor: 'trunk',
    });
    const first = driveLoadMore(session, { primary: rowsServer(rows) }, { pageSize: 50 });
    expect(first).toEqual({ mode: 'network', requests: 10 });
    expect(session.rawFetchedInLoad).toBe(500);
    expect(session.scannedThisLoad.size).toBe(500);
    expect(session.scannedUniqueRevisions).toBe(500);
    expect(session.loadedMatchedCount).toBe(80);
    expect(session.visibleMatched).toBe(80);
    expect(session.displayedCount).toBe(50);
    expect(session.visibleEntries.length - session.displayedCount).toBe(30);
    expect(session.sources[0].cursor).toBe(60);
    expect(session.canFetchMore).toBe(true);
    expect(session.hasMore).toBe(true);

    // 第二次 loadMore：先展示剩余 30 条，不发网络，单轮计数归零。
    const second = driveLoadMore(session, { primary: rowsServer(rows) }, { pageSize: 50 });
    expect(second).toEqual({ mode: 'pending-only', requests: 0 });
    expect(session.displayedCount).toBe(80);
    expect(session.rawFetchedInLoad).toBe(0);
    expect(session.scannedThisLoad.size).toBe(0);
    expect(session.rawFetchedTotal).toBe(500);

    // 第三次 loadMore：从 cursor=60 续扫 60 条（51+9），命中窗口外的 r1。
    const third = driveLoadMore(session, { primary: rowsServer(rows) }, { pageSize: 50 });
    expect(third).toEqual({ mode: 'network', requests: 2 });
    expect(session.rawFetchedInLoad).toBe(60);
    expect(session.loadedMatchedCount).toBe(81);
    expect(session.displayedCount).toBe(81);
    expect(session.sources[0].exhausted).toBe(true);
    expect(session.scannedUniqueRevisions).toBe(560);
    expect(session.canFetchMore).toBe(false);
    expect(session.hasMore).toBe(false);
  });

  it('单轮只推进 pending 时隐藏“本轮已处理/本轮唯一”所需的计数为零', () => {
    const rows = buildBudgetRows();
    const session = createHistorySession({
      upperRevision: 560,
      upperSource: 'live-head',
      followCopies: true,
      targetPresentAtUpper: false,
      target: FILE_TARGET,
      nearestExistingAncestor: 'trunk',
    });
    driveLoadMore(session, { primary: rowsServer(rows) }, { pageSize: 50 });
    driveLoadMore(session, { primary: rowsServer(rows) }, { pageSize: 50 });
    expect(session.rawFetchedInLoad).toBe(0);
    expect(session.scannedThisLoad.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 上限语义（同构小参数）
// ---------------------------------------------------------------------------

describe('5,000 命中 / 100,000 扫描上限语义（同构小参数）', () => {
  const limits: HistoryLimits = { matched: 2, scanned: 6, rawBudgetPerLoad: 6 };
  const pageSize = 2;

  function buildLimitSession(): HistorySession {
    return createHistorySession({
      upperRevision: 108,
      upperSource: 'live-head',
      followCopies: true,
      targetPresentAtUpper: false,
      target: FILE_TARGET,
      nearestExistingAncestor: 'trunk',
    });
  }

  function buildLimitRows(): HistoryEntry[] {
    return [
      otherEntry(108),
      otherEntry(107),
      hitEntry(106),
      hitEntry(105),
      otherEntry(104),
      hitEntry(103),
      hitEntry(102),
      otherEntry(101),
    ];
  }

  it('到达上限停止请求；最后一批越过完整保留；双 reason 并存且 actual 记录真实值', () => {
    const session = buildLimitSession();
    const result = driveLoadMore(session, { primary: rowsServer(buildLimitRows()) }, {
      pageSize,
      limits,
    });
    expect(result).toEqual({ mode: 'network', requests: 2 });
    // 本轮 6 条原始回包全部处理（6 = scanned limit，整页保留不截断）。
    expect(session.rawFetchedInLoad).toBe(6);
    expect(session.scannedThisLoad.size).toBe(6);
    expect(session.scannedUniqueRevisions).toBe(6);
    // 命中越过 matched limit（1 → 3）：完整保留 3 条命中。
    expect(session.loadedMatchedCount).toBe(3);
    expect(session.historyLimitState).toEqual({
      reasons: [
        { kind: 'matched', limit: 2, actual: 3 },
        { kind: 'scanned', limit: 6, actual: 6 },
      ],
    });
    expect(session.canFetchMore).toBe(false);
    // 仍有未展示匹配时 hasMore 保持 true。
    expect(session.displayedCount).toBe(2);
    expect(session.visibleMatched).toBe(3);
    expect(session.hasMore).toBe(true);

    // 已达上限后不再发出请求：下一轮 begin 只能 pending-only。
    expect(nextHistoryLogRequest(session, pageSize, limits)).toBeUndefined();

    // pending 清空后 hasMore 才转 false。
    const second = driveLoadMore(session, { primary: rowsServer(buildLimitRows()) }, {
      pageSize,
      limits,
    });
    expect(second).toEqual({ mode: 'pending-only', requests: 0 });
    expect(session.displayedCount).toBe(3);
    expect(session.hasMore).toBe(false);
    expect(session.canFetchMore).toBe(false);

    // 清理/关闭重开：新会话全部归零。
    expect(beginHistoryLoadMore(session, limits)).toBe('exhausted');
  });

  it('到达上限后即使预算未用尽也不再请求', () => {
    const session = buildLimitSession();
    driveLoadMore(session, { primary: rowsServer(buildLimitRows()) }, {
      pageSize,
      limits: { matched: 1, scanned: 100_000, rawBudgetPerLoad: 500 },
    });
    // 第一页 3 条就命中 1 条，达到 matched=1；下一请求前检查停止。
    expect(session.rawFetchedInLoad).toBe(3);
    expect(session.historyLimitState?.reasons).toEqual([
      { kind: 'matched', limit: 1, actual: 1 },
    ]);
    expect(session.canFetchMore).toBe(false);
    expect(nextHistoryLogRequest(session, pageSize, { matched: 1, scanned: 100_000, rawBudgetPerLoad: 500 }))
      .toBeUndefined();
  });

  it('scanned reason 的 actual 记录到达上限时的会话集合大小', () => {
    const session = buildLimitSession();
    // 扫描上限 3：第一批 3 条后到达，停止；无命中。
    driveLoadMore(session, { primary: rowsServer([otherEntry(108), otherEntry(107), otherEntry(106)]) }, {
      pageSize,
      limits: { matched: 100, scanned: 3, rawBudgetPerLoad: 500 },
    });
    expect(session.scannedUniqueRevisions).toBe(3);
    expect(session.historyLimitState?.reasons).toEqual([
      { kind: 'scanned', limit: 3, actual: 3 },
    ]);
  });

  it('checkHistoryLimits 幂等：同 kind 不重复记录，保留首次 actual', () => {
    const session = buildLimitSession();
    session.scannedRevisionIds.add(101);
    session.scannedRevisionIds.add(102);
    const first = checkHistoryLimits(session, { matched: 100, scanned: 2, rawBudgetPerLoad: 500 });
    expect(first).toEqual([{ kind: 'scanned', limit: 2, actual: 2 }]);
    session.scannedRevisionIds.add(103);
    const second = checkHistoryLimits(session, { matched: 100, scanned: 2, rawBudgetPerLoad: 500 });
    expect(second).toEqual([{ kind: 'scanned', limit: 2, actual: 3 }]);
    expect(session.historyLimitState?.reasons).toEqual([
      { kind: 'scanned', limit: 2, actual: 2 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 六类计数、跨源去重与连续两轮独立预算（同构 fixture）
// ---------------------------------------------------------------------------

describe('多源源栈、六类计数与连续两轮预算独立（同构 fixture）', () => {
  const pageSize = 50;
  const limits = DEFAULT_HISTORY_LIMITS;

  /**
   * gen-counts-fixture 生成的合成回包（直接注入，不经分页模拟）：
   * 第 1 轮祖先源 1397..901（497 条）+ copyfrom 源 903,902,901（与祖先
   * 重复）→ raw=500、唯一 497；第 2 轮祖先源 900..404（497 条）+
   * copyfrom 源 406,405,404（与祖先重复）→ 本轮 raw=500；累计 raw=1000、
   * 累计唯一 994。命中 r901（跨源）、r1000、r1100，r1100 作者 bob。
   */
  function buildAncestorEntries(hi: number, lo: number): HistoryEntry[] {
    const entries: HistoryEntry[] = [];
    for (let revision = hi; revision >= lo; revision -= 1) {
      if (revision === 1000) {
        entries.push(hitEntry(revision, { author: 'alice' }));
      } else if (revision === 1100) {
        entries.push(hitEntry(revision, { author: 'bob' }));
      } else if (revision === 901) {
        entries.push(makeEntry(revision, {
          author: 'alice',
          paths: [{
            path: '/trunk/target.txt',
            action: 'A',
            copyfromPath: '/branches/base/target.txt',
            copyfromRevision: 903,
          }],
        }));
      } else {
        entries.push(otherEntry(revision));
      }
    }
    return entries;
  }

  function buildCopyfromEntries(revisions: number[], hitRevision?: number): HistoryEntry[] {
    return revisions.map((revision) => makeEntry(revision, {
      author: 'alice',
      paths: [{
        path: revision === hitRevision ? '/branches/base/target.txt' : '/branches/base/other.txt',
        action: 'M',
      }],
    }));
  }

  function newCountsSession(): HistorySession {
    return createHistorySession({
      upperRevision: 1397,
      upperSource: 'live-head',
      followCopies: true,
      targetPresentAtUpper: false,
      target: FILE_TARGET,
      nearestExistingAncestor: 'trunk',
    });
  }

  it('每轮 500 条独立预算、同 revision 去重、累计与会话唯一计数分离', () => {
    const session = newCountsSession();

    // 第 1 轮：祖先页 → 压入来源源 → copyfrom 页。
    expect(beginHistoryLoadMore(session, limits)).toBe('network');
    applyHistoryLogPage(session, FILE_TARGET, {
      sourceId: 'ancestor-filter',
      entries: buildAncestorEntries(1397, 901),
      requestedLimit: 51,
    }, { limits });
    expect(session.rawFetchedInLoad).toBe(497);
    expect(session.scannedThisLoad.size).toBe(497);
    expect(session.sources.map((source) => source.kind)).toEqual(['ancestor-filter', 'copyfrom']);
    expect(session.sources[2]).toBeUndefined();
    expect(session.sources[1]).toMatchObject({
      queryUrl: 'https://svn.example.com/repo/branches/base/target.txt',
      pathFilter: '/branches/base/target.txt',
      pegRevision: 903,
      cursor: 903,
    });
    expect(session.sources[0].cursor).toBe(900);
    applyHistoryLogPage(session, FILE_TARGET, {
      sourceId: session.sources[1].id,
      entries: buildCopyfromEntries([903, 902, 901], 901),
      requestedLimit: 51,
    }, { limits });
    finishHistoryLoadMore(session, { pageSize, limits });

    expect(session.rawFetchedInLoad).toBe(500);
    expect(session.scannedThisLoad.size).toBe(497); // copyfrom 3 条与祖先重复
    expect(session.rawFetchedTotal).toBe(500);
    expect(session.scannedRevisionIds.size).toBe(497);
    expect(session.loadedMatchedCount).toBe(3); // r901（跨源合并）+ r1000 + r1100
    expect(session.visibleMatched).toBe(3);
    expect(session.displayedCount).toBe(3);
    expect(session.sources[1].cursor).toBe(900);
    // 每个源各自累计原始回包数（含跨源重复）。
    expect(session.sources[0].scannedRaw).toBe(497);
    expect(session.sources[1].scannedRaw).toBe(3);

    // 同 revision 变更路径并集：r901 同时保留目标新增与来源修改。
    const r901 = session.entriesByRevision.get(901);
    expect(r901?.paths.map((change) => change.path).sort()).toEqual([
      '/branches/base/target.txt',
      '/trunk/target.txt',
    ]);

    // 筛选只在已加载记录上重算：author=alice 隐藏 bob 的 r1100。
    recomputeHistoryView(session, { author: 'alice' }, pageSize);
    expect(session.visibleMatched).toBe(2);
    expect(session.displayedCount).toBe(2);
    // 筛选不改变已扫描源栈与累计计数。
    expect(session.rawFetchedTotal).toBe(500);
    expect(session.sources).toHaveLength(2);
    recomputeHistoryView(session, {}, pageSize);

    // 第 2 轮：独立预算重置后祖先源 900..404 + copyfrom 源 406,405,404。
    expect(beginHistoryLoadMore(session, limits)).toBe('network');
    expect(session.rawFetchedInLoad).toBe(0);
    expect(session.scannedThisLoad.size).toBe(0);
    applyHistoryLogPage(session, FILE_TARGET, {
      sourceId: 'ancestor-filter',
      entries: buildAncestorEntries(900, 404),
      requestedLimit: 51,
    }, { limits });
    applyHistoryLogPage(session, FILE_TARGET, {
      sourceId: session.sources[1].id,
      entries: buildCopyfromEntries([406, 405, 404]),
      requestedLimit: 51,
    }, { limits });
    finishHistoryLoadMore(session, { pageSize, limits });

    expect(session.rawFetchedInLoad).toBe(500);
    expect(session.scannedThisLoad.size).toBe(497);
    expect(session.rawFetchedTotal).toBe(1_000);
    expect(session.scannedUniqueRevisions).toBe(994); // 497 + 497（第 2 轮 copyfrom 与祖先重复）
    expect(session.loadedMatchedCount).toBe(3);
    // 会话“已扫描 N 条”不能拿 loadedMatchedCount 冒充。
    expect(session.scannedUniqueRevisions).not.toBe(session.loadedMatchedCount);
  });

  it('pending-only 轮不改变累计计数也不进网络', () => {
    const session = newCountsSession();
    expect(beginHistoryLoadMore(session, limits)).toBe('network');
    applyHistoryLogPage(session, FILE_TARGET, {
      sourceId: 'ancestor-filter',
      entries: buildAncestorEntries(1397, 901),
      requestedLimit: 51,
    }, { limits });
    applyHistoryLogPage(session, FILE_TARGET, {
      sourceId: session.sources[1].id,
      entries: buildCopyfromEntries([903, 902, 901], 901),
      requestedLimit: 51,
    }, { limits });
    finishHistoryLoadMore(session, { pageSize: 2, limits });
    expect(session.displayedCount).toBe(2);
    expect(session.visibleMatched).toBe(3);

    const rawBefore = session.rawFetchedTotal;
    expect(beginHistoryLoadMore(session, limits)).toBe('pending-only');
    expect(session.rawFetchedInLoad).toBe(0);
    expect(session.scannedThisLoad.size).toBe(0);
    finishHistoryLoadMore(session, { pageSize: 2, limits });
    expect(session.displayedCount).toBe(3);
    expect(session.rawFetchedTotal).toBe(rawBefore);
  });
});

// ---------------------------------------------------------------------------
// 筛选（作者口径，实测日期边界）
// ---------------------------------------------------------------------------

describe('筛选语义', () => {
  const entries: HistoryEntry[] = [
    makeEntry(1, {
      author: 'alice',
      message: '初始化 项目 文档',
      date: '2026-11-10T02:00:00.000000Z',
      paths: [{ path: '/trunk/文档 目录/说明.txt', action: 'A' }],
    }),
    makeEntry(2, {
      author: 'bob',
      message: '修复 登录 问题 & <标签>',
      date: '2026-11-12T23:30:00.000000Z',
      paths: [{ path: '/trunk/文档 目录/at@file#1.txt', action: 'M' }],
    }),
    makeEntry(3, {
      author: 'alice',
      message: 'special @ # path',
      date: '2026-11-20T04:00:00.000000Z',
      paths: [{ path: '/trunk/other.txt', action: 'M' }],
    }),
    makeEntry(4, {
      author: 'carol',
      message: 'copy 来源',
      date: '2026-11-25T04:00:00.000000Z',
      paths: [{
        path: '/trunk/new.txt',
        action: 'A',
        copyfromPath: '/trunk/dirB/old.txt',
        copyfromRevision: 3,
      }],
    }),
  ];

  function matchedRevisions(filter: HistoryFilter): number[] {
    return entries.filter((entry) => historyEntryMatches(entry, filter)).map((entry) => entry.revision);
  }

  it('关键词大小写不敏感匹配说明、作者、revision（含 rN）与全部路径（含复制来源）', () => {
    expect(matchedRevisions({ keyword: '登录' })).toEqual([2]);
    expect(matchedRevisions({ keyword: 'ALICE' })).toEqual([1, 3]);
    expect(matchedRevisions({ keyword: 'r2' })).toEqual([2]);
    expect(matchedRevisions({ keyword: '@file' })).toEqual([2]);
    expect(matchedRevisions({ keyword: 'dirb' })).toEqual([4]);
    expect(matchedRevisions({ keyword: '& <标签>' })).toEqual([2]);
  });

  it('作者精确（大小写不敏感）、路径子串、组合 AND', () => {
    expect(matchedRevisions({ author: 'BOB' })).toEqual([2]);
    expect(matchedRevisions({ author: 'ali' })).toEqual([]);
    expect(matchedRevisions({ path: 'AT@FILE#1' })).toEqual([2]);
    expect(matchedRevisions({ path: '文档' })).toEqual([1, 2]);
    expect(matchedRevisions({ path: 'dirb' })).toEqual([4]);
    expect(matchedRevisions({ keyword: '登录', author: 'bob' })).toEqual([2]);
    expect(matchedRevisions({ keyword: '登录', author: 'alice' })).toEqual([]);
    expect(matchedRevisions({})).toEqual([1, 2, 3, 4]);
  });

  it('日期按本地时区转换后比较（列表与筛选共用 localDateKey）', () => {
    const day2 = localDateKey(entries[1].date);
    expect(day2).toBeDefined();
    expect(matchedRevisions({ dateFrom: day2, dateTo: day2 })).toEqual([2]);
    // 自洽断言：与本地 getters 一致，不把 UTC 字符串直接当日期比较。
    const local = new Date(entries[1].date as string);
    const expected = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
    expect(day2).toBe(expected);
    expect(formatLogDate(entries[1].date)).toBe(`${expected} ${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`);
  });

  it('起止日期反序：isHistoryDateRangeReversed 为真时忽略日期条件（保留上一有效结果的判定）', () => {
    const reversed: HistoryFilter = { dateFrom: '2026-11-14', dateTo: '2026-11-10' };
    expect(isHistoryDateRangeReversed(reversed)).toBe(true);
    expect(matchedRevisions(reversed)).toEqual([1, 2, 3, 4]);
    expect(isHistoryDateRangeReversed({ dateFrom: '2026-11-10', dateTo: '2026-11-10' })).toBe(false);
    expect(isHistoryDateRangeReversed({})).toBe(false);
  });

  it('筛选变化只重算已加载记录的展示前缀，不重建源栈/不重发网络', () => {
    const session = createHistorySession({
      upperRevision: 4,
      upperSource: 'live-head',
      followCopies: true,
      targetPresentAtUpper: true,
      target: FILE_TARGET,
    });
    // 直接把 4 条记录并进会话（模拟已加载）。
    for (const entry of entries) {
      session.entriesByRevision.set(entry.revision, entry);
      session.scannedRevisionIds.add(entry.revision);
    }
    updateHistoryDerivedCounters(session);
    session.displayedCount = 4;
    const sourcesBefore = session.sources;
    const cursorBefore = session.sources[0].cursor;

    recomputeHistoryView(session, { author: 'alice' }, 2);
    expect(session.visibleMatched).toBe(2);
    expect(session.displayedCount).toBe(2);
    expect(session.entriesByRevision.size).toBe(4);
    expect(session.sources).toBe(sourcesBefore);
    expect(session.sources[0].cursor).toBe(cursorBefore);
    expect(session.rawFetchedTotal).toBe(0);
  });

  it('collectHistoryAuthors 按首次出现顺序去重', () => {
    expect(collectHistoryAuthors([
      makeEntry(5, { author: 'bob' }),
      makeEntry(4, { author: 'alice' }),
      makeEntry(3, { author: 'bob' }),
      makeEntry(2),
    ])).toEqual(['bob', 'alice']);
  });

  it('会话累计扫描作者：未命中提交的作者也进入 scannedAuthors，按首次出现顺序去重', () => {
    // ancestor-filter 源：目标自身路径记录命中，普通兄弟路径记录不命中。
    // 作者下拉口径是「已扫描原始批次中的实际作者」，命中过滤不影响作者收集。
    const session = createHistorySession({
      upperRevision: 10,
      upperSource: 'live-head',
      followCopies: true,
      targetPresentAtUpper: false,
      nearestExistingAncestor: 'trunk',
      target: FILE_TARGET,
    });
    const sourceId = session.sources[0]?.id ?? '';
    applyHistoryLogPage(session, FILE_TARGET, {
      sourceId,
      entries: [
        hitEntry(5, { author: 'alice' }),
        makeEntry(4, { author: 'bob', paths: [{ path: '/trunk/other.txt', action: 'M' }] }),
        hitEntry(3, { author: 'alice' }),
        makeEntry(2, { author: 'carol', paths: [{ path: '/trunk/other.txt', action: 'M' }] }),
        hitEntry(1),
      ],
      requestedLimit: 6,
    });
    // r5/r3/r1 命中（r1 无作者），r4/r2 未命中。
    expect(session.entriesByRevision.size).toBe(3);
    expect(session.scannedAuthors).toEqual(['alice', 'bob', 'carol']);
    // 跨页继续追加新作者；重复作者不重复收录。
    applyHistoryLogPage(session, FILE_TARGET, {
      sourceId,
      entries: [makeEntry(100, { author: 'dave', paths: [{ path: '/trunk/other.txt', action: 'M' }] })],
      requestedLimit: 6,
    });
    expect(session.scannedAuthors).toEqual(['alice', 'bob', 'carol', 'dave']);
  });

  it('resetHistorySession 清空 scannedAuthors（upper 三字段保留）', () => {
    const session = createHistorySession({
      upperRevision: 10,
      upperSource: 'live-head',
      followCopies: true,
      targetPresentAtUpper: true,
      target: FILE_TARGET,
    });
    applyHistoryLogPage(session, FILE_TARGET, {
      sourceId: session.sources[0]?.id ?? '',
      entries: [hitEntry(3, { author: 'alice' })],
      requestedLimit: 2,
    });
    expect(session.scannedAuthors).toEqual(['alice']);
    expect(resetHistorySession(session)).toBe(true);
    expect(session.scannedAuthors).toEqual([]);
    expect(session.upperRevision).toBe(10);
    expect(session.upperSource).toBe('live-head');
  });

  it('空筛选字段视为未启用', () => {
    expect(matchedRevisions({ keyword: '', author: '', path: '', dateFrom: '', dateTo: '' }))
      .toEqual([1, 2, 3, 4]);
  });
});

// ---------------------------------------------------------------------------
// upper 状态、resetHistorySession 与 refreshHistoryUpper
// ---------------------------------------------------------------------------

describe('upper 状态语义', () => {
  function resolvedSession(upperSource: 'live-head' | 'snapshot' | 'base-fallback' = 'live-head'): HistorySession {
    return createHistorySession({
      upperRevision: 10,
      upperSource,
      followCopies: true,
      targetPresentAtUpper: true,
      target: FILE_TARGET,
    });
  }

  function fillSession(session: HistorySession): void {
    session.entriesByRevision.set(3, hitEntry(3));
    session.visibleEntries = [hitEntry(3)];
    session.scannedRevisionIds.add(3);
    session.rawFetchedTotal = 1;
    session.rawFetchedInLoad = 1;
    session.scannedThisLoad.add(3);
    session.displayedCount = 1;
    session.historyLimitState = { reasons: [{ kind: 'matched', limit: 5_000, actual: 5_001 }] };
    updateHistoryDerivedCounters(session);
  }

  it('unresolved 初始态固定为 null/unresolved/unavailable 且无源', () => {
    const session = createUnresolvedHistorySession({ followCopies: true });
    expect(session.upperRevision).toBeNull();
    expect(session.upperSource).toBe('unresolved');
    expect(session.headState).toBe('unavailable');
    expect(session.sources).toEqual([]);
    expect(session.canFetchMore).toBe(false);
    expect(session.hasMore).toBe(false);
    expect(beginHistoryLoadMore(session)).toBe('exhausted');
    expect(classifyHistoryOutcome(session, { targetPresentAtUpper: true })).toBe('empty');
  });

  it('upperSource 与 headState 的冻结对应关系', () => {
    expect(resolvedSession('live-head').headState).toBe('available');
    expect(resolvedSession('snapshot').headState).toBe('unknown');
    expect(resolvedSession('base-fallback').headState).toBe('unavailable');
  });

  it('resetHistorySession：unresolved 拒绝；live-head/base-fallback 保持 upper 与 headState 并清空计数', () => {
    const unresolved = createUnresolvedHistorySession({ followCopies: true });
    expect(resetHistorySession(unresolved)).toBe(false);
    expect(unresolved.upperSource).toBe('unresolved');
    expect(unresolved.upperRevision).toBeNull();

    const live = resolvedSession('live-head');
    fillSession(live);
    expect(resetHistorySession(live)).toBe(true);
    expect(live.upperRevision).toBe(10);
    expect(live.upperSource).toBe('live-head');
    expect(live.headState).toBe('available');
    expect(live.followCopies).toBe(true);
    expect(live.sources).toEqual([]);
    expect(live.entriesByRevision.size).toBe(0);
    expect(live.visibleEntries).toEqual([]);
    expect(live.displayedCount).toBe(0);
    expect(live.scannedRevisionIds.size).toBe(0);
    expect(live.rawFetchedTotal).toBe(0);
    expect(live.rawFetchedInLoad).toBe(0);
    expect(live.scannedThisLoad.size).toBe(0);
    expect(live.scannedUniqueRevisions).toBe(0);
    expect(live.loadedMatchedCount).toBe(0);
    expect(live.visibleMatched).toBe(0);
    expect(live.historyLimitState).toBeNull();
    expect(live.canFetchMore).toBe(false);

    const fallback = resolvedSession('base-fallback');
    fillSession(fallback);
    expect(resetHistorySession(fallback)).toBe(true);
    expect(fallback.upperSource).toBe('base-fallback');
    expect(fallback.headState).toBe('unavailable');
    expect(fallback.upperRevision).toBe(10);
  });

  it('refreshHistoryUpper 运行时校验：非法 mode / snapshot / base-fallback 能力', () => {
    const unresolved = createUnresolvedHistorySession({ followCopies: true });
    const live = resolvedSession('live-head');
    const snapshot = resolvedSession('snapshot');
    const fallback = resolvedSession('base-fallback');

    expect(canRefreshHistoryUpper(live, 'head', { hasLocalBase: false })).toEqual({ ok: true, mode: 'head' });
    expect(canRefreshHistoryUpper(unresolved, 'head', { hasLocalBase: false })).toEqual({ ok: true, mode: 'head' });
    expect(canRefreshHistoryUpper(fallback, 'head', { hasLocalBase: true })).toEqual({ ok: true, mode: 'head' });
    expect(canRefreshHistoryUpper(snapshot, 'head', { hasLocalBase: true }))
      .toEqual({ ok: false, reason: 'snapshot-source' });
    for (const mode of ['full', 'base', '', 'HEAD']) {
      expect(canRefreshHistoryUpper(live, mode, { hasLocalBase: true }))
        .toEqual({ ok: false, reason: 'invalid-mode' });
    }

    expect(canRefreshHistoryUpper(unresolved, 'base-fallback', { hasLocalBase: true }))
      .toEqual({ ok: true, mode: 'base-fallback' });
    expect(canRefreshHistoryUpper(fallback, 'base-fallback', { hasLocalBase: true }))
      .toEqual({ ok: true, mode: 'base-fallback' });
    expect(canRefreshHistoryUpper(live, 'base-fallback', { hasLocalBase: true }))
      .toEqual({ ok: false, reason: 'source-live-head' });
    expect(canRefreshHistoryUpper(unresolved, 'base-fallback', { hasLocalBase: false }))
      .toEqual({ ok: false, reason: 'not-local-target' });
    expect(canRefreshHistoryUpper(snapshot, 'base-fallback', { hasLocalBase: true }))
      .toEqual({ ok: false, reason: 'snapshot-source' });
  });

  it('refresh head：live-head 同值提示已最新且保留数据；值变化清数据；来源恢复优先 live-head', () => {
    const live = resolvedSession('live-head');
    fillSession(live);
    expect(applyHistoryUpperRefresh(live, 'head', 10)).toBe('up-to-date');
    expect(live.rawFetchedTotal).toBe(1);
    expect(live.entriesByRevision.size).toBe(1);

    expect(applyHistoryUpperRefresh(live, 'head', 12)).toBe('updated');
    expect(live.upperRevision).toBe(12);
    expect(live.upperSource).toBe('live-head');
    expect(live.headState).toBe('available');
    expect(live.entriesByRevision.size).toBe(0);
    expect(live.rawFetchedTotal).toBe(0);

    // unresolved 恢复：即使 revision 数值等于本地 BASE，也属于来源恢复（清数据重读）。
    const unresolved = createUnresolvedHistorySession({ followCopies: true });
    expect(applyHistoryUpperRefresh(unresolved, 'head', 7)).toBe('updated');
    expect(unresolved.upperRevision).toBe(7);
    expect(unresolved.upperSource).toBe('live-head');
    expect(unresolved.headState).toBe('available');

    // base-fallback 恢复到 live-head（同值也更新来源）。
    const fallback = resolvedSession('base-fallback');
    fillSession(fallback);
    expect(applyHistoryUpperRefresh(fallback, 'head', 10)).toBe('updated');
    expect(fallback.upperSource).toBe('live-head');
    expect(fallback.headState).toBe('available');
    expect(fallback.upperRevision).toBe(10);
    expect(fallback.rawFetchedTotal).toBe(0);
  });

  it('refresh base-fallback：成功固定 base-fallback/unavailable；失败时不应用成功路径', () => {
    // 失败分支不发 core 命令（BASE 上限 log 探测失败由宿主在调用
    // applyHistoryUpperRefresh 之前分流），本用例只断言 core 成功路径的
    // 固定三字段与数据重置；失败语义由 historyModel/panel 层用失败 log
    // mock 断言（宿主测试域）。
    const fallback = resolvedSession('base-fallback');
    fillSession(fallback);

    expect(applyHistoryUpperRefresh(fallback, 'base-fallback', 7)).toBe('updated');
    expect(fallback.upperRevision).toBe(7);
    expect(fallback.upperSource).toBe('base-fallback');
    expect(fallback.headState).toBe('unavailable');
    expect(fallback.entriesByRevision.size).toBe(0);
    expect(fallback.rawFetchedTotal).toBe(0);
  });

  it('clearHistorySessionData 只清数据、不动 upper/headState/followCopies', () => {
    const live = resolvedSession('live-head');
    fillSession(live);
    clearHistorySessionData(live);
    expect(live.upperRevision).toBe(10);
    expect(live.upperSource).toBe('live-head');
    expect(live.headState).toBe('available');
    expect(live.followCopies).toBe(true);
    expect(live.sources).toEqual([]);
  });

  it('applyHistoryUpperRefresh 拒绝运行时非法 mode 与非法 revision', () => {
    const live = resolvedSession('live-head');
    expect(() => applyHistoryUpperRefresh(live, 'full' as unknown as 'head', 5)).toThrow(/非法/);
    expect(() => applyHistoryUpperRefresh(live, 'head', 0)).toThrow(/非法/);
    expect(live.upperRevision).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 实际节点映射与 notFoundAtRevision（mock svn info）
// ---------------------------------------------------------------------------

describe('resolveHistoryNodeAtRevision', () => {
  function infoOkXml(url: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<info>
<entry kind="file" path="target.txt" revision="7">
<url>${url}</url>
<relative-url>^/trunk/target.txt</relative-url>
<repository><root>https://svn.example.com/repo</root><uuid>u</uuid></repository>
<commit revision="7"><author>a</author><date>2026-11-12T00:00:00.000000Z</date></commit>
</entry>
</info>`;
  }

  function absentResult(): { stdout: string; stderr: string; exitCode: number } {
    return {
      stdout: '<?xml version="1.0" encoding="UTF-8"?>\n<info>\n</info>\n',
      stderr: "svn: warning: W170000: URL 'https://svn.example.com/repo/trunk/target.txt' non-existent in revision 2\nsvn: E200009: Could not display info for all targets because some targets don't exist",
      exitCode: 1,
    };
  }

  function infoOk(url: string): { stdout: string; stderr: string; exitCode: number } {
    return { stdout: infoOkXml(url), stderr: '', exitCode: 0 };
  }

  it('info 成功即 present，命令带 --non-interactive 与 URL@revision peg', async () => {
    vi.mocked(run).mockResolvedValueOnce(infoOk('https://svn.example.com/repo/trunk/target.txt'));
    const resolution = await resolveHistoryNodeAtRevision('svn', {
      target: FILE_TARGET,
      revision: 7,
      entries: [],
    });
    expect(resolution).toEqual({
      status: 'present',
      repositoryPath: 'trunk/target.txt',
      url: 'https://svn.example.com/repo/trunk/target.txt',
      revision: 7,
    });
    expect(vi.mocked(run).mock.calls[0][1]).toEqual([
      'info',
      '--xml',
      '--non-interactive',
      '--',
      'https://svn.example.com/repo/trunk/target.txt@7',
    ]);
  });

  it('info 返回的 URL 实体只解码一次（&amp;amp; 保持 &amp;）', async () => {
    vi.mocked(run).mockResolvedValueOnce(infoOk('https://svn.example.com/repo/a.txt?x=1&amp;y=2'));
    const resolution = await resolveHistoryNodeAtRevision('svn', {
      target: FILE_TARGET,
      revision: 7,
      entries: [],
    });
    expect(resolution).toMatchObject({ status: 'present', url: 'https://svn.example.com/repo/a.txt?x=1&y=2' });
  });

  it('认证失败（E170001）经统一补录重试一次，补录后成功回到 present', async () => {
    // resolveHistoryNodeAtRevision 旧实现直接 run、不消费
    // getCredentials，凭据失效时只报错不弹补录框；修复后走
    // runOrThrowWithRunner 的认证补录原语。
    vi.mocked(run)
      .mockResolvedValueOnce({ stdout: '', stderr: 'svn: E170001: Authentication failed', exitCode: 1 })
      .mockResolvedValueOnce(infoOk('https://svn.example.com/repo/trunk/target.txt'));
    const getCredentials = vi.fn().mockResolvedValue({ username: 'yu', password: 's3cret' });

    const resolution = await resolveHistoryNodeAtRevision('svn', {
      target: FILE_TARGET,
      revision: 7,
      entries: [],
    }, { getCredentials });

    expect(resolution).toMatchObject({ status: 'present', revision: 7 });
    expect(getCredentials).toHaveBeenCalledTimes(1);
    expect(vi.mocked(run)).toHaveBeenCalledTimes(2);
    // 重试参数在 `--` 之前插入凭据（`--` 及其后位置参数保持尾部）。
    expect(vi.mocked(run).mock.calls[1][1]).toEqual([
      'info',
      '--xml',
      '--non-interactive',
      '--username',
      'yu',
      '--password',
      's3cret',
      '--',
      'https://svn.example.com/repo/trunk/target.txt@7',
    ]);
  });

  it('补录取消：按原认证错误抛出，不重试', async () => {
    vi.mocked(run).mockResolvedValueOnce({
      stdout: '',
      stderr: 'svn: E215004: No more credentials or we tried too many times',
      exitCode: 1,
    });
    const getCredentials = vi.fn().mockResolvedValue(undefined);
    await expect(resolveHistoryNodeAtRevision('svn', {
      target: FILE_TARGET,
      revision: 7,
      entries: [],
    }, { getCredentials })).rejects.toBeInstanceOf(SvnError);
    expect(getCredentials).toHaveBeenCalledTimes(1);
    expect(vi.mocked(run)).toHaveBeenCalledTimes(1);
  });

  it('absent（W170000+E200009）不触发认证补录，直接进入复制窗口映射', async () => {
    vi.mocked(run).mockResolvedValueOnce(absentResult());
    const getCredentials = vi.fn();
    const resolution = await resolveHistoryNodeAtRevision('svn', {
      target: FILE_TARGET,
      revision: 2,
      entries: [],
    }, { getCredentials });
    expect(resolution).toEqual({ status: 'notFoundAtRevision' });
    expect(getCredentials).not.toHaveBeenCalled();
  });

  it('文件复制：所选 revision 早于复制 revision 时切换到 copyfrom 来源', async () => {
    vi.mocked(run)
      .mockResolvedValueOnce(absentResult())
      .mockResolvedValueOnce(infoOk('https://svn.example.com/repo/trunk/src.txt'));
    const entries = [
      makeEntry(3, {
        paths: [{
          path: '/trunk/target.txt',
          action: 'A',
          copyfromPath: '/trunk/src.txt',
          copyfromRevision: 2,
        }],
      }),
    ];
    const resolution = await resolveHistoryNodeAtRevision('svn', {
      target: FILE_TARGET,
      revision: 2,
      entries,
    });
    expect(resolution).toMatchObject({
      status: 'present',
      repositoryPath: 'trunk/src.txt',
      revision: 2,
    });
    expect(vi.mocked(run).mock.calls[1][1][4]).toBe('https://svn.example.com/repo/trunk/src.txt@2');
  });

  it('嵌套复制：来源 info 仍 absent 时继续沿复制窗口解析（多跳）', async () => {
    vi.mocked(run)
      // /C/x.txt@1 absent
      .mockResolvedValueOnce({
        stdout: '<info></info>',
        stderr: 'svn: warning: W170000: non-existent\nsvn: E200009: Could not display info',
        exitCode: 1,
      })
      // /B/x.txt@6 absent
      .mockResolvedValueOnce({
        stdout: '<info></info>',
        stderr: 'svn: warning: W170000: non-existent\nsvn: E200009: Could not display info',
        exitCode: 1,
      })
      // /A/x.txt@2 present
      .mockResolvedValueOnce(infoOk('https://svn.example.com/repo/A/x.txt'));
    const target: HistoryTarget = {
      url: 'https://svn.example.com/repo/C/x.txt',
      repositoryRootUrl: 'https://svn.example.com/repo',
      relativePath: 'C/x.txt',
      kind: 'file',
    };
    const entries = [
      makeEntry(10, {
        paths: [{ path: '/C', action: 'A', copyfromPath: '/B', copyfromRevision: 6 }],
      }),
      makeEntry(8, {
        paths: [{ path: '/B', action: 'A', copyfromPath: '/A', copyfromRevision: 2 }],
      }),
    ];
    const resolution = await resolveHistoryNodeAtRevision('svn', {
      target,
      revision: 1,
      entries,
    });
    expect(resolution).toMatchObject({
      status: 'present',
      repositoryPath: 'A/x.txt',
      revision: 2,
    });
    expect(vi.mocked(run).mock.calls.map((call) => call[1][4])).toEqual([
      'https://svn.example.com/repo/C/x.txt@1',
      'https://svn.example.com/repo/B/x.txt@6',
      'https://svn.example.com/repo/A/x.txt@2',
    ]);
  });

  it('删除提交：同 revision 的 D（含祖先目录删除）解析为 absent', async () => {
    vi.mocked(run).mockResolvedValueOnce({
      stdout: '<info></info>',
      stderr: 'svn: warning: W170000: non-existent\nsvn: E200009: Could not display info',
      exitCode: 1,
    });
    const target: HistoryTarget = {
      url: 'https://svn.example.com/repo/trunk/sub/file.txt',
      repositoryRootUrl: 'https://svn.example.com/repo',
      relativePath: 'trunk/sub/file.txt',
      kind: 'file',
    };
    const entries = [
      makeEntry(4, { paths: [{ path: '/trunk/sub', action: 'D' }] }),
    ];
    const resolution = await resolveHistoryNodeAtRevision('svn', {
      target,
      revision: 4,
      entries,
    });
    expect(resolution).toEqual({ status: 'absent', deletedRevision: 4 });
  });

  it('从未存在的目标（祖先首次 A 无 copyfrom）返回 notFoundAtRevision', async () => {
    vi.mocked(run).mockResolvedValueOnce({
      stdout: '<info></info>',
      stderr: 'svn: warning: W170000: non-existent\nsvn: E200009: Could not display info',
      exitCode: 1,
    });
    const target: HistoryTarget = {
      url: 'https://svn.example.com/repo/trunk/gone.txt',
      repositoryRootUrl: 'https://svn.example.com/repo',
      relativePath: 'trunk/gone.txt',
      kind: 'file',
    };
    const resolution = await resolveHistoryNodeAtRevision('svn', {
      target,
      revision: 6,
      entries: [makeEntry(1, { paths: [{ path: '/trunk', action: 'A' }] })],
    });
    expect(resolution).toEqual({ status: 'notFoundAtRevision' });
  });

  it('复制在所选 revision 本身发生时使用新路径（same-revision 分支）', async () => {
    vi.mocked(run).mockResolvedValueOnce({
      stdout: '<info></info>',
      stderr: 'svn: warning: W170000: non-existent\nsvn: E200009: Could not display info',
      exitCode: 1,
    });
    const entries = [
      makeEntry(3, {
        paths: [{
          path: '/trunk/target.txt',
          action: 'A',
          copyfromPath: '/trunk/src.txt',
          copyfromRevision: 2,
        }],
      }),
    ];
    const resolution = await resolveHistoryNodeAtRevision('svn', {
      target: FILE_TARGET,
      revision: 3,
      entries,
    });
    expect(resolution).toMatchObject({
      status: 'present',
      repositoryPath: 'trunk/target.txt',
      revision: 3,
    });
  });

  it('非 absent 的 info 失败原样抛出，不进入删除历史推定', async () => {
    vi.mocked(run).mockResolvedValueOnce({
      stdout: '',
      stderr: 'svn: E160006: No such revision 999',
      exitCode: 1,
    });
    await expect(resolveHistoryNodeAtRevision('svn', {
      target: FILE_TARGET,
      revision: 999,
      entries: [],
    })).rejects.toBeInstanceOf(SvnError);
    expect(vi.mocked(run)).toHaveBeenCalledTimes(1);
  });

  it('存在 entry 的 info 失败不构成 absent（E200009 单独出现不算证据）', async () => {
    vi.mocked(run).mockResolvedValueOnce({
      stdout: '<info><entry kind="file" path="x"><url>https://svn.example.com/repo/trunk/target.txt</url></entry></info>',
      stderr: 'svn: E200009: Could not display info for all targets because some targets don\'t exist',
      exitCode: 1,
    });
    await expect(resolveHistoryNodeAtRevision('svn', {
      target: FILE_TARGET,
      revision: 7,
      entries: [],
    })).rejects.toBeInstanceOf(SvnError);
  });
});

describe('findRevisionPathMapping', () => {
  it('复制记录覆盖所选 revision：早于复制切来源，等于复制用新路径，删除判 deleted，否则 unknown', () => {
    const copyEntry = makeEntry(5, {
      paths: [{
        path: '/trunk/target.txt',
        action: 'A',
        copyfromPath: '/trunk/src.txt',
        copyfromRevision: 4,
      }],
    });
    expect(findRevisionPathMapping([copyEntry], '/trunk/target.txt', 'file', 3)).toEqual({
      kind: 'copy',
      sourcePath: '/trunk/src.txt',
      sourceRevision: 4,
    });
    expect(findRevisionPathMapping([copyEntry], '/trunk/target.txt', 'file', 5))
      .toEqual({ kind: 'same-revision', revision: 5 });
    expect(findRevisionPathMapping([copyEntry], '/trunk/target.txt', 'file', 6))
      .toEqual({ kind: 'unknown' });
    expect(findRevisionPathMapping(
      [makeEntry(4, { paths: [{ path: '/trunk/sub', action: 'D' }] })],
      '/trunk/sub/file.txt',
      'file',
      5,
    )).toEqual({ kind: 'deleted', revision: 4 });
  });

  it('目录目标的后代复制不建立当前身份映射', () => {
    const childCopy = makeEntry(5, {
      paths: [{
        path: '/trunk/dir/child',
        action: 'A',
        copyfromPath: '/branches/child',
        copyfromRevision: 4,
      }],
    });
    expect(findRevisionPathMapping([childCopy], '/trunk/dir', 'dir', 3)).toEqual({ kind: 'unknown' });
  });
});

// ---------------------------------------------------------------------------
// 结果分类
// ---------------------------------------------------------------------------

describe('classifyHistoryOutcome', () => {
  function sessionWithMatches(count: number): HistorySession {
    const session = createHistorySession({
      upperRevision: 5,
      upperSource: 'live-head',
      followCopies: true,
      targetPresentAtUpper: true,
      target: FILE_TARGET,
    });
    for (let revision = 5; revision > 5 - count; revision -= 1) {
      session.entriesByRevision.set(revision, hitEntry(revision));
      session.scannedRevisionIds.add(revision);
    }
    session.sources[0].exhausted = true;
    updateHistoryDerivedCounters(session);
    recomputeHistoryView(session, {}, 50);
    return session;
  }

  it('ready / noMatch / empty / notFound 四态', () => {
    expect(classifyHistoryOutcome(sessionWithMatches(2), { targetPresentAtUpper: true })).toBe('ready');
    expect(classifyHistoryOutcome(sessionWithMatches(2), { targetPresentAtUpper: false })).toBe('ready');

    const noMatch = sessionWithMatches(2);
    recomputeHistoryView(noMatch, { keyword: '不存在的关键词' }, 50);
    expect(noMatch.visibleMatched).toBe(0);
    expect(classifyHistoryOutcome(noMatch, { targetPresentAtUpper: true })).toBe('noMatch');

    const empty = createHistorySession({
      upperRevision: 5,
      upperSource: 'live-head',
      followCopies: true,
      targetPresentAtUpper: true,
      target: FILE_TARGET,
    });
    empty.sources[0].exhausted = true;
    updateHistoryDerivedCounters(empty);
    expect(classifyHistoryOutcome(empty, { targetPresentAtUpper: true })).toBe('empty');
    expect(classifyHistoryOutcome(empty, { targetPresentAtUpper: false })).toBe('notFound');
  });

  it('尚无命中但仍有可扫描源时保持 ready（继续加载原始批次）', () => {
    const session = createHistorySession({
      upperRevision: 5,
      upperSource: 'live-head',
      followCopies: true,
      targetPresentAtUpper: false,
      target: FILE_TARGET,
      nearestExistingAncestor: 'trunk',
    });
    expect(classifyHistoryOutcome(session, { targetPresentAtUpper: false })).toBe('ready');
    expect(classifyHistoryOutcome(session, { targetPresentAtUpper: true })).toBe('ready');
  });
});
