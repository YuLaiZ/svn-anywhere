#!/bin/bash
# M4 阶段 0 / V3 可复跑探测：svn diff --xml --summarize 的文件/目录行为、
# 相对路径映射、相同内容元数据、删除后节点、peg 陷阱、类型变化。
# 用法：先跑 fixture.sh，再 M4_STAGE0_ROOT=/tmp/m4-stage0-V3 ./summarize-probe.sh
set -uo pipefail
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
ROOT=${M4_STAGE0_ROOT:-/tmp/m4-stage0-V3}
URL="file://$ROOT/fixture01/repo"
EXP=$ROOT/export
mkdir -p "$EXP"
exec > >(tee "$ROOT/logs/v3-summarize-probe.log") 2>&1
run() {
  echo
  echo "### $1"
  shift
  echo "\$ svn $*"
  svn "$@" 2>&1
  echo "[exit=$?]"
}
echo "== V3 summarize 探测 $(date -u +%FT%TZ) =="

echo "===== A. 文件目标 ====="
run "A1 文本修改 text.txt@1..2" diff --xml --summarize --non-interactive --old "$URL/trunk/text.txt@1" --new "$URL/trunk/text.txt@2"
run "A2 文件新增 added.txt@1..2" diff --xml --summarize --non-interactive --old "$URL/trunk/added.txt@1" --new "$URL/trunk/added.txt@2"
run "A3 文件删除 deleted.txt@1..2" diff --xml --summarize --non-interactive --old "$URL/trunk/deleted.txt@1" --new "$URL/trunk/deleted.txt@2"
run "A4 属性-only props-only.txt@1..2（item=none）" diff --xml --summarize --non-interactive --old "$URL/trunk/props-only.txt@1" --new "$URL/trunk/props-only.txt@2"
run "A5 内容+属性 content-props.txt@1..2" diff --xml --summarize --non-interactive --old "$URL/trunk/content-props.txt@1" --new "$URL/trunk/content-props.txt@2"
run "A6 二进制 bin.dat@1..2" diff --xml --summarize --non-interactive --old "$URL/trunk/bin.dat@1" --new "$URL/trunk/bin.dat@2"
run "A7 无差异 text.txt@2..2" diff --xml --summarize --non-interactive --old "$URL/trunk/text.txt@2" --new "$URL/trunk/text.txt@2"
run "A8 相同内容不同元数据 meta.txt@2..9（空）" diff --xml --summarize --non-interactive --old "$URL/trunk/meta.txt@2" --new "$URL/trunk/meta.txt@9"
run "A9 单 URL 范围形式 -r 1:2 text.txt" diff --xml --summarize --non-interactive -r 1:2 "$URL/trunk/text.txt"

echo "===== B. 目录目标与相对路径映射 ====="
run "B1 trunk 整树 @2..15" diff --xml --summarize --non-interactive --old "$URL/trunk@2" --new "$URL/trunk@15"
run "B2 dirA 子树 @1..2" diff --xml --summarize --non-interactive --old "$URL/trunk/dirA@1" --new "$URL/trunk/dirA@2"
run "B3 复制目录 dirA@2 vs dirA3@7（path 以旧根为基准）" diff --xml --summarize --non-interactive --old "$URL/trunk/dirA@2" --new "$URL/trunk/dirA3@7"
run "B4 复制目录未修改 dirA@2 vs dirA3@6（空）" diff --xml --summarize --non-interactive --old "$URL/trunk/dirA@2" --new "$URL/trunk/dirA3@6"
run "B5 new 端从未存在 dirA@2 vs never-exists@7（E160013）" diff --xml --summarize --non-interactive --old "$URL/trunk/dirA@2" --new "$URL/trunk/never-exists@7"
run "B6 new 端已删除 branches/dirA2@5 vs @7（输出 deleted 树）" diff --xml --summarize --non-interactive --old "$URL/branches/dirA2@5" --new "$URL/branches/dirA2@7"
run "B7 两端都不可读 branches/dirA2@6 vs @7（E160013）" diff --xml --summarize --non-interactive --old "$URL/branches/dirA2@6" --new "$URL/branches/dirA2@7"
run "B8 目录属性变化 dirA@2 vs @14（item=none props=modified kind=dir）" diff --xml --summarize --non-interactive --old "$URL/trunk/dirA@2" --new "$URL/trunk/dirA@14"
run "B9 同路径类型变化 meta.txt@9 vs @15（deleted+added 两条）" diff --xml --summarize --non-interactive --old "$URL/trunk/meta.txt@9" --new "$URL/trunk/meta.txt@15"

echo "===== C. 映射正确性关键证据 ====="
run "C1 旧根 dirA 下实际内容 f1.txt@7" cat --non-interactive -r 7 "$URL/trunk/dirA/f1.txt@7"
run "C2 新根 dirA3 下实际内容 f1.txt@7" cat --non-interactive -r 7 "$URL/trunk/dirA3/f1.txt@7"
run "C3 旧端 added 条目 URL 不存在：dirA/new.txt@1" cat --non-interactive -r 1 "$URL/trunk/dirA/new.txt@1"
run "C4 空格路径编码：summarize trunk@2..8（path 为 %20）" diff --xml --summarize --non-interactive --old "$URL/trunk@2" --new "$URL/trunk@8"
run "C5 list 的 name 原样空格（对照）" list --xml --non-interactive --depth immediates -r 8 "$URL/trunk"

echo "===== D. 删除后节点与删除前 revision ====="
run "D1 lifecycle.txt info @5（删除后：W170000+E200009）" info --xml --non-interactive -r 5 "$URL/trunk/lifecycle.txt@5"
run "D2 lifecycle.txt info @4（删除前）" info --xml --non-interactive -r 4 "$URL/trunk/lifecycle.txt@4"
run "D3 lifecycle.txt log --stop-on-copy @4" log --non-interactive -v --stop-on-copy "$URL/trunk/lifecycle.txt@4"
run "D4 lifecycle.txt cat @4" cat --non-interactive -r 4 "$URL/trunk/lifecycle.txt@4"
run "D5 export lifecycle.txt@4 -> 无 @ 目标" export --non-interactive -q -r 4 "$URL/trunk/lifecycle.txt@4" "$EXP/lifecycle-r4.txt"
run "D6 export lifecycle.txt@4 -> 含 @ 目标（E200009 peg not allowed）" export --non-interactive -q -r 4 "$URL/trunk/lifecycle.txt@4" "$EXP/lifecycle@4.txt"
run "D7 export lifecycle.txt@4 -> 含 @ 目标尾部补 @（成功）" export --non-interactive -q -r 4 "$URL/trunk/lifecycle.txt@4" "$EXP/lifecycle@4.txt@"
run "D8 export lifecycle.txt@5（删除后：E170000）" export --non-interactive -q -r 5 "$URL/trunk/lifecycle.txt@5" "$EXP/lifecycle-r5.txt"
run "D9 log -r 3 URL@2（删除提交路径不可读：E160013）" log --non-interactive -v -r 3 "$URL/trunk/lifecycle.txt@2"

echo "===== E. list 单端枚举与 peg 陷阱 ====="
run "E1 list -r 5 branches/dirA2@5（带 peg，成功）" list --xml --non-interactive --depth infinity -r 5 "$URL/branches/dirA2@5"
run "E2 list -r 5 branches/dirA2（无 peg，默认 HEAD 失败）" list --xml --non-interactive --depth infinity -r 5 "$URL/branches/dirA2"
run "E3 list -r 13 branches/dirA2@5（operative 超过删除点也失败）" list --xml --non-interactive --depth infinity -r 13 "$URL/branches/dirA2@5"
run "E4 list 单目录只输出根以下（dirA@2）" list --xml --non-interactive --depth infinity -r 2 "$URL/trunk/dirA"
run "E5 list 文件 URL（单条目 name=文件名）" list --xml --non-interactive --depth infinity -r 2 "$URL/trunk/text.txt"
run "E6 list 空目录（空 lists）" list --xml --non-interactive --depth infinity -r 2 "$URL/trunk/empty-dir"

echo "===== F. 导出目标覆盖/符号链接/清理 ====="
mkdir -p "$EXP/force-dir"
printf 'stale\n' > "$EXP/force-dir/stale.txt"
run "F1 export 到已存在目录（E155000）" export --non-interactive -q -r 9 "$URL/trunk@9" "$EXP/force-dir"
run "F2 export --force 覆盖（旧多余文件保留）" export --non-interactive -q --force -r 9 "$URL/trunk@9" "$EXP/force-dir"
echo "-- F3 stale.txt 保留: $(test -e "$EXP/force-dir/stale.txt" && echo yes || echo no)"
printf 'existing\n' > "$EXP/text2.txt"
run "F4 export 到已存在文件（默认拒绝）" export --non-interactive -q -r 2 "$URL/trunk/text.txt@2" "$EXP/text2.txt"
run "F5 export --force 覆盖文件（成功）" export --non-interactive -q --force -r 2 "$URL/trunk/text.txt@2" "$EXP/text2.txt"
run "F6 export 符号链接 link.txt@9" export --non-interactive -q -r 9 "$URL/trunk/link.txt@9" "$EXP/link-export.txt"
echo "-- F7 链接类型: $(ls -l "$EXP/link-export.txt" 2>&1 | tail -1)"
run "F8 export 二进制 bin.dat@9" export --non-interactive -q -r 9 "$URL/trunk/bin.dat@9" "$EXP/bin-export.dat"
echo "-- F9 二进制 md5: $(md5 -q "$EXP/bin-export.dat" 2>&1) vs cat: $(svn cat --non-interactive -r 9 "$URL/trunk/bin.dat@9" | md5 -q)"
echo "== 探测结束 $(date -u +%FT%TZ) =="
