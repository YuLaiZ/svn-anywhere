#!/bin/bash
# V6-2 跨客户端工作副本：SVN 1.14.5 客户端（Alpine 容器）创建混合 revision WC，
# 由宿主机 SVN 1.15 客户端执行 status/info/log/relocate/update/resolve，
# 再回到 1.14 客户端读回。目标仓库用 svn110（1.10.4 服务端），避免污染 V6-1 的 svn114 数据。
#
# 用法：
#   bash wc-cross-version.sh prepare   # 1.14 checkout r5 + update 到混合 revision，输出 revision 表
#   bash wc-cross-version.sh commit    # 1.14 客户端提交 r10（修改 exp/sub/b.txt）
#   bash wc-cross-version.sh host-ops  # 1.15 status/info/log/relocate/update + 冲突与 resolve
#   bash wc-cross-version.sh readback  # 1.14 客户端读回 1.15 操作后的 WC
#
# 前置：矩阵容器 svn114 镜像可用；svn110 已提交 seed-data.sh 的 r5-r9。
# WC 落在 $WORK_DIR/wc/wc14（容器内挂载为 /work/wc14）。
set -eu
source "$(dirname "$0")/env-v6.sh"
STEP=${1:-}
WC_HOST="$WORK_DIR/wc/wc14"
# 容器访问宿主映射端口；宿主无法解析 host.docker.internal，因此 relocate 必需。
URL_CONTAINER="http://host.docker.internal:9101/svn/test"
URL_HOST=$(url_of svn110)
IMG=svn-matrix:v1.14

run14() { # run14 <script-path>；以宿主 UID/GID 运行 1.14 客户端容器
  docker run --rm -u "$(id -u):$(id -g)" --entrypoint /bin/sh \
    -v "$WORK_DIR/wc:/work" -v "$1:$1:ro" "$IMG" "$1"
}

case "$STEP" in
  prepare)
    cat > "$WORK_DIR/wc14-prepare.sh" <<'EOS'
#!/bin/sh
set -e
OPTS="--non-interactive --no-auth-cache --username matrixtest --password test-pass-123"
URL=http://host.docker.internal:9101/svn/test
svn --version --quiet
svn checkout $OPTS -r 5 "$URL" /work/wc14 2>&1 | tail -3
svn update $OPTS -r 9 /work/wc14/exp 2>&1
svn update $OPTS -r 6 /work/wc14/exp/a.txt 2>&1
for p in /work/wc14 /work/wc14/trunk /work/wc14/exp /work/wc14/exp/a.txt /work/wc14/exp/sub /work/wc14/exp/sub/b.txt; do
  printf '%s rev=%s\n' "$p" "$(svn info --show-item revision $OPTS "$p")"
done
EOS
    run14 "$WORK_DIR/wc14-prepare.sh"
    ;;
  commit)
    cat > "$WORK_DIR/wc14-commit.sh" <<'EOS'
#!/bin/sh
set -e
OPTS="--non-interactive --no-auth-cache --username matrixtest --password test-pass-123"
printf 'sub b v3 from svn 1.14 client\n' > /work/wc14/exp/sub/b.txt
svn commit $OPTS -m "r10: 由 SVN 1.14 客户端提交" /work/wc14/exp/sub/b.txt 2>&1
for p in /work/wc14 /work/wc14/exp /work/wc14/exp/sub /work/wc14/exp/sub/b.txt; do
  printf '%s rev=%s\n' "$p" "$(svn info --show-item revision $OPTS "$p")"
done
EOS
    run14 "$WORK_DIR/wc14-commit.sh"
    ;;
  host-ops)
    svn status --xml "${SVN_OPTS[@]}" "$WC_HOST" > "$WORK_DIR/raw/wc15-status-pre.out" 2>&1 || true
    svn info --xml "${SVN_OPTS[@]}" "$WC_HOST/exp/a.txt" > "$WORK_DIR/raw/wc15-info-pre.out" 2>&1 || true
    # WC 记录的 URL 是容器地址，宿主不可达：先记录失败，再 relocate 到宿主地址。
    svn log --xml -l 3 "${SVN_OPTS[@]}" "$WC_HOST" > "$WORK_DIR/raw/wc15-log-wcurl.out" 2> "$WORK_DIR/raw/wc15-log-wcurl.err" || true
    svn log --xml -l 3 "${SVN_OPTS[@]}" "$URL_HOST" > "$WORK_DIR/raw/wc15-log-remote.out" 2>&1 || true
    svn relocate "${SVN_OPTS[@]}" "$URL_HOST" "$WC_HOST" 2>&1
    svn update "${SVN_OPTS[@]}" "$WC_HOST" 2>&1
    for p in . trunk exp exp/a.txt exp/sub exp/sub/b.txt; do
      printf '%s rev=%s\n' "$p" "$(svn info --show-item revision "${SVN_OPTS[@]}" -- "$WC_HOST/$p")"
    done
    sqlite3 "$WC_HOST/.svn/wc.db" 'pragma user_version;'
    # 冲突：服务端先提交一次 a.txt（独立 seed WC），本地修改后单文件 update。
    S="$WORK_DIR/wc/seed-svn110"
    printf 'line1\nline2-server-r11\nline3-r9\nline4\nline5-changed\nline6\nline7\nline8\nline9-added\nline10-r9\n' > "$S/exp/a.txt"
    svn commit "${SVN_OPTS[@]}" -m "r11: 服务端修改 a.txt 第2行" "$S/exp/a.txt" 2>&1
    svn update "${SVN_OPTS[@]}" -r 6 "$WC_HOST/exp/a.txt" 2>&1
    printf 'line1\nline2-local-edit\nline3-r9\nline4\nline5-changed\nline6\nline7\nline8\nline9-added\nline10-r9\n' > "$WC_HOST/exp/a.txt"
    svn status --xml "${SVN_OPTS[@]}" "$WC_HOST" > "$WORK_DIR/raw/wc15-status-mixed.out" 2>&1 || true
    svn update "${SVN_OPTS[@]}" "$WC_HOST/exp/a.txt" 2>&1 || true
    svn status --xml "${SVN_OPTS[@]}" "$WC_HOST" > "$WORK_DIR/raw/wc15-status-conflict.out" 2>&1 || true
    svn resolve --accept working "${SVN_OPTS[@]}" "$WC_HOST/exp/a.txt" 2>&1
    svn status --xml "${SVN_OPTS[@]}" "$WC_HOST" > "$WORK_DIR/raw/wc15-status-resolved.out" 2>&1 || true
    sqlite3 "$WC_HOST/.svn/wc.db" 'pragma user_version;'
    ;;
  readback)
    cat > "$WORK_DIR/wc14-readback.sh" <<'EOS'
#!/bin/sh
OPTS="--non-interactive --no-auth-cache"
svn info --xml $OPTS /work/wc14/exp/a.txt 2>&1 | head -40
svn status --xml $OPTS /work/wc14 2>&1 | head -25
svn info --show-item revision $OPTS -- /work/wc14
EOS
    run14 "$WORK_DIR/wc14-readback.sh"
    ;;
  *)
    echo "usage: $0 {prepare|commit|host-ops|readback}" >&2
    exit 2
    ;;
esac
