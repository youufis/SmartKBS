"""
SmartKB 全局配置
从 AgentSmartKBXS.py 提取并集中管理所有常量
"""
import json
import os
from pathlib import Path

# ── 项目根目录 ──
BASE_DIR = Path(__file__).resolve().parent.parent

# ── 应用版本（从前端 package.json 读取，避免硬编码） ──
_FE_PKG = BASE_DIR / "frontend" / "package.json"
APP_VERSION: str = "0.0.0"
try:
    if _FE_PKG.exists():
        APP_VERSION = json.loads(_FE_PKG.read_text(encoding="utf-8")).get("version", "0.0.0")
except Exception:
    pass

# ── 目录/文件相关 ──
CHAT_HISTORY_DIR = "ChatHistory"
LOG_FILES_DIR = str(BASE_DIR / "LogFiles")
ROOT_DIR = "root"
STU_DIR = "stu"
SUMMARY_DIR_NAME = "Summary"

# ── 服务器配置 ──
SERVER_HOST = "0.0.0.0"
SERVER_PORT = 8086

# ── 默认用户 ──
DEFAULT_LOGGED_IN_NAME = "root"

# ── 任务管理 ──
TEACHERS_SUMMARY_DIR = "teachers"
ADMIN_SUMMARY_DIR = "admin"

# ── JWT ──
JWT_SECRET_KEY = os.environ.get("JWT_SECRET_KEY", "smartkb-jwt-secret-key-change-in-production")
JWT_ALGORITHM = "HS256"

# ── 静态文件路径 ──
FRONTEND_DIST_DIR = BASE_DIR / "frontend" / "dist"

# 注意：运行时配置由 backend/api/config_router.py 统一管理
# 修改 system_config.json 请通过 API（/api/config）或直接编辑 JSON 文件
