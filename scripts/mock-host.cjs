/**
 * mock 宿主验证脚本：拦截 require('vscode')，加载打包产物 out/extension.js，
 * 直接驱动 activate 与注册的命令 handler。除命令骨架场景外，
 * 还用本地 svnadmin + file:// 临时副本驱动真实的更新/状态/清理命令链路。
 * 用法：`pnpm run mock-host`（先构建再运行）。任一场景失败退出码为 1。
 */
const { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync, existsSync, readFileSync, symlinkSync, statSync, readdirSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');

const state = {
  information: [],
  warning: [],
  openDialogCalls: 0,
  /** showOpenDialog 选项记录（断言 canSelectFolders 等参数形态）。 */
  openDialogOptions: [],
  /** showOpenDialog 选中结果（undefined 表示取消）。 */
  openDialogResult: undefined,
  channels: [],
  registered: new Map(),
  activeCommandIds: new Set(),
  disposables: [],
  /** 模态确认框（更新确认）返回的按钮；undefined 表示用户取消。 */
  confirmResult: undefined,
  /** 非模态警告消息（如冲突提示）按钮点击结果；undefined 表示未点击。 */
  warningChoice: undefined,
  /** 警告挂起门：'hold' 时带按钮的非模态警告返回挂起 promise（模拟用户未处理通知）。 */
  warningGate: 'off',
  warningGateResolvers: [],
  progressTitles: [],
  /** 提交说明输入框返回值。 */
  inputResult: undefined,
  /** InputBox 输入队列（逐个弹出，优先于 inputResult；元素 undefined 表示该次取消）。 */
  inputQueue: [],
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
  /** getConfiguration 覆盖项（按场景注入，如 svnPath 指向包装脚本）。 */
  configOverrides: undefined,
  /** 全部频道的追加式写入序列（分频道后保持 channelText() 的追加语义）。 */
  allLines: [],
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
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  window: {
    createOutputChannel(title) {
      const ch = {
        title,
        lines: [],
        shown: 0,
        appendLine(line) { ch.lines.push(line); state.allLines.push(line); },
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
    showWarningMessage(message, ...rest) {
      // 两种形态：模态确认框（第二参 { modal: true }，confirmResult 决定
      // 确认/取消）与带字符串按钮的非模态警告（如冲突提示，warningChoice
      // 决定点击结果）；无按钮消息返回 undefined。
      state.warning.push(message);
      const first = rest[0];
      const modalOpt = first && typeof first === 'object' && first.modal ? first : undefined;
      const items = modalOpt ? rest.slice(1) : rest;
      if (items.length === 0) {
        return Promise.resolve(undefined);
      }
      // 挂起门：模拟带按钮通知已弹出、用户尚未处理的窗口期。
      if (!modalOpt && state.warningGate === 'hold') {
        return new Promise((resolve) => state.warningGateResolvers.push(resolve));
      }
      return Promise.resolve(modalOpt ? state.confirmResult : state.warningChoice);
    },
    showErrorMessage(message) {
      state.warning.push(`[error] ${message}`);
      return Promise.resolve(undefined);
    },
    showOpenDialog(options) {
      state.openDialogCalls += 1;
      state.openDialogOptions.push(options);
      return Promise.resolve(state.openDialogResult);
    },
    withProgress(options, task) {
      state.progressTitles.push(options.title);
      return task({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) });
    },
    showInputBox() {
      // 队列优先：驱动「非法输入提示后重试」链路；元素 undefined 表示该次取消。
      if (state.inputQueue.length > 0) {
        return Promise.resolve(state.inputQueue.shift());
      }
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
      // state.configOverrides 可按场景覆盖配置项（如 svnPath 指向包装脚本）。
      return { get: (key, fallback) => (Object.prototype.hasOwnProperty.call(state.configOverrides ?? {}, key) ? state.configOverrides[key] : fallback) };
    },
    fs: {
      // 真实文件系统探查（冲突路径定位用）；不存在时抛错，与宿主语义一致。
      stat: async (uri) => {
        const st = statSync(uri.fsPath);
        return {
          type: st.isDirectory() ? 2 : st.isFile() ? 1 : 0,
          ctime: st.ctimeMs,
          mtime: st.mtimeMs,
          size: st.size,
        };
      },
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
  // 输出按操作域分频道后，各频道内容不再是全局追加式；用写入序列聚合，
  // 保持既有场景「slice(之前长度) 取本次增量」的断言语义。
  return state.allLines.join('\n');
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
  // 已销毁面板的帧索引不可比（重开是新面板、从 0 计数）：只以存活面板为基线。
  const panel0 = [...state.panels].reverse().find((p) => p.viewType === 'svn-anywhere-ignore' && !p.disposed);
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
  // 目标切换遇旧会话草稿会弹「放弃并切换」确认：本辅助代表用户已决定
  // 打开该目标，临时确认切换并恢复原值（无草稿时不弹、不受影响）。
  let panel;
  let render;
  const confirmBefore = state.confirmResult;
  state.confirmResult = '放弃并切换';
  try {
    for (let attempt = 0; attempt < 8 && !render; attempt += 1) {
      await state.registered.get('svnAnywhere.commit')({ fsPath: uriFsPath, scheme: 'file' });
      panel = [...state.panels].reverse().find((p) => p.viewType === 'svn-anywhere-commit');
      if (!panel) {
        throw new Error(`提交面板未创建（panels=${state.panels.length}）`);
      }
      panel.sendReady();
      render = await waitRender(panel, expectText, 20);
    }
  } finally {
    state.confirmResult = confirmBefore;
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
      // 与真实 Memento 语义一致：update(key, undefined) 删除键。
      update: async (key, value) => {
        if (value === undefined) {
          state.globalStateMap.delete(key);
        } else {
          state.globalStateMap.set(key, value);
        }
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
  state.inputQueue = ['HEAD'];
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

  console.log('场景 9：真实副本「清理」——模态确认后完成写频道');
  state.confirmResult = '清理';
  const linesBeforeCleanup = channelText().length;
  await state.registered.get('svnAnywhere.cleanup')({ fsPath: join(probe, 'a.txt'), scheme: 'file' });
  const cleanupOutput = channelText().slice(linesBeforeCleanup);
  check('确认框写明影响范围（svn cleanup 与目标）',
    state.warning.some((m) => m.includes('svn cleanup') && m.includes(probe)),
    JSON.stringify(state.warning.slice(-3)));
  check('频道写清理完成', cleanupOutput.includes('清理完成。'), cleanupOutput.slice(-300));
  state.confirmResult = undefined;

  console.log('场景 10：真实副本「更新」遇冲突——退出码为 0 仍要提示冲突');
  writeFileSync(join(remote, 'a.txt'), 'remote edit\n');
  svn(['commit', '-q', '-m', 'remote edit a'], remote);
  writeFileSync(join(probe, 'a.txt'), 'local edit\n');
  state.confirmResult = '更新';
  state.inputQueue = ['HEAD'];
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
  const panel11 = await openCommitPanel(probe2, 'data-row-id="b.txt"');
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
  const panel12 = await openCommitPanel(probe3, 'data-row-id="fresh.txt"');
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
  const panel13 = await openCommitPanel(probe3, 'data-row-id="drop.txt"');
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
  const base14 = panel14.webview.posted.length;
  const before14 = Number((panel14.webview.posted.filter((m) => m.type === 'render').at(-1) ?? {}).formRevision);
  panel14.sendAuto({ kind: 'addRule' });
  const afterAdd14 = await waitNewRender(panel14, '未保存', base14);
  check('加入后输入框被宿主清空（formRevision 前进，本地未确认输入不回退）',
    !!afterAdd14 && afterAdd14.formRevision > before14 && afterAdd14.formRevision >= 1000 && /value=""/.test(afterAdd14.html),
    `formRevision=${afterAdd14?.formRevision} before=${before14}`);
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

  console.log('场景 18b：预置陈旧记录与孤儿快照后 activate 返回即完成首载折算与清理');
  {
    // 陈旧记录（模拟上一进程被 kill 后遗留）：commit 的 committing → 折算 unknown；
    // update 的 prepared → 按 M1 可安全重跑移除；import 的 running → 折算 unknown 且保留。
    const staleRecords = [
      {
        operationId: 'op-stale-commit', wcRoot: '/mock/stale/wc-a', targetRelPath: '.',
        nodeKind: 'dir', kind: 'commit', phase: 'committing', knownRevisions: [], updatedAt: 900,
      },
      {
        operationId: 'op-stale-update', wcRoot: '/mock/stale/wc-b', targetRelPath: '.',
        nodeKind: 'dir', kind: 'update', phase: 'prepared', knownRevisions: [], updatedAt: 901,
      },
      {
        operationId: 'op-live-import', wcRoot: '/mock/stale/src', targetRelPath: '.',
        nodeKind: 'dir', kind: 'import', phase: 'running', knownRevisions: [], updatedAt: 902,
      },
    ];
    const previousRecords = state.globalStateMap.get('svnAnywhere.operations');
    state.globalStateMap.set(
      'svnAnywhere.operations',
      [...(Array.isArray(previousRecords) ? previousRecords : []), ...staleRecords],
    );
    // 快照文件：孤儿（无未终态记录对应）应删；未终态 import 的快照保留；
    // 不匹配识别形态（op- 命名 ∧ 快照 schema 双条件）的文件一律不动。
    const storageDir = makeTempDir('svn-anywhere-mock-storage-');
    const snapshotJson = JSON.stringify({ version: 1, entries: [], dirs: [] });
    writeFileSync(join(storageDir, 'op-orphan-dead'), snapshotJson);
    writeFileSync(join(storageDir, 'op-live-import'), snapshotJson);
    writeFileSync(join(storageDir, 'op-not-json'), 'not json at all');
    writeFileSync(join(storageDir, 'op-wrong-schema'), JSON.stringify({ hello: 'world' }));
    writeFileSync(join(storageDir, 'notes.txt'), 'unrelated');
    const thirdContext = {
      subscriptions: [],
      extensionUri: { scheme: 'file', path: '/mock-ext', toString: () => 'file:///mock-ext' },
      globalState: context.globalState,
      globalStorageUri: { scheme: 'file', path: storageDir, fsPath: storageDir, toString: () => `file://${storageDir}` },
    };
    await extension.activate(thirdContext);
    const folded = state.globalStateMap.get('svnAnywhere.operations') || [];
    const foldOf = (id) => (folded.find((r) => r.operationId === id) || {}).phase;
    check('activate 返回后 commit 的 committing 已折算 unknown', foldOf('op-stale-commit') === 'unknown',
      JSON.stringify(folded));
    check('activate 返回后 update 的 prepared 已按可重跑移除',
      !folded.some((r) => r.operationId === 'op-stale-update'));
    check('activate 返回后 import 的 running 已折算 unknown 且记录保留',
      foldOf('op-live-import') === 'unknown');
    check('孤儿快照（op- 命名 ∧ 快照 schema ∧ 无未终态记录）被删除',
      !existsSync(join(storageDir, 'op-orphan-dead')));
    check('未终态记录的快照不被误删', existsSync(join(storageDir, 'op-live-import')));
    check('op- 命名但非 JSON 的文件不动', existsSync(join(storageDir, 'op-not-json')));
    check('op- 命名但非快照 schema 的 JSON 不动', existsSync(join(storageDir, 'op-wrong-schema')));
    check('非 op- 命名的文件不动', existsSync(join(storageDir, 'notes.txt')));
    check('三次 activate 后命令注册集合仍与贡献点一致', state.registered.size === expectedIds.length);
    rmSync(storageDir, { recursive: true, force: true });
  }

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
  const panel19 = await openCommitPanel(join(nestedWc, 'src'), 'data-row-id="src/item.txt"');
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
  const panel21 = await openCommitPanel(specialWc, 'data-row-id="foo&amp;#10;bar"');
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
  const panel22 = await openCommitPanel(specialWc, 'data-row-id="a@1"');
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
  const panel = await openCommitPanel(panelWc, 'data-row-id="src/core/a.txt"');
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
  const panel26 = await openCommitPanel(actWc, 'data-row-id="revert.txt"');
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
  const panel26b = await openCommitPanel(actWc, 'data-row-id="trash-me.txt"');
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
  const panel27 = await openCommitPanel(clWc, 'data-row-id="plain.txt"');
  const data27 = await waitRender(panel27, 'changelist');
  // 分组条目与未分组条目都在面板上，changelist 徽标按原值。
  check('changelist 容器条目与未分组条目同时出现',
    data27.html.includes('data-row-id="all.txt"') &&
    data27.html.includes('data-row-id="none.txt"') &&
    data27.html.includes('data-row-id="plain.txt"'));
  // 筛选真实组名 all：编码值 name:all 与哨兵不冲突。
  // 上一目标的慢重读（file:// status -u）可能让面板长时间 busy、切换被拒
  // 或短暂停留在旧目标：等待循环检测最新帧不是本目标时重新驱动命令
  // （等价用户再点一次「提交」），而不是只靠固定次数重试。重驱与
  // openCommitPanel 同口径临时确认「放弃并切换」——旧会话勾选有变化时
  // 不确认会被取消，面板卡在旧目标使本场景必然失败。
  await waitPanelIdle(panel27);
  let filtered27;
  for (let attempt = 0; attempt < 10 && !filtered27; attempt += 1) {
    const latest27 = [...panel27.webview.posted].reverse().find((m) => m.type === 'render');
    if (latest27 && !String(latest27.html).includes('cl-wc')) {
      const confirmBefore27 = state.confirmResult;
      state.confirmResult = '放弃并切换';
      try {
        await state.registered.get('svnAnywhere.commit')({ fsPath: clWc, scheme: 'file' });
      } finally {
        state.confirmResult = confirmBefore27;
      }
      await waitNewRender(panel27, 'data-row-id="plain.txt"', panel27.webview.posted.length, 150);
    }
    panel27.sendAuto({ kind: 'setFilter', filterId: 'changelist', value: 'name:all' });
    for (let retry = 0; retry < 100; retry += 1) {
      filtered27 = [...panel27.webview.posted].reverse().find(
        (m) => m.type === 'render' && m.html.includes('data-row-id="all.txt"') && m.html.includes('显示 1 / 3 项'),
      );
      if (filtered27) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await waitPanelIdle(panel27, 100);
  }
  check('真实组名 all 的筛选不与哨兵冲突（只显示 all.txt，全局选择保留）',
    !!filtered27 && filtered27.html.includes('data-row-id="all.txt"') && !filtered27.html.includes('data-row-id="plain.txt"'),
    filtered27 ? filtered27.html.slice(0, 300) : `未等到筛选帧；尾部帧=${JSON.stringify(panel27.webview.posted.slice(-8).map((m) => m.type === 'render' ? ['render', String(m.sessionId).slice(0, 5), 'busy=' + (m.html.includes('data-busy="1"') ? 1 : 0), (m.html.match(/显示 [^<]*/g) ?? []).slice(-1)[0] ?? '', m.html.includes('cl-wc') ? 'T=cl-wc' : m.html.includes('act-wc') ? 'T=act-wc' : 'T=?', (m.html.match(/data-row-id="[^"]{0,30}/g) ?? []).slice(0, 5).join(',')] : [m.type, String(m.message ?? '').slice(0, 40)]))}`);
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
  const panel28 = await openCommitPanel(dirWc, 'data-row-id="newdir"');
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
  const panel29 = await openCommitPanel(batchWc, 'data-row-id="batch/f000.txt"');
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
  const panel30 = await openCommitPanel(partialWc, 'data-row-id="batch/f119.txt"');
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
  state.inputQueue = ['HEAD'];
  await state.registered.get('svnAnywhere.update')({ fsPath: extMain, scheme: 'file' });
  state.confirmResult = undefined;
  // 外部副本内产生修改 + 主副本修改。
  writeFileSync(join(extMain, 'vendor', 'shared.txt'), 'shared changed in external\n');
  writeFileSync(join(extMain, 'main.txt'), 'main changed\n');
  const panel31 = await openCommitPanel(extMain, 'data-row-id="main.txt"');
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
  // 嵌套子目录随基线纳管：保存后验证父目录规则只作用于直接子项，
  // 不递归隐藏子目录内的同名未版本控制项（非递归语义）。
  mkdirSync(join(igWc, 'src', 'sub'), { recursive: true });
  svn(['add', '-q', join('src', 'sub')], igWc);
  svn(['propset', '-q', 'svn:ignore', '-F', join(igLab.lab, 'rules-old.txt'), 'src'], igWc);
  svn(['propset', '-q', 'custom:keep', 'v1', 'src'], igWc);
  svn(['commit', '-q', '-m', 'ig base'], igWc);
  writeFileSync(join(igWc, 'src', 'noise.log'), 'log');
  writeFileSync(join(igWc, 'src', 'keep.log'), 'log');
  // 与被忽略直接子项同名的嵌套未版本控制项：验证规则不递归作用。
  writeFileSync(join(igWc, 'src', 'sub', 'noise.log'), 'log');
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
  check('已版本控制子项不受忽略规则影响（src/.keep 无状态条目）',
    !status33.includes('src/.keep'),
    status33);
  check('不匹配规则的直接子项保持未版本控制（未被 I 隐藏）',
    /^\?\s+src\/keep\.log$/m.test(status33) && !/^I\s+src\/keep\.log$/m.test(status33),
    status33);
  check('嵌套子目录内同名未版本控制项不被父目录规则误隐藏（保持 ? 而非 I）',
    /^\?\s+src\/sub\/noise\.log$/m.test(status33) && !/^I\s+src\/sub\/noise\.log$/m.test(status33),
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
  // 重启前工作副本已有额外本地修改（工作值两条，记录里的待提交值只有一条）：
  // 核实未提交解锁后须按真实工作值与 BASE 重算，保留「待提交」而非「无修改」。
  writeFileSync(join(lab37.lab, 'r37d.txt'), 'new37\nextra37\n');
  svn(['propset', '-q', 'svn:ignore', '-F', join(lab37.lab, 'r37d.txt'), 'src'], wc37);
  // 重启恢复后视图点的是横幅按钮：真实消息为 bannerAction（不是内部
  // resolveUnknown），宿主写锁须按 actionId 放行，否则按钮会被拒绝。
  p37.sendAuto({ kind: 'bannerAction', bannerId: 'unknown', actionId: 'resolveUnknown' });
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
  const pendingFrame37 = await waitNewRender(p37, '本地已保存 · 待提交', base37, 300);
  check('核实未提交后按真实工作值重算待提交状态（不显示无修改）',
    !!pendingFrame37 && !pendingFrame37.html.includes('规则列表无修改')
      && !/data-intent="submitIgnore"[^>]*disabled/.test(pendingFrame37.html),
    pendingFrame37 ? '' : '解锁后未出现待提交帧');
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
  // 同口径：协调受阻横幅的「恢复协调」按钮也是 bannerAction。
  p37b.sendAuto({ kind: 'bannerAction', bannerId: 'reconcile', actionId: 'resolveUnknown' });
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

  console.log('场景 38：右键「添加」——未版本控制文件与深层目录 --parents 补齐上级');
  const lab38 = makeSvnLab();
  const wc38 = lab38.checkout('wc38');
  writeFileSync(join(wc38, 'base.txt'), 'base\n');
  svn(['add', '-q', '--parents', 'base.txt'], wc38);
  svn(['commit', '-q', '-m', 'init'], wc38);
  writeFileSync(join(wc38, 'fresh.txt'), 'fresh\n');
  await state.registered.get('svnAnywhere.add')({ fsPath: join(wc38, 'fresh.txt'), scheme: 'file' });
  check('未版本控制文件登记 A', svn(['status'], wc38).includes('A       fresh.txt'));
  check('提示含已登记添加', state.information.some((m) => m.includes('fresh.txt')));
  mkdirSync(join(wc38, 'deep/inner'), { recursive: true });
  writeFileSync(join(wc38, 'deep/inner/n.txt'), 'n\n');
  await state.registered.get('svnAnywhere.add')({ fsPath: join(wc38, 'deep/inner/n.txt'), scheme: 'file' });
  const status38 = svn(['status'], wc38);
  check('深层路径 --parents 补齐未纳管上级',
    status38.includes('A       deep') && status38.includes('A       deep/inner') && status38.includes('A       deep/inner/n.txt'),
    status38);
  // 已版本控制目标：提示且不执行。
  const linesBefore38 = channelText().length;
  await state.registered.get('svnAnywhere.add')({ fsPath: join(wc38, 'base.txt'), scheme: 'file' });
  check('已版本控制目标提示不执行', state.information.some((m) => m.includes('已在版本控制')) &&
    !channelText().slice(linesBefore38).includes('> svn add'));
  rmSync(lab38.lab, { recursive: true, force: true });

  console.log('场景 39：右键「删除」——确认框写明影响范围与不可逆，默认同时删除本地');
  const lab39 = makeSvnLab();
  const wc39 = lab39.checkout('wc39');
  mkdirSync(join(wc39, 'tree/inner'), { recursive: true });
  writeFileSync(join(wc39, 'tree/inner/f.txt'), 'v1\n');
  writeFileSync(join(wc39, 'tree/g.txt'), 'v1\n');
  writeFileSync(join(wc39, 'mod.txt'), 'v1\n');
  svn(['add', '-q', '--parents', 'tree/inner/f.txt', 'tree/g.txt', 'mod.txt'], wc39);
  svn(['commit', '-q', '-m', 'init'], wc39);
  writeFileSync(join(wc39, 'mod.txt'), 'v2\n');
  // 取消：不执行。
  state.confirmResult = undefined;
  await state.registered.get('svnAnywhere.delete')({ fsPath: join(wc39, 'mod.txt'), scheme: 'file' });
  check('取消确认不删除', existsSync(join(wc39, 'mod.txt')) && !svn(['status'], wc39).includes('D'));
  state.confirmResult = '删除';
  const warningBefore39 = state.warning.length;
  await state.registered.get('svnAnywhere.delete')({ fsPath: join(wc39, 'mod.txt'), scheme: 'file' });
  const confirm39 = state.warning.slice(warningBefore39).find((m) => m.includes('mod.txt'));
  check('确认框写明删除本地文件并登记 SVN 删除', !!confirm39 && confirm39.includes('删除本地文件并登记 SVN 删除'),
    String(confirm39).slice(0, 200));
  check('确认框含不可逆说明', !!confirm39 && confirm39.includes('无法从工作副本直接撤销'));
  check('本地有修改的文件经 --force 删除并登记', !existsSync(join(wc39, 'mod.txt')) &&
    svn(['status'], wc39).includes('D       mod.txt'));
  await state.registered.get('svnAnywhere.delete')({ fsPath: join(wc39, 'tree'), scheme: 'file' });
  const confirmDir = state.warning.slice(warningBefore39).find((m) => m.includes('tree/g.txt'));
  check('目录确认枚举完整影响子树', !!confirmDir && confirmDir.includes('tree/inner/f.txt'),
    String(confirmDir).slice(0, 300));
  check('目录默认本地删除', !existsSync(join(wc39, 'tree')) && svn(['status'], wc39).includes('D       tree'));
  writeFileSync(join(wc39, 'u.txt'), 'u\n');
  await state.registered.get('svnAnywhere.delete')({ fsPath: join(wc39, 'u.txt'), scheme: 'file' });
  check('未版本控制目标不走 SVN 删除', state.information.some((m) => m.includes('未纳入版本控制')) &&
    existsSync(join(wc39, 'u.txt')));
  state.confirmResult = undefined;
  rmSync(lab39.lab, { recursive: true, force: true });

  console.log('场景 40：右键「还原」——确认列出文件数量与路径，单文件与整目录递归');
  const lab40 = makeSvnLab();
  const wc40 = lab40.checkout('wc40');
  mkdirSync(join(wc40, 'tree/inner'), { recursive: true });
  writeFileSync(join(wc40, 'tree/inner/f.txt'), 'v1\n');
  writeFileSync(join(wc40, 'mod.txt'), 'v1\n');
  svn(['add', '-q', '--parents', 'tree/inner/f.txt', 'mod.txt'], wc40);
  svn(['commit', '-q', '-m', 'init'], wc40);
  writeFileSync(join(wc40, 'tree/inner/f.txt'), 'v2\n');
  svn(['propset', '-q', 'svn:ignore', 'zzz', 'tree'], wc40);
  state.confirmResult = '还原';
  const warningBefore40 = state.warning.length;
  await state.registered.get('svnAnywhere.revert')({ fsPath: join(wc40, 'tree'), scheme: 'file' });
  const confirm40 = state.warning.slice(warningBefore40).find((m) => m.includes('tree'));
  check('确认框列出数量（2 个路径：目录属性+子文件）', !!confirm40 && confirm40.includes('2 个路径'),
    String(confirm40).slice(0, 300));
  check('确认框列出路径清单', !!confirm40 && confirm40.includes('tree/inner/f.txt'));
  check('确认框含不可逆说明', !!confirm40 && confirm40.includes('无法找回'));
  check('目录递归还原后 status 干净', svn(['status'], wc40).trim() === '', svn(['status'], wc40));
  writeFileSync(join(wc40, 'mod.txt'), 'v3\n');
  state.confirmResult = undefined;
  await state.registered.get('svnAnywhere.revert')({ fsPath: join(wc40, 'mod.txt'), scheme: 'file' });
  check('取消确认保留本地修改', readFileSync(join(wc40, 'mod.txt'), 'utf8') === 'v3\n');
  state.confirmResult = '还原';
  await state.registered.get('svnAnywhere.revert')({ fsPath: join(wc40, 'mod.txt'), scheme: 'file' });
  check('单文件确认还原', readFileSync(join(wc40, 'mod.txt'), 'utf8') === 'v1\n');
  await state.registered.get('svnAnywhere.revert')({ fsPath: join(wc40, 'mod.txt'), scheme: 'file' });
  check('无修改时提示无可还原', state.information.some((m) => m.includes('没有可还原')));

  // externals 边界：svn revert -R 不跨 external，目录递归还原的确认清单
  // 须隔离 external 内部条目（status 会递归列出）。
  const lab40e = makeSvnLab();
  execFileSync('svn', ['mkdir', '-q', '-m', 'ext base', `${lab40e.repoUrl}/ext-src`]);
  const extHost40 = lab40e.checkout('ext-host40', 'ext-src');
  writeFileSync(join(extHost40, 's.txt'), 'v1');
  svn(['add', '-q', 's.txt'], extHost40);
  svn(['commit', '-q', '-m', 'ext init'], extHost40);
  const main40e = lab40e.checkout('main40e');
  writeFileSync(join(main40e, 'a.txt'), 'v1');
  svn(['add', '-q', 'a.txt'], main40e);
  writeFileSync(join(main40e, '.svn', 'ext-def.tmp'), `vendor ${lab40e.repoUrl}/ext-src\n`);
  svn(['propset', '-q', 'svn:externals', '-F', join(main40e, '.svn', 'ext-def.tmp'), '.'], main40e);
  rmSync(join(main40e, '.svn', 'ext-def.tmp'));
  svn(['commit', '-q', '-m', 'init with externals'], main40e);
  state.confirmResult = '更新';
  state.inputQueue = ['HEAD'];
  await state.registered.get('svnAnywhere.update')({ fsPath: main40e, scheme: 'file' });
  writeFileSync(join(main40e, 'vendor', 's.txt'), 'v2 in external');
  writeFileSync(join(main40e, 'a.txt'), 'v2 main');
  state.confirmResult = '还原';
  const warningBefore40e = state.warning.length;
  await state.registered.get('svnAnywhere.revert')({ fsPath: main40e, scheme: 'file' });
  const confirm40e = state.warning.slice(warningBefore40e).find((m) => m.includes('a.txt'));
  check('目录递归还原清单隔离 external 内条目（计数只含主副本）',
    !!confirm40e && confirm40e.includes('1 个路径') && !confirm40e.includes('vendor/s.txt'),
    String(confirm40e).slice(0, 300));
  check('还原后 external 内修改保留（svn revert -R 不跨 external）',
    readFileSync(join(main40e, 'a.txt'), 'utf8') === 'v1' &&
    readFileSync(join(main40e, 'vendor', 's.txt'), 'utf8') === 'v2 in external');
  await state.registered.get('svnAnywhere.revert')({ fsPath: join(main40e, 'vendor', 's.txt'), scheme: 'file' });
  check('明确选中 external 内文件时 svn revert 作用于该副本',
    readFileSync(join(main40e, 'vendor', 's.txt'), 'utf8') === 'v1');
  state.confirmResult = undefined;
  rmSync(lab40.lab, { recursive: true, force: true });
  rmSync(lab40e.lab, { recursive: true, force: true });

  console.log('场景 41：右键「移动」——svn move 保留历史；文件系统移动检测提示');
  const lab41 = makeSvnLab();
  const wc41 = lab41.checkout('wc41');
  writeFileSync(join(wc41, 'a.txt'), 'v1\n');
  writeFileSync(join(wc41, 'b.txt'), 'v1\n');
  svn(['add', '-q', '--parents', 'a.txt', 'b.txt'], wc41);
  svn(['commit', '-q', '-m', 'init'], wc41);
  state.inputResult = join(wc41, 'renamed.txt');
  await state.registered.get('svnAnywhere.move')({ fsPath: join(wc41, 'a.txt'), scheme: 'file' });
  const status41 = svn(['status'], wc41);
  check('svn move 登记 D+A+（保留历史标记）',
    status41.includes('D       a.txt') && /A\s+\+\s+renamed\.txt/.test(status41), status41);
  svn(['commit', '-q', '-m', 'rename a'], wc41);
  check('提交后仓库记录改名来源', svn(['log', '--verbose', '-r', 'HEAD'], wc41).includes('(from /a.txt:'));
  // 目标已存在：提示并终止。
  state.inputResult = join(wc41, 'b.txt');
  const linesBefore41 = channelText().length;
  await state.registered.get('svnAnywhere.move')({ fsPath: join(wc41, 'renamed.txt'), scheme: 'file' });
  check('目标已存在拒绝并终止', state.information.some((m) => m.includes('已存在')) &&
    !channelText().slice(linesBefore41).includes('> svn move'));
  // 文件系统移动检测：源 missing 时提示改用 svn move。
  state.inputResult = undefined;
  const fs = require('node:fs');
  fs.renameSync(join(wc41, 'b.txt'), join(wc41, 'b-moved-elsewhere.txt'));
  const warningBefore41 = state.warning.length;
  await state.registered.get('svnAnywhere.move')({ fsPath: join(wc41, 'b.txt'), scheme: 'file' });
  const hint41 = state.warning.slice(warningBefore41).find((m) => m.includes('b.txt'));
  check('文件系统移动检测：提示移回原位置后用 svn move',
    !!hint41 && hint41.includes('移回原位置') && hint41.includes('保留历史'), String(hint41).slice(0, 300));
  fs.renameSync(join(wc41, 'b-moved-elsewhere.txt'), join(wc41, 'b.txt'));
  rmSync(lab41.lab, { recursive: true, force: true });

  console.log('场景 42：右键「在 Finder 中显示」转发 revealFileInOS；命令面板回退活动编辑器');
  const executedBefore42 = state.executedCommands.length;
  await state.registered.get('svnAnywhere.revealInFinder')({ fsPath: '/tmp/svn-anywhere-reveal-target.txt', scheme: 'file' });
  check('右键路径直接转发 revealFileInOS',
    state.executedCommands.slice(executedBefore42).some(([cmd, uri]) =>
      cmd === 'revealFileInOS' && uri && uri.fsPath === '/tmp/svn-anywhere-reveal-target.txt'),
    JSON.stringify(state.executedCommands.slice(executedBefore42)));
  await state.registered.get('svnAnywhere.revealInFinder')(undefined);
  check('无 uri 且无活动编辑器时静默返回（不转发）',
    state.executedCommands.length === executedBefore42 + 1);

  console.log('场景 43：右键「更新」输入指定版本号——-r 生效，svn info 显示目标版本');
  const lab43 = makeSvnLab();
  const base43 = lab43.checkout('base43');
  writeFileSync(join(base43, 'a.txt'), 'v1\n');
  svn(['add', '-q', '--parents', 'a.txt'], base43);
  svn(['commit', '-q', '-m', 'r1'], base43);
  const other43 = lab43.checkout('other43');
  writeFileSync(join(other43, 'a.txt'), 'v2\n');
  svn(['commit', '-q', '-m', 'r2'], other43);
  state.confirmResult = '更新';
  state.inputQueue = ['1'];
  const linesBefore43 = channelText().length;
  await state.registered.get('svnAnywhere.update')({ fsPath: base43, scheme: 'file' });
  const out43 = channelText().slice(linesBefore43);
  check('频道回显带 -r 1 的更新命令', out43.includes('update --non-interactive -r 1'), out43.slice(-400));
  const infoRev43 = () => Number(svn(['info', '--show-item', 'revision', '.'], base43).trim());
  check('svn info 显示目标版本 1', infoRev43() === 1, `revision=${infoRev43()}`);
  check('内容回退到 r1', readFileSync(join(base43, 'a.txt'), 'utf8') === 'v1\n');
  state.inputQueue = ['HEAD'];
  const linesBefore43b = channelText().length;
  await state.registered.get('svnAnywhere.update')({ fsPath: base43, scheme: 'file' });
  check('HEAD 更新回显 -r HEAD', channelText().slice(linesBefore43b).includes('-r HEAD'));
  check('HEAD 后回到最新 revision 且内容同步',
    infoRev43() === 2 && readFileSync(join(base43, 'a.txt'), 'utf8') === 'v2\n');
  state.confirmResult = undefined;
  rmSync(lab43.lab, { recursive: true, force: true });

  console.log('场景 44：版本号非法输入提示后重试；取消输入不执行更新');
  const lab44 = makeSvnLab();
  const wc44 = lab44.checkout('wc44');
  writeFileSync(join(wc44, 'a.txt'), 'v1\n');
  svn(['add', '-q', '--parents', 'a.txt'], wc44);
  svn(['commit', '-q', '-m', 'init'], wc44);
  state.confirmResult = '更新';
  state.inputQueue = ['abc', '0', '-1', '1'];
  const warningBefore44 = state.warning.length;
  const linesBefore44 = channelText().length;
  await state.registered.get('svnAnywhere.update')({ fsPath: wc44, scheme: 'file' });
  check('非法输入每次提示后重试（3 次提示）',
    state.warning.slice(warningBefore44).filter((m) => m.includes('版本号须为正整数或 HEAD')).length === 3,
    JSON.stringify(state.warning.slice(warningBefore44)));
  check('重试到合法值后执行 -r 1', channelText().slice(linesBefore44).includes('update --non-interactive -r 1'));
  const progressBefore44 = state.progressTitles.length;
  const linesBefore44b = channelText().length;
  state.inputQueue = [undefined];
  await state.registered.get('svnAnywhere.update')({ fsPath: wc44, scheme: 'file' });
  check('取消版本号输入不执行更新',
    state.progressTitles.length === progressBefore44 && !channelText().slice(linesBefore44b).includes('> svn update'),
    channelText().slice(linesBefore44b).slice(-300));
  state.confirmResult = undefined;
  rmSync(lab44.lab, { recursive: true, force: true });

  console.log('场景 45：更新冲突提示「打开冲突文件」——文本冲突在编辑器打开');
  const lab45 = makeSvnLab();
  const base45 = lab45.checkout('base45');
  writeFileSync(join(base45, 'c.txt'), 'line1\n');
  svn(['add', '-q', '--parents', 'c.txt'], base45);
  svn(['commit', '-q', '-m', 'base'], base45);
  const other45 = lab45.checkout('other45');
  writeFileSync(join(other45, 'c.txt'), 'line1\nremote\n');
  svn(['commit', '-q', '-m', 'remote edit'], other45);
  writeFileSync(join(base45, 'c.txt'), 'line1\nlocal\n');
  state.confirmResult = '更新';
  state.warningChoice = '打开冲突文件';
  state.inputQueue = ['HEAD'];
  const executedBefore45 = state.executedCommands.length;
  await state.registered.get('svnAnywhere.update')({ fsPath: base45, scheme: 'file' });
  const conflictCmds45 = state.executedCommands.slice(executedBefore45);
  check('点「打开冲突文件」后用 vscode.open 打开冲突文件',
    conflictCmds45.some(([cmd, uri]) => cmd === 'vscode.open' && uri && uri.fsPath === join(base45, 'c.txt')),
    JSON.stringify(conflictCmds45));
  state.warningChoice = undefined;
  state.confirmResult = undefined;
  rmSync(lab45.lab, { recursive: true, force: true });

  console.log('场景 46：树冲突提示定位到目录——revealFileInOS');
  const lab46 = makeSvnLab();
  const base46 = lab46.checkout('base46');
  mkdirSync(join(base46, 'dir'), { recursive: true });
  writeFileSync(join(base46, 'dir', 'nested.txt'), 'v1\n');
  svn(['add', '-q', '--parents', 'dir/nested.txt'], base46);
  svn(['commit', '-q', '-m', 'dir base'], base46);
  const other46 = lab46.checkout('other46');
  svn(['delete', '-q', 'dir'], other46);
  svn(['commit', '-q', '-m', 'remote delete dir'], other46);
  writeFileSync(join(base46, 'dir', 'nested.txt'), 'local edit\n');
  state.confirmResult = '更新';
  state.warningChoice = '打开冲突文件';
  state.inputQueue = ['HEAD'];
  const warningBefore46 = state.warning.length;
  const executedBefore46 = state.executedCommands.length;
  await state.registered.get('svnAnywhere.update')({ fsPath: base46, scheme: 'file' });
  check('树冲突提示列出目录',
    state.warning.slice(warningBefore46).some((m) => m.includes('冲突') && m.includes('dir')),
    JSON.stringify(state.warning.slice(warningBefore46)));
  const cmds46 = state.executedCommands.slice(executedBefore46);
  check('树冲突目录在系统文件管理器定位（revealFileInOS）',
    cmds46.some(([cmd, uri]) => cmd === 'revealFileInOS' && uri && uri.fsPath === join(base46, 'dir')),
    JSON.stringify(cmds46));
  state.warningChoice = undefined;
  state.confirmResult = undefined;
  rmSync(lab46.lab, { recursive: true, force: true });

  console.log('场景 47：冲突通知未处理期间互斥锁已释放——同副本清理可立即执行');
  const warningBase47 = state.warning.length;
  const lab47 = makeSvnLab();
  const base47 = lab47.checkout('base47');
  writeFileSync(join(base47, 'c.txt'), 'line1\n');
  svn(['add', '-q', '--parents', 'c.txt'], base47);
  svn(['commit', '-q', '-m', 'base'], base47);
  const other47 = lab47.checkout('other47');
  writeFileSync(join(other47, 'c.txt'), 'line1\nremote\n');
  svn(['commit', '-q', '-m', 'remote edit'], other47);
  writeFileSync(join(base47, 'c.txt'), 'line1\nlocal\n');
  state.confirmResult = '更新';
  state.inputQueue = ['HEAD'];
  state.warningGate = 'hold';
  const linesBefore47 = channelText().length;
  const updating47 = state.registered.get('svnAnywhere.update')({ fsPath: base47, scheme: 'file' });
  // 等待本场景新增的冲突警告弹出（挂起中，模拟用户尚未处理通知）。
  // 只认 warningBase47 之后的增量且路径为 c.txt，避免命中历史场景的冲突警告。
  let warned47 = false;
  for (let retry = 0; retry < 200 && !warned47; retry += 1) {
    warned47 = state.warning.slice(warningBase47).some((m) => m.includes('1 个冲突') && m.includes('c.txt'));
    if (!warned47) await new Promise((resolve) => setTimeout(resolve, 30));
  }
  check('冲突警告已弹出（挂起等待用户处理）', warned47,
    JSON.stringify(state.warning.slice(warningBase47).filter((m) => m.includes('冲突'))));
  // 锁已释放：同副本清理不被「工作副本有未完成操作」拒绝，正常完成。
  state.confirmResult = '清理';
  const warningBefore47 = state.warning.length;
  const linesBefore47c = channelText().length;
  await state.registered.get('svnAnywhere.cleanup')({ fsPath: base47, scheme: 'file' });
  const cleanupOut47 = channelText().slice(linesBefore47c);
  check('冲突通知等待期间清理正常执行（互斥锁已释放）', cleanupOut47.includes('清理完成。'), cleanupOut47.slice(-300));
  check('未被「工作副本有未完成操作」拒绝',
    !state.warning.slice(warningBefore47).some((m) => m.includes('工作副本有未完成操作')),
    JSON.stringify(state.warning.slice(warningBefore47)));
  // 放行挂起的冲突通知（用户关闭），更新命令正常收尾。
  for (const resolveGate of state.warningGateResolvers.splice(0)) resolveGate(state.warningChoice);
  state.warningGate = 'off';
  await updating47;
  check('通知处理后更新命令完成（频道含冲突明细）',
    channelText().slice(linesBefore47).includes('C    c.txt'),
    channelText().slice(linesBefore47).slice(-300));
  state.confirmResult = undefined;
  state.warningChoice = undefined;
  rmSync(lab47.lab, { recursive: true, force: true });

  console.log('场景 48：分频道输出与操作日志——状态/更新/其它互不覆盖，日志含时间|命令|退出码|耗时');
  // 场景 17 deactivate 后场景 18 二次 activate 会重建同名频道：取最新实例。
  const channelByTitle = (title) => [...state.channels].reverse().find((c) => c.title === title);
  const channelTextOf = (title) => (channelByTitle(title) ? channelByTitle(title).lines.join('\n') : '');
  const lab48 = makeSvnLab();
  const wc48 = lab48.checkout('wc48');
  writeFileSync(join(wc48, 'a.txt'), 'v1');
  svn(['add', '-q', '--parents', 'a.txt'], wc48);
  svn(['commit', '-q', '-m', 'init'], wc48);
  writeFileSync(join(wc48, 'a.txt'), 'v2');
  const remote48 = lab48.checkout('remote48');
  writeFileSync(join(remote48, 'b.txt'), 'new');
  svn(['add', '-q', '--parents', 'b.txt'], remote48);
  svn(['commit', '-q', '-m', 'remote b'], remote48);
  await state.registered.get('svnAnywhere.showStatus')({ fsPath: join(wc48, 'a.txt'), scheme: 'file' });
  const statusText48 = channelTextOf('SVN Anywhere · 状态');
  check('状态频道含 modified 明细', statusText48.includes('[modified] a.txt'), statusText48.slice(-300));
  state.confirmResult = '更新';
  state.inputQueue = ['HEAD'];
  await state.registered.get('svnAnywhere.update')({ fsPath: wc48, scheme: 'file' });
  const updateText48 = channelTextOf('SVN Anywhere · 更新');
  check('更新频道含 update 命令回显与 revision 汇总',
    updateText48.includes('> svn update --non-interactive') && updateText48.includes('更新完成，当前 revision'),
    updateText48.slice(-400));
  check('状态频道不含 update 输出（互不覆盖）', !statusText48.includes('> svn update'), statusText48.slice(-200));
  check('更新频道不含状态明细（互不覆盖）', !updateText48.includes('[modified] a.txt'), updateText48.slice(-300));
  state.confirmResult = '清理';
  await state.registered.get('svnAnywhere.cleanup')({ fsPath: wc48, scheme: 'file' });
  const otherText48 = channelTextOf('SVN Anywhere');
  check('其它频道（SVN Anywhere）含清理输出', otherText48.includes('清理完成。'), otherText48.slice(-300));
  const opLog48 = channelTextOf('SVN Anywhere · 操作日志');
  const opLogLines48 = opLog48.split('\n').filter((l) => l.trim());
  const opLogLineRe = /^\d{2}:\d{2}:\d{2}\.\d{3} \| .+ \| 退出码 \d+ \| \d+ms$/;
  check('操作日志行均为 时间 | 命令 | 退出码 | 耗时 结构',
    opLogLines48.length >= 3 && opLogLines48.every((l) => opLogLineRe.test(l)),
    opLogLines48.filter((l) => !opLogLineRe.test(l)).slice(0, 5).map((l) => JSON.stringify(l.slice(0, 120))).join('\n'));
  check('操作日志含状态与更新命令（跨频道统一记录）',
    opLog48.includes('status --xml') && opLog48.includes('update --non-interactive'),
    opLogLines48.slice(-6).join('\n'));
  check('操作日志命令列已脱敏（无 --password 场景下不出现明文标记）',
    !opLog48.includes('--password '), '');
  state.confirmResult = undefined;
  rmSync(lab48.lab, { recursive: true, force: true });

  console.log('场景 49：GBK 输出解码回退——svn 包装脚本输出 GBK 字节，状态频道正确显示中文');
  // 逐双字节反查目标汉字的 GBK 编码（宿主 Node 无 GBK 编码器，只有解码器）。
  const gbkBytesOf = (text) => {
    const decoder = new TextDecoder('gbk');
    const bytes = [];
    for (const ch of text) {
      let found = null;
      for (let b1 = 0x81; b1 <= 0xfe && !found; b1 += 1) {
        for (let b2 = 0x40; b2 <= 0xfe && !found; b2 += 1) {
          if (decoder.decode(Buffer.from([b1, b2])) === ch) found = [b1, b2];
        }
      }
      if (!found) throw new Error(`no gbk bytes for ${ch}`);
      bytes.push(...found);
    }
    return bytes;
  };
  const gbkName = '中文文件.txt';
  const gbkEsc = gbkBytesOf('中文文件').map((b) => `\\x${b.toString(16).padStart(2, '0')}`).join('');
  const wrapDir = makeTempDir('svn-anywhere-gbkwrap-');
  const wrapSvn = join(wrapDir, 'svn-gbk.sh');
  writeFileSync(wrapSvn, [
    '#!/bin/sh',
    'case "$1" in',
    "  --version) printf 'svn, version 1.15.0 (mock-gbk)\\n'; exit 0 ;;",
    '  status) printf \'<?xml version="1.0"?>\\n<status>\\n<target path=".">\\n<entry path="' + gbkEsc + '.txt">\\n<wc-status item="modified" props="none"></wc-status>\\n</entry>\\n</target>\\n</status>\\n\'; exit 0 ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  const wc49 = makeTempDir('svn-anywhere-mock-wc49-');
  mkdirSync(join(wc49, '.svn'), { recursive: true });
  writeFileSync(join(wc49, '.svn', 'wc.db'), 'fake');
  state.configOverrides = { svnPath: wrapSvn };
  try {
    await state.registered.get('svnAnywhere.showStatus')({ fsPath: wc49, scheme: 'file' });
    const statusText49 = channelTextOf('SVN Anywhere · 状态');
    check('GBK 字节按回退链解码为中文（不出现乱码替换符）',
      statusText49.includes(`[modified] ${gbkName}`) && !statusText49.includes('\uFFFD'),
      statusText49.slice(-300));
    check('其它频道同样不含替换符', !channelTextOf('SVN Anywhere').includes('\uFFFD'), '');
  } finally {
    state.configOverrides = undefined;
    rmSync(wrapDir, { recursive: true, force: true });
    rmSync(wc49, { recursive: true, force: true });
  }

  console.log('场景 50：认证补录重试——凭据弹窗、脱敏回显与操作日志两行各自准确');
  const authWrapDir = makeTempDir('svn-anywhere-authwrap-');
  const authSvn = join(authWrapDir, 'svn-auth.sh');
  writeFileSync(authSvn, [
    '#!/bin/sh',
    'case "$1" in',
    "  --version) printf 'svn, version 1.15.0 (mock-auth)\\n'; exit 0 ;;",
    '  update)',
    '    case " $* " in',
    "      *' --password '*) printf \"Updating '.':\\nU    a.txt\\nUpdated to revision 3.\\n\"; exit 0 ;;",
    "      *) printf 'svn: E170001: Authentication failed\\n' >&2; exit 1 ;;",
    '    esac ;;',
    '  *) printf \'mock: unsupported\\n\' >&2; exit 1 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  const wc50 = makeTempDir('svn-anywhere-mock-wc50-');
  mkdirSync(join(wc50, '.svn'), { recursive: true });
  writeFileSync(join(wc50, '.svn', 'wc.db'), 'fake');
  state.configOverrides = { svnPath: authSvn };
  const opLogCountBefore50 = (channelByTitle('SVN Anywhere · 操作日志') || { lines: [] }).lines.length;
  const updateLinesBefore50 = (channelByTitle('SVN Anywhere · 更新') || { lines: [] }).lines.length;
  try {
    state.confirmResult = '更新';
    // InputBox 顺序：版本号 HEAD → 认证用户名 → 认证密码（password 输入框）。
    state.inputQueue = ['HEAD', 'reviewer', 'pass123'];
    await state.registered.get('svnAnywhere.update')({ fsPath: wc50, scheme: 'file' });
    const updateLines50 = channelByTitle('SVN Anywhere · 更新').lines.slice(updateLinesBefore50);
    check('重试成功：更新频道含最终 revision 汇总', updateLines50.some((l) => l.includes('更新完成，当前 revision 3')),
      updateLines50.join('\n').slice(-400));
    check('频道退出码两行（首执行 1、重试 0）——既有口径不变',
      updateLines50.includes('退出码: 1') && updateLines50.includes('退出码: 0'),
      updateLines50.filter((l) => l.startsWith('退出码')).join('|'));
    check('重试命令回显已脱敏（--password ***，无明文）',
      updateLines50.some((l) => l.includes('--username reviewer --password ***')) &&
      !updateLines50.join('\n').includes('pass123'),
      updateLines50.filter((l) => l.includes('--username')).join('\n'));
    const opLog50 = channelByTitle('SVN Anywhere · 操作日志').lines.slice(opLogCountBefore50).filter((l) => l.includes('update'));
    check('操作日志两行：首执行（无凭据、退出码 1）与重试（脱敏凭据、退出码 0）各自准确',
      opLog50.length === 2 &&
      /退出码 1 \| \d+ms$/.test(opLog50[0]) && !opLog50[0].includes('--username') &&
      opLog50[1].includes('--username reviewer --password ***') && /退出码 0 \| \d+ms$/.test(opLog50[1]),
      opLog50.join('\n'));
    check('操作日志与频道均无明文密码', !opLog50.join('\n').includes('pass123'), '');
    state.confirmResult = undefined;
    state.inputQueue = [];
  } finally {
    state.configOverrides = undefined;
    rmSync(authWrapDir, { recursive: true, force: true });
    rmSync(wc50, { recursive: true, force: true });
  }

  console.log('场景 51：资源管理器多选批量更新——第二参数 Uri[] 形态、嵌套去重只保留最外层、一次执行逐项可见');
  const lab51 = makeSvnLab();
  const base51 = lab51.checkout('base51');
  mkdirSync(join(base51, 'd1', 'sub'), { recursive: true });
  mkdirSync(join(base51, 'd2'), { recursive: true });
  for (const rel of ['d1/a.txt', 'd1/sub/b.txt', 'd2/c.txt']) {
    writeFileSync(join(base51, rel), 'v1\n');
  }
  svn(['add', '-q', '--parents', 'd1', 'd2'], base51);
  svn(['commit', '-q', '-m', 'init'], base51);
  const other51 = lab51.checkout('other51');
  writeFileSync(join(other51, 'd1/a.txt'), 'v2\n');
  writeFileSync(join(other51, 'd2/c.txt'), 'v2\n');
  svn(['commit', '-q', '-m', 'remote change'], other51);
  const head51 = Number(svn(['info', '--show-item', 'revision', lab51.repoUrl]).trim());
  const uri51 = (p) => ({ fsPath: p, scheme: 'file' });
  state.confirmResult = '更新';
  state.inputQueue = ['HEAD'];
  const warningBefore51 = state.warning.length;
  const linesBefore51 = channelText().length;
  // 多选形态：(uri, uris[])，选区含嵌套（d1/a.txt、d1/sub 在 d1 内）与并列目标 d2。
  await state.registered.get('svnAnywhere.update')(
    uri51(join(base51, 'd1/a.txt')),
    [uri51(join(base51, 'd1/a.txt')), uri51(join(base51, 'd1/sub')), uri51(join(base51, 'd1')), uri51(join(base51, 'd2'))],
  );
  const confirmMsg51 = state.warning[warningBefore51] ?? '';
  check('确认框列出全部去重后目标（d1、d2），嵌套内层不重复出现',
    confirmMsg51.includes('d1') && confirmMsg51.includes(join(base51, 'd2')) &&
    !confirmMsg51.includes(join(base51, 'd1/a.txt')),
    confirmMsg51);
  const out51 = channelText().slice(linesBefore51);
  check('一次 svn update 携带去重后的两个目标（一次执行）',
    out51.includes('update --non-interactive -r HEAD d1 d2'), out51.slice(-400));
  check('结果逐项可见：两个目标下的明细路径都出现在频道',
    out51.includes('d1/a.txt') && out51.includes('d2/c.txt'), out51.slice(-400));
  check('两处内容都已更新到远端版本',
    readFileSync(join(base51, 'd1/a.txt'), 'utf8') === 'v2\n' &&
    readFileSync(join(base51, 'd2/c.txt'), 'utf8') === 'v2\n');
  check('两个目标目录 revision 都到 HEAD',
    Number(svn(['info', '--show-item', 'revision', 'd1'], base51).trim()) === head51 &&
    Number(svn(['info', '--show-item', 'revision', 'd2'], base51).trim()) === head51);
  state.confirmResult = undefined;
  state.inputQueue = [];
  rmSync(lab51.lab, { recursive: true, force: true });

  console.log('场景 52：资源管理器多选批量提交——多目标面板会话、目标外不混入、跨副本选区拒绝');
  const mwc52 = panelLab.checkout('batch-wc');
  mkdirSync(join(mwc52, 'd1', 'sub'), { recursive: true });
  mkdirSync(join(mwc52, 'd2'), { recursive: true });
  for (const rel of ['d1/a.txt', 'd1/sub/b.txt', 'd2/c.txt', 'outside.txt']) {
    writeFileSync(join(mwc52, rel), 'v1\n');
  }
  svn(['add', '-q', '--parents', 'd1', 'd2', 'outside.txt'], mwc52);
  svn(['commit', '-q', '-m', 'batch base'], mwc52);
  writeFileSync(join(mwc52, 'd1/a.txt'), 'v2\n');
  writeFileSync(join(mwc52, 'd2/c.txt'), 'v2\n');
  writeFileSync(join(mwc52, 'outside.txt'), 'v2\n');
  const otherWc52 = panelLab.checkout('batch-other');
  const uri52 = (p) => ({ fsPath: p, scheme: 'file' });
  /** 以多选数组形态驱动「提交」并等待目标数据帧（同 openCommitPanel 的重试语义）。 */
  const openCommitPanelBatch = async (uris, expectText) => {
    let panel;
    let render;
    // 与 openCommitPanel 同口径：切换遇旧会话草稿时确认放弃（无草稿不受影响）。
    const confirmBeforeBatch = state.confirmResult;
    state.confirmResult = '放弃并切换';
    try {
      for (let attempt = 0; attempt < 8 && !render; attempt += 1) {
        await state.registered.get('svnAnywhere.commit')(uris[0], uris);
        panel = [...state.panels].reverse().find((p) => p.viewType === 'svn-anywhere-commit');
        if (!panel) {
          throw new Error(`提交面板未创建（panels=${state.panels.length}）`);
        }
        panel.sendReady();
        render = await waitRender(panel, expectText, 20);
      }
    } finally {
      state.confirmResult = confirmBeforeBatch;
    }
    if (!render || !panel) {
      throw new Error(`多选面板数据帧未出现：${expectText}`);
    }
    return { panel, render };
  };
  // 多选两个并列目标（d1/a.txt 与 d2 不嵌套）：面板建立多目标会话。
  const batch52 = await openCommitPanelBatch(
    [uri52(join(mwc52, 'd1/a.txt')), uri52(join(mwc52, 'd2'))],
    'data-row-id="d1/a.txt"',
  );
  check('多目标会话：两个目标下的变更都进面板，标题显示 2 个目标',
    batch52.render.html.includes('data-row-id="d1/a.txt"') &&
    batch52.render.html.includes('data-row-id="d2/c.txt"') &&
    batch52.render.html.includes('2 个目标'),
    (batch52.render.html.match(/·[^<]{0,20}/g) ?? []).slice(0, 4).join('|'));
  check('目标外的修改不混入（outside.txt 不在面板）',
    !batch52.render.html.includes('data-row-id="outside.txt"'));
  // 提交两个目标下的各一项：一次 commit 携带两个显式路径，目标外保留本地。
  const info52 = state.information.length;
  await commitViaPanel(batch52.panel, ['d1/a.txt', 'd2/c.txt'], 'batch commit two targets');
  await waitNewInfo('提交成功', info52);
  check('批量提交一次入库两个目标路径，目标外修改保留本地',
    svn(['cat', '-r', 'HEAD', 'd1/a.txt'], mwc52) === 'v2\n' &&
    svn(['cat', '-r', 'HEAD', 'd2/c.txt'], mwc52) === 'v2\n' &&
    svn(['status'], mwc52).includes('outside.txt'),
    svn(['status'], mwc52));
  // 跨工作副本选区：提示分开执行，面板不切换目标。
  await waitPanelIdle(batch52.panel);
  const infoBefore52b = state.information.length;
  await state.registered.get('svnAnywhere.commit')(
    uri52(join(mwc52, 'd1/a.txt')),
    [uri52(join(mwc52, 'd1/a.txt')), uri52(otherWc52)],
  );
  check('跨副本多选提交被拒绝并提示同一工作副本要求',
    state.information.slice(infoBefore52b).some((m) => m.includes('同一个工作副本')),
    JSON.stringify(state.information.slice(infoBefore52b)));
  // 嵌套选区（d1 与 d1/a.txt）：去重后只剩最外层 d1，单目标形态。
  writeFileSync(join(mwc52, 'd1/sub/b.txt'), 'v2\n');
  await openCommitPanelBatch(
    [uri52(join(mwc52, 'd1')), uri52(join(mwc52, 'd1/a.txt'))],
    'data-row-id="d1/sub/b.txt"',
  );
  const dedupPanel = [...state.panels].reverse().find((p) => p.viewType === 'svn-anywhere-commit');
  const dedupRender = [...dedupPanel.webview.posted].reverse().find(
    (m) => m.type === 'render' && m.html.includes('data-row-id="d1/sub/b.txt"'),
  );
  check('嵌套选区去重后为单目标（不显示多目标标签），面板正常打开',
    !!dedupRender && !dedupRender.html.includes('2 个目标'));

  console.log('场景 53：跨副本嵌套选区——独立嵌套副本不被字符串去重吞掉，更新两组执行、提交提示分开');
  const lab53 = makeSvnLab();
  const base53 = lab53.checkout('base53');
  writeFileSync(join(base53, 'a.txt'), 'v1\n');
  svn(['add', '-q', '--parents', 'a.txt'], base53);
  svn(['commit', '-q', '-m', 'init'], base53);
  // 在外层副本内部 checkout 独立嵌套副本：外层 status 中它是 unversioned，
  // 外层 update/commit 均不作用于它（svn 1.15 实测），不能被字符串去重吞掉。
  const nested53 = join(base53, 'nested-wc');
  svn(['checkout', '-q', lab53.repoUrl, nested53]);
  const other53 = lab53.checkout('other53');
  writeFileSync(join(other53, 'a.txt'), 'v2\n');
  svn(['commit', '-q', '-m', 'remote change'], other53);
  const head53 = Number(svn(['info', '--show-item', 'revision', lab53.repoUrl]).trim());
  const uri53 = (p) => ({ fsPath: p, scheme: 'file' });
  state.confirmResult = '更新';
  state.inputQueue = ['HEAD'];
  const warningBefore53 = state.warning.length;
  const linesBefore53 = channelText().length;
  // 多选外层副本根 + 嵌套独立副本：字符串上嵌套但分属两个工作副本。
  await state.registered.get('svnAnywhere.update')(
    uri53(base53),
    [uri53(base53), uri53(nested53)],
  );
  const confirmMsg53 = state.warning[warningBefore53] ?? '';
  check('确认框同时列出外层与嵌套副本目标（操作意图不丢失）',
    confirmMsg53.includes(base53) && confirmMsg53.includes(nested53),
    confirmMsg53);
  const out53 = channelText().slice(linesBefore53);
  check('两个副本各自执行一次 update（两条命令回显）',
    (out53.match(/> svn update --non-interactive -r HEAD \./g) || []).length === 2,
    out53.slice(-500));
  check('外层与嵌套副本 revision 都到 HEAD（修复前嵌套被吞、revision 停留）',
    Number(svn(['info', '--show-item', 'revision', '.'], base53).trim()) === head53 &&
    Number(svn(['info', '--show-item', 'revision', '.'], nested53).trim()) === head53,
    `base=${svn(['info', '--show-item', 'revision', '.'], base53).trim()} nested=${svn(['info', '--show-item', 'revision', '.'], nested53).trim()} head=${head53}`);
  check('外层内容更新到远端版本', readFileSync(join(base53, 'a.txt'), 'utf8') === 'v2\n');
  state.confirmResult = undefined;
  state.inputQueue = [];
  // 提交侧：跨副本嵌套选区不再静默只剩外层目标，而是明确提示分开执行。
  writeFileSync(join(base53, 'a.txt'), 'v3\n');
  writeFileSync(join(nested53, 'a.txt'), 'v3\n');
  const infoBefore53b = state.information.length;
  await state.registered.get('svnAnywhere.commit')(
    uri53(join(base53, 'a.txt')),
    [uri53(join(base53, 'a.txt')), uri53(nested53)],
  );
  check('跨副本多选提交被拒绝并提示同一工作副本要求（嵌套副本不被静默吞掉）',
    state.information.slice(infoBefore53b).some((m) => m.includes('同一个工作副本')),
    JSON.stringify(state.information.slice(infoBefore53b)));
  rmSync(lab53.lab, { recursive: true, force: true });

  console.log('场景 54：P2 隐藏重显——输入即时重绘、重推最新草稿、请求序号重启不被去重吞掉');
  const lab54 = makeSvnLab();
  const wc54 = lab54.checkout('wc54');
  writeFileSync(join(wc54, 'origin.txt'), 'x\n');
  svn(['add', '-q', '--parents', 'origin.txt'], wc54);
  svn(['commit', '-q', '-m', 'init'], wc54);
  const panel54 = await openIgnorePanel(join(wc54, 'origin.txt'), '未设置');
  const sid54 = [...panel54.webview.posted].reverse().find((m) => m.type === 'render').sessionId;
  // 缺陷 A：syncInput 后立即推送渲染（修复前停在旧帧，加入按钮与输入值不更新）。
  const postedBeforeDraft = panel54.webview.posted.length;
  panel54.sendIntent({ kind: 'syncInput', fieldId: 'draft', value: 'draft-test', inputRevision: 1 }, sid54, '1');
  const draftFrame54 = await waitNewRender(panel54, 'value="draft-test"', postedBeforeDraft);
  check('syncInput 立即重绘：待加入输入值与启用中的加入按钮同步上屏',
    Boolean(draftFrame54) && draftFrame54.html.includes('data-focus="add-rule">'),
    draftFrame54 ? `formRevision=${draftFrame54.formRevision}` : '未出现含草稿的渲染帧');
  // 缺陷 B：隐藏销毁后重显——ready 重握手清空请求去重集合并重推最新状态。
  const postedBeforeReload = panel54.webview.posted.length;
  panel54.sendReady();
  const reloadFrame54 = await waitNewRender(panel54, 'value="draft-test"', postedBeforeReload);
  check('重显重握手推最新草稿（重推帧含输入值而非旧空值）', Boolean(reloadFrame54),
    reloadFrame54 ? '' : 'ready 后未重推含 draft-test 的帧');
  // 视图重建后请求序号从 req-1 重启：与重建前同 ID 的意图必须仍被处理。
  const postedBeforeAdd = panel54.webview.posted.length;
  panel54.sendIntent({ kind: 'addRule' }, sid54, '1');
  const addedFrame54 = await waitNewRender(panel54, 'rule-text">draft-test', postedBeforeAdd);
  check('请求序号重启后同 ID 意图不被去重吞掉（addRule 入列）', Boolean(addedFrame54),
    addedFrame54 ? '' : 'req-1（addRule）未产生新帧（被旧去重集合吞掉）');
  // closePanel 同样以重启序号发送：dirty 草稿触发关闭确认即证明意图被处理。
  state.confirmResult = undefined;
  const warningBefore54 = state.warning.length;
  panel54.sendIntent({ kind: 'closePanel' }, sid54, '2');
  await new Promise((resolve) => setTimeout(resolve, 100));
  check('重启序号的 closePanel 到达控制器并弹出放弃草稿确认',
    state.warning.slice(warningBefore54).some((m) => m.includes('关闭并放弃未保存修改？')),
    JSON.stringify(state.warning.slice(warningBefore54)));
  rmSync(lab54.lab, { recursive: true, force: true });
  // 关闭场景 54 面板（其草稿会随 dispose 暂存到 lab54 目标键），
  // 场景 55 用干净的暂存空间断言自己的目标键。
  panel54.dispose();

  console.log('场景 55：P2 原生关闭暂存草稿——重建握手归零确认序号、⌘W 关闭后重开恢复');
  for (const key of [...state.globalStateMap.keys()]) {
    if (key.startsWith('ignorePanel.stash|')) {
      state.globalStateMap.delete(key);
    }
  }
  const lab55 = makeSvnLab();
  const wc55 = lab55.checkout('wc55');
  writeFileSync(join(wc55, 'origin.txt'), 'x\n');
  svn(['add', '-q', '--parents', 'origin.txt'], wc55);
  svn(['commit', '-q', '-m', 'init'], wc55);
  const panel55 = await openIgnorePanel(join(wc55, 'origin.txt'), '未设置');
  const sid55 = [...panel55.webview.posted].reverse().find((m) => m.type === 'render').sessionId;
  // 输入并加入：留下未保存草稿（规则 + 确认序号累积）。
  const postedBeforeAdd55 = panel55.webview.posted.length;
  panel55.sendIntent({ kind: 'syncInput', fieldId: 'draft', value: 'keep-draft', inputRevision: 1 }, sid55, '1');
  panel55.sendIntent({ kind: 'addRule' }, sid55, '2');
  const addedFrame55 = await waitNewRender(panel55, 'rule-text">keep-draft', postedBeforeAdd55);
  const epochBeforeReload55 = addedFrame55 ? (addedFrame55.viewEpoch ?? 0) : -1;
  check('加入后规则上屏且携带视图代次', Boolean(addedFrame55) && epochBeforeReload55 >= 1,
    addedFrame55 ? `viewEpoch=${epochBeforeReload55}` : 'addRule 帧未出现');
  // webview 重建握手：视图输入序号从零重启，宿主确认序号同步归零并递增代次。
  const postedBeforeReload55 = panel55.webview.posted.length;
  panel55.sendReady();
  const reloadFrame55 = await waitNewRender(panel55, 'rule-text">keep-draft', postedBeforeReload55);
  check('重建握手帧：formRevision 归零且 viewEpoch 递增（旧大序号不误确认新视图输入）',
    Boolean(reloadFrame55) && reloadFrame55.formRevision === 0 && reloadFrame55.viewEpoch > epochBeforeReload55,
    reloadFrame55 ? `formRevision=${reloadFrame55.formRevision} viewEpoch=${reloadFrame55.viewEpoch} before=${epochBeforeReload55}` : 'ready 重推帧未出现');
  // 原生关闭（⌘W/标签 X → onDidDispose，无面板内确认框）：未保存草稿暂存。
  panel55.dispose();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const stashKeys55 = [...state.globalStateMap.keys()].filter((k) => k.startsWith('ignorePanel.stash|'));
  check('原生关闭后未保存草稿已按目标键暂存（globalState）', stashKeys55.length === 1,
    JSON.stringify(stashKeys55));
  // 重开同目标：暂存草稿恢复到编辑值并提示，暂存一次性消费。
  const panel55b = await openIgnorePanel(join(wc55, 'origin.txt'), '已恢复上次关闭面板时未保存的草稿');
  const html55b = [...panel55b.webview.posted].reverse().find((m) => m.type === 'render').html;
  check('重开恢复草稿：未保存规则回到列表且未保存徽标在场',
    html55b.includes('rule-text">keep-draft') && html55b.includes('未保存'),
    html55b.slice(0, 120));
  check('暂存一次性消费（globalState 无残留）',
    ![...state.globalStateMap.keys()].some((k) => k.startsWith('ignorePanel.stash|')), '');
  rmSync(lab55.lab, { recursive: true, force: true });

  console.log('场景 56：P2 暂存基线与放弃语义——外部修改不静默覆盖、确认放弃不再恢复');
  // 场景 55 重开的面板还挂着恢复的草稿：先原生关闭（会按目标键暂存）并清空
  // 暂存空间，场景 56 才能在「无面板 + 无暂存」的初始态下断言自己的键。
  panel55b.dispose();
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const key of [...state.globalStateMap.keys()]) {
    if (key.startsWith('ignorePanel.stash|')) {
      state.globalStateMap.delete(key);
    }
  }
  const lab56 = makeSvnLab();
  const wc56 = lab56.checkout('wc56');
  writeFileSync(join(wc56, 'origin.txt'), 'x\n');
  svn(['add', '-q', '--parents', 'origin.txt'], wc56);
  svn(['commit', '-q', '-m', 'init'], wc56);
  const stashKeys56 = () => [...state.globalStateMap.keys()].filter((k) => k.startsWith('ignorePanel.stash|'));
  check('场景前置：暂存空间干净', stashKeys56().length === 0, JSON.stringify(stashKeys56()));
  // 加入规则形成未保存草稿（基线为初始无属性），原生关闭暂存。
  const panel56 = await openIgnorePanel(join(wc56, 'origin.txt'), '未设置');
  const sid56 = [...panel56.webview.posted].reverse().find((m) => m.type === 'render').sessionId;
  panel56.sendIntent({ kind: 'syncInput', fieldId: 'draft', value: 'restored.tmp', inputRevision: 1 }, sid56, '1');
  panel56.sendIntent({ kind: 'addRule' }, sid56, '2');
  await waitNewRender(panel56, 'rule-text">restored.tmp', panel56.webview.posted.length - 4);
  panel56.dispose();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const stash56 = state.globalStateMap.get(stashKeys56()[0]);
  check('原生关闭暂存连带暂存时保存基线（savedRules 空 + 属性不存在）',
    stashKeys56().length === 1 && stash56 && Array.isArray(stash56.savedRules)
      && stash56.savedRules.length === 0 && stash56.savedPropertyExists === false
      && JSON.stringify(stash56.rules) === JSON.stringify(['restored.tmp']),
    JSON.stringify(stash56));
  // 关闭期间外部 propset 修改规则：重开恢复草稿须提示外部修改。
  svn(['propset', '-q', 'svn:ignore', 'external.keep', wc56], wc56);
  const panel56b = await openIgnorePanel(join(wc56, 'origin.txt'), '关闭期间规则已被其他操作修改');
  const sid56b = [...panel56b.webview.posted].reverse().find((m) => m.type === 'render').sessionId;
  check('重开恢复草稿且外部修改提示在场（未保存徽标 + 恢复的规则）', (() => {
    const frame = [...panel56b.webview.posted].reverse().find((m) => m.type === 'render');
    return frame.html.includes('rule-text">restored.tmp') && frame.html.includes('未保存');
  })(), '');
  // 保存：磁盘值与暂存基线不一致 → 拦截写回，external.keep 保留在属性里。
  const postedBeforeSave56 = panel56b.webview.posted.length;
  panel56b.sendIntent({ kind: 'saveIgnore' }, sid56b, '1');
  const blockedFrame56 = await waitNewRender(panel56b, '本次未覆盖', postedBeforeSave56);
  check('恢复草稿的保存被外部修改拦截（错误横幅提示未覆盖）', Boolean(blockedFrame56), '');
  const propAfter56 = svn(['propget', 'svn:ignore', wc56], wc56).trim();
  check('真实 propget 确认 external.keep 未被旧草稿覆盖', propAfter56 === 'external.keep', JSON.stringify(propAfter56));
  // 面板内确认「放弃草稿并关闭」：销毁后不再暂存刚放弃的草稿。
  state.confirmResult = '放弃草稿并关闭';
  panel56b.sendIntent({ kind: 'closePanel' }, sid56b, '2');
  await new Promise((resolve) => setTimeout(resolve, 100));
  check('确认放弃并关闭后 globalState 不留暂存（P2 放弃路径）',
    panel56b.disposed && stashKeys56().length === 0,
    `disposed=${panel56b.disposed} keys=${JSON.stringify(stashKeys56())}`);
  state.confirmResult = undefined;
  rmSync(lab56.lab, { recursive: true, force: true });

  console.log('场景 57：P1 命令入口切换目标——说明草稿先确认，取消保留，确认后空说明加载（真机缺陷复现）');
  // 复现真机验收 5 缺陷路径：batch-a 输入说明 → 资源管理器对同副本 example.txt
  // 执行提交。修复前直接切换并静默清空说明；修复后须先弹「放弃并切换」。
  // 先关闭此前场景遗留的 P1 面板（场景 52 会话的勾选变化会触发切换确认），
  // 场景 57 在「无面板」初始态下建立自己的会话。
  const leftoverCommitPanel = [...state.panels].reverse().find((p) => p.viewType === 'svn-anywhere-commit' && !p.disposed);
  if (leftoverCommitPanel) {
    leftoverCommitPanel.dispose();
  }
  const lab57 = makeSvnLab();
  const wc57 = lab57.checkout('wc57');
  mkdirSync(join(wc57, 'batch-a'), { recursive: true });
  writeFileSync(join(wc57, 'batch-a', 'a.txt'), 'base\n');
  writeFileSync(join(wc57, 'example.txt'), 'base\n');
  svn(['add', '-q', '--parents', 'batch-a'], wc57);
  svn(['commit', '-q', '-m', 'init'], wc57);
  writeFileSync(join(wc57, 'batch-a', 'a.txt'), 'change\n');
  writeFileSync(join(wc57, 'example.txt'), 'change\n');
  const panelsBefore57 = state.panels.length;
  await state.registered.get('svnAnywhere.commit')({ fsPath: join(wc57, 'batch-a'), scheme: 'file' });
  const panel57 = state.panels.at(-1);
  check('P1 打开 batch-a 创建新面板', state.panels.length === panelsBefore57 + 1, '');
  const frame57 = await waitRender(panel57, 'data-row-id="batch-a/a.txt"');
  check('batch-a 会话就绪（a.txt 变更在场）', Boolean(frame57), '');
  const sid57 = frame57.sessionId;
  // 输入说明草稿：页脚字数即时更新（缺陷 A 修复后的输入即回推链路）。
  panel57.sendAuto({ kind: 'syncInput', fieldId: 'message', value: '切换前草稿', inputRevision: state.intentSeq + 1000 });
  const draftFrame57 = await waitRender(panel57, '说明 5 字');
  check('说明草稿输入后页脚显示 5 字', Boolean(draftFrame57), '');
  // 取消切换：弹「切换目标并放弃草稿？」，面板会话与草稿不动。
  state.confirmResult = undefined;
  const warnBefore57 = state.warning.length;
  await state.registered.get('svnAnywhere.commit')({ fsPath: join(wc57, 'example.txt'), scheme: 'file' });
  const sidAfterCancel57 = [...panel57.webview.posted].reverse().find((m) => m.type === 'render').sessionId;
  check('取消切换：弹出放弃草稿确认且面板会话未变',
    state.warning.slice(warnBefore57).some((m) => m.includes('切换目标并放弃草稿？')) && sidAfterCancel57 === sid57,
    JSON.stringify(state.warning.slice(warnBefore57)));
  check('取消切换后草稿仍在（无 example.txt 渲染帧）',
    ![...panel57.webview.posted].some((m) => m.type === 'render' && m.html.includes('data-row-id="example.txt"'))
      && [...panel57.webview.posted].reverse().find((m) => m.type === 'render').html.includes('切换前草稿'),
    '');
  // 确认切换：新会话渲染 example.txt，说明清零。
  state.confirmResult = '放弃并切换';
  await state.registered.get('svnAnywhere.commit')({ fsPath: join(wc57, 'example.txt'), scheme: 'file' });
  const switchedFrame57 = await waitRender(panel57, 'data-row-id="example.txt"');
  check('确认切换：新会话渲染 example.txt 且说明 0 字',
    Boolean(switchedFrame57) && switchedFrame57.sessionId !== sid57 && switchedFrame57.html.includes('说明 0 字'),
    switchedFrame57 ? `sessionId 切换=${switchedFrame57.sessionId !== sid57} 说明0字=${switchedFrame57.html.includes('说明 0 字')}` : 'example.txt 帧未出现');
  // 切回 batch-a：当前会话无草稿，不再确认直接切换，已放弃草稿不复活。
  const warnBeforeBack57 = state.warning.length;
  await state.registered.get('svnAnywhere.commit')({ fsPath: join(wc57, 'batch-a'), scheme: 'file' });
  const postedIndex57 = panel57.webview.posted.indexOf(switchedFrame57) + 1;
  const backFrame57 = await waitNewRender(panel57, 'data-row-id="batch-a/a.txt"', postedIndex57);
  check('切回 batch-a：不再弹确认，新会话空说明且草稿不复活',
    Boolean(backFrame57) && backFrame57.html.includes('说明 0 字') && !backFrame57.html.includes('切换前草稿')
      && !state.warning.slice(warnBeforeBack57).some((m) => m.includes('切换目标并放弃草稿？')),
    backFrame57 ? '' : '切回 batch-a 帧未出现');
  state.confirmResult = undefined;
  rmSync(lab57.lab, { recursive: true, force: true });

  /* ---------------- P3 检出/续检任务执行器（真实 file:// svn） ---------------- */

  // 远端身份三元组读取（脚本侧轻解析 svn info --xml；面板正式链路走 core 的 checkRemote）。
  const peggedUrl = (url) => (url.includes('@') ? `${url}@` : url);
  const remoteIdentityOf = (url) => {
    const xml = svn(['info', '--xml', peggedUrl(url)]);
    const pick = (re) => re.exec(xml)?.[1] ?? '';
    return {
      repositoryUuid: pick(/<uuid>([^<]+)<\/uuid>/),
      repositoryRootUrl: pick(/<root>([^<]+)<\/root>/),
      relativeUrl: pick(/<relative-url>([^<]+)<\/relative-url>/),
      revision: Number(pick(/<entry[^>]*revision="(\d+)"/)),
    };
  };
  const draftFormOf = (url, rev, depth, parentDir, name) => ({
    url, urlInput: url, nameMode: 'auto', parentDir, dirName: name,
    directMode: false, directDir: '', revMode: 'number', rev: String(rev),
    depth, sourceDir: '', message: '',
  });
  // 仓库结构：trunk 下 a.txt + sub/b.txt + sub/deep/c.txt（供四深度与续检断言）。
  // lab.checkout 检出的是仓库根——trunk 作为首个提交的子目录建立。
  const seedTrunk = (lab, fileTag) => {
    const seed = lab.checkout('seed');
    mkdirSync(join(seed, 'trunk', 'sub', 'deep'), { recursive: true });
    writeFileSync(join(seed, 'trunk', 'a.txt'), `${fileTag}-a`);
    writeFileSync(join(seed, 'trunk', 'sub', 'b.txt'), `${fileTag}-b`);
    writeFileSync(join(seed, 'trunk', 'sub', 'deep', 'c.txt'), `${fileTag}-c`);
    svn(['add', '-q', 'trunk'], seed);
    svn(['commit', '-q', '-m', 'seed'], seed);
    return seed;
  };

  console.log('场景 58：P3 检出执行器——四深度、指定版本与 URL 段含 @（真实 file://）');
  {
    const api = extension.__checkoutTaskApi;
    if (!api) {
      throw new Error('扩展未导出 __checkoutTaskApi（自动化驱动出口缺失）');
    }
    const lab58 = makeSvnLab();
    const trunk58 = `${lab58.repoUrl}/trunk`;
    const seed58 = seedTrunk(lab58, 'r1');
    writeFileSync(join(seed58, 'trunk', 'a.txt'), 'r2-a');
    svn(['commit', '-q', '-m', 'r2'], seed58);

    const parent58 = join(lab58.lab, 'targets');
    mkdirSync(parent58, { recursive: true });
    const runCheckout58 = async ({ url, rev, depth, name }) => {
      const identity = remoteIdentityOf(url);
      const progress = [];
      const started = api.startCheckoutTask({
        svnPath: 'svn', url, pinnedRevision: rev ?? identity.revision, depth,
        targetDir: join(parent58, name), parentDir: parent58, dirName: name,
        directMode: false, directDir: '', identity,
        entryKey: parent58, initiatorSessionId: 'mock-session-58',
        formSnapshot: draftFormOf(url, rev ?? identity.revision, depth, parent58, name),
        callbacks: { onProgress: (s) => progress.push({ count: s.count, currentFile: s.currentFile }) },
      });
      const done = await started.done;
      return { done, progress };
    };
    const depthOf = (dir) => svn(['info', '--show-item', 'depth', '--', `${dir}@`]).trim();

    // 四深度：empty / files / immediates / infinity。
    const empty58 = await runCheckout58({ url: trunk58, depth: 'empty', name: 'd-empty' });
    check('empty 深度检出 success', empty58.done.outcome === 'finished' && empty58.done.result.kind === 'success',
      JSON.stringify(empty58.done).slice(0, 300));
    check('empty：目标 depth=empty 且无业务条目', depthOf(join(parent58, 'd-empty')) === 'empty'
      && !existsSync(join(parent58, 'd-empty', 'a.txt')));

    const files58 = await runCheckout58({ url: trunk58, depth: 'files', name: 'd-files' });
    check('files 深度检出 success 与流式计数', files58.done.outcome === 'finished'
      && files58.progress.at(-1)?.count === 1, JSON.stringify(files58.progress).slice(0, 200));
    check('files：顶层文件存在、子目录不展开', existsSync(join(parent58, 'd-files', 'a.txt'))
      && !existsSync(join(parent58, 'd-files', 'sub')));

    const imm58 = await runCheckout58({ url: trunk58, depth: 'immediates', name: 'd-imm' });
    check('immediates 深度检出 success 与流式计数', imm58.done.outcome === 'finished'
      && imm58.progress.at(-1)?.count === 2, JSON.stringify(imm58.progress).slice(0, 200));
    check('immediates：顶层文件与子目录实体、深层不展开',
      existsSync(join(parent58, 'd-imm', 'a.txt')) && existsSync(join(parent58, 'd-imm', 'sub'))
      && !existsSync(join(parent58, 'd-imm', 'sub', 'b.txt')) && !existsSync(join(parent58, 'd-imm', 'sub', 'deep')));

    const inf58 = await runCheckout58({ url: trunk58, depth: 'infinity', name: 'd-inf' });
    check('infinity 深度检出 success 与流式计数', inf58.done.outcome === 'finished'
      && inf58.progress.at(-1)?.count === 5, JSON.stringify(inf58.progress).slice(0, 200));
    check('infinity：全量条目落盘', existsSync(join(parent58, 'd-inf', 'sub', 'deep', 'c.txt')));

    // 指定版本：固定 r1（a.txt 为 r1 内容）。
    const rev58 = await runCheckout58({ url: trunk58, rev: 1, depth: 'infinity', name: 'd-rev1' });
    check('指定版本检出 success（尾行 revision）', rev58.done.outcome === 'finished'
      && rev58.done.result.kind === 'success' && rev58.done.result.revision === 1,
      JSON.stringify(rev58.done.result).slice(0, 200));
    check('指定版本：内容与 working revision 都是 r1',
      readFileSync(join(parent58, 'd-rev1', 'a.txt'), 'utf8') === 'r1-a'
      && svn(['info', '--show-item', 'revision', '--', `${join(parent58, 'd-rev1')}@`]).trim() === '1');

    // URL 段含 @：peg 处理（escapeUrlPeg 补尾 @）后正确检出目录 a@b。
    // a@b 目录此刻才建（四深度计数断言基于纯 trunk 结构）。
    svn(['mkdir', '-q', '-m', 'at-dir', `${trunk58}/a@b@`]);
    const at58 = await runCheckout58({ url: `${trunk58}/a@b`, depth: 'infinity', name: 'a@b' });
    check('@ 段 URL 检出 success', at58.done.outcome === 'finished' && at58.done.result.kind === 'success',
      JSON.stringify(at58.done).slice(0, 300));
    check('@ 段：目标目录名原样为 a@b（.svn 元数据就位）',
      existsSync(join(parent58, 'a@b', '.svn', 'wc.db')), join(parent58, 'a@b'));

    // 成功路径记录按终态收口移除、检出频道有命令与尾行。
    check('成功路径全部记录已收口移除',
      !(state.globalStateMap.get('svnAnywhere.operations') || []).some((r) => r.kind === 'checkout' && r.lockKey?.startsWith(parent58)),
      JSON.stringify(state.globalStateMap.get('svnAnywhere.operations')));
    check('检出频道有 checkout 命令回显与尾行', channelTextOf('SVN Anywhere · 检出').includes('checkout --non-interactive')
      && channelTextOf('SVN Anywhere · 检出').includes('Checked out revision'),
      channelTextOf('SVN Anywhere · 检出').slice(-400));
    rmSync(lab58.lab, { recursive: true, force: true });
  }

  console.log('场景 59：中断续检——半成品构造、只读核验、resume 补全与身份不一致阻断');
  {
    const api = extension.__checkoutTaskApi;
    const lab59 = makeSvnLab();
    const trunk59 = `${lab59.repoUrl}/trunk`;
    seedTrunk(lab59, 'v1');
    const identity59 = remoteIdentityOf(trunk59);
    const head59 = identity59.revision;

    // 半成品构造：完整检出后删除深层（.svn 元数据仍在，宿主被 kill 的残留形态）。
    const partial = join(lab59.lab, 'partial');
    svn(['checkout', '-q', trunk59, partial]);
    rmSync(join(partial, 'sub', 'deep'), { recursive: true, force: true });
    rmSync(join(partial, 'sub', 'b.txt'));
    // 预置 residue-pending 记录并重新 activate（loadPending 恢复记录）。
    state.globalStateMap.set('svnAnywhere.operations', [{
      operationId: 'op-resume-mock', wcRoot: partial, lockKey: partial, kind: 'checkout',
      targetRelPath: '.', nodeKind: 'dir', phase: 'residue-pending', knownRevisions: [],
      updatedAt: Date.now(), url: trunk59, targetPath: partial, pinnedRevision: head59,
      depth: 'infinity', repositoryUuid: identity59.repositoryUuid,
      repositoryRootUrl: identity59.repositoryRootUrl, relativeUrl: identity59.relativeUrl,
    }]);
    await extension.activate(secondContext);

    // 1) 只读核验：resumable；核验不改记录。
    const report59 = await api.verifyCheckoutOnly({
      svnPath: 'svn', targetDir: partial,
      expectation: {
        repositoryUuid: identity59.repositoryUuid,
        repositoryRootUrl: identity59.repositoryRootUrl,
        relativeUrl: identity59.relativeUrl,
        depth: 'infinity', pinnedRevision: head59,
      },
      resultScope: { entryKey: lab59.lab, mode: 'checkout' }, epoch: 1,
    });
    check('只读核验结论 resumable（半成品可续）', report59.kind === 'resumable',
      JSON.stringify(report59).slice(0, 300));
    check('核验不改记录（保持 residue-pending）',
      (state.globalStateMap.get('svnAnywhere.operations') || [])
        .find((r) => r.operationId === 'op-resume-mock')?.phase === 'residue-pending');

    // recordUnavailable 分支：记录不存在时返回供面板提示。
    const unavailable59 = await api.resumeCheckoutTask({
      svnPath: 'svn', operationId: 'op-no-such', lockKey: partial, targetDir: partial,
      url: trunk59, pinnedRevision: head59, depth: 'infinity', identity: identity59,
      entryKey: lab59.lab, initiatorSessionId: 'mock-session-59',
    });
    check('记录不存在 → recordUnavailable（非占用）', unavailable59.ok === false && unavailable59.reason === 'recordUnavailable',
      JSON.stringify(unavailable59).slice(0, 200));

    // 2) resume：核验通过 → cleanup + update 补全深层。
    const resumed59 = await api.resumeCheckoutTask({
      svnPath: 'svn', operationId: 'op-resume-mock', lockKey: partial, targetDir: partial,
      url: trunk59, pinnedRevision: head59, depth: 'infinity', identity: identity59,
      entryKey: lab59.lab, formSnapshot: draftFormOf(trunk59, head59, 'infinity', lab59.lab, 'partial'),
      initiatorSessionId: 'mock-session-59',
    });
    check('resume 启动成功（beginResume 独占通过）', resumed59.ok === true, JSON.stringify(resumed59).slice(0, 200));
    if (resumed59.ok) {
      const done59 = await resumed59.done;
      check('续检完成 success（update 尾行 revision）',
        done59.outcome === 'finished' && done59.result.kind === 'success' && done59.result.revision === head59,
        JSON.stringify(done59).slice(0, 300));
      check('中断深层已补全（missing 条目恢复）', existsSync(join(partial, 'sub', 'deep', 'c.txt'))
        && existsSync(join(partial, 'sub', 'b.txt')));
    }
    check('续检完成记录按终态收口移除',
      !(state.globalStateMap.get('svnAnywhere.operations') || []).some((r) => r.operationId === 'op-resume-mock'),
      JSON.stringify(state.globalStateMap.get('svnAnywhere.operations')));
    check('检出频道记录续检 update 命令', channelTextOf('SVN Anywhere · 检出').includes('update --non-interactive'),
      channelTextOf('SVN Anywhere · 检出').slice(-300));

    // 3) 身份不一致阻断：另一仓库的副本配本仓库的记录参数 → resumeBlocked。
    const otherLab = makeSvnLab();
    const otherSeed = otherLab.checkout('other-seed');
    writeFileSync(join(otherSeed, 'x.txt'), 'other');
    svn(['add', '-q', '--parents', 'x.txt'], otherSeed);
    svn(['commit', '-q', '-m', 'other'], otherSeed);
    const partial2 = join(lab59.lab, 'partial2');
    svn(['checkout', '-q', otherLab.repoUrl, partial2]);
    state.globalStateMap.set('svnAnywhere.operations', [{
      operationId: 'op-resume-mock2', wcRoot: partial2, lockKey: partial2, kind: 'checkout',
      targetRelPath: '.', nodeKind: 'dir', phase: 'residue-pending', knownRevisions: [],
      updatedAt: Date.now(), url: trunk59, targetPath: partial2, pinnedRevision: head59,
      depth: 'infinity', repositoryUuid: identity59.repositoryUuid,
      repositoryRootUrl: identity59.repositoryRootUrl, relativeUrl: identity59.relativeUrl,
    }]);
    await extension.activate(secondContext);
    const blocked59 = await api.resumeCheckoutTask({
      svnPath: 'svn', operationId: 'op-resume-mock2', lockKey: partial2, targetDir: partial2,
      url: trunk59, pinnedRevision: head59, depth: 'infinity', identity: identity59,
      entryKey: lab59.lab, formSnapshot: draftFormOf(trunk59, head59, 'infinity', lab59.lab, 'partial2'),
      initiatorSessionId: 'mock-session-59',
    });
    check('阻断分支 resume 启动成功（重核验在 connecting 窗口内）', blocked59.ok === true, JSON.stringify(blocked59).slice(0, 200));
    if (blocked59.ok) {
      const doneBlocked = await blocked59.done;
      check('重核验失败 → resumeBlocked（VerifyReport 附带，无任务终态 result）',
        doneBlocked.outcome === 'finished' && doneBlocked.result.kind === 'resumeBlocked'
        && doneBlocked.result.verify?.blockReason === 'identityMismatch',
        JSON.stringify(doneBlocked).slice(0, 400));
    }
    check('阻断分支记录回 residue-pending（未终态保留）',
      (state.globalStateMap.get('svnAnywhere.operations') || [])
        .find((r) => r.operationId === 'op-resume-mock2')?.phase === 'residue-pending');
    check('resumeBlocked 结果页写入会话缓存', api.readCachedResult(lab59.lab)?.page?.kind === 'resumeBlocked');
    rmSync(otherLab.lab, { recursive: true, force: true });
    rmSync(lab59.lab, { recursive: true, force: true });
  }

  console.log('场景 60：关闭面板任务继续——后台完成终态写缓存（执行器与面板生命周期解耦）');
  {
    const api = extension.__checkoutTaskApi;
    const lab60 = makeSvnLab();
    const trunk60 = `${lab60.repoUrl}/trunk`;
    seedTrunk(lab60, 'bg');
    const identity60 = remoteIdentityOf(trunk60);
    // wrapper 让 checkout 睡 1.5 秒：制造「面板已关、任务仍在途」的窗口。
    const wrapDir60 = makeTempDir('svn-anywhere-slowwrap-');
    const slowSvn = join(wrapDir60, 'svn-slow.sh');
    writeFileSync(slowSvn, [
      '#!/bin/sh',
      'if [ "$1" = "checkout" ]; then sleep 1.5; fi',
      'exec svn "$@"',
      '',
    ].join('\n'), { mode: 0o755 });
    state.configOverrides = { svnPath: slowSvn };
    try {
      const target60 = join(lab60.lab, 'bg-target');
      const startedAt60 = Date.now();
      const started = api.startCheckoutTask({
        // 不传 svnPath：走配置（指向延迟 wrapper），同真实面板发起链路。
        url: trunk60, pinnedRevision: identity60.revision, depth: 'infinity',
        targetDir: target60, parentDir: lab60.lab, dirName: 'bg-target',
        directMode: false, directDir: '', identity: identity60,
        entryKey: lab60.lab, initiatorSessionId: 'mock-session-60',
        formSnapshot: draftFormOf(trunk60, identity60.revision, 'infinity', lab60.lab, 'bg-target'),
        // 「面板已关」：不注入任何回调订阅（dispose 后执行器仍结算）。
      });
      const done60 = await started.done;
      check('后台完成 success（与面板存活无关）',
        done60.outcome === 'finished' && done60.result.kind === 'success',
        JSON.stringify(done60).slice(0, 300));
      check('任务真实运行了延迟窗口（发起时进程在途）', Date.now() - startedAt60 >= 1400,
        `${Date.now() - startedAt60}ms`);
      check('终态写入会话缓存（executor 后台写入）',
        api.readCachedResult(lab60.lab)?.page?.kind === 'success',
        JSON.stringify(api.readCachedResult(lab60.lab))?.slice(0, 200));
      check('该目标的记录按终态收口移除',
        !(state.globalStateMap.get('svnAnywhere.operations') || [])
          .some((r) => r.lockKey === target60),
        JSON.stringify(state.globalStateMap.get('svnAnywhere.operations')));
    } finally {
      state.configOverrides = undefined;
      rmSync(wrapDir60, { recursive: true, force: true });
      rmSync(lab60.lab, { recursive: true, force: true });
    }
  }

  console.log('场景 61：检出命令入口与面板链路——命令打开面板、检出、取消、关闭重开恢复（真实 file://）');
  {
    const lab61 = makeSvnLab();
    const trunk61 = `${lab61.repoUrl}/trunk`;
    seedTrunk(lab61, 'cmd');
    const parent61 = join(lab61.lab, 'targets');
    mkdirSync(parent61, { recursive: true });

    // 1) 右键目录驱动命令 → 面板创建，表单页带出该父目录。
    await state.registered.get('svnAnywhere.checkout')({ fsPath: parent61, scheme: 'file' });
    let panel61 = [...state.panels].reverse().find((p) => p.viewType === 'svn-anywhere-checkout' && !p.disposed);
    check('命令打开检出面板（webview 创建）', Boolean(panel61),
      `panels=${state.panels.map((p) => p.viewType).join(',')}`);
    panel61.sendReady();
    const formFrame61 = await waitRender(panel61, '仓库 URL');
    check('表单页呈现且父目录带出', Boolean(formFrame61) && formFrame61.html.includes(parent61),
      formFrame61 ? '' : '表单页帧未出现');

    // 2) 填 file:// 仓库 URL → 下一步（真实 svn info 连接检查）→ 核对页。
    let posted = panel61.webview.posted.length;
    panel61.sendAuto({ kind: 'syncInput', fieldId: 'url', value: trunk61, inputRevision: state.intentSeq + 1000 });
    await waitNewRender(panel61, 'trunk', posted);
    posted = panel61.webview.posted.length;
    panel61.sendAuto({ kind: 'checkoutNext' });
    const reviewFrame61 = await waitNewRender(panel61, '开始检出', posted);
    check('连接检查通过进入核对页（固定 revision）', Boolean(reviewFrame61),
      reviewFrame61 ? '' : '核对页帧未出现');

    // 3) 开始检出 → 成功页（真实 svn checkout，默认命名取 URL 末段 trunk）。
    posted = panel61.webview.posted.length;
    panel61.sendAuto({ kind: 'startCheckout' });
    const successFrame61 = await waitNewRender(panel61, '检出完成', posted, 400);
    check('面板内检出成功页', Boolean(successFrame61), successFrame61 ? '' : '成功页帧未出现');
    check('目标目录真实落盘（join(父目录, URL 末段)）',
      existsSync(join(parent61, 'trunk', 'a.txt')) && existsSync(join(parent61, 'trunk', 'sub', 'deep', 'c.txt')));

    // 4) 新建任务 → 第二次检出（慢 svn 保证取消窗口）→ 运行中取消 → 取消结果页。
    posted = panel61.webview.posted.length;
    panel61.sendAuto({ kind: 'newTask' });
    await waitNewRender(panel61, '仓库 URL', posted);
    const wrapDir61 = makeTempDir('svn-anywhere-slowwrap61-');
    const slowSvn61 = join(wrapDir61, 'svn-slow.sh');
    // 检出命令的真实写盘照常（svn 先落全部文件），流式输出逐行放慢——
    // 制造「文件已落地、任务仍在途」的取消窗口：此刻取消即得「已取消，
    // 文件保留」的真实形态（连接期取消则目录尚不存在，同样是合法现场，
    // 但无法断言磁盘保留）。
    writeFileSync(slowSvn61, [
      '#!/bin/sh',
      'if [ "$1" = "checkout" ]; then',
      '  svn "$@" | while IFS= read -r line; do',
      '    printf \'%s\\n\' "$line"',
      '    sleep 0.25',
      '  done',
      '  exit 0',
      'fi',
      'exec svn "$@"',
      '',
    ].join('\n'), { mode: 0o755 });
    const confirmBefore61 = state.confirmResult;
    state.configOverrides = { svnPath: slowSvn61 };
    state.confirmResult = '取消检出';
    try {
      panel61.sendAuto({ kind: 'syncInput', fieldId: 'url', value: `${trunk61}/sub`, inputRevision: state.intentSeq + 1000 });
      posted = panel61.webview.posted.length;
      panel61.sendAuto({ kind: 'checkoutNext' });
      await waitNewRender(panel61, '开始检出', posted);
      posted = panel61.webview.posted.length;
      panel61.sendAuto({ kind: 'startCheckout' });
      // 等取消真正可用：运行页首帧在 connecting 段就渲染「已取得 0 项」，但取消
      // 按钮此刻 disabled（宿主放行表同源拒绝，title 恒带「正在准备」说明不能
      // 作区分标记）；running 段 disabled 属性消失，此刻发送取消才进链路。
      const cancelEnabled61 = (html) => {
        const tag = /<button[^>]*data-intent="cancelTask"[^>]*>/.exec(html)?.[0];
        return tag !== undefined && !tag.includes(' disabled');
      };
      let runningFrame61;
      for (let i = 0; i < 400 && !runningFrame61; i += 1) {
        runningFrame61 = [...panel61.webview.posted.slice(posted)].reverse().find(
          (m) => m.type === 'render' && m.html.includes('已取得 1') && cancelEnabled61(m.html),
        );
        if (!runningFrame61) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      check('运行页进入 running 段（首条文件已取得，取消按钮可用）', Boolean(runningFrame61),
        runningFrame61 ? '' : 'running 帧未出现');
      posted = panel61.webview.posted.length;
      panel61.sendAuto({ kind: 'cancelTask' });
      const canceledFrame61 = await waitNewRender(panel61, '已取消，文件保留', posted, 400);
      check('运行中取消 → 取消结果页（文件保留）', Boolean(canceledFrame61),
        canceledFrame61 ? '' : '取消结果页帧未出现');
      check('取消后文件保留（svn 已写盘的业务文件仍在）',
        existsSync(join(parent61, 'sub')) && existsSync(join(parent61, 'sub', 'b.txt')));
    } finally {
      state.configOverrides = undefined;
      state.confirmResult = confirmBefore61;
      rmSync(wrapDir61, { recursive: true, force: true });
    }

    // 5) 关闭面板 → 同入口重开 → 会话缓存恢复取消结果页（而非新表单）。
    panel61.sendAuto({ kind: 'closePanel' });
    check('面板已关闭', panel61.disposed === true);
    await state.registered.get('svnAnywhere.checkout')({ fsPath: parent61, scheme: 'file' });
    const reopened61 = [...state.panels].reverse().find((p) => p.viewType === 'svn-anywhere-checkout' && !p.disposed);
    check('重开创建新面板实例', Boolean(reopened61) && reopened61 !== panel61);
    reopened61.sendReady();
    const recovered61 = await waitRender(reopened61, '已取消，文件保留');
    check('关闭重开恢复取消结果页（会话缓存命中）', Boolean(recovered61),
      recovered61 ? '' : '恢复帧未出现');

    // 6) 命令面板回退：无参且无活动编辑器 → 弹目录选择框（只可选目录）；取消静默。
    const dialogBefore61 = state.openDialogCalls;
    const panelsBefore61 = state.panels.filter((p) => !p.disposed).length;
    const infoBefore61 = state.information.length;
    state.openDialogResult = undefined;
    await state.registered.get('svnAnywhere.checkout')(undefined);
    const dialogOptions61 = state.openDialogOptions[state.openDialogOptions.length - 1];
    check('无参调用弹目录选择框（canSelectFolders、不可选文件）',
      state.openDialogCalls === dialogBefore61 + 1
        && dialogOptions61?.canSelectFolders === true && dialogOptions61?.canSelectFiles === false,
      JSON.stringify(dialogOptions61));
    check('选择框取消静默：无新面板、无提示',
      state.panels.filter((p) => !p.disposed).length === panelsBefore61
        && state.information.length === infoBefore61);

    // 7) 选择框选中另一目录 → 面板目标切换（结果页未处理 → 确认放弃并切换 → 新表单）。
    const parent61b = join(lab61.lab, 'targets-b');
    mkdirSync(parent61b, { recursive: true });
    state.openDialogResult = [{ fsPath: parent61b }];
    state.confirmResult = '放弃并切换';
    try {
      await state.registered.get('svnAnywhere.checkout')(undefined);
      const switched61 = await waitRender(reopened61, parent61b);
      check('选择框选中回退 → 目标切换确认后新表单带出新父目录', Boolean(switched61),
        switched61 ? '' : '切换后表单帧未出现');
    } finally {
      state.openDialogResult = undefined;
      state.confirmResult = confirmBefore61;
    }
    rmSync(lab61.lab, { recursive: true, force: true });
  }

  /* ---------------- P3 导入任务执行器（真实 file:// svn） ---------------- */

  // 快照/digest/说明 hash 的脚本侧构造（与 core 的规范化口径一致：entries 按
  // path 字典序、字段按 schema 声明序、dirs 排序；说明按 LF 归一 UTF-8 字节）。
  const importSnapshotOf = (items) => {
    const entries = [...items]
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map((item) => ({
        path: item.path, kind: item.kind, size: item.size, mtimeMs: 1,
        ignored: false, unreadable: false, nested: false, unsupported: false,
      }));
    const dirs = [...new Set(items.filter((item) => item.kind === 'dir').map((item) => item.path))].sort();
    return { version: 1, entries, dirs };
  };
  const importSnapshotDigest = (snapshot) =>
    createHash('sha256').update(JSON.stringify(snapshot), 'utf8').digest('hex');
  const importMessageDigest = (message) =>
    createHash('sha256').update(Buffer.from(message.replace(/\r\n|\r/g, '\n'), 'utf8')).digest('hex');
  const importParentIdentity = (parentUrl) => {
    const xml = svn(['info', '--xml', parentUrl]);
    const pick = (re) => re.exec(xml)?.[1] ?? '';
    return {
      repositoryUuid: pick(/<uuid>([^<]+)<\/uuid>/),
      repositoryRootUrl: pick(/<root>([^<]+)<\/root>/),
      lastChangedRevision: Number(pick(/<commit[^>]*revision="(\d+)"/)),
    };
  };
  const importFormOf = (url, sourceDir, message) => ({
    url, urlInput: url, nameMode: 'manual', parentDir: '', dirName: '',
    directMode: false, directDir: '', revMode: 'head', rev: '', depth: 'infinity',
    sourceDir, message,
  });
  const importRecords = () => (state.globalStateMap.get('svnAnywhere.operations') || [])
    .filter((record) => record.kind === 'import');

  console.log('场景 62：P3 导入执行器——正常全链、结果未知核实、merged 收口（真实 file://）');
  {
    const api = extension.__importTaskApi;
    if (!api) {
      throw new Error('扩展未导出 __importTaskApi（自动化驱动出口缺失）');
    }
    // 关闭前面场景存活的面板：其任务移除/结果更新订阅会在导入任务结算时
    // 重跑恢复（按旧入口基准读缓存，作用域不一致即清缓存），干扰断言。
    for (const panel of [...state.panels]) {
      if (!panel.disposed) {
        panel.dispose();
      }
    }

    // 62a 正常导入全链：快照落盘 → begin → import → 证据 A → done → 快照删除 + URL 历史回调。
    const lab62a = makeSvnLab();
    svn(['mkdir', '-q', '-m', 'seed', `${lab62a.repoUrl}/trunk@`]);
    const src62a = join(lab62a.lab, 'src');
    mkdirSync(join(src62a, 'sub'), { recursive: true });
    writeFileSync(join(src62a, 'a.txt'), 'import-a');
    writeFileSync(join(src62a, 'sub', 'b.txt'), 'import-b');
    const snapshot62a = importSnapshotOf([
      { path: 'a.txt', kind: 'file', size: 8 },
      { path: 'sub', kind: 'dir', size: 0 },
      { path: 'sub/b.txt', kind: 'file', size: 8 },
    ]);
    const storage62a = makeTempDir('svn-anywhere-import-storage-');
    const target62a = `${lab62a.repoUrl}/trunk/imported`;
    const succeeded62a = [];
    const progress62a = [];
    const done62a = await api.startImportTask({
      svnPath: 'svn', snapshotDir: storage62a,
      sourceDir: src62a, targetUrl: target62a,
      parentIdentity: importParentIdentity(`${lab62a.repoUrl}/trunk`),
      message: 'mock import message', nameMode: 'manual',
      snapshot: snapshot62a, entryKey: src62a, initiatorSessionId: 'mock-session-62',
      formSnapshot: importFormOf(target62a, src62a, 'mock import message'),
      callbacks: {
        onProgress: (progress) => progress62a.push(progress.count),
        onSucceeded: (info) => succeeded62a.push(info),
      },
    }).done;
    check('导入 success（证据 A → done，附 revision）',
      done62a.outcome === 'finished' && done62a.result.kind === 'success'
        && Number.isInteger(done62a.result.revision),
      JSON.stringify(done62a).slice(0, 300));
    check('远端目标已创建且内容完整',
      svn(['cat', `${target62a}/sub/b.txt@`]).trim() === 'import-b');
    check('流式 Adding 计数（文件与目录共 3 项）',
      progress62a.at(-1) === 3, JSON.stringify(progress62a));
    check('onSucceeded 触发（共用 URL 历史的数据源）',
      succeeded62a.length === 1 && succeeded62a[0].targetUrl === target62a
        && succeeded62a[0].revision === done62a.result.revision,
      JSON.stringify(succeeded62a));
    check('成功后记录终态收口（无 import 记录残留）',
      importRecords().length === 0, JSON.stringify(importRecords()));
    check('成功后快照删除（storage 无 op- 文件）',
      !readdirSync(storage62a).some((name) => name.startsWith('op-')));
    check('导入频道有命令回显与 Committed 尾行',
      channelTextOf('SVN Anywhere · 导入').includes('import --non-interactive')
        && channelTextOf('SVN Anywhere · 导入').includes('Committed revision'),
      channelTextOf('SVN Anywhere · 导入').slice(-300));
    check('成功页写入会话缓存（import 作用域）',
      api.readCachedResult(src62a)?.page?.kind === 'success');
    rmSync(storage62a, { recursive: true, force: true });
    rmSync(lab62a.lab, { recursive: true, force: true });

    // 62b 结果未知核实链：真实提交后构造 unknown 记录 + 快照 → verifyImport
    // committed → done 收口 + 快照删除。
    const lab62b = makeSvnLab();
    svn(['mkdir', '-q', '-m', 'seed', `${lab62b.repoUrl}/trunk@`]);
    const src62b = join(lab62b.lab, 'src-unknown');
    mkdirSync(join(src62b, 'sub'), { recursive: true });
    writeFileSync(join(src62b, 'a.txt'), 'verify-a');
    writeFileSync(join(src62b, 'sub', 'b.txt'), 'verify-b');
    const snapshot62b = importSnapshotOf([
      { path: 'a.txt', kind: 'file', size: 8 },
      { path: 'sub', kind: 'dir', size: 0 },
      { path: 'sub/b.txt', kind: 'file', size: 8 },
    ]);
    const storage62b = makeTempDir('svn-anywhere-import-storage-');
    const target62b = `${lab62b.repoUrl}/trunk/verify-target`;
    const message62b = 'verify-chain message';
    // 模拟「已提交但结果未知」：真实 svn import 已发生，记录与快照按锚点构造。
    const parentIdentity62b = importParentIdentity(`${lab62b.repoUrl}/trunk`);
    svn(['import', '-q', '-m', message62b, src62b, target62b]);
    writeFileSync(join(storage62b, 'op-verify-mock'), JSON.stringify(snapshot62b));
    state.globalStateMap.set('svnAnywhere.operations', [
      ...(state.globalStateMap.get('svnAnywhere.operations') || []),
      {
        operationId: 'op-verify-mock', wcRoot: src62b, lockKey: src62b, kind: 'import',
        targetRelPath: '.', nodeKind: 'dir', phase: 'unknown', knownRevisions: [],
        updatedAt: Date.now(), targetPath: src62b,
        importIntent: {
          targetUrl: target62b, parentIdentity: parentIdentity62b,
          message: message62b, nameMode: 'manual',
          messageHash: importMessageDigest(message62b),
          startedAt: 1,
          summary: { fileCount: 2, totalBytes: 16 },
          snapshotDigest: importSnapshotDigest(snapshot62b),
          fileRefs: 'op-verify-mock',
        },
      },
    ]);
    await extension.activate(secondContext);
    const verify62b = await api.verifyImportTask({
      svnPath: 'svn', snapshotDir: storage62b, operationId: 'op-verify-mock',
      resultScope: { entryKey: src62b, mode: 'import' }, epoch: 1,
    });
    check('核实结论 committed（done 收口 + resolvedRevision）',
      verify62b.conclusion === 'committed' && verify62b.recordSettled === true
        && Number.isInteger(verify62b.revision),
      JSON.stringify(verify62b).slice(0, 300));
    check('核实后记录 finish 移除',
      !importRecords().some((record) => record.operationId === 'op-verify-mock'),
      JSON.stringify(importRecords()));
    check('核实后快照删除', !existsSync(join(storage62b, 'op-verify-mock')));
    rmSync(storage62b, { recursive: true, force: true });
    rmSync(lab62b.lab, { recursive: true, force: true });

    // 62c merged 收口链：目标已存在（空目录）→ import 合并提交 → 证据非 A →
    // unknown outcome=merged → acknowledge 收口（finish + 快照删除）。
    const lab62c = makeSvnLab();
    svn(['mkdir', '-q', '-m', 'seed', `${lab62c.repoUrl}/trunk@`]);
    const src62c = join(lab62c.lab, 'src-merged');
    mkdirSync(src62c, { recursive: true });
    writeFileSync(join(src62c, 'm.txt'), 'merged-m');
    const snapshot62c = importSnapshotOf([{ path: 'm.txt', kind: 'file', size: 7 }]);
    const storage62c = makeTempDir('svn-anywhere-import-storage-');
    const target62c = `${lab62c.repoUrl}/trunk/merged-target`;
    svn(['mkdir', '-q', '-m', 'pre-create', `${target62c}@`]);
    const done62c = await api.startImportTask({
      svnPath: 'svn', snapshotDir: storage62c,
      sourceDir: src62c, targetUrl: target62c,
      parentIdentity: importParentIdentity(`${lab62c.repoUrl}/trunk`),
      message: 'merged-chain message', nameMode: 'auto',
      snapshot: snapshot62c, entryKey: src62c, initiatorSessionId: 'mock-session-62',
      formSnapshot: importFormOf(target62c, src62c, 'merged-chain message'),
    }).done;
    check('合并形态 → merged 结果（保留 revision、不显示为普通成功）',
      done62c.outcome === 'finished' && done62c.result.kind === 'merged'
        && Number.isInteger(done62c.result.revision),
      JSON.stringify(done62c).slice(0, 300));
    const mergedRecords62c = importRecords();
    check('记录转 unknown ∧ outcome=merged ∧ resolvedRevision 落盘',
      mergedRecords62c.length === 1 && mergedRecords62c[0].phase === 'unknown'
        && mergedRecords62c[0].outcome === 'merged'
        && mergedRecords62c[0].resolvedRevision === done62c.result.revision,
      JSON.stringify(mergedRecords62c));
    check('merged 快照保留（acknowledge 前的证据在）',
      readdirSync(storage62c).some((name) => name.startsWith('op-')));
    const ack62c = await api.acknowledgeImportTask(mergedRecords62c[0].operationId, storage62c);
    check('acknowledge 收口 settled', ack62c.settled === true, JSON.stringify(ack62c));
    check('收口后记录移除 + 快照删除',
      importRecords().length === 0
        && !readdirSync(storage62c).some((name) => name.startsWith('op-')),
      JSON.stringify(importRecords()));
    rmSync(storage62c, { recursive: true, force: true });
    rmSync(lab62c.lab, { recursive: true, force: true });
  }

  /* ---------------- P3 导入面板消息级全链（真实 file:// svn） ---------------- */

  console.log('场景 63：P3 导入面板全链——切模式→填源→下一步→预览→勾选→确认→重检→执行→结果（真实 file://）');
  {
    const lab63 = makeSvnLab();
    svn(['mkdir', '-q', '-m', 'seed', `${lab63.repoUrl}/trunk@`]);
    // 面板流程的快照目录经 activate 的 globalStorageUri 挂载（场景 62 尾部
    // 的二次 activate 已将其清空，此处重新挂载专用目录）。
    const storage63 = makeTempDir('svn-anywhere-import-storage-63-');
    await extension.activate({
      subscriptions: [],
      extensionUri: context.extensionUri,
      globalState: context.globalState,
      globalStorageUri: { scheme: 'file', path: storage63, fsPath: storage63, toString: () => `file://${storage63}` },
    });
    // 关闭其他存活面板：其订阅会在导入结算时按旧入口基准重跑，干扰断言。
    for (const panel of [...state.panels]) {
      if (!panel.disposed) {
        panel.dispose();
      }
    }

    // 1) 命令入口打开面板（导入命令入口属下一任务——经既有 checkout 入口 + 模式切换进入）。
    const parent63 = join(lab63.lab, 'work');
    mkdirSync(parent63, { recursive: true });
    await state.registered.get('svnAnywhere.checkout')({ fsPath: parent63, scheme: 'file' });
    const panel63 = [...state.panels].reverse().find((p) => p.viewType === 'svn-anywhere-checkout' && !p.disposed);
    check('面板创建', Boolean(panel63), `panels=${state.panels.map((p) => p.viewType).join(',')}`);
    panel63.sendReady();
    await waitRender(panel63, '仓库 URL');

    // 2) 切 import 模式（新会话无草稿无结果，切换无需确认）。
    panel63.sendAuto({ kind: 'switchP3Mode' });
    const importForm63 = await waitRender(panel63, '本地源目录（未版本控制）');
    check('切换到导入表单', Boolean(importForm63), importForm63 ? '' : '导入表单帧未出现');

    // 3) 源目录（未版本控制的本地目录）与目标 URL、说明。
    const src63 = join(lab63.lab, 'import-src');
    mkdirSync(join(src63, 'sub'), { recursive: true });
    writeFileSync(join(src63, 'a.txt'), 'panel-a');
    writeFileSync(join(src63, 'sub', 'b.txt'), 'panel-b');
    const target63 = `${lab63.repoUrl}/trunk/panel-imported`;
    panel63.sendAuto({ kind: 'syncInput', fieldId: 'sourceDir', value: src63, inputRevision: state.intentSeq + 1000 });
    await waitRender(panel63, src63);
    panel63.sendAuto({ kind: 'syncInput', fieldId: 'url', value: target63, inputRevision: state.intentSeq + 1000 });
    await waitRender(panel63, 'panel-imported');
    panel63.sendAuto({ kind: 'syncInput', fieldId: 'message', value: '面板导入说明', inputRevision: state.intentSeq + 1000 });

    // 4) 下一步：真实 svn info（父）+ ls（目标不存在）→ 核对页 + 范围预览装载。
    panel63.sendAuto({ kind: 'importNext' });
    const review63 = await waitRender(panel63, '我已核对导入范围');
    check('连接检查通过进入核对页（预览装载、含源文件行）',
      Boolean(review63) && review63.html.includes('a.txt') && review63.html.includes('sub/b.txt'),
      review63 ? '' : '核对页帧未出现');

    // 5) 勾选范围确认 → 开始 → 仓库提交确认（modal）→ 第三次比对 + 远端重检 → 真实 svn import → 证据检查。
    panel63.sendAuto({ kind: 'syncInput', fieldId: 'checked', value: 'true', inputRevision: state.intentSeq + 1000 });
    await waitRender(panel63, 'startImport');
    const confirmBefore63 = state.confirmResult;
    state.confirmResult = '确认导入';
    try {
      panel63.sendAuto({ kind: 'startImport' });
      const done63 = await waitNewRender(panel63, 'data-intent="handoffToCheckout"', panel63.webview.posted.length);
      check('面板内导入成功页（证据 A → done）', Boolean(done63),
        done63 ? '' : String(panel63.webview.posted.at(-1)?.html ?? '').slice(0, 300));
      check('远端目标真实创建且内容完整',
        svn(['cat', `${target63}/sub/b.txt@`]).trim() === 'panel-b');
      check('成功后记录终态收口（无 import 记录残留）',
        !(state.globalStateMap.get('svnAnywhere.operations') || []).some((r) => r.kind === 'import'),
        JSON.stringify((state.globalStateMap.get('svnAnywhere.operations') || []).filter((r) => r.kind === 'import')));
      check('URL 历史共用写入（成功时点）',
        (state.globalStateMap.get('svnAnywhere.checkoutUrlHistory') || []).includes(target63),
        JSON.stringify(state.globalStateMap.get('svnAnywhere.checkoutUrlHistory')));
      check('成功后快照删除', !readdirSync(storage63).some((name) => name.startsWith('op-')));
    } finally {
      state.confirmResult = confirmBefore63;
    }

    // 6) 成功页动作：查看原目录（revealFileInOS 指向源目录）。
    panel63.sendAuto({ kind: 'revealSourceDir' });
    check('查看原目录经 revealFileInOS 指向源目录',
      state.executedCommands.some(([cmd, uri]) => cmd === 'revealFileInOS' && uri && uri.fsPath === src63),
      JSON.stringify(state.executedCommands.filter(([cmd]) => cmd === 'revealFileInOS')));

    rmSync(storage63, { recursive: true, force: true });
    rmSync(lab63.lab, { recursive: true, force: true });
  }

  console.log('场景 64：svnAnywhere.importLocal 命令入口——右键目录以 import 模式打开面板、源目录带出、入口级推进（真实 file://）');
  {
    // 场景 63 的面板全链已覆盖核对→确认→执行；本场景只验命令入口形态：
    // 命令触发面板以 import 模式打开 + 源目录带出 + 连接检查进核对页即止。
    const lab64 = makeSvnLab();
    svn(['mkdir', '-q', '-m', 'seed', `${lab64.repoUrl}/trunk@`]);
    // 关闭场景 63 遗留的存活面板（成功页会话），避免入口切换确认干扰断言。
    for (const panel of [...state.panels]) {
      if (!panel.disposed) {
        panel.dispose();
      }
    }

    // 1) 右键目录形态：命令直接以 import 模式打开面板（已纳管与否不在此拦）。
    const src64 = join(lab64.lab, 'import-src');
    mkdirSync(join(src64, 'sub'), { recursive: true });
    writeFileSync(join(src64, 'a.txt'), 'entry-a');
    writeFileSync(join(src64, 'sub', 'b.txt'), 'entry-b');
    const panelsBefore64 = state.panels.filter((p) => !p.disposed).length;
    await state.registered.get('svnAnywhere.importLocal')({ fsPath: src64, scheme: 'file' });
    const panel64 = [...state.panels].reverse().find((p) => p.viewType === 'svn-anywhere-checkout' && !p.disposed);
    check('命令以 import 模式创建面板', Boolean(panel64) && state.panels.filter((p) => !p.disposed).length === panelsBefore64 + 1,
      `panels=${state.panels.map((p) => p.viewType).join(',')}`);
    panel64.sendReady();
    const form64 = await waitRender(panel64, '仓库 URL');
    check('导入表单页呈现且源目录带出（标题=导入、入口键=源目录）',
      Boolean(form64) && form64.html.includes('导入') && form64.html.includes('本地源目录') && form64.html.includes(src64),
      form64 ? '' : '表单页帧未出现');

    // 2) 入口级推进一小步：填目标 URL → 下一步（真实 svn info 父 + ls 目标不存在）→ 核对页预览。
    panel64.sendAuto({ kind: 'syncInput', fieldId: 'url', value: `${lab64.repoUrl}/trunk/entry-imported`, inputRevision: state.intentSeq + 1000 });
    await waitRender(panel64, 'entry-imported');
    panel64.sendAuto({ kind: 'importNext' });
    const review64 = await waitRender(panel64, '我已核对导入范围');
    check('连接检查通过进入核对页（预览含源文件行）',
      Boolean(review64) && review64.html.includes('a.txt') && review64.html.includes('sub/b.txt'),
      review64 ? '' : '核对页帧未出现');

    // 3) 命令面板无路径回退：无参且无活动编辑器 → 弹目录选择框（只可选目录）；取消静默。
    const dialogBefore64 = state.openDialogCalls;
    const infoBefore64 = state.information.length;
    const aliveBefore64 = state.panels.filter((p) => !p.disposed).length;
    state.openDialogResult = undefined;
    await state.registered.get('svnAnywhere.importLocal')(undefined);
    const dialogOptions64 = state.openDialogOptions[state.openDialogOptions.length - 1];
    check('无参调用弹目录选择框（canSelectFolders、不可选文件）',
      state.openDialogCalls === dialogBefore64 + 1
        && dialogOptions64?.canSelectFolders === true && dialogOptions64?.canSelectFiles === false,
      JSON.stringify(dialogOptions64));
    check('选择框取消静默：无新面板、无提示',
      state.panels.filter((p) => !p.disposed).length === aliveBefore64
        && state.information.length === infoBefore64);

    // 4) 右键文件 URI：提示「导入源必须是目录」并弹目录选择框改选源目录。
    const infoBeforeFile64 = state.information.length;
    state.openDialogResult = [{ fsPath: src64 }];
    try {
      await state.registered.get('svnAnywhere.importLocal')({ fsPath: join(src64, 'a.txt'), scheme: 'file' });
      check('文件 URI 提示「导入源必须是目录」并弹选择框',
        state.information.length === infoBeforeFile64 + 1
          && state.information[state.information.length - 1].includes('导入源必须是目录')
          && state.openDialogCalls === dialogBefore64 + 2);
      // 同源目录（同入口键 + import 模式）：面板 reveal 复用，不新开实例。
      check('选择框选中源目录后命中既有会话（同入口 reveal）',
        state.panels.filter((p) => !p.disposed).length === aliveBefore64);
    } finally {
      state.openDialogResult = undefined;
    }

    rmSync(lab64.lab, { recursive: true, force: true });
  }

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
