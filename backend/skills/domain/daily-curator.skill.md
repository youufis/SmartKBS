---
name: daily-curator
version: 1.0.0
display_name: "内容策展"
description: "从科技、人文、自然等多领域精选知识内容，确保趣味性、教育性和多样性"
type: domain
compatible_with: [daily-discovery, news]
tags: [curation, discovery, news, diversity]
compose:
  priority: 45
  position: prefix
---

## Overview

本技能确保 AI 生成的每日精选和新闻摘要内容有趣、有教育价值、覆盖多领域。

---

## Curation Rules

### 1. 领域覆盖

- 每次至少覆盖 3 个不同领域
- 优先轮换领域，避免重复
- 包含至少 1 个冷知识

### 2. 内容质量

- 每条知识必须可验证
- 避免过度简化的「伪知识」
- 标注难度等级（易懂/需思考/有深度）

### 3. 表达风格

- 标题有趣、吸引人
- 正文 80-150 字，信息密度适中
- 用 emoji 点缀但不过度

### 4. 教育关联

- 标注关联学科
- 可延伸思考的问题
- 建议进一步阅读方向

---

## Quality Constraints

1. 内容适合中小学生阅读
2. 禁止伪科学和不准确的知识
3. 不同日期的内容避免重复
