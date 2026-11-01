"""
代码自动评分引擎

流程：读取提交 → 读取测试用例 → 并发逐用例执行 → 比较输出 → 写明细与总分

2026-11 重构要点：
1. 用例并发执行（每份提交最多 3 个并发），总耗时不再随用例数线性膨胀。
2. 逐用例超时取题目的 time_limit，不再一律 10 秒。
3. 明细写独立表 code_submission_cases，长输出不再把 JSON 截断成不可解析。
4. 语法错误归为 compile_error，超时归为 time_limit，安全拦截/异常归为 runtime_error。
5. 记录 max_score；用例改分后重判不会把「8/10」显示成「8/5」。
"""
import asyncio
from datetime import datetime
from typing import Any

from backend.logger import logger
from backend.question_db import (
    execute_query as q_query,
    execute_update as q_update,
    execute_query_one as q_one,
    get_connection,
)
from backend.code_runner import (
    run_python,
    run_javascript,
    MAX_EXECUTION_TIME,
    GRADE_OUTPUT_CHARS,
)

# 一份提交内部最多同时跑几个用例（全局还有 code_runner 的进程闸）
CASE_CONCURRENCY = 3

# 明细里每条文本最多存多少字符（避免一个 200KB 输出 × 30 用例把库撑爆）
DETAIL_TEXT_LIMIT = 4000

_CASE_SELECT = """SELECT id, input, expected_output, description, score, is_sample
                  FROM code_test_cases
                  WHERE problem_id=?
                  ORDER BY sort_order, id"""


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _normalize_output(text: str) -> str:
    """标准化输出：去除末尾空白、统一换行符。"""
    return (text or "").rstrip().replace('\r\n', '\n').replace('\r', '\n')


def _clip(text: str, limit: int = DETAIL_TEXT_LIMIT) -> str:
    text = text or ""
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n…（仅显示前 {limit} 字符，完整内容已截断）"


async def _run_case(
    runner,
    source_code: str,
    case: dict[str, Any],
    index: int,
    timeout: float,
) -> dict[str, Any]:
    input_data = case.get("input") or ""
    expected = case.get("expected_output") or ""
    case_score = float(case.get("score") or 0)
    is_sample = bool(case.get("is_sample"))

    result = await runner(
        source_code,
        input_data,
        timeout=timeout,
        max_output_chars=GRADE_OUTPUT_CHARS,
    )
    exec_time = float(result.get("execution_time") or 0)
    error_kind = result.get("error_kind") or ""
    stdout = result.get("stdout") or ""
    if result.get("stdout_truncated") and not error_kind:
        error_kind = "runtime"
        result["error"] = f"输出超过 {GRADE_OUTPUT_CHARS} 字符上限，请检查是否有过量打印"

    is_pass = False
    error_msg = ""
    if error_kind:
        error_msg = str(result.get("error") or result.get("stderr") or "")[:2000]
    else:
        is_pass = _normalize_output(stdout) == _normalize_output(expected)

    return {
        "case_id": case.get("id"),
        "case_index": index,
        "description": case.get("description") or "",
        "is_sample": is_sample,
        "input": _clip(input_data),
        "expected": _clip(expected),
        "actual": _clip(stdout),
        "is_pass": is_pass,
        "score": case_score if is_pass else 0,
        "execution_time": exec_time,
        "error": error_msg,
        "error_kind": error_kind,
    }


def _decide_status(details: list[dict[str, Any]], passed: int, total: int) -> str:
    if total and passed == total:
        return "accepted"
    kinds = {d.get("error_kind") for d in details if d.get("error_kind")}
    if "compile" in kinds:
        return "compile_error"
    if "timeout" in kinds:
        return "time_limit"
    if "security" in kinds or "runtime" in kinds or "busy" in kinds:
        return "runtime_error"
    return "wrong_answer"


async def grade_submission(submission_id: int) -> dict[str, Any]:
    """对代码提交进行自动评分。返回结构化结果，供调用方发放积分/刷新列表。"""
    sub = q_one(
        "SELECT problem_id, language, source_code, student_username FROM code_submissions WHERE id=?",
        (submission_id,),
    )
    if not sub:
        return {"status": "error", "error": "提交记录不存在"}

    problem_id = sub["problem_id"]
    language = sub["language"]
    source_code = sub["source_code"]
    student_username = sub.get("student_username") or ""
    problem = q_one("SELECT time_limit FROM code_problems WHERE id=?", (problem_id,)) or {}
    try:
        timeout = float(problem.get("time_limit") or MAX_EXECUTION_TIME)
    except (TypeError, ValueError):
        timeout = float(MAX_EXECUTION_TIME)
    timeout = max(0.5, min(60.0, timeout))

    cases = q_query(_CASE_SELECT, (problem_id,))
    if not cases:
        _mark_failed(submission_id, "该题目没有配置测试用例", 0)
        return {"status": "error", "error": "该题目没有配置测试用例"}

    total_cases = len(cases)
    max_score = round(sum(float(c.get("score") or 0) for c in cases), 2)

    if language == "python":
        runner = run_python
    elif language == "javascript":
        runner = run_javascript
    else:
        _mark_failed(submission_id, f"不支持的语言: {language}", max_score)
        return {"status": "error", "error": f"不支持的语言: {language}"}

    semaphore = asyncio.Semaphore(CASE_CONCURRENCY)

    async def _guarded(index: int, case: dict[str, Any]) -> dict[str, Any]:
        async with semaphore:
            return await _run_case(runner, source_code, case, index, timeout)

    details = await asyncio.gather(*[
        _guarded(i, case) for i, case in enumerate(cases)
    ])

    passed = sum(1 for d in details if d["is_pass"])
    total_score = round(sum(float(d["score"]) for d in details), 2)
    max_exec_time = max((float(d["execution_time"] or 0) for d in details), default=0.0)
    status = _decide_status(details, passed, total_cases)

    # 失败摘要：只存一句人话，不再把整段 JSON 塞进 error_message
    first_error = next((d["error"] for d in details if d["error"]), "")
    error_summary = first_error[:1000]

    created_at = _now()
    try:
        with get_connection() as conn:
            c = conn.cursor()
            c.execute("DELETE FROM code_submission_cases WHERE submission_id=?", (submission_id,))
            c.executemany(
                """INSERT INTO code_submission_cases
                   (submission_id, student_username, case_id, case_index, description, is_sample,
                    input, expected, actual, is_pass, score, execution_time, error, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                [
                    (
                        submission_id, student_username, d["case_id"], d["case_index"], d["description"],
                        1 if d["is_sample"] else 0, d["input"], d["expected"], d["actual"],
                        1 if d["is_pass"] else 0, d["score"], d["execution_time"],
                        d["error"], created_at,
                    )
                    for d in details
                ],
            )
            c.execute(
                """UPDATE code_submissions
                   SET status=?, passed_cases=?, total_cases=?, score=?, max_score=?,
                       execution_time=?, error_message=?, ai_review_status='pending',
                       ai_review='', ai_review_error=''
                   WHERE id=?""",
                (status, passed, total_cases, total_score, max_score,
                 max_exec_time, error_summary, submission_id),
            )
            conn.commit()
    except Exception as e:
        logger.error(f"判题结果落库失败: #{submission_id}: {e}")
        _mark_failed(submission_id, f"判题结果保存失败: {e}", max_score)
        return {"status": "error", "error": str(e)}

    logger.info(
        f"代码评分完成: submission #{submission_id}, "
        f"passed={passed}/{total_cases}, score={total_score}/{max_score}, status={status}"
    )

    return {
        "status": status,
        "score": total_score,
        "passed": passed,
        "total": total_cases,
        "max_score": max_score,
        "execution_time": max_exec_time,
        "details": details,
    }


def _mark_failed(submission_id: int, message: str, max_score: float = 0) -> None:
    q_update(
        """UPDATE code_submissions
           SET status='failed', error_message=?, max_score=? WHERE id=?""",
        (message[:1000], max_score, submission_id),
    )


def recover_stale_submissions() -> int:
    """服务启动时把上次进程中断遗留的 pending/running 提交标记为失败。

    判题任务只活在本进程里，进程重启后它们不可能再完成；不清理会让前端
    一直轮询到一个永远不变的「评分中」。
    """
    rows = q_query(
        "SELECT id FROM code_submissions WHERE status IN ('pending','running')"
    )
    if not rows:
        return 0
    fixed = 0
    for row in rows:
        # 判题任务只活在本进程；启动时还挂着的 pending 不可能再完成
        q_update(
            """UPDATE code_submissions
               SET status='failed',
                   error_message='服务重启导致判题中断，请重新提交'
               WHERE id=?""",
            (row["id"],),
        )
        fixed += 1
    # AI 审查任务同样只活在本进程，重启后把「进行中」标记失败，前端才不会一直等
    q_update(
        """UPDATE code_submissions
           SET ai_review_status='failed',
               ai_review_error='服务重启导致 AI 审查中断，请重新发起'
           WHERE ai_review_status='running'""",
        (),
    )
    if fixed:
        logger.info(f"[代码练习] 启动回收 {fixed} 条中断的判题任务")
    return fixed
