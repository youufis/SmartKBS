"""
统一日志配置
- _SmartLogger: except 块内调用 logger.error 自动附带堆栈(exc_info), 全局免逐处改造
- SizeRotatingHandler: 延迟打开 + 轮转方式/保留量按配置(LOG_ROTATION_MODE/LOG_KEEP_DAYS/LOG_KEEP_COUNT, 默认 size+5 份与历史一致); size=满 5MB 切档, day=跨天后首条日志时切档(归档按日期命名), both=两者取先到; rename 轮转归档(.gz) + 被多实例锁住时退避重试并告警(绝不复制) + 每 32 条顺带重读配置(保存即热生效)
- 级别策略: logger=DEBUG, 控制台=INFO(现场不刷屏), 文件=DEBUG(排障可查)
- uvicorn.access/uvicorn.error: 恢复 INFO(可见 4xx/5xx) + 内置噪音路径过滤器(统一配置, main.py 不再重复)
- 两条 uvicorn 日志: URL 里的 token= 一律打码(_AccessTokenRedactFilter), 超长 query 截断,
  不让 JWT 明文和整份板书 JSON 进日志(WS 握手行出自 uvicorn.error, 以前只过滤了 access)
- uvicorn.access/uvicorn.error: 反复撞开的 WebSocket 握手按"路径+结果"限流(_WsHandshakeNoiseFilter)
"""
import json
import logging
import os
import re
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

from backend.config import LOG_FILES_DIR, STORAGE_DIR, LOG_ROTATION_DEFAULTS

_LOG_MAX_BYTES = 5 * 1024 * 1024   # 5 MB
_LOG_BACKUP_COUNT = 5
_CHECK_EVERY_N = 32                 # 每 N 条检查一次大小, 降低 stat 频率
_ROTATION_DEFAULTS = LOG_ROTATION_DEFAULTS   # 出厂口径单一来源在 backend/config.py，config_router.DEFAULT_CONFIG 同源引用

# ── 轮转/保留配置读取（2026-11-19 按天轮转改造）──
# 不走 config_router.get_config_value：backend.logger 在启动最早期被全站模块 import，
# 而 config_router 反过来 import backend.logger —— 那时它还没加载完，会形成循环。
# 这里对 system_config.json 做只读旁路：按 (mtime,size) 缓存整份 JSON，
# 解析失败一律按出厂默认，绝不让日志模块因配置异常而哑掉。
_raw_cfg_key: tuple = ()
_raw_cfg_data: dict = {}
_raw_cfg_lock = threading.Lock()


def _raw_system_config() -> dict:
    global _raw_cfg_key, _raw_cfg_data
    path = STORAGE_DIR / "system_config.json"
    try:
        st = path.stat()
        key = (st.st_mtime_ns, st.st_size)
        with _raw_cfg_lock:
            if _raw_cfg_key == key:
                return _raw_cfg_data
            data = json.loads(path.read_text(encoding="utf-8-sig"))
            if not isinstance(data, dict):
                data = {}
            _raw_cfg_key, _raw_cfg_data = key, data
            return data
    except Exception:
        return {}


def _rotation_settings() -> tuple[str, int, int]:
    """(mode, keep_days, keep_count)；非法值/缺键一律回落出厂默认"""
    cfg = _raw_system_config()
    mode = str(cfg.get("LOG_ROTATION_MODE", _ROTATION_DEFAULTS["LOG_ROTATION_MODE"]) or "size").strip().lower()
    if mode not in ("size", "day", "both"):
        mode = "size"

    def _num(key: str, default: int, lo: int, hi: int) -> int:
        try:
            v = int(float(cfg.get(key, default)))
        except (TypeError, ValueError):
            return default
        return min(hi, max(lo, v))

    return (mode,
            _num("LOG_KEEP_DAYS", _ROTATION_DEFAULTS["LOG_KEEP_DAYS"], 0, 365),
            _num("LOG_KEEP_COUNT", _ROTATION_DEFAULTS["LOG_KEEP_COUNT"], 1, 200))

# 高频噪音路径(健康检查/心跳/静态资源), 访问日志中过滤掉
_ACCESS_NOISE = (
    "/api/config-sync/",
    "/api/downloads/ping",
    "/api/scores/ping",
    "/uploads/",
    "/assets/",
    "/api/notifications/unread",
    "GET / ",
)

# 前端定时轮询的接口(未读通知/学伴推送/进行中任务/在线人数) —— 这些路径上的 401
# 属于"挂机页面 token 失效"的已知噪音，由 _PollAuthNoiseFilter 限流汇总
_POLL_401_NOISE = (
    "/api/notifications",
    "/api/companion/push",
    "/api/tasks/active",
    "/api/auth/online-count",
    # 白板只读端兜底轮询（/api/whiteboard/rooms/{id}/snapshot）：WS 不通时 3 秒一轮，
    # 挂机页面 token 一旦失效就是一片 401 海。前端已改成"401 即停表 + 跳登录"，
    # 这里再叠一层：缓存着旧 bundle 的浏览器不至于把 access log 刷满
    #（每 60 秒仍汇总一条带样例的 WARN，线索不丢）。全站只有这一个路由带 snapshot。
    "/snapshot",
)


#: 访问日志里必须打码的参数：token 类是凭据；sig/snapshot/document 会把整份板书
#: JSON 抄进 URL（一条 600+ 字符，连"抑制 N 条"的汇总样例都成了新的刷屏源）。
_SECRET_PARAMS = (
    "token", "access_token", "id_token", "refresh_token", "api_key", "apikey",
    "password", "secret", "sig", "signature", "snapshot", "document",
)
_MAX_URL_LOG_CHARS = 300      # 带 query string 的单行日志上限，超出部分折成计数
_MAX_SAMPLE_CHARS = 160       # 汇总告警里样例的长度上限

_PARAM_RE = re.compile(
    r"([?&])(" + "|".join(_SECRET_PARAMS) + r")=([^&\s\x22\x27]+)",
    re.IGNORECASE,
)


def redact_log_text(text: str) -> str:
    """打码凭据/超长参数 + 截断带 query 的超长行；其余(方法/路径/状态码)原样保留。

    WebSocket 握手只能靠 URL 或 Cookie 带令牌(白板/讨论区/抢答都用过 ?token=)，
    uvicorn 的访问日志连 query string 一起打印，于是每连一次就往日志里抄一份可用的
    JWT —— 而日志的可见范围远大于令牌本该到的地方。
    """
    out = _PARAM_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}=***", text)
    if "?" in out and len(out) > _MAX_URL_LOG_CHARS:
        cut = out[:_MAX_URL_LOG_CHARS]
        out = f"{cut}…(截断 {len(out) - _MAX_URL_LOG_CHARS} 字符)"
    return out


class _AccessTokenRedactFilter(logging.Filter):
    """访问/协议日志的打码过滤器（uvicorn.access 与 uvicorn.error 共用）。

    注意 uvicorn 的两类记录都是"模板 + args"发出来的：
      · uvicorn.access 的 AccessFormatter 会把 record.args 解包成
        (client_addr, method, full_path, http_version, status_code)；
      · uvicorn.error 的握手行同理。
    所以有 args 时必须逐个参数打码、模板不动 —— 早先只改 record.msg 再清空 args，
    解包直接抛错，一条越权的 GET 能换来一整屏 "--- Logging error ---" 堆栈。
    """

    def filter(self, record):
        try:
            msg = record.getMessage()
        except Exception:
            return True
        if "?" not in msg:
            return True
        lowered = msg.lower()
        # 快路径：没有敏感参数名、长度也正常的行直接放行（访问日志每请求一条，别做无用功）
        if len(msg) <= _MAX_URL_LOG_CHARS and not any(k in lowered for k in _SECRET_PARAMS):
            return True
        redacted = redact_log_text(msg)
        if redacted == msg:
            return True
        args = record.args
        if isinstance(args, tuple) and args:
            record.args = tuple(
                redact_log_text(a) if isinstance(a, str) else a for a in args
            )
        elif isinstance(args, dict) and args:
            record.args = {
                k: redact_log_text(v) if isinstance(v, str) else v
                for k, v in args.items()
            }
        else:
            record.msg = redacted
            record.args = None
        return True


class _SmartLogger(logging.Logger):
    """error 级日志在异常处理上下文中自动附加堆栈"""
    def error(self, msg, *args, **kwargs):  # type: ignore[override]
        if "exc_info" not in kwargs and sys.exc_info()[0] is not None:
            kwargs["exc_info"] = True
        return super().error(msg, *args, **kwargs)


class _AccessNoiseFilter(logging.Filter):
    """过滤 uvicorn.access 中的心跳/静态资源噪音, 保留其余(含 4xx/5xx)"""
    def filter(self, record):
        try:
            msg = record.getMessage()
        except Exception:
            return True
        return not any(n in msg for n in _ACCESS_NOISE)


class RepeatThrottle:
    """同一件事再说一遍也没意义的记录节流：满速几条，然后指数退避到上限。

    挂机页面/缓存里的旧 bundle 会没完没了地重复同一个失败（轮询接口 401、
    WebSocket 握手被拒、访问日志噪音汇总）。这类记录第一条有价值，之后每分钟
    一条就是把排障信息埋进噪音里。策略：

      * 第 1 条立刻放行；
      * 前 full_speed_repeats 条按 base_seconds（默认 60 秒）放行，够看清问题；
      * 之后间隔翻倍，封顶 cap_seconds（默认 15 分钟）—— 问题还在，人不会漏看；
      * 某个键静默超过 cap_seconds，说明是新一轮问题，重新按满速记录。
    """

    def __init__(self, base_seconds: float = 60.0, cap_seconds: float = 900.0,
                 full_speed_repeats: int = 3):
        self.base = float(base_seconds)
        self.cap = float(cap_seconds)
        self.full = max(1, int(full_speed_repeats))
        self._state: dict[str, tuple[float, int]] = {}   # 键 -> (上次放行时间, 已放行条数)

    def _gap(self, repeats: int) -> float:
        if repeats < self.full:
            return self.base
        return min(self.cap, self.base * (2 ** (repeats - self.full + 1)))

    def allow(self, key: str, now: float | None = None) -> bool:
        if now is None:
            now = time.monotonic()
        last, repeats = self._state.get(key, (0.0, 0))
        if now - last > self.cap:          # 静默已久：新一轮，回到满速
            repeats = 0
        if last and now - last < self._gap(repeats):
            return False
        self._state[key] = (now, repeats + 1)
        if len(self._state) > 512:
            cutoff = now - self.cap
            for stale in [k for k, (ts, _) in self._state.items() if ts < cutoff]:
                self._state.pop(stale, None)
            if len(self._state) > 512:
                self._state.clear()
        return True


class _PollAuthNoiseFilter(logging.Filter):
    """压掉"前端轮询接口 + 401"这类已知访问日志噪音，改为限流汇总告警。

    背景：通知未读 / 学伴推送未读 / 进行中任务这类轮询每 30s 一轮，页面挂机 +
    token 失效时会把 access log 刷成 401 海。真问题时这些行反而淹没有用信息，
    所以：单条丢弃，但每 60 秒输出一条"抑制了 N 条 + 样例"的 WARN，不丢线索。
    只针对 401；轮询接口的 200/5xx、其它接口的 401 全部照常输出。
    """

    SUMMARY_INTERVAL = 60.0

    #: uvicorn(0.4x) 的 raw message 形如 `addr - "GET /x HTTP/1.1" 401` ——
    #  状态码在结尾、后面**没有**空格。这里以前写的是 `" 401 " in msg`，
    #  于是这条过滤器从上线起就没命中过一次（日志里从来没见过"抑制 N 条"的汇总）。
    #  改成按结尾匹配，顺带把状态码位置锁死在引号收尾之后，不会误伤路径里的数字。
    _STATUS_401 = re.compile(r'"\s+401\s*$')

    def __init__(self, name: str = "", throttle: RepeatThrottle | None = None):
        super().__init__(name)
        self._suppressed = 0
        self._sample = ""
        self._sample_key = ""
        self._last_group = ""
        # 同一个样例会连着刷屏：满速 3 轮(每分钟一条)后退避到最长 15 分钟一条
        self._throttle = throttle or RepeatThrottle(self.SUMMARY_INTERVAL)

    def filter(self, record):
        try:
            msg = record.getMessage()
        except Exception:
            return True
        if not (self._STATUS_401.search(msg)
                and any(path in msg for path in _POLL_401_NOISE)):
            return True

        self._suppressed += 1
        if not self._sample:
            # 样例只留一句能定位的长度：白板兜底轮询的 ?sig= 是整份板书 JSON 的
            # 前 200 字符，URL 编码后 600+ 字符，汇总告警本身反倒成了刷屏主力
            self._sample = redact_log_text(msg.strip())[:_MAX_SAMPLE_CHARS]
            # 归组键只取"命中的轮询路径 + 方法"。绝不能用整行或含 client:port 的片段：
            # 每次请求的临时端口都在变，键随之变，限流等于没限 —— 2026-10-21 就是
            # 这么把"每分钟一条汇总"刷成"每 5 秒一条汇总"的。
            self._sample_key = next((path for path in _POLL_401_NOISE if path in msg), "poll")
        now = time.monotonic()
        if self._throttle.allow("poll401|" + self._sample_key, now):
            count, sample = self._suppressed, self._sample
            self._last_group = self._sample_key or "poll"
            self._suppressed, self._sample, self._sample_key = 0, "", ""
            try:
                logging.getLogger("smartkb").warning(
                    f"[access] 抑制 {count} 条轮询接口 401 访问日志"
                    f"（{self._last_group}：重复的只汇总一条，越持续越稀疏），样例: {sample}"
                )
            except Exception:
                pass
        return False


class _WsHandshakeNoiseFilter(logging.Filter):
    """把"同一个客户端反复撞 WebSocket 握手"的三连行压成每分钟一条。

    现场（2026-10-21）：挂机页面的提问 WS 带着已失效的令牌（token_version 已被
    登录流程递增）每 5 秒重连一次，而该端点在 accept 之前 close()，uvicorn 只会
    把它当成 HTTP 403 拒绝，浏览器拿到的是没有原因的 1006，"未认证就别重连"的
    判断永远不触发。每次尝试 uvicorn.error 打三行：

        171.34.210.119:22494 - "WebSocket /api/interaction/questions/ws?token=***" 403
        connection rejected (403 Forbidden)
        connection closed

    一分钟 36 行同义反复，真正的 4xx/5xx 与堆栈全被埋掉。令牌失效这件事后端在
    拒绝时已经记了一行可排查的 WARN（见 backend/ws_reject.py），这三行纯属重复，
    所以按"路径+结果"限流：每类 60 秒放行一条，其余计数，每分钟汇总一次。
    只针对握手行 —— 白板/抢答正常的 accepted 连接同样只留一条样例，
    业务层日志（谁进了哪个房间）不受影响。
    """

    WINDOW_SECONDS = 60.0

    _HANDSHAKE = re.compile(r'"WebSocket (?P<path>[^"\s]+)" (?P<result>\[accepted\]|\d{3})')

    def __init__(self, name: str = "", throttle: RepeatThrottle | None = None):
        super().__init__(name)
        self._passed: dict[str, float] = {}
        self._suppressed = 0
        self._sample = ""
        self._summary_key = ""
        # 放行窗口固定 60 秒(总得让人看见问题还在)，汇总行按退避节奏出
        self._throttle = throttle or RepeatThrottle(self.WINDOW_SECONDS)

    def filter(self, record):
        try:
            msg = record.getMessage()
        except Exception:
            return True
        key = self._noise_key(msg)
        if key is None:
            return True

        now = time.monotonic()
        if now - self._passed.get(key, 0.0) >= self.WINDOW_SECONDS:
            self._passed[key] = now
            if len(self._passed) > 128:      # 防长期运行堆积（路径数量本该有限）
                cutoff = now - self.WINDOW_SECONDS
                for seen_key in [k for k, ts in self._passed.items() if ts < cutoff]:
                    self._passed.pop(seen_key, None)
            return True

        self._suppressed += 1
        if not self._sample:
            self._sample = redact_log_text(msg.strip())[:_MAX_SAMPLE_CHARS]
            self._summary_key = key
        if self._throttle.allow("wsnoise|" + self._summary_key, now):
            count, sample = self._suppressed, self._sample
            self._suppressed, self._sample = 0, ""
            try:
                logging.getLogger("smartkb").warning(
                    f"[access] 近 60 秒内抑制 {count} 条 WebSocket 握手日志"
                    f"（已按路径+结果去重），样例: {sample}"
                )
            except Exception:
                pass
        return False

    @classmethod
    def _noise_key(cls, msg: str) -> str | None:
        """这类记录归到哪个去重键；不是握手噪音返回 None（照常输出）"""
        hit = cls._HANDSHAKE.search(msg)
        if hit:
            path = hit.group("path").split("?", 1)[0]
            return f"ws|{path}|{hit.group('result')}"
        stripped = msg.strip()
        # "connection rejected (...)" / "connection closed" 不带任何上下文：
        # 前者是 403 的复述，后者每条连接（含正常断开）都打，留着只会稀释日志。
        # "connection handler failed" 是带堆栈的异常，绝不属于噪音。
        if stripped.startswith("connection rejected (") or stripped == "connection closed":
            return "ws|handshake-tail"
        return None





class _AsyncioTeardownNoiseFilter(logging.Filter):
    """压掉 Windows proactor 拆连接时的固有噪声，其它 asyncio 错误一律照打。

    现场（2026-11-15 部署机日志）：客户端把连接掐断（关标签页、断网、扫描器握手
    即走）之后，_ProactorBasePipeTransport._call_connection_lost 仍对已断开的
    socket 调 shutdown()，抛 OSError[WinError 10057]，事件循环默认异常处理器把
    整段 traceback 以 ERROR 打出来：

        Exception in callback _ProactorBasePipeTransport._call_connection_lost(None)
        handle: <Handle _ProactorBasePipeTransport._call_connection_lost(None)>
        Traceback (most recent call last): ... OSError: [WinError 10057] ...

    它发生在连接拆除的瞬间，不影响该请求已经返回的结果，也不影响任何业务；但每次
    掉线刷十几行，真错误会被埋掉。过滤要同时满足两条：命中拆除符号，且确认异常就
    是那几个套接字错误码。判不准（没有 exc_info 的变体、别的回调恰好提到同一个符
    号）一律放行 - 宁可漏滤，不可误吞。
    """

    WINDOW_SECONDS = 60.0
    _TEARDOWN = re.compile(r"_call_connection_lost|_ProactorBasePipeTransport")
    _SOCKET_CODES = (10053, 10054, 10057)   # 已断开 / 连接重置 / 未连接

    def __init__(self, name: str = "", throttle: RepeatThrottle | None = None):
        super().__init__(name)
        self._passed: dict[str, float] = {}
        self._suppressed: dict[str, int] = {}     # 按错误形态分桶，汇总别把账记错
        self._samples: dict[str, str] = {}
        self._throttle = throttle or RepeatThrottle(self.WINDOW_SECONDS)

    def filter(self, record):
        try:
            msg = record.getMessage()
        except Exception:
            return True
        if not self._TEARDOWN.search(msg):
            return True
        kind = self._noise_kind(record)
        if kind is None:
            return True
        now = time.monotonic()
        key = "asyncio-teardown|" + kind
        if now - self._passed.get(key, 0.0) >= self.WINDOW_SECONDS:
            self._passed[key] = now
            if len(self._passed) > 32:
                cutoff = now - self.WINDOW_SECONDS
                for stale in [k for k, ts in self._passed.items() if ts < cutoff]:
                    self._passed.pop(stale, None)
            return True

        self._suppressed[kind] = self._suppressed.get(kind, 0) + 1
        self._samples.setdefault(kind, redact_log_text(msg.strip().splitlines()[0])[:_MAX_SAMPLE_CHARS])
        if self._throttle.allow(key, now):
            count, sample = self._suppressed.pop(kind, 0), self._samples.pop(kind, "")
            try:
                logging.getLogger("smartkb").warning(
                    f"[access] 近 60 秒内抑制 {count} 条 asyncio 拆连接噪声"
                    f"（{kind}，连接已断后 shutdown 的固有报错），样例: {sample}"
                )
            except Exception:
                pass
        return False

    @classmethod
    def _noise_kind(cls, record) -> str | None:
        """确认这条记录就是已知的套接字拆除错误；判不准返回 None（照常输出）"""
        exc = record.exc_info[1] if record.exc_info and len(record.exc_info) > 1 else None
        if isinstance(exc, OSError):
            if exc.winerror in cls._SOCKET_CODES:
                return "WinError %d" % int(exc.winerror)
            if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
                return type(exc).__name__
        if record.exc_info:
            try:
                text = logging.Formatter().formatException(record.exc_info)
            except Exception:
                return None
            for code in cls._SOCKET_CODES:
                if "WinError %d" % code in text:
                    return "WinError %d" % code
        return None

class SizeRotatingHandler(logging.FileHandler):
    """按大小轮转的日志处理器, 归档名带时间戳, 保留最近 N 份

    多实例安全: 轮转只做 os.rename, 成功才截断新档; 其他进程持有句柄时 rename 直接失败
    (WinError 32), 此时退避重试并一次性告警。旧版 shutil.move 在 Windows 锁文件时会退化为
    "整体复制+删不掉原件", 曾把同一份日志复制出 5 个假归档而主文件永不截断(2026-10 事故)。

    兜底: 连续 2 次被锁轮转失败后, 本进程自动"迁出"到 backend.<pid>.log 独立滚动,
    保证任何共写环境下 5MB 自动重开都成立; 遗留文件由 log_retention 每日回收。
    """

    _ROTATE_BACKOFF = 300.0  # rename 失败后的重试间隔(秒)

    def __init__(self, filename, maxBytes=None, backupCount=None, encoding="utf-8"):
        mode, keep_days, keep_count = _rotation_settings()
        self.rotation_mode = mode   # 不能叫 self.mode：那是 FileHandler 的打开模式(a/w)，_open() 会用；取值 size/day/both
        self.keep_days = keep_days
        self.maxBytes = maxBytes or _LOG_MAX_BYTES
        self.backupCount = backupCount or keep_count
        self._emit_n = 0
        self._rotate_warned = False
        self._next_rotate_at = 0.0
        self._rotate_fail_streak = 0
        self._cur_date = None                 # 当前文件归属日期（跨天轮转用，延迟自 mtime 初始化）
        self._pending_archive_date = None     # 本轮要归档到哪天（轮转失败时保留，重试仍归那天）
        super().__init__(filename, encoding=encoding, delay=True)

    def emit(self, record):
        try:
            self._emit_n += 1
            if self.stream is not None and time.monotonic() >= self._next_rotate_at:
                if self._emit_n % _CHECK_EVERY_N == 0:
                    self._refresh_settings()   # 配置改了最迟 32 条内自动跟上（热应用钩子只是抢先一步）
                if self._should_rotate_by_date():
                    self.do_rollover()
                elif self.rotation_mode != "day" and self._emit_n % _CHECK_EVERY_N == 0:
                    try:
                        if os.path.getsize(self.baseFilename) >= self.maxBytes:
                            self.do_rollover()
                    except OSError:
                        pass
        except Exception:
            pass
        super().emit(record)

    def _refresh_settings(self):
        self.rotation_mode, self.keep_days, self.backupCount = _rotation_settings()

    def _file_date(self):
        """当前文件归属哪天：读 mtime；读不到按今天（新文件）"""
        try:
            return datetime.fromtimestamp(os.path.getmtime(self.baseFilename)).date()
        except OSError:
            return datetime.now().date()

    def _should_rotate_by_date(self) -> bool:
        if self.rotation_mode not in ("day", "both"):
            return False
        if self._cur_date is None:
            self._cur_date = self._file_date()
            return False
        today = datetime.now().date()
        if today > self._cur_date:
            # 归档归到文件自己所属的那天：低流量系统隔几天才写日志时，陈旧内容不该顶着今天的日期
            self._pending_archive_date = self._cur_date
            return True
        return False

    def do_rollover(self):
        """rename 轮转: 只认原子改名; 被其他活句柄锁住时原地续写、退避重试, 绝不复制"""
        self.close()
        if self.rotation_mode in ("day", "both"):
            d = self._pending_archive_date or self._file_date()
            archive = f"{self.baseFilename}.{d.strftime('%Y%m%d')}"
            if os.path.exists(archive) or os.path.exists(archive + ".gz"):
                # 同一天第二次切档（both 模式 5MB 保险丝触发）：加时分秒防撞名，仍撞再加序号
                base_archive = archive
                for i in range(50):
                    suffix = datetime.now().strftime("%H%M%S") + (f"-{i}" if i else "")
                    archive = f"{base_archive}-{suffix}"
                    if not (os.path.exists(archive) or os.path.exists(archive + ".gz")):
                        break
        else:
            archive = f"{self.baseFilename}.{datetime.now().strftime('%Y%m%d-%H%M%S')}"
        rotated = False
        try:
            os.rename(self.baseFilename, archive)
            rotated = True
        except OSError as e:
            self._next_rotate_at = time.monotonic() + self._ROTATE_BACKOFF
            self._rotate_fail_streak += 1
            if not self._rotate_warned:
                self._rotate_warned = True
                print(
                    f"[logger] backend.log 轮转失败(疑似多实例共写持有句柄, WinError 32): {e}; "
                    f"退避 {int(self._ROTATE_BACKOFF)}s 后重试, 期间日志继续写原文件。"
                    "请确认是否存在双实例(见 LogFiles/backend-instance.pid 与启动日志[实例守卫])",
                    file=sys.stderr,
                )
        if rotated:
            self._rotate_warned = False
            self._next_rotate_at = 0.0
            self._rotate_fail_streak = 0
            self._cur_date = datetime.now().date()
            self._pending_archive_date = None
            self._compress_archive(archive)
            self._prune_archives()
        try:
            self.stream = open(self.baseFilename, "a", encoding=self.encoding)
        except Exception as e:
            if not self._rotate_warned:
                self._rotate_warned = True
                print(f"[logger] 日志重开文件失败(已降级为仅控制台): {e}", file=sys.stderr)
        if (not rotated and self._rotate_fail_streak >= 2
                and os.path.basename(self.baseFilename) == "backend.log"):
            self._move_out()

    def _move_out(self):
        """共享 backend.log 被其他实例长期锁死 -> 迁出为进程私有日志, 保住自身 5MB 自动轮转"""
        new_name = "backend.%d.log" % os.getpid()
        new_path = os.path.join(os.path.dirname(self.baseFilename), new_name)
        try:
            if self.stream is not None:                     # 关旧流(3.11 FileHandler 无 setBaseFilename, 手动切换)
                try:
                    self.stream.close()
                except OSError:
                    pass
                self.stream = None
            self.baseFilename = new_path
            self._cur_date = None      # 新文件重新认日子
            self._pending_archive_date = None   # 旧文件的归档日期作废：不清的话，迁出后首次轮转若由大小保险丝
                                                # 触发（不走跨天判定），新文件会被冠上迁出前残留的旧日期（2026-11-19 审查修复）
            self.stream = open(self.baseFilename, "a", encoding=self.encoding)
            self._rotate_fail_streak = 0
            self._next_rotate_at = 0.0
            self._rotate_fail_streak = 0
            print(f"[logger] backend.log 被其他实例锁死, 本进程日志已迁出 -> {new_name}; "
                  "迁出后轮转恢复正常, 遗留文件由保留任务定期回收", file=sys.stderr)
            return True
        except Exception as e:
            print(f"[logger] 日志迁出失败: {e}", file=sys.stderr)
            return False

    def _compress_archive(self, archive):
        """尽力把归档压成 .gz; 失败保留原始文件(超额清理两种都计数)"""
        try:
            import gzip
            import shutil
            gz = archive + ".gz"
            with open(archive, "rb") as src, gzip.open(gz, "wb") as dst:
                shutil.copyfileobj(src, dst)
            os.remove(archive)
        except Exception:
            pass

    def _prune_archives(self):
        """按配置清理归档(含 .gz)，两条规则：
        - 份数封顶：任何模式都生效；day/both 下自动抬高到不低于保留天数（防"配 14 天却只留 5 份"）；
        - 按天过期：仅 day/both 且 keep_days>0 时生效——size 模式维持纯份数口径，与历史零差异。
        """
        try:
            d = os.path.dirname(self.baseFilename) or "."
            base = os.path.basename(self.baseFilename)
            entries = []
            for f in os.listdir(d):
                if not f.startswith(base + "."):
                    continue
                try:
                    entries.append((os.path.getmtime(os.path.join(d, f)), f))
                except OSError:
                    continue
            entries.sort(reverse=True)
            cap = self.backupCount if self.rotation_mode == "size" else max(self.backupCount, self.keep_days or 0)
            cutoff = (time.time() - self.keep_days * 86400
                      if (self.rotation_mode in ("day", "both") and self.keep_days > 0) else None)
            for i, (mt, f) in enumerate(entries):
                if i >= cap or (cutoff is not None and mt < cutoff):
                    try:
                        os.remove(os.path.join(d, f))
                    except OSError:
                        pass
        except Exception:
            pass


def setup_logger(name: str = "smartkb") -> logging.Logger:
    """配置并返回单例 logger"""
    logger = logging.getLogger(name)
    logger.setLevel(logging.DEBUG)

    if logger.handlers:
        return logger

    # 控制台 handler: INFO 及以上
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(logging.INFO)
    console_handler.setFormatter(logging.Formatter(
        "[%(asctime)s] %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    ))
    logger.addHandler(console_handler)

    # 文件 handler: DEBUG 起, 轮转/保留按 LOG_ROTATION_MODE / LOG_KEEP_DAYS / LOG_KEEP_COUNT（默认 size+5 份=历史行为）
    try:
        log_dir = Path(LOG_FILES_DIR)
        log_dir.mkdir(parents=True, exist_ok=True)
        file_handler = SizeRotatingHandler(log_dir / "backend.log")
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(logging.Formatter(
            "[%(asctime)s] %(levelname)s [%(filename)s:%(lineno)d] - %(message)s"
        ))
        logger.addHandler(file_handler)
    except Exception as e:
        logger.warning(f"无法配置日志文件: {e}")

    return logger


# 必须在首次 getLogger 之前注册, 使 error() 自动带堆栈
logging.setLoggerClass(_SmartLogger)

# 全局默认 logger
logger = setup_logger()


def rotation_settings_snapshot() -> dict:
    """当前生效的轮转/保留口径（log_retention 的家族硬顶与配置页响应共用）"""
    mode, keep_days, keep_count = _rotation_settings()
    return {"mode": mode, "keep_days": keep_days, "keep_count": keep_count}


def apply_log_rotation() -> dict:
    """配置保存后的热应用钩子：立刻刷新在跑的 handler；没赶上也没关系，emit 每 32 条会自查重读。"""
    mode, keep_days, keep_count = _rotation_settings()
    updated = 0
    for h in logging.getLogger("smartkb").handlers:
        if isinstance(h, SizeRotatingHandler):
            h.rotation_mode, h.keep_days, h.backupCount = mode, keep_days, keep_count
            updated += 1
    return {"mode": mode, "keep_days": keep_days, "keep_count": keep_count, "handlers": updated}

# uvicorn 日志去噪/脱敏: HTTP 访问日志(uvicorn.access) + WebSocket 握手与协议行
# (uvicorn.error —— websockets 实现把 logger 直接绑在它上面, 握手行里的 ?token=
#  以前没人打码, JWT 明文就这么一遍遍打进终端)
uvicorn_access = logging.getLogger("uvicorn.access")
uvicorn_access.setLevel(logging.INFO)
uvicorn_error = logging.getLogger("uvicorn.error")
uvicorn_error.setLevel(logging.INFO)

# 顺序要紧：先打码再判重，_WsHandshakeNoiseFilter 留下的样例才是脱敏后的
for _uvicorn_logger in (uvicorn_access, uvicorn_error):
    if not any(isinstance(f, _AccessTokenRedactFilter) for f in _uvicorn_logger.filters):
        _uvicorn_logger.addFilter(_AccessTokenRedactFilter())
    if not any(isinstance(f, _WsHandshakeNoiseFilter) for f in _uvicorn_logger.filters):
        _uvicorn_logger.addFilter(_WsHandshakeNoiseFilter())

if not any(isinstance(f, _AccessNoiseFilter) for f in uvicorn_access.filters):
    uvicorn_access.addFilter(_AccessNoiseFilter())
if not any(isinstance(f, _PollAuthNoiseFilter) for f in uvicorn_access.filters):
    uvicorn_access.addFilter(_PollAuthNoiseFilter())


# asyncio 的默认异常处理器走的是 "asyncio" 这个 logger（uvicorn 不接管它，记录直接
# 落到 lastResort/终端），Windows proactor 拆连接的固有报错就从这里出来。
_asyncio_logger = logging.getLogger("asyncio")
if not any(isinstance(f, _AsyncioTeardownNoiseFilter) for f in _asyncio_logger.filters):
    _asyncio_logger.addFilter(_AsyncioTeardownNoiseFilter())
