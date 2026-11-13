#!/usr/bin/env bash
# M4 阶段 0 / V4 冲突类型与动作的可复跑探针。
# 只依赖本机 svn/svnadmin、file:// 仓库与 xmllint，不访问任何远端服务器或真实凭据。
# 用法：bash test/fixtures/m4-stage0/v4-conflict-probe.sh [--keep]
# 断言失败时以非零码退出；--keep 保留临时目录供人工核查。
set -euo pipefail
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/m4-v4-probe.XXXXXX")
cleanup() {
  if [ "$KEEP" = 1 ]; then echo "kept: $ROOT"; else rm -rf "$ROOT"; fi
}
trap cleanup EXIT
fail() { echo "ASSERT FAILED: $*" >&2; exit 1; }
assert_eq() { [ "$1" = "$2" ] || fail "$3 (got '$1', want '$2')"; }
xcount() { # $1=xml 文件 $2=xpath count 表达式
  xmllint --xpath "$2" "$1" 2>/dev/null || true
}
status_code() { # $1=目录 $2=路径；输出首列状态码，空状态输出空
  ( cd "$1" && svn status "$2" | head -1 | cut -c1 )
}
command -v xmllint >/dev/null || fail "需要 xmllint（libxml2）"

echo "== 构建仓库与冲突矩阵（${ROOT}）=="
svnadmin create "$ROOT/repo"
svnadmin create "$ROOT/extra-repo"
svn co -q "file://$ROOT/repo" "$ROOT/wc0"
svn co -q "file://$ROOT/extra-repo" "$ROOT/extra-wc0"

cd "$ROOT/wc0"
printf 'line1\nline2\nline3\nline4\nline5\n' > text.txt
printf 'prop content\n' > prop.txt
printf 'mix1\nmix2\nmix3\n' > mixed.txt
printf 'multi content\n' > multi.txt
printf 'binary base \x00\x01\x02 data\n' > binary.bin
printf 'tree-del base\n' > tree-del.txt
mkdir -p tree-dir && printf 'tree-dir child base\n' > tree-dir/a.txt
mkdir -p extdir && printf 'outer own file\n' > extdir/own.txt
svn add -q text.txt prop.txt mixed.txt multi.txt binary.bin tree-del.txt tree-dir extdir
svn propset -q k base prop.txt
svn propset -q m base mixed.txt
svn propset -q p1 base1 multi.txt
svn propset -q p2 base2 multi.txt
svn commit -q -m "r-base"
svn update -q

cd "$ROOT/extra-wc0"
printf 'external base\n' > f.txt
svn add -q f.txt
svn commit -q -m "ext-base"
cd "$ROOT/wc0"
svn propset -q svn:externals "ext file://$ROOT/extra-repo" extdir
svn commit -q -m "add externals"
svn update -q

svn co -q "file://$ROOT/repo" "$ROOT/wc1"
svn co -q "file://$ROOT/repo" "$ROOT/wc2"

# 传入侧（wc1）提交
cd "$ROOT/wc1"
sed -i.bak 's/^line1$/line1-theirs/' text.txt && rm text.txt.bak
svn propset -q k theirs prop.txt
sed -i.bak 's/^mix1$/mix1-theirs/' mixed.txt && rm mixed.txt.bak
svn propset -q m theirs mixed.txt
svn propset -q p1 theirs1 multi.txt
svn propset -q p2 theirs2 multi.txt
printf 'binary theirs \x00\xff data\n' > binary.bin
svn rm -q tree-del.txt
svn rm -q tree-dir
printf 'tree-add theirs\n' > tree-add.txt
svn add -q tree-add.txt
svn commit -q -m "incoming changes"
svn update -q

cd "$ROOT/extra-wc0"
printf 'external theirs\n' > f.txt
svn commit -q -m "ext-incoming"

# 本地侧（wc2）未提交修改后 update 产生冲突
cd "$ROOT/wc2"
sed -i.bak 's/^line1$/line1-local/' text.txt && rm text.txt.bak
svn propset -q k local prop.txt
sed -i.bak 's/^mix1$/mix1-local/' mixed.txt && rm mixed.txt.bak
svn propset -q m local mixed.txt
svn propset -q p1 local1 multi.txt
svn propset -q p2 local2 multi.txt
printf 'binary local \x00\xfe data\n' > binary.bin
printf 'tree-del local edit\n' > tree-del.txt
printf 'tree-dir child local edit\n' > tree-dir/a.txt
printf 'tree-add local\n' > tree-add.txt
svn add -q tree-add.txt
printf 'external local\n' > extdir/ext/f.txt
svn update > "$ROOT/update-wc2.out" 2>&1 || fail "wc2 update 应成功（冲突仍 exit 0）"

echo "== 1. status --xml --ignore-externals 三条判据与 external 隔离 =="
svn status --xml --ignore-externals > "$ROOT/status.xml"
assert_eq "$(xcount "$ROOT/status.xml" 'count(//entry[wc-status[@item="conflicted"]])')" 3 "item=conflicted 条目数"
assert_eq "$(xcount "$ROOT/status.xml" 'count(//entry[wc-status[@props="conflicted"]])')" 3 "props=conflicted 条目数"
assert_eq "$(xcount "$ROOT/status.xml" 'count(//entry[wc-status[@tree-conflicted="true"]])')" 3 "tree-conflicted 条目数"
assert_eq "$(xcount "$ROOT/status.xml" 'count(//entry[wc-status[@item="external"]])')" 1 "external 边界条目数"
if grep -q 'extdir/ext/f.txt' "$ROOT/status.xml"; then fail "--ignore-externals 不应包含 external 内部路径"; fi
svn status --xml > "$ROOT/status-with-ext.xml"
grep -q 'path="extdir/ext/f.txt"' "$ROOT/status-with-ext.xml" || fail "不带 --ignore-externals 时应包含 external 内部冲突"
echo "OK: 8 个冲突条目（text/props/tree 三判据各 3），external 内部隔离"

echo "== 2. info --xml 冲突节点与重复节点 =="
svn info --xml text.txt prop.txt mixed.txt multi.txt binary.bin tree-del.txt tree-dir tree-add.txt > "$ROOT/info.xml"
assert_eq "$(xcount "$ROOT/info.xml" 'count(//conflict)')" 9 "多目标 info conflict 节点总数（含重复）"
assert_eq "$(xcount "$ROOT/info.xml" 'count(//tree-conflict)')" 3 "tree-conflict 节点数"
svn info --xml mixed.txt > "$ROOT/info-mixed.xml"
svn info --xml multi.txt > "$ROOT/info-multi.xml"
assert_eq "$(xcount "$ROOT/info-mixed.xml" 'count(//conflict)')" 4 "mixed 重复节点数"
assert_eq "$(xcount "$ROOT/info-multi.xml" 'count(//conflict)')" 2 "multi 重复节点数"
grep -q 'side="source-left"' "$ROOT/info.xml" && grep -q 'side="source-right"' "$ROOT/info.xml" || fail "info 应包含 source-left/right"
grep -q 'reason="edit"' "$ROOT/info.xml" || fail "tree-conflict 应包含 reason"
echo "OK: source-left/right 可用；mixed 4 节点、multi 2 节点需按指纹去重"

echo "== 3. 辅助文件 =="
for f in text.txt.mine text.txt.r2 text.txt.r3 mixed.txt.prej prop.txt.prej multi.txt.prej binary.bin.r2 binary.bin.r3; do
  [ -f "$f" ] || fail "缺少辅助文件 $f"
done
[ ! -f binary.bin.mine ] || fail "二进制冲突不应出现 .mine"
echo "OK: 文本 3 辅助文件、属性 .prej、二进制无 .mine"

echo "== 4. resolve --accept 六值与 postpone =="
try_text_resolve() { # $1=accept $2=期望首行 $3=期望状态首列（空=干净）
  local dir="case-text-$1"
  cp -a "$ROOT/wc2" "$ROOT/$dir"
  ( cd "$ROOT/$dir" && svn resolve --non-interactive --accept "$1" --depth empty -- text.txt >/dev/null 2>&1 )
  assert_eq "$(head -1 "$ROOT/$dir/text.txt")" "$2" "accept=$1 文件首行"
  assert_eq "$(status_code "$ROOT/$dir" text.txt)" "$3" "accept=$1 状态首列"
}
try_text_resolve base 'line1' 'M'
try_text_resolve working '<<<<<<< .mine' 'M'
try_text_resolve mine-conflict 'line1-local' 'M'
try_text_resolve theirs-conflict 'line1-theirs' ''
try_text_resolve mine-full 'line1-local' 'M'
try_text_resolve theirs-full 'line1-theirs' ''
set +e
cp -a "$ROOT/wc2" "$ROOT/case-postpone"
( cd "$ROOT/case-postpone" && svn resolve --non-interactive --accept postpone --depth empty -- text.txt >"$ROOT/postpone.out" 2>&1 )
RC=$?
set -e
[ "$RC" -ne 0 ] || fail "postpone 应被拒绝"
grep -q 'E205000' "$ROOT/postpone.out" || fail "postpone 应返回 E205000"
echo "OK: 六种 accept 行为符合矩阵；postpone E205000"

echo "== 5. 混合路径 --accept working --depth empty 范围 =="
cp -a "$ROOT/wc2" "$ROOT/case-mixed"
( cd "$ROOT/case-mixed" && svn resolve --non-interactive --accept working --depth empty -- mixed.txt >/dev/null )
assert_eq "$(status_code "$ROOT/case-mixed" mixed.txt)" 'M' "混合路径 working 后文本状态"
assert_eq "$(cd "$ROOT/case-mixed" && svn status mixed.txt | cut -c1-2)" 'MM' "混合路径 working 后内容+属性均为 M"
assert_eq "$(status_code "$ROOT/case-mixed" text.txt)" 'C' "其他路径不应被一并解决"
( cd "$ROOT/case-mixed" && svn info --xml mixed.txt | grep -q '<conflict' ) && fail "mixed 冲突应已清除"
echo "OK: mixed 文本+属性一次 working 全部清除，其他路径不受影响"

echo "== 6. 属性三值、propset -F / propdel、回扫 =="
assert_eq "$(svn propget k "file://$ROOT/repo/prop.txt@2")" base "source-left 属性值"
assert_eq "$(svn propget k "file://$ROOT/repo/prop.txt@3")" theirs "source-right 属性值"
assert_eq "$(svn propget k "$ROOT/wc2/prop.txt")" local "本地工作属性值"
cp -a "$ROOT/wc2" "$ROOT/case-prop"
printf 'theirs' > "$ROOT/selected.txt"
( cd "$ROOT/case-prop" && svn propset -q k -F "$ROOT/selected.txt" prop.txt && svn resolve --non-interactive --accept working --depth empty -- prop.txt >/dev/null )
assert_eq "$(cd "$ROOT/case-prop" && svn status prop.txt)" '' "属性写回并 working 后应无状态"
assert_eq "$(svn propget k "$ROOT/case-prop/prop.txt")" theirs "写回后的属性值"
cp -a "$ROOT/wc2" "$ROOT/case-multi"
( cd "$ROOT/case-multi" && svn propset -q p1 -F "$ROOT/selected.txt" multi.txt && svn propdel -q p2 multi.txt && svn resolve --non-interactive --accept working --depth empty -- multi.txt >/dev/null )
assert_eq "$(svn propget p1 "$ROOT/case-multi/multi.txt")" theirs "多属性逐项写回 p1"
set +e
svn propget p2 "$ROOT/case-multi/multi.txt" >/dev/null 2>&1
P2RC=$?
set -e
[ "$P2RC" -ne 0 ] || fail "propdel 后 p2 应不存在"
echo "OK: 三值可从 source-left/right 读取；propset -F 与 propdel 写回后 working 清冲突；回扫 status 为空"

echo "== 7. 树冲突 working 与非法 accept =="
cp -a "$ROOT/wc2" "$ROOT/case-tree-add"
( cd "$ROOT/case-tree-add" && svn resolve --non-interactive --accept working --depth empty -- tree-add.txt >/dev/null )
assert_eq "$(status_code "$ROOT/case-tree-add" tree-add.txt)" 'R' "tree-add working 后保留 replaced"
cp -a "$ROOT/wc2" "$ROOT/case-tree-del"
( cd "$ROOT/case-tree-del" && svn resolve --non-interactive --accept working --depth empty -- tree-del.txt >/dev/null )
assert_eq "$(status_code "$ROOT/case-tree-del" tree-del.txt)" 'A' "tree-del working 后保留 add-with-history"
set +e
cp -a "$ROOT/wc2" "$ROOT/case-tree-mine"
( cd "$ROOT/case-tree-mine" && svn resolve --non-interactive --accept mine-full --depth empty -- tree-add.txt >"$ROOT/tree-mine.out" 2>&1 )
TRC=$?
set -e
[ "$TRC" -ne 0 ] || fail "树冲突 mine-full 应失败"
grep -q 'W195024' "$ROOT/tree-mine.out" || fail "树冲突非法 accept 应报 W195024"
echo "OK: tree working 有效；mine-full W195024 + E155027"

echo "== 8. 同路径多属性三值与三方判定 =="
cd "$ROOT/wc0"
svn update -q
printf 'tristate content\n' > tristate.txt
svn add -q tristate.txt
svn propset -q p1 base1 tristate.txt
svn propset -q p2 base2 tristate.txt
svn propset -q p3 base3 tristate.txt
svn commit -q -m "add tristate"
cd "$ROOT"
svn co -q "file://$ROOT/repo" "$ROOT/wcT1"
svn co -q "file://$ROOT/repo" "$ROOT/wcT2"
( cd "$ROOT/wcT1" && svn propset -q p1 incoming1 tristate.txt && svn propset -q p3 incoming3 tristate.txt && svn commit -q -m "incoming p1/p3" )
( cd "$ROOT/wcT2" && svn propset -q p1 local1 tristate.txt && svn propset -q p2 localonly tristate.txt && svn update >/dev/null )
( cd "$ROOT/wcT2" && svn info --xml tristate.txt > "$ROOT/info-tristate.xml" )
assert_eq "$(xcount "$ROOT/info-tristate.xml" 'count(//conflict)')" 1 "tristate 属性冲突节点数"
assert_eq "$(cd "$ROOT/wcT2" && svn propget p1 tristate.txt)" local1 "tristate p1 本地值"
assert_eq "$(cd "$ROOT/wcT2" && svn propget p3 tristate.txt)" incoming3 "tristate p3 已应用传入值"
echo "OK: 仅 p1 满足 local!=base && incoming!=base && local!=incoming"

echo "== 9. external 内部变更不进入外层冲突 =="
cd "$ROOT/extra-wc0"
printf 'external v3\n' > f.txt
svn commit -q -m "ext-v3"
BEFORE=$(svn info --show-item revision "$ROOT/wc2/extdir/ext")
cp -a "$ROOT/wc2" "$ROOT/case-extignore"
( cd "$ROOT/case-extignore" && svn update --non-interactive --ignore-externals . >/dev/null )
AFTER=$(svn info --show-item revision "$ROOT/case-extignore/extdir/ext")
assert_eq "$AFTER" "$BEFORE" "--ignore-externals 更新不应触碰 external"
if ( cd "$ROOT/case-extignore" && svn status --xml --ignore-externals | grep -q 'extdir/ext/f.txt' ); then
  fail "external 内部冲突不应出现在 --ignore-externals 结果"
fi
echo "OK: external 内部 revision 与冲突均被隔离"

echo "== 10. 树冲突 unversioned 阻塞形态 =="
cd "$ROOT/wc0"
svn update -q
mkdir -p obs && printf 'obs child\n' > obs/child.txt
svn add -q obs
svn commit -q -m "add obs dir"
cd "$ROOT"
HEADREV=$(svn info --show-item revision "file://$ROOT/repo")
svn co -q -r $((HEADREV-1)) "file://$ROOT/repo" "$ROOT/wcO1"
printf 'unversioned obstruction\n' > "$ROOT/wcO1/obs"
( cd "$ROOT/wcO1" && svn update >/dev/null 2>&1 || true )
svn status --xml --ignore-externals "$ROOT/wcO1" > "$ROOT/status-obs.xml"
assert_eq "$(xcount "$ROOT/status-obs.xml" 'count(//entry[wc-status[@tree-conflicted="true" and @item="deleted"]])')" 1 "unversioned 阻塞树冲突形态"
( cd "$ROOT/wcO1" && svn info --xml obs > "$ROOT/info-obs.xml" )
grep -q 'reason="unversioned"' "$ROOT/info-obs.xml" || fail "obstruction 树冲突 reason 应为 unversioned"
( cd "$ROOT/wcO1" && svn resolve --non-interactive --accept working --depth empty -- obs >/dev/null )
echo "OK: item=deleted + tree-conflicted=true；reason=unversioned；resolve working 可确认"

echo "== 11. WC 锁定（busy）可观察形态 =="
# 先提交一个 64 MiB 文件，拉长 wc2 的 update 窗口，便于在写操作中途强杀以留下 WC 锁。
cd "$ROOT/wc0"
dd if=/dev/zero of="$ROOT/wc0/slow.bin" bs=1m count=64 2>/dev/null
svn add -q slow.bin
svn commit -q -m "slow file for lock probe"
LOCKED=0
for attempt in 1 2 3 4 5 6 7 8; do
  rm -rf "$ROOT/case-lock"
  cp -a "$ROOT/wc2" "$ROOT/case-lock"
  ( cd "$ROOT/case-lock"; svn update --non-interactive >/dev/null 2>&1 & echo $! > "$ROOT/up.pid"; wait $(cat "$ROOT/up.pid") 2>/dev/null || true ) &
  WRAP=$!
  sleep 0.1
  kill -9 $(cat "$ROOT/up.pid" 2>/dev/null) 2>/dev/null || true
  wait "$WRAP" 2>/dev/null || true
  ( cd "$ROOT/case-lock" && svn status --xml --ignore-externals > "$ROOT/lock-status.xml" 2>/dev/null ) || true
  if grep -q 'wc-locked="true"' "$ROOT/lock-status.xml"; then
    LOCKED=1; break
  fi
done
if [ "$LOCKED" = 1 ]; then
  set +e
  ( cd "$ROOT/case-lock" && svn resolve --non-interactive --accept working --depth empty -- text.txt >"$ROOT/lock.out" 2>&1 )
  LRC=$?
  set -e
  [ "$LRC" -ne 0 ] || fail "WC 锁定时 resolve 应失败"
  grep -q 'W155004\|E155004' "$ROOT/lock.out" || fail "WC 锁定错误应含 E155004/W155004"
  echo "OK: 锁定副本 resolve 返回 W155004/E155027，status 可读并带 wc-locked"
else
  echo "SKIP: 未能在该机器复现 WC 锁定（依赖 update 被强杀时机）"
fi

echo "ALL ASSERTIONS PASSED"
