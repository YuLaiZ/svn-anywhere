/**
 * P5 远端只读内容（M4 阶段 2 的宿主内容部分）：
 * - 注册带仓库身份/revision 的 TextDocumentContentProvider（自定义 scheme），
 *   只读文本 ≤16 MiB 内嵌；URI 含仓库 UUID、原始 URL、revision 与一次性
 *   内容键，不回写工作副本、不产生工作副本文件；
 * - 二进制与超过内嵌上限的文本经 core/remoteContent 的 runToFile 真流式
 *   写入受管临时目录，再交系统默认应用打开；2 GiB 与磁盘余量不足的降级
 *   状态原样返回给调用方（不启动 cat 或及时终止，不留半文件）；
 * - 复用 host/diffView.ts 的「关闭即释放」模式：provider 文档关闭时删除
 *   对应内存内容；外部应用临时资源按进程归属与 mtime 过期回收（宿主停用
 *   清理本进程创建的资源，跨进程残留按 24 小时过期兜底）。
 *
 * 只读保障：provider 只提供内容，不注册 FileSystemProvider、不提供写盘
 * 通道；文档不能被保存回任何位置（provider 文档的编辑只停留在内存模型，
 * 已知边界，由 UI 与命令入口约束）。
 *
 * 内容分类沿用 core/remoteContent：先读 `svn:mime-type`（缺失视为无
 * mime），再读前 8 KiB 判 NUL；MIME 非 `text/*` 或含 NUL 即二进制。
 * 文本候选打开前再探测 `svn:special`：符号链接的 cat 内容是
 * `link <target>` 原文（无 mime、无 NUL），命中时返回显式 special 状态，
 * 不把链接原文送进内嵌文本预览。
 * 每次内容读取都经 core 原语的 `--non-interactive` 与 authScope /
 * credentialProvider 链（RunOptions 由调用方传入）。
 */
import * as vscode from 'vscode';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserError, RepoNodeRef } from '../core/remoteBrowse';
import {
  downloadRemoteFile,
  planRemoteContentOpen,
  probeRemoteContent,
  readRemoteText,
  REMOTE_INLINE_TEXT_MAX_BYTES,
  REMOTE_TEMP_FILE_MAX_BYTES,
} from '../core/remoteContent';
import type { RunOptions } from '../core/svnCli';
import { format, strings } from './i18n';
import { logLine } from './output';
import { probeSnapshotSpecial } from './panel/snapshotModel';

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

/** 只读远端文本文档的自定义 scheme。 */
export const REMOTE_DOCUMENT_SCHEME = 'svn-anywhere-remote';

/** 受管临时资源根目录名（系统临时目录下）。 */
export const REMOTE_RESOURCE_DIR_NAME = 'svn-anywhere-remote';

/** 外部应用临时资源的过期兜底：24 小时（停用清理之外的跨进程回收）。 */
export const REMOTE_RESOURCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 内容键缓存：文档关闭即删除对应条目（diffView 的关闭释放模式）。 */
interface RemoteDocumentContent {
  text: string;
  bytes: number;
  encoding: string;
  fellBack: boolean;
  lenient: boolean;
}

const documentContents = new Map<string, RemoteDocumentContent>();

// ---------------------------------------------------------------------------
// 文档 URI（仓库身份 + revision + 一次性内容键）
// ---------------------------------------------------------------------------

export interface RemoteDocumentTarget {
  repositoryUuid: string;
  /** 原始编码节点 URL。 */
  rawUrl: string;
  revision: number;
}

export interface ParsedRemoteDocumentUri {
  repositoryUuid: string;
  rawUrl: string;
  revision: number;
  contentKey: string;
}

/** 宽容解码：非法百分号序列原样保留（不猜编码）。 */
function decodeLoose(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 构造只读文档 URI：path 依次为仓库 UUID、revision、一次性内容键与
 * 条目展示名（末段供编辑器标签标题），query 携带原始 URL。
 * 内容键是身份主键；名称段的编码形态不影响 provider 取内容。
 */
export function buildRemoteDocumentUri(
  target: RemoteDocumentTarget,
  name: string,
  contentKey: string,
): vscode.Uri {
  const path = `/${target.repositoryUuid}/${target.revision}/${contentKey}/${name}`;
  const query = `url=${encodeURIComponent(target.rawUrl)}`;
  if (typeof vscode.Uri.from === 'function') {
    return vscode.Uri.from({ scheme: REMOTE_DOCUMENT_SCHEME, path, query });
  }
  // fake 宿主（无 Uri.from）的兜底：parse 后 path 形态不同也不影响身份。
  return vscode.Uri.parse(`${REMOTE_DOCUMENT_SCHEME}:${path}?${query}`);
}

/** 解析只读文档 URI；非本 scheme 或形状不符返回 undefined。 */
export function parseRemoteDocumentUri(uri: vscode.Uri): ParsedRemoteDocumentUri | undefined {
  if (uri.scheme !== REMOTE_DOCUMENT_SCHEME) {
    return undefined;
  }
  const segments = uri.path.split('/');
  // 期望 ['', uuid, revision, contentKey, ...name]
  if (segments.length < 5 || segments[0] !== '') {
    return undefined;
  }
  if (!/^\d+$/.test(segments[2])) {
    return undefined;
  }
  const revision = Number(segments[2]);
  if (!Number.isSafeInteger(revision)) {
    return undefined;
  }
  const query = uri.query ?? '';
  const urlMatch = /(?:^|&)url=([^&]*)/.exec(query);
  if (urlMatch === null) {
    return undefined;
  }
  return {
    repositoryUuid: decodeLoose(segments[1]),
    rawUrl: decodeLoose(urlMatch[1]),
    revision,
    contentKey: decodeLoose(segments[3]),
  };
}

// ---------------------------------------------------------------------------
// TextDocumentContentProvider
// ---------------------------------------------------------------------------

class RemoteDocumentContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    const parsed = parseRemoteDocumentUri(uri);
    if (parsed === undefined) {
      return strings.browse.documentInvalid;
    }
    const content = documentContents.get(parsed.contentKey);
    if (content === undefined) {
      return strings.browse.documentReleased;
    }
    return content.text;
  }
}

/** provider 注册句柄与文档关闭监听（二次 activate 时先释放旧句柄）。 */
let providerRegistration: vscode.Disposable | undefined;
let closeWatch: vscode.Disposable | undefined;

/** 文档关闭即释放对应内存内容（关闭后重开显示「内容已释放」提示）。 */
function releaseDocumentContent(uri: vscode.Uri): void {
  if (uri.scheme !== REMOTE_DOCUMENT_SCHEME) {
    return;
  }
  const parsed = parseRemoteDocumentUri(uri);
  if (parsed !== undefined) {
    documentContents.delete(parsed.contentKey);
  }
}

/**
 * 激活接线：注册只读 provider 与文档关闭监听，并在后台回收过期临时资源。
 * fake 宿主（自动化环境）缺少 workspace API 时跳过注册而非中断激活；
 * 回收失败只降级为日志一行。
 */
export function initializeRemoteContent(context: vscode.ExtensionContext): void {
  try {
    if (typeof vscode.workspace.registerTextDocumentContentProvider === 'function') {
      providerRegistration?.dispose();
      providerRegistration = vscode.workspace.registerTextDocumentContentProvider(
        REMOTE_DOCUMENT_SCHEME,
        new RemoteDocumentContentProvider(),
      );
      context.subscriptions.push(providerRegistration);
    }
    if (typeof vscode.workspace.onDidCloseTextDocument === 'function') {
      closeWatch?.dispose();
      closeWatch = vscode.workspace.onDidCloseTextDocument((document) => releaseDocumentContent(document.uri));
      context.subscriptions.push(closeWatch);
    }
  } catch (err) {
    logLine(format(strings.browse.initFailed, {
      message: err instanceof Error ? err.message : String(err),
    }), 'browse');
    return;
  }
  try {
    cleanupExpiredRemoteResources();
  } catch {
    // 过期回收失败只是晚一次清理，不影响激活。
  }
}

// ---------------------------------------------------------------------------
// 受管临时资源（外部应用打开）
// ---------------------------------------------------------------------------

function remoteResourceRootDir(): string {
  return join(tmpdir(), REMOTE_RESOURCE_DIR_NAME);
}

/** 每个资源一个子目录，目录名带进程号：停用清理只处理本进程创建的目录。 */
function createRemoteResourceDir(): string {
  const root = remoteResourceRootDir();
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, `${process.pid}-`));
}

function removeRemoteResourceDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 回收失败不影响本次打开结果；过期清理兜底。
  }
}

/**
 * 过期回收：删除受管根下 mtime 早于 maxAgeMs 的资源目录。
 * 用目录时间而非内存表，跨进程重启后的残留同样能回收。
 */
export function cleanupExpiredRemoteResources(
  maxAgeMs: number = REMOTE_RESOURCE_MAX_AGE_MS,
  now: number = Date.now(),
  rootDir: string = remoteResourceRootDir(),
): number {
  let names: string[];
  try {
    names = readdirSync(rootDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const dir = join(rootDir, name);
    try {
      const stat = statSync(dir);
      if (!stat.isDirectory()) {
        continue;
      }
      if (now - stat.mtimeMs > maxAgeMs) {
        rmSync(dir, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // 并发清理或不可访问：跳过。
    }
  }
  return removed;
}

/** 停用清理：删除本进程创建的全部外部资源目录。 */
function removeOwnedRemoteResources(rootDir: string = remoteResourceRootDir()): void {
  let names: string[];
  try {
    names = readdirSync(rootDir);
  } catch {
    return;
  }
  const prefix = `${process.pid}-`;
  for (const name of names) {
    if (name.startsWith(prefix)) {
      removeRemoteResourceDir(join(rootDir, name));
    }
  }
}

/** 停用接线：清空内容缓存、释放 provider/监听并删除本进程的临时资源。 */
export function disposeRemoteContent(): void {
  documentContents.clear();
  providerRegistration?.dispose();
  providerRegistration = undefined;
  closeWatch?.dispose();
  closeWatch = undefined;
  removeOwnedRemoteResources();
}

/** 测试辅助：重置缓存与注册状态，并删除受管根目录的全部残留。 */
export function resetRemoteContentForTest(): void {
  documentContents.clear();
  providerRegistration?.dispose();
  providerRegistration = undefined;
  closeWatch?.dispose();
  closeWatch = undefined;
  removeOwnedRemoteResources();
}

// ---------------------------------------------------------------------------
// 打开远端内容
// ---------------------------------------------------------------------------

export interface OpenRemoteContentOptions extends RunOptions {
  /** 读取 revision；缺省用节点的 snapshotRevision（P5 浏览快照）。 */
  revision?: number;
  /** 已知文件大小（info entry@size / list size），用于 16 MiB / 2 GiB 预判。 */
  sizeBytes?: number;
  /** 内嵌文本上限覆盖（默认 16 MiB；测试用更小值等价验证降级路径）。 */
  inlineTextMaxBytes?: number;
}

export type RemoteContentOpenOutcome =
  | {
      status: 'openedText';
      uri: vscode.Uri;
      bytes: number;
      encoding: string;
      fellBack: boolean;
      lenient: boolean;
    }
  | {
      status: 'openedExternal';
      filePath: string;
      bytesWritten: number;
      reason: 'binary' | 'textTooLarge';
    }
  /** 已下载到临时文件但系统默认应用拒绝打开（文件保留供手动打开）。 */
  | { status: 'externalOpenFailed'; filePath: string; bytesWritten: number }
  /**
   * svn:special 符号链接：不进入内嵌文本预览（cat 输出为 `link <target>`
   * 原文）；调用方按此状态给出提示，可导出或外部打开。
   */
  | { status: 'special' }
  | { status: 'tooLarge'; sizeBytes: number; limitBytes: number }
  | { status: 'insufficientDisk'; message: string }
  | { status: 'notFound'; error: BrowserError }
  | { status: 'error'; error: BrowserError };

/** 节点展示名：仓库相对路径最后一段（逐段解码后的原始名称）。 */
function displayNameOfNode(node: RepoNodeRef): string {
  const name = node.relativePath.split('/').filter((segment) => segment !== '').pop();
  return name !== undefined && name !== '' ? name : 'file';
}

/** 临时文件名：从 URL 最后一段宽容解码并剥除路径分隔符/控制字符。 */
function safeTempFileName(rawUrl: string): string {
  const last = rawUrl.split('/').filter((segment) => segment !== '').pop() ?? '';
  let name = decodeLoose(last);
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, '_').trim();
  if (name === '' || name === '.' || name === '..') {
    return 'remote-file';
  }
  return name;
}

/** 系统默认应用打开本地文件；fake/受限宿主返回 false 由调用方降级。 */
async function openExternalFile(filePath: string): Promise<boolean> {
  const env = vscode.env;
  if (env === undefined || typeof env.openExternal !== 'function') {
    return false;
  }
  return vscode.env.openExternal(vscode.Uri.file(filePath));
}

/**
 * 下载到受管临时目录并交系统默认应用打开；失败路径删除刚建的空目录
 * （runToFile 自身已删除 `.part` 半文件，不留残片）。
 */
async function downloadAndOpenExternal(
  svnPath: string,
  node: RepoNodeRef,
  revision: number,
  runOptions: RunOptions,
  sizeBytes: number | undefined,
  reason: 'binary' | 'textTooLarge',
): Promise<RemoteContentOpenOutcome> {
  const dir = createRemoteResourceDir();
  const targetPath = join(dir, safeTempFileName(node.rawUrl));
  const result = await downloadRemoteFile(svnPath, node.rawUrl, {
    ...runOptions,
    revision,
    targetPath,
    ...(sizeBytes !== undefined ? { expectedBytes: sizeBytes } : {}),
  });
  switch (result.status) {
    case 'downloaded': {
      logLine(format(strings.browse.openExternalLog, {
        url: node.rawUrl,
        revision: String(revision),
        path: result.filePath,
        bytes: String(result.bytesWritten),
      }), 'browse');
      const opened = await openExternalFile(result.filePath);
      if (!opened) {
        return {
          status: 'externalOpenFailed',
          filePath: result.filePath,
          bytesWritten: result.bytesWritten,
        };
      }
      return {
        status: 'openedExternal',
        filePath: result.filePath,
        bytesWritten: result.bytesWritten,
        reason,
      };
    }
    case 'tooLarge': {
      removeRemoteResourceDir(dir);
      return {
        status: 'tooLarge',
        sizeBytes: result.expectedBytes ?? sizeBytes ?? result.limitBytes,
        limitBytes: result.limitBytes,
      };
    }
    case 'insufficientDisk':
      removeRemoteResourceDir(dir);
      return { status: 'insufficientDisk', message: result.message };
    case 'notFound':
      removeRemoteResourceDir(dir);
      return { status: 'notFound', error: result.error };
    default:
      removeRemoteResourceDir(dir);
      return { status: 'error', error: result.error };
  }
}

/**
 * 打开远端文件内容（P5 节点只读打开的唯一宿主入口）。
 *
 * 决策顺序：
 * 1. `svn:mime-type` + 前 8 KiB NUL 探测分类；
 * 2. 已知大小 > 2 GiB → tooLarge（不启动 cat）；
 * 3. 二进制（任意大小）→ runToFile 临时资源 + 系统默认应用；
 * 4. 文本候选 → 探测 `svn:special`：符号链接返回显式 special 状态，
 *    不进入内嵌文本预览；
 * 5. 文本大小未知或 ≤16 MiB → 流式读取（16 MiB 上限兜底）后经只读
 *    provider 打开；
 * 6. 文本实际超过内嵌上限（大小未知情形）→ 降级为临时资源外部打开，
 *    reason='textTooLarge'（页面文案「文件过大，未使用内置文本预览」由
 *    P5 控制器按该状态展示）。
 *
 * 未显式提供 timeoutMs 时 cat 类调用不限时（大文件传输是长任务，取消由
 * signal 承担）；显式值原样尊重。
 */
export async function openRemoteContent(
  svnPath: string,
  node: RepoNodeRef,
  options: OpenRemoteContentOptions = {},
): Promise<RemoteContentOpenOutcome> {
  const { revision: revisionOption, sizeBytes, inlineTextMaxBytes, ...rest } = options;
  const revision = revisionOption ?? node.snapshotRevision;
  const runOptions: RunOptions = { ...rest };
  if (runOptions.timeoutMs === undefined) {
    // svn cat 读大文件不设默认 120 秒超时；调用方可显式覆盖。
    runOptions.timeoutMs = 0;
  }
  // 已知大小先做 2 GiB 预算：无论文本/二进制都无法交付，直接降级，
  // 不启动任何 cat（连 8 KiB 探测都不做）。
  if (sizeBytes !== undefined && sizeBytes > REMOTE_TEMP_FILE_MAX_BYTES) {
    return { status: 'tooLarge', sizeBytes, limitBytes: REMOTE_TEMP_FILE_MAX_BYTES };
  }

  const probe = await probeRemoteContent(svnPath, node.rawUrl, { ...runOptions, revision });
  if (probe.status === 'notFound') {
    return { status: 'notFound', error: probe.error };
  }
  if (probe.status === 'error') {
    return { status: 'error', error: probe.error };
  }

  const plan = planRemoteContentOpen({ kind: probe.classification.kind, sizeBytes });
  if (plan.mode === 'tooLarge') {
    return { status: 'tooLarge', sizeBytes: plan.sizeBytes, limitBytes: plan.limitBytes };
  }
  if (plan.mode === 'externalTempFile') {
    return downloadAndOpenExternal(svnPath, node, revision, runOptions, sizeBytes, plan.reason);
  }

  // 文本候选先探测 svn:special：符号链接的 cat 输出是 `link <target>`
  // 原文，MIME/NUL 分类会误判为普通文本；命中时不进入内嵌文本预览。
  if (await probeSnapshotSpecial(svnPath, node.rawUrl, revision, runOptions)) {
    return { status: 'special' };
  }

  const text = await readRemoteText(svnPath, node.rawUrl, {
    ...runOptions,
    revision,
    ...(inlineTextMaxBytes !== undefined ? { maxBytes: inlineTextMaxBytes } : {}),
  });
  if (text.status === 'notFound') {
    return { status: 'notFound', error: text.error };
  }
  if (text.status === 'error') {
    return { status: 'error', error: text.error };
  }
  if (text.status === 'tooLarge') {
    // 大小未知而实际超过内嵌上限：降级为临时资源交系统应用，不把半读
    // 文本冒充完整内容，也不把超大文本塞进内置编辑器。
    return downloadAndOpenExternal(svnPath, node, revision, runOptions, sizeBytes, 'textTooLarge');
  }

  const contentKey = randomBytes(12).toString('hex');
  documentContents.set(contentKey, {
    text: text.text,
    bytes: text.bytes,
    encoding: text.encoding,
    fellBack: text.fellBack,
    lenient: text.lenient,
  });
  const uri = buildRemoteDocumentUri(
    { repositoryUuid: node.repositoryUuid, rawUrl: node.rawUrl, revision },
    displayNameOfNode(node),
    contentKey,
  );
  try {
    await vscode.window.showTextDocument(uri, { preview: false, preserveFocus: false });
  } catch (err) {
    // 文档从未打开时 onDidCloseTextDocument 不会触发：必须立即回收内容键，
    // 否则每次失败都滞留一份 ≤16 MiB 文本直到停用/进程退出。
    documentContents.delete(contentKey);
    const message = err instanceof Error ? err.message : String(err);
    logLine(format(strings.error.failed, { message }), 'browse');
    return {
      status: 'error',
      error: { kind: 'unknown', message: `Cannot open read-only document: ${message}`, codes: [] },
    };
  }
  logLine(format(strings.browse.openTextLog, {
    url: node.rawUrl,
    revision: String(revision),
    bytes: String(text.bytes),
    encoding: text.encoding,
  }), 'browse');
  return {
    status: 'openedText',
    uri,
    bytes: text.bytes,
    encoding: text.encoding,
    fellBack: text.fellBack,
    lenient: text.lenient,
  };
}

/** 参考上限（供 P5 控制器展示「文件过大」阈值时复用，不重复定义常量）。 */
export const REMOTE_TEXT_INLINE_LIMIT_BYTES = REMOTE_INLINE_TEXT_MAX_BYTES;
