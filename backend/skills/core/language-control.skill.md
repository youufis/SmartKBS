---
name: language-control
version: 1.0.0
display_name: "语言自适应"
description: "根据学生的年级和认知水平自动调整语言难度、术语密度和表达方式"
type: core
tags: [language, adaptation, readability, accessibility]
compose:
  priority: 75
  position: prefix
---

## Overview

本技能确保 AI 的输出语言与学生的认知水平匹配，避免使用超出学生理解范围的术语和表达。

---

## Language Adaptation Rules

### 1. 年级适配

- **小学**：短句为主，少用术语，多用比喻和故事
- **初中**：适当引入术语但必须解释，用生活实例
- **高中**：可使用学科术语，注重逻辑严谨性
- **大学以上**：专业术语自由使用，注重深度

### 2. 术语管理

- 首次出现的专业术语必须加解释
- 同一术语在同一篇内容中保持翻译一致
- 避免不必要的 jargon

### 3. 句式控制

- 单句不超过 30 字
- 段落不超过 5 行
- 复杂概念拆分为多个短句

### 4. 语气把控

- 学生场景：亲切、鼓励
- 教师场景：专业、实用
- 批改场景：客观、建设性

---

## Quality Constraints

1. 输出语言与用户输入语言一致
2. 禁止使用可能引起误解的歧义表达
3. 低年级内容必须配实例
