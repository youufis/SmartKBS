"""
报告导出 API 路由
生成 Excel/CSV 格式的成绩单、考试报告、点名记录、课堂互动数据等
"""
import csv
import io
import json
import re
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, Query
from fastapi.responses import StreamingResponse
import openpyxl
from openpyxl.styles import Font, Alignment, Border, Side, PatternFill
from openpyxl.utils import get_column_letter

from backend.api.dependencies import get_current_user
from backend.database import execute_query
from backend.question_db import (
    execute_query as q_execute_query,
    execute_query_one,
)
from backend.logger import logger
from backend.permission_service import (
    get_teacher_grades,
    get_teacher_classes,
    get_students_in_scope,
    get_grade_by_name,
    _resolve_class_id_flexible,
)
from backend.summary_service import SUMMARY_TYPES, build_summary

router = APIRouter()

# E5: 单次导出的行数上限, 超限要求先筛选(而不是静默截断或撑爆内存)
MAX_EXPORT_ROWS = 50000

# ── 样式常量 ──
HEADER_FONT = Font(name="微软雅黑", bold=True, size=11, color="FFFFFF")
HEADER_FILL = PatternFill(start_color="1677FF", end_color="1677FF", fill_type="solid")
HEADER_ALIGNMENT = Alignment(horizontal="center", vertical="center", wrap_text=True)
CELL_ALIGNMENT = Alignment(horizontal="center", vertical="center")
BORDER = Border(
    left=Side(style="thin"),
    right=Side(style="thin"),
    top=Side(style="thin"),
    bottom=Side(style="thin"),
)
TITLE_FONT = Font(name="微软雅黑", bold=True, size=14)


def _guard_row_count(total: int, what: str = "导出") -> None:
    """E5: 行数超限直接报错并提示缩小范围"""
    if total > MAX_EXPORT_ROWS:
        raise HTTPException(
            status_code=400,
            detail=f"{what}约 {total} 行，超过单次上限 {MAX_EXPORT_ROWS} 行，请先缩小年级/班级/时间范围",
        )


def _resolve_export_teacher(user: dict, requested: str) -> str:
    """E1: 管理员可指定任意教师; 教师只能导出自己的教学数据(与 /rollcall 口径一致)"""
    if user.get("role", 2) == 0 and requested:
        return requested
    return user.get("username", "")


def _assert_can_view_exam(user: dict, exam: dict) -> None:
    """E2: 考试报告(含每题正确答案)仅限创建者或管理员, 与 exam_router._can_manage_exam 一致"""
    if user.get("role", 2) == 0:
        return
    if (exam.get("creator_username") or "") == user.get("username", ""):
        return
    raise HTTPException(status_code=403, detail="仅考试创建者和管理员可导出该考试的成绩报告")


def _assert_can_view_task(user: dict, task_creator: str) -> None:
    """E3: 任务提交记录仅限创建者或管理员"""
    if user.get("role", 2) == 0:
        return
    if (task_creator or "") == user.get("username", ""):
        return
    raise HTTPException(status_code=403, detail="仅任务创建者和管理员可导出该任务的提交记录")


def _assert_can_view_interaction(user: dict, creator: str, kind: str = "测验") -> None:
    """E2b: 随堂测验/投票结果仅限创建者或管理员"""
    if user.get("role", 2) == 0:
        return
    if (creator or "") == user.get("username", ""):
        return
    raise HTTPException(status_code=403, detail=f"仅{kind}创建者和管理员可导出结果")


def _style_header(ws, row: int, cols: int):
    """给表头行设置样式"""
    for col in range(1, cols + 1):
        cell = ws.cell(row=row, column=col)
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        cell.alignment = HEADER_ALIGNMENT
        cell.border = BORDER


def _style_cells(ws, start_row: int, end_row: int, cols: int):
    """给数据区域设置样式"""
    for row in range(start_row, end_row + 1):
        for col in range(1, cols + 1):
            cell = ws.cell(row=row, column=col)
            cell.alignment = CELL_ALIGNMENT
            cell.border = BORDER


def _auto_width(ws, cols: int, max_width: int = 40):
    """自动调整列宽"""
    for col in range(1, cols + 1):
        max_len = 0
        for row in ws.iter_rows(min_col=col, max_col=col):
            for cell in row:
                if cell.value:
                    max_len = max(max_len, len(str(cell.value)))
        ws.column_dimensions[get_column_letter(col)].width = min(max_len + 4, max_width)


def _excel_response(wb, filename: str) -> StreamingResponse:
    """将 workbook 转为 StreamingResponse"""
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    # 使用 RFC 5987 编码支持中文文件名
    from urllib.parse import quote
    encoded_name = quote(filename, safe='')
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_name}",
            "Access-Control-Expose-Headers": "Content-Disposition",
        },
    )


# ── 1. 导出课堂积分 ──

@router.get("/scores", summary="导出课堂积分表 (Excel)")
def export_scores(
    request: Request,
    teacher: str = Query("", description="教师用户名"),
    grade: str = Query("", description="年级"),
    cls: str = Query("", description="班级"),
):
    """导出班级积分表为 Excel

    E1: 旧实现把 teacher 参数直接当查询条件, 任一教师可导出同事名下的班级积分表
        (实测 chenshaofeng 取到 youufis 全部学生姓名与分数)。
    E4: 由 async def 改为 def, 交给 Starlette 线程池执行, 不再占住事件循环。
    """
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")

    # 确定查询的教师(管理员可指定, 教师固定为自己)
    query_teacher = _resolve_export_teacher(user, teacher)
    cnt = execute_query("SELECT COUNT(*) FROM scores WHERE teacher_username = ?", (query_teacher,))
    _guard_row_count(cnt[0][0] if cnt else 0, "班级积分表")

    # 构建条件
    conditions = ["teacher_username = ?"]
    params = [query_teacher]
    if grade:
        conditions.append("grade = ?")
        params.append(grade)
    if cls:
        conditions.append("class_name = ?")
        params.append(cls)

    where = " AND ".join(conditions)
    rows = execute_query(
        f"""SELECT grade, class_name, student_name, score, updated_at
            FROM scores WHERE {where}
            ORDER BY grade, class_name, score DESC""",
        tuple(params),
    )

    if not rows:
        raise HTTPException(status_code=404, detail="没有找到积分数据")

    # S-NO: scores 表只存姓名, 学号(=users.username)按「年级+姓名」反查补齐
    no_map = {}
    for g, n, unames in execute_query(
        """SELECT grade, name, GROUP_CONCAT(username, '、')
           FROM users
           WHERE role=2 AND name IS NOT NULL AND name != ''
           GROUP BY grade, name"""
    ):
        if n:
            no_map[(g or "", n)] = unames or ""

    # 计算排名
    ranked = []
    seen_classes = set()
    rank_in_class = {}
    for r in rows:
        key = f"{r[0]}|{r[1]}"
        if key not in seen_classes:
            seen_classes.add(key)
            rank_in_class[key] = 1
        ranked.append({
            "grade": r[0],
            "class": r[1],
            "student_no": no_map.get((r[0] or "", r[2] or ""), ""),
            "name": r[2],
            "score": r[3],
            "updated_at": r[4] or "",
            "rank": rank_in_class[key],
        })
        rank_in_class[key] += 1

    # 创建 Excel
    wb = openpyxl.Workbook()
    ws = wb.active
    assert ws is not None
    ws.title = "课堂积分"

    # 标题
    title = f"课堂积分表"
    if grade:
        title += f" - {grade}"
    if cls:
        title += f" - {cls}班"
    ws.merge_cells("A1:G1")
    ws.cell(1, 1, title).font = TITLE_FONT

    headers = ["年级", "班级", "学号", "学生姓名", "积分", "排名", "最后更新"]
    for i, h in enumerate(headers, 1):
        ws.cell(3, i, h)
    _style_header(ws, 3, len(headers))

    for idx, r in enumerate(ranked):
        row = idx + 4
        ws.cell(row, 1, r["grade"])
        ws.cell(row, 2, r["class"])
        ws.cell(row, 3, r["student_no"])
        ws.cell(row, 4, r["name"])
        ws.cell(row, 5, r["score"])
        ws.cell(row, 6, r["rank"])
        ws.cell(row, 7, r["updated_at"])

    _style_cells(ws, 4, len(ranked) + 3, len(headers))
    _auto_width(ws, len(headers))

    filename = f"课堂积分_{grade or '全部'}_{cls or '全部'}.xlsx"
    return _excel_response(wb, filename)


# ── 2. 导出考试结果 ──

@router.get("/exam/{exam_id}", summary="导出考试成绩报告 (Excel)")
def export_exam_result(exam_id: int, request: Request):
    """导出指定考试的完整成绩报告为 Excel"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role == 2:
        raise HTTPException(status_code=403, detail="权限不足")

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")
    _assert_can_view_exam(user, exam)

    # 获取提交记录（exam_attempts 在 questions.db 中）
    attempts = q_execute_query(
        """SELECT * FROM exam_attempts
           WHERE exam_id = ? AND status IN ('submitted', 'graded')
           ORDER BY score DESC""",
        (exam_id,),
    )

    # 批量补充学生姓名（避免 N+1 查询）
    if attempts:
        usernames = [a['student_username'] for a in attempts]
        placeholders = ",".join("?" for _ in usernames)
        user_rows = execute_query(
            f"SELECT username, name FROM users WHERE username IN ({placeholders})",
            tuple(usernames),
        )
        name_map = {r[0]: r[1] for r in user_rows} if user_rows else {}
        for a in attempts:
            a['student_real_name'] = name_map.get(a['student_username'], a.get('student_name', ''))

    # 获取考试的题目（exam_questions 和 question_bank 在 questions.db 中）
    questions = q_execute_query(
        """SELECT eq.id as eq_id, eq.score as question_score, qb.id as qid,
                  qb.type, qb.question_text, qb.correct_answer, qb.options
           FROM exam_questions eq
           JOIN question_bank qb ON eq.question_id = qb.id
           WHERE eq.exam_id = ?
           ORDER BY eq.sort_order""",
        (exam_id,),
    )

    wb = openpyxl.Workbook()

    # ── Sheet 1: 成绩总表 ──
    ws1 = wb.active
    assert ws1 is not None
    ws1.title = "成绩总表"

    title = f"考试报告 - {exam['title']}"
    ws1.merge_cells("A1:H1")
    ws1.cell(1, 1, title).font = TITLE_FONT

    # 考试信息
    info = [
        ("科目", exam["subject"]),
        ("总分", str(exam["total_score"])),
        ("及格分", str(exam["pass_score"])),
        ("考试时长", f"{exam['duration']} 分钟"),
        ("状态", {"draft": "草稿", "published": "已发布", "ended": "已结束"}.get(exam["status"], exam["status"])),
    ]
    for i, (k, v) in enumerate(info):
        ws1.cell(3, i * 2 + 1, k).font = Font(bold=True)
        ws1.cell(3, i * 2 + 2, v)

    # 统计数据
    scores_list = [a["score"] for a in attempts]
    total = len(scores_list)
    avg_score = round(sum(scores_list) / max(total, 1), 1) if scores_list else 0
    pass_count = sum(1 for s in scores_list if s >= exam["pass_score"])
    max_score = max(scores_list) if scores_list else 0
    min_score = min(scores_list) if scores_list else 0

    stats = [
        ("参考人数", total),
        ("平均分", avg_score),
        ("最高分", max_score),
        ("最低分", min_score),
        ("及格人数", pass_count),
        ("及格率", f"{round(pass_count / max(total, 1) * 100, 1)}%"),
    ]
    for i, (k, v) in enumerate(stats):
        ws1.cell(4, i * 2 + 1, k).font = Font(bold=True)
        ws1.cell(4, i * 2 + 2, v)

    # 表头
    headers1 = ["排名", "学生姓名", "用户名", "得分", "总分", "是否及格", "提交时间"]
    row_start = 6
    for i, h in enumerate(headers1, 1):
        ws1.cell(row_start, i, h)
    _style_header(ws1, row_start, len(headers1))

    for idx, a in enumerate(attempts):
        row = row_start + 1 + idx
        ws1.cell(row, 1, idx + 1)
        ws1.cell(row, 2, a.get("student_real_name") or a.get("student_name") or "")
        ws1.cell(row, 3, a["student_username"])
        ws1.cell(row, 4, a["score"])
        ws1.cell(row, 5, exam["total_score"])
        passed = "✅ 及格" if a["score"] >= exam["pass_score"] else "❌ 未及格"
        ws1.cell(row, 6, passed)
        ws1.cell(row, 7, a.get("submitted_at") or "")

    _style_cells(ws1, row_start + 1, row_start + len(attempts), len(headers1))
    _auto_width(ws1, len(headers1))

    # ── Sheet 2: 逐题分析 ──
    if questions:
        ws2 = wb.create_sheet("逐题分析")
        ws2.merge_cells("A1:F1")
        ws2.cell(1, 1, f"逐题分析 - {exam['title']}").font = TITLE_FONT

        headers2 = ["题号", "题型", "题目内容", "正确答案", "分值", "正确率"]
        for i, h in enumerate(headers2, 1):
            ws2.cell(3, i, h)
        _style_header(ws2, 3, len(headers2))

        type_map = {"single": "单选", "multiple": "多选", "true_false": "判断", "short": "简答",
                     "fill": "填空", "essay": "作文", "subjective": "主观题"}

        for idx, q in enumerate(questions):
            row = 4 + idx
            ws2.cell(row, 1, idx + 1)
            ws2.cell(row, 2, type_map.get(q["type"], q["type"]))
            # 截取题目内容
            q_text = q["question_text"]
            if len(q_text) > 80:
                q_text = q_text[:77] + "..."
            ws2.cell(row, 3, q_text)
            ws2.cell(row, 4, q["correct_answer"])
            ws2.cell(row, 5, q["question_score"])

            # 计算正确率
            correct_count = 0
            for a in attempts:
                if a.get("answers"):
                    try:
                        answers = json.loads(a["answers"]) if isinstance(a["answers"], str) else a["answers"]
                    except (json.JSONDecodeError, TypeError):
                        answers = {}
                else:
                    answers = {}
                # 题目答案的 key 在 answers 字典中
                q_key = str(q["qid"])
                student_ans = answers.get(q_key) or answers.get(str(q["eq_id"])) or ""
                if student_ans and student_ans == q["correct_answer"]:
                    correct_count += 1

            rate = round(correct_count / max(len(attempts), 1) * 100, 1)
            ws2.cell(row, 6, f"{rate}%")

        _style_cells(ws2, 4, 4 + len(questions) - 1, len(headers2))
        _auto_width(ws2, len(headers2), max_width=50)

    filename = f"考试报告_{exam['title']}.xlsx"
    return _excel_response(wb, filename)


# ── 3. 导出点名记录 ──

@router.get("/rollcall", summary="导出点名记录 (Excel)")
def export_rollcall(
    request: Request,
    teacher: str = Query("", description="教师用户名"),
    grade: str = Query("", description="年级"),
    cls: str = Query("", description="班级"),
    start_date: str = Query("", description="开始日期 YYYY-MM-DD"),
    end_date: str = Query("", description="结束日期 YYYY-MM-DD"),
):
    """导出点名历史记录为 Excel"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")

    conditions = []
    params: list[str] = []

    if role == 1:
        conditions.append("teacher_username = ?")
        params.append(username)
    elif teacher:
        conditions.append("teacher_username = ?")
        params.append(teacher)

    if grade:
        conditions.append("grade = ?")
        params.append(grade)
    if cls:
        conditions.append("class_name = ?")
        params.append(cls)
    if start_date:
        conditions.append("created_at >= ?")
        params.append(start_date)
    if end_date:
        conditions.append("created_at <= ?")
        params.append(end_date + " 23:59:59")

    where = " AND ".join(conditions) if conditions else "1=1"
    cnt = execute_query(f"SELECT COUNT(*) FROM rollcall_history WHERE {where}", tuple(params))
    _guard_row_count(cnt[0][0] if cnt else 0, "点名记录")
    rows = execute_query(
        f"""SELECT teacher_username, grade, class_name, student_name, result, points, created_at
            FROM rollcall_history WHERE {where}
            ORDER BY created_at DESC""",
        tuple(params),
    )

    if not rows:
        raise HTTPException(status_code=404, detail="没有找到点名记录")

    wb = openpyxl.Workbook()
    ws = wb.active
    assert ws is not None
    ws.title = "点名记录"

    title = "点名记录"
    if grade:
        title += f" - {grade}"
    if cls:
        title += f" - {cls}班"
    ws.merge_cells("A1:G1")
    ws.cell(1, 1, title).font = TITLE_FONT

    headers = ["教师", "年级", "班级", "学生姓名", "回答结果", "积分变动", "时间"]
    for i, h in enumerate(headers, 1):
        ws.cell(3, i, h)
    _style_header(ws, 3, len(headers))

    result_map = {"1": "正确", "0": "错误", "": "待定"}
    for idx, r in enumerate(rows):
        row = 4 + idx
        ws.cell(row, 1, r[0])
        ws.cell(row, 2, r[1])
        ws.cell(row, 3, r[2])
        ws.cell(row, 4, r[3])
        ws.cell(row, 5, result_map.get(str(r[4] or ""), str(r[4] or "待定")))
        ws.cell(row, 6, r[5])
        ws.cell(row, 7, r[6] or "")

    _style_cells(ws, 4, len(rows) + 3, len(headers))
    _auto_width(ws, len(headers))

    filename = f"点名记录_{grade or '全部'}_{cls or '全部'}.xlsx"
    return _excel_response(wb, filename)


# ── 4. 导出任务提交记录 ──

@router.get("/tasks", summary="导出任务提交记录 (Excel)")
def export_tasks(
    request: Request,
    task_id: str = Query("", description="任务ID"),
):
    """导出任务提交记录为 Excel"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")

    # 获取任务列表
    if task_id:
        tasks = execute_query(
            "SELECT * FROM tasks WHERE id = ?",
            (task_id,),
        )
    elif role == 0:
        tasks = execute_query(
            "SELECT * FROM tasks ORDER BY created_at DESC",
        )
    else:
        tasks = execute_query(
            "SELECT * FROM tasks WHERE creator_username = ? ORDER BY created_at DESC",
            (username,),
        )

    if not tasks:
        raise HTTPException(status_code=404, detail="没有找到任务")
    # E3: 按 task_id 导出时同样校验归属(旧实现任一教师传 id 就能拿到他人任务的提交名单)
    if role == 1:
        for t in tasks:
            _assert_can_view_task(user, t[1])
    ph = ",".join("?" for _ in tasks)
    cnt2 = execute_query(
        f"SELECT COUNT(*) FROM task_submissions WHERE task_id IN ({ph})",
        tuple(t[0] for t in tasks),
    )
    _guard_row_count(cnt2[0][0] if cnt2 else 0, "任务提交记录")

    wb = openpyxl.Workbook()
    first_sheet = True

    for t in tasks:
        if first_sheet:
            ws = wb.active
            assert ws is not None
            ws.title = _safe_sheet_name(t[2][:20])  # task name as sheet name
            first_sheet = False
        else:
            ws = wb.create_sheet(title=_safe_sheet_name(t[2][:20]))

        # 标题
        ws.merge_cells("A1:E1")
        ws.cell(1, 1, f"任务提交记录 - {t[2]}").font = TITLE_FONT
        ws.cell(2, 1, f"描述: {t[3] or ''}")
        ws.cell(2, 2, f"状态: {t[4]}")
        ws.cell(2, 4, f"创建时间: {t[5] or ''}")

        # 获取提交记录
        task_id_val = t[0]
        submissions = execute_query(
            """SELECT ts.submitted_at, ts.student_username, u.name
               FROM task_submissions ts
               LEFT JOIN users u ON ts.student_username = u.username
               WHERE ts.task_id = ?
               ORDER BY ts.submitted_at DESC""",
            (task_id_val,),
        )

        headers = ["序号", "学生用户名", "学生姓名", "提交时间"]
        for i, h in enumerate(headers, 1):
            ws.cell(4, i, h)
        _style_header(ws, 4, len(headers))

        for idx, s in enumerate(submissions):
            row = 5 + idx
            ws.cell(row, 1, idx + 1)
            ws.cell(row, 2, s[1])
            ws.cell(row, 3, s[2] or "")
            ws.cell(row, 4, s[0] or "")

        _style_cells(ws, 5, 5 + len(submissions) - 1, len(headers))
        _auto_width(ws, len(headers))

    filename = f"任务提交记录.xlsx"
    return _excel_response(wb, filename)


# ── 5. 导出学情进度 ──

@router.get("/progress", summary="导出学情进度 (Excel)")
def export_progress(
    request: Request,
    course_id: int = Query(None, description="课程 ID"),
    grade: str = Query(None, description="年级"),
    class_name: str = Query(None, description="班级"),
):
    """导出学情进度（知识点完成情况）为 Excel"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")

    # R1: 与进度总览共用装配函数(旧实现直接调用端点函数, 一旦端点带 Query 默认参数就会
    #     把 Query 对象当数字运算 -> TypeError 500); page=None 表示导出全量学生
    from backend.api.curriculum_router import build_progress_overview

    raw = build_progress_overview(user, course_id, grade, class_name, page=None)
    students = raw.get("students", [])
    _guard_row_count(len(students) * 10, "学情进度")

    if not students:
        raise HTTPException(status_code=404, detail="没有找到进度数据")

    wb = openpyxl.Workbook()
    ws = wb.active
    assert ws is not None
    ws.title = "学情进度"

    title = "学情进度报告"
    if grade:
        title += f" - {grade}"
    if class_name:
        title += f" - {class_name}班"
    ws.merge_cells("A1:H1")
    ws.cell(1, 1, title).font = TITLE_FONT

    headers = ["姓名", "年级", "班级", "课程", "知识点总数", "已完成", "完成率", "状态"]
    for i, h in enumerate(headers, 1):
        ws.cell(3, i, h)
    _style_header(ws, 3, len(headers))

    row_idx = 4
    for stu in students:
        stu_courses = stu.get("courses") or []
        if not stu_courses:
            ws.cell(row_idx, 1, stu.get("name", ""))
            ws.cell(row_idx, 2, stu.get("grade", ""))
            ws.cell(row_idx, 3, stu.get("class", ""))
            ws.cell(row_idx, 4, "—")
            ws.cell(row_idx, 5, 0)
            ws.cell(row_idx, 6, 0)
            ws.cell(row_idx, 7, "0%")
            ws.cell(row_idx, 8, "无课程")
            row_idx += 1
        else:
            for c in stu_courses:
                ws.cell(row_idx, 1, stu.get("name", ""))
                ws.cell(row_idx, 2, stu.get("grade", ""))
                ws.cell(row_idx, 3, stu.get("class", ""))
                ws.cell(row_idx, 4, c.get("course_name", ""))
                ws.cell(row_idx, 5, c.get("total_kps", 0))
                ws.cell(row_idx, 6, c.get("completed_kps", 0))
                rate = c.get("rate", 0)
                ws.cell(row_idx, 7, f"{rate}%")
                status = "✅ 已完成" if rate >= 100 else ("🔄 进行中" if rate > 0 else "⏳ 未开始")
                ws.cell(row_idx, 8, status)
                row_idx += 1

    _style_cells(ws, 4, row_idx - 1, len(headers))
    _auto_width(ws, len(headers))

    filename = f"学情进度_{grade or '全部'}_{class_name or '全部'}.xlsx"
    return _excel_response(wb, filename)


def _safe_sheet_name(name: str) -> str:
    """Excel sheet name max 31 chars, no special chars"""
    safe = "".join(c if c.isalnum() or c in "_ -" else "_" for c in name)
    return safe[:31] or "Sheet"


# ── CSV 响应辅助 ──

def _csv_response(rows: list[list[str]], headers: list[str], filename: str) -> StreamingResponse:
    """将数据转为 CSV 响应（带 UTF-8 BOM，Excel 可直接打开）"""
    buf = io.StringIO()
    # 注意: 下方按 utf-8-sig 编码输出时已自带 BOM, 不要再手写一个
    # (旧实现双 BOM 会让 Excel 在 A1 单元格混入零宽字符, 影响筛选/公式)
    writer = csv.writer(buf)
    writer.writerow(headers)
    for row in rows:
        writer.writerow(row)
    buf.seek(0)
    from urllib.parse import quote
    encoded_name = quote(filename, safe='')
    return StreamingResponse(
        iter([buf.getvalue().encode('utf-8-sig')]),
        media_type="text/csv; charset=utf-8-sig",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_name}",
        },
    )


# ── 6. 导出随堂测验结果 ──

@router.get("/quiz/{quiz_id}", summary="导出随堂测验结果 (CSV)")
def export_quiz_result(quiz_id: int, request: Request):
    """导出随堂测验的答题结果为 CSV 或 Excel"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")

    # 获取测验信息
    quiz = execute_query("SELECT * FROM interaction_quizzes WHERE id = ?", (quiz_id,))
    if not quiz:
        raise HTTPException(status_code=404, detail="测验不存在")
    quiz = quiz[0]
    qcreator = execute_query(
        "SELECT creator_username FROM interaction_quizzes WHERE id = ?", (quiz_id,)
    )
    _assert_can_view_interaction(user, qcreator[0][0] if qcreator else "", "随堂测验")
    questions = json.loads(quiz[4]) if isinstance(quiz[4], str) else quiz[4]

    # 获取答题记录
    answers = execute_query(
        """SELECT student_username, answers, score, submitted_at
           FROM interaction_quiz_answers WHERE quiz_id = ? ORDER BY score DESC""",
        (quiz_id,),
    )

    csv_headers = ["学生", "得分"]
    for i, q in enumerate(questions):
        csv_headers.append(f"第{i + 1}题答案")
        csv_headers.append(f"第{i + 1}题是否正确")

    csv_rows = []
    for a in answers:
        student = a[0]
        ans_data = json.loads(a[1]) if isinstance(a[1], str) else a[1]
        score = a[2]
        row = [student, str(score)]
        for i, q in enumerate(questions):
            user_ans = ""
            correct = ""
            for item in ans_data:
                if item.get("question_index") == i:
                    user_ans = item.get("answer", "")
                    correct_ans = q.get("answer", "")
                    if isinstance(q.get("options"), dict):
                        correct_ans = q.get("answer", "")
                    is_correct = "是" if str(user_ans).upper() == str(correct_ans).upper() else "否"
                    row.append(user_ans)
                    row.append(is_correct)
                    break
            else:
                row.append("")
                row.append("")
        csv_rows.append(row)

    filename = f"随堂测验_{quiz[2]}.csv"
    return _csv_response(csv_rows, csv_headers, filename)


# ── 7. 导出投票结果 ──

@router.get("/poll/{poll_id}", summary="导出投票结果 (CSV)")
def export_poll_result(poll_id: int, request: Request):
    """导出投票结果为 CSV"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")

    poll = execute_query("SELECT * FROM interaction_polls WHERE id = ?", (poll_id,))
    if not poll:
        raise HTTPException(status_code=404, detail="投票不存在")
    poll = poll[0]
    pcreator = execute_query(
        "SELECT creator_username FROM interaction_polls WHERE id = ?", (poll_id,)
    )
    _assert_can_view_interaction(user, pcreator[0][0] if pcreator else "", "投票")
    options = json.loads(poll[3]) if isinstance(poll[3], str) else poll[3]

    # 获取投票记录
    votes = execute_query(
        """SELECT student_username, selected_option FROM interaction_poll_votes
           WHERE poll_id = ? ORDER BY student_username""",
        (poll_id,),
    )

    csv_headers = ["学生", "所选选项编号", "所选选项内容"]
    csv_rows = []
    for v in votes:
        student = v[0]
        opt_idx = v[1]
        opt_text = options[opt_idx] if opt_idx < len(options) else f"选项{opt_idx}"
        csv_rows.append([student, str(opt_idx), opt_text])

    filename = f"投票结果_{poll[2]}.csv"
    return _csv_response(csv_rows, csv_headers, filename)


# ═════════════════════════════════════════════════════════════
# 8. 跨活动成绩汇总导出 (summary_service)
#    /summary/meta     可选筛选范围 (年级/班级/学生/活动类型/教师)
#    /summary/preview  JSON 预览 (前 200 条明细 + 三类聚合)
#    /summary/excel    多 Sheet Excel (明细/学生汇总/按活动/按班级)
#    /summary/csv      单表 CSV (同参数, sheet 可选)
#    权限: 管理员全部; 教师仅自己创建的活动 × 任教年级班级学生
# ═════════════════════════════════════════════════════════════

SUMMARY_PREVIEW_LIMIT = 200


def _split_csv_param(v: str) -> list[str]:
    return [x.strip() for x in (v or "").split(",") if x.strip()]


def _summary_request_filters(
    grade: str, cls: str, usernames: str, types: str,
    start: str, end: str, teacher: str,
) -> dict:
    return {
        "grade": (grade or "").strip(),
        "cls": (cls or "").strip(),
        "usernames": _split_csv_param(usernames),
        "types": _split_csv_param(types),
        "start": (start or "").strip(),
        "end": (end or "").strip(),
        "teacher": (teacher or "").strip(),
    }


def _summary_data(request: Request, filters: dict) -> dict:
    """执行汇总采集并套用导出行数上限 (E5 同口径)"""
    user = get_current_user(request)
    if user.get("role", 2) == 2:
        raise HTTPException(status_code=403, detail="权限不足")
    data = build_summary(user, **filters)
    _guard_row_count(len(data["records"]), "学生活动汇总明细")
    return data


def _s(v) -> str:
    """None → 空串, 其余转字符串 (Excel/CSV 单元格通用)"""
    return "" if v is None else str(v)


def _summary_sheet_rows(data: dict) -> dict[str, tuple[list[str], list[list[str]]]]:
    """把 build_summary 结果转成 4 张表的 (headers, rows), Excel/CSV 共用"""
    types: dict = data["types"]  # 保持注册表顺序
    tkeys = list(types.keys())

    # ── Sheet 1: 活动明细 ──
    h1 = ["年级", "班级", "学生姓名", "学号", "活动类型", "活动名称", "创建者",
          "得分", "满分", "得分率(%)", "状态", "时间"]
    r1 = [[
        rec["grade"], rec["class_name"], rec["student_name"], rec["username"],
        rec["type_label"], rec["activity_title"], rec["creator_name"],
        _s(rec["score"]), _s(rec["total_score"]), _s(rec["rate"]),
        rec["status"], rec["time"],
    ] for rec in data["records"]]

    # ── Sheet 2: 学生汇总 (学生 × 活动类型矩阵) ──
    h2 = ["年级", "班级", "学生姓名", "学号"]
    col_getters: list = []
    for k in tkeys:
        kind = types[k]["kind"]
        label = types[k]["label"]
        if kind == "score":
            h2 += [f"{label}·次数", f"{label}·平均得分率(%)", f"{label}·最高得分率(%)"]
            col_getters += [("count", k), ("avg", k), ("max", k)]
        elif kind == "participation":
            h2 += [f"{label}·参与次数"]
            col_getters.append(("count", k))
        else:  # points
            h2 += [f"{label}·总积分"]
            col_getters.append(("points", k))
    h2 += ["完成活动总数", "整体平均得分率(%)"]

    r2 = []
    for row in data["by_student"]:
        cells = [row["grade"], row["class_name"], row["name"], row["username"]]
        for mode, k in col_getters:
            cell = row["types"].get(k) or {}
            if mode == "count":
                cells.append(_s(cell.get("count") or ""))
            elif mode == "avg":
                cells.append(_s(cell.get("avg_rate")))
            elif mode == "max":
                cells.append(_s(cell.get("max_rate")))
            else:
                cells.append(_s(cell.get("points")))
        cells.append(_s(row["total_done"]))
        cells.append(_s(row["overall_avg_rate"]))
        r2.append(cells)

    # ── Sheet 3: 按活动汇总 ──
    h3 = ["活动类型", "活动ID", "活动名称", "创建者", "应参与人数", "实参与人数",
          "参与率(%)", "平均得分率(%)", "最高得分率(%)", "最低得分率(%)", "及格率(%)", "最后参与时间"]
    r3 = [[
        a["type_label"], _s(a["activity_id"]), a["activity_title"], a["creator_name"],
        _s(a["expected"]), _s(a["participants"]), _s(a["participation_rate"]),
        _s(a["avg_rate"]), _s(a["max_rate"]), _s(a["min_rate"]),
        _s(a["pass_rate"]), a["last_time"],
    ] for a in data["by_activity"]]

    # ── Sheet 4: 按班级汇总 ──
    h4 = ["年级", "班级", "学生人数"]
    for k in tkeys:
        kind = types[k]["kind"]
        label = types[k]["label"]
        if kind == "score":
            h4 += [f"{label}·完成次数", f"{label}·平均得分率(%)"]
        else:
            h4 += [f"{label}·次数"]
    h4 += ["完成活动总数", "整体平均得分率(%)", "课堂积分总计"]
    r4 = []
    for row in data["by_class"]:
        cells = [row["grade"], row["class_name"], _s(row["students"])]
        for k in tkeys:
            cell = row["types"].get(k) or {}
            cells.append(_s(cell.get("count") or ""))
            if types[k]["kind"] == "score":
                cells.append(_s(cell.get("avg_rate")))
        cells.append(_s(row["total_done"]))
        cells.append(_s(row["overall_avg_rate"]))
        cells.append(_s(row.get("points_total")))
        r4.append(cells)

    return {
        "活动明细": (h1, r1),
        "学生汇总": (h2, r2),
        "按活动汇总": (h3, r3),
        "按班级汇总": (h4, r4),
    }


_SHEET_KEYS = {"records": "活动明细", "student": "学生汇总",
               "activity": "按活动汇总", "class": "按班级汇总"}


def _summary_scope_label(filters: dict, data: dict) -> str:
    parts = []
    if filters.get("grade"):
        parts.append(filters["grade"])
    if filters.get("cls"):
        parts.append(filters["cls"])
    if filters.get("usernames"):
        parts.append(f"{len(filters['usernames'])}名学生")
    if not parts:
        parts.append(f"{len(data['population'])}名学生")
    return "_".join(parts)


# 管理员年级下拉只列"有真实使用"的年级: grades 表被 init_db 预置了小学到高中
# 12 个默认年级, 全量返回会让用不上的年级冒充可选项 (看起来像硬编码)。
# 以"有在籍学生"为唯一标准: classes 表可能存在历史残留的空白班级
# (建了班级壳但从未导入学生), 这类年级导出群体本为空集, 列入只会造成误导。
_USABLE_GRADES_WHERE = """EXISTS (SELECT 1 FROM users u WHERE u.role = 2
                               AND IFNULL(u.status,'active') = 'active' AND u.grade_id = g.id)"""


@router.get("/summary/meta", summary="汇总导出-可选范围(年级/类型/教师)")
def export_summary_meta(request: Request):
    """年级列表与活动类型 (管理员另有教师列表); 班级/学生改用
    /summary/classes 与 /summary/students 按年级、班级级联动态加载。
    管理员年级=有在籍学生的年级 (数据驱动, 预置空年级与无学生的残留班级年级不展示);
    教师年级=任教年级 (teacher_assignments 即真实数据)。"""
    user = get_current_user(request)
    role = user.get("role", 2)
    username = user["username"]
    if role == 2:
        raise HTTPException(status_code=403, detail="权限不足")

    if role == 0:
        grade_rows = execute_query(
            f"""SELECT g.name FROM grades g
                WHERE g.is_active = 1 AND ({_USABLE_GRADES_WHERE})
                ORDER BY g.sort_order, g.name""")
        names = [r[0] for r in grade_rows]
    else:
        names = [g["name"] for g in get_teacher_grades(username)]
    result: dict = {
        "is_admin": role == 0,
        "grades": names,
        "activity_types": [
            {"key": k, "label": v["label"], "kind": v["kind"]}
            for k, v in SUMMARY_TYPES.items()
        ],
    }
    if role == 0:
        result["teachers"] = [
            {"username": r[0], "name": r[1] or r[0]}
            for r in execute_query(
                "SELECT username, name FROM users WHERE role IN (0,1) "
                "AND IFNULL(status,'active')='active' ORDER BY username"
            )
        ]
    return result


SUMMARY_STUDENT_LIMIT = 2000


def _summary_resolve_scope(grade: str, cls: str) -> tuple[int | None, int | None]:
    """年级名/班级名 → (grade_id, class_id), 口径与 SummaryContext 筛选一致"""
    grade_id: int | None = None
    class_id: int | None = None
    gname = (grade or "").strip()
    cname = (cls or "").strip()
    if gname:
        ginfo = get_grade_by_name(gname)
        if not ginfo:
            raise HTTPException(status_code=400, detail=f"年级不存在: {gname}")
        grade_id = ginfo["id"]
    if cname:
        if grade_id is None:
            raise HTTPException(status_code=400, detail="筛选班级时必须同时指定年级")
        class_id = _resolve_class_id_flexible(grade_id, cname)
        if class_id is None:
            raise HTTPException(status_code=400, detail=f"班级不存在: {gname} {cname}")
    return grade_id, class_id


@router.get("/summary/classes", summary="汇总导出-班级列表(按年级动态加载)")
def export_summary_classes(request: Request, grade: str = Query(..., description="年级名称")):
    """指定年级下当前用户可见的班级: 管理员=全年级, 教师=任教班级"""
    user = get_current_user(request)
    if user.get("role", 2) == 2:
        raise HTTPException(status_code=403, detail="权限不足")
    gname = (grade or "").strip()
    ginfo = get_grade_by_name(gname)
    if not ginfo:
        raise HTTPException(status_code=400, detail=f"年级不存在: {gname}")
    rows = get_teacher_classes(user["username"], ginfo["id"])
    return {
        "grade": gname,
        "classes": [str(r.get("display_name") or r.get("name") or "") for r in rows],
    }


@router.get("/summary/students", summary="汇总导出-学生列表(按年级/班级动态加载)")
def export_summary_students(
    request: Request,
    grade: str = Query("", description="年级名称"),
    cls: str = Query("", description="班级显示名"),
):
    """指定年级/班级内当前用户可见的学生 (不传筛选=权限范围内全部, 有上限)"""
    user = get_current_user(request)
    if user.get("role", 2) == 2:
        raise HTTPException(status_code=403, detail="权限不足")
    grade_id, class_id = _summary_resolve_scope(grade, cls)
    pop = get_students_in_scope(user["username"], grade_id=grade_id, class_id=class_id)
    students = [
        {"username": s["username"], "name": s.get("name") or "",
         "grade": str(s.get("grade") or ""), "class_name": str(s.get("class") or "")}
        for s in pop[:SUMMARY_STUDENT_LIMIT]
    ]
    return {"total": len(pop), "truncated": len(pop) > len(students), "students": students}


@router.get("/summary/preview", summary="汇总导出-数据预览 (JSON)")
def export_summary_preview(
    request: Request,
    grade: str = Query("", description="年级名称"),
    cls: str = Query("", description="班级显示名"),
    usernames: str = Query("", description="指定学生学号, 逗号分隔"),
    types: str = Query("", description="活动类型 key, 逗号分隔, 空=全部"),
    start: str = Query("", description="开始日期 YYYY-MM-DD"),
    end: str = Query("", description="结束日期 YYYY-MM-DD"),
    teacher: str = Query("", description="管理员按指定教师口径导出"),
):
    filters = _summary_request_filters(grade, cls, usernames, types, start, end, teacher)
    data = _summary_data(request, filters)
    return {
        "types": data["types"],
        "population_size": len(data["population"]),
        "total_records": len(data["records"]),
        "preview_limit": SUMMARY_PREVIEW_LIMIT,
        "records": data["records"][:SUMMARY_PREVIEW_LIMIT],
        "by_student": data["by_student"],
        "by_activity": data["by_activity"],
        "by_class": data["by_class"],
    }


@router.get("/summary/excel", summary="汇总导出-多Sheet Excel")
def export_summary_excel(
    request: Request,
    grade: str = Query("", description="年级名称"),
    cls: str = Query("", description="班级显示名"),
    usernames: str = Query("", description="指定学生学号, 逗号分隔"),
    types: str = Query("", description="活动类型 key, 逗号分隔, 空=全部"),
    start: str = Query("", description="开始日期 YYYY-MM-DD"),
    end: str = Query("", description="结束日期 YYYY-MM-DD"),
    teacher: str = Query("", description="管理员按指定教师口径导出"),
):
    filters = _summary_request_filters(grade, cls, usernames, types, start, end, teacher)
    data = _summary_data(request, filters)
    sheets = _summary_sheet_rows(data)

    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    scope = _summary_scope_label(filters, data)
    period = ""
    if filters["start"] or filters["end"]:
        period = f"  ({filters['start'] or '…'} ~ {filters['end'] or '…'})"

    for name, (headers, rows) in sheets.items():
        ws = wb.create_sheet(_safe_sheet_name(name))
        ncol = max(len(headers), 1)
        ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=ncol)
        ws.cell(1, 1, f"学生活动汇总 - {scope}{period}").font = TITLE_FONT
        for i, h in enumerate(headers, 1):
            ws.cell(3, i, h)
        _style_header(ws, 3, len(headers))
        for ri, row in enumerate(rows):
            for ci, val in enumerate(row, 1):
                # 数字单元格写数值, 便于透视/公式
                if isinstance(val, str) and val != "" and re.fullmatch(r"-?\d+(\.\d+)?", val):
                    num = float(val)
                    ws.cell(4 + ri, ci, int(num) if num == int(num) else num)
                else:
                    ws.cell(4 + ri, ci, val)
        if rows:
            _style_cells(ws, 4, 3 + len(rows), len(headers))
        _auto_width(ws, len(headers))

    filename = f"学生活动汇总_{scope}_{datetime.now().strftime('%Y%m%d_%H%M')}.xlsx"
    return _excel_response(wb, filename)


@router.get("/summary/csv", summary="汇总导出-单表 CSV")
def export_summary_csv(
    request: Request,
    sheet: str = Query("records", description="records|student|activity|class"),
    grade: str = Query("", description="年级名称"),
    cls: str = Query("", description="班级显示名"),
    usernames: str = Query("", description="指定学生学号, 逗号分隔"),
    types: str = Query("", description="活动类型 key, 逗号分隔, 空=全部"),
    start: str = Query("", description="开始日期 YYYY-MM-DD"),
    end: str = Query("", description="结束日期 YYYY-MM-DD"),
    teacher: str = Query("", description="管理员按指定教师口径导出"),
):
    sheet_name = _SHEET_KEYS.get((sheet or "records").strip(), "活动明细")
    filters = _summary_request_filters(grade, cls, usernames, types, start, end, teacher)
    data = _summary_data(request, filters)
    headers, rows = _summary_sheet_rows(data)[sheet_name]
    scope = _summary_scope_label(filters, data)
    filename = f"学生活动汇总_{sheet_name}_{scope}.csv"
    return _csv_response(rows, headers, filename)