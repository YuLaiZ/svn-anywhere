/**
 * P5 仓库浏览器模型（browseModel）状态机测试（M4 阶段 2）：
 * - 打开/根身份：目录默认展开并排队读取；文件入口直接选中；
 * - 常规目录（≤阈值）：名称列表探测后继续 XML 元数据，ready 后
 *   metadata=complete、首批 40；
 * - 两段式大目录（>阈值）：名称首屏立即 ready（metadata=pending）、
 *   精确总数、可见片元数据补全队列/进度/取消/旧回包丢弃；
 * - 加载更多 ≤40、100k 条目只保留在宿主模型（visible 仍为 40）；
 * - 选中/展开分离：选中走单节点 info 补全（名称模式），旧代次丢弃，
 *   详情 info 同步父条目元数据；
 * - 折叠清后代缓存与选中；父刷新取消后代；重试原路径；
 * - 节点错误不影响父级/兄弟；tooLarge 终态与 banner；空目录 ready+0；
 * - 会话恢复：browsableState 保存浏览 revision/展开路径/选中路径，
 *   beginOpen(restore) 后逐层恢复（含扩大可见片到命中条目）；
 * - buildPanelState：树行/详情 kv/元数据 banner 与取消动作/刷新入口。
 * 全部为纯模型调用，不依赖 vscode 与真实 svn。
 */
import { describe, expect, it } from 'vitest';
import {
  browseText,
  BrowseModel,
  BROWSE_FIRST_BATCH,
  BROWSE_METADATA_THRESHOLD,
  formatBytes,
  hasBrowseMeta,
  type BrowseDirState,
  type BrowseModelOptions,
  type BrowseNodeState,
} from '../src/host/panel/browseModel';
import type {
  BrowseDirectoryListing,
  BrowseDirectoryNames,
  BrowserError,
  RepoNodeRef,
} from '../src/core/remoteBrowse';

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

function childRef(parent: RepoNodeRef, name: string, kind: 'dir' | 'file' = 'file'): RepoNodeRef {
  return {
    ...parent,
    rawUrl: `${parent.rawUrl}/${encodeURIComponent(name)}`,
    relativePath: parent.relativePath === '' ? name : `${parent.relativePath}/${name}`,
    kind,
  };
}

function namesOf(entries: Array<{ name: string; kind?: 'dir' | 'file' }>): BrowseDirectoryNames {
  return {
    entries: entries.map((entry) => ({ name: entry.name, kind: entry.kind ?? 'file' })),
    total: entries.length,
    bytes: 100,
  };
}

function namesRange(count: number, prefix = 'file'): BrowseDirectoryNames {
  const entries = Array.from({ length: count }, (_, index) => ({
    name: `${prefix}-${String(index).padStart(5, '0')}.txt`,
    kind: 'file' as const,
  }));
  return { entries, total: count, bytes: count * 24 };
}

function listingOf(
  entries: Array<{ name: string; kind?: 'dir' | 'file'; meta?: Record<string, number | string> }>,
): BrowseDirectoryListing {
  return {
    listPath: `${ROOT_URL}/`,
    entries: entries.map((entry) => ({
      name: entry.name,
      kind: entry.kind ?? 'file',
      ...(entry.kind === 'dir' ? {} : { sizeBytes: 12 }),
      lastChangedRevision: 10,
      lastChangedAuthor: 'bob',
      lastChangedDate: '2026-11-01T09:00:00Z',
      ...(entry.meta ?? {}),
    })),
    total: entries.length,
    xmlBytes: 1000,
  };
}

const notFound: BrowserError = { kind: 'notFound', message: 'not found', codes: ['W160013'] };

/** 打开模型并应用根 info（目录）。 */
function openDir(options: BrowseModelOptions = {}): BrowseModel {
  const model = new BrowseModel(options);
  model.beginOpen(ROOT_URL);
  model.applyRootInfo(rootRef());
  return model;
}

function rootNode(model: BrowseModel): BrowseNodeState {
  const key = model.rootKeyValue;
  expect(key).toBeDefined();
  const node = model.nodeByKey(key as string);
  expect(node).toBeDefined();
  return node as BrowseNodeState;
}

function rootDir(model: BrowseModel): BrowseDirState {
  const dir = rootNode(model).dir;
  expect(dir).toBeDefined();
  return dir as BrowseDirState;
}

/** 让一个目录读取完成（常规目录：names 探测 branch 后 XML 元数据）。 */
function loadNodeAsXml(
  model: BrowseModel,
  key: string,
  entries: Array<{ name: string; kind?: 'dir' | 'file' }>,
): void {
  const requestSeq = model.beginNodeLoad(key);
  expect(requestSeq).toBeDefined();
  const names: BrowseDirectoryNames = {
    entries: entries.map((entry) => ({ name: entry.name, kind: entry.kind ?? 'file' })),
    total: entries.length,
    bytes: 100,
  };
  expect(model.completeNodeNames(key, requestSeq as number, names)).toBe('branch');
  expect(model.completeNodeListing(key, requestSeq as number, listingOf(entries))).toBe(true);
}

/** 让根目录读取完成（常规目录）。 */
function loadRootAsXml(
  model: BrowseModel,
  entriesOrListing: Array<{ name: string; kind?: 'dir' | 'file' }> | BrowseDirectoryListing,
): void {
  const entries = Array.isArray(entriesOrListing)
    ? entriesOrListing
    : entriesOrListing.entries.map((entry) => ({ name: entry.name, kind: entry.kind }));
  loadNodeAsXml(model, model.rootKeyValue as string, entries);
}

/* ------------------------------ 打开与根身份 ------------------------------ */

describe('打开与根身份', () => {
  it('目录入口：根节点建立、默认展开并排队读取；快照 revision 固定', () => {
    const model = openDir();
    expect(model.rootPhaseValue).toBe('ready');
    expect(model.snapshotRevisionValue).toBe(42);
    expect(model.repositoryUuidValue).toBe('uuid-1');
    const root = rootNode(model);
    expect(root.kind).toBe('dir');
    expect(root.expanded).toBe(true);
    expect(root.name).toBe('trunk');
    expect(model.takeLoadRequests()).toEqual([ROOT_URL]);
  });

  it('根 info 失败：rootPhase=error，树为空，banner 带重试入口且不可关闭', () => {
    const model = new BrowseModel();
    model.beginOpen(ROOT_URL);
    model.failOpen(notFound);
    expect(model.rootPhaseValue).toBe('error');
    expect(model.buildTreeRows()).toEqual([]);
    const state = model.buildPanelState('s1');
    const banner = state.banners.find((candidate) => candidate.id === 'browseRootError');
    expect(banner).toBeDefined();
    expect(banner?.dismissable).toBe(false);
    expect(banner?.actions?.map((action) => action.id)).toEqual(['retryBrowseRoot']);
    expect(state.lazyTree?.empty.title).toContain('无法打开仓库');
  });

  it('文件入口：不读取目录，直接选中并展示详情', () => {
    const model = new BrowseModel();
    model.beginOpen('https://example.com/repo/trunk/a.txt');
    model.applyRootInfo(rootRef({
      rawUrl: 'https://example.com/repo/trunk/a.txt',
      relativePath: 'trunk/a.txt',
      kind: 'file',
      lastChangedRevision: 41,
    }));
    expect(model.selectedNodeKey).toBe('https://example.com/repo/trunk/a.txt');
    expect(model.takeLoadRequests()).toEqual([]);
    const detail = model.buildPanelState('s1').detail;
    expect(detail?.title).toBe('a.txt');
    const kv = detail?.sections.find((section) => section.kind === 'kv');
    expect(kv?.kind).toBe('kv');
    if (kv?.kind === 'kv') {
      expect(kv.entries.map((entry) => entry.label)).toContain('节点 URL');
      expect(kv.entries.find((entry) => entry.label === '节点 URL')?.value)
        .toBe('https://example.com/repo/trunk/a.txt');
    }
  });

  it('根刷新：清空全部后代与选中，重新排队读取根目录', () => {
    const model = openDir();
    loadRootAsXml(model, listingOf([{ name: 'dir', kind: 'dir' }, { name: 'a.txt' }]));
    const childKey = `${ROOT_URL}/a.txt`;
    // 构建树行触发子节点创建并选中。
    model.buildTreeRows();
    expect(model.selectNode(childKey).ok).toBe(true);
    expect(model.nodeCount()).toBe(3);
    const result = model.reloadNode(ROOT_URL);
    expect(result.kind).toBe('root');
    expect(model.nodeCount()).toBe(0);
    expect(model.selectedNodeKey).toBeUndefined();
    expect(model.rootPhaseValue).toBe('loading');
    // 重新应用根 info（刷新为 HEAD r50）。
    model.applyRootRefresh(rootRef({ snapshotRevision: 50, lastChangedRevision: 50 }));
    expect(model.snapshotRevisionValue).toBe(50);
    expect(model.takeLoadRequests()).toEqual([ROOT_URL]);
  });
});

/* ------------------------------ 常规目录（≤阈值） ------------------------------ */

describe('常规目录：一次性 XML 元数据', () => {
  it('名称探测返回 branch；XML ready 后 metadata=complete、首批 40、已读=总数', () => {
    const model = openDir();
    const listing = listingOf(Array.from({ length: 80 }, (_, index) => ({ name: `f${index}.txt` })));
    loadRootAsXml(model, listing);
    const dir = rootDir(model);
    expect(dir.phase).toBe('ready');
    expect(dir.metadata).toBe('complete');
    expect(dir.total).toBe(80);
    expect(dir.entries.length).toBe(80);
    expect(dir.visible).toBe(BROWSE_FIRST_BATCH);
    expect(hasBrowseMeta(dir.entries[0].meta)).toBe(true);
    expect(dir.entries[0].meta.lastChangedRevision).toBe(10);
    expect(dir.entries[0].meta.sizeBytes).toBe(12);
    // 名称探测不进行补全任务。
    expect(model.metadataTasks()).toEqual([]);
    expect(model.hasMetadataWork()).toBe(false);
  });

  it('空目录：ready + total=0（不是错误），行状态显示空目录', () => {
    const model = openDir();
    loadRootAsXml(model, listingOf([]));
    const dir = rootDir(model);
    expect(dir.phase).toBe('ready');
    expect(dir.total).toBe(0);
    expect(dir.metadata).toBe('complete');
    const row = model.buildTreeRows()[0];
    expect(row.statusText).toBe('空目录');
    expect(row.expanded).toBe(true);
  });

  it('XML 模式加载更多：每次 ≤40，最后一页不超过总数，行内动作只在有更多时出现', () => {
    const model = openDir();
    loadRootAsXml(model, listingOf(Array.from({ length: 100 }, (_, index) => ({ name: `f${index}.txt` }))));
    expect(model.loadMore(ROOT_URL).added).toBe(40);
    expect(rootDir(model).visible).toBe(80);
    // 增量切片只构建本次新增的可见行（append 通道），不重走整棵树。
    const firstSlice = model.buildNodeSlice(ROOT_URL, 40, 40);
    expect(firstSlice.map((row) => row.label)).toEqual(
      Array.from({ length: 40 }, (_, index) => `f${40 + index}.txt`),
    );
    expect(firstSlice.every((row) => row.depth === 1 && row.kind === 'file')).toBe(true);
    expect(model.buildNodeSlice(ROOT_URL, 80, 40)).toEqual([]);
    expect(model.loadMore(ROOT_URL).added).toBe(20);
    expect(rootDir(model).visible).toBe(100);
    const lastSlice = model.buildNodeSlice(ROOT_URL, 80, 40);
    expect(lastSlice.map((row) => row.label)).toEqual(
      Array.from({ length: 20 }, (_, index) => `f${80 + index}.txt`),
    );
    expect(model.buildNodeSlice(ROOT_URL, 100, 40)).toEqual([]);
    expect(model.buildNodeSlice(ROOT_URL, 0, 0)).toEqual([]);
    expect(model.loadMore(ROOT_URL).added).toBe(0);
    // 未知节点或未展开节点没有可追加的子行切片。
    expect(model.buildNodeSlice('missing', 0, 40)).toEqual([]);
    // 加载更多不产生补全任务（元数据已在内存）。
    expect(model.metadataTasks()).toEqual([]);
    const rows = model.buildTreeRows();
    // 根节点的“加载更多”由树级动作承载；树级动作在有更多时存在。
    const state = model.buildPanelState('s1');
    expect(state.lazyTree?.rows[0].children?.length).toBe(100);
    expect(rows[0].actions?.some((action) => action.id === 'loadMoreBrowserNode')).toBeFalsy();
  });
});

/* ------------------------------ 两段式大目录 ------------------------------ */

describe('两段式大目录：名称首屏 + 可取消元数据补全', () => {
  function openLarge(total: number, firstBatch = 4): BrowseModel {
    const model = openDir({ threshold: 1, firstBatch, metadataConcurrency: 2 });
    const requestSeq = model.beginNodeLoad(ROOT_URL) as number;
    expect(model.completeNodeNames(ROOT_URL, requestSeq, namesRange(total))).toBe('done');
    return model;
  }

  it('超过阈值：立即 ready（metadata=pending）、精确总数、首批 4、可见片入队', () => {
    const model = openLarge(10);
    const dir = rootDir(model);
    expect(dir.phase).toBe('ready');
    expect(dir.nameMode).toBe(true);
    expect(dir.metadata).toBe('pending');
    expect(dir.total).toBe(10);
    expect(dir.entries.length).toBe(10);
    expect(dir.visible).toBe(4);
    expect(dir.metadataProgress).toEqual({ completed: 0, total: 4 });
    expect(dir.metadataQueue).toEqual([0, 1, 2, 3]);
    const row = model.buildTreeRows()[0];
    expect(row.total).toBe(10);
    expect(row.loaded).toBe(10);
    expect(row.metadata).toBe('pending');
    expect(row.statusText).toContain('元数据待补全');
  });

  it('100k 条目只保留宿主紧凑数组：visible 仍为首批 40，补全任务按并发上限取出', () => {
    const model = new BrowseModel();
    model.beginOpen(ROOT_URL);
    model.applyRootInfo(rootRef());
    const requestSeq = model.beginNodeLoad(ROOT_URL) as number;
    expect(model.completeNodeNames(ROOT_URL, requestSeq, namesRange(100_000))).toBe('done');
    const dir = rootDir(model);
    expect(dir.total).toBe(100_000);
    expect(dir.entries.length).toBe(100_000);
    expect(dir.visible).toBe(BROWSE_FIRST_BATCH);
    expect(dir.metadataQueue.length).toBe(BROWSE_FIRST_BATCH);
    const tasks = model.metadataTasks();
    expect(tasks.length).toBeLessThanOrEqual(4);
    expect(tasks.every((task) => task.url.startsWith(ROOT_URL))).toBe(true);
    // 第二批任务不会超过总并发。
    const more = model.metadataTasks();
    expect(tasks.length + more.length).toBeLessThanOrEqual(model.metadataConcurrency);
    // 模型本身不把任何条目推给视图：树行 count 只含首批。
    expect(model.buildTreeRows()[0].children?.length).toBe(BROWSE_FIRST_BATCH);
  });

  it('补全任务回写元数据并推进进度；全部可见条目完成后 metadata=complete', () => {
    const model = openLarge(4);
    const tasks = model.metadataTasks();
    expect(tasks.length).toBe(2);
    for (const task of tasks) {
      expect(model.applyMetadata(task.nodeKey, task.entryIndex, task.metadataSeq, {
        lastChangedRevision: 7,
        lastChangedAuthor: 'carol',
        sizeBytes: 99,
      })).toBe(true);
    }
    let dir = rootDir(model);
    expect(dir.metadataProgress.completed).toBe(2);
    expect(hasBrowseMeta(dir.entries[0].meta)).toBe(true);
    const next = model.metadataTasks();
    expect(next.length).toBe(2);
    for (const task of next) {
      model.applyMetadata(task.nodeKey, task.entryIndex, task.metadataSeq, { lastChangedRevision: 8 });
    }
    dir = rootDir(model);
    expect(dir.metadata).toBe('complete');
    expect(dir.metadataProgress).toEqual({ completed: 4, total: 4 });
    expect(model.hasMetadataWork()).toBe(false);
  });

  it('补全失败也推进进度（行保持占位），不会无限重试', () => {
    const model = openLarge(2);
    const tasks = model.metadataTasks();
    expect(tasks.length).toBe(2);
    for (const task of tasks) {
      model.applyMetadata(task.nodeKey, task.entryIndex, task.metadataSeq, { error: notFound });
    }
    const dir = rootDir(model);
    // 失败条目保持占位（不计入“已补全”），队列/在途清空后不再重试。
    expect(dir.metadataProgress.completed).toBe(0);
    expect(hasBrowseMeta(dir.entries[0].meta)).toBe(false);
    expect(model.hasMetadataWork()).toBe(false);
    expect(dir.metadata).toBe('pending');
  });

  it('取消补全：状态 cancelled、在途回包按代次丢弃、已补全保留、加载更多恢复补全', () => {
    const model = openLarge(8);
    const tasks = model.metadataTasks();
    expect(tasks.length).toBe(2);
    // 完成一个，另一个在途。
    model.applyMetadata(tasks[0].nodeKey, tasks[0].entryIndex, tasks[0].metadataSeq, {
      lastChangedRevision: 1,
    });
    const cancelled = model.cancelMetadata();
    expect(cancelled).toEqual([ROOT_URL]);
    let dir = rootDir(model);
    expect(dir.metadata).toBe('cancelled');
    expect(dir.metadataQueue).toEqual([]);
    expect(dir.metadataInFlight).toEqual([]);
    expect(hasBrowseMeta(dir.entries[tasks[0].entryIndex].meta)).toBe(true);
    // 取消后旧任务回包（旧代次）被丢弃。
    expect(model.applyMetadata(tasks[0].nodeKey, tasks[0].entryIndex, tasks[0].metadataSeq, {
      lastChangedRevision: 2,
    })).toBe(false);
    expect(model.metadataTasks()).toEqual([]);
    // 加载更多：新可见片入队并把状态恢复为 pending。
    expect(model.loadMore(ROOT_URL).added).toBe(4);
    dir = rootDir(model);
    expect(dir.visible).toBe(8);
    expect(dir.metadata).toBe('pending');
    expect(dir.metadataQueue.length).toBeGreaterThan(0);
    expect(model.metadataTasks().length).toBeGreaterThan(0);
  });

  it('元数据 banner 汇总进度并提供取消动作；取消后 banner 消失', () => {
    const model = openLarge(4);
    model.metadataTasks();
    const state = model.buildPanelState('s1');
    const banner = state.banners.find((candidate) => candidate.id === 'browseMetadata');
    expect(banner).toBeDefined();
    expect(banner?.title).toContain('元数据补全中');
    expect(banner?.actions?.map((action) => action.id)).toEqual(['cancelBrowserMetadata']);
    expect(banner?.dismissable).toBe(false);
    model.cancelMetadata();
    const after = model.buildPanelState('s1');
    expect(after.banners.some((candidate) => candidate.id === 'browseMetadata')).toBe(false);
  });

  it('选中节点走单节点 info 不等批次：详情 loading → info 回包补全详情与条目元数据', () => {
    const model = openLarge(10);
    model.buildTreeRows();
    const childKey = `${ROOT_URL}/file-00000.txt`;
    const selection = model.selectNode(childKey);
    expect(selection.ok).toBe(true);
    expect(selection.detail).toBeDefined();
    const request = selection.detail!;
    expect(model.buildPanelState('s1').detail?.sections.some((section) => section.kind === 'text')).toBe(true);
    // 旧代次回包被丢弃。
    expect(model.applyDetailInfo(childKey, request.detailSeq + 1, { ref: childRef(rootRef(), 'x.txt') })).toBe(false);
    const result = model.applyDetailInfo(childKey, request.detailSeq, {
      ref: childRef(rootRef(), 'file-00000.txt'),
      sizeBytes: 321,
    });
    expect(result).toBe(true);
    const dir = rootDir(model);
    expect(dir.entries[0].meta.lastChangedRevision).toBe(40);
    expect(dir.entries[0].meta.sizeBytes).toBe(321);
    // 详情 info 也把该条目从补全队列中完成并推进进度。
    expect(dir.metadataQueue).not.toContain(0);
    expect(dir.metadataProgress.completed).toBe(1);
    const detail = model.buildPanelState('s1').detail;
    expect(detail?.title).toBe('file-00000.txt');
    const kv = detail?.sections.find((section) => section.kind === 'kv');
    if (kv?.kind === 'kv') {
      expect(kv.entries.find((entry) => entry.label === '文件大小')?.value).toBe('321 B');
      expect(kv.entries.find((entry) => entry.label === '节点最后修改')?.value).toBe('r40');
    }
  });

  it('选中 info 与后台补全并发命中同一条目：补全进度不重复计数', () => {
    const model = openLarge(4);
    const tasks = model.metadataTasks();
    const task = tasks[0];
    model.buildTreeRows();
    // 选中同一条目（名称模式元数据缺失）→ 详情 info。
    const childKey = `${ROOT_URL}/file-00000.txt`;
    const selection = model.selectNode(childKey);
    expect(selection.detail).toBeDefined();
    model.applyDetailInfo(childKey, selection.detail!.detailSeq, {
      ref: childRef(rootRef(), 'file-00000.txt'),
      sizeBytes: 10,
    });
    expect(rootDir(model).metadataProgress.completed).toBe(1);
    // 后台补全任务随后回包：条目已完整，进度保持 1。
    model.applyMetadata(task.nodeKey, task.entryIndex, task.metadataSeq, { lastChangedRevision: 9 });
    expect(rootDir(model).metadataProgress.completed).toBe(1);
  });

  it('并行展开两个目录：请求互不取消，各自回包各自生效', () => {
    const model = openDir();
    loadRootAsXml(model, [{ name: 'left', kind: 'dir' }, { name: 'right', kind: 'dir' }]);
    model.buildTreeRows();
    expect(model.toggleNode(`${ROOT_URL}/left`).needLoad).toBe(true);
    expect(model.toggleNode(`${ROOT_URL}/right`).needLoad).toBe(true);
    expect(model.takeLoadRequests()).toEqual([`${ROOT_URL}/left`, `${ROOT_URL}/right`]);
    const leftSeq = model.beginNodeLoad(`${ROOT_URL}/left`) as number;
    const rightSeq = model.beginNodeLoad(`${ROOT_URL}/right`) as number;
    // right 先回包不影响 left 的请求代次。
    expect(model.completeNodeNames(`${ROOT_URL}/right`, rightSeq, namesOf([{ name: 'r.txt' }]))).toBe('branch');
    expect(model.completeNodeListing(`${ROOT_URL}/right`, rightSeq, listingOf([{ name: 'r.txt' }]))).toBe(true);
    expect(model.isNodeRequestCurrent(`${ROOT_URL}/left`, leftSeq)).toBe(true);
    expect(model.completeNodeNames(`${ROOT_URL}/left`, leftSeq, namesOf([{ name: 'l.txt' }]))).toBe('branch');
    expect(model.completeNodeListing(`${ROOT_URL}/left`, leftSeq, listingOf([{ name: 'l.txt' }]))).toBe(true);
    const rows = model.buildTreeRows()[0].children ?? [];
    expect(rows.find((row) => row.label === 'left')?.children?.[0].label).toBe('l.txt');
    expect(rows.find((row) => row.label === 'right')?.children?.[0].label).toBe('r.txt');
  });

  it('XML 模式选中不需要 info（元数据已完整）', () => {
    const model = openDir();
    loadRootAsXml(model, listingOf([{ name: 'a.txt' }]));
    model.buildTreeRows();
    const selection = model.selectNode(`${ROOT_URL}/a.txt`);
    expect(selection.ok).toBe(true);
    expect(selection.detail).toBeUndefined();
    const detail = model.buildPanelState('s1').detail;
    expect(detail?.title).toBe('a.txt');
  });
});

/* ------------------------------ 展开/折叠/刷新 ------------------------------ */

describe('展开、折叠与刷新', () => {
  it('展开是独立意图：展开未读目录排队读取，不改变选中', () => {
    const model = openDir();
    loadRootAsXml(model, [{ name: 'docs', kind: 'dir' }, { name: 'a.txt' }]);
    model.buildTreeRows();
    const docsKey = `${ROOT_URL}/docs`;
    const selection = model.selectNode(`${ROOT_URL}/a.txt`);
    expect(selection.ok).toBe(true);
    const result = model.toggleNode(docsKey);
    expect(result.action).toBe('expand');
    expect(result.needLoad).toBe(true);
    expect(model.takeLoadRequests()).toEqual([docsKey]);
    // 选中未因展开而改变。
    expect(model.selectedNodeKey).toBe(`${ROOT_URL}/a.txt`);
    // 展开后再次折叠：不重读。
    const collapse = model.toggleNode(docsKey);
    expect(collapse.action).toBe('collapse');
    expect(model.toggleNode(docsKey).needLoad).toBe(true);
  });

  it('折叠清空后代缓存与后代选中；再次展开按原快照 revision 重新读取', () => {
    const model = openDir();
    loadRootAsXml(model, [{ name: 'docs', kind: 'dir' }]);
    const docsKey = `${ROOT_URL}/docs`;
    model.buildTreeRows();
    // 展开 docs 并加载其子目录。
    model.toggleNode(docsKey);
    loadNodeAsXml(model, docsKey, [{ name: 'deep.txt' }]);
    model.buildTreeRows();
    expect(model.selectNode(`${docsKey}/deep.txt`).ok).toBe(true);
    expect(model.nodeCount()).toBe(3);
    // 折叠 docs：删除其子节点并清除选中。
    const collapse = model.toggleNode(docsKey);
    expect(collapse.action).toBe('collapse');
    expect(collapse.removed).toEqual([`${docsKey}/deep.txt`]);
    expect(model.nodeCount()).toBe(2);
    expect(model.selectedNodeKey).toBeUndefined();
    // 再次展开：dir 状态已 ready，不重新读取。
    const expand = model.toggleNode(docsKey);
    expect(expand.action).toBe('expand');
    expect(expand.needLoad).toBe(false);
    expect(model.takeLoadRequests()).toEqual([]);
    expect(model.buildTreeRows()[0].children?.[0].children?.[0].label).toBe('deep.txt');
  });

  it('父目录刷新：清空该节点与全部后代（返回删除键供控制器取消），保留兄弟', () => {
    const model = openDir();
    loadRootAsXml(model, [{ name: 'docs', kind: 'dir' }, { name: 'other', kind: 'dir' }]);
    model.buildTreeRows();
    model.toggleNode(`${ROOT_URL}/docs`);
    model.toggleNode(`${ROOT_URL}/other`);
    loadNodeAsXml(model, `${ROOT_URL}/docs`, [{ name: 'deep.txt' }]);
    loadNodeAsXml(model, `${ROOT_URL}/other`, []);
    model.buildTreeRows();
    expect(model.nodeCount()).toBe(4);
    const result = model.reloadNode(`${ROOT_URL}/docs`);
    expect(result.kind).toBe('node');
    expect(result.removed).toEqual([`${ROOT_URL}/docs/deep.txt`]);
    expect(model.nodeCount()).toBe(3);
    // 兄弟节点 other 仍在且展开。
    expect(model.nodeByKey(`${ROOT_URL}/other`)?.expanded).toBe(true);
    // docs 重新进入读取队列且展开。
    expect(model.nodeByKey(`${ROOT_URL}/docs`)?.expanded).toBe(true);
    expect(model.takeLoadRequests()).toEqual([`${ROOT_URL}/docs`]);
  });

  it('旧请求回包不覆盖当前树：刷新后按新代次归属，旧代次为 stale', () => {
    const model = openDir();
    const oldSeq = model.beginNodeLoad(ROOT_URL) as number;
    // 刷新根节点（模拟），再读取。
    model.reloadNode(ROOT_URL);
    model.applyRootRefresh(rootRef({ snapshotRevision: 43 }));
    const newSeq = model.beginNodeLoad(ROOT_URL) as number;
    expect(model.completeNodeNames(ROOT_URL, oldSeq, namesRange(3))).toBe('stale');
    expect(model.completeNodeNames(ROOT_URL, newSeq, namesOf([{ name: 'a.txt' }]))).toBe('branch');
    expect(model.completeNodeListing(ROOT_URL, newSeq, listingOf([{ name: 'a.txt' }]))).toBe(true);
    expect(rootDir(model).total).toBe(1);
  });

  it('节点错误只写该节点：父级与兄弟保持 ready，重试重新排队原 URL', () => {
    const model = openDir();
    loadRootAsXml(model, [{ name: 'bad', kind: 'dir' }, { name: 'good', kind: 'dir' }]);
    model.buildTreeRows();
    model.toggleNode(`${ROOT_URL}/bad`);
    model.toggleNode(`${ROOT_URL}/good`);
    const badSeq = model.beginNodeLoad(`${ROOT_URL}/bad`) as number;
    model.beginNodeLoad(`${ROOT_URL}/good`);
    model.failNode(`${ROOT_URL}/bad`, badSeq, notFound);
    const badDir = model.nodeByKey(`${ROOT_URL}/bad`)?.dir;
    const goodDir = model.nodeByKey(`${ROOT_URL}/good`)?.dir;
    expect(badDir?.phase).toBe('error');
    expect(badDir?.error?.kind).toBe('notFound');
    expect(goodDir?.phase).toBe('loading');
    expect(rootDir(model).phase).toBe('ready');
    // 行内重试入口。
    const badRow = model.buildTreeRows()[0].children?.find((row) => row.label === 'bad');
    expect(badRow?.phase).toBe('error');
    expect(badRow?.actions?.map((action) => action.id)).toContain('retryBrowserNode');
    // 重试原路径：与该节点同一 key 重新排队。
    const retry = model.reloadNode(`${ROOT_URL}/bad`);
    expect(retry.kind).toBe('node');
    expect(model.takeLoadRequests()).toEqual([`${ROOT_URL}/bad`]);
    expect(model.nodeByKey(`${ROOT_URL}/bad`)?.dir?.phase).toBe('idle');
  });

  it('tooLarge 是显式终态：不保留部分条目、行内重试、banner 提示', () => {
    const model = openDir();
    const requestSeq = model.beginNodeLoad(ROOT_URL) as number;
    expect(model.completeNodeTooLarge(ROOT_URL, requestSeq, { reason: 'entries', limit: 100_000 })).toBe(true);
    const dir = rootDir(model);
    expect(dir.phase).toBe('error');
    expect(dir.entries).toEqual([]);
    expect(dir.total).toBe(0);
    expect(dir.error?.kind).toBe('tooLarge');
    const state = model.buildPanelState('s1');
    const banner = state.banners.find((candidate) => candidate.id === 'browseTooLargeNode');
    expect(banner?.level).toBe('warn');
    expect(banner?.title).toContain('目录超出当前完整读取上限');
    expect(state.lazyTree?.rows[0].phase).toBe('error');
    // 关闭 tooLarge 提示。
    expect(model.dismissNotice('browseTooLargeNode')).toBe(false);
    model.clearLimitNotice();
    expect(model.buildPanelState('s1').banners.some((candidate) => candidate.id === 'browseTooLargeNode')).toBe(false);
  });

  it('取消导致的 failNode 回到 idle（不展示错误）', () => {
    const model = openDir();
    const requestSeq = model.beginNodeLoad(ROOT_URL) as number;
    expect(model.failNode(ROOT_URL, requestSeq, { kind: 'cancelled', message: 'cancelled', codes: [] })).toBe(true);
    const dir = rootDir(model);
    expect(dir.phase).toBe('idle');
    expect(dir.error).toBeUndefined();
  });
});

/* ------------------------------ 会话恢复 ------------------------------ */

describe('关闭重开恢复（可浏览状态）', () => {
  it('browsableState 保存浏览 revision、展开相对路径与选中路径', () => {
    const model = openDir();
    loadRootAsXml(model, [{ name: 'docs', kind: 'dir' }, { name: 'a.txt' }]);
    model.buildTreeRows();
    model.toggleNode(`${ROOT_URL}/docs`);
    model.selectNode(`${ROOT_URL}/a.txt`);
    const browsable = model.browsableState();
    expect(browsable).toEqual({
      entryUrl: ROOT_URL,
      snapshotRevision: 42,
      expandedPaths: ['docs'],
      selectedPath: 'a.txt',
    });
  });

  it('beginOpen(restore) 后按旧 revision 打开并逐层恢复展开链（含可见片之外的条目）', () => {
    const model = new BrowseModel({ threshold: 2, firstBatch: 2 });
    model.beginOpen(ROOT_URL, {
      entryUrl: ROOT_URL,
      snapshotRevision: 41,
      expandedPaths: ['docs/deep'],
      selectedPath: 'a.txt',
    });
    expect(model.restoreRevision).toBe(41);
    model.applyRootInfo(rootRef({ snapshotRevision: 41 }));
    // 根读取：docs 在首批可见片之外（索引 2），恢复需扩大可见片。
    const requestSeq = model.beginNodeLoad(ROOT_URL) as number;
    model.completeNodeNames(ROOT_URL, requestSeq, namesOf([
      { name: 'a.txt' },
      { name: 'b.txt' },
      { name: 'docs', kind: 'dir' },
    ]));
    // 恢复“选中 a.txt”的详情 info（名称模式元数据缺失）。
    const progress = model.advanceRestore();
    expect(progress.detail?.nodeKey).toBe(`${ROOT_URL}/a.txt`);
    expect(rootDir(model).visible).toBe(3);
    // 展开 docs：排队读取。
    expect(model.takeLoadRequests()).toEqual([`${ROOT_URL}/docs`]);
    loadNodeAsXml(model, `${ROOT_URL}/docs`, [{ name: 'deep', kind: 'dir' }]);
    const progress2 = model.advanceRestore();
    expect(progress2.detail).toBeUndefined();
    expect(model.takeLoadRequests()).toEqual([`${ROOT_URL}/docs/deep`]);
    expect(model.nodeByKey(`${ROOT_URL}/docs`)?.expanded).toBe(true);
  });

  it('入口在恢复 revision 不存在时由控制器回落 HEAD（模型只记录新 revision）', () => {
    const model = new BrowseModel();
    model.beginOpen(ROOT_URL, { entryUrl: ROOT_URL, snapshotRevision: 30, expandedPaths: [] });
    expect(model.restoreRevision).toBe(30);
    model.applyRootInfo(rootRef({ snapshotRevision: 42 }));
    expect(model.snapshotRevisionValue).toBe(42);
  });
});

/* ------------------------------ 面板状态 ------------------------------ */

describe('buildPanelState', () => {
  it('树/布局/详情/徽标/刷新入口与只读提示', () => {
    const model = openDir();
    loadRootAsXml(model, listingOf([{ name: 'dir', kind: 'dir' }, { name: 'a.txt' }]));
    model.buildTreeRows();
    model.selectNode(`${ROOT_URL}/dir`);
    const state = model.buildPanelState('session-1');
    expect(state.sessionId).toBe('session-1');
    expect(state.busy).toBe(false);
    expect(state.layout).toMatchObject({
      layout: 'master-detail',
      masterScrollKey: 'browse-tree',
      detailScrollKey: 'browse-detail',
    });
    expect(state.lazyTree?.id).toBe('browse');
    expect(state.lazyTree?.rows[0].label).toBe('trunk');
    expect(state.lazyTree?.rows[0].children?.length).toBe(2);
    expect(state.headerBadges).toEqual([{ text: '浏览 revision r42' }]);
    expect(state.footer?.primary?.id).toBe('refresh');
    expect(state.detail?.title).toBe('dir');
    const actions = state.detail?.sections.find((section) => section.kind === 'actions');
    expect(actions?.kind).toBe('actions');
    if (actions?.kind === 'actions') {
      expect(actions.actions.map((action) => action.id)).toEqual([
        'copyBrowserNodeUrl',
        'openHistoryFromBrowser',
      ]);
      expect(actions.actions[0].payload?.['node-id']).toBeDefined();
    }
    expect(state.hint).toContain('只读浏览远端仓库');
  });

  it('文件详情动作包含打开远端文件；目录不包含', () => {
    const model = openDir();
    loadRootAsXml(model, listingOf([{ name: 'a.txt' }]));
    model.buildTreeRows();
    model.selectNode(`${ROOT_URL}/a.txt`);
    const state = model.buildPanelState('s1');
    const actions = state.detail?.sections.find((section) => section.kind === 'actions');
    if (actions?.kind === 'actions') {
      expect(actions.actions.map((action) => action.id)).toContain('openRemoteNode');
    }
    model.selectNode(ROOT_URL);
    const rootState = model.buildPanelState('s1');
    const rootActions = rootState.detail?.sections.find((section) => section.kind === 'actions');
    if (rootActions?.kind === 'actions') {
      expect(rootActions.actions.map((action) => action.id)).not.toContain('openRemoteNode');
    }
  });

  it('无选中节点时详情为空态提示，不伪造业务内容', () => {
    const model = openDir();
    loadRootAsXml(model, listingOf([{ name: 'a.txt' }]));
    expect(model.buildPanelState('s1').detail?.title).toBe('选择左侧节点查看详情。');
  });

  it('控制器提示（认证取消等）进入 banner 并可关闭', () => {
    const model = openDir();
    const id = model.pushNotice('error', browseText('authCancelledMessage'));
    expect(model.buildPanelState('s1').banners.some((banner) => banner.id === id)).toBe(true);
    expect(model.dismissNotice(id)).toBe(true);
    expect(model.buildPanelState('s1').banners.some((banner) => banner.id === id)).toBe(false);
    expect(model.dismissNotice('missing')).toBe(false);
  });
});

/* ------------------------------ 视图行扩展字段 ------------------------------ */

describe('视图行扩展字段（LazyTreeRowSpec，宿主生成展示文本）', () => {
  it('节点行带 kindLabel/nodeUrl/repoPath/lastChanged；文件行带大小 metaText', () => {
    const model = openDir();
    loadRootAsXml(model, [{ name: 'a.txt' }, { name: 'docs', kind: 'dir' }]);
    const rows = model.buildTreeRows()[0].children ?? [];
    const fileRow = rows.find((row) => row.label === 'a.txt');
    expect(fileRow).toBeDefined();
    expect(fileRow?.kindLabel).toBe('文件');
    expect(fileRow?.nodeUrl).toBe(`${ROOT_URL}/a.txt`);
    expect(fileRow?.repoPath).toBe('^/trunk/a.txt');
    expect(fileRow?.lastChanged).toEqual({
      revision: 'r10',
      author: 'bob',
      date: '2026-11-01T09:00:00Z',
    });
    expect(fileRow?.metaText).toBe('12 B');
    // 目录行不把子项大小汇总成自身 metaText（目录详情不汇总子项）。
    const dirRow = rows.find((row) => row.label === 'docs');
    expect(dirRow?.kindLabel).toBe('目录');
    expect(dirRow?.metaText).toBeUndefined();
  });

  it('空目录行带 emptyText（ready + total=0，不是错误）', () => {
    const model = openDir();
    loadRootAsXml(model, []);
    const row = model.buildTreeRows()[0];
    expect(row.emptyText).toBe('空目录');
    expect(row.phase).toBe('ready');
    expect(row.tooLarge).toBeUndefined();
  });

  it('tooLarge 行带 tooLarge 与说明（不保留部分条目）', () => {
    const model = openDir();
    const requestSeq = model.beginNodeLoad(ROOT_URL) as number;
    expect(model.completeNodeTooLarge(ROOT_URL, requestSeq, { reason: 'entries', limit: 100_000 })).toBe(true);
    const row = model.buildTreeRows()[0];
    expect(row.phase).toBe('error');
    expect(row.tooLarge).toBe(true);
    expect(row.statusText).toBe('目录超出当前完整读取上限');
  });

  it('名称模式补全中的目录行带 metadataCancelAction（复用 refreshBrowserNode 承载取消）', () => {
    const model = openDir({ threshold: 1, firstBatch: 2 });
    const requestSeq = model.beginNodeLoad(ROOT_URL) as number;
    expect(model.completeNodeNames(ROOT_URL, requestSeq, namesRange(10))).toBe('done');
    const row = model.buildTreeRows()[0];
    expect(row.metadata).toBe('pending');
    expect(row.metadataCancelAction).toEqual({
      id: 'refreshBrowserNode',
      label: '取消元数据补全',
    });
    // 补全中的行不再并列通用刷新动作（同一意图承载取消语义）。
    expect(row.actions?.some((action) => action.id === 'refreshBrowserNode')).toBeFalsy();
    // 取消后行保留「已取消」状态，不再提供取消按钮；刷新入口恢复。
    model.cancelMetadata();
    const cancelled = model.buildTreeRows()[0];
    expect(cancelled.metadata).toBe('cancelled');
    expect(cancelled.metadataCancelAction).toBeUndefined();
    expect(cancelled.actions?.some((action) => action.id === 'refreshBrowserNode')).toBe(true);
  });
});

/* ------------------------------ 文案与格式化 ------------------------------ */

describe('文案与格式化', () => {
  it('browseText 输出 i18n.browsePanel 文案并填充占位（缺失键回落默认中文）', () => {
    expect(browseText('panelTitle')).toBe('仓库浏览');
    expect(browseText('snapshotBadge', { revision: '7' })).toBe('浏览 revision r7');
    expect(browseText('copyUrlDone', { url: 'https://h/repo' })).toBe('已复制原始 URL：https://h/repo');
  });

  it('阈值与首批常量符合定案（5,000 / 40）', () => {
    expect(BROWSE_METADATA_THRESHOLD).toBe(5000);
    expect(BROWSE_FIRST_BATCH).toBe(40);
  });

  it('formatBytes 输出可读大小', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(321)).toBe('321 B');
    expect(formatBytes(2048)).toBe('2.0 KiB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MiB');
  });
});
