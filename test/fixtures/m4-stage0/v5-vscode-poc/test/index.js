/**
 * 编辑器集成 PoC：在真实 VS Code Extension Host 中验证
 * 快速差异/行内追溯依赖的装饰、概览标尺、保存事件、活动编辑器切换与清理语义。
 * 结果以 JSONL 追加写入 /tmp/svn-anywhere-vscode-poc/poc-result.jsonl，写完即退出进程。
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const OUT_DIR = process.env.VSCODE_POC_OUT || '/tmp/svn-anywhere-vscode-poc';
function log(obj) {
  fs.appendFileSync(path.join(OUT_DIR, 'poc-result.jsonl'), JSON.stringify(obj) + '\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

exports.run = async function run() {
  const startedAt = Date.now();
  try {
    // 1. API 存在性（快速差异/行内追溯所需面）
    const api = {
      createTextEditorDecorationType: typeof vscode.window.createTextEditorDecorationType,
      setDecorationsOnEditor: typeof vscode.window.activeTextEditor?.setDecorations,
      overviewRulerLane: vscode.OverviewRulerLane,
      decorationRangeBehavior: vscode.DecorationRangeBehavior,
      onDidSaveTextDocument: typeof vscode.workspace.onDidSaveTextDocument,
      onDidChangeActiveTextEditor: typeof vscode.window.onDidChangeActiveTextEditor,
      onDidChangeTextDocument: typeof vscode.workspace.onDidChangeTextDocument,
      onDidCloseTextDocument: typeof vscode.workspace.onDidCloseTextDocument,
      version: vscode.version,
      appName: vscode.env.appName,
    };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-poc-'));
    const file1 = path.join(dir, 'a.txt');
    const file2 = path.join(dir, 'b.txt');
    fs.writeFileSync(file1, Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n'));
    fs.writeFileSync(file2, 'b1\nb2\n');

    const doc1 = await vscode.workspace.openTextDocument(file1);
    const editor1 = await vscode.window.showTextDocument(doc1, { preview: false });

    // 2. 三种装饰类型（修改/新增/删除），含概览标尺与行尾归属
    const modType = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(255, 200, 0, 0.20)',
      overviewRulerColor: 'rgba(255, 200, 0, 0.80)',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      after: { contentText: ' r12 · alice', color: 'rgba(128, 128, 128, 0.90)' },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    const addType = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: 'rgba(0, 200, 0, 0.80)',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      after: { contentText: ' 未提交', color: 'rgba(180, 180, 180, 0.90)' },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    const delType = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: 'rgba(200, 0, 0, 0.80)',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      after: { contentText: ' −2 行', color: 'rgba(180, 120, 120, 0.90)' },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });

    // 3. setDecorations：200 个修改 + 50 个新增 + 20 个删除，计时（单任务占用）
    const modRanges = [];
    for (let i = 0; i < 200; i += 1) modRanges.push(new vscode.Range(i, 0, i, 4));
    const addRanges = [];
    for (let i = 0; i < 50; i += 1) addRanges.push(new vscode.Range(i * 2, 0, i * 2, 4));
    const delRanges = [];
    for (let i = 0; i < 20; i += 1) delRanges.push(new vscode.Range(150 + i, 0, 150 + i, 4));
    const tSet0 = process.hrtime.bigint();
    editor1.setDecorations(modType, modRanges);
    editor1.setDecorations(addType, addRanges);
    editor1.setDecorations(delType, delRanges);
    const tSet1 = process.hrtime.bigint();

    // 4. 关闭开关：清空全部装饰并 dispose 类型
    editor1.setDecorations(modType, []);
    editor1.setDecorations(addType, []);
    editor1.setDecorations(delType, []);

    // 5. 保存事件：编辑 → 保存 → onDidSaveTextDocument 延迟
    const saveEvents = [];
    const saveDisposable = vscode.workspace.onDidSaveTextDocument((d) => {
      saveEvents.push({ uri: d.uri.fsPath, delayFromApplyMs: Date.now() - saveRequestedAt });
    });
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc1.uri, new vscode.Position(0, 0), 'x');
    await vscode.workspace.applyEdit(edit);
    const saveRequestedAt = Date.now();
    await doc1.save();
    for (let i = 0; i < 100 && saveEvents.length === 0; i += 1) await sleep(10);

    // 6. 活动编辑器切换事件与装饰隔离：切到第二个文件，旧编辑器应保留装饰吗？
    //    重新给 editor1 设置装饰，再切换，验证不同编辑器装饰互不影响。
    editor1.setDecorations(modType, modRanges);
    const activeEvents = [];
    const activeDisposable = vscode.window.onDidChangeActiveTextEditor((e) => {
      activeEvents.push(e ? path.basename(e.document.fileName) : null);
    });
    const doc2 = await vscode.workspace.openTextDocument(file2);
    const editor2 = await vscode.window.showTextDocument(doc2, { preview: false });
    for (let i = 0; i < 100 && activeEvents.length === 0; i += 1) await sleep(10);
    editor2.setDecorations(addType, [new vscode.Range(0, 0, 0, 2)]);

    // 7. 10k 行文件的装饰性能（真实宿主 UI 线程）
    const bigFile = path.join(dir, 'big.txt');
    const bigLines = [];
    for (let i = 0; i < 10000; i += 1) bigLines.push(`l${i} some text here to make a realistic line`);
    fs.writeFileSync(bigFile, bigLines.join('\n'));
    const bigDoc = await vscode.workspace.openTextDocument(bigFile);
    const bigEditor = await vscode.window.showTextDocument(bigDoc, { preview: false });
    const bigRanges = [];
    for (let i = 0; i < 10000; i += 10) bigRanges.push(new vscode.Range(i, 0, i, 1));
    const tBig0 = process.hrtime.bigint();
    bigEditor.setDecorations(modType, bigRanges);
    const tBig1 = process.hrtime.bigint();
    bigEditor.setDecorations(modType, []);

    // 8. 清理
    modType.dispose();
    addType.dispose();
    delType.dispose();
    saveDisposable.dispose();
    activeDisposable.dispose();

    log({
      ok: true,
      phase: 'editor-integration',
      api,
      setDecorationsMs: Number(tSet1 - tSet0) / 1e6,
      decorationCounts: { mod: modRanges.length, add: addRanges.length, del: delRanges.length },
      saveEvents,
      saveEventObserved: saveEvents.length > 0,
      activeEvents,
      bigFileSetMs: Number(tBig1 - tBig0) / 1e6,
      bigRanges: bigRanges.length,
      bigLines: bigLines.length,
      totalMs: Date.now() - startedAt,
    });
  } catch (err) {
    log({ ok: false, phase: 'editor-integration', error: String((err && err.stack) || err) });
    process.exitCode = 1;
  } finally {
    // 给日志落盘留时间后退出扩展宿主进程
    setTimeout(() => process.exit(process.exitCode || 0), 300);
  }
};
