/**
 * 打包排除清单（.vscodeignore）与本地临时产物目录的一致性：
 * package.json 未声明 files 字段，vsce 打包范围由 .vscodeignore 决定；
 * 本地测试与开发工具会在仓库根留下临时产物目录（vitest 的 json reporter/coverage
 * 输出 .vitest、AI 工作流脚本 .zcode），用此测试锁定它们不会混入 vsix。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ignoreRules = readFileSync(join(process.cwd(), '.vscodeignore'), 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'));

describe('.vscodeignore 排除本地临时产物目录', () => {
  it('排除 vitest 输出目录 .vitest/**（json reporter/coverage 产物）', () => {
    expect(ignoreRules, '.vitest/** 排除项缺失，vitest 产物会混入 vsix').toContain('.vitest/**');
  });

  it('排除 AI 工作流脚本目录 .zcode/**（同类的打包污染源）', () => {
    expect(ignoreRules, '.zcode/** 排除项缺失，工作流临时文件会混入 vsix').toContain('.zcode/**');
  });
});
