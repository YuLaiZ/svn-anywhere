/**
 * 导入 core 的真实 svn 烟囱（svnadmin + file://，不碰远端服务器）：
 * - 全链路：枚举（中文/空格名、空目录、symlink、ignored 剔除）→ 快照
 *   digest → 说明临时文件 → buildImportArgs 直接可执行 → import 后
 *   verifyImportOutcome 判 committed（changed paths 精确匹配）；
 * - 目标从未创建 → notCommitted（父目录三项一致）；
 * - 导入后删除目标（revision 递增）→ unknown parentRevisionAdvanced；
 * - 源预检（副本内未纳管 E200009 / 副本外 E155007 / 已纳管）与
 *   开始前重检（targetExists / 通过并刷新锚点）；
 * - 临时 HOME 下「解析器标注 = svn 实际入库」同源对照（续行配置）。
 */
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildImportArgs,
  buildImportTargetUrl,
  enumerationToSnapshot,
  enumerateImportSource,
  messageDigest,
  parseParentInfoXml,
  precheckImportSource,
  recheckImportTarget,
  removeMessageTempDir,
  snapshotDigest,
  verifyImportOutcome,
  writeMessageTempFile,
  type ParentIdentitySnapshot,
} from '../src/core/importDir';
import { escapeUrlPeg } from '../src/core/checkout';
import { readSvnConfigGlobalIgnores } from '../src/core/svnConfig';
import { runOrThrow } from '../src/core/svnCli';
import { createSvnLab, type SvnLab } from './helpers';

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

const labs: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of labs.splice(0)) {
    cleanup();
  }
});

function makeLab(prefix: string): SvnLab {
  const lab = createSvnLab(prefix);
  labs.push(() => lab.cleanup());
  return lab;
}

/** 建 trunk 父目录（r1）并返回父 URL。 */
function seedParent(lab: SvnLab): string {
  const parentUrl = `${lab.repoUrl}/trunk`;
  lab.svn(['mkdir', '-q', '-m', 'trunk', parentUrl]);
  return parentUrl;
}

/** 读取父目录身份快照（连接检查初读的等价物）。 */
async function readParentIdentity(parentUrl: string): Promise<ParentIdentitySnapshot> {
  const result = await runOrThrow('svn', ['info', '--xml', '--non-interactive', '--', escapeUrlPeg(parentUrl)]);
  const summary = parseParentInfoXml(result.stdout);
  if (!summary) {
    throw new Error('svn info --xml 输出无法解析父目录摘要');
  }
  const { repositoryUuid, repositoryRootUrl, lastChangedRevision } = summary;
  return { repositoryUuid, repositoryRootUrl, lastChangedRevision };
}

/**
 * 临时 HOME：解析器与 svn 子进程（继承环境）读同一份临时配置，隔离
 * 用户 ~/.subversion/config 的自定义 global-ignores 对对照断言的影响。
 * configText 缺省写显式空忽略集（`global-ignores =` 覆盖内置默认集）。
 */
function withTempHome(configText = '[miscellany]\nglobal-ignores =\n'): { home: string; restore(): void } {
  const home = mkdtempSync(join(tmpdir(), 'svn-anywhere-imp-home-'));
  mkdirSync(join(home, '.subversion'), { recursive: true });
  writeFileSync(join(home, '.subversion', 'config'), configText, 'utf8');
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  return {
    home,
    restore() {
      process.env.HOME = savedHome;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

describe('导入全链路（真实 svn）', () => {
  it('枚举→快照→import→verify 判 committed（中文/空格/空目录/symlink）', async () => {
    if (!hasSvn || !hasSvnadmin) {
      return;
    }
    const lab = makeLab('svn-anywhere-imp-full-');
    const parentUrl = seedParent(lab);
    // 临时 HOME 显式空忽略集：解析器与 svn 子进程同读一份配置，隔离
    // 用户配置的偶然影响；ignored 剔除的同源对照由临时 HOME 续行用例承担。
    const tempHome = withTempHome();
    try {
      const src = join(lab.root, 'src');
      mkdirSync(join(src, '空 目录', 'deep'), { recursive: true });
      mkdirSync(join(src, 'emptydir'));
      writeFileSync(join(src, 'a&b.txt'), 'hello');
      writeFileSync(join(src, '空 目录', 'deep', 'd.txt'), 'deep');
      symlinkSync('a&b.txt', join(src, 'link'));

      const enumeration = enumerateImportSource(src, { ignorePatterns: readSvnConfigGlobalIgnores() });
      expect(enumeration.blockers).toEqual([]);
      expect(enumeration.dirs).toEqual(['emptydir', '空 目录', '空 目录/deep']);
      const snapshot = enumerationToSnapshot(enumeration);
      const digest = snapshotDigest(snapshot);

      const targetUrl = buildImportTargetUrl(parentUrl, '导入 目标@x');
      const identity = await readParentIdentity(parentUrl);
      const recheck = await recheckImportTarget('svn', parentUrl, targetUrl, identity);
      expect(recheck.ok).toBe(true);
      const anchor = recheck.ok ? recheck.parentIdentity : identity;

      const message = '导入 & <说明>\r\n第二行\r\n';
      const temp = writeMessageTempFile(message);
      try {
        const args = buildImportArgs(targetUrl, src, temp.messageFile);
        // 目录名编码一次（@ → %40），import 目标原样传入。
        expect(args.at(-1)).toBe(targetUrl);
        expect(args.at(-1)).not.toContain('导入 目标@x');
        lab.svn(args);
      } finally {
        removeMessageTempDir(temp.tempDir);
      }

      const outcome = await verifyImportOutcome('svn', {
        snapshot,
        expectedSnapshotDigest: digest,
        targetUrl,
        parentUrl,
        parentIdentity: anchor,
        expectedMessageDigest: messageDigest(message),
      });
      // committed = changed paths 精确匹配（文件集合含 symlink、剔除 ignored、
      // 目录子集、目标根 action=A），即「解析器标注 = svn 实际入库」的对照。
      expect(outcome).toEqual({ kind: 'committed', revision: 2 });
    } finally {
      tempHome.restore();
    }
  });

  it('目标从未创建：父目录三项一致 → notCommitted', async () => {
    if (!hasSvn || !hasSvnadmin) {
      return;
    }
    const lab = makeLab('svn-anywhere-imp-not-');
    const parentUrl = seedParent(lab);
    const targetUrl = buildImportTargetUrl(parentUrl, 'never-there');

    const identity = await readParentIdentity(parentUrl);
    const recheck = await recheckImportTarget('svn', parentUrl, targetUrl, identity);
    expect(recheck.ok).toBe(true);
    const anchor = recheck.ok ? recheck.parentIdentity : identity;

    const snapshot = { version: 1, entries: [], dirs: [] };
    const outcome = await verifyImportOutcome('svn', {
      snapshot,
      expectedSnapshotDigest: snapshotDigest(snapshot),
      targetUrl,
      parentUrl,
      parentIdentity: anchor,
      expectedMessageDigest: messageDigest('说明\n'),
    });
    expect(outcome).toEqual({ kind: 'notCommitted', evidence: { parentLastChangedRevision: anchor.lastChangedRevision } });
  });

  it('导入后目标被外部删除（revision 递增）→ unknown parentRevisionAdvanced', async () => {
    if (!hasSvn || !hasSvnadmin) {
      return;
    }
    const lab = makeLab('svn-anywhere-imp-del-');
    const parentUrl = seedParent(lab);
    const tempHome = withTempHome();
    try {
      const src = join(lab.root, 'src');
      mkdirSync(src);
      writeFileSync(join(src, 'a.txt'), 'x');
      const enumeration = enumerateImportSource(src, { ignorePatterns: readSvnConfigGlobalIgnores() });
      const snapshot = enumerationToSnapshot(enumeration);

      const targetUrl = buildImportTargetUrl(parentUrl, 'gone-later');
      const identity = await readParentIdentity(parentUrl);
      const recheck = await recheckImportTarget('svn', parentUrl, targetUrl, identity);
      const anchor = recheck.ok ? recheck.parentIdentity : identity;

      const temp = writeMessageTempFile('说明\n');
      try {
        lab.svn(buildImportArgs(targetUrl, src, temp.messageFile));
      } finally {
        removeMessageTempDir(temp.tempDir);
      }
      // 导入成功（r2）后外部删除目标（r3）：锚点停在 r1。
      lab.svn(['rm', '-q', '-m', 'remove target', `${targetUrl}@`]);

      const outcome = await verifyImportOutcome('svn', {
        snapshot,
        expectedSnapshotDigest: snapshotDigest(snapshot),
        targetUrl,
        parentUrl,
        parentIdentity: anchor,
        expectedMessageDigest: messageDigest('说明\n'),
      });
      expect(outcome).toMatchObject({ kind: 'unknown', reason: 'parentRevisionAdvanced' });
    } finally {
      tempHome.restore();
    }
  });
});

describe('源预检与开始前重检（真实 svn）', () => {
  it('副本内未纳管 E200009 / 副本外 E155007 → unversioned；副本根 → versioned', async () => {
    if (!hasSvn || !hasSvnadmin) {
      return;
    }
    const lab = makeLab('svn-anywhere-imp-pre-');
    lab.svn(['mkdir', '-q', '-m', 'r1', `${lab.repoUrl}/trunk`]);
    const wc = join(lab.root, 'wc');
    lab.svn(['checkout', '-q', lab.repoUrl, wc]);

    const inner = join(wc, 'unversioned-inner');
    mkdirSync(inner);
    writeFileSync(join(inner, 'f.txt'), 'x');
    expect(await precheckImportSource('svn', inner)).toMatchObject({ status: 'unversioned' });

    const outside = join(lab.root, 'outside');
    mkdirSync(outside);
    expect(await precheckImportSource('svn', outside)).toMatchObject({ status: 'unversioned' });

    expect(await precheckImportSource('svn', wc)).toMatchObject({ status: 'versioned' });
  });

  it('目标已存在 → recheck targetExists；通过时刷新 revision 锚点', async () => {
    if (!hasSvn || !hasSvnadmin) {
      return;
    }
    const lab = makeLab('svn-anywhere-imp-re-');
    const parentUrl = seedParent(lab);
    const identity = await readParentIdentity(parentUrl);

    const takenUrl = buildImportTargetUrl(parentUrl, 'taken');
    lab.svn(['mkdir', '-q', '-m', 'take', `${takenUrl}@`]);
    const exists = await recheckImportTarget('svn', parentUrl, takenUrl, identity);
    expect(exists).toMatchObject({ ok: false, failure: 'targetExists' });

    const freeUrl = buildImportTargetUrl(parentUrl, 'free');
    const ok = await recheckImportTarget('svn', parentUrl, freeUrl, identity);
    expect(ok).toEqual({ ok: true, parentIdentity: { ...identity, lastChangedRevision: 2 } });
  });
});

describe('global-ignores 同源对照（临时 HOME）', () => {
  it('续行配置下解析器标注 = svn import 实际入库（verify committed 即对照成立）', async () => {
    if (!hasSvn || !hasSvnadmin) {
      return;
    }
    const lab = makeLab('svn-anywhere-imp-home-');
    const parentUrl = seedParent(lab);
    // 临时 HOME 同时作用于解析器（process.env.HOME）与 svn 子进程
    // （继承环境），两者读同一份带续行的配置、不污染用户 ~/.subversion/config。
    const tempHome = withTempHome('[miscellany]\nglobal-ignores = *.ign \\\n  *.ign2\n');
    try {
      const patterns = readSvnConfigGlobalIgnores();
      expect(patterns).toEqual(['*.ign', '*.ign2']);

      const src = join(lab.root, 'src');
      mkdirSync(src);
      writeFileSync(join(src, 'skip.ign'), 'a');
      writeFileSync(join(src, 'skip.ign2'), 'b');
      writeFileSync(join(src, 'keep.txt'), 'c');
      const enumeration = enumerateImportSource(src, { ignorePatterns: patterns });
      expect(enumeration.entries.filter((e) => e.ignored).map((e) => e.path)).toEqual(['skip.ign', 'skip.ign2']);
      const snapshot = enumerationToSnapshot(enumeration);

      const targetUrl = buildImportTargetUrl(parentUrl, 'home-ign');
      const identity = await readParentIdentity(parentUrl);
      const recheck = await recheckImportTarget('svn', parentUrl, targetUrl, identity);
      const anchor = recheck.ok ? recheck.parentIdentity : identity;

      const temp = writeMessageTempFile('说明\n');
      try {
        lab.svn(buildImportArgs(targetUrl, src, temp.messageFile));
      } finally {
        removeMessageTempDir(temp.tempDir);
      }

      const outcome = await verifyImportOutcome('svn', {
        snapshot,
        expectedSnapshotDigest: snapshotDigest(snapshot),
        targetUrl,
        parentUrl,
        parentIdentity: anchor,
        expectedMessageDigest: messageDigest('说明\n'),
      });
      // 若 svn 实际提交了 skip.ign/skip.ign2，文件集合精确匹配会失败——
      // committed 即证明解析器的 ignored 标注与 import 实际跳过一致。
      expect(outcome).toEqual({ kind: 'committed', revision: 2 });
    } finally {
      tempHome.restore();
    }
  });
});
