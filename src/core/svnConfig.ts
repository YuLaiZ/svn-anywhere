/**
 * svn 客户端配置（~/.subversion/config）的 global-ignores 解析。core 模块，
 * 不依赖 vscode。
 *
 * 定位口径（svn 1.15 实测）：svn 子进程以 HOME 环境变量定位
 * ~/.subversion/config（不识别 SVN_CONFIG_DIR 环境变量），本模块读
 * process.env.HOME（回退 os.homedir()）与子进程同源；单测可用注入的
 * 配置文本或路径替代，端到端的临时 HOME 对照由宿主侧验证承担。
 *
 * 解析失败（配置文件存在但格式错误到抛错）抛 SvnConfigError——上层
 * 据此「阻止确认与提交」（无法完整确认忽略范围时不发起导入）。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * svn 内置默认忽略集（键缺省时的回退口径，与 svn 1.15 出厂 config 的
 * 注释展示一致并经实测校准：`*.o` 匹配前导点文件 `.hidden.o`，
 * `[Tt]humbs.db` 不匹配 `Tb.db`——basename 整体匹配、`*` 可跨前导点）。
 */
export const DEFAULT_GLOBAL_IGNORES: readonly string[] = [
  '*.o', '*.lo', '*.la', '*.al', '.libs', '*.so', '*.so.[0-9]*', '*.a',
  '*.pyc', '*.pyo', '__pycache__', '*.rej', '*~', '#*#', '.#*', '.*.swp',
  '.DS_Store', '[Tt]humbs.db',
];

/** 配置解析失败（格式错误或不可读）——上层据此阻止导入确认。 */
export class SvnConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SvnConfigError';
  }
}

/** 逻辑行形态：反斜杠续行已在读取阶段拼接完成。 */
interface ConfigLine {
  text: string;
  /** 1 起的物理起始行号，错误消息定位用。 */
  lineNumber: number;
}

/**
 * 物理行 → 逻辑行：行尾 `\` 紧跟换行时与下一行拼接（实测 svn 1.15 对
 * `global-ignores = *.foo \` + 次行 `*.bar` 的续行生效，漏续行会漏标）。
 * 文件末尾悬挂的 `\`（无下一行）按行尾空白丢弃处理。
 */
function joinContinuations(configText: string): ConfigLine[] {
  const lines = configText.split(/\r\n|\r|\n/);
  const logical: ConfigLine[] = [];
  let index = 0;
  while (index < lines.length) {
    const start = index;
    let text = lines[index];
    while (text.endsWith('\\') && index + 1 < lines.length) {
      text = `${text.slice(0, -1)}${lines[++index]}`;
    }
    if (text.endsWith('\\')) {
      text = text.slice(0, -1);
    }
    logical.push({ text, lineNumber: start + 1 });
    index += 1;
  }
  return logical;
}

/**
 * 解析配置文本中的 global-ignores：只读 [miscellany] 节的 global-ignores
 * 键；值按空白分隔为 fnmatch 风格 glob 模式（匹配对象是路径 basename）；
 * `#`/`;` 开头的注释行跳过；行尾反斜杠续行拼接后再分词。
 *
 * 键缺省时返回内置默认忽略集；键显式存在（值可为空）时按值分词——
 * 空值覆盖默认集、得到空模式列表（与 svn 行为一致）。同名键多次出现
 * 取最后一次（覆盖语义，与 svn 一致）。
 *
 * 以下形态视为格式错误抛 SvnConfigError：节头未闭合（`[misc`）、非
 * 注释非空行缺少 `=` 分隔、键名为空（`= value`）。
 */
export function parseSvnConfigGlobalIgnores(configText: string): string[] {
  let section = '';
  let found: string | undefined;
  for (const { text, lineNumber } of joinContinuations(configText)) {
    const trimmed = text.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) {
      continue;
    }
    const header = /^\[([^\]]*)\]$/.exec(trimmed);
    if (header) {
      section = header[1].trim().toLowerCase();
      continue;
    }
    if (trimmed.startsWith('[')) {
      throw new SvnConfigError(`配置第 ${lineNumber} 行节头未闭合：${trimmed}`);
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      throw new SvnConfigError(`配置第 ${lineNumber} 行不是合法的键值行：${trimmed}`);
    }
    if (section === 'miscellany' && trimmed.slice(0, eq).trim().toLowerCase() === 'global-ignores') {
      found = trimmed.slice(eq + 1);
    }
  }
  if (found === undefined) {
    return [...DEFAULT_GLOBAL_IGNORES];
  }
  return found.trim().split(/\s+/).filter((token) => token !== '');
}

/** svnConfig 读取的可注入参数：三者都缺省时读默认路径。 */
export interface SvnConfigOptions {
  /** 直接注入配置文本（vitest 不起子进程的层）。 */
  configText?: string;
  /** 注入配置文件路径（优先于 homeDir）。 */
  configPath?: string;
  /** 注入 HOME 目录（默认 process.env.HOME，回退 os.homedir()）。 */
  homeDir?: string;
}

/** svn 客户端配置文件的默认路径：HOME 下 .subversion/config。 */
export function svnConfigPath(homeDir: string = process.env.HOME ?? homedir()): string {
  return join(homeDir, '.subversion', 'config');
}

/**
 * 读取并解析 global-ignores。配置文件不存在时返回内置默认集（与 svn
 * 子进程对缺失配置的行为一致）；文件存在但不可读或格式错误抛
 * SvnConfigError——无法完整确认忽略范围，上层阻止导入确认与提交。
 */
export function readSvnConfigGlobalIgnores(options: SvnConfigOptions = {}): string[] {
  let configText: string;
  if (options.configText !== undefined) {
    configText = options.configText;
  } else {
    const path = options.configPath ?? svnConfigPath(options.homeDir);
    try {
      configText = readFileSync(path, 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return [...DEFAULT_GLOBAL_IGNORES];
      }
      throw new SvnConfigError(`无法读取 svn 配置文件 ${path}：${e.message}`);
    }
  }
  return parseSvnConfigGlobalIgnores(configText);
}

/** glob → 正则源码段：fnmatch 风格（* ? [seq]/[!seq]，\ 转义，其余按字面）。 */
function globToRegExpSource(pattern: string): string {
  let out = '';
  let index = 0;
  while (index < pattern.length) {
    const ch = pattern[index];
    if (ch === '\\' && index + 1 < pattern.length) {
      out += pattern[++index].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (ch === '*') {
      out += '.*';
    } else if (ch === '?') {
      out += '.';
    } else if (ch === '[') {
      const close = pattern.indexOf(']', index + 1);
      if (close < 0) {
        // 未闭合的 [ 按字面处理（apr_fnmatch 同样不把孤立的 [ 当通配）。
        out += '\\[';
      } else {
        const body = pattern.slice(index + 1, close);
        out += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
        index = close;
      }
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    index += 1;
  }
  return out;
}

const globCache = new Map<string, RegExp>();

function globRegExp(pattern: string): RegExp {
  let re = globCache.get(pattern);
  if (!re) {
    re = new RegExp(`^${globToRegExpSource(pattern)}$`);
    globCache.set(pattern, re);
  }
  return re;
}

/**
 * basename 与 global-ignores 模式列表的匹配（fnmatch 风格：`*` 跨前导点、
 * `?` 单字符、`[seq]`/`[!seq]` 字符类、`\` 转义；大小写敏感——与 svn 的
 * apr_fnmatch 默认口径一致）。空模式列表不匹配任何名称。
 */
export function matchesGlobalIgnores(patterns: readonly string[], name: string): boolean {
  return patterns.some((pattern) => globRegExp(pattern).test(name));
}
