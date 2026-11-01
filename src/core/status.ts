/**
 * svn status 的执行与 XML 解析。core 模块，不依赖 vscode。
 *
 * 界面展示的状态必须来自 `svn status --xml` 的实际输出（不自造字母映射），
 * wcStatus 一律保留 svn 原词（modified / unversioned / conflicted …）。
 */
import { XMLParser } from 'fast-xml-parser';
import { runOrThrow, type RunOptions } from './svnCli';
import { escapePeg } from './workspace';

export interface StatusEntry {
  /** 来自 XML 的原始 entry@path：相对目标调用时相对 cwd，绝对目标调用时为绝对路径。 */
  path: string;
  /** svn 工作副本状态原词，来自 wc-status@item。 */
  wcStatus: string;
  /** 节点类型（file/dir），旧版本 svn 可能不输出。 */
  kind?: string;
  /** 条目 revision；unversioned 等条目没有。 */
  revision?: number;
  /** 属性状态（none / normal / modified）。 */
  props?: string;
  /** 所属 changelist 名称原值（含首尾空格）；未分组条目为 null。 */
  changelist: string | null;
}

export interface StatusResult {
  targetPath: string;
  entries: StatusEntry[];
  /** externals 边界目录路径（item=external 的条目，未进 entries）。
   * 外部副本内部的变更仍会出现在 entries 中，调用方须按这些前缀隔离。 */
  externals: string[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // 路径属性中的首尾空格属于文件名，不能改变目标身份。
  trimValues: false,
  // SVN 用数字实体表示路径控制字符；解码一次，保留 &amp; 编码的字面实体。
  htmlEntities: true,
  // status XML 里 entry 一定按集合处理，单个条目也要保持数组形态；
  // changelist/target 容器同理（多目标调用时 target 出现多个，单目标也保持数组）。
  isArray: (name) => name === 'entry' || name === 'changelist' || name === 'target',
});

/** 不进面板/展示的条目：svn 默认参数不输出 ignored；external 在入口单独收集。 */
const HIDDEN_ITEMS = new Set(['ignored', 'external']);

function toNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** 可提交项的 wc-status 集合（unversioned 只在提交面板展示、不参与提交）。 */
export const COMMITTABLE_ITEMS = new Set(['modified', 'added', 'deleted', 'missing', 'replaced', 'conflicted']);

/** 属性有修改的条目（svn:ignore 等）：item 可能仍是 normal，但 `svn commit <path>` 可提交。 */
export function isPropertyModified(entry: StatusEntry): boolean {
  return entry.props === 'modified';
}

/** 从状态结果中筛出可提交项；conflicted 由提交流程另行拦截。 */
export function commitableEntries(result: StatusResult): StatusEntry[] {
  return result.entries.filter((entry) => COMMITTABLE_ITEMS.has(entry.wcStatus) || isPropertyModified(entry));
}

/** 解析 `svn status --xml` 输出；结构异常时按空结果处理，不抛解析异常。
 * 多目标调用时 SVN 输出多个 <target> 元素，条目分别挂各自的 target；
 * <changelist> 容器与 <target> 平级、跨目标收拢分组条目。 */
export function parseStatusXml(xml: string): StatusResult {
  const parsed = parser.parse(xml) as {
    status?: {
      target?: StatusXmlTarget | StatusXmlTarget[];
      /** 与 <target> 平级的分组容器：svn 把分了 changelist 的条目挪进来。 */
      changelist?: Array<{ name?: string; entry?: StatusXmlEntry[] }>;
    };
  };

  const targets = parsed.status?.target === undefined
    ? []
    : Array.isArray(parsed.status.target)
      ? parsed.status.target
      : [parsed.status.target];
  const entries: StatusEntry[] = [];
  const externals: string[] = [];
  for (const target of targets) {
    for (const entry of target?.entry ?? []) {
      // 未分组条目直挂 <target>；externals 边界目录单独记录（副本边界隔离用）。
      if (entry['wc-status']?.item === 'external' && entry.path) {
        externals.push(entry.path);
        continue;
      }
      pushEntry(entries, entry, null);
    }
  }
  for (const group of parsed.status?.changelist ?? []) {
    for (const entry of group.entry ?? []) {
      // changelist 名称保留 XML 原值（含首尾空格），不 trim。
      pushEntry(entries, entry, typeof group.name === 'string' ? group.name : null);
    }
  }
  // 单目标行为不变；多目标的 targetPath 用于状态报告标题，拼接展示。
  const paths = targets.map((target) => target?.path).filter((path): path is string => typeof path === 'string');
  return { targetPath: paths.join('、'), entries, externals };
}

interface StatusXmlTarget {
  path?: string;
  entry?: StatusXmlEntry[];
}

interface StatusXmlEntry {
  path?: string;
  'wc-status'?: {
    item?: string;
    kind?: string;
    revision?: string | number;
    props?: string;
  };
}

function pushEntry(entries: StatusEntry[], entry: StatusXmlEntry, changelist: string | null): void {
  const wcStatus = entry['wc-status'];
  if (!entry.path || !wcStatus?.item || HIDDEN_ITEMS.has(wcStatus.item)) {
    return;
  }
  entries.push({
    path: entry.path,
    wcStatus: wcStatus.item,
    kind: wcStatus.kind,
    revision: toNumber(wcStatus.revision),
    props: wcStatus.props,
    changelist,
  });
}

/** 对目标路径执行 `svn status --xml` 并解析。target 须经 escapePeg 转义；
 * 批量操作传入数组时一次查询多个目标（SVN 输出多个 <target> 段）。 */
export async function runStatus(
  svnPath: string,
  target: string | string[],
  options: RunOptions = {},
): Promise<StatusResult> {
  const targets = typeof target === 'string' ? [target] : target;
  const result = await runOrThrow(svnPath, ['status', '--xml', ...targets.map(escapePeg)], options);
  return parseStatusXml(result.stdout);
}
