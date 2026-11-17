/**
 * F107 快速差异（M4 阶段 4 任务 2）：只对用户显式开启的当前活动文本文件
 * 工作，用编辑器装饰显示修改/新增/删除行，不新建业务面板、不后台轮询。
 *
 * 口径（本地 SVN 实测）：
 * - 先判定本地/已版本控制/存在/非目录/非二进制；未版本控制（E155010）、
 *   missing（`svn diff -r BASE -x -U0` 静默 exit 0 且输出全空）与二进制
 *   必须在入口用 status/info + mime/NUL 分类挡住，不能靠 diff 输出判定。
 * - 完整命令 `svn diff --non-interactive --internal-diff --ignore-properties
 *   -r BASE -x -U0 -- <原始字面路径>`；`--internal-diff` 覆盖用户 external
 *   diff 配置，hunk 只用于行区间，不把 stdout 当补丁保存。`@` 路径与
 *   blame/cat 相反：diff 必须用原始字面路径，追加尾 `@` 会被当字面文件名。
 * - `-x -U0` 的 hunk 头为 `@@ -oldStart[,oldCount] +newStart[,newCount] @@`，
 *   count 缺省为 1；修改/新增映射到工作文件行区间，纯删除 hunk
 *   （newCount=0）没有工作文件行区间，只在 newStart 行显示删除标记，
 *   不生成非法 Range。
 * - 文档保存、重新激活时刷新；再次执行关闭命令或切到其他编辑器即撤下
 *   装饰（关闭命令/关闭编辑器都走显式状态清理，不依赖文档释放事件）。
 */
import * as vscode from 'vscode';
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { SvnError } from '../core/errors';
import { BINARY_PROBE_BYTES, classifyContentKind } from '../core/remoteBrowse';
import { runStatus } from '../core/status';
import { runOrThrow, type RunOptions } from '../core/svnCli';
import { escapePeg, findWorkingCopy } from '../core/workspace';
import { readSvnPath, readTimeoutMs } from './config';
import { format, strings } from './i18n';
import { decodingRunOptions, logCommand, logLine } from './output';

// ---------------------------------------------------------------------------
// 本地目标判定（versioned / exists / nonDir / nonBinary）
// ---------------------------------------------------------------------------

/** 通过判定的本地文本目标。 */
export interface LocalEditorTarget {
  wcRoot: string;
  /** 目标文件绝对路径（realpath 归一后的现存路径）。 */
  fsPath: string;
  /** 工作副本相对路径（原始字面形态；diff 直接作为参数，不追加 peg）。 */
  relPath: string;
  /** 本地逻辑大小（stat.size，不是磁盘占用）。 */
  sizeBytes: number;
}

export type LocalEditorRejectReason =
  | 'noActiveEditor'
  | 'notFile'
  | 'notWorkingCopy'
  | 'unversioned'
  | 'missing'
  | 'deleted'
  | 'directory'
  | 'binary';

export type LocalEditorTargetResult =
  | { status: 'ok'; target: LocalEditorTarget }
  | { status: 'rejected'; reason: LocalEditorRejectReason }
  | { status: 'error'; error: unknown };

export interface ProbeLocalEditorOptions {
  svnPath: string;
  runOptions?: RunOptions;
}

/** 读取文件前 limit 字节（NUL 判据只摸探测窗口，不整文件读入）。 */
export function readHeadBytes(fsPath: string, limit = BINARY_PROBE_BYTES): Buffer {
  const fd = openSync(fsPath, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    const bytesRead = readSync(fd, buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

/**
 * 本地 `svn:mime-type` 属性读取。属性缺失是正常情况：老版本输出空 stdout
 * exit 0，1.15 输出 W200017 警告 + exit 1（实测），两者都返回 undefined；
 * 其余命令失败按异常上抛，由调用方分类。
 */
export async function readLocalMimeType(
  svnPath: string,
  wcRoot: string,
  relPath: string,
  options: RunOptions = {},
): Promise<string | undefined> {
  const args = ['propget', '--non-interactive', 'svn:mime-type', '--', escapePeg(relPath)];
  try {
    const result = await runOrThrow(svnPath, args, { cwd: wcRoot, ...options });
    const value = result.stdout.trim();
    return value === '' ? undefined : value;
  } catch (err) {
    if (err instanceof SvnError && /W200017/.test(`${err.stderr ?? ''}\n${err.message}`)) {
      return undefined;
    }
    throw err;
  }
}

/** info 失败是否属于「路径未纳管/不存在」（不是认证/网络/权限）。 */
function isUnversionedFailure(err: unknown): boolean {
  if (!(err instanceof SvnError)) {
    return false;
  }
  const text = `${err.stderr ?? ''}\n${err.message}\n${err.code ?? ''}`;
  return /\b(?:E155010|W155010|E200009|E155007|W155007)\b/.test(text);
}

/**
 * 判定一个本地文档 URI 是否可作为快速差异/行内追溯目标。
 *
 * 顺序：file scheme → 工作副本定位 → 本地存在/非目录 → status 分类
 * （unversioned/missing/deleted 入口禁用）→ 无 status 条目时用 info 确认
 * 已版本控制 → `svn:mime-type` + 前 8 KiB NUL 双重二进制判定。
 */
export async function probeLocalEditorTarget(
  documentUri: vscode.Uri,
  options: ProbeLocalEditorOptions,
): Promise<LocalEditorTargetResult> {
  if (documentUri.scheme !== 'file') {
    return { status: 'rejected', reason: 'notFile' };
  }
  const rawPath = documentUri.fsPath;
  const wcRoot = findWorkingCopy(rawPath);
  if (wcRoot === undefined) {
    return { status: 'rejected', reason: 'notWorkingCopy' };
  }
  let stat;
  try {
    stat = statSync(rawPath);
  } catch {
    // 本地不存在：missing（含 svn rm 未提交的 missing 文件）。
    return { status: 'rejected', reason: 'missing' };
  }
  if (stat.isDirectory()) {
    return { status: 'rejected', reason: 'directory' };
  }
  if (!stat.isFile()) {
    return { status: 'rejected', reason: 'notFile' };
  }
  const fsPath = safeRealpath(rawPath);
  const relPath = relative(wcRoot, fsPath);
  if (relPath === '' || relPath.startsWith('..') || isAbsolute(relPath)) {
    return { status: 'rejected', reason: 'notWorkingCopy' };
  }

  const runOptions: RunOptions = { cwd: wcRoot, ...(options.runOptions ?? {}) };
  let versioned = false;
  try {
    const status = await runStatus(options.svnPath, relPath, runOptions);
    const entry = status.entries.find((item) => item.path === relPath || item.path === fsPath);
    if (entry !== undefined) {
      if (entry.wcStatus === 'unversioned' || entry.wcStatus === 'ignored' || entry.wcStatus === 'external') {
        return { status: 'rejected', reason: 'unversioned' };
      }
      if (entry.wcStatus === 'missing') {
        return { status: 'rejected', reason: 'missing' };
      }
      if (entry.wcStatus === 'deleted') {
        return { status: 'rejected', reason: 'deleted' };
      }
      if (entry.kind === 'dir') {
        return { status: 'rejected', reason: 'directory' };
      }
      versioned = true;
    }
  } catch (err) {
    return { status: 'error', error: err };
  }
  if (!versioned) {
    // 干净版本文件不在 status 输出中：用 info 一次确认版本控制身份。
    try {
      await runOrThrow(options.svnPath, ['info', '--non-interactive', '--', escapePeg(relPath)], runOptions);
      versioned = true;
    } catch (err) {
      if (isUnversionedFailure(err)) {
        return { status: 'rejected', reason: 'unversioned' };
      }
      return { status: 'error', error: err };
    }
  }

  let mimeType: string | undefined;
  try {
    mimeType = await readLocalMimeType(options.svnPath, wcRoot, relPath, options.runOptions ?? {});
  } catch (err) {
    return { status: 'error', error: err };
  }
  let head: Buffer;
  try {
    head = readHeadBytes(fsPath);
  } catch (err) {
    return { status: 'error', error: err };
  }
  if (classifyContentKind(mimeType, head).kind === 'binary') {
    return { status: 'rejected', reason: 'binary' };
  }
  return { status: 'ok', target: { wcRoot, fsPath, relPath, sizeBytes: stat.size } };
}

function safeRealpath(fsPath: string): string {
  try {
    return realpathSync(fsPath);
  } catch {
    // 现存文件不会失败；父目录别名等场景保留原路径交给 relative 判定。
    return fsPath;
  }
}

/** 本地目标拒绝原因的中文短语（刷新停止等日志用，命令提示走 editor.ts）。 */
export function localRejectReasonLabel(
  reason: LocalEditorRejectReason | 'tooLarge' | 'noCommittedRevision' | 'error',
): string {
  switch (reason) {
    case 'noActiveEditor':
      return strings.editor.reasonUnknown;
    case 'notFile':
      return strings.editor.reasonNotFile;
    case 'notWorkingCopy':
      return strings.editor.reasonNotWorkingCopy;
    case 'unversioned':
      return strings.editor.reasonUnversioned;
    case 'missing':
      return strings.editor.reasonMissing;
    case 'deleted':
      return strings.editor.reasonDeleted;
    case 'directory':
      return strings.editor.reasonDirectory;
    case 'binary':
      return strings.editor.reasonBinary;
    case 'tooLarge':
      return strings.editor.reasonTooLarge;
    case 'noCommittedRevision':
      return strings.blamePanel.noCommittedRevision;
    case 'error':
      return strings.editor.reasonUnknown;
  }
}

// ---------------------------------------------------------------------------
// 零上下文 diff：命令、解析与行映射
// ---------------------------------------------------------------------------

/** `-U0` 基础参数（导出供测试断言 external diff 配置被 --internal-diff 覆盖）。 */
export const QUICK_DIFF_BASE_ARGS: readonly string[] = [
  'diff',
  '--non-interactive',
  '--internal-diff',
  '--ignore-properties',
  '-r',
  'BASE',
  '-x',
  '-U0',
];

/**
 * 构造单文件快速差异命令。relPath 必须保持原始字面形态（含 `@` 也不追加
 * 尾 `@`）；`--` 结束选项解析，短横线开头的相对路径同样安全。
 */
export function buildQuickDiffArgs(relPath: string): string[] {
  return [...QUICK_DIFF_BASE_ARGS, '--', relPath];
}

/** 一个零上下文 hunk（count 缺省已归一为 1）。 */
export interface QuickDiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** 解析 `-U0` 统一 diff 的 hunk 头；Index/---/+++ 头与内容行一律忽略。 */
export function parseZeroContextDiffHunks(diffStdout: string): QuickDiffHunk[] {
  const hunks: QuickDiffHunk[] = [];
  for (const line of diffStdout.split('\n')) {
    const match = HUNK_HEADER.exec(line);
    if (match === null) {
      continue;
    }
    hunks.push({
      oldStart: Number(match[1]),
      oldCount: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newCount: match[4] === undefined ? 1 : Number(match[4]),
    });
  }
  return hunks;
}

export type QuickDiffLineKind = 'modified' | 'added' | 'deleted';

/** 工作文件（1-based）行标记；deleted 仅代表该行处发生了删除。 */
export interface QuickDiffLineMarker {
  line: number;
  kind: QuickDiffLineKind;
  /** 仅 deleted：本次删除的旧文件行数（标记文本用）。 */
  deletedCount?: number;
}

/**
 * hunk → 工作文件行标记：
 * - 修改/新增（newCount > 0）映射到 [newStart, newStart+newCount-1]；
 *   oldCount=0 为纯新增，否则为修改；
 * - 纯删除（newCount=0）没有工作文件行区间，标记在 newStart 行（0 或
 *   超出文档时 clamp 到有效行），不生成非法 Range；
 * - 同一行既有删除标记又有修改/新增标记时以修改/新增为准。
 */
export function mapQuickDiffHunksToLines(
  hunks: readonly QuickDiffHunk[],
  documentLineCount: number,
): QuickDiffLineMarker[] {
  const byLine = new Map<number, QuickDiffLineMarker>();
  if (documentLineCount < 1) {
    return [];
  }
  const clampLine = (line: number): number => Math.min(Math.max(line, 1), documentLineCount);
  for (const hunk of hunks) {
    if (hunk.newCount === 0) {
      const line = clampLine(hunk.newStart);
      const existing = byLine.get(line);
      if (existing === undefined || existing.kind === 'deleted') {
        byLine.set(line, { line, kind: 'deleted', deletedCount: Math.max(hunk.oldCount, 1) });
      }
      continue;
    }
    const kind: QuickDiffLineKind = hunk.oldCount === 0 ? 'added' : 'modified';
    const first = clampLine(hunk.newStart);
    const last = clampLine(hunk.newStart + hunk.newCount - 1);
    for (let line = first; line <= last; line += 1) {
      const existing = byLine.get(line);
      if (existing === undefined || existing.kind === 'deleted') {
        byLine.set(line, { line, kind });
      }
    }
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------
// 装饰
// ---------------------------------------------------------------------------

export interface QuickDiffDecorationTypes {
  modified: vscode.TextEditorDecorationType;
  added: vscode.TextEditorDecorationType;
  deleted: vscode.TextEditorDecorationType;
}

export interface QuickDiffDecorationSet {
  modified: vscode.DecorationOptions[];
  added: vscode.DecorationOptions[];
  deleted: vscode.DecorationOptions[];
}

/** 行背景 + 概览标尺的三种装饰类型；rangeBehavior 固定不随编辑扩展。 */
export function createQuickDiffDecorationTypes(): QuickDiffDecorationTypes {
  const common = {
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  };
  return {
    modified: vscode.window.createTextEditorDecorationType({
      ...common,
      backgroundColor: 'rgba(255, 200, 0, 0.18)',
      overviewRulerColor: 'rgba(255, 200, 0, 0.80)',
    }),
    added: vscode.window.createTextEditorDecorationType({
      ...common,
      backgroundColor: 'rgba(80, 200, 120, 0.18)',
      overviewRulerColor: 'rgba(80, 200, 120, 0.80)',
    }),
    deleted: vscode.window.createTextEditorDecorationType({
      ...common,
      backgroundColor: 'rgba(230, 80, 80, 0.18)',
      overviewRulerColor: 'rgba(230, 80, 80, 0.80)',
    }),
  };
}

/** 行标记 → 三种装饰的 DecorationOptions（整行空范围，删除行附 after 提示）。 */
export function buildQuickDiffDecorations(markers: readonly QuickDiffLineMarker[]): QuickDiffDecorationSet {
  const result: QuickDiffDecorationSet = { modified: [], added: [], deleted: [] };
  for (const marker of markers) {
    const range = new vscode.Range(marker.line - 1, 0, marker.line - 1, 0);
    if (marker.kind === 'deleted') {
      result.deleted.push({
        range,
        renderOptions: {
          after: {
            contentText: format(strings.editor.quickDiffDeleted, {
              count: String(marker.deletedCount ?? 1),
            }),
          },
        },
      });
    } else if (marker.kind === 'added') {
      result.added.push({ range });
    } else {
      result.modified.push({ range });
    }
  }
  return result;
}

function applyQuickDiffDecorations(
  editor: vscode.TextEditor,
  types: QuickDiffDecorationTypes,
  decorations: QuickDiffDecorationSet,
): void {
  editor.setDecorations(types.modified, decorations.modified);
  editor.setDecorations(types.added, decorations.added);
  editor.setDecorations(types.deleted, decorations.deleted);
}

function clearQuickDiffDecorations(editor: vscode.TextEditor, types: QuickDiffDecorationTypes): void {
  editor.setDecorations(types.modified, []);
  editor.setDecorations(types.added, []);
  editor.setDecorations(types.deleted, []);
}

// ---------------------------------------------------------------------------
// diff 执行
// ---------------------------------------------------------------------------

export type QuickDiffCollectResult =
  | { status: 'ok'; hunks: QuickDiffHunk[] }
  /** 预判后状态变化（文件变成二进制）：不装饰，由调用方禁用。 */
  | { status: 'binary' };

/** 执行 `svn diff -r BASE -x -U0` 并解析 hunk；失败原样上抛。 */
export async function collectQuickDiffHunks(
  svnPath: string,
  target: Pick<LocalEditorTarget, 'wcRoot' | 'relPath'>,
  options: RunOptions = {},
): Promise<QuickDiffCollectResult> {
  const args = buildQuickDiffArgs(target.relPath);
  const result = await runOrThrow(svnPath, args, {
    cwd: target.wcRoot,
    ...options,
    onExit: logCommand(svnPath, args, target.wcRoot, 'other'),
  });
  if (/Cannot display: file marked as a binary type/i.test(result.stdout)) {
    return { status: 'binary' };
  }
  return { status: 'ok', hunks: parseZeroContextDiffHunks(result.stdout) };
}

// ---------------------------------------------------------------------------
// 开关状态机
// ---------------------------------------------------------------------------

export type QuickDiffOutcome =
  | { status: 'enabled'; markerCount: number }
  | { status: 'disabled' }
  /** 开启流程在途期间又被 toggle/关闭取代：本次结果丢弃，不创建会话。 */
  | { status: 'superseded' }
  | { status: 'rejected'; reason: LocalEditorRejectReason }
  | { status: 'failed'; error: unknown };

/** 可注入的依赖（测试用替身；默认走真实 svn 与 vscode 装饰 API）。 */
export interface QuickDiffDeps {
  svnPath?: string;
  runOptions?: RunOptions;
  probe?: typeof probeLocalEditorTarget;
  collect?: typeof collectQuickDiffHunks;
  createDecorationTypes?: typeof createQuickDiffDecorationTypes;
}

interface QuickDiffSession {
  uriKey: string;
  editor: vscode.TextEditor;
  types: QuickDiffDecorationTypes;
  disposables: vscode.Disposable[];
}

let quickDiffSession: QuickDiffSession | undefined;

/**
 * 开关代次（并发保护）：每次 toggle 进入与 disable 时递增。开启流程的
 * await 返回后校验代次，过期（期间又发生 toggle/关闭）则丢弃结果，
 * 不创建装饰类型、不登记监听——否则两次并发开启各自建立会话，
 * 先完成的装饰类型与事件监听会被后一次覆盖而永不释放，
 * 其 setDecorations 结果也无法被后续关闭清除。
 */
let quickDiffGeneration = 0;

/**
 * 最近一次装饰应用结果（会话被关闭时清空）。真实 Extension Host 冒烟用：
 * 装饰内容无法经 vscode 公开 API 回读，用「最近刷新是否产出行标记」证明
 * 保存触发的自动刷新真正完成，而非只证明会话仍开启。
 */
export interface QuickDiffLastRefresh {
  /** 会话文档 URI（editor.document.uri.toString()）。 */
  uriKey: string;
  /** 最近一次应用的行标记数；刷新被停止/失败时为 null。 */
  markerCount: number | null;
  /** 刷新被停止或失败的原因（成功时缺省）。 */
  error?: string;
}

let quickDiffLastRefresh: QuickDiffLastRefresh | undefined;

/** 当前（或最近一次）快速差异装饰应用结果；会话关闭后返回 undefined。 */
export function getLastQuickDiffRefresh(): QuickDiffLastRefresh | undefined {
  return quickDiffLastRefresh;
}

/** 当前是否有文档处于快速差异开启状态（测试/命令入口断言用）。 */
export function isQuickDiffEnabled(): boolean {
  return quickDiffSession !== undefined;
}

function defaultRunOptions(): RunOptions {
  return { timeoutMs: readTimeoutMs(), ...decodingRunOptions('other') };
}

function buildDeps(deps: QuickDiffDeps): Required<Pick<QuickDiffDeps, 'svnPath' | 'runOptions' | 'probe' | 'collect' | 'createDecorationTypes'>> {
  return {
    svnPath: deps.svnPath ?? readSvnPath(),
    runOptions: deps.runOptions ?? defaultRunOptions(),
    probe: deps.probe ?? probeLocalEditorTarget,
    collect: deps.collect ?? collectQuickDiffHunks,
    createDecorationTypes: deps.createDecorationTypes ?? createQuickDiffDecorationTypes,
  };
}

async function computeDecorations(
  fullDeps: ReturnType<typeof buildDeps>,
  editor: vscode.TextEditor,
): Promise<
  | { status: 'ok'; decorations: QuickDiffDecorationSet; markerCount: number }
  | { status: 'rejected'; reason: LocalEditorRejectReason }
  | { status: 'failed'; error: unknown }
> {
  const probed = await fullDeps.probe(editor.document.uri, {
    svnPath: fullDeps.svnPath,
    runOptions: fullDeps.runOptions,
  });
  if (probed.status === 'rejected') {
    return probed;
  }
  if (probed.status === 'error') {
    return { status: 'failed', error: probed.error };
  }
  let collected: QuickDiffCollectResult;
  try {
    collected = await fullDeps.collect(fullDeps.svnPath, probed.target, fullDeps.runOptions);
  } catch (err) {
    return { status: 'failed', error: err };
  }
  if (collected.status === 'binary') {
    return { status: 'rejected', reason: 'binary' };
  }
  const markers = mapQuickDiffHunksToLines(collected.hunks, editor.document.lineCount);
  return { status: 'ok', decorations: buildQuickDiffDecorations(markers), markerCount: markers.length };
}

/**
 * 开关当前活动文本文件的快速差异：
 * - 同一文件已开启 → 关闭并清除全部装饰；
 * - 未开启 → 先判定目标（versioned/exists/nonDir/nonBinary），再执行
 *   `svn diff -r BASE -x -U0` 并按 hunk 行号装饰；
 * - 开启期间监听文档保存（刷新）与活动编辑器切换（切走即撤销）。
 */
export async function toggleQuickDiff(
  editor: vscode.TextEditor | undefined,
  deps: QuickDiffDeps = {},
): Promise<QuickDiffOutcome> {
  if (editor === undefined) {
    return { status: 'rejected', reason: 'noActiveEditor' };
  }
  const uriKey = editor.document.uri.toString();
  if (quickDiffSession !== undefined && quickDiffSession.uriKey === uriKey) {
    disableQuickDiff();
    return { status: 'disabled' };
  }
  disableQuickDiff();
  const generation = quickDiffGeneration;
  const fullDeps = buildDeps(deps);
  const computed = await computeDecorations(fullDeps, editor);
  if (generation !== quickDiffGeneration) {
    // 期间又发生 toggle/关闭：本次开启已过期，结果丢弃（不建会话、不建装饰类型）。
    return { status: 'superseded' };
  }
  if (computed.status === 'rejected') {
    return computed;
  }
  if (computed.status === 'failed') {
    return computed;
  }

  const session: QuickDiffSession = {
    uriKey,
    editor,
    types: fullDeps.createDecorationTypes(),
    disposables: [],
  };
  quickDiffSession = session;
  applyQuickDiffDecorations(session.editor, session.types, computed.decorations);
  quickDiffLastRefresh = { uriKey, markerCount: computed.markerCount };
  watchQuickDiffSession(session, fullDeps);
  logLine(format(strings.editor.quickDiffEnabled, {
    path: editor.document.uri.fsPath,
    count: String(computed.markerCount),
  }));
  return { status: 'enabled', markerCount: computed.markerCount };
}

function watchQuickDiffSession(
  session: QuickDiffSession,
  fullDeps: ReturnType<typeof buildDeps>,
): void {
  const workspaceApi = vscode.workspace;
  if (typeof workspaceApi.onDidSaveTextDocument === 'function') {
    session.disposables.push(workspaceApi.onDidSaveTextDocument((document) => {
      if (quickDiffSession !== session || document.uri.toString() !== session.uriKey) {
        return;
      }
      void refreshQuickDiff(fullDeps);
    }));
  }
  if (typeof vscode.window.onDidChangeActiveTextEditor === 'function') {
    session.disposables.push(vscode.window.onDidChangeActiveTextEditor((active) => {
      if (quickDiffSession !== session) {
        return;
      }
      if (active === undefined || active.document.uri.toString() !== session.uriKey) {
        disableQuickDiff();
        return;
      }
      // 重新激活同一文档：刷新（技术方案 F107「重新激活时更新」）。
      void refreshQuickDiff(fullDeps);
    }));
  }
}

/**
 * 重新计算并应用装饰（保存、重新激活或手动刷新）。目标失效/变为二进制/
 * 读取失败时清空装饰并写输出频道；迟到结果不写入已关闭的会话。
 */
export async function refreshQuickDiff(deps: QuickDiffDeps = {}): Promise<void> {
  const session = quickDiffSession;
  if (session === undefined) {
    return;
  }
  const fullDeps = buildDeps(deps);
  try {
    const computed = await computeDecorations(fullDeps, session.editor);
    if (quickDiffSession !== session) {
      return;
    }
    if (computed.status === 'ok') {
      applyQuickDiffDecorations(session.editor, session.types, computed.decorations);
      quickDiffLastRefresh = { uriKey: session.uriKey, markerCount: computed.markerCount };
      return;
    }
    clearQuickDiffDecorations(session.editor, session.types);
    if (computed.status === 'rejected') {
      const reason = localRejectReasonLabel(computed.reason);
      quickDiffLastRefresh = { uriKey: session.uriKey, markerCount: null, error: reason };
      logLine(format(strings.editor.quickDiffRefreshStopped, {
        path: session.editor.document.uri.fsPath,
        reason,
      }));
    } else {
      const message = computed.error instanceof Error ? computed.error.message : String(computed.error);
      quickDiffLastRefresh = { uriKey: session.uriKey, markerCount: null, error: message };
      logLine(format(strings.error.failed, {
        message,
      }));
    }
  } catch (err) {
    if (quickDiffSession !== session) {
      return;
    }
    clearQuickDiffDecorations(session.editor, session.types);
    const message = err instanceof Error ? err.message : String(err);
    quickDiffLastRefresh = { uriKey: session.uriKey, markerCount: null, error: message };
    logLine(format(strings.error.failed, {
      message,
    }));
  }
}

/** 关闭快速差异：清空装饰、释放事件监听与装饰类型，不留残留状态。 */
export function disableQuickDiff(): void {
  // 关闭也是状态变更：让在途开启流程变为过期（避免关闭后又被迟到结果点亮）。
  quickDiffGeneration += 1;
  quickDiffLastRefresh = undefined;
  const session = quickDiffSession;
  if (session === undefined) {
    return;
  }
  quickDiffSession = undefined;
  try {
    clearQuickDiffDecorations(session.editor, session.types);
  } catch {
    // 编辑器已释放（窗口关闭）时清理异常不影响状态收口。
  }
  for (const disposable of session.disposables) {
    disposable.dispose();
  }
  session.disposables = [];
  session.types.modified.dispose();
  session.types.added.dispose();
  session.types.deleted.dispose();
}
