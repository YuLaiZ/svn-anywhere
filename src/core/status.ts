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
}

export interface StatusResult {
  targetPath: string;
  entries: StatusEntry[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // 路径属性中的首尾空格属于文件名，不能改变目标身份。
  trimValues: false,
  // SVN 用数字实体表示路径控制字符；解码一次，保留 &amp; 编码的字面实体。
  htmlEntities: true,
  // status XML 里 entry 一定按集合处理，单个条目也要保持数组形态。
  isArray: (name) => name === 'entry',
});

/** M1 不展示的条目：svn 默认参数不输出 ignored，external 防御性过滤占位行。 */
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

/** 解析 `svn status --xml` 输出；结构异常时按空结果处理，不抛解析异常。 */
export function parseStatusXml(xml: string): StatusResult {
  const parsed = parser.parse(xml) as {
    status?: {
      target?: {
        path?: string;
        entry?: Array<{
          path?: string;
          'wc-status'?: {
            item?: string;
            kind?: string;
            revision?: string | number;
            props?: string;
          };
        }>;
      };
    };
  };

  const target = parsed.status?.target;
  const entries: StatusEntry[] = [];
  for (const entry of target?.entry ?? []) {
    const wcStatus = entry['wc-status'];
    if (!entry.path || !wcStatus?.item) {
      continue;
    }
    if (HIDDEN_ITEMS.has(wcStatus.item)) {
      continue;
    }
    entries.push({
      path: entry.path,
      wcStatus: wcStatus.item,
      kind: wcStatus.kind,
      revision: toNumber(wcStatus.revision),
      props: wcStatus.props,
    });
  }
  return { targetPath: target?.path ?? '', entries };
}

/** 对目标路径执行 `svn status --xml` 并解析。target 须经 escapePeg 转义。 */
export async function runStatus(
  svnPath: string,
  target: string,
  options: RunOptions = {},
): Promise<StatusResult> {
  const result = await runOrThrow(svnPath, ['status', '--xml', escapePeg(target)], options);
  return parseStatusXml(result.stdout);
}
