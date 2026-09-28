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

# ── AI 接入域名：业务空间专属域名优先，普通域名备用 ──
# 阿里云百炼官方口径：生产环境建议切到业务空间专属域名（更高并发承载 + 网络隔离），
# 切换只需替换 Base URL 的域名，接口与业务逻辑不变 —— 也就是说两个域名是通用的，
# 因此「谁连得上用谁」比「让管理员手改配置」更合理：填了专属域名就优先走它，
# 连接层失败（DNS 解析不了、拒连、连不上超时）自动回落到普通域名。
PUBLIC_AI_API_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"


def normalize_ai_api_base(raw) -> str:
    """配置里的地址规范成 OpenAI 兼容 base：补协议、去尾斜杠、裸域名补 /compatible-mode/v1"""
    text = str(raw or "").strip().rstrip("/")
    if not text:
        return ""
    if not text.startswith("http://") and not text.startswith("https://"):
        text = "https://" + text
    if "/compatible-mode" not in text:
        text += "/compatible-mode/v1"
    return text


def ai_api_bases() -> list:
    """AI 调用候选地址（按优先顺序，已去重）：专属域名在前、普通域名兜底。

    专属域名沿用知识库那一栏 KB_API_BASE（同一个业务空间、同一个 Key，不必重复填）。
    """
    from backend.api.config_router import get_config_value   # 延迟导入，避开循环依赖
    out = []
    dedicated = normalize_ai_api_base(get_config_value("KB_API_BASE", ""))
    if dedicated:
        out.append(dedicated)
    public = normalize_ai_api_base(get_config_value("QWEN_OPENAI_API_BASE", "")) or PUBLIC_AI_API_BASE
    if public not in out:
        out.append(public)
    return out


def ai_api_base() -> str:
    """当前首选地址（没填专属域名时就是普通域名）"""
    try:
        return ai_api_bases()[0]
    except Exception:
        return PUBLIC_AI_API_BASE

