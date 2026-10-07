"""
自适应出题 Prompt
基于学生薄弱知识点生成针对性练习题
"""
PRACTICE_GENERATE_PROMPT = """请根据以下要求生成针对性练习题。

## 目标知识点
{knowledge_points}

## 出题要求
- 题型：{type_desc}
- 题目数量：{count} 道
- 难度：{difficulty_desc}
- 目的：帮助学生巩固薄弱知识点

{question_schema}

- 简答/填空题的 explanation 写答题思路，帮助学生理解知识点
"""
