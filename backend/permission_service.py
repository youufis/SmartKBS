"""
统一权限服务
教师年级/班级权限的唯一入口，替代散落的 _parse_teacher_grade_class

核心原则:
- 管理员 (role=0): 全局权限，不查 teacher_assignments
- 教师 (role=1): 查 teacher_assignments 表
- 学生 (role=2): 查自身 grade_id/class_id 与教师匹配
"""
from typing import Optional

from backend.database import execute_query, execute_insert_update, get_connection, execute_query_dict
from backend.logger import logger


# ═══════════════════════════════════════════════════════════════
# 年级主数据
# ═══════════════════════════════════════════════════════════════

def get_all_grades(stage: str = None) -> list[dict]:
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
        return c.lastrowid


def get_grade_by_id(grade_id: int) -> dict | None:
    rows = execute_query_dict("SELECT id, name, stage, sort_order FROM grades WHERE id=?", (grade_id,))
    return rows[0] if rows else None


def get_grade_by_name(name: str) -> dict | None:
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

def get_all_classes(grade_id: int) -> list[dict]:
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
        return c.lastrowid


def get_class_by_id(class_id: int) -> dict | None:
    rows = execute_query_dict(
        "SELECT id, grade_id, name, display_name, sort_order FROM classes WHERE id=?", (class_id,)
    )
    return rows[0] if rows else None


def get_class_by_name(grade_id: int, name: str) -> dict | None:
    rows = execute_query_dict(
        "SELECT id, grade_id, name, display_name, sort_order FROM classes WHERE grade_id=? AND name=?",
        (grade_id, name),
    )
    return rows[0] if rows else None


# ═══════════════════════════════════════════════════════════════
# 教师任教关系
# ═══════════════════════════════════════════════════════════════

def get_teacher_assignments(teacher_username: str) -> list[dict]:
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


def get_teacher_grades(teacher_username: str) -> list[dict]:
    """教师任教的年级列表（去重），管理员返回全部。
    优先查 teacher_assignments，无数据时降级查旧 users.grade 管道格式。"""
    from backend.auth import is_admin
    if is_admin(teacher_username):
        return get_all_grades()
    rows = execute_query_dict(
        """SELECT DISTINCT g.id, g.name, g.stage, g.sort_order
           FROM teacher_assignments ta
           JOIN grades g ON ta.grade_id = g.id
           WHERE ta.teacher_username = ?
           ORDER BY g.sort_order""",
        (teacher_username,),
    )
    if rows:
        return rows
    # 降级：查旧 users.grade 管道格式
    old_rows = execute_query("SELECT grade FROM users WHERE username=?", (teacher_username,))
    if old_rows and old_rows[0][0]:
        grade_str = (old_rows[0][0] or "").strip()
        if grade_str:
            result = []
            for g_name in grade_str.split("|"):
                g_name = g_name.strip()
                if g_name:
                    info = get_grade_by_name(g_name)
                    if info:
                        result.append(info)
                    else:
                        # 旧年级名不在新表中，动态创建
                        gid = upsert_grade(g_name)
                        result.append(get_grade_by_id(gid))
            return result
    return []


def get_teacher_classes(teacher_username: str, grade_id: int) -> list[dict]:
    """教师在指定年级的任教班级，class_id=NULL 表示该年级全部班级。
    优先查 teacher_assignments，无数据时降级查旧 users.class 管道格式。"""
    from backend.auth import is_admin
    if is_admin(teacher_username):
        return get_all_classes(grade_id)

    # 先查是否有 class_id=NULL（表示该年级全部班级）
    rows = execute_query(
        "SELECT class_id FROM teacher_assignments WHERE teacher_username=? AND grade_id=? AND class_id IS NULL",
        (teacher_username, grade_id),
    )
    if rows:
        return get_all_classes(grade_id)

    rows = execute_query_dict(
        """SELECT c.id, c.grade_id, c.name, c.display_name, c.sort_order
           FROM teacher_assignments ta
           JOIN classes c ON ta.class_id = c.id
           WHERE ta.teacher_username = ? AND ta.grade_id = ?
           ORDER BY c.sort_order""",
        (teacher_username, grade_id),
    )
    if rows:
        return rows

    # 降级：查旧 users.grade/class 管道格式
    grade_info = get_grade_by_id(grade_id)
    if not grade_info:
        return []
    grade_name = grade_info["name"]
    old_rows = execute_query("SELECT grade, class FROM users WHERE username=?", (teacher_username,))
    if old_rows and old_rows[0][0]:
        gcm = parse_legacy_teacher_grade_class(
            (old_rows[0][0] or "").strip(), str(old_rows[0][1] or "").strip()
        )
        class_names = gcm.get(grade_name, [])
        if not class_names:
            # 该年级没有限制 → 全部班级
            return get_all_classes(grade_id)
        result = []
        for cn in class_names:
            if "班" not in cn:
                cn = f"{cn}班"
            cls_info = get_class_by_name(grade_id, cn)
            if cls_info:
                result.append(cls_info)
            else:
                cid = upsert_class(grade_id, cn)
                result.append(get_class_by_id(cid))
        return result
    return []


def assign_teacher(teacher_username: str, grade_id: int, class_id: int = None, subject: str = ""):
    """为教师添加任教关系（幂等）"""
    execute_insert_update(
        """INSERT OR IGNORE INTO teacher_assignments (teacher_username, grade_id, class_id, subject)
           VALUES (?, ?, ?, ?)""",
        (teacher_username, grade_id, class_id, subject),
    )


def remove_teacher_assignment(teacher_username: str, grade_id: int, class_id: int = None):
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
    """用户是否有权限访问该年级（新表优先，无数据时降级旧格式）"""
    from backend.auth import is_admin
    if is_admin(username):
        return True
    rows = execute_query(
        "SELECT 1 FROM teacher_assignments WHERE teacher_username=? AND grade_id=?",
        (username, grade_id),
    )
    if rows:
        return True
    # 降级：查旧 users.grade 管道格式
    grade_info = get_grade_by_id(grade_id)
    if not grade_info:
        return False
    old_rows = execute_query("SELECT grade FROM users WHERE username=?", (username,))
    if old_rows and old_rows[0][0]:
        allowed = [g.strip() for g in (old_rows[0][0] or "").split("|") if g.strip()]
        return grade_info["name"] in allowed
    return False


def can_access_class(username: str, grade_id: int, class_id: int) -> bool:
    """用户是否有权限访问该班级（新表优先，无数据时降级旧格式）"""
    from backend.auth import is_admin
    if is_admin(username):
        return True
    # 检查新表
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
    if rows:
        return True
    # 降级：查旧格式
    grade_info = get_grade_by_id(grade_id)
    class_info = get_class_by_id(class_id) if class_id else None
    if not grade_info:
        return False
    old_rows = execute_query("SELECT grade, class FROM users WHERE username=?", (username,))
    if old_rows and old_rows[0][0]:
        gcm = parse_legacy_teacher_grade_class(
            (old_rows[0][0] or "").strip(), str(old_rows[0][1] or "").strip()
        )
        allowed = gcm.get(grade_info["name"], [])
        if not allowed:
            # 没有指定班级限制 → 该年级全部可访问
            return True
        if class_info:
            cls_name = class_info["name"].replace("班", "")
            return cls_name in allowed
    return False


def is_student_in_teacher_scope(student_username: str, teacher_username: str) -> bool:
    """判断学生是否在教师的管辖范围内（新表优先，降级旧格式）"""
    from backend.auth import is_admin
    if is_admin(teacher_username):
        return True
    # 获取学生年级班级（新字段优先，降级旧字段）
    student = execute_query_dict(
        "SELECT grade_id, class_id, grade, class FROM users WHERE username=?", (student_username,)
    )
    if not student:
        return False
    s = student[0]

    # 优先用新字段
    if s.get("grade_id"):
        return can_access_class(teacher_username, s["grade_id"], s.get("class_id"))

    # 降级：学生也是旧格式，教师也是旧格式，直接文本匹配
    s_grade = (s.get("grade") or "").strip()
    s_class = str(s.get("class") or "").strip()
    if not s_grade:
        return False

    old_rows = execute_query("SELECT grade, class FROM users WHERE username=?", (teacher_username,))
    if not old_rows or not old_rows[0][0]:
        return False
    gcm = parse_legacy_teacher_grade_class(
        (old_rows[0][0] or "").strip(), str(old_rows[0][1] or "").strip()
    )
    allowed_classes = gcm.get(s_grade, [])
    if not allowed_classes:
        return s_grade in gcm  # 该年级无班级限制
    return s_class in allowed_classes


def get_students_in_scope(username: str, grade_id: int = None, class_id: int = None) -> list[dict]:
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
            params,
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
