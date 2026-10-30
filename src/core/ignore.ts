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
 * （实测 svn 1.15），属正常情形按空规则处理；其余失败原样抛出。
 */
export async function readIgnoreRules(
  svnPath: string,
  dir: string,
  options: RunOptions = {},
): Promise<string[]> {
  const args = ['propget', 'svn:ignore', escapePeg(dir)];
  const result = await run(svnPath, args, options);
  if (result.exitCode !== 0) {
    if (result.stderr.includes('W200017')) {
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
