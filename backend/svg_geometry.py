"""SVG 几何体检 —— 不看语义、只看画得对不对位置的质量闸。

用途
----
函数图像有 figure_spec + 确定性渲染兜底（见 backend.figure_svg），但电路图、流程图、
装置图、光路图这类**没法参数化**的图仍然是模型手绘像素。这类图最常见的坏法不需要
理解语义就能发现：

- 画到 viewBox 外面 —— 实测 #2308 的抛物线和 y 轴截距点在 y=500px，而画布只有 400px 高，
  学生看到的是一张"只有坐标轴和两个点"的空图；
- 整张图挤在一个几十像素的角落里（比例尺算错）；
- 只有边框没有内容；
- ``<text>`` 里留着没排版的 LaTeX（``$R_1$``）；
- 把正确选项的解析式写进了图里（配图泄答案）。

这些都属于"能机械判定的错"，所以在入库前一律拦下：宁可不配图，也不配一张错的。
"""
from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET
from typing import Any

from backend.math_text import latex_leftovers

_NS = "{http://www.w3.org/2000/svg}"
_NUM_RE = re.compile(r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?")


class _Mat:
    """仿射矩阵（a b c d e f），用来累计 transform，避免只看 translate 的漏判"""

    __slots__ = ("a", "b", "c", "d", "e", "f")

    def __init__(self, a=1.0, b=0.0, c=0.0, d=1.0, e=0.0, f=0.0):
        self.a, self.b, self.c, self.d, self.e, self.f = a, b, c, d, e, f

    def apply(self, x: float, y: float) -> tuple[float, float]:
        return (self.a * x + self.c * y + self.e, self.b * x + self.d * y + self.f)

    def then(self, m: "_Mat") -> "_Mat":
        return _Mat(self.a * m.a + self.c * m.b, self.b * m.a + self.d * m.b,
                    self.a * m.c + self.c * m.d, self.b * m.c + self.d * m.d,
                    self.a * m.e + self.c * m.f + self.e, self.b * m.e + self.d * m.f + self.f)


_TRANSFORM_RE = re.compile(r"(translate|scale|rotate|matrix|skewX|skewY)\s*\(([^)]*)\)", re.I)


def _parse_transform(raw: str | None) -> _Mat:
    m = _Mat()
    if not raw:
        return m
    for name, arg in _TRANSFORM_RE.findall(raw):
        nums = [float(v) for v in _NUM_RE.findall(arg)]
        low = name.lower()
        if low == "translate":
            dx = nums[0] if nums else 0.0
            dy = nums[1] if len(nums) > 1 else 0.0
            m = m.then(_Mat(e=dx, f=dy))
        elif low == "scale":
            sx = nums[0] if nums else 1.0
            sy = nums[1] if len(nums) > 1 else sx
            m = m.then(_Mat(a=sx, d=sy))
        elif low == "rotate":
            ang = nums[0] if nums else 0.0
            cx = nums[1] if len(nums) > 2 else 0.0
            cy = nums[2] if len(nums) > 2 else 0.0
            rad = math.radians(ang)
            rot = _Mat(math.cos(rad), math.sin(rad), -math.sin(rad), math.cos(rad), cx, cy)
            m = m.then(_Mat(e=cx, f=cy)).then(rot)
        elif low == "matrix":
            if len(nums) == 6:
                m = m.then(_Mat(*nums))
        elif low == "skewx" and nums:
            m = m.then(_Mat(c=math.tan(math.radians(nums[0]))))
        elif low == "skewy" and nums:
            m = m.then(_Mat(b=math.tan(math.radians(nums[0]))))
    return m


_PATH_CMD_RE = re.compile(r"([MmLlHhVvCcSsQqTtAaZz])|(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)")


def _num(raw: str | None) -> float | None:
    """属性值 -> float；非纯数字（"100%"、"auto"、空）一律返回 None 跳过

    真实 AI SVG 里 x1="100%"、width="50%"、r="auto" 都会让 float() 抛穿。本模块是质量闸，
    抛穿的后果不是"报错"而是"这张图没被检查就放行了"，所以宁可少取一个点。
    """
    if raw is None:
        return None
    t = str(raw).strip().rstrip("%")
    if not t:
        return None
    try:
        return float(t)
    except ValueError:
        return None


def _walk_path(d: str) -> list[tuple[float, float]]:
    """把 path d 里的坐标点取出来（绝对/相对都支持；弧线按端点取）

    AI 写的 path 千奇百怪：指令后参数不足（实测有 C 只给 5 个数、Q 只给 3 个数的真实
    SVG）、以 Z 结尾又接新段、只有 M 没有后续。原则是**取到多少算多少，绝不因数据
    残缺而抛异常** —— 本函数服务于质量闸，一旦抛穿，上层会"保守放行"，那道闸对这张图
    就静默失效：比放行一张错图更危险，因为它让闸看起来还在工作。
    """
    pts: list[tuple[float, float]] = []
    segs: list[list] = []
    for m in _PATH_CMD_RE.finditer(d or ""):
        if m.group(1):
            segs.append([m.group(1), []])
        elif m.group(2) and segs:
            segs[-1][1].append(float(m.group(2)))

    need_of = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "Q": 4,
               "S": 2, "T": 2, "A": 7, "Z": 0}
    cx = cy = 0.0
    sx = sy = 0.0
    for cmd, a in segs:
        if not cmd:
            continue
        rel = cmd.islower()
        k = cmd.upper()
        pos = 0
        while k in need_of:
            need = need_of[k]
            if len(a) - pos < need:
                break
            if need == 0:                             # Z：回到起点
                cx, cy = sx, sy
                break
            if k == "M":
                x, y = a[pos], a[pos + 1]
                cx, cy = (cx + x, cy + y) if rel else (x, y)
                sx, sy = cx, cy
                pts.append((cx, cy))
                pos += 2
                k = "L"                               # M 后续跟的坐标按线段处理
            elif k == "L":
                x, y = a[pos], a[pos + 1]
                cx, cy = (cx + x, cy + y) if rel else (x, y)
                pts.append((cx, cy))
                pos += 2
            elif k == "H":
                cx = (cx + a[pos]) if rel else a[pos]
                pts.append((cx, cy))
                pos += 1
            elif k == "V":
                cy = (cy + a[pos]) if rel else a[pos]
                pts.append((cx, cy))
                pos += 1
            elif k == "C":
                x1, y1, x2, y2, x, y = a[pos:pos + 6]
                if rel:
                    pts.extend([(cx + x1, cy + y1), (cx + x2, cy + y2), (cx + x, cy + y)])
                    cx, cy = cx + x, cy + y
                else:
                    pts.extend([(x1, y1), (x2, y2), (x, y)])
                    cx, cy = x, y
                pos += 6
            elif k == "Q":
                x1, y1, x, y = a[pos:pos + 4]
                if rel:
                    pts.extend([(cx + x1, cy + y1), (cx + x, cy + y)])
                    cx, cy = cx + x, cy + y
                else:
                    pts.extend([(x1, y1), (x, y)])
                    cx, cy = x, y
                pos += 4
            elif k in ("S", "T"):
                x, y = a[pos], a[pos + 1]
                cx, cy = (cx + x, cy + y) if rel else (x, y)
                pts.append((cx, cy))
                pos += 2
            elif k == "A":
                x, y = a[pos + 5], a[pos + 6]
                cx, cy = (cx + x, cy + y) if rel else (x, y)
                pts.append((cx, cy))
                pos += 7
            else:
                break
    return pts


def _viewbox(svg: str) -> tuple[float, float, float, float] | None:
    """取 viewBox。必须从解析后的根元素读，不能只靠双引号正则

    原来写成只匹配 ``viewBox="..."``。AI 生成的 SVG 里 ``viewBox='0 0 600 400'``
    很常见，那种图会返回 None，而 inspect_svg 的**越界检查与"挤在角落"检查都在
    ``if vb:`` 里面** —— 等于单引号的图完全不做几何体检，而 #2308 那种"曲线画到
    画布外、学生看到空图"正是要靠这两项拦下来的（2026-11-25 口径审查发现）。
    """
    raw: str | None = None
    try:
        root = ET.fromstring(svg)
        raw = root.get("viewBox") or root.get("viewbox")
    except ET.ParseError:
        raw = None
    if raw is None:
        m = re.search("viewBox\\s*=\\s*[\"\']([^\"\']*)[\"\']", svg or "")
        raw = m.group(1) if m else None
    if not raw:
        return None
    nums = [float(v) for v in _NUM_RE.findall(raw)]
    if len(nums) != 4:
        return None
    return (nums[0], nums[1], nums[2], nums[3])


def collect_points(svg: str) -> list[tuple[float, float]]:
    """取全图所有可见几何点（已折算 transform）"""
    pts: list[tuple[float, float]] = []
    try:
        root = ET.fromstring(svg)
    except ET.ParseError:
        return pts

    def walk(el, mat: _Mat) -> None:
        m2 = mat.then(_parse_transform(el.get("transform")))
        tag = el.tag.replace(_NS, "")
        g = el.get
        if tag == "line":
            for kx, ky in (("x1", "y1"), ("x2", "y2")):
                vx, vy = _num(g(kx)), _num(g(ky))
                if vx is not None and vy is not None:
                    pts.append(m2.apply(vx, vy))
        elif tag == "circle":
            ccx, ccy, rr = _num(g("cx")) or 0.0, _num(g("cy")) or 0.0, _num(g("r")) or 0.0
            for dx, dy in ((-rr, 0), (rr, 0), (0, -rr), (0, rr)):
                pts.append(m2.apply(ccx + dx, ccy + dy))
        elif tag == "ellipse":
            ccx, ccy = _num(g("cx")) or 0.0, _num(g("cy")) or 0.0
            rx, ry = _num(g("rx")) or 0.0, _num(g("ry")) or 0.0
            for dx, dy in ((-rx, 0), (rx, 0), (0, -ry), (0, ry)):
                pts.append(m2.apply(ccx + dx, ccy + dy))
        elif tag == "rect":
            x, y = _num(g("x")) or 0.0, _num(g("y")) or 0.0
            w, h = _num(g("width")) or 0.0, _num(g("height")) or 0.0
            for dx, dy in ((0, 0), (w, 0), (0, h), (w, h)):
                pts.append(m2.apply(x + dx, y + dy))
        elif tag in ("polyline", "polygon"):
            for gx, gy in re.findall(r"(-?[\d.]+)[,\s]+(-?[\d.]+)", g("points") or ""):
                pts.append(m2.apply(float(gx), float(gy)))
        elif tag == "path":
            for x, y in _walk_path(g("d") or ""):
                pts.append(m2.apply(x, y))
        elif tag == "text":
            pts.append(m2.apply(_num(g("x")) or 0.0, _num(g("y")) or 0.0))
        for child in list(el):
            walk(child, m2)

    for child in list(root):
        walk(child, _Mat())
    return pts


def inspect_svg(svg: str | None, *, options: dict[str, Any] | None = None,
                correct_answer: str = "") -> tuple[list[str], list[str]]:
    """返回 (硬伤, 软问题)

    分两级是必要的：手绘的电路图/流程图经常有少量元素压着画布边，若一律拒收，
    闸门就会变成"大部分配图都不要了"，老师只会把它关掉。只有**确定会让学生看到
    错图或乱码**的才做硬拦：画到画布外一大半、挤成一个点、空图、公式没排版、泄答案。
    """
    hard: list[str] = []
    soft: list[str] = []
    if not svg or "<svg" not in svg:
        return ["不是 SVG"], []
    vb = _viewbox(svg)
    if not vb:
        soft.append("缺少 viewBox，导出到试卷时尺寸不可控")
    drawable = re.findall(r"<(line|circle|rect|path|polyline|polygon|text|ellipse|image)\b", svg)
    if len(drawable) < 2:
        hard.append("图元过少（%d 个），基本是空图" % len(drawable))
        return hard, soft

    pts = collect_points(svg)
    if not pts:
        hard.append("取不到任何几何坐标")
        return hard, soft

    if vb:
        vx, vy, vw, vh = vb
        outside = [p for p in pts
                   if p[0] < vx - 1 or p[0] > vx + vw + 1 or p[1] < vy - 1 or p[1] > vy + vh + 1]
        frac = len(outside) / len(pts)
        if frac >= 0.25:
            hard.append("约 %.0f%% 的图元画在画布外（viewBox %dx%d），学生看到的会是被裁掉或缺失的图"
                        % (frac * 100, vw, vh))
        elif frac >= 0.10:
            soft.append("有 %.0f%% 的图元超出画布" % (frac * 100))
        xs = [p[0] for p in pts if vx - 1 <= p[0] <= vx + vw + 1]
        ys = [p[1] for p in pts if vy - 1 <= p[1] <= vy + vh + 1]
        if xs and ys and max(xs) - min(xs) < 30 and max(ys) - min(ys) < 30:
            hard.append("全图挤在 %.0fx%.0f 像素的角落里，比例尺明显算错了"
                            % (max(xs) - min(xs), max(ys) - min(ys)))

    leftovers = latex_leftovers(svg)
    if leftovers:
        hard.append("图里有 %d 处公式没排版，会原样印出反斜杠，例如 %s"
                        % (len(leftovers), leftovers[0][:40]))

    leak = _answer_leak(svg, options or {}, correct_answer)
    if leak:
        hard.append(leak)
    return hard, soft


def geometry_issues(svg: str | None, *, options: dict[str, Any] | None = None,
                    correct_answer: str = "") -> list[str]:
    """只要硬伤清单（会让学生看到错图/乱码的那部分）"""
    return inspect_svg(svg, options=options, correct_answer=correct_answer)[0]


def _answer_leak(svg: str, options: Any, correct_answer: str) -> str:
    """配图会被原样印到学生卷面上，正确选项的内容出现在图里就是泄答案"""
    if not options or not correct_answer:
        return ""
    # options 在各条链路里形状不统一：题库是 {"A":…}，前端与部分 prompt 给的是
    # ["A. …", "B. …"]。这里必须两种都吃 —— 传 list 时 .get 会 AttributeError，
    # 而本函数在质量闸里，抛穿的后果是"这张图没被检查就放行了"（2026-11-25 自查发现）。
    if isinstance(options, (list, tuple)):
        letters = "ABCDEF"
        options = {letters[i]: v for i, v in enumerate(options) if isinstance(v, str)}
    elif not isinstance(options, dict):
        return ""
    letters = [k.strip().upper() for k in str(correct_answer).replace(" ", "").split(",") if k.strip()]
    texts = [t.strip() for t in re.findall(r"<text[^>]*>(.*?)</text>", svg or "", re.S)]
    norm = lambda u: re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "", u)
    for letter in letters:
        body = str(options.get(letter) or "").strip()
        if len(body) < 4:
            continue
        nb = norm(body)
        for t in texts:
            nt = norm(t)
            if nb and len(nb) >= 5 and nb in nt:
                return "配图里出现了正确选项 %s 的内容（%s），会泄露答案" % (letter, body[:30])
    return ""
