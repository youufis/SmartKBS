"""
系统配置管理 API
允许管理员在 UI 中集中管理系统常量（API Key、模型参数等）
配置存储于 backend/system_config.json
"""
import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

from backend.api.dependencies import get_current_user, require_admin
from backend.logger import logger

router = APIRouter()

# ── 配置文件路径 ──
CONFIG_FILE = Path(__file__).resolve().parent.parent / "system_config.json"

# ── 默认配置（与 config.py 保持一致） ──
DEFAULT_CONFIG: dict[str, Any] = {
    # 品牌信息
    "AGENT_NAME": "智慧教学平台-高中信通版",
    "ORG_NAME": "",
    # API 密钥（全局兜底）
    "dashscope_api_key": "",
    # 模型与应用配置
    "APPID": "6fcb54e8f16f4e3b94e4b9fd4eab1125",
    "QWEN_OPENAI_API_BASE": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "MODEL_LONG_NAME": "qwen-long",
    "MODEL_VL_NAME": "qwen3-vl-flash",
    "MODEL_NAME": "deepseek-v4-flash",
    # 文件大小限制
    "MAX_DOC_SIZE_MB": 10,
    "MAX_IMAGE_SIZE_MB": 5,
    # JWT
    "JWT_EXPIRATION_HOURS": 24,
    # 在线用户超时
    "ONLINE_USER_TIMEOUT_SECONDS": 1800,
    # 请求限制
    "ENABLE_REQUEST_LIMIT": False,
    "MAX_ALLOWED_REQUESTS": 50,
    # 下载中心
    "TEACHER_DOWNLOAD_QUOTA_GB": 5,
    # 文件类型白名单
    "IMAGE_EXTENSIONS": ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp'],
    "DOCUMENT_EXTENSIONS": [
        '.txt', '.md', '.pdf', '.doc', '.docx',
        '.xls', '.xlsx', '.ppt', '.pptx', '.csv',
        '.json', '.html', '.htm',
    ],
}


def load_config() -> dict[str, Any]:
    """加载配置文件，不存在时返回默认值"""
    if CONFIG_FILE.exists():
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            # 合并默认值，确保新字段存在
            merged = dict(DEFAULT_CONFIG)
            merged.update(data)
            return merged
        except Exception as e:
            logger.warning(f"读取配置文件失败: {e}")
    return dict(DEFAULT_CONFIG)


def save_config(config: dict[str, Any]):
    """保存配置到文件"""
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(
        json.dumps(config, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def get_config_value(key: str, default: Any = None) -> Any:
    """运行时获取配置值（供其他模块使用）"""
    cfg = load_config()
    return cfg.get(key, default)


# ── API 端点 ──


@router.get("")
async def get_config(request: Request):
    """获取全部系统配置（管理员）"""
    user = get_current_user(request)
    require_admin(user)
    return load_config()


class ConfigUpdate(BaseModel):
    config: dict[str, Any]


@router.put("")
async def update_config(req: ConfigUpdate, request: Request):
    """更新系统配置（管理员）"""
    user = get_current_user(request)
    require_admin(user)
    current = load_config()
    # 只允许更新已知的 key
    for key, value in req.config.items():
        if key in DEFAULT_CONFIG:
            current[key] = value
    save_config(current)
    logger.info(f"管理员 {user['username']} 更新了系统配置 ({len(req.config)} 项)")

    # 更新 API Key 后清除聊天模块的缓存，使新 key 即时生效
    if any(k in ('dashscope_api_key', 'deepseek_api_key') for k in req.config):
        try:
            from backend.api.chat_router import clear_api_key_cache
            clear_api_key_cache()
        except Exception:
            pass

    return {"status": "ok", "config": current}


@router.get("/public")
async def get_public_config():
    """公开配置（无需登录）— 用于登录页面等展示品牌信息"""
    cfg = load_config()
    return {
        "AGENT_NAME": cfg.get("AGENT_NAME", "智慧教学平台-高中信通版"),
        "ORG_NAME": cfg.get("ORG_NAME", ""),
    }


@router.get("/apikey-status")
async def get_apikey_status(request: Request):
    """获取 API Key 配置状态（管理员），告知来源：env（环境变量）、config（系统配置）、missing（缺失）"""
    user = get_current_user(request)
    require_admin(user)

    import os
    env_key = os.environ.get("DASHSCOPE_API_KEY", "")
    cfg_key = load_config().get("dashscope_api_key", "")

    if env_key:
        status = "env"
        source = "环境变量 DASHSCOPE_API_KEY"
        hint = ""
    elif cfg_key:
        status = "config"
        source = "系统配置"
        hint = ""
    else:
        status = "missing"
        source = ""
        hint = "请设置环境变量 DASHSCOPE_API_KEY，或在下方填写 API Key 并保存"

    return {
        "status": status,
        "source": source,
        "hint": hint,
        "configured": status != "missing",
    }
