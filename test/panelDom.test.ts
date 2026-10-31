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
