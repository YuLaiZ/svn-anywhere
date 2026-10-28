/**
 * 所有可见中文文案集中在此。M7 若加英文，只替换这个模块。
 */

export const strings = {
  output: {
    title: 'SVN Anywhere',
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
    withShowOutput: '{message}',
    buttonShowOutput: '显示输出',
  },
} as const;

/** 按 {key} 占位符填充文案。 */
export function format(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => params[key] ?? match);
}
