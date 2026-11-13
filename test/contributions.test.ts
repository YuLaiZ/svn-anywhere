/**
 * package.json 贡献点与 i18n 命令标签的一致性：
 * 菜单/命令面板标题（package.json）与占位提示所用标签（host/i18n）
 * 两处维护，用此测试防止漂移。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HISTORY_PAGE_SIZE, HISTORY_PAGE_SIZES } from '../src/core/history';
import { strings } from '../src/host/i18n';

interface Manifest {
  contributes: {
    commands: Array<{ command: string; title: string; category?: string }>;
    submenus?: Array<{ id: string; label: string }>;
    configuration?: {
      properties: Record<string, { type?: string; enum?: unknown[]; default?: unknown; description?: string }>;
    };
  };
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

  it('子菜单与命令类别统一为 SVN Anywhere（与其他 SVN 扩展同名子菜单区分）', () => {
    expect(pkg.contributes.submenus).toEqual([{ id: 'svnAnywhere.submenu', label: 'SVN Anywhere' }]);
    for (const c of pkg.contributes.commands) {
      expect(c.category, `${c.command} 的 category 不是 SVN Anywhere`).toBe('SVN Anywhere');
    }
  });
});

describe('配置贡献点（M4 新增 historyPageSize）', () => {
  const properties = pkg.contributes.configuration?.properties ?? {};

  it('historyPageSize 已登记且类型为 number', () => {
    const prop = properties['svnAnywhere.historyPageSize'];
    expect(prop).toBeDefined();
    expect(prop?.type).toBe('number');
  });

  it('historyPageSize 的可选值与默认值与 core/history 常量一致', () => {
    const prop = properties['svnAnywhere.historyPageSize'];
    expect(prop?.enum).toEqual([...HISTORY_PAGE_SIZES]);
    expect(prop?.default).toBe(DEFAULT_HISTORY_PAGE_SIZE);
  });

  it('所有配置项都带非空 description（设置页可读）', () => {
    for (const [key, prop] of Object.entries(properties)) {
      expect(prop.description, `${key} 缺少 description`).toBeTruthy();
    }
  });
});
