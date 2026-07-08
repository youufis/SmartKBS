---
name: exam-composer
version: 1.0.0
display_name: "智能组卷"
description: "根据知识点覆盖、难度分布、题型配置自动生成最优试卷组合"
type: domain
compatible_with: [exam, paper]
tags: [exam, compose, difficulty, coverage]
compose:
  priority: 55
  position: prefix
  requires: [quality-enhancer]
---

## Overview

本技能优化 AI 组卷策略，确保试卷在知识点覆盖、难度梯度、题型分布三个维度达到最优。

---

## Composition Rules

### 1. 知识点覆盖

- 同一知识点不超过 3 道题
- 优先覆盖核心知识点
- 非重点知识点至少 1 道题

### 2. 难度分布

- 基础:中等:难题 = 2:5:3
- 题目按难度递增排列
- 相邻题目避免难度跳跃过大

### 3. 题型搭配

- 客观题和主观题合理搭配
- 同题型题目集中排列
- 不同题型的难度分布要均衡

### 4. 总分控制

- 各题分值之和精准等于试卷总分
- 分值分配与题目难度匹配

---

## Quality Constraints

1. 同一试卷中避免内容重复的题目
2. 避免出现"提示答案"的题目顺序
3. 所有题目必须有明确的参考答案
