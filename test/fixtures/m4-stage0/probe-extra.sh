#!/bin/bash
# 补充探测：客户端选项拒绝、删除路径 peg、反向 diff、多目标 info、二进制属性、cursor 分页。
set -u
source "$(dirname "$0")/env.sh"
for n in svn16 svn18 svn110 svn114; do
  url=$(url_of "$n")
  run $n x-list-v svn list --xml -v "${SVN_OPTS[@]}" "$url/exp"
  run $n x-diff-nosum svn diff --xml -r 5:9 "${SVN_OPTS[@]}" "$url/exp"
  run $n ok-info-deleted-peg svn info --xml "${SVN_OPTS[@]}" "$url/exp/empty@5"
  run $n ok-list-deleted-peg svn list --xml --depth immediates "${SVN_OPTS[@]}" "$url/exp/empty@5"
  run $n ok-cat-peg svn cat "${SVN_OPTS[@]}" "$url/exp/a.txt@5"
  run $n diff-reverse svn diff --xml --summarize -r 9:5 "${SVN_OPTS[@]}" "$url"
  run $n log-range svn log --xml -v -r 3:5 "${SVN_OPTS[@]}" "$url/exp"
  run $n info-multi svn info --xml "${SVN_OPTS[@]}" "$url/exp/a.txt" "$url/exp/nope.txt" "$url/exp/binary.bin"
  run $n proplist-bin svn proplist --xml -v "${SVN_OPTS[@]}" "$url/exp/binary.bin"
  run $n log-limit2 svn log --xml -l 2 "${SVN_OPTS[@]}" "$url/exp"
  run $n log-cursor svn log --xml -l 2 -r 8:1 "${SVN_OPTS[@]}" "$url/exp"
done
echo "done -> $WORK_DIR/raw"
