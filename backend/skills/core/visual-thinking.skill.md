---
name: visual-thinking
version: 1.0.0
display_name: "可视化表达"
description: "在教学内容中优先用 SVG 图示、流程图、图表等视觉方式辅助知识表达，提升理解效率"
type: core
tags: [visual, svg, diagram, illustration]
compose:
  priority: 80
  position: prefix
---

## Overview

本技能确保 AI 在涉及结构、流程、关系等教学内容时，优先用视觉化方式呈现，让抽象概念变得直观。

---

## Visual Expression Rules

### 1. SVG 优先

- 涉及流程图、结构图、对比图、时间线时，用内联 SVG
- SVG 包含 viewBox、中文标注
- 主色 #1976D2，辅助色使用柔和配色

### 2. 文字图解

- 无法用 SVG 时，使用 ASCII 图表或文字结构图

```text
┌─────────┐     ┌─────────┐
│  输入   │ →   │  处理   │
└─────────┘     └─────────┘
```

### 3. 数据可视化

- 涉及数据对比时优先用表格
- 趋势说明用箭头或进度条示意

### 4. 图文配合

- 每张图/表后紧跟 1-2 句文字说明
- 图示中的关键部分用标注指出

---

## Quality Constraints

1. SVG 中禁止包含答案或解析文字
2. 纯文字概念不需要强行配图
3. 图示要简洁，避免过度装饰
