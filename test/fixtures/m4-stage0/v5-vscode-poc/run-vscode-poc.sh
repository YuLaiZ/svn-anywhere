#!/bin/sh
# V5-3 真实 VS Code Extension Host PoC 启动器。
# 用法：sh test/fixtures/m4-stage0/v5-vscode-poc/run-vscode-poc.sh [index|index2]
#   index   基础 API/装饰/保存事件/切换/10k 行
#   index2  活动编辑器/保存后重算链路/关闭清理/真实 svn diff 端到端
# 环境变量：
#   VSCODE_BIN   VS Code CLI 路径（默认 macOS 安装路径）
#   M4_V5_OUT    结果目录（默认 /tmp/m4-v5-poc-out）
#   M4_V5_WC     index2 使用的 svn 工作副本（默认 /tmp/m4-stage0-v5/wc-clean）
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
TEST=${1:-index2}
OUT=${M4_V5_OUT:-/tmp/m4-v5-poc-out}
mkdir -p "$OUT"
export M4_V5_OUT="$OUT"
VSCODE_BIN=${VSCODE_BIN:-"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"}
"$VSCODE_BIN" \
  --extensionDevelopmentPath="$DIR" \
  --extensionTestsPath="$DIR/test/$TEST.js" \
  --user-data-dir="$OUT/user-data" \
  --extensions-dir="$OUT/extensions" \
  --disable-workspace-trust --skip-welcome --skip-release-notes --no-sandbox --disable-gpu
echo "result: $OUT/poc-result.jsonl"
