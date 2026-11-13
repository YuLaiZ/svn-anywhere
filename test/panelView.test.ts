/**
 * view.ts 渲染测试：关键 HTML 片段（筛选栏、两种空态、禁用态、动作按钮、
 * 忙碌态）与转义边界；DOM 结构沿用原型 class 基线。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitFixture } from '../src/host/panel/fixture';
import { render, renderLazyNodeSlice, renderTableRowSlice, type LazyTreeRowView } from '../src/host/panel/view';
import type {
  FormFieldSpec,
  LazyTreeRowSpec,
  PanelState,
  RowSpec,
  DetailSectionSpec,
  TableRowSpec,
  TableSpec,
} from '../src/host/panel/state';
import { strings, format } from '../src/host/i18n';

function baseState(patch: Partial<PanelState> = {}): PanelState {
  return {
    sessionId: 's',
    title: 'SVN 状态',
    targetLabel: 'wc-a',
    revision: 3,
    formRevision: 0,
    busy: false,
    banners: [],
    ...patch,
  };
}

function listState(rows: RowSpec[], extra: Partial<NonNullable<PanelState['list']>> = {}): PanelState {
  return baseState({
    list: {
      id: 'status',
      columns: [{ key: 'path', label: 'path' }],
      rows,
      filters: [
        {
          id: 'status',
          cellKey: 'status',
          value: 'all',
          options: [
            { value: 'all', label: strings.panel.filterAll },
            { value: 'modified', label: 'modified' },
          ],
        },
      ],
      selection: { total: 0, visible: 0, hidden: 0 },
      empty: { title: strings.panel.emptyTitle, detail: strings.panel.emptyDetail },
      filterEmpty: {
        title: strings.panel.filterEmptyTitle,
        detail: strings.panel.filterEmptyDetail,
        action: { id: 'clearFilters', label: strings.panel.clearFilter },
      },
      ...extra,
    },
  });
}

describe('render：结构基线', () => {
  it('输出 .panel 骨架：panel-header / list / footer', () => {
    const html = render(listState([{ id: 'a', cells: { path: 'a.ts', status: 'modified' } }]));
    expect(html).toContain('class="panel"');
    expect(html).toContain('panel-header');
    expect(html).toContain('panel-title');
    expect(html).toContain('panel-target');
    expect(html).toContain('class="list"');
    expect(html).toContain('class="footer"');
    expect(html).toContain('data-revision="3"');
  });

  it('筛选栏渲染 select 与选项，data-intent=setFilter', () => {
    const html = render(listState([{ id: 'a', cells: { path: 'a.ts', status: 'modified' } }]));
    expect(html).toContain('data-intent="setFilter"');
    expect(html).toContain(`value="all"`);
    expect(html).toContain('<option value="modified">modified</option>');
  });

  it('行渲染：勾选、状态字母、路径、动作按钮', () => {
    const html = render(listState([
      {
        id: 'src/a.ts',
        cells: { path: 'src/a.ts', status: 'modified' },
        selected: true,
        badges: [{ text: 'mylist' }, { text: '属性修改' }],
        actions: [
          { id: 'openDiff', label: strings.panel.actDiff },
          { id: 'openFile', label: strings.panel.actOpen },
        ],
      },
    ]));
    expect(html).toContain('data-intent="toggleRow"');
    expect(html).toContain('checked');
    expect(html).toContain('title="modified"');
    expect(html).toContain('src/a.ts');
    expect(html).toContain('mylist');
    expect(html).toContain(strings.panel.actDiff);
    expect(html).toContain(strings.panel.actOpen);
  });

  it('状态字母映射：missing 显示 ! 且 class 用可作选择器的 missing', () => {
    const html = render(listState([{ id: 'x', cells: { path: 'x', status: 'missing' } }]));
    expect(html).toContain('>!</span>');
    expect(html).toContain('class="st missing"');
  });
});

describe('render：空态', () => {
  it('无条目空态不渲染列表与清除筛选动作', () => {
    const html = render(listState([]));
    expect(html).toContain(strings.panel.emptyTitle);
    expect(html).not.toContain('class="list"');
    expect(html).not.toContain(strings.panel.clearFilter);
  });

  it('筛选无匹配渲染筛选空态与清除筛选动作', () => {
    const html = render(listState([{ id: 'a', cells: { path: 'a.ts', status: 'modified' } }], {
      filters: [
        { id: 'status', cellKey: 'status', value: 'unversioned', options: [] },
      ],
    }));
    expect(html).toContain(strings.panel.filterEmptyTitle);
    expect(html).toContain(`data-intent="clearFilters"`);
    expect(html).toContain(strings.panel.clearFilter);
    expect(html).not.toContain('class="list"');
  });
});

describe('render：禁用与忙碌', () => {
  it('busy 时勾选、筛选、刷新全部禁用且出现 progress', () => {
    const html = render({ ...listState([{ id: 'a', cells: { path: 'a.ts', status: 'modified' } }]), busy: true });
    expect(html).toContain('class="progress"');
    expect(html).toMatch(/type="checkbox"[^>]*disabled/);
    expect(html).toMatch(/<select[^>]*disabled/);
    expect(html).toMatch(/data-intent="refresh"[^>]*disabled/);
  });

  it('行级禁用带可读原因（title/aria-label）', () => {
    const html = render(listState([
      {
        id: 'u1',
        cells: { path: 'u1', status: 'unversioned' },
        disabled: true,
        disabledReason: '未版本控制，没有 BASE；可打开文件查看',
        actions: [
          { id: 'openDiff', label: strings.panel.actDiff, disabled: true, disabledReason: strings.panel.actDiffNoBase },
        ],
      },
    ]));
    expect(html).toContain('disabled');
    expect(html).toContain(strings.panel.actDiffNoBase);
  });
});

describe('render：转义', () => {
  it('路径与属性值在文本/属性上下文都转义', () => {
    const evil = `a"onmouseover="x` + `<b>&'`;
    const html = render(listState([{ id: evil, cells: { path: evil, status: 'modified' } }]));
    expect(html).not.toContain('<b>&');
    expect(html).toContain('&lt;b&gt;&amp;');
    expect(html).toContain('&quot;onmouseover=&quot;');
  });

  it('说明输入值转义 </textarea> 防逃逸', () => {
    const html = render(baseState({
      form: {
        id: 'm',
        busy: false,
        fields: [{ id: 'message', label: '说明', value: '</textarea><script>alert(1)</script>', type: 'textarea' }],
      },
    }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;/textarea&gt;');
  });

  it('提示条 detail 预格式渲染（stderr 原样）', () => {
    const html = render(baseState({
      banners: [{ id: 'e', level: 'error', title: '读取失败', detail: 'svn: E155004: <locked>\n&more', preformatted: true }],
    }));
    expect(html).toContain('<pre>');
    expect(html).toContain('&lt;locked&gt;');
  });
});

describe('render：说明输入与计数', () => {
  it('form 渲染 textarea 且带 data-field-id 稳定标识', () => {
    const html = render(baseState({
      form: {
        id: 'm',
        busy: false,
        fields: [{ id: 'message', label: strings.panel.messageLabel, value: '草稿', type: 'textarea' }],
      },
    }));
    expect(html).toContain('data-field-id="message"');
    expect(html).toContain('>草稿</textarea>');
  });

  it('隐藏已选计数出现在标题区与页脚', () => {
    const html = render(listState(
      [{ id: 'a', cells: { path: 'a', status: 'modified' }, selected: true }],
      { selection: { total: 2, visible: 1, hidden: 1 } },
    ));
    expect(html).toContain(strings.panel.countsHidden.replace('{count}', '1'));
  });

  it('0a fixture 条目可直接进入渲染（typed fixture 复用为测试数据）', () => {
    const items = commitFixture('normal').items;
    const rows: RowSpec[] = items.map((item) => ({
      id: item.id,
      cells: { path: item.path, status: item.wcStatus },
      selected: item.selected,
      badges: item.badges,
    }));
    const html = render(listState(rows));
    expect(html).toContain('src/core/status.ts');
    expect(html).toContain('tmp/scratch.md');
  });
});

describe('render：P1 树形与提交面板片段', () => {
  function treeRows(): RowSpec[] {
    return [
      {
        id: 'local|src',
        group: 'local',
        nav: { path: 'src' },
        cells: {},
        children: [
          { id: 'src/a.ts', group: 'local', cells: { path: 'src/a.ts', status: 'modified' }, selected: true },
          { id: 'src/b.ts', group: 'local', cells: { path: 'src/b.ts', status: 'modified' } },
        ],
      },
      {
        id: 'unversioned|new',
        group: 'unversioned',
        nav: { path: 'new' },
        cells: {},
        children: [
          { id: 'new/u.ts', group: 'unversioned', cells: { path: 'new/u.ts', status: 'unversioned' }, selected: false },
        ],
      },
    ];
  }

  it('树模式渲染导航目录（聚合勾选+折叠按钮）与树内 basename 显示', () => {
    const state = listState(treeRows(), {
      viewMode: 'tree',
      groups: [{ id: 'local', label: '本地变更' }, { id: 'unversioned', label: '未版本控制' }],
    });
    const html = render(state);
    expect(html).toContain('tree-folder');
    expect(html).toContain('data-node-id="local|src"');
    expect(html).toContain('data-nav-key="local|src"');
    expect(html).toContain('data-intent="toggleTree"');
    // 树内叶行显示 basename，title 保留完整路径。
    expect(html).toMatch(/title="src\/a\.ts"[^>]*>a\.ts</);
    // 组头渲染与 data-indeterminate 半选标记（local 组 2 选 1）。
    expect(html).toContain('data-intent="toggleGroup"');
    expect(html).toContain('data-group-id="local"');
  });

  it('列表模式平铺完整路径，无导航节点', () => {
    const state = listState(treeRows(), {
      viewMode: 'list',
      groups: [{ id: 'local', label: '本地变更' }, { id: 'unversioned', label: '未版本控制' }],
    });
    const html = render(state);
    expect(html).not.toContain('tree-folder');
    expect(html).toContain('>src/a.ts</span>');
    expect(html).toContain('>new/u.ts</span>');
  });

  it('成功卡片独立渲染（level=success 的 commitSuccess banner）', () => {
    const state = baseState({
      banners: [{ id: 'commitSuccess', level: 'success', title: '提交成功', detail: '已提交 2 项 · revision r9' }],
    });
    const html = render(state);
    expect(html).toContain('success-card');
    expect(html).toContain('success-icon');
    expect(html).not.toContain('<div class="banners">');
  });

  it('unknown 写锁定：折叠按钮、提交、关闭、筛选全部禁用', () => {
    const state = listState(treeRows(), {
      viewMode: 'tree',
      groups: [{ id: 'local', label: '本地变更' }],
    });
    state.writeLocked = true;
    state.footer = {
      summary: '提交结果待核实，暂不能重提',
      primary: { id: 'submit', label: '待核实', disabled: true },
      secondary: [{ id: 'closePanel', label: '关闭', disabled: true }],
    };
    const html = render(state);
    expect(html).toMatch(/data-nav-key="local\|src"[^>]*disabled/);
    expect(html).toMatch(/data-intent="setFilter"[^>]*disabled/);
    expect(html).toMatch(/data-intent="submit"[^>]*disabled/);
  });

  it('选择工具条渲染已选计数与动作链接', () => {
    const state = listState(treeRows(), {
      groups: [{ id: 'local', label: '本地变更' }, { id: 'unversioned', label: '未版本控制' }],
      selectionActions: [
        { id: 'selectVisible', label: '选择可见可提交项' },
        { id: 'clearSelection', label: '清空全部勾选' },
      ],
      selection: { total: 1, visible: 1, hidden: 0 },
    });
    const html = render(state);
    expect(html).toContain('selection-bar');
    expect(html).toContain('已选 1 项');
    expect(html).toContain('data-intent="selectVisible"');
  });

  it('说明工具条渲染前缀 chips 与历史按钮', () => {
    const state = baseState({
      form: {
        id: 'message',
        busy: false,
        fields: [{ id: 'message', label: '提交说明', value: '', type: 'textarea' }],
        tools: [
          { id: 'applyPrefix', label: '修复', payload: { index: '0' } },
          { id: 'managePrefixes', label: '前缀…' },
        ],
      },
    });
    const html = render(state);
    expect(html).toContain('class="chip"');
    expect(html).toContain('data-intent="applyPrefix"');
    expect(html).toContain('data-index="0"');
  });
});

describe('render：P2 忽略规则编辑器片段', () => {
  function ignoreState(patch: Partial<PanelState> = {}): PanelState {
    return baseState({
      title: strings.ignorePanel.panelTitle,
      headerBadges: [{ text: '已读取' }, { text: '2 条' }],
      headerActions: [{ id: 'refresh', label: strings.ignorePanel.reload }],
      hint: strings.ignorePanel.hint,
      ignoreEditor: {
        rules: [
          { index: 0, text: '*.log' },
          { index: 1, text: 'build' },
        ],
        listLabel: strings.ignorePanel.panelTitle,
        removeLabel: strings.ignorePanel.removeRuleLabel,
        empty: { title: strings.ignorePanel.emptyUnset, detail: strings.ignorePanel.emptyUnsetDetail, extra: strings.ignorePanel.emptyOtherSources },
        draft: { fieldId: 'draft', label: strings.ignorePanel.draftLabel, value: '', placeholder: strings.ignorePanel.draftPlaceholder },
        addNote: strings.ignorePanel.addNote,
        noOriginNote: strings.ignorePanel.noOriginNote,
        addAction: { id: 'addRule', label: strings.ignorePanel.addRule, disabled: true, disabledReason: strings.ignorePanel.addRuleEmptyReason },
      },
      footer: {
        summary: strings.ignorePanel.summaryClean,
        primary: { id: 'submitIgnore', label: strings.ignorePanel.commitButton, disabled: true, disabledReason: strings.ignorePanel.commitButtonReason },
        secondary: [
          { id: 'closePanel', label: strings.ignorePanel.closeButton },
          { id: 'saveIgnore', label: strings.ignorePanel.saveButton, disabled: true, disabledReason: strings.ignorePanel.saveButtonReason },
        ],
      },
      ...patch,
    });
  }

  it('规则行、待加入输入、页脚（关闭/保存/提交）与标题徽标渲染', () => {
    const html = render(ignoreState());
    expect(html).toContain('class="rules"');
    expect(html).toContain('rule-row');
    expect(html).toContain('rule-text">*.log');
    expect(html).toContain('data-intent="removeRule" data-index="1"');
    expect(html).toContain('aria-label="移除规则 *.log"');
    expect(html).toContain('add-area');
    expect(html).toContain('data-field-id="draft"');
    expect(html).toContain('data-intent="addRule"');
    expect(html).toContain(strings.ignorePanel.hint.slice(0, 10));
    expect(html).toContain('badge">已读取');
    expect(html).toContain('2 条');
    expect(html).toContain('data-intent="refresh"');
    // 页脚三按钮齐全。
    expect(html).toContain('data-intent="closePanel"');
    expect(html).toContain('data-intent="saveIgnore"');
    expect(html).toContain('data-intent="submitIgnore"');
  });

  it('规则文本与属性上下文都转义（通配符/尖括号/引号原样展示）', () => {
    const html = render(ignoreState({
      ignoreEditor: {
        rules: [{ index: 0, text: 'cache[[]1[]][?].log' }, { index: 1, text: 'a<b>&"q".tmp' }],
        listLabel: 'rules',
        removeLabel: '移除',
        empty: { title: 'e' },
        draft: { fieldId: 'draft', label: 'd', value: '', placeholder: '' },
        addNote: 'n',
        addAction: { id: 'addRule', label: '加入' },
      },
    }));
    expect(html).toContain('rule-text">cache[[]1[]][?].log');
    expect(html).toContain('a&lt;b&gt;&amp;&quot;q&quot;.tmp');
  });

  it('锁定时编辑区控件随 busy 禁用一致', () => {
    const html = render(ignoreState({
      busy: true,
      ignoreEditor: {
        rules: [{ index: 0, text: '*.log' }],
        listLabel: 'rules',
        removeLabel: '移除',
        empty: { title: 'e' },
        draft: { fieldId: 'draft', label: 'd', value: '', placeholder: '', disabled: true },
        addNote: 'n',
        addAction: { id: 'addRule', label: '加入', disabled: true },
        busy: true,
      },
    }));
    expect((html.match(/disabled/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('data-busy="1"');
  });
});

describe('render：表格组件（TableSpec）', () => {
  function tableState(patch: Partial<NonNullable<PanelState['table']>> = {}, statePatch: Partial<PanelState> = {}): PanelState {
    return baseState({
      table: {
        id: 'big',
        columns: [
          { key: 'path', label: '路径', sortable: true },
          { key: 'size', label: '大小', sortable: true, sortType: 'number', align: 'right' },
          { key: 'note', label: '备注' },
        ],
        sort: { key: 'size', direction: 'desc' },
        filters: [
          { id: 'path', kind: 'text', cellKey: 'path', value: '' },
          {
            id: 'ext', kind: 'select', cellKey: 'ext', value: 'all',
            options: [{ value: 'all', label: '全部' }, { value: 'ts', label: 'ts' }],
          },
        ],
        pagination: { page: 1, pageSize: 50, total: 2, pageCount: 1 },
        rows: [
          { id: 'r1', cells: { path: 'src/a.ts', size: '9 GiB', ext: 'ts' }, actions: [{ id: 'revealFileInOS', label: '定位' }] },
          { id: 'r2', cells: { path: 'b.bin', size: '100 B', ext: 'bin' } },
        ],
        empty: { title: '无大文件' },
        filterEmpty: { title: '无匹配文件' },
        note: '部分结果：1 个目录不可读',
        ...patch,
      },
      ...statePatch,
    });
  }

  it('渲染列头、行、行内动作按钮（意图只带行 ID）', () => {
    const html = render(tableState());
    expect(html).toContain('class="table-block"');
    expect(html).toContain('data-sort-key="path"');
    expect(html).toContain('data-sort-key="size"');
    expect(html).toContain('<td class="col align-right">9 GiB</td>');
    expect(html).toContain('data-intent="revealFileInOS" data-row-id="r1"');
    expect(html).toContain('>定位</button>');
  });

  it('sortable 列渲染排序按钮且当前列带方向指示；非 sortable 列只有文本', () => {
    const html = render(tableState());
    // size 是当前排序列（desc）：按钮标记 active、指示 ↓、下一方向 asc。
    expect(html).toContain('data-sort-key="size" data-sort-direction="asc"');
    expect(html).toMatch(/th-sort active[^>]*>大小/);
    // path 未激活：从升序开始。
    expect(html).toContain('data-sort-key="path" data-sort-direction="asc"');
    // note 列不可排序：无排序按钮。
    expect(html).toContain('<th class="col" scope="col">备注</th>');
  });

  it('text 筛选渲染输入框、select 筛选渲染下拉（data-filter-id 绑定）', () => {
    const html = render(tableState());
    expect(html).toMatch(/<input type="text" data-intent="setFilter" data-filter-id="path"/);
    expect(html).toMatch(/<select data-intent="setFilter" data-filter-id="ext"/);
    expect(html).toContain('<option value="all" selected>全部</option>');
  });

  it('分页只在多页时渲染：翻页意图带目标页码', () => {
    const single = render(tableState());
    expect(single).not.toContain('data-intent="setPage"');
    const paged = render(tableState({ pagination: { page: 2, pageSize: 1, total: 2, pageCount: 2 } }));
    expect(paged).toContain('data-page="1"');
    expect(paged).toContain('data-page="3"');
    expect(paged).toContain('第 2 / 2 页');
  });

  it('无行时按筛选活跃与否渲染两种空态；note 始终渲染', () => {
    const noRows = render(tableState({ rows: [] }));
    expect(noRows).toContain('无大文件');
    const filteredEmpty = render(tableState({
      rows: [],
      filters: [{ id: 'path', kind: 'text', cellKey: 'path', value: 'zzz' }],
    }));
    expect(filteredEmpty).toContain('无匹配文件');
    expect(filteredEmpty).toContain('部分结果：1 个目录不可读');
  });

  it('占用态无放行视图：表格通用控件全禁（基线面板现状）', () => {
    const html = render(tableState({}, { busy: true }));
    expect(html).toMatch(/data-intent="setSort"[^>]*disabled/);
    expect(html).toMatch(/data-intent="setFilter"[^>]*disabled/);
    expect(html).toMatch(/data-intent="revealFileInOS"[^>]*disabled/);
  });

  it('占用态按放行视图禁用：busy 帧中放行的只读控件可交互、未放行的禁用', () => {
    const html = render(tableState({}, {
      busy: true,
      gate: {
        busy: ['setSort', 'setFilter', 'setPage', 'revealFileInOS', 'viewTaskLog'],
        writeLocked: [],
      },
    }));
    expect(html).not.toMatch(/data-intent="setSort"[^>]*disabled/);
    expect(html).not.toMatch(/data-intent="setFilter"[^>]*disabled/);
    expect(html).not.toMatch(/data-intent="revealFileInOS"[^>]*disabled/);
    // 放行视图只覆盖 busy 行；writeLocked 行为空集不影响 busy 帧。
  });
});

describe('render：向导步骤条（steps）', () => {
  it('渲染三步向导，当前步高亮、已过步弱化、未到步默认', () => {
    const html = render(baseState({
      steps: { labels: ['填写信息', '核对范围', '执行与结果'], current: 1 },
    }));
    expect(html).toContain('class="steps"');
    expect(html).toMatch(/class="step done"><span class="step-index" aria-hidden="true">1<\/span><span class="step-label">填写信息<\/span>/);
    expect(html).toMatch(/class="step current"><span class="step-index" aria-hidden="true">2<\/span><span class="step-label">核对范围<\/span>/);
    expect(html).toMatch(/class="step"><span class="step-index" aria-hidden="true">3<\/span><span class="step-label">执行与结果<\/span>/);
  });

  it('未声明 steps 时不渲染步骤条（M2 面板零变化）', () => {
    expect(render(baseState())).not.toContain('class="steps"');
  });
});

describe('render：P5 懒加载树（LazyTreeSpec）', () => {
  /** 以 P5 扩展行形状构造节点（字段在 state.ts 声明前先按结构验证渲染）。 */
  function nodeView(row: LazyTreeRowView): LazyTreeRowSpec {
    return row;
  }

  function treeState(patch: Partial<PanelState> = {}): PanelState {
    return baseState({
      layout: {
        layout: 'master-detail',
        masterLabel: '远端目录',
        detailLabel: '节点详情',
        masterScrollKey: 'browser-tree',
        detailScrollKey: 'browser-detail',
      },
      lazyTree: {
        id: 'browser',
        ariaLabel: '远端目录树',
        rows: [
          nodeView({
            id: 'trunk',
            label: 'trunk',
            kind: 'dir',
            depth: 0,
            phase: 'ready',
            loaded: 40,
            total: 1284,
            expanded: true,
            selected: true,
            statusText: '已读取 40 / 总计 1,284',
            expandLabel: '折叠目录 trunk',
            repoPath: '^/trunk',
            nodeUrl: 'https://example.com/svn/trunk',
            kindLabel: '目录',
            metaText: '1,284 项',
            lastChanged: { revision: 'r1284', author: 'alice', date: '2026-11-13' },
            children: [
              nodeView({
                id: 'trunk/docs',
                label: 'docs',
                kind: 'dir',
                depth: 1,
                phase: 'loading',
                metadata: 'filling',
                metadataProgress: { completed: 20, total: 40 },
                metadataCancelAction: { id: 'refreshBrowserNode', label: '取消补全' },
              }),
              nodeView({
                id: 'trunk/a.ts',
                label: 'a.ts',
                kind: 'file',
                depth: 1,
                phase: 'idle',
                metadata: 'pending',
                kindLabel: '文件',
                metaText: '12.4 KB',
              }),
              nodeView({
                id: 'trunk/empty',
                label: 'empty',
                kind: 'dir',
                depth: 1,
                phase: 'ready',
                loaded: 0,
                total: 0,
                emptyText: '空目录',
              }),
              nodeView({
                id: 'trunk/huge',
                label: 'huge',
                kind: 'dir',
                depth: 1,
                phase: 'error',
                tooLarge: true,
                statusText: '目录超出当前完整读取上限',
              }),
            ],
          }),
          nodeView({
            id: 'trunk/broken',
            label: 'broken',
            kind: 'dir',
            depth: 0,
            phase: 'error',
            statusText: '读取该目录失败',
            actions: [{ id: 'retryBrowserNode', label: '重试' }],
          }),
        ],
        empty: { title: '空目录', detail: '这个目录没有直属条目。' },
        loadMoreAction: { id: 'loadMoreBrowserNode', label: '加载更多', payload: { 'node-id': 'trunk' } },
      },
      detail: {
        title: 'trunk',
        subtitle: '远端目录 · 节点最后修改 r1284',
        sections: [
          { kind: 'kv', heading: '节点信息', entries: [
            { label: '节点 URL', value: 'https://example.com/svn/trunk', mono: true },
            { label: '仓库相对路径', value: '^/trunk', mono: true },
          ] },
          { kind: 'text', heading: '说明', paragraphs: ['只读浏览。'] },
          { kind: 'pre', heading: '原始输出', text: 'svn: <info> & more' },
          { kind: 'actions', actions: [{ id: 'copyBrowserNodeUrl', label: '复制 URL' }] },
        ],
      },
      ...patch,
    });
  }

  it('主从布局渲染两个独立滚动 pane（data-scroll-key）与稳定节点标识', () => {
    const html = render(treeState());
    expect(html).toContain('class="split-layout layout-master-detail"');
    expect(html).toContain('data-scroll-key="browser-tree"');
    expect(html).toContain('data-scroll-key="browser-detail"');
    expect((html.match(/class="pane-scroll"/g) ?? []).length).toBe(2);
    expect(html).toContain('aria-label="远端目录树"');
    expect(html).toContain('role="treeitem"');
    expect(html).toContain('aria-level="2"');
  });

  it('展开、选择、重试是独立标记：节点动作只带稳定 nodeId', () => {
    const html = render(treeState());
    expect(html).toContain('data-intent="toggleBrowserNode" data-node-id="trunk"');
    expect(html).toContain('data-intent="selectBrowserNode" data-node-id="trunk"');
    expect(html).toContain('data-intent="retryBrowserNode" data-node-id="trunk/broken"');
    expect(html).toContain('data-intent="loadMoreBrowserNode"');
    expect(html).toContain('data-node-id="trunk"');
    expect(html).toContain('aria-expanded="true"');
  });

  it('已读取/总数与元数据补全状态分开显示；pending 行显示占位', () => {
    const html = render(treeState());
    expect(html).toContain('已读取 40 / 总计 1,284');
    expect(html).toContain('class="node-pending muted"');
    expect(html).toContain('node-metadata-progress');
    expect(html).toContain('20 / 40');
    expect(html).toContain('width:50.0%');
  });

  it('详情段：键值/文本/预格式/动作，动态值全部转义', () => {
    const html = render(treeState());
    expect(html).toContain('class="detail-title">trunk<');
    expect(html).toContain('class="kv"');
    expect(html).toContain('<dt>节点 URL</dt><dd class="mono">https://example.com/svn/trunk</dd>');
    expect(html).toContain('<pre>svn: &lt;info&gt; &amp; more</pre>');
    expect(html).toContain('data-intent="copyBrowserNodeUrl"');
  });

  it('空目录渲染空态；balanced 布局带独立修饰类', () => {
    const empty = render(treeState({
      lazyTree: { id: 'browser', rows: [], empty: { title: '空目录' } },
      layout: { layout: 'balanced' },
    } as Partial<PanelState>));
    expect(empty).toContain('空目录');
    expect(empty).toContain('layout-balanced');
  });

  it('节点行显示名称、节点 URL、^/ 相对路径、最后修改与自身元数据（size/kind）', () => {
    const html = render(treeState());
    expect(html).toContain('class="node-label" data-intent="selectBrowserNode" data-node-id="trunk"');
    expect(html).toContain('class="node-repo-path mono">^/trunk</span>');
    expect(html).toContain('class="node-url mono" title="https://example.com/svn/trunk">https://example.com/svn/trunk</span>');
    expect(html).toContain('class="node-last-changed">r1284 · alice · 2026-11-13</span>');
    expect(html).toContain('class="node-kind">目录</span>');
    expect(html).toContain('class="node-size">1,284 项</span>');
    expect(html).toContain('class="node-kind">文件</span>');
    expect(html).toContain('class="node-size">12.4 KB</span>');
  });

  it('两段式元数据：pending 待补全、filling 已补全 X / Y 与取消按钮、cancelled 已取消', () => {
    const html = render(treeState());
    expect(html).toContain(strings.panel.metadataPending);
    expect(html).toContain('元数据补全中：已补全 20 / 40');
    expect(html).toMatch(
      /<button[^>]*data-intent="refreshBrowserNode"[^>]*data-node-id="trunk\/docs"[^>]*>取消补全<\/button>/,
    );
    const cancelled = render(treeState({
      lazyTree: {
        id: 'browser',
        rows: [
          nodeView({
            id: 'trunk',
            label: 'trunk',
            kind: 'dir',
            depth: 0,
            phase: 'ready',
            loaded: 40,
            total: 1284,
            metadata: 'cancelled',
            metadataProgress: { completed: 20, total: 1284 },
          }),
        ],
        empty: { title: '空目录' },
      },
    } as Partial<PanelState>));
    expect(cancelled).toContain(strings.panel.metadataCancelled);
  });

  it('节点错误徽标、空目录徽标与 tooLarge 降级说明分开渲染', () => {
    const html = render(treeState());
    expect(html).toContain('class="node-error-badge" title="读取该目录失败">读取失败</span>');
    // 空目录只由 ready + total=0 派生，不是读取失败。
    expect(html).toContain('class="node-empty">空目录</span>');
    expect(html).toMatch(/class="node-limit" role="alert">目录超出当前完整读取上限<\/div>/);
    // tooLarge 行不叠加「读取失败」徽标（超限不是节点读取错误）。
    const hugeStart = html.indexOf('data-node-id="trunk/huge"');
    const hugeEnd = html.indexOf('data-node-id="trunk/broken"');
    expect(hugeStart).toBeGreaterThan(-1);
    expect(hugeEnd).toBeGreaterThan(hugeStart);
    expect(html.slice(hugeStart, hugeEnd)).not.toContain('node-error-badge');
  });

  it('首批 40 切片与加载更多：只渲染宿主切片，按钮只带稳定节点 ID', () => {
    const slice = (start: number, count: number) =>
      Array.from({ length: count }, (_, index) =>
        nodeView({
          id: `file-${start + index}.txt`,
          label: `file-${start + index}.txt`,
          kind: 'file',
          depth: 0,
          phase: 'ready',
        }),
      );
    const first = render(treeState({
      lazyTree: {
        id: 'browser',
        rows: slice(0, 40),
        empty: { title: '空目录' },
        loadMoreAction: { id: 'loadMoreBrowserNode', label: '加载更多', payload: { 'node-id': 'root' } },
      },
    } as Partial<PanelState>));
    expect((first.match(/role="treeitem"/g) ?? []).length).toBe(40);
    expect(first).toContain('class="tree-rows" role="group" data-append-key="browser"');
    expect(first).toContain('data-intent="loadMoreBrowserNode" data-node-id="root"');
    expect(first).not.toMatch(/data-intent="loadMoreBrowserNode"[^>]*data-tree-id/);
    // append 累积切片：第二批后 80 行，仍只有一个加载更多入口。
    const appended = render(treeState({
      lazyTree: {
        id: 'browser',
        rows: [...slice(0, 40), ...slice(40, 40)],
        empty: { title: '空目录' },
        loadMoreAction: { id: 'loadMoreBrowserNode', label: '加载更多', payload: { 'node-id': 'root' } },
      },
    } as Partial<PanelState>));
    expect((appended.match(/role="treeitem"/g) ?? []).length).toBe(80);
    expect((appended.match(/data-intent="loadMoreBrowserNode"/g) ?? []).length).toBe(1);
    // append 消息载荷：只渲染新增节点片段，不含树容器/空态/加载更多。
    const sliceHtml = renderLazyNodeSlice(treeState(), slice(40, 40), 'browser');
    expect((sliceHtml.match(/role="treeitem"/g) ?? []).length).toBe(40);
    expect(sliceHtml).not.toContain('class="lazy-tree"');
    expect(sliceHtml).not.toContain('tree-load-more');
  });

  it('append 定位键挂在节点子行容器上：treeId:nodeId，不在每个行节点上', () => {
    const html = render(treeState());
    // 根行 trunk 的 children 容器是加载更多的追加目标。
    expect(html).toContain(
      'class="tree-node-children" role="group" data-append-key="browser:trunk"',
    );
    // 行节点自身不带 data-append-key（追加目标是子容器，不是行）。
    expect(html).not.toMatch(/<div class="tree-node [^"]*"[^>]*data-append-key/);
    // 增量片段内展开节点的子容器同样按 treeId:nodeId 定位，供后续 append 使用。
    const nested = renderLazyNodeSlice(treeState(), [
      nodeView({
        id: 'trunk/docs',
        label: 'docs',
        kind: 'dir',
        depth: 1,
        phase: 'ready',
        expanded: true,
        children: [
          nodeView({ id: 'trunk/docs/deep.txt', label: 'deep.txt', kind: 'file', depth: 2, phase: 'ready' }),
        ],
      }),
    ], 'browser');
    expect(nested).toContain(
      'class="tree-node-children" role="group" data-append-key="browser:trunk/docs"',
    );
    expect(nested).toContain('data-node-id="trunk/docs/deep.txt"');
    expect(nested).not.toContain('class="tree-rows"');
  });

  it('CSS 契约：P5 行在 294/400 宽度无横向溢出（对齐既有断点）', () => {
    const css = readFileSync(join(process.cwd(), 'media/panel.css'), 'utf8');
    // 400px 既有断点内改为上下布局，并收缩节点次级信息缩进与详情键值列。
    expect(css).toContain('@media (max-width: 400px)');
    expect(css).toContain('.split-layout { flex-direction: column; }');
    expect(css).toMatch(/\.node-sub,\s*\.node-flags \{ padding-left: 12px; \}/);
    expect(css).toContain('grid-template-columns: minmax(0, max-content) minmax(0, 1fr)');
    // 长 URL/路径允许任意换行且可收缩，树在 pane-scroll 内滚动。
    expect(css).toMatch(
      /\.node-repo-path,\s*\.node-url \{ min-width: 0; overflow-wrap: anywhere; word-break: break-all; \}/,
    );
    expect(css).toContain('.pane-scroll > .lazy-tree { flex: none; min-height: auto; overflow: visible; }');
  });
});

describe('render：P6 表格选择与 append 分页', () => {
  function historyState(patch: Partial<NonNullable<PanelState['table']>> = {}, statePatch: Partial<PanelState> = {}): PanelState {
    return baseState({
      table: {
        id: 'history',
        columns: [
          { key: 'revision', label: 'Revision', sortable: true },
          { key: 'message', label: '说明' },
        ],
        sort: { key: 'revision', direction: 'desc' },
        pagination: { page: 1, pageSize: 2, total: 50, pageCount: 1, mode: 'append' },
        selection: { mode: 'revision', maxSelected: 2, ariaLabel: '选择要比较的 revision' },
        rows: [
          {
            id: 'r9',
            cells: { revision: 'r9', message: 'fix' },
            selected: true,
            selectionLabel: '勾选 revision r9',
          },
          {
            id: 'r8',
            cells: { revision: 'r8', message: 'feat' },
            selectionLabel: '勾选 revision r8',
          },
          {
            id: 'r7',
            cells: { revision: 'r7', message: 'chore' },
            disabled: true,
            disabledReason: '节点在该 revision 不存在',
            selectionLabel: '勾选 revision r7',
          },
        ],
        loadMoreAction: { id: 'loadMoreHistory', label: '加载更多' },
        empty: { title: '无历史' },
        ...patch,
      },
      ...statePatch,
    });
  }

  it('selection 渲染勾选列：checked/disabled/可访问名称与行选中态', () => {
    const html = render(historyState());
    expect(html).toContain('<th class="col select" scope="col" aria-label="选择要比较的 revision">');
    expect(html).toContain('data-intent="toggleHistoryRevision" data-row-id="r9"');
    expect(html).toMatch(/data-row-id="r9"[^>]*data-intent="selectHistoryRevision"/);
    expect(html).toContain('aria-label="勾选 revision r7"');
    expect(html).toMatch(/data-row-id="r9"[^>]*checked/);
    expect(html).toMatch(/data-row-id="r7"[^>]*disabled/);
    expect(html).toContain('title="节点在该 revision 不存在"');
    expect(html).toMatch(/<tr data-row-id="r9" class="selected"/);
  });

  it('append 模式不渲染上一页/下一页，只渲染外部加载更多动作', () => {
    const html = render(historyState({ pagination: { page: 1, pageSize: 2, total: 50, pageCount: 25, mode: 'append' } }));
    expect(html).not.toContain('data-intent="setPage"');
    expect(html).toContain('data-intent="loadMoreHistory"');
    expect(html).toContain('class="table-load-more"');
  });

  it('append 空态（筛选无匹配）仍保留加载更多入口', () => {
    const html = render(historyState({ rows: [] }, {
      filterPanel: undefined,
    }));
    expect(html).toContain('无历史');
    expect(html).toContain('data-intent="loadMoreHistory"');
  });

  it("page 模式保持既有翻页；滚动键按表格 ID 稳定", () => {
    const html = render(historyState({
      pagination: { page: 2, pageSize: 1, total: 2, pageCount: 2 },
    }));
    expect(html).toContain('data-intent="setPage"');
    expect(html).toContain('data-scroll-key="table-history"');
  });

  it('比较候选表格可覆盖行点击意图（selectCompareCandidate），不写死历史意图', () => {
    const html = render(historyState({ rowSelectIntent: 'selectCompareCandidate', selection: undefined }));
    expect(html).toContain('data-intent="selectCompareCandidate" data-focus="table-row-r9"');
    expect(html).not.toContain('data-intent="selectHistoryRevision"');
  });

  it('占用态无放行视图时勾选与行选中一并禁用', () => {
    const html = render(historyState({}, { busy: true }));
    expect(html).toMatch(/data-intent="toggleHistoryRevision"[^>]*disabled/);
    expect(html).not.toContain('data-intent="selectHistoryRevision"');
  });
});

describe('render：P6 历史表格（行、append 页脚与增量行片段）', () => {
  function historyTable(patch: Partial<TableSpec> = {}): TableSpec {
    return {
      id: 'history',
      columns: [
        { key: 'revision', label: 'Revision', sortable: true },
        { key: 'author', label: '作者' },
        { key: 'date', label: '日期' },
        { key: 'message', label: '提交说明' },
        { key: 'paths', label: '变更路径数', align: 'right' },
      ],
      sort: { key: 'revision', direction: 'desc' },
      pagination: { page: 1, pageSize: 2, total: 80, pageCount: 1, mode: 'append' },
      selection: { mode: 'revision', maxSelected: 2, ariaLabel: '选择要比较的 revision' },
      rows: [
        {
          id: 'r1280',
          cells: {
            revision: 'r1280',
            author: '林舟',
            date: '2026-11-13',
            message: '修复 <面板> & 渲染',
            paths: '3',
          },
          selected: true,
          selectionLabel: '勾选 revision r1280',
          actions: [{ id: 'viewHistoryRevision', label: '查看此版本' }],
        },
        {
          id: 'r1279',
          cells: {
            revision: 'r1279',
            author: '周宁',
            date: '2026-11-12',
            message: 'feat: 新增行',
            paths: '1',
          },
          selectionLabel: '勾选 revision r1279',
        },
      ],
      loadMoreAction: { id: 'loadMoreHistory', label: strings.panel.loadMoreHistory },
      loadMoreInfo: {
        summary: '已显示 50 / 共 80 条',
        sessionSummary: '会话已扫描 1,000 条 revision · 目标历史 80 条',
        thisLoad: { rawFetched: 500, uniqueScanned: 497 },
      },
      empty: { title: '没有历史记录' },
      filterEmpty: { title: '没有匹配当前筛选的历史记录' },
      ...patch,
    };
  }

  it('行显示 revision/作者/日期/摘要/变更路径数五列，摘要转义', () => {
    const html = render(baseState({ table: historyTable() }));
    // 列头：勾选列 + 五个数据列（Revision 是可排序列，渲染为排序按钮）。
    expect((html.match(/scope="col"/g) ?? []).length).toBe(6);
    expect(html).toContain('data-sort-key="revision"');
    for (const label of ['Revision', '作者', '日期', '提交说明', '变更路径数']) {
      expect(html).toContain(label);
    }
    const row = html.slice(html.indexOf('<tr data-row-id="r1280"'), html.indexOf('<tr data-row-id="r1279"'));
    expect(row).toContain('>r1280</td>');
    expect(row).toContain('>林舟</td>');
    expect(row).toContain('>2026-11-13</td>');
    expect(row).toContain('修复 &lt;面板&gt; &amp; 渲染');
    expect(row).toContain('align-right">3</td>');
    expect(row).toMatch(/aria-selected="true"/);
    expect(row).toContain('data-intent="viewHistoryRevision" data-row-id="r1280"');
  });

  it('append 模式 tbody 带 data-append-key（table.id）；page 模式不带', () => {
    const append = render(baseState({ table: historyTable() }));
    expect(append).toContain('<tbody data-append-key="history">');
    const page = render(baseState({
      table: historyTable({ pagination: { page: 1, pageSize: 50, total: 2, pageCount: 1 } }),
    }));
    expect(page).toContain('<tbody>');
    expect(page).not.toContain('data-append-key="history"');
  });

  it('加载更多旁显示本次/累计计数（本轮原始回包数与唯一 revision 数）', () => {
    const html = render(baseState({ table: historyTable() }));
    const more = html.slice(html.indexOf('class="table-load-more"'));
    expect(more).toContain('class="table-load-more-info"');
    expect(more).toContain('已显示 50 / 共 80 条');
    expect(more).toContain('会话已扫描 1,000 条 revision · 目标历史 80 条');
    expect(more).toContain(format(strings.historyPanel.scannedThisLoad, { count: '500' }));
    expect(more).toContain(format(strings.historyPanel.uniqueRevisionsThisLoad, { count: '497' }));
    expect(more).toContain('data-intent="loadMoreHistory"');
  });

  it('宿主未提供 loadMoreInfo 时页脚回退显示已展示/可见累计计数', () => {
    const html = render(baseState({ table: historyTable({ loadMoreInfo: undefined }) }));
    const more = html.slice(html.indexOf('class="table-load-more"'));
    expect(more).toContain(format(strings.historyPanel.displayedSummary, { displayed: '2' }));
    expect(more).toContain(format(strings.historyPanel.visibleSummary, { visible: '80' }));
    expect(more).not.toContain('class="load-more-this-load"');
    expect(more).toContain('data-intent="loadMoreHistory"');
  });

  it('pending-only（本轮 0 字段）隐藏“本轮”行但保留累计计数', () => {
    const html = render(baseState({
      table: historyTable({
        loadMoreInfo: {
          summary: '已显示 80 / 共 80 条',
          sessionSummary: '会话已扫描 500 条 revision · 目标历史 80 条',
          thisLoad: { rawFetched: 0, uniqueScanned: 0 },
        },
      }),
    }));
    const more = html.slice(html.indexOf('class="table-load-more"'));
    expect(more).toContain('已显示 80 / 共 80 条');
    expect(more).toContain('会话已扫描 500 条 revision · 目标历史 80 条');
    expect(more).not.toContain(format(strings.historyPanel.scannedThisLoad, { count: '0' }));
    expect(more).not.toContain(format(strings.historyPanel.uniqueRevisionsThisLoad, { count: '0' }));
    expect(more).not.toContain('class="load-more-this-load"');
  });

  it('无匹配（筛选活跃）空态仍显示加载更多与累计计数', () => {
    const html = render(baseState({
      table: historyTable({
        rows: [],
        filters: [{ id: 'keyword', kind: 'text', cellKey: 'message', value: 'zzz' }],
      }),
    }));
    expect(html).toContain('没有匹配当前筛选的历史记录');
    expect(html).toContain('data-intent="loadMoreHistory"');
    expect(html).toContain('已显示 50 / 共 80 条');
  });

  it('P6 宿主用 emptyMode=filterEmpty 显式指定 noMatch（不依赖 TableSpec.filters）', () => {
    const noMatch = render(baseState({
      table: historyTable({ rows: [], emptyMode: 'filterEmpty' }),
    }));
    expect(noMatch).toContain('没有匹配当前筛选的历史记录');
    expect(noMatch).not.toContain('没有历史记录');
    expect(noMatch).toContain('data-intent="loadMoreHistory"');
    const empty = render(baseState({
      table: historyTable({ rows: [], emptyMode: 'empty' }),
    }));
    expect(empty).toContain('没有历史记录');
    expect(empty).not.toContain('没有匹配当前筛选的历史记录');
  });

  it('renderTableRowSlice 只渲染行片段：不含 table/tbody/加载更多/列头', () => {
    const table = historyTable();
    const rows: TableRowSpec[] = Array.from({ length: 40 }, (_, index) => ({
      id: `r${900 - index}`,
      cells: { revision: `r${900 - index}`, author: 'a', date: '2026-11-01', message: 'm', paths: '1' },
      selectionLabel: `勾选 revision r${900 - index}`,
    }));
    const slice = renderTableRowSlice(baseState(), table, rows);
    expect((slice.match(/<tr /g) ?? []).length).toBe(40);
    expect(slice).not.toContain('<table');
    expect(slice).not.toContain('<thead');
    expect(slice).not.toContain('<tbody');
    expect(slice).not.toContain('<th ');
    expect(slice).not.toContain('table-load-more');
    expect(slice).toContain('data-intent="toggleHistoryRevision" data-row-id="r900"');
  });
});

describe('render：P6 详情变更路径与复制窗口', () => {
  function detailState(sections: DetailSectionSpec[]): PanelState {
    return baseState({
      layout: {
        layout: 'master-detail',
        masterLabel: '历史记录',
        detailLabel: '版本详情',
        masterScrollKey: 'history-table',
        detailScrollKey: 'history-detail',
      },
      detail: {
        title: 'r1280 · 修复复制展示',
        subtitle: '林舟 · 2026-11-13 10:00',
        sections,
      },
    });
  }

  it('变更路径列出 action/类型/copyfrom/说明，行内动作只带稳定路径项 ID', () => {
    const html = render(detailState([
      {
        kind: 'paths',
        heading: '变更路径',
        paths: [
          {
            id: 'r1280:0',
            path: 'trunk/src/app.ts',
            action: 'M',
            kind: 'file',
            note: '当前目标',
            actions: [{ id: 'copyHistoryText', label: '复制路径', payload: { 'copy-kind': 'changedPath' } }],
          },
          {
            id: 'r1280:1',
            path: 'trunk/docs/guide.md',
            action: 'A',
            copyfrom: { path: 'branches/base/docs/guide.md', revision: '3', label: '复制自' },
          },
        ],
      },
    ]));
    expect(html).toContain('class="path-action act-M">M</span>');
    expect(html).toContain('class="path-action act-A">A</span>');
    // 表格与详情各自独立滚动：滚动键来自 MasterDetailSpec（宿主稳定命名）。
    expect(html).toContain('data-scroll-key="history-table"');
    expect(html).toContain('data-scroll-key="history-detail"');
    expect(html).toContain('class="path-value mono" title="trunk/src/app.ts">trunk/src/app.ts</span>');
    expect(html).toContain('class="path-kind">file</span>');
    expect(html).toContain('class="path-note muted">当前目标</span>');
    expect(html).toContain('data-path-id="r1280:0"');
    expect(html).toContain(
      'data-intent="copyHistoryText" data-row-id="r1280:0"',
    );
    expect(html).toContain('data-copy-kind="changedPath"');
    // copyfrom 展示为「复制自 来源@rN」，来源路径不做二次拼接。
    expect(html).toContain('class="path-copyfrom"');
    expect(html).toContain('复制自 <span class="mono">branches/base/docs/guide.md</span>');
    expect(html).toContain('<span class="mono">@r3</span>');
  });

  it('超过 collapseAfter 的路径收进“查看全部变更路径”details（视图瞬时折叠）', () => {
    const html = render(detailState([
      {
        kind: 'paths',
        heading: '变更路径',
        collapseAfter: 2,
        moreLabel: '查看全部变更路径（{count}）',
        paths: ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((path, index) => ({
          id: `p${index}`,
          path,
          action: 'M',
        })),
      },
    ]));
    const direct = html.slice(0, html.indexOf('class="detail-paths-more"'));
    expect(direct).toContain('>a.ts<');
    expect(direct).toContain('>b.ts<');
    expect(direct).not.toContain('>c.ts<');
    expect(html).toContain('<details class="detail-paths-more">');
    expect(html).toContain('<summary>查看全部变更路径（2）</summary>');
    const folded = html.slice(html.indexOf('class="detail-paths-more"'));
    expect(folded).toContain('>c.ts<');
    expect(folded).toContain('>d.ts<');
  });

  it('moreLabel 不含 {count} 时在文案后附加条数；无路径时渲染 emptyText', () => {
    const html = render(detailState([
      {
        kind: 'paths',
        collapseAfter: 1,
        moreLabel: '查看全部变更路径',
        paths: [{ id: 'p0', path: 'a.ts' }, { id: 'p1', path: 'b.ts' }, { id: 'p2', path: 'c.ts' }],
      },
    ]));
    expect(html).toContain('<summary>查看全部变更路径（2）</summary>');
    const empty = render(detailState([
      { kind: 'paths', heading: '变更路径', paths: [], emptyText: '该提交没有可直接展示的变更路径。' },
    ]));
    expect(empty).toContain('class="muted">该提交没有可直接展示的变更路径。');
    expect(empty).not.toContain('class="changed-paths"');
  });

  it('复制窗口逐层展示 目标 ← 来源@revision 与边界说明', () => {
    const html = render(detailState([
      {
        kind: 'copyWindow',
        heading: '复制来源',
        items: [
          {
            targetPath: 'trunk/C',
            sourcePath: 'trunk/B',
            sourceRevision: '4',
            boundaryRevision: '5',
            note: '复制点之前的历史停在来源节点',
          },
          { targetPath: 'trunk/B', sourcePath: 'trunk/A', sourceRevision: '2', boundaryRevision: '3' },
        ],
      },
    ]));
    expect(html).toContain('class="copy-window"');
    expect(html).toContain('class="copy-window-path mono" title="trunk/C">trunk/C</span>');
    expect(html).toContain('<span class="copy-window-arrow" aria-hidden="true">←</span>');
    expect(html).toContain('title="trunk/B">trunk/B</span><span class="mono">@r4</span>');
    expect(html).toContain('class="copy-window-meta">r5</span>');
    expect(html).toContain('class="copy-window-meta">复制点之前的历史停在来源节点</span>');
    const empty = render(detailState([
      { kind: 'copyWindow', heading: '复制来源', items: [], emptyText: '没有复制关系。' },
    ]));
    expect(empty).toContain('class="muted">没有复制关系。');
  });

  it('详情层动作在 detail.id 存在时绑定稳定行 ID（复制 revision/说明等）', () => {
    const html = render(baseState({
      layout: { layout: 'master-detail' },
      detail: {
        id: 'r1280',
        title: 'r1280',
        sections: [{
          kind: 'actions',
          actions: [
            { id: 'copyHistoryText', label: '复制 revision', payload: { 'copy-kind': 'revision' } },
            { id: 'compareBase', label: '工作内容与 BASE 比较' },
          ],
        }],
      },
    }));
    expect(html).toContain('data-intent="copyHistoryText" data-row-id="r1280"');
    expect(html).toContain('data-copy-kind="revision"');
    expect(html).toContain('data-intent="compareBase" data-row-id="r1280"');
    // 未提供 detail.id 的既有面板保持 data-detail-action 无参绑定。
    const legacy = render(baseState({
      layout: { layout: 'master-detail' },
      detail: { title: '节点', sections: [{ kind: 'actions', actions: [{ id: 'copyBrowserNodeUrl', label: '复制 URL' }] }] },
    }));
    expect(legacy).toContain('data-intent="copyBrowserNodeUrl" data-detail-action="copyBrowserNodeUrl"');
  });

  it('路径与复制来源中的 HTML 特殊字符全部转义', () => {
    const html = render(detailState([
      {
        kind: 'paths',
        paths: [{
          id: 'p0',
          path: 'trunk/<img src=x onerror=alert(1)>.ts',
          action: 'A',
          copyfrom: { path: 'branches/"x"&y', revision: '2' },
          note: '<script>note</script>',
        }],
      },
      {
        kind: 'copyWindow',
        items: [{ targetPath: '<t>', sourcePath: '"s"&', note: '<b>' }],
      },
    ]));
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>note</script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('trunk/&lt;img src=x onerror=alert(1)&gt;.ts');
    expect(html).toContain('branches/&quot;x&quot;&amp;y');
    expect(html).toContain('&lt;script&gt;note&lt;/script&gt;');
    expect(html).toContain('&lt;t&gt;');
    expect(html).toContain('&quot;s&quot;&amp;');
  });
});

describe('render：P6 筛选面板完整字段（跟随复制/每批数量）', () => {
  function fullFilterState(): PanelState {
    return baseState({
      filterPanel: {
        id: 'historyFilters',
        title: '筛选',
        fields: [
          { id: 'keyword', kind: 'text', label: '关键词', value: '迁移', placeholder: '说明、作者或 rN' },
          {
            id: 'author',
            kind: 'select',
            label: '作者',
            value: 'alice',
            options: [{ value: 'all', label: '全部作者' }, { value: 'alice', label: 'alice' }],
          },
          { id: 'path', kind: 'text', label: '路径', value: 'src/' },
          { id: 'from', kind: 'date', label: '起始日期', value: '2026-01-01' },
          { id: 'to', kind: 'date', label: '截止日期', value: '2026-11-13' },
          {
            id: 'follow',
            kind: 'select',
            label: '历史范围',
            value: 'follow',
            options: [{ value: 'follow', label: '跟随复制历史' }, { value: 'stop', label: '停在复制点' }],
          },
          {
            id: 'pageSize',
            kind: 'select',
            label: '每批数量',
            value: '50',
            options: [{ value: '20', label: '20' }, { value: '50', label: '50' }, { value: '100', label: '100' }],
          },
        ],
        clearAction: { id: 'clearHistoryFilters', label: '清空筛选' },
      },
    });
  }

  it('关键词/作者/路径/起止日期/跟随复制/每批数量全部渲染，选中值回显', () => {
    const html = render(fullFilterState());
    expect(html).toContain('data-filter-field-id="keyword"');
    expect(html).toContain('data-filter-field-id="author"');
    expect(html).toContain('data-filter-field-id="path"');
    expect(html).toContain('data-filter-field-id="from"');
    expect(html).toContain('data-filter-field-id="to"');
    expect(html).toContain('data-filter-field-id="follow"');
    expect(html).toContain('data-filter-field-id="pageSize"');
    expect(html).toContain('<option value="alice" selected>alice</option>');
    expect(html).toContain('<option value="follow" selected>跟随复制历史</option>');
    expect(html).toContain('<option value="50" selected>50</option>');
    expect(html).toMatch(/<input type="text" value="迁移"/);
    expect(html).toMatch(/<input type="date" value="2026-11-13"/);
    expect(html).toContain('data-intent="clearHistoryFilters"');
    // 筛选字段变化只提交 id/value（不携带网络请求或分页参数）。
    expect(html).toContain('data-intent="setHistoryFilter" data-filter-field-id="follow"');
    expect(html).toContain('data-intent="setHistoryFilter" data-filter-field-id="pageSize"');
  });
});

describe('render：P6 状态提示（错误/权限/上限/HEAD）', () => {
  it('错误与权限横幅 role=alert 并带重试/关闭动作（bannerAction 按稳定 ID）', () => {
    const html = render(baseState({
      banners: [
        {
          id: 'historyError',
          level: 'error',
          title: strings.historyPanel.loadFailedTitle,
          detail: format(strings.historyPanel.loadFailedDetail, { message: 'svn: E175013: Access forbidden' }),
          actions: [{ id: 'refresh', label: '重试' }],
        },
        {
          id: 'historyPermission',
          level: 'error',
          title: '权限被拒绝',
          detail: '当前账号没有读取该路径历史的权限。',
          dismissable: false,
        },
      ],
    }));
    expect((html.match(/class="banner error" role="alert"/g) ?? []).length).toBe(2);
    expect(html).toContain('svn: E175013: Access forbidden');
    expect(html).toContain('data-intent="bannerAction" data-banner-id="historyError"');
    expect(html).toContain('data-action-id="refresh"');
    // dismissable:false 的权限横幅不渲染关闭按钮（判定性持久提示）：
    // 该横幅既无 actions 也无 data-banner-id，避免可点被拒的关闭入口。
    expect(html).toContain('当前账号没有读取该路径历史的权限。');
    expect(html).not.toContain('data-banner-id="historyPermission"');
  });

  it('上限横幅同时列出 matched/scanned 两个 reason，并提供清理入口', () => {
    const html = render(baseState({
      banners: [{
        id: 'historyLimit',
        level: 'warn',
        title: '历史会话达到上限',
        detail: format(strings.historyPanel.limitBoth, {
          matchedActual: '5,080',
          matchedLimit: '5,000',
          scannedActual: '100,010',
          scannedLimit: '100,000',
        }),
        dismissable: false,
        actions: [{
          id: 'resetHistorySession',
          label: '清除该目标历史会话并重新读取',
          payload: {},
        }],
      }],
    }));
    expect(html).toContain('class="banner warn"');
    expect(html).toContain('已加载命中 5,080/5,000');
    expect(html).toContain('已扫描 revision 100,010/100,000');
    expect(html).toContain('data-intent="bannerAction" data-banner-id="historyLimit"');
    expect(html).toContain('data-action-id="resetHistorySession"');
    expect(html).toContain('仅影响本次会话加载，不修改工作副本');
  });

  it('HEAD 不可用横幅提供“尝试按 BASE 上限查看”（refreshHistoryUpper mode=base-fallback）', () => {
    const html = render(baseState({
      banners: [{
        id: 'historyHead',
        level: 'warn',
        title: format(strings.historyPanel.headUnavailable, { message: '服务器不可达' }),
        dismissable: false,
        actions: [{
          id: 'refreshHistoryUpper',
          label: strings.historyPanel.tryBaseUpper,
          payload: { mode: 'base-fallback' },
        }],
      }],
    }));
    expect(html).toContain('HEAD 暂不可用：服务器不可达');
    expect(html).toContain('data-intent="bannerAction" data-banner-id="historyHead"');
    expect(html).toContain('data-action-id="refreshHistoryUpper"');
    expect(html).toContain('data-mode="base-fallback"');
    expect(html).toContain(strings.historyPanel.tryBaseUpper);
  });
});

describe('render：P6 窄面板 CSS 契约', () => {
  it('294/400 宽度下历史表格与详情不横向溢出（内部滚动 + 任意换行）', () => {
    const css = readFileSync(join(process.cwd(), 'media/panel.css'), 'utf8');
    // 400px 断点内主从布局上下堆叠；窄屏覆盖必须定义在基础规则之后才生效。
    expect(css).toMatch(/@media \(max-width: 400px\) \{[\s\S]*\.split-layout \{ flex-direction: column; \}/);
    expect(css).toMatch(/@media \(max-width: 400px\) \{[\s\S]*\.path-item \.acts \{ margin-left: 0; \}/);
    const basePathActs = css.indexOf('.path-item .acts { margin-left: auto;');
    const narrowPathActs = css.indexOf('.path-item .acts { margin-left: 0; }');
    expect(basePathActs).toBeGreaterThan(-1);
    expect(narrowPathActs).toBeGreaterThan(basePathActs);
    const baseLoadMore = css.indexOf('.table-load-more { flex: none; display: flex; flex-wrap: wrap;');
    const narrowLoadMore = css.indexOf('.table-load-more { padding: 6px 12px; }');
    expect(narrowLoadMore).toBeGreaterThan(baseLoadMore);
    // 加载更多页脚与计数可换行；计数文本任意换行。
    expect(css).toContain('.table-load-more { flex: none; display: flex; flex-wrap: wrap;');
    expect(css).toContain('.table-load-more-info { display: flex; flex-wrap: wrap;');
    // 变更路径/复制窗口的路径值可收缩换行，详情在 pane-scroll 内滚动。
    expect(css).toContain('.changed-paths { list-style: none; margin: 4px 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }');
    expect(css).toContain('.path-value { min-width: 0; overflow-wrap: anywhere; word-break: break-all; }');
    expect(css).toContain('.copy-window-item { display: flex; flex-wrap: wrap;');
    expect(css).toContain('.copy-window-path { min-width: 0; overflow-wrap: anywhere; word-break: break-all; }');
    // 表格横向滚动只发生在容器内（.table-scroll），页面本身不横向溢出。
    expect(css).toMatch(/\.table-scroll \{[^}]*overflow: auto;/);
    expect(css).toMatch(/\.pane-scroll \{[^}]*overflow: auto;/);
  });
});

describe('render：P7 tabs 与进度状态', () => {
  it('tabs 只表达计数与当前 tab，切换意图带稳定 tab ID', () => {
    const html = render(baseState({
      tabs: {
        id: 'conflicts',
        ariaLabel: '冲突分组',
        current: 'text',
        tabs: [
          { id: 'all', label: '全部', count: 5 },
          { id: 'text', label: '文件', count: 3 },
          { id: 'tree', label: '树', disabled: true, disabledReason: '没有树冲突' },
        ],
      },
    }));
    expect(html).toContain('class="tabs" role="tablist" aria-label="冲突分组"');
    expect(html).toContain('data-intent="setConflictTab" data-tab-id="text"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('class="tab current"');
    expect(html).toContain('<span class="tab-count">3</span>');
    expect(html).toMatch(/data-tab-id="tree"[^>]*disabled/);
  });

  it('确定进度渲染比例宽度；不确定进度保留动画条', () => {
    const determinate = render(baseState({
      progress: { title: '正在扫描冲突', detail: '已完成 3 / 10', ratio: 0.3, actions: [{ id: 'viewTaskLog', label: '查看日志' }] },
    }));
    expect(determinate).toContain('class="task-progress"');
    expect(determinate).toContain('data-determinate="1"');
    expect(determinate).toContain('width:30.0%');
    expect(determinate).toContain('data-intent="viewTaskLog"');
    const indeterminate = render(baseState({ progress: { title: '正在读取历史' } }));
    expect(indeterminate).toContain('<div class="progress" aria-hidden="true"><i></i></div>');
    expect(indeterminate).not.toContain('data-determinate');
  });
});

describe('render：P6 折叠筛选面板（FilterPanelSpec）', () => {
  function filterState(patch: Partial<NonNullable<PanelState['filterPanel']>> = {}): PanelState {
    return baseState({
      filterPanel: {
        id: 'historyFilters',
        title: '筛选',
        fields: [
          { id: 'keyword', kind: 'text', label: '关键词', value: 'fix', placeholder: '说明/作者/revision' },
          { id: 'author', kind: 'select', label: '作者', value: 'all', options: [
            { value: 'all', label: '全部' },
            { value: 'alice', label: 'alice' },
          ] },
          { id: 'since', kind: 'date', label: '起始日期', value: '2026-01-01', error: '起止日期反序' },
        ],
        clearAction: { id: 'clearHistoryFilters', label: '清空筛选' },
        ...patch,
      },
    });
  }

  it('字段渲染 text/date/select 与错误，值变化走 setHistoryFilter', () => {
    const html = render(filterState());
    expect(html).toContain('<details class="filter-panel" data-filter-panel-id="historyFilters" open>');
    expect(html).toContain('<summary>筛选</summary>');
    expect(html).toContain('data-intent="setHistoryFilter" data-filter-field-id="keyword"');
    expect(html).toMatch(/<input type="text" value="fix"/);
    expect(html).toMatch(/<input type="date" value="2026-01-01"/);
    expect(html).toMatch(/<select data-intent="setHistoryFilter" data-filter-field-id="author"/);
    expect(html).toContain('<option value="alice">alice</option>');
    expect(html).toContain('class="field-error">起止日期反序');
    expect(html).toContain('data-intent="clearHistoryFilters"');
  });

  it('collapsed 时不带 open；busy 时字段与清空动作禁用', () => {
    const collapsed = render(filterState({ collapsed: true }));
    expect(collapsed).toContain('<details class="filter-panel" data-filter-panel-id="historyFilters">');
    const busy = render({ ...filterState(), busy: true });
    expect(busy).toMatch(/data-intent="setHistoryFilter"[^>]*disabled/);
    expect(busy).toMatch(/data-intent="clearHistoryFilters"[^>]*disabled/);
  });
});

describe('render：checkbox 表单字段', () => {
  function checkState(field: Partial<FormFieldSpec>, statePatch: Partial<PanelState> = {}): PanelState {
    return baseState({
      form: { id: 'f', busy: false, fields: [{ id: 'directMode', label: '直接检出到所选目录', value: 'false', type: 'checkbox', ...field }] },
      ...statePatch,
    });
  }

  it("checked 由 value 派生：'true' 勾选、其余不勾选", () => {
    const checked = render(checkState({ value: 'true' }));
    expect(checked).toMatch(/<input type="checkbox" data-field-id="directMode"[^>]*checked/);
    const unchecked = render(checkState({ value: 'false' }));
    expect(unchecked).not.toMatch(/<input type="checkbox" data-field-id="directMode"[^>]*checked/);
  });

  it('disabled/error/help 沿用既有字段语义', () => {
    const html = render(checkState({ disabled: true, error: '解析失败，暂不可修改', help: '勾选后目标路径按所选目录计算' }));
    expect(html).toMatch(/<input type="checkbox" data-field-id="directMode"[^>]*disabled/);
    expect(html).toContain('class="field-error"');
    expect(html).toContain('勾选后目标路径按所选目录计算');
  });

  it('占用态无放行视图时禁用（与文本字段同判定）', () => {
    const html = render(checkState({}, { busy: true }));
    expect(html).toMatch(/<input type="checkbox" data-field-id="directMode"[^>]*disabled/);
  });
});
