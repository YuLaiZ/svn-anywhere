/**
 * 提交文件多选面板（M1 用 QuickPick，不写 Webview）。
 * 可提交项默认全选；unversioned 仅展示、默认不勾选；
 * 每项带「查看差异」按钮，回调由提交命令提供。
 * 使用 createQuickPick：showQuickPick 的 options 不支持条目级按钮。
 */
import * as vscode from 'vscode';
import { isPropertyModified, type StatusEntry } from '../../core/status';
import { format, strings } from '../i18n';

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

/**
 * 提交说明输入（F91 多行）：在 untitled 文档中编辑——InputBox 是单行控件，
 * 粘贴的换行会被展平成空格，无法满足多行要求。
 * 点通知按钮「使用此说明」返回文档全文（空文档 = 空说明，走空说明确认）；
 * 点「取消」或直接关闭文档返回 undefined（取消提交）。
 */
export async function inputCommitMessage(prompt: string): Promise<string | undefined> {
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.parse('untitled:svn-commit-message.txt'),
  );
  await vscode.window.showTextDocument(doc, { preview: true });

  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      closeSubscription.dispose();
      resolve(value);
    };
    const closeSubscription = vscode.workspace.onDidCloseTextDocument((closed) => {
      if (closed === doc) {
        finish(undefined);
      }
    });
    void vscode.window
      .showInformationMessage(
        format(strings.commit.messageEditorNotice, { prompt, button: strings.commit.useMessageButton }),
        strings.commit.useMessageButton,
        strings.commit.cancelButton,
      )
      .then((choice) => {
        finish(choice === strings.commit.useMessageButton ? doc.getText() : undefined);
        void closeMessageTab(doc);
      });
  });
}

/** 用完关闭说明编辑器的 tab；untitled 文档不落盘，关闭失败不影响主流程。 */
async function closeMessageTab(doc: vscode.TextDocument): Promise<void> {
  try {
    const uri = doc.uri.toString();
    const tab = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri);
    if (tab) {
      await vscode.window.tabGroups.close(tab);
    }
  } catch {
    // 忽略：残留一个空 untitled tab 无副作用。
  }
}
