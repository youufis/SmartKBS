"""
数据库连接管理
替代 AgentSmartKBXS.py 中裸 sqlite3.connect() 调用
提供上下文管理器，自动管理连接生命周期
"""
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from backend.config import ROOT_DIR, STU_DIR
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

            # 兼容旧表：添加 token_version 列（单点登录用）
            try:
                c.execute("ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0")
            except sqlite3.OperationalError:
                pass  # 列已存在

            # 兼容旧表：class 列从 INTEGER 转为 TEXT（SQLite 类型宽松，无需实际更改）
            # 但确保旧数据能被正确读取：无需操作

            # 课堂积分查询优化索引（role + grade 联合索引）
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_users_role_grade ON users(role, grade)")
            except sqlite3.OperationalError:
                pass
            # 用户姓名搜索索引
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_users_name ON users(name)")
            except sqlite3.OperationalError:
                pass

            # ── 兼容旧表：添加 grade_id / class_id 外键列（新年级班级体系）──
            try:
                c.execute("ALTER TABLE users ADD COLUMN grade_id INTEGER REFERENCES grades(id)")
            except sqlite3.OperationalError:
                pass
            try:
                c.execute("ALTER TABLE users ADD COLUMN class_id INTEGER REFERENCES classes(id)")
            except sqlite3.OperationalError:
                pass
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_users_grade_id ON users(grade_id)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_users_class_id ON users(class_id)")
            except sqlite3.OperationalError:
                pass

            # ── 年级主数据表（全学段：小学/初中/高中）──
            c.execute("""CREATE TABLE IF NOT EXISTS grades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                stage TEXT NOT NULL DEFAULT '',
                sort_order INTEGER NOT NULL DEFAULT 0,
                is_active INTEGER DEFAULT 1
            )""")
            # 预置默认年级数据（幂等）
            default_grades = [
                ("一年级", "小学", 10),
                ("二年级", "小学", 12),
                ("三年级", "小学", 14),
                ("四年级", "小学", 16),
                ("五年级", "小学", 18),
                ("六年级", "小学", 20),
                ("初一", "初中", 30),
                ("初二", "初中", 32),
                ("初三", "初中", 34),
                ("高一", "高中", 50),
                ("高二", "高中", 52),
                ("高三", "高中", 54),
            ]
            for g_name, g_stage, g_order in default_grades:
                try:
                    c.execute(
                        "INSERT OR IGNORE INTO grades (name, stage, sort_order) VALUES (?, ?, ?)",
                        (g_name, g_stage, g_order),
                    )
                except sqlite3.OperationalError:
                    pass

            # ── 班级主数据表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS classes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                grade_id INTEGER NOT NULL REFERENCES grades(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                display_name TEXT NOT NULL,
                sort_order INTEGER DEFAULT 0,
                UNIQUE(grade_id, name)
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_classes_grade ON classes(grade_id)")
            except sqlite3.OperationalError:
                pass

            # ── 教师任教关系表（核心：解耦多年级多班级）──
            c.execute("""CREATE TABLE IF NOT EXISTS teacher_assignments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                teacher_username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
                grade_id INTEGER NOT NULL REFERENCES grades(id) ON DELETE CASCADE,
                class_id INTEGER,
                subject TEXT DEFAULT '',
                UNIQUE(teacher_username, grade_id, class_id)
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_ta_teacher ON teacher_assignments(teacher_username)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_ta_grade ON teacher_assignments(grade_id)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_ta_class ON teacher_assignments(class_id)")
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

            # ── question_bank 多媒体字段迁移 ──
            for col in ['svg_content', 'has_svg', 'media_placeholders', 'media_files']:
                try:
                    if col == 'has_svg':
                        c.execute(f"ALTER TABLE question_bank ADD COLUMN {col} INTEGER DEFAULT 0")
                    else:
                        c.execute(f"ALTER TABLE question_bank ADD COLUMN {col} TEXT DEFAULT ''")
                except sqlite3.OperationalError:
                    pass  # 字段已存在

            # ── 课堂积分表 ──
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
            # ── 兼容：scores 表增加 FK 列 ──
            for col in ["grade_id", "class_id"]:
                try:
                    c.execute(f"ALTER TABLE scores ADD COLUMN {col} INTEGER")
                except sqlite3.OperationalError:
                    pass

            # ── 点名权重表 ──
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
            # ── 兼容：rollcall_weights 表增加 FK 列 ──
            for col in ["grade_id", "class_id"]:
                try:
                    c.execute(f"ALTER TABLE rollcall_weights ADD COLUMN {col} INTEGER")
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
            # ── 兼容：rollcall_meta 表增加 FK 列 ──
            for col in ["grade_id", "class_id"]:
                try:
                    c.execute(f"ALTER TABLE rollcall_meta ADD COLUMN {col} INTEGER")
                except sqlite3.OperationalError:
                    pass

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
            # ── 兼容：rollcall_history 表增加 FK 列 ──
            for col in ["grade_id", "class_id"]:
                try:
                    c.execute(f"ALTER TABLE rollcall_history ADD COLUMN {col} INTEGER")
                except sqlite3.OperationalError:
                    pass

            # ── 任务表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                creator_username TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                status TEXT DEFAULT 'active',
                created_at TEXT,
                updated_at TEXT,
                ai_summary TEXT DEFAULT ''
            )""")
            try:
                c.execute("ALTER TABLE tasks ADD COLUMN ai_summary TEXT DEFAULT ''")
            except sqlite3.OperationalError:
                pass  # 列已存在
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

            # ── AI 批改结果表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS task_grades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL,
                student_username TEXT NOT NULL,
                ai_score REAL,
                ai_comment TEXT DEFAULT '',
                ai_feedback TEXT DEFAULT '',
                ai_strengths TEXT DEFAULT '',
                ai_weaknesses TEXT DEFAULT '',
                ai_graded_at TEXT,
                UNIQUE(task_id, student_username)
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_tg_task ON task_grades(task_id)")
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
                UNIQUE(poll_id, student_username, selected_option)
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
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_iq_student ON interaction_questions(student_username)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_iq_status ON interaction_questions(status)")
            except sqlite3.OperationalError:
                pass

            # ── 迁移：interaction_polls 添加 poll_type 列 ──
            try:
                c.execute("ALTER TABLE interaction_polls ADD COLUMN poll_type TEXT DEFAULT 'single'")
            except sqlite3.OperationalError:
                pass

            # ── 迁移：interaction_poll_votes 唯一约束改为 (poll_id, student_username, selected_option) ──
            # 支持多选投票：同一学生可对同一投票选择多个不同选项
            try:
                c.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='interaction_poll_votes'")
                row = c.fetchone()
                if row and row[0]:
                    # 旧约束: UNIQUE(poll_id, student_username)
                    # 新约束: UNIQUE(poll_id, student_username, selected_option)
                    if "UNIQUE(poll_id, student_username)" in row[0] and "selected_option" not in row[0]:
                        c.execute("ALTER TABLE interaction_poll_votes RENAME TO interaction_poll_votes_old")
                        c.execute("""CREATE TABLE interaction_poll_votes (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            poll_id INTEGER NOT NULL,
                            student_username TEXT NOT NULL,
                            selected_option INTEGER NOT NULL,
                            created_at TEXT NOT NULL,
                            UNIQUE(poll_id, student_username, selected_option)
                        )""")
                        c.execute("""INSERT INTO interaction_poll_votes
                            (id, poll_id, student_username, selected_option, created_at)
                            SELECT id, poll_id, student_username, selected_option, created_at
                            FROM interaction_poll_votes_old""")
                        c.execute("DROP TABLE interaction_poll_votes_old")
            except sqlite3.OperationalError:
                pass

            # ── 迁移：interaction_questions 添加 answered_by 列（学生互答功能） ──
            try:
                c.execute("ALTER TABLE interaction_questions ADD COLUMN answered_by TEXT DEFAULT ''")
            except sqlite3.OperationalError:
                pass

            # ── 课堂互动：多学生回答表（每个学生限答一次） ──
            c.execute("""CREATE TABLE IF NOT EXISTS interaction_question_answers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                question_id INTEGER NOT NULL,
                student_username TEXT NOT NULL,
                answer TEXT NOT NULL,
                status TEXT DEFAULT 'pending_approval',
                created_at TEXT NOT NULL,
                UNIQUE(question_id, student_username)
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_iqa_qid ON interaction_question_answers(question_id)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_iqa_status ON interaction_question_answers(status)")
            except sqlite3.OperationalError:
                pass

            # ── 分组讨论表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS discussions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                creator_username TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                subject TEXT DEFAULT '',
                group_mode TEXT DEFAULT 'auto',
                group_count INTEGER DEFAULT 0,
                members_per_group INTEGER DEFAULT 0,
                ai_role TEXT DEFAULT 'guide',
                duration_minutes INTEGER DEFAULT 0,
                status TEXT DEFAULT 'pending',
                grade TEXT DEFAULT '',
                classes TEXT DEFAULT '',
                require_summary INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_disc_creator ON discussions(creator_username)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_disc_status ON discussions(status)")
            except sqlite3.OperationalError:
                pass

            # ── 讨论小组表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS discussion_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                discussion_id INTEGER NOT NULL REFERENCES discussions(id),
                group_index INTEGER NOT NULL,
                name TEXT DEFAULT ''
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_dg_disc ON discussion_groups(discussion_id)")
            except sqlite3.OperationalError:
                pass

            # ── 讨论组成员表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS discussion_members (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL REFERENCES discussion_groups(id),
                username TEXT NOT NULL,
                role TEXT DEFAULT 'member',
                joined_at TEXT NOT NULL
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_dm_group ON discussion_members(group_id)")
                c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_user_disc ON discussion_members(group_id, username)")
            except sqlite3.OperationalError:
                pass

            # ── 讨论消息表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS discussion_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL REFERENCES discussion_groups(id),
                username TEXT,
                content TEXT NOT NULL,
                msg_type TEXT DEFAULT 'text',
                created_at TEXT NOT NULL
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_dmsg_group ON discussion_messages(group_id)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_dmsg_time ON discussion_messages(created_at)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_dmsg_type ON discussion_messages(msg_type)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_dm_username ON discussion_members(username)")
            except sqlite3.OperationalError:
                pass

            # ── 讨论报告表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS discussion_reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                discussion_id INTEGER NOT NULL REFERENCES discussions(id),
                group_id INTEGER,
                report_content TEXT NOT NULL,
                generated_at TEXT NOT NULL
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_dr_disc ON discussion_reports(discussion_id)")
            except sqlite3.OperationalError:
                pass

            # ═══════════════════════════════════════════════
            # 课程大纲模块（v2.3）
            # ═══════════════════════════════════════════════

            # ── 课程表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS courses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                code TEXT DEFAULT '',
                description TEXT DEFAULT '',
                grade TEXT DEFAULT '',
                cover_image TEXT DEFAULT '',
                sort_order INTEGER DEFAULT 0,
                status TEXT DEFAULT 'active',
                subject TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )""")
            # 兼容旧表：添加 subject 列（课程大类）
            try:
                c.execute("ALTER TABLE courses ADD COLUMN subject TEXT DEFAULT ''")
            except sqlite3.OperationalError:
                pass  # 列已存在

            # ── 章/节表（自引用 parent_id，支持无限嵌套） ──
            c.execute("""CREATE TABLE IF NOT EXISTS chapters (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                course_id INTEGER NOT NULL REFERENCES courses(id),
                parent_id INTEGER DEFAULT NULL REFERENCES chapters(id),
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                sort_order INTEGER DEFAULT 0,
                status TEXT DEFAULT 'active',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )""")

            # ── 知识点表（叶子节点） ──
            c.execute("""CREATE TABLE IF NOT EXISTS knowledge_points (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chapter_id INTEGER NOT NULL REFERENCES chapters(id),
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                learning_objectives TEXT DEFAULT '',
                difficulty TEXT DEFAULT 'medium',
                estimated_minutes INTEGER DEFAULT 0,
                sort_order INTEGER DEFAULT 0,
                status TEXT DEFAULT 'active',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )""")

            # ── 课程资源绑定表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS curriculum_bindings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                knowledge_point_id INTEGER NOT NULL REFERENCES knowledge_points(id),
                resource_type TEXT NOT NULL,
                resource_id INTEGER NOT NULL,
                sort_order INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                UNIQUE(knowledge_point_id, resource_type, resource_id)
            )""")

            # ── 学生学习进度表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS learning_progress (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_username TEXT NOT NULL REFERENCES users(username),
                knowledge_point_id INTEGER NOT NULL REFERENCES knowledge_points(id),
                status TEXT DEFAULT 'not_started',
                score REAL DEFAULT 0,
                completed_at TEXT DEFAULT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(student_username, knowledge_point_id)
            )""")

            # ── 课程大纲索引 ──
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_courses_status ON courses(status)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_chapters_course ON chapters(course_id)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_chapters_parent ON chapters(parent_id)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_kp_chapter ON knowledge_points(chapter_id)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_cb_kp ON curriculum_bindings(knowledge_point_id)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_cb_type ON curriculum_bindings(resource_type, resource_id)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_lp_student ON learning_progress(student_username)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_lp_kp ON learning_progress(knowledge_point_id)")
            except sqlite3.OperationalError:
                pass

            # ═══════════════════════════════════════════════
            # 资源分组模块（v2.7）
            # ═══════════════════════════════════════════════

            c.execute("""CREATE TABLE IF NOT EXISTS resource_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                group_name TEXT NOT NULL,
                sort_order INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                UNIQUE(username, group_name)
            )""")

            c.execute("""CREATE TABLE IF NOT EXISTS resource_group_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL REFERENCES resource_groups(id),
                file_path TEXT NOT NULL,
                sort_order INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                UNIQUE(group_id, file_path)
            )""")

            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_rg_username ON resource_groups(username)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_rgi_group ON resource_group_items(group_id)")
            except sqlite3.OperationalError:
                pass

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
                session_id INTEGER NOT NULL REFERENCES practice_sessions(id),
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
                session_id INTEGER NOT NULL REFERENCES practice_sessions(id),
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

            # ═══════════════════════════════════════════════
            # 积分奖励模块（v4.1）
            # ═══════════════════════════════════════════════

            # ── 活动积分记录表（每次活动的奖励流水） ──
            c.execute("""CREATE TABLE IF NOT EXISTS activity_rewards (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_username TEXT NOT NULL,
                activity_type TEXT NOT NULL,
                activity_id TEXT NOT NULL,
                activity_title TEXT DEFAULT '',
                reward_type TEXT NOT NULL,
                points INTEGER NOT NULL,
                reason TEXT DEFAULT '',
                teacher_username TEXT DEFAULT '',
                created_at TEXT NOT NULL
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_ar_student ON activity_rewards(student_username)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_ar_activity ON activity_rewards(activity_type, activity_id)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_ar_created ON activity_rewards(created_at)")
            except sqlite3.OperationalError:
                pass

            # ── 学生积分汇总表（缓存，避免每次都 SUM） ──
            c.execute("""CREATE TABLE IF NOT EXISTS student_total_points (
                student_username TEXT PRIMARY KEY,
                total_points INTEGER DEFAULT 0,
                updated_at TEXT NOT NULL
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_stp_points ON student_total_points(total_points DESC)")
            except sqlite3.OperationalError:
                pass

            # ═══════════════════════════════════════════════
            # 称号系统模块（v4.5）
            # ═══════════════════════════════════════════════

            # ── 学生主称号表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS student_titles (
                student_username TEXT PRIMARY KEY,
                title_level INTEGER DEFAULT 1,
                title_name TEXT DEFAULT '初窥门径',
                unlocked_at TEXT,
                updated_at TEXT
            )""")

            # ── 称号升级历史表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS title_upgrade_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_username TEXT NOT NULL,
                old_title TEXT DEFAULT '',
                new_title TEXT NOT NULL,
                title_type TEXT DEFAULT 'main',
                subject TEXT DEFAULT '',
                created_at TEXT NOT NULL
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_tuh_student ON title_upgrade_history(student_username)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_tuh_created ON title_upgrade_history(created_at)")
            except sqlite3.OperationalError:
                pass

            # ── 学生学科称号表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS student_subject_titles (
                student_username TEXT NOT NULL,
                subject TEXT NOT NULL,
                question_count INTEGER DEFAULT 0,
                title_level INTEGER DEFAULT 1,
                title_name TEXT DEFAULT '入门',
                updated_at TEXT,
                PRIMARY KEY (student_username, subject)
            )""")

            # ── 学生成就徽章表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS student_badges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_username TEXT NOT NULL,
                badge_id TEXT NOT NULL,
                badge_name TEXT NOT NULL,
                unlocked_at TEXT NOT NULL,
                UNIQUE(student_username, badge_id)
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_sb_student ON student_badges(student_username)")
            except sqlite3.OperationalError:
                pass

            # ═══════════════════════════════════════════════
            # 考勤统计模块（v4.3）
            # ═══════════════════════════════════════════════

            # ── 登录日志表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS login_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                student_name TEXT DEFAULT '',
                grade TEXT DEFAULT '',
                class_name TEXT DEFAULT '',
                login_time TEXT NOT NULL,
                login_ip TEXT DEFAULT '',
                user_agent TEXT DEFAULT '',
                logout_time TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now', 'localtime'))
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_ll_username ON login_logs(username)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_ll_class ON login_logs(grade, class_name)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_ll_time ON login_logs(login_time)")
            except sqlite3.OperationalError:
                pass

            # ═══════════════════════════════════════════════
            # 知识闯关模块
            # ═══════════════════════════════════════════════

            # ── 闯关记录表（每轮一条） ──
            c.execute("""CREATE TABLE IF NOT EXISTS quest_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_username TEXT NOT NULL,
                total_questions INTEGER DEFAULT 15,
                answered_count INTEGER DEFAULT 0,
                correct_count INTEGER DEFAULT 0,
                score INTEGER DEFAULT 0,
                wrong_question_index INTEGER DEFAULT 0,
                lifelines_used TEXT DEFAULT '[]',
                current_question_index INTEGER DEFAULT 0,
                used_categories TEXT DEFAULT '[]',
                completed INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                completed_at TEXT
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_qr_student ON quest_records(student_username)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_qr_status ON quest_records(student_username, completed)")
            except sqlite3.OperationalError:
                pass

            # ── 闯关题目记录表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS quest_question_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                quest_id INTEGER NOT NULL,
                sort_order INTEGER NOT NULL,
                category TEXT DEFAULT '',
                question_text TEXT NOT NULL,
                options TEXT NOT NULL,
                correct_answer TEXT NOT NULL,
                student_answer TEXT DEFAULT '',
                is_correct INTEGER DEFAULT -1,
                lifeline_used TEXT DEFAULT '',
                time_spent INTEGER DEFAULT 0,
                score INTEGER DEFAULT 0,
                explanation TEXT NOT NULL,
                svg_content TEXT DEFAULT '',
                has_svg INTEGER DEFAULT 0,
                media_files TEXT DEFAULT '',
                media_placeholders TEXT DEFAULT '',
                FOREIGN KEY (quest_id) REFERENCES quest_records(id)
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_qqr_quest ON quest_question_records(quest_id)")
            except sqlite3.OperationalError:
                pass

            # ── 闯关徽章计数表（可重复收集） ──
            c.execute("""CREATE TABLE IF NOT EXISTS quest_badge_counts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_username TEXT NOT NULL UNIQUE,
                total_success_count INTEGER DEFAULT 0,
                updated_at TEXT NOT NULL
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_qbc_student ON quest_badge_counts(student_username)")
            except sqlite3.OperationalError:
                pass

            # ── 闯关题库表（AI 出题持久化，可复用） ──
            c.execute("""CREATE TABLE IF NOT EXISTS quest_question_bank (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category TEXT NOT NULL,
                question_text TEXT NOT NULL UNIQUE,
                options TEXT NOT NULL,
                correct_answer TEXT NOT NULL,
                explanation TEXT NOT NULL,
                used_count INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                svg_content TEXT DEFAULT '',
                has_svg INTEGER DEFAULT 0,
                media_files TEXT DEFAULT '',
                media_placeholders TEXT DEFAULT ''
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_qqb_category ON quest_question_bank(category)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_qqb_used ON quest_question_bank(used_count)")
            except sqlite3.OperationalError:
                pass

            # ── quest_records 增加 use_bank 标记 ──
            try:
                c.execute("ALTER TABLE quest_records ADD COLUMN use_bank INTEGER DEFAULT 0")
            except sqlite3.OperationalError:
                pass

            # ── 闯关题目表媒体字段迁移（兼容旧表） ──
            for col in ['svg_content', 'has_svg', 'media_files', 'media_placeholders']:
                try:
                    if col == 'has_svg':
                        c.execute(f"ALTER TABLE quest_question_records ADD COLUMN {col} INTEGER DEFAULT 0")
                    else:
                        c.execute(f"ALTER TABLE quest_question_records ADD COLUMN {col} TEXT DEFAULT ''")
                except sqlite3.OperationalError:
                    pass
            for col in ['svg_content', 'has_svg', 'media_files', 'media_placeholders']:
                try:
                    if col == 'has_svg':
                        c.execute(f"ALTER TABLE quest_question_bank ADD COLUMN {col} INTEGER DEFAULT 0")
                    else:
                        c.execute(f"ALTER TABLE quest_question_bank ADD COLUMN {col} TEXT DEFAULT ''")
                except sqlite3.OperationalError:
                    pass  # 字段已存在

            # ═══════════════════════════════════════════════
            # 知识抢答活动模块
            # ═══════════════════════════════════════════════

            # ── 抢答活动房间表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS quick_quiz_rooms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_code TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                creator_username TEXT NOT NULL,
                status TEXT DEFAULT 'waiting',
                question_source TEXT DEFAULT 'bank',
                question_count INTEGER DEFAULT 10,
                time_limit INTEGER DEFAULT 15,
                scoring_mode TEXT DEFAULT 'speed',
                min_players INTEGER DEFAULT 2,
                max_players INTEGER DEFAULT 50,
                target_grade TEXT DEFAULT '',
                target_class TEXT DEFAULT '',
                use_ai_generate INTEGER DEFAULT 0,
                subject TEXT DEFAULT '',
                knowledge_points TEXT DEFAULT '',
                difficulty TEXT DEFAULT 'medium',
                created_at TEXT NOT NULL,
                started_at TEXT,
                ended_at TEXT
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_qqr_code ON quick_quiz_rooms(room_code)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_qqr_creator ON quick_quiz_rooms(creator_username)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_qqr_status ON quick_quiz_rooms(status)")
            except sqlite3.OperationalError:
                pass

            # ── 抢答活动参与者表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS quick_quiz_players (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id INTEGER NOT NULL,
                student_username TEXT NOT NULL,
                student_name TEXT DEFAULT '',
                grade TEXT DEFAULT '',
                class_name TEXT DEFAULT '',
                total_score REAL DEFAULT 0,
                correct_count INTEGER DEFAULT 0,
                wrong_count INTEGER DEFAULT 0,
                total_time REAL DEFAULT 0,
                streak INTEGER DEFAULT 0,
                max_streak INTEGER DEFAULT 0,
                joined_at TEXT NOT NULL,
                UNIQUE(room_id, student_username)
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_qqp_room ON quick_quiz_players(room_id)")
            except sqlite3.OperationalError:
                pass

            # ── 抢答活动题目表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS quick_quiz_questions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id INTEGER NOT NULL,
                sort_order INTEGER NOT NULL,
                question_text TEXT NOT NULL,
                options TEXT NOT NULL,
                correct_answer TEXT NOT NULL,
                explanation TEXT DEFAULT '',
                source TEXT DEFAULT 'bank',
                source_question_id INTEGER,
                svg_content TEXT DEFAULT '',
                has_svg INTEGER DEFAULT 0,
                media_files TEXT DEFAULT '',
                media_placeholders TEXT DEFAULT '',
                UNIQUE(room_id, sort_order)
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_qqq_room ON quick_quiz_questions(room_id)")
            except sqlite3.OperationalError:
                pass

            # ── 媒体字段迁移（兼容旧表） ──
            for col in ['svg_content', 'has_svg', 'media_files', 'media_placeholders']:
                try:
                    if col == 'has_svg':
                        c.execute(f"ALTER TABLE quick_quiz_questions ADD COLUMN {col} INTEGER DEFAULT 0")
                    else:
                        c.execute(f"ALTER TABLE quick_quiz_questions ADD COLUMN {col} TEXT DEFAULT ''")
                except sqlite3.OperationalError:
                    pass  # 字段已存在

            # ── 抢答活动答题记录表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS quick_quiz_answers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id INTEGER NOT NULL,
                question_id INTEGER NOT NULL,
                student_username TEXT NOT NULL,
                answer TEXT DEFAULT '',
                is_correct INTEGER DEFAULT -1,
                time_spent REAL DEFAULT 0,
                score REAL DEFAULT 0,
                answered_at TEXT,
                UNIQUE(question_id, student_username)
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_qqa_room ON quick_quiz_answers(room_id)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_qqa_question ON quick_quiz_answers(question_id)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_qqa_student ON quick_quiz_answers(student_username)")
            except sqlite3.OperationalError:
                pass

            # ── 抢答活动排行快照表 ──
            c.execute("""CREATE TABLE IF NOT EXISTS quick_quiz_rankings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id INTEGER NOT NULL,
                round_number INTEGER NOT NULL,
                rankings TEXT NOT NULL,
                created_at TEXT NOT NULL
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_qqr_round ON quick_quiz_rankings(room_id, round_number)")
            except sqlite3.OperationalError:
                pass

            # ═══════════════════════════════════════════════
            # 错题本模块（v5.3）
            # ═══════════════════════════════════════════════

            # ── 错题记录表（精确追踪每道错题） ──
            c.execute("""CREATE TABLE IF NOT EXISTS wrong_book (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_username TEXT NOT NULL,
                question_id INTEGER NOT NULL,
                source TEXT NOT NULL DEFAULT 'exam',
                source_id INTEGER DEFAULT 0,
                knowledge_points TEXT DEFAULT '',
                question_type TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending',
                wrong_answer TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                mastered_at TEXT
            )""")
            try:
                c.execute("CREATE INDEX IF NOT EXISTS idx_wb_student ON wrong_book(student_username)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_wb_question ON wrong_book(question_id)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_wb_kp ON wrong_book(knowledge_points)")
                c.execute("CREATE INDEX IF NOT EXISTS idx_wb_status ON wrong_book(status)")
            except sqlite3.OperationalError:
                pass

            conn.commit()
            logger.debug("数据库初始化完成")

            # ── 自动回填存量数据的 grade_id/class_id ──
            _backfill_grade_class_ids(c)

            # 确保存在默认管理员账号
            _ensure_default_admin()
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
    """执行查询并返回所有结果（返回元组列表）"""
    with get_connection() as conn:
        c = conn.cursor()
        c.execute(sql, params)
        return c.fetchall()


def execute_query_dict(sql: str, params: tuple = ()):
    """执行查询并返回所有结果（返回字典列表，支持按列名访问）"""
    with get_connection() as conn:
        conn.row_factory = sqlite3.Row
        c = conn.cursor()
        c.execute(sql, params)
        rows = c.fetchall()
        return [dict(row) for row in rows]


def execute_query_one(sql: str, params: tuple = ()):
    """执行查询并返回单条结果（字典格式），无结果时返回 None"""
    with get_connection() as conn:
        conn.row_factory = sqlite3.Row
        c = conn.cursor()
        c.execute(sql, params)
        row = c.fetchone()
        return dict(row) if row else None


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


def execute_batch(operations: list[tuple[str, tuple]]):
    """
    批量执行多个写操作，共用同一个事务
    operations: [(sql1, params1), (sql2, params2), ...]
    """
    with get_connection() as conn:
        c = conn.cursor()
        for sql, params in operations:
            c.execute(sql, params)
        conn.commit()


# ── 自动回填 grade_id/class_id ──

def _backfill_grade_class_ids(c):
    """回填存量数据的 grade_id/class_id（幂等，仅在缺失时执行）"""
    try:
        # 1. 学生 users
        c.execute("SELECT COUNT(*) FROM users WHERE grade_id IS NULL AND grade IS NOT NULL AND grade!=''")
        if c.fetchone()[0]:
            c.execute("UPDATE users SET grade_id=(SELECT id FROM grades WHERE name=users.grade) "
                      "WHERE grade_id IS NULL AND grade IS NOT NULL AND grade!=''")
            c.execute("UPDATE users SET class_id=(SELECT c2.id FROM classes c2 JOIN grades g ON c2.grade_id=g.id "
                      "WHERE g.name=users.grade AND (c2.name=users.class||'班' OR c2.name=users.class)) "
                      "WHERE class_id IS NULL AND class IS NOT NULL AND class!=''")
            logger.info("已自动回填 users 表 grade_id/class_id")

        # 2. scores / rollcall 系列表
        for table in ['scores', 'rollcall_weights', 'rollcall_meta', 'rollcall_history']:
            c.execute(f"SELECT COUNT(*) FROM {table} WHERE grade_id IS NULL")
            if c.fetchone()[0]:
                c.execute(f"UPDATE {table} SET grade_id=(SELECT id FROM grades WHERE name={table}.grade) "
                          f"WHERE grade_id IS NULL")
                logger.info(f"已自动回填 {table} 表 grade_id")

        conn = c.connection
        conn.commit()
    except Exception as e:
        logger.warning(f"自动回填 grade_id/class_id 失败: {e}")


# ── 默认管理员账号 ──

def _ensure_default_admin():
    """确保存在默认管理员账号（首次运行时创建）"""
    from backend.auth import hash_password  # 延迟导入，避免循环依赖

    rows = execute_query("SELECT COUNT(*) FROM users WHERE role=0")
    if rows[0][0] == 0:
        hashed = hash_password("root")
        execute_insert_update(
            "INSERT OR IGNORE INTO users (username, password, name, role) VALUES (?, ?, ?, ?)",
            ("root", hashed, "系统管理员", 0),
        )
        logger.info("已创建默认管理员账号: root / root")
