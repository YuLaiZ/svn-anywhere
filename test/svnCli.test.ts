import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authScopeOfUrl,
  killAllActive,
  run,
  runOrThrow,
  runOrThrowWithRunner,
  runToFile,
  svnEnv,
  urlWithPeg,
} from '../src/core/svnCli';
import {
  INSUFFICIENT_DISK,
  MAX_ERROR_TAIL_CHARS,
  OUTPUT_TOO_LARGE,
  SvnError,
  classifyAuthFailure,
  isNetworkFailure,
} from '../src/core/errors';

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

  describe('authScope 认证/权限细分', () => {
    type Runner = NonNullable<Parameters<typeof runOrThrowWithRunner>[3]>;

    const failingRunner = (stderr: string): { runner: Runner; calls: string[][] } => {
      const calls: string[][] = [];
      const runner = (async (_svnPath: string, args: string[]) => {
        calls.push(args);
        throw new SvnError({
          message: stderr.split('\n')[0] ?? '失败',
          command: args,
          exitCode: 1,
          stderr,
          code: 'E170001',
        });
      }) as Runner;
      return { runner, calls };
    };

    it('svn:// 的 E170001 Authorization failed 归 permission：不弹补录、只执行一次', async () => {
      const fake = failingRunner('svn: E170001: Authorization failed\nsvn: E170000: ...');
      const getCredentials = vi.fn().mockResolvedValue({ username: 'u', password: 'p' });

      await expect(
        runOrThrowWithRunner('svn', ['list', '--non-interactive', '--', 'svn://host/repo@'], {
          authScope: { scheme: 'svn', host: 'host', port: 3690 },
          getCredentials,
        }, fake.runner),
      ).rejects.toBeInstanceOf(SvnError);
      expect(getCredentials).not.toHaveBeenCalled();
      expect(fake.calls).toHaveLength(1);
    });

    it('svn:// 的 E170001 Can\'t get username or password 归 auth：弹补录并重试', async () => {
      const fake = failingRunner("svn: E170013: Unable to connect\nsvn: E170001: Can't get username or password");
      const getCredentials = vi.fn().mockResolvedValue({ username: 'u', password: 'p' });

      await expect(
        runOrThrowWithRunner('svn', ['list', '--non-interactive', '--', 'svn://host/repo@'], {
          authScope: { scheme: 'svn', host: 'host', port: 3690 },
          getCredentials,
        }, fake.runner),
      ).rejects.toBeInstanceOf(SvnError);
      expect(getCredentials).toHaveBeenCalledTimes(1);
      expect(fake.calls).toHaveLength(2);
    });

    it('HTTP 的 E175013 授权拒绝归 permission：不弹补录', async () => {
      const fake = failingRunner('svn: E170013: Unable to connect\nsvn: E175013: Access to /repo forbidden');
      const getCredentials = vi.fn().mockResolvedValue({ username: 'u', password: 'p' });

      await expect(
        runOrThrowWithRunner('svn', ['info', '--non-interactive', '--', 'https://host/repo@'], {
          authScope: { scheme: 'https', host: 'host', port: 443 },
          getCredentials,
        }, fake.runner),
      ).rejects.toBeInstanceOf(SvnError);
      expect(getCredentials).not.toHaveBeenCalled();
      expect(fake.calls).toHaveLength(1);
    });

    it('未传 authScope 时保持 M1–M3 按码判定：E170001 仍触发补录（兼容旧用例）', async () => {
      const fake = failingRunner('svn: E170001: Authorization failed');
      const getCredentials = vi.fn().mockResolvedValue({ username: 'u', password: 'p' });

      await expect(
        runOrThrowWithRunner('svn', ['update', '.'], { getCredentials }, fake.runner),
      ).rejects.toBeInstanceOf(SvnError);
      expect(getCredentials).toHaveBeenCalledTimes(1);
      expect(fake.calls).toHaveLength(2);
    });

    it('getCredentials 收到 RunOptions.authScope 原样传入的 scope', async () => {
      const fake = failingRunner('svn: E215004: No more credentials');
      const scope = { scheme: 'https' as const, host: 'example.com', port: 8443 };
      const getCredentials = vi.fn().mockResolvedValue(undefined);

      await expect(
        runOrThrowWithRunner('svn', ['ls', 'https://example.com:8443/repo'], {
          authScope: scope,
          getCredentials,
        }, fake.runner),
      ).rejects.toBeInstanceOf(SvnError);
      expect(getCredentials).toHaveBeenCalledWith(scope);
    });
  });
});

describe('urlWithPeg（统一 URL@REV 构造）', () => {
  it('无 revision 时追加空 peg，不裸露用户 URL', () => {
    expect(urlWithPeg('https://host/repo/trunk')).toBe('https://host/repo/trunk@');
    expect(urlWithPeg('file:///tmp/repo')).toBe('file:///tmp/repo@');
  });

  it('带 revision 时固定为 url + @ + peg', () => {
    expect(urlWithPeg('https://host/repo/trunk', 5)).toBe('https://host/repo/trunk@5');
    expect(urlWithPeg('https://host/repo/trunk', 0)).toBe('https://host/repo/trunk@0');
    expect(urlWithPeg('https://host/repo/trunk', 'HEAD')).toBe('https://host/repo/trunk@HEAD');
  });

  it('含字面 @ 的 URL 追加 peg 后不会残留 peg 语法歧义（实测 E205000 场景）', () => {
    expect(urlWithPeg('file:///tmp/repo/at@file#1.txt', 3)).toBe('file:///tmp/repo/at@file#1.txt@3');
    expect(urlWithPeg('file:///tmp/repo/at@file#1.txt')).toBe('file:///tmp/repo/at@file#1.txt@');
  });

  it('含 %40 编码的 URL 与字面 @ 同等处理', () => {
    expect(urlWithPeg('https://host/repo/a%40b.txt', 2)).toBe('https://host/repo/a%40b.txt@2');
  });

  it('以字面 @ 结尾的合法节点 URL 不剥除尾 @：固定拼接为 url + @ + peg', () => {
    // svn 的 <url> 对名称以 @ 结尾的节点原样回显字面尾 @（实测不编码 %40）；
    // 剥除会把它解析成「路径 + peg」而指向同名兄弟节点或报 W170000。
    expect(urlWithPeg('https://host/repo/tail@', 1)).toBe('https://host/repo/tail@@1');
    expect(urlWithPeg('https://host/repo/tail@')).toBe('https://host/repo/tail@@');
    expect(urlWithPeg('file:///tmp/repo/dir@', 5)).toBe('file:///tmp/repo/dir@@5');
  });

  it('null 与 undefined 等价于空 peg', () => {
    expect(urlWithPeg('https://host/repo/trunk', null)).toBe('https://host/repo/trunk@');
    expect(urlWithPeg('https://host/repo/trunk', undefined)).toBe('https://host/repo/trunk@');
  });
});

describe('authScopeOfUrl（单飞凭据作用域构造）', () => {
  it('http/https/svn 各自补齐协议默认端口', () => {
    expect(authScopeOfUrl('http://example.com/repo')).toEqual({ scheme: 'http', host: 'example.com', port: 80 });
    expect(authScopeOfUrl('https://example.com/repo/trunk')).toEqual({ scheme: 'https', host: 'example.com', port: 443 });
    expect(authScopeOfUrl('svn://example.com/repo')).toEqual({ scheme: 'svn', host: 'example.com', port: 3690 });
  });

  it('显式端口优先；host 统一小写（同源 key 稳定）', () => {
    expect(authScopeOfUrl('HTTPS://Example.COM:8443/repo')).toEqual({ scheme: 'https', host: 'example.com', port: 8443 });
  });

  it('IPv6 主机与端口解析', () => {
    expect(authScopeOfUrl('https://[::1]:8443/repo')).toEqual({ scheme: 'https', host: '[::1]', port: 8443 });
    expect(authScopeOfUrl('https://[::1]/repo')).toEqual({ scheme: 'https', host: '[::1]', port: 443 });
  });

  it('file 与 svn+ssh 不适用凭据补录，返回 undefined', () => {
    expect(authScopeOfUrl('file:///tmp/repo')).toBeUndefined();
    expect(authScopeOfUrl('svn+ssh://host/repo')).toBeUndefined();
  });

  it('非 URL 或空 authority 返回 undefined（不误判本地路径）', () => {
    expect(authScopeOfUrl('/tmp/repo')).toBeUndefined();
    expect(authScopeOfUrl('https:///repo')).toBeUndefined();
  });

  it('userinfo 防御性剥除（规范 URL 不应携带）', () => {
    expect(authScopeOfUrl('https://user:pass@example.com/repo')).toEqual({
      scheme: 'https',
      host: 'example.com',
      port: 443,
    });
  });
});

describe('classifyAuthFailure / isNetworkFailure（错误分类基座）', () => {
  it('svn:// E170001 按固定 en_US.UTF-8 消息细分 auth 与 permission', () => {
    expect(classifyAuthFailure('svn: E170001: Authorization failed', 'svn')).toBe('permission');
    expect(classifyAuthFailure("svn: E170013: Unable to connect\nsvn: E170001: Can't get username or password", 'svn')).toBe('auth');
    expect(classifyAuthFailure('svn: E170001: Authentication failed', 'svn')).toBe('auth');
  });

  it('HTTP 401（E215004）为 auth，HTTP authz（E175013）为 permission（任意 scheme）', () => {
    expect(classifyAuthFailure('svn: E170013: x\nsvn: E215004: No more credentials', 'https')).toBe('auth');
    expect(classifyAuthFailure('svn: E170013: x\nsvn: E175013: Access forbidden', 'https')).toBe('permission');
    expect(classifyAuthFailure('svn: E170013: x\nsvn: E175013: Access forbidden')).toBe('permission');
  });

  it('未提供 scheme 时沿用 isAuthFailure：E170001 Authorization failed 仍为 auth', () => {
    expect(classifyAuthFailure('svn: E170001: Authorization failed')).toBe('auth');
  });

  it('非认证类失败返回 undefined', () => {
    expect(classifyAuthFailure('svn: E155007: not a working copy', 'https')).toBeUndefined();
    expect(classifyAuthFailure('svn: E160013: path not found', 'svn')).toBeUndefined();
  });

  it('E175012（超时）与 E120108（连接中断）归网络类（补充实测）', () => {
    expect(isNetworkFailure('svn: E170013: x\nsvn: E175012: Connection timed out')).toBe(true);
    expect(isNetworkFailure('svn: E170013: x\nsvn: E120108: The server unexpectedly closed the connection')).toBe(true);
    expect(isNetworkFailure('svn: E000061: Connection refused')).toBe(true);
    expect(isNetworkFailure('svn: E170001: Authentication failed')).toBe(false);
    expect(isNetworkFailure('')).toBe(false);
  });
});

/**
 * host/auth.ts 的单飞协调器测试：
 * 同一 scheme+host+port 的并发认证失败共享一个凭据弹窗 Promise；
 * 取消/成功只结算一次；不同源各自补录。vscode 用受控 Promise 模拟
 * showInputBox：用例可以精确决定「弹窗何时结算」，验证在途共享。
 */
describe('host 单飞凭据协调器（auth.ts）', () => {
  interface PendingInput {
    options: { prompt?: string; value?: string; password?: boolean };
    resolve: (value: string | undefined) => void;
  }
  const pending: PendingInput[] = [];

  afterEach(() => {
    pending.length = 0;
    vi.resetModules();
  });

  async function loadAuth(): Promise<typeof import('../src/host/auth')> {
    vi.doMock('vscode', () => ({
      window: {
        showInputBox: (options: { prompt?: string; value?: string; password?: boolean }) => {
          return new Promise<string | undefined>((resolve) => {
            pending.push({ options, resolve });
          });
        },
      },
    }));
    return import('../src/host/auth');
  }

  const settle = async (index: number, value: string | undefined) => {
    const item = pending[index];
    if (!item) {
      throw new Error(`待结算的输入框不存在：${index}`);
    }
    item.resolve(value);
    // 让 promptForCredentials 的 await 链推进。
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it('4 个并发同 scope 失败只弹一次凭据框，全部拿到同一凭据', async () => {
    const { requestCredentials } = await loadAuth();
    const scope = { scheme: 'https' as const, host: 'example.com', port: 443 };

    const p1 = requestCredentials(scope);
    const p2 = requestCredentials(scope);
    const p3 = requestCredentials(scope);
    const p4 = requestCredentials(scope);
    // 4 个请求只触发了一个用户名输入框（弹窗在途即共享）。
    expect(pending).toHaveLength(1);
    await settle(0, 'yu');
    expect(pending).toHaveLength(2);
    expect(pending[1]?.options.password).toBe(true);
    await settle(1, 's3cret');

    const results = await Promise.all([p1, p2, p3, p4]);
    expect(results).toEqual(Array.from({ length: 4 }, () => ({ username: 'yu', password: 's3cret' })));
    // 全程只有用户名 + 密码两次输入框，没有重复弹窗。
    expect(pending).toHaveLength(2);
  });

  it('取消只结算一次：所有等待者统一得到 undefined，之后重新发起会新弹窗', async () => {
    const { requestCredentials } = await loadAuth();
    const scope = { scheme: 'svn' as const, host: 'repo.local', port: 3690 };

    const p1 = requestCredentials(scope);
    const p2 = requestCredentials(scope);
    expect(pending).toHaveLength(1);
    await settle(0, undefined);

    await expect(Promise.all([p1, p2])).resolves.toEqual([undefined, undefined]);
    expect(pending).toHaveLength(1);

    // 取消后的新一轮请求重新弹窗（in-flight 已清除）。
    const p3 = requestCredentials(scope);
    expect(pending).toHaveLength(2);
    await settle(1, 'u2');
    await settle(2, 'p2');
    await expect(p3).resolves.toEqual({ username: 'u2', password: 'p2' });
  });

  it('成功结算后新的认证失败重新弹窗（共享只发生在在途期间）', async () => {
    const { requestCredentials } = await loadAuth();
    const scope = { scheme: 'http' as const, host: 'a.example', port: 80 };

    const first = requestCredentials(scope);
    await settle(0, 'u');
    await settle(1, 'p');
    await expect(first).resolves.toEqual({ username: 'u', password: 'p' });

    const second = requestCredentials(scope);
    expect(pending).toHaveLength(3);
    await settle(2, 'u');
    await settle(3, 'p2');
    await expect(second).resolves.toEqual({ username: 'u', password: 'p2' });
  });

  it('不同 host/port 各自补录，不共享凭据 Promise', async () => {
    const { requestCredentials } = await loadAuth();
    const a = requestCredentials({ scheme: 'https', host: 'a.example', port: 443 });
    const b = requestCredentials({ scheme: 'https', host: 'b.example', port: 443 });
    // 两个 scope 各自弹出第一个输入框（用户名），互不共享。
    expect(pending).toHaveLength(2);
    // pending 顺序：0=A 用户名、1=B 用户名、2=A 密码、3=B 密码。
    await settle(0, 'ua');
    expect(pending).toHaveLength(3);
    await settle(2, 'pa');
    await settle(1, 'ub');
    expect(pending).toHaveLength(4);
    await settle(3, 'pb');
    await expect(a).resolves.toEqual({ username: 'ua', password: 'pa' });
    await expect(b).resolves.toEqual({ username: 'ub', password: 'pb' });
  });

  it('未提供 scope 时不做共享（每次独立弹窗，保持 M1–M3 行为）', async () => {
    const { requestCredentials } = await loadAuth();
    const p1 = requestCredentials();
    const p2 = requestCredentials();
    expect(pending).toHaveLength(2);

    // pending 顺序：0=p1 用户名、1=p2 用户名、2=p1 密码、3=p2 密码。
    await settle(0, 'u1');
    expect(pending).toHaveLength(3);
    await settle(2, 'p1');
    await settle(1, 'u2');
    expect(pending).toHaveLength(4);
    await settle(3, 'p2');
    await expect(p1).resolves.toEqual({ username: 'u1', password: 'p1' });
    await expect(p2).resolves.toEqual({ username: 'u2', password: 'p2' });
  });

  it('credentialProvider 绑定默认 scope，svnCli 传入的 scope 优先', async () => {
    const { credentialProvider } = await loadAuth();
    const bound = { scheme: 'https' as const, host: 'bound.example', port: 443 };
    const actual = { scheme: 'https' as const, host: 'actual.example', port: 443 };
    const provider = credentialProvider(bound);

    const p1 = provider();
    expect(pending).toHaveLength(1);
    await settle(0, 'u');
    await settle(1, 'p');
    await expect(p1).resolves.toEqual({ username: 'u', password: 'p' });

    // 回调收到同一 scope 时命中同一 key（结算后重新弹窗，但 key 语义一致）；
    // 显式参数优先于创建时绑定的 scope。
    const p2 = provider(actual);
    expect(pending).toHaveLength(3);
    await settle(2, 'u2');
    await settle(3, 'p2');
    await expect(p2).resolves.toEqual({ username: 'u2', password: 'p2' });
  });
});

describe('runToFile 失败诊断（机器可读 code + 英文技术文本）', () => {
  it('预算/磁盘预检与创建失败：code 固定，message 不携带面向用户的中文叙述', async () => {
    const dir = makeTempDir('svn-anywhere-runtofile-diag-');
    try {
      const target = join(dir, 'out.bin');
      const scenarios: Array<{ name: string; code: string; invoke: () => Promise<unknown> }> = [
        {
          name: 'expectedBytes 超过字节上限',
          code: OUTPUT_TOO_LARGE,
          invoke: () => runToFile('svn', ['cat'], { targetPath: target, expectedBytes: 100, maxBytes: 10 }),
        },
        {
          name: '目标目录磁盘余量不足',
          code: INSUFFICIENT_DISK,
          invoke: () => runToFile('svn', ['cat'], { targetPath: target, headroomBytes: Number.MAX_SAFE_INTEGER }),
        },
        {
          name: '临时文件创建失败（目标目录不存在）',
          code: 'ENOENT',
          invoke: () => runToFile('svn', ['cat'], { targetPath: join(dir, 'missing-dir', 'out.bin') }),
        },
      ];
      for (const scenario of scenarios) {
        try {
          await scenario.invoke();
          expect.unreachable(`${scenario.name} 必须抛 SvnError`);
        } catch (err) {
          expect(err, scenario.name).toBeInstanceOf(SvnError);
          expect((err as SvnError).code, scenario.name).toBe(scenario.code);
          // 面向用户的文案由宿主按 code 映射 i18n；core 只给英文技术诊断。
          expect((err as Error).message, scenario.name).not.toMatch(/[一-鿿]/);
        }
      }
    } finally {
      cleanupDir(dir);
    }
  });
});
