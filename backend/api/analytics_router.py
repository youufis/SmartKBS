"""
AI 智能学情分析 API 路由
利用 DashScope AI 对学习数据进行分析，生成自然语言学情报告
"""
import json
import os
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, Query

from backend.api.dependencies import get_current_user
from backend.database import execute_query
from backend.question_db import execute_query as q_execute_query
from backend.logger import logger

router = APIRouter()


def _get_dashscope_api_key() -> str:
    """获取 DashScope API Key"""
    key = os.environ.get("DASHSCOPE_API_KEY", "")
    if not key:
        try:
            from backend.api.config_router import load_config
            cfg = load_config()
            key = cfg.get("dashscope_api_key", "")
        except Exception:
            pass
    return key


def _call_ai(prompt: str) -> str:
    """调用 AI 分析（非流式）- 支持智能体/直接调大模型双模式"""
    api_key = _get_dashscope_api_key()
    if not api_key:
        return "⚠️ AI 分析功能不可用：请管理员在「系统配置」中填写 DashScope API Key"

    from backend.api.ai_service import call_ai_sync
    try:
        return call_ai_sync(prompt, api_key)
    except Exception as e:
        logger.error(f"AI 学情分析调用失败: {e}")
        return f"AI 分析出错：{str(e)}"


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


@router.get("/class-overview", summary="班级学情总览（AI 生成）")
async def class_overview(
    request: Request,
    grade: str = Query("", description="年级"),
    cls: str = Query("", description="班级"),
    teacher: str = Query("", description="教师用户名"),
):
    """AI 生成班级学情总览报告"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看")

    query_teacher = teacher or username

    # 收集班级数据
    # 班级号格式处理：users.class 存数字(1)，下拉框传"高一1班"
    class_num = _extract_class_num(cls)

    # 1. 学生人数
    student_count = execute_query(
        "SELECT COUNT(*) FROM users WHERE role = 2 AND grade = ? AND class = ?",
        (grade, class_num),
    )
    total_students = student_count[0][0] if student_count else 0
    if total_students == 0:
        return {"report": "暂无该班级的学生数据", "data": {}}

    # 2. 积分统计（scores.class_name 存 "高一1班" 格式）
    score_stats = execute_query(
        """SELECT COUNT(*), COALESCE(SUM(score),0), COALESCE(AVG(score),0),
                  COALESCE(MAX(score),0), COALESCE(MIN(score),0)
           FROM scores WHERE teacher_username = ? AND grade = ? AND class_name = ?""",
        (query_teacher, grade, cls),
    )

    # 3. 点名统计（rollcall_history.result 存 correct/incorrect/skip）
    rc_stats = execute_query(
        """SELECT COUNT(*),
                  SUM(CASE WHEN result='correct' THEN 1 ELSE 0 END),
                  SUM(CASE WHEN result='incorrect' THEN 1 ELSE 0 END)
           FROM rollcall_history WHERE teacher_username = ? AND grade = ? AND class_name = ?""",
        (query_teacher, grade, cls),
    )

    # 4. 考试统计（该班级最近的考试）
    exam_stats = q_execute_query(
        """SELECT e.title, e.subject, COUNT(ea.id) as attempt_count,
                  COALESCE(AVG(ea.score),0) as avg_score,
                  e.pass_score, e.total_score
           FROM exams e
           LEFT JOIN exam_attempts ea ON ea.exam_id = e.id
           WHERE e.status IN ('published', 'ended')
           GROUP BY e.id
           ORDER BY e.created_at DESC LIMIT 5""",
    )

    # 5. 任务完成率
    task_stats = execute_query(
        "SELECT COUNT(*) FROM tasks WHERE creator_username = ? AND status = 'active'",
        (query_teacher,),
    )
    task_submissions = execute_query(
        """SELECT COUNT(DISTINCT ts.student_username)
           FROM task_submissions ts
           JOIN tasks t ON ts.task_id = t.id
           WHERE t.creator_username = ?""",
        (query_teacher,),
    )

    # ── 构造 AI Prompt ──
    sc = score_stats[0] if score_stats else (0, 0, 0, 0, 0)
    rc = rc_stats[0] if rc_stats else (0, 0, 0)

    data_summary = {
        "grade": grade,
        "class": cls,
        "total_students": total_students,
        "score_count": _safe_int(sc[0]),
        "score_total": _safe_int(sc[1]),
        "score_avg": round(_safe_float(sc[2]), 1),
        "score_max": _safe_int(sc[3]),
        "score_min": _safe_int(sc[4]),
        "rollcall_total": _safe_int(rc[0]),
        "rollcall_correct": _safe_int(rc[1]),
        "rollcall_wrong": _safe_int(rc[2]),
        "exams": [
            {
                "title": e['title'],
                "subject": e['subject'],
                "attempts": _safe_int(e['attempt_count']),
                "avg_score": round(_safe_float(e['avg_score']), 1),
                "pass_score": _safe_float(e['pass_score']),
                "total_score": _safe_float(e['total_score']),
            }
            for e in exam_stats
        ],
        "active_tasks": _safe_int(task_stats[0][0] if task_stats else 0),
        "submitted_students": _safe_int(task_submissions[0][0] if task_submissions else 0),
    }

    prompt = f"""你是一位经验丰富的高中信息技术/通用技术教师。请根据以下班级数据，生成一份专业的学情分析报告。

班级：{grade}{cls}班
学生人数：{total_students}

【课堂积分】
有积分记录的学生数：{data_summary['score_count']}
总积分：{data_summary['score_total']}
平均积分：{data_summary['score_avg']}
最高积分：{data_summary['score_max']}

【点名情况】
总点名次数：{data_summary['rollcall_total']}
回答正确次数：{data_summary['rollcall_correct']}
回答错误次数：{data_summary['rollcall_wrong']}

【考试情况】
{chr(10).join(f"- 《{e['title']}》({e['subject']}): 参考{e['attempts']}人, 平均分{e['avg_score']}/{e['total_score']}" for e in data_summary['exams'])}

【任务完成】
活跃任务数：{data_summary['active_tasks']}
已提交学生数：{data_summary['submitted_students']}

请生成包含以下内容的分析报告（以 Markdown 格式输出）：
1. 📊 **班级整体情况**：对该班级的学习状态进行总体评价
2. 📈 **学习亮点**：指出表现突出的方面
3. ⚠️ **需要关注的问题**：指出薄弱环节
4. 💡 **教学建议**：给出具体的改进建议

请使用自然、亲切的语气，直接以分析内容开头，不要出现"根据提供的数据"等冗余表述。"""

    ai_report = _call_ai(prompt)

    return {
        "report": ai_report,
        "data": data_summary,
    }


@router.get("/student/{target_username}", summary="学生个体 AI 学情分析")
async def student_analytics(target_username: str, request: Request):
    """AI 生成学生个体学情分析"""
    user = get_current_user(request)
    role = user.get("role", 2)

    if role == 2 and user["username"] != target_username:
        raise HTTPException(status_code=403, detail="无权查看")

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

    # 积分
    score_rows = execute_query(
        "SELECT COALESCE(SUM(score),0) FROM scores WHERE student_name = ?",
        (student_name,),
    )
    total_score = score_rows[0][0] if score_rows else 0

    # 点名
    rc_rows = execute_query(
        """SELECT COUNT(*), SUM(CASE WHEN result='1' THEN 1 ELSE 0 END)
           FROM rollcall_history WHERE student_name = ?""",
        (student_name,),
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

    # 构建数据
    exam_text = ""
    for e in exam_results:
        exam_text += f"- 《{e['title']}》({e['subject']}): {e['score']}/{e['total_score']}分 ({'通过' if e['score'] >= e['pass_score'] else '未通过'})\n"

    prompt = f"""你是一位高中信息技术教师。请根据以下学生数据，生成一份个性化的学情分析报告。

学生：{student_name}
班级：{student_grade}{student_class}

【考试成绩】
{exam_text if exam_text else '暂无考试记录'}

【课堂积分】累计 {total_score} 分
【点名情况】共被点名 {rc_total} 次，回答正确 {rc_correct} 次
【任务完成】已提交 {task_count} 个任务
【AI 对话】共 {chat_count} 次

请生成（Markdown 格式）：
1. 📊 **学习概况**
2. 💪 **优势与进步**
3. 🔧 **改进建议**
4. 🎯 **下一阶段学习建议**

语气亲切、鼓励为主。"""

    ai_report = _call_ai(prompt)

    return {
        "student": {"username": target_username, "name": student_name, "grade": student_grade, "class": student_class},
        "report": ai_report,
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

    attempts = q_execute_query(
        "SELECT * FROM exam_attempts WHERE exam_id = ? AND status IN ('submitted', 'graded') AND auto_graded = 1 AND answers IS NOT NULL AND answers != '' ORDER BY score DESC",
        (exam_id,),
    )

    questions = q_execute_query(
        """SELECT qb.id, qb.type, qb.question_text, qb.correct_answer, qb.difficulty, qb.knowledge_points,
                  eq.score as question_score
           FROM exam_questions eq
           JOIN question_bank qb ON eq.question_id = qb.id
           WHERE eq.exam_id = ?
           ORDER BY eq.sort_order""",
        (exam_id,),
    )

    scores = [a['score'] for a in attempts]
    total_count = len(scores)
    avg_score = round(sum(scores) / max(total_count, 1), 1)
    pass_count = sum(1 for s in scores if s >= exam['pass_score'])
    max_score = max(scores) if scores else 0
    min_score = min(scores) if scores else 0

    # 每题正确率
    q_accuracy = []
    for q in questions:
        correct = 0
        for a in attempts:
            if a.get('answers'):
                try:
                    answers = json.loads(a['answers']) if isinstance(a['answers'], str) else a['answers']
                except (json.JSONDecodeError, TypeError):
                    answers = {}
            else:
                answers = {}
            q_key = str(q['id'])
            # 注意: answers 存储的是批改结果对象，如 {student_answer, correct_answer, is_correct}
            ans_entry = answers.get(q_key, {})
            if isinstance(ans_entry, dict):
                if ans_entry.get('is_correct'):
                    correct += 1
            elif ans_entry == q['correct_answer']:
                # 兼容旧格式：直接存答案文本
                correct += 1
        rate = round(correct / max(total_count, 1) * 100, 1)
        q_accuracy.append({
            "id": q['id'],
            "type": q['type'],
            "text": q['question_text'][:80],
            "correct_rate": rate,
            "difficulty": q.get('difficulty', 'medium'),
            "knowledge_points": q.get('knowledge_points', ''),
        })

    # 找出最薄弱的知识点
    weak_points = [q for q in q_accuracy if q['correct_rate'] < 60]

    prompt = f"""你是一位高中{exam['subject']}教师。请根据以下考试数据，生成专业的考试分析报告。

考试名称：{exam['title']}
科目：{exam['subject']}
参考人数：{total_count}
平均分：{avg_score}/{exam['total_score']}
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

    ai_report = _call_ai(prompt)

    return {
        "exam": {"id": exam['id'], "title": exam['title'], "subject": exam['subject']},
        "statistics": {
            "total_students": total_count,
            "avg_score": avg_score,
            "max_score": max_score,
            "min_score": min_score,
            "pass_count": pass_count,
            "pass_rate": round(pass_count / max(total_count, 1) * 100, 1),
            "total_score": exam['total_score'],
        },
        "question_accuracy": q_accuracy,
        "report": ai_report,
    }
