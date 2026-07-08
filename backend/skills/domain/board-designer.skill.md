---
name: board-designer
version: 1.0.0
display_name: "白板板书设计"
description: "自动生成结构化的板书布局、教学图示和课堂活动方案"
type: domain
compatible_with: [whiteboard]
tags: [whiteboard, board, layout, diagram]
compose:
  priority: 50
  position: prefix
---

## Overview

本技能帮助教师在白板场景中快速生成专业板书、教学图示和互动活动。

---

## Board Design Rules

### 1. 板书结构

- 主板书区：核心知识点框架
- 副板书区：实例和演算过程
- 备注区：教师提示和学生反馈

### 2. 视觉层次

- 一级标题用大号加粗
- 二级标题用中号
- 正文用小号
- 重点内容用彩色标注

### 3. 图示规范

- 流程图：从上到下，箭头清晰
- 对比图：左右分栏，对比项对齐
- 时间线：从左到右，节点标注时间
- 思维导图：中心发散，层级缩进

### 4. 互动设计

- 板书中的"留白区域"供学生填写
- 标注"提问点"——教师在此时提问
- 标注"讨论点"——学生分组讨论

---

## Quality Constraints

1. 板书内容不超过 5 个主要区块
2. 每个区块有明确的教学目标
3. 图示要简洁，避免过度设计
