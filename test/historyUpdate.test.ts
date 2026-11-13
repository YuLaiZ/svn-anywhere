/**
 * history-update 的写前检查、命令与回读测试（M4 阶段 1）：
 * - 纯逻辑覆盖固定意图、命令参数、本地存在性与非法 revision；
 * - 集成用例走本地 svnadmin + file:// 副本：更新成功/冲突/未知、复制前
 *   更新禁用、本地修改阻止、范围冲突、未知回扫三出口。
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
 * M4 阶段 6：未知回扫三出口（成功/冲突）、external 内部副本隔离
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
