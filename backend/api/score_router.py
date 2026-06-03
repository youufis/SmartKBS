"""
课堂积分系统 API 路由
"""
import jwt as pyjwt
from fastapi import APIRouter, Request

from backend.database import get_connection, execute_query
from backend.score_utils import teacher_score_key, load_teacher_scores, save_teacher_scores, load_students

router = APIRouter()


# ── 教师身份识别工具 ──

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
    from backend.subject_config import get_grade_list
    all_grades = get_grade_list()
    if teacher == "root":
        return all_grades
    rows = execute_query("SELECT grade FROM users WHERE username=?", (teacher,))
    if not rows:
        return all_grades
    grade_str = (rows[0][0] or "").strip()
    if not grade_str:
        return all_grades
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
    students = load_students(grade)
    all_classes = sorted(set(s["class"] for s in students))
    allowed = _get_teacher_allowed_classes(teacher, grade)
    if allowed:
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
    students = load_students(grade)
    filtered = [s for s in students if s["class"] == cls]
    scores = load_teacher_scores(teacher)
    for s in filtered:
        s["score"] = scores.get(teacher_score_key(teacher, grade, s["class"], s["name"]), 0)
    return filtered


async def api_ranking(request: Request):
    teacher = _get_teacher(request)
    grade = request.query_params.get("grade", "")
    cls = request.query_params.get("class", "")
    students = load_students(grade)
    if cls:
        filtered = [s for s in students if s["class"] == cls]
    else:
        filtered = list(students)
    scores = load_teacher_scores(teacher)
    for s in filtered:
        s["score"] = scores.get(teacher_score_key(teacher, grade, s["class"], s["name"]), 0)
    filtered.sort(key=lambda x: x["score"], reverse=True)
    return filtered


async def api_stats(request: Request):
    teacher = _get_teacher(request)
    grade = request.query_params.get("grade", "")
    cls = request.query_params.get("class", "")
    students = load_students(grade)
    if cls:
        filtered = [s for s in students if s["class"] == cls]
    else:
        filtered = list(students)
    scores = load_teacher_scores(teacher)
    total = max_s = 0
    max_name = ""
    for s in filtered:
        sc = scores.get(teacher_score_key(teacher, grade, s["class"], s["name"]), 0)
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
    scores = load_teacher_scores(teacher)
    key = teacher_score_key(teacher, body["grade"], body["class"], body["name"])
    scores[key] = scores.get(key, 0) + body["points"]
    save_teacher_scores(scores, teacher)
    return {"success": True, "total": scores[key], "added": body["points"]}


async def api_reset_post(request: Request):
    body = await request.json()
    teacher = body.get("teacher") or _get_teacher(request)
    scores = load_teacher_scores(teacher)
    g, c, n = body.get("grade"), body.get("class"), body.get("name")
    if n:
        scores.pop(teacher_score_key(teacher, g, c, n), None)
    elif c and g:
        prefix = f"{teacher}|{g}|{c}|"
        for k in list(scores):
            if k.startswith(prefix):
                scores.pop(k, None)
    save_teacher_scores(scores, teacher)
    return {"success": True}


async def api_student_save(request: Request):
    body = await request.json()
    teacher = body.get("teacher") or _get_teacher(request)
    grade = body.get("grade")
    from backend.subject_config import get_grade_list
    if grade not in get_grade_list():
        return {"success": False, "error": "无效年级"}

    name = (body.get("name") or "").strip()
    cls = (body.get("class") or "").strip()
    original_name = (body.get("originalName") or "").strip()
    original_class = (body.get("originalClass") or "").strip()

    if not name or not cls:
        return {"success": False, "error": "姓名和班级为必填项"}

    if original_name and original_class and (original_name != name or original_class != cls):
        scores = load_teacher_scores(teacher)
        old_key = teacher_score_key(teacher, grade, original_class, original_name)
        new_key = teacher_score_key(teacher, grade, cls, name)
        if old_key in scores:
            scores[new_key] = scores.pop(old_key)
            save_teacher_scores(scores, teacher)

    return {"success": True, "student": {"name": name, "class": cls}}


async def api_student_delete(request: Request):
    body = await request.json()
    teacher = body.get("teacher") or _get_teacher(request)
    grade = body.get("grade")
    name = (body.get("name") or "").strip()
    cls = (body.get("class") or "").strip()
    from backend.subject_config import get_grade_list
    if grade not in get_grade_list() or not name or not cls:
        return {"success": False, "error": "参数错误"}
    scores = load_teacher_scores(teacher)
    scores.pop(teacher_score_key(teacher, grade, cls, name), None)
    save_teacher_scores(scores, teacher)
    return {"success": True}


# ── 路由注册 ──

router.get("/classes", summary="获取班级列表")(api_classes)
router.get("/my-grades", summary="获取我的年级列表")(api_my_grades)
router.get("/teacher-info", summary="获取教师任教信息")(api_teacher_info)
router.get("/students", summary="获取学生列表（含积分）")(api_students)
router.get("/ranking", summary="获取积分排名")(api_ranking)
router.get("/stats", summary="获取积分统计")(api_stats)
router.post("/score", summary="添加积分")(api_score_post)
router.post("/reset", summary="重置积分")(api_reset_post)
router.post("/student", summary="保存/迁移学生积分")(api_student_save)
router.delete("/student", summary="删除学生积分")(api_student_delete)


# ── 原 mount_score_api 内联定义的路由 ──


@router.get("/ping", summary="健康检查")
async def ping():
    return {"status": "ok"}


@router.get("/my-score", summary="查询学生个人累计积分")
async def api_my_score(request: Request):
    """查询某个学生在所有教师下的累计积分"""
    name = request.query_params.get("name", "").strip()
    if not name:
        return {"error": "缺少 name 参数"}

    teachers_list = ["root"]
    try:
        rows = execute_query("SELECT username FROM users WHERE role IN (0, 1)")
        teachers_list = ["root"] + [row[0] for row in rows if row[0] != "root"]
    except Exception:
        pass

    total_score = 0
    found_grade = ""
    found_class = ""
    found_teachers = []
    teacher_scores = {}

    for t in teachers_list:
        scores = load_teacher_scores(t)
        for key, val in scores.items():
            parts = key.split("|")
            if len(parts) == 4 and parts[-1] == name:
                total_score += val
                if not found_grade:
                    found_grade = parts[1]
                    found_class = parts[2]
                if t not in found_teachers:
                    found_teachers.append(t)
                teacher_scores[t] = teacher_scores.get(t, 0) + val

    if total_score > 0:
        return {
            "name": name,
            "class": found_class,
            "grade": found_grade,
            "score": total_score,
            "teacher": "、".join(found_teachers),
            "teacher_scores": teacher_scores,
        }
    return {"name": name, "score": None, "message": "未找到该学生的积分记录"}


@router.get("/teachers", summary="获取教师/管理员列表")
async def api_teachers():
    """获取所有教师/管理员列表"""
    teachers = ["root"]
    try:
        rows = execute_query(
            "SELECT username FROM users WHERE role IN (0, 1) ORDER BY username"
        )
        teachers = ["root"] + [row[0] for row in rows if row[0] != "root"]
    except Exception:
        pass
    return sorted(set(teachers))
