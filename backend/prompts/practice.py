"""
自适应出题 Prompt
基于学生薄弱知识点生成针对性练习题
"""
PRACTICE_GENERATE_PROMPT = """你是一位经验丰富的高中{subject}教师。请根据以下要求生成针对性练习题。

## 目标知识点
{knowledge_points}

## 出题要求
- 题型：{type_desc}
- 题目数量：{count} 道
- 难度：{difficulty_desc}
- 目的：帮助学生巩固薄弱知识点

## 公式标记规则
涉及数学、物理、化学公式时，使用 LaTeX 语法：
- 行内公式用 $...$，如 $E=mc^2$、$f(x)=ax^2+b$
- 独立公式用 $$...$$

## 配图规则（⚠️ 重要！必须遵守）
每道题可输出 svg_code 和 media_placeholders 字段（都可以为 null）：

【svg_code】— 技术图示
适用于：电路图、流程图、光路图、函数图像、结构框图等技术图示。
viewBox="0 0 600 400"，中文标注。
*如果是原理、结构、流程类的配图，用 svg_code*
**⚠️ 安全约束**：SVG 配图中**严禁**出现题目答案、解析说明或任何会泄露正确选项的文字内容，只能展示中性的技术图示。

【media_placeholders】— 真实图片（调用 AI 生图）
**凡是知识点中包含「实物」「外观」「实物图」「场景」「照片」「实际产品」「显微镜下」等词，必须使用 media_placeholders！**
适用于：硬件外观、电子元器件实物、实验装置、场景照片、生物显微图等真实感图片。
description 写 50-100 字详细描述（主体、颜色、环境、用途），purpose 为 "实物图"。

**⚠️ 图片描述安全规则（极其重要！）**：`description` 的内容将直接作为图片生成的提示词，**严禁**包含任何与题目答案、解析、正确/错误选项相关的文字信息；只能描述图片的视觉内容（主体物体、颜色、环境、用途等），不得泄露题目的答案或解题思路。

【两者关系】
- svg_code 和 media_placeholders **可以同时存在**（SVG 画原理 + 占位符生成实物照）
- 如果知识点明确要求「实物图」，则必须包含 media_placeholders
- 两者都为 null 仅适用于纯概念文字题

【配图覆盖率要求】
- 超过 60% 的题目应包含至少一种配图

请严格按照 JSON 格式输出，只返回一个 JSON 数组：

[
  {{
    "type": "single/multiple/true_false/short",
    "question": "题目内容（含 $...$ LaTeX 公式）",
    "options": {{"A":"选项（含公式）", "B":"...", "C":"...", "D":"..."}},
    "answer": "正确答案",
    "explanation": "详细解析（含公式），包含为什么选这个以及常见错误",
    "knowledge_point": "所属知识点",
    "difficulty": "easy/medium/hard",
    "svg_code": "<svg>...</svg>",
    "media_placeholders": [{{"key":"p1","description":"详细图片描述","purpose":"示意图/实物图"}}]
  }}
]

注意：
- 判断题 options 为 {{"对":"对", "错":"错"}}，answer 为"对"或"错"
- 简答题 options 为 null，answer 为参考答案
- svg_code 和 media_placeholders 可以同时存在
- 超过 50% 的题目应包含至少一种配图
"""
