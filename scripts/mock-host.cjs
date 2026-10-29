/**
 * mock 宿主验证脚本：拦截 require('vscode')，加载打包产物 out/extension.js，
 * 直接驱动 activate 与注册的命令 handler。除命令骨架场景外，
 * 还用本地 svnadmin + file:// 临时副本驱动真实的更新/状态/清理命令链路。
 * 用法：`pnpm run mock-host`（先构建再运行）。任一场景失败退出码为 1。
 */
const { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } = require('node:fs');
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
  /** showQuickPick 单选面板按 label 匹配返回的项；undefined 表示取消。 */
  quickPickChoice: undefined,
  quickPicks: [],
  /** 说明编辑通知上点的按钮（「使用此说明」确认提交说明）。 */
  messageChoice: '使用此说明',
};

const fakeVscode = {
  ProgressLocation: { Notification: 15 },
  ThemeIcon: class {
    constructor(id) { this.id = id; }
  },
  Uri: {
    parse: (s) => ({ scheme: 'untitled', path: s, toString: () => s }),
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
  },
  workspace: {
    workspaceFolders: [],
    // 说明编辑文档：内容直接取 state.inputResult，配合 messageChoice 模拟确认。
    openTextDocument: async (uri) => ({
      uri,
      fileName: 'svn-commit-message.txt',
      getText: () => state.inputResult ?? '',
    }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
    getConfiguration() {
      return { get: (_key, fallback) => fallback };
    },
  },
  commands: {
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
  const context = { subscriptions: [] };
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
  const secondContext = { subscriptions: [] };
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
