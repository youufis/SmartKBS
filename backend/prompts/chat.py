"""
AI 对话相关 Prompt
- System role
- 试题生成（题库）
"""
AI_CHAT_SYSTEM_ROLE = "请用你的学科知识回答用户的问题。"

QUESTION_GENERATE_PROMPT = """请根据以下要求生成试题，并**自动为试题配图**以及**使用 LaTeX 公式标记**。

科目：{subject}
知识点范围：{knowledge_points}
题型：{type_desc}
数量：{count}道
难度：{difficulty_desc}

{question_schema}

注意：
- 题目和选项要与{subject}课程内容紧密相关
"""

# ── 含多媒体/公式支持的增强版试题生成 Prompt ──

QUESTION_GENERATE_WITH_MEDIA_PROMPT = """请根据以下要求生成试题，并**自动为试题配图**以及**使用 LaTeX 公式标记**。

科目：{subject}
知识点范围：{knowledge_points}
题型：{type_desc}
数量：{count}道
难度：{difficulty_desc}

{question_schema}

注意：
- 配图会被原样印到学生看到的页面上，description 只描述画面里有什么，不要把答案或解析写进图片描述
"""


# ── SVG 补图专用 Prompt ──

SVG_GENERATE_PROMPT = """你是一位 SVG 绘图专家。请根据以下描述生成教学用 SVG 配图。

描述：{description}
科目：{subject}
尺寸：600×400（viewBox="0 0 600 400"）
要求：
- 中文标注
- 配色协调，主色 #1976D2
- 适合课堂教学
- 只输出 SVG 代码，不要 ```svg 标记
- 如果是电路图，使用标准电路元件符号
**⚠️ 安全约束（极其重要！）**：SVG 中禁止出现题目的答案、解析、解题过程、选项正误判断或任何泄露正确答案的文字和符号。只能绘制中性、客观的技术原理图示，不得标注正确/错误选项。
"""


# ── 图片生成 Prompt（透传给通义万相） ──

IMAGE_GEN_PROMPT_TEMPLATE = """为{subject}课堂绘制一张{purpose}。
画面内容：{description}
画面风格：主体居中、构图清晰、色彩真实，适合作为教学课件或试卷插图。
画面中不要出现任何文字、字母、数字、公式、水印、商标或 logo（需要文字标注的原理图/流程图请改用 SVG，图像模型写中文必然糊）。
"""
