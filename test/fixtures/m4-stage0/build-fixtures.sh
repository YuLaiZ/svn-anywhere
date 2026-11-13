#!/bin/sh
# M4 阶段 0 / V2（历史、复制与筛选）本地 SVN 实验 fixture 构造脚本。
# 只使用 svnadmin + file:// + svnmucc，不访问网络、不使用真实凭据。
# 用法：build-fixtures.sh [目标目录]（默认 /tmp/m4-stage0-v2/repos）
# 复跑：脚本先删除目标目录下同名仓库再重建，保证 revision 编号与提交内容一致。

set -eu

ROOT=${1:-/tmp/m4-stage0-v2/repos}
SVNADMIN=${SVNADMIN:-svnadmin}
SVNMUCC=${SVNMUCC:-svnmucc}
SVN=${SVN:-svn}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/m4-stage0-v2-build.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

export LANG=${LANG:-en_US.UTF-8}
export LC_ALL=${LC_ALL:-en_US.UTF-8}

mkdir -p "$ROOT"

# 新建仓库：删除旧目录后 svnadmin create
new_repo() {
  name=$1
  rm -rf "$ROOT/$name"
  "$SVNADMIN" create "$ROOT/$name"
  echo "created $ROOT/$name"
}

# svnmucc 提交：第 1 参数为提交说明，其余参数原样传给 svnmucc
mucc() {
  msg=$1
  shift
  "$SVNMUCC" --non-interactive -m "$msg" "$@" >/dev/null
}

# ---------------------------------------------------------------------------
# linear：r1-r56 线性历史。r1 建 trunk，r2 加 a.txt，r3-r56 每次追加一行。
# 用途：批次 20/50/100、+1 lookahead、cursor=最小 revision-1、cursor<1。
# ---------------------------------------------------------------------------
build_linear() {
  new_repo linear
  R="file://$ROOT/linear"
  mucc "r1: mkdir trunk" mkdir "$R/trunk"
  echo a > "$WORK/a.txt"
  mucc "r2: add a.txt" put "$WORK/a.txt" "$R/trunk/a.txt"
  i=3
  while [ "$i" -le 56 ]; do
    echo "v$i" >> "$WORK/a.txt"
    mucc "r$i: edit a.txt ($i)" put "$WORK/a.txt" "$R/trunk/a.txt"
    i=$((i + 1))
  done
}

# ---------------------------------------------------------------------------
# copy：r1-r6 复制与嵌套复制。
# r1 建 trunk/dirA/{file1,keep}.txt；r2 改 dirA/file1；r3 复制 dirA->dirB；
# r4 改 dirB/file1；r5 嵌套复制 dirB->dirC；r6 改 dirC/file1。
# 用途：默认跟随复制（文件 vs 目录）、--stop-on-copy、copyfrom-path/rev。
# ---------------------------------------------------------------------------
build_copy() {
  new_repo copy
  R="file://$ROOT/copy"
  printf 'one\n' > "$WORK/one.txt"
  printf 'keep\n' > "$WORK/keep.txt"
  mucc "r1: add trunk/dirA" mkdir "$R/trunk" mkdir "$R/trunk/dirA" \
    put "$WORK/one.txt" "$R/trunk/dirA/file1.txt" put "$WORK/keep.txt" "$R/trunk/dirA/keep.txt"
  printf 'one\ntwo\n' > "$WORK/file1.txt"
  mucc "r2: edit dirA/file1" put "$WORK/file1.txt" "$R/trunk/dirA/file1.txt"
  mucc "r3: copy dirA -> dirB" cp HEAD "$R/trunk/dirA" "$R/trunk/dirB"
  printf 'one\ntwo\nthree\n' > "$WORK/file1.txt"
  mucc "r4: edit dirB/file1" put "$WORK/file1.txt" "$R/trunk/dirB/file1.txt"
  mucc "r5: nested copy dirB -> dirC" cp HEAD "$R/trunk/dirB" "$R/trunk/dirC"
  printf 'one\ntwo\nthree\nfour\n' > "$WORK/file1.txt"
  mucc "r6: edit dirC/file1" put "$WORK/file1.txt" "$R/trunk/dirC/file1.txt"
}

# ---------------------------------------------------------------------------
# copy-wc：与 copy 相同的提交序列，但用工作副本 svn cp + svn commit 构造。
# 目的：对照 copy（svnmucc cp HEAD）观察 copyfrom-rev 的两种形态：
#   - 工作副本复制：copyfrom-rev = 来源路径 last-changed revision（目录 1/3）；
#   - svnmucc cp HEAD：copyfrom-rev = 复制时的全局 HEAD（目录 2/4）。
# 两者影响 svn log 默认跟随的可见 revision 范围与显式 copyfrom 源 cursor。
# ---------------------------------------------------------------------------
build_copy_wc() {
  new_repo copy-wc
  R="file://$ROOT/copy-wc"
  WC="$WORK/wc-copy-wc"
  "$SVN" checkout -q "$R" "$WC"
  mkdir -p "$WC/trunk/dirA"
  printf 'one\n' > "$WC/trunk/dirA/file1.txt"
  printf 'keep\n' > "$WC/trunk/dirA/keep.txt"
  "$SVN" add -q "$WC/trunk"
  "$SVN" commit -q -m "r1: add trunk/dirA" "$WC"
  printf 'one\ntwo\n' > "$WC/trunk/dirA/file1.txt"
  "$SVN" commit -q -m "r2: edit dirA/file1" "$WC"
  "$SVN" copy -q "$WC/trunk/dirA" "$WC/trunk/dirB"
  "$SVN" commit -q -m "r3: copy dirA -> dirB" "$WC"
  printf 'one\ntwo\nthree\n' > "$WC/trunk/dirB/file1.txt"
  "$SVN" commit -q -m "r4: edit dirB/file1" "$WC"
  "$SVN" copy -q "$WC/trunk/dirB" "$WC/trunk/dirC"
  "$SVN" commit -q -m "r5: nested copy dirB -> dirC" "$WC"
  printf 'one\ntwo\nthree\nfour\n' > "$WC/trunk/dirC/file1.txt"
  "$SVN" commit -q -m "r6: edit dirC/file1" "$WC"
}

# ---------------------------------------------------------------------------
# deleted：r1-r6。
# r1 建 trunk/sub/file.txt；r2、r3 修改；r4 删除 trunk/sub；
# r5、r6 修改无关的 trunk/other.txt（兄弟路径）。
# 用途：HEAD 已删除目标直接 log 失败、numeric peg 不跨删除点、
#       祖先 trunk 日志按 /trunk/sub 筛选能发现删除提交、无关提交不命中。
# ---------------------------------------------------------------------------
build_deleted() {
  new_repo deleted
  R="file://$ROOT/deleted"
  printf 's1\n' > "$WORK/file.txt"
  printf 'o1\n' > "$WORK/other.txt"
  mucc "r1: add trunk/sub/file.txt" mkdir "$R/trunk" mkdir "$R/trunk/sub" \
    put "$WORK/file.txt" "$R/trunk/sub/file.txt" put "$WORK/other.txt" "$R/trunk/other.txt"
  printf 's1\ns2\n' > "$WORK/file.txt"
  mucc "r2: edit file" put "$WORK/file.txt" "$R/trunk/sub/file.txt"
  printf 's1\ns2\ns3\n' > "$WORK/file.txt"
  mucc "r3: edit file" put "$WORK/file.txt" "$R/trunk/sub/file.txt"
  mucc "r4: delete trunk/sub" rm "$R/trunk/sub"
  printf 'o1\no2\n' > "$WORK/other.txt"
  mucc "r5: edit other" put "$WORK/other.txt" "$R/trunk/other.txt"
  printf 'o1\no2\no3\n' > "$WORK/other.txt"
  mucc "r6: edit other again" put "$WORK/other.txt" "$R/trunk/other.txt"
}

# ---------------------------------------------------------------------------
# ancestor-copy：r1-r5，祖先目录复制且来源目录含同名路径。
# r1 建 branches/base/{x,y}.txt；r2 改 branches/base/x.txt；
# r3 复制 branches/base -> trunk；r4 改 trunk/x.txt；r5 删除 trunk/x.txt。
# 用途：ancestor-filter --stop-on-copy 停在 r3 复制点、不把 /branches/base/x.txt
#       误归因给 trunk/x.txt；r3 含两级 copyfrom-path/rev 可建立显式来源源。
# ---------------------------------------------------------------------------
build_ancestor_copy() {
  new_repo ancestor-copy
  R="file://$ROOT/ancestor-copy"
  printf 'base1\n' > "$WORK/x.txt"
  printf 'baseY\n' > "$WORK/y.txt"
  mucc "r1: add branches/base/{x,y}.txt" mkdir "$R/branches" mkdir "$R/branches/base" \
    put "$WORK/x.txt" "$R/branches/base/x.txt" put "$WORK/y.txt" "$R/branches/base/y.txt"
  printf 'base1\nbase2\n' > "$WORK/x.txt"
  mucc "r2: edit branches/base/x.txt" put "$WORK/x.txt" "$R/branches/base/x.txt"
  mucc "r3: copy branches/base -> trunk" cp HEAD "$R/branches/base" "$R/trunk"
  printf 'base1\nbase2\ntrunk4\n' > "$WORK/x.txt"
  mucc "r4: edit trunk/x.txt" put "$WORK/x.txt" "$R/trunk/x.txt"
  mucc "r5: delete trunk/x.txt" rm "$R/trunk/x.txt"
}

# ---------------------------------------------------------------------------
# filecopy：r1-r5，文件级复制。
# r1 建 trunk/src.txt；r2 改 src.txt；r3 复制 src.txt -> copy.txt；
# r4 改 copy.txt；r5 删除 copy.txt。
# 用途：文件复制默认跟随复制（含 copyfrom）、--stop-on-copy、复制后修改/删除、
#       HEAD 已删除时 log 失败，与目录复制行为对照。
# ---------------------------------------------------------------------------
build_filecopy() {
  new_repo filecopy
  R="file://$ROOT/filecopy"
  printf 'src1\n' > "$WORK/src.txt"
  mucc "r1: add trunk/src.txt" mkdir "$R/trunk" put "$WORK/src.txt" "$R/trunk/src.txt"
  printf 'src1\nsrc2\n' > "$WORK/src.txt"
  mucc "r2: edit src.txt" put "$WORK/src.txt" "$R/trunk/src.txt"
  mucc "r3: copy src.txt -> copy.txt" cp HEAD "$R/trunk/src.txt" "$R/trunk/copy.txt"
  printf 'src1\nsrc2\ncopy4\n' > "$WORK/src.txt"
  mucc "r4: edit copy.txt" put "$WORK/src.txt" "$R/trunk/copy.txt"
  mucc "r5: delete copy.txt" rm "$R/trunk/copy.txt"
}

# ---------------------------------------------------------------------------
# i18n：r1-r3，筛选字段形态。
# r1 alice 中文说明并建「文档 目录/说明.txt」；r2 bob 中文说明含 & < >；
# r3 alice 建含 @ # 空格中文的文件。
# 用途：关键词/作者/路径筛选的大小写、中文、XML 转义与特殊字符数据形态。
# ---------------------------------------------------------------------------
build_i18n() {
  new_repo i18n
  R="file://$ROOT/i18n"
  printf 'i1\n' > "$WORK/i.txt"
  mucc "初始化 项目 文档" -u alice mkdir "$R/文档 目录" put "$WORK/i.txt" "$R/文档 目录/说明.txt"
  printf 'i2\n' > "$WORK/i.txt"
  mucc "修复 登录 问题 & <标签>" -u bob put "$WORK/i.txt" "$R/文档 目录/说明.txt"
  printf 'i3\n' > "$WORK/i.txt"
  mucc "special @ # path" -u alice put "$WORK/i.txt" "$R/文档 目录/at@file#1.txt"
}

# ---------------------------------------------------------------------------
# date-edge：r1 单提交，svn:date 固定为 2026-11-12T23:30:00.000000Z。
# 该时刻在 UTC 是 2026-11-12、在 +08:00 是 2026-11-13，用于验证列表展示与
# 日期筛选必须先转扩展宿主本地时区再取日期。
# ---------------------------------------------------------------------------
build_date_edge() {
  new_repo date-edge
  R="file://$ROOT/date-edge"
  printf 'd1\n' > "$WORK/d.txt"
  mucc "date edge commit" -u alice put "$WORK/d.txt" "$R/d.txt"
  printf '2026-11-12T23:30:00.000000Z' > "$WORK/newdate.txt"
  "$SVNADMIN" setrevprop "$ROOT/date-edge" -r 1 svn:date "$WORK/newdate.txt"
}

# ---------------------------------------------------------------------------
# nested-copy：r1-r7，目标祖先目录两层复制。
# r1 建 A/x.txt；r2 建 A/y.txt（A 目录变化）；r3 复制 A -> B；
# r4 改 B/x.txt；r5 复制 B -> C；r6 建 C/z.txt（C 目录变化）；r7 删除 C/x.txt。
# 用途：ancestor-filter 在 r5、r3 两个复制点依次压入 copyfrom 源（B@4、A@2），
#       验证源栈串行与每源独立 cursor。
# ---------------------------------------------------------------------------
build_nested_copy() {
  new_repo nested-copy
  R="file://$ROOT/nested-copy"
  printf 'a1\n' > "$WORK/x.txt"
  printf 'aY\n' > "$WORK/y.txt"
  printf 'aZ\n' > "$WORK/z.txt"
  mucc "r1: add A/x.txt" mkdir "$R/A" put "$WORK/x.txt" "$R/A/x.txt"
  mucc "r2: add A/y.txt" put "$WORK/y.txt" "$R/A/y.txt"
  mucc "r3: copy A -> B" cp HEAD "$R/A" "$R/B"
  printf 'a1\nb4\n' > "$WORK/x.txt"
  mucc "r4: edit B/x.txt" put "$WORK/x.txt" "$R/B/x.txt"
  mucc "r5: copy B -> C" cp HEAD "$R/B" "$R/C"
  mucc "r6: add C/z.txt" put "$WORK/z.txt" "$R/C/z.txt"
  mucc "r7: delete C/x.txt" rm "$R/C/x.txt"
}

# ---------------------------------------------------------------------------
# budget：r1-r560，单轮扫描预算 fixture。
# r1 建 trunk/{target,other}.txt；r2-r60 只改 other；
# r61-r559 共 499 个提交：j=0,6,...,468（79 个）改 target，其余 420 个改 other；
# r560 删除 trunk/target.txt。
# 结果：最新 500 条原始回包（r560..r61）中恰有 80 条涉及 /trunk/target.txt
#       （r560 删除 + 79 条修改），其余 420 条为无关提交。
# 用途：一次“加载更多”500 条原始回包上限；500 条扫描产生 80 条匹配、
#       每页 50 时首次展示 50、剩余 30 待展示不发网络。
# ---------------------------------------------------------------------------
build_budget() {
  new_repo budget
  R="file://$ROOT/budget"
  printf 't1\n' > "$WORK/target.txt"
  printf 'o1\n' > "$WORK/other.txt"
  mucc "r1: add trunk/{target,other}.txt" mkdir "$R/trunk" \
    put "$WORK/target.txt" "$R/trunk/target.txt" put "$WORK/other.txt" "$R/trunk/other.txt"
  n=2
  while [ "$n" -le 60 ]; do
    printf 'o%s\n' "$n" >> "$WORK/other.txt"
    mucc "r$n: edit other" put "$WORK/other.txt" "$R/trunk/other.txt"
    n=$((n + 1))
  done
  j=0
  while [ "$j" -le 498 ]; do
    rev=$((61 + j))
    if [ $((j % 6)) -eq 0 ] && [ "$j" -le 468 ]; then
      printf 't%s\n' "$rev" >> "$WORK/target.txt"
      mucc "r$rev: edit target" put "$WORK/target.txt" "$R/trunk/target.txt"
    else
      printf 'o%s\n' "$rev" >> "$WORK/other.txt"
      mucc "r$rev: edit other" put "$WORK/other.txt" "$R/trunk/other.txt"
    fi
    j=$((j + 1))
  done
  mucc "r560: delete target" rm "$R/trunk/target.txt"
}

build_linear
build_copy
build_copy_wc
build_deleted
build_ancestor_copy
build_filecopy
build_i18n
build_date_edge
build_nested_copy
build_budget

for repo in linear copy copy-wc deleted ancestor-copy filecopy i18n date-edge nested-copy budget; do
  head=$("$SVN" info --show-item revision "file://$ROOT/$repo")
  echo "$repo HEAD=$head"
done
