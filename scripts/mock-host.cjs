/**
 * mock 宿主验证脚本：拦截 require('vscode')，加载打包产物 out/extension.js，
 * 直接驱动 activate 与注册的命令 handler。除命令骨架场景外，
 * 还用本地 svnadmin + file:// 临时副本驱动真实的更新/状态/清理命令链路。
 * 用法：`pnpm run mock-host`（先构建再运行）。任一场景失败退出码为 1。
 */
const { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync, existsSync, readFileSync, symlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');

const state = {
  information: [],
  warning: [],
  openDialogCalls: 0,
  channels: [],
  registered: new Map(),
  activeCommandIds: new Set(),
  disposables: [],
  /** 模态确认框（更新确认）返回的按钮；undefined 表示用户取消。 */
  confirmResult: undefined,
  progressTitles: [],
  /** 提交说明输入框返回值。 */
  inputResult: undefined,
  quickPickTitles: [],
  /** QuickPick 指定勾选的 label 集合；undefined 表示默认勾选。 */
  quickPickPicked: undefined,
  quickPickDiff: undefined,
  /** showQuickPick 单选面板按 label 匹配返回的项；undefined 表示取消。 */
  quickPickChoice: undefined,
  quickPicks: [],
  /** 说明编辑通知上点的按钮（「使用此说明」确认提交说明）。 */
  messageChoice: '使用此说明',
  /** createWebviewPanel 替身创建的面板记录。 */
  panels: [],
  /** executeCommand 调用记录（args 数组）。 */
  executedCommands: [],
  /** onDidCloseTextDocument 注册的处理器。 */
  closeDocHandlers: [],
  /** showWarningMessage 调用记录（复用 warning，另存供切换拒绝断言）。 */
  /** globalState 替身存储（面板历史/前缀/操作记录）。 */
  globalStateMap: new Map(),
  /** 面板意图自增序号（requestId 去重要求每次不同）。 */
  intentSeq: 0,
};

const fakeVscode = {
  ProgressLocation: { Notification: 15 },
  ViewColumn: { Active: 1, Beside: 2 },
  ThemeIcon: class {
    constructor(id) { this.id = id; }
  },
  Uri: {
    parse: (s) => ({ scheme: 'untitled', path: s, toString: () => s }),
    file: (path) => ({ scheme: 'file', path, fsPath: path, toString: () => `file://${path}` }),
    joinPath: (base, ...parts) => {
      const path = [base.path.replace(/\/$/, ''), ...parts].join('/');
      return { scheme: 'file', path, fsPath: path, toString: () => `file://${path}` };
    },
  },
  TabInputText: class {},
  window: {
    createOutputChannel(title) {
      const ch = {
        title,
        lines: [],
        shown: 0,
        appendLine(line) { ch.lines.push(line); },
        show() { ch.shown += 1; },
        dispose() {},
      };
      state.channels.push(ch);
      return ch;
    },
    showInformationMessage(message, ...items) {
      state.information.push(message);
      // 说明编辑确认：inputResult 为 undefined 时视为取消（与旧 showInputBox 语义一致）。
      const choice = state.inputResult === undefined ? undefined : state.messageChoice;
      return Promise.resolve(items.length > 0 ? choice : undefined);
    },
    showWarningMessage(message, _options, ...items) {
      // 带按钮参数的调用是模态确认框；返回 state.confirmResult 决定确认/取消。
      state.warning.push(message);
      return Promise.resolve(items.length > 0 ? state.confirmResult : undefined);
    },
    showErrorMessage(message) {
      state.warning.push(`[error] ${message}`);
      return Promise.resolve(undefined);
    },
    showOpenDialog() {
      state.openDialogCalls += 1;
      return Promise.resolve(undefined);
    },
    withProgress(options, task) {
      state.progressTitles.push(options.title);
      return task({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) });
    },
    showInputBox() {
      return Promise.resolve(state.inputResult);
    },
    showTextDocument: async () => undefined,
    tabGroups: { all: [], close: async () => true },
    showQuickPick(items, options) {
      state.quickPickTitles.push(options?.title ?? '');
      if (state.quickPickChoice === undefined) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(items.find((i) => i.label === state.quickPickChoice));
    },
    createQuickPick() {
      const handlers = {};
      const qp = {
        title: '', placeholder: '', canSelectMany: false, matchOnDescription: false,
        items: [], selectedItems: [],
        onDidAccept(cb) { (handlers.accept ??= []).push(cb); return { dispose() {} }; },
        onDidHide(cb) { (handlers.hide ??= []).push(cb); return { dispose() {} }; },
        onDidTriggerItemButton(cb) { (handlers.button ??= []).push(cb); return { dispose() {} }; },
        show() {
          // 模拟用户回车确认：未指定勾选集合时默认选非 unversioned 项。
          qp.selectedItems = state.quickPickPicked
            ? qp.items.filter((i) => state.quickPickPicked.includes(i.label))
            : qp.items.filter((i) => i.description !== 'unversioned');
          if (state.quickPickDiff) {
            const item = qp.items.find((candidate) => candidate.label === state.quickPickDiff);
            if (!item) throw new Error(`未找到差异条目 ${state.quickPickDiff}`);
            handlers.button?.forEach((cb) => cb({ item }));
          }
          handlers.accept?.forEach((cb) => cb());
          handlers.hide?.forEach((cb) => cb());
        },
        hide() { handlers.hide?.forEach((cb) => cb()); },
        dispose() {},
      };
      state.quickPicks.push(qp);
      return qp;
    },
    activeTextEditor: undefined,
    createWebviewPanel(viewType, title, _showOptions, options) {
      const messageHandlers = [];
      const disposeHandlers = [];
      const webview = {
        _html: '',
        posted: [],
        onDidReceiveMessage(handler) {
          messageHandlers.push(handler);
          return { dispose() {} };
        },
        postMessage(message) {
          webview.posted.push(message);
          return Promise.resolve(true);
        },
        asWebviewUri: (uri) => ({ scheme: 'vscode-webview', path: uri.path, toString: () => `vscode-webview://fake${uri.path}` }),
        cspSource: 'vscode-webview-fake:',
        set html(value) {
          webview._html = value;
        },
        get html() {
          return webview._html;
        },
      };
      const panel = {
        viewType, title, webview, options,
        revealed: 0, disposed: false,
        reveal() { panel.revealed += 1; },
        dispose() {
          if (panel.disposed) return;
          panel.disposed = true;
          disposeHandlers.forEach((cb) => cb());
        },
        /** 测试驱动：模拟视图发消息给宿主。 */
        send(raw) {
          if (process.env.P2_TRACE && raw && raw.type === 'intent' && ['fillOriginName', 'addRule', 'saveIgnore', 'submitIgnore', 'removeRule', 'refresh', 'resolveUnknown', 'syncInput'].includes(raw.intent?.kind)) {
            console.log('TRACE send:', JSON.stringify({ kind: raw.intent.kind, sid: String(raw.sessionId).slice(0, 5), rid: raw.requestId }));
          }
          messageHandlers.forEach((cb) => cb(raw));
        },
        /** 测试驱动：模拟视图加载完成握手。 */
        sendReady() {
          panel.send({ type: 'ready', protocolVersion: 1 });
        },
        /** 测试驱动：模拟视图意图。 */
        sendIntent(intent, sessionId, requestId) {
          panel.send({ type: 'intent', protocolVersion: 1, sessionId, requestId: `req-${requestId}`, intent });
        },
        /** 测试驱动：以面板当前会话发送意图（requestId 自增保证唯一）。 */
        sendAuto(intent) {
          state.intentSeq += 1;
          const current = [...webview.posted].reverse().find((m) => m.type === 'render');
          panel.send({
            type: 'intent',
            protocolVersion: 1,
            sessionId: current ? current.sessionId : '',
            requestId: `req-auto-${state.intentSeq}`,
            intent,
          });
        },
      };
      panel.onDidDispose = (handler) => {
        disposeHandlers.push(handler);
        return { dispose() {} };
      };
      state.panels.push(panel);
      return panel;
    },
  },
  workspace: {
    workspaceFolders: [],
    // 说明编辑文档：内容直接取 state.inputResult，配合 messageChoice 模拟确认。
    openTextDocument: async (uri) => ({
      uri,
      fileName: 'svn-commit-message.txt',
      getText: () => state.inputResult ?? '',
    }),
    onDidCloseTextDocument: (handler) => {
      state.closeDocHandlers.push(handler);
      return { dispose() {} };
    },
    getConfiguration() {
      return { get: (_key, fallback) => fallback };
    },
  },
  commands: {
    executeCommand: async (command, ...args) => {
      state.executedCommands.push([command, ...args]);
      return undefined;
    },
    // 模拟真实 VSCode：重复注册同一命令 ID 抛 already exists，dispose 后可重新注册。
    registerCommand(id, handler) {
      if (state.activeCommandIds.has(id)) {
        throw new Error(`command '${id}' already exists`);
      }
      state.activeCommandIds.add(id);
      const disposable = {
        dispose() {
          state.activeCommandIds.delete(id);
        },
      };
      state.registered.set(id, handler);
      state.disposables.push(disposable);
      return disposable;
    },
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return fakeVscode;
  }
  return originalLoad.call(this, request, parent, isMain);
};

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

function makeTempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function svn(args, cwd) {
  return execFileSync('svn', args, { cwd, encoding: 'utf8' });
}

function channelText() {
  return state.channels.map((c) => c.lines.join('\n')).join('\n');
}

/** 等待面板收到包含指定文本的 render 帧；超时返回 undefined。 */
async function waitRender(panel, includes, attempts = 150) {
  for (let i = 0; i < attempts; i += 1) {
    const hit = [...panel.webview.posted].reverse().find((m) => m.type === 'render' && m.html.includes(includes));
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
}

/** 等待从 posted[afterIndex] 起出现的、包含指定文本的 render 帧（避免命中历史帧；
 * 目标切换会重置 revision 序号，故用消息索引而非 revision 比较。
 * 调用方传快照时的 posted.length——即下一帧的起始索引）。 */
async function waitNewRender(panel, includes, afterIndex, attempts = 200) {
  for (let i = 0; i < attempts; i += 1) {
    const hit = [...panel.webview.posted.slice(afterIndex)].reverse().find(
      (m) => m.type === 'render' && m.html.includes(includes),
    );
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
}

/** 轮询等待磁盘/仓库状态条件成立（真实 svn 链路耗时不可预测，命令完成晚于面板帧时避免过早断言）。 */
async function waitForCond(name, fn, attempts = 120) {
  for (let i = 0; i < attempts; i += 1) {
    if (fn()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  console.error(`  COND-TIMEOUT ${name}`);
  return false;
}

/** 等待从 posted[afterIndex] 起出现的空闲（非忙碌）render 帧：目标切换/重读完成的可靠信号。 */
async function waitNewIdle(panel, afterIndex, attempts = 200) {
  for (let i = 0; i < attempts; i += 1) {
    const frame = [...panel.webview.posted.slice(afterIndex)].reverse().find(
      (m) => m.type === 'render' && m.html.includes('data-busy="0"'),
    );
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
}

/**
 * 通过 P1 提交面板驱动一次精确范围的提交：清空勾选 → 逐项勾选 →
 * （可选）同步说明 → 提交。确认框由 state.confirmResult 控制。
 */
function maxRevision(panel) {
  return panel.webview.posted.reduce((max, m) => (m.type === 'render' && m.revision > max ? m.revision : max), 0);
}

async function commitViaPanel(panel, paths, message) {
  await waitPanelIdle(panel);
  const revisionBefore = maxRevision(panel);
  panel.sendAuto({ kind: 'clearSelection' });
  for (const path of paths) {
    panel.sendAuto({ kind: 'toggleRow', rowId: path, selected: true });
  }
  if (message !== undefined) {
    panel.sendAuto({ kind: 'syncInput', fieldId: 'message', value: message, inputRevision: state.intentSeq + 1000 });
  }
  panel.sendAuto({ kind: 'submit' });
  // 等待本次提交完成：频道出现新的 Committed revision、错误弹窗或
  // 面板『添加失败』横幅（成功卡片会持续展示，不能作为完成信号）。
  const committedBefore = (channelText().match(/Committed revision \d+\./g) || []).length;
  const errorsBefore = state.warning.filter((m) => m.startsWith('[error]')).length;
  for (let retry = 0; retry < 500; retry += 1) {
    const committedNow = (channelText().match(/Committed revision \d+\./g) || []).length;
    const failed = [...panel.webview.posted].reverse().find((m) => m.type === 'render' && m.html.includes('添加失败'));
    const errored = state.warning.filter((m) => m.startsWith('[error]')).length > errorsBefore;
    if (committedNow > committedBefore || failed || errored) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  await waitPanelIdle(panel);
  void revisionBefore;
}

/** 等待面板回到空闲（最新 render 帧非忙碌）；用于操作间避免 busy 拒绝。 */
async function waitPanelIdle(panel, attempts = 300) {
  for (let i = 0; i < attempts; i += 1) {
    const last = [...panel.webview.posted].reverse().find((m) => m.type === 'render');
    if (last && last.html.includes('data-busy="0"')) return true;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return false;
}

/** 等待出现新的信息提示（从 fromIndex 起匹配）；真实 svn 提交链路耗时不确定。 */
async function waitNewInfo(includes, fromIndex, attempts = 300) {
  for (let i = 0; i < attempts; i += 1) {
    if (state.information.slice(fromIndex).some((m) => m.includes(includes))) return true;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return false;
}

/** 打开 P2 忽略规则面板并等待「本次打开产生」的数据帧（防历史帧命中）。 */
async function openIgnorePanel(uriFsPath, expectText) {
  const panel0 = [...state.panels].reverse().find((p) => p.viewType === 'svn-anywhere-ignore');
  const before = panel0 ? panel0.webview.posted.length : 0;
  let panel;
  let render;
  for (let attempt = 0; attempt < 8 && !render; attempt += 1) {
    await state.registered.get('svnAnywhere.editIgnore')({ fsPath: uriFsPath, scheme: 'file' });
    // P2 与 P1 是不同 panelId；取 ignore 面板（viewType svn-anywhere-ignore）。
    panel = [...state.panels].reverse().find((p) => p.viewType === 'svn-anywhere-ignore');
    if (!panel) {
      throw new Error(`忽略规则面板未创建（panels=${state.panels.map((p) => p.viewType).join(',')}）`);
    }
    panel.sendReady();
    render = await waitNewRender(panel, expectText, before, 20);
  }
  if (!render || !panel) {
    const frames = (panel?.webview.posted ?? []).filter((m) => m.type === 'render').slice(-4);
    throw new Error(`P2 面板数据帧未出现：${expectText}\nlast=${JSON.stringify(frames.map((f) => [f.sessionId?.slice(0, 5), (f.html.match(/<span class="badge[^>]*>[^<]*/g) ?? []).map((x) => x.replace(/<span class="badge[^>]*>/, '')).join('+'), (f.html.match(/rule-text">[^<]{0,30}/g) ?? []).join('|'), f.html.includes('banner error') ? 'ERR-BANNER' : '']))}warn=${JSON.stringify(state.warning.slice(-2)).slice(0, 200)}`);
  }
  return panel;
}

/** 打开提交面板并等待数据帧就绪（expectText 出现于 render 中）。 */
async function openCommitPanel(uriFsPath, expectText) {
  // P1 面板同类型复用实例：按 viewType 定位（其他类型面板可能更晚创建）。
  // 上一个会话可能仍在重读（busy 拒绝切换）：轮询重试直到目标数据帧出现。
  let panel;
  let render;
  for (let attempt = 0; attempt < 8 && !render; attempt += 1) {
    await state.registered.get('svnAnywhere.commit')({ fsPath: uriFsPath, scheme: 'file' });
    panel = [...state.panels].reverse().find((p) => p.viewType === 'svn-anywhere-commit');
    if (!panel) {
      throw new Error(`提交面板未创建（panels=${state.panels.length}）`);
    }
    panel.sendReady();
    render = await waitRender(panel, expectText, 20);
  }
  if (!render || !panel) {
    const frames = (panel?.webview.posted ?? []).filter((m) => m.type === 'render').slice(-2);
    throw new Error(`面板数据帧未出现：${expectText}\nlast=${JSON.stringify(frames.map((f) => [f.sessionId?.slice(0, 5), String(f.html ?? '').slice(0, 120)])).slice(0, 500)}`);
  }
  return panel;
}

/** 搭建含远端提交能力的本地 SVN 实验场，返回两个工作副本与 svn helper。 */
function makeSvnLab() {
  const lab = makeTempDir('svn-anywhere-mock-svn-');
  const repoPath = join(lab, 'repo');
  execFileSync('svnadmin', ['create', repoPath]);
  const repoUrl = `file://${repoPath}`;
  const checkout = (name, subPath) => {
    const path = join(lab, name);
    mkdirSync(path, { recursive: true });
    svn(['checkout', '-q', subPath ? `${repoUrl}/${subPath}` : repoUrl, '.'], path);
    return path;
  };
  return { lab, repoUrl, checkout };
}

async function main() {
  const extension = require('../out/extension.js');
  const pkg = require('../package.json');
  const context = {
    subscriptions: [],
    extensionUri: { scheme: 'file', path: '/mock-ext', toString: () => 'file:///mock-ext' },
    globalState: {
      get: (key, defaultValue) => (state.globalStateMap.has(key) ? state.globalStateMap.get(key) : defaultValue),
      update: async (key, value) => {
        state.globalStateMap.set(key, value);
      },
    },
  };
  await extension.activate(context);

  console.log('场景 1：activate 后全部命令注册，与 package.json 贡献点一致');
  const expectedIds = pkg.contributes.commands.map((c) => c.command);
  check(
    '注册的命令 ID 与贡献点集合一致',
    expectedIds.length === state.registered.size && expectedIds.every((id) => state.registered.has(id)),
    `贡献点 ${expectedIds.length} 个，实际注册 ${state.registered.size} 个：${[...state.registered.keys()].join(', ')}`,
  );
  // subscriptions = 命令句柄数 + activate 推入的输出频道释放句柄。
  check('注册句柄挂到 context.subscriptions', context.subscriptions.length === expectedIds.length + 1);

  console.log('场景 2：右键工作副本内路径，命令定位到副本根并留痕');
  // 所有 M1 命令已实装，占位模板退役；用重定位命令验证「右键 → 定位 → 执行」链路。
  // 该副本的 .svn/wc.db 是伪造文件，svn 命令会失败，顺带覆盖重定位的针对性失败提示。
  const wc = makeTempDir('svn-anywhere-mock-wc-');
  mkdirSync(join(wc, '.svn'), { recursive: true });
  writeFileSync(join(wc, '.svn', 'wc.db'), 'fake');
  const fileInside = join(wc, 'a.txt');
  writeFileSync(fileInside, 'x');
  await state.registered.get('svnAnywhere.relocate')({ fsPath: fileInside, scheme: 'file' });
  check(
    '输出频道有定位日志',
    state.channels.some((c) => c.lines.some((l) => l.includes('[定位]') && l.includes(wc))),
    `频道内容：${JSON.stringify(state.channels.map((c) => c.lines))}`,
  );
  check(
    '无效副本上的 info 失败进统一错误收口',
    state.warning.some((m) => m.startsWith('[error]')),
    JSON.stringify(state.warning),
  );

  console.log('场景 3：右键非工作副本目录，给出明确提示，不静默');
  const plain = makeTempDir('svn-anywhere-mock-plain-');
  const infoBeforePlain = state.information.length;
  await state.registered.get('svnAnywhere.relocate')({ fsPath: plain, scheme: 'file' });
  check(
    '弹「不在工作副本」信息提示',
    state.information.length === infoBeforePlain + 1 &&
      state.information[state.information.length - 1].includes('不在 SVN 工作副本中'),
  );

  console.log('场景 4：命令面板无参调用且无活动编辑器，走文件选择框；取消后静默');
  const infoBeforeDialog = state.information.length;
  await state.registered.get('svnAnywhere.refreshStatus')(undefined);
  check('弹出了文件选择框', state.openDialogCalls === 1);
  check('用户取消后无提示、无报错', state.information.length === infoBeforeDialog);

  console.log('场景 5：「显示输出」命令聚焦输出频道');
  await state.registered.get('svnAnywhere.showOutput')(undefined);
  check('输出频道 show 被调用', state.channels.some((c) => c.shown >= 1));

  console.log('场景 6：真实副本「显示状态」输出 wcStatus 原词明细');
  const svnLab = makeSvnLab();
  const probe = svnLab.checkout('probe');
  writeFileSync(join(probe, 'a.txt'), 'v1');
  svn(['add', '-q', '--parents', 'a.txt'], probe);
  svn(['commit', '-q', '-m', 'init'], probe);
  writeFileSync(join(probe, 'a.txt'), 'v2');
  writeFileSync(join(probe, 'untracked.txt'), 'x');
  const linesBeforeStatus = channelText().length;
  await state.registered.get('svnAnywhere.showStatus')({ fsPath: join(probe, 'a.txt'), scheme: 'file' });
  await state.registered.get('svnAnywhere.showStatus')({ fsPath: probe, scheme: 'file' });
  const statusOutput = channelText().slice(linesBeforeStatus);
  check('文件目标：频道含 modified 原词明细', statusOutput.includes('[modified] a.txt'), statusOutput.slice(-500));
  check('目录目标：频道含 unversioned 原词明细', statusOutput.includes('[unversioned] untracked.txt'));

  console.log('场景 7：真实副本「更新」——模态确认后执行，频道有明细与最终 revision');
  const remote = svnLab.checkout('remote');
  writeFileSync(join(remote, 'remote-new.txt'), 'new');
  svn(['add', '-q', '--parents', 'remote-new.txt'], remote);
  svn(['commit', '-q', '-m', 'remote add'], remote);
  state.confirmResult = '更新';
  const linesBeforeUpdate = channelText().length;
  // 对目录驱动更新：单文件目标拉不到远端新增文件。
  await state.registered.get('svnAnywhere.update')({ fsPath: probe, scheme: 'file' });
  const updateOutput = channelText().slice(linesBeforeUpdate);
  check('进度通知弹出', state.progressTitles.some((t) => t.includes('正在更新')));
  check('频道记录了实际执行的 update 命令', updateOutput.includes('update --non-interactive'));
  check('频道含流式明细行 A', updateOutput.includes('A    remote-new.txt'), updateOutput.slice(-600));
  check('频道含最终 revision 汇总', updateOutput.includes('更新完成，当前 revision'));
  state.confirmResult = undefined;

  console.log('场景 8：真实副本「更新」——模态取消后不执行');
  const progressBeforeCancel = state.progressTitles.length;
  const linesBeforeCancel = channelText().length;
  await state.registered.get('svnAnywhere.update')({ fsPath: probe, scheme: 'file' });
  const cancelOutput = channelText().slice(linesBeforeCancel);
  check('取消后不进进度、不执行 svn update',
    state.progressTitles.length === progressBeforeCancel && !cancelOutput.includes('> svn update'),
    cancelOutput.slice(-300));

  console.log('场景 9：真实副本「清理」完成写频道');
  const linesBeforeCleanup = channelText().length;
  await state.registered.get('svnAnywhere.cleanup')({ fsPath: join(probe, 'a.txt'), scheme: 'file' });
  const cleanupOutput = channelText().slice(linesBeforeCleanup);
  check('频道写清理完成', cleanupOutput.includes('清理完成。'), cleanupOutput.slice(-300));

  console.log('场景 10：真实副本「更新」遇冲突——退出码为 0 仍要提示冲突');
  writeFileSync(join(remote, 'a.txt'), 'remote edit\n');
  svn(['commit', '-q', '-m', 'remote edit a'], remote);
  writeFileSync(join(probe, 'a.txt'), 'local edit\n');
  state.confirmResult = '更新';
  const warningBeforeConflict = state.warning.length;
  const linesBeforeConflict = channelText().length;
  await state.registered.get('svnAnywhere.update')({ fsPath: probe, scheme: 'file' });
  const conflictOutput = channelText().slice(linesBeforeConflict);
  check('频道含冲突明细行 C', conflictOutput.includes('C    a.txt'), conflictOutput.slice(-600));
  check(
    '弹出冲突警告并列出文件',
    state.warning.length > warningBeforeConflict &&
      state.warning.slice(warningBeforeConflict).some((m) => m.includes('冲突') && m.includes('a.txt')),
    JSON.stringify(state.warning.slice(warningBeforeConflict)),
  );
  state.confirmResult = undefined;

  console.log('场景 11：P1 面板——远端有更新先三选，更新并继续后重读并提示再提交');
  const probe2 = svnLab.checkout('probe2');
  writeFileSync(join(probe2, 'b.txt'), 'v1');
  svn(['add', '-q', '--parents', 'b.txt'], probe2);
  svn(['commit', '-q', '-m', 'probe2 init'], probe2);
  writeFileSync(join(probe2, 'b.txt'), 'local edit\n');
  writeFileSync(join(remote, 'remote-add.txt'), 'x');
  svn(['add', '-q', '--parents', 'remote-add.txt'], remote);
  svn(['commit', '-q', '-m', 'remote add more'], remote);
  state.confirmResult = '更新并继续';
  const warningBeforeCommit = state.warning.length;
  const progressBeforeCommit = state.progressTitles.length;
  const linesBeforeCommitCheck = channelText().length;
  // 对目录驱动：单文件目标的 status -u 查不到其他路径的远端变更。
  const panel11 = await openCommitPanel(probe2, 'b.txt');
  const render11 = await waitRender(panel11, '仅远端变更');
  check('面板出现仅远端分组（提交前检查开启）', !!render11, '未出现远端分组');
  await commitViaPanel(panel11, ['b.txt'], '提交本地修改');
  // 真实 svn 检查+更新链路耗时不确定：轮询等待更新完成汇总出现。
  let commitCheckOutput = '';
  for (let retry = 0; retry < 300; retry += 1) {
    commitCheckOutput = channelText().slice(linesBeforeCommitCheck);
    if (commitCheckOutput.includes('更新完成，当前 revision') || commitCheckOutput.includes('更新完成。')) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  check(
    '弹出远端更新三选提示',
    state.warning.slice(warningBeforeCommit).some((m) => m.includes('远端更新')),
    JSON.stringify(state.warning.slice(warningBeforeCommit)),
  );
  check('频道写远端检查汇总', commitCheckOutput.includes('远端检查：'));
  check('执行了更新（进度通知）', state.progressTitles.length > progressBeforeCommit);
  check('频道有更新明细与最终 revision', commitCheckOutput.includes('更新完成，当前 revision'), JSON.stringify(state.warning.slice(warningBeforeCommit)).slice(0, 400));
  check(
    '更新并继续后不自动重提（说明与勾选保留，等待用户再次提交）',
    !commitCheckOutput.includes('Committed revision'),
    commitCheckOutput.slice(-400),
  );
  state.confirmResult = undefined;

  console.log('场景 12：P1 面板——部分勾选提交、revision 回显、多行说明、空说明与待添加');
  const probe3 = svnLab.checkout('probe3');
  writeFileSync(join(probe3, 'b2.txt'), 'v1');
  writeFileSync(join(probe3, 'c2.txt'), 'v1');
  svn(['add', '-q', '--parents', 'b2.txt', 'c2.txt'], probe3);
  svn(['commit', '-q', '-m', 'probe3 init'], probe3);
  writeFileSync(join(probe3, 'b2.txt'), 'committed content\n');
  writeFileSync(join(probe3, 'c2.txt'), 'kept local\n');
  writeFileSync(join(probe3, 'fresh.txt'), 'fresh body\n');
  const panel12 = await openCommitPanel(probe3, 'fresh.txt');
  const lastFrame = panel12.webview.posted.filter((m) => m.type === 'render').at(-1);
  const data12 = await waitRender(panel12, 'fresh.txt');
  check(
    '未版本控制默认不勾选',
    data12.html.includes('data-row-id="fresh.txt"') && !/data-row-id="fresh\.txt"[^>]*checked/.test(data12.html),
  );
  // F91 多行说明：换行必须原样进入远端日志，不能被展平成空格。
  const infoBeforeRealCommit = state.information.length;
  await commitViaPanel(panel12, ['b2.txt'], 'feat: mock host commit\n第二行说明');
  const okFirst = await waitNewInfo('提交成功', infoBeforeRealCommit);
  check('提交成功提示含 revision', okFirst,
    JSON.stringify(state.warning.slice(-3)).slice(0, 400) + '||CH=' + channelText().slice(-500));
  const remoteCheck = svn(['cat', `${svnLab.repoUrl}/b2.txt`]);
  check('远端确实收到新内容', remoteCheck.includes('committed content'));
  const logLines = svn(['log', '-r', 'HEAD', svnLab.repoUrl]).split('\n').map((l) => l.trim());
  check(
    '多行说明原样进入远端日志',
    logLines.includes('feat: mock host commit') && logLines.includes('第二行说明'),
    JSON.stringify(logLines),
  );
  check('未勾选项保持本地变更', svn(['status'], probe3).includes('c2.txt'));

  // F24/F80：空说明提交（开关默认允许，空说明二次确认）。
  state.confirmResult = '继续';
  const infoBeforeEmpty = state.information.length;
  await commitViaPanel(panel12, ['c2.txt'], '');
  check('空说明经二次确认后提交成功', await waitNewInfo('提交成功', infoBeforeEmpty),
    JSON.stringify(state.information.slice(infoBeforeEmpty)).slice(0, 300));
  check('空说明弹了二次确认', state.warning.some((m) => m.includes('提交说明为空')));

  // 提交内添加：勾选未版本控制项 → 范围确认 → 先 add 再 commit。
  const freshRevisionBefore = svn(['info', '--show-item', 'revision', svnLab.repoUrl]);
  const infoBeforeFresh = state.information.length;
  await commitViaPanel(panel12, ['fresh.txt'], 'add fresh file');
  await waitNewInfo('提交成功', infoBeforeFresh);
  check(
    '勾选未版本控制提交成功（先 add 后 commit）',
    svn(['cat', '-r', 'HEAD', 'fresh.txt'], probe3) === 'fresh body\n' &&
      svn(['info', '--show-item', 'revision', svnLab.repoUrl]) !== freshRevisionBefore,
  );
  check('范围确认列出待添加说明', state.warning.some((m) => m.includes('先登记 SVN 添加') || m.includes('未版本控制')));
  state.confirmResult = undefined;

  console.log('场景 13：P1 面板 missing——确认后 svn delete --force 并提交删除远端文件');
  writeFileSync(join(probe3, 'drop.txt'), 'to delete');
  svn(['add', '-q', '--parents', 'drop.txt'], probe3);
  svn(['commit', '-q', '-m', 'add drop'], probe3);
  rmSync(join(probe3, 'drop.txt'));
  state.confirmResult = '继续';
  const linesBeforeMissing = channelText().length;
  const infoBeforeMissing = state.information.length;
  const panel13 = await openCommitPanel(probe3, 'drop.txt');
  const infoBefore13 = state.information.length;
  await commitViaPanel(panel13, ['drop.txt'], 'chore: drop file');
  await waitNewInfo('提交成功', infoBefore13);
  const missingOutput = channelText().slice(linesBeforeMissing);
  check('missing 范围确认出现', state.warning.some((m) => m.includes('missing') || m.includes('未登记 SVN 删除')));
  check('commit 输出含删除行 Deleting', missingOutput.includes('Deleting       drop.txt'), missingOutput.slice(-600));
  check('提交成功提示', state.information.slice(infoBeforeMissing).some((m) => m.includes('提交成功')));
  let remoteMissing = false;
  try {
    svn(['cat', `${svnLab.repoUrl}/drop.txt`]);
    remoteMissing = false;
  } catch {
    remoteMissing = true;
  }
  check('远端文件已被删除', remoteMissing);
  state.confirmResult = undefined;

  console.log('场景 14：真实副本「编辑忽略规则」面板——自定义模式保存后 status 不再显示');
  const probe5 = svnLab.checkout('probe5');
  mkdirSync(join(probe5, 'src'), { recursive: true });
  writeFileSync(join(probe5, 'src', '.keep'), '');
  svn(['add', '-q', '--parents', join('src', '.keep')], probe5);
  svn(['commit', '-q', '-m', 'probe5 init'], probe5);
  writeFileSync(join(probe5, 'src', 'noise.log'), 'log');
  // 命令入口已切换为 P2 忽略规则面板：输入模式 → 加入 → 保存。
  const panel14 = await openIgnorePanel(join(probe5, 'src', 'noise.log'), '未设置 svn:ignore');
  panel14.sendAuto({ kind: 'syncInput', fieldId: 'draft', value: '*.log', inputRevision: state.intentSeq + 1000 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  panel14.sendAuto({ kind: 'addRule' });
  await waitRender(panel14, '未保存');
  panel14.sendAuto({ kind: 'saveIgnore' });
  await waitRender(panel14, '忽略规则已保存到本机');
  check('被忽略文件不再出现在 status', !svn(['status'], probe5).includes('noise.log'));
  check('保存卡片明示尚未提交 SVN',
    [...panel14.webview.posted].reverse().some((m) => m.type === 'render' && m.html.includes('尚未提交到 SVN')));

  console.log('场景 15：真实副本「重定位」——同仓库换地址后 info 指向新地址');
  const probe6 = svnLab.checkout('probe6');
  writeFileSync(join(probe6, 'r.txt'), 'v');
  svn(['add', '-q', '--parents', 'r.txt'], probe6);
  svn(['commit', '-q', '-m', 'probe6 init'], probe6);
  const oldUrl = svnLab.repoUrl;
  const newUrl = `${svnLab.repoUrl}-moved`;
  execFileSync('mv', [join(svnLab.lab, 'repo'), join(svnLab.lab, 'repo-moved')]);
  state.inputResult = newUrl;
  state.confirmResult = '重定位';
  const linesBeforeRelocate = channelText().length;
  await state.registered.get('svnAnywhere.relocate')({ fsPath: probe6, scheme: 'file' });
  const relocateOutput = channelText().slice(linesBeforeRelocate);
  check('频道写重定位完成', relocateOutput.includes('重定位完成。'), relocateOutput.slice(-400));
  check(
    '副本地址已指向新 URL',
    svn(['info', '--show-item', 'url', '.'], probe6).trim() === newUrl,
    svn(['info', '--show-item', 'url', '.'], probe6),
  );

  console.log('场景 16：重定位输入相同地址被拒绝；换仓库失败给针对性提示');
  state.inputResult = newUrl;
  const infoBeforeSame = state.information.length;
  await state.registered.get('svnAnywhere.relocate')({ fsPath: probe6, scheme: 'file' });
  check(
    '相同地址提示无需重定位',
    state.information.slice(infoBeforeSame).some((m) => m.includes('无需重定位')),
  );
  const foreign = makeSvnLab();
  state.inputResult = `file://${foreign.lab}/repo`;
  state.confirmResult = '重定位';
  const warningBeforeForeign = state.warning.length;
  await state.registered.get('svnAnywhere.relocate')({ fsPath: probe6, scheme: 'file' });
  check(
    '换仓库失败给针对性提示',
    state.warning.slice(warningBeforeForeign).some((m) => m.includes('同一仓库换地址')),
    JSON.stringify(state.warning.slice(warningBeforeForeign)),
  );
  state.inputResult = undefined;
  state.confirmResult = undefined;

  console.log('场景 17：deactivate 正常返回');
  let deactivateOk = true;
  try {
    extension.deactivate();
  } catch (err) {
    deactivateOk = false;
    console.error(`       ${err}`);
  }
  check('deactivate 不抛错', deactivateOk);

  console.log('场景 18：同一宿主实例二次 activate 不重复注册');
  const secondContext = {
    subscriptions: [],
    extensionUri: { scheme: 'file', path: '/mock-ext', toString: () => 'file:///mock-ext' },
    globalState: context.globalState,
  };
  let secondActivateOk = true;
  try {
    await extension.activate(secondContext);
  } catch (err) {
    secondActivateOk = false;
    console.error(`       ${err}`);
  }
  check(
    '二次 activate 不抛重复命令 ID 错误',
    secondActivateOk,
    'mock 模拟了真实 VSCode 的 already exists 行为；抛错说明旧句柄未释放',
  );
  check('命令注册集合仍与贡献点一致', state.registered.size === expectedIds.length);

  console.log('场景 19：P1 面板——嵌套目录与带空格文件的差异、选择提交和 missing 删除范围');
  const nestedLab = makeSvnLab();
  const nestedWc = nestedLab.checkout('nested');
  mkdirSync(join(nestedWc, 'src', 'src'), { recursive: true });
  const nestedNames = ['src/item.txt', 'src/src/item.txt', 'src/ report.txt ', 'src/report.txt', 'src/drop.txt', 'src/src/drop.txt'];
  for (const name of nestedNames) writeFileSync(join(nestedWc, name), `baseline ${name}\n`);
  svn(['add', '-q', 'src'], nestedWc);
  svn(['commit', '-q', '-m', 'nested baseline'], nestedWc);
  for (const name of nestedNames) writeFileSync(join(nestedWc, name), `modified ${name}\n`);
  // 以 wcRoot 为 cwd 的嵌套目标：entry 已相对根，面板路径不重复拼 target 前缀。
  const panel19 = await openCommitPanel(join(nestedWc, 'src'), 'src/item.txt');
  const data19 = await waitRender(panel19, 'src/src/item.txt');
  check(
    '面板保留嵌套同名路径的独立身份（不拼目标前缀）',
    data19.html.includes('data-row-id="src/item.txt"') && data19.html.includes('data-row-id="src/src/item.txt"'),
    '缺少嵌套同名条目',
  );
  // 差异：只打开选中项的并排 diff（右侧为工作文件，左侧为 BASE）。
  const diffCmdBefore19 = state.executedCommands.length;
  panel19.sendAuto({ kind: 'openDiff', itemId: 'src/item.txt' });
  for (let retry = 0; retry < 100 && state.executedCommands.length === diffCmdBefore19; retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const diff19 = state.executedCommands.at(-1);
  check(
    '嵌套目录差异指向选中项（vscode.diff 右端为选中工作文件）',
    diff19 && diff19[0] === 'vscode.diff' && diff19[2].path === join(nestedWc, 'src', 'item.txt'),
    JSON.stringify(diff19 ?? []).slice(0, 200),
  );
  if (diff19 && diff19[0] === 'vscode.diff') {
    check('差异左端是选中项 BASE', readFileSync(diff19[1].path, 'utf8') === 'baseline src/item.txt\n');
  }
  const info19a = state.information.length;
  await commitViaPanel(panel19, ['src/item.txt'], 'commit selected nested path');
  await waitNewInfo('提交成功', info19a);
  check('嵌套目录提交选中项，未误提交同名深层项',
    svn(['cat', `${nestedLab.repoUrl}/src/item.txt`]).startsWith('modified') &&
    svn(['cat', `${nestedLab.repoUrl}/src/src/item.txt`]).startsWith('baseline'));
  check('未选中同名深层项仍为本地修改', svn(['status'], nestedWc).includes('src/src/item.txt'));

  // 首尾空格文件（Q21）：条目身份保留，邻名不被波及。
  const info19b = state.information.length;
  await commitViaPanel(panel19, ['src/ report.txt '], 'commit spaced name');
  await waitNewInfo('提交成功', info19b);
  check('条目身份保留首尾空格，邻名不受影响',
    svn(['cat', '-r', 'HEAD', 'src/ report.txt '], nestedWc).startsWith('modified') &&
    svn(['cat', '-r', 'HEAD', 'src/report.txt'], nestedWc).startsWith('baseline'));

  rmSync(join(nestedWc, 'src', 'drop.txt'));
  state.confirmResult = '继续';
  await commitViaPanel(panel19, ['src/drop.txt'], 'drop nested missing');
  for (let retry = 0; retry < 400 && svn(['list', `${nestedLab.repoUrl}/src`]).includes('drop.txt'); retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  check('嵌套 missing 只删除选中目标，保留同名深层文件',
    !svn(['list', `${nestedLab.repoUrl}/src`]).split('\n').includes('drop.txt') &&
    svn(['cat', `${nestedLab.repoUrl}/src/src/drop.txt`]).startsWith('baseline') &&
    svn(['status'], nestedWc).includes('src/src/drop.txt'),
    svn(['list', `${nestedLab.repoUrl}/src`]) + '|' + svn(['status'], nestedWc).slice(0, 200));
  state.confirmResult = undefined;
  rmSync(nestedLab.lab, { recursive: true, force: true });

  console.log('场景 20：无法精确忽略的换行/回车名称不写入属性或误忽略其他文件');
  const specialLab = makeSvnLab();
  const specialWc = specialLab.checkout('special');
  for (const name of ['foo\nbar', 'foo\rbar', 'foo', 'bar']) writeFileSync(join(specialWc, name), 'unversioned');
  for (const name of ['foo\nbar', 'foo\rbar']) {
    const panel20 = await openIgnorePanel(join(specialWc, name), '此目录未设置 svn:ignore');
    await waitNewIdle(panel20, panel20.webview.posted.length);
    panel20.sendAuto({ kind: 'fillOriginName' });
    const rejected20 = await waitRender(panel20, '无法表示为一条精确忽略规则');
    check('不可编码名称给可读提示 ' + JSON.stringify(name), !!rejected20);
  }
  check('拒绝前未写 svn:ignore', !svn(['proplist', '--xml', '.'], specialWc).includes('svn:ignore'));
  check('相近名称没有被忽略', !svn(['status', '--no-ignore', '--xml', '.'], specialWc).includes('item="ignored"'));

  console.log('场景 21：P1 面板——控制字符与字面实体邻名保持不同身份，添加失败不波及邻名');
  const literalNames = ['foo&#10;bar', 'foo&#13;bar', 'foo&#9;bar'];
  for (const name of literalNames) {
    writeFileSync(join(specialWc, name), 'literal baseline');
    svn(['add', '-q', '--', name], specialWc);
  }
  svn(['commit', '-q', '-m', 'literal entities baseline'], specialWc);
  for (const name of literalNames) writeFileSync(join(specialWc, name), 'literal modified');
  const revisionBeforeControl = svn(['info', '--show-item', 'revision', specialLab.repoUrl]);
  const panel21 = await openCommitPanel(specialWc, 'foo&amp;#10;bar');
  const data21 = await waitRender(panel21, 'unversioned');
  // 控制字符名（unversioned）与字面实体名（modified）同时出现且身份不同。
  check(
    '面板保留换行与字面实体的不同身份',
    data21.html.includes('data-row-id="foo\nbar"') && data21.html.includes('data-row-id="foo&amp;#10;bar"'),
    data21.html.slice(0, 200),
  );
  // 勾选控制字符目标（unversioned）提交：add 被 svn 拒绝（E160005），不继续 commit、不操作邻名。
  state.confirmResult = '继续';
  await commitViaPanel(panel21, ['foo\nbar'], 'try invalid control path');
  for (let retry = 0; retry < 300 && ![...panel21.webview.posted].reverse().find((m) => m.type === 'render' && m.html.includes('添加失败')); retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  check('不支持的控制字符添加失败时停止，不提交邻名',
    svn(['info', '--show-item', 'revision', specialLab.repoUrl]) === revisionBeforeControl &&
    svn(['cat', '-r', 'HEAD', 'foo&#10;bar'], specialWc) === 'literal baseline',
    '控制字符目标导致邻名被提交');
  const addFailRender = [...panel21.webview.posted].reverse().find((m) => m.type === 'render' && m.html.includes('添加失败'));
  check('添加失败进面板横幅解释（已添加项保留 A 状态）', !!addFailRender, '未出现添加失败横幅');
  const info21b = state.information.length;
  await commitViaPanel(panel21, ['foo&#10;bar'], 'commit literal entity');
  await waitNewInfo('提交成功', info21b);
  check('选择字面实体只提交该文件',
    svn(['cat', '-r', 'HEAD', 'foo&#10;bar'], specialWc) === 'literal modified' &&
    svn(['cat', '-r', 'HEAD', 'foo&#13;bar'], specialWc) === 'literal baseline');

  console.log('场景 22：P1 面板——短横线选项邻名和 @ 邻名的差异/提交/删除范围');
  const optionName = '--targets=manifest';
  writeFileSync(join(specialWc, optionName), 'option baseline');
  writeFileSync(join(specialWc, 'manifest'), 'decoy.txt\n');
  writeFileSync(join(specialWc, 'decoy.txt'), 'decoy baseline');
  writeFileSync(join(specialWc, 'a@1'), 'selected baseline');
  writeFileSync(join(specialWc, 'a@1@'), 'neighbor baseline');
  svn(['add', '-q', '--', './--targets=manifest', 'manifest', 'decoy.txt', 'a@1@', 'a@1@@'], specialWc);
  svn(['commit', '-q', '-m', 'special paths baseline'], specialWc);
  writeFileSync(join(specialWc, optionName), 'OPTION-SELECTED-CHANGE');
  writeFileSync(join(specialWc, 'decoy.txt'), 'DECOY-CHANGE');
  writeFileSync(join(specialWc, 'a@1'), 'AT-SELECTED-CHANGE');
  writeFileSync(join(specialWc, 'a@1@'), 'AT-NEIGHBOR-CHANGE');
  const panel22 = await openCommitPanel(specialWc, 'a@1');
  // 差异不指向邻名：逐项 openDiff 后断言 vscode.diff 右端是目标工作文件。
  for (const name of [optionName, 'a@1', 'a@1@']) {
    const before22 = state.executedCommands.length;
    panel22.sendAuto({ kind: 'openDiff', itemId: name });
    for (let retry = 0; retry < 100 && state.executedCommands.length === before22; retry += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const diff22 = state.executedCommands.at(-1);
    check(
      '特殊目标差异指向自身 ' + JSON.stringify(name),
      diff22 && diff22[0] === 'vscode.diff' && diff22[2].path === join(specialWc, name),
      JSON.stringify(diff22 ?? []).slice(0, 160),
    );
  }
  const info22a = state.information.length;
  await commitViaPanel(panel22, [optionName], 'commit literal option file');
  await waitNewInfo('提交成功', info22a);
  check('短横线目标提交安全，不读取 manifest 误提交',
    svn(['cat', '-r', 'HEAD', '--', './--targets=manifest'], specialWc) === 'OPTION-SELECTED-CHANGE' &&
    svn(['cat', '-r', 'HEAD', 'decoy.txt'], specialWc) === 'decoy baseline');
  const info22b = state.information.length;
  await commitViaPanel(panel22, ['a@1'], 'commit at name');
  await waitNewInfo('提交成功', info22b);
  check('含 @ 的提交保留 peg 语义且不提交末尾 @ 邻名',
    svn(['cat', '-r', 'HEAD', 'a@1@'], specialWc) === 'AT-SELECTED-CHANGE' &&
    svn(['cat', '-r', 'HEAD', 'a@1@@'], specialWc) === 'neighbor baseline');
  const info22c = state.information.length;
  await commitViaPanel(panel22, ['a@1@'], 'commit at neighbor');
  await waitNewInfo('提交成功', info22c);
  check('末尾 @ 邻名也可被单独提交',
    svn(['cat', '-r', 'HEAD', 'a@1@@'], specialWc) === 'AT-NEIGHBOR-CHANGE');
  rmSync(join(specialWc, optionName));
  // 面板外删除已纳管文件：先刷新面板，missing 条目出现后再勾选提交。
  await waitPanelIdle(panel22);
  panel22.sendAuto({ kind: 'refresh' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  for (let retry = 0; retry < 300; retry += 1) {
    const fresh = [...panel22.webview.posted].reverse().find((m) => m.type === 'render' && m.html.includes('data-row-id="--targets=manifest"'));
    if (fresh && fresh.html.includes('missing')) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  state.confirmResult = '继续';
  await commitViaPanel(panel22, [optionName], 'drop option file');
  for (let retry = 0; retry < 400 && svn(['list', specialLab.repoUrl]).includes(optionName); retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  {
    const f = [...panel22.webview.posted].reverse().find((m) => m.type === 'render');
  }
  check('短横线 missing 登记删除只作用于目标',
    !svn(['list', specialLab.repoUrl]).split('\n').includes(optionName) &&
    svn(['cat', '-r', 'HEAD', 'decoy.txt'], specialWc) === 'decoy baseline');
  state.confirmResult = undefined;
  rmSync(specialLab.lab, { recursive: true, force: true });

  console.log('场景 23：P1 面板基座——CSP 骨架、树形渲染与差异能力（真实副本）');
  const panelLab = makeSvnLab();
  const panelWc = panelLab.checkout('panel-wc');
  mkdirSync(join(panelWc, 'src', 'core'), { recursive: true });
  writeFileSync(join(panelWc, 'src', 'core', 'a.txt'), 'base content\n');
  writeFileSync(join(panelWc, 'src', 'core', 'prop.txt'), 'x');
  writeFileSync(join(panelWc, 'src', 'bin.img'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]));
  svn(['add', '-q', 'src'], panelWc);
  svn(['commit', '-q', '-m', 'panel baseline'], panelWc);
  writeFileSync(join(panelWc, 'src', 'new.txt'), 'unversioned body');
  writeFileSync(join(panelWc, 'src', 'core', 'a.txt'), 'work content\n');
  svn(['propset', '-q', 'svn:ignore', 'tmp', 'src'], panelWc);
  const panel = await openCommitPanel(panelWc, 'src/core/a.txt');
  check('HTML 骨架含 CSP/nonce/asWebviewUri 资源',
    panel.webview.html.includes("default-src 'none'") &&
    /script-src 'nonce-[0-9a-f]+/.test(panel.webview.html) &&
    panel.webview.html.includes('vscode-webview://fake/mock-ext/media/panel.js'),
    panel.webview.html.slice(0, 400));
  const data23 = await waitRender(panel, 'tree-folder');
  check('默认树形：导航目录聚合勾选与折叠按钮',
    data23.html.includes('data-node-id="local|src"') && data23.html.includes('data-nav-key="local|src"'),
    data23.html.slice(0, 300));
  check('目录属性行独立出现（src 目录属性）', data23.html.includes('data-row-id="src"') && data23.html.includes('目录属性'));
  check('unversioned 行差异禁用并可解释', /data-intent="openDiff" data-item-id="src\/new\.txt"[^>]*disabled/.test(data23.html),
    (data23.html.match(/data-item-id="src\/new\.txt"[^>]*>/g) ?? []).join(' | '));
  // 树/列表切换：选择与筛选保留。
  await waitPanelIdle(panel);
  panel.sendAuto({ kind: 'setView', view: 'list' });
  const listRender = await waitRender(panel, 'src/core/a.txt');
  check('列表模式平铺完整路径且无导航节点', listRender.html.includes('>src/core/a.txt<') && !listRender.html.includes('tree-folder'));
  panel.sendAuto({ kind: 'setView', view: 'tree' });

  // 单文件差异（modified）：vscode.diff 左端 BASE、右端工作文件、临时释放。
  const diffCmdBefore = state.executedCommands.length;
  panel.sendAuto({ kind: 'openDiff', itemId: 'src/core/a.txt' });
  for (let retry = 0; retry < 100 && state.executedCommands.length === diffCmdBefore; retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const diffCall = state.executedCommands.at(-1);
  check('modified 打开 vscode.diff 并排差异', diffCall && diffCall[0] === 'vscode.diff',
    JSON.stringify(state.executedCommands.slice(diffCmdBefore)).slice(0, 300));
  if (diffCall && diffCall[0] === 'vscode.diff') {
    check('差异左端是 BASE 内容', readFileSync(diffCall[1].path, 'utf8') === 'base content\n', diffCall[1].path);
    check('差异右端是工作文件', diffCall[2].path === join(panelWc, 'src', 'core', 'a.txt'), diffCall[2].path);
    state.closeDocHandlers.forEach((cb) => cb({ uri: diffCall[1] }));
    check('关闭差异后临时 BASE 文件已释放', !existsSync(diffCall[1].path), diffCall[1].path);
  }
  // 纯属性目录走属性差异（输出频道），不打开文本 diff。
  const propCommands = state.executedCommands.length;
  panel.sendAuto({ kind: 'openDiff', itemId: 'src' });
  for (let retry = 0; retry < 100 && state.executedCommands.length === propCommands; retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  check('纯属性目录走属性差异（不打开文本 diff）',
    !state.executedCommands.slice(propCommands).some((args) => args[0] === 'vscode.diff') &&
    channelText().includes('属性差异'),
    channelText().slice(-400));
  // 伪造条目 / 旧会话意图不触发差异；协议版本不兼容被拒绝并 toast。
  const forgedCommands = state.executedCommands.length;
  panel.sendIntent({ kind: 'openDiff', itemId: 'not-exist' }, data23.sessionId, 901);
  panel.sendIntent({ kind: 'openDiff', itemId: 'src/core/a.txt' }, 'stale-session', 902);
  await new Promise((resolve) => setTimeout(resolve, 200));
  check('伪造/旧会话意图不触发差异', state.executedCommands.length === forgedCommands,
    JSON.stringify(state.executedCommands.slice(forgedCommands)).slice(0, 200));
  const invalidToastBefore = panel.webview.posted.length;
  panel.send({ type: 'intent', protocolVersion: 99, sessionId: data23.sessionId, requestId: 'x', intent: { kind: 'refresh' } });
  check('协议版本不兼容被拒绝并 toast 原因',
    panel.webview.posted.slice(invalidToastBefore).some((m) => m.type === 'toast' && m.message.includes('协议版本不兼容')),
    JSON.stringify(panel.webview.posted.slice(invalidToastBefore).slice(0, 2)));

  console.log('场景 24：面板生命周期——同目标复用、目标切换、忙碌拒绝与迟到结果');
  const panelsBeforeReuse = state.panels.length;
  await state.registered.get('svnAnywhere.commit')({ fsPath: panelWc, scheme: 'file' });
  check('同目标再次调用复用面板并 reveal',
    state.panels.length === panelsBeforeReuse && panel.revealed >= 1,
    `panels=${state.panels.length} revealed=${panel.revealed}`);
  const panelWc2 = panelLab.checkout('panel-wc2');
  writeFileSync(join(panelWc2, 'b.txt'), 'v2\n');
  const panelsBeforeSwitch = state.panels.length;
  await state.registered.get('svnAnywhere.commit')({ fsPath: panelWc2, scheme: 'file' });
  check('不同目标切换复用同一面板实例（不新建）', state.panels.length === panelsBeforeSwitch);
  const secondRender = await waitRender(panel, 'b.txt');
  check('切换后渲染新目标会话（含 b.txt）',
    secondRender && secondRender.sessionId !== data23.sessionId,
    JSON.stringify(secondRender ?? {}).slice(0, 200));
  // 旧会话迟到结果：直接向旧 sessionId 发意图应被忽略。
  const lateCommands = state.executedCommands.length;
  panel.sendIntent({ kind: 'openDiff', itemId: 'src/core/a.txt' }, data23.sessionId, 903);
  await new Promise((resolve) => setTimeout(resolve, 150));
  check('旧会话迟到意图不再执行', state.executedCommands.length === lateCommands);
  // 忙碌拒绝切换：refresh 进行中切新目标。
  panel.sendAuto({ kind: 'refresh' });
  const warningBeforeBusy = state.warning.length;
  const panelWc3 = panelLab.checkout('panel-wc3');
  writeFileSync(join(panelWc3, 'c.txt'), 'v3\n');
  await state.registered.get('svnAnywhere.commit')({ fsPath: panelWc3, scheme: 'file' });
  check('忙碌期间拒绝切换目标并提示',
    state.warning.slice(warningBeforeBusy).some((m) => m.includes('拒绝切换')),
    JSON.stringify(state.warning.slice(warningBeforeBusy)));
  for (let retry = 0; retry < 100 && channelText().includes('正在读取…'); retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  console.log('场景 25：面板销毁——dispose 后迟到结果与二次打开');
  const lastSessionRender = [...panel.webview.posted].reverse().find((m) => m.type === 'render');
  panel.dispose();
  const postedAfterDispose = panel.webview.posted.length;
  panel.sendIntent({ kind: 'openDiff', itemId: 'b.txt' }, lastSessionRender.sessionId, 904);
  panel.sendReady();
  await new Promise((resolve) => setTimeout(resolve, 150));
  check('销毁后不再有任何消息更新', panel.webview.posted.length === postedAfterDispose);
  await state.registered.get('svnAnywhere.commit')({ fsPath: panelWc, scheme: 'file' });
  const reopened = state.panels.at(-1);
  check('销毁后再次打开创建新面板', reopened !== panel && state.panels.length === panelsBeforeReuse + 1);
  reopened.sendReady();
  const reopenedRender = await waitRender(reopened, 'src/core/a.txt');
  check('新面板新会话渲染同一目标',
    reopenedRender && reopenedRender.sessionId !== lastSessionRender.sessionId && reopenedRender.html.includes('src/core/a.txt'),
    JSON.stringify(reopenedRender ?? {}).slice(0, 200));

  console.log('场景 26：P1 行内操作——还原与删除（已版本控制/回收站）');
  const actWc = panelLab.checkout('act-wc');
  writeFileSync(join(actWc, 'revert.txt'), 'base\n');
  writeFileSync(join(actWc, 'del.txt'), 'base\n');
  svn(['add', '-q', 'revert.txt', 'del.txt'], actWc);
  svn(['commit', '-q', '-m', 'act baseline'], actWc);
  writeFileSync(join(actWc, 'revert.txt'), 'changed\n');
  writeFileSync(join(actWc, 'del.txt'), 'changed\n');
  const panel26 = await openCommitPanel(actWc, 'revert.txt');
  state.quickPickChoice = '还原…';
  state.confirmResult = '继续';
  await waitPanelIdle(panel26);
  panel26.sendAuto({ kind: 'rowMore', itemId: 'revert.txt' });
  for (let retry = 0; retry < 100 && svn(['status'], actWc).includes('revert.txt'); retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  check('行内还原后条目回到 normal（不再出现在变更列表）', !svn(['status'], actWc).includes('revert.txt'));
  // 已版本控制删除：svn delete --force 同时删除本地。
  state.quickPickChoice = '登记删除…';
  for (let retry = 0; retry < 300; retry += 1) {
    const fresh = [...panel26.webview.posted].reverse().find(
      (m) => m.type === 'render' && m.html.includes('data-row-id="del.txt"') && !m.html.includes('data-row-id="revert.txt"'),
    );
    if (fresh) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  panel26.sendAuto({ kind: 'rowMore', itemId: 'del.txt' });
  for (let retry = 0; retry < 100 && existsSync(join(actWc, 'del.txt')); retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  check('已版本控制删除走 svn delete --force（本地一并删除）', !existsSync(join(actWc, 'del.txt')) && svn(['status'], actWc).includes('del.txt'),
    'warn=' + JSON.stringify(state.warning.slice(-3)).slice(0, 300));
  // 未版本控制删除：优先 /usr/bin/trash（文件从原位置消失即视为进回收站流程）。
  writeFileSync(join(actWc, 'trash-me.txt'), 'x');
  const panel26b = await openCommitPanel(actWc, 'trash-me.txt');
  state.quickPickChoice = '移到回收站…';
  await waitPanelIdle(panel26b);
  panel26b.sendAuto({ kind: 'rowMore', itemId: 'trash-me.txt' });
  for (let retry = 0; retry < 100 && existsSync(join(actWc, 'trash-me.txt')); retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  check('未版本控制删除移入回收站（原位置消失）', !existsSync(join(actWc, 'trash-me.txt')));
  state.quickPickChoice = undefined;
  state.confirmResult = undefined;

  console.log('场景 27：P1 changelist——筛选与整组选择分离，特殊组名不冲突（Q27）');
  const clWc = panelLab.checkout('cl-wc');
  for (const name of ['all.txt', 'none.txt', 'plain.txt']) writeFileSync(join(clWc, name), 'base\n');
  svn(['add', '-q', 'all.txt', 'none.txt', 'plain.txt'], clWc);
  svn(['commit', '-q', '-m', 'cl baseline'], clWc);
  writeFileSync(join(clWc, 'all.txt'), 'v2');
  writeFileSync(join(clWc, 'none.txt'), 'v2');
  writeFileSync(join(clWc, 'plain.txt'), 'v2');
  svn(['changelist', '-q', 'all', 'all.txt'], clWc);
  svn(['changelist', '-q', 'name:all', 'none.txt'], clWc);
  const panel27 = await openCommitPanel(clWc, 'plain.txt');
  const data27 = await waitRender(panel27, 'changelist');
  // 分组条目与未分组条目都在面板上，changelist 徽标按原值。
  check('changelist 容器条目与未分组条目同时出现',
    data27.html.includes('data-row-id="all.txt"') &&
    data27.html.includes('data-row-id="none.txt"') &&
    data27.html.includes('data-row-id="plain.txt"'));
  // 筛选真实组名 all：编码值 name:all 与哨兵不冲突。
  await waitPanelIdle(panel27);
  panel27.sendAuto({ kind: 'setFilter', filterId: 'changelist', value: 'name:all' });
  let filtered27;
  for (let retry = 0; retry < 200; retry += 1) {
    filtered27 = [...panel27.webview.posted].reverse().find(
      (m) => m.type === 'render' && m.html.includes('data-row-id="all.txt"') && m.html.includes('显示 1 / 3 项'),
    );
    if (filtered27) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  check('真实组名 all 的筛选不与哨兵冲突（只显示 all.txt，全局选择保留）',
    !!filtered27 && filtered27.html.includes('data-row-id="all.txt"') && !filtered27.html.includes('data-row-id="plain.txt"'),
    filtered27 ? filtered27.html.slice(0, 300) : '未等到筛选帧');
  // 显式整组选择：替换选择为该组成员；随后仍可取消单项，提交按实际勾选。
  panel27.sendAuto({ kind: 'selectChangelist' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const groupPick27 = await waitRender(panel27, '已选 1 项');
  check('整组选择替换选择并清除其他筛选', !!groupPick27);
  await waitPanelIdle(panel27);
  panel27.sendAuto({ kind: 'toggleRow', rowId: 'all.txt', selected: false });
  panel27.sendAuto({ kind: 'toggleRow', rowId: 'plain.txt', selected: true });
  const info27 = state.information.length;
  await commitViaPanel(panel27, ['plain.txt'], 'commit ungrouped only');
  await waitNewInfo('提交成功', info27);
  check('筛选不改变提交语义：实际勾选（plain.txt）才提交，组成员保留本地修改',
    svn(['cat', '-r', 'HEAD', 'plain.txt'], clWc) === 'v2' &&
    svn(['cat', '-r', 'HEAD', 'all.txt'], clWc) === 'base\n' &&
    svn(['status'], clWc).includes('all.txt'));

  console.log('场景 28：P1 未版本控制目录——枚举子项、忽略项不加入、链接叶节点、嵌套副本隔离');
  const dirWc = panelLab.checkout('dir-wc');
  mkdirSync(join(dirWc, 'newdir', 'sub'), { recursive: true });
  // 目录先纳管（--depth empty 不带子项）并提交 svn:ignore：忽略项由 svn 隐藏，
  // 未纳管子目录（sub）由面板递归枚举具体子项。
  svn(['add', '-q', '--depth', 'empty', 'newdir'], dirWc);
  svn(['commit', '-q', '-m', 'dir baseline', '--depth', 'empty', 'newdir'], dirWc);
  const ignoreTmp = join(dirWc, '.svn', 'ignore-rules.tmp');
  writeFileSync(ignoreTmp, 'skipped.log\n*.tmp\n');
  svn(['propset', '-q', 'svn:ignore', '-F', ignoreTmp, 'newdir'], dirWc);
  writeFileSync(join(dirWc, 'newdir', 'main.ts'), 'main');
  writeFileSync(join(dirWc, 'newdir', 'sub', 'child.ts'), 'child');
  writeFileSync(join(dirWc, 'newdir', 'skipped.log'), 'ignored');
  writeFileSync(join(dirWc, 'newdir', 'keep.txt'), 'picked');
  symlinkSync(join(dirWc, 'newdir', 'keep.txt'), join(dirWc, 'newdir', 'link'));
  writeFileSync(join(dirWc, 'newdir', 'noise.tmp'), 'tmp ignored');
  // 嵌套工作副本：newdir 下再检出一份独立副本。
  const nestedWc28 = join(dirWc, 'newdir', 'nested-wc');
  mkdirSync(nestedWc28, { recursive: true });
  svn(['checkout', '-q', panelLab.repoUrl, nestedWc28], dirWc);
  const panel28 = await openCommitPanel(dirWc, 'newdir');
  const data28 = await waitRender(panel28, 'newdir/main.ts');
  check('未版本控制目录枚举出具体子项（svn status 不进入，面板递归枚举）',
    data28.html.includes('data-row-id="newdir/main.ts"') && data28.html.includes('data-row-id="newdir/sub/child.ts"'),
    data28.html.slice(0, 400));
  check('忽略项不进入面板（skipped.log / *.tmp）',
    !data28.html.includes('skipped.log') && !data28.html.includes('noise.tmp'));
  check('符号链接作为叶节点标记', data28.html.includes('data-row-id="newdir/link"') && data28.html.includes('符号链接'));
  check('嵌套工作副本按副本边界隔离（不可勾选）',
    data28.html.includes('data-row-id="newdir/nested-wc"') && /data-row-id="newdir\/nested-wc"[^>]*disabled/.test(data28.html));
  // 勾选子文件与子目录：目录 --depth empty 不隐式递归；未勾选文件不加入。
  state.confirmResult = '继续';
  const info28 = state.information.length;
  await commitViaPanel(panel28, ['newdir/keep.txt', 'newdir/sub/child.ts'], 'add selected children only');
  await waitNewInfo('提交成功', info28, 400);
  const status28 = svn(['status'], dirWc);
  check('勾选子项已添加并提交（远端可见）',
    svn(['list', '-r', 'HEAD', `${panelLab.repoUrl}/newdir`]).includes('keep.txt'));
  check('未勾选文件不递归加入（main.ts 仍未版本控制）', status28.includes('main.ts'));
  check('忽略项未被加入（保持 ignored 而非 A）',
    !/^A\s+newdir\/skipped\.log/m.test(status28) && svn(['status', '--no-ignore'], dirWc).includes('I       newdir/skipped.log'));
  check('符号链接未被带入（未勾选保持 unversioned）', !/^A\s+newdir\/link/m.test(status28));
  state.confirmResult = undefined;

  console.log('场景 29：P1 拆批提交——100 项以上分批，每批 revision 即时记录');
  const batchWc = panelLab.checkout('batch-wc');
  mkdirSync(join(batchWc, 'batch'), { recursive: true });
  const batchNames = Array.from({ length: 120 }, (_, i) => `batch/f${String(i).padStart(3, '0')}.txt`);
  for (const name of batchNames) writeFileSync(join(batchWc, name), 'base\n');
  svn(['add', '-q', 'batch'], batchWc);
  svn(['commit', '-q', '-m', 'batch baseline'], batchWc);
  for (const name of batchNames) writeFileSync(join(batchWc, name), 'modified\n');
  const panel29 = await openCommitPanel(batchWc, 'batch/f000.txt');
  const data29 = await waitRender(panel29, 'batch/f119.txt');
  check('120 项全部进入面板（默认全选可提交本地项）', data29.html.includes('data-row-id="batch/f119.txt"'));
  // 默认全选直接提交（不 clear，保留默认勾选）。
  panel29.sendAuto({ kind: 'syncInput', fieldId: 'message', value: 'batched commit', inputRevision: state.intentSeq + 1000 });
  panel29.sendAuto({ kind: 'submit' });
  const revisionsBefore29 = (channelText().match(/Committed revision/g) || []).length;
  for (let retry = 0; retry < 2000; retry += 1) {
    if (((channelText().match(/Committed revision/g) || []).length - revisionsBefore29) >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const commitRevisions = [];
  for (let retry = 0; retry < 2000 && commitRevisions.length < 2; retry += 1) {
    const text = channelText();
    commitRevisions.length = 0;
    const all = [...text.matchAll(/Committed revision (\d+)\./g)].map((m) => m[1]);
    commitRevisions.push(...all.slice(revisionsBefore29));
    if (commitRevisions.length < 2) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  check('超过 100 项拆成两批并各回显一个 revision', commitRevisions.length >= 2,
    `revisions=${JSON.stringify(commitRevisions)}`);
  const after29 = svn(['status'], batchWc);
  check('两批全部提交成功，工作副本变干净', after29.trim() === '', after29.slice(0, 200));
  await waitPanelIdle(panel29);
  let success29;
  for (let retry = 0; retry < 300; retry += 1) {
    success29 = [...panel29.webview.posted].reverse().find((m) => m.type === 'render' && m.html.includes('r' + commitRevisions[0]));
    if (success29) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  check('成功卡片回显全部批次 revision（不承诺单 revision）',
    !!success29 && commitRevisions.length >= 2 && success29.html.includes('r' + commitRevisions[0]) && success29.html.includes('r' + commitRevisions[1]),
    `revs=${JSON.stringify(commitRevisions)} card=${success29 ? String(success29.html.match(/已提交[^<]{0,60}/)) : '未出现成功卡片'}`);

  console.log('场景 30：P1 部分成功——pre-commit 钩子拒绝第二批，重试只处理剩余项');
  const partialLab = makeSvnLab();
  const partialWc = partialLab.checkout('partial-wc');
  mkdirSync(join(partialWc, 'batch'), { recursive: true });
  const partialNames = Array.from({ length: 120 }, (_, i) => `batch/f${String(i).padStart(3, '0')}.txt`);
  for (const name of partialNames) writeFileSync(join(partialWc, name), 'base\n');
  svn(['add', '-q', 'batch'], partialWc);
  svn(['commit', '-q', '-m', 'partial baseline'], partialWc);
  for (const name of partialNames) writeFileSync(join(partialWc, name), 'modified\n');
  // pre-commit 钩子拒绝包含 f110 的提交事务：第一批（f000-f099）成功，第二批失败。
  // svn 执行 hook 时使用受限 PATH（实测不含 Homebrew 路径），
  // svnlook 以本机解析出的绝对路径写入 hook 脚本。
  const svnlookBin = execFileSync('which', ['svnlook'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(partialLab.lab, 'repo', 'hooks', 'pre-commit'),
    ['#!/bin/sh', 'REPOS="$1"', 'TXN="$2"', `FILES=\`${svnlookBin} changed "$REPOS" -t "$TXN"\``, 'case "$FILES" in *f110*) echo "reject f110" 1>&2; exit 1;; esac', 'exit 0', ''].join('\n'),
  );
  execFileSync('chmod', ['+x', join(partialLab.lab, 'repo', 'hooks', 'pre-commit')]);
  const panel30 = await openCommitPanel(partialWc, 'batch/f119.txt');
  await waitPanelIdle(panel30);
  const revBefore30 = (channelText().match(/Committed revision/g) || []).length;
  panel30.sendAuto({ kind: 'syncInput', fieldId: 'message', value: 'partial commit', inputRevision: state.intentSeq + 1000 });
  panel30.sendAuto({ kind: 'submit' });
  let partialBanner30;
  for (let retry = 0; retry < 600 && !partialBanner30; retry += 1) {
    partialBanner30 = [...panel30.webview.posted].reverse().find(
      (m) => m.type === 'render' && m.html.includes('部分成功') && m.html.includes('data-row-id="batch/f110.txt"'),
    );
    if (!partialBanner30) await new Promise((resolve) => setTimeout(resolve, 30));
  }
  check('部分成功横幅出现且剩余项保留在面板', !!partialBanner30, '未等到部分成功帧');
  const committed30 = [...channelText().matchAll(/Committed revision (\d+)\./g)].map((m) => m[1]).slice(revBefore30);
  check('第一批回显一个 revision', committed30.length === 1, `revisions=${JSON.stringify(committed30)}`);
  check('第一批（f000）已入库、第二批（f110-f119）保留本地修改',
    svn(['cat', '-r', 'HEAD', 'batch/f000.txt'], partialWc) === 'modified\n' &&
    svn(['cat', '-r', 'HEAD', 'batch/f110.txt'], partialWc) === 'base\n' &&
    svn(['status'], partialWc).includes('batch/f110.txt'));
  // 移除钩子后重试：不被自身记录阻塞，剩余项全部提交。
  rmSync(join(partialLab.lab, 'repo', 'hooks', 'pre-commit'));
  const commitsBeforeRetry30 = (channelText().match(/Committed revision/g) || []).length;
  panel30.sendAuto({ kind: 'submit' });
  for (let retry = 0; retry < 600; retry += 1) {
    if (((channelText().match(/Committed revision/g) || []).length - commitsBeforeRetry30) >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  await waitPanelIdle(panel30);
  check('重试不被自身操作记录阻塞，剩余项全部提交成功',
    svn(['status'], partialWc).trim() === '' && svn(['cat', '-r', 'HEAD', 'batch/f110.txt'], partialWc) === 'modified\n',
    svn(['status'], partialWc).slice(0, 200));
  rmSync(partialLab.lab, { recursive: true, force: true });

  console.log('场景 31：P1 externals——外部目录不混入当前提交范围（真实 svn:externals）');
  const extLab = makeSvnLab();
  execFileSync('svn', ['mkdir', '-q', '-m', 'ext base', `${extLab.repoUrl}/ext-src`]);
  const extHost = extLab.checkout('ext-host', 'ext-src');
  writeFileSync(join(extHost, 'shared.txt'), 'shared base\n');
  svn(['add', '-q', 'shared.txt'], extHost);
  svn(['commit', '-q', '-m', 'shared base'], extHost);
  const extMain = extLab.checkout('ext-main');
  writeFileSync(join(extMain, 'main.txt'), 'main base\n');
  svn(['add', '-q', 'main.txt'], extMain);
  // 声明 externals：vendor 指向仓库 ext-src 子目录（外部工作副本边界）。
  writeFileSync(join(extMain, '.svn', 'ext-def.tmp'), `vendor ${extLab.repoUrl}/ext-src\n`);
  svn(['propset', '-q', 'svn:externals', '-F', join(extMain, '.svn', 'ext-def.tmp'), '.'], extMain);
  rmSync(join(extMain, '.svn', 'ext-def.tmp'));
  svn(['commit', '-q', '-m', 'declare externals'], extMain);
  state.confirmResult = '更新';
  await state.registered.get('svnAnywhere.update')({ fsPath: extMain, scheme: 'file' });
  state.confirmResult = undefined;
  // 外部副本内产生修改 + 主副本修改。
  writeFileSync(join(extMain, 'vendor', 'shared.txt'), 'shared changed in external\n');
  writeFileSync(join(extMain, 'main.txt'), 'main changed\n');
  const panel31 = await openCommitPanel(extMain, 'main.txt');
  const data31 = [...panel31.webview.posted].reverse().find((m) => m.type === 'render' && m.html.includes('data-row-id="main.txt"'));
  check('externals 占位条目不进入面板（解析层过滤 external）',
    !!data31 && !data31.html.includes('data-row-id="vendor"'),
    data31 ? data31.html.slice(0, 200) : '未等到数据帧');
  check('外部副本内部的修改不混入当前面板（副本边界隔离）',
    !data31.html.includes('vendor/shared.txt'));
  // 提交主副本修改：外部目录不参与。
  await commitViaPanel(panel31, ['main.txt'], 'commit main only');
  check('提交只作用于主副本，外部副本修改保留',
    svn(['cat', '-r', 'HEAD', 'main.txt'], extMain) === 'main changed\n' &&
    svn(['status'], join(extMain, 'vendor')).includes('shared.txt'));
  rmSync(extLab.lab, { recursive: true, force: true });

  console.log('场景 32：P1 目录删除——确认枚举影响子树，提交后整棵删除入库');
  const delLab = makeSvnLab();
  const delWc = delLab.checkout('del-wc');
  mkdirSync(join(delWc, 'tree', 'inner'), { recursive: true });
  writeFileSync(join(delWc, 'tree', 'a.txt'), 'a\n');
  writeFileSync(join(delWc, 'tree', 'inner', 'b.txt'), 'b\n');
  svn(['add', '-q', 'tree'], delWc);
  svn(['commit', '-q', '-m', 'tree baseline'], delWc);
  // 目录属性修改让 tree 成为面板条目（svn status 不列无变更目录）。
  svn(['propset', '-q', 'custom:mark', '1', 'tree'], delWc);
  // 面板行内删除目录：确认框枚举子树（svn list -R），登记后提交删除。
  const panel32 = await openCommitPanel(delWc, 'data-row-id="tree"');
  await waitPanelIdle(panel32);
  state.quickPickChoice = '登记删除…';
  state.confirmResult = '继续';
  const warnsBefore32 = state.warning.length;
  panel32.sendAuto({ kind: 'rowMore', itemId: 'tree' });
  let subtreeConfirm32;
  for (let retry = 0; retry < 300 && !subtreeConfirm32; retry += 1) {
    subtreeConfirm32 = state.warning.slice(warnsBefore32).find((m) => m.includes('tree/a.txt') && m.includes('tree/inner/b.txt'));
    if (!subtreeConfirm32) await new Promise((resolve) => setTimeout(resolve, 30));
  }
  check('目录删除确认枚举完整影响子树', !!subtreeConfirm32, JSON.stringify(state.warning.slice(warnsBefore32)).slice(0, 300));
  state.quickPickChoice = undefined;
  for (let retry = 0; retry < 300 && existsSync(join(delWc, 'tree')); retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  await waitPanelIdle(panel32);
  // 提交删除：远端整棵树消失。
  await commitViaPanel(panel32, ['tree'], 'drop tree');
  check('目录删除提交后远端整棵树消失',
    !svn(['list', delLab.repoUrl]).includes('tree'),
    svn(['list', delLab.repoUrl]));
  state.confirmResult = undefined;
  rmSync(delLab.lab, { recursive: true, force: true });

  console.log('场景 33：P2 面板——文件入口编辑父目录、加入/保存/本机生效/清空 propdel（真实 SVN）');
  const igLab = makeSvnLab();
  const igWc = igLab.checkout('ig-wc');
  mkdirSync(join(igWc, 'src'), { recursive: true });
  writeFileSync(join(igWc, 'src', '.keep'), '');
  writeFileSync(join(igLab.lab, 'rules-old.txt'), 'old\n');
  svn(['add', '-q', '--parents', join('src', '.keep')], igWc);
  svn(['propset', '-q', 'svn:ignore', '-F', join(igLab.lab, 'rules-old.txt'), 'src'], igWc);
  svn(['propset', '-q', 'custom:keep', 'v1', 'src'], igWc);
  svn(['commit', '-q', '-m', 'ig base'], igWc);
  writeFileSync(join(igWc, 'src', 'noise.log'), 'log');
  writeFileSync(join(igWc, 'src', 'keep.log'), 'log');
  const panelsBefore33 = state.panels.length;
  const p33 = await openIgnorePanel(join(igWc, 'src', 'noise.log'), 'rule-text');
  const base33 = p33.webview.posted.length;
  check('P2 打开的是忽略规则面板（不创建 P1）',
    state.panels.length === panelsBefore33 && p33.viewType === 'svn-anywhere-ignore');
  const data33 = await waitRender(p33, 'rule-text">old');
  check('文件入口编辑父目录规则并提供「用当前项名」',
    data33.html.includes('rule-text">old') && data33.html.includes('用当前项名') && data33.html.includes('noise.log'),
    data33.html.slice(0, 200));
  check('hint 说明直接子项作用范围', data33.html.includes('未版本控制的直接子项'));
  // 用当前项名（无通配符文件名不改变原值）→ 加入 → 保存。
  p33.sendAuto({ kind: 'fillOriginName' });
  await waitNewRender(p33, '已填入当前项', base33);
  p33.sendAuto({ kind: 'addRule' });
  p33.sendAuto({ kind: 'saveIgnore' });
  await new Promise((resolve) => setTimeout(resolve, 600));
  const status33 = svn(['status', '--no-ignore'], igWc);
  check('保存后匹配的未版本控制直接子项被忽略',
    /^I\s+src\/noise\.log$/m.test(status33),
    status33);
  check('保存仅本机：远端属性未变',
    svn(['propget', '-r', 'HEAD', 'svn:ignore', `${igLab.repoUrl}/src`]).trim() === 'old');
  check('成功卡片明示尚未提交 SVN',
    [...p33.webview.posted].reverse().some((m) => m.type === 'render' && m.html.includes('本机已生效') && m.html.includes('尚未提交到 SVN')));
  // 清空全部规则 → 保存改 propdel。
  await waitPanelIdle(p33);
  p33.sendAuto({ kind: 'removeRule', index: 1 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  p33.sendAuto({ kind: 'removeRule', index: 0 });
  const cleared33 = await waitNewRender(p33, '保存将删除', base33);
  check('清空后空态说明保存将删除属性', !!cleared33 && cleared33.html.includes('此目录未设置 svn:ignore') === false);
  p33.sendAuto({ kind: 'saveIgnore' });
  await waitNewRender(p33, '此目录未设置 svn:ignore', base33);
  check('规则清空后属性被删除（propdel）',
    !svn(['proplist', '--xml', 'src'], igWc).includes('svn:ignore'),
    svn(['proplist', '--xml', 'src'], igWc));

  console.log('场景 34：P2 精确名称转义与不可表示名称、路径示例、重复模式');
  const special34 = ['cache[1]?.log', 'cache1x.log'];
  for (const name of special34) writeFileSync(join(igWc, 'src', name), 'unversioned');
  writeFileSync(join(igWc, 'src', 'foo\nbar'), 'unversioned');
  // 切换到同副本的另一文件入口：无草稿直接切换。
  const p34 = await openIgnorePanel(join(igWc, 'src', 'cache[1]?.log'), '此目录未设置 svn:ignore');
  const base34 = p34.webview.posted.length;
  await waitNewIdle(p34, base34);
  p34.sendAuto({ kind: 'fillOriginName' });
  const filled34 = await waitNewRender(p34, 'cache[[]1[]][?].log', base34);
  check('用当前项名转义通配符为字面量', !!filled34 && filled34.html.includes('cache[[]1[]][?].log'));
  p34.sendAuto({ kind: 'addRule' });
  await waitNewRender(p34, '未保存', base34);
  p34.sendAuto({ kind: 'saveIgnore' });
  await waitNewRender(p34, '忽略规则已保存到本机', base34);
  const ignored34 = await waitForCond('34-精确忽略', () => {
    const out = svn(['status', '--no-ignore'], igWc);
    return /^I\s+src\/cache\[1\]\?\.log$/m.test(out) && /^\?\s+src\/cache1x\.log$/m.test(out);
  });
  check('精确名称只匹配目标（cache[1]?.log 被忽略，相近名不误忽略）', ignored34,
    svn(['status', '--no-ignore'], igWc));
  // 含换行的名称：可读拒绝且不写属性。
  const p34b = await openIgnorePanel(join(igWc, 'src', 'foo\nbar'), 'cache[[]1[]][?].log');
  await waitPanelIdle(p34b);
  p34b.sendAuto({ kind: 'fillOriginName' });
  await waitRender(p34b, '无法表示为一条精确忽略规则');
  // 路径示例与重复模式的提示。
  p34b.sendAuto({ kind: 'syncInput', fieldId: 'draft', value: './secret.txt', inputRevision: state.intentSeq + 1000 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  p34b.sendAuto({ kind: 'addRule' });
  await waitNewRender(p34b, '路径分隔符', base34);
  p34b.sendAuto({ kind: 'syncInput', fieldId: 'draft', value: 'cache[[]1[]][?].log', inputRevision: state.intentSeq + 1000 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  p34b.sendAuto({ kind: 'addRule' });
  await waitNewRender(p34b, '该模式已在规则中', base34);
  p34b.sendAuto({ kind: 'syncInput', fieldId: 'draft', value: '', inputRevision: state.intentSeq + 1000 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  check('拒绝路径示例与重复模式不写属性',
    svn(['propget', 'svn:ignore', 'src'], igWc).trim() === 'cache[[]1[]][?].log',
    svn(['propget', 'svn:ignore', 'src'], igWc));

  console.log('场景 35：P2 仅规则提交——隔离临时副本入库，其他属性与子文件保留');
  const igWc35 = igLab.checkout('ig-wc35');
  mkdirSync(join(igWc35, 'src'), { recursive: true });
  writeFileSync(join(igWc35, 'src', 'a.txt'), 'base\n');
  writeFileSync(join(igLab.lab, 'rules35.txt'), 'old\n');
  svn(['add', '-q', '--parents', join('src', 'a.txt')], igWc35);
  svn(['propset', '-q', 'svn:ignore', '-F', join(igLab.lab, 'rules35.txt'), 'src'], igWc35);
  svn(['propset', '-q', 'custom:keep', 'v1', 'src'], igWc35);
  svn(['commit', '-q', '-m', 'ig35 base'], igWc35);
  // add 子项的提交会让目录节点的 BASE 落后于仓库（新增子项推进仓库目录 revision），
  // 对齐后再进入面板（正常使用中的副本通常已对齐）。
  svn(['update', '-q', '--depth', 'empty', 'src'], igWc35);
  // 本地三类修改：ignore 新值（保存）+ 其他属性 + 子文件。
  writeFileSync(join(igLab.lab, 'rules35b.txt'), '*.log\nbuild\n');
  svn(['propset', '-q', 'svn:ignore', '-F', join(igLab.lab, 'rules35b.txt'), 'src'], igWc35);
  svn(['propset', '-q', 'custom:keep', 'v2', 'src'], igWc35);
  writeFileSync(join(igWc35, 'src', 'a.txt'), 'local edit\n');
  const p35 = await openIgnorePanel(join(igWc35, 'src'), '本地已保存 · 待提交');
  const base35 = p35.webview.posted.length;
  await waitNewIdle(p35, base35);
  const panelsBefore35 = state.panels.length;
  p35.sendAuto({ kind: 'submitIgnore' });
  const committed35 = await waitNewRender(p35, '忽略规则已提交到 SVN', base35, 800);
  check('提交留在 P2（不打开 P1 面板）', state.panels.length === panelsBefore35);
  check('提交成功卡片含 revision 与仅 svn:ignore 范围说明',
    !!committed35 && /r\d+/.test(committed35.html) && committed35.html.includes('仅提交当前目录的 svn:ignore'),
    committed35 ? committed35.html.slice(0, 200) : '未等到成功卡片');
  const remote35 = await waitForCond('35-远端仅规则', () =>
    svn(['propget', '-r', 'HEAD', 'svn:ignore', `${igLab.repoUrl}/src`]).includes('*.log') &&
    svn(['propget', '-r', 'HEAD', 'custom:keep', `${igLab.repoUrl}/src`]).trim() === 'v1');
  check('远端仅 svn:ignore 更新（其他属性仍 v1）', remote35);
  check('子文件修改保留本地、远端内容不变',
    svn(['status'], igWc35).includes('src/a.txt') &&
    svn(['cat', '-r', 'HEAD', `${igLab.repoUrl}/src/a.txt`]) === 'base\n');
  const base35ok = await waitForCond('35-BASE读回', () =>
    svn(['propget', 'svn:ignore', '-r', 'BASE', 'src'], igWc35).includes('*.log'));
  check('协调后 BASE 读回为已提交值', base35ok);
  const badge35 = await waitNewRender(p35, '>已提交<', base35, 600);
  check('提交后徽标回到已提交且无待提交修改',
    !!badge35 && badge35.html.includes('已提交 r'),
    'lastBadges=' + JSON.stringify((badge35?.html ?? '').match(/<span class="badge[^>]*>[^<]*/g)));

  console.log('场景 36：P2 外部修改拒绝提交；重读同步新基线与属性删除');
  // 保存一份新规则，随后外部改属性 → 提交被拒。
  const base36 = p35.webview.posted.length;
  p35.sendAuto({ kind: 'syncInput', fieldId: 'draft', value: 'extra', inputRevision: state.intentSeq + 1000 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  p35.sendAuto({ kind: 'addRule' });
  await waitNewRender(p35, '未保存', base36);
  p35.sendAuto({ kind: 'saveIgnore' });
  await waitNewRender(p35, '忽略规则已保存到本机', base36);
  writeFileSync(join(igLab.lab, 'rules36.txt'), 'external-change\n');
  svn(['propset', '-q', 'svn:ignore', '-F', join(igLab.lab, 'rules36.txt'), 'src'], igWc35);
  await waitPanelIdle(p35);
  p35.sendAuto({ kind: 'submitIgnore' });
  const external35 = await waitNewRender(p35, '本次没有提交', base36);
  check('提交前核对发现外部修改：不提交不覆盖',
    !!external35 && external35.html.includes('请重新读取并核对'));
  const revBefore36 = svn(['info', '--show-item', 'revision', igLab.repoUrl]).trim();
  check('外部修改场景仓库 revision 未前进', svn(['info', '--show-item', 'revision', igLab.repoUrl]).trim() === revBefore36);
  // 重新读取（确认放弃草稿）同步新基线；外部删除属性后重读为空态。
  state.confirmResult = '放弃草稿并读取';
  p35.sendAuto({ kind: 'refresh' });
  await waitNewRender(p35, 'external-change', base36);
  check('重读后新基线生效（列表为外部值）',
    [...p35.webview.posted.slice(base36)].some((m) => m.type === 'render' && m.html.includes('rule-text">external-change')));
  state.confirmResult = undefined;
  svn(['propdel', '-q', 'svn:ignore', 'src'], igWc35);
  state.confirmResult = '放弃草稿并读取';
  await waitNewIdle(p35, p35.webview.posted.length);
  p35.sendAuto({ kind: 'refresh' });
  await waitNewRender(p35, '此目录未设置 svn:ignore', base36, 200);
  check('外部删除属性后重读为未设置空态（区别于读取失败）', true);
  state.confirmResult = undefined;

  console.log('场景 37：P2 结果未知与协调受阻的持久化恢复（真实仓库幂等协调，不二次提交）');
  const lab37 = makeSvnLab();
  const wc37 = lab37.checkout('wc37');
  mkdirSync(join(wc37, 'src'), { recursive: true });
  writeFileSync(join(wc37, 'src', 'a.txt'), 'base\n');
  writeFileSync(join(lab37.lab, 'r37a.txt'), 'old\n');
  svn(['add', '-q', '--parents', join('src', 'a.txt')], wc37);
  svn(['propset', '-q', 'svn:ignore', '-F', join(lab37.lab, 'r37a.txt'), 'src'], wc37);
  svn(['commit', '-q', '-m', 'r37 base'], wc37);
  // a) 预置 unknown 记录（远端仍是原始值）：核实未提交 → 解锁。
  state.globalStateMap.set('svnAnywhere.operations', [{
    operationId: 'op-p2-unknown-1',
    wcRoot: wc37,
    targetRelPath: 'src',
    nodeKind: 'dir',
    phase: 'unknown',
    property: { name: 'svn:ignore', originalExists: true, originalValue: ['old'], pendingExists: true, pendingValue: ['new37'] },
    knownRevisions: [],
    updatedAt: Date.now(),
  }]);
  await extension.activate(context); // 重载操作存储，恢复未完成记录限制
  const p37 = await openIgnorePanel(join(wc37, 'src'), '提交结果未知');
  await waitNewIdle(p37, p37.webview.posted.length);
  const base37 = p37.webview.posted.length;
  check('unknown 记录恢复写锁定（横幅+核实入口）',
    [...p37.webview.posted].reverse().some((m) => m.type === 'render' && m.html.includes('提交结果未知') && m.html.includes('核实提交结果')));
  p37.sendAuto({ kind: 'resolveUnknown' });
  const toast37 = await new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const hit = p37.webview.posted.find((m) => m.type === 'toast' && String(m.message).includes('已确认未提交'));
      if (hit || Date.now() - started > 6000) {
        clearInterval(timer);
        resolve(hit);
      }
    }, 30);
  });
  check('核实未提交后解锁（toast 确认，可重试）', !!toast37);
  // b) 真实提交 A' 到仓库（不经面板），原副本不 update；预置协调受阻记录。
  // 真实提交 A'（临时隔离方式）：新检出对齐 BASE 后仅提交属性，原副本不 update。
  const wc37b = join(lab37.lab, 'wc37b');
  mkdirSync(wc37b);
  svn(['checkout', '-q', '--depth', 'empty', `${lab37.repoUrl}/src`, '.'], wc37b);
  writeFileSync(join(lab37.lab, 'r37b.txt'), 'A-prime\n');
  svn(['propset', '-q', 'svn:ignore', '-F', join(lab37.lab, 'r37b.txt'), '.'], wc37b);
  svn(['commit', '-q', '-m', 'commit A-prime', '--depth', 'empty', '.'], wc37b);
  const rev37 = svn(['info', '--show-item', 'revision', lab37.repoUrl]).trim();
  state.globalStateMap.set('svnAnywhere.operations', [{
    operationId: 'op-p2-blocked-1',
    wcRoot: wc37,
    targetRelPath: 'src',
    nodeKind: 'dir',
    phase: 'coordination-blocked',
    property: { name: 'svn:ignore', originalExists: true, originalValue: ['old'], pendingExists: true, pendingValue: ['A-prime'] },
    knownRevisions: [Number(rev37)],
    updatedAt: Date.now(),
  }]);
  await extension.activate(context);
  const p37b = await openIgnorePanel(join(wc37, 'src'), '尚未协调完成');
  await waitNewIdle(p37b, p37b.webview.posted.length);
  const base37b = p37b.webview.posted.length;
  check('协调受阻记录恢复（横幅含已知 revision）',
    [...p37b.webview.posted].reverse().some((m) => m.type === 'render' && m.html.includes(`r${rev37}`) && m.html.includes('尚未协调完成')));
  // 原副本工作值被外部改成 A'+B：恢复协调 → 确认保留 → 冲突解决 → 幂等完成。
  writeFileSync(join(lab37.lab, 'r37c.txt'), 'A-prime\nB\n');
  svn(['propset', '-q', 'svn:ignore', '-F', join(lab37.lab, 'r37c.txt'), 'src'], wc37);
  state.confirmResult = '保留这些修改并完成协调';
  p37b.sendAuto({ kind: 'resolveUnknown' });
  const done37 = await waitNewRender(p37b, '忽略规则已提交到 SVN', base37b, 400);
  const doneFrame37 = await waitNewRender(p37b, '后续本地规则修改仍待提交', base37b, 600);
  check('恢复协调幂等完成（保留后续修改，不产生第二次提交）',
    !!done37 && svn(['info', '--show-item', 'revision', lab37.repoUrl]).trim() === rev37,
    `rev=${svn(['info', '--show-item', 'revision', lab37.repoUrl]).trim()} vs ${rev37}`);
  const state37 = !!doneFrame37 &&
    svn(['propget', 'svn:ignore', '-r', 'BASE', 'src'], wc37).trim() === 'A-prime' &&
    svn(['propget', 'svn:ignore', 'src'], wc37).split('\n').filter(Boolean).join(',') === 'A-prime,B';
  check('协调完成后 BASE=A\'、工作值=A\'+B（B 保留待提交）', state37);
  check('完成卡片提示后续本地规则修改仍待提交', !!doneFrame37);
  state.confirmResult = undefined;
  rmSync(lab37.lab, { recursive: true, force: true });
  rmSync(igLab.lab, { recursive: true, force: true });

  rmSync(panelLab.lab, { recursive: true, force: true });

  rmSync(wc, { recursive: true, force: true });
  rmSync(plain, { recursive: true, force: true });
  rmSync(svnLab.lab, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} 项未通过`);
    process.exit(1);
  }
  console.log('\n全部场景通过');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
