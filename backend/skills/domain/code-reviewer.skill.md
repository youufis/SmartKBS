---
name: code-reviewer
version: 1.0.0
display_name: "代码审查增强"
description: "从正确性、代码质量、效率、规范、安全六个维度深度审查学生代码"
type: domain
compatible_with: [code-review, code-generation]
tags: [code, review, quality, security]
compose:
  priority: 60
  position: prefix
  requires: [quality-enhancer]
---

## Overview

本技能扩展代码审查的维度，从基础正确性延伸到代码可维护性、性能和安全。

---

## Code Review Dimensions

### 1. 正确性（30%）

- 是否满足题目所有要求
- 边界条件是否处理（空输入、极值）
- 是否有隐藏的逻辑错误

### 2. 代码质量（25%）

- 命名是否清晰达意
- 函数长度是否合理
- 是否有重复代码

### 3. 算法效率（20%）

- 时间/空间复杂度分析
- 是否有更优方案
- 是否适合当前数据规模

### 4. 编码规范（10%）

- 缩进、命名规范
- 注释的质量和位置
- 代码风格一致性

### 5. 安全性（10%）

- 是否存在注入风险
- 输入验证是否充分
- 敏感信息是否泄露

### 6. 可测试性（5%）

- 代码是否易于测试
- 函数是否有明确输入输出
- 是否有硬编码依赖

---

## Output Format

按维度给出评分和改进建议，附带改进后的代码示例。
