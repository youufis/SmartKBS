"""
SmartKB 全局配置
从 AgentSmartKBXS.py 提取并集中管理所有常量
"""
import os
from pathlib import Path

# ── 项目根目录 ──
BASE_DIR = Path(__file__).resolve().parent.parent

# ── 目录/文件相关 ──
CHAT_HISTORY_DIR = "ChatHistory"
LOG_FILES_DIR = str(BASE_DIR / "LogFiles")
ROOT_DIR = "root"
STU_DIR = "stu"
SUMMARY_DIR_NAME = "Summary"
TASK_DIR_NAME = "Task"
ICON_PATH = "icon/logo.png"

# ── 服务器配置 ──
SERVER_HOST = "0.0.0.0"
SERVER_PORT = 8086

# ── DashScope / 模型配置 ──
QWEN_OPENAI_API_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"
APPID = "6fcb54e8f16f4e3b94e4b9fd4eab1125"
MODEL_LONG_NAME = "qwen-long"
MODEL_VL_NAME = "qwen3-vl-flash"
MODEL_NAME = "deepseek-v4-flash"

# ── API Key（优先从环境变量获取） ──
dashscope_api_key = os.environ.get("DASHSCOPE_API_KEY", "")

# ── 默认用户 ──
DEFAULT_LOGGED_IN_NAME = "root"

# ── 任务管理 ──
ACTIVE_TASKS_FILE = "active_tasks.json"
TASKS_DIR_NAME = "tasks"
TEACHERS_SUMMARY_DIR = "teachers"
ADMIN_SUMMARY_DIR = "admin"

# ── 文件类型与大小限制 ──
IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp']
DOCUMENT_EXTENSIONS = [
    '.txt', '.md', '.pdf', '.doc', '.docx',
    '.xls', '.xlsx', '.ppt', '.pptx', '.csv',
    '.json', '.html', '.htm',
]
MAX_DOC_SIZE_MB = 10
MAX_IMAGE_SIZE_MB = 5

# ── 请求限制 ──
MAX_ALLOWED_REQUESTS = 50
ENABLE_REQUEST_LIMIT = False

# ── JWT ──
JWT_SECRET_KEY = "smartkb-jwt-secret-key-change-in-production"
JWT_ALGORITHM = "HS256"
JWT_EXPIRATION_HOURS = 24

# ── 在线用户超时 ──
ONLINE_USER_TIMEOUT_SECONDS = 1800  # 30 分钟无活动视为离线

# ── 静态文件路径 ──
FRONTEND_DIST_DIR = BASE_DIR / "frontend" / "dist"

# ── 从 system_config.json 加载覆盖（运行时通过 API 修改） ──
_SYSTEM_CONFIG_PATH = BASE_DIR / "backend" / "system_config.json"
if _SYSTEM_CONFIG_PATH.exists():
    import json as _json
    try:
        _overrides = _json.loads(_SYSTEM_CONFIG_PATH.read_text(encoding="utf-8"))
        for _k, _v in _overrides.items():
            # 跳过以下划线开头的 key
            if _k.startswith("_"):
                continue
            # dashscope_api_key 若已通过环境变量设置，则不覆盖
            if _k == "dashscope_api_key" and os.environ.get("DASHSCOPE_API_KEY", ""):
                continue
            if _k in globals():
                globals()[_k] = _v
    except Exception:
        pass
