"""图内公式渲染 —— 把 LaTeX 片段画成**任何渲染器都认**的原生 SVG 图元。

为什么需要这个模块
----------------
AI 生成的 SVG 里，公式一直是重灾区。2026-11 抽查全库 242 张配图，21 张把裸 LaTeX
原样塞进 <text>：``$R_1$``、``$2^7$``、``$\\Delta t$``、``$$Risk = Threat \\times
Vulnerability$$``。浏览器和 cairosvg 都不解析 LaTeX，于是学生和试卷上看到的就是这串
字面反斜杠 —— 图本身没错，但公式全是乱码。另有模型把 ``V_{CC}`` 拆成
``V``/``cc`` 两个 <text> 硬凑下标，位置全靠猜，排版更乱。

实测过 6 种排版手法在 cairosvg（试卷导出用的光栅器）下的真实表现，据此选定：
- **用** ``<tspan font-size dy>`` 做上下标（渲染正确，浏览器同样正确）；
- **用** 堆叠 ``<text>`` + 横线画分数；
- **用** Unicode 希腊字母与运算符（Δ θ Ω μ × → ≤ ≈ 都有字形）；
- **不用** ``baseline-shift`` —— cairosvg 直接忽略它，``x\u00b2`` 会退化成 ``X2``；
- **不用** Unicode 上标字符（\u2070-\u2089）—— 常见字体只有 \u00b9\u00b2\u00b3，``R\u2081`` 是豆腐块。

对外两个入口：:func:`render_math` 给确定性渲染器标注用；:func:`mathify_svg` 是个
后置清洗步骤，把任何来源（包括模型手绘的电路图、流程图）``<text>`` 里的 LaTeX 就地
换成原生图元，让"公式显示正常"不再取决于模型当时有没有想起来要转义。
"""
from __future__ import annotations

import re

#: LaTeX 命令 -> Unicode。图里出现的量符基本都在这张表内。
_SYMBOLS = {
    "alpha": "\u03b1", "beta": "\u03b2", "gamma": "\u03b3", "delta": "\u0394",
    "Delta": "\u0394", "epsilon": "\u03b5", "varepsilon": "\u03b5", "zeta": "\u03b6",
    "eta": "\u03b7", "theta": "\u03b8", "Theta": "\u0398", "lambda": "\u03bb",
    "Lambda": "\u039b", "mu": "\u03bc", "nu": "\u03bd", "pi": "\u03c0", "Pi": "\u03a0",
    "rho": "\u03c1", "sigma": "\u03c3", "Sigma": "\u03a3", "tau": "\u03c4",
    "phi": "\u03c6", "varphi": "\u03c6", "chi": "\u03c7", "psi": "\u03c8",
    "omega": "\u03c9", "Omega": "\u03a9",
    "times": "\u00d7", "div": "\u00f7", "cdot": "\u00b7", "pm": "\u00b1", "mp": "\u2213",
    "approx": "\u2248", "neq": "\u2260", "ne": "\u2260", "leq": "\u2264", "le": "\u2264",
    "geq": "\u2265", "ge": "\u2265", "infty": "\u221e", "propto": "\u221d",
    "rightarrow": "\u2192", "to": "\u2192", "Rightarrow": "\u21d2", "leftarrow": "\u2190",
    "uparrow": "\u2191", "downarrow": "\u2193", "perp": "\u22a5", "parallel": "\u2225",
    "angle": "\u2220", "triangle": "\u25b3", "odot": "\u2299", "oplus": "\u2295",
    "circ": "\u25e6", "degree": "\u00b0", "Celsius": "\u2103", "percent": "%",
    "sqrt": "\u221a", "prime": "\u2032", "ldots": "\u2026", "cdots": "\u22ef",
    "langle": "\u2329", "rangle": "\u232a", "overline": "", "triangleleft": "\u25c1",
}

#: 只影响排版的命令，直接吃掉
_DROPPED = {"left", "right", ",", ";", "!", ":", "quad", "qquad", "mathrm", "text",
            "mathbf", "operatorname", "displaystyle", "tfrac", "limits"}

_SUB_RATIO = 0.72
_SUB_DY = 0.30
_SUP_DY = -0.42


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _unesc(s: str) -> str:
    return (s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
             .replace("&quot;", '"').replace("&#39;", "'"))


def has_math(src: str) -> bool:
    """这段文字是不是需要排版的公式（含 $ 包裹、LaTeX 命令、裸上下标写法）"""
    if not src:
        return False
    t = src.strip()
    if "$" in t or "\\(" in t or "\\[" in t:
        return True
    if re.search(r"\\[a-zA-Z]+", t):
        return True
    # 下划线前必须是字母/右括号，不能是数字：否则 10_000、2_5（千分位写法）会被
    # 当成公式，排成"10 下标 000"（2026-11-25 自查实测到的误判）
    if re.search(r"[A-Za-z})]_\{?[A-Za-z0-9+\-]", t):       # R_1, U_CE, x_0^2
        return True
    if re.search(r"[A-Za-z0-9)]\^(\{?[A-Za-z0-9+\-]|\\)", t):
        return True
    return False


# ════════════════════════ 一、解析成排版树 ════════════════════════

def _strip_delims(src: str) -> str:
    """吃掉公式定界符：``$...$`` / ``$$...$$`` / ``\\(..\\)`` / ``\\[..\\]``

    ``$`` 可能出现在句中（``时间间\u9694 $\\\\triangle t$``、``\u5206\u8fa8\u7387: $1024 \\\\times 800$``），
    所以必须全局清掉，只处理首尾会留下半截乱码。真正的美元符号模型会写 ``\\$``，
    先占位保护、最后再还原。
    """
    t = str(src or "").replace("\\$", "\x02")
    t = t.replace("$", "")
    t = re.sub(r"\\\(|\\\)|\\\[|\\\]", "", t)
    t = t.replace("\x02", "$")
    return t.strip()


def _tokenize(src: str) -> list:
    """-> 线性节点列表：("run", text) / ("sup", nodes) / ("sub", nodes) / ("frac", n, d)"""
    nodes: list = []
    buf = ""

    def flush():
        nonlocal buf
        if buf:
            nodes.append(("run", buf))
            buf = ""

    i, n = 0, len(src)
    while i < n:
        ch = src[i]
        if ch == "\\":
            m = re.match(r"\\([a-zA-Z]+|[,;!:])", src[i:])
            if not m:
                buf += ch
                i += 1
                continue
            cmd = m.group(1)
            i += m.end()
            if cmd.isalpha():
                # LaTeX 里 \mu A 的空格只是命令名分隔符，不是真空格
                while i < n and src[i] in " 	":
                    i += 1
            if cmd in _DROPPED:
                # \frac{a}{b} / \sqrt{a} / \overline{a} 由下面带参数的分支处理
                continue
            if cmd == "frac" or cmd == "dfrac" or cmd == "tfrac":
                num = _grab_group(src, i); i = num[1]
                den = _grab_group(src, i); i = den[1]
                flush()
                nodes.append(("frac", _tokenize(num[0]), _tokenize(den[0])))
                continue
            if cmd == "sqrt":
                arg = _grab_group(src, i); i = arg[1]
                flush()
                nodes.append(("run", "\u221a"))
                nodes.extend(_tokenize(arg[0]))
                continue
            if cmd == "overline":
                arg = _grab_group(src, i); i = arg[1]
                flush()
                nodes.append(("over", _tokenize(arg[0])))
                continue
            if cmd in ("Delta", "theta"):
                flush(); buf = _SYMBOLS.get(cmd, cmd); flush(); continue
            if cmd in _SYMBOLS:
                buf += _SYMBOLS[cmd]
            else:
                buf += cmd          # 未知命令：留下名字，至少不是反斜杠乱码
            continue
        if ch in "^_":
            flush()
            i += 1
            if i < n and src[i] == "{":
                arg = _grab_group(src, i); i = arg[1]
            else:
                mm = re.match(r"([A-Za-z0-9+\-\u0391-\u03c9])", src[i:])
                if not mm:
                    buf += ch
                    continue
                arg = (mm.group(1), i + mm.end())
                i = arg[1]
                nodes.append((ch, _tokenize(mm.group(1))))
                continue
            nodes.append((ch, _tokenize(arg[0])))
            continue
        if ch in "{}":
            i += 1
            continue
        buf += ch
        i += 1
    flush()
    return nodes


def _grab_group(src: str, i: int) -> tuple[str, int]:
    """从位置 i 取一个 {…} 组（允许一层嵌套），返回 (内容, 新位置)"""
    n = len(src)
    while i < n and src[i] in " \t":
        i += 1
    if i >= n:
        return "", i
    if src[i] != "{":
        m = re.match(r"(\S)", src[i:])
        return (m.group(1), i + 1) if m else ("", i)
    depth = 0
    start = i
    while i < n:
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return src[start + 1:i], i + 1
        i += 1
    return src[start + 1:], n


# ════════════════════════ 二、排版（估算宽度 + 绝对定位） ════════════════════════

def _char_w(ch: str, size: float) -> float:
    o = ord(ch)
    if o >= 0x2E80:                      # CJK / 全角
        return size
    if ch in "iljt.,:;'|!()[] ":
        return size * 0.32
    if ch.isupper() or ch in "\u0391\u0392\u0393\u0394\u0398\u03a9":
        return size * 0.68
    return size * 0.55


def _run_width(nodes: list, size: float) -> float:
    total = 0.0
    for node in nodes:
        kind = node[0]
        if kind == "run":
            total += sum(_char_w(c, size) for c in node[1])
        elif kind in ("^", "_"):
            total += _run_width(node[1], size * _SUB_RATIO)
        elif kind == "frac":
            total += max(_run_width(node[1], size * 0.85), _run_width(node[2], size * 0.85)) + size * 0.3
        elif kind == "over":
            total += _run_width(node[1], size)
    return total


class _Emitter:
    def __init__(self, size: float, fill: str, family: str):
        self.size = size
        self.fill = fill
        self.family = family
        self.parts: list[str] = []

    def text(self, x: float, y: float, s: str, size: float) -> None:
        self.parts.append('<text x="%.2f" y="%.2f" font-size="%.2f" fill="%s" '
                          'font-family="%s">%s</text>' % (x, y, size, self.fill, self.family, _esc(s)))

    def emit_nodes(self, x: float, y: float, nodes: list, size: float) -> float:
        """把节点画在 (x, y) 基线上，返回新的 x"""
        for node in nodes:
            kind = node[0]
            if kind == "run":
                w = sum(_char_w(c, size) for c in node[1])
                self.text(x, y, node[1], size)
                x += w
            elif kind == "^":
                sub = size * _SUB_RATIO
                x += size * 0.06
                x = self.emit_nodes(x, y + size * _SUP_DY, node[1], sub)
            elif kind == "_":
                sub = size * _SUB_RATIO
                x = self.emit_nodes(x, y + size * _SUB_DY, node[1], sub)
            elif kind == "frac":
                fs = size * 0.85
                wnum = _run_width(node[1], fs)
                wden = _run_width(node[2], fs)
                w = max(wnum, wden)
                cx = x + w / 2.0
                # 三段基线：分子抬到中线以上、分母落到中线以下、横线居中且与两者
                # 都留出字形高度（原先横线离分母太近，画出来像给分母加了个上划线）
                self._center(cx, y - size * 0.34, node[1], fs, wnum)
                self._center(cx, y + size * 0.92, node[2], fs, wden)
                self.parts.append('<line x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f" stroke="%s" '
                                  'stroke-width="%.2f"/>'
                                  % (x + 1, y + size * 0.10, x + w - 1, y + size * 0.10,
                                     self.fill, max(0.9, size * 0.06)))
                x += w + size * 0.34
            elif kind == "over":
                w = _run_width(node[1], size)
                x = self.emit_nodes(x, y, node[1], size)
                self.parts.append('<line x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f" stroke="%s" '
                                  'stroke-width="%.2f"/>'
                                  % (x - w, y - size * 1.02, x, y - size * 1.02,
                                     self.fill, max(0.9, size * 0.07)))
        return x

    def _center(self, cx: float, y: float, nodes: list, size: float, w: float) -> None:
        self.emit_nodes(cx - w / 2.0, y, nodes, size)


def render_math(src: str, *, x: float, y: float, size: float = 14.0,
                anchor: str = "start", fill: str = "#333",
                family: str = "Microsoft YaHei, PingFang SC, Arial, sans-serif") -> str:
    """公式 -> SVG 片段。anchor 支持 start/middle/end（按估算宽度回退起点）。"""
    # 上限是必须的：模型偶尔会吐出一段超长"公式"（实测 500 项表达式渲染出 128KB 的
    # <text> 片段），一张试卷几十道题就能把导出撑爆。超长的一律降级成纯文本。
    if src is not None and len(str(src)) > 400:
        # 降级成纯文本时同样要按 anchor 偏移，否则居中/右对齐的标注会整体左移
        text = plain_math(str(src))[:400]
        est = sum(_char_w(c, size) for c in text)
        ox = x - est / 2.0 if anchor == "middle" else (x - est if anchor == "end" else x)
        return '<text x="%.2f" y="%.2f" font-size="%.2f" fill="%s" font-family="%s">%s</text>' \
            % (ox, y, size, fill, family, _esc(text))
    nodes = _tokenize(_strip_delims(src))
    if not nodes:
        return ""
    w = _run_width(nodes, size)
    ox = x
    if anchor == "middle":
        ox = x - w / 2.0
    elif anchor == "end":
        ox = x - w
    em = _Emitter(size, fill, family)
    em.emit_nodes(ox, y, nodes, size)
    if len(em.parts) == 1 and em.parts[0].startswith("<text"):
        return em.parts[0]
    return "<g>" + "".join(em.parts) + "</g>"


def plain_math(src: str) -> str:
    """公式 -> 纯文本（用于不便排版的场合）：符号转 Unicode，上下标转 x_1 / x^2"""
    nodes = _tokenize(_strip_delims(src))

    def walk(ns: list) -> str:
        out = ""
        for node in ns:
            k = node[0]
            if k == "run":
                out += node[1]
            elif k == "^":
                inner = walk(node[1])
                out += "^" + (inner if len(inner) == 1 else "{" + inner + "}")
            elif k == "_":
                inner = walk(node[1])
                out += "_" + (inner if len(inner) == 1 else "{" + inner + "}")
            elif k == "frac":
                num, den = walk(node[1]), walk(node[2])
                out += "(" + num + ")/(" + den + ")"
            elif k == "over":
                out += walk(node[1])
        return out

    return walk(nodes)


# ════════════════════════ 三、就地修复任意 SVG 里的公式 ════════════════════════

_TEXT_RE = re.compile(r"<text\b([^>]*)>(?P<body>[^<]*)</text>", re.S)
_ATTR_RE = re.compile(
    "([\\w:-]+)\\s*=\\s*(?:\\x22([^\x22]*)\\x22|\\x27([^\x27]*)\\x27|([^\\s\x22\x27>]+))"
)


def mathify_svg(svg: str) -> tuple[str, int]:
    """把 ``<text>`` 里的 LaTeX 换成原生图元；返回 (新 SVG, 修复条数)

    只处理"纯文本内容"的 <text>（模型手绘的公式标签全都是这种）。已经排好版的
    （含 <tspan> 等子元素）一律不动，避免二次加工把排版弄坏。
    """
    if not svg or "<text" not in svg:
        return svg, 0
    fixed = 0

    def repl(m: re.Match) -> str:
        nonlocal fixed
        attrs, body = m.group(1), m.group("body")
        raw = _unesc(body)
        if not has_math(raw):
            return m.group(0)
        # 必须用 finditer + 分组号：findall 对"未参与匹配的分支"返回空字符串而不是
        # None，于是 next(v for v in m[1:] if v is not None) 永远取到第一个分支的空值，
        # 单引号属性 (x='375') 会解析成 x='' —— 表现为公式全被挪到 (0,0) 叠成一团。
        a: dict[str, str] = {}
        for m in _ATTR_RE.finditer(attrs):
            val = m.group(2)
            if val is None:
                val = m.group(3)
            if val is None:
                val = m.group(4)
            a[m.group(1)] = val or ""
        # 必须显式拿到 x/y 才敢重排：拿不到时按 0 处理会把整条公式搬到画布左上角，
        # 多条公式叠在一起变成一团糊字（2026-11-25 自查实测：#834 的 $I_C$/$I_B$/$I_E$ 因为属性用
        # 单引号、此前的正则只认双引号，三条全部落到 (0,0)）。原样保留至少还可读。
        try:
            x = float(a["x"])
            y = float(a["y"])
        except (KeyError, TypeError, ValueError):
            return m.group(0)
        size = _parse_font_size(a, attrs)
        frag = render_math(raw, x=x, y=y, size=size,
                           anchor=(a.get("text-anchor") or "start"),
                           fill=a.get("fill") or "#333")
        if not frag:
            return m.group(0)
        fixed += 1
        return frag

    out = _TEXT_RE.sub(repl, svg)
    return out, fixed


def _parse_font_size(attrs: dict[str, str], raw_attr_str: str) -> float:
    v = attrs.get("font-size")
    if v:
        m = re.match(r"([\d.]+)", v.strip())
        if m:
            return float(m.group(1))
    style = attrs.get("style") or ""
    m = re.search(r"font-size\s*:\s*([\d.]+)", style)
    if m:
        return float(m.group(1))
    return 14.0


def latex_leftovers(svg: str) -> list[str]:
    """列出 SVG 里仍未被排版的 LaTeX 片段（用于质量闸判定）"""
    found = []
    for _attrs, body in _TEXT_RE.findall(svg or ""):
        raw = _unesc(body).strip()
        if raw and has_math(raw):
            found.append(raw[:60])
    return found
