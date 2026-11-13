'use strict';
/**
 * M4 阶段 4 真实 Extension Host 装饰冒烟（F107 快速差异 / F108 行内追溯）。
 *
 * 由 scripts/extension-host-test.mjs 经 --extensionTestsPath 加载：
 *   node scripts/extension-host-test.mjs --extension . --tests test/ext-host/editor-smoke.cjs
 *
 * 覆盖：
 * - 扩展在真实 VS Code 1.85+ 宿主动机中激活，两个编辑器命令已注册且可执行；
 * - 在真实 svnadmin + file:// 隔离仓库的工作副本里打开修改过的文本文件：
 *   开启快速差异 → 状态为 enabled（目标判定 + svn diff + setDecorations 成功）；
 *   再次执行关闭 → 状态 false（装饰清空）；行内追溯同样开关；
 * - 装饰 API 本身（createTextEditorDecorationType / setDecorations）在宿主中
 *   可用性由 scripts/extension-host-test.mjs 的内置冒烟保证。
 *
 * 装饰内容无法经 vscode 公开 API 回读，这里用扩展 activate 返回的开关状态
 * 证明命令链路在真实编辑器中执行（enabled 只在内部 diff/blame 成功并完成
 * setDecorations 后成立）。测试结果写入 $M4_EXT_HOST_OUT/result.json。
 */
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const OUTPUT_DIR = process.env.M4_EXT_HOST_OUT;
const RESULT_FILE = OUTPUT_DIR ? path.join(OUTPUT_DIR, 'result.json') : null;
const checks = [];

function check(name, condition, detail) {
  const ok = Boolean(condition);
  checks.push({ name, ok, detail: detail === undefined ? undefined : String(detail) });
  if (!ok) {
    throw new Error('FAIL ' + name + (detail === undefined ? '' : ': ' + detail));
  }
}

function writeResult(result) {
  if (!RESULT_FILE) {
    return;
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify(Object.assign({ checks }, result), null, 2));
}

const SVN_ENV = { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };

function svn(args, cwd) {
  return execFileSync('svn', args, { cwd, encoding: 'utf8', env: SVN_ENV });
}

/** 创建隔离的 svnadmin + file:// 仓库与工作副本，返回修改过的文本文件路径。 */
function createLab(root) {
  const repoPath = path.join(root, 'repo');
  execFileSync('svnadmin', ['create', repoPath], { encoding: 'utf8', env: SVN_ENV });
  const wc = path.join(root, 'wc');
  fs.mkdirSync(wc, { recursive: true });
  svn(['checkout', '-q', `file://${repoPath}`, '.'], wc);
  const target = path.join(wc, 'smoke.txt');
  // 20 行基线，带末尾换行（零上下文尾部追加 hunk 的稳定形态）。
  fs.writeFileSync(target, Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n');
  svn(['add', '-q', 'smoke.txt'], wc);
  svn(['commit', '-q', '-m', 'baseline'], wc);
  // 修改第 5 行、在旧第 14 行后插入 2 行、尾部追加 1 行。
  const newLines = [
    'line1', 'line2', 'line3', 'line4', 'line5-local', 'line6', 'line7',
    'line8', 'line9', 'line10', 'line11', 'line12', 'line13', 'line14',
    'inserted-a', 'inserted-b',
    'line15', 'line16', 'line17', 'line18', 'line19', 'line20',
    'tail-added',
  ];
  fs.writeFileSync(target, newLines.join('\n') + '\n');
  return { wc, target };
}

exports.run = async function run() {
  const startedAt = Date.now();
  let tempRoot;
  try {
    check('vscode.version 可用', typeof vscode.version === 'string', vscode.version);

    const extension = vscode.extensions.getExtension('yulaiz.svn-anywhere');
    check('扩展已安装并位于 Extension Development Host', extension !== undefined, 'yulaiz.svn-anywhere');
    const api = await extension.activate();
    check('activate 返回编辑器集成 API', api !== undefined && typeof api.isQuickDiffEnabled === 'function', typeof api);
    check('初始状态：快速差异关闭', api.isQuickDiffEnabled() === false);
    check('初始状态：行内追溯关闭', api.isInlineBlameEnabled() === false);

    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svn-anywhere-editor-smoke-'));
    const lab = createLab(tempRoot);

    const document = await vscode.workspace.openTextDocument(lab.target);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    check('活动编辑器指向工作副本文件', vscode.window.activeTextEditor === editor);
    // 23 行内容 + 末尾换行产生的最后一个空行。
    check('文档行数', document.lineCount === 24, document.lineCount);

    // F107：开启 → 内部 status/info/mime 判定 + svn diff -r BASE -x -U0 + 装饰。
    await vscode.commands.executeCommand('svnAnywhere.toggleQuickDiff');
    check('快速差异开启（真实 diff + 装饰调用成功）', api.isQuickDiffEnabled() === true);
    await vscode.commands.executeCommand('svnAnywhere.toggleQuickDiff');
    check('快速差异再次执行关闭，装饰已撤销', api.isQuickDiffEnabled() === false);

    // F108：开启 → 不带 -r 的 svn blame --xml + 逐行 after 装饰。
    await vscode.commands.executeCommand('svnAnywhere.toggleInlineBlame');
    check('行内追溯开启（真实 blame + 装饰调用成功）', api.isInlineBlameEnabled() === true);
    await vscode.commands.executeCommand('svnAnywhere.toggleInlineBlame');
    check('行内追溯再次执行关闭，装饰已撤销', api.isInlineBlameEnabled() === false);

    // 未保存编辑后保存：小文件保存自动刷新链路（再次开启后保存不抛错）。
    await vscode.commands.executeCommand('svnAnywhere.toggleQuickDiff');
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(0, 0), '// saved\n');
    check('WorkspaceEdit 应用到文档', await vscode.workspace.applyEdit(edit));
    await document.save();
    await new Promise((resolve) => setTimeout(resolve, 300));
    check('保存后快速差异仍开启（自动刷新未中断）', api.isQuickDiffEnabled() === true);
    await vscode.commands.executeCommand('svnAnywhere.toggleQuickDiff');
    check('保存刷新后关闭无异常', api.isQuickDiffEnabled() === false);

    writeResult({
      ok: true,
      phase: 'editor-integration-smoke',
      vscodeVersion: vscode.version,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err) {
    writeResult({
      ok: false,
      phase: 'editor-integration-smoke',
      elapsedMs: Date.now() - startedAt,
      error: String((err && err.stack) || err),
    });
    process.exitCode = 1;
  } finally {
    if (tempRoot) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        // 清理失败不影响测试结论。
      }
    }
    setTimeout(() => process.exit(process.exitCode || 0), 300);
  }
};
