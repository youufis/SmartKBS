"""
认证工具函数
JWT 生成/验证 + 密码哈希 + 角色判断
"""
import time
from datetime import datetime, timedelta, timezone
from typing import Optional, Any

import bcrypt
import jwt

from backend.config import (
    JWT_SECRET_KEY,
    JWT_ALGORITHM,
)
from backend.api.config_router import get_config_value
from backend.database import execute_query, execute_insert_update, get_connection

# ── 在线用户管理（替代全局变量 active_users）──
_active_tokens: dict[str, float] = {}  # token -> last_active_time


def update_active_token(token: str):
    """更新 token 活跃时间"""
    _active_tokens[token] = time.time()


def remove_active_token(token: str):
    """移除 token"""
    _active_tokens.pop(token, None)


def remove_active_token_by_username(username: str):
    """移除该用户的所有活跃 token（用于登出时清除在线状态）"""
    for token in list(_active_tokens.keys()):
        payload = decode_jwt_token(token)
        if payload and payload.get("username") == username:
            del _active_tokens[token]


def get_online_usernames() -> set[str]:
    """获取所有在线用户的用户名集合，自动清理过期 token"""
    now = time.time()
    timeout = get_config_value("ONLINE_USER_TIMEOUT_SECONDS", 1800)
    expired = [t for t in _active_tokens
               if now - _active_tokens[t] > timeout]
    for t in expired:
        del _active_tokens[t]
    usernames: set[str] = set()
    for token in list(_active_tokens.keys()):
        payload = decode_jwt_token(token)
        if payload and "username" in payload:
            usernames.add(payload["username"])
    return usernames


def get_online_count() -> int:
    """获取在线用户数（按用户名去重）"""
    return len(get_online_usernames())


# ── 密码哈希 ──

def hash_password(password: str) -> bytes:
    """生成 bcrypt 密码哈希"""
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())


def check_password(password: str, hashed: bytes) -> bool:
    """验证密码"""
    return bcrypt.checkpw(password.encode("utf-8"), hashed)


# ── JWT ──

def get_token_version(username: str) -> int:
    """获取用户当前的 token 版本号"""
    rows = execute_query("SELECT token_version FROM users WHERE username=?", (username,))
    return rows[0][0] if rows else 0


def increment_token_version(username: str) -> int:
    """递增 token 版本号（使旧 token 失效），返回新版本号"""
    with get_connection() as conn:
        conn.cursor().execute(
            "UPDATE users SET token_version = token_version + 1 WHERE username=?",
            (username,),
        )
        conn.commit()
    return get_token_version(username)


def create_jwt_token(username: str, role: int, name: str = "") -> str:
    """创建 JWT token（携带 token_version，用于单点登录校验）"""
    version = get_token_version(username)
    payload = {
        "username": username,
        "role": role,
        "name": name,
        "token_version": version,
        "exp": datetime.now(timezone.utc) + timedelta(hours=get_config_value("JWT_EXPIRATION_HOURS", 24)),
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


def verify_token_version(payload: dict[str, Any]) -> bool:
    """验证 token 版本号是否与数据库一致（防止多设备登录）"""
    username = payload.get("username", "")
    token_version = payload.get("token_version", 0)
    db_version = get_token_version(username)
    return token_version == db_version


# ── 角色常量（统一入口，禁止硬编码数字） ──
ROLE_ADMIN = 0
ROLE_TEACHER = 1
ROLE_STUDENT = 2

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


# ── 密保问题（双问题验证 + 频率限制）──

# 预设密保问题列表
SECURITY_QUESTIONS = [
    "你的学号/工号是多少？",
    "你的出生地是哪里？",
    "你最喜欢的科目是什么？",
    "你的班主任姓名是什么？",
    "你最喜欢的一位老师名字是什么？",
    "你的小学名称是什么？",
    "你母亲的姓名是什么？",
    "你父亲的姓名是什么？",
    "你最喜欢的颜色是什么？",
    "你的宠物名字是什么？",
]

MAX_SECURITY_FAILED_ATTEMPTS = 5
SECURITY_LOCK_MINUTES = 30


def _get_now_str() -> str:
    from datetime import datetime
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _parse_datetime(dt_str: str):
    from datetime import datetime
    try:
        return datetime.strptime(dt_str, "%Y-%m-%d %H:%M:%S")
    except (ValueError, TypeError):
        return None


def get_security_questions(username: str) -> tuple[str, str]:
    """获取用户设置的两个密保问题"""
    rows = execute_query(
        "SELECT security_question, security_question2 FROM users WHERE username=?",
        (username,),
    )
    if rows:
        return (rows[0][0] or "", rows[0][1] or "")
    return ("", "")


def has_security_configured(username: str) -> bool:
    """检查用户是否已设置双密保"""
    rows = execute_query(
        "SELECT security_question, security_question2 FROM users WHERE username=?",
        (username,),
    )
    return bool(rows and rows[0][0] and rows[0][1])


def set_security_questions(username: str, q1: str, a1: str, q2: str, a2: str) -> None:
    """设置双密保问题（答案用 bcrypt 哈希存储）"""
    h1 = bcrypt.hashpw(a1.encode("utf-8"), bcrypt.gensalt())
    h2 = bcrypt.hashpw(a2.encode("utf-8"), bcrypt.gensalt())
    execute_insert_update(
        """UPDATE users
           SET security_question=?, security_answer_hash=?,
               security_question2=?, security_answer_hash2=?,
               security_failed_attempts=0, security_locked_until=''
           WHERE username=?""",
        (q1, h1, q2, h2, username),
    )


def verify_security_answer(username: str, answer: str, question_index: int = 0) -> bool:
    """验证指定索引的密保答案（question_index: 0=第一题, 1=第二题）"""
    col = "security_answer_hash" if question_index == 0 else "security_answer_hash2"
    rows = execute_query(
        f"SELECT {col} FROM users WHERE username=?", (username,)
    )
    if not rows or not rows[0][0]:
        return False
    return bcrypt.checkpw(answer.encode("utf-8"), rows[0][0])


# ── 频率限制 ──

def check_security_locked(username: str) -> tuple[bool, str]:
    """检查用户是否被锁定，返回 (是否锁定, 剩余等待描述)"""
    rows = execute_query(
        "SELECT security_failed_attempts, security_locked_until FROM users WHERE username=?",
        (username,),
    )
    if not rows:
        return False, ""

    locked_until_str = rows[0][1] or ""
    if locked_until_str:
        locked_until = _parse_datetime(locked_until_str)
        if locked_until:
            from datetime import datetime
            now = datetime.now()
            if now < locked_until:
                remaining = int((locked_until - now).total_seconds() // 60)
                return True, f"密保验证已锁定，请{remaining}分钟后再试"
            else:
                # 锁定已过期，自动解锁
                execute_insert_update(
                    "UPDATE users SET security_failed_attempts=0, security_locked_until='' WHERE username=?",
                    (username,),
                )
    return False, ""


def increment_failed_attempts(username: str) -> int:
    """递增失败次数，达到上限则锁定，返回当前失败次数"""
    rows = execute_query(
        "SELECT security_failed_attempts FROM users WHERE username=?",
        (username,),
    )
    current = (rows[0][0] or 0) if rows else 0
    current += 1

    if current >= MAX_SECURITY_FAILED_ATTEMPTS:
        from datetime import datetime, timedelta
        locked_until = (datetime.now() + timedelta(minutes=SECURITY_LOCK_MINUTES)).strftime(
            "%Y-%m-%d %H:%M:%S"
        )
        execute_insert_update(
            "UPDATE users SET security_failed_attempts=?, security_locked_until=? WHERE username=?",
            (current, locked_until, username),
        )
    else:
        execute_insert_update(
            "UPDATE users SET security_failed_attempts=? WHERE username=?",
            (current, username),
        )
    return current


def reset_failed_attempts(username: str) -> None:
    """重置失败次数（验证成功后调用）"""
    execute_insert_update(
        "UPDATE users SET security_failed_attempts=0, security_locked_until='' WHERE username=?",
        (username,),
    )
