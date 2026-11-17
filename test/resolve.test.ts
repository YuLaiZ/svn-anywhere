/**
 * resolve 动作矩阵、计划与回扫测试：
 * - 纯逻辑覆盖六值枚举、postpone 不入 CLI、二进制 base/块变体拒绝、
 *   混合路径禁止单选择、属性逐项选择与 working 二次确认；
 * - 集成用例走本地 file:// 副本：命令前指纹、命令后 status+info 联合回读、
 *   resolve 静默 exit 0 不当作成功、外部删除后的异常判定。
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  readConflictRecord,
  type ConflictKind,
  type ConflictRecord,
  type PropertyConflictValue,
  type PropertyValue,
} from '../src/core/conflict';
import {
  SVN_ACCEPT_VALUES,
  availableResolveActions,
  buildResolveArgs,
  executeResolve,
  isAnomalousResolveStatus,
  planResolve,
  verifyResolveOutcome,
} from '../src/core/resolve';
import { run } from '../src/core/svnCli';
import { createSvnLab, writeFile } from './helpers';

const lab = createSvnLab('svn-anywhere-resolve-');
afterAll(() => lab.cleanup());

function fakeRecord(
  path: string,
  kinds: ConflictKind[],
  extra: Partial<ConflictRecord> = {},
): ConflictRecord {
  return {
    id: `fingerprint:${path}:${kinds.join(',')}`,
    path,
    kinds,
    contentKind: 'text',
    artifacts: [],
    ...extra,
  };
}

function propertyValue(value: string | undefined): PropertyValue {
  return value === undefined ? { exists: false } : { exists: true, value: Buffer.from(value) };
}

function propertyConflict(
  name: string,
  local: string | undefined,
  base: string | undefined,
  incoming: string | undefined,
  autoUnsupported = false,
): PropertyConflictValue {
  return {
    name,
    local: propertyValue(local),
    base: propertyValue(base),
    incoming: propertyValue(incoming),
    autoUnsupported,
  };
}

describe('svn resolve 参数纪律', () => {
  it('六个合法 --accept 值；postpone 不在枚举内', () => {
    expect(SVN_ACCEPT_VALUES).toEqual(['base', 'working', 'mine-conflict', 'theirs-conflict', 'mine-full', 'theirs-full']);
    expect((SVN_ACCEPT_VALUES as readonly string[]).includes('postpone')).toBe(false);
  });

  it('resolve 步固定 --non-interactive --depth empty；propset 值走临时文件参数', () => {
    expect(buildResolveArgs({ kind: 'resolve', relPath: 'a.txt', accept: 'theirs-full' })).toEqual([
      'resolve',
      '--non-interactive',
      '--accept',
      'theirs-full',
      '--depth',
      'empty',
      '--',
      'a.txt',
    ]);
    // 含 @ 的路径尾部补 peg 转义（escapePeg 契约）。
    expect(buildResolveArgs({ kind: 'resolve', relPath: 'at@2.txt', accept: 'working' })).toContain('at@2.txt@');
    expect(buildResolveArgs({ kind: 'propset', relPath: 'p.txt', name: 'k', value: Buffer.from('v') }, '/tmp/v')).toEqual([
      'propset',
      '-q',
      'k',
      '-F',
      '/tmp/v',
      '--',
      'p.txt',
    ]);
    expect(buildResolveArgs({ kind: 'propdel', relPath: 'p.txt', name: 'k' })).toEqual([
      'propdel',
      '-q',
      'k',
      '--',
      'p.txt',
    ]);
  });
});

/* ---------------------------------------------------------------------------
 * 命令后回扫的异常 status 集合
 * ------------------------------------------------------------------------- */

describe('isAnomalousResolveStatus 异常集合', () => {
  it('missing/obstructed/incomplete 与 deleted(非树) 为异常；deleted(树) 与普通项不报', () => {
    for (const item of ['missing', 'obstructed', 'incomplete']) {
      expect(isAnomalousResolveStatus(item, ['text']), item).toBe(true);
      expect(isAnomalousResolveStatus(item, ['property']), item).toBe(true);
    }
    expect(isAnomalousResolveStatus('deleted', ['text'])).toBe(true);
    expect(isAnomalousResolveStatus('deleted', ['property'])).toBe(true);
    // 树冲突 working 的预期结果可以是保留 D。
    expect(isAnomalousResolveStatus('deleted', ['tree'])).toBe(false);
    expect(isAnomalousResolveStatus('modified', ['text'])).toBe(false);
    expect(isAnomalousResolveStatus('normal', [])).toBe(false);
    expect(isAnomalousResolveStatus(undefined, [])).toBe(false);
  });
});

describe('availableResolveActions 动作矩阵', () => {
  it('纯文本：六值可用，working 需人工确认', () => {
    const actions = availableResolveActions(fakeRecord('a.txt', ['text'], { contentKind: 'text' }));
    expect(actions.strategies).toEqual([...SVN_ACCEPT_VALUES]);
    expect(actions.workingRequiresConfirmation).toBe(true);
    expect(actions.blocker).toBeUndefined();
  });

  it('二进制：只留 mine-full/theirs-full/working，禁用 base 与冲突块变体', () => {
    const actions = availableResolveActions(fakeRecord('b.bin', ['text'], { contentKind: 'binary' }));
    expect(actions.strategies).toEqual(['working', 'mine-full', 'theirs-full']);
    expect(actions.workingRequiresConfirmation).toBe(true);
  });

  it('类型不确定：无自动动作', () => {
    expect(availableResolveActions(fakeRecord('u.bin', ['text'], { contentKind: 'unknown' }))).toMatchObject({
      strategies: [],
      blocker: 'unknown-content',
    });
  });

  it('纯属性：逐项选择；三值缺失或含保留属性时不可自动处理', () => {
    const withValues = fakeRecord('p.txt', ['property'], {
      propertyConflicts: [propertyConflict('k', 'l', 'b', 'i')],
    });
    expect(availableResolveActions(withValues)).toMatchObject({ strategies: [], propertySelection: true });
    expect(availableResolveActions(fakeRecord('p.txt', ['property']))).toMatchObject({ blocker: 'property-values-unavailable' });
    const reserved = fakeRecord('p.txt', ['property'], {
      propertyConflicts: [propertyConflict('svn:mergeinfo', 'l', 'b', 'i', true)],
    });
    expect(availableResolveActions(reserved)).toMatchObject({ blocker: 'property-auto-unsupported' });
  });

  it('纯树：只有 working（确认后）或推迟；混合路径无自动动作', () => {
    const tree = fakeRecord('t', ['tree'], {
      treeConflict: { operation: 'update', kind: 'file', reason: 'edit', action: 'delete', victim: 't' },
    });
    expect(availableResolveActions(tree)).toMatchObject({
      strategies: ['working'],
      treeConfirmation: true,
      workingRequiresConfirmation: true,
    });
    expect(availableResolveActions(fakeRecord('m', ['text', 'property']))).toMatchObject({ blocker: 'mixed-path' });
    expect(availableResolveActions(fakeRecord('t', ['tree']))).toMatchObject({ blocker: 'unknown-content' });
  });
});

describe('planResolve 拒绝矩阵', () => {
  const text = fakeRecord('a.txt', ['text'], { contentKind: 'text' });
  const binary = fakeRecord('b.bin', ['text'], { contentKind: 'binary' });
  const tree = fakeRecord('t', ['tree'], {
    treeConflict: { operation: 'update', kind: 'file', reason: 'edit', action: 'delete', victim: 't' },
  });

  it('postpone 不在 CLI 枚举，直接拒绝', () => {
    expect(planResolve(text, { kind: 'postpone' })).toEqual({ ok: false, reason: 'postpone-not-cli' });
  });

  it('混合路径拒绝一切单选择（含 working），交人工交互后回扫', () => {
    const mixed = fakeRecord('m.txt', ['text', 'property'], {
      propertyConflicts: [propertyConflict('k', 'l', 'b', 'i')],
    });
    expect(planResolve(mixed, { kind: 'accept', value: 'theirs-full' })).toEqual({ ok: false, reason: 'mixed-path' });
    expect(planResolve(mixed, { kind: 'working', confirmed: true })).toEqual({ ok: false, reason: 'mixed-path' });
    expect(planResolve(mixed, { kind: 'property', choices: [{ name: 'k', choice: 'base' }] })).toEqual({ ok: false, reason: 'mixed-path' });
  });

  it('二进制 base 应用层拒绝；mine-conflict/theirs-conflict 为不适用选项', () => {
    expect(planResolve(binary, { kind: 'accept', value: 'base' })).toEqual({ ok: false, reason: 'binary-base' });
    expect(planResolve(binary, { kind: 'accept', value: 'mine-conflict' })).toEqual({ ok: false, reason: 'binary-block-variant' });
    expect(planResolve(binary, { kind: 'accept', value: 'theirs-conflict' })).toEqual({ ok: false, reason: 'binary-block-variant' });
    expect(planResolve(binary, { kind: 'accept', value: 'theirs-full' })).toEqual({
      ok: true,
      steps: [{ kind: 'resolve', relPath: 'b.bin', accept: 'theirs-full' }],
    });
  });

  it('working 与树确认都需要二次确认', () => {
    expect(planResolve(text, { kind: 'working', confirmed: false })).toEqual({ ok: false, reason: 'working-requires-confirmation' });
    expect(planResolve(text, { kind: 'accept', value: 'working' })).toEqual({ ok: false, reason: 'working-requires-confirmation' });
    expect(planResolve(text, { kind: 'working', confirmed: true })).toEqual({
      ok: true,
      steps: [{ kind: 'resolve', relPath: 'a.txt', accept: 'working' }],
    });
    expect(planResolve(tree, { kind: 'accept', value: 'mine-full' })).toEqual({ ok: false, reason: 'tree-invalid-strategy' });
    expect(planResolve(tree, { kind: 'working', confirmed: false })).toEqual({ ok: false, reason: 'tree-requires-confirmation' });
    expect(planResolve(tree, { kind: 'working', confirmed: true })).toMatchObject({ ok: true });
  });

  it('属性冲突不允许整值 accept；逐项选择生成写回步骤后统一 working', () => {
    const record = fakeRecord('p.txt', ['property'], {
      propertyConflicts: [
        propertyConflict('a', 'local-a', 'base-a', 'incoming-a'),
        propertyConflict('b', 'local-b', undefined, undefined),
      ],
    });
    expect(planResolve(record, { kind: 'accept', value: 'theirs-full' })).toEqual({ ok: false, reason: 'property-requires-selection' });
    expect(planResolve(record, { kind: 'property', choices: [{ name: 'a', choice: 'incoming' }] })).toEqual({
      ok: false,
      reason: 'property-incomplete',
    });
    expect(planResolve(record, { kind: 'property', choices: [
      { name: 'a', choice: 'incoming' },
      { name: 'b', choice: 'local' },
      { name: 'ghost', choice: 'base' },
    ] })).toEqual({ ok: false, reason: 'property-incomplete' });

    const plan = planResolve(record, {
      kind: 'property',
      choices: [
        { name: 'a', choice: 'incoming' },
        { name: 'b', choice: 'local' },
      ],
    });
    expect(plan).toEqual({
      ok: true,
      steps: [
        { kind: 'propset', relPath: 'p.txt', name: 'a', value: Buffer.from('incoming-a') },
        { kind: 'resolve', relPath: 'p.txt', accept: 'working' },
      ],
    });
  });

  it('选择基线与传入值缺失时生成 propdel；保留属性不可选择', () => {
    const record = fakeRecord('p.txt', ['property'], {
      propertyConflicts: [
        propertyConflict('gone', 'local', 'base', undefined),
        propertyConflict('restored', 'local', undefined, 'incoming'),
      ],
    });
    expect(planResolve(record, {
      kind: 'property',
      choices: [
        { name: 'gone', choice: 'incoming' },
        { name: 'restored', choice: 'base' },
      ],
    })).toEqual({
      ok: true,
      steps: [
        { kind: 'propdel', relPath: 'p.txt', name: 'gone' },
        { kind: 'propdel', relPath: 'p.txt', name: 'restored' },
        { kind: 'resolve', relPath: 'p.txt', accept: 'working' },
      ],
    });
    const reserved = fakeRecord('p.txt', ['property'], {
      propertyConflicts: [propertyConflict('svn:ignore', 'l', 'b', 'i', true)],
    });
    expect(planResolve(reserved, { kind: 'property', choices: [{ name: 'svn:ignore', choice: 'base' }] })).toEqual({
      ok: false,
      reason: 'property-auto-unsupported',
    });
  });

  it('对非属性记录传属性选择、非法 accept 值与未知内容均拒绝', () => {
    expect(planResolve(text, { kind: 'property', choices: [] })).toEqual({ ok: false, reason: 'property-not-applicable' });
    expect(planResolve(text, { kind: 'accept', value: 'postpone' as never })).toEqual({ ok: false, reason: 'invalid-accept' });
    expect(planResolve(fakeRecord('u', ['text'], { contentKind: 'unknown' }), { kind: 'accept', value: 'theirs-full' })).toEqual({ ok: false, reason: 'unknown-content' });
  });
});

/* ------------------------------------------------------------------ *
 * 集成：命令前指纹 + 命令后回读
 * ------------------------------------------------------------------ */

function makeTextConflict(name: string, relPath = `${name}.txt`): string {
  const base = lab.checkout(name);
  writeFile(base, relPath, 'line1\n', true);
  lab.svn(['commit', '-q', '-m', 'resolve base'], base);
  const other = lab.checkout(`${name}-other`);
  writeFile(other, relPath, 'line1\nremote\n');
  lab.svn(['commit', '-q', '-m', 'resolve remote'], other);
  writeFile(base, relPath, 'line1\nlocal\n');
  lab.svn(['update', '-q'], base);
  return base;
}

/** 生成仅拦截指定子命令的 svn wrapper（其余命令转真实 svn）。 */
function writeWrapper(name: string, lines: string[]): string {
  const realSvn = execFileSync('which', ['svn'], { encoding: 'utf8' }).trim();
  const file = join(lab.root, name);
  writeFileSync(file, `#!/bin/bash\n${lines.join('\n').replaceAll('__REAL_SVN__', realSvn)}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe('executeResolve 集成（本地 file:// 副本）', () => {
  it('working 未确认被拒绝且不发写命令；确认后回读 resolved、辅助文件清除', async () => {
    const wc = makeTextConflict('res-text');
    const rel = 'res-text.txt';
    const before = await readConflictRecord('svn', wc, rel);
    expect(before.record?.kinds).toEqual(['text']);
    // 分类结果由宿主注入（扫描默认不探测内容类型）；文本冲突需显式标注。
    const record = { ...before.record!, contentKind: 'text' as const };

    const rejected = await executeResolve('svn', wc, {
      record,
      selection: { kind: 'working', confirmed: false },
    });
    expect(rejected.outcome).toBe('rejected');
    expect(rejected.reason).toBe('working-requires-confirmation');
    expect((await readConflictRecord('svn', wc, rel)).record).toBeDefined();

    const done = await executeResolve('svn', wc, {
      record,
      selection: { kind: 'working', confirmed: true },
    });
    expect(done.outcome).toBe('resolved');
    expect(done.verification?.outcome).toBe('resolved');
    expect(existsSync(join(wc, `${rel}.mine`))).toBe(false);
    expect(existsSync(join(wc, `${rel}.r1`))).toBe(false);
    // resolve 后工作文件保留冲突标记（working 的语义；cat 读 BASE，须读工作文件）。
    expect(readFileSync(join(wc, rel), 'utf8')).toContain('<<<<<<<');
  });

  it('已解决后再按旧计划执行：命令前指纹发现无冲突，拒绝空动作', async () => {
    const wc = makeTextConflict('res-stale');
    const rel = 'res-stale.txt';
    const record = { ...(await readConflictRecord('svn', wc, rel)).record!, contentKind: 'text' as const };
    // 外部客户端先解决（跳过应用层）。
    lab.svn(['resolve', '--non-interactive', '--accept', 'theirs-full', '--depth', 'empty', rel], wc);
    const result = await executeResolve('svn', wc, {
      record,
      selection: { kind: 'working', confirmed: true },
    });
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'conflict-not-found' });
  });

  it('resolve 对非冲突路径静默 exit 0；应用层不得据此宣称成功', async () => {
    const wc = lab.checkout('res-silent');
    writeFile(wc, 'silent.txt', 'v1\n', true);
    lab.svn(['commit', '-q', '-m', 'silent base'], wc);
    const raw = await run('svn', ['resolve', '--non-interactive', '--accept', 'working', '--depth', 'empty', '--', 'silent.txt'], { cwd: wc });
    expect(raw.exitCode).toBe(0);
    expect(raw.stdout).toBe('');
    const stale = fakeRecord('silent.txt', ['text']);
    const guarded = await executeResolve('svn', wc, { record: stale, selection: { kind: 'working', confirmed: true } });
    expect(guarded).toMatchObject({ outcome: 'rejected', reason: 'conflict-not-found' });
  });

  it('resolve 成功后外部删除路径：status+info 联合回读判 anomalous', async () => {
    const wc = makeTextConflict('res-anomalous');
    const rel = 'res-anomalous.txt';
    const record = { ...(await readConflictRecord('svn', wc, rel)).record!, contentKind: 'text' as const };
    const done = await executeResolve('svn', wc, { record, selection: { kind: 'working', confirmed: true } });
    expect(done.outcome).toBe('resolved');
    rmSync(join(wc, rel));
    const verification = await verifyResolveOutcome('svn', wc, rel, { previousKinds: ['text'] });
    expect(verification.outcome).toBe('anomalous');
    expect(verification.statusItem).toBe('missing');
  });

  it('resolve 成功后版本化文件被同名目录替换（obstructed）：判 anomalous，不宣称已解决', async () => {
    // 核验场景（SVN 1.15 file:// 实测）：resolve --accept working
    // 后把版本化文件换成同名目录，status 输出 item="obstructed"、info
    // exit 0 且无 <conflict> 节点；旧判定只认 missing/deleted，会被当作
    // 已解决并写台账。修复后 obstructed 归 anomalous。
    const wc = makeTextConflict('res-obstructed');
    const rel = 'res-obstructed.txt';
    const record = { ...(await readConflictRecord('svn', wc, rel)).record!, contentKind: 'text' as const };
    const done = await executeResolve('svn', wc, { record, selection: { kind: 'working', confirmed: true } });
    expect(done.outcome).toBe('resolved');
    rmSync(join(wc, rel));
    mkdirSync(join(wc, rel));
    const verification = await verifyResolveOutcome('svn', wc, rel, { previousKinds: ['text'] });
    expect(verification.outcome).toBe('anomalous');
    expect(verification.statusItem).toBe('obstructed');
  });

  it('status 非零退出且 stderr 为空：unknown 且 detail 为英文技术诊断', async () => {
    const wc = makeTextConflict('res-silent-status');
    const rel = 'res-silent-status.txt';
    const wrapper = writeWrapper('svn-status-silent-fail.sh', [
      'if [ "$1" = "status" ]; then',
      '  exit 3',
      'fi',
      'exec "__REAL_SVN__" "$@"',
    ]);
    const verification = await verifyResolveOutcome(wrapper, wc, rel, { previousKinds: ['text'] });
    expect(verification.outcome).toBe('unknown');
    expect((verification as { detail?: string }).detail).toBe('svn status exit code 3');
    expect((verification as { detail?: string }).detail).not.toMatch(/[一-鿿]/);
  });

  it('属性冲突：逐项选择写回后 working，propertyConflicts 三值来自 source-left/right', async () => {
    const wc = lab.checkout('res-prop');
    writeFile(wc, 'prop.txt', 'v1\n', true);
    lab.svn(['propset', '-q', 'k', 'base', 'prop.txt'], wc);
    lab.svn(['commit', '-q', '-m', 'prop base'], wc);
    const other = lab.checkout('res-prop-other');
    lab.svn(['propset', '-q', 'k', 'theirs', 'prop.txt'], other);
    lab.svn(['commit', '-q', '-m', 'prop remote'], other);
    lab.svn(['propset', '-q', 'k', 'local', 'prop.txt'], wc);
    lab.svn(['update', '-q'], wc);

    const record = (await readConflictRecord('svn', wc, 'prop.txt')).record!;
    expect(record.kinds).toEqual(['property']);
    expect(record.propertyConflicts?.map((property) => property.name)).toEqual(['k']);
    expect(record.propertyConflicts?.[0]).toMatchObject({
      local: { exists: true },
      base: { exists: true },
      incoming: { exists: true },
      autoUnsupported: false,
    });
    const plan = await executeResolve('svn', wc, {
      record,
      selection: { kind: 'property', choices: [{ name: 'k', choice: 'incoming' }] },
    });
    expect(plan.outcome).toBe('resolved');
    expect(lab.svn(['propget', 'k', 'prop.txt'], wc).trim()).toBe('theirs');
    expect((await readConflictRecord('svn', wc, 'prop.txt')).record).toBeUndefined();
  });

  it('树冲突：working 需节点确认；确认后 tree 消失并判 resolved', async () => {
    const wc = lab.checkout('res-tree');
    writeFile(wc, 'tree.txt', 'v1\n', true);
    lab.svn(['commit', '-q', '-m', 'tree base'], wc);
    const other = lab.checkout('res-tree-other');
    lab.svn(['rm', '-q', 'tree.txt'], other);
    lab.svn(['commit', '-q', '-m', 'tree remote delete'], other);
    writeFile(wc, 'tree.txt', 'local edit\n');
    lab.svn(['update', '-q'], wc);
    const record = (await readConflictRecord('svn', wc, 'tree.txt')).record!;
    expect(record.kinds).toEqual(['tree']);
    const unconfirmed = await executeResolve('svn', wc, {
      record,
      selection: { kind: 'working', confirmed: false },
    });
    expect(unconfirmed).toMatchObject({ outcome: 'rejected', reason: 'tree-requires-confirmation' });
    const done = await executeResolve('svn', wc, {
      record,
      selection: { kind: 'working', confirmed: true },
    });
    expect(done.outcome).toBe('resolved');
    const status = await run('svn', ['status', '--xml', '--ignore-externals', '--', 'tree.txt'], { cwd: wc });
    expect(status.stdout).not.toContain('tree-conflicted');
  });

  it('二进制冲突：base 在应用层被拒绝，冲突保持未解决', async () => {
    const wc = lab.checkout('res-bin');
    writeFileSync(join(wc, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
    lab.svn(['add', '-q', 'bin.dat'], wc);
    lab.svn(['commit', '-q', '-m', 'bin base'], wc);
    const other = lab.checkout('res-bin-other');
    // 已版本化文件：直接改写二进制内容后提交。
    writeFileSync(join(other, 'bin.dat'), Buffer.from([0x00, 0x09, 0x09]));
    lab.svn(['commit', '-q', '-m', 'bin remote'], other);
    writeFileSync(join(wc, 'bin.dat'), Buffer.from([0x00, 0x03, 0x03]));
    lab.svn(['update', '-q'], wc);
    const record = (await readConflictRecord('svn', wc, 'bin.dat')).record!;
    expect(record.kinds).toEqual(['text']);
    const result = await executeResolve('svn', wc, {
      record,
      selection: { kind: 'accept', value: 'base' },
      contentKind: 'binary',
    });
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'binary-base' });
    expect((await readConflictRecord('svn', wc, 'bin.dat')).record).toBeDefined();
  });
});
