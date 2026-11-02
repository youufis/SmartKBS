"""
代码练习 API 路由

支持：代码运行（不评分）、提交评分、AI 代码审查、题目管理、教师端统计。

数据表：code_problems / code_test_cases / code_submissions /
        code_submission_cases（逐用例明细）/ code_runs（运行留痕）

2026-11 调整：
- 判题走异步子进程（见 code_runner），不再阻塞事件循环
- 提交/运行做可见性、状态、长度与频率校验
- 教师只能管理自己创建的题目（管理员不受限）
- 明细独立落表；列表批量聚合，去掉 N+1
- 支持题目编辑测试用例、目标范围、上下架、参考解与重新判分
"""
import asyncio
import json
import time
from collections import deque
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel, Field

from backend.api.dependencies import get_current_user
from backend.question_db import (
    execute_query as q_query,
    execute_insert as q_insert,
    execute_update as q_update,
    execute_query_one as q_one,
    get_connection,
)
from backend.code_score import apply_split as _apply_split, split_100 as _split_100
from backend.database import execute_query_dict as db_query_dict
from backend.logger import logger
from backend.api.chat_router import get_api_keys
from backend.api.ai_service import call_ai_async
from backend.prompts import build_ai_role
from backend.utils import extract_json_from_text
from backend.code_runner import (
    run_python, run_javascript, get_supported_languages,
    MAX_CODE_LENGTH, MAX_INPUT_CHARS, GRADE_OUTPUT_CHARS,
)
from backend.code_grader import grade_submission
from backend.permission_service import (
    check_activity_visibility,
    get_students_by_scope,
    attach_student_info,
)

router = APIRouter()

# 判题任务只活在本进程：持有引用防止被 GC 提前回收
_ACTIVE_GRADES: set[asyncio.Task] = set()

# 轻量内存限流：run/submit 频率（进程内，重启即清）
_RATE_WINDOWS: dict[str, deque[float]] = {}
RATE_LIMITS = {
    "run": (30, 60.0),      # 60 秒内最多 30 次运行
    "submit": (10, 60.0),   # 60 秒内最多 10 次提交
}


class CodeTestCasePayload(BaseModel):
    input: str = ""
    expected_output: str = ""
    description: str = ""
    score: float = 1
    is_sample: bool = False


class CodeRunRequest(BaseModel):
    problem_id: Optional[int] = None
    language: str = "python"
    source_code: str = Field(default="", max_length=MAX_CODE_LENGTH)
    input_data: str = Field(default="", max_length=MAX_INPUT_CHARS)


class CodeSubmitRequest(BaseModel):
    problem_id: int
    language: str = "python"
    source_code: str = Field(default="", max_length=MAX_CODE_LENGTH)


class CodeProblemCreate(BaseModel):
    title: str = Field(default="", max_length=200)
    description: str = ""
    subject: str = ""
    knowledge_points: str = ""
    difficulty: str = "medium"
    language: str = "python"
    template_code: str = ""
    starter_code: str = ""
    reference_solution: str = ""
    time_limit: int = 5
    status: str = "active"
    target_scope: str = "teacher_classes"
    target_grade: str = ""
    target_class: str = ""
    target_users: str = ""
    test_cases: list[CodeTestCasePayload] = Field(default_factory=list)


class CodeProblemUpdate(BaseModel):
    title: Optional[str] = Field(default=None, max_length=200)
    description: Optional[str] = None
    subject: Optional[str] = None
    knowledge_points: Optional[str] = None
    difficulty: Optional[str] = None
    language: Optional[str] = None
    template_code: Optional[str] = None
    starter_code: Optional[str] = None
    reference_solution: Optional[str] = None
    time_limit: Optional[int] = None
    status: Optional[str] = None
    target_scope: Optional[str] = None
    target_grade: Optional[str] = None
    target_class: Optional[str] = None
    target_users: Optional[str] = None
    # 传入则整组替换；不传则保持原样
    test_cases: Optional[list[CodeTestCasePayload]] = None


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _role(user: dict[str, Any]) -> int:
    raw = user.get("role")
    if raw is None:
        return 2
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 2


def _is_manager(user: dict[str, Any]) -> bool:
    return _role(user) in (0, 1)


def _ensure_manager(user: dict[str, Any], problem: dict[str, Any]) -> None:
    """管理员可管全部；教师只能管自己创建的题。"""
    role = _role(user)
    if role == 0:
        return
    if role == 1 and problem.get("creator_username") == user.get("username"):
        return
    raise HTTPException(status_code=403, detail="只能管理自己创建的代码题")


def _student_scope(username: str) -> tuple[str, str]:
    si = db_query_dict("SELECT grade, class FROM users WHERE username=?", (username,))
    if not si:
        return "", ""
    return str(si[0].get("grade") or ""), str(si[0].get("class") or "")


def _student_can_see(user: dict[str, Any], problem: dict[str, Any]) -> bool:
    if _role(user) != 2:
        return True
    s_grade, s_class = _student_scope(user["username"])
    return check_activity_visibility(
        student_username=user["username"],
        student_grade=s_grade,
        student_class=s_class,
        creator_username=problem.get("creator_username", ""),
        target_scope=problem.get("target_scope", "teacher_classes"),
        target_grade=problem.get("target_grade", ""),
        target_class=problem.get("target_class", ""),
        target_users=problem.get("target_users", ""),
    )


def _load_problem(problem_id: int, *, active_only: bool = False) -> dict[str, Any]:
    p = q_one("SELECT * FROM code_problems WHERE id=?", (problem_id,))
    if not p or p.get("status") == "deleted":
        # deleted 是历史软删除标记：一律当不存在，避免管理员列表/详情把它算进来
        raise HTTPException(status_code=404, detail="题目不存在")
    if active_only and p.get("status") != "active":
        raise HTTPException(status_code=404, detail="题目不存在或已下架")
    return p


def _ensure_can_access(user: dict[str, Any], problem: dict[str, Any], *, active_only: bool = True) -> None:
    if active_only and problem.get("status") != "active":
        # 教师/管理员可以预览下架题；学生不行
        if _role(user) == 2:
            raise HTTPException(status_code=404, detail="题目不存在或已下架")
    if not _student_can_see(user, problem):
        raise HTTPException(status_code=403, detail="无权访问该题目")


def _rate_check(kind: str, username: str) -> None:
    limit, window = RATE_LIMITS[kind]
    key = f"{kind}:{username}"
    now = time.monotonic()
    dq = _RATE_WINDOWS.setdefault(key, deque())
    while dq and now - dq[0] > window:
        dq.popleft()
    if len(dq) >= limit:
        raise HTTPException(status_code=429, detail="操作太频繁，请稍后再试")
    dq.append(now)
    # 防止长期运行后字典无限增长
    if len(_RATE_WINDOWS) > 5000:
        for k in [k for k, v in _RATE_WINDOWS.items() if not v or now - v[-1] > window]:
            _RATE_WINDOWS.pop(k, None)


def _validate_cases(cases: list[CodeTestCasePayload]) -> float:
    if not cases:
        raise HTTPException(status_code=400, detail="至少配置一个测试用例")
    if len(cases) > 50:
        raise HTTPException(status_code=400, detail="测试用例最多 50 个")
    total = 0.0
    for i, case in enumerate(cases, 1):
        if not (case.input or "").strip() and not (case.expected_output or "").strip() \
                and not (case.description or "").strip():
            raise HTTPException(status_code=400, detail=f"第 {i} 个用例是空的")
        if len(case.input or "") > MAX_INPUT_CHARS:
            raise HTTPException(status_code=400, detail=f"第 {i} 个用例的输入超过 {MAX_INPUT_CHARS} 字符上限")
        if len(case.expected_output or "") > 20000:
            raise HTTPException(status_code=400, detail=f"第 {i} 个用例的期望输出超过 20000 字符上限")
        if case.score is None or case.score < 0 or case.score > 100:
            raise HTTPException(status_code=400, detail=f"第 {i} 个用例分值需在 0~100 之间")
        total += float(case.score)
    if total <= 0:
        raise HTTPException(status_code=400, detail="测试用例总分必须大于 0")
    if total > 1000:
        raise HTTPException(status_code=400, detail="测试用例总分不能超过 1000")
    return round(total, 2)


def _insert_cases(problem_id: int, cases: list[CodeTestCasePayload], *, replace: bool = False) -> None:
    now = _now()
    with get_connection() as conn:
        c = conn.cursor()
        start = 0
        if replace:
            c.execute("DELETE FROM code_test_cases WHERE problem_id=?", (problem_id,))
        else:
            row = c.execute(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM code_test_cases WHERE problem_id=?",
                (problem_id,),
            ).fetchone()
            start = int(row[0] or 0) if row else 0
        c.executemany(
            """INSERT INTO code_test_cases
               (problem_id, input, expected_output, is_sample, score, sort_order, description, created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            [
                (
                    problem_id, case.input or "", case.expected_output or "",
                    1 if case.is_sample else 0, float(case.score), start + i,
                    case.description or "", now,
                )
                for i, case in enumerate(cases)
            ],
        )
        # 用例分归一到合计 100：相对权重保留，满分统一（教师看到的分值可能被按比例调整）
        _apply_split(c, problem_id)
        conn.commit()


def _cases_equal(existing: list[dict[str, Any]], cases: list[CodeTestCasePayload]) -> bool:
    """判断测试用例组是否与库里一致，避免改个标题就把用例全删了重建。"""
    if len(existing) != len(cases):
        return False
    for row, case in zip(existing, cases):
        if (row.get("input") or "") != (case.input or ""):
            return False
        if (row.get("expected_output") or "") != (case.expected_output or ""):
            return False
        if (row.get("description") or "") != (case.description or ""):
            return False
        if bool(row.get("is_sample")) != bool(case.is_sample):
            return False
        if abs(float(row.get("score") or 0) - float(case.score or 0)) > 1e-9:
            return False
    return True


def _problem_max_score(problem_id: int) -> float:
    row = q_one(
        "SELECT COALESCE(SUM(score), 0) AS total FROM code_test_cases WHERE problem_id=?",
        (problem_id,),
    )
    return round(float((row or {}).get("total") or 0), 2)


def _spawn_grade(submission_id: int, username: str, problem_id: int) -> None:
    task = asyncio.create_task(_do_grade(submission_id, username, problem_id))
    _ACTIVE_GRADES.add(task)
    task.add_done_callback(_ACTIVE_GRADES.discard)


# ═══════════════════════════════════════════════════════════
# 1. 代码运行
# ═══════════════════════════════════════════════════════════

@router.post("/code/run", summary="运行代码（不评分）")
async def run_code(req: CodeRunRequest, request: Request):
    user = get_current_user(request)
    username = user["username"]
    _rate_check("run", username)

    runner = {"python": run_python, "javascript": run_javascript}.get(req.language)
    if not runner:
        raise HTTPException(status_code=400, detail=f"不支持的语言: {req.language}")

    timeout = 10.0
    if req.problem_id:
        problem = _load_problem(req.problem_id)
        _ensure_can_access(user, problem)
        try:
            timeout = max(0.5, min(60.0, float(problem.get("time_limit") or 10)))
        except (TypeError, ValueError):
            timeout = 10.0

    result = await runner(req.source_code, req.input_data, timeout=timeout)
    q_insert(
        "INSERT INTO code_runs (problem_id,student_username,language,source_code,input_data,output_data,execution_time,error_message,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (req.problem_id, username, req.language, req.source_code,
         req.input_data, result.get("stdout", ""),
         result.get("execution_time", 0),
         (result.get("error") or result.get("stderr", ""))[:1000], _now()),
    )
    # 每人只留最近 200 条运行记录，避免 code_runs 无限膨胀
    q_update(
        """DELETE FROM code_runs
           WHERE student_username=? AND id NOT IN (
               SELECT id FROM code_runs WHERE student_username=? ORDER BY id DESC LIMIT 200
           )""",
        (username, username),
    )
    result["time_limit"] = timeout
    return result


# ═══════════════════════════════════════════════════════════
# 2. 提交评分
# ═══════════════════════════════════════════════════════════

@router.post("/code/submit", summary="提交代码评分")
async def submit_code(req: CodeSubmitRequest, request: Request):
    user = get_current_user(request)
    username = user["username"]
    _rate_check("submit", username)

    problem = _load_problem(req.problem_id, active_only=True)
    _ensure_can_access(user, problem)
    if req.language != problem["language"]:
        raise HTTPException(status_code=400, detail=f"语言不匹配，该题使用 {problem['language']}")
    if not req.source_code.strip():
        raise HTTPException(status_code=400, detail="代码不能为空")

    # 同一题还有判题中的提交：直接复用，避免连点生成一串任务
    pending = q_one(
        """SELECT id FROM code_submissions
           WHERE problem_id=? AND student_username=? AND status IN ('pending','running')
           ORDER BY id DESC LIMIT 1""",
        (req.problem_id, username),
    )
    if pending:
        return {"submission_id": pending["id"], "status": "pending", "message": "上一次判题还在进行"}

    now = _now()
    max_score = _problem_max_score(req.problem_id)
    sub_id = q_insert(
        """INSERT INTO code_submissions
           (problem_id,student_username,language,source_code,status,max_score,created_at)
           VALUES (?,?,?,?,'pending',?,?)""",
        (req.problem_id, username, req.language, req.source_code, max_score, now),
    )
    if sub_id is None:
        raise HTTPException(status_code=500, detail="创建提交记录失败")
    _spawn_grade(sub_id, username, req.problem_id)
    return {"submission_id": sub_id, "status": "pending", "message": "评分中"}


async def _do_grade(submission_id: int, username: str, problem_id: int):
    try:
        result = await grade_submission(submission_id)
        if result.get("status") == "error":
            logger.warning(f"判题未完成: #{submission_id}: {result.get('error')}")
            return
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
    sub = q_one(
        """SELECT cs.*, cp.title AS problem_title, cp.language AS problem_language
           FROM code_submissions cs
           JOIN code_problems cp ON cp.id = cs.problem_id
           WHERE cs.id=?""",
        (submission_id,),
    )
    if not sub:
        raise HTTPException(status_code=404, detail="提交记录不存在")
    role = _role(user)
    if role == 2 and sub.get("student_username") != user["username"]:
        raise HTTPException(status_code=404, detail="提交记录不存在")

    details = q_query(
        """SELECT case_id, case_index, description, is_sample, input, expected,
                  actual, is_pass, score, execution_time, error
           FROM code_submission_cases
           WHERE submission_id=? ORDER BY case_index""",
        (submission_id,),
    )
    if not details:
        # 兼容旧数据：以前的明细塞在 error_message 的 JSON 里（可能被截断）
        em = sub.get("error_message", "") or ""
        if em.lstrip().startswith("["):
            try:
                parsed = json.loads(em)
                if isinstance(parsed, list):
                    details = parsed
                    sub["error_message"] = ""
            except Exception:
                pass
    sub["details"] = details
    if not sub.get("max_score"):
        sub["max_score"] = _problem_max_score(sub["problem_id"])
    return sub


# ═══════════════════════════════════════════════════════════
# 3. AI 代码审查
# ═══════════════════════════════════════════════════════════

@router.post("/code/submissions/{submission_id}/review", summary="AI 代码审查")
async def ai_code_review(submission_id: int, request: Request):
    user = get_current_user(request)
    username = user["username"]
    sub = q_one(
        "SELECT cs.*, cp.title as problem_title FROM code_submissions cs JOIN code_problems cp ON cp.id=cs.problem_id WHERE cs.id=?",
        (submission_id,),
    )
    if not sub:
        raise HTTPException(status_code=404, detail="提交记录不存在")
    if _role(user) == 2 and sub.get("student_username") != username:
        raise HTTPException(status_code=404, detail="提交记录不存在")
    if sub.get("status") in ("pending", "running"):
        raise HTTPException(status_code=400, detail="判题尚未完成，暂不能审查")

    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")
    from backend.prompts.code_review import CODE_REVIEW_PROMPT
    ai_role = build_ai_role()
    prompt = f"{ai_role}" + CODE_REVIEW_PROMPT.format(
        problem_title=sub["problem_title"],
        language=sub["language"],
        source_code=(sub["source_code"] or "")[:MAX_CODE_LENGTH],
    )

    q_update(
        "UPDATE code_submissions SET ai_review_status='running', ai_review_error='' WHERE id=?",
        (submission_id,),
    )

    async def _do() -> dict[str, Any]:
        try:
            rt = await call_ai_async(prompt, api_key, json_mode=True, use_kb=False)
            d = extract_json_from_text(rt)
            if d:
                q_update(
                    "UPDATE code_submissions SET ai_review=?, ai_review_status='completed' WHERE id=?",
                    (json.dumps(d, ensure_ascii=False), submission_id),
                )
                return d
            q_update(
                "UPDATE code_submissions SET ai_review_status='failed', ai_review_error=? WHERE id=?",
                ("AI 返回格式异常", submission_id),
            )
            return {"error": "格式异常"}
        except Exception as e:
            q_update(
                "UPDATE code_submissions SET ai_review_status='failed', ai_review_error=? WHERE id=?",
                (str(e)[:500], submission_id),
            )
            return {"error": str(e)}

    from backend.ai_task_manager import task_manager
    tid = await task_manager.create_task(description="AI 代码审查", coro_factory=_do)
    return {"task_id": tid, "message": "AI 审查已提交"}


@router.get("/code/submissions/{submission_id}/review", summary="查询 AI 审查结果")
async def get_code_review(submission_id: int, request: Request):
    user = get_current_user(request)
    sub = q_one(
        "SELECT student_username, ai_review, ai_review_status, ai_review_error FROM code_submissions WHERE id=?",
        (submission_id,),
    )
    if not sub:
        raise HTTPException(status_code=404, detail="不存在")
    if _role(user) == 2 and sub.get("student_username") != user["username"]:
        raise HTTPException(status_code=404, detail="不存在")
    raw = sub.get("ai_review", "") or ""
    review = None
    if raw:
        try:
            review = json.loads(raw)
        except Exception:
            review = None
    return {
        "status": sub["ai_review_status"],
        "review": review,
        "error": sub.get("ai_review_error") or "",
    }


# ═══════════════════════════════════════════════════════════
# 4. 题目查询与提交历史
# ═══════════════════════════════════════════════════════════

@router.get("/code/languages", summary="获取支持的语言列表")
async def get_languages():
    return {"languages": get_supported_languages()}


def _visible_problem_rows(user: dict[str, Any], where: str, params: list[Any]) -> list[dict[str, Any]]:
    """学生端：先按可见范围过滤，再在内存里分页（权限判断依赖目标范围逻辑）。"""
    sql = (
        "SELECT cp.id, cp.id as problem_id, cp.title, cp.subject, cp.knowledge_points, "
        "cp.difficulty, cp.created_at, cp.creator_username, cp.creator_name, cp.language, "
        "cp.time_limit, cp.starter_code, cp.status, cp.target_scope, cp.target_grade, "
        "cp.target_class, cp.target_users FROM code_problems cp "
        f"WHERE {where} ORDER BY cp.id DESC"
    )
    all_rows = q_query(sql, tuple(params))
    username = user["username"]
    s_grade, s_class = _student_scope(username)
    return [
        r for r in all_rows
        if check_activity_visibility(
            student_username=username,
            student_grade=s_grade,
            student_class=s_class,
            creator_username=r["creator_username"],
            target_scope=r.get("target_scope", "teacher_classes"),
            target_grade=r.get("target_grade", ""),
            target_class=r.get("target_class", ""),
            target_users=r.get("target_users", ""),
        )
    ]


@router.get("/code/problems", summary="获取代码题列表")
async def list_code_problems(
    request: Request,
    subject: str = Query(""),
    status: str = Query("active"),
    difficulty: str = Query(""),
    keyword: str = Query(""),
    my_status: str = Query(""),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    user = get_current_user(request)
    username = user["username"]
    role = _role(user)

    params: list[Any] = []
    if role == 2:
        # 学生永远只看已发布题目
        where = "cp.status='active'"
    elif status == "all":
        # 「全部」= 已发布 + 已下架；历史 deleted 行永远不展示
        where = "cp.status IN ('active','paused')"
    elif status in ("active", "paused"):
        where = "cp.status=?"
        params.append(status)
    else:
        where = "cp.status='active'"
    if subject:
        where += " AND cp.subject=?"
        params.append(subject)
    if difficulty in ("easy", "medium", "hard"):
        where += " AND cp.difficulty=?"
        params.append(difficulty)
    if keyword.strip():
        kw = f"%{keyword.strip()}%"
        where += " AND (cp.title LIKE ? OR cp.knowledge_points LIKE ? OR cp.description LIKE ?)"
        params.extend([kw, kw, kw])
    if role == 1:
        where += " AND cp.creator_username=?"
        params.append(username)

    if role == 2:
        rows = _visible_problem_rows(user, where, params)
    else:
        total = (q_one(f"SELECT COUNT(*) as cnt FROM code_problems cp WHERE {where}", tuple(params)) or {}).get("cnt", 0)
        rows = q_query(
            "SELECT cp.id as problem_id,cp.title,cp.subject,cp.knowledge_points,cp.difficulty,"
            "cp.created_at,cp.creator_username,cp.creator_name,cp.language,cp.time_limit,"
            "cp.starter_code,cp.status,cp.target_scope,cp.target_grade,cp.target_class,cp.target_users "
            f"FROM code_problems cp WHERE {where} ORDER BY cp.id DESC LIMIT ? OFFSET ?",
            tuple(params + [page_size, (page - 1) * page_size]))

    # ── 批量补「我的最佳提交」「用例总分」「教师端统计」：一次查询替代逐行 N+1 ──
    ids = [int(r.get("problem_id") or r.get("id")) for r in rows]
    best_map: dict[int, dict[str, Any]] = {}
    max_score_map: dict[int, float] = {}
    stats_map: dict[int, dict[str, Any]] = {}
    if ids:
        ph = ",".join("?" for _ in ids)
        for b in q_query(
            f"""SELECT problem_id, status, score, id as submission_id
                FROM code_submissions
                WHERE student_username=? AND is_best=1 AND problem_id IN ({ph})""",
            tuple([username] + ids),
        ):
            best_map[int(b["problem_id"])] = b
        for m in q_query(
            f"""SELECT problem_id, COALESCE(SUM(score), 0) AS total
                FROM code_test_cases WHERE problem_id IN ({ph}) GROUP BY problem_id""",
            tuple(ids),
        ):
            max_score_map[int(m["problem_id"])] = round(float(m["total"] or 0), 2)
        if role in (0, 1):
            for s in q_query(
                f"""SELECT problem_id,
                           COUNT(*) AS total_submissions,
                           COUNT(DISTINCT student_username) AS total_students,
                           SUM(CASE WHEN is_best=1 AND status='accepted' THEN 1 ELSE 0 END) AS accepted_students
                    FROM code_submissions WHERE problem_id IN ({ph}) GROUP BY problem_id""",
                tuple(ids),
            ):
                stats_map[int(s["problem_id"])] = s

    if role == 2 and my_status:
        def _match(row: dict[str, Any]) -> bool:
            st = (best_map.get(int(row["problem_id"])) or {}).get("status")
            if my_status == "accepted":
                return st == "accepted"
            if my_status == "unaccepted":
                return bool(st) and st != "accepted"
            if my_status == "untried":
                return not st
            return True
        rows = [r for r in rows if _match(r)]
        total = len(rows)
        rows = rows[(page - 1) * page_size:(page - 1) * page_size + page_size]
    elif role == 2:
        total = len(rows)
        rows = rows[(page - 1) * page_size:(page - 1) * page_size + page_size]

    for r in rows:
        pid = int(r.get("problem_id") or r.get("id"))
        b = best_map.get(pid)
        r["my_status"] = b["status"] if b else None
        r["my_score"] = b["score"] if b else None
        r["my_submission_id"] = b["submission_id"] if b else None
        r["max_score"] = max_score_map.get(pid, 0)
        if not r.get("creator_name"):
            r["creator_name"] = r.get("creator_username", "")
        if role in (0, 1):
            s = stats_map.get(pid) or {}
            r["total_submissions"] = int(s.get("total_submissions") or 0)
            r["total_students"] = int(s.get("total_students") or 0)
            r["accepted_students"] = int(s.get("accepted_students") or 0)
            r["pass_rate"] = round(
                (r["accepted_students"] / r["total_students"] * 100) if r["total_students"] else 0, 1
            )
    return {"items": rows, "total": total, "page": page, "page_size": page_size}


@router.get("/code/problems/{problem_id}", summary="获取代码题详情")
async def get_code_problem(problem_id: int, request: Request):
    user = get_current_user(request)
    role = _role(user)
    p = _load_problem(problem_id)
    _ensure_can_access(user, p)
    if "problem_id" not in p:
        p["problem_id"] = p["id"]

    p["sample_cases"] = q_query(
        "SELECT id,input,expected_output,description,score FROM code_test_cases WHERE problem_id=? AND is_sample=1 ORDER BY sort_order, id",
        (problem_id,),
    )
    p["max_score"] = _problem_max_score(problem_id)
    # 学生端统一用 initial_code，避免 template/starter 两套字段打架
    p["initial_code"] = p.get("starter_code") or p.get("template_code") or ""
    b = q_one(
        """SELECT id,status,score,max_score,passed_cases,total_cases,execution_time,source_code,created_at
           FROM code_submissions WHERE problem_id=? AND student_username=? AND is_best=1""",
        (problem_id, user["username"]),
    )
    p["best_submission"] = b
    if role == 2:
        # 参考解只给教师看，学生拿到就能直接抄
        p.pop("reference_solution", None)
    return p


@router.get("/code/my-submissions/{problem_id}", summary="获取我的提交历史")
async def get_my_submissions(problem_id: int, request: Request):
    user = get_current_user(request)
    subs = q_query(
        """SELECT id,status,passed_cases,total_cases,score,max_score,execution_time,
                  ai_review_status,is_best,created_at
           FROM code_submissions WHERE problem_id=? AND student_username=?
           ORDER BY created_at DESC, id DESC LIMIT 50""",
        (problem_id, user["username"]),
    )
    if subs and not subs[0].get("max_score"):
        ms = _problem_max_score(problem_id)
        for s in subs:
            s["max_score"] = ms
    return {"submissions": subs}


# ═══════════════════════════════════════════════════════════
# 5. 教师端：创建/管理代码题
# ═══════════════════════════════════════════════════════════

@router.post("/code/problems", summary="[教师] 创建代码题")
async def create_code_problem(req: CodeProblemCreate, request: Request):
    user = get_current_user(request)
    if not _is_manager(user):
        raise HTTPException(status_code=403, detail="权限不足")
    if not req.title.strip():
        raise HTTPException(status_code=400, detail="请输入标题")
    if req.status not in ("active", "paused"):
        raise HTTPException(status_code=400, detail="状态只能是 active 或 paused")
    if not (1 <= int(req.time_limit) <= 60):
        raise HTTPException(status_code=400, detail="单用例时间限制需在 1~60 秒之间")
    total = _validate_cases(req.test_cases)

    now = _now()
    uname = user.get("name") or user["username"]
    pid = q_insert(
        """INSERT INTO code_problems
           (title,description,subject,knowledge_points,difficulty,creator_username,creator_name,
            language,template_code,starter_code,reference_solution,time_limit,status,
            created_at,updated_at,target_scope,target_grade,target_class,target_users)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (req.title.strip(), req.description, req.subject, req.knowledge_points,
         req.difficulty, user["username"], uname, req.language, req.template_code,
         req.starter_code or req.template_code, req.reference_solution,
         int(req.time_limit), req.status, now, now,
         req.target_scope, req.target_grade, req.target_class, req.target_users),
    )
    if pid is None:
        raise HTTPException(status_code=500, detail="创建题目失败")
    _insert_cases(pid, req.test_cases)
    logger.info(f"教师 {user['username']} 创建代码题: {req.title} (id={pid}, 用例总分 {total})")
    return {"status": "ok", "problem_id": pid, "max_score": total}


@router.put("/code/problems/{problem_id}", summary="[教师] 更新代码题")
async def update_code_problem(problem_id: int, req: CodeProblemUpdate, request: Request):
    user = get_current_user(request)
    problem = _load_problem(problem_id)
    _ensure_manager(user, problem)

    if req.status is not None and req.status not in ("active", "paused"):
        raise HTTPException(status_code=400, detail="状态只能是 active 或 paused")
    if req.time_limit is not None and not (1 <= int(req.time_limit) <= 60):
        raise HTTPException(status_code=400, detail="单用例时间限制需在 1~60 秒之间")
    if req.test_cases is not None:
        _validate_cases(req.test_cases)

    uf, up = [], []
    fields = [
        "title", "description", "subject", "knowledge_points", "difficulty", "language",
        "template_code", "starter_code", "reference_solution", "time_limit", "status",
        "target_scope", "target_grade", "target_class", "target_users",
    ]
    for f in fields:
        v = getattr(req, f, None)
        if v is not None:
            if f == "title":
                v = v.strip()
                if not v:
                    raise HTTPException(status_code=400, detail="标题不能为空")
            uf.append(f"{f}=?")
            up.append(v)
    # 学生看到的初始代码统一取 starter_code（旧字段）优先；
    # 前端现在只编辑 template_code，改模板时同步把 starter_code 一起更新，
    # 否则编辑后学生仍看到旧代码。
    if req.template_code is not None and req.starter_code is None:
        uf.append("starter_code=?")
        up.append(req.template_code)
    if uf:
        up.extend([_now(), problem_id])
        q_update(f"UPDATE code_problems SET {','.join(uf)},updated_at=? WHERE id=?", tuple(up))

    needs_regrade = False
    if req.test_cases is not None:
        existing_cases = q_query(
            """SELECT input, expected_output, description, score, is_sample
               FROM code_test_cases WHERE problem_id=? ORDER BY sort_order, id""",
            (problem_id,),
        )
        if not _cases_equal(existing_cases, req.test_cases):
            _insert_cases(problem_id, req.test_cases, replace=True)
            needs_regrade = True
    if req.time_limit is not None and int(req.time_limit) != int(problem.get("time_limit") or 0):
        needs_regrade = True

    return {"status": "ok", "needs_regrade": needs_regrade}


@router.delete("/code/problems/{problem_id}", summary="[教师] 删除代码题")
async def delete_code_problem(problem_id: int, request: Request):
    user = get_current_user(request)
    problem = _load_problem(problem_id)
    _ensure_manager(user, problem)

    # 先删逐用例明细，再删提交主记录
    q_update(
        "DELETE FROM code_submission_cases WHERE submission_id IN (SELECT id FROM code_submissions WHERE problem_id=?)",
        (problem_id,),
    )
    q_update("DELETE FROM code_test_cases WHERE problem_id=?", (problem_id,))
    q_update("DELETE FROM code_submissions WHERE problem_id=?", (problem_id,))
    q_update("DELETE FROM code_runs WHERE problem_id=?", (problem_id,))
    from backend.database import execute_insert_update as db_update
    from backend.reward_engine import activity_reward_students, recompute_students
    _affected = activity_reward_students([("code", problem_id)])
    db_update("DELETE FROM activity_rewards WHERE activity_type='code' AND activity_id=?", (str(problem_id),))
    db_update("DELETE FROM notifications WHERE source_type='code' AND source_id=?", (str(problem_id),))
    recompute_students(_affected)
    q_update("DELETE FROM code_problems WHERE id=?", (problem_id,))
    logger.info(f"教师 {user['username']} 删除代码题 #{problem_id}: {problem.get('title')}")
    return {"status": "ok"}


@router.put("/code/problems/{problem_id}/test-cases", summary="[教师] 整组替换测试用例")
async def replace_test_cases(problem_id: int, request: Request, cases: list[CodeTestCasePayload]):
    user = get_current_user(request)
    problem = _load_problem(problem_id)
    _ensure_manager(user, problem)
    total = _validate_cases(cases)
    _insert_cases(problem_id, cases, replace=True)
    return {"status": "ok", "max_score": total, "needs_regrade": True}


@router.post("/code/problems/{problem_id}/test-cases", summary="[教师] 追加测试用例")
async def add_test_cases(problem_id: int, request: Request, cases: list[CodeTestCasePayload]):
    user = get_current_user(request)
    problem = _load_problem(problem_id)
    _ensure_manager(user, problem)
    _validate_cases(cases)
    _insert_cases(problem_id, cases)
    return {"status": "ok", "max_score": _problem_max_score(problem_id)}


@router.get("/code/problems/{problem_id}/test-cases", summary="[教师] 获取测试用例")
async def get_test_cases(problem_id: int, request: Request):
    user = get_current_user(request)
    problem = _load_problem(problem_id)
    _ensure_manager(user, problem)
    return {"test_cases": q_query(
        "SELECT id,input,expected_output,is_sample,score,sort_order,description FROM code_test_cases WHERE problem_id=? ORDER BY sort_order, id",
        (problem_id,),
    )}


@router.post("/code/problems/{problem_id}/regrade", summary="[教师] 重新判分")
async def regrade_problem(problem_id: int, request: Request):
    user = get_current_user(request)
    problem = _load_problem(problem_id)
    _ensure_manager(user, problem)
    subs = q_query(
        "SELECT id, student_username FROM code_submissions WHERE problem_id=? AND is_best=1",
        (problem_id,),
    )
    if not subs:
        return {"status": "ok", "count": 0, "message": "暂无需要重判的提交"}
    q_update("UPDATE code_submissions SET status='pending', passed_cases=0, score=0 WHERE problem_id=? AND is_best=1", (problem_id,))
    for s in subs:
        _spawn_grade(s["id"], s["student_username"], problem_id)
    logger.info(f"教师 {user['username']} 触发代码题 #{problem_id} 重判，共 {len(subs)} 份")
    return {"status": "ok", "count": len(subs), "message": f"已提交 {len(subs)} 份重新判分"}


class ValidateSolutionRequest(BaseModel):
    source_code: str = Field(default="", max_length=MAX_CODE_LENGTH)
    language: Optional[str] = None


class ValidateDraftRequest(BaseModel):
    language: str = "python"
    time_limit: int = 5
    source_code: str = Field(default="", max_length=MAX_CODE_LENGTH)
    test_cases: list[CodeTestCasePayload] = Field(default_factory=list)


def _short(text: str, limit: int = 4000) -> str:
    text = text or ""
    return text if len(text) <= limit else text[:limit] + f"\n…（仅显示前 {limit} 字符）"


async def _run_validation(
    source_code: str,
    language: str,
    timeout: float,
    cases: list[dict[str, Any]],
) -> dict[str, Any]:
    """跑一组用例做自测，不写任何表。create / edit 两个入口共用。"""
    runner = {"python": run_python, "javascript": run_javascript}.get(language)
    if not runner:
        raise HTTPException(status_code=400, detail=f"不支持的语言: {language}")

    sem = asyncio.Semaphore(3)

    def _norm(value: str) -> str:
        return (value or "").rstrip().replace("\r\n", "\n").replace("\r", "\n")

    async def _one(index: int, case: dict[str, Any]) -> dict[str, Any]:
        async with sem:
            result = await runner(
                source_code, case.get("input") or "",
                timeout=timeout, max_output_chars=GRADE_OUTPUT_CHARS,
            )
        actual = result.get("stdout") or ""
        expected = case.get("expected_output") or ""
        error = "" if not result.get("error_kind") else str(result.get("error") or result.get("stderr") or "")
        is_pass = not error and _norm(actual) == _norm(expected)
        return {
            "case_id": case.get("id"),
            "case_index": index,
            "description": case.get("description") or "",
            "is_sample": bool(case.get("is_sample")),
            "score": float(case.get("score") or 0),
            "input": _short(case.get("input") or ""),
            "expected": _short(expected),
            "actual": _short(actual),
            "is_pass": is_pass,
            "error": error[:2000],
            "execution_time": float(result.get("execution_time") or 0),
        }

    details = await asyncio.gather(*[_one(i, c) for i, c in enumerate(cases)])
    passed = sum(1 for d in details if d["is_pass"])
    return {
        "passed": passed,
        "total": len(details),
        "all_pass": passed == len(details),
        "max_score": round(sum(float(c.get("score") or 0) for c in cases), 2),
        "details": details,
    }


@router.post("/code/validate", summary="[教师] 用一段代码自测当前用例（不落库）")
async def validate_draft(req: ValidateDraftRequest, request: Request):
    """创建/编辑弹窗共用：用例还没保存也能先验证参考解。"""
    user = get_current_user(request)
    if not _is_manager(user):
        raise HTTPException(status_code=403, detail="权限不足")
    _rate_check("run", user["username"])
    if not req.source_code.strip():
        raise HTTPException(status_code=400, detail="参考解不能为空")
    _validate_cases(req.test_cases)
    try:
        timeout = max(0.5, min(60.0, float(req.time_limit or 5)))
    except (TypeError, ValueError):
        timeout = 5.0
    cases = [{
        "id": i + 1,
        "input": c.input or "",
        "expected_output": c.expected_output or "",
        "description": c.description or "",
        "score": c.score,
        "is_sample": c.is_sample,
    } for i, c in enumerate(req.test_cases)]
    return await _run_validation(req.source_code, req.language, timeout, cases)


@router.post("/code/problems/{problem_id}/validate", summary="[教师] 用参考解自测测试用例")
async def validate_solution(problem_id: int, req: ValidateSolutionRequest, request: Request):
    """兼容入口：按已保存的测试用例验证参考解。"""
    user = get_current_user(request)
    problem = _load_problem(problem_id)
    _ensure_manager(user, problem)
    _rate_check("run", user["username"])
    if not req.source_code.strip():
        raise HTTPException(status_code=400, detail="参考解不能为空")

    language = req.language or problem.get("language") or "python"
    cases = q_query(
        """SELECT id, input, expected_output, description, score, is_sample
           FROM code_test_cases WHERE problem_id=? ORDER BY sort_order, id""",
        (problem_id,),
    )
    if not cases:
        raise HTTPException(status_code=400, detail="该题目还没有测试用例")
    try:
        timeout = max(0.5, min(60.0, float(problem.get("time_limit") or 10)))
    except (TypeError, ValueError):
        timeout = 10.0
    return await _run_validation(req.source_code, language, timeout, cases)


@router.get("/code/teachers/statistics", summary="[教师] 代码题统计数据")
async def get_code_teacher_statistics(request: Request):
    user = get_current_user(request)
    role = _role(user)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")
    username = user["username"]
    where = "cp.creator_username=? AND cp.status IN ('active','paused')" if role == 1 else "cp.status IN ('active','paused')"
    params = [username] if role == 1 else []
    problems = q_query(
        f"SELECT cp.id as problem_id,cp.title,cp.subject,cp.status FROM code_problems cp WHERE {where} ORDER BY cp.id DESC",
        tuple(params),
    )
    if problems:
        ids = [p["problem_id"] for p in problems]
        ph = ",".join("?" for _ in ids)
        stats = {
            int(s["problem_id"]): s for s in q_query(
                f"""SELECT problem_id, COUNT(*) AS total_submissions,
                           COUNT(DISTINCT student_username) AS total_students,
                           SUM(CASE WHEN is_best=1 AND status='accepted' THEN 1 ELSE 0 END) AS accepted_students
                    FROM code_submissions WHERE problem_id IN ({ph}) GROUP BY problem_id""",
                tuple(ids),
            )
        }
        for p in problems:
            s = stats.get(int(p["problem_id"])) or {}
            p.update({
                "total_submissions": int(s.get("total_submissions") or 0),
                "total_students": int(s.get("total_students") or 0),
                "accepted_students": int(s.get("accepted_students") or 0),
            })
            p["pass_rate"] = round(
                (p["accepted_students"] / p["total_students"] * 100) if p["total_students"] else 0, 1
            )
    return {"problems": problems, "total": len(problems)}


@router.get("/code/problems/{problem_id}/submissions/detail", summary="[教师] 查看提交详情")
async def get_problem_submission_detail(problem_id: int, request: Request):
    user = get_current_user(request)
    problem = _load_problem(problem_id)
    _ensure_manager(user, problem)

    subs = q_query(
        """SELECT cs.id,cs.student_username,cs.status,cs.score,cs.max_score,cs.passed_cases,
                  cs.total_cases,cs.execution_time,cs.source_code,cs.ai_review_status,cs.created_at
           FROM code_submissions cs
           WHERE cs.problem_id=? AND cs.is_best=1
           ORDER BY cs.score DESC,cs.created_at DESC""",
        (problem_id,),
    )
    attach_student_info(subs, key="student_username", prefix="student_", overwrite=True)
    for s in subs:
        s["student_class"] = s.get("student_class_name") or s.get("student_class") or ""
        if not s.get("max_score"):
            s["max_score"] = _problem_max_score(problem_id)

    # 目标学生名册（用于「谁没交」与通过率；定向名单优先）
    roster_raw = get_students_by_scope(
        problem.get("creator_username") or user["username"],
        problem.get("target_scope") or "teacher_classes",
        problem.get("target_grade") or "",
        problem.get("target_class") or "",
        problem.get("target_users") or "",
    )
    sub_map = {s["student_username"]: s for s in subs}
    roster = []
    for st in roster_raw:
        uname = st.get("username")
        if not uname:
            continue
        s = sub_map.get(uname)
        roster.append({
            "username": uname,
            "name": st.get("name") or uname,
            "grade": st.get("grade") or "",
            "class": st.get("class") or "",
            "submitted": bool(s),
            "status": (s or {}).get("status"),
            "score": (s or {}).get("score"),
            "max_score": (s or {}).get("max_score"),
            "passed_cases": (s or {}).get("passed_cases"),
            "total_cases": (s or {}).get("total_cases"),
            "submitted_at": (s or {}).get("created_at"),
        })
    # 班级列可能是裸数字（"1"），补成 "高一1班" 这类可读名
    attach_student_info(roster, key="username", prefix="", overwrite=False)
    for r in roster:
        r["class"] = r.get("class_name") or r.get("class") or ""
    roster.sort(key=lambda x: (bool(x["submitted"]), str(x["class"]), str(x["name"])))

    target_count = len(roster)
    submitted_count = sum(1 for r in roster if r["submitted"])
    accepted_count = sum(1 for r in roster if r["status"] == "accepted")
    # 只统计能换算的提交：max_score=0 是判题失败留下的老数据，算进去会把均分拉低
    scores = [float(r["score"] or 0) for r in roster
              if r["submitted"] and float(r.get("max_score") or 0) > 0]
    # 满分按用例分之和算（不是固定 100）：教师给每个用例设分，题与题之间满分可能不同
    max_rows = q_query(
        "SELECT COALESCE(SUM(score), 0) AS s FROM code_test_cases WHERE problem_id = ?",
        (problem_id,))
    max_total = round(float((max_rows[0] or {}).get("s") or 0), 2) if max_rows else 0.0
    avg_raw = round(sum(scores) / len(scores), 2) if scores else 0.0
    summary = {
        "target_count": target_count,
        "submitted_count": submitted_count,
        "accepted_count": accepted_count,
        "pass_rate": round(accepted_count / submitted_count * 100, 1) if submitted_count else 0,
        # 原始分：满分跟着用例走，单独看没法跨题比较
        "avg_score": round(avg_raw, 1),
        "max_score": max_total,
        # 百分制：主展示用，与通过率同口径；max=0（老数据）时为 None，前端显示"—"
        "avg_percent": round(avg_raw / max_total * 100, 1) if (scores and max_total > 0) else None,
    }

    # 逐用例通过率（只统计每人的最佳提交）
    case_stats: list[dict[str, Any]] = []
    if subs:
        sub_ids = [s["id"] for s in subs]
        ph = ",".join("?" for _ in sub_ids)
        case_meta = {
            int(c["id"]): c for c in q_query(
                "SELECT id, description, score, is_sample, sort_order FROM code_test_cases WHERE problem_id=? ORDER BY sort_order, id",
                (problem_id,),
            )
        }
        for row in q_query(
            f"""SELECT case_id, COUNT(*) AS judged,
                       SUM(CASE WHEN is_pass=1 THEN 1 ELSE 0 END) AS passed
                FROM code_submission_cases WHERE submission_id IN ({ph}) GROUP BY case_id""",
            tuple(sub_ids),
        ):
            cid = int(row["case_id"] or 0)
            # 用例被整组替换后，旧提交里的 case_id 已不属于当前题目，统计时忽略
            if cid not in case_meta:
                continue
            meta = case_meta.get(cid) or {}
            judged = int(row["judged"] or 0)
            passed = int(row["passed"] or 0)
            case_stats.append({
                "case_id": cid,
                "description": meta.get("description") or "",
                "score": meta.get("score") or 0,
                "is_sample": bool(meta.get("is_sample")),
                "judged": judged,
                "passed": passed,
                "pass_rate": round(passed / judged * 100, 1) if judged else 0,
            })
        case_stats.sort(key=lambda x: int(x["case_id"] or 0))

    return {
        "title": problem["title"],
        "submissions": subs,
        "roster": roster,
        "summary": summary,
        "case_stats": case_stats,
        "total": len(subs),
    }


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
    if not _is_manager(user):
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
              "\n至少5个测试用例，前2个is_sample=true，总分10。"
              "reference_solution 必须是能通过全部测试用例的完整代码。")

    async def _do() -> dict[str, Any]:
        try:
            rt = await call_ai_async(prompt, api_key, json_mode=True, use_kb=False)
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
    if not _is_manager(get_current_user(request)):
        raise HTTPException(status_code=403, detail="权限不足")
    return await create_code_problem(req, request)
