/**
 * 真实 Extension Development Host 探针：
 * 在 Webview 中验证容器查询、294/400/360 宽度、深色/浅色/高对比度主题、
 * 剪贴板与输入法组合事件；结果按阶段追加到 $EXT_HOST_DIR/ext-host-result.ndjson。
 *
 * 运行（隔离 profile，不影响用户环境）：
 *   EXT_HOST_DIR=/tmp/svn-anywhere-ext-host "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
 *     --extensionDevelopmentPath=<本目录> \
 *     --user-data-dir=$EXT_HOST_DIR/vscode-profile \
 *     --extensions-dir=$EXT_HOST_DIR/vscode-exts \
 *     --disable-workspace-trust --new-window $EXT_HOST_DIR/ext-host-workspace
 *
 * 说明：脚本会自动切换 Light 2026 / Default High Contrast 主题并最终退出 VS Code；
 * 剪贴板在窗口未聚焦时返回 NotAllowedError（Document is not focused），
 * 真实聚焦后的剪贴板验证见人工核对清单。
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const BASE = process.env.EXT_HOST_DIR || '/tmp/svn-anywhere-ext-host';
const OUT = path.join(BASE, 'ext-host-result.ndjson');

function activate() {
  const panel = vscode.window.createWebviewPanel(
    'm4probe', 'M4 ext-host probe', vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = fs.readFileSync(path.join(__dirname, 'ext.html'), 'utf8');
  const log = (obj) => fs.appendFileSync(OUT, JSON.stringify(obj) + '\n');
  log({
    phase: 'activated',
    vscodeVersion: vscode.version,
    colorThemeKind: vscode.window.activeColorTheme.kind,
    themeName: vscode.workspace.getConfiguration('workbench').get('colorTheme'),
  });
  panel.reveal(vscode.ViewColumn.One, false);
  panel.webview.onDidReceiveMessage(async (msg) => {
    log(msg);
    if (msg.phase === 'dark') {
      await vscode.workspace.getConfiguration('workbench').update(
        'colorTheme', 'Light 2026', vscode.ConfigurationTarget.Global
      );
      setTimeout(() => panel.reveal(vscode.ViewColumn.One, false), 1500);
      setTimeout(() => panel.webview.postMessage({ cmd: 'measure-light' }), 2200);
    } else if (msg.phase === 'light') {
      await vscode.workspace.getConfiguration('workbench').update(
        'colorTheme', 'Default High Contrast', vscode.ConfigurationTarget.Global
      );
      setTimeout(() => panel.webview.postMessage({ cmd: 'measure-hc' }), 2200);
    } else if (msg.phase === 'hc') {
      setTimeout(() => vscode.commands.executeCommand('workbench.action.quit'), 1000);
    }
  });
  setTimeout(() => vscode.commands.executeCommand('workbench.action.quit'), 20000);
}
exports.activate = activate;
