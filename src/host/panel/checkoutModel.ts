/**
 * P3 检出/导入面板的会话状态机与渲染态构建（纯函数，不依赖 vscode）。
 *
 * 状态形状覆盖两种 mode（技术方案 §4.1，对齐交互状态清单 §二/§三逐行）：
 * mode 专属字段分组齐全——本批实现 checkout 侧 reducer 与渲染，import
 * 分组（sourceDir/message、review.checked/snapshot/parentIdentity、
 * result 的 unknown/merged 分支）的类型与渲染分列一次到位，导入流程的
 * reducer 由阶段 2 接入时补齐，避免破坏性扩展。
 *
 * 关键规则（§4.1/§4.2/§7.1/§7.2，交互状态清单 §二）：
 * - URL 双字段：urlInput 是输入框显示草稿（每次同步原样写入、含非法
 *   输入，视图只渲染它——非法输入不被旧值顶掉）；form.url 是规范编码
 *   URI（业务唯一真相源），校验通过才写；
 * - 连接检查按发起代次（checkSeq）丢弃迟到回包；参数编辑使签名失效、
 *   清除身份快照与自动前进意图；
 * - 默认命名联动只在 nameMode='auto' 时发生，手动改名后保留；
 * - 最终路径 path.join 归一拼接（directMode 为 directDir）；
 * - 结果页动作集按 kind 分列（清单 §二各行），closed 是宿主视图态、
 *   不进 reducer 业务状态。
 */
import { join } from 'node:path';
import {
  defaultCheckoutName,
  editableURL,
  encodeEditableURL,
  isValidCheckoutName,
  normalizeCheckoutUrl,
  type CheckoutDepth,
  type RemoteIdentity,
  type VerifyReport,
} from '../../core/checkout';
import type { ImportSnapshot, ParentIdentitySnapshot } from '../../core/importDir';
import { format, strings } from '../i18n';
import type { CheckoutFormDraft } from './drafts';
import type { ActionSpec, BannerSpec, FooterSpec, FormFieldSpec, FormSpec, PanelState } from './state';

/** URL 历史本机共用上限（检出/导入同一份，§4.2）。 */
export const URL_HISTORY_LIMIT = 10;

/* ---------------------------------------------------------------------------
 * 状态形状（§4.1）
 * ------------------------------------------------------------------------- */

export type P3Mode = 'checkout' | 'import';

export type CheckoutStep = 'form' | 'review' | 'running' | 'result';

/**
 * 连接检查相位。auth = 原生认证补录进行中（清单 §二 form/auth 行）；
 * success = 检查通过且当前表单签名与检查时一致（表单页保留成功回显）。
 */
export type CheckoutConnPhase = 'untested' | 'testing' | 'auth' | 'success' | 'failed';

/** 任务执行相位（只保留执行态；终态唯一落点是 result.kind，§4.1 task 注释）。 */
export type CheckoutTaskPhase = 'connecting' | 'running' | 'canceling';

/** P3 表单（检出与导入共用形状，未用字段保持默认空值）。 */
export interface CheckoutFormState {
  /** 规范编码 URI（业务唯一真相源）：校验通过才写。 */
  url: string;
  /** 输入框显示草稿：每次同步原样写入（含校验失败的输入），视图只渲染本字段。 */
  urlInput: string;
  /** 命名模式：手动改名后保留、不随 URL 联动覆盖，不可由其他字段推导。 */
  nameMode: 'auto' | 'manual';
  /** 宿主计算的最终本地路径（directMode 为 directDir，否则 join(parentDir, dirName)）；导入为 null。 */
  finalPath: string | null;
  urlError: string | null;
  parentDir: string;
  dirName: string;
  /** 直接检出开关与所选目标目录（关闭时 directDir 保持空串、不留脏值）。 */
  directMode: boolean;
  directDir: string;
  /** 版本模式与版本号输入（'number' 时 rev 为非空数字串）。 */
  revMode: 'head' | 'number';
  rev: string;
  depth: CheckoutDepth;
  nameError: string | null;
  revError: string | null;
  /** 导入模式字段（checkout 模式下为空串）。 */
  sourceDir: string;
  message: string;
}

/** 连接检查子态：相位、参数签名、发起代次、结论与身份快照。 */
export interface CheckoutConnState {
  phase: CheckoutConnPhase;
  /** 最近一次检查发起时的参数签名（url+revMode+rev / url+sourceDir，§4.1）；从未发起或失效后为 null（失败结论保留签名，作为参数编辑失效判定的基准）。 */
  signature: string | null;
  /** 发起代次：每次 connNext 递增，回包按它丢弃迟到结论（同签名的先后两次检查互不串扰）。 */
  checkSeq: number;
  /** 检出：HEAD 解析结果或指定版本；连接检查成功写入。 */
  pinnedRevision: number | null;
  /** 自动前进意图（「下一步」触发检查时置位）；任何参数编辑清除。 */
  pendingNext: boolean;
  /** 连接检查与「下一步」阶段源预检失败的通用原因（表单页 error 横幅）。 */
  error: string | null;
  /** checkout 仓库身份快照（begin 三参数来源；签名失效/重新发起清除，§4.1）。 */
  identity: RemoteIdentity | null;
}

/** 核对页子态：检出用 targetState/error，导入分组字段阶段 2 接入。 */
export interface CheckoutReviewState {
  /** 检出：目标目录状态说明（进入核对页时的本地检查结论）。 */
  targetState: string | null;
  snapshotAtCheck: string | null;
  /** 导入：范围确认勾选（未勾选不能开始）。 */
  checked: boolean;
  /** 导入：进入 review 时的源快照（文件列表由宿主 TableSpec 实例承载，模型只持引用）。 */
  snapshot: ImportSnapshot | null;
  /** 导入：sourceChanged/targetChanged 分别置位，清勾选要求重新预览。 */
  scopeChanged: 'source' | 'target' | null;
  /** review 页错误横幅（检出重查/begin 写失败等预命令终止原因；§4.1 两侧共用）。 */
  error: string | null;
  /** 导入父目录身份快照（连接检查初读、重检刷新；§4.1）。 */
  parentIdentity: ParentIdentitySnapshot | null;
}

/** 运行中任务的进度镜像（taskRegistry 任务对象是真相源，此处供渲染）。 */
export interface CheckoutTaskState {
  phase: CheckoutTaskPhase;
  currentFile: string | null;
  count: number;
  /** 未建任务时为 null（任务对象 opId 仅宿主保留，渲染用派生文本）。 */
  opId: string | null;
}

/**
 * 结果页判别联合（§4.1 result，mode 分组避免 checkout+unknown 之类的
 * 非法组合）。checkout 分支的 success/canceled/failed/resumeBlocked 与
 * 任务执行器（checkoutTask.ts 的 CheckoutResultPage）结构同构，可直接
 * 传入 setResult；resumable/interrupted 由核验结论与重启分诊产生。
 */
export type P3ResultPage =
  | {
      mode: 'checkout';
      kind: 'success' | 'canceled' | 'failed' | 'interrupted' | 'resumable' | 'resumeBlocked';
      revision?: number;
      /** 检出/续检目标绝对路径。 */
      path: string;
      detail?: string;
      /** resumable/resumeBlocked 附带的核验报告。 */
      verify?: VerifyReport;
      /** canceled/failed/resumeBlocked 页的表单快照（abandonResidue 的数据源）。 */
      formSnapshot?: CheckoutFormDraft;
    }
  | {
      mode: 'import';
      kind: 'success' | 'failed' | 'unknown' | 'merged';
      revision?: number;
      path: string;
      detail?: string;
      /** kind='success'/'failed' 的结论来源：命令直接结束 / unknown 核实转结论。 */
      evidence?: 'command' | 'verified';
      /** 仅 kind='unknown' 合法（核实不唯一的唯一结论）。 */
      resolution?: 'unresolved';
      /** kind='failed'/'unknown' 页的表单快照（retryImport/abandonUnknownImport 回填数据源）。 */
      formSnapshot?: { url: string; sourceDir: string; message: string; nameMode: 'auto' | 'manual' };
      /** 仅 kind='unknown' 合法：核实第 0 步「快照不完整」失败后写入（abandonUnknownImport 的判定载体）。 */
      snapshotIncomplete?: true;
      /** 仅 kind='merged' 合法（acknowledgeMerged 收口后宿主置位）：收口后动作集切换为新建/日志。 */
      settled?: true;
    };

/** 运行中任务绑定：目标作用域与页头路径按任务呈现，不以本次打开入口推导（§4.1 五段第①段）。 */
export interface CheckoutBinding {
  resultScope: { entryKey: string; mode: P3Mode };
  /** 任务/记录的目标路径（页头与结果页展示基准）。 */
  targetPath: string;
}

/** 重开会话的恢复来源段（§4.1 五段：taskRegistry → 缓存 → 记录分诊 → 草稿 → 新表单）。 */
export type CheckoutRecoveredFrom = 'task' | 'cache' | 'record' | 'draft' | null;

/**
 * 标记恢复来源段：重开恢复流程（控制器按五段顺序判定后）与绑定运行中
 * 任务时调用——供测试断言与面板呈现「已恢复」提示；fromDraft 内部已置
 * 'draft'，发起/新建动作会清回 null。
 */
export function markRecovered(state: CheckoutPanelState, from: Exclude<CheckoutRecoveredFrom, null>): CheckoutPanelState {
  return { ...state, recovered: from };
}

/** 面板打开入口（任务 resultScope 捕获与草稿键的基准；newTask 重建表单的初始值来源）。 */
export interface CheckoutPanelEntry {
  sessionId: string;
  /** 入口路径 realpath（草稿键与 resultScope.entryKey 同源）。 */
  entryKey: string;
  mode: P3Mode;
  /** 检出：打开入口的父目录；导入：源目录。 */
  parentDir?: string;
  sourceDir?: string;
  /** 新任务草稿初始深度（F136 配置，只影响初始值、不覆盖已编辑草稿）。 */
  defaultDepth?: CheckoutDepth;
  /** URL 历史（宿主 globalState 载入后喂入；模型只读镜像）。 */
  history?: string[];
}

/** 入口快照（创建时归一为必填；newTask/switchMode 重建与页头兜底展示用）。 */
export interface CheckoutPanelEntrySnapshot {
  entryKey: string;
  mode: P3Mode;
  parentDir: string;
  sourceDir: string;
  defaultDepth: CheckoutDepth;
}

/** P3 面板完整状态（检出与导入共用形状，§4.1）。 */
export interface CheckoutPanelState {
  sessionId: string;
  /** 打开入口快照（newTask 重建与页头兜底展示用）。 */
  entry: CheckoutPanelEntrySnapshot;
  mode: P3Mode;
  step: CheckoutStep;
  form: CheckoutFormState;
  /** URL 历史（检出/导入共用；成功才记录，addHistoryUrl 纯函数维护）。 */
  history: string[];
  conn: CheckoutConnState;
  review: CheckoutReviewState;
  /** 运行中任务镜像；无任务为 null（终态不进 task.phase，唯一落点 result）。 */
  task: CheckoutTaskState | null;
  result: P3ResultPage | null;
  /** busy/writeLocked 判定输入（任务态/记录态/占用信息由控制器求值后喂入）。 */
  busy: boolean;
  writeLocked: boolean;
  /** 运行中任务绑定（跨入口/恢复态打开时页头与动作对象按任务的目标作用域）。 */
  binding: CheckoutBinding | null;
  /** 恢复来源段标记（fresh 打开为 null）。 */
  recovered: CheckoutRecoveredFrom;
}

/* ---------------------------------------------------------------------------
 * 初始态与派生
 * ------------------------------------------------------------------------- */

/** 创建初始状态：新表单（form 步、conn untested、无任务无结果）。 */
export function createCheckoutPanelState(entry: CheckoutPanelEntry): CheckoutPanelState {
  const defaultDepth = entry.defaultDepth ?? 'infinity';
  const base: CheckoutPanelEntrySnapshot = {
    entryKey: entry.entryKey,
    mode: entry.mode,
    parentDir: entry.parentDir ?? '',
    sourceDir: entry.sourceDir ?? '',
    defaultDepth,
  };
  return {
    sessionId: entry.sessionId,
    entry: base,
    mode: entry.mode,
    step: 'form',
    form: {
      url: '',
      urlInput: '',
      nameMode: 'auto',
      finalPath: null,
      urlError: null,
      parentDir: base.parentDir,
      dirName: '',
      directMode: false,
      directDir: '',
      revMode: 'head',
      rev: '',
      depth: defaultDepth,
      nameError: null,
      revError: null,
      sourceDir: base.sourceDir,
      message: '',
    },
    history: [...(entry.history ?? [])],
    conn: freshConn(),
    review: freshReview(),
    task: null,
    result: null,
    busy: false,
    writeLocked: false,
    binding: null,
    recovered: null,
  };
}

function freshConn(): CheckoutConnState {
  return {
    phase: 'untested',
    signature: null,
    checkSeq: 0,
    pinnedRevision: null,
    pendingNext: false,
    error: null,
    identity: null,
  };
}

function freshReview(): CheckoutReviewState {
  return {
    targetState: null,
    snapshotAtCheck: null,
    checked: false,
    snapshot: null,
    scopeChanged: null,
    error: null,
    parentIdentity: null,
  };
}

/**
 * 最终本地路径（§4.2）：directMode 为 directDir，否则 path.join(parentDir,
 * dirName)——路径归一拼接而非字符串 +（`/p/ab`+`c` 必须得到 `/p/ab/c`）；
 * 任一输入为空时无路径可展示（null）。
 */
export function finalPathOf(form: CheckoutFormState): string | null {
  if (form.directMode) {
    return form.directDir === '' ? null : form.directDir;
  }
  if (form.parentDir === '' || form.dirName === '') {
    return null;
  }
  return join(form.parentDir, form.dirName);
}

/** 连接检查的参数签名（§4.1：检出 url+revMode+rev，导入 url+sourceDir）。 */
export function signatureOf(form: CheckoutFormState, mode: P3Mode): string {
  return mode === 'checkout'
    ? `checkout|${form.url}|${form.revMode}|${form.rev}`
    : `import|${form.url}|${form.sourceDir}`;
}

/** 子目录名校验（§4.2 非法名清单；空值不置错——是否必填由开始校验承担）。 */
export function validateDirName(name: string): string | null {
  if (name === '') {
    return null;
  }
  return isValidCheckoutName(name) ? null : strings.checkoutPanel.nameInvalid;
}

/** 版本号校验（HEAD 或非负整数；'number' 模式下 rev 必须是零或正整数）。 */
export function validateRev(revMode: 'head' | 'number', rev: string): string | null {
  if (revMode !== 'number') {
    return null;
  }
  return /^\d+$/.test(rev) ? null : strings.checkoutPanel.revInvalid;
}

/** URL 显示草稿 → 规范编码 URI 的校验链（§8 逆变换 + §4.2 校验，checkout 侧口径）。 */
export function normalizeUrlInput(raw: string): { ok: true; url: string } | { ok: false; message: string } {
  const encoded = encodeEditableURL(raw);
  const result = normalizeCheckoutUrl(encoded);
  return result.ok ? { ok: true, url: result.url } : { ok: false, message: result.message };
}

/** 以 urlInput 为准重算 urlError（草稿恢复后重算用；非法时 form.url 置空、保留显示值）。 */
function revalidateUrl(form: CheckoutFormState): Pick<CheckoutFormState, 'url' | 'urlError'> {
  if (form.urlInput === '') {
    return { url: '', urlError: null };
  }
  const check = normalizeUrlInput(form.urlInput);
  return check.ok ? { url: check.url, urlError: null } : { url: '', urlError: check.message };
}

function refreshDerived(form: CheckoutFormState): CheckoutFormState {
  return {
    ...form,
    nameError: validateDirName(form.dirName),
    revError: validateRev(form.revMode, form.rev),
    finalPath: finalPathOf(form),
  };
}

/* ---------------------------------------------------------------------------
 * 表单 reducer（syncInput 分发 + 目录选择器 + 自动命名）
 * ------------------------------------------------------------------------- */

/** syncInput 的字段 ID 约定（视图表单字段 → 宿主意图的统一通道）。 */
export type CheckoutFormFieldId =
  | 'url'
  | 'urlHistory'
  | 'dirName'
  | 'revMode'
  | 'rev'
  | 'depth'
  | 'directMode'
  | 'directDir'
  | 'parentDir'
  | 'sourceDir'
  | 'message'
  | 'checked';

const DEPTH_VALUES = new Set<CheckoutDepth>(['empty', 'files', 'immediates', 'infinity']);

/**
 * 表单输入同步（基座 syncInput 意图的分发入口）：
 * - url：urlInput 原样写入（非法输入不被旧值顶掉）；逆变换+校验通过才写
 *   form.url；nameMode='auto' 时联动默认目录名；参数签名变化使连接检查
 *   失效并清除错误横幅（修改目标触发）；
 * - urlHistory：值为历史 URL（视图 select 的 change 值），按选择历史处理；
 * - dirName：置 nameMode='manual'（手动改名后保留）；
 * - revMode/rev：签名变化同样失效检查；revError 重算；
 * - directMode：'false' 时清空 directDir（切回普通模式不留脏值）；
 * - depth：非法值忽略；
 * - 其余字段原样写入。
 */
export function syncInput(
  state: CheckoutPanelState,
  fieldId: CheckoutFormFieldId,
  value: string,
): CheckoutPanelState {
  switch (fieldId) {
    case 'url':
      return syncUrl(state, value);
    case 'urlHistory':
      return value === '' ? state : selectHistoryUrl(state, value);
    case 'dirName':
      return withForm(state, refreshDerived({ ...state.form, dirName: value, nameMode: 'manual' }));
    case 'revMode': {
      const revMode = value === 'number' ? 'number' : 'head';
      return invalidateOnSignatureChange(withForm(state, refreshDerived({ ...state.form, revMode })));
    }
    case 'rev':
      return invalidateOnSignatureChange(withForm(state, refreshDerived({ ...state.form, rev: value })));
    case 'depth': {
      if (!DEPTH_VALUES.has(value as CheckoutDepth)) {
        return state;
      }
      return withForm(state, { ...state.form, depth: value as CheckoutDepth });
    }
    case 'directMode': {
      const directMode = value === 'true';
      return withForm(
        state,
        refreshDerived({ ...state.form, directMode, directDir: directMode ? state.form.directDir : '' }),
      );
    }
    case 'directDir':
      return withForm(state, refreshDerived({ ...state.form, directDir: value }));
    case 'parentDir':
      return withForm(state, refreshDerived({ ...state.form, parentDir: value }));
    case 'sourceDir':
      return invalidateOnSignatureChange(withForm(state, { ...state.form, sourceDir: value }));
    case 'message':
      return withForm(state, { ...state.form, message: value });
    case 'checked':
      // 导入核对的范围确认勾选（清单 §三 review/unchecked↔checked；阶段 2
      // 接入流程，类型与通道一次到位）。范围变化清确认由导入 reducer 承担。
      return { ...state, review: { ...state.review, checked: value === 'true' } };
    default:
      return state;
  }
}

/** URL 输入同步：显示草稿原样保留，规范值与校验态重算，签名变化失效检查。 */
function syncUrl(state: CheckoutPanelState, raw: string): CheckoutPanelState {
  const check = raw === '' ? { ok: false as const, message: '' } : normalizeUrlInput(raw);
  const form: CheckoutFormState = {
    ...state.form,
    urlInput: raw,
    url: raw === '' ? '' : check.ok ? check.url : state.form.url,
    urlError: raw === '' ? null : check.ok ? null : check.message,
  };
  const linked = applyAutoNaming(form);
  return invalidateOnSignatureChange(withForm(state, linked));
}

/**
 * nameMode='auto' 时按 URL 联动默认目录名（§4.2：URL 末段单次解码、
 * 非法名留空待填）；manual 时保留自定义值。
 */
function applyAutoNaming(form: CheckoutFormState): CheckoutFormState {
  if (form.nameMode !== 'auto') {
    return form;
  }
  const dirName = form.url === '' ? '' : defaultCheckoutName(form.url) ?? '';
  return { ...form, dirName, nameError: validateDirName(dirName) };
}

/** 选择历史 URL（或联动/「使用本地目录名」写入规范 URL 的共用路径）：双字段同写、auto 联动。 */
export function selectHistoryUrl(state: CheckoutPanelState, url: string): CheckoutPanelState {
  // 历史写入前已过校验；此处仍走校验链保证状态不变量（非法值不写 form.url）。
  const check = normalizeUrlInput(editableURL(url));
  const form: CheckoutFormState = check.ok
    ? { ...state.form, url: check.url, urlInput: editableURL(check.url), urlError: null }
    : { ...state.form, urlInput: url, urlError: check.message };
  return invalidateOnSignatureChange(withForm(state, applyAutoNaming(form)));
}

/** 「恢复 URL 目录名」：回 auto 并按当前 URL 重新联动。 */
export function useUrlName(state: CheckoutPanelState): CheckoutPanelState {
  return withForm(state, applyAutoNaming({ ...state.form, nameMode: 'auto' }));
}

/** 「使用本地目录名」（导入侧）：回 auto；末段联动由阶段 2 的导入 reducer 承担。 */
export function useDirName(state: CheckoutPanelState): CheckoutPanelState {
  return withForm(state, { ...state.form, nameMode: 'auto' });
}

/** 目录选择器：写父目录（表单内草稿值，不改入口键）。 */
export function pickParentDir(state: CheckoutPanelState, dir: string): CheckoutPanelState {
  return withForm(state, refreshDerived({ ...state.form, parentDir: dir }));
}

/** 直接检出的目标目录选择：写 directDir 并置 directMode=true（§7.2 pickDirectDir）。 */
export function pickDirectDir(state: CheckoutPanelState, dir: string): CheckoutPanelState {
  return withForm(state, refreshDerived({ ...state.form, directDir: dir, directMode: true }));
}

function withForm(state: CheckoutPanelState, form: CheckoutFormState): CheckoutPanelState {
  return { ...state, form };
}

/**
 * 参数签名变化时使连接检查失效（§4.1：untested + 身份/结论/自动前进
 * 全清——旧 URL 的成功结果不得批准新参数）并清除两侧错误横幅（修改
 * 目标触发，§4.1 清除口径）。签名未变（如仅改目录名/深度、或非法输入
 * 未改变规范值）时不动 conn。
 */
function invalidateOnSignatureChange(state: CheckoutPanelState): CheckoutPanelState {
  const before = state.conn.signature;
  const current = signatureOf(state.form, state.mode);
  if (before === null || before === current) {
    return state;
  }
  return {
    ...state,
    conn: { ...freshConn(), checkSeq: state.conn.checkSeq },
    review: { ...state.review, error: null },
  };
}

/**
 * URL 历史维护（成功才记录，§4.2）：去重置顶、上限 10；返回新数组。
 * 持久化由控制器写 globalState，模型只给纯函数。
 */
export function addHistoryUrl(history: readonly string[], url: string): string[] {
  if (url === '') {
    return [...history];
  }
  return [url, ...history.filter((item) => item !== url)].slice(0, URL_HISTORY_LIMIT);
}

/* ---------------------------------------------------------------------------
 * 连接检查 reducer（§4.1/§4.3：发起 → 认证补录 → 结论；迟到回包丢弃）
 * ------------------------------------------------------------------------- */

/** connNext 的返回：issued=false 表示发起被拒（URL 校验失败或已在检查中）。 */
export interface ConnNextResult {
  state: CheckoutPanelState;
  /** 本次发起的代次（回包经 connSettled 带回比对）。 */
  seq: number;
  issued: boolean;
}

/**
 * 发起连接检查（「下一步」自动触发）：
 * - 先对当前 urlInput 重走校验（不拿旧 form.url 通过检查——Q1 用例④）；
 *   失败即拒绝发起、置 urlError、留在表单；
 * - 检查中（testing/auth）禁止重复发起；
 * - 发起：phase='testing'、签名定格、代次递增、pendingNext=true、旧结论
 *   与身份快照清除。
 */
export function connNext(state: CheckoutPanelState): ConnNextResult {
  const check = normalizeUrlInput(state.form.urlInput);
  if (!check.ok) {
    const rejected = withForm(state, { ...state.form, url: state.form.urlInput === '' ? '' : state.form.url, urlError: check.message });
    return { state: rejected, seq: state.conn.checkSeq, issued: false };
  }
  if (state.conn.phase === 'testing' || state.conn.phase === 'auth') {
    return { state, seq: state.conn.checkSeq, issued: false };
  }
  const next = withForm(state, applyAutoNaming({ ...state.form, url: check.url, urlError: null }));
  const seq = state.conn.checkSeq + 1;
  return {
    state: {
      ...next,
      conn: {
        phase: 'testing',
        signature: signatureOf(next.form, next.mode),
        checkSeq: seq,
        pinnedRevision: null,
        pendingNext: true,
        error: null,
        identity: null,
      },
    },
    seq,
    issued: true,
  };
}

/** connSettled 的结论（成功携带身份与固定 revision；失败携带可读原因）。 */
export type ConnOutcome =
  | { ok: true; pinnedRevision: number; identity: RemoteIdentity }
  | { ok: false; failure: string; message: string };

/**
 * 连接检查结论写入：发起代次一致且仍处 testing 才生效——代次不一致
 * （参数已编辑后再次发起、或更早一次检查的迟到回包）原样丢弃。
 * 成功写入 pinnedRevision 与身份快照；pendingNext 仍在时自动进入核对页
 * （清单 §二 form/untested 行「通过后自动进入核对」）。失败留在表单、
 * 写 conn.error（signature 保留，作为后续参数编辑失效判定的基准）。
 */
export function connSettled(state: CheckoutPanelState, seq: number, outcome: ConnOutcome): CheckoutPanelState {
  if (state.conn.checkSeq !== seq || state.conn.phase !== 'testing') {
    return state;
  }
  if (outcome.ok) {
    const autoAdvance = state.conn.pendingNext;
    return {
      ...state,
      step: autoAdvance ? 'review' : state.step,
      conn: {
        ...state.conn,
        phase: 'success',
        pendingNext: false,
        error: null,
        pinnedRevision: outcome.pinnedRevision,
        identity: outcome.identity,
      },
    };
  }
  return {
    ...state,
    step: 'form',
    conn: {
      ...state.conn,
      phase: 'failed',
      pendingNext: false,
      identity: null,
      pinnedRevision: null,
      error: outcome.message,
    },
  };
}

/** 进入原生认证补录（http/https/svn 的连接检查认证失败时由控制器转入）。 */
export function connAuth(state: CheckoutPanelState): CheckoutPanelState {
  if (state.conn.phase !== 'testing') {
    return state;
  }
  return { ...state, conn: { ...state.conn, phase: 'auth' } };
}

/** 补录完成、检查继续（回到 testing 等待命令结论）。 */
export function connAuthResume(state: CheckoutPanelState): CheckoutPanelState {
  if (state.conn.phase !== 'auth') {
    return state;
  }
  return { ...state, conn: { ...state.conn, phase: 'testing' } };
}

/** 补录取消/Esc：检查终止回 untested，清除结论与自动前进意图。 */
export function connAuthCancel(state: CheckoutPanelState): CheckoutPanelState {
  if (state.conn.phase !== 'auth') {
    return state;
  }
  return { ...state, conn: { ...freshConn(), checkSeq: state.conn.checkSeq } };
}

/** 宿主写入连接检查/源预检失败原因（conn.error 承载，渲染为表单页 error 横幅）。 */
export function setConnError(state: CheckoutPanelState, message: string): CheckoutPanelState {
  return { ...state, conn: { ...state.conn, phase: 'failed', error: message } };
}

/** 重查通过、紧邻写命令发出前清除身份快照（§4.3 时序；begin 失败与重查失败均保留）。 */
export function consumeIdentity(state: CheckoutPanelState): CheckoutPanelState {
  return { ...state, conn: { ...state.conn, identity: null } };
}

/* ---------------------------------------------------------------------------
 * 向导转移与任务 reducer
 * ------------------------------------------------------------------------- */

/** 进入核对页：连接检查通过（phase='success'）才可，否则原样返回。 */
export function enterReview(state: CheckoutPanelState): CheckoutPanelState {
  if (state.conn.phase !== 'success') {
    return state;
  }
  return { ...state, step: 'review' };
}

/**
 * 返回表单：保留表单值与连接检查结论（签名未变不失效），清除 review
 * 错误横幅（返回表单触发，§4.1 清除口径）。
 */
export function backToForm(state: CheckoutPanelState): CheckoutPanelState {
  return { ...state, step: 'form', review: { ...state.review, error: null } };
}

/**
 * 核对页目标状态说明写入（检出：进入 review 时的本地目标检查结论，
 * 「目标状态」键值行的数据源）。
 */
export function setReviewInfo(state: CheckoutPanelState, targetState: string): CheckoutPanelState {
  return { ...state, review: { ...state.review, targetState } };
}

/** 宿主写入 review 页错误横幅（开始前重查失败、begin 写失败/idConflict 等预命令终止原因）。 */
export function setReviewError(state: CheckoutPanelState, message: string): CheckoutPanelState {
  return { ...state, step: 'review', review: { ...state.review, error: message } };
}

/** 清除 review 错误横幅（重新开始/重新预览触发）。 */
export function clearReviewError(state: CheckoutPanelState): CheckoutPanelState {
  return { ...state, review: { ...state.review, error: null } };
}

/**
 * 发起任务（startCheckout/startImport 的模型侧转移）：进入 running 步、
 * 建立任务绑定（resultScope 缺省取打开入口 + 当前 mode）、清结果页与
 * review 错误（重新开始触发）、清除恢复标记。任务对象由控制器注册
 * taskRegistry，此处只建镜像。
 */
export function beginTask(
  state: CheckoutPanelState,
  task: { opId: string; targetPath: string; resultScope?: { entryKey: string; mode: P3Mode } },
): CheckoutPanelState {
  return {
    ...state,
    step: 'running',
    task: { phase: 'connecting', currentFile: null, count: 0, opId: task.opId },
    binding: {
      resultScope: task.resultScope ?? { entryKey: state.entry.entryKey, mode: state.mode },
      targetPath: task.targetPath,
    },
    result: null,
    recovered: null,
    review: { ...state.review, error: null },
  };
}

/** 任务相位推进（connecting → running → canceling；执行器回调时由控制器写入）。 */
export function taskPhase(state: CheckoutPanelState, phase: CheckoutTaskPhase): CheckoutPanelState {
  if (!state.task) {
    return state;
  }
  return { ...state, task: { ...state.task, phase } };
}

/** 流式进度更新（数量与当前文件名；节流由控制器承担）。 */
export function taskProgress(
  state: CheckoutPanelState,
  progress: { count: number; currentFile: string | null },
): CheckoutPanelState {
  if (!state.task) {
    return state;
  }
  return { ...state, task: { ...state.task, count: progress.count, currentFile: progress.currentFile } };
}

/**
 * 任务终态/核验结论写入结果页（任何进入结果页的转移都经本函数）：
 * 执行器结果页（结构同构）、核验结论页（setVerifyOutcome）、续检重核验
 * 失败的 resumeBlocked 转移都落到这里；task 镜像清空（终态不进 task）。
 */
export function setResult(state: CheckoutPanelState, page: P3ResultPage): CheckoutPanelState {
  return { ...state, step: 'result', result: page, task: null };
}

/**
 * 宿主重启后的 interrupted 派生页（§4.1 五段第③段记录分诊）：无
 * formSnapshot 来源（重启后无任务对象、无会话缓存——已登记差异：该页
 * 的「改用新目录」回空白表单、由用户重填）。
 */
export function buildInterruptedPage(input: { path: string; detail?: string }): P3ResultPage {
  return { mode: 'checkout', kind: 'interrupted', path: input.path, detail: input.detail };
}

/** verifyCheckout 核验结论（§4.4）：resumable/resumeBlocked 落结果页；快照从被核验页透传。 */
export function setVerifyOutcome(
  state: CheckoutPanelState,
  input: { report: VerifyReport; path: string; formSnapshot?: CheckoutFormDraft },
): CheckoutPanelState {
  return setResult(state, {
    mode: 'checkout',
    kind: input.report.kind,
    path: input.path,
    verify: input.report,
    formSnapshot: input.formSnapshot,
  });
}

/**
 * 新建任务（结果页 newTask）：回空白表单（入口初始值 + 配置默认深度）、
 * 清结果页/任务绑定/连接检查/核对页；URL 历史与入口键保留（历史归
 * globalState，入口键仍是本会话的作用域基准）。会话结果缓存的清除由
 * 控制器执行（离页动作）。
 */
export function newTask(state: CheckoutPanelState): CheckoutPanelState {
  const fresh = createCheckoutPanelState({
    sessionId: state.sessionId,
    ...state.entry,
    history: state.history,
  });
  return fresh;
}

/**
 * 模式切换（switchP3Mode 确认「放弃并切换」后的模型侧转移）：等同换
 * 目标——表单按切换后 mode 的入口初始值重建、连接检查/核对页/结果页/
 * 绑定全清。草稿与缓存清理由控制器执行。
 */
export function switchMode(state: CheckoutPanelState): CheckoutPanelState {
  const mode: P3Mode = state.mode === 'checkout' ? 'import' : 'checkout';
  return {
    ...createCheckoutPanelState({ sessionId: state.sessionId, ...state.entry, history: state.history }),
    mode,
    entry: { ...state.entry, mode },
  };
}

/* ---------------------------------------------------------------------------
 * 草稿投影（drafts.ts 的 CheckoutFormDraft 全字段往返）
 * ------------------------------------------------------------------------- */

/** 模型 form → 草稿值（draftable 字段投影；错误字段不持久化）。 */
export function toDraft(state: CheckoutPanelState): CheckoutFormDraft {
  const { url, urlInput, nameMode, parentDir, dirName, directMode, directDir, revMode, rev, depth, sourceDir, message } = state.form;
  return { url, urlInput, nameMode, parentDir, dirName, directMode, directDir, revMode, rev, depth, sourceDir, message };
}

/**
 * 草稿值 → 模型 form（重开恢复第④段）：全字段回填，错误字段按恢复值
 * 重算（不持久化、重开重算）；conn/review/结果页/绑定重置，回 form 步
 * （review 步不入草稿，重开重新「下一步」重建）。
 */
export function fromDraft(state: CheckoutPanelState, draft: CheckoutFormDraft): CheckoutPanelState {
  const form: CheckoutFormState = {
    ...state.form,
    ...draft,
  };
  const revalidated = refreshDerived({ ...form, ...revalidateUrl(form) });
  return {
    ...state,
    step: 'form',
    recovered: 'draft',
    task: null,
    result: null,
    binding: null,
    conn: { ...freshConn(), checkSeq: state.conn.checkSeq },
    review: freshReview(),
    form: revalidated,
  };
}

/* ---------------------------------------------------------------------------
 * 渲染态构建（§7.1：表单/结果页动作集/横幅/三步条）
 * ------------------------------------------------------------------------- */

/** buildCheckoutPanelState 的宿主侧输入（模型不持有 IO 态，由控制器求值喂入）。 */
export interface BuildCheckoutPanelOptions {
  /** 「核验/核实进行中」登记命中（重开恢复结果页时附过程提示横幅）。 */
  verifyPending?: boolean;
  /** resumable 页「继续原检出」的占用判定（beginResume 谓词求值结果，默认可用）。 */
  resumeAvailable?: boolean;
}

/** 会话状态 → 宿主渲染态（三步条、表单/核对/进度/结果页、横幅、页脚全量派生）。 */
export function buildCheckoutPanelState(
  state: CheckoutPanelState,
  options: BuildCheckoutPanelOptions = {},
): PanelState {
  const t = strings.checkoutPanel;
  const busy = state.busy || state.step === 'running';
  const banners: BannerSpec[] = [];
  if (state.step === 'form' && state.conn.error) {
    banners.push({ id: 'connError', level: 'error', title: t.connErrorTitle, detail: state.conn.error, preformatted: true });
  }
  if (state.step === 'review' && state.review.error) {
    banners.push({ id: 'reviewError', level: 'error', title: t.reviewErrorTitle, detail: state.review.error, preformatted: true });
  }
  let form: FormSpec | undefined;
  let footer: FooterSpec | undefined;
  if (state.step === 'form') {
    form = buildFormSpec(state);
    footer = buildFormFooter(state);
  } else if (state.step === 'review') {
    form = buildReviewSpec(state);
    footer = buildReviewFooter(state);
  } else if (state.step === 'running') {
    form = buildProgressSpec(state);
    footer = buildProgressFooter(state);
  } else {
    form = buildResultSpec(state);
    footer = buildResultFooter(state, options);
    banners.push(...buildResultBanners(state, options));
  }
  return {
    sessionId: state.sessionId,
    title: state.mode === 'checkout' ? t.panelTitleCheckout : t.panelTitleImport,
    targetLabel: targetLabelOf(state),
    revision: 0,
    formRevision: 0,
    busy,
    writeLocked: state.writeLocked,
    banners,
    form,
    footer,
    steps: { labels: [t.stepForm, t.stepReview, t.stepResult], current: stepIndexOf(state.step) },
    headerBadges: connBadges(state),
  };
}

function stepIndexOf(step: CheckoutStep): number {
  return step === 'form' ? 0 : step === 'review' ? 1 : 2;
}

function targetLabelOf(state: CheckoutPanelState): string {
  const t = strings.checkoutPanel;
  if (state.binding) {
    return format(t.targetBound, { path: state.binding.targetPath });
  }
  return state.mode === 'checkout'
    ? format(t.targetParentDir, { path: state.entry.parentDir })
    : format(t.targetSourceDir, { path: state.entry.sourceDir });
}

function connBadges(state: CheckoutPanelState): Array<{ text: string; warn?: boolean }> | undefined {
  if (state.step !== 'form') {
    return undefined;
  }
  const t = strings.checkoutPanel;
  switch (state.conn.phase) {
    case 'testing':
      return [{ text: t.badgeConnTesting }];
    case 'auth':
      return [{ text: t.badgeConnAuth }];
    case 'success':
      return [{
        text: state.conn.pinnedRevision !== null
          ? format(t.badgeConnSuccess, { revision: String(state.conn.pinnedRevision) })
          : t.badgeConnSuccess,
      }];
    case 'failed':
      return [{ text: t.badgeConnFailed, warn: true }];
    default:
      return undefined;
  }
}

/** 表单页字段集（检出/导入按 mode 分组；未用分组不渲染）。 */
function buildFormSpec(state: CheckoutPanelState): FormSpec {
  const t = strings.checkoutPanel;
  const { form, mode } = state;
  const fields: FormFieldSpec[] = [];
  fields.push({
    id: 'url',
    label: t.urlLabel,
    value: form.urlInput,
    type: 'text',
    error: form.urlError ?? undefined,
    help: t.urlHelp,
  });
  if (state.history.length > 0) {
    fields.push({
      id: 'urlHistory',
      label: t.urlHistoryLabel,
      value: '',
      type: 'select',
      options: [
        { value: '', label: t.urlHistoryNone },
        ...state.history.map((url) => ({ value: url, label: editableURL(url) })),
      ],
    });
  }
  if (mode === 'checkout') {
    fields.push({
      id: 'revMode',
      label: t.revModeLabel,
      value: form.revMode,
      type: 'select',
      options: [
        { value: 'head', label: t.revModeHead },
        { value: 'number', label: t.revModeNumber },
      ],
    });
    if (form.revMode === 'number') {
      fields.push({ id: 'rev', label: t.revLabel, value: form.rev, type: 'text', error: form.revError ?? undefined });
    }
    fields.push({
      id: 'depth',
      label: t.depthLabel,
      value: form.depth,
      type: 'select',
      options: (['empty', 'files', 'immediates', 'infinity'] as const).map((depth) => ({
        value: depth,
        label: t.depthLabels[depth],
      })),
    });
    fields.push({
      id: 'directMode',
      label: t.directModeLabel,
      value: form.directMode ? 'true' : 'false',
      type: 'checkbox',
    });
    if (form.directMode) {
      fields.push({ id: 'directDir', label: t.directDirLabel, value: form.directDir, type: 'text' });
    } else {
      fields.push({ id: 'parentDir', label: t.parentDirLabel, value: form.parentDir, type: 'text' });
      fields.push({
        id: 'dirName',
        label: t.dirNameLabel,
        value: form.dirName,
        type: 'text',
        error: form.nameError ?? undefined,
        help: t.dirNameHelp,
      });
    }
  } else {
    fields.push({ id: 'sourceDir', label: t.sourceDirLabel, value: form.sourceDir, type: 'text' });
    fields.push({ id: 'message', label: t.messageLabel, value: form.message, type: 'textarea' });
  }
  const tools: ActionSpec[] = [];
  if (mode === 'checkout') {
    tools.push(
      form.directMode
        ? { id: 'pickDirectDir', label: t.pickDirectDir }
        : { id: 'pickParentDir', label: t.pickParentDir },
    );
    if (form.nameMode === 'manual' && !form.directMode) {
      tools.push({ id: 'useUrlName', label: t.useUrlName });
    }
  } else if (form.nameMode === 'manual') {
    tools.push({ id: 'useDirName', label: t.useDirName });
  }
  return { id: mode === 'checkout' ? 'checkoutForm' : 'importForm', fields, tools: tools.length > 0 ? tools : undefined, busy: false };
}

/** 表单页页脚：下一步（testing/auth 禁止重复；failed 可直接重试）。 */
function buildFormFooter(state: CheckoutPanelState): FooterSpec {
  const t = strings.checkoutPanel;
  const checking = state.conn.phase === 'testing' || state.conn.phase === 'auth';
  return {
    summary: '',
    primary: {
      id: state.mode === 'checkout' ? 'checkoutNext' : 'importNext',
      label: checking ? t.nextTesting : t.nextLabel,
      disabled: checking,
      disabledReason: checking ? t.nextTesting : undefined,
    },
    secondary: [{ id: 'closePanel', label: strings.panel.closeButton }],
  };
}

/** 核对页（§7.1：键值行用 FormSpec 禁用字段承载；导入核对含确认勾选）。 */
function buildReviewSpec(state: CheckoutPanelState): FormSpec {
  const t = strings.checkoutPanel;
  const { form, conn, review, mode } = state;
  const row = (id: string, label: string, value: string): FormFieldSpec => ({
    id,
    label,
    value,
    type: 'text',
    disabled: true,
  });
  const fields: FormFieldSpec[] =
    mode === 'checkout'
      ? [
          row('reviewUrl', t.reviewUrl, editableURL(form.url)),
          row('reviewPath', t.reviewPath, form.finalPath ?? '—'),
          row('reviewRequested', t.reviewRequested, form.revMode === 'head' ? 'HEAD' : `r${form.rev}`),
          row('reviewPinned', t.reviewPinned, conn.pinnedRevision !== null ? `r${conn.pinnedRevision}` : '—'),
          row('reviewDepth', t.reviewDepth, t.depthLabels[form.depth]),
          row('reviewTargetState', t.reviewTargetState, review.targetState ?? '—'),
        ]
      : [
          row('reviewUrl', t.reviewUrl, editableURL(form.url)),
          row('reviewSourceDir', t.reviewSourceDir, form.sourceDir),
          row('reviewMessage', t.reviewMessage, form.message),
          { id: 'checked', label: t.reviewCheckedLabel, value: review.checked ? 'true' : 'false', type: 'checkbox' },
        ];
  return { id: mode === 'checkout' ? 'checkoutReview' : 'importReview', fields, busy: false };
}

/** 核对页页脚：开始（导入未勾选禁用）+ 返回。 */
function buildReviewFooter(state: CheckoutPanelState): FooterSpec {
  const t = strings.checkoutPanel;
  const importBlocked = state.mode === 'import' && !state.review.checked;
  return {
    summary: '',
    primary: {
      id: state.mode === 'checkout' ? 'startCheckout' : 'startImport',
      label: state.mode === 'checkout' ? t.startCheckoutLabel : t.startImportLabel,
      disabled: importBlocked,
      disabledReason: importBlocked ? t.startImportReason : undefined,
    },
    secondary: [
      { id: 'checkoutBack', label: t.backLabel },
      { id: 'closePanel', label: strings.panel.closeButton },
    ],
  };
}

/** 运行页（清单 §二 running 行：当前文件、已取得数、总量未知标记）。 */
function buildProgressSpec(state: CheckoutPanelState): FormSpec {
  const t = strings.checkoutPanel;
  const task = state.task;
  const fields: FormFieldSpec[] = [
    {
      id: 'progressCount',
      label: format(t.progressCount, { count: String(task?.count ?? 0) }),
      value: '',
      type: 'text',
      disabled: true,
    },
    {
      id: 'progressCurrent',
      label: t.progressCurrent,
      value: task?.currentFile ?? '—',
      type: 'text',
      disabled: true,
    },
    {
      id: 'progressTotal',
      label: t.progressTotalUnknown,
      value: '',
      type: 'text',
      disabled: true,
    },
  ];
  return { id: 'checkoutProgress', fields, busy: true };
}

/**
 * 运行页页脚：取消按钮仅 running 可点（connecting 准备段不提供用户取消、
 * canceling 禁重复取消，§7.2 P3 busy 行——DOM 禁用与宿主守卫同源）。
 */
function buildProgressFooter(state: CheckoutPanelState): FooterSpec {
  const t = strings.checkoutPanel;
  const phase = state.task?.phase ?? 'connecting';
  const cancellable = phase === 'running';
  const reason = phase === 'canceling' ? t.cancelDisabledCanceling : t.cancelDisabledConnecting;
  return {
    summary: format(t.progressCount, { count: String(state.task?.count ?? 0) }),
    primary: { id: 'cancelTask', label: t.cancelLabel, disabled: !cancellable, disabledReason: reason },
    secondary: [
      { id: 'viewTaskLog', label: t.actLog },
      { id: 'closePanel', label: strings.panel.closeButton },
    ],
  };
}

/** 结果页键值行（revision/路径/原因/核验结论，按 kind 有无增减）。 */
function buildResultSpec(state: CheckoutPanelState): FormSpec {
  const t = strings.checkoutPanel;
  const result = state.result;
  const fields: FormFieldSpec[] = [];
  const row = (id: string, label: string, value: string): void => {
    fields.push({ id, label, value, type: 'text', disabled: true });
  };
  if (result?.mode === 'checkout') {
    if (result.kind === 'success' && result.revision !== undefined) {
      row('resultRevision', t.resultRevision, `r${result.revision}`);
    }
    row('resultPath', t.resultPath, result.path);
    if (result.detail) {
      row('resultDetail', t.resultDetail, result.detail);
    }
    if (result.verify) {
      row('resultVerify', t.resultVerify, result.verify.message ?? result.verify.blockReason ?? result.verify.kind);
    }
  } else if (result?.mode === 'import') {
    if (result.revision !== undefined) {
      row('resultRevision', t.resultRevision, `r${result.revision}`);
    }
    row('resultPath', t.resultPath, result.path);
    if (result.detail) {
      row('resultDetail', t.resultDetail, result.detail);
    }
  }
  return { id: state.mode === 'checkout' ? 'checkoutResult' : 'importResult', fields, busy: false };
}

/**
 * 结果页页脚动作集（清单 §二各行，关闭为常驻尾项）：
 * - success（检出）：当前窗口打开/新窗口打开/加入工作区/日志/新建 五项；
 * - canceled/failed：核验续检/改用新目录/Finder/日志 四项；
 * - interrupted：核验/改用新目录/日志 三项（无 Finder——基线差异）；
 * - resumeBlocked：改用新目录/重新核验/日志 三项（重新核验是 M3 扩展动作）；
 * - resumable：继续原检出/日志（+关闭，无核验——resumable 本身即核验结论）；
 * - 导入侧分列阶段 2 接入流程，动作集一并建好：unknown=核实（快照不
 *   完整分支另挂放弃核实）/merged=核实+确认收口（settled 后=新建+日志）/
 *   failed=返回填写并重试/success=另选新目录检出+查看原目录+新建+日志。
 */
function buildResultFooter(state: CheckoutPanelState, options: BuildCheckoutPanelOptions): FooterSpec {
  const result = state.result;
  if (!result) {
    return { summary: '', secondary: [{ id: 'closePanel', label: strings.panel.closeButton }] };
  }
  return result.mode === 'checkout'
    ? buildCheckoutResultFooter(result, options)
    : buildImportResultFooter(result);
}

function buildCheckoutResultFooter(
  result: Extract<P3ResultPage, { mode: 'checkout' }>,
  options: BuildCheckoutPanelOptions,
): FooterSpec {
  const t = strings.checkoutPanel;
  const close: ActionSpec = { id: 'closePanel', label: strings.panel.closeButton };
  const log: ActionSpec = { id: 'viewTaskLog', label: t.actLog };
  switch (result.kind) {
    case 'success':
      return {
        summary: '',
        primary: { id: 'openCurrentWindow', label: t.actOpenCurrent },
        secondary: [
          { id: 'openNewWindow', label: t.actOpenNew },
          { id: 'addToWorkspace', label: t.actAddWorkspace },
          { id: 'newTask', label: t.actNewTask },
          log,
          close,
        ],
      };
    case 'canceled':
    case 'failed':
      return {
        summary: '',
        primary: { id: 'verifyCheckout', label: t.actVerifyResume },
        secondary: [
          { id: 'abandonResidue', label: t.actAbandon },
          { id: 'revealResultDir', label: t.actRevealDir },
          log,
          close,
        ],
      };
    case 'interrupted':
      return {
        summary: '',
        primary: { id: 'verifyCheckout', label: t.actVerifyResume },
        secondary: [{ id: 'abandonResidue', label: t.actAbandon }, log, close],
      };
    case 'resumeBlocked':
      return {
        summary: '',
        primary: { id: 'abandonResidue', label: t.actAbandon },
        secondary: [{ id: 'verifyCheckout', label: t.actReverify }, log, close],
      };
    case 'resumable': {
      const available = options.resumeAvailable !== false;
      return {
        summary: '',
        primary: {
          id: 'resumeCheckout',
          label: t.actResume,
          disabled: !available,
          disabledReason: available ? undefined : t.resumeOccupiedReason,
        },
        secondary: [log, close],
      };
    }
  }
}

function buildImportResultFooter(result: Extract<P3ResultPage, { mode: 'import' }>): FooterSpec {
  const t = strings.checkoutPanel;
  const close: ActionSpec = { id: 'closePanel', label: strings.panel.closeButton };
  const log: ActionSpec = { id: 'viewTaskLog', label: t.actLog };
  switch (result.kind) {
    case 'unknown':
      return {
        summary: '',
        primary: { id: 'verifyImport', label: t.actVerifyImport },
        secondary: result.snapshotIncomplete
          ? [{ id: 'abandonUnknownImport', label: t.actAbandonVerify }, log, close]
          : [log, close],
      };
    case 'merged':
      if (result.settled) {
        return {
          summary: '',
          primary: { id: 'newTask', label: t.actNewTask },
          secondary: [log, close],
        };
      }
      return {
        summary: '',
        primary: { id: 'acknowledgeMerged', label: t.actAckMerged },
        secondary: [{ id: 'verifyImport', label: t.actVerifyImport }, log, close],
      };
    case 'failed':
      return {
        summary: '',
        primary: { id: 'retryImport', label: t.actRetryImport },
        secondary: [log, close],
      };
    case 'success':
      return {
        summary: '',
        primary: { id: 'handoffToCheckout', label: t.actHandoff },
        secondary: [
          { id: 'revealSourceDir', label: t.actRevealSource },
          { id: 'newTask', label: t.actNewTask },
          log,
          close,
        ],
      };
  }
}

/** 结果页结论横幅 + 「核验/核实进行中」过程提示（dismissable:false）。 */
function buildResultBanners(state: CheckoutPanelState, options: BuildCheckoutPanelOptions): BannerSpec[] {
  const t = strings.checkoutPanel;
  const banners: BannerSpec[] = [];
  const result = state.result;
  if (result) {
    const level: BannerSpec['level'] =
      result.kind === 'success'
        ? 'success'
        : result.kind === 'failed' || result.kind === 'resumeBlocked'
          ? 'error'
          : result.kind === 'resumable'
            ? 'info'
            : 'warn';
    banners.push({ id: `result.${result.kind}`, level, title: t.resultTitles[result.kind] });
  }
  if (options.verifyPending) {
    banners.push({
      id: 'verifyPending',
      level: 'info',
      title: t.verifyPendingTitle,
      dismissable: false,
    });
  }
  return banners;
}
