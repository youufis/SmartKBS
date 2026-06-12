"""
认证 API 路由
登录 / 登出 / 当前用户 / 在线人数
"""
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from backend.database import execute_query, execute_insert_update
from backend.auth import (
    check_password,
    create_jwt_token,
    increment_token_version,
    get_user_role,
    remove_active_token,
    remove_active_token_by_username,
    get_online_count,
)
from backend.api.config_router import get_config_value
from backend.logger import logger

router = APIRouter()


class LoginRequest(BaseModel):
    username_or_name: str
    password: str


@router.post("/login")
async def login(req: LoginRequest, fastapi_request: Request):
    """用户登录，支持用户名或姓名"""
    username_or_name = req.username_or_name.strip()
    password = req.password

    if not username_or_name or not password:
        raise HTTPException(status_code=400, detail="用户名和密码不能为空")

    # 先按用户名查询
    rows = execute_query(
        "SELECT username, password, class, name, gender, role, grade FROM users WHERE username=?",
        (username_or_name,),
    )

    # 如果用户名未找到，按姓名查询
    if not rows:
        name_rows = execute_query(
            "SELECT username, password, class, name, gender, role, grade FROM users WHERE name=?",
            (username_or_name,),
        )
        if len(name_rows) > 1:
            raise HTTPException(
                status_code=400,
                detail="存在多个同名用户，请使用用户名登录",
            )
        rows = name_rows

    if not rows:
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    username, hashed_password, class_val, name_val, gender_val, role_val, grade_val = rows[0]

    # 验证密码
    if not check_password(password, hashed_password):
        raise HTTPException(status_code=401, detail="密码错误")

    # 登录前递增 token_version，使旧 token 失效（强制单点登录）
    increment_token_version(username)
    token = create_jwt_token(username, role_val, name=name_val or "")

    # 格式化用户信息
    gender_str = ""
    if gender_val is not None:
        g = str(gender_val)
        if g in ("1", "M", "m", "男"):
            gender_str = "男"
        elif g in ("2", "F", "f", "女", "0"):
            gender_str = "女"
        else:
            gender_str = g

    role_name = {0: "admin", 1: "teacher", 2: "student"}.get(role_val, "student")

    # ── 记录登录日志（考勤统计用） ──
    # 仅记录学生账号（role=2）的登录
    logger.info(f"登录日志检查 - username={username}, role_val={role_val}, name_val={name_val}")
    if role_val == 2:
        try:
            import datetime
            now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

            # 先关闭上一次未登出的会话（logout_time 默认是空字符串，需同时匹配 NULL 和 ''）
            execute_insert_update(
                "UPDATE login_logs SET logout_time=? WHERE username=? AND (logout_time IS NULL OR logout_time = '')",
                (now_str, username),
            )

            # 获取客户端 IP（用 fastapi_request 而非 req，因为 req 是 Pydantic 模型）
            client_ip = fastapi_request.headers.get("x-forwarded-for", "")
            if client_ip:
                client_ip = client_ip.split(",")[0].strip()
            else:
                client_ip = fastapi_request.client.host if fastapi_request.client else "unknown"
            user_agent = fastapi_request.headers.get("user-agent", "")[:200]
            execute_insert_update(
                """INSERT INTO login_logs (username, student_name, grade, class_name, login_time, login_ip, user_agent)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (username, name_val or "", grade_val or "", str(class_val) if class_val else "",
                 now_str, client_ip, user_agent),
            )
            logger.info(f"登录日志已记录: {username} @ {now_str} from {client_ip}")
        except Exception as e:
            logger.warning(f"记录登录日志失败: {e}")
            import traceback
            logger.warning(traceback.format_exc())

        # ── 每日登录积分奖励（仅学生，一天一次） ──
        try:
            from backend.reward_engine import award_daily_login
            awarded = award_daily_login(username)
            if awarded:
                logger.info(f"每日登录奖励: {username} +1 分")
        except Exception as e:
            logger.warning(f"每日登录奖励发放失败: {e}")

    logger.info(f"用户登录成功: {username}")

    # 设置 Cookie，使浏览器直接导航到 /api/files/ 资源时能携带身份信息
    response = JSONResponse(content={
        "token": token,
        "user": {
            "username": username,
            "name": name_val or "",
            "class": str(class_val) if class_val else "",
            "gender": gender_str,
            "role": role_name,
            "grade": grade_val or "",
        },
    })
    response.set_cookie(
        key="smartkb_token",
        value=token,
        httponly=True,      # 防止 XSS 窃取
        samesite="lax",     # 允许同站导航携带
        max_age=get_config_value("JWT_EXPIRATION_HOURS", 24) * 3600,  # 与 JWT 过期时间一致
        path="/",
    )
    return response


@router.post("/logout")
async def logout(request: Request):
    """登出（使当前用户的所有 token 失效，清除 cookie）"""
    user = request.state.user
    if user:
        username = user.get("username", "")
        if username:
            # 记录登出时间
            try:
                import datetime
                now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                execute_insert_update(
                    "UPDATE login_logs SET logout_time=? WHERE username=? AND (logout_time IS NULL OR logout_time = '')",
                    (now_str, username),
                )
            except Exception as e:
                logger.warning(f"记录登出时间失败: {e}")

            increment_token_version(username)  # 递增版本号，清除所有在线会话
            remove_active_token_by_username(username)
            logger.info(f"用户登出: {username}")

    response = JSONResponse(content={"message": "已登出"})
    response.delete_cookie(key="smartkb_token", path="/")
    return response


@router.get("/me")
async def get_current_user(request: Request):
    """获取当前登录用户信息"""
    user = request.state.user
    if not user:
        raise HTTPException(status_code=401, detail="未登录")

    username = user["username"]
    rows = execute_query(
        "SELECT username, class, name, gender, role, grade FROM users WHERE username=?",
        (username,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="用户不存在")

    username, class_val, name_val, gender_val, role_val, grade_val = rows[0]
    role_name = {0: "admin", 1: "teacher", 2: "student"}.get(role_val, "student")

    # ── 会话恢复时也记录考勤（学生自动登录/刷新页面均会触发） ──
    if role_val == 2:
        try:
            # 检查今天是否已有记录，避免重复写入过多
            import datetime
            today = datetime.datetime.now().strftime("%Y-%m-%d")
            existing = execute_query(
                "SELECT COUNT(*) FROM login_logs WHERE username=? AND login_time LIKE ?",
                (username, f"{today}%"),
            )
            if existing and existing[0][0] == 0:
                client_ip = request.headers.get("x-forwarded-for", "")
                if client_ip:
                    client_ip = client_ip.split(",")[0].strip()
                else:
                    client_ip = request.client.host if request.client else "unknown"
                user_agent = request.headers.get("user-agent", "")[:200]
                now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                execute_insert_update(
                    """INSERT INTO login_logs (username, student_name, grade, class_name, login_time, login_ip, user_agent)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (username, name_val or "", grade_val or "", str(class_val) if class_val else "",
                     now_str, client_ip, user_agent),
                )
                logger.info(f"会话恢复记录考勤: {username} @ {now_str}")
        except Exception as e:
            logger.warning(f"会话恢复记录考勤失败: {e}")

    return {
        "username": username,
        "name": name_val or "",
        "class": str(class_val) if class_val else "",
        "role": role_name,
        "grade": grade_val or "",
    }


@router.get("/online-count")
async def online_count():
    """获取在线用户数"""
    return {"count": get_online_count()}
