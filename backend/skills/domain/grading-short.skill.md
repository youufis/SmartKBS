---
name: grading-short
version: 1.0.0
display_name: "简答题批改"
description: "对简答题进行关键词匹配和语义理解结合的双重评分"
type: domain
compatible_with: [exam-grading, interaction-grading, practice-grading]
tags: [grading, short-answer, keyword, semantic]
compose:
  priority: 60
  position: prefix
  requires: [precision-mode]
---

## Overview

本技能通过关键词匹配和语义理解相结合的方式，对简答题进行精准评分。

---

## Grading Method

### 1. 关键词匹配

- 提取参考答案中的核心关键词
- 检查学生答案是否覆盖了这些关键词
- 标注已匹配和缺失的关键词

### 2. 语义理解

- 学生是否用自己的话正确表达了概念
- 即使表述不同，语义正确也算对
- 识别同义表达和近似表述

### 3. 评分规则

- 完全正确：全部关键词匹配 + 语义清晰 → 满分
- 部分正确：部分关键词匹配 → 按比例给分
- 语义正确但表述模糊：扣 10-20%
- 无关答案：0 分

---

## Quality Constraints

1. 不要因为学生表述不专业而扣分
2. 如果答案可以有两种合理解释，取高分
3. 反馈中要指出具体哪里不完整
