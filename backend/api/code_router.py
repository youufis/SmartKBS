"""
代码练习 API 路由
支持：代码运行（不评分）、提交评分、AI 代码审查、题目管理
数据表：code_problems（独立表，不再依赖 question_bank）
"""
import asyncio
import json
import re
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.question_db import (
    execute_query as q_query,
    execute_insert as q_insert,
    execute_update as q_update,
    execute_query_one as q_one,
)
from backend.database import execute_query as db_query, execute_query_dict as db_query_dict
from backend.logger import logger
from backend.api.chat_router import get_api_keys
from backend.api.ai_service import call_ai_async
from backend.prompts import apply_skills, build_ai_role
from backend.utils import extract_json_from_text
from backend.code_runner import run_python, run_javascript, get_supported_languages
from backend.code_grader import grade_submission
from backend.permission_service import check_activity_visibility

router = APIRouter()


class CodeRunRequest(BaseModel):
    problem_id: Optional[int] = None
    language: str = "python"
    source_code: str
    input_data: str = ""


class CodeSubmitRequest(BaseModel):
    problem_id: int
    language: str = "python"
    source_code: str


class CodeProblemCreate(BaseModel):
    title: str
    description: str = ""
    subject: str = ""
    knowledge_points: str = ""
    difficulty: str = "medium"
    language: str = "python"
    template_code: str = ""
    starter_code: str = ""
    time_limit: int = 5
    target_scope: str = "teacher_classes"
    target_grade: str = ""
    target_class: str = ""
    target_users: str = ""
    test_cases: list[dict[str, Any]] = []


class CodeProblemUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    subject: Optional[str] = None
    knowledge_points: Optional[str] = None
    difficulty: Optional[str] = None
    language: Optional[str] = None
    template_code: Optional[str] = None
    starter_code: Optional[str] = None
    time_limit: Optional[int] = None


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ═══════════════════════════════════════════════════════════
# 1. 代码运行
# ═══════════════════════════════════════════════════════════

@router.post("/code/run", summary="运行代码（不评分）")
async def run_code(req: CodeRunRequest, request: Request):
    user = get_current_user(request)
    if len(req.source_code) > 50000:
        raise HTTPException(status_code=400, detail="代码过长")
    runner = {"python": run_python, "javascript": run_javascript}.get(req.language)
    if not runner:
        raise HTTPException(status_code=400, detail=f"不支持的语言: {req.language}")
    result = await runner(req.source_code, req.input_data)
    q_insert(
        "INSERT INTO code_runs (problem_id,student_username,language,source_code,input_data,output_data,execution_time,error_message,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (req.problem_id, user["username"], req.language, req.source_code,
         req.input_data, result.get("stdout", ""),
         result.get("execution_time", 0),
         result.get("error") or result.get("stderr", ""), _now()),
    )
    return result


# ═══════════════════════════════════════════════════════════
# 2. 提交评分
# ═══════════════════════════════════════════════════════════

@router.post("/code/submit", summary="提交代码评分")
async def submit_code(req: CodeSubmitRequest, request: Request):
    user = get_current_user(request)
    username = user["username"]
    problem = q_one("SELECT id, language FROM code_problems WHERE id=?", (req.problem_id,))
    if not problem:
        raise HTTPException(status_code=404, detail="题目不存在")
    if req.language != problem["language"]:
        raise HTTPException(status_code=400, detail=f"语言不匹配，该题使用 {problem['language']}")
    now = _now()
    sub_id = q_insert(
        "INSERT INTO code_submissions (problem_id,student_username,language,source_code,status,created_at) VALUES (?,?,?,?,'pending',?)",
        (req.problem_id, username, req.language, req.source_code, now))
    if sub_id is None:
        raise HTTPException(status_code=500, detail="创建提交记录失败")
    asyncio.create_task(_do_grade(sub_id, username, req.problem_id))
    return {"submission_id": sub_id, "status": "pending", "message": "评分中"}


async def _do_grade(submission_id: int, username: str, problem_id: int):
    try:
        result = await grade_submission(submission_id)
        best = q_query(
            "SELECT score FROM code_submissions WHERE problem_id=? AND student_username=? AND is_best=1",
            (problem_id, username))
        current_score = result.get("score", 0)
        if not best or current_score >= (best[0]["score"] if best else 0):
            q_update("UPDATE code_submissions SET is_best=0 WHERE problem_id=? AND student_username=?", (problem_id, username))
            q_update("UPDATE code_submissions SET is_best=1 WHERE id=?", (submission_id,))
        try:
            from backend.reward_engine import award_participation, award_grade
            award_participation(username, "code", str(problem_id), f"代码练习 #{problem_id}")
            ms = result.get("max_score", 10)
            if result.get("status") == "accepted" and ms > 0:
                award_grade(username, "code", str(problem_id), current_score, ms, f"代码练习 #{problem_id}")
        except Exception as e:
            logger.warning(f"积分发放失败: {e}")
        logger.info(f"评分完成: #{submission_id}, 得分 {current_score}")
    except Exception as e:
        logger.error(f"评分失败: #{submission_id}: {e}")
        q_update("UPDATE code_submissions SET status='failed', error_message=? WHERE id=?", (str(e)[:500], submission_id))


@router.get("/code/submissions/{submission_id}", summary="查询提交评分结果")
async def get_submission(submission_id: int, request: Request):
    user = get_current_user(request)
    sub = q_one("SELECT * FROM code_submissions WHERE id=? AND student_username=?", (submission_id, user["username"]))
    if not sub:
        raise HTTPException(status_code=404, detail="提交记录不存在")
    em = sub.get("error_message", "") or ""
    if em:
        try:
            sub["details"] = json.loads(em)
            sub["error_message"] = ""
        except Exception:
            sub["details"] = []
    return sub


# ═══════════════════════════════════════════════════════════
# 3. AI 代码审查
# ═══════════════════════════════════════════════════════════

@router.post("/code/submissions/{submission_id}/review", summary="AI 代码审查")
async def ai_code_review(submission_id: int, request: Request):
    user = get_current_user(request)
    username = user["username"]
    sub = q_one(
        "SELECT cs.*, cp.title as problem_title FROM code_submissions cs JOIN code_problems cp ON cp.id=cs.problem_id WHERE cs.id=? AND cs.student_username=?",
        (submission_id, username))
    if not sub:
        raise HTTPException(status_code=404, detail="提交记录不存在")
    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")
    from backend.prompts.code_review import CODE_REVIEW_PROMPT
    from backend.prompts import build_ai_role
    ai_role = build_ai_role()
    prompt = f"{ai_role}" + CODE_REVIEW_PROMPT.format(problem_title=sub["problem_title"], language=sub["language"], source_code=sub["source_code"])
    # 注意：不注入技能 — 技能的结构化输出指令与 JSON 格式要求冲突

    async def _do() -> dict[str, Any]:
        try:
            rt = await call_ai_async(prompt, api_key)
            d = extract_json_from_text(rt)
            if d:
                q_update("UPDATE code_submissions SET ai_review=?, ai_review_status='completed' WHERE id=?", (json.dumps(d, ensure_ascii=False), submission_id))
                return d
            q_update("UPDATE code_submissions SET ai_review_status='failed' WHERE id=?", (submission_id,))
            return {"error": "格式异常"}
        except Exception as e:
            q_update("UPDATE code_submissions SET ai_review_status='failed' WHERE id=?", (submission_id,))
            return {"error": str(e)}

    from backend.ai_task_manager import task_manager
    tid = await task_manager.create_task(description="AI 代码审查", coro_factory=_do)
    return {"task_id": tid, "message": "AI 审查已提交"}


@router.get("/code/submissions/{submission_id}/review", summary="查询 AI 审查结果")
async def get_code_review(submission_id: int, request: Request):
    user = get_current_user(request)
    sub = q_one("SELECT ai_review, ai_review_status FROM code_submissions WHERE id=? AND student_username=?", (submission_id, user["username"]))
    if not sub:
        raise HTTPException(status_code=404, detail="不存在")
    raw = sub.get("ai_review", "") or ""
    return {"status": sub["ai_review_status"], "review": json.loads(raw) if raw else None}


# ═══════════════════════════════════════════════════════════
# 4. 题目查询与提交历史
# ═══════════════════════════════════════════════════════════

@router.get("/code/languages", summary="获取支持的语言列表")
async def get_languages():
    return {"languages": get_supported_languages()}


@router.get("/code/problems", summary="获取代码题列表")
async def list_code_problems(
    request: Request,
    subject: str = Query(""),
    status: str = Query("active"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    where = "cp.status='active'"
    if status == "all":
        where = "1=1"
    params: list[Any] = []
    if subject:
        where += " AND cp.subject=?"
        params.append(subject)

    if role == 0:
        pass
    elif role == 1:
        where += " AND cp.creator_username=?"
        params.append(username)
    else:
        # 学生：获取后按目标范围过滤
        pass

    # 对于学生，先不限制 creator，获取所有活跃题目再过滤
    if role == 2:
        student_where = "1=1" if status == "all" else "cp.status='active'"
        student_params: list[Any] = []
        if subject:
            student_where += " AND cp.subject=?"
            student_params.append(subject)
        all_rows = q_query(
            f"SELECT cp.id,cp.id as problem_id,cp.title,cp.subject,cp.knowledge_points,cp.difficulty,cp.created_at,cp.creator_username,cp.creator_name,cp.language,cp.time_limit,cp.starter_code,cp.description,cp.template_code,cp.target_scope,cp.target_grade,cp.target_class,cp.target_users,cp.status FROM code_problems cp WHERE {student_where} ORDER BY cp.id DESC",
            tuple(student_params),
        )
        si = db_query_dict("SELECT grade,class FROM users WHERE username=?", (username,))
        s_grade = str(si[0]["grade"] or "") if si else ""
        s_class = str(si[0]["class"] or "") if si else ""
        filtered = []
        for r in all_rows:
            if check_activity_visibility(
                student_username=username,
                student_grade=s_grade,
                student_class=s_class,
                creator_username=r["creator_username"],
                target_scope=r.get("target_scope", "teacher_classes"),
                target_grade=r.get("target_grade", ""),
                target_class=r.get("target_class", ""),
                target_users=r.get("target_users", ""),
            ):
                filtered.append(r)
        total = len(filtered)
        offset_idx = (page - 1) * page_size
        rows = filtered[offset_idx:offset_idx + page_size]
        # 转换为 dict
        rows = [dict(r) for r in rows]
    else:
        total = (q_one(f"SELECT COUNT(*) as cnt FROM code_problems cp WHERE {where}", tuple(params)) or {}).get("cnt", 0)
        rows = q_query(
            f"SELECT cp.id as problem_id,cp.title,cp.subject,cp.knowledge_points,cp.difficulty,cp.created_at,cp.creator_username,cp.creator_name,cp.language,cp.time_limit,cp.starter_code FROM code_problems cp WHERE {where} ORDER BY cp.id DESC LIMIT ? OFFSET ?",
            tuple(params + [page_size, (page - 1) * page_size]))

    for r in rows:
        pid = r.get("problem_id") or r.get("id")
        b = q_one("SELECT status,score,id as submission_id FROM code_submissions WHERE problem_id=? AND student_username=? AND is_best=1", (pid, username))
        r["my_status"] = b["status"] if b else None
        r["my_score"] = b["score"] if b else None
        r["my_submission_id"] = b["submission_id"] if b else None
        if not r.get("creator_name"):
            r["creator_name"] = r.get("creator_username", "")
        if role in (0, 1):
            s = q_one("SELECT COALESCE(COUNT(*),0) as total_submissions, COALESCE(SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END),0) as accepted_count FROM code_submissions WHERE problem_id=?", (pid,))
            r["total_submissions"] = s["total_submissions"] if s else 0
            r["accepted_count"] = s["accepted_count"] if s else 0
    return {"items": rows, "total": total, "page": page, "page_size": page_size}


@router.get("/code/problems/{problem_id}", summary="获取代码题详情")
async def get_code_problem(problem_id: int, request: Request):
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    p = q_one("SELECT * FROM code_problems WHERE id=?", (problem_id,))
    if not p:
        raise HTTPException(status_code=404, detail="不存在")
    # 学生需检查活动范围
    if role == 2:
        si = db_query_dict("SELECT grade,class FROM users WHERE username=?", (username,))
        s_grade = str(si[0]["grade"] or "") if si else ""
        s_class = str(si[0]["class"] or "") if si else ""
        if not check_activity_visibility(
            student_username=username,
            student_grade=s_grade,
            student_class=s_class,
            creator_username=p["creator_username"],
            target_scope=p.get("target_scope", "teacher_classes"),
            target_grade=p.get("target_grade", ""),
            target_class=p.get("target_class", ""),
            target_users=p.get("target_users", ""),
        ):
            raise HTTPException(status_code=403, detail="无权查看该题目")
    # 统一字段名
    if "problem_id" not in p and "id" in p:
        p["problem_id"] = p["id"]
    p["sample_cases"] = q_query("SELECT id,input,expected_output,description,score FROM code_test_cases WHERE problem_id=? AND is_sample=1 ORDER BY sort_order", (problem_id,))
    b = q_one("SELECT id,status,score,passed_cases,total_cases,execution_time,source_code,created_at FROM code_submissions WHERE problem_id=? AND student_username=? AND is_best=1", (problem_id, user["username"]))
    p["best_submission"] = b
    return p


@router.get("/code/my-submissions/{problem_id}", summary="获取我的提交历史")
async def get_my_submissions(problem_id: int, request: Request):
    user = get_current_user(request)
    return {"submissions": q_query(
        "SELECT id,status,passed_cases,total_cases,score,execution_time,ai_review_status,created_at FROM code_submissions WHERE problem_id=? AND student_username=? ORDER BY created_at DESC LIMIT 50",
        (problem_id, user["username"]))}


# ═══════════════════════════════════════════════════════════
# 5. 教师端：创建/管理代码题
# ═══════════════════════════════════════════════════════════

@router.post("/code/problems", summary="[教师] 创建代码题")
async def create_code_problem(req: CodeProblemCreate, request: Request):
    user = get_current_user(request)
    if user.get("role", 2) not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")
    if not req.title.strip():
        raise HTTPException(status_code=400, detail="请输入标题")
    now = _now()
    uname = user.get("name") or user["username"]
    pid = q_insert(
        "INSERT INTO code_problems (title,description,subject,knowledge_points,difficulty,creator_username,creator_name,language,template_code,starter_code,time_limit,status,created_at,updated_at,target_scope,target_grade,target_class,target_users) VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?,?)",
        (req.title, req.description, req.subject, req.knowledge_points, req.difficulty, user["username"], uname, req.language, req.template_code, req.starter_code, req.time_limit, now, now,
         req.target_scope, req.target_grade, req.target_class, req.target_users))
    for i, tc in enumerate(req.test_cases):
        q_insert("INSERT INTO code_test_cases (problem_id,input,expected_output,is_sample,score,sort_order,description,created_at) VALUES (?,?,?,?,?,?,?,?)",
                 (pid, tc.get("input", ""), tc["expected_output"], 1 if tc.get("is_sample") else 0, tc.get("score", 1), i, tc.get("description", ""), now))
    logger.info(f"教师 {user['username']} 创建代码题: {req.title} (id={pid})")
    return {"status": "ok", "problem_id": pid}


@router.put("/code/problems/{problem_id}", summary="[教师] 更新代码题")
async def update_code_problem(problem_id: int, req: CodeProblemUpdate, request: Request):
    user = get_current_user(request)
    if user.get("role", 2) not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")
    if not q_one("SELECT id FROM code_problems WHERE id=?", (problem_id,)):
        raise HTTPException(status_code=404, detail="不存在")
    uf, up = [], []
    for f in ["title","description","subject","knowledge_points","difficulty","language","template_code","starter_code","time_limit"]:
        v = getattr(req, f, None)
        if v is not None:
            uf.append(f"{f}=?")
            up.append(v)
    if uf:
        up.extend([_now(), problem_id])
        q_update(f"UPDATE code_problems SET {','.join(uf)},updated_at=? WHERE id=?", tuple(up))
    return {"status": "ok"}


@router.delete("/code/problems/{problem_id}", summary="[教师] 删除代码题")
async def delete_code_problem(problem_id: int, request: Request):
    user = get_current_user(request)
    if user.get("role", 2) not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")
    if not q_one("SELECT id FROM code_problems WHERE id=?", (problem_id,)):
        raise HTTPException(status_code=404, detail="不存在")
    # 硬删除关联数据（测试用例、提交记录、运行记录）
    q_update("DELETE FROM code_test_cases WHERE problem_id=?", (problem_id,))
    q_update("DELETE FROM code_submissions WHERE problem_id=?", (problem_id,))
    q_update("DELETE FROM code_runs WHERE problem_id=?", (problem_id,))
    # activity_rewards 和 notifications 在 smartkb.db（使用主数据库连接）
    from backend.database import execute_insert_update as db_update
    db_update("DELETE FROM activity_rewards WHERE activity_type='code' AND activity_id=?", (str(problem_id),))
    db_update("DELETE FROM notifications WHERE source_type='code' AND source_id=?", (str(problem_id),))
    # 硬删主记录
    q_update("DELETE FROM code_problems WHERE id=?", (problem_id,))
    return {"status": "ok"}


@router.post("/code/problems/{problem_id}/test-cases", summary="[教师] 添加测试用例")
async def add_test_cases(problem_id: int, request: Request, cases: list[dict[str, Any]]):
    if request.state.user.get("role", 2) not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")
    now = _now()
    for i, tc in enumerate(cases):
        q_insert("INSERT INTO code_test_cases (problem_id,input,expected_output,is_sample,score,sort_order,description,created_at) VALUES (?,?,?,?,?,?,?,?)",
                 (problem_id, tc.get("input", ""), tc["expected_output"], 1 if tc.get("is_sample") else 0, tc.get("score", 1), i, tc.get("description", ""), now))
    return {"status": "ok"}


@router.get("/code/problems/{problem_id}/test-cases", summary="[教师] 获取测试用例")
async def get_test_cases(problem_id: int, request: Request):
    if request.state.user.get("role", 2) not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")
    return {"test_cases": q_query("SELECT id,input,expected_output,is_sample,score,sort_order,description FROM code_test_cases WHERE problem_id=? ORDER BY sort_order", (problem_id,))}


@router.get("/code/teachers/statistics", summary="[教师] 代码题统计数据")
async def get_code_teacher_statistics(request: Request):
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")
    username = user["username"]
    where = "cp.creator_username=?" if role == 1 else "1=1"
    params = [username] if role == 1 else []
    problems = q_query(f"SELECT cp.id as problem_id,cp.title,cp.subject FROM code_problems cp WHERE {where} AND cp.status='active' ORDER BY cp.id DESC", tuple(params))
    for p in problems:
        s = q_one("SELECT COUNT(DISTINCT student_username) as ts,COUNT(*) as tsub,SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) as ac FROM code_submissions WHERE problem_id=?", (p["problem_id"],))
        p.update(s or {})
    return {"problems": problems, "total": len(problems)}


@router.get("/code/problems/{problem_id}/submissions/detail", summary="[教师] 查看提交详情")
async def get_problem_submission_detail(problem_id: int, request: Request):
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")
    p = q_one("SELECT title,creator_username FROM code_problems WHERE id=?", (problem_id,))
    if not p:
        raise HTTPException(status_code=404, detail="不存在")
    if role == 1 and p["creator_username"] != user["username"]:
        raise HTTPException(status_code=403, detail="只能查看自己的题目")
    subs = q_query(
        "SELECT cs.id,cs.student_username,cs.status,cs.score,cs.passed_cases,cs.total_cases,cs.execution_time,cs.source_code,cs.created_at FROM code_submissions cs WHERE cs.problem_id=? AND cs.is_best=1 ORDER BY cs.score DESC,cs.created_at DESC",
        (problem_id,))
    for s in subs:
        ui = db_query_dict("SELECT name,class FROM users WHERE username=?", (s["student_username"],))
        s["student_name"] = ui[0]["name"] if ui and ui[0]["name"] else s["student_username"]
        s["student_class"] = ui[0]["class"] if ui else ""
    return {"title": p["title"], "submissions": subs, "total": len(subs)}


# ═══════════════════════════════════════════════════════════
# 6. AI 辅助生成代码题
# ═══════════════════════════════════════════════════════════

class AiGenerateCodeProblem(BaseModel):
    topic: str
    subject: str = ""
    language: str = "python"
    difficulty: str = "medium"


@router.post("/code/ai-generate", summary="[教师] AI 生成代码题")
async def ai_generate_code_problem(req: AiGenerateCodeProblem, request: Request):
    user = get_current_user(request)
    if user.get("role", 2) not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")
    if not req.topic.strip():
        raise HTTPException(status_code=400, detail="请输入主题")
    api_key, _ = get_api_keys(user["username"])
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")

    dd = {"easy": "简单", "medium": "中等", "hard": "困难"}.get(req.difficulty, "中等")
    ai_role = build_ai_role(subject=req.subject)
    prompt = (f"{ai_role}根据主题生成编程题。\n主题：{req.topic}\n语言：{req.language}\n难度：{dd}\n\n"
              "JSON格式：{\"title\":\"...\",\"description\":\"...\",\"template_code\":\"...\",\"starter_code\":\"...\","
              "\"reference_solution\":\"...\",\"knowledge_points\":\"...\","
              "\"test_cases\":[{\"input\":\"...\",\"expected_output\":\"...\",\"description\":\"...\",\"is_sample\":true,\"score\":1}]}"
              "\n至少5个测试用例，前2个is_sample=true，总分10")
    # 注意：不注入技能 — 技能的结构化输出指令与 JSON 格式要求冲突

    async def _do() -> dict[str, Any]:
        try:
            rt = await call_ai_async(prompt, api_key)
            d = extract_json_from_text(rt)
            if d:
                return {"status": "ok", "data": d, "raw": rt}
            return {"status": "error", "content": rt}
        except Exception as e:
            return {"status": "error", "content": str(e)}

    from backend.ai_task_manager import task_manager
    tid = await task_manager.create_task(description=f"AI 生成代码题: {req.topic}", coro_factory=_do)
    return {"task_id": tid, "message": "AI 生成中"}


@router.post("/code/ai-generate/save", summary="[教师] 保存 AI 生成的代码题")
async def save_ai_generated_problem(req: CodeProblemCreate, request: Request):
    if request.state.user.get("role", 2) not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")
    return await create_code_problem(req, request)
