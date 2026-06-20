"""
统一日志配置
使用自定义 SizeRotatingHandler，shutil 替代 os.rename 解决 Windows 文件锁问题。
日志达到 5MB 自动轮转，保留最近 5 个文件。
"""
import logging
import os
import shutil
import sys
from pathlib import Path

from backend.config import LOG_FILES_DIR

_LOG_MAX_BYTES = 5 * 1024 * 1024   # 5 MB
_LOG_BACKUP_COUNT = 5


class SizeRotatingHandler(logging.FileHandler):
    """按大小轮转的日志处理器（兼容 Windows 文件锁）"""
    def __init__(self, filename, maxBytes=_LOG_MAX_BYTES, backupCount=_LOG_BACKUP_COUNT, encoding="utf-8"):
        self.maxBytes = maxBytes
        self.backupCount = backupCount
        super().__init__(filename, encoding=encoding)

    def emit(self, record):
        """写入前检查是否需要轮转"""
        try:
            if self.stream and os.path.exists(self.baseFilename):
                if os.path.getsize(self.baseFilename) >= self.maxBytes:
                    self.do_rollover()
            super().emit(record)
        except Exception:
            super().emit(record)

    def do_rollover(self):
        """轮转：用 shutil.move 替代 os.rename，兼容 Windows 文件锁"""
        self.close()
        for i in range(self.backupCount - 1, 0, -1):
            s = f"{self.baseFilename}.{i}"
            d = f"{self.baseFilename}.{i + 1}"
            if os.path.exists(s):
                try:
                    shutil.move(s, d)
                except Exception:
                    pass
        d1 = f"{self.baseFilename}.1"
        if os.path.exists(self.baseFilename):
            try:
                shutil.move(self.baseFilename, d1)
            except Exception:
                pass
        self.stream = open(self.baseFilename, "a", encoding=self.encoding)


def setup_logger(name: str = "smartkb") -> logging.Logger:
    """设置并返回一个配置好的 logger 实例"""
    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)

    if logger.handlers:
        return logger

    # 控制台 handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(logging.INFO)
    console_handler.setFormatter(logging.Formatter(
        "[%(asctime)s] %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    ))
    logger.addHandler(console_handler)

    # 文件 handler（5MB 自动轮转 + 保留 5 个）
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
        logger.warning(f"无法创建日志文件: {e}")

    return logger


# 全局默认 logger
logger = setup_logger()
