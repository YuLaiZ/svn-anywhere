import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { SvnError } from './errors';
import type { DepthOperationIntent, DepthOperationStep, SparseDepth } from './operations';
import { readRemoteDirectory, readRemoteNode, withRemoteAuthScope } from './remoteBrowse';
import { runOrThrowWithRunner, runStream, urlWithPeg, type RunOptions } from './svnCli';
import { escapePeg } from './workspace';

export const sparseDepths = ['exclude', 'empty', 'files', 'immediates', 'infinity'] as const;
const maxXml = 32 * 1024 * 1024;
const maxEntries = 100_000;
type Xml = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@', trimValues: false,
  parseTagValue: false, parseAttributeValue: false, htmlEntities: true,
  isArray: (name) => ['entry', 'target', 'property', 'changelist'].includes(name),
});

export interface SparseNode {
  path: string;
  kind: 'file' | 'dir';
  depth: SparseDepth | null;
  url: string;
  uuid?: string;
  revision?: number;
}

export interface SparseListing {
  root: SparseNode;
  nodes: Map<string, SparseNode>;
  remoteRevision?: number;
  remoteError?: string;
}

export interface SparseSnapshot extends SparseListing {
  remote: Map<string, SparseNode>;
  protectedPaths: Set<string>;
}

export interface SparseImpact {
  removed: string[];
  added: string[];
}

export interface SparsePlan {
  intent: DepthOperationIntent;
  fingerprint: string;
  impacts: SparseImpact[];
}

function xmlObject(value: unknown): Xml {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Xml : {};
}

function objects(value: unknown): Xml[] {
  return Array.isArray(value) ? value.map(xmlObject) : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseXml(value: string, root: string): Xml {
  if (XMLValidator.validate(value) !== true) throw new Error('SVN 返回的目录数据不完整');
  const parsed = parser.parse(value) as Xml;
  if (!(root in parsed)) throw new Error('SVN 返回的目录数据缺少 ' + root);
  return xmlObject(parsed[root]);
}

function inside(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}

/**
 * SVN XML 里的本地路径字段归一为绝对路径。`svn info` 对 cwd 之下的目标回相对 cwd
 * 的路径（子进程 cwd 为 `/` 时任何绝对目标都被相对化），`status`/`propget` 回绝对
 * 路径；无论哪种形态都按子进程 cwd（未设置即当前进程 cwd）归一，范围校验只在
 * 绝对形态下进行，节点身份不再受子进程 cwd 影响。
 */
function absoluteNodePath(raw: string, options: RunOptions): string {
  return isAbsolute(raw) ? raw : resolve(options.cwd ?? process.cwd(), raw);
}

function requireInside(parent: string, path: string): void {
  if (!isAbsolute(path) || !inside(parent, path)) throw new Error('SVN 节点超出工作副本范围');
}

function nodeUrl(root: string, parent: string, path: string): string {
  return [root.replace(/\/$/, ''), ...relative(parent, path).split(sep).filter(Boolean).map(encodeURIComponent)].join('/');
}

function urlIdentity(value: string): string {
  const url = new URL(value);
  return url.protocol + '//' + url.host + url.pathname.split('/').map((part) => encodeURIComponent(decodeURIComponent(part))).join('/');
}

function lexicalPath(root: string, name: string): string {
  const segments = name.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..' || part.includes('\0') || (sep !== '/' && part.includes(sep)))) {
    throw new Error('SVN 返回了无效的相对路径');
  }
  return join(root, ...segments);
}

function exists(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
    throw error;
  });
}

async function queryXml(svn: string, args: string[], options: RunOptions): Promise<string> {
  let chunks: Buffer[] = [];
  let bytes = 0;
  await runOrThrowWithRunner(svn, args, options, (path, argv, attemptOptions) => {
    chunks = [];
    bytes = 0;
    return runStream(path, argv, {
      ...attemptOptions, onStdoutChunk(chunk) {
        bytes += chunk.length;
        if (bytes > maxXml) throw new Error('SVN 目录数据超过读取上限，请缩小作用范围');
        chunks.push(chunk);
      },
    });
  });
  // SVN XML 指定 UTF-8，拒绝损坏字节以避免路径被替换字符改写。
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

export async function readLocalSparseNodes(
  svn: string, path: string, level: 'empty' | 'immediates' | 'infinity', options: RunOptions,
): Promise<Map<string, SparseNode>> {
  let xml: string;
  try {
    xml = await queryXml(svn, ['info', '--xml', '--depth', level, '--', escapePeg(path)], options);
  } catch (error) {
    if (error instanceof SvnError && /\bW155010\b/.test(error.stderr) &&
        /\bE200009\b/.test(error.stderr) && !await exists(path)) return new Map();
    throw error;
  }
  const entries = objects(parseXml(xml, 'info').entry);
  if (!entries.length || entries.length > maxEntries) throw new Error('SVN 本地目录数据不完整或超出上限');
  const nodes = new Map<string, SparseNode>();
  for (const value of entries) {
    const current = absoluteNodePath(text(value['@path']), options);
    const kind = value['@kind'];
    const depth = text(xmlObject(value['wc-info']).depth);
    const revision = Number(value['@revision']);
    const uuid = text(xmlObject(value.repository).uuid);
    const url = text(value.url);
    requireInside(path, current);
    if ((kind !== 'dir' && kind !== 'file') || !uuid || !url || !/^\d+$/.test(text(value['@revision'])) ||
        !Number.isSafeInteger(revision) || (kind === 'dir' && !sparseDepths.includes(depth as SparseDepth))) {
      throw new Error('SVN 本地节点身份或深度无法确认：' + current);
    }
    if (nodes.has(current)) throw new Error('SVN 返回了重复的本地节点：' + current);
    nodes.set(current, { path: current, kind, depth: kind === 'dir' ? depth as SparseDepth : null, url, uuid, revision });
  }
  return nodes;
}

export async function readSparseListing(
  svn: string, path: string, options: RunOptions, parent?: { root: SparseNode; revision: number },
): Promise<SparseListing> {
  const nodes = await readLocalSparseNodes(svn, path, 'immediates', options);
  const root = nodes.get(path) ?? parent?.root;
  if (!root || root.kind !== 'dir') throw new Error('请选择工作副本内的 SVN 目录');
  if (!nodes.has(path)) nodes.set(path, root);
  const remoteRoot = await readRemoteNode(svn, root.url, { ...options, revision: parent?.revision });
  if (remoteRoot.status !== 'present') return { root, nodes, remoteError: remoteRoot.error.message };
  if (remoteRoot.node.repositoryUuid !== root.uuid || remoteRoot.node.kind !== 'dir') {
    return { root, nodes, remoteError: '远端目录身份与本地工作副本不一致' };
  }
  const remoteRevision = remoteRoot.node.snapshotRevision;
  const result = await readRemoteDirectory(svn, root.url, { ...options, revision: remoteRevision });
  if (result.status !== 'ready') return { root, nodes, remoteError: result.error.message };
  for (const entry of result.listing.entries) {
    const child = lexicalPath(path, entry.name);
    if (dirname(child) !== path) throw new Error('SVN 直属目录查询返回了跨级节点');
    if (!nodes.has(child)) nodes.set(child, { path: child, kind: entry.kind, depth: null, url: nodeUrl(root.url, path, child), uuid: root.uuid });
  }
  return { root, nodes, remoteRevision };
}

async function inspectProtection(svn: string, root: SparseNode, local: Map<string, SparseNode>, options: RunOptions): Promise<Set<string>> {
  const protectedPaths = new Set<string>();
  const target = escapePeg(root.path);
  const status = parseXml(await queryXml(svn, ['status', '--xml', '--no-ignore', '--ignore-externals', '--', target], options), 'status');
  const readTargets = objects(status.target);
  if (readTargets.length !== 1 || absoluteNodePath(text(readTargets[0]['@path']), options) !== root.path) {
    throw new Error('SVN 状态未覆盖需要核实的范围：' + root.path);
  }
  const targets = [...readTargets, ...objects(status.changelist)];
  for (const section of targets) {
    for (const entry of objects(section.entry)) {
      const path = absoluteNodePath(text(entry['@path']), options);
      requireInside(root.path, path);
      const wcStatus = xmlObject(entry['wc-status']);
      if (!['normal', 'none'].includes(text(wcStatus['@item'])) ||
          !['normal', 'none'].includes(text(wcStatus['@props'])) || wcStatus['@switched'] === 'true' ||
          wcStatus['@tree-conflicted'] === 'true' || wcStatus['@wc-locked'] === 'true') protectedPaths.add(path);
    }
  }
  const props = parseXml(await queryXml(svn, ['propget', '--xml', '-R', 'svn:externals', '--', target], options), 'properties');
  for (const entry of objects(props.target)) {
    const path = absoluteNodePath(text(entry['@path']), options);
    requireInside(root.path, path);
    if (objects(entry.property).some((prop) => text(prop['#text']).trim() !== '' || typeof prop['#text'] !== 'string')) {
      protectedPaths.add(path);
    }
  }
  const realRoot = await realpath(root.path);
  for (const node of local.values()) {
    if (node.uuid !== root.uuid || urlIdentity(node.url) !== urlIdentity(nodeUrl(root.url, root.path, node.path))) {
      protectedPaths.add(node.path);
    }
    if (node.kind !== 'dir') continue;
    const stat = await exists(node.path);
    if (node.depth === 'exclude' ? !!stat : !stat?.isDirectory() || await realpath(node.path) !== join(realRoot, relative(root.path, node.path))) {
      protectedPaths.add(node.path);
    }
    if (node.path !== root.path && stat?.isDirectory() && await exists(join(node.path, '.svn', 'wc.db'))) {
      protectedPaths.add(node.path);
    }
  }
  return protectedPaths;
}

export async function readSparseSnapshot(
  svn: string, path: string, options: RunOptions, revision?: number,
): Promise<SparseSnapshot> {
  const nodes = await readLocalSparseNodes(svn, path, 'infinity', options);
  const root = nodes.get(path);
  if (!root || root.kind !== 'dir') throw new Error('无法读取工作副本目录深度');
  const remoteRoot = await readRemoteNode(svn, root.url, { ...options, revision });
  if (remoteRoot.status !== 'present') throw new Error(remoteRoot.error.message);
  if (remoteRoot.node.repositoryUuid !== root.uuid || remoteRoot.node.kind !== 'dir') {
    throw new Error('远端目录身份与本地工作副本不一致');
  }
  const pinned = remoteRoot.node.snapshotRevision;
  const scoped = withRemoteAuthScope(root.url, { ...options, retryReadOnly: root.url.startsWith('file:') ? undefined : {} });
  const remoteXml = await queryXml(svn, ['list', '--xml', '--non-interactive', '-R', '-r', String(pinned),
    '--', urlWithPeg(root.url, pinned)], scoped);
  const lists = xmlObject(parseXml(remoteXml, 'lists').list);
  if (typeof lists['@path'] !== 'string' || !lists['@path']) throw new Error('SVN 远端目录数据不完整');
  const entries = objects(lists.entry);
  if (entries.length > maxEntries) throw new Error('远端节点数超过上限，请缩小作用范围');
  const remote = new Map<string, SparseNode>([[path, root]]);
  for (const entry of entries) {
    const child = lexicalPath(path, text(entry.name));
    const kind = entry['@kind'];
    if ((kind !== 'dir' && kind !== 'file') || remote.has(child)) throw new Error('远端节点类型不明或路径重复');
    remote.set(child, { path: child, kind, depth: null, url: nodeUrl(root.url, path, child), uuid: root.uuid });
  }
  const protectedPaths = await inspectProtection(svn, root, nodes, options);
  return { root, nodes, remote, remoteRevision: pinned, protectedPaths };
}

function fingerprint(nodes: Map<string, SparseNode>, includeRevision = false): string {
  const serialized = [...nodes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path, n]) => [path, n.kind, n.depth, urlIdentity(n.url), n.uuid, includeRevision ? n.revision : null]);
  return createHash('sha256').update(JSON.stringify(serialized)).digest('hex');
}

function subtree(nodes: Map<string, SparseNode>, path: string) {
  return new Map([...nodes].filter(([child]) => inside(path, child)));
}

function projectedDepth(node: SparseNode, target: string, depth: SparseDepth): SparseDepth | null | undefined {
  if (node.path === target) return depth;
  if (depth === 'infinity') return node.kind === 'dir' ? 'infinity' : null;
  if (dirname(node.path) !== target) return undefined;
  if (node.kind === 'file' && (depth === 'files' || depth === 'immediates')) return null;
  if (node.kind === 'dir' && depth === 'immediates') return 'empty';
  return undefined;
}

export function planSparseChanges(
  snapshot: SparseSnapshot, changes: ReadonlyMap<string, SparseDepth>, keep: boolean, wcRoot: string,
): SparsePlan {
  if (snapshot.remoteRevision === undefined || !snapshot.root.uuid) throw new Error('远端目录身份和版本尚未确认');
  const revision = snapshot.remoteRevision;
  const working = new Map(snapshot.nodes);
  const impacts: SparseImpact[] = [];
  const steps: DepthOperationStep[] = [];
  const scope = snapshot.root.path;

  function append(path: string, depth: SparseDepth, preserveCurrent = false): void {
    requireInside(scope, path);
    if (depth === 'exclude' && path === scope) throw new Error('请从上一级目录排除此范围');
    const before = subtree(working, path);
    const known = snapshot.remote.get(path);
    if (!known || known.kind !== 'dir') throw new Error('远端已无该目录：' + path);
    const current = working.get(path);
    if (preserveCurrent && current?.depth === depth) return;
    const unconfirmed = [...before.values()].find((node) => node.depth !== 'exclude' && !snapshot.remote.has(node.path));
    if (unconfirmed) throw new Error('远端清单无法核对本地节点：' + unconfirmed.path);
    const dangerous = [...snapshot.protectedPaths].find((entry) => inside(path, entry) || inside(entry, path));
    if (dangerous) throw new Error('此路径含本地改动或无法安全探测：' + dangerous);
    if ([...before.values()].some((node) => (node.revision ?? 0) > revision)) {
      throw new Error('本地修订高于计划修订，请重新预览：' + path);
    }
    if (!current && depth === 'exclude') append(path, 'empty');
    const parent = working.get(dirname(path));
    if (path !== scope && (!parent || parent.depth === 'exclude')) throw new Error('请先纳入上一级目录：' + dirname(path));
    const actualBefore = subtree(working, path);
    for (const key of actualBefore.keys()) working.delete(key);
    for (const node of subtree(snapshot.remote, path).values()) {
      const result = projectedDepth(node, path, depth);
      if (result !== undefined) working.set(node.path, { ...node, depth: result, revision });
    }
    const after = subtree(working, path);
    const excluded = (node?: SparseNode) => !node || node.depth === 'exclude';
    impacts.push({
      removed: [...actualBefore.values()].filter((node) => !excluded(node) && excluded(after.get(node.path))).map((node) => node.path),
      added: [...after.values()].filter((node) => !excluded(node) && excluded(actualBefore.get(node.path))).map((node) => node.path),
    });
    steps.push({
      path, depth, beforeDepth: actualBefore.get(path)?.depth ?? null, expectedUrl: known.url,
      beforeFingerprint: fingerprint(actualBefore, true),
      expectedFingerprint: fingerprint(after),
    });
  }

  if (keep) {
    if (snapshot.root.depth !== 'files') {
      for (const [path, depth] of changes) {
        if (dirname(path) !== scope) throw new Error('仅可从直属目录选择保留范围');
        if ([...subtree(snapshot.nodes, path).values()].some((node) => node.path !== path && projectedDepth(node, path, depth) !== node.depth)) {
          throw new Error('先处理此子树单独设置的深度，再调整保留范围：' + path);
        }
      }
      append(scope, 'files');
    }
    for (const [path, depth] of changes) {
      if (dirname(path) !== scope) throw new Error('仅可从直属目录选择保留范围');
      append(path, depth, true);
    }
    for (const node of working.values()) {
      if (node.kind === 'dir' && dirname(node.path) === scope && node.depth !== 'exclude' && !changes.has(node.path)) append(node.path, 'exclude');
    }
  } else {
    for (const [path, depth] of changes) {
      if (depth === 'exclude' && path === wcRoot) throw new Error('工作副本根目录不能被排除');
      if ([...changes.keys()].some((other) => other !== path && (inside(path, other) || inside(other, path)))) {
        throw new Error('计划中有重叠的父子目录，请分次调整');
      }
      append(path, depth);
    }
  }
  const intent = { scopePath: scope, revision, uuid: snapshot.root.uuid, steps };
  const planFingerprint = createHash('sha256').update(JSON.stringify([intent, fingerprint(snapshot.nodes, true)])).digest('hex');
  return { intent, fingerprint: planFingerprint, impacts };
}

export async function observeSparseStep(
  svn: string, step: DepthOperationStep, revision: number, options: RunOptions, beforeOnly = false,
): Promise<'applied' | 'unchanged' | 'unknown'> {
  const local = await readLocalSparseNodes(svn, step.path, 'infinity', options);
  const stat = await exists(step.path);
  const root = local.get(step.path);
  if (root && urlIdentity(root.url) !== urlIdentity(step.expectedUrl)) return 'unknown';
  if (root?.depth === 'exclude' ? !!stat : root ? !stat?.isDirectory() : !!stat) return 'unknown';
  if (root && root.depth !== 'exclude' && (await inspectProtection(svn, root, local, options)).size) return 'unknown';
  if (!beforeOnly && fingerprint(local) === step.expectedFingerprint &&
      (step.depth === 'exclude' || root?.revision === revision)) return 'applied';
  if (fingerprint(local, true) === step.beforeFingerprint) return 'unchanged';
  return 'unknown';
}

export function sparseStepArgs(step: DepthOperationStep, revision: number): string[] {
  return ['update', '--non-interactive', '--ignore-externals', '-r', String(revision), '--set-depth', step.depth,
    '--', escapePeg(step.path)];
}
