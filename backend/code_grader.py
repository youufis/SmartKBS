"""
代码自动评分引擎
流程：获取提交记录 → 读取测试用例 → 逐用例执行 → 比较输出 → 计算得分
"""
import json
from typing import Any, Optional

from backend.logger import logger
from backend.question_db import execute_query as q_query, execute_update as q_update
from backend.code_runner import run_python, run_javascript, MAX_EXECUTION_TIME


def _normalize_output(text: str) -> str:
    """标准化输出：去除末尾空白、统一换行符

    不同平台的换行符差异会影响字符串比较，统一处理后再比较。
    """
    return text.rstrip().replace('\r\n', '\n').replace('\r', '\n')


async def grade_submission(submission_id: int) -> dict[str, Any]:
    """对代码提交进行自动评分

    流程:
    1. 从 code_submissions 读取提交记录
    2. 从 code_test_cases 读取该题的所有测试用例
    3. 逐用例执行学生代码并比较输出
    4. 计算总得分
    5. 更新 submission 记录

    Args:
        submission_id: 提交记录 ID

    Returns:
        {
            "status": "accepted" | "wrong_answer" | "runtime_error" | "time_limit",
            "score": float,
            "passed": int,
            "total": int,
            "execution_time": float,
            "details": [
                {
                    "case_id": int,
                    "is_sample": bool,
                    "input": str,
                    "expected": str,
                    "actual": str,
                    "execution_time": float,
                    "is_pass": bool,
                    "error": str,
                    "score": float,
                }
            ]
        }
    """
    # 1. 读取提交记录
    sub_rows = q_query(
        "SELECT problem_id, language, source_code FROM code_submissions WHERE id=?",
        (submission_id,),
    )
    if not sub_rows:
        return {"status": "error", "error": "提交记录不存在"}

    problem_id = sub_rows[0]["problem_id"]
    language = sub_rows[0]["language"]
    source_code = sub_rows[0]["source_code"]

    # 2. 读取测试用例
    cases = q_query(
        """SELECT id, input, expected_output, score, is_sample
           FROM code_test_cases
           WHERE problem_id=?
           ORDER BY sort_order""",
        (problem_id,),
    )
    if not cases:
        return {"status": "error", "error": "该题目没有配置测试用例"}

    total_cases = len(cases)
    passed = 0
    total_score = 0.0
    max_score = sum(c["score"] for c in cases)
    details = []
    max_exec_time = 0.0

    # 3. 选择运行器
    if language == "python":
        runner = run_python
    elif language == "javascript":
        runner = run_javascript
    else:
        return {"status": "error", "error": f"不支持的语言: {language}"}

    # 4. 逐用例执行
    for case in cases:
        case_id = case["id"]
        input_data = case["input"] or ""
        expected = case["expected_output"]
        case_score = case["score"]
        is_sample = bool(case["is_sample"])

        result = await runner(source_code, input_data)
        exec_time = result.get("execution_time", 0)
        max_exec_time = max(max_exec_time, exec_time)

        is_pass = False
        error_msg = ""

        if result.get("error"):
            # 运行时错误或超时
            error_msg = result.get("stderr") or result.get("error", "")
        else:
            actual = _normalize_output(result.get("stdout", ""))
            expected_norm = _normalize_output(expected)
            is_pass = (actual == expected_norm)

        if is_pass:
            passed += 1
            total_score += case_score

        details.append({
            "case_id": case_id,
            "is_sample": is_sample,
            "input": input_data,
            "expected": expected,
            "actual": result.get("stdout", ""),
            "execution_time": exec_time,
            "is_pass": is_pass,
            "error": error_msg,
            "score": case_score if is_pass else 0,
        })

    # 5. 计算结果
    final_score = round(total_score, 1)

    if max_exec_time >= MAX_EXECUTION_TIME:
        final_status = "time_limit"
    elif passed == total_cases:
        final_status = "accepted"
    elif passed > 0:
        final_status = "wrong_answer"
    else:
        final_status = "runtime_error"

    # 6. 更新提交记录
    q_update(
        """UPDATE code_submissions
           SET status=?, passed_cases=?, total_cases=?, score=?,
               execution_time=?, error_message=?
           WHERE id=?""",
        (final_status, passed, total_cases, final_score,
         max_exec_time, json.dumps(details, ensure_ascii=False)[:5000],
         submission_id),
    )

    logger.info(
        f"代码评分完成: submission #{submission_id}, "
        f"passed={passed}/{total_cases}, score={final_score}, status={final_status}"
    )

    return {
        "status": final_status,
        "score": final_score,
        "passed": passed,
        "total": total_cases,
        "max_score": max_score,
        "execution_time": max_exec_time,
        "details": details,
    }
