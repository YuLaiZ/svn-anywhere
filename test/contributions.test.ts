/**
 * package.json 贡献点与 i18n 命令标签的一致性：
 * 菜单/命令面板标题（package.json）与占位提示所用标签（host/i18n）
 * 两处维护，用此测试防止漂移。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { strings } from '../src/host/i18n';

interface Manifest {
  contributes: { commands: Array<{ command: string; title: string }> };
}

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as Manifest & { name: string };

describe('贡献点与 i18n 命令标签一致性', () => {
  it('当前清单确为 svn-anywhere（防止 cwd 偏离导致读错 package.json）', () => {
    expect(pkg.name).toBe('svn-anywhere');
  });

  it('每条 i18n 命令标签都有对应贡献点且标题一致', () => {
    for (const [key, title] of Object.entries(strings.command)) {
      const found = pkg.contributes.commands.find((c) => c.command === `svnAnywhere.${key}`);
      expect(found, `贡献点缺少命令 svnAnywhere.${key}`).toBeDefined();
      expect(found?.title, `svnAnywhere.${key} 标题与 i18n 不一致`).toBe(title);
    }
  });

  it('每条贡献点命令都有 i18n 标签', () => {
    for (const c of pkg.contributes.commands) {
      const key = c.command.replace('svnAnywhere.', '');
      expect((strings.command as Record<string, string>)[key], `i18n 缺少 ${c.command} 标签`).toBeDefined();
    }
  });
});
