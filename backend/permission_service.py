"""
统一权限服务
教师年级/班级权限的唯一入口，替代散落的 _parse_teacher_grade_class

核心原则:
- 管理员 (role=0): 全局权限，不查 teacher_assignments
- 教师 (role=1): 查 teacher_assignments 表
- 学生 (role=2): 查自身 grade_id/class_id 与教师匹配
"""
from typing import Any, Optional

from backend.database import execute_query, execute_insert_update, get_connection, execute_query_dict
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
        """SELECT c.id, c.grade_id, c.name, c.display_name, c.sort_order
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
