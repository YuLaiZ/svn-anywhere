import { describe, expect, it } from 'vitest';
import { LineBuffer, redactArgs, sanitizeText } from '../src/core/redact';

describe('sanitizeText', () => {
  it.each([
    ['svn commit --password secret123 --file /tmp/x', 'svn commit --password *** --file /tmp/x'],
    ['--password=secret123', '--password=***'],
    ['--password "a b" --other', '--password *** --other'],
    ["--password 'a b'", '--password ***'],
    ['--PASSWORD xyz', '--PASSWORD ***'],
    ['普通输出行 --username alice', '普通输出行 --username alice'],
  ])('%s => %s', (input, expected) => {
    expect(sanitizeText(input)).toBe(expected);
  });
});

describe('redactArgs', () => {
  it('分离式 --password 的值被替换', () => {
    expect(redactArgs(['commit', '--password', 's3cret', '--file', 'x']))
      .toEqual(['commit', '--password', '***', '--file', 'x']);
  });

  it('等号式 --password=value 被替换', () => {
    expect(redactArgs(['--password=s3cret'])).toEqual(['--password=***']);
  });

  it('连续脱敏只替换各自的值', () => {
    expect(redactArgs(['--password', 'a', '--password', 'b']))
      .toEqual(['--password', '***', '--password', '***']);
  });

  it('其他参数不变', () => {
    expect(redactArgs(['info', '--show-item', 'url'])).toEqual(['info', '--show-item', 'url']);
  });
});

describe('LineBuffer', () => {
  it('整块到达时按行脱敏输出', () => {
    const lines: string[] = [];
    const buffer = new LineBuffer((line) => lines.push(line));
    buffer.push('a\n--password secret\nb\n');
    buffer.flush();
    expect(lines).toEqual(['a', '--password ***', 'b']);
  });

  it('密码与值被拆进两个 chunk 时仍能脱敏', () => {
    const lines: string[] = [];
    const buffer = new LineBuffer((line) => lines.push(line));
    buffer.push('--pass');
    buffer.push('word s3cret\nnext\n');
    buffer.flush();
    expect(lines).toEqual(['--password ***', 'next']);
  });

  it('flush 冲出无换行的残余内容', () => {
    const lines: string[] = [];
    const buffer = new LineBuffer((line) => lines.push(line));
    buffer.push('tail --password p');
    buffer.flush();
    expect(lines).toEqual(['tail --password ***']);
  });
});
