"""
智能点名 · 公平版 API 路由
"""
import json, os, random, re, time
from typing import Any

from fastapi import APIRouter, Request, HTTPException

from backend.config import DATA_DIR, ROOT_DIR, STU_DIR
from backend.api.dependencies import get_current_user
from backend.auth import ROLE_ADMIN, ROLE_TEACHER, ROLE_STUDENT, is_admin, get_online_usernames
from backend.database import get_connection, execute_query, execute_query_dict, execute_insert_update
from backend.logger import logger
from backend.score_utils import teacher_score_key, load_teacher_scores, save_teacher_scores, load_students
from backend.permission_service import (
    get_teacher_grades,
    get_teacher_classes,
    get_grade_by_name,
    parse_legacy_teacher_grade_class,
)

router = APIRouter()


# ── 工具函数 ──

def _get_rollcall_teacher(request: Request, user: dict[str, Any] | None = None,
                          body: dict[str, Any] | None = None) -> str:
    """R2: 点名数据的归属一律以"登录身份"为准

    - 管理员可用 ?teacher= 或 body.teacher 指名查看/操作某位教师的点名册;
    - 其他角色忽略客户端传入的 teacher, 强制使用本人用户名。
      (前端点名页本来就只传自己的用户名, 因此正常操作行为不变, 只是不再可伪造)
    旧实现允许 ?teacher=<任意用户名> 切换归属, 且未登录时回退成 "root"。
    """
    if user is not None and user.get("role") == ROLE_ADMIN:
        requested = (request.query_params.get("teacher") or (body or {}).get("teacher") or "").strip()
        if requested:
            return requested
    return (user or {}).get("username") or "root"


def _load_students(grade: str = ""):
    """从数据库加载学生名单，按年级和班级筛选"""
    return load_students(grade)


def _load_scores(teacher="root"):
    return load_teacher_scores(teacher)


def _save_scores(scores, teacher="root"):
    save_teacher_scores(scores, teacher)


def _score_key(teacher, grade, cls, name):
    return teacher_score_key(teacher, grade, cls, name)


def _is_teacher_allowed(username: str, grade: str, cls: str) -> bool:
    """检查教师是否有权限访问该年级/班级（严格走统一权限 permission_service）"""
    # 兼容 int 型班级（users.class 存在 1 这类数字），避免 .replace 抛 AttributeError
    grade = str(grade or "").strip()
    cls = str(cls or "").strip()
    # R4: 年级/班级都拿不到时一律拒绝(旧实现默认放行, 导致教师可翻查
    # 任意"年级字段为空"的账号(含管理员/同事)的登录日志与考勤明细)
    if not grade and not cls:
        return False
    if is_admin(username):
        return True

    from backend.permission_service import can_access_grade, can_access_class, get_grade_by_name

    grade_info = get_grade_by_name(grade)
    if not grade_info:
        return False

    # 必须通过年级权限检查（无降级）
    if not can_access_grade(username, grade_info["id"]):
        return False

    # 未指定班级时，有年级权限即通过
    if not cls:
        return True

    # 通过 classes 表查找班级名
    class_rows = execute_query_dict(
        "SELECT id FROM classes WHERE grade_id=? AND (name LIKE ? OR display_name LIKE ?)",
        (grade_info["id"], f"%{cls.replace('班', '')}%", f"%{cls.replace('班', '')}%")
    )
    if not class_rows:
        return False

    return can_access_class(username, grade_info["id"], class_rows[0]["id"])


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
    try:
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
                "INSERT OR REPLACE INTO rollcall_meta (teacher_username, grade, class_name, last_time, picked_in_round, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))",
                (teacher, grade, cls, data.get("last_time"), picked),
            )
            c.execute(
                "DELETE FROM rollcall_history WHERE teacher_username=? AND grade=? AND class_name=?",
                (teacher, grade, cls),
            )
            for entry in data.get("history", []):
                raw_time = entry.get("time", "")
                if raw_time and len(raw_time) <= 10 and ":" in raw_time:
                    if data.get("last_time"):
                        base_date = time.strftime("%Y-%m-%d", time.localtime(data["last_time"]))
                    else:
                        base_date = time.strftime("%Y-%m-%d")
                    full_time = f"{base_date} {raw_time}"
                else:
                    full_time = raw_time if raw_time else time.strftime("%Y-%m-%d %H:%M:%S")
                c.execute(
                    "INSERT INTO rollcall_history (teacher_username, grade, class_name, student_name, result, points, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (teacher, grade, cls, entry.get("student", ""), entry.get("result", ""), entry.get("points", 0), full_time),
                )
            conn.commit()
            data["updated"] = time.strftime("%Y-%m-%d %H:%M:%S")
    except Exception as e:
        logger.error(f"保存点名状态失败: {e}")
        raise
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
    """权重自然恢复：每隔几分钟权重向10恢复，同时更新 last_time 确保持久化"""
    if not last_time:
        return time.time()
    elapsed = (time.time() - last_time) / 60
    if elapsed >= 2:
        for s in weights:
            weights[s] = min(10, weights[s] + elapsed * 0.3)
        last_time = time.time()
    return last_time


def _save_to_student_chat(student_name, cls, content, grade="", actor="", actor_is_admin=False):
    """将课堂记录写入学生个人的 ChatHistory 目录

    R7: 旧实现只按姓名匹配学生且忽略班级, 重名时会把记录写进别人的目录;
    现按 姓名 + 年级 + 班级 共同定位, 并把范围限制在操作教师的任教班级内。
    """
    username = None
    try:
        rows = execute_query(
            "SELECT username, grade_id, class_id FROM users WHERE role=2 AND name=?",
            (student_name,),
        )
    except Exception as e:
        logger.warning(f"点名-查找学生用户名失败 (name={student_name}): {e}")
        return None
    if not rows:
        return None
    cnum = re.sub(r"[^\d]", "", str(cls or "")) if cls else ""
    cands = []
    for r in rows:
        if len(rows) > 1 and cnum:
            crow = execute_query("SELECT display_name FROM classes WHERE id=?", (r[2],))
            cname = str(crow[0][0]) if crow and crow[0][0] else ""
            if cnum not in re.sub(r"[^\d]", "", cname):
                continue
        cands.append(r[0])
    if len(cands) != 1:
        # 无法唯一定位时不写, 避免把记录写进同名他人的目录
        logger.warning(f"课堂记录未定位到唯一学生: name={student_name} 候选={cands}")
        return None
    username = cands[0]
    if not actor_is_admin:
        from backend.permission_service import check_teacher_access_to_student
        if not check_teacher_access_to_student(actor, username):
            logger.warning(f"课堂记录越权写入被拒绝: actor={actor} student={username}")
            return None
    # 安全校验：只允许字母数字下划线
    import re as _re
    if not _re.match(r'^\w+$', username):
        logger.warning(f"非法用户名，跳过写入 ChatHistory: {username}")
        return None
    try:
        role_rows = execute_query("SELECT role FROM users WHERE username=?", (username,))
        if role_rows and role_rows[0][0] == 2:
            user_dir = os.path.join(DATA_DIR, STU_DIR, username)
        else:
            user_dir = os.path.join(DATA_DIR, username)
    except Exception:
        user_dir = os.path.join(DATA_DIR, username)
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
    """获取年级列表 - 只返回有实际学生的年级"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role == ROLE_ADMIN:
        # 管理员：仅返回有学生数据的年级（通过 grade_id 关联 grades 表）
        rows = execute_query_dict(
            """SELECT DISTINCT g.name
               FROM users u
               JOIN grades g ON u.grade_id = g.id
               WHERE u.role=2 AND g.is_active=1
               ORDER BY g.sort_order"""
        )
        if rows:
            return [r["name"] for r in rows]
        # 降级：从 users 表旧字段获取
        old_rows = execute_query(
            "SELECT DISTINCT grade FROM users WHERE role=2 AND grade IS NOT NULL AND grade!='' ORDER BY grade"
        )
        return [row[0] for row in old_rows]
    # 教师：从 teacher_assignments → grades 表获取任教年级
    grades = get_teacher_grades(user["username"])
    if grades:
        return [g["name"] for g in grades]
    # 降级：如果教师未配置任教记录，从有学生数据的年级中获取
    rows = execute_query(
        "SELECT DISTINCT grade FROM users WHERE role=2 AND grade IS NOT NULL AND grade!='' ORDER BY grade"
    )
    return [row[0] for row in rows]


async def api_classes(request: Request):
    """获取班级列表 - 统一使用 classes 表，与 permission_service 同源"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    grade = request.query_params.get("grade", "")
    if not grade:
        return []

    # 统一通过 grades 表解析 grade_id
    grade_info = get_grade_by_name(grade)

    if role == ROLE_ADMIN:
        # 管理员：仅返回该年级有学生数据的班级（通过 class_id 关联 classes 表）
        if grade_info:
            rows = execute_query_dict(
                """SELECT DISTINCT c.display_name, c.sort_order
                   FROM users u
                   JOIN classes c ON u.class_id = c.id
                   WHERE u.role=2 AND u.grade_id=? AND c.grade_id=?
                   ORDER BY c.sort_order""",
                (grade_info["id"], grade_info["id"]),
            )
            if rows:
                return [r["display_name"] for r in rows]
        # 降级：从 users 表旧字段获取
        students = _load_students(grade)
        return sorted(set(s.get("class", "") for s in students if s.get("class")))

    # 教师：从 teacher_assignments → classes 表获取任教班级
    if grade_info:
        classes = get_teacher_classes(username, grade_info["id"])
        if classes:
            return [c["display_name"] for c in classes]
        # 新表无数据，降级查旧格式
        students = _load_students(grade)
        return sorted(set(s.get("class", "") for s in students if s.get("class")))

    # 降级：旧格式（users 表的 grade/class 字段，管道符分隔）
    t_rows = execute_query(
        "SELECT grade, class FROM users WHERE username=?", (username,)
    )
    if not t_rows:
        return []
    t_grade = (t_rows[0][0] or "").strip()
    t_class = str(t_rows[0][1] or "").strip()
    if not t_grade:
        students = _load_students(grade)
        return sorted(set(s.get("class", "") for s in students if s.get("class")))
    gcm = parse_legacy_teacher_grade_class(t_grade, t_class)
    if grade in gcm:
        allowed = gcm[grade]
        if allowed:
            return [f"{grade}{c}班" for c in allowed]
    students = _load_students(grade)
    return sorted(set(s.get("class", "") for s in students if s.get("class")))


async def api_students(request: Request):
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    teacher = _get_rollcall_teacher(request, user)
    grade = request.query_params.get("grade", "")
    cls = request.query_params.get("class", "")

    # 教师只能查看自己任教班级的学生
    if role != ROLE_ADMIN:
        if not _is_teacher_allowed(username, grade, cls):
            return []

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
    user = get_current_user(request)          # R1: 点名操作必须登录
    body = await request.json()
    grade, cls = _normalize_grade_class(body.get("grade", ""), body.get("class", ""))   # R11
    teacher = _get_rollcall_teacher(request, user, body)   # R2: 归属以登录身份为准
    if not grade or not cls:
        return {"error": "缺少年级/班级"}

    # 教师只能操作自己班级的点名
    if user.get("role") != ROLE_ADMIN and not _is_teacher_allowed(user["username"], grade, cls):
        return {"error": "无权操作该班级"}

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
    user = get_current_user(request)          # R1: 旧实现完全匿名, 任何人可给任意学生加分
    body = await request.json()
    grade, cls = _normalize_grade_class(body.get("grade", ""), body.get("class", ""))   # R11
    student = str(body.get("student", "")).strip()
    result = body.get("result", "skip")
    teacher = _get_rollcall_teacher(request, user, body)   # R2
    noScore = body.get("noScore", False)
    customPoints = body.get("points")
    if user.get("role") != ROLE_ADMIN and not _is_teacher_allowed(user["username"], grade, cls):
        raise HTTPException(status_code=403, detail="无权操作该班级的点名")
    if customPoints is not None:
        try:
            customPoints = max(-100, min(100, int(customPoints)))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="积分需为整数")

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

    # ── 积分奖励（参与点名） ──
    try:
        if result in ("correct", "incorrect"):
            from backend.reward_engine import award_participation
            # 从 "高一1班" 提取纯数字班级号
            import re
            cls_num = re.sub(r'[^\d]', '', str(cls)) if cls else ""
            student_user = execute_query(
                "SELECT username FROM users WHERE role=2 AND name=? AND grade=? AND (class=? OR class=?)",
                (student, grade, cls_num, f"{cls_num}班"),
            )
            if student_user:
                award_participation(student_user[0][0], "rollcall", f"{grade}_{cls}_{student}", f"点名-{student}")
    except Exception as e:
        logger.warning(f"点名积分奖励发放失败 (student={student}): {e}")

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
    user = get_current_user(request)      # R1
    teacher = _get_rollcall_teacher(request, user)
    grade = request.query_params.get("grade", "")
    cls = request.query_params.get("class", "")
    grade, cls = _normalize_grade_class(grade, cls)   # R11
    # R2: 非管理员只能读自己任教班级
    if user.get("role") != ROLE_ADMIN and not _is_teacher_allowed(user["username"], grade, cls):
        raise HTTPException(status_code=403, detail="无权查看该班级点名记录")
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
    """重置点名数据(需登录; 教师仅限自己任教班级)"""
    user = get_current_user(request)
    body = await request.json()
    grade, cls = _normalize_grade_class(body.get("grade", ""), body.get("class", ""))   # R11
    teacher = _get_rollcall_teacher(request, user, body)
    if not grade or not cls:
        raise HTTPException(status_code=400, detail="缺少 grade/class 参数")
    if user.get("role") != ROLE_ADMIN and not _is_teacher_allowed(user["username"], grade, cls):
        raise HTTPException(status_code=403, detail="无权重置该班级的点名数据")
    total = _reset_rollcall(teacher, grade, cls)
    return {"success": True, "total": total, "teacher": teacher}


async def api_save_record(request: Request):
    user = get_current_user(request)      # R1: 旧实现匿名, 可向任意学生目录写文件
    body = await request.json()
    grade = body.get("grade", "")
    cls = body.get("class", "")
    student = str(body.get("student", "")).strip()
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
    content = "\n".join(lines)
    if len(content) > 60_000:
        raise HTTPException(status_code=400, detail="课堂记录内容过长")
    path = _save_to_student_chat(student, cls, content, grade=grade, actor=user["username"],
                                actor_is_admin=user.get("role") == ROLE_ADMIN)
    if not path:
        logger.warning(f"课堂记录未写入: student={student} class={cls} by={user['username']}")
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
                      COUNT(DISTINCT rh.id) as history_count
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
                      COUNT(DISTINCT rh.id) as history_count
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
    grade, cls = _normalize_grade_class(grade, cls)   # R11

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

    total = _reset_rollcall(teacher, grade, cls)
    return {"success": True, "total": total, "teacher": teacher}


# ═══════════════════════════════════════════════════════════
# 考勤统计 API（v4.3）
# ═══════════════════════════════════════════════════════════


@router.get("/attendance/grades", summary="获取考勤年级列表")
async def attendance_grades(request: Request):
    """获取年级列表（考勤统计用）- 管理员全部，教师只看到自己的"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role == 0:
        rows = execute_query(
            "SELECT DISTINCT grade FROM users WHERE role=2 AND grade IS NOT NULL AND grade!='' ORDER BY grade"
        )
        return [row[0] for row in rows]
    else:
        from backend.permission_service import get_teacher_grades
        grades = get_teacher_grades(username)
        return [g["name"] for g in grades]


@router.get("/attendance/classes", summary="获取考勤班级列表")
async def attendance_classes(request: Request):
    """获取班级列表（考勤统计用）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    grade = request.query_params.get("grade", "")

    if not grade:
        return []

    if role == 0:
        students = _load_students(grade)
        return sorted(set(s.get("class", "") for s in students if s.get("class")))
    else:
        if not _is_teacher_allowed(username, grade, ""):
            return []
        from backend.permission_service import get_teacher_classes, get_grade_by_name
        grade_info = get_grade_by_name(grade)
        if grade_info:
            classes = get_teacher_classes(username, grade_info["id"])
            if classes:
                return [c["display_name"] for c in classes]
        students = _load_students(grade)
        return sorted(set(s.get("class", "") for s in students if s.get("class")))


@router.get("/attendance/summary", summary="考勤统计概览（按班级）")
async def attendance_summary(request: Request):
    """获取考勤统计概览：总人数、已登录人数、登录率"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    grade = request.query_params.get("grade", "")
    cls = request.query_params.get("class", "")

    if not grade or not cls:
        raise HTTPException(status_code=400, detail="缺少 grade/class 参数")

    # 权限检查
    if role != 0 and not _is_teacher_allowed(username, grade, cls):
        raise HTTPException(status_code=403, detail="无权查看该班级考勤")

    # 获取该班级所有学生
    students = _load_students(grade)
    class_students = [s for s in students if s.get("class") == cls]
    total_count = len(class_students)

    # 从格式化班级名 "高一1班" 中提取班级数字 "1"
    import re
    cls_match = re.search(r'(\d+)', cls)
    cls_num = cls_match.group(1) if cls_match else cls

    # 直接查数据库获取该年级+班级所有学生的用户名（兼容 class="1" 和 class="1班"）
    student_rows = execute_query(
        "SELECT username, name FROM users WHERE role=2 AND grade=? AND (class=? OR class=?)",
        (grade, cls_num, f"{cls_num}班"),
    )
    # 建立 name -> username 映射
    name_to_username = {row[1]: row[0] for row in student_rows}

    # 建立 student_name -> username 关联
    student_usernames = []
    for s in class_students:
        uname = name_to_username.get(s["name"], "")
        if uname:
            student_usernames.append(uname)

    # 获取所有在线用户（有活跃 token 即为在线）
    online_usernames = get_online_usernames()

    # 统计在线学生
    logged_in_count = sum(1 for u in student_usernames if u in online_usernames)

    # 获取每个学生的最新登录时间和 IP（供展示用）
    latest_logins = {}
    if student_usernames:
        placeholders = ",".join(["?"] * len(student_usernames))
        latest_rows = execute_query_dict(
            f"""SELECT username, login_time, login_ip FROM login_logs
                WHERE username IN ({placeholders})
                AND login_time = (
                    SELECT MAX(login_time) FROM login_logs sub
                    WHERE sub.username = login_logs.username
                )
                ORDER BY login_time DESC""",
            tuple(student_usernames),
        )
        for row in latest_rows:
            latest_logins[row["username"]] = {
                "login_time": row["login_time"],
                "login_ip": row["login_ip"],
            }

    # 组装学生考勤明细
    student_list = []
    for s in class_students:
        uname = name_to_username.get(s["name"], "")
        login_info = latest_logins.get(uname, {})
        student_list.append({
            "name": s["name"],
            "username": uname,
            "grade": grade,
            "class": s.get("class", ""),
            "gender": s.get("gender", ""),
            "has_logged_in": uname in online_usernames,
            "last_login_time": login_info.get("login_time", ""),
            "last_login_ip": login_info.get("login_ip", ""),
        })

    login_rate = round((logged_in_count / total_count * 100), 1) if total_count > 0 else 0

    return {
        "grade": grade,
        "class": cls,
        "total_count": total_count,
        "logged_in_count": logged_in_count,
        "not_logged_in_count": total_count - logged_in_count,
        "login_rate": login_rate,
        "students": student_list,
    }


@router.get("/attendance/logs", summary="获取考勤登录明细")
async def attendance_logs(request: Request):
    """获取某个学生的详细登录记录"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    target_username = request.query_params.get("username", "")

    if not target_username:
        raise HTTPException(status_code=400, detail="缺少 username 参数")

    # 权限：管理员可查看任何学生，教师只能看自己任教范围内的学生
    if role != 0:
        from backend.permission_service import check_teacher_access_to_student
        # R4: 旧实现用 users 的遗留文本列判定, 目标(如管理员/同事)该列为空时
        # 会被 _is_teacher_allowed 的"空即放行"分支放过, 导致教师能翻别人的登录日志;
        # 改为直接走 teacher_assignments 的统一判定(非学生一律 False)
        if not check_teacher_access_to_student(username, target_username):
            raise HTTPException(status_code=403, detail="无权查看该学生考勤记录")

    logs = execute_query_dict(
        """SELECT id, username, student_name, login_time, login_ip, user_agent, logout_time
           FROM login_logs WHERE username=?
           ORDER BY login_time DESC""",
        (target_username,),
    )

    return {"logs": logs, "total": len(logs)}


@router.get("/attendance/online-students", summary="获取全部在线学生信息（含年级班级）")
async def attendance_online_students(request: Request):
    """获取当前所有在线学生信息（含年级、班级、登录信息），默认展示用"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    online_usernames = get_online_usernames()
    if not online_usernames:
        return {"students": [], "total": 0}

    # 只筛选 role=2 的学生
    placeholders = ",".join(["?"] * len(online_usernames))
    rows = execute_query_dict(
        f"""SELECT u.name, u.username, u.grade as old_grade, u.class as old_class,
                   g.name as grade_name, COALESCE(c.display_name, u.class) as class_display,
                   u.gender
            FROM users u
            LEFT JOIN grades g ON u.grade_id = g.id
            LEFT JOIN classes c ON u.class_id = c.id
            WHERE u.role=2 AND u.username IN ({placeholders})""",
        tuple(online_usernames),
    )

    # 非管理员按权限过滤
    if role != 0:
        allowed_rows = []
        for r in rows:
            # LEFT JOIN 无匹配时键存在但值为 NULL, dict.get 的默认值不生效,
            # 会退化成"空年级"而被放行 -> 统一用 or 归一
            s_grade = r.get("grade_name") or r.get("old_grade") or ""
            s_class = r.get("class_display") or r.get("old_class") or ""
            if _is_teacher_allowed(username, s_grade or "", s_class or ""):
                allowed_rows.append(r)
        rows = allowed_rows

    # 获取每位学生最新登录信息
    student_usernames = [r["username"] for r in rows]
    latest_logins = {}
    if student_usernames:
        ph = ",".join(["?"] * len(student_usernames))
        latest_rows = execute_query_dict(
            f"""SELECT username, login_time, login_ip FROM login_logs
                WHERE username IN ({ph})
                AND login_time = (
                    SELECT MAX(login_time) FROM login_logs sub
                    WHERE sub.username = login_logs.username
                )
                ORDER BY login_time DESC""",
            tuple(student_usernames),
        )
        for lr in latest_rows:
            latest_logins[lr["username"]] = {
                "login_time": lr["login_time"],
                "login_ip": lr["login_ip"],
            }

    student_list = []
    for r in rows:
        login_info = latest_logins.get(r["username"], {})
        grade_val = r.get("grade_name") or r.get("old_grade") or ""
        class_val = r.get("class_display") or r.get("old_class") or ""
        student_list.append({
            "name": r["name"],
            "username": r["username"],
            "grade": grade_val or "",
            "class": class_val or "",
            "gender": "男" if r.get("gender") in (1, "1", "男") else "女" if r.get("gender") in (2, "0", "女", 0) else "",
            "has_logged_in": True,
            "last_login_time": login_info.get("login_time", ""),
            "last_login_ip": login_info.get("login_ip", ""),
        })

    return {"students": student_list, "total": len(student_list)}


@router.get("/attendance/staff-logins", summary="获取教职工登录信息（管理员专用）")
async def attendance_staff_logins(request: Request):
    """获取所有教师和管理员的登录信息（仅管理员可查看）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role != 0:
        raise HTTPException(status_code=403, detail="仅管理员可查看教职工登录信息")

    # 获取所有教师(role=1)和管理员(role=0)
    staff_rows = execute_query_dict(
        """SELECT username, name, role, grade, class
           FROM users
           WHERE role IN (0, 1)
           ORDER BY role, username"""
    )

    if not staff_rows:
        return {"staff": [], "total": 0}

    # 获取每位教职工的最新登录信息
    staff_usernames = [r["username"] for r in staff_rows]
    latest_logins = {}
    if staff_usernames:
        ph = ",".join(["?"] * len(staff_usernames))
        latest_rows = execute_query_dict(
            f"""SELECT username, login_time, login_ip, user_agent, logout_time FROM login_logs
                WHERE username IN ({ph})
                AND login_time = (
                    SELECT MAX(login_time) FROM login_logs sub
                    WHERE sub.username = login_logs.username
                )
                ORDER BY login_time DESC""",
            tuple(staff_usernames),
        )
        for lr in latest_rows:
            # 如果已登出，则标记为离线
            is_online = not lr.get("logout_time")
            latest_logins[lr["username"]] = {
                "login_time": lr["login_time"],
                "login_ip": lr["login_ip"],
                "user_agent": lr.get("user_agent", ""),
                "is_online": is_online,
            }

    # 获取当前在线教职工（有活跃 token）
    online_usernames = get_online_usernames()

    staff_list = []
    for r in staff_rows:
        login_info = latest_logins.get(r["username"], {})
        is_online = r["username"] in online_usernames
        role_label = "管理员" if r["role"] == 0 else "教师"
        staff_list.append({
            "name": r["name"] or "",
            "username": r["username"],
            "role": role_label,
            "grade": r.get("grade", "") or "",
            "class": r.get("class", "") or "",
            "is_online": is_online,
            "last_login_time": login_info.get("login_time", ""),
            "last_login_ip": login_info.get("login_ip", ""),
            "last_user_agent": login_info.get("user_agent", ""),
        })

    return {"staff": staff_list, "total": len(staff_list)}


@router.delete("/attendance/login-logs", summary="清除登录日志（管理员专用）")
async def attendance_clear_login_logs(request: Request):
    """清除登录日志记录（仅管理员可操作）"""
    user = get_current_user(request)
    role = user.get("role", 2)

    if role != 0:
        raise HTTPException(status_code=403, detail="仅管理员可清除登录日志")

    # 获取查询参数
    target_username = request.query_params.get("username", "")
    keep_days_str = request.query_params.get("keep_days", "")

    try:
        if target_username:
            if keep_days_str:
                # 保留最近 N 天，清除更早的记录
                try:
                    keep_days = int(keep_days_str)
                except ValueError:
                    raise HTTPException(status_code=400, detail="keep_days 必须是整数")
                execute_insert_update(
                    "DELETE FROM login_logs WHERE username=? AND login_time < datetime('now', ? || ' days')",
                    (target_username, f"-{keep_days}"),
                )
                logger.info(f"管理员 {user['username']} 已清除用户 {target_username} {keep_days} 天前的登录日志")
                return {"success": True, "message": f"已清除用户 {target_username} {keep_days} 天前的登录日志"}
            else:
                execute_insert_update(
                    "DELETE FROM login_logs WHERE username=?",
                    (target_username,),
                )
                logger.info(f"管理员 {user['username']} 已清除用户 {target_username} 的全部登录日志")
                return {"success": True, "message": f"已清除用户 {target_username} 的全部登录日志"}
        else:
            if keep_days_str:
                try:
                    keep_days = int(keep_days_str)
                except ValueError:
                    raise HTTPException(status_code=400, detail="keep_days 必须是整数")
                execute_insert_update(
                    "DELETE FROM login_logs WHERE login_time < datetime('now', ? || ' days')",
                    (f"-{keep_days}",),
                )
                logger.info(f"管理员 {user['username']} 已清除 {keep_days} 天前的全部登录日志")
                return {"success": True, "message": f"已清除 {keep_days} 天前的全部登录日志"}
            else:
                execute_insert_update("DELETE FROM login_logs")
                logger.info(f"管理员 {user['username']} 已清除全部登录日志")
                return {"success": True, "message": "已清除全部登录日志"}
    except Exception as e:
        logger.error(f"清除登录日志失败: {e}")
        raise HTTPException(status_code=500, detail="清除登录日志失败")


def _normalize_grade_class(grade: str, cls: str) -> tuple[str, str]:
    """R11: 点名数据以 (教师, 年级, 班级) 为键, 年级与班级名不一致时会写出
    "高二 / 高一1班" 这种永远查不出来的脏行(现库里 scores 有 49 行即如此)。
    班级名自带年级前缀时以班级名为准, 保证键自洽, 也让权限判定落在真实班级上。
    """
    g = str(grade or "").strip()
    cn = str(cls or "").strip()
    if not cn:
        return g, cn
    try:
        rows = execute_query_dict(
            "SELECT g.name AS gname FROM classes c JOIN grades g ON c.grade_id = g.id "
            "WHERE c.display_name = ? OR c.name = ?",
            (cn, cn),
        )
    except Exception:
        return g, cn
    if rows and rows[0].get("gname") and str(rows[0]["gname"]) != g:
        return str(rows[0]["gname"]), cn
    return g, cn


def prune_stale_rollcall_meta() -> int:
    """R8: 清理 rollcall_meta 里年级与班级名互相矛盾的历史脏行

    这些行只保存 last_time / picked_in_round 等临时状态, 不含任何点名成绩,
    脏数据来源早期年级/班级归属调整。为避免误删, 仍有点名历史的键一律保留。
    """
    try:
        rows = execute_query_dict("SELECT id, teacher_username, grade, class_name FROM rollcall_meta")
    except Exception as e:
        logger.warning(f"[rollcall] 读取 rollcall_meta 失败, 跳过脏行清理: {e}")
        return 0
    stale = []
    for r in rows:
        g = str(r.get("grade") or "").strip()
        cn = str(r.get("class_name") or "").strip()
        if not g or not cn or cn.startswith(g):
            continue
        has_hist = execute_query(
            "SELECT 1 FROM rollcall_history WHERE teacher_username=? AND grade=? AND class_name=? LIMIT 1",
            (r["teacher_username"], g, cn),
        )
        if not has_hist:
            stale.append(r["id"])
    if not stale:
        return 0
    ph = ",".join(["?"] * len(stale))
    execute_insert_update(f"DELETE FROM rollcall_meta WHERE id IN ({ph})", tuple(stale))
    logger.info(f"[rollcall] 已清理 {len(stale)} 行年级与班级不一致的点名临时状态")
    return len(stale)


def _reset_rollcall(teacher: str, grade: str, cls: str) -> int:
    """R1: 重置某班点名状态(权重复原 + 清空本轮已点 + 清空历史), 供两处调用"""
    students = _load_students(grade)
    names = [s["name"] for s in students if s.get("class") == cls]
    state = {
        "weights": {n: 10 for n in names},
        "history": [],
        "picked_in_round": [],
        "last_time": time.time(),
    }
    _save_history(teacher, grade, cls, state)
    return len(names)
