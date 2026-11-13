#!/usr/bin/env python3
"""提取 svn --xml 输出的元素/属性形状（版本字段差异表素材）。

用法: python3 -I xmlshape.py <file.xml>
输出每个元素路径与排序后的属性名，用于跨版本对比字段是否缺失。
"""
import sys
import xml.etree.ElementTree as ET


def shape(path):
    try:
        tree = ET.parse(path)
    except Exception as e:  # noqa: BLE001 - 实验脚本，打印即可
        print(f"  <parse error: {e}>")
        return None
    out = set()

    def walk(el, prefix):
        tag = el.tag.split('}')[-1]
        here = f"{prefix}/{tag}"
        attrs = sorted(el.attrib.keys())
        out.add(here + (f"[@{','.join(attrs)}]" if attrs else ""))
        for ch in el:
            walk(ch, here)

    root = tree.getroot().tag.split('}')[-1]
    for child in tree.getroot():
        walk(child, root)
    return out


if __name__ == '__main__':
    result = shape(sys.argv[1])
    if result:
        for line in sorted(result):
            print(line)
