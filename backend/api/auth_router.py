"""
认证 API 路由
登录 / 登出 / 当前用户 / 在线人数
"""
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from backend.database import execute_query
from backend.auth import (
    check_password,
    create_jwt_token,
    increment_token_version,
    get_user_role,
    remove_active_token,
    get_online_count,
)
from backend.api.config_router import get_config_value
from backend.logger import logger

router = APIRouter()


class LoginRequest(BaseModel):
    username_or_name: str
    password: str


@router.post("/login")
async def login(req: LoginRequest):
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

    # 生成 JWT token（先递增版本号，使旧 token 失效）
    increment_token_version(username)
    token = create_jwt_token(username, role_val)

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
async def logout():
    """登出（清除 cookie）"""
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
