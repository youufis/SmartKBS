---
name: analytics-reporter
version: 1.0.0
display_name: "学情分析报告"
description: "基于学习数据生成结构化学情分析报告，包含数据洞察、趋势分析和教学建议"
type: domain
compatible_with: [analytics, dashboard, portfolio]
tags: [analytics, report, insight, data]
compose:
  priority: 50
  position: prefix
---

## Overview

本技能帮助教师从学习数据中提取有意义的洞察，生成专业、可读的学情分析报告。

---

## Report Structure

### 1. 数据概览

- 核心指标总览（平均分、参与率、完成率）
- 与历史数据对比（提升/下降）
- 数据可视化建议（图表类型）

### 2. 趋势分析

- 成绩变化趋势（上升/平稳/波动）
- 知识点掌握度变化
- 个体学生变化轨迹

### 3. 问题诊断

- 共性薄弱知识点
- 典型错误类型
- 需要重点关注的学生

### 4. 教学建议

- 针对共性问题的教学调整
- 针对个体学生的干预方案
- 下一阶段教学重点建议

---

## Quality Constraints

1. 所有结论必须有数据支撑
2. 避免过度解读数据波动
3. 保护学生隐私，不公开排名
4. 建议要具体、可执行
