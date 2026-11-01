import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dedupeNestedPaths, escapePeg, findWorkingCopy } from '../src/core/workspace';

describe('findWorkingCopy', () => {
  let roots: string[] = [];

  const makeRoot = (): string => {
    // macOS 的 tmpdir 是符号链接（/var/folders -> /private/var/folders），
    // findWorkingCopy 返回 realpath 后的路径，这里同样解析保持一致。
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'svn-anywhere-')));
    roots.push(root);
    return root;
  };

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    roots = [];
  });

  const makeWorkingCopy = (dir: string): void => {
    mkdirSync(join(dir, '.svn'), { recursive: true });
    writeFileSync(join(dir, '.svn', 'wc.db'), 'fake');
  };

  it('从文件路径向上找到所在副本根', () => {
    const root = makeRoot();
    makeWorkingCopy(root);
    const deepDir = join(root, 'a', 'b');
    mkdirSync(deepDir, { recursive: true });
    const file = join(deepDir, 'file.txt');
    writeFileSync(file, 'x');

    expect(findWorkingCopy(file)).toBe(root);
  });

  it('目录本身是副本根时返回自身', () => {
    const root = makeRoot();
    makeWorkingCopy(root);

    expect(findWorkingCopy(root)).toBe(root);
  });

  it('嵌套副本命中最近的一个', () => {
    const root = makeRoot();
    makeWorkingCopy(root);
    const nested = join(root, 'nested');
    mkdirSync(join(nested, 'sub'), { recursive: true });
    makeWorkingCopy(nested);
    const nestedFile = join(nested, 'sub', 'file.txt');
    writeFileSync(nestedFile, 'x');
    const rootFile = join(root, 'other');
    mkdirSync(rootFile, { recursive: true });
    const rootFilePath = join(rootFile, 'file.txt');
    writeFileSync(rootFilePath, 'x');

    expect(findWorkingCopy(nestedFile)).toBe(nested);
    expect(findWorkingCopy(rootFilePath)).toBe(root);
  });

  it('符号链接路径解析到真实副本（realpath 语义）', () => {
    const root = makeRoot();
    makeWorkingCopy(root);
    writeFileSync(join(root, 'file.txt'), 'x');
    const link = join(root, 'link-to-wc');
    symlinkSync(root, link, 'dir');

    expect(findWorkingCopy(link)).toBe(root);
    expect(findWorkingCopy(join(link, 'file.txt'))).toBe(root);
  });

  it('只有 .svn 目录而没有 wc.db 时不视为工作副本', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.svn'), { recursive: true });

    expect(findWorkingCopy(root)).toBeUndefined();
  });

  it('路径不存在时返回 undefined', () => {
    expect(findWorkingCopy('/definitely/not/exist/path')).toBeUndefined();
  });

  it('完全不在副本内时返回 undefined', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'plain'), { recursive: true });

    expect(findWorkingCopy(join(root, 'plain'))).toBeUndefined();
  });
});

describe('escapePeg', () => {
  it('短横线开头的目标显式表示为路径，并保留 peg 转义', () => {
    expect(escapePeg('--targets=manifest')).toBe('./--targets=manifest');
    expect(escapePeg('-name@1')).toBe('./-name@1@');
  });

  it('路径含 @ 时在末尾补 @', () => {
    expect(escapePeg('/tmp/a@b/file')).toBe('/tmp/a@b/file@');
    expect(escapePeg('file@')).toBe('file@@');
  });

  it('路径不含 @ 时原样返回', () => {
    expect(escapePeg('/tmp/普通路径/file.txt')).toBe('/tmp/普通路径/file.txt');
  });
});

describe('dedupeNestedPaths（批量选区嵌套去重）', () => {
  it('嵌套路径只保留最外层；内层先出现也不影响', () => {
    expect(dedupeNestedPaths(['/wc/a/b/c.txt', '/wc/a'])).toEqual(['/wc/a']);
    expect(dedupeNestedPaths(['/wc/a', '/wc/a/b/c.txt'])).toEqual(['/wc/a']);
  });

  it('路径分段边界：前缀相似但非祖先的路径互不包含', () => {
    expect(dedupeNestedPaths(['/wc/a', '/wc/ab/c.txt'])).toEqual(['/wc/a', '/wc/ab/c.txt']);
    expect(dedupeNestedPaths(['/wc/a-b', '/wc/a/b.txt'])).toEqual(['/wc/a-b', '/wc/a/b.txt']);
  });

  it('重复路径收敛为一份，兄弟路径都保留，顺序与输入一致', () => {
    expect(dedupeNestedPaths(['/wc/b', '/wc/a', '/wc/b'])).toEqual(['/wc/b', '/wc/a']);
    expect(dedupeNestedPaths(['/wc/a/x.txt', '/wc/b', '/wc/a/y.txt', '/wc'])).toEqual(['/wc']);
  });

  it('末尾分隔符不影响祖先判定（目录 URI 形态）；返回原值不截断', () => {
    expect(dedupeNestedPaths(['/wc/a/', '/wc/a/b.txt'])).toEqual(['/wc/a/']);
    expect(dedupeNestedPaths(['/wc/a/b.txt', '/wc/a/'])).toEqual(['/wc/a/']);
  });

  it('副本根本身（根路径）吞掉其余全部嵌套目标', () => {
    expect(dedupeNestedPaths(['/wc', '/wc/x/y.txt', '/wc/z'])).toEqual(['/wc']);
  });

  it('单元素与空数组原样返回', () => {
    expect(dedupeNestedPaths(['/wc/a.txt'])).toEqual(['/wc/a.txt']);
    expect(dedupeNestedPaths([])).toEqual([]);
  });
});
