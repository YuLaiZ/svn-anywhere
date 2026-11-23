'use strict';

const vscode = require('vscode');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { setTimeout: delay } = require('node:timers/promises');

async function until(predicate, message) {
  for (let i = 0; i < 180; i++) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(message);
}

const check = (condition, message) => { if (!condition) throw new Error(message); };

exports.run = async function () {
  const output = process.env.M4_EXT_HOST_OUT;
  const result = { runId: process.env.M4_EXT_HOST_RUN_ID, checks: [], vscodeVersion: vscode.version };
  const push = (name) => result.checks.push({ name, ok: true });
  try {
    const extension = vscode.extensions.getExtension('yulaiz.svn-anywhere');
    check(extension, '未找到待验证的 SVN Anywhere 扩展');
    await extension.activate();
    push('最终扩展在真实 Extension Host 激活');

    const commands = await vscode.commands.getCommands();
    check(commands.includes('svnAnywhere.editDepth') && commands.includes('svnAnywhere.recoverOperation'), 'M5 命令未注册');
    push('P8 与恢复入口已注册');
    const root = process.env.SVN_ANYWHERE_M5_WC;
    const fixture = process.env.SVN_ANYWHERE_M5_FIXTURE;
    const role = process.env.SVN_ANYWHERE_M5_ROLE;
    const { getOperationRegistry, runOrThrow } = require(join(extension.extensionPath, 'out', 'extension.js')).__m5OperationApi;
    const registry = getOperationRegistry();

    if (role === 'owner') {
      const begin = await registry.begin({ wcRoot: root, targetRelPath: '.', nodeKind: 'dir', kind: 'daily', writeAction: 'fixture' });
      check(begin.ok, '主窗口未取得锁');
      const phase = await registry.markPhase(begin.operationId, 'running');
      check(phase.ok, '主窗口未登记写入派发');
      // 真正启动 SVN。验收提交由临时仓库钩子暂停。
      const active = runOrThrow('svn', ['commit', '-m', 'm5-lock-probe', '--', root], { cwd: root });
      active.catch(() => {});
      await until(() => fs.existsSync(join(fixture, 'hook-reached')), '提交没有到达临时仓库钩子');
      fs.writeFileSync(join(fixture, 'owner-pid'), String(process.pid));
      await active;
      throw new Error('主窗口探针没有在 SVN 执行期间被终止');
    }

    if (role === 'observer') {
      const ownerPidFile = join(fixture, 'owner-pid');
      await until(() => fs.existsSync(ownerPidFile), '主窗口没有开始写入');
      const args = { wcRoot: root, targetRelPath: '.', nodeKind: 'dir', kind: 'daily', writeAction: 'observer' };
      const denied = await registry.begin(args);
      check(!denied.ok && denied.reason === 'busy', '另一窗口在 SVN 执行期间错误获得锁');
      push('两套隔离窗口竞争同一副本时只有一项写入');
      const other = join(fixture, 'sibling');
      const allowed = await registry.begin({ ...args, wcRoot: other });
      check(allowed.ok, '独立工作副本被错误阻断');
      await registry.finish(allowed.operationId);
      push('独立工作副本可以同时取得写权限');

      process.kill(Number(fs.readFileSync(ownerPidFile, 'utf8')), 'SIGKILL');
      await delay(150);
      const afterKill = await registry.begin(args);
      check(!afterKill.ok && afterKill.reason === 'busy', '主宿主被终止后仍执行的 SVN 失去写锁');
      const record = (await registry.loadAllRecords()).find((item) => item.wcRoot === root);
      const cleanupBeforeExit = await registry.withRecoveryLease(record.operationId, async () => true);
      check(cleanupBeforeExit === undefined, '上一个 SVN 仍跑动时允许了回扫恢复');
      push('扩展宿主异常退出后仍由 SVN 进程持锁');

      fs.writeFileSync(join(fixture, 'release-hook'), '');
      await until(async () => {
        await registry.refreshWorkspace(root);
        return registry.writeRestriction(root)?.phase === 'unknown';
      }, 'SVN 退出后未将遗留记录识别为结果未知');
      const unknown = registry.writeRestriction(root);
      check(unknown && !(await registry.begin(args)).ok, '未知结果失去写入限制');
      await registry.withRecoveryLease(unknown.operationId, async () => {
        const state = execFileSync('svn', ['status', '--xml', '--', root], { encoding: 'utf8' });
        check(!state.includes('wc-locked'), '副本未恢复到可读状态');
        await registry.finalizeOperation(unknown.operationId, 'done');
      });
      const recovered = await registry.begin(args);
      check(recovered.ok, '回扫结算后写权限仍被占用');
      await registry.finish(recovered.operationId);
      push('跨宿主恢复保留未知记录，结算后恢复写入');
    } else {
      const scratch = fs.mkdtempSync(join(output, 'p8-fixture-'));
      const repo = join(scratch, 'repo');
      const wc = join(scratch, 'wc');
      execFileSync('svnadmin', ['create', repo]);
      execFileSync('svn', ['checkout', pathToFileURL(repo).href, wc]);
      const target = vscode.Uri.file(wc);
      await vscode.commands.executeCommand('svnAnywhere.editDepth', target);
      const tab = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((item) => item.label.includes('深度编辑'));
      await until(() => tab(), 'P8 Webview 没有在真实宿主打开');
      push('P8 Webview 从正式命令入口打开');
      await vscode.window.tabGroups.close(tab());
    }
    result.ok = true;
  } catch (error) {
    result.ok = false;
    result.error = String(error?.stack ?? error);
  } finally {
    fs.writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2));
  }
  if (!result.ok) throw new Error(result.error);
};
