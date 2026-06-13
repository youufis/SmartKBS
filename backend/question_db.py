"""
试题库数据库连接管理
独立于 smartkb.db，使用单独的 questions.db 文件
"""
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from backend.logger import logger

# 数据库文件路径（backend 目录下）
DB_PATH = Path(__file__).resolve().parent / "questions.db"


def init_question_db():
    """初始化试题库数据库（如果表不存在则创建）"""
    try:
        with get_connection() as conn:
            c = conn.cursor()

            # ── 试题库表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS question_bank (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,              -- single|multiple|true_false|short|fill|essay|subjective
                question_text TEXT NOT NULL,
                options TEXT,                    -- JSON，选择题: {"A":"选项","B":"选项",...}
                correct_answer TEXT NOT NULL,    -- 单选:"A"; 多选:"A,B,C"; 判断:"对"/"错"; 简答:参考答案
                explanation TEXT,
                knowledge_points TEXT,           -- 知识点标签（逗号分隔）
                subject TEXT DEFAULT '',         -- 信息技术 / 通用技术
                difficulty TEXT DEFAULT 'medium', -- easy | medium | hard
                creator_username TEXT NOT NULL,
                creator_name TEXT DEFAULT '',
                source TEXT DEFAULT 'ai',        -- ai | manual
                status TEXT DEFAULT 'active',    -- active | deleted
                created_at TEXT,
                updated_at TEXT
            )""")

            # 索引
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_qb_type ON question_bank(type)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_qb_creator ON question_bank(creator_username)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_qb_knowledge ON question_bank(knowledge_points)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_qb_status ON question_bank(status)")
            except sqlite3.OperationalError:
                pass

            # ── 多媒体/公式配图字段迁移 ──
            for col in ['svg_content', 'has_svg', 'media_placeholders', 'media_files']:
                try:
                    if col == 'has_svg':
                        c.execute(f"ALTER TABLE question_bank ADD COLUMN {col} INTEGER DEFAULT 0")
                    else:
                        c.execute(f"ALTER TABLE question_bank ADD COLUMN {col} TEXT DEFAULT ''")
                except sqlite3.OperationalError:
                    pass  # 字段已存在

            # ── 考试表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS exams (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                subject TEXT DEFAULT '',
                duration INTEGER DEFAULT 45,
                total_score REAL DEFAULT 100,
                pass_score REAL DEFAULT 60,
                shuffle_questions INTEGER DEFAULT 1,
                shuffle_options INTEGER DEFAULT 1,
                show_result_immediately INTEGER DEFAULT 0,
                max_attempts INTEGER DEFAULT 1,
                start_time TEXT,
                end_time TEXT,
                status TEXT DEFAULT 'draft',
                creator_username TEXT NOT NULL,
                creator_name TEXT DEFAULT '',
                created_at TEXT,
                updated_at TEXT
            )""")

            # ── 考试-试题关联表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS exam_questions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                exam_id INTEGER NOT NULL,
                question_id INTEGER NOT NULL,
                sort_order INTEGER DEFAULT 0,
                score REAL DEFAULT 5,
                FOREIGN KEY (exam_id) REFERENCES exams(id),
                FOREIGN KEY (question_id) REFERENCES question_bank(id)
            )""")

            # ── 考试记录表（学生答题记录） ──
            c.execute("""CREATE TABLE IF NOT EXISTS exam_attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                exam_id INTEGER NOT NULL,
                student_username TEXT NOT NULL,
                student_name TEXT DEFAULT '',
                started_at TEXT,
                submitted_at TEXT,
                status TEXT DEFAULT 'in_progress',
                score REAL DEFAULT 0,
                total_score REAL DEFAULT 0,
                answers TEXT,
                auto_graded INTEGER DEFAULT 0,
                graded_by TEXT DEFAULT '',          -- 批改人: 'ai' | 教师用户名
                grading_details TEXT DEFAULT '',    -- AI 详细批改结果 JSON（含多维评分、评语等）
                teacher_reviewed INTEGER DEFAULT 0, -- 教师是否已复核
                teacher_score REAL DEFAULT -1,      -- 教师手动调整后的分数（-1 表示未调整）
                teacher_comment TEXT DEFAULT '',    -- 教师评语
                FOREIGN KEY (exam_id) REFERENCES exams(id)
            )""")

            # 索引
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_exam_creator ON exams(creator_username)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_exam_status ON exams(status)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_eq_exam ON exam_questions(exam_id)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_ea_exam ON exam_attempts(exam_id)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_ea_student ON exam_attempts(student_username)")
            except sqlite3.OperationalError:
                pass

            # ── 字段迁移：exam_attempts 新增字段 ──
            for col_def in [
                ("graded_by", "TEXT DEFAULT ''"),
                ("grading_details", "TEXT DEFAULT ''"),
                ("teacher_reviewed", "INTEGER DEFAULT 0"),
                ("teacher_score", "REAL DEFAULT -1"),
                ("teacher_comment", "TEXT DEFAULT ''"),
            ]:
                try:
                    c.execute(f"ALTER TABLE exam_attempts ADD COLUMN {col_def[0]} {col_def[1]}")
                except sqlite3.OperationalError:
                    pass  # 字段已存在

            # ── 智能练习：练习任务表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS practice_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                knowledge_points TEXT NOT NULL,
                creator_username TEXT NOT NULL,
                subject TEXT DEFAULT '信息科技',
                question_count INTEGER DEFAULT 0,
                total_score INTEGER DEFAULT 0,
                target_grade TEXT DEFAULT '',
                target_class TEXT DEFAULT '',
                target_students TEXT DEFAULT '',
                source TEXT DEFAULT 'teacher',
                status TEXT DEFAULT 'active',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )""")
            try:
                c.execute("ALTER TABLE practice_sessions ADD COLUMN target_students TEXT DEFAULT ''")
            except sqlite3.OperationalError:
                pass
            try:
                c.execute("ALTER TABLE practice_sessions ADD COLUMN source TEXT DEFAULT 'teacher'")
            except sqlite3.OperationalError:
                pass
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_ps_creator ON practice_sessions(creator_username)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_ps_target ON practice_sessions(target_grade, target_class)")
            except sqlite3.OperationalError:
                pass

            # ── 智能练习：练习题目关联表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS practice_session_questions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                question_id INTEGER NOT NULL,
                sort_order INTEGER DEFAULT 0,
                score INTEGER DEFAULT 10
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_psq_session ON practice_session_questions(session_id)")
            except sqlite3.OperationalError:
                pass

            # ── 智能练习：学生答题记录表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS practice_attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                student_username TEXT NOT NULL,
                answers TEXT NOT NULL,
                score INTEGER DEFAULT 0,
                total_score INTEGER DEFAULT 0,
                status TEXT DEFAULT 'submitted',
                submitted_at TEXT NOT NULL,
                UNIQUE(session_id, student_username)
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_pa_student ON practice_attempts(student_username)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_pa_session ON practice_attempts(session_id)")
            except sqlite3.OperationalError:
                pass

            # ═══════════════════════════════════════════════════════════
            # 代码练习：独立表（不再依赖 question_bank）
            # ═══════════════════════════════════════════════════════════

            # ── 代码题主表（独立，不再关联 question_bank）──
            # 先检查旧表结构，如有 question_id 列则迁移
            try:
                c.execute("SELECT question_id FROM code_problems LIMIT 1")
                # 旧表存在，删除重建（新功能尚无生产数据）
                c.execute("DROP TABLE IF EXISTS code_problems")
                c.execute("DROP TABLE IF EXISTS code_test_cases")
                c.execute("DROP TABLE IF EXISTS code_submissions")
                c.execute("DROP TABLE IF EXISTS code_runs")
            except sqlite3.OperationalError:
                pass  # 新表或不存在

            c.execute("""CREATE TABLE IF NOT EXISTS code_problems (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                subject TEXT DEFAULT '信息科技',
                knowledge_points TEXT DEFAULT '',
                difficulty TEXT DEFAULT 'medium',
                creator_username TEXT NOT NULL,
                creator_name TEXT DEFAULT '',
                language TEXT NOT NULL DEFAULT 'python',
                template_code TEXT DEFAULT '',
                starter_code TEXT DEFAULT '',
                time_limit INTEGER DEFAULT 5,
                status TEXT DEFAULT 'active',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )""")

            # ── 测试用例表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS code_test_cases (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                problem_id INTEGER NOT NULL,
                input TEXT DEFAULT '',
                expected_output TEXT NOT NULL,
                is_sample INTEGER DEFAULT 0,
                score REAL DEFAULT 1.0,
                sort_order INTEGER DEFAULT 0,
                description TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                FOREIGN KEY (problem_id) REFERENCES code_problems(id)
            )""")

            # ── 学生提交记录表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS code_submissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                problem_id INTEGER NOT NULL,
                student_username TEXT NOT NULL,
                language TEXT NOT NULL DEFAULT 'python',
                source_code TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                passed_cases INTEGER DEFAULT 0,
                total_cases INTEGER DEFAULT 0,
                score REAL DEFAULT 0,
                execution_time REAL,
                error_message TEXT DEFAULT '',
                ai_review TEXT DEFAULT '',
                ai_review_status TEXT DEFAULT 'pending',
                created_at TEXT NOT NULL,
                is_best INTEGER DEFAULT 0,
                FOREIGN KEY (problem_id) REFERENCES code_problems(id)
            )""")

            # ── 运行记录表（非评分的「运行一下」功能）──
            c.execute("""CREATE TABLE IF NOT EXISTS code_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                problem_id INTEGER,
                student_username TEXT NOT NULL,
                language TEXT NOT NULL DEFAULT 'python',
                source_code TEXT NOT NULL,
                input_data TEXT DEFAULT '',
                output_data TEXT DEFAULT '',
                execution_time REAL,
                error_message TEXT DEFAULT '',
                created_at TEXT NOT NULL
            )""")

            # 索引
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_cp_creator ON code_problems(creator_username)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_cp_status ON code_problems(status)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_ctc_problem ON code_test_cases(problem_id, sort_order)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_cs_student ON code_submissions(student_username, problem_id)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_cs_best ON code_submissions(problem_id, is_best)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_cr_student ON code_runs(student_username)")
            except sqlite3.OperationalError:
                pass

            conn.commit()
            logger.debug("试题库数据库初始化完成")
    except Exception as e:
        logger.error(f"试题库数据库初始化失败: {e}")
        raise


@contextmanager
def get_connection():
    """获取试题库数据库连接的上下文管理器
    已启用 WAL 模式和 30 秒超时，支持并发读写。
    """
    conn = None
    try:
        conn = sqlite3.connect(str(DB_PATH), timeout=30, check_same_thread=False)
        conn.row_factory = sqlite3.Row  # 支持按列名访问
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=30000")
        yield conn
    except sqlite3.Error as e:
        logger.error(f"试题库数据库操作失败: {e}")
        raise
    finally:
        if conn:
            conn.close()


def execute_query(sql: str, params: tuple = ()):
    """执行查询并返回所有结果（字典格式）"""
    with get_connection() as conn:
        c = conn.cursor()
        c.execute(sql, params)
        rows = c.fetchall()
        return [dict(row) for row in rows]


def execute_query_one(sql: str, params: tuple = ()):
    """执行查询并返回单条结果（字典格式）"""
    with get_connection() as conn:
        c = conn.cursor()
        c.execute(sql, params)
        row = c.fetchone()
        return dict(row) if row else None


def execute_insert(sql: str, params: tuple = ()):
    """执行插入操作并返回自增 ID"""
    with get_connection() as conn:
        c = conn.cursor()
        c.execute(sql, params)
        conn.commit()
        return c.lastrowid


def execute_update(sql: str, params: tuple = ()):
    """执行更新/删除操作"""
    with get_connection() as conn:
        c = conn.cursor()
        c.execute(sql, params)
        conn.commit()
        return c.rowcount
