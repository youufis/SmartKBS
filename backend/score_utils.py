"""
积分与学生数据工具函数
供 score_router.py 和 rollcall_router.py 共享
"""
import uuid

from backend.database import get_connection, execute_query


def teacher_score_key(teacher, grade, cls, name):
    """生成积分字典的复合键"""
    return f"{teacher}|{grade}|{cls}|{name}"


def load_teacher_scores(teacher):
    """从数据库加载教师的积分数据"""
    rows = execute_query(
        "SELECT grade, class_name, student_name, score FROM scores WHERE teacher_username=?",
        (teacher,),
    )
    return {teacher_score_key(teacher, row[0], row[1], row[2]): row[3] for row in rows}


def save_teacher_scores(scores_data, teacher):
    """保存教师的积分数据到数据库（增量更新，保留原有 updated_at）"""
    with get_connection() as conn:
        c = conn.cursor()
        # 获取当前已有的记录，用于判断哪些需要删除
        existing_rows = c.execute(
            "SELECT grade, class_name, student_name FROM scores WHERE teacher_username=?",
            (teacher,),
        ).fetchall()
        existing_keys = set()
        for row in existing_rows:
            existing_keys.add(teacher_score_key(teacher, row[0], row[1], row[2]))

        new_keys = set(scores_data.keys())

        # 删除已移除的记录
        for key in existing_keys - new_keys:
            parts = key.split("|")
            if len(parts) == 4:
                _, grade, cls, name = parts
                c.execute(
                    "DELETE FROM scores WHERE teacher_username=? AND grade=? AND class_name=? AND student_name=?",
                    (teacher, grade, cls, name),
                )

        # 新增或更新记录
        for key, score in scores_data.items():
            parts = key.split("|")
            if len(parts) == 4:
                _, grade, cls, name = parts
                if key in existing_keys:
                    c.execute(
                        # A4: 必须用 localtime —— 读取方(portfolio 的"近 N 天"统计)拿
                        # Python 本地时间做 >= 比较, 旧写法存 UTC 会整体偏移 8 小时
                        "UPDATE scores SET score=?, updated_at=datetime('now', 'localtime') "
                        "WHERE teacher_username=? AND grade=? AND class_name=? AND student_name=?",
                        (score, teacher, grade, cls, name),
                    )
                else:
                    c.execute(
                        "INSERT INTO scores (teacher_username, grade, class_name, student_name, score, updated_at) "
                        "VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))",
                        (teacher, grade, cls, name, score),
                    )

        conn.commit()


def load_students(grade=""):
    """从数据库加载学生名单，按年级和班级筛选"""
    students = []
    try:
        import re
        grade_id = None
        if grade:
            if grade.isdigit():
                grade_id = int(grade)
            else:
                from backend.database import execute_query as eq
                r = eq("SELECT id FROM grades WHERE name=?", (grade,))
                if r:
                    grade_id = r[0][0]

        with get_connection() as conn:
            c = conn.cursor()
            if grade_id:
                c.execute(
                    """SELECT u.username, u.name, COALESCE(c.display_name, u.class) as cls_display, u.gender
                       FROM users u
                       LEFT JOIN classes c ON u.class_id = c.id
                       WHERE u.role=2 AND u.grade_id=? AND u.name IS NOT NULL AND u.name!=''""",
                    (grade_id,),
                )
            else:
                return []

            # S-DEDUP: 去重键用学号(username), 不再用姓名 ——
            # 同名学生在同年级会被旧实现静默丢掉一个(名单少人, 且没人发现)。
            # 老数据缺学号时退回姓名做键, 保持可见。
            seen, class_map = set(), {}
            for username, name, cls_display, gender_val in c.fetchall():
                dedup_key = (username or "").strip() or ("\x00name:" + name)
                if dedup_key in seen:
                    continue
                seen.add(dedup_key)
                cls_display = cls_display or ""
                class_map.setdefault(cls_display, []).append({
                    # 学号即登录用户名, 供积分管理/排行榜/学生管理统一展示
                    "username": username or "",
                    "class": cls_display, "name": name,
                    "gender": "男" if gender_val in (1, "1", "男") else "女" if gender_val in (2, "0", "女", 0) else "",
                })
            for cls_name in sorted(class_map.keys()):
                students.extend(class_map[cls_name])
    except Exception:
        pass
    return students


# ── 积分流水（score_logs）────────────────────────────────────────
#
# 背景：scores 表只存"当前总分 + updated_at"，老师无法回答"这 25 分谁什么时候加的"，
# 也不能撤销。每次加减分/重置都在 score_logs 里落一行，op_id 把一次操作(单个/批量/整班重置)
# 的行归成一组，撤销就是"把最近一组按相反数再应用一遍"。


def new_op_id() -> str:
    """一次积分操作的流水号（同一次批量/整班操作共用）"""
    return uuid.uuid4().hex


def student_fk_ids(grade: str, cls_display: str) -> tuple[int | None, int | None]:
    """年级名 + 班级显示名 -> (grade_id, class_id)；取不到就返回 None"""
    gid = None
    rows = execute_query("SELECT id FROM grades WHERE name=?", ((grade or "").strip(),))
    if rows:
        gid = rows[0][0]
    cid = None
    if gid and (cls_display or "").strip():
        rows2 = execute_query(
            "SELECT id FROM classes WHERE grade_id=? AND (display_name=? OR name=?)",
            (gid, cls_display.strip(), cls_display.strip()),
        )
        if rows2:
            cid = rows2[0][0]
    return gid, cid


def find_student_username(grade: str, cls_display: str, name: str) -> str:
    """按 (年级, 班级, 姓名) 反查学号，用于把流水挂到账号上（改名/转班后还能追到人）"""
    gid, cid = student_fk_ids(grade, cls_display)
    if gid is None:
        return ""
    if cid is not None:
        rows = execute_query(
            "SELECT username FROM users WHERE role=2 AND grade_id=? AND class_id=? AND name=? LIMIT 1",
            (gid, cid, name),
        )
        if rows:
            return rows[0][0] or ""
    rows = execute_query(
        "SELECT username FROM users WHERE role=2 AND grade_id=? AND name=? LIMIT 1",
        (gid, name),
    )
    return (rows[0][0] or "") if rows else ""


def apply_score_delta(teacher: str, grade: str, cls_display: str, name: str, delta: int, *,
                      reason: str = "", op_id: str | None = None, student_username: str = "",
                      log_undone: bool = False, mark_undone_id: int | None = None) -> int:
    """给某个学生在某班的积分做一次增量（行不存在就建），同时写一条流水。返回新总分。

    log_undone=True 用于"撤销"这一步自己产生的流水：写进去但立刻标为已撤销，
    免得撤销本身又变成一次可撤销的操作。
    mark_undone_id=被撤销的那条流水 id：同一次事务里把它标成已撤销，
    避免"外层持有写事务 + 内层再开连接"互相等锁。
    """
    op_id = op_id or new_op_id()
    delta = int(delta or 0)
    if not student_username:
        student_username = find_student_username(grade, cls_display, name)
    gid, cid = student_fk_ids(grade, cls_display)

    with get_connection() as conn:
        c = conn.cursor()
        row = c.execute(
            "SELECT id, score FROM scores "
            "WHERE teacher_username=? AND grade=? AND class_name=? AND student_name=?",
            (teacher, grade, cls_display, name),
        ).fetchone()
        if row:
            total = int(row[1] or 0) + delta
            c.execute(
                "UPDATE scores SET score=?, updated_at=datetime('now', 'localtime'), "
                "grade_id=COALESCE(grade_id, ?), class_id=COALESCE(class_id, ?) WHERE id=?",
                (total, gid, cid, row[0]),
            )
        else:
            total = delta
            c.execute(
                "INSERT INTO scores (teacher_username, grade, class_name, student_name, score, "
                "updated_at, grade_id, class_id) VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'), ?, ?)",
                (teacher, grade, cls_display, name, total, gid, cid),
            )
        c.execute(
            "INSERT INTO score_logs (op_id, teacher_username, student_username, grade, class_name, "
            "student_name, points, reason, undone, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))",
            (op_id, teacher, student_username, grade, cls_display, name, delta, reason,
             1 if log_undone else 0),
        )
        if mark_undone_id is not None:
            c.execute("UPDATE score_logs SET undone=1 WHERE id=?", (mark_undone_id,))
        conn.commit()
    return total


def load_score_logs(teacher: str, grade: str = "", cls_display: str = "",
                    name: str = "", limit: int = 200) -> list[dict]:
    """积分流水（倒序）。teacher 为空表示不限教师（管理员看全校）。"""
    sql = (
        "SELECT id, op_id, teacher_username, student_username, grade, class_name, student_name, "
        "points, reason, undone, created_at FROM score_logs WHERE 1=1"
    )
    params: list = []
    if teacher:
        sql += " AND teacher_username=?"
        params.append(teacher)
    if grade:
        sql += " AND grade=?"
        params.append(grade)
    if cls_display:
        sql += " AND class_name=?"
        params.append(cls_display)
    if name:
        sql += " AND student_name=?"
        params.append(name)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(max(1, min(int(limit or 200), 1000)))
    rows = execute_query(sql, tuple(params))
    keys = ["id", "op_id", "teacher", "student_username", "grade", "class_name", "name",
            "points", "reason", "undone", "created_at"]
    return [dict(zip(keys, r)) for r in rows]
