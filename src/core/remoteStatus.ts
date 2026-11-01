/**
 * svn status -u 的执行与 XML 解析（提交前远端检查，F145/F81）。
 * core 模块，不依赖 vscode。
 */
import { XMLParser } from 'fast-xml-parser';
import { runOrThrow, type RunOptions } from './svnCli';
import { escapePeg } from './workspace';

export interface RemoteStatusEntry {
  path: string;
  /** 本地工作副本状态原词；本地未版本控制时为 `none`。 */
  wcStatus?: string;
  /** 远端状态原词（modified/added/deleted/replaced…）；远端无变化时不出现。 */
  reposStatus?: string;
}

export interface RemoteStatusResult {
  /** 对照 revision（服务端 HEAD）。 */
  against?: number;
  entries: RemoteStatusEntry[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // 路径属性中的首尾空格属于文件名，不能改变目标身份。
  trimValues: false,
  // SVN 用数字实体表示路径控制字符；解码一次，保留 &amp; 编码的字面实体。
  htmlEntities: true,
  // 多目标调用时 target 出现多个；entry/changelist 同 status 解析保持数组形态。
  isArray: (name) => name === 'entry' || name === 'changelist' || name === 'target',
});

/** 不计入远端更新的 repos-status 值：none 是无变化，external 不在 M1 范围。 */
const IGNORED_REPOS_STATUS = new Set(['none', 'external']);

/** 解析 `svn status -u --xml` 输出；结构异常时按空结果处理，不抛解析异常。 */
export function parseRemoteStatusXml(xml: string): RemoteStatusResult {
  const parsed = parser.parse(xml) as {
    status?: {
      target?: RemoteXmlTarget | RemoteXmlTarget[];
      /** -u 输出同样把 changelist 条目放进与 <target> 平级的容器。 */
      changelist?: Array<{ name?: string; entry?: RemoteXmlEntry[] }>;
    };
  };

  const targets = parsed.status?.target === undefined
    ? []
    : Array.isArray(parsed.status.target)
      ? parsed.status.target
      : [parsed.status.target];
  const entries: RemoteStatusEntry[] = [];
  for (const target of targets) {
    for (const entry of target?.entry ?? []) {
      pushRemoteEntry(entries, entry);
    }
  }
  for (const group of parsed.status?.changelist ?? []) {
    for (const entry of group.entry ?? []) {
      pushRemoteEntry(entries, entry);
    }
  }
  // 多目标各自带 against（同一仓库 HEAD 应一致）；取最大值保守表示对照基线。
  const againstRevisions = targets
    .map((target) => toNumber(target?.against?.revision))
    .filter((revision): revision is number => revision !== undefined);
  const againstRevision = againstRevisions.length > 0 ? Math.max(...againstRevisions) : undefined;
  return { against: againstRevision, entries };
}

interface RemoteXmlTarget {
  against?: { revision?: string | number };
  entry?: RemoteXmlEntry[];
}

interface RemoteXmlEntry {
  path?: string;
  'wc-status'?: { item?: string };
  'repos-status'?: { item?: string };
}

function pushRemoteEntry(entries: RemoteStatusEntry[], entry: RemoteXmlEntry): void {
  if (!entry.path) {
    return;
  }
  entries.push({
    path: entry.path,
    wcStatus: entry['wc-status']?.item,
    reposStatus: entry['repos-status']?.item,
  });
}

/** 远端有变化的条目（repos-status 存在且非 none/external）。 */
export function remoteChangedEntries(result: RemoteStatusResult): RemoteStatusEntry[] {
  return result.entries.filter(
    (entry) => entry.reposStatus !== undefined && !IGNORED_REPOS_STATUS.has(entry.reposStatus),
  );
}

/**
 * 对目标路径执行 `svn status -u --xml` 并解析。访问远端，固定
 * --non-interactive 防止等待凭据输入；target 传原始路径，内部做 peg 转义；
 * 批量操作传入数组时一次查询多个目标。
 */
export async function runRemoteStatus(
  svnPath: string,
  target: string | string[],
  options: RunOptions = {},
): Promise<RemoteStatusResult> {
  const targets = typeof target === 'string' ? [target] : target;
  const result = await runOrThrow(
    svnPath,
    ['status', '-u', '--non-interactive', '--xml', ...targets.map(escapePeg)],
    options,
  );
  return parseRemoteStatusXml(result.stdout);
}

function toNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
