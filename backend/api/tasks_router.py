"""
任务管理 API 路由
创建/激活/提交/汇总/AI 批改
"""
import asyncio
import json
import os
import re
import time
from types import SimpleNamespace
from typing import Any

import httpx
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.auth import can_create_task, is_teacher, is_admin
from backend.api.chat_router import get_api_keys, upload_file_to_dashscope
from backend.prompts import build_ai_role
from backend.permission_service import check_activity_visibility
from backend.api.config_router import get_config_value
from backend.model_catalog import DEFAULT_LONG_MODEL
from backend.config import (
    STU_DIR,
    SUMMARY_DIR_NAME,
    TEACHERS_SUMMARY_DIR,
    ADMIN_SUMMARY_DIR,
    BASE_DIR,
    ai_api_base,
)
from backend.utils import get_account_chat_history_dir, get_admin_chat_history_dir, path_within

from backend.database import (
    execute_query, execute_query_dict, execute_insert_update, get_connection,
)
from backend import homework
from backend.logger import logger

# K4: 任务字段上限与目标范围白名单
TASK_NAME_MAX = 60
TASK_DESC_MAX = 5000
SUBMIT_CONTENT_MAX = 200_000        # K3: 单次提交内容上限(约 200KB)
TASK_TARGET_SCOPES = {"all", "teacher_classes", "grade", "class", "individual"}
TASK_SUBMIT_MODES = {"conversation", "file", "mixed"}
TASK_GRADING_POLICIES = {"ai_then_review", "manual_only", "ai_auto_publish"}
FILE_NOTE_MAX = 5000                  # mixed 模式的文字说明上限
RUBRIC_MAX_DIMS = 8
_HW_EDITABLE = {"submit_mode", "allowed_exts", "max_files", "max_file_mb", "deadline_at",
                "resubmit_limit", "allow_late", "total_score", "rubric", "grading_policy"}

# 文件作业用到的列很多，逐处手写 SELECT 清单迟早和 _task_row_to_dict 的位置索引漂移，
# 所以统一用这一份常量：新增列只能往末尾加（老查询只取前几列时靠 len(row) 兜底）。
_TASK_COLS = ("id, creator_username, name, description, status, created_at, target_scope, "
              "target_grade, target_class, target_users, subject, submit_mode, allowed_exts, "
              "max_files, max_file_mb, deadline_at, resubmit_limit, allow_late, total_score, "
              "rubric, grading_policy, publish_status")


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


def _norm_deadline(raw: Any) -> str:
    """把浏览器 datetime-local('2026-10-30T18:00') / 只给日期 / 完整时间统一成
    'YYYY-MM-DD HH:MM:SS'（本地时间，与全站 datetime('now','localtime') 同口径）。
    只给日期时补到当天 23:59:59 —— 教师写"10月30日"意指当天晚上都算按时。
    """
    text = str(raw or "").strip().replace("T", " ")
    if not text:
        return ""
    from datetime import datetime as _dt
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d", "%Y/%m/%d %H:%M", "%Y/%m/%d"):
        try:
            d = _dt.strptime(text, fmt)
            if fmt in ("%Y-%m-%d", "%Y/%m/%d"):
                d = d.replace(hour=23, minute=59, second=59)
            return d.strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
    raise HTTPException(status_code=400, detail="截止时间格式不对，请用 2026-10-30 18:00 这种形式")


def _norm_exts(raw: Any) -> str:
    """任务级白名单：小写、补点、去重，并校验都在系统允许范围内"""
    text = str(raw or "").strip()
    if not text:
        return ""
    allowed = set(homework.default_allowed_exts())
    out: list[str] = []
    for one in re.split(r"[,;、\s]+", text):
        ext = one.strip().lower()
        if not ext:
            continue
        if not ext.startswith("."):
            ext = "." + ext
        if ext not in allowed:
            raise HTTPException(status_code=400,
                                detail=f"不支持的文件类型 {ext}（管理员允许的类型: {'、'.join(sorted(allowed))}）")
        if ext not in out:
            out.append(ext)
    return ",".join(out)


def _norm_rubric(raw: Any, total_score: float) -> str:
    """评分维度 JSON 校验：名称非空、分值非负、维度数受限；空则返回空串(用默认四维)"""
    text = str(raw or "").strip()
    if not text:
        return ""
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        try:
            data = json.loads(text.replace("\'", "'"))
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="评分维度格式不对，应为 [{\"name\":\"内容\",\"max\":40}]")
    if isinstance(data, dict):
        data = data.get("dims")
    if not isinstance(data, list) or not data:
        raise HTTPException(status_code=400, detail="评分维度至少一项")
    dims: list[dict[str, Any]] = []
    for one in data[:RUBRIC_MAX_DIMS]:
        if not isinstance(one, dict):
            continue
        name = str(one.get("name") or one.get("label") or "").strip()[:20]
        try:
            mx = float(one.get("max") or one.get("score") or 0)
        except (TypeError, ValueError):
            mx = 0.0
        if not name or mx < 0:
            continue
        dims.append({"name": name, "max": round(mx, 1)})
    if not dims:
        raise HTTPException(status_code=400, detail="评分维度没有有效项（需要名称 + 分值）")
    total = sum(d["max"] for d in dims)
    if total > 0 and abs(total - float(total_score)) > 0.5:
        # 不阻断教师：按比例归一到满分，避免"维度之和 ≠ 总分"导致 AI 维度分与总分打架
        k = float(total_score) / total
        for d in dims:
            d["max"] = round(d["max"] * k, 1)
        logger.info(f"[作业维度] 维度分值之和 {total:g} ≠ 满分 {total_score:g}，已按比例归一")
    return json.dumps(dims, ensure_ascii=False)


def _norm_hw_fields(req: Any) -> dict[str, Any]:
    """把创建/编辑请求里的文件作业字段清洗成可落库的一组值"""
    mode = str(getattr(req, "submit_mode", "conversation") or "conversation").strip()
    if mode not in TASK_SUBMIT_MODES:
        raise HTTPException(status_code=400, detail="提交方式无效")
    policy = str(getattr(req, "grading_policy", "ai_then_review") or "ai_then_review").strip()
    if policy not in TASK_GRADING_POLICIES:
        raise HTTPException(status_code=400, detail="批改策略无效")
    try:
        total = float(getattr(req, "total_score", 100) or 100)
    except (TypeError, ValueError):
        total = 100.0
    total = max(1.0, min(1000.0, total))
    cap_mb = homework._cfg_int("HOMEWORK_MAX_FILE_MB", homework.DEFAULT_MAX_FILE_MB)
    try:
        mb = int(getattr(req, "max_file_mb", homework.DEFAULT_MAX_FILE_MB) or 0)
    except (TypeError, ValueError):
        mb = 0
    mb = max(1, min(mb or cap_mb, cap_mb))          # 系统配置是硬上限，教师只能往下调
    try:
        mf = int(getattr(req, "max_files", homework.DEFAULT_MAX_FILES) or 0)
    except (TypeError, ValueError):
        mf = 0
    mf = max(1, min(mf or homework.DEFAULT_MAX_FILES, 10))
    try:
        rl = int(getattr(req, "resubmit_limit", 3))
    except (TypeError, ValueError):
        rl = 3
    rl = max(0, min(rl, 20))                        # 0 = 不限次数
    return {
        "submit_mode": mode,
        "allowed_exts": _norm_exts(getattr(req, "allowed_exts", "")),
        "max_files": mf,
        "max_file_mb": mb,
        "deadline_at": _norm_deadline(getattr(req, "deadline_at", "")),
        "resubmit_limit": rl,
        "allow_late": 1 if int(getattr(req, "allow_late", 1) or 0) else 0,
        "total_score": total,
        "rubric": _norm_rubric(getattr(req, "rubric", ""), total) if mode != "conversation" else "",
        "grading_policy": policy,
    }


class SubmitTaskRequest(BaseModel):
    task_id: str
    conversation_content: str


class CreateTaskRequest(BaseModel):
    name: str
    description: str = ""
    subject: str = ""          # 学科（对话作业的创建弹窗里选的，落库后活动监控/列表才显示得出科目）
    target_scope: str = "teacher_classes"
    target_grade: str = ""
    target_class: str = ""
    target_users: str = ""
    # ── 文件提交类作业（submit_mode != conversation 时才有意义）──
    submit_mode: str = "conversation"     # conversation=交对话记录 | file=交文件 | mixed=文件+说明
    allowed_exts: str = ""               # 空=用系统默认白名单
    max_files: int = homework.DEFAULT_MAX_FILES
    max_file_mb: int = homework.DEFAULT_MAX_FILE_MB
    deadline_at: str = ""                # 'YYYY-MM-DD HH:MM:SS'，空=不限
    resubmit_limit: int = 3              # 可提交次数(含首次)，0=不限
    allow_late: int = 1                  # 截止后仍可提交，只标迟交不扣分
    total_score: float = 100
    rubric: str = ""                     # 评分维度 JSON，空=用默认四维
    grading_policy: str = "ai_then_review"


class GradeReviewRequest(BaseModel):
    """教师复核：改分/改评语（AI 原分保留，学生端以教师分为准）"""
    student: str
    score: float | None = None
    comment: str | None = None
    feedback: str | None = None
    needs_review: bool | None = None


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
        # 学科：追加在最后（老查询只取前 6 列，这里给空串给界面显示"-"）
        "subject": (row[10] if len(row) > 10 else "") or "",
    }
    # ── 文件作业字段（同样只在取到列时才有值；老的 6 列/11 列查询走默认）──
    if len(row) > 11:
        task.update({
            "submit_mode": row[11] or "conversation",
            "allowed_exts": row[12] or "",
            "max_files": int(row[13] or homework.DEFAULT_MAX_FILES),
            "max_file_mb": int(row[14] or homework.DEFAULT_MAX_FILE_MB),
            "deadline_at": row[15] or "",
            "resubmit_limit": int(row[16] if row[16] is not None else 3),
            "allow_late": int(row[17] if row[17] is not None else 1),
            "total_score": float(row[18] or 100),
            "rubric": row[19] or "",
            "grading_policy": row[20] or "ai_then_review",
            "publish_status": row[21] or "draft",
        })
    else:
        task["submit_mode"] = "conversation"
    task.setdefault("total_score", 100)
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
        f"SELECT {_TASK_COLS} FROM tasks WHERE status='active' ORDER BY created_at DESC"
    )
    return [_task_row_to_dict(row) for row in rows]


def _get_all_tasks_raw() -> list[dict[str, Any]]:
    """从数据库获取所有任务（含非活跃）"""
    rows = execute_query(
        f"SELECT {_TASK_COLS} FROM tasks ORDER BY created_at DESC"
    )
    return [_task_row_to_dict(row) for row in rows]


def _get_creator_tasks(username: str) -> list[dict[str, Any]]:  # type: ignore[valid-type]
    """获取指定创建者的所有任务"""
    rows = execute_query(
        f"SELECT {_TASK_COLS} FROM tasks WHERE creator_username=? ORDER BY created_at DESC",
        (username,),
    )
    return [_task_row_to_dict(row) for row in rows]


def _check_task_ownership(task_id: str, username: str) -> dict[str, Any] | None:
    """验证当前用户是否有权操作该任务，返回任务信息或 None"""
    rows = execute_query(f"SELECT {_TASK_COLS} FROM tasks WHERE id=?", (task_id,))
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

    # 待批改份数: 有提交但还没有批改结果的（首页「待批改任务」直达本列表时按它筛选）
    task_ids = [t["id"] for t in tasks]
    graded_map: dict[str, int] = {}
    if task_ids:
        ph = ",".join("?" for _ in task_ids)
        for r in execute_query(
            f"SELECT task_id, COUNT(*) FROM task_grades WHERE task_id IN ({ph}) GROUP BY task_id",
            tuple(task_ids),
        ):
            graded_map[r[0]] = r[1]
    for task in tasks:
        graded = graded_map.get(task["id"], 0)
        task["graded_count"] = graded
        task["pending_grade_count"] = max(0, len(task.get("submissions") or []) - graded)
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
    hw = _norm_hw_fields(req)

    import uuid
    task_id = f"{username}_{task_name}_{int(time.time())}_{uuid.uuid4().hex[:8]}"
    now = time.strftime("%Y-%m-%d %H:%M:%S")

    # 23 列的 INSERT 用命名参数：位置参数少写一个 ? 只会得到「22 values for 23 columns」，
    # 列名与参数一一对上，改字段时不可能漏。
    execute_insert_update(
        """INSERT INTO tasks (id, creator_username, name, description, subject, status, created_at, updated_at,
                              target_scope, target_grade, target_class, target_users,
                              submit_mode, allowed_exts, max_files, max_file_mb, deadline_at,
                              resubmit_limit, allow_late, total_score, rubric, grading_policy, publish_status)
           VALUES (:id, :creator, :name, :description, :subject, 'active', :now, :now,
                   :target_scope, :target_grade, :target_class, :target_users,
                   :submit_mode, :allowed_exts, :max_files, :max_file_mb, :deadline_at,
                   :resubmit_limit, :allow_late, :total_score, :rubric, :grading_policy, 'draft')""",
        {"id": task_id, "creator": username, "name": task_name,
         "description": req.description.strip(), "subject": (req.subject or "").strip(), "now": now,
         "target_scope": req.target_scope, "target_grade": req.target_grade,
         "target_class": req.target_class, "target_users": req.target_users,
         **hw},
    )

    new_task = {
        "id": task_id,
        "creator": username,
        "name": task_name,
        "description": req.description.strip(),
        "subject": (req.subject or "").strip(),
        "status": "active",
        "created_time": now,
        "target_scope": req.target_scope,
        "target_grade": req.target_grade,
        "target_class": req.target_class,
        "target_users": req.target_users,
        "submissions": [],
        **hw,
    }

    logger.info(f"任务已创建: {task_name}, creator={username}, mode={hw['submit_mode']}")
    return {"task": new_task, "message": f"任务 '{task_name}' 创建成功"}


class UpdateTaskRequest(BaseModel):
    task_id: str
    name: str | None = None
    description: str | None = None
    subject: str | None = None
    # 文件作业可调项（提交方式除外，见 update_task 里的锁）
    submit_mode: str | None = None
    allowed_exts: str | None = None
    max_files: int | None = None
    max_file_mb: int | None = None
    deadline_at: str | None = None
    resubmit_limit: int | None = None
    allow_late: int | None = None
    total_score: float | None = None
    rubric: str | None = None
    grading_policy: str | None = None


@router.put("/update")
async def update_task(req: UpdateTaskRequest, request: Request):
    """编辑任务：名称 / 要求 / 学科。

    只放开这三项 —— 目标范围与状态决定"谁能看到、还能不能交"，改动影响已发布的活动，
    要改得走专门流程，这里不碰。以前对话作业完全没有编辑入口，学科（新加的字段）
    在存量作业上也就无从补起。
    """
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    rows = execute_query("SELECT creator_username FROM tasks WHERE id=?", (req.task_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="任务不存在")
    if role != 0 and rows[0][0] != username:
        raise HTTPException(status_code=403, detail="只能编辑自己创建的作业")

    fields: list[str] = []
    params: list[Any] = []
    if req.name is not None:
        name = req.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="任务名称不能为空")
        if len(name) > TASK_NAME_MAX:
            raise HTTPException(status_code=400, detail=f"任务名称最长 {TASK_NAME_MAX} 字")
        fields.append("name=?")
        params.append(name)
    if req.description is not None:
        desc = req.description.strip()
        if len(desc) > TASK_DESC_MAX:
            raise HTTPException(status_code=400, detail=f"任务描述最长 {TASK_DESC_MAX} 字")
        fields.append("description=?")
        params.append(desc)
    if req.subject is not None:
        fields.append("subject=?")
        params.append(req.subject.strip())
    if not fields:
        return {"message": "没有需要更新的字段"}

    # ── 文件作业字段：截止/限额/维度随时可改，提交方式在有人交过之后锁死 ──
    # 归一化必须拿「现值」当底座：只改维度却按默认的满分 100 归一，会把维度分算错。
    hw_patch = {f: v for f, v in req.model_dump().items() if f in _HW_EDITABLE and v is not None}
    if hw_patch:
        cur_rows = execute_query_dict(f"SELECT {_TASK_COLS} FROM tasks WHERE id=?", (req.task_id,))
        cur = cur_rows[0] if cur_rows else {}
        merged = {f: cur.get(f) for f in _HW_EDITABLE}
        merged.update(hw_patch)
        if not merged.get("total_score"):
            merged["total_score"] = 100
        hw = _norm_hw_fields(SimpleNamespace(**merged))
        submitted = execute_query(
            "SELECT COUNT(*) FROM task_submissions WHERE task_id=?", (req.task_id,))
        has_sub = bool(submitted and submitted[0][0])
        for col, val in hw.items():
            if col not in hw_patch:
                continue                     # 教师没改的字段不写回，避免默认值覆盖现值
            if col == "submit_mode" and has_sub and val != (cur.get("submit_mode") or "conversation"):
                raise HTTPException(status_code=400,
                                    detail="已有学生提交，不能改提交方式（要换形态请新建作业）")
            fields.append(f"{col}=?")
            params.append(val)

    fields.append("updated_at=?")
    params.append(time.strftime("%Y-%m-%d %H:%M:%S"))
    params.append(req.task_id)
    execute_insert_update(f"UPDATE tasks SET {', '.join(fields)} WHERE id=?", tuple(params))
    logger.info(f"任务已更新: {req.task_id}, by={username}, fields={[f.split('=')[0] for f in fields]}")

    row = execute_query(f"SELECT {_TASK_COLS} FROM tasks WHERE id=?", (req.task_id,))
    return {"task": _task_row_to_dict(row[0]) if row else None, "message": "作业已更新"}


def _strip_json_fence(text: str) -> str:
    """去掉模型偶尔加上的 ```json 代码块围栏，否则 JSON 容错层也解不开"""
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1]
        if "```" in cleaned:
            cleaned = cleaned.rsplit("```", 1)[0]
    return cleaned.strip()


# AI 起草时允许学生提交的文件类型（模型给多了会被这里裁掉，避免起草结果落不了库）
_DRAFT_FILE_TYPES = {
    "docx": [".docx"],
    "pdf": [".pdf"],
    "xlsx": [".xlsx"],
    "pptx": [".pptx"],
    "image": [".jpg", ".jpeg", ".png", ".webp"],
    "text": [".txt", ".md"],
}


@router.post("/ai-create-draft")
async def ai_create_homework_draft(request: Request):
    """✨ AI 起草作业：教师给一句想法，返回名称与要求草稿（不落库，教师改完再创建）

    两种形态各用一套 prompt：对话作业要写"怎么和 AI 聊"，文件作业要写"交什么文件 + 评分维度"。
    以前只有对话作业那一份，教师先切成"交文件"再点 AI 起草，出来的仍是"去和 AI 对话"的要求，
    只能整段重打 —— 起草必须跟着形态走。
    """
    user = get_current_user(request)
    username = user["username"]
    if not can_create_task(username):
        raise HTTPException(status_code=403, detail="权限不足")

    body = await request.json()
    idea = str(body.get("idea", "")).strip()[:500]
    if not idea:
        raise HTTPException(status_code=400, detail="请先描述作业主题或想法")

    audience_parts = [x for x in (str(body.get("grade", "")).strip(),
                                  str(body.get("class", "")).strip()) if x]
    audience = "、".join(audience_parts) or "全班学生"
    duration = str(body.get("duration_minutes", "") or "").strip() or "不限"
    mode = str(body.get("submit_mode") or "conversation").strip()
    if mode not in TASK_SUBMIT_MODES:
        mode = "conversation"
    try:
        total_score = float(body.get("total_score") or 100)
    except (TypeError, ValueError):
        total_score = 100.0
    total_score = max(1.0, min(1000.0, total_score))

    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="API Key 未配置，请在系统配置中设置")

    from backend.prompts.homework_grade import FILE_DRAFT_PROMPT, TASK_DRAFT_PROMPT
    from backend.api.ai_service import call_ai_async
    if mode == "conversation":
        prompt = TASK_DRAFT_PROMPT.format(idea=idea, audience=audience, duration=duration)
    else:
        prompt = FILE_DRAFT_PROMPT.format(idea=idea, audience=audience, duration=duration,
                                          total_score=f"{total_score:g}")
    try:
        ai_text = await call_ai_async(prompt, api_key, json_mode=True, use_kb=False, max_tokens=1500)
    except Exception as e:
        logger.error(f"[作业起草] AI 调用失败 by={username}: {e}")
        raise HTTPException(status_code=502, detail=f"AI 起草失败: {str(e)}")

    from backend import ai_json
    draft = ai_json.try_parse(_strip_json_fence(ai_text))
    if not isinstance(draft, dict):
        logger.error(f"[作业起草] 返回格式异常 by={username}: raw={ai_text[:300]}")
        raise HTTPException(status_code=502, detail="AI 返回格式异常，请重试")

    name = str(draft.get("name") or "").strip()[:TASK_NAME_MAX]
    # 模型经常把"提交物/要求点/评分侧重"写成一整行 —— 不重排的话，教师看到的
    # 就是一堵没有换行的墙（要求框里根本没法逐条核对）
    description = homework.format_requirement(
        str(draft.get("description") or ""))[:TASK_DESC_MAX]
    if not name or not description:
        raise HTTPException(status_code=502, detail="AI 未生成有效草稿，请换个说法再试")
    try:
        minutes = int(draft.get("duration_minutes") or 0)
    except (TypeError, ValueError):
        minutes = 0

    out: dict[str, Any] = {
        "name": name,
        "description": description,
        "duration_minutes": minutes,
        "tips": str(draft.get("tips") or "").strip()[:300],
        "submit_mode": mode,
    }

    if mode != "conversation":
        # 维度：只收合法项，分值按满分归一，保证"维度之和 = 总分"
        raw_dims = draft.get("dims") or draft.get("rubric") or []
        dims: list[dict[str, Any]] = []
        for one in raw_dims if isinstance(raw_dims, list) else []:
            if not isinstance(one, dict):
                continue
            dname = str(one.get("name") or one.get("label") or "").strip()[:20]
            try:
                dmax = float(one.get("max") or one.get("score") or 0)
            except (TypeError, ValueError):
                dmax = 0.0
            if dname and dmax > 0:
                dims.append({"name": dname, "max": round(dmax, 1)})
        if dims:
            total = sum(d["max"] for d in dims)
            k = total_score / total if total > 0 else 1
            for d in dims:
                d["max"] = round(d["max"] * k, 1)
            out["rubric"] = json.dumps(dims, ensure_ascii=False)
            out["dims"] = dims

        # 文件类型：模型给的不认就丢掉，全丢就用系统默认白名单
        allowed = homework.default_allowed_exts()
        exts: list[str] = []
        raw_types = draft.get("file_types") or draft.get("types") or []
        for one in raw_types if isinstance(raw_types, list) else []:
            for ext in _DRAFT_FILE_TYPES.get(str(one).strip().lower(), []):
                if ext in allowed and ext not in exts:
                    exts.append(ext)
        if exts:
            out["allowed_exts"] = ",".join(exts)

    logger.info(f"[作业起草] 完成 by={username}, name={name}, mode={mode}")
    return out

@router.post("/submit")
async def submit_task(req: SubmitTaskRequest, request: Request):
    """提交到任务"""
    user = get_current_user(request)
    username = user["username"]

    # 查找任务（数据库）
    # 必须取全列：submit_mode 在后面的列上，只取前 6 列会让"文件作业不能交对话记录"的保护
    # 读不到真实形态而形同虚设
    rows = execute_query(
        f"SELECT {_TASK_COLS} FROM tasks WHERE id=? AND status='active'", (req.task_id,))
    if rows:
        task_info = _task_row_to_dict(rows[0])
    else:
        # 兼容按名称查找
        rows2 = execute_query(
            f"SELECT {_TASK_COLS} FROM tasks WHERE name=? AND status='active' LIMIT 1",
            (req.task_id,),
        )
        if rows2:
            task_info = _task_row_to_dict(rows2[0])
        else:
            raise HTTPException(status_code=404, detail="任务未找到")

    creator = task_info["creator"]
    target_scope = task_info.get("target_scope", "teacher_classes")

    # 文件类作业（交文件 / 文件+说明）都不能走这个入口：正文在上传的文件里，
    # 粘一段对话记录进来只会把批改依据带偏。mixed 以前没关，导致出现
    # "只交了文字没交文件"的提交 —— 它进不了批改包却计入已交人数，现已一并收紧。
    if (task_info.get("submit_mode") or "conversation") in ("file", "mixed"):
        raise HTTPException(status_code=400, detail="该作业要求上传文件提交，请在提交区上传文件")

    # 权限校验：学生只能提交到可见范围内的任务（与文件提交共用 _assert_submit_visible）
    _assert_submit_visible(user, task_info)

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
    from backend.reward_engine import activity_reward_students, recompute_students
    _affected = activity_reward_students([("task", task_id)])   # 事务内取不到名单，删前先记
    with get_connection() as conn:
        c = conn.cursor()
        c.execute("DELETE FROM task_submissions WHERE task_id=?", (task_id,))
        c.execute("DELETE FROM task_grades WHERE task_id=?", (task_id,))
        c.execute("DELETE FROM activity_rewards WHERE activity_type='task' AND activity_id=?", (task_id,))
        c.execute("DELETE FROM notifications WHERE source_type='task' AND source_id=?", (task_id,))
        c.execute("DELETE FROM homework_files WHERE task_id=?", (task_id,))
        c.execute("DELETE FROM tasks WHERE id=?", (task_id,))
        conn.commit()

    recompute_students(_affected)   # 缺陷A：必须在 commit 之后，否则与事务写锁互撞
    # K9: 汇总文件一并清理, 不再残留给同名新任务
    purged = _purge_summary_files(task_info["creator"], task_info["name"], task_id)
    # 作业文件同样不能只删库留盘（一学期下来磁盘会被撑爆）
    hw_removed = purge_task_files_on_disk(task_id)
    logger.info(f"任务已删除: {task_id}, by={username}, 清理汇总文件 {purged} 个, "
                f"作业文件 {hw_removed} 个")
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
        content = _read_student_submission(creator, task_info["name"], student, task_info["id"])

    # 提交名单补年级班级(此前只有学号+姓名)
    from backend.permission_service import attach_student_info
    attach_student_info(result, key="username", prefix="")
    return {
        "task_name": task_info["name"],
        "task_status": task_info["status"],
        "submissions": result,
        "submission_count": len(result),
        "student_content": content if student else None,
    }


def _read_student_submission(creator: str, task_name: str, student: str, task_id: str = "") -> str:
    """从汇总文件中读取指定学生的提交内容。

    修复: 旧实现用未净化的"summary_{任务名}.md"拼读路径, 而提交流程写的是
    "summary_{任务名}_{任务指纹}.md"(K3 净化 + 指纹命名), 读写路径不一致,
    教师点"查看提交内容"永远为空(数据其实在盘上)。现与写入端统一走
    _summary_paths(带指纹) + _summary_paths_legacy(历史兼容) 逐个探测。
    """
    marker = f"## 学生 {student}"
    next_marker = "\n## 学生 "
    # 同一提交会写到多个候选位置(teachers/个人/admin), 互为副本:
    # 找到第一个包含该学生标记的文件即返回, 避免跨文件重复拼接
    paths = _summary_paths(creator, task_name, task_id) + _summary_paths_legacy(creator, task_name)
    for summary_path in paths:
        if not os.path.isfile(summary_path):
            continue
        try:
            with open(summary_path, "r", encoding="utf-8") as f:
                content = f.read()
        except Exception:
            continue
        content = content.replace("\r\n", "\n")
        if marker not in content:
            continue

        all_chunks = []
        for part in content.split(marker):
            if not part.strip():
                continue
            if next_marker in part:
                student_chunk = part.split(next_marker, 1)[0]
            else:
                student_chunk = part

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
            # 去掉块尾部的分隔线残留
            while chunk_text.endswith("---"):
                chunk_text = chunk_text[:-3].rstrip()
            if chunk_text:
                all_chunks.append(chunk_text)

        if all_chunks:
            return "\n\n---\n\n".join(all_chunks)
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

    # 文件作业：该生交过的文件与批次记录一并清掉，不然回退了盘上还留着原件
    _hw_rows = execute_query_dict(
        "SELECT stored_path FROM homework_files WHERE task_id=? AND student_username=?",
        (task_id, student))
    if _hw_rows:
        execute_insert_update(
            "DELETE FROM homework_files WHERE task_id=? AND student_username=?", (task_id, student))
        _paths = {r["stored_path"] for r in _hw_rows}
        for sp in _paths:
            pth = homework.resolve_stored(sp)
            if pth:
                try:
                    os.remove(str(pth))
                except OSError:
                    pass
        purge_task_files_on_disk(task_id, [student])

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

def _grading_basis(task_name: str, task_desc: str) -> str:
    """把教师填的任务名称/任务说明渲染成 AI 的批改依据文本。

    没填要求时不直接失败：让模型按任务名称推断主题，但要求它在评语里说明依据有限，
    前端也会提示教师补写要求以提高批改准确度。
    """
    from backend.prompts.homework_grade import GRADING_BASIS
    desc = (task_desc or "").strip() or "（教师未填写作业要求，请按任务名称推断主题与合理期望，并在评语中说明依据有限）"
    return GRADING_BASIS.format(task_name=task_name, task_description=desc)


def _normalize_criteria(raw: Any) -> list[dict[str, str]]:
    """要求点判定归一化为 [{item, status, evidence}]，供教师逐条对照批改依据"""
    if not isinstance(raw, list):
        return []
    allowed = {"met": "met", "partial": "partial", "missing": "missing",
               "true": "met", "false": "missing",
               "达成": "met", "部分达成": "partial", "缺失": "missing", "未达成": "missing"}
    out: list[dict[str, str]] = []
    for one in raw:
        if isinstance(one, str):
            one = {"item": one, "status": "partial", "evidence": ""}
        if not isinstance(one, dict):
            continue
        item = str(one.get("item") or one.get("requirement") or "").strip()
        if not item:
            continue
        status = str(one.get("status") or one.get("met") or "").strip().lower()
        out.append({
            "item": item[:120],
            "status": allowed.get(status, "partial"),
            "evidence": str(one.get("evidence") or one.get("note") or "").strip()[:200],
        })
        if len(out) >= 8:
            break
    return out


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

    api_base = ai_api_base()
    model = get_config_value("MODEL_LONG_NAME", DEFAULT_LONG_MODEL)

    # 4. 上传 summary 文件到 DashScope
    try:
        file_id = await upload_file_to_dashscope(summary_path, api_key)
    except Exception as e:
        logger.error(f"文件上传失败: {e}")
        raise HTTPException(status_code=500, detail=f"文件上传失败: {str(e)}")

    # 5. 构建批改 prompt（批改依据 = 教师填的任务名称 + 任务说明）
    from backend.prompts.homework_grade import TASK_GRADING_PROMPT
    ai_role = build_ai_role()
    prompt = f"{ai_role}\n" + TASK_GRADING_PROMPT.format(
        basis=_grading_basis(task_name, task_desc),
    )
    # 注意：不注入技能 — 技能的结构化输出指令与 JSON 格式要求冲突

    # 6. 调用 qwen-long
    try:
        async with httpx.AsyncClient() as client:
            req_payload = {
                "model": model,
                "messages": [
                    {"role": "system", "content": f"{build_ai_role()}正在批改学生提交的作业对话记录。"},
                    {"role": "system", "content": f"fileid://{file_id}"},
                    {"role": "user", "content": prompt},
                ],
                "stream": False,
                # 批改结果必须是 JSON：网关层强制合法格式，杜绝「AI 返回格式异常」
                "response_format": {"type": "json_object"},
            }
            resp = await client.post(
                f"{api_base}/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=req_payload,
                timeout=300,
            )
            if resp.status_code == 400 and "response_format" in req_payload:
                req_payload.pop("response_format")  # 网关不支持时降级重试
                resp = await client.post(
                    f"{api_base}/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json=req_payload,
                    timeout=300,
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

        from backend import ai_json
        result_data = ai_json.try_parse(cleaned)
        if result_data is None:
            raise ValueError("AI 返回格式异常（容错层亦无法解析）")
        grades_list = result_data.get("grades", [])
        class_summary = result_data.get("summary", "")

        logger.info(f"AI 批改结果: {len(grades_list)} 位学生, summary={bool(class_summary)}")
    except (json.JSONDecodeError, KeyError) as e:
        logger.error(f"AI 返回解析失败: {e}, raw={ai_text[:500]}")
        raise HTTPException(status_code=502, detail=f"AI 返回格式异常: {str(e)}")

    # 8. 写入 task_grades 表
    # 缺陷B：上面的 AI 调用最长 180s，这期间任务可能已被删除或被"重置数据"清空提交，
    # 直接回写就会留下没有提交、没有归属的孤儿成绩（列表与统计都会读到）。
    saved = []
    skipped_gone: list[str] = []
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
        criteria = _normalize_criteria(g.get("criteria"))
        if not student or score is None:
            continue

        if not execute_query(
            "SELECT 1 FROM task_submissions WHERE task_id=? AND student_username=?",
            (task_id, student),
        ):
            skipped_gone.append(student)
            continue
        execute_insert_update(
            # SELECT ... WHERE EXISTS 由数据库保证"提交还在才写"，
            # 覆盖上面检查与写入之间的竞态窗口（VALUES 写法做不到这一点）
            """INSERT OR REPLACE INTO task_grades
               (task_id, student_username, ai_score, ai_comment, ai_feedback,
                ai_strengths, ai_weaknesses, ai_criteria, ai_graded_at)
               SELECT ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime')
               WHERE EXISTS (SELECT 1 FROM task_submissions
                             WHERE task_id=? AND student_username=?)""",
            (task_id, student, score, comment, feedback,
             json.dumps(strengths, ensure_ascii=False),
             json.dumps(weaknesses, ensure_ascii=False),
             json.dumps(criteria, ensure_ascii=False),
             task_id, student),
        )
        saved.append({
            "student": student,
            "score": score,
            "comment": comment,
            "feedback": feedback,
            "strengths": strengths,
            "weaknesses": weaknesses,
            "criteria": criteria,
        })

    # 9. 保存全班总结到 tasks 表
    summary_json = json.dumps(class_summary, ensure_ascii=False)
    execute_insert_update(
        "UPDATE tasks SET ai_summary=?, updated_at=datetime('now', 'localtime') WHERE id=?",
        (summary_json, task_id),
    )

    if skipped_gone:
        logger.warning(
            f"AI 批改回写被跳过 {len(skipped_gone)} 人（提交在批改期间已被删除或重置）: "
            f"task={task_id} {skipped_gone[:5]}"
        )
    logger.info(f"AI 批改完成: task={task_name}, 批改人数={len(saved)}, by={username}")
    return {
        "summary": class_summary,
        "grades": saved,
        "graded_count": len(saved),
        "skipped_count": len(skipped_gone),
        "message": (f"AI 批改完成，共批改 {len(saved)} 位学生"
                    + (f"；{len(skipped_gone)} 人的提交已不存在，未写入成绩" if skipped_gone else "")),
    }


# ── 单个学生 AI 批改（与全班批改互补）──

def _clamp_task_score(raw: Any) -> int | None:
    """AI 给的分可能是浮点/字符串/越界，统一夹成 0-100 整数；判不出返回 None"""
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return None
    if v != v:                      # NaN
        return None
    return int(max(0, min(100, round(v))))


def _as_str_list(raw: Any) -> list[str]:
    """优点/不足统一成字符串数组：模型偶尔会回一段用顿号连起来的话"""
    if isinstance(raw, str):
        import re as _re
        return [x.strip() for x in _re.split(r"[、;；\n]+", raw) if x.strip()]
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    return []


def _refresh_class_stats(task_id: str) -> dict[str, Any]:
    """单人批改后同步「全班批改总结」卡片的数字口径。

    分数按 task_grades 重算（平均分/最高/最低/人数），文字点评沿用上一次全班总结；
    否则只批一个人时，教师看到的全班数字仍是旧口径。
    """
    summary: dict[str, Any] = {}
    rows = execute_query("SELECT ai_summary FROM tasks WHERE id=?", (task_id,))
    if rows and rows[0][0]:
        try:
            old = json.loads(rows[0][0])
            if isinstance(old, dict):
                summary = old
        except json.JSONDecodeError:
            summary = {}
    stat = execute_query(
        "SELECT COUNT(*), AVG(ai_score), MAX(ai_score), MIN(ai_score) "
        "FROM task_grades WHERE task_id=?",
        (task_id,),
    )
    if stat:
        n, avg, hi, lo = stat[0]
        summary["total_students"] = n
        if n:
            summary["class_average"] = round(float(avg or 0), 1)
            summary["highest_score"] = hi
            summary["lowest_score"] = lo
    execute_insert_update(
        "UPDATE tasks SET ai_summary=?, updated_at=datetime('now', 'localtime') WHERE id=?",
        (json.dumps(summary, ensure_ascii=False), task_id),
    )
    return summary


def _safe_json_dict(raw: Any) -> dict:
    """维度分等对象型 JSON 字段的老库容错：解析不出来就当没有"""
    if not raw:
        return {}
    try:
        val = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {}
    return val if isinstance(val, dict) else {}


def _safe_json_list(raw: Any) -> list:
    """老库里可能是空串或坏 JSON，解析不出来就当没有，不影响其余字段"""
    if not raw:
        return []
    try:
        val = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    return val if isinstance(val, list) else []


def _get_task_grade_row(task_id: str, student: str) -> dict[str, Any]:
    """读回某位学生的批改结果（补姓名/年级/班级），供前端只刷新那一行。

    score 必须是「教师分为准」的有效分：教师复核改到 85 之后，
    这里若还回 AI 的 72，前端那一行就会当场退回旧分。
    """
    rows = execute_query(
        "SELECT student_username, ai_score, ai_comment, ai_feedback, ai_strengths, "
        "ai_weaknesses, ai_graded_at, ai_criteria, teacher_score, teacher_comment, dim_scores, "
        "needs_review, published, late_submitted, similarity, graded_by FROM task_grades "
        "WHERE task_id=? AND student_username=?",
        (task_id, student),
    )
    if not rows:
        return {}
    r = rows[0]
    grade = {
        "student": r[0],
        "score": r[8] if r[8] is not None else r[1],
        "ai_score": r[1],
        "teacher_score": r[8],
        "comment": r[9] if r[9] else r[2],
        "ai_comment": r[2],
        "feedback": r[3],
        "strengths": json.loads(r[4]) if r[4] else [],
        "weaknesses": json.loads(r[5]) if r[5] else [],
        "graded_at": r[6],
        "criteria": _safe_json_list(r[7]),
        "dim_scores": _safe_json_dict(r[10]),
        "needs_review": bool(r[11]),
        "published": bool(r[12]),
        "late_submitted": bool(r[13]),
        "similarity": _safe_json_list(r[14]),
        "graded_by": r[15] or "ai",
    }
    from backend.permission_service import attach_student_info
    attach_student_info([grade], key="student", prefix="")
    return grade


@router.post("/ai-grade-student/{task_id}")
async def ai_grade_single_student(task_id: str, request: Request):
    """🤖 只批改一位学生：把该学生的对话记录单独交给 AI 分析评分

    与 /ai-grade/{task_id}（全班一次批完）互补：全班批完后发现某个学生批得不准、
    或某个学生重新提交了，教师可以只重批那一个人 —— 省 token，也不覆盖其他学生的成绩。
    """
    user = get_current_user(request)
    username = user["username"]
    if not can_create_task(username):
        raise HTTPException(status_code=403, detail="权限不足")

    body = await request.json()
    student = str(body.get("student", "")).strip()
    if not student:
        raise HTTPException(status_code=400, detail="缺少 student")

    rows = execute_query(
        "SELECT id, creator_username, name, description FROM tasks WHERE id=?",
        (task_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="任务未找到")
    _, creator, task_name, task_desc = rows[0]
    task_desc = task_desc or task_name
    if not is_admin(username) and creator != username:
        raise HTTPException(status_code=403, detail="无权限批改此任务")

    # 提交记录是批改的前提（回退/重置后不再批该生）
    if not execute_query(
        "SELECT 1 FROM task_submissions WHERE task_id=? AND student_username=?",
        (task_id, student),
    ):
        raise HTTPException(status_code=404, detail=f"未找到学生 {student} 的提交记录")

    content = _read_student_submission(creator, task_name, student, task_id)
    if not content.strip():
        raise HTTPException(status_code=404, detail=f"学生 {student} 的提交内容读不到，无法批改")

    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="API Key 未配置，请在系统配置中设置")

    api_base = ai_api_base()
    model = get_config_value("MODEL_LONG_NAME", DEFAULT_LONG_MODEL)

    from backend.prompts.homework_grade import TASK_STUDENT_GRADING_PROMPT
    prompt = f"{build_ai_role()}\n" + TASK_STUDENT_GRADING_PROMPT.format(
        basis=_grading_basis(task_name, task_desc), student=student,
    )

    import re as _re
    import tempfile
    safe_student = _re.sub(r"[^A-Za-z0-9_.\-]", "_", student)[:40] or "student"
    tmp_path = ""
    try:
        # 只送这一位学生的记录：临时落一个 md 换 fileid，长对话不会因为请求体过大而失败
        fd, tmp_path = tempfile.mkstemp(
            prefix=f"task_grade_{_task_digest(task_id)}_{safe_student}_", suffix=".md")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(f"## 学生 {student}\n\n提交内容:\n\n{content}\n")
        try:
            file_id = await upload_file_to_dashscope(tmp_path, api_key)
        except Exception as e:
            logger.error(f"[单人批改] 提交内容上传失败 task={task_id} student={student}: {e}")
            raise HTTPException(status_code=500, detail=f"提交内容上传失败: {str(e)}")

        try:
            async with httpx.AsyncClient() as client:
                req_payload = {
                    "model": model,
                    "messages": [
                        {"role": "system",
                         "content": f"{build_ai_role()}正在批改学生 {student} 提交的作业对话记录。"},
                        {"role": "system", "content": f"fileid://{file_id}"},
                        {"role": "user", "content": prompt},
                    ],
                    "stream": False,
                    # 与全班批改一致：网关层强制 JSON，杜绝「AI 返回格式异常」
                    "response_format": {"type": "json_object"},
                }
                resp = await client.post(
                    f"{api_base}/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json=req_payload,
                    timeout=300,
                )
                if resp.status_code == 400 and "response_format" in req_payload:
                    req_payload.pop("response_format")  # 网关不支持时降级重试
                    resp = await client.post(
                        f"{api_base}/chat/completions",
                        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                        json=req_payload,
                        timeout=300,
                    )
                if resp.status_code != 200:
                    raise HTTPException(status_code=502,
                                        detail=f"AI 模型调用失败: {resp.text[:200]}")
                ai_text = resp.json()["choices"][0]["message"]["content"]
        except httpx.TimeoutException:
            raise HTTPException(status_code=504, detail="AI 模型调用超时，请稍后重试")
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"[单人批改] AI 调用失败: {e}")
            raise HTTPException(status_code=502, detail=f"AI 调用失败: {str(e)}")
    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except OSError:
                pass

    # 解析：兼容单对象 / {"grade": {...}} / {"grades": [{...}]} 三种回包写法
    try:
        cleaned = ai_text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[-1]
            if "```" in cleaned:
                cleaned = cleaned.rsplit("```", 1)[0]
        from backend import ai_json
        parsed = ai_json.try_parse(cleaned.strip())
    except Exception as e:
        logger.warning(f"[单人批改] JSON 解析异常: {e}")
        parsed = None
    if not isinstance(parsed, dict):
        logger.error(f"[单人批改] AI 返回格式异常 task={task_id} student={student}, "
                     f"raw={ai_text[:300]}")
        raise HTTPException(status_code=502, detail="AI 返回格式异常，请重试")
    one = parsed.get("grade")
    if not isinstance(one, dict):
        lst = parsed.get("grades")
        one = lst[0] if (isinstance(lst, list) and lst and isinstance(lst[0], dict)) else parsed

    score = _clamp_task_score(one.get("score"))
    if score is None:
        logger.error(f"[单人批改] AI 未给出有效分数 task={task_id} student={student}")
        raise HTTPException(status_code=502, detail="AI 未给出有效分数，请重试")
    comment = str(one.get("comment") or "")[:500]
    feedback = str(one.get("feedback") or "")[:500]
    strengths = _as_str_list(one.get("strengths"))[:6]
    weaknesses = _as_str_list(one.get("weaknesses"))[:6]
    criteria = _normalize_criteria(one.get("criteria"))

    execute_insert_update(
        # 与全班批改同一写法：提交在批改期间被回退时不写孤儿成绩
        """INSERT OR REPLACE INTO task_grades
           (task_id, student_username, ai_score, ai_comment, ai_feedback,
            ai_strengths, ai_weaknesses, ai_criteria, ai_graded_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime')
           WHERE EXISTS (SELECT 1 FROM task_submissions
                         WHERE task_id=? AND student_username=?)""",
        (task_id, student, score, comment, feedback,
         json.dumps(strengths, ensure_ascii=False),
         json.dumps(weaknesses, ensure_ascii=False),
         json.dumps(criteria, ensure_ascii=False),
         task_id, student),
    )

    grade = _get_task_grade_row(task_id, student)
    if not grade:
        raise HTTPException(status_code=409, detail="批改结果未写入：该学生的提交可能已被回退")
    summary = _refresh_class_stats(task_id)
    logger.info(f"AI 单人批改完成: task={task_name}, student={student}, "
                f"score={score}, by={username}")
    return {
        "grade": grade,
        "summary": summary,
        "message": f"已完成 {student} 的 AI 批改",
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

    task_row = execute_query("SELECT submit_mode, total_score, publish_status FROM tasks WHERE id=?",
                             (task_id,))
    mode = (task_row[0][0] if task_row else "conversation") or "conversation"
    full_score = float(task_row[0][1] or 100) if task_row else 100.0
    publish_status = (task_row[0][2] if task_row else "draft") or "draft"

    def _effective(ai_score: Any, teacher_score: Any) -> Any:
        """教师改过就以教师分为准，AI 原分另行返回（保留可追溯的痕迹）"""
        return teacher_score if teacher_score is not None else ai_score

    # 权限验证
    if not is_admin(username) and creator != username:
        # 学生可以看自己的批改
        if not is_teacher(username) and not is_admin(username):
            rows = execute_query(
                "SELECT ai_score, ai_comment, ai_feedback, ai_strengths, ai_weaknesses, ai_graded_at, "
                "ai_criteria, teacher_score, teacher_comment, dim_scores, needs_review, published, "
                "late_submitted, graded_by FROM task_grades "
                "WHERE task_id=? AND student_username=? AND (?=0 OR COALESCE(published, 1)=1)",
                # 「未发布不给学生看」是文件作业的规则；对话作业历来批完即可见，
                # 而且老库的 published 默认值取决于建列时机，不能拿它当判据
                (task_id, username, 1 if mode in ("file", "mixed") else 0),
            )
            if rows:
                r = rows[0]
                return {
                    # K2: 全班 AI 总结(含他人表现描述)不再下发给非创建者学生
                    "summary": None,
                    "grades": [{
                        "student": username,
                        "score": _effective(r[0], r[7]),
                        "ai_score": r[0],
                        "teacher_score": r[7],
                        "comment": r[8] if r[8] else r[1],
                        "ai_comment": r[1],
                        "feedback": r[2],
                        "strengths": json.loads(r[3]) if r[3] else [],
                        "weaknesses": json.loads(r[4]) if r[4] else [],
                        "graded_at": r[5],
                        "criteria": _safe_json_list(r[6]),
                        "dim_scores": _safe_json_dict(r[9]),
                        "needs_review": bool(r[10]),
                        "late_submitted": bool(r[12]),
                        "graded_by": r[13] or "ai",
                    }],
                    "graded_count": 1,
                }
            return {"summary": None, "grades": [], "graded_count": 0}
        raise HTTPException(status_code=403, detail="无权限查看")

    # 教师/管理员查看所有
    rows = execute_query(
        "SELECT student_username, ai_score, ai_comment, ai_feedback, ai_strengths, ai_weaknesses, "
        "ai_graded_at, ai_criteria, teacher_score, teacher_comment, dim_scores, needs_review, "
        "published, late_submitted, similarity, graded_by FROM task_grades WHERE task_id=? "
        "ORDER BY COALESCE(teacher_score, ai_score) DESC",
        (task_id,),
    )
    grades = []
    for r in rows:
        grades.append({
            "student": r[0],
            "score": _effective(r[1], r[8]),
            "ai_score": r[1],
            "teacher_score": r[8],
            "comment": r[9] if r[9] else r[2],
            "ai_comment": r[2],
            "feedback": r[3],
            "strengths": json.loads(r[4]) if r[4] else [],
            "weaknesses": json.loads(r[5]) if r[5] else [],
            "graded_at": r[6],
            "criteria": _safe_json_list(r[7]),
            "dim_scores": _safe_json_dict(r[10]),
            "needs_review": bool(r[11]),
            "published": bool(r[12]),
            "late_submitted": bool(r[13]),
            "similarity": _safe_json_list(r[14]),
            "graded_by": r[15] or "ai",
        })

    # 批改名单只有学号, 补姓名/年级/班级
    from backend.permission_service import attach_student_info
    attach_student_info(grades, key="student", prefix="")
    return {
        "summary": class_summary,
        "grades": grades,
        "graded_count": len(grades),
        "submit_mode": mode,
        "total_score": full_score,
        "publish_status": publish_status,
        "published_count": sum(1 for g in grades if g["published"]),
    }

# ════════════════════════════════════════════════════════════════════════
# 文件提交类作业（Word / PDF / 图片 / 表格 / 演示稿）
#   · 落盘 stu/<学号>/homework/<任务指纹>/，一次提交 = 一个 submission_seq（重交留痕，批改取最后一次）
#   · 文档类在提交时就抽正文（本地毫秒级）；图片留给批改任务里的 VL 预解读
#   · AI 批改复用对话作业那条通道：全班合成一份「批改包」→ fileid:// → qwen-long
#   · 判不出的一律 needs_review 转人工，绝不猜分；教师改分保留 AI 原分
# ════════════════════════════════════════════════════════════════════════

HW_NOTE_MAX = 5000
HW_DISK_MIN_FREE_MB = 100


def _hw_task(task_id: str) -> dict[str, Any] | None:
    """按列名取任务整行（文件作业字段多，继续用位置索引迟早出错）"""
    rows = execute_query_dict(f"SELECT {_TASK_COLS} FROM tasks WHERE id=?", (task_id,))
    return rows[0] if rows else None


def _assert_submit_visible(user: dict, task: dict) -> None:
    """学生只能提交到自己可见范围内的作业（与 /submit 同一判据，抽出来避免两处漂移）"""
    if user.get("role") != 2:
        return
    username = user["username"]
    s_grade = str(user.get("grade", "") or "").strip()
    s_class = str(user.get("class", "") or "").strip()
    rows_grade = execute_query("SELECT grade, class FROM users WHERE username=?", (username,))
    if rows_grade:
        s_grade = str(rows_grade[0][0] or "").strip()
        s_class = str(rows_grade[0][1] or "").strip()
    if not check_activity_visibility(
        student_username=username,
        student_grade=s_grade,
        student_class=s_class,
        # 调用方有两种形态：/submit 传 _task_row_to_dict 映射后的 dict(键是 creator)，
        # 文件提交传 execute_query_dict 的原始行(键是 creator_username)，这里兼容两者
        creator_username=task.get("creator") or task["creator_username"],
        target_scope=task.get("target_scope") or "teacher_classes",
        target_grade=task.get("target_grade") or "",
        target_class=task.get("target_class") or "",
        target_users=task.get("target_users") or "",
    ):
        raise HTTPException(status_code=403, detail="无权提交到该任务")


def _hw_is_late(task: dict, submitted_at: str) -> bool:
    """迟交判定：字符串按 'YYYY-MM-DD HH:MM:SS' 同格式可直接比（全站本地时间口径）"""
    deadline = str(task.get("deadline_at") or "").strip()
    if not deadline:
        return False
    return str(submitted_at or "") > deadline


def _hw_next_seq(task_id: str, student: str) -> int:
    rows = execute_query(
        "SELECT MAX(submission_seq) FROM homework_files WHERE task_id=? AND student_username=?",
        (task_id, student),
    )
    return int((rows[0][0] if rows and rows[0][0] else 0)) + 1


def _hw_submitted_times(task_id: str, student: str) -> int:
    """已提交次数：以文件批次为准（同一次提交的多份文件共用一个 seq）"""
    rows = execute_query(
        "SELECT COUNT(DISTINCT submission_seq) FROM homework_files WHERE task_id=? AND student_username=?",
        (task_id, student),
    )
    return int(rows[0][0] if rows else 0)


def purge_task_files_on_disk(task_id: str, students: list[str] | None = None) -> int:
    """删掉本作业落盘的文件夹。

    目录名就是任务指纹（stu/<学号>/homework/<指纹>/），所以按指纹扫一遍即可覆盖全部学生 ——
    删任务与"活动重置"时提交名单可能已经先被清掉，靠名单反而清不干净。
    返回清理的目录数。
    """
    import shutil
    removed = 0
    digest = homework.task_digest(task_id)
    if students:
        targets = [homework.DATA_DIR / STU_DIR / stu / "homework" / digest for stu in students]
    else:
        root = homework.DATA_DIR / STU_DIR
        targets = sorted(root.glob(f"*/homework/{digest}")) if root.exists() else []
    for d in targets:
        try:
            if not d.exists():
                continue
            # 双保险：只认" stu/<学号>/homework/<任务指纹> "这一种形状
            parts = d.parts
            if "homework" not in parts or STU_DIR not in parts:
                continue
            shutil.rmtree(str(d), ignore_errors=True)
            removed += 1
        except Exception as e:
            logger.warning(f"[作业文件] 目录清理失败 task={task_id} dir={d}: {e}")
    return removed


def _hw_file_payload(row: dict, with_text: bool = False) -> dict[str, Any]:
    """作业文件行的对外形态：下载走 /api/tasks/file/<id>，不再依赖静态目录权限"""
    data = {
        "id": row["id"],
        "task_id": row["task_id"],
        "student": row["student_username"],
        "seq": int(row["submission_seq"] or 1),
        "filename": row["filename"],
        "ext": row["ext"],
        "kind": row["kind"] or homework.file_kind(row["ext"]),
        "mime": row["mime"] or "",
        "size": int(row["size"] or 0),
        "chars": int(row["chars"] or 0),
        "extract_status": row["extract_status"] or "pending",
        "error": row["error"] or "",
        "has_digest": bool((row["text_digest"] or "") or (row["vl_digest"] or "")),
        "created_at": row["created_at"] or "",
        "url": f"/api/tasks/file/{row['id']}",
    }
    if with_text:
        body = (row["text_digest"] or "").strip() or (row["vl_digest"] or "").strip()
        data["text_preview"] = body[:4000]
        data["text_truncated"] = len(body) > 4000
    return data


@router.post("/{task_id}/submit-files")
async def submit_task_files(task_id: str, request: Request,
                            files: list[UploadFile] = File(...),
                            note: str = Form("")):
    """📎 学生上传文件提交作业（.docx/.pdf/.xlsx/.pptx/文本/图片）

    原子性沿用对话作业的 K3 口径：任何一个文件校验或落盘失败就回滚本次批次，
    绝不留「提交记录在、文件不在」的半条数据。
    """
    user = get_current_user(request)
    username = user["username"]

    task = _hw_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="作业未找到")
    if (task.get("submit_mode") or "conversation") == "conversation":
        raise HTTPException(status_code=400, detail="该作业要求提交对话记录，不需要上传文件")
    if (task.get("status") or "active") != "active":
        raise HTTPException(status_code=409, detail="该作业已结束，无法再提交")
    _assert_submit_visible(user, task)

    deadline = str(task.get("deadline_at") or "").strip()
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    if deadline and now > deadline and not int(task.get("allow_late") or 0):
        raise HTTPException(status_code=409, detail=f"已过截止时间 {deadline}，本次不再接收提交")

    seq = _hw_next_seq(task_id, username)
    limit = int(task.get("resubmit_limit") or 0)
    if limit and seq > limit:
        raise HTTPException(status_code=409,
                            detail=f"已提交 {seq - 1} 次，达到上限 {limit} 次；如需重交请联系教师")

    if not files:
        raise HTTPException(status_code=400, detail="请选择要提交的文件")
    max_files = homework.task_max_files(task)
    if len(files) > max_files:
        raise HTTPException(status_code=400, detail=f"本次最多提交 {max_files} 个文件")
    allowed = set(homework.task_allowed_exts(task))
    max_bytes = homework.task_max_file_mb(task) * 1024 * 1024

    # 磁盘预警：撑爆磁盘是「全班都交不上」级别的故障，宁可提前拒绝
    try:
        import shutil as _sh
        free_mb = _sh.disk_usage(str(homework.DATA_DIR)).free // (1024 * 1024)
        if free_mb < HW_DISK_MIN_FREE_MB:
            raise HTTPException(status_code=503,
                                detail=f"服务器磁盘剩余不足（{free_mb}MB），请稍后再交或联系管理员")
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"[作业提交] 磁盘余量检查失败（按放行处理）: {e}")

    saved: list[dict[str, Any]] = []
    written: list[str] = []
    try:
        for up in files:
            display = homework.safe_display_name(up.filename or "file")
            ext = os.path.splitext(display)[1].lower()
            if ext in homework.LEGACY_OFFICE_EXTS:
                raise HTTPException(
                    status_code=400,
                    detail=f"{display}：旧版 {ext} 格式无法在线批改，请另存为 {ext}x（如 .doc 转 .docx）后上传")
            if ext not in allowed:
                raise HTTPException(
                    status_code=400,
                    detail=f"{display}：该作业只收 {'、'.join(sorted(allowed))}")
            content = await up.read()
            if not content:
                raise HTTPException(status_code=400, detail=f"{display}：空文件")
            if len(content) > max_bytes:
                raise HTTPException(
                    status_code=400,
                    detail=f"{display}：超过单文件上限 {homework.task_max_file_mb(task)}MB")
            if not homework.sniff_ok(ext, content):
                raise HTTPException(status_code=400,
                                    detail=f"{display}：文件内容与扩展名不符，已拒绝")

            info = homework.save_upload(username, task_id, seq, content, display)
            written.append(info["abs_path"])
            if info["kind"] == "image":
                status, digest, chars = "image", "", 0
            else:
                status, digest, chars = homework.extract_text(info["abs_path"], ext)
            row_id = execute_insert_update(
                """INSERT OR REPLACE INTO homework_files
                   (task_id, student_username, submission_seq, filename, stored_path, ext, mime, kind,
                    size, sha256, text_digest, extract_status, chars, error, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))""",
                (task_id, username, seq, display, info["stored_path"], ext,
                 up.content_type or "", info["kind"], info["size"], info["sha256"],
                 digest, status, chars,
                 "" if status in ("ok", "image") else
                 {"empty": "文件里没有可识别的文字",
                  "scanned": "PDF 疑似扫描件（纯图片），需教师看原件",
                  "failed": "文件无法解析（可能已加密或损坏）"}.get(status, "解析失败")),
            )
            saved.append({"id": row_id, "filename": display, "extract_status": status,
                          "size": info["size"], "kind": info["kind"]})

        # mixed 模式的文字说明：存进提交行，批改包里作为「设计思路」一起交给模型
        # 绕过 HTTP 直接调用本函数时（内部任务/测试），形参拿到的是 Form(...) 的默认对象
        # 而不是字符串，直接 str() 会把 FieldInfo 的 repr 当说明文字存进库。
        note_text = (note if isinstance(note, str) else "").strip()[:HW_NOTE_MAX]
        if task.get("submit_mode") == "mixed" and note_text:
            execute_insert_update(
                """INSERT INTO task_submissions (task_id, student_username, submitted_at, note)
                   VALUES (?, ?, datetime('now','localtime'), ?)
                   ON CONFLICT(task_id, student_username)
                   DO UPDATE SET submitted_at = excluded.submitted_at, note = excluded.note""",
                (task_id, username, note_text),
            )
        else:
            execute_insert_update(
                """INSERT INTO task_submissions (task_id, student_username, submitted_at)
                   VALUES (?, ?, datetime('now','localtime'))
                   ON CONFLICT(task_id, student_username)
                   DO UPDATE SET submitted_at = excluded.submitted_at""",
                (task_id, username),
            )
    except Exception as e:
        for path in written:                       # 回滚本批次已落盘的文件，不留孤儿
            try:
                os.remove(path)
            except OSError:
                pass
        execute_insert_update(
            "DELETE FROM homework_files WHERE task_id=? AND student_username=? AND submission_seq=?",
            (task_id, username, seq),
        )
        if isinstance(e, HTTPException):
            logger.info(f"[作业提交] 被拒 task={task_id} student={username}: {e.detail}")
            raise
        logger.error(f"[作业提交] 失败已回滚 task={task_id} student={username}: {e}")
        raise HTTPException(status_code=500, detail=f"提交失败，已回滚本次上传：{str(e)[:120]}")

    if user.get("role") == 2:
        try:
            from backend.reward_engine import award_participation
            award_participation(username, "task", str(task_id), task.get("name") or "")
        except Exception:
            pass

    late = _hw_is_late(task, now)
    logger.info(f"作业文件已提交: task={task.get('name')}, student={username}, "
                f"seq={seq}, files={len(saved)}, late={late}")
    return {
        "message": f"已提交 {len(saved)} 个文件" + ("（迟交已标记）" if late else ""),
        "submission_seq": seq,
        "late_submitted": late,
        "files": saved,
    }


@router.get("/{task_id}/files")
async def get_task_files(task_id: str, request: Request):
    """📎 作业文件清单：教师（创建者）/管理员看全班，学生只看自己最近一次提交"""
    user = get_current_user(request)
    username = user["username"]
    task = _hw_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="作业未找到")

    is_owner = is_admin(username) or task["creator_username"] == username
    teacher_view = is_owner and user.get("role") != 2
    if not is_owner and user.get("role") != 2:
        raise HTTPException(status_code=403, detail="无权限查看该作业的提交文件")

    if teacher_view:
        rows = execute_query_dict(
            "SELECT * FROM homework_files WHERE task_id=? "
            "ORDER BY student_username, submission_seq DESC, id", (task_id,))
        scope = request.query_params.get("student", "")
        if scope:
            rows = [r for r in rows if r["student_username"] == scope]
    else:
        rows = execute_query_dict(
            "SELECT * FROM homework_files WHERE task_id=? AND student_username=? "
            "ORDER BY submission_seq DESC, id", (task_id, username))

    latest_map: dict[str, int] = {}
    for r in rows:
        latest_map[r["student_username"]] = max(
            latest_map.get(r["student_username"], 0), int(r["submission_seq"] or 1))
    if not teacher_view:      # 学生端不必翻历史批次，只给当前有效的那一次
        rows = [r for r in rows if int(r["submission_seq"] or 1) == latest_map.get(username, 1)]

    items = []
    for r in rows:
        item = _hw_file_payload(r, with_text=teacher_view)
        item["is_latest"] = int(r["submission_seq"] or 1) == latest_map.get(r["student_username"], 0)
        items.append(item)

    subs: dict[str, Any] = {}
    sub_rows = execute_query_dict(
        "SELECT student_username, submitted_at, note FROM task_submissions WHERE task_id=?", (task_id,))
    for s in sub_rows:
        if teacher_view or s["student_username"] == username:
            subs[s["student_username"]] = {
                "submitted_at": s["submitted_at"],
                "note": s["note"] or "",
                "late_submitted": _hw_is_late(task, s["submitted_at"] or ""),
            }
    return {
        "task_id": task_id,
        "task_name": task.get("name"),
        "submit_mode": task.get("submit_mode"),
        "deadline_at": task.get("deadline_at") or "",
        "allowed_exts": homework.task_allowed_exts(task),
        "max_files": homework.task_max_files(task),
        "max_file_mb": homework.task_max_file_mb(task),
        "resubmit_limit": int(task.get("resubmit_limit") or 0),
        "total_score": float(task.get("total_score") or 100),
        "files": items,
        "submissions": subs,
    }


@router.get("/file/{file_id}")
async def download_homework_file(file_id: int, request: Request, inline: int = 0):
    """下载/预览单个作业文件。

    权限只有三种：本人、作业创建教师、管理员。归属清晰，因此不开
    「任课教师可读整个 stu/ 目录」那种宽口子。
    """
    user = get_current_user(request)
    username = user["username"]
    rows = execute_query_dict("SELECT * FROM homework_files WHERE id=?", (file_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="文件不存在")
    row = rows[0]
    task = _hw_task(row["task_id"])
    owner_ok = row["student_username"] == username
    creator_ok = bool(task) and (task["creator_username"] == username or is_admin(username))
    if not (owner_ok or creator_ok):
        raise HTTPException(status_code=403, detail="无权访问该文件")

    path = homework.resolve_stored(row["stored_path"])
    if not path:
        raise HTTPException(status_code=404, detail="文件已不在服务器上（可能被活动重置或清理）")
    from urllib.parse import quote
    disp = "inline" if inline else "attachment"
    return FileResponse(
        str(path),
        media_type=row["mime"] or "application/octet-stream",
        headers={"Content-Disposition": f"{disp}; filename*=UTF-8''{quote(row['filename'])}"},
    )


@router.delete("/{task_id}/file/{file_id}")
async def delete_homework_file(task_id: str, file_id: int, request: Request):
    """撤下单个文件：限本人（或创建教师），且只能撤最近一次提交、作业仍在接收期内"""
    user = get_current_user(request)
    username = user["username"]
    rows = execute_query_dict("SELECT * FROM homework_files WHERE id=? AND task_id=?",
                              (file_id, task_id))
    if not rows:
        raise HTTPException(status_code=404, detail="文件不存在")
    row = rows[0]
    task = _hw_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="作业未找到")

    is_creator = is_admin(username) or task["creator_username"] == username
    if not is_creator and row["student_username"] != username:
        raise HTTPException(status_code=403, detail="只能撤回自己的提交")
    if not is_creator:
        if (task.get("status") or "active") != "active":
            raise HTTPException(status_code=409, detail="作业已结束，不能撤回")
        deadline = str(task.get("deadline_at") or "").strip()
        if deadline and time.strftime("%Y-%m-%d %H:%M:%S") > deadline \
                and not int(task.get("allow_late") or 0):
            raise HTTPException(status_code=409, detail="已过截止时间，不能撤回")
        latest = _hw_next_seq(task_id, row["student_username"]) - 1
        if int(row["submission_seq"] or 1) != latest:
            raise HTTPException(status_code=409, detail="只能撤回最近一次提交的文件")

    execute_insert_update("DELETE FROM homework_files WHERE id=?", (file_id,))
    # 内容寻址的文件可能被同一学生的其他批次复用，确认没人引用再删物理文件
    still = execute_query(
        "SELECT COUNT(*) FROM homework_files WHERE stored_path=?", (row["stored_path"],))
    if not (still and still[0][0]):
        p = homework.resolve_stored(row["stored_path"])
        if p:
            try:
                os.remove(str(p))
            except OSError as e:
                logger.warning(f"[作业文件] 物理删除失败 id={file_id}: {e}")
    logger.info(f"作业文件已撤回: task={task_id} file={file_id} by={username}")
    return {"message": "已撤回该文件"}

@router.post("/{task_id}/extract")
async def reextract_homework_files(task_id: str, request: Request):
    """教师手动重跑抽取：改了白名单、刚开多模态、或之前失败/扫描件都用得上"""
    user = get_current_user(request)
    username = user["username"]
    task = _hw_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="作业未找到")
    if not (is_admin(username) or task["creator_username"] == username):
        raise HTTPException(status_code=403, detail="无权限操作此作业")

    body: dict[str, Any] = {}
    try:
        body = await request.json() or {}
    except Exception:
        body = {}
    student = str(body.get("student") or "").strip()

    rows = execute_query_dict(
        """SELECT * FROM homework_files hw WHERE hw.task_id=? AND hw.submission_seq=(
               SELECT MAX(submission_seq) FROM homework_files h2
               WHERE h2.task_id=hw.task_id AND h2.student_username=hw.student_username)
           ORDER BY hw.student_username, hw.id""",
        (task_id,))
    if student:
        rows = [r for r in rows if r["student_username"] == student]

    api_key, _ = get_api_keys(username)
    done = failed = skipped = 0
    for row in rows:
        ext = row["ext"] or ""
        path = homework.resolve_stored(row["stored_path"])
        if not path:
            failed += 1
            continue
        if homework.file_kind(ext) == "image":
            if not homework.vl_enabled() or not api_key:
                skipped += 1
                continue
            status, digest = await asyncio.to_thread(
                homework.vl_digest_images, [str(path)], api_key, task.get("name") or "")
            execute_insert_update(
                "UPDATE homework_files SET vl_digest=?, extract_status=?, error=?, chars=? WHERE id=?",
                (digest, "ok" if status == "ok" else "failed",
                 "" if status == "ok" else "图片识别失败，请教师看原件", len(digest), row["id"]))
            done += 1 if status == "ok" else 0
            failed += 0 if status == "ok" else 1
            continue
        status, digest, chars = homework.extract_text(str(path), ext)
        execute_insert_update(
            "UPDATE homework_files SET text_digest=?, extract_status=?, chars=?, error=? WHERE id=?",
            (digest, status, chars,
             "" if status == "ok" else f"抽取结果：{status}", row["id"]))
        done += 1 if status == "ok" else 0
        failed += 0 if status == "ok" else 1

    logger.info(f"[作业重抽] task={task_id} by={username} 成功={done} 失败={failed} 跳过={skipped}")
    return {"message": f"重抽完成：成功 {done}，失败 {failed}，跳过 {skipped}",
            "ok": done, "failed": failed, "skipped": skipped}


# ── 批改包：把每位学生最新一次提交的正文拼成一份可上传的文件 ──

def _hw_basis(task: dict) -> str:
    """文件作业的批改依据（要求 + 满分 + 评分维度），全班与单人共用同一份，口径才不会漂"""
    from backend.prompts.homework_grade import GRADING_BASIS_FILE
    dims = homework.rubric_of(task)
    desc = str(task.get("description") or "").strip() or \
        "（教师未填写作业要求，请按作业名称推断主题与合理期望，并在评语中说明依据有限）"
    return GRADING_BASIS_FILE.format(
        task_name=task.get("name") or "",
        task_description=desc,
        total_score=f"{float(task.get('total_score') or 100):g}",
        rubric=homework.render_rubric(dims),
    )


def _hw_student_body(task: dict, files: list[dict], note: str) -> tuple[str, bool]:
    """一位学生的批改正文。返回 (正文, 是否需要教师复核)

    需要复核的三种情况：图片没做多模态预解读、扫描件没抽出文字、文件解析失败——
    这些都「看不见内容」，让模型硬猜就是拿 0 分冤枉学生。
    """
    hint = str(task.get("name") or "")
    blocks: list[str] = []
    needs_review = False
    for f in files:
        kind = f["kind"] or homework.file_kind(f["ext"])
        head = f"· 文件：{f['filename']}（{kind}，{int(f['size'] or 0) // 1024}KB"
        if f["chars"]:
            head += f"，正文 {f['chars']} 字"
        head += "）"
        body = (f["text_digest"] or "").strip()
        if kind == "image" and not body:
            body = (f["vl_digest"] or "").strip()
        if not body:
            needs_review = True
            why = {"image": "图片未做多模态识别（管理员未开启或识别失败）",
                   "scanned": "疑似扫描件，未抽出文字",
                   "failed": "文件无法解析",
                   "empty": "文件里没有可识别的文字"}.get(f["extract_status"] or "", "未取到正文")
            blocks.append(f"{head}\n  （{why}，需教师查看原件）")
            continue
        if f["extract_status"] == "image" or kind == "image":
            blocks.append(f"{head}\n【图片识别结果，可能存在转录误差】\n{body}")
        else:
            blocks.append(f"{head}\n{homework.clip(body, homework.PKG_STUDENT_CHARS)}")
    text = "\n\n".join(blocks)
    if note:
        text = f"【学生说明】{note}\n\n{text}"
    return text, needs_review


def _hw_latest_files(task_id: str, student: str = "") -> dict[str, list[dict]]:
    """每位学生最新一次提交的文件（批改只看最后一次，重交不留旧稿给模型）"""
    sql = """SELECT * FROM homework_files hw WHERE hw.task_id=? AND hw.submission_seq=(
               SELECT MAX(submission_seq) FROM homework_files h2
               WHERE h2.task_id=hw.task_id AND h2.student_username=hw.student_username)"""
    params: tuple = (task_id,)
    if student:
        sql += " AND hw.student_username=?"
        params = (task_id, student)
    sql += " ORDER BY hw.student_username, hw.id"
    grouped: dict[str, list[dict]] = {}
    for row in execute_query_dict(sql, params):
        grouped.setdefault(row["student_username"], []).append(row)
    return grouped


async def _hw_ensure_images(task_id: str, api_key: str, only_student: str = "",
                            on_done: Any = None) -> dict[str, int]:
    """给最新一次提交里还没预解读的图片补 VL，结果缓存进库（重批不重抽）"""
    grouped = _hw_latest_files(task_id, only_student)
    pending: list[dict] = []
    for files in grouped.values():
        for f in files:
            if (f["kind"] or homework.file_kind(f["ext"])) == "image" \
                    and not (f["vl_digest"] or "").strip():
                pending.append(f)
    counts = {"total": len(pending), "ok": 0, "failed": 0, "skipped": 0}
    if not pending:
        return counts
    if not api_key or not homework.vl_enabled():
        counts["skipped"] = len(pending)
        return counts

    sem = asyncio.Semaphore(max(1, _hw_vl_concurrency()))

    async def one(row: dict):
        path = homework.resolve_stored(row["stored_path"])
        if not path:
            counts["failed"] += 1
            return
        async with sem:
            status, digest = await asyncio.to_thread(
                homework.vl_digest_images, [str(path)], api_key, row.get("_hint") or "")
        execute_insert_update(
            "UPDATE homework_files SET vl_digest=?, extract_status=?, error=?, chars=? WHERE id=?",
            (digest, "ok" if status == "ok" else "failed",
             "" if status == "ok" else "图片识别失败，请教师看原件", len(digest), row["id"]))
        counts["ok" if status == "ok" else "failed"] += 1
        if on_done:
            on_done()

    hint = ""
    rows = execute_query_dict("SELECT name FROM tasks WHERE id=?", (task_id,))
    hint = (rows[0]["name"] if rows else "") or ""
    for r in pending:
        r["_hint"] = hint
    await asyncio.gather(*(one(r) for r in pending))
    return counts


def _hw_vl_concurrency() -> int:
    """VL 并发沿用批改引擎那套配置，避免把出题/对话的额度挤没"""
    try:
        return max(1, int(get_config_value("AI_GRADING_CONCURRENCY", 2)))
    except Exception:
        return 2


def _hw_build_package(task_id: str, students: list[str] | None = None) -> tuple[str, dict[str, bool]]:
    """生成全班（或指定学生）批改包内容。返回 (markdown, student->needs_review)"""
    task = _hw_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="作业未找到")
    grouped = _hw_latest_files(task_id, "")
    if students is not None:
        grouped = {k: v for k, v in grouped.items() if k in students}
    sub_rows = execute_query_dict(
        "SELECT student_username, submitted_at, note FROM task_submissions WHERE task_id=?", (task_id,))
    subs = {r["student_username"]: r for r in sub_rows}

    parts = [f"# 作业批改包：{task.get('name') or task_id}\n",
             _hw_basis(task),
             "\n---\n"]
    review_map: dict[str, bool] = {}
    for student in sorted(grouped):
        sub = subs.get(student) or {}
        note = str(sub.get("note") or "")[:800]
        body, needs = _hw_student_body(task, grouped[student], note)
        review_map[student] = needs
        submitted = sub.get("submitted_at") or ""
        late = "（迟交）" if _hw_is_late(task, submitted) else ""
        parts.append(f"\n## 学生 {student}\n\n提交时间: {submitted}{late}\n\n{body}\n")
        parts.append("\n---\n")
    return "".join(parts), review_map


def _clamp_score_to_total(raw: Any, total: float) -> float | None:
    """AI 分数可能越界/非数；统一夹到 [0, 满分]，判不出返回 None"""
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return None
    if v != v:
        return None
    return round(max(0.0, min(v, total)), 1)


def _hw_norm_dim_scores(raw: Any, dims: list[dict], score: float) -> dict[str, float]:
    """维度分归一：键对齐教师设定的维度、单项不超上限、总和向总分看齐"""
    given = raw if isinstance(raw, dict) else {}
    out: dict[str, float] = {}
    for d in dims:
        val = given.get(d["name"])
        try:
            v = float(val) if val is not None else 0.0
        except (TypeError, ValueError):
            v = 0.0
        out[d["name"]] = round(max(0.0, min(v, float(d["max"]))), 1)
    s = sum(out.values())
    if s > 0 and abs(s - score) > 0.05:
        k = score / s
        for d in dims:
            out[d["name"]] = round(min(float(d["max"]), out[d["name"]] * k), 1)
    return out


def _hw_write_grade(task_id: str, student: str, one: dict, task: dict,
                    needs_review: bool, published: int) -> bool:
    """写一份批改结果。提交在批改期间被回退时不写孤儿成绩（沿用对话作业的 EXISTS 写法）"""
    total = float(task.get("total_score") or 100)
    score = _clamp_score_to_total(one.get("score"), total)
    if score is None:
        execute_insert_update(
            """INSERT INTO task_grades (task_id, student_username, ai_score, ai_comment, needs_review,
                                       graded_by, published, ai_graded_at)
               SELECT ?, ?, NULL, ?, 1, 'none', 0, datetime('now','localtime')
               WHERE EXISTS (SELECT 1 FROM task_submissions WHERE task_id=? AND student_username=?)""",
            (task_id, student,
             str(one.get("comment") or "AI 未能给出有效分数，请教师查看原件批改"),
             task_id, student),
        )
        return True
    dims = homework.rubric_of(task)
    comment = str(one.get("comment") or "")[:500]
    feedback = str(one.get("feedback") or "")[:500]
    strengths = _as_str_list(one.get("strengths"))[:6]
    weaknesses = _as_str_list(one.get("weaknesses"))[:6]
    criteria = _normalize_criteria(one.get("criteria"))
    dim_scores = _hw_norm_dim_scores(one.get("dim_scores"), dims, score)
    review = 1 if needs_review or bool(one.get("needs_review")) else 0
    execute_insert_update(
        """INSERT OR REPLACE INTO task_grades
           (task_id, student_username, ai_score, ai_comment, ai_feedback, ai_strengths, ai_weaknesses,
            ai_criteria, ai_graded_at, dim_scores, needs_review, graded_by, published, teacher_score,
            teacher_comment)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), ?, ?, 'ai', ?, NULL, ''
           WHERE EXISTS (SELECT 1 FROM task_submissions WHERE task_id=? AND student_username=?)""",
        (task_id, student, score, comment, feedback,
         json.dumps(strengths, ensure_ascii=False), json.dumps(weaknesses, ensure_ascii=False),
         json.dumps(criteria, ensure_ascii=False),
         json.dumps(dim_scores, ensure_ascii=False), review, published, task_id, student),
    )
    return False


# ── AI 调用与批改编排 ──

async def _hw_call_long(prompt: str, package_md: str, api_key: str, system_tail: str) -> str:
    """批改包落临时文件 → 上传换 fileid → qwen-long 评分（与对话作业同一条通道）"""
    import tempfile
    fd, tmp_path = tempfile.mkstemp(prefix="hw_package_", suffix=".md")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(package_md)
    try:
        try:
            file_id = await upload_file_to_dashscope(tmp_path, api_key)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"批改包上传失败: {str(e)[:120]}")

        api_base = ai_api_base()
        model = get_config_value("MODEL_LONG_NAME", DEFAULT_LONG_MODEL)
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": f"{build_ai_role()}{system_tail}"},
                {"role": "system", "content": f"fileid://{file_id}"},
                {"role": "user", "content": prompt},
            ],
            "stream": False,
            "response_format": {"type": "json_object"},
        }
        async with httpx.AsyncClient() as client:
            try:
                resp = await client.post(
                    f"{api_base}/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json=payload, timeout=300,
                )
                if resp.status_code == 400 and "response_format" in payload:
                    payload.pop("response_format")     # 网关不支持强制 JSON 时降级重试
                    resp = await client.post(
                        f"{api_base}/chat/completions",
                        headers={"Authorization": f"Bearer {api_key}",
                                 "Content-Type": "application/json"},
                        json=payload, timeout=300,
                    )
            except httpx.TimeoutException:
                raise HTTPException(status_code=504, detail="AI 批改超时，请稍后重试或改为逐个批改")
            if resp.status_code != 200:
                raise HTTPException(status_code=502, detail=f"AI 模型调用失败: {resp.text[:200]}")
            return resp.json()["choices"][0]["message"]["content"]
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def _hw_parse(ai_text: str) -> dict | None:
    from backend import ai_json
    return ai_json.try_parse(_strip_json_fence(ai_text or ""))


async def _hw_grade_class(task_id: str, teacher: str, on_progress: Any = None) -> dict[str, Any]:
    """全班文件作业 AI 批改：补图片 → 组包 → 一次调用 → 落库（默认待复核，不直接发布）"""
    task = _hw_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="作业未找到")
    if not _hw_latest_files(task_id):
        raise HTTPException(status_code=404, detail="还没有学生提交文件")

    api_key, _ = get_api_keys(teacher)
    if not api_key:
        raise HTTPException(status_code=400, detail="API Key 未配置，请在系统配置中设置")

    grouped = _hw_latest_files(task_id)
    if on_progress:
        on_progress(phase="识别图片", done=0, total=sum(
            1 for fs in grouped.values() for f in fs
            if (f["kind"] or "") == "image" and not (f["vl_digest"] or "").strip()))
    img = await _hw_ensure_images(task_id, api_key, "",
                                  on_done=(lambda: on_progress(phase="识别图片", step=1)) if on_progress else None)

    package_md, review_map = _hw_build_package(task_id, list(grouped))
    if on_progress:
        on_progress(phase="AI 评分", total=len(grouped))

    from backend.prompts.homework_grade import FILE_GRADING_PROMPT
    prompt = f"{build_ai_role()}\n" + FILE_GRADING_PROMPT.format(
        basis=_hw_basis(task), total_score=f"{float(task.get('total_score') or 100):g}")
    ai_text = await _hw_call_long(prompt, package_md, api_key, "正在批改学生上传文件提交的作业。")
    parsed = _hw_parse(ai_text)
    if not isinstance(parsed, dict):
        logger.error(f"[文件批改] 全班结果格式异常 task={task_id} raw={(ai_text or '')[:300]}")
        raise HTTPException(status_code=502, detail="AI 返回格式异常，请重试或改为逐个批改")

    total = float(task.get("total_score") or 100)
    policy = task.get("grading_policy") or "ai_then_review"
    published = 1 if policy == "ai_auto_publish" else 0
    grades = parsed.get("grades")
    if not isinstance(grades, list):
        grades = []
    written = 0
    skipped: list[str] = []
    seen: set[str] = set()
    for one in grades:
        if not isinstance(one, dict):
            continue
        student = str(one.get("student") or "").strip()
        if student.startswith("学生 "):
            student = student[3:]
        if not student or student not in grouped:
            continue
        seen.add(student)
        # 材料本身看不见（扫描件/未识别图片）或模型自己说拿不准 → 都要落到"待教师"
        needs = review_map.get(student, False) or bool(one.get("needs_review"))
        if _hw_write_grade(task_id, student, one, task, needs, published):
            skipped.append(student)
        else:
            written += 1
        if on_progress:
            on_progress(phase="AI 评分", done=written)

    # AI 漏批的学生：标记待人工，绝不留"看数字像批过了"的空洞
    for student in grouped:
        if student in seen:
            continue
        execute_insert_update(
            """INSERT OR REPLACE INTO task_grades
               (task_id, student_username, ai_score, ai_comment, needs_review, graded_by, published,
                ai_graded_at, teacher_score, teacher_comment)
               SELECT ?, ?, NULL, ?, 1, 'none', 0, datetime('now','localtime'), NULL, ''
               WHERE NOT EXISTS (SELECT 1 FROM task_grades g WHERE g.task_id=? AND g.student_username=?
                                 AND COALESCE(g.teacher_score, g.ai_score) IS NOT NULL)""",
            (task_id, student, "AI 本次未覆盖到这份提交，请教师批改或单人重批", task_id, student),
        )
        skipped.append(student)

    sim = _hw_similarity(task_id, persist=True)
    # 教师看到的两个数字必须来自库里真实的行状态：材料看不见（扫描件/未识别图片）也算待人工
    state = execute_query(
        "SELECT COUNT(*), SUM(CASE WHEN needs_review=1 THEN 1 ELSE 0 END), "
        "SUM(CASE WHEN COALESCE(teacher_score, ai_score) IS NOT NULL THEN 1 ELSE 0 END) "
        "FROM task_grades WHERE task_id=?", (task_id,))
    flagged = int(state[0][1] or 0) if state else 0
    scored = int(state[0][2] or 0) if state else 0
    summary = parsed.get("summary") if isinstance(parsed.get("summary"), dict) else {}
    summary = dict(summary or {})
    summary["total_students"] = len(grouped)
    summary["graded_ok"] = written
    summary["needs_review"] = flagged
    summary["images_vl"] = img
    execute_insert_update(
        "UPDATE tasks SET ai_summary=?, updated_at=datetime('now','localtime') WHERE id=?",
        (json.dumps(summary, ensure_ascii=False), task_id))
    _refresh_class_stats(task_id)

    logger.info(f"[文件批改] 全班完成 task={task_id} 有效={written} 待人工={len(skipped)} by={teacher}")
    return {
        "summary": summary,
        "graded_count": scored,
        "needs_review_count": flagged,
        "images": img,
        "similarity_pairs": sim,
        "published": published,
        "message": (f"AI 批改完成：有效 {written} 份，待教师处理 {len(skipped)} 份"
                    + ("（已按策略自动发布）" if published else "（默认待复核，点「发布成绩」后学生可见）")),
    }


async def _hw_grade_one_student(task_id: str, teacher: str, student: str) -> dict[str, Any]:
    """单个学生的文件作业重批（批改不准则逐个重跑，省 token 也不动别人的成绩）"""
    task = _hw_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="作业未找到")
    grouped = _hw_latest_files(task_id, student)
    if not grouped.get(student):
        raise HTTPException(status_code=404, detail=f"学生 {student} 没有提交文件")
    api_key, _ = get_api_keys(teacher)
    if not api_key:
        raise HTTPException(status_code=400, detail="API Key 未配置，请在系统配置中设置")

    await _hw_ensure_images(task_id, api_key, student)
    package_md, review_map = _hw_build_package(task_id, [student])

    from backend.prompts.homework_grade import FILE_STUDENT_GRADING_PROMPT
    prompt = f"{build_ai_role()}\n" + FILE_STUDENT_GRADING_PROMPT.format(
        basis=_hw_basis(task), student=student,
        total_score=f"{float(task.get('total_score') or 100):g}")
    ai_text = await _hw_call_long(prompt, package_md, api_key, f"正在批改学生 {student} 上传的作业文件。")
    parsed = _hw_parse(ai_text)
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=502, detail="AI 返回格式异常，请重试")
    one = parsed.get("grade")
    if not isinstance(one, dict):
        lst = parsed.get("grades")
        one = lst[0] if isinstance(lst, list) and lst and isinstance(lst[0], dict) else parsed

    bad = _hw_write_grade(task_id, student, one, task, review_map.get(student, False), 0)
    _refresh_class_stats(task_id)
    grade = _get_task_grade_row(task_id, student)
    if not grade:
        raise HTTPException(status_code=409, detail="批改结果未写入：该学生的提交可能已被回退")
    return {"grade": grade, "needs_review": bool(bad),
            "message": f"已完成 {student} 的文件作业批改（待复核后发布）"}


def _hw_similarity(task_id: str, persist: bool = False) -> list[dict[str, Any]]:
    """同班正文相似检测：只标旗不扣分，教师自己判断是讨论过还是抄的"""
    grouped = _hw_latest_files(task_id)
    task = _hw_task(task_id) or {}
    texts: dict[str, str] = {}
    for student, files in grouped.items():
        body, _ = _hw_student_body(task, files, "")
        texts[student] = re.sub(r"^· 文件：.*$", "", body, flags=re.M)
    pairs = homework.similarity_pairs(texts)
    if persist and pairs:
        by_student: dict[str, list[dict[str, Any]]] = {}
        for pr in pairs:
            by_student.setdefault(pr["a"], []).append({"with": pr["b"], "ratio": pr["ratio"]})
            by_student.setdefault(pr["b"], []).append({"with": pr["a"], "ratio": pr["ratio"]})
        for student, items in by_student.items():
            execute_insert_update(
                "UPDATE task_grades SET similarity=? WHERE task_id=? AND student_username=?",
                (json.dumps(items, ensure_ascii=False)[:500], task_id, student))
    return pairs


@router.post("/grading-job/{task_id}")
async def create_file_grading_job(task_id: str, request: Request):
    """🤖 文件作业全班/单人 AI 批改（后台任务 + 进度轮询）

    为什么不复用同步的 /ai-grade：一个班 40 份文件「图片识别 + 组包 + 评分」很容易
    超过一个请求能等的时长，做成后台任务教师才不用盯着转圈，失败也不会重复烧 token。
    """
    user = get_current_user(request)
    username = user["username"]
    if not can_create_task(username):
        raise HTTPException(status_code=403, detail="权限不足")
    task = _hw_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="作业未找到")
    if not is_admin(username) and task["creator_username"] != username:
        raise HTTPException(status_code=403, detail="无权限批改此任务")
    if (task.get("submit_mode") or "conversation") == "conversation":
        raise HTTPException(status_code=400, detail="对话作业请用 /api/tasks/ai-grade 批改")

    body: dict[str, Any] = {}
    try:
        body = await request.json() or {}
    except Exception:
        body = {}
    student = str(body.get("student") or "").strip()
    if student and not _hw_latest_files(task_id, student).get(student):
        raise HTTPException(status_code=404, detail=f"学生 {student} 没有提交文件")
    if not student and not _hw_latest_files(task_id):
        raise HTTPException(status_code=404, detail="还没有学生提交文件")

    from backend.ai_task_manager import task_manager, report_progress

    def on_progress(**fields: Any):
        if fields.get("step"):
            cur = _JOB_PROGRESS.get(task_id, {})
            cur["done"] = int(cur.get("done") or 0) + int(fields["step"])
            report_progress(**cur)
            return
        cur = _JOB_PROGRESS.get(task_id, {})
        cur.update({k: v for k, v in fields.items() if v is not None})
        _JOB_PROGRESS[task_id] = cur
        report_progress(**cur)

    async def run() -> dict[str, Any]:
        try:
            if student:
                return await _hw_grade_one_student(task_id, username, student)
            return await _hw_grade_class(task_id, username, on_progress=on_progress)
        finally:
            _JOB_PROGRESS.pop(task_id, None)

    job_id = await task_manager.create_task(
        f"批改文件作业「{task.get('name') or task_id}」" + (f"（{student}）" if student else "（全班）"),
        run,
        owner_username=username,
        dedupe_key=f"hw_grade:{task_id}:{username}:{student}",
        reuse_completed=False,          # 手动"再批一次"必须真跑一轮，不能拿上一轮回执
        max_concurrent=2,
    )
    return {"task_id": job_id,
            "poll_url": f"/api/interaction/ai-task/{job_id}",
            "message": "批改任务已开始，可稍后查看进度（不必一直等着）"}


_JOB_PROGRESS: dict[str, dict[str, Any]] = {}


@router.put("/grade-review/{task_id}")
async def grade_review(task_id: str, req: GradeReviewRequest, request: Request):
    """✍️ 教师复核：改分/改评语。AI 原分保留，学生端以教师分为准"""
    user = get_current_user(request)
    username = user["username"]
    task = _hw_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="作业未找到")
    if not is_admin(username) and task["creator_username"] != username:
        raise HTTPException(status_code=403, detail="无权限批改此任务")
    student = req.student.strip()
    if not student:
        raise HTTPException(status_code=400, detail="缺少 student")

    total = float(task.get("total_score") or 100)
    fields: list[str] = ["graded_by='teacher'"]
    params: list[Any] = []
    if req.score is not None:
        score = _clamp_score_to_total(req.score, total)
        if score is None:
            raise HTTPException(status_code=400, detail="分数无效")
        fields.append("teacher_score=?")
        params.append(score)
        dims = homework.rubric_of(task)
        if dims:
            # 教师只改总分时，维度分按原比例缩放，避免出现"总分 85 但维度加起来 72"
            row = execute_query_dict(
                "SELECT dim_scores, ai_score FROM task_grades WHERE task_id=? AND student_username=?",
                (task_id, student))
            if row:
                try:
                    old = json.loads(row[0]["dim_scores"] or "{}")
                except json.JSONDecodeError:
                    old = {}
                if isinstance(old, dict) and old:
                    fields.append("dim_scores=?")
                    params.append(json.dumps(_hw_norm_dim_scores(old, dims, score), ensure_ascii=False))
    if req.comment is not None:
        fields.append("teacher_comment=?")
        params.append(req.comment.strip()[:800])
    if req.feedback is not None:
        fields.append("ai_feedback=?")
        params.append(req.feedback.strip()[:500])
    if req.needs_review is not None:
        fields.append("needs_review=?")
        params.append(0 if not req.needs_review else 1)
    if not execute_query("SELECT id FROM task_grades WHERE task_id=? AND student_username=?",
                         (task_id, student)):
        execute_insert_update(
            "INSERT INTO task_grades (task_id, student_username, ai_graded_at) VALUES (?, ?, "
            "datetime('now','localtime'))", (task_id, student))
    params.extend([task_id, student])
    execute_insert_update(
        f"UPDATE task_grades SET {', '.join(fields)} WHERE task_id=? AND student_username=?",
        tuple(params))
    _refresh_class_stats(task_id)
    logger.info(f"[作业复核] task={task_id} student={student} by={username}")
    return {"grade": _get_task_grade_row(task_id, student), "message": "已保存教师批改结果"}


@router.post("/publish/{task_id}")
async def publish_task_grades(task_id: str, request: Request):
    """📣 发布成绩：学生可见 + 通知 + 等级奖（AI 分默认停在这里之前，教师确认才放行）"""
    user = get_current_user(request)
    username = user["username"]
    task = _hw_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="作业未找到")
    if not is_admin(username) and task["creator_username"] != username:
        raise HTTPException(status_code=403, detail="无权限发布此任务")

    rows = execute_query_dict(
        "SELECT student_username, needs_review FROM task_grades WHERE task_id=? "
        "AND COALESCE(teacher_score, ai_score) IS NOT NULL AND COALESCE(published,1)=0",
        (task_id,))
    if not rows:
        return {"message": "没有待发布的成绩（可能已发布，或还有学生未批改）", "published": 0}
    students = [r["student_username"] for r in rows]
    placeholders = ",".join("?" for _ in students)
    execute_insert_update(
        f"UPDATE task_grades SET published=1 WHERE task_id=? AND student_username IN ({placeholders})",
        tuple([task_id] + students))
    execute_insert_update(
        "UPDATE tasks SET publish_status='published', updated_at=datetime('now','localtime') WHERE id=?",
        (task_id,))

    total = float(task.get("total_score") or 100)
    awarded = 0
    try:
        from backend.reward_engine import award_grade
        for r in execute_query_dict(
            f"SELECT student_username, COALESCE(teacher_score, ai_score) AS s FROM task_grades "
            f"WHERE task_id=? AND student_username IN ({placeholders})", tuple([task_id] + students)):
            if r["s"] is not None and award_grade(r["student_username"], "task", str(task_id),
                                                  float(r["s"]), total, task.get("name") or ""):
                awarded += 1
    except Exception as e:
        logger.warning(f"[作业发布] 等级奖发放失败 task={task_id}: {e}")

    notified = True
    try:
        from backend.api.notification_router import notify_users
        enabled = get_config_value("enabled_notification_types", ["exam", "system"])
        notified = "task" in (enabled or [])
        notify_users(
            students, "task",
            f"作业成绩已发布：{task.get('name') or ''}",
            f"教师已发布「{task.get('name') or ''}」的批改结果，可查看分数与评语。",
            related_link=f"/tasks?task={task_id}", source_type="task", source_id=str(task_id))
    except Exception as e:
        notified = False
        logger.warning(f"[作业发布] 通知失败 task={task_id}: {e}")

    logger.info(f"[作业发布] task={task_id} 人数={len(students)} 等级奖={awarded} by={username}")
    return {
        "message": (f"已发布 {len(students)} 人的成绩"
                    + (f"，{awarded} 人获得等级奖" if awarded else "")
                    + ("" if notified else "（注意：系统配置里未启用「task」通知类型，学生不会收到推送）")),
        "published": len(students),
        "grade_awarded": awarded,
        "notified": notified,
    }


@router.get("/{task_id}/similarity")
async def get_task_similarity(task_id: str, request: Request):
    """相似提交一览（只标旗，判定权在教师）"""
    user = get_current_user(request)
    username = user["username"]
    task = _hw_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="作业未找到")
    if not is_admin(username) and task["creator_username"] != username:
        raise HTTPException(status_code=403, detail="无权限查看")
    pairs = _hw_similarity(task_id, persist=True)
    return {"pairs": pairs, "count": len(pairs),
            "message": f"发现 {len(pairs)} 组相似提交（相似度高≠抄袭，请结合课堂情况判断）"}


@router.get("/{task_id}/archive")
async def download_task_archive(task_id: str, request: Request):
    """📦 打包下载全班（或某位学生）最后提交的原件"""
    user = get_current_user(request)
    username = user["username"]
    task = _hw_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="作业未找到")
    if not is_admin(username) and task["creator_username"] != username:
        raise HTTPException(status_code=403, detail="无权限下载")

    student = request.query_params.get("student", "").strip()
    grouped = _hw_latest_files(task_id, student)
    if not grouped:
        raise HTTPException(status_code=404, detail="没有可下载的提交")

    import tempfile
    import zipfile
    from starlette.background import BackgroundTask
    fd, zip_path = tempfile.mkstemp(prefix="hw_archive_", suffix=".zip")
    os.close(fd)
    packed = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for who, files in grouped.items():
            for f in files:
                p = homework.resolve_stored(f["stored_path"])
                if not p:
                    continue
                zf.write(str(p), arcname=f"{who}/{f['filename']}")
                packed += 1
    name = f"{homework.safe_display_name(str(task.get('name') or '作业'))}_提交打包_{time.strftime('%Y%m%d_%H%M')}.zip"
    from urllib.parse import quote
    return FileResponse(
        zip_path, media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"},
        background=BackgroundTask(lambda p=zip_path: os.remove(p) if os.path.exists(p) else None),
    )
