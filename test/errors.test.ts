import { describe, expect, it } from 'vitest';
import {
  MAX_ERROR_TAIL_CHARS,
  SvnError,
  assertSuccess,
  extractSvnErrorCodes,
  isAuthFailure,
  tailText,
} from '../src/core/errors';

describe('extractSvnErrorCodes', () => {
  it('提取单个错误码', () => {
    expect(extractSvnErrorCodes("svn: E155007: '/x' is not a working copy"))
      .toEqual(['E155007']);
  });

  it('提取多个错误码', () => {
    expect(extractSvnErrorCodes('svn: E170013: Unable to connect\nsvn: E215004: No more credentials'))
      .toEqual(['E170013', 'E215004']);
  });

  it('无错误码时返回空数组', () => {
    expect(extractSvnErrorCodes('clean output')).toEqual([]);
  });

  it('不把非 E 开头的 6 位数字当错误码', () => {
    expect(extractSvnErrorCodes('revision 123456')).toEqual([]);
  });
});

describe('isAuthFailure', () => {
  it.each([
    ['svn: E170001: Authentication failed', true],
    ['svn: E215004: No more credentials or we tried too many times.', true],
    ['Authorization failed', true],
    ['svn: E170013: Unable to connect to a repository', false],
    ["svn: E155007: not a working copy", false],
  ])('%s => %s', (text, expected) => {
    expect(isAuthFailure(text)).toBe(expected);
  });
});

describe('tailText', () => {
  it('短文本原样返回', () => {
    expect(tailText('abc')).toBe('abc');
  });

  it('超长时只保留尾部并加省略标记', () => {
    const text = 'a'.repeat(MAX_ERROR_TAIL_CHARS + 100) + 'tail-marker';
    const tailed = tailText(text);
    expect(tailed.length).toBeLessThanOrEqual(MAX_ERROR_TAIL_CHARS + 20);
    expect(tailed).toContain('tail-marker');
    expect(tailed.startsWith('…')).toBe(true);
  });
});

describe('SvnError', () => {
  it('构造时对 command 做密码脱敏', () => {
    const err = new SvnError({ message: 'm', command: ['commit', '--password', 's3cret', 'path'] });
    expect(err.command).toEqual(['commit', '--password', '***', 'path']);
  });
});

describe('assertSuccess', () => {
  it('退出码为 0 时原样返回', () => {
    const result = { stdout: 'ok', stderr: '', exitCode: 0 };
    expect(assertSuccess(result, ['status'])).toBe(result);
  });

  it('非零退出码时抛携带上下文的 SvnError', () => {
    const result = { stdout: '', stderr: 'svn: E155007: boom', exitCode: 1 };
    try {
      assertSuccess(result, ['status'], '/tmp/wc');
      expect.unreachable('应当抛出 SvnError');
    } catch (err) {
      expect(err).toBeInstanceOf(SvnError);
      const svnErr = err as SvnError;
      expect(svnErr.command).toEqual(['status']);
      expect(svnErr.cwd).toBe('/tmp/wc');
      expect(svnErr.exitCode).toBe(1);
      expect(svnErr.stderr).toBe('svn: E155007: boom');
      expect(svnErr.code).toBe('E155007');
      expect(svnErr.message).toContain('E155007');
    }
  });
});
