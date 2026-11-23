import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');

if (process.platform === 'darwin' || process.platform === 'linux') {
  mkdirSync('out', { recursive: true });
  const arch = process.platform === 'darwin'
    ? ['-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=11.0']
    : [];
  execFileSync(process.env.CC || 'cc', [
    ...arch, '-Wall', '-Wextra', '-Werror', '-O2',
    'src/native/workspace-lock.c', '-o', 'out/workspace-lock',
  ], { stdio: 'inherit' });
}

// esbuild 一次构建只支持一种输出格式（已实测确认），因此扩展与视图拆两次构建：
// 1. 扩展入口（cjs）→ out/extension.js，vscode 保持 external；
// 2. 视图入口（iife）→ media/panel.js，打进 Webview，无 external。
// watch 模式同时监听两个入口。
const extensionOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'out/extension.js',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

const webviewOptions = {
  entryPoints: ['src/host/panel/webview/main.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: 'media/panel.js',
  sourcemap: false,
  logLevel: 'info',
};

if (watch) {
  const [extensionContext, webviewContext] = await Promise.all([
    esbuild.context(extensionOptions),
    esbuild.context(webviewOptions),
  ]);
  await Promise.all([extensionContext.watch(), webviewContext.watch()]);
  console.log('[esbuild] watch 已启动（extension + webview 双入口）');
} else {
  await Promise.all([esbuild.build(extensionOptions), esbuild.build(webviewOptions)]);
}
