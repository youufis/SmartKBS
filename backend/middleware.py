"""
FastAPI 中间件
- JWT 认证中间件（401 带原因码 + 令牌滑动续期）
- 在线用户活跃度追踪
- SSE 感知的 GZip 中间件（避免压缩缓冲导致流式输出失效）
"""
from typing import Optional

from fastapi import FastAPI, Request, HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.datastructures import Headers
from starlette.middleware.gzip import GZipMiddleware, GZipResponder
from starlette.types import Message, Receive, Scope, Send

from backend.auth import (
    get_token_ttl_hours,
    renew_token_if_needed,
    update_active_token,
    verify_token,
    verify_token_version,
)
from backend.auth_errors import auth_error_response, log_auth_reject
from backend.security_guard import block_response
from backend.logger import logger
from backend.request_ctx import set_current_user

#: 滑动续期下发新令牌用的响应头/cookie 名（前端 api/client.ts 读同一个头）
RENEW_HEADER = "X-Renew-Token"
TOKEN_COOKIE = "smartkb_token"


def extract_token(request: Request) -> Optional[str]:
    """从请求头中提取 Bearer token"""
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        return auth_header[7:]
    return None


class AuthMiddleware(BaseHTTPMiddleware):
    """JWT 认证中间件：验证 token 并将用户信息注入 request.state"""

    async def dispatch(self, request: Request, call_next):
        # 0) 来源地址先过一道：黑名单 / 因连续鉴权失败被临时封禁的 IP，公开接口也一并拒掉
        #    （登录接口是"猜密码"的靶子，绝不能只靠业务层限流）
        blocked = block_response(request)
        if blocked is not None:
            return blocked

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
            token = request.cookies.get(TOKEN_COOKIE)

        # 从 URL 查询参数中提取（用于开发环境或特殊场景）
        if not token:
            token = request.query_params.get("token")

        # 本次请求是否需要下发续期后的新令牌
        request.state.renewed_token = None

        if token:
            # A2/A3: 统一走 verify_token —— 校验签名 + 账号真实存在 + 版本号一致,
            # 并用数据库里的 role 覆盖令牌里的 role(防止旧令牌角色残留与伪造提权)
            payload, code = verify_token(token)
            if payload:
                request.state.user = payload
                set_current_user(payload)
                update_active_token(token)
                # 滑动续期：令牌剩余寿命不足阈值时，借这次请求换一张新令牌
                try:
                    request.state.renewed_token = renew_token_if_needed(payload)
                except Exception as exc:  # 续期失败绝不能影响正常请求
                    logger.debug(f"[auth] 令牌滑动续期失败(忽略): {exc}")
            else:
                request.state.user = None
                set_current_user(None)
                if not is_public:
                    # 带上原因码: 前端能区分"没带凭证/过期/被顶下线", 日志也能一眼看懂
                    log_auth_reject(request, code, where="middleware")
                    return auth_error_response(code)
        else:
            request.state.user = None
            set_current_user(None)

        response = await call_next(request)

        new_token = getattr(request.state, "renewed_token", None)
        if new_token:
            max_age = get_token_ttl_hours() * 3600
            # 响应里带着一次性换来的新令牌，绝不允许被任何中间缓存存下来
            cache_control = response.headers.get("Cache-Control", "")
            if "no-store" not in cache_control.lower():
                response.headers["Cache-Control"] = (
                    f"{cache_control}, no-store" if cache_control else "no-store"
                )
            response.headers[RENEW_HEADER] = new_token
            # cookie 同步续期，保证"浏览器直接打开 /api/files/..."那条路也不掉登录
            response.set_cookie(
                key=TOKEN_COOKIE,
                value=new_token,
                max_age=max_age,
                httponly=True,
                samesite="lax",
                path="/",
            )
        return response


def register_middleware(app: FastAPI):
    """注册中间件"""
    app.add_middleware(AuthMiddleware)


# 这些响应类型本身就是压缩格式或二进制，gzip 压不动，直发更快。
# 实测：root/html/puzzle/ruffle 下 13.9MB 的 core.ruffle *.wasm 压缩一次约 14s，
# 不压缩只要 1.4s —— 全班同时打开互动课件时，CPU 会被 gzip 完全吃掉。
_NO_GZIP_CONTENT_TYPES = {
    "application/wasm",
    "application/x-shockwave-flash",
    "application/octet-stream",
    "application/zip",
    "application/pdf",
    "application/msword",
}
_NO_GZIP_PREFIXES = ("image/", "video/", "audio/", "font/", "application/vnd.")


def _gzip_is_waste(content_type: str) -> bool:
    """该响应的 content-type 是否不值得压缩。"""
    ct = content_type.split(";", 1)[0].strip().lower()
    if not ct:
        return False
    if ct == "image/svg+xml":      # svg 是文本，压缩收益明显，不跳过
        return False
    return ct in _NO_GZIP_CONTENT_TYPES or ct.startswith(_NO_GZIP_PREFIXES)


class SSEAwareGZipResponder(GZipResponder):
    """GZip 响应包装器：在 Starlette 的基础上，再跳过"压不动"的响应。

    1) SSE(text/event-stream)：gzip.GzipFile 会把输入攒到流结束才吐数据，
       逐块下发的实时输出会被憋没。新版 Starlette 已用
       DEFAULT_EXCLUDED_CONTENT_TYPES 内建排除，这里不再重复处理，只保留说明。
    2) 二进制/已压缩响应(wasm/swf/图片/音视频/zip/office)：压缩率几乎为零，
       纯烧 CPU 并推迟首字节。Starlette 在 send_with_compression 里只有当
       apply_compression() 的返回值与入参不同才会写 Content-Encoding，
       所以让它原样返回就等于"这条响应按 identity 直发"。

    注：Starlette 1.x 把钩子从 send_with_gzip 改名为 send_with_compression，
    老版本上本类退化为原生行为(只是不跳过二进制)，不会报错。
    """

    def __init__(self, app, minimum_size: int, compresslevel: int = 9):
        super().__init__(app, minimum_size, compresslevel)
        self._skip_gzip = False

    async def send_with_compression(self, message: Message) -> None:
        if message["type"] == "http.response.start" and not self.started:
            content_type = Headers(raw=message["headers"]).get("content-type", "")
            self._skip_gzip = _gzip_is_waste(content_type)
        await super().send_with_compression(message)

    def apply_compression(self, body: bytes, *, more_body: bool) -> bytes:
        if self._skip_gzip:
            return body
        return super().apply_compression(body, more_body=more_body)


class SSEAwareGZipMiddleware(GZipMiddleware):
    """GZip 中间件：普通文本响应压缩，SSE 与二进制/已压缩响应直发。"""

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
