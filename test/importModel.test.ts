/**
 * P3 导入面板状态机纯函数测试：对照交互状态清单 §三全部状态行逐行断言
 * （form/untested、testing、auth、testFailed、review/unchecked、checked、
 * sourceChanged、targetChanged、running、canceling、unknown 三分支、
 * failed、success；closed 是宿主视图态、不进 reducer），外加专项：
 * - 目标 URL 末段联动（源目录变化联动、手动保留、useDirName 恢复、
 *   encodeURIComponent 编码一次）；
 * - importNext 重走 normalizeImportTarget（尾 @ 编码 %40；非法输入拒绝发起）；
 * - 连接检查分支：父 kind≠dir / existing / auth / connectError / 通过；
 * - global-ignores 解析失败阻止勾选确认与开始；
 * - 源快照比对 scopeChanged 清勾选要求重新预览；
 * - 确认后重检 targetChanged 与网络失败分列（后者保留参数可重勾选）；
 * - 空说明二次确认标记；
 * - retryImport/abandonUnknownImport 两层回填（会话 form 优先/快照回填）；
 * - handoff 切 checkout 保留 URL/revMode='number'/revision；
 * - acknowledgeMerged settled 动作集切换；
 * - toDraft/fromDraft 导入字段往返（含 message/nameMode）。
 */
import { describe, expect, it } from 'vitest';
import { editableURL } from '../src/core/checkout';
import type {
  ImportBlockReason,
  ImportEnumeration,
  ImportSourceEntry,
  ParentIdentitySnapshot,
} from '../src/core/importDir';
import { createEmptyFormDraft } from '../src/host/panel/drafts';
import { strings } from '../src/host/i18n';
import {
  IMPORT_PREVIEW_SORT_DEFAULT,
  abandonUnknownImportReducer,
  acknowledgeMergedReducer,
  backToForm,
  beginImportTask,
  beginImportVerify,
  buildCheckoutPanelState,
  checkImportScope,
  connAuth,
  connAuthCancel,
  connAuthResume,
  consumeParentIdentity,
  createCheckoutPanelState,
  createImportPreviewFilters,
  fromDraft,
  handoffReducer,
  IMPORT_PREVIEW_PAGE_SIZE,
  importConnSettled,
  importConfirmBlockReason,
  importNextReducer,
  pickSourceDirReducer,
  retryImportReducer,
  setChecked,
  setConfirmState,
  setEmptyMessageConfirm,
  setImportResult,
  setPreview,
  setPreviewError,
  setRecheckOutcome,
  setSourcePrecheck,
  syncInput,
  taskPhase,
  toDraft,
  useDirName,
  type CheckoutPanelState,
  type ImportConnOutcome,
} from '../src/host/panel/checkoutModel';
import type { FooterSpec, PanelState } from '../src/host/panel/state';

/* ------------------------------- 构造辅助 ------------------------------- */

function importState(): CheckoutPanelState {
  return createCheckoutPanelState({ sessionId: 's1', entryKey: '/src', mode: 'import', history: [] });
}

/** 以 fromDraft 的正规路径设置初始 URL（保持 nameMode='auto'——syncInput url 会置 manual）。 */
function importStateWithUrl(url: string, sourceDir = ''): CheckoutPanelState {
  return fromDraft(importState(), {
    ...createEmptyFormDraft(),
    url,
    urlInput: url,
    sourceDir,
    nameMode: 'auto',
  });
}

const PARENT: ParentIdentitySnapshot = {
  repositoryUuid: 'uuid-1',
  repositoryRootUrl: 'http://example.com/svn',
  lastChangedRevision: 100,
};

const IMPORT_OK: ImportConnOutcome = { ok: true, parentIdentity: PARENT };

function entry(path: string, overrides: Partial<ImportSourceEntry> = {}): ImportSourceEntry {
  return {
    path,
    kind: 'file',
    size: 10,
    mtimeMs: 1,
    ignored: false,
    unreadable: false,
    nested: false,
    unsupported: false,
    ...overrides,
  };
}

/** 与 enumerateImportSource 同口径地汇总（模型测试不触文件系统，直接构造枚举数据）。 */
function enumerationOf(entries: ImportSourceEntry[], dirs: string[] = []): ImportEnumeration {
  let fileCount = 0;
  let totalBytes = 0;
  let specialItemCount = 0;
  let symlinkCount = 0;
  let unreadableCount = 0;
  let nestedCount = 0;
  let unsupportedCount = 0;
  const blockers = new Set<ImportBlockReason>();
  for (const item of entries) {
    if ((item.kind === 'file' || item.kind === 'symlink') && !item.ignored) {
      fileCount += 1;
      totalBytes += item.size;
    }
    if (item.kind === 'special') {
      specialItemCount += 1;
    }
    if (item.kind === 'symlink') {
      symlinkCount += 1;
    }
    if (item.unreadable) {
      unreadableCount += 1;
      blockers.add('unreadable');
    }
    if (item.nested) {
      nestedCount += 1;
      blockers.add('nested');
    }
    if (item.unsupported) {
      unsupportedCount += 1;
      blockers.add('unsupported');
    }
  }
  return {
    entries,
    dirs,
    summary: { fileCount, totalBytes, specialItemCount, symlinkCount, unreadableCount, nestedCount, unsupportedCount },
    blockers: [...blockers],
  };
}

/** 清单 §三 normal 场景：8 文件 + 2 忽略项。 */
function normalEnumeration(): ImportEnumeration {
  const files = Array.from({ length: 8 }, (_, i) => entry(`src/f${i}.ts`, { size: 100 + i }));
  const ignored = [entry('tmp.log', { ignored: true }), entry('build/out.js', { ignored: true })];
  return enumerationOf([...files, ...ignored], ['src', 'build']);
}

/** 走到核对页预览完成态的常用链：合法 URL → 下一步 → 检查通过 → 预览回填。 */
function toImportReview(url = 'http://example.com/svn/trunk/proj'): CheckoutPanelState {
  let s = importStateWithUrl(url);
  const next = importNextReducer(s);
  expect(next.issued).toBe(true);
  s = importConnSettled(next.state, next.seq, IMPORT_OK);
  return setPreview(s, normalEnumeration());
}

function actionIds(footer: FooterSpec | undefined): string[] {
  if (!footer) {
    return [];
  }
  const ids: string[] = [];
  if (footer.primary) {
    ids.push(footer.primary.id);
  }
  for (const action of footer.secondary ?? []) {
    ids.push(action.id);
  }
  return ids;
}

function fieldIds(panel: PanelState): string[] {
  return (panel.form?.fields ?? []).map((field) => field.id);
}

function fieldOf(panel: PanelState, id: string): { value: string; disabled?: boolean; error?: string } | undefined {
  return panel.form?.fields.find((field) => field.id === id);
}

/* ====================== 清单 §三：form / untested ====================== */

describe('清单 §三 form/untested：导入表单', () => {
  it('初始态：源目录/目标 URL/多行说明字段，源目录选择器与下一步可用', () => {
    const s = importState();
    expect(s.step).toBe('form');
    expect(s.conn.phase).toBe('untested');
    const panel = buildCheckoutPanelState(s);
    expect(fieldIds(panel)).toEqual(expect.arrayContaining(['url', 'sourceDir', 'message']));
    expect(panel.form?.fields.find((field) => field.id === 'message')?.type).toBe('textarea');
    expect(panel.form?.tools?.some((tool) => tool.id === 'pickSourceDir')).toBe(true);
    expect(panel.footer?.primary?.id).toBe('importNext');
    expect(panel.footer?.primary?.disabled).toBeFalsy();
  });

  it('pickSourceDirReducer：写源目录 + 预检占位（testing + 代次）+ auto 联动目标 URL 末段', () => {
    const s = importStateWithUrl('http://example.com/svn/trunk/old');
    const next = pickSourceDirReducer(s, '/data/我的 目录');
    expect(next.state.form.sourceDir).toBe('/data/我的 目录');
    expect(next.state.conn.phase).toBe('testing');
    expect(next.state.conn.pendingNext).toBe(false);
    expect(next.seq).toBe(1);
    // 末段替换（不是父 URL 末段追加）：old 被替换为编码一次的源目录名。
    expect(next.state.form.url).toBe(`http://example.com/svn/trunk/${encodeURIComponent('我的 目录')}`);
    expect(next.state.form.url).not.toContain('%25'); // 不双重编码
    // urlInput 是显示形态（中文可读、%20 等 ASCII 转义保留），form.url 是规范编码 URI。
    expect(next.state.form.urlInput).toBe('http://example.com/svn/trunk/我的%20目录');
  });

  it('占位期间「下一步」拒绝发起（预检未回填不发起连接检查）', () => {
    const s = pickSourceDirReducer(importStateWithUrl('http://example.com/svn/trunk/a'), '/data/src').state;
    const next = importNextReducer(s);
    expect(next.issued).toBe(false);
    expect(next.state).toBe(s);
  });

  it.each([
    ['unversioned', { status: 'unversioned' } as const, 'untested 放行'],
    ['versioned', { status: 'versioned' } as const, '改用提交'],
    ['missing', { status: 'missing', message: '源目录不存在：ENOENT' } as const, '源目录不存在'],
    ['notDir', { status: 'notDir', message: '源路径不是目录：/data/f' } as const, '源路径不是目录'],
    ['svnMissing', { status: 'svnMissing', message: 'spawn svn ENOENT' } as const, 'spawn svn ENOENT'],
    ['unknown', { status: 'unknown', message: 'E155015 wc.db 被锁' } as const, 'SVN 状态读取失败'],
  ])('setSourcePrecheck %s → %s', (name, result, expectText) => {
    const base = importStateWithUrl('http://example.com/svn/trunk/a');
    const next = pickSourceDirReducer(base, '/data/src');
    const settled = setSourcePrecheck(next.state, next.seq, result);
    if (name === 'unversioned') {
      expect(settled.conn.phase).toBe('untested');
      expect(settled.conn.error).toBeNull();
      return;
    }
    expect(settled.step).toBe('form');
    expect(settled.conn.phase).toBe('failed');
    expect(settled.conn.error).toContain(expectText);
    // 渲染为表单页 error 横幅（清单 form/testFailed 同款承载）。
    expect(buildCheckoutPanelState(settled).banners).toContainEqual(
      expect.objectContaining({ id: 'connError', level: 'error' }),
    );
  });

  it('预检失败后修改参数清除横幅（占位时定格的签名失效）', () => {
    const base = importStateWithUrl('http://example.com/svn/trunk/a');
    const next = pickSourceDirReducer(base, '/data/src');
    let s = setSourcePrecheck(next.state, next.seq, { status: 'versioned' });
    expect(s.conn.phase).toBe('failed');
    s = syncInput(s, 'sourceDir', '/data/other');
    expect(s.conn.phase).toBe('untested');
    expect(s.conn.error).toBeNull();
  });

  it('预检迟到回包按代次丢弃（源目录快速切换两次）', () => {
    const base = importStateWithUrl('http://example.com/svn/trunk/a');
    const first = pickSourceDirReducer(base, '/data/one');
    const second = pickSourceDirReducer(first.state, '/data/two');
    // 第一次预检的迟到失败回包不得污染第二次占位。
    const stale = setSourcePrecheck(second.state, first.seq, { status: 'versioned' });
    expect(stale).toBe(second.state);
  });
});

/* ============ 目标 URL 联动专项（编码一次 / 手动保留 / 恢复联动） ============ */

describe('目标 URL 末段联动', () => {
  it('特殊字符编码一次：中文/空格/@/# 都经 encodeURIComponent（# 不会被 encodeURI 漏掉）', () => {
    const s = importStateWithUrl('http://example.com/svn/trunk/old');
    const next = pickSourceDirReducer(s, '/data/a@b#c 中文');
    expect(next.state.form.url).toBe(`http://example.com/svn/trunk/${encodeURIComponent('a@b#c 中文')}`);
    expect(next.state.form.url).not.toContain('#');
    expect(next.state.form.url).toContain('a%40b%23c');
  });

  it('手动改 URL 后保留：syncInput url 置 manual，改源目录不覆盖', () => {
    let s = importStateWithUrl('http://example.com/svn/trunk/old');
    s = syncInput(s, 'url', 'http://example.com/svn/trunk/自定义');
    expect(s.form.nameMode).toBe('manual');
    expect(s.form.url).toBe(`http://example.com/svn/trunk/${encodeURIComponent('自定义')}`);
    const next = pickSourceDirReducer(s, '/data/src');
    expect(next.state.form.url).toBe(`http://example.com/svn/trunk/${encodeURIComponent('自定义')}`);
    // 手动模式下渲染「使用本地目录名」恢复联动。
    expect(buildCheckoutPanelState(next.state).form?.tools?.some((tool) => tool.id === 'useDirName')).toBe(true);
  });

  it('useDirName 恢复 auto 并立即按当前源目录联动末段', () => {
    let s = importStateWithUrl('http://example.com/svn/trunk/old');
    s = { ...s, form: { ...s.form, sourceDir: '/data/恢复' } };
    const manual = syncInput(s, 'url', 'http://example.com/svn/trunk/手动');
    expect(manual.form.nameMode).toBe('manual');
    const restored = useDirName(manual);
    expect(restored.form.nameMode).toBe('auto');
    expect(restored.form.url).toBe(`http://example.com/svn/trunk/${encodeURIComponent('恢复')}`);
  });

  it('手动输入源目录（syncInput sourceDir）同样联动；URL 无路径段时不联动', () => {
    let s = importStateWithUrl('http://example.com/svn/trunk/old');
    s = syncInput(s, 'sourceDir', '/data/输入名');
    expect(s.form.url).toBe(`http://example.com/svn/trunk/${encodeURIComponent('输入名')}`);
    // 仅 scheme://authority 无末段可替换：保持原值。
    const bare = importStateWithUrl('http://example.com');
    const next = syncInput(bare, 'sourceDir', '/data/src');
    expect(next.form.url).toBe('http://example.com');
  });

  it('尾斜杠 URL 的末段替换落在最后一个非空段（trunk 被替换，不追加）', () => {
    const s = importStateWithUrl('http://example.com/svn/trunk/');
    const next = pickSourceDirReducer(s, '/data/name');
    expect(next.state.form.url).toBe(`http://example.com/svn/${encodeURIComponent('name')}`);
  });
});

/* ============== 清单 §三：form/testing、auth、testFailed ============== */

describe('清单 §三 form/testing、auth、testFailed：连接检查', () => {
  it('importNext：urlInput 重走 normalizeImportTarget，发起态 testing + 代次 + 自动前进', () => {
    const s = importStateWithUrl('http://example.com/svn/trunk/c@d');
    const next = importNextReducer(s);
    expect(next.issued).toBe(true);
    expect(next.state.conn.phase).toBe('testing');
    expect(next.state.conn.pendingNext).toBe(true);
    // 路径中段的 @ 合法保留（命令层走 escapeUrlPeg）；只有末尾字面 @ 才编码 %40。
    expect(next.state.conn.signature).toBe('import|http://example.com/svn/trunk/c@d|');
    expect(next.seq).toBe(1);
  });

  it('尾 @ 三步一体：urlInput 末段字面 @ 编码为 %40（仅尾 @，中段 @ 合法保留；方案 §5 示例形态）', () => {
    let s = importState();
    s = syncInput(s, 'url', 'http://example.com/svn/trunk/c@d@');
    expect(s.form.url).toBe('http://example.com/svn/trunk/c@d%40');
    expect(s.form.urlInput).toBe('http://example.com/svn/trunk/c@d@'); // 显示值保持用户原输入
    const next = importNextReducer(s);
    expect(next.issued).toBe(true);
    expect(next.state.form.url).toBe('http://example.com/svn/trunk/c@d%40');
  });

  it('非法 urlInput（query/fragment/裸中文未编码路径外的拒绝项）拒绝发起并置 urlError', () => {
    let s = importState();
    s = syncInput(s, 'url', 'http://example.com/svn/trunk/x?rev=1');
    const next = importNextReducer(s);
    expect(next.issued).toBe(false);
    expect(next.state.step).toBe('form');
    expect(next.state.form.urlError).toBeTruthy();
    // 空 URL 同样拒绝。
    const empty = importNextReducer(importState());
    expect(empty.issued).toBe(false);
  });

  it('父 kind≠dir：拒绝放行核对，conn.error「父路径不是目录」', () => {
    const s = importStateWithUrl('http://example.com/svn/file.txt/newdir');
    const next = importNextReducer(s);
    const settled = importConnSettled(next.state, next.seq, { ok: false, failure: 'parentNotDir' });
    expect(settled.step).toBe('form');
    expect(settled.conn.phase).toBe('failed');
    expect(settled.conn.error).toContain('父路径不是目录');
  });

  it('existing：目标已存在 → conn.error 提示修改 URL 重测', () => {
    const s = importStateWithUrl('http://example.com/svn/trunk/exists');
    const next = importNextReducer(s);
    const settled = importConnSettled(next.state, next.seq, { ok: false, failure: 'targetExists' });
    expect(settled.conn.phase).toBe('failed');
    expect(settled.conn.error).toContain('远端目标已存在');
    expect(settled.step).toBe('form');
  });

  it('auth：转入认证补录相位，resume 回 testing、cancel 回 untested', () => {
    const s = importStateWithUrl('http://example.com/svn/trunk/proj');
    const next = importNextReducer(s);
    let settled = importConnSettled(next.state, next.seq, { ok: false, failure: 'auth', message: '认证失败' });
    expect(settled.conn.phase).toBe('auth');
    settled = connAuthResume(settled);
    expect(settled.conn.phase).toBe('testing');
    settled = connAuth(settled);
    const cancelled = connAuthCancel(settled);
    expect(cancelled.conn.phase).toBe('untested');
  });

  it('connectError：网络失败原文进 conn.error', () => {
    const s = importStateWithUrl('http://example.com/svn/trunk/proj');
    const next = importNextReducer(s);
    const settled = importConnSettled(next.state, next.seq, {
      ok: false,
      failure: 'connectError',
      message: 'E175002 无法连接',
    });
    expect(settled.conn.error).toBe('E175002 无法连接');
    expect(settled.conn.phase).toBe('failed');
  });

  it('通过：conn.success + 父身份快照写入 review.parentIdentity + 自动进核对页', () => {
    const s = importStateWithUrl('http://example.com/svn/trunk/proj');
    const next = importNextReducer(s);
    const settled = importConnSettled(next.state, next.seq, IMPORT_OK);
    expect(settled.step).toBe('review');
    expect(settled.conn.phase).toBe('success');
    expect(settled.review.parentIdentity).toEqual(PARENT);
  });

  it('迟到回包按代次丢弃；参数编辑失效检查并清除父身份', () => {
    const s = importStateWithUrl('http://example.com/svn/trunk/proj');
    const first = importNextReducer(s);
    // 参数编辑（URL 变化）→ 签名失效 → 旧回包丢弃、parentIdentity 不写。
    const edited = syncInput(first.state, 'url', 'http://example.com/svn/trunk/other');
    expect(edited.conn.phase).toBe('untested');
    const stale = importConnSettled(edited, first.seq, IMPORT_OK);
    expect(stale).toBe(edited);
    expect(stale.review.parentIdentity).toBeNull();
  });

  it('review 后返回表单改 URL：父身份快照清除（旧父身份不得用于新目标）', () => {
    let s = toImportReview();
    s = backToForm(s);
    s = syncInput(s, 'url', 'http://example.com/svn/trunk/other');
    expect(s.review.parentIdentity).toBeNull();
    expect(s.conn.phase).toBe('untested');
  });
});

/* ============ 清单 §三：review/unchecked 与范围预览 ============ */

describe('清单 §三 review/unchecked：范围预览', () => {
  it('可见信息：文件表（TableSpec）+ 计数汇总 + 说明 + 原目录仍未版本控制 + 勾选控件', () => {
    const s = toImportReview();
    const panel = buildCheckoutPanelState(s);
    expect(panel.steps?.current).toBe(1);
    expect(panel.table?.id).toBe('importPreview');
    expect(panel.table?.columns.map((column) => column.key)).toEqual(['path', 'kind', 'size', 'state']);
    expect(panel.table?.pagination.total).toBe(10); // 8 文件 + 2 忽略（全量条目）
    expect(panel.table?.rows).toHaveLength(10);
    const ignoredRow = panel.table?.rows.find((row) => row.cells.path === 'tmp.log');
    expect(ignoredRow?.cells.state).toContain('忽略');
    const fileRow = panel.table?.rows.find((row) => row.cells.path === 'src/f0.ts');
    expect(fileRow?.cells.state).toContain('将导入');
    const byId = new Map((panel.form?.fields ?? []).map((field) => [field.id, field.value]));
    expect(byId.get('reviewFileCount')).toBe('8 项');
    expect(byId.get('reviewIgnoredCount')).toBe('2');
    expect(byId.get('reviewSymlinkCount')).toBe('0');
    expect(byId.get('reviewTotalBytes')).toBe('828 B'); // 100+101+…+107
    expect(fieldIds(panel)).toContain('reviewSourceUnversioned');
    expect(fieldOf(panel, 'checked')?.disabled).toBeFalsy();
  });

  it('分页：超过一页时按宿主传入页码切片（sliceTableRows，pageSize=50）', () => {
    const many = enumerationOf(Array.from({ length: 60 }, (_, i) => entry(`f${i}.txt`)));
    let s = importStateWithUrl('http://example.com/svn/trunk/proj');
    const next = importNextReducer(s);
    s = importConnSettled(next.state, next.seq, IMPORT_OK);
    s = setPreview(s, many);
    const page1 = buildCheckoutPanelState(s);
    expect(page1.table?.pagination).toEqual({ page: 1, pageSize: IMPORT_PREVIEW_PAGE_SIZE, total: 60, pageCount: 2 });
    expect(page1.table?.rows).toHaveLength(IMPORT_PREVIEW_PAGE_SIZE);
    const page2 = buildCheckoutPanelState(s, { importPreviewPage: 2 });
    expect(page2.table?.pagination.page).toBe(2);
    expect(page2.table?.rows).toHaveLength(10);
  });

  it('允许动作：返回、确认勾选、关闭；未勾选不能开始', () => {
    const s = toImportReview();
    const footer = buildCheckoutPanelState(s).footer;
    expect(footer?.primary?.id).toBe('startImport');
    expect(footer?.primary?.disabled).toBe(true);
    expect(footer?.primary?.disabledReason).toBeTruthy();
    expect(actionIds(footer)).toEqual(expect.arrayContaining(['checkoutBack', 'closePanel']));
  });

  it('预览未回填（快照 null）：无表格、勾选禁用（正在生成范围预览）', () => {
    let s = importStateWithUrl('http://example.com/svn/trunk/proj');
    const next = importNextReducer(s);
    s = importConnSettled(next.state, next.seq, IMPORT_OK);
    const panel = buildCheckoutPanelState(s);
    expect(panel.table).toBeUndefined();
    expect(fieldOf(panel, 'checked')?.disabled).toBe(true);
    expect(importConfirmBlockReason(s.review)).toBeTruthy();
  });

  /** 走到核对页并装载自定义条目集（排序/筛选回喂用例的夹具）。 */
  function reviewWith(entries: ImportSourceEntry[]): CheckoutPanelState {
    let s = importStateWithUrl('http://example.com/svn/trunk/proj');
    const next = importNextReducer(s);
    s = importConnSettled(next.state, next.seq, IMPORT_OK);
    return setPreview(s, enumerationOf(entries));
  }

  it('排序回喂：点表头切列与方向；size 按字节数值排序（不按展示字符串）', () => {
    // 字节值 900/1000/80：数值降序应为 b(1000)→a(900)→c(80)；展示字符串
    // 排序会把「1000 B」排在「80 B」之前、与数值序在 a/c 间分叉。
    const s = reviewWith([
      entry('a.ts', { size: 900 }),
      entry('b.ts', { size: 1000 }),
      entry('c.ts', { size: 80 }),
    ]);
    const panel = buildCheckoutPanelState(s, { importPreviewSort: { key: 'size', direction: 'desc' } });
    expect(panel.table?.sort).toEqual({ key: 'size', direction: 'desc' });
    expect(panel.table?.rows.map((row) => row.cells.path)).toEqual(['b.ts', 'a.ts', 'c.ts']);
    const asc = buildCheckoutPanelState(s, { importPreviewSort: { key: 'path', direction: 'desc' } });
    expect(asc.table?.rows.map((row) => row.cells.path)).toEqual(['c.ts', 'b.ts', 'a.ts']);
  });

  it('排序缺省回退路径升序（IMPORT_PREVIEW_SORT_DEFAULT）', () => {
    const s = reviewWith([entry('b.ts'), entry('a.ts')]);
    const panel = buildCheckoutPanelState(s);
    expect(panel.table?.sort).toEqual(IMPORT_PREVIEW_SORT_DEFAULT);
    expect(panel.table?.rows.map((row) => row.cells.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('筛选回喂：path 文本大小写不敏感子串匹配；state select 精确匹配', () => {
    const t = strings.checkoutPanel;
    const s = reviewWith([
      entry('src/a.ts', { size: 1 }),
      entry('src/B.ts', { size: 2 }),
      entry('doc/x.md', { size: 3 }),
      entry('tmp.log', { ignored: true }),
    ]);
    // 「SRC」大写输入匹配小写路径 src（宿主侧 text 筛选不区分大小写）。
    const byPath = buildCheckoutPanelState(s, { importPreviewFilters: createImportPreviewFilters('SRC') });
    expect(byPath.table?.rows.map((row) => row.cells.path)).toEqual(['src/B.ts', 'src/a.ts']);
    expect(byPath.table?.filters?.find((filter) => filter.id === 'previewPath')?.value).toBe('SRC');
    // state 精确筛选「将忽略」：只剩忽略项。
    const byState = buildCheckoutPanelState(s, {
      importPreviewFilters: createImportPreviewFilters('', t.previewStateIgnored),
    });
    expect(byState.table?.rows.map((row) => row.cells.path)).toEqual(['tmp.log']);
    expect(byState.table?.pagination.total).toBe(1);
  });

  it('筛选后总数/页数随匹配收敛（重置页码的数据基础由宿主视图状态承担）', () => {
    const many = Array.from({ length: 60 }, (_, i) => entry(`f${String(i).padStart(2, '0')}.txt`));
    const s = reviewWith(many);
    const filtered = buildCheckoutPanelState(s, { importPreviewFilters: createImportPreviewFilters('f5') });
    expect(filtered.table?.pagination.total).toBe(10); // f50..f59
    expect(filtered.table?.pagination.pageCount).toBe(1);
    // 请求页码越界（旧页码 2）在筛选后收敛到最后一页。
    const clamped = buildCheckoutPanelState(s, {
      importPreviewPage: 2,
      importPreviewFilters: createImportPreviewFilters('f5'),
    });
    expect(clamped.table?.pagination.page).toBe(1);
  });
});

/* =============== 清单 §三：review/checked（勾选与确认框） =============== */

describe('清单 §三 review/checked：勾选确认与开始', () => {
  it('setChecked(true)：已核对范围，开始按钮解禁；开始 → 仓库提交确认框标记', () => {
    let s = toImportReview();
    s = setChecked(s, true);
    expect(s.review.checked).toBe(true);
    const footer = buildCheckoutPanelState(s).footer;
    expect(footer?.primary?.disabled).toBeFalsy();
    // 点开始 → 确认框打开（模型标记；Esc 关闭不发起，勾选保留）。
    s = setConfirmState(s, true);
    expect(s.review.confirmPending).toBe(true);
    s = setConfirmState(s, false);
    expect(s.review.confirmPending).toBe(false);
    expect(s.review.checked).toBe(true);
  });

  it('阻止条目（blockers）时勾选被拒（checkbox disabled 与 setChecked 守卫同源）', () => {
    let s = toImportReview();
    s = setPreview(s, enumerationOf([
      entry('a.txt'),
      entry('fifo', { kind: 'special', unsupported: true }),
    ]));
    const panel = buildCheckoutPanelState(s);
    expect(fieldOf(panel, 'checked')?.disabled).toBe(true);
    expect(setChecked(s, true)).toBe(s);
    // blockers 错误横幅可见（无法确认完整导入范围）。
    expect(panel.banners).toContainEqual(expect.objectContaining({ id: 'importBlockers', level: 'error' }));
  });

  it('global-ignores 解析失败：错误横幅 + 强制未勾选，阻止勾选确认与开始', () => {
    let s = toImportReview();
    s = setPreviewError(s, '忽略规则读取失败，无法确认忽略范围');
    expect(s.review.previewError).toBe(true);
    expect(s.review.checked).toBe(false);
    const panel = buildCheckoutPanelState(s);
    expect(panel.banners).toContainEqual(
      expect.objectContaining({ id: 'reviewError', level: 'error', detail: '忽略规则读取失败，无法确认忽略范围' }),
    );
    expect(setChecked(s, true)).toBe(s);
    // 修复配置后重新预览即可继续（previewError 复位）。
    s = setPreview(s, normalEnumeration());
    expect(s.review.previewError).toBe(false);
    expect(setChecked(s, true).review.checked).toBe(true);
  });

  it('无可导入文件（仅空目录/全忽略）：提示并不提供只创建空目录', () => {
    let s = toImportReview();
    s = setPreview(s, enumerationOf([entry('tmp.log', { ignored: true })], ['emptydir']));
    expect(s.review.error).toContain('没有可导入的文件');
    expect(setChecked(s, true)).toBe(s);
    const panel = buildCheckoutPanelState(s);
    expect(fieldOf(panel, 'checked')?.disabled).toBe(true);
  });

  it('空说明二次确认标记：置位渲染 info 横幅（dismissable:false），确认后清除', () => {
    let s = toImportReview();
    s = setEmptyMessageConfirm(s, true);
    const pending = buildCheckoutPanelState(s);
    expect(pending.banners).toContainEqual(
      expect.objectContaining({ id: 'emptyMessageConfirm', level: 'info', dismissable: false }),
    );
    s = setEmptyMessageConfirm(s, false);
    expect(buildCheckoutPanelState(s).banners.some((banner) => banner.id === 'emptyMessageConfirm')).toBe(false);
  });
});

/* ============ 清单 §三：review/sourceChanged（快照比对） ============ */

describe('清单 §三 review/sourceChanged：源快照比对', () => {
  it('预览后源目录新增文件：digest 不一致 → scopeChanged=source、清勾选、要求重新预览', () => {
    let s = toImportReview();
    s = setChecked(s, true);
    const changed = checkImportScope(s, enumerationOf([
      ...normalEnumeration().entries,
      entry('src/new.ts'),
    ], normalEnumeration().dirs));
    expect(changed.review.scopeChanged).toBe('source');
    expect(changed.review.checked).toBe(false);
    expect(changed.review.confirmPending).toBe(false);
    expect(changed.review.error).toContain('源目录内容已变化');
    // 允许动作：重新预览 → 再勾选（清单 §三 sourceChanged 行）。
    const footer = buildCheckoutPanelState(changed).footer;
    expect(actionIds(footer)).toContain('refreshImportPreview');
    expect(setChecked(changed, true)).toBe(changed); // 旧范围不能直接提交（勾选被拒）
  });

  it('快照一致：原样返回（引用不变，流程继续），不置 scopeChanged', () => {
    const s = toImportReview();
    const same = checkImportScope(s, normalEnumeration());
    expect(same).toBe(s);
    expect(same.review.scopeChanged).toBeNull();
  });

  it('重新预览后：scopeChanged/勾选复位，可再次确认', () => {
    let s = toImportReview();
    const changed = checkImportScope(s, enumerationOf([entry('only.ts')]));
    expect(changed.review.scopeChanged).toBe('source');
    s = setPreview(changed, normalEnumeration());
    expect(s.review.scopeChanged).toBeNull();
    expect(s.review.checked).toBe(false);
    expect(setChecked(s, true).review.checked).toBe(true);
  });

  it('仅内容变化（size/mtime）同样判为 sourceChanged（digest 覆盖全量清单）', () => {
    const s = toImportReview();
    const entries = normalEnumeration().entries.map((item) => (item.path === 'src/f0.ts' ? { ...item, size: 999 } : item));
    const changed = checkImportScope(s, enumerationOf(entries, normalEnumeration().dirs));
    expect(changed.review.scopeChanged).toBe('source');
  });
});

/* ============ 清单 §三：review/targetChanged（确认后重检） ============ */

describe('清单 §三 review/targetChanged：确认后完整重检', () => {
  it('父身份不一致（identityChanged）→ scopeChanged=target、清勾选、提示重新测试核对', () => {
    let s = toImportReview();
    s = setChecked(s, true);
    s = setRecheckOutcome(s, { ok: false, failure: 'identityChanged', message: '父目录仓库身份已变化，请重新测试核对' });
    expect(s.review.scopeChanged).toBe('target');
    expect(s.review.checked).toBe(false);
    expect(s.review.error).toContain('重新测试核对');
    // targetChanged 后不允许直接再勾选（须返回修改 URL 重新核对）。
    expect(setChecked(s, true)).toBe(s);
    expect(buildCheckoutPanelState(s).banners).toContainEqual(
      expect.objectContaining({ id: 'reviewError', level: 'error' }),
    );
  });

  it('目标已存在（targetExists）与父变文件节点（parentNotDir）同样按 targetChanged 分列', () => {
    for (const failure of ['targetExists', 'parentNotDir'] as const) {
      let s = toImportReview();
      s = setChecked(s, true);
      s = setRecheckOutcome(s, { ok: false, failure, message: '远端目标已存在' });
      expect(s.review.scopeChanged, failure).toBe('target');
      expect(s.review.checked).toBe(false);
    }
  });

  it('网络/认证失败：与 targetChanged 分列——review 错误横幅 + 清确认保留参数，可重勾选再走重检', () => {
    for (const failure of ['parentUnreachable', 'targetCheckFailed'] as const) {
      let s = toImportReview();
      s = setChecked(s, true);
      s = setRecheckOutcome(s, { ok: false, failure, message: 'E175002 网络不可达' });
      expect(s.review.scopeChanged, failure).toBeNull(); // 不置 targetChanged
      expect(s.review.checked).toBe(false);
      expect(s.review.error).toContain('E175002');
      expect(s.form.url).toBe('http://example.com/svn/trunk/proj'); // 参数保留
      expect(s.step).toBe('review'); // 不进 result 失败页（命令未发出）
      expect(s.result).toBeNull();
      // 重新勾选可再点开始重走重检（未勾选期间开始禁用）。
      const rechecked = setChecked(s, true);
      expect(rechecked.review.checked).toBe(true);
      expect(buildCheckoutPanelState(s).footer?.primary?.disabled).toBe(true); // 未勾选时开始禁用
    }
  });

  it('重检通过：错误横幅清除，lastChangedRevision 刷新为重检时读取值', () => {
    let s = toImportReview();
    s = setRecheckOutcome(s, { ok: false, failure: 'parentUnreachable', message: '网络抖动' });
    expect(s.review.error).toBeTruthy();
    const rechecked: ParentIdentitySnapshot = { ...PARENT, lastChangedRevision: 105 };
    s = setRecheckOutcome(s, { ok: true, parentIdentity: rechecked });
    expect(s.review.error).toBeNull();
    expect(s.review.parentIdentity).toEqual(rechecked);
    expect(s.review.parentIdentity?.lastChangedRevision).toBe(105);
  });

  it('consumeParentIdentity：begin 落盘后、紧邻写命令前清除（失败保留口径的对照）', () => {
    let s = toImportReview();
    s = consumeParentIdentity(s);
    expect(s.review.parentIdentity).toBeNull();
  });
});

/* ============ 清单 §三：running 与 canceling ============ */

describe('清单 §三 running/canceling：执行与取消', () => {
  it('beginImportTask：running 步、任务镜像 connecting、绑定 resultScope 与源目录目标', () => {
    let s = toImportReview();
    s = setChecked(s, true);
    s = beginImportTask(s, { opId: 'op-9', targetPath: '/data/src' });
    expect(s.step).toBe('running');
    expect(s.task).toEqual({ phase: 'connecting', currentFile: null, count: 0, opId: 'op-9' });
    expect(s.binding).toEqual({ resultScope: { entryKey: '/src', mode: 'import' }, targetPath: '/data/src' });
    expect(s.result).toBeNull();
  });

  it('运行页可见信息与动作：进度行、取消/日志/关闭；canceling 禁重复取消', () => {
    let s = beginImportTask(toImportReview(), { opId: 'op-9', targetPath: '/data/src' });
    s = taskPhase(s, 'running');
    const running = buildCheckoutPanelState(s);
    expect(running.busy).toBe(true);
    expect(actionIds(running.footer)).toEqual(expect.arrayContaining(['cancelTask', 'viewTaskLog', 'closePanel']));
    s = taskPhase(s, 'canceling');
    const canceling = buildCheckoutPanelState(s).footer;
    expect(canceling?.primary?.disabled).toBe(true);
    expect(canceling?.primary?.disabledReason).toContain('等待退出');
  });
});

/* ============ 清单 §三：unknown 与核实三分支 ============ */

describe('清单 §三 unknown：结果未知页与核实', () => {
  it('unknown：只允许核实/日志/关闭——无开始/重试/新建/返回填写入口', () => {
    const s = setImportResult(importState(), { kind: 'unknown', path: '/data/src', detail: '结果未知' });
    expect(s.result?.mode).toBe('import');
    const footer = buildCheckoutPanelState(s).footer;
    const ids = actionIds(footer);
    expect(ids).toEqual(['verifyImport', 'viewTaskLog', 'closePanel']);
    for (const forbidden of ['startImport', 'retryImport', 'newTask', 'checkoutBack']) {
      expect(ids).not.toContain(forbidden);
    }
  });

  it('快照不完整分支（snapshotIncomplete）另挂「放弃核实并解除限制」', () => {
    const s = setImportResult(importState(), { kind: 'unknown', path: '/data/src', snapshotIncomplete: true });
    expect(actionIds(buildCheckoutPanelState(s).footer)).toEqual([
      'verifyImport',
      'abandonUnknownImport',
      'viewTaskLog',
      'closePanel',
    ]);
  });

  it('核实发起时重置 snapshotIncomplete（旧 true 不残留「放弃核实」动作）', () => {
    let s = setImportResult(importState(), { kind: 'unknown', path: '/data/src', snapshotIncomplete: true });
    s = beginImportVerify(s);
    expect(s.result?.mode === 'import' && s.result.kind === 'unknown' && s.result.snapshotIncomplete).toBeUndefined();
    expect(actionIds(buildCheckoutPanelState(s).footer)).toEqual(['verifyImport', 'viewTaskLog', 'closePanel']);
    // 非 unknown 页与未置标志页原样返回（幂等守卫）。
    const merged = setImportResult(importState(), { kind: 'merged', revision: 3, path: '/data/src' });
    expect(beginImportVerify(merged)).toBe(merged);
  });

  it("unknown → unresolved：证据不唯一保持 unknown（resolution='unresolved'）", () => {
    const s = setImportResult(importState(), {
      kind: 'unknown',
      path: '/data/src',
      resolution: 'unresolved',
      detail: '仓库不可达',
    });
    if (s.result?.mode === 'import') {
      expect(s.result.kind).toBe('unknown');
      expect(s.result.resolution).toBe('unresolved');
    }
    expect(actionIds(buildCheckoutPanelState(s).footer)).toEqual(['verifyImport', 'viewTaskLog', 'closePanel']);
  });

  it('unknown → notCommitted：核实确认未提交 → 失败页（evidence=verified）可返回填写并重试', () => {
    const s = setImportResult(importState(), {
      kind: 'failed',
      path: '/data/src',
      evidence: 'verified',
      detail: '证据确认未提交',
      formSnapshot: { url: 'http://example.com/svn/trunk/proj', sourceDir: '/data/src', message: '说明', nameMode: 'auto' },
    });
    if (s.result?.mode === 'import') {
      expect(s.result.kind).toBe('failed');
      expect(s.result.evidence).toBe('verified');
      expect(s.result.formSnapshot?.sourceDir).toBe('/data/src');
    }
    expect(actionIds(buildCheckoutPanelState(s).footer)).toEqual(['retryImport', 'viewTaskLog', 'closePanel']);
  });

  it('unknown → committed：核实已提交 → 成功页（evidence=verified、禁止再提交一次）', () => {
    const s = setImportResult(importState(), {
      kind: 'success',
      revision: 1281,
      path: '/data/src',
      evidence: 'verified',
    });
    expect(actionIds(buildCheckoutPanelState(s).footer)).toEqual([
      'handoffToCheckout',
      'revealSourceDir',
      'newTask',
      'viewTaskLog',
      'closePanel',
    ]);
  });

  it('abandonUnknownImport：回表单、保留表单值（两层回填）、清结果页', () => {
    let s = importState();
    s = setImportResult(s, {
      kind: 'unknown',
      path: '/data/src',
      snapshotIncomplete: true,
      formSnapshot: { url: 'http://example.com/svn/trunk/proj', sourceDir: '/data/src', message: '待重填', nameMode: 'manual' },
    });
    s = { ...s, form: { ...s.form, url: '', urlInput: '' } }; // 模拟重启后 form 已空
    const back = abandonUnknownImportReducer(s);
    expect(back.step).toBe('form');
    expect(back.result).toBeNull();
    expect(back.form.url).toBe('http://example.com/svn/trunk/proj');
    expect(back.form.sourceDir).toBe('/data/src');
    expect(back.form.message).toBe('待重填');
    expect(back.form.nameMode).toBe('manual');
    expect(back.conn.phase).toBe('untested'); // 重新发起走完整连接检查
  });
});

/* ==================== 清单 §三：failed 与 retryImport ==================== */

describe('清单 §三 failed：返回填写并重试', () => {
  it('failed：已确认未提交及原因可见，动作 = 重试/日志/关闭', () => {
    const s = setImportResult(importState(), {
      kind: 'failed',
      path: '/data/src',
      detail: 'E160020 目标已存在同名文件',
      formSnapshot: { url: 'http://example.com/svn/trunk/proj', sourceDir: '/data/src', message: '', nameMode: 'auto' },
    });
    const panel = buildCheckoutPanelState(s);
    expect(actionIds(panel.footer)).toEqual(['retryImport', 'viewTaskLog', 'closePanel']);
    expect(fieldOf(panel, 'resultDetail')?.value).toContain('E160020');
  });

  it('结果页标题按 mode 分列：导入失败页显示「已确认未提交」，不带检出「文件保留」语义', () => {
    const s = setImportResult(importState(), { kind: 'failed', path: '/data/src', detail: '原因' });
    const banners = buildCheckoutPanelState(s).banners;
    expect(banners).toContainEqual(
      expect.objectContaining({ id: 'result.failed', level: 'error', title: strings.checkoutPanel.importResultTitles.failed }),
    );
    expect(banners.some((banner) => banner.title.includes('文件保留'))).toBe(false);
    // 成功页同表分列（导入完成 ≠ 检出完成）。
    const ok = setImportResult(importState(), { kind: 'success', revision: 1281, path: '/data/src' });
    expect(buildCheckoutPanelState(ok).banners).toContainEqual(
      expect.objectContaining({ id: 'result.success', title: strings.checkoutPanel.importResultTitles.success }),
    );
  });

  it('retryImport 两层回填：会话 form 非空优先 form（用户可能已就地修改）', () => {
    let s = importState();
    s = { ...s, form: { ...s.form, url: 'http://session/x', urlInput: 'http://session/x', sourceDir: '/session', message: '会话说明', nameMode: 'auto' } };
    s = setImportResult(s, {
      kind: 'failed',
      path: '/data/src',
      formSnapshot: { url: 'http://snapshot/y', sourceDir: '/snapshot', message: '快照说明', nameMode: 'manual' },
    });
    const back = retryImportReducer(s);
    expect(back.form.url).toBe('http://session/x');
    expect(back.form.sourceDir).toBe('/session');
    expect(back.form.message).toBe('会话说明');
  });

  it('retryImport 快照回填：form 空（关闭重开/重启）时按 formSnapshot 回填，urlInput 派生显示值', () => {
    let s = importState();
    s = setImportResult(s, {
      kind: 'failed',
      path: '/data/src',
      formSnapshot: { url: 'http://example.com/svn/trunk/%E4%B8%AD', sourceDir: '/data/src', message: '多行\n说明', nameMode: 'manual' },
    });
    s = { ...s, form: { ...s.form, url: '', urlInput: '', sourceDir: '', message: '' } };
    const back = retryImportReducer(s);
    expect(back.form.url).toBe('http://example.com/svn/trunk/%E4%B8%AD');
    expect(back.form.urlInput).toBe(editableURL('http://example.com/svn/trunk/%E4%B8%AD'));
    expect(back.form.sourceDir).toBe('/data/src');
    expect(back.form.message).toBe('多行\n说明');
    expect(back.form.nameMode).toBe('manual'); // nameMode 透传：手动命名不退 auto
    expect(back.conn.phase).toBe('untested'); // 重试需重新测试与核对
    expect(back.review.checked).toBe(false);
    expect(back.binding).toBeNull();
  });
});

/* ============ 清单 §三：success 与 handoff（另选新目录检出） ============ */

describe('清单 §三 success：成功页与交接', () => {
  function successState(): CheckoutPanelState {
    let s = importState();
    s = { ...s, form: { ...s.form, url: 'http://example.com/svn/trunk/%E6%96%B0%E7%9B%AE%E5%BD%95' } };
    return setImportResult(s, { kind: 'success', revision: 1281, path: '/data/src', evidence: 'command' });
  }

  it('success：r1281 与原目录仍未版本控制说明可见；四项动作完整', () => {
    const s = successState();
    const panel = buildCheckoutPanelState(s);
    expect(fieldOf(panel, 'resultRevision')?.value).toBe('r1281');
    expect(fieldOf(panel, 'resultPath')?.value).toBe('/data/src');
    expect(actionIds(panel.footer)).toEqual(['handoffToCheckout', 'revealSourceDir', 'newTask', 'viewTaskLog', 'closePanel']);
  });

  it('handoff：切 checkout 模式、保留 URL、revMode=number + revision、子目录名按 URL 联动', () => {
    const s = successState();
    const h = handoffReducer(s);
    expect(h.mode).toBe('checkout');
    expect(h.entry.mode).toBe('checkout');
    expect(h.step).toBe('form');
    expect(h.form.url).toBe('http://example.com/svn/trunk/%E6%96%B0%E7%9B%AE%E5%BD%95');
    expect(h.form.revMode).toBe('number');
    expect(h.form.rev).toBe('1281');
    expect(h.form.nameMode).toBe('auto');
    expect(h.form.dirName).toBe('新目录'); // 检出侧 auto 联动（URL 末段单次解码）
    expect(h.result).toBeNull();
    expect(h.conn.phase).toBe('untested');
  });

  it('handoff 后仍要求完整测试核对：开始动作回到 startCheckout（不覆盖原目录）', () => {
    const h = handoffReducer(successState());
    const panel = buildCheckoutPanelState(h);
    expect(panel.footer?.primary?.id).toBe('checkoutNext');
    expect(fieldIds(panel)).not.toContain('sourceDir');
  });
});

/* ============ merged：acknowledgeMerged 收口与 settled 动作集 ============ */

describe('merged：人工核对收口', () => {
  it('merged 页动作集 = 确认收口 + 核实 + 日志；提示不显示为普通成功', () => {
    const s = setImportResult(importState(), { kind: 'merged', revision: 12, path: '/data/src' });
    const panel = buildCheckoutPanelState(s);
    expect(actionIds(panel.footer)).toEqual(['acknowledgeMerged', 'verifyImport', 'viewTaskLog', 'closePanel']);
    expect(panel.banners).toContainEqual(expect.objectContaining({ id: 'result.merged', level: 'warn' }));
  });

  it('acknowledgeMerged：merged → settled 形态，动作集切换为 新建/日志/关闭', () => {
    let s = setImportResult(importState(), { kind: 'merged', revision: 12, path: '/data/src' });
    s = acknowledgeMergedReducer(s);
    if (s.result?.mode === 'import') {
      expect(s.result.kind).toBe('merged');
      expect(s.result.settled).toBe(true);
    }
    expect(actionIds(buildCheckoutPanelState(s).footer)).toEqual(['newTask', 'viewTaskLog', 'closePanel']);
    // 已收口后再次调用幂等（原样返回）。
    expect(acknowledgeMergedReducer(s)).toBe(s);
  });

  it('merged 页核实第 0 步失败：横幅提示、不转 unknown 不写 snapshotIncomplete', () => {
    const s = setImportResult(importState(), { kind: 'merged', revision: 12, path: '/data/src' });
    const panel = buildCheckoutPanelState(s, { importVerifySnapshotFailed: true });
    expect(panel.banners).toContainEqual(
      expect.objectContaining({ id: 'importVerifySnapshotFailed', level: 'info', dismissable: false }),
    );
    if (s.result?.mode === 'import') {
      expect(s.result.snapshotIncomplete).toBeUndefined();
    }
  });

  it('非 merged 页调用 acknowledgeMerged 原样返回（守卫）', () => {
    const s = setImportResult(importState(), { kind: 'unknown', path: '/data/src' });
    expect(acknowledgeMergedReducer(s)).toBe(s);
  });
});

/* ============ toDraft/fromDraft 导入字段往返（§9 草稿投影） ============ */

describe('toDraft/fromDraft 导入字段往返', () => {
  it('全字段往返：sourceDir/message/nameMode 逐字段相等；错误字段不持久化', () => {
    let s = importState();
    s = syncInput(s, 'url', 'http://example.com/svn/trunk/%E4%B8%AD');
    s = syncInput(s, 'sourceDir', '/data/中文 目录');
    s = syncInput(s, 'message', '多行\n说明文本');
    const draft = toDraft(s);
    expect(draft.sourceDir).toBe('/data/中文 目录');
    expect(draft.message).toBe('多行\n说明文本');
    expect(draft.nameMode).toBe('manual'); // syncInput url 置 manual
    const round = fromDraft(importState(), draft);
    expect(round.form.sourceDir).toBe('/data/中文 目录');
    expect(round.form.message).toBe('多行\n说明文本');
    expect(round.form.nameMode).toBe('manual');
    expect(round.form.url).toBe('http://example.com/svn/trunk/%E4%B8%AD');
    expect(round.step).toBe('form');
    expect(round.conn.phase).toBe('untested');
    expect(round.review.parentIdentity).toBeNull();
  });

  it('closed/restart 的模型承载：结果页在状态上保留、草稿可完整往返（closed 是宿主视图态）', () => {
    let s = importState();
    s = setImportResult(s, { kind: 'unknown', path: '/data/src' });
    expect(s.result?.kind).toBe('unknown');
    const draft = toDraft(s);
    expect(draft.sourceDir).toBe(s.form.sourceDir);
  });
});
