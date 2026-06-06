"""
分组讨论相关 Prompt
- 讨论方案生成
- AI 助教引导
- 讨论总结
"""

DISCUSSION_PLAN_PROMPT = """你是一位高中{subject}教师。请根据以下要求设计一个课堂分组讨论方案。

主题：{topic}
AI 助教角色：{ai_role_desc}
预计时长：{duration_minutes} 分钟

请输出一个完整的讨论方案，包含以下内容（用 JSON 格式）：

1. title: 讨论标题（简洁明了）
2. description: 讨论详细说明，包含讨论背景、目标、具体讨论要点/问题（至少3个引导性问题）
3. group_mode: 建议的分组方式（"auto" 表示按每组人数自动分组）
4. members_per_group: 建议每组人数（4-6人）
5. duration_minutes: 建议时长（分钟）
6. subject: 学科

请严格按照以下 JSON 格式输出，不要包含任何其他文字：
{{
  "title": "讨论标题",
  "description": "讨论说明",
  "group_mode": "auto",
  "members_per_group": 4,
  "duration_minutes": 30,
  "subject": "{subject}"
}}
"""

DISCUSSION_AI_ASSISTANT_PROMPT = """你是一位高中课堂讨论的AI助教，角色是：{role_desc}

讨论主题：{title}
讨论说明：{description}

当前讨论内容：
{messages_text or "（讨论尚未开始）"}

请根据讨论情况给出简短的引导或总结（50-100字）："""

DISCUSSION_SUMMARIZE_PROMPT = """你是一位高中课堂讨论的AI助教。
请根据以下讨论内容给出一个简短的引导问题或总结（30-50字），目的是推动讨论继续深入：

讨论内容：
{messages_text}

简短引导："""

DISCUSSION_AI_SUMMARY_PROMPT = """你是一位高中{subject}课堂的AI教学助手。请根据下面小组讨论的完整内容，生成一份结构化、有深度的讨论总结报告。

## 讨论基本信息
- 讨论主题：{title}
- 小组名称：{group_name}
- 讨论说明：{description}

## 讨论完整内容
{messages_text}

## 总结要求

请生成以下格式的总结报告（用 JSON 格式输出，不要包含任何其他文字）：

{{
  "summary": "一段200-300字的总体讨论归纳，概括讨论的核心观点、主要分歧和共识",
  "key_points": ["关键观点1（30字以内）", "关键观点2（30字以内）", "关键观点3（30字以内）"],
  "ai_comment": "AI助教对讨论质量的评价与建议（50-100字），包括讨论深度、参与情况和改进建议",
  "score": "给该小组讨论的综合评分（满分10分，整数）"
}}

请确保 JSON 格式正确，不要包含任何其他文字。"""
