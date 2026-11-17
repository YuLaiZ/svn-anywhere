#!/bin/sh
# 可复跑探针：本机 svnadmin + file:// 构造 blame/diff 关键形态。
# 只写调用方给出的临时目录；不访问网络、不使用凭据。
# 用法：sh test/fixtures/m4-stage0/probe-blame-diff.sh /tmp/svn-anywhere-svn-probe
set -u
BASE=${1:-/tmp/svn-anywhere-svn-probe}
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
SVN="svn --non-interactive"
rm -rf "$BASE"
mkdir -p "$BASE"
svnadmin create "$BASE/repo"
$SVN checkout "file://$BASE/repo" "$BASE/wc" >/dev/null
cd "$BASE/wc" || exit 1

for i in 01 02 03 04 05 06 07 08 09 10; do echo "line$i"; done > file.txt
printf 'line01\nline02\n' > deleted.txt
printf 'BIN\0DATA' > binary.bin
$SVN add file.txt deleted.txt binary.bin >/dev/null
$SVN propset svn:mime-type application/octet-stream binary.bin >/dev/null
$SVN commit -m r1 --username alice >/dev/null
sed -i '' 's/^line03$/line03-bob/' file.txt
$SVN commit -m r2 --username bob >/dev/null
$SVN rm deleted.txt >/dev/null
$SVN commit -m r3 --username carol >/dev/null

echo '### blame: clean WC default (line-number/commit map)'
$SVN blame --xml file.txt | grep -E 'line-number|revision=|author' | tr -d ' ' | paste - - - || true
echo '### blame: explicit -r 1:HEAD on clean WC (same map)'
$SVN blame --xml -r 1:HEAD file.txt | grep -c '<entry'
echo '### blame: local edit/new/delete then default (workfile aligned, local lines have no commit)'
sed -i '' 's/^line02$/line02-local/' file.txt
sed -i '' '/^line05$/d' file.txt
printf 'local-new\n' >> file.txt
grep -c '' file.txt
$SVN blame --xml file.txt | grep -E 'line-number|revision=' | tr -d ' ' | paste - -
echo '### blame: -r BASE with local edits (BASE aligned)'
$SVN blame --xml -r BASE file.txt | grep -c '<entry'
echo '### blame: reverse -r HEAD:1 (only old-end lines, only in-range edits have commit)'
$SVN blame --xml -r HEAD:1 file.txt | grep -E 'line-number|revision=' | tr -d ' ' | paste - -
echo '### blame: binary (empty blame + stderr warning, exit 0)'
# 注意：svn blame 的二进制跳过依赖工作副本 BASE 状态（实测未 update 的旧 BASE 可能不跳过），
# 产品不能依赖它自行拒绝，必须先按 svn:mime-type/NUL 判定。这里 update 到 HEAD 以稳定复现。
$SVN update binary.bin >/dev/null 2>&1
$SVN blame --xml binary.bin 2>&1; echo "exit=$?"
echo '### blame: deleted URL at last-existing peg, and at deleted peg'
$SVN blame --xml "file://$BASE/repo/deleted.txt@2" >/dev/null; echo "peg2 exit=$?"
$SVN blame --xml "file://$BASE/repo/deleted.txt@3" >/dev/null 2>"$BASE/del.err"; echo "peg3 exit=$?"; cat "$BASE/del.err"
echo '### diff: U0 hunk shape (edit + delete + append)'
$SVN revert -R . >/dev/null 2>&1
sed -i '' 's/^line03-bob$/line03-local/' file.txt
sed -i '' '/^line05$/d' file.txt
printf 'tail\n' >> file.txt
$SVN diff --internal-diff --ignore-properties -r BASE -x -U0 -- file.txt
echo '### diff: unversioned (E155010, exit 1, empty stdout)'
printf 'x\n' > unver.txt
$SVN diff --internal-diff --ignore-properties -r BASE -x -U0 -- unver.txt; echo "exit=$?"
echo '### diff: missing (local rm, exit 0, empty stdout/stderr)'
rm file.txt
$SVN diff --internal-diff --ignore-properties -r BASE -x -U0 -- file.txt; echo "exit=$?"
$SVN revert file.txt >/dev/null
echo '### diff: binary modified (Cannot display marker, no hunks)'
printf 'BIN\0CHANGED' > binary.bin
$SVN diff --internal-diff --ignore-properties -r BASE -x -U0 -- binary.bin; echo "exit=$?"
$SVN revert binary.bin >/dev/null
echo '### diff: external diff config only applies without --internal-diff'
# marker 脚本记录被调用；--internal-diff 时 marker 不得出现。
# 先制造一处差异（前面的 missing 场景已把 file.txt revert 回 BASE）。
sed -i '' 's/^line04$/line04-local/' file.txt
cat > "$BASE/marker-diff.sh" <<EOS
#!/bin/sh
echo called >> "$BASE/diff-called.marker"
exec diff -u "\$@"
EOS
chmod +x "$BASE/marker-diff.sh"
rm -f "$BASE/diff-called.marker"
$SVN diff --internal-diff --ignore-properties -r BASE -x -U0 --config-option=config:helpers:diff-cmd="$BASE/marker-diff.sh" -- file.txt >/dev/null 2>&1
echo "internal exit=$? marker=$(test -f "$BASE/diff-called.marker" && echo present || echo absent)"
rm -f "$BASE/diff-called.marker"
$SVN diff --ignore-properties -r BASE -x -U0 --config-option=config:helpers:diff-cmd="$BASE/marker-diff.sh" -- file.txt >/dev/null 2>&1
echo "external exit=$? marker=$(test -f "$BASE/diff-called.marker" && echo present || echo absent)"
echo '### done'
