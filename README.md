# 智慧教学平台 (SmartKBS)

> **版本 V5.4.0** | 更新于 2026-06-14

> 通用学科 AI 智慧教学管理平台（全学段：小学/初中/高中通用技术、信息科技等学科）
> 集成流式 AI 对话、资源管理、试题库、在线考试、智能组卷 & Word 导出、
> 任务管理、AI 智能批改、课程大纲、课堂互动、分组讨论、知识抢答活动、积分奖励、课堂积分、
> 智能点名、考勤统计、错题巩固、智能练习、AI 资源推荐、学情分析、成长档案等功能。
> 基于 **FastAPI + React** 构建。

![版本](https://img.shields.io/badge/版本-5.4.0-blue)
![后端](https://img.shields.io/badge/后端-FastAPI-green)
![前端](https://img.shields.io/badge/前端-React%2BTypeScript-blue)
![AI](https://img.shields.io/badge/AI-DashScope-orange)
![许可证](https://img.shields.io/badge/许可证-AGPL--3.0-red)

---

## 📋 项目简介

**SmartKBS** 是一款通用学科的 AI 智能问答与教学管理平台。
系统基于 **FastAPI + React** 构建，融合云端 AI 能力（阿里云 DashScope 与 DeepSeek），
为教师和学生提供全方位教学辅助服务。

> 💡 **学科无关设计**：平台以高中信息科技、通用技术课程为例进行开发设计，
> 但不限定特定学科。通过配置 AI 智能体（Agent）的知识库内容，可接入任意学科的教学资源。
> 教师可根据自身教学需要，自由配置学科知识库，实现个性化教学支持。

---

## 🎮 演示环境

> **🌐 演示地址：** [http://youufis.oicp.net:8086](http://youufis.oicp.net:8086)
>
> **⏰ 开放时间：** 日间开放（晚间关机）
>
> **👤 测试账号：**
>
> | 角色 | 用户名              | 密码          |
> |------|---------------------|---------------|
> | 教师 | youufis             | ultraultra    |
> | 学生 | s11001 ~ s11009     | 123456        |
> | 学生 | s18001 ~ s19009     | 123456        |

---

## ✨ 功能总览

### 📊 首页仪表盘

登录后进入智能首页，按角色聚合展示关键数据：

- **学生端**：待完成考试数、已完成考试数、累计积分与排名、活跃任务数、待答测验数、已参与投票数、近期考试成绩、系统公告、最近活动时间线、快速入口
- **教师/管理员端**：考试概览（总数/草稿/已发布/已结束）、任务提交统计、学生总数、本周点名次数、随堂测验/投票概览、今日对话数、快速入口

> **所有登录用户可用**

### 💬 AI 对话

核心智能问答界面，支持流式对话、文件上传（图片/文档）、图像理解、文件摘要增强、RAG 学科知识增强、历史记录检索、HTML 预览、多模型切换。

> **所有登录用户可用**

### 📄 资源中心

以卡片网格展示 HTML 教学资源文件，支持共享/取消共享操作：

- **管理员共享**：可选择「所有人」「指定教师」「指定年级/班级」
- **教师共享**：可选择「管理员和教师」+「自己的班级」

> **所有登录用户可用；学生仅查看共享资源**

### 📁 资源管理

上传/删除/重命名教学资源文件（HTML/CSS/JS/图片/文档等），每位教师拥有独立资源目录，支持文件共享操作。

> **管理员和教师可用**

### 📚 资源分类导航

按分类（通用技术、信息技术、人工智能通识、PUZZLE益智、课堂互动、文件中心）浏览公共教学资源。

> **管理员和教师可用**

### 📖 课程大纲

课程→章→节→知识点四级树形结构：

- **AI 智能生成**：支持文本输入或文件上传（txt/md/pdf/docx），AI 自动提取课程结构
- **手动管理**：添加、编辑、删除课程/章节/知识点，支持同级/跨层级拖拽排序
- **资源绑定**：为知识点绑定 HTML 课件、考试、讨论、随堂测验、任务等 6 类资源
- **学习进度追踪**：学生标记知识点完成状态，实时显示进度条
- **教师总览**：全班学生知识点完成进度矩阵，支持按年级/班级筛选

> **管理员和教师可管理；学生可查看并标记学习进度**

### 📝 试题管理

AI 智能试题库系统：

- **AI 一键生成**：按科目、题型、知识点、难度和数量自动生成试题
- **智能提取**：支持粘贴文本或上传 .docx / JSON 文件，自动识别题型、选项和答案
- **题型支持**：单选题、多选题、判断题、简答题
- **多媒体支持**：全面支持 LaTeX 公式（$...$）和配图显示
  - SVG 绘制技术图示，通义万相生成实物图片
  - 配图支持生成、预览、删除，并发生成优化

> **管理员和教师可用**

### 📝 考试发布

完整在线考试系统：

- **创建配置**：设置标题、科目、时长、总分、及格分、题目/选项乱序、答题次数、时间范围
- **组卷方式**：智能选题（按条件筛选）或手动选题
- **考试流程**：发布/结束控制，学生在线答题（实时倒计时），客观题自动批改
- **消息通知**：发布/取消/修改/提前结束时自动通知

> **管理员和教师可创建管理；学生可参加已发布的考试**

### 📄 智能组卷 & Word 导出

分步引导式组卷向导（配置 → 组卷 → 导出）：

- **题型题量配置**、难度分布、知识点范围筛选
- **AI 智能选题**或**规则选题**（按难度比例随机）
- **组卷统计面板**：实时题型/难度分布、总分，支持手动移除题目
- **Word 导出**：试卷（学生用）、答案卷（红色答案+蓝色解析）、答题卡
- **LaTeX 公式渲染**为图片嵌入，SVG 配图自动转 PNG

> **管理员和教师可用**

### ✅ 任务管理

教师发布任务，学生提交 AI 对话内容作为作业，支持查看提交详情、撤销提交、结束任务。

> **所有登录用户可用，按角色功能区分**

### 📥 文件中心

管理下载目录中的文件，支持上传/下载/删除、配额管理、目录共享（整个目录自动继承权限）。

> **管理员和教师可用；学生可查看共享文件**

### 📕 错题巩固

自动归集学生错题，按考试归类展示。支持 AI 一键生成个性化复习计划（错题分析、知识点复习建议、针对性练习）。教师可按年级→班级→学生三级联动查看。

> **所有登录用户可用**

### 📝 智能练习（定向出题）

AI 驱动的定向练习系统，从错题本生成针对性练习题，支持定向推送至班级或指定学生。学生在线作答后 AI 自动批改简答题。异步出题，不阻塞界面。

> **管理员和教师可出题管理；学生可参与**

### 🤖 AI 教学资源推荐

根据知识点内容，AI 自动分析并推荐关联的 HTML 课件、考试试卷、课堂讨论、随堂测验等资源，支持一键绑定。AI 也可根据知识点自动生成完整 HTML 课件。

> **管理员和教师可用**

### 🎯 课堂互动工具

随堂测验、快速投票、课堂提问三合一：

- **随堂测验**：可视化编辑器创建（单选/多选/判断），AI 自动生成，自动评分，支持配图和公式
- **快速投票**：单选/多选模式，AI 自动生成，实时柱状图统计
- **课堂提问**：学生发起（支持匿名），教师回答或 AI 辅助回答，仅本班可见

> **所有用户可用，按角色和班级区分**

### 👥 分组讨论

AI 助教辅助的课堂分组讨论系统：

- **创建讨论**：支持自动/手动/随机分组，AI 助教角色（旁观者/引导者/主动参与/辩论裁判）
- **参与讨论**：学生进入独立讨论室实时聊天，AI 助教自动参与
- **讨论管理**：教师查看所有分组消息，结束讨论后 AI 自动生成结构化总结报告（含关键观点、AI 评价与评分）

> **管理员和教师可创建管理；学生可参与本班讨论**

### ⚡ 知识抢答活动

实时多人在线抢答竞赛系统，支持 WebSocket 同步出题、即时计分、自动排名。
教师创建房间设置限时与题目来源（题库/AI 生成），学生输入房间码参与抢答。
答对 +1 分，答错 −2 分，活动结束后自动生成排行榜与每题回顾。

> **管理员和教师可创建管理；学生可参与抢答**

### 🏆 课堂积分

课堂积分激励系统，支持多教师独立管理积分、排行榜、学生管理，数据持久化至数据库。

> **管理员和教师可用；学生可查看**

### 🏆 积分奖励体系

参与课堂活动（测验/投票/提问/考试/练习/讨论等）自动获得积分：参与基础分 +2，优秀（≥90%）+15、良好（≥75%）+10、及格（≥60%）+5。含等级称号（学神/学霸/进阶/新秀/起步）和班级排名。

> **管理员和教师可用；学生可查看**

### 🎯 点名管理

智能点名系统，基于权重比例的公平随机抽取，权重自然衰减，轮次管理（覆盖超 60% 自动重置），历史记录追踪。

> **管理员和教师可用**

### 📋 考勤统计

学生登录时自动记录时间、IP、浏览器信息。按班级展示登录率、学生明细及历史登录记录。教师仅查看本班，管理员可查看全部。

> **管理员和教师可用**

### 👤 学生成长档案

聚合学生全维度学习数据（考试、积分、点名、任务、对话），含综合摘要、成绩走势图、积分趋势图、成长时间轴。

> **学生查看自己；教师/管理员可查看任何学生**

### 🔬 AI 智能学情分析

利用 AI 对学习数据深度分析，生成班级学情报告（整体评价、亮点、薄弱环节、建议）和考试分析报告（分数分布、逐题正确率、教学改进建议）。

> **教师和管理员可用**

### 📊 数据导出

支持将考试、点名、课堂互动等数据导出为 Excel/CSV 格式。

> **教师和管理员可用**

### 🔔 消息通知系统

顶栏铃铛实时显示未读通知，自动触发资源分享、考试发布/变更/提交等通知。支持全部/未读筛选、标记已读、全部已读、删除。通知类型可在系统配置中管理。

> **所有登录用户可用**

### 📢 系统公告

管理员/教师可发布带优先级（普通/重要/紧急）和置顶功能的公告，支持按角色、年级、班级限定可见范围。

> **所有登录用户可查看；管理员和教师可发布**

### 👥 用户管理

完整的账号管理（注册、信息更新、密码修改、删除、CSV 导入），支持管理员/教师/学生三种角色。教师可设置任教年级班级，用于考试和任务的可见性过滤。

> **管理员和教师可用；学生仅改密**

### ⚙️ 系统配置

集中管理品牌信息、API 密钥（DashScope / DeepSeek）、
模型参数（APPID/模型名称/API 地址）、系统限制（文件大小/Token 有效期/
在线超时/频率限制）、下载配额、通知类型、生图参数。
支持按用户独立配置 API Key。

> **仅管理员可用**

---

## 📄 许可证

本项目基于 **GNU Affero General Public License v3.0 (AGPL-3.0)** 开源。

Copyright © 2026 youufis

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published
    by the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the

---

## 📦 更新日志

### v5.4.0 (2026-06-14)

🎯 **全学段年级班级重构**

- **年级体系重构**：新增 `grades`/`classes`/`teacher_assignments` 三张核心表，支持小学/初中/高中全学段
- **统一权限服务**：新建 `permission_service.py`，集中管理所有年级班级权限判断，替代散落各处的管道解析逻辑
- **教师任教关系规范化**：多年级多班级从字符串拼接改为关系表存储，支持精确权限控制
- **格式统一**：`users.class` 统一为纯数字格式，消除"1"与"1班"不一致问题
- **动态加载**：所有年级/班级下拉框基于实际数据动态加载，无硬编码
- **兼容降级**：旧管道格式数据自动迁移，新表无数据时回退旧格式

### v5.3.0 (2026-06-13)

- 历史版本功能
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.

---

## 🚀 快速开始

### 环境要求

- Python 3.9+

> 前端已预编译至 `frontend/dist/`，**无需 Node.js / npm**。如需修改前端代码，才需要 Node.js 18+。

### 1️⃣ 启动后端服务

```bash
# 方式一：直接启动
cd D:\SmartKBS
python backend/main.py

# 方式二：使用 Uvicorn 启动
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8086 --reload
```

后端服务默认运行在 `http://localhost:8086`，自动提供前端静态文件服务。

### 2️⃣ 启动前端开发服务器（仅开发/修改前端时需要）

```bash
cd frontend
npm install
npm run dev
```

前端开发模式默认运行在 `http://localhost:5173`

### 3️⃣ 默认管理员登录

| 用户名 | 密码 |
|--------|------|
| root   | root |

### 4️⃣ 配置 AI 服务

在 _系统配置_ 页面设置 DashScope API Key 或 DeepSeek API Key，
或在 _系统配置 → API 密钥管理_ 中为每个用户单独配置。

---

## 📁 项目结构

```text
SmartKBS/
├── backend/                # FastAPI 后端
│   ├── main.py             # 入口文件（路由挂载、静态文件服务）
│   ├── config.py           # 全局配置常量
│   ├── database.py         # 数据库连接管理（smartkb.db）
│   ├── question_db.py      # 试题库数据库（questions.db）
│   ├── auth.py             # JWT 认证 + bcrypt 密码哈希
│   ├── middleware.py        # 认证中间件
│   ├── logger.py           # 统一日志配置
│   ├── rag.py              # RAG 检索增强生成
│   ├── paper_generator.py  # Word 试卷生成引擎（python-docx）
│   ├── reward_engine.py    # 积分奖励引擎
│   ├── ai_task_manager.py  # AI 异步任务管理器
│   ├── system_config.json  # 运行时配置
│   ├── api/                # API 路由模块
│   │   ├── auth_router.py, chat_router.py, users_router.py
│   │   ├── question_router.py, exam_router.py, paper_router.py
│   │   ├── score_router.py, rollcall_router.py
│   │   ├── dashboard_router.py, analytics_router.py
│   │   ├── interaction_router.py, discussion_router.py
│   │   ├── curriculum_router.py, portfolio_router.py
│   │   ├── notification_router.py, sharing_router.py
│   │   ├── config_router.py, system_router.py
│   │   ├── downloads_router.py, files_router.py
│   │   ├── resources_router.py, history_router.py
│   │   ├── tasks_router.py, export_router.py
│   │   ├── wrong_book_router.py, practice_router.py
│   │   ├── recommend_router.py, reward_router.py
│   │   ├── ai_service.py           # AI 统一调用服务
│   │   └── image_gen_service.py    # 通义万相图片生成
│   └── prompts/            # AI Prompt 模板
│       ├── chat.py, exam.py, paper.py, quiz.py
│       ├── practice.py, recommend.py, report.py
│       └── ...
├── frontend/               # React + Vite 前端
│   ├── src/
│   │   ├── api/            # API 接口封装
│   │   ├── components/     # 公共组件（ComposeWizard, QuizEditor, ShareDialog 等）
│   │   ├── pages/          # 页面组件（35+ 页面）
│   │   ├── stores/         # Zustand 状态管理（authStore, chatStore）
│   │   └── types/          # TypeScript 类型定义
│   └── dist/               # 预编译构建产物
├── root/                   # 管理员数据目录
│   ├── html/               # 公共教学资源
│   └── ChatHistory/        # 对话历史
├── stu/                    # 学生数据目录
├── question_media/         # 试题配图文件
├── temp_uploads/           # 临时上传文件（自动清理）
├── USER_MANUAL.md          # 系统帮助文档
├── package.json            # 项目配置
├── requirements.txt        # Python 依赖
├── web.config              # IIS 部署配置
└── README.md
```

---

## 🗄️ 数据存储

| 数据类型 | 存储位置 |
| --------- | --------- |
| 用户/积分/点名/任务/通知/共享/课程大纲/课堂互动/讨论/考勤/奖励/知识抢答 | `backend/smartkb.db`（SQLite） |
| 试题库与考试数据 | `backend/questions.db`（SQLite） |
| 对话历史 | `<用户目录>/ChatHistory/` 按日期分目录 |
| 教学资源 | `<用户目录>/html/` 各账号独立 |
| 系统配置 | `backend/system_config.json` |
| 用户 API Key | `<用户目录>/.env`（DashScope + DeepSeek） |
| 试题配图 | `question_media/` 按题目 ID 分目录 |
| 临时上传文件 | `temp_uploads/`（自动清理超 24 小时文件） |

---

## 👥 权限总览

| 页面/功能 | 学生 | 教师 | 管理员 |
| --------- | :--: | :--: | :-----: |
| AI 对话 | ✅ | ✅ | ✅ |
| 首页仪表盘 | ✅ | ✅ | ✅ |
| 共享中心 | ✅ 共享资源 | ✅ | ✅ |
| 资源管理 | - | ✅ | ✅ |
| 资源分类导航 | ✅ | ✅ | ✅ |
| 课程大纲 | ✅ 查看/学习 | ✅ 管理 | ✅ 管理 |
| 课程进度追踪 | - | ✅ 自己班级 | ✅ 全部 |
| 试题管理 | - | ✅ | ✅ |
| 考试发布 | ✅ 参加 | ✅ 管理 | ✅ 管理 |
| 智能组卷 & Word 导出 | - | ✅ | ✅ |
| 任务管理 | ✅ 提交 | ✅ 管理 | ✅ 管理 |
| 文件中心 | ✅ 共享文件 | ✅ | ✅ |
| 用户管理 | 仅改密 | ✅ | ✅ |
| 系统配置 | - | - | ✅ |
| 课堂积分 | ✅ 查看 | ✅ 自己班级 | ✅ 全部管理 |
| 积分奖励 | ✅ 查看 | ✅ 自己班级 | ✅ 全部管理 |
| 点名管理 | - | ✅ 自己班级 | ✅ 所有班级 |
| 考勤统计 | - | ✅ 自己班级 | ✅ 全部 |
| 学情分析 | - | ✅ 自己班级 | ✅ 全部 |
| 成长档案 | ✅ 自己 | ✅ 全班 | ✅ 全班 |
| 课堂互动 | ✅ 本班参与 | ✅ 自己班级 | ✅ 全部管理 |
| 分组讨论 | ✅ 本班参与 | ✅ 自己班级 | ✅ 全部管理 |
| 知识抢答活动 | ✅ 参与 | ✅ 管理 | ✅ 管理 |
| 错题巩固 | ✅ 自己 | ✅ 全班 | ✅ 全班 |
| 智能练习 | ✅ 参与 | ✅ 管理 | ✅ 管理 |
| AI 资源推荐 | - | ✅ | ✅ |
| 数据导出 | - | ✅ | ✅ |
| 系统公告 | ✅ 查看 | ✅ 发布 | ✅ 发布 |
| 消息通知 | ✅ | ✅ | ✅ |
| HTML 创作指南 | ✅ | ✅ | ✅ |
| 关于与帮助 | ✅ | ✅ | ✅ |

---

## 🛠️ 技术栈

| 层级 | 技术 |
| ------ | ------ |
| **后端** | Python 3.11+, FastAPI, Uvicorn, SQLite |
| **前端** | React, TypeScript, Vite, Ant Design 6, Zustand, React Router 7 |
| **AI 模型** | 通义千问 (DashScope Qwen), DeepSeek |
| **图片生成** | 通义万相 (wan2.2-t2i-flash), SVG |
| **认证** | JWT (bcrypt + PyJWT)，支持单点登录 |
| **数据库** | SQLite（smartkb.db + questions.db） |
| **流式传输** | Server-Sent Events (SSE) |
| **文档导出** | python-docx (Word), openpyxl (Excel), matplotlib (公式渲染) |

---

## 📄 License

本项目仅供教育用途使用。

---

## 📬 关于

**SmartKBS** — 教育智能体 · 高中信通版

- 详细使用指南请参阅 [`USER_MANUAL.md`](USER_MANUAL.md)
- **作者：** UNET
- **联系：** [youufis@sina.com](mailto:youufis@sina.com)
