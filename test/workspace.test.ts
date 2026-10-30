import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { escapePeg, findWorkingCopy } from '../src/core/workspace';

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
