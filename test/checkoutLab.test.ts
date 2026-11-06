/**
 * 检出 core 的真实 svn 烟囱（svnadmin + file://，不碰远端服务器）：
 * - checkRemote 的 dir/file/不存在路径/不存在 revision/含 %40 的 URL/尾斜杠等价；
 * - buildCheckoutArgs 产出的参数直接可执行（URL 与目标 peg 转义正确）；
 * - verifyResumable 对完整副本、部分检出（immediates）、missing 条目、
 *   深度/revision/身份不一致的分类，以及 cleanup + update 续检序列补全。
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCheckoutArgs,
  buildResumeArgs,
  checkRemote,
  verifyResumable,
  type ResumableExpectation,
} from '../src/core/checkout';
import { createSvnLab, type SvnLab } from './helpers';

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

/**
 * 远端结构（r1-r5）：
 * r1 /trunk；r2 /trunk/a.txt；r3 /trunk/sub/deep.txt；
 * r4 /a@b（以 %40 编码创建）；r5 /a@b/inside.txt。
 */
function seedRemote(lab: SvnLab): string {
  const src = join(lab.root, 'seed.txt');
  writeFileSync(src, 'content\n');
  lab.svn(['mkdir', '-q', '-m', 'trunk', `${lab.repoUrl}/trunk`]);
  lab.svn(['import', '-q', '-m', 'a', src, `${lab.repoUrl}/trunk/a.txt`]);
  lab.svn(['import', '-q', '-m', 'deep', src, `${lab.repoUrl}/trunk/sub/deep.txt`]);
  // mkdir 的 URL 目标按 peg 语义解析（%40 解码为 @ 会被当作 peg 分隔符），
  // 与 import 不同，须补尾 @ 让 svn 把整段当路径。
  lab.svn(['mkdir', '-q', '-m', 'at', `${lab.repoUrl}/a%40b@`]);
  lab.svn(['import', '-q', '-m', 'inside', src, `${lab.repoUrl}/a%40b/inside.txt`]);
  return `${lab.repoUrl}/trunk`;
}

/** 用真实 checkRemote 构造核验基准（模拟连接检查快照写入记录的链路）。 */
async function expectationFor(
  trunkUrl: string,
  depth: ResumableExpectation['depth'],
): Promise<ResumableExpectation> {
  const check = await checkRemote('svn', trunkUrl);
  if (!check.ok) {
    throw new Error(`checkRemote 应成功：${JSON.stringify(check)}`);
  }
  return { ...check.identity, depth, pinnedRevision: check.pinnedRevision };
}

describe('checkRemote（真实 svn）', () => {
  it('dir/file/不存在路径/不存在 revision/%40 URL/尾斜杠等价', async () => {
    const lab = makeLab('svn-anywhere-co-remote-');
    const trunkUrl = seedRemote(lab);

    const dir = await checkRemote('svn', trunkUrl);
    expect(dir).toMatchObject({
      ok: true,
      pinnedRevision: 5,
      identity: { repositoryRootUrl: lab.repoUrl, relativeUrl: '^/trunk' },
    });
    if (dir.ok) {
      expect(dir.identity.repositoryUuid).toMatch(/^[0-9a-f-]{36}$/);
    }

    // 尾斜杠的等价 URL：svn 规范化后身份三元组一致。
    const trailingSlash = await checkRemote('svn', `${trunkUrl}/`);
    expect(trailingSlash).toEqual(dir);

    // file 节点 info 成功但判「目标不是目录」。
    const file = await checkRemote('svn', `${trunkUrl}/a.txt`);
    expect(file).toMatchObject({ ok: false, failure: 'notDir' });

    // 不存在路径：W170000 + E200009。
    const missing = await checkRemote('svn', `${lab.repoUrl}/nope`);
    expect(missing).toMatchObject({ ok: false, failure: 'urlNotFound' });

    // 不存在 revision：E160006。
    const noRevision = await checkRemote('svn', trunkUrl, { revision: 99 });
    expect(noRevision).toMatchObject({ ok: false, failure: 'revisionNotFound' });

    // 含 %40 的 URL：补尾 @ 后真实 svn 接受；relative-url 是 svn 规范化
    // 输出的解码形态（^/a@b），不是原始编码形态。
    const pegged = await checkRemote('svn', `${lab.repoUrl}/a%40b`);
    expect(pegged).toMatchObject({
      ok: true,
      identity: { repositoryRootUrl: lab.repoUrl, relativeUrl: '^/a@b' },
    });
  });
});

describe('buildCheckoutArgs（真实 svn 执行）', () => {
  it('含 %40 的 URL 与含 @ 的目标目录都能检出成功', () => {
    const lab = makeLab('svn-anywhere-co-args-');
    seedRemote(lab);

    const target = join(lab.root, 'wc@x');
    const args = buildCheckoutArgs(`${lab.repoUrl}/a%40b`, target, { revision: 5, depth: 'infinity' });
    expect(args.at(-2)).toBe(`${lab.repoUrl}/a%40b@`);
    lab.svn(args);
    expect(existsSync(join(target, 'inside.txt'))).toBe(true);

    // 深度用 --depth：immediates 检出只落一层，子目录内容不递归。
    const shallow = join(lab.root, 'shallow');
    lab.svn(buildCheckoutArgs(`${lab.repoUrl}/trunk`, shallow, { revision: 5, depth: 'immediates' }));
    expect(existsSync(join(shallow, 'sub'))).toBe(true);
    expect(existsSync(join(shallow, 'sub', 'deep.txt'))).toBe(false);
  });
});

describe('verifyResumable（真实 svn）', () => {
  it('完整副本：身份/深度/revision 全一致 → resumable；URL 字符串形态不影响', async () => {
    const lab = makeLab('svn-anywhere-co-full-');
    const trunkUrl = seedRemote(lab);
    const wc = join(lab.root, 'wc');
    lab.svn(['checkout', '-q', trunkUrl, wc]);

    const expectation = await expectationFor(trunkUrl, 'infinity');
    const report = await verifyResumable('svn', wc, expectation);
    expect(report.kind).toBe('resumable');
    expect(report.identity?.workingRevision).toBe(5);
    expect(report.status?.entries).toEqual([]);
  });

  it('副本内 missing 条目不阻断（未完成状态正是续检要补全的对象）', async () => {
    const lab = makeLab('svn-anywhere-co-missing-');
    const trunkUrl = seedRemote(lab);
    const wc = join(lab.root, 'wc');
    lab.svn(['checkout', '-q', trunkUrl, wc]);
    rmSync(join(wc, 'sub', 'deep.txt'));

    const expectation = await expectationFor(trunkUrl, 'infinity');
    const report = await verifyResumable('svn', wc, expectation);
    expect(report.kind).toBe('resumable');
    expect(report.status?.entries.some((e) => e.wcStatus === 'missing')).toBe(true);
  });

  it('部分检出（immediates）：同深度 → resumable；深度不符 → depthMismatch', async () => {
    const lab = makeLab('svn-anywhere-co-depth-');
    const trunkUrl = seedRemote(lab);
    const wc = join(lab.root, 'wc');
    lab.svn(['checkout', '-q', '--depth', 'immediates', trunkUrl, wc]);

    const same = await expectationFor(trunkUrl, 'immediates');
    expect((await verifyResumable('svn', wc, same)).kind).toBe('resumable');

    const crossed = await expectationFor(trunkUrl, 'infinity');
    const report = await verifyResumable('svn', wc, crossed);
    expect(report).toMatchObject({ kind: 'resumeBlocked', blockReason: 'depthMismatch' });
    expect(report.identity?.depth).toBe('immediates');
  });

  it('工作 revision 超过固定 revision → revisionMismatch', async () => {
    const lab = makeLab('svn-anywhere-co-rev-');
    const trunkUrl = seedRemote(lab);
    const wc = join(lab.root, 'wc');
    lab.svn(['checkout', '-q', '-r', '3', trunkUrl, wc]);

    const pinned = await expectationFor(trunkUrl, 'infinity');
    expect(pinned.pinnedRevision).toBe(5);
    // 副本停在 r3 ≤ r5：可续。
    expect((await verifyResumable('svn', wc, pinned)).kind).toBe('resumable');

    // 仓库前进到 r6 且副本更新过去：工作 revision 超过固定值。
    const extra = join(lab.root, 'extra.txt');
    writeFileSync(extra, 'more\n');
    lab.svn(['import', '-q', '-m', 'r6', extra, `${lab.repoUrl}/trunk/extra.txt`]);
    lab.svn(['update', '-q', wc]);
    const report = await verifyResumable('svn', wc, pinned);
    expect(report).toMatchObject({ kind: 'resumeBlocked', blockReason: 'revisionMismatch' });
  });

  it('仓库身份不一致 → identityMismatch', async () => {
    const lab = makeLab('svn-anywhere-co-id-');
    const trunkUrl = seedRemote(lab);
    const wc = join(lab.root, 'wc');
    lab.svn(['checkout', '-q', trunkUrl, wc]);

    const expectation = await expectationFor(trunkUrl, 'infinity');
    const report = await verifyResumable('svn', wc, {
      ...expectation,
      repositoryUuid: '99999999-9999-9999-9999-999999999999',
    });
    expect(report).toMatchObject({ kind: 'resumeBlocked', blockReason: 'identityMismatch' });
  });

  it('续检序列：缺直接子项的部分副本先 cleanup 再 update --set-depth 补全后复核可续', async () => {
    const lab = makeLab('svn-anywhere-co-resume-');
    const trunkUrl = seedRemote(lab);
    const wc = join(lab.root, 'wc');
    lab.svn(['checkout', '-q', '--depth', 'immediates', trunkUrl, wc]);
    // immediates 深度只落直接子项：a.txt 在层内，sub/deep.txt 属第二层
    // 不拉取（同深度续检不会补它，属深度内正常状态）。
    expect(existsSync(join(wc, 'a.txt'))).toBe(true);
    expect(existsSync(join(wc, 'sub', 'deep.txt'))).toBe(false);
    // 构造层内缺失（对应中断副本的 missing 项）。
    rmSync(join(wc, 'a.txt'));

    const expectation = await expectationFor(trunkUrl, 'immediates');
    const before = await verifyResumable('svn', wc, expectation);
    expect(before.kind).toBe('resumable');
    expect(before.status?.entries.some((e) => e.wcStatus === 'missing')).toBe(true);

    const { cleanupArgs, updateArgs } = buildResumeArgs(wc, {
      pinnedRevision: expectation.pinnedRevision,
      depth: 'immediates',
    });
    lab.svn(cleanupArgs);
    lab.svn(updateArgs);
    expect(existsSync(join(wc, 'a.txt'))).toBe(true);
    expect(lab.svn(['status', wc]).trim()).toBe('');

    const after = await verifyResumable('svn', wc, expectation);
    expect(after.kind).toBe('resumable');
    expect(after.identity?.depth).toBe('immediates');
  });
});
