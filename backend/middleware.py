"""
FastAPI 中间件
- JWT 认证中间件
- 在线用户活跃度追踪
- CORS
"""
from typing import Optional

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from backend.auth import decode_jwt_token, update_active_token


def extract_token(request: Request) -> Optional[str]:
    """从请求头中提取 Bearer token"""
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        return auth_header[7:]
    return None


class AuthMiddleware(BaseHTTPMiddleware):
    """JWT 认证中间件：验证 token 并将用户信息注入 request.state"""

    async def dispatch(self, request: Request, call_next):
        # 公开路径：不需要认证
        public_paths = [
            "/api/auth/login",
            "/api/auth/logout",
            "/api/files/",
            "/api/resources/nav",
            "/score-api/",
            "/rollcall-api/",
            "/static/",
            "/docs",
            "/openapi.json",
            "/uploads/",
        ]
        request_path = request.url.path

        # 检查是否为公开路径
        is_public = any(request_path.startswith(p) for p in public_paths)

        # 如果是前端路由（没有 API 前缀），也放行
        if not request_path.startswith("/api/") and not any(
            request_path.startswith(p) for p in ["/score-api/", "/rollcall-api/", "/downloads-api/"]
        ):
            is_public = True

        # 尝试从多个来源提取 token
        token = extract_token(request)

        # 从 Cookie 中提取（用于浏览器直接导航到资源文件）
        if not token:
            token = request.cookies.get("smartkb_token")

        # 从 URL 查询参数中提取（用于开发环境或特殊场景）
        if not token:
            token = request.query_params.get("token")

        if token:
            payload = decode_jwt_token(token)
            if payload:
                # 注入用户信息
                request.state.user = payload
                update_active_token(token)
            else:
                # token 无效
                if not is_public:
                    return JSONResponse(
                        status_code=401,
                        content={"detail": "无效的认证令牌"},
                    )
        else:
            request.state.user = None

        response = await call_next(request)
        return response


def register_middleware(app: FastAPI):
    """注册所有中间件"""
    app.add_middleware(AuthMiddleware)
