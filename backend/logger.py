"""
统一日志配置
替代 AgentSmartKBXS.py 中散落的 print() 调用
使用 RotatingFileHandler 按大小轮转，防止日志无限增长。
"""
import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

from backend.config import LOG_FILES_DIR

# 日志轮转配置
_LOG_MAX_BYTES = 5 * 1024 * 1024   # 单个日志文件最大 5 MB
_LOG_BACKUP_COUNT = 5              # 保留最近 5 个备份文件


def setup_logger(name: str = "smartkb") -> logging.Logger:
    """设置并返回一个配置好的 logger 实例"""
    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)

    # 避免重复添加 handler
    if logger.handlers:
        return logger

    # 控制台 handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(logging.INFO)
    console_fmt = logging.Formatter(
        "[%(asctime)s] %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    console_handler.setFormatter(console_fmt)
    logger.addHandler(console_handler)

    # 文件 handler（自动轮转）
    try:
        log_dir = Path(LOG_FILES_DIR)
        log_dir.mkdir(parents=True, exist_ok=True)
        file_handler = RotatingFileHandler(
            log_dir / "backend.log",
            maxBytes=_LOG_MAX_BYTES,
            backupCount=_LOG_BACKUP_COUNT,
            encoding="utf-8",
        )
        file_handler.setLevel(logging.DEBUG)
        file_fmt = logging.Formatter(
            "[%(asctime)s] %(levelname)s [%(filename)s:%(lineno)d] - %(message)s"
        )
        file_handler.setFormatter(file_fmt)
        logger.addHandler(file_handler)
    except Exception as e:
        logger.warning(f"无法创建日志文件: {e}")

    return logger


# 全局默认 logger
logger = setup_logger()
