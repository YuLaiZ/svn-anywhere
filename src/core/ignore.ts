/**
 * svn:ignore 规则的读取、合并与写回参数（F121）。core 模块，不依赖 vscode。
 *
 * svn:ignore 属性值是按行分隔的通配模式；合并时保持既有顺序、
 * 新规则追加在末尾并去重。
 */
import { run, type RunOptions } from './svnCli';
import { SvnError, extractSvnErrorCodes, tailText } from './errors';
import { escapePeg } from './workspace';

/** 解析 `svn propget svn:ignore <dir>` 的输出为规则列表。 */
export function parseIgnoreRules(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

function escapeRegExp(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/**
 * 把 svn:ignore 模式（apr_fnmatch 子集：* 任意串、? 单字符、[...] 字符类、
 * \ 转义）转换为整名匹配的正则。模式只用于直接子项名，不含路径分隔。
 */
export function ignorePatternToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] ?? '';
    if (char === '\\' && i + 1 < pattern.length) {
      source += escapeRegExp(pattern[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (char === '*') {
      source += '.*';
      continue;
    }
    if (char === '?') {
      source += '.';
      continue;
    }
    if (char === '[') {
      let j = i + 1;
      let negate = false;
      if (pattern[j] === '!' || pattern[j] === '^') {
        negate = true;
        j += 1;
      }
      let body = '';
      if (pattern[j] === ']') {
        body += '\\]';
        j += 1;
      }
      while (j < pattern.length && pattern[j] !== ']') {
        const cls = pattern[j] ?? '';
        body += cls === '\\' ? '\\\\' : escapeRegExp(cls);
        j += 1;
      }
      if (j >= pattern.length) {
        // 未闭合的 [ 按字面量处理。
        source += '\\[';
        continue;
      }
      source += negate ? `[^${body}]` : `[${body}]`;
      i = j;
      continue;
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`);
}

/** 名称是否命中任一忽略规则（名称按原值比较，不 trim）。 */
export function matchesIgnoreRules(name: string, rules: string[]): boolean {
  return rules.some((rule) => {
    const trimmed = rule.trim();
    if (trimmed === '') {
      return false;
    }
    if (trimmed === name) {
      return true;
    }
    return ignorePatternToRegExp(rule).test(name);
  });
}

/** 将直接子项名转换为精确匹配的 svn:ignore 模式，保留空格。 */
export function literalIgnorePattern(name: string): string {
  if (/[\r\n]/.test(name)) {
    throw new RangeError('A name containing line breaks cannot be represented by one svn:ignore pattern');
  }
  return [...name].map((char) => {
    if (char === '\\') return '\\\\';
    if (char === '[') return '[[]';
    if (char === ']') return '[]]';
    if (char === '*') return '[*]';
    if (char === '?') return '[?]';
    return char;
  }).join('');
}

/**
 * 读取目标的 svn:ignore 规则。属性不存在时 svn 报 W200017 且退出码非 0
 * （实测 svn 1.15），目标未纳管（如提交面板对未版本控制目录枚举子项前
 * 读规则）报 E200005，都属无属性可读的常态，按空规则处理；其余失败原样
 * 抛出。`--` 防止以 `-` 开头的相对路径被解析为选项。
 */
export async function readIgnoreRules(
  svnPath: string,
  dir: string,
  options: RunOptions = {},
): Promise<string[]> {
  const args = ['propget', 'svn:ignore', '--', escapePeg(dir)];
  const result = await run(svnPath, args, options);
  if (result.exitCode !== 0) {
    if (result.stderr.includes('W200017') || result.stderr.includes('E200005')) {
      return [];
    }
    throw new SvnError({
      message: tailText(result.stderr.trim() || `svn propget 退出码 ${result.exitCode}`),
      command: args,
      cwd: options.cwd,
      exitCode: result.exitCode,
      stderr: tailText(result.stderr),
      code: extractSvnErrorCodes(result.stderr)[0],
    });
  }
  return parseIgnoreRules(result.stdout);
}

/** 合并规则：先做移除，再把新增追加到末尾（去重、保持既有顺序）。 */
export function mergeIgnoreRules(
  existing: string[],
  additions: string[],
  removals: string[],
): string[] {
  const result = existing.filter((rule) => !removals.includes(rule));
  for (const addition of additions) {
    if (!result.includes(addition)) {
      result.push(addition);
    }
  }
  return result;
}

/**
 * 构建写回命令参数：仍有规则时 propset 从临时文件读入，规则清空时 propdel。
 * propset/propdel 是本地属性操作；目录路径含 @ 时须转义。
 */
export function buildWriteArgs(rules: string[], dir: string, tmpFile: string): string[] {
  if (rules.length === 0) {
    return ['propdel', 'svn:ignore', escapePeg(dir)];
  }
  return ['propset', 'svn:ignore', '-F', tmpFile, escapePeg(dir)];
}
