"""
V6.6.0 基线迁移脚本
记录当前数据库结构版本，后续升级脚本以此为基准
"""
from backend.database import get_connection
from backend.logger import logger


def migrate():
    """V6.6.0 基线迁移：确保升级日志表存在"""
    with get_connection() as conn:
        c = conn.cursor()
        c.execute("""
            CREATE TABLE IF NOT EXISTS upgrade_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_version TEXT NOT NULL,
                to_version TEXT NOT NULL,
                admin_username TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'success',
                error_message TEXT DEFAULT '',
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
    logger.info("V6.6.0 基线迁移完成：upgrade_logs 表已就绪")
