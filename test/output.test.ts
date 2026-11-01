/**
 * 输出频道生命周期的宿主侧单测：mock vscode 模块验证按操作域分频道
 * （状态/更新/提交/其它互不覆盖）、操作日志频道逐命令记录
 * 时间|命令|退出码|耗时、频道复用、dispose 后写入丢弃、二次激活
 * （resetOutputState）后输出恢复。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => ({
  channels: [] as Array<{
    title: string;
    lines: string[];
    shown: number;
    disposed: boolean;
    appendLine: (line: string) => void;
    show: () => void;
    dispose: () => void;
  }>,
}));

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: (title: string) => {
      const ch = {
        title,
        lines: [] as string[],
        shown: 0,
        disposed: false,
        appendLine(line: string) {
          ch.lines.push(line);
        },
        show() {
          ch.shown += 1;
        },
        dispose() {
          ch.disposed = true;
        },
      };
      vscodeMock.channels.push(ch);
      return ch;
    },
  },
}));

import {
  disposeOutputChannel,
  getOutputChannel,
  logCommand,
  logExitCode,
  logLine,
  resetOutputState,
  showOutput,
} from '../src/host/output';

function channelByTitle(title: string) {
  return vscodeMock.channels.find((ch) => ch.title === title);
}

describe('输出频道生命周期（宿主侧）', () => {
  beforeEach(() => {
    disposeOutputChannel();
    resetOutputState();
    vscodeMock.channels.length = 0;
  });

  it('getOutputChannel 同一 kind 复用同一频道实例', () => {
    const first = getOutputChannel();
    const second = getOutputChannel();
    expect(first).toBe(second);
    expect(vscodeMock.channels).toHaveLength(1);
  });

  it('不同 kind 各建独立频道且互不覆盖', () => {
    logLine('状态行', 'status');
    logLine('更新行', 'update');
    logLine('提交行', 'commit');
    logLine('其它行', 'other');
    expect(vscodeMock.channels.map((ch) => ch.title)).toEqual([
      'SVN Anywhere · 状态',
      'SVN Anywhere · 更新',
      'SVN Anywhere · 提交',
      'SVN Anywhere',
    ]);
    expect(channelByTitle('SVN Anywhere · 状态')?.lines).toEqual(['状态行']);
    expect(channelByTitle('SVN Anywhere · 更新')?.lines).toEqual(['更新行']);
    expect(channelByTitle('SVN Anywhere · 提交')?.lines).toEqual(['提交行']);
    expect(channelByTitle('SVN Anywhere')?.lines).toEqual(['其它行']);
  });

  it('dispose 后迟到写入被丢弃，不重建频道', () => {
    getOutputChannel();
    disposeOutputChannel();
    expect(() => logLine('停用后的迟到写入')).not.toThrow();
    expect(() => showOutput()).not.toThrow();
    expect(vscodeMock.channels).toHaveLength(1);
    expect(vscodeMock.channels[0]?.lines).toHaveLength(0);
    expect(vscodeMock.channels[0]?.disposed).toBe(true);
  });

  it('resetOutputState 后二次激活输出恢复（新频道可写入）', () => {
    const first = getOutputChannel();
    disposeOutputChannel();
    resetOutputState();
    logLine('二次激活后的输出');
    expect(vscodeMock.channels).toHaveLength(2);
    expect(vscodeMock.channels[1]?.lines).toEqual(['二次激活后的输出']);
    expect(getOutputChannel()).not.toBe(first);
  });

  it('logExitCode 写入「退出码: N」行到指定频道', () => {
    logExitCode(0, 'status');
    logExitCode(1, 'commit');
    expect(channelByTitle('SVN Anywhere · 状态')?.lines).toEqual(['退出码: 0']);
    expect(channelByTitle('SVN Anywhere · 提交')?.lines).toEqual(['退出码: 1']);
  });

  it('logCommand 回显命令并返回退出记录器，写入操作日志行（时间|命令|退出码|耗时）', () => {
    const onExit = logCommand('svn', ['status', '--xml', '.'], '/tmp/wc', 'status');
    expect(channelByTitle('SVN Anywhere · 状态')?.lines).toEqual([
      '> svn status --xml .  (cwd: /tmp/wc)',
    ]);
    onExit(0);
    const logChannel = channelByTitle('SVN Anywhere · 操作日志');
    expect(logChannel?.lines).toHaveLength(1);
    const line = logChannel?.lines[0] ?? '';
    expect(line).toContain('| svn status --xml .  (cwd: /tmp/wc) | 退出码 0 | ');
    expect(line).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
    expect(line).toMatch(/\|\s\d+ms$/);
    // 退出码行同时写入对应操作域频道。
    expect(channelByTitle('SVN Anywhere · 状态')?.lines).toEqual([
      '> svn status --xml .  (cwd: /tmp/wc)',
      '退出码: 0',
    ]);
  });

  it('logCommand 对 --password 脱敏（回显与操作日志都不含明文）', () => {
    const onExit = logCommand('svn', ['update', '--password', 's3cret', '.'], undefined, 'update');
    onExit(1);
    const updateLines = channelByTitle('SVN Anywhere · 更新')?.lines ?? [];
    expect(updateLines[0]).not.toContain('s3cret');
    expect(updateLines[0]).toContain('***');
    const logLineText = channelByTitle('SVN Anywhere · 操作日志')?.lines[0] ?? '';
    expect(logLineText).not.toContain('s3cret');
    expect(logLineText).toContain('***');
  });

  it('操作日志行内命令参数的换行归一为字面 \\n（一行一命令）', () => {
    const onExit = logCommand('svn', ['add', '--', 'foo\nbar'], '/tmp/wc', 'other');
    onExit(1);
    const logLines = channelByTitle('SVN Anywhere · 操作日志')?.lines ?? [];
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain('foo\\nbar');
    expect(logLines[0]).not.toContain('\n');
  });

  it('dispose 后 logCommand 返回的记录器为空操作，不重建频道', () => {
    const onExit = logCommand('svn', ['--version']);
    disposeOutputChannel();
    expect(() => onExit(0)).not.toThrow();
    expect(vscodeMock.channels.every((ch) => !ch.title.includes('操作日志') || ch.lines.length === 0)).toBe(true);
  });

  it('认证补录重试：操作日志记两行且命令行各自准确（真实子进程假 svn）', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const lab = mkdtempSync(join(tmpdir(), 'svn-anywhere-authlog-'));
    try {
      // 假 svn：无 --password 时报 E170001 退出 1；带 --password 时成功。
      const fakeSvn = join(lab, 'svn-fake.sh');
      writeFileSync(fakeSvn, [
        '#!/bin/sh',
        'case " $* " in',
        "  *' --password '*) printf 'ok'; exit 0 ;;",
        "  *) printf 'svn: E170001: Authentication failed\\n' >&2; exit 1 ;;",
        'esac',
        '',
      ].join('\n'), { mode: 0o755 });

      const { runOrThrow } = await import('../src/core/svnCli');
      const mainExit = logCommand(fakeSvn, ['info', '.'], lab, 'status');
      const result = await runOrThrow(fakeSvn, ['info', '.'], {
        cwd: lab,
        getCredentials: async () => ({ username: 'yu', password: 's3cret' }),
        onExit: mainExit,
        // 与产品调用点同形态：隐式返回 logCommand 的退出记录器，
        // 重试执行用它作为 onExit（操作日志第二行绑定重试命令行）。
        onCredentialRetry: (retryArgs) => logCommand(fakeSvn, retryArgs, lab, 'status'),
      });
      expect(result.stdout).toBe('ok');

      // 频道退出码两行（首执行 1、重试 0）——既有口径不变。
      const statusLines = channelByTitle('SVN Anywhere · 状态')?.lines ?? [];
      expect(statusLines).toContain('退出码: 1');
      expect(statusLines).toContain('退出码: 0');
      // 重试命令回显已脱敏。
      expect(statusLines.some((l) => l.includes('--password ***'))).toBe(true);
      expect(statusLines.some((l) => l.includes('s3cret'))).toBe(false);

      // 操作日志两行：第一行为首执行命令（无凭据、退出码 1），
      // 第二行为重试命令（--password 已脱敏、退出码 0），命令行各自准确。
      const opLog = channelByTitle('SVN Anywhere · 操作日志')?.lines ?? [];
      expect(opLog).toHaveLength(2);
      expect(opLog[0]).toMatch(/\| \S+svn-fake\.sh info \.  \(cwd: [^)]*\) \| 退出码 1 \| \d+ms$/);
      expect(opLog[1]).toMatch(/\| \S+svn-fake\.sh info \. --username yu --password \*\*\*  \(cwd: [^)]*\) \| 退出码 0 \| \d+ms$/);
      expect(opLog.every((l) => !l.includes('s3cret'))).toBe(true);
    } finally {
      rmSync(lab, { recursive: true, force: true });
    }
  });
});
