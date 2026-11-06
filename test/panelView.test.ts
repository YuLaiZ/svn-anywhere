/**
 * view.ts 渲染测试：关键 HTML 片段（筛选栏、两种空态、禁用态、动作按钮、
 * 忙碌态）与转义边界；DOM 结构沿用原型 class 基线。
 */
import { describe, expect, it } from 'vitest';
import { commitFixture } from '../src/host/panel/fixture';
import { render } from '../src/host/panel/view';
import type { FormFieldSpec, PanelState, RowSpec } from '../src/host/panel/state';
import { strings } from '../src/host/i18n';

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
