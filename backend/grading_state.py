"""答卷「是否仍需批改」的统一判定。

背景：本系统 exam_attempts.status 只有 in_progress / submitted / grading / expired，
交卷后一直停在 'submitted'（并不会写成 'graded'），全站也都按 status IN ('submitted','graded')
当作「已交卷」。所以拿 status='submitted' 当「待批改」，会把早就判完的卷子永远算进待办，
数字只涨不降。真正还需要机器或人再动的只有：
  1) ai_pending > 0                       主观题还在后台批改队列里
  2) grading_details 里 needs_review / grading='pending'，且教师尚未复核
首页待办与考试中心列表必须共用这一份定义，否则两边永远对不上。
"""
import json
from typing import Any

from backend.logger import logger


def attempt_needs_grading(ai_pending: Any, teacher_reviewed: Any, grading_details: Any) -> bool:
    """单份答卷是否仍需批改"""
    try:
        if int(ai_pending or 0) > 0:
            return True
    except (TypeError, ValueError):
        pass
    try:
        if int(teacher_reviewed or 0):
            return False
    except (TypeError, ValueError):
        pass
    raw = str(grading_details or '').strip()
    if not raw:
        return False
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return False
    if not isinstance(data, dict):
        return False
    for val in data.values():
        if not isinstance(val, dict):
            continue
        if val.get('needs_review') or str(val.get('grading') or '').lower() == 'pending':
            return True
    return False


def pending_grading_by_exam(join: str = '', where: str = '', params: tuple = ()):
    """返回 (exam_id -> 待批改份数, 待批改总份数)。题库不可用时返回空结果而不是抛错。"""
    from backend.question_db import execute_query

    sql = (
        'SELECT ea.id, ea.exam_id, ea.ai_pending, ea.teacher_reviewed, ea.grading_details '
        f'FROM exam_attempts ea {join} WHERE ea.status=\'submitted\' {where}'
    )
    try:
        rows = execute_query(sql, tuple(params)) or []
    except Exception as e:
        logger.warning(f'[grading_state] 读取待批改答卷失败，按 0 处理: {e}')
        return {}, 0

    counts: dict[int, int] = {}
    total = 0
    for r in rows:
        try:
            if not attempt_needs_grading(r.get('ai_pending'), r.get('teacher_reviewed'), r.get('grading_details')):
                continue
            eid = int(r.get('exam_id') or 0)
        except (AttributeError, TypeError, ValueError):
            continue
        counts[eid] = counts.get(eid, 0) + 1
        total += 1
    return counts, total
