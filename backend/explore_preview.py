"""探索画布 · 时间线存档的线框预览（128px 缩略图）

为什么不是位图：服务端没有 tldraw 渲染器，客户端每次自动存档再去截图会把交互拖慢，
而存档是服务端按 30 分钟节流写的，客户端根本不知道哪一次落了盘。这里改成抽几何：
把形状的位置/尺寸/颜色/笔迹点压成几百字节的 JSON，抽屉里用 SVG 现画，128px 下和截图看不出差别。

体积口径：单份预览封顶 6000 字符（约 48 个形状、每条笔迹最多 24 个点），
每页时间线环形保留 12 份，一页最多多出几十 KB，换掉"只有时间+KB 看不懂"的问题。
"""
import base64
import json
import math
import struct

MAX_SHAPES = 48
MAX_STROKE_POINTS = 24
MAX_CHARS = 6000

# tldraw 颜色名 → 调色板下标（前端 PALETTE 同序）
_COLORS = {
    "black": 0, "dark": 1, "grey": 2, "light-blue": 3, "blue": 4, "light-green": 5,
    "green": 6, "light-red": 7, "red": 8, "orange": 9, "yellow": 10, "light-violet": 11,
    "violet": 12, "plum": 13, "light-gray": 2, "white": 14,
}
# 形状类别 → 下标：0 矩形 1 椭圆 2 便笺 3 纯文本 4 图片 5 提问卡 6 连线/箭头
_KIND = {
    "geo": 0, "note": 2, "text": 3, "image": 4, "video": 4, "bookmark": 4,
    "ask-card": 5, "arrow": 6, "line": 6, "frame": 0,
}
_ELLIPSE = {"ellipse", "circle", "oval"}


def _num(v, default=0.0):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if math.isfinite(f) else default


def _decode_path(b64):
    """tldraw 笔迹段 → 点列。格式见 @tldraw/tlschema 的 b64Vecs.decodePoints：
    首点 = 3 个 float32（x,y,z，绝对坐标），之后每点 = 3 个 float16（相对上一点的增量）。
    """
    if not isinstance(b64, str) or not b64:
        return []
    try:
        raw = base64.b64decode(b64, validate=False)
    except Exception:  # noqa: BLE001 - 预览解析失败不能影响存档
        return []
    if len(raw) < 12:
        return []
    try:
        x, y, _z = struct.unpack("<3f", raw[:12])
    except struct.error:
        return []
    if not (math.isfinite(x) and math.isfinite(y)):
        return []
    pts = [(x, y)]
    for off in range(12, len(raw) - 5, 6):
        try:
            dx, dy, _dz = struct.unpack("<3e", raw[off:off + 6])
        except struct.error:
            break
        if not (math.isfinite(dx) and math.isfinite(dy)):
            break
        x += dx
        y += dy
        pts.append((x, y))
    return pts


def _records(snapshot):
    try:
        data = json.loads(snapshot)
    except Exception:  # noqa: BLE001
        return []
    if not isinstance(data, dict):
        return []
    store = None
    for key in ("document", "store"):
        node = data.get(key)
        if isinstance(node, dict) and isinstance(node.get("store"), (dict, list)):
            store = node["store"]
            break
        if isinstance(node, (dict, list)):
            store = node
            break
    if store is None:
        return []
    recs = list(store.values()) if isinstance(store, dict) else list(store)
    return [r for r in recs if isinstance(r, dict)]


def _boxes(recs):
    """把每个形状变成一条预览图元：矩形类给包围盒，笔迹/连线给折线。"""
    items = []
    for r in recs:
        if r.get("typeName") != "shape":
            continue
        st = str(r.get("type") or "")
        props = r.get("props") if isinstance(r.get("props"), dict) else {}
        x, y = _num(r.get("x")), _num(r.get("y"))
        color = _COLORS.get(str(props.get("color") or ""), 0)

        if st == "draw":
            pts = []
            for seg in props.get("segments") or []:
                if isinstance(seg, dict):
                    pts.extend(_decode_path(seg.get("path")))
            if not pts:
                pts = [(p.get("x"), p.get("y")) for p in props.get("points") or []
                       if isinstance(p, dict)]
            if not pts:
                continue
            step = max(1, int(math.ceil(len(pts) / MAX_STROKE_POINTS)))
            line = [(x + px, y + py) for px, py in pts[::step]]
            items.append(("d", line, color))
            continue

        if st in ("arrow", "line"):
            # 连线：取首尾两个端点就够认出方向
            pts = [(x + _num(p.get("x")), y + _num(p.get("y"))) for p in props.get("points") or []
                   if isinstance(p, dict)]
            if len(pts) >= 2:
                items.append(("d", [pts[0], pts[-1]], color))
            continue

        w = _num(props.get("w"))
        h = _num(props.get("h"))
        if not w:
            txt = str(props.get("text") or "")
            w = min(320.0, max(40.0, len(txt) * 14.0))
        if not h:
            h = max(24.0, w * 0.35)
        kind = _KIND.get(st, 0)
        if st == "geo" and str(props.get("geo") or "").lower() in _ELLIPSE:
            kind = 1
        items.append(("r", x, y, w, h, kind, color))

    return items


def build_preview(snapshot):
    """快照 JSON → 预览 JSON 字符串；空页或解析失败返回 ""（前端显示占位）。"""
    if not snapshot:
        return ""
    items = _boxes(_records(snapshot))
    if not items:
        return ""

    xs, ys = [], []
    for it in items:
        if it[0] == "d":
            xs.extend(p[0] for p in it[1])
            ys.extend(p[1] for p in it[1])
        else:
            xs.extend([it[1], it[1] + it[3]])
            ys.extend([it[2], it[2] + it[4]])
    if not xs:
        return ""
    min_x, min_y = min(xs), min(ys)
    width = max(1.0, max(xs) - min_x)
    height = max(1.0, max(ys) - min_y)

    out = []
    for it in items[:MAX_SHAPES]:
        if it[0] == "d":
            pts = it[1][:MAX_STROKE_POINTS]
            line = [v for px, py in pts for v in (int(round(px - min_x)), int(round(py - min_y)))]
            out.append(["d", line, it[2]])
        else:
            _, x, y, w, h, kind, color = it
            out.append(["r", int(round(x - min_x)), int(round(y - min_y)),
                        int(round(w)), int(round(h)), kind, color])

    text = json.dumps({"b": [int(round(width)), int(round(height))], "s": out},
                      separators=(",", ":"), ensure_ascii=False)
    while len(text) > MAX_CHARS and len(out) > 4:
        out = out[:max(4, len(out) // 2)]
        text = json.dumps({"b": [int(round(width)), int(round(height))], "s": out},
                          separators=(",", ":"), ensure_ascii=False)
    return text if len(text) <= MAX_CHARS else ""
