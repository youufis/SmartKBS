"""
课堂积分激励系统 - 多教师版
每个教师管理自己的积分，积分文件保存在教师自己的目录中
学生数据全部从数据库 smartkb.db 加载
"""
import json, os
import jwt as pyjwt
from fastapi import Request
from backend.database import get_connection, execute_query

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ── 教师积分文件读写（保存在教师自己目录中）──

def _load_teacher_scores(teacher):
    """从数据库加载教师的积分数据"""
    rows = execute_query(
        "SELECT grade, class_name, student_name, score FROM scores WHERE teacher_username=?",
        (teacher,),
    )
    return {_teacher_score_key(teacher, row[0], row[1], row[2]): row[3] for row in rows}


def _save_teacher_scores(scores_data, teacher):
    """保存教师的积分数据到数据库（全量替换）"""
    with get_connection() as conn:
        c = conn.cursor()
        c.execute("DELETE FROM scores WHERE teacher_username=?", (teacher,))
        for key, score in scores_data.items():
            parts = key.split("|")
            if len(parts) == 4:
                _, grade, cls, name = parts
                c.execute(
                    "INSERT INTO scores (teacher_username, grade, class_name, student_name, score, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
                    (teacher, grade, cls, name, score),
                )
        conn.commit()


def _teacher_score_key(teacher, grade, cls, name):
    return f"{teacher}|{grade}|{cls}|{name}"


def _get_teacher(request: Request) -> str:
    """从请求中提取教师用户名"""
    teacher = request.query_params.get("teacher", "")
    if teacher:
        return teacher
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        try:
            payload = pyjwt.decode(auth[7:], options={"verify_signature": False})
            return payload.get("username", "root")
        except Exception:
            pass
    return "root"


def _load_students(grade="高一"):
    """从数据库加载学生名单"""
    students = []
    try:
        with get_connection() as conn:
            c = conn.cursor()
            c.execute(
                "SELECT name, class, gender FROM users WHERE role=2 AND grade=? AND name IS NOT NULL AND name!=''",
                (grade,),
            )
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
        for cls_name in sorted(class_map.keys()):
            students.extend(class_map[cls_name])
        if students:
            return students
    except Exception:
        pass
    return []


# ── 教师年级/班级权限辅助 ──

def _parse_teacher_grade_class(grade: str, class_str: str) -> dict[str, list[str]]:
    """解析教师的年级和班级映射，返回 {年级: [班级列表]}"""
    result = {}
    if not grade or not grade.strip():
        return result
    grade_parts = [g.strip() for g in grade.split("|")]
    class_parts = [c.strip() for c in class_str.split("|")] if class_str else []
    for i, g in enumerate(grade_parts):
        if not g:
            continue
        if i < len(class_parts) and class_parts[i]:
            classes = [c.strip() for c in class_parts[i].split(",") if c.strip()]
            result[g] = classes
        else:
            result[g] = []
    return result


def _get_teacher_allowed_grades(teacher: str) -> list[str]:
    """获取教师有权限的年级列表，管理员返回全部"""
    if teacher == "root":
        return ["高一", "高二"]
    rows = execute_query("SELECT grade FROM users WHERE username=?", (teacher,))
    if not rows:
        return ["高一", "高二"]
    grade_str = (rows[0][0] or "").strip()
    if not grade_str:
        return ["高一", "高二"]
    return [g.strip() for g in grade_str.split("|") if g.strip()]


def _get_teacher_allowed_classes(teacher: str, grade: str) -> list[str]:
    """获取教师在某个年级任教的班级列表，管理员返回空（表示全部）"""
    if teacher == "root":
        return []
    rows = execute_query("SELECT grade, class FROM users WHERE username=?", (teacher,))
    if not rows:
        return []
    teacher_grade = (rows[0][0] or "").strip()
    teacher_class = str(rows[0][1] or "").strip()
    if not teacher_grade and not teacher_class:
        return []
    gcm = _parse_teacher_grade_class(teacher_grade, teacher_class)
    return gcm.get(grade, [])


# ── API 处理器 ──

async def api_classes(request: Request):
    grade = request.query_params.get("grade", "")
    teacher = _get_teacher(request)
    students = _load_students(grade)
    all_classes = sorted(set(s["class"] for s in students))
    allowed = _get_teacher_allowed_classes(teacher, grade)
    if allowed:
        # 教师只返回其任教的班级
        # 用完整类名匹配，避免 endswith("1班") 误匹配 "11班"
        allowed_full = {f"{grade}{a}班" for a in allowed}
        return [c for c in all_classes if c in allowed_full]
    return all_classes


async def api_my_grades(request: Request):
    """返回当前教师可查看的年级列表"""
    teacher = _get_teacher(request)
    return _get_teacher_allowed_grades(teacher)


async def api_teacher_info(request: Request):
    """返回当前教师的任教信息（年级+班级）"""
    teacher = _get_teacher(request)
    if teacher == "root":
        return {"username": "root", "teaching": "管理员，所有年级和班级"}
    rows = execute_query("SELECT grade, class FROM users WHERE username=?", (teacher,))
    if not rows:
        return {"username": teacher, "teaching": "未配置任教信息"}
    teacher_grade = (rows[0][0] or "").strip()
    teacher_class = str(rows[0][1] or "").strip()
    if not teacher_grade:
        return {"username": teacher, "teaching": "未配置任教信息"}
    gcm = _parse_teacher_grade_class(teacher_grade, teacher_class)
    parts = []
    for g, classes in gcm.items():
        if classes:
            parts.append(f"{g}{','.join(classes)}班")
        else:
            parts.append(f"{g}（全部班级）")
    return {"username": teacher, "teaching": " | ".join(parts)}


async def api_students(request: Request):
    teacher = _get_teacher(request)
    grade = request.query_params.get("grade", "")
    cls = request.query_params.get("class", "")
    students = _load_students(grade)
    filtered = [s for s in students if s["class"] == cls]
    scores = _load_teacher_scores(teacher)
    for s in filtered:
        s["score"] = scores.get(_teacher_score_key(teacher, grade, s["class"], s["name"]), 0)
    return filtered


async def api_ranking(request: Request):
    teacher = _get_teacher(request)
    grade = request.query_params.get("grade", "")
    cls = request.query_params.get("class", "")
    students = _load_students(grade)
    if cls:
        filtered = [s for s in students if s["class"] == cls]
    else:
        filtered = list(students)
    scores = _load_teacher_scores(teacher)
    for s in filtered:
        s["score"] = scores.get(_teacher_score_key(teacher, grade, s["class"], s["name"]), 0)
    filtered.sort(key=lambda x: x["score"], reverse=True)
    return filtered


async def api_stats(request: Request):
    teacher = _get_teacher(request)
    grade = request.query_params.get("grade", "")
    cls = request.query_params.get("class", "")
    students = _load_students(grade)
    if cls:
        filtered = [s for s in students if s["class"] == cls]
    else:
        filtered = list(students)
    scores = _load_teacher_scores(teacher)
    total = max_s = 0
    max_name = ""
    for s in filtered:
        sc = scores.get(_teacher_score_key(teacher, grade, s["class"], s["name"]), 0)
        total += sc
        if sc > max_s:
            max_s, max_name = sc, s["name"]
    return {
        "total": total,
        "avg": round(total / len(filtered), 1) if filtered else 0,
        "max_score": max_s,
        "max_name": max_name,
        "count": len(filtered),
    }


async def api_score_post(request: Request):
    body = await request.json()
    teacher = body.get("teacher") or _get_teacher(request)
    scores = _load_teacher_scores(teacher)
    key = _teacher_score_key(teacher, body["grade"], body["class"], body["name"])
    scores[key] = scores.get(key, 0) + body["points"]
    _save_teacher_scores(scores, teacher)
    return {"success": True, "total": scores[key], "added": body["points"]}


async def api_reset_post(request: Request):
    body = await request.json()
    teacher = body.get("teacher") or _get_teacher(request)
    scores = _load_teacher_scores(teacher)
    g, c, n = body.get("grade"), body.get("class"), body.get("name")
    if n:
        scores.pop(_teacher_score_key(teacher, g, c, n), None)
    elif c and g:
        prefix = f"{teacher}|{g}|{c}|"
        for k in list(scores):
            if k.startswith(prefix):
                scores.pop(k, None)
    _save_teacher_scores(scores, teacher)
    return {"success": True}


async def api_student_save(request: Request):
    body = await request.json()
    teacher = body.get("teacher") or _get_teacher(request)
    grade = body.get("grade")
    if grade not in ("高一", "高二"):
        return {"success": False, "error": "无效年级"}

    name = (body.get("name") or "").strip()
    cls = (body.get("class") or "").strip()
    original_name = (body.get("originalName") or "").strip()
    original_class = (body.get("originalClass") or "").strip()

    if not name or not cls:
        return {"success": False, "error": "姓名和班级为必填项"}

    # 班级或姓名变更时迁移积分记录
    if original_name and original_class and (original_name != name or original_class != cls):
        scores = _load_teacher_scores(teacher)
        old_key = _teacher_score_key(teacher, grade, original_class, original_name)
        new_key = _teacher_score_key(teacher, grade, cls, name)
        if old_key in scores:
            scores[new_key] = scores.pop(old_key)
            _save_teacher_scores(scores, teacher)

    return {"success": True, "student": {"name": name, "class": cls}}


async def api_student_delete(request: Request):
    body = await request.json()
    teacher = body.get("teacher") or _get_teacher(request)
    grade = body.get("grade")
    name = (body.get("name") or "").strip()
    cls = (body.get("class") or "").strip()
    if grade not in ("高一", "高二") or not name or not cls:
        return {"success": False, "error": "参数错误"}

    # 仅删除积分记录
    scores = _load_teacher_scores(teacher)
    scores.pop(_teacher_score_key(teacher, grade, cls, name), None)
    _save_teacher_scores(scores, teacher)
    return {"success": True}


# ── 注意：API 路由已迁移至 backend/api/score_router.py ──
# 本文件保留所有工具函数和 API 处理函数，供新路由模块和 smart_rollcall_api.py 导入


def read_score_html():
    return "<p style='color:white;text-align:center;padding:40px;'>课堂积分系统加载中...</p>"




