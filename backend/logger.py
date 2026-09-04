"""
统一日志配置
- _SmartLogger: except 块内调用 logger.error 自动附带堆栈(exc_info), 全局免逐处改造
- SizeRotatingHandler: 延迟打开 + 每 32 条抽样查大小 + 按日期归档轮转保留 5 份 + 轮转失败仅告警一次
- 级别策略: logger=DEBUG, 控制台=INFO(现场不刷屏), 文件=DEBUG(排障可查)
- uvicorn.access: 恢复 INFO(可见 4xx/5xx) + 内置噪音路径过滤器(统一配置, main.py 不再重复)
"""
import logging
import os
import shutil
import sys
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


class SizeRotatingHandler(logging.FileHandler):
    """按大小轮转的日志处理器, 归档名带时间戳, 保留最近 N 份"""
    def __init__(self, filename, maxBytes=_LOG_MAX_BYTES, backupCount=_LOG_BACKUP_COUNT, encoding="utf-8"):
        self.maxBytes = maxBytes
        self.backupCount = backupCount
        self._emit_n = 0
        self._rotate_warned = False
        super().__init__(filename, encoding=encoding, delay=True)

    def emit(self, record):
        try:
            self._emit_n += 1
            if self.stream is not None and self._emit_n % _CHECK_EVERY_N == 0:
                try:
                    if os.path.getsize(self.baseFilename) >= self.maxBytes:
                        self.do_rollover()
                except OSError:
                    pass
        except Exception:
            pass
        super().emit(record)

    def do_rollover(self):
        """轮转: 当前文件改名为带时间戳归档, 清理超额旧档; 失败只告警一次"""
        self.close()
        moved = False
        try:
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            shutil.move(self.baseFilename, f"{self.baseFilename}.{stamp}")
            moved = True
        except Exception:
            moved = False
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
        try:
            self.stream = open(self.baseFilename, "a", encoding=self.encoding)
            self._rotate_warned = False if moved else self._rotate_warned
        except Exception as e:
            if not self._rotate_warned:
                self._rotate_warned = True
                print(f"[logger] 日志轮转/重开文件失败(已降级为仅控制台): {e}", file=sys.stderr)


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
