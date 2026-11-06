/**
 * 导入任务执行器（importTask）测试：mock vscode（输出频道/配置）与 core
 * svn 命令层（runOrThrow），经执行器 API 驱动完整状态机——
 * - 快照落盘时点（紧邻 begin、文件名即 operationId）与半写清理/写失败出口；
 * - begin 任何失败（busy/idConflict/写失败）一律删快照（反复尝试不累积
 *   无主文件）+ 草稿写回 + 任务移除 + 无缓存写入；
 * - importIntent 全字段落盘（重启模拟 loadAllRecords 读回）；
 * - 执行期认证「先补录、后查远端」四态（E200009 带凭据重试/目标已存在放
 *   弃/ls 认证失败/ls 其他失败提示）；svn+ssh 不注入；
 * - 成功路径证据检查三分类（A→done / 非 A→merged outcome 落盘 / 证据不
 *   可得→unknown 无 outcome / exit 0 无尾行→unknown）；
 * - 直接失败出口⑦（finish+快照删+失败页 formSnapshot）与取消→unknown；
 * - verifyImport 三结论的记录收口与快照删除（unknown 保持不动）；
 * - acknowledge（outcome 随 done 落盘保留）与 abandon 收口；
 * - 快照文件名与孤儿快照清理的识别形态一致。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { SvnError } from '../src/core/errors';
import {
  enumerateImportSource,
  enumerationToSnapshot,
  messageDigest,
  serializeSnapshot,
  snapshotDigest,
  type ImportSnapshot,
  type ParentIdentitySnapshot,
} from '../src/core/importDir';
import {
  OperationRegistry,
  randomOperationId,
  resetRunningOperationsForTest,
  setOperationRegistryForTest,
  type OperationRecord,
  type OperationStore,
} from '../src/core/operations';
import { runOrThrow, type AuthCredentials, type RunOptions, type RunResult } from '../src/core/svnCli';
import { cleanupOrphanSnapshots } from '../src/host/orphanSnapshots';
import { readDraft, setDraftStorage, type CheckoutFormDraft } from '../src/host/panel/drafts';
import { cancelCheckoutTask } from '../src/host/panel/checkoutTask';
import {
  ImportProgressParser,
  abandonUnknownImportTask,
  acknowledgeImportTask,
  deleteImportSnapshot,
  startImportTask,
  verifyImportTask,
  type StartImportTaskInput,
} from '../src/host/panel/importTask';
import { resetResultEpochs } from '../src/host/resultEpoch';
import { matchReadonlyVerify, readSessionResult, resetSessionResults } from '../src/host/sessionResults';
import { getActiveTask, getTaskById, resetTaskRegistry } from '../src/host/taskRegistry';

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({
      lines: [] as string[],
      shown: 0,
      appendLine(line: string) {
        (this as { lines: string[] }).lines.push(line);
      },
      show() {
        (this as { shown: number }).shown += 1;
      },
      dispose() {},
    }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
}));

vi.mock('../src/core/svnCli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/svnCli')>();
  return { ...actual, runOrThrow: vi.fn() };
});

/* ------------------------------ 测试夹具 ------------------------------ */

const PARENT_IDENTITY: ParentIdentitySnapshot = {
  repositoryUuid: 'uuid-1',
  repositoryRootUrl: 'file:///tmp/repo',
  lastChangedRevision: 2,
};

const TARGET_URL = 'file:///tmp/repo/trunk/src';
const SOURCE_DIR = '/import/src-real';
const MESSAGE = '导入说明';

const FORM: CheckoutFormDraft = {
  url: TARGET_URL,
  urlInput: TARGET_URL,
  nameMode: 'manual',
  parentDir: '',
  dirName: '',
  directMode: false,
  directDir: '',
  revMode: 'head',
  rev: '',
  depth: 'infinity',
  sourceDir: SOURCE_DIR,
  message: MESSAGE,
};

/** 快照夹具：a.txt + sub/b.txt + 忽略项 tmp.log + 目录 sub。 */
const SNAPSHOT: ImportSnapshot = {
  version: 1,
  entries: [
    { path: 'a.txt', kind: 'file', size: 10, mtimeMs: 1, ignored: false, unreadable: false, nested: false, unsupported: false },
    { path: 'sub', kind: 'dir', size: 0, mtimeMs: 1, ignored: false, unreadable: false, nested: false, unsupported: false },
    { path: 'sub/b.txt', kind: 'file', size: 20, mtimeMs: 1, ignored: false, unreadable: false, nested: false, unsupported: false },
    { path: 'tmp.log', kind: 'file', size: 5, mtimeMs: 1, ignored: true, unreadable: false, nested: false, unsupported: false },
  ],
  dirs: ['sub'],
};

let store: OperationStore & {
  records: Map<string, OperationRecord>;
  savedRecords: OperationRecord[];
};
let registry: OperationRegistry;
let globalStateMap: Map<string, unknown>;
let snapshotDir: string;
let labRoot: string;

/** 内存存储替身：记录每次 save 的完整形态（acknowledge 的 outcome 保留断言数据源）。 */
function makeMemoryStore(failingSave = false): OperationStore & {
  records: Map<string, OperationRecord>;
  savedRecords: OperationRecord[];
} {
  const records = new Map<string, OperationRecord>();
  const savedRecords: OperationRecord[] = [];
  return {
    records,
    savedRecords,
    load: () => [...records.values()],
    async save(record) {
      if (failingSave) {
        throw new Error('globalState 写入失败（模拟）');
      }
      records.set(record.operationId, record);
      savedRecords.push({ ...record });
    },
    async remove(operationId) {
      records.delete(operationId);
    },
  };
}

function baseInput(overrides: Partial<StartImportTaskInput> = {}): StartImportTaskInput {
  return {
    svnPath: 'svn',
    snapshotDir,
    sourceDir: SOURCE_DIR,
    targetUrl: TARGET_URL,
    parentIdentity: PARENT_IDENTITY,
    message: MESSAGE,
    nameMode: 'manual',
    snapshot: SNAPSHOT,
    entryKey: SOURCE_DIR,
    initiatorSessionId: 'initiator-1',
    formSnapshot: FORM,
    ...overrides,
  };
}

/** runOrThrow mock 的统一入口：记录调用参数并分发到用例 handler。 */
const runCalls: Array<{ args: string[]; options: RunOptions }> = [];
function mockRun(handler: (args: string[], options: RunOptions) => Promise<RunResult>): void {
  runCalls.length = 0;
  vi.mocked(runOrThrow).mockImplementation(async (_svnPath: string, args: string[], options: RunOptions = {}) => {
    runCalls.push({ args, options });
    return handler(args, options);
  });
}

const okRun = (stdout = ''): RunResult => ({ stdout, stderr: '', exitCode: 0 });

function svnError(args: string[], stderr: string, code?: string): SvnError {
  return new SvnError({ message: stderr.split('\n')[0] ?? stderr, command: args, stderr, code });
}

function authError(args: string[]): SvnError {
  return svnError(args, 'svn: E170001: Authorization failed', 'E170001');
}

/** 快照目录下的 op- 命名文件清单（无主文件断言）。 */
function snapshotFiles(): string[] {
  return existsSync(snapshotDir) ? readdirSync(snapshotDir).filter((name) => name.startsWith('op-')) : [];
}

const asUri = (fsPath: string): vscode.Uri => ({ fsPath }) as unknown as vscode.Uri;

/** 真实构造的快照（含真实 digest 输入形态）与夹具常量等价即可。 */
function realSnapshotOf(dir: string): ImportSnapshot {
  return enumerationToSnapshot(enumerateImportSource(dir));
}

/* --------------------------- 证据命令 XML 夹具 --------------------------- */

const RELATIVE_URL = '^/trunk/src';

function evidenceXml(rootAction: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<log>',
    '<logentry revision="5">',
    '<author>tester</author><date>2026-01-01T00:00:00.000000Z</date>',
    '<paths>',
    `<path action="${rootAction}" kind="dir">/trunk/src</path>`,
    '<path action="A" kind="file">/trunk/src/a.txt</path>',
    '<path action="A" kind="file">/trunk/src/sub/b.txt</path>',
    '</paths>',
    `<msg>${MESSAGE}</msg>`,
    '</logentry>',
    '</log>',
    '',
  ].join('\n');
}

/** 成功路径证据命令链（info relative-url + log）；import 分支经 onStdoutChunk 喂流式输出。 */
function mockEvidenceCommands(rootAction: string, importStdout = 'Adding  a.txt\nCommitted revision 5.\n'): void {
  mockRun(async (args, options) => {
    if (args[0] === 'import') {
      options.onStdoutChunk?.(Buffer.from(importStdout));
      return okRun(importStdout);
    }
    if (args[0] === 'info' && args[1] === '--show-item' && args[2] === 'relative-url') {
      return okRun(`${RELATIVE_URL}\n`);
    }
    if (args[0] === 'log') {
      return okRun(evidenceXml(rootAction));
    }
    throw new Error(`未预期的命令: ${args.join(' ')}`);
  });
}

/* --------------------------- unknown 记录与快照种子 --------------------------- */

/** 预置一条 unknown 的 import 记录 + 对应快照文件（verifyImport/acknowledge/abandon 的对象）。 */
async function seedUnknownRecord(options: { outcome?: 'merged'; writeSnapshot?: boolean } = {}): Promise<string> {
  mkdirSync(snapshotDir, { recursive: true });
  const begin = await registry.begin({
    wcRoot: SOURCE_DIR,
    targetRelPath: '.',
    nodeKind: 'dir',
    kind: 'import',
    lockKey: SOURCE_DIR,
    operationId: 'op-verify-1',
    targetPath: SOURCE_DIR,
    importIntent: {
      targetUrl: TARGET_URL,
      parentIdentity: PARENT_IDENTITY,
      message: MESSAGE,
      nameMode: 'manual',
      messageHash: messageDigest(MESSAGE),
      startedAt: 1,
      summary: { fileCount: 2, totalBytes: 30 },
      snapshotDigest: snapshotDigest(SNAPSHOT),
      fileRefs: 'op-verify-1',
    },
  });
  expect(begin.ok).toBe(true);
  await registry.markPhase('op-verify-1', 'running');
  const patch = options.outcome ? { outcome: options.outcome, resolvedRevision: 5 } : {};
  await registry.markPhase('op-verify-1', 'unknown', patch);
  if (options.writeSnapshot !== false) {
    writeFileSync(join(snapshotDir, 'op-verify-1'), serializeSnapshot(SNAPSHOT), 'utf8');
  }
  return 'op-verify-1';
}

beforeEach(() => {
  store = makeMemoryStore();
  registry = new OperationRegistry(store);
  setOperationRegistryForTest(registry);
  resetRunningOperationsForTest();
  resetTaskRegistry();
  resetSessionResults();
  resetResultEpochs();
  globalStateMap = new Map();
  setDraftStorage({
    get: <T>(key: string, defaultValue?: T) => (globalStateMap.has(key) ? globalStateMap.get(key) as T : defaultValue as T),
    update: async (key: string, value: unknown) => {
      if (value === undefined) {
        globalStateMap.delete(key);
      } else {
        globalStateMap.set(key, value);
      }
    },
  });
  labRoot = mkdtempSync(join(tmpdir(), 'svn-anywhere-importtask-'));
  snapshotDir = join(labRoot, 'storage');
  vi.mocked(runOrThrow).mockReset();
});

afterEach(() => {
  rmSync(labRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/* ------------------------ 快照落盘与预命令终止出口 ------------------------ */

describe('快照落盘时点与预命令终止出口', () => {
  it('成功路径：快照紧邻 begin 落盘（文件名即 operationId、无扩展名）、begin 沿用预生成 ID', async () => {
    mockEvidenceCommands('A');
    const input = baseInput();
    const outcome = await startImportTask(input).done;

    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('success');
    // 快照已随 done 收口删除。
    expect(snapshotFiles()).toHaveLength(0);
    // 记录 phase 序列：prepared → running → done。
    expect(store.savedRecords.map((record) => record.phase)).toEqual(['prepared', 'running', 'done']);
    // begin 沿用任务 ID（任务对象创建时预生成）。
    const prepared = store.savedRecords[0] as OperationRecord;
    expect(prepared.operationId).toMatch(/^op-[0-9a-z]+-[0-9a-z]+$/);
  });

  it('快照文件名与孤儿快照清理的识别形态一致（未终态保留、终态后清为孤儿）', async () => {
    mockRun(async (args) => {
      if (args[0] === 'import') {
        // exit 0 无尾行 → unknown（快照保留）。
        return okRun('Adding  a.txt\n');
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });
    const outcome = await startImportTask(baseInput()).done;
    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('unknown');
    // 快照保留且文件名可被孤儿清理识别。
    expect(snapshotFiles()).toHaveLength(1);
    const name = snapshotFiles()[0] as string;
    expect(name).toMatch(/^op-[0-9a-z]+-[0-9a-z]+$/);
    expect(JSON.parse(readFileSync(join(snapshotDir, name), 'utf8'))).toEqual(SNAPSHOT);
    // 未终态记录在 → 孤儿清理不删；按终态收口后 → 清理删除。
    const live = await registry.loadAllRecords();
    await cleanupOrphanSnapshots(asUri(snapshotDir));
    expect(existsSync(join(snapshotDir, name))).toBe(true);
    await registry.finalizeOperation(live[0]!.operationId, 'done');
    await cleanupOrphanSnapshots(asUri(snapshotDir));
    expect(existsSync(join(snapshotDir, name))).toBe(false);
  });

  it('快照写失败：不发起 begin、无记录残留、草稿写回、任务移除、无缓存', async () => {
    // 用一个已存在的文件路径充当目录：mkdir 抛 ENOTDIR → 写失败出口。
    const blocker = join(labRoot, 'blocker');
    writeFileSync(blocker, 'x');
    const onPreCommandExit = vi.fn();

    const outcome = await startImportTask(baseInput({
      snapshotDir: blocker,
      callbacks: { onPreCommandExit },
    })).done;

    expect(outcome).toEqual({
      outcome: 'preCommandExit',
      exit: { kind: 'snapshotWriteFailed', message: expect.any(String) },
    });
    expect(onPreCommandExit).toHaveBeenCalledTimes(1);
    expect(store.records.size).toBe(0);
    expect(getActiveTask('checkout')).toBeUndefined();
    expect(readSessionResult('checkout', { entryKey: SOURCE_DIR, mode: 'import' })).toBeUndefined();
    expect(readDraft(SOURCE_DIR, 'import')).toEqual(FORM);
  });

  it('begin busy：删快照 + 草稿写回 + 任务移除 + 无缓存；反复尝试不累积无主文件', async () => {
    // 预置同 lockKey 在途记录。
    const held = await registry.begin({
      wcRoot: SOURCE_DIR, targetRelPath: '.', nodeKind: 'dir', kind: 'commit',
    });
    expect(held.ok).toBe(true);
    if (held.ok) {
      await registry.markPhase(held.operationId, 'committing');
    }

    for (let i = 0; i < 3; i += 1) {
      const outcome = await startImportTask(baseInput()).done;
      expect(outcome).toEqual({
        outcome: 'preCommandExit',
        exit: { kind: 'beginBusy', heldBy: expect.objectContaining({ kind: 'commit', phase: 'committing' }) },
      });
    }
    // 「begin 的任何失败都删快照」：同源目录占用反复尝试不累积无主文件。
    expect(snapshotFiles()).toHaveLength(0);
    expect(getActiveTask('checkout')).toBeUndefined();
    expect(readSessionResult('checkout', { entryKey: SOURCE_DIR, mode: 'import' })).toBeUndefined();
    expect(readDraft(SOURCE_DIR, 'import')).toEqual(FORM);
  });

  it('前置可用性检查发现 ID 撞车 → 换 ID 重查（快照以新 ID 落盘、begin 通过）', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const randomSpy = vi.spyOn(Math, 'random');
    // 消费序：生成既有记录 ID（0.5）→ startImportTask 首次生成（0.5，撞车）→ 换 ID（0.7）。
    randomSpy.mockReturnValueOnce(0.5).mockReturnValueOnce(0.5).mockReturnValueOnce(0.7);
    const conflictId = randomOperationId();
    store.records.set(conflictId, {
      operationId: conflictId, wcRoot: '/other', targetRelPath: '.', nodeKind: 'dir',
      kind: 'import', phase: 'unknown', knownRevisions: [], updatedAt: 1,
    });

    mockEvidenceCommands('A');
    const outcome = await startImportTask(baseInput()).done;
    expect(outcome.outcome).toBe('finished');
    // 既有冲突记录不动；本次任务按新 ID 落盘并成功收口。
    expect([...store.records.keys()]).toEqual([conflictId]);
    expect(snapshotFiles()).toHaveLength(0);
    const prepared = store.savedRecords.find((record) => record.phase === 'prepared') as OperationRecord;
    expect(prepared.operationId).not.toBe(conflictId);
  });

  it('begin 侧 idConflict 防线：前置检查与 begin 校验之间的撞车 → 删快照出口收口', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    // 两次生成都消费同一 mock 值：既有记录 ID 与 startImportTask 预生成 ID 相同。
    const conflictId = randomOperationId();
    const intruder: OperationRecord = {
      operationId: conflictId, wcRoot: '/other', targetRelPath: '.', nodeKind: 'dir',
      kind: 'import', phase: 'unknown', knownRevisions: [], updatedAt: 1,
    };
    // 前置检查（load #1）无冲突、begin 校验（load #2）时出现同 ID 记录——
    // 前置检查与 begin 校验之间理论撞车窗口的防线。
    let loadCount = 0;
    const originalLoad = store.load.bind(store);
    store.load = async () => {
      loadCount += 1;
      const loaded = await originalLoad();
      return loadCount >= 2 ? [intruder, ...loaded] : loaded;
    };

    const outcome = await startImportTask(baseInput()).done;
    expect(outcome).toEqual({ outcome: 'preCommandExit', exit: { kind: 'beginIdConflict' } });
    // 删快照（本任务刚写入的那份，归属校验匹配即删除）+ 任务移除。
    expect(snapshotFiles()).toHaveLength(0);
    expect(getActiveTask('checkout')).toBeUndefined();
    expect(readSessionResult('checkout', { entryKey: SOURCE_DIR, mode: 'import' })).toBeUndefined();
  });

  it('begin 写盘失败：删快照、出口收口、无记录残留', async () => {
    const failing = makeMemoryStore(true);
    const failingRegistry = new OperationRegistry(failing);
    setOperationRegistryForTest(failingRegistry);

    const outcome = await startImportTask(baseInput()).done;
    expect(outcome.outcome).toBe('preCommandExit');
    if (outcome.outcome !== 'preCommandExit') {
      return;
    }
    expect(outcome.exit.kind).toBe('beginWriteFailed');
    expect(failing.records.size).toBe(0);
    expect(snapshotFiles()).toHaveLength(0);
    expect(getActiveTask('checkout')).toBeUndefined();
  });

  it('onParentIdentityConsumed 在 begin 成功后、紧邻命令发出前触发（begin 失败不触发）', async () => {
    const onParentIdentityConsumed = vi.fn();
    const importCalls = vi.fn(async () => okRun('Committed revision 5.\n'));
    mockRun(async (args) => {
      if (args[0] === 'import') {
        return importCalls();
      }
      if (args[0] === 'info' && args[1] === '--show-item') {
        return okRun(`${RELATIVE_URL}\n`);
      }
      if (args[0] === 'log') {
        return okRun(evidenceXml('A'));
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });
    const outcome = await startImportTask(baseInput({ callbacks: { onParentIdentityConsumed } })).done;
    expect(outcome.outcome).toBe('finished');
    expect(onParentIdentityConsumed).toHaveBeenCalledTimes(1);
    expect(importCalls).toHaveBeenCalledTimes(1);
  });
});

/* --------------------------- importIntent 落盘 --------------------------- */

describe('importIntent 全字段落盘（重启模拟读回）', () => {
  it('targetUrl/message/nameMode/messageHash/parentIdentity/summary/snapshotDigest/fileRefs 一次写入', async () => {
    mockRun(async (args) => {
      if (args[0] === 'import') {
        // 直接失败（可证明未提交）——记录随即收口删除，先在 savedRecords 断言。
        throw svnError(args, 'svn: E160020: File already exists', 'E160020');
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });
    const input = baseInput({ nameMode: 'auto', message: '说明原文\n第二行' });
    const outcome = await startImportTask(input).done;
    expect(outcome.outcome).toBe('finished');

    const prepared = store.savedRecords.find((record) => record.phase === 'prepared') as OperationRecord;
    expect(prepared.kind).toBe('import');
    expect(prepared.lockKey).toBe(SOURCE_DIR);
    expect(prepared.targetPath).toBe(SOURCE_DIR);
    expect(prepared.wcRoot).toBe(SOURCE_DIR);
    // 目标 URL 由 importIntent 唯一承载（顶层无冗余 url）。
    expect(prepared.url).toBeUndefined();
    const intent = prepared.importIntent!;
    expect(intent.targetUrl).toBe(input.targetUrl);
    expect(intent.message).toBe(input.message);
    expect(intent.nameMode).toBe('auto');
    expect(intent.messageHash).toBe(messageDigest(input.message));
    expect(intent.parentIdentity).toEqual(PARENT_IDENTITY);
    // summary 口径：file|symlink 且非 ignored（a.txt + sub/b.txt）。
    expect(intent.summary).toEqual({ fileCount: 2, totalBytes: 30 });
    expect(intent.fileRefs).toBe(prepared.operationId);
    expect(intent.snapshotDigest).toBe(snapshotDigest(SNAPSHOT));
    // 重启模拟：loadAllRecords 读回（终态收口前）——此处经 savedRecords 已覆盖。
  });
});

/* --------------------- 执行期认证：先补录、后查远端四态 --------------------- */

describe('执行期认证（§4.3 ② 四态）', () => {
  const AUTH_TARGET = 'http://svn.example.com/repo/trunk/src';

  function authImportMock(lsHandler: (args: string[]) => Promise<RunResult>) {
    return async (args: string[], options: RunOptions): Promise<RunResult> => {
      if (args[0] === 'ls' && args[1] === '--non-interactive') {
        return lsHandler(args);
      }
      if (args[0] === 'import') {
        if (options.getCredentials) {
          const cred = await options.getCredentials();
          if (!cred) {
            throw authError(args);
          }
          // 模拟 svnCli 带凭据重试成功（流式输出经 onStdoutChunk 喂入）。
          const stdout = 'Adding  a.txt\nCommitted revision 5.\n';
          options.onStdoutChunk?.(Buffer.from(stdout));
          return okRun(stdout);
        }
        throw authError(args);
      }
      if (args[0] === 'info' && args[1] === '--show-item') {
        return okRun(`${RELATIVE_URL}\n`);
      }
      if (args[0] === 'log') {
        return okRun(evidenceXml('A'));
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    };
  }

  it('E200009（目标不存在）→ 弹补录后带凭据重试一次成功', async () => {
    const prompt = vi.fn(async (): Promise<AuthCredentials> => ({ username: 'u', password: 'p' }));
    mockRun(authImportMock(async () => {
      throw svnError(['ls'], 'svn: E200009: URL \'http://svn.example.com/repo/trunk/src\' non-existent', 'E200009');
    }));

    const outcome = await startImportTask(baseInput({
      targetUrl: AUTH_TARGET,
      callbacks: { getCredentials: prompt },
    })).done;
    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('success');
    expect(prompt).toHaveBeenCalledTimes(1);
    // 探测 ls 显式带凭据、有界超时（≤120s、不继承 0）、不注入 getCredentials。
    const lsCall = runCalls.find(({ args }) => args[0] === 'ls');
    expect(lsCall?.args).toContain('--username');
    expect(lsCall?.options.timeoutMs).toBeLessThanOrEqual(120_000);
    expect(lsCall?.options.getCredentials).toBeUndefined();
  });

  it('目标已存在（ls 成功）→ 放弃重试按原错误抛出、出口⑦直接失败', async () => {
    const prompt = vi.fn(async (): Promise<AuthCredentials> => ({ username: 'u', password: 'p' }));
    mockRun(authImportMock(async () => okRun('')));

    const outcome = await startImportTask(baseInput({ targetUrl: AUTH_TARGET, callbacks: { getCredentials: prompt } })).done;
    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('failed');
    expect(outcome.result.detail).toContain('远端目标已存在');
    expect(outcome.result.formSnapshot).toEqual({ url: AUTH_TARGET, sourceDir: SOURCE_DIR, message: MESSAGE, nameMode: 'manual' });
    // 出口⑦：failed-unconfirmed 随即 finish 移除 + 快照删除。
    expect(await registry.loadAllRecords()).toHaveLength(0);
    expect(snapshotFiles()).toHaveLength(0);
  });

  it('ls 自身认证失败 → 放弃重试按认证失败处理（不误归目标已出现）', async () => {
    const prompt = vi.fn(async (): Promise<AuthCredentials> => ({ username: 'u', password: 'p' }));
    mockRun(authImportMock(async (args) => {
      throw authError(args);
    }));

    const outcome = await startImportTask(baseInput({ targetUrl: AUTH_TARGET, callbacks: { getCredentials: prompt } })).done;
    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('failed');
    expect(outcome.result.detail).toContain('凭据无法访问仓库');
    expect(await registry.loadAllRecords()).toHaveLength(0);
  });

  it('ls 其他失败（网络）→ 无法确认目标状态：出口⑦ + 「无法确认远端目标状态」提示', async () => {
    const prompt = vi.fn(async (): Promise<AuthCredentials> => ({ username: 'u', password: 'p' }));
    mockRun(authImportMock(async (args) => {
      throw svnError(args, 'svn: E175002: Network connection closed unexpectedly', 'E175002');
    }));

    const outcome = await startImportTask(baseInput({ targetUrl: AUTH_TARGET, callbacks: { getCredentials: prompt } })).done;
    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('failed');
    expect(outcome.result.detail).toContain('无法确认远端目标状态');
  });

  it('svn+ssh：不注入 getCredentials，认证类失败按可证明未提交直接失败', async () => {
    const prompt = vi.fn(async (): Promise<AuthCredentials> => ({ username: 'u', password: 'p' }));
    mockRun(async (args, options) => {
      if (args[0] === 'import') {
        expect(options.getCredentials).toBeUndefined();
        throw authError(args);
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });

    const outcome = await startImportTask(baseInput({
      targetUrl: 'svn+ssh://svn.example.com/repo/trunk/src',
      callbacks: { getCredentials: prompt },
    })).done;
    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('failed');
    expect(prompt).not.toHaveBeenCalled();
    expect(await registry.loadAllRecords()).toHaveLength(0);
  });
});

/* ------------------------ 成功路径证据检查三分类 ------------------------ */

describe('成功路径证据检查三分类', () => {
  it('① 目标根 action=A → done：finish 移除 + 快照删除 + 成功页 + onSucceeded', async () => {
    const onSucceeded = vi.fn();
    mockEvidenceCommands('A');

    const outcome = await startImportTask(baseInput({ callbacks: { onSucceeded } })).done;
    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('success');
    expect(outcome.result.revision).toBe(5);
    expect(outcome.result.evidence).toBe('command');
    expect(outcome.result.targetUrl).toBe(TARGET_URL);
    expect(onSucceeded).toHaveBeenCalledWith({ revision: 5, targetUrl: TARGET_URL });
    // 出口④：done 随即 finish 移除 + 快照删除。
    expect(await registry.loadAllRecords()).toHaveLength(0);
    expect(snapshotFiles()).toHaveLength(0);
    // 成功页写入会话缓存（executor 一律写入）。
    const cached = readSessionResult('checkout', { entryKey: SOURCE_DIR, mode: 'import' });
    expect(cached?.page).toEqual(outcome.result);
  });

  it('② 目标根非 A → unknown + outcome=merged/resolvedRevision 落盘（重启读回）、快照保留、merged 页', async () => {
    mockEvidenceCommands('M');

    const outcome = await startImportTask(baseInput()).done;
    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('merged');
    expect(outcome.result.revision).toBe(5);
    expect(outcome.result.detail).toContain('人工核对');
    // 未终态保留：记录 unknown ∧ outcome='merged' ∧ resolvedRevision=5。
    const records = await registry.loadAllRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.phase).toBe('unknown');
    expect(records[0]?.outcome).toBe('merged');
    expect(records[0]?.resolvedRevision).toBe(5);
    // 快照保留（核实与 acknowledge 收口的证据）。
    expect(snapshotFiles()).toHaveLength(1);
    // merged 页写缓存。
    const cached = readSessionResult('checkout', { entryKey: SOURCE_DIR, mode: 'import' });
    expect((cached?.page as { kind?: string })?.kind).toBe('merged');
  });

  it('③ 证据命令失败 → unknown 不写 outcome、普通 unknown 页「无法读取仓库证据」', async () => {
    mockRun(async (args, options) => {
      if (args[0] === 'import') {
        const stdout = 'Adding  a.txt\nCommitted revision 5.\n';
        options.onStdoutChunk?.(Buffer.from(stdout));
        return okRun(stdout);
      }
      if (args[0] === 'info' && args[1] === '--show-item') {
        throw svnError(args, 'svn: E175002: connection closed', 'E175002');
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });

    const outcome = await startImportTask(baseInput()).done;
    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('unknown');
    expect(outcome.result.detail).toContain('无法读取仓库证据');
    const records = await registry.loadAllRecords();
    expect(records[0]?.phase).toBe('unknown');
    expect(records[0]?.outcome).toBeUndefined();
    expect(records[0]?.resolvedRevision).toBeUndefined();
  });

  it('exit 0 但无 Committed revision 尾行 → unknown 冻结、不冒充成功', async () => {
    mockRun(async (args) => {
      if (args[0] === 'import') {
        return okRun('Adding  a.txt\n');
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });

    const outcome = await startImportTask(baseInput()).done;
    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('unknown');
    expect(outcome.result.resolution).toBe('unresolved');
    const records = await registry.loadAllRecords();
    expect(records[0]?.phase).toBe('unknown');
    // 无证据命令发出（未解析出 revision 即不走证据检查）。
    expect(runCalls.some(({ args }) => args[0] === 'log')).toBe(false);
  });
});

/* ------------------------ 直接失败与取消 ------------------------ */

describe('直接失败出口⑦与取消', () => {
  it('E160020 同名冲突：failed-unconfirmed + finish + 快照删除 + 失败页 formSnapshot', async () => {
    mockRun(async (args) => {
      if (args[0] === 'import') {
        throw svnError(args, 'svn: E160020: File already exists', 'E160020');
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });

    const outcome = await startImportTask(baseInput()).done;
    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('failed');
    expect(outcome.result.detail).toContain('E160020');
    expect(outcome.result.formSnapshot).toEqual({ url: TARGET_URL, sourceDir: SOURCE_DIR, message: MESSAGE, nameMode: 'manual' });
    expect(await registry.loadAllRecords()).toHaveLength(0);
    expect(snapshotFiles()).toHaveLength(0);
  });

  it('网络中断（不可证明）→ unknown 冻结（不冒充失败）', async () => {
    mockRun(async (args) => {
      if (args[0] === 'import') {
        throw svnError(args, 'svn: E175002: Network connection closed unexpectedly', 'E175002');
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });

    const outcome = await startImportTask(baseInput()).done;
    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('unknown');
    const records = await registry.loadAllRecords();
    expect(records[0]?.phase).toBe('unknown');
    expect(snapshotFiles()).toHaveLength(1);
  });

  it('取消（复用 cancelCheckoutTask）→ unknown 冻结', async () => {
    mockRun((args, options) => {
      if (args[0] === 'import') {
        return new Promise<RunResult>((_resolve, reject) => {
          options.onStdoutChunk?.(Buffer.from('Adding  a.txt\n'));
          options.signal?.addEventListener('abort', () => {
            reject(new SvnError({ message: 'svn import 已被取消', command: args, code: 'CANCELLED', stderr: '' }));
          }, { once: true });
        });
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });

    const started = startImportTask(baseInput());
    await vi.waitFor(() => expect(getTaskById(started.taskId)?.phase).toBe('running'));
    expect(cancelCheckoutTask(started.taskId)).toEqual({ ok: true });

    const outcome = await started.done;
    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('unknown');
    expect(outcome.result.detail).toContain('取消');
    expect(outcome.result.formSnapshot).toBeDefined();
    const records = await registry.loadAllRecords();
    expect(records[0]?.phase).toBe('unknown');
  });
});

/* --------------------------- 流式进度解析 --------------------------- */

describe('流式进度解析', () => {
  it('Adding 前缀计数、Committed revision 尾行捕获、未识别行进日志不计数', () => {
    const unknownLines: string[] = [];
    const parser = new ImportProgressParser(
      (text) => unknownLines.push(text),
      undefined,
    );
    parser.feed(Buffer.from('Adding  a.txt\n'));
    parser.feed(Buffer.from('Transmitting file data .done\n'));
    parser.feed(Buffer.from('Adding  sub\n'));
    parser.feed(Buffer.from('Committed revision 7.\n'));
    parser.finish();

    expect(parser.state.count).toBe(2);
    expect(parser.state.revision).toBe(7);
    expect(parser.state.currentFile).toBe('sub');
    expect(unknownLines).toEqual(['Transmitting file data .done']);
  });

  it('前缀为 ASCII 字节匹配；跨块行拼出完整行；残留尾段 finish 捕获', () => {
    const parser = new ImportProgressParser(() => {}, undefined);
    parser.feed(Buffer.from(`Adding  fi`));
    expect(parser.state.count).toBe(0);
    parser.feed(Buffer.from(`le.txt\nCommitted revision 3.`));
    expect(parser.state.count).toBe(1);
    expect(parser.state.currentFile).toBe('file.txt');
    expect(parser.state.revision).toBeNull();
    parser.finish();
    expect(parser.state.revision).toBe(3);
  });

  it('执行器接入 onStdoutChunk：进度回调收到计数与当前路径', async () => {
    const progress: Array<{ count: number; currentFile: string | null }> = [];
    mockRun(async (args, options) => {
      if (args[0] === 'import') {
        options.onStdoutChunk?.(Buffer.from('Adding  a.txt\n'));
        options.onStdoutChunk?.(Buffer.from('Adding  sub\nCommitted revision 5.\n'));
        return okRun('Committed revision 5.\n');
      }
      if (args[0] === 'info' && args[1] === '--show-item') {
        return okRun(`${RELATIVE_URL}\n`);
      }
      if (args[0] === 'log') {
        return okRun(evidenceXml('A'));
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });

    const outcome = await startImportTask(baseInput({
      callbacks: { onProgress: (state) => progress.push({ count: state.count, currentFile: state.currentFile }) },
    })).done;
    expect(outcome.outcome).toBe('finished');
    expect(progress.map((state) => state.count)).toEqual([1, 2]);
    expect(progress.at(-1)?.currentFile).toBe('sub');
    // 导入本体 timeoutMs=0、目标 URL 原样（不 peg 追加）。
    const importCall = runCalls.find(({ args }) => args[0] === 'import');
    expect(importCall?.options.timeoutMs).toBe(0);
    expect(importCall?.args).toContain(TARGET_URL);
    expect(importCall?.args.some((arg) => arg === `${TARGET_URL}@`)).toBe(false);
  });
});

/* --------------------------- verifyImport 三结论 --------------------------- */

/** verifyImport committed 链的只读命令 mock（ls 存在 → 父 info → R → relative-url → log）。 */
function mockVerifyCommitted(): void {
  mockRun(async (args) => {
    if (args[0] === 'ls') {
      return okRun('');
    }
    if (args[0] === 'info' && args[1] === '--xml') {
      return okRun([
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<info>',
        '<entry kind="dir" path="src" revision="9">',
        '<url>file:///tmp/repo/trunk</url>',
        '<repository><root>file:///tmp/repo</root><uuid>uuid-1</uuid></repository>',
        '<commit revision="2"><author>t</author><date>2026-01-01T00:00:00.000000Z</date></commit>',
        '</entry>',
        '</info>',
        '',
      ].join('\n'));
    }
    if (args[0] === 'info' && args[1] === '--show-item') {
      return okRun(args[2] === 'relative-url' ? `${RELATIVE_URL}\n` : '5\n');
    }
    if (args[0] === 'log') {
      return okRun(evidenceXml('A'));
    }
    throw new Error(`未预期的命令: ${args.join(' ')}`);
  });
}

describe('verifyImportTask（unknown 核实）', () => {
  it('committed：done + resolvedRevision 落盘 + finish 移除 + 快照删除 + onSucceeded', async () => {
    await seedUnknownRecord();
    mockVerifyCommitted();
    const onSucceeded = vi.fn();

    const result = await verifyImportTask({
      svnPath: 'svn',
      snapshotDir,
      operationId: 'op-verify-1',
      resultScope: { entryKey: SOURCE_DIR, mode: 'import' },
      epoch: 2,
      callbacks: { onSucceeded },
    });

    expect(result.conclusion).toBe('committed');
    if (result.conclusion !== 'committed') {
      return;
    }
    expect(result.revision).toBe(5);
    expect(result.recordSettled).toBe(true);
    expect(result.formSnapshot).toEqual({ url: TARGET_URL, sourceDir: SOURCE_DIR, message: MESSAGE, nameMode: 'manual' });
    expect(onSucceeded).toHaveBeenCalledWith({ revision: 5, targetUrl: TARGET_URL });
    // 出口⑤：done（resolvedRevision 落盘）→ finish 移除 + 快照删除。
    expect(await registry.loadAllRecords()).toHaveLength(0);
    const doneRecord = store.savedRecords.find((record) => record.phase === 'done');
    expect(doneRecord?.resolvedRevision).toBe(5);
    expect(snapshotFiles()).toHaveLength(0);
  });

  it('notCommitted：failed-unconfirmed + finish 移除 + 快照删除', async () => {
    await seedUnknownRecord();
    mockRun(async (args) => {
      if (args[0] === 'ls') {
        throw svnError(args, 'svn: E200009: URL non-existent', 'E200009');
      }
      if (args[0] === 'info' && args[1] === '--xml') {
        return okRun([
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<info>',
          '<entry kind="dir" path="trunk" revision="9">',
          '<url>file:///tmp/repo/trunk</url>',
          '<repository><root>file:///tmp/repo</root><uuid>uuid-1</uuid></repository>',
          '<commit revision="2"><author>t</author><date>2026-01-01T00:00:00.000000Z</date></commit>',
          '</entry>',
          '</info>',
          '',
        ].join('\n'));
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });

    const result = await verifyImportTask({
      svnPath: 'svn', snapshotDir, operationId: 'op-verify-1',
      resultScope: { entryKey: SOURCE_DIR, mode: 'import' }, epoch: 3,
    });

    expect(result.conclusion).toBe('notCommitted');
    expect(result.evidence).toEqual({ parentLastChangedRevision: 2 });
    expect(result.recordSettled).toBe(true);
    // 出口⑥：failed-unconfirmed 随即 finish 移除 + 快照删除。
    expect(await registry.loadAllRecords()).toHaveLength(0);
    expect(snapshotFiles()).toHaveLength(0);
  });

  it('unknown（快照缺失）→ 保持 unknown 不动记录、snapshotIncomplete 标志返回', async () => {
    await seedUnknownRecord({ writeSnapshot: false });

    const result = await verifyImportTask({
      svnPath: 'svn', snapshotDir, operationId: 'op-verify-1',
      resultScope: { entryKey: SOURCE_DIR, mode: 'import' }, epoch: 4,
    });

    expect(result.conclusion).toBe('unknown');
    expect(result.reason).toBe('snapshotIncomplete');
    expect(result.snapshotIncomplete).toBe(true);
    expect(result.recordSettled).toBe(false);
    // 记录保持 unknown（不动）、快照本就不存在。
    const records = await registry.loadAllRecords();
    expect(records[0]?.phase).toBe('unknown');
  });

  it('核实发起即登记只读命令进行中（scope/epoch 由调用方传入；结论返回前登记命中）', async () => {
    await seedUnknownRecord();
    const scope = { entryKey: SOURCE_DIR, mode: 'import' as const };
    // 慢 ls：核实进行中（数十秒命令链的最小化形态）验证登记与结论送达。
    let releaseLs: (() => void) | undefined;
    mockRun((args) => {
      if (args[0] === 'ls') {
        return new Promise<RunResult>((resolve) => {
          releaseLs = () => resolve(okRun(''));
        });
      }
      if (args[0] === 'info' && args[1] === '--xml') {
        return Promise.resolve(okRun([
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<info>',
          '<entry kind="dir" path="trunk" revision="9">',
          '<url>file:///tmp/repo/trunk</url>',
          '<repository><root>file:///tmp/repo</root><uuid>uuid-1</uuid></repository>',
          '<commit revision="2"><author>t</author><date>2026-01-01T00:00:00.000000Z</date></commit>',
          '</entry>',
          '</info>',
          '',
        ].join('\n')));
      }
      if (args[0] === 'info' && args[1] === '--show-item') {
        return Promise.resolve(okRun(args[2] === 'relative-url' ? `${RELATIVE_URL}\n` : '5\n'));
      }
      if (args[0] === 'log') {
        return Promise.resolve(okRun(evidenceXml('A')));
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });

    const promise = verifyImportTask({
      svnPath: 'svn', snapshotDir, operationId: 'op-verify-1',
      resultScope: scope, epoch: 5,
    });
    // 核实进行中：登记存在且 scope/epoch 匹配（「重开先于结论完成」的提示依据），
    // 且 ls 已挂起（命令链确实在途）后再释放。
    await vi.waitFor(() => {
      expect(matchReadonlyVerify('checkout', scope, 5)).toBe(true);
      expect(releaseLs).toBeDefined();
    });
    releaseLs?.();
    const result = await promise;
    expect(result.conclusion).toBe('committed');
    // 结论返回后登记的清除由控制器 settleReadonlyVerify 执行；本函数不越权。
  });

  it('记录已不可用（不存在）→ 结论 recordUnavailable、不执行收口', async () => {
    const result = await verifyImportTask({
      svnPath: 'svn', snapshotDir, operationId: 'op-gone',
      resultScope: { entryKey: SOURCE_DIR, mode: 'import' }, epoch: 7,
    });
    expect(result.conclusion).toBe('unknown');
    expect(result.reason).toBe('recordUnavailable');
    expect(result.recordSettled).toBe(false);
  });

  it('核实进行中记录已被 acknowledge 收口 → 校验不过跳过二次收口', async () => {
    await seedUnknownRecord({ outcome: 'merged' });
    mockVerifyCommitted();
    // 模拟冲突：核实命令返回前记录已被收口删除（findRecord 第 2 次读取）。
    const originalLoad = store.load.bind(store);
    let loadCount = 0;
    store.load = async () => {
      loadCount += 1;
      // 第 2 次起（记录收口校验）记录已被 acknowledge 收口删除。
      if (loadCount >= 2) {
        return [];
      }
      return originalLoad();
    };

    const result = await verifyImportTask({
      svnPath: 'svn', snapshotDir, operationId: 'op-verify-1',
      resultScope: { entryKey: SOURCE_DIR, mode: 'import' }, epoch: 8,
    });

    expect(result.conclusion).toBe('committed');
    expect(result.recordSettled).toBe(false);
  });
});

/* --------------------------- acknowledge / abandon --------------------------- */

describe('acknowledgeImportTask 与 abandonUnknownImportTask', () => {
  it('acknowledge：done 保留 outcome=merged/resolvedRevision 落盘 → finish 移除 + 快照删除', async () => {
    await seedUnknownRecord({ outcome: 'merged' });

    const result = await acknowledgeImportTask('op-verify-1', snapshotDir);
    expect(result).toEqual({ settled: true });
    // 记录移除；done 落盘时 outcome='merged' 与 resolvedRevision 随记录保留。
    expect(await registry.loadAllRecords()).toHaveLength(0);
    const doneRecord = store.savedRecords.find((record) => record.phase === 'done');
    expect(doneRecord?.outcome).toBe('merged');
    expect(doneRecord?.resolvedRevision).toBe(5);
    expect(snapshotFiles()).toHaveLength(0);
  });

  it('acknowledge：记录已收口/不存在 → settled=false 不再动作', async () => {
    expect(await acknowledgeImportTask('op-none', snapshotDir)).toEqual({ settled: false });
  });

  it('abandon：failed-unconfirmed（解除限制语义）+ finish 移除 + 快照删除', async () => {
    await seedUnknownRecord();

    const result = await abandonUnknownImportTask('op-verify-1', snapshotDir);
    expect(result).toEqual({ abandoned: true });
    const records = await registry.loadAllRecords();
    expect(records).toHaveLength(0);
    const abandoned = store.savedRecords.at(-1);
    expect(abandoned?.phase).toBe('failed-unconfirmed');
    expect(snapshotFiles()).toHaveLength(0);
  });

  it('abandon：记录已非 unknown → abandoned=false', async () => {
    await seedUnknownRecord();
    await registry.finalizeOperation('op-verify-1', 'done');
    rmSync(join(snapshotDir, 'op-verify-1'), { force: true });
    expect(await abandonUnknownImportTask('op-verify-1', snapshotDir)).toEqual({ abandoned: false });
  });
});

/* --------------------------- deleteImportSnapshot 归属校验 --------------------------- */

describe('deleteImportSnapshot 归属校验', () => {
  it('ownership 匹配才删除；不匹配（他人同 ID 文件）跳过；文件不存在静默 false', async () => {
    mkdirSync(snapshotDir, { recursive: true });
    const filePath = join(snapshotDir, 'op-own-1');
    writeFileSync(filePath, 'snap', 'utf8');
    const stats = statSync(filePath);

    expect(await deleteImportSnapshot('op-own-1', snapshotDir, { mtimeMs: stats.mtimeMs, size: stats.size })).toBe(true);
    expect(existsSync(filePath)).toBe(false);

    writeFileSync(filePath, 'other-owner', 'utf8');
    const stale = { mtimeMs: stats.mtimeMs, size: 999 };
    expect(await deleteImportSnapshot('op-own-1', snapshotDir, stale)).toBe(false);
    expect(existsSync(filePath)).toBe(true);
    // 无 ownership 的删除是幂等收口（文件不存在也视为已删）。
    expect(await deleteImportSnapshot('op-missing-1', snapshotDir)).toBe(true);
    expect(await deleteImportSnapshot('op-any', undefined)).toBe(false);
  });
});

/* --------------------------- 真实目录快照摘要口径 --------------------------- */

describe('快照摘要口径（与枚举器一致）', () => {
  it('summaryOfSnapshot 与 enumerateImportSource 的 fileCount/totalBytes 同口径', async () => {
    const dir = join(labRoot, 'src');
    const sub = join(dir, 'sub');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(dir, 'a.txt'), '12345'); // 5 字节
    writeFileSync(join(sub, 'b.txt'), '1234567890'); // 10 字节
    mockRun(async (args) => {
      if (args[0] === 'import') {
        throw svnError(args, 'svn: E160020: File already exists', 'E160020');
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });

    const snapshot = realSnapshotOf(dir);
    await startImportTask(baseInput({ sourceDir: dir, snapshot, entryKey: dir })).done;
    const prepared = store.savedRecords.find((record) => record.phase === 'prepared') as OperationRecord;
    expect(prepared.importIntent?.summary).toEqual({ fileCount: 2, totalBytes: 15 });
    expect(prepared.importIntent?.snapshotDigest).toBe(snapshotDigest(snapshot));
  });
});
