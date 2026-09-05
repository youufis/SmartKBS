"""
SmartKB 全局配置
"""
import json
import os
from pathlib import Path

# ── 项目根目录 ──
BASE_DIR = Path(__file__).resolve().parent.parent

# ── 用户数据目录（桌面版可通过环境变量覆盖） ──
# 桌面版 Electron 会将此设为 app.getPath('userData')，实现数据持久化
DATA_DIR = Path(os.environ.get("SMARTKB_DATA_DIR", str(BASE_DIR)))

# ── 应用版本 ──
# 优先读取前端 package.json，桌面版回退到 version.json
def _load_app_version() -> str:
    try:
        pkg = BASE_DIR / "frontend" / "package.json"
        if pkg.exists():
            return json.loads(pkg.read_text(encoding="utf-8")).get("version", "0.0.0")
    except Exception:
        pass
    try:
        ver = BASE_DIR / "version.json"
        if ver.exists():
            return json.loads(ver.read_text(encoding="utf-8")).get("latest_version", "0.0.0")
    except Exception:
        pass
    return "0.0.0"

APP_VERSION: str = _load_app_version()

# ── 目录/文件相关 ──
CHAT_HISTORY_DIR = "ChatHistory"
LOG_FILES_DIR = str(DATA_DIR / "LogFiles")
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
JWT_SECRET_FALLBACK = "smartkb-jwt-secret-key-change-in-production"
JWT_SECRET_IS_DEFAULT = "JWT_SECRET_KEY" not in os.environ
JWT_SECRET_KEY = os.environ.get("JWT_SECRET_KEY", JWT_SECRET_FALLBACK)
JWT_ALGORITHM = "HS256"

# ── 静态文件路径 ──
# 桌面版可通过环境变量 SMARTKB_FRONTEND_PATH 覆盖
FRONTEND_DIST_DIR = Path(os.environ.get(
    "SMARTKB_FRONTEND_PATH",
    str(BASE_DIR / "frontend" / "dist")
))

# 注意：运行时配置由 backend/api/config_router.py 统一管理
# 修改 system_config.json 请通过 API（/api/config）或直接编辑 JSON 文件
