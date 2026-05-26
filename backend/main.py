"""
SmartKB 后端入口
纯 FastAPI 应用，替代 Gradio 启动
"""
import os
import sys
from pathlib import Path

# 确保项目根目录在 sys.path 中
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from backend.config import SERVER_HOST, SERVER_PORT, FRONTEND_DIST_DIR
from backend.database import init_db
from backend.question_db import init_question_db
from backend.logger import logger
from backend.middleware import register_middleware

# 创建 FastAPI 应用
app = FastAPI(
    title="SmartKB - 教育智能体 API",
    description="高中信息技术与通用技术课程 AI 智能问答与教学管理平台",
    version="2.0.0",
    docs_url="/docs",
)

# CORS 配置（开发环境允许前端 dev server 跨域）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册认证中间件
register_middleware(app)

# ── 挂载现有 API 模块 ──
from backend.score_system import mount_score_api
from backend.smart_rollcall_api import mount_rollcall_api
from backend.downloads_api import mount_downloads_api

mount_score_api(app)
mount_rollcall_api(app)
mount_downloads_api(app)
logger.info("现有 API 模块已挂载: score / rollcall / downloads")

# ── 挂载新 API 路由 ──
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

app.include_router(auth_router, prefix="/api/auth", tags=["认证"])
app.include_router(users_router, prefix="/api/users", tags=["用户管理"])
app.include_router(chat_router, prefix="/api/chat", tags=["对话"])
app.include_router(history_router, prefix="/api/history", tags=["历史记录"])
app.include_router(resources_router, prefix="/api/resources", tags=["教学资源"])
app.include_router(tasks_router, prefix="/api/tasks", tags=["任务管理"])
app.include_router(system_router, prefix="/api/system", tags=["系统工具"])
app.include_router(files_router, prefix="/api/files", tags=["文件服务"])
app.include_router(config_router, prefix="/api/config", tags=["系统配置"])
app.include_router(question_router, prefix="/api/questions", tags=["试题库"])
app.include_router(exam_router, prefix="/api/exams", tags=["考试发布"])


@app.get("/api/health")
async def health_check():
    """健康检查接口"""
    return {"status": "ok", "version": "2.0.0"}


# ── 静态文件服务（前端构建产物） ──
# 使用 catch-all 路由代替 mount，避免挂载点优先级高于 API 路由
# 必须放在所有 API 路由之后，否则会拦截 API 请求
_frontend_dist = Path(FRONTEND_DIST_DIR)
if _frontend_dist.exists() and _frontend_dist.is_dir():
    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        file_path = _frontend_dist / full_path
        if file_path.is_file():
            return FileResponse(str(file_path))
        # SPA fallback: 所有非 API、非文件路径返回 index.html
        return FileResponse(str(_frontend_dist / "index.html"))
    logger.info(f"前端静态文件服务已挂载: {_frontend_dist}")
else:
    logger.warning(f"前端构建目录不存在: {_frontend_dist}，请先执行 npm run build")


@app.on_event("startup")
async def startup():
    """应用启动时的初始化"""
    # 设置 Matplotlib 配置目录
    os.environ.setdefault("MPLCONFIGDIR", "D:/SmartKBS/matplotlib")

    # 初始化数据库
    init_db()
    init_question_db()
    logger.info("SmartKB 后端启动完成")


@app.on_event("shutdown")
async def shutdown():
    logger.info("SmartKB 后端关闭")


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
