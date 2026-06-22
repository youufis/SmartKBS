"""
系统配置管理 API
允许管理员在 UI 中集中管理系统常量（API Key、模型参数等）
配置存储于 backend/system_config.json
"""
import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from backend.api.dependencies import get_current_user, require_admin
from backend.logger import logger

router = APIRouter()

# ── 配置文件路径 ──
CONFIG_FILE = Path(__file__).resolve().parent.parent / "system_config.json"

# ── 默认配置（与 config.py 保持一致） ──
DEFAULT_CONFIG: dict[str, Any] = {
    # 品牌信息（AGENT_NAME 由 "智慧教学平台-" + AGENT_EDITION 自动拼接，不再单独保存）
    "AGENT_EDITION": "高中信通版",
    "ORG_NAME": "",
    # API 密钥（全局兜底）
    "dashscope_api_key": "",
    # 模型与应用配置
    "APPID": "",  # 留空则直接调用大模型(MODEL_NAME)；填写后调用百炼智能体应用。注意：APPID 必须与 DASHSCOPE_API_KEY 归属于同一个阿里云账号，否则无法调用
    "QWEN_OPENAI_API_BASE": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "MODEL_LONG_NAME": "qwen-long",
    "MODEL_VL_NAME": "qwen3-vl-plus",
    "MODEL_NAME": "deepseek-v4-flash",
    # 多模态模型开关（当默认对话模型为 qwen3.5-flash / qwen3.6-flash 等多模态模型时，
    # 开启后对话支持图片+文本同时输入，走多模态 API 格式）
    "ENABLE_MULTIMODAL": False,
    # 文件大小限制
    "MAX_DOC_SIZE_MB": 10,
    "MAX_IMAGE_SIZE_MB": 5,
    # JWT
    "JWT_EXPIRATION_HOURS": 24,
    # 在线用户超时
    "ONLINE_USER_TIMEOUT_SECONDS": 1800,
    # AI 对话权限（可多选角色：1=教师, 2=学生；管理员始终可用）
    "ENABLE_AI_CHAT_FOR_ROLES": [1, 2],
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
    # 课程名称列表
    "SUBJECTS": ["信息科技", "通用技术"],
    # 启用的试题题型（可在此增删，前端自动同步）
    "QUESTION_TYPES": [
        {"key": "single", "label": "单选题"},
        {"key": "multiple", "label": "多选题"},
        {"key": "true_false", "label": "判断题"},
        {"key": "short", "label": "简答题"},
        {"key": "fill", "label": "填空题"},
        {"key": "essay", "label": "作文"},
        {"key": "subjective", "label": "主观题"},
    ],
    # 消息通知类型（默认只启用考试通知，管理员可在系统配置中调整）
    "enabled_notification_types": ["exam"],
    # 图片生成（通义万相，与对话模型共享 API Key）
    "IMAGE_GEN_ENABLED": True,
    "IMAGE_GEN_MODEL": "wan2.2-t2i-flash",
    "IMAGE_GEN_SIZE": "1024*1024",
    # 称号系统配置
    "ENABLE_BADGES": True,
    "ENABLE_SUBJECT_TITLES": True,
    # 闯关挑战出题模式：false=AI 出题（默认）, true=从题库出题
    "QUEST_USE_BANK": False,
    # AI 请求超时设置（秒）— 白板 AI 生成图示/板书等操作的超时时间
    "AI_REQUEST_TIMEOUT": 300,
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
    # 允许更新已知的 key + 称号配置相关 key
    _title_keys = {"TITLE_CONFIG", "SUBJECT_TITLE_CONFIG", "BADGE_CONFIG", "ENABLE_BADGES", "ENABLE_SUBJECT_TITLES", "QUEST_USE_BANK"}
    for key, value in req.config.items():
        if key in DEFAULT_CONFIG or key in _title_keys:
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
    edition = cfg.get("AGENT_EDITION", "高中信通版")
    full_name = f"智慧教学平台-{edition}" if edition else "智慧教学平台"
    return {
        "AGENT_NAME": full_name,
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


@router.get("/multimodal-status")
async def get_multimodal_status():
    """公开接口：获取多模态模型启用状态（无需管理员权限）"""
    cfg = load_config()
    return {"multimodal_enabled": cfg.get("ENABLE_MULTIMODAL", False)}


@router.get("/titles", summary="获取称号配置（管理员）")
async def get_title_config_api(request: Request):
    """获取称号系统全部配置"""
    user = get_current_user(request)
    require_admin(user)
    cfg = load_config()
    from backend.title_system import get_title_config, get_subject_title_config, get_badge_config
    return {
        "TITLE_CONFIG": cfg.get("TITLE_CONFIG", get_title_config()),
        "SUBJECT_TITLE_CONFIG": cfg.get("SUBJECT_TITLE_CONFIG", get_subject_title_config()),
        "BADGE_CONFIG": cfg.get("BADGE_CONFIG", get_badge_config()),
        "ENABLE_BADGES": cfg.get("ENABLE_BADGES", True),
        "ENABLE_SUBJECT_TITLES": cfg.get("ENABLE_SUBJECT_TITLES", True),
    }


@router.put("/titles", summary="更新称号配置（管理员）")
async def update_title_config_api(req: ConfigUpdate, request: Request):
    """更新称号系统配置"""
    user = get_current_user(request)
    require_admin(user)
    current = load_config()
    for key, value in req.config.items():
        if key in ("TITLE_CONFIG", "SUBJECT_TITLE_CONFIG", "BADGE_CONFIG", "ENABLE_BADGES", "ENABLE_SUBJECT_TITLES"):
            current[key] = value
    save_config(current)
    logger.info(f"管理员 {user['username']} 更新了称号配置")
    return {"status": "ok"}


@router.get("/subjects", summary="获取启用的课程列表")
async def get_subjects():
    """从系统配置返回课程列表"""
    from backend.subject_config import get_subjects, get_default_subject
    return {
        "subjects": get_subjects(),
        "default": get_default_subject(),
    }

@router.get("/question-types", summary="获取启用的题型列表")
async def get_question_types():
    """从系统配置返回题型列表（管理员可在系统配置页面修改）"""
    cfg = load_config()
    types = cfg.get("QUESTION_TYPES", [])
    return {
        "types": types,
        "default": types[0] if types else {"key": "single", "label": "单选题"},
    }

@router.get("/grades", summary="获取年级列表")
async def get_grades(stage: str | None = None):
    """获取年级列表，支持按学段筛选（小学/初中/高中）"""
    from backend.permission_service import get_all_grades, get_all_stages
    grades = get_all_grades(stage or "")
    stages = get_all_stages()
    return {
        "grades": grades,
        "stages": stages,
    }


@router.get("/grades/{grade_id}/classes", summary="获取某年级的班级列表")
async def get_classes_by_grade(grade_id: int):
    """获取指定年级下的所有班级"""
    from backend.permission_service import get_all_classes, get_grade_by_id
    grade = get_grade_by_id(grade_id)
    if not grade:
        raise HTTPException(status_code=404, detail="年级不存在")
    classes = get_all_classes(grade_id)
    return {
        "grade": grade,
        "classes": classes,
    }


@router.get("/stages", summary="获取学段列表")
async def get_stages():
    """获取所有学段"""
    from backend.permission_service import get_all_stages
    return {"stages": get_all_stages()}
