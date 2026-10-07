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

{question_schema}

注意：
- 每道题额外带 "score": 1（随堂测验每题 1 分）
- 不需要配图的题目 svg_code 和 media_placeholders 都设为 null
- **数组必须包含 {count} 个元素**，每个元素对应一道题，不要多也不要少
"""
