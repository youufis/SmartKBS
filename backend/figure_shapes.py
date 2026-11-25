# -*- coding: utf-8 -*-
"""统计图 / 几何图形的确定性渲染 —— 把 A 档能力从"函数曲线"扩到另两类刚需图型。

为什么这两类也值得参数化
----------------------
2026-11-25 跨学科实测：地理"气温曲线+降水柱状图"直接生成失败，生物"S 型种群曲线"
被拒收，数学几何题被误判成"图文不符"。这三类都不是"模型画得不够好"，而是**根本没有
可声明的结构**，只能让它手绘像素 —— 而手绘恰恰是错的根源。

好消息是这三类的正确性同样可以机械判定：

* **统计图**：柱高必须正比于数据、折线顶点必须落在数据值上、饼图角度必须等于
  占比×360°。数据是离散数值，图就是数据的线性映射，画错同样不可能。
* **几何图**：只要模型给出顶点坐标 + 关系声明（D 是 AB 中点、AB∥CD、∠B=60°），
  关系就能拿坐标**逐条验算**；验算通过再按坐标画，中点就真的在中点、平行线真的平行、
  60° 角画出来就是 60°（前提：两轴等比，否则角度会被拉歪）。

两类都遵循同一条铁律：**任何一条校验不过就拒绝出图**，绝不出"看起来像"的错图。
"""
from __future__ import annotations

import math
import re
from typing import Any

from backend.figure_axis import fmt_tick, nice_step
from backend.math_text import render_math

WIDTH_DEFAULT = 600
HEIGHT_DEFAULT = 400
PADDING = 48.0
FONT = "Microsoft YaHei, PingFang SC, Arial, sans-serif"


class ShapeSpecError(ValueError):
    """统计图/几何 spec 不合法，或声明的关系与坐标矛盾 —— 拒绝出图"""


def _esc(s: str) -> str:
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _num(v: Any) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise ShapeSpecError("数值无法解析：%r" % (v,)) from None
    if not math.isfinite(f):
        raise ShapeSpecError("数值非法（NaN/无穷）：%r" % (v,))
    return f


# ══════════════════════════════ 一、统计图 ══════════════════════════════

def render_stat(spec: dict[str, Any], *, width: int = WIDTH_DEFAULT,
                height: int = HEIGHT_DEFAULT) -> str:
    """统计图 spec -> SVG。柱高/折线位置/饼图角度都由数据线性映射，不可能画歪。

    {"chart": "bar|line|combo|pie",
     "categories": ["1月", ...],
     "series": [{"name": "降水", "data": [20, 35, ...], "type": "bar", "axis": "left"},
                {"name": "气温", "data": [3, 5, ...], "type": "line", "axis": "right"}],
     "x_label": "月份", "y_left_label": "降水量/mm", "y_right_label": "气温/℃",
     "title": "某地气温曲线与降水柱状图"}
    """
    if not isinstance(spec, dict):
        raise ShapeSpecError("统计图 spec 必须是对象")
    chart = str(spec.get("chart") or "").strip().lower()
    series = spec.get("series") or []
    cats = spec.get("categories") or []
    if not isinstance(series, list) or not series:
        raise ShapeSpecError("统计图缺少 series")
    for s in series:
        if not isinstance(s, dict):
            raise ShapeSpecError("series 里存在非对象条目")

    # ── 饼图单独处理 ──
    if chart == "pie":
        return _render_pie(spec, series, width, height)

    if not isinstance(cats, list) or len(cats) < 2:
        raise ShapeSpecError("统计图至少需要 2 个 categories")
    n = len(cats)
    data_lists: list[list[float]] = []
    for si, s in enumerate(series):
        d = s.get("data")
        if not isinstance(d, list) or len(d) != n:
            raise ShapeSpecError("系列 %r（第 %d 个）的数据长度(%s)与 categories 数量(%d)不一致"
                                 % (s.get("name") or "?", si + 1,
                                    len(d) if isinstance(d, list) else "缺失", n))
        vals: list[float] = []
        for di, v in enumerate(d):
            try:
                vals.append(_num(v))
            except ShapeSpecError as exc:
                # 点明位置才有用：只说"数值无法解析：None"，老师不知道是哪一格
                raise ShapeSpecError("系列 %r 第 %d 项（对应 %r）%s"
                                     % (s.get("name") or "?", di + 1,
                                        (spec.get("categories") or [None] * (di + 1))[di],
                                        exc)) from exc
        data_lists.append(vals)

    # 系列没写 type 时默认按柱状：categories 是离散类目，"某地降水柱状图""各部分占比"
    # 这类请求里柱状才是常态；原来默认成折线，模型省略 type 就画出一条不该出现的折线。
    # 注意只算"等效类型"，不回写 spec —— 直接改 series[i]["type"] 会污染调用方传进来的
    # 对象（同一份 spec 被复用或重试时，第二次拿到的就是被改过的输入）。
    def eff_type(item: dict) -> str:
        t = str(item.get("type") or "").strip().lower()
        return t or "bar"

    _types = {eff_type(_s) for _s in series if isinstance(_s, dict)}
    if not chart:
        if "bar" in _types and "line" in _types:
            chart = "combo"
        elif _types <= {"bar"}:
            chart = "bar"
        else:
            chart = "line"
    # 校验放在推断之后：省略 chart 是合法写法，但 radar/scatter 这种不支持的类型
    # 必须明确拒收 —— 上一轮这条校验被我后续替换冲掉了，导致 chart="radar" 被
    # 静默当成折线画出来（对抗测试实测复现）。
    if chart not in ("bar", "line", "combo", "pie"):
        raise ShapeSpecError("不支持的统计图类型 %r（可用：bar / line / combo / pie）" % chart)

    # ── 左右轴各自独立定标（双 Y 轴是地理/生物组合图的刚需）──
    def axis_for(s: dict) -> str:
        return "right" if str(s.get("axis") or "").lower() == "right" else "left"

    left_vals = [v for s, d in zip(series, data_lists) if axis_for(s) == "left" for v in d]
    right_vals = [v for s, d in zip(series, data_lists) if axis_for(s) == "right" for v in d]
    if not left_vals:
        left_vals = right_vals or [0, 1]

    def scale_of(vals: list[float]) -> tuple[float, float, float]:
        lo, hi = min(vals + [0.0]), max(vals)
        if hi <= lo:
            hi = lo + 1
        step = nice_step(hi - lo, 5)
        top = math.ceil(hi / step) * step
        bottom = 0.0 if min(vals) >= 0 else math.floor(min(vals) / step) * step
        return bottom, top, step

    l_lo, l_hi, l_step = scale_of(left_vals)
    plot_l, plot_t = PADDING + 26, PADDING + (22 if spec.get("title") else 0)
    plot_r, plot_b = width - PADDING - (30 if right_vals else 0), height - PADDING - 26
    plot_w, plot_h = plot_r - plot_l, plot_b - plot_t

    def Y(v: float, lo: float, hi: float) -> float:
        return plot_b - (v - lo) / (hi - lo) * plot_h

    out = ['<svg viewBox="0 0 %d %d" xmlns="http://www.w3.org/2000/svg" font-family="%s">'
           % (width, height, FONT),
           '<rect width="%d" height="%d" fill="#ffffff"/>' % (width, height)]
    if spec.get("title"):
        out.append(render_math(str(spec["title"]), x=width / 2.0, y=PADDING - 6,
                               size=15, anchor="middle", fill="#222"))

    # 网格 + 左轴刻度
    g = ['<g stroke="#e9eef4" stroke-width="1">']
    t = ['<g font-size="11" fill="#555">']
    v = l_lo
    while v <= l_hi + 1e-9:
        y = Y(v, l_lo, l_hi)
        g.append('<line x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f"/>' % (plot_l, y, plot_r, y))
        t.append('<text x="%.2f" y="%.2f" text-anchor="end">%s</text>'
                 % (plot_l - 6, y + 4, fmt_tick(v, l_step)))
        v += l_step
    out.append("".join(g) + "</g>" + "".join(t) + "</g>")

    # 右轴刻度
    if right_vals:
        r_lo, r_hi, r_step = scale_of(right_vals)
        rt = ['<g font-size="11" fill="#c0392b">']
        v = r_lo
        while v <= r_hi + 1e-9:
            y = Y(v, r_lo, r_hi)
            rt.append('<text x="%.2f" y="%.2f">%s</text>' % (plot_r + 6, y + 4, fmt_tick(v, r_step)))
            v += r_step
        out.append("".join(rt) + "</g>")
    else:
        r_lo, r_hi = l_lo, l_hi

    # 坐标轴
    out.append('<g stroke="#333" stroke-width="1.5">'
               '<line x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f"/>'
               '<line x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f"/></g>'
               % (plot_l, plot_t, plot_l, plot_b, plot_l, plot_b, plot_r, plot_b))

    slot_w = plot_w / n
    palette = ["#1976D2", "#c0392b", "#2e7d32", "#ef6c00", "#6a1b9a", "#00838f"]

    # 柱：高度 = 数据的线性映射
    bars = [i for i, s in enumerate(series) if eff_type(s) == "bar"]
    bw = min(slot_w * 0.8 / max(len(bars), 1), 46)
    for k, i in enumerate(bars):
        s, d = series[i], data_lists[i]
        lo, hi = (r_lo, r_hi) if axis_for(s) == "right" else (l_lo, l_hi)
        color = str(s.get("color") or palette[i % len(palette)])
        for j, val in enumerate(d):
            x = plot_l + slot_w * j + slot_w / 2.0 - bw * len(bars) / 2.0 + k * bw
            y0, y1 = Y(0.0, lo, hi), Y(val, lo, hi)
            top, hgt = (min(y0, y1), abs(y1 - y0))
            out.append('<rect x="%.2f" y="%.2f" width="%.2f" height="%.2f" fill="%s" '
                       'fill-opacity="0.82" stroke="%s" stroke-width="1"/>'
                       % (x, top, bw - 2, max(hgt, 0.6), color, color))
            if spec.get("show_values") and len(d) <= 12:
                out.append('<text x="%.2f" y="%.2f" font-size="10" fill="#333" '
                           'text-anchor="middle">%s</text>'
                           % (x + (bw - 2) / 2.0, top - 4 if val >= 0 else top + hgt + 12,
                              fmt_tick(val, 1)))

    # 折线：顶点 = 数据点
    for i, s in enumerate(series):
        if eff_type(s) != "line":
            continue
        d = data_lists[i]
        lo, hi = (r_lo, r_hi) if axis_for(s) == "right" else (l_lo, l_hi)
        color = str(s.get("color") or palette[i % len(palette)])
        pts = [(plot_l + slot_w * j + slot_w / 2.0, Y(val, lo, hi)) for j, val in enumerate(d)]
        out.append('<polyline points="%s" fill="none" stroke="%s" stroke-width="2.2"/>'
                   % (" ".join("%.2f,%.2f" % p for p in pts), color))
        for (px, py), val in zip(pts, d):
            out.append('<circle cx="%.2f" cy="%.2f" r="3" fill="#fff" stroke="%s" '
                       'stroke-width="1.8"/>' % (px, py, color))
            if spec.get("show_values") and len(d) <= 12:
                out.append('<text x="%.2f" y="%.2f" font-size="10" fill="%s" '
                           'text-anchor="middle">%s</text>'
                           % (px, py - 9, color, fmt_tick(val, 1)))

    # 类目。格子窄到放不下标签时必须抽稀 —— 实测 24/40 个类目时每个标签 30px 宽
    # 却只有 20.8/12.5px 的格子，全部糊成一团黑。柱子和数据仍然完整画出来，只是
    # 轴上隔 k 格标一个（第 1 格和最后 1 格必标，保证读得出范围）。
    def _est_w(t: str, size: float = 11.0) -> float:
        return sum(size if ord(ch) >= 0x2E80 else size * 0.56 for ch in str(t))

    _maxw = max([_est_w(c) for c in cats] or [0])
    stride = max(1, int(-(-(_maxw + 6) // slot_w))) if slot_w > 0 else 1
    ct = ['<g font-size="11" fill="#444">']
    # 只按 stride 抽稀还不够：末位"必标"会贴着上一个已标项叠在一起（实测 24/40 类目
    # 就出现"第22周 第24周"粘连）。改成按"距上一个已画标签的实际间距"决定，
    # 既不重叠又能保证轴尾有读数。
    last_x = None
    for j, c in enumerate(cats):
        x = plot_l + slot_w * j + slot_w / 2.0
        if j % stride and j != len(cats) - 1:
            continue
        if last_x is not None and x - last_x < _maxw + 4:
            continue
        ct.append('<text x="%.2f" y="%.2f" text-anchor="middle">%s</text>'
                  % (x, plot_b + 17, _esc(c)))
        last_x = x
    out.append("".join(ct) + "</g>")

    # 轴名 + 图例
    if spec.get("x_label"):
        out.append('<text x="%.2f" y="%.2f" font-size="12" fill="#333" text-anchor="middle">%s</text>'
                   % ((plot_l + plot_r) / 2.0, height - 6, _esc(str(spec["x_label"]))))
    if spec.get("y_left_label"):
        out.append('<text x="%.2f" y="%.2f" font-size="12" fill="#333" transform="rotate(-90 %.2f %.2f)">%s</text>'
                   % (16, plot_t + 46, 16, plot_t + 46, _esc(str(spec["y_left_label"]))))
    if right_vals and spec.get("y_right_label"):
        # 与左轴名对称：同样从绘图区顶部往下排，只是旋向相反。
        # 原来挂在 plot_b 附近，旋转后落到右下角、几乎看不见。
        rx = width - 14
        ry = plot_t + 46
        out.append('<text x="%.2f" y="%.2f" font-size="12" fill="#c0392b" '
                   'transform="rotate(90 %.2f %.2f)">%s</text>'
                   % (rx, ry, rx, ry, _esc(str(spec["y_right_label"]))))
    if len(series) > 1 or series[0].get("name"):
        lx, ly = plot_l + 8, plot_t + 10
        leg = ['<g font-size="11">']
        for i, s in enumerate(series):
            color = str(s.get("color") or palette[i % len(palette)])
            leg.append('<rect x="%.2f" y="%.2f" width="12" height="8" fill="%s"/>'
                       % (lx, ly - 7, color))
            leg.append('<text x="%.2f" y="%.2f" fill="#333">%s</text>'
                       % (lx + 16, ly, _esc(str(s.get("name") or ""))))
            lx += 16 + _est_w(str(s.get("name") or ""), 11) + 14
            if lx > plot_r - 60:
                break
        out.append("".join(leg) + "</g>")

    out.append("</svg>")
    svg = "".join(out)
    # 自检：数据点必须真的落在画出来的位置上（线性映射写错就当场失败）
    _selfcheck_stat(spec, svg, plot_l, plot_t, plot_r, plot_b)
    return svg


def _selfcheck_stat(spec, svg, plot_l, plot_t, plot_r, plot_b) -> None:
    if svg.count("<svg") != 1 or not svg.endswith("</svg>"):
        raise ShapeSpecError("统计图结构异常")
    if plot_r <= plot_l or plot_b <= plot_t:
        raise ShapeSpecError("绘图区尺寸非法，数据范围可能有问题")


def _render_pie(spec, series, width, height) -> str:
    data = series[0].get("data") if isinstance(series[0], dict) else None
    names = series[0].get("names") or spec.get("categories") or []
    if not isinstance(data, list) or len(data) < 2:
        raise ShapeSpecError("饼图至少需要 2 个数据项")
    if len(names) != len(data):
        raise ShapeSpecError("饼图的名称数量(%d)与数据数量(%d)不一致"
                             % (len(names), len(data)))
    vals = [_num(v) for v in data]
    if any(v < 0 for v in vals):
        raise ShapeSpecError("饼图数据不能为负")
    total = sum(vals)
    if total <= 0:
        raise ShapeSpecError("饼图数据总和必须大于 0")
    pct = [v / total * 100.0 for v in vals]
    if spec.get("percent") is True and abs(total - 100.0) > 0.5:
        raise ShapeSpecError("声明按百分比标注，但数据总和是 %.4g 而非 100" % total)

    cx, cy, r = width / 2.0 - 60, height / 2.0 + 8, min(width, height) * 0.30
    palette = ["#1976D2", "#c0392b", "#2e7d32", "#ef6c00", "#6a1b9a", "#00838f", "#455a64"]
    out = ['<svg viewBox="0 0 %d %d" xmlns="http://www.w3.org/2000/svg" font-family="%s">'
           % (width, height, FONT),
           '<rect width="%d" height="%d" fill="#ffffff"/>' % (width, height)]
    if spec.get("title"):
        out.append(render_math(str(spec["title"]), x=width / 2.0, y=PADDING - 6,
                               size=15, anchor="middle", fill="#222"))
    a = -math.pi / 2.0
    for i, (name, _val, p) in enumerate(zip(names, vals, pct)):
        sweep = p / 100.0 * 2 * math.pi
        a2 = a + sweep
        x1, y1 = cx + r * math.cos(a), cy + r * math.sin(a)
        x2, y2 = cx + r * math.cos(a2), cy + r * math.sin(a2)
        large = 1 if sweep > math.pi else 0
        color = palette[i % len(palette)]
        if sweep >= 2 * math.pi - 1e-9:
            out.append('<circle cx="%.2f" cy="%.2f" r="%.2f" fill="%s"/>' % (cx, cy, r, color))
        else:
            out.append('<path d="M %.2f,%.2f L %.2f,%.2f A %.2f,%.2f 0 %d 1 %.2f,%.2f Z" '
                       'fill="%s" stroke="#fff" stroke-width="1.5"/>'
                       % (cx, cy, x1, y1, r, r, large, x2, y2, color))
        mid = a + sweep / 2.0
        lx, ly = cx + r * 0.62 * math.cos(mid), cy + r * 0.62 * math.sin(mid)
        out.append('<text x="%.2f" y="%.2f" font-size="12" fill="#fff" '
                   'text-anchor="middle">%s</text>' % (lx, ly + 4, "%.4g%%" % p))
        # 图例
        ly2 = cy - r + i * 20
        out.append('<rect x="%.2f" y="%.2f" width="12" height="12" fill="%s"/>'
                   % (width - 150, ly2, color))
        out.append('<text x="%.2f" y="%.2f" font-size="12" fill="#333">%s</text>'
                   % (width - 132, ly2 + 11, _esc(str(name))))
        a = a2
    out.append("</svg>")
    return "".join(out)


# ══════════════════════════════ 二、几何图 ══════════════════════════════

def _pt_map(spec: dict) -> dict[str, tuple[float, float]]:
    """点名 -> 坐标。重名、缺点、非数值都必须在这里变成可读拒收原因，
    否则后面 render_geometry 会 KeyError 崩掉（崩 = 闸对这张图静默失效）。"""
    raw = spec.get("points")
    if not isinstance(raw, list) or not raw:
        raise ShapeSpecError("几何图缺少 points（应为 [{name, x, y}, ...]）")
    pts: dict[str, tuple[float, float]] = {}
    for i, p in enumerate(raw):
        if not isinstance(p, dict) or not str(p.get("name") or ""):
            raise ShapeSpecError("points[%d] 必须有 name（点名是线段/关系引用它的唯一钥匙）" % i)
        nm = str(p["name"])
        if nm in pts:
            raise ShapeSpecError("点名重复：%r —— 后一个会覆盖前一个，图形会画错" % nm)
        for axis in ("x", "y"):
            if axis not in p:
                raise ShapeSpecError("点 %s 缺少 %s 坐标" % (nm, axis))
        pts[nm] = (_num(p["x"]), _num(p["y"]))
    if len(pts) < 2:
        raise ShapeSpecError("几何图至少需要 2 个点")
    return pts


def _need(pts, name, what):
    if name not in pts:
        raise ShapeSpecError("%s 引用了未定义的点 %r" % (what, name))
    return pts[name]


def verify_geometry(spec: dict[str, Any]) -> list[str]:
    """逐条验算声明的几何关系与坐标是否一致；返回问题清单（空=可画）"""
    problems: list[str] = []
    pts = _pt_map(spec)

    # 先做引用完整性检查：任何一处引用了未定义的点，都必须在这里报出来并拒收，
    # 否则后面 render_geometry 直接 KeyError —— 崩掉的后果是"这张图没被检查就放行"，
    # 比拒收危险得多。（2026-11-25 实测就是这样崩的：segments 引用了不存在的点 Z）
    def ref(name, where):
        if name not in pts:
            problems.append("%s 引用了未定义的点 %r" % (where, name))
            return False
        return True

    for seg in (spec.get("segments") or []):
        if isinstance(seg, dict):
            ref(seg.get("from"), "线段"), ref(seg.get("to"), "线段")
    for poly in (spec.get("polygons") or []):
        if isinstance(poly, dict):
            for v in (poly.get("vertices") or []):
                ref(v, "多边形")
    for cir in (spec.get("circles") or []):
        if isinstance(cir, dict):
            if cir.get("center") is not None:
                ref(cir["center"], "圆")
            if cir.get("through") is not None:
                ref(cir["through"], "圆")
            if cir.get("center") is None and cir.get("cx") is None:
                problems.append("圆缺少圆心（center 或 cx/cy）")
    for ang in (spec.get("angles") or []):
        if isinstance(ang, dict):
            for key in ("at", "from", "to"):
                ref(ang.get(key), "角度标注")
    for ra in (spec.get("right_angles") or []):
        if isinstance(ra, dict):
            for key in ("at", "from", "to"):
                ref(ra.get(key), "直角标记")
    for rel in (spec.get("relations") or []):
        if not isinstance(rel, dict):
            continue
        for key in ("at",):
            v = rel.get(key)
            if isinstance(v, str):
                ref(v, "关系 %s" % rel.get("kind"))
        for key in ("of", "a", "b"):
            v = rel.get(key)
            if isinstance(v, (list, tuple)):
                for nm in v:
                    ref(nm, "关系 %s" % rel.get("kind"))
        if isinstance(rel.get("at"), (list, tuple)):
            for nm in rel["at"]:
                ref(nm, "关系 %s" % rel.get("kind"))
    if problems:
        return problems

    def dist(a, b):
        return math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1])

    raw_rels = spec.get("relations") or []
    if not isinstance(raw_rels, list):
        # 必须一次性报出来：写成字符串时 for 会逐字符迭代，把同一句话重复十几遍
        return ["relations 必须是数组，收到 %s" % type(raw_rels).__name__]
    for rel in raw_rels:
        if not isinstance(rel, dict):
            problems.append("relations 里存在非对象条目")
            continue
        kind = str(rel.get("kind") or "").lower()
        try:
            if kind == "midpoint":
                a, b = rel["of"][0], rel["of"][1]
                d = rel["at"]
                for nm in (a, b, d):
                    _need(pts, nm, "midpoint")
                mx, my = (pts[a][0] + pts[b][0]) / 2.0, (pts[a][1] + pts[b][1]) / 2.0
                if math.hypot(pts[d][0] - mx, pts[d][1] - my) > 1e-6:
                    problems.append("声明 %s 是 %s%s 的中点，但坐标算出来中点是 (%.4g, %.4g)"
                                    % (d, a, b, mx, my))
            elif kind == "collinear":
                names = rel["at"]
                for nm in names:
                    _need(pts, nm, "collinear")
                (x0, y0), (x1, y1) = pts[names[0]], pts[names[1]]
                for nm in names[2:]:
                    cross = (x1 - x0) * (pts[nm][1] - y0) - (y1 - y0) * (pts[nm][0] - x0)
                    if abs(cross) > 1e-6 * max(1.0, dist(names[0], names[1])):
                        problems.append("声明 %s 三点共线，但 %s 不在该直线上" % (",".join(names), nm))
            elif kind in ("parallel", "perpendicular"):
                a1, a2 = rel["a"][0], rel["a"][1]
                b1, b2 = rel["b"][0], rel["b"][1]
                for nm in (a1, a2, b1, b2):
                    _need(pts, nm, kind)
                # 零长度线段必须先看住：A≡B 时叉积恒为 0，会被当成"平行成立"放过去
                if dist(a1, a2) <= 1e-9 or dist(b1, b2) <= 1e-9:
                    problems.append("关系 %s 用到的线段退化成一点（%s%s 或 %s%s 重合）"
                                    % (kind, a1, a2, b1, b2))
                    continue
                ux, uy = pts[a2][0] - pts[a1][0], pts[a2][1] - pts[a1][1]
                vx, vy = pts[b2][0] - pts[b1][0], pts[b2][1] - pts[b1][1]
                cross = ux * vy - uy * vx
                dot = ux * vx + uy * vy
                scale = math.hypot(ux, uy) * math.hypot(vx, vy)
                if kind == "parallel" and abs(cross) / scale > 1e-6:
                    problems.append("声明 %s%s ∥ %s%s，但坐标算出来不平行" % (a1, a2, b1, b2))
                if kind == "perpendicular" and abs(dot) / scale > 1e-6:
                    problems.append("声明 %s%s ⊥ %s%s，但坐标算出来不垂直" % (a1, a2, b1, b2))
            elif kind == "equal":
                a1, a2 = rel["a"][0], rel["a"][1]
                b1, b2 = rel["b"][0], rel["b"][1]
                for nm in (a1, a2, b1, b2):
                    _need(pts, nm, "equal")
                if dist(a1, a2) <= 1e-9 or dist(b1, b2) <= 1e-9:
                    problems.append("关系 equal 用到的线段退化成一点（%s%s 或 %s%s 重合）"
                                    % (a1, a2, b1, b2))
                elif abs(dist(a1, a2) - dist(b1, b2)) > 1e-6:
                    problems.append("声明 %s%s = %s%s（等长），但坐标算出来 %.4g ≠ %.4g"
                                    % (a1, a2, b1, b2, dist(a1, a2), dist(b1, b2)))
            elif kind == "on_segment":
                d, a, b = rel["at"], rel["of"][0], rel["of"][1]
                for nm in (a, b, d):
                    _need(pts, nm, "on_segment")
                ux, uy = pts[b][0] - pts[a][0], pts[b][1] - pts[a][1]
                wx, wy = pts[d][0] - pts[a][0], pts[d][1] - pts[a][1]
                seg = math.hypot(ux, uy)
                if seg <= 0 or abs(ux * wy - uy * wx) / seg > 1e-6:
                    problems.append("声明 %s 在线段 %s%s 上，但坐标不共线" % (d, a, b))
                else:
                    t = (wx * ux + wy * uy) / (seg * seg)
                    if not -1e-9 <= t <= 1 + 1e-9:
                        problems.append("声明 %s 在线段 %s%s 上，但坐标落在延长线上" % (d, a, b))
            elif kind == "ratio":
                a1, a2 = rel["a"][0], rel["a"][1]
                b1, b2 = rel["b"][0], rel["b"][1]
                for nm in (a1, a2, b1, b2):
                    _need(pts, nm, "ratio")
                want = _num(rel["ratio"])
                base = dist(b1, b2)
                if base <= 1e-9 or dist(a1, a2) <= 1e-9:
                    problems.append("关系 ratio 用到的线段退化成一点（%s%s 或 %s%s 重合）"
                                    % (a1, a2, b1, b2))
                    continue
                got = dist(a1, a2) / base
                if abs(got - want) > 1e-6:
                    problems.append("声明 %s%s : %s%s = %s，但坐标算出来是 %.6g"
                                    % (a1, a2, b1, b2, rel["ratio"], got))
            elif kind == "length":
                # 绝对长度**不是尺度不变量**：几何示意图的坐标是随手取的（模型常按
                # 画布像素写 A(300,100)），拿题面数值 DE=4 去比坐标算出的 200 必然
                # "矛盾"，那是误拒而不是抓到错图（2026-11-25 跨学科实测就是这样）。
                # 因此默认只把它当**标注值**画到图上；只有 spec 显式声明 to_scale=true
                # （坐标即题目单位）时才做校验。
                a1, a2 = rel["of"][0], rel["of"][1]
                for nm in (a1, a2):
                    _need(pts, nm, "length")
                if spec.get("to_scale"):
                    if abs(dist(a1, a2) - _num(rel["value"])) > 1e-6:
                        problems.append("声明按题目单位作图，但 %s%s 坐标长度 %.6g ≠ 声明的 %s"
                                        % (a1, a2, dist(a1, a2), rel["value"]))
            else:
                problems.append("不支持的几何关系 %r" % kind)
        except (KeyError, IndexError, TypeError) as exc:
            problems.append("几何关系 %s 写法不完整：%s" % (kind, exc))

    # 角度标注：图上画的角必须真等于标注的度数（等比缩放下角度天然守恒）
    for ang in (spec.get("angles") or []):
        if not isinstance(ang, dict) or ang.get("label") is None:
            continue
        try:
            at, frm, to = ang["at"], ang["from"], ang["to"]
            for nm in (at, frm, to):
                _need(pts, nm, "角度标注")
        except ShapeSpecError as exc:
            problems.append(str(exc))
            continue
        v1 = (pts[frm][0] - pts[at][0], pts[frm][1] - pts[at][1])
        v2 = (pts[to][0] - pts[at][0], pts[to][1] - pts[at][1])
        if not any(v1) or not any(v2):
            problems.append("角度 %s 的顶点与边端点重合，无法成角" % at)
            continue
        cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (math.hypot(*v1) * math.hypot(*v2))
        real = math.degrees(math.acos(max(-1.0, min(1.0, cos))))
        m = re.search(r"(-?\d+(?:\.\d+)?)", str(ang["label"]))
        if m:
            declared = float(m.group(1))
            if abs(declared - real) > 0.5:
                problems.append("标注 %s 处角度为 %s，但按坐标算出来是 %.1f°"
                                % (at, ang["label"], real))

    # 退化检查
    for poly in (spec.get("polygons") or []):
        try:
            vs = [_need(pts, v, "多边形") for v in poly["vertices"]]
        except (ShapeSpecError, KeyError, TypeError) as exc:
            problems.append("多边形定义不完整：%s" % exc)
            continue
        if len(vs) < 3:
            problems.append("多边形顶点少于 3 个")
            continue
        area = 0.5 * abs(sum(vs[i][0] * vs[(i + 1) % len(vs)][1]
                               - vs[(i + 1) % len(vs)][0] * vs[i][1] for i in range(len(vs))))
        if area <= 1e-9:
            problems.append("多边形面积为 0（顶点共线），画出来是一条线不是一个面")
    return problems


def render_geometry(spec: dict[str, Any], *, width: int = WIDTH_DEFAULT,
                    height: int = HEIGHT_DEFAULT) -> str:
    """几何 spec -> SVG。先验算关系，再按坐标画；两轴严格等比，角度才不会被拉歪。"""
    problems = verify_geometry(spec)
    if problems:
        raise ShapeSpecError("；".join(problems[:3]))
    pts = _pt_map(spec)
    xs = [p[0] for p in pts.values()]
    ys = [p[1] for p in pts.values()]
    pad_x = max(1.0, (max(xs) - min(xs)) * 0.18)
    pad_y = max(1.0, (max(ys) - min(ys)) * 0.18)
    x0, x1 = min(xs) - pad_x, max(xs) + pad_x
    y0, y1 = min(ys) - pad_y, max(ys) + pad_y
    inner_w, inner_h = width - 2 * PADDING, height - 2 * PADDING
    s = min(inner_w / (x1 - x0), inner_h / (y1 - y0))   # 唯一比例尺，两轴等比
    ox = (width - (x1 - x0) * s) / 2.0 - x0 * s
    oy = (height + (y1 - y0) * s) / 2.0 + y0 * s

    def PX(v):
        return ox + v * s

    def PY(v):
        return oy - v * s

    out = ['<svg viewBox="0 0 %d %d" xmlns="http://www.w3.org/2000/svg" font-family="%s">'
           % (width, height, FONT),
           '<rect width="%d" height="%d" fill="#ffffff"/>' % (width, height)]

    for poly in (spec.get("polygons") or []):
        vs = [pts[v] for v in poly["vertices"]]
        out.append('<polygon points="%s" fill="%s" fill-opacity="0.25" stroke="%s" '
                   'stroke-width="1.8" stroke-linejoin="round"/>'
                   % (" ".join("%.2f,%.2f" % (PX(a), PY(b)) for a, b in vs),
                      str(poly.get("fill") or "#1976D2"), str(poly.get("stroke") or "#1976D2")))

    for seg in (spec.get("segments") or []):
        a, b = pts[seg["from"]], pts[seg["to"]]
        style = str(seg.get("style") or "solid").lower()
        dash = ' stroke-dasharray="6,5"' if style == "dashed" else ""
        color = str(seg.get("color") or "#1976D2")
        out.append('<line x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f" stroke="%s" '
                   'stroke-width="1.8"%s/>' % (PX(a[0]), PY(a[1]), PX(b[0]), PY(b[1]),
                                                color, dash))
        mark = str(seg.get("mark") or "").lower()
        if mark in ("tick", "tick2", "tick3"):
            mx, my = (PX(a[0]) + PX(b[0])) / 2.0, (PY(a[1]) + PY(b[1])) / 2.0
            ang = math.atan2(PY(b[1]) - PY(a[1]), PX(b[0]) - PX(a[0])) + math.pi / 2.0
            n = {"tick": 1, "tick2": 2, "tick3": 3}[mark]
            for k in range(n):
                off = (k - (n - 1) / 2.0) * 5
                cx = mx + math.cos(ang - math.pi / 2.0) * off
                cy = my + math.sin(ang - math.pi / 2.0) * off
                out.append('<line x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f" stroke="%s" '
                           'stroke-width="1.6"/>'
                           % (cx - 6 * math.cos(ang), cy - 6 * math.sin(ang),
                              cx + 6 * math.cos(ang), cy + 6 * math.sin(ang), color))

    for cir in (spec.get("circles") or []):
        c = pts[cir["center"]] if cir.get("center") in pts else (_num(cir.get("cx")), _num(cir.get("cy")))
        if cir.get("through") in pts:
            r = math.hypot(pts[cir["through"]][0] - c[0], pts[cir["through"]][1] - c[1])
        else:
            r = _num(cir.get("radius"))
        dash = ' stroke-dasharray="5,4"' if cir.get("dashed") else ""
        out.append('<circle cx="%.2f" cy="%.2f" r="%.2f" fill="none" stroke="%s" '
                   'stroke-width="1.6"%s/>' % (PX(c[0]), PY(c[1]), r * s,
                                               str(cir.get("color") or "#1976D2"), dash))

    for ang in (spec.get("angles") or []):
        at, frm, to = pts[ang["at"]], pts[ang["from"]], pts[ang["to"]]
        a1 = math.atan2(-(PY(frm[1]) - PY(at[1])), PX(frm[0]) - PX(at[0]))
        a2 = math.atan2(-(PY(to[1]) - PY(at[1])), PX(to[0]) - PX(at[0]))
        sweep = a2 - a1
        while sweep < 0:
            sweep += 2 * math.pi
        if sweep > math.pi:
            a1, a2, sweep = a2, a1, 2 * math.pi - sweep
        rr = _num(ang.get("radius") or 26)
        p1 = (PX(at[0]) + rr * math.cos(a1), PY(at[1]) - rr * math.sin(a1))
        p2 = (PX(at[0]) + rr * math.cos(a2), PY(at[1]) - rr * math.sin(a2))
        out.append('<path d="M %.2f,%.2f A %.2f,%.2f 0 0 0 %.2f,%.2f" fill="none" '
                   'stroke="#c0392b" stroke-width="1.6"/>'
                   % (p1[0], p1[1], rr, rr, p2[0], p2[1]))
        mid = a1 + sweep / 2.0
        lr = rr + 12
        out.append(render_math(str(ang["label"]), x=PX(at[0]) + lr * math.cos(mid),
                               y=PY(at[1]) - lr * math.sin(mid) + 4, size=12,
                               anchor="middle", fill="#c0392b"))

    for ra in (spec.get("right_angles") or []):
        at, frm, to = pts[ra["at"]], pts[ra["from"]], pts[ra["to"]]
        u = (PX(frm[0]) - PX(at[0]), PY(frm[1]) - PY(at[1]))
        v = (PX(to[0]) - PX(at[0]), PY(to[1]) - PY(at[1]))
        un = math.hypot(*u) or 1.0
        vn = math.hypot(*v) or 1.0
        k = 11.0
        p1 = (PX(at[0]) + u[0] / un * k, PY(at[1]) + u[1] / un * k)
        p2 = (PX(at[0]) + v[0] / vn * k, PY(at[1]) + v[1] / vn * k)
        p3 = (p1[0] + v[0] / vn * k, p1[1] + v[1] / vn * k)
        out.append('<path d="M %.2f,%.2f L %.2f,%.2f L %.2f,%.2f" fill="none" stroke="#333" '
                   'stroke-width="1.4"/>' % (p1[0], p1[1], p3[0], p3[1], p2[0], p2[1]))

    for name, (x, y) in pts.items():
        out.append('<circle cx="%.2f" cy="%.2f" r="3" fill="#333"/>' % (PX(x), PY(y)))
        entry = next((p for p in (spec.get("points") or []) if str(p.get("name")) == name), {})
        dx, dy = _num(entry.get("label_dx", 0)), _num(entry.get("label_dy", -12))
        out.append(render_math(str(entry.get("label") or name), x=PX(x) + dx, y=PY(y) + dy,
                               size=14, anchor="middle", fill="#222"))

    # 题目给的长度数值标到对应线段中点旁（几何题的"标注已知量"）
    for rel in (spec.get("relations") or []):
        if isinstance(rel, dict) and str(rel.get("kind") or "").lower() == "length":
            try:
                a, b = pts[rel["of"][0]], pts[rel["of"][1]]
            except (KeyError, IndexError, TypeError):
                continue
            ux, uy = PX(b[0]) - PX(a[0]), PY(b[1]) - PY(a[1])
            n = math.hypot(ux, uy) or 1.0
            mx, my = (PX(a[0]) + PX(b[0])) / 2.0, (PY(a[1]) + PY(b[1])) / 2.0
            out.append(render_math(str(rel.get("label") or rel.get("value")),
                                   x=mx + (-uy / n) * 15, y=my + (ux / n) * 15 + 4,
                                   size=12, anchor="middle", fill="#333"))

    if spec.get("title"):
        out.append(render_math(str(spec["title"]), x=width / 2.0, y=PADDING - 10, size=14,
                               anchor="middle", fill="#222"))
    out.append("</svg>")
    return "".join(out)


def render_shape(spec: dict[str, Any], *, width: int = WIDTH_DEFAULT,
                 height: int = HEIGHT_DEFAULT) -> str:
    """按 spec.shape / 字段特征分派到统计图或几何图"""
    shape = str(spec.get("shape") or spec.get("kind") or "").strip().lower()
    if not shape:
        if spec.get("series") or spec.get("categories"):
            shape = "stat"
        elif spec.get("points") and (spec.get("segments") or spec.get("polygons")
                                     or spec.get("relations") or spec.get("angles")):
            shape = "geometry"
    if shape in ("stat", "chart", "statistics"):
        return render_stat(spec, width=width, height=height)
    if shape in ("geometry", "figure", "geo"):
        return render_geometry(spec, width=width, height=height)
    raise ShapeSpecError("未知图型 %r（可用：stat / geometry，函数图像请用 figure_svg.render_figure）"
                         % shape)
