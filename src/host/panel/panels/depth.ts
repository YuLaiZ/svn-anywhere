import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, dirname, relative, sep } from 'node:path';
import {
  getOperationRegistry, kindOf, type OperationRecord, type SparseDepth,
} from '../../../core/operations';
import {
  planSparseChanges, readSparseListing, readSparseSnapshot, sparseDepths, type SparseListing,
  type SparseNode, type SparsePlan,
} from '../../../core/sparse';
import { beginSparseTask, runSparseTask, verifySparseTask, type SparseTaskResult } from '../../../core/sparseTask';
import { findWorkingCopy } from '../../../core/workspace';
import { credentialProvider } from '../../auth';
import { readSvnPath, readTimeoutMs } from '../../config';
import { openConflictTarget } from '../../commands/conflicts';
import { resolveWorkingCopyTarget, type WcTarget } from '../../commands/target';
import { performUpdatePaths } from '../../commands/update';
import { decodingRunOptions, logLine, showOutput } from '../../output';
import { strings } from '../../i18n';
import { createPanel, type PanelHandle } from '../host';
import type { Intent } from '../protocol';
import type { BannerSpec, ConfirmDialogSpec, FormFieldSpec, PanelState } from '../state';

type Mode = 'update' | 'keep' | 'depth';
const modes = { update: '只更新所选', keep: '以后只保留所选', depth: '逐目录设置' };
const depthText: Record<SparseDepth, string> = {
  exclude: '排除', empty: '仅目录', files: '含直属文件', immediates: '含直属子目录与文件', infinity: '完整递归',
};
const hints: Record<Mode, string> = {
  update: '只更新勾选的本地目录。本次跳过未选的同级目录，检出深度保持原样。',
  keep: '以后普通更新只保留所选直属子目录及父目录的直属文件。首次收窄可能临时移除已选目录并重新检出。',
  depth: '调整目录的持久深度。确认前会列出受影响的路径和实际执行顺序。',
};
type Preview =
  | { id: string; detail: string; mode: 'update'; paths: string[] }
  | { id: string; detail: string; mode: 'depth'; plan: SparsePlan; changes: Map<string, SparseDepth>; keep: boolean }
  | { id: string; detail: string; mode: 'resume'; record: OperationRecord };
let context: vscode.ExtensionContext | undefined;
const panels = new Map<string, DepthPanel>();

export function setDepthPanelContext(value: vscode.ExtensionContext): void {
  context = value;
}

function inWorkingCopy(path: string, wcRoot: string): boolean {
  return findWorkingCopy(path) === wcRoot;
}

function isLocal(node: SparseNode): boolean {
  return !!node.depth && node.depth !== 'exclude';
}

function summarize(paths: string[], scope: string): string {
  const limit = 36;
  const all = [...new Set(paths)];
  const visible = all.slice(0, limit).map((path) => relative(scope, path) || '.').join('、');
  return all.length > limit ? visible + '（另有 ' + (all.length - limit) + ' 项，详见输出日志）' : visible;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function svnOptions(signal?: AbortSignal) {
  return { timeoutMs: readTimeoutMs(), getCredentials: credentialProvider(), signal, ...decodingRunOptions('other') };
}

export async function commandDepth(uri?: vscode.Uri): Promise<void> {
  const target = await resolveWorkingCopyTarget(uri, strings.command.editDepth);
  if (!target) return;
  const status = await lstat(target.targetPath).catch(() => undefined);
  if (!status?.isDirectory() || !inWorkingCopy(target.targetPath, target.wcRoot)) {
    void vscode.window.showInformationMessage('请选择工作副本中的 SVN 目录。');
    return;
  }
  await openDepthPanel(target);
}

export async function openDepthPanel(target: WcTarget): Promise<void> {
  if (!context) throw new Error('深度编辑面板尚未初始化');
  const key = target.wcRoot + '\0' + target.targetPath;
  const existing = panels.get(key);
  if (existing) {
    existing.reveal();
    await existing.refresh();
    return;
  }
  const panel = new DepthPanel(target, context, () => panels.delete(key));
  panels.set(key, panel);
  await panel.refresh();
}

class DepthPanel {
  private handle: PanelHandle;
  private mode: Mode = 'update';
  private listings = new Map<string, SparseListing>();
  private expanded = new Set<string>();
  private ids = new Map<string, string>();
  private inputRevision = 0;
  private updateDraft?: Set<string>;
  private keepDraft?: Map<string, SparseDepth>;
  private depthDraft = new Map<string, SparseDepth>();
  private busy = false;
  private disposed = false;
  private readAbort?: AbortController;
  private preview?: Preview;
  private notice?: BannerSpec;
  private restriction?: OperationRecord;
  private saved?: OperationRecord;
  private visibleLimit = 100;
  private hasMore = false;

  constructor(private readonly target: WcTarget, extension: vscode.ExtensionContext, cleanup: () => void) {
    this.expanded.add(target.targetPath);
    const readActions = ['closePanel', 'viewTaskLog'].map((action) => ({ action }));
    this.handle = createPanel('depth-' + randomUUID(), {
      title: strings.command.editDepth + ' · ' + basename(target.targetPath),
      gates: {
        busy: readActions,
        writeLocked: [...readActions, ...['refresh', 'verifyDepth', 'setDepthTab', 'toggleDepthNode', 'loadDepthRows'].map((action) => ({ action }))],
      },
    }, {
      onIntent: (intent) => this.intent(intent),
      onViewReady: () => { this.inputRevision = 0; this.push(); },
      onDispose: () => { this.disposed = true; this.readAbort?.abort(); cleanup(); },
    }, extension);
  }

  reveal(): void {
    this.handle.reveal();
  }

  async refresh(): Promise<void> {
    if (this.busy) return;
    this.preview = undefined;
    await this.runBusy(() => this.readRoot());
  }

  private async readRoot(): Promise<void> {
    if (this.disposed) return;
    this.readAbort?.abort();
    this.readAbort = new AbortController();
    const signal = this.readAbort.signal;
    const registry = getOperationRegistry();
    await registry.refreshWorkspace(this.target.wcRoot);
    this.restriction = registry.writeRestriction(this.target.wcRoot);
    this.saved = registry.pendingForWcRoot(this.target.wcRoot)
      .find((item) => kindOf(item) === 'depth-edit' && item.depthIntent?.scopePath === this.target.targetPath);
    const result = await readSparseListing(readSvnPath(), this.target.targetPath, svnOptions(signal));
    if (signal.aborted) return;
    const previous = [...this.expanded];
    this.listings.clear();
    this.listings.set(this.target.targetPath, result);
    this.expanded = new Set([this.target.targetPath]);
    for (const path of previous) {
      if (path !== this.target.targetPath && this.expanded.has(dirname(path))) {
        const node = this.listings.get(dirname(path))?.nodes.get(path);
        if (node?.kind === 'dir') await this.expand(node, signal);
      }
    }
  }

  private async runBusy(work: () => Promise<void>): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.push();
    try {
      await work();
    } catch (error) {
      this.notice = { id: 'depth-error', title: '无法完成操作', detail: errorText(error), level: 'error' };
      logLine(errorText(error), 'other');
    } finally {
      this.busy = false;
      this.push();
    }
  }

  private topDirectories(): SparseNode[] {
    const root = this.listings.get(this.target.targetPath);
    return [...root?.nodes.values() ?? []].filter((node) => node.kind === 'dir' && node.path !== this.target.targetPath);
  }

  private idFor(path: string): string {
    let id = this.ids.get(path);
    if (!id) {
      id = 'directory-' + this.ids.size;
      this.ids.set(path, id);
    }
    return id;
  }

  private selectedUpdates(): Set<string> {
    return this.updateDraft ?? new Set(this.topDirectories().filter(isLocal).map((node) => node.path));
  }

  private selectedKeep(): Map<string, SparseDepth> {
    return this.keepDraft ?? new Map(this.topDirectories().filter(isLocal).map((node) => [node.path, node.depth ?? 'infinity']));
  }

  private field(node: SparseNode, level: number, selected = false): FormFieldSpec {
    const id = this.idFor(node.path);
    const root = this.listings.get(this.target.targetPath);
    const current = node.depth ? depthText[node.depth] + ' · ' + node.depth : '未检出';
    const blocked = !!this.restriction || !!this.saved || (this.mode !== 'update' && !!root?.remoteError);
    let field: FormFieldSpec;
    if (this.mode === 'depth') {
      const parent = this.listings.get(dirname(node.path))?.root;
      const options = sparseDepths.filter((depth) => depth !== 'exclude' || node.path !== this.target.targetPath)
        .map((depth) => ({ value: depth, label: depthText[depth] }));
      field = {
        id, type: 'select', label: node.path + ' 的目标深度', value: this.depthDraft.get(node.path) ?? '',
        options: [{ value: '', label: '保持当前深度' }, ...options],
        disabled: blocked || (node.path !== this.target.targetPath && !parent?.depth) || parent?.depth === 'exclude',
      };
    } else {
      field = {
        id, type: 'checkbox', label: modes[this.mode] + ' ' + node.path, value: String(selected),
        disabled: blocked || (this.mode === 'update' && !isLocal(node)),
      };
    }
    const expanded = this.expanded.has(node.path);
    field.directory = {
      name: basename(node.path), current: this.mode === 'update' && isLocal(node) ? '已检出' : current, level,
      toggle: this.mode === 'depth' ? {
        id: 'toggleDepthNode', label: expanded ? '▾' : '▸', disabledReason: (expanded ? '折叠 ' : '展开 ') + basename(node.path),
        payload: { 'node-id': id },
      } : undefined,
    };
    return field;
  }

  private fields(): FormFieldSpec[] {
    this.hasMore = false;
    if (this.mode !== 'depth') {
      const nodes = this.topDirectories();
      const selection = this.mode === 'update' ? this.selectedUpdates() : this.selectedKeep();
      this.hasMore = nodes.length > this.visibleLimit;
      return nodes.slice(0, this.visibleLimit).map((node) => this.field(node, 0, selection.has(node.path)));
    }
    const listing = this.listings.get(this.target.targetPath);
    if (!listing) return [];
    const rows = [this.field(listing.root, 0)];
    const walk = (scope: SparseListing, level: number) => {
      if (!this.expanded.has(scope.root.path)) return;
      for (const node of scope.nodes.values()) {
        if (node.path === scope.root.path || node.kind !== 'dir') continue;
        if (rows.length >= this.visibleLimit) {
          this.hasMore = true;
          return;
        }
        rows.push(this.field(node, level));
        const child = this.listings.get(node.path);
        if (child) walk(child, level + 1);
      }
    };
    walk(listing, 1);
    return rows;
  }

  private push(): void {
    if (this.disposed) return;
    const listing = this.listings.get(this.target.targetPath);
    const banners: BannerSpec[] = [];
    if (listing?.remoteError) banners.push({
      id: 'depth-remote', title: '远端列表不可用，可以查看或只更新已检出的目录',
      detail: listing.remoteError, level: 'warn', dismissable: false,
    });
    if (this.restriction) banners.push({
      id: 'depth-restriction',
      title: this.restriction.phase === 'running' || this.restriction.phase === 'prepared'
        ? '此工作副本有操作正在执行'
        : this.saved ? '此工作副本仍有结果待核实' : '此工作副本有其他未完成操作',
      detail: this.restriction.targetRelPath, level: 'warn', dismissable: false,
    });
    if (this.saved?.phase === 'residue-pending') banners.push({
      id: 'depth-remainder', title: '有尚未完成的深度步骤，请预览后继续或放弃剩余步骤',
      detail: '已核实 ' + (this.saved.depthProgress?.verified ?? 0) + ' 项。', level: 'info', dismissable: false,
    });
    if (this.saved?.depthIntent && (this.saved.phase === 'unknown' || this.saved.phase === 'residue-pending')) {
      const { steps } = this.saved.depthIntent;
      const progress = this.saved.depthProgress;
      const scope = this.target.targetPath;
      const details = steps.slice(0, 36).map((step, index) => {
        const status = index < (progress?.verified ?? 0) ? '已核实' : index === progress?.dispatching ? '结果待核实' : '尚未执行';
        return status + ' · ' + (relative(scope, step.path) || '.') + ' → ' + depthText[step.depth];
      });
      if (steps.length > details.length) details.push('还有 ' + (steps.length - details.length) + ' 项，详见剩余步骤的预览。');
      banners.push({ id: 'depth-steps', title: '最近任务', detail: details.join('\n'), preformatted: true, level: 'info' });
    }
    if (this.notice) banners.push(this.notice);
    const summary = this.mode === 'update' ? '已选 ' + this.selectedUpdates().size + ' 个本地目录'
      : this.mode === 'keep' ? '以后保留 ' + this.selectedKeep().size + ' 个目录'
      : this.depthDraft.size + ' 项深度调整待确认';
    const confirmDialog: ConfirmDialogSpec | undefined = this.preview && {
      id: this.preview.id, title: this.preview.mode === 'update' ? '确认只更新所选目录' : '确认深度调整',
      detail: this.preview.detail, cancelLabel: '返回编辑', cancelFocusIntent: 'previewDepth',
      confirm: { id: 'applyDepthPreview', label: this.preview.mode === 'update' ? '开始更新' : '应用变更',
        payload: { 'preview-id': this.preview.id } },
    };
    const fields = this.fields();
    const state: PanelState = {
      sessionId: this.handle.sessionId, revision: 0, formRevision: this.inputRevision, busy: this.busy,
      writeLocked: !!this.restriction, title: strings.command.editDepth, targetLabel: this.target.targetPath,
      hint: hints[this.mode], banners, confirmDialog,
      tabs: { id: 'depth-tabs', current: this.mode, intent: 'setDepthTab', tabs: (Object.entries(modes)
        .map(([id, label]) => ({ id, label }))) },
      form: { id: 'depth-directories', busy: this.busy, fields },
      footer: {
        summary, primary: this.restriction?.phase === 'unknown' && this.saved?.operationId === this.restriction.operationId
          ? { id: 'verifyDepth', label: '回扫工作副本' }
          : { id: 'previewDepth', label: this.saved?.phase === 'residue-pending' ? '预览剩余步骤' : '预览变更',
            disabled: !listing || !!this.restriction || (!this.saved && (
              this.mode !== 'update' ? !!listing.remoteError || (this.mode === 'depth' && !this.depthDraft.size)
                : !this.selectedUpdates().size)) },
        secondary: [
          { id: 'refresh', label: listing?.remoteError ? '重试查询' : '刷新状态' },
          { id: 'viewTaskLog', label: '查看日志' },
          ...(this.hasMore ? [{ id: 'loadDepthRows', label: '显示更多目录' }] : []),
          this.saved?.phase === 'residue-pending' ? { id: 'discardDepthRemainder', label: '放弃剩余步骤' }
            : { id: 'clearDepthDraft', label: '重置选择' },
        ],
      },
    };
    this.handle.update(state);
  }

  private async expand(node: SparseNode, signal?: AbortSignal): Promise<void> {
    const main = this.listings.get(this.target.targetPath);
    if (!main?.remoteRevision && !isLocal(node)) return;
    const ancestor = main?.remoteRevision === undefined ? undefined : { root: node, revision: main.remoteRevision };
    const listing = await readSparseListing(readSvnPath(), node.path, svnOptions(signal), ancestor);
    if (!signal?.aborted) {
      this.listings.set(node.path, listing);
      this.expanded.add(node.path);
    }
  }

  private forField(id: string): SparseNode | undefined {
    for (const listing of this.listings.values()) {
      for (const node of listing.nodes.values()) {
        if (this.ids.get(node.path) === id && node.kind === 'dir') return node;
      }
    }
    return undefined;
  }

  private async intent(intent: Intent): Promise<void> {
    switch (intent.kind) {
      case 'closePanel': this.handle.dispose(); return;
      case 'viewTaskLog': showOutput(true, 'other'); return;
      case 'refresh': await this.refresh(); return;
      case 'setDepthTab':
        this.mode = intent.tab;
        this.preview = undefined;
        this.push();
        return;
      case 'toggleDepthNode': {
        if (this.mode !== 'depth') return;
        const node = this.forField(intent.nodeId);
        if (!node) return;
        if (this.expanded.delete(node.path)) {
          this.push();
        } else {
          await this.runBusy(() => this.expand(node, this.readAbort?.signal));
        }
        return;
      }
      case 'syncInput': {
        if (this.busy || this.restriction || this.saved || intent.inputRevision <= this.inputRevision) return;
        const field = this.fields().find((item) => item.id === intent.fieldId);
        const node = this.forField(intent.fieldId);
        if (!node || !field || field.disabled) return;
        this.inputRevision = intent.inputRevision;
        this.preview = undefined;
        if (this.mode === 'depth') {
          if (!field.options?.some((option) => option.value === intent.value)) return;
          if (intent.value === '') this.depthDraft.delete(node.path);
          else this.depthDraft.set(node.path, intent.value as SparseDepth);
        } else if (intent.value === 'true' || intent.value === 'false') {
          if (this.mode === 'update') {
            this.updateDraft ??= this.selectedUpdates();
            if (intent.value === 'true') this.updateDraft.add(node.path);
            else this.updateDraft.delete(node.path);
          } else {
            this.keepDraft ??= this.selectedKeep();
            if (intent.value === 'true') this.keepDraft.set(node.path, isLocal(node) ? node.depth ?? 'infinity' : 'infinity');
            else this.keepDraft.delete(node.path);
          }
        }
        this.push();
        return;
      }
      case 'loadDepthRows':
        this.visibleLimit += 100;
        this.push();
        return;
      case 'clearDepthDraft':
        if (this.restriction || this.saved) return;
        if (this.mode === 'update') this.updateDraft = undefined;
        else if (this.mode === 'keep') this.keepDraft = undefined;
        else this.depthDraft.clear();
        this.preview = undefined;
        this.push();
        return;
      case 'previewDepth': await this.runBusy(() => this.buildPreview()); return;
      case 'applyDepthPreview':
        if (this.preview?.id === intent.previewId) {
          const preview = this.preview;
          this.preview = undefined;
          await this.runBusy(() => this.apply(preview));
        }
        return;
      case 'verifyDepth':
        await this.runBusy(() => this.verify());
        return;
      case 'discardDepthRemainder':
        await this.runBusy(async () => {
          if (this.saved?.phase !== 'residue-pending') return;
          const answer = await vscode.window.showWarningMessage('放弃尚未执行的深度步骤？已生效的变更会保留。', { modal: true }, '放弃剩余步骤');
          if (answer !== '放弃剩余步骤') return;
          await getOperationRegistry().finish(this.saved.operationId);
          await this.readRoot();
        });
        return;
      default: return;
    }
  }

  private async buildPreview(): Promise<void> {
    this.notice = undefined;
    if (this.restriction) return;
    const id = randomUUID();
    const scope = this.target.targetPath;
    if (this.saved?.phase === 'residue-pending' && this.saved.depthIntent) {
      const steps = this.saved.depthIntent.steps.slice(this.saved.depthProgress?.verified ?? 0);
      this.preview = { id, mode: 'resume', record: this.saved, detail: '只继续以下剩余步骤（r' +
        this.saved.depthIntent.revision + '）\n' + steps.map((step) => relative(scope, step.path) + ' → ' + depthText[step.depth]).join('\n') };
    } else if (this.mode === 'update') {
      const selected = this.selectedUpdates();
      const nodes = this.topDirectories();
      const paths = nodes.filter((node) => selected.has(node.path) && isLocal(node)).map((node) => node.path);
      if (!paths.length) return;
      const skipped = nodes.filter((node) => !paths.includes(node.path));
      const riskyLater = this.listings.get(scope)?.root.depth === 'infinity' && skipped.some((node) => node.depth === null);
      this.preview = { id, mode: 'update', paths, detail: [
        scope, '本次更新：' + summarize(paths, scope), '本次跳过：' + (summarize(skipped.map((node) => node.path), scope) || '无'),
        ...(riskyLater ? ['以后对完整检出的父目录普通更新时，仍可能下载未明确排除的目录。'] : []),
      ].join('\n') };
    } else {
      const keep = this.mode === 'keep';
      const changes = new Map(keep ? this.selectedKeep() : this.depthDraft);
      const snapshot = await readSparseSnapshot(readSvnPath(), scope, svnOptions(this.readAbort?.signal));
      const plan = planSparseChanges(snapshot, changes, keep, this.target.wcRoot);
      if (!plan.intent.steps.length) {
        this.notice = { id: 'depth-unchanged', title: '当前检出范围已符合所选设置', level: 'info' };
        return;
      }
      const detail = [scope, '固定修订 r' + plan.intent.revision];
      if (keep) {
        detail.push('以后保留直属文件及：' + (summarize([...changes.keys()], scope) || '无子目录'));
        detail.push('以后跳过：' + (summarize(this.topDirectories().filter((node) => !changes.has(node.path)).map((node) => node.path), scope) || '无'));
        const old = new Set(this.topDirectories().filter(isLocal).map((node) => node.path));
        const temporary = plan.intent.steps.filter((step) => old.has(step.path) && step.beforeDepth === null && changes.has(step.path));
        if (temporary.length) detail.push('先从本地移除，随后重新检出：' + summarize(temporary.map((step) => step.path), scope));
      }
      for (const [index, step] of plan.intent.steps.entries()) {
        const impact = plan.impacts[index];
        const name = relative(scope, step.path) || '.';
        detail.push(name + ' → ' + depthText[step.depth] + (step.beforeDepth === null && step.depth === 'empty' ? '（只取目录自身）' : ''));
        if (impact.removed.length) detail.push('从本地移除：' + summarize(impact.removed, scope));
        if (impact.added.length) detail.push('纳入本地：' + summarize(impact.added, scope));
        for (const path of impact.removed) logLine('预览 · 从本地移除 · ' + path, 'other');
        for (const path of impact.added) logLine('预览 · 纳入本地 · ' + path, 'other');
      }
      this.preview = { id, mode: 'depth', plan, detail: detail.join('\n'), changes, keep };
    }
  }

  private async apply(preview: Preview): Promise<void> {
    this.notice = undefined;
    const registry = getOperationRegistry();
    await registry.refreshWorkspace(this.target.wcRoot);
    const svn = readSvnPath();
    if (preview.mode === 'update') {
      let updated = 0;
      this.updateDraft = new Set(preview.paths);
      for (const path of preview.paths) {
        if (!inWorkingCopy(path, this.target.wcRoot) || !(await lstat(path)).isDirectory()) {
          throw new Error('更新前目录身份已变化：' + path);
        }
        const rel = relative(this.target.wcRoot, path);
        const result = await performUpdatePaths(this.target.wcRoot, [rel], path, svn, { conflictPrompt: false });
        if (result.exitCode !== 0 || !(result.finalRevision !== undefined || result.items.length || result.conflicts.length)) break;
        this.updateDraft.delete(path);
        updated++;
        if (result.conflicts.length || Object.values(result.conflictSummary ?? {}).some((count) => !!count)) {
          void openConflictTarget({ wcRoot: this.target.wcRoot, scopeRelPath: rel.split(sep).join('/'), source: 'update' });
          break;
        }
      }
      this.notice = { id: 'depth-updated', title: '已更新 ' + updated + ' 个目录',
        detail: this.updateDraft.size ? '剩余所选目录尚未更新，请查看日志。' : '检出深度保持原样。',
        level: this.updateDraft.size ? 'warn' : 'success' };
    } else {
      let result: SparseTaskResult;
      if (preview.mode === 'resume') {
        const begin = await registry.beginResume(preview.record.operationId, this.target.wcRoot);
        if (!begin.ok) throw new Error('未完成计划已变化或有其他操作在途，请刷新状态');
        result = await runSparseTask(registry, svn, begin.record, svnOptions());
      } else {
        const scope = preview.plan.intent.scopePath;
        result = await beginSparseTask(registry, svn, this.target.wcRoot, preview.plan, async () => {
          if (!inWorkingCopy(scope, this.target.wcRoot)) throw new Error('工作副本身份已变化');
          const fresh = await readSparseSnapshot(svn, scope, svnOptions());
          return planSparseChanges(fresh, preview.changes, preview.keep, this.target.wcRoot);
        }, svnOptions());
        if (result.kind === 'done') {
          if (preview.keep) this.keepDraft = undefined;
          for (const step of preview.plan.intent.steps) {
            if (this.depthDraft.get(step.path) === step.depth) this.depthDraft.delete(step.path);
          }
        }
      }
      this.notice = result.kind === 'done'
        ? { id: 'depth-success', title: '已核实 ' + result.count + ' 个深度步骤', level: 'success' }
        : { id: 'depth-result', title: result.kind === 'unknown' ? '深度变更结果待核实' : '深度步骤未发送',
          detail: result.message, level: 'warn' };
    }
    await this.readRoot();
  }

  private async verify(): Promise<void> {
    const registry = getOperationRegistry();
    await registry.refreshWorkspace(this.target.wcRoot);
    const record = registry.pendingForWcRoot(this.target.wcRoot).find((item) => item.operationId === this.saved?.operationId);
    if (!record || record.phase !== 'unknown') {
      await this.readRoot();
      return;
    }
    const result = await verifySparseTask(registry, readSvnPath(), record, svnOptions());
    const titles = {
      applied: '回扫确认该步骤已生效', unchanged: '回扫确认该步骤尚未生效',
      unknown: '回扫仍无法确认，保留写入限制', done: '全部步骤已核实',
    };
    this.notice = { id: 'depth-verified', title: titles[result], level: result === 'unknown' ? 'warn' : 'success' };
    await this.readRoot();
  }
}
