#!/bin/bash
# M4 阶段 0 / V3 可复跑 fixture：快照比较与差异资源。
# 本机 svnadmin + file:// 只读实验，不访问真实服务器。统一产品同源 locale。
# 用法：M4_STAGE0_ROOT=/tmp/m4-stage0-V3 ./fixture.sh
set -euo pipefail
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
ROOT=${M4_STAGE0_ROOT:-/tmp/m4-stage0-V3}
BASE=$ROOT/fixture01
REPO=$BASE/repo
URL="file://$REPO"
WC=$BASE/wc
mkdir -p "$BASE" "$ROOT/logs"
exec > >(tee "$ROOT/logs/v3-fixture.log") 2>&1
echo "== V3 fixture 构造 $(date -u +%FT%TZ) =="

# ---------- r1：基础树（文本/二进制/属性/空目录/空格路径/符号链接） ----------
svnadmin create "$REPO"
svn checkout -q --non-interactive "$URL" "$WC"
cd "$WC"
mkdir -p trunk/dirA/sub trunk/empty-dir branches
printf 'line1\nline2\nline3\n' > trunk/text.txt
printf 'same-content\n' > trunk/content-only.txt
printf 'props\n' > trunk/props-only.txt
printf 'cp v1\n' > trunk/content-props.txt
printf 'meta\n' > trunk/meta.txt
printf 'BIN\x00\x01\x02\x03\xff\xfe' > trunk/bin.dat
dd if=/dev/zero bs=1024 count=1 2>/dev/null | tr '\0' '\001' >> trunk/bin.dat
printf 'delete me\n' > trunk/deleted.txt
printf 'life v1\n' > trunk/lifecycle.txt
printf 'f1 v1\n' > trunk/dirA/f1.txt
printf 'f2 v1\n' > trunk/dirA/f2.txt
printf 'g v1\n' > trunk/dirA/sub/g.txt
printf 'keep\n' > trunk/dirA/keep.txt
printf 'spaced\n' > "trunk/spaced name.txt"
ln -s text.txt trunk/link.txt
svn add -q --parents trunk/dirA trunk/empty-dir branches \
  trunk/text.txt trunk/content-only.txt trunk/props-only.txt trunk/content-props.txt \
  trunk/meta.txt trunk/bin.dat trunk/deleted.txt trunk/lifecycle.txt \
  "trunk/spaced name.txt" trunk/link.txt
svn propset -q svn:mime-type application/octet-stream trunk/bin.dat
svn commit -q -m 'r1: base tree'

# ---------- r2：修改/新增/删除/属性/二进制/空目录 ----------
printf 'line1\nline2 changed\nline3\n' > trunk/text.txt
printf 'added\n' > trunk/added.txt
svn add -q trunk/added.txt
svn delete -q trunk/deleted.txt
svn propset -q custom:flag 1 trunk/props-only.txt
printf 'cp v2\n' > trunk/content-props.txt
svn propset -q custom:flag 1 trunk/content-props.txt
printf 'BIN2\x00\x04\x05\x06\xff\xfd' > trunk/bin.dat
dd if=/dev/zero bs=2048 count=1 2>/dev/null | tr '\0' '\002' >> trunk/bin.dat
printf 'f1 v2\n' > trunk/dirA/f1.txt
printf 'new\n' > trunk/dirA/new.txt
svn add -q trunk/dirA/new.txt
svn delete -q trunk/dirA/sub/g.txt
svn mkdir -q trunk/new-empty-dir
svn commit -q -m 'r2: modify/add/delete/props/binary/empty-dir'

# ---------- r3：单提交复制目录/文件 + 删除目录/文件（svnmucc） ----------
svnmucc -U "$URL" -m 'r3: copy dirA->branches/dirA2, copy text.txt->branches/text-copy.txt, rm dirA/sub, rm lifecycle.txt' \
  cp 2 trunk/dirA branches/dirA2 \
  cp 2 trunk/text.txt branches/text-copy.txt \
  rm trunk/dirA/sub \
  rm trunk/lifecycle.txt

# ---------- r4/r5：恢复并再次删除 lifecycle.txt（复制历史 + 删除链） ----------
svnmucc -U "$URL" -m 'r4: restore lifecycle.txt from branches/text-copy.txt@3' \
  cp 3 branches/text-copy.txt trunk/lifecycle.txt
svnmucc -U "$URL" -m 'r5: delete lifecycle.txt again' \
  rm trunk/lifecycle.txt

# ---------- r6：复制 dirA2 -> dirA3 并删除 dirA2；r7：修改 dirA3 ----------
svnmucc -U "$URL" -m 'r6: cp branches/dirA2 -> trunk/dirA3, rm branches/dirA2' \
  cp 5 branches/dirA2 trunk/dirA3 \
  rm branches/dirA2
svn update -q "$WC"
printf 'f1 v3\n' > trunk/dirA3/f1.txt
svn commit -q -m 'r7: modify dirA3/f1.txt'

# ---------- r8：空格路径修改 ----------
printf 'spaced v2\n' > "trunk/spaced name.txt"
svn commit -q -m 'r8: modify spaced name.txt'

# ---------- r9：svnmucc put 相同内容（相同内容不同元数据） ----------
printf 'meta\n' > "$ROOT/metadata-same.txt"
svnmucc -U "$URL" -m 'r9: svnmucc put meta.txt with identical content' put "$ROOT/metadata-same.txt" trunk/meta.txt

# ---------- r14：目录属性变化 ----------
svnmucc -U "$URL" -m 'r14: propset custom:dironly on trunk/dirA' propset custom:dironly 1 trunk/dirA

# ---------- r15：同路径节点类型变化（file<->dir replace） ----------
printf 'z' > "$ROOT/tiny"
svnmucc -U "$URL" -m 'r15: replace trunk/meta.txt file->dir; replace trunk/empty-dir dir->file' \
  rm trunk/meta.txt \
  mkdir trunk/meta.txt \
  rm trunk/empty-dir \
  put "$ROOT/tiny" trunk/empty-dir

echo "-- 最终 log:"
svn log -v --non-interactive "$URL"
echo "== V3 fixture 完成 $(date -u +%FT%TZ) =="
