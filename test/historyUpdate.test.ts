/**
 * history-update 的写前检查、命令与回读测试：
 * - 纯逻辑覆盖固定意图、命令参数、本地存在性与非法 revision；
 * - 集成用例走本地 svnadmin + file:// 副本：更新成功/冲突/未知、复制前
 *   更新禁用、本地修改阻止、范围冲突、未知回扫三出口。
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { scanConflicts } from '../src/core/conflict';
import { buildHistoryUpdateArgs, checkHistoryUpdatePreconditions, checkLocalUpdateTarget, prepareHistoryUpdate, rescanHistoryUpdate, runHistoryUpdate, type HistoryUpdateIntent } from '../src/core/historyUpdate';
import { createSvnLab, writeFile } from './helpers';

const lab = createSvnLab('svn-anywhere-history-update-');
afterAll(() => lab.cleanup());

function headRevision(): number {
  return Number(lab.svn(['info', '--show-item', 'revision', lab.repoUrl]).trim());
}

/** 在共享 lab 仓库提交一个唯一文件的基线，返回该提交的 revision。 */
function seedFile(relative: string, content = 'v1\n'): number {
  const seeder = lab.checkout(`seed-${relative.replace(/[/.]/g, '-')}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  writeFile(seeder, relative, content, true);
  lab.svn(['commit', '-q', '-m', `seed ${relative}`], seeder);
  return Number(lab.svn(['info', '--show-item', 'revision', relative], seeder).trim());
}

describe('buildHistoryUpdateArgs 固定参数形态', () => {
  const intent: HistoryUpdateIntent = {
    wcRoot: '/wc',
    targetRelPath: 'a.txt',
    targetKind: 'file',
    targetUrl: 'file:///repo/a.txt',
    requestedRevision: 5,
    preRevision: 3,
  };

  it('固定 --non-interactive --ignore-externals -r <rev> -- <target>', () => {
    expect(buildHistoryUpdateArgs(intent)).toEqual([
      'update',
      '--non-interactive',
      '--ignore-externals',
      '-r',
      '5',
      '--',
      'a.txt',
    ]);
  });

  it('含 @ 的目标路径经 escapePeg 尾部补 @；请求 revision 固定为数字', () => {
    const args = buildHistoryUpdateArgs({ ...intent, targetRelPath: 'at@2.txt', requestedRevision: 7 });
    expect(args).toContain('at@2.txt@');
    expect(args[args.indexOf('-r') + 1]).toBe('7');
    expect(args).not.toContain('HEAD');
  });
});

describe('checkLocalUpdateTarget 本地目标存在性', () => {
  it('存在且属于目标工作副本的文件/目录通过；缺失路径阻止', () => {
    const wc = lab.checkout('hu-local');
    writeFile(wc, 'present.txt', 'x', true);
    expect(checkLocalUpdateTarget(wc, 'present.txt')).toMatchObject({ ok: true, kind: 'file' });
    expect(checkLocalUpdateTarget(wc, '.')).toMatchObject({ ok: true, kind: 'dir' });
    expect(checkLocalUpdateTarget(wc, 'missing.txt')).toEqual({ ok: false, reason: 'missing-local' });
  });

  it('嵌套工作副本不并入外层副本的更新范围', () => {
    const outer = lab.checkout('hu-outer');
    const nested = `${outer}/nested`;
    lab.svn(['checkout', '-q', lab.repoUrl, nested], outer);
    expect(checkLocalUpdateTarget(outer, 'nested')).toMatchObject({ ok: false, reason: 'nested-working-copy' });
  });
});

describe('prepareHistoryUpdate 固定意图', () => {
  it('组装 wcRoot/relPath/kind/url/requestedRevision/preRevision', async () => {
    const baseRev = seedFile('hu-prepare.txt');
    const wc = lab.checkout('hu-prepare');
    lab.svn(['update', '-q', '-r', String(baseRev)], wc);
    const prepared = await prepareHistoryUpdate('svn', wc, 'hu-prepare.txt', headRevision());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    expect(prepared.intent).toMatchObject({
      targetRelPath: 'hu-prepare.txt',
      targetKind: 'file',
      requestedRevision: headRevision(),
      preRevision: baseRev,
    });
    expect(prepared.intent.targetUrl.endsWith('/hu-prepare.txt')).toBe(true);
    expect(prepared.intent.wcRoot).toBe(wc);
  });

  it('非法 revision、缺失路径与未版本控制路径分别拒绝', async () => {
    const wc = lab.checkout('hu-prepare-bad');
    writeFile(wc, 'unversioned.txt', 'x');
    for (const invalid of [0, -1, 1.5]) {
      expect(await prepareHistoryUpdate('svn', wc, 'unversioned.txt', invalid)).toEqual({ ok: false, reason: 'invalid-revision' });
    }
    expect(await prepareHistoryUpdate('svn', wc, 'nope.txt', 1)).toEqual({ ok: false, reason: 'missing-local' });
    const unversioned = await prepareHistoryUpdate('svn', wc, 'unversioned.txt', 1);
    expect(unversioned.ok).toBe(false);
    if (!unversioned.ok) {
      expect(unversioned.reason).toBe('not-versioned');
    }
  });
});

describe('checkHistoryUpdatePreconditions 写前检查', () => {
  it('干净目标通过；本地修改与属性修改阻止', async () => {
    const baseRev = seedFile('hu-check.txt');
    const wc = lab.checkout('hu-check');
    writeFile(wc, 'props.txt', 'p1\n', true);
    lab.svn(['commit', '-q', '-m', 'check props base'], wc);
    const prepared = await prepareHistoryUpdate('svn', wc, 'hu-check.txt', baseRev);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    expect(await checkHistoryUpdatePreconditions('svn', prepared.intent)).toEqual({ ok: true });

    writeFile(wc, 'hu-check.txt', 'locally modified\n');
    const modified = await checkHistoryUpdatePreconditions('svn', prepared.intent);
    expect(modified.ok).toBe(false);
    expect(modified.reason).toBe('local-modifications');
    expect(modified.blocking?.map((entry) => entry.path)).toContain('hu-check.txt');

    writeFile(wc, 'hu-check.txt', 'v1\n');
    // 目录目标：根目录属性修改属于该目标范围。
    const rootPrepared = await prepareHistoryUpdate('svn', wc, '.', baseRev);
    expect(rootPrepared.ok).toBe(true);
    if (!rootPrepared.ok) {
      return;
    }
    lab.svn(['propset', '-q', 'svn:ignore', 'ignored.tmp', '.'], wc);
    const propsModified = await checkHistoryUpdatePreconditions('svn', rootPrepared.intent);
    expect(propsModified.ok).toBe(false);
    expect(propsModified.reason).toBe('local-modifications');
    expect(propsModified.blocking?.some((entry) => entry.props === 'modified')).toBe(true);
  });

  it('复制前更新禁用：请求 revision 早于复制点时 target-absent-at-revision', async () => {
    const seeder = lab.checkout('hu-copy-seed');
    writeFile(seeder, 'hu-trunk/a.txt', 'v1\n', true);
    lab.svn(['commit', '-q', '-m', 'copy seed trunk'], seeder);
    const trunkRev = Number(lab.svn(['info', '--show-item', 'revision', 'hu-trunk/a.txt'], seeder).trim());
    lab.svn(['copy', '-q', '-m', 'copy trunk', `${lab.repoUrl}/hu-trunk`, `${lab.repoUrl}/hu-branch`], seeder);
    const copyRev = headRevision();
    const wc = lab.checkout('hu-copy');
    const beforeCopy = await prepareHistoryUpdate('svn', wc, 'hu-branch/a.txt', trunkRev);
    expect(beforeCopy.ok).toBe(true);
    if (!beforeCopy.ok) {
      return;
    }
    const blocked = await checkHistoryUpdatePreconditions('svn', beforeCopy.intent);
    expect(blocked).toMatchObject({ ok: false, reason: 'target-absent-at-revision' });

    const atCopy = await prepareHistoryUpdate('svn', wc, 'hu-branch/a.txt', copyRev);
    expect(atCopy.ok).toBe(true);
    if (!atCopy.ok) {
      return;
    }
    expect(await checkHistoryUpdatePreconditions('svn', atCopy.intent)).toEqual({ ok: true });
  });
});

describe('runHistoryUpdate 执行与回读', () => {
  it('成功：回读节点 revision 等于请求值且无冲突 → updated；rescan 同出口', async () => {
    const baseRev = seedFile('hu-run.txt');
    const wc = lab.checkout('hu-run');
    lab.svn(['update', '-q', '-r', String(baseRev)], wc);
    const other = lab.checkout('hu-run-other');
    writeFile(other, 'hu-run.txt', 'v2\n');
    lab.svn(['commit', '-q', '-m', 'run remote'], other);
    const targetRev = headRevision();

    const prepared = await prepareHistoryUpdate('svn', wc, 'hu-run.txt', targetRev);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    expect(prepared.intent.preRevision).toBe(baseRev);
    const result = await runHistoryUpdate('svn', prepared.intent);
    expect(result).toMatchObject({
      targetRelPath: 'hu-run.txt',
      requestedRevision: targetRev,
      preRevision: baseRev,
      postNodeRevision: targetRev,
      outcome: 'updated',
    });
    expect(result.conflicts).toEqual([]);
    expect(result.conflictSummary.total).toBe(0);
    expect(lab.svn(['info', '--show-item', 'revision', 'hu-run.txt'], wc).trim()).toBe(String(targetRev));

    const rescan = await rescanHistoryUpdate('svn', prepared.intent);
    expect(rescan.outcome).toBe('updated');
  });

  it('冲突：本地修改 + 传入修改 → conflict，冲突集合限定本次目标范围', async () => {
    const baseRev = seedFile('hu-conflict/sub/a.txt');
    const wc = lab.checkout('hu-conflict');
    lab.svn(['update', '-q', '-r', String(baseRev)], wc);
    const other = lab.checkout('hu-conflict-other');
    writeFile(other, 'hu-conflict/sub/a.txt', 'v1\nremote\n');
    lab.svn(['commit', '-q', '-m', 'conflict remote sub'], other);
    writeFile(wc, 'hu-conflict/sub/a.txt', 'v1\nlocal\n');
    // 根上另一个文件也制造冲突，但不在本次目标范围（sub）内。
    writeFile(other, 'hu-conflict/root.txt', 'v1\n', true);
    lab.svn(['commit', '-q', '-m', 'conflict remote root'], other);
    writeFile(wc, 'hu-conflict/root.txt', 'v1\nlocal\n');
    const targetRev = headRevision();

    const prepared = await prepareHistoryUpdate('svn', wc, 'hu-conflict/sub', targetRev);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    expect(prepared.intent.targetKind).toBe('dir');
    const result = await runHistoryUpdate('svn', prepared.intent);
    expect(result.outcome).toBe('conflict');
    expect(result.postNodeRevision).toBe(targetRev);
    expect(result.conflicts.map((record) => record.path)).toEqual(['hu-conflict/sub/a.txt']);
    expect(result.conflictSummary).toEqual({ text: 1, property: 0, tree: 0, total: 1 });
    // 命令输出初解析线索：C 行路径与 final revision 供交叉核对。
    expect(result.outputHint?.conflicts).toEqual(['hu-conflict/sub/a.txt']);
    expect(result.outputHint?.finalRevision).toBe(targetRev);

    const rescan = await rescanHistoryUpdate('svn', prepared.intent);
    expect(rescan.outcome).toBe('conflict');
    expect(rescan.conflicts.map((record) => record.path)).toEqual(['hu-conflict/sub/a.txt']);
  });

  it('命令失败（不存在的 revision）：回读成功也不按预期值结算 → unknown', async () => {
    const baseRev = seedFile('hu-unknown.txt');
    const wc = lab.checkout('hu-unknown');
    lab.svn(['update', '-q', '-r', String(baseRev)], wc);
    const prepared = await prepareHistoryUpdate('svn', wc, 'hu-unknown.txt', headRevision() + 1000);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    const result = await runHistoryUpdate('svn', prepared.intent);
    expect(result.outcome).toBe('unknown');
    expect(result.postNodeRevision).toBe(baseRev);

    const rescan = await rescanHistoryUpdate('svn', prepared.intent);
    expect(rescan.outcome).toBe('still-unknown');
    expect(rescan.postNodeRevision).toBe(baseRev);
  });

  it('进程级失败（svn 不存在）：回读失败 → unknown + readbackError', async () => {
    const intent: HistoryUpdateIntent = {
      wcRoot: '/nonexistent',
      targetRelPath: 'x.txt',
      targetKind: 'file',
      targetUrl: 'file:///nonexistent/x.txt',
      requestedRevision: 1,
      preRevision: 1,
    };
    const result = await runHistoryUpdate('definitely-not-a-svn-binary', intent);
    expect(result.outcome).toBe('unknown');
    expect(result.readbackError).toBeDefined();
    expect(result.conflicts).toEqual([]);
    const rescan = await rescanHistoryUpdate('definitely-not-a-svn-binary', intent);
    expect(rescan.outcome).toBe('still-unknown');
    expect(rescan.readbackError).toBeDefined();
  });
});

/* ---------------------------------------------------------------------------
 * 未知回扫三出口（成功/冲突）、external 内部副本隔离
 * ------------------------------------------------------------------------- */

/**
 * 模拟「svn update 实际写入成功但命令输出失败」：wrapper 转发真实 svn，
 * 只把 update 的退出码改为 1。用于覆盖未知态后回扫的成功/冲突出口
 * （与「进程失败但写入可能已发生」的真实 kill 形态同构）。
 */
function createFailingUpdateSvn(): string {
  const realSvn = execFileSync('which', ['svn'], { encoding: 'utf8' }).trim();
  const wrapper = join(lab.root, `svn-update-fails-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.sh`);
  writeFileSync(wrapper, `#!/bin/sh\n"${realSvn}" "$@"\nrc=$?\nif [ "$1" = "update" ]; then\n  exit 1\nfi\nexit $rc\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

describe('未知回扫三出口：命令输出失败但写入已生效', () => {
  it('成功出口：update 实际成功但退出码非零 → unknown；回扫确认请求 revision 且无冲突 → updated', async () => {
    const baseRev = seedFile('hu-rescan-ok.txt');
    const wc = lab.checkout('hu-rescan-ok');
    lab.svn(['update', '-q', '-r', String(baseRev)], wc);
    const other = lab.checkout('hu-rescan-ok-other');
    writeFile(other, 'hu-rescan-ok.txt', 'v2\n');
    lab.svn(['commit', '-q', '-m', 'rescan ok remote'], other);
    const targetRev = headRevision();
    const prepared = await prepareHistoryUpdate('svn', wc, 'hu-rescan-ok.txt', targetRev);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    const failing = createFailingUpdateSvn();
    const result = await runHistoryUpdate(failing, prepared.intent);
    // 命令被记为失败 → unknown（即使写入实际发生、回读 revision 已等于请求）。
    expect(result.outcome).toBe('unknown');
    expect(result.postNodeRevision).toBe(targetRev);
    expect(readFileSync(join(wc, 'hu-rescan-ok.txt'), 'utf8')).toBe('v2\n');

    const rescan = await rescanHistoryUpdate(failing, prepared.intent);
    expect(rescan.outcome).toBe('updated');
    expect(rescan.postNodeRevision).toBe(targetRev);
    expect(rescan.conflicts).toEqual([]);
    expect(rescan.conflictSummary.total).toBe(0);
  });

  it('冲突出口：写入实际产生冲突但退出码非零 → unknown；回扫确认请求 revision 且有冲突 → conflict', async () => {
    const baseRev = seedFile('hu-rescan-conflict/sub/a.txt');
    const wc = lab.checkout('hu-rescan-conflict');
    lab.svn(['update', '-q', '-r', String(baseRev)], wc);
    const other = lab.checkout('hu-rescan-conflict-other');
    writeFile(other, 'hu-rescan-conflict/sub/a.txt', 'v1\nremote\n');
    lab.svn(['commit', '-q', '-m', 'rescan conflict remote'], other);
    writeFile(wc, 'hu-rescan-conflict/sub/a.txt', 'v1\nlocal\n');
    const targetRev = headRevision();
    const prepared = await prepareHistoryUpdate('svn', wc, 'hu-rescan-conflict/sub', targetRev);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    const failing = createFailingUpdateSvn();
    const result = await runHistoryUpdate(failing, prepared.intent);
    expect(result.outcome).toBe('unknown');
    expect(result.postNodeRevision).toBe(targetRev);
    expect(result.conflicts.map((record) => record.path)).toEqual(['hu-rescan-conflict/sub/a.txt']);

    const rescan = await rescanHistoryUpdate(failing, prepared.intent);
    expect(rescan.outcome).toBe('conflict');
    expect(rescan.postNodeRevision).toBe(targetRev);
    expect(rescan.conflicts.map((record) => record.path)).toEqual(['hu-rescan-conflict/sub/a.txt']);
    expect(rescan.conflictSummary).toEqual({ text: 1, property: 0, tree: 0, total: 1 });
  });
});

describe('external 内部副本隔离（P6 更新与 P7 范围）', () => {
  it('P6 --ignore-externals 不更新 external 内部；external 内部冲突不进入本次结果与范围扫描', async () => {
    const seeder = lab.checkout(`hu-ext-seed-${Date.now()}`);
    writeFile(seeder, 'hu-ext/extsrc/f.txt', 'ext v1\n', true);
    writeFile(seeder, 'hu-ext/proj/main.txt', 'main v1\n', true);
    lab.svn(['commit', '-q', '-m', 'ext base'], seeder);
    lab.svn(['propset', 'svn:externals', `ext ${lab.repoUrl}/hu-ext/extsrc`, 'hu-ext/proj'], seeder);
    lab.svn(['commit', '-q', '-m', 'ext definition'], seeder);
    const defRev = headRevision();

    const wc = lab.checkout(`hu-ext-wc-${Date.now()}`);
    lab.svn(['update', '-q', '-r', String(defRev)], wc);
    const externalFile = join(wc, 'hu-ext/proj/ext/f.txt');
    expect(existsSync(externalFile)).toBe(true);
    const externalRevisionBefore = lab.svn(['info', '--show-item', 'revision', 'hu-ext/proj/ext'], wc).trim();

    // external 内部本地修改（不属于本副本更新范围） + 外部源与主目标远程前进。
    writeFile(wc, 'hu-ext/proj/ext/f.txt', 'ext local\n');
    writeFile(seeder, 'hu-ext/extsrc/f.txt', 'ext v2\n');
    writeFile(seeder, 'hu-ext/proj/main.txt', 'main v2\n');
    lab.svn(['commit', '-q', '-m', 'ext remote + main'], seeder);
    const targetRev = headRevision();

    const prepared = await prepareHistoryUpdate('svn', wc, 'hu-ext/proj', targetRev);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    // 写前检查不因 external 内部修改阻止（status --ignore-externals）。
    expect(await checkHistoryUpdatePreconditions('svn', prepared.intent)).toEqual({ ok: true });

    const result = await runHistoryUpdate('svn', prepared.intent);
    expect(result.outcome).toBe('updated');
    expect(result.conflicts).toEqual([]);
    expect(readFileSync(join(wc, 'hu-ext/proj/main.txt'), 'utf8')).toBe('main v2\n');
    // external 内部 revision 未被 P6 更新推进，本地修改保留。
    expect(lab.svn(['info', '--show-item', 'revision', 'hu-ext/proj/ext'], wc).trim()).toBe(externalRevisionBefore);
    expect(readFileSync(externalFile, 'utf8')).toBe('ext local\n');

    // 普通 update（含 external）会产生外部内部冲突：真实 status 能看到。
    lab.svn(['update', '-q'], wc);
    const rawStatus = lab.svn(['status', '--xml'], wc);
    expect(rawStatus).toContain('hu-ext/proj/ext/f.txt');
    // P7 范围扫描同源（status --ignore-externals + external 边界过滤）不计外部内部冲突。
    const scoped = await scanConflicts('svn', wc, { scope: 'hu-ext/proj' });
    expect(scoped.records.some((record) => record.path.startsWith('hu-ext/proj/ext'))).toBe(false);
    const whole = await scanConflicts('svn', wc);
    expect(whole.records.some((record) => record.path.startsWith('hu-ext/proj/ext'))).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * 命令输出初解析线索（复用 parseUpdateOutput）
 * ------------------------------------------------------------------------- */

/**
 * 模拟「命令输出线索与权威回读不一致」：转发真实 svn，把 update 输出的
 * `Updated to revision N.` / `At revision N.` 改写为 999（退出码保持）。
 * 用于断言 outputHint 只作提示、outcome/postNodeRevision 仍以回读为准。
 */
function createHintedUpdateSvn(): string {
  const realSvn = execFileSync('which', ['svn'], { encoding: 'utf8' }).trim();
  const wrapper = join(lab.root, `svn-update-hint-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.sh`);
  writeFileSync(wrapper, [
    '#!/bin/bash',
    'out=$(mktemp)',
    `"${realSvn}" "$@" > "$out"`,
    'rc=$?',
    "sed -E 's/(Updated to|At) revision [0-9]+\\./\\1 revision 999./' \"$out\"",
    'rm -f "$out"',
    'exit $rc',
    '',
  ].join('\n'));
  chmodSync(wrapper, 0o755);
  return wrapper;
}

describe('命令输出初解析线索（parseUpdateOutput 复用）', () => {
  it('成功更新：outputHint 携带命令输出的 final revision，与回读一致', async () => {
    const baseRev = seedFile('hu-hint-ok.txt');
    const wc = lab.checkout('hu-hint-ok');
    lab.svn(['update', '-q', '-r', String(baseRev)], wc);
    const other = lab.checkout('hu-hint-ok-other');
    writeFile(other, 'hu-hint-ok.txt', 'v2\n');
    lab.svn(['commit', '-q', '-m', 'hint ok remote'], other);
    const targetRev = headRevision();
    const prepared = await prepareHistoryUpdate('svn', wc, 'hu-hint-ok.txt', targetRev);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }

    const result = await runHistoryUpdate('svn', prepared.intent);
    expect(result.outcome).toBe('updated');
    expect(result.postNodeRevision).toBe(targetRev);
    expect(result.outputHint).toEqual({ finalRevision: targetRev, conflicts: [] });
  });

  it('输出线索与回读不一致：仍以回读为准（outcome/postNodeRevision 不随输出改写）', async () => {
    const baseRev = seedFile('hu-hint-mismatch.txt');
    const wc = lab.checkout('hu-hint-mismatch');
    lab.svn(['update', '-q', '-r', String(baseRev)], wc);
    const other = lab.checkout('hu-hint-mismatch-other');
    writeFile(other, 'hu-hint-mismatch.txt', 'v2\n');
    lab.svn(['commit', '-q', '-m', 'hint mismatch remote'], other);
    const targetRev = headRevision();
    const prepared = await prepareHistoryUpdate('svn', wc, 'hu-hint-mismatch.txt', targetRev);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }

    const hinted = createHintedUpdateSvn();
    const result = await runHistoryUpdate(hinted, prepared.intent);
    // 命令成功且回读等于请求值：结算 updated，不采用被改写的 999。
    expect(result.outcome).toBe('updated');
    expect(result.postNodeRevision).toBe(targetRev);
    expect(result.outputHint?.finalRevision).toBe(999);
    // 回读仍读到请求 revision 的实际内容。
    expect(readFileSync(join(wc, 'hu-hint-mismatch.txt'), 'utf8')).toBe('v2\n');
  });

  it('进程级失败：没有命令结果时不产生 outputHint（不伪造线索）', async () => {
    const intent: HistoryUpdateIntent = {
      wcRoot: '/nonexistent',
      targetRelPath: 'x.txt',
      targetKind: 'file',
      targetUrl: 'file:///nonexistent/x.txt',
      requestedRevision: 1,
      preRevision: 1,
    };
    const result = await runHistoryUpdate('definitely-not-a-svn-binary', intent);
    expect(result.outcome).toBe('unknown');
    expect(result.outputHint).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------
 * unknown 结算：命令成功（exit 0）但回读与请求不一致
 * ------------------------------------------------------------------------- */

/**
 * wrapper：把 update 的 `-r <任意值>` 改写为固定 revision 后正常执行，
 * 模拟外部 SVN 客户端并发写入导致实际停留的 BASE 与请求值不同。
 */
function createRewrittenRevisionSvn(forcedRevision: number): string {
  const realSvn = execFileSync('which', ['svn'], { encoding: 'utf8' }).trim();
  const wrapper = join(lab.root, `svn-update-rewrite-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.sh`);
  writeFileSync(wrapper, [
    '#!/bin/bash',
    'out=()',
    'skip=0',
    'for a in "$@"; do',
    '  if [ "$skip" = "1" ]; then out+=("REV"); skip=0; continue; fi',
    '  if [ "$a" = "-r" ]; then out+=("-r"); skip=1; continue; fi',
    '  out+=("$a")',
    'done',
    `exec "${realSvn}" "\${out[@]}"`,
    '',
  ].join('\n').replace('REV', String(forcedRevision)));
  chmodSync(wrapper, 0o755);
  return wrapper;
}

describe('unknown 结算：命令成功但回读不一致', () => {
  it('命令 exit 0 但回读 revision 与请求不一致（外部并发写入）→ unknown，postNodeRevision 为实际回读值', async () => {
    const baseRev = seedFile('hu-p210-rev.txt');
    const wc = lab.checkout('hu-p210-rev');
    lab.svn(['update', '-q', '-r', String(baseRev)], wc);
    const other = lab.checkout('hu-p210-rev-other');
    writeFile(other, 'hu-p210-rev.txt', 'v2\n');
    lab.svn(['commit', '-q', '-m', 'p210 remote'], other);
    const targetRev = headRevision();
    const prepared = await prepareHistoryUpdate('svn', wc, 'hu-p210-rev.txt', targetRev);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    expect(prepared.intent.preRevision).toBe(baseRev);

    const wrapper = createRewrittenRevisionSvn(prepared.intent.preRevision);
    const result = await runHistoryUpdate(wrapper, prepared.intent);
    // 命令本身成功（无 commandError），但回读 revision ≠ 请求 → 保持 unknown。
    expect(result.commandError).toBeUndefined();
    expect(result.outcome).toBe('unknown');
    expect(result.postNodeRevision).toBe(prepared.intent.preRevision);
    // 输出线索如实保留命令输出的 final revision（同样是旧值），仅供交叉核对。
    expect(result.outputHint?.finalRevision).toBe(prepared.intent.preRevision);
  });

  it('命令成功但回读节点 URL 与固定意图不一致 → unknown', async () => {
    const baseRev = seedFile('hu-p210-url.txt');
    seedFile('hu-p210-url-other.txt');
    const wc = lab.checkout('hu-p210-url');
    lab.svn(['update', '-q', '-r', String(baseRev)], wc);
    const targetRev = headRevision();
    const prepared = await prepareHistoryUpdate('svn', wc, 'hu-p210-url.txt', targetRev);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    const result = await runHistoryUpdate('svn', {
      ...prepared.intent,
      // 固定意图里的节点 URL 指向另一节点：命令照常更新，但身份核对不符。
      targetUrl: `${lab.repoUrl}/hu-p210-url-other.txt`,
    });
    expect(result.outcome).toBe('unknown');
    expect(result.postNodeRevision).toBe(targetRev);
  });

  it('命令成功但回读节点 kind 与固定意图不一致 → unknown', async () => {
    const baseRev = seedFile('hu-p210-kind.txt');
    const wc = lab.checkout('hu-p210-kind');
    lab.svn(['update', '-q', '-r', String(baseRev)], wc);
    const targetRev = headRevision();
    const prepared = await prepareHistoryUpdate('svn', wc, 'hu-p210-kind.txt', targetRev);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    const result = await runHistoryUpdate('svn', {
      ...prepared.intent,
      targetKind: 'dir',
    });
    expect(result.outcome).toBe('unknown');
    expect(result.postNodeRevision).toBe(targetRev);
  });
});

/* ---------------------------------------------------------------------------
 * 写前检查安全门禁：除 modified/属性 modified 外的全部阻断项
 * ------------------------------------------------------------------------- */

/** 在共享仓库提交写前门禁基线目录 hu-gate/*，返回该提交 revision（只提交一次）。 */
let gateBaseRevision: number | undefined;
function seedGateDir(): number {
  if (gateBaseRevision !== undefined) {
    return gateBaseRevision;
  }
  const seeder = lab.checkout(`hu-gate-seed-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
  writeFile(seeder, 'hu-gate/del.txt', 'del\n', true);
  writeFile(seeder, 'hu-gate/missing.txt', 'missing\n', true);
  writeFile(seeder, 'hu-gate/replaced.txt', 'replaced\n', true);
  writeFile(seeder, 'hu-gate/conflict.txt', 'conflict base\n', true);
  lab.svn(['commit', '-q', '-m', 'gate seed'], seeder);
  gateBaseRevision = headRevision();
  return gateBaseRevision;
}

/** 检出工作副本并把 hu-gate 目录目标准备成固定意图。 */
async function prepareGateIntent(name: string, baseRev: number): Promise<HistoryUpdateIntent> {
  const wc = lab.checkout(name);
  const prepared = await prepareHistoryUpdate('svn', wc, 'hu-gate', baseRev);
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) {
    throw new Error(`prepare 意外失败：${prepared.reason}`);
  }
  return prepared.intent;
}

/** 生成按子命令伪造输出的 svn wrapper（status 等），其余转发真实 svn。 */
function createCommandWrapper(name: string, lines: string[]): string {
  const realSvn = execFileSync('which', ['svn'], { encoding: 'utf8' }).trim();
  const wrapper = join(lab.root, `${name}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.sh`);
  writeFileSync(wrapper, `#!/bin/bash\n${lines.join('\n')}\nexec "${realSvn}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

describe('写前检查安全门禁：全部阻断状态', () => {
  it('added/deleted/missing/replaced 逐项阻断 local-modifications', async () => {
    const baseRev = seedGateDir();
    const scenarios: Array<{
      name: string;
      mutate(wc: string): void;
      expectedStatus: string;
      expectedPath: string;
    }> = [
      {
        name: 'hu-gate-added',
        mutate: (wc) => writeFile(wc, 'hu-gate/added.txt', 'a\n', true),
        expectedStatus: 'added',
        expectedPath: 'hu-gate/added.txt',
      },
      {
        name: 'hu-gate-deleted',
        mutate: (wc) => lab.svn(['delete', '-q', 'hu-gate/del.txt'], wc),
        expectedStatus: 'deleted',
        expectedPath: 'hu-gate/del.txt',
      },
      {
        name: 'hu-gate-missing',
        mutate: (wc) => rmSync(join(wc, 'hu-gate/missing.txt')),
        expectedStatus: 'missing',
        expectedPath: 'hu-gate/missing.txt',
      },
      {
        name: 'hu-gate-replaced',
        mutate: (wc) => {
          lab.svn(['delete', '-q', 'hu-gate/replaced.txt'], wc);
          writeFile(wc, 'hu-gate/replaced.txt', 'new\n');
          lab.svn(['add', '-q', 'hu-gate/replaced.txt'], wc);
        },
        expectedStatus: 'replaced',
        expectedPath: 'hu-gate/replaced.txt',
      },
    ];
    for (const scenario of scenarios) {
      const intent = await prepareGateIntent(scenario.name, baseRev);
      // 基线干净，确保阻断确实由构造的状态触发。
      expect(await checkHistoryUpdatePreconditions('svn', intent), scenario.name).toEqual({ ok: true });
      scenario.mutate(intent.wcRoot);
      const result = await checkHistoryUpdatePreconditions('svn', intent);
      expect(result.ok, scenario.name).toBe(false);
      expect(result.reason, scenario.name).toBe('local-modifications');
      const entry = result.blocking?.find((candidate) => candidate.path === scenario.expectedPath);
      expect(entry, scenario.name).toBeDefined();
      expect(entry?.wcStatus, scenario.name).toBe(scenario.expectedStatus);
      // message 仅原始输出/缺省，不含中文叙述。
      expect(result.message ?? '', scenario.name).not.toMatch(/[一-鿿]/);
    }
  });

  it('conflicted 与树冲突（本地编辑 vs 传入删除）分别阻断', async () => {
    const baseRev = seedGateDir();

    // 文本冲突：本地修改 + 远端修改后 update。
    const conflictIntent = await prepareGateIntent('hu-gate-conflict', baseRev);
    const other = lab.checkout('hu-gate-conflict-other');
    writeFile(other, 'hu-gate/conflict.txt', 'remote v\n');
    lab.svn(['commit', '-q', '-m', 'gate conflict remote'], other);
    writeFile(conflictIntent.wcRoot, 'hu-gate/conflict.txt', 'local v\n');
    lab.svn(['update', '-q'], conflictIntent.wcRoot);
    const conflicted = await checkHistoryUpdatePreconditions('svn', conflictIntent);
    expect(conflicted).toMatchObject({ ok: false, reason: 'local-modifications' });
    expect(conflicted.blocking?.map((entry) => entry.wcStatus)).toContain('conflicted');

    // 树冲突：本地编辑 vs 传入删除（复用 conflict 测试域的构造）。
    const treeIntent = await prepareGateIntent('hu-gate-tree', baseRev);
    const otherTree = lab.checkout('hu-gate-tree-other');
    lab.svn(['rm', '-q', 'hu-gate/conflict.txt'], otherTree);
    lab.svn(['commit', '-q', '-m', 'gate tree remote delete'], otherTree);
    writeFile(treeIntent.wcRoot, 'hu-gate/conflict.txt', 'local edit\n');
    lab.svn(['update', '-q'], treeIntent.wcRoot);
    const tree = await checkHistoryUpdatePreconditions('svn', treeIntent);
    expect(tree).toMatchObject({ ok: false, reason: 'local-modifications' });
    expect(tree.blocking?.map((entry) => entry.path)).toContain('hu-gate/conflict.txt');
  });

  it('status 读取失败（exit 非零 / XML 截断）按 info-error 阻止，不产生可发写命令的意图', async () => {
    const baseRev = seedGateDir();
    const intent = await prepareGateIntent('hu-gate-status-fail', baseRev);

    // exit 非零：原始 stderr 作为 detail 透传。
    const failWrapper = createCommandWrapper('svn-gate-status-fail', [
      'if [ "$1" = "status" ]; then',
      '  echo \'svn: E155007: /path is not a working copy\' >&2',
      '  exit 1',
      'fi',
    ]);
    const failed = await checkHistoryUpdatePreconditions(failWrapper, intent);
    expect(failed).toMatchObject({ ok: false, reason: 'info-error' });
    expect(failed.message).toContain('E155007');
    expect(failed.message ?? '').not.toMatch(/[一-鿿]/);

    // exit 0 但 XML 截断：解析残片失败按 info-error，不返回中文句子。
    const truncatedWrapper = createCommandWrapper('svn-gate-status-truncated', [
      'if [ "$1" = "status" ]; then',
      '  printf \'<status>\'',
      '  exit 0',
      'fi',
    ]);
    const truncated = await checkHistoryUpdatePreconditions(truncatedWrapper, intent);
    expect(truncated).toEqual({ ok: false, reason: 'info-error' });
  });
});

/* ---------------------------------------------------------------------------
 * core 不返回面向用户的中文句子
 * ------------------------------------------------------------------------- */

describe('失败分支只给 reason 与原始输出', () => {
  it('prepare 的 info 缺 URL / 缺 revision 分支不带叙述性中文 message', async () => {
    const baseRev = seedFile('hu-p214.txt');
    const wc = lab.checkout('hu-p214');
    lab.svn(['update', '-q', '-r', String(baseRev)], wc);

    const noUrlWrapper = createCommandWrapper('svn-p214-no-url', [
      'if [ "$1" = "info" ]; then',
      '  printf \'<?xml version="1.0"?><info><entry kind="file" path="x" revision="3"><relative-url>^/x</relative-url></entry></info>\'',
      '  exit 0',
      'fi',
    ]);
    expect(await prepareHistoryUpdate(noUrlWrapper, wc, 'hu-p214.txt', baseRev)).toEqual({
      ok: false,
      reason: 'info-error',
    });

    const noRevisionWrapper = createCommandWrapper('svn-p214-no-revision', [
      'if [ "$1" = "info" ]; then',
      '  printf \'<?xml version="1.0"?><info><entry kind="file" path="x"><url>file:///x</url></entry></info>\'',
      '  exit 0',
      'fi',
    ]);
    expect(await prepareHistoryUpdate(noRevisionWrapper, wc, 'hu-p214.txt', baseRev)).toEqual({
      ok: false,
      reason: 'not-versioned',
    });
  });

  it('目标检查的空骨架分支只给 target-absent-at-revision，不带中文 message', async () => {
    const baseRev = seedFile('hu-p214-target.txt');
    const wc = lab.checkout('hu-p214-target');
    const prepared = await prepareHistoryUpdate('svn', wc, 'hu-p214-target.txt', baseRev);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    const emptyWrapper = createCommandWrapper('svn-p214-empty-info', [
      'if [ "$1" = "info" ]; then',
      '  printf \'<?xml version="1.0"?><info></info>\'',
      '  exit 0',
      'fi',
    ]);
    expect(await checkHistoryUpdatePreconditions(emptyWrapper, prepared.intent)).toEqual({
      ok: false,
      reason: 'target-absent-at-revision',
    });
  });
});

/* ---------------------------------------------------------------------------
 * 目标存在性检查走统一认证补录原语（runOrThrow）
 * ------------------------------------------------------------------------- */

describe('checkTargetAtRevision 认证补录', () => {
  const authScope = { scheme: 'http' as const, host: 'example.com', port: 80 };

  /**
   * wrapper：首次 `info`（无凭据）报 E170001 认证失败；带
   * --username/--password 的重试返回合法 info XML。status 直接返回空骨架。
   */
  function createAuthWrapper(name: string): string {
    return createCommandWrapper(name, [
      'if [ "$1" = "info" ]; then',
      '  case " $* " in',
      '    *" --username "*)',
      '      printf \'<?xml version="1.0"?><info><entry kind="file" path="hu-auth-retry.txt" revision="5"><url>file:///repo/hu-auth-retry.txt</url></entry></info>\'',
      '      exit 0',
      '      ;;',
      '    *)',
      '      echo \'svn: E170001: Authentication failed\' >&2',
      '      exit 1',
      '      ;;',
      '  esac',
      'fi',
      'if [ "$1" = "status" ]; then',
      '  printf \'<?xml version="1.0"?><status><target path="."></target></status>\'',
      '  exit 0',
      'fi',
      'exit 1',
    ]);
  }

  function makeIntent(wcRoot: string): HistoryUpdateIntent {
    return {
      wcRoot,
      targetRelPath: 'hu-auth-retry.txt',
      targetKind: 'file',
      targetUrl: 'file:///repo/hu-auth-retry.txt',
      requestedRevision: 5,
      preRevision: 4,
    };
  }

  it('首次 info 认证错误 → 补录凭据 → 重试通过（认证失败不冒充目标缺失）', async () => {
    const wc = lab.checkout('hu-auth-retry');
    writeFile(wc, 'hu-auth-retry.txt', 'x\n', true);
    const wrapper = createAuthWrapper('svn-hu-auth-retry');
    const scopes: unknown[] = [];
    const result = await checkHistoryUpdatePreconditions(wrapper, makeIntent(wc), {
      authScope,
      getCredentials: async (scope) => {
        scopes.push(scope);
        return { username: 'u', password: 'p' };
      },
    });
    // 补录只弹一次，作用域原样透传；重试成功后写前检查整体通过。
    expect(scopes).toEqual([authScope]);
    expect(result).toEqual({ ok: true });
  });

  it('补录取消：保持 info-error 并透传认证原始输出，不进入 absent 判定', async () => {
    const wc = lab.checkout('hu-auth-retry-cancel');
    writeFile(wc, 'hu-auth-retry.txt', 'x\n', true);
    const wrapper = createAuthWrapper('svn-hu-auth-retry-cancel');
    const result = await checkHistoryUpdatePreconditions(wrapper, makeIntent(wc), {
      authScope,
      getCredentials: async () => undefined,
    });
    expect(result).toMatchObject({ ok: false, reason: 'info-error' });
    expect(result.message).toContain('E170001');
  });
});
