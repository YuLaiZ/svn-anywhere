#!/usr/bin/env node
/**
 * 真实 VS Code Extension Host 冒烟测试入口（M4 阶段 4 编辑器装饰验收复用）。
 *
 * 做两件事：
 * 1. 生成一个最小扩展包 + 测试入口（未指定 --extension/--tests 时），
 *    或直接使用调用方指定的扩展根目录与测试入口模块；
 * 2. 用本机 VS Code CLI 以 --extensionDevelopmentPath + --extensionTestsPath
 *    启动 Extension Host，在真实 vscode API 环境执行测试，收集 result.json。
 *
 * 默认冒烟覆盖：OverviewRulerLane / DecorationRangeBehavior 枚举、
 * createTextEditorDecorationType、setDecorations 更新与清空、
 * onDidSaveTextDocument 触发与退订。阶段 4 的快速差异/行内追溯验收可复用
 * 本脚本的启动链路：--extension <项目根> --tests <验收测试入口>。
 *
 * 与阶段 0 PoC（test/fixtures/m4-stage0/v5-vscode-poc/run-vscode-poc.sh）
 * 使用同一 VS Code CLI 直启方式，不新增 @vscode/test-electron 依赖。
 */
import {
  accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RESULT_NAME = 'result.json';
const DEFAULT_TIMEOUT_MS = 180_000;

const SMOKE_SOURCE = `'use strict';
/**
 * 自动生成的最小冒烟测试：在真实 Extension Host 内验证编辑器装饰与保存事件链路。
 * 由 scripts/extension-host-test.mjs 写入，经 --extensionTestsPath 加载。
 */
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
  fs.writeFileSync(RESULT_FILE, JSON.stringify(Object.assign({ checks }, result), null, 2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition, attempts, intervalMs) {
  for (let i = 0; i < attempts; i += 1) {
    if (condition()) {
      return true;
    }
    await sleep(intervalMs);
  }
  return false;
}

exports.run = async function run() {
  const startedAt = Date.now();
  let tempDir;
  try {
    check('vscode.version 可用', typeof vscode.version === 'string', vscode.version);
    check('OverviewRulerLane.Right', vscode.OverviewRulerLane.Right === 4, vscode.OverviewRulerLane.Right);
    check('OverviewRulerLane.Full', vscode.OverviewRulerLane.Full === 7, vscode.OverviewRulerLane.Full);
    check('DecorationRangeBehavior.ClosedClosed', vscode.DecorationRangeBehavior.ClosedClosed === 1, vscode.DecorationRangeBehavior.ClosedClosed);

    const decorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(255, 200, 0, 0.20)',
      overviewRulerColor: 'rgba(255, 200, 0, 0.80)',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      after: { contentText: ' ext-host smoke', color: 'rgba(128, 128, 128, 0.90)' },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    check('createTextEditorDecorationType 返回 key', typeof decorationType.key === 'string' && decorationType.key.length > 0, decorationType.key);

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svn-anywhere-ext-host-'));
    const targetFile = path.join(tempDir, 'smoke.txt');
    fs.writeFileSync(targetFile, ['alpha', 'beta', 'gamma'].join('\\n'));

    const document = await vscode.workspace.openTextDocument(targetFile);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    check('activeTextEditor 指向新编辑器', vscode.window.activeTextEditor === editor);
    check('文档行数', document.lineCount === 3, document.lineCount);

    // 装饰集合可更新、可清空；真实 API 以不抛错为可用判据。
    editor.setDecorations(decorationType, [new vscode.Range(0, 0, 0, 5)]);
    editor.setDecorations(decorationType, [
      new vscode.Range(1, 0, 1, 4),
      new vscode.Range(2, 0, 2, 5),
    ]);
    editor.setDecorations(decorationType, []);
    checks.push({ name: 'setDecorations 更新与清空无异常', ok: true });

    // 保存事件：注册 -> 修改并保存 -> 触发；dispose 后不再触发。
    const savedPaths = [];
    const subscription = vscode.workspace.onDidSaveTextDocument((saved) => {
      savedPaths.push(saved.uri.fsPath);
    });
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(0, 0), '# ');
    const applied = await vscode.workspace.applyEdit(edit);
    check('WorkspaceEdit 应用到文档', applied === true, applied);
    await document.save();
    const saved = await waitFor(() => savedPaths.includes(targetFile), 200, 10);
    check('onDidSaveTextDocument 在保存后触发', saved, JSON.stringify(savedPaths));

    subscription.dispose();
    const edit2 = new vscode.WorkspaceEdit();
    edit2.insert(document.uri, new vscode.Position(0, 0), '## ');
    await vscode.workspace.applyEdit(edit2);
    await document.save();
    await sleep(150);
    check('dispose 后保存事件不再触发', savedPaths.length === 1, JSON.stringify(savedPaths));

    decorationType.dispose();
    writeResult({ ok: true, phase: 'editor-decorations-smoke', vscodeVersion: vscode.version, elapsedMs: Date.now() - startedAt });
  } catch (err) {
    writeResult({ ok: false, phase: 'editor-decorations-smoke', elapsedMs: Date.now() - startedAt, error: String((err && err.stack) || err) });
    process.exitCode = 1;
  } finally {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (err) {
        // 清理失败不影响测试结论。
      }
    }
    setTimeout(() => process.exit(process.exitCode || 0), 300);
  }
};
`;

function printUsage() {
  console.log(`真实 VS Code Extension Host 冒烟测试入口

用法：
  node scripts/extension-host-test.mjs [选项]

选项：
  --extension <目录>  使用指定扩展根目录（默认生成内置最小扩展）
  --tests <文件>      使用指定测试入口模块（默认生成内置装饰冒烟测试）
  --out <目录>        产物目录（result.json 与隔离的 user-data/extensions 写入这里；默认临时目录）
  --vscode <路径>     VS Code CLI 路径（默认读环境变量 VSCODE_BIN，再尝试 macOS 默认安装路径与 PATH）
  --timeout <毫秒>    子进程超时（默认 ${DEFAULT_TIMEOUT_MS}）
  --keep              未指定 --out 时保留临时产物目录（成功时默认删除）
  --verbose           输出 VS Code 子进程的完整 stdout/stderr
  -h, --help          显示本帮助

前置条件：
  - 本机安装 VS Code 桌面版 1.85+；扩展宿主需要图形会话（不能用于纯无头 CI）。
  - 默认使用 macOS 的 /Applications/Visual Studio Code.app/Contents/Resources/app/bin/code；
    其他平台用 VSCODE_BIN 或 --vscode 指定 CLI。
  - 每次运行使用隔离的 user-data/extensions 目录，不修改本机 VS Code 配置。

阶段 4 复用示例（先 pnpm run build）：
  node scripts/extension-host-test.mjs --extension . --tests test/ext-host/editor-smoke.cjs
`);
}

function fail(message) {
  console.error(`[ext-host-test] ${message}`);
  process.exit(1);
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const options = {
    keep: false,
    verbose: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  let index = 0;
  const nextValue = (flag) => {
    index += 1;
    const value = argv[index];
    if (!value || value.startsWith('-')) {
      fail(`${flag} 缺少参数`);
    }
    return value;
  };
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--keep') {
      options.keep = true;
    } else if (arg === '--verbose') {
      options.verbose = true;
    } else if (arg === '--extension') {
      options.extensionPath = resolve(nextValue('--extension'));
    } else if (arg === '--tests') {
      options.testsPath = resolve(nextValue('--tests'));
    } else if (arg === '--out') {
      options.outDir = resolve(nextValue('--out'));
    } else if (arg === '--vscode') {
      options.vscodeBin = nextValue('--vscode');
    } else if (arg === '--timeout') {
      const value = Number(nextValue('--timeout'));
      if (!Number.isFinite(value) || value <= 0) fail('--timeout 需要正整数毫秒数');
      options.timeoutMs = value;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      fail(`未知参数：${arg}（用 --help 查看用法）`);
    }
  }
  return options;
}

function resolveVscodeBin(explicit) {
  if (explicit) {
    if (!explicit.includes('/') && !explicit.includes('\\')) {
      const probe = spawnSync(explicit, ['--version'], { encoding: 'utf8', timeout: 15_000 });
      if (probe.error || probe.status !== 0) {
        fail(`--vscode 指定的 CLI 不可用：${explicit}`);
      }
      return explicit;
    }
    if (!isExecutable(explicit)) {
      fail(`--vscode 指定的路径不可执行：${explicit}`);
    }
    return explicit;
  }

  const envBin = process.env.VSCODE_BIN;
  if (envBin) {
    if (!isExecutable(envBin)) {
      fail(`环境变量 VSCODE_BIN 指向的路径不可执行：${envBin}`);
    }
    return envBin;
  }

  if (process.platform === 'darwin') {
    for (const candidate of [
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code',
    ]) {
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  const probe = spawnSync('code', ['--version'], { encoding: 'utf8', timeout: 15_000 });
  if (!probe.error && probe.status === 0) {
    return 'code';
  }

  fail([
    '未找到 VS Code CLI。请安装 VS Code 桌面版，或：',
    '  - 设置环境变量 VSCODE_BIN=/path/to/code',
    '  - 或用 --vscode /path/to/code 指定',
    'macOS 默认路径：/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
  ].join('\n'));
  return undefined;
}

/** 生成内置最小扩展与装饰冒烟测试。 */
function prepareHarness(outDir) {
  const harnessDir = join(outDir, 'harness');
  mkdirSync(join(harnessDir, 'test'), { recursive: true });
  writeFileSync(join(harnessDir, 'package.json'), `${JSON.stringify({
    name: 'svn-anywhere-ext-host-smoke',
    publisher: 'svn-anywhere-local',
    version: '0.0.1',
    engines: { vscode: '^1.85.0' },
    main: './extension.cjs',
    activationEvents: ['*'],
  }, null, 2)}\n`);
  writeFileSync(join(harnessDir, 'extension.cjs'), [
    "'use strict';",
    '// 冒烟测试直接调用 VS Code API，扩展本体无需贡献任何能力。',
    'exports.activate = function activate() {};',
    'exports.deactivate = function deactivate() {};',
    '',
  ].join('\n'));
  writeFileSync(join(harnessDir, 'test', 'smoke.cjs'), SMOKE_SOURCE);
  return {
    extensionPath: harnessDir,
    testsPath: join(harnessDir, 'test', 'smoke.cjs'),
  };
}

function printTail(label, text) {
  const lines = String(text ?? '').trimEnd().split('\n');
  const tail = lines.slice(-40);
  console.log(`--- ${label}（末 ${tail.length} 行）---`);
  console.log(tail.join('\n'));
}

/** macOS 的 code CLI 启动应用后立即返回：以 result.json 出现为测试完成信号。 */
async function waitForResult(resultPath, deadline) {
  while (!existsSync(resultPath)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const vscodeBin = resolveVscodeBin(options.vscodeBin);

  let outDir = options.outDir;
  let temporaryOut = false;
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
  } else {
    outDir = mkdtempSync(join(tmpdir(), 'svn-anywhere-ext-host-'));
    temporaryOut = true;
  }

  let extensionPath = options.extensionPath;
  let testsPath = options.testsPath;
  if (!extensionPath || !testsPath) {
    const harness = prepareHarness(outDir);
    extensionPath ??= harness.extensionPath;
    testsPath ??= harness.testsPath;
  }
  if (!existsSync(join(extensionPath, 'package.json'))) {
    fail(`扩展根目录缺少 package.json：${extensionPath}`);
  }
  if (!existsSync(testsPath)) {
    fail(`测试入口不存在：${testsPath}`);
  }

  console.log('真实 Extension Host 冒烟测试');
  console.log(`  VS Code CLI：${vscodeBin}`);
  console.log(`  扩展路径：${extensionPath}`);
  console.log(`  测试入口：${testsPath}`);
  console.log(`  产物目录：${outDir}`);

  const cliArgs = [
    `--extensionDevelopmentPath=${extensionPath}`,
    `--extensionTestsPath=${testsPath}`,
    `--user-data-dir=${join(outDir, 'user-data')}`,
    `--extensions-dir=${join(outDir, 'extensions')}`,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--no-sandbox',
    '--disable-gpu',
  ];
  const startedAt = Date.now();
  const child = spawnSync(vscodeBin, cliArgs, {
    encoding: 'utf8',
    timeout: options.timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, M4_EXT_HOST_OUT: outDir },
  });
  const resultPath = join(outDir, RESULT_NAME);
  // CLI 已返回不代表测试结束（macOS 上通常是异步执行），轮询到总超时预算耗尽。
  const completed = await waitForResult(resultPath, startedAt + options.timeoutMs);
  const elapsedMs = Date.now() - startedAt;

  const failures = [];
  if (child.error) {
    const code = child.error.code;
    failures.push(code === 'ETIMEDOUT'
      ? `VS Code CLI 在 ${options.timeoutMs} ms 内未返回`
      : `VS Code 启动失败：${child.error.message}`);
  }
  if (typeof child.status === 'number' && child.status !== 0) {
    failures.push(`VS Code 子进程退出码 ${child.status}`);
  }
  if (!completed) {
    failures.push(`等待测试结果超时（${options.timeoutMs} ms）：${resultPath} 未出现`);
  }

  let report;
  if (existsSync(resultPath)) {
    try {
      report = JSON.parse(readFileSync(resultPath, 'utf8'));
    } catch (err) {
      failures.push(`测试结果无法解析：${String(err)}`);
    }
  } else {
    failures.push(`未找到测试结果 ${resultPath}（测试入口是否导出 run() 并写入结果？）`);
  }

  if (Array.isArray(report?.checks)) {
    for (const item of report.checks) {
      const detail = !item.ok && item.detail !== undefined ? `：${item.detail}` : '';
      console.log(`  ${item.ok ? 'PASS' : 'FAIL'} ${item.name}${detail}`);
    }
  }
  if (report && report.ok !== true) {
    if (report.error) {
      console.error(`--- 测试错误 ---\n${report.error}`);
    }
    if (!failures.includes('冒烟测试存在失败检查项')) {
      failures.push('冒烟测试存在失败检查项');
    }
  }

  if (options.verbose) {
    printTail('VS Code stdout', child.stdout);
    printTail('VS Code stderr', child.stderr);
  }

  if (failures.length > 0) {
    console.error('\n失败：');
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    if (!options.verbose) {
      printTail('VS Code stdout', child.stdout);
      printTail('VS Code stderr', child.stderr);
    }
    if (temporaryOut) {
      console.error(`临时产物保留供排查：${outDir}`);
    }
    process.exit(1);
  }

  console.log(`\n全部检查通过（${Array.isArray(report?.checks) ? report.checks.length : 0} 项，耗时 ${elapsedMs} ms）`);
  if (temporaryOut && !options.keep) {
    rmSync(outDir, { recursive: true, force: true });
  } else {
    console.log(`产物目录已保留：${outDir}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
