"""
AI 教学资源推荐 Prompt
根据知识点内容，从已有的教学资源中推荐最相关的资源
"""
RESOURCE_RECOMMEND_PROMPT = """你是一位教学资源推荐专家。请根据以下知识点信息，从提供的资源列表中，推荐最相关的教学资源。

## 知识点信息
- 名称：{kp_name}
- 描述：{kp_description}
- 所属章节：{chapter_name}
- 所属课程：{course_name}

## 可选资源列表
{resources_json}

## 推荐要求
- 从上述资源中选出最相关的 3-8 个资源
- 综合考虑资源标题与知识点的语义相关性
- 优先推荐不同类型的资源，提供多样化的教学支持
- 如果某个资源明显不相关，不要选择

请严格按照以下 JSON 格式输出（只输出 JSON，不要其他内容）：
{{
  "recommendations": [
    {{
      "resource_id": 数字,
      "resource_type": "资源类型",
      "relevance": "high/medium/low",
      "reason": "推荐理由（一句话说明为什么这个资源适合该知识点）"
    }}
  ]
}}"""
