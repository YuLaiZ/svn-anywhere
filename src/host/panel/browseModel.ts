/**
 * P5 仓库浏览器模型（M4 阶段 2 任务 2/3/4 的宿主状态机）。纯 TypeScript，
 * 不依赖 vscode，可在 vitest 中直接驱动。
 *
 * 状态边界（技术方案 §3.2/§3.3）：
 * - 树只在宿主内存保存当前浏览 revision 的节点与已读取条目；100k 条目
 *   只存在紧凑数组，Webview 每帧只接收每个目录的可见片（首批/每次
 *   加载更多 ≤40 条）；
 * - 每个目录节点的读取状态是独立状态机（idle/loading/ready/error），
 *   节点级 requestSeq 保证旧回包不覆盖当前树——父目录刷新、折叠或
 *   取消补全都会使后代/该节点的在途回包过期；
 * - 展开与选中是独立意图：展开只触发目录读取，选中才更新详情；
 * - 两段式加载（2026-11-13 定案）：目录读取先经无元数据 `svn list`
 *   取得名称与精确总数；超过阈值（默认 5,000）立即 ready（metadata
 *   pending）并由可见片的可取消后台任务补全元数据；不超过阈值继续用
 *   `list --xml` 一次取回完整元数据（常规目录行为不变）；选中节点走
 *   单节点 info 补全详情，不等待后台批次；
 * - 空目录是 ready + total=0（只能建立在读取成功上），不是错误；节点
 *   错误只写该节点，不替换父级与兄弟；tooLarge（100k/64 MiB）是显式
 *   终态，不展示部分条目或伪总数；
 * - 关闭重开恢复只保存轻量可浏览状态（浏览 revision、展开的相对路径、
 *   选中路径），节点内容按懒加载重新读取，不把 100k 条目搬进会话存储。
 *
 * 模型不执行 IO、不持有 AbortController、不接触 ReadRequestTicket：这些
 * 由面板控制器（panels/browse.ts）承担；模型只通过 requestSeq 判定回包
 * 归属，并通过待读队列（takeLoadRequests）把"需要读取哪个目录"交给
 * 控制器。
 */
import {
  entryNodeRef,
  type BrowseDirectoryListing,
  type BrowseDirectoryNames,
  type BrowserError,
  type RepoNodeRef,
} from '../../core/remoteBrowse';
import { format, strings } from '../i18n';
import type {
  ActionSpec,
  BannerSpec,
  DetailSectionSpec,
  DetailSpec,
  LazyTreeRowSpec,
  LazyTreeSpec,
  MasterDetailSpec,
  PanelState,
} from './state';

// ---------------------------------------------------------------------------
// 常量与冻结类型
// ---------------------------------------------------------------------------

/** 首批与每次“加载更多”的最大节点数（交互设计「失败与规模」）。 */
export const BROWSE_FIRST_BATCH = 40;

/** 大目录两段式阈值（技术方案 §3.2 定案，暂定 5,000）。 */
export const BROWSE_METADATA_THRESHOLD = 5_000;

/** 元数据补全任务默认并发（单节点 svn info）。 */
export const BROWSE_METADATA_CONCURRENCY = 4;

/** 树面板与详情面板的稳定标识（滚动保持键与测试定位）。 */
export const BROWSE_TREE_ID = 'browse';

export type BrowseNodePhase = 'idle' | 'loading' | 'ready' | 'error';

/** 两段式元数据状态：complete=元数据齐全；pending/filling/cancelled=名称模式。 */
export type BrowseMetadataState = 'complete' | 'pending' | 'filling' | 'cancelled';

/** 条目元数据：来自 list --xml 或单节点 info；缺失字段表示尚未补全。 */
export interface BrowseMeta {
  sizeBytes?: number;
  lastChangedRevision?: number;
  lastChangedAuthor?: string;
  lastChangedDate?: string;
}

/** 条目元数据是否已足以构建详情（不需要再发 info）。 */
export function hasBrowseMeta(meta: BrowseMeta): boolean {
  return meta.lastChangedRevision !== undefined;
}

/** 目录节点状态（技术方案 §3.3 的 BrowseNodeState 落地形态）。 */
export interface BrowseDirState {
  phase: BrowseNodePhase;
  /** 节点级读取代次：回包必须与当前值一致，否则丢弃。 */
  requestSeq: number;
  /** 已读取条目（紧凑；名称模式下元数据为空）。 */
  entries: BrowseEntryState[];
  /** 精确直属总数（ready 时）。 */
  total: number;
  /** 已下发视图的条目数（首批 40，加载更多 +40）。 */
  visible: number;
  metadata: BrowseMetadataState;
  /** 名称模式（两段式第一段）：元数据经选中 info 与后台任务补全。 */
  nameMode: boolean;
  /** 可见片元数据补全进度：total=可见条目数，completed=已补全数。 */
  metadataProgress: { completed: number; total: number };
  /** 待补全的可见条目索引。 */
  metadataQueue: number[];
  /** 正在补全的条目索引（避免重复取任务）。 */
  metadataInFlight: number[];
  /** 已入队处理到的可见片上界（只对新增片入队；失败条目不重复重试）。 */
  metadataEnqueuedUntil: number;
  /** 补全任务代次：取消/刷新递增，旧任务回包丢弃。 */
  metadataSeq: number;
  error?: BrowserError;
}

/** 树中的一个条目（父目录 entries 中的一项）。 */
export interface BrowseEntryState {
  name: string;
  kind: 'dir' | 'file';
  meta: BrowseMeta;
}

/** 树节点：根节点由入口 info 建立，子节点按父目录可见片懒创建。 */
export interface BrowseNodeState {
  /** 稳定展示 ID（仅本会话生命周期内稳定，不进会话存储）。 */
  id: string;
  /** 节点身份键：原始 URL（含编码，含 @/# 的 URL 也稳定）。 */
  key: string;
  parentKey: string | null;
  /** 父目录 entries 中的索引（根节点为空）。 */
  entryIndex?: number;
  name: string;
  kind: 'dir' | 'file';
  depth: number;
  /** 节点身份（仓库 UUID/根/快照 revision/最后修改）。 */
  ref: RepoNodeRef;
  expanded: boolean;
  selected: boolean;
  dir?: BrowseDirState;
  detailPhase: 'idle' | 'loading' | 'ready' | 'error';
  detailError?: BrowserError;
  /** 详情 info 请求代次（选中/重试递增，旧回包丢弃）。 */
  detailSeq: number;
}

/** 关闭重开恢复的轻量可浏览状态（写入 m4SessionStore.browsable）。 */
export interface BrowseBrowsableState {
  /** 本次浏览的入口原始 URL。 */
  entryUrl: string;
  /** 浏览快照 revision（重开时先按该 revision 读入口 info）。 */
  snapshotRevision: number;
  /** 已展开目录的仓库相对路径（根为空串，根恒展开不保存）。 */
  expandedPaths: string[];
  /** 选中节点的仓库相对路径（可选）。 */
  selectedPath?: string;
}

/** 打开阶段的信息（会话票据由控制器持有，模型只保留目标与来源）。 */
export interface BrowseModelOptions {
  threshold?: number;
  firstBatch?: number;
  metadataConcurrency?: number;
}

/** 控制器从模型取走的目录读取任务（loadQueue 消费）。 */
export interface BrowseLoadRequest {
  nodeKey: string;
  /** 节点读取代次；completeNode* / failNode 必须原样带回。 */
  requestSeq: number;
}

/** 控制器从模型取走的元数据补全任务（单节点 info）。 */
export interface BrowseMetadataTask {
  nodeKey: string;
  entryIndex: number;
  /** 条目节点 URL（原始编码）。 */
  url: string;
  /** 补全任务代次；applyMetadata 必须原样带回。 */
  metadataSeq: number;
}

/** 选中/恢复选中触发的详情 info 请求。 */
export interface BrowseDetailRequest {
  nodeKey: string;
  detailSeq: number;
}

/* ---------------------------------------------------------------------------
 * 本地文案（i18n.browsePanel 落地前的默认值；落地后自动优先取 i18n，
 * 与阶段 1 protocol.ts 的 INVALID_ENUM_DEFAULT 同一模式）。
 * ------------------------------------------------------------------------- */

const BROWSE_TEXT_DEFAULTS = {
  panelTitle: '仓库浏览',
  masterLabel: '目录树',
  detailLabel: '节点详情',
  openHint: '只读浏览远端仓库；不产生写命令，不在工作副本产生文件。',
  treeAriaLabel: '远端仓库目录树',
  openingTitle: '正在打开仓库…',
  openingDetail: '正在读取入口节点的仓库身份与浏览 revision。',
  emptyDir: '空目录',
  emptyTree: '没有可显示的节点',
  emptyTreeDetail: '展开目录或刷新仓库后重试。',
  detailEmpty: '选择左侧节点查看详情。',
  detailLoading: '正在读取节点信息…',
  detailFailed: '节点信息读取失败：{message}',
  rootFailedTitle: '无法打开仓库',
  loadFailedTitle: '目录读取失败',
  tooLargeTitle: '目录超出当前完整读取上限',
  tooLargeEntries: '直属条目超过 {limit} 条，未展示部分结果；可重试或关闭该目录。',
  tooLargeBytes: '目录清单超过 {limit} MiB，未展示部分结果；可重试或关闭该目录。',
  tooLargeBannerDetail: '{path}：{reason}',
  notFoundMessage: '路径在当前浏览 revision 不存在。',
  revisionNotFoundMessage: '浏览 revision r{revision} 不存在。',
  permissionMessage: '没有访问该路径的权限。',
  authCancelledMessage: '认证已取消，读取未完成；可重试。',
  networkMessage: '网络错误：{message}',
  unknownMessage: '读取失败：{message}',
  cancelMetadata: '取消元数据补全',
  metadataBannerDetail: '目录 {path} 的可见片正在补全；取消后保留已补全部分，未补全行保持占位。',
  metadataBannerMulti: '共 {count} 个目录正在补全可见片元数据；取消后保留已补全部分。',
  refreshHead: '刷新仓库（读取最新 HEAD）',
  refreshNode: '刷新',
  copyUrl: '复制原始 URL',
  openFile: '打开远端文件',
  openFileTooLarge: '文件大小 {size} 超过 {limit} 的临时资源上限，未打开。',
  openHistory: '查看变更日志',
  detailKindDir: '目录',
  detailKindFile: '文件',
  detailUrl: '节点 URL',
  detailRelativePath: '仓库相对路径',
  detailRepoRoot: '仓库根',
  detailSnapshot: '浏览快照 revision',
  detailLastChanged: '节点最后修改',
  detailAuthor: '最后修改作者',
  detailDate: '最后修改时间',
  detailSize: '文件大小',
  detailDirCounts: '已读取 / 总数',
  detailValueMissing: '—',
  snapshotBadge: '浏览 revision r{revision}',
  rootLabel: '仓库根',
  refreshAuth: '重新读取',
  copyUrlDone: '已复制原始 URL：{url}',
  urlCopiedLog: '已复制节点 URL：{url}',
  metadataProgressLine: '元数据补全中：已补全 {completed} / {total}',
  selectedSummary: '已选择：{name}',
} as const;

type BrowseTextKey = keyof typeof BROWSE_TEXT_DEFAULTS;

interface BrowsePanelStrings {
  readonly [key: string]: string | undefined;
}

/** i18n 已落地的 P5 专有文案（strings.browsePanel）；未落地时用本地默认值。 */
function browsePanelStrings(): BrowsePanelStrings | undefined {
  const candidate = (strings as unknown as { browsePanel?: BrowsePanelStrings }).browsePanel;
  return candidate;
}

/** 取 P5 文案：优先 i18n.browsePanel，回落本地默认中文；支持 {name} 占位。 */
export function browseText(key: BrowseTextKey, params: Record<string, string> = {}): string {
  const override = browsePanelStrings()?.[key];
  return format(override ?? BROWSE_TEXT_DEFAULTS[key], params);
}

/* ---------------------------------------------------------------------------
 * 模型主体
 * ------------------------------------------------------------------------- */

export class BrowseModel {
  private readonly threshold: number;
  private readonly firstBatch: number;
  readonly metadataConcurrency: number;

  private rootUrl = '';
  private rootKey: string | undefined;
  private snapshotRevision: number | undefined;
  private repositoryRootUrl: string | undefined;
  private repositoryUuid: string | undefined;
  private rootPhase: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  private rootError: BrowserError | undefined;
  private readonly nodes = new Map<string, BrowseNodeState>();
  private selectedKey: string | undefined;
  private nextNodeSeq = 0;
  private nextRequestSeq = 0;
  /** 待读取目录队列（控制器 takeLoadRequests 消费）。 */
  private pendingLoads: string[] = [];
  /** 重开恢复：待展开的相对路径与待选中的路径。 */
  private pendingExpandPaths: string[] = [];
  private pendingSelectPath: string | undefined;
  /** 控制器推送的持久提示（认证取消、打开失败等），由 dismissBanner 清除。 */
  private notices: BannerSpec[] = [];
  private noticeSeq = 0;
  /** 最近一次的 tooLarge 终态（banner 用）。 */
  private limitNotice: { nodeKey: string; path: string; reason: 'entries' | 'bytes'; limit: number } | undefined;

  constructor(options: BrowseModelOptions = {}) {
    this.threshold = options.threshold ?? BROWSE_METADATA_THRESHOLD;
    this.firstBatch = options.firstBatch ?? BROWSE_FIRST_BATCH;
    this.metadataConcurrency = options.metadataConcurrency ?? BROWSE_METADATA_CONCURRENCY;
  }

  /* ------------------------- 生命周期：打开与根身份 ------------------------- */

  /** 打开入口：记录 URL 与恢复状态；控制器随后读取入口 info。 */
  beginOpen(url: string, restore?: BrowseBrowsableState): void {
    this.rootUrl = url;
    this.rootPhase = 'loading';
    this.rootError = undefined;
    this.rootKey = undefined;
    this.snapshotRevision = restore?.snapshotRevision;
    this.nodes.clear();
    this.selectedKey = undefined;
    this.pendingLoads = [];
    this.limitNotice = undefined;
    this.notices = [];
    this.pendingExpandPaths = (restore?.expandedPaths ?? []).filter((path) => path !== '');
    this.pendingSelectPath = restore?.selectedPath;
  }

  /** 打开失败（入口 info 失败或入口节点在该 revision 不存在）。 */
  failOpen(error: BrowserError): void {
    this.rootPhase = 'error';
    this.rootError = error;
  }

  /** 入口 info 成功：建立根节点；目录默认展开并排队读取。 */
  applyRootInfo(node: RepoNodeRef): void {
    this.rootPhase = 'ready';
    this.rootError = undefined;
    this.rootKey = node.rawUrl;
    this.snapshotRevision = node.snapshotRevision;
    this.repositoryRootUrl = node.repositoryRootUrl;
    this.repositoryUuid = node.repositoryUuid;
    const root = this.createRootNode(node);
    this.nodes.set(root.key, root);
    if (root.kind === 'dir') {
      root.expanded = true;
      this.ensureDirState(root);
      this.pushLoad(root.key);
    } else {
      root.selected = true;
      this.selectedKey = root.key;
      root.detailPhase = 'ready';
    }
    this.advanceRestore();
  }

  /** 根刷新后重新应用入口 info（保持根显示位置；快照 revision 以新值为准）。 */
  applyRootRefresh(node: RepoNodeRef): void {
    const previousRoot = this.rootKey !== undefined ? this.nodes.get(this.rootKey) : undefined;
    const expanded = previousRoot?.expanded ?? true;
    const newRootKey = node.rawUrl;
    // 刷新根：清空全部后代与选中（后代缓存按原路径重新懒加载）。
    this.nodes.clear();
    this.selectedKey = undefined;
    this.pendingLoads = [];
    this.rootPhase = 'ready';
    this.rootError = undefined;
    this.rootKey = newRootKey;
    this.snapshotRevision = node.snapshotRevision;
    this.repositoryRootUrl = node.repositoryRootUrl;
    this.repositoryUuid = node.repositoryUuid;
    const root = this.createRootNode(node);
    this.nodes.set(root.key, root);
    if (root.kind === 'dir') {
      root.expanded = expanded;
      this.ensureDirState(root);
      this.pushLoad(root.key);
    } else {
      root.selected = true;
      this.selectedKey = root.key;
      root.detailPhase = 'ready';
    }
    this.advanceRestore();
  }

  private createRootNode(node: RepoNodeRef): BrowseNodeState {
    const name = node.relativePath === ''
      ? browseText('rootLabel')
      : node.relativePath.split('/').pop() ?? node.relativePath;
    return {
      id: `b${++this.nextNodeSeq}`,
      key: node.rawUrl,
      parentKey: null,
      name,
      kind: node.kind,
      depth: 0,
      ref: node,
      expanded: false,
      selected: false,
      detailPhase: 'idle',
      detailSeq: 0,
    };
  }

  /* ------------------------- 只读访问器 ------------------------- */

  get rootUrlValue(): string {
    return this.rootUrl;
  }

  get rootKeyValue(): string | undefined {
    return this.rootKey;
  }

  get snapshotRevisionValue(): number | undefined {
    return this.snapshotRevision;
  }

  get repositoryUuidValue(): string | undefined {
    return this.repositoryUuid;
  }

  get repositoryRootUrlValue(): string | undefined {
    return this.repositoryRootUrl;
  }

  get rootPhaseValue(): 'idle' | 'loading' | 'ready' | 'error' {
    return this.rootPhase;
  }

  get rootErrorValue(): BrowserError | undefined {
    return this.rootError;
  }

  get selectedNodeKey(): string | undefined {
    return this.selectedKey;
  }

  /** 恢复状态里记录的旧浏览 revision（控制器决定先按旧 revision 读入口）。 */
  get restoreRevision(): number | undefined {
    return this.snapshotRevision;
  }

  nodeById(id: string): BrowseNodeState | undefined {
    for (const node of this.nodes.values()) {
      if (node.id === id) {
        return node;
      }
    }
    return undefined;
  }

  nodeByKey(key: string): BrowseNodeState | undefined {
    return this.nodes.get(key);
  }

  selectedNode(): BrowseNodeState | undefined {
    return this.selectedKey !== undefined ? this.nodes.get(this.selectedKey) : undefined;
  }

  nodeCount(): number {
    return this.nodes.size;
  }

  /** 某目录节点的原始 URL 与仓库相对路径（详情/交接用）。 */
  nodeRefOf(key: string): RepoNodeRef | undefined {
    return this.nodes.get(key)?.ref;
  }

  /** 条目元数据（打开远端文件前取已知大小；名称模式可能为空对象）。 */
  entryMeta(key: string): BrowseMeta {
    const node = this.nodes.get(key);
    return node !== undefined ? this.metaOf(node) : {};
  }

  /* ------------------------- 目录读取状态机 ------------------------- */

  /**
   * 开始目录读取：设置 loading 并返回节点读取代次；节点不存在、非目录或
   * 已在 loading 时返回 undefined（重复展开不重复读取）。
   */
  beginNodeLoad(key: string): number | undefined {
    const node = this.nodes.get(key);
    if (!node || node.kind !== 'dir') {
      return undefined;
    }
    const dir = this.ensureDirState(node);
    if (dir.phase === 'loading') {
      return undefined;
    }
    // 读取已发起：从待读队列消费（控制器 takeLoadRequests 与本方法都可能在用）。
    this.pendingLoads = this.pendingLoads.filter((candidate) => candidate !== key);
    dir.requestSeq = ++this.nextRequestSeq;
    dir.phase = 'loading';
    dir.error = undefined;
    return dir.requestSeq;
  }

  /** 回包归属：节点仍在树中且代次匹配。 */
  isNodeRequestCurrent(key: string, requestSeq: number): boolean {
    const dir = this.nodes.get(key)?.dir;
    return dir !== undefined && dir.requestSeq === requestSeq;
  }

  /**
   * 第一段（无元数据名称列表）完成：
   * - 超过阈值 → 立即 ready（metadata pending）并返回 'done'；
   * - 不超过阈值 → 返回 'branch'，控制器继续读取 `list --xml` 完整元数据；
   * - 代次过期/节点不存在 → 'stale'（回包丢弃）。
   */
  completeNodeNames(key: string, requestSeq: number, listing: BrowseDirectoryNames): 'branch' | 'done' | 'stale' {
    const node = this.nodes.get(key);
    const dir = node?.dir;
    if (!node || !dir || dir.requestSeq !== requestSeq) {
      return 'stale';
    }
    if (listing.total > this.threshold) {
      dir.entries = listing.entries.map((entry) => ({ name: entry.name, kind: entry.kind, meta: {} }));
      dir.total = listing.total;
      dir.visible = Math.min(this.firstBatch, dir.total);
      dir.nameMode = dir.total > 0;
      dir.metadata = dir.nameMode ? 'pending' : 'complete';
      dir.metadataProgress = { completed: 0, total: 0 };
      dir.metadataQueue = [];
      dir.metadataInFlight = [];
      dir.metadataEnqueuedUntil = 0;
      dir.phase = 'ready';
      dir.error = undefined;
      this.enqueueVisibleMetadata(node, dir);
      return 'done';
    }
    return 'branch';
  }

  /** 常规目录（≤阈值）完整 XML 元数据到达：ready + metadata complete。 */
  completeNodeListing(key: string, requestSeq: number, listing: BrowseDirectoryListing): boolean {
    const node = this.nodes.get(key);
    const dir = node?.dir;
    if (!node || !dir || dir.requestSeq !== requestSeq) {
      return false;
    }
    dir.entries = listing.entries.map((entry) => {
      const meta: BrowseMeta = {};
      if (entry.sizeBytes !== undefined) {
        meta.sizeBytes = entry.sizeBytes;
      }
      if (entry.lastChangedRevision !== undefined) {
        meta.lastChangedRevision = entry.lastChangedRevision;
      }
      if (entry.lastChangedAuthor !== undefined) {
        meta.lastChangedAuthor = entry.lastChangedAuthor;
      }
      if (entry.lastChangedDate !== undefined) {
        meta.lastChangedDate = entry.lastChangedDate;
      }
      return { name: entry.name, kind: entry.kind, meta };
    });
    dir.total = listing.total;
    dir.visible = Math.min(this.firstBatch, dir.total);
    // XML 模式已携带完整元数据：没有补全任务，加载更多直接复用内存条目。
    dir.nameMode = false;
    dir.metadata = 'complete';
    dir.metadataProgress = { completed: 0, total: 0 };
    dir.metadataQueue = [];
    dir.metadataInFlight = [];
    dir.metadataEnqueuedUntil = 0;
    dir.phase = 'ready';
    dir.error = undefined;
    return true;
  }

  /** 目录越限（100k 条目 / 64 MiB）：tooLarge 终态，不保留部分条目。 */
  completeNodeTooLarge(
    key: string,
    requestSeq: number,
    info: { reason: 'entries' | 'bytes'; limit: number },
  ): boolean {
    const node = this.nodes.get(key);
    const dir = node?.dir;
    if (!node || !dir || dir.requestSeq !== requestSeq) {
      return false;
    }
    dir.entries = [];
    dir.total = 0;
    dir.visible = 0;
    dir.phase = 'error';
    dir.error = {
      kind: 'tooLarge',
      message: info.reason === 'entries'
        ? browseText('tooLargeEntries', { limit: String(info.limit) })
        : browseText('tooLargeBytes', { limit: String(Math.floor(info.limit / (1024 * 1024))) }),
      codes: [],
    };
    this.limitNotice = {
      nodeKey: key,
      path: this.displayPathOf(node),
      reason: info.reason,
      limit: info.limit,
    };
    return true;
  }

  /** 目录读取失败：cancelled 回到 idle（无错误展示），其余写节点错误。 */
  failNode(key: string, requestSeq: number, error: BrowserError): boolean {
    const node = this.nodes.get(key);
    const dir = node?.dir;
    if (!node || !dir || dir.requestSeq !== requestSeq) {
      return false;
    }
    if (error.kind === 'cancelled') {
      dir.phase = 'idle';
      return true;
    }
    dir.phase = 'error';
    dir.error = error;
    dir.entries = [];
    dir.total = 0;
    dir.visible = 0;
    return true;
  }

  /* ------------------------- 展开 / 折叠 / 选中 ------------------------- */

  /**
   * 展开或折叠目录节点（展开≠选中）。折叠会删除全部后代缓存并清空
   * 后代选中；返回被删除的节点键，供控制器终止在途请求与补全任务。
   */
  toggleNode(key: string): { action: 'expand' | 'collapse' | 'none'; needLoad: boolean; removed: string[] } {
    const node = this.nodes.get(key);
    if (!node || node.kind !== 'dir') {
      return { action: 'none', needLoad: false, removed: [] };
    }
    if (node.expanded) {
      node.expanded = false;
      const removed = this.removeDescendants(key);
      this.clearSelectionIfRemoved(removed);
      return { action: 'collapse', needLoad: false, removed };
    }
    node.expanded = true;
    const dir = this.ensureDirState(node);
    let needLoad = false;
    if (dir.phase !== 'ready') {
      this.pushLoad(key);
      needLoad = true;
    } else if (dir.metadata !== 'complete') {
      // 已 ready 的名称列表：恢复/继续可见片补全（不重读目录）。
      this.enqueueVisibleMetadata(node, dir);
    }
    return { action: 'expand', needLoad, removed: [] };
  }

  /**
   * 选中节点：返回是否需要单节点 info 补全详情。已有元数据（XML 模式
   * 或此前已补全）时不重复请求；名称模式缺失时置详情 loading 并返回
   * 请求代次。
   */
  selectNode(key: string): { ok: boolean; detail?: BrowseDetailRequest } {
    const node = this.nodes.get(key);
    if (!node) {
      return { ok: false };
    }
    for (const candidate of this.nodes.values()) {
      candidate.selected = false;
    }
    node.selected = true;
    this.selectedKey = key;
    node.detailSeq = ++this.nextRequestSeq;
    const meta = this.metaOf(node);
    if (node.ref !== undefined && hasBrowseMeta(meta)) {
      node.detailPhase = 'ready';
      node.detailError = undefined;
      return { ok: true };
    }
    node.detailPhase = 'loading';
    node.detailError = undefined;
    return { ok: true, detail: { nodeKey: key, detailSeq: node.detailSeq } };
  }

  /**
   * 选中节点的 info 回包：写回条目元数据与详情；代次过期丢弃。
   * 返回是否被接受。
   */
  applyDetailInfo(
    key: string,
    detailSeq: number,
    result: { ref: RepoNodeRef; sizeBytes?: number } | { error: BrowserError },
  ): boolean {
    const node = this.nodes.get(key);
    if (!node || node.detailSeq !== detailSeq) {
      return false;
    }
    if ('error' in result) {
      node.detailPhase = 'error';
      node.detailError = result.error;
      return true;
    }
    node.ref = result.ref;
    node.detailPhase = 'ready';
    node.detailError = undefined;
    if (node.parentKey !== null && node.entryIndex !== undefined) {
      // 同步父目录条目的元数据：列表行的占位被单节点 info 即时补全。
      const parent = this.nodes.get(node.parentKey);
      const parentDir = parent?.dir;
      const entryIndex = node.entryIndex;
      if (parent !== undefined && parentDir !== undefined && entryIndex !== undefined) {
        // 写入条目元数据（只在写前缺失时计入补全进度），并把该条目移出
        // 补全队列/在途（若后台任务并行命中，回包会因 meta 已完整跳过计数）。
        this.completeEntryMetadata(parentDir, entryIndex, this.metaFromRef(result.ref, result.sizeBytes));
        this.finalizeMetadataForEntry(parent, entryIndex);
      }
    }
    return true;
  }

  /** 详情信息请求是否仍然有效（选中未变、代次匹配）。 */
  isDetailRequestCurrent(key: string, detailSeq: number): boolean {
    return this.nodes.get(key)?.detailSeq === detailSeq;
  }

  /* ------------------------- 加载更多 ------------------------- */

  /**
   * 目录节点“加载更多”：可见片最多增加一批（≤40）。名称模式下新可见
   * 片进入元数据补全队列（取消后再次加载会恢复补全）。
   */
  loadMore(key: string): { added: number } {
    const node = this.nodes.get(key);
    const dir = node?.dir;
    if (!node || !dir || dir.phase !== 'ready') {
      return { added: 0 };
    }
    const next = Math.min(dir.total, dir.visible + this.firstBatch);
    const added = next - dir.visible;
    dir.visible = next;
    if (added > 0) {
      if (dir.nameMode && dir.metadata === 'complete') {
        dir.metadata = 'pending';
      }
      this.enqueueVisibleMetadata(node, dir);
    }
    return { added };
  }

  /**
   * 构建目录节点可见片 `[start, start + count)` 的节点行（append 增量
   * 通道专用）：只构建新增切片，不重走整棵树。目标节点未展开或目录未
   * ready 时返回空数组（调用方随后依赖整段 render 兜底）。
   */
  buildNodeSlice(key: string, start: number, count: number): LazyTreeRowSpec[] {
    const node = this.nodes.get(key);
    const dir = node?.dir;
    if (!node || !dir || dir.phase !== 'ready' || !node.expanded) {
      return [];
    }
    const from = Math.max(0, start);
    const end = Math.min(from + Math.max(0, count), dir.visible, dir.entries.length);
    const rows: LazyTreeRowSpec[] = [];
    for (let index = from; index < end; index += 1) {
      const child = this.ensureChildNode(node, index);
      if (child !== undefined) {
        rows.push(this.buildNodeRow(child));
      }
    }
    return rows;
  }

  /* ------------------------- 刷新 / 重试 ------------------------- */

  /**
   * 刷新或重试一个节点（重试只请求原 URL，不回退父目录、不使用旧计数）：
   * - 根目录：清空整棵树（保留根身份），控制器先读 HEAD info 再
   *   applyRootRefresh；
   * - 其他目录：清空该节点读取状态与全部后代，保持展开后重新读取；
   * - 文件：重置详情，返回需要重新 info 的请求。
   */
  reloadNode(key: string): {
    kind: 'root' | 'node' | 'detail' | 'none';
    detail?: BrowseDetailRequest;
    removed: string[];
  } {
    const node = this.nodes.get(key);
    if (!node) {
      return { kind: 'none', removed: [] };
    }
    if (key === this.rootKey) {
      this.rootPhase = 'loading';
      this.rootError = undefined;
      const removed = [...this.nodes.keys()];
      this.nodes.clear();
      this.selectedKey = undefined;
      this.pendingLoads = [];
      this.limitNotice = undefined;
      return { kind: 'root', removed };
    }
    if (node.kind === 'dir') {
      const removed = this.removeDescendants(key);
      this.clearSelectionIfRemoved(removed);
      node.dir = undefined;
      node.expanded = true;
      this.ensureDirState(node);
      this.pushLoad(key);
      return { kind: 'node', removed };
    }
    node.detailSeq = ++this.nextRequestSeq;
    node.detailPhase = 'loading';
    node.detailError = undefined;
    return { kind: 'detail', detail: { nodeKey: key, detailSeq: node.detailSeq }, removed: [] };
  }

  /* ------------------------- 元数据补全（两段式第二段） ------------------------- */

  /** 取元数据补全任务（总数受并发上限约束，跨节点共享）。 */
  metadataTasks(limit: number = this.metadataConcurrency): BrowseMetadataTask[] {
    const tasks: BrowseMetadataTask[] = [];
    if (limit <= 0) {
      return tasks;
    }
    let inFlightTotal = 0;
    for (const node of this.nodes.values()) {
      if (node.dir !== undefined) {
        inFlightTotal += node.dir.metadataInFlight.length;
      }
    }
    for (const node of this.nodes.values()) {
      if (tasks.length >= limit || inFlightTotal >= this.metadataConcurrency) {
        break;
      }
      const dir = node.dir;
      if (!dir || dir.phase !== 'ready') {
        continue;
      }
      if (dir.metadata !== 'pending' && dir.metadata !== 'filling') {
        continue;
      }
      while (
        dir.metadataQueue.length > 0
        && tasks.length < limit
        && inFlightTotal < this.metadataConcurrency
      ) {
        const entryIndex = dir.metadataQueue.shift() as number;
        if (entryIndex >= dir.entries.length) {
          continue;
        }
        const entry = dir.entries[entryIndex];
        if (hasBrowseMeta(entry.meta)) {
          // 已由选中 info 或前次任务补全：跳过且不重复计数。
          continue;
        }
        dir.metadata = 'filling';
        dir.metadataInFlight.push(entryIndex);
        inFlightTotal += 1;
        tasks.push({
          nodeKey: node.key,
          entryIndex,
          url: this.childUrlOf(node, entry),
          metadataSeq: dir.metadataSeq,
        });
      }
      this.finishMetadataIfIdle(dir);
    }
    return tasks;
  }

  /** 补全任务代次是否有效（取消/刷新后旧回包丢弃）。 */
  isMetadataTaskCurrent(nodeKey: string, metadataSeq: number): boolean {
    return this.nodes.get(nodeKey)?.dir?.metadataSeq === metadataSeq;
  }

  /**
   * 补全回包：成功时写入条目元数据并推进进度（失败条目保持占位且
   * 不重复计入“已补全”，也不自动重试）。代次过期时丢弃。
   */
  applyMetadata(
    nodeKey: string,
    entryIndex: number,
    metadataSeq: number,
    result: BrowseMeta | { error: BrowserError },
  ): boolean {
    const node = this.nodes.get(nodeKey);
    const dir = node?.dir;
    if (!node || !dir || dir.metadataSeq !== metadataSeq) {
      return false;
    }
    const inFlightIndex = dir.metadataInFlight.indexOf(entryIndex);
    if (inFlightIndex >= 0) {
      dir.metadataInFlight.splice(inFlightIndex, 1);
    }
    if (!('error' in result)) {
      this.completeEntryMetadata(dir, entryIndex, result);
    }
    this.finishMetadataIfIdle(dir);
    return true;
  }

  /**
   * 取消元数据补全：指定节点或全部。取消递增补全代次（在途回包全部
   * 过期），已补全条目保留，未补全行保持占位。返回被取消的节点键。
   */
  cancelMetadata(nodeKey?: string): string[] {
    const cancelled: string[] = [];
    const targets = nodeKey !== undefined
      ? [this.nodes.get(nodeKey)].filter((node): node is BrowseNodeState => node !== undefined)
      : [...this.nodes.values()];
    for (const node of targets) {
      const dir = node.dir;
      if (!dir) {
        continue;
      }
      if (dir.metadata !== 'pending' && dir.metadata !== 'filling') {
        continue;
      }
      dir.metadataSeq += 1;
      dir.metadataQueue = [];
      dir.metadataInFlight = [];
      dir.metadata = 'cancelled';
      cancelled.push(node.key);
    }
    return cancelled;
  }

  /** 正在补全的目录摘要（banner 汇总用）。 */
  metadataFillingNodes(): Array<{ nodeKey: string; name: string; completed: number; total: number }> {
    const filling: Array<{ nodeKey: string; name: string; completed: number; total: number }> = [];
    for (const node of this.nodes.values()) {
      const dir = node.dir;
      if (!dir) {
        continue;
      }
      const hasWork = dir.metadata === 'filling'
        || (dir.metadata === 'pending' && (dir.metadataQueue.length > 0 || dir.metadataInFlight.length > 0));
      if (hasWork) {
        filling.push({
          nodeKey: node.key,
          name: node.name,
          completed: dir.metadataProgress.completed,
          total: dir.metadataProgress.total,
        });
      }
    }
    return filling;
  }

  /** 是否有任何目录需要补全任务（控制器决定是否启动泵）。 */
  hasMetadataWork(): boolean {
    for (const node of this.nodes.values()) {
      const dir = node.dir;
      if (!dir) {
        continue;
      }
      if ((dir.metadata === 'pending' || dir.metadata === 'filling')
        && (dir.metadataQueue.length > 0 || dir.metadataInFlight.length > 0)) {
        return true;
      }
    }
    return false;
  }

  /* ------------------------- 待读取队列与恢复 ------------------------- */

  /** 取走全部待读目录键（控制器逐个 beginNodeLoad 并发起 IO）。 */
  takeLoadRequests(): string[] {
    const requests = this.pendingLoads;
    this.pendingLoads = [];
    return requests;
  }

  /**
   * 目录 ready 后的恢复推进：把可定位的待展开路径展开，尝试恢复选中。
   * 返回需要控制器执行详情 info 的请求（恢复选中且元数据缺失时）。
   */
  advanceRestore(): { detail?: BrowseDetailRequest } {
    if (this.pendingExpandPaths.length === 0 && this.pendingSelectPath === undefined) {
      return {};
    }
    // 先构建当前帧可见行（懒创建节点）；恢复路径可能落在已读取但
    // 尚未上屏的条目上，按路径解析时会把可见片扩大到命中索引。
    this.buildTreeRows();
    const remaining: string[] = [];
    for (const path of this.pendingExpandPaths) {
      const walk = this.walkPath(path);
      // 展开路径上每一级已到达的目录（深层目录等其父目录读取完成后再
      // 由下一次 advanceRestore 继续）。
      for (const node of walk.chain) {
        if (node.kind !== 'dir') {
          break;
        }
        node.expanded = true;
        const dir = this.ensureDirState(node);
        if (dir.phase !== 'ready') {
          this.pushLoad(node.key);
        }
      }
      if (!walk.complete) {
        remaining.push(path);
      }
    }
    this.pendingExpandPaths = remaining;
    if (this.pendingSelectPath !== undefined) {
      const walk = this.walkPath(this.pendingSelectPath);
      if (walk.complete && walk.reached !== undefined) {
        this.pendingSelectPath = undefined;
        const result = this.selectNode(walk.reached.key);
        if (result.detail !== undefined) {
          return { detail: result.detail };
        }
      }
    }
    return {};
  }

  /* ------------------------- 提示（banner） ------------------------- */

  /** 控制器推送持久提示（认证取消、打开文件失败等）；返回 banner ID。 */
  pushNotice(level: BannerSpec['level'], title: string, detail?: string): string {
    const id = `browseNotice-${++this.noticeSeq}`;
    const banner: BannerSpec = { id, level, title };
    if (detail !== undefined) {
      banner.detail = detail;
    }
    this.notices.push(banner);
    // 只保留最近 3 条提示，避免连续失败堆满页面。
    if (this.notices.length > 3) {
      this.notices.splice(0, this.notices.length - 3);
    }
    return id;
  }

  /** 关闭一条提示（dismissBanner 意图）；返回是否存在。 */
  dismissNotice(id: string): boolean {
    const index = this.notices.findIndex((banner) => banner.id === id);
    if (index < 0) {
      return false;
    }
    this.notices.splice(index, 1);
    return true;
  }

  clearLimitNotice(): void {
    this.limitNotice = undefined;
  }

  /* ------------------------- 可浏览状态（会话恢复） ------------------------- */

  /** 轻量可浏览状态：浏览 revision + 展开路径 + 选中路径。 */
  browsableState(): BrowseBrowsableState | undefined {
    if (this.rootKey === undefined || this.snapshotRevision === undefined) {
      return undefined;
    }
    const expandedPaths: string[] = [];
    for (const node of this.nodes.values()) {
      if (node.parentKey !== null && node.kind === 'dir' && node.expanded) {
        expandedPaths.push(this.pathRelativeToRoot(node));
      }
    }
    const state: BrowseBrowsableState = {
      entryUrl: this.rootUrl,
      snapshotRevision: this.snapshotRevision,
      expandedPaths,
    };
    const selected = this.selectedNode();
    if (selected !== undefined) {
      state.selectedPath = this.pathRelativeToRoot(selected);
    }
    return state;
  }

  /* ------------------------- 视图构建（PanelState） ------------------------- */

  /** 树行：根 + 已展开目录的可见片（不递归未读取内容）。 */
  buildTreeRows(): LazyTreeRowSpec[] {
    if (this.rootKey === undefined) {
      return [];
    }
    const root = this.nodes.get(this.rootKey);
    if (root === undefined) {
      return [];
    }
    return [this.buildNodeRow(root)];
  }

  /** 构建完整面板状态（宿主每帧推送）。 */
  buildPanelState(sessionId: string): PanelState {
    const layout: MasterDetailSpec = {
      layout: 'master-detail',
      masterLabel: browseText('masterLabel'),
      detailLabel: browseText('detailLabel'),
      masterScrollKey: 'browse-tree',
      detailScrollKey: 'browse-detail',
    };
    const rows = this.buildTreeRows();
    const tree: LazyTreeSpec = {
      id: BROWSE_TREE_ID,
      ariaLabel: browseText('treeAriaLabel'),
      rows,
      empty: this.buildTreeEmpty(),
    };
    const rootLoadMore = this.rootLoadMoreAction();
    if (rootLoadMore !== undefined) {
      tree.loadMoreAction = rootLoadMore;
    }
    if (this.rootPhase === 'loading' || this.rootPhase === 'idle') {
      tree.busy = true;
    }
    const state: PanelState = {
      sessionId,
      title: browseText('panelTitle'),
      targetLabel: this.targetLabel(),
      revision: 0,
      formRevision: 0,
      busy: false,
      banners: this.buildBanners(),
      layout,
      lazyTree: tree,
      hint: this.buildHint(),
      headerBadges: this.buildHeaderBadges(),
      // 页脚主按钮复用通用 refresh 意图（控制器解释为「刷新根/读新 HEAD」）；
      // 任意目录行的行内刷新按钮负责局部刷新。
      footer: {
        summary: this.buildFooterSummary(),
        primary: { id: 'refresh', label: browseText('refreshHead') },
      },
    };
    const detail = this.buildDetail();
    if (detail !== undefined) {
      state.detail = detail;
    }
    return state;
  }

  private buildTreeEmpty(): { title: string; detail?: string } {
    if (this.rootPhase === 'loading' || this.rootPhase === 'idle') {
      return { title: browseText('openingTitle'), detail: browseText('openingDetail') };
    }
    if (this.rootPhase === 'error') {
      const error = this.rootError ?? { kind: 'unknown', message: '', codes: [] };
      return {
        title: browseText('rootFailedTitle'),
        detail: this.errorTitle(error),
      };
    }
    return { title: browseText('emptyTree'), detail: browseText('emptyTreeDetail') };
  }

  private buildHint(): string {
    if (this.rootPhase !== 'ready' || this.repositoryRootUrl === undefined) {
      return browseText('openHint');
    }
    return `${browseText('openHint')} ${format(strings.historyPanel.repositoryUrl, { url: this.repositoryRootUrl })}`;
  }

  private buildHeaderBadges(): PanelState['headerBadges'] {
    if (this.snapshotRevision === undefined || this.rootPhase !== 'ready') {
      return [];
    }
    return [{ text: browseText('snapshotBadge', { revision: String(this.snapshotRevision) }) }];
  }

  private buildFooterSummary(): string {
    if (this.rootPhase !== 'ready') {
      return browseText('panelTitle');
    }
    const root = this.rootKey !== undefined ? this.nodes.get(this.rootKey) : undefined;
    const rootDir = root?.dir;
    if (rootDir !== undefined && rootDir.phase === 'ready') {
      const base = format(strings.panel.nodeLoadedTotal, {
        loaded: String(rootDir.entries.length),
        total: String(rootDir.total),
      });
      const selected = this.selectedNode();
      if (selected !== undefined) {
        return `${base} · ${browseText('selectedSummary', { name: selected.name })}`;
      }
      return base;
    }
    return browseText('panelTitle');
  }

  private targetLabel(): string {
    if (this.rootKey !== undefined) {
      const root = this.nodes.get(this.rootKey);
      if (root !== undefined) {
        return root.ref.relativePath === ''
          ? root.ref.repositoryRootUrl
          : `^/${root.ref.relativePath}`;
      }
    }
    return this.rootUrl;
  }

  private buildBanners(): BannerSpec[] {
    const banners: BannerSpec[] = [...this.notices];
    if (this.rootPhase === 'error' && this.rootError !== undefined) {
      banners.unshift({
        id: 'browseRootError',
        level: 'error',
        title: browseText('rootFailedTitle'),
        detail: this.errorTitle(this.rootError),
        // 持久判定性提示：重试入口挂在横幅上，不渲染 ×（关闭后无恢复入口）。
        dismissable: false,
        actions: [{ id: 'retryBrowseRoot', label: browseText('refreshAuth') }],
      });
    }
    if (this.limitNotice !== undefined) {
      const notice = this.limitNotice;
      const reason = notice.reason === 'entries'
        ? browseText('tooLargeEntries', { limit: String(notice.limit) })
        : browseText('tooLargeBytes', { limit: String(Math.floor(notice.limit / (1024 * 1024))) });
      banners.push({
        id: 'browseTooLargeNode',
        level: 'warn',
        title: browseText('tooLargeTitle'),
        detail: browseText('tooLargeBannerDetail', { path: notice.path, reason }),
      });
    }
    const filling = this.metadataFillingNodes();
    if (filling.length > 0) {
      const completed = filling.reduce((sum, entry) => sum + entry.completed, 0);
      const total = filling.reduce((sum, entry) => sum + entry.total, 0);
      banners.push({
        id: 'browseMetadata',
        level: 'info',
        title: browseText('metadataProgressLine', { completed: String(completed), total: String(total) }),
        detail: filling.length === 1
          ? browseText('metadataBannerDetail', { path: filling[0].name })
          : browseText('metadataBannerMulti', { count: String(filling.length) }),
        actions: [{ id: 'cancelBrowserMetadata', label: browseText('cancelMetadata') }],
        dismissable: false,
      });
    }
    return banners;
  }

  private buildDetail(): DetailSpec | undefined {
    const node = this.selectedNode();
    if (node === undefined) {
      if (this.rootPhase !== 'ready') {
        return undefined;
      }
      return {
        title: browseText('detailEmpty'),
        sections: [],
      };
    }
    const meta = this.metaOf(node);
    const sections: DetailSectionSpec[] = [];
    const kindLabel = node.kind === 'dir' ? browseText('detailKindDir') : browseText('detailKindFile');
    const kv: DetailSectionSpec = {
      kind: 'kv',
      heading: kindLabel,
      entries: [
        { label: browseText('detailUrl'), value: node.ref.rawUrl, mono: true },
        {
          label: browseText('detailRelativePath'),
          value: `^/${node.ref.relativePath}`,
          mono: true,
        },
        {
          label: browseText('detailRepoRoot'),
          value: this.repositoryRootUrl ?? node.ref.repositoryRootUrl,
          mono: true,
        },
        {
          label: browseText('detailSnapshot'),
          value: this.snapshotRevision !== undefined ? `r${this.snapshotRevision}` : browseText('detailValueMissing'),
        },
        {
          label: browseText('detailLastChanged'),
          value: meta.lastChangedRevision !== undefined
            ? `r${meta.lastChangedRevision}`
            : browseText('detailValueMissing'),
        },
        {
          label: browseText('detailAuthor'),
          value: meta.lastChangedAuthor ?? browseText('detailValueMissing'),
        },
        {
          label: browseText('detailDate'),
          value: meta.lastChangedDate ?? browseText('detailValueMissing'),
        },
      ],
    };
    if (node.kind === 'file') {
      kv.entries.push({
        label: browseText('detailSize'),
        value: meta.sizeBytes !== undefined
          ? formatBytes(meta.sizeBytes)
          : browseText('detailValueMissing'),
      });
    }
    const dir = node.dir;
    if (node.kind === 'dir' && dir !== undefined && dir.phase === 'ready') {
      kv.entries.push({
        label: browseText('detailDirCounts'),
        value: `${dir.entries.length} / ${dir.total}`,
      });
    }
    sections.push(kv);
    if (node.detailPhase === 'loading') {
      sections.push({ kind: 'text', paragraphs: [browseText('detailLoading')] });
    } else if (node.detailPhase === 'error' && node.detailError !== undefined) {
      sections.push({
        kind: 'text',
        paragraphs: [browseText('detailFailed', { message: this.errorTitle(node.detailError) })],
      });
    }
    const actions: ActionSpec[] = [
      {
        id: 'copyBrowserNodeUrl',
        label: browseText('copyUrl'),
        payload: { 'node-id': node.id },
      },
    ];
    if (node.kind === 'file') {
      actions.push({
        id: 'openRemoteNode',
        label: browseText('openFile'),
        payload: { 'node-id': node.id },
      });
    }
    actions.push({
      id: 'openHistoryFromBrowser',
      label: browseText('openHistory'),
      payload: { 'node-id': node.id },
    });
    sections.push({ kind: 'actions', actions });
    return {
      title: node.name,
      subtitle: `${kindLabel} · ${node.ref.relativePath === '' ? '^/' : `^/${node.ref.relativePath}`}`,
      sections,
    };
  }

  /* ------------------------- 行构建 ------------------------- */

  private buildNodeRow(node: BrowseNodeState): LazyTreeRowSpec {
    const dir = node.dir;
    const phase: LazyTreeRowSpec['phase'] = node.kind === 'dir'
      ? (dir?.phase ?? 'idle')
      : 'ready';
    const row: LazyTreeRowSpec = {
      id: node.id,
      label: node.name,
      kind: node.kind,
      depth: node.depth,
      phase,
      expanded: node.kind === 'dir' ? node.expanded : undefined,
      selected: node.selected,
    };
    if (node.kind === 'dir') {
      row.expandLabel = format(
        node.expanded ? strings.panel.treeCollapseLabel : strings.panel.treeExpandLabel,
        { path: node.name },
      );
    }
    row.selectLabel = format(strings.panel.nodeSelectLabel, { path: node.name });
    // 行次级信息与自身元数据：宿主按 i18n 生成展示文本，视图只排版。
    row.kindLabel = node.kind === 'dir' ? browseText('detailKindDir') : browseText('detailKindFile');
    row.nodeUrl = node.ref.rawUrl;
    row.repoPath = node.ref.relativePath === '' ? '^/' : `^/${node.ref.relativePath}`;
    const meta = this.metaOf(node);
    const lastChanged: { revision?: string; author?: string; date?: string } = {};
    if (meta.lastChangedRevision !== undefined) {
      lastChanged.revision = `r${meta.lastChangedRevision}`;
    }
    if (meta.lastChangedAuthor !== undefined) {
      lastChanged.author = meta.lastChangedAuthor;
    }
    if (meta.lastChangedDate !== undefined) {
      lastChanged.date = meta.lastChangedDate;
    }
    if (Object.keys(lastChanged).length > 0) {
      row.lastChanged = lastChanged;
    }
    if (node.kind === 'file' && meta.sizeBytes !== undefined) {
      row.metaText = formatBytes(meta.sizeBytes);
    }
    if (dir !== undefined && dir.phase === 'ready') {
      row.loaded = dir.entries.length;
      row.total = dir.total;
      row.metadata = dir.metadata;
      if (dir.metadata === 'filling' || dir.metadata === 'cancelled' || dir.metadataProgress.total > 0) {
        row.metadataProgress = {
          completed: dir.metadataProgress.completed,
          total: dir.metadataProgress.total,
        };
      }
      row.statusText = this.dirStatusText(dir);
      if (dir.total === 0) {
        row.emptyText = browseText('emptyDir');
      }
      if (dir.metadata === 'pending' || dir.metadata === 'filling') {
        // 行内取消入口复用 refreshBrowserNode 意图承载取消语义（协议无专用
        // 意图）；控制器对补全中的目录只取消补全，不重读。
        row.metadataCancelAction = { id: 'refreshBrowserNode', label: browseText('cancelMetadata') };
      }
    } else if (dir !== undefined && dir.phase === 'loading') {
      row.statusText = strings.panel.nodeLoading;
    } else if (dir !== undefined && dir.phase === 'error' && dir.error !== undefined) {
      row.statusText = this.errorTitle(dir.error);
      if (dir.error.kind === 'tooLarge') {
        row.tooLarge = true;
      }
    }
    const actions: ActionSpec[] = [];
    if (node.kind === 'dir') {
      if (dir !== undefined && dir.phase === 'error') {
        actions.push({ id: 'retryBrowserNode', label: strings.panel.retryNode });
      } else if (dir !== undefined && dir.phase === 'ready') {
        if (dir.visible < dir.total) {
          // 根节点的“加载更多”复用树级按钮，其余目录用行内按钮。
          if (node.parentKey !== null) {
            actions.push({ id: 'loadMoreBrowserNode', label: strings.panel.loadMoreBrowser });
          }
        }
        // 补全中的目录行内入口是「取消补全」，不并列刷新（同一意图承载）。
        if (dir.metadata !== 'pending' && dir.metadata !== 'filling') {
          actions.push({ id: 'refreshBrowserNode', label: browseText('refreshNode') });
        }
      } else if (dir !== undefined && dir.phase === 'idle') {
        actions.push({ id: 'refreshBrowserNode', label: browseText('refreshNode') });
      }
    }
    if (actions.length > 0) {
      row.actions = actions;
    }
    if (node.kind === 'dir' && node.expanded && dir !== undefined && dir.phase === 'ready') {
      const children: LazyTreeRowSpec[] = [];
      const visible = Math.min(dir.visible, dir.entries.length);
      for (let index = 0; index < visible; index += 1) {
        const child = this.ensureChildNode(node, index);
        if (child !== undefined) {
          children.push(this.buildNodeRow(child));
        }
      }
      if (children.length > 0) {
        row.children = children;
      }
    }
    return row;
  }

  private rootLoadMoreAction(): ActionSpec | undefined {
    if (this.rootKey === undefined) {
      return undefined;
    }
    const root = this.nodes.get(this.rootKey);
    const dir = root?.dir;
    if (root === undefined || dir === undefined || dir.phase !== 'ready' || dir.visible >= dir.total) {
      return undefined;
    }
    return {
      id: 'loadMoreBrowserNode',
      label: strings.panel.loadMoreBrowser,
      payload: { 'node-id': root.id },
    };
  }

  private dirStatusText(dir: BrowseDirState): string {
    if (dir.total === 0) {
      return browseText('emptyDir');
    }
    const base = format(strings.panel.nodeLoadedTotal, {
      loaded: String(dir.entries.length),
      total: String(dir.total),
    });
    if (dir.metadata === 'cancelled') {
      return `${base} · ${strings.panel.metadataCancelled}`;
    }
    if (dir.metadata === 'pending') {
      return `${base} · ${strings.panel.metadataPending}`;
    }
    return base;
  }

  /* ------------------------- 内部辅助 ------------------------- */

  private ensureDirState(node: BrowseNodeState): BrowseDirState {
    const existing = node.dir;
    if (existing !== undefined) {
      return existing;
    }
    const created: BrowseDirState = {
      phase: 'idle',
      requestSeq: 0,
      entries: [],
      total: 0,
      visible: 0,
      metadata: 'complete',
      nameMode: false,
      metadataProgress: { completed: 0, total: 0 },
      metadataQueue: [],
      metadataInFlight: [],
      metadataEnqueuedUntil: 0,
      metadataSeq: 0,
    };
    node.dir = created;
    return created;
  }

  private pushLoad(key: string): void {
    if (this.pendingLoads.includes(key)) {
      return;
    }
    this.pendingLoads.push(key);
  }

  /**
   * 可见片的未补全条目入队：只处理 enqueuedUntil 之后的新增片（每次
   * 加载更多 O(40)），已处理过的条目（成功/失败）不重复重试。
   * 进度 total=可见条目数，completed 由补全成功时增量维护。
   */
  private enqueueVisibleMetadata(node: BrowseNodeState, dir: BrowseDirState): void {
    const visible = Math.min(dir.visible, dir.entries.length);
    dir.metadataProgress.total = visible;
    for (let index = dir.metadataEnqueuedUntil; index < visible; index += 1) {
      const entry = dir.entries[index];
      if (hasBrowseMeta(entry.meta)) {
        continue;
      }
      if (dir.metadataQueue.includes(index) || dir.metadataInFlight.includes(index)) {
        continue;
      }
      dir.metadataQueue.push(index);
    }
    if (visible > dir.metadataEnqueuedUntil) {
      dir.metadataEnqueuedUntil = visible;
    }
    if (dir.metadata === 'cancelled' && dir.metadataQueue.length > 0) {
      dir.metadata = 'pending';
    }
  }

  /**
   * 写入条目元数据并只在「写前缺失、写后完整」时推进 completed——
   * 选中 info 与后台补全可能并发命中同一条目，不能重复计数。
   */
  private completeEntryMetadata(dir: BrowseDirState, entryIndex: number, meta: BrowseMeta): void {
    const entry = dir.entries[entryIndex];
    if (entry === undefined) {
      return;
    }
    const wasComplete = hasBrowseMeta(entry.meta);
    entry.meta = meta;
    if (!wasComplete && hasBrowseMeta(entry.meta)) {
      dir.metadataProgress.completed += 1;
    }
  }

  /** 队列与在途都空：把元数据状态收敛为 complete（已处理全部可见片）。 */
  private finishMetadataIfIdle(dir: BrowseDirState): void {
    if (dir.metadata !== 'filling' && dir.metadata !== 'pending') {
      return;
    }
    if (dir.metadataQueue.length === 0 && dir.metadataInFlight.length === 0) {
      if (dir.entries.some((entry) => !hasBrowseMeta(entry.meta))) {
        // 已处理但存在失败/未入队条目：保持 pending 以便后续加载更多时继续。
        dir.metadata = 'pending';
      } else {
        dir.metadata = 'complete';
      }
    }
  }

  /** 单节点 info 回包同步父条目元数据时，推进该条目的补全进度。 */
  private finalizeMetadataForEntry(parent: BrowseNodeState, entryIndex: number): void {
    const dir = parent.dir;
    if (dir === undefined) {
      return;
    }
    const queueIndex = dir.metadataQueue.indexOf(entryIndex);
    if (queueIndex >= 0) {
      dir.metadataQueue.splice(queueIndex, 1);
    }
    this.finishMetadataIfIdle(dir);
  }

  private metaFromRef(ref: RepoNodeRef, sizeBytes?: number): BrowseMeta {
    const meta: BrowseMeta = { lastChangedRevision: ref.lastChangedRevision };
    if (ref.lastChangedAuthor !== undefined) {
      meta.lastChangedAuthor = ref.lastChangedAuthor;
    }
    if (ref.lastChangedDate !== undefined) {
      meta.lastChangedDate = ref.lastChangedDate;
    }
    if (sizeBytes !== undefined) {
      meta.sizeBytes = sizeBytes;
    }
    return meta;
  }

  private metaOf(node: BrowseNodeState): BrowseMeta {
    if (node.parentKey === null) {
      return this.metaFromRef(node.ref, undefined);
    }
    const parent = this.nodes.get(node.parentKey);
    const entry = parent?.dir?.entries[node.entryIndex ?? -1];
    return entry?.meta ?? {};
  }

  private childUrlOf(parent: BrowseNodeState, entry: BrowseEntryState): string {
    return entryNodeRef(parent.ref, {
      name: entry.name,
      kind: entry.kind,
      ...(entry.meta.lastChangedRevision !== undefined
        ? { lastChangedRevision: entry.meta.lastChangedRevision }
        : {}),
      ...(entry.meta.lastChangedAuthor !== undefined
        ? { lastChangedAuthor: entry.meta.lastChangedAuthor }
        : {}),
      ...(entry.meta.lastChangedDate !== undefined
        ? { lastChangedDate: entry.meta.lastChangedDate }
        : {}),
      ...(entry.meta.sizeBytes !== undefined ? { sizeBytes: entry.meta.sizeBytes } : {}),
    }).rawUrl;
  }

  /** 创建/复用父目录可见条目的子节点（幂等；行构建时懒创建）。 */
  private ensureChildNode(parent: BrowseNodeState, index: number): BrowseNodeState | undefined {
    const dir = parent.dir;
    if (dir === undefined) {
      return undefined;
    }
    const entry = dir.entries[index];
    if (entry === undefined) {
      return undefined;
    }
    const ref = entryNodeRef(parent.ref, {
      name: entry.name,
      kind: entry.kind,
      ...(entry.meta.lastChangedRevision !== undefined
        ? { lastChangedRevision: entry.meta.lastChangedRevision }
        : {}),
      ...(entry.meta.lastChangedAuthor !== undefined
        ? { lastChangedAuthor: entry.meta.lastChangedAuthor }
        : {}),
      ...(entry.meta.lastChangedDate !== undefined
        ? { lastChangedDate: entry.meta.lastChangedDate }
        : {}),
      ...(entry.meta.sizeBytes !== undefined ? { sizeBytes: entry.meta.sizeBytes } : {}),
    });
    const existing = this.nodes.get(ref.rawUrl);
    if (existing !== undefined) {
      existing.entryIndex = index;
      existing.name = entry.name;
      existing.kind = entry.kind;
      existing.depth = parent.depth + 1;
      existing.ref = ref;
      return existing;
    }
    const node: BrowseNodeState = {
      id: `b${++this.nextNodeSeq}`,
      key: ref.rawUrl,
      parentKey: parent.key,
      entryIndex: index,
      name: entry.name,
      kind: entry.kind,
      depth: parent.depth + 1,
      ref,
      expanded: false,
      selected: false,
      detailPhase: 'idle',
      detailSeq: 0,
    };
    this.nodes.set(node.key, node);
    return node;
  }

  /**
   * 删除节点的全部后代（折叠/刷新父目录），返回被删除的键。
   * 先按 parentKey 建一次子索引再迭代删除，避免逐层全表扫描的 O(n²)。
   */
  private removeDescendants(key: string): string[] {
    const children = new Map<string, string[]>();
    for (const [nodeKey, node] of this.nodes) {
      if (node.parentKey === null) {
        continue;
      }
      const list = children.get(node.parentKey);
      if (list === undefined) {
        children.set(node.parentKey, [nodeKey]);
      } else {
        list.push(nodeKey);
      }
    }
    const removed: string[] = [];
    const stack = [...(children.get(key) ?? [])];
    while (stack.length > 0) {
      const childKey = stack.pop() as string;
      removed.push(childKey);
      this.nodes.delete(childKey);
      const grandchildren = children.get(childKey);
      if (grandchildren !== undefined) {
        stack.push(...grandchildren);
      }
    }
    return removed;
  }

  private clearSelectionIfRemoved(removed: string[]): void {
    if (this.selectedKey !== undefined && removed.includes(this.selectedKey)) {
      this.selectedKey = undefined;
    }
  }

  /** 节点相对本次浏览根节点的路径（根为空串；不含仓库根前缀）。 */
  private pathRelativeToRoot(node: BrowseNodeState): string {
    const root = this.rootKey !== undefined ? this.nodes.get(this.rootKey) : undefined;
    const rootPath = root?.ref.relativePath ?? '';
    const nodePath = node.ref.relativePath;
    if (rootPath === '') {
      return nodePath;
    }
    if (nodePath === rootPath) {
      return '';
    }
    if (nodePath.startsWith(`${rootPath}/`)) {
      return nodePath.slice(rootPath.length + 1);
    }
    return nodePath;
  }

  /**
   * 按「相对浏览根节点」的路径逐段定位节点（仅沿已读取目录）；命中
   * 条目 index 超出当前可见片时扩大可见片一次到命中位置（恢复展开/
   * 选中用）。返回已到达的祖先链（含根到最远节点）与是否完整命中；
   * 父目录尚未读取时 complete=false，由控制器在下次目录 ready 后重试。
   */
  private walkPath(relativePath: string): { chain: BrowseNodeState[]; reached?: BrowseNodeState; complete: boolean } {
    if (this.rootKey === undefined) {
      return { chain: [], complete: false };
    }
    const root = this.nodes.get(this.rootKey);
    if (root === undefined) {
      return { chain: [], complete: false };
    }
    const chain: BrowseNodeState[] = [root];
    if (relativePath === '') {
      return { chain, reached: root, complete: true };
    }
    const segments = relativePath.split('/');
    let current = root;
    for (const segment of segments) {
      if (current.kind !== 'dir') {
        return { chain, reached: current, complete: false };
      }
      const dir = current.dir;
      if (dir === undefined || dir.phase !== 'ready') {
        return { chain, reached: current, complete: false };
      }
      const index = dir.entries.findIndex((entry) => entry.name === segment);
      if (index < 0) {
        return { chain, reached: current, complete: false };
      }
      if (index >= dir.visible) {
        dir.visible = index + 1;
      }
      const child = this.ensureChildNode(current, index);
      if (child === undefined) {
        return { chain, reached: current, complete: false };
      }
      chain.push(child);
      current = child;
    }
    return { chain, reached: current, complete: true };
  }

  private displayPathOf(node: BrowseNodeState): string {
    return node.ref.relativePath === '' ? '^/' : `^/${node.ref.relativePath}`;
  }

  /* ------------------------- 错误文案 ------------------------- */

  /** 节点/根错误的标题文案（按分类）。 */
  errorTitle(error: BrowserError): string {
    switch (error.kind) {
      case 'tooLarge':
        return browseText('tooLargeTitle');
      case 'notFound':
        return browseText('notFoundMessage');
      case 'revisionNotFound':
        return browseText('revisionNotFoundMessage', {
          revision: String(this.snapshotRevision ?? ''),
        });
      case 'permission':
        return browseText('permissionMessage');
      case 'auth':
        return browseText('authCancelledMessage');
      case 'network':
        return browseText('networkMessage', { message: error.message });
      default:
        return browseText('unknownMessage', { message: error.message });
    }
  }

}

/** 字节数展示（与 P4 的格式化口径一致：B/KiB/MiB/GiB，一位小数）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 'B';
  for (const candidate of units) {
    value /= 1024;
    unit = candidate;
    if (value < 1024) {
      break;
    }
  }
  return `${value.toFixed(1)} ${unit}`;
}
