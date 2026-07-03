"""
课堂互动相关 Prompt
- 随堂测验生成
"""
QUIZ_GENERATE_PROMPT = """请根据以下要求生成随堂测验题目。

## 学科
{subject}

## 主题
{topic}

## 出题要求
- 题型：{type_desc}
- 题目数量：**{count} 道**（请务必生成 {count} 道不同的题目）
- 覆盖主题相关的多个知识点/角度

## 格式要求
1. 每道题必须包含完整选项（选择题4个选项，判断题["对","错"]）
2. 必须给出正确答案
3. 必须提供详细解析，帮助学生理解知识点
4. 涉及公式用 $...$ LaTeX 语法标记
5. 配图规则（**优先使用 SVG**，media_placeholders 仅当需要真实图片时使用）：
   - 【svg_code — 优先使用】适用于电路图、流程图等技术图示，无需额外 API 调用
   - 【media_placeholders】— **谨慎使用**，仅当需要硬件外观、实验装置等真实图片时才用
   - svg_code 和 media_placeholders 可以同时存在
   - 纯文字题不需要配图，都留 null 即可
   - **⚠️ 安全约束**：配图中**严禁**包含题目答案、解析、解题过程或任何会泄露正确选项的文字内容

请严格按照以下 JSON 格式输出，不要包含任何其他文字。
**数组必须包含 {count} 个元素，每个元素对应一道题：**

[
  {{
    "type": "single",
    "question": "第一题题目内容",
    "options": ["A. 选项A", "B. 选项B", "C. 选项C", "D. 选项D"],
    "answer": "A",
    "explanation": "解析：...",
    "score": 1,
    "svg_code": null,
    "media_placeholders": null
  }},
  {{
    "type": "true_false",
    "question": "第二题题目内容",
    "options": ["对", "错"],
    "answer": "对",
    "explanation": "解析：...",
    "score": 1,
    "svg_code": null,
    "media_placeholders": null
  }},
  ...  // 继续生成剩余题目，直到总共 {count} 道
]

注意：
- 判断题 type 为 "true_false"，options 为 ["对", "错"]，answer 为 "对" 或 "错"
- 选择题 options 为包含4个选项的字符串数组
- 不需要配图的题目 svg_code 和 media_placeholders 都设为 null
"""
