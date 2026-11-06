// @vitest-environment jsdom
/**
 * Webview 视图侧 DOM 行为验证：消息往返、输入同步、事件委托意图、
 * 焦点/光标/滚动保持、忙碌禁用、组合输入与销毁。
 * 直接测 src/host/panel/webview/app.ts（与打包进 media/panel.js 的同一实现）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountPanel, type WebviewApi } from '../src/host/panel/webview/app';
import { render } from '../src/host/panel/view';
import type { PanelState, RowSpec } from '../src/host/panel/state';

function makeApi(): { api: WebviewApi; sent: unknown[] } {
  const sent: unknown[] = [];
  return { api: { postMessage: (message) => sent.push(message) }, sent };
}

function stateOf(patch: Partial<PanelState> = {}): PanelState {
  return {
    sessionId: 's1',
    title: '面板',
    targetLabel: 'wc',
    revision: 1,
    formRevision: 0,
    busy: false,
    banners: [],
    list: {
      id: 'l',
      columns: [],
      rows: rowsOf(),
      filters: [
        {
          id: 'status',
          cellKey: 'status',
          value: 'all',
          options: [
            { value: 'all', label: '全部' },
            { value: 'modified', label: 'modified' },
            { value: 'unversioned', label: 'unversioned' },
          ],
        },
      ],
      selection: { total: 0, visible: 0, hidden: 0 },
      empty: { title: '无变更' },
      filterEmpty: { title: '无匹配', action: { id: 'clearFilters', label: '清除筛选' } },
    },
    form: {
      id: 'm',
      busy: false,
      fields: [{ id: 'message', label: '说明', value: '', type: 'textarea' }],
    },
    ...patch,
  };
}

function rowsOf(): RowSpec[] {
  return [
    {
      id: 'a.ts',
      cells: { path: 'a.ts', status: 'modified', ext: 'value:ts' },
      actions: [
        { id: 'openDiff', label: '差异' },
        { id: 'openFile', label: '打开' },
      ],
    },
    {
      id: 'b.txt',
      cells: { path: 'b.txt', status: 'unversioned', ext: 'none' },
      actions: [{ id: 'openDiff', label: '差异', disabled: true, disabledReason: '无 BASE' }],
    },
  ];
}

const lastIntent = (sent: unknown[]) =>
  sent.filter((m) => (m as { type?: string }).type === 'intent').at(-1) as
    | { requestId: string; sessionId: string; intent: Record<string, unknown> }
    | undefined;

function setup(patch: Partial<PanelState> = {}) {
  document.body.innerHTML = '<div id="app"></div>';
  const { api, sent } = makeApi();
  const app = mountPanel(document, api);
  const st = stateOf(patch);
  app.handleHostMessage({
    type: 'render',
    protocolVersion: 1,
    sessionId: 's1',
    revision: 1,
    formRevision: 0,
    html: render(st),
  });
  return { app, sent, st };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('挂载与握手', () => {
  it('挂载即发送 ready（协议版本 1）', () => {
    document.body.innerHTML = '<div id="app"></div>';
    const { sent } = makeApi();
    const api = { postMessage: (m: unknown) => sent.push(m) };
    mountPanel(document, api);
    expect(sent).toEqual([{ type: 'ready', protocolVersion: 1 }]);
  });

  it('render 消息替换 DOM 并渲染行列', () => {
    const { app } = setup();
    expect(document.querySelectorAll('.row').length).toBe(2);
    expect(document.querySelector('.list')).not.toBeNull();
    app.dispose();
  });

  it('dispose 后不再发送消息', () => {
    const { app, sent } = setup();
    app.dispose();
    const before = sent.length;
    document.querySelector<HTMLButtonElement>('[data-intent="refresh"]')?.click();
    expect(sent.length).toBe(before);
  });
});

describe('事件委托 → 意图', () => {
  it('点击差异按钮发送 openDiff（只带条目 ID）', () => {
    const { app, sent } = setup();
    document.querySelector<HTMLButtonElement>('[data-item-id="a.ts"][data-intent="openDiff"]')?.click();
    const intent = lastIntent(sent);
    expect(intent?.intent).toEqual({ kind: 'openDiff', itemId: 'a.ts' });
    expect(intent?.sessionId).toBe('s1');
    expect(intent?.requestId).toMatch(/^req-/);
    app.dispose();
  });

  it('勾选变化发送 toggleRow；筛选变化发送 setFilter', () => {
    const { app, sent } = setup();
    const box = document.querySelector<HTMLInputElement>('input[data-row-id="a.ts"]');
    box!.checked = true;
    box!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(lastIntent(sent)?.intent).toEqual({ kind: 'toggleRow', rowId: 'a.ts', selected: true });

    const select = document.querySelector<HTMLSelectElement>('[data-intent="setFilter"]');
    select!.value = 'modified';
    select!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(lastIntent(sent)?.intent).toEqual({ kind: 'setFilter', filterId: 'status', value: 'modified' });
    app.dispose();
  });

  it('点击未知横幅的核实按钮发送 bannerAction（重启恢复的真实按钮路径）', () => {
    const { app, sent } = setup({
      writeLocked: true,
      banners: [{
        id: 'unknown',
        level: 'warn',
        title: '提交结果未知',
        actions: [{ id: 'resolveUnknown', label: '核实提交结果' }],
      }],
    });
    const button = document.querySelector<HTMLButtonElement>(
      '[data-intent="bannerAction"][data-action-id="resolveUnknown"]',
    );
    expect(button).not.toBeNull();
    button?.click();
    expect(lastIntent(sent)?.intent).toEqual({
      kind: 'bannerAction',
      bannerId: 'unknown',
      actionId: 'resolveUnknown',
    });
    app.dispose();
  });

  it('筛选空态的清除筛选按钮发送 clearFilters', () => {
    const { app } = setup({ list: undefined });
    // 手动渲染筛选空态（绕过宿主）：直接调用 render 更贴近视图职责边界。
    document.body.innerHTML = '<div id="app"></div>';
    const { api: api2, sent: sent2 } = makeApi();
    const app2 = mountPanel(document, api2);
    const filtered = stateOf();
    filtered.list!.filters![0].value = 'unversioned';
    // 仅保留 unversioned 可见性之外的状态组合：改为 modified 过滤后无匹配。
    filtered.list!.filters![0].value = 'modified';
    filtered.list!.rows = [rowsOf()[1]];
    app2.handleHostMessage({
      type: 'render', protocolVersion: 1, sessionId: 's1', revision: 1, formRevision: 0,
      html: render(filtered),
    });
    document.querySelector<HTMLButtonElement>('[data-intent="clearFilters"]')?.click();
    expect(lastIntent(sent2)?.intent).toEqual({ kind: 'clearFilters' });
    app.dispose();
    app2.dispose();
  });

  it('disabled 控件不产生意图', () => {
    const { app, sent } = setup();
    const disabledButton = document.querySelector<HTMLButtonElement>('[data-item-id="b.txt"][data-intent="openDiff"]');
    expect(disabledButton?.disabled).toBe(true);
    disabledButton?.click();
    expect(lastIntent(sent)).toBeUndefined();
    app.dispose();
  });

  it('busy 渲染下全部写控件禁用', () => {
    const { app } = setup({ busy: true });
    expect(document.querySelector<HTMLInputElement>('input[data-row-id="a.ts"]')?.disabled).toBe(true);
    expect(document.querySelector<HTMLSelectElement>('[data-intent="setFilter"]')?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-intent="refresh"]')?.disabled).toBe(true);
    expect(document.querySelector('.progress')).not.toBeNull();
    app.dispose();
  });
});

describe('输入同步与状态保持', () => {
  it('输入事件发送 syncInput 且 inputRevision 递增', () => {
    const { app, sent } = setup();
    const area = document.querySelector<HTMLTextAreaElement>('[data-field-id="message"]')!;
    area.value = '第一行';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    area.value = '第一行\n第二行';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    const intents = sent.filter((m) => (m as { type?: string }).type === 'intent') as Array<{ intent: Record<string, unknown> }>;
    expect(intents[0].intent).toMatchObject({ kind: 'syncInput', fieldId: 'message', value: '第一行' });
    expect(intents[1].intent).toMatchObject({ kind: 'syncInput', value: '第一行\n第二行' });
    expect((intents[1].intent.inputRevision as number)).toBeGreaterThan(intents[0].intent.inputRevision as number);
    app.dispose();
  });

  it('整段重绘恢复焦点、光标与滚动位置', () => {
    const { app } = setup();
    const area = document.querySelector<HTMLTextAreaElement>('[data-field-id="message"]')!;
    area.focus();
    area.value = 'abcdef';
    area.setSelectionRange(3, 5);
    const list = document.querySelector<HTMLElement>('.list')!;
    list.scrollTop = 40;

    const next = stateOf();
    next.form!.fields[0].value = 'abcdef';
    app.handleHostMessage({
      type: 'render', protocolVersion: 1, sessionId: 's1', revision: 2, formRevision: 1,
      html: render(next),
    });

    const restored = document.querySelector<HTMLTextAreaElement>('[data-field-id="message"]')!;
    expect(document.activeElement).toBe(restored);
    expect(restored.selectionStart).toBe(3);
    expect(restored.selectionEnd).toBe(5);
    expect(document.querySelector<HTMLElement>('.list')!.scrollTop).toBe(40);
    app.dispose();
  });

  it('视图待确认的较新输入不被旧 formRevision 覆盖', () => {
    const { app, sent } = setup();
    const area = document.querySelector<HTMLTextAreaElement>('[data-field-id="message"]')!;
    area.value = '本地更新内容';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    const inputRevision = (lastIntent(sent)?.intent.inputRevision as number) ?? 0;

    // 宿主携带的 formRevision 落后于视图输入序号：保留本地值。
    const older = stateOf();
    older.form!.fields[0].value = '宿主旧值';
    app.handleHostMessage({
      type: 'render', protocolVersion: 1, sessionId: 's1', revision: 2,
      formRevision: inputRevision - 1,
      html: render(older),
    });
    expect(document.querySelector<HTMLTextAreaElement>('[data-field-id="message"]')!.value).toBe('本地更新内容');

    // 宿主 formRevision 追上后可正常覆盖。
    const newer = stateOf();
    newer.form!.fields[0].value = '宿主确认值';
    app.handleHostMessage({
      type: 'render', protocolVersion: 1, sessionId: 's1', revision: 3,
      formRevision: inputRevision,
      html: render(newer),
    });
    expect(document.querySelector<HTMLTextAreaElement>('[data-field-id="message"]')!.value).toBe('宿主确认值');
    app.dispose();
  });

  it('视图重建（viewEpoch 递增）后确认空间重置：旧代大序号不回退新视图连续输入', () => {
    // 旧视图时代宿主累计了较大确认序号（如 100）；webview 重建后视图是全新
    // 上下文（本用例即新挂载实例），宿主 ready 归零 formRevision 并递增代次。
    document.body.innerHTML = '<div id="app"></div>';
    const { api, sent } = makeApi();
    const app = mountPanel(document, api);
    const restored = stateOf();
    app.handleHostMessage({
      type: 'render', protocolVersion: 1, sessionId: 's1', revision: 1,
      formRevision: 0, viewEpoch: 1, html: render(restored),
    });
    // 新视图连续输入 abcd（rev 1）、abcde（rev 2），序号从零重启。
    const area = document.querySelector<HTMLTextAreaElement>('[data-field-id="message"]')!;
    area.value = 'abcd';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    area.value = 'abcde';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    const intents = sent.filter((m) => (m as { type?: string }).type === 'intent') as Array<{ intent: Record<string, unknown> }>;
    expect(intents.map((m) => m.intent.inputRevision)).toEqual([1, 2]);
    // 宿主先回推较早输入 abcd 的回显帧（formRevision 已归零后按新序号对齐）：
    // 较新的 abcde 仍是待确认输入，不被该帧回退。
    const echoedAbcd = stateOf();
    echoedAbcd.form!.fields[0].value = 'abcd';
    app.handleHostMessage({
      type: 'render', protocolVersion: 1, sessionId: 's1', revision: 2,
      formRevision: 1, viewEpoch: 1, html: render(echoedAbcd),
    });
    expect(document.querySelector<HTMLTextAreaElement>('[data-field-id="message"]')!.value).toBe('abcde');
    // 最新输入的回显帧（formRevision=2）到达后正常收敛。
    const echoedAbcde = stateOf();
    echoedAbcde.form!.fields[0].value = 'abcde';
    app.handleHostMessage({
      type: 'render', protocolVersion: 1, sessionId: 's1', revision: 3,
      formRevision: 2, viewEpoch: 1, html: render(echoedAbcde),
    });
    expect(document.querySelector<HTMLTextAreaElement>('[data-field-id="message"]')!.value).toBe('abcde');
    app.dispose();
  });

  it('视图代次递增的帧清空未确认输入：帧内值直接生效', () => {
    const { app, sent } = setup();
    const area = document.querySelector<HTMLTextAreaElement>('[data-field-id="message"]')!;
    area.value = '旧视图待确认';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    expect(sent.filter((m) => (m as { type?: string }).type === 'intent').length).toBe(1);
    // 新代次帧到达（宿主重建握手）：旧代的待确认输入不再受保护，帧值生效。
    const nextEpoch = stateOf();
    nextEpoch.form!.fields[0].value = '新代次宿主值';
    app.handleHostMessage({
      type: 'render', protocolVersion: 1, sessionId: 's1', revision: 2,
      formRevision: 0, viewEpoch: 1, html: render(nextEpoch),
    });
    expect(document.querySelector<HTMLTextAreaElement>('[data-field-id="message"]')!.value).toBe('新代次宿主值');
    app.dispose();
  });

  it('组合输入期间点击不触发意图；compositionend 同步最终值', () => {
    const { app, sent } = setup();
    const area = document.querySelector<HTMLTextAreaElement>('[data-field-id="message"]')!;
    area.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-intent="refresh"]')?.click();
    expect(sent.filter((m) => (m as { type?: string }).type === 'intent')).toHaveLength(0);

    area.value = '拼音组合结果';
    area.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    const intent = lastIntent(sent);
    expect(intent?.intent).toMatchObject({ kind: 'syncInput', value: '拼音组合结果' });
    app.dispose();
  });

  it('组合期间的同会话渲染只暂存；compositionend 应用暂存且输入不回退', () => {
    const { app, sent } = setup();
    const area = document.querySelector<HTMLTextAreaElement>('[data-field-id="message"]')!;
    area.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    // 组合中间值触发输入同步，宿主据此回推整段渲染（含派生更新，如新标题）。
    area.value = '组合中';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    expect(lastIntent(sent)?.intent).toMatchObject({ kind: 'syncInput', value: '组合中', inputRevision: 1 });
    const echoed = stateOf({ title: '组合暂存帧' });
    echoed.form!.fields[0].value = '组合中';
    app.handleHostMessage({
      type: 'render', protocolVersion: 1, sessionId: 's1', revision: 2,
      formRevision: 1, html: render(echoed),
    });
    // 组合期间 DOM 不被替换：暂存帧未上屏，本地输入原样保留。
    expect(document.querySelector('.panel-title')?.textContent).not.toBe('组合暂存帧');
    expect(area.value).toBe('组合中');
    // compositionend：同步最终组合值，随后应用暂存帧；最终值不被暂存帧回退。
    area.value = '组合最终值';
    area.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    expect(lastIntent(sent)?.intent).toMatchObject({ kind: 'syncInput', value: '组合最终值', inputRevision: 2 });
    expect(document.querySelector('.panel-title')?.textContent).toBe('组合暂存帧');
    expect(document.querySelector<HTMLTextAreaElement>('[data-field-id="message"]')!.value).toBe('组合最终值');
    app.dispose();
  });

  it('组合期间的会话切换帧立即应用（不暂存）', () => {
    const { app } = setup();
    const area = document.querySelector<HTMLTextAreaElement>('[data-field-id="message"]')!;
    area.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const switched = stateOf({ sessionId: 's2', title: '新目标帧' });
    app.handleHostMessage({
      type: 'render', protocolVersion: 1, sessionId: 's2', revision: 1,
      formRevision: 0, html: render(switched),
    });
    expect(document.querySelector('.panel-title')?.textContent).toBe('新目标帧');
    app.dispose();
  });

  it('组合期间切换会话清除组合态：新会话后续渲染立即上屏（旧控件 compositionend 不再冒泡）', () => {
    const { app, sent } = setup();
    const area = document.querySelector<HTMLTextAreaElement>('[data-field-id="message"]')!;
    area.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    // 同会话回显帧照常暂存（组合进行中）。
    const echoed = stateOf({ title: 'A 回显帧' });
    echoed.form!.fields[0].value = '组合中';
    app.handleHostMessage({
      type: 'render', protocolVersion: 1, sessionId: 's1', revision: 2,
      formRevision: 1, html: render(echoed),
    });
    expect(document.querySelector('.panel-title')?.textContent).not.toBe('A 回显帧');
    // 切换到会话 B：切换帧立即上屏；旧输入控件已随 DOM 替换，
    // 其 compositionend 不再冒泡到根节点（本用例刻意不再派发）。
    const switched = stateOf({ sessionId: 's2', title: 'B 首帧' });
    app.handleHostMessage({
      type: 'render', protocolVersion: 1, sessionId: 's2', revision: 3,
      formRevision: 0, html: render(switched),
    });
    expect(document.querySelector('.panel-title')?.textContent).toBe('B 首帧');
    // B 的后续同会话渲染不被残留组合态暂存（修复前会一直暂存、视图冻结）。
    const updated = stateOf({ sessionId: 's2', title: 'B 更新帧' });
    app.handleHostMessage({
      type: 'render', protocolVersion: 1, sessionId: 's2', revision: 4,
      formRevision: 1, html: render(updated),
    });
    expect(document.querySelector('.panel-title')?.textContent).toBe('B 更新帧');
    // 组合态清除后点击守卫恢复：快捷动作不再被 isComposing 拦截。
    document.querySelector<HTMLButtonElement>('[data-intent="refresh"]')?.click();
    expect(lastIntent(sent)?.intent).toEqual({ kind: 'refresh' });
    app.dispose();
  });
});

describe('瞬时提示与销毁', () => {
  it('toast 消息插入并自动移除', () => {
    vi.useFakeTimers();
    const { app } = setup();
    app.handleHostMessage({ type: 'toast', protocolVersion: 1, sessionId: 's1', level: 'error', message: '失败' });
    expect(document.querySelector('.toast.error')?.textContent).toBe('失败');
    vi.advanceTimersByTime(4100);
    expect(document.querySelector('.toast')).toBeNull();
    vi.useRealTimers();
    app.dispose();
  });

  it('旧会话迟到 toast 被忽略；首帧前握手期 toast 放行', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="app"></div>';
    const { api } = makeApi();
    const app = mountPanel(document, api);
    // 首帧 render 之前（currentSessionId 为空）的 toast 放行，避免丢首个提示。
    app.handleHostMessage({ type: 'toast', protocolVersion: 1, sessionId: 's1', level: 'info', message: '首提示' });
    expect(document.querySelector('.toast.info')?.textContent).toBe('首提示');
    // 新会话首帧 render 落地后会话跟随 s2。
    app.handleHostMessage({
      type: 'render', protocolVersion: 1, sessionId: 's2', revision: 1, formRevision: 0, html: render(stateOf()),
    });
    app.handleHostMessage({ type: 'toast', protocolVersion: 1, sessionId: 's1', level: 'error', message: '旧会话提示' });
    expect(document.querySelector('.toast.error')).toBeNull();
    app.handleHostMessage({ type: 'toast', protocolVersion: 1, sessionId: 's2', level: 'error', message: '新会话提示' });
    expect(document.querySelector('.toast.error')?.textContent).toBe('新会话提示');
    vi.useRealTimers();
    app.dispose();
  });

  it('旧会话迟到 render 后点击以新会话发送（会话跟随最新 render）', () => {
    const { app, sent } = setup();
    const next = stateOf();
    app.handleHostMessage({
      type: 'render', protocolVersion: 1, sessionId: 's2', revision: 2, formRevision: 0, html: render(next),
    });
    document.querySelector<HTMLButtonElement>('[data-intent="refresh"]')?.click();
    expect(lastIntent(sent)?.sessionId).toBe('s2');
    app.dispose();
  });
});

describe('checkbox 表单字段：单通道输入同步', () => {
  function checkSetup(patch: Partial<PanelState> = {}) {
    return setup({
      form: {
        id: 'f',
        busy: false,
        fields: [{ id: 'directMode', label: '直接检出', value: 'false', type: 'checkbox' }],
      },
      ...patch,
    });
  }

  function intentsOf(sent: unknown[]): Array<Record<string, unknown>> {
    return sent
      .filter((m) => (m as { type?: string }).type === 'intent')
      .map((m) => (m as { intent: Record<string, unknown> }).intent);
  }

  it('勾选/取消各发送一次 syncInput，值由 checked 派生（change 单通道）', () => {
    const { app, sent } = checkSetup();
    const box = document.querySelector<HTMLInputElement>('[data-field-id="directMode"]')!;
    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    const intents = intentsOf(sent);
    expect(intents).toHaveLength(2);
    expect(intents[0]).toMatchObject({ kind: 'syncInput', fieldId: 'directMode', value: 'true' });
    expect(intents[1]).toMatchObject({ kind: 'syncInput', fieldId: 'directMode', value: 'false' });
    expect((intents[1].inputRevision as number)).toBeGreaterThan(intents[0].inputRevision as number);
    app.dispose();
  });

  it('input 事件对 checkbox 目标不发送（勾选不走文本输入委托）', () => {
    const { app, sent } = checkSetup();
    const box = document.querySelector<HTMLInputElement>('[data-field-id="directMode"]')!;
    box.checked = true;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    // checkbox 的 value 属性是静态串，input 委托不发送（否则「取消勾选仍发送 true」）。
    expect(intentsOf(sent)).toHaveLength(0);
    app.dispose();
  });

  it('disabled 勾选不产生意图', () => {
    const { app, sent } = checkSetup({
      form: {
        id: 'f',
        busy: false,
        fields: [{ id: 'directMode', label: '直接检出', value: 'false', type: 'checkbox', disabled: true }],
      },
    });
    const box = document.querySelector<HTMLInputElement>('[data-field-id="directMode"]')!;
    expect(box.disabled).toBe(true);
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(intentsOf(sent)).toHaveLength(0);
    app.dispose();
  });

  it('待确认的勾选值不被旧 formRevision 帧回退（checked 恢复）', () => {
    const { app, sent } = checkSetup();
    const box = document.querySelector<HTMLInputElement>('[data-field-id="directMode"]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    const inputRevision = (intentsOf(sent)[0].inputRevision as number) ?? 0;
    const older = stateOf();
    older.form = { id: 'f', busy: false, fields: [{ id: 'directMode', label: '直接检出', value: 'false', type: 'checkbox' }] };
    app.handleHostMessage({
      type: 'render', protocolVersion: 1, sessionId: 's1', revision: 2,
      formRevision: inputRevision - 1, html: render(older),
    });
    expect(document.querySelector<HTMLInputElement>('[data-field-id="directMode"]')!.checked).toBe(true);
    app.dispose();
  });
});

describe('表格交互：排序/翻页/行内定位/文本筛选转发', () => {
  function tableSetup(patch: Partial<PanelState> = {}) {
    return setup({
      list: undefined,
      form: undefined,
      table: {
        id: 'big',
        columns: [
          { key: 'path', label: '路径', sortable: true },
          { key: 'size', label: '大小', sortable: true, sortType: 'number', align: 'right' },
        ],
        sort: { key: 'size', direction: 'desc' },
        filters: [{ id: 'path', kind: 'text', cellKey: 'path', value: '' }],
        pagination: { page: 2, pageSize: 1, total: 3, pageCount: 3 },
        rows: [
          { id: 'r1', cells: { path: 'a.bin', size: '9 GiB' }, actions: [{ id: 'revealFileInOS', label: '定位' }] },
        ],
        empty: { title: '空' },
      },
      ...patch,
    });
  }

  it('点击列头排序按钮发送 setSort（key + 点击后方向）', () => {
    const { app, sent } = tableSetup();
    document.querySelector<HTMLButtonElement>('[data-intent="setSort"][data-sort-key="size"]')?.click();
    expect(lastIntent(sent)?.intent).toEqual({ kind: 'setSort', key: 'size', direction: 'asc' });
    app.dispose();
  });

  it('点击翻页按钮发送 setPage（目标页码）', () => {
    const { app, sent } = tableSetup();
    document.querySelector<HTMLButtonElement>('[data-intent="setPage"][data-page="1"]')?.click();
    expect(lastIntent(sent)?.intent).toEqual({ kind: 'setPage', page: 1 });
    document.querySelector<HTMLButtonElement>('[data-intent="setPage"][data-page="3"]')?.click();
    expect(lastIntent(sent)?.intent).toEqual({ kind: 'setPage', page: 3 });
    app.dispose();
  });

  it('点击行内定位按钮发送 revealFileInOS（只带行 ID，不带路径）', () => {
    const { app, sent } = tableSetup();
    document.querySelector<HTMLButtonElement>('[data-intent="revealFileInOS"][data-row-id="r1"]')?.click();
    expect(lastIntent(sent)?.intent).toEqual({ kind: 'revealFileInOS', rowId: 'r1' });
    app.dispose();
  });

  it('表格文本筛选输入走 setFilter（change 通道，不进表单输入同步）', () => {
    const { app, sent } = tableSetup();
    const input = document.querySelector<HTMLInputElement>('[data-intent="setFilter"][data-filter-id="path"]')!;
    input.value = 'SRC';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(lastIntent(sent)?.intent).toEqual({ kind: 'setFilter', filterId: 'path', value: 'SRC' });
    app.dispose();
  });
});
