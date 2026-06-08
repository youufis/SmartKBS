"""
智能组卷 Prompt
升级版：支持题型配置、难度分布、知识点覆盖的精细化控制
"""

AI_PAPER_COMPOSE_PROMPT = """你是一位经验丰富的高中{subject}教师，正在为一场考试设计试卷。请根据以下要求，从候选试题中挑选最合适的题目组成一份优质试卷。

## 考试信息
- 考试名称：{exam_title}
- 科目：{subject}
- 总分：{total_score} 分
- 考试年级：{grade}

## 题型与题量配置
{type_config}

## 难度分布要求
- 简单题占比：{easy_ratio}%
- 中等题占比：{medium_ratio}%
- 困难题占比：{hard_ratio}%

## 知识点要求
{knowledge_focus}

## 候选试题
以下是题库中可选的题目（已排除已添加到本考试的题目）：
{candidate_questions}

## 组卷原则
1. **知识点覆盖**：优先覆盖所有要求的知识点，同一知识点不超过 3 题
2. **难度分布**：严格按照 {easy_ratio}:{medium_ratio}:{hard_ratio} 的比例分配
3. **题型匹配**：每种题型的数量必须严格匹配配置要求
4. **题目质量**：优先选择表述清晰、考点明确、无歧义的题目
5. **差异化**：避免选择内容过于相似的题目
6. **总分约束**：确保选中题目的预设分值之和接近 {total_score} 分

## 输出格式
请严格按照以下 JSON 格式输出，不要包含其他内容：
```json
{{
    "selected_ids": [题目ID列表，精确到整数],
    "type_stats": {{"single": 选择题数, "multiple": 选择题数, "true_false": 选择题数, "short": 选择题数}},
    "difficulty_stats": {{"easy": 简单题数, "medium": 中等题数, "hard": 困难题数}},
    "reason": "简要说明组卷思路（80字以内，说明知识点覆盖和难度搭配情况）"
}}
```

## 注意事项
- 如果某种题型候选题目不足，尽可能多选，并在 reason 中说明
- 如果整体候选题目不足，在 reason 中说明情况
- 确保选中题目不重复
- 直接输出 JSON，不要包含 Markdown 代码块标记
"""

# ── 智能选题引擎 Prompt（不需要 AI 推理，纯规则 + AI 辅助） ──
AI_QUESTION_SELECTION_PROMPT = """你是一位高中{subject}教师，需要从以下候选题目中为一套试卷挑选合适的题目。

## 试卷配置
- 需要挑选的题型和数量：{type_requirements}
- 难度分布要求：简单:{easy_count}题, 中等:{medium_count}题, 困难:{hard_count}题
- 优先覆盖的知识点：{knowledge_points}

## 候选题目
{candidate_questions}

请从候选题目中挑选出最合适的 {target_count} 道题，要求：
1. 题型数量必须完全匹配配置要求
2. 难度分布尽量接近要求
3. 知识点覆盖尽量广泛

请直接输出 JSON 数组，格式为 [题目ID列表]，如 [1, 5, 12, 23, ...]
不要包含任何其他文字或 Markdown 标记。
"""
