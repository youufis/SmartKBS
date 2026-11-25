"""
AI 对话相关 Prompt
- System role
- 试题生成（题库）
"""
AI_CHAT_SYSTEM_ROLE = "请用你的学科知识回答用户的问题。"

QUESTION_GENERATE_PROMPT = """请根据以下要求生成试题，并**自动为试题配图**以及**使用 LaTeX 公式标记**。

学科：{subject}
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

学科：{subject}
知识点范围：{knowledge_points}
题型：{type_desc}
数量：{count}道
难度：{difficulty_desc}

{question_schema}

注意：
- 配图会被原样印到学生看到的页面上，description 只描述画面里有什么，不要把答案或解析写进图片描述
"""


# ── SVG 补图专用 Prompt ──

# ── SVG 配图 Prompt ──
#
# 规则正文不在这里抄一份 —— 唯一真相是 backend.prompts.figure_rules（题库单题重生成、
# 批量出题、课件配图三个消费方共用同一份，画布尺寸也由它锁定）。
# 本模板本身要走 str.format()，所以嵌入的是**花括号已转义**的版本。
from backend.prompts.figure_rules import SAFETY_NOTE, figure_rules_for_format

SVG_GENERATE_SPEC_PROMPT = (
    "你是一位教学配图设计师。请针对下面这道题，判断它需要什么配图，并按规则输出。\n"
    "\n"
    "题干：{description}\n"
    "学科：{subject}\n"
    "\n"
    + figure_rules_for_format()
    + "\n"
    + SAFETY_NOTE + "\n"
)

# 旧的 SVG_GENERATE_PROMPT（让模型直接手写像素坐标）已于 2026-11-25 删除：
# 它正是函数图像画错的根因，而且留着就是一个"绕过 figure_spec 与质量闸"的现成入口。


# ── 图片生成 Prompt（透传给通义万相） ──

IMAGE_GEN_PROMPT_TEMPLATE = """为{subject}课堂绘制一张{purpose}。
画面内容：{description}
画面风格：主体居中、构图清晰、色彩真实，适合作为教学课件或试卷插图。
画面中不要出现任何文字、字母、数字、公式、水印、商标或 logo（需要文字标注的原理图/流程图请改用 SVG，图像模型写中文必然糊）。
"""
