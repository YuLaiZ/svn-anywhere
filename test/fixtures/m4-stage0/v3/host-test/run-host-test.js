'use strict';
/**
 * M4 阶段 0 / V3 宿主层 PoC 运行器（@vscode/test-electron + VS Code 1.85）。
 * 依赖：`npm install @vscode/test-electron`（在 host-test 目录）。
 * 用法：node run-host-test.js；结果写 result.json。
 */
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const version = process.env.VSCODE_VERSION || '1.85.2';
  const resultPath = process.env.M4_V3_RESULT || path.join(__dirname, 'result.json');
  process.env.M4_V3_RESULT = resultPath;
  const launchArgs = [
    '--user-data-dir', path.join(__dirname, 'user-data'),
    '--extensions-dir', path.join(__dirname, 'extensions'),
    '--disable-extensions',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
  ];
  console.log('[host-test] VS Code version:', version);
  const exitCode = await runTests({
    version,
    extensionDevelopmentPath: path.join(__dirname, 'min-ext'),
    extensionTestsPath: path.join(__dirname, 'host-tests'),
    launchArgs,
  });
  console.log('[host-test] exitCode:', exitCode, 'result:', resultPath);
}

main().catch((err) => {
  console.error('[host-test] FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
