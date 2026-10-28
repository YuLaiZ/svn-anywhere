/**
 * 认证失败弹窗补录（F67）。host 模块。
 * 用户名预填上次输入（只存模块内存变量）；密码用 password 输入框，
 * 不写配置、不写 globalState、不写日志（F68）。
 */
import * as vscode from 'vscode';
import type { AuthCredentials } from '../core/svnCli';
import { strings } from './i18n';

/** 只存内存的上次输入用户名；扩展宿主生命周期内有效，随进程消失。 */
let lastUsername = '';

/** 弹窗补录用户名与密码；任一步取消返回 undefined（调用方放弃重试）。 */
export async function promptForCredentials(): Promise<AuthCredentials | undefined> {
  const username = await vscode.window.showInputBox({
    prompt: strings.auth.usernamePrompt,
    value: lastUsername,
    ignoreFocusOut: true,
  });
  if (username === undefined) {
    return undefined;
  }
  const password = await vscode.window.showInputBox({
    prompt: strings.auth.passwordPrompt,
    password: true,
    ignoreFocusOut: true,
  });
  if (password === undefined) {
    return undefined;
  }
  lastUsername = username.trim();
  return { username: lastUsername, password };
}

/** 仅供测试：清空内存中的用户名缓存。 */
export function resetAuthCache(): void {
  lastUsername = '';
}
