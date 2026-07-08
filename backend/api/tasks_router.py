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
from backend.utils import get_account_chat_history_dir, get_admin_chat_history_dir
from backend.database import execute_query, execute_insert_update, get_connection
from backend.logger import logger
from backend.prompts import apply_skills
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
    """获取所有活动任务"""
    user = get_current_user(request)
    target_user = request.query_params.get("user", user["username"])

    # 如果是学生，返回筛选后的任务
    if not is_admin(target_user) and not is_teacher(target_user):
        all_tasks = get_all_tasks()
        relevant = get_user_relevant_tasks(target_user, all_tasks)
        return {"tasks": relevant, "total": len(relevant)}

    tasks = get_all_tasks()
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
        "INSERT OR REPLACE INTO task_submissions (task_id, student_username, submitted_at) VALUES (?, ?, datetime('now'))",
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


# ═══════════════════════════════════════════════════════════
# AI 批改功能
# ═══════════════════════════════════════════════════════════

def _find_summary_file(creator: str, task_name: str) -> str | None:
    """查找任务的 summary 汇总文件路径"""
    admin_chat_dir = get_admin_chat_history_dir()
    paths = [
        os.path.join(str(BASE_DIR), admin_chat_dir, SUMMARY_DIR_NAME, TEACHERS_SUMMARY_DIR, creator, f"summary_{task_name}.md"),
        os.path.join(str(BASE_DIR), get_account_chat_history_dir(creator), SUMMARY_DIR_NAME, f"summary_{task_name}.md"),
        os.path.join(str(BASE_DIR), admin_chat_dir, SUMMARY_DIR_NAME, ADMIN_SUMMARY_DIR, f"summary_{creator}_{task_name}.md"),
    ]
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
    summary_path = _find_summary_file(creator, task_name)
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
    prompt = apply_skills(prompt, "practice-grading")

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
               VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))""",
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
        "UPDATE tasks SET ai_summary=?, updated_at=datetime('now') WHERE id=?",
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
                    "summary": class_summary,
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
            return {"summary": class_summary, "grades": [], "graded_count": 0}
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
