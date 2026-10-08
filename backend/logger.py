"""
统一日志配置
- _SmartLogger: except 块内调用 logger.error 自动附带堆栈(exc_info), 全局免逐处改造
- SizeRotatingHandler: 延迟打开 + 每 32 条抽样查大小 + rename 轮转归档(.gz)保留 5 份 + 被多实例锁住时退避重试并告警(绝不复制)
- 级别策略: logger=DEBUG, 控制台=INFO(现场不刷屏), 文件=DEBUG(排障可查)
- uvicorn.access: 恢复 INFO(可见 4xx/5xx) + 内置噪音路径过滤器(统一配置, main.py 不再重复)
- uvicorn.access: URL 里的 token= 一律打码(_AccessTokenRedactFilter), 不让 JWT 明文进日志文件
"""
import logging
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

from backend.config import LOG_FILES_DIR

_LOG_MAX_BYTES = 5 * 1024 * 1024   # 5 MB
_LOG_BACKUP_COUNT = 5
_CHECK_EVERY_N = 32                 # 每 N 条检查一次大小, 降低 stat 频率

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
)


class _AccessTokenRedactFilter(logging.Filter):
    """把访问日志 URL 中的 token= 值替换成 ***，其余(路径/状态码)原样保留。

    WebSocket 握手只能靠 URL 或 Cookie 带令牌(白板/讨论区/抢答都用过 ?token=)，
    uvicorn 的 access log 连 query string 一起打印，于是每连一次就往日志文件里
    抄一份可用的 JWT —— 而日志的可见范围远大于令牌本该到的地方。
    """

    PATTERN = re.compile(r"([?&])token=[^&\s\x22\x27]+")

    def filter(self, record):
        try:
            msg = record.getMessage()
        except Exception:
            return True
        if "token=" not in msg:
            return True
        redacted = self.PATTERN.sub(r"\1token=***", msg)
        if redacted != msg:
            record.msg = redacted
            record.args = ()
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


class _PollAuthNoiseFilter(logging.Filter):
    """压掉"前端轮询接口 + 401"这类已知访问日志噪音，改为限流汇总告警。

    背景：通知未读 / 学伴推送未读 / 进行中任务这类轮询每 30s 一轮，页面挂机 +
    token 失效时会把 access log 刷成 401 海。真问题时这些行反而淹没有用信息，
    所以：单条丢弃，但每 60 秒输出一条"抑制了 N 条 + 样例"的 WARN，不丢线索。
    只针对 401；轮询接口的 200/5xx、其它接口的 401 全部照常输出。
    """

    SUMMARY_INTERVAL = 60.0

    def __init__(self, name: str = ""):
        super().__init__(name)
        self._suppressed = 0
        self._sample = ""
        self._last_report = 0.0

    def filter(self, record):
        try:
            msg = record.getMessage()
        except Exception:
            return True
        if not (" 401 " in msg and any(path in msg for path in _POLL_401_NOISE)):
            return True

        self._suppressed += 1
        if not self._sample:
            self._sample = msg.strip()
        now = time.monotonic()
        if now - self._last_report >= self.SUMMARY_INTERVAL:
            self._last_report = now
            count, sample = self._suppressed, self._sample
            self._suppressed, self._sample = 0, ""
            try:
                logging.getLogger("smartkb").warning(
                    f"[access] 近 60 秒内抑制 {count} 条轮询接口 401 访问日志，"
                    f"样例: {sample}"
                )
            except Exception:
                pass
        return False


class SizeRotatingHandler(logging.FileHandler):
    """按大小轮转的日志处理器, 归档名带时间戳, 保留最近 N 份

    多实例安全: 轮转只做 os.rename, 成功才截断新档; 其他进程持有句柄时 rename 直接失败
    (WinError 32), 此时退避重试并一次性告警。旧版 shutil.move 在 Windows 锁文件时会退化为
    "整体复制+删不掉原件", 曾把同一份日志复制出 5 个假归档而主文件永不截断(2026-10 事故)。

    兜底: 连续 2 次被锁轮转失败后, 本进程自动"迁出"到 backend.<pid>.log 独立滚动,
    保证任何共写环境下 5MB 自动重开都成立; 遗留文件由 log_retention 每日回收。
    """

    _ROTATE_BACKOFF = 300.0  # rename 失败后的重试间隔(秒)

    def __init__(self, filename, maxBytes=_LOG_MAX_BYTES, backupCount=_LOG_BACKUP_COUNT, encoding="utf-8"):
        self.maxBytes = maxBytes
        self.backupCount = backupCount
        self._emit_n = 0
        self._rotate_warned = False
        self._next_rotate_at = 0.0
        self._rotate_fail_streak = 0
        super().__init__(filename, encoding=encoding, delay=True)

    def emit(self, record):
        try:
            self._emit_n += 1
            if (self.stream is not None
                    and self._emit_n % _CHECK_EVERY_N == 0
                    and time.monotonic() >= self._next_rotate_at):
                try:
                    if os.path.getsize(self.baseFilename) >= self.maxBytes:
                        self.do_rollover()
                except OSError:
                    pass
        except Exception:
            pass
        super().emit(record)

    def do_rollover(self):
        """rename 轮转: 只认原子改名; 被其他活句柄锁住时原地续写、退避重试, 绝不复制"""
        self.close()
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        archive = f"{self.baseFilename}.{stamp}"
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
        """按 mtime 保留最近 backupCount 份归档(含 .gz), 清理超额"""
        try:
            d = os.path.dirname(self.baseFilename) or "."
            base = os.path.basename(self.baseFilename)
            archives = sorted(
                (f for f in os.listdir(d) if f.startswith(base + ".")),
                key=lambda f: os.path.getmtime(os.path.join(d, f)),
                reverse=True,
            )
            for old in archives[self.backupCount:]:
                try:
                    os.remove(os.path.join(d, old))
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

    # 文件 handler: DEBUG 起, 5MB 轮转 + 保留 5 份日期归档
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

# uvicorn HTTP 访问日志: INFO 级(可捕获 4xx), 由过滤器去噪; 统一在此配置
uvicorn_access = logging.getLogger("uvicorn.access")
uvicorn_access.setLevel(logging.INFO)
if not any(isinstance(f, _AccessNoiseFilter) for f in uvicorn_access.filters):
    uvicorn_access.addFilter(_AccessNoiseFilter())
if not any(isinstance(f, _PollAuthNoiseFilter) for f in uvicorn_access.filters):
    uvicorn_access.addFilter(_PollAuthNoiseFilter())
if not any(isinstance(f, _AccessTokenRedactFilter) for f in uvicorn_access.filters):
    uvicorn_access.addFilter(_AccessTokenRedactFilter())
