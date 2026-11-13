#!/bin/bash
# M4 阶段 0 / V6 跨版本实验共享环境。
# 用法：source env.sh；矩阵四容器端口与测试弱口令来自 svn-test-matrix 项目
# （common/*.users.example 模板），可用 SVN_TEST_USER/SVN_TEST_PASS 覆盖。
# 禁止把真实凭据写进本目录或环境变量。
set -u
export WORK_DIR=${WORK_DIR:-/tmp/m4-stage0-v6}
export SVN_USER=${SVN_TEST_USER:-matrixtest}
export SVN_PASS=${SVN_TEST_PASS:-test-pass-123}
# 矩阵变量；产品与测试固定 en_US.UTF-8（见 V0），避免错误文本本地化。
export LANG=${M4_LANG:-en_US.UTF-8}
export LC_ALL=${M4_LANG:-en_US.UTF-8}
SVN_OPTS=(--non-interactive --no-auth-cache --username "$SVN_USER" --password "$SVN_PASS")

srv_port() { case $1 in svn16) echo 9061;; svn18) echo 9081;; svn110) echo 9101;; svn114) echo 9141;; esac; }
srv_ver() { case $1 in svn16) echo 1.6.17;; svn18) echo 1.8.10;; svn110) echo 1.10.4;; svn114) echo 1.14.5;; esac; }
url_of() { echo "http://127.0.0.1:$(srv_port "$1")/svn/test"; }

# run <srv> <tag> <cmd...>：把 stdout/stderr/退出码存到 $WORK_DIR/raw/<srv>/<tag>.{out,err,rc}
run() {
  local n=$1 tag=$2; shift 2
  local dir="$WORK_DIR/raw/$n"; mkdir -p "$dir"
  "$@" >"$dir/$tag.out" 2>"$dir/$tag.err"; echo "$?" > "$dir/$tag.rc"
}
