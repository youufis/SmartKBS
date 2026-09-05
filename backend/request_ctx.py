"""当前请求用户上下文。

中间件解析出登录用户后写入, 供 AI 后台任务记录归属者
(见 ai_task_manager.create_task), 避免为几十个调用点逐个加参数。
"""
from contextvars import ContextVar
from typing import Any

_current_user: ContextVar[dict[str, Any] | None] = ContextVar("current_user", default=None)


def set_current_user(payload: dict[str, Any] | None) -> None:
    _current_user.set(payload)


def get_current_username() -> str:
    user = _current_user.get()
    if not user:
        return ""
    return str(user.get("username") or "")
