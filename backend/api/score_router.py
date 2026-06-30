"""
课堂积分系统 API 路由
"""
import jwt as pyjwt
from typing import Any

from fastapi import APIRouter, Request

from backend.database import get_connection, execute_query, execute_query_dict
from backend.score_utils import teacher_score_key, load_teacher_scores, save_teacher_scores, load_students
from backend.permission_service import (
    get_teacher_grades,
    get_teacher_classes,
    get_teacher_assignments,
    get_grade_by_name,
    parse_legacy_teacher_grade_class,
)

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


# ── API 处理器 ──

async def api_classes(request: Request):
    grade = request.query_params.get("grade", "")
    teacher = _get_teacher(request)
    # 教师用权限服务过滤，管理员返回实际学生班级
    grade_info = get_grade_by_name(grade)
    if grade_info:
        classes = get_teacher_classes(teacher, grade_info["id"])
        if classes:
            return [c["display_name"] for c in classes]
    # 降级：从学生数据获取
    students = load_students(grade)
    return sorted(set(s["class"] for s in students))


async def api_my_grades(request: Request):
    """返回当前教师可查看的年级列表 - 管理员基于实际学生数据"""
    from backend.auth import is_admin
    teacher = _get_teacher(request)
    if is_admin(teacher):
        rows = execute_query(
            "SELECT DISTINCT grade FROM users WHERE role=2 AND grade IS NOT NULL AND grade!='' ORDER BY grade"
        )
        return [row[0] for row in rows]
    grades = get_teacher_grades(teacher)
    return [g["name"] for g in grades]


async def api_teacher_info(request: Request):
    """返回当前教师的任教信息（年级+班级）"""
    teacher = _get_teacher(request)
    from backend.auth import is_admin
    if is_admin(teacher):
        return {"username": teacher, "teaching": "管理员，所有年级和班级"}

    # 优先使用新表
    assignments = get_teacher_assignments(teacher)
    if assignments:
        grade_map: dict[str, set[str]] = {}
        for a in assignments:
            gn = a["grade_name"]
            if gn not in grade_map:
                grade_map[gn] = set()
            if a.get("class_name"):
                grade_map[gn].add(a["class_name"])
        parts = []
        for g, classes in grade_map.items():
            if classes:
                parts.append(f"{g}{','.join(sorted(classes))}")
            else:
                parts.append(f"{g}（全部班级）")
        return {"username": teacher, "teaching": " | ".join(parts)}

    # 降级：旧格式
    rows = execute_query("SELECT grade, class FROM users WHERE username=?", (teacher,))
    if not rows:
        return {"username": teacher, "teaching": "未配置任教信息"}
    teacher_grade = (rows[0][0] or "").strip()
    teacher_class = str(rows[0][1] or "").strip()
    if not teacher_grade:
        return {"username": teacher, "teaching": "未配置任教信息"}
    gcm = parse_legacy_teacher_grade_class(teacher_grade, teacher_class)
    parts = []
    for g, classes in gcm.items():
        if classes:
            parts.append(f"{g}{','.join(classes)}班")
        else:
            parts.append(f"{g}（全部班级）")
    return {"username": teacher, "teaching": " | ".join(parts)}


def _enrich_with_reward_points(students: list[dict[str, Any]], grade: str) -> list[dict[str, Any]]:
    """为每个学生补充 reward_points（通过 users 表关联）"""
    if not students:
        return students
    # 批量查询该年级所有学生的积分，一次 DB 调用
    reward_rows = execute_query(
        """SELECT u.name, COALESCE(stp.total_points, 0)
           FROM users u
           LEFT JOIN student_total_points stp ON u.username = stp.student_username
           WHERE u.role=2 AND u.grade=?""",
        (grade,),
    )
    name_to_reward = {row[0]: row[1] for row in reward_rows if row[0]}
    for s in students:
        s["reward_points"] = name_to_reward.get(s["name"], 0)
        s["total_points"] = (s.get("score") or 0) + s["reward_points"]
    return students


async def api_students(request: Request):
    teacher = _get_teacher(request)
    grade = request.query_params.get("grade", "")
    cls = request.query_params.get("class", "")
    students = load_students(grade)
    filtered = [s for s in students if s["class"] == cls]
    scores = load_teacher_scores(teacher)
    for s in filtered:
        s["score"] = scores.get(teacher_score_key(teacher, grade, s["class"], s["name"]), 0)
    _enrich_with_reward_points(filtered, grade)
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
    _enrich_with_reward_points(filtered, grade)
    # 默认按综合积分排序（total_points = manual + reward）
    filtered.sort(key=lambda x: x["total_points"], reverse=True)
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
