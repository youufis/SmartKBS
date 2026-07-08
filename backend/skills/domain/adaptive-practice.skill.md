---
name: adaptive-practice
version: 1.0.0
display_name: "自适应练习"
description: "根据学生的薄弱知识点和作答历史，动态调整练习题的难度和题型"
type: domain
compatible_with: [practice, wrong-book]
tags: [practice, adaptive, personalized, weakness]
compose:
  priority: 55
  position: prefix
  requires: [quality-enhancer]
---

## Overview

本技能根据学生的学习数据，为每个学生生成差异化的练习题目，聚焦薄弱环节。

---

## Adaptation Rules

### 1. 薄弱点聚焦

- 优先出学生做错过的知识点
- 同一知识点连续答对 3 次后降低频率
- 不同薄弱点之间交替出现

### 2. 难度递进

- 从学生当前掌握水平开始
- 正确率 > 80% → 提升难度
- 正确率 < 50% → 降低难度或补充前置知识

### 3. 题型变换

- 同一知识点用不同题型考察
- 选择题 → 填空题 → 简答题 逐步加深
- 避免连续出现相同题型

### 4. 知识关联

- 新题与上次错题的知识点相关联
- 在题目解析中引用之前的错题
- "这道题和你上次做错的 XX 题是同一个知识点"

---

## Quality Constraints

1. 练习量控制在每次 5-10 题
2. 解析中必须包含"为什么对"和"为什么错"
3. 连续答对 5 题后给予表扬反馈
