/**
 * 认证与错误（F66–F70）测试：runOrThrow 的认证失败识别、保留原始 args
 * 重放、补录取消、非认证错误不触发；host 补录弹窗的用户名预填与密码框；
 * 重试参数与错误对象中的密码脱敏；重试前 onCredentialRetry 回调的
 * 时机与参数（宿主据此回显脱敏命令行）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runOrThrowWithRunner, type RunOptions, type RunResult } from '../src/core/svnCli';
import { SvnError } from '../src/core/errors';

const vscodeMock = vi.hoisted(() => ({
  inputs: [] as Array<{ prompt?: string; value?: string; password?: boolean }>,
  results: [] as Array<string | undefined>,
}));

const runResult = (over: Partial<RunResult>): RunResult => ({
  stdout: '', stderr: '', exitCode: 0, ...over,
});

type Runner = NonNullable<Parameters<typeof runOrThrowWithRunner>[3]>;

describe('runOrThrow 认证重试（F66/F67）', () => {
  const runFake = (): {
    runner: Runner;
    push(r: RunResult): void;
    calls: Array<{ args: string[] }>;
  } => {
    const responses: RunResult[] = [];
    const calls: Array<{ args: string[] }> = [];
    const runner = (async (_svnPath: string, args: string[]) => {
      calls.push({ args });
      const next = responses.shift();
      if (!next) {
        throw new Error('runner 无预设响应');
      }
      if (next.exitCode !== 0) {
        throw new SvnError({
          message: next.stderr.split('\n')[0] ?? '失败',
          command: args,
          exitCode: next.exitCode,
          stderr: next.stderr,
          code: 'E170001',
        });
      }
      return next;
    }) as Runner;
    return { runner, push: (r: RunResult) => responses.push(r), calls };
  };

  it('认证失败时补录凭据并以原始 args 追加 --username/--password 重放一次', async () => {
    const fake = runFake();
    fake.push(runResult({ exitCode: 1, stderr: 'svn: E170001: Authentication failed' }));
    fake.push(runResult({ stdout: 'Updated to revision 2.\n', exitCode: 0 }));
    const getCredentials = vi.fn().mockResolvedValue({ username: 'yu', password: 's3cret' });

    const result = await runOrThrowWithRunner('svn', ['update', '--non-interactive', '.'], {
      cwd: '/wc',
      getCredentials,
    }, fake.runner);

    expect(result.stdout).toContain('Updated to revision 2.');
    expect(getCredentials).toHaveBeenCalledTimes(1);
    expect(fake.calls).toHaveLength(2);
    const retryArgs = fake.calls[1]?.args ?? [];
    expect(retryArgs.slice(0, 3)).toEqual(['update', '--non-interactive', '.']);
    expect(retryArgs.slice(3)).toEqual(['--username', 'yu', '--password', 's3cret']);
    expect(retryArgs.slice(0, 3)).toEqual(fake.calls[0]?.args ?? []);
  });

  it('E215004 / authorization failed / Authentication failed 都识别为认证失败', async () => {
    for (const stderr of [
      'svn: E215004: No more credentials or we tried too many times.',
      'svn: E170001: authorization failed',
      'svn: E170001: Authentication failed',
    ]) {
      const fake = runFake();
      fake.push(runResult({ exitCode: 1, stderr }));
      fake.push(runResult({ exitCode: 0 }));
      const getCredentials = vi.fn().mockResolvedValue({ username: 'u', password: 'p' });
      await runOrThrowWithRunner('svn', ['ls', 'http://x'], { getCredentials }, fake.runner);
      expect(getCredentials).toHaveBeenCalledTimes(1);
    }
  });

  it('补录取消：按原错误抛出，不重放', async () => {
    const fake = runFake();
    fake.push(runResult({ exitCode: 1, stderr: 'svn: E215004: No more credentials' }));
    const getCredentials = vi.fn().mockResolvedValue(undefined);

    await expect(
      runOrThrowWithRunner('svn', ['update', '.'], { getCredentials }, fake.runner),
    ).rejects.toBeInstanceOf(SvnError);
    expect(getCredentials).toHaveBeenCalledTimes(1);
    expect(fake.calls).toHaveLength(1);
  });

  it('非认证错误：不触发补录，直接抛出', async () => {
    const fake = runFake();
    fake.push(runResult({ exitCode: 1, stderr: 'svn: E155007: not a working copy' }));
    const getCredentials = vi.fn();

    await expect(
      runOrThrowWithRunner('svn', ['info', '.'], { getCredentials }, fake.runner),
    ).rejects.toBeInstanceOf(SvnError);
    expect(getCredentials).not.toHaveBeenCalled();
  });

  it('重试仍失败：按重试错误抛出，错误 command 已脱敏', async () => {
    const fake = runFake();
    fake.push(runResult({ exitCode: 1, stderr: 'svn: E170001: Authentication failed' }));
    fake.push(runResult({ exitCode: 1, stderr: 'svn: E170001: Authentication failed again' }));
    const getCredentials = vi.fn().mockResolvedValue({ username: 'yu', password: 's3cret' });

    const err = await runOrThrowWithRunner('svn', ['update', '.'], { getCredentials }, fake.runner).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SvnError);
    const svnError = err as SvnError;
    expect(svnError.command).not.toContain('s3cret');
    expect(svnError.command).toContain('***');
    expect(svnError.stderr).not.toContain('s3cret');
  });

  it('未提供 getCredentials 的调用方（本地命令）不受影响', async () => {
    const fake = runFake();
    fake.push(runResult({ stdout: 'ok', exitCode: 0 }));
    const result = await runOrThrowWithRunner('svn', ['status', '.'], {} as RunOptions, fake.runner);
    expect(result.stdout).toBe('ok');
    expect(fake.calls).toHaveLength(1);
  });

  it('认证重试执行前 onCredentialRetry 以追加凭据后的 args 调用一次', async () => {
    const fake = runFake();
    fake.push(runResult({ exitCode: 1, stderr: 'svn: E170001: Authentication failed' }));
    fake.push(runResult({ stdout: 'ok', exitCode: 0 }));
    const observed: Array<{ args: string[]; callsWhenFired: number }> = [];

    await runOrThrowWithRunner('svn', ['update', '.'], {
      cwd: '/wc',
      getCredentials: vi.fn().mockResolvedValue({ username: 'yu', password: 's3cret' }),
      onCredentialRetry: (args) => observed.push({ args, callsWhenFired: fake.calls.length }),
    }, fake.runner);

    // 回调恰好一次；触发时机在首次执行结束之后、重试执行之前（回显先于执行）。
    expect(observed).toHaveLength(1);
    expect(observed[0]?.callsWhenFired).toBe(1);
    expect(observed[0]?.args).toEqual(['update', '.', '--username', 'yu', '--password', 's3cret']);
    expect(fake.calls[1]?.args).toEqual(observed[0]?.args);
  });

  it('无重试（首次成功）与补录取消时 onCredentialRetry 都不调用', async () => {
    // 首次成功。
    const ok = runFake();
    ok.push(runResult({ stdout: 'ok', exitCode: 0 }));
    const okRetry = vi.fn();
    await runOrThrowWithRunner('svn', ['status', '.'], { onCredentialRetry: okRetry }, ok.runner);
    expect(okRetry).not.toHaveBeenCalled();

    // 认证失败但补录取消：不重试，也不回调。
    const cancelled = runFake();
    cancelled.push(runResult({ exitCode: 1, stderr: 'svn: E215004: No more credentials' }));
    const cancelledRetry = vi.fn();
    await expect(
      runOrThrowWithRunner('svn', ['update', '.'], {
        getCredentials: vi.fn().mockResolvedValue(undefined),
        onCredentialRetry: cancelledRetry,
      }, cancelled.runner),
    ).rejects.toBeInstanceOf(SvnError);
    expect(cancelledRetry).not.toHaveBeenCalled();
  });
});

describe('promptForCredentials（F67/F68）', () => {
  beforeEach(async () => {
    vscodeMock.inputs.length = 0;
    vscodeMock.results.length = 0;
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function loadAuth() {
    vi.doMock('vscode', () => ({
      window: {
        showInputBox: (options: { prompt?: string; value?: string; password?: boolean }) => {
          vscodeMock.inputs.push(options);
          return Promise.resolve(vscodeMock.results.shift());
        },
      },
    }));
    const mod = await import('../src/host/auth');
    return mod;
  }

  it('两次输入框：用户名普通输入（预填上次）、密码 password 输入；凭据只返回不落盘', async () => {
    const { promptForCredentials } = await loadAuth();
    vscodeMock.results.push('yu', 's3cret');
    const first = await promptForCredentials();
    expect(first).toEqual({ username: 'yu', password: 's3cret' });
    expect(vscodeMock.inputs[0]?.password).toBeUndefined();
    expect(vscodeMock.inputs[1]?.password).toBe(true);

    // 第二次弹窗用户名预填上次输入（模块内存变量）。
    vscodeMock.results.push('yu2', 'p2');
    await promptForCredentials();
    expect(vscodeMock.inputs[2]?.value).toBe('yu');
  });

  it('用户名取消：不问密码，返回 undefined', async () => {
    const { promptForCredentials } = await loadAuth();
    vscodeMock.results.push(undefined);
    const result = await promptForCredentials();
    expect(result).toBeUndefined();
    expect(vscodeMock.inputs).toHaveLength(1);
  });
});
