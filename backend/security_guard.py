"""
来源 IP 防护（全部内存态，进程重启即清零）

做三件事：
  1. 辨认：鉴权失败时把 User-Agent / Referer / 路径 记进日志。
     uvicorn 的 access log 里没有 UA，光看 `INFO: x.x.x.x - "GET ..." 401`
     根本分不清"某个人忘关页面"还是"脚本在撞库"，这条补齐。
  2. 拦人：同一 IP 在短时间内反复鉴权失败 -> 临时封禁（默认 30 次/60 秒 -> 封 10 分钟）；
     管理员也可以直接把 IP/网段写进 IP_DENYLIST 永久拒绝。
  3. 补盲：登录失败以前**完全不留痕**（login_logs 只写成功），被猜密码时无从发现；
     这里单独审计并配更严的阈值。

注意：封禁按"对端 IP"算。若你的用户都走同一个出口（学校 NAT / 代理），
一个账号被刷就可能连累同出口的正常用户 —— 需要时把 ENABLE_IP_GUARD 关掉或调高阈值。
"""
import ipaddress
import threading
import time
from collections import defaultdict, deque
from typing import Any, Optional

from fastapi import Request
from fastapi.responses import JSONResponse

from backend.api.config_router import get_config_value
from backend.logger import logger

_LOCK = threading.Lock()

#: ip -> 鉴权失败时间戳窗口
_auth_fails: dict[str, deque[float]] = defaultdict(deque)
#: ip -> 登录失败时间戳窗口
_login_fails: dict[str, deque[float]] = defaultdict(deque)
#: ip -> 封禁到期时间(monotonic)
_banned: dict[str, float] = {}
#: ip -> 最近一次可疑行为画像（给管理员接口用）
_offenders: dict[str, dict[str, Any]] = {}

_MAX_TRACKED_IPS = 512


def _num(key: str, default: float) -> float:
    try:
        return float(get_config_value(key, default))
    except (TypeError, ValueError):
        return default


def _bool(key: str, default: bool) -> bool:
    try:
        return bool(get_config_value(key, default))
    except (TypeError, ValueError):
        return default


def normalize_ip(raw: str) -> str:
    """去掉 ::ffff: 前缀和 :端口 后缀，返回纯 IP 字符串"""
    ip = (raw or "").strip()
    if ip.startswith("[") and "]" in ip:          # [2408:8207::1]:1234
        ip = ip[1:ip.index("]")]
    elif ip.count(":") == 1 and ip.rsplit(":", 1)[1].isdigit():
        ip = ip.rsplit(":", 1)[0]      # IPv4:端口
    if ip.lower().startswith("::ffff:"):
        ip = ip[7:]
    return ip or "unknown"


def client_ip(request: Request) -> str:
    """取来源 IP。只有明确信任反代(TRUST_PROXY_HEADERS)时才看 X-Forwarded-For，
    否则客户端自己塞一个 XFF 就能伪造来源、绕过封禁。
    """
    if _bool("TRUST_PROXY_HEADERS", False):
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            return normalize_ip(forwarded.split(",")[0])
        real_ip = request.headers.get("x-real-ip", "")
        if real_ip:
            return normalize_ip(real_ip)
    peer = request.client.host if request.client else ""
    return normalize_ip(peer)


def user_agent(request: Request, limit: int = 120) -> str:
    ua = request.headers.get("user-agent", "") or "-"
    return ua[:limit]


def referer(request: Request) -> str:
    """来源页：能直接看出是哪个页面/站点在发这些请求"""
    return request.headers.get("referer", "") or request.headers.get("origin", "") or "-"


def _deny_entries() -> list[str]:
    raw = get_config_value("IP_DENYLIST", []) or []
    if isinstance(raw, str):
        raw = [x.strip() for x in raw.replace(";", ",").split(",")]
    return [x for x in (str(i).strip() for i in raw) if x]


def match_denylist(ip: str) -> Optional[str]:
    """支持三种写法：精确 IP、前缀（14.112.）、网段（14.112.131.0/24）"""
    for entry in _deny_entries():
        try:
            if "/" in entry:
                if ipaddress.ip_address(ip) in ipaddress.ip_network(entry, strict=False):
                    return entry
            elif entry.endswith((".", ":")):
                if ip.startswith(entry):
                    return entry
            elif entry == ip:
                return entry
        except ValueError:
            continue          # 写错的条目直接忽略，不影响整体判断
    return None


def _prune(window: deque[float], seconds: float, now: float) -> None:
    while window and now - window[0] > seconds:
        window.popleft()


def _note_offender(ip: str, request: Request, kind: str, code: str = "") -> None:
    """记下这个 IP 最后一次可疑行为，供管理员接口查看"""
    info = _offenders.get(ip) or {"ip": ip, "auth_failures": 0, "login_failures": 0}
    info["last_seen"] = time.strftime("%Y-%m-%d %H:%M:%S")
    info["last_path"] = f"{request.method} {request.url.path}"
    info["last_ua"] = user_agent(request)
    info["last_referer"] = referer(request)
    info["last_kind"] = kind
    if code:
        info["last_code"] = code
    info["auth_failures" if kind == "auth" else "login_failures"] = \
        int(info.get("auth_failures" if kind == "auth" else "login_failures", 0)) + 1
    _offenders[ip] = info
    if len(_offenders) > _MAX_TRACKED_IPS:
        for old in sorted(_offenders, key=lambda k: _offenders[k].get("last_seen", ""))[:64]:
            _offenders.pop(old, None)


def record_auth_failure(request: Request, code: str) -> None:
    """鉴权失败计数（中间件/依赖给出的 401），超阈值则临时封禁该 IP"""
    if not _bool("ENABLE_IP_GUARD", True):
        return
    ip = client_ip(request)
    window_seconds = _num("AUTH_FAIL_WINDOW_SECONDS", 60)
    limit = int(_num("AUTH_FAIL_LIMIT", 30))
    ban_seconds = int(_num("AUTH_FAIL_BAN_SECONDS", 600))
    now = time.monotonic()

    with _LOCK:
        _note_offender(ip, request, "auth", code)
        window = _auth_fails[ip]
        window.append(now)
        _prune(window, window_seconds, now)
        count = len(window)
        if limit > 0 and ban_seconds > 0 and count >= limit and ip not in _banned:
            _banned[ip] = now + ban_seconds
            logger.warning(
                f"[安全] 临时封禁 IP {ip}：{int(window_seconds)} 秒内鉴权失败 {count} 次"
                f"（最近 code={code}，UA={user_agent(request, 60)}，路径={request.method} {request.url.path}），"
                f"封禁 {ban_seconds} 秒"
            )
        if len(_auth_fails) > _MAX_TRACKED_IPS:
            for old in list(_auth_fails.keys())[:64]:
                _auth_fails.pop(old, None)


def record_login_failure(request: Request, username: str) -> None:
    """登录失败审计（这条以前没有任何记录，被猜密码时完全看不见）"""
    ip = client_ip(request)
    window_seconds = _num("LOGIN_FAIL_WINDOW_SECONDS", 600)
    limit = int(_num("LOGIN_FAIL_LIMIT", 10))
    ban_seconds = int(_num("AUTH_FAIL_BAN_SECONDS", 600))
    now = time.monotonic()

    logger.warning(
        f"[安全] 登录失败 username={username!r} ip={ip} UA={user_agent(request)}"
    )
    if not _bool("ENABLE_IP_GUARD", True):
        return
    with _LOCK:
        _note_offender(ip, request, "login")
        window = _login_fails[ip]
        window.append(now)
        _prune(window, window_seconds, now)
        count = len(window)
        if limit > 0 and ban_seconds > 0 and count >= limit and ip not in _banned:
            _banned[ip] = now + ban_seconds
            logger.warning(
                f"[安全] 临时封禁 IP {ip}：{int(window_seconds)} 秒内登录失败 {count} 次"
                f"（疑似猜密码，最后 UA={user_agent(request, 60)}），封禁 {ban_seconds} 秒"
            )


def block_response(request: Request) -> Optional[JSONResponse]:
    """命中黑名单/封禁期 -> 直接返回响应（放在认证中间件最前面，公开接口也拒）"""
    ip = client_ip(request)

    deny = match_denylist(ip)
    if deny:
        logger.warning(f"[安全] 拒绝黑名单 IP {ip}（规则 {deny}）{request.method} {request.url.path}")
        return JSONResponse(
            status_code=403,
            content={"detail": "访问被拒绝：来源地址在黑名单中", "code": "ip_denied"},
        )

    if not _bool("ENABLE_IP_GUARD", True):
        return None
    now = time.monotonic()
    with _LOCK:
        until = _banned.get(ip, 0)
        if until and now < until:
            retry = int(until - now) + 1
            return JSONResponse(
                status_code=429,
                content={"detail": f"访问过于频繁，请 {retry} 秒后重试", "code": "ip_rate_banned"},
                headers={"Retry-After": str(retry)},
            )
        if until:
            _banned.pop(ip, None)
    return None


def unban(ip: str) -> bool:
    ip = normalize_ip(ip)
    with _LOCK:
        existed = _banned.pop(ip, None) is not None
        _auth_fails.pop(ip, None)
        _login_fails.pop(ip, None)
    return existed


def snapshot() -> dict[str, Any]:
    """管理员视角：现在封了谁、谁在失败、各自用的什么 UA"""
    now = time.monotonic()
    with _LOCK:
        banned = [
            {"ip": ip, "remaining_seconds": max(0, int(until - now))}
            for ip, until in _banned.items() if until > now
        ]
        offenders = sorted(
            (
                {**info,
                 "recent_auth_fails": len(_auth_fails.get(info["ip"], ())),
                 "recent_login_fails": len(_login_fails.get(info["ip"], ()))}
                for info in _offenders.values()
            ),
            key=lambda x: x.get("last_seen", ""),
            reverse=True,
        )[:30]
    return {
        "enabled": _bool("ENABLE_IP_GUARD", True),
        "trust_proxy_headers": _bool("TRUST_PROXY_HEADERS", False),
        "limits": {
            "auth_fail_window_seconds": _num("AUTH_FAIL_WINDOW_SECONDS", 60),
            "auth_fail_limit": _num("AUTH_FAIL_LIMIT", 30),
            "auth_fail_ban_seconds": _num("AUTH_FAIL_BAN_SECONDS", 600),
            "login_fail_window_seconds": _num("LOGIN_FAIL_WINDOW_SECONDS", 600),
            "login_fail_limit": _num("LOGIN_FAIL_LIMIT", 10),
        },
        "denylist": _deny_entries(),
        "banned": banned,
        "recent_offenders": offenders,
    }
