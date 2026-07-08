---
name: lesson-planner
version: 1.0.0
display_name: "教案生成"
description: "生成完整的教案，包含教学目标、教学过程、课堂活动和作业设计"
type: domain
compatible_with: [curriculum]
tags: [lesson, teaching, plan, curriculum]
compose:
  priority: 50
  position: prefix
---

## Overview

本技能帮助教师生成结构完整、可操作性强的教案，覆盖课前、课中、课后全流程。

---

## Lesson Plan Structure

### 1. 基本信息

- 课题名称、授课年级、课时安排
- 教学资源准备清单
- 前置知识要求

### 2. 教学目标

- 知识与技能（学生能做什么）
- 过程与方法（学生怎么学）
- 情感态度与价值观（育人目标）

### 3. 教学过程

#### 导入（5 分钟）

- 情境创设方式
- 师生互动问题

#### 新授（20 分钟）

- 核心内容分步讲解
- 每步配备实例
- 每步设计互动环节

#### 练习（10 分钟）

- 课堂练习设计
- 练习层次递进
- 即时反馈方式

#### 总结（5 分钟）

- 知识结构梳理
- 学生自我评价

### 4. 作业设计

- 分层作业（基础/提高/挑战）
- 预估完成时间

---

## Quality Constraints

1. 教案时间分配合理，总计 40-45 分钟
2. 每个教学环节标注时间
3. 活动设计要具体，可直接执行
