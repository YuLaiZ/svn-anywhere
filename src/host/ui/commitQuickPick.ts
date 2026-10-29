/**
 * 提交文件多选面板（M1 用 QuickPick，不写 Webview）。
 * 可提交项默认全选；unversioned 仅展示、默认不勾选；
 * 每项带「查看差异」按钮，回调由提交命令提供。
 * 使用 createQuickPick：showQuickPick 的 options 不支持条目级按钮。
 */
import * as vscode from 'vscode';
import { isPropertyModified, type StatusEntry } from '../../core/status';
import { strings } from '../i18n';

export interface PickedChange {
  path: string;
  wcStatus: string;
}

interface CommitQuickItem extends vscode.QuickPickItem {
  entry: StatusEntry;
}

/**
 * 展示文件多选面板，返回用户确认的变更；取消（Esc/关闭）返回 undefined。
 * onDiff 在用户点击条目「查看差异」按钮时触发，面板保持打开。
 */
export function pickCommitFiles(
  entries: StatusEntry[],
  options: {
    title: string;
    placeholder: string;
    onDiff: (entry: StatusEntry) => void;
  },
): Promise<PickedChange[] | undefined> {
  return new Promise((resolve) => {
    const picker = vscode.window.createQuickPick<CommitQuickItem>();
    picker.title = options.title;
    picker.placeholder = options.placeholder;
    picker.canSelectMany = true;
    picker.matchOnDescription = true;
    picker.items = entries.map((entry) => ({
      label: entry.path,
      // 纯属性变更的 item 是 normal，直接展示会误导为无可提交内容，换成「属性修改」。
      description:
        entry.wcStatus === 'normal' && isPropertyModified(entry)
          ? strings.commit.propModified
          : entry.wcStatus,
      buttons: [{ iconPath: new vscode.ThemeIcon('diff') }],
      entry,
    }));
    // unversioned 不能直接提交，仅展示且默认不勾选。
    picker.selectedItems = picker.items.filter((item) => item.entry.wcStatus !== 'unversioned');

    let accepted = false;
    picker.onDidAccept(() => {
      accepted = true;
      resolve(
        picker.selectedItems.map((item) => ({
          path: item.entry.path,
          wcStatus: item.entry.wcStatus,
        })),
      );
      picker.hide();
    });
    picker.onDidTriggerItemButton((event) => options.onDiff(event.item.entry));
    picker.onDidHide(() => {
      picker.dispose();
      if (!accepted) {
        resolve(undefined);
      }
    });
    picker.show();
  });
}

/** 提交说明输入；用户取消（Esc）返回 undefined。 */
export function inputCommitMessage(prompt: string): Thenable<string | undefined> {
  return vscode.window.showInputBox({ prompt, ignoreFocusOut: true });
}
