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


def _iter_entries(graded: Any):
    if not isinstance(graded, dict):
        return
    for k, v in graded.items():
        if isinstance(v, dict):
            yield str(k), v


def count_needs_review(graded: Any) -> int:
    """题集里仍待教师确认的题数（needs_review 标记，或题态 review/pending）。可接 dict 或 JSON 串。"""
    if isinstance(graded, str):
        try:
            graded = json.loads(graded)
        except (ValueError, TypeError):
            return 0
    return sum(1 for _k, v in _iter_entries(graded)
               if v.get('needs_review') or str(v.get('grading') or '').lower() in ('review', 'pending'))


def review_suffix(graded: Any) -> str:
    """成绩通知的"待确认"标注（拍板：先发+标注，不压通知）。无待确认题返回空串。"""
    n = count_needs_review(graded)
    return f"，其中 {n} 道主观题待教师确认（复核后成绩会更新）" if n else ""


def diff_bookkeeping(before: Any, after: Any) -> tuple[dict, dict]:
    """教师复核前后的逐题判定对照 → (改对的题, 改错的题)。

    只返回判定翻转的条目，未变的不进回写；仍待复核(needs_review/review)的题不算定稿，
    不回写错题本。错题本/积分侧函数自身幂等，重复调用安全。
    """
    if isinstance(before, str):
        try:
            before = json.loads(before)
        except (ValueError, TypeError):
            before = {}
    if isinstance(after, str):
        try:
            after = json.loads(after)
        except (ValueError, TypeError):
            after = {}
    newly_correct: dict = {}
    newly_wrong: dict = {}
    before = before if isinstance(before, dict) else {}
    for k, v in _iter_entries(after):
        if v.get('needs_review') or str(v.get('grading') or '').lower() in ('review', 'pending'):
            continue
        prev = before.get(k) if isinstance(before.get(k), dict) else None
        was = bool(prev.get('is_correct')) if prev else False
        now = bool(v.get('is_correct'))
        # R2: 复核前的 needs_review/review/pending 是未定稿占位(0 分 + is_correct=False,
        # 结算时被 B4 过滤跳过)。教师终判为错时前后都是 False —— 只按翻转比对会漏记。
        unconfirmed = bool(prev is not None and (
            prev.get('needs_review')
            or str(prev.get('grading') or '').lower() in ('review', 'pending')))
        if now and not was:
            newly_correct[k] = v
        elif (not now) and (was or unconfirmed):
            newly_wrong[k] = v
    return newly_correct, newly_wrong


def _blob_needs_review(raw: Any) -> bool:
    """批改留痕 JSON 串里是否仍有待人工/在途题（needs_review / review / pending）。"""
    try:
        data = json.loads(str(raw or "{}"))
    except (ValueError, TypeError):
        return False
    if not isinstance(data, dict):
        return False
    for val in data.values():
        if not isinstance(val, dict):
            continue
        if val.get('needs_review') or str(val.get('grading') or '').lower() in ('review', 'pending'):
            return True
    return False


def pending_extra_grading(username: str = "", is_admin: bool = False) -> tuple[int, int]:
    """(同步练习, 随堂测验) 仍需批改的答卷份数 —— 与考试共用 grading_state 口径。

    练习在题库库(practice_*), 测验在主库(interaction_*), 分库分连接;
    非管理员只看自己创建的场次, 与考试侧同一收口逻辑。LIKE 只做粗筛,
    命中后再解析 JSON 精确判定, 避免把"复核完已清标记"的卷子重复算进待办。
    """
    from backend.question_db import execute_query as qb_execute
    n_practice = 0
    try:
        if is_admin or not username:
            rows = qb_execute(
                """SELECT answers, ai_pending FROM practice_attempts
                   WHERE status='submitted'
                     AND (ai_pending=1 OR answers LIKE '%needs_review%' OR answers LIKE '%pending%')
                   LIMIT 2000""") or []
        else:
            rows = qb_execute(
                """SELECT pa.answers, pa.ai_pending FROM practice_attempts pa
                   JOIN practice_sessions ps ON ps.id = pa.session_id
                   WHERE pa.status='submitted' AND ps.creator_username=?
                     AND (pa.ai_pending=1 OR pa.answers LIKE '%needs_review%' OR pa.answers LIKE '%pending%')
                   LIMIT 2000""", (username,)) or []
        for r in rows:
            if int(r.get("ai_pending") or 0) > 0 or _blob_needs_review(r.get("answers")):
                n_practice += 1
    except Exception as e:
        logger.warning(f'[grading_state] 练习待批改统计失败，按 0 处理: {e}')

    n_quiz = 0
    try:
        from backend.database import execute_query as main_execute
        if is_admin or not username:
            rows = main_execute(
                """SELECT graded, ai_pending FROM interaction_quiz_answers
                   WHERE (ai_pending=1 OR graded LIKE '%needs_review%' OR graded LIKE '%pending%')
                   LIMIT 2000""") or []
        else:
            rows = main_execute(
                """SELECT qa.graded, qa.ai_pending FROM interaction_quiz_answers qa
                   JOIN interaction_quizzes iq ON iq.id = qa.quiz_id
                   WHERE iq.creator_username=?
                     AND (qa.ai_pending=1 OR qa.graded LIKE '%needs_review%' OR qa.graded LIKE '%pending%')
                   LIMIT 2000""", (username,)) or []
        for r in rows:
            if int(r[1] or 0) > 0 or _blob_needs_review(r[0]):
                n_quiz += 1
    except Exception as e:
        logger.warning(f'[grading_state] 测验待批改统计失败，按 0 处理: {e}')
    return n_practice, n_quiz


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
