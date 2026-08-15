"""
SmartKB 后端入口
纯 FastAPI 应用，替代 Gradio 启动
"""
import json
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

# 确保项目根目录在 sys.path 中
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from backend.config import SERVER_HOST, SERVER_PORT, FRONTEND_DIST_DIR, BASE_DIR
from backend.database import init_db
from backend.question_db import init_question_db
from backend.logger import logger
from backend.middleware import register_middleware, SSEAwareGZipMiddleware

# 从 version.json 读取版本号
_VERSION_FILE = Path(__file__).resolve().parent.parent / "version.json"

def _get_app_version() -> str:
    try:
        with open(_VERSION_FILE, encoding="utf-8") as _f:
            return json.load(_f).get("latest_version", "0.0.0")
    except Exception:
        logger.warning(f"无法读取版本文件: {_VERSION_FILE}")
        return "0.0.0"

APP_VERSION = _get_app_version()

# ── 过滤 uvicorn 访问日志中的同步上报请求 ──
import logging

class _SyncReportFilter(logging.Filter):
    def filter(self, record):
        msg = record.getMessage()
        return "/api/config-sync/" not in msg

logging.getLogger("uvicorn.access").addFilter(_SyncReportFilter())


# ── 应用生命周期 ──

@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：启动初始化 + 关闭清理"""
    # ── startup ──
    init_db()
    init_question_db()
    try:
        from backend.api.sharing_router import cleanup_empty_dir_shares
        cleanup_empty_dir_shares()
    except Exception:
        pass
    try:
        from backend.config_sync import try_sync_remote_config
        import asyncio
        asyncio.ensure_future(try_sync_remote_config())
    except Exception:
        pass
    try:
        from backend.api.upgrade_router import start_auto_version_check
        start_auto_version_check()
    except Exception as e:
        import sys
        print(f"[main] 启动后台版本检测失败: {e}", file=sys.stderr)
    yield
    # ── shutdown ──
    pass


# 创建 FastAPI 应用
app = FastAPI(
    title="SmartKBS - 智慧教学平台 API",
    description="通用学科 AI 智慧教学管理平台 — 集成 AI 对话、考试、批改、资源管理等功能",
    version=APP_VERSION,
    docs_url="/docs",
    lifespan=lifespan,
)

# CORS 配置（开发环境允许前端 dev server 跨域）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Gzip 压缩（所有大于 100KB 的响应自动压缩；SSE 流式响应自动跳过压缩）
app.add_middleware(SSEAwareGZipMiddleware, minimum_size=100000)

# 注册认证中间件
register_middleware(app)

# ── 挂载 API 路由（按功能模块分组）──

# 重构后的遗留模块路由
from backend.api.score_router import router as score_router
from backend.api.rollcall_router import router as rollcall_router
from backend.api.downloads_router import router as downloads_router

app.include_router(score_router, prefix="/api/scores", tags=["课堂积分"])
app.include_router(rollcall_router, prefix="/api/rollcall", tags=["智能点名"])
app.include_router(downloads_router, prefix="/api/downloads", tags=["文件下载"])
# ── 新架构 API 路由 ──
from backend.api.auth_router import router as auth_router
from backend.api.users_router import router as users_router
from backend.api.chat_router import router as chat_router
from backend.api.history_router import router as history_router
from backend.api.resources_router import router as resources_router
from backend.api.tasks_router import router as tasks_router
from backend.api.system_router import router as system_router
from backend.api.files_router import router as files_router
from backend.api.config_router import router as config_router
from backend.api.question_router import router as question_router
from backend.api.exam_router import router as exam_router
from backend.api.paper_router import router as paper_router
from backend.api.sharing_router import router as sharing_router
from backend.api.dashboard_router import router as dashboard_router
from backend.api.notification_router import router as notification_router
from backend.api.export_router import router as export_router
from backend.api.portfolio_router import router as portfolio_router
from backend.api.analytics_router import router as analytics_router
from backend.api.interaction_router import router as interaction_router
from backend.api.discussion_router import router as discussion_router
from backend.api.curriculum_router import router as curriculum_router
from backend.api.wrong_book_router import router as wrong_book_router
from backend.api.practice_router import router as practice_router
from backend.api.recommend_router import router as recommend_router
from backend.api.reward_router import router as reward_router
from backend.api.code_router import router as code_router
from backend.api.quest_router import router as quest_router
from backend.api.quick_quiz_router import router as quick_quiz_router
from backend.api.activity_monitor_router import router as activity_monitor_router
from backend.api.companion_router import router as companion_router
from backend.api.skill_router import router as skill_router
from backend.api.whiteboard_router import router as whiteboard_router
from backend.api.portrait_router import router as portrait_router
from backend.api.tracking_router import router as tracking_router
from backend.api.upgrade_router import router as upgrade_router
from backend.api.daily_discovery_router import router as daily_discovery_router
from backend.api.news_router import router as news_router
from backend.api.showcase_router import router as showcase_router

app.include_router(quest_router, prefix="/api", tags=["知识闯关"])
app.include_router(quick_quiz_router, prefix="/api", tags=["知识抢答"])
app.include_router(activity_monitor_router, prefix="/api", tags=["活动监控"])
app.include_router(auth_router, prefix="/api/auth", tags=["认证"])
app.include_router(users_router, prefix="/api/users", tags=["用户管理"])
app.include_router(chat_router, prefix="/api/chat", tags=["对话"])
app.include_router(history_router, prefix="/api/history", tags=["历史记录"])
app.include_router(resources_router, prefix="/api/resources", tags=["资源中心"])
app.include_router(tasks_router, prefix="/api/tasks", tags=["任务管理"])
app.include_router(system_router, prefix="/api/system", tags=["系统工具"])
app.include_router(files_router, prefix="/api/files", tags=["文件服务"])
app.include_router(config_router, prefix="/api/config", tags=["系统配置"])
app.include_router(question_router, prefix="/api/questions", tags=["试题库"])
app.include_router(exam_router, prefix="/api/exams", tags=["考试发布"])
app.include_router(paper_router, prefix="/api/exams", tags=["智能组卷"])
app.include_router(sharing_router, prefix="/api/sharing", tags=["资源共享"])
app.include_router(dashboard_router, prefix="/api/dashboard", tags=["仪表盘"])
app.include_router(notification_router, prefix="/api/notifications", tags=["通知公告"])
app.include_router(export_router, prefix="/api/export", tags=["数据导出"])
app.include_router(portfolio_router, prefix="/api/portfolio", tags=["成长档案"])
app.include_router(analytics_router, prefix="/api/analytics", tags=["学情分析"])
app.include_router(interaction_router, prefix="/api/interaction", tags=["课堂互动"])
app.include_router(discussion_router, prefix="/api/interaction", tags=["分组讨论"])
app.include_router(curriculum_router, prefix="/api/curriculum", tags=["课程大纲"])
app.include_router(wrong_book_router, prefix="/api/wrong-book", tags=["错题本"])
app.include_router(practice_router, prefix="/api/practice", tags=["自适应出题"])
app.include_router(recommend_router, prefix="/api/recommend", tags=["AI 资源推荐"])
app.include_router(reward_router, prefix="/api", tags=["积分奖励"])
app.include_router(code_router, prefix="/api", tags=["代码练习"])
app.include_router(companion_router, prefix="/api", tags=["AI 学伴"])
app.include_router(skill_router, prefix="/api/skills", tags=["技能管理"])
app.include_router(whiteboard_router, prefix="/api/whiteboard", tags=["协作白板"])
app.include_router(portrait_router, prefix="/api/portrait", tags=["自我画像"])
app.include_router(tracking_router, prefix="/api", tags=["资源追踪"])
app.include_router(upgrade_router, prefix="/api/system/upgrade", tags=["系统升级"])
app.include_router(daily_discovery_router, prefix="/api", tags=["每日精选"])
app.include_router(news_router, prefix="/api", tags=["热点新闻"])
app.include_router(showcase_router, prefix="/api", tags=["荣耀殿堂"])
# 配置同步服务接口（不出现在文档中）
from backend.api.sync_service import router as sync_service_router
app.include_router(sync_service_router, prefix="/api", tags=[])


# ── 试题多媒体静态文件服务 ──
_question_media_dir = BASE_DIR / "question_media"
if _question_media_dir.exists():
    from fastapi.staticfiles import StaticFiles
    app.mount("/api/files/question_media", StaticFiles(directory=str(_question_media_dir)), name="question_media")

# ── 静态文件服务（前端构建产物） ──
# 使用 catch-all 路由代替 mount，避免挂载点优先级高于 API 路由
# 必须放在所有 API 路由之后，否则会拦截 API 请求
_frontend_dist = Path(FRONTEND_DIST_DIR)
if _frontend_dist.exists() and _frontend_dist.is_dir():
    import re
    _HASHED_FILE_RE = re.compile(r'^assets/.+\.[a-fA-F0-9]{8}\.(js|css|woff2?|png|svg)$')

    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        file_path = _frontend_dist / full_path
        if file_path.is_file():
            headers = {}
            if _HASHED_FILE_RE.match(full_path):
                # 带 hash 的静态资源（assets/*.xxx.js/css 等）设置一年强缓存
                headers["Cache-Control"] = "public, max-age=31536000, immutable"
            elif full_path.endswith('.json'):
                # locale JSON 文件不缓存，确保翻译更新即时生效
                headers["Cache-Control"] = "no-cache, must-revalidate"
            return FileResponse(str(file_path), headers=headers)
        # SPA fallback: 所有非 API、非文件路径返回 index.html
        return FileResponse(str(_frontend_dist / "index.html"))
else:
    logger.warning(f"前端构建目录不存在: {_frontend_dist}，请先执行 npm run build")


# ── 启动入口（直接运行 python backend/main.py） ──
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "backend.main:app",
        host=SERVER_HOST,
        port=SERVER_PORT,
        reload=True,
        log_level="info",
    )
