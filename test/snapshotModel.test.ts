/**
 * P6 快照比较模型 / 导出 / BASE 比较 / P6→P3 交接契约测试（M4 阶段 3
 * 任务 4/5/6）：
 * - 纯模型：左右按 revision 数值定向、候选全量留宿主且每页最多 100、
 *   筛选/翻页只重算宿主切片（不触发任何网络）、选中清理、状态派生
 *   （新增/删除/修改/属性/二进制/无差异）、表格切片与意图载荷；
 * - 真实本地 SVN（svnadmin + file://）：复制文件/目录与子文件继承的
 *   实际节点解析（复制前来源 URL）、删除 revision 的 absent 候选与
 *   deletionRevision-1 导出、目录单端不存在枚举另一端、summarize 右根
 *   重拼不依赖输出 URL、单文件导出（含目标字面 @ 的 peg 转义与原子覆盖）、
 *   目录 BASE 比较的 status 实际变化；
 * - 交接契约：文件目标/非法 revision/空或非法 URL 在宿主入口拒绝，
 *   URL 经 normalizeCheckoutUrl 归一。
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseLogXml,
  type HistoryEntry,
  type HistoryTarget,
} from '../src/core/history';
import type { SnapshotCompareResult, SnapshotDiffCandidate, SnapshotNodeState } from '../src/core/snapshot';
import { run, urlWithPeg } from '../src/core/svnCli';
import {
  SNAPSHOT_CANDIDATE_PAGE_SIZE,
  applySnapshotCandidateProbes,
  applySnapshotCompareResult,
  applySnapshotCompareTooLarge,
  buildSnapshotCandidateTable,
  checkoutHandoffEntryKey,
  createSnapshotCompareState,
  decodeSnapshotRelativePath,
  deriveSnapshotCandidateStatus,
  loadSnapshotCompare,
  planSnapshotBaseCompare,
  planSnapshotExport,
  resolveSnapshotCompareEndpoints,
  runSnapshotCompare,
  selectSnapshotCandidate,
  selectedSnapshotCandidate,
  setSnapshotCompareFilter,
  setSnapshotComparePage,
  snapshotCandidatePage,
  snapshotCompareSummary,
  snapshotPrecedingRevisions,
  validateCheckoutHistoryHandoff,
  writeSnapshotExport,
} from '../src/host/panel/snapshotModel';
import { createSvnLab, writeFile, type SvnLab } from './helpers';

let hasSvn = false;
try {
  execSync('svn --version', { stdio: 'ignore' });
  hasSvn = true;
} catch {
  hasSvn = false;
}

/* ------------------------------ 纯模型 ------------------------------ */

const presentNode = (url: string, revision: number, kind: 'file' | 'dir' = 'file'): SnapshotNodeState => ({
  state: 'present',
  node: {
    repositoryUuid: 'uuid-1',
    repositoryRootUrl: 'file:///repo',
    rawUrl: url,
    relativePath: 'trunk/a.txt',
    snapshotRevision: revision,
    lastChangedRevision: revision,
    kind,
  },
});

const TARGET: HistoryTarget = {
  url: 'file:///repo/trunk/a.txt',
  repositoryRootUrl: 'file:///repo',
  relativePath: 'trunk/a.txt',
  kind: 'file',
};

function makeCandidate(index: number, patch: Partial<SnapshotDiffCandidate> = {}): SnapshotDiffCandidate {
  return {
    relativePath: `f${index}.txt`,
    item: 'modified',
    props: 'none',
    kind: 'file',
    leftPresent: true,
    rightPresent: true,
    leftUrl: `file:///repo/trunk/f${index}.txt`,
    rightUrl: `file:///repo/trunk/f${index}.txt`,
    leftRevision: 1,
    rightRevision: 2,
    ...patch,
  };
}

function readyResult(candidates: SnapshotDiffCandidate[]): Extract<SnapshotCompareResult, { state: 'ready' }> {
  return {
    state: 'ready',
    left: presentNode('file:///repo/trunk/a.txt', 1),
    right: presentNode('file:///repo/trunk/a.txt', 2),
    source: 'summarize',
    candidates,
  };
}

describe('快照比较模型：方向、切片与状态', () => {
  it('左右按 revision 数值定向：勾选顺序无影响', () => {
    const a = createSnapshotCompareState(TARGET, 9, 2);
    expect(a.leftRevision).toBe(2);
    expect(a.rightRevision).toBe(9);
    const b = createSnapshotCompareState(TARGET, 2, 9);
    expect(b.leftRevision).toBe(2);
    expect(b.rightRevision).toBe(9);
  });

  it('候选全量留宿主，每页最多 100；翻页只改切片不重算候选', () => {
    const candidates = Array.from({ length: 250 }, (_value, index) => makeCandidate(index));
    const state = applySnapshotCompareResult(createSnapshotCompareState(TARGET, 1, 2), readyResult(candidates));
    expect(state.candidates).toHaveLength(250);
    expect(snapshotCandidatePage(state).candidates).toHaveLength(SNAPSHOT_CANDIDATE_PAGE_SIZE);
    expect(snapshotCandidatePage(state).pageCount).toBe(3);

    const page2 = setSnapshotComparePage(state, 2);
    expect(page2.candidates).toBe(state.candidates);
    expect(snapshotCandidatePage(page2).candidates[0].id).toBe('c100');
    const page3 = setSnapshotComparePage(page2, 3);
    expect(snapshotCandidatePage(page3).candidates).toHaveLength(50);
    // clamp：越界页不产生空页。
    expect(setSnapshotComparePage(page3, 99).page).toBe(3);
    expect(setSnapshotComparePage(page3, 0).page).toBe(1);
  });

  it('筛选只重算宿主切片（候选数组引用不变），页码回 1，选中被筛掉即清空', () => {
    const candidates = [
      makeCandidate(1, { relativePath: 'src/a%20b.txt' }),
      makeCandidate(2, { relativePath: 'docs/readme.md' }),
      makeCandidate(3, { relativePath: 'src/c.txt' }),
    ];
    let state = applySnapshotCompareResult(createSnapshotCompareState(TARGET, 1, 2), readyResult(candidates));
    state = selectSnapshotCandidate(state, 'c2');
    expect(selectedSnapshotCandidate(state)?.id).toBe('c2');

    const filtered = setSnapshotCompareFilter(state, 'SRC');
    expect(filtered.candidates).toBe(state.candidates);
    expect(filtered.filteredIndexes).toEqual([0, 2]);
    expect(filtered.page).toBe(1);
    expect(filtered.selectedId).toBe('c2');

    const noMatch = setSnapshotCompareFilter(state, '不存在');
    expect(noMatch.filteredIndexes).toEqual([]);
    expect(noMatch.selectedId).toBeNull();

    // 解码展示路径：空格恢复为原文。
    expect(decodeSnapshotRelativePath('src/a%20b.txt')).toBe('src/a b.txt');
  });

  it('选中候选：未知 ID 忽略；表格行只携带选中态与稳定 ID', () => {
    let state = applySnapshotCompareResult(
      createSnapshotCompareState(TARGET, 1, 2),
      readyResult([makeCandidate(1), makeCandidate(2)]),
    );
    expect(selectSnapshotCandidate(state, 'c99')).toBe(state);
    state = selectSnapshotCandidate(state, 'c1');
    const table = buildSnapshotCandidateTable(state);
    expect(table.id).toBe('snapshotCandidates');
    expect(table.rowSelectIntent).toBe('selectCompareCandidate');
    expect(table.rows.map((row) => row.id)).toEqual(['c0', 'c1']);
    expect(table.rows[1].selected).toBe(true);
    expect(table.pagination).toMatchObject({ page: 1, pageSize: 100, total: 2, pageCount: 1 });
  });

  it('状态派生：新增/删除/修改/属性/无差异/二进制，二进制不开放文本差异', () => {
    expect(deriveSnapshotCandidateStatus({ item: 'added', props: 'none' })).toBe('added');
    expect(deriveSnapshotCandidateStatus({ item: 'deleted', props: 'none' })).toBe('deleted');
    expect(deriveSnapshotCandidateStatus({ item: 'modified', props: 'none' })).toBe('modified');
    expect(deriveSnapshotCandidateStatus({ item: 'none', props: 'modified' })).toBe('property');
    expect(deriveSnapshotCandidateStatus({ item: 'modified', props: 'none', contentKind: 'binary' })).toBe('binary');
    // 内容相同、仅属性变化 → property（不伪造文本差异）。
    expect(deriveSnapshotCandidateStatus({
      item: 'modified', props: 'modified', contentKind: 'text', contentsEqual: true,
    })).toBe('property');
    expect(deriveSnapshotCandidateStatus({ item: 'modified', props: 'none', contentKind: 'text' })).toBe('modified');

    let state = applySnapshotCompareResult(
      createSnapshotCompareState(TARGET, 1, 2),
      readyResult([makeCandidate(0), makeCandidate(1, { item: 'added' })]),
    );
    expect(state.candidates[0].canOpenTextDiff).toBe(true);
    state = applySnapshotCandidateProbes(state, new Map([['c0', { contentKind: 'binary' }]]));
    expect(state.candidates[0].status).toBe('binary');
    expect(state.candidates[0].canOpenTextDiff).toBe(false);
    expect(state.candidates[0].canExport).toBe(true);
    expect(snapshotCompareSummary(state)).toMatchObject({ binary: 1, added: 1 });
  });

  it('预算超限：不展示部分候选冒充完整差异', () => {
    const state = applySnapshotCompareTooLarge(createSnapshotCompareState(TARGET, 1, 2), {
      state: 'tooLarge',
      limit: 'entries',
      left: presentNode('file:///repo/trunk', 1, 'dir'),
      right: presentNode('file:///repo/trunk', 2, 'dir'),
      source: 'summarize',
    });
    expect(state.phase).toBe('tooLarge');
    expect(state.candidates).toEqual([]);
    expect(state.tooLargeLimit).toBe('entries');
  });

  it('preceding 回退候选：已加载历史中早于删除提交的 revision 降序（上限 8）', () => {
    const entries: HistoryEntry[] = [5, 3, 9, 1, 7, 2].map((revision) => ({ revision, message: '', paths: [] }));
    expect(snapshotPrecedingRevisions(entries, 6)).toEqual([5, 3, 2, 1]);
    expect(snapshotPrecedingRevisions(entries, 100)).toEqual([9, 7, 5, 3, 2, 1]);
  });
});

describe('P6→P3 交接契约校验', () => {
  it('文件目标直接拒绝；目录 URL 经 normalizeCheckoutUrl 归一', () => {
    const fileCheck = validateCheckoutHistoryHandoff({
      sourceUrl: 'file:///repo/trunk/dirC',
      pinnedRevision: 5,
      nodeKind: 'file',
    });
    expect(fileCheck.ok).toBe(false);
    if (!fileCheck.ok) {
      expect(fileCheck.reason).toBe('file-target');
    }

    const ok = validateCheckoutHistoryHandoff({
      sourceUrl: 'file:///repo/trunk/dirC',
      pinnedRevision: 5,
      nodeKind: 'dir',
    });
    expect(ok).toEqual({
      ok: true,
      handoff: {
        source: 'history',
        sourceUrl: 'file:///repo/trunk/dirC',
        pinnedRevision: 5,
        nodeKind: 'dir',
      },
    });
    if (ok.ok) {
      expect(checkoutHandoffEntryKey(ok.handoff)).toBe('history:file:///repo/trunk/dirC');
    }
  });

  it('非法 revision / 空 URL / 非法 URL 各自拒绝', () => {
    expect(validateCheckoutHistoryHandoff({
      sourceUrl: 'file:///repo/trunk', pinnedRevision: 0, nodeKind: 'dir',
    })).toMatchObject({ ok: false, reason: 'invalid-revision' });
    expect(validateCheckoutHistoryHandoff({
      sourceUrl: '  ', pinnedRevision: 3, nodeKind: 'dir',
    })).toMatchObject({ ok: false, reason: 'empty-url' });
    expect(validateCheckoutHistoryHandoff({
      sourceUrl: 'file:///repo/trunk?x=1', pinnedRevision: 3, nodeKind: 'dir',
    })).toMatchObject({ ok: false, reason: 'invalid-url' });
  });
});

/* ------------------------------ 真实 SVN ------------------------------ */

function historyTarget(repoUrl: string, path: string, kind: 'file' | 'dir'): HistoryTarget {
  return {
    url: `${repoUrl}${path}`,
    repositoryRootUrl: repoUrl,
    relativePath: path.replace(/^\//, ''),
    kind,
  };
}

async function loadLogEntries(url: string, upper: number): Promise<HistoryEntry[]> {
  const result = await run('svn', [
    'log', '--xml', '-v', '--non-interactive',
    '-l', '1000', '-r', `${upper}:1`, '--', urlWithPeg(url, upper),
  ]);
  expect(result.exitCode).toBe(0);
  return parseLogXml(result.stdout);
}

let lab: SvnLab | undefined;

afterEach(() => {
  lab?.cleanup();
  lab = undefined;
});

describe.skipIf(!hasSvn)('真实 SVN：复制文件/目录的实际节点解析与比较', () => {
  function buildCopyRepo(): SvnLab {
    const local = createSvnLab('svn-anywhere-snapshot-model-');
    // copy 仓库（svnmucc 形态）：r1 dirA；r2 改 file1；r3 cp dirA→dirB
    // （copyfrom-rev=2）；r4 改 dirB/file1；r5 cp dirB→dirC（copyfrom-rev=4）；
    // r6 改 dirC/file1。
    const work = mkdtempSync(join(tmpdir(), 'svn-anywhere-snapshot-model-src-'));
    try {
      writeFileSync(join(work, 'file1.txt'), 'one\n');
      writeFileSync(join(work, 'keep.txt'), 'keep\n');
      execSync(`svnmucc --non-interactive -m r1 mkdir ${local.repoUrl}/trunk mkdir ${local.repoUrl}/trunk/dirA put ${join(work, 'file1.txt')} ${local.repoUrl}/trunk/dirA/file1.txt put ${join(work, 'keep.txt')} ${local.repoUrl}/trunk/dirA/keep.txt`);
      writeFileSync(join(work, 'file1.txt'), 'one\ntwo\n');
      execSync(`svnmucc --non-interactive -m r2 put ${join(work, 'file1.txt')} ${local.repoUrl}/trunk/dirA/file1.txt`);
      execSync(`svnmucc --non-interactive -m r3 cp HEAD ${local.repoUrl}/trunk/dirA ${local.repoUrl}/trunk/dirB`);
      writeFileSync(join(work, 'file1.txt'), 'one\ntwo\nthree\n');
      execSync(`svnmucc --non-interactive -m r4 put ${join(work, 'file1.txt')} ${local.repoUrl}/trunk/dirB/file1.txt`);
      execSync(`svnmucc --non-interactive -m r5 cp HEAD ${local.repoUrl}/trunk/dirB ${local.repoUrl}/trunk/dirC`);
      writeFileSync(join(work, 'file1.txt'), 'one\ntwo\nthree\nfour\n');
      execSync(`svnmucc --non-interactive -m r6 put ${join(work, 'file1.txt')} ${local.repoUrl}/trunk/dirC/file1.txt`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    return local;
  }

  it('文件目标：r1 解析到复制前来源 dirB/file1@4，比较给出 modified 与左右实际 URL', async () => {
    lab = buildCopyRepo();
    const target = historyTarget(lab.repoUrl, '/trunk/dirC/file1.txt', 'file');
    const entries = await loadLogEntries(target.url, 6);
    const resolved = await resolveSnapshotCompareEndpoints('svn', {
      target, firstRevision: 6, secondRevision: 1, entries,
    });
    expect(resolved.leftRevision).toBe(1);
    expect(resolved.rightRevision).toBe(6);
    expect(resolved.left.state).toBe('present');
    if (resolved.left.state === 'present') {
      expect(resolved.left.node.rawUrl).toContain('/trunk/dirB/file1.txt');
      expect(resolved.left.node.snapshotRevision).toBe(4);
    }
    expect(resolved.right.state).toBe('present');
    if (resolved.right.state === 'present') {
      expect(resolved.right.node.rawUrl).toContain('/trunk/dirC/file1.txt');
      expect(resolved.right.node.snapshotRevision).toBe(6);
    }

    const { result } = await runSnapshotCompare('svn', {
      target, firstRevision: 6, secondRevision: 1, entries,
    });
    expect(result.state).toBe('ready');
    if (result.state === 'ready') {
      expect(result.candidates).toHaveLength(1);
      const candidate = result.candidates[0];
      expect(candidate).toMatchObject({ item: 'modified', props: 'none', kind: 'file' });
      expect(candidate.leftUrl).toContain('/trunk/dirB/file1.txt');
      expect(candidate.rightUrl).toContain('/trunk/dirC/file1.txt');
    }
  });

  it('目录目标：两端实际根比较，相对路径从 --old 根剥离后拼右根，子文件继承目录复制', async () => {
    lab = buildCopyRepo();
    const target = historyTarget(lab.repoUrl, '/trunk/dirC', 'dir');
    const entries = await loadLogEntries(target.url, 6);
    const { result } = await runSnapshotCompare('svn', {
      target, firstRevision: 1, secondRevision: 6, entries,
    });
    expect(result.state).toBe('ready');
    if (result.state !== 'ready') {
      return;
    }
    expect(result.source).toBe('summarize');
    const fileCandidate = result.candidates.find((candidate) => candidate.relativePath === 'file1.txt');
    expect(fileCandidate).toBeDefined();
    // 右端 URL 必须按旧根相对路径拼到右根，而不是 summarize 输出 URL（旧根）。
    expect(fileCandidate?.leftUrl).toContain('/trunk/dirB/file1.txt');
    expect(fileCandidate?.rightUrl).toContain('/trunk/dirC/file1.txt');
    // 未修改的 keep.txt 不产生候选（两端实际快照差异，非提交路径并集）。
    expect(result.candidates.some((candidate) => candidate.relativePath === 'keep.txt')).toBe(false);
  });

  it('目录单端不存在：枚举存在端生成整树候选（source=list-left）', async () => {
    lab = createSvnLab('svn-anywhere-snapshot-del-');
    const wc = lab.checkout('wc');
    writeFile(wc, 'trunk/sub/file.txt', 'v1\n', true);
    lab.svn(['commit', '-q', '-m', 'r1'], wc);
    writeFileSync(join(wc, 'trunk', 'sub', 'file.txt'), 'v2\n');
    lab.svn(['commit', '-q', '-m', 'r2'], wc);
    lab.svn(['update', '-q'], wc);
    lab.svn(['delete', '-q', '--', 'trunk/sub'], wc);
    lab.svn(['commit', '-q', '-m', 'r3 delete sub'], wc);

    const target = historyTarget(lab.repoUrl, '/trunk/sub', 'dir');
    const entries = await loadLogEntries(lab.repoUrl, 3);
    expect(entries.some((entry) => entry.revision === 3)).toBe(true);
    const { result } = await runSnapshotCompare('svn', {
      target, firstRevision: 1, secondRevision: 3, entries,
    });
    expect(result.state).toBe('ready');
    if (result.state !== 'ready') {
      return;
    }
    expect(result.source).toBe('list-left');
    expect(result.candidates.map((candidate) => candidate.relativePath)).toEqual(['file.txt']);
    expect(result.candidates[0]).toMatchObject({ item: 'deleted', leftPresent: true, rightPresent: false });
    expect(result.candidates[0].rightUrl).toBeUndefined();
  });

  it('文件删除 revision：生成 deleted 候选与空右端；导出计划用 deletionRevision-1 的实际节点', async () => {
    lab = createSvnLab('svn-anywhere-snapshot-del-file-');
    const wc = lab.checkout('wc');
    writeFile(wc, 'trunk/sub/file.txt', 'v1\n', true);
    lab.svn(['commit', '-q', '-m', 'r1'], wc);
    writeFileSync(join(wc, 'trunk', 'sub', 'file.txt'), 'v2\n');
    lab.svn(['commit', '-q', '-m', 'r2'], wc);
    lab.svn(['update', '-q'], wc);
    lab.svn(['delete', '-q', '--', 'trunk/sub'], wc);
    lab.svn(['commit', '-q', '-m', 'r3 delete sub'], wc);

    const target = historyTarget(lab.repoUrl, '/trunk/sub/file.txt', 'file');
    const entries = await loadLogEntries(lab.repoUrl, 3);
    const { result } = await runSnapshotCompare('svn', {
      target, firstRevision: 1, secondRevision: 3, entries, secondDeletionRevision: 3,
    });
    expect(result.state).toBe('ready');
    if (result.state !== 'ready') {
      return;
    }
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ item: 'deleted', leftPresent: true, rightPresent: false });
    expect(result.candidates[0].leftUrl).toContain('/trunk/sub/file.txt');

    const plan = await planSnapshotExport('svn', {
      target, revision: 3, entries, deletionRevision: 3,
    });
    expect(plan).toMatchObject({ status: 'preceding', revision: 2, requestedRevision: 2, viaHistoryFallback: false });
    if (plan.status === 'preceding') {
      expect(plan.url).toContain('/trunk/sub/file.txt');
    }

    const write = await writeSnapshotExport('svn', {
      url: plan.status === 'preceding' ? plan.url : '',
      revision: plan.status === 'preceding' ? plan.revision : 0,
      targetPath: join(wc, 'exported-file.txt'),
    });
    expect(write.status).toBe('exported');
    expect(readFileSync(join(wc, 'exported-file.txt'), 'utf8')).toBe('v2\n');

    // 目录的删除前版本导出仍归 M6：文件导出入口显式拒绝。
    const dirTarget = historyTarget(lab.repoUrl, '/trunk/sub', 'dir');
    const dirPlan = await planSnapshotExport('svn', {
      target: dirTarget, revision: 3, entries, deletionRevision: 3,
    });
    expect(dirPlan.status).toBe('directoryNotSupported');
  });

  it('导出：当前 revision 实际节点、目标含字面 @ 的 peg 转义、覆盖需显式确认', async () => {
    lab = createSvnLab('svn-anywhere-snapshot-export-');
    const wc = lab.checkout('wc');
    writeFile(wc, 'trunk/file@1.txt', 'v1\n', true);
    lab.svn(['commit', '-q', '-m', 'r1'], wc);
    writeFileSync(join(wc, 'trunk', 'file@1.txt'), 'v2\n');
    lab.svn(['commit', '-q', '-m', 'r2'], wc);

    const target = historyTarget(lab.repoUrl, '/trunk/file@1.txt', 'file');
    const entries = await loadLogEntries(lab.repoUrl, 2);
    const plan = await planSnapshotExport('svn', { target, revision: 2, entries });
    expect(plan).toMatchObject({ status: 'present', revision: 2 });
    if (plan.status !== 'present') {
      return;
    }
    const outDir = mkdtempSync(join(tmpdir(), 'svn-anywhere-snapshot-out-'));
    try {
      // 目标路径含字面 @：writeSnapshotExport 内部对本地目标做尾 @ 转义。
      const outPath = join(outDir, 'file@export.txt');
      const first = await writeSnapshotExport('svn', { url: plan.url, revision: 2, targetPath: outPath });
      expect(first.status).toBe('exported');
      expect(readFileSync(outPath, 'utf8')).toBe('v2\n');

      // 已存在且未确认 → exists（不覆盖）。
      const second = await writeSnapshotExport('svn', { url: plan.url, revision: 2, targetPath: outPath });
      expect(second.status).toBe('exists');
      expect(readFileSync(outPath, 'utf8')).toBe('v2\n');

      // 确认覆盖后才替换（原子替换，无 .part 残留）。
      const third = await writeSnapshotExport('svn', {
        url: plan.url, revision: 2, targetPath: outPath, overwrite: true,
      });
      expect(third.status).toBe('exported');
      expect(readFileSync(outPath, 'utf8')).toBe('v2\n');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }

    const dirTarget = historyTarget(lab.repoUrl, '/trunk', 'dir');
    const dirPlan = await planSnapshotExport('svn', { target: dirTarget, revision: 2, entries });
    expect(dirPlan.status).toBe('directoryNotSupported');
  });

  it('BASE 比较：文件单条、目录列出实际变化、干净目录 unchanged', async () => {
    lab = createSvnLab('svn-anywhere-snapshot-base-');
    const wc = lab.checkout('wc');
    writeFile(wc, 'a.txt', 'base\n', true);
    writeFile(wc, 'clean.txt', 'clean\n', true);
    lab.svn(['commit', '-q', '-m', 'r1'], wc);

    const clean = await planSnapshotBaseCompare('svn', { wcRoot: wc, relPath: '.', kind: 'dir' });
    expect(clean).toEqual({ status: 'unchanged', entries: [] });

    writeFileSync(join(wc, 'a.txt'), 'work\n');
    writeFile(wc, 'new.txt', 'new\n', true);
    const filePlan = await planSnapshotBaseCompare('svn', { wcRoot: wc, relPath: 'a.txt', kind: 'file' });
    expect(filePlan.status).toBe('ready');
    if (filePlan.status === 'ready') {
      expect(filePlan.entries).toHaveLength(1);
      expect(filePlan.entries[0]).toMatchObject({ relPath: 'a.txt', wcStatus: 'modified' });
    }

    const dirPlan = await planSnapshotBaseCompare('svn', { wcRoot: wc, relPath: '.', kind: 'dir' });
    expect(dirPlan.status).toBe('ready');
    if (dirPlan.status === 'ready') {
      const statuses = Object.fromEntries(dirPlan.entries.map((entry) => [entry.relPath, entry.wcStatus]));
      expect(statuses['a.txt']).toBe('modified');
      expect(statuses['new.txt']).toBe('added');
      expect(statuses['clean.txt']).toBeUndefined();
    }
  });
});

describe.skipIf(!hasSvn)('loadSnapshotCompare：状态机与错误分类', () => {
  it('比较成功进入 ready；预算超限以同构小参数验证 tooLarge 状态', async () => {
    lab = createSvnLab('svn-anywhere-snapshot-load-');
    const wc = lab.checkout('wc');
    for (let index = 0; index < 5; index += 1) {
      writeFile(wc, `d/f${index}.txt`, `v${index}\n`, true);
    }
    lab.svn(['commit', '-q', '-m', 'r1'], wc);
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(join(wc, 'd', `f${index}.txt`), `v${index + 1}\n`);
    }
    lab.svn(['commit', '-q', '-m', 'r2'], wc);

    const target = historyTarget(lab.repoUrl, '/d', 'dir');
    const entries = await loadLogEntries(target.url, 2);
    let state = createSnapshotCompareState(target, 1, 2);
    state = await loadSnapshotCompare('svn', state, { entries });
    expect(state.phase).toBe('ready');
    expect(state.candidates.length).toBeGreaterThan(0);

    const limited = await loadSnapshotCompare(
      'svn',
      createSnapshotCompareState(target, 1, 2),
      { entries, budget: { maxEntries: 2 } },
    );
    expect(limited.phase).toBe('tooLarge');
    expect(limited.tooLargeLimit).toBe('entries');
    expect(limited.candidates).toEqual([]);
  });

  it('读取失败进入 error 相位且保留可展示消息', async () => {
    const target = historyTarget('file:///tmp/svn-anywhere-no-such-repo', '/trunk/no-such.txt', 'file');
    const state = await loadSnapshotCompare(
      'svn',
      createSnapshotCompareState(target, 1, 2),
      { entries: [] },
    );
    expect(state.phase).toBe('error');
    expect(state.errorMessage).toBeTruthy();
  });
});
