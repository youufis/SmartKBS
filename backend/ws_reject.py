"""WebSocket 拒绝握手的统一出口：先握手、再按应用状态码关闭，并留一行可排查的记录。

为什么必须 accept 之后再 close()
--------------------------------
Starlette 在 accept 之前调用 close()，ASGI 层等价于"这个连接我不接"，uvicorn 直接
回一个 HTTP 403（`websockets` 实现再补两行 "connection rejected (403 Forbidden)" /
"connection closed"）。浏览器侧的 onclose 只能拿到 1006 —— 没有关闭码、没有原因。
于是前端"未认证/无权限就别再重连"的判断（按 event.code 认 4401/4403/4001）永远
触发不了。2026-10-21 现场：一个挂着失效令牌的页面每 5 秒撞一次提问 WS 握手，
白板只读端连不上 WS 后退化成 3 秒一轮的 /snapshot 兜底轮询，终端被 403 三连行和
401 海一起刷满，而且每行都把 JWT 原文抄一遍。

改成"握手成功 → 立刻按应用状态码关闭"之后：
  · 前端拿到真实的 4401/4403/4001，按各自的非重连码停手；
  · 访问日志里那条握手行变成 [accepted]，由 backend/logger.py 的
    _WsHandshakeNoiseFilter 与 uvicorn 的协议行一起去噪（60 秒一条）；
  · 这里自己打的那行 WARN 才是有用的一条：原因码(token_stale/expired/...)、
    账号、来源 IP，同样按 60 秒限流，不会因为一个挂机页面刷屏。
"""
from typing import Any

from fastapi import WebSocket

from backend.auth import peek_token_username
from backend.logger import RepeatThrottle, logger

#: 同一 (入口+关闭码+原因码+IP) 的记录节流：满速每分钟一条，重复后最长退避到 15 分钟
_throttle = None


def _client_ip(websocket: WebSocket) -> str:
    """真实 TCP 对端；客户端自己塞 X-Forwarded-For 不算数（与 security_guard 一致）"""
    try:
        from backend.security_guard import client_ip

        return client_ip(websocket)  # 只用到 .headers / .client，WebSocket 同样满足
    except Exception:
        peer = getattr(websocket, "client", None)
        return getattr(peer, "host", "") or "unknown"


def _log_reject(where: str, code: int, reason: str, auth_code: str,
                username: str, ip: str, path: str) -> None:
    global _throttle
    if _throttle is None:
        _throttle = RepeatThrottle(60.0, 900.0, 3)
    if not _throttle.allow(f"{where}|{code}|{auth_code}|{ip}"):
        return
    logger.warning(
        f"[WS] 拒绝连接 {where} path={path} code={code}"
        + (f" 原因码={auth_code}" if auth_code else "")
        + f" user={username or '<未知>'} ip={ip} 说明={reason}"
    )


async def reject_websocket(
    websocket: WebSocket,
    *,
    code: int = 4401,
    reason: str = "未认证",
    where: str = "WS",
    token: str = "",
    auth_code: str = "",
    username: str = "",
    send_frame: bool = True,
) -> None:
    """拒绝一次 WebSocket 握手：记录一行（限流）+ 先 accept 再按应用码关闭。

    send_frame=False 时不回业务帧：白板对"压根没通过认证"的一方只给关闭码，
    不回显内容（见 whiteboard_router._ws_reject），但关闭码仍然要送到位。
    """
    path = ""
    try:
        path = str(websocket.url.path)
    except Exception:
        pass
    if not token:
        # 白板已改成"握手优先用同源 Cookie 带令牌"，这里也照着同一顺序取一次，
        # 只为了让日志能写下"是谁的旧凭证还在打"（不参与任何鉴权判定）
        try:
            from backend.middleware import TOKEN_COOKIE
        except Exception:
            TOKEN_COOKIE = "smartkb_token"
        token = (websocket.query_params.get("token", "")
                 or websocket.cookies.get(TOKEN_COOKIE, ""))
    if not username and token:
        # 只解签名有效的令牌，且绝不参与鉴权判定：伪造令牌里的用户名不进日志
        username = peek_token_username(token)
    _log_reject(where, code, reason, auth_code, username, _client_ip(websocket), path)

    try:
        await websocket.accept()
    except Exception as e:
        logger.debug(f"[WS] {where} 握手前的 accept 未完成（客户端可能已断开）: {e}")
    if send_frame:
        try:
            await websocket.send_json({"type": "ws_rejected", "code": code, "reason": reason})
        except Exception as e:
            logger.debug(f"[WS] {where} 拒绝原因未送达: {e}")
    try:
        await websocket.close(code=code, reason=reason)
    except Exception as e:
        logger.debug(f"[WS] {where} 关闭未送达 code={code}: {e}")


def close_hint(payload_or_code: Any) -> tuple[int, str]:
    """把 verify_token 的原因码翻成 (关闭码, 给前端的说明)，供各 WS 端点复用。"""
    from backend.auth_errors import AUTH_EXPIRED, AUTH_MISSING, AUTH_STALE

    code = payload_or_code if isinstance(payload_or_code, str) else ""
    if code == AUTH_EXPIRED:
        return 4401, "登录已过期，请重新登录"
    if code == AUTH_STALE:
        return 4401, "账号已在其他地方登录或已退出，请重新登录"
    if code == AUTH_MISSING:
        return 4401, "未登录，请先登录"
    return 4401, "未认证"
