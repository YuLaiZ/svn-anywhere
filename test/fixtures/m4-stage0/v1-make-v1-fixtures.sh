#!/bin/bash
# M4 阶段0 V1：本地 file:// fixture 构建脚本（可复跑）
# 用法: ./make-v1-fixtures.sh [BASE_DIR]  （默认 /tmp/m4-stage0-V1）
# 产出: repo-main（字段/mime/NUL/特殊字符/大文件/阈值文本）、repo-sizes（10k 与 100k 直属目录）
# 全部命令 --non-interactive；不访问网络；不进入项目仓库。
set -euo pipefail
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
BASE=${1:-/tmp/m4-stage0-V1}
mkdir -p "$BASE"
cd "$BASE"

if [ ! -d repo-main ]; then
  svnadmin create repo-main
  svn co -q "file://$BASE/repo-main" wc-main
  cd wc-main
  mkdir -p "普通目录" "空目录" "空格 目录" "深/子/孙"
  printf 'line1\nline2\nline3\n' > "普通文本.txt"
  printf '\x00\x01\x02binary\x00content' > binary.dat
  printf '\x00\x00hidden' > no-mime-nul.csv
  printf 'plain text but has \x00 nul' > fake-text.bin
  printf '\x89PNG\r\n\x1a\n fake png bytes' > image.png
  printf 'at content' > "at@name.txt"
  printf 'hash content' > "hash#name.txt"
  printf 'combo' > "中文 文件@#.txt"
  printf 'deep' > "深/子/孙/deep.txt"
  printf 'space name' > "空格 目录/有 空格 的文件.txt"
  node -e 'const fs=require("fs");fs.writeFileSync("utf16le.txt",Buffer.concat([Buffer.from([0xFF,0xFE]),Buffer.from("hello 中文 utf16","utf16le")]));fs.writeFileSync("latin1.txt",Buffer.from([0xe9,0xe8,0xea,0x20,0x6c,0x61,0x74,0x69,0x6e,0x31,0x0a]));const h=Buffer.alloc(8192,0x61);fs.writeFileSync("nul-after-8k.bin",Buffer.concat([h,Buffer.from([0,1,2])]));fs.writeFileSync("empty.txt",Buffer.alloc(0));fs.writeFileSync("svg-as-text.svg","<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>\n");fs.writeFileSync("text-plain-attr.txt","纯文本但带 text/plain\n");'
  svn add -q --force . >/dev/null
  svn propset -q svn:mime-type image/png image.png
  svn propset -q svn:mime-type text/plain fake-text.bin
  svn propset -q svn:mime-type application/octet-stream binary.dat
  svn propset -q svn:mime-type text/plain text-plain-attr.txt
  svn propset -q svn:mime-type image/svg+xml svg-as-text.svg
  svn ci -q -m "初始fixture:目录/文件/二进制/特殊字符" --non-interactive
  printf 'v2\n' >> "普通文本.txt"; svn ci -q -m "第二次提交:修改文本" --non-interactive
  svn propdel -q svn:mime-type no-mime-nul.csv utf16le.txt 2>/dev/null || true
  svn ci -q -m "清除自动mime以测试纯NUL探测" --non-interactive
  # 大文件与 16 MiB 阈值文本
  node -e 'const fs=require("fs"),crypto=require("crypto");const fd=fs.openSync("../big-256m.bin","w");const b=crypto.randomBytes(1024*1024);for(let i=0;i<256;i++)fs.writeSync(fd,b);fs.closeSync(fd);fs.writeFileSync("../text-15m.txt","a".repeat(15*1024*1024));fs.writeFileSync("../text-17m.txt","b".repeat(17*1024*1024));'
  cp ../big-256m.bin ../text-15m.txt ../text-17m.txt .
  svn add -q big-256m.bin text-15m.txt text-17m.txt
  svn ci -q -m "大文件与16MiB阈值fixture" --non-interactive
  cd "$BASE"
fi

if [ ! -d repo-sizes ]; then
  svnadmin create repo-sizes
  : > empty
  { echo mkdir; echo d10k; seq -f 'f%06g' 1 10000 | awk -v B="$BASE" '{print "put"; print B"/empty"; print "d10k/"$0}'; } > tokens-10k.txt
  svnmucc -m "seed 10k files" -U "file://$BASE/repo-sizes" -X tokens-10k.txt
  { echo mkdir; echo d100k; seq -f 'f%06g' 1 100000 | awk -v B="$BASE" '{print "put"; print B"/empty"; print "d100k/"$0}'; } > tokens-100k.txt
  svnmucc -m "seed 100k files" -U "file://$BASE/repo-sizes" -X tokens-100k.txt
fi
echo "fixtures ready under $BASE"
