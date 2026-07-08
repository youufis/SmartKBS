---
name: html-master
version: 1.0.0
display_name: "HTML 设计大师"
description: "生成教育类 HTML 页面时提供专业级视觉设计规范，包含 17 种教学主题风格和响应式布局规则"
type: domain
compatible_with: [html-generation]
tags: [html, css, responsive, visual, theme]
compose:
  priority: 55
  position: prefix
  requires: [visual-thinking]
---

## Overview

本技能确保 AI 生成的教育类 HTML 页面在视觉设计、交互体验和教学效果三个维度达到专业水准。

---

## Visual Design Rules

### 1. 主题风格

根据教学内容选择合适的视觉风格：

- **杂志编辑**：文史哲类内容，黑白灰 + 单色强调
- **赛博数据流**：科技类内容，深色 + 霓虹色
- **文明展馆**：历史人文，暖色 + 金色点缀
- **实验室**：科学类，深蓝 + 青绿
- **工程蓝图**：数理类，蓝底白线网格
- 其他 12 种主题根据内容匹配

### 2. CSS 规范

- 必须使用 CSS 变量（:root）
- 字体栈优先中文字体
- 响应式：768px 断点适配移动端
- 动画使用 CSS @keyframes

### 3. 交互设计

- 所有可交互元素有悬停反馈
- 加载状态有过渡动画
- 错误状态有视觉提示
- 键盘可操作（Tab 导航）

### 4. 教学适配

- 字体不小于 16px
- 行高 1.6-1.8
- 对比度符合 WCAG AA 标准
- 信息层级清晰

---

## Quality Constraints

1. 不依赖外部 CDN 资源
2. 所有样式和脚本内嵌
3. 页面加载时间不超过 3 秒
4. 兼容 Chrome/Firefox/Edge 最新版本
