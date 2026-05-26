"""
FastAPI 依赖注入工具
提供 get_current_user 等公共依赖
"""
from typing import Any
from fastapi import Request, HTTPException


def get_current_user(request: Request) -> dict[str, Any]:
    """从 request.state 获取当前登录用户信息"""
    user = request.state.user
    if user is None:
        raise HTTPException(status_code=401, detail="未登录")
    return user


def require_admin(user: dict[str, Any] | None = None) -> dict[str, Any]:
    """要求当前用户为管理员（装饰器或依赖链使用）"""
    if user is None or user.get("role") != 0:
        raise HTTPException(status_code=403, detail="权限不足：需要管理员权限")
    return user
