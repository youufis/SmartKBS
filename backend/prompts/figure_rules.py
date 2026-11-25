# -*- coding: utf-8 -*-
"""SVG 配图规则的**唯一真相**。

为什么要单独一个模块
------------------
历史上"教模型怎么画图"的文本散在三处各写一份：``prompts/chat.py``（单题重新生成）、
``api/image_gen_service.py``（课件配图）、``prompts/question_schema.py``（批量出题）。
内容相似、措辞不同、画布尺寸还不一致（600×400 vs 800×500）。结果就是"改一处漏两处"
—— 上一轮加统计图/几何 spec 时，我不得不把同一段规则手工抄三遍，抄完还发现示例里
少写了一个右括号。

现在只有这一份。两个消费方式：

* :data:`FIGURE_RULES` —— **单花括号原文**。给 ``question_schema`` 那种"format 之后
  再回填"的场合直接用。
* :func:`figure_rules_for_format` —— 把花括号成对转义，给会被 ``str.format()``
  处理的 prompt 模板用（``chat``、``image_gen_service``）。

画布尺寸也在这里定死，并用断言防止正文与常量漂移。
"""
from __future__ import annotations

FIGURE_W = 600
FIGURE_H = 400
FIGURE_CANVAS = f"0 0 {FIGURE_W} {FIGURE_H}"

#: 配图规则正文（单花括号，可读优先；不要在这里做 .format）
FIGURE_RULES = """━━ 输出规则（严格 JSON 对象，不要围栏、不要其他文字）━━
{"figure_spec": 对象或 null, "svg_code": "字符串或 null"}

能参数化的图**一律只输出 figure_spec、svg_code 写 null** —— 后端把它确定性地渲染成图，
像素由代码算。你不输出也不需要输出任何像素坐标、<path>、<circle>。

① 函数图像（含坐标系：一次函数、二次函数/抛物线、反比例函数、幂/指/对数、三角函数、
   线性规划，以及物理 s-t / v-t / I-U、化学溶解度·浓度曲线、生物种群·酶活曲线）
   {"functions": [{"expr": "用 x 表示的解析式", "label": "图上标注的公式"}],
    "points": [{"x": 数, "y": 数, "label": "标注文字"}],
    "x_range": [小, 大], "y_range": [小, 大]}
   - expr 用中学写法即可："x^2-2x-3"、"\\frac{6}{x}"、"-x+2"、"2\\sin x"、
     "100/(1+9*exp(-0.6*x))" 都认
   - points 必须是题干给出的点，且**真的满足 y=f(x)**：后端逐点代入验算，不符就整张拒收；
     原点、对称轴与 x 轴交点这类辅助点加 "off_curve": true
   - 反比例函数的 x_range 必须跨过 0（两支都要画出来）
   - 要表示"待定/不含答案"，label 写一般式（如 "y=ax^2+bx+c"），但 expr 仍须是确定的一条曲线

② 统计图（柱状 / 折线 / 双 Y 轴组合 / 饼图）
   {"chart": "bar|line|combo|pie", "categories": ["1月", ...],
    "series": [{"name": "降水量", "data": [45, 60, ...], "type": "bar", "axis": "left"},
               {"name": "气温", "data": [8, 9, ...], "type": "line", "axis": "right"}],
    "x_label": "月份", "y_left_label": "降水量/mm", "y_right_label": "气温/℃", "title": "图名"}
   - data 是**题目给的原始数值**，不要自己换算；柱高与折线位置由数据线性映射，画歪不可能
   - data 长度必须等于 categories 长度；饼图各扇区角度按占比自动算，标百分比时数据总和须为 100
   - 地理"气温曲线+降水柱状"、生物"种群数量"、化学"含量占比"这类题一律走这里

③ 几何图（三角形 / 圆 / 立体图形 / 平面机构图）
   {"shape": "geometry", "points": [{"name": "A", "x": 数, "y": 数}, ...],
    "segments": [{"from": "A", "to": "B", "style": "solid|dashed", "mark": "tick|tick2"}],
    "polygons": [{"vertices": ["A", "B", "C"]}],
    "circles": [{"center": "O", "through": "A"}],
    "angles": [{"at": "B", "from": "A", "to": "C", "label": "60°"}],
    "right_angles": [{"at": "A", "from": "B", "to": "C"}],
    "relations": [{"kind": "midpoint", "of": ["A", "B"], "at": "D"},
                  {"kind": "parallel", "a": ["D", "E"], "b": ["B", "C"]},
                  {"kind": "ratio", "a": ["D", "E"], "b": ["B", "C"], "ratio": 0.5},
                  {"kind": "length", "of": ["B", "C"], "value": 8}]}
   - points 的 x/y 是**数学坐标（y 向上）**，不是画布像素；单位随你取（1 格=1 或 =100 都行），
     后端会自动算包围盒、等比缩放并居中。别按 600×400 画布去写，那样图形会上下颠倒
   - 先按题目条件算出各点坐标，再声明关系；后端拿坐标逐条验算 midpoint / parallel /
     perpendicular / equal / ratio / collinear / on_segment 与角度标注，对不上就整张拒收
   - 好处：中点真的在中点、平行线真的平行、标 60° 画出来就是 60°（两轴严格等比）

④ 无法参数化的图（电路图 / 实物连接 / 流程图 / 网络拓扑 / 结构框图 / 光路图 /
   实验装置 / 受力分析 / 细胞结构 / 地图 / 等高线 / 时间轴）
   figure_spec 写 null，由你直接绘制 svg_code。以下都是硬规则，后端会机检，违反就拒收：
   - viewBox="0 0 600 400"，主色 #1976D2，中文标注，纯 SVG 代码
   - 所有图元必须落在 0<=x<=600、0<=y<=400 之内，不许画到画布外
   - 内容要铺满画布，不要所有元素挤在一个角落里
   - <text> 里需要下标/上标/分数时**直接写 LaTeX**（<text>$R_1$</text>、<text>$2^7$</text>、
     <text>$\\frac{6}{x}$</text>），后端会自动排版成真正的上下标与分数；
     不要自己拼 <tspan>，也不要把 V_{CC} 拆成 V、cc 两个 <text> 硬凑位置
   - 禁止 <script> / <foreignObject> / on* 事件属性 / 外链 URL / <style> 外部依赖
"""

#: 安全约束（配图会原样印到学生卷面上）——同样只此一份
SAFETY_NOTE = """**⚠️ 安全约束（极其重要）**：配图会被原样印到学生看到的试卷上。禁止出现题目答案、
解析、解题过程、选项正误判断或任何泄露正确选项的文字与符号。"""


def _assert_no_drift() -> None:
    """正文里的画布尺寸必须与常量一致 —— 防止以后改了常量忘了改正文（或反之）"""
    if f'viewBox="0 0 {FIGURE_W} {FIGURE_H}"' not in FIGURE_RULES:
        raise RuntimeError(
            "figure_rules 正文里的 viewBox 与 FIGURE_W/FIGURE_H 常量已漂移，请同步")
    if f"0<=x<={FIGURE_W}、0<=y<={FIGURE_H}" not in FIGURE_RULES:
        raise RuntimeError(
            "figure_rules 正文里的越界判定与 FIGURE_W/FIGURE_H 常量已漂移，请同步")


_assert_no_drift()


def figure_rules_for_format() -> str:
    """给需要走 ``str.format()`` 的 prompt 用：把正文里的花括号成对转义。

    共用规范段里有大量 JSON 花括号，如果模板先回填再 format，片段自己就会被当成
    占位符解析（轻则 KeyError，重则把 {"A":…} 变成乱码）。所以这两个消费方必须用
    转义版，而 ``question_schema`` 那种"format 之后整体替换"的场合用原文。
    """
    return FIGURE_RULES.replace("{", "{{").replace("}", "}}")


def canvas_note() -> str:
    return f"尺寸：{FIGURE_W}×{FIGURE_H}（viewBox=\"{FIGURE_CANVAS}\"）"
