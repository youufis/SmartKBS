"""
课堂积分系统 API 路由
"""
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from backend.api.dependencies import get_current_user
from backend.auth import ROLE_ADMIN, ROLE_STUDENT
from backend.database import execute_query, execute_query_dict
from backend.logger import logger
from backend.score_utils import (
    teacher_score_key,
    load_teacher_scores,
    load_students,
    apply_score_delta,
    load_score_logs,
    new_op_id,
)
from backend.permission_service import (
    get_teacher_grades,
    get_teacher_classes,
    get_teacher_assignments,
    get_grade_by_name,
    parse_legacy_teacher_grade_class,
)

router = APIRouter()


# ── 教师身份识别工具 ──

def _get_teacher(request: Request, body: dict | None = None) -> str:
    """S-AUTH: 积分的归属一律以"登录身份"为准（与点名 R2 同一口径）

    - 管理员可用 ?teacher= 或 body.teacher 指名查看/操作某位教师的数据；
    - 教师/学生忽略客户端传来的 teacher，强制使用本人用户名；
    - 未登录由 get_current_user 直接抛 auth_missing（401），不再回退 "root"。
    旧实现信任 query 里的 teacher 且未登录回退 root，叠加 middleware 把 /api/scores/
    当成公开路径 —— 匿名请求带上 ?teacher=root 即可读写全校积分（实测可读名单、可加 100 分）。
    """
    user = get_current_user(request)
    if user.get("role") == ROLE_ADMIN:
        requested = (request.query_params.get("teacher")
                     or (body or {}).get("teacher") or "").strip()
        if requested:
            return requested
    return user.get("username") or "root"


def _require_staff(request: Request, body: dict | None = None) -> str:
    """加减分/批量/重置/撤销只允许教师与管理员（学生只读）。

    前端本来就不给学生入口，但接口层不能只靠界面：旧实现里任何登录用户都能给任意学生加分。
    """
    user = get_current_user(request)
    if user.get("role") == ROLE_STUDENT:
        raise HTTPException(status_code=403, detail="权限不足：学生不能修改积分")
    return _get_teacher(request, body)


def _current_place(username: str):
    """按学号取学生当前的 (年级, 班级显示名, 姓名)：撤销时对齐用，改名转班后仍撤得对"""
    rows = execute_query(
        """SELECT COALESCE(g.name, u.grade), COALESCE(c.display_name, u.class), u.name
           FROM users u
           LEFT JOIN grades  g ON g.id = u.grade_id
           LEFT JOIN classes c ON c.id = u.class_id
           WHERE u.username=?""",
        (username,),
    )
    if not rows or not rows[0][2]:
        return None
    return (rows[0][0] or "", rows[0][1] or "", rows[0][2])


# ── API 处理器 ──

async def api_classes(request: Request):
    grade = request.query_params.get("grade", "")
    teacher = _get_teacher(request)
    from backend.auth import is_admin
    grade_info = get_grade_by_name(grade)
    if grade_info:
        # 管理员/学生 → 直接查班级表
        if is_admin(teacher):
            all_classes = execute_query_dict(
                "SELECT display_name FROM classes WHERE grade_id=? ORDER BY sort_order",
                (grade_info["id"],),
            )
            return [c["display_name"] for c in all_classes]
        # 教师 → 任教班级
        classes = get_teacher_classes(teacher, grade_info["id"])
        if classes:
            return [c["display_name"] for c in classes]
    # 降级：从学生数据获取
    students = load_students(grade)
    return sorted(set(s["class"] for s in students))


async def api_my_grades(request: Request):
    """返回当前用户可查看的年级列表"""
    from backend.auth import is_admin, ROLE_STUDENT
    teacher = _get_teacher(request)
    if is_admin(teacher):
        rows = execute_query(
            "SELECT DISTINCT grade FROM users WHERE role=2 AND IFNULL(status,'active')='active' AND grade IS NOT NULL AND grade!='' ORDER BY grade"
        )
        return [row[0] for row in rows]
    # 教师 → 任教年级
    grades = get_teacher_grades(teacher)
    if grades:
        return [g["name"] for g in grades]
    # 学生 → 返回全校有学生的年级
    rows = execute_query(
        "SELECT DISTINCT grade FROM users WHERE role=2 AND IFNULL(status,'active')='active' AND grade IS NOT NULL AND grade!='' ORDER BY grade"
    )
    return [row[0] for row in rows]


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
        """SELECT u.username, u.name, COALESCE(stp.total_points, 0)
           FROM users u
           LEFT JOIN student_total_points stp ON u.username = stp.student_username
           WHERE u.role=2 AND IFNULL(u.status,'active')='active' AND u.grade=?""",
        (grade,),
    )
    # S-NO: 学号(username)唯一, 优先按学号精确关联 —— 同年级同名学生不再互相串分
    by_username = {row[0]: row[2] for row in reward_rows if row[0]}
    # 兜底: 老数据缺学号时退回按姓名匹配(与旧行为一致)
    by_name = {row[1]: row[2] for row in reward_rows if row[1]}
    for st in students:
        uname = (st.get("username") or "").strip()
        pts = by_username.get(uname) if uname else None
        if pts is None:
            pts = by_name.get(st["name"])
        st["reward_points"] = pts or 0
        st["total_points"] = (st.get("score") or 0) + st["reward_points"]
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
    teacher = _require_staff(request, body)
    grade = (body.get("grade") or "").strip()
    cls = (body.get("class") or "").strip()
    name = (body.get("name") or "").strip()
    points = int(body.get("points") or 0)
    reason = (body.get("reason") or "").strip()
    if not grade or not cls or not name:
        return {"success": False, "error": "参数错误"}
    if not points:
        return {"success": False, "error": "分值不能为 0"}
    op_id = new_op_id()
    total = apply_score_delta(teacher, grade, cls, name, points, reason=reason, op_id=op_id)
    return {"success": True, "total": total, "added": points, "op_id": op_id}


async def api_reset_post(request: Request):
    """重置积分 = 写 0 并记流水（可撤销）。

    旧实现是直接把 scores 行删掉：既留不下痕迹，也没法撤销；而且和"删除"按钮撞成同一个效果。
    """
    body = await request.json()
    teacher = _require_staff(request, body)
    scores = load_teacher_scores(teacher)
    g, c, n = body.get("grade"), body.get("class"), body.get("name")
    if n:
        keys = [teacher_score_key(teacher, g, c, n)]
    elif c and g:
        prefix = f"{teacher}|{g}|{c}|"
        keys = [k for k in scores if k.startswith(prefix)]
    else:
        return {"success": False, "error": "参数错误"}

    op_id = new_op_id()
    touched = 0
    for key in keys:
        old = int(scores.get(key) or 0)
        if not old:
            continue
        parts = key.split("|")
        if len(parts) != 4:
            continue
        _, k_grade, k_cls, k_name = parts
        apply_score_delta(teacher, k_grade, k_cls, k_name, -old, reason="reset", op_id=op_id)
        touched += 1
    return {"success": True, "reset": touched, "op_id": op_id}


async def api_score_batch(request: Request):
    """批量加分/扣分：一次操作共用一个 op_id，整组可撤销"""
    body = await request.json()
    teacher = _require_staff(request, body)
    grade = (body.get("grade") or "").strip()
    cls = (body.get("class") or "").strip()
    names = [str(x).strip() for x in (body.get("names") or []) if str(x).strip()]
    points = int(body.get("points") or 0)
    reason = (body.get("reason") or "").strip()
    if not grade or not cls or not names:
        return {"success": False, "error": "参数错误"}
    if not points:
        return {"success": False, "error": "分值不能为 0"}
    op_id = new_op_id()
    for nm in names:
        apply_score_delta(teacher, grade, cls, nm, points, reason=reason, op_id=op_id)
    return {"success": True, "updated": len(names), "added": points, "op_id": op_id}


async def api_score_logs(request: Request):
    """积分流水（默认当前教师的当前年级/班级；管理员可加 ?teacher= 看别人）"""
    teacher = _get_teacher(request)
    try:
        limit = int(request.query_params.get("limit") or 200)
    except ValueError:
        limit = 200
    return {"logs": load_score_logs(
        teacher,
        grade=(request.query_params.get("grade") or "").strip(),
        cls_display=(request.query_params.get("class") or "").strip(),
        name=(request.query_params.get("name") or "").strip(),
        limit=limit,
    )}


async def api_score_undo(request: Request):
    """撤销最近一次积分操作（默认限当前班级）：把那一组流水按相反数再应用一遍"""
    body = await request.json()
    teacher = _require_staff(request, body)
    grade = (body.get("grade") or "").strip()
    cls = (body.get("class") or "").strip()

    sql = "SELECT op_id FROM score_logs WHERE teacher_username=? AND undone=0"
    params: list = [teacher]
    if grade and cls:
        sql += " AND grade=? AND class_name=?"
        params += [grade, cls]
    sql += " ORDER BY id DESC LIMIT 1"
    rows = execute_query(sql, tuple(params))
    if not rows:
        return {"success": False, "error": "没有可撤销的操作"}

    op_id = rows[0][0]
    logs = execute_query(
        "SELECT id, student_username, grade, class_name, student_name, points "
        "FROM score_logs WHERE op_id=? AND undone=0 ORDER BY id",
        (op_id,),
    )
    reversed_students = 0
    reversed_points = 0
    for lid, sun, g, cls_n, nm, pts in logs:
        pts = int(pts or 0)
        cur = _current_place(sun) if sun else None      # 学生可能已改名/转班
        gg, cc, nn = cur if cur else (g, cls_n, nm)
        apply_score_delta(teacher, gg, cc, nn, -pts, reason="undo", op_id=op_id,
                          student_username=sun or "", log_undone=True, mark_undone_id=lid)
        reversed_students += 1
        reversed_points += pts
    return {"success": True, "reversed_students": reversed_students,
            "reversed_points": reversed_points, "op_id": op_id}


# ── 路由注册 ──

router.get("/classes", summary="获取班级列表")(api_classes)
router.get("/my-grades", summary="获取我的年级列表")(api_my_grades)
router.get("/teacher-info", summary="获取教师任教信息")(api_teacher_info)
router.get("/students", summary="获取学生列表（含积分）")(api_students)
router.get("/ranking", summary="获取积分排名")(api_ranking)
router.get("/stats", summary="获取积分统计")(api_stats)
router.post("/score", summary="添加积分")(api_score_post)
router.post("/batch", summary="批量加减分")(api_score_batch)
router.post("/reset", summary="重置积分（写 0 + 记流水，可撤销）")(api_reset_post)
router.post("/undo", summary="撤销最近一次积分操作")(api_score_undo)
router.get("/logs", summary="积分流水")(api_score_logs)


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
    except Exception as e:
        logger.warning(f"查询教师列表失败: {e}")

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
async def api_teachers(request: Request):
    """获取所有教师/管理员列表（S-AUTH：仅教师与管理员可读）

    前端只在管理员打开积分管理时才拉它做"切换教师"下拉；学生不需要同事目录，
    顺手把越权面收掉（旧实现登录即可枚举全部教师用户名）。
    """
    user = get_current_user(request)
    if user.get("role") == ROLE_STUDENT:
        raise HTTPException(status_code=403, detail="权限不足：无法查看教师列表")
    teachers = ["root"]
    try:
        rows = execute_query(
            "SELECT username FROM users WHERE role IN (0, 1) ORDER BY username"
        )
        teachers = ["root"] + [row[0] for row in rows if row[0] != "root"]
    except Exception:
        pass
    return sorted(set(teachers))
