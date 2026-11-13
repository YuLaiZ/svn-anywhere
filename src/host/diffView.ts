/**
 * 单文件差异的宿主打开逻辑：按条目状态决定差异两端与展示方式，
 * 用 vscode.diff 并排打开；临时资源随差异编辑器引用释放。
 *
 * 能力口径（技术方案 §6 / 交互清单）：
 * - 普通修改：BASE → 工作文件；
 * - 新增：无 BASE 时空内容 → 当前文件；带历史复制的新增先识别来源，
 *   BASE 端即复制来源内容（svn cat -r BASE 对 copied 节点返回来源），
 *   标题注明复制来源；
 * - 删除：BASE → 空内容；missing 本地缺失，明示不可比较（登记删除后可看）；
 * - 纯属性修改：属性差异独立展示（svn diff --properties 写输出频道），
 *   不用内容相同的文本 diff 假装没有变化；
 * - 二进制：明示能力并给打开文件入口，不做文本差异；
 * - 未版本控制：差异按钮禁用，走「打开文件」。
 *
 * M4 阶段 3 扩展（P6 快照比较）：
 * - openSnapshotTextDiff：两个历史 revision 的快照内容经只读 provider
 *   打开原生 vscode.diff；URI 携带 revision 与一次性内容键，文档关闭即
 *   释放（与临时资源的关闭释放同一监听）；单端不存在用空内容文档（阶段 0
 *   V3-5：不能传不存在的 file URI）；二进制与 svn:special 不进入文本差异；
 * - promptSnapshotExport：原生保存对话框 + 覆盖确认 + 原子替换写盘入口；
 * - openSnapshotBaseCompareEntry：目录 BASE 比较逐项复用单文件 BASE diff。
 */
import * as vscode from 'vscode';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { looksBinary, parseCopiedFrom, readBaseContent, readInfoText, removeDiffTempDir } from '../core/diff';
import type { BrowserError, RepoNodeRef } from '../core/remoteBrowse';
import { probeRemoteContent, readRemoteText, REMOTE_INLINE_TEXT_MAX_BYTES } from '../core/remoteContent';
import { runOrThrow, type RunOptions } from '../core/svnCli';
import {
  probeSnapshotSpecial,
  snapshotText,
  writeSnapshotExport,
  type SnapshotBaseCompareEntry,
  type SnapshotExportPlan,
} from './panel/snapshotModel';
import { openRemoteContent, type RemoteContentOpenOutcome } from './readonlyContent';
import { readTimeoutMs } from './config';
import { format, strings } from './i18n';
import { decodingRunOptions, logCommand, logLine, showOutput } from './output';

export interface DiffTarget {
  svnPath: string;
  wcRoot: string;
  /** 相对副本根的原始路径（保留首尾空格；不能从展示文本反推）。 */
  relPath: string;
  wcStatus: string;
  props?: string;
  kind?: string;
}

export type DiffOutcome =
  | 'diffed'
  | 'addedNoBase'
  | 'deleted'
  | 'propertyDiffShown'
  | 'binaryNotified'
  | 'missingNotified'
  | 'unversionedNotified'
  | 'directoryNotified'
  | 'failed';

/** 临时文件 → 所在临时目录；一个目录的全部引用关闭后清理该目录。 */
const tempRefs = new Map<string, string>();

/** 关闭监听（首次打开差异时注册）。 */
let closeSubscription: vscode.Disposable | undefined;

/** 测试辅助：重置临时资源追踪与快照只读内容/注册。 */
export function resetDiffViewForTest(): void {
  for (const tempDir of new Set(tempRefs.values())) {
    removeDiffTempDir(tempDir);
  }
  tempRefs.clear();
  snapshotContents.clear();
  snapshotProvider?.dispose();
  snapshotProvider = undefined;
  closeSubscription?.dispose();
  closeSubscription = undefined;
}

/**
 * 打开/展示单个条目的差异；返回结果分类（供测试与能力提示使用）。
 * relPath 由宿主从条目映射，视图侧不传路径。
 */
export async function openEntryDiff(target: DiffTarget): Promise<DiffOutcome> {
  const { svnPath, wcRoot, relPath, wcStatus, props, kind } = target;

  if (wcStatus === 'unversioned') {
    return 'unversionedNotified';
  }
  if (wcStatus === 'missing') {
    // 本地端不存在：登记删除后才能比较 BASE → 空内容。
    return 'missingNotified';
  }
  if (kind === 'dir') {
    // 目录节点没有文本差异；纯属性目录走属性差异，其余明示无文本差异。
    if (props === 'modified') {
      return showPropertyDiff(svnPath, wcRoot, relPath);
    }
    return 'directoryNotified';
  }
  // 纯属性修改：item 为 normal 而 props 为 modified。
  if (wcStatus === 'normal' && props === 'modified') {
    return showPropertyDiff(svnPath, wcRoot, relPath);
  }

  const base = await readBaseContent(svnPath, wcRoot, relPath);
  if (!base.ok && base.reason === 'error') {
    logLine(format(strings.error.failed, { message: (base.stderr.split('\n')[0] ?? '').trim() }));
    return 'failed';
  }

  const deleted = wcStatus === 'deleted';
  const currentPath = join(wcRoot, relPath);

  // 二进制检测：本地端存在读本地端；删除项本地端已不存在，读 BASE 端。
  const probe = deleted
    ? (base.ok ? base.content.slice(0, 8192) : '')
    : safeReadHead(currentPath);
  if (looksBinary(probe)) {
    return 'binaryNotified';
  }

  // 左端（BASE / 空）：右端（工作文件 / 删除后的空内容）。
  const tempDir = mkdtempSync(join(tmpdir(), 'svn-anywhere-diff-'));
  const baseTempPath = join(tempDir, 'base');
  writeFileSync(baseTempPath, base.ok ? base.content : '', 'utf8');
  registerTempRef(tempDir, baseTempPath);

  const rightPath = deleted ? join(tempDir, 'empty') : currentPath;
  if (deleted) {
    writeFileSync(rightPath, '', 'utf8');
    registerTempRef(tempDir, rightPath);
  }

  const title = await diffTitle(svnPath, wcRoot, relPath, wcStatus);
  await openDiffEditor(vscode.Uri.file(baseTempPath), vscode.Uri.file(rightPath), title);
  if (deleted) {
    return 'deleted';
  }
  return base.ok ? 'diffed' : 'addedNoBase';
}

/** 差异标题：带历史复制的新增标注来源；普通修改/替换用 BASE → 工作副本。 */
async function diffTitle(svnPath: string, wcRoot: string, relPath: string, wcStatus: string): Promise<string> {
  if (wcStatus === 'added') {
    try {
      const copied = parseCopiedFrom(await readInfoText(svnPath, wcRoot, relPath));
      if (copied) {
        return format(strings.panel.copiedFromTitle, {
          path: relPath,
          source: copied.url,
          revision: String(copied.revision),
        });
      }
    } catch {
      // info 失败不阻塞差异：退回普通新增标题。
    }
    return format(strings.panel.addedDiffTitle, { path: relPath });
  }
  return format(strings.panel.diffTitle, { path: relPath });
}

async function openDiffEditor(left: vscode.Uri, right: vscode.Uri, title: string): Promise<void> {
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: false });
}

/** 纯属性差异：svn diff 原样写入输出频道并展示（实测 1.15 无 --properties 选项；纯属性条目的 diff 输出只含属性段）。 */
async function showPropertyDiff(svnPath: string, wcRoot: string, relPath: string): Promise<DiffOutcome> {
  const args = ['diff', '--', relPath];
  try {
    const result = await runOrThrow(svnPath, args, {
      cwd: wcRoot,
      timeoutMs: readTimeoutMs(),
      ...decodingRunOptions('other'),
      onExit: logCommand(svnPath, args, wcRoot),
    });
    logLine(format(strings.panel.propDiffHeader, { path: relPath }));
    logLine(result.stdout.trim() || strings.commit.diffClean);
    showOutput(false);
    return 'propertyDiffShown';
  } catch (err) {
    logLine(format(strings.error.failed, {
      message: (err instanceof Error ? err.message.split('\n')[0] ?? '' : String(err)),
    }));
    return 'failed';
  }
}

function safeReadHead(path: string): string {
  try {
    return readFileSync(path, 'utf8').slice(0, 8192);
  } catch {
    return '';
  }
}

/** 登记临时文件引用：引用它的差异编辑器一侧文档关闭时释放整个临时目录。 */
function registerTempRef(tempDir: string, tempPath: string): void {
  tempRefs.set(vscode.Uri.file(tempPath).toString(), tempDir);
  ensureCloseListener();
}

function ensureCloseListener(): void {
  if (closeSubscription) {
    return;
  }
  closeSubscription = vscode.workspace.onDidCloseTextDocument((doc) => {
    releaseClosedDocument(doc.uri);
  });
}

/**
 * 文档关闭释放（临时文件与快照只读内容共用）：
 * - 临时文件：同一目录的全部引用文档都已关闭时清理（diff 两侧各算一个引用）；
 * - 快照 provider 内容：按一次性内容键删除内存文本。
 */
function releaseClosedDocument(uri: vscode.Uri): void {
  const key = uri.toString();
  const tempDir = tempRefs.get(key);
  if (tempDir !== undefined) {
    const siblings = [...tempRefs.entries()].filter(([, dir]) => dir === tempDir);
    for (const [siblingKey] of siblings) {
      tempRefs.delete(siblingKey);
    }
    removeDiffTempDir(tempDir);
  }
  const parsed = parseSnapshotDocumentUri(uri);
  if (parsed !== undefined) {
    snapshotContents.delete(parsed.contentKey);
  }
}

/** 差异打开的用户可见提示（二进制/缺失等能力明示）。 */
export function diffOutcomeNotice(outcome: DiffOutcome, target: DiffTarget): string | undefined {
  switch (outcome) {
    case 'binaryNotified':
      return format(strings.panel.binaryNotice, { path: target.relPath });
    case 'missingNotified':
      return format(strings.panel.missingNotice, { path: target.relPath });
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// P6 快照文本差异：只读 provider + vscode.diff（M4 阶段 3 任务 4）
// ---------------------------------------------------------------------------

/** 快照只读文本文档的自定义 scheme（与 P5 远端内容分开：内容生命周期不同）。 */
export const SNAPSHOT_DOCUMENT_SCHEME = 'svn-anywhere-snapshot';

interface SnapshotDocumentContent {
  text: string;
  bytes: number;
}

/** 一次性内容键 → 文本；文档关闭即释放（与临时资源同一关闭监听）。 */
const snapshotContents = new Map<string, SnapshotDocumentContent>();

let snapshotProvider: vscode.Disposable | undefined;

function decodeLoose(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export interface SnapshotDocumentTarget {
  /** 实际节点 URL（原始编码）；单端不存在时用占位 URL。 */
  rawUrl: string;
  revision: number;
}

export interface ParsedSnapshotDocumentUri {
  rawUrl: string;
  revision: number;
  contentKey: string;
}

/**
 * 构造快照只读文档 URI：path 依次为 revision、一次性内容键与展示名
 * （末段供编辑器标签标题），query 携带原始 URL。**revision 是 URI 的
 * 固定组成部分**，同一内容键不会跨 revision 复用。
 */
export function buildSnapshotDocumentUri(
  target: SnapshotDocumentTarget,
  name: string,
  contentKey: string,
): vscode.Uri {
  const safeName = name.replace(/[\\/\u0000-\u001f\u007f]/g, '_');
  const path = `/${target.revision}/${contentKey}/${safeName}`;
  const query = `url=${encodeURIComponent(target.rawUrl)}`;
  if (typeof vscode.Uri.from === 'function') {
    return vscode.Uri.from({ scheme: SNAPSHOT_DOCUMENT_SCHEME, path, query });
  }
  return vscode.Uri.parse(`${SNAPSHOT_DOCUMENT_SCHEME}:${path}?${query}`);
}

/** 解析快照只读文档 URI；非本 scheme 或形状不符返回 undefined。 */
export function parseSnapshotDocumentUri(uri: vscode.Uri): ParsedSnapshotDocumentUri | undefined {
  if (uri.scheme !== SNAPSHOT_DOCUMENT_SCHEME) {
    return undefined;
  }
  const segments = uri.path.split('/');
  // 期望 ['', revision, contentKey, ...name]
  if (segments.length < 4 || segments[0] !== '') {
    return undefined;
  }
  if (!/^\d+$/.test(segments[1])) {
    return undefined;
  }
  const revision = Number(segments[1]);
  if (!Number.isSafeInteger(revision)) {
    return undefined;
  }
  const query = uri.query ?? '';
  const urlMatch = /(?:^|&)url=([^&]*)/.exec(query);
  if (urlMatch === null) {
    return undefined;
  }
  return {
    rawUrl: decodeLoose(urlMatch[1]),
    revision,
    contentKey: decodeLoose(segments[2]),
  };
}

class SnapshotDocumentContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    const parsed = parseSnapshotDocumentUri(uri);
    if (parsed === undefined) {
      return strings.browse.documentInvalid;
    }
    return snapshotContents.get(parsed.contentKey)?.text ?? strings.browse.documentReleased;
  }
}

/** 首次打开快照差异时注册 provider；fake 宿主缺 API 时跳过（测试只断言 URI）。 */
function ensureSnapshotProvider(): void {
  if (snapshotProvider !== undefined) {
    return;
  }
  if (typeof vscode.workspace.registerTextDocumentContentProvider !== 'function') {
    return;
  }
  snapshotProvider = vscode.workspace.registerTextDocumentContentProvider(
    SNAPSHOT_DOCUMENT_SCHEME,
    new SnapshotDocumentContentProvider(),
  );
}

/** 快照差异一端：present 端给实际 URL/revision；不存在端省略 rawUrl。 */
export interface SnapshotDiffSideInput {
  /** present 端的实际节点 URL（原始编码，复制场景为来源路径）。 */
  rawUrl?: string;
  /** 该端实际 revision（复制解析后可能与用户选择的 revision 不同）。 */
  revision: number;
  /** info/list 的已知大小（用于内嵌上限预判）。 */
  sizeBytes?: number;
  /** 编辑器标签展示名；缺省从 URL 末段取。 */
  displayName?: string;
}

export interface OpenSnapshotTextDiffParams {
  svnPath: string;
  /** 差异标题（宿主已本地化）。 */
  title: string;
  /** 左/旧端。 */
  left: SnapshotDiffSideInput;
  /** 右/新端。 */
  right: SnapshotDiffSideInput;
  runOptions?: RunOptions;
  /** 内嵌文本上限覆盖（默认 16 MiB；测试用更小值验证降级）。 */
  inlineTextMaxBytes?: number;
}

export type SnapshotTextDiffOutcome =
  | { status: 'opened'; leftUri: string; rightUri: string; leftBytes: number; rightBytes: number }
  | { status: 'binary'; side: 'left' | 'right' }
  | { status: 'special'; side: 'left' | 'right' }
  | { status: 'tooLarge'; side: 'left' | 'right'; limitBytes: number }
  | { status: 'notFound'; side: 'left' | 'right'; error: BrowserError }
  | { status: 'error'; side: 'left' | 'right'; error: BrowserError }
  | { status: 'failed'; message: string };

type SnapshotSideProbe =
  | { state: 'absent' }
  | { state: 'text' }
  | { state: 'binary' }
  | { state: 'special' }
  | { state: 'tooLarge'; limitBytes: number }
  | { state: 'notFound'; error: BrowserError }
  | { state: 'error'; error: BrowserError };

/** 探测一端的展示类型：不存在/文本/二进制/特殊/超限/错误。 */
async function probeSnapshotDiffSide(
  svnPath: string,
  side: SnapshotDiffSideInput,
  options: RunOptions,
  inlineTextMaxBytes: number,
): Promise<SnapshotSideProbe> {
  if (side.rawUrl === undefined) {
    return { state: 'absent' };
  }
  if (side.sizeBytes !== undefined && side.sizeBytes > inlineTextMaxBytes) {
    return { state: 'tooLarge', limitBytes: inlineTextMaxBytes };
  }
  const probe = await probeRemoteContent(svnPath, side.rawUrl, { ...options, revision: side.revision });
  if (probe.status === 'notFound') {
    return { state: 'notFound', error: probe.error };
  }
  if (probe.status === 'error') {
    return { state: 'error', error: probe.error };
  }
  if (probe.classification.kind === 'binary') {
    return { state: 'binary' };
  }
  if (await probeSnapshotSpecial(svnPath, side.rawUrl, side.revision, options)) {
    return { state: 'special' };
  }
  return { state: 'text' };
}

type SnapshotSideText =
  | { state: 'text'; text: string; bytes: number }
  | { state: 'tooLarge'; limitBytes: number }
  | { state: 'notFound'; error: BrowserError }
  | { state: 'error'; error: BrowserError };

async function readSnapshotDiffSideText(
  svnPath: string,
  side: SnapshotDiffSideInput,
  options: RunOptions,
  inlineTextMaxBytes: number,
): Promise<SnapshotSideText> {
  if (side.rawUrl === undefined) {
    // 单端不存在必须用空内容文档（阶段 0 V3-5：不存在的 file URI 渲染错误文本）。
    return { state: 'text', text: '', bytes: 0 };
  }
  const read = await readRemoteText(svnPath, side.rawUrl, {
    ...options,
    revision: side.revision,
    maxBytes: inlineTextMaxBytes,
  });
  switch (read.status) {
    case 'text':
      return { state: 'text', text: read.text, bytes: read.bytes };
    case 'tooLarge':
      return { state: 'tooLarge', limitBytes: read.limitBytes };
    case 'notFound':
      return { state: 'notFound', error: read.error };
    case 'error':
      return { state: 'error', error: read.error };
  }
}

function snapshotDisplayName(side: SnapshotDiffSideInput): string {
  if (side.displayName !== undefined && side.displayName !== '') {
    return side.displayName;
  }
  const last = (side.rawUrl ?? '').split('/').filter((segment) => segment !== '').pop();
  const decoded = last === undefined ? '' : decodeLoose(last);
  return decoded === '' ? '(absent)' : decoded;
}

/**
 * 打开两个历史 revision 快照的原生文本差异（任务 4）：
 * - 两端分别按 mime/NUL 探测与 svn:special 检查；任一端为二进制/特殊文件
 *   时返回状态，不打开文本差异（二进制只提供版本、导出或外部打开）；
 * - 单端不存在（absent/notFound）用空内容文档作为该端，不传不存在的
 *   file URI；
 * - 两端内容经只读 provider 暴露，URI 携带 revision；vscode.diff 关闭后
 *   文档关闭监听释放内存内容；
 * - 文本实际超过内嵌上限返回 tooLarge，不把半读文本冒充完整内容。
 */
export async function openSnapshotTextDiff(
  params: OpenSnapshotTextDiffParams,
): Promise<SnapshotTextDiffOutcome> {
  const { svnPath, left, right } = params;
  const inlineTextMaxBytes = params.inlineTextMaxBytes ?? REMOTE_INLINE_TEXT_MAX_BYTES;
  const runOptions: RunOptions = { ...(params.runOptions ?? {}) };
  if (runOptions.timeoutMs === undefined) {
    // cat 类长任务不设默认 120 秒超时；删除由 signal 承担。
    runOptions.timeoutMs = 0;
  }
  try {
    const leftProbe = await probeSnapshotDiffSide(svnPath, left, runOptions, inlineTextMaxBytes);
    const rightProbe = await probeSnapshotDiffSide(svnPath, right, runOptions, inlineTextMaxBytes);
    for (const [side, probe] of [['left', leftProbe], ['right', rightProbe]] as const) {
      switch (probe.state) {
        case 'binary':
          return { status: 'binary', side };
        case 'special':
          return { status: 'special', side };
        case 'tooLarge':
          return { status: 'tooLarge', side, limitBytes: probe.limitBytes };
        case 'notFound':
          return { status: 'notFound', side, error: probe.error };
        case 'error':
          return { status: 'error', side, error: probe.error };
        default:
          break;
      }
    }
    if (leftProbe.state === 'absent' && rightProbe.state === 'absent') {
      return { status: 'failed', message: snapshotText('stateNotFoundAtRevision') };
    }
    const leftText = await readSnapshotDiffSideText(svnPath, left, runOptions, inlineTextMaxBytes);
    if (leftText.state !== 'text') {
      return leftText.state === 'tooLarge'
        ? { status: 'tooLarge', side: 'left', limitBytes: leftText.limitBytes }
        : leftText.state === 'notFound'
          ? { status: 'notFound', side: 'left', error: leftText.error }
          : { status: 'error', side: 'left', error: leftText.error };
    }
    const rightText = await readSnapshotDiffSideText(svnPath, right, runOptions, inlineTextMaxBytes);
    if (rightText.state !== 'text') {
      return rightText.state === 'tooLarge'
        ? { status: 'tooLarge', side: 'right', limitBytes: rightText.limitBytes }
        : rightText.state === 'notFound'
          ? { status: 'notFound', side: 'right', error: rightText.error }
          : { status: 'error', side: 'right', error: rightText.error };
    }

    ensureSnapshotProvider();
    ensureCloseListener();
    const leftKey = randomBytes(12).toString('hex');
    const rightKey = randomBytes(12).toString('hex');
    snapshotContents.set(leftKey, { text: leftText.text, bytes: leftText.bytes });
    snapshotContents.set(rightKey, { text: rightText.text, bytes: rightText.bytes });
    const leftUri = buildSnapshotDocumentUri(
      { rawUrl: left.rawUrl ?? 'urn:svn-anywhere:absent', revision: left.revision },
      snapshotDisplayName(left),
      leftKey,
    );
    const rightUri = buildSnapshotDocumentUri(
      { rawUrl: right.rawUrl ?? 'urn:svn-anywhere:absent', revision: right.revision },
      snapshotDisplayName(right),
      rightKey,
    );
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, params.title, { preview: false });
    return {
      status: 'opened',
      leftUri: leftUri.toString(),
      rightUri: rightUri.toString(),
      leftBytes: leftText.bytes,
      rightBytes: rightText.bytes,
    };
  } catch (err) {
    return {
      status: 'failed',
      message: err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err),
    };
  }
}

/** 停用清理：释放快照 provider 与内存内容。 */
export function disposeSnapshotDiffView(): void {
  snapshotContents.clear();
  snapshotProvider?.dispose();
  snapshotProvider = undefined;
}

/**
 * 扩展停用时的差异视图兜底清理：在 disposeSnapshotDiffView 基础上，
 * 释放文档关闭监听并删除尚未被关闭事件回收的差异临时目录（差异编辑器
 * 随宿主关闭时 close 事件不再到达扩展）。
 */
export function disposeDiffView(): void {
  disposeSnapshotDiffView();
  for (const tempDir of new Set(tempRefs.values())) {
    removeDiffTempDir(tempDir);
  }
  tempRefs.clear();
  closeSubscription?.dispose();
  closeSubscription = undefined;
}

// ---------------------------------------------------------------------------
// P6 单文件导出：原生保存对话框 + 覆盖确认
// ---------------------------------------------------------------------------

export interface PromptSnapshotExportParams {
  svnPath: string;
  /** planSnapshotExport 的 present/preceding 结果（url/revision 为实际节点）。 */
  plan: Extract<SnapshotExportPlan, { status: 'present' | 'preceding' }>;
  /** 保存对话框的建议文件名（会是初始默认名）。 */
  suggestedName: string;
  runOptions?: RunOptions;
}

export type SnapshotExportDialogOutcome =
  | { status: 'exported'; path: string; revision: number; viaHistoryFallback: boolean }
  | { status: 'canceled' }
  | { status: 'failed'; message: string };

function sanitizeExportName(name: string): string {
  const cleaned = basename(name)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'svn-export' : cleaned;
}

/**
 * 单文件导出的宿主入口（任务 5）：
 * - 原生保存对话框选择目标路径；对话框取消不写任何文件；
 * - 目标已存在时显式模态确认覆盖（不依赖宿主对话框自身的覆盖提示，
 *   `svn export --force` 也不清理旧文件，产品走临时文件 + 原子替换）；
 * - 写盘由 writeSnapshotExport 执行（导出源与本地目标都做 peg 转义）；
 * - 删除前版本导出返回实际 revision 与是否经历史前序回退，供界面明示。
 */
export async function promptSnapshotExport(
  params: PromptSnapshotExportParams,
): Promise<SnapshotExportDialogOutcome> {
  const windowApi = vscode.window;
  if (windowApi === undefined || typeof windowApi.showSaveDialog !== 'function') {
    return { status: 'failed', message: snapshotText('exportFailed', { message: '宿主缺少保存对话框' }) };
  }
  const picked = await windowApi.showSaveDialog({
    // 默认保存到用户主目录，避免相对 file URI 由宿主按未知 cwd 解析。
    defaultUri: vscode.Uri.file(join(homedir(), sanitizeExportName(params.suggestedName))),
    saveLabel: snapshotText(
      params.plan.status === 'preceding' ? 'exportPrecedingDialogTitle' : 'exportDialogTitle',
    ),
  });
  if (picked === undefined) {
    return { status: 'canceled' };
  }
  const targetPath = picked.fsPath !== undefined && picked.fsPath !== '' ? picked.fsPath : picked.path;
  let result = await writeSnapshotExport(
    params.svnPath,
    { url: params.plan.url, revision: params.plan.revision, targetPath },
    params.runOptions ?? {},
  );
  if (result.status === 'exists') {
    const confirmLabel = snapshotText('exportExistsConfirm');
    const ok = await windowApi.showWarningMessage(
      snapshotText('exportExistsTitle'),
      { modal: true, detail: snapshotText('exportExistsDetail', { path: targetPath }) },
      confirmLabel,
    );
    if (ok !== confirmLabel) {
      return { status: 'canceled' };
    }
    result = await writeSnapshotExport(
      params.svnPath,
      { url: params.plan.url, revision: params.plan.revision, targetPath, overwrite: true },
      params.runOptions ?? {},
    );
  }
  if (result.status === 'exported') {
    return {
      status: 'exported',
      path: result.path,
      revision: params.plan.revision,
      viaHistoryFallback: params.plan.status === 'preceding' && params.plan.viaHistoryFallback,
    };
  }
  if (result.status === 'failed') {
    return { status: 'failed', message: result.message };
  }
  return { status: 'canceled' };
}

// ---------------------------------------------------------------------------
// P6 BASE 比较与内容打开复用
// ---------------------------------------------------------------------------

/**
 * 目录 BASE 比较逐项入口：把字符串键变化交给既有单文件 BASE diff
 * （openEntryDiff 的决策矩阵与临时资源释放完全复用，不重写 BASE 语义）。
 */
export async function openSnapshotBaseCompareEntry(
  svnPath: string,
  wcRoot: string,
  entry: SnapshotBaseCompareEntry,
): Promise<DiffOutcome> {
  return openEntryDiff({
    svnPath,
    wcRoot,
    relPath: entry.relPath,
    wcStatus: entry.wcStatus,
    props: entry.props,
    kind: entry.kind,
  });
}

/**
 * 打开所选 revision 的节点内容（P5 只读 provider / 二进制临时资源复用的
 * 唯一入口）：文本按 mime/NUL 判定内嵌预览，二进制/超大文本交系统默认
 * 应用；2 GiB 与磁盘余量不足等降级状态原样返回。
 */
export async function openSnapshotNodeContent(
  svnPath: string,
  node: RepoNodeRef,
  revision: number,
  options: RunOptions = {},
): Promise<RemoteContentOpenOutcome> {
  return openRemoteContent(svnPath, node, { ...options, revision });
}
