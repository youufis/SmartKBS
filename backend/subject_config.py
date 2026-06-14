"""
课程与年级配置
所有课程名称、年级等从 system_config.json 读取，避免硬编码
"""
from backend.logger import logger

# 默认值（当 system_config.json 中未配置时使用）
DEFAULT_SUBJECTS = ["信息科技", "通用技术"]
DEFAULT_GRADES = ["一年级", "二年级", "三年级", "四年级", "五年级", "六年级",
                  "初一", "初二", "初三",
                  "高一", "高二", "高三"]


def get_subjects() -> list[str]:
    """获取启用的课程列表"""
    try:
        from backend.api.config_router import load_config
        cfg = load_config()
        subjects = cfg.get("SUBJECTS", None)
        if subjects and isinstance(subjects, list) and len(subjects) > 0:
            return subjects
    except Exception:
        pass
    return DEFAULT_SUBJECTS


def get_default_subject() -> str:
    """获取默认课程名称"""
    subjects = get_subjects()
    return subjects[0] if subjects else DEFAULT_SUBJECTS[0]


def get_grades() -> list[str]:
    """获取所有年级列表（从数据库 users 表动态获取，自动拆分 | 分隔的年级）"""
    try:
        from backend.database import execute_query
        rows = execute_query(
            "SELECT DISTINCT grade FROM users WHERE grade IS NOT NULL AND grade != '' ORDER BY grade"
        )
        grade_set: set[str] = set()
        for r in rows:
            if r[0]:
                for g in str(r[0]).split("|"):
                    g = g.strip()
                    if g:
                        grade_set.add(g)
        grades = sorted(grade_set)
        if grades:
            return grades
    except Exception:
        pass
    return DEFAULT_GRADES


def get_grade_list() -> list[str]:
    """获取年级列表（供前端下拉框使用）"""
    return get_grades()


def get_subject_list() -> list[str]:
    """获取课程列表（供前端下拉框使用）"""
    return get_subjects()
