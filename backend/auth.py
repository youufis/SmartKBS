"""
认证工具函数
JWT 生成/验证 + 密码哈希 + 角色判断
移植自 AgentSmartKBXS.py
"""
import time
from datetime import datetime, timedelta, timezone
from typing import Optional, Any

import bcrypt
import jwt

from backend.config import (
    JWT_SECRET_KEY,
    JWT_ALGORITHM,
    JWT_EXPIRATION_HOURS,
    ONLINE_USER_TIMEOUT_SECONDS,
)
from backend.database import execute_query, execute_insert_update

# ── 在线用户管理（替代全局变量 active_users）──
_active_tokens: dict[str, float] = {}  # token -> last_active_time


def update_active_token(token: str):
    """更新 token 活跃时间"""
    _active_tokens[token] = time.time()


def remove_active_token(token: str):
    """移除 token"""
    _active_tokens.pop(token, None)


def get_online_count() -> int:
    """获取在线用户数（按用户名去重），自动清理过期 token"""
    now = time.time()
    expired = [t for t in _active_tokens
               if now - _active_tokens[t] > ONLINE_USER_TIMEOUT_SECONDS]
    for t in expired:
        del _active_tokens[t]
    # 解码 token 统计唯一用户名
    usernames: set[str] = set()
    for token in list(_active_tokens.keys()):
        payload = decode_jwt_token(token)
        if payload and "username" in payload:
            usernames.add(payload["username"])
    return len(usernames)


# ── 密码哈希 ──

def hash_password(password: str) -> bytes:
    """生成 bcrypt 密码哈希"""
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())


def check_password(password: str, hashed: bytes) -> bool:
    """验证密码"""
    return bcrypt.checkpw(password.encode("utf-8"), hashed)


# ── JWT ──

def create_jwt_token(username: str, role: int) -> str:
    """创建 JWT token"""
    payload = {
        "username": username,
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRATION_HOURS),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def decode_jwt_token(token: str) -> dict[str, Any] | None:
    """解码 JWT token，返回 payload 或 None"""
    try:
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None


# ── 角色判断 ──

def get_user_role(username: str) -> Optional[int]:
    """获取用户角色: 0=管理员, 1=教师, 2=普通用户"""
    rows = execute_query("SELECT role FROM users WHERE username=?", (username,))
    if rows:
        return rows[0][0]
    return None


def is_admin(username: str) -> bool:
    role = get_user_role(username)
    return role == 0


def is_teacher(username: str) -> bool:
    role = get_user_role(username)
    return role == 1


def is_regular_user(username: str) -> bool:
    role = get_user_role(username)
    return role == 2


def can_create_task(username: str) -> bool:
    return is_admin(username) or is_teacher(username)


def can_manage_users(username: str) -> bool:
    return is_admin(username)


def can_import_users(username: str) -> bool:
    """是否允许导入用户（管理员和教师均可）"""
    return is_admin(username) or is_teacher(username)


def can_manage_html_files(username: str) -> bool:
    return is_admin(username) or is_teacher(username)


def can_provide_api_key(username: str) -> bool:
    return is_admin(username) or is_teacher(username)
