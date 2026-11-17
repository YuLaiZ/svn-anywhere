#!/bin/bash
# 可复跑大目录 fixture：50k 条目（短名）与 >64MiB XML（深长路径）。
# 大目录只落在实验根（默认 /tmp/svn-anywhere-stream-host/large），不进入仓库。
# 用法：FIXTURE_ROOT=/tmp/svn-anywhere-stream-host ./large-fixture.sh
set -euo pipefail
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
ROOT=${FIXTURE_ROOT:-/tmp/svn-anywhere-stream-host}
export FIXTURE_ROOT="$ROOT"
URL="file://$ROOT/fixture01/repo"
TREE=$ROOT/large/tree
mkdir -p "$ROOT/logs"
exec > >(tee "$ROOT/logs/stream-large-fixture.log") 2>&1
echo "== 大目录构造 $(date -u +%FT%TZ) =="
rm -rf "$TREE"
mkdir -p "$TREE/large/empty" "$TREE/large/dir50k"

python3 -I - <<'PY'
import os
root = os.environ.get('FIXTURE_LARGE_DIR') or (os.environ.get('FIXTURE_ROOT') or '/tmp/svn-anywhere-stream-host') + '/large/tree'
root = root + '/large/dir50k'
for i in range(50000):
    with open(os.path.join(root, f'f{i:05d}.txt'), 'wb') as f:
        f.write(b'x')
print('dir50k files:', 50000)
PY

echo "-- import large/empty + large/dir50k（约 2 分钟）..."
time svn import -q --non-interactive -m 'large/empty + large/dir50k (50k files)' "$TREE/large" "$URL/large"

python3 -I - <<'PY'
import os
root = (os.environ.get('FIXTURE_ROOT') or '/tmp/svn-anywhere-stream-host') + '/large/tree/large/dir64m'
seg = 'd' * 200
fname = 'f' * 200 + '.txt'
for a in range(20):
    for b in range(20):
        for c in range(20):
            d = os.path.join(root, f'{seg}{a:02d}', f'{seg}{b:02d}', f'{seg}{c:02d}')
            os.makedirs(d, exist_ok=True)
            for n in range(8):
                with open(os.path.join(d, f'{fname}{n}'), 'wb') as f:
                    f.write(b'y')
print('dir64m files: 64000, dirs: 8421')
PY
echo "-- import dir64m（约 3 分钟）..."
time svn import -q --non-interactive -m 'large/dir64m (deep paths, >64MiB XML)' "$TREE/large/dir64m" "$URL/large/dir64m"
svn info --non-interactive "$URL" | grep -E 'Revision|Last Changed Rev'
echo "== 完成 $(date -u +%FT%TZ) =="
