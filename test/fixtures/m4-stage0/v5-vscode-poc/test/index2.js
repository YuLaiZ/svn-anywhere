/**
 * 第二轮 PoC：活动编辑器语义、保存后“重算→装饰”链路、关闭清理，
 * 以及真实 svn diff 命令 + hunk 解析 + 装饰的宿主端到端延迟。
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const OUT_DIR = process.env.VSCODE_POC_OUT || '/tmp/svn-anywhere-vscode-poc';
function log(obj) {
  fs.appendFileSync(path.join(OUT_DIR, 'poc-result.jsonl'), JSON.stringify(obj) + '\n');
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 与快速差异实现同口径的轻量 hunk 解析：返回每个 hunk 的旧/新行区间。 */
function parseUnifiedHunks(text) {
  const hunks = [];
  let file = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('Index: ')) {
      file = line.slice(7);
    } else if (line.startsWith('@@ ')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) {
        hunks.push({
          file,
          oldStart: Number(m[1]),
          oldCount: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newCount: m[4] === undefined ? 1 : Number(m[4]),
        });
      }
    }
  }
  return hunks;
}

function svnDiff(wcPath, relPath) {
  return new Promise((resolve, reject) => {
    execFile(
      'svn',
      ['diff', '--non-interactive', '--internal-diff', '--ignore-properties', '-r', 'BASE', '-x', '-U0', '--', relPath],
      { cwd: wcPath, env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }, timeout: 60000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err && err.code !== 0 && err.code !== 1) return reject(err);
        resolve(stdout);
      },
    );
  });
}

exports.run = async function run() {
  const startedAt = Date.now();
  try {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vscode-poc2-'));
    const file1 = path.join(dir, 'a.txt');
    fs.writeFileSync(file1, Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n'));
    const doc1 = await vscode.workspace.openTextDocument(file1);
    const editor1 = await vscode.window.showTextDocument(doc1, { preview: false });

    const activeAfterShow = vscode.window.activeTextEditor === editor1;

    const modType = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(255, 200, 0, 0.20)',
      overviewRulerColor: 'rgba(255, 200, 0, 0.80)',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      after: { contentText: ' r12 · alice', color: 'rgba(128, 128, 128, 0.90)' },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });

    // 1. 保存后“重算→装饰”链路：模拟 10k 行归属解析后一次性 setDecorations
    const refreshTimings = [];
    const saveDisposable = vscode.workspace.onDidSaveTextDocument((d) => {
      const t0 = process.hrtime.bigint();
      const n = d.lineCount;
      const ranges = [];
      for (let i = 0; i < n; i += 1) ranges.push(new vscode.Range(i, 0, i, 1));
      const editor = vscode.window.activeTextEditor;
      let setMs = null;
      if (editor && editor.document === d) {
        const ts0 = process.hrtime.bigint();
        editor.setDecorations(modType, ranges);
        setMs = Number(process.hrtime.bigint() - ts0) / 1e6;
      }
      refreshTimings.push({ lineCount: n, ranges: ranges.length, parseAndBuildMs: Number(process.hrtime.bigint() - t0) / 1e6, setMs });
    });
    const bigFile = path.join(dir, 'big.txt');
    const bigLines = [];
    for (let i = 0; i < 10000; i += 1) bigLines.push(`l${i} some text here to make a realistic line`);
    fs.writeFileSync(bigFile, bigLines.join('\n'));
    const bigDoc = await vscode.workspace.openTextDocument(bigFile);
    const bigEditor = await vscode.window.showTextDocument(bigDoc, { preview: false });
    const edit = new vscode.WorkspaceEdit();
    edit.insert(bigDoc.uri, new vscode.Position(0, 0), 'x');
    await vscode.workspace.applyEdit(edit);
    const saveT0 = Date.now();
    await bigDoc.save();
    for (let i = 0; i < 200 && refreshTimings.length === 0; i += 1) await sleep(10);
    const saveToRefreshMs = Date.now() - saveT0;

    // 2. 关闭编辑器：onDidCloseTextDocument + 装饰清理
    let closeEvent = null;
    const closeDisposable = vscode.workspace.onDidCloseTextDocument((d) => {
      if (d.uri.fsPath === file1) closeEvent = { uri: d.uri.fsPath, at: Date.now() };
    });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (let i = 0; i < 100 && !closeEvent; i += 1) await sleep(10);

    // 3. 真实 svn diff → 解析 → 装饰（宿主内端到端）
    const WC = process.env.VSCODE_POC_WC || '/tmp/svn-anywhere-vscode-poc/wc-clean';
    const REL = 'diff-target.txt';
    const tCmd0 = process.hrtime.bigint();
    const diffText = await svnDiff(WC, REL);
    const tCmd1 = process.hrtime.bigint();
    const hunks = parseUnifiedHunks(diffText);
    const tParse1 = process.hrtime.bigint();
    const targetFile = path.join(WC, REL);
    const targetDoc = await vscode.workspace.openTextDocument(targetFile);
    const targetEditor = await vscode.window.showTextDocument(targetDoc, { preview: false });
    const decoRanges = [];
    for (const h of hunks) {
      if (h.newCount === 0) continue; // 纯删除 hunk 无工作文件行区间，另行标记
      decoRanges.push(new vscode.Range(h.newStart - 1, 0, h.newStart - 1 + h.newCount - 1, 0));
    }
    const tDeco0 = process.hrtime.bigint();
    targetEditor.setDecorations(modType, decoRanges);
    const tDeco1 = process.hrtime.bigint();

    modType.dispose();
    saveDisposable.dispose();
    closeDisposable.dispose();

    log({
      ok: true,
      phase: 'editor-integration-2',
      activeAfterShow,
      activeEditorIdentityHolds: vscode.window.activeTextEditor === targetEditor,
      refreshTimings,
      saveToRefreshMs,
      closeEventObserved: closeEvent !== null,
      svnE2E: {
        hunks,
        hunkCount: hunks.length,
        commandMs: Number(tCmd1 - tCmd0) / 1e6,
        parseMs: Number(tParse1 - tCmd1) / 1e6,
        decorateMs: Number(tDeco1 - tDeco0) / 1e6,
        totalMs: Number(tDeco1 - tCmd0) / 1e6,
        diffBytes: Buffer.byteLength(diffText),
      },
      totalMs: Date.now() - startedAt,
    });
  } catch (err) {
    log({ ok: false, phase: 'editor-integration-2', error: String((err && err.stack) || err) });
    process.exitCode = 1;
  } finally {
    setTimeout(() => process.exit(process.exitCode || 0), 300);
  }
};
