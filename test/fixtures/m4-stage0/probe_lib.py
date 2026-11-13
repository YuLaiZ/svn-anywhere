#!/usr/bin/env python3
"""M4 阶段 0 / V2 历史与复制实验的 XML 解析辅助。

只用于实验证据统计，不是产品代码。用法见 probe-history.sh。
"""
import re
import sys


def parse(path):
    """解析 svn log --xml 输出为 [(revision, author, msg, [(action, path, copyfrom_path, copyfrom_rev)])]。"""
    xml = open(path, encoding="utf-8").read()
    if "<logentry" not in xml:
        return []
    out = []
    for m in re.finditer(r'<logentry\s+revision="(\d+)">(.*?)</logentry>', xml, re.S):
        rev = int(m.group(1))
        body = m.group(2)
        author = _text(body, "author")
        msg = _text(body, "msg")
        paths = []
        for pm in re.finditer(r"<path([^>]*)>([^<]+)</path>", body):
            attrs = pm.group(1)
            p = pm.group(2).strip()
            action = _attr(attrs, "action") or "?"
            cf = _attr(attrs, "copyfrom-path")
            cfr = _attr(attrs, "copyfrom-rev")
            paths.append((action, p, cf, cfr))
        out.append((rev, author, msg, paths))
    return out


def _attr(attrs, name):
    m = re.search(r'%s="([^"]*)"' % name, attrs)
    return m.group(1) if m else None


def _text(body, tag):
    m = re.search(r"<%s>(.*?)</%s>" % (tag, tag), body, re.S)
    return m.group(1) if m else ""


def relevant(path, action, target, kind):
    """ancestor-filter 路径命中规则（与实施计划 V2-2/技术方案 4.1 对应）：
    - 路径等于目标：命中；
    - 路径是目标的祖先目录且 action 为 A/R/D（结构变更）：命中；
    - 目录目标：任意后代路径变更命中；
    - 其他（兄弟/无关路径）：不命中。
    """
    if path == target:
        return True
    if target.startswith(path.rstrip("/") + "/"):
        return action in ("A", "R", "D")
    if kind == "dir" and path.startswith(target.rstrip("/") + "/"):
        return True
    return False


def relevant_strict(path, action, target, kind, copyfrom_path):
    """严格版命中规则：用于 notFound 判定，避免把「祖先目录首次创建（A 无 copyfrom、
    同 revision 未添加目标路径）」误当成目标历史。
    - 目标路径自身的任何记录：命中；
    - 祖先目录 D：命中（目标被删除）；
    - 祖先目录 A/R 带 copyfrom：命中（复制映射可能带入目标，待解析来源确认）；
    - 祖先目录 A/R 无 copyfrom：仅当同 revision 存在目标路径自身记录时命中（由第一条覆盖）；
    - 目录目标的后代路径：命中。
    """
    if path == target:
        return True
    if target.startswith(path.rstrip("/") + "/"):
        if action == "D":
            return True
        if action in ("A", "R") and copyfrom_path:
            return True
        return False
    if kind == "dir" and path.startswith(target.rstrip("/") + "/"):
        return True
    return False


def matching_revisions(path, target, kind, strict=False):
    rows = parse(path)
    hits = []
    for rev, author, msg, paths in rows:
        hit = False
        for a, p, cf, _ in paths:
            if strict:
                hit = hit or relevant_strict(p, a, target, kind, cf)
            else:
                hit = hit or relevant(p, a, target, kind)
        if hit:
            hits.append(rev)
    return [r[0] for r in rows], hits


def main():
    cmd = sys.argv[1]
    if cmd == "revs":
        # revs FILE -> 逗号分隔 revision（降序原样）
        print(",".join(str(r[0]) for r in parse(sys.argv[2])))
    elif cmd == "count":
        print(len(parse(sys.argv[2])))
    elif cmd == "match":
        # match FILE TARGET file|dir [strict] -> REVS=<all>;HITS=<hits>
        strict = len(sys.argv) > 5 and sys.argv[5] == "strict"
        allrevs, hits = matching_revisions(sys.argv[2], sys.argv[3], sys.argv[4], strict)
        print("REVS=%s;HITS=%s" % (",".join(str(r) for r in allrevs), ",".join(str(r) for r in hits)))
    elif cmd == "authors":
        rows = parse(sys.argv[2])
        print(",".join(sorted({r[1] for r in rows})))
    else:
        sys.exit("unknown command %s" % cmd)


if __name__ == "__main__":
    main()
