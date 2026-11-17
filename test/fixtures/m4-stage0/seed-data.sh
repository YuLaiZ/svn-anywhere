#!/bin/bash
# 跨版本字段实验数据：在单个矩阵服务端仓库提交 r5-r9 相同内容。
# 数据覆盖：普通/中文/空格/@/# 文件名、二进制、空目录、复制、删除、属性、
# 多行提交消息、多 revision 修改（供 log/diff/blame 采集）。
# 幂等：HEAD>=9 时跳过。用法：bash seed-data.sh <svn16|svn18|svn110|svn114>
set -eu
source "$(dirname "$0")/env.sh"
n=$1; url=$(url_of "$n"); wc="$WORK_DIR/wc/seed-$n"
data="$WORK_DIR/data"
mkdir -p "$data/exp/sub" "$data/exp/empty"
printf 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n' > "$data/exp/a.txt"
printf '中文内容第一行\n第二行 with spaces\n第三行\n' > "$data/exp/中文 文件.txt"
printf 'at sign path\n' > "$data/exp/at@sign.txt"
printf 'hash path\n' > "$data/exp/hash#tag.txt"
printf 'space path\n' > "$data/exp/space name.txt"
printf 'sub b v1\n' > "$data/exp/sub/b.txt"
printf 'prop file\n' > "$data/exp/prop.txt"
printf '#!/bin/sh\necho hi\n' > "$data/exp/exec.sh"
printf '\x00\x01\x02\xff\xfe binary\x00payload\n' > "$data/exp/binary.bin"

rm -rf "$wc"
svn checkout "${SVN_OPTS[@]}" --quiet "$url" "$wc"
cd "$wc"
svn update "${SVN_OPTS[@]}" --quiet
head=$(svn info --show-item revision "${SVN_OPTS[@]}" -- "$url")
if [ "$head" -ge 9 ]; then echo "skip $n HEAD=$head"; exit 0; fi
if [ "$head" -lt 5 ]; then
  cp -R "$data/exp" ./exp
  svn add "${SVN_OPTS[@]}" --quiet exp
  svn propset svn:executable '*' exp/exec.sh >/dev/null
  svn propset test:color red exp/prop.txt >/dev/null
  svn commit "${SVN_OPTS[@]}" --quiet -m "r5: 添加跨版本实验数据（中文 空格 @ # 二进制 属性）"
fi
head=$(svn info --show-item revision "${SVN_OPTS[@]}" -- "$url")
if [ "$head" -lt 6 ]; then
  printf 'line1\nline2-changed\nline3\nline4\nline5-changed\nline6\nline7\nline8\nline9-added\n' > exp/a.txt
  svn commit "${SVN_OPTS[@]}" --quiet -m "r6: 修改 a.txt 多行内容"
fi
head=$(svn info --show-item revision "${SVN_OPTS[@]}" -- "$url")
if [ "$head" -lt 7 ]; then
  svn copy "${SVN_OPTS[@]}" --quiet exp/sub exp/subcopy
  printf 'sub b v2 after copy\n' > exp/subcopy/b.txt
  svn commit "${SVN_OPTS[@]}" --quiet -m "r7: 复制 sub 为 subcopy 并修改副本"
fi
head=$(svn info --show-item revision "${SVN_OPTS[@]}" -- "$url")
if [ "$head" -lt 8 ]; then
  svn delete "${SVN_OPTS[@]}" --quiet exp/empty
  svn propset test:color blue exp/prop.txt >/dev/null
  svn commit "${SVN_OPTS[@]}" --quiet -m "r8: 删除空目录并更新 prop.txt 属性"
fi
head=$(svn info --show-item revision "${SVN_OPTS[@]}" -- "$url")
if [ "$head" -lt 9 ]; then
  printf 'line1\nline2-changed\nline3-r9\nline4\nline5-changed\nline6\nline7\nline8\nline9-added\nline10-r9\n' > exp/a.txt
  svn commit "${SVN_OPTS[@]}" --quiet -m $'r9: 再改 a.txt\n第二行提交说明（多行）'
fi
echo "seeded $n HEAD=$(svn info --show-item revision "${SVN_OPTS[@]}" -- "$url")"
