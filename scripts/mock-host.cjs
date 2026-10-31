/**
 * mock 宿主验证脚本：拦截 require('vscode')，加载打包产物 out/extension.js，
 * 直接驱动 activate 与注册的命令 handler。除命令骨架场景外，
 * 还用本地 svnadmin + file:// 临时副本驱动真实的更新/状态/清理命令链路。
 * 用法：`pnpm run mock-host`（先构建再运行）。任一场景失败退出码为 1。
 */
const { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync, existsSync, readFileSync } = require('node:fs');
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

/** 搭建含远端提交能力的本地 SVN 实验场，返回两个工作副本与 svn helper。 */
function makeSvnLab() {
  const lab = makeTempDir('svn-anywhere-mock-svn-');
  const repoPath = join(lab, 'repo');
  execFileSync('svnadmin', ['create', repoPath]);
  const repoUrl = `file://${repoPath}`;
  const checkout = (name) => {
    const path = join(lab, name);
    mkdirSync(path, { recursive: true });
    svn(['checkout', '-q', repoUrl, '.'], path);
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

  console.log('场景 11：真实副本「提交」——远端有更新先提示，更新并继续后进入提交入口');
  const probe2 = svnLab.checkout('probe2');
  writeFileSync(join(probe2, 'b.txt'), 'v1');
  svn(['add', '-q', '--parents', 'b.txt'], probe2);
  svn(['commit', '-q', '-m', 'probe2 init'], probe2);
  writeFileSync(join(probe2, 'b.txt'), 'local edit\n');
  writeFileSync(join(remote, 'remote-add.txt'), 'x');
  svn(['add', '-q', '--parents', 'remote-add.txt'], remote);
  svn(['commit', '-q', '-m', 'remote add more'], remote);
  state.confirmResult = '更新并继续';
  const quickPicksBeforeCommit = state.quickPicks.length;
  const warningBeforeCommit = state.warning.length;
  const progressBeforeCommit = state.progressTitles.length;
  const linesBeforeCommitCheck = channelText().length;
  // 对目录驱动：单文件目标的 status -u 查不到其他路径的远端变更。
  await state.registered.get('svnAnywhere.commit')({ fsPath: probe2, scheme: 'file' });
  const commitCheckOutput = channelText().slice(linesBeforeCommitCheck);
  check(
    '弹出远端更新提示',
    state.warning.slice(warningBeforeCommit).some((m) => m.includes('远端更新')),
    JSON.stringify(state.warning.slice(warningBeforeCommit)),
  );
  check('频道写远端检查汇总', commitCheckOutput.includes('远端检查：'));
  check('执行了更新（进度通知）', state.progressTitles.length > progressBeforeCommit);
  check('频道有更新明细与最终 revision', commitCheckOutput.includes('更新完成，当前 revision'));
  check(
    '更新后进入提交面板',
    state.quickPicks.length > quickPicksBeforeCommit &&
      String(state.quickPicks.at(-1)?.title).includes('选择要提交的变更'),
    `面板数 ${state.quickPicks.length}`,
  );
  state.confirmResult = undefined;

  console.log('场景 12：真实副本「提交」——部分勾选提交、revision 回显、空说明');
  const probe3 = svnLab.checkout('probe3');
  writeFileSync(join(probe3, 'b2.txt'), 'v1');
  writeFileSync(join(probe3, 'c2.txt'), 'v1');
  svn(['add', '-q', '--parents', 'b2.txt', 'c2.txt'], probe3);
  svn(['commit', '-q', '-m', 'probe3 init'], probe3);
  writeFileSync(join(probe3, 'b2.txt'), 'committed content\n');
  writeFileSync(join(probe3, 'c2.txt'), 'kept local\n');
  // F91 多行说明：换行必须原样进入远端日志，不能被展平成空格。
  state.inputResult = 'feat: mock host commit\n第二行说明';
  state.quickPickPicked = ['b2.txt'];
  const infoBeforeRealCommit = state.information.length;
  const linesBeforeRealCommit = channelText().length;
  await state.registered.get('svnAnywhere.commit')({ fsPath: probe3, scheme: 'file' });
  const commitOutput = channelText().slice(linesBeforeRealCommit);
  check('频道含 Committed revision 输出', commitOutput.includes('Committed revision'), commitOutput.slice(-600));
  check(
    '弹提交成功提示含 revision',
    state.information.slice(infoBeforeRealCommit).some((m) => m.includes('提交成功，revision')),
    JSON.stringify(state.information.slice(infoBeforeRealCommit)),
  );
  // F29 部分提交：未勾选的 c2.txt 保持本地变更（提交后状态报告可见）。
  check('未勾选项保持本地变更', commitOutput.includes('[modified] c2.txt'), commitOutput.slice(-400));
  const remoteCheck = svn(['cat', `${svnLab.repoUrl}/b2.txt`]);
  check('远端确实收到新内容', remoteCheck.includes('committed content'));
  const logLines = svn(['log', '-r', 'HEAD', svnLab.repoUrl]).split('\n').map((l) => l.trim());
  check(
    '多行说明原样进入远端日志',
    logLines.includes('feat: mock host commit') && logLines.includes('第二行说明'),
    JSON.stringify(logLines),
  );

  // F24/F80：空说明提交（开关默认允许，空说明二次确认）。
  state.inputResult = '';
  state.confirmResult = '继续';
  state.quickPickPicked = ['c2.txt'];
  const infoBeforeEmpty = state.information.length;
  await state.registered.get('svnAnywhere.commit')({ fsPath: probe3, scheme: 'file' });
  check(
    '空说明提交成功',
    state.information.slice(infoBeforeEmpty).some((m) => m.includes('提交成功，revision')),
    JSON.stringify(state.information.slice(infoBeforeEmpty)),
  );
  check('空说明弹了二次确认', state.warning.some((m) => m.includes('提交说明为空')));
  state.inputResult = undefined;
  state.confirmResult = undefined;
  state.quickPickPicked = undefined;

  console.log('场景 13：真实副本「提交」missing——svn delete --force 后提交删除远端文件');
  writeFileSync(join(probe3, 'drop.txt'), 'to delete');
  svn(['add', '-q', '--parents', 'drop.txt'], probe3);
  svn(['commit', '-q', '-m', 'add drop'], probe3);
  rmSync(join(probe3, 'drop.txt'));
  state.inputResult = 'chore: drop file';
  state.confirmResult = '继续';
  const linesBeforeMissing = channelText().length;
  const infoBeforeMissing = state.information.length;
  await state.registered.get('svnAnywhere.commit')({ fsPath: probe3, scheme: 'file' });
  const missingOutput = channelText().slice(linesBeforeMissing);
  check('missing 确认弹窗出现', state.warning.some((m) => m.includes('未登记 SVN 删除')));
  check('commit 输出含删除行 Deleting', missingOutput.includes('Deleting       drop.txt'), missingOutput.slice(-600));
  check(
    '提交成功提示',
    state.information.slice(infoBeforeMissing).some((m) => m.includes('提交成功，revision')),
  );
  let remoteMissing = false;
  try {
    svn(['cat', `${svnLab.repoUrl}/drop.txt`]);
    remoteMissing = false;
  } catch {
    remoteMissing = true;
  }
  check('远端文件已被删除', remoteMissing);
  state.inputResult = undefined;
  state.confirmResult = undefined;

  console.log('场景 14：真实副本「忽略设置」——自定义模式写回，status 不再显示');
  const probe5 = svnLab.checkout('probe5');
  mkdirSync(join(probe5, 'src'), { recursive: true });
  writeFileSync(join(probe5, 'src', '.keep'), '');
  svn(['add', '-q', '--parents', join('src', '.keep')], probe5);
  svn(['commit', '-q', '-m', 'probe5 init'], probe5);
  writeFileSync(join(probe5, 'src', 'noise.log'), 'log');
  state.quickPickChoice = '输入自定义模式（如 *.log）';
  state.inputResult = '*.log';
  const infoBeforeIgnore = state.information.length;
  const linesBeforeIgnore = channelText().length;
  await state.registered.get('svnAnywhere.editIgnore')({ fsPath: join(probe5, 'src', 'noise.log'), scheme: 'file' });
  const ignoreOutput = channelText().slice(linesBeforeIgnore);
  check('频道写 svn:ignore 更新结果', ignoreOutput.includes('svn:ignore 已更新：*.log'), ignoreOutput.slice(-400));
  check(
    '弹本地变更提示',
    state.information.slice(infoBeforeIgnore).some((m) => m.includes('本地变更') && m.includes('提交')),
  );
  check('被忽略文件不再出现在 status', !svn(['status'], probe5).includes('noise.log'));
  state.quickPickChoice = undefined;
  state.inputResult = undefined;

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

  console.log('场景 19：嵌套目录与带空格文件的真实差异、选择提交和 missing 删除范围');
  const nestedLab = makeSvnLab();
  const nestedWc = nestedLab.checkout('nested');
  mkdirSync(join(nestedWc, 'src', 'src'), { recursive: true });
  const nestedNames = ['src/item.txt', 'src/src/item.txt', 'src/ report.txt ', 'src/report.txt', 'src/drop.txt', 'src/src/drop.txt'];
  for (const name of nestedNames) writeFileSync(join(nestedWc, name), `baseline ${name}\n`);
  svn(['add', '-q', 'src'], nestedWc);
  svn(['commit', '-q', '-m', 'nested baseline'], nestedWc);
  for (const name of nestedNames) writeFileSync(join(nestedWc, name), `modified ${name}\n`);
  state.quickPickPicked = ['src/item.txt'];
  state.quickPickDiff = 'src/item.txt';
  state.inputResult = undefined;
  const beforeNestedDiff = channelText().length;
  await state.registered.get('svnAnywhere.commit')({ fsPath: join(nestedWc, 'src'), scheme: 'file' });
  for (let retry = 0; retry < 100 && !channelText().slice(beforeNestedDiff).includes('+modified src/item.txt'); retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const nestedDiff = channelText().slice(beforeNestedDiff);
  check('嵌套目录差异指向选中项', nestedDiff.includes('+modified src/item.txt') && !nestedDiff.includes('+modified src/src/item.txt'), nestedDiff.slice(-600));
  state.quickPickDiff = undefined;
  state.inputResult = 'commit selected nested path';
  await state.registered.get('svnAnywhere.commit')({ fsPath: join(nestedWc, 'src'), scheme: 'file' });
  check('嵌套目录提交选中项，未误提交同名深层项',
    svn(['cat', `${nestedLab.repoUrl}/src/item.txt`]).startsWith('modified') &&
    svn(['cat', `${nestedLab.repoUrl}/src/src/item.txt`]).startsWith('baseline'));
  check('未选中同名深层项仍为本地修改', svn(['status'], nestedWc).includes('src/src/item.txt'));

  state.quickPickPicked = ['src/ report.txt '];
  await state.registered.get('svnAnywhere.commit')({ fsPath: join(nestedWc, 'src', ' report.txt '), scheme: 'file' });
  check('文件入口与首尾空格保留准确目标',
    svn(['cat', '-r', 'HEAD', 'src/ report.txt '], nestedWc).startsWith('modified') &&
    svn(['cat', '-r', 'HEAD', 'src/report.txt'], nestedWc).startsWith('baseline'));

  rmSync(join(nestedWc, 'src', 'drop.txt'));
  state.quickPickPicked = ['src/drop.txt'];
  state.confirmResult = '继续';
  await state.registered.get('svnAnywhere.commit')({ fsPath: join(nestedWc, 'src'), scheme: 'file' });
  check('嵌套 missing 只删除选中目标，保留同名深层文件',
    !svn(['list', `${nestedLab.repoUrl}/src`]).split('\n').includes('drop.txt') &&
    svn(['cat', `${nestedLab.repoUrl}/src/src/drop.txt`]).startsWith('baseline') &&
    svn(['status'], nestedWc).includes('src/src/drop.txt'));
  state.inputResult = undefined;
  state.confirmResult = undefined;
  state.quickPickPicked = undefined;
  rmSync(nestedLab.lab, { recursive: true, force: true });

  console.log('场景 20：无法精确忽略的换行/回车名称不写入属性或误忽略其他文件');
  const specialLab = makeSvnLab();
  const specialWc = specialLab.checkout('special');
  for (const name of ['foo\nbar', 'foo\rbar', 'foo', 'bar']) writeFileSync(join(specialWc, name), 'unversioned');
  for (const name of ['foo\nbar', 'foo\rbar']) {
    state.quickPickChoice = `把「${name}」加入忽略`;
    const warningsBefore = state.warning.length;
    await state.registered.get('svnAnywhere.editIgnore')({ fsPath: join(specialWc, name), scheme: 'file' });
    check('不可编码名称给可读提示 ' + JSON.stringify(name), state.warning.slice(warningsBefore).some((message) => message.includes('无法表示为一条精确忽略规则')));
  }
  check('拒绝前未写 svn:ignore', !svn(['proplist', '--xml', '.'], specialWc).includes('svn:ignore'));
  check('相近名称没有被忽略', !svn(['status', '--no-ignore', '--xml', '.'], specialWc).includes('item="ignored"'));
  state.quickPickChoice = undefined;

  console.log('场景 21：控制字符与字面实体邻名在完整提交入口保持不同身份');
  const literalNames = ['foo&#10;bar', 'foo&#13;bar', 'foo&#9;bar'];
  for (const name of literalNames) {
    writeFileSync(join(specialWc, name), 'literal baseline');
    svn(['add', '-q', '--', name], specialWc);
  }
  svn(['commit', '-q', '-m', 'literal entities baseline'], specialWc);
  for (const name of literalNames) writeFileSync(join(specialWc, name), 'literal modified');
  state.quickPickPicked = ['foo\nbar'];
  state.inputResult = 'try invalid control path';
  const revisionBeforeControl = svn(['info', '--show-item', 'revision', specialLab.repoUrl]);
  await state.registered.get('svnAnywhere.commit')({ fsPath: specialWc, scheme: 'file' });
  const specialLabels = state.quickPicks.at(-1).items.map((item) => item.label);
  check('面板保留换行与字面实体的不同身份', specialLabels.includes('foo\nbar') && specialLabels.includes('foo&#10;bar'));
  check('不支持的控制字符目标不会转而提交字面邻名',
    svn(['info', '--show-item', 'revision', specialLab.repoUrl]) === revisionBeforeControl &&
    svn(['cat', '-r', 'HEAD', 'foo&#10;bar'], specialWc) === 'literal baseline');
  state.quickPickPicked = ['foo&#10;bar'];
  await state.registered.get('svnAnywhere.commit')({ fsPath: specialWc, scheme: 'file' });
  check('选择字面实体只提交该文件',
    svn(['cat', '-r', 'HEAD', 'foo&#10;bar'], specialWc) === 'literal modified' &&
    svn(['cat', '-r', 'HEAD', 'foo&#13;bar'], specialWc) === 'literal baseline');

  console.log('场景 22：短横线选项邻名和 @ 邻名的真实状态/差异/提交/删除范围');
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
  for (const [name, expected, unexpected] of [
    [optionName, '+OPTION-SELECTED-CHANGE', '+DECOY-CHANGE'],
    ['a@1', '+AT-SELECTED-CHANGE', '+AT-NEIGHBOR-CHANGE'],
    ['a@1@', '+AT-NEIGHBOR-CHANGE', '+AT-SELECTED-CHANGE'],
  ]) {
    state.quickPickPicked = [name];
    state.quickPickDiff = name;
    state.inputResult = undefined;
    const before = channelText().length;
    await state.registered.get('svnAnywhere.commit')({ fsPath: specialWc, scheme: 'file' });
    for (let retry = 0; retry < 100 && !channelText().slice(before).includes(expected); retry += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const output = channelText().slice(before);
    check('特殊目标差异不指向邻名 ' + name, output.includes(expected) && !output.includes(unexpected), output.slice(-600));
  }
  state.quickPickDiff = undefined;
  state.quickPickPicked = undefined;
  state.inputResult = 'commit literal option file';
  await state.registered.get('svnAnywhere.commit')({ fsPath: join(specialWc, optionName), scheme: 'file' });
  check('短横线文件入口状态和提交均安全，未读取 manifest 误提交',
    svn(['cat', '-r', 'HEAD', '--', './--targets=manifest'], specialWc) === 'OPTION-SELECTED-CHANGE' &&
    svn(['cat', '-r', 'HEAD', 'decoy.txt'], specialWc) === 'decoy baseline');
  state.quickPickPicked = ['a@1'];
  await state.registered.get('svnAnywhere.commit')({ fsPath: specialWc, scheme: 'file' });
  check('含 @ 的提交保留 peg 语义且不提交末尾 @ 邻名',
    svn(['cat', '-r', 'HEAD', 'a@1@'], specialWc) === 'AT-SELECTED-CHANGE' &&
    svn(['cat', '-r', 'HEAD', 'a@1@@'], specialWc) === 'neighbor baseline');
  rmSync(join(specialWc, optionName));
  state.quickPickPicked = [optionName];
  state.confirmResult = '继续';
  await state.registered.get('svnAnywhere.commit')({ fsPath: specialWc, scheme: 'file' });
  check('短横线 missing 登记删除只作用于目标',
    !svn(['list', specialLab.repoUrl]).split('\n').includes(optionName) &&
    svn(['cat', '-r', 'HEAD', 'decoy.txt'], specialWc) === 'decoy baseline');
  state.quickPickPicked = undefined;
  state.inputResult = undefined;
  state.confirmResult = undefined;
  rmSync(specialLab.lab, { recursive: true, force: true });

  console.log('场景 23：状态面板——创建、CSP 骨架、渲染与单文件差异（真实副本）');
  const panelLab = makeSvnLab();
  const panelWc = panelLab.checkout('panel-wc');
  mkdirSync(join(panelWc, 'src'), { recursive: true });
  writeFileSync(join(panelWc, 'src', 'a.txt'), 'base content\n');
  writeFileSync(join(panelWc, 'src', 'prop-dir.txt'), 'x');
  writeFileSync(join(panelWc, 'src', 'bin.img'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]));
  svn(['add', '-q', 'src'], panelWc);
  svn(['commit', '-q', '-m', 'panel baseline'], panelWc);
  writeFileSync(join(panelWc, 'src', 'a.txt'), 'work content\n');
  writeFileSync(join(panelWc, 'src', 'new.txt'), 'unversioned body');
  svn(['propset', '-q', 'svn:ignore', 'tmp', 'src'], panelWc);
  const panelsBefore = state.panels.length;
  await state.registered.get('svnAnywhere.showStatusPanel')({ fsPath: panelWc, scheme: 'file' });
  check('创建了一个 webview 面板', state.panels.length === panelsBefore + 1, `面板数 ${state.panels.length}`);
  const panel = state.panels.at(-1);
  check('HTML 骨架含 CSP/nonce/asWebviewUri 资源',
    panel.webview.html.includes("default-src 'none'") &&
    /script-src 'nonce-[0-9a-f]+/.test(panel.webview.html) &&
    panel.webview.html.includes('vscode-webview://fake/mock-ext/media/panel.js'),
    panel.webview.html.slice(0, 400));
  panel.sendReady();
  const firstRender = panel.webview.posted.find((m) => m.type === 'render');
  check('ready 后收到首帧 render（协议版本 1、含会话 ID）',
    firstRender && firstRender.protocolVersion === 1 && typeof firstRender.sessionId === 'string' &&
    firstRender.revision >= 1 && firstRender.html.includes('class="panel"'),
    JSON.stringify(firstRender ?? {}).slice(0, 200));
  // 首帧是忙碌态，等待数据帧（runStatus 完成后推送）。
  for (let retry = 0; retry < 100 && !panel.webview.posted.some((m) => m.type === 'render' && m.html.includes('src/a.txt')); retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const dataRender = [...panel.webview.posted].reverse().find((m) => m.type === 'render' && m.html.includes('src/a.txt'));
  check('渲染包含 modified 原词与 unversioned 行',
    dataRender && dataRender.html.includes('modified') && dataRender.html.includes('src/new.txt'),
    dataRender ? dataRender.html.slice(0, 300) : '未等到数据帧');
  check('unversioned 行差异按钮禁用并给原因',
    dataRender && dataRender.html.match(/data-item-id="src\/new\.txt"[^>]*/)?.[0]?.includes('disabled') === true,
    dataRender ? dataRender.html.match(/data-item-id="src\/new\.txt"[^>]*/)?.[0] : '未等到数据帧');

  console.log('场景 24：面板意图——单文件差异、属性差异与能力边界');
  const commandsBeforeDiff = state.executedCommands.length;
  panel.sendIntent({ kind: 'openDiff', itemId: 'src/a.txt' }, dataRender.sessionId, 1);
  for (let retry = 0; retry < 100 && state.executedCommands.length === commandsBeforeDiff; retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const diffCall = state.executedCommands.at(-1);
  check('modified 打开 vscode.diff 并排差异',
    diffCall && diffCall[0] === 'vscode.diff',
    JSON.stringify(state.executedCommands.slice(commandsBeforeDiff)).slice(0, 300));
  if (diffCall && diffCall[0] === 'vscode.diff') {
    const baseContent = readFileSync(diffCall[1].path, 'utf8');
    check('差异左端是 BASE 内容', baseContent === 'base content\n', baseContent);
    check('差异右端是工作文件', diffCall[2].path === join(panelWc, 'src', 'a.txt'), diffCall[2].path);
    // 关闭差异文档 → 临时资源释放。
    state.closeDocHandlers.forEach((cb) => cb({ uri: diffCall[1] }));
    check('关闭差异后临时 BASE 文件已释放', !existsSync(diffCall[1].path), diffCall[1].path);
  }
  const propCommands = state.executedCommands.length;
  panel.sendIntent({ kind: 'openDiff', itemId: 'src' }, dataRender.sessionId, 2);
  for (let retry = 0; retry < 100 && state.executedCommands.length === propCommands; retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  check('纯属性目录走属性差异（不打开文本 diff，写输出频道）',
    !state.executedCommands.slice(propCommands).some((args) => args[0] === 'vscode.diff') &&
    channelText().includes('属性差异'),
    channelText().slice(-400));
  const forgedCommands = state.executedCommands.length;
  panel.sendIntent({ kind: 'openDiff', itemId: 'src/new.txt' }, dataRender.sessionId, 3);
  panel.sendIntent({ kind: 'openDiff', itemId: 'not-exist' }, dataRender.sessionId, 4);
  panel.sendIntent({ kind: 'openDiff', itemId: 'src/a.txt' }, 'stale-session', 5);
  await new Promise((resolve) => setTimeout(resolve, 100));
  check('伪造/越权/旧会话意图不触发差异',
    state.executedCommands.length === forgedCommands,
    JSON.stringify(state.executedCommands.slice(forgedCommands)).slice(0, 200));
  const invalidToastBefore = panel.webview.posted.length;
  panel.send({ type: 'intent', protocolVersion: 99, sessionId: dataRender.sessionId, requestId: 'x', intent: { kind: 'refresh' } });
  check('协议版本不兼容被拒绝并 toast 原因',
    panel.webview.posted.slice(invalidToastBefore).some((m) => m.type === 'toast' && m.message.includes('协议版本不兼容')),
    JSON.stringify(panel.webview.posted.slice(invalidToastBefore).slice(0, 2)));

  console.log('场景 25：面板生命周期——同目标复用、目标切换、忙碌拒绝与迟到结果');
  const panelsBeforeReuse = state.panels.length;
  await state.registered.get('svnAnywhere.showStatusPanel')({ fsPath: panelWc, scheme: 'file' });
  check('同目标再次调用复用面板并 reveal',
    state.panels.length === panelsBeforeReuse && panel.revealed === 1,
    `panels=${state.panels.length} revealed=${panel.revealed}`);
  const panelWc2 = panelLab.checkout('panel-wc2');
  writeFileSync(join(panelWc2, 'b.txt'), 'v2\n');
  const panelsBeforeSwitch = state.panels.length;
  await state.registered.get('svnAnywhere.showStatusPanel')({ fsPath: panelWc2, scheme: 'file' });
  check('不同目标切换复用同一面板实例（不新建）', state.panels.length === panelsBeforeSwitch);
  for (let retry = 0; retry < 100 && ![...panel.webview.posted].reverse().some((m) => m.type === 'render' && m.html.includes('b.txt')); retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const secondRender = [...panel.webview.posted].reverse().find((m) => m.type === 'render' && m.html.includes('b.txt'));
  check('切换后渲染新目标会话（含 b.txt）',
    secondRender && secondRender.sessionId !== dataRender.sessionId,
    JSON.stringify(secondRender ?? {}).slice(0, 200));
  // 旧会话迟到结果：直接向旧 sessionId 发意图应被忽略。
  const lateCommands = state.executedCommands.length;
  panel.sendIntent({ kind: 'openDiff', itemId: 'src/a.txt' }, firstRender.sessionId, 6);
  await new Promise((resolve) => setTimeout(resolve, 100));
  check('旧会话迟到意图不再执行', state.executedCommands.length === lateCommands);
  // 忙碌拒绝切换：refresh 进行中切新目标。
  panel.sendIntent({ kind: 'refresh' }, secondRender.sessionId, 7);
  const warningBeforeBusy = state.warning.length;
  const panelWc3 = panelLab.checkout('panel-wc3');
  writeFileSync(join(panelWc3, 'c.txt'), 'v3\n');
  await state.registered.get('svnAnywhere.showStatusPanel')({ fsPath: panelWc3, scheme: 'file' });
  check('忙碌期间拒绝切换目标并提示',
    state.warning.slice(warningBeforeBusy).some((m) => m.includes('拒绝切换')),
    JSON.stringify(state.warning.slice(warningBeforeBusy)));
  for (let retry = 0; retry < 100 && channelText().includes('正在读取…'); retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  console.log('场景 26：面板销毁——dispose 后迟到结果与二次打开');
  const lastSessionRender = [...panel.webview.posted].reverse().find((m) => m.type === 'render');
  panel.dispose();
  const postedAfterDispose = panel.webview.posted.length;
  panel.sendIntent({ kind: 'openDiff', itemId: 'b.txt' }, lastSessionRender.sessionId, 8);
  panel.sendReady();
  await new Promise((resolve) => setTimeout(resolve, 100));
  check('销毁后不再有任何消息更新', panel.webview.posted.length === postedAfterDispose);
  await state.registered.get('svnAnywhere.showStatusPanel')({ fsPath: panelWc, scheme: 'file' });
  const reopened = state.panels.at(-1);
  check('销毁后再次打开创建新面板', reopened !== panel && state.panels.length === panelsBeforeReuse + 1);
  reopened.sendReady();
  for (let retry = 0; retry < 100 && !reopened.webview.posted.some((m) => m.type === 'render' && m.html.includes('src/a.txt')); retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const reopenedRender = [...reopened.webview.posted].reverse().find((m) => m.type === 'render' && m.html.includes('src/a.txt'));
  check('新面板新会话渲染同一目标',
    reopenedRender && reopenedRender.sessionId !== lastSessionRender.sessionId && reopenedRender.html.includes('src/a.txt'),
    JSON.stringify(reopenedRender ?? {}).slice(0, 200));
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
