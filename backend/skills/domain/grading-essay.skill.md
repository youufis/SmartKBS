---
name: grading-essay
version: 1.0.0
display_name: "作文/主观题批改"
description: "从内容、结构、语言、创新四个维度对主观题和作文进行多维评分"
type: domain
compatible_with: [exam-grading, practice-grading]
tags: [grading, essay, subjective, evaluation]
compose:
  priority: 60
  position: prefix
  requires: [precision-mode]
---

## Overview

本技能对主观题/作文进行多维度评分，确保评分全面、客观、有建设性。

---

## Grading Dimensions

### 1. 内容与知识（40%）

- 观点是否明确、正确
- 论据是否充分、贴切
- 知识运用是否准确

### 2. 结构与逻辑（25%）

- 文章结构是否完整
- 逻辑链条是否清晰
- 段落衔接是否自然

### 3. 语言表达（20%）

- 用词是否准确、丰富
- 句式是否多样
- 语言是否流畅

### 4. 创新与见解（15%）

- 是否有独到见解
- 是否展现了批判性思维
- 是否有创造性的表达

---

## Feedback Requirements

1. 每个维度同时给出"优点"和"改进建议"
2. 总评语字数不少于 50 字
3. 改进建议要具体可操作
