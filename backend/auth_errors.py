"""
401 统一出口

给每一种"未登录"打上机器可读的 code，前端据此区分处理（跳登录 / 提示原因 /
判断是被顶下线还是单纯过期），后端日志也能一眼看出是"没带凭证"还是"凭证过期"。

detail 仍然是中文字符串（大量页面直接把 detail 丢给 message.error），
code 作为平铺字段附加，老前端读不懂也不会炸。
"""
import time
from typing import Any, Optional

from fastapi import Request, status
from fastapi.responses import JSONResponse

# ── 凭证失败原因（与前端 utils/authCodes.ts 一一对应）──
AUTH_MISSING = "auth_missing"          # 请求里压根没有 token（未登录 / 未带上）
AUTH_EXPIRED = "token_expired"         # 签名有效，但 exp 已到
AUTH_INVALID = "token_invalid"         # 签名或格式不对（密钥换过、伪造、串了别站 token）
AUTH_STALE = "token_stale"             # 签名有效但 token_version 不符 —— 被同账号顶下线 / 已登出
AUTH_NO_ACCOUNT = "account_missing"    # token 里的账号已不存在
AUTH_LOGIN_BLOCKED = "login_blocked"   # 角色被"暂停登录"闸门挡住（升级维护），不是凭证问题

_MESSAGES = {
    AUTH_MISSING: "未登录，请先登录",
    AUTH_EXPIRED: "登录已过期，请重新登录",
    AUTH_INVALID: "登录凭证无效，请重新登录",
    # 措辞保留"在其他地方登录"这个旧短语：老版本前端(缓存里的旧 bundle)按这句话识别被顶号
    AUTH_STALE: "账号已在其他地方登录或已退出，请重新登录",
    AUTH_NO_ACCOUNT: "账号不存在或已被删除，请重新登录",
    AUTH_LOGIN_BLOCKED: "已暂停登录，请稍后再试",
}

#: 需要前端"停轮询 + 跳登录"的 401（区别于登录接口自身报的"密码错误"）
REAUTH_CODES = {AUTH_MISSING, AUTH_EXPIRED, AUTH_INVALID, AUTH_STALE, AUTH_NO_ACCOUNT, AUTH_LOGIN_BLOCKED}


#: 角色 -> (配置键, 提示文案 i18n 键)。管理员(0)不在此表内，永不被挡。
_LOGIN_GATE_BY_ROLE = {
    2: ("LOGIN_BLOCK_STUDENT", "messages.error.login_block_student"),
    1: ("LOGIN_BLOCK_TEACHER", "messages.error.login_block_teacher"),
}


#: 来源闸门：不分角色，学生/教师从外网进来都挡（管理员同样不受此项影响）。
LOGIN_BLOCK_EXTERNAL_KEY = "LOGIN_BLOCK_EXTERNAL"
LOGIN_BLOCK_EXTERNAL_MSG_KEY = "messages.error.login_block_external"


def _gate_flag(value: Any) -> bool:
    """容忍手改 JSON 时写成字符串 "true"/"1"；读不到配置一律按"允许"处理。"""
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)


def login_block_message_key(role: Any, ip: Optional[str] = None) -> Optional[str]:
    """这次请求是否被登录闸门挡住；命中则返回提示文案的 i18n 键，否则 None。

    两道闸门都只为学生/教师准备，管理员(role 0)任何一道都不受限制：
      · 角色闸门 LOGIN_BLOCK_STUDENT / LOGIN_BLOCK_TEACHER：按角色挡，不看来源；
      · 来源闸门 LOGIN_BLOCK_EXTERNAL：只挡外网地址，内网与本机照常。
    先判角色、再判来源——角色被暂停时说"某类账号暂停登录"更准确，
    来源闸门只在角色放行且这次确实从外网进来时才生效。
    ip 由调用方用 security_guard.client_ip(request) 取（真实 TCP 对端，
    客户端自己塞 X-Forwarded-For 不算数）；取不到一律按内网处理。

    登录接口与认证中间件共用这一份判定：前者挡新登录，后者挡已在途的会话，
    两处逻辑必须一致，所以只在这里写一次。配置异常时放行——
    宁可在读不到配置时放过，也不能因为一个坏配置把全校挡在门外。
    """
    from backend.api.config_router import get_config_value  # 局部导入，避开启动期循环依赖

    try:
        role_int = int(role)
    except (TypeError, ValueError):
        return None
    entry = _LOGIN_GATE_BY_ROLE.get(role_int)
    if not entry:
        return None
    cfg_key, msg_key = entry
    try:
        if _gate_flag(get_config_value(cfg_key, False)):
            return msg_key
        if _gate_flag(get_config_value(LOGIN_BLOCK_EXTERNAL_KEY, False)):
            from backend.security_guard import is_external_ip  # 局部导入，避开启动期循环依赖
            if is_external_ip(ip or ""):
                return LOGIN_BLOCK_EXTERNAL_MSG_KEY
    except Exception:
        return None
    return None


def auth_message(code: str) -> str:
    """原因码 -> 给用户看的中文提示"""
    return _MESSAGES.get(code, "登录状态异常，请重新登录")


class AuthError(Exception):
    """认证类 401：带原因码，由 main.py 注册的全局 handler 转成 JSON。"""

    status_code = status.HTTP_401_UNAUTHORIZED

    def __init__(self, code: str = AUTH_MISSING, message: Optional[str] = None):
        self.code = code or AUTH_MISSING
        self.message = message or auth_message(self.code)
        super().__init__(self.message)


def auth_error_body(code: str, message: Optional[str] = None) -> dict[str, Any]:
    """统一的 401 响应体：detail 给人看，code 给程序看。"""
    return {"detail": message or auth_message(code), "code": code}


def auth_error_response(code: str, message: Optional[str] = None) -> JSONResponse:
    """中间件里直接 return 用（中间件不走异常 handler）。"""
    return JSONResponse(
        status_code=status.HTTP_401_UNAUTHORIZED,
        content=auth_error_body(code, message),
        headers={"WWW-Authenticate": "Bearer"},
    )


# ── 401 拒绝日志（限流：同一 原因+方法+路径 每分钟一条，避免挂机页面刷屏）──

_REJECT_LOG_INTERVAL = 60.0
_reject_logged: dict[str, float] = {}


def log_auth_reject(request: Request, code: str, where: str = "middleware") -> None:
    """记一条可排查的 401：原因码 + 来源 IP + UA + 来源页（access log 里没有 UA）。

    同时把这次失败喂给 security_guard 做"同 IP 连续失败 -> 临时封禁"的计数。
    """
    from backend.logger import logger   # 局部导入，避开 logger<->config 的启动顺序问题
    from backend.security_guard import (
        client_ip,
        record_auth_failure,
        referer,
        user_agent,
    )

    record_auth_failure(request, code)

    key = f"{code}|{where}|{request.method} {request.url.path}"
    now = time.monotonic()
    if now - _reject_logged.get(key, 0.0) < _REJECT_LOG_INTERVAL:
        return
    _reject_logged[key] = now
    if len(_reject_logged) > 256:
        _reject_logged.clear()
    logger.warning(
        f"[401] {request.method} {request.url.path} code={code} "
        f"ip={client_ip(request)} from={where} ua={user_agent(request, 80)} ref={referer(request)}"
    )
