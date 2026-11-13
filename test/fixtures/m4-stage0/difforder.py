#!/usr/bin/env python3
"""验证 svn diff --xml --summarize 的输出顺序是否稳定（跨版本/多次运行）。

用法: python3 -I difforder.py
前置：四服务端已提交 seed-data.sh 的 r5-r9。
依赖 env.sh 的端口映射；凭据用 SVN_TEST_USER/SVN_TEST_PASS。
"""
import os
import subprocess
import xml.etree.ElementTree as ET

USER = os.environ.get('SVN_TEST_USER', 'matrixtest')
PASS = os.environ.get('SVN_TEST_PASS', 'test-pass-123')
OPTS = ['--non-interactive', '--no-auth-cache', '--username', USER, '--password', PASS]
PORTS = {9061: '1.6.17', 9081: '1.8.10', 9101: '1.10.4', 9141: '1.14.5'}

for port, ver in PORTS.items():
    orders = []
    for _ in range(5):
        out = subprocess.run(
            ['svn', 'diff', '--xml', '--summarize', '-r', '5:9', *OPTS,
             f'http://127.0.0.1:{port}/svn/test'],
            capture_output=True, text=True,
        )
        root = ET.fromstring(out.stdout)
        orders.append(tuple(p.text.rsplit('/', 1)[-1] for p in root.iter('path')))
    print(f'{ver} ({port}) distinct orders: {len(set(orders))}')
    for order in set(orders):
        print('   ', order)
