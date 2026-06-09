"""
任务管理 API 路由
创建/激活/提交/汇总
"""
import os
import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.auth import can_create_task, is_teacher, is_admin
from backend.config import (
    SUMMARY_DIR_NAME,
    TEACHERS_SUMMARY_DIR,
    ADMIN_SUMMARY_DIR,
)
from backend.utils import get_account_chat_history_dir, get_admin_chat_history_dir
from backend.database import execute_query, execute_insert_update, get_connection, execute_insert_update, get_connection
from backend.logger import logger

router = APIRouter()


class CreateTaskRequest(BaseModel):
    name: str
    description: str = ""


class SubmitTaskRequest(BaseModel):
    task_id: str
    conversation_content: str


# ── 辅助函数（数据库版）──

def _task_row_to_dict(row, submissions: list[str] | None = None) -> dict:
    """将 tasks 表行转换为前端期望的 dict 格式"""
    task = {
        "id": row[0],
        "creator": row[1],
        "name": row[2],
        "description": row[3] or "",
        "status": row[4],
        "created_time": row[5],
    }
    if submissions is not None:
        task["submissions"] = submissions
    else:
        sub_rows = execute_query(
            "SELECT student_username FROM task_submissions WHERE task_id=?", (row[0],)
        )
        task["submissions"] = [s[0] for s in sub_rows]
    return task


def _get_all_tasks() -> list[dict]:
    """从数据库获取所有活跃任务"""
    rows = execute_query(
        "SELECT id, creator_username, name, description, status, created_at FROM tasks WHERE status='active' ORDER BY created_at DESC"
    )
    return [_task_row_to_dict(row) for row in rows]


def _get_all_tasks_raw() -> list[dict]:
    """从数据库获取所有任务（含非活跃）"""
    rows = execute_query(
        "SELECT id, creator_username, name, description, status, created_at FROM tasks ORDER BY created_at DESC"
    )
    return [_task_row_to_dict(row) for row in rows]


def _get_creator_tasks(username: str) -> list[dict]:
    """获取指定创建者的所有任务"""
    rows = execute_query(
        "SELECT id, creator_username, name, description, status, created_at FROM tasks WHERE creator_username=? ORDER BY created_at DESC",
        (username,),
    )
    return [_task_row_to_dict(row) for row in rows]


def _check_task_ownership(task_id: str, username: str) -> dict | None:
    """验证当前用户是否有权操作该任务，返回任务信息或 None"""
    for task in _get_all_tasks_raw():
        if task["id"] == task_id:
            if is_admin(username) or task.get("creator") == username:
                return task
            return None
    return None


def _parse_teacher_grade_class(grade: str, class_str: str) -> dict[str, list[str]]:
    """解析教师的年级和班级字段，返回 {年级: [班级列表]} 的映射"""
    result = {}
    if not grade or not grade.strip():
        return result
    grade_parts = [g.strip() for g in grade.split("|")]
    class_parts = [c.strip() for c in class_str.split("|")] if class_str else []
    for i, g in enumerate(grade_parts):
        if not g:
            continue
        if i < len(class_parts) and class_parts[i]:
            classes = [c.strip() for c in class_parts[i].split(",") if c.strip()]
            result[g] = classes
        else:
            result[g] = []
    return result


def _get_user_relevant_tasks(student_user: str, active_tasks: list) -> list:
    """获取与学生相关的任务（基于教师任教的年级和班级匹配）

    匹配规则:
    - 教师 grade="高一|高二", class="1,2,3,4|1,2,7,8"
      → 高一教1,2,3,4班；高二教1,2,7,8班
    - 学生 grade="高一", class="3"  → 匹配（3在高一的班级列表中）
    - 管理员(root)的任务对所有学生可见
    - 教师未设置年级/班级信息时，任务对所有学生可见（兼容旧数据）
    """
    relevant = []

    # 获取学生信息
    student_rows = execute_query(
        "SELECT grade, class FROM users WHERE username=?", (student_user,)
    )
    if not student_rows:
        return relevant

    student_grade = (student_rows[0][0] or "").strip()
    student_class = str(student_rows[0][1] or "").strip()

    for task in active_tasks:
        creator = task["creator"]

        # 管理员（root）的任务对所有学生可见
        if creator == "root":
            if task not in relevant:
                relevant.append(task)
            continue

        # 只匹配教师创建的任务
        if not is_teacher(creator):
            continue

        # 获取教师的年级和班级信息
        teacher_rows = execute_query(
            "SELECT grade, class FROM users WHERE username=?", (creator,)
        )
        if not teacher_rows:
            continue

        teacher_grade = (teacher_rows[0][0] or "").strip()
        teacher_class = str(teacher_rows[0][1] or "").strip()

        # 如果教师没有设置年级班级信息，默认匹配所有学生（兼容旧数据）
        if not teacher_grade and not teacher_class:
            relevant.append(task)
            continue

        # 解析教师任教映射
        grade_class_map = _parse_teacher_grade_class(teacher_grade, teacher_class)

        # 检查学生是否匹配教师任教的某个年级和班级
        matched = False
        if student_grade and student_grade in grade_class_map:
            allowed_classes = grade_class_map[student_grade]
            if not allowed_classes:
                # 有年级但没指定具体班级，匹配该年级所有学生
                matched = True
            elif student_class in allowed_classes:
                matched = True

        if matched:
            relevant.append(task)

    return relevant


# ── API 端点 ──

@router.get("/active")
async def get_active_tasks(request: Request):
    """获取所有活动任务"""
    user = get_current_user(request)
    target_user = request.query_params.get("user", user["username"])

    # 如果是学生，返回筛选后的任务
    if not is_admin(target_user) and not is_teacher(target_user):
        all_tasks = _get_all_tasks()
        relevant = _get_user_relevant_tasks(target_user, all_tasks)
        return {"tasks": relevant, "total": len(relevant)}

    tasks = _get_all_tasks()
    # 教师只能看到自己的任务，管理员看到所有
    if not is_admin(target_user):
        tasks = [t for t in tasks if t.get("creator") == target_user]

    # 补充提交者姓名
    for task in tasks:
        usernames = task.get("submissions", [])
        if usernames:
            names = []
            for uname in usernames:
                rows = execute_query("SELECT name FROM users WHERE username=?", (uname,))
                if rows and rows[0][0]:
                    names.append(rows[0][0])
                else:
                    names.append(uname)
            task["submissions_names"] = names
        else:
            task["submissions_names"] = []
    return {"tasks": tasks, "total": 0}


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

    task_id = f"{username}_{task_name}_{int(time.time())}"
    now = time.strftime("%Y-%m-%d %H:%M:%S")

    execute_insert_update(
        "INSERT INTO tasks (id, creator_username, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
        (task_id, username, task_name, req.description.strip(), now, now),
    )

    new_task = {
        "id": task_id,
        "creator": username,
        "name": task_name,
        "description": req.description.strip(),
        "status": "active",
        "created_time": now,
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

    # 记录提交（幂等）
    execute_insert_update(
        "INSERT OR IGNORE INTO task_submissions (task_id, student_username, submitted_at) VALUES (?, ?, datetime('now'))",
        (task_info["id"], username),
    )

    # 保存到汇总文件
    _save_to_summary(creator, task_info["name"], username, req.conversation_content)

    # ── 任务提交积分奖励（仅学生） ──
    if user.get("role") == 2:
        try:
            from backend.reward_engine import award_participation
            award_participation(username, "task", str(task_info["id"]), task_info["name"])
        except Exception:
            pass

    logger.info(f"任务已提交: {task_info['name']}, student={username}")
    return {"message": f"已提交到任务 '{task_info['name']}'"}


def _save_to_summary(creator: str, task_name: str, student: str, content: str):
    """保存提交到汇总文件"""
    admin_chat_dir = get_admin_chat_history_dir()

    paths = [
        os.path.join(admin_chat_dir, SUMMARY_DIR_NAME, TEACHERS_SUMMARY_DIR, creator, f"summary_{task_name}.md"),
        os.path.join(get_account_chat_history_dir(creator), SUMMARY_DIR_NAME, f"summary_{task_name}.md"),
        os.path.join(admin_chat_dir, SUMMARY_DIR_NAME, ADMIN_SUMMARY_DIR, f"summary_{creator}_{task_name}.md"),
    ]

    for path in paths:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        file_exists = os.path.exists(path)
        with open(path, "a", encoding="utf-8") as f:
            if not file_exists:
                f.write(f"# 任务汇总\n\n创建时间: {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n---\n\n")
            f.write(f"## 学生 {student}\n\n")
            f.write(f"提交时间: {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n")
            f.write(f"内容:\n{content}\n\n---\n\n")


@router.get("/user")
async def get_user_tasks(request: Request):
    """获取当前用户的活动任务"""
    user = get_current_user(request)
    username = user["username"]

    active_tasks = _get_all_tasks()
    relevant = _get_user_relevant_tasks(username, active_tasks)

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
        c.execute("DELETE FROM tasks WHERE id=?", (task_id,))
        conn.commit()

    logger.info(f"任务已删除: {task_id}, by={username}")
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
    """从学生的 ChatHistory 中读取提交到该任务的对话文件"""
    from backend.config import BASE_DIR
    student_dir = get_account_chat_history_dir(student)
    full_path = os.path.join(str(BASE_DIR), student_dir)

    if not os.path.isdir(full_path):
        return ""

    # 在所有日期目录中查找 task_{task_name}_*.md，取最新的
    import glob
    pattern = f"task_{task_name}_*.md"
    matches = []
    for root, dirs, files in os.walk(full_path):
        for f in files:
            if f.startswith(f"task_{task_name}_") and f.endswith(".md"):
                matches.append(os.path.join(root, f))

    if not matches:
        return ""

    # 按修改时间取最新的文件
    matches.sort(key=os.path.getmtime, reverse=True)
    try:
        with open(matches[0], "r", encoding="utf-8") as f:
            content = f.read()
        # 去掉文件头部的创建时间信息，只保留对话内容
        if "---" in content:
            parts = content.split("---", 1)
            if len(parts) > 1:
                return parts[1].strip()
        return content.strip()
    except Exception:
        return ""


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
    creator_tasks = _load_user_active_tasks(creator)

    found = False
    for task in creator_tasks["tasks"]:
        if task["id"] == task_id:
            if student in task["submissions"]:
                task["submissions"].remove(student)
                found = True
            break

    if not found:
        raise HTTPException(status_code=404, detail=f"未找到学生 {student} 的提交记录")

    _save_user_active_tasks(creator, creator_tasks)
    _update_unified_tasks_file()

    # 也从汇总文件中移除该学生的记录
    _remove_student_from_summary(creator, task_info["name"], student)

    logger.info(f"提交已回退: task={task_info['name']}, student={student}, by={username}")
    return {"message": f"已回退学生 {student} 的提交"}


def _remove_student_from_summary(creator: str, task_name: str, student: str):
    """从汇总文件中移除某学生的提交记录"""
    admin_chat_dir = get_admin_chat_history_dir()
    paths = [
        os.path.join(admin_chat_dir, SUMMARY_DIR_NAME, TEACHERS_SUMMARY_DIR, creator, f"summary_{task_name}.md"),
        os.path.join(get_account_chat_history_dir(creator), SUMMARY_DIR_NAME, f"summary_{task_name}.md"),
        os.path.join(admin_chat_dir, SUMMARY_DIR_NAME, ADMIN_SUMMARY_DIR, f"summary_{creator}_{task_name}.md"),
    ]

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
