/**
 * 检出/续检任务执行器（checkoutTask）与 P3 草稿模块（drafts）测试：
 * mock vscode（输出频道/配置）与 core svn 命令层（runOrThrow/runStatus），
 * 经执行器 API 驱动完整状态机——
 * - 状态机全转移（connecting→running→success/canceled/failed）与终态结算
 *   顺序（缓存先写、任务后移除；记录 done→finish 移除 / residue-pending 保留）；
 * - 预命令终止出口（begin busy/idConflict/写失败、开始前目标重查失败）：
 *   草稿写回、任务移除、无缓存写入、记录收口；
 * - 流式进度解析（A 前缀计数、宽松解码、尾行、跨块行、未识别行进日志）；
 * - 执行期认证的半成品边界（目标空弹补录、已写入放弃、svn+ssh 不注入）；
 * - 取消竞态（canceling 禁重复取消、确认期间终态不回改）；
 * - 续检（beginResume busy/recordUnavailable、重核验失败 resumeBlocked、
 *   成功 finish、取消/失败回 residue-pending、formSnapshot 继承）；
 * - 草稿模块（键、覆盖、敏感 URL 双字段过滤、错误字段不持久化、清除）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SvnError } from '../src/core/errors';
import {
  OperationRegistry,
  randomOperationId,
  resetRunningOperationsForTest,
  setOperationRegistryForTest,
  type OperationRecord,
  type OperationStore,
} from '../src/core/operations';
import { runOrThrow, type AuthCredentials, type RunOptions, type RunResult } from '../src/core/svnCli';
import { runStatus } from '../src/core/status';
import {
  clearDraft,
  containsSensitiveUrl,
  draftKey,
  readDraft,
  saveDraft,
  setDraftStorage,
  type CheckoutFormDraft,
} from '../src/host/panel/drafts';
import {
  CHECKOUT_ENTRY_PREFIXES,
  CheckoutProgressParser,
  cancelCheckoutTask,
  recheckCheckoutTarget,
  resumeCheckoutTask,
  startCheckoutTask,
  verifyCheckoutOnly,
  type CheckoutTaskCallbacks,
  type StartCheckoutTaskInput,
} from '../src/host/panel/checkoutTask';
import { resetResultEpochs } from '../src/host/resultEpoch';
import {
  matchReadonlyVerify,
  readSessionResult,
  resetSessionResults,
} from '../src/host/sessionResults';
import {
  getActiveTask,
  getTaskById,
  onTaskRemoved,
  resetTaskRegistry,
} from '../src/host/taskRegistry';

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

vi.mock('../src/core/status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/status')>();
  return { ...actual, runStatus: vi.fn() };
});

/* ------------------------------ 测试夹具 ------------------------------ */

const IDENTITY = { repositoryUuid: 'uuid-1', repositoryRootUrl: 'file:///tmp/repo', relativeUrl: '^/trunk' };

const FORM: CheckoutFormDraft = {
  url: 'file:///tmp/repo/trunk',
  urlInput: 'file:///tmp/repo/trunk',
  nameMode: 'manual',
  parentDir: '/tmp/parent',
  dirName: 'trunk',
  directMode: false,
  directDir: '',
  revMode: 'number',
  rev: '5',
  depth: 'infinity',
  sourceDir: '',
  message: '',
};

let store: OperationStore & { records: Map<string, OperationRecord>; phases: string[] };
let registry: OperationRegistry;
let globalStateMap: Map<string, unknown>;
let labRoot: string;

/** 内存存储替身：记录 save 时的 phase 序列（终态收口顺序断言的数据源）。 */
function makeMemoryStore(failingSave = false): OperationStore & { records: Map<string, OperationRecord>; phases: string[] } {
  const records = new Map<string, OperationRecord>();
  const phases: string[] = [];
  return {
    records,
    phases,
    load: () => [...records.values()],
    async save(record) {
      if (failingSave) {
        throw new Error('globalState 写入失败（模拟）');
      }
      records.set(record.operationId, record);
      phases.push(record.phase);
    },
    async remove(operationId) {
      records.delete(operationId);
    },
  };
}

function baseInput(overrides: Partial<StartCheckoutTaskInput> = {}): StartCheckoutTaskInput {
  return {
    svnPath: 'svn',
    url: 'file:///tmp/repo/trunk',
    pinnedRevision: 5,
    depth: 'infinity',
    targetDir: join(labRoot, 'target'),
    parentDir: labRoot,
    dirName: 'target',
    directMode: false,
    directDir: '',
    identity: IDENTITY,
    entryKey: '/tmp/parent-real',
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

function authError(args: string[]): SvnError {
  return new SvnError({
    message: 'svn: E170001: Authorization failed',
    command: args,
    stderr: 'svn: E170001: Authorization failed',
    code: 'E170001',
  });
}

/** verifyResumable 的只读命令链 mock：info 文本 + 两个 --show-item。 */
function mockVerifyCommands(options: {
  uuid?: string;
  relativeUrl?: string;
  depth?: string;
  revision?: number;
} = {}): void {
  const uuid = options.uuid ?? IDENTITY.repositoryUuid;
  const relativeUrl = options.relativeUrl ?? IDENTITY.relativeUrl;
  const depth = options.depth ?? 'infinity';
  const revision = options.revision ?? 3;
  mockRun(async (args) => {
    if (args[0] === 'info' && args[1] === '--') {
      return okRun(
        `URL: file:///tmp/repo/trunk\nRepository UUID: ${uuid}\nRepository Root: ${IDENTITY.repositoryRootUrl}\nRevision: ${revision}\nNode Kind: directory\n`,
      );
    }
    if (args[0] === 'info' && args[1] === '--show-item') {
      return okRun(args[2] === 'relative-url' ? relativeUrl : depth);
    }
    throw new Error(`未预期的命令: ${args.join(' ')}`);
  });
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
  labRoot = mkdtempSync(join(tmpdir(), 'svn-anywhere-checkouttask-'));
  vi.mocked(runOrThrow).mockReset();
  vi.mocked(runStatus).mockReset();
});

afterEach(() => {
  rmSync(labRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/* ------------------------ 状态机与终态结算顺序 ------------------------ */

describe('检出任务状态机', () => {
  it('成功：connecting→running→success；记录 done→finish 移除；缓存先写、任务后移除', async () => {
    const phases: string[] = [];
    const removalSnapshots: boolean[] = [];
    onTaskRemoved('checkout', 'watcher-session', (removed) => {
      removalSnapshots.push(readSessionResult('checkout', removed.resultScope) !== undefined);
    });
    mockRun(async (args, options) => {
      if (args[0] === 'checkout') {
        options.onStdoutChunk?.(Buffer.from('A    /t/a.txt\nA    /t/sub\n'));
        options.onStdoutChunk?.(Buffer.from('Checked out revision 7.\n'));
        return okRun('A    /t/a.txt\nA    /t/sub\nChecked out revision 7.\n');
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });

    const started = startCheckoutTask(baseInput());
    // 发起即返回：任务在注册表、处于 connecting（后台推进中）。
    expect(getTaskById(started.taskId)).toBeDefined();
    const outcome = await started.done;

    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('success');
    expect(outcome.result.revision).toBe(7);
    // 终态即移除：任务不在注册表。
    expect(getTaskById(started.taskId)).toBeUndefined();
    expect(getActiveTask('checkout')).toBeUndefined();
    // 记录 done 后 finish 移除（store 无记录）。
    expect(await registry.loadAllRecords()).toHaveLength(0);
    // 结算顺序：任务移除通知回调时缓存已就绪（先写缓存、再移除任务）。
    expect(removalSnapshots).toEqual([true]);
    // 缓存页与结果页一致。
    const cached = readSessionResult('checkout', { entryKey: '/tmp/parent-real', mode: 'checkout' });
    expect(cached?.page).toEqual(outcome.result);
    // 记录 phase 序列：prepared → running → done（begin/命令发出/终态收口）。
    phases.push(...store.phases);
    expect(phases).toEqual(['prepared', 'running', 'done']);
  });

  it('取消：running→canceling→canceled；记录 residue-pending 保留；结果页含 formSnapshot', async () => {
    mockRun((args, options) => {
      if (args[0] === 'checkout') {
        return new Promise<RunResult>((_resolve, reject) => {
          options.onStdoutChunk?.(Buffer.from('A    /t/a.txt\n'));
          options.signal?.addEventListener('abort', () => {
            reject(new SvnError({ message: 'svn checkout 已被取消', command: args, code: 'CANCELLED', stderr: '' }));
          }, { once: true });
        });
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });

    const started = startCheckoutTask(baseInput());
    await vi.waitFor(() => expect(getTaskById(started.taskId)?.phase).toBe('running'));
    expect(cancelCheckoutTask(started.taskId)).toEqual({ ok: true });
    expect(getTaskById(started.taskId)?.phase).toBe('canceling');

    const outcome = await started.done;
    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('canceled');
    expect(outcome.result.formSnapshot).toEqual(FORM);
    // residue-pending 未终态保留（记录仍在，供核验/续检/放弃）。
    const records = await registry.loadAllRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.phase).toBe('residue-pending');
    expect(records[0]?.kind).toBe('checkout');
    const cached = readSessionResult('checkout', { entryKey: '/tmp/parent-real', mode: 'checkout' });
    expect((cached?.page as { kind?: string })?.kind).toBe('canceled');
  });

  it('失败：running→failed；记录 residue-pending；固定字段随 begin 落盘', async () => {
    mockRun(async (args) => {
      if (args[0] === 'checkout') {
        throw new SvnError({ message: 'svn: E000104: 无法连接', command: args, stderr: 'svn: E000104', code: 'E000104' });
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });

    const input = baseInput();
    const outcome = await startCheckoutTask(input).done;
    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('failed');
    expect(outcome.result.detail).toContain('E000104');
    const records = await registry.loadAllRecords();
    expect(records).toHaveLength(1);
    const record = records[0] as OperationRecord;
    expect(record.phase).toBe('residue-pending');
    // 固定字段经 begin 参数面一次写入（§2.2 接口增量）。
    expect(record.url).toBe(input.url);
    expect(record.targetPath).toBe(input.targetDir);
    expect(record.pinnedRevision).toBe(5);
    expect(record.depth).toBe('infinity');
    expect(record.repositoryUuid).toBe(IDENTITY.repositoryUuid);
    expect(record.repositoryRootUrl).toBe(IDENTITY.repositoryRootUrl);
    expect(record.relativeUrl).toBe(IDENTITY.relativeUrl);
    expect(record.lockKey).toBe(join(input.parentDir, input.dirName));
    expect(record.wcRoot).toBe(join(input.parentDir, input.dirName));
  });

  it('onIdentityConsumed 在重查通过、紧邻命令发出前触发（begin 失败不触发）', async () => {
    const onIdentityConsumed = vi.fn();
    const checkoutCalls = vi.fn(async () => okRun('Checked out revision 5.\n'));
    mockRun(async (args) => {
      if (args[0] === 'checkout') {
        return checkoutCalls();
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });
    const outcome = await startCheckoutTask(baseInput({ callbacks: { onIdentityConsumed } })).done;
    expect(outcome.outcome).toBe('finished');
    expect(onIdentityConsumed).toHaveBeenCalledTimes(1);
    // 命令发出（checkout mock 被调）说明清除发生在紧邻命令前且不阻断流程。
    expect(checkoutCalls).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------- 预命令终止出口 -------------------------- */

describe('预命令终止出口（统一收口 helper）', () => {
  it('begin busy：草稿写回全字段、任务移除、无缓存写入、不产生 result', async () => {
    // 预置同 lockKey 在途记录（M2 committing）。
    const held = await registry.begin({
      wcRoot: join(labRoot, 'target'), targetRelPath: '.', nodeKind: 'dir', kind: 'commit',
    });
    expect(held.ok).toBe(true);
    if (held.ok) {
      await registry.markPhase(held.operationId, 'committing');
    }

    const onPreCommandExit = vi.fn();
    const started = startCheckoutTask(baseInput({ callbacks: { onPreCommandExit } }));
    const outcome = await started.done;

    expect(outcome).toEqual({
      outcome: 'preCommandExit',
      exit: { kind: 'beginBusy', heldBy: expect.objectContaining({ kind: 'commit', phase: 'committing' }) },
    });
    expect(onPreCommandExit).toHaveBeenCalledTimes(1);
    // 任务已移除（busy 恢复假值）。
    expect(getActiveTask('checkout')).toBeUndefined();
    // 不写会话缓存。
    expect(readSessionResult('checkout', { entryKey: '/tmp/parent-real', mode: 'checkout' })).toBeUndefined();
    // 草稿已写回：formSnapshot 全字段（敏感过滤后原样保留）。
    expect(readDraft('/tmp/parent-real', 'checkout')).toEqual(FORM);
    // 预置记录不受影响。
    const records = await registry.loadAllRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.phase).toBe('committing');
  });

  it('begin idConflict：预生成 ID 与既有记录撞车 → 出口收口', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const conflictId = randomOperationId();
    store.records.set(conflictId, {
      operationId: conflictId, wcRoot: '/other', targetRelPath: '.', nodeKind: 'dir',
      kind: 'import', phase: 'unknown', knownRevisions: [], updatedAt: 1,
    });

    const outcome = await startCheckoutTask(baseInput()).done;
    expect(outcome).toEqual({ outcome: 'preCommandExit', exit: { kind: 'beginIdConflict' } });
    // 不写缓存、任务移除；既有记录不动。
    expect(readSessionResult('checkout', { entryKey: '/tmp/parent-real', mode: 'checkout' })).toBeUndefined();
    expect(getActiveTask('checkout')).toBeUndefined();
    expect([...store.records.keys()]).toEqual([conflictId]);
  });

  it('begin 写盘失败：store.save 抛错 → 出口收口、无记录残留', async () => {
    const failing = makeMemoryStore(true);
    const failingRegistry = new OperationRegistry(failing);
    setOperationRegistryForTest(failingRegistry);

    const outcome = await startCheckoutTask(baseInput()).done;
    expect(outcome.outcome).toBe('preCommandExit');
    if (outcome.outcome !== 'preCommandExit') {
      return;
    }
    expect(outcome.exit.kind).toBe('beginWriteFailed');
    expect(outcome.exit.kind === 'beginWriteFailed' && outcome.exit.message).toContain('globalState');
    expect(failing.records.size).toBe(0);
    expect(getActiveTask('checkout')).toBeUndefined();
    expect(readSessionResult('checkout', { entryKey: '/tmp/parent-real', mode: 'checkout' })).toBeUndefined();
  });

  it('开始前目标重查失败（目标非空）：记录 failed-unconfirmed+finish、草稿写回、无 result', async () => {
    const target = join(labRoot, 'target');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'existing.txt'), 'x');
    const onPreCommandExit = vi.fn();

    const outcome = await startCheckoutTask(baseInput({ callbacks: { onPreCommandExit } })).done;

    expect(outcome).toEqual({
      outcome: 'preCommandExit',
      exit: {
        kind: 'targetRecheckFailed',
        reason: 'targetNotEmpty',
        message: expect.stringContaining('不为空'),
      },
    });
    expect(onPreCommandExit).toHaveBeenCalledTimes(1);
    // 可证明零写入：failed-unconfirmed 随即 finish（记录移除，不残留占用）。
    expect(await registry.loadAllRecords()).toHaveLength(0);
    // 草稿写回 + 不写缓存。
    expect(readDraft('/tmp/parent-real', 'checkout')).toEqual(FORM);
    expect(readSessionResult('checkout', { entryKey: '/tmp/parent-real', mode: 'checkout' })).toBeUndefined();
  });

  it('开始前目标重查失败（嵌套副本：父目录是工作副本）', async () => {
    mkdirSync(join(labRoot, '.svn'), { recursive: true });
    writeFileSync(join(labRoot, '.svn', 'wc.db'), 'fake');
    // 目标不存在，但父目录向上找到工作副本 → 拒绝嵌套。
    const outcome = await startCheckoutTask(baseInput()).done;
    expect(outcome.outcome).toBe('preCommandExit');
    if (outcome.outcome !== 'preCommandExit') {
      return;
    }
    expect(outcome.exit.kind).toBe('targetRecheckFailed');
    expect(outcome.exit.kind === 'targetRecheckFailed' && outcome.exit.reason).toBe('nestedWorkingCopy');
    expect(await registry.loadAllRecords()).toHaveLength(0);
  });

  it('开始前目标重查失败（目标已含 .svn）', async () => {
    const target = join(labRoot, 'target');
    mkdirSync(join(target, '.svn'), { recursive: true });
    const outcome = await startCheckoutTask(baseInput()).done;
    expect(outcome.outcome).toBe('preCommandExit');
    if (outcome.outcome !== 'preCommandExit') {
      return;
    }
    expect(outcome.exit.kind === 'targetRecheckFailed' && outcome.exit.reason).toBe('targetHasMetadata');
  });

  it('recheckCheckoutTarget：目标不存在或空目录放行', () => {
    expect(recheckCheckoutTarget(join(labRoot, 'not-exist'))).toEqual({ ok: true });
    const empty = join(labRoot, 'empty');
    mkdirSync(empty, { recursive: true });
    expect(recheckCheckoutTarget(empty)).toEqual({ ok: true });
  });
});

/* ------------------------------ 流式进度 ------------------------------ */

describe('流式进度解析', () => {
  it('A 前缀计数、当前文件名宽松解码、Checked out 尾行、未识别行进日志不计数', () => {
    const unknownLines: string[] = [];
    const progressStates: Array<{ count: number; currentFile: string | null }> = [];
    const parser = new CheckoutProgressParser(
      CHECKOUT_ENTRY_PREFIXES,
      (text) => unknownLines.push(text),
      (state) => progressStates.push({ ...state }),
    );
    // GBK 字节名（「中文.txt」的 GBK 编码）：宽松解码出现替换符、计数不受影响。
    const gbkName = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x2e, 0x74, 0x78, 0x74]);
    parser.feed(Buffer.concat([Buffer.from('A    /t/'), gbkName, Buffer.from('\n')]));
    parser.feed(Buffer.from('Fetching external…\n'));
    parser.feed(Buffer.from('A    /t/sub\n'));
    parser.feed(Buffer.from('Checked out revision 4.\n'));
    parser.finish();

    expect(parser.state.count).toBe(2);
    expect(parser.state.revision).toBe(4);
    expect(parser.state.currentFile).toBe('/t/sub');
    // 未识别行不计数、进日志回调。
    expect(unknownLines).toEqual(['Fetching external…']);
    // 首个条目的当前文件名含替换符（GBK 宽松解码乱码可接受）。
    expect(progressStates[0]?.currentFile).toContain('\uFFFD');
  });

  it('跨块行：一行输出被拆成多块时字节层行缓冲拼出完整行', () => {
    const parser = new CheckoutProgressParser(CHECKOUT_ENTRY_PREFIXES, () => {}, () => {});
    parser.feed(Buffer.from('A    /t/fi'));
    expect(parser.state.count).toBe(0);
    parser.feed(Buffer.from('le.txt\nChecked out revision 2.'));
    expect(parser.state.count).toBe(1);
    expect(parser.state.currentFile).toBe('/t/file.txt');
    expect(parser.state.revision).toBeNull();
    // 残留尾段无换行：finish 后捕获尾行 revision。
    parser.finish();
    expect(parser.state.revision).toBe(2);
  });

  it('执行器接入 onStdoutChunk：进度回调收到计数与当前文件名', async () => {
    const progressStates: Array<{ count: number; currentFile: string | null }> = [];
    mockRun(async (args, options) => {
      if (args[0] === 'checkout') {
        options.onStdoutChunk?.(Buffer.from('A    /t/one.txt\n'));
        options.onStdoutChunk?.(Buffer.from('A    /t/two.txt\nA    /t/three.txt\nChecked out revision 5.\n'));
        return okRun();
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });
    const callbacks: CheckoutTaskCallbacks = {
      onProgress: (state) => progressStates.push({ count: state.count, currentFile: state.currentFile }),
    };
    const outcome = await startCheckoutTask(baseInput({ callbacks })).done;
    expect(outcome.outcome).toBe('finished');
    expect(progressStates.map((s) => s.count)).toEqual([1, 2, 3]);
    expect(progressStates.at(-1)?.currentFile).toBe('/t/three.txt');
  });
});

/* --------------------- 执行期认证与半成品边界 --------------------- */

describe('执行期认证（scheme 分支与半成品边界）', () => {
  it('http + 目标空：弹窗补录重试成功', async () => {
    const prompt = vi.fn(async (): Promise<AuthCredentials> => ({ username: 'u', password: 'p' }));
    const firstCallArgs: string[][] = [];
    let retried = false;
    mockRun(async (args, options) => {
      if (args[0] === 'checkout') {
        if (!retried) {
          retried = true;
          firstCallArgs.push(args);
          // 模拟 runOrThrowWithRunner 的认证重试判定：认证失败 → 调注入的
          // getCredentials → 有凭据则带凭据重试一次。
          if (options.getCredentials) {
            const cred = await options.getCredentials();
            if (!cred) {
              throw authError(args);
            }
            return okRun('Checked out revision 5.\n');
          }
          throw authError(args);
        }
        return okRun();
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });

    const outcome = await startCheckoutTask(baseInput({
      url: 'http://svn.example.com/repo/trunk',
      callbacks: { getCredentials: prompt },
    })).done;

    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('success');
    // 弹窗补录被调（包装回调透传——目标仍为空、无 .svn）。
    expect(prompt).toHaveBeenCalledTimes(1);
    // 注入的回调存在（svn+ssh/file 分支才会是 undefined）。
    expect(runCalls[0]?.options.getCredentials).toBeInstanceOf(Function);
  });

  it('http + 目标已写入半成品：不弹补录、返回空值放弃重试，按失败落 residue-pending', async () => {
    const prompt = vi.fn(async (): Promise<AuthCredentials> => ({ username: 'u', password: 'p' }));
    const target = join(labRoot, 'target');
    let firstFired = false;
    mockRun(async (args, options) => {
      if (args[0] === 'checkout') {
        if (!firstFired) {
          firstFired = true;
          // 首次执行已向目标写出半成品（认证失败发生在传输开始后的形态）。
          mkdirSync(target, { recursive: true });
          writeFileSync(join(target, 'half.txt'), 'x');
          if (options.getCredentials) {
            const cred = await options.getCredentials();
            if (!cred) {
              throw authError(args);
            }
          }
          throw authError(args);
        }
        throw new Error('不应发生重试');
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });

    const input = baseInput({ url: 'http://svn.example.com/repo/trunk', callbacks: { getCredentials: prompt } });
    const outcome = await startCheckoutTask(input).done;

    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('failed');
    // 半成品边界：包装回调发现目标已写入 → 返回空值，弹窗未弹。
    expect(prompt).not.toHaveBeenCalled();
    const records = await registry.loadAllRecords();
    expect(records[0]?.phase).toBe('residue-pending');
  });

  it('svn+ssh：不注入 getCredentials，认证类失败按普通失败呈现', async () => {
    mockRun(async (args, options) => {
      if (args[0] === 'checkout') {
        // svn+ssh 分支：执行器不应注入凭据回调（注入了这里直接失败暴露）。
        expect(options.getCredentials).toBeUndefined();
        throw authError(args);
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });

    const prompt = vi.fn(async (): Promise<AuthCredentials> => ({ username: 'u', password: 'p' }));
    const outcome = await startCheckoutTask(baseInput({
      url: 'svn+ssh://svn.example.com/repo/trunk',
      callbacks: { getCredentials: prompt },
    })).done;

    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('failed');
    expect(prompt).not.toHaveBeenCalled();
  });
});

/* ----------------------------- 取消竞态 ----------------------------- */

describe('取消竞态', () => {
  it('canceling 期间再次取消被拒绝', async () => {
    let releaseCancel: (() => void) | undefined;
    mockRun((args, options) => {
      if (args[0] === 'checkout') {
        return new Promise<RunResult>((_resolve, reject) => {
          options.onStdoutChunk?.(Buffer.from('A    /t/a.txt\n'));
          releaseCancel = () => {
            reject(new SvnError({ message: 'svn checkout 已被取消', command: args, code: 'CANCELLED', stderr: '' }));
          };
        });
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });
    const started = startCheckoutTask(baseInput());
    await vi.waitFor(() => expect(getTaskById(started.taskId)?.phase).toBe('running'));
    expect(cancelCheckoutTask(started.taskId)).toEqual({ ok: true });
    expect(cancelCheckoutTask(started.taskId)).toEqual({ ok: false, reason: 'notRunning', phase: 'canceling' });
    // 收尾：让后台流程结算（abort 不接线的形态，手动释放）。
    releaseCancel?.();
    const outcome = await started.done;
    expect(outcome.outcome).toBe('finished');
  });

  it('取消请求发出后任务自然成功：终态不被回改为 canceled', async () => {
    let resolveNatural: (() => void) | undefined;
    mockRun((args, options) => {
      if (args[0] === 'checkout') {
        return new Promise<RunResult>((resolve) => {
          resolveNatural = () => {
            options.onStdoutChunk?.(Buffer.from('Checked out revision 9.\n'));
            resolve(okRun('Checked out revision 9.\n'));
          };
        });
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });
    const started = startCheckoutTask(baseInput());
    await vi.waitFor(() => expect(getTaskById(started.taskId)?.phase).toBe('running'));
    expect(cancelCheckoutTask(started.taskId)).toEqual({ ok: true });
    resolveNatural?.();
    const outcome = await started.done;
    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('success');
    expect(outcome.result.revision).toBe(9);
    // 终态（任务已移除）后再取消：missing，不回改。
    expect(cancelCheckoutTask(started.taskId)).toEqual({ ok: false, reason: 'missing' });
  });

  it('connecting 窗口（命令未发出）取消被拒绝', async () => {
    // begin 挂起：任务停在 connecting。
    const slowStore = makeMemoryStore();
    const originalSave = slowStore.save.bind(slowStore);
    slowStore.save = async (record: OperationRecord) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return originalSave(record);
    };
    setOperationRegistryForTest(new OperationRegistry(slowStore));
    mockRun(async () => okRun());

    const started = startCheckoutTask(baseInput());
    expect(getTaskById(started.taskId)?.phase).toBe('connecting');
    expect(cancelCheckoutTask(started.taskId)).toEqual({ ok: false, reason: 'notRunning', phase: 'connecting' });
    const outcome = await started.done;
    expect(outcome.outcome).toBe('finished');
  });
});

/* ------------------------------- 续检 ------------------------------- */

/** 预置一条 residue-pending 的 checkout 记录（续检对象）。 */
async function seedResidueRecord(): Promise<string> {
  const lockKey = join(labRoot, 'target');
  const begin = await registry.begin({
    wcRoot: lockKey, targetRelPath: '.', nodeKind: 'dir', kind: 'checkout', lockKey,
    operationId: 'op-resume-1', url: 'file:///tmp/repo/trunk', targetPath: join(labRoot, 'target'),
    pinnedRevision: 5, depth: 'infinity',
    repositoryUuid: IDENTITY.repositoryUuid,
    repositoryRootUrl: IDENTITY.repositoryRootUrl,
    relativeUrl: IDENTITY.relativeUrl,
  });
  expect(begin.ok).toBe(true);
  await registry.markPhase('op-resume-1', 'residue-pending');
  return 'op-resume-1';
}

describe('续检（resumeCheckoutTask）', () => {
  it('beginResume busy：同 lockKey 他人 committing 记录占用 → 返回占用构造数据、不改相位', async () => {
    // 续检对象（residue-pending）+ 同 lockKey 他人 committing 记录叠加。
    await seedResidueRecord();
    const lockKey = join(labRoot, 'target');
    const held = await registry.begin({
      wcRoot: lockKey, targetRelPath: '.', nodeKind: 'dir', kind: 'commit',
    });
    expect(held.ok).toBe(true);
    if (held.ok) {
      await registry.markPhase(held.operationId, 'committing');
    }

    const result = await resumeCheckoutTask({
      svnPath: 'svn', operationId: 'op-resume-1', lockKey, targetDir: join(labRoot, 'target'),
      url: 'file:///tmp/repo/trunk', pinnedRevision: 5, depth: 'infinity', identity: IDENTITY,
      entryKey: '/tmp/parent-real', formSnapshot: FORM, initiatorSessionId: 'initiator-1',
    });

    expect(result).toEqual({
      ok: false,
      reason: 'busy',
      heldBy: expect.objectContaining({ kind: 'commit', phase: 'committing' }),
    });
    expect(getActiveTask('checkout')).toBeUndefined();
  });

  it('beginResume recordUnavailable：记录不存在 → 返回供面板提示', async () => {
    const result = await resumeCheckoutTask({
      svnPath: 'svn', operationId: 'op-no-such', lockKey: join(labRoot, 'target'),
      targetDir: join(labRoot, 'target'), url: 'file:///tmp/repo/trunk',
      pinnedRevision: 5, depth: 'infinity', identity: IDENTITY,
      entryKey: '/tmp/parent-real', initiatorSessionId: 'initiator-1',
    });
    expect(result).toEqual({ ok: false, reason: 'recordUnavailable' });
  });

  it('执行前重核验失败：resumeBlocked 写缓存、任务移除、记录回 residue-pending、无任务终态 result', async () => {
    await seedResidueRecord();
    // 核验链的 info/show-item 通过、status 失败 → 保守 resumeBlocked。
    mockVerifyCommands();
    vi.mocked(runStatus).mockRejectedValue(new Error('svn: E155004: working copy locked'));

    const result = await resumeCheckoutTask({
      svnPath: 'svn', operationId: 'op-resume-1', lockKey: join(labRoot, 'target'),
      targetDir: join(labRoot, 'target'), url: 'file:///tmp/repo/trunk',
      pinnedRevision: 5, depth: 'infinity', identity: IDENTITY,
      entryKey: '/tmp/parent-real', formSnapshot: FORM, initiatorSessionId: 'initiator-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const outcome = await result.done;
    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    // resumeBlocked（非任务终态 result：success/canceled/failed 不发生）。
    expect(outcome.result.kind).toBe('resumeBlocked');
    expect(outcome.result.verify?.kind).toBe('resumeBlocked');
    expect(outcome.result.verify?.blockReason).toBe('statusFailed');
    expect(outcome.result.formSnapshot).toEqual(FORM);
    // 记录回 residue-pending（未终态保留）。
    const records = await registry.loadAllRecords();
    expect(records[0]?.phase).toBe('residue-pending');
    // 任务移除；缓存镜像为 resumeBlocked 页。
    expect(getActiveTask('checkout')).toBeUndefined();
    const cached = readSessionResult('checkout', { entryKey: '/tmp/parent-real', mode: 'checkout' });
    expect((cached?.page as { kind?: string })?.kind).toBe('resumeBlocked');
    // 不发写命令（cleanup/update 未被调用）。
    expect(runCalls.filter(({ args }) => args[0] === 'cleanup' || args[0] === 'update')).toHaveLength(0);
  });

  it('成功链路：核验通过 → cleanup + update --set-depth → done + finish 移除', async () => {
    await seedResidueRecord();
    mockVerifyCommands();
    vi.mocked(runStatus).mockResolvedValue({ targetPath: '.', entries: [], externals: [] });
    mockRun(async (args, options) => {
      if (args[0] === 'info' && args[1] === '--') {
        return okRun(
          'URL: file:///tmp/repo/trunk\nRepository UUID: uuid-1\nRepository Root: file:///tmp/repo\nRevision: 3\nNode Kind: directory\n',
        );
      }
      if (args[0] === 'info' && args[1] === '--show-item') {
        return okRun(args[2] === 'relative-url' ? '^/trunk' : 'infinity');
      }
      if (args[0] === 'cleanup') {
        return okRun();
      }
      if (args[0] === 'update') {
        options.onStdoutChunk?.(Buffer.from('U    target/a.txt\nUpdated to revision 5.\n'));
        return okRun('U    target/a.txt\nUpdated to revision 5.\n');
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });

    const result = await resumeCheckoutTask({
      svnPath: 'svn', operationId: 'op-resume-1', lockKey: join(labRoot, 'target'),
      targetDir: join(labRoot, 'target'), url: 'file:///tmp/repo/trunk',
      pinnedRevision: 5, depth: 'infinity', identity: IDENTITY,
      entryKey: '/tmp/parent-real', formSnapshot: FORM, initiatorSessionId: 'initiator-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const outcome = await result.done;
    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('success');
    expect(outcome.result.revision).toBe(5);
    // 续检命令形态：cleanup 与 update -r pinned --set-depth。
    const cleanupCall = runCalls.find(({ args }) => args[0] === 'cleanup');
    const updateCall = runCalls.find(({ args }) => args[0] === 'update');
    expect(cleanupCall?.args.slice(0, 2)).toEqual(['cleanup', join(labRoot, 'target')]);
    expect(updateCall?.args.slice(0, 6)).toEqual([
      'update', '--non-interactive', '-r', '5', '--set-depth', 'infinity',
    ]);
    // 记录 finish 移除；都 timeoutMs=0。
    expect(await registry.loadAllRecords()).toHaveLength(0);
    expect(cleanupCall?.options.timeoutMs).toBe(0);
    expect(updateCall?.options.timeoutMs).toBe(0);
  });

  it('取消/失败回 residue-pending；续检认证豁免零写入前置（回调直接透传）', async () => {
    await seedResidueRecord();
    // 核验通过；update 抛认证失败且凭据补录返回 undefined（用户取消补录）。
    const prompt = vi.fn(async (): Promise<AuthCredentials | undefined> => undefined);
    mockRun(async (args, options) => {
      if (args[0] === 'info') {
        if (args[1] === '--show-item') {
          return okRun(args[2] === 'relative-url' ? '^/trunk' : 'infinity');
        }
        return okRun(
          'URL: file:///tmp/repo/trunk\nRepository UUID: uuid-1\nRepository Root: file:///tmp/repo\nRevision: 3\nNode Kind: directory\n',
        );
      }
      if (args[0] === 'cleanup') {
        return okRun();
      }
      if (args[0] === 'update') {
        // 续检豁免：即便目标已含内容（update 目标必含 .svn），回调仍透传弹窗。
        mkdirSync(join(labRoot, 'target', '.svn'), { recursive: true });
        if (options.getCredentials) {
          const cred = await options.getCredentials();
          if (!cred) {
            throw authError(args);
          }
        }
        throw authError(args);
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });
    vi.mocked(runStatus).mockResolvedValue({ targetPath: '.', entries: [], externals: [] });

    const result = await resumeCheckoutTask({
      svnPath: 'svn', operationId: 'op-resume-1', lockKey: join(labRoot, 'target'),
      targetDir: join(labRoot, 'target'), url: 'http://svn.example.com/repo/trunk',
      pinnedRevision: 5, depth: 'infinity', identity: IDENTITY,
      entryKey: '/tmp/parent-real', formSnapshot: FORM, initiatorSessionId: 'initiator-1',
      callbacks: { getCredentials: prompt },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const outcome = await result.done;
    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('failed');
    // 弹窗被调（零写入前置豁免：目标含 .svn 仍弹）。
    expect(prompt).toHaveBeenCalledTimes(1);
    const records = await registry.loadAllRecords();
    expect(records[0]?.phase).toBe('residue-pending');
  });

  it('取消：cleanup/update 执行中取消 → canceled 回 residue-pending', async () => {
    await seedResidueRecord();
    vi.mocked(runStatus).mockResolvedValue({ targetPath: '.', entries: [], externals: [] });
    mockRun((args, options) => {
      if (args[0] === 'info' && args[1] === '--') {
        return Promise.resolve(okRun(
          'URL: file:///tmp/repo/trunk\nRepository UUID: uuid-1\nRepository Root: file:///tmp/repo\nRevision: 3\nNode Kind: directory\n',
        ));
      }
      if (args[0] === 'info' && args[1] === '--show-item') {
        return Promise.resolve(okRun(args[2] === 'relative-url' ? '^/trunk' : 'infinity'));
      }
      if (args[0] === 'cleanup') {
        return Promise.resolve(okRun());
      }
      if (args[0] === 'update') {
        return new Promise<RunResult>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            reject(new SvnError({ message: 'svn update 已被取消', command: args, code: 'CANCELLED', stderr: '' }));
          }, { once: true });
        });
      }
      throw new Error(`未预期的命令: ${args.join(' ')}`);
    });

    const result = await resumeCheckoutTask({
      svnPath: 'svn', operationId: 'op-resume-1', lockKey: join(labRoot, 'target'),
      targetDir: join(labRoot, 'target'), url: 'file:///tmp/repo/trunk',
      pinnedRevision: 5, depth: 'infinity', identity: IDENTITY,
      entryKey: '/tmp/parent-real', formSnapshot: FORM, initiatorSessionId: 'initiator-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    await vi.waitFor(() => expect(getTaskById('op-resume-1')?.phase).toBe('running'));
    expect(cancelCheckoutTask('op-resume-1')).toEqual({ ok: true });
    const outcome = await result.done;
    expect(outcome.outcome).toBe('finished');
    if (outcome.outcome !== 'finished') {
      return;
    }
    expect(outcome.result.kind).toBe('canceled');
    expect(outcome.result.formSnapshot).toEqual(FORM);
    const records = await registry.loadAllRecords();
    expect(records[0]?.phase).toBe('residue-pending');
  });
});

/* --------------------------- 只读核验 --------------------------- */

describe('verifyCheckoutOnly（只读核验链）', () => {
  it('登记只读命令进行中、返回报告、不改记录（保持 residue-pending）', async () => {
    await seedResidueRecord();
    mockVerifyCommands();
    vi.mocked(runStatus).mockResolvedValue({
      targetPath: '.', entries: [{ path: 'a.txt', wcStatus: 'modified', props: 'none', changelist: null }], externals: [],
    });

    const scope = { entryKey: '/tmp/parent-real', mode: 'checkout' as const };
    const report = await verifyCheckoutOnly({
      svnPath: 'svn',
      targetDir: join(labRoot, 'target'),
      expectation: {
        repositoryUuid: IDENTITY.repositoryUuid,
        repositoryRootUrl: IDENTITY.repositoryRootUrl,
        relativeUrl: IDENTITY.relativeUrl,
        depth: 'infinity',
        pinnedRevision: 5,
      },
      resultScope: scope,
      epoch: 3,
    });

    expect(report.kind).toBe('resumable');
    expect(report.status?.entries[0]?.path).toBe('a.txt');
    // 发起即登记（resultScope/epoch 由调用方传入）。
    expect(matchReadonlyVerify('checkout', scope, 3)).toBe(true);
    // 核验不改记录。
    const records = await registry.loadAllRecords();
    expect(records[0]?.phase).toBe('residue-pending');
  });
});

/* --------------------------- P3 草稿模块 --------------------------- */

describe('P3 草稿模块（drafts）', () => {
  it('键形态对齐 P2 命名风格；同入口键单份覆盖', () => {
    expect(draftKey('/tmp/parent-real', 'checkout')).toBe('checkoutPanel.draft|/tmp/parent-real|checkout');
    expect(draftKey('/tmp/src', 'import')).toBe('checkoutPanel.draft|/tmp/src|import');
    saveDraft('/tmp/parent-real', 'checkout', { ...FORM, dirName: 'first' });
    saveDraft('/tmp/parent-real', 'checkout', { ...FORM, dirName: 'second' });
    expect(readDraft('/tmp/parent-real', 'checkout')?.dirName).toBe('second');
    // 导入与检出键不串。
    saveDraft('/tmp/parent-real', 'import', { ...FORM, sourceDir: '/tmp/src' });
    expect(readDraft('/tmp/parent-real', 'checkout')?.sourceDir).toBe('');
    expect(readDraft('/tmp/parent-real', 'import')?.sourceDir).toBe('/tmp/src');
  });

  it('敏感 URL 双字段过滤：user:pass@/user@/?/# 清空后持久化、其余字段保留', () => {
    saveDraft('/k', 'checkout', {
      ...FORM,
      url: 'svn://user:pass@host/repo/trunk',
      urlInput: 'http://user@host/repo/trunk',
    });
    const saved = readDraft('/k', 'checkout');
    expect(saved?.url).toBe('');
    expect(saved?.urlInput).toBe('');
    // 其余字段原样。
    expect(saved?.nameMode).toBe('manual');
    expect(saved?.dirName).toBe('trunk');
    expect(saved?.rev).toBe('5');

    saveDraft('/k2', 'checkout', { ...FORM, url: 'http://h/repo?a=1', urlInput: 'http://h/repo#frag' });
    const saved2 = readDraft('/k2', 'checkout');
    expect(saved2?.url).toBe('');
    expect(saved2?.urlInput).toBe('');

    // 路径段含 @ 与普通 URL 不被误清。
    saveDraft('/k3', 'checkout', { ...FORM, url: 'file:///tmp/a@b/trunk', urlInput: 'file:///tmp/repo/trunk' });
    expect(readDraft('/k3', 'checkout')?.url).toBe('file:///tmp/a@b/trunk');
  });

  it('containsSensitiveUrl 判定矩阵', () => {
    expect(containsSensitiveUrl('svn://user:pass@host/trunk')).toBe(true);
    expect(containsSensitiveUrl('svn://user@host/trunk')).toBe(true);
    expect(containsSensitiveUrl('https://h/trunk?q=1')).toBe(true);
    expect(containsSensitiveUrl('https://h/trunk#f')).toBe(true);
    expect(containsSensitiveUrl('user:pass@host/trunk')).toBe(false); // 非 scheme://authority 形态
    expect(containsSensitiveUrl('file:///tmp/repo/trunk')).toBe(false);
    expect(containsSensitiveUrl('svn://host/trunk')).toBe(false);
    expect(containsSensitiveUrl('file:///tmp/a%40b@x')).toBe(false); // 路径段 @ 不在 authority
    expect(containsSensitiveUrl('')).toBe(false);
  });

  it('错误字段不持久化：草稿值形态不含 urlError/nameError/revError', () => {
    saveDraft('/k', 'checkout', FORM);
    const raw = globalStateMap.get(draftKey('/k', 'checkout')) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(
      ['depth', 'dirName', 'directDir', 'directMode', 'message', 'nameMode', 'parentDir', 'rev', 'revMode', 'sourceDir', 'url', 'urlInput'].sort(),
    );
  });

  it('清除草稿：clearDraft 后读取为 undefined', () => {
    saveDraft('/k', 'checkout', FORM);
    expect(readDraft('/k', 'checkout')).toBeDefined();
    clearDraft('/k', 'checkout');
    expect(readDraft('/k', 'checkout')).toBeUndefined();
  });
});
