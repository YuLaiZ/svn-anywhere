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
