# -*- coding: utf-8 -*-
"""直连模式多轮记忆：会话轮次存储与容量/过期治理

背景：APPID 留空时对话走 OpenAI 兼容接口直连大模型，该接口本身无状态，
百炼智能体的 session_id 记忆也就不存在 —— 本模块在平台侧补上多轮上下文。

只在「实际调用走直连」时启用；智能体路径仍用百炼返回的 session_id。
为避免把直连的 key 误传给 Application.call，本模块生成的 key 一律带 `d_` 前缀。

五道清除触发（详见 docs）：
① 写入即裁剪（会话内行数有界）② 读取即过期（惰性 TTL）③ 显式清除（新话题/按用户）
④ 后台分钟级 prune（backend/log_retention.py 守护线程）⑤ 全局行数硬上限

所有异常一律吞掉并降级为「无记忆的单轮对话」，绝不影响正常对话链路。
"""
from datetime import datetime, timedelta
from typing import Any, Optional

from backend.database import get_connection
from backend.logger import logger

SESSION_PREFIX = "d_"

_DEFAULTS = {
    "CHAT_MEMORY_ENABLED": True,
    "CHAT_MEMORY_MAX_TURNS": 8,
    "CHAT_MEMORY_TTL_MINUTES": 30,
    "CHAT_MEMORY_MAX_CHARS": 6000,
    "CHAT_MEMORY_MAX_ROWS": 20000,
    "CHAT_MEMORY_CONTENT_MAX_CHARS": 4000,
    "CHAT_MEMORY_PRUNE_INTERVAL_MINUTES": 5,
}


def _cfg(key: str) -> Any:
    """读配置（缺失/异常一律回落到内置默认值）"""
    default = _DEFAULTS.get(key)
    try:
        from backend.api.config_router import get_config_value
        val = get_config_value(key, default)
    except Exception:
        return default
    if isinstance(default, bool):
        return bool(val)
    if isinstance(default, int):
        try:
            num = int(float(val))
        except (TypeError, ValueError):
            return default
        return num if num > 0 else default
    return val


def enabled() -> bool:
    return bool(_cfg("CHAT_MEMORY_ENABLED"))


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def is_direct_session(session_id: Any) -> bool:
    """是否本模块生成的直连会话 key"""
    return bool(session_id) and str(session_id).startswith(SESSION_PREFIX)


def new_session_key() -> str:
    import uuid
    return SESSION_PREFIX + uuid.uuid4().hex[:24]


def ensure_session(username: str, session_id: Any) -> str:
    """沿用合法的直连 key，否则新建。非法/越权一律静默换新（不给探测反馈）"""
    sid = str(session_id or "").strip()
    if is_direct_session(sid) and len(sid) <= 40:
        return sid
    return new_session_key()


def get_history(session_key: str, username: str) -> list[dict[str, str]]:
    """取该会话仍在有效期内的最近 N 轮，按时间正序返回 [{role, content}]

    读取时顺带做惰性过期删除：即便后台 prune 没跑，用户再也不回来的死会话
    也会在下次任何人读同一 key 时被清掉。
    """
    if not session_key or not username:
        return []
    max_turns = int(_cfg("CHAT_MEMORY_MAX_TURNS"))
    max_chars = int(_cfg("CHAT_MEMORY_MAX_CHARS"))
    cutoff = (datetime.now() - timedelta(minutes=int(_cfg("CHAT_MEMORY_TTL_MINUTES")))).strftime("%Y-%m-%d %H:%M:%S")
    try:
        with get_connection() as conn:
            try:
                conn.execute("DELETE FROM chat_turns WHERE session_key=? AND created_at < ?", (session_key, cutoff))
                conn.commit()
            except Exception:
                pass
            rows = conn.execute(
                """SELECT role, content, partial FROM chat_turns
                   WHERE session_key=? AND username=? AND created_at >= ?
                   ORDER BY id DESC LIMIT ?""",
                (session_key, username, cutoff, max_turns * 2 + 2),
            ).fetchall()
    except Exception as e:
        logger.warning(f"[对话记忆] 读取失败(按单轮处理): {e}")
        return []

    turns = [{"role": r[0], "content": r[1], "partial": int(r[2] or 0)} for r in reversed(rows)]

    # 半截回答（客户端中途 abort）连同其前面的那句提问一起丢，避免模型续写残句
    kept: list[dict[str, Any]] = []
    for t in turns:
        if t["role"] == "assistant" and t["partial"]:
            if kept and kept[-1]["role"] == "user":
                kept.pop()
            continue
        kept.append(t)
    # 只保留成对轮次，最后一条必须是 user 之前的完整问答
    while kept and kept[-1]["role"] != "assistant":
        kept.pop()

    # 从最旧一端开始丢，直到字符预算达标（至少保最新一轮）
    def _total(items):
        return sum(len(i["content"]) for i in items)
    while len(kept) > 2 and _total(kept) > max_chars:
        kept.pop(0)
    # 首条必须是 user：残缺状态（如只有半句回答）不送去模型，避免角色错位
    while kept and kept[0]["role"] != "user":
        kept.pop(0)
    while len(kept) % 2:
        kept.pop(0)

    return [{"role": i["role"], "content": i["content"]} for i in kept]


def append_turn(session_key: str, username: str, role: str, content: str,
                scene: str = "chat", tokens: int = 0, partial: bool = False) -> None:
    """写入一轮，并做会话内裁剪 + 全表行数硬上限"""
    if not session_key or not username or role not in ("user", "assistant"):
        return
    text = str(content or "").strip()
    if not text:
        return
    limit = int(_cfg("CHAT_MEMORY_CONTENT_MAX_CHARS"))
    if len(text) > limit:
        text = text[:limit] + "……（已截断）"
    max_turns = int(_cfg("CHAT_MEMORY_MAX_TURNS"))
    max_rows = int(_cfg("CHAT_MEMORY_MAX_ROWS"))
    try:
        with get_connection() as conn:
            conn.execute(
                """INSERT INTO chat_turns (session_key, username, scene, role, content, tokens, partial, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (session_key, username, scene, role, text, int(tokens or 0), 1 if partial else 0, _now()),
            )
            keep = max_turns * 2
            conn.execute(
                """DELETE FROM chat_turns WHERE session_key=? AND id NOT IN (
                       SELECT id FROM chat_turns WHERE session_key=? ORDER BY id DESC LIMIT ?)""",
                (session_key, session_key, keep),
            )
            total = conn.execute("SELECT COUNT(*) FROM chat_turns").fetchone()[0]
            if total > max_rows:
                conn.execute(
                    """DELETE FROM chat_turns WHERE id NOT IN (
                           SELECT id FROM chat_turns ORDER BY id DESC LIMIT ?)""",
                    (max_rows,),
                )
                logger.info(f"[对话记忆] 触发行数上限 {max_rows}，已淘汰最旧 {total - max_rows} 条")
            conn.commit()
    except Exception as e:
        logger.warning(f"[对话记忆] 写入失败(不影响本次回答): {e}")


def reset_session(session_key: Any, username: str) -> int:
    """新话题 / 删除历史时立即清除该会话记忆（归属不符则一条都不删）"""
    sid = str(session_key or "").strip()
    if not is_direct_session(sid) or not username:
        return 0
    try:
        with get_connection() as conn:
            cur = conn.execute("DELETE FROM chat_turns WHERE session_key=? AND username=?", (sid, username))
            conn.commit()
            return cur.rowcount or 0
    except Exception as e:
        logger.warning(f"[对话记忆] 清除会话失败: {e}")
        return 0


def purge_user(username: str) -> int:
    try:
        with get_connection() as conn:
            cur = conn.execute("DELETE FROM chat_turns WHERE username=?", (username,))
            conn.commit()
            return cur.rowcount or 0
    except Exception as e:
        logger.warning(f"[对话记忆] 清空用户记忆失败: {e}")
        return 0


def prune_expired(ttl_minutes: Optional[int] = None) -> int:
    """删除所有超过 TTL 的轮次（后台兜底，分钟级）"""
    minutes = int(ttl_minutes) if ttl_minutes else int(_cfg("CHAT_MEMORY_TTL_MINUTES"))
    cutoff = (datetime.now() - timedelta(minutes=minutes)).strftime("%Y-%m-%d %H:%M:%S")
    try:
        with get_connection() as conn:
            cur = conn.execute("DELETE FROM chat_turns WHERE created_at < ?", (cutoff,))
            conn.commit()
            return cur.rowcount or 0
    except Exception as e:
        logger.warning(f"[对话记忆] 过期清理失败: {e}")
        return 0


def stats() -> dict[str, Any]:
    """供管理员观测：行数、占用字节、最老一条的时间"""
    out: dict[str, Any] = {"rows": 0, "bytes": 0, "oldest": "", "enabled": enabled(),
                           "max_turns": int(_cfg("CHAT_MEMORY_MAX_TURNS")),
                           "ttl_minutes": int(_cfg("CHAT_MEMORY_TTL_MINUTES")),
                           "max_rows": int(_cfg("CHAT_MEMORY_MAX_ROWS"))}
    try:
        with get_connection() as conn:
            row = conn.execute("SELECT COUNT(*), COALESCE(SUM(LENGTH(content)), 0), MIN(created_at) FROM chat_turns").fetchone()
            out["rows"], out["bytes"], out["oldest"] = int(row[0] or 0), int(row[1] or 0), str(row[2] or "")
    except Exception as e:
        out["error"] = str(e)[:120]
    return out
