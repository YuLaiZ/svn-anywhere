/**
 * 「远端信息」命令：对右键或回退解析出的本地路径读取 svn info，
 * QuickPick 展示节点 URL、仓库根 URL、仓库 UUID 与 ^/ 相对路径，
 * 选中含 URL/路径的条目即把原始值（不二次解码）复制到剪贴板。
 *
 * 目标语义：右键的文件/目录就是信息目标，不向上借父目录或副本根的
 * URL 误报成功（副本内未纳管按「未版本控制」提示）；路径来源回退为
 * 右键 uri → 活动编辑器（仅 file scheme）→ 文件选择框，取消静默。
 *
 * 认证补录按副本 URL 的 scheme 分支（网络命令统一纪律）：http/https/svn
 * 副本的 info 注入凭据补录重试；svn+ssh/file 不注入——其认证类失败文本
 * 可能被误识别，一律按普通失败呈现，不弹 HTTP 凭据框。先读节点 URL
 * （本地元数据查询，不访问网络）确定 scheme，再按结果决定注入。
 */
import * as vscode from 'vscode';
import { SvnError } from '../../core/errors';
import {
  classifyInfoError,
  isCredentialScheme,
  readNodeUrl,
  readRemoteInfo,
  type RemoteInfoKind,
  type RemoteInfoReadResult,
} from '../../core/remoteInfo';
import { escapePeg } from '../../core/workspace';
import { promptForCredentials } from '../auth';
import { readSvnPath, readTimeoutMs } from '../config';
import { format, strings } from '../i18n';
import { decodingRunOptions, logCommand, logLine } from '../output';
import { pickTargetFsPath } from './target';
import { showCommandError } from './registry';

/** QuickPick 条目：可复制条目携带原始值；纯展示与不可用条目不带。 */
interface RemoteInfoPickItem extends vscode.QuickPickItem {
  /** 选中后复制到剪贴板的原始值（编码形态原样）。 */
  copyRaw?: string;
  /** 字段缺失的条目：选中后提示原因，不提供复制动作。 */
  unavailable?: RemoteInfoKind;
}

/** 四类信息项的固定展示顺序与标签。 */
const ENTRY_ORDER: ReadonlyArray<{ kind: RemoteInfoKind; label: string }> = [
  { kind: 'nodeUrl', label: strings.remoteInfo.labelNodeUrl },
  { kind: 'rootUrl', label: strings.remoteInfo.labelRootUrl },
  { kind: 'uuid', label: strings.remoteInfo.labelUuid },
  { kind: 'relativePath', label: strings.remoteInfo.labelRelativePath },
];

export async function commandShowRemoteInfo(uri?: vscode.Uri): Promise<void> {
  const fsPath = await pickTargetFsPath(uri);
  if (!fsPath) {
    return;
  }

  const svnPath = readSvnPath();
  const runOptions = { timeoutMs: readTimeoutMs(), ...decodingRunOptions('other') };
  const urlArgs = ['info', '--show-item', 'url', escapePeg(fsPath)];

  // 第一步：读节点 URL（工作副本元数据查询）确定 scheme。失败时已无
  // URL 可供分支判定，认证类文本也按普通失败呈现（与不注入面一致）。
  let nodeUrl: string;
  try {
    nodeUrl = await readNodeUrl(svnPath, fsPath, {
      ...runOptions,
      onExit: logCommand(svnPath, urlArgs, undefined, 'other'),
    });
  } catch (err) {
    presentReadFailure(err);
    return;
  }

  // 第二步：按 scheme 分支决定是否注入凭据补录，再完整读取信息。
  const infoArgs = ['info', '--', escapePeg(fsPath)];
  const credentialRun = isCredentialScheme(nodeUrl);
  let result: RemoteInfoReadResult;
  try {
    result = await readRemoteInfo(svnPath, fsPath, {
      ...runOptions,
      ...(credentialRun
        ? {
            getCredentials: promptForCredentials,
            // 重试命令回显到输出频道（logCommand 内置脱敏，密码不外泄）。
            onCredentialRetry: (retryArgs: string[]) => logCommand(svnPath, retryArgs, undefined, 'other'),
          }
        : {}),
      onExit: logCommand(svnPath, infoArgs, undefined, 'other'),
    });
  } catch (err) {
    showCommandError(err, 'other');
    return;
  }
  if (!result.ok) {
    presentReadFailure(result.error);
    return;
  }

  const picked = await vscode.window.showQuickPick(buildPickItems(fsPath, result), {
    placeHolder: strings.remoteInfo.pickPlaceholder,
    matchOnDetail: true,
  });
  if (!picked || picked.copyRaw === undefined) {
    // 取消、本地路径纯展示条目：不动作。
    if (picked?.unavailable !== undefined) {
      void vscode.window.showInformationMessage(
        format(strings.remoteInfo.unavailableNotice, { label: picked.label }),
      );
    }
    return;
  }

  const raw = picked.copyRaw;
  try {
    await vscode.env.clipboard.writeText(raw);
    // 回显与剪贴板内容一致：都是原始 URI 原样。
    void vscode.window.showInformationMessage(format(strings.remoteInfo.copied, { value: raw }));
  } catch (err) {
    // 复制失败不显示成功：明确提示失败，并重开以原始值为初值的输入框
    // 供手动选择复制（不只提示「建议手动复制」却无处可选）。
    const message = err instanceof Error ? err.message : String(err);
    logLine(format(strings.remoteInfo.copyFailed, { message }), 'other');
    void vscode.window.showWarningMessage(format(strings.remoteInfo.copyFailed, { message }));
    await vscode.window.showInputBox({
      prompt: strings.remoteInfo.copyManualPrompt,
      value: raw,
      ignoreFocusOut: true,
    });
  }
}

/** 组装 QuickPick 条目：本地路径纯展示 + 四类信息项（可用/不可用）。 */
function buildPickItems(fsPath: string, result: Extract<RemoteInfoReadResult, { ok: true }>): RemoteInfoPickItem[] {
  const items: RemoteInfoPickItem[] = [
    { label: strings.remoteInfo.labelLocalPath, detail: fsPath },
  ];
  for (const { kind, label } of ENTRY_ORDER) {
    const entry = result.entries.find((item) => item.kind === kind);
    if (entry) {
      // CLI 补 @ 提示只挂在相对路径条目上：^/ 路径是最常被直接粘贴到
      // 命令行的形态（svn 把 @ 当 peg 分隔符，^/a@b 须写作 ^/a@b@）。
      items.push({
        label,
        detail: entry.display,
        ...(kind === 'relativePath' && entry.needsPegHint
          ? { description: strings.remoteInfo.pegHint }
          : {}),
        copyRaw: entry.raw,
      });
    } else {
      items.push({
        label,
        detail: strings.remoteInfo.unavailableDetail,
        unavailable: kind,
      });
    }
  }
  return items;
}

/** 读取失败的分类呈现：未版本控制与 svn 缺失是可预期情况，只提示不弹错误框。 */
function presentReadFailure(err: unknown): void {
  if (!(err instanceof SvnError)) {
    showCommandError(err, 'other');
    return;
  }
  const { reason } = classifyInfoError(err);
  if (reason === 'unversioned') {
    void vscode.window.showInformationMessage(strings.remoteInfo.unversioned);
    return;
  }
  if (reason === 'svnMissing') {
    void vscode.window.showWarningMessage(strings.activation.svnMissing);
    return;
  }
  showCommandError(err, 'other');
}
