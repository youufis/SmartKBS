"""
任务管理 API 路由
创建/激活/提交/汇总/AI 批改
"""
import json
import os
import time
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.auth import can_create_task, is_teacher, is_admin
from backend.api.chat_router import get_api_keys, upload_file_to_dashscope
from backend.prompts import build_ai_role
from backend.permission_service import check_activity_visibility
from backend.api.config_router import get_config_value
from backend.config import (
    SUMMARY_DIR_NAME,
    TEACHERS_SUMMARY_DIR,
    ADMIN_SUMMARY_DIR,
    BASE_DIR,
)
from backend.utils import get_account_chat_history_dir, get_admin_chat_history_dir, path_within

from backend.database import execute_query, execute_insert_update, get_connection
from backend.logger import logger
from backend.prompts import apply_skills

# K4: 任务字段上限与目标范围白名单
TASK_NAME_MAX = 60
TASK_DESC_MAX = 5000
SUBMIT_CONTENT_MAX = 200_000        # K3: 单次提交内容上限(约 200KB)
TASK_TARGET_SCOPES = {"all", "teacher_classes", "grade", "class", "individual"}


def _safe_task_filename(task_name, task_id: str = "") -> str:
    """K3: 任务名进入文件路径前必须净化

    旧实现把任务名直接拼进 summary_{task_name}.md 并 makedirs(dirname),
    教师建一个名字里带 .. 的路径, 学生一提交就会在项目目录之外写文件;
    名字含 : * ? " < > | 或超长时 open() 直接抛错, 提交记录却已入库 -> 数据不一致。
    """
    import re as _re
    base = os.path.basename(str(task_name or "").replace(chr(92), "/"))
    base = _re.sub(r'[\\/:*?"<>|\r\n\t]+', '_', base).strip(' ._')
    if len(base) > 40:
        base = base[:40].strip(" ._")
    if not base:
        base = _re.sub(r"[^A-Za-z0-9_.-]", "_", str(task_id or ""))[:40] or "task"
    return base


def _task_digest(task_id: str) -> str:
    """任务 ID 的稳定短指纹(用于文件名, 避免同名任务共用一个汇总文件)"""
    import hashlib
    if not task_id:
        return ""
    return hashlib.md5(str(task_id).encode("utf-8")).hexdigest()[:8]


def _summary_paths_for(creator: str, fname: str, admin_fname: str) -> list[str]:
    admin_chat_dir = get_admin_chat_history_dir()
    candidates = [
        os.path.join(admin_chat_dir, SUMMARY_DIR_NAME, TEACHERS_SUMMARY_DIR, creator, fname),
        os.path.join(get_account_chat_history_dir(creator), SUMMARY_DIR_NAME, fname),
        os.path.join(admin_chat_dir, SUMMARY_DIR_NAME, ADMIN_SUMMARY_DIR, admin_fname),
    ]
    root = os.path.realpath(str(BASE_DIR))
    return [p for p in candidates if path_within(root, os.path.realpath(p))]


def _summary_paths(creator: str, task_name: str, task_id: str = "") -> list[str]:
    """K3: 当前写入路径(净化 + 带任务指纹), 并断言落点仍在项目目录内"""
    safe = _safe_task_filename(task_name, task_id)
    digest = _task_digest(task_id)
    stem = f"{safe}_{digest}" if digest else safe
    return _summary_paths_for(creator, f"summary_{stem}.md", f"summary_{creator}_{stem}.md")


def _summary_paths_legacy(creator: str, task_name: str) -> list[str]:
    """K9: 历史遗留路径(仅任务名, 无指纹) —— 只用于读取与清理, 保持向后兼容"""
    safe = _safe_task_filename(task_name)
    return _summary_paths_for(creator, f"summary_{safe}.md", f"summary_{creator}_{safe}.md")


def _purge_summary_files(creator: str, task_name: str, task_id: str = "") -> int:
    """删除任务时一并清理其汇总文件(旧实现只删数据库, 文件永久残留,
    之后同名新任务会 append 到同一文件里, 把上一届学生的内容混进来)"""
    removed = 0
    for p in _summary_paths(creator, task_name, task_id) + _summary_paths_legacy(creator, task_name):
        try:
            if os.path.isfile(p):
                os.remove(p)
                removed += 1
        except Exception as e:
            logger.warning(f"[任务] 汇总文件删除失败 {p}: {e}")
    return removed


def _assert_task_target_scope(user: dict, scope: str, grade: str, cls: str, users: str) -> None:
    """K4: 教师只能把任务布置给自己任教范围内的学生; 全校范围仅管理员"""
    if user.get("role", 2) == 0:
        return
    if scope == "all":
        raise HTTPException(status_code=403, detail="面向全体用户的任务仅管理员可创建")
    if scope not in TASK_TARGET_SCOPES:
        raise HTTPException(status_code=400, detail="目标范围无效")
    from backend.permission_service import (
        get_teacher_grades, get_teacher_classes, get_grade_by_name, is_student_in_teacher_scope,
    )
    teacher = user.get("username", "")
    grades = {g["name"] for g in (get_teacher_grades(teacher) or [])}
    want_grades = [x.strip() for x in str(grade or "").replace("，", ",").split(",") if x.strip()]
    if want_grades and grades and not set(want_grades) <= grades:
        raise HTTPException(status_code=403,
                            detail=f"只能面向自己任教的年级布置任务（可选项: {'、'.join(sorted(grades)) or '无'}）")
    if scope == "class" and cls:
        gname = want_grades[0] if want_grades else (next(iter(grades)) if grades else "")
        gi = get_grade_by_name(gname) if gname else None
        allowed = {str(c["name"]).replace("班", "").strip() for c in (get_teacher_classes(teacher, gi["id"]) if gi else [])}
        want_cls = {x.strip().replace("班", "") for x in str(cls).replace("，", ",").split(",") if x.strip()}
        if allowed and not want_cls <= allowed:
            raise HTTPException(status_code=403,
                                detail=f"只能面向自己任教的班级布置任务（可选项: {'、'.join(sorted(a for a in allowed if a)) or '无'}）")
    if scope == "individual" and users:
        for stu in [x.strip() for x in str(users).replace("，", ",").split(",") if x.strip()]:
            if not is_student_in_teacher_scope(stu, teacher):
                raise HTTPException(status_code=403, detail=f"学生 {stu} 不在您的任教范围内")

router = APIRouter()


class CreateTaskRequest(BaseModel):
    name: str
    description: str = ""
    target_scope: str = "teacher_classes"
    target_grade: str = ""
    target_class: str = ""
    target_users: str = ""


class SubmitTaskRequest(BaseModel):
    task_id: str
    conversation_content: str


# ── 辅助函数（数据库版）──

def _task_row_to_dict(row, submissions: list[str] | None = None) -> dict[str, Any]:
    """将 tasks 表行转换为前端期望的 dict 格式"""
    # row 可能来自 SELECT *，包含 target_* 字段（索引 6-9）
    target_scope = row[6] if len(row) > 6 else "teacher_classes"
    target_grade = row[7] if len(row) > 7 else ""
    target_class = row[8] if len(row) > 8 else ""
    target_users = row[9] if len(row) > 9 else ""
    task = {
        "id": row[0],
        "creator": row[1],
        "name": row[2],
        "description": row[3] or "",
        "status": row[4],
        "created_time": row[5],
        "target_scope": target_scope,
        "target_grade": target_grade,
        "target_class": target_class,
        "target_users": target_users,
    }
    if submissions is not None:
        task["submissions"] = submissions
    else:
        sub_rows = execute_query(
            "SELECT student_username FROM task_submissions WHERE task_id=?", (row[0],)
        )
        task["submissions"] = [s[0] for s in sub_rows]
    return task


def get_all_tasks() -> list[dict[str, Any]]:
    """从数据库获取所有活跃任务"""
    rows = execute_query(
        "SELECT id, creator_username, name, description, status, created_at, target_scope, target_grade, target_class, target_users FROM tasks WHERE status='active' ORDER BY created_at DESC"
    )
    return [_task_row_to_dict(row) for row in rows]


def _get_all_tasks_raw() -> list[dict[str, Any]]:
    """从数据库获取所有任务（含非活跃）"""
    rows = execute_query(
        "SELECT id, creator_username, name, description, status, created_at, target_scope, target_grade, target_class, target_users FROM tasks ORDER BY created_at DESC"
    )
    return [_task_row_to_dict(row) for row in rows]


def _get_creator_tasks(username: str) -> list[dict[str, Any]]:  # type: ignore[valid-type]
    """获取指定创建者的所有任务"""
    rows = execute_query(
        "SELECT id, creator_username, name, description, status, created_at, target_scope, target_grade, target_class, target_users FROM tasks WHERE creator_username=? ORDER BY created_at DESC",
        (username,),
    )
    return [_task_row_to_dict(row) for row in rows]


def _check_task_ownership(task_id: str, username: str) -> dict[str, Any] | None:
    """验证当前用户是否有权操作该任务，返回任务信息或 None"""
    rows = execute_query(
        "SELECT id, creator_username, name, description, status, created_at, "
        "target_scope, target_grade, target_class, target_users "
        "FROM tasks WHERE id=?", (task_id,),
    )
    if not rows:
        return None
    task = _task_row_to_dict(rows[0])
    if is_admin(username) or task.get("creator") == username:
        return task
    return None


def get_user_relevant_tasks(student_user: str, active_tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """获取与学生相关的任务（基于活动目标范围 + 教师任教范围匹配）

    优先使用任务的 target_scope 过滤；兼容旧数据（无 target_scope 时回退到任教范围匹配）。
    """

    # 查询学生的年级班级
    student_rows = execute_query(
        "SELECT grade, class FROM users WHERE username=?", (student_user,)
    )
    s_grade = str(student_rows[0][0] or "").strip() if student_rows else ""
    s_class = str(student_rows[0][1] or "").strip() if student_rows else ""

    relevant = []
    for task in active_tasks:
        creator = task["creator"]

        # 使用统一的活动范围检查
        if check_activity_visibility(
            student_username=student_user,
            student_grade=s_grade,
            student_class=s_class,
            creator_username=creator,
            target_scope=task.get("target_scope", "teacher_classes"),
            target_grade=task.get("target_grade", ""),
            target_class=task.get("target_class", ""),
            target_users=task.get("target_users", ""),
        ):
            relevant.append(task)

    return relevant


# ── API 端点 ──

@router.get("/active")
async def get_active_tasks(request: Request):
    """获取活动任务列表

    K1: `user` 参数此前对任何登录用户生效 —— 学生传 user=<某教师> 即可拿到该教师任务的
        submissions(学号) 与 submissions_names(真实姓名)。现仅管理员可代查, 且被代查账号须存在(K7)。
    K5: 提交者姓名一次性批量查询, 不再逐任务逐学生 N+1; total 返回真实总数。
    """
    user = get_current_user(request)
    caller = user["username"]
    caller_role = user.get("role", 2)
    target_user = request.query_params.get("user", "") or caller

    if target_user != caller:
        if caller_role != 0:
            raise HTTPException(status_code=403, detail="无权查看其他用户的任务列表")
        if not execute_query("SELECT 1 FROM users WHERE username=?", (target_user,)):
            raise HTTPException(status_code=404, detail="用户不存在")

    all_tasks = get_all_tasks()

    if caller_role == 2:
        # 学生: 只暴露"我自己是否提交", 不含同学学号与姓名(K1)
        relevant = get_user_relevant_tasks(target_user, all_tasks)
        for task in relevant:
            mine = target_user in (task.get("submissions") or [])
            task["submissions"] = [target_user] if mine else []
            task["submissions_names"] = [target_user] if mine else []
        return {"tasks": relevant, "total": len(relevant)}

    tasks = all_tasks if caller_role == 0 else [t for t in all_tasks if t.get("creator") == target_user]
    all_names = {u for t in tasks for u in (t.get("submissions") or [])}
    name_map: dict[str, str] = {}
    if all_names:
        ph = ",".join("?" for _ in all_names)
        for r in execute_query(f"SELECT username, name FROM users WHERE username IN ({ph})", tuple(all_names)):
            name_map[r[0]] = r[1] or r[0]
    for task in tasks:
        task["submissions_names"] = [name_map.get(u, u) for u in (task.get("submissions") or [])]
    return {"tasks": tasks, "total": len(tasks)}


@router.post("/create")
async def create_task(req: CreateTaskRequest, request: Request):
    """创建新任务（管理员/教师）"""
    user = get_current_user(request)
    username = user["username"]

    if not can_create_task(username):
        raise HTTPException(status_code=403, detail="权限不足：只有管理员和教师可以创建任务")

    task_name = req.name.strip()
    if not task_name:
        raise HTTPException(status_code=400, detail="任务名称不能为空")
    # K4: 字段上限 + 目标范围必须在本人任教范围内
    if len(task_name) > TASK_NAME_MAX:
        raise HTTPException(status_code=400, detail=f"任务名称最长 {TASK_NAME_MAX} 字")
    if len(req.description.strip()) > TASK_DESC_MAX:
        raise HTTPException(status_code=400, detail=f"任务描述最长 {TASK_DESC_MAX} 字")
    _assert_task_target_scope(user, req.target_scope, req.target_grade, req.target_class, req.target_users)

    import uuid
    task_id = f"{username}_{task_name}_{int(time.time())}_{uuid.uuid4().hex[:8]}"
    now = time.strftime("%Y-%m-%d %H:%M:%S")

    execute_insert_update(
        """INSERT INTO tasks (id, creator_username, name, description, status, created_at, updated_at,
                              target_scope, target_grade, target_class, target_users)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)""",
        (task_id, username, task_name, req.description.strip(), now, now,
         req.target_scope, req.target_grade, req.target_class, req.target_users),
    )

    new_task = {
        "id": task_id,
        "creator": username,
        "name": task_name,
        "description": req.description.strip(),
        "status": "active",
        "created_time": now,
        "target_scope": req.target_scope,
        "target_grade": req.target_grade,
        "target_class": req.target_class,
        "target_users": req.target_users,
        "submissions": [],
    }

    logger.info(f"任务已创建: {task_name}, creator={username}")
    return {"task": new_task, "message": f"任务 '{task_name}' 创建成功"}


@router.post("/submit")
async def submit_task(req: SubmitTaskRequest, request: Request):
    """提交到任务"""
    user = get_current_user(request)
    username = user["username"]

    # 查找任务（数据库）
    rows = execute_query(
        "SELECT id, creator_username, name, description, status, created_at FROM tasks WHERE id=? AND status='active'",
        (req.task_id,),
    )
    if rows:
        task_info = _task_row_to_dict(rows[0])
    else:
        # 兼容按名称查找
        rows2 = execute_query(
            "SELECT id, creator_username, name, description, status, created_at FROM tasks WHERE name=? AND status='active' LIMIT 1",
            (req.task_id,),
        )
        if rows2:
            task_info = _task_row_to_dict(rows2[0])
        else:
            raise HTTPException(status_code=404, detail="任务未找到")

    creator = task_info["creator"]
    target_scope = task_info.get("target_scope", "teacher_classes")

    # 权限校验：学生只能提交到可见范围内的任务
    if user.get("role") == 2:
        s_grade = user.get("grade", "")
        s_class = user.get("class", "")
        rows_grade = execute_query(
            "SELECT grade, class FROM users WHERE username=?", (username,),
        )
        if rows_grade:
            s_grade = str(rows_grade[0][0] or "").strip()
            s_class = str(rows_grade[0][1] or "").strip()
        if not check_activity_visibility(
            student_username=username,
            student_grade=s_grade,
            student_class=s_class,
            creator_username=creator,
            target_scope=target_scope,
            target_grade=task_info.get("target_grade", ""),
            target_class=task_info.get("target_class", ""),
            target_users=task_info.get("target_users", ""),
        ):
            raise HTTPException(status_code=403, detail="无权提交到该任务")

    # 记录提交（已存在的更新提交时间，不静默忽略）
    execute_insert_update(
        # A4: 与其余表一致用本地时间(首页最近动态直接展示该字段)
        "INSERT OR REPLACE INTO task_submissions (task_id, student_username, submitted_at) "
        "VALUES (?, ?, datetime('now', 'localtime'))",
        (task_info["id"], username),
    )

    # 保存到汇总文件（K3: 写盘失败则回滚提交记录, 避免出现"有提交无内容"的不一致）
    if not _save_to_summary(creator, task_info["name"], username,
                            req.conversation_content, task_info["id"]):
        execute_insert_update(
            "DELETE FROM task_submissions WHERE task_id=? AND student_username=?",
            (task_info["id"], username),
        )
        raise HTTPException(status_code=500, detail="汇总文件写入失败，请重试或联系管理员检查磁盘/任务名")

    # ── 任务提交积分奖励（仅学生） ──
    if user.get("role") == 2:
        try:
            from backend.reward_engine import award_participation
            award_participation(username, "task", str(task_info["id"]), task_info["name"])
        except Exception:
            pass

    logger.info(f"任务已提交: {task_info['name']}, student={username}")
    return {"message": f"已提交到任务 '{task_info['name']}'"}


def _save_to_summary(creator: str, task_name: str, student: str, content: str, task_id: str = "") -> bool:
    """保存提交到汇总文件（K3: 路径净化 + 内容截断 + 返回是否落盘成功）"""
    paths = _summary_paths(creator, task_name, task_id)
    if not paths:
        logger.error(f"[任务] 汇总文件路径被判定越界, 拒绝写入: creator={creator}, task={task_name!r}")
        return False
    safe_content = str(content or "")
    truncated = len(safe_content) > SUBMIT_CONTENT_MAX
    if truncated:
        safe_content = safe_content[:SUBMIT_CONTENT_MAX] + "\n\n> ⚠️ 内容过长，已截断保存"
    ok = False
    for path in paths:
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            file_exists = os.path.exists(path)
            with open(path, "a", encoding="utf-8") as f:
                if not file_exists:
                    f.write(f"# 任务汇总\n\n创建时间: {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n---\n\n")
                f.write(f"## 学生 {student}\n\n")
                f.write(f"提交时间: {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n")
                f.write(f"内容:\n{safe_content}\n\n---\n\n")
            ok = True
        except Exception as e:
            logger.warning(f"[任务] 汇总文件写入失败 {path}: {e}")
    return ok


@router.get("/user")
async def get_user_tasks(request: Request):
    """获取当前用户的活动任务"""
    user = get_current_user(request)
    username = user["username"]

    active_tasks = get_all_tasks()
    relevant = get_user_relevant_tasks(username, active_tasks)

    return {"tasks": relevant}


class DeleteTaskRequest(BaseModel):
    task_id: str


@router.delete("/delete")
async def delete_task(request: Request):
    """删除任务（管理员/教师）"""
    user = get_current_user(request)
    username = user["username"]

    if not can_create_task(username):
        raise HTTPException(status_code=403, detail="权限不足")

    body = await request.json()
    task_id = body.get("task_id", "")
    if not task_id:
        raise HTTPException(status_code=400, detail="缺少 task_id")

    # 所有权验证
    task_info = _check_task_ownership(task_id, username)
    if not task_info:
        raise HTTPException(status_code=404, detail="任务未找到或无权限删除")

    # 从数据库删除
    with get_connection() as conn:
        c = conn.cursor()
        c.execute("DELETE FROM task_submissions WHERE task_id=?", (task_id,))
        c.execute("DELETE FROM task_grades WHERE task_id=?", (task_id,))
        c.execute("DELETE FROM activity_rewards WHERE activity_type='task' AND activity_id=?", (task_id,))
        c.execute("DELETE FROM notifications WHERE source_type='task' AND source_id=?", (task_id,))
        c.execute("DELETE FROM tasks WHERE id=?", (task_id,))
        conn.commit()

    # K9: 汇总文件一并清理, 不再残留给同名新任务
    purged = _purge_summary_files(task_info["creator"], task_info["name"], task_id)
    logger.info(f"任务已删除: {task_id}, by={username}, 清理汇总文件 {purged} 个")
    return {"message": "任务已删除"}


@router.put("/end")
async def end_task(request: Request):
    """结束任务（管理员/教师）"""
    user = get_current_user(request)
    username = user["username"]

    if not can_create_task(username):
        raise HTTPException(status_code=403, detail="权限不足")

    body = await request.json()
    task_id = body.get("task_id", "")
    if not task_id:
        raise HTTPException(status_code=400, detail="缺少 task_id")

    # 所有权验证
    task_info = _check_task_ownership(task_id, username)
    if not task_info:
        raise HTTPException(status_code=404, detail="任务未找到或无权限结束")

    # 数据库更新状态
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    execute_insert_update(
        "UPDATE tasks SET status='inactive', updated_at=? WHERE id=?",
        (now, task_id),
    )

    logger.info(f"任务已结束: {task_id}, by={username}")
    return {"message": "任务已结束"}


@router.get("/submissions/{task_id}")
async def get_task_submissions(task_id: str, request: Request):
    """获取任务的提交详情（含学生姓名和提交内容）"""
    user = get_current_user(request)
    username = user["username"]
    if not can_create_task(username):
        raise HTTPException(status_code=403, detail="权限不足")

    # 从数据库查找任务
    rows = execute_query(
        "SELECT id, creator_username, name, description, status, created_at FROM tasks WHERE id=?",
        (task_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="任务未找到")
    task_info = _task_row_to_dict(rows[0])

    # 权限验证
    if not is_admin(username) and task_info["creator"] != username:
        raise HTTPException(status_code=403, detail="无权限查看此任务")

    creator = task_info["creator"]
    submissions = task_info.get("submissions", [])

    # 获取学生姓名
    result = []
    for uname in submissions:
        row = execute_query("SELECT name FROM users WHERE username=?", (uname,))
        display_name = row[0][0] if row and row[0][0] else uname
        result.append({
            "username": uname,
            "name": display_name,
        })

    # 如果有具体某学生的查询参数，返回该学生的提交内容
    student = request.query_params.get("student", "")
    content = ""
    if student:
        content = _read_student_submission(creator, task_info["name"], student)

    return {
        "task_name": task_info["name"],
        "task_status": task_info["status"],
        "submissions": result,
        "submission_count": len(result),
        "student_content": content if student else None,
    }


def _read_student_submission(creator: str, task_name: str, student: str) -> str:
    """从汇总文件中读取指定学生的提交内容"""
    admin_chat_dir = get_admin_chat_history_dir()

    # 汇总文件路径（与 _save_to_summary 一致）
    summary_path = os.path.join(
        admin_chat_dir,
        SUMMARY_DIR_NAME, TEACHERS_SUMMARY_DIR, creator,
        f"summary_{task_name}.md",
    )
    if not os.path.isfile(summary_path):
        return ""

    try:
        with open(summary_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return ""

    # 提取该学生的所有提交内容（可能有多次提交记录）
    marker = f"## 学生 {student}"
    if marker not in content:
        return ""

    next_marker = "\n## 学生 "
    all_chunks = []
    for part in content.split(marker):
        if not part.strip():
            continue
        # 取到下一个学生标记或文件末尾
        if next_marker in part:
            student_chunk = part.split(next_marker, 1)[0]
        else:
            student_chunk = part

        # 解析提交内容 — 取 "内容:" 之后到结束的全部内容
        lines = student_chunk.strip().split("\n")
        content_started = False
        result_lines = []
        for line in lines:
            if line.startswith("内容:"):
                content_started = True
                rest = line[len("内容:"):].strip()
                if rest:
                    result_lines.append(rest)
                continue
            if content_started:
                result_lines.append(line)
        chunk_text = "\n".join(result_lines).strip()
        if chunk_text:
            all_chunks.append(chunk_text)

    return "\n\n---\n\n".join(all_chunks) if all_chunks else ""
@router.post("/revert-submission")
async def revert_submission(request: Request):
    """回退学生的提交（管理员/教师）"""
    user = get_current_user(request)
    username = user["username"]
    if not can_create_task(username):
        raise HTTPException(status_code=403, detail="权限不足")

    body = await request.json()
    task_id = body.get("task_id", "")
    student = body.get("student", "")
    if not task_id or not student:
        raise HTTPException(status_code=400, detail="缺少 task_id 或 student")

    # 所有权验证：教师只能回退自己任务的提交
    task_info = _check_task_ownership(task_id, username)
    if not task_info:
        raise HTTPException(status_code=404, detail="任务未找到或无权限操作")

    creator = task_info["creator"]

    # 检查学生是否有提交记录
    sub_row = execute_query(
        "SELECT id FROM task_submissions WHERE task_id=? AND student_username=?",
        (task_id, student),
    )
    if not sub_row:
        raise HTTPException(status_code=404, detail=f"未找到学生 {student} 的提交记录")

    # 删除提交记录和 AI 批改记录
    execute_insert_update(
        "DELETE FROM task_submissions WHERE task_id=? AND student_username=?",
        (task_id, student),
    )
    execute_insert_update(
        "DELETE FROM task_grades WHERE task_id=? AND student_username=?",
        (task_id, student),
    )

    # 也从汇总文件中移除该学生的记录
    _remove_student_from_summary(creator, task_info["name"], student, task_id)
    # K8: 批改记录已删, 全班总结(ai_summary)随之失效, 避免教师继续看含该生的旧总结
    left = execute_query("SELECT COUNT(*) FROM task_grades WHERE task_id=?", (task_id,))
    if not (left and left[0][0]):
        execute_insert_update("UPDATE tasks SET ai_summary='' WHERE id=?", (task_id,))

    logger.info(f"提交已回退: task={task_info['name']}, student={student}, by={username}")
    return {"message": f"已回退学生 {student} 的提交"}


def _remove_student_from_summary(creator: str, task_name: str, student: str, task_id: str = ""):
    """从汇总文件中移除某学生的提交记录（K3: 复用净化路径; K9: 兼容历史文件）"""
    paths = _summary_paths(creator, task_name, task_id) + _summary_paths_legacy(creator, task_name)

    import re
    for path in paths:
        if not os.path.exists(path):
            continue
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        # 统一换行符（Windows \r\n → \n）
        content = content.replace('\r\n', '\n')
        # 移除该学生的提交块（完整块直到下一位学生或文件末尾）
        pattern = rf"\n*## 学生 {re.escape(student)}\s*\n\n提交时间:.*?\n\n内容:\n.*?(?=\n*## 学生|\Z)"
        new_content = re.sub(pattern, "", content, count=1, flags=re.DOTALL)
        # 清理多余的 ---
        new_content = re.sub(r"\n\n---\n\n---\n\n", "\n\n---\n\n", new_content)
        with open(path, "w", encoding="utf-8") as f:
            f.write(new_content.strip() + "\n")


# ═══════════════════════════════════════════════════════════
# AI 批改功能
# ═══════════════════════════════════════════════════════════

def _find_summary_file(creator: str, task_name: str, task_id: str = "") -> str | None:
    """查找任务的 summary 汇总文件路径（K3: 统一走净化路径 + 兼容历史三种布局）"""
    # K9: 先找新的带任务指纹文件, 再兼容历史同名文件
    paths = _summary_paths(creator, task_name, task_id) + _summary_paths_legacy(creator, task_name)
    for p in paths:
        if os.path.exists(p):
            return p
    return None


@router.post("/ai-grade/{task_id}")
async def ai_grade_task(task_id: str, request: Request):
    """🤖 AI 批改任务：读取 summary 汇总文件，调用 qwen-long 分析每位学生的对话并评分"""
    user = get_current_user(request)
    username = user["username"]
    if not can_create_task(username):
        raise HTTPException(status_code=403, detail="权限不足")

    # 1. 查找任务信息
    rows = execute_query(
        "SELECT id, creator_username, name, description, status, created_at FROM tasks WHERE id=?",
        (task_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="任务未找到")
    task = rows[0]
    task_name = task[2]
    task_desc = task[3] or task_name
    creator = task[1]

    # 权限：教师只能批改自己的任务
    if not is_admin(username) and creator != username:
        raise HTTPException(status_code=403, detail="无权限批改此任务")

    # 2. 查找 summary 文件
    summary_path = _find_summary_file(creator, task_name, task_id)
    if not summary_path:
        raise HTTPException(status_code=404, detail="汇总文件未找到，暂无学生提交")

    # 3. 获取 API Key 和配置
    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="API Key 未配置，请在系统配置中设置")

    api_base = get_config_value("QWEN_OPENAI_API_BASE",
                                "https://dashscope.aliyuncs.com/compatible-mode/v1")
    model = get_config_value("MODEL_LONG_NAME", "qwen-long")

    # 4. 上传 summary 文件到 DashScope
    try:
        file_id = await upload_file_to_dashscope(summary_path, api_key)
    except Exception as e:
        logger.error(f"文件上传失败: {e}")
        raise HTTPException(status_code=500, detail=f"文件上传失败: {str(e)}")

    # 5. 构建批改 prompt
    from backend.prompts.homework_grade import TASK_GRADING_PROMPT
    ai_role = build_ai_role()
    prompt = f"{ai_role}\n" + TASK_GRADING_PROMPT.format(
        subject="",
        task_name=task_name,
        task_description=task_desc,
    )
    # 注意：不注入技能 — 技能的结构化输出指令与 JSON 格式要求冲突

    # 6. 调用 qwen-long
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{api_base}/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": model,
                    "messages": [
                        {"role": "system", "content": f"{build_ai_role()}正在批改学生提交的作业对话记录。"},
                        {"role": "system", "content": f"fileid://{file_id}"},
                        {"role": "user", "content": prompt},
                    ],
                    "stream": False,
                },
                timeout=180,
            )
            if resp.status_code != 200:
                raise HTTPException(status_code=502, detail=f"AI 模型调用失败: {resp.text[:200]}")

            data = resp.json()
            ai_text = data["choices"][0]["message"]["content"]
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="AI 模型调用超时，请稍后重试")
    except Exception as e:
        logger.error(f"AI 调用失败: {e}")
        raise HTTPException(status_code=502, detail=f"AI 调用失败: {str(e)}")

    # 7. 解析 AI 返回的 JSON
    try:
        # 清理可能的 Markdown 代码块标记
        cleaned = ai_text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[-1]
            if "```" in cleaned:
                cleaned = cleaned.rsplit("```", 1)[0]
        cleaned = cleaned.strip()

        result_data = json.loads(cleaned)
        grades_list = result_data.get("grades", [])
        class_summary = result_data.get("summary", "")

        logger.info(f"AI 批改结果: {len(grades_list)} 位学生, summary={bool(class_summary)}")
    except (json.JSONDecodeError, KeyError) as e:
        logger.error(f"AI 返回解析失败: {e}, raw={ai_text[:500]}")
        raise HTTPException(status_code=502, detail=f"AI 返回格式异常: {str(e)}")

    # 8. 写入 task_grades 表
    saved = []
    for g in grades_list:
        student = g.get("student", "")
        # AI 可能从 "## 学生 xxx" 中提取出 "学生 xxx"，需要清洗前缀
        if student.startswith("学生 "):
            student = student[3:]
        score = g.get("score")
        comment = g.get("comment", "")
        feedback = g.get("feedback", "")
        strengths = g.get("strengths", [])
        weaknesses = g.get("weaknesses", [])
        if not student or score is None:
            continue

        execute_insert_update(
            """INSERT OR REPLACE INTO task_grades
               (task_id, student_username, ai_score, ai_comment, ai_feedback,
                ai_strengths, ai_weaknesses, ai_graded_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))""",
            (task_id, student, score, comment, feedback,
             json.dumps(strengths, ensure_ascii=False),
             json.dumps(weaknesses, ensure_ascii=False)),
        )
        saved.append({
            "student": student,
            "score": score,
            "comment": comment,
            "feedback": feedback,
            "strengths": strengths,
            "weaknesses": weaknesses,
        })

    # 9. 保存全班总结到 tasks 表
    summary_json = json.dumps(class_summary, ensure_ascii=False)
    execute_insert_update(
        "UPDATE tasks SET ai_summary=?, updated_at=datetime('now', 'localtime') WHERE id=?",
        (summary_json, task_id),
    )

    logger.info(f"AI 批改完成: task={task_name}, 批改人数={len(saved)}, by={username}")
    return {
        "summary": class_summary,
        "grades": saved,
        "graded_count": len(saved),
        "message": f"AI 批改完成，共批改 {len(saved)} 位学生",
    }


@router.get("/grades/{task_id}")
async def get_task_grades(task_id: str, request: Request):
    """获取任务的 AI 批改结果"""
    user = get_current_user(request)
    username = user["username"]

    # 查找任务
    rows = execute_query(
        "SELECT id, creator_username, name, ai_summary FROM tasks WHERE id=?",
        (task_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="任务未找到")

    creator = rows[0][1]
    ai_summary_raw = rows[0][3] or ""

    # 解析全班总结
    class_summary = None
    if ai_summary_raw:
        try:
            class_summary = json.loads(ai_summary_raw)
        except json.JSONDecodeError:
            pass

    # 权限验证
    if not is_admin(username) and creator != username:
        # 学生可以看自己的批改
        if not is_teacher(username) and not is_admin(username):
            rows = execute_query(
                "SELECT ai_score, ai_comment, ai_feedback, ai_strengths, ai_weaknesses, ai_graded_at "
                "FROM task_grades WHERE task_id=? AND student_username=?",
                (task_id, username),
            )
            if rows:
                r = rows[0]
                return {
                    # K2: 全班 AI 总结(含他人表现描述)不再下发给非创建者学生
                    "summary": None,
                    "grades": [{
                        "student": username,
                        "score": r[0],
                        "comment": r[1],
                        "feedback": r[2],
                        "strengths": json.loads(r[3]) if r[3] else [],
                        "weaknesses": json.loads(r[4]) if r[4] else [],
                        "graded_at": r[5],
                    }],
                    "graded_count": 1,
                }
            return {"summary": None, "grades": [], "graded_count": 0}
        raise HTTPException(status_code=403, detail="无权限查看")

    # 教师/管理员查看所有
    rows = execute_query(
        "SELECT student_username, ai_score, ai_comment, ai_feedback, ai_strengths, ai_weaknesses, ai_graded_at "
        "FROM task_grades WHERE task_id=? ORDER BY ai_score DESC",
        (task_id,),
    )
    grades = []
    for r in rows:
        grades.append({
            "student": r[0],
            "score": r[1],
            "comment": r[2],
            "feedback": r[3],
            "strengths": json.loads(r[4]) if r[4] else [],
            "weaknesses": json.loads(r[5]) if r[5] else [],
            "graded_at": r[6],
        })

    return {"summary": class_summary, "grades": grades, "graded_count": len(grades)}
