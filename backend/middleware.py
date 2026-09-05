"""
FastAPI 中间件
- JWT 认证中间件
- 在线用户活跃度追踪
- SSE 感知的 GZip 中间件（避免压缩缓冲导致流式输出失效）
"""
from typing import Optional

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.datastructures import Headers
from starlette.middleware.gzip import GZipMiddleware, GZipResponder
from starlette.types import Message, Receive, Scope, Send

from backend.auth import decode_jwt_token, update_active_token, verify_token_version
from backend.request_ctx import set_current_user


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
            "/api/auth/security-questions",
            "/api/auth/security-check/",
            "/api/auth/verify-security",
            "/api/auth/reset-password-by-security",
            "/api/resources/nav",
            "/api/scores/",
            "/api/rollcall/",
            "/api/downloads/",
            "/api/files/question_media/",
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
                # 校验 token 版本号（防止多设备同时登录）
                if not verify_token_version(payload):
                    request.state.user = None
                    if not is_public:
                        return JSONResponse(
                            status_code=401,
                            content={"detail": "登录已过期：该账号已在其他地方登录"},
                        )
                else:
                    # 注入用户信息
                    request.state.user = payload
                    set_current_user(payload)
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
            set_current_user(None)

        response = await call_next(request)
        return response


def register_middleware(app: FastAPI):
    """注册中间件"""
    app.add_middleware(AuthMiddleware)


class SSEAwareGZipResponder(GZipResponder):
    """GZip 响应包装器：对 SSE（text/event-stream）响应直接透传，不做压缩。

    gzip.GzipFile 会缓存输入，直到缓冲区攒满或流结束时才输出压缩数据，
    导致 SSE 的小块增量数据被积压到响应结束才一次性发给客户端，
    表现就是“看起来没有流式输出”。SSE 必须跳过压缩才能逐块实时下发。
    """

    def __init__(self, app, minimum_size: int, compresslevel: int = 9):
        super().__init__(app, minimum_size, compresslevel)
        self._is_event_stream = False

    async def send_with_gzip(self, message: Message) -> None:
        if self._is_event_stream:
            # SSE 响应：原样透传，不做任何缓冲/压缩
            await self.send(message)
            return

        if message["type"] == "http.response.start":
            self.initial_message = message
            headers = Headers(raw=message["headers"])
            content_type = headers.get("content-type", "")
            self._is_event_stream = content_type.startswith("text/event-stream")
            if self._is_event_stream:
                await self.send(message)
                return

        await super().send_with_gzip(message)


class SSEAwareGZipMiddleware(GZipMiddleware):
    """GZip 中间件：普通响应保持压缩，SSE 响应跳过压缩以保证实时流式输出。"""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            headers = Headers(scope=scope)
            if "gzip" in headers.get("Accept-Encoding", ""):
                responder = SSEAwareGZipResponder(
                    self.app, self.minimum_size, compresslevel=self.compresslevel
                )
                await responder(scope, receive, send)
                return
        await self.app(scope, receive, send)
