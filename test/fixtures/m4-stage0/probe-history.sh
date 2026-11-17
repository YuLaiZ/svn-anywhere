#!/bin/sh
# 历史、复制与筛选场景的证据复跑脚本。
# 前置：先运行 build-fixtures.sh 生成仓库；默认仓库目录 /tmp/svn-anywhere-fixtures/repos。
# 输出：KEY=VALUE 断言行 + 少量原始 XML 摘要。全部命令 --non-interactive。
# HTTP 相关用例需另起本地矩阵容器（见本地实验记录），本脚本只覆盖 file://。
set -eu

ROOT=${1:-/tmp/svn-anywhere-fixtures/repos}
OUT=${2:-/tmp/svn-anywhere-fixtures/probe-out}
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

echo "## 默认跟随复制 / --stop-on-copy / 嵌套复制"
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
echo "COPY_DIRC_FOLLOW=$(revs a1-dirC-follow)"
echo "COPY_DIRC_STOP=$(revs a1-dirC-stop)"
echo "COPY_FILEC_FOLLOW=$(revs a1-fileC-follow)"
echo "COPY_FILEC_STOP=$(revs a1-fileC-stop)"
echo "COPY_DIRB_FOLLOW=$(revs a1-dirB-follow)"
echo "COPY_WC_DIRC_FOLLOW=$(revs a1-copywc-dirC-follow)"
echo "COPY_WC_DIRC_STOP=$(revs a1-copywc-dirC-stop)"
echo "COPY_WC_DIRB_FOLLOW=$(revs a1-copywc-dirB-follow)"
echo "NESTED_COPY_FOLLOW=$(revs a1-nested-follow)"
echo "NESTED_COPY_STOP=$(revs a1-nested-stop)"
echo "FILECOPY_PEG4=$(revs a1-filecopy-peg)"
echo "FILECOPY_STOP=$(revs a1-filecopy-stop)"
echo "COPY_DIRC_COPYFROM_REV_REMOTE=$(grep -o 'copyfrom-path="/trunk/dirB"' "$XML/a1-dirC-follow.xml" | head -1; grep -A1 'copyfrom-path="/trunk/dirB"' "$XML/a1-dirC-follow.xml" | grep -o 'copyfrom-rev="[0-9]*"' | head -1)"
echo "COPY_DIRC_COPYFROM_REV_WC=$(grep -A1 'copyfrom-path="/trunk/dirB"' "$XML/a1-copywc-dirC-follow.xml" | grep -o 'copyfrom-rev="[0-9]*"' | head -1)"
grep -c 'copyfrom-path' "$XML/a1-filecopy-peg.xml" | sed 's/^/FILECOPY_R3_COPYFROM_LINES=/'

echo "## 批次 / 最后一批 / 空历史 / 删除后路径 / pre-copy"
for n in 21 51 101; do
  "$SVN" log --xml --non-interactive -l "$n" -r 56:1 "$L" > "$XML/a2-l$n.xml" 2>/dev/null || true
  echo "BATCH_L${n}_COUNT=$(cnt a2-l$n)"
done
"$SVN" log --xml --non-interactive -r 4:4 "$D/trunk/other.txt" > "$XML/a2-empty.xml" 2>/dev/null || true
echo "EMPTY_COUNT=$(cnt a2-empty)"
"$SVN" log --xml --non-interactive "$D/trunk/sub" >"$XML/a2-del-head.xml" 2>"$XML/a2-del-head.err" || true
echo "DELETED_HEAD_ERR=$(tr '\n' '|' < "$XML/a2-del-head.err" | sed 's/|$//')"
"$SVN" log --xml --non-interactive -r 1:1 "$L/trunk/a.txt" >"$XML/a2-lowrev.xml" 2>"$XML/a2-lowrev.err" || true
echo "LOW_REV_ERR=$(tr '\n' '|' < "$XML/a2-lowrev.err" | sed 's/|$//')"
"$SVN" info --xml --non-interactive "$FC/trunk/copy.txt@2" >"$XML/a2-precopy.out" 2>"$XML/a2-precopy.err" || true
echo "PRECOPY_INFO_ERR=$(tr '\n' '|' < "$XML/a2-precopy.err" | sed 's/|$//')"

echo "## numeric peg 不跨删除点 / 祖先回退"
logxml a3-peg31 "" "$D/trunk/sub@3" -r 3:1
logxml a3-peg41 "" "$D/trunk/sub@3" -r 4:1
logxml a3-ancestor "" "$D/trunk@6" -r 6:1 --stop-on-copy
echo "PEG_BOUNDARY_PEG31=$(revs a3-peg31)"
echo "PEG_BOUNDARY_PEG41_XML=$(grep -c '<logentry' "$XML/a3-peg41.xml" 2>/dev/null || echo 0)"
echo "PEG_BOUNDARY_PEG41_ERR=$(tr '\n' '|' < "$XML/a3-peg41.err" | sed 's/|$//')"
echo "ANCESTOR_ALL=$(revs a3-ancestor)"
echo "ANCESTOR_MATCH_FILE=$(match a3-ancestor /trunk/sub/file.txt file)"
echo "ANCESTOR_MATCH_DIR=$(match a3-ancestor /trunk/sub dir)"

echo "## cursor 边界"
"$SVN" log --xml --non-interactive -l 21 -r 56:1 "$L" > "$XML/a4-b1.xml" 2>/dev/null
"$SVN" log --xml --non-interactive -l 21 -r 35:1 "$L" > "$XML/a4-b2.xml" 2>/dev/null
"$SVN" log --xml --non-interactive -l 21 -r 36:1 "$L" > "$XML/a4-b2-wrong.xml" 2>/dev/null
"$SVN" log --xml --non-interactive -l 21 -r 1:1 "$L" > "$XML/a4-last.xml" 2>/dev/null
"$SVN" log --xml --non-interactive -r 0:1 "$L" > "$XML/a4-zero.xml" 2>/dev/null
echo "CURSOR_BATCH1=$(revs a4-b1)"
echo "CURSOR_BATCH2=$(revs a4-b2)"
echo "CURSOR_BATCH2_WRONG=$(revs a4-b2-wrong)"
echo "CURSOR_LAST=$(revs a4-last)"
echo "CURSOR_R0=$(revs a4-zero)"

echo "## 多源栈 / 复制点停止 / 同 revision 去重对照 / 500 预算"
logxml b5-src1 "" "$NC/C@7" -r 7:1 --stop-on-copy
logxml b5-src2 "" "$NC/B@4" -r 4:1 --stop-on-copy
logxml b5-src3 "" "$NC/A@2" -r 2:1
logxml b5-follow "" "$NC/C@7" -r 7:1
echo "MULTI_SOURCE_SRC1=$(revs b5-src1)"
echo "MULTI_SOURCE_SRC2=$(revs b5-src2)"
echo "MULTI_SOURCE_SRC3=$(revs b5-src3)"
echo "MULTI_SOURCE_FOLLOW=$(revs b5-follow)"
echo "MULTI_SOURCE_OVERLAP_DETAIL=$(python3 - "$XML/b5-follow.xml" "$XML/b5-src2.xml" "$XML/b5-src3.xml" <<'EOF'
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

echo "## 500 条扫描产生 80 条匹配 / 每页 50"
"$SVN" log --xml -v --non-interactive --stop-on-copy -r 560:1 "$BG/trunk@560" > "$XML/b6-full.xml" 2>/dev/null || true
python3 - "$XML/b6-full.xml" <<'EOF'
import re, sys
xml = open(sys.argv[1]).read()
entries = re.findall(r'<logentry\s+revision="(\d+)">(.*?)</logentry>', xml, re.S)
print("SCAN_BUDGET_TOTAL_RAW=%d" % len(entries))
hits = [int(r) for r, b in entries if ">/trunk/target.txt</path>" in b]
print("SCAN_BUDGET_TOTAL_HITS=%d" % len(hits))
win = [(int(r), b) for r, b in entries if 61 <= int(r) <= 560]
print("SCAN_BUDGET_WINDOW_RAW=%d" % len(win))
print("SCAN_BUDGET_WINDOW_HITS=%d" % sum(1 for _, b in win if ">/trunk/target.txt</path>" in b))
print("SCAN_BUDGET_WINDOW_REVS=%d..%d" % (max(r for r, _ in win), min(r for r, _ in win)))
EOF

echo "## 客户端分页模拟（batch=50, 每批 51, 单轮 500 预算）"
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
echo "PAGING_REQUESTS=$req"
echo "PAGING_RAW_FETCHED_IN_LOAD=$raw"
echo "PAGING_MATCHED=$matched"
echo "PAGING_NEXT_CURSOR=$cursor"
echo "PAGING_DISPLAY_FIRST=50"
echo "PAGING_PENDING=$((matched - 50))"

echo "## 祖先复制同名路径不误归因"
logxml c7-stop "" "$AC/trunk@5" -r 5:1 --stop-on-copy
logxml c7-follow "" "$AC/trunk@5" -r 5:1
echo "ANCESTOR_COPY_STOP_ALL=$(revs c7-stop)"
echo "ANCESTOR_COPY_STOP_MATCH_FILE=$(match c7-stop /trunk/x.txt file)"
echo "ANCESTOR_COPY_FOLLOW_ALL=$(revs c7-follow)"
echo "ANCESTOR_COPY_FOLLOW_MATCH_FILE=$(match c7-follow /trunk/x.txt file)"
echo "ANCESTOR_COPY_STOP_COPYFROM=$(grep -o 'copyfrom-path="[^"]*"\|copyfrom-rev="[^"]*"' "$XML/c7-stop.xml" | tr '\n' ';')"

echo "## 文件/目录复制形态与四态数据"
logxml c8-filecopy-peg4 "" "$FC/trunk/copy.txt@4" -r 4:1
echo "COPY_SHAPE_FILECOPY_PEG4=$(revs c8-filecopy-peg4)"
"$SVN" log --xml --non-interactive "$FC/trunk/copy.txt" >/dev/null 2>"$XML/c8-filecopy-head.err" || true
echo "COPY_SHAPE_FILECOPY_HEAD_ERR=$(tr '\n' '|' < "$XML/c8-filecopy-head.err" | sed 's/|$//')"
echo "COPY_SHAPE_EMPTY=$(cnt a2-empty)"
echo "COPY_SHAPE_NOTFOUND_MATCH=$(match a3-ancestor /trunk/gone.txt file)"
echo "COPY_SHAPE_NOTFOUND_STRICT=$(match a3-ancestor /trunk/gone.txt file strict)"
echo "COPY_SHAPE_TARGET_STRICT=$(match a3-ancestor /trunk/sub/file.txt file strict)"
"$SVN" info --xml --non-interactive "file://$ROOT/no-such-repo/x@1" >"$XML/c8-error.out" 2>"$XML/c8-error.err" || true
echo "COPY_SHAPE_ERROR_ERR=$(tr '\n' '|' < "$XML/c8-error.err" | sed 's/|$//')"

echo "## 筛选字段形态"
logxml c10-i18n "" "$I18N"
echo "FILTER_FIELD_AUTHORS=$(python3 "$HERE/probe_lib.py" authors "$XML/c10-i18n.xml")"
echo "FILTER_FIELD_MSG_SAMPLE=$(grep -o '<msg>[^<]*</msg>' "$XML/c10-i18n.xml" | head -3 | tr '\n' ';')"
"$SVN" log --xml --non-interactive -r 1 "$DE" > "$XML/c10-date.xml" 2>/dev/null
echo "FILTER_FIELD_DATE_UTC=$(grep -o '<date>[^<]*</date>' "$XML/c10-date.xml")"
echo "FILTER_FIELD_COPYFROM_PATH_SAMPLE=$(grep -o 'copyfrom-path="[^"]*"' "$XML/a1-dirC-follow.xml" | head -2 | tr '\n' ';')"

echo "## info 错误分类（file://）"
for spec in "notexist:$D/trunk/nope@6" "rev999:$D/trunk@999" "repo:none"; do
  name=${spec%%:*}
  case $name in
    notexist) "$SVN" info --xml --non-interactive "$D/trunk/nope@6" >/dev/null 2>"$XML/c11-$name.err" || true ;;
    rev999) "$SVN" info --xml --non-interactive "$D/trunk@999" >/dev/null 2>"$XML/c11-$name.err" || true ;;
    repo) "$SVN" info --xml --non-interactive "file://$ROOT/no-such-repo/x@1" >/dev/null 2>"$XML/c11-$name.err" || true ;;
  esac
  echo "INFO_ERROR_${name}_ERR=$(tr '\n' '|' < "$XML/c11-$name.err" | sed 's/|$//')"
done
echo "INFO_ERROR_HTTP_NOTE=HTTP auth/permission/network 用例需本地矩阵容器，见本地实验记录"
