'use strict';
/**
 * 宿主层 PoC 运行器（@vscode/test-electron + VS Code 1.85）。
 * 依赖：`npm install @vscode/test-electron`（在 host-test 目录）。
 * 用法：node run-host-test.js；结果写临时目录下的 result.json（不污染仓库）。
 * 产物位置：默认 mkdtempSync(tmpdir()) 下的一次性目录（result.json、
 * user-data/、extensions/ 均在其中）；FIXTURE_ROOT 指定父目录；
 * HOST_TEST_RESULT 可单独覆盖 result.json 路径。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const version = process.env.VSCODE_VERSION || '1.85.2';
  // 宿主 PoC 会写 result.json、user-data/ 与 extensions/：默认放系统临时目录，
  // 避免按注释复跑时把产物写进仓库内的 fixture 目录。
  const outRoot = fs.mkdtempSync(path.join(process.env.FIXTURE_ROOT || os.tmpdir(), 'svn-anywhere-host-test-'));
  const resultPath = process.env.HOST_TEST_RESULT || path.join(outRoot, 'result.json');
  process.env.HOST_TEST_RESULT = resultPath;
  const launchArgs = [
    '--user-data-dir', path.join(outRoot, 'user-data'),
    '--extensions-dir', path.join(outRoot, 'extensions'),
    '--disable-extensions',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
  ];
  console.log('[host-test] VS Code version:', version);
  console.log('[host-test] out root:', outRoot);
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
