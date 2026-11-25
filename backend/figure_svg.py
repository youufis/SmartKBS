"""函数图像确定性渲染 —— 让「图」成为「式」的机械投影，而不是模型手写的像素。

为什么必须换架构
----------------
原先的链路让模型直接输出 <circle cx="100" cy="-100"> 这种像素坐标。模型要同时做三件事：
解出函数、定比例尺、再把数学坐标逐个换算成像素并记住「屏幕 y 向下」。第一件它通常做对，
后两件是它结构上不擅长的：

- 2026-11 抽查 4 道数学函数题，3 道画错：y 轴没翻转（(1,-1) 画到 x 轴上方）、
  同一张图里 x 轴比例自相矛盾（-1 画到原点右侧）、抛物线开口方向反了、
  反比例函数只画一支，甚至整条曲线和 y 轴截距点画到 viewBox 之外（学生看到空图）。
- 更隐蔽的一种：模型在解析里写「让我们调整题目数据……构造一个更标准的题目：
  过(0,0),(2,0),(1,-1)」，于是配图描述的是它心里改过的那道题，而题干和答案键还是
  原来那道 —— 图和题干各说各话。

本模块把职责切开：模型只声明数学语义（figure_spec），像素由代码算。渲染器里 y 轴
翻转只发生在一处（PY），比例尺只有一个来源，曲线是对真实函数逐点采样 —— "画错"在
构造上就不可能。唯一剩下的风险是「spec 声明的函数本身不对」，那由 verify_figure()
用题干的数值条件 + 答案选项做交叉验算来兜。

任何一条校验不过就拒绝出图（返回空），而不是出一张错的：最坏情况是没有配图，
绝不会是有一张错的配图被印到试卷上。这是"宁缺勿错"的硬保证。
"""
from __future__ import annotations

import ast
import hashlib
import json
import math
import re
from typing import Any, Callable

from backend.figure_axis import fmt_tick as _fmt_num
from backend.figure_axis import nice_step, ticks
from backend.math_text import render_math

WIDTH_DEFAULT = 600
HEIGHT_DEFAULT = 400
PADDING = 48.0

_FUNCS = {
    "sin": math.sin, "cos": math.cos, "tan": math.tan,
    "asin": math.asin, "acos": math.acos, "atan": math.atan,
    "sinh": math.sinh, "cosh": math.cosh, "tanh": math.tanh,
    "sqrt": math.sqrt, "abs": abs,
    "log": math.log10, "lg": math.log10, "ln": math.log,
    "exp": math.exp, "floor": math.floor, "ceil": math.ceil,
}
_CONSTS = {"pi": math.pi, "e": math.e}


class FigureSpecError(ValueError):
    """figure_spec 不合法，或画出来与题干/答案矛盾 —— 一律拒绝出图"""


# ════════════════════════ 一、表达式：受限求值（绝不裸 eval） ════════════════════════

_ALLOWED_NODES = (
    ast.Expression, ast.BinOp, ast.UnaryOp, ast.Num, ast.Constant, ast.Name,
    ast.Load, ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.USub, ast.UAdd,
    ast.Call,
)


def _needs_star(prev: str, tok: str, names: set[str]) -> bool:
    """相邻两个记号之间要不要补乘号

    要补：``2x``、``3(x-1)``、``(x+1)(x-1)``、``x\u00b7sin``；不补：``sin(``（函数调用）、
    ``**`` 两侧、以及任何一侧还是运算符的情况。隐式乘法是中学解析式的常态写法，
    这里不处理就等于要求模型永远写规范 Python —— 它不会。
    """
    if not prev or not tok:
        return False
    if prev in "([,*/+-=<>":
        return False
    prev_is_operand = (prev[-1].isdigit() or prev[-1] in ")]"
                       or (re.fullmatch(r"[A-Za-z_]\w*", prev) is not None and prev not in names))
    if not prev_is_operand:
        return False
    return tok[0].isalpha() or tok[0] == "(" or tok[0].isdigit()


def _expr_to_python(src: str) -> str:
    """LaTeX / 手写混合格式 -> 可 ast.parse 的表达式

    统一吸收 "y = x^2-2x-1"、"x^2"、"2x"、"3(x-1)^2"、"\\frac{6}{x}"、"\\sin x"、
    "\\sqrt{x}"。模型给的解析式本来就长这样：如果"换个写法就判不认识"，保证就退化成
    看模型心情，那和让它手写像素坐标没有本质区别。

    隐式乘法与函数作用用词法扫描判定，不用正则硬套 —— 正则版会把 "sin x" 补成
    "sin*x"（函数名后绝不能有乘号），也会在括号边界上插错字符。
    """
    text = str(src or "").strip()
    text = text.replace("$", "").replace("\\,", " ").replace("\\;", " ").replace("\\!", "")
    text = text.replace("\\cdot", "*").replace("\\times", "*").replace("\\div", "/")
    text = text.replace("\\left", "").replace("\\right", "")
    text = re.sub(r"\\d?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}", r"((\1)/(\2))", text)
    text = re.sub(r"\\sqrt\s*\{([^{}]*)\}", r"sqrt(\1)", text)
    text = re.sub(r"\\([a-zA-Z]+)", r"\1", text)          # \\sin -> sin（白名单再筛）
    text = text.replace("{", "(").replace("}", ")")
    # 选项里普遍带 "y =" / "f(x) =" 前缀，剥掉后才是关于 x 的表达式
    text = re.sub(r"^\s*(?:[yYuUvVzW]|[fFgGhH]\s*\(\s*[xXtT]\s*\))\s*=\s*", "", text)
    text = text.replace("^", "**")

    names = set(_FUNCS) | set(_CONSTS)
    # 数字必须整体吃掉科学计数法：物理/化学的 6.02e23、9e9、2e-3 是常态写法。
    # 原来只匹配 \d+\.?\d*，"1e8" 被拆成 1 和标识符 e8，报"未知变量 e8"直接拒收
    # （2026-11-25 自查实测）。要求 e 后面必须跟数字，"2e"（2×欧拉数）仍按隐式乘法处理。
    tokens = re.findall(r"\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|[A-Za-z_]\w*|\*\*|\S|\s+", text)
    out: list[str] = []

    def push(tok: str) -> None:
        if out and _needs_star(out[-1], tok, names):
            out.append("*")
        out.append(tok)

    idx = 0
    while idx < len(tokens):
        tok = tokens[idx]
        if tok.isspace():
            idx += 1
            continue
        # \sin x / \cos 2x 是函数作用，不是乘法：把后面这一整段"项"括进参数里，
        # 遇到加减乘除、逗号或右括号才停（sin x + 1 -> sin(x)+1，cos 2x -> cos(2*x)）。
        if re.fullmatch(r"[A-Za-z_]\w*", tok) is not None and tok in _FUNCS:
            j = idx + 1
            while j < len(tokens) and tokens[j].isspace():
                j += 1
            arg: list[str] = []
            while j < len(tokens):
                t = tokens[j]
                if t.isspace():
                    j += 1
                    continue
                if not re.fullmatch(r"[A-Za-z_]\w*|\d+\.?\d*", t):
                    break
                if arg and _needs_star(arg[-1], t, names):
                    arg.append("*")
                arg.append(t)
                j += 1
            if arg:
                push(tok + "(" + "".join(arg) + ")")
                idx = j
                continue
        push(tok)
        idx += 1
    return "".join(out)


def _brief(src: object, limit: int = 60) -> str:
    """报错里只放截断后的原文：模型吐出一段超长表达式时，整段回显会把 422 提示撑爆，
    既没法读也可能把内容原样带到前端日志里。"""
    t = str(src if src is not None else "")
    return t if len(t) <= limit else t[:limit] + "…(%d 字符)" % len(t)


def compile_expr(src: str, var: str = "x") -> Callable[[float], float]:
    """把解析式编译成 f(x)。只放行算术节点与白名单函数名。"""
    text = _expr_to_python(src)
    if not text:
        raise FigureSpecError("表达式为空")
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError as exc:
        raise FigureSpecError("表达式无法解析：%r（%s）" % (_brief(src), exc.msg)) from exc
    for node in ast.walk(tree):
        if not isinstance(node, _ALLOWED_NODES):
            raise FigureSpecError("表达式含不允许的写法 %s：%r" % (type(node).__name__, src))
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in _FUNCS:
                raise FigureSpecError("表达式含未知函数：%r" % _brief(src))
        if (isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)
                and node.id not in _FUNCS and node.id not in _CONSTS and node.id != var):
            raise FigureSpecError("表达式含未知变量 %r：%r" % (node.id, _brief(src)))
    code = compile(tree, "<figure_expr>", "eval")
    env_base = dict(_CONSTS)
    env_base.update(_FUNCS)

    def f(value: float) -> float:
        env = dict(env_base)
        env[var] = value
        return eval(code, {"__builtins__": {}}, env)   # noqa: S307 — 节点已白名单化

    return f


def _function_of(item: dict[str, Any]) -> Callable[[float], float]:
    """spec 里一个函数条目 求值函数（expr 与带系数的 kind 简写都支持）"""
    kind = str(item.get("kind") or item.get("type") or "").strip().lower()
    expr = item.get("expr") or item.get("expression") or item.get("formula")
    if expr:
        return compile_expr(str(expr))
    params = item.get("params") if isinstance(item.get("params"), dict) else item
    try:
        if kind in ("linear", "once"):
            k, b = float(params["k"]), float(params.get("b", 0))
            return lambda x, k=k, b=b: k * x + b
        if kind in ("quadratic", "parabola"):
            a = float(params["a"]); b = float(params.get("b", 0)); c = float(params.get("c", 0))
            return lambda x, a=a, b=b, c=c: a * x * x + b * x + c
        if kind == "vertex":
            a = float(params["a"]); h = float(params["h"]); k = float(params["k"])
            return lambda x, a=a, h=h, k=k: a * (x - h) ** 2 + k
        if kind == "inverse":
            k = float(params["k"])
            return lambda x, k=k: (k / x) if x else float("nan")
    except (KeyError, TypeError, ValueError) as exc:
        raise FigureSpecError("函数 %s 的系数不完整：%s" % (kind, exc)) from exc
    raise FigureSpecError("不支持的函数类型 %r，请改用 expr 写解析式" % kind)


# ════════════════════════ 二、渲染 ════════════════════════

def _on_curve_tol(y: float, span: float = 0.0) -> float:
    """判断"点是否落在曲线上"的容差

    固定 1e-6 太苛刻：模型写 x=3.662 表示 ln9/0.6，f(x) 就差 2.5e-3，正确的图会被
    误拒（2026-11-25 生物 S 型曲线实测就是这样）。按量级放宽到"值或纵幅的千分之五"
    取大者 —— 真正要拦的图文不符偏差都在 1~2 个单位以上，放宽只少误伤、不漏放错图。
    """
    return max(1e-6, abs(y) * 5e-3, abs(span) * 5e-3)


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def render_figure(spec: dict[str, Any], *, width: int = WIDTH_DEFAULT,
                  height: int = HEIGHT_DEFAULT, samples: int = 600) -> str:
    """figure_spec  SVG 源码。任何自检不过抛 FigureSpecError（调用方据此拒收）。

    spec（模型只填数学量，不填任何像素）::

        {"functions": [{"expr": "-x^2+2x-1", "label": "y=ax^2+bx+c",
                        "color": "#1976D2", "dashed": false},
                       {"kind": "inverse", "params": {"k": 6}}],
         "points":    [{"x": 0, "y": -1, "label": "(0, -1)", "on": 0}],
         "x_range": [-1.5, 3.5], "y_range": [-2.5, 1.5], "uniform": true}
    """
    if not isinstance(spec, dict):
        raise FigureSpecError("figure_spec 必须是对象")
    fns = spec.get("functions") or []
    if not isinstance(fns, list) or not fns:
        raise FigureSpecError("figure_spec.functions 为空，无图可画")
    for fn in fns:
        if not isinstance(fn, dict):
            raise FigureSpecError("functions 里存在非对象条目")
    pts = [p for p in (spec.get("points") or []) if isinstance(p, dict)]
    evaluators = [_function_of(fn) for fn in fns]

    # 1) 标注点必须真的落在它声明的曲线上（off_curve 的点除外，比如原点 O、辅助点）
    _span = 0.0
    _yr = spec.get("y_range")
    if isinstance(_yr, (list, tuple)) and len(_yr) == 2:
        try:
            _span = abs(float(_yr[1]) - float(_yr[0]))
        except (TypeError, ValueError):
            _span = 0.0
    for p in pts:
        try:
            pxx, pyy = float(p["x"]), float(p["y"])
        except (KeyError, TypeError, ValueError) as exc:
            raise FigureSpecError("关键点缺少数值坐标：%s" % p) from exc
        if p.get("off_curve"):
            continue
        on = p.get("on")
        idxs = range(len(evaluators)) if on in (None, "any", True) else [int(on)]
        tol = _on_curve_tol(pyy, _span)
        for i in idxs:
            try:
                if abs(evaluators[i](pxx) - pyy) <= tol:
                    break
            except (ZeroDivisionError, ValueError, OverflowError):
                continue
        else:
            raise FigureSpecError(
                "关键点 (%g, %g) 不在任何一条曲线上 —— 题干给定点与解析式矛盾，拒绝出图"
                % (pxx, pyy))

    # 2) 视窗自动含住所有关键点
    xs = [float(p["x"]) for p in pts]
    ys = [float(p["y"]) for p in pts]
    def _range(key: str, fallback: list) -> list:
        raw = spec.get(key)
        if not isinstance(raw, (list, tuple)) or len(raw) != 2:
            raw = fallback
        try:
            lo, hi = float(raw[0]), float(raw[1])
        except (TypeError, ValueError) as exc:
            raise FigureSpecError("%s 必须是两个数字，收到 %r（%s）"
                                  % (key, raw, exc)) from exc
        return [lo, hi]

    xr = _range("x_range", [-4, 4] if not xs else [min(xs) - 1, max(xs) + 1])
    yr = _range("y_range", [-4, 4] if not ys else [min(ys) - 1, max(ys) + 1])
    x0, x1 = xr[0], xr[1]
    y0, y1 = yr[0], yr[1]
    if not (x1 > x0 and y1 > y0):
        raise FigureSpecError("坐标范围非法")
    if x1 - x0 < 2:
        x0, x1 = x0 - 1, x1 + 1
    if y1 - y0 < 2:
        y0, y1 = y0 - 1, y1 + 1
    step_x = nice_step(x1 - x0)
    step_y = nice_step(y1 - y0)
    x0 = math.floor(x0 / step_x) * step_x
    x1 = math.ceil(x1 / step_x) * step_x
    y0 = math.floor(y0 / step_y) * step_y
    y1 = math.ceil(y1 / step_y) * step_y

    # 3) 比例尺只有一个来源。
    #    函数图像默认**两轴各自定标**：x 与 y 通常是两个量纲（时间/温度 vs 数量/溶解度），
    #    强行 1:1 会把 x 轴撑到 -100~125 这种荒谬范围，把有意义区间挤成一小段
    #    （2026-11-25 生物 S 型曲线实测就是这样）。等比是几何图的刚需（角度不能歪），
    #    那边由 figure_shapes.render_geometry 单独保证。
    #    需要等比时（如反比例函数要看出两支对称）在 spec 里显式写 "uniform": true。
    inner_w, inner_h = width - 2 * PADDING, height - 2 * PADDING
    sx, sy = inner_w / (x1 - x0), inner_h / (y1 - y0)
    if spec.get("uniform", False):
        s_uniform = min(sx, sy)
        # 等比时把范围撑满画布（否则图只占一角、四周大片留白），
        # 但**扩完范围必须按新跨度重算刻度步长** —— 沿用旧步长会画出几十条刻度糊成一团。
        want_x, want_y = inner_w / s_uniform, inner_h / s_uniform
        if (x1 - x0) < want_x:
            cx = (x0 + x1) / 2.0
            x0, x1 = cx - want_x / 2.0, cx + want_x / 2.0
        if (y1 - y0) < want_y:
            cy = (y0 + y1) / 2.0
            y0, y1 = cy - want_y / 2.0, cy + want_y / 2.0
        step_x = nice_step(x1 - x0)
        step_y = nice_step(y1 - y0)
        x0 = math.floor(x0 / step_x) * step_x
        x1 = math.ceil(x1 / step_x) * step_x
        y0 = math.floor(y0 / step_y) * step_y
        y1 = math.ceil(y1 / step_y) * step_y
        sx = sy = min(inner_w / (x1 - x0), inner_h / (y1 - y0))
    ox = PADDING - x0 * sx
    oy = PADDING + y1 * sy                 # y=0 这条线的像素高度

    def PX(v: float) -> float:
        return ox + v * sx

    def PY(v: float) -> float:
        return oy - v * sy                 # 全图唯一一次 y 轴翻转

    for p in pts:
        if not (x0 - 1e-9 <= float(p["x"]) <= x1 + 1e-9 and y0 - 1e-9 <= float(p["y"]) <= y1 + 1e-9):
            raise FigureSpecError("关键点 (%g, %g) 落在坐标范围外" % (float(p["x"]), float(p["y"])))

    # clipPath 的 id 必须每张图唯一：一张试卷里会有多张图，SVG 的 id 在同一个 DOM
    # 里是全局的，都叫 "plot" 时后一张的 clip-path 会指到第一张的矩形上。
    sig = "%.4f,%.4f,%.4f,%.4f|" % (x0, x1, y0, y1)
    for _fn in fns:
        sig += "%s|%s|" % (_fn.get("expr") or _fn.get("kind") or "",
                             _fn.get("label") or "")
    clip_id = "fig" + hashlib.md5(sig.encode("utf-8")).hexdigest()[:10]
    out = ['<svg viewBox="0 0 %d %d" xmlns="http://www.w3.org/2000/svg" '
           'font-family="Microsoft YaHei, PingFang SC, Arial, sans-serif">' % (width, height),
           '<defs><clipPath id="%s"><rect x="%.2f" y="%.2f" width="%.2f" height="%.2f"/>'
           '</clipPath></defs>' % (clip_id, PADDING - 3, PADDING - 3, inner_w + 6, inner_h + 6),
           '<rect width="%d" height="%d" fill="#ffffff"/>' % (width, height)]

    # 4) 网格
    grid = ['<g stroke="#e9eef4" stroke-width="1">']
    for v in ticks(x0, x1, step_x):
        grid.append('<line x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f"/>'
                    % (PX(v), PY(y1), PX(v), PY(y0)))
    for v in ticks(y0, y1, step_y):
        grid.append('<line x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f"/>'
                    % (PX(x0), PY(v), PX(x1), PY(v)))
    out.append("".join(grid) + "</g>")

    # 5) 坐标轴、箭头、轴名
    out.append('<g stroke="#333" stroke-width="1.6">'
               '<line x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f"/>'
               '<line x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f"/></g>'
               % (PX(x0), PY(0), PX(x1), PY(0), PX(0), PY(y0), PX(0), PY(y1)))
    out.append('<g fill="#333">'
               '<polygon points="%.2f,%.2f %.2f,%.2f %.2f,%.2f"/>'
               '<polygon points="%.2f,%.2f %.2f,%.2f %.2f,%.2f"/></g>'
               % (PX(x1), PY(0), PX(x1) - 9, PY(0) - 4.5, PX(x1) - 9, PY(0) + 4.5,
                  PX(0), PY(y1), PX(0) - 4.5, PY(y1) + 9, PX(0) + 4.5, PY(y1) + 9))
    out.append('<text x="%.2f" y="%.2f" font-size="15" font-style="italic">x</text>'
               % (PX(x1) + 6, PY(0) + 5))
    out.append('<text x="%.2f" y="%.2f" font-size="15" font-style="italic">y</text>'
               % (PX(0) - 6, PY(y1) - 10))
    # 6) 刻度（学生要能从图上读数，题目才成立）
    tick_markup = ['<g font-size="12" fill="#555">']
    for v in ticks(x0, x1, step_x):
        if abs(v) > 1e-9:
            tick_markup.append('<line x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f" stroke="#333" '
                               'stroke-width="1.2"/>' % (PX(v), PY(0) - 4, PX(v), PY(0) + 4))
            tick_markup.append('<text x="%.2f" y="%.2f" text-anchor="middle">%s</text>'
                               % (PX(v), PY(0) + 18, _fmt_num(v, step_x)))
    for v in ticks(y0, y1, step_y):
        if abs(v) > 1e-9:
            tick_markup.append('<line x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f" stroke="#333" '
                               'stroke-width="1.2"/>' % (PX(0) - 4, PY(v), PX(0) + 4, PY(v)))
            tick_markup.append('<text x="%.2f" y="%.2f" text-anchor="end">%s</text>'
                               % (PX(0) - 8, PY(v) + 4, _fmt_num(v, step_y)))
    tick_markup.append('<text x="%.2f" y="%.2f" text-anchor="end">O</text>'
                       % (PX(0) - 7, PY(0) + 17))
    out.append("".join(tick_markup) + "</g>")


    # 7) 曲线：逐点采样 + 断点自动断开（渐近线两侧不能连成竖线）
    for fn, ev in zip(fns, evaluators):
        color = str(fn.get("color") or "#1976D2")
        dash = ' stroke-dasharray="6,4"' if fn.get("dashed") else ""
        segs: list[list] = []
        cur: list = []
        prev: float | None = None
        for i in range(samples + 1):
            xv = x0 + (x1 - x0) * i / samples
            try:
                yv = float(ev(xv))
            except (ZeroDivisionError, ValueError, OverflowError):
                yv = float("nan")
            inside = math.isfinite(yv) and y0 - 1e-9 <= yv <= y1 + 1e-9
            jump = inside and prev is not None and abs(yv - prev) > (y1 - y0) * 0.5
            if not inside or jump:
                if len(cur) > 1:
                    segs.append(cur)
                cur = []
            if inside:
                cur.append((PX(xv), PY(yv)))
                prev = yv
            else:
                prev = yv if math.isfinite(yv) else None
        if len(cur) > 1:
            segs.append(cur)
        if not segs:
            raise FigureSpecError("曲线在该坐标范围内不可见（函数无定义或完全出界）")
        for seg in segs:
            out.append('<path clip-path="url(#%s)" d="M %s" fill="none" stroke="%s" '
                       'stroke-width="2.4"%s/>'
                       % (clip_id, " L ".join("%.2f,%.2f" % q for q in seg), color, dash))
        if fn.get("label"):
            # 标签走公式排版：$y=\frac{6}{x}$ 这种要真画出分数，不能把反斜杠印到卷子上。
            # 放在离 y 轴远的那一侧：y 轴在左半幅时标签靠右，否则靠左 —— 否则会压住
            # y 轴箭头（实测 x0<0 的图全都撞在一起）。
            left_side = PX(0) > (PX(x0) + PX(x1)) / 2.0
            out.append(render_math(str(fn["label"]),
                                   x=(PX(x0) + 12 if left_side else PX(x1) - 12),
                                   y=PADDING + 18, size=13.5,
                                   anchor="start" if left_side else "end", fill=color))

    # 8) 关键点：虚线引导 + 圆点 + 标签
    for p in pts:
        xv, yv = float(p["x"]), float(p["y"])
        color = str(p.get("color") or "#d32f2f")
        if p.get("guide", True):
            out.append('<g stroke="#9aa7b4" stroke-width="1" stroke-dasharray="4,4">'
                       '<line x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f"/>'
                       '<line x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f"/></g>'
                       % (PX(xv), PY(yv), PX(xv), PY(0), PX(xv), PY(yv), PX(0), PY(yv)))
        out.append('<circle cx="%.2f" cy="%.2f" r="4" fill="%s"/>' % (PX(xv), PY(yv), color))
        label = str(p.get("label") or "(%s, %s)" % (_fmt_num(xv, 1), _fmt_num(yv, 1)))
        anchor = "start" if xv >= 0 else "end"
        out.append(render_math(label, x=PX(xv) + (9 if xv >= 0 else -9),
                               y=PY(yv) + (-10 if yv >= 0 else 21),
                               size=13, anchor=anchor, fill="#333"))
    out.append("</svg>")
    return "".join(out)

# ════════════════════════ 三、交叉验算（图 / 题干 / 答案键 三者必须一致） ════════════════════════

_PAIR_RE = re.compile(r"\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)")
#: 题干里出现这些词时，紧跟的坐标点被断言"在图象上"，图上必须画过它
_ON_GRAPH_WORDS = ("经过", "过点", "过", "交于", "交", "顶点", "切于", "在图象上", "在图像上", "位于")
_ANSWER_RE = re.compile(r"^\s*(?:[yYuUvVzW]|[fFgGhH]\s*\(\s*[xXtT]\s*\))\s*=\s*")


def _stem_pairs(question_text: str) -> list[tuple[float, float, bool]]:
    """从题干取坐标点，并标注它是否被断言在图象上（看前 14 个字符里有没有关键词）"""
    text = re.sub(r"\$|\\[a-zA-Z]+|[{}]", " ", str(question_text or ""))
    pairs: list[tuple[float, float, bool]] = []
    for m in _PAIR_RE.finditer(text):
        try:
            x, y = float(m.group(1)), float(m.group(2))
        except ValueError:
            continue
        before = text[max(0, m.start() - 14):m.start()]
        pairs.append((x, y, any(w in before for w in _ON_GRAPH_WORDS)))
    return pairs


def _safe(f, x: float) -> float:
    try:
        return float(f(x))
    except (ZeroDivisionError, ValueError, OverflowError, TypeError):
        return float("nan")


def _passes(evaluators: list, x: float, y: float, tol: float | None = None) -> bool:
    """曲线是否经过该点；容差按量级自适应（见 _on_curve_tol）"""
    limit = tol if tol is not None else _on_curve_tol(y)
    for ev in evaluators:
        try:
            if abs(float(ev(x)) - y) <= limit:
                return True
        except (ZeroDivisionError, ValueError, OverflowError, TypeError):
            continue
    return False


def verify_figure(spec: dict[str, Any], *, question_text: str = "",
                  options: dict[str, Any] | None = None,
                  correct_answer: str = "") -> list[str]:
    """返回问题清单；空列表 = 图与题干/答案自洽，可以入库。

    这一层是"spec 本身声明错了"的兜底。渲染器保证**图 = spec**，但保证不了
    **spec = 题干**，而历史上出错的恰恰是后者（模型在解析里自己改了题目数据，
    配图按改后的画，题干按改前的存）。这里用题干里的数值条件去验 spec，
    再用选项反查答案键，两边一夹，图与题干不符、答案键写错都会被拦下。
    """
    problems: list[str] = []
    fns = spec.get("functions") or []
    if not isinstance(fns, list) or not fns:
        return ["figure_spec.functions 为空"]
    try:
        evaluators = [_function_of(fn) for fn in fns if isinstance(fn, dict)]
    except FigureSpecError as exc:
        return [str(exc)]
    if not evaluators:
        return ["figure_spec 里没有可用的函数"]

    # ── A. 题干声明在图象上的点，曲线必须真的经过 ──
    pairs = _stem_pairs(question_text)
    asserted = [(x, y) for x, y, on in pairs if on]
    for x, y in asserted:
        if not _passes(evaluators, x, y):
            problems.append("题干声明图象经过 (%g, %g)，但配图的解析式算出来不是这个值" % (x, y))
    if pairs and not asserted and not any(_passes(evaluators, x, y) for x, y, _ in pairs):
        problems.append("配图曲线不经过题干里出现的任何一个坐标点，疑似图文不符")

    # ── B. 反比例函数必须两支都可见（学生要能看出图象分布在哪些象限）──
    for fn in fns:
        if isinstance(fn, dict) and str(fn.get("kind") or fn.get("type") or "").lower() == "inverse":
            if float(fn.get("params", {}).get("k", 0) if isinstance(fn.get("params"), dict)
                     else fn.get("k", 0)) != 0:
                xr = spec.get("x_range")
                if xr and len(xr) == 2 and (float(xr[0]) > 0 or float(xr[1]) < 0):
                    problems.append("反比例函数图象被裁到只剩一个象限，x 范围应跨过 0")

    # ── C. 图必须等于正确答案那条解析式；顺带验答案键本身对不对 ──
    if options and correct_answer:
        exprs: dict[str, Callable[[float], float]] = {}
        for key, val in (options.items() if isinstance(options, dict) else []):
            # 选项在库里是 "$y = x^2 - 2x - 1$" 这种带 $ 的 LaTeX，先剥掉定界符再判前缀，
            # 否则 ^\s*[yY]\s*= 永远匹配不上，整段选项交叉验算会被静默跳过
            # （2026-11-25 真实链路验证就是这样漏掉了模型给的 x^2-1）。
            text = str(val or "").replace("$", "").strip()
            if not text or not _ANSWER_RE.search(text):
                continue
            try:
                exprs[str(key).strip().upper()] = compile_expr(text)
            except FigureSpecError:
                continue
        if exprs:
            probes = [-3.7, -1.3, 0.6, 1.9, 2.4, 5.1]

            def same(f, g) -> bool:
                """两条解析式是否恒等：逐点代入，只要有一次不等就判不同"""
                total = agree = 0
                for q in probes:
                    try:
                        a, b = float(f(q)), float(g(q))
                    except (ZeroDivisionError, ValueError, OverflowError):
                        continue
                    if not (math.isfinite(a) and math.isfinite(b)):
                        continue
                    total += 1
                    if abs(a - b) <= 1e-6:
                        agree += 1
                return total >= 3 and agree == total

            drawn_match = [k for k, g in exprs.items() if any(same(ev, g) for ev in evaluators)]
            if not drawn_match:
                problems.append("配图解析式与四个选项都不相符（图与题干/选项脱节）")

            letters = [k for k in str(correct_answer).upper().replace(" ", "").split(",")
                       if k in exprs]
            if letters:
                target = exprs[letters[0]]
                if not any(same(ev, target) for ev in evaluators):
                    problems.append(
                        "配图与正确答案选项 %s 的解析式不一致（配图实际画的是 %s）"
                        % (letters[0], "/".join(drawn_match) or "无匹配选项"))

            # 答案键自检：能同时满足题干所有"在图象上"的点的选项，才是真答案。
            # 2304 就是靠这条抓出来的 —— 键写 A，但只有 C 过 (0,-1) 和 (1,0)。
            # 标注泄答案检查：函数名标注/点标注里出现正确选项那条解析式，图就不能要
            if letters:
                target_text = _ANSWER_RE.sub("", str(options.get(letters[0]) or "")
                                             .replace("$", "")).replace(" ", "")
                labels = [str(f.get("label") or "") for f in fns if isinstance(f, dict)]
                labels += [str(p.get("label") or "") for p in (spec.get("points") or [])
                           if isinstance(p, dict)]
                for lab in labels:
                    nl = _ANSWER_RE.sub("", str(lab).replace("$", "")).replace(" ", "")
                    if len(nl) >= 5 and nl == target_text:
                        problems.append("配图标注 %r 就是正确选项 %s 的解析式，会泄露答案"
                                        % (str(lab)[:30], letters[0]))
                        break

            if asserted and len(exprs) >= 2:
                fits = [k for k, g in exprs.items()
                        if all(abs(float(g(x)) - y) <= _on_curve_tol(y) for x, y in asserted
                               if math.isfinite(_safe(g, x)))]
                if len(fits) == 1 and letters and fits[0] != letters[0]:
                    problems.append(
                        "答案键疑误：按题干条件应为 %s，当前记为 %s" % (fits[0], letters[0]))

    return problems

def spec_from_answer(spec: dict[str, Any], *, question_text: str,
                     options: dict[str, Any], correct_answer: str) -> dict[str, Any] | None:
    """模型给的 spec 与题干矛盾时，改用"正确答案那条解析式"重建 spec。

    为什么该做这一步：这类题的图本来就由题干的数值条件唯一确定，画出来不比题干多泄露
    答案；而模型给错 spec（实测会把过 (0,-1),(1,0)、对称轴 x=1 的抛物线写成选项 A 的
    x^2-2x-1）时，直接拒收只会让老师看到一张空配图。正确答案的表达式是现成的、可靠的，
    拿它重建 spec 就能把"拒收"变成"一张对的图"。

    只有在**正确答案确实满足题干所有"在图象上"的点**时才重建 —— 否则说明答案键本身
    与题干矛盾（#2304 原始状态：键写 A、解析算出 C），那种情况必须继续拒收并把矛盾报出来，
    绝不能拿一个错答案去画图。
    """
    if not options or not correct_answer:
        return None
    letters = [k.strip().upper() for k in str(correct_answer).replace(" ", "").split(",")]
    expr_text = ""
    for letter in letters:
        for key, val in options.items():
            if str(key).strip().upper() == letter:
                cand = str(val or "").replace("$", "").strip()
                if _ANSWER_RE.search(cand):
                    expr_text = cand
                    break
        if expr_text:
            break
    if not expr_text:
        return None
    try:
        ev = compile_expr(expr_text)
    except FigureSpecError:
        return None

    asserted = [(x, y) for x, y, on in _stem_pairs(question_text) if on]
    if asserted:
        if not all(abs(float(_safe(ev, x)) - y) <= _on_curve_tol(y) for x, y in asserted):
            return None          # 答案键与题干矛盾，不重建
        points = [{"x": x, "y": y} for x, y in asserted]
    else:
        points = []

    # 标签不能照抄：模型给的 label 往往就是它那条错解析式（实测画 x^2-2x-1 的图、
    # label 也写 y=x^2-2x-1）。重建曲线后还留着旧标签，等于在卷面上印一条和曲线
    # 矛盾的公式；要是它正好等于正确选项，还顺带泄了答案。
    # 规则：能编译成 x 的表达式且与纠正后的解析式恒等 -> 保留；编译不过（"y=ax^2+bx+c"
    # 这种一般式，正是这类题该显示的中性标注）-> 保留；其余丢弃。
    old_fns = spec.get("functions") if isinstance(spec, dict) else None
    label = ""
    if isinstance(old_fns, list) and old_fns and isinstance(old_fns[0], dict):
        raw_label = str(old_fns[0].get("label") or "")
        if raw_label:
            try:
                lv = compile_expr(raw_label)
                agree = all(abs(float(lv(q)) - float(ev(q))) < 1e-6
                            for q in (0.37, 1.13, 2.41, -0.83, -2.19)
                            if math.isfinite(lv(q)) and math.isfinite(ev(q)))
                label = raw_label if agree else ""
            except FigureSpecError:
                label = raw_label
    repaired: dict[str, Any] = {
        "functions": [{"expr": expr_text, "label": label}],
        "points": points,
    }
    if isinstance(spec, dict):
        for k in ("x_range", "y_range", "uniform"):
            if k in spec:
                repaired[k] = spec[k]
    return repaired



def _strip_leaking_labels(spec: dict[str, Any], options: dict[str, Any],
                          correct_answer: str) -> dict[str, Any] | None:
    """去掉等于正确选项解析式的标注（"y=6/x" 这种），其余标注原样保留"""
    letters = [k.strip().upper() for k in str(correct_answer or "").replace(" ", "").split(",")]
    if not letters or not isinstance(options, dict):
        return None
    target = ""
    for key, val in options.items():
        if str(key).strip().upper() == letters[0]:
            target = _ANSWER_RE.sub("", str(val or "").replace("$", "")).replace(" ", "")
            break
    if len(target) < 5:
        return None

    def norm(label: str) -> str:
        return _ANSWER_RE.sub("", str(label or "").replace("$", "")).replace(" ", "")

    new_spec = json.loads(json.dumps(spec, ensure_ascii=False)) if spec else None
    if not isinstance(new_spec, dict):
        return None
    stripped = False
    for fn in (new_spec.get("functions") or []):
        if isinstance(fn, dict) and norm(fn.get("label") or "") == target:
            fn.pop("label", None)
            stripped = True
    for pt in (new_spec.get("points") or []):
        if isinstance(pt, dict) and norm(pt.get("label") or "") == target:
            pt.pop("label", None)
            stripped = True
    return new_spec if stripped else None


def repair_spec(spec: dict[str, Any], *, question_text: str, options: dict[str, Any],
                correct_answer: str) -> tuple[dict[str, Any] | None, str]:
    """spec 有问题时依次尝试三种修法，返回 (可用的 spec, 做了什么) 或 (None, "")

    为什么要修而不是直接拒：模型给错解析式、把答案写进标注，都是这类题的常见错法；
    而"正确的图"其实完全可以从题干和答案键推出来。直接拒收只会让老师看到一张空配图，
    以为功能坏了。修不动的（答案键本身与题干矛盾）才真的拒 —— 那时报的原因是有用的。
    """
    base_kwargs = {"question_text": question_text, "options": options,
                   "correct_answer": correct_answer}
    if not isinstance(spec, dict):
        return None, ""
    if not verify_figure(spec, **base_kwargs):
        return spec, ""
    tries: list[tuple[dict[str, Any], str]] = []
    rebuilt = spec_from_answer(spec, **base_kwargs)
    if rebuilt is not None:
        tries.append((rebuilt, "按正确答案解析式重建曲线"))
        deleaked = _strip_leaking_labels(rebuilt, options, correct_answer)
        if deleaked is not None:
            tries.append((deleaked, "按正确答案解析式重建曲线，并去掉泄露答案的标注"))
    deleaked = _strip_leaking_labels(spec, options, correct_answer)
    if deleaked is not None:
        tries.append((deleaked, "去掉泄露答案的标注"))
    for cand, action in tries:
        if not verify_figure(cand, **base_kwargs):
            return cand, action
    return None, ""

# ════════════════════════ 四、拒收原因分诊 ════════════════════════

#: 属于"题目本身自相矛盾"的关键词 —— 这类要老师去改题干/答案键
_DATA_CONFLICT_MARKS = ("答案键", "与四个选项都不相符", "与正确答案选项")
#: 属于"模型没能表达出来"的关键词 —— 这类题目是对的，重试或换图型就行，
#: 提示"请修正题目数据"会把老师引向完全错误的方向（2026-11-25 跨学科实测就是这样）
_MODEL_FAILURE_MARKS = ("不在任何一条曲线上", "不支持的函数类型", "表达式", "不可见",
                        "无图可画", "缺少数值坐标", "暂不支持", "系数不完整",
                        "落在坐标范围外", "不是对象", "必须是对象", "题干声明图象经过")


def classify_problems(problems: list[str]) -> str:
    """把验算问题分成 data_conflict / model_failure / unknown

    分诊的价值：让"题目错了"和"模型没画好"在提示语上彻底分开。前者必须改题，
    后者重试即可 —— 混在一起说，老师会去改本来正确的题干，把对的题改坏。
    """
    if not problems:
        return "ok"
    text = "；".join(problems)
    if any(m in text for m in _DATA_CONFLICT_MARKS):
        return "data_conflict"
    if any(m in text for m in _MODEL_FAILURE_MARKS):
        return "model_failure"
    return "unknown"

