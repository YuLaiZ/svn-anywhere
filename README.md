# SVN Anywhere

在 VS Code 里管理任意布局的 SVN 工作副本。

## 现状

2026-10-27 立项。首个版本 M1（右键工作流）八个阶段已全部实施：M1 验收 1–7 与多行提交说明专项于 2026-10-29 在本地 `file://` 环境复验通过（修复 `7436d15`/`a79774c` 后），验收 8（认证失败补录）于 2026-10-30 在本地 Docker 多版本 SVN 服务器矩阵上通过——**M1 验收全部通过**，遗留仅体验项（见需求包阶段进度）。M1 验收时点自动验证为 163 项单元测试与 mock-host 18 场景；0.7.0 门槛为 85 个测试文件 / 2,364 通过 + 1 跳过（双 locale 全量一致）与 mock-host 69 个场景块 374 项检查。

当前版本 **0.7.0** 是 M4（历史与比较）的交付版本，**M4 已于 2026-11-17 正式验收完成**。在 0.6.0 的只读链路（P5 仓库浏览器、P6 只读历史与版本比较、快速差异 `svnAnywhere.toggleQuickDiff`、行内追溯 `svnAnywhere.toggleInlineBlame`）之上，0.7.0 补齐 P7 冲突处理（`svnAnywhere.scanConflicts`：冲突扫描、单项解决、辅助文件与树/属性/二进制冲突、逐项结果与批量处理）、历史面板更新到指定 revision 与未知结果回扫，以及资源管理器更新和提交前检查发现冲突时通往 P7 的入口（只打开扫描入口，不自动解决）。最终验收覆盖双 locale 全量测试、69 个 mock-host 场景、真实 Extension Host、VS Code 1.85.1 和最终 VSIX 隔离安装。

## 为什么

macOS 上没有 TortoiseSVN。现存的 VS Code SVN 扩展各自只覆盖一部分能力：

- 能递归扫描多个工作副本的，已经停止维护；
- 右键菜单完整的，必须先打开一个 SVN 文件才显示；
- 能看远端地址和历史的，只识别直接加入工作区的目录；
- 全部强制要求非空提交说明。

本项目把这些能力拼在一起，并且不预设目录结构。

## 设计原则

- **不假设布局**：单个根目录下的多个工作副本、多个分散目录、任意嵌套深度，可以同时存在。
- **按路径响应**：命令从被操作的路径向上找最近的 `.svn`，不依赖当前打开了什么文件。
- **命令行优先**：所有操作调用本机 `svn`，不内置 SVN 库，行为与终端保持一致。
- **可解释**：执行了什么命令、在哪一步失败，都要能直接看到。

## 计划

首个版本 M1 聚焦一条右键工作流：在资源管理器右键任意路径，即可更新、提交（含空说明开关、`missing` 转删除、提交前远端检查）、改仓库地址、编辑忽略规则。不注册常驻视图，不监听文件变化。

0.6.0 已在此之上实现检出、导入本地目录、磁盘治理，以及 M4 的只读链路：P5 仓库浏览器（`svnAnywhere.browseRepository`）、P6 历史与比较（`svnAnywhere.showHistory`）、编辑器右键的快速差异与行内追溯；0.7.0 补齐 P7 冲突处理（`svnAnywhere.scanConflicts`）、历史面板更新到指定 revision 与回扫、冲突批量处理，以及资源管理器与提交前检查的 P7 入口。M4 已于 2026-11-17 完成正式验收。

## 开发

要求 Node 18+ 与 pnpm；扩展最低支持 VS Code 1.85。

```bash
pnpm install
pnpm run build      # esbuild 打包到 out/extension.js
pnpm run watch      # 监听模式构建
pnpm run typecheck  # tsc --noEmit
pnpm run test       # vitest 单元测试
pnpm run mock-host  # 先构建，再以 mock 宿主加载打包产物验证命令行为
node scripts/extension-host-test.mjs  # 真实 Extension Host 冒烟（需本机安装 VS Code 桌面版）
```

调试：F5 以「扩展开发宿主」启动（`.vscode/launch.json` 已配置自动构建并指向真实工作副本），在宿主的输出面板选择「SVN Anywhere」查看命令输出。

## 真实 Extension Host 测试

`scripts/extension-host-test.mjs` 用本机 VS Code CLI（`--extensionDevelopmentPath` + `--extensionTestsPath`）启动真实 Extension Host，默认执行编辑器装饰冒烟：`OverviewRulerLane` / `DecorationRangeBehavior` 枚举、`createTextEditorDecorationType`、`setDecorations` 更新与清空、`onDidSaveTextDocument` 触发与退订。M4 阶段 4 的快速差异与行内追溯验收复用同一入口。

前置条件：本机安装 VS Code 桌面版 1.85+；扩展宿主需要图形会话，不能用于纯无头 CI。默认使用 macOS 的 `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`，其他平台用 `VSCODE_BIN` 环境变量或 `--vscode` 指定。每次运行使用隔离的 user-data 与 extensions 目录，不修改本机 VS Code 配置。

```bash
node scripts/extension-host-test.mjs                       # 内置冒烟
node scripts/extension-host-test.mjs --keep                # 保留临时产物（result.json、宿主日志）
node scripts/extension-host-test.mjs --extension . --tests <验收测试入口>  # 阶段 4 复用（先 pnpm run build）
```

结果写入产物目录的 `result.json` 并打印检查项，任一检查失败退出码为 1。`--out <目录>` 可固定产物位置，`--verbose` 输出宿主完整日志，`--timeout <毫秒>` 调整超时。

mock 宿主（`scripts/mock-host.cjs`）的 `fakeVscode` 同步实现了上述装饰与保存事件语义，`test/mockHost.test.ts` 锁定其行为；`pnpm run mock-host` 仍负责真实命令链路的端到端场景。

打包与本地安装（`@vscode/vsce` 为 devDependency，产出 vsix 本地分发，不上架 Marketplace）：

```bash
pnpm run build
pnpm exec vsce package              # 产出 svn-anywhere-<版本>.vsix
code --install-extension svn-anywhere-0.7.0.vsix --extensions-dir <隔离目录> --force
```
