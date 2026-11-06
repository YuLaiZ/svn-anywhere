/**
 * P3 检出面板状态机纯函数测试：对照交互状态清单 §二全部状态行逐行
 * 断言（form/untested、testing、auth、testFailed、review、running、
 * canceling、canceled、interrupted、failed、resumable、resumeBlocked、
 * success；closed 是宿主视图态、不进 reducer），外加：
 * - URL 双字段（非法输入不被旧值顶掉）、默认命名联动与手动保留；
 * - path.join 最终路径拼接（非字符串 +）；
 * - 连接检查发起代次：迟到回包丢弃、signature 失效、pendingNext 撤销；
 * - revMode/revision 与目录名校验；
 * - toDraft/fromDraft 全字段往返（错误字段不持久化、重开重算）。
 */
import { describe, expect, it } from 'vitest';
import type { RemoteIdentity, VerifyReport } from '../src/core/checkout';
import type { FooterSpec, PanelState } from '../src/host/panel/state';
import type { CheckoutFormDraft } from '../src/host/panel/drafts';
import {
  addHistoryUrl,
  backToForm,
  beginTask,
  buildCheckoutPanelState,
  buildInterruptedPage,
  connAuth,
  connAuthCancel,
  connAuthResume,
  connNext,
  connSettled,
  consumeIdentity,
  createCheckoutPanelState,
  enterReview,
  fromDraft,
  finalPathOf,
  markRecovered,
  newTask,
  pickDirectDir,
  pickParentDir,
  selectHistoryUrl,
  setConnError,
  setResult,
  setReviewError,
  setVerifyOutcome,
  switchMode,
  syncInput,
  taskPhase,
  taskProgress,
  toDraft,
  URL_HISTORY_LIMIT,
  useUrlName,
  type CheckoutPanelState,
  type ConnOutcome,
  type P3ResultPage,
} from '../src/host/panel/checkoutModel';

/* ------------------------------- 构造辅助 ------------------------------- */

function state(): CheckoutPanelState {
  return createCheckoutPanelState({
    sessionId: 's1',
    entryKey: '/parent',
    mode: 'checkout',
    parentDir: '/parent',
    defaultDepth: 'infinity',
    history: [],
  });
}

const IDENTITY: RemoteIdentity = {
  repositoryUuid: 'uuid-1',
  repositoryRootUrl: 'http://example.com/svn',
  relativeUrl: '^/trunk/proj',
};

const OK_OUTCOME: ConnOutcome = { ok: true, pinnedRevision: 1281, identity: IDENTITY };
const FAIL_OUTCOME: ConnOutcome = { ok: false, failure: 'urlNotFound', message: 'URL 不存在' };

function fieldIds(panel: PanelState): string[] {
  return (panel.form?.fields ?? []).map((field) => field.id);
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

/** 走到 review 步的常用链：输入合法 URL → 下一步 → 检查通过自动进核对。 */
function toReview(url = 'http://example.com/svn/trunk/dabs'): {
  state: CheckoutPanelState;
  seq: number;
} {
  let s = syncInput(state(), 'url', url);
  const next = connNext(s);
  s = connSettled(next.state, next.seq, OK_OUTCOME);
  return { state: s, seq: next.seq };
}

function verifyReportOf(kind: 'resumable' | 'resumeBlocked'): VerifyReport {
  return kind === 'resumable'
    ? { kind: 'resumable', identity: { url: 'http://example.com/svn/trunk/dabs', depth: 'infinity', workingRevision: 1281 } }
    : { kind: 'resumeBlocked', blockReason: 'identityMismatch', message: '副本仓库身份与检出记录不一致' };
}

/* ====================== 清单 §二：form / untested ====================== */

describe('清单 §二 form/untested：初始表单与可见信息', () => {
  it('初始态：form 步、conn untested、无任务无结果无绑定', () => {
    const s = state();
    expect(s.step).toBe('form');
    expect(s.mode).toBe('checkout');
    expect(s.conn.phase).toBe('untested');
    expect(s.conn.signature).toBeNull();
    expect(s.conn.identity).toBeNull();
    expect(s.conn.pendingNext).toBe(false);
    expect(s.task).toBeNull();
    expect(s.result).toBeNull();
    expect(s.binding).toBeNull();
    expect(s.recovered).toBeNull();
  });

  it('可见信息：URL、父目录/子目录、版本、深度字段齐备（清单「可见信息」列）', () => {
    const panel = buildCheckoutPanelState(state());
    expect(fieldIds(panel)).toEqual(
      expect.arrayContaining(['url', 'parentDir', 'dirName', 'revMode', 'depth', 'directMode']),
    );
    const revMode = panel.form?.fields.find((field) => field.id === 'revMode');
    expect(revMode?.value).toBe('head');
    const depth = panel.form?.fields.find((field) => field.id === 'depth');
    expect(depth?.value).toBe('infinity');
    // 检出模式不渲染导入分组字段。
    expect(fieldIds(panel)).not.toContain('sourceDir');
    expect(fieldIds(panel)).not.toContain('message');
  });

  it('允许动作：编辑（无禁用）、目录选择、下一步、关闭；入口 parentDir 预填', () => {
    const s = state();
    expect(s.form.parentDir).toBe('/parent');
    const panel = buildCheckoutPanelState(s);
    expect(panel.form?.fields.every((field) => field.disabled !== true)).toBe(true);
    expect(panel.form?.tools?.some((tool) => tool.id === 'pickParentDir')).toBe(true);
    expect(panel.footer?.primary?.id).toBe('checkoutNext');
    expect(panel.footer?.primary?.disabled).toBeFalsy();
    expect(actionIds(panel.footer)).toContain('closePanel');
    expect(panel.steps).toEqual({ labels: expect.anything(), current: 0 });
  });

  it('URL 历史下拉：有历史时提供 select 字段（历史列表是宿侧 globalState，模型只持镜像）', () => {
    const s = createCheckoutPanelState({
      sessionId: 's1',
      entryKey: '/parent',
      mode: 'checkout',
      parentDir: '/parent',
      history: ['http://example.com/a', 'http://example.com/b'],
    });
    const panel = buildCheckoutPanelState(s);
    const historyField = panel.form?.fields.find((field) => field.id === 'urlHistory');
    expect(historyField?.type).toBe('select');
    expect(historyField?.options?.map((option) => option.value)).toEqual([
      '',
      'http://example.com/a',
      'http://example.com/b',
    ]);
  });

  it('下一步自动检查连接（清单退出规则）：connNext 进入 testing 并携带自动前进意图', () => {
    let s = syncInput(state(), 'url', 'http://example.com/svn/trunk/dabs');
    const next = connNext(s);
    expect(next.issued).toBe(true);
    expect(next.state.conn.phase).toBe('testing');
    expect(next.state.conn.pendingNext).toBe(true);
    expect(next.state.conn.signature).toBe('checkout|http://example.com/svn/trunk/dabs|head|');
    expect(next.seq).toBe(1);
  });

  it('F136 默认深度只影响初始值：entry 注入什么初始深度就是什么', () => {
    const s = createCheckoutPanelState({
      sessionId: 's1',
      entryKey: '/p',
      mode: 'checkout',
      defaultDepth: 'files',
    });
    expect(s.form.depth).toBe('files');
    // 已编辑深度不被入口默认覆盖（重开恢复走 fromDraft，值来自草稿）。
    const edited = syncInput(s, 'depth', 'empty');
    expect(edited.form.depth).toBe('empty');
  });
});

/* ================= URL 双字段、默认命名联动与手动保留 ================= */

describe('URL 双字段（§4.1/§8）', () => {
  it('合法输入：urlInput 存原始输入、form.url 存规范编码值、urlError 为空', () => {
    const s = syncInput(state(), 'url', 'http://example.com/svn/trunk/%E4%B8%AD');
    expect(s.form.urlInput).toBe('http://example.com/svn/trunk/%E4%B8%AD');
    expect(s.form.url).toBe('http://example.com/svn/trunk/%E4%B8%AD');
    expect(s.form.urlError).toBeNull();
    // 中文输入经逆变换编码为 %XX 后接受（表单不误拒原始非 ASCII）。
    const cn = syncInput(state(), 'url', 'http://example.com/svn/trunk/中');
    expect(cn.form.url).toBe('http://example.com/svn/trunk/%E4%B8%AD');
    expect(cn.form.urlInput).toBe('http://example.com/svn/trunk/中');
    expect(cn.form.urlError).toBeNull();
  });

  it('非法输入不被旧值顶掉：urlInput 保留原始输入、form.url 保持上次合法值、urlError 置位', () => {
    let s = syncInput(state(), 'url', 'http://example.com/svn/trunk/dabs');
    expect(s.form.url).toBe('http://example.com/svn/trunk/dabs');
    s = syncInput(s, 'url', 'http://user:pass@example.com/svn/trunk/other');
    expect(s.form.urlInput).toBe('http://user:pass@example.com/svn/trunk/other');
    expect(s.form.url).toBe('http://example.com/svn/trunk/dabs');
    expect(s.form.urlError).toContain('用户名');
  });

  it('nameMode=auto：URL 变化联动默认目录名（末段单次解码）', () => {
    const s = syncInput(state(), 'url', 'http://example.com/svn/trunk/%E4%B8%AD%E6%96%87');
    expect(s.form.nameMode).toBe('auto');
    expect(s.form.dirName).toBe('中文');
  });

  it('URL 末段为非法名（.. / 空段）时默认名留空待填', () => {
    const s = syncInput(state(), 'url', 'http://example.com/svn/..');
    expect(s.form.dirName).toBe('');
    expect(s.form.nameError).toBeNull();
  });

  it('nameMode=manual：手动改名后保留、URL 联动不覆盖；useUrlName 恢复 auto 并重新联动', () => {
    let s = syncInput(state(), 'url', 'http://example.com/svn/trunk/dabs');
    s = syncInput(s, 'dirName', 'mydir');
    expect(s.form.nameMode).toBe('manual');
    s = syncInput(s, 'url', 'http://example.com/svn/trunk/other');
    expect(s.form.dirName).toBe('mydir');
    s = useUrlName(s);
    expect(s.form.nameMode).toBe('auto');
    expect(s.form.dirName).toBe('other');
  });

  it('选择历史：双字段同写、urlInput 为显示形态、auto 联动（syncInput urlHistory 同口径）', () => {
    const viaHelper = selectHistoryUrl(state(), 'http://example.com/svn/trunk/%E4%B8%AD');
    expect(viaHelper.form.url).toBe('http://example.com/svn/trunk/%E4%B8%AD');
    expect(viaHelper.form.urlInput).toBe('http://example.com/svn/trunk/中');
    expect(viaHelper.form.dirName).toBe('中');
    const viaSync = syncInput(state(), 'urlHistory', 'http://example.com/svn/trunk/%E4%B8%AD');
    expect(viaSync.form).toEqual(viaHelper.form);
    // 空值（下拉占位）不改状态。
    expect(syncInput(viaHelper, 'urlHistory', '')).toBe(viaHelper);
  });
});

/* ==================== 字段校验与最终路径（§4.2） ==================== */

describe('字段校验与最终路径拼接', () => {
  it('子目录名非法清单：. .. 分隔符/反斜杠、首尾空白、控制字符 → nameError；中文/空格/@/# 原样合法', () => {
    for (const bad of ['.', '..', 'a/b', 'a\\b', ' a', 'a ', 'a\tb']) {
      const s = syncInput(state(), 'dirName', bad);
      expect(s.form.nameError, `「${bad}」应报错`).toContain('子目录名');
    }
    for (const good of ['中文 目录', 'a@b', 'a#b', 'dabs']) {
      const s = syncInput(state(), 'dirName', good);
      expect(s.form.nameError, `「${good}」应合法`).toBeNull();
    }
  });

  it('版本校验：number 模式下非空非负整数；head 模式无校验；切回 head 清错', () => {
    let s = syncInput(state(), 'revMode', 'number');
    s = syncInput(s, 'rev', '12a');
    expect(s.form.revError).toContain('版本号');
    s = syncInput(s, 'rev', '-1');
    expect(s.form.revError).toContain('版本号');
    s = syncInput(s, 'rev', '1281');
    expect(s.form.revError).toBeNull();
    s = syncInput(s, 'revMode', 'head');
    expect(s.form.revError).toBeNull();
  });

  it('最终路径 path.join 归一拼接：/p/ab + c = /p/ab/c（不是 /p/abc）', () => {
    let s = syncInput(state(), 'parentDir', '/p/ab');
    s = syncInput(s, 'dirName', 'c');
    expect(s.form.finalPath).toBe('/p/ab/c');
    // 边界斜杠由 path.join 消解。
    s = syncInput(s, 'parentDir', '/p/ab/');
    expect(s.form.finalPath).toBe('/p/ab/c');
    // 任一输入为空则无最终路径。
    expect(finalPathOf({ ...s.form, parentDir: '' })).toBeNull();
    expect(finalPathOf({ ...s.form, dirName: '' })).toBeNull();
  });

  it('directMode：pickDirectDir 写入所选目录并置开关、最终路径取 directDir；切回普通模式清空所选目录', () => {
    let s = pickDirectDir(state(), '/target/dir');
    expect(s.form.directMode).toBe(true);
    expect(s.form.directDir).toBe('/target/dir');
    expect(s.form.finalPath).toBe('/target/dir');
    s = syncInput(s, 'directMode', 'false');
    expect(s.form.directMode).toBe(false);
    expect(s.form.directDir).toBe('');
    // 直接模式渲染目标目录字段、隐藏父目录/子目录名（§4.2）。
    const panel = buildCheckoutPanelState(pickDirectDir(state(), '/t'));
    expect(fieldIds(panel)).toContain('directDir');
    expect(fieldIds(panel)).not.toContain('dirName');
    expect(fieldIds(panel)).not.toContain('parentDir');
  });

  it('表单内改 parentDir 是草稿值：不改入口键快照（§9 键纪律）', () => {
    const s = pickParentDir(state(), '/other/parent');
    expect(s.form.parentDir).toBe('/other/parent');
    expect(s.entry.parentDir).toBe('/parent');
    expect(s.entry.entryKey).toBe('/parent');
  });

  it('深度非法值忽略，四档合法值写入', () => {
    expect(syncInput(state(), 'depth', 'deep').form.depth).toBe('infinity');
    expect(syncInput(state(), 'depth', 'empty').form.depth).toBe('empty');
  });
});

/* ==================== 清单 §二：form/testing 与 form/auth ==================== */

describe('清单 §二 form/testing：检查中', () => {
  it('检查中按钮显示「正在检查连接…」并禁止重复下一步', () => {
    let s = syncInput(state(), 'url', 'http://example.com/svn/trunk/dabs');
    const next = connNext(s);
    s = next.state;
    const panel = buildCheckoutPanelState(s);
    expect(panel.footer?.primary?.disabled).toBe(true);
    expect(panel.footer?.primary?.label).toContain('正在检查连接');
    expect(panel.headerBadges?.[0]?.text).toContain('正在检查连接');
    const again = connNext(s);
    expect(again.issued).toBe(false);
    expect(again.state).toBe(s);
    expect(again.seq).toBe(next.seq);
  });

  it('编辑参数撤销自动前进：URL/版本变化清 pendingNext 并使旧检查失效（signature 失效）', () => {
    let s = syncInput(state(), 'url', 'http://example.com/svn/trunk/dabs');
    s = connNext(s).state;
    expect(s.conn.pendingNext).toBe(true);
    s = syncInput(s, 'url', 'http://example.com/svn/trunk/other');
    expect(s.conn.phase).toBe('untested');
    expect(s.conn.pendingNext).toBe(false);
    expect(s.conn.signature).toBeNull();
    expect(s.conn.identity).toBeNull();
  });

  it('参数未变化（仅改目录名/深度）不失效检查', () => {
    let s = syncInput(state(), 'url', 'http://example.com/svn/trunk/dabs');
    s = connNext(s).state;
    s = syncInput(s, 'dirName', 'renamed');
    expect(s.conn.phase).toBe('testing');
    s = syncInput(s, 'depth', 'files');
    expect(s.conn.phase).toBe('testing');
  });
});

describe('清单 §二 form/auth：原生认证补录相位', () => {
  it('认证相位可表达：testing → auth → 继续检查回 testing', () => {
    let s = syncInput(state(), 'url', 'http://example.com/svn/trunk/dabs');
    s = connNext(s).state;
    s = connAuth(s);
    expect(s.conn.phase).toBe('auth');
    expect(buildCheckoutPanelState(s).headerBadges?.[0]?.text).toContain('认证');
    s = connAuthResume(s);
    expect(s.conn.phase).toBe('testing');
  });

  it('认证取消/Esc：回 untested、清除自动前进意图', () => {
    let s = syncInput(state(), 'url', 'http://example.com/svn/trunk/dabs');
    s = connNext(s).state;
    s = connAuth(s);
    s = connAuthCancel(s);
    expect(s.conn.phase).toBe('untested');
    expect(s.conn.pendingNext).toBe(false);
  });
});

/* ==================== 清单 §二：form/testFailed ==================== */

describe('清单 §二 form/testFailed：检查失败留表单', () => {
  it('失败留在表单、原因进 conn.error、渲染为表单页 error 横幅；不进入核对', () => {
    let s = syncInput(state(), 'url', 'http://example.com/svn/missing');
    const next = connNext(s);
    s = connSettled(next.state, next.seq, FAIL_OUTCOME);
    expect(s.step).toBe('form');
    expect(s.conn.phase).toBe('failed');
    expect(s.conn.error).toBe('URL 不存在');
    const panel = buildCheckoutPanelState(s);
    expect(panel.banners).toContainEqual(
      expect.objectContaining({ id: 'connError', level: 'error' }),
    );
    expect(panel.headerBadges?.[0]?.warn).toBe(true);
    // 改参数后可直接再点下一步重试（清单允许动作）。
    expect(panel.footer?.primary?.disabled).toBeFalsy();
  });

  it('修改目标清除错误横幅（§4.1 清除触发：修改目标）', () => {
    let s = syncInput(state(), 'url', 'http://example.com/svn/missing');
    const next = connNext(s);
    s = connSettled(next.state, next.seq, FAIL_OUTCOME);
    s = syncInput(s, 'url', 'http://example.com/svn/other');
    expect(s.conn.error).toBeNull();
    expect(s.conn.phase).toBe('untested');
  });

  it('重试发起：新代次递增，旧代次回包按迟到丢弃', () => {
    let s = syncInput(state(), 'url', 'http://example.com/svn/missing');
    const first = connNext(s);
    s = connSettled(first.state, first.seq, FAIL_OUTCOME);
    const second = connNext(s);
    expect(second.seq).toBe(first.seq + 1);
    // 第一次检查的迟到回包（如认证补录后的慢回包）不得写进新检查。
    const stale = connSettled(second.state, first.seq, OK_OUTCOME);
    expect(stale.conn.phase).toBe('testing');
    expect(stale.conn.identity).toBeNull();
  });
});

/* ======================== 清单 §二：review ======================== */

describe('清单 §二 review：核对页', () => {
  it('检查通过自动进入核对页（pendingNext）；pinnedRevision 与身份快照写入', () => {
    const { state: s } = toReview();
    expect(s.step).toBe('review');
    expect(s.conn.phase).toBe('success');
    expect(s.conn.pinnedRevision).toBe(1281);
    expect(s.conn.identity).toEqual(IDENTITY);
  });

  it('可见信息：原始 URL、最终路径、请求版本、固定 revision、深度、目标状态（禁用键值行承载）', () => {
    const { state: s } = toReview();
    const panel = buildCheckoutPanelState(s);
    const fields = panel.form?.fields ?? [];
    expect(fields.every((field) => field.disabled === true)).toBe(true);
    const byId = new Map(fields.map((field) => [field.id, field.value]));
    expect(byId.get('reviewUrl')).toBe('http://example.com/svn/trunk/dabs');
    expect(byId.get('reviewRequested')).toBe('HEAD');
    expect(byId.get('reviewPinned')).toBe('r1281');
    expect(byId.get('reviewDepth')).toContain('infinity');
    expect(byId.get('reviewTargetState')).toBe('—');
    expect(panel.steps?.current).toBe(1);
  });

  it('指定版本形态：请求版本展示 rN；目标状态说明可写入', () => {
    let s = syncInput(state(), 'url', 'http://example.com/svn/trunk/dabs');
    s = syncInput(s, 'revMode', 'number');
    s = syncInput(s, 'rev', '1200');
    const next = connNext(s);
    s = connSettled(next.state, next.seq, OK_OUTCOME);
    s = { ...s, review: { ...s.review, targetState: '目录不存在，将新建' } };
    const panel = buildCheckoutPanelState(s);
    const byId = new Map((panel.form?.fields ?? []).map((field) => [field.id, field.value]));
    expect(byId.get('reviewRequested')).toBe('r1200');
    expect(byId.get('reviewTargetState')).toBe('目录不存在，将新建');
  });

  it('允许动作：返回、开始、关闭（页脚三动作）', () => {
    const { state: s } = toReview();
    const footer = buildCheckoutPanelState(s).footer;
    expect(footer?.primary?.id).toBe('startCheckout');
    expect(actionIds(footer)).toEqual(expect.arrayContaining(['checkoutBack', 'startCheckout', 'closePanel']));
  });

  it('返回表单：保留表单值与连接结论（签名未变不失效）、清除 review 错误横幅', () => {
    let s = toReview().state;
    s = setReviewError(s, '目标目录不为空');
    expect(buildCheckoutPanelState(s).banners).toContainEqual(
      expect.objectContaining({ id: 'reviewError', level: 'error' }),
    );
    s = backToForm(s);
    expect(s.step).toBe('form');
    expect(s.conn.phase).toBe('success');
    expect(s.conn.identity).toEqual(IDENTITY);
    expect(s.review.error).toBeNull();
    expect(s.form.url).toBe('http://example.com/svn/trunk/dabs');
  });

  it('enterReview 守卫：连接检查未通过不可进核对', () => {
    const s = state();
    expect(enterReview(s).step).toBe('form');
    const next = connNext(syncInput(s, 'url', 'http://x/y'));
    const failed = connSettled(next.state, next.seq, FAIL_OUTCOME);
    expect(enterReview(failed).step).toBe('form');
  });

  it('开始失败回核对页（预命令终止以 review.error 承载，清单 busy/targetChanged 行）', () => {
    const s = setReviewError(state(), '目标目录不为空（/parent/dabs），请换一个空目录或新目录名');
    expect(s.step).toBe('review');
    expect(s.review.error).toContain('不为空');
  });

  it('review 后修改 URL：身份快照与结论一并失效（旧 URL 的成功不得批准新参数）', () => {
    let s = toReview().state;
    s = backToForm(s);
    s = syncInput(s, 'url', 'http://example.com/svn/trunk/other');
    expect(s.conn.phase).toBe('untested');
    expect(s.conn.identity).toBeNull();
    expect(s.conn.pinnedRevision).toBeNull();
  });

  it('consumeIdentity：重查通过、紧邻写命令发出前清除身份快照（begin 参数来源生命周期）', () => {
    let s = toReview().state;
    s = consumeIdentity(s);
    expect(s.conn.identity).toBeNull();
    expect(s.conn.phase).toBe('success');
  });
});

/* ================== 清单 §二：running 与 canceling ================== */

describe('清单 §二 running/canceling：执行与取消', () => {
  it('beginTask：进入 running 步、任务镜像 connecting、绑定 targetPath 与默认 resultScope', () => {
    let s = toReview().state;
    s = beginTask(s, { opId: 'op-1', targetPath: '/parent/dabs' });
    expect(s.step).toBe('running');
    expect(s.task).toEqual({ phase: 'connecting', currentFile: null, count: 0, opId: 'op-1' });
    expect(s.binding).toEqual({ resultScope: { entryKey: '/parent', mode: 'checkout' }, targetPath: '/parent/dabs' });
    expect(s.result).toBeNull();
    expect(s.review.error).toBeNull();
  });

  it('可见信息：当前文件、已取得数、总量未知标记；不提供编辑/新建（步骤条在执行段）', () => {
    let s = beginTask(toReview().state, { opId: 'op-1', targetPath: '/parent/dabs' });
    s = taskPhase(s, 'running');
    s = taskProgress(s, { count: 12, currentFile: 'trunk/src/a.ts' });
    const panel = buildCheckoutPanelState(s);
    expect(panel.busy).toBe(true);
    expect(panel.steps?.current).toBe(2);
    const byId = new Map((panel.form?.fields ?? []).map((field) => [field.id, field.value]));
    expect(byId.get('progressCurrent')).toBe('trunk/src/a.ts');
    const countField = panel.form?.fields.find((field) => field.id === 'progressCount');
    expect(countField?.label).toContain('12');
    expect(panel.form?.fields.some((field) => field.id === 'progressTotal')).toBe(true);
    expect(actionIds(panel.footer)).toEqual(
      expect.arrayContaining(['cancelTask', 'viewTaskLog', 'closePanel']),
    );
  });

  it('connecting 准备段不提供用户取消（DOM 禁用与宿主守卫同源）', () => {
    const s = beginTask(toReview().state, { opId: 'op-1', targetPath: '/parent/dabs' });
    const footer = buildCheckoutPanelState(s).footer;
    expect(footer?.primary?.disabled).toBe(true);
    expect(footer?.primary?.id).toBe('cancelTask');
  });

  it('canceling：取消请求已发出、等待退出——不宣称已取消、禁重复取消（清单 canceling 行）', () => {
    let s = beginTask(toReview().state, { opId: 'op-1', targetPath: '/parent/dabs' });
    s = taskPhase(s, 'running');
    s = taskPhase(s, 'canceling');
    const footer = buildCheckoutPanelState(s).footer;
    expect(footer?.primary?.disabled).toBe(true);
    expect(footer?.primary?.disabledReason).toContain('等待退出');
    expect(actionIds(footer)).toEqual(expect.arrayContaining(['viewTaskLog', 'closePanel']));
  });

  it('running 态页头按绑定任务目标呈现（跨入口绑定不以本次入口推导）', () => {
    const s = beginTask(toReview().state, { opId: 'op-1', targetPath: '/parent/dabs' });
    expect(buildCheckoutPanelState(s).targetLabel).toContain('/parent/dabs');
  });
});

/* ============ 清单 §二：结果页动作集按 kind 分列（canceled/failed/ ============ */
/* ============ interrupted/resumable/resumeBlocked/success 各行） ============ */

describe('清单 §二 结果页动作集分列', () => {
  type CheckoutPage = Extract<P3ResultPage, { mode: 'checkout' }>;
  const page = (kind: CheckoutPage['kind'], extra: Partial<CheckoutPage> = {}): CheckoutPage => ({
    mode: 'checkout',
    kind,
    path: '/parent/dabs',
    ...extra,
  });

  it('success：三打开 + 新建 + 日志五项（基线 §二 success 行完整承载）', () => {
    const s = setResult(toReview().state, page('success', { revision: 1281 }));
    const footer = buildCheckoutPanelState(s).footer;
    expect(actionIds(footer)).toEqual([
      'openCurrentWindow',
      'openNewWindow',
      'addToWorkspace',
      'newTask',
      'viewTaskLog',
      'closePanel',
    ]);
    expect(footer?.primary?.id).toBe('openCurrentWindow');
    // revision 与本地路径进键值行。
    const byId = new Map((buildCheckoutPanelState(s).form?.fields ?? []).map((f) => [f.id, f.value]));
    expect(byId.get('resultRevision')).toBe('r1281');
    expect(byId.get('resultPath')).toBe('/parent/dabs');
  });

  it('canceled：核验续检/改用新目录/Finder/日志四项；文件保留文案', () => {
    const s = setResult(toReview().state, page('canceled', { detail: '用户取消' }));
    const footer = buildCheckoutPanelState(s).footer;
    expect(actionIds(footer)).toEqual([
      'verifyCheckout',
      'abandonResidue',
      'revealResultDir',
      'viewTaskLog',
      'closePanel',
    ]);
    expect(buildCheckoutPanelState(s).banners).toContainEqual(
      expect.objectContaining({ id: 'result.canceled', level: 'warn' }),
    );
  });

  it('failed：动作集与 canceled 同款四项（失败原因可见）', () => {
    const s = setResult(toReview().state, page('failed', { detail: '网络中断' }));
    const footer = buildCheckoutPanelState(s).footer;
    expect(actionIds(footer)).toEqual([
      'verifyCheckout',
      'abandonResidue',
      'revealResultDir',
      'viewTaskLog',
      'closePanel',
    ]);
    const byId = new Map((buildCheckoutPanelState(s).form?.fields ?? []).map((f) => [f.id, f.value]));
    expect(byId.get('resultDetail')).toBe('网络中断');
    expect(buildCheckoutPanelState(s).banners).toContainEqual(
      expect.objectContaining({ id: 'result.failed', level: 'error' }),
    );
  });

  it('interrupted：核验/改用新目录/日志三项——无 Finder（基线差异，不多加不漏）', () => {
    const s = setResult(toReview().state, buildInterruptedPage({ path: '/parent/dabs' }));
    const footer = buildCheckoutPanelState(s).footer;
    expect(actionIds(footer)).toEqual(['verifyCheckout', 'abandonResidue', 'viewTaskLog', 'closePanel']);
    expect(actionIds(footer)).not.toContain('revealResultDir');
  });

  it('interrupted 派生页无表单快照（重启后无任务对象与缓存——已登记差异）', () => {
    const page = buildInterruptedPage({ path: '/parent/dabs', detail: '宿主重启' });
    expect(page.kind).toBe('interrupted');
    expect('formSnapshot' in page && page.formSnapshot !== undefined).toBe(false);
  });

  it('resumeBlocked：改用新目录/重新核验/日志三项——没有「继续原检出」按钮（清单禁止列）', () => {
    const s = setResult(toReview().state, page('resumeBlocked', { verify: verifyReportOf('resumeBlocked') }));
    const footer = buildCheckoutPanelState(s).footer;
    expect(actionIds(footer)).toEqual(['abandonResidue', 'verifyCheckout', 'viewTaskLog', 'closePanel']);
    expect(actionIds(footer)).not.toContain('resumeCheckout');
    const byId = new Map((buildCheckoutPanelState(s).form?.fields ?? []).map((f) => [f.id, f.value]));
    expect(byId.get('resultVerify')).toContain('身份');
  });

  it('resumable：继续原检出/日志/关闭三项（清单 §二 resumable 行——无核验，resumable 本身即核验结论）', () => {
    const s = setResult(toReview().state, page('resumable', { verify: verifyReportOf('resumable') }));
    const footer = buildCheckoutPanelState(s).footer;
    expect(actionIds(footer)).toEqual(['resumeCheckout', 'viewTaskLog', 'closePanel']);
    expect(footer?.primary?.disabled).toBeFalsy();
  });

  it('resumable：占用判定喂入 false 时「继续原检出」禁用并给可读原因', () => {
    const s = setResult(toReview().state, page('resumable', { verify: verifyReportOf('resumable') }));
    const footer = buildCheckoutPanelState(s, { resumeAvailable: false }).footer;
    expect(footer?.primary?.disabled).toBe(true);
    expect(footer?.primary?.disabledReason).toContain('占用');
  });

  it('setResult 后任务镜像清空（终态唯一落点是 result.kind，不进 task.phase）', () => {
    let s = beginTask(toReview().state, { opId: 'op-1', targetPath: '/parent/dabs' });
    s = taskPhase(s, 'running');
    s = setResult(s, page('success', { revision: 1281 }));
    expect(s.step).toBe('result');
    expect(s.task).toBeNull();
    expect(s.result?.kind).toBe('success');
  });

  it('setVerifyOutcome：核验结论转移（resumable/resumeBlocked），快照从被核验页透传', () => {
    const canceledPage = page('canceled', { detail: '用户取消', formSnapshot: toDraft(toReview().state) });
    let s = setResult(toReview().state, canceledPage);
    s = setVerifyOutcome(s, {
      report: verifyReportOf('resumable'),
      path: '/parent/dabs',
      formSnapshot: canceledPage.formSnapshot,
    });
    expect(s.result?.kind).toBe('resumable');
    if (s.result?.mode === 'checkout') {
      expect(s.result.verify?.kind).toBe('resumable');
      expect(s.result.formSnapshot?.url).toBe('http://example.com/svn/trunk/dabs');
    }
    s = setVerifyOutcome(s, { report: verifyReportOf('resumeBlocked'), path: '/parent/dabs' });
    expect(s.result?.kind).toBe('resumeBlocked');
  });

  it('核验/核实进行中提示：info 横幅且不渲染关闭 ×（dismissable:false，§7.1）', () => {
    const s = setResult(toReview().state, page('canceled'));
    const banner = buildCheckoutPanelState(s, { verifyPending: true }).banners.find((b) => b.id === 'verifyPending');
    expect(banner?.level).toBe('info');
    expect(banner?.dismissable).toBe(false);
  });
});

/* ================ 迟到回包丢弃与 signature 失效（§4.1） ================ */

describe('迟到回包与代次丢弃', () => {
  it('更早一次检查的迟到回包按代次丢弃（不写结论）', () => {
    let s = syncInput(state(), 'url', 'http://example.com/svn/trunk/dabs');
    const first = connNext(s);
    // 检查失败后用户直接重试，发起了第二次检查。
    s = connSettled(first.state, first.seq, FAIL_OUTCOME);
    const second = connNext(s);
    // 第一次检查的迟到成功回包（同签名不同代次）不得批准。
    s = connSettled(second.state, first.seq, OK_OUTCOME);
    expect(s.conn.phase).toBe('testing');
    expect(s.step).toBe('form');
    // 第二次的真实回包正常生效。
    s = connSettled(s, second.seq, OK_OUTCOME);
    expect(s.conn.phase).toBe('success');
    expect(s.step).toBe('review');
  });

  it('参数编辑使旧回包失效：untested 相位收到旧代次回包直接丢弃', () => {
    let s = syncInput(state(), 'url', 'http://example.com/svn/trunk/dabs');
    const next = connNext(s);
    s = next.state;
    s = syncInput(s, 'url', 'http://example.com/svn/trunk/other');
    expect(s.conn.phase).toBe('untested');
    const stale = connSettled(s, next.seq, OK_OUTCOME);
    expect(stale).toBe(s);
  });

  it('连接成功后的参数编辑同样失效（旧 URL 的成功结果不得把用户切到核对页）', () => {
    let s = toReview().state;
    s = backToForm(s);
    s = syncInput(s, 'url', 'http://example.com/svn/trunk/other');
    expect(s.conn.phase).toBe('untested');
    expect(s.step).toBe('form');
  });

  it('pendingNext 撤销后，代次一致的成功回包不再自动进核对（留在表单）', () => {
    // pendingNext 的清除路径：参数编辑使 phase 回 untested，此时同代次
    // 回包已被相位守卫丢弃；此用例验证「成功 + pendingNext=false」的形态
    // ——单独发起检查（非「下一步」路径预留形态）不自动前进。
    let s = syncInput(state(), 'url', 'http://example.com/svn/trunk/dabs');
    const next = connNext(s);
    s = { ...next.state, conn: { ...next.state.conn, pendingNext: false } };
    s = connSettled(s, next.seq, OK_OUTCOME);
    expect(s.conn.phase).toBe('success');
    expect(s.step).toBe('form');
  });
});

/* =============== newTask / switchMode / 错误承载与恢复标记 =============== */

describe('newTask、switchMode 与错误承载', () => {
  it('newTask：回新表单（入口初始值与配置默认深度）、清结果页/任务/绑定/连接检查；历史保留', () => {
    let s = beginTask(toReview().state, { opId: 'op-1', targetPath: '/parent/dabs' });
    s = setResult(s, { mode: 'checkout', kind: 'success', revision: 1, path: '/parent/dabs' });
    s = { ...s, history: ['http://a'], recovered: 'task' };
    const fresh = newTask(s);
    expect(fresh.step).toBe('form');
    expect(fresh.result).toBeNull();
    expect(fresh.task).toBeNull();
    expect(fresh.binding).toBeNull();
    expect(fresh.conn.phase).toBe('untested');
    expect(fresh.review.checked).toBe(false);
    expect(fresh.recovered).toBeNull();
    expect(fresh.form.parentDir).toBe('/parent');
    expect(fresh.form.depth).toBe('infinity');
    expect(fresh.form.url).toBe('');
    expect(fresh.history).toEqual(['http://a']);
  });

  it('switchMode：模式翻转、表单按入口初始值重置（等同换目标）', () => {
    const s = syncInput(state(), 'url', 'http://example.com/svn/trunk/dabs');
    const switched = switchMode(s);
    expect(switched.mode).toBe('import');
    expect(switched.entry.mode).toBe('import');
    expect(switched.form.url).toBe('');
    expect(switched.conn.phase).toBe('untested');
    // 切换后按导入模式渲染源目录/说明字段。
    const panel = buildCheckoutPanelState(switched);
    expect(fieldIds(panel)).toContain('sourceDir');
    expect(fieldIds(panel)).toContain('message');
  });

  it('setConnError：宿主写入的连接/源预检失败原因渲染为表单页 error 横幅', () => {
    const s = setConnError(state(), '无法连接仓库');
    expect(s.conn.phase).toBe('failed');
    expect(buildCheckoutPanelState(s).banners).toContainEqual(
      expect.objectContaining({ id: 'connError', level: 'error', detail: '无法连接仓库' }),
    );
  });

  it('导入核对勾选通道一次到位：checked 切换驱动开始按钮禁用（清单 §三 未勾选不能开始）', () => {
    let s = switchMode(state());
    s = syncInput(s, 'checked', 'true');
    expect(s.review.checked).toBe(true);
    const footer = buildCheckoutPanelState({ ...s, step: 'review', conn: { ...s.conn, phase: 'success' } }).footer;
    expect(footer?.primary?.id).toBe('startImport');
    expect(footer?.primary?.disabled).toBe(false);
    const unchecked = buildCheckoutPanelState({ ...syncInput(s, 'checked', 'false'), step: 'review', conn: { ...s.conn, phase: 'success' } }).footer;
    expect(unchecked?.primary?.disabled).toBe(true);
  });

  it('导入结果页动作集一并建好：unknown=核实（快照不完整分支另挂放弃核实）/merged/failed/success', () => {
    const s = switchMode(state());
    const unknownPage = buildCheckoutPanelState(
      setResult(s, { mode: 'import', kind: 'unknown', path: '/src', detail: '结果未知' }),
    );
    expect(actionIds(unknownPage.footer)).toEqual(['verifyImport', 'viewTaskLog', 'closePanel']);
    const incomplete = buildCheckoutPanelState(
      setResult(s, { mode: 'import', kind: 'unknown', path: '/src', snapshotIncomplete: true }),
    );
    expect(actionIds(incomplete.footer)).toEqual(['verifyImport', 'abandonUnknownImport', 'viewTaskLog', 'closePanel']);
    const merged = buildCheckoutPanelState(
      setResult(s, { mode: 'import', kind: 'merged', revision: 12, path: '/src' }),
    );
    expect(actionIds(merged.footer)).toEqual(['acknowledgeMerged', 'verifyImport', 'viewTaskLog', 'closePanel']);
    const settled = buildCheckoutPanelState(
      setResult(s, { mode: 'import', kind: 'merged', revision: 12, path: '/src', settled: true }),
    );
    expect(actionIds(settled.footer)).toEqual(['newTask', 'viewTaskLog', 'closePanel']);
    const importFailed = buildCheckoutPanelState(
      setResult(s, { mode: 'import', kind: 'failed', path: '/src' }),
    );
    expect(actionIds(importFailed.footer)).toEqual(['retryImport', 'viewTaskLog', 'closePanel']);
    const importSuccess = buildCheckoutPanelState(
      setResult(s, { mode: 'import', kind: 'success', revision: 1281, path: '/src' }),
    );
    expect(actionIds(importSuccess.footer)).toEqual([
      'handoffToCheckout',
      'revealSourceDir',
      'newTask',
      'viewTaskLog',
      'closePanel',
    ]);
  });
});

/* ============== toDraft/fromDraft 全字段往返（§9 草稿投影） ============== */

describe('toDraft/fromDraft 全字段往返', () => {
  function filledDraft(): CheckoutFormDraft {
    return {
      url: 'http://example.com/svn/trunk/%E4%B8%AD',
      urlInput: 'http://example.com/svn/trunk/中',
      nameMode: 'manual',
      parentDir: '/parent',
      dirName: '自定义',
      directMode: true,
      directDir: '/target/dir',
      revMode: 'number',
      rev: '1281',
      depth: 'files',
      sourceDir: '',
      message: '',
    };
  }

  it('全字段往返：toDraft → fromDraft 逐字段相等（含 nameMode/directMode/directDir）', () => {
    let s = pickDirectDir(state(), '/target/dir');
    const draft = filledDraft();
    s = { ...s, form: { ...s.form, ...draft } };
    const round = fromDraft(state(), toDraft(s));
    expect(round.form.url).toBe(draft.url);
    expect(round.form.urlInput).toBe(draft.urlInput);
    expect(round.form.nameMode).toBe('manual');
    expect(round.form.parentDir).toBe('/parent');
    expect(round.form.dirName).toBe('自定义');
    expect(round.form.directMode).toBe(true);
    expect(round.form.directDir).toBe('/target/dir');
    expect(round.form.revMode).toBe('number');
    expect(round.form.rev).toBe('1281');
    expect(round.form.depth).toBe('files');
    expect(round.form.finalPath).toBe('/target/dir');
  });

  it('fromDraft 重置流程态：回 form 步、conn untested、review 重置、清结果与绑定、标记恢复来源草稿段', () => {
    const s = beginTask(toReview().state, { opId: 'op-1', targetPath: '/parent/dabs' });
    const round = fromDraft(s, toDraft(s));
    expect(round.step).toBe('form');
    expect(round.recovered).toBe('draft');
    expect(round.task).toBeNull();
    expect(round.result).toBeNull();
    expect(round.binding).toBeNull();
    expect(round.conn.phase).toBe('untested');
    expect(round.review.checked).toBe(false);
  });

  it('错误字段不持久化：恢复后按表单值重算（非法 URL 重算置位、合法则无错）', () => {
    let s = syncInput(state(), 'url', 'http://user@example.com/svn/x');
    expect(s.form.urlError).toContain('用户名');
    const round = fromDraft(state(), toDraft(s));
    expect(round.form.urlError).toContain('用户名');
    // 修改为合法值后错误清除（重算路径）。
    const legal = fromDraft(state(), { ...toDraft(s), url: 'http://example.com/svn/x', urlInput: 'http://example.com/svn/x' });
    expect(legal.form.urlError).toBeNull();
  });
});

/* ====================== URL 历史（§4.2）与 closed 说明 ====================== */

describe('URL 历史与 closed 边界', () => {
  it('addHistoryUrl：去重置顶、上限 10、空值不改', () => {
    let history = ['http://a', 'http://b', 'http://c'];
    history = addHistoryUrl(history, 'http://b');
    expect(history).toEqual(['http://b', 'http://a', 'http://c']);
    history = addHistoryUrl(history, 'http://d');
    expect(history[0]).toBe('http://d');
    let filled = Array.from({ length: URL_HISTORY_LIMIT + 2 }, (_, i) => `http://x/${i}`);
    filled = addHistoryUrl(filled, 'http://new');
    expect(filled).toHaveLength(URL_HISTORY_LIMIT);
    expect(filled[0]).toBe('http://new');
    expect(addHistoryUrl(['http://a'], '')).toEqual(['http://a']);
  });

  it('closed 是宿主视图态：不进 reducer 业务状态（步骤枚举无 closed；草稿/结果保留由 fromDraft/setResult 承载）', () => {
    const steps: CheckoutPanelState['step'][] = ['form', 'review', 'running', 'result'];
    expect(steps).not.toContain('closed');
    // 「草稿/结果保留」的模型承载：结果页在 state 上保留、草稿可完整往返。
    const s = setResult(toReview().state, { mode: 'checkout', kind: 'canceled', path: '/parent/dabs' });
    expect(s.result?.kind).toBe('canceled');
    expect(toDraft(s).url).toBe(s.form.url);
  });

  it('markRecovered：恢复来源段标记（五段之①③由恢复流程写入，发起/新建清回）', () => {
    expect(markRecovered(state(), 'task').recovered).toBe('task');
    expect(markRecovered(state(), 'record').recovered).toBe('record');
    let s = markRecovered(state(), 'cache');
    s = beginTask(s, { opId: 'op-1', targetPath: '/parent/dabs' });
    expect(s.recovered).toBeNull();
  });
});
