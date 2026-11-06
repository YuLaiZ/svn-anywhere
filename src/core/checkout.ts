/**
 * 检出（checkout）的 core 原语：URL 校验与默认命名、远端目录检查、
 * 检出/续检参数构建、中断副本可续检核验。core 模块，不依赖 vscode。
 *
 * 深度口径（svn 1.15 实测）：checkout 子命令不接受 --set-depth
 * （`Subcommand 'checkout' doesn't accept option '--set-depth ARG'`），
 * 深度检出用 --depth；续检序列是先 svn cleanup 再 svn update
 * -r <pinned> --set-depth <depth>（update 支持 --set-depth，幂等施加
 * 原深度）。两个口径不可混用。
 *
 * 超时纪律：检出、续检的 cleanup/update 与核验的 status 都可能远超
 * 默认 120 秒（大仓库长任务、十万级文件副本的本地遍历），执行时必须
 * 传 timeoutMs=0（不限时），取消由调用方经 AbortSignal 承担。
 */
import { XMLParser } from 'fast-xml-parser';
import { SvnError, extractSvnErrorCodes, isAuthFailure } from './errors';
import { readNodeIdentity } from './nodeIdentity';
import { runStatus, type StatusResult } from './status';
import { runOrThrow, type RunOptions } from './svnCli';
import { escapePeg } from './workspace';

/** 检出支持的 URL 协议（svn+ssh 允许但不适用凭据补录）。 */
export const CHECKOUT_SCHEMES: readonly string[] = ['http', 'https', 'svn', 'svn+ssh', 'file'];

/** 检出深度四档，映射 svn 的 --depth/--set-depth 取值。 */
export type CheckoutDepth = 'empty' | 'files' | 'immediates' | 'infinity';

/** 连续 %XX 百分号编码段（一段或多段连续）。 */
const PCT_SEGMENT = /(?:%[0-9a-fA-F]{2})+/g;

// ---------------------------------------------------------------------------
// URL 校验
// ---------------------------------------------------------------------------

/** 校验失败原因：协议不支持 / authority 内嵌用户信息 / 查询参数 / 片段 / 未编码字符。 */
export type CheckoutUrlRejectReason = 'scheme' | 'userinfo' | 'query' | 'fragment' | 'unencoded';

export type CheckoutUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: CheckoutUrlRejectReason; message: string };

/**
 * 检出 URL 规范校验：只接受已编码的合法 URI。
 * - 协议限 http/https/svn/svn+ssh/file 五种；
 * - authority 段出现 `user:pass@` 或 `user@`（用户名内嵌）一律拒绝——
 *   用户名不是密码，但内嵌它会让同一 URL 因登录名不同而不稳定，
 *   svn+ssh 的账号由 SSH 配置承载，不进 URL；
 * - 路径段中的 `@` 合法（后续经 escapeUrlPeg 处理）；
 * - query（?）、fragment（#）、原始非 ASCII、空格与控制字符拒绝——
 *   不猜测编码；面板层先把显示值经 encodeEditableURL 逆变换编码，
 *   中文以 %XX 形态进入本校验器。
 */
export function normalizeCheckoutUrl(url: string): CheckoutUrlResult {
  if (url === '') {
    return { ok: false, reason: 'scheme', message: 'URL 不能为空' };
  }
  for (const ch of url) {
    const code = ch.charCodeAt(0);
    if (code <= 0x20 || code > 0x7e) {
      return {
        ok: false,
        reason: 'unencoded',
        message: 'URL 含未编码字符（非 ASCII 字符与空格需以 %XX 百分号编码）',
      };
    }
  }
  if (url.includes('?') || url.includes('#')) {
    return { ok: false, reason: url.includes('?') ? 'query' : 'fragment', message: 'URL 中不填写用户名、密码、查询参数或片段' };
  }
  const match = /^(https?|svn\+ssh|svn|file):\/\//.exec(url);
  if (!match) {
    return { ok: false, reason: 'scheme', message: 'URL 协议必须是 http、https、svn、svn+ssh 或 file' };
  }
  const afterScheme = url.slice(match[0].length);
  const authority = afterScheme.split('/', 1)[0] ?? '';
  if (authority.includes('@')) {
    return { ok: false, reason: 'userinfo', message: 'URL 中不填写用户名、密码、查询参数或片段' };
  }
  return { ok: true, url };
}

// ---------------------------------------------------------------------------
// 默认目录名
// ---------------------------------------------------------------------------

/**
 * 目录名合法性：非空、不是 `.` / `..`、不含路径分隔符（/ 与反斜杠）、
 * 不含控制字符、无首尾空白；中文、空格、`@`、`#` 原样保留。
 */
export function isValidCheckoutName(name: string): boolean {
  if (name === '' || name === '.' || name === '..') {
    return false;
  }
  if (name.includes('/') || name.includes('\\')) {
    return false;
  }
  if (name !== name.trim()) {
    return false;
  }
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}

/**
 * 从 URL 路径取子目录名默认值：最后一个非空路径段做单次
 * decodeURIComponent 解码（失败保留原样编码形态）；无可用段或解码后
 * 为非法名（见 isValidCheckoutName）时返回 undefined，由表单留空待填。
 */
export function defaultCheckoutName(url: string): string | undefined {
  const schemeEnd = url.indexOf('://');
  if (schemeEnd < 0) {
    return undefined;
  }
  const authorityEnd = url.indexOf('/', schemeEnd + 3);
  const path = authorityEnd < 0 ? '' : url.slice(authorityEnd + 1);
  const last = path.split('/').reverse().find((segment) => segment !== '');
  if (last === undefined) {
    return undefined;
  }
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    // 单次解码失败（无效 UTF-8 编码段等）保留原样。
  }
  return isValidCheckoutName(name) ? name : undefined;
}

// ---------------------------------------------------------------------------
// peg 转义（URL 与本地路径）
// ---------------------------------------------------------------------------

/**
 * URL 的 peg 转义：URL 含字面 `@` 或编码的 `%40` 时在末尾补一个 `@`，
 * 让 svn 把整条 URL 当作路径而非 peg 语法解析（svn 在解析 peg 前先对
 * URL 解码一次，字面 @ 与 %40 都会触发 E205000，补尾 @ 后都成功）。
 *
 * 规则：
 * - 先剥掉输入末尾的单个 `@`（用户可能粘贴「命令行须补 @」提示的已
 *   转义形态 `…/a@b@`），剥后统一判定，需要补则统一补回一个——
 *   `escapeUrlPeg('…/a@b@')` 与 `escapeUrlPeg('…/a@b')` 产出相同，
 *   幂等、不产生 `a@b@@` 之类的双重转义；尾 @ 剥除后无 @ 的 URL
 *   （`…/abc@`）按无 peg 处理，返回剥除后的形态（svn 中 `abc@` 与
 *   `abc` 指向同一节点，缺省 peg 即 HEAD，行为等价）；
 * - 对每个 %XX 连续段做一次 decodeURIComponent 探测，结果含 `@` 即
 *   触发（`%40` 出现在任一段——文件名或目录名——同样触发）；
 * - 双重编码的 `%2540` 解码一次后是 `%40`（不含字面 `@`），不误判、
 *   不触发，也不改写内容；
 * - 探测失败（无效 UTF-8 段如 `%D6%D0%40` 整段解码抛错）时回退为
 *   段内不区分大小写查找 `%40`，保证编码段不漏判。
 */
export function escapeUrlPeg(url: string): string {
  const base = url.endsWith('@') ? url.slice(0, -1) : url;
  if (base.includes('@')) {
    return `${base}@`;
  }
  for (const match of base.matchAll(PCT_SEGMENT)) {
    const segment = match[0];
    try {
      if (decodeURIComponent(segment).includes('@')) {
        return `${base}@`;
      }
    } catch {
      if (/%40/i.test(segment)) {
        return `${base}@`;
      }
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// 表单显示值（原始 URI 与可编辑显示值的互转）
// ---------------------------------------------------------------------------

/**
 * 原始规范 URI → 输入框显示值：对每段连续 %XX 做一次解码（失败该段
 * 原样），解码结果中的 ASCII 字符重新 encodeURIComponent、非 ASCII
 * （中文等）保留——中文可读，`%40`（@）与 `%20`/`%23` 等保留转义，
 * 不会被解码成会破坏 URL 形态的字面字符。
 */
export function editableURL(url: string): string {
  return url.replace(PCT_SEGMENT, (segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return segment;
    }
    let out = '';
    for (const ch of decoded) {
      out += ch.charCodeAt(0) < 0x80 ? encodeURIComponent(ch) : ch;
    }
    return out;
  });
}

/**
 * 显示值 → 原始规范 URI（editableURL 的逆变换）：非 ASCII 字符
 * encodeURIComponent 回 %XX，ASCII 字符与既有 %XX 转义原样保留。
 * 不区分「显示带出的中文」与「用户新输入的中文」（无法区分也不必要），
 * 回写后再过 normalizeCheckoutUrl 校验。
 */
export function encodeEditableURL(value: string): string {
  let out = '';
  for (const ch of value) {
    out += ch.charCodeAt(0) < 0x80 ? ch : encodeURIComponent(ch);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 远端检查（svn info --xml）
// ---------------------------------------------------------------------------

/** svn info --xml 的 entry 摘要（URL 目标无 wc-info 段）。 */
export interface RemoteInfoEntry {
  kind: string;
  /** 被查询的 revision（不带 -r 时为 HEAD）。 */
  revision: number;
  url: string;
  relativeUrl: string;
  repositoryUuid: string;
  repositoryRootUrl: string;
}

const infoParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // 路径与 URL 中的首尾空格属于名称，不能改变身份。
  trimValues: false,
  // SVN 用数字实体表示控制字符；解码一次，保留 &amp; 编码的字面实体。
  htmlEntities: true,
  isArray: (name) => name === 'entry',
});

interface InfoXmlEntry {
  kind?: string;
  revision?: string | number;
  url?: string;
  'relative-url'?: string;
  repository?: { root?: string; uuid?: string };
}

/** 解析 `svn info --xml` 输出，取第一个 entry；字段缺失返回 undefined。 */
export function parseInfoXml(xml: string): RemoteInfoEntry | undefined {
  const parsed = infoParser.parse(xml) as { info?: { entry?: InfoXmlEntry[] } };
  const entry = parsed.info?.entry?.[0];
  if (!entry) {
    return undefined;
  }
  const revision = Number(entry.revision);
  const url = typeof entry.url === 'string' ? entry.url : undefined;
  const relativeUrl = typeof entry['relative-url'] === 'string' ? entry['relative-url'] : undefined;
  const repositoryRootUrl = typeof entry.repository?.root === 'string' ? entry.repository.root : undefined;
  const repositoryUuid = typeof entry.repository?.uuid === 'string' ? entry.repository.uuid : undefined;
  if (url === undefined || relativeUrl === undefined || repositoryRootUrl === undefined
    || repositoryUuid === undefined || !Number.isFinite(revision)) {
    return undefined;
  }
  return {
    kind: entry.kind ?? '',
    revision,
    url,
    relativeUrl,
    repositoryUuid,
    repositoryRootUrl,
  };
}

/** 连接检查失败分类；unknown 为无法归类的兜底（消息原样保留）。 */
export type RemoteCheckFailure =
  | 'notDir'
  | 'urlNotFound'
  | 'revisionNotFound'
  | 'connection'
  | 'auth'
  | 'unknown';

/** 远端仓库身份三元组（记录与副本核验共用同一比对基准）。 */
export interface RemoteIdentity {
  repositoryUuid: string;
  repositoryRootUrl: string;
  /** `^/…` 形态的仓库相对路径。 */
  relativeUrl: string;
}

export type CheckRemoteResult =
  | { ok: true; pinnedRevision: number; identity: RemoteIdentity }
  | { ok: false; failure: RemoteCheckFailure; message: string };

export interface CheckRemoteOptions extends RunOptions {
  /** 目标 revision：数字或 'HEAD'（缺省即 HEAD，结果固定为读到的具体 revision）。 */
  revision?: string | number;
}

/** URL 不存在时 svn 在 stderr 先给 W170000 警告再给 E200009 错误。 */
const URL_NOT_FOUND_CODES = new Set(['E200009', 'E160013']);
const REVISION_NOT_FOUND_CODES = new Set(['E160006', 'E160005', 'E195012']);
const CONNECTION_CODES = new Set(['E175002', 'E170013', 'E175013', 'E180001', 'E000104', 'E670003']);

function classifyRemoteError(err: unknown): { ok: false; failure: RemoteCheckFailure; message: string } {
  if (err instanceof SvnError) {
    if (isAuthFailure(err.stderr)) {
      return { ok: false, failure: 'auth', message: err.message };
    }
    const codes = new Set(extractSvnErrorCodes(err.stderr));
    if (codes.has('E200009') || err.stderr.includes('W170000') || [...URL_NOT_FOUND_CODES].some((c) => codes.has(c))) {
      return { ok: false, failure: 'urlNotFound', message: err.message };
    }
    if ([...REVISION_NOT_FOUND_CODES].some((c) => codes.has(c))) {
      return { ok: false, failure: 'revisionNotFound', message: err.message };
    }
    if ([...CONNECTION_CODES].some((c) => codes.has(c))) {
      return { ok: false, failure: 'connection', message: err.message };
    }
    return { ok: false, failure: 'unknown', message: err.message };
  }
  return { ok: false, failure: 'unknown', message: err instanceof Error ? err.message : String(err) };
}

/** 适用 --username/--password 补录的协议；svn+ssh（SSH 配置承载）与 file 不适用。 */
export function schemeAcceptsCredentials(url: string): boolean {
  const scheme = url.slice(0, url.indexOf('://'));
  return scheme === 'http' || scheme === 'https' || scheme === 'svn';
}

/**
 * 连接检查：`svn info --xml [-r rev] <url>` 的封装（URL 走 escapeUrlPeg）。
 * 成功且 entry kind=dir 时返回固定 revision（HEAD 请求解析为读到的具体
 * revision）与仓库身份三元组；file 节点的 info 同样成功，但 checkout
 * 只对目录有意义，此处判「目标不是目录」，避免「检查通过、开始失败」。
 * 失败按 URL 不存在 / 版本不存在 / 连接失败 / 认证失败分类。
 *
 * 凭据注入按协议分支：http/https/svn 透传调用方的 getCredentials（认证
 * 失败弹窗补录重试一次由 svnCli 承担）；svn+ssh/file 不注入——其认证类
 * 失败可能被文本匹配误识别，一律按普通失败呈现（分类仍返回 auth，
 * 是否弹补录框由宿主按协议决定）。
 */
export async function checkRemote(
  svnPath: string,
  url: string,
  options: CheckRemoteOptions = {},
): Promise<CheckRemoteResult> {
  const { revision, ...runOptions } = options;
  const args = ['info', '--xml', '--non-interactive'];
  if (revision !== undefined && String(revision).toUpperCase() !== 'HEAD') {
    args.push('-r', String(revision));
  }
  args.push('--', escapeUrlPeg(url));
  const effectiveOptions: RunOptions = schemeAcceptsCredentials(url)
    ? runOptions
    : { ...runOptions, getCredentials: undefined };
  try {
    const result = await runOrThrow(svnPath, args, effectiveOptions);
    const entry = parseInfoXml(result.stdout);
    if (!entry) {
      return { ok: false, failure: 'urlNotFound', message: '目标不存在（svn info 未返回条目）' };
    }
    if (entry.kind !== 'dir') {
      return { ok: false, failure: 'notDir', message: '目标不是目录' };
    }
    return {
      ok: true,
      pinnedRevision: entry.revision,
      identity: {
        repositoryUuid: entry.repositoryUuid,
        repositoryRootUrl: entry.repositoryRootUrl,
        relativeUrl: entry.relativeUrl,
      },
    };
  } catch (err) {
    return classifyRemoteError(err);
  }
}

// ---------------------------------------------------------------------------
// 检出与续检参数构建
// ---------------------------------------------------------------------------

export interface CheckoutBuildParams {
  /** 连接检查固定下来的 revision（执行与续检都用它，不用 HEAD）。 */
  revision: number;
  depth: CheckoutDepth;
}

/**
 * 检出命令参数：`svn checkout --non-interactive -r <pinned> --depth <d>
 * <url> <目标>`。URL 走 peg 规则（含字面 @ 或 %40 时补尾 @）。目标
 * 目录是创建型路径，svn 对 checkout 的目标参数不做 peg 解析、按字面
 * 处理（实测含 @ 的目标补尾 @ 会建出以 @ 结尾的错误目录名），因此只
 * 对短横线开头的路径加 `./` 前缀防止被当作选项、不追加尾 @；含 @ 的
 * 目标目录名原样传递即可正确创建。深度用 --depth——svn 1.15 的
 * checkout 不接受 --set-depth。执行时必须传 timeoutMs=0（默认 120 秒
 * 会杀掉大仓库长任务并被误判为失败），取消走 AbortSignal。
 */
export function buildCheckoutArgs(url: string, targetDir: string, params: CheckoutBuildParams): string[] {
  const target = targetDir.startsWith('-') ? `./${targetDir}` : targetDir;
  return [
    'checkout',
    '--non-interactive',
    '-r',
    String(params.revision),
    '--depth',
    params.depth,
    escapeUrlPeg(url),
    target,
  ];
}

export interface ResumeBuildParams {
  pinnedRevision: number;
  depth: CheckoutDepth;
}

/**
 * 续检命令序列（中断副本经核验放行后执行）：先普通 `svn cleanup`
 * （解除中断残留的锁，不做磁盘清理），再 `svn update --non-interactive
 * -r <pinned> --set-depth <depth>` 幂等施加原深度——update 支持
 * --set-depth，与 checkout 的 --depth 口径区分。不先 cleanup 直接
 * update 会报 E155004（working copy locked）。两个命令都必须以
 * timeoutMs=0 执行（大副本的 cleanup/update 同样可能超过默认 120 秒）。
 */
export function buildResumeArgs(
  targetDir: string,
  params: ResumeBuildParams,
): { cleanupArgs: string[]; updateArgs: string[] } {
  return {
    cleanupArgs: ['cleanup', escapePeg(targetDir)],
    updateArgs: [
      'update',
      '--non-interactive',
      '-r',
      String(params.pinnedRevision),
      '--set-depth',
      params.depth,
      escapePeg(targetDir),
    ],
  };
}

// ---------------------------------------------------------------------------
// 中断副本可续检核验
// ---------------------------------------------------------------------------

/** 检出记录中冻结的核验基准（连接检查时快照写入）。 */
export interface ResumableExpectation {
  repositoryUuid: string;
  repositoryRootUrl: string;
  relativeUrl: string;
  depth: CheckoutDepth;
  pinnedRevision: number;
}

export type ResumeBlockReason =
  /** 身份/深度/相对路径读取失败（wc.db 中间态损坏、被锁）——无法核验即不放行。 */
  | 'readFailed'
  /** 仓库身份三元组与记录不一致（被 switch 到其他地址等）。 */
  | 'identityMismatch'
  /** 副本实际深度与记录深度不一致（深度不一致单独分类，展示两侧差异）。 */
  | 'depthMismatch'
  /** 副本工作 revision 超过固定 revision（残留与参数不一致）。 */
  | 'revisionMismatch'
  /** svn status 读取失败——无法展示本地状态即不放行续检。 */
  | 'statusFailed';

/** 核验时实际读到的副本状态（供核验页展示与差异说明）。 */
export interface ResumedCopyState {
  url: string;
  repositoryUuid: string;
  repositoryRootUrl: string;
  relativeUrl: string;
  depth: string;
  workingRevision: number;
}

export interface VerifyReport {
  kind: 'resumable' | 'resumeBlocked';
  blockReason?: ResumeBlockReason;
  message?: string;
  /** 实际读到的副本状态；首个读取命令失败时可能不完整。 */
  identity?: Partial<ResumedCopyState>;
  /** 本地状态快照（核验页展示本地改动与未完成状态，供用户判断）。 */
  status?: StatusResult;
}

function blockedCopy(reason: ResumeBlockReason, message: string, identity?: Partial<ResumedCopyState>): VerifyReport {
  return { kind: 'resumeBlocked', blockReason: reason, message, identity };
}

/**
 * 核验中断副本可否续检（只读，不改检出记录、不发写命令）。
 *
 * 比对不做 URL 字符串直比——SVN 会规范化尾斜杠与百分号编码大小写，
 * 等价 URL 的字符串可能不同——改用 repositoryUuid + repositoryRootUrl
 * + relative-url 三元组（`^/…` 形态，两侧都来自 svn 规范化输出）：
 * 三元组一致 ∧ 深度一致（svn info --show-item depth，文本 info 无
 * Depth 字段必须用 --show-item）∧ 工作 revision ≤ pinnedRevision 即
 * 候选可续。
 *
 * svn status 的条目内容不据此阻断：中断副本的 missing/locked 条目是
 * 正常未完成状态，正是续检要补全的对象；仅 status 命令读取失败
 * （wc.db 被锁等）保守判 resumeBlocked——无法展示本地状态即不放行。
 */
export async function verifyResumable(
  svnPath: string,
  targetDir: string,
  expectation: ResumableExpectation,
  options: RunOptions = {},
): Promise<VerifyReport> {
  let state: ResumedCopyState;
  try {
    const identity = await readNodeIdentity(svnPath, targetDir, options);
    const relativeUrl = await showItem(svnPath, targetDir, 'relative-url', options);
    const depth = await showItem(svnPath, targetDir, 'depth', options);
    state = {
      url: identity.url,
      repositoryUuid: identity.repositoryUuid,
      repositoryRootUrl: identity.repositoryRootUrl,
      relativeUrl,
      depth,
      workingRevision: identity.revision,
    };
  } catch (err) {
    return blockedCopy('readFailed', err instanceof Error ? err.message : String(err));
  }

  if (state.repositoryUuid !== expectation.repositoryUuid
    || state.repositoryRootUrl !== expectation.repositoryRootUrl
    || state.relativeUrl !== expectation.relativeUrl) {
    return blockedCopy('identityMismatch', '副本仓库身份与检出记录不一致', state);
  }
  if (state.depth !== expectation.depth) {
    return blockedCopy('depthMismatch', `副本深度 ${state.depth} 与记录深度 ${expectation.depth} 不一致`, state);
  }
  if (state.workingRevision > expectation.pinnedRevision) {
    return blockedCopy(
      'revisionMismatch',
      `副本工作 revision ${state.workingRevision} 超过固定 revision ${expectation.pinnedRevision}`,
      state,
    );
  }

  // status 不限时：十万级文件副本的本地 status 可超过默认 120 秒，
  // 超时会被误判成 resumeBlocked（把可续检副本错误阻断）；status 无
  // 网络等待，耗时上限受本地遍历限制，不限时是安全的。
  try {
    const status = await runStatus(svnPath, targetDir, { ...options, timeoutMs: 0 });
    return { kind: 'resumable', identity: state, status };
  } catch (err) {
    return blockedCopy('statusFailed', err instanceof Error ? err.message : String(err), state);
  }
}

/** 读 `svn info --show-item <item> <目标>` 的单字段输出（trimmed）。 */
async function showItem(
  svnPath: string,
  targetDir: string,
  item: 'relative-url' | 'depth',
  options: RunOptions,
): Promise<string> {
  const result = await runOrThrow(
    svnPath,
    ['info', '--show-item', item, '--', escapePeg(targetDir)],
    options,
  );
  return result.stdout.trim();
}
