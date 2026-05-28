"""
学生成长档案 API 路由
聚合展示学生全维度成长数据：考试、积分、点名、任务、对话
"""
from datetime import datetime, timedelta
from collections import defaultdict

from fastapi import APIRouter, HTTPException, Request

from backend.api.dependencies import get_current_user
from backend.database import execute_query
from backend.question_db import execute_query as q_execute_query
from backend.logger import logger

router = APIRouter()


@router.get("/{username}", summary="获取学生完整成长档案")
async def get_portfolio(username: str, request: Request):
    """获取指定学生的完整成长档案"""
    user = get_current_user(request)
    current_username = user["username"]
    role = user.get("role", 2)

    # 权限：学生只能看自己，教师/管理员可看任何学生
    if role == 2 and current_username != username:
        raise HTTPException(status_code=403, detail="无权查看其他学生的档案")

    # 获取学生基本信息
    user_rows = execute_query(
        "SELECT username, name, class, grade, gender FROM users WHERE username = ?",
        (username,),
    )
    if not user_rows:
        raise HTTPException(status_code=404, detail="学生不存在")

    user_info = {
        "username": user_rows[0][0],
        "name": user_rows[0][1] or user_rows[0][0],
        "class": user_rows[0][2] or "",
        "grade": user_rows[0][3] or "",
        "gender": str(user_rows[0][4] or ""),
    }

    # ── 1. 考试成绩 ──
    exam_results = q_execute_query(
        """SELECT ea.id, e.title, ea.score, ea.total_score, e.pass_score,
                  ea.submitted_at, e.subject
           FROM exam_attempts ea
           JOIN exams e ON ea.exam_id = e.id
           WHERE ea.student_username = ? AND ea.status IN ('submitted', 'graded')
           ORDER BY ea.submitted_at ASC""",
        (username,),
    )

    exam_stats = {}
    if exam_results:
        scores = [r['score'] for r in exam_results]
        total_scores = [r['total_score'] for r in exam_results]
        percentages = [(r['score'] / r['total_score'] * 100) if r['total_score'] > 0 else 0 for r in exam_results]
        passed = sum(1 for r in exam_results if r['score'] >= r['pass_score'])
        exam_stats = {
            "total_exams": len(exam_results),
            "avg_score": round(sum(scores) / len(scores), 1) if scores else 0,
            "avg_percentage": round(sum(percentages) / len(percentages), 1) if percentages else 0,
            "passed_count": passed,
            "failed_count": len(exam_results) - passed,
            "max_score": max(scores) if scores else 0,
            "min_score": min(scores) if scores else 0,
            "trend": percentages,  # 百分比趋势（用于前端画折线图）
            "subjects": list(set(r['subject'] for r in exam_results if r['subject'])),
        }

    # ── 2. 课堂积分 ──
    scores_rows = execute_query(
        """SELECT teacher_username, grade, class_name, score, updated_at
           FROM scores WHERE student_name = ?
           ORDER BY updated_at DESC""",
        (user_info['name'],),
    )

    score_stats = {}
    if scores_rows:
        total_score = sum(r[3] for r in scores_rows)
        teacher_count = len(set(r[0] for r in scores_rows))
        score_stats = {
            "total_score": total_score,
            "teacher_count": teacher_count,
            "class_count": len(set(r[2] for r in scores_rows)),
            "records": [
                {
                    "teacher": r[0],
                    "grade": r[1],
                    "class": r[2],
                    "score": r[3],
                    "updated_at": r[4] or "",
                }
                for r in scores_rows
            ],
        }

        # 积分趋势（按日期分组）
        score_by_date = defaultdict(int)
        for r in scores_rows:
            if r[4]:
                date_key = r[4][:10]
                score_by_date[date_key] += r[3]
        score_stats["trend"] = [
            {"date": k, "score": v}
            for k, v in sorted(score_by_date.items())
        ]

    # ── 3. 点名记录 ──
    rollcall_rows = execute_query(
        """SELECT teacher_username, grade, class_name, result, points, created_at
           FROM rollcall_history WHERE student_name = ?
           ORDER BY created_at DESC""",
        (user_info['name'],),
    )

    rollcall_stats = {}
    if rollcall_rows:
        total_calls = len(rollcall_rows)
        correct = sum(1 for r in rollcall_rows if r[3] == "1")
        wrong = sum(1 for r in rollcall_rows if r[3] == "0")
        total_points = sum(r[4] or 0 for r in rollcall_rows)
        rollcall_stats = {
            "total_calls": total_calls,
            "correct_count": correct,
            "wrong_count": wrong,
            "accuracy": round(correct / max(total_calls, 1) * 100, 1),
            "total_points": total_points,
        }

    # ── 4. 任务完成 ──
    task_rows = execute_query(
        """SELECT t.name, t.description, ts.submitted_at, t.created_at
           FROM task_submissions ts
           JOIN tasks t ON ts.task_id = t.id
           WHERE ts.student_username = ?
           ORDER BY ts.submitted_at DESC""",
        (username,),
    )

    task_stats = {}
    if task_rows:
        task_stats = {
            "completed": len(task_rows),
            "tasks": [
                {
                    "name": r[0],
                    "description": r[1] or "",
                    "submitted_at": r[2] or "",
                }
                for r in task_rows
            ],
        }
    else:
        task_stats = {"completed": 0, "tasks": []}

    # ── 5. 对话活跃度 ──
    chat_rows = execute_query(
        """SELECT date, COUNT(*) as cnt
           FROM conversations WHERE username = ?
           GROUP BY date ORDER BY date DESC""",
        (username,),
    )

    chat_stats = {}
    if chat_rows:
        total_days = len(chat_rows)
        total_chats = sum(r[1] for r in chat_rows)
        chat_stats = {
            "total_days": total_days,
            "total_chats": total_chats,
            "avg_daily": round(total_chats / max(total_days, 1), 1),
            "recent_days": [
                {"date": r[0], "count": r[1]}
                for r in chat_rows[:30]
            ],
        }

    # ── 6. 综合摘要 ──
    summary_parts = []
    if exam_stats:
        summary_parts.append(
            f"参加了 {exam_stats['total_exams']} 场考试，"
            f"平均分 {exam_stats['avg_percentage']}%，"
            f"通过 {exam_stats['passed_count']} 场"
        )
    if score_stats:
        summary_parts.append(
            f"累计获得 {score_stats['total_score']} 课堂积分"
        )
    if rollcall_stats:
        summary_parts.append(
            f"被点名 {rollcall_stats['total_calls']} 次，"
            f"正确率 {rollcall_stats['accuracy']}%"
        )
    if task_stats:
        summary_parts.append(
            f"完成 {task_stats['completed']} 个任务"
        )
    if chat_stats:
        summary_parts.append(
            f"AI 对话活跃 {chat_stats['total_days']} 天，共 {chat_stats['total_chats']} 次"
        )

    return {
        "user": user_info,
        "summary": " | ".join(summary_parts) if summary_parts else "暂无学习数据",
        "exams": {
            "results": exam_results,
            "stats": exam_stats,
        },
        "scores": score_stats,
        "rollcall": rollcall_stats,
        "tasks": task_stats,
        "chats": chat_stats,
    }


@router.get("/{username}/timeline", summary="获取学生成长时间轴")
async def get_timeline(username: str, request: Request):
    """获取学生成长时间轴事件"""
    user = get_current_user(request)
    current_username = user["username"]
    role = user.get("role", 2)

    if role == 2 and current_username != username:
        raise HTTPException(status_code=403, detail="无权查看")

    user_rows = execute_query(
        "SELECT name FROM users WHERE username = ?",
        (username,),
    )
    student_name = user_rows[0][0] if user_rows and user_rows[0][0] else username

    events = []

    # 考试事件
    exam_events = q_execute_query(
        """SELECT ea.submitted_at, e.title, ea.score, e.total_score, e.pass_score
           FROM exam_attempts ea
           JOIN exams e ON ea.exam_id = e.id
           WHERE ea.student_username = ? AND ea.submitted_at IS NOT NULL
           ORDER BY ea.submitted_at ASC""",
        (username,),
    )
    for ev in exam_events:
        passed = ev['score'] >= ev['pass_score']
        events.append({
            "time": ev['submitted_at'],
            "type": "exam",
            "title": f"完成了考试「{ev['title']}」",
            "detail": f"得分 {ev['score']}/{ev['total_score']} {'✅ 通过' if passed else '❌ 未通过'}",
            "icon": "exam",
        })

    # 积分事件
    score_events = execute_query(
        """SELECT updated_at, score, teacher_username, class_name
           FROM scores WHERE student_name = ?
           ORDER BY updated_at ASC""",
        (student_name,),
    )
    for ev in score_events:
        if ev[0]:
            events.append({
                "time": ev[0],
                "type": "score",
                "title": f"课堂积分变动",
                "detail": f"{'获得' if ev[1] > 0 else '扣除'} {abs(ev[1])} 分 (由 {ev[2]})",
                "icon": "score",
            })

    # 点名事件
    rc_events = execute_query(
        """SELECT created_at, result, points, teacher_username
           FROM rollcall_history WHERE student_name = ?
           ORDER BY created_at ASC""",
        (student_name,),
    )
    for ev in rc_events:
        if ev[0]:
            result_label = "正确" if ev[1] == "1" else ("错误" if ev[1] == "0" else "待定")
            events.append({
                "time": ev[0],
                "type": "rollcall",
                "title": "被点名",
                "detail": f"回答{result_label}，积分变动 {ev[2] or 0}",
                "icon": "rollcall",
            })

    # 任务事件
    task_events = execute_query(
        """SELECT ts.submitted_at, t.name
           FROM task_submissions ts
           JOIN tasks t ON ts.task_id = t.id
           WHERE ts.student_username = ?
           ORDER BY ts.submitted_at ASC""",
        (username,),
    )
    for ev in task_events:
        if ev[0]:
            events.append({
                "time": ev[0],
                "type": "task",
                "title": f"提交了任务「{ev[1]}」",
                "detail": "",
                "icon": "task",
            })

    # 按时间排序
    events.sort(key=lambda x: x["time"] or "")
    return events
