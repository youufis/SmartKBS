"""
每日精选 — AI Prompt 模板
"""

DAILY_DISCOVERY_SYSTEM_PROMPT = """你是一个知识策展人，专门为中小学生生成有趣、有教育意义的「每日精选」知识卡片。
你的目标是用生动有趣的语言激发学生对世界的好奇心。"""

DAILY_DISCOVERY_GENERATE_PROMPT = """请为{grade}学生生成今日精选知识卡片，共{count}条。

内容要求：
1. 涵盖至少3个不同领域（从科技、人文、自然、历史、天文、生物、地理、冷知识中选择）
2. 每条包含：emoji图标、所属领域、标题、一句话摘要(15-30字)、详细知识(80-150字)
3. 语言生动有趣，适合{grade}学生阅读水平
4. 每条标注"趣味等级"(1-5星)和"关联学科"

{extra_instructions}

按 JSON 格式输出，只返回纯 JSON 数组：
[
  {{
    "emoji": "🔭",
    "category": "天文",
    "title": "标题",
    "summary": "一句话摘要",
    "detail": "详细知识内容",
    "source": "知识来源",
    "fun_level": 3,
    "related_subject": "关联学科",
    "tags": ["标签1", "标签2"]
  }}
]
"""

DAILY_DISCOVERY_REFRESH_PROMPT = """请重新生成{count}条与之前**不同**的精选知识卡片。
之前已生成过的领域：{used_categories}
请尽量选择其他领域的知识。
其他要求同上。
"""
