"""
统一权限服务
教师年级/班级权限的唯一入口，替代散落的 _parse_teacher_grade_class

核心原则:
- 管理员 (role=0): 全局权限，不查 teacher_assignments
- 教师 (role=1): 查 teacher_assignments 表
- 学生 (role=2): 查自身 grade_id/class_id 与教师匹配
"""
import sqlite3
from typing import Any, Optional

from backend.database import execute_query, execute_insert_update, get_connection, execute_query_dict, DB_PATH
from backend.logger import logger
from backend.auth import ROLE_ADMIN, ROLE_TEACHER, ROLE_STUDENT


# ═══════════════════════════════════════════════════════════════
# 年级主数据
# ═══════════════════════════════════════════════════════════════

def get_all_grades(stage: str | None = None) -> list[dict[str, Any]]:
    """获取所有年级，可按学段筛选"""
    if stage:
        rows = execute_query_dict(
            "SELECT id, name, stage, sort_order FROM grades WHERE is_active=1 AND stage=? ORDER BY sort_order",
            (stage,),
        )
    else:
        rows = execute_query_dict(
            "SELECT id, name, stage, sort_order FROM grades WHERE is_active=1 ORDER BY sort_order",
        )
    return rows


def get_all_stages() -> list[str]:
    """获取所有学段"""
    rows = execute_query(
        "SELECT DISTINCT stage FROM grades WHERE is_active=1 AND stage!='' ORDER BY stage"
    )
    return [r[0] for r in rows]


def get_user_grade_class(username: str) -> tuple[str, str]:
    """查询用户的年级(grade)和班级(class)"""
    rows = execute_query(
        "SELECT grade, class FROM users WHERE username=?",
        (username,),
    )
    if rows and rows[0]:
        return str(rows[0][0] or ""), str(rows[0][1] or "")
    return "", ""


def upsert_grade(name: str, stage: str = "", sort_order: int = 0) -> int:
    """查找或创建年级，返回 grade_id"""
    rows = execute_query("SELECT id FROM grades WHERE name=?", (name,))
    if rows:
        return rows[0][0]
    # 自动推断学段
    if not stage:
        stage = _infer_stage(name)
    # 自动推断排序
    if not sort_order:
        sort_order = _infer_sort_order(name, stage)
    with get_connection() as conn:
        c = conn.cursor()
        c.execute(
            "INSERT INTO grades (name, stage, sort_order) VALUES (?, ?, ?)",
            (name, stage, sort_order),
        )
        conn.commit()
        assert c.lastrowid is not None
        return c.lastrowid


def get_grade_by_id(grade_id: int) -> dict[str, Any] | None:
    rows = execute_query_dict("SELECT id, name, stage, sort_order FROM grades WHERE id=?", (grade_id,))
    return rows[0] if rows else None


def get_grade_by_name(name: str) -> dict[str, Any] | None:
    rows = execute_query_dict("SELECT id, name, stage, sort_order FROM grades WHERE name=?", (name,))
    return rows[0] if rows else None


def _infer_stage(name: str) -> str:
    """根据年级名称自动推断学段"""
    if not name:
        return ""
    # 小学: 一年级~六年级 或 1年级~6年级
    for i in range(1, 7):
        if f"{i}" in name or f"{'一二三四五六'[i-1]}" in name:
            if "年级" in name or "年" in name:
                return "小学"
    # 初中: 初一~初三, 七年级~九年级
    if any(k in name for k in ["初", "七", "八", "九"]):
        return "初中"
    # 高中: 高一~高三
    if "高" in name:
        return "高中"
    return ""


def _infer_sort_order(name: str, stage: str) -> int:
    """根据年级名称推断排序"""
    base = {"小学": 10, "初中": 30, "高中": 50}.get(stage, 0)
    # 提取数字
    import re
    nums = re.findall(r'\d+', name)
    if nums:
        return base + int(nums[0]) * 2
    # 中文数字映射
    cn_map = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6,
              "七": 7, "八": 8, "九": 9}
    for cn, num in cn_map.items():
        if cn in name:
            return base + num * 2
    return base


# ═══════════════════════════════════════════════════════════════
# 班级主数据
# ═══════════════════════════════════════════════════════════════

def get_all_classes(grade_id: int) -> list[dict[str, Any]]:
    """获取某年级下的所有班级"""
    return execute_query_dict(
        "SELECT id, grade_id, name, display_name, sort_order FROM classes WHERE grade_id=? ORDER BY sort_order",
        (grade_id,),
    )


def upsert_class(grade_id: int, name: str, display_name: str = "") -> int:
    """查找或创建班级，返回 class_id"""
    rows = execute_query("SELECT id FROM classes WHERE grade_id=? AND name=?", (grade_id, name))
    if rows:
        return rows[0][0]
    # 生成 display_name
    if not display_name:
        grade_info = get_grade_by_id(grade_id)
        grade_name = grade_info["name"] if grade_info else ""
        # 如果 name 已包含"班"，直接拼接；否则加"班"后缀
        if "班" in name:
            display_name = f"{grade_name}{name}"
        else:
            display_name = f"{grade_name}{name}班"
    # 自动排序
    import re
    nums = re.findall(r'\d+', name)
    sort_order = int(nums[0]) * 2 if nums else 0
    with get_connection() as conn:
        c = conn.cursor()
        c.execute(
            "INSERT INTO classes (grade_id, name, display_name, sort_order) VALUES (?, ?, ?, ?)",
            (grade_id, name, display_name, sort_order),
        )
        conn.commit()
        assert c.lastrowid is not None
        return c.lastrowid


def get_class_by_id(class_id: int) -> dict[str, Any] | None:
    rows = execute_query_dict(
        "SELECT id, grade_id, name, display_name, sort_order FROM classes WHERE id=?", (class_id,)
    )
    return rows[0] if rows else None


def get_class_by_name(grade_id: int, name: str) -> dict[str, Any] | None:
    rows = execute_query_dict(
        "SELECT id, grade_id, name, display_name, sort_order FROM classes WHERE grade_id=? AND name=?",
        (grade_id, name),
    )
    return rows[0] if rows else None


# ═══════════════════════════════════════════════════════════════
# 教师任教关系
# ═══════════════════════════════════════════════════════════════

def get_teacher_assignments(teacher_username: str) -> list[dict[str, Any]]:
    """获取教师的所有任教关系"""
    return execute_query_dict(
        """SELECT ta.id, ta.teacher_username, ta.grade_id, ta.class_id, ta.subject,
                  g.name AS grade_name, g.stage,
                  c.name AS class_name, c.display_name AS class_display_name
           FROM teacher_assignments ta
           JOIN grades g ON ta.grade_id = g.id
           LEFT JOIN classes c ON ta.class_id = c.id
           WHERE ta.teacher_username = ?
           ORDER BY g.sort_order, c.sort_order""",
        (teacher_username,),
    )


def get_teacher_subjects(teacher_username: str) -> list[str]:
    """获取教师的任教学科列表（去重），管理员返回系统全部学科"""
    from backend.auth import is_admin
    if is_admin(teacher_username):
        from backend.subject_config import get_subjects
        return get_subjects()
    rows = execute_query_dict(
        "SELECT DISTINCT subject FROM teacher_assignments WHERE teacher_username=? AND subject!=''",
        (teacher_username,),
    )
    return [r['subject'] for r in rows]


def get_teacher_grades(teacher_username: str) -> list[dict[str, Any]]:
    """教师任教的年级列表（去重），管理员返回全部"""
    from backend.auth import is_admin
    if is_admin(teacher_username):
        return get_all_grades()
    return execute_query_dict(
        """SELECT DISTINCT g.id, g.name, g.stage, g.sort_order
           FROM teacher_assignments ta
           JOIN grades g ON ta.grade_id = g.id
           WHERE ta.teacher_username = ?
           ORDER BY g.sort_order""",
        (teacher_username,),
    )


def get_teacher_classes(teacher_username: str, grade_id: int) -> list[dict[str, Any]]:
    """教师在指定年级的任教班级，class_id=NULL 表示该年级全部班级"""
    from backend.auth import is_admin
    if is_admin(teacher_username):
        return get_all_classes(grade_id)

    rows = execute_query(
        "SELECT class_id FROM teacher_assignments WHERE teacher_username=? AND grade_id=? AND class_id IS NULL",
        (teacher_username, grade_id),
    )
    if rows:
        return get_all_classes(grade_id)

    return execute_query_dict(
        """SELECT DISTINCT c.id, c.grade_id, c.name, c.display_name, c.sort_order
           FROM teacher_assignments ta
           JOIN classes c ON ta.class_id = c.id
           WHERE ta.teacher_username = ? AND ta.grade_id = ?
           ORDER BY c.sort_order""",
        (teacher_username, grade_id),
    )


def assign_teacher(teacher_username: str, grade_id: int, class_id: int | None = None, subject: str = ""):
    """为教师添加任教关系（幂等）"""
    execute_insert_update(
        """INSERT OR IGNORE INTO teacher_assignments (teacher_username, grade_id, class_id, subject)
           VALUES (?, ?, ?, ?)""",
        (teacher_username, grade_id, class_id, subject),
    )


def remove_teacher_assignment(teacher_username: str, grade_id: int, class_id: int | None = None):
    """移除教师的任教关系"""
    if class_id is None:
        execute_insert_update(
            "DELETE FROM teacher_assignments WHERE teacher_username=? AND grade_id=? AND class_id IS NULL",
            (teacher_username, grade_id),
        )
    else:
        execute_insert_update(
            "DELETE FROM teacher_assignments WHERE teacher_username=? AND grade_id=? AND class_id=?",
            (teacher_username, grade_id, class_id),
        )


def clear_teacher_assignments(teacher_username: str):
    """清除教师所有任教关系（用于重新导入）"""
    execute_insert_update(
        "DELETE FROM teacher_assignments WHERE teacher_username=?",
        (teacher_username,),
    )


# ═══════════════════════════════════════════════════════════════
# 权限检查（统一入口）
# ═══════════════════════════════════════════════════════════════

def can_access_grade(username: str, grade_id: int) -> bool:
    """用户是否有权限访问该年级"""
    from backend.auth import is_admin
    if is_admin(username):
        return True
    rows = execute_query(
        "SELECT 1 FROM teacher_assignments WHERE teacher_username=? AND grade_id=?",
        (username, grade_id),
    )
    return len(rows) > 0


def can_access_class(username: str, grade_id: int, class_id: int) -> bool:
    """用户是否有权限访问该班级"""
    from backend.auth import is_admin
    if is_admin(username):
        return True
    rows = execute_query(
        "SELECT 1 FROM teacher_assignments WHERE teacher_username=? AND grade_id=? AND class_id=?",
        (username, grade_id, class_id),
    )
    if rows:
        return True
    rows = execute_query(
        "SELECT 1 FROM teacher_assignments WHERE teacher_username=? AND grade_id=? AND class_id IS NULL",
        (username, grade_id),
    )
    return len(rows) > 0


def is_student_in_teacher_scope(student_username: str, teacher_username: str) -> bool:
    """判断学生是否在教师的管辖范围内"""
    from backend.auth import is_admin
    if is_admin(teacher_username):
        return True
    student = execute_query_dict(
        "SELECT grade_id, class_id FROM users WHERE username=?", (student_username,)
    )
    if not student or not student[0].get("grade_id"):
        return False
    s = student[0]
    return can_access_class(teacher_username, s["grade_id"], s.get("class_id") or 0)


def get_students_in_scope(username: str, grade_id: int | None = None, class_id: int | None = None) -> list[dict[str, Any]]:
    """获取用户管辖范围内的学生"""
    from backend.auth import is_admin
    if is_admin(username):
        # 管理员：可筛选
        conditions = ["u.role=2"]
        params = []
        if grade_id:
            conditions.append("u.grade_id=?")
            params.append(grade_id)
        if class_id:
            conditions.append("u.class_id=?")
            params.append(class_id)
        where = " AND ".join(conditions)
        return execute_query_dict(
            f"SELECT u.username, u.name, u.grade, u.class, u.grade_id, u.class_id FROM users u WHERE {where} ORDER BY u.grade, u.class, u.name",
            tuple(params),
        )

    # 教师：只返回自己任教范围内的学生
    assignments = get_teacher_assignments(username)
    if not assignments:
        return []

    result = []
    seen = set()
    for a in assignments:
        gid = a["grade_id"]
        if grade_id and gid != grade_id:
            continue
        cid = a.get("class_id")
        if class_id and cid != class_id:
            continue

        if cid is None:
            # 该年级全部学生
            students = execute_query_dict(
                "SELECT u.username, u.name, u.grade, u.class, u.grade_id, u.class_id FROM users u WHERE u.role=2 AND u.grade_id=?",
                (gid,),
            )
        else:
            students = execute_query_dict(
                "SELECT u.username, u.name, u.grade, u.class, u.grade_id, u.class_id FROM users u WHERE u.role=2 AND u.grade_id=? AND u.class_id=?",
                (gid, cid),
            )
        for s in students:
            if s["username"] not in seen:
                seen.add(s["username"])
                result.append(s)
    return result


# ═══════════════════════════════════════════════════════════════
# 通用师生关系查询（替代旧的 users.grade/class 字符串匹配）
# ═══════════════════════════════════════════════════════════════

def get_teachers_for_student(student_username: str) -> list[str]:
    """获取某学生的所有任教教师用户名列表（通过 teacher_assignments）"""
    student = execute_query_dict(
        "SELECT grade_id, class_id FROM users WHERE username=?",
        (student_username,),
    )
    if not student or not student[0].get("grade_id"):
        return []
    s = student[0]
    gid = s["grade_id"]
    cid = s.get("class_id")
    if cid:
        rows = execute_query_dict(
            """SELECT DISTINCT teacher_username FROM teacher_assignments
               WHERE grade_id=? AND (class_id=? OR class_id IS NULL)""",
            (gid, cid),
        )
    else:
        rows = execute_query_dict(
            """SELECT DISTINCT teacher_username FROM teacher_assignments
               WHERE grade_id=?""",
            (gid,),
        )
    return [r["teacher_username"] for r in rows]


def check_teacher_access_to_student(
    teacher_username: str,
    student_username: str,
) -> bool:
    """判断教师是否有权限访问该学生数据（通过 teacher_assignments）"""
    return is_student_in_teacher_scope(student_username, teacher_username)


# ═══════════════════════════════════════════════════════════════
# 活动目标范围工具（统一入口）
# ═══════════════════════════════════════════════════════════════

def get_students_by_scope(
    creator_username: str,
    target_scope: str = "teacher_classes",
    target_grade: str = "",
    target_class: str = "",
    target_users: str = "",
) -> list[dict[str, Any]]:
    """
    根据目标范围参数获取对应的学生列表

    target_scope 取值:
      'all'             - 全体学生
      'teacher_classes' - 教师任教的所有班级（默认）
      'grade'           - 指定年级（target_grade）
      'class'           - 指定班级（target_grade + target_class）
      'individual'      - 定向学生（target_users，逗号分隔用户名）
    """
    from backend.auth import is_admin

    # 兼容旧数据：target_scope 为 NULL/空字符串时视为 teacher_classes
    if not target_scope:
        target_scope = "teacher_classes"

    # 管理员创建的活动，默认全体可见
    if target_scope == "all" or target_scope == "teacher_classes" and is_admin(creator_username):
        return execute_query_dict(
            "SELECT u.username, u.name, u.grade, u.class, u.grade_id, u.class_id FROM users u WHERE u.role=2 ORDER BY u.grade, u.class, u.name"
        )

    if target_scope == "teacher_classes":
        # 按教师任教班级查询
        return get_students_in_scope(creator_username)

    if target_scope == "grade":
        if not target_grade:
            return get_students_in_scope(creator_username)
        # 指定年级
        grades = [g.strip() for g in target_grade.split(",") if g.strip()]
        students = []
        seen = set()
        for g_name in grades:
            rows = execute_query_dict(
                "SELECT u.username, u.name, u.grade, u.class, u.grade_id, u.class_id FROM users u WHERE u.role=2 AND u.grade=?",
                (g_name,),
            )
            for s in rows:
                if s["username"] not in seen:
                    seen.add(s["username"])
                    students.append(s)
        return students

    if target_scope == "class":
        if not target_grade or not target_class:
            return get_students_in_scope(creator_username)
        # 指定班级（支持多班级逗号分隔）
        grades = [g.strip() for g in target_grade.split(",") if g.strip()]
        classes = [c.strip() for c in target_class.split(",") if c.strip()]
        students = []
        seen = set()
        import re
        for g_name in grades:
            for c_name in classes:
                c_num = re.sub(r'[^\d]', '', c_name) if c_name else ''
                rows = execute_query_dict(
                    """SELECT u.username, u.name, u.grade, u.class, u.grade_id, u.class_id
                       FROM users u WHERE u.role=2 AND u.grade=? AND (u.class=? OR u.class=?)""",
                    (g_name, c_name, c_num),
                )
                for s in rows:
                    if s["username"] not in seen:
                        seen.add(s["username"])
                        students.append(s)
        return students

    if target_scope == "individual":
        if not target_users:
            return get_students_in_scope(creator_username)
        # 定向学生
        usernames = [u.strip() for u in target_users.split(",") if u.strip()]
        if not usernames:
            return get_students_in_scope(creator_username)
        placeholders = ",".join("?" for _ in usernames)
        return execute_query_dict(
            f"SELECT u.username, u.name, u.grade, u.class, u.grade_id, u.class_id FROM users u WHERE u.role=2 AND u.username IN ({placeholders})",
            tuple(usernames),
        )

    # 安全默认值：回退到教师任教班级
    return get_students_in_scope(creator_username)


def get_student_identity(usernames: list) -> dict:
    """批量解析学生的 姓名/年级/班级(规范名)。

    年级班级优先取 grades/classes 规范表, 再回退 users 的遗留文本列;
    遗留列里班级可能只存数字("1"), 统一补成"高一1班"这种可读形式。
    """
    names = [str(x or "").strip() for x in usernames]
    names = [n for n in dict.fromkeys(names) if n]
    out: dict[str, dict[str, str]] = {}
    if not names:
        return out
    ph = ",".join("?" for _ in names)
    rows = execute_query_dict(
        f"""SELECT u.username, u.name,
                   COALESCE(g.name, u.grade, '') AS grade_name,
                   COALESCE(c.display_name, c.name, u.class, '') AS class_name
            FROM users u
            LEFT JOIN grades g ON u.grade_id = g.id
            LEFT JOIN classes c ON u.class_id = c.id
            WHERE u.username IN ({ph})""",
        tuple(names),
    )
    for r in rows or []:
        grade = str(r.get("grade_name") or "").strip()
        cls = str(r.get("class_name") or "").strip()
        if cls.isdigit():
            cls = f"{grade}{cls}班" if grade else f"{cls}班"
        if grade and cls.startswith(grade):
            tag = cls
        elif grade and cls:
            tag = f"{grade}·{cls}"
        else:
            tag = grade or cls
        out[str(r["username"])] = {
            "name": str(r.get("name") or r["username"]),
            "grade": grade, "class": cls, "tag": tag,
        }
    return out


def attach_student_info(rows: list, key: str = "username", prefix: str = "",
                        overwrite: bool = False) -> list:
    """给响应里的每一行补 姓名/年级/班级, 供各管理面直接展示。

    只增列不改语义; 已存在且非空的字段默认不覆盖(overwrite=True 时覆盖,
    用于把 class_name 这类"数字班级"纠正成规范名)。
    """
    if not rows:
        return rows
    ident = get_student_identity([r.get(key) for r in rows if isinstance(r, dict)])
    for r in rows:
        if not isinstance(r, dict):
            continue
        info = ident.get(str(r.get(key) or "")) or {}
        for fld, val in (("name", info.get("name", "")), ("grade", info.get("grade", "")),
                         ("class_name", info.get("class", ""))):
            k = prefix + fld
            if overwrite or not r.get(k):
                r[k] = val
    return rows


def check_activity_visibility(
    student_username: str,
    student_grade: str,
    student_class: str,
    creator_username: str,
    target_scope: str = "teacher_classes",
    target_grade: str = "",
    target_class: str = "",
    target_users: str = "",
) -> bool:
    """
    判断某学生对某个活动的可见性
    用于学生端列表过滤
    """
    from backend.auth import is_admin

    # 兼容旧数据：target_scope 为 NULL/空字符串时视为 teacher_classes
    if not target_scope:
        target_scope = "teacher_classes"

    if target_scope == "all":
        return True

    if target_scope == "teacher_classes":
        # 判断学生是否在教师的任教范围内
        return is_student_in_teacher_scope(student_username, creator_username)

    if target_scope == "grade":
        if not target_grade:
            # 未指定具体年级时回退到教师任教班级
            return is_student_in_teacher_scope(student_username, creator_username)
        target_grades = [g.strip() for g in target_grade.split(",") if g.strip()]
        return student_grade in target_grades

    if target_scope == "class":
        if not target_grade or not target_class:
            # 未指定具体年级/班级时回退到教师任教班级
            return is_student_in_teacher_scope(student_username, creator_username)
        target_grades = [g.strip() for g in target_grade.split(",") if g.strip()]
        target_classes = [c.strip() for c in target_class.split(",") if c.strip()]
        if student_grade not in target_grades:
            return False
        # 班级名支持精确匹配或数字提取
        import re
        for tc in target_classes:
            if student_class == tc:
                return True
            tc_num = re.sub(r'[^\d]', '', tc)
            if tc_num and student_class == tc_num:
                return True
            if tc_num and student_class == f"{tc_num}班":
                return True
        return False

    if target_scope == "individual":
        if not target_users:
            return is_student_in_teacher_scope(student_username, creator_username)
        usernames = [u.strip() for u in target_users.split(",") if u.strip()]
        return student_username in usernames

    # 安全的默认值：回退到教师任教班级匹配（而非全体可见）
    return is_student_in_teacher_scope(student_username, creator_username)


def filter_activities_by_scope(
    activities: list[dict[str, Any]],
    student_username: str,
) -> list[dict[str, Any]]:
    """
    对学生可见的活动列表按目标范围过滤
    每个 activity dict 需包含:
      creator_username, target_scope, target_grade, target_class, target_users
    """
    # 查询学生的年级班级
    student_rows = execute_query_dict(
        "SELECT grade, class FROM users WHERE username=?",
        (student_username,),
    )
    if not student_rows:
        return activities  # 查不到学生信息则全部返回（兼容）
    student_grade = str(student_rows[0].get("grade") or "").strip()
    student_class = str(student_rows[0].get("class") or "").strip()

    result = []
    for act in activities:
        if check_activity_visibility(
            student_username,
            student_grade,
            student_class,
            act.get("creator_username", ""),
            act.get("target_scope", "teacher_classes"),
            act.get("target_grade", ""),
            act.get("target_class", ""),
            act.get("target_users", ""),
        ):
            result.append(act)
    return result


# ═══════════════════════════════════════════════════════════════
# 旧格式兼容（迁移期使用）
# ═══════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════
# 共享资源权限检查（统一入口）
# ═══════════════════════════════════════════════════════════════

def _resolve_class_id_flexible(grade_id: int, class_name: str) -> int | None:
    """灵活解析班级名称到 class_id，支持 name/display_name/纯数字 三种格式"""
    if not class_name:
        return None
    # 1) 精确匹配 name
    row = execute_query_dict(
        "SELECT id FROM classes WHERE grade_id=? AND name=?", (grade_id, class_name)
    )
    if row:
        return row[0]["id"]
    # 2) 精确匹配 display_name
    row = execute_query_dict(
        "SELECT id FROM classes WHERE grade_id=? AND display_name=?", (grade_id, class_name)
    )
    if row:
        return row[0]["id"]
    # 3) 提取数字匹配 name 为 "X班"
    import re
    nums = re.findall(r'\d+', class_name)
    if nums:
        name_candidate = f"{nums[0]}班"
        row = execute_query_dict(
            "SELECT id FROM classes WHERE grade_id=? AND name=?", (grade_id, name_candidate)
        )
        if row:
            return row[0]["id"]
    return None


def _teacher_can_access_scope(
    teacher_username: str,
    target_grades: list[str],
    target_classes: list[str],
) -> bool:
    """检查教师是否有权限看到某个年级/班级范围的共享资源

    教师如果任教该年级（或该年级下的具体班级），则对该范围的资源共享可见。
    班级名称支持 name/display_name/纯数字 三种格式的匹配。
    """
    assignments = get_teacher_assignments(teacher_username)
    if not assignments:
        return False

    # 收集教师任教的年级ID集合和 年级→班级 映射
    teacher_grade_ids = set()
    teacher_grade_classes: dict[int, set[int | None]] = {}
    for a in assignments:
        gid = a["grade_id"]
        teacher_grade_ids.add(gid)
        cid = a.get("class_id")  # None 表示整个年级
        if gid not in teacher_grade_classes:
            teacher_grade_classes[gid] = set()
        teacher_grade_classes[gid].add(cid)

    for g_name in target_grades:
        grade_info = get_grade_by_name(g_name)
        if not grade_info:
            continue
        gid = grade_info["id"]
        # 教师不任教该年级
        if gid not in teacher_grade_ids:
            continue
        # 没有指定班级 → 教师任教该年级（整个年级或部分班级都算）
        if not target_classes:
            return True
        # 有指定班级：检查教师是否任教这些班级
        for c_name in target_classes:
            # 教师在该年级有全部班级权限
            if None in teacher_grade_classes.get(gid, set()):
                return True
            class_id = _resolve_class_id_flexible(gid, c_name)
            if class_id and class_id in teacher_grade_classes.get(gid, set()):
                return True
    return False


def check_share_visibility(
    viewer_username: str,
    share_scope: str,
    target_users_csv: str = "",
    target_grade_csv: str = "",
    target_class_csv: str = "",
) -> bool:
    """
    统一检查共享资源对用户的可见性

    这是共享权限的统一入口函数，所有共享资源的可见性判断都应通过此函数。
    替代 sharing_router 中分散的 _check_share_scope 逻辑。

    参数:
        viewer_username: 查看共享资源的用户名
        share_scope: 共享范围 ('all', 'staff', 'teacher', 'class')
        target_users_csv: 逗号分隔的目标用户名列表
        target_grade_csv: 逗号分隔的目标年级名称列表
        target_class_csv: 逗号分隔的目标班级名称列表

    返回:
        True 表示用户对该资源可见
    """
    from backend.auth import is_admin

    # ── scope='all': 所有人可见 ──
    if share_scope == 'all':
        return True

    # 获取查看者信息
    viewer_rows = execute_query_dict(
        "SELECT username, grade, class, role, grade_id, class_id FROM users WHERE username=?",
        (viewer_username,),
    )
    if not viewer_rows:
        return False
    v = viewer_rows[0]
    viewer_role = v["role"]
    viewer_grade_str = str(v["grade"] or "")
    viewer_class_str = str(v["class"] or "")
    viewer_grade_id = v.get("grade_id")
    viewer_class_id = v.get("class_id")

    # ── scope='staff': 管理员和教师可见 ──
    if share_scope == 'staff':
        return viewer_role in (ROLE_ADMIN, ROLE_TEACHER)

    # 解析 CSV 为目标列表
    target_users = [u.strip() for u in target_users_csv.split(",") if u.strip()] if target_users_csv else []
    target_grades = [g.strip() for g in target_grade_csv.split(",") if g.strip()] if target_grade_csv else []
    target_classes = [c.strip() for c in target_class_csv.split(",") if c.strip()] if target_class_csv else []

    # ── scope='teacher': 检查 target_users 或年级/班级匹配 ──
    if share_scope == 'teacher':
        # 直接用户匹配
        if viewer_username in target_users:
            return True
        # 组合共享: 同时指定了年级和班级时匹配学生
        if viewer_role == ROLE_STUDENT and target_grades and target_classes:
            return _match_grade_class(
                viewer_grade_str, viewer_class_str,
                viewer_grade_id, viewer_class_id,
                target_grades, target_classes,
            )
        return False

    # ── scope='class': 年级/班级匹配 ──
    if share_scope == 'class':
        if not target_grades:
            return False

        # 管理员：可见所有按年级/班级共享的资源
        if viewer_role == ROLE_ADMIN:
            return True

        # 教师：检查是否任教该年级/班级
        if viewer_role == ROLE_TEACHER:
            return _teacher_can_access_scope(
                viewer_username, target_grades, target_classes
            )

        # 学生：按年级/班级匹配
        return _match_grade_class(
            viewer_grade_str, viewer_class_str,
            viewer_grade_id, viewer_class_id,
            target_grades, target_classes,
        )

    return False


def _match_grade_class(
    viewer_grade_str: str,
    viewer_class_str: str,
    viewer_grade_id: int | None,
    viewer_class_id: int | None,
    target_grades: list[str],
    target_classes: list[str],
) -> bool:
    """匹配用户的年级/班级是否在目标列表中（支持名称和 ID 双重匹配）"""
    # 年级匹配（名称）
    grade_ok = viewer_grade_str in target_grades
    # 年级匹配（ID）
    if not grade_ok and viewer_grade_id:
        for g_name in target_grades:
            grade_info = get_grade_by_name(g_name)
            if grade_info and grade_info["id"] == viewer_grade_id:
                grade_ok = True
                break

    if not grade_ok:
        return False

    # 如果未指定班级，表示该年级所有班级可见
    if not target_classes:
        return True

    # 班级匹配（名称）
    class_ok = viewer_class_str in target_classes
    # 班级匹配（ID，支持 name/display_name/纯数字）
    if not class_ok and viewer_class_id and viewer_grade_id:
        for c_name in target_classes:
            resolved_id = _resolve_class_id_flexible(viewer_grade_id, c_name)
            if resolved_id and resolved_id == viewer_class_id:
                class_ok = True
                break

    return class_ok


# ═══════════════════════════════════════════════════════════════
# 批量升年级
# ═══════════════════════════════════════════════════════════════

def build_grade_promotion_map() -> dict[int, dict[str, Any] | None]:
    """构建年级升迁映射

    按学段分组，按 sort_order 排序，相邻年级互为升迁关系。
    返回 {grade_id: next_grade_info | None}
    - next_grade_info: dict {id, name, stage, sort_order} 升级目标年级
    - None: 该年级已是本学段最高级（毕业年级）
    """
    from collections import defaultdict

    rows = execute_query_dict(
        "SELECT id, name, stage, sort_order FROM grades WHERE is_active=1 ORDER BY stage, sort_order"
    )
    stage_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        stage_groups[r["stage"]].append(r)

    promotion_map: dict[int, dict[str, Any] | None] = {}
    for stage, group in stage_groups.items():
        group.sort(key=lambda x: x["sort_order"])
        for i, g in enumerate(group):
            if i + 1 < len(group):
                promotion_map[g["id"]] = group[i + 1]
            else:
                promotion_map[g["id"]] = None  # 毕业年级
    return promotion_map


def _resolve_grade_name(grade_id: int | None, grade_text: str | None) -> str:
    """根据 grade_id 或 grade 文本解析年级名称，兜底返回未知"""
    if grade_id:
        row = execute_query("SELECT name FROM grades WHERE id=?", (grade_id,))
        if row:
            return row[0][0]
    if grade_text:
        return grade_text
    return "未知"


def preview_grade_promotion() -> dict[str, Any]:
    """预览升年级影响

    返回:
    {
        "promotion_map": {grade_name: next_grade_name | "(毕业)"},
        "grade_details": [{grade, count, classes, next_grade, next_grade_id}],
        "total_students": int,
    }
    """
    prom_map = build_grade_promotion_map()

    # 查出所有学生（role=2），包括 grade_id 为 NULL 的
    students = execute_query_dict(
        "SELECT u.grade_id, u.grade, u.class, COUNT(*) as cnt FROM users u WHERE u.role=2 GROUP BY u.grade_id, u.grade, u.class"
    )

    # 按 grade_id 聚合（grade_id 为 NULL 的按 grade 文本聚合）
    from collections import defaultdict
    grade_agg: dict[str, dict[str, Any]] = {}
    for s in students:
        gid = s["grade_id"]
        # 用 resolve 拿到统一的年级名
        g_name = _resolve_grade_name(gid, s["grade"])
        if g_name not in grade_agg:
            grade_agg[g_name] = {
                "grade": g_name,
                "grade_id": gid,
                "count": 0,
                "classes": set(),
            }
        grade_agg[g_name]["count"] += s["cnt"]
        cls_val = s["class"]
        if cls_val is not None and cls_val != "":
            grade_agg[g_name]["classes"].add(str(cls_val))

    # 构建可读的映射
    readable_map: dict[str, str | None] = {}
    grade_details = []
    for g_name, info in grade_agg.items():
        gid = info["grade_id"]
        next_info = prom_map.get(gid) if gid else None
        if next_info is not None:
            next_name = next_info["name"]
            next_id = next_info["id"]
        else:
            next_name = None  # 毕业
            next_id = None
        readable_map[g_name] = next_name
        grade_details.append({
            "grade": g_name,
            "grade_id": gid,
            "count": info["count"],
            "classes": sorted(info["classes"]),
            "next_grade": next_name,
            "next_grade_id": next_id,
        })

    # 排序：按 sort_order
    grade_order = {
        r["name"]: r["sort_order"]
        for r in execute_query_dict("SELECT name, sort_order FROM grades")
    }
    grade_details.sort(key=lambda x: grade_order.get(x["grade"], 999))

    total_students = sum(d["count"] for d in grade_details)

    return {
        "promotion_map": readable_map,
        "grade_details": grade_details,
        "total_students": total_students,
    }


def build_reverse_grade_promotion_map() -> dict[int, dict[str, Any] | None]:
    """构建降级映射（升级的逆操作）

    将 build_grade_promotion_map 的映射倒转，并补齐各学段最低年级（不可再降）：
    - 原映射 {旧年级ID: 新年级信息}
    - 反映射 {新年级ID: 旧年级信息}
    - 毕业年级（原映射值为 None）不参与降级
    - 起点年级（无更低年级可降）映射为 None
    """
    forward = build_grade_promotion_map()
    reverse: dict[int, dict[str, Any] | None] = {}

    # 第一步：翻转映射（新年级→旧年级）
    for old_gid, next_info in forward.items():
        if next_info is None:
            continue  # 毕业年级本身不可降
        old_name = _resolve_grade_name(old_gid, None)
        reverse[next_info["id"]] = {
            "id": old_gid,           # 降级后的目标 grade_id
            "name": old_name,         # 降级后的目标年级名称
            "stage": next_info.get("stage", ""),
            "sort_order": next_info.get("sort_order", 0) - 2,
        }

    # 第二步：补齐起点年级（不在 reverse keys 中且 forward 值非 None 的）→ None
    # 这些年级（如一年级、初一、高一）无法再降
    for gid, next_info in forward.items():
        if next_info is not None and gid not in reverse:
            reverse[gid] = None  # 已是最低年级，不可再降

    return reverse


def execute_grade_promotion(
    sync_scores: bool = True,
    sync_rollcall: bool = True,
    match_class: bool = True,
    dry_run: bool = False,
    prom_map: dict[int, dict[str, Any] | None] | None = None,
    direction: str = "up",
) -> dict[str, Any]:
    """执行批量升/降年级

    参数:
        sync_scores: 是否同步更新 scores 表
        sync_rollcall: 是否同步更新 rollcall_weights/rollcall_meta 表
        match_class: 是否按同名班级自动匹配新年级的 class_id
        dry_run: 仅预览不执行
        prom_map: 年级映射，None 则自动构建升年级映射（默认）；传入反向映射则为降级
        direction: "up" 升年级 / "down" 降级（影响返回标签）

    返回:
        {
            "success": bool,
            "direction": "up" | "down",
            "promoted": {grade_name: promoted_count},
            "not_moved": {grade_name: not_moved_count},
            "updated_users": int,
            "updated_scores": int,
            "updated_rollcall": int,
            "errors": [str]
        }
    """
    if prom_map is None:
        prom_map = build_grade_promotion_map()
    errors = []

    # ── 查出所有学生（role=2）──
    # 优先用 grade_id，若无则尝试通过 grade 名称反查
    students = execute_query_dict(
        """SELECT u.username, u.grade, u.grade_id, u.class, u.class_id
           FROM users u WHERE u.role=2"""
    )

    # 预加载 grade 名称→ID 映射（用于反查 grade_id 为 NULL 的学生）
    grade_name_to_id = {
        r["name"]: r["id"]
        for r in execute_query_dict("SELECT id, name FROM grades WHERE is_active=1")
    }

    # 分类统计
    promoted: dict[str, int] = {}
    not_moved: dict[str, int] = {}
    skipped: list[str] = []

    # ── 事务：所有 users 更新在一个事务中完成 ──
    if not dry_run:
        conn_outer = sqlite3.connect(str(DB_PATH), timeout=30)
        conn_outer.execute("PRAGMA journal_mode=WAL")
        conn_outer.execute("PRAGMA busy_timeout=30000")
        conn_outer.execute("BEGIN IMMEDIATE")
    else:
        conn_outer = None

    try:
        for stu in students:
            username = stu["username"]
            gid = stu["grade_id"]
            g_name_text = stu["grade"]

            # 若 grade_id 为空，尝试通过 grade 名称反查
            if not gid and g_name_text:
                g_name_str = str(g_name_text).strip()
                gid = grade_name_to_id.get(g_name_str)
                # 更新 users.grade_id 以便后续关联
                if gid and not dry_run:
                    assert conn_outer is not None
                    c = conn_outer.cursor()
                    c.execute(
                        "UPDATE users SET grade_id=? WHERE username=?",
                        (gid, username),
                    )

            # 仍然没有 grade_id → 无法处理
            if not gid:
                skipped.append(username)
                continue

            next_info = prom_map.get(gid)
            if next_info is None:
                # 不可移动：升年级时是毕业年级，降级时是最低年级
                display_name = _resolve_grade_name(gid, g_name_text)
                not_moved[display_name] = not_moved.get(display_name, 0) + 1
                continue

            next_name = next_info["name"]
            next_id = next_info["id"]
            display_name = _resolve_grade_name(gid, g_name_text)
            promoted[display_name] = promoted.get(display_name, 0) + 1

            if dry_run:
                continue

            # 计算新班级 ID
            new_class_id = stu["class_id"]
            if match_class and stu["class"]:
                cls_name = str(stu["class"])
                if "班" not in cls_name:
                    cls_name = f"{cls_name}班"
                c = conn_outer.cursor()
                c.execute(
                    "SELECT id FROM classes WHERE grade_id=? AND name=?",
                    (next_id, cls_name),
                )
                row = c.fetchone()
                if row:
                    new_class_id = row[0]
                else:
                    new_class_id = None  # 新年级无同名班级
            elif not match_class:
                new_class_id = stu["class_id"]  # 保留原值

            c = conn_outer.cursor()
            c.execute(
                "UPDATE users SET grade=?, grade_id=?, class_id=? WHERE username=?",
                (next_name, next_id, new_class_id, username),
            )

        # 同步更新 scores
        updated_scores = 0
        if sync_scores and not dry_run:
            assert conn_outer is not None
            c = conn_outer.cursor()
            for old_gid, next_info in prom_map.items():
                if next_info is None:
                    continue
                next_name = next_info["name"]
                next_id = next_info["id"]
                # 通过 grade_id 匹配
                c.execute(
                    "SELECT COUNT(*) FROM scores WHERE grade_id=? AND grade_id IS NOT NULL",
                    (old_gid,),
                )
                updated_scores += c.fetchone()[0]
                c.execute(
                    "UPDATE scores SET grade=?, grade_id=? WHERE grade_id=? AND grade_id IS NOT NULL",
                    (next_name, next_id, old_gid),
                )
                # 兼容：grade 名称匹配（grade_id 为 NULL 的旧数据）
                old_name_row = c.execute(
                    "SELECT name FROM grades WHERE id=?", (old_gid,)
                ).fetchone()
                if old_name_row:
                    old_name = old_name_row[0]
                    c.execute(
                        "SELECT COUNT(*) FROM scores WHERE grade=? AND (grade_id IS NULL OR grade_id='')",
                        (old_name,),
                    )
                    updated_scores += c.fetchone()[0]
                    c.execute(
                        "UPDATE scores SET grade=? WHERE grade=? AND (grade_id IS NULL OR grade_id='')",
                        (next_name, old_name),
                    )

        # 同步更新 rollcall
        updated_rollcall = 0
        if sync_rollcall and not dry_run:
            assert conn_outer is not None
            c = conn_outer.cursor()
            for table in ["rollcall_weights", "rollcall_meta"]:
                for old_gid, next_info in prom_map.items():
                    if next_info is None:
                        continue
                    next_name = next_info["name"]
                    next_id = next_info["id"]
                    c.execute(
                        f"SELECT COUNT(*) FROM {table} WHERE grade_id=? AND grade_id IS NOT NULL",
                        (old_gid,),
                    )
                    updated_rollcall += c.fetchone()[0]
                    c.execute(
                        f"UPDATE {table} SET grade=?, grade_id=? WHERE grade_id=? AND grade_id IS NOT NULL",
                        (next_name, next_id, old_gid),
                    )

        # 提交事务
        if not dry_run:
            assert conn_outer is not None
            conn_outer.commit()

    except Exception as e:
        if conn_outer:
            conn_outer.rollback()
        logger.error(f"升年级事务失败，已回滚: {e}")
        return {
            "success": False,
            "direction": direction,
            "promoted": {},
            "not_moved": {},
            "updated_users": 0,
            "updated_scores": 0,
            "updated_rollcall": 0,
            "errors": [f"升年级失败，已全部回滚: {str(e)}"],
        }
    finally:
        if conn_outer:
            conn_outer.close()

    promoted_count = sum(promoted.values())

    result = {
        "success": True,
        "direction": direction,
        "promoted": promoted,
        "not_moved": not_moved,
        "updated_users": promoted_count,
        "updated_scores": updated_scores if sync_scores and not dry_run else 0,
        "updated_rollcall": updated_rollcall if sync_rollcall and not dry_run else 0,
        "errors": errors,
    }
    if skipped:
        result["skipped"] = skipped
        logger.warning(f"升年级跳过 {len(skipped)} 个无年级信息的学生: {skipped[:10]}...")
    return result


def parse_legacy_teacher_grade_class(grade: str, class_str: str) -> dict[str, list[str]]:
    """
    解析旧格式的教师年级/班级字符串
    输入: grade="高一|高二", class_str="1,2,3|4,5"
    输出: {"高一": ["1","2","3"], "高二": ["4","5"]}
    """
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


def migrate_legacy_teacher(username: str):
    """
    将旧格式的教师年级班级数据迁移到新表结构
    读取 users.grade 和 users.class 的管道格式，写入 teacher_assignments
    """
    rows = execute_query("SELECT grade, class FROM users WHERE username=?", (username,))
    if not rows:
        return
    grade_str = (rows[0][0] or "").strip()
    class_str = str(rows[0][1] or "").strip()

    if not grade_str:
        return

    gcm = parse_legacy_teacher_grade_class(grade_str, class_str)
    for grade_name, class_names in gcm.items():
        grade_id = upsert_grade(grade_name)
        if not class_names:
            # 该年级所有班级
            assign_teacher(username, grade_id, None)
        else:
            for cls_name in class_names:
                # 规范化班级名（补"班"后缀）
                if "班" not in cls_name:
                    cls_name = f"{cls_name}班"
                class_id = upsert_class(grade_id, cls_name)
                assign_teacher(username, grade_id, class_id)

    logger.info(f"教师 '{username}' 旧格式数据已迁移到 teacher_assignments")
