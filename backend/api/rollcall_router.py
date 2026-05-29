"""
智能点名 · 公平版 API 路由
"""
import json, os, random, time
import jwt as pyjwt
from fastapi import APIRouter, Request, HTTPException

from backend.config import BASE_DIR, ROOT_DIR, STU_DIR
from backend.api.dependencies import get_current_user
from backend.auth import is_admin
from backend.database import get_connection, execute_query
from backend.score_utils import teacher_score_key, load_teacher_scores, save_teacher_scores, load_students

router = APIRouter()


# ── 工具函数 ──

def _get_rollcall_teacher(request: Request, body: dict = None) -> str:
    """从请求中提取教师用户名"""
    teacher = request.query_params.get("teacher", "")
    if teacher:
        return teacher
    if body and body.get("teacher"):
        return body["teacher"]
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        try:
            payload = pyjwt.decode(auth[7:], options={"verify_signature": False})
            return payload.get("username", "root")
        except Exception:
            pass
    return "root"


def _rollcall_dir(teacher: str) -> str:
    """获取教师的点名数据目录（兼容旧代码）"""
    if teacher == ROOT_DIR:
        return os.path.join(BASE_DIR, ROOT_DIR, "html", "rollcall_data")
    return os.path.join(BASE_DIR, teacher, "html", "rollcall_data")


def _load_students(grade="高一"):
    """从数据库加载学生名单，按年级和班级筛选"""
    return load_students(grade)


def _load_scores(teacher="root"):
    return load_teacher_scores(teacher)


def _save_scores(scores, teacher="root"):
    save_teacher_scores(scores, teacher)


def _score_key(teacher, grade, cls, name):
    return teacher_score_key(teacher, grade, cls, name)


def _load_history(teacher, grade, cls):
    """从数据库加载点名状态"""
    with get_connection() as conn:
        c = conn.cursor()
        c.execute(
            "SELECT student_name, weight FROM rollcall_weights WHERE teacher_username=? AND grade=? AND class_name=?",
            (teacher, grade, cls),
        )
        weights = {row[0]: row[1] for row in c.fetchall()}
        c.execute(
            "SELECT last_time, picked_in_round FROM rollcall_meta WHERE teacher_username=? AND grade=? AND class_name=?",
            (teacher, grade, cls),
        )
        meta = c.fetchone()
        last_time = meta[0] if meta else None
        picked_in_round = json.loads(meta[1]) if meta and meta[1] else []
        c.execute(
            "SELECT student_name, created_at, result, points, teacher_username FROM rollcall_history WHERE teacher_username=? AND grade=? AND class_name=? ORDER BY id",
            (teacher, grade, cls),
        )
        history = [
            {"student": row[0], "time": row[1], "result": row[2], "points": row[3], "teacher": row[4]}
            for row in c.fetchall()
        ]
    return {
        "weights": weights,
        "history": history,
        "picked_in_round": picked_in_round,
        "last_time": last_time,
        "updated": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


def _save_history(teacher, grade, cls, data):
    """保存点名状态到数据库"""
    with get_connection() as conn:
        c = conn.cursor()
        c.execute(
            "DELETE FROM rollcall_weights WHERE teacher_username=? AND grade=? AND class_name=?",
            (teacher, grade, cls),
        )
        for sname, weight in data.get("weights", {}).items():
            c.execute(
                "INSERT INTO rollcall_weights (teacher_username, grade, class_name, student_name, weight) VALUES (?, ?, ?, ?, ?)",
                (teacher, grade, cls, sname, weight),
            )
        picked = json.dumps(data.get("picked_in_round", []), ensure_ascii=False)
        c.execute(
            "INSERT OR REPLACE INTO rollcall_meta (teacher_username, grade, class_name, last_time, picked_in_round, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
            (teacher, grade, cls, data.get("last_time"), picked),
        )
        c.execute(
            "DELETE FROM rollcall_history WHERE teacher_username=? AND grade=? AND class_name=?",
            (teacher, grade, cls),
        )
        for entry in data.get("history", []):
            c.execute(
                "INSERT INTO rollcall_history (teacher_username, grade, class_name, student_name, result, points, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (teacher, grade, cls, entry.get("student", ""), entry.get("result", ""), entry.get("points", 0), entry.get("time", "")),
            )
        conn.commit()
        data["updated"] = time.strftime("%Y-%m-%d %H:%M:%S")


def _weighted_pick(weights):
    """权重越高越可能被选到，最低保底权重1"""
    names = list(weights.keys())
    if not names:
        return None
    vals = [(n, max(1, weights[n])) for n in names]
    total = sum(w for _, w in vals)
    r = random.random() * total
    for name, w in vals:
        r -= w
        if r <= 0:
            return name
    return vals[-1][0]


def _apply_decay(weights, last_time):
    """权重自然恢复：每隔几分钟权重向10恢复"""
    if not last_time:
        return time.time()
    elapsed = (time.time() - last_time) / 60
    if elapsed >= 2:
        for s in weights:
            weights[s] = min(10, weights[s] + elapsed * 0.3)
        return time.time()
    return last_time


def _save_to_student_chat(student_name, cls, content):
    """将课堂记录写入学生个人的 ChatHistory 目录"""
    username = None
    try:
        rows = execute_query("SELECT username FROM users WHERE name=?", (student_name,))
        if rows:
            username = rows[0][0]
    except Exception:
        pass
    if not username:
        return None
    try:
        role_rows = execute_query("SELECT role FROM users WHERE username=?", (username,))
        if role_rows and role_rows[0][0] == 2:
            user_dir = os.path.join(BASE_DIR, STU_DIR, username)
        else:
            user_dir = os.path.join(BASE_DIR, username)
    except Exception:
        user_dir = os.path.join(BASE_DIR, username)
    os.makedirs(user_dir, exist_ok=True)
    chat_dir = os.path.join(user_dir, "ChatHistory")
    date_str = time.strftime("%Y-%m-%d")
    date_dir = os.path.join(chat_dir, date_str)
    os.makedirs(date_dir, exist_ok=True)
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    filepath = os.path.join(date_dir, f"课堂记录_{timestamp}.md")
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)
    return filepath


# ── API 处理器 ──

async def api_grades(request: Request):
    """从数据库获取有学生的年级列表"""
    try:
        rows = execute_query(
            "SELECT DISTINCT grade FROM users WHERE role=2 AND grade IS NOT NULL AND grade!='' ORDER BY grade"
        )
        return [row[0] for row in rows]
    except Exception:
        return ["高一", "高二"]


async def api_classes(request: Request):
    grade = request.query_params.get("grade", "")
    students = _load_students(grade)
    return sorted(set(s.get("class", "") for s in students if s.get("class")))


async def api_students(request: Request):
    teacher = _get_rollcall_teacher(request)
    grade = request.query_params.get("grade", "")
    cls = request.query_params.get("class", "")
    students = _load_students(grade)
    if cls:
        students = [s for s in students if s.get("class") == cls]
    scores = _load_scores(teacher)
    result = []
    for s in students:
        sk = _score_key(teacher, grade, s.get("class", ""), s["name"])
        result.append({
            "name": s["name"],
            "class": s.get("class", ""),
            "gender": s.get("gender", ""),
            "score": scores.get(sk, 0),
        })
    return result


async def api_pick(request: Request):
    body = await request.json()
    grade, cls = body.get("grade", ""), body.get("class", "")
    teacher = body.get("teacher") or _get_rollcall_teacher(request, body)
    if not grade or not cls:
        return {"error": "缺少年级/班级"}

    state = _load_history(teacher, grade, cls)
    students = _load_students(grade)
    names = [s["name"] for s in students if s.get("class") == cls]

    for n in names:
        state["weights"].setdefault(n, 10)

    state["last_time"] = _apply_decay(state["weights"], state.get("last_time"))
    picked_in_round = state.setdefault("picked_in_round", [])

    total_students = len(names)
    if total_students > 0 and len(picked_in_round) / total_students >= 0.6:
        picked_in_round.clear()

    available = {n: state["weights"][n] for n in names if n not in picked_in_round}
    if not available:
        picked_in_round.clear()
        available = {n: state["weights"][n] for n in names}

    picked = _weighted_pick(available)
    if not picked:
        return {"error": "没有学生"}

    state["weights"][picked] = max(1, state["weights"][picked] - 3)
    picked_in_round.append(picked)
    state["last_time"] = time.time()

    _save_history(teacher, grade, cls, state)

    covered = set(h.get("student") for h in state.get("history", []))
    return {
        "student": picked,
        "grade": grade,
        "class": cls,
        "teacher": teacher,
        "covered": len(covered),
        "total": len(names),
        "history_count": len(state.get("history", [])),
    }


async def api_mark(request: Request):
    body = await request.json()
    grade, cls = body.get("grade", ""), body.get("class", "")
    student = body.get("student", "")
    result = body.get("result", "skip")
    teacher = body.get("teacher") or _get_rollcall_teacher(request, body)
    noScore = body.get("noScore", False)
    customPoints = body.get("points")

    state = _load_history(teacher, grade, cls)
    points_added = 0

    if result == "correct":
        state["weights"][student] = min(10, state["weights"].get(student, 10) + 1)
        if not noScore:
            scores = _load_scores(teacher)
            sk = _score_key(teacher, grade, cls, student)
            add_pts = customPoints if customPoints is not None else 5
            scores[sk] = scores.get(sk, 0) + add_pts
            _save_scores(scores, teacher)
            points_added = add_pts
    elif result == "incorrect":
        if not noScore:
            scores = _load_scores(teacher)
            sk = _score_key(teacher, grade, cls, student)
            add_pts = customPoints if customPoints is not None else 2
            scores[sk] = scores.get(sk, 0) + add_pts
            _save_scores(scores, teacher)
            points_added = add_pts

    state.setdefault("history", []).append({
        "student": student,
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "result": result,
        "points": points_added,
        "teacher": teacher,
    })

    _save_history(teacher, grade, cls, state)

    scores = _load_scores(teacher)
    sk = _score_key(teacher, grade, cls, student)
    return {
        "success": True,
        "student": student,
        "result": result,
        "points_added": points_added,
        "total_score": scores.get(sk, 0),
        "history_count": len(state["history"]),
        "teacher": teacher,
    }


async def api_history(request: Request):
    teacher = _get_rollcall_teacher(request)
    grade = request.query_params.get("grade", "")
    cls = request.query_params.get("class", "")
    state = _load_history(teacher, grade, cls)
    students = _load_students(grade)
    names = [s["name"] for s in students if s.get("class") == cls]
    covered = set(h.get("student") for h in state.get("history", []))
    correct_count = sum(1 for h in state.get("history", []) if h.get("result") == "correct")
    return {
        "history": state.get("history", []),
        "weights": state.get("weights", {}),
        "covered": len(covered),
        "total": len(names),
        "correct_count": correct_count,
        "updated": state.get("updated", ""),
        "teacher": teacher,
    }


async def api_reset(request: Request):
    body = await request.json()
    grade, cls = body.get("grade", ""), body.get("class", "")
    teacher = body.get("teacher") or _get_rollcall_teacher(request, body)
    students = _load_students(grade)
    names = [s["name"] for s in students if s.get("class") == cls]
    state = {
        "weights": {n: 10 for n in names},
        "history": [],
        "picked_in_round": [],
        "last_time": time.time(),
    }
    _save_history(teacher, grade, cls, state)
    return {"success": True, "total": len(names), "teacher": teacher}


async def api_save_record(request: Request):
    body = await request.json()
    grade = body.get("grade", "")
    cls = body.get("class", "")
    student = body.get("student", "")
    rec_type = body.get("type", "课堂互动")
    title = body.get("title", "")
    correct_count = body.get("correctCount", 0)
    total = body.get("totalQuestions", 0)
    points = body.get("points", 0)
    answers = body.get("answers", [])
    lines = [f"## 🎯 课堂答题记录\n"]
    lines.append(f"**时间**: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"**班级**: {grade} · {cls}")
    if title:
        lines.append(f"**课程**: {title}")
    lines.append(f"**类型**: {rec_type}")
    lines.append("\n---\n")
    lines.append("### 📊 答题概况\n")
    lines.append(f"**学生**: {student}")
    if total > 0:
        ratio = f"{correct_count}/{total}"
        emoji = "✅" if correct_count == total else "⚠️"
        lines.append(f"**结果**: {emoji} 答对 {ratio} 题 · 获得 +{points} 积分")
    else:
        lines.append(f"**结果**: {'✅ 答对' if points > 0 else '💬 参与'} · 获得 +{points} 积分")
    if answers:
        lines.append("\n---\n")
        lines.append("### 📋 题目详情\n")
        labels = ["A", "B", "C", "D"]
        for i, a in enumerate(answers):
            icon = "✅" if a.get("isCorrect") else "❌"
            lines.append(f"**第 {i+1} 题** {icon} {'答对' if a.get('isCorrect') else '答错'}")
            lines.append(f"> {a.get('question', '')}")
            opts = a.get("options", [])
            your_ans = a.get("yourAnswer", -1)
            correct_ans = a.get("correctAnswer", -1)
            opt_list = []
            if isinstance(opts, dict):
                opt_list = [opts.get(l, "") for l in labels]
            elif isinstance(opts, (list, tuple)):
                opt_list = list(opts)
            if isinstance(your_ans, str) and your_ans in labels:
                your_ans = labels.index(your_ans)
            if isinstance(correct_ans, str) and correct_ans in labels:
                correct_ans = labels.index(correct_ans)
            for j, opt in enumerate(opt_list):
                marker = ""
                if j == your_ans and j == correct_ans:
                    marker = " ← **你的答案** ✅"
                elif j == your_ans:
                    marker = " ← **你的答案**"
                elif j == correct_ans:
                    marker = " ← **正确答案** ✅"
                lines.append(f"- {labels[j]}. {opt}{marker}")
            if a.get("principle"):
                lines.append(f"知识点：{a['principle']}")
            lines.append("")
    lines.append("\n---\n")
    lines.append("*由 SmartKB 自动记录*")
    _save_to_student_chat(student, cls, "\n".join(lines))
    return {"success": True}


# ── 路由注册 ──

router.get("/grades", summary="获取年级列表")(api_grades)
router.get("/classes", summary="获取班级列表")(api_classes)
router.get("/students", summary="获取学生列表（含积分）")(api_students)
router.post("/pick", summary="公平点名选取")(api_pick)
router.post("/mark", summary="标记点名结果")(api_mark)
router.get("/history", summary="获取点名历史")(api_history)
router.post("/reset", summary="重置点名数据")(api_reset)
router.post("/save-record", summary="保存答题记录到 ChatHistory")(api_save_record)


# ── 管理员总览、教师查看自己的班级 ──


@router.get("/admin/sessions", summary="获取点名会话列表")
async def admin_list_sessions(request: Request):
    """管理员查看所有班级，教师只查看自己的"""
    user = get_current_user(request)
    username = user["username"]

    if is_admin(username):
        rows = execute_query(
            """SELECT rw.teacher_username, rw.grade, rw.class_name,
                      COUNT(DISTINCT rw.student_name) as student_count,
                      COUNT( rh.id) as history_count
               FROM rollcall_weights rw
               LEFT JOIN rollcall_history rh ON rh.teacher_username=rw.teacher_username
                   AND rh.grade=rw.grade AND rh.class_name=rw.class_name
               GROUP BY rw.teacher_username, rw.grade, rw.class_name
               ORDER BY rw.teacher_username, rw.grade, rw.class_name"""
        )
    else:
        rows = execute_query(
            """SELECT rw.teacher_username, rw.grade, rw.class_name,
                      COUNT(DISTINCT rw.student_name) as student_count,
                      COUNT(rh.id) as history_count
               FROM rollcall_weights rw
               LEFT JOIN rollcall_history rh ON rh.teacher_username=rw.teacher_username
                   AND rh.grade=rw.grade AND rh.class_name=rw.class_name
               WHERE rw.teacher_username=?
               GROUP BY rw.teacher_username, rw.grade, rw.class_name
               ORDER BY rw.grade, rw.class_name""",
            (username,),
        )

    return {
        "sessions": [
            {
                "teacher": r[0],
                "grade": r[1],
                "class": r[2],
                "student_count": r[3],
                "history_count": r[4],
            }
            for r in rows
        ],
        "total": len(rows),
    }


@router.get("/admin/detail", summary="查看点名会话详情")
async def admin_session_detail(request: Request):
    """管理员可查看任意班级，教师只能查看自己的"""
    user = get_current_user(request)
    username = user["username"]
    teacher = request.query_params.get("teacher", username)
    grade = request.query_params.get("grade", "")
    cls = request.query_params.get("class", "")

    if not grade or not cls:
        raise HTTPException(status_code=400, detail="缺少 grade/class 参数")

    if not is_admin(username) and teacher != username:
        raise HTTPException(status_code=403, detail="只能查看自己的班级")

    state = _load_history(teacher, grade, cls)
    return {
        "teacher": teacher,
        "grade": grade,
        "class": cls,
        "weights": state.get("weights", {}),
        "history": state.get("history", []),
        "picked_in_round": state.get("picked_in_round", []),
        "last_time": state.get("last_time"),
        "updated": state.get("updated", ""),
        "student_count": len(state.get("weights", {})),
        "history_count": len(state.get("history", [])),
    }


@router.post("/admin/reset", summary="重置点名会话")
async def admin_reset_session(request: Request):
    """管理员可重置任意班级，教师只能重置自己的"""
    user = get_current_user(request)
    username = user["username"]
    body = await request.json()
    teacher = body.get("teacher", username)
    grade = body.get("grade", "")
    cls = body.get("class", "")

    if not grade or not cls:
        raise HTTPException(status_code=400, detail="缺少 grade/class 参数")

    if not is_admin(username) and teacher != username:
        raise HTTPException(status_code=403, detail="只能重置自己的班级")

    students = _load_students(grade)
    names = [s["name"] for s in students if s.get("class") == cls]
    state = {
        "weights": {n: 10 for n in names},
        "history": [],
        "picked_in_round": [],
        "last_time": time.time(),
    }
    _save_history(teacher, grade, cls, state)

    return {"success": True, "total": len(names), "teacher": teacher}
