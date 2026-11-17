/**
 * P7 冲突模型（conflictModel.ts）单测：
 * - 扫描结果归一化视图（tab/计数/行排序/选择裁剪）；
 * - resolvedLedger 与整副本扫描合并（真实新冲突优先、台账不参与未解决计数）；
 * - 推迟、树确认、动作矩阵（六种文本变体/二进制/属性/树/混合/批量适用性）；
 * - 详情（属性三值、辅助文件、树元数据、混合标记、已解决行）；
 * - 扫描代次、关闭重开序列化/恢复、面板状态构建；
 * - 扫描编排（真实 file:// 副本）：内容分类注入、属性三值补查与指纹
 *   一致性、认证只在远端值补查时使用、范围过滤分段判定。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  mergeResolvedLedger,
  readConflictRecord,
  summarizeConflicts,
  type ConflictRecord,
  type PropertyConflictValue,
} from '../src/core/conflict';
import { createSvnLab, writeFile, type SvnLab } from './helpers';
import { render } from '../src/host/panel/view';
import type { ActionSpec } from '../src/host/panel/state';
import { resetM4SessionStore } from '../src/host/sessionResults';
import { strings } from '../src/host/i18n';
import {
  CONFLICT_BATCH_WHOLE_VARIANTS,
  CONFLICT_TEXT_DEFAULTS,
  REJECT_TEXT_DEFAULTS,
  REJECT_TEXT_KEYS,
  ConflictModel,
  batchApplicabilityOf,
  buildConflictActionMatrix,
  buildConflictDetail,
  classifyWorkingCopyContent,
  conflictScopeOf,
  conflictText,
  createRemoteAuthorizer,
  createWorkingCopyContentClassifier,
  describePropertyValue,
  filterRecordsToConflictScope,
  persistConflictSession,
  restoreConflictSession,
  scanConflictScope,
  type ConflictScanOutcome,
  type ConflictScopeTarget,
} from '../src/host/panel/conflictModel';

/* ---------------------------------------------------------------------------
 * 构造辅助
 * ------------------------------------------------------------------------- */

let idSeq = 0;

function makeRecord(overrides: Partial<ConflictRecord> & { path: string }): ConflictRecord {
  idSeq += 1;
  const record = {
    id: overrides.id ?? `id-${overrides.path}-${idSeq}`,
    path: overrides.path,
    kinds: overrides.kinds ?? ['text'],
    contentKind: overrides.contentKind ?? 'text',
    artifacts: overrides.artifacts ?? [],
  } as ConflictRecord;
  return Object.assign(record, overrides);
}

function makeOutcome(
  records: ConflictRecord[],
  extra: Partial<ConflictScanOutcome> = {},
): ConflictScanOutcome {
  return {
    records,
    summary: summarizeConflicts(records),
    externals: [],
    wcLocked: false,
    failures: [],
    scope: { wcRoot: '/wc', scopeRelPath: '.' },
    scannedAt: 1,
    propertyValueFailures: [],
    ...extra,
  };
}

function modelWith(records: ConflictRecord[]): ConflictModel {
  const model = new ConflictModel();
  model.adoptScope({ wcRoot: '/wc', scopeRelPath: '.' });
  const epoch = model.beginScan();
  expect(model.applyScan(epoch, makeOutcome(records))).toBe(true);
  return model;
}

function property(name: string, local: string | null, base: string | null, incoming: string | null, autoUnsupported = false): PropertyConflictValue {
  const value = (text: string | null) => (text === null
    ? { exists: false }
    : { exists: true, value: Buffer.from(text, 'utf8') });
  return { name, local: value(local), base: value(base), incoming: value(incoming), autoUnsupported };
}

/* ---------------------------------------------------------------------------
 * tab 与计数
 * ------------------------------------------------------------------------- */

describe('ConflictModel tab 与计数', () => {
  it('混合路径同时贡献 text 与 property 计数；tab 只过滤可见行', () => {
    const mixed = makeRecord({
      path: 'mixed.txt',
      kinds: ['text', 'property'],
      propertyConflicts: [property('m', 'local', 'base', 'theirs')],
    });
    const binary = makeRecord({ path: 'bin.dat', contentKind: 'binary' });
    const tree = makeRecord({ path: 'tree-del.txt', kinds: ['tree'] });
    const model = modelWith([mixed, binary, tree]);
    expect(model.tabCounts()).toEqual({ all: 4, text: 2, property: 1, tree: 1 });
    expect(model.visibleRows().map((row) => row.path)).toEqual(['bin.dat', 'mixed.txt', 'tree-del.txt']);
    model.setTab('text');
    expect(model.visibleRows().map((row) => row.path)).toEqual(['bin.dat', 'mixed.txt']);
    model.setTab('property');
    expect(model.visibleRows().map((row) => row.path)).toEqual(['mixed.txt']);
    model.setTab('tree');
    expect(model.visibleRows().map((row) => row.path)).toEqual(['tree-del.txt']);
    model.setTab('all');
    expect(model.visibleRows()).toHaveLength(3);
  });

  it('行按路径稳定排序；选择在新扫描移除后自动清除', () => {
    const b = makeRecord({ path: 'b.txt' });
    const a = makeRecord({ path: 'a.txt' });
    const model = modelWith([b, a]);
    expect(model.rows().map((row) => row.path)).toEqual(['a.txt', 'b.txt']);
    expect(model.select(b.id)).toBe(true);
    expect(model.selectedKey()).toBe(b.id);
    const epoch = model.beginScan();
    expect(model.applyScan(epoch, makeOutcome([a]))).toBe(true);
    expect(model.selectedKey()).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------
 * resolvedLedger 合并
 * ------------------------------------------------------------------------- */

describe('ConflictModel resolvedLedger 合并', () => {
  it('台账独有项以 resolved 行补出，不参与未解决计数', () => {
    const text = makeRecord({ path: 'text.txt' });
    const model = modelWith([text]);
    model.recordResolved({
      fingerprint: 'old-1',
      path: 'resolved.txt',
      kinds: ['text'],
      strategy: 'theirs-full',
      operationId: 'op-1',
      resolvedAt: 100,
    });
    const rows = model.rows();
    expect(rows.map((row) => [row.path, row.status])).toEqual([
      ['resolved.txt', 'resolved'],
      ['text.txt', 'unresolved'],
    ]);
    expect(model.summary().total).toBe(1);
  });

  it('真实扫描仍报告的同一路径 + 冲突类型覆盖台账（真实新冲突优先）', () => {
    const model = new ConflictModel();
    model.adoptScope({ wcRoot: '/wc', scopeRelPath: '.' });
    model.recordResolved({
      fingerprint: 'old-1',
      path: 'text.txt',
      kinds: ['text'],
      strategy: 'mine-full',
      operationId: 'op-1',
      resolvedAt: 1,
    });
    const epoch = model.beginScan();
    const record = makeRecord({ path: 'text.txt' });
    model.applyScan(epoch, makeOutcome([record]));
    const rows = model.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('unresolved');
    expect(rows[0]?.record?.id).toBe(record.id);
  });

  it('同一路径不同类型的外部新冲突不被台账覆盖，且台账不补 resolved 行', () => {
    const model = new ConflictModel();
    model.adoptScope({ wcRoot: '/wc', scopeRelPath: '.' });
    model.recordResolved({
      fingerprint: 'old-1',
      path: 'mixed.txt',
      kinds: ['text'],
      strategy: 'mine-full',
      operationId: 'op-1',
      resolvedAt: 1,
    });
    const epoch = model.beginScan();
    model.applyScan(epoch, makeOutcome([makeRecord({ path: 'mixed.txt', kinds: ['property'] })]));
    const rows = model.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('unresolved');
    expect(rows[0]?.kinds).toEqual(['property']);
  });

  it('mergeResolvedLedger 与模型口径一致（同输入同输出）', () => {
    const record = makeRecord({ path: 'a.txt' });
    const model = modelWith([record]);
    expect(model.rows()).toEqual(
      mergeResolvedLedger([record], [], []).sort((a, b) => a.path.localeCompare(b.path)),
    );
  });
});

/* ---------------------------------------------------------------------------
 * 推迟
 * ------------------------------------------------------------------------- */

describe('ConflictModel 推迟', () => {
  it('推迟只改面板状态；重复推迟幂等；可取消推迟', () => {
    const record = makeRecord({ path: 'text.txt' });
    const model = modelWith([record]);
    expect(model.postpone(record.id)).toBe('postponed');
    expect(model.rowByKey(record.id)?.status).toBe('postponed');
    expect(model.postpone(record.id)).toBe('already');
    expect(model.summary().total).toBe(1);
    expect(model.unpostpone(record.id)).toBe(true);
    expect(model.rowByKey(record.id)?.status).toBe('unresolved');
  });

  it('已解决行不能推迟；扫描不再报告时推迟项自然消失', () => {
    const record = makeRecord({ path: 'text.txt' });
    const model = modelWith([record]);
    model.recordResolved({
      fingerprint: 'fp-done',
      path: 'done.txt',
      kinds: ['text'],
      strategy: 'working',
      operationId: 'op-1',
      resolvedAt: 1,
    });
    const resolvedRow = model.rows().find((row) => row.status === 'resolved');
    expect(resolvedRow).toBeDefined();
    expect(model.postpone(resolvedRow!.key)).toBe('resolved');
    model.postpone(record.id);
    expect(model.postponed()).toHaveLength(1);
    const epoch = model.beginScan();
    model.applyScan(epoch, makeOutcome([]));
    expect(model.postponed()).toHaveLength(1);
    expect(model.rows()).toHaveLength(1);
    expect(model.rows()[0]?.status).toBe('resolved');
  });
});

/* ---------------------------------------------------------------------------
 * 树确认
 * ------------------------------------------------------------------------- */

describe('ConflictModel 树确认', () => {
  it('确认绑定记录指纹与扫描代次；扫描代次或记录变化后需重新确认', () => {
    const tree = makeRecord({ path: 'tree-del.txt', kinds: ['tree'] });
    const text = makeRecord({ path: 'text.txt' });
    const model = modelWith([tree, text]);
    expect(model.prepareTreeConflict(tree.id)).toBe('prepared');
    expect(model.isTreePrepared(tree.id)).toBe(true);
    expect(model.prepareTreeConflict(tree.id)).toBe('already');
    expect(model.prepareTreeConflict(text.id)).toBe('not-tree');
    expect(model.prepareTreeConflict('missing')).toBe('not-found');
    const epoch = model.beginScan();
    model.applyScan(epoch, makeOutcome([tree, text]));
    expect(model.isTreePrepared(tree.id)).toBe(false);
  });

  it('非树记录拒绝确认', () => {
    const record = makeRecord({ path: 'text.txt' });
    const model = modelWith([record]);
    expect(model.prepareTreeConflict(record.id)).toBe('not-tree');
  });
});

/* ---------------------------------------------------------------------------
 * 动作矩阵
 * ------------------------------------------------------------------------- */

function matrixOf(record: ConflictRecord) {
  return buildConflictActionMatrix(record);
}

describe('动作矩阵（从 core/resolve 派生）', () => {
  it('纯文本：六值全部可用，working 需二次确认，批量只开放整文件策略', () => {
    const matrix = matrixOf(makeRecord({ path: 'text.txt' }));
    expect(matrix.mixedPath).toBe(false);
    expect(matrix.variants.map((variant) => variant.value)).toEqual([
      'mine-full', 'theirs-full', 'working', 'mine-conflict', 'theirs-conflict', 'base',
    ]);
    expect(matrix.variants.every((variant) => variant.enabled)).toBe(true);
    expect(matrix.workingRequiresConfirmation).toBe(true);
    expect(matrix.batch.applicable).toBe(true);
    expect(matrix.batch.variants).toEqual([...CONFLICT_BATCH_WHOLE_VARIANTS]);
    expect(matrix.blocker).toBeUndefined();
  });

  it('二进制：base 与冲突块变体禁用并给出原因；批量仍只开放整文件策略', () => {
    const matrix = matrixOf(makeRecord({ path: 'bin.dat', contentKind: 'binary' }));
    const byValue = new Map(matrix.variants.map((variant) => [variant.value, variant]));
    expect(byValue.get('base')?.enabled).toBe(false);
    expect(byValue.get('base')?.disabledReason).toContain('二进制');
    expect(byValue.get('mine-conflict')?.enabled).toBe(false);
    expect(byValue.get('theirs-conflict')?.enabled).toBe(false);
    expect(byValue.get('mine-full')?.enabled).toBe(true);
    expect(byValue.get('theirs-full')?.enabled).toBe(true);
    expect(byValue.get('working')?.enabled).toBe(true);
    expect(matrix.batch).toEqual({ applicable: true, variants: [...CONFLICT_BATCH_WHOLE_VARIANTS] });
  });

  it('类型未知：全部禁用，批量不适用', () => {
    const matrix = matrixOf(makeRecord({ path: 'x', contentKind: 'unknown' }));
    expect(matrix.variants.every((variant) => !variant.enabled)).toBe(true);
    expect(matrix.blocker).toBe('unknown-content');
    expect(matrix.blockerText).toContain('未知');
    expect(matrix.batch).toEqual({ applicable: false, unsupportedReason: 'unknown-content', variants: [] });
  });

  it('属性：逐项选择；保留属性 autoUnsupported 不进自动批量', () => {
    const normal = matrixOf(makeRecord({
      path: 'prop.txt',
      kinds: ['property'],
      contentKind: 'unknown',
      propertyConflicts: [property('k', 'local', 'base', 'theirs')],
    }));
    expect(normal.propertySelection).toBe(true);
    expect(normal.variants.every((variant) => !variant.enabled)).toBe(true);
    expect(normal.batch).toEqual({ applicable: false, unsupportedReason: 'property', variants: [] });

    const reserved = matrixOf(makeRecord({
      path: 'merge.txt',
      kinds: ['property'],
      contentKind: 'unknown',
      propertyConflicts: [property('svn:mergeinfo', '/a:1', '/a:2', '/a:3', true)],
    }));
    expect(reserved.autoUnsupported).toBe(true);
    expect(reserved.blocker).toBe('property-auto-unsupported');
    expect(reserved.batch).toEqual({ applicable: false, unsupportedReason: 'auto-unsupported', variants: [] });
  });

  it('属性值读取不完整：不提供自动处理', () => {
    const matrix = matrixOf(makeRecord({ path: 'prop.txt', kinds: ['property'], contentKind: 'unknown' }));
    expect(matrix.propertyValuesUnavailable).toBe(true);
    const variant = matrix.variants.find((candidate) => candidate.value === 'mine-full');
    expect(variant?.enabled).toBe(false);
    expect(variant?.disabledReason).toContain('属性值');
  });

  it('树冲突：只有 working（确认后），其余禁用；批量不适用', () => {
    const matrix = matrixOf(makeRecord({
      path: 'tree-del.txt',
      kinds: ['tree'],
      contentKind: 'unknown',
      treeConflict: {
        operation: 'update',
        kind: 'file',
        reason: 'delete',
        action: 'edit',
        victim: 'tree-del.txt',
      },
    }));
    expect(matrix.treeConfirmation).toBe(true);
    const byValue = new Map(matrix.variants.map((variant) => [variant.value, variant]));
    expect(byValue.get('working')?.enabled).toBe(true);
    expect(byValue.get('mine-full')?.enabled).toBe(false);
    expect(byValue.get('mine-full')?.disabledReason).toContain('树冲突');
    expect(matrix.batch).toEqual({ applicable: false, unsupportedReason: 'tree', variants: [] });
  });

  it('混合路径：全部禁用直接应用；批量不适用', () => {
    const matrix = matrixOf(makeRecord({
      path: 'mixed.txt',
      kinds: ['text', 'property'],
      propertyConflicts: [property('m', 'local', 'base', 'theirs')],
    }));
    expect(matrix.mixedPath).toBe(true);
    expect(matrix.variants.every((variant) => !variant.enabled)).toBe(true);
    expect(matrix.blocker).toBe('mixed-path');
    expect(matrix.batch).toEqual({ applicable: false, unsupportedReason: 'mixed-path', variants: [] });
  });

  it('batchApplicabilityOf 对可执行项返回整文件策略', () => {
    expect(batchApplicabilityOf(makeRecord({ path: 'a', kinds: ['text'] }))).toEqual({
      applicable: true,
      variants: ['mine-full', 'theirs-full'],
    });
  });
});

/* ---------------------------------------------------------------------------
 * 变体、属性选择与确认对话框
 * ------------------------------------------------------------------------- */

describe('变体与属性选择', () => {
  it('chooseVariant 只接受动作矩阵可用变体；新扫描清空选择', () => {
    const record = makeRecord({ path: 'text.txt' });
    const model = modelWith([record]);
    expect(model.chooseVariant(record.id, 'base')).toBe('selected');
    expect(model.selectedVariant(record.id)).toBe('base');
    expect(model.chooseVariant(record.id, 'base')).toBe('unchanged');
    expect(model.chooseVariant('missing', 'base')).toBe('not-found');
    const detail = model.detail(record.id)!;
    const variants = detail.sections.find((section) => section.kind === 'variants');
    if (variants?.kind === 'variants') {
      expect(variants.options.find((option) => option.value === 'base')?.selected).toBe(true);
    }
    const actions = detail.sections.flatMap((section) => (section.kind === 'actions' ? section.actions : []));
    expect(actions.find((action) => action.id === 'applyConflictResolution')?.disabled).not.toBe(true);

    const binary = makeRecord({ path: 'bin.dat', contentKind: 'binary' });
    const binaryModel = modelWith([binary]);
    expect(binaryModel.chooseVariant(binary.id, 'base')).toBe('disabled');

    const epoch = model.beginScan();
    model.applyScan(epoch, makeOutcome([record]));
    expect(model.selectedVariant(record.id)).toBeUndefined();
  });

  it('selectPropertyValue 逐项选择、完整性判定与保留属性拒绝', () => {
    const record = makeRecord({
      path: 'prop.txt',
      kinds: ['property'],
      contentKind: 'unknown',
      propertyConflicts: [
        property('p1', 'l1', 'b1', 't1'),
        property('p2', 'l2', 'b2', 't2'),
        property('svn:ignore', 'x', 'y', 'z', true),
      ],
    });
    const model = modelWith([record]);
    expect(model.selectPropertyValue(record.id, 'p1', 'local')).toBe('selected');
    expect(model.selectPropertyValue(record.id, 'p1', 'local')).toBe('unchanged');
    expect(model.selectPropertyValue(record.id, 'nope', 'local')).toBe('not-property');
    expect(model.selectPropertyValue(record.id, 'svn:ignore', 'local')).toBe('unsupported');
    expect(model.selectPropertyValue('missing', 'p1', 'local')).toBe('not-found');
    expect(model.propertySelectionComplete(record.id)).toBe(false);
    model.selectPropertyValue(record.id, 'p2', 'incoming');
    expect(model.propertySelectionComplete(record.id)).toBe(true);
    expect(model.propertyChoices(record.id)).toEqual({ p1: 'local', p2: 'incoming' });
    const detail = model.detail(record.id)!;
    const properties = detail.sections.find((section) => section.kind === 'properties');
    if (properties?.kind === 'properties') {
      expect(properties.properties.find((item) => item.name === 'p1')?.selected).toBe('local');
      expect(properties.properties.find((item) => item.name === 'p2')?.selected).toBe('incoming');
      expect(properties.properties.find((item) => item.name === 'svn:ignore')?.autoUnsupported).toBe(true);
    }
  });

  it('确认对话框：树确认 prepareTreeConflict、working 二次确认 applyConflictResolution', () => {
    const tree = makeRecord({ path: 'tree-del.txt', kinds: ['tree'] });
    const treeModel = modelWith([tree]);
    const treeDialog = treeModel.confirmDialog(tree.id, 'tree', 'req-1')!;
    expect(treeDialog.id).toContain('req-1');
    expect(treeDialog.confirm.id).toBe('prepareTreeConflict');
    expect(treeDialog.level).toBe('warn');
    expect(treeDialog.detail).toContain('tree-del.txt');
    expect(treeModel.confirmDialog(tree.id, 'working')?.confirm.id).toBe('applyConflictResolution');

    const text = makeRecord({ path: 'text.txt' });
    const textModel = modelWith([text]);
    expect(textModel.confirmDialog(text.id, 'tree')).toBeUndefined();
    expect(textModel.confirmDialog('missing', 'working')).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------
 * 详情
 * ------------------------------------------------------------------------- */

describe('冲突详情', () => {
  it('文本记录：元数据三段 revision 分离、六种变体选项、辅助文件角色', () => {
    const record = makeRecord({
      path: 'text.txt',
      nodeBaseRevision: 4,
      baselineRevision: 2,
      incomingRevision: 3,
      artifacts: [
        { role: 'base', path: 'text.txt.r2', revision: 2 },
        { role: 'mine', path: 'text.txt.mine' },
        { role: 'incoming', path: 'text.txt.r3', revision: 3 },
      ],
    });
    const detail = buildConflictDetail({ row: { key: record.id, path: record.path, kinds: record.kinds, status: 'unresolved', record } });
    const text = JSON.stringify(detail);
    expect(text).toContain('r4');
    expect(text).toContain('r2');
    expect(text).toContain('r3');
    expect(text).toContain('text.txt.mine');
    const variants = detail.sections.find((section) => section.kind === 'variants');
    expect(variants?.kind).toBe('variants');
    if (variants?.kind === 'variants') {
      expect(variants.options.map((option) => option.value)).toEqual([
        'mine-full', 'theirs-full', 'working', 'mine-conflict', 'theirs-conflict', 'base',
      ]);
      expect(variants.options.every((option) => option.disabled !== true)).toBe(true);
      expect(variants.options.find((option) => option.value === 'working')?.label).toContain('确认');
      expect(variants.options.filter((option) => option.advanced === true).map((option) => option.value))
        .toEqual(['mine-conflict', 'theirs-conflict', 'base']);
      expect(variants.advancedLabel).toBeTruthy();
    }
    const artifacts = detail.sections.find((section) => section.kind === 'artifacts');
    expect(artifacts?.kind).toBe('artifacts');
    if (artifacts?.kind === 'artifacts') {
      expect(artifacts.artifacts.map((artifact) => artifact.path)).toEqual([
        'text.txt.r2', 'text.txt.mine', 'text.txt.r3',
      ]);
      expect(artifacts.artifacts[0]?.revision).toBe('2');
    }
  });

  it('二进制记录：类型说明作为 variants note、版本入口带角色', () => {
    const record = makeRecord({ path: 'bin.dat', contentKind: 'binary' });
    const detail = buildConflictDetail({ row: { key: record.id, path: record.path, kinds: record.kinds, status: 'unresolved', record } });
    const variants = detail.sections.find((section) => section.kind === 'variants');
    if (variants?.kind === 'variants') {
      expect(variants.note).toContain('二进制');
      expect(variants.options.find((option) => option.value === 'base')?.disabled).toBe(true);
    }
    const text = JSON.stringify(detail);
    expect(text).toContain('二进制');
    const actions = detail.sections.flatMap((section) => (section.kind === 'actions' ? section.actions : []));
    expect(actions.filter((action) => action.id === 'openConflictVersion').map((action) => action.payload?.['role']))
      .toEqual(['local', 'base', 'incoming']);
  });

  it('属性记录：逐属性三值（文本/不存在/二进制值/超长截断）与逐项选择动作', () => {
    const reserved = property('svn:mergeinfo', '/a:1', null, '/b:2', true);
    const binary = property('bin', 'a\u0001b', 'base', 'theirs');
    const record = makeRecord({
      path: 'prop.txt',
      kinds: ['property'],
      contentKind: 'unknown',
      propertyConflicts: [property('k', 'local', 'base', 'theirs'), reserved, binary],
    });
    const detail = buildConflictDetail({
      row: { key: record.id, path: record.path, kinds: record.kinds, status: 'unresolved', record },
      propertyChoices: { k: 'incoming' },
    });
    const properties = detail.sections.find((section) => section.kind === 'properties');
    expect(properties?.kind).toBe('properties');
    if (properties?.kind === 'properties') {
      expect(properties.properties).toHaveLength(3);
      const k = properties.properties.find((item) => item.name === 'k');
      expect(k?.local.text).toBe('local');
      expect(k?.base.text).toBe('base');
      expect(k?.incoming.text).toBe('theirs');
      expect(k?.selected).toBe('incoming');
      expect(k?.local.action?.payload).toEqual({ property: 'k', choice: 'local' });
      const merge = properties.properties.find((item) => item.name === 'svn:mergeinfo');
      expect(merge?.autoUnsupported).toBe(true);
      expect(merge?.autoUnsupportedNote).toBeTruthy();
      expect(merge?.base.exists).toBe(false);
    }
    const text = JSON.stringify(detail);
    expect(text).toContain('（不存在）');
    expect(text).toContain('二进制值');
    expect(text).toContain('需检查器处理');
    expect(describePropertyValue({ exists: true, value: Buffer.from('a\u0001b') })).toContain('二进制值');
    expect(describePropertyValue({ exists: true, value: Buffer.from('x'.repeat(500)) })).toContain('已截断');
  });

  it('纯属性记录：全部属性选择完成后渲染 working 入口，未选完禁用并给原因', () => {
    const record = makeRecord({
      path: 'prop-only.txt',
      kinds: ['property'],
      contentKind: 'unknown',
      propertyConflicts: [
        property('k1', 'l1', 'b1', 'i1'),
        property('k2', 'l2', 'b2', 'i2'),
      ],
    });
    const row = { key: record.id, path: record.path, kinds: record.kinds, status: 'unresolved' as const, record };
    const actionsOf = (detail: ReturnType<typeof buildConflictDetail>): ActionSpec[] =>
      detail.sections.flatMap((section) => (section.kind === 'actions' ? section.actions : []));

    // 未选择：入口存在但禁用（compareNeedsTwo 同型：动作稳定、可用性跟选择走）。
    const incomplete = buildConflictDetail({
      row,
      propertyChoices: { k1: 'local' },
      propertySelectionComplete: false,
    });
    const partial = actionsOf(incomplete).find((action) => action.id === 'applyConflictResolution');
    expect(partial).toMatchObject({ label: conflictText('detailApplyPropertyWorking'), disabled: true });
    expect(partial?.disabledReason).toBe(conflictText('detailPropertyIncomplete'));

    const complete = buildConflictDetail({
      row,
      propertyChoices: { k1: 'local', k2: 'incoming' },
      propertySelectionComplete: true,
    });
    expect(actionsOf(complete).find((action) => action.id === 'applyConflictResolution')).toMatchObject({
      label: conflictText('detailApplyPropertyWorking'),
      disabled: false,
    });
  });

  it('纯属性记录（模型）：choosePropertyValue 意图全部选完后 detail 入口启用（同源 propertySelectionComplete）', () => {
    const record = makeRecord({
      path: 'prop-model.txt',
      kinds: ['property'],
      contentKind: 'unknown',
      propertyConflicts: [
        property('k1', 'l1', 'b1', 'i1'),
        property('k2', 'l2', 'b2', 'i2'),
      ],
    });
    const model = modelWith([record]);
    model.select(record.id);
    expect(model.propertySelectionComplete(record.id)).toBe(false);
    const before = model.detail()!;
    const beforeActions = before.sections.flatMap((section) => (section.kind === 'actions' ? section.actions : []));
    expect(beforeActions.find((action) => action.id === 'applyConflictResolution')?.disabled).toBe(true);

    expect(model.selectPropertyValue(record.id, 'k1', 'local')).toBe('selected');
    expect(model.propertySelectionComplete(record.id)).toBe(false);
    expect(model.selectPropertyValue(record.id, 'k2', 'incoming')).toBe('selected');
    expect(model.propertySelectionComplete(record.id)).toBe(true);

    const after = model.detail()!;
    const afterActions = after.sections.flatMap((section) => (section.kind === 'actions' ? section.actions : []));
    expect(afterActions.find((action) => action.id === 'applyConflictResolution')).toMatchObject({
      label: conflictText('detailApplyPropertyWorking'),
      disabled: false,
    });
  });

  it('树冲突：元数据 + 确认状态切换动作可用性', () => {
    const record = makeRecord({
      path: 'tree-del.txt',
      kinds: ['tree'],
      contentKind: 'unknown',
      treeConflict: {
        operation: 'update',
        kind: 'file',
        reason: 'delete',
        action: 'edit',
        victim: 'tree-del.txt',
        sourceRight: { side: 'source-right', kind: 'file', pathInRepos: 'tree-del.txt', revision: 3 },
      },
    });
    const row = { key: record.id, path: record.path, kinds: record.kinds, status: 'unresolved' as const, record };
    const unprepared = buildConflictDetail({ row });
    const unpreparedActions = unprepared.sections.flatMap((section) => (section.kind === 'actions' ? section.actions : []));
    expect(unpreparedActions.find((action) => action.id === 'prepareTreeConflict')?.disabled).not.toBe(true);
    expect(unpreparedActions.find((action) => action.id === 'applyConflictResolution')?.disabled).toBe(true);
    const prepared = buildConflictDetail({ row, treePrepared: true });
    const preparedActions = prepared.sections.flatMap((section) => (section.kind === 'actions' ? section.actions : []));
    expect(preparedActions.find((action) => action.id === 'prepareTreeConflict')?.disabled).toBe(true);
    expect(preparedActions.find((action) => action.id === 'applyConflictResolution')?.disabled).not.toBe(true);
    expect(JSON.stringify(prepared)).toContain('tree-del.txt');
  });

  it('混合路径：说明、变体 warn 与只读交互处理入口', () => {
    const record = makeRecord({ path: 'mixed.txt', kinds: ['text', 'property'], propertyConflicts: [property('m', 'l', 'b', 't')] });
    const detail = buildConflictDetail({ row: { key: record.id, path: record.path, kinds: record.kinds, status: 'unresolved', record } });
    const text = JSON.stringify(detail);
    expect(text).toContain('同一路径');
    expect(text).toContain('工作副本终端');
    const variants = detail.sections.find((section) => section.kind === 'variants');
    if (variants?.kind === 'variants') {
      expect(variants.warn).toContain('同一路径');
      expect(variants.options.every((option) => option.disabled)).toBe(true);
    }
    // 无文本变体段的混合路径（属性+树）仍显示独立说明段。
    const propTree = makeRecord({
      path: 'prop-tree',
      kinds: ['property', 'tree'],
      propertyConflicts: [property('m', 'l', 'b', 't')],
      treeConflict: { operation: 'update', kind: 'dir', reason: 'add', action: 'add', victim: 'prop-tree' },
    });
    const propTreeDetail = buildConflictDetail({ row: { key: propTree.id, path: propTree.path, kinds: propTree.kinds, status: 'unresolved', record: propTree } });
    expect(propTreeDetail.sections.some((section) => section.kind === 'text'
      && section.heading === '混合路径')).toBe(true);
  });

  it('已解决行：显示策略/操作编号/确认时间与说明', () => {
    const row = {
      key: 'fp-1',
      path: 'done.txt',
      kinds: ['text' as const],
      status: 'resolved' as const,
      resolved: {
        fingerprint: 'fp-1',
        path: 'done.txt',
        kinds: ['text' as const],
        strategy: 'theirs-full',
        operationId: 'op-42',
        resolvedAt: 1_700_000_000_000,
      },
    };
    const detail = buildConflictDetail({ row });
    const text = JSON.stringify(detail);
    expect(text).toContain('theirs-full');
    expect(text).toContain('op-42');
    expect(text).toContain('已解决');
  });

  it('属性值补查失败：详情渲染「补齐认证」入口（authenticateConflictSource）', () => {
    // 属性冲突值缺失（propertyConflicts 为空）是远端补查失败/未认证的降级形态。
    const unavailable = makeRecord({ path: 'prop-unavailable.txt', kinds: ['property'], contentKind: 'unknown' });
    const actionsOf = (detail: ReturnType<typeof buildConflictDetail>): ActionSpec[] =>
      detail.sections.flatMap((section) => (section.kind === 'actions' ? section.actions : []));
    const detail = buildConflictDetail({
      row: { key: unavailable.id, path: unavailable.path, kinds: unavailable.kinds, status: 'unresolved', record: unavailable },
    });
    const authAction = actionsOf(detail).find((action) => action.id === 'authenticateConflictSource');
    expect(authAction).toMatchObject({ label: conflictText('detailAuthenticateSource') });
    expect(authAction?.disabled).not.toBe(true);
    // 属性段仍有「补查失败」提示（动作与说明同源）。
    const properties = detail.sections.find((section) => section.kind === 'properties');
    expect(properties?.kind === 'properties' ? properties.note : undefined).toBe(conflictText('propertyUnavailableNotice'));

    // 属性值完整时没有认证入口（不制造无意义动作）。
    const available = makeRecord({
      path: 'prop-ok.txt',
      kinds: ['property'],
      contentKind: 'unknown',
      propertyConflicts: [property('m', 'l', 'b', 'i')],
    });
    const okDetail = buildConflictDetail({
      row: { key: available.id, path: available.path, kinds: available.kinds, status: 'unresolved', record: available },
    });
    expect(actionsOf(okDetail).some((action) => action.id === 'authenticateConflictSource')).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * 扫描代次与持久化
 * ------------------------------------------------------------------------- */

describe('扫描代次与关闭重开恢复', () => {
  it('旧代次的 applyScan/failScan/进度被丢弃；取消只改面板状态', () => {
    const model = new ConflictModel();
    model.adoptScope({ wcRoot: '/wc', scopeRelPath: '.' });
    const first = model.beginScan();
    const second = model.beginScan();
    expect(model.isScanCurrent(first)).toBe(false);
    expect(model.applyScan(first, makeOutcome([makeRecord({ path: 'old.txt' })]))).toBe(false);
    expect(model.failScan(first, new Error('旧失败'))).toBe(false);
    model.updateProgress(first, 3, 10);
    expect(model.buildPanelState('s').progress?.detail).toBeUndefined();
    expect(model.cancelScan(second)).toBe(true);
    expect(model.phase()).toBe('idle');
  });

  it('serialize/restore 恢复 tab、选择、快照、台账与推迟；跨作用域拒绝', () => {
    const record = makeRecord({ path: 'text.txt' });
    const postponedRow = makeRecord({ path: 'p.txt' });
    const model = modelWith([record, postponedRow]);
    model.setTab('text');
    model.select(record.id);
    model.postpone(postponedRow.id);
    model.recordResolved({
      fingerprint: 'fp-1',
      path: 'done.txt',
      kinds: ['text'],
      strategy: 'mine-full',
      operationId: 'op-1',
      resolvedAt: 5,
    });
    const serialized = model.serialize()!;
    expect(serialized.postponed).toHaveLength(1);
    expect(serialized.resolvedLedger).toHaveLength(1);

    const restored = new ConflictModel();
    restored.adoptScope({ wcRoot: '/wc', scopeRelPath: '.' });
    expect(restored.restore(serialized)).toBe(true);
    expect(restored.tab()).toBe('text');
    expect(restored.selectedKey()).toBe(record.id);
    expect(restored.records()).toHaveLength(2);
    expect(restored.ledger()).toHaveLength(1);
    expect(restored.postponed()).toHaveLength(1);
    expect(restored.rows().find((row) => row.path === 'p.txt')?.status).toBe('postponed');

    const otherScope = new ConflictModel();
    otherScope.adoptScope({ wcRoot: '/other', scopeRelPath: '.' });
    expect(otherScope.restore(serialized)).toBe(false);
    expect(otherScope.records()).toHaveLength(0);
  });

  it('形状版本不符的 browsable/snapshot 被忽略，台账仍可恢复', () => {
    const model = new ConflictModel();
    model.adoptScope({ wcRoot: '/wc', scopeRelPath: '.' });
    expect(model.restore({
      browsable: { version: 99, scope: { wcRoot: '/wc', scopeRelPath: '.' }, tab: 'text' },
      conflictSnapshot: { version: 99 },
      resolvedLedger: [{
        fingerprint: 'fp', path: 'a', kinds: ['text'], strategy: 'working', operationId: 'op', resolvedAt: 1,
      }],
      postponed: [],
    })).toBe(true);
    expect(model.tab()).toBe('all');
    expect(model.records()).toHaveLength(0);
    expect(model.ledger()).toHaveLength(1);
  });

  it('persistConflictSession/restoreConflictSession 经 m4SessionStore 关闭重开', () => {
    resetM4SessionStore();
    const record = makeRecord({ path: 'text.txt' });
    const model = modelWith([record]);
    model.setTab('text');
    model.select(record.id);
    model.postpone(record.id);
    model.recordResolved({
      fingerprint: 'fp-1',
      path: 'done.txt',
      kinds: ['text'],
      strategy: 'mine-full',
      operationId: 'op-1',
      resolvedAt: 7,
    });
    const scope = model.scope()!;
    expect(persistConflictSession(model)).toBeDefined();

    const reopened = new ConflictModel();
    expect(restoreConflictSession(reopened, scope)).toBe(true);
    expect(reopened.tab()).toBe('text');
    expect(reopened.selectedKey()).toBe(record.id);
    expect(reopened.records()).toHaveLength(1);
    expect(reopened.ledger()).toHaveLength(1);
    expect(reopened.rows().find((row) => row.path === 'text.txt')?.status).toBe('postponed');

    const other = new ConflictModel();
    expect(restoreConflictSession(other, { wcRoot: '/other', scopeRelPath: '.' })).toBe(false);
    resetM4SessionStore();
  });

  it('adoptScope：同一工作副本换范围保留台账/推迟，换工作副本全部清空', () => {
    const taskScope = { wcRoot: '/wc', scopeRelPath: 'src' };
    const model = new ConflictModel();
    model.adoptScope(taskScope);
    const record = makeRecord({ path: 'src/a.txt' });
    const epoch = model.beginScan();
    expect(model.applyScan(epoch, makeOutcome([record], { scope: taskScope }))).toBe(true);
    model.postpone(record.id);
    model.setTab('text');
    model.select(record.id);
    model.recordResolved({
      fingerprint: 'fp-done',
      path: 'src/done.txt',
      kinds: ['text'],
      strategy: 'mine-full',
      operationId: 'op-done',
      resolvedAt: 5,
    });

    // 同一工作副本：台账/推迟保留（切换范围不丢已解决状态）；筛选/快照
    // 等展示态由新范围扫描/恢复重建。
    model.adoptScope({ wcRoot: '/wc', scopeRelPath: '.' });
    expect(model.ledger().map((entry) => entry.path)).toEqual(['src/done.txt']);
    expect(model.postponed()).toHaveLength(1);
    expect(model.tab()).toBe('all');
    expect(model.records()).toHaveLength(0);
    expect(model.phase()).toBe('idle');

    // 换工作副本：台账与推迟随作用域项淘汰。
    model.adoptScope({ wcRoot: '/other', scopeRelPath: '.' });
    expect(model.ledger()).toHaveLength(0);
    expect(model.postponed()).toHaveLength(0);
    expect(model.tab()).toBe('all');
  });

  it('任务范围 resolve 后切整副本仍显示已解决（台账跨范围页移交，真实新冲突优先）', () => {
    resetM4SessionStore();
    const taskScope = { wcRoot: '/wc', scopeRelPath: 'src/sub' };
    const taskModel = new ConflictModel();
    taskModel.adoptScope(taskScope);
    const taskEpoch = taskModel.beginScan();
    expect(taskModel.applyScan(taskEpoch, makeOutcome([], { scope: taskScope }))).toBe(true);
    taskModel.recordResolved({
      fingerprint: 'fp-a',
      path: 'src/sub/a.txt',
      kinds: ['text'],
      strategy: 'mine-full',
      operationId: 'op-a',
      resolvedAt: 3,
    });
    expect(persistConflictSession(taskModel)).toBeDefined();

    // 切整副本：'.' 页无本页快照（恢复返回 false → 控制器照常 fresh 扫描），
    // 但任务范围页的台账已移交进模型。
    const whole = new ConflictModel();
    expect(restoreConflictSession(whole, { wcRoot: '/wc', scopeRelPath: '.' })).toBe(false);
    expect(whole.ledger().map((entry) => entry.path)).toEqual(['src/sub/a.txt']);
    const scan = whole.beginScan();
    expect(whole.applyScan(scan, makeOutcome([], { scope: { wcRoot: '/wc', scopeRelPath: '.' } }))).toBe(true);
    const resolvedRow = whole.rows().find((row) => row.path === 'src/sub/a.txt');
    expect(resolvedRow?.status).toBe('resolved');
    expect(whole.summary().total).toBe(0);

    // 真实扫描仍报告同一路径 + 类型冲突时以未解决为准（真实新冲突优先）。
    const rescan = whole.beginScan();
    const conflictedAgain = makeRecord({ path: 'src/sub/a.txt' });
    expect(whole.applyScan(rescan, makeOutcome([conflictedAgain], {
      scope: { wcRoot: '/wc', scopeRelPath: '.' },
    }))).toBe(true);
    expect(whole.rows().find((row) => row.path === 'src/sub/a.txt')?.status).toBe('unresolved');
    resetM4SessionStore();
  });
});

/* ---------------------------------------------------------------------------
 * 面板状态
 * ------------------------------------------------------------------------- */

describe('buildPanelState', () => {
  it('balanced 布局、tabs 计数、冲突列表行、默认详情与扫描进度', () => {
    const record = makeRecord({ path: 'text.txt' });
    const model = new ConflictModel();
    model.adoptScope({ wcRoot: '/wc', scopeRelPath: '.' });
    const epoch = model.beginScan();
    const scanning = model.buildPanelState('s1');
    expect(scanning.layout?.layout).toBe('balanced');
    expect(scanning.busy).toBe(true);
    expect(scanning.progress?.title).toContain('扫描');
    model.updateProgress(epoch, 2, 5);
    expect(model.buildPanelState('s1').progress?.ratio).toBeCloseTo(0.4);
    model.applyScan(epoch, makeOutcome([record], { externals: ['ext'] }));
    const state = model.buildPanelState('s1');
    expect(state.busy).toBe(false);
    expect(state.tabs?.current).toBe('all');
    expect(state.tabs?.tabs.map((tab) => [tab.id, tab.count])).toEqual([
      ['all', 1], ['text', 1], ['property', 0], ['tree', 0],
    ]);
    expect(state.conflictList?.rows.map((row) => row.id)).toEqual([record.id]);
    expect(state.conflictList?.selectIntent).toBe('selectConflict');
    expect(state.conflictList?.rows[0]?.status).toBe('unresolved');
    expect(state.conflictList?.rows[0]?.contentKind).toBe('text');
    expect(state.conflictList?.rows[0]?.auto?.kind).toBe('applicable');
    expect(state.conflictList?.kindLabels?.text).toBeTruthy();
    expect(state.detail?.title).toContain('选择冲突');
    expect(state.banners.some((banner) => banner.id === 'conflictExternalBoundary')).toBe(true);
  });

  it('扫描进度区的关闭/查看日志动作复用 i18n.panel 键（不硬编码文案）', () => {
    const model = new ConflictModel();
    model.adoptScope({ wcRoot: '/wc', scopeRelPath: '.' });
    model.beginScan();
    const progress = model.buildPanelState('s1').progress;
    expect(progress?.actions).toEqual([
      { id: 'closePanel', label: strings.panel.taskProgressClose },
      { id: 'viewTaskLog', label: strings.panel.taskProgressLog },
    ]);
  });

  it('属性值补查失败路径渲染面板级「补齐认证」横幅（authenticateConflictSource）', () => {
    const record = makeRecord({ path: 'p.txt' });
    const model = new ConflictModel();
    model.adoptScope({ wcRoot: '/wc', scopeRelPath: '.' });
    const epoch = model.beginScan();
    expect(model.applyScan(epoch, makeOutcome([record], { propertyValueFailures: ['p.txt'] }))).toBe(true);
    const banner = model.buildPanelState('s1').banners.find((candidate) => candidate.id === 'conflictPropertyValueFailures');
    expect(banner).toBeDefined();
    expect(banner?.detail).toContain('p.txt');
    expect(banner?.actions?.map((action) => action.id)).toEqual(['authenticateConflictSource']);
  });

  it('external 边界横幅可关闭：会话内保持关闭，切换目标后恢复', () => {
    const record = makeRecord({ path: 'text.txt' });
    const model = new ConflictModel();
    model.adoptScope({ wcRoot: '/wc', scopeRelPath: '.' });
    const epoch = model.beginScan();
    model.applyScan(epoch, makeOutcome([record], { externals: ['ext'] }));
    expect(model.buildPanelState('s1').banners.some((b) => b.id === 'conflictExternalBoundary')).toBe(true);
    expect(model.dismissBanner('conflictExternalBoundary')).toBe(true);
    expect(model.buildPanelState('s1').banners.some((b) => b.id === 'conflictExternalBoundary')).toBe(false);
    // 重新扫描同一范围：保持关闭（不重复打扰）。
    const rescan = model.beginScan();
    model.applyScan(rescan, makeOutcome([record], { externals: ['ext'] }));
    expect(model.buildPanelState('s1').banners.some((b) => b.id === 'conflictExternalBoundary')).toBe(false);
    // 不存在或不可关闭的横幅返回 false。
    expect(model.dismissBanner('conflictScanFailed')).toBe(false);
    expect(model.dismissBanner('missing')).toBe(false);
    // 切换目标：新会话恢复展示。
    model.adoptScope({ wcRoot: '/wc', scopeRelPath: 'trunk' });
    const next = model.beginScan();
    model.applyScan(next, makeOutcome([record], {
      externals: ['ext'],
      scope: { wcRoot: '/wc', scopeRelPath: 'trunk' },
    }));
    expect(model.buildPanelState('s1').banners.some((b) => b.id === 'conflictExternalBoundary')).toBe(true);
  });

  it('扫描失败保留旧列表并显示错误横幅；wcLocked 徽标与横幅', () => {
    const record = makeRecord({ path: 'text.txt' });
    const model = modelWith([record]);
    const epoch = model.beginScan();
    model.failScan(epoch, new Error('E000013: Permission denied'));
    const failed = model.buildPanelState('s1');
    expect(failed.banners.find((banner) => banner.id === 'conflictScanFailed')?.detail).toContain('E000013');
    expect(failed.conflictList?.rows).toHaveLength(1);

    const locked = modelWith([record]);
    const lockedEpoch = locked.beginScan();
    locked.applyScan(lockedEpoch, makeOutcome([record], { wcLocked: true }));
    const state = locked.buildPanelState('s1');
    expect(state.banners.some((banner) => banner.id === 'conflictWcLocked')).toBe(true);
    expect(state.headerBadges?.some((badge) => badge.warn === true)).toBe(true);
  });

  it('属性/树/混合行标记为不适用并给出原因；unknown 行不伪装成已解决', () => {
    const prop = makeRecord({
      path: 'prop.txt',
      kinds: ['property'],
      contentKind: 'unknown',
      propertyConflicts: [property('k', 'l', 'b', 't')],
    });
    const model = modelWith([prop]);
    const row = model.buildPanelState('s1').conflictList?.rows[0];
    expect(row?.auto?.kind).toBe('unsupported');
    expect(row?.auto?.reason).toContain('属性');
    model.markUnknown(prop.id, '回扫失败');
    const unknown = model.buildPanelState('s1').conflictList?.rows[0];
    expect(unknown?.status).toBe('unknown');
    expect(unknown?.statusLabel).toBeTruthy();
    expect(model.isUnknown(prop.id)).toBe(true);
  });

  it('模型面板状态可被视图渲染（冲突列表、变体选项与属性三值段）', () => {
    const mixed = makeRecord({
      path: 'mixed.txt',
      kinds: ['text', 'property'],
      propertyConflicts: [property('m', 'local', 'base', 'theirs')],
      artifacts: [{ role: 'mine', path: 'mixed.txt.mine' }],
    });
    const model = modelWith([mixed]);
    const listHtml = render(model.buildPanelState('s1'));
    expect(listHtml).toContain('class="conflict-list"');
    expect(listHtml).toContain('data-status="unresolved"');
    expect(listHtml).toContain('conflict-select');
    model.select(mixed.id);
    const detailHtml = render(model.buildPanelState('s1'));
    expect(detailHtml).toContain('property-item');
    expect(detailHtml).toContain('choice-grid');
    expect(detailHtml).toContain('chooseConflictVariant');
    expect(detailHtml).toContain('choosePropertyValue');
    expect(detailHtml).toContain('artifact-list');
  });
});

/* ---------------------------------------------------------------------------
 * 扫描编排（真实 file:// 副本）
 * ------------------------------------------------------------------------- */

interface ConflictLab {
  lab: SvnLab;
  wc: string;
}

function buildConflictLab(): ConflictLab {
  const lab = createSvnLab('svn-anywhere-conflict-model-');
  const wc0 = lab.checkout('wc0');
  writeFile(wc0, 'text.txt', 'line1\nline2\n', true);
  writeFile(wc0, 'prop.txt', 'prop content\n', true);
  writeFile(wc0, 'mixed.txt', 'mix1\nmix2\n', true);
  writeFile(wc0, 'tree-del.txt', 'tree-del base\n', true);
  writeFileSync(join(wc0, 'binary.bin'), Buffer.from([0x62, 0x69, 0x00, 0x01, 0x02, 0x0a]));
  lab.svn(['add', '-q', 'binary.bin'], wc0);
  lab.svn(['propset', '-q', 'k', 'base', 'prop.txt'], wc0);
  lab.svn(['propset', '-q', 'm', 'base', 'mixed.txt'], wc0);
  lab.svn(['commit', '-q', '-m', 'r-base'], wc0);

  const wc1 = lab.checkout('wc1');
  const wc2 = lab.checkout('wc2');

  writeFile(wc1, 'text.txt', 'line1-theirs\nline2\n');
  lab.svn(['propset', '-q', 'k', 'theirs', 'prop.txt'], wc1);
  writeFile(wc1, 'mixed.txt', 'mix1-theirs\nmix2\n');
  lab.svn(['propset', '-q', 'm', 'theirs', 'mixed.txt'], wc1);
  writeFileSync(join(wc1, 'binary.bin'), Buffer.from([0x74, 0x00, 0xff, 0x0a]));
  lab.svn(['rm', '-q', 'tree-del.txt'], wc1);
  lab.svn(['commit', '-q', '-m', 'incoming changes'], wc1);
  lab.svn(['update', '-q'], wc1);

  writeFile(wc2, 'text.txt', 'line1-local\nline2\n');
  lab.svn(['propset', '-q', 'k', 'local', 'prop.txt'], wc2);
  writeFile(wc2, 'mixed.txt', 'mix1-local\nmix2\n');
  lab.svn(['propset', '-q', 'm', 'local', 'mixed.txt'], wc2);
  writeFileSync(join(wc2, 'binary.bin'), Buffer.from([0x6c, 0x00, 0xfe, 0x0a]));
  writeFile(wc2, 'tree-del.txt', 'tree-del local edit\n');
  lab.svn(['update'], wc2);
  return { lab, wc: wc2 };
}

describe('scanConflictScope（真实 file:// 副本）', () => {
  let built: ConflictLab | undefined;

  afterEach(() => {
    built?.lab.cleanup();
    built = undefined;
  });

  it('覆盖文本/二进制/属性/混合/树冲突；内容分类与属性三值补查生效', async () => {
    built = buildConflictLab();
    const wc = built.wc;
    const target: ConflictScopeTarget = conflictScopeOf(wc);
    const authorizerCalls: string[] = [];
    const progress: Array<[number, number]> = [];
    const outcome = await scanConflictScope({
      svnPath: 'svn',
      classifyContent: createWorkingCopyContentClassifier('svn', wc),
      authorizeRemote: async (url) => {
        authorizerCalls.push(url);
        return undefined;
      },
      onProgress: (completed, total) => progress.push([completed, total]),
    }, target);

    const byPath = new Map(outcome.records.map((record) => [record.path, record]));
    expect(byPath.has('text.txt')).toBe(true);
    expect(byPath.has('prop.txt')).toBe(true);
    expect(byPath.has('mixed.txt')).toBe(true);
    expect(byPath.has('binary.bin')).toBe(true);
    expect(byPath.has('tree-del.txt')).toBe(true);

    const text = byPath.get('text.txt')!;
    expect(text.kinds).toEqual(['text']);
    expect(text.contentKind).toBe('text');
    expect(text.baselineRevision).not.toBe(text.nodeBaseRevision);

    const binary = byPath.get('binary.bin')!;
    expect(binary.contentKind).toBe('binary');
    expect(binary.artifacts.some((artifact) => artifact.role === 'mine')).toBe(false);

    const mixed = byPath.get('mixed.txt')!;
    expect(mixed.kinds).toContain('text');
    expect(mixed.kinds).toContain('property');
    expect(mixed.propertyConflicts).toHaveLength(1);
    expect(mixed.propertyConflicts![0]!.local.value?.toString()).toBe('local');
    expect(mixed.propertyConflicts![0]!.base.value?.toString()).toBe('base');
    expect(mixed.propertyConflicts![0]!.incoming.value?.toString()).toBe('theirs');

    const prop = byPath.get('prop.txt')!;
    expect(prop.kinds).toEqual(['property']);
    expect(prop.propertyConflicts?.[0]?.name).toBe('k');

    const tree = byPath.get('tree-del.txt')!;
    expect(tree.kinds).toContain('tree');
    expect(tree.treeConflict?.reason).toBeTruthy();

    // 摘要按 kinds 项计数：text（text/binary/mixed）+ property（prop/mixed）+ tree
    expect(outcome.summary.text).toBe(3);
    expect(outcome.summary.property).toBe(2);
    expect(outcome.summary.tree).toBe(1);
    expect(outcome.summary.total).toBe(6);
    expect(outcome.failures).toEqual([]);
    expect(outcome.propertyValueFailures).toEqual([]);
    // file:// 来源不需要认证：authorizer 不应被调用（认证只在远端值补查时使用）。
    expect(authorizerCalls).toEqual([]);
    expect(progress.length).toBeGreaterThan(0);
    const last = progress.at(-1)!;
    expect(last[0]).toBe(last[1]);
  });

  it('属性补查后记录指纹与执行前重读一致（executeResolve 可直接比对）', async () => {
    built = buildConflictLab();
    const wc = built.wc;
    const outcome = await scanConflictScope({ svnPath: 'svn' }, conflictScopeOf(wc));
    const prop = outcome.records.find((record) => record.path === 'prop.txt')!;
    const reread = await readConflictRecord('svn', wc, 'prop.txt');
    expect(reread.record?.id).toBe(prop.id);
    expect(reread.record?.propertyConflicts?.length).toBe(prop.propertyConflicts?.length);
    // 混合路径（文本 + 属性）同样要求扫描指纹与执行前重读一致。
    const mixed = outcome.records.find((record) => record.path === 'mixed.txt')!;
    const mixedReread = await readConflictRecord('svn', wc, 'mixed.txt');
    expect(mixedReread.record?.id).toBe(mixed.id);
    expect(mixedReread.record?.kinds.sort()).toEqual([...mixed.kinds].sort());
  });

  it('范围过滤：子目录范围只保留范围内记录；整副本保留全部', async () => {
    built = buildConflictLab();
    const wc = built.wc;
    const outcome = await scanConflictScope({ svnPath: 'svn', readPropertyValues: false }, conflictScopeOf(wc));
    const whole = filterRecordsToConflictScope(conflictScopeOf(wc), outcome.records);
    expect(whole).toHaveLength(outcome.records.length);
    const sub = conflictScopeOf(wc, 'missing-dir');
    expect(filterRecordsToConflictScope(sub, outcome.records)).toEqual([]);
  });

  it('范围过滤：wcRoot 为符号链接路径（macOS /tmp、/var 形态）时先 realpath 归一，不误判为空', () => {
    // 显式构造符号链接根（等价于 macOS /tmp → /private/tmp），
    // 断言「祖先 realpath + 原始 fsPath 混算」不再导致空范围。
    const base = mkdtempSync(join(tmpdir(), 'svn-anywhere-scope-link-'));
    try {
      const realRoot = join(base, 'real-wc');
      mkdirSync(join(realRoot, 'sub'), { recursive: true });
      const linkRoot = join(base, 'link-wc');
      symlinkSync(realRoot, linkRoot, 'dir');
      const records = [
        makeRecord({ path: 'sub/file.txt' }),
        makeRecord({ path: 'missing-dir/victim.txt', kinds: ['tree'], contentKind: 'unknown' }),
        makeRecord({ path: 'other-dir/keep.txt' }),
      ];
      // 现存子目录范围：只保留 sub 下记录。
      expect(filterRecordsToConflictScope(conflictScopeOf(linkRoot, 'sub'), records)
        .map((record) => record.path)).toEqual(['sub/file.txt']);
      // 缺失子目录范围（树冲突 victim 祖先已删除）：最近存在祖先 realpath + 后缀回拼。
      expect(filterRecordsToConflictScope(conflictScopeOf(linkRoot, 'missing-dir'), records)
        .map((record) => record.path)).toEqual(['missing-dir/victim.txt']);
      // 整副本范围不裁记录。
      expect(filterRecordsToConflictScope(conflictScopeOf(linkRoot, '.'), records)).toHaveLength(3);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

/* ---------------------------------------------------------------------------
 * 文案对账
 * ------------------------------------------------------------------------- */

describe('文案对账', () => {
  it('CONFLICT_TEXT_DEFAULTS 与 i18n.conflictPanel 键值一致（新增文案全部走 i18n）', () => {
    const panel = strings.conflictPanel as unknown as Record<string, string>;
    for (const [key, value] of Object.entries(CONFLICT_TEXT_DEFAULTS)) {
      expect(panel[key], `i18n.conflictPanel 缺少或漂移：${key}`).toBe(value);
    }
  });

  it('REJECT_TEXT_DEFAULTS 与 i18n.resolvePanel 对应键一致', () => {
    const panel = strings.resolvePanel as unknown as Record<string, string>;
    for (const [reason, value] of Object.entries(REJECT_TEXT_DEFAULTS)) {
      const i18nKey = REJECT_TEXT_KEYS[reason as keyof typeof REJECT_TEXT_KEYS];
      expect(panel[i18nKey], `i18n.resolvePanel 缺少或漂移：${i18nKey}`).toBe(value);
    }
  });
});

/* ---------------------------------------------------------------------------
 * 内容分类与认证注入
 * ------------------------------------------------------------------------- */

describe('内容分类与认证注入', () => {
  it('MIME 非 text/* 或含 NUL 判二进制；无内容头为未知', () => {
    expect(classifyWorkingCopyContent('image/png', Buffer.from('abc'))).toBe('binary');
    expect(classifyWorkingCopyContent('text/plain', Buffer.from('abc'))).toBe('text');
    expect(classifyWorkingCopyContent('text/plain', Buffer.from([0x61, 0x00]))).toBe('binary');
    expect(classifyWorkingCopyContent(undefined, Buffer.from([0x61, 0x00]))).toBe('binary');
    expect(classifyWorkingCopyContent(undefined, Buffer.from('plain'))).toBe('text');
    expect(classifyWorkingCopyContent(undefined, undefined)).toBe('unknown');
    expect(classifyWorkingCopyContent('text/plain', undefined)).toBe('unknown');
  });

  it('createRemoteAuthorizer：只对 http/https/svn URL 注入 authScope 与凭据提供者', async () => {
    const provider = async () => ({ username: 'u', password: 'p' });
    const authorizer = createRemoteAuthorizer(provider);
    const base = { timeoutMs: 1000 } as const;
    const http = await authorizer('http://example.com/repo/f@2', base);
    expect(http?.authScope).toEqual({ scheme: 'http', host: 'example.com', port: 80 });
    expect(typeof http?.getCredentials).toBe('function');
    expect(await http?.getCredentials?.(http.authScope)).toEqual({ username: 'u', password: 'p' });
    expect(await authorizer('file:///tmp/repo/f@2', base)).toBeUndefined();
    expect(await authorizer('svn+ssh://example.com/repo/f@2', base)).toBeUndefined();
  });

  it('冲突范围归一化：空串与 ./ 都落到整副本', () => {
    expect(conflictScopeOf('/wc', '').scopeRelPath).toBe('.');
    expect(conflictScopeOf('/wc', './sub/dir/').scopeRelPath).toBe('sub/dir');
    expect(conflictScopeOf('/wc', 'sub/dir/').scopeRelPath).toBe('sub/dir');
  });
});
