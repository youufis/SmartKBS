# -*- coding: utf-8 -*-
"""出题 Prompt 的共用规范片段（2026-10 走查后从 6 份出题 prompt 里抽出来）。

为什么要抽
----------
会往 question_bank 写题的"出题指令"一共 6 处：chat.py 两份（AI 出题 / 出题含配图）、
practice.py（同步练习）、teaching.py（课程练习 10 道单选）、quiz.py（随堂测验）、
curriculum_router 里内联拼的智能练习补题。同一套规则各写各的，实测就出现这些**互相矛盾**：

1. 题型清单里写着 code，可这两个出题端点进门就先拒 code（编程题走「代码练习」），
   question_factory 也拒收机器生成的 code 题 —— 模型真给出一道 code 就少一道题；
2. 判断题选项教的是 {"对":"对","错":"错"}，而库里其它题型的选项键一律是 A/B/C/D
   （实测 113 道判断题 112 道用的是中文键，等于两套约定并存）；
3. "引号铁律"（中文引号不能当 JSON 定界符、值开头不能丢英文引号）只写在其中一份里，
   而这条恰恰是历史上"6 道题全丢"那类解析事故换来的教训；
4. 答案写法只笼统写"正确答案"，而入库门槛要求单选恰好 1 个字母、多选至少 2 个字母、
   判断题答案必须是「对/错」—— 口径不一致就会时不时长一批"判分必然判错"的死题。

⚠️ 用这些片段前必须知道的两件事
------------------------------
1. **花括号有两种口径**。`.format()` 模板（chat/practice/teaching/quiz）里的字面花括号必须
   成对出现，所以拼进去之前要过 `fsafe()`；而 f-string（curriculum 内联那段）插值时**不要**
   转义，直接用原文。搞混的症状：前者报 KeyError/留下双括号，后者把 JSON 示例打成废码。
   有测试按各调用点的真实参数把每份 prompt 渲染一遍兜底（tests/test_prompt_contract.py）。
2. **选项形状故意不统一**：随堂测验（quiz.py）的返回值直接进教师编辑器，前端按
   `options: string[]`（"A. 文本"）渲染，改成 dict 会把编辑器渲染弄坏 —— 所以给它单独一份
   ANSWER_RULES_LIST。入库那一侧不受影响：question_factory.normalize_options 两种形状都吃，
   落库一律是 {"A": "文本"}。统一发生在入库口，不在展示层。
"""

# 与 question_factory.ALL_TYPES 对齐，但去掉 code：机器出题链路不收编程题
BANK_TYPE_VOCAB = "single/multiple/true_false/short/fill/essay/subjective"


def fsafe(text: str) -> str:
    """把片段准备拼进 .format() 模板：字面花括号成对写两次。"""
    return text.replace("{", "{{").replace("}", "}}")


LATEX_RULE = r"""━━━━ 公式标记规则 ━━━━
涉及数学、物理、化学公式时使用 LaTeX 语法：行内 $...$，独立 $$...$$，化学式 $\ce{H2O}$。
**LaTeX 的反斜杠在 JSON 字符串里要多叠一层**：分数就写 "$\\frac{1}{2}$"（不是 "$\frac{1}{2}$"），
少叠一层等于把整份 JSON 打废 —— 一批题一道都进不了题库。
普通文字内容里不要出现 $ 符号。"""

MEDIA_RULE = """━━━━ 配图规则（优先 SVG，谨慎用生图） ━━━━
每道题都可以输出 svg_code 与 media_placeholders 两个字段，不需要配图就留 null。
- svg_code【优先使用】：电路图、流程图、协议栈、网络拓扑、结构框图、函数图像、光路图、
  受力分析图等技术图示；viewBox="0 0 600 400"，中文标注，主色 #1976D2，纯 SVG 代码，
  无需额外 API 调用、零成本。凡包含物理过程、数学图形、技术原理的题目应生成 svg_code。
- media_placeholders【谨慎使用】：只有确实需要真实图片（硬件外观、电子元器件实物、
  实验装置、生物显微图、场景照片）时才用，每张图消耗一次生图配额；每道题最多 2 个；
  description 写 50-100 字（主体、颜色、环境、用途），purpose 为 "实物图"/"微观图"/"场景图"/"示意图"。
  **生图模型不写中文**，description 里不要要求"标注出XX""写上XX字样"（要文字标注就改用 svg_code）。
- 两者可以同时存在：SVG 画原理 + 占位符生成实物照片，互不冲突。
- ⚠️ 安全约束：svg_code 与 description 里**严禁**出现题目答案、解析、解题过程或任何会泄露
  正确选项的文字 —— 配图会被原样印到学生看到的试卷上。"""

JSON_QUOTES_RULE = """**引号铁律**：JSON 的键名与字符串定界符必须用英文双引号 " ；
中文引号「」“” 只能出现在字符串内容里，绝不能充当 JSON 定界符；
值开头严禁丢失英文引号（错误示例："D": 环节的数量… ；正确示例："D": "环节的数量…"）。
数组里不得有注释、尾逗号、未加引号的键 —— 任何一条都会让整批题目解析失败、全部丢失。"""

JSON_ONLY_RULE = """━━━━ 输出格式 ━━━━
只输出一个合法的 JSON 数组，不得有任何其他文字（不要写"好的""以下是题目"这类开场白）。
""" + JSON_QUOTES_RULE

FIELD_NAME_RULE = """━━━━ 字段名（逐字一致，改名字等于这道题没生成） ━━━━
type / question / options / answer / explanation / knowledge_point / difficulty /
svg_code / media_placeholders。
不要写成 question_text、choices、correct_answer、选项、答案 —— 后端按上面的名字取值。"""

ANSWER_RULES = """━━━━ 答案与选项写法（与题库入库校验一致，不符的题目会被直接拒收） ━━━━
- single 单选：options 用 {"A":…,"B":…,"C":…,"D":…} 四个字母键；answer 只写 **1 个字母**
- multiple 多选：answer 用逗号分隔的字母，如 "A,C"，**至少 2 个**
- true_false 判断：options 固定写 {"A":"对","B":"错"}；answer 写 "对" 或 "错"
  （不要写 A/B，也不要写"正确/错误"）
- short 简答 / fill 填空：options 设为 null，answer 写参考答案文本（填空的空位用 ______ 表示）
- essay 作文 / subjective 主观题：options 设为 null，answer 写评分要点
- **别在这里出编程题**：代码题走「代码练习」，写成 type=code 会被入库校验拒收
- 选项文字里不要再写 "A." "B." 这类前缀（键名已经是字母，前端会自动拼）"""

ANSWER_RULES_LIST = """━━━━ 答案与选项写法（与题库入库校验一致，不符的题目会被直接拒收） ━━━━
- single 单选：options 是 4 个字符串的数组，形如 ["A. 选项内容", "B. …", "C. …", "D. …"]；
  answer 只写 **1 个字母**（"A"），必须与数组里的字母前缀对得上
- true_false 判断：options 固定写 ["对", "错"]，answer 写 "对" 或 "错"
- 每道题都要给 explanation（详细解析，说明为什么选这个以及常见错误）"""

SINGLE_CHOICE_RULES = """━━━━ 单选题写法（与题库入库校验一致，不符的题目会被直接拒收） ━━━━
- type 一律写 "single"；options 必须是 {"A":…,"B":…,"C":…,"D":…} 四个字母键
- answer 只写 **1 个字母**（如 "A"），不要写选项文字，也不要写多个字母
- 选项文字里不要再写 "A." 前缀（键名已经是字母，前端会自动拼）
- explanation 详细说明为什么选这个以及常见错误
- difficulty 只能是 easy / medium / hard"""


def question_example(types_line: str = BANK_TYPE_VOCAB, options_shape: str = "dict") -> str:
    """出题 JSON 示例块。**单花括号原文**（它只会被整体塞进 prompt，不再过 .format）。"""
    if options_shape == "list":
        # 随堂测验：返回值直接进教师编辑器，前端按 string[] 渲染，所以选项必须是数组
        options = '"options": ["A. 选项A", "B. 选项B", "C. 选项C", "D. 选项D"]'
        ans = '"answer": "A"'
    else:
        options = '"options": {"A":"选项A", "B":"选项B", "C":"选项C", "D":"选项D"}'
        ans = '"answer": "A"'
    return (
        "[\n"
        "  {\n"
        f'    "type": "{types_line}",\n'
        '    "question": "题目内容（含 $...$ LaTeX 公式）",\n'
        f'    {options},\n'
        f'    {ans},\n'
        '    "explanation": "详细解析，说明为什么选这个以及常见错误",\n'
        '    "knowledge_point": "所属知识点",\n'
        '    "difficulty": "easy/medium/hard",\n'
        '    "svg_code": "<svg>...</svg>",\n'
        '    "media_placeholders": [\n'
        '      {"key":"p1","description":"详细图片描述（50-100字）","purpose":"示意图/实物图"}\n'
        '    ]\n'
        "  }\n"
        "]"
    )


# 出题 prompt 模板里的占位符：整段规范由 render_question_prompt 在 format 之后回填，
# 这样片段本身永远不需要考虑"花括号要不要成对写两次"。
SCHEMA_PLACEHOLDER = "{question_schema}"
_SENTINEL = "\x00__QUESTION_SCHEMA__\x00"


def schema_block(types_line: str = BANK_TYPE_VOCAB, options_shape: str = "dict",
                 with_media: bool = True, answer_rules: str = "") -> str:
    """把共用规范拼成一段，供各出题 prompt 复用。

    answer_rules 不给时按选项形状挑默认版：dict 形状讲 A/B/C/D 键，
    list 形状（随堂测验）讲 ["A. 文本"] 数组 —— 两处都必须与 question_factory 的入库门槛一致。
    """
    parts = [LATEX_RULE]
    if with_media:
        parts.append(MEDIA_RULE)
    parts += [FIELD_NAME_RULE, JSON_ONLY_RULE, question_example(types_line, options_shape)]
    parts.append(answer_rules or (ANSWER_RULES if options_shape == "dict" else ANSWER_RULES_LIST))
    return "\n\n".join(parts)


def render_question_prompt(template: str, *, schema: str = "", **kw) -> str:
    """渲染出题 prompt：先按各 prompt 自己的参数 .format()，再回填共用规范段。

    顺序很关键 —— 共用片段里有大量 JSON 花括号，如果先回填再 format，片段自己就会被
    .format 当成占位符解析（轻则 KeyError，重则把 {"A":…} 变成乱码）。所以先把模板里的
    {question_schema} 换成一个不可能出现在正文里的哨兵，format 完再整体替换。
    """
    if SCHEMA_PLACEHOLDER in template:
        schema = schema or schema_block()
        return template.replace(SCHEMA_PLACEHOLDER, _SENTINEL).format(**kw).replace(_SENTINEL, schema)
    return template.format(**kw)


# ── 给"整页 HTML 里内嵌题目数组"的场景用（章节练习 / 互动练习页） ──
# 这类页面里的数组正是 resources_router 往题库写题的来源（_extract_questions_from_html），
# 所以字段口径必须和上面那份一致，否则页面能显示、题库却进不去。
QUESTION_DATA_CONTRACT = """- 页面脚本里的题目数组，每个元素必须包含：
  question（题干）、options（{"A":…,"B":…,"C":…,"D":…} 四个字母键；判断题写 {"A":"对","B":"错"}）、
  answer（单选只写 1 个字母；判断题写「对」或「错」）、explanation（解析）、type（single/true_false）
- answer 用的字母必须真是 options 里的键，不能写选项文字、不能写下标 0/1
- 题干里不要把选项文字也抄一遍
- 缺答案、答案越界的条目会被题库入库校验拒收：页面上看得到，题库里却没有"""
