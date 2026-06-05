"""
AI 对话相关 Prompt
- System role
- 试题生成（题库）
"""
AI_CHAT_SYSTEM_ROLE = "你是一位高中信息科技与通用技术教师。请用你的学科知识回答用户的问题。"

QUESTION_GENERATE_PROMPT = """请根据以下要求生成试题。

科目：{subject}
知识点范围：{knowledge_points}
题型：{type_desc}
数量：{count}道
难度：{difficulty_desc}

请严格按照 JSON 格式输出，只返回一个 JSON 数组，不要包含其他内容：

[
  {{
    "type": "题型标识(single/multiple/true_false/short)",
    "question": "题目内容",
    "options": {{"A":"选项A", "B":"选项B", "C":"选项C", "D":"选项D"}},
    "answer": "正确答案",
    "explanation": "解析内容",
    "knowledge_point": "所属知识点",
    "difficulty": "easy/medium/hard"
  }}
]

注意：
- 如果是判断题，options 设为 {{"对":"对", "错":"错"}}，answer 为"对"或"错"
- 如果是简答题，options 设为 null，answer 为参考答案
- 题目和选项要与高中{subject}课程内容紧密相关
"""
