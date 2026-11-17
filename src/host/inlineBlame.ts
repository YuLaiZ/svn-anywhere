/**
 * F108 行内追溯（M4 阶段 4 任务 3）：当前工作文件逐行 revision/author
 * 装饰。core 模块不依赖 vscode，blame 执行与 XML 解析全部复用
 * `core/blame.ts`。
 *
 * 口径（本地 SVN 实测）：
 * - **不带任何 `-r`** 的 `svn blame --xml`：显式 `-r 1:HEAD`/`-r BASE`
 *   对工作副本按 BASE 内容输出，本地修改/新增后行号错位；本地新增/修改
 *   行可能没有 `<commit>`，显示「未提交/未归属」而不是套用旧行作者。
 * - 行尾 after 文本显示 `rN · author`；author 缺失（revprop 删除）只显示
 *   `rN`。
 * - 入口先用 status/info + `svn:mime-type`/NUL 双重探测判定
 *   versioned/exists/nonDir/nonBinary（复用 quickDiff 的本地目标探测）；
 *   blame 对二进制跳过行为不稳定、对 missing 文件仍返回 BASE 归属，
 *   不能依赖 blame 自身拒绝。
 * - 大小降级：文件 > 16 MiB 禁用行内追溯并返回明确状态；
 *   > 10 MiB 或 > 100k 行不自动刷新（保存时提示按需刷新）；blame XML
 *   体积约为工作文件 2.18 倍，输出字节上限 64 MiB 由 core/blame 承担。
 * - 显式开启后仅维护当前活动文本编辑器；关闭命令或切换文件即撤下装饰，
 *   不设后台轮询。
 */
import * as vscode from 'vscode';
import { runBlame, type BlameLine, type BlameNotTraceableReason } from '../core/blame';
import type { RunOptions } from '../core/svnCli';
import { readSvnPath, readTimeoutMs } from './config';
import { format, strings } from './i18n';
import { decodingRunOptions, logLine } from './output';
import {
  localRejectReasonLabel,
  probeLocalEditorTarget,
  type LocalEditorRejectReason,
  type LocalEditorTarget,
} from './quickDiff';

// ---------------------------------------------------------------------------
// 常量与降级判定
// ---------------------------------------------------------------------------

/** 超过此大小禁用行内追溯（实测 16 MiB blame 约 2.9 s）。 */
export const INLINE_BLAME_DISABLE_MAX_BYTES = 16 * 1024 * 1024;

/** 超过此大小不自动刷新，由用户按需刷新（实测 10 MiB 约 1.9 s）。 */
export const INLINE_BLAME_AUTO_REFRESH_MAX_BYTES = 10 * 1024 * 1024;

/** 超过此行数不自动刷新（装饰与 blame 重算的 UI 预算）。 */
export const INLINE_BLAME_AUTO_REFRESH_MAX_LINES = 100_000;

export type InlineBlameAvailability = 'auto' | 'manualRefresh' | 'disabled';

/** 文件大小/行数 → 刷新策略：禁用 / 仅按需刷新 / 自动刷新。 */
export function inlineBlameAvailability(sizeBytes: number, lineCount: number): InlineBlameAvailability {
  if (sizeBytes > INLINE_BLAME_DISABLE_MAX_BYTES) {
    return 'disabled';
  }
  if (sizeBytes > INLINE_BLAME_AUTO_REFRESH_MAX_BYTES || lineCount > INLINE_BLAME_AUTO_REFRESH_MAX_LINES) {
    return 'manualRefresh';
  }
  return 'auto';
}

// ---------------------------------------------------------------------------
// 行归属 → after 装饰文本
// ---------------------------------------------------------------------------

export interface InlineBlameDecoration {
  /** 1-based 行号（与当前工作文件对齐）。 */
  line: number;
  /** 行尾 after 文本：`rN · author` / `rN` / 未提交。 */
  text: string;
}

/**
 * blame 行归属 → 每行 after 文本：
 * - 有 `<commit>` 且有 author：`rN · author`；
 * - 有 `<commit>` 但 author 缺失（revprop 删除）：`rN`；
 * - 无 `<commit>`（本地修改/新增）：未提交/未归属；
 * - 超出当前文档行数的行（blame 与工作文件应对齐，防御性裁剪）不装饰。
 */
export function buildInlineBlameDecorations(
  lines: readonly BlameLine[],
  documentLineCount: number,
): InlineBlameDecoration[] {
  const decorations: InlineBlameDecoration[] = [];
  for (const line of lines) {
    if (line.lineNumber < 1 || line.lineNumber > documentLineCount) {
      continue;
    }
    let text: string;
    if (line.revision === undefined) {
      text = strings.editor.inlineBlameUncommitted;
    } else if (line.author !== undefined && line.author !== '') {
      text = format(strings.editor.inlineBlameLine, {
        revision: String(line.revision),
        author: line.author,
      });
    } else {
      text = format(strings.editor.inlineBlameLineNoAuthor, {
        revision: String(line.revision),
      });
    }
    decorations.push({ line: line.lineNumber, text });
  }
  return decorations;
}

/** 行内归属装饰类型：行尾 after 文本，灰色弱化，不改变行背景。 */
export function createInlineBlameDecorationType(): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    after: {
      color: 'rgba(128, 128, 128, 0.90)',
      margin: '0 0 0 2em',
    },
  });
}

/** 装饰数据 → DecorationOptions（整行范围，after 渲染在行尾）。 */
export function buildInlineBlameDecorationOptions(
  document: vscode.TextDocument,
  decorations: readonly InlineBlameDecoration[],
): vscode.DecorationOptions[] {
  return decorations.map((decoration) => ({
    range: document.lineAt(decoration.line - 1).range,
    renderOptions: {
      after: { contentText: decoration.text },
    },
  }));
}

// ---------------------------------------------------------------------------
// 开关状态机
// ---------------------------------------------------------------------------

export type InlineBlameRejectReason = LocalEditorRejectReason | 'tooLarge' | 'noCommittedRevision';

export type InlineBlameOutcome =
  | { status: 'enabled'; availability: Exclude<InlineBlameAvailability, 'disabled'>; lineCount: number }
  | { status: 'disabled' }
  /** 开启流程在途期间又被 toggle/关闭取代：本次结果丢弃，不创建会话。 */
  | { status: 'superseded' }
  | { status: 'rejected'; reason: InlineBlameRejectReason }
  | { status: 'failed'; error: unknown };

/** 可注入依赖（测试用替身；默认走真实 svn blame 与 vscode 装饰 API）。 */
export interface InlineBlameDeps {
  svnPath?: string;
  runOptions?: RunOptions;
  probe?: typeof probeLocalEditorTarget;
  blame?: typeof runBlame;
  createDecorationType?: typeof createInlineBlameDecorationType;
  /** 大文件保存时的「按需刷新」提示（默认 vscode.window.showInformationMessage）。 */
  notify?: (message: string, action: string) => Promise<string | undefined>;
}

interface InlineBlameSession {
  uriKey: string;
  editor: vscode.TextEditor;
  decorationType: vscode.TextEditorDecorationType;
  disposables: vscode.Disposable[];
  /** 最近一次按文件大小/行数重算的刷新策略（保存与刷新时更新）。 */
  availability: InlineBlameAvailability;
}

let inlineBlameSession: InlineBlameSession | undefined;

/**
 * 开关代次（并发保护）：每次 toggle 进入与 disable 时递增。开启流程的
 * await 返回后校验代次，过期（期间又发生 toggle/关闭）则丢弃结果，
 * 不创建装饰类型、不登记监听，避免并发开启覆盖会话导致资源泄漏。
 */
let inlineBlameGeneration = 0;

/** 当前是否有文档处于行内追溯开启状态（测试/命令入口断言用）。 */
export function isInlineBlameEnabled(): boolean {
  return inlineBlameSession !== undefined;
}

function defaultRunOptions(): RunOptions {
  return { timeoutMs: readTimeoutMs(), ...decodingRunOptions('other') };
}

function buildDeps(deps: InlineBlameDeps): Required<Pick<
  InlineBlameDeps,
  'svnPath' | 'runOptions' | 'probe' | 'blame' | 'createDecorationType' | 'notify'
>> {
  return {
    svnPath: deps.svnPath ?? readSvnPath(),
    runOptions: deps.runOptions ?? defaultRunOptions(),
    probe: deps.probe ?? probeLocalEditorTarget,
    blame: deps.blame ?? runBlame,
    createDecorationType: deps.createDecorationType ?? createInlineBlameDecorationType,
    notify: deps.notify ?? defaultNotify,
  };
}

function defaultNotify(message: string, action: string): Promise<string | undefined> {
  return Promise.resolve(vscode.window.showInformationMessage(message, action)) as Promise<string | undefined>;
}

/** blame 不可追溯原因 → 入口拒绝原因（binary/notFound/directory/noCommittedRevision/tooLarge）。 */
function notTraceableReasonToReject(reason: BlameNotTraceableReason): InlineBlameRejectReason {
  switch (reason) {
    case 'binary':
      return 'binary';
    case 'directory':
      return 'directory';
    case 'notFound':
      return 'missing';
    case 'noCommittedRevision':
      // 已 svn add 未提交：不是「未纳入版本控制」，用专属原因映射准确文案。
      return 'noCommittedRevision';
    case 'tooLarge':
      return 'tooLarge';
  }
}

function applyInlineBlame(
  session: InlineBlameSession,
  lines: readonly BlameLine[],
): void {
  const document = session.editor.document;
  const decorations = buildInlineBlameDecorations(lines, document.lineCount);
  session.editor.setDecorations(
    session.decorationType,
    buildInlineBlameDecorationOptions(document, decorations),
  );
}

/**
 * 开关当前活动文本文件的行内追溯：
 * - 同一文件已开启 → 关闭并清除装饰；
 * - 未开启 → 判定目标与大小（>16 MiB 禁用并返回 tooLarge），执行不带
 *   `-r` 的 `svn blame --xml`，逐行装饰 revision/author；
 * - 开启期间小文件保存自动刷新；>10 MiB/>100k 行保存不自动刷新，弹
 *   「立即刷新」按需刷新；切换编辑器即撤销。
 */
export async function toggleInlineBlame(
  editor: vscode.TextEditor | undefined,
  deps: InlineBlameDeps = {},
): Promise<InlineBlameOutcome> {
  if (editor === undefined) {
    return { status: 'rejected', reason: 'noActiveEditor' };
  }
  const uriKey = editor.document.uri.toString();
  if (inlineBlameSession !== undefined && inlineBlameSession.uriKey === uriKey) {
    disableInlineBlame();
    return { status: 'disabled' };
  }
  disableInlineBlame();
  const generation = inlineBlameGeneration;
  const fullDeps = buildDeps(deps);

  const probed = await fullDeps.probe(editor.document.uri, {
    svnPath: fullDeps.svnPath,
    runOptions: fullDeps.runOptions,
  });
  if (generation !== inlineBlameGeneration) {
    return { status: 'superseded' };
  }
  if (probed.status === 'rejected') {
    return probed;
  }
  if (probed.status === 'error') {
    return { status: 'failed', error: probed.error };
  }
  const target: LocalEditorTarget = probed.target;
  const availability = inlineBlameAvailability(target.sizeBytes, editor.document.lineCount);
  if (availability === 'disabled') {
    return { status: 'rejected', reason: 'tooLarge' };
  }

  const blamed = await executeBlame(fullDeps, target);
  if (generation !== inlineBlameGeneration) {
    // 期间又发生 toggle/关闭：本次开启已过期，结果丢弃（不建会话、不建装饰类型）。
    return { status: 'superseded' };
  }
  if (blamed.status !== 'ok') {
    return blamed;
  }

  const session: InlineBlameSession = {
    uriKey,
    editor,
    decorationType: fullDeps.createDecorationType(),
    disposables: [],
    availability,
  };
  inlineBlameSession = session;
  applyInlineBlame(session, blamed.lines);
  watchInlineBlameSession(session, fullDeps);
  logLine(format(strings.editor.inlineBlameEnabled, {
    path: editor.document.uri.fsPath,
    count: String(blamed.lines.length),
  }));
  return {
    status: 'enabled',
    availability,
    lineCount: blamed.lines.length,
  };
}

type BlameExecution =
  | { status: 'ok'; lines: BlameLine[] }
  | { status: 'rejected'; reason: InlineBlameRejectReason }
  | { status: 'failed'; error: unknown };

/** 执行 blame 并归一结果；network/auth 等异常交统一错误收口。 */
async function executeBlame(
  fullDeps: ReturnType<typeof buildDeps>,
  target: LocalEditorTarget,
): Promise<BlameExecution> {
  try {
    // 传原始绝对路径：core/blame 的 buildBlameArgs 会统一补 `@` peg（含 `@`
    // 的本地路径必须尾部追加 `@`，与 diff 的原始字面路径语义相反）。
    const result = await fullDeps.blame(
      fullDeps.svnPath,
      { target: target.fsPath },
      { cwd: target.wcRoot, ...fullDeps.runOptions },
    );
    if (result.state === 'notTraceable') {
      return { status: 'rejected', reason: notTraceableReasonToReject(result.reason) };
    }
    return { status: 'ok', lines: result.lines };
  } catch (err) {
    return { status: 'failed', error: err };
  }
}

function watchInlineBlameSession(
  session: InlineBlameSession,
  fullDeps: ReturnType<typeof buildDeps>,
): void {
  const workspaceApi = vscode.workspace;
  if (typeof workspaceApi.onDidSaveTextDocument === 'function') {
    session.disposables.push(workspaceApi.onDidSaveTextDocument((document) => {
      if (inlineBlameSession !== session || document.uri.toString() !== session.uriKey) {
        return;
      }
      // 文件可能在开启后增长跨过大小/行数阈值：保存时按最新探测重算策略。
      void handleInlineBlameSave(session, fullDeps);
    }));
  }
  if (typeof vscode.window.onDidChangeActiveTextEditor === 'function') {
    session.disposables.push(vscode.window.onDidChangeActiveTextEditor((active) => {
      if (inlineBlameSession !== session) {
        return;
      }
      if (active === undefined || active.document.uri.toString() !== session.uriKey) {
        disableInlineBlame();
      }
    }));
  }
}

/**
 * 保存后的刷新策略：用最新探测的 sizeBytes 与当前文档行数重算
 * inlineBlameAvailability 并写回会话，按三分支处理：
 * - disabled（>16 MiB）：撤下装饰、关闭会话并提示；
 * - manualRefresh（>10 MiB 或 >100k 行）：只弹「立即刷新」，不自动跑 blame；
 * - auto：自动刷新。
 */
async function handleInlineBlameSave(
  session: InlineBlameSession,
  fullDeps: ReturnType<typeof buildDeps>,
): Promise<void> {
  try {
    const probed = await fullDeps.probe(session.editor.document.uri, {
      svnPath: fullDeps.svnPath,
      runOptions: fullDeps.runOptions,
    });
    if (inlineBlameSession !== session) {
      return;
    }
    if (probed.status !== 'ok') {
      clearInlineBlameDecorations(session);
      logLine(format(strings.editor.inlineBlameRefreshStopped, {
        path: session.editor.document.uri.fsPath,
        reason: localRejectReasonLabel(probed.status === 'rejected' ? probed.reason : 'error'),
      }));
      return;
    }
    const availability = refreshAvailability(session, probed.target);
    if (availability === 'disabled') {
      disableInlineBlame();
      logLine(format(strings.editor.inlineBlameRefreshStopped, {
        path: session.editor.document.uri.fsPath,
        reason: localRejectReasonLabel('tooLarge'),
      }));
      void vscode.window.showWarningMessage(strings.editor.inlineBlameTooLarge);
      return;
    }
    if (availability === 'manualRefresh') {
      await promptManualRefresh(fullDeps);
      return;
    }
    await refreshInlineBlame(fullDeps);
  } catch (err) {
    if (inlineBlameSession !== session) {
      return;
    }
    clearInlineBlameDecorations(session);
    logLine(format(strings.error.failed, {
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

/** 按最新探测结果与当前文档行数重算刷新策略并写回会话。 */
function refreshAvailability(
  session: InlineBlameSession,
  target: LocalEditorTarget,
): InlineBlameAvailability {
  const availability = inlineBlameAvailability(target.sizeBytes, session.editor.document.lineCount);
  session.availability = availability;
  return availability;
}

/** 大文件保存后的按需刷新提示；用户点「立即刷新」才重跑 blame。 */
async function promptManualRefresh(fullDeps: ReturnType<typeof buildDeps>): Promise<void> {
  try {
    const picked = await fullDeps.notify(
      strings.editor.inlineBlameManualRefresh,
      strings.editor.inlineBlameRefreshNow,
    );
    if (picked === strings.editor.inlineBlameRefreshNow) {
      await refreshInlineBlame(fullDeps);
    }
  } catch {
    // 提示失败不影响功能；下次保存再提示。
  }
}

/**
 * 重新执行 blame 并刷新装饰（保存自动刷新或用户按需刷新）。目标失效时
 * 清空装饰并写输出频道；迟到结果不写入已关闭的会话。
 */
export async function refreshInlineBlame(deps: InlineBlameDeps = {}): Promise<void> {
  const session = inlineBlameSession;
  if (session === undefined) {
    return;
  }
  const fullDeps = buildDeps(deps);
  try {
    const probed = await fullDeps.probe(session.editor.document.uri, {
      svnPath: fullDeps.svnPath,
      runOptions: fullDeps.runOptions,
    });
    if (inlineBlameSession !== session) {
      return;
    }
    if (probed.status !== 'ok') {
      clearInlineBlameDecorations(session);
      logLine(format(strings.editor.inlineBlameRefreshStopped, {
        path: session.editor.document.uri.fsPath,
        reason: localRejectReasonLabel(probed.status === 'rejected' ? probed.reason : 'error'),
      }));
      return;
    }
    // 文件可能在开启后增长跨过阈值——按最新探测重算并写回策略。
    // disabled 时直接收口关闭会话；manualRefresh 只表示「保存不自动刷新」，
    // 本次是调用方明确要求刷新（保存分支已按 manualRefresh 拦截，或用户
    // 点了「立即刷新」），继续执行。
    if (refreshAvailability(session, probed.target) === 'disabled') {
      disableInlineBlame();
      logLine(format(strings.editor.inlineBlameRefreshStopped, {
        path: session.editor.document.uri.fsPath,
        reason: localRejectReasonLabel('tooLarge'),
      }));
      void vscode.window.showWarningMessage(strings.editor.inlineBlameTooLarge);
      return;
    }
    const blamed = await executeBlame(fullDeps, probed.target);
    if (inlineBlameSession !== session) {
      return;
    }
    if (blamed.status !== 'ok') {
      clearInlineBlameDecorations(session);
      logLine(format(strings.editor.inlineBlameRefreshStopped, {
        path: session.editor.document.uri.fsPath,
        reason: localRejectReasonLabel(blamed.status === 'rejected' ? blamed.reason : 'error'),
      }));
      return;
    }
    applyInlineBlame(session, blamed.lines);
  } catch (err) {
    if (inlineBlameSession !== session) {
      return;
    }
    clearInlineBlameDecorations(session);
    logLine(format(strings.error.failed, {
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

function clearInlineBlameDecorations(session: InlineBlameSession): void {
  try {
    session.editor.setDecorations(session.decorationType, []);
  } catch {
    // 编辑器已释放（窗口关闭）时清理异常不影响状态收口。
  }
}

/** 关闭行内追溯：清空装饰、释放事件监听与装饰类型，不留残留状态。 */
export function disableInlineBlame(): void {
  // 关闭也是状态变更：让在途开启流程变为过期（避免关闭后又被迟到结果点亮）。
  inlineBlameGeneration += 1;
  const session = inlineBlameSession;
  if (session === undefined) {
    return;
  }
  inlineBlameSession = undefined;
  clearInlineBlameDecorations(session);
  for (const disposable of session.disposables) {
    disposable.dispose();
  }
  session.disposables = [];
  session.decorationType.dispose();
}
