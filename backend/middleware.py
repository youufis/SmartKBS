"""
FastAPI 中间件
- JWT 认证中间件（401 带原因码 + 令牌滑动续期）
- 在线用户活跃度追踪
- SSE 感知的 GZip 中间件（压缩会把流式输出憋没，故 SSE/二进制直发 + 启动自检）
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


# ── SSE 与"压不动"的响应必须跳过 GZip ──────────────────────────────────────
#
# 为什么必须跳过：gzip.GzipFile 会把写进去的字节攒在自己的缓冲里，SSE 逐块
# 产出的小片段会被憋到整条流结束才一次性吐给客户端，表现就是"对话没有流式输出"。
#
# 这段逻辑真正的坑：它依赖 Starlette 的私有压缩钩子，而这个钩子改过名字。
# 同一份代码在三个环境里跑的是三个版本，行为并不一致（均已实测）：
#   * 0.41.3 —— 只有 send_with_gzip，且完全没有"按 content-type 排除"的机制，
#     SSE 必须我们自己放行，否则整条流会被攒到结束才吐；
#     这个版本来自 pip install --user 装在
#     C:\Users\<账号>\AppData\Roaming\Python\Python311\site-packages 的老包，
#     它遮蔽了 C:\Program Files\Python311 下的全局版本，所以凡是"不走 .venv"
#     起的后端（IIS 应用程序池、直接敲 uvicorn）解析到的都是它。
#   * 0.52.1 / 1.3.1 —— 钩子改名成 send_with_compression + apply_compression，
#     并由 DEFAULT_EXCLUDED_CONTENT_TYPES 内建排除 text/event-stream。
# 时间线：2026-08-15 ecf309c 挂旧钩子修好 → 2026-09-10 9d2afb5 重构时只挂新钩子、
# 把 SSE 交给上游兜底 → 旧钩子没人调用、新钩子在 0.41.3 上不存在，"跳过压缩"
# 静默失效，服务器上知识问答的流式输出又没了（本地 .venv 是新版本所以一切正常）。
# 结论：两代钩子都实现，任一命中即可；再加一道启动自检，探测不过就整体不压缩。

#: SSE 的响应类型（新版 Starlette 也排除它，这里重复一遍以求两版行为一致）
_SSE_CONTENT_TYPES = ("text/event-stream",)

#: 这些响应类型本身就是压缩格式或二进制，gzip 压不动，直发更快。
#: 实测：root/html/puzzle/ruffle 下 13.9MB 的 core.ruffle *.wasm 压缩一次约 14s，
#: 不压缩只要 1.4s —— 全班同时打开互动课件时，CPU 会被 gzip 完全吃掉。
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
    """该响应是否应当按 identity 原样直发：SSE、二进制、以及已压缩的内容。"""
    ct = content_type.split(";", 1)[0].strip().lower()
    if not ct:
        return False
    if ct.startswith(_SSE_CONTENT_TYPES):   # 一压缩就攒流，必须直发
        return True
    if ct == "image/svg+xml":      # svg 是文本，压缩收益明显，不跳过
        return False
    return ct in _NO_GZIP_CONTENT_TYPES or ct.startswith(_NO_GZIP_PREFIXES)


#: 当前 Starlette 用的是哪一代压缩钩子（两条都可能不存在，故分别记录）
_HAS_LEGACY_GZIP_HOOK = hasattr(GZipResponder, "send_with_gzip")
_HAS_MODERN_GZIP_HOOK = hasattr(GZipResponder, "send_with_compression")


class SSEAwareGZipResponder(GZipResponder):
    """GZip 响应包装器：SSE 与"压不动"的响应直发，其余照常压缩。

    两条钩子分别对应一代 Starlette，这里同时实现：装哪一代就走哪条路，
    另一条在对应版本上只是不被调用的死代码，不会报错。
    """

    def __init__(self, app, minimum_size: int, compresslevel: int = 9):
        super().__init__(app, minimum_size, compresslevel)
        self._skip_gzip = False      # 新版：让 apply_compression 原样返回即可
        self._passthrough = False    # 旧版：无压缩函数可挂，整条响应直接透传

    # ── 旧版 Starlette(<=0.46) 的唯一钩子 ──
    async def send_with_gzip(self, message: Message) -> None:
        if self._passthrough:
            await self.send(message)
            return

        if message["type"] == "http.response.start":
            content_type = Headers(raw=message["headers"]).get("content-type", "")
            if _gzip_is_waste(content_type):
                # 头里不带 Content-Encoding，body 原样下发，等价于 identity 直发
                self._passthrough = True
                await self.send(message)
                return

        await super().send_with_gzip(message)

    # ── 新版 Starlette(>=0.47) 的钩子 ──
    async def send_with_compression(self, message: Message) -> None:
        if message["type"] == "http.response.start" and not self.started:
            content_type = Headers(raw=message["headers"]).get("content-type", "")
            self._skip_gzip = _gzip_is_waste(content_type)
        await super().send_with_compression(message)

    def apply_compression(self, body: bytes, *, more_body: bool) -> bytes:
        if self._skip_gzip:
            return body
        return super().apply_compression(body, more_body=more_body)


#: 自检不通过时置 False：宁可整站不压缩，也绝不能把流式输出憋成一次性返回。
GZIP_ENABLED = True


async def _gzip_bypass_selftest() -> str:
    """拿一条模拟的 text/event-stream 响应，真跑一遍本模块的 responder。

    返回空串表示通过，否则是不通过的原因。之所以不看版本号、不满足于
    hasattr 而是实测：私有钩子一旦被再次改名，症状只是"流式没了"，
    极难归因；自检把它变成启动日志里一条明确的错误。
    """
    chunks = [b"data: one\n\n", b"data: two\n\n", b"data: three\n\n"]
    sent: list[Message] = []

    async def _app(scope, receive, send):
        await send({
            "type": "http.response.start",
            "status": 200,
            "headers": [(b"content-type", b"text/event-stream; charset=utf-8")],
        })
        for index, chunk in enumerate(chunks):
            await send({
                "type": "http.response.body",
                "body": chunk,
                "more_body": index < len(chunks) - 1,
            })

    async def _capture(message: Message) -> None:
        sent.append(message)

    async def _receive() -> Message:
        return {"type": "http.disconnect"}

    responder = SSEAwareGZipResponder(_app, minimum_size=1)
    await responder({"type": "http"}, _receive, _capture)

    if not sent or sent[0].get("type") != "http.response.start":
        return "未捕获到响应头"
    if Headers(raw=sent[0]["headers"]).get("content-encoding"):
        return "SSE 响应被写上 Content-Encoding，压缩没有跳过"
    bodies = [m.get("body", b"") for m in sent if m.get("type") == "http.response.body"]
    if b"".join(bodies) != b"".join(chunks):
        return "SSE 响应体被改写（多半是 gzip 缓冲）"
    if len(bodies) != len(chunks) or not all(bodies):
        return f"SSE 分块被合并：{len(bodies)}/{len(chunks)}"
    return ""


async def check_gzip_middleware() -> bool:
    """启动自检：确认"跳过压缩"在当前 Starlette 上确实生效。

    探测失败时关掉整个响应压缩（GZIP_ENABLED=False）并打错误日志，
    保证流式输出可用优先于压缩收益。返回压缩是否启用。
    """
    global GZIP_ENABLED
    hook = ("modern:send_with_compression" if _HAS_MODERN_GZIP_HOOK
            else "legacy:send_with_gzip" if _HAS_LEGACY_GZIP_HOOK else "none")
    try:
        reason = await _gzip_bypass_selftest()
    except Exception as exc:      # 自检本身出问题不应该影响启动
        logger.warning(f"[gzip] SSE 跳压缩自检执行失败(忽略, 压缩照常): {exc}")
        return GZIP_ENABLED

    if reason:
        GZIP_ENABLED = False
        logger.error(
            f"[gzip] SSE 跳压缩自检失败：{reason} "
            f"(starlette={_starlette_version()}, 钩子={hook})；"
            "已关闭整站响应压缩以保证对话/生成类流式输出实时下发，"
            "请尽快核对 starlette 版本与 backend/middleware.py 的压缩钩子实现"
        )
    else:
        logger.info(
            f"[gzip] SSE 跳压缩自检通过 (starlette={_starlette_version()}, 钩子={hook})："
            "文本响应照常压缩，text/event-stream 与二进制/已压缩响应直发"
        )
    return GZIP_ENABLED


def _starlette_version() -> str:
    try:
        import starlette
        return getattr(starlette, "__version__", "unknown")
    except Exception:
        return "unknown"


class SSEAwareGZipMiddleware(GZipMiddleware):
    """GZip 中间件：普通文本响应压缩，SSE 与二进制/已压缩响应直发。"""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not GZIP_ENABLED or scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        if "gzip" in headers.get("Accept-Encoding", ""):
            responder = SSEAwareGZipResponder(
                self.app, self.minimum_size, compresslevel=self.compresslevel
            )
            await responder(scope, receive, send)
            return
        await self.app(scope, receive, send)
