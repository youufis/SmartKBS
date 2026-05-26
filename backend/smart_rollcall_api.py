"""
智能点名 · 公平版 — 后端 API
提供：年级/班级列表、学生数据、公平点名算法、历史记录（服务端持久化）
积分存储与 score_system.py 保持一致（按教师目录存储）
学生数据全部从数据库 users.db 加载
"""
import json, os, random, time
from fastapi import Request

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "root", "html")

# 与 score_system.py 共享积分存储逻辑
from backend.score_system import (
    _load_teacher_scores,
    _save_teacher_scores,
    _teacher_score_key,
)


# ── 教师身份提取（支持 query 参数和 POST body）──

def _get_rollcall_teacher(request: Request, body: dict = None) -> str:
    """从请求中提取教师用户名"""
    # 优先从 query 参数获取
    teacher = request.query_params.get("teacher", "")
    if teacher:
        return teacher
    # 从 POST body 获取
    if body and body.get("teacher"):
        return body["teacher"]
    # 从 JWT 获取
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        try:
            import jwt as pyjwt
            payload = pyjwt.decode(auth[7:], options={"verify_signature": False})
            return payload.get("username", "root")
        except Exception:
            pass
    return "root"


def _rollcall_dir(teacher: str) -> str:
    """获取教师的点名数据目录"""
    if teacher == "root":
        d = os.path.join(BASE_DIR, "root", "html", "rollcall_data")
    else:
        d = os.path.join(BASE_DIR, teacher, "html", "rollcall_data")
    os.makedirs(d, exist_ok=True)
    return d

# ── 工具函数 ──

def _load_students(grade="高一"):
    """从数据库加载学生名单，按年级和班级筛选"""
    import sqlite3
    db_path = os.path.join(BASE_DIR, "backend", "users.db")
    students = []
    try:
        conn = sqlite3.connect(db_path)
        c = conn.cursor()
        c.execute("SELECT name, class, gender FROM users WHERE role=2 AND grade=? AND name IS NOT NULL AND name!=''",
                   (grade,))
        seen, class_map = set(), {}
        for name, cls_num, gval in c.fetchall():
            if name in seen:
                continue
            seen.add(name)
            cls_str = str(cls_num or "")
            cls_key = f"{grade}{cls_str}班" if cls_str else f"{grade}班"
            class_map.setdefault(cls_key, []).append({
                "class": cls_key, "name": name,
                "gender": "男" if gval in (1, "1", "男") else "女" if gval in (2, "0", "女", 0) else "",
                "language": "", "subjects": "", "major": "",
            })
        conn.close()
        for cls_name in sorted(class_map.keys()):
            students.extend(class_map[cls_name])
        if students:
            return students
    except Exception:
        pass
    return []

def _load_scores(teacher="root"):
    """使用 score_system 的统一积分存储，自动迁移旧数据"""
    scores = _load_teacher_scores(teacher)
    if scores:
        return scores

    # 迁移旧版 scores.json（单文件，key 格式 {grade}|{cls}|{name}）
    old_path = os.path.join(DATA_DIR, "score_system", "scores.json")
    if os.path.exists(old_path):
        try:
            with open(old_path, "r", encoding="utf-8") as f:
                old_scores = json.load(f)
            if old_scores:
                new_scores = {}
                for key, val in old_scores.items():
                    parts = key.split("|")
                    if len(parts) == 3:
                        new_key = _teacher_score_key(teacher, parts[0], parts[1], parts[2])
                        new_scores[new_key] = val
                    else:
                        new_scores[key] = val
                _save_teacher_scores(new_scores, teacher)
                return new_scores
        except Exception:
            pass
    return {}

def _save_scores(scores, teacher="root"):
    _save_teacher_scores(scores, teacher)

def _score_key(teacher, grade, cls, name):
    return _teacher_score_key(teacher, grade, cls, name)

def _history_file(teacher, grade, cls):
    safe = f"{grade}_{cls}".replace(" ", "_")
    return os.path.join(_rollcall_dir(teacher), f"{safe}.json")

def _load_history(teacher, grade, cls):
    path = _history_file(teacher, grade, cls)
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"weights": {}, "history": [], "updated": ""}

def _save_history(teacher, grade, cls, data):
    data["updated"] = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(_history_file(teacher, grade, cls), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

# ── API: 年级列表 ──

async def api_grades(request: Request):
    """从数据库获取有学生的年级列表"""
    import sqlite3
    try:
        conn = sqlite3.connect(os.path.join(BASE_DIR, "backend", "users.db"))
        c = conn.cursor()
        c.execute("SELECT DISTINCT grade FROM users WHERE role=2 AND grade IS NOT NULL AND grade!='' ORDER BY grade")
        grades = [row[0] for row in c.fetchall()]
        conn.close()
        return grades
    except Exception:
        return ["高一", "高二"]

# ── API: 班级列表 ──

async def api_classes(request: Request):
    grade = request.query_params.get("grade", "")
    students = _load_students(grade)
    return sorted(set(s.get("class", "") for s in students if s.get("class")))

# ── API: 学生列表（含积分） ──

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

# ── 公平算法：加权随机选取 ──

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
    elapsed = (time.time() - last_time) / 60  # 分钟
    if elapsed >= 2:
        for s in weights:
            weights[s] = min(10, weights[s] + elapsed * 0.3)
        return time.time()
    return last_time

# ── API: 点名选取 ──

async def api_pick(request: Request):
    body = await request.json()
    grade, cls = body.get("grade", ""), body.get("class", "")
    teacher = body.get("teacher") or _get_rollcall_teacher(request, body)
    if not grade or not cls:
        return {"error": "缺少年级/班级"}

    state = _load_history(teacher, grade, cls)
    students = _load_students(grade)
    names = [s["name"] for s in students if s.get("class") == cls]

    # 确保每个学生有权重
    for n in names:
        state["weights"].setdefault(n, 10)

    # 权重自然恢复
    state["last_time"] = _apply_decay(state["weights"], state.get("last_time"))

    # 公平轮询：维护本轮已抽到的学生
    picked_in_round = state.setdefault("picked_in_round", [])

    # 如果本轮覆盖率达到60%或全部抽完，自动重置轮次
    total_students = len(names)
    if total_students > 0 and len(picked_in_round) / total_students >= 0.6:
        picked_in_round.clear()

    # 从未在本轮抽到的学生中，按权重选择
    available = {n: state["weights"][n] for n in names if n not in picked_in_round}
    if not available:
        # 兜底：如果所有都抽到了，重置
        picked_in_round.clear()
        available = {n: state["weights"][n] for n in names}

    picked = _weighted_pick(available)
    if not picked:
        return {"error": "没有学生"}

    # 被点到：权重-3，加入本轮已抽到
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

# ── API: 标记结果 ──

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
        "time": time.strftime("%H:%M:%S"),
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

# ── API: 获取历史记录 + 覆盖统计 ──

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

# ── API: 重置 ──

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

# ── 工具：写入学生个人 ChatHistory ──

def _save_to_student_chat(student_name, cls, content):
    """将课堂记录写入学生个人的 ChatHistory 目录"""
    base_dir = os.path.dirname(os.path.abspath(__file__))
    db_path = os.path.join(base_dir, "users.db")
    username = None
    if os.path.exists(db_path):
        import sqlite3
        try:
            conn = sqlite3.connect(db_path)
            c = conn.cursor()
            # 只用姓名查找（班级可能不一致）
            c.execute("SELECT username FROM users WHERE name=?", (student_name,))
            results = c.fetchall()
            conn.close()
            if results:
                username = results[0][0]
        except Exception:
            pass
    if not username:
        return None
    # 根据用户角色决定工作目录：学生(普通用户)在 stu/ 下，教师和管理员在根目录
    try:
        conn = sqlite3.connect(db_path)
        c = conn.cursor()
        c.execute("SELECT role FROM users WHERE username=?", (username,))
        role_row = c.fetchone()
        conn.close()
        if role_row and role_row[0] == 2:  # 普通用户（学生）
            user_dir = os.path.join(base_dir, "stu", username)
        else:
            user_dir = os.path.join(base_dir, username)
    except Exception:
        user_dir = os.path.join(base_dir, username)
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


# ── API: 保存详细答题记录到学生 ChatHistory ──

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
            # 兼容 options 为对象 {A:..., B:...} 或数组
            opt_list = []
            if isinstance(opts, dict):
                opt_list = [opts.get(l, "") for l in labels]
            elif isinstance(opts, (list, tuple)):
                opt_list = list(opts)
            # 兼容 yourAnswer/correctAnswer 为字母或数字
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


# ── 挂载 ──

def mount_rollcall_api(app):
    app.get("/rollcall-api/grades")(api_grades)
    app.get("/rollcall-api/classes")(api_classes)
    app.get("/rollcall-api/students")(api_students)
    app.post("/rollcall-api/pick")(api_pick)
    app.post("/rollcall-api/mark")(api_mark)
    app.get("/rollcall-api/history")(api_history)
    app.post("/rollcall-api/reset")(api_reset)
    app.post("/rollcall-api/save-record")(api_save_record)