"""
用户管理 API 路由
注册 / 更新 / 改密 / 删除 / 查询 / 导入 / 批量删除
"""
import asyncio
import csv
import io
import json
import os
import re
import shutil
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from backend.database import execute_query, execute_insert_update, execute_batch, get_transaction
from backend.auth import (
    hash_password,
    is_admin,
    is_teacher,
    can_manage_users,
    can_manage_html_files,
    can_import_users,
    increment_token_version,
    remove_active_token_by_username,
)
from backend.api.dependencies import get_current_user
from backend.config import STU_DIR, ROOT_DIR, DATA_DIR
from backend.logger import logger
from backend.permission_service import (
    upsert_grade,
    upsert_class,
    assign_teacher,
    clear_teacher_assignments,
    parse_legacy_teacher_grade_class,
    get_teacher_grades,
    get_teacher_classes,
    get_teacher_subjects,
    is_student_in_teacher_scope,
)
from backend.utils import like_escape

router = APIRouter()


# ── 数据模型 ──

class RegisterRequest(BaseModel):
    username: str
    password: str
    class_val: Optional[str] = ""
    name: Optional[str] = ""
    gender: Optional[int] = 0
    role: Optional[int] = 2  # 默认普通用户
    grade: Optional[str] = ""  # 年级：高一/高二
    subjects: Optional[list[str]] = []  # 教师任教学科


class UpdateUserRequest(BaseModel):
    username: str
    class_val: Optional[str] = ""
    name: Optional[str] = ""
    gender: Optional[int] = 0
    grade: Optional[str] = ""
    subjects: Optional[list[str]] = []  # 教师任教学科



class ChangePasswordRequest(BaseModel):
    username: str
    new_password: str


class BulkDeleteRequest(BaseModel):
    pattern: str
    confirm: bool = False  # 确认删除，防止误操作（false 时只返回匹配预览，绝不删除）
    match_mode: str = "prefix"  # 匹配模式：prefix 前缀 / contains 包含 / exact 精确


# ── 辅助函数 ──

def _normalize_class(cls_val: str) -> str:
    """统一班级格式：去除\"班\"后缀，保留纯数字"""
    if not cls_val:
        return ""
    cls_val = str(cls_val).strip()
    return cls_val.replace("班", "")


def _standardize_gender(gender_value) -> int:
    """标准化性别值"""
    if gender_value is None:
        return 0
    g = str(gender_value).strip()
    if g in ("1", "M", "m", "男"):
        return 1
    return 0


def _standardize_role(role_value) -> int:
    """标准化角色值"""
    if role_value is None:
        return 2
    r = str(role_value).strip()
    if r in ("0", "admin", "管理员"):
        return 0
    if r in ("1", "teacher", "教师"):
        return 1
    return 2


# ── 用户管理权限助手(U-SCOPE) ──

def _caller_role(user: dict) -> int:
    """A2: 中间件已用数据库真值校正过 role, 这里直接采信"""
    return user.get("role", 2)


def _cls_no(v) -> str:
    return str(v if v is not None else "").replace("班", "").strip()


def _teacher_can_assign_class(teacher: str, grade_name: str, class_val: str) -> bool:
    """教师能否在指定年级/班级下建号或改号"""
    grade_name = (grade_name or "").strip()
    if not grade_name:
        return False
    grades = {g["name"]: g["id"] for g in get_teacher_grades(teacher)}
    if grade_name not in grades:
        return False
    allowed = [_cls_no(c["name"]) for c in get_teacher_classes(teacher, grades[grade_name])]
    allowed = [a for a in allowed if a]
    if not allowed:
        return True  # 该年级不限班级
    want = [_cls_no(x) for x in str(class_val or "").replace("，", ",").split("|")[0].split(",") if _cls_no(x)]
    if not want:
        return True
    return all(w in allowed for w in want)


def _assert_can_manage_target(user: dict, target: str, action: str = "管理") -> None:
    """教师可以管用户, 但仅限自己任教范围内的学生; role!=2 的账号只能由管理员动"""
    if _caller_role(user) == 0:
        return
    teacher = user.get("username", "")
    if _caller_role(user) != 1:
        raise HTTPException(status_code=403, detail=f"权限不足：仅管理员或教师可以{action}用户")
    rows = execute_query("SELECT role FROM users WHERE username=?", (target,))
    if not rows:
        raise HTTPException(status_code=404, detail=f"用户 '{target}' 不存在")
    if rows[0][0] != 2:
        raise HTTPException(status_code=403, detail="教师只能管理学生账号，教师与管理员账号请联系管理员")
    if not is_student_in_teacher_scope(target, teacher):
        raise HTTPException(status_code=403, detail=f"该学生不在您的任教范围内，无法{action}")


def _teacher_visibility_filter(teacher: str) -> tuple[str, list]:
    """教师可见记录 = 非学生账号(同事目录) + 自己任教范围内的学生"""
    from backend.permission_service import get_teacher_assignments
    parts: list[str] = []
    params: list = []
    for a in (get_teacher_assignments(teacher) or []):
        gid = a.get("grade_id")
        cid = a.get("class_id")
        if not gid:
            continue
        if cid:
            parts.append("(role=2 AND grade_id=? AND class_id=?)")
            params.extend([gid, cid])
        else:
            parts.append("(role=2 AND grade_id=?)")
            params.append(gid)
    if not parts:
        return "role IN (0,1)", []
    return "role IN (0,1) OR " + " OR ".join(parts), params


def _scoped_usernames_for_teacher(teacher: str) -> set[str]:
    """教师可见/可管的学生用户名集合"""
    rows = execute_query("SELECT username FROM users WHERE role=2")
    return {r[0] for r in rows if is_student_in_teacher_scope(r[0], teacher)}


# ── 批量删除：用户名匹配辅助 ──

_BULK_MATCH_MODES = {"prefix", "contains", "exact"}
_MATCH_MODE_LABELS = {"prefix": "前缀匹配", "contains": "包含匹配", "exact": "精确匹配"}
_DELETE_FROM_RE = re.compile(r"^\s*DELETE\s+FROM\s+([A-Za-z0-9_]+)", re.IGNORECASE)
_main_tables_cache: Optional[frozenset] = None


def _normalize_match_mode(mode: Optional[str]) -> str:
    """规范化匹配模式，未知取值回退为最安全的前缀匹配"""
    m = (mode or "prefix").strip().lower()
    return m if m in _BULK_MATCH_MODES else "prefix"


def _username_condition(pattern: str, match_mode: str) -> tuple[str, tuple]:
    """按匹配模式构造用户名匹配条件与查询参数"""
    if match_mode == "exact":
        return "username = ?", (pattern,)
    if match_mode == "contains":
        return "username LIKE ?", (f"%{pattern}%",)
    return "username LIKE ?", (f"{pattern}%",)


def _find_bulk_delete_targets(pattern: str, match_mode: str) -> tuple[list[str], int]:
    """返回 (可删除用户名列表, 被跳过的管理员账号数量)"""
    cond, cond_params = _username_condition(pattern, match_mode)
    rows = execute_query(f"SELECT username, role FROM users WHERE {cond}", cond_params)
    users = [r[0] for r in rows if r[1] != 0]
    return users, len(rows) - len(users)


def _delete_target_table(sql: str) -> str:
    """取出 DELETE 语句的目标表名（用于跳过不存在的表）"""
    m = _DELETE_FROM_RE.match(sql)
    return m.group(1).lower() if m else ""


def _main_table_names() -> frozenset:
    """主库现有表名集合（进程内缓存，建表仅发生在启动初始化阶段）"""
    global _main_tables_cache
    if _main_tables_cache is None:
        try:
            rows = execute_query("SELECT name FROM sqlite_master WHERE type='table'")
            _main_tables_cache = frozenset(r[0].lower() for r in rows)
        except Exception as e:
            logger.warning(f"读取表名列表失败，跳过表存在性检查: {e}")
            _main_tables_cache = frozenset()
    return _main_tables_cache


# ── 彻底删除用户（数据库 + 文件系统） ──

def _delete_user_completely(username: str):
    """
    彻底删除用户的所有相关数据：
    1. 删除用户文件目录（stu/<username> 或 <username>）
    2. 删除数据库中所有与该用户相关的记录
    """
    # 1. 删除用户文件目录
    user_dir = os.path.join(DATA_DIR, STU_DIR, username)
    alt_dir = os.path.join(DATA_DIR, username)
    for d in [user_dir, alt_dir]:
        if os.path.isdir(d):
            try:
                shutil.rmtree(d)
                logger.info(f"已删除用户目录: {d}")
            except Exception as e:
                logger.warning(f"删除用户目录失败 {d}: {e}")

    # 获取用户姓名（用于清理 scores/rollcall 等以姓名为标识的记录）
    name_rows = execute_query("SELECT name FROM users WHERE username=?", (username,))
    student_name = name_rows[0][0] if name_rows else ""

    # 2. 先获取资源分组ID（用于级联删除分组项）
    group_ids = execute_query(
        "SELECT id FROM resource_groups WHERE username=?", (username,)
    )
    group_id_list = [g[0] for g in group_ids] if group_ids else []

    # 3. 删除数据库中所有与该用户相关的记录（使用事务）
    delete_ops = [
        # 以 username 为直接标识的表
        ("DELETE FROM daily_usage WHERE username=?", (username,)),
        ("DELETE FROM conversations WHERE username=?", (username,)),
        ("DELETE FROM notifications WHERE recipient_username=?", (username,)),
        ("DELETE FROM discussion_members WHERE username=?", (username,)),
        ("DELETE FROM discussion_messages WHERE username=?", (username,)),
        ("DELETE FROM discussion_reports WHERE discussion_id IN (SELECT id FROM discussions WHERE creator_username=?)", (username,)),
        ("DELETE FROM interaction_quiz_answers WHERE student_username=?", (username,)),
        ("DELETE FROM interaction_poll_votes WHERE student_username=?", (username,)),
        ("DELETE FROM interaction_questions WHERE student_username=?", (username,)),
        ("DELETE FROM interaction_question_answers WHERE student_username=?", (username,)),
        ("DELETE FROM learning_progress WHERE student_username=?", (username,)),
        ("DELETE FROM task_submissions WHERE student_username=?", (username,)),
        ("DELETE FROM task_grades WHERE student_username=?", (username,)),
        ("DELETE FROM practice_attempts WHERE student_username=?", (username,)),
        # 智能练习：教师创建的练习任务
        ("DELETE FROM practice_session_questions WHERE session_id IN (SELECT id FROM practice_sessions WHERE creator_username=?)", (username,)),
        ("DELETE FROM practice_sessions WHERE creator_username=?", (username,)),
        ("DELETE FROM activity_rewards WHERE student_username=?", (username,)),
        ("DELETE FROM student_total_points WHERE student_username=?", (username,)),
        ("DELETE FROM student_titles WHERE student_username=?", (username,)),
        ("DELETE FROM title_upgrade_history WHERE student_username=?", (username,)),
        ("DELETE FROM student_subject_titles WHERE student_username=?", (username,)),
        ("DELETE FROM student_badges WHERE student_username=?", (username,)),
        ("DELETE FROM login_logs WHERE username=?", (username,)),
        # 资源查看日志
        ("DELETE FROM resource_view_logs WHERE student_username=?", (username,)),
        ("DELETE FROM resource_view_logs WHERE owner_username=?", (username,)),
        # 以 username 为创建者/拥有者的表
        # 先清理共享资源关联的课程绑定
        ("DELETE FROM curriculum_bindings WHERE resource_id IN (SELECT id FROM shared_resources WHERE owner_username=?)", (username,)),
        ("DELETE FROM shared_resources WHERE owner_username=?", (username,)),
        # 先删 task_grades 子表，再删 tasks 父表（顺序不可颠倒）
        ("DELETE FROM task_grades WHERE task_id IN (SELECT id FROM tasks WHERE creator_username=?)", (username,)),
        ("DELETE FROM tasks WHERE creator_username=?", (username,)),
        ("DELETE FROM announcements WHERE creator_username=?", (username,)),
        ("DELETE FROM interaction_quizzes WHERE creator_username=?", (username,)),
        ("DELETE FROM interaction_polls WHERE creator_username=?", (username,)),
        ("DELETE FROM discussions WHERE creator_username=?", (username,)),
        # 知识闯关（quest）
        ("DELETE FROM quest_question_records WHERE quest_id IN (SELECT id FROM quest_records WHERE student_username=?)", (username,)),
        ("DELETE FROM quest_records WHERE student_username=?", (username,)),
        ("DELETE FROM quest_badge_counts WHERE student_username=?", (username,)),
        # quest_question_bank 没有 creator_username 列，创建题目时不追踪创建者，故不删除
        # 知识抢答（quick_quiz）
        ("DELETE FROM quick_quiz_answers WHERE student_username=?", (username,)),
        ("DELETE FROM quick_quiz_players WHERE student_username=?", (username,)),
        ("DELETE FROM quick_quiz_rankings WHERE room_id IN (SELECT id FROM quick_quiz_rooms WHERE creator_username=?)", (username,)),
        ("DELETE FROM quick_quiz_questions WHERE room_id IN (SELECT id FROM quick_quiz_rooms WHERE creator_username=?)", (username,)),
        ("DELETE FROM quick_quiz_rooms WHERE creator_username=?", (username,)),
        # 教师相关数据（积分、点名等）
        ("DELETE FROM scores WHERE teacher_username=?", (username,)),
        ("DELETE FROM rollcall_weights WHERE teacher_username=?", (username,)),
        ("DELETE FROM rollcall_meta WHERE teacher_username=?", (username,)),
        ("DELETE FROM rollcall_history WHERE teacher_username=?", (username,)),
        # 学生作为被积分/点名对象（student_name TEXT 匹配，已移至下方条件追加）
        # 自我画像数据
        ("DELETE FROM portrait_likes WHERE portrait_id IN (SELECT id FROM student_portraits WHERE username=?)", (username,)),
        ("DELETE FROM student_portraits WHERE username=?", (username,)),
        # 荣耀殿堂展示墙数据
        ("DELETE FROM showcase_likes WHERE showcase_id IN (SELECT id FROM student_showcase WHERE student_username=?)", (username,)),
        ("DELETE FROM showcase_view_logs WHERE showcase_id IN (SELECT id FROM student_showcase WHERE student_username=?)", (username,)),
        ("DELETE FROM student_showcase WHERE student_username=?", (username,)),
        ("DELETE FROM showcase_likes WHERE username=?", (username,)),
        ("DELETE FROM showcase_view_logs WHERE username=?", (username,)),
        # 学伴数据
        ("DELETE FROM ai_companion_config WHERE username=?", (username,)),
        ("DELETE FROM ai_companion_memory WHERE student_username=?", (username,)),
        ("DELETE FROM ai_companion_push_log WHERE student_username=?", (username,)),
        # 错题本
        ("DELETE FROM wrong_book WHERE student_username=?", (username,)),
        # 每日精选
        ("DELETE FROM discovery_viewed WHERE username=?", (username,)),
        ("DELETE FROM discovery_view_log WHERE username=?", (username,)),
        ("DELETE FROM discovery_favorites WHERE username=?", (username,)),
        ("DELETE FROM discovery_daily_stats WHERE username=?", (username,)),
        ("DELETE FROM discovery_refresh_cards WHERE username=?", (username,)),
        # 热点新闻
        ("DELETE FROM news_view_log WHERE username=?", (username,)),
        ("DELETE FROM news_favorites WHERE username=?", (username,)),
        ("DELETE FROM news_daily_stats WHERE username=?", (username,)),
        # 协作白板：先清理用户在他人房间的痕迹，再删除自己创建的房间
        ("DELETE FROM whiteboard_operations WHERE username=?", (username,)),
        ("DELETE FROM whiteboard_room_members WHERE username=?", (username,)),
        ("DELETE FROM whiteboard_rooms WHERE creator_username=?", (username,)),
        # 讨论组子表（需先于 discussions 删除）
        ("DELETE FROM discussion_groups WHERE discussion_id IN (SELECT id FROM discussions WHERE creator_username=?)", (username,)),
    ]
    # 删除资源分组项
    for gid in group_id_list:
        delete_ops.append(("DELETE FROM resource_group_items WHERE group_id=?", (gid,)))
    delete_ops.append(("DELETE FROM resource_groups WHERE username=?", (username,)))
    # 仅当 student_name 非空时才按姓名匹配删除，避免空字符串误删他人记录
    if student_name:
        delete_ops.append(("DELETE FROM scores WHERE student_name=?", (student_name,)))
        delete_ops.append(("DELETE FROM rollcall_weights WHERE student_name=?", (student_name,)))
        delete_ops.append(("DELETE FROM rollcall_history WHERE student_name=?", (student_name,)))
    # 教师任教关系
    delete_ops.append(("DELETE FROM teacher_assignments WHERE teacher_username=?", (username,)))
    # 最后删除用户本身
    delete_ops.append(("DELETE FROM users WHERE username=?", (username,)))

    # 先按表存在性过滤（老版本库可能缺表），再放进单个事务一次性提交。
    # 原来每条语句单独开连接提交，删除上千个用户时会慢几十倍。
    existing_tables = _main_table_names()
    ops = []
    for sql, params in delete_ops:
        table = _delete_target_table(sql)
        if existing_tables and table and table not in existing_tables:
            logger.debug(f"表不存在，跳过删除: {table}")
            continue
        ops.append((sql, params))

    try:
        execute_batch(ops)
    except Exception as bulk_err:
        # 整体事务失败（例如列不存在）时回退为逐条执行，尽量把数据删干净
        logger.warning(f"批量删除事务失败，回退逐条执行: {bulk_err}")
        for sql, params in ops:
            try:
                execute_batch([(sql, params)])
            except Exception as e:
                logger.warning(f"删除操作跳过（表或列不存在）: {sql[:80]}... - {e}")

    # 4. 删除 questions.db 中的考试、练习、题库等记录（共用一个连接和一个事务）
    try:
        from backend.question_db import get_connection as q_get_connection

        q_ops = [
            ("DELETE FROM exam_attempts WHERE student_username=?", (username,)),
            ("DELETE FROM code_submissions WHERE student_username=?", (username,)),
            # 教师创建的代码题（先删关联的测试用例和运行记录）
            ("DELETE FROM code_test_cases WHERE problem_id IN (SELECT id FROM code_problems WHERE creator_username=?)", (username,)),
            ("DELETE FROM code_runs WHERE problem_id IN (SELECT id FROM code_problems WHERE creator_username=?)", (username,)),
            ("DELETE FROM code_problems WHERE creator_username=?", (username,)),
            ("DELETE FROM ai_practice_results WHERE student_username=?", (username,)),
            # 教师创建的考试（先删关联的 exam_questions）
            ("DELETE FROM exam_questions WHERE exam_id IN (SELECT id FROM exams WHERE creator_username=?)", (username,)),
            ("DELETE FROM exams WHERE creator_username=?", (username,)),
            # 教师创建的题库题目
            ("DELETE FROM question_bank WHERE creator_username=?", (username,)),
            # 教师创建的智能练习（先删关联题目，再删练习记录）
            ("DELETE FROM practice_session_questions WHERE session_id IN (SELECT id FROM practice_sessions WHERE creator_username=?)", (username,)),
            ("DELETE FROM practice_attempts WHERE session_id IN (SELECT id FROM practice_sessions WHERE creator_username=?)", (username,)),
            ("DELETE FROM practice_sessions WHERE creator_username=?", (username,)),
            # 学生答题记录（与教师创建的练习独立）
            ("DELETE FROM practice_attempts WHERE student_username=?", (username,)),
        ]
        with q_get_connection() as q_conn:
            q_cur = q_conn.cursor()
            q_tables = frozenset(
                r[0].lower()
                for r in q_cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
            )
            for sql, params in q_ops:
                table = _delete_target_table(sql)
                if q_tables and table and table not in q_tables:
                    continue
                try:
                    q_cur.execute(sql, params)
                except Exception as e:
                    logger.warning(f"questions.db 删除跳过: {sql[:60]}... - {e}")
            q_conn.commit()
    except Exception as e:
        logger.warning(f"删除 questions.db 记录失败: {e}")

    logger.info(f"用户 '{username}' 的所有数据库记录已清除")


# ── API 端点 ──

@router.post("/register")
async def register_user(req: RegisterRequest, request: Request):
    """注册新用户（管理员和教师均可）"""
    current_user = get_current_user(request)
    if not can_manage_users(current_user["username"]) and not is_teacher(current_user["username"]):
        raise HTTPException(status_code=403, detail="权限不足：仅管理员或教师可以注册用户")

    username = req.username.strip()
    password = req.password.strip()

    if not username or not password:
        raise HTTPException(status_code=400, detail="用户名和密码不能为空")

    # 检查用户是否已存在
    existing = execute_query("SELECT username FROM users WHERE username=?", (username,))
    if existing:
        raise HTTPException(status_code=400, detail=f"用户 '{username}' 已存在")

    hashed = hash_password(password)
    gender_num = _standardize_gender(req.gender)
    role_num = _standardize_role(req.role)

    # U-SCOPE: 教师可建号, 但只能建自己任教范围内的学生, 且不能造出教师/管理员
    if _caller_role(current_user) != 0:
        if role_num != 2:
            raise HTTPException(status_code=403, detail="教师只能创建学生账号，创建教师/管理员请联系管理员")
        if not _teacher_can_assign_class(current_user["username"], req.grade or "", req.class_val or ""):
            raise HTTPException(status_code=403, detail="只能在本人任教范围内的年级班级建号")

    try:
        # 解析年级/班级 ID
        grade_id = None
        class_id = None
        grade_val = req.grade or ""
        class_val = _normalize_class(req.class_val or "")

        if grade_val and role_num == 2:  # 学生：单个年级 + 单个班级
            grade_id = upsert_grade(grade_val.strip())
            if class_val:
                cls_name = class_val.strip()
                if "班" not in cls_name:
                    cls_name = f"{cls_name}班"
                class_id = upsert_class(grade_id, cls_name)

        execute_insert_update(
            "INSERT INTO users (username, password, class, name, gender, role, grade, grade_id, class_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (username, hashed, class_val, req.name, gender_num, role_num, grade_val, grade_id, class_id),
        )

        # 教师：解析多年级多班级并写入 teacher_assignments
        if role_num == 1 and grade_val:
            subj_list = req.subjects or []
            gcm = parse_legacy_teacher_grade_class(grade_val, class_val)
            for g_name, cls_names in gcm.items():
                gid = upsert_grade(g_name)
                assert gid is not None
                for subj in subj_list:
                    if not cls_names:
                        assign_teacher(username, gid, None, subj)  # type: ignore[arg-type]
                    else:
                        for cn in cls_names:
                            if "班" not in cn:
                                cn = f"{cn}班"
                            cid = upsert_class(gid, cn)
                            assign_teacher(username, gid, cid, subj)

        logger.info(f"用户注册成功: {username}")
        return {"message": f"用户 '{username}' 注册成功"}
    except Exception as e:
        logger.error(f"用户注册失败: {e}")
        raise HTTPException(status_code=500, detail=f"注册失败: {str(e)}")


@router.put("/update")
async def update_user_info(req: UpdateUserRequest, request: Request):
    """更新用户信息（管理员和教师均可）"""
    current_user = get_current_user(request)
    username = req.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="用户名不能为空")

    existing = execute_query(
        "SELECT username, role, grade, class FROM users WHERE username=?", (username,)
    )
    if not existing:
        raise HTTPException(status_code=404, detail=f"用户 '{username}' 不存在")

    # U-SCOPE: 管理员不限; 教师可改自己(仅限姓名/性别, 任教范围不得自改)或自己范围内的学生
    if _caller_role(current_user) == 1 and username == current_user["username"]:
        old_grade = existing[0][2] or ""
        old_class = str(existing[0][3] or "")
        if (req.grade or "") != old_grade or _normalize_class(req.class_val or "") != _normalize_class(old_class):
            raise HTTPException(status_code=403, detail="任教范围只能由管理员调整")
    else:
        _assert_can_manage_target(current_user, username, "更新")

    gender_num = _standardize_gender(req.gender)
    class_val = _normalize_class(req.class_val or "")
    grade_val = req.grade or ""
    role_rows = execute_query("SELECT role FROM users WHERE username=?", (username,))
    role_num = role_rows[0][0] if role_rows else 2

    try:
        # 解析新 FK 值
        grade_id = None
        class_id = None
        if grade_val and role_num == 2:  # 学生
            grade_id = upsert_grade(grade_val.strip())
            if class_val:
                cls_name = class_val
                if "班" not in cls_name:
                    cls_name = f"{cls_name}班"
                class_id = upsert_class(grade_id, cls_name)

        execute_insert_update(
            "UPDATE users SET class=?, name=?, gender=?, grade=?, grade_id=?, class_id=? WHERE username=?",
            (class_val, req.name, gender_num, grade_val, grade_id, class_id, username),
        )

        # 教师：重建 teacher_assignments
        # U5: 旧实现"先清空, 再仅按请求里的 subjects 重建", 于是任何不带 subjects 字段的
        #     局部更新都会把该教师的任教范围整体清空(实测一次即让一位教师失去全部 13 条授权),
        #     表现为他在积分/资源/点名/展示卡等所有模块里突然看不到自己的学生。
        if role_num == 1 and grade_val:
            subj_list = req.subjects if req.subjects else list(get_teacher_subjects(username) or [])
            gcm = parse_legacy_teacher_grade_class(grade_val, class_val)
            pending: list[tuple] = []
            for g_name, cls_names in gcm.items():
                gid = upsert_grade(g_name)
                if gid is None:
                    continue
                for subj in (subj_list or [None]):
                    if not cls_names:
                        pending.append((gid, None, subj))
                    else:
                        for cn in cls_names:
                            if "班" not in cn:
                                cn = f"{cn}班"
                            pending.append((gid, upsert_class(gid, cn), subj))
            if not pending:
                raise HTTPException(status_code=400, detail="任教范围解析为空，已保留原有任教范围")
            clear_teacher_assignments(username)
            for gid, cid, subj in pending:
                assign_teacher(username, gid, cid, subj)  # type: ignore[arg-type]

        logger.info(f"用户信息已更新: {username}")
        return {"message": f"用户 '{username}' 信息已更新"}
    except Exception as e:
        logger.error(f"更新用户信息失败: {e}")
        raise HTTPException(status_code=500, detail=f"更新失败: {str(e)}")


@router.put("/password")
async def change_password(req: ChangePasswordRequest, request: Request):
    """修改密码（管理员可改任何用户，普通用户仅改自己）"""
    current_user = get_current_user(request)
    current_username = current_user["username"]

    username = req.username.strip()
    new_password = req.new_password.strip()

    if not username or not new_password:
        raise HTTPException(status_code=400, detail="用户名和新密码不能为空")

    # U-PWD: 以角色判定管理员(旧实现把管理员用户名写死成 "root", 换部署即失效)
    is_admin_caller = _caller_role(current_user) == 0
    if not is_admin_caller and username != current_username:
        raise HTTPException(status_code=403, detail="权限不足：只能修改自己的密码")

    hashed = hash_password(new_password)

    try:
        execute_insert_update(
            "UPDATE users SET password=? WHERE username=?",
            (hashed, username),
        )
        # U-PWD: 管理员代改他人密码后, 让对方已有的会话立即失效(自己改密则不断线, 避免正在用的窗口被踢)
        if is_admin_caller and username != current_username:
            increment_token_version(username)
            remove_active_token_by_username(username)
        logger.info(f"密码已修改: {username}")
        return {"message": f"用户 '{username}' 密码已修改"}
    except Exception as e:
        logger.error(f"修改密码失败: {e}")
        raise HTTPException(status_code=500, detail=f"修改密码失败: {str(e)}")


@router.delete("/{username}")
async def delete_user(username: str, request: Request):
    """彻底删除用户及其所有相关数据（管理员和教师均可）"""
    current_user = get_current_user(request)

    # 禁止删除任何管理员账号（role=0）
    rows = execute_query("SELECT username, role FROM users WHERE username=?", (username,))
    if not rows:
        raise HTTPException(status_code=404, detail=f"用户 '{username}' 不存在")
    if rows[0][1] == 0:
        raise HTTPException(status_code=400, detail="不能删除管理员账号")
    if username == current_user.get("username"):
        raise HTTPException(status_code=400, detail="不能删除自己的账号")
    # U-SCOPE: 管理员可删任何非管理员账号; 教师只能删自己任教范围内的学生
    _assert_can_manage_target(current_user, username, "删除")

    try:
        remove_active_token_by_username(username)
        _delete_user_completely(username)
        logger.info(f"用户已彻底删除: {username}")
        return {"message": f"用户 '{username}' 已彻底删除"}
    except Exception as e:
        logger.error(f"删除用户失败: {e}")
        raise HTTPException(status_code=500, detail=f"删除失败: {str(e)}")


@router.get("/export")
async def export_users(request: Request, keyword: Optional[str] = None):
    """导出用户为 CSV 文件"""
    current_user = get_current_user(request)
    if _caller_role(current_user) == 2:
        raise HTTPException(status_code=403, detail="权限不足：仅管理员或教师可以导出用户")

    conds, params = [], []
    if keyword and keyword.strip():
        kw = f"%{like_escape(keyword.strip())}%"
        conds.append("(username LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')")
        params.extend([kw, kw])
    if _caller_role(current_user) == 1:
        # U-SCOPE: 教师导出同样限定在任教范围内(同事目录一并保留, 便于分享对象选择)
        scope_sql, scope_params = _teacher_visibility_filter(current_user["username"])
        conds.append("(" + scope_sql + ")")
        params.extend(scope_params)
    where = " WHERE " + " AND ".join(conds) if conds else ""
    rows = execute_query(
        "SELECT username, class, name, gender, role, grade FROM users" + where + " ORDER BY username",
        tuple(params),
    )

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["用户名", "姓名", "性别", "角色", "年级", "班级", "任教学科"])

    for username, class_val, name_val, gender_val, role_val, grade_val in rows:
        role_name = {0: "管理员", 1: "教师", 2: "普通用户"}.get(role_val, "普通用户")
        gender_name = "男" if gender_val == 1 else "女" if gender_val == 0 else ""
        subjects_str = ""
        if role_val in (0, 1):
            from backend.permission_service import get_teacher_subjects
            subjects = get_teacher_subjects(username)
            if role_val == 0:
                subjects_str = "全部学科"
            elif subjects:
                subjects_str = "、".join(subjects)
        writer.writerow([username, name_val or "", gender_name, role_name, grade_val or "", class_val or "", subjects_str])

    csv_bytes = output.getvalue().encode('utf-8-sig')
    output.close()

    return StreamingResponse(
        iter([csv_bytes]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=users_export.csv"},
    )


@router.get("/{username}")
async def get_user_info(username: str, request: Request):
    """查询用户信息(U-SCOPE: 本人或管理员不限; 教师限自己任教范围内的学生)"""
    current_user = get_current_user(request)
    if _caller_role(current_user) != 0 and username != current_user.get("username", ""):
        _assert_can_manage_target(current_user, username, "查看")

    rows = execute_query(
        "SELECT username, class, name, gender, role, grade FROM users WHERE username=?",
        (username,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail=f"用户 '{username}' 不存在")

    username, class_val, name_val, gender_val, role_val, grade_val = rows[0]
    role_name = {0: "管理员", 1: "教师", 2: "普通用户"}.get(role_val, "普通用户")
    gender_name = "男" if gender_val == 1 else "女" if gender_val == 0 else ""

    # 获取教师/管理员的任教学科
    subjects = []
    if role_val in (0, 1):
        from backend.permission_service import get_teacher_subjects
        subjects = get_teacher_subjects(username)

    return {
        "username": username,
        "class": class_val,
        "name": name_val,
        "gender": gender_name,
        "role": role_val,
        "role_name": role_name,
        "grade": grade_val or "",
        "subjects": subjects,
    }


@router.get("")
async def get_all_users(
    request: Request,
    keyword: Optional[str] = None,
    page: int = Query(0, ge=0, description="0 表示不分页(默认, 兼容旧前端); >0 时按分页返回"),
    page_size: int = Query(200, ge=1, le=500, description="分页大小, 上限 500"),
):
    """查看所有用户，支持按用户名/姓名模糊搜索

    U-SCOPE: 学生不再可见(旧实现只需登录即可导出全校 1410 个账号的姓名/班级/年级/角色);
    教师仅能看到同事目录 + 自己任教范围内的学生; 管理员不限。
    """
    current_user = get_current_user(request)
    caller_role = _caller_role(current_user)
    if caller_role == 2:
        raise HTTPException(status_code=403, detail="权限不足：仅管理员或教师可以查看用户列表")

    conds = ["(username LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')"] if (keyword and keyword.strip()) else []
    params: list = []
    if conds:
        kw = f"%{like_escape(keyword.strip())}%"
        params = [kw, kw]
    if caller_role == 1:
        scope_sql, scope_params = _teacher_visibility_filter(current_user["username"])
        conds.append("(" + scope_sql + ")")
        params.extend(scope_params)
    where = " WHERE " + " AND ".join(conds) if conds else ""
    sql = "SELECT username, class, name, gender, role, grade FROM users" + where + " ORDER BY username"
    limit_sql = ""
    if page > 0:
        limit_sql = " LIMIT ? OFFSET ?"
        params.extend([page_size, (page - 1) * page_size])
    rows = execute_query(sql + limit_sql, tuple(params))
    users = []
    for username, class_val, name_val, gender_val, role_val, grade_val in rows:
        role_name = {0: "管理员", 1: "教师", 2: "普通用户"}.get(role_val, "普通用户")
        gender_name = "男" if gender_val == 1 else "女" if gender_val == 0 else ""
        # 获取教师/管理员的任教学科
        subjects = []
        if role_val in (0, 1):
            from backend.permission_service import get_teacher_subjects
            subjects = get_teacher_subjects(username)
        users.append({
            "username": username,
            "class": class_val,
            "name": name_val,
            "gender": gender_name,
            "role": role_name,
            "grade": grade_val or "",
            "subjects": subjects,
        })

    return {"users": users, "total": len(users)}


@router.post("/bulk-delete/preview")
async def preview_bulk_delete_users(req: BulkDeleteRequest, request: Request):
    """批量删除预览：只统计匹配用户并返回样例，不做任何删除，供前端二次确认"""
    current_user = get_current_user(request)
    # U-SCOPE: 批量删除按用户名模式匹配, 教师一旦可用即可一次抹掉全校学生
    # (实测 pattern="s" 前缀匹配命中 1406 人), 而前端本就把这块标成"仅管理员可用"
    if _caller_role(current_user) != 0:
        raise HTTPException(status_code=403, detail="权限不足：批量删除仅限管理员使用")

    pattern = req.pattern.strip()
    if not pattern:
        raise HTTPException(status_code=400, detail="请提供要删除的用户名模式")

    match_mode = _normalize_match_mode(req.match_mode)
    users, skipped_admins = _find_bulk_delete_targets(pattern, match_mode)
    return {
        "pattern": pattern,
        "match_mode": match_mode,
        "match_mode_label": _MATCH_MODE_LABELS[match_mode],
        "matched_count": len(users),
        "preview": users[:10],
        "skipped_admin_count": skipped_admins,
        "message": f"模式 '{pattern}'（{_MATCH_MODE_LABELS[match_mode]}）匹配 {len(users)} 个用户"
        + (f"，另有 {skipped_admins} 个管理员账号不会被删除" if skipped_admins else ""),
    }


@router.post("/bulk-delete")
async def bulk_delete_users(req: BulkDeleteRequest, request: Request):
    """批量彻底删除用户（按用户名模式匹配，跳过管理员账号，SSE 流式进度）

    安全约定：必须显式传 confirm=true 才会真正删除。confirm=false 时返回 400 且
    detail 为结构化对象（含 matched_count / preview），前端应先调用
    /bulk-delete/preview 展示确认框，用户确认后再以 confirm=true 重发本接口。
    """
    current_user = get_current_user(request)
    if _caller_role(current_user) != 0:
        raise HTTPException(status_code=403, detail="权限不足：批量删除仅限管理员使用")

    pattern = req.pattern.strip()
    if not pattern:
        raise HTTPException(status_code=400, detail="请提供要删除的用户名模式")

    match_mode = _normalize_match_mode(req.match_mode)
    all_users, skipped_admins = _find_bulk_delete_targets(pattern, match_mode)
    total = len(all_users)

    if not req.confirm:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "need_confirm",
                "code": "BULK_DELETE_NEED_CONFIRM",
                "message": f"模式 '{pattern}'（{_MATCH_MODE_LABELS[match_mode]}）匹配 {total} 个用户，"
                f"前 {min(total, 10)} 个: {all_users[:10]}。请确认后以 confirm=true 重新提交",
                "matched_count": total,
                "preview": all_users[:10],
                "skipped_admin_count": skipped_admins,
            },
        )

    async def event_generator():
        yield "data: {}\n\n".format(json.dumps(
            {
                'type': 'start',
                'total': total,
                'pattern': pattern,
                'match_mode': match_mode,
                'skipped_admin_count': skipped_admins,
            },
            ensure_ascii=False,
        ))

        if total == 0:
            yield "data: {}\n\n".format(json.dumps(
                {'type': 'done', 'deleted': 0, 'error_count': 0, 'errors': [], 'message': '没有匹配的用户'},
                ensure_ascii=False,
            ))
            return

        # 用户很多时按批次回报进度，避免上千条 SSE 事件拖慢前端渲染
        step = 1 if total <= 50 else max(1, total // 100)
        deleted_count = 0
        error_list: list[str] = []

        for i, username in enumerate(all_users):
            try:
                # 放入线程池执行，避免删除耗时阻塞事件循环导致进度长时间不动
                await asyncio.to_thread(_delete_user_completely, username)
                deleted_count += 1
            except Exception as e:
                error_list.append(f"用户 '{username}': {str(e)}")
                logger.error(f"批量删除用户 '{username}' 失败: {e}")

            done_so_far = i + 1
            if done_so_far % step == 0 or done_so_far == total:
                progress_data = {
                    'type': 'progress',
                    'current': done_so_far,
                    'total': total,
                    'deleted': deleted_count,
                    'error_count': len(error_list),
                    'percent': round(done_so_far / total * 100, 1),
                }
                yield f"data: {json.dumps(progress_data, ensure_ascii=False)}\n\n"

        logger.info(
            f"批量删除用户: pattern={pattern}, mode={match_mode}, "
            f"deleted={deleted_count}, errors={len(error_list)}, skipped_admins={skipped_admins}"
        )
        done_msg = (
            f"成功删除 {deleted_count} 个用户，{len(error_list)} 个错误"
            if error_list else f"成功删除 {deleted_count} 个用户"
        )
        done_data = {
            'type': 'done',
            'deleted': deleted_count,
            'error_count': len(error_list),
            'errors': error_list[:50],
            'message': done_msg,
        }
        yield f"data: {json.dumps(done_data, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/import")
async def import_users(file: UploadFile = File(...), request: Request = None):  # type: ignore[assignment]
    """CSV 批量导入用户（流式进度返回）"""
    if request:
        current_user = get_current_user(request)
        if not can_import_users(current_user["username"]):
            raise HTTPException(status_code=403, detail="权限不足：仅管理员或教师可以导入用户")

    if not (file.filename or "").endswith(".csv"):
        raise HTTPException(status_code=400, detail="请上传 CSV 文件")

    content = await file.read()

    # 尝试多种编码
    content_str = None
    for encoding in ["utf-8-sig", "utf-8", "gbk", "gb2312"]:
        try:
            content_str = content.decode(encoding)
            break
        except (UnicodeDecodeError, LookupError):
            continue
    if content_str is None:
        raise HTTPException(status_code=400, detail="无法解析 CSV 文件编码")

    reader = csv.DictReader(io.StringIO(content_str))
    rows = list(reader)
    total = len(rows)

    async def event_generator():
        imported = 0
        errors = []
        # U-SCOPE: 记录本次导入者身份与是否管理员(CSV 的 role 列对教师一律降级为学生)
        importer_name = current_user["username"]
        is_admin_importer = _caller_role(current_user) == 0
        role_clamped = 0

        # 发送开始事件
        yield f"data: {json.dumps({'type': 'start', 'total': total}, ensure_ascii=False)}\n\n"

        # 预解析所有年级/班级名称，构建缓存
        grade_cache: dict[str, int] = {}   # grade_name → grade_id
        class_cache: dict[tuple[int, str], int] = {}  # (grade_id, class_name) → class_id
        for row in rows:
            grade_val = row.get("grade", "").strip()
            if grade_val:
                for g_name in grade_val.split("|"):
                    g_name = g_name.strip()
                    if g_name and g_name not in grade_cache:
                        grade_cache[g_name] = upsert_grade(g_name)
            class_val = row.get("class", "").strip()
            if class_val:
                # 解析班级名（可能包含管道分隔）
                class_groups = [c.strip() for c in class_val.split("|")] if "|" in class_val else [class_val]
                for cg in class_groups:
                    for cn in cg.split(","):
                        cn = cn.strip()
                        if not cn:
                            continue
                        if "班" not in cn:
                            cn = f"{cn}班"
                        # 需要知道 grade_id，但这里不好推断...
                        # 对班级做宽松处理：导入时先按名称创建，grade_id 绑定在事务中处理

        # 在单一事务中执行所有数据库操作
        with get_transaction() as conn:
            cursor = conn.cursor()

            for row_num, row in enumerate(rows, start=2):
                try:
                    username = row.get("username", "").strip()
                    password = row.get("password", "").strip()
                    if not username or not password:
                        errors.append(f"第{row_num}行：用户名或密码为空")
                        await asyncio.sleep(0)
                        continue

                    # 检查是否已存在
                    cursor.execute(
                        "SELECT username FROM users WHERE username=?", (username,)
                    )
                    if cursor.fetchone():
                        errors.append(f"第{row_num}行：用户 '{username}' 已存在，跳过")
                        await asyncio.sleep(0)
                        continue

                    hashed = hash_password(password)
                    class_val = _normalize_class(row.get("class", "").strip())
                    name_val = row.get("name", "").strip()
                    gender_val = _standardize_gender(row.get("gender", "0"))
                    role_val = _standardize_role(row.get("role", "2"))
                    grade_val = row.get("grade", "").strip()

                    # U-SCOPE: 教师导入不得造出教师/管理员账号, 且只能建自己任教范围内的学生
                    if not is_admin_importer:
                        if role_val != 2:
                            role_clamped += 1
                            role_val = 2
                        first_grade = grade_val.split("|")[0].strip()
                        if not _teacher_can_assign_class(importer_name, first_grade, class_val):
                            errors.append(f"第{row_num}行：年级「{first_grade or '空'}」班级「{class_val or '空'}」不在您的任教范围内")
                            await asyncio.sleep(0)
                            continue

                    # 解析年级/班级 ID
                    grade_id = None
                    class_id = None
                    if grade_val and role_val == 2:
                        # 学生：单年级单班级
                        g_name = grade_val.split("|")[0].strip()  # 取第一个（学生不应有管道）
                        grade_id = grade_cache.get(g_name) or upsert_grade(g_name)
                        grade_cache[g_name] = grade_id
                        if class_val:
                            cls_name = class_val.strip()
                            if "班" not in cls_name:
                                cls_name = f"{cls_name}班"
                            cache_key = (grade_id, cls_name)
                            if cache_key not in class_cache:
                                class_cache[cache_key] = upsert_class(grade_id, cls_name)
                            class_id = class_cache[cache_key]

                    cursor.execute(
                        "INSERT INTO users (username, password, class, name, gender, role, grade, grade_id, class_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (username, hashed, class_val, name_val, gender_val, role_val, grade_val, grade_id, class_id),
                    )

                    # 解析任教学科（CSV 中逗号分隔，如 "信息科技,通用技术"）
                    subjects_str = row.get("subjects", "").strip()
                    subject_list = [s.strip() for s in subjects_str.replace("，", ",").split(",") if s.strip()] if subjects_str else []
                    # 校验学科是否在系统配置中，不在则发出警告
                    if subject_list:
                        from backend.subject_config import get_subjects
                        valid_subjects = get_subjects()
                        invalid = [s for s in subject_list if s not in valid_subjects]
                        if invalid:
                            valid_str = "、".join(valid_subjects) if valid_subjects else "（未配置）"
                            logger.warning(f"导入用户 '{username}' 学科 {','.join(invalid)} 不在系统配置 SUBJECTS 中（当前配置: {valid_str}），已跳过非法学科")
                            subject_list = [s for s in subject_list if s in valid_subjects]

                    # 教师：写入 teacher_assignments
                    if role_val == 1 and grade_val:
                        gcm = parse_legacy_teacher_grade_class(grade_val, class_val)
                        for g_name, cls_names in gcm.items():
                            gid = grade_cache.get(g_name) or upsert_grade(g_name)
                            grade_cache[g_name] = gid
                            # 如果有指定学科，为每个学科创建一条记录；否则创建一条无学科记录
                            if subject_list:
                                for subj in subject_list:
                                    if not cls_names:
                                        cursor.execute(
                                            "INSERT OR IGNORE INTO teacher_assignments (teacher_username, grade_id, class_id, subject) VALUES (?, ?, NULL, ?)",
                                            (username, gid, subj),
                                        )
                                    else:
                                        for cn in cls_names:
                                            if "班" not in cn:
                                                cn = f"{cn}班"
                                            cache_key = (gid, cn)
                                            if cache_key not in class_cache:
                                                class_cache[cache_key] = upsert_class(gid, cn)
                                            cid = class_cache[cache_key]
                                            cursor.execute(
                                                "INSERT OR IGNORE INTO teacher_assignments (teacher_username, grade_id, class_id, subject) VALUES (?, ?, ?, ?)",
                                                (username, gid, cid, subj),
                                            )
                            else:
                                # 未指定学科，保持向后兼容
                                if not cls_names:
                                    cursor.execute(
                                        "INSERT OR IGNORE INTO teacher_assignments (teacher_username, grade_id, class_id) VALUES (?, ?, NULL)",
                                        (username, gid),
                                    )
                                else:
                                    for cn in cls_names:
                                        if "班" not in cn:
                                            cn = f"{cn}班"
                                        cache_key = (gid, cn)
                                        if cache_key not in class_cache:
                                            class_cache[cache_key] = upsert_class(gid, cn)
                                        cid = class_cache[cache_key]
                                        cursor.execute(
                                            "INSERT OR IGNORE INTO teacher_assignments (teacher_username, grade_id, class_id) VALUES (?, ?, ?)",
                                            (username, gid, cid),
                                        )

                    imported += 1
                except Exception as e:
                    errors.append(f"第{row_num}行：{str(e)}")

                # 每处理一行发送一次进度
                progress_data = {
                    'type': 'progress',
                    'current': row_num - 1,
                    'total': total,
                    'imported': imported,
                    'error_count': len(errors),
                    'percent': round((row_num - 1) / total * 100, 1),
                }
                yield f"data: {json.dumps(progress_data, ensure_ascii=False)}\n\n"

        # 事务在此自动提交，所有插入一次性写入磁盘

        # 发送完成事件
        logger.info(f"批量导入用户: imported={imported}, errors={len(errors)}")
        if role_clamped:
            errors.append(f"注：{role_clamped} 行的 role 列被降级为学生（教师账号无权创建教师/管理员）")
        done_msg = f"成功导入 {imported} 个用户，{len(errors)} 个错误"
        done_data = {
            'type': 'done',
            'imported': imported,
            'role_clamped': role_clamped,
            'error_count': len(errors),
            'errors': errors[:50],
            'message': done_msg,
        }
        yield f"data: {json.dumps(done_data, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.get("/import/template")
async def download_import_template(request: Request):
    """下载用户导入 CSV 模板(需登录; 模板含账号结构说明, 不再对匿名开放)"""
    get_current_user(request)
    import tempfile

    csv_content = "username,password,class,name,gender,role,grade,subjects\n"
    csv_content += "# === 学生示例（class 自动去\"班\"后缀，按年级名匹配主数据） ===\n"
    csv_content += "s11001,123456,1班,张三,男,2,一年级,\n"
    csv_content += "s11002,123456,2班,李四,女,2,一年级,\n"
    csv_content += "s21001,123456,3班,王五,男,2,初一,\n"
    csv_content += "s31001,123456,1班,赵六,女,2,高一,\n"
    csv_content += "# === 教师示例（用 | 分隔多年级，用 , 分隔多班级） ===\n"
    csv_content += "t001,123456,\"1班,2班|1班\",王老师,男,1,一年级|初一,信息科技\n"
    csv_content += "t002,123456,\"1班,2班,3班\",李老师,女,1,高一,通用技术\n"
    csv_content += "# === 教师多学科示例（subjects 列多个学科用逗号分隔，需用英文双引号包裹） ===\n"
    csv_content += "t003,123456,\"1班,2班\",陈老师,女,1,高一,\"信息科技,通用技术\"\n"
    csv_content += "# 说明: grade 列支持 \"一年级\"~\"高三\" 等任意年级名，class 列数字自动补\"班\"后缀并映射到 classes 表。subjects 列为教师任教学科，多个用英文逗号分隔并用英文双引号包裹"

    # 创建临时文件
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".csv", mode="w", encoding="utf-8-sig")
    tmp.write(csv_content)
    tmp.close()

    return FileResponse(
        tmp.name,
        media_type="text/csv",
        filename="user_import_template.csv",
    )


# ═══════════════════════════════════════════════════════════════
# 批量升年级
# ═══════════════════════════════════════════════════════════════

@router.get("/promote-grades/preview")
async def preview_promote_grades(request: Request):
    """预览升年级影响范围"""
    current_user = get_current_user(request)
    from backend.auth import is_admin
    if not is_admin(current_user["username"]):
        raise HTTPException(status_code=403, detail="权限不足：仅管理员可以执行升年级操作")

    try:
        from backend.permission_service import preview_grade_promotion
        return preview_grade_promotion()
    except Exception as e:
        logger.error(f"预览升年级失败: {e}")
        raise HTTPException(status_code=500, detail=f"预览失败: {str(e)}")


class GradePromotionRequest(BaseModel):
    sync_scores: bool = True
    sync_rollcall: bool = True
    match_class: bool = True
    confirm: bool = False


@router.post("/promote-grades")
async def execute_promote_grades(req: GradePromotionRequest, request: Request):
    """执行批量升年级"""
    current_user = get_current_user(request)
    from backend.auth import is_admin
    if not is_admin(current_user["username"]):
        raise HTTPException(status_code=403, detail="权限不足：仅管理员可以执行升年级操作")

    if not req.confirm:
        raise HTTPException(status_code=400, detail="请先确认执行升年级操作（confirm=true）")

    try:
        from backend.permission_service import execute_grade_promotion
        result = execute_grade_promotion(
            sync_scores=req.sync_scores,
            sync_rollcall=req.sync_rollcall,
            match_class=req.match_class,
            direction="up",
        )
        logger.info(f"批量升年级完成: promoted={result['promoted']}")
        return result
    except Exception as e:
        logger.error(f"执行升年级失败: {e}")
        raise HTTPException(status_code=500, detail=f"升年级失败: {str(e)}")


# ═══════════════════════════════════════════════════════════════
# 反向降级（升年级的逆操作）
# ═══════════════════════════════════════════════════════════════

@router.post("/promote-grades/reverse")
async def reverse_promote_grades(req: GradePromotionRequest, request: Request):
    """反向降级：高二→高一、高三→高二（升年级的逆操作）"""
    current_user = get_current_user(request)
    from backend.auth import is_admin
    if not is_admin(current_user["username"]):
        raise HTTPException(status_code=403, detail="权限不足：仅管理员")

    if not req.confirm:
        raise HTTPException(status_code=400, detail="请先确认执行降级操作（confirm=true）")

    try:
        from backend.permission_service import execute_grade_promotion, build_reverse_grade_promotion_map
        reverse_map = build_reverse_grade_promotion_map()
        result = execute_grade_promotion(
            sync_scores=req.sync_scores,
            sync_rollcall=req.sync_rollcall,
            match_class=req.match_class,
            prom_map=reverse_map,
            direction="down",
        )
        if result["success"]:
            logger.info(f"批量降级完成: promoted={result['promoted']}, already_min={result['not_moved']}")
        return result
    except Exception as e:
        logger.error(f"执行降级失败: {e}")
        raise HTTPException(status_code=500, detail=f"降级失败: {str(e)}")
