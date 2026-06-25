"""
AI 代码审查 Prompt
用于分析学生提交的代码，从正确性、代码质量、效率、规范等维度给出评价
"""

CODE_REVIEW_PROMPT = """请对学生的编程代码进行审查分析。

## 题目信息
- 题目：{problem_title}
- 编程语言：{language}

## 学生的代码
```{language}
{source_code}
```

## 审查要求
请从以下 6 个维度进行全面分析，用 JSON 格式输出：

### 1. 正确性 (Correctness)
- 代码是否能正确实现题目要求？
- 是否存在逻辑错误或边界条件未处理？

### 2. 代码质量 (Code Quality)
- 命名规范（变量、函数命名是否清晰）
- 代码结构（是否模块化、是否冗余）
- 注释质量（是否有关键注释）

### 3. 算法效率 (Efficiency)
- 时间复杂度和空间复杂度分析
- 是否有更优的算法方案

### 4. 编码规范 (Style)
- PEP 8 规范遵守情况
- 缩进、空格、空行是否规范

### 5. 常见错误 (Common Mistakes)
- 初学者容易犯的错误
- 安全隐患（如 eval、SQL 注入等，仅当有相关代码时指出）

### 6. 改进建议 (Improvements)
- 具体的代码修改建议
- 推荐的学习资源或练习方向

## 输出格式
请严格按以下 JSON 格式输出，不要包含其他内容：
```json
{{
    "overall_rating": "优秀/良好/一般/需努力",
    "overall_score": <0-100的整数>,
    "dimensions": {{
        "correctness": {{
            "score": <0-100>,
            "comment": "<分析内容>",
            "issues": ["问题1", "问题2"]
        }},
        "code_quality": {{
            "score": <0-100>,
            "comment": "<分析内容>",
            "issues": ["问题1", "问题2"]
        }},
        "efficiency": {{
            "score": <0-100>,
            "comment": "<分析内容>",
            "issues": ["问题1"]
        }},
        "style": {{
            "score": <0-100>,
            "comment": "<分析内容>",
            "issues": ["问题1"]
        }}
    }},
    "strengths": ["优点1", "优点2"],
    "weaknesses": ["不足1", "不足2"],
    "suggestions": ["建议1", "建议2"],
    "improved_code": "改进后的代码（只输出关键的改进部分，用注释标出修改点）"
}}
```

## 注意事项
1. 语气亲切、鼓励为主，对初学者要保护学习积极性
2. 建议要具体、可操作，不要只说"改进代码质量"
3. 对正确性要严格把关，但评分要适当考虑学生的年级水平
4. 如果是高中生的代码，不要用业界顶级标准苛求
5. 对于完全正确的代码，可以给出进一步学习的建议（如扩展功能、优化性能）
"""


CODE_REVIEW_SHORT_PROMPT = """请对以下 {language} 代码进行简要审查，分析代码质量并给出改进建议。

代码功能：{problem_title}

```{language}
{source_code}
```

请用 JSON 格式回复：
{{
    "overall_score": <0-100>,
    "overall_comment": "<总体评价，20-50字>",
    "issues": ["问题1", "问题2"],
    "suggestions": ["建议1", "建议2"],
    "improved_code": "改进片段"
}}
"""
