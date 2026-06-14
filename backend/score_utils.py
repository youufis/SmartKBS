"""
积分与学生数据工具函数
供 score_router.py 和 rollcall_router.py 共享
"""
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
                    """SELECT u.name, COALESCE(c.display_name, u.class) as cls_display, u.gender
                       FROM users u
                       LEFT JOIN classes c ON u.class_id = c.id
                       WHERE u.role=2 AND u.grade_id=? AND u.name IS NOT NULL AND u.name!=''""",
                    (grade_id,),
                )
            else:
                return []

            seen, class_map = set(), {}
            for name, cls_display, gender_val in c.fetchall():
                if name in seen:
                    continue
                seen.add(name)
                cls_display = cls_display or ""
                class_map.setdefault(cls_display, []).append({
                    "class": cls_display, "name": name,
                    "gender": "男" if gender_val in (1, "1", "男") else "女" if gender_val in (2, "0", "女", 0) else "",
                    "language": "", "subjects": "", "major": "",
                })
            for cls_name in sorted(class_map.keys()):
                students.extend(class_map[cls_name])
    except Exception:
        pass
    return students
