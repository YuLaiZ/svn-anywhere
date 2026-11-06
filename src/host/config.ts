/**
 * 配置读取。host 模块，集中处理 svnAnywhere.* 配置项。
 * 用户可能填入非法类型，读取处做防御，不让激活路径抛未处理异常。
 */
import * as vscode from 'vscode';
import type { CheckoutDepth } from '../core/checkout';
import { DEFAULT_ENCODING_FALLBACK, DEFAULT_OUTPUT_ENCODING } from '../core/encoding';
import { DEFAULT_TIMEOUT_MS } from '../core/svnCli';

export function getConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('svnAnywhere');
}

/** svn 可执行路径：配置为空或类型非法时回退到 PATH 里的 `svn`。 */
export function readSvnPath(): string {
  const raw: unknown = getConfiguration().get('svnPath', '');
  const configured = typeof raw === 'string' ? raw.trim() : '';
  return configured || 'svn';
}

/** 单条 svn 命令超时毫秒数；非正数或类型非法时用默认值。 */
export function readTimeoutMs(): number {
  const raw: unknown = getConfiguration().get('timeoutMs', DEFAULT_TIMEOUT_MS);
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  return DEFAULT_TIMEOUT_MS;
}

/** 命令失败时是否自动切到输出面板；类型非法时按开启处理。 */
export function readShowOutputOnError(): boolean {
  const raw: unknown = getConfiguration().get('showOutputOnError', true);
  return typeof raw === 'boolean' ? raw : true;
}

/** 提交前是否检查远端更新；类型非法时按开启处理（默认开启）。 */
export function readRemoteCheckBeforeCommit(): boolean {
  const raw: unknown = getConfiguration().get('remoteCheckBeforeCommit', true);
  return typeof raw === 'boolean' ? raw : true;
}

/** 是否允许空提交说明；类型非法时按开启处理（默认开启）。 */
export function readAllowEmptyCommitMessage(): boolean {
  const raw: unknown = getConfiguration().get('allowEmptyCommitMessage', true);
  return typeof raw === 'boolean' ? raw : true;
}

/** 检出面板默认深度四档的合法取值（与 core/checkout 的 CheckoutDepth 同构）。 */
const CHECKOUT_DEPTHS: readonly CheckoutDepth[] = ['empty', 'files', 'immediates', 'infinity'];

/**
 * 检出面板新表单的默认深度（F136）：只影响新任务草稿的初始值，
 * 已保存的草稿按草稿值恢复、不被配置覆盖。类型非法时按全部后代处理。
 */
export function readCheckoutDefaultDepth(): CheckoutDepth {
  const raw: unknown = getConfiguration().get('checkoutDefaultDepth', 'infinity');
  return typeof raw === 'string' && CHECKOUT_DEPTHS.includes(raw as CheckoutDepth)
    ? (raw as CheckoutDepth)
    : 'infinity';
}

/** svn 输出解码设置：主编码与回退链（编码 label 不区分大小写）。 */
export interface EncodingSettings {
  encoding: string;
  encodingFallback: string[];
}

/**
 * 读取输出编码配置：主编码严格解码、失败按回退链逐个重试。
 * 类型非法或留空时回退默认值（UTF-8 / gbk,gb2312,big5）；回退链按
 * 逗号分隔，忽略空白段。编码 label 的合法性由解码层判定并跳过。
 */
export function readEncodingSettings(): EncodingSettings {
  const rawPrimary: unknown = getConfiguration().get('encoding', DEFAULT_OUTPUT_ENCODING);
  const primary = typeof rawPrimary === 'string' && rawPrimary.trim() ? rawPrimary.trim() : DEFAULT_OUTPUT_ENCODING;
  const rawFallback: unknown = getConfiguration().get('encodingFallback', DEFAULT_ENCODING_FALLBACK.join(','));
  const fallback = (typeof rawFallback === 'string' ? rawFallback : '')
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);
  return { encoding: primary, encodingFallback: fallback };
}
