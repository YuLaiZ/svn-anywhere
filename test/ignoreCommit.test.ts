/**
 * P2 隔离提交 core 原语测试：
 * - 快照读取区分属性不存在（W200017）与存在但为空；BASE/HEAD 读取；
 * - applyIgnoreSnapshot 的 propset -F / propdel；
 * - 组合链路（真实 svnadmin + file://）：限深临时副本提交只入库
 *   svn:ignore，原副本其他属性与子文件修改全程保留，协调后 BASE
 *   读回为已提交值；远端并发（out of date）失败；本地后续修改触发
 *   属性冲突并以保留工作值方式解决。
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyIgnoreSnapshot,
  checkoutDepthEmpty,
  commitTempIgnore,
  coordinateUpdate,
  propertyConflicted,
  readIgnoreSnapshot,
  readRemoteIgnoreSnapshot,
  readRemoteNodeRevisions,
  resolvePropertyConflict,
  snapshotEqual,
  writeRulesTempFile,
} from '../src/core/ignoreCommit';
import { parseNodeIdentity, readNodeIdentity } from '../src/core/nodeIdentity';
import { createSvnLab, writeFile } from './helpers';

const labs: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of labs.splice(0)) {
    cleanup();
  }
});

function makeLab(prefix: string) {
  const lab = createSvnLab(prefix);
  labs.push(() => lab.cleanup());
  return lab;
}

/** 提交目录属性前的基线仓库：src 目录带子文件、svn:ignore 与另一属性。 */
function seedRepo(lab: ReturnType<typeof createSvnLab>) {
  const wc = lab.checkout('wc');
  lab.svn(['mkdir', '-q', 'src'], wc);
  writeFile(wc, 'src/a.txt', 'base\n', true);
  const rules = join(wc, '.svn-rules.tmp');
  writeFileSync(rules, 'old-rule\n');
  lab.svn(['propset', '-q', 'svn:ignore', '-F', rules, 'src'], wc);
  lab.svn(['propset', '-q', 'custom:keep', 'v1', 'src'], wc);
  lab.svn(['commit', '-q', '-m', 'seed'], wc);
  rmSync(rules);
  return wc;
}

describe('parseNodeIdentity', () => {
  it('解析 URL/UUID/根/修订与类型', () => {
    const stdout = [
      'Path: src',
      'URL: file:///tmp/repo/src',
      'Relative URL: ^/src',
      'Repository Root: file:///tmp/repo',
      'Repository UUID: 11111111-2222-3333-4444-555555555555',
      'Revision: 7',
      'Node Kind: directory',
      'Schedule: normal',
    ].join('\n');
    expect(parseNodeIdentity(stdout)).toEqual({
      url: 'file:///tmp/repo/src',
      repositoryUuid: '11111111-2222-3333-4444-555555555555',
      repositoryRootUrl: 'file:///tmp/repo',
      revision: 7,
      kind: 'directory',
    });
  });

  it('缺字段返回 undefined', () => {
    expect(parseNodeIdentity('URL: file:///x\nRevision: 3\n')).toBeUndefined();
  });
});

describe('readIgnoreSnapshot：存在性与空值分开', () => {
  it('未设置属性 → exists=false；设置空值 → exists=true 且规则为空', async () => {
    const lab = makeLab('svn-anywhere-ig-snap-');
    const wc = lab.checkout('wc');
    lab.svn(['mkdir', '-q', 'src'], wc);
    lab.svn(['commit', '-q', '-m', 'mkdir'], wc);
    const absent = await readIgnoreSnapshot('svn', 'src', { cwd: wc });
    expect(absent).toEqual({ rules: [], exists: false });
    lab.svn(['propset', '-q', 'svn:ignore', '', 'src'], wc);
    const empty = await readIgnoreSnapshot('svn', 'src', { cwd: wc });
    expect(empty.exists).toBe(true);
    expect(empty.rules).toEqual([]);
  });

  it('BASE 与远端 HEAD（URL）读取；规则按行原样保留（含首尾空格行）', async () => {
    const lab = makeLab('svn-anywhere-ig-rev-');
    const wc = seedRepo(lab);
    const rules = join(wc, '.svn-rules.tmp');
    writeFileSync(rules, ' spaced \n*.log\n');
    lab.svn(['propset', '-q', 'svn:ignore', '-F', rules, 'src'], wc);
    lab.svn(['commit', '-q', '-m', 'spaced rules', '--depth', 'empty', 'src'], wc);
    rmSync(rules);
    const base = await readIgnoreSnapshot('svn', 'src', { cwd: wc, revision: 'BASE' });
    expect(base).toEqual({ rules: [' spaced ', '*.log'], exists: true });
    const head = await readRemoteIgnoreSnapshot('svn', `${lab.repoUrl}/src`, { cwd: wc });
    expect(head).toEqual(base);
    const revisions = await readRemoteNodeRevisions('svn', `${lab.repoUrl}/src`, { cwd: wc });
    expect(revisions.headRevision).toBeGreaterThanOrEqual(revisions.lastChangedRevision);
    expect(revisions.lastChangedRevision).toBeGreaterThan(0);
  });
});

describe('applyIgnoreSnapshot', () => {
  it('规则清空走 propdel，非空走 propset -F 临时文件', async () => {
    const lab = makeLab('svn-anywhere-ig-apply-');
    const wc = lab.checkout('wc');
    lab.svn(['mkdir', '-q', 'src'], wc);
    lab.svn(['commit', '-q', '-m', 'mkdir'], wc);
    await applyIgnoreSnapshot('svn', 'src', { rules: ['*.tmp', 'build'], exists: true }, { cwd: wc });
    expect(await readIgnoreSnapshot('svn', 'src', { cwd: wc })).toEqual({
      rules: ['*.tmp', 'build'],
      exists: true,
    });
    await applyIgnoreSnapshot('svn', 'src', { rules: [], exists: false }, { cwd: wc });
    expect(await readIgnoreSnapshot('svn', 'src', { cwd: wc })).toEqual({ rules: [], exists: false });
  });

  it('writeRulesTempFile 末尾补换行且清理临时目录', () => {
    const { tempDir, rulesFile } = writeRulesTempFile(['a', 'b']);
    expect(readFileSync(rulesFile, 'utf8')).toBe('a\nb\n');
    rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('隔离提交组合链路（真实 SVN）', () => {
  it('临时副本提交只入库 svn:ignore；协调后原副本其他修改保留', async () => {
    const lab = makeLab('svn-anywhere-ig-commit-');
    const wc = seedRepo(lab);
    // 原副本制造三类本地修改：ignore 新值 + 其他属性修改 + 子文件修改。
    const rules = join(wc, '.svn-rules.tmp');
    writeFileSync(rules, 'new-rule\nextra\n');
    lab.svn(['propset', '-q', 'svn:ignore', '-F', rules, 'src'], wc);
    lab.svn(['propset', '-q', 'custom:keep', 'v2', 'src'], wc);
    rmSync(rules);
    writeFileSync(join(wc, 'src', 'a.txt'), 'local edit\n');

    // 隔离提交：BASE 身份 → 限深检出 → 仅应用 svn:ignore → 提交。
    const identity = await readNodeIdentity('svn', 'src', { cwd: wc });
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-ig-tmp-')));
    try {
      const tempWc = join(tempDir, 'wc');
      await checkoutDepthEmpty('svn', identity.url, identity.revision, tempWc, {});
      const tempBase = await readIgnoreSnapshot('svn', '.', { cwd: tempWc, revision: 'BASE' });
      expect(tempBase).toEqual({ rules: ['old-rule'], exists: true });
      await applyIgnoreSnapshot('svn', '.', { rules: ['new-rule', 'extra'], exists: true }, { cwd: tempWc });
      const messageFile = join(tempDir, 'message.txt');
      writeFileSync(messageFile, '更新忽略规则', 'utf8');
      const revision = await commitTempIgnore('svn', tempWc, messageFile, {});
      expect(revision).toBeGreaterThan(identity.revision);

      // 原副本不受提交影响：两类本地修改原样保留。
      const status = lab.svn(['status'], wc);
      expect(status).toContain('M      src');
      expect(status).toContain('M       src/a.txt');
      // 仓库侧：仅 svn:ignore 变为新值，custom:keep 仍是 v1。
      expect(await readRemoteIgnoreSnapshot('svn', `${lab.repoUrl}/src`, { cwd: wc }))
        .toEqual({ rules: ['new-rule', 'extra'], exists: true });
      expect(lab.svn(['propget', '-r', 'HEAD', 'custom:keep', `${lab.repoUrl}/src`], wc).trim()).toBe('v1');

      // 协调：update --depth empty 后 BASE 读回为已提交值，无冲突。
      await coordinateUpdate('svn', 'src', { cwd: wc });
      expect(await propertyConflicted('svn', 'src', { cwd: wc })).toBe(false);
      expect(await readIgnoreSnapshot('svn', 'src', { cwd: wc, revision: 'BASE' }))
        .toEqual({ rules: ['new-rule', 'extra'], exists: true });
      // 工作值与提交一致；custom:keep=v2 与子文件修改保留。
      expect(await readIgnoreSnapshot('svn', 'src', { cwd: wc }))
        .toEqual({ rules: ['new-rule', 'extra'], exists: true });
      expect(lab.svn(['propget', 'custom:keep', 'src'], wc).trim()).toBe('v2');
      expect(lab.svn(['status'], wc)).toContain('M       src/a.txt');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('远端该节点已前进时临时副本提交报 out of date（不覆盖他人修改）', async () => {
    const lab = makeLab('svn-anywhere-ig-ood-');
    const wc = seedRepo(lab);
    const identity = await readNodeIdentity('svn', 'src', { cwd: wc });
    // 他人基于同一 BASE 提交了新 ignore。
    const other = lab.checkout('other');
    const rules = join(other, '.svn-rules.tmp');
    writeFileSync(rules, 'other-rule\n');
    lab.svn(['propset', '-q', 'svn:ignore', '-F', rules, 'src'], other);
    lab.svn(['commit', '-q', '-m', 'other change', '--depth', 'empty', 'src'], other);
    rmSync(rules);
    // 我们仍基于旧 BASE 做隔离提交。
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-ig-tmp-')));
    try {
      const tempWc = join(tempDir, 'wc');
      await checkoutDepthEmpty('svn', identity.url, identity.revision, tempWc, {});
      await applyIgnoreSnapshot('svn', '.', { rules: ['mine'], exists: true }, { cwd: tempWc });
      const messageFile = join(tempDir, 'message.txt');
      writeFileSync(messageFile, '更新忽略规则', 'utf8');
      await expect(commitTempIgnore('svn', tempWc, messageFile, {})).rejects.toThrow(/out of date|E160028/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('本地后续修改触发属性冲突；resolve --accept working 保留工作值并保住 BASE', async () => {
    const lab = makeLab('svn-anywhere-ig-conflict-');
    const wc = seedRepo(lab);
    // 我们提交新值。
    const identity = await readNodeIdentity('svn', 'src', { cwd: wc });
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-ig-tmp-')));
    try {
      const tempWc = join(tempDir, 'wc');
      await checkoutDepthEmpty('svn', identity.url, identity.revision, tempWc, {});
      await applyIgnoreSnapshot('svn', '.', { rules: ['A-prime'], exists: true }, { cwd: tempWc });
      const messageFile = join(tempDir, 'message.txt');
      writeFileSync(messageFile, '更新忽略规则', 'utf8');
      await commitTempIgnore('svn', tempWc, messageFile, {});
      // 协调前原副本被外部改成 A'+B（后续本地修改）。
      const rules = join(wc, '.svn-rules.tmp');
      writeFileSync(rules, 'A-prime\nB\n');
      lab.svn(['propset', '-q', 'svn:ignore', '-F', rules, 'src'], wc);
      rmSync(rules);
      await coordinateUpdate('svn', 'src', { cwd: wc });
      // update 退出码为 0 但属性冲突（不能只看退出码）。
      expect(await propertyConflicted('svn', 'src', { cwd: wc })).toBe(true);
      // 用户核对后保留工作值：BASE=A'，工作值 A'+B 保留为待提交修改。
      await resolvePropertyConflict('svn', 'src', { cwd: wc });
      expect(await propertyConflicted('svn', 'src', { cwd: wc })).toBe(false);
      expect(await readIgnoreSnapshot('svn', 'src', { cwd: wc, revision: 'BASE' }))
        .toEqual({ rules: ['A-prime'], exists: true });
      expect(await readIgnoreSnapshot('svn', 'src', { cwd: wc }))
        .toEqual({ rules: ['A-prime', 'B'], exists: true });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('snapshotEqual', () => {
  it('存在性与逐行原值都参与比较', () => {
    expect(snapshotEqual({ rules: ['a'], exists: true }, { rules: ['a'], exists: true })).toBe(true);
    expect(snapshotEqual({ rules: [], exists: false }, { rules: [], exists: true })).toBe(false);
    expect(snapshotEqual({ rules: [' a'], exists: true }, { rules: ['a'], exists: true })).toBe(false);
    expect(snapshotEqual({ rules: ['a', 'b'], exists: true }, { rules: ['b', 'a'], exists: true })).toBe(false);
  });
});
