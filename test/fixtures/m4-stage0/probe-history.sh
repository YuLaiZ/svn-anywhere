#!/bin/sh
# M4 阶段 0 / V2（历史、复制与筛选）证据复跑脚本。
# 前置：先运行 build-fixtures.sh 生成仓库；默认仓库目录 /tmp/m4-stage0-v2/repos。
# 输出：KEY=VALUE 断言行 + 少量原始 XML 摘要。全部命令 --non-interactive。
# HTTP 相关用例需另起本地矩阵容器（见阶段 0 记录），本脚本只覆盖 file://。
set -eu

ROOT=${1:-/tmp/m4-stage0-v2/repos}
OUT=${2:-/tmp/m4-stage0-v2/probe-out}
SVN=${SVN:-svn}
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$OUT"
XML="$OUT/xml"
mkdir -p "$XML"

export LANG=${LANG:-en_US.UTF-8}
export LC_ALL=${LC_ALL:-en_US.UTF-8}

L="file://$ROOT/linear"
C="file://$ROOT/copy"
D="file://$ROOT/deleted"
AC="file://$ROOT/ancestor-copy"
FC="file://$ROOT/filecopy"
NC="file://$ROOT/nested-copy"
BG="file://$ROOT/budget"
I18N="file://$ROOT/i18n"
DE="file://$ROOT/date-edge"

logxml() { # logxml OUTNAME REVIDARGS PATH [extra args...]
  name=$1; revargs=$2; path=$3; shift 3
  "$SVN" log --xml -v --non-interactive $revargs "$@" "$path" > "$XML/$name.xml" 2>"$XML/$name.err" || true
}

revs() { python3 "$HERE/probe_lib.py" revs "$XML/$1.xml"; }
cnt() { python3 "$HERE/probe_lib.py" count "$XML/$1.xml"; }
match() { python3 "$HERE/probe_lib.py" match "$XML/$1.xml" "$2" "$3" ${4:-}; }

echo "## A1 默认跟随复制 / --stop-on-copy / 嵌套复制"
logxml a1-dirC-follow "" "$C/trunk/dirC"
logxml a1-dirC-stop "" "$C/trunk/dirC" --stop-on-copy
logxml a1-fileC-follow "" "$C/trunk/dirC/file1.txt"
logxml a1-fileC-stop "" "$C/trunk/dirC/file1.txt" --stop-on-copy
logxml a1-dirB-follow "" "$C/trunk/dirB"
logxml a1-copywc-dirC-follow "" "file://$ROOT/copy-wc/trunk/dirC"
logxml a1-copywc-dirC-stop "" "file://$ROOT/copy-wc/trunk/dirC" --stop-on-copy
logxml a1-copywc-dirB-follow "" "file://$ROOT/copy-wc/trunk/dirB"
logxml a1-nested-follow "" "$NC/C"
logxml a1-nested-stop "" "$NC/C" --stop-on-copy
logxml a1-filecopy-peg "" "$FC/trunk/copy.txt@4" -r 4:1
logxml a1-filecopy-stop "" "$FC/trunk/copy.txt@4" -r 4:1 --stop-on-copy
echo "A1_DIRC_FOLLOW=$(revs a1-dirC-follow)"
echo "A1_DIRC_STOP=$(revs a1-dirC-stop)"
echo "A1_FILEC_FOLLOW=$(revs a1-fileC-follow)"
echo "A1_FILEC_STOP=$(revs a1-fileC-stop)"
echo "A1_DIRB_FOLLOW=$(revs a1-dirB-follow)"
echo "A1_COPYWC_DIRC_FOLLOW=$(revs a1-copywc-dirC-follow)"
echo "A1_COPYWC_DIRC_STOP=$(revs a1-copywc-dirC-stop)"
echo "A1_COPYWC_DIRB_FOLLOW=$(revs a1-copywc-dirB-follow)"
echo "A1_NESTED_FOLLOW=$(revs a1-nested-follow)"
echo "A1_NESTED_STOP=$(revs a1-nested-stop)"
echo "A1_FILECOPY_PEG4=$(revs a1-filecopy-peg)"
echo "A1_FILECOPY_STOP=$(revs a1-filecopy-stop)"
echo "A1_DIRC_COPYFROM_REV_REMOTE=$(grep -o 'copyfrom-path="/trunk/dirB"' "$XML/a1-dirC-follow.xml" | head -1; grep -A1 'copyfrom-path="/trunk/dirB"' "$XML/a1-dirC-follow.xml" | grep -o 'copyfrom-rev="[0-9]*"' | head -1)"
echo "A1_DIRC_COPYFROM_REV_WC=$(grep -A1 'copyfrom-path="/trunk/dirB"' "$XML/a1-copywc-dirC-follow.xml" | grep -o 'copyfrom-rev="[0-9]*"' | head -1)"
grep -c 'copyfrom-path' "$XML/a1-filecopy-peg.xml" | sed 's/^/A1_FILECOPY_R3_COPYFROM_LINES=/'

echo "## A2 批次 / 最后一批 / 空历史 / 删除后路径 / pre-copy"
for n in 21 51 101; do
  "$SVN" log --xml --non-interactive -l "$n" -r 56:1 "$L" > "$XML/a2-l$n.xml" 2>/dev/null || true
  echo "A2_L${n}_COUNT=$(cnt a2-l$n)"
done
"$SVN" log --xml --non-interactive -r 4:4 "$D/trunk/other.txt" > "$XML/a2-empty.xml" 2>/dev/null || true
echo "A2_EMPTY_COUNT=$(cnt a2-empty)"
"$SVN" log --xml --non-interactive "$D/trunk/sub" >"$XML/a2-del-head.xml" 2>"$XML/a2-del-head.err" || true
echo "A2_DELETED_HEAD_ERR=$(tr '\n' '|' < "$XML/a2-del-head.err" | sed 's/|$//')"
"$SVN" log --xml --non-interactive -r 1:1 "$L/trunk/a.txt" >"$XML/a2-lowrev.xml" 2>"$XML/a2-lowrev.err" || true
echo "A2_LOW_REV_ERR=$(tr '\n' '|' < "$XML/a2-lowrev.err" | sed 's/|$//')"
"$SVN" info --xml --non-interactive "$FC/trunk/copy.txt@2" >"$XML/a2-precopy.out" 2>"$XML/a2-precopy.err" || true
echo "A2_PRECOPY_INFO_ERR=$(tr '\n' '|' < "$XML/a2-precopy.err" | sed 's/|$//')"

echo "## A3 numeric peg 不跨删除点 / 祖先回退"
logxml a3-peg31 "" "$D/trunk/sub@3" -r 3:1
logxml a3-peg41 "" "$D/trunk/sub@3" -r 4:1
logxml a3-ancestor "" "$D/trunk@6" -r 6:1 --stop-on-copy
echo "A3_PEG31=$(revs a3-peg31)"
echo "A3_PEG41_XML=$(grep -c '<logentry' "$XML/a3-peg41.xml" 2>/dev/null || echo 0)"
echo "A3_PEG41_ERR=$(tr '\n' '|' < "$XML/a3-peg41.err" | sed 's/|$//')"
echo "A3_ANCESTOR_ALL=$(revs a3-ancestor)"
echo "A3_ANCESTOR_MATCH_FILE=$(match a3-ancestor /trunk/sub/file.txt file)"
echo "A3_ANCESTOR_MATCH_DIR=$(match a3-ancestor /trunk/sub dir)"

echo "## A4 cursor 边界"
"$SVN" log --xml --non-interactive -l 21 -r 56:1 "$L" > "$XML/a4-b1.xml" 2>/dev/null
"$SVN" log --xml --non-interactive -l 21 -r 35:1 "$L" > "$XML/a4-b2.xml" 2>/dev/null
"$SVN" log --xml --non-interactive -l 21 -r 36:1 "$L" > "$XML/a4-b2-wrong.xml" 2>/dev/null
"$SVN" log --xml --non-interactive -l 21 -r 1:1 "$L" > "$XML/a4-last.xml" 2>/dev/null
"$SVN" log --xml --non-interactive -r 0:1 "$L" > "$XML/a4-zero.xml" 2>/dev/null
echo "A4_BATCH1=$(revs a4-b1)"
echo "A4_BATCH2=$(revs a4-b2)"
echo "A4_BATCH2_WRONG_CURSOR=$(revs a4-b2-wrong)"
echo "A4_LAST=$(revs a4-last)"
echo "A4_R0=$(revs a4-zero)"

echo "## B5 多源栈 / 复制点停止 / 同 revision 去重对照 / 500 预算"
logxml b5-src1 "" "$NC/C@7" -r 7:1 --stop-on-copy
logxml b5-src2 "" "$NC/B@4" -r 4:1 --stop-on-copy
logxml b5-src3 "" "$NC/A@2" -r 2:1
logxml b5-follow "" "$NC/C@7" -r 7:1
echo "B5_SRC1=$(revs b5-src1)"
echo "B5_SRC2=$(revs b5-src2)"
echo "B5_SRC3=$(revs b5-src3)"
echo "B5_FOLLOW=$(revs b5-follow)"
echo "B5_OVERLAP_DETAIL=$(python3 - "$XML/b5-follow.xml" "$XML/b5-src2.xml" "$XML/b5-src3.xml" <<'EOF'
import sys, re
def revs(p):
    return [int(x) for x in re.findall(r'<logentry\s+revision="(\d+)"', open(p).read())]
f, s2, s3 = (revs(p) for p in sys.argv[1:4])
u = sorted(set(f) | set(s2) | set(s3), reverse=True)
print("raw=%d;unique=%d;union=%s;overlap_s2=%s;overlap_s3=%s" % (
    len(f)+len(s2)+len(s3), len(u), ",".join(map(str,u)),
    ",".join(map(str, sorted(set(f)&set(s2), reverse=True))),
    ",".join(map(str, sorted(set(f)&set(s3), reverse=True)))))
EOF
)"

echo "## B6 500 条扫描产生 80 条匹配 / 每页 50"
"$SVN" log --xml -v --non-interactive --stop-on-copy -r 560:1 "$BG/trunk@560" > "$XML/b6-full.xml" 2>/dev/null || true
python3 - "$XML/b6-full.xml" <<'EOF'
import re, sys
xml = open(sys.argv[1]).read()
entries = re.findall(r'<logentry\s+revision="(\d+)">(.*?)</logentry>', xml, re.S)
print("B6_TOTAL_RAW=%d" % len(entries))
hits = [int(r) for r, b in entries if ">/trunk/target.txt</path>" in b]
print("B6_TOTAL_HITS=%d" % len(hits))
win = [(int(r), b) for r, b in entries if 61 <= int(r) <= 560]
print("B6_WINDOW_RAW=%d" % len(win))
print("B6_WINDOW_HITS=%d" % sum(1 for _, b in win if ">/trunk/target.txt</path>" in b))
print("B6_WINDOW_REVS=%d..%d" % (max(r for r, _ in win), min(r for r, _ in win)))
EOF

echo "## B6b 客户端分页模拟（batch=50, 每批 51, 单轮 500 预算）"
batch=50; cursor=560; raw=0; req=0; matched=0; last_rev=0
while [ "$cursor" -ge 1 ] && [ "$raw" -lt 500 ]; do
  req=$((req + 1))
  "$SVN" log --xml -v --non-interactive -l $((batch + 1)) -r "$cursor:1" "$BG/trunk@560" > "$XML/b6b-req$req.xml" 2>/dev/null || true
  line=$(python3 - "$XML/b6b-req$req.xml" $((500 - raw)) <<'EOF'
import re, sys
xml = open(sys.argv[1]).read()
entries = re.findall(r'<logentry\s+revision="(\d+)">(.*?)</logentry>', xml, re.S)
take = min(len(entries), int(sys.argv[2]))
m = sum(1 for r, b in entries[:take] if ">/trunk/target.txt</path>" in b)
last = int(entries[take-1][0]) if take else 0
print("%d %d %d" % (take, m, last))
EOF
)
  take=$(echo "$line" | cut -d' ' -f1)
  m=$(echo "$line" | cut -d' ' -f2)
  last_rev=$(echo "$line" | cut -d' ' -f3)
  matched=$((matched + m)); raw=$((raw + take))
  cursor=$((last_rev - 1))
done
echo "B6B_REQUESTS=$req"
echo "B6B_RAW_FETCHED_IN_LOAD=$raw"
echo "B6B_MATCHED=$matched"
echo "B6B_NEXT_CURSOR=$cursor"
echo "B6B_DISPLAY_FIRST=50"
echo "B6B_PENDING=$((matched - 50))"

echo "## C7 祖先复制同名路径不误归因"
logxml c7-stop "" "$AC/trunk@5" -r 5:1 --stop-on-copy
logxml c7-follow "" "$AC/trunk@5" -r 5:1
echo "C7_STOP_ALL=$(revs c7-stop)"
echo "C7_STOP_MATCH_FILE=$(match c7-stop /trunk/x.txt file)"
echo "C7_FOLLOW_ALL=$(revs c7-follow)"
echo "C7_FOLLOW_MATCH_FILE=$(match c7-follow /trunk/x.txt file)"
echo "C7_STOP_COPYFROM=$(grep -o 'copyfrom-path="[^"]*"\|copyfrom-rev="[^"]*"' "$XML/c7-stop.xml" | tr '\n' ';')"

echo "## C8 文件/目录复制形态与四态数据"
logxml c8-filecopy-peg4 "" "$FC/trunk/copy.txt@4" -r 4:1
echo "C8_FILECOPY_PEG4=$(revs c8-filecopy-peg4)"
"$SVN" log --xml --non-interactive "$FC/trunk/copy.txt" >/dev/null 2>"$XML/c8-filecopy-head.err" || true
echo "C8_FILECOPY_HEAD_ERR=$(tr '\n' '|' < "$XML/c8-filecopy-head.err" | sed 's/|$//')"
echo "C8_EMPTY=$(cnt a2-empty)"
echo "C8_NOTFOUND_MATCH=$(match a3-ancestor /trunk/gone.txt file)"
echo "C8_NOTFOUND_STRICT=$(match a3-ancestor /trunk/gone.txt file strict)"
echo "C8_TARGET_STRICT=$(match a3-ancestor /trunk/sub/file.txt file strict)"
"$SVN" info --xml --non-interactive "file://$ROOT/no-such-repo/x@1" >"$XML/c8-error.out" 2>"$XML/c8-error.err" || true
echo "C8_ERROR_ERR=$(tr '\n' '|' < "$XML/c8-error.err" | sed 's/|$//')"

echo "## C10 筛选字段形态"
logxml c10-i18n "" "$I18N"
echo "C10_AUTHORS=$(python3 "$HERE/probe_lib.py" authors "$XML/c10-i18n.xml")"
echo "C10_MSG_SAMPLE=$(grep -o '<msg>[^<]*</msg>' "$XML/c10-i18n.xml" | head -3 | tr '\n' ';')"
"$SVN" log --xml --non-interactive -r 1 "$DE" > "$XML/c10-date.xml" 2>/dev/null
echo "C10_DATE_UTC=$(grep -o '<date>[^<]*</date>' "$XML/c10-date.xml")"
echo "C10_COPYFROM_PATH_SAMPLE=$(grep -o 'copyfrom-path="[^"]*"' "$XML/a1-dirC-follow.xml" | head -2 | tr '\n' ';')"

echo "## C11 info 错误分类（file://）"
for spec in "notexist:$D/trunk/nope@6" "rev999:$D/trunk@999" "repo:none"; do
  name=${spec%%:*}
  case $name in
    notexist) "$SVN" info --xml --non-interactive "$D/trunk/nope@6" >/dev/null 2>"$XML/c11-$name.err" || true ;;
    rev999) "$SVN" info --xml --non-interactive "$D/trunk@999" >/dev/null 2>"$XML/c11-$name.err" || true ;;
    repo) "$SVN" info --xml --non-interactive "file://$ROOT/no-such-repo/x@1" >/dev/null 2>"$XML/c11-$name.err" || true ;;
  esac
  echo "C11_${name}_ERR=$(tr '\n' '|' < "$XML/c11-$name.err" | sed 's/|$//')"
done
echo "C11_HTTP_NOTE=HTTP auth/permission/network 用例需本地矩阵容器，见阶段 0 记录"
