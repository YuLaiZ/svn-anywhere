/**
 * 远端信息的容错读取与展示值构造。core 模块，不依赖 vscode。
 *
 * 与 nodeIdentity 的严格读取分工：nodeIdentity 一次 `svn info` 要求五字段
 * 齐全（缺一即抛解析错误），服务协调与提交前核对；本模块面向「远端信息」
 * 的展示场景——字段各自独立成立，根 URL 等字段缺失时节点 URL 条目仍要
 * 可构造（展示与复制不因个别字段缺失而整体失败）。因此这里对同一条
 * `svn info` 文本输出做可选字段的宽松解析，每个字段独立成功/缺失。
 *
 * 展示口径：svn 输出的 URL 保持原始编码形态（%XX），复制与「已复制」
 * 回显都必须用原始值（两处一致，不二次解码）；QuickPick 展示值才做
 * 逐段解码——每段连续 %XX 各解码一次（不用 decodeURI：%23/%40 等
 * 保留编码不会被它解码，@、# 仍不可读），解码后控制字符重新转义回
 * %XX，解码失败的段原样保留。
 */
import { SvnError, extractSvnErrorCodes } from './errors';
import { runOrThrow, type RunOptions } from './svnCli';
import { escapePeg } from './workspace';

/** 连续 %XX 百分号编码段（一段或多段连续）。 */
const PCT_SEGMENT = /(?:%[0-9a-fA-F]{2})+/g;

/** 远端信息的四类条目。 */
export type RemoteInfoKind = 'nodeUrl' | 'rootUrl' | 'uuid' | 'relativePath';

/** 读取失败分类：未版本控制 / svn 可执行缺失 / 其他失败。 */
export type RemoteInfoFailureReason = 'unversioned' | 'svnMissing' | 'failed';

/** 单个信息条目：原始值（复制与命令行使用）与展示值（解码可读）。 */
export interface RemoteInfoEntry {
  kind: RemoteInfoKind;
  /** svn 输出的原始字符串：进剪贴板与「已复制」回显，原样不二次解码。 */
  raw: string;
  /** 逐段解码后的展示值：中文、空格、@、# 可读，控制字符保持转义。 */
  display: string;
  /** 展示值含 @ 时为 true：该值作为命令行参数会被 svn 当 peg 语法解析。 */
  needsPegHint: boolean;
}

/** 容错读取结果：成功（可能缺字段）或分类后的失败。 */
export type RemoteInfoReadResult =
  | { ok: true; entries: RemoteInfoEntry[]; missing: RemoteInfoKind[] }
  | { ok: false; reason: RemoteInfoFailureReason; message: string; error: SvnError };

/**
 * 展示值解码：对每段连续 %XX 做一次 decodeURIComponent，解码结果中的
 * 控制字符（\u0000-\u001f、\u007f）重新 encodeURIComponent 转义（复制值
 * 仍是原始形态，这里只为展示可读）；某段解码失败（无效 UTF-8 序列等）
 * 该段原样保留。
 */
export function displayDecoded(value: string): string {
  return value.replace(PCT_SEGMENT, (segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return segment;
    }
    let out = '';
    for (const ch of decoded) {
      const code = ch.charCodeAt(0);
      out += code <= 0x1f || code === 0x7f ? encodeURIComponent(ch) : ch;
    }
    return out;
  });
}

/** 适用 --username/--password 凭据补录的 scheme；svn+ssh 的认证由 SSH
 * 配置承载、file 走文件系统权限，注入 HTTP 凭据框与实际认证方式不符。 */
const CREDENTIAL_SCHEMES: readonly string[] = ['http', 'https', 'svn'];

/** 判断副本 URL 是否适用凭据补录（认证补录按副本 URL 的 scheme 分支）。 */
export function isCredentialScheme(url: string): boolean {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
  return match !== null && CREDENTIAL_SCHEMES.includes(match[1].toLowerCase());
}

/**
 * svn info 失败分类：E200009（副本内未纳管或路径不存在）与 E155007
 * （不在任何工作副本内）都提示「未版本控制」；spawn ENOENT（找不到 svn
 * 可执行）指向 svnPath 配置错误，不得误报为未版本控制；其余失败原样
 * 保留原因。
 */
export function classifyInfoError(err: SvnError): { reason: RemoteInfoFailureReason; message: string } {
  if (err.code === 'ENOENT') {
    return { reason: 'svnMissing', message: err.message };
  }
  const codes = extractSvnErrorCodes(`${err.stderr}\n${err.message}`);
  if (codes.includes('E200009') || codes.includes('E155007')) {
    return { reason: 'unversioned', message: err.message };
  }
  return { reason: 'failed', message: err.stderr || err.message };
}

/** 从 svn info 文本输出宽松提取可选字段（每字段独立，缺行即缺失）。 */
function parseInfoFields(stdout: string): {
  url?: string;
  rootUrl?: string;
  uuid?: string;
  relativeUrl?: string;
} {
  let url: string | undefined;
  let rootUrl: string | undefined;
  let uuid: string | undefined;
  let relativeUrl: string | undefined;
  for (const line of stdout.split('\n')) {
    let match = /^URL:\s*(\S+)/.exec(line);
    if (match) {
      url = match[1];
    }
    match = /^Repository Root:\s*(\S+)/.exec(line);
    if (match) {
      rootUrl = match[1];
    }
    match = /^Repository UUID:\s*(\S+)/.exec(line);
    if (match) {
      uuid = match[1];
    }
    match = /^Relative URL:\s*(\S+)/.exec(line);
    if (match) {
      relativeUrl = match[1];
    }
  }
  return { url, rootUrl, uuid, relativeUrl };
}

/**
 * 相对路径回退计算：svn info 未输出 Relative URL 字段时，用节点 URL
 * 去掉仓库根前缀推得 `^/...`（保留原始编码段）；节点即仓库根时为 `^/`。
 * 两者不同源（理论不可达的防御分支）时返回 undefined，按字段缺失处理。
 */
function computeRelativeUrl(url: string, rootUrl: string): string | undefined {
  const root = rootUrl.endsWith('/') ? rootUrl.slice(0, -1) : rootUrl;
  if (url === root) {
    return '^/';
  }
  if (!url.startsWith(`${root}/`)) {
    return undefined;
  }
  return `^/${url.slice(root.length + 1)}`;
}

function makeEntry(kind: RemoteInfoKind, raw: string): RemoteInfoEntry {
  const display = displayDecoded(raw);
  return { kind, raw, display, needsPegHint: display.includes('@') };
}

/**
 * 容错读取目标节点的远端信息（一条 `svn info` 文本输出宽松解析）。
 * 字段缺失不构成失败：缺失项进 missing（调用方据此渲染不可用条目），
 * 已读到的条目照常构造——仓库根读取不到时节点 URL 仍可展示与复制。
 * 命令失败（退出码非零、找不到 svn 等）返回分类结果，不抛错。
 */
export async function readRemoteInfo(
  svnPath: string,
  target: string,
  options: RunOptions = {},
): Promise<RemoteInfoReadResult> {
  const args = ['info', '--', escapePeg(target)];
  let stdout: string;
  try {
    const result = await runOrThrow(svnPath, args, options);
    stdout = result.stdout;
  } catch (err) {
    if (err instanceof SvnError) {
      const classified = classifyInfoError(err);
      return { ok: false, ...classified, error: err };
    }
    throw err;
  }
  const fields = parseInfoFields(stdout);
  const entries: RemoteInfoEntry[] = [];
  const missing: RemoteInfoKind[] = [];
  if (fields.url !== undefined) {
    entries.push(makeEntry('nodeUrl', fields.url));
  } else {
    missing.push('nodeUrl');
  }
  if (fields.rootUrl !== undefined) {
    entries.push(makeEntry('rootUrl', fields.rootUrl));
  } else {
    missing.push('rootUrl');
  }
  if (fields.uuid !== undefined) {
    entries.push(makeEntry('uuid', fields.uuid));
  } else {
    missing.push('uuid');
  }
  // 相对路径优先取 Relative URL 字段；缺失时回退「节点 URL 去根前缀」计算。
  const relativeRaw = fields.relativeUrl
    ?? (fields.url !== undefined && fields.rootUrl !== undefined
      ? computeRelativeUrl(fields.url, fields.rootUrl)
      : undefined);
  if (relativeRaw !== undefined) {
    entries.push(makeEntry('relativePath', relativeRaw));
  } else {
    missing.push('relativePath');
  }
  return { ok: true, entries, missing };
}

/**
 * 读取目标节点的 URL（`svn info --show-item url` 单字段）。本地路径的
 * URL 存于工作副本元数据，读取不访问网络；远端信息命令先用它确定副本
 * 的 scheme，再按 scheme 决定完整读取是否注入凭据补录。失败抛 SvnError
 * （分类走 classifyInfoError）。
 */
export async function readNodeUrl(
  svnPath: string,
  target: string,
  options: RunOptions = {},
): Promise<string> {
  const args = ['info', '--show-item', 'url', escapePeg(target)];
  const result = await runOrThrow(svnPath, args, options);
  const url = result.stdout.trim();
  if (url === '') {
    throw new SvnError({
      message: 'svn info 未返回节点 URL',
      command: args,
      cwd: options.cwd,
      stderr: result.stdout,
      code: 'INFO_PARSE',
    });
  }
  return url;
}
