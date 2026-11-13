#!/bin/bash
# M4 阶段 0 / V3 可复跑探测：HTTP 服务端矩阵（1.6.17/1.14.5）上的 summarize/list 形态核对。
# 复用 https://github.com/YuLaiZ/svn-test-matrix 的已有容器；不新建、不停止。
# 需要 MATRIX_DIR（含 .env 与 docker-compose.yml），默认 ~/IdeaProjects/personal/svn-test-matrix。
# 用法：M4_STAGE0_ROOT=/tmp/m4-stage0-V3 MATRIX_DIR=... ./http-matrix.sh
set -uo pipefail
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
ROOT=${M4_STAGE0_ROOT:-/tmp/m4-stage0-V3}
MATRIX_DIR=${MATRIX_DIR:-$HOME/IdeaProjects/personal/svn-test-matrix}
LOG=$ROOT/logs/v3-http-matrix.log
mkdir -p "$ROOT/logs"
set -a; . "$MATRIX_DIR/.env"; set +a
CRED=(--non-interactive --no-auth-cache --username "$SVN_TEST_USER" --password "$SVN_TEST_PASS")
exec > >(tee "$LOG") 2>&1
run() {
  echo
  echo "### $1"
  shift
  echo "\$ svn $1 <credentials> ..."
  svn "$@" 2>&1
  echo "[exit=$?]"
}
echo "== V3 HTTP 矩阵核对 $(date -u +%FT%TZ) =="
for pair in "svn114 9141" "svn16 9061"; do
  set -- $pair
  name=$1; port=$2
  URL="http://127.0.0.1:$port/svn/test"
  echo "===== $name ($URL) ====="
  run "$name info" info "${CRED[@]}" "$URL"
  run "$name diff summarize trunk@1..3" diff --xml --summarize "${CRED[@]}" --old "$URL/trunk@1" --new "$URL/trunk@3"
  run "$name list --depth infinity trunk@3" list --xml "${CRED[@]}" --depth infinity -r 3 "$URL/trunk"
done
echo "== 完成 $(date -u +%FT%TZ) =="
