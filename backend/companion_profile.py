"""
AI 学伴配置管理
管理每个学生的学伴配置（开关、人格、名称等）
"""
from datetime import datetime
from typing import Any

from backend.database import execute_query, execute_insert_update, get_connection
from backend.logger import logger
from backend.prompts.companion import build_companion_prompt, PERSONALITY_MAP

# ── 默认配置 ──

DEFAULT_CONFIG = {
    "enabled": 1,
    "personality": "encouraging",
    "companion_name": "小智",
    "avatar_style": "default",
    "wakeup_time": "08:00",
}


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def get_config(username: str) -> dict[str, Any]:
    """获取学生的学伴配置，不存在则创建默认配置"""
    rows = execute_query(
        "SELECT enabled, personality, companion_name, avatar_style, wakeup_time, created_at, updated_at "
        "FROM ai_companion_config WHERE username=?",
        (username,),
    )
    if rows:
        row = rows[0]
        personality = str(row[1] or "encouraging")
        return {
            "username": username,
            "enabled": bool(row[0]),
            "personality": personality,
            "personality_label": _get_personality_label(personality),
            "companion_name": str(row[2] or "小智"),
            "avatar_style": str(row[3] or "default"),
            "wakeup_time": str(row[4] or "08:00"),
            "created_at": str(row[5] or ""),
            "updated_at": str(row[6] or ""),
        }
    # 创建默认配置
    now = _now()
    execute_insert_update(
        "INSERT OR IGNORE INTO ai_companion_config (username, enabled, personality, companion_name, avatar_style, wakeup_time, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (username, DEFAULT_CONFIG["enabled"], DEFAULT_CONFIG["personality"],
         DEFAULT_CONFIG["companion_name"], DEFAULT_CONFIG["avatar_style"],
         DEFAULT_CONFIG["wakeup_time"], now, now),
    )
    cfg = dict(DEFAULT_CONFIG)
    cfg["personality_label"] = _get_personality_label(cfg["personality"])
    return {"username": username, **cfg, "created_at": now, "updated_at": now}


def _get_personality_label(personality: str) -> str:
    """获取人格的中文标签"""
    labels = {"encouraging": "鼓励型 🎉", "rigorous": "严谨型 📐", "humorous": "幽默型 😄"}
    return labels.get(personality, "鼓励型 🎉")


def update_config(username: str, cfg: dict[str, Any]) -> dict[str, Any]:
    """更新学伴配置，只更新提供的字段"""
    allowed_keys = {"enabled", "personality", "companion_name", "avatar_style", "wakeup_time"}
    now = _now()

    # 先确保配置存在
    get_config(username)

    fields = []
    values = []
    for key, value in cfg.items():
        if key in allowed_keys:
            if key == "enabled":
                value = 1 if value else 0
            fields.append(f"{key}=?")
            values.append(value)

    if fields:
        fields.append("updated_at=?")
        values.append(now)
        values.append(username)
        sql = f"UPDATE ai_companion_config SET {', '.join(fields)} WHERE username=?"
        execute_insert_update(sql, tuple(values))

    return get_config(username)


def get_personality_desc(personality: str) -> str:
    """获取人格描述文本"""
    p = PERSONALITY_MAP.get(personality, PERSONALITY_MAP["encouraging"])
    return p["desc"]


def get_personality_list() -> list[dict[str, str]]:
    """获取所有可用的人格列表"""
    return [
        {"key": "encouraging", "label": "鼓励型", "desc": "🎉 「加油，你是最棒的」"},
        {"key": "rigorous", "label": "严谨型", "desc": "📐 「我们再分析一下」"},
        {"key": "humorous", "label": "幽默型", "desc": "😄 「今天又翻车了？」"},
    ]


def get_companion_name(username: str) -> str:
    """获取学伴名称"""
    cfg = get_config(username)
    return cfg.get("companion_name", "小智")


def is_enabled(username: str) -> bool:
    """学伴是否启用"""
    cfg = get_config(username)
    return bool(cfg.get("enabled", True))
