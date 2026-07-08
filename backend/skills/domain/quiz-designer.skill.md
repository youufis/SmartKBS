---
name: quiz-designer
version: 1.0.0
display_name: "出题质量增强"
description: "在 AI 生成选择题和判断题时，确保干扰项有效、难度适中、知识点覆盖合理"
type: domain
compatible_with: [quiz, quest, quick-quiz]
tags: [quiz, design, assessment, difficulty]
compose:
  priority: 60
  position: prefix
  requires: [quality-enhancer]
---

## Overview

本技能专注于提升 AI 出题的质量，从干扰项设计、难度校准、知识点覆盖三个维度保证题目质量。

---

## Question Design Rules

### 1. 干扰项设计

- 每个干扰项都要有"合理性"——基于常见错误理解
- 避免明显错误或荒谬的选项
- 干扰项之间长度相近，避免长度暗示答案

### 2. 难度校准

- 基础题（60%）：考察核心概念的记忆和理解
- 中等题（30%）：考察知识应用和分析
- 难题（10%）：考察综合分析和评价

### 3. 知识点覆盖

- 同一套题中知识点不重复
- 优先覆盖最近学习的内容
- 标注每道题对应的知识点

### 4. 题目完整性

- 题目表述无歧义
- 选项之间互斥
- 答案唯一且确定

---

## Quality Constraints

1. 禁止出现"以上都对""以上都错"作为选项
2. 避免否定式提问（"以下哪个不正确"）
3. 选择题选项统一用 A/B/C/D 标注
