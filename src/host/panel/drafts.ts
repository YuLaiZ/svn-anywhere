/**
 * P3 检出/导入面板的草稿暂存（M2 P2 草稿同款 globalState 挂载形态）。
 *
 * 键 = 打开入口路径 realpath + mode（检出为打开入口的父目录、导入为源
 * 目录——不用最终目标路径，打开时目标尚未确定）；同入口键单份覆盖。
 * 表单内改过的 parentDir/directMode/directDir 都是草稿值、不改键。
 *
 * 写入前做敏感信息过滤：form.url 与 form.urlInput 双字段中任一含
 * authority 段内嵌用户信息（user:pass@ / user@）、query（?）或
 * fragment（#）的清空后持久化——校验失败但含凭据的原始输入同样不得
 * 落盘（密码只在内存）。错误字段（urlError/nameError/revError）不持久
 * 化：草稿值类型本身不含这些字段，重开按恢复的表单值重算校验。
 *
 * 本模块不依赖 vscode：存储经 setDraftStorage 注入 MementoLike
 * （activate 时由命令注册入口挂 context.globalState，测试注入替身）。
 */
import type { MementoLike } from '../../core/operations';

/** 草稿归属的 P3 面板模式（与 resultScope.mode 同源）。 */
export type CheckoutDraftMode = 'checkout' | 'import';

/** 检出深度四档（与 core/checkout 的 CheckoutDepth 同构，草稿自包含）。 */
export type CheckoutDraftDepth = 'empty' | 'files' | 'immediates' | 'infinity';

/**
 * 草稿值形态 = 全部表单字段（技术方案 §4.1 form 字段中可持久化的子集；
 * finalPath 是宿主派生展示值、错误字段不持久化，均不在本类型内）。
 * 同一形态也是任务对象的 formSnapshot 与结果页快照（§4.1 result.formSnapshot）。
 */
export interface CheckoutFormDraft {
  /** 规范编码 URI（业务唯一真相源）。 */
  url: string;
  /** URL 输入框显示草稿（含校验失败的原始输入）。 */
  urlInput: string;
  /** 命名模式：手动改名后保留、不随 URL 联动覆盖，不可由其他字段推导。 */
  nameMode: 'auto' | 'manual';
  parentDir: string;
  dirName: string;
  /** 直接检出开关与所选目标目录（directMode=false 时 directDir 为空）。 */
  directMode: boolean;
  directDir: string;
  /** 版本模式与版本号输入（'number' 时 rev 为非空数字串）。 */
  revMode: 'head' | 'number';
  rev: string;
  depth: CheckoutDraftDepth;
  /** 导入模式字段（checkout 模式下为空串）。 */
  sourceDir: string;
  message: string;
}

/** 空表单草稿（新任务的初始值；深度默认值由面板按配置填充后另行暂存）。 */
export function createEmptyFormDraft(depth: CheckoutDraftDepth = 'infinity'): CheckoutFormDraft {
  return {
    url: '',
    urlInput: '',
    nameMode: 'auto',
    parentDir: '',
    dirName: '',
    directMode: false,
    directDir: '',
    revMode: 'head',
    rev: '',
    depth,
    sourceDir: '',
    message: '',
  };
}

let storage: MementoLike | undefined;

/** activate 时注入宿主 globalState（或测试替身）；传 undefined 卸载。 */
export function setDraftStorage(memento: MementoLike | undefined): void {
  storage = memento;
}

/** 草稿键：对齐 P2 `ignorePanel.stash|…` 的命名风格，入口键 + 模式。 */
export function draftKey(entryKey: string, mode: CheckoutDraftMode): string {
  return `checkoutPanel.draft|${entryKey}|${mode}`;
}

/**
 * URL 是否含敏感信息（authority 段内嵌用户信息 / query / fragment）。
 * 过滤口径与 URL 校验器（core/checkout 的 normalizeCheckoutUrl）的拒绝
 * 项对齐，但作用对象是任意输入文本（校验失败的粘贴同样要拦）：scheme
 * 前缀不限定五种——任何 `scheme://user[:pass]@…` 形态的 authority 内嵌
 * 用户信息都按敏感处理。
 */
export function containsSensitiveUrl(value: string): boolean {
  if (value === '') {
    return false;
  }
  if (value.includes('?') || value.includes('#')) {
    return true;
  }
  const schemeMatch = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(value);
  if (schemeMatch) {
    const authority = value.slice(schemeMatch[0].length).split('/')[0] ?? '';
    if (authority.includes('@')) {
      return true;
    }
  }
  return false;
}

/** 敏感双字段过滤后的草稿副本（其余字段原样保留）。 */
function sanitizeDraft(form: CheckoutFormDraft): CheckoutFormDraft {
  return {
    ...form,
    url: containsSensitiveUrl(form.url) ? '' : form.url,
    urlInput: containsSensitiveUrl(form.urlInput) ? '' : form.urlInput,
  };
}

/**
 * 暂存草稿（同入口键单份覆盖）。敏感双字段过滤后写入；返回是否真正
 * 写入（存储未挂载时 false，调用方可感知配置缺失而不静默丢值）。
 */
export function saveDraft(entryKey: string, mode: CheckoutDraftMode, form: CheckoutFormDraft): boolean {
  if (!storage) {
    return false;
  }
  void storage.update(draftKey(entryKey, mode), sanitizeDraft(form));
  return true;
}

/** 清除草稿（任务开始执行、切换确认放弃、newTask 等出口调用）。 */
export function clearDraft(entryKey: string, mode: CheckoutDraftMode): void {
  if (!storage) {
    return;
  }
  void storage.update(draftKey(entryKey, mode), undefined);
}

/** 读取草稿（无草稿或存储未挂载返回 undefined；读取不清除）。 */
export function readDraft(entryKey: string, mode: CheckoutDraftMode): CheckoutFormDraft | undefined {
  if (!storage) {
    return undefined;
  }
  return storage.get<CheckoutFormDraft | undefined>(draftKey(entryKey, mode), undefined);
}
