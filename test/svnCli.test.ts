import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { killAllActive, run, runOrThrow, svnEnv } from '../src/core/svnCli';
import { MAX_ERROR_TAIL_CHARS, SvnError } from '../src/core/errors';

let hasSvn = false;
try {
  execSync('svn --version', { stdio: 'ignore' });
  hasSvn = true;
} catch {
  hasSvn = false;
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe('run（真实 svn）', () => {
  it.runIf(hasSvn)('svn --version 返回版本号且退出码为 0', async () => {
    const result = await run('svn', ['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('svn, version');
  });

  it.runIf(hasSvn)('cwd 指定非工作副本时透传非零退出码与 stderr', async () => {
    const dir = makeTempDir('svn-anywhere-run-');
    try {
      // svn info 对非工作副本报 E155007 且退出码非零；svn status 只警告不报错。
      const result = await run('svn', ['info'], { cwd: dir });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('E155007');
    } finally {
      cleanupDir(dir);
    }
  });

  it.runIf(hasSvn)('onOutput 收到与 stdout 一致的增量输出', async () => {
    let streamed = '';
    const result = await run('svn', ['--version'], {
      onOutput: (chunk) => {
        streamed += chunk;
      },
    });
    expect(streamed).toBe(result.stdout);
  });

  it.runIf(hasSvn)('onExit 在命令正常结束时收到退出码 0', async () => {
    const codes: number[] = [];
    await run('svn', ['--version'], { onExit: (code) => codes.push(code) });
    expect(codes).toEqual([0]);
  });

  it.runIf(hasSvn)('非零退出码同样触发 onExit（run 层不把退出码当进程失败）', async () => {
    const dir = makeTempDir('svn-anywhere-onexit-');
    try {
      const codes: number[] = [];
      const result = await run('svn', ['info'], { cwd: dir, onExit: (code) => codes.push(code) });
      expect(result.exitCode).not.toBe(0);
      expect(codes).toEqual([result.exitCode]);
    } finally {
      cleanupDir(dir);
    }
  });

  it.runIf(hasSvn)('onOutput 的 stderr 分支携带非工作副本错误', async () => {
    const dir = makeTempDir('svn-anywhere-stderr-');
    try {
      const stderrChunks: string[] = [];
      await run('svn', ['info'], {
        cwd: dir,
        onOutput: (chunk, source) => {
          if (source === 'stderr') {
            stderrChunks.push(chunk);
          }
        },
      });
      expect(stderrChunks.join('')).toContain('E155007');
    } finally {
      cleanupDir(dir);
    }
  });

  it.runIf(hasSvn)('中文路径下 UTF-8 输出正常解码', async () => {
    const dir = makeTempDir('svn-anywhere-中文路径-');
    try {
      const result = await run('svn', ['info'], { cwd: dir });
      expect(result.stderr).toContain('中文路径');
    } finally {
      cleanupDir(dir);
    }
  });

  it.runIf(hasSvn)('timeoutMs 为 0 表示不限时', async () => {
    const result = await run('svn', ['--version'], { timeoutMs: 0 });
    expect(result.exitCode).toBe(0);
  });

  it('svnEnv 强制 UTF-8 环境变量', () => {
    const env = svnEnv();
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.LC_ALL).toBe('en_US.UTF-8');
  });
});

describe('run（进程级失败，不依赖 svn）', () => {
  it('可执行文件不存在时抛 SvnError（ENOENT），消息含路径', async () => {
    const promise = run('svn-anywhere-definitely-not-exists', ['--version']);
    await expect(promise).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(SvnError);
      const svnErr = err as SvnError;
      expect(svnErr.code).toBe('ENOENT');
      expect(svnErr.message).toContain('svn-anywhere-definitely-not-exists');
      return true;
    });
  });

  it('cwd 不存在时抛 SvnError（ENOENT）', async () => {
    const promise = run('/bin/echo', ['hi'], { cwd: '/definitely/not/exist/dir' });
    await expect(promise).rejects.toMatchObject({ name: 'SvnError', code: 'ENOENT' });
  });

  it('超时后 kill 进程并抛 SvnError（TIMEOUT）', async () => {
    const promise = run('sleep', ['5'], { timeoutMs: 300 });
    await expect(promise).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(SvnError);
      const svnErr = err as SvnError;
      expect(svnErr.code).toBe('TIMEOUT');
      expect(svnErr.message).toContain('超时');
      expect(svnErr.message).toContain('300');
      return true;
    });
  });

  it('超时错误消息与 command 字段都经过密码脱敏', async () => {
    // sh -c 只执行脚本，多余参数成为位置参数，用于构造含密码的 args。
    const promise = run('sh', ['-c', 'sleep 30', '--password', 's3cret'], { timeoutMs: 200 });
    await expect(promise).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(SvnError);
      const svnErr = err as SvnError;
      expect(svnErr.command).not.toContain('s3cret');
      expect(svnErr.command).toContain('***');
      expect(svnErr.message).toContain('***');
      expect(svnErr.message).not.toContain('s3cret');
      return true;
    });
  });

  it('超时路径的 stderr 也截断到尾部', async () => {
    const { writeFileSync } = await import('node:fs');
    const dir = makeTempDir('svn-anywhere-bigerr-');
    const bigFile = join(dir, 'big.txt');
    writeFileSync(bigFile, 'e'.repeat(200_000));
    try {
      const promise = run('sh', ['-c', `cat ${JSON.stringify(bigFile)} >&2; sleep 30`], { timeoutMs: 300 });
      await expect(promise).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(SvnError);
        const svnErr = err as SvnError;
        expect(svnErr.code).toBe('TIMEOUT');
        expect(svnErr.stderr.length).toBeLessThanOrEqual(MAX_ERROR_TAIL_CHARS + 20);
        expect(svnErr.stderr.startsWith('…')).toBe(true);
        return true;
      });
    } finally {
      cleanupDir(dir);
    }
  });

  it('leader 先退出、孙进程忽略 TERM 时仍能经 SIGKILL 组杀返回', async () => {
    // sh 启动后台子 shell（忽略 TERM、限 10 秒循环自然退出兜底）后立即退出：
    // leader 的 exitCode 非 null，SIGKILL 判据必须不看 leader 状态才能杀掉持管道的孙进程。
    // 注意：无 SIGKILL 时子 shell 约 10.1 秒自然退出并同样返回 TIMEOUT（早于 15s testTimeout），
    // 因此必须用耗时上界区分强制终止（约 3.2 秒）与自然退出。
    const subShell = 'trap "" TERM; for i in 1 2 3 4 5 6 7 8 9 10; do sleep 1; done';
    const promise = run('sh', ['-c', `(${subShell}) & exit 0`], { timeoutMs: 200 });
    const startedAt = Date.now();
    await expect(promise).rejects.toMatchObject({ name: 'SvnError', code: 'TIMEOUT' });
    // 下界证明走满了 200ms 超时 + 3 秒 SIGKILL 宽限；上界排除 10 秒自然退出的假阳性。
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(3000);
    expect(elapsed).toBeLessThan(5000);
  });

  it('AbortSignal 触发后抛 SvnError（CANCELLED）', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const promise = run('sleep', ['5'], { signal: controller.signal });
    await expect(promise).rejects.toMatchObject({ name: 'SvnError', code: 'CANCELLED' });
  });

  it('超时与取消不触发 onExit（无含混的中间退出码）', async () => {
    const codes: number[] = [];
    await expect(
      run('sleep', ['5'], { timeoutMs: 200, onExit: (code) => codes.push(code) }),
    ).rejects.toMatchObject({ name: 'SvnError', code: 'TIMEOUT' });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await expect(
      run('sleep', ['5'], { signal: controller.signal, onExit: (code) => codes.push(code) }),
    ).rejects.toMatchObject({ name: 'SvnError', code: 'CANCELLED' });
    expect(codes).toEqual([]);
  });

  it('已 aborted 的 signal 立即取消，不启动等待', async () => {
    const controller = new AbortController();
    controller.abort();
    const promise = run('sleep', ['5'], { signal: controller.signal });
    await expect(promise).rejects.toMatchObject({ name: 'SvnError', code: 'CANCELLED' });
  });

  it('killAllActive 终止进行中的子进程并按取消处理', async () => {
    const promise = run('sleep', ['30']);
    await new Promise((resolve) => setTimeout(resolve, 150));
    killAllActive();
    // deactivate 路径的终止等价于取消：命令层不应看到「退出码 -1」这种含混结果。
    await expect(promise).rejects.toMatchObject({ name: 'SvnError', code: 'CANCELLED' });
  });
});

describe('runOrThrow', () => {
  it.runIf(hasSvn)('成功时返回结果', async () => {
    const result = await runOrThrow('svn', ['--version']);
    expect(result.stdout).toContain('svn, version');
  });

  it.runIf(hasSvn)('非零退出码时抛携带命令与 stderr 的 SvnError', async () => {
    const dir = makeTempDir('svn-anywhere-throw-');
    try {
      const promise = runOrThrow('svn', ['info'], { cwd: dir });
      await expect(promise).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(SvnError);
        const svnErr = err as SvnError;
        expect(svnErr.command).toEqual(['info']);
        expect(svnErr.exitCode).not.toBe(0);
        expect(svnErr.stderr).toContain('E155007');
        return true;
      });
    } finally {
      cleanupDir(dir);
    }
  });
});
