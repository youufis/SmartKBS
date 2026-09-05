"""
系统配置管理 API
允许管理员在 UI 中集中管理系统常量（API Key、模型参数等）
配置存储于 backend/system_config.json
"""
import json
import os
import shutil
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from backend.api.dependencies import get_current_user, require_admin
from backend.logger import logger

router = APIRouter()

# ── 配置文件路径 ──
CONFIG_FILE = Path(__file__).resolve().parent.parent / "system_config.json"


def _backup_file() -> Path:
    """C1: 上一次成功保存的副本路径（随 CONFIG_FILE 动态派生，便于测试与迁移）"""
    return CONFIG_FILE.with_name(CONFIG_FILE.name + ".bak")


_SECRET_KEYS = ("dashscope_api_key", "APPID")                          # C3: 不回显明文
_MASK_PREFIX = "****"

# ── 默认配置（与 config.py 保持一致） ──
DEFAULT_CONFIG: dict[str, Any] = {
    # 品牌信息（AGENT_NAME 由 "智慧教学平台-" + AGENT_EDITION 自动拼接，不再单独保存）
    "AGENT_EDITION": "通用版",
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
    # 技能系统：已启用的技能名称列表（空列表=关闭所有技能）
    "enabled_skills": [],
    # 课程名称列表
    "SUBJECTS": ["人工智能"],
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
    "enabled_notification_types": ["exam", "system"],
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


_config_lock = threading.Lock()
_cache_lock = threading.RLock()
_cfg_cache: dict[str, Any] | None = None
_cfg_cache_key: tuple | None = None
_cfg_corrupt: dict[str, Any] = {"corrupt": False, "recovered_from_backup": False, "detail": ""}


def _config_stat_key() -> tuple | None:
    """C4: 用 (mtime_ns, size) 作为缓存键, 避免每次读盘 + 解析整份 JSON"""
    try:
        st = CONFIG_FILE.stat()
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


def _read_json_config(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def load_config() -> dict[str, Any]:
    """加载系统配置（C1/C4）

    - 带 (mtime,size) 缓存, 配置改动即时生效但不再每次读盘解析;
    - 文件损坏(如写入过程中掉电)时先回退上一次备份, 并记录可见状态, 不再静默丢配置;
    - 合并默认值保证新字段存在。
    """
    global _cfg_cache, _cfg_cache_key
    key = _config_stat_key()
    with _cache_lock:
        if _cfg_cache is not None and _cfg_cache_key == key:
            return dict(_cfg_cache)

        data: dict[str, Any] | None = None
        corrupt = {"corrupt": False, "recovered_from_backup": False, "detail": ""}
        if key is None:
            if CONFIG_FILE.exists():
                corrupt = {"corrupt": True, "recovered_from_backup": False,
                           "detail": "配置文件无法读取"}
        else:
            data = _read_json_config(CONFIG_FILE)
            if data is None:
                backup = _read_json_config(_backup_file())
                corrupt = {
                    "corrupt": True,
                    "recovered_from_backup": backup is not None,
                    "detail": f"{CONFIG_FILE.name} 解析失败"
                              + ("，已回退到上一次备份" if backup is not None else "，且无可用备份"),
                }
                data = backup
        if data is None:
            if not corrupt["corrupt"] and key is not None:
                corrupt = {"corrupt": True, "recovered_from_backup": False,
                           "detail": "无可用配置，已使用系统默认值"}
            data = {}
        _cfg_corrupt.clear()
        _cfg_corrupt.update(corrupt)
        if corrupt["corrupt"]:
            logger.error(f"[配置] {corrupt['detail']}；请管理员尽快在系统配置页重新保存以修复配置文件")

        merged = dict(DEFAULT_CONFIG)
        merged.update(data)
        _cfg_cache = merged
        _cfg_cache_key = key
        return dict(merged)


def save_config(config: dict[str, Any]):
    """保存配置（C1: 先备份 + 临时文件原子替换, 不再出现半截文件）"""
    global _cfg_cache, _cfg_cache_key
    payload = json.dumps(config, ensure_ascii=False, indent=2)
    with _config_lock:
        CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        try:
            if CONFIG_FILE.exists():
                shutil.copy2(CONFIG_FILE, _backup_file())
        except OSError as e:
            logger.warning(f"[配置] 备份写入失败(不影响本次保存): {e}")
        tmp = CONFIG_FILE.with_name(CONFIG_FILE.name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, CONFIG_FILE)          # 同盘原子替换
    with _cache_lock:
        _cfg_cache = None
        _cfg_cache_key = None


def get_config_value(key: str, default: Any = None) -> Any:
    """运行时获取配置值（供其他模块使用，走 mtime 缓存）"""
    cfg = load_config()
    return cfg.get(key, default)


def config_health() -> dict[str, Any]:
    """C1: 配置健康状态(供 /config/health 与启动自检使用)"""
    load_config()
    with _cache_lock:
        info = dict(_cfg_corrupt)
    return {
        "status": ("corrupt_recovered_from_backup" if info.get("recovered_from_backup")
                   else ("corrupt" if info.get("corrupt") else "ok")),
        "ok": not info.get("corrupt", False),
        "detail": info.get("detail", ""),
        "file": str(CONFIG_FILE),
        "backup_exists": _backup_file().exists(),
    }


def _mask_secret(value: Any) -> Any:
    if not isinstance(value, str) or not value:
        return value
    return _MASK_PREFIX + (value[-4:] if len(value) > 4 else "")


def _mask_config(config: dict[str, Any]) -> dict[str, Any]:
    out = dict(config)
    for k in _SECRET_KEYS:
        if out.get(k):
            out[k] = _mask_secret(out[k])
    return out


# ── C2/C5: 配置写入校验 ──

_NUM_RANGES: dict[str, tuple[float, float]] = {
    "JWT_EXPIRATION_HOURS": (1, 720),
    "ONLINE_USER_TIMEOUT_SECONDS": (60, 86400),
    "MAX_DOC_SIZE_MB": (1, 200),
    "MAX_IMAGE_SIZE_MB": (1, 200),
    "TEACHER_DOWNLOAD_QUOTA_GB": (1, 100),
    "MAX_ALLOWED_REQUESTS": (1, 10000),
    "AI_REQUEST_TIMEOUT": (5, 900),
}
_BOOL_KEYS = {
    "ENABLE_MULTIMODAL", "ENABLE_REQUEST_LIMIT", "IMAGE_GEN_ENABLED",
    "ENABLE_BADGES", "ENABLE_SUBJECT_TITLES", "QUEST_USE_BANK",
}
_STR_LIMITS: dict[str, int] = {
    "AGENT_EDITION": 64, "ORG_NAME": 100, "QWEN_OPENAI_API_BASE": 300,
    "MODEL_LONG_NAME": 80, "MODEL_VL_NAME": 80, "MODEL_NAME": 80,
    "IMAGE_GEN_MODEL": 80, "IMAGE_GEN_SIZE": 32,
    "dashscope_api_key": 200, "APPID": 128,
}
_STRLIST_KEYS = {"IMAGE_EXTENSIONS": 60, "DOCUMENT_EXTENSIONS": 60, "enabled_skills": 100,
                 "SUBJECTS": 40, "enabled_notification_types": 40}
_TITLE_LIST_KEYS = {"TITLE_CONFIG", "SUBJECT_TITLE_CONFIG", "BADGE_CONFIG"}
_EXT_RE = None


def _bad_ext(ext: Any) -> bool:
    global _EXT_RE
    if _EXT_RE is None:
        import re as _re
        _EXT_RE = _re.compile(r"^\.[A-Za-z0-9]{1,10}$")
    return not (isinstance(ext, str) and _EXT_RE.match(ext))


def _validate_title_config(key: str, value: Any) -> None:
    """C5: 称号/徽章配置结构校验, 避免写坏后称号子系统全线报错"""
    if not isinstance(value, list) or not value:
        raise HTTPException(status_code=400, detail=f"{key} 必须是非空列表")
    if key == "BADGE_CONFIG":
        seen: set[str] = set()
        for i, item in enumerate(value):
            if not isinstance(item, dict) or not item.get("id") or not item.get("name"):
                raise HTTPException(status_code=400, detail=f"{key} 第 {i + 1} 项需包含 id 与 name")
            if str(item["id"]) in seen:
                raise HTTPException(status_code=400, detail=f"{key} 存在重复 id: {item['id']}")
            seen.add(str(item["id"]))
        return
    points_field = "min_points" if key == "TITLE_CONFIG" else "min_questions"
    prev_level = -1
    prev_points = -1
    for i, item in enumerate(value):
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail=f"{key} 第 {i + 1} 项必须是对象")
        for need in ("level", "name", points_field):
            if need not in item:
                raise HTTPException(status_code=400, detail=f"{key} 第 {i + 1} 项缺少字段 {need}")
        try:
            level = int(item["level"])
            points = int(item[points_field])
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"{key} 第 {i + 1} 项的 level/{points_field} 必须是整数")
        if not str(item["name"]).strip():
            raise HTTPException(status_code=400, detail=f"{key} 第 {i + 1} 项 name 不能为空")
        if points < 0:
            raise HTTPException(status_code=400, detail=f"{key} 第 {i + 1} 项 {points_field} 不能为负")
        if level <= prev_level or points < prev_points:
            raise HTTPException(status_code=400,
                                detail=f"{key} 第 {i + 1} 项的 level/{points_field} 必须逐级递增(不能低于上一档)")
        prev_level, prev_points = level, points


def _validate_config_updates(updates: dict[str, Any]) -> dict[str, Any]:
    """C2: 校验并规范化配置更新; 未知键忽略(与旧行为一致)"""
    out: dict[str, Any] = {}
    for key, value in updates.items():
        if key in _NUM_RANGES:
            lo, hi = _NUM_RANGES[key]
            try:
                num = int(float(value))
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail=f"{key} 必须是数字（{lo}~{hi}）")
            if not lo <= num <= hi:
                raise HTTPException(status_code=400, detail=f"{key} 需在 {lo}~{hi} 之间，当前 {num}")
            out[key] = num
        elif key in _BOOL_KEYS:
            if isinstance(value, bool):
                out[key] = value
            elif isinstance(value, str) and value.strip().lower() in ("true", "false", "1", "0"):
                out[key] = value.strip().lower() in ("true", "1")
            else:
                raise HTTPException(status_code=400, detail=f"{key} 必须是布尔值")
        elif key in _STR_LIMITS:
            if not isinstance(value, str):
                raise HTTPException(status_code=400, detail=f"{key} 必须是文本")
            if len(value) > _STR_LIMITS[key]:
                raise HTTPException(status_code=400, detail=f"{key} 最长 {_STR_LIMITS[key]} 字")
            out[key] = value.strip() if key in ("dashscope_api_key", "APPID") else value
        elif key in _STRLIST_KEYS:
            if not isinstance(value, list) or not all(isinstance(x, str) and x.strip() for x in value):
                raise HTTPException(status_code=400, detail=f"{key} 必须是非空字符串列表")
            if len(value) > _STRLIST_KEYS[key]:
                raise HTTPException(status_code=400, detail=f"{key} 最多 {_STRLIST_KEYS[key]} 项")
            if key.endswith("EXTENSIONS") and any(_bad_ext(x) for x in value):
                raise HTTPException(status_code=400, detail=f"{key} 每一项需形如 .pdf（点号 + 1~10 位字母数字）")
            out[key] = [x.strip() for x in value]
        elif key == "ENABLE_AI_CHAT_FOR_ROLES":
            if not isinstance(value, list) or not all(isinstance(x, int) and x in (0, 1, 2) for x in value):
                raise HTTPException(status_code=400, detail="ENABLE_AI_CHAT_FOR_ROLES 需为角色编号列表(1=教师, 2=学生)")
            out[key] = list(value)
        elif key == "QUESTION_TYPES":
            if not isinstance(value, list) or not value:
                raise HTTPException(status_code=400, detail="QUESTION_TYPES 必须是非空列表")
            for i, item in enumerate(value):
                if not isinstance(item, dict) or not str(item.get("key", "")).strip() or not str(item.get("label", "")).strip():
                    raise HTTPException(status_code=400, detail=f"QUESTION_TYPES 第 {i + 1} 项需包含 key 与 label")
            out[key] = value
        elif key in _TITLE_LIST_KEYS:
            _validate_title_config(key, value)
            out[key] = value
    return out


# ── API 端点 ──


@router.get("")
async def get_config(request: Request):
    """获取全部系统配置（管理员；C3: 密钥类字段掩码回显，不回传明文）"""
    user = get_current_user(request)
    require_admin(user)
    return _mask_config(load_config())


@router.get("/health", summary="配置文件健康状态（管理员）")
async def get_config_health(request: Request):
    """C1: 配置文件损坏/回退状态可见, 不再静默用默认值覆盖真实配置"""
    user = get_current_user(request)
    require_admin(user)
    return config_health()


class ConfigUpdate(BaseModel):
    config: dict[str, Any]


@router.put("")
async def update_config(req: ConfigUpdate, request: Request):
    """更新系统配置（管理员）"""
    user = get_current_user(request)
    require_admin(user)
    current = load_config()
    # 允许更新已知的 key + 称号配置相关 key
    _title_keys = {"TITLE_CONFIG", "SUBJECT_TITLE_CONFIG", "BADGE_CONFIG", "ENABLE_BADGES",
                   "ENABLE_SUBJECT_TITLES", "QUEST_USE_BANK"}
    known = {k: v for k, v in req.config.items() if k in DEFAULT_CONFIG or k in _title_keys}
    # C3: 掩码回显的值代表"未修改"（前端表单会原样提交），空串才是主动清空
    for k in _SECRET_KEYS:
        if isinstance(known.get(k), str) and known[k].startswith(_MASK_PREFIX):
            known.pop(k)
    # C2: 类型/范围校验, 不合法整批拒绝(不做部分写入)
    known = _validate_config_updates(known)
    if not known:
        # 没有实际变更(例如只提交了掩码密钥)时不写盘, 避免无意义的文件重写
        return {"status": "ok", "config": _mask_config(current), "updated": []}
    current.update(known)
    save_config(current)
    logger.info(f"管理员 {user['username']} 更新了系统配置 ({len(known)} 项)")

    # 更新 API Key 后清除聊天模块的缓存，使新 key 即时生效
    if any(k in ('dashscope_api_key', 'deepseek_api_key') for k in req.config):
        try:
            from backend.api.chat_router import clear_api_key_cache
            clear_api_key_cache()
        except Exception:
            pass

    # C3: 响应同样掩码, 不回传明文密钥
    return {"status": "ok", "config": _mask_config(current), "updated": sorted(known.keys())}


@router.get("/public")
async def get_public_config():
    """公开配置（无需登录）— 用于登录页面等展示品牌信息"""
    cfg = load_config()
    edition = cfg.get("AGENT_EDITION", "通用版")
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
async def get_multimodal_status(request: Request):
    """获取多模态模型启用状态（需登录，无需管理员权限）"""
    get_current_user(request)
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
    allowed = {k: v for k, v in req.config.items()
               if k in ("TITLE_CONFIG", "SUBJECT_TITLE_CONFIG", "BADGE_CONFIG",
                        "ENABLE_BADGES", "ENABLE_SUBJECT_TITLES")}
    # C5: 结构校验后再落盘, 避免写坏称号/徽章配置把积分子系统整体打挂
    allowed = _validate_config_updates(allowed)
    if not allowed:
        raise HTTPException(status_code=400, detail="没有可更新的称号配置项")
    current.update(allowed)
    save_config(current)
    logger.info(f"管理员 {user['username']} 更新了称号配置")
    return {"status": "ok"}


@router.get("/subjects", summary="获取启用的课程列表")
async def get_subjects(request: Request):
    # U-CFG: 这些枚举页仅供已登录页面使用(匿名只有 /config/public)
    get_current_user(request)
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
async def get_grades(request: Request, stage: str | None = None):
    get_current_user(request)
    """获取年级列表，支持按学段筛选（小学/初中/高中）"""
    from backend.permission_service import get_all_grades, get_all_stages
    grades = get_all_grades(stage or "")
    stages = get_all_stages()
    return {
        "grades": grades,
        "stages": stages,
    }


@router.get("/grades/{grade_id}/classes", summary="获取某年级的班级列表")
async def get_classes_by_grade(grade_id: int, request: Request):
    get_current_user(request)
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
async def get_stages(request: Request):
    get_current_user(request)
    """获取所有学段"""
    from backend.permission_service import get_all_stages
    return {"stages": get_all_stages()}
