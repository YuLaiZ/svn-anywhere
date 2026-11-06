/**
 * svnConfig 测试：global-ignores 解析（[miscellany] 单键、注释行、空白
 * 分词、反斜杠续行、键缺省默认集、格式错误抛错形态）、注入文本/路径
 * 读取、basename glob 匹配矩阵。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GLOBAL_IGNORES,
  SvnConfigError,
  matchesGlobalIgnores,
  parseSvnConfigGlobalIgnores,
  readSvnConfigGlobalIgnores,
  svnConfigPath,
} from '../src/core/svnConfig';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'svn-anywhere-cfg-'));
  tempDirs.push(dir);
  return dir;
}

describe('parseSvnConfigGlobalIgnores', () => {
  it('读取 [miscellany] 节的 global-ignores 键并按空白分词', () => {
    const text = [
      '[auth]',
      'password-stores = keychain',
      '[miscellany]',
      'global-ignores = *.foo *.bar   build\ttmp',
      'log-encoding = utf-8',
    ].join('\n');
    expect(parseSvnConfigGlobalIgnores(text)).toEqual(['*.foo', '*.bar', 'build', 'tmp']);
  });

  it('其他节的 global-ignores 键不生效', () => {
    const text = '[helpers]\nglobal-ignores = *.nope\n[miscellany]\n';
    expect(parseSvnConfigGlobalIgnores(text)).toEqual([...DEFAULT_GLOBAL_IGNORES]);
  });

  it('# 与 ; 开头的注释行跳过', () => {
    const text = [
      '[miscellany]',
      '# global-ignores = *.commented',
      '; global-ignores = *.semi',
      'global-ignores = *.real',
    ].join('\n');
    expect(parseSvnConfigGlobalIgnores(text)).toEqual(['*.real']);
  });

  it('反斜杠续行：行尾 \\ 与下一行拼接后分词，两段模式都生效', () => {
    const text = '[miscellany]\nglobal-ignores = *.foo \\\n  *.bar\n';
    expect(parseSvnConfigGlobalIgnores(text)).toEqual(['*.foo', '*.bar']);
    expect(matchesGlobalIgnores(parseSvnConfigGlobalIgnores(text), 'x.foo')).toBe(true);
    expect(matchesGlobalIgnores(parseSvnConfigGlobalIgnores(text), 'x.bar')).toBe(true);
  });

  it('续行可以跨多行', () => {
    const text = '[miscellany]\nglobal-ignores = a \\\nb \\\nc\n';
    expect(parseSvnConfigGlobalIgnores(text)).toEqual(['a', 'b', 'c']);
  });

  it('注释行的行尾反斜杠把下一行并入注释（与 svn 一致：键不生效、回退默认集）', () => {
    const text = ['[miscellany]', '# comment \\', 'global-ignores = *.ok'].join('\n');
    expect(parseSvnConfigGlobalIgnores(text)).toEqual([...DEFAULT_GLOBAL_IGNORES]);
  });

  it('键缺省时返回内置默认忽略集', () => {
    expect(parseSvnConfigGlobalIgnores('[miscellany]\nlog-encoding = utf-8\n')).toEqual([...DEFAULT_GLOBAL_IGNORES]);
    expect(parseSvnConfigGlobalIgnores('')).toEqual([...DEFAULT_GLOBAL_IGNORES]);
  });

  it('默认集内容与 svn 1.15 出厂口径一致', () => {
    expect(DEFAULT_GLOBAL_IGNORES).toEqual([
      '*.o', '*.lo', '*.la', '*.al', '.libs', '*.so', '*.so.[0-9]*', '*.a',
      '*.pyc', '*.pyo', '__pycache__', '*.rej', '*~', '#*#', '.#*', '.*.swp',
      '.DS_Store', '[Tt]humbs.db',
    ]);
  });

  it('键显式存在但值为空：覆盖默认集得到空模式列表', () => {
    expect(parseSvnConfigGlobalIgnores('[miscellany]\nglobal-ignores =\n')).toEqual([]);
  });

  it('同名键多次出现取最后一次', () => {
    const text = '[miscellany]\nglobal-ignores = *.first\nglobal-ignores = *.second\n';
    expect(parseSvnConfigGlobalIgnores(text)).toEqual(['*.second']);
  });

  it('格式错误抛 SvnConfigError：节头未闭合', () => {
    expect(() => parseSvnConfigGlobalIgnores('[miscellany\nglobal-ignores = *.x\n'))
      .toThrow(SvnConfigError);
  });

  it('格式错误抛 SvnConfigError：非注释非空行缺少 = 分隔', () => {
    expect(() => parseSvnConfigGlobalIgnores('[miscellany]\ngarbage line\n')).toThrow(SvnConfigError);
  });

  it('格式错误抛 SvnConfigError：键名为空', () => {
    expect(() => parseSvnConfigGlobalIgnores('[miscellany]\n= *.x\n')).toThrow(SvnConfigError);
  });

  it('错误消息含行号定位', () => {
    try {
      parseSvnConfigGlobalIgnores('[miscellany]\n\nbad line\n');
      expect.unreachable('应抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(SvnConfigError);
      expect((err as Error).message).toContain('3');
    }
  });
});

describe('readSvnConfigGlobalIgnores', () => {
  it('注入 configText 时直接解析', () => {
    expect(readSvnConfigGlobalIgnores({ configText: '[miscellany]\nglobal-ignores = *.z\n' })).toEqual(['*.z']);
  });

  it('注入 configPath 读取指定文件', () => {
    const home = makeTempHome();
    const configPath = join(home, 'my-config');
    writeFileSync(configPath, '[miscellany]\nglobal-ignores = *.from-file\n', 'utf8');
    expect(readSvnConfigGlobalIgnores({ configPath })).toEqual(['*.from-file']);
  });

  it('注入 homeDir 时读 HOME 下 .subversion/config', () => {
    const home = makeTempHome();
    mkdirSync(join(home, '.subversion'), { recursive: true });
    writeFileSync(join(home, '.subversion', 'config'), '[miscellany]\nglobal-ignores = *.in-home\n', 'utf8');
    expect(readSvnConfigGlobalIgnores({ homeDir: home })).toEqual(['*.in-home']);
    expect(svnConfigPath(home)).toBe(join(home, '.subversion', 'config'));
  });

  it('配置文件不存在时返回内置默认集', () => {
    const home = makeTempHome();
    expect(readSvnConfigGlobalIgnores({ homeDir: home })).toEqual([...DEFAULT_GLOBAL_IGNORES]);
  });

  it('配置文件格式错误抛 SvnConfigError（上层据此阻止确认与提交）', () => {
    const home = makeTempHome();
    mkdirSync(join(home, '.subversion'), { recursive: true });
    writeFileSync(join(home, '.subversion', 'config'), '[miscellany]\nnot-a-kv-line\n', 'utf8');
    expect(() => readSvnConfigGlobalIgnores({ homeDir: home })).toThrow(SvnConfigError);
  });
});

describe('matchesGlobalIgnores', () => {
  it.each([
    [['*.o'], 'a.o', true],
    [['*.o'], '.hidden.o', true],
    [['*.o'], 'a.O', false],
    [['*.so.[0-9]*'], 'lib.so.9', true],
    [['*.so.[0-9]*'], 'lib.so.abc', false],
    [['[Tt]humbs.db'], 'Thumbs.db', true],
    [['[Tt]humbs.db'], 'thumbs.db', true],
    [['[Tt]humbs.db'], 'Tb.db', false],
    [['[!a]bc'], 'xbc', true],
    [['[!a]bc'], 'abc', false],
    [['?.txt'], 'a.txt', true],
    [['?.txt'], 'ab.txt', false],
    [['build'], 'build', true],
    [['build'], 'build/x', false],
    [['a?c'], 'abc', true],
    [['a\\*c'], 'a*c', true],
    [['a\\*c'], 'axc', false],
    [[], 'anything', false],
    [['*.foo', '*.bar'], 'x.bar', true],
  ])('模式 %j 对 %s → %s', (patterns, name, expected) => {
    expect(matchesGlobalIgnores(patterns as string[], name as string)).toBe(expected);
  });

  it('svn 1.15 出厂默认集的实测口径（前导点、[Tt]humbs.db 不跨名匹配）', () => {
    const ignored = ['a.o', 'b.lo', 'x.rej', 'y~', '#hash#', '.#lock', '.hidden.o', '.s.swp', '.DS_Store', 'z.pyc'];
    for (const name of ignored) {
      expect(matchesGlobalIgnores(DEFAULT_GLOBAL_IGNORES, name)).toBe(true);
    }
    const kept = ['Tb.db', 'c.pyd', 'keep.txt', 'Thumbs.db'];
    for (const name of kept.slice(0, 3)) {
      expect(matchesGlobalIgnores(DEFAULT_GLOBAL_IGNORES, name)).toBe(false);
    }
  });
});
