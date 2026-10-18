"""
AI 智能学情分析 API 路由
利用 DashScope AI 对学习数据进行分析，生成自然语言学情报告
"""
import json
import os
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Query

from backend.api.dependencies import get_current_user
from backend.database import execute_query
from backend.question_db import execute_query as q_execute_query
from backend.logger import logger
from backend.permission_service import can_access_grade, can_access_class, get_grade_by_name
from backend.prompts import apply_skills
from backend.prompts.analytics import CLASS_ANALYSIS_PROMPT, STUDENT_ANALYSIS_PROMPT, TEACHING_ADVICE_PROMPT
from backend.prompts.exam import EXAM_ANALYSIS_PROMPT
from backend.prompts import build_ai_role
# E1: 考试判分/统计的唯一实现（成绩弹窗 / 本页 / Excel 导出共用）
from backend.exam_stats import (
    exam_graded,
    question_stats as exam_question_stats,
    score_stats as exam_score_stats,
)

# ── 辅助：将 TEXT 年级/班级名解析为 ID ──
def _resolve_grade_id(grade_name: str) -> int | None:
    """将 '高一' 解析为 grades.id"""
    if not grade_name:
        return None
    r = execute_query("SELECT id FROM grades WHERE name=?", (grade_name,))
    return r[0][0] if r else None

def _resolve_class_id(grade_name: str, cls_name: str) -> int | None:
    """将 ('高一', '高一1班') 或 ('高一', '1') 解析为 classes.id"""
    gid = _resolve_grade_id(grade_name)
    if not gid or not cls_name:
        return None
    import re
    nums = re.findall(r'\d+', cls_name)
    cls_num = nums[0] if nums else cls_name
    r = execute_query(
        "SELECT id FROM classes WHERE grade_id=? AND (name=? OR name=?)",
        (gid, f"{cls_num}班", cls_num),
    )
    return r[0][0] if r else None

router = APIRouter()


def _get_dashscope_api_key() -> str:
    """获取 DashScope API Key（使用统一缓存入口）"""
    from backend.api.chat_router import get_api_keys
    key, _ = get_api_keys("")
    return key


def _call_ai(prompt: str) -> str:  # type: ignore[misc]
    """调用 AI 分析（同步，保留兼容）"""
    api_key = _get_dashscope_api_key()
    if not api_key:
        return "⚠️ AI 分析功能不可用：请管理员在「系统配置」中填写 DashScope API Key"

    prompt = apply_skills(prompt, "analytics")

    from backend.api.ai_service import call_ai_sync
    try:
        return call_ai_sync(prompt, api_key, use_kb=False)
    except Exception as e:
        logger.error(f"AI 学情分析调用失败: {e}")
        return f"AI 分析出错：{str(e)}"


async def _call_ai_task(description: str, prompt: str, dedupe_key: str = "",
                        max_concurrent: int | None = None,
                        cache_kind: str = "", cache_scope: str = "",
                        created_by: str = "", cache_meta: dict | None = None) -> str:
    """提交 AI 分析后台任务，返回 task_id

    dedupe_key: 同一用户的同键任务在"进行中"或"刚完成 60s 内"直接复用既有 task_id,
    避免刷新页面/连点两下/前端重试重复调用模型计费。
    max_concurrent: 每用户进行中的任务上限, 超出抛 TooManyAITasks,
    由 main.py 的异常处理器统一转成 429(无需各端点自己 try/except)。
    """
    api_key = _get_dashscope_api_key()
    if not api_key:
        # 无 API Key 时直接返回错误信息（不创建任务）
        task_id = __import__('uuid').uuid4().hex[:12]
        from backend.ai_task_manager import task_manager, AITask, TaskStatus
        task = AITask(task_id, description)
        task.status = TaskStatus.FAILED
        task.error = "⚠️ AI 分析功能不可用：请管理员在「系统配置」中填写 DashScope API Key"
        task.completed_at = __import__('time').time()
        task_manager._tasks[task_id] = task  # type: ignore[attr-defined]
        return task_id

    from backend.api.ai_service import call_ai_async

    async def _do_analysis() -> dict[str, Any]:
        try:
            result = await call_ai_async(prompt, api_key, use_kb=False)
            report_id = None
            if cache_kind and cache_scope and result:
                from backend.ai_report_cache import save_report
                report_id = save_report(
                    cache_kind, cache_scope, result, created_by or "", meta=cache_meta,
                )
            return {"result": result, "report_id": report_id}
        except Exception as e:
            logger.error(f"AI 学情分析调用失败: {e}")
            return {"error": f"AI 分析出错：{str(e)}"}

    from backend.ai_task_manager import task_manager
    return await task_manager.create_task(description=description, coro_factory=_do_analysis,
                                          dedupe_key=dedupe_key, max_concurrent=max_concurrent)


def _safe_int(val) -> int:
    try:
        return int(val)
    except (TypeError, ValueError):
        return 0


def _safe_float(val) -> float:
    try:
        return float(val)
    except (TypeError, ValueError):
        return 0.0


def _extract_class_num(cls_val: str) -> str:
    """从 '高一1班' 格式中提取班级数字 '1'"""
    import re
    nums = re.findall(r'\d+', cls_val)
    return nums[0] if nums else cls_val


def _class_name_variants(grade: str, cls_val: str) -> list[str]:
    """R3: 班级名在各表里写法并不统一(点名册存 "高一1班", 积分表可能存 "1" 或 "1班"),
    统一生成候选集合, 避免"换一个入口就查不到数据"的口径不一致。
    年级由查询的另一个条件限定, 因此候选集不会跨年级误匹配。
    """
    import re as _re
    out: list[str] = []
    v = str(cls_val or "").strip()
    if not v:
        return out
    out.append(v)
    if grade and v.startswith(grade):
        out.append(v[len(grade):])
    nums = _re.findall(r"\d+", v)
    if nums:
        n = nums[0]
        out.extend([n, f"{n}班", f"{grade}{n}班"])
    seen, res = set(), []
    for x in out:
        x = (x or "").strip()
        if x and x not in seen:
            seen.add(x)
            res.append(x)
    return res


@router.get("/class-overview", summary="班级学情总览（AI 生成）")
async def class_overview(
    request: Request,
    grade: str = Query("", description="年级"),
    cls: str = Query("", description="班级"),
    teacher: str = Query("", description="教师用户名"),
    snapshot_only: bool = Query(False, description="只返回数据快照，不生成 AI 报告"),
):
    """AI 生成班级学情总览报告（统计口径由 analytics_service 统一）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看")

    query_teacher = teacher or username
    if role == 1 and teacher and teacher != username:
        raise HTTPException(status_code=403, detail="只能查看自己的班级学情")

    from backend.analytics_service import build_class_snapshot
    snapshot = build_class_snapshot(user, query_teacher, grade, cls)
    scope = snapshot["scope"]
    d = snapshot["data"]
    if d["total_students"] == 0:
        return {
            "task_id": None,
            "empty": True,
            "message": "该班级暂无学生数据",
            "data": d,
            "sources": [],
        }
    if snapshot_only:
        return {
            "task_id": None,
            "snapshot_only": True,
            "data": d,
            "sources": snapshot["sources"],
        }

    ai_role = build_ai_role(grade=grade)
    prompt = f"{ai_role}" + CLASS_ANALYSIS_PROMPT.format(
        grade=grade,
        cls=scope["class_num"],
        total_students=d["total_students"],
        score_count=d["score_count"],
        score_total=d["score_total"],
        score_avg=d["score_avg"],
        score_max=d["score_max"],
        score_min=d["score_min"],
        rollcall_total=d["rollcall_total"],
        rollcall_correct=d["rollcall_correct"],
        rollcall_wrong=d["rollcall_wrong"],
        exam_lines=snapshot["exam_lines"],
        active_tasks=d["active_tasks"],
        submitted_students=d["submitted_students"],
    )

    scope_key = f"co:{query_teacher}:{grade}:{cls}"
    task_id = await _call_ai_task(
        "班级学情分析", prompt,
        dedupe_key=scope_key,
        max_concurrent=4,
        cache_kind="class_overview",
        cache_scope=scope_key,
        created_by=username,
        cache_meta={**d, "class_display": scope["display_name"]},
    )

    return {
        "task_id": task_id,
        "message": "AI 分析已提交，请稍后查询结果",
        "data": d,
        "sources": snapshot["sources"],
    }


@router.get("/student/{target_username}", summary="学生个体 AI 学情分析")
async def student_analytics(target_username: str, request: Request):
    """AI 生成学生个体学情分析"""
    user = get_current_user(request)
    role = user.get("role", 2)

    if role == 2 and user["username"] != target_username:
        raise HTTPException(status_code=403, detail="无权查看")
    if role == 1:
        from backend.permission_service import is_student_in_teacher_scope
        if not is_student_in_teacher_scope(target_username, user["username"]):
            raise HTTPException(status_code=403, detail="该学生不在您的任教范围内")

    # 获取学生信息
    user_rows = execute_query(
        "SELECT name, grade, class FROM users WHERE username = ?",
        (target_username,),
    )
    if not user_rows:
        raise HTTPException(status_code=404, detail="学生不存在")
    student_name = user_rows[0][0] or target_username
    student_grade = user_rows[0][1] or ""
    student_class = user_rows[0][2] or ""

    # 考试成绩
    exam_results = q_execute_query(
        """SELECT e.title, e.subject, ea.score, ea.total_score, e.pass_score, ea.submitted_at
           FROM exam_attempts ea
           JOIN exams e ON ea.exam_id = e.id
           WHERE ea.student_username = ? AND ea.status IN ('submitted', 'graded')
           ORDER BY ea.submitted_at DESC""",
        (target_username,),
    )

    # 积分（同名可能跨班，按年级/班级候选名一起限定）
    from backend.analytics_service import class_name_variants
    variants = class_name_variants(student_grade, str(student_class or "")) or [str(student_class or "")]
    vph = ",".join("?" for _ in variants)
    score_rows = execute_query(
        f"SELECT COALESCE(SUM(score),0) FROM scores "
        f"WHERE student_name=? AND grade=? AND class_name IN ({vph})",
        (student_name, student_grade, *variants),
    )
    total_score = score_rows[0][0] if score_rows else 0

    # 点名
    rc_rows = execute_query(
        f"""SELECT COUNT(*), SUM(CASE WHEN result='correct' THEN 1 ELSE 0 END)
            FROM rollcall_history
            WHERE student_name=? AND grade=? AND class_name IN ({vph})
              AND result IN ('correct','incorrect')""",
        (student_name, student_grade, *variants),
    )
    rc_total = rc_rows[0][0] if rc_rows else 0
    rc_correct = rc_rows[0][1] if rc_rows else 0

    # 任务
    task_rows = execute_query(
        "SELECT COUNT(*) FROM task_submissions WHERE student_username = ?",
        (target_username,),
    )
    task_count = task_rows[0][0] if task_rows else 0

    # 对话
    chat_rows = execute_query(
        "SELECT COUNT(*) FROM conversations WHERE username = ?",
        (target_username,),
    )
    chat_count = chat_rows[0][0] if chat_rows else 0

    # 资源浏览
    rv_rows = execute_query(
        "SELECT COUNT(*) FROM resource_view_logs WHERE student_username = ?",
        (target_username,),
    )
    rv_count = rv_rows[0][0] if rv_rows else 0

    # 构建数据
    exam_text = ""
    for e in exam_results:
        exam_text += f"- 《{e['title']}》({e['subject']}): {e['score']}/{e['total_score']}分 ({'通过' if e['score'] >= e['pass_score'] else '未通过'})\n"

    ai_role = build_ai_role(grade=student_grade)
    prompt = f"""{ai_role}请根据以下学生数据，生成一份个性化的学情分析报告。

学生：{student_name}
班级：{student_grade}{student_class}

【考试成绩】
{exam_text if exam_text else '暂无考试记录'}

【课堂积分】累计 {total_score} 分
【点名情况】共被点名 {rc_total} 次，回答正确 {rc_correct} 次
【任务完成】已提交 {task_count} 个任务
【AI 对话】共 {chat_count} 次
【资源浏览】已浏览 {rv_count} 个学习资源

请生成（Markdown 格式）：
1. 📊 **学习概况**
2. 💪 **优势与进步**
3. 🔧 **改进建议**
4. 🎯 **下一阶段学习建议**

语气亲切、鼓励为主。"""

    task_id = await _call_ai_task("学生个体学情分析", prompt,
                                  dedupe_key=f"sa:{target_username}", max_concurrent=4)

    return {
        "task_id": task_id,
        "message": "AI 分析已提交，请稍后查询结果",
        "student": {"username": target_username, "name": student_name, "grade": student_grade, "class": student_class},
    }


@router.get("/exam/{exam_id}/report", summary="单次考试 AI 分析报告")
async def exam_analytics(exam_id: int, request: Request):
    """AI 生成单次考试的分析报告"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看")

    exam = q_execute_query("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")
    exam = exam[0]
    # E2c: 单次考试分析含全部学生成绩与逐题数据, 仅限创建者或管理员
    from backend.api.export_router import _assert_can_view_exam
    _assert_can_view_exam(user, dict(exam))

    # E1: 与成绩弹窗、Excel 导出统一口径 —— 不再自己筛 auto_graded=1（那会把"还没判完"的答卷整份排除，
    #     于是同一场考试在学情分析与成绩页的人数/平均分对不上）。
    attempts = q_execute_query(
        "SELECT * FROM exam_attempts WHERE exam_id = ? AND status IN ('submitted', 'graded') ORDER BY score DESC",
        (exam_id,),
    )

    questions = q_execute_query(
        """SELECT qb.id as qid, qb.type, qb.question_text, qb.correct_answer, qb.difficulty,
                  qb.knowledge_points, qb.options, eq.score as question_score
           FROM exam_questions eq
           JOIN question_bank qb ON eq.question_id = qb.id
           WHERE eq.exam_id = ?
           ORDER BY eq.sort_order""",
        (exam_id,),
    )

    # 每题正确率 + 班级统计：走 backend.exam_stats（分母只算已判分人数，批改中的卷子不进平均分）
    parsed = []
    for a in attempts:
        graded = exam_graded(a.get('answers'))
        ans_map = {str(k): v.get('student_answer', '') for k, v in graded.items() if isinstance(v, dict)}
        parsed.append((a.get('student_username', ''), ans_map, graded))

    q_stats = exam_question_stats(questions, parsed)
    stats = exam_score_stats(attempts, exam['total_score'], exam['pass_score'])
    stats['total_students'] = stats['submitted_count']      # 兼容前端既有字段名
    total_count = stats['graded_count']
    avg_score = stats['avg_score']
    max_score = stats['max_score']
    min_score = stats['min_score']
    pass_count = stats['pass_count']

    # 前端（学情分析页）沿用旧字段名：id / text / correct_rate / difficulty / knowledge_points
    q_accuracy = [{
        "id": int(q['qid']) if str(q['qid']).isdigit() else q['qid'],
        "type": q['type'],
        "text": str(q['question_text'] or '')[:80],
        "correct_rate": q['correct_rate'],
        "difficulty": q.get('difficulty', 'medium') or 'medium',
        "knowledge_points": q.get('knowledge_points', '') or '',
        # 新增：让页面能显示「已判 x/y」与本题批改中人数
        "correct_count": q['correct_count'],
        "total_count": q['total_count'],
        "pending_count": q['pending_count'],
    } for q in q_stats]

    # 找出最薄弱的知识点
    weak_points = [q for q in q_accuracy if q['correct_rate'] < 60]

    ai_role = build_ai_role(subject=exam['subject'], grade=exam.get('grade', ''))
    prompt = f"""{ai_role}请根据以下考试数据，生成专业的考试分析报告。

考试名称：{exam['title']}
科目：{exam['subject']}
参考人数：{stats['submitted_count']}（其中 {stats['pending_count']} 份仍在批改中，下列统计均不含）
平均分：{avg_score}/{exam['total_score']}（平均得分率 {stats['avg_rate']}%）
最高分：{max_score}
最低分：{min_score}
及格人数：{pass_count}/{total_count}（及格线{exam['pass_score']}分）

各题正确率（正确率 < 60% 的为薄弱题）：
{chr(10).join(f'- 第{i+1}题 ({q["type"]}, {q["difficulty"]}): 正确率{q["correct_rate"]}%' + (f' [知识点: {q["knowledge_points"]}]' if q['knowledge_points'] else '') for i, q in enumerate(q_accuracy))}

薄弱知识点：
{chr(10).join(('- ' + (q["knowledge_points"] or (f"第{q['id']}题"))) for q in weak_points) if weak_points else '无显著薄弱点'}

请生成（Markdown 格式）：
1. 📊 **总体情况**
2. 📈 **分数分布分析**
3. ⚠️ **薄弱知识点**
4. 💡 **教学改进建议"""

    scope_key = f"ea:{exam_id}"
    task_id = await _call_ai_task(
        "考试分析报告", prompt,
        dedupe_key=scope_key, max_concurrent=4,
        cache_kind="exam_report", cache_scope=scope_key,
        created_by=user["username"],
        cache_meta={"exam_title": exam["title"], "subject": exam["subject"]},
    )

    return {
        "task_id": task_id,
        "message": "AI 分析已提交，请稍后查询结果",
        "exam": {"id": exam['id'], "title": exam['title'], "subject": exam['subject']},
        # E1: 与成绩弹窗同一份口径（批改中的答卷不进平均分/及格率，另给已判份数）
        "statistics": {**stats, "total_score": exam['total_score']},
        "question_accuracy": q_accuracy,
    }


# ═══════════════════════════════════════════════════════════
# V3.2 新增：AI 教学建议
# ═══════════════════════════════════════════════════════════

@router.get("/teaching-suggestions", summary="AI 教学建议")
async def teaching_suggestions(
    request: Request,
    grade: str = Query(...),
    cls: str = Query(...),
    teacher_username: str = Query(""),
):
    """AI 生成具体可操作的教学建议（与班级学情共用同一份快照）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看")

    query_teacher = teacher_username if (role == 0 and teacher_username) else username
    from backend.analytics_service import build_class_snapshot
    snapshot = build_class_snapshot(user, query_teacher, grade, cls)
    scope = snapshot["scope"]
    d = snapshot["data"]
    if d["total_students"] == 0:
        return {
            "task_id": None,
            "empty": True,
            "message": "该班级暂无学生数据",
            "data": d,
            "sources": [],
        }

    from backend.permission_service import get_teacher_subjects
    subjects = get_teacher_subjects(query_teacher)
    subject = subjects[0] if subjects else "通用"

    ai_role = build_ai_role(grade=grade)
    prompt = f"{ai_role}" + TEACHING_SUGGESTIONS_PROMPT.format(
        grade=grade,
        cls=scope["class_num"],
        subject=subject,
        total_students=d["total_students"],
        score_count=d["score_count"],
        score_total=d["score_total"],
        score_avg=d["score_avg"],
        score_max=d["score_max"],
        score_min=d["score_min"],
        rollcall_total=d["rollcall_total"],
        rollcall_correct=d["rollcall_correct"],
        rollcall_wrong=d["rollcall_wrong"],
        rollcall_rate=d["rollcall_rate"],
        exam_text=snapshot["exam_lines"],
        active_tasks=d["active_tasks"],
        submitted_students=d["submitted_students"],
        task_rate=d["task_rate"],
    )

    scope_key = f"ts:{query_teacher}:{grade}:{cls}"
    task_id = await _call_ai_task(
        "AI 教学建议", prompt,
        dedupe_key=scope_key,
        max_concurrent=4,
        cache_kind="teaching_suggestions",
        cache_scope=scope_key,
        created_by=username,
        cache_meta={**d, "class_display": scope["display_name"]},
    )
    data_summary = {
        "total_students": d["total_students"],
        "score_avg": d["score_avg"],
        "rollcall_rate": d["rollcall_rate"],
        "exam_count": d["exam_count"],
        "task_rate": d["task_rate"],
    }
    return {
        "task_id": task_id,
        "message": "AI 分析已提交，请稍后查询结果",
        "data": data_summary,
        "sources": snapshot["sources"],
    }


# ═══════════════════════════════════════════════════════════
# 导出 WORD 文档
# ═══════════════════════════════════════════════════════════

def _markdown_to_docx(doc, text: str):
    """将 Markdown 文本写入 docx 文档"""
    from docx.shared import Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    for line in text.split('\n'):
        line = line.strip()
        if not line:
            doc.add_paragraph()
            continue
        if line.startswith('### '):
            doc.add_heading(line[4:], level=3)
        elif line.startswith('## '):
            doc.add_heading(line[3:], level=2)
        elif line.startswith('# '):
            doc.add_heading(line[2:], level=1)
        elif line.startswith('- **') and '：' in line:
            content = line.lstrip('- ')
            p = doc.add_paragraph()
            bold_end = content.find('**', 2)
            if bold_end > 0:
                run = p.add_run(content[2:bold_end])
                run.bold = True
                p.add_run(content[bold_end + 2:])
            else:
                p.add_run(content)
        elif line.startswith('- '):
            doc.add_paragraph(line[2:], style='List Bullet')
        elif any(line.startswith(f'{i}. ') for i in range(1, 10)):
            doc.add_paragraph(line, style='List Number')
        else:
            if '**' in line:
                p = doc.add_paragraph()
                parts = line.split('**')
                for i, part in enumerate(parts):
                    if part:
                        run = p.add_run(part)
                        if i % 2 == 1:
                            run.bold = True
            else:
                doc.add_paragraph(line)


@router.get("/class-overview/export", summary="导出班级学情分析为 Word 文档")
async def export_class_overview_docx(
    request: Request,
    grade: str = Query(...),
    cls: str = Query(...),
    teacher: str = Query(""),
    report_id: int | None = Query(None, description="页面生成的报告 ID"),
):
    """导出班级学情报告；只读已生成报告，不再重复调用模型。"""
    import io
    import urllib.parse
    from docx import Document
    from docx.shared import Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from fastapi.responses import StreamingResponse

    user = get_current_user(request)
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可导出")

    from backend.api.export_router import _resolve_export_teacher
    query_teacher = _resolve_export_teacher(user, teacher)
    scope_key = f"co:{query_teacher}:{grade}:{cls}"
    from backend.ai_report_cache import get_latest_report, get_report
    if report_id:
        report = get_report(report_id, user["username"], role, kind="class_overview")
    else:
        report = get_latest_report("class_overview", scope_key)
    if not report:
        raise HTTPException(status_code=409, detail="请先在页面生成班级学情报告，再导出")

    content = report.get("content") or ""
    meta = report.get("meta") or {}
    cls_name = meta.get("class_display") or f"{grade}{cls}班"
    total_students = meta.get("total_students", 0)

    doc = Document()
    style = doc.styles['Normal']  # type: ignore[union-attr, attr-defined]
    style.font.name = 'Microsoft YaHei'  # type: ignore[attr-defined]
    style.font.size = Pt(11)  # type: ignore[attr-defined]
    style.paragraph_format.line_spacing = 1.5  # type: ignore[attr-defined]

    title = doc.add_heading(f"{cls_name} 学情分析报告", level=1)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    info = doc.add_paragraph()
    info.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = info.add_run(f"年级：{grade}  班级：{cls}  学生人数：{total_students}")
    run.font.size = Pt(10)
    run.font.color.rgb = RGBColor(0x66, 0x66, 0x66)

    doc.add_paragraph()
    _markdown_to_docx(doc, content)

    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    safe_filename = urllib.parse.quote(f"学情分析_{cls_name}.docx")
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{safe_filename}"},
    )


@router.get("/teaching-suggestions/export", summary="导出 AI 教学建议为 Word 文档")
async def export_teaching_suggestions_docx(
    request: Request,
    grade: str = Query(...),
    cls: str = Query(...),
    teacher_username: str = Query(""),
    report_id: int | None = Query(None, description="页面生成的报告 ID"),
):
    """导出 AI 教学建议；只读已生成报告，不再重复调用模型。"""
    import io
    import urllib.parse
    from docx import Document
    from docx.shared import Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from fastapi.responses import StreamingResponse

    user = get_current_user(request)
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可导出")

    from backend.api.export_router import _resolve_export_teacher
    query_teacher = _resolve_export_teacher(user, teacher_username)
    scope_key = f"ts:{query_teacher}:{grade}:{cls}"
    from backend.ai_report_cache import get_latest_report, get_report
    if report_id:
        report = get_report(report_id, user["username"], role, kind="teaching_suggestions")
    else:
        report = get_latest_report("teaching_suggestions", scope_key)
    if not report:
        raise HTTPException(status_code=409, detail="请先在页面生成 AI 教学建议，再导出")

    content = report.get("content") or ""
    meta = report.get("meta") or {}
    cls_name = meta.get("class_display") or f"{grade}{cls}班"
    total_students = meta.get("total_students", 0)

    doc = Document()
    style = doc.styles['Normal']  # type: ignore[union-attr, attr-defined]
    style.font.name = 'Microsoft YaHei'  # type: ignore[attr-defined]
    style.font.size = Pt(11)  # type: ignore[attr-defined]
    style.paragraph_format.line_spacing = 1.5  # type: ignore[attr-defined]

    title = doc.add_heading(f"{cls_name} AI 教学建议", level=1)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    info = doc.add_paragraph()
    info.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = info.add_run(f"年级：{grade}  班级：{cls}  学生人数：{total_students}")
    run.font.size = Pt(10)
    run.font.color.rgb = RGBColor(0x66, 0x66, 0x66)

    doc.add_paragraph()
    _markdown_to_docx(doc, content)

    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    safe_filename = urllib.parse.quote(f"教学建议_{cls_name}.docx")
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{safe_filename}"},
    )


@router.get("/exam/{exam_id}/report/export", summary="导出考试 AI 分析报告为 Word 文档")
async def export_exam_report_docx(
    exam_id: int,
    request: Request,
    report_id: int | None = Query(None, description="页面生成的报告 ID"),
):
    """导出考试分析报告；只读已生成报告，不再重复调用模型。"""
    import io
    import urllib.parse
    from docx import Document
    from docx.shared import Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from fastapi.responses import StreamingResponse

    user = get_current_user(request)
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可导出")

    exam = q_execute_query("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")
    exam = exam[0]
    from backend.api.export_router import _assert_can_view_exam
    _assert_can_view_exam(user, dict(exam))

    scope_key = f"ea:{exam_id}"
    from backend.ai_report_cache import get_latest_report, get_report
    if report_id:
        report = get_report(report_id, user["username"], role, kind="exam_report")
    else:
        report = get_latest_report("exam_report", scope_key)
    if not report:
        raise HTTPException(status_code=409, detail="请先在页面生成考试分析报告，再导出")

    content = report.get("content") or ""
    doc = Document()
    style = doc.styles['Normal']  # type: ignore[union-attr, attr-defined]
    style.font.name = 'Microsoft YaHei'  # type: ignore[attr-defined]
    style.font.size = Pt(11)  # type: ignore[attr-defined]
    style.paragraph_format.line_spacing = 1.5  # type: ignore[attr-defined]

    title = doc.add_heading(f"考试分析报告 - {exam['title']}", level=1)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    info = doc.add_paragraph()
    info.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = info.add_run(f"科目：{exam['subject']}  生成时间：{report.get('created_at', '')}")
    run.font.size = Pt(10)
    run.font.color.rgb = RGBColor(0x66, 0x66, 0x66)

    doc.add_paragraph()
    _markdown_to_docx(doc, content)

    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    safe_filename = urllib.parse.quote(f"考试分析_{exam['title']}.docx")
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{safe_filename}"},
    )
