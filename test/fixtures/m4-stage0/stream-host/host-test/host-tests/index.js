'use strict';
/**
 * 宿主层 PoC：只读文本 provider、vscode.diff、临时二进制文件。
 * 在 @vscode/test-electron 启动的 VS Code 1.85 扩展宿主内运行；
 * 结果写 $HOST_TEST_RESULT（默认同目录 result.json）。
 */
const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

exports.run = async function run() {
  const out = { vscodeVersion: vscode.version, steps: [] };
  const rec = (name, data) => out.steps.push({ name, ...data });
  let reg;
  try {
    // ---------- 1. 只读文本 provider ----------
    const scheme = 'svn-snapshot-poc';
    const content = 'line1\nline2 changed\nline3\n';
    const provider = {
      provideTextDocumentContent(uri) {
        return uri.path.includes('missing') ? '' : content;
      },
    };
    reg = vscode.workspace.registerTextDocumentContentProvider(scheme, provider);
    const left = vscode.Uri.parse(`${scheme}:/left/text.txt`);
    const right = vscode.Uri.parse(`${scheme}:/right/text.txt`);
    const missing = vscode.Uri.parse(`${scheme}:/left/missing.txt`);

    const doc = await vscode.workspace.openTextDocument(left);
    rec('open-provider-doc', {
      ok: true,
      text: doc.getText(),
      lineCount: doc.lineCount,
      isUntitled: doc.isUntitled,
      uri: doc.uri.toString(),
    });
    const edit = new vscode.WorkspaceEdit();
    edit.replace(left, new vscode.Range(0, 0, 0, 5), 'XXXXX');
    let editApplied = null;
    let editError = null;
    try {
      editApplied = await vscode.workspace.applyEdit(edit);
    } catch (e) {
      editError = String(e);
    }
    rec('edit-provider-doc', { applied: editApplied, error: editError, textAfter: doc.getText() });

    // ---------- 2. vscode.diff ----------
    await vscode.commands.executeCommand('vscode.diff', left, right, 'M4 snapshot POC diff');
    const tabsOf = () =>
      vscode.window.tabGroups.all.flatMap((g) =>
        g.tabs.map((t) => ({
          label: t.label,
          isActive: t.isActive,
          inputCtor: t.input && t.input.constructor && t.input.constructor.name,
          isDiff: t.input instanceof vscode.TabInputTextDiff,
          original: t.input && t.input.original ? t.input.original.toString() : undefined,
          modified: t.input && t.input.modified ? t.input.modified.toString() : undefined,
        })),
      );
    rec('vscode-diff', { tabs: tabsOf() });

    await vscode.commands.executeCommand('vscode.diff', missing, right, 'M4 snapshot POC diff missing-left');
    rec('vscode-diff-missing-left', { tabs: tabsOf() });

    const shown = await vscode.window.showTextDocument(doc, { preview: true });
    rec('show-provider-doc', { visible: shown.visible, documentUri: shown.document.uri.toString() });

    // ---------- 3. 临时二进制文件 ----------
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svn-anywhere-host-bin-'));
    const binPath = path.join(tmp, 'bin.dat');
    fs.writeFileSync(binPath, Buffer.from([0x42, 0x49, 0x4e, 0x00, 0x01, 0x02, 0xff]));
    const binUri = vscode.Uri.file(binPath);
    let binDoc = null;
    let binError = null;
    try {
      const d = await vscode.workspace.openTextDocument(binUri);
      binDoc = { text: d.getText(), lineCount: d.lineCount, uri: d.uri.toString() };
    } catch (e) {
      binError = String(e);
    }
    rec('open-binary-temp', { ok: binDoc !== null, doc: binDoc, error: binError });

    try {
      await vscode.commands.executeCommand('vscode.diff', binUri, right, 'M4 snapshot POC diff binary-left');
      rec('vscode-diff-binary-left', { tabs: tabsOf() });
    } catch (e) {
      rec('vscode-diff-binary-left', { error: String(e) });
    }

    // ---------- 4. 不存在的文件 URI 作为 diff 端 ----------
    try {
      const ghost = vscode.Uri.file(path.join(tmp, 'ghost.txt'));
      await vscode.commands.executeCommand('vscode.diff', ghost, right, 'M4 snapshot POC diff ghost-left');
      rec('vscode-diff-ghost-left', { tabs: tabsOf() });
    } catch (e) {
      rec('vscode-diff-ghost-left', { error: String(e) });
    }
  } catch (e) {
    rec('fatal', { message: String((e && e.stack) || e) });
  } finally {
    try { if (reg) reg.dispose(); } catch { /* ignore */ }
    const resultPath = process.env.HOST_TEST_RESULT || path.join(__dirname, 'result.json');
    fs.writeFileSync(resultPath, JSON.stringify(out, null, 2));
  }
};
