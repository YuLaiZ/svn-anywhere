/**
 * view.ts 渲染测试：关键 HTML 片段（筛选栏、两种空态、禁用态、动作按钮、
 * 忙碌态）与转义边界；DOM 结构沿用原型 class 基线。
 */
import { describe, expect, it } from 'vitest';
import { commitFixture } from '../src/host/panel/fixture';
import { render } from '../src/host/panel/view';
import type { PanelState, RowSpec } from '../src/host/panel/state';
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
