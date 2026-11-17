# M4 跨版本与扩展宿主实验脚本

只读实验的可复跑脚本与小数据，不参与产品构建。所有脚本只访问本机
`svnadmin`/Docker 矩阵与隔离的 VS Code；矩阵凭据用 `common/*.users.example`
中的测试弱口令，可用 `SVN_TEST_USER`/`SVN_TEST_PASS` 覆盖。

| 文件 | 用途 |
|---|---|
| `env.sh` | 共享变量：矩阵端口、测试凭据、`run` 输出保存 |
| `seed-data.sh` | 在单个服务端提交 r5-r9 实验数据（中文/空格/@/#/二进制/属性/复制/删除） |
| `probe-matrix.sh` | 四服务端 × list/log/info/diff/blame 成功路径原始输出 |
| `probe-errors.sh` | 错误路径、认证三态、四命令认证一致性 |
| `probe-extra.sh` | 选项拒绝、删除路径 peg、反向 diff、多目标 info、cursor 分页 |
| `xmlshape.py` | 提取 XML 字段形状，用于版本字段差异表 |
| `difforder.py` | 验证 `diff --summarize` 输出顺序稳定性 |
| `wc-cross-version.sh` | 1.14 客户端创建混合 revision WC，1.15 执行 status/info/log/relocate/update/resolve |
| `webview/container-query.html` | 无头浏览器验证容器查询/宽度/主题（`window.__probe` 断言接口） |
| `webview/ext-host/` | 真实 Extension Development Host 探针扩展（自动切换三种主题并写结果） |

## 典型流程

```sh
cd test/fixtures/m4-stage0
source env.sh
# 矩阵容器已启动（svn-test-matrix: docker compose up -d）
for n in svn16 svn18 svn110 svn114; do bash seed-data.sh $n; done
bash probe-matrix.sh && bash probe-errors.sh && bash probe-extra.sh
bash wc-cross-version.sh prepare && bash wc-cross-version.sh commit && \
  bash wc-cross-version.sh host-ops && bash wc-cross-version.sh readback
# 无头容器查询（Chrome + chrome-devtools CLI）
chrome-devtools new_page "file://$PWD/webview/container-query.html"
# 真实宿主
EXT_HOST_DIR=/tmp/svn-anywhere-ext-host "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --extensionDevelopmentPath="$PWD/webview/ext-host" \
  --user-data-dir=/tmp/svn-anywhere-ext-host/vscode-profile \
  --extensions-dir=/tmp/svn-anywhere-ext-host/vscode-exts \
  --disable-workspace-trust --new-window /tmp/svn-anywhere-ext-host/ext-host-workspace
```

注意：`seed-data.sh` 会向矩阵仓库提交实验 revision；跨版本实验会在 svn110 上提交
r10/r11。容器重建后需重新播种。

## 压测与宿主 PoC 的产物位置

- `parse-bench.cjs` / `render-bench.cjs` / `sax-limit-probe.cjs` 默认从
  项目 `node_modules` 解析 `saxes`（devDependency）；需要指向其他安装位置时
  用 `M4_SAXES_PATH` 覆盖。
- `stream-host/host-test/run-host-test.js` 的 `result.json`、`user-data/` 与
  `extensions/` 默认写入 `mkdtempSync(tmpdir())` 下的一次性目录，不再落进
  仓库内 fixture 目录；`FIXTURE_ROOT` 可指定临时目录的父目录，
  `HOST_TEST_RESULT` 可单独覆盖 result.json 路径。
