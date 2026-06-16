"""
AI 对话相关 Prompt
- System role
- 试题生成（题库）
"""
AI_CHAT_SYSTEM_ROLE = "你是一位高中信息科技与通用技术教师。请用你的学科知识回答用户的问题。"

QUESTION_GENERATE_PROMPT = """请根据以下要求生成试题，并**自动为试题配图**以及**使用 LaTeX 公式标记**。

科目：{subject}
知识点范围：{knowledge_points}
题型：{type_desc}
数量：{count}道
难度：{difficulty_desc}

━━━━ 公式标记规则 ━━━━
涉及数学、物理、化学公式时，使用 LaTeX 语法：$...$ 行内公式，$$...$$ 独立公式。

━━━━ 配图规则（AI 自动判断） ━━━━
每道题输出 svg_code（技术图示）和 media_placeholders（实物图占位符）字段，都可以为 null：
- 【svg_code】适用于电路图、流程图、函数图像等纯 SVG 技术图示（viewBox="0 0 600 400"，中文标注，主色 #1976D2）
- 【media_placeholders】适用于硬件外观、实物照片等真实图片，description 写 50-100 字详细描述
- 两者可同时存在（SVG 画原理 + 占位符生成实物照片），互不冲突
- **仅在必要时配图**：纯概念/记忆性文字题不需要配图，勿强行生成
**⚠️ 安全约束**：配图中严禁出现题目答案、解析、解题过程或任何会泄露正确选项的文字内容。

请严格按照 JSON 格式输出，只返回一个 JSON 数组：

[
  {{
    "type": "single/multiple/true_false/short/fill/essay/subjective/code",
    "question": "题目内容（含 $...$ LaTeX 公式）",
    "options": {{"A":"选项", "B":"...", "C":"...", "D":"..."}},
    "answer": "正确答案",
    "explanation": "解析",
    "knowledge_point": "知识点",
    "difficulty": "easy/medium/hard",
    "svg_code": "<svg>...</svg>",
    "media_placeholders": [{{"key":"p1","description":"图片描述","purpose":"示意图"}}],
    // 仅当 type="code" 时需要以下字段：
    "template_code": "代码模板（函数签名+注释，学生填写核心逻辑）",
    "starter_code": "初始代码框架",
    "language": "python",
    "test_cases": [{{"input":"样例输入", "expected_output":"期望输出", "description":"用例说明", "score":1, "is_sample":true}}]
  }}
]

注意：
- 选择题（single/multiple）：options 设选项字典，answer 设正确答案字母
- 判断题（true_false）：options 设为 {{"对":"对", "错":"错"}}，answer 为"对"或"错"
- 简答题/填空题（short/fill）：options 设为 null，answer 为参考答案
- 作文/主观题（essay/subjective）：options 设为 null，answer 为评分要点
- **编程题（code）**：options 设为 null，answer 为参考解答代码，必须提供 template_code + test_cases（至少3个）
- 题目和选项要与高中{subject}课程内容紧密相关
"""

# ── 含多媒体/公式支持的增强版试题生成 Prompt ──

QUESTION_GENERATE_WITH_MEDIA_PROMPT = """请根据以下要求生成试题，并**自动为试题配图**以及**使用 LaTeX 公式标记**。

科目：{subject}
知识点范围：{knowledge_points}
题型：{type_desc}
数量：{count}道
难度：{difficulty_desc}

━━━━ 公式标记规则（必须遵守） ━━━━
涉及数学、物理、化学公式时，使用 LaTeX 语法：

- 行内公式用 $...$，如 $E=mc^2$、$f(x)=ax^2+b$
- 独立公式用 $$...$$ 显示，如 $$\\int_a^b f(x)dx$$
- 化学式用 \\ce{{}} 宏包，如 \\ce{{H2O}} 表示水分子
- 普通文字内容不要使用 $ 符号

━━━━ 配图规则（AI 自动判断，非常重要！） ━━━━
每道题必须输出 svg_code 和 media_placeholders 字段（都可以为 null）：

【svg_code】— 技术图示（优先使用）
适用于：电路图、流程图、协议栈、网络拓扑、框图、数据结构、函数图像、光路图、受力分析图等
生成要求：viewBox="0 0 600 400"，中文标注，配色协调（主色 #1976D2），纯 SVG 代码
*对于包含物理过程、数学图形、技术原理的题目，必须生成 svg_code*
**⚠️ 安全约束**：SVG 配图中**严禁**出现题目答案、解析、解题过程、选项正误标记或任何会泄露正确选项的文字内容；只能展示中性的原理、结构或技术图示。

【media_placeholders】— 真实图片占位符（调用 AI 生图）
**知识点含「实物」「外观」「实物图」「场景」「照片」「实际产品」「显微镜下」等词时，必须使用 media_placeholders！**
适用于：硬件设备外观（CPU、主板、路由器、传感器、机器人、工具等）、电子元器件实物、生物显微图、化学实验装置、场景照片、人物操作示意图等
purpose 为 "实物图" / "微观图" / "场景图"，description 写 50-100 字详细描述

**⚠️ 图片描述安全规则（极其重要！）**：`description` 的内容将直接作为图片生成的提示词，**严禁**包含任何与题目答案、解析、解题过程、正确/错误选项相关的文字信息；只能描述图片的视觉内容（主体物体、颜色、环境、用途等），不得泄露题目的答案、解析、解题思路或过程。

【svg_code 和 media_placeholders 可以同时存在】
- SVG 画原理示意图 + media_placeholders 生成实物照片，两者互补
- 如果知识点明确要求「实物图」，必须包含 media_placeholders

【两者同时为 null】— 仅限纯概念/记忆性文字题

⚠️ 注意：svg_code 和 media_placeholders **仅在需要图示时使用**，纯文字题无需配图，不要强行生成。

━━━━ 输出格式 ━━━━
[
  {{
    "type": "single/multiple/true_false/short/fill/essay/subjective/code",
    "question": "题目内容（含 $...$ LaTeX 公式）",
    "options": {{"A":"选项（含公式）", "B":"...", "C":"...", "D":"..."}},
    "answer": "正确答案",
    "explanation": "解析（含公式）",
    "knowledge_point": "知识点",
    "difficulty": "easy/medium/hard",
    "svg_code": "<svg>...</svg>",
    "media_placeholders": [
      {{"key":"p1","description":"详细图片描述（50-100字）","purpose":"示意图/实物图/微观图/场景图"}}
    ]
  }}
]

注意：svg_code 和 media_placeholders 可以同时存在（比如SVG画原理图+真实图片展示实物），互不冲突！
"""


# ── SVG 补图专用 Prompt ──

SVG_GENERATE_PROMPT = """你是一位 SVG 绘图专家。请根据以下描述生成教学用 SVG 配图。

描述：{description}
科目：{subject}
尺寸：600×400（viewBox="0 0 600 400"）
要求：
- 中文标注
- 配色协调，主色 #1976D2
- 适合高中课堂教学
- 只输出 SVG 代码，不要 ```svg 标记
- 如果是电路图，使用标准电路元件符号
**⚠️ 安全约束（极其重要！）**：SVG 中禁止出现题目的答案、解析、解题过程、选项正误判断或任何泄露正确答案的文字和符号。只能绘制中性、客观的技术原理图示，不得标注正确/错误选项。
"""


# ── 图片生成 Prompt（透传给通义万相） ──

IMAGE_GEN_PROMPT_TEMPLATE = """为高中{subject}教学绘制一张{purpose}。
要求：{description}
风格：清晰准确，适合课堂教学使用，标注关键部分。
**重要安全规则**：图片中禁止出现任何与题目答案、解析、解题过程、选项正误判断相关的文字或符号。只能展示中性、客观的视觉内容，不得泄露正确答案、解析或解题线索。
"""
