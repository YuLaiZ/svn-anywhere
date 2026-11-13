/**
 * P6 快照比较的目标节点解析、目录/文件两端口径与候选构造。core 模块，
 * 不依赖 vscode。
 *
 * 口径（技术方案 §4.3/§4.4 与阶段 0 V3 实测）：
 * - 端点解析区分 present / absent（已知删除）/ notFoundAtRevision：
 *   `svn info --xml -r <rev> URL@<rev>` 成功即 present；失败为「不存在」
 *   （`W170000`/`W160013` + `E200009`）时，只有删除提交可由 deletionRevision
 *   解释为 absent，其余按 notFoundAtRevision 返回，不拿删除后的 URL 读取
 *   内容，也不静默猜测来源；认证/权限/网络错误原样抛出，不误报删除；
 * - 任何 `URL@REV` 都经 svnCli.urlWithPeg 构造（含字面 @ 的 URL 必须补
 *   peg，无 revision 也追加空 peg）；远端命令一律带 `--non-interactive`；
 * - summarize（`svn diff --xml --summarize --old --new`）输出路径以 `--old`
 *   根为基准（HTTP 为完整 URL、file:// 为旧根 + 相对路径，空格为 %20）；
 *   目录候选必须从旧根剥离相对路径后再拼到右/新根，**禁止直接把输出 URL
 *   当右端 URL**（实测会读到旧根内容）；候选按相对路径自建索引并稳定排序，
 *   不依赖返回顺序（1.6.17 同一请求 5 次出现 2 种顺序）；
 * - 保留 `(item, kind)` 二元组：同路径类型替换输出 deleted(旧 kind) +
 *   added(新 kind) 两条同 URL 记录，不能按 URL 去重；属性-only 的 item
 *   字面值为 `none`；
 * - 单端不存在时改用 `svn list --xml --depth infinity -r <rev> URL@<rev>`
 *   流式枚举存在端；已删除路径的枚举必须同时带 peg 与 operative revision，
 *   缺 peg 默认 HEAD 会 `W160013` 失败；`<name>` 为原样名称（空格原样），
 *   与 summarize 的 URL 编码 path 是两套语义（这里统一转成逐段编码的
 *   相对路径）；
 * - 目录候选预算固定 50,000 条目 / 64 MiB XML（解析侧），任一超限返回
 *   `tooLarge`，不展示部分候选冒充完整差异；正常 summarize 同样走
 *   `runStream + StringDecoder('utf8') + saxes` 流式 SAX，不先累计整段 XML
 *   （阶段 0 实测整段缓冲 6–65 MB XML 达 77–264 MiB 增量内存，必须流式）；
 * - 内容层面的二进制判定（svn:mime-type + NUL）由 remoteContent 承担；
 *   本模块只回答节点 kind、表格差异（item/props）与两端存在性/实际 URL。
 */
import { SaxesParser } from 'saxes';
import { SvnError, extractSvnErrorCodes, tailText } from './errors';
import { parseRemoteInfoXml, type RepoNodeRef } from './remoteBrowse';
import { runOrThrow, runStream, urlWithPeg, Utf8StreamDecoder, type RunOptions, type RunStreamResult } from './svnCli';

// 共享目标身份（技术方案 §2.2 冻结契约）由 remoteBrowse 定义；这里只复用，
// 避免两套 RepoNodeRef 漂移。其中 relativePath 为逐段解码后的仓库相对路径。
export type { RepoNodeRef } from './remoteBrowse';

/** 目录候选的条目预算：50,000 条（技术方案 §4.4 固定预算）。 */
export const SNAPSHOT_ENTRY_LIMIT = 50_000;

/** 目录候选的 XML 字节预算：64 MiB（技术方案 §4.4 固定预算）。 */
export const SNAPSHOT_XML_BYTE_LIMIT = 64 * 1024 * 1024;

/** 删除前回退的历史 revision 尝试上限（含 deletionRevision-1 本身）。 */
export const DELETION_FALLBACK_LIMIT = 8;

/** 目录枚举 / summarize 的解析预算。 */
export interface SnapshotParseBudget {
  maxEntries: number;
  maxBytes: number;
}

export const DEFAULT_SNAPSHOT_BUDGET: SnapshotParseBudget = {
  maxEntries: SNAPSHOT_ENTRY_LIMIT,
  maxBytes: SNAPSHOT_XML_BYTE_LIMIT,
};

/** 解析预算超限：由 SAX 收集器在流式回调内抛出，驱动层映射为 tooLarge。 */
export class SnapshotBudgetError extends Error {
  readonly limit: 'entries' | 'bytes';

  constructor(limit: 'entries' | 'bytes') {
    super(limit === 'entries' ? '快照条目数超过上限' : '快照 XML 字节数超过上限');
    this.name = 'SnapshotBudgetError';
    this.limit = limit;
  }
}

/** 单个端点（左/旧 或 右/新）的解析结果。 */
export type SnapshotNodeState =
  | {
      state: 'present';
      node: RepoNodeRef;
      /** 文件字节数（来自 info entry@size；目录与未知时省略，供内容预算预检）。 */
      sizeBytes?: number;
    }
  /** 已知删除提交可以解释为「该 revision 不存在」；deletedAtRevision 为删除提交（若已知）。 */
  | { state: 'absent'; url: string; revision: number; deletedAtRevision?: number }
  /** 无法由删除/复制窗口解释的「该 revision 不存在」。 */
  | { state: 'notFoundAtRevision'; url: string; revision: number };

/** 端点解析入参：URL 为原始编码值（不含 peg），revision 必须为具体数字。 */
export interface ResolveSnapshotNodeParams {
  url: string;
  revision: number;
  /**
   * 已知删除提交（来自 log/复制窗口）。信息读取失败为「不存在」且
   * revision >= deletionRevision 时返回 absent(deleted)，否则 notFoundAtRevision。
   */
  deletionRevision?: number;
}

/** 端点解析结果中可实施的节点动作（更新动作由宿主按本地上下文另行加门禁）。 */
export type SnapshotNodeAction =
  | 'openContent'
  | 'exportVersion'
  | 'blame'
  | 'checkoutRevision'
  | 'exportPrecedingVersion';

/** 由端点存在性/类型导出核心可用动作（不含宿主门禁与二进制探测）。 */
export function snapshotNodeActions(state: SnapshotNodeState): SnapshotNodeAction[] {
  switch (state.state) {
    case 'present':
      return state.node.kind === 'file'
        ? ['openContent', 'exportVersion', 'blame']
        : ['checkoutRevision'];
    case 'absent':
      return ['exportPrecedingVersion'];
    case 'notFoundAtRevision':
      return [];
  }
}

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** svn 输出里的 W/E 六位错误码（信息读取失败要靠 W170000/W160013 区分「不存在」）。 */
function extractWarningAndErrorCodes(text: string): string[] {
  return [...text.matchAll(/\b[WE]\d{6}\b/g)].map((match) => match[0]);
}

/** 是否属于「路径在该 revision 不存在」类失败（不是认证/网络/权限）。 */
function isNotExistFailure(text: string): boolean {
  const codes = extractWarningAndErrorCodes(text);
  return codes.some((code) => code === 'W170000' || code === 'W160013' || code === 'E160013');
}

/** 归一化 URL 根：去掉尾部斜杠（`file://` 这类只有协议分隔符的形态除外）。 */
function normalizeRootUrl(url: string): string {
  let root = url;
  while (root.length > 0 && root.endsWith('/') && !root.endsWith('://')) {
    root = root.slice(0, -1);
  }
  return root;
}

function decodeUrlSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * 从 summarize 输出路径剥离 `--old` 根，返回相对路径（保持百分号编码）。
 *
 * 优先按原样前缀剥离；编码大小写等差异导致前缀不匹配时，逐段解码比较
 * 后仍从输出路径取编码段，保证「旧根 + 相对路径」的稳定映射。路径不以
 * 旧根为基准时返回 undefined，调用方不得猜测。
 */
export function relativePathUnderRoot(rootUrl: string, outputPath: string): string | undefined {
  const root = normalizeRootUrl(rootUrl);
  if (outputPath === root) {
    return '';
  }
  if (outputPath.startsWith(`${root}/`)) {
    return outputPath.slice(root.length + 1);
  }
  const rootSegments = root.split('/');
  const pathSegments = outputPath.split('/');
  if (pathSegments.length <= rootSegments.length) {
    return undefined;
  }
  for (let index = 0; index < rootSegments.length; index += 1) {
    if (decodeUrlSegment(pathSegments[index]) !== decodeUrlSegment(rootSegments[index])) {
      return undefined;
    }
  }
  return pathSegments.slice(rootSegments.length).join('/');
}

/**
 * 把逐段编码的相对路径接到 URL 根上：相对路径为空时返回根本身；不重复
 * 拼仓库根、不二次编码。relativePath 必须是 `relativePathUnderRoot` 或
 * list 名称逐段编码后的结果。
 */
export function joinSnapshotUrl(rootUrl: string, relativePath: string): string {
  const root = normalizeRootUrl(rootUrl);
  return relativePath === '' ? root : `${root}/${relativePath}`;
}

/** 由非零退出码构造 SvnError（保留 stderr 供认证/权限/网络分类）。 */
function commandFailure(args: string[], options: RunOptions, stderr: string, exitCode: number): SvnError {
  return new SvnError({
    message: tailText(stderr.trim() || `svn ${args[0]} 退出码 ${exitCode}`),
    command: args,
    cwd: options.cwd,
    exitCode,
    stderr: tailText(stderr),
    code: extractSvnErrorCodes(stderr)[0],
  });
}

/**
 * 解析单个目标节点在指定 revision 的形态。
 *
 * - 成功：present，返回原始 URL、仓库根/UUID、相对路径、快照 revision 与
 *   节点最后修改信息；
 * - 路径在该 revision 不存在：删除提交可由 deletionRevision 解释时返回
 *   absent(deleted)，否则 notFoundAtRevision；
 * - 认证/权限/网络及其他失败：抛 SvnError（错误码保留在 stderr/code 中），
 *   不得把这类失败误报为删除。
 */
export async function resolveSnapshotNode(
  svnPath: string,
  params: ResolveSnapshotNodeParams,
  options: RunOptions = {},
): Promise<SnapshotNodeState> {
  const args = [
    'info', '--xml', '--non-interactive',
    '-r', String(params.revision),
    '--', urlWithPeg(params.url, params.revision),
  ];
  let stdout: string;
  try {
    stdout = (await runOrThrow(svnPath, args, options)).stdout;
  } catch (err) {
    if (err instanceof SvnError) {
      const text = `${err.stderr}\n${err.message}`;
      if (isNotExistFailure(text)) {
        if (params.deletionRevision !== undefined && params.revision >= params.deletionRevision) {
          return {
            state: 'absent',
            url: params.url,
            revision: params.revision,
            deletedAtRevision: params.deletionRevision,
          };
        }
        return { state: 'notFoundAtRevision', url: params.url, revision: params.revision };
      }
    }
    throw err;
  }
  let info: ReturnType<typeof parseRemoteInfoXml>;
  try {
    info = parseRemoteInfoXml(stdout);
  } catch (err) {
    throw new SvnError({
      message: `svn info XML 解析失败：${err instanceof Error ? err.message : String(err)}`,
      command: args,
      cwd: options.cwd,
      stderr: tailText(stdout),
      code: 'INFO_PARSE',
    });
  }
  if (!info) {
    throw new SvnError({
      message: 'svn info --xml 输出缺少节点必需字段（URL/仓库根/UUID/kind/revision）',
      command: args,
      cwd: options.cwd,
      stderr: tailText(stdout),
      code: 'INFO_PARSE',
    });
  }
  return info.sizeBytes === undefined
    ? { state: 'present', node: info.node }
    : { state: 'present', node: info.node, sizeBytes: info.sizeBytes };
}

/** 删除前可读版本的解析结果。 */
export type DeletionPrecedingResult =
  | {
      state: 'present';
      revision: number;
      node: RepoNodeRef;
      /** 首个候选（deletionRevision-1）不可读，经历史前序回退得到。 */
      viaHistoryFallback: boolean;
    }
  | { state: 'notFound'; requestedRevision: number };

/** 删除前版本解析入参。 */
export interface ResolveDeletionPrecedingParams {
  /** 已删除节点在删除前的原始 URL（当前名称）。 */
  url: string;
  /** 删除提交的 revision。 */
  deletionRevision: number;
  /**
   * 历史前序回退候选（来自 P6 已加载历史/复制窗口的 revision，新→旧）。
   * `deletionRevision - 1` 不可读时按序尝试；不传则只尝试 deletionRevision-1。
   */
  fallbackRevisions?: readonly number[];
  /** 回退尝试上限，默认 DELETION_FALLBACK_LIMIT。 */
  fallbackLimit?: number;
}

/**
 * 解析删除提交的「导出删除前版本」内容 revision：先用 deletionRevision-1；
 * 该 revision 仍不可读时按历史前序候选（fallbackRevisions）向前回退，并
 * 明确实际可读的 revision 与节点。所有候选都在对应 revision 重新解析
 * 实际节点 URL（复制场景以该 revision 的 info 结果为准）。
 *
 * 只有「不存在」才会触发回退；认证/权限/网络错误原样抛出——权限屏蔽
 * 无法由客户端猜测成某个历史版本。
 */
export async function resolveDeletionPrecedingRevision(
  svnPath: string,
  params: ResolveDeletionPrecedingParams,
  options: RunOptions = {},
): Promise<DeletionPrecedingResult> {
  const limit = params.fallbackLimit ?? DELETION_FALLBACK_LIMIT;
  const candidates: number[] = [];
  const primary = params.deletionRevision - 1;
  if (primary >= 0) {
    candidates.push(primary);
  }
  for (const revision of params.fallbackRevisions ?? []) {
    if (revision >= 0 && revision < params.deletionRevision && !candidates.includes(revision)) {
      candidates.push(revision);
    }
  }
  const attempts = Math.min(limit, candidates.length);
  for (let index = 0; index < attempts; index += 1) {
    const revision = candidates[index];
    const resolved = await resolveSnapshotNode(svnPath, { url: params.url, revision }, options);
    if (resolved.state === 'present') {
      return {
        state: 'present',
        revision,
        node: resolved.node,
        viaHistoryFallback: index > 0,
      };
    }
    if (resolved.state === 'absent') {
      // 候选 revision 本身处于删除之后：继续向前回退。
      continue;
    }
  }
  return { state: 'notFound', requestedRevision: params.deletionRevision };
}

/* ------------------------------ XML 流式收集器 ------------------------------ */

function resolveBudget(budget?: Partial<SnapshotParseBudget>): SnapshotParseBudget {
  return {
    maxEntries: budget?.maxEntries ?? DEFAULT_SNAPSHOT_BUDGET.maxEntries,
    maxBytes: budget?.maxBytes ?? DEFAULT_SNAPSHOT_BUDGET.maxBytes,
  };
}

/** 流式 SAX 收集器的公共形态：喂文本、结束时取结果（关闭 XML 文档）。 */
interface SaxCollector<T> {
  feed(text: string): void;
  end(): T;
}

interface SummarizeXmlState {
  item: string;
  props: string;
  kind: string;
  text: string;
}

class SummarizeXmlCollector implements SaxCollector<SummarizeEntry[]> {
  private readonly parser = new SaxesParser({ xmlns: false });
  private readonly entries: SummarizeEntry[] = [];
  private bytes = 0;
  private current: SummarizeXmlState | undefined;

  constructor(private readonly budget: SnapshotParseBudget) {
    this.parser.on('opentag', (tag) => {
      if (tag.name === 'path') {
        this.current = {
          item: tag.attributes.item ?? '',
          props: tag.attributes.props ?? '',
          kind: tag.attributes.kind ?? '',
          text: '',
        };
      }
    });
    this.parser.on('text', (text) => {
      if (this.current) {
        this.current.text += text;
      }
    });
    this.parser.on('cdata', (text) => {
      if (this.current) {
        this.current.text += text;
      }
    });
    this.parser.on('closetag', (tag) => {
      if (tag.name === 'path' && this.current) {
        this.push(this.current);
        this.current = undefined;
      }
    });
  }

  private push(state: SummarizeXmlState): void {
    if (this.entries.length >= this.budget.maxEntries) {
      throw new SnapshotBudgetError('entries');
    }
    // 保留 (item, kind) 二元组；同 URL 的 deleted+added 两条都保留，不去重。
    this.entries.push({
      path: state.text,
      item: state.item,
      props: state.props,
      kind: state.kind,
    });
  }

  feed(text: string): void {
    this.bytes += Buffer.byteLength(text, 'utf8');
    if (this.bytes > this.budget.maxBytes) {
      throw new SnapshotBudgetError('bytes');
    }
    this.parser.write(text);
  }

  end(): SummarizeEntry[] {
    this.parser.close();
    return this.entries;
  }
}

/** `svn diff --xml --summarize` 的单条记录（保留 svn 原词，不做归一化）。 */
export interface SummarizeEntry {
  /** 输出原始路径：以 `--old` 根为基准的 URL（空格为 %20）。 */
  path: string;
  /** 原 item 值：added / deleted / modified / none（属性-only 为 none）。 */
  item: string;
  /** 原 props 值：none / modified。 */
  props: string;
  /** 原 kind 值：file / dir。 */
  kind: string;
}

/** 解析 `svn diff --xml --summarize` 输出（小数据/测试用；生产走流式）。 */
export function parseSummarizeXml(
  xml: string,
  budget?: Partial<SnapshotParseBudget>,
): SummarizeEntry[] {
  const collector = new SummarizeXmlCollector(resolveBudget(budget));
  collector.feed(xml);
  return collector.end();
}

/** `svn list --xml --depth infinity` 的条目（相对目标根）。 */
export interface SnapshotListEntry {
  /** 相对目标根的逐段百分号编码路径（list 的 name 是原样名称，这里编码）。 */
  relativePath: string;
  kind: string;
  size?: number;
  lastChangedRevision?: number;
  lastChangedAuthor?: string;
  lastChangedDate?: string;
}

interface ListEntryState {
  kind: string;
  name: string;
  size?: number;
  commitRevision?: number;
  author?: string;
  date?: string;
}

class ListXmlCollector implements SaxCollector<SnapshotListEntry[]> {
  private readonly parser = new SaxesParser({ xmlns: false });
  private readonly entries: SnapshotListEntry[] = [];
  private bytes = 0;
  private current: ListEntryState | undefined;
  private activeField: 'name' | 'size' | 'author' | 'date' | undefined;
  private buffer = '';

  constructor(private readonly budget: SnapshotParseBudget) {
    this.parser.on('opentag', (tag) => {
      switch (tag.name) {
        case 'entry':
          this.current = { kind: tag.attributes.kind ?? '', name: '' };
          break;
        case 'name':
        case 'size':
          this.activeField = tag.name;
          this.buffer = '';
          break;
        case 'commit':
          if (this.current) {
            this.current.commitRevision = toNumber(tag.attributes.revision);
          }
          break;
        case 'author':
        case 'date':
          this.activeField = tag.name;
          this.buffer = '';
          break;
        default:
          break;
      }
    });
    this.parser.on('text', (text) => {
      if (this.activeField !== undefined) {
        this.buffer += text;
      }
    });
    this.parser.on('cdata', (text) => {
      if (this.activeField !== undefined) {
        this.buffer += text;
      }
    });
    this.parser.on('closetag', (tag) => {
      switch (tag.name) {
        case 'name':
          if (this.current) {
            this.current.name = this.buffer;
          }
          this.activeField = undefined;
          break;
        case 'size':
          if (this.current) {
            this.current.size = toNumber(this.buffer);
          }
          this.activeField = undefined;
          break;
        case 'author':
          if (this.current) {
            this.current.author = this.buffer;
          }
          this.activeField = undefined;
          break;
        case 'date':
          if (this.current) {
            this.current.date = this.buffer;
          }
          this.activeField = undefined;
          break;
        case 'entry':
          if (this.current) {
            this.push(this.current);
            this.current = undefined;
          }
          break;
        default:
          break;
      }
    });
  }

  private push(state: ListEntryState): void {
    if (this.entries.length >= this.budget.maxEntries) {
      throw new SnapshotBudgetError('entries');
    }
    if (state.name === '') {
      return;
    }
    this.entries.push({
      // list 的 <name> 是原样名称（空格/中文/emoji 原样，可含 / 的相对路径）；
      // 逐段 encodeURIComponent 得到与 summarize URL 编码 path 对齐的形态。
      relativePath: state.name.split('/').map((segment) => encodeURIComponent(segment)).join('/'),
      kind: state.kind,
      size: state.size,
      lastChangedRevision: state.commitRevision,
      lastChangedAuthor: state.author,
      lastChangedDate: state.date,
    });
  }

  feed(text: string): void {
    this.bytes += Buffer.byteLength(text, 'utf8');
    if (this.bytes > this.budget.maxBytes) {
      throw new SnapshotBudgetError('bytes');
    }
    this.parser.write(text);
  }

  end(): SnapshotListEntry[] {
    this.parser.close();
    return this.entries;
  }
}

/** 解析 `svn list --xml` 输出（小数据/测试用；生产走流式）。 */
export function parseListXml(
  xml: string,
  budget?: Partial<SnapshotParseBudget>,
): SnapshotListEntry[] {
  const collector = new ListXmlCollector(resolveBudget(budget));
  collector.feed(xml);
  return collector.end();
}

/* ------------------------------ 流式命令驱动 ------------------------------ */

type SaxStreamOutcome<T> =
  | { kind: 'parsed'; value: T; stderr: string }
  | { kind: 'failed'; stderr: string; exitCode: number }
  | { kind: 'tooLarge'; limit: 'entries' | 'bytes' };

/**
 * 以 runStream + Utf8StreamDecoder + saxes 执行命令：stdout 不累计整段，
 * 按块喂 SAX；预算越限在回调内抛出并终止子进程，映射为 tooLarge。
 * 退出码非零时不关闭 XML（多条错误路径的 stdout 是未闭合文档），原样
 * 返回 stderr/exitCode 供调用方分类，绝不把半截输出当结果。
 */
async function runSaxStream<T>(
  svnPath: string,
  args: string[],
  options: RunOptions,
  makeCollector: () => SaxCollector<T>,
): Promise<SaxStreamOutcome<T>> {
  const collector = makeCollector();
  const decoder = new Utf8StreamDecoder();
  let result: RunStreamResult;
  try {
    result = await runStream(svnPath, args, {
      ...options,
      onStdoutChunk: (chunk) => {
        collector.feed(decoder.write(chunk));
      },
    });
  } catch (err) {
    if (err instanceof SnapshotBudgetError) {
      return { kind: 'tooLarge', limit: err.limit };
    }
    if (err instanceof SvnError) {
      throw err;
    }
    throw new SvnError({
      message: `XML 解析失败：${err instanceof Error ? err.message : String(err)}`,
      command: args,
      cwd: options.cwd,
      code: 'XML_PARSE',
    });
  }
  if (result.exitCode !== 0) {
    return { kind: 'failed', stderr: result.stderr, exitCode: result.exitCode };
  }
  try {
    const tail = decoder.end();
    if (tail !== '') {
      collector.feed(tail);
    }
    return { kind: 'parsed', value: collector.end(), stderr: result.stderr };
  } catch (err) {
    if (err instanceof SnapshotBudgetError) {
      return { kind: 'tooLarge', limit: err.limit };
    }
    throw new SvnError({
      message: `XML 解析失败：${err instanceof Error ? err.message : String(err)}`,
      command: args,
      cwd: options.cwd,
      code: 'XML_PARSE',
    });
  }
}

/** summarize 命令的执行结果。 */
export type SummarizeResult =
  | { state: 'ready'; entries: SummarizeEntry[] }
  /** 目标在某一端不可读（E160013）：调用方改走单端 list 枚举。 */
  | { state: 'notFound' }
  | { state: 'tooLarge'; limit: 'entries' | 'bytes' };

/** summarize 入参：两端为已解析的实际节点 URL 与具体 revision。 */
export interface SummarizeSnapshotsParams {
  oldUrl: string;
  oldRevision: number;
  newUrl: string;
  newRevision: number;
}

/**
 * 执行 `svn diff --xml --summarize --old <oldUrl@rev> --new <newUrl@rev>`。
 * 输出路径以 --old 根为基准；调用方必须按 relativePathUnderRoot 映射。
 */
export async function summarizeSnapshots(
  svnPath: string,
  params: SummarizeSnapshotsParams,
  options: RunOptions = {},
  budget?: Partial<SnapshotParseBudget>,
): Promise<SummarizeResult> {
  const args = [
    'diff', '--xml', '--summarize', '--non-interactive',
    '--old', urlWithPeg(params.oldUrl, params.oldRevision),
    '--new', urlWithPeg(params.newUrl, params.newRevision),
  ];
  const parsedBudget = resolveBudget(budget);
  const outcome = await runSaxStream(
    svnPath,
    args,
    options,
    () => new SummarizeXmlCollector(parsedBudget),
  );
  switch (outcome.kind) {
    case 'tooLarge':
      return { state: 'tooLarge', limit: outcome.limit };
    case 'failed':
      if (isNotExistFailure(outcome.stderr)) {
        return { state: 'notFound' };
      }
      throw commandFailure(args, options, outcome.stderr, outcome.exitCode);
    case 'parsed':
      return { state: 'ready', entries: outcome.value };
  }
}

/** 单端目录枚举结果。 */
export type SnapshotEnumerationResult =
  | { state: 'ready'; entries: SnapshotListEntry[] }
  | { state: 'notFound' }
  | { state: 'tooLarge'; limit: 'entries' | 'bytes' };

/** 单端枚举入参：URL 为目标根原始 URL，revision 为快照 revision。 */
export interface EnumerateSnapshotParams {
  url: string;
  revision: number;
}

/**
 * 用 `svn list --xml --depth infinity -r <rev> URL@<rev>` 流式枚举目标根
 * 以下条目。已删除路径必须同时带 peg 与 operative revision（缺 peg 默认
 * HEAD 会 W160013 失败）；条目名称不 trim，逐段编码后作为相对路径。
 */
export async function enumerateSnapshot(
  svnPath: string,
  params: EnumerateSnapshotParams,
  options: RunOptions = {},
  budget?: Partial<SnapshotParseBudget>,
): Promise<SnapshotEnumerationResult> {
  const args = [
    'list', '--xml', '--non-interactive', '--depth', 'infinity',
    '-r', String(params.revision),
    '--', urlWithPeg(params.url, params.revision),
  ];
  const parsedBudget = resolveBudget(budget);
  const outcome = await runSaxStream(
    svnPath,
    args,
    options,
    () => new ListXmlCollector(parsedBudget),
  );
  switch (outcome.kind) {
    case 'tooLarge':
      return { state: 'tooLarge', limit: outcome.limit };
    case 'failed':
      if (isNotExistFailure(outcome.stderr)) {
        return { state: 'notFound' };
      }
      throw commandFailure(args, options, outcome.stderr, outcome.exitCode);
    case 'parsed':
      return { state: 'ready', entries: outcome.value };
  }
}

/* ------------------------------ 比较与候选 ------------------------------ */

/** 比较端点入参：URL 必须已是解析后的实际节点 URL（复制来源由历史层给出）。 */
export interface SnapshotEndpointInput {
  url: string;
  revision: number;
  /** 已知删除提交（用于把「不存在」解释为 absent(deleted)）。 */
  deletionRevision?: number;
  /** 已解析的端点状态（提供时不再调用 svn info；调用方保证与 url/revision 一致）。 */
  resolved?: SnapshotNodeState;
}

/** 单条差异候选：同时回答两端存在性、实际 URL、节点类型与 (item, props, kind)。 */
export interface SnapshotDiffCandidate {
  /** 相对比较目标根的逐段编码路径（文件目标为 ''；目录根自身也为 ''）。 */
  relativePath: string;
  /** svn summarize 原 item 词（added/deleted/modified/none）；单端枚举为 added/deleted。 */
  item: string;
  /** svn summarize 原 props 词（none/modified）。 */
  props: string;
  /** 该记录的节点类型原词（file/dir）；与 item 组成二元组，同 URL 两条不去重。 */
  kind: string;
  leftPresent: boolean;
  rightPresent: boolean;
  /** 左/旧端实际 URL（该端不存在时为 undefined）。 */
  leftUrl?: string;
  /** 右/新端实际 URL（该端不存在时为 undefined）。 */
  rightUrl?: string;
  leftRevision?: number;
  rightRevision?: number;
}

/** 比较候选来源（诊断与 UI 状态）。 */
export type SnapshotDiffSource = 'summarize' | 'list-left' | 'list-right' | 'endpoint' | 'none';

/** 比较结果：任一预算超限整体 tooLarge，不展示部分候选冒充完整差异。 */
export type SnapshotCompareResult =
  | {
      state: 'ready';
      left: SnapshotNodeState;
      right: SnapshotNodeState;
      source: SnapshotDiffSource;
      candidates: SnapshotDiffCandidate[];
    }
  | {
      state: 'tooLarge';
      limit: 'entries' | 'bytes';
      left: SnapshotNodeState;
      right: SnapshotNodeState;
      source: SnapshotDiffSource;
    };

/** 比较入参：targetKind 由历史目标类型决定（目录历史 / 文件历史）。 */
export interface CompareSnapshotsParams {
  targetKind: 'file' | 'dir';
  left: SnapshotEndpointInput;
  right: SnapshotEndpointInput;
}

/** 用户勾选顺序不影响比较方向：按 revision 数值把较小者作为左/旧端。 */
export function orderSnapshotEndpoints(
  a: SnapshotEndpointInput,
  b: SnapshotEndpointInput,
): { left: SnapshotEndpointInput; right: SnapshotEndpointInput } {
  return a.revision <= b.revision ? { left: a, right: b } : { left: b, right: a };
}

const ITEM_RANK: Record<string, number> = {
  deleted: 0,
  modified: 1,
  none: 2,
  added: 3,
};

/** 候选稳定排序：相对路径 → item 序（deleted 在 added 前）→ kind → URL。 */
function sortCandidates(candidates: SnapshotDiffCandidate[]): SnapshotDiffCandidate[] {
  return candidates.sort((a, b) => {
    if (a.relativePath !== b.relativePath) {
      return a.relativePath < b.relativePath ? -1 : 1;
    }
    const rankA = ITEM_RANK[a.item] ?? 4;
    const rankB = ITEM_RANK[b.item] ?? 4;
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    if (a.kind !== b.kind) {
      return a.kind < b.kind ? -1 : 1;
    }
    const keyA = `${a.leftUrl ?? ''}|${a.rightUrl ?? ''}`;
    const keyB = `${b.leftUrl ?? ''}|${b.rightUrl ?? ''}`;
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
}

function summarizeCandidates(
  entries: SummarizeEntry[],
  leftRoot: string,
  rightRoot: string,
  leftRevision: number,
  rightRevision: number,
): SnapshotDiffCandidate[] {
  const candidates: SnapshotDiffCandidate[] = [];
  for (const entry of entries) {
    const relativePath = relativePathUnderRoot(leftRoot, entry.path);
    if (relativePath === undefined) {
      // 证据不支持「旧根 + 相对路径」映射时不做猜测，避免把来源路径虚增到新目录。
      throw new SvnError({
        message: `summarize 输出路径不以 --old 根为基准，无法建立相对路径映射：${entry.path}`,
        command: ['diff', '--xml', '--summarize'],
        code: 'SUMMARIZE_MAPPING',
      });
    }
    const leftPresent = entry.item !== 'added';
    const rightPresent = entry.item !== 'deleted';
    candidates.push({
      relativePath,
      item: entry.item,
      props: entry.props,
      kind: entry.kind,
      leftPresent,
      rightPresent,
      leftUrl: leftPresent ? joinSnapshotUrl(leftRoot, relativePath) : undefined,
      rightUrl: rightPresent ? joinSnapshotUrl(rightRoot, relativePath) : undefined,
      leftRevision: leftPresent ? leftRevision : undefined,
      rightRevision: rightPresent ? rightRevision : undefined,
    });
  }
  return sortCandidates(candidates);
}

function endpointCandidate(node: RepoNodeRef, side: 'left' | 'right'): SnapshotDiffCandidate {
  return {
    relativePath: '',
    item: side === 'left' ? 'deleted' : 'added',
    props: 'none',
    kind: node.kind,
    leftPresent: side === 'left',
    rightPresent: side === 'right',
    leftUrl: side === 'left' ? node.rawUrl : undefined,
    rightUrl: side === 'right' ? node.rawUrl : undefined,
    leftRevision: side === 'left' ? node.snapshotRevision : undefined,
    rightRevision: side === 'right' ? node.snapshotRevision : undefined,
  };
}

function listCandidates(
  entries: SnapshotListEntry[],
  side: 'left' | 'right',
  rootUrl: string,
  revision: number,
): SnapshotDiffCandidate[] {
  return sortCandidates(entries.map((entry) => ({
    relativePath: entry.relativePath,
    item: side === 'left' ? 'deleted' : 'added',
    props: 'none',
    kind: entry.kind,
    leftPresent: side === 'left',
    rightPresent: side === 'right',
    leftUrl: side === 'left' ? joinSnapshotUrl(rootUrl, entry.relativePath) : undefined,
    rightUrl: side === 'right' ? joinSnapshotUrl(rootUrl, entry.relativePath) : undefined,
    leftRevision: side === 'left' ? revision : undefined,
    rightRevision: side === 'right' ? revision : undefined,
  })));
}

async function resolveEndpoint(
  svnPath: string,
  input: SnapshotEndpointInput,
  options: RunOptions,
): Promise<SnapshotNodeState> {
  if (input.resolved) {
    return input.resolved;
  }
  return resolveSnapshotNode(
    svnPath,
    { url: input.url, revision: input.revision, deletionRevision: input.deletionRevision },
    options,
  );
}

/**
 * 目录目标比较：先分别解析左右 revision 的目标目录根；两端都存在时以
 * 实际根调 summarize（输出路径按 --old 根映射到右根）；单端不存在
 * （已删除或从未存在）时改用 list 流式枚举存在端，生成整树新增/删除；
 * 两端都不可读时无差异。父目录比较只取两端实际快照差异，不取提交
 * 记录路径并集。入口内部按 revision 数值定左右（用户勾选顺序无影响）。
 */
export async function compareDirectorySnapshots(
  svnPath: string,
  params: CompareSnapshotsParams,
  options: RunOptions = {},
  budget?: Partial<SnapshotParseBudget>,
): Promise<SnapshotCompareResult> {
  const ordered = orderSnapshotEndpoints(params.left, params.right);
  const left = await resolveEndpoint(svnPath, ordered.left, options);
  const right = await resolveEndpoint(svnPath, ordered.right, options);
  const leftPresent = left.state === 'present';
  const rightPresent = right.state === 'present';

  if (!leftPresent && !rightPresent) {
    return { state: 'ready', left, right, source: 'none', candidates: [] };
  }
  if (!leftPresent) {
    const node = (right as { state: 'present'; node: RepoNodeRef }).node;
    const enumeration = await enumerateSnapshot(
      svnPath,
      { url: node.rawUrl, revision: node.snapshotRevision },
      options,
      budget,
    );
    if (enumeration.state === 'tooLarge') {
      return { state: 'tooLarge', limit: enumeration.limit, left, right, source: 'list-right' };
    }
    if (enumeration.state === 'notFound') {
      throw new SvnError({
        message: `目录枚举失败：节点在 revision ${node.snapshotRevision} 报告存在但 list 找不到`,
        command: ['list', '--xml'],
        code: 'ENUMERATION_NOT_FOUND',
      });
    }
    return {
      state: 'ready',
      left,
      right,
      source: 'list-right',
      candidates: listCandidates(enumeration.entries, 'right', node.rawUrl, node.snapshotRevision),
    };
  }
  if (!rightPresent) {
    const node = (left as { state: 'present'; node: RepoNodeRef }).node;
    const enumeration = await enumerateSnapshot(
      svnPath,
      { url: node.rawUrl, revision: node.snapshotRevision },
      options,
      budget,
    );
    if (enumeration.state === 'tooLarge') {
      return { state: 'tooLarge', limit: enumeration.limit, left, right, source: 'list-left' };
    }
    if (enumeration.state === 'notFound') {
      throw new SvnError({
        message: `目录枚举失败：节点在 revision ${node.snapshotRevision} 报告存在但 list 找不到`,
        command: ['list', '--xml'],
        code: 'ENUMERATION_NOT_FOUND',
      });
    }
    return {
      state: 'ready',
      left,
      right,
      source: 'list-left',
      candidates: listCandidates(enumeration.entries, 'left', node.rawUrl, node.snapshotRevision),
    };
  }

  const leftNode = (left as { state: 'present'; node: RepoNodeRef }).node;
  const rightNode = (right as { state: 'present'; node: RepoNodeRef }).node;
  const summary = await summarizeSnapshots(
    svnPath,
    {
      oldUrl: leftNode.rawUrl,
      oldRevision: leftNode.snapshotRevision,
      newUrl: rightNode.rawUrl,
      newRevision: rightNode.snapshotRevision,
    },
    options,
    budget,
  );
  if (summary.state === 'tooLarge') {
    return { state: 'tooLarge', limit: summary.limit, left, right, source: 'summarize' };
  }
  if (summary.state === 'notFound') {
    // 两端 info 都报告存在却 E160013：证据自相矛盾，不做猜测（不能把半输出
    // 或缺端当完整差异），交由调用方按错误呈现。
    throw new SvnError({
      message: 'svn diff --summarize 报告目标不存在，但两端 info 均解析为存在；不展示部分候选',
      command: ['diff', '--xml', '--summarize'],
      code: 'SUMMARIZE_NOT_FOUND',
    });
  }
  return {
    state: 'ready',
    left,
    right,
    source: 'summarize',
    candidates: summarizeCandidates(
      summary.entries,
      leftNode.rawUrl,
      rightNode.rawUrl,
      leftNode.snapshotRevision,
      rightNode.snapshotRevision,
    ),
  };
}

/**
 * 文件目标比较：两端都存在时以实际节点 URL 调 summarize；单端为
 * absent(deleted)/notFoundAtRevision 时直接生成新增/删除候选与空内容端
 * （不把 info 的「不存在」误写成未知网络错误），也不调用 summarize。
 * 内容是否相同由内容层读取；仅属性变化时 summarize 的 item 为 none。
 * 入口内部按 revision 数值定左右（用户勾选顺序无影响）。
 */
export async function compareFileSnapshots(
  svnPath: string,
  params: CompareSnapshotsParams,
  options: RunOptions = {},
  budget?: Partial<SnapshotParseBudget>,
): Promise<SnapshotCompareResult> {
  const ordered = orderSnapshotEndpoints(params.left, params.right);
  const left = await resolveEndpoint(svnPath, ordered.left, options);
  const right = await resolveEndpoint(svnPath, ordered.right, options);
  const leftPresent = left.state === 'present';
  const rightPresent = right.state === 'present';

  if (!leftPresent && !rightPresent) {
    return { state: 'ready', left, right, source: 'none', candidates: [] };
  }
  if (!leftPresent || !rightPresent) {
    const node = (leftPresent
      ? (left as { state: 'present'; node: RepoNodeRef }).node
      : (right as { state: 'present'; node: RepoNodeRef }).node);
    return {
      state: 'ready',
      left,
      right,
      source: 'endpoint',
      candidates: [endpointCandidate(node, leftPresent ? 'left' : 'right')],
    };
  }

  const leftNode = (left as { state: 'present'; node: RepoNodeRef }).node;
  const rightNode = (right as { state: 'present'; node: RepoNodeRef }).node;
  const summary = await summarizeSnapshots(
    svnPath,
    {
      oldUrl: leftNode.rawUrl,
      oldRevision: leftNode.snapshotRevision,
      newUrl: rightNode.rawUrl,
      newRevision: rightNode.snapshotRevision,
    },
    options,
    budget,
  );
  if (summary.state === 'tooLarge') {
    return { state: 'tooLarge', limit: summary.limit, left, right, source: 'summarize' };
  }
  if (summary.state === 'notFound') {
    throw new SvnError({
      message: 'svn diff --summarize 报告目标不存在，但两端 info 均解析为存在；不展示部分候选',
      command: ['diff', '--xml', '--summarize'],
      code: 'SUMMARIZE_NOT_FOUND',
    });
  }
  return {
    state: 'ready',
    left,
    right,
    source: 'summarize',
    candidates: summarizeCandidates(
      summary.entries,
      leftNode.rawUrl,
      rightNode.rawUrl,
      leftNode.snapshotRevision,
      rightNode.snapshotRevision,
    ),
  };
}

/** 按目标类型分派文件/目录比较。 */
export async function compareSnapshots(
  svnPath: string,
  params: CompareSnapshotsParams,
  options: RunOptions = {},
  budget?: Partial<SnapshotParseBudget>,
): Promise<SnapshotCompareResult> {
  return params.targetKind === 'dir'
    ? compareDirectorySnapshots(svnPath, params, options, budget)
    : compareFileSnapshots(svnPath, params, options, budget);
}

/** 候选的差异大类（内容层的二进制判定不在此处断言）。 */
export type SnapshotDiffType = 'added' | 'deleted' | 'property' | 'content' | 'same';

/**
 * 由 summarize 结果与「两端内容是否相同」判定差异大类：
 * - item=added/deleted 直接对应新增/删除；
 * - item=none + props=modified 或内容相同仅属性变化 → property（绝不伪造
 *   文本差异）；
 * - 其余 modified（或内容差异 + 属性差异）→ content。
 * 内容是否可作文本比较仍由 remoteContent 的 mime/NUL 探测决定。
 */
export function candidateDiffType(
  candidate: SnapshotDiffCandidate,
  contentsEqual = false,
): SnapshotDiffType {
  if (candidate.item === 'added') {
    return 'added';
  }
  if (candidate.item === 'deleted') {
    return 'deleted';
  }
  if (candidate.item === 'none' && candidate.props === 'modified') {
    return 'property';
  }
  if (contentsEqual && candidate.props === 'modified') {
    return 'property';
  }
  if (candidate.item === 'modified' || candidate.props === 'modified') {
    return 'content';
  }
  return 'same';
}
