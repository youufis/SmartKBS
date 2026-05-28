"""
数据库连接管理
替代 AgentSmartKBXS.py 中裸 sqlite3.connect() 调用
提供上下文管理器，自动管理连接生命周期
"""
import json
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from backend.logger import logger

# 数据库文件路径（backend 目录下）
DB_PATH = Path(__file__).resolve().parent / "smartkb.db"


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

            # ── 共享资源表 ──
            c.execute(
                """CREATE TABLE IF NOT EXISTS shared_resources (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner_username TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    file_name TEXT NOT NULL,
                    resource_type TEXT NOT NULL CHECK(resource_type IN ('html', 'download')),
                    share_scope TEXT NOT NULL DEFAULT 'all',
                    target_users TEXT DEFAULT '',
                    target_grade TEXT DEFAULT '',
                    target_class TEXT DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(owner_username, file_path, resource_type)
                )"""
            )
            # 迁移旧表：移除 share_scope 的 CHECK 约束以支持新值，并添加 target_users 列
            try:
                c.execute("DROP TABLE IF EXISTS shared_resources_old")
                c.execute("ALTER TABLE shared_resources RENAME TO shared_resources_old")
                c.execute("""CREATE TABLE shared_resources (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner_username TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    file_name TEXT NOT NULL,
                    resource_type TEXT NOT NULL CHECK(resource_type IN ('html', 'download')),
                    share_scope TEXT NOT NULL DEFAULT 'all',
                    target_users TEXT DEFAULT '',
                    target_grade TEXT DEFAULT '',
                    target_class TEXT DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(owner_username, file_path, resource_type)
                )""")
                c.execute("""INSERT INTO shared_resources
                    (id, owner_username, file_path, file_name, resource_type, share_scope, target_users, target_grade, target_class, created_at, updated_at)
                    SELECT id, owner_username, file_path, file_name, resource_type, share_scope, '', target_grade, target_class, created_at, updated_at
                    FROM shared_resources_old""")
                c.execute("DROP TABLE shared_resources_old")
            except sqlite3.OperationalError:
                pass  # 首次创建或已迁移
            # 兼容旧表：添加 target_users 列（如果不存在）
            try:
                c.execute("ALTER TABLE shared_resources ADD COLUMN target_users TEXT DEFAULT ''")
            except sqlite3.OperationalError:
                pass

            # ── 课堂积分表（替代 score_system JSON） ──
            c.execute("""CREATE TABLE IF NOT EXISTS scores (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                teacher_username TEXT NOT NULL,
                grade TEXT NOT NULL,
                class_name TEXT NOT NULL,
                student_name TEXT NOT NULL,
                score INTEGER DEFAULT 0,
                updated_at TEXT,
                UNIQUE(teacher_username, grade, class_name, student_name)
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_scores_teacher ON scores(teacher_username)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_scores_lookup ON scores(teacher_username, grade, class_name)")
            except sqlite3.OperationalError:
                pass

            # ── 点名权重表（替代 rollcall_data JSON） ──
            c.execute("""CREATE TABLE IF NOT EXISTS rollcall_weights (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                teacher_username TEXT NOT NULL,
                grade TEXT NOT NULL,
                class_name TEXT NOT NULL,
                student_name TEXT NOT NULL,
                weight REAL DEFAULT 10,
                UNIQUE(teacher_username, grade, class_name, student_name)
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_rcw_class ON rollcall_weights(teacher_username, grade, class_name)")
            except sqlite3.OperationalError:
                pass

            # ── 点名轮次元数据 ──
            c.execute("""CREATE TABLE IF NOT EXISTS rollcall_meta (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                teacher_username TEXT NOT NULL,
                grade TEXT NOT NULL,
                class_name TEXT NOT NULL,
                last_time REAL,
                picked_in_round TEXT DEFAULT '[]',
                updated_at TEXT,
                UNIQUE(teacher_username, grade, class_name)
            )""")

            # ── 点名历史记录表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS rollcall_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                teacher_username TEXT NOT NULL,
                grade TEXT NOT NULL,
                class_name TEXT NOT NULL,
                student_name TEXT,
                result TEXT,
                points INTEGER DEFAULT 0,
                created_at TEXT
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_rch_class ON rollcall_history(teacher_username, grade, class_name)")
            except sqlite3.OperationalError:
                pass

            # ── 任务表（替代 ChatHistory/Task JSON） ──
            c.execute("""CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                creator_username TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                status TEXT DEFAULT 'active',
                created_at TEXT,
                updated_at TEXT
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_tasks_creator ON tasks(creator_username)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)")
            except sqlite3.OperationalError:
                pass

            # ── 任务提交记录表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS task_submissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL,
                student_username TEXT NOT NULL,
                submitted_at TEXT,
                UNIQUE(task_id, student_username)
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_ts_task ON task_submissions(task_id)")
            except sqlite3.OperationalError:
                pass

            # ── 对话历史索引表（替代文件扫描） ──
            c.execute("""CREATE TABLE IF NOT EXISTS conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                session_id TEXT DEFAULT '',
                date TEXT NOT NULL,
                filename TEXT NOT NULL,
                title TEXT DEFAULT '',
                message_count INTEGER DEFAULT 0,
                file_size INTEGER DEFAULT 0,
                created_at TEXT,
                UNIQUE(username, date, filename)
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(username)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_conv_date ON conversations(username, date)")
            except sqlite3.OperationalError:
                pass

            # ── 通知消息表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                recipient_username TEXT NOT NULL,
                type TEXT NOT NULL DEFAULT 'info',
                title TEXT NOT NULL,
                content TEXT DEFAULT '',
                related_link TEXT DEFAULT '',
                is_read INTEGER DEFAULT 0,
                created_at TEXT NOT NULL
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_notif_recipient ON notifications(recipient_username, is_read)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_notif_time ON notifications(recipient_username, created_at)")
            except sqlite3.OperationalError:
                pass

            # ── 公告表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS announcements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                creator_username TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                target_role TEXT DEFAULT 'all',
                target_grade TEXT DEFAULT '',
                target_class TEXT DEFAULT '',
                priority TEXT DEFAULT 'normal',
                is_pinned INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_ann_target ON announcements(target_role, target_grade, target_class)")
            except sqlite3.OperationalError:
                pass

            # ── 课堂互动：随堂测验表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS interaction_quizzes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                creator_username TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                questions TEXT NOT NULL,      -- JSON 数组
                status TEXT DEFAULT 'active',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_iq_creator ON interaction_quizzes(creator_username)")
            except sqlite3.OperationalError:
                pass

            # ── 课堂互动：随堂测验答案表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS interaction_quiz_answers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                quiz_id INTEGER NOT NULL,
                student_username TEXT NOT NULL,
                answers TEXT NOT NULL,        -- JSON
                score REAL DEFAULT 0,
                submitted_at TEXT NOT NULL,
                UNIQUE(quiz_id, student_username)
            )""")

            # ── 课堂互动：快速投票表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS interaction_polls (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                creator_username TEXT NOT NULL,
                question TEXT NOT NULL,
                options TEXT NOT NULL,         -- JSON 数组
                status TEXT DEFAULT 'active',
                created_at TEXT NOT NULL
            )""")

            # ── 课堂互动：投票记录表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS interaction_poll_votes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                poll_id INTEGER NOT NULL,
                student_username TEXT NOT NULL,
                selected_option INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(poll_id, student_username)
            )""")

            # ── 课堂互动：学生提问表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS interaction_questions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_username TEXT NOT NULL,
                content TEXT NOT NULL,
                is_anonymous INTEGER DEFAULT 0,
                status TEXT DEFAULT 'pending',
                answer TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                answered_at TEXT
            )""")

            conn.commit()
            logger.info("数据库初始化完成")

            # 迁移旧版 JSON 数据（仅首次运行自动导入）
            _migrate_from_json()
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


# ── 旧版 JSON → 数据库 数据迁移 ──

def _migrate_conversations(BASE_DIR, conn):
    """扫描用户目录下的 .md 对话文件，建立 DB 索引"""
    chat_dirs = [BASE_DIR / "root" / "ChatHistory"]
    stu_dir = BASE_DIR / "stu"
    if stu_dir.exists():
        for user_dir in stu_dir.iterdir():
            if user_dir.is_dir():
                chat_dirs.append(user_dir / "ChatHistory")
    for item in BASE_DIR.iterdir():
        d = item / "ChatHistory"
        if item.is_dir() and d.exists() and item.name not in ("root", "stu"):
            chat_dirs.append(d)

    now_str = time.strftime("%Y-%m-%d %H:%M:%S")
    for chat_dir in chat_dirs:
        if not chat_dir.exists():
            continue
        parent = chat_dir.parent
        username = parent.name  # stu/ 下的由外层循环处理
        for md_file in chat_dir.rglob("*.md"):
            if "Summary" in md_file.parts:
                continue
            rel_path = md_file.relative_to(chat_dir)
            date_str = rel_path.parts[0] if len(rel_path.parts) > 1 else ""
            fsize = md_file.stat().st_size
            try:
                conn.cursor().execute(
                    "INSERT OR IGNORE INTO conversations (username, date, filename, file_size, created_at) VALUES (?, ?, ?, ?, ?)",
                    (username, date_str, str(rel_path).replace("\\", "/"), fsize, now_str),
                )
            except Exception:
                pass
    conn.commit()
    cnt = conn.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]
    logger.info(f"[迁移] 对话索引: {cnt} 条")


def _migrate_from_json():
    """将旧版 JSON 文件数据迁移到数据库（仅首次运行自动执行）"""
    BASE_DIR = Path(__file__).resolve().parent.parent

    # ── 对话历史索引迁移（独立运行，不受 scores 检查影响） ──
    try:
        with get_connection() as conn:
            existing = conn.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]
            if existing == 0:
                _migrate_conversations(BASE_DIR, conn)
    except Exception as e:
        logger.warning(f"[迁移] 对话索引失败: {e}")

    # 检查是否已迁移（scores 表有数据则跳过）
    with get_connection() as conn:
        if conn.execute("SELECT COUNT(*) FROM scores").fetchone()[0] > 0:
            return

    migrated_any = False

    # ── 1. 迁移积分数据（root/html/score_system/score.json） ──
    score_path = BASE_DIR / "root" / "html" / "score_system" / "score.json"
    if score_path.exists():
        try:
            with open(score_path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            with get_connection() as conn:
                for key, score in raw.items():
                    parts = key.split("|")
                    if len(parts) == 4:
                        c = conn.cursor()
                        c.execute(
                            "INSERT OR REPLACE INTO scores (teacher_username, grade, class_name, student_name, score, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
                            (parts[0], parts[1], parts[2], parts[3], score),
                        )
                conn.commit()
            migrated_any = True
            logger.info(f"[迁移] 积分数据: {len(raw)} 条")
        except Exception as e:
            logger.warning(f"[迁移] 积分数据失败: {e}")

    # ── 2. 迁移点名数据（root/html/rollcall_data/*.json） ──
    rc_dir = BASE_DIR / "root" / "html" / "rollcall_data"
    if rc_dir.exists():
        try:
            with get_connection() as conn:
                for fpath in sorted(rc_dir.glob("*.json")):
                    parts = fpath.stem.split("_", 1)
                    if len(parts) != 2:
                        continue
                    grade, cls = parts
                    with open(fpath, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    teacher = "root"
                    c = conn.cursor()
                    for sname, weight in data.get("weights", {}).items():
                        c.execute(
                            "INSERT OR REPLACE INTO rollcall_weights (teacher_username, grade, class_name, student_name, weight) VALUES (?, ?, ?, ?, ?)",
                            (teacher, grade, cls, sname, weight),
                        )
                    picked = json.dumps(data.get("picked_in_round", []), ensure_ascii=False)
                    c.execute(
                        "INSERT OR REPLACE INTO rollcall_meta (teacher_username, grade, class_name, last_time, picked_in_round, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
                        (teacher, grade, cls, data.get("last_time"), picked),
                    )
                    for entry in data.get("history", []):
                        c.execute(
                            "INSERT INTO rollcall_history (teacher_username, grade, class_name, student_name, result, points, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                            (teacher, grade, cls, entry.get("student", ""), entry.get("result", ""), entry.get("points", 0), entry.get("time", "")),
                        )
                conn.commit()
            migrated_any = True
            logger.info(f"[迁移] 点名数据完成")
        except Exception as e:
            logger.warning(f"[迁移] 点名数据失败: {e}")

    # ── 3. 迁移任务数据（root/ChatHistory/Task/*/active_tasks.json） ──
    task_base = BASE_DIR / "root" / "ChatHistory" / "Task"
    if task_base.exists():
        try:
            with get_connection() as conn:
                for user_dir in task_base.iterdir():
                    if not user_dir.is_dir():
                        continue
                    task_file = user_dir / "active_tasks.json"
                    if not task_file.exists():
                        continue
                    username = user_dir.name
                    with open(task_file, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    for task in data.get("tasks", []):
                        conn.cursor().execute(
                            "INSERT OR REPLACE INTO tasks (id, creator_username, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                            (task.get("id", ""), task.get("creator", username), task.get("name", ""), task.get("description", ""), task.get("status", "active"), task.get("created_time", ""), task.get("created_time", "")),
                        )
                        for su in task.get("submissions", []):
                            conn.cursor().execute(
                                "INSERT OR IGNORE INTO task_submissions (task_id, student_username, submitted_at) VALUES (?, ?, datetime('now'))",
                                (task.get("id", ""), su),
                            )
                conn.commit()
            migrated_any = True
            logger.info(f"[迁移] 任务数据完成")
        except Exception as e:
            logger.warning(f"[迁移] 任务数据失败: {e}")

    # ── 4. 迁移对话历史索引（扫描现有 .md 文件） ──
    try:
        with get_connection() as conn:
            existing = conn.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]
            if existing == 0:
                _migrate_conversations(BASE_DIR, conn)
    except Exception as e:
        logger.warning(f"[迁移] 对话索引失败: {e}")

    if migrated_any:
        logger.info("数据库迁移完成：旧版 JSON → SQLite")
