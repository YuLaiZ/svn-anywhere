import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { OperationRecord, OperationStore } from './operations';

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('SVN 操作存储目录不是当前用户的私有目录');
  }
}

function canonicalPath(path: string): string {
  let current = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

function lockPath(path: string): string {
  const canonical = canonicalPath(path);
  // macOS 卷可不区分大小写，路径尚未创建时也沿用同一锁键。
  return process.platform === 'darwin' ? canonical.normalize('NFC').toLowerCase() : canonical;
}

function within(root: string, path: string): boolean {
  const segment = relative(root, path);
  return segment === '' || (segment !== '..' && !segment.startsWith('..' + sep) && !isAbsolute(segment));
}

export function overlappingWorkspaces(left: string, right: string): boolean {
  const a = lockPath(left);
  const b = lockPath(right);
  return within(a, b) || within(b, a);
}

export interface WorkspaceLease {
  key: string;
  helper: string;
  fds: readonly number[];
  close(): void;
}

interface ActiveLease {
  lease: WorkspaceLease;
  alias?: string;
}
const activeLeases = new Map<string, ActiveLease>();

export function registerWorkspaceLease(operationId: string, lease: WorkspaceLease): void {
  activeLeases.set(operationId, { lease });
}

export function registerWorkspaceLeaseAlias(operationId: string, path: string): void {
  const owner = activeLeases.get(operationId);
  if (owner) owner.alias = lockPath(path);
}

export function releaseWorkspaceLease(operationId: string): void {
  const owner = activeLeases.get(operationId);
  if (!owner) return;
  activeLeases.delete(operationId);
  owner.lease.close();
}

const writeCommands = new Set(['update', 'checkout', 'commit', 'import', 'cleanup', 'relocate',
  'add', 'delete', 'move', 'revert', 'propset', 'propdel', 'resolve', 'switch', 'merge']);

export function workspaceLeasesForCommand(args: readonly string[], cwd: string | undefined): WorkspaceLease[] {
  if (!writeCommands.has(args[0]) || !activeLeases.size) return [];
  const paths: string[] = [];
  if (cwd) paths.push(lockPath(cwd));
  for (const argument of args.slice(1)) {
    if (!isAbsolute(argument)) continue;
    const path = argument.endsWith('@') && argument.slice(0, -1).includes('@') ? argument.slice(0, -1) : argument;
    try {
      paths.push(lockPath(path));
    } catch {
      // 绝对路径参数也可能是消息文件。交由 SVN 验证与命令相关的参数。
    }
  }
  return [...activeLeases.values()]
    .filter(({ lease, alias }) => paths.some((path) => within(lease.key, path) || (alias && within(alias, path))))
    .map(({ lease }) => lease);
}

export class WorkspaceLocks {
  private readonly directory: string;

  constructor(directory: string, private readonly helper: string) {
    this.directory = directory;
    privateDirectory(directory);
  }

  acquire(key: string): WorkspaceLease | undefined {
    const canonical = lockPath(key);
    const resources: string[] = [canonical];
    for (let path = dirname(canonical); path !== resources.at(-1); path = dirname(path)) resources.push(path);
    resources.reverse();
    const fds: number[] = [];
    let acquired = false;
    try {
      for (const path of resources) {
        const name = createHash('sha256').update(path).digest('hex') + '.lock';
        fds.push(openSync(join(this.directory, name), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600));
      }
      const modes = resources.map((path) => path === canonical ? 'x' : 's');
      const result = spawnSync(this.helper, ['acquire', ...modes], { stdio: ['ignore', 'ignore', 'ignore', ...fds] });
      if (result.error) throw result.error;
      if (result.status === 1) return undefined;
      if (result.status !== 0) throw new Error('无法取得工作副本文件锁');
      acquired = true;
      return { key: canonical, helper: this.helper, fds, close: () => fds.splice(0).forEach(closeSync) };
    } finally {
      if (!acquired) fds.forEach(closeSync);
    }
  }
}

function recordName(id: string): string {
  return createHash('sha256').update(id).digest('hex') + '.json';
}

export class FileOperationStore implements OperationStore {
  constructor(private readonly directory: string) {
    privateDirectory(directory);
  }

  async load(): Promise<OperationRecord[]> {
    const files = await readdir(this.directory);
    const records: OperationRecord[] = [];
    for (const name of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const value: unknown = JSON.parse(await readFile(join(this.directory, name), 'utf8'));
        if (!value || typeof value !== 'object' || !('operationId' in value) ||
            typeof value.operationId !== 'string' || recordName(value.operationId) !== name ||
            !('wcRoot' in value) || typeof value.wcRoot !== 'string' ||
            !('phase' in value) || typeof value.phase !== 'string') throw new Error('无效的 SVN 操作记录 ' + name);
        records.push(value as OperationRecord);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return records;
  }

  private async syncDirectory(): Promise<void> {
    const handle = await open(this.directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async save(record: OperationRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, recordName(record.operationId));
    const temporary = join(this.directory, randomUUID() + '.tmp');
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(record), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
      await this.syncDirectory();
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  async remove(operationId: string): Promise<void> {
    await unlink(join(this.directory, recordName(operationId))).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await this.syncDirectory();
  }
}
