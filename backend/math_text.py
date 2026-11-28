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


# ════════════════════════ 四、AI 输出里公式转义损坏的还原 ════════════════════════

"""把模型写坏的 LaTeX 转义还原成 KaTeX 认得的形态。

模型把 LaTeX 塞进 JSON 字符串时，反斜杠的数量几乎从来不对，落库后就是用户看到的
「公式解析不全面」——同一道解析里一半公式正常、一半显示成 ``rac{2}{2}``、``imes``、
或换行后孤零零一个斜体 ``ge 2``。2026-11-28 抽查 questions.db（id 2545 / 1632 / 1367）
实测到两种损坏形态：

1. **单反斜杠被 JSON 吃掉**：``\\frac`` 里的 ``\\f`` 本身是合法 JSON 转义（换页符），
   ``json.loads`` 不报错，直接把它变成 ``\\x0c`` + ``rac``；同理 ``\\times``→TAB+imes、
   ``\\bar``→BS+ar、``\\rightarrow``→CR+ightarrow、``\\neq``→LF+eq。只有首字母是
   b/f/n/r/t 的命令中招，``\\geq``/``\\infty``/``\\le`` 反而完好 —— 这正是"有的正常
   有的乱码"的原因，也解释了为什么整段公式退化成纯文本。
2. **反斜杠叠多了**：提示词要求"JSON 里多叠一层"，模型有时叠两层，解出来是
   ``\\\\ge``；KaTeX 把 ``\\\\`` 当换行命令，于是公式在中间断行、命令名掉到下一行。

修复边界（宁可少改，不可改坏）：
- 控制字符还原：全文做，但**只在"控制字符 + 尾缀 = 已知 LaTeX 命令"时**才动手，
  围栏代码块整段跳过；还原不了的 FF/BS/VT 只在公式段内丢弃（代码块外的 TAB 不动）。
- 多余反斜杠折叠：只在公式段（``$...$`` / ``$$...$$`` / ``\\(..\\)`` / ``\\[..\\]``）内做，
  正文里的 ``\\\\``（Markdown 转义反斜杠）原样保留。
- ``\\n`` 换行是合法 JSON 转义，只有当尾缀长度 ≥2 且拼出来是已知命令时才当作 ``\\n*``
  命令还原（``\\neq`` 救得回，正文换行后接英文单词不会被误伤）。
"""

#: 首字母会被 JSON 转义吃掉的 LaTeX 命令全集（b/f/n/r/t 开头）
_CTRL_FIRST = {0x08: "b", 0x09: "t", 0x0a: "n", 0x0c: "f", 0x0d: "r"}

#: 认得的 LaTeX 命令名：只有在这个表里才敢还原，避免把正文改成公式。
#: 表内容由 KaTeX + mhchem 实测导出（node 里逐个 \command 试渲染，凡不是
#: "Undefined control sequence" 的都算认识），覆盖数学/物理/化学/生物/高数记号：
#: \frac \ce \rightleftharpoons \hbar \Omega \varepsilon \xrightarrow \binom \partial …
#: 升级 KaTeX 后重新生成：node frontend/katex_probe2.cjs && python scripts/sync_katex_cmds.py
_LATEX_CMD_NAMES = (
    # \a…
    "aa AA above acute alef alefsym aleph allowbreak alpha Alpha amalg And angl angle angln approx "
    "approxcolon approxcoloncolon approxeq arccos arcctg arcsin arctan arctg arg argmax argmin ast "
    "asymp atop "
    # \b…
    "backepsilon backprime backsim backsimeq backslash bar barwedge Bbb Bbbk bcancel because begin "
    "begingroup beta Beta beth between bf bgroup big Big bigcap bigcirc bigcup bigg Bigg biggl Biggl "
    "Biggm biggm biggr Biggr bigl Bigl Bigm bigm bigodot bigoplus bigotimes Bigr bigr bigsqcup "
    "bigstar bigtriangledown bigtriangleup biguplus bigvee bigwedge binom blacklozenge blacksquare "
    "blacktriangle blacktriangledown blacktriangleleft blacktriangleright blue blueA blueB blueC "
    "blueD blueE bm bmod bold boldsymbol bot bowtie Box boxdot boxed boxminus boxplus boxtimes Bra "
    "bra bra@ket bra@set brace brack braket Braket breve bull bullet Bumpeq bumpeq "
    # \c…
    "cal cancel cap Cap cdot cdotp cdots ce centerdot cfrac ch char check checkmark chi Chi choose "
    "circ circeq circlearrowleft circlearrowright circledast circledcirc circleddash circledR "
    "circledS clap clubs clubsuit cnums colon Colonapprox colonapprox coloncolon coloncolonapprox "
    "coloncolonequals coloncolonminus coloncolonsim Coloneq coloneq Coloneqq coloneqq colonequals "
    "colonminus Colonsim colonsim color colorbox complement Complex cong coprod copyright cos cosec "
    "cosh cot cotg coth csc ctg cth cup Cup curlyeqprec curlyeqsucc curlyvee curlywedge "
    "curvearrowleft curvearrowright "
    # \d…
    "dag Dagger dagger daleth darr Darr dArr dashleftarrow dashrightarrow dashv dbinom dblcolon ddag "
    "ddagger ddddot dddot ddot ddots def deg degree delta Delta det dfrac diagdown diagup diamond "
    "Diamond diamonds diamondsuit digamma dim displaystyle div divideontimes dot doteq Doteq "
    "doteqdot dotplus dots dotsb DOTSB dotsc dotsi DOTSI dotsm dotso DOTSX dotsx doublebarwedge "
    "doublecap doublecup downarrow Downarrow downdownarrows downharpoonleft downharpoonright "
    # \e…
    "edef egroup ell emph empty emptyset end endgroup enskip enspace Epsilon epsilon eqcirc Eqcolon "
    "eqcolon eqqcolon Eqqcolon eqsim eqslantgtr eqslantless equalscolon equalscoloncolon equiv "
    "errmessage Eta eta eth exist exists exp expandafter "
    # \f…
    "fallingdotseq fbox fcolorbox Finv flat footnotesize forall frac frak frown futurelet "
    # \g…
    "Game Gamma gamma gcd gdef ge genfrac geq geqq geqslant gets gg ggg gggtr gimel global gnapprox "
    "gneq gneqq gnsim goldA goldB goldC goldD goldE grave gray grayA grayB grayC grayD grayE grayF "
    "grayG grayH grayI green greenA greenB greenC greenD greenE gt gtrapprox gtrdot gtreqless "
    "gtreqqless gtrless gtrsim gvertneqq "
    # \h…
    "harr Harr hArr hat hbar hbox hdashline hearts heartsuit hline hom hookleftarrow hookrightarrow "
    "hphantom href hskip hslash hspace html@mathml htmlClass htmlData htmlId htmlStyle Huge huge "
    # \i…
    "iff iiint iint Im image imageof imath impliedby implies in includegraphics inf infin infty "
    "injlim int intercal intop Iota iota isin it "
    # \j…
    "jmath Join "
    # \k…
    "kaBlue kaGreen kappa Kappa KaTeX ker kern ket Ket "
    # \l…
    "Lambda lambda land lang langle Large large LARGE larr Larr lArr LaTeX lbrace lBrace lbrack "
    "lceil ldotp ldots le leadsto left Leftarrow leftarrow leftarrowtail leftharpoondown "
    "leftharpoonup leftleftarrows Leftrightarrow leftrightarrow leftrightarrows leftrightharpoons "
    "leftrightsquigarrow leftthreetimes leq leqq leqslant lessapprox lessdot lesseqgtr lesseqqgtr "
    "lessgtr lesssim let lfloor lg lgroup lhd lim liminf limits limsup ll llap llbracket llcorner "
    "Lleftarrow lll llless lmoustache ln lnapprox lneq lneqq lnot lnsim log long longleftarrow "
    "Longleftarrow Longleftrightarrow longleftrightarrow longmapsto longrightarrow Longrightarrow "
    "looparrowleft looparrowright lor lozenge lparen lq Lrarr lrarr lrArr lrcorner Lsh lt ltimes "
    "lVert lvert lvertneqq "
    # \m…
    "maltese mapsto maroonA maroonB maroonC maroonD maroonE mathbb mathbf mathbin mathcal mathchoice "
    "mathclap mathclose mathellipsis mathfrak mathinner mathit mathllap mathnormal mathop mathopen "
    "mathord mathpunct mathrel mathring mathrlap mathrm mathscr mathsf mathsfit mathsterling "
    "mathstrut mathtt max measuredangle medspace message mho mid middle min mintA mintB mintC "
    "minuscolon minuscoloncolon minuso mkern mod models mp mskip mu Mu multimap "
    # \n…
    "nabla natnums natural ncong ne nearrow neg negmedspace negthickspace negthinspace neq "
    "newcommand newline nexists ngeq ngeqq ngeqslant ngtr ni nleftarrow nLeftarrow nLeftrightarrow "
    "nleftrightarrow nleq nleqq nleqslant nless nmid nobreak nobreakspace noexpand nolimits nonumber "
    "normalsize not notag notin notni nparallel nprec npreceq nrightarrow nRightarrow nshortmid "
    "nshortparallel nsim nsubseteq nsubseteqq nsucc nsucceq nsupseteq nsupseteqq ntriangleleft "
    "ntrianglelefteq ntriangleright ntrianglerighteq Nu nu nvDash nVdash nvdash nVDash nwarrow "
    # \o…
    "odot oiiint oiint oint Omega omega Omicron omicron ominus operatorname operatorname* "
    "operatorname@ operatornamewithlimits oplus orange ordinarycolon origof oslash otimes over "
    "overbrace overbracket overgroup overleftarrow overleftharpoon overleftrightarrow overline "
    "overlinesegment Overrightarrow overrightarrow overrightharpoon overset owns "
    # \p…
    "parallel partial perp phantom phase phi Phi pi Pi pink pitchfork plim plusmn pm pmb pmod pod "
    "pounds Pr prec precapprox preccurlyeq preceq precnapprox precneqq precnsim precsim prime prod "
    "projlim propto providecommand providecommand* Psi psi pu purple purpleA purpleB purpleC purpleD "
    "purpleE "
    # \q…
    "qquad quad "
    # \r…
    "raisebox rang rangle Rarr rarr rArr ratio rBrace rbrace rbrack rceil Re real reals Reals red "
    "redA redB redC redD redE relax renewcommand restriction rfloor rgroup rhd rho Rho right "
    "rightarrow Rightarrow rightarrowtail rightharpoondown rightharpoonup rightleftarrows "
    "rightleftharpoons rightrightarrows rightsquigarrow rightthreetimes risingdotseq rlap rm "
    "rmoustache rparen rq rrbracket Rrightarrow Rsh rtimes rule rVert rvert "
    # \s…
    "scriptscriptstyle scriptsize scriptstyle sdot searrow sec sect Set set setminus sf sh sharp "
    "shortmid shortparallel show Sigma sigma sim simcolon simcoloncolon simeq sin sinh sixptsize "
    "small smallfrown smallint smallsetminus smallsmile smash smile sout space spades spadesuit "
    "sphericalangle sqcap sqcup sqrt sqsubset sqsubseteq sqsupset sqsupseteq square stackrel star "
    "sub sube Subset subset subseteq subseteqq subsetneq subsetneqq substack succ succapprox "
    "succcurlyeq succeq succnapprox succneqq succnsim succsim sum sup supe supset Supset supseteq "
    "supseteqq supsetneq supsetneqq surd swarrow "
    # \t…
    "tag tag@literal tag@paren tan tanh Tau tau tbinom tealA tealB tealC tealD tealE TeX text textbf "
    "textcircled textcolor textcopyright textit textmd textnormal TextOrMath textregistered textrm "
    "textsf textstyle texttt textup tfrac tg th therefore theta Theta thetasym thickapprox thicksim "
    "thickspace thinspace tilde times tiny tmspace to top triangle triangledown triangleleft "
    "trianglelefteq triangleq triangleright trianglerighteq tripledash tt twoheadleftarrow "
    "twoheadrightarrow "
    # \u…
    "uarr uArr Uarr ulcorner underbar underbrace underbracket undergroup underleftarrow "
    "underleftrightarrow underline underlinesegment underrightarrow underset unlhd unrhd uparrow "
    "Uparrow updownarrow Updownarrow upharpoonleft upharpoonright uplus Upsilon upsilon upuparrows "
    "urcorner url utilde "
    # \v…
    "varDelta varepsilon varGamma varinjlim varkappa varLambda varliminf varlimsup varnothing "
    "varOmega varphi varPhi varPi varpi varprojlim varpropto varPsi varrho varsigma varSigma "
    "varsubsetneq varsubsetneqq varsupsetneq varsupsetneqq vartheta varTheta vartriangle "
    "vartriangleleft vartriangleright varUpsilon varvdots varXi vcentcolon vcenter Vdash vDash vdash "
    "vdots vec vee veebar verb verb* Vert vert vphantom Vvdash "
    # \w…
    "wedge weierp widecheck widehat widetilde wp wr "
    # \x…
    "xcancel xdef xhookleftarrow xhookrightarrow xi Xi xLeftarrow xleftarrow xleftequilibrium "
    "xleftharpoondown xleftharpoonup xLeftrightarrow xleftrightarrow xleftrightharpoons xlongequal "
    "xmapsto xRightarrow xrightarrow xrightequilibrium xrightharpoondown xrightharpoonup "
    "xrightleftarrows xrightleftharpoons xtofrom xtwoheadleftarrow xtwoheadrightarrow "
    # \y…
    "yen "
    # \z…
    "zeta Zeta "
)
_LATEX_CMDS = frozenset(_LATEX_CMD_NAMES.split())

#: 公式段内容（不含定界符）
#: 叠多了的反斜杠 + 命令名（``\\\\ge`` / ``\\\\frac``）
_OVER_ESCAPED_RE = re.compile(r"(\\{2,})([A-Za-z]+)")
#: 换行/回车后只有紧跟"数学记号"才敢认单字母尾缀：$\nu$ 救得回，
#: 代码行首的 i, j = 0 不会被当成 \ni（逗号/分号故意不在此列）
_MATHISH = "{}^_\\$0123456789"

#: 紧跟控制字符的 ASCII 字母串
_TAIL_RE = re.compile(r"[A-Za-z]+")
_FENCE_RE = re.compile(r"(^[ \t]*(```|~~~)[\s\S]*?^\s*\2[ \t]*$)", re.M)


def is_latex_command(name: str) -> bool:
    """公开判定：这个字母串是不是我们认得的 LaTeX 命令名（供 ai_json 复用）"""
    return name in _LATEX_CMDS


def _known_cmd(name: str) -> bool:
    """命令名是否认识（容忍尾部多带的括号/花括号已被正则切掉）"""
    return name in _LATEX_CMDS


def _next_char(text: str, k: int, n: int, after: str) -> str:
    """切片内第 k 个字符；越界时取切片后的第一个字符（公式段的收尾定界符）"""
    if k < n:
        return text[k]
    return after[0] if after else ""


def _is_indent(text: str, i: int, ctx: str = "") -> bool:
    """位置 i 是否处在行首缩进位（到行首只有空白）。

    ctx 是这段切片**前面**的字符：公式段体从定界符后切出来时，切片开头并不是
    真正的行首 —— 不带 ctx 会把 "$ar{v}" 的退格符当成"行首缩进的制表符"漏掉。
    """
    j = i - 1
    while j >= -len(ctx):
        ch = text[j] if j >= 0 else ctx[j]
        if ch in " \t":
            j -= 1
            continue
        return ch == "\n"
    return True


def _restore_ctrl(text: str, *, drop_unknown: bool, ctx: str = "", after: str = "") -> str:
    """控制字符 + 尾缀 -> 还原成 ``\\命令``；还原不了时是否丢弃控制字符"""
    if not any(chr(c) in text for c in _CTRL_FIRST):
        return text
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        o = ord(text[i])
        first = _CTRL_FIRST.get(o)
        if first:
            m = _TAIL_RE.match(text, i + 1)
            tail = m.group(0) if m else ""
            cand = first + tail if tail else ""
            # \n / \r 本身是合法换行：只有尾缀够长（≥2）且拼出来是命令才还原，
            # 否则 "……说明：\nnext" 这类正文会被改成公式。
            # 位于行首缩进位（到行首只有空格/制表符）的控制字符不动：那是缩进，不是被吃掉的反斜杠。
            if (tail and cand in _LATEX_CMDS
                    and (o not in (0x0a, 0x0d) or len(tail) >= 2
                         or _next_char(text, i + 1 + len(tail), n, after) in _MATHISH)
                    and not _is_indent(text, i, ctx)):
                out.append("\\" + cand)
                i += 1 + len(tail)
                continue
            if o == 0x0d and i + 1 < n and text[i + 1] == "\n":
                i += 1                       # CRLF：正常换行，原样交给下一轮
                continue
            if drop_unknown and o in (0x08, 0x09, 0x0b, 0x0c, 0x0d):
                i += 1                       # 公式段里的裸控制字符只会渲染成方块/断行
                continue                     # （\n 不动：$$ 块里的换行是合法排版）
        out.append(text[i])
        i += 1
    return "".join(out)


def _math_spans(text: str) -> list[tuple[int, int]]:
    """公式段正文的 [start, end) 区间；定界符不配对时保守地跳过这一段"""
    spans: list[tuple[int, int]] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "\\":
            nxt = text[i + 1] if i + 1 < n else ""
            if nxt in "()[]":
                close = "\\)" if nxt == "(" else "\\]"
                j = text.find(close, i + 2)
                if j < 0:
                    i += 2
                    continue
                spans.append((i + 2, j))
                i = j + 2
                continue
            if nxt == "$":                   # \$ 是字面美元符
                i += 2
                continue
            i += 1
            continue
        if ch == "$":
            two = text.startswith("$$", i)
            marker = "$$" if two else "$"
            j = text.find(marker, i + len(marker))
            body = text[i + len(marker):j] if j >= 0 else ""
            if j < 0 or (not two and "\n\n" in body):
                i += len(marker)
                continue
            spans.append((i + len(marker), j))
            i = j + len(marker)
            continue
        i += 1
    return spans


def _repair_region(text: str) -> str:
    """一段非代码文本：先还原控制字符，再在公式段内折叠多余反斜杠"""
    spans = _math_spans(text)
    if not spans:
        return _restore_ctrl(text, drop_unknown=False)
    pieces: list[str] = []
    pos = 0
    for a, b in spans:
        if a < pos:                          # 定界符重叠（模型写飞了），跳过
            continue
        ctx = text[max(0, pos - 2):pos]
        pieces.append(_restore_ctrl(text[pos:a], drop_unknown=False, ctx=ctx))
        body = _restore_ctrl(text[a:b], drop_unknown=True, ctx=text[max(0, a - 2):a],
                             after=text[b:b + 1])
        if _OVER_ESCAPED_RE.search(body):
            body = _OVER_ESCAPED_RE.sub(
                lambda m: "\\" + m.group(2) if _known_cmd(m.group(2)) else m.group(0),
                body)
        pieces.append(body)
        pos = b
    pieces.append(_restore_ctrl(text[pos:], drop_unknown=False, ctx=text[max(0, pos - 2):pos]))
    return "".join(pieces)


# ════════════════════════ 五、正文里"裸 LaTeX 命令"补上 $ 定界符 ════════════════════════

"""模型经常把公式写进正文却不套 ``$``：选项 ``[3, +\\infty)``、解析里的 ``m \\ge 2``。
没有定界符，remark-math / KaTeX 一律不接管，页面就把 ``\\infty`` 当普通文字显示
（Markdown 还会把 ``\\i`` 的反斜杠当转义吃掉，最后看到的是 "infty"）。这里在**公式段
之外**把"命令 + 紧邻的数学片段"包进 ``$...$``，让各学科行文里裸写的记号也能渲染。

边界（宁可漏包，不可包错）：
- 代码围栏、行内代码、已经在 ``$`` / ``\\(\\)`` 里的内容整段跳过；
- 只认 KaTeX 认识的命令名（``\\%`` ``\\_`` 这类转义标点、Windows 路径 ``C:\\Users`` 不动）；
- 片段以 CJK 为硬边界，两端剥掉空白、句末标点、"A." 这类选项标签，以及没有配对开符的收尾括号；
- 命令不是强记号（\\infty \\ge \\frac \\ce…）且片段里没有数字/运算符时不包。
"""

_ALLOWED_RUN = frozenset(
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    " +-*/=<>^_{}()[]|!.,;:%~&\"'\\"
)
#: 这些命令可以"孤身"被包进公式；其它命令必须旁边还有数字/运算符才包
_STRONG_CMDS = frozenset({
    "infty", "times", "div", "cdot", "pm", "mp", "leq", "le", "geq", "ge", "neq", "ne",
    "approx", "equiv", "sim", "simeq", "propto", "sqrt", "frac", "dfrac", "tfrac", "binom",
    "ce", "pu", "rightarrow", "Rightarrow", "to", "leftarrow", "leftrightarrow", "sum",
    "prod", "int", "lim", "partial", "nabla", "cup", "cap", "in", "notin", "subset",
    "subseteq", "supset", "supseteq", "perp", "parallel", "angle", "triangle", "degree",
    "alpha", "beta", "gamma", "delta", "Delta", "theta", "lambda", "mu", "rho", "sigma",
    "tau", "phi", "Omega", "omega", "pi", "epsilon", "varepsilon", "vec", "hat", "bar",
    "overline", "overrightarrow", "hbar", "therefore", "because", "cong",
})
_CMD_ANCHOR = re.compile(r"\\([A-Za-z]+)")
_TRIM_CHARS = " \t.,;:!?"
_LEAD_LABEL = re.compile(r"^[A-Za-z][.)]\s+")
_MATH_SIGNAL = re.compile(r"[0-9=+\-*/<>^_{}|]")
#: 收尾括号只在自己没有配对开符时才剥掉；[3, +∞) 这种半开区间的右括号是配对的
_CLOSER_OPENER = {")": "([", "]": "([", "}": "{"}
#: 行首的列表/编号标记（"- "、"* "、"2."、"1)）"）——绝不能被吞进公式，否则列表项
#: 会整条变成 $- x \ge 2$，Markdown 的列表结构当场没了
_LINE_MARK = re.compile(r"^(?:[-*+]|\d+[.)])[ \t]+")
#: 向左看到"选项标签 + 空格"（"B. "）或连续空格（并列选项的分隔）就收手
_OPT_TAIL = re.compile(r"[A-Za-z][.)][ \t]*$")
_DOUBLE_SP = re.compile(r"[ \t]{2,}$")
_OPT_HEAD = re.compile(r"[ \t]*[A-Za-z][.)][ \t]")


def _expand_left(text: str, pos: int) -> int:
    while pos > 0 and text[pos - 1] in _ALLOWED_RUN:
        if text[pos - 1] in " \t":
            before = text[:pos - 1]
            if _OPT_TAIL.search(before) or _DOUBLE_SP.search(before):
                break
        pos -= 1
    return pos


def _expand_right(text: str, pos: int) -> int:
    n = len(text)
    while pos < n and text[pos] in _ALLOWED_RUN:
        if text[pos] in " \t":
            if _DOUBLE_SP.match(text[max(0, pos - 1):pos + 1]) or _OPT_HEAD.match(text[pos:]):
                break
        pos += 1
    return pos


def _trim_indices(text: str, a: int, b: int) -> tuple[int, int]:
    """把 [a,b) 两端能安全剥掉的字符剥掉，返回收紧后的下标（不返回切片，避免再找位置）"""
    # 行首列表/编号标记不吃进公式："- x \ge 2" 只包 "x \ge 2"，
    # 否则 Markdown 的列表结构会被整条吞掉（解析里这种行很多）
    if a == 0 or text[a - 1] == "\n":
        m = _LINE_MARK.match(text[a:b])
        if m:
            a += m.end()
    while a < b and text[a] in _TRIM_CHARS:
        a += 1
    m = _LEAD_LABEL.match(text[a:b])
    if m:
        a += m.end()
    while a < b and text[b - 1] in _TRIM_CHARS:
        b -= 1
    while a < b and text[b - 1] in ")]}" and not any(
            text.count(op, a, b - 1) for op in _CLOSER_OPENER[text[b - 1]]):
        b -= 1
        while a < b and text[b - 1] in _TRIM_CHARS:
            b -= 1
    return a, b


def _wrap_plain(text: str) -> str:
    """一段公式段之外的纯文本：把裸命令所在的数学片段包进 $…$"""
    if "\\" not in text:
        return text
    ranges: list[list[int]] = []
    for m in _CMD_ANCHOR.finditer(text):
        cmd = m.group(1)
        if not _known_cmd(cmd):
            continue
        a, b = _expand_left(text, m.start()), _expand_right(text, m.end())
        a, b = _trim_indices(text, a, b)
        seg = text[a:b]
        if not seg or len(seg) > 80 or "$" in seg or "`" in seg:
            continue
        if cmd not in _STRONG_CMDS and not _MATH_SIGNAL.search(seg.replace("\\" + cmd, "")):
            continue
        ranges.append([a, b])
    if not ranges:
        return text
    ranges.sort()
    merged: list[list[int]] = []
    for a, b in ranges:
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    out: list[str] = []
    pos = 0
    for a, b in merged:
        if a < pos:
            continue
        out.append(text[pos:a])
        out.append("$" + text[a:b] + "$")
        pos = b
    out.append(text[pos:])
    return "".join(out)


def _split_math_regions(text: str):
    """-> [(是否公式段, 片段)]：公式段（含定界符）整段原样，段外才做裸命令包裹"""
    spans = _math_spans(text)
    if not spans:
        return [(False, text)]
    out: list[tuple[bool, str]] = []
    pos = 0
    for a, b in spans:
        if a < pos:
            continue
        # 起始定界符：$$ / \[ / \( 占 2 个字符，$ 占 1 个
        open_len = 2 if text[max(0, a - 2):a] in ("$$", "\\(", "\\[") else 1
        if a - open_len < pos:                 # 定界符重叠，保守起见整段不动
            continue
        out.append((False, text[pos:a - open_len]))
        out.append((True, text[a - open_len:b + open_len]))
        pos = b + open_len
    if pos < len(text):
        out.append((False, text[pos:]))
    return out


def _wrap_inline_code_aware(chunk: str) -> str:
    """行内代码 `…` 里不包公式（反引号成对切分，奇数段是代码本体）"""
    if "`" not in chunk:
        return _wrap_plain(chunk)
    parts = chunk.split("`")
    for i in range(0, len(parts), 2):
        parts[i] = _wrap_plain(parts[i])
    return "`".join(parts)


def wrap_bare_math(text: str) -> str:
    """把正文里裸写的 LaTeX 命令补成 $…$（幂等；代码围栏与已有公式段不动）"""
    if not text or "\\" not in text:
        return text
    out: list[str] = []
    pos = 0
    for m in _FENCE_RE.finditer(text):
        for is_math, seg in _split_math_regions(text[pos:m.start()]):
            out.append(seg if is_math else _wrap_inline_code_aware(seg))
        out.append(m.group(0))
        pos = m.end()
    for is_math, seg in _split_math_regions(text[pos:]):
        out.append(seg if is_math else _wrap_inline_code_aware(seg))
    return "".join(out)


def needs_math_repair(text: str) -> bool:
    """这段文本有没有可能被上述两种损坏影响（用来避免对每条正常文本空跑一遍）"""
    if not text:
        return False
    if any(chr(c) in text for c in _CTRL_FIRST):
        return True
    return bool(_OVER_ESCAPED_RE.search(text))


def _looks_like_json_blob(text: str) -> bool:
    """整段是一个 JSON 对象/数组？这类文本要先解析再逐字段修，不能就地折反斜杠"""
    if text[:1] not in ("{", "["):
        return False
    try:
        import json
        json.loads(text)
        return True
    except Exception:
        return False


def repair_math_text(text: str) -> str:
    """还原 AI 输出里被 JSON 转义吃掉的 LaTeX 命令（幂等，正常文本原样返回）。

    **整坨 JSON 直接跳过**：序列化后的文本里 ``\\\\div`` 是 ``\\div`` 的合法转义，按公式段
    规则把它折成单个反斜杠，等于把 ``\\d`` 塞进 JSON —— 整坨当场解析失败。要修 JSON 列
    必须先解析、只改字符串叶子、再回写（见 scripts/repair_math_escapes.py 的 repair_value
    与 question_parse.repair_questions）。
    """
    if not isinstance(text, str) or not needs_math_repair(text):
        return text
    if _looks_like_json_blob(text):
        return text
    out: list[str] = []
    pos = 0
    for m in _FENCE_RE.finditer(text):       # 围栏代码块整段保护
        out.append(_repair_region(text[pos:m.start()]))
        out.append(m.group(0))
        pos = m.end()
    out.append(_repair_region(text[pos:]))
    return "".join(out)

