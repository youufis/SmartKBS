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

请严格按照以下 JSON 格式输出，不要包含任何其他文字：
[
  {{
    "type": "single" 或 "true_false",
    "question": "题目内容",
    "options": ["A. 选项A", "B. 选项B", "C. 选项C", "D. 选项D"],
    "answer": "A",
    "explanation": "解析：...",
    "score": 1
  }}
]

注意：判断题 type 为 "true_false"，options 为 ["对", "错"]，answer 为 "对" 或 "错"。
"""
