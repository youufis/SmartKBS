"""
技能使用统计 (Skill Stats)

在 apply_skills 成功注入后记录一条轻量流水, 供管理页展示"实际用了哪些技能"。
设计原则(与技能系统一致):
- 零侵入: 任何失败都静默降级, 绝不影响 AI 主流程
- 自维护: 概率式清理 90 天前的旧行, 不需要额外定时任务
"""
import json
import random
from datetime import datetime, timedelta

from backend.logger import logger

_TABLE_READY = False

RETENTION_DAYS = 90
_PRUNE_PROBABILITY = 0.02  # 约每 50 次注入清理一次


def _ensure_table() -> None:
    global _TABLE_READY
    if _TABLE_READY:
        return
    from backend.database import execute_insert_update
    execute_insert_update(
        """CREATE TABLE IF NOT EXISTS skill_usage (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               scene TEXT NOT NULL,
               skills TEXT NOT NULL,
               chars INTEGER NOT NULL,
               created_at TEXT NOT NULL
           )"""
    )
    execute_insert_update(
        "CREATE INDEX IF NOT EXISTS idx_skill_usage_created ON skill_usage(created_at)"
    )
    _TABLE_READY = True


def record_usage(scene: str, skills: list[str], chars: int) -> None:
    """记录一次技能注入(只记成功注入且非空的), 失败静默降级"""
    try:
        from backend.database import execute_insert_update
        _ensure_table()
        execute_insert_update(
            "INSERT INTO skill_usage (scene, skills, chars, created_at) VALUES (?, ?, ?, ?)",
            (scene, json.dumps(list(skills), ensure_ascii=False), int(chars),
             datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
        )
        if random.random() < _PRUNE_PROBABILITY:
            cutoff = (datetime.now() - timedelta(days=RETENTION_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
            execute_insert_update("DELETE FROM skill_usage WHERE created_at < ?", (cutoff,))
    except Exception as e:
        logger.debug(f"[skill_stats] 记录失败(已忽略): {e}")


def query_stats(days: int = 30) -> dict:
    """聚合近 N 天的注入流水: 按场景 / 按技能 / 总量"""
    from backend.database import execute_query_dict
    _ensure_table()
    since = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
    rows = execute_query_dict(
        "SELECT scene, skills, chars, created_at FROM skill_usage WHERE created_at >= ? ORDER BY id",
        (since,),
    )
    by_scene: dict[str, dict] = {}
    by_skill: dict[str, dict] = {}
    total_chars = 0
    for r in rows:
        total_chars += r["chars"]
        sc = by_scene.setdefault(r["scene"], {"count": 0, "chars": 0, "last_used": ""})
        sc["count"] += 1
        sc["chars"] += r["chars"]
        sc["last_used"] = r["created_at"]
        try:
            names = json.loads(r["skills"])
        except Exception:
            names = []
        for name in names:
            sk = by_skill.setdefault(name, {"count": 0, "scenes": set()})
            sk["count"] += 1
            sk["scenes"].add(r["scene"])
    for sk in by_skill.values():
        sk["scenes"] = sorted(sk["scenes"])
    return {
        "days": days,
        "total_injections": len(rows),
        "total_chars": total_chars,
        "by_scene": dict(sorted(by_scene.items(), key=lambda kv: kv[1]["count"], reverse=True)),
        "by_skill": dict(sorted(by_skill.items(), key=lambda kv: kv[1]["count"], reverse=True)),
    }
