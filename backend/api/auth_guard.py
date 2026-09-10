"""
路由层鉴权小工具：把"未登录"统一收敛到一个带原因码的异常上。

用法：
    from backend.api.auth_guard import unauthorized
    ...
    if not user:
        raise unauthorized()            # code=auth_missing -> {"detail": "...", "code": "auth_missing"}
    raise unauthorized("token_expired") # 过期/被顶下线等具体原因
"""
from typing import Any, Optional

from fastapi import Request

from backend.auth_errors import AUTH_MISSING, AuthError


def unauthorized(code: str = AUTH_MISSING, message: Optional[str] = None) -> AuthError:
    """构造（不抛出）一个带原因码的 401，调用处写 `raise unauthorized()`。"""
    return AuthError(code, message)


def current_user(request: Request) -> dict[str, Any]:
    """取当前登录用户，未登录抛带码 401（替代各路由里手写的 `if not user: raise 401`）。"""
    user = getattr(request.state, "user", None)
    if user is None:
        raise unauthorized()
    return user
