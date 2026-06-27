"""
用户管理 API 路由
注册 / 更新 / 改密 / 删除 / 查询 / 导入 / 批量删除
"""
import asyncio
import csv
import io
import json
import os
import shutil
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, UploadFile, File
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
)
from backend.api.dependencies import get_current_user
from backend.config import STU_DIR, ROOT_DIR, BASE_DIR
from backend.logger import logger
from backend.permission_service import (
    upsert_grade,
    upsert_class,
    assign_teacher,
    clear_teacher_assignments,
    parse_legacy_teacher_grade_class,
)

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


# ── 彻底删除用户（数据库 + 文件系统） ──

def _delete_user_completely(username: str):
    """
    彻底删除用户的所有相关数据：
    1. 删除用户文件目录（stu/<username> 或 <username>）
    2. 删除数据库中所有与该用户相关的记录
    """
    # 1. 删除用户文件目录
    user_dir = os.path.join(BASE_DIR, STU_DIR, username)
    alt_dir = os.path.join(BASE_DIR, username)
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
        # 以 username 为创建者/拥有者的表
        # 先清理共享资源关联的课程绑定
        ("DELETE FROM curriculum_bindings WHERE resource_id IN (SELECT id FROM shared_resources WHERE owner_username=?)", (username,)),
        ("DELETE FROM shared_resources WHERE owner_username=?", (username,)),
        ("DELETE FROM tasks WHERE creator_username=?", (username,)),
        ("DELETE FROM task_grades WHERE task_id IN (SELECT id FROM tasks WHERE creator_username=?)", (username,)),
        ("DELETE FROM announcements WHERE creator_username=?", (username,)),
        ("DELETE FROM interaction_quizzes WHERE creator_username=?", (username,)),
        ("DELETE FROM interaction_polls WHERE creator_username=?", (username,)),
        ("DELETE FROM discussions WHERE creator_username=?", (username,)),
        # 知识闯关（quest）
        ("DELETE FROM quest_question_records WHERE quest_id IN (SELECT id FROM quest_records WHERE student_username=?)", (username,)),
        ("DELETE FROM quest_records WHERE student_username=?", (username,)),
        ("DELETE FROM quest_badge_counts WHERE student_username=?", (username,)),
        ("DELETE FROM quest_question_bank WHERE creator_username=?", (username,)),
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
        # 学生作为被积分/点名对象（student_name TEXT 匹配）
        ("DELETE FROM scores WHERE student_name=?", (student_name,)),
        ("DELETE FROM rollcall_weights WHERE student_name=?", (student_name,)),
        ("DELETE FROM rollcall_history WHERE student_name=?", (student_name,)),
        # 自我画像数据
        ("DELETE FROM portrait_likes WHERE portrait_id IN (SELECT id FROM student_portraits WHERE username=?)", (username,)),
        ("DELETE FROM student_portraits WHERE username=?", (username,)),
    ]
    # 删除资源分组项
    for gid in group_id_list:
        delete_ops.append(("DELETE FROM resource_group_items WHERE group_id=?", (gid,)))
    delete_ops.append(("DELETE FROM resource_groups WHERE username=?", (username,)))
    # 最后删除用户本身
    delete_ops.append(("DELETE FROM users WHERE username=?", (username,)))

    # 逐条执行删除操作，单条失败仅记录日志不影响后续
    for sql, params in delete_ops:
        try:
            execute_batch([(sql, params)])
        except Exception as e:
            logger.warning(f"删除操作跳过（表或列不存在）: {sql[:80]}... - {e}")

    # 4. 删除 questions.db 中的考试答题记录和代码练习记录
    try:
        from backend.question_db import execute_update as q_execute_update
        q_execute_update(
            "DELETE FROM exam_attempts WHERE student_username=?", (username,)
        )
        q_execute_update(
            "DELETE FROM code_submissions WHERE student_username=?", (username,)
        )
        q_execute_update(
            "DELETE FROM code_problems WHERE creator_username=?", (username,)
        )
        q_execute_update(
            "DELETE FROM ai_practice_results WHERE student_username=?", (username,)
        )
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
    if not can_manage_users(current_user["username"]) and not is_teacher(current_user["username"]):
        raise HTTPException(status_code=403, detail="权限不足：仅管理员或教师可以更新用户信息")

    username = req.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="用户名不能为空")

    existing = execute_query("SELECT username FROM users WHERE username=?", (username,))
    if not existing:
        raise HTTPException(status_code=404, detail=f"用户 '{username}' 不存在")

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

        # 教师：更新 teacher_assignments
        if role_num == 1 and grade_val:
            from backend.permission_service import clear_teacher_assignments, assign_teacher
            clear_teacher_assignments(username)
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

    # 普通用户只能改自己的密码
    if current_username != "root" and username != current_username:
        raise HTTPException(status_code=403, detail="权限不足：只能修改自己的密码")

    hashed = hash_password(new_password)

    try:
        execute_insert_update(
            "UPDATE users SET password=? WHERE username=?",
            (hashed, username),
        )
        logger.info(f"密码已修改: {username}")
        return {"message": f"用户 '{username}' 密码已修改"}
    except Exception as e:
        logger.error(f"修改密码失败: {e}")
        raise HTTPException(status_code=500, detail=f"修改密码失败: {str(e)}")


@router.delete("/{username}")
async def delete_user(username: str, request: Request):
    """彻底删除用户及其所有相关数据（管理员和教师均可）"""
    current_user = get_current_user(request)
    if not can_manage_users(current_user["username"]) and not is_teacher(current_user["username"]):
        raise HTTPException(status_code=403, detail="权限不足：仅管理员或教师可以删除用户")

    # 检查用户是否存在并获取角色
    rows = execute_query("SELECT username, role FROM users WHERE username=?", (username,))
    if not rows:
        raise HTTPException(status_code=404, detail=f"用户 '{username}' 不存在")

    user_role = rows[0][1]

    # 禁止删除任何管理员账号（role=0）
    if user_role == 0:
        raise HTTPException(status_code=400, detail="不能删除管理员账号")

    try:
        _delete_user_completely(username)
        logger.info(f"用户已彻底删除: {username}")
        return {"message": f"用户 '{username}' 已彻底删除"}
    except Exception as e:
        logger.error(f"删除用户失败: {e}")
        raise HTTPException(status_code=500, detail=f"删除失败: {str(e)}")


@router.get("/{username}")
async def get_user_info(username: str, request: Request):
    """查询用户信息"""
    current_user = get_current_user(request)

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
async def get_all_users(request: Request, keyword: Optional[str] = None):
    """查看所有用户，支持按用户名/姓名模糊搜索"""
    get_current_user(request)  # 只需登录

    if keyword and keyword.strip():
        kw = f"%{keyword.strip()}%"
        rows = execute_query(
            "SELECT username, class, name, gender, role, grade FROM users WHERE username LIKE ? OR name LIKE ? ORDER BY username",
            (kw, kw),
        )
    else:
        rows = execute_query(
            "SELECT username, class, name, gender, role, grade FROM users ORDER BY username"
        )
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


@router.post("/bulk-delete")
async def bulk_delete_users(req: BulkDeleteRequest, request: Request):
    """批量彻底删除用户（按用户名模式匹配，跳过管理员账号）"""
    current_user = get_current_user(request)
    if not can_manage_users(current_user["username"]) and not is_teacher(current_user["username"]):
        raise HTTPException(status_code=403, detail="权限不足：仅管理员或教师可以批量删除")

    pattern = req.pattern.strip()
    if not pattern:
        raise HTTPException(status_code=400, detail="请提供要删除的用户名模式")

    try:
        # 先查出匹配的非管理员用户（用于返回列表）
        rows = execute_query(
            "SELECT username FROM users WHERE username LIKE ? AND role != 0",
            (f"%{pattern}%",),
        )
        deleted = [row[0] for row in rows]
        if not deleted:
            return {"message": "没有匹配的用户", "deleted": []}

        # 逐个彻底删除（每个用户清理数据库记录 + 文件目录）
        for username in deleted:
            _delete_user_completely(username)

        logger.info(f"批量删除用户: pattern={pattern}, count={len(deleted)}")
        return {"message": f"已删除 {len(deleted)} 个用户", "deleted": deleted}
    except Exception as e:
        logger.error(f"批量删除失败: {e}")
        raise HTTPException(status_code=500, detail=f"批量删除失败: {str(e)}")


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
        done_msg = f"成功导入 {imported} 个用户，{len(errors)} 个错误"
        done_data = {
            'type': 'done',
            'imported': imported,
            'error_count': len(errors),
            'errors': errors[:50],
            'message': done_msg,
        }
        yield f"data: {json.dumps(done_data, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.get("/import/template")
async def download_import_template():
    """下载用户导入 CSV 模板"""
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
