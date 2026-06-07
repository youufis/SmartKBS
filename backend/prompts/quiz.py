"""
课堂互动相关 Prompt
- 随堂测验生成
"""
QUIZ_GENERATE_PROMPT = """你是一位高中{subject}教师。请根据以下要求生成随堂测验题目。

主题：{topic}
题型：{type_desc}
题目数量：{count} 题

要求：
1. 每道题必须包含完整选项（选择题4个选项，判断题["对","错"]）
2. 必须给出正确答案
3. 必须提供详细解析，帮助学生理解知识点
4. 涉及公式用 $...$ LaTeX 语法标记
5. 配图规则：
   - 【svg_code】适用于电路图、流程图等技术图示，**严禁**包含答案、解析或选项正误标记
   - 【media_placeholders】适用于硬件外观、实验装置、场景照片等真实图片
   - 知识点含「实物」「外观」「照片」等词时，必须用 media_placeholders
   - svg_code 和 media_placeholders 可以同时存在
   - **⚠️ 安全约束**：`media_placeholders[].description` 仅描述图片视觉内容（主体、颜色、环境），**严禁**包含题目答案、解析或任何会泄露正确答案的文字

请严格按照以下 JSON 格式输出，不要包含任何其他文字：
[
  {{
    "type": "single" 或 "true_false",
    "question": "题目内容（含 $...$ 公式）",
    "options": ["A. 选项A", "B. 选项B", "C. 选项C", "D. 选项D"],
    "answer": "A",
    "explanation": "解析：...",
    "score": 1,
    "svg_code": "<svg>...</svg>",
    "media_placeholders": [{{"key":"p1","description":"图片描述","purpose":"示意图"}}]
  }}
]

注意：判断题 type 为 "true_false"，options 为 ["对", "错"]，answer 为 "对" 或 "错"。
"""
