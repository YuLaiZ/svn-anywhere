/**
 * 认证失败弹窗补录（F67）。host 模块。
 * 用户名预填上次输入（只存模块内存变量）；密码用 password 输入框，
 * 不写配置、不写 globalState、不写日志（F68）。
 *
 * 单飞协调：同一时刻针对同一 `scheme + host + port`
 * 只允许一个凭据弹窗在途。并发的同源认证失败共享同一个凭据 Promise：
 * - 成功：所有等待者拿到同一份凭据，各自带凭据重试原路径；
 * - 取消：所有等待者统一得到 undefined（按原认证错误失败）；
 * - 结算一次后清除 in-flight 记录，后续新的认证失败重新弹窗。
 * 不同源（不同 host/port/scheme）各自独立补录。Promise 本身只结算一次，
 * 因此「取消/成功只结算一次」由共享 Promise + 单次弹窗保证。
 */
import * as vscode from 'vscode';
import type { AuthCredentials, AuthScope } from '../core/svnCli';
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

/** 在途的凭据补录 Promise，按 authScopeKey 分组（单飞协调器状态）。 */
const inflight = new Map<string, Promise<AuthCredentials | undefined>>();

/**
 * 单飞 key：`scheme://host:port`。port 由 authScopeOfUrl 补齐默认端口，
 * 因此显式 `:443` 与省略端口得到同一 key；无 scope 时返回空串
 * （调用方未声明作用域，退化为每次独立弹窗，保持 M1–M3 行为）。
 */
export function authScopeKey(scope?: AuthScope): string {
  if (!scope) {
    return '';
  }
  return `${scope.scheme}://${scope.host}:${scope.port ?? ''}`;
}

/**
 * 请求凭据（单飞入口）：同 scope 已有在途弹窗时直接加入等待，不再弹框；
 * 否则发起一次弹窗并把 Promise 登记为在途，结算后（成功或取消）清除。
 * 未提供 scope 时不做共享，直接弹窗。
 */
export function requestCredentials(scope?: AuthScope): Promise<AuthCredentials | undefined> {
  if (!scope) {
    return promptForCredentials();
  }
  const key = authScopeKey(scope);
  const existing = inflight.get(key);
  if (existing) {
    return existing;
  }
  const promise = promptForCredentials().finally(() => {
    // 只清除自己登记的那一项：若上一轮结算后同 key 已发起新弹窗，
    // 不能误删新一轮的在途 Promise。
    if (inflight.get(key) === promise) {
      inflight.delete(key);
    }
  });
  inflight.set(key, promise);
  return promise;
}

/**
 * 构造可直接注入 RunOptions.getCredentials 的提供者：创建时绑定默认
 * scope；svnCli 调用回调时会把 RunOptions.authScope 原样传入，参数优先
 * （两者应指向同一目标，防止调用点与 provider 绑定的 scope 不一致）。
 */
export function credentialProvider(
  scope?: AuthScope,
): (requested?: AuthScope) => Promise<AuthCredentials | undefined> {
  return (requested?: AuthScope) => requestCredentials(requested ?? scope);
}

/** 仅供测试：清空内存中的用户名缓存。 */
export function resetAuthCache(): void {
  lastUsername = '';
}

/** 仅供测试：清空在途凭据 Promise（避免用例间互相影响）。 */
export function resetAuthFlight(): void {
  inflight.clear();
}
