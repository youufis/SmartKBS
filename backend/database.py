"""
数据库连接管理
替代 AgentSmartKBXS.py 中裸 sqlite3.connect() 调用
提供上下文管理器，自动管理连接生命周期
"""
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from backend.logger import logger

# 数据库文件路径（backend 目录下）
DB_PATH = Path(__file__).resolve().parent / "users.db"


def init_db():
    """初始化用户数据库（如果表不存在则创建）"""
    try:
        with get_connection() as conn:
            c = conn.cursor()
            c.execute(
                """CREATE TABLE IF NOT EXISTS users
                 (username TEXT PRIMARY KEY,
                  password BLOB,
                  class TEXT,
                  name TEXT,
                  gender INTEGER,
                  role INTEGER DEFAULT 2,
                  grade TEXT)"""
            )
            # 兼容旧表：添加 grade 列（如果不存在）
            try:
                c.execute("ALTER TABLE users ADD COLUMN grade TEXT")
            except sqlite3.OperationalError:
                pass  # 列已存在

            # 兼容旧表：class 列从 INTEGER 转为 TEXT（SQLite 类型宽松，无需实际更改）
            # 但确保旧数据能被正确读取：无需操作

            # 课堂积分查询优化索引（role + grade 联合索引）
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_users_role_grade ON users(role, grade)")
            except sqlite3.OperationalError:
                pass

            # ── 每日使用量统计表（限流用，与日志解耦） ──
            c.execute(
                """CREATE TABLE IF NOT EXISTS daily_usage (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL,
                    date TEXT NOT NULL,
                    count INTEGER DEFAULT 0,
                    UNIQUE(username, date)
                )"""
            )

            conn.commit()
            logger.info("数据库初始化完成")
    except Exception as e:
        logger.error(f"数据库初始化失败: {e}")
        raise


@contextmanager
def get_connection():
    """获取数据库连接的上下文管理器
    使用方式:
        with get_connection() as conn:
            c = conn.cursor()
            c.execute(...)
    已启用 WAL 模式和 30 秒超时，支持并发读写。
    """
    conn = None
    try:
        conn = sqlite3.connect(str(DB_PATH), timeout=30, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=30000")
        yield conn
    except sqlite3.Error as e:
        logger.error(f"数据库操作失败: {e}")
        raise
    finally:
        if conn:
            conn.close()


def execute_query(sql: str, params: tuple = ()):
    """执行查询并返回所有结果"""
    with get_connection() as conn:
        c = conn.cursor()
        c.execute(sql, params)
        return c.fetchall()


def execute_insert_update(sql: str, params: tuple = ()):
    """执行插入/更新操作并提交"""
    with get_connection() as conn:
        c = conn.cursor()
        c.execute(sql, params)
        conn.commit()
        return c.lastrowid


@contextmanager
def get_transaction():
    """
    获取数据库连接（批量事务用）
    退出时自动提交，异常时自动回滚
    适用于批量导入等需要多次操作统一提交的场景
    """
    conn = sqlite3.connect(str(DB_PATH))
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
