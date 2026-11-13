#!/bin/bash
# V6-1 成功路径命令矩阵：四服务端 × list/log/info/diff/blame 等，
# 原始输出与退出码保存在 $WORK_DIR/raw/<srv>/。
# 前置：bash seed-data.sh 已在四个服务端提交 r5-r9。
set -u
source "$(dirname "$0")/env-v6.sh"
for n in svn16 svn18 svn110 svn114; do
  url=$(url_of "$n")
  run $n list-imm svn list --xml --depth immediates "${SVN_OPTS[@]}" "$url/exp"
  run $n list-inf svn list --xml --depth infinity "${SVN_OPTS[@]}" "$url/exp"
  run $n list-empty-r5 svn list --xml --depth immediates "${SVN_OPTS[@]}" -r 5 "$url/exp/empty"
  run $n log-exp svn log --xml -v -l 5 "${SVN_OPTS[@]}" "$url/exp"
  run $n log-stopcopy svn log --xml -v --stop-on-copy "${SVN_OPTS[@]}" "$url/exp/subcopy"
  run $n log-g svn log --xml -g -l 3 "${SVN_OPTS[@]}" "$url/exp"
  run $n info-root svn info --xml "${SVN_OPTS[@]}" "$url/exp"
  run $n info-file svn info --xml "${SVN_OPTS[@]}" "$url/exp/a.txt"
  # URL 内含 @ 必须用尾部 @ 结束 peg 语法
  run $n info-at svn info --xml "${SVN_OPTS[@]}" "$url/exp/at@sign.txt@"
  run $n info-cn svn info --xml "${SVN_OPTS[@]}" "$url/exp/中文 文件.txt"
  run $n info-empty-r5 svn info --xml "${SVN_OPTS[@]}" -r 5 "$url/exp/empty"
  run $n diff-sum-all svn diff --xml --summarize -r 5:9 "${SVN_OPTS[@]}" "$url"
  run $n diff-sum-file svn diff --xml --summarize -r 6:9 "${SVN_OPTS[@]}" "$url/exp/a.txt"
  run $n diff-sum-copy svn diff --xml --summarize -r 7:9 "${SVN_OPTS[@]}" "$url/exp/subcopy"
  run $n diff-sum-old svn diff --xml --summarize -r 5:7 "${SVN_OPTS[@]}" "$url/exp"
  run $n blame svn blame --xml "${SVN_OPTS[@]}" "$url/exp/a.txt"
  run $n blame-range svn blame --xml -r 1:9 "${SVN_OPTS[@]}" "$url/exp/a.txt"
  run $n cat-binary svn cat "${SVN_OPTS[@]}" "$url/exp/binary.bin"
  run $n proplist svn proplist --xml -v "${SVN_OPTS[@]}" "$url/exp/prop.txt"
  run $n propget svn propget --xml test:color "${SVN_OPTS[@]}" "$url/exp/prop.txt"
  run $n cat-cn svn cat "${SVN_OPTS[@]}" "$url/exp/中文 文件.txt"
done
echo "done -> $WORK_DIR/raw"
