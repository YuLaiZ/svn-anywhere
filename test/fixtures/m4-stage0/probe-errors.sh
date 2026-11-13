#!/bin/bash
# V6-1 错误路径与 HTTP 认证矩阵：不存在/已删除路径、peg、非法 revision、
# 文件当目录、目录 blame、二进制 blame、diff/cat 缺失目标、认证三态、四命令认证一致性。
set -u
source "$(dirname "$0")/env-v6.sh"
mkdir -p "$WORK_DIR/cfg-empty"
for n in svn16 svn18 svn110 svn114; do
  url=$(url_of "$n")
  run $n e-info-missing svn info --xml "${SVN_OPTS[@]}" "$url/exp/nope.txt"
  run $n e-log-deleted svn log --xml "${SVN_OPTS[@]}" "$url/exp/empty"
  run $n ok-log-deleted-peg svn log --xml -v "${SVN_OPTS[@]}" "$url/exp/empty@5"
  run $n e-rev-missing svn info --xml "${SVN_OPTS[@]}" -r 999 "$url/exp"
  run $n e-list-under-file svn list --xml "${SVN_OPTS[@]}" "$url/exp/a.txt/child"
  run $n e-blame-dir svn blame --xml "${SVN_OPTS[@]}" "$url/exp"
  run $n ok-blame-binary svn blame --xml "${SVN_OPTS[@]}" "$url/exp/binary.bin"
  run $n e-diff-missing svn diff --xml --summarize -r 5:9 "${SVN_OPTS[@]}" "$url/exp/nope.txt"
  run $n e-cat-missing svn cat "${SVN_OPTS[@]}" "$url/exp/nope.txt"
  # 认证三态：隔离 config-dir，且不带 --no-auth-cache 之外的用户缓存。
  run $n auth-none svn info --xml --non-interactive --no-auth-cache --config-dir "$WORK_DIR/cfg-empty" "$url"
  run $n auth-badpass svn info --xml --non-interactive --no-auth-cache --config-dir "$WORK_DIR/cfg-empty" --username "$SVN_USER" --password wrong-pass "$url"
  run $n auth-ok svn info --xml --non-interactive --no-auth-cache --config-dir "$WORK_DIR/cfg-empty" --username "$SVN_USER" --password "$SVN_PASS" "$url"
  run $n auth-none-list svn list --xml --non-interactive --no-auth-cache --config-dir "$WORK_DIR/cfg-empty" "$url/exp"
  run $n auth-none-log svn log --xml --non-interactive --no-auth-cache --config-dir "$WORK_DIR/cfg-empty" "$url/exp"
  run $n auth-none-diff svn diff --xml --summarize -r 5:9 --non-interactive --no-auth-cache --config-dir "$WORK_DIR/cfg-empty" "$url/exp"
  run $n auth-none-blame svn blame --xml --non-interactive --no-auth-cache --config-dir "$WORK_DIR/cfg-empty" "$url/exp/a.txt"
done
echo "done -> $WORK_DIR/raw"
