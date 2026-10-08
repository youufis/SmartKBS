"""
智能点名 · 公平版 API 路由
"""
import json, os, random, re, time
from typing import Any

from datetime import datetime

from fastapi import APIRouter, Body, Request, HTTPException

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


def _base_date_for_history(last_time) -> str:
    """给只有 HH:MM 的历史条目补日期。

    last_time 由客户端回传，可能是 float 时间戳，也可能是字符串。旧代码直接
    time.localtime(last_time)，遇到字符串就 TypeError 把整批保存打挂——
    点名状态一条都写不进去。解析失败或算出未来日期时，一律退回「今天」。
    """
    try:
        ts = float(last_time)
    except (TypeError, ValueError):
        return time.strftime("%Y-%m-%d")
    today = time.strftime("%Y-%m-%d")
    stamp = time.strftime("%Y-%m-%d", time.localtime(ts))
    return stamp if stamp <= today else today


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
                    base_date = _base_date_for_history(data.get("last_time"))
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
            "SELECT username, grade_id, class_id FROM users WHERE role=2 AND IFNULL(status,'active')='active' AND name=?",
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
               WHERE u.role=2 AND IFNULL(u.status,'active')='active' AND g.is_active=1
               ORDER BY g.sort_order"""
        )
        if rows:
            return [r["name"] for r in rows]
        # 降级：从 users 表旧字段获取
        old_rows = execute_query(
            "SELECT DISTINCT grade FROM users WHERE role=2 AND IFNULL(status,'active')='active' AND grade IS NOT NULL AND grade!='' ORDER BY grade"
        )
        return [row[0] for row in old_rows]
    # 教师：从 teacher_assignments → grades 表获取任教年级
    grades = get_teacher_grades(user["username"])
    if grades:
        return [g["name"] for g in grades]
    # 降级：如果教师未配置任教记录，从有学生数据的年级中获取
    rows = execute_query(
        "SELECT DISTINCT grade FROM users WHERE role=2 AND IFNULL(status,'active')='active' AND grade IS NOT NULL AND grade!='' ORDER BY grade"
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
                   WHERE u.role=2 AND IFNULL(u.status,'active')='active' AND u.grade_id=? AND c.grade_id=?
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
                "SELECT username FROM users WHERE role=2 AND IFNULL(status,'active')='active' AND name=? AND grade=? AND (class=? OR class=?)",
                (student, grade, cls_num, f"{cls_num}班"),
            )
            if student_user:
                # activity_id 带日期 = 每人每天点名计一次分。
                # 旧口径 f"{grade}_{cls}_{student}" 不含日期，学生被点名一万次也只有 2 分，
                # 而"点名达人/全勤标兵"徽章又依赖点名记录，两边口径互相打架。
                _roll_day = time.strftime("%Y-%m-%d")   # 本模块只 import 了 time，别用 datetime
                award_participation(student_user[0][0], "rollcall",
                                    f"{grade}_{cls}_{student}_{_roll_day}", f"点名-{student}")
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


# ── 语音播报（点名念姓名；实现在 backend/tts_service.py）──

#: 播报接口会真金白银调合成，按用户做内存态节流（真人点名一分钟点不了几次）
_SPEECH_HITS: dict[str, list[float]] = {}
_SPEECH_WINDOW_SECONDS = 60
_SPEECH_MAX_PER_WINDOW = 20


def _speech_throttled(username: str) -> bool:
    now = time.time()
    hits = [x for x in _SPEECH_HITS.get(username, []) if now - x < _SPEECH_WINDOW_SECONDS]
    limited = len(hits) >= _SPEECH_MAX_PER_WINDOW
    if not limited:
        hits.append(now)
    _SPEECH_HITS[username] = hits
    return limited


async def api_speech_status(request: Request):
    """点名页据此决定 🔊 图标是否可用（与 /api/config/multimodal-status 同口径：登录即可，无需管理员）"""
    get_current_user(request)
    from backend.tts_service import tts_enabled

    return {"enabled": tts_enabled()}


async def api_speech(request: Request):
    """播报一名学生的姓名，返回可播放的音频 URL。

    只接受**该班名册里真实存在**的姓名：这个接口会产生计费调用，若收任意文本
    就等于对外开了个免费 TTS 口。权限沿用点名本来的口径 —— 教师只能操作自己
    任教的班级，管理员不限。

    失败一律返回 {ok:false, error:中文原因}，不抛异常：点名不能被音频问题挡住。
    """
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", ROLE_STUDENT)
    grade = request.query_params.get("grade", "")
    cls = request.query_params.get("class", "")
    name = (request.query_params.get("name", "") or "").strip()

    if role != ROLE_ADMIN and not _is_teacher_allowed(username, grade, cls):
        raise HTTPException(status_code=403, detail="无权操作该班级")
    if not name or len(name) > 20:
        raise HTTPException(status_code=400, detail="姓名长度不合法")

    from backend.tts_service import speak_student_name, tts_enabled

    if not tts_enabled():
        return {"ok": False, "disabled": True, "error": "语音合成未启用，请在系统配置中开启"}
    if _speech_throttled(username):
        return {"ok": False, "throttled": True, "error": "播报过于频繁，请稍候再试"}

    roster = {str(x.get("name") or "") for x in _load_students(grade) if x.get("class") == cls}
    if name not in roster:
        logger.info(f"[rollcall] 拒绝播报不在名册的姓名 user={username} {grade}/{cls} {name[:12]!r}")
        return {"ok": False, "error": "该姓名不在本班名册中"}

    return await speak_student_name(name)


# ── 路由注册 ──

router.get("/grades", summary="获取年级列表")(api_grades)
router.get("/classes", summary="获取班级列表")(api_classes)
router.get("/students", summary="获取学生列表（含积分）")(api_students)
router.post("/pick", summary="公平点名选取")(api_pick)
router.post("/mark", summary="标记点名结果")(api_mark)
router.get("/history", summary="获取点名历史")(api_history)
router.post("/reset", summary="重置点名数据")(api_reset)
router.post("/save-record", summary="保存答题记录到 ChatHistory")(api_save_record)
router.get("/speech-status", summary="语音播报是否可用（点名页图标用）")(api_speech_status)
router.get("/speech", summary="播报学生姓名（返回音频 URL）")(api_speech)


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
            "SELECT DISTINCT grade FROM users WHERE role=2 AND IFNULL(status,'active')='active' AND grade IS NOT NULL AND grade!='' ORDER BY grade"
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
        "SELECT username, name FROM users WHERE role=2 AND IFNULL(status,'active')='active' AND grade=? AND (class=? OR class=?)",
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


@router.get("/attendance/staff-logins", summary="获取教职工登录信息（已弃用，保留一个版本）",
            deprecated=True)
async def attendance_staff_logins(request: Request):
    """教职工登录信息 —— 能力已被 /attendance/login-logs 完全覆盖，保留一版做过渡。

    它原先独有的两项都已并入登录历史：
      - 在线判定统一用活跃会话（get_online_usernames），不再看 logout_time 是否留空
      - "谁从没用过系统"由 stats.never_logged_in 回答（默认统计教职工）
    暂不删除的原因：浏览器缓存的旧 bundle 仍会调它，直接下线会让老页面报错；
    下个版本连同前端残留一起清掉。
    """
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


# ══════════════════════════════════════════════════════════════
# 登录历史记录管理（考勤统计第三个子页，仅管理员）
# ══════════════════════════════════════════════════════════════
# 与上面两个只读视图的分工：/attendance/logs 回答"某个学生的全部历史"，
# /attendance/staff-logins 回答"每个教职工的最近一次"，都答不了
# "最近谁在哪个 IP 登录过、能否按条件翻出来并清理"。这里补的是这一段。
#
# 注意：login_logs 只记**成功登录**（登录失败仅进日志文件与内存封禁计数，
# 不落库），前端文案也要照实说明，别让人以为失败尝试也在里面。

LOGIN_LOG_MAX_PAGE_SIZE = 200
LOGIN_LOG_EXPORT_CAP = 20000
LOGIN_LOG_BATCH_CAP = 1000
#: 排序字段白名单：拼进 ORDER BY 的列名绝不能来自未校验的用户输入
LOGIN_LOG_SORT_FIELDS = {"id", "login_time", "logout_time", "username", "grade"}
LOGIN_LOG_TRUE_VALUES = {"1", "true", "yes", "on"}

_ROLE_LABELS = {0: "管理员", 1: "教师", 2: "学生"}

_LOGIN_LOG_SELECT = """SELECT l.id, l.username, l.student_name, l.grade, l.class_name,
                              l.login_time, l.logout_time, l.login_ip, l.user_agent,
                              u.name AS real_name, u.role AS role
                       FROM login_logs l
                       LEFT JOIN users u ON u.username = l.username"""


def _like_esc(v: str) -> str:
    """转义 LIKE 的通配符，用 ! 作 ESCAPE 字符。

    不用反斜杠：SQL 字面量里 ESCAPE '\\' 会变成两个字符被 SQLite 拒绝；
    不转义则用户搜 "100%.md" 这类文本时 % 会被当通配符，误伤其它行。
    """
    return re.sub(r"([%!_])", "!\\1", str(v or ""))


def _require_login_log_admin(request: Request) -> dict:
    """登录历史含 IP 与 UA 指纹，属个人信息：三个端点一律服务端硬限管理员。

    前端隐藏入口只是体验，权限判定必须以这里为准。
    """
    user = get_current_user(request)
    if user.get("role", 2) != ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="仅管理员可查看与管理登录历史")
    return user


def _norm_time_bound(raw: str, end_of_day: bool, label: str) -> str:
    """把日期参数规范成与 login_time 同格式的本地时间串。

    login_time 是用 datetime('now','localtime') 写的 'YYYY-MM-DD HH:MM:SS'，
    所以比较值也必须是同格式本地串：只给日期却不补时分秒，字符串比较会让
    "筛今天的记录" 直接落空（'2026-10-03' < '2026-10-03 08:00:00'）。
    """
    text = str(raw or "").strip()
    if not text:
        return ""
    date_only = len(text) <= 10
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(text, fmt)
        except ValueError:
            continue
        if date_only:
            dt = dt.replace(hour=23, minute=59, second=59) if end_of_day else dt.replace(
                hour=0, minute=0, second=0)
        return dt.strftime("%Y-%m-%d %H:%M:%S")
    raise HTTPException(status_code=400,
                        detail=f"{label} 格式应为 YYYY-MM-DD 或 YYYY-MM-DD HH:MM:SS")


def _login_log_where(q: dict) -> tuple[str, list]:
    """按筛选条件拼 WHERE（返回条件串与参数列表，值一律走占位符）"""
    conds: list[str] = ["1=1"]
    args: list[Any] = []

    keyword = str(q.get("keyword") or "").strip()
    if keyword:
        like = f"%{_like_esc(keyword)}%"
        conds.append("(l.username LIKE ? ESCAPE '!' OR COALESCE(u.name, l.student_name) LIKE ? ESCAPE '!'"
                     " OR l.login_ip LIKE ? ESCAPE '!')")
        args += [like, like, like]

    username = str(q.get("username") or "").strip()
    if username:
        conds.append("l.username = ?")
        args.append(username)

    role = str(q.get("role") or "").strip()
    if role and role != "all":
        if role not in {"0", "1", "2"}:
            raise HTTPException(status_code=400, detail="role 只能是 0/1/2 或 all")
        conds.append("u.role = ?")
        args.append(int(role))

    grade = str(q.get("grade") or "").strip()
    if grade:
        conds.append("l.grade = ?")
        args.append(grade)

    cls = str(q.get("class_name") or "").strip()
    if cls:
        conds.append("l.class_name = ?")
        args.append(cls)

    # 「在线」一律以活跃会话为准（get_online_usernames），不要按 logout_time 是否为空判：
    # 实测 5 条 logout_time 留空的行里 5 条都是假在线（关页面没点登出、九月的老记录、
    # 甚至已注销的幽灵账号），照它显示"当前在线 5"会把管理员误导。
    if str(q.get("only_online") or "").strip().lower() in LOGIN_LOG_TRUE_VALUES:
        _online = sorted(get_online_usernames())
        if _online:
            conds.append(f"l.username IN ({','.join('?' * len(_online))})")
            args.extend(_online)
        else:
            conds.append("1=0")

    # 已注销账号的历史：用 LEFT JOIN 才看得到，否则这类行永远留在库里没人清理
    if str(q.get("orphan_only") or "").strip().lower() in LOGIN_LOG_TRUE_VALUES:
        conds.append("u.username IS NULL")

    start = _norm_time_bound(q.get("login_from", ""), False, "login_from")
    if start:
        conds.append("l.login_time >= ?")
        args.append(start)
    end = _norm_time_bound(q.get("login_to", ""), True, "login_to")
    if end:
        conds.append("l.login_time <= ?")
        args.append(end)

    return " AND ".join(conds), args


def _login_log_row(r: dict, online_users: set[str] | None = None) -> dict:
    """统一出口结构：角色给中文标签、时长在 Python 侧算（SQLite 版本差异别带到比较逻辑里）"""
    login_t = str(r.get("login_time") or "")
    logout_t = str(r.get("logout_time") or "")
    duration = None
    if login_t and logout_t:
        try:
            duration = int((datetime.strptime(logout_t[:19], "%Y-%m-%d %H:%M:%S")
                            - datetime.strptime(login_t[:19], "%Y-%m-%d %H:%M:%S")).total_seconds())
            if duration < 0:
                duration = None      # 历史脏数据里登出早于登录：宁可不显示，也不给负时长
        except ValueError:
            duration = None
    role = r.get("role")
    return {
        "id": r.get("id"),
        "username": r.get("username") or "",
        "name": r.get("real_name") or r.get("student_name") or "",
        "role": "" if role is None else _ROLE_LABELS.get(int(role), str(role)),
        "role_value": role,
        "account_exists": role is not None,
        "grade": r.get("grade") or "",
        "class_name": r.get("class_name") or "",
        "login_time": login_t,
        "logout_time": logout_t,
        # 在线 = 该账号当前有活跃会话；登出时间留空只是"没点登出"，不代表在线
        "is_online": (r.get("username") or "") in (online_users or set()),
        "duration_seconds": duration,
        "login_ip": r.get("login_ip") or "",
        "user_agent": r.get("user_agent") or "",
    }


@router.get("/attendance/login-logs", summary="登录历史记录查询（管理员专用）")
async def attendance_login_logs(request: Request):
    """跨用户翻查登录历史：筛选 + 服务端分页 + 命中集统计。"""
    _require_login_log_admin(request)
    q = request.query_params

    try:
        page = max(1, int(q.get("page") or 1))
        page_size = int(q.get("page_size") or 20)
    except ValueError:
        raise HTTPException(status_code=400, detail="page / page_size 必须是整数")
    if page_size < 1 or page_size > LOGIN_LOG_MAX_PAGE_SIZE:
        raise HTTPException(status_code=400,
                            detail=f"page_size 范围为 1-{LOGIN_LOG_MAX_PAGE_SIZE}")

    sort = str(q.get("sort") or "login_time").strip().lower()
    if sort not in LOGIN_LOG_SORT_FIELDS:
        raise HTTPException(status_code=400,
                            detail="sort 只能是 " + "/".join(sorted(LOGIN_LOG_SORT_FIELDS)))
    order = "ASC" if str(q.get("order") or "desc").strip().lower() == "asc" else "DESC"

    where, args = _login_log_where({k: q.get(k, "") for k in (
        "keyword", "username", "role", "grade", "class_name",
        "only_online", "orphan_only", "login_from", "login_to")})

    total_rows = execute_query_dict(
        f"SELECT COUNT(*) AS c FROM login_logs l LEFT JOIN users u ON u.username = l.username WHERE {where}",
        tuple(args)) or []
    total = int(total_rows[0]["c"]) if total_rows else 0

    stats_rows = execute_query_dict(
        f"""SELECT COUNT(DISTINCT l.username) AS users_,
                   SUM(CASE WHEN l.logout_time IS NULL OR l.logout_time = '' THEN 1 ELSE 0 END) AS online_,
                   MIN(l.login_time) AS t_from, MAX(l.login_time) AS t_to
            FROM login_logs l LEFT JOIN users u ON u.username = l.username WHERE {where}""",
        tuple(args)) or []
    st = stats_rows[0] if stats_rows else {}

    online_users = set(get_online_usernames())
    rows = execute_query_dict(
        f"{_LOGIN_LOG_SELECT} WHERE {where} ORDER BY l.{sort} {order}, l.id DESC LIMIT ? OFFSET ?",
        tuple(args) + (page_size, (page - 1) * page_size)) or []

    # 命中集里有多少账号当前真在线：取全部匹配用户（不分页）与活跃会话求交
    # execute_query_dict 返回的是字典行，取值必须用列名（写成 r[0] 会 KeyError）
    matched_users = {str(r["username"]) for r in (execute_query_dict(
        f"SELECT DISTINCT l.username AS username FROM login_logs l LEFT JOIN users u ON u.username = l.username WHERE {where}",
        tuple(args)) or [])}
    # 「谁从没用过系统」原先只有教职工登录页能答，合并进来不能丢：
    # 未加角色筛选时按教职工(0/1)统计 —— 上千个"未登录学生"没有管理意义
    role_filter = str(q.get("role") or "").strip()
    if role_filter in ("0", "1"):
        nl_where, nl_params = "u.role = ? AND IFNULL(u.status,'active')='active'", [int(role_filter)]
    elif role_filter == "2":
        nl_where, nl_params = "u.role = 2 AND IFNULL(u.status,'active')='active'", []
    else:
        nl_where, nl_params = "u.role IN (0,1) AND IFNULL(u.status,'active')='active'", []
    never_logged_in = int((execute_query_dict(
        f"""SELECT COUNT(*) AS c FROM users u
            WHERE {nl_where} AND NOT EXISTS
              (SELECT 1 FROM login_logs l WHERE l.username = u.username)""",
        tuple(nl_params)) or [{"c": 0}])[0]["c"])

    return {
        "logs": [_login_log_row(r, online_users) for r in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
        "stats": {
            "rows": total,
            "users": int(st.get("users_") or 0),
            # 不再用"logout_time 为空"的 SQL 口径，改为活跃会话交集
            "online": len(matched_users & online_users),
            "never_logged_in": never_logged_in,
            "time_from": st.get("t_from") or "",
            "time_to": st.get("t_to") or "",
        },
    }


@router.get("/attendance/login-logs/export", summary="导出登录历史 (Excel，管理员专用)")
async def attendance_export_login_logs(request: Request):
    """按当前筛选条件导出多表 Excel：明细 + 按用户汇总 + 导出说明。

    筛选参数与列表端点完全一致（所见即所得），不分页但设硬上限：
    管理员以为"导出成功"而实际只拿到截断结果，比直接报错更糟。
    """
    admin = _require_login_log_admin(request)
    q = request.query_params
    where, args = _login_log_where({k: q.get(k, "") for k in (
        "keyword", "username", "role", "grade", "class_name",
        "only_online", "orphan_only", "login_from", "login_to")})

    rows = execute_query_dict(
        f"{_LOGIN_LOG_SELECT} WHERE {where} ORDER BY l.login_time DESC, l.id DESC LIMIT ?",
        tuple(args) + (LOGIN_LOG_EXPORT_CAP + 1,)) or []
    if len(rows) > LOGIN_LOG_EXPORT_CAP:
        raise HTTPException(status_code=400,
                            detail=f"结果超过 {LOGIN_LOG_EXPORT_CAP} 行，请缩小时间范围或加筛选条件后重试")

    from openpyxl import Workbook
    from backend.api.export_router import (  # 复用既有 Excel 样式与响应范式
        _auto_width, _excel_response, _guard_row_count, _style_cells, _style_header)

    _guard_row_count(len(rows), "登录历史")
    items = [_login_log_row(r, set(get_online_usernames())) for r in rows]

    wb = Workbook()
    ws = wb.active
    ws.title = "登录明细"
    headers = ["序号", "姓名", "用户名", "角色", "年级", "班级", "登录时间", "登出时间",
               "在线时长", "登录IP", "客户端 UA"]
    ws.append(headers)
    _style_header(ws, 1, len(headers))
    for idx, it in enumerate(items, 1):
        dur = ""
        if it["duration_seconds"] is not None:
            m, s = divmod(int(it["duration_seconds"]), 60)
            h, m = divmod(m, 60)
            dur = f"{h}小时{m}分{s}秒" if h else (f"{m}分{s}秒" if m else f"{s}秒")
        ws.append([idx, it["name"], it["username"], it["role"] or "已注销", it["grade"],
                   it["class_name"], it["login_time"], it["logout_time"] or "未登出",
                   dur, it["login_ip"], it["user_agent"]])
    _style_cells(ws, 2, max(2, len(items) + 1), len(headers))
    _auto_width(ws, len(headers), max_width=46)
    ws.freeze_panes = "A2"

    # 按用户汇总：管理员最常问的是"谁登录得最多 / 最近一次是谁"
    agg: dict[str, dict[str, Any]] = {}
    for it in items:
        a = agg.setdefault(it["username"], {"name": it["name"], "role": it["role"] or "已注销",
                                            "grade": it["grade"], "class": it["class_name"],
                                            "count": 0, "ips": set(), "last": "", "online": 0})
        a["count"] += 1
        if it["login_ip"]:
            a["ips"].add(it["login_ip"])
        a["last"] = max(a["last"], it["login_time"])
        a["online"] += 1 if it["is_online"] else 0
    ws2 = wb.create_sheet("按用户汇总")
    h2 = ["序号", "姓名", "用户名", "角色", "年级", "班级", "登录次数", "未登出次数",
          "最近登录时间", "涉及IP数"]
    ws2.append(h2)
    _style_header(ws2, 1, len(h2))
    for i, (uname, a) in enumerate(sorted(agg.items(), key=lambda kv: (-kv[1]["count"], kv[0])), 1):
        ws2.append([i, a["name"], uname, a["role"], a["grade"], a["class"], a["count"],
                    a["online"], a["last"], len(a["ips"])])
    _style_cells(ws2, 2, max(2, len(agg) + 1), len(h2))
    _auto_width(ws2, len(h2))
    ws2.freeze_panes = "A2"

    ws3 = wb.create_sheet("导出说明")
    ws3.append(["项目", "内容"])
    _style_header(ws3, 1, 2)
    for line in [
        ["导出时间", datetime.now().strftime("%Y-%m-%d %H:%M:%S")],
        ["操作人", admin.get("username", "")],
        ["筛选条件", "; ".join(f"{k}={v}" for k, v in (
            ("关键字", q.get("keyword", "")), ("用户名", q.get("username", "")),
            ("角色", q.get("role", "")), ("年级", q.get("grade", "")),
            ("班级", q.get("class_name", "")), ("登录起", q.get("login_from", "")),
            ("登录止", q.get("login_to", "")),
            ("仅在线", q.get("only_online", "")), ("仅已注销账号", q.get("orphan_only", "")))
                              if v) or "无（全部）"],
        ["记录条数", str(len(items))],
        ["涉及账号数", str(len(agg))],
        ["当前在线账号数", str(len({i["username"] for i in items if i["is_online"]}))],
        ["数据来源", "login_logs（系统自动保留最近 180 天）"],
        ["口径说明", "仅记录登录成功的事件；登录失败不落库，只在服务端日志与 IP 封禁计数中体现。"],
        ["在线判定", "「在线」指该账号当前持有活跃会话（服务端令牌表），不是登出时间留空 —— "
                     "关页面不点登出会留下大量「未登出」行，按它判在线会严重虚高。"],
        ["隐私提示", "本表含 IP 与客户端指纹，仅限管理员在校内管理用途使用，勿外传。"],
    ]:
        ws3.append(line)
    _style_cells(ws3, 2, 9, 2)
    _auto_width(ws3, 2, max_width=90)

    filename = f"登录历史_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
    logger.info(f"[审计] 管理员 {admin.get('username', '')} 导出登录历史 {len(items)} 条，"
                f"条件={dict(q)}")
    return _excel_response(wb, filename)


@router.delete("/attendance/login-logs/batch", summary="按记录批量删除登录历史（管理员专用）")
async def attendance_delete_login_logs_batch(request: Request, body: dict = Body(...)):
    """按勾选 id 精确删除。

    刻意不提供"按当前筛选条件全删"：筛选条件写错就能一键抹掉整段审计痕迹，
    粒度上限留给已有的三种粗粒度端点（整库 / 整用户 / 按保留天数），路径明确。
    """
    admin = _require_login_log_admin(request)
    raw = (body or {}).get("ids")
    if not isinstance(raw, list) or not raw:
        raise HTTPException(status_code=400, detail="请先选择要删除的记录")
    if len(raw) > LOGIN_LOG_BATCH_CAP:
        raise HTTPException(status_code=400,
                            detail=f"单次最多删除 {LOGIN_LOG_BATCH_CAP} 条，请分批操作")
    ids: list[int] = []
    for v in raw:
        try:
            n = int(v)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="ids 必须是记录 id 数组")
        if n <= 0:
            raise HTTPException(status_code=400, detail="ids 存在非法值")
        ids.append(n)
    ids = sorted(set(ids))

    marks = ",".join("?" * len(ids))
    doomed = execute_query_dict(
        f"SELECT id, username, login_time FROM login_logs WHERE id IN ({marks})", tuple(ids)) or []
    if not doomed:
        return {"requested": len(ids), "deleted": 0, "missing": len(ids),
                "message": "所选记录不存在或已被删除"}

    # 占位符必须按**实际命中**的条数生成：用请求里的 ids 数拼模板、却传命中的 got，
    # 一旦有不存在的 id 就会绑定数不匹配直接报错（第一次自测就踩中了）
    got = [d["id"] for d in doomed]
    got_marks = ",".join("?" * len(got))
    execute_insert_update(f"DELETE FROM login_logs WHERE id IN ({got_marks})", tuple(got))
    # 删除个人信息类记录必须可事后追溯：谁、删了谁的、哪些时间点的记录
    logger.info(f"[审计] 管理员 {admin.get('username', '')} 批量删除登录历史 {len(got)} 条，"
                f"涉及账号 {sorted({str(d['username']) for d in doomed})[:10]}，"
                f"id 样例 {got[:20]}，未命中 {len(ids) - len(got)} 条")
    return {"requested": len(ids), "deleted": len(got), "missing": len(ids) - len(got),
            "message": f"已删除 {len(got)} 条登录记录"}


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
