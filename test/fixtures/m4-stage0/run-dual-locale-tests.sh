#!/usr/bin/env bash
# 双 locale 全量测试基线复跑：测试进程的 SVN 输出环境由 test/setup.ts 统一
# 固定，宿主 LANG/LC_ALL 不应影响任何断言。两套环境的结果数字必须完全一致
# （当前基线：56 文件 / 1325 通过 / 1 跳过），出现差异即存在宿主 locale 继承。
set -euo pipefail
cd "$(dirname "$0")/../../.."

for loc in C.UTF-8 zh_CN.UTF-8; do
  echo "=== LANG/LC_ALL=${loc} ==="
  env LANG="${loc}" LC_ALL="${loc}" pnpm test
done
