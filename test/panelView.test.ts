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
  ConflictBatchSpec,
  ConflictListSpec,
  ConfirmDialogSpec,
  FormFieldSpec,
  LazyTreeRowSpec,
  PanelState,
  RowSpec,
  DetailSectionSpec,
  TableRowSpec,
  TableSpec,
} from '../src/host/panel/state';
import { createP6Gates, createP7Gates, allowedActions } from '../src/host/panel/gates';
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
        rowSelectIntent: 'selectHistoryRevision',
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

  it('未声明 rowSelectIntent 的表格（导入预览/大文件表）：行上不注入历史行意图', () => {
    const html = render(historyState({
      id: 'importPreview',
      rowSelectIntent: undefined,
      selection: undefined,
    }));
    expect(html).toContain('<tr data-row-id="r9"');
    expect(html).not.toMatch(/<tr data-row-id="r9"[^>]*data-intent/);
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
      rowSelectIntent: 'selectHistoryRevision',
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

describe('render：P7 冲突列表（ConflictListSpec）', () => {
  function p7State(patch: Partial<PanelState> = {}, listPatch: Partial<ConflictListSpec> = {}): PanelState {
    return baseState({
      layout: {
        layout: 'balanced',
        masterLabel: '冲突列表',
        detailLabel: '冲突详情',
        masterScrollKey: 'conflicts-master',
        detailScrollKey: 'conflicts-detail',
      },
      conflictList: {
        id: 'conflicts',
        ariaLabel: '冲突列表',
        kindLabels: { text: '文件', property: '属性', tree: '树' },
        rows: [
          {
            id: 'fp-text',
            path: 'trunk/src/app.ts',
            kinds: ['text'],
            status: 'unresolved',
            contentKind: 'text',
            auto: { kind: 'applicable', label: '可自动处理' },
            selected: true,
          },
          {
            id: 'fp-bin',
            path: 'trunk/docs/方案.docx',
            kinds: ['text'],
            status: 'unresolved',
            contentKind: 'binary',
            auto: { kind: 'applicable', label: '可自动处理' },
          },
          {
            id: 'fp-prop',
            path: 'trunk/config',
            kinds: ['property'],
            status: 'postponed',
            statusLabel: '已推迟 · 未解决',
            auto: {
              kind: 'unsupported',
              label: '不适用：需检查器处理',
              reason: '保留属性 svn:mergeinfo 需检查器处理',
            },
          },
          {
            id: 'fp-mixed',
            path: 'trunk/mixed.txt',
            kinds: ['text', 'property'],
            status: 'unknown',
            statusLabel: '待核实',
          },
          {
            id: 'fp-tree',
            path: 'trunk/tree-del.txt',
            kinds: ['tree'],
            status: 'resolved',
          },
        ],
        empty: {
          title: '当前没有未解决冲突',
          detail: '可以重新扫描工作副本。',
          action: { id: 'rescanConflicts', label: '重新扫描', payload: { scope: 'whole' } },
        },
        ...listPatch,
      },
      ...patch,
    });
  }

  it('balanced 主从布局两个独立滚动 pane；行只携带稳定 ID 的选中意图', () => {
    const html = render(p7State());
    expect(html).toContain('class="split-layout layout-balanced"');
    expect(html).toContain('data-scroll-key="conflicts-master"');
    expect(html).toContain('data-scroll-key="conflicts-detail"');
    expect(html).toContain('role="list" data-conflict-list-id="conflicts" aria-label="冲突列表"');
    expect(html).toContain('class="conflict-select" data-intent="selectConflict" data-row-id="fp-text"');
    expect(html).toContain('aria-current="true"');
    // 行与动作都不携带路径（路径只在展示文本里）。
    expect(html).not.toMatch(/data-(row-id|intent)="[^"]*trunk\/src\/app\.ts/);
  });

  it('行渲染路径、类型徽标、内容子类型与状态徽标（含未知/已解决/已推迟）', () => {
    const html = render(p7State());
    expect(html).toContain('class="conflict-path mono" title="trunk/src/app.ts">trunk/src/app.ts</span>');
    expect(html).toContain('<span class="conflict-kind kind-text">文件</span>');
    expect(html).toContain('<span class="conflict-kind kind-property">属性</span>');
    expect(html).toContain('<span class="conflict-kind kind-tree">树</span>');
    expect(html).toContain('<span class="conflict-content content-binary">二进制</span>');
    expect(html).toContain('<span class="conflict-status st-unresolved">未解决</span>');
    expect(html).toContain('<span class="conflict-status st-postponed">已推迟 · 未解决</span>');
    expect(html).toContain('<span class="conflict-status st-unknown">待核实</span>');
    expect(html).toContain('<span class="conflict-status st-resolved">已解决</span>');
    // resolved 行保留在列表并带状态类，供撤下动效识别。
    expect(html).toContain('class="conflict-item status-resolved" data-row-id="fp-tree" data-status="resolved"');
  });

  it('可自动策略标记：可自动处理徽标与「不适用：需检查器处理」原因', () => {
    const html = render(p7State());
    expect(html).toContain('class="conflict-auto applicable">可自动处理</span>');
    expect(html).toContain(
      'class="conflict-auto unsupported" title="保留属性 svn:mergeinfo 需检查器处理">不适用：需检查器处理</span>',
    );
  });

  it('同路径混合冲突行同时显示多个类型徽标（文件+属性）', () => {
    const html = render(p7State());
    expect(html).toMatch(
      /data-row-id="fp-mixed"[\s\S]*?class="conflict-kind kind-text">文件<\/span><span class="conflict-kind kind-property">属性<\/span>/,
    );
  });

  it('空态渲染标题/说明/重新扫描动作；row 内动作只带稳定行 ID', () => {
    const empty = render(p7State({}, { rows: [] }));
    expect(empty).toContain('class="conflict-list-block"');
    expect(empty).toContain('当前没有未解决冲突');
    expect(empty).toContain('data-intent="rescanConflicts" data-empty="1" data-scope="whole"');
    const withActions = render(p7State({}, {
      rows: [{
        id: 'fp-text',
        path: 'trunk/src/app.ts',
        kinds: ['text'],
        status: 'unresolved',
        actions: [{ id: 'copyConflictPath', label: '复制路径' }],
      }],
    }));
    expect(withActions).toContain('data-intent="copyConflictPath" data-row-id="fp-text"');
  });
});

describe('render：P7 批量计划与结果（ConflictBatchSpec）', () => {
  function batchState(patch: Partial<ConflictBatchSpec>, statePatch: Partial<PanelState> = {}): PanelState {
    return baseState({
      conflictBatch: {
        id: 'conflict-batch-plan-1',
        heading: '批量处理计划',
        mode: 'plan',
        summary: [
          { label: '工作副本根', value: 'C:\\wc & <repo>', mono: true },
          { label: '范围', value: '整个工作副本', mono: true },
          { label: '策略', value: '使用传入内容（仅文件冲突）' },
        ],
        strategyLabel: '策略',
        strategies: [
          { value: 'theirs-full', label: '使用传入内容（仅文件冲突）', selected: true },
          { value: 'mine-full', label: '保留本地内容（仅文件冲突）', selected: false },
        ],
        groups: [
          {
            id: 'applicable',
            title: '将执行（2）',
            items: [
              { path: 'src/a.ts', note: '整文件策略 使用传入内容（仅文件冲突）' },
              { path: 'bin/b.dat', note: '整文件策略 使用传入内容（仅文件冲突）' },
            ],
          },
          {
            id: 'unsupported',
            title: '不执行（1）',
            items: [{ path: 'config', note: '不适用：属性冲突需要逐项选择' }],
          },
          { id: 'postponed', title: '已推迟（1）', items: [{ path: 'tree-del.txt' }] },
        ],
        actions: [
          { id: 'startConflictBatch', label: '开始批量处理' },
          { id: 'showConflictBatchResults', label: '查看批量结果' },
        ],
        ...patch,
      },
      ...statePatch,
    });
  }

  it('计划页：概要/策略按钮/三组清单与开始动作，路径只作展示文本', () => {
    const html = render(batchState({}));
    expect(html).toContain('data-batch-id="conflict-batch-plan-1" data-batch-mode="plan"');
    expect(html).toContain('批量处理计划');
    // 工作副本根原值转义展示（反斜杠与 HTML 特殊字符）。
    expect(html).toContain('C:\\wc &amp; &lt;repo&gt;');
    expect(html).toContain(
      'data-intent="planConflictBatch" data-strategy="theirs-full" data-focus="batch-strategy-theirs-full" aria-pressed="true"',
    );
    expect(html).toContain(
      'data-intent="planConflictBatch" data-strategy="mine-full" data-focus="batch-strategy-mine-full" aria-pressed="false"',
    );
    expect(html).toContain('将执行（2）');
    expect(html).toContain('class="mono batch-path">src/a.ts</span>');
    expect(html).toContain('不适用：属性冲突需要逐项选择');
    expect(html).toContain('已推迟（1）');
    expect(html).toContain('data-intent="startConflictBatch"');
    expect(html).toContain('data-intent="showConflictBatchResults"');
    // 批量动作与分组项不把路径塞进 data-* 参数。
    expect(html).not.toMatch(/data-(intent|strategy|footer)="[^"]*src\/a\.ts/);
  });

  it('计划页：禁写原因与禁用开始按钮可解释', () => {
    const html = render(batchState({
      blockedReason: '工作副本被锁定：批量处理不能写入，请先执行「清理」。',
      actions: [{
        id: 'startConflictBatch',
        label: '开始批量处理',
        disabled: true,
        disabledReason: '工作副本被锁定：批量处理不能写入，请先执行「清理」。',
      }],
    }));
    expect(html).toContain('class="batch-blocked" role="note"');
    expect(html).toContain('工作副本被锁定');
    expect(html).toMatch(/data-intent="startConflictBatch"[^>]*disabled/);
    expect(html).toMatch(/title="工作副本被锁定[^"]*"/);
  });

  it('结果页：摘要 chips、停止位置、最终回扫说明与逐项状态', () => {
    const html = render(batchState({
      mode: 'results',
      strategies: [],
      groups: [],
      actions: [],
      results: {
        title: '批量处理结果',
        chips: [
          { label: '已解决 2', kind: 'ok' },
          { label: '失败 1', kind: 'error' },
          { label: '未执行 1', kind: 'warn' },
          { label: '仍冲突 1', kind: 'error' },
        ],
        stoppedNote: '在第 3/4 项停止：src/c.ts；原因：冲突状态在读取后发生变化，批量已停止。',
        rescanNote: '最终范围回扫完成：仍冲突 1 项。',
        items: [
          { path: 'src/a.ts', state: 'resolved', stateLabel: '已解决（使用传入内容（仅文件冲突））' },
          { path: 'src/c.ts', state: 'unknown', stateLabel: '待核实', detail: '回扫矛盾' },
          { path: 'src/d.ts', state: 'not-run', stateLabel: '未执行' },
        ],
      },
    }));
    expect(html).toContain('class="batch-chip batch-chip-ok">已解决 2</span>');
    expect(html).toContain('batch-chip-error');
    expect(html).toContain('class="batch-stopped" role="note"');
    expect(html).toContain('在第 3/4 项停止：src/c.ts');
    expect(html).toContain('最终范围回扫完成：仍冲突 1 项。');
    expect(html).toContain('data-batch-item-state="resolved"');
    expect(html).toContain('batch-state batch-state-unknown');
    expect(html).toContain('未执行');
  });

  it('批量区转义动态文案（路径/原因不注入 HTML）', () => {
    const html = render(batchState({
      groups: [{
        id: 'unsupported',
        title: '不执行（1）',
        items: [{ path: '<img src=x onerror=alert(1)>', note: '<script>alert(1)</script>' }],
      }],
    }));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('无批量区时不渲染（既有面板结构不变）', () => {
    const html = render(baseState());
    expect(html).not.toContain('class="conflict-batch"');
  });

  it('占用态策略按钮按 P7 放行表禁用（planConflictBatch 属写集）', () => {
    const html = render(batchState({}, {
      busy: true,
      gate: { busy: ['selectConflict', 'closePanel'], writeLocked: [] },
    }));
    expect(html).toMatch(/data-intent="planConflictBatch"[^>]*disabled/);
    expect(html).toMatch(/data-intent="startConflictBatch"[^>]*disabled/);
  });
});

describe('render：P7 冲突详情（辅助文件/属性三值/树元数据/六种变体）', () => {
  function detailState(sections: DetailSectionSpec[], patch: Partial<PanelState> = {}): PanelState {
    return baseState({
      layout: { layout: 'balanced', masterLabel: '冲突列表', detailLabel: '冲突详情' },
      detail: { id: 'fp-text', title: 'trunk/src/app.ts', subtitle: '文件冲突 · 文本', sections },
      ...patch,
    });
  }

  it('辅助文件段：通用角色 + 工作副本相对路径 + revision；空态与说明', () => {
    const html = render(detailState([{
      kind: 'artifacts',
      heading: 'SVN 冲突辅助文件',
      artifacts: [
        { roleLabel: '冲突基线', path: 'trunk/src/app.ts.r2', revision: '2' },
        { roleLabel: '本地工作内容', path: 'trunk/src/app.ts.mine' },
        { roleLabel: '传入内容', path: 'trunk/src/app.ts.r4', revision: '4' },
      ],
      note: '辅助文件来自当前冲突记录，不按后缀扫描工作副本。',
    }]));
    expect(html).toContain('<h2>SVN 冲突辅助文件</h2>');
    expect(html).toContain('<span class="artifact-role">冲突基线</span>');
    expect(html).toContain('<span class="artifact-path mono" title="trunk/src/app.ts.r2">trunk/src/app.ts.r2</span>');
    expect(html).toContain('<span class="artifact-revision mono">r2</span>');
    expect(html).toContain('<span class="artifact-role">本地工作内容</span>');
    expect(html).toContain('辅助文件来自当前冲突记录，不按后缀扫描工作副本。');
    const empty = render(detailState([{
      kind: 'artifacts',
      heading: 'SVN 冲突辅助文件',
      artifacts: [],
      emptyText: '当前回扫未报告该冲突的辅助文件。',
    }]));
    expect(empty).toContain('当前回扫未报告该冲突的辅助文件。');
  });

  it('属性三值：逐属性对照本地/基线/传入，选中值高亮，选择按钮走宿主 payload', () => {
    const html = render(detailState([{
      kind: 'properties',
      heading: '属性冲突三值',
      properties: [
        {
          name: 'p1',
          local: { text: 'local1' },
          base: { text: 'base1' },
          selected: 'incoming',
          incoming: {
            text: 'incoming1',
            action: { id: 'chooseConflictVariant', label: '选传入', payload: { value: 'theirs-full' } },
          },
        },
        {
          name: 'p2',
          local: { text: 'local2' },
          base: { text: '（不存在）', exists: false },
          incoming: { text: 'incoming2' },
        },
      ],
      note: '命令范围是该路径上的全部冲突属性。',
    }]));
    expect(html).toContain('<span class="property-name mono">p1</span>');
    expect(html).toContain('<span class="property-name mono">p2</span>');
    expect(html).toContain('>本地</strong>');
    expect(html).toContain('>基线</strong>');
    expect(html).toContain('>传入</strong>');
    expect(html).toContain('<code class="mono">local1</code>');
    expect(html).toContain('<code class="mono">base1</code>');
    expect(html).toContain('<code class="mono">incoming1</code>');
    // 不存在的一侧由宿主给文本，视图只附加 absent 弱化样式。
    expect(html).toContain('<div class="property-value absent"><code class="mono">（不存在）</code>');
    // 选中值卡片高亮；选择按钮只带 data-value 载荷（属性名由宿主行 ID 映射）。
    expect(html).toMatch(/property-cell"><strong>传入<\/strong><div class="property-value selected">/);
    expect(html).toContain('data-intent="chooseConflictVariant" data-value="theirs-full"');
    expect(html).toContain('命令范围是该路径上的全部冲突属性。');
  });

  it('保留属性（svn:mergeinfo）标注「不适用：需检查器处理」且不渲染选择按钮', () => {
    const html = render(detailState([{
      kind: 'properties',
      heading: '属性冲突三值',
      properties: [{
        name: 'svn:mergeinfo',
        local: {
          text: '/proj/trunk:16',
          action: { id: 'chooseConflictVariant', label: '选本地', payload: { value: 'mine-full' } },
        },
        base: { text: '/proj/trunk:15' },
        incoming: { text: '/proj/trunk:17' },
        autoUnsupported: true,
        autoUnsupportedNote: '不适用：需检查器处理',
      }],
    }]));
    expect(html).toContain('class="property-unsupported" title="不适用：需检查器处理">不适用：需检查器处理</span>');
    // 保留属性下即使宿主误带选择动作也不渲染（应用层已禁用自动处理）。
    expect(html).not.toContain('data-intent="chooseConflictVariant"');
  });

  it('六种文本变体：三种常用卡 + 高级 SVN 变体折叠三种，选择只带稳定枚举值', () => {
    const html = render(detailState([{
      kind: 'variants',
      heading: '选择处理结果',
      advancedLabel: '高级 SVN 变体',
      options: [
        { value: 'mine-full', label: '保留本地', description: '整文件采用本地工作内容', selected: true },
        { value: 'theirs-full', label: '使用传入内容', description: '整文件采用传入版本' },
        { value: 'working', label: '保留两者 / 人工合并', description: '打开冲突标记编辑器' },
        { value: 'base', label: '恢复冲突基线', advanced: true },
        { value: 'mine-conflict', label: '仅冲突块取本地', advanced: true },
        { value: 'theirs-conflict', label: '仅冲突块取传入', advanced: true },
      ],
    }]));
    expect(html).toContain('<h2>选择处理结果</h2>');
    expect(html).toContain('<details class="advanced"><summary>高级 SVN 变体</summary>');
    // 常用三项在 choice-grid，高级三项在 advanced-grid。
    expect((html.match(/class="choice( selected)?" data-intent="chooseConflictVariant"/g) ?? []).length).toBe(6);
    expect(html).toContain('aria-pressed="true" title="整文件采用本地工作内容"');
    for (const value of ['mine-full', 'theirs-full', 'working', 'base', 'mine-conflict', 'theirs-conflict']) {
      expect(html).toContain(`data-value="${value}"`);
    }
    expect(html).toContain('data-intent="chooseConflictVariant" data-value="mine-full" data-focus="variant-mine-full"');
  });

  it('二进制子类型：只给三个整文件变体，并提供版本打开动作', () => {
    const html = render(detailState([
      {
        kind: 'text',
        heading: '二进制文件冲突',
        paragraphs: ['该冲突是文件冲突的二进制子类型，不做文本差异。'],
      },
      {
        kind: 'variants',
        heading: '选择处理结果',
        options: [
          { value: 'mine-full', label: '保留本地文件' },
          { value: 'theirs-full', label: '使用传入文件' },
          { value: 'working', label: '外部处理后采用当前文件' },
        ],
        note: '二进制文件不提供按冲突块取舍。',
      },
      {
        kind: 'actions',
        actions: [
          { id: 'openConflictVersion', label: '打开本地版本', payload: { role: 'local' } },
          { id: 'openConflictVersion', label: '打开冲突基线', payload: { role: 'base' }, disabled: true, disabledReason: '没有可用基线文件' },
        ],
      },
    ]));
    expect(html).toContain('二进制文件冲突');
    expect((html.match(/class="choice( selected)?" data-intent="chooseConflictVariant"/g) ?? []).length).toBe(3);
    expect(html).toContain('data-intent="openConflictVersion" data-row-id="fp-text" data-role="local"');
    expect(html).toMatch(/data-intent="openConflictVersion"[^>]*data-role="base"[^>]*disabled/);
  });

  it('树版本元数据以键值段渲染（operation/reason/action/victim 与双方 revision）', () => {
    const html = render(detailState([{
      kind: 'kv',
      heading: '树冲突来源',
      entries: [
        { label: '冲突类型', value: '树冲突' },
        { label: '树操作', value: 'update', mono: true },
        { label: '原因', value: 'delete', mono: true },
        { label: '动作', value: 'edit', mono: true },
        { label: 'victim', value: 'trunk/tree-del.txt', mono: true },
        { label: '冲突基线（source-left）', value: 'r2' },
        { label: '传入（source-right）', value: 'r4' },
      ],
    }]));
    expect(html).toContain('<dt>树操作</dt><dd class="mono">update</dd>');
    expect(html).toContain('<dt>原因</dt><dd class="mono">delete</dd>');
    expect(html).toContain('<dt>动作</dt><dd class="mono">edit</dd>');
    expect(html).toContain('<dt>victim</dt><dd class="mono">trunk/tree-del.txt</dd>');
    expect(html).toContain('<dt>冲突基线（source-left）</dt><dd>r2</dd>');
    expect(html).toContain('<dt>传入（source-right）</dt><dd>r4</dd>');
  });

  it('每项动作区：接受版本/标记解决/推迟/只读交互处理入口都只发稳定意图', () => {
    const html = render(detailState([{
      kind: 'actions',
      actions: [
        { id: 'applyConflictResolution', label: '应用并重新扫描' },
        { id: 'postponeConflict', label: '推迟处理' },
        { id: 'openWorkCopyTerminal', label: '打开 SVN 交互处理' },
        { id: 'inspectConflict', label: '检查器' },
      ],
    }]));
    expect(html).toContain('data-intent="applyConflictResolution" data-row-id="fp-text"');
    expect(html).toContain('data-intent="postponeConflict" data-row-id="fp-text"');
    expect(html).toContain('data-intent="openWorkCopyTerminal" data-row-id="fp-text"');
    expect(html).toContain('data-intent="inspectConflict" data-row-id="fp-text"');
    expect(html).not.toContain('trunk/src/app.ts" data-intent');
  });

  it('混合路径：变体全部禁用并显示原因与 warn 说明', () => {
    const html = render(detailState([{
      kind: 'variants',
      heading: '选择处理结果',
      options: [
        {
          value: 'mine-full',
          label: '保留本地',
          disabled: true,
          disabledReason: '混合路径不能直接应用单一路径级策略',
        },
      ],
      warn: '该路径同时存在文本与属性冲突；直接应用会处理整条路径上的全部冲突。',
    }]));
    expect(html).toMatch(/class="choice" data-intent="chooseConflictVariant"[^>]*title="混合路径不能直接应用单一路径级策略"[^>]*disabled/);
    expect(html).toContain('class="choice-warn" role="note">该路径同时存在文本与属性冲突');
  });
});

describe('render：P7 确认对话框与状态（模态/进度/错误态）', () => {
  function dialogState(dialog: ConfirmDialogSpec): PanelState {
    return baseState({
      layout: { layout: 'balanced' },
      confirmDialog: dialog,
    });
  }

  it('树冲突确认对话框：模态语义、分段文案与二次确认按钮', () => {
    const html = render(dialogState({
      id: 'tree-prepare-fp-tree',
      title: '确认树冲突节点已处理',
      detail: '工作副本根：/repo/wc\n冲突路径：trunk/tree-del.txt\n面板没有执行移开、重命名或删除节点。',
      level: 'warn',
      confirm: { id: 'prepareTreeConflict', label: '我已处理，继续' },
      cancelLabel: '取消',
    }));
    expect(html).toContain('class="modal-backdrop" data-confirm-dialog-id="tree-prepare-fp-tree"');
    expect(html).toContain('class="confirm-dialog warn" role="dialog" aria-modal="true"');
    expect(html).toContain('aria-labelledby="confirm-dialog-title-tree-prepare-fp-tree"');
    expect(html).toContain('<h2 id="confirm-dialog-title-tree-prepare-fp-tree">确认树冲突节点已处理</h2>');
    expect(html).toContain('<p>工作副本根：/repo/wc</p>');
    expect(html).toContain('<p>冲突路径：trunk/tree-del.txt</p>');
    expect(html).toContain('面板没有执行移开、重命名或删除节点。');
    // 取消是视图瞬时关闭；确认按钮转发宿主意图（无参数，按当前选中行）。
    expect(html).toContain('data-dialog-dismiss="tree-prepare-fp-tree"');
    expect(html).toContain('data-intent="prepareTreeConflict"');
  });

  it('二次确认使用 preformatted 命令范围原文并可更换确认动作', () => {
    const html = render(dialogState({
      id: 'tree-working-fp-tree',
      title: '确认采用当前工作副本节点状态？',
      detail: '将执行：\n  svn resolve --accept working --depth empty -- "trunk/tree-del.txt"\n随后回扫确认。',
      preformatted: true,
      confirm: { id: 'applyConflictResolution', label: '确认应用 working' },
    }));
    expect(html).toContain('<pre class="confirm-detail">将执行：');
    expect(html).toContain('svn resolve --accept working --depth empty');
    expect(html).toContain('data-intent="applyConflictResolution"');
    // 缺省取消文案来自通用「收起」键，不硬编码。
    expect(html).toContain(strings.panel.dismiss);
    expect(html).not.toContain('class="confirm-dialog warn"');
  });

  it('扫描进度：标题、已扫描 N 项、确定比例与取消入口', () => {
    const html = render(baseState({
      progress: {
        title: '正在扫描工作副本冲突',
        detail: '已扫描 12 / 40 项',
        ratio: 0.3,
        actions: [{ id: 'closePanel', label: '取消' }],
      },
    }));
    expect(html).toContain('class="task-progress"');
    expect(html).toContain('正在扫描工作副本冲突');
    expect(html).toContain('已扫描 12 / 40 项');
    expect(html).toContain('width:30.0%');
    expect(html).toContain('data-intent="closePanel"');
  });

  it('错误态横幅：scanFailed/loadError/resolveError/unknown/busy 均有可重试或关闭动作', () => {
    const html = render(baseState({
      banners: [
        { id: 'scanFailed', level: 'error', title: '冲突扫描失败', detail: 'svn: E000013: Permission denied', actions: [{ id: 'rescanConflicts', label: '重试', payload: { scope: 'whole' } }] },
        { id: 'resolveVerify', level: 'warn', title: '解决结果未知', detail: '请先重新扫描确认，不要直接重试写入。', dismissable: false },
        { id: 'busyHeld', level: 'info', title: '同一工作副本已有冲突任务在运行', dismissable: false },
      ],
      writeLocked: true,
    }));
    expect(html).toContain('class="banner error" role="alert"');
    expect(html).toContain('svn: E000013: Permission denied');
    expect(html).toContain('data-intent="bannerAction" data-banner-id="scanFailed"');
    expect(html).toContain('data-action-id="rescanConflicts"');
    expect(html).toContain('解决结果未知');
    expect(html).toContain('同一工作副本已有冲突任务在运行');
    expect(html).toContain('data-busy="0"');
  });

  it('路径/属性值/对话框文案中的 HTML 特殊字符全部转义', () => {
    const html = render(detailStateForEscape());
    expect(html).toContain('a&lt;b&gt;&amp;&quot;.txt');
    expect(html).toContain('&lt;local&gt;');
    expect(html).toContain('&quot;quoted&quot;');
    expect(html).not.toContain('<local>');

    function detailStateForEscape(): PanelState {
      return baseState({
        layout: { layout: 'balanced' },
        conflictList: {
          id: 'conflicts',
          rows: [{
            id: 'fp<1>',
            path: 'trunk/a<b>&".txt',
            kinds: ['text'],
            status: 'unresolved',
          }],
          empty: { title: '空' },
        },
        detail: {
          id: 'fp<1>',
          title: 'trunk/a<b>&".txt',
          sections: [{
            kind: 'properties',
            heading: '属性',
            properties: [{
              name: 'p1',
              local: { text: '<local>' },
              base: { text: '"quoted"' },
              incoming: { text: 'x' },
            }],
          }],
        },
        confirmDialog: {
          id: 'dlg<1>',
          title: '<title>',
          detail: '<detail>',
          confirm: { id: 'prepareTreeConflict', label: '确认' },
        },
      });
    }
  });
});

describe('render：P7 窄面板 CSS 契约（294/400）', () => {
  it('变体卡/属性三值单列、冲突行可换行、模态收窄且页面不横向溢出', () => {
    const css = readFileSync(join(process.cwd(), 'media/panel.css'), 'utf8');
    // 基础规则存在。
    expect(css).toContain('.conflict-list {');
    expect(css).toContain('.conflict-path {');
    expect(css).toMatch(/\.conflict-path \{[^}]*overflow-wrap: anywhere;/);
    // 独立使用时列表自身滚动；主从 pane 内交给 pane-scroll（不保留第二套滚动）。
    expect(css).toContain('.pane-scroll > .conflict-list { flex: none; min-height: auto; overflow: visible; }');
    expect(css).toContain('.property-grid {');
    expect(css).toMatch(/\.property-value code \{[^}]*overflow-wrap: anywhere;/);
    expect(css).toContain('.property-value.absent code { color: var(--vscode-descriptionForeground); }');
    expect(css).toContain('.choice-grid {');
    expect(css).toContain('.modal-backdrop[hidden] { display: none; }');
    // 批量计划/结果区：卡片、分组路径与窄面板单列断言（阶段 7）。
    expect(css).toContain('.conflict-batch {');
    expect(css).toMatch(/\.batch-path \{[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/@media \(max-width: 400px\) \{[\s\S]*?\.conflict-batch \{/);
    // resolved 撤下动效：行状态更新播放一次高亮淡出。
    expect(css).toContain('.conflict-item.just-resolved {');
    expect(css).toContain('@keyframes conflict-resolved');
    // 窄屏覆盖必须位于基础规则之后才生效（同 P6 契约）。
    const baseChoice = css.indexOf('.choice-grid {');
    const narrowChoice = css.indexOf('.choice-grid,\n  .property-grid { grid-template-columns: 1fr; }');
    expect(narrowChoice).toBeGreaterThan(baseChoice);
    expect(css).toMatch(/@media \(max-width: 400px\) \{[\s\S]*\.choice-grid,\s*\.property-grid \{ grid-template-columns: 1fr; \}/);
    const baseConflictActs = css.indexOf('.conflict-item .acts { margin-left: auto;');
    const narrowConflictActs = css.indexOf('.conflict-item .acts { margin-left: 0; }');
    expect(narrowConflictActs).toBeGreaterThan(baseConflictActs);
    expect(css).toContain('.confirm-dialog { width: 100%; padding: 12px; }');
  });
});

// ---------------------------------------------------------------------------
// 占用态页脚/横幅/确认框禁用与放行表同源
// ---------------------------------------------------------------------------

describe('render：占用态页脚/横幅/确认框按放行表同源禁用', () => {
  /** 取 data-intent（可选 data-action-id）对应的按钮开标签。 */
  function buttonTag(html: string, intent: string, actionId?: string): string {
    const extra = actionId === undefined ? '' : `[^>]*data-action-id="${actionId}"`;
    const match = new RegExp(`<button[^>]*data-intent="${intent}"${extra}[^>]*>`).exec(html);
    expect(match, `button ${intent}${actionId === undefined ? '' : `/${actionId}`}`).not.toBeNull();
    return match![0];
  }

  /** 携带放行视图的渲染状态：gate 由同一张表求值（与宿主 renderStateOf 同源）。 */
  function gatedState(patch: Partial<PanelState>): PanelState {
    return baseState(patch);
  }

  it('P6 busy：页脚 loadMore/refresh/reset 禁用，横幅日志/关闭放行，× 禁用（与 P6 表同源）', () => {
    const gates = createP6Gates();
    const state = gatedState({
      busy: true,
      gate: { busy: allowedActions(gates.busy), writeLocked: allowedActions(gates.writeLocked) },
      footer: {
        summary: '目标历史 3 条',
        primary: { id: 'loadMoreHistory', label: '加载更多' },
        secondary: [
          { id: 'refreshHistoryUpper', label: '刷新 HEAD' },
          { id: 'resetHistorySession', label: '重置会话' },
        ],
      },
      banners: [{
        id: 'historyUpdate',
        level: 'info',
        title: '正在更新',
        actions: [
          { id: 'viewTaskLog', label: '查看日志' },
          { id: 'closePanel', label: '关闭面板' },
        ],
        dismissable: true,
      }],
    });
    const html = render(state);
    // P6 busy 行不含写意图（loadMore/refresh/reset 均属等待集）。
    expect(buttonTag(html, 'loadMoreHistory')).toContain(' disabled');
    expect(buttonTag(html, 'refreshHistoryUpper')).toContain(' disabled');
    expect(buttonTag(html, 'resetHistorySession')).toContain(' disabled');
    // 放行集内的横幅动作：与宿主守卫同表，DOM 可点。
    expect(buttonTag(html, 'bannerAction', 'viewTaskLog')).not.toContain(' disabled');
    expect(buttonTag(html, 'bannerAction', 'closePanel')).not.toContain(' disabled');
    // dismissBanner 不在 P6 放行集：× 同源禁用，不出现可点被拒。
    expect(buttonTag(html, 'dismissBanner')).toContain(' disabled');
  });

  it('P7 writeLocked：写/批量与确认框禁用，回扫与日志放行，× 禁用（与 P7 表同源）', () => {
    const gates = createP7Gates();
    const state = gatedState({
      writeLocked: true,
      gate: { busy: allowedActions(gates.busy), writeLocked: allowedActions(gates.writeLocked) },
      footer: {
        summary: '冲突 2 项',
        primary: { id: 'planConflictBatch', label: '批量处理' },
        secondary: [
          { id: 'rescanConflicts', label: '重新扫描' },
          { id: 'startConflictBatch', label: '开始批量' },
        ],
      },
      banners: [{
        id: 'conflictExternalBoundary',
        level: 'warn',
        title: '外部副本成员不进入本副本冲突列表',
        actions: [{ id: 'viewTaskLog', label: '查看日志' }],
        dismissable: true,
      }],
      confirmDialog: {
        id: 'dialog-1',
        title: '确认应用？',
        confirm: { id: 'applyConflictResolution', label: '应用所选处理结果' },
      },
    });
    const html = render(state);
    // writeLocked 行只放行回扫与只读查看，写/批量必须等待。
    expect(buttonTag(html, 'planConflictBatch')).toContain(' disabled');
    expect(buttonTag(html, 'startConflictBatch')).toContain(' disabled');
    expect(buttonTag(html, 'rescanConflicts')).not.toContain(' disabled');
    expect(buttonTag(html, 'bannerAction', 'viewTaskLog')).not.toContain(' disabled');
    expect(buttonTag(html, 'dismissBanner')).toContain(' disabled');
    // 确认框确认按钮与守卫同源：占用态不可点。
    expect(buttonTag(html, 'applyConflictResolution')).toContain(' disabled');
    // 对话框内的取消是纯 Webview 瞬时关闭（不发意图），不受放行表约束。
    expect(html).toContain('data-dialog-dismiss="dialog-1"');
  });

  it('未携带放行视图的面板（M2）保持既有渲染：页脚/横幅动作不额外禁用', () => {
    const state = baseState({
      busy: true,
      footer: {
        summary: '待核实',
        primary: { id: 'commit', label: '提交' },
        secondary: [{ id: 'resolveUnknown', label: '核实' }],
      },
      banners: [{
        id: 'notice',
        level: 'info',
        title: '提示',
        actions: [{ id: 'viewTaskLog', label: '查看日志' }],
        dismissable: true,
      }],
    });
    const html = render(state);
    // 未携带 gate：视图不猜测放行集，保持 M2 现状（守卫仍会拒绝）。
    expect(buttonTag(html, 'commit')).not.toContain(' disabled');
    expect(buttonTag(html, 'resolveUnknown')).not.toContain(' disabled');
    expect(buttonTag(html, 'bannerAction', 'viewTaskLog')).not.toContain(' disabled');
    expect(buttonTag(html, 'dismissBanner')).not.toContain(' disabled');
  });
});
