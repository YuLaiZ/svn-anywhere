// Run two isolated desktop extension hosts against the same file-backed working copy.
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const extension = resolve(process.argv[2] ?? '.');
// macOS Unix-domain sockets have a short path limit. Each host appends its own IPC file name.
const output = realpathSync(mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'sva-m5-')));
const fixture = join(output, 'fixture');
mkdirSync(fixture);
const repo = join(fixture, 'repo');
const target = join(fixture, 'target');
execFileSync('svnadmin', ['create', repo]);
for (const wc of [target, join(fixture, 'sibling')]) execFileSync('svn', ['checkout', '-q', pathToFileURL(repo).href, wc]);
writeFileSync(join(target, 'fixture.txt'), 'm5');
execFileSync('svn', ['add', join(target, 'fixture.txt')]);
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const reached = quote(join(fixture, 'hook-reached'));
const release = quote(join(fixture, 'release-hook'));
writeFileSync(join(repo, 'hooks', 'pre-commit'), [
  '#!/bin/sh', ': > ' + reached, 'while [ ! -f ' + release + ' ]; do /bin/sleep 0.08; done', '',
].join('\n'), { mode: 0o700 });

const ids = new Map();
function run(role) {
  const log = openSync(join(output, role + '.log'), 'w');
  const child = spawn(process.execPath, [
    'scripts/extension-host-test.mjs', '--extension', extension, '--tests', 'test/ext-host/m5-smoke.cjs',
    '--out', join(output, role), '--timeout', '90000', '--verbose',
  ], {
    env: {
      ...process.env, SVN_ANYWHERE_STATE_DIR: join(output, 'shared-state'), SVN_ANYWHERE_M5_ROLE: role,
      SVN_ANYWHERE_M5_WC: target, SVN_ANYWHERE_M5_FIXTURE: fixture,
    },
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  ids.set(role, child);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
  });
}

console.log('双宿主验证记录 ' + output);
const owner = run('owner');
try {
  const pidFile = join(fixture, 'owner-pid');
  for (let attempts = 0; attempts < 160 && !existsSync(pidFile); attempts++) {
    if (ids.get('owner').exitCode !== null || existsSync(join(output, 'owner', 'result.json'))) break;
    await delay(350);
  }
  if (!existsSync(pidFile)) {
    throw new Error('主宿主未派发测试命令\n' + readFileSync(join(output, 'owner.log'), 'utf8'));
  }
  const code = await run('observer');
  console.log(readFileSync(join(output, 'observer.log'), 'utf8'));
  if (code !== 0) throw new Error('双窗口验证失败');
} finally {
  writeFileSync(join(fixture, 'release-hook'), '');
  const process = ids.get('owner');
  if (process.exitCode === null) process.kill();
  await owner;
}
