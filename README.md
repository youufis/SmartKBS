# 教育智能体-高中信通版 (SmartKBS)

> 面向高中信息技术与通用技术课程的 AI 智能问答与教学管理平台

![版本](https://img.shields.io/badge/版本-1.1.0-blue)
![后端](https://img.shields.io/badge/后端-FastAPI-green)
![前端](https://img.shields.io/badge/前端-React%2BTypeScript-blue)
![AI](https://img.shields.io/badge/AI-DashScope%20%7C%20DeepSeek-orange)

---

## 📋 项目简介

**SmartKBS** 是一款面向高中信息技术与通用技术课程的 AI 智能问答与教学管理平台。系统基于 **FastAPI + React** 构建，融合云端 AI 能力（阿里云 DashScope 与 DeepSeek），为教师和学生提供全方位教学辅助服务。

---

## ✨ 功能特性

### 💬 AI 对话

核心智能问答界面，支持流式对话、文件上传（图片/文档）、图像理解、文件摘要增强、历史记录检索、HTML 预览、多模型切换。

### 📄 资源中心

按用户目录浏览 HTML 教学资源文件，卡片网格展示，一键新标签页打开。
管理员/教师可在此**共享**自己的资源给其他用户：

- **管理员共享** → 所有用户可见
- **教师共享** → 仅自己班级的学生可见

### 📁 资源管理

上传/删除/重命名教学资源文件（HTML/CSS/JS/图片/文档等），每位教师拥有独立资源目录，资源相互隔离。
每个文件支持**共享/取消共享**操作。

### 📚 资源分类导航

### 📝 试题管理

AI 智能试题库系统，支持一键生成（按科目/题型/知识点/难度）与手动管理（编辑/删除/筛选），题型涵盖单选、多选、判断、简答。

### 📝 考试发布

完整在线考试系统，支持创建配置、智能/手动组卷、自动批改（客观题）、成绩查看与解析。

### ✅ 任务管理

教师发布学习任务，学生提交 AI 对话内容作为作业，支持查看提交详情、撤销提交、结束任务。

### 📥 文件中心

文件下载管理，支持上传/下载/删除，每位教师具有独立配额（默认 5GB）。
管理员/教师同样支持**共享下载文件**给其他用户（管理员→全员，教师→本班学生）。

### 👥 用户管理

完整的用户账号管理（注册、信息更新、密码修改、删除、CSV 导入），支持管理员/教师/学生三种角色。

### ⚙️ 系统配置

集中管理品牌信息、API 密钥（DashScope / DeepSeek）、模型参数、系统限制、下载配额等全局配置。

### 🏆 课堂积分

课堂积分激励系统，支持教师独立管理积分、排行榜、学生管理，多教师数据隔离。

---

## 🚀 快速开始

### 环境要求

- Python 3.9+
- Node.js 18+
- npm 或 yarn

### 1️⃣ 启动后端服务

```bash
# 方式一：直接启动
cd D:\SmartKBS
python backend/main.py

# 方式二：使用 Uvicorn 启动
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8086 --reload
```

后端服务默认运行在 `http://localhost:8086`

### 2️⃣ 启动前端开发服务器（可选）

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

在 _系统配置_ 页面设置 DashScope API Key 或 DeepSeek API Key，或在 _系统配置 → API 密钥管理_ 中为每个用户单独配置。

---

## 📁 项目结构

```text
SmartKBS/
├── backend/              # FastAPI 后端
│   ├── main.py           # 入口文件
│   ├── config.py         # 配置
│   ├── database.py       # 数据库
│   ├── auth.py           # 认证
│   ├── middleware.py      # 中间件
│   ├── api/              # API 路由
│   │   ├── auth_router.py
│   │   ├── chat_router.py
│   │   ├── question_router.py
│   │   ├── exam_router.py
│   │   ├── users_router.py
│   │   └── ...
│   └── ...
├── frontend/             # React + Vite 前端
│   ├── src/
│   │   ├── api/          # API 接口
│   │   ├── components/   # 组件
│   │   ├── pages/        # 页面
│   │   ├── stores/       # 状态管理
│   │   └── types/        # 类型定义
│   └── ...
├── root/                 # 管理员数据目录
│   ├── html/             # 公共教学资源
│   └── ChatHistory/      # 对话历史
├── stu/                  # 学生数据目录
├── youufis/              # 教师数据目录
├── about_help.md         # 系统帮助文档
├── package.json          # 项目配置
├── requirements.txt      # Python 依赖
├── web.config            # IIS 部署配置
├── .gitignore
└── README.md
```

---

## 🗄️ 数据存储

| 数据类型 | 存储位置 |
| --------- | --------- |
| 用户账号 | `backend/users.db`（SQLite） |
| 对话历史 | `<用户目录>/ChatHistory/` |
| 教学资源 | `<用户目录>/html/` |
| 试题库与考试 | `backend/questions.db`（SQLite） |
| 系统配置 | `backend/system_config.json` |
| 课堂积分 | `<用户目录>/html/score_system/score.json` |

---

## 👥 权限总览

| 页面/功能 | 学生 | 教师 | 管理员 |
| --------- | :--: | :--: | :-----: |
| AI 对话 | ✅ | ✅ | ✅ |
| 教学资源 | - | ✅ | ✅ |
| 资源管理 | - | ✅ | ✅ |
| 资源分类导航 | - | ✅ | ✅ |
| 试题管理 | - | ✅ | ✅ |
| 考试发布 | ✅ 参加 | ✅ 管理 | ✅ 管理 |
| 任务管理 | ✅ 提交 | ✅ 管理 | ✅ 管理 |
| 下载中心 | - | ✅ | ✅ |
| 用户管理 | 仅改密 | ✅ | ✅ |
| 系统配置 | - | - | ✅ |
| 课堂积分 | ✅ 查看 | ✅ 管理 | ✅ 管理 |

---

## 🛠️ 技术栈

| 层级 | 技术 |
| ------ | ------ |
| **后端** | Python, FastAPI, Uvicorn, SQLite |
| **前端** | React, TypeScript, Vite |
| **AI 模型** | 通义千问 (DashScope), DeepSeek |
| **认证** | JWT Token |

---

## 📄 License

本项目仅供教育用途使用。

---

## 📬 关于

SmartKBS — 教育智能体-高中信通版

详细使用指南请参阅 [`about_help.md`](about_help.md)。
