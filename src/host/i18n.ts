/**
 * 所有可见中文文案集中在此。M7 若加英文，只替换这个模块。
 */

export const strings = {
  output: {
    title: 'SVN Anywhere',
  },
  command: {
    showStatus: '显示状态',
    commit: '提交',
    update: '更新',
    refreshStatus: '刷新状态',
    cleanup: '清理',
    relocate: '重定位（改仓库地址）',
    editIgnore: '忽略设置',
    showOutput: '显示输出',
  },
  target: {
    resolved: '[定位] {command}：目标 {target}，副本根 {wcRoot}',
  },
  status: {
    header: '状态（{path}）：',
    clean: '无本地变更。',
    entry: '[{status}] {path}',
  },
  update: {
    confirmTitle: '将更新以下路径：\n{target}',
    confirmButton: '更新',
    progress: '正在更新 {target}…',
    done: '更新完成，当前 revision {revision}。',
    doneNoRevision: '更新完成。',
    conflicts: '更新完成，但有 {count} 个冲突需要先解决：{paths}',
    conflictsUnresolved: '更新输出报告了 {count} 个冲突，但未能定位冲突文件，请在输出面板确认。',
  },
  cleanup: {
    progress: '正在清理 {target}…',
    done: '清理完成。',
  },
  commitCheck: {
    remoteSummary: '远端检查：{count} 个远端更新（对照 revision {against}）。',
    confirmTitle: '发现 {count} 个远端更新，先更新再提交？',
    updateAndContinue: '更新并继续',
    updateOnly: '仅更新',
    cancel: '取消',
    blockedByConflicts: '更新产生冲突，已停止提交：{paths}',
    noChanges: '没有可提交的本地变更。',
  },
  commit: {
    pickTitle: '选择要提交的变更（{target}）',
    pickPlaceholder: '空格勾选、回车确认；点条目右侧按钮查看差异',
    messagePrompt: '提交说明（{count} 个文件，目标 {target}）',
    emptyMessageConfirm: '提交说明为空，继续？',
    continueButton: '继续',
    emptyMessageRejected: '提交说明不能为空。可在设置 svnAnywhere.allowEmptyCommitMessage 中允许空说明。',
    missingConfirm: '{count} 个文件已在本地删除但未登记 SVN 删除，提交前会执行 svn delete，继续？',
    commitProgress: '正在提交 {count} 个文件…',
    committed: '提交成功，revision {revision}。',
    committedNoRevision: '提交完成。',
    diffHeader: '差异（{path}）：',
    diffClean: '无差异。',
    refreshHeader: '提交后状态：',
  },
  relocate: {
    inputPrompt: '输入新的仓库地址（当前：{oldUrl}）',
    sameUrlRejected: '新地址与当前地址相同，无需重定位。',
    confirmTitle: '确认重定位？\n副本根：{wcRoot}\n旧地址：{oldUrl}\n新地址：{newUrl}',
    confirmButton: '重定位',
    progress: '正在重定位 {wcRoot}…',
    done: '重定位完成。',
    failureHint: '重定位失败：{message}。relocate 仅适用于同一仓库换地址（UUID 一致）；换仓库请用 svn switch 或重新检出。',
  },
  ignore: {
    pickPlaceholder: '选择忽略规则操作',
    addCurrentName: '把「{name}」加入忽略',
    addCustomPattern: '输入自定义模式（如 *.log）',
    removeExisting: '移除已有规则：{rule}',
    customPatternPrompt: '输入要忽略的文件名或通配模式',
    currentRulesHeader: '当前 svn:ignore 规则（{dir}）：',
    emptyRules: '（无规则）',
    written: 'svn:ignore 已更新：{rules}',
    removed: 'svn:ignore 规则已清空。',
    localChange: '属性修改是本地变更，需要提交后才对团队生效。',
  },
  placeholder: {
    notice: '「{command}」将在后续版本提供。已定位到工作副本：{wcRoot}',
  },
  dialog: {
    openTarget: '选择要在 SVN 中操作的文件或目录',
  },
  activation: {
    svnVersionPrefix: 'svn 版本：',
    svnMissing: '未找到 svn 可执行文件。请确认已安装 svn，或把可执行文件路径配置到 svnAnywhere.svnPath。',
    invalidSvnPath: 'svnAnywhere.svnPath 指向的不是有效的 svn 可执行文件：{path}',
    invalidSvnDetail: '该路径的输出：{detail}',
    workspaceProbeHeader: '工作区副本探测：',
    noWorkspaceFolder: '当前没有打开的工作区目录，跳过副本探测。',
    notWorkingCopy: '不在 SVN 工作副本中，跳过：{path}',
    infoUrl: '仓库地址：{url}（{path}）',
    infoFailed: 'svn info 失败：{message}',
    noWorkingCopyFound: '工作区目录中未发现 SVN 工作副本。',
    probeFailed: '启动探测失败：{message}',
  },
  error: {
    notWorkingCopy: '当前路径不在 SVN 工作副本中',
    cancelled: '操作已取消',
    failed: '命令失败：{message}',
    withShowOutput: '{message}',
    buttonShowOutput: '显示输出',
  },
} as const;

/** 按 {key} 占位符填充文案。 */
export function format(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => params[key] ?? match);
}
