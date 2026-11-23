/**
 * 扩展入口。激活时探测 svn、注册命令，并把版本与工作区副本地址写入输出频道。
 */
import * as vscode from 'vscode';
import { run, runOrThrow, killAllActive } from './core/svnCli';
import { getOperationRegistry } from './core/operations';
import { SvnError, tailText } from './core/errors';
import { escapePeg, findWorkingCopy } from './core/workspace';
import { readSvnPath, readTimeoutMs } from './host/config';
import { registerAllCommands } from './host/commands';
import { registerBrowseRepositoryCommand, setBrowsePanelOpener, setHistoryHandoffHandler } from './host/commands/browse';
import { registerScanConflictsCommand, setConflictPanelOpener } from './host/commands/conflicts';
import { registerEditorCommands } from './host/commands/editor';
import { openBrowsePanel, setBrowsePanelContext } from './host/panel/panels/browse';
import { openConflictPanel, setConflictPanelContext } from './host/panel/panels/conflicts';
import { openHistoryTarget, registerShowHistoryCommand, setHistoryPanelOpener } from './host/commands/history';
import { openHistoryPanel, setHistoryPanelContext } from './host/panel/panels/history';
import {
  cancelCheckoutTask,
  resumeCheckoutTask,
  startCheckoutTask,
  verifyCheckoutOnly,
} from './host/panel/checkoutTask';
import {
  abandonUnknownImportTask,
  acknowledgeImportTask,
  startImportTask,
  verifyImportTask,
} from './host/panel/importTask';
import {
  cancelDiskScan,
  consumeScanMarker,
  startDiskScan,
  startVacuumTask,
} from './host/panel/diskTask';
import { openDiskPanel } from './host/panel/panels/disk';
import { disposeRemoteContent, initializeRemoteContent } from './host/readonlyContent';
import { disposeDiffView } from './host/diffView';
import { disableInlineBlame, isInlineBlameEnabled } from './host/inlineBlame';
import { disableQuickDiff, getLastQuickDiffRefresh, isQuickDiffEnabled, type QuickDiffLastRefresh } from './host/quickDiff';
import { readSessionResult } from './host/sessionResults';
import { format, strings } from './host/i18n';
import { decodingRunOptions, disposeOutputChannel, getOutputChannel, logCommand, logLine, resetOutputState } from './host/output';

/**
 * 扩展公开 API（activate 返回值；真实 Extension Host 的自动化冒烟经
 * `vscode.extensions.getExtension('yulaiz.svn-anywhere').exports` 读取）。
 * 装饰本身无法经 vscode 公开 API 回读，用开关状态证明命令链路已在真实
 * 编辑器中执行（enabled 只在目标判定与 diff/blame 成功、setDecorations
 * 调用后成立）。
 */
export interface SvnAnywhereExtensionApi {
  isQuickDiffEnabled(): boolean;
  isInlineBlameEnabled(): boolean;
  /**
   * 最近一次快速差异保存刷新的结果（行标记数或失败原因；关闭/重新开启
   * 清空）。自动化冒烟用它等待「保存后刷新完成」，避免只回读开关造成
   * 刷新尚未执行就通过的盲断言。
   */
  getLastQuickDiffRefresh(): QuickDiffLastRefresh | undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<SvnAnywhereExtensionApi> {
  resetOutputState();
  context.subscriptions.push({ dispose: disposeOutputChannel });
  getOutputChannel();
  // P5 远端只读内容（M4 阶段 2）：注册带仓库身份/revision 的
  // TextDocumentContentProvider、文档关闭释放监听，并后台回收过期临时资源。
  initializeRemoteContent(context);
  // P5 面板上下文与命令层打开器注入：browseRepository 命令解析出的目标
  // 交给面板控制器；P6 历史交接经 setHistoryHandoffHandler 接到 P6 打开器。
  setBrowsePanelContext(context);
  setBrowsePanelOpener(openBrowsePanel);
  // P6 历史面板（M4 阶段 3）：showHistory 命令的本地目标与 P5 节点交接
  // 共用同一面板控制器；交接载荷只含节点身份与快照 revision。
  setHistoryPanelContext(context);
  setHistoryPanelOpener(openHistoryPanel);
  setHistoryHandoffHandler((payload) => openHistoryTarget({ source: 'handoff', payload }));
  // await 注册（含操作记录首载折算与孤儿快照清理）：activate 返回后命令
  // 可用即意味着注册表已折算完成（M3 §2.2 首载时序）。
  await registerAllCommands(context);
  // M4 入口命令接线（命令数 18→19）：浏览仓库与查看历史入口与
  // registerAllCommands 分开管理，二次激活由各自的句柄数组保证幂等。
  registerBrowseRepositoryCommand(context);
  registerShowHistoryCommand(context);
  // M4 阶段 5：P7 冲突扫描入口（命令数 21→22）——右键/编辑器/命令面板
  // 解析工作副本根后交给注入的 P7 面板打开器；P6 更新冲突交接共用同一
  // openConflictTarget 注入点（冲突集合由 P7 重新真实扫描）。
  setConflictPanelContext(context);
  setConflictPanelOpener(openConflictPanel);
  registerScanConflictsCommand(context);
  // M4 阶段 4：编辑器集成命令（命令数 19→21）——快速差异与行内追溯由
  // 各自模块的状态机维护装饰，入口只取当前活动文本编辑器。
  registerEditorCommands(context);
  probeSvn().catch((err: unknown) => {
    logLine(format(strings.activation.probeFailed, {
      message: err instanceof Error ? err.message : String(err),
    }));
  });
  return { isQuickDiffEnabled, isInlineBlameEnabled, getLastQuickDiffRefresh };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 启动探测：`svn --version` 写入输出频道并校验输出特征（防止配置成
 * 其它可执行文件时误判可用）；随后对工作区目录逐一探测副本地址。
 * 找不到 svn 或路径配置错误时提示并指向配置项。
 */
async function probeSvn(): Promise<void> {
  const svnPath = readSvnPath();
  try {
    const result = await run(svnPath, ['--version'], {
      timeoutMs: readTimeoutMs(),
      ...decodingRunOptions('other'),
      onExit: logCommand(svnPath, ['--version']),
    });
    if (result.exitCode !== 0 || !result.stdout.includes('svn, version')) {
      const detail = tailText((result.stderr.trim() || result.stdout.trim()).split('\n')[0] ?? '');
      logLine(format(strings.activation.invalidSvnDetail, { detail }));
      logLine(format(strings.activation.invalidSvnPath, { path: svnPath }));
      void vscode.window.showWarningMessage(format(strings.activation.invalidSvnPath, { path: svnPath }));
      return;
    }
    logLine(`${strings.activation.svnVersionPrefix}${result.stdout.split('\n')[0]?.trim() ?? ''}`);
  } catch (err) {
    logLine(errorMessage(err));
    // ENOENT 是「没装/路径错」；EACCES 等其它进程级错误原样呈现，不误导为未安装。
    const code = err instanceof SvnError ? err.code : undefined;
    void vscode.window.showWarningMessage(
      code === 'ENOENT'
        ? strings.activation.svnMissing
        : format(strings.activation.probeFailed, { message: errorMessage(err) }),
    );
    return;
  }

  await probeWorkspace(svnPath);
}

/** 对每个工作区目录向上找副本；命中的逐个执行 `svn info --show-item url`。 */
async function probeWorkspace(svnPath: string): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    logLine(strings.activation.noWorkspaceFolder);
    return;
  }

  logLine(strings.activation.workspaceProbeHeader);
  let foundCount = 0;
  for (const folder of folders) {
    const wcRoot = findWorkingCopy(folder.uri.fsPath);
    if (!wcRoot) {
      logLine(format(strings.activation.notWorkingCopy, { path: folder.uri.fsPath }));
      continue;
    }
    foundCount += 1;
    const args = ['info', '--show-item', 'url', escapePeg(wcRoot)];
    try {
      const result = await runOrThrow(svnPath, args, {
        cwd: wcRoot,
        timeoutMs: readTimeoutMs(),
        ...decodingRunOptions('other'),
        onExit: logCommand(svnPath, args, wcRoot),
      });
      logLine(format(strings.activation.infoUrl, { url: result.stdout.trim(), path: wcRoot }));
    } catch (err) {
      logLine(format(strings.activation.infoFailed, { message: errorMessage(err) }));
    }
  }
  if (foundCount === 0) {
    logLine(strings.activation.noWorkingCopyFound);
  }
}

export function deactivate(): void {
  killAllActive();
  // 编辑器装饰与快照只读 provider 的内存内容随停用释放（关闭释放模式的
  // 停用兜底；P5 远端内容的临时资源由 disposeRemoteContent 清理）。
  disableQuickDiff();
  disableInlineBlame();
  disposeDiffView();
  disposeRemoteContent();
  disposeOutputChannel();
}

/**
 * 检出/续检任务执行器的自动化驱动出口（mock-host 真实 svn 场景使用）。
 * P3 面板控制器与命令入口由后续任务接入——接入前执行器经本出口可被
 * out/extension.js 的宿主脚本直接驱动；真实 VSCode 宿主只调用
 * activate/deactivate，不消费本导出。
 */
export const __checkoutTaskApi = {
  startCheckoutTask,
  cancelCheckoutTask,
  resumeCheckoutTask,
  verifyCheckoutOnly,
  /** 读取检出面板的会话结果缓存（自动化断言「后台终态写缓存」用）。 */
  readCachedResult: (entryKey: string) =>
    readSessionResult('checkout', { scopeKind: 'checkout', entryKey, mode: 'checkout' }),
};

/**
 * 导入任务执行器的自动化驱动出口（mock-host 真实 svn 场景使用，形态对齐
 * __checkoutTaskApi）。P3 导入侧面板控制器接线由后续任务完成——接入前
 * 执行器经本出口可被 out/extension.js 的宿主脚本直接驱动；真实 VSCode
 * 宿主只调用 activate/deactivate，不消费本导出。
 */
export const __importTaskApi = {
  startImportTask,
  verifyImportTask,
  acknowledgeImportTask,
  abandonUnknownImportTask,
  /** 读取导入面板（P3 共用面板类别）的会话结果缓存（自动化断言用）。 */
  readCachedResult: (entryKey: string) =>
    readSessionResult('checkout', { scopeKind: 'checkout', entryKey, mode: 'import' }),
};

/**
 * 磁盘治理任务执行器的自动化驱动出口（mock-host 真实 svn 场景使用，形态
 * 对齐 __checkoutTaskApi/__importTaskApi）。P4 面板控制器与命令入口由
 * 阶段 3 任务 6 接入——接入前执行器经本出口可被 out/extension.js 的宿主
 * 脚本直接驱动；真实 VSCode 宿主只调用 activate/deactivate，不消费本导出。
 */
export const __diskTaskApi = {
  startDiskScan,
  cancelDiskScan,
  startVacuumTask,
  /** 面板控制器打开入口（mock-host 经面板意图驱动「扫描→确认清理→复测」全链用）。 */
  openDiskPanel,
  /** 读取磁盘治理面板的会话结果缓存（自动化断言「后台终态写缓存」用）。 */
  readCachedResult: (wcRoot: string) => readSessionResult('disk', { scopeKind: 'disk', wcRoot }),
  /** 重启模拟：读取并一次性消费「扫描进行中」标记（自动化断言用）。 */
  consumeScanMarker,
};

/** 验证打包扩展在真实宿主中的跨窗口操作注册与子进程生命周期。 */
export const __m5OperationApi = { getOperationRegistry, runOrThrow };
