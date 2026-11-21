"""
学科与年级配置
所有学科名称、年级等从 system_config.json 读取，避免硬编码
"""
from backend.logger import logger

# 默认值（当 system_config.json 中未配置时使用）。出厂默认值只认这一份：
# config_router.DEFAULT_CONFIG["SUBJECTS"] 直接引用它，改这里两边一起动。
DEFAULT_SUBJECTS = ["人工智能"]
# 配置页「学科列表」的常用候选（同样只此一份，经 /api/config/meta 下发，前端不再抄）。
# 它是"建议值"不是"生效值"：生效值永远是 system_config.json 的 SUBJECTS。
SUBJECT_PRESETS = ["信息科技", "通用技术", "人工智能", "物理"]
DEFAULT_GRADES = ["一年级", "二年级", "三年级", "四年级", "五年级", "六年级",
                  "初一", "初二", "初三",
                  "高一", "高二", "高三"]


def get_subjects() -> list[str]:
    """获取启用的学科列表。

    兼容历史脏数据：SUBJECTS 被写成逗号串时也照样拆开（以前只认 list，
    写成字符串会静默回落成「人工智能」，表现成"学科列表被重置"）。
    """
    try:
        from backend.api.config_router import load_config
        from backend.config_lists import as_str_list
        cfg = load_config()
        subjects = as_str_list(cfg.get("SUBJECTS"), DEFAULT_SUBJECTS)
        if subjects:
            return subjects
    except Exception:
        pass
    return DEFAULT_SUBJECTS


def get_subject_presets() -> list[str]:
    """配置页候选：常用清单在前，当前已配置但不在清单里的补在后面（顺序稳定，不随保存抖动）。"""
    out = list(SUBJECT_PRESETS)
    for s in get_subjects():
        if s not in out:
            out.append(s)
    return out


def get_default_subject() -> str:
    """获取默认学科名"""
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
    """获取学科列表（供前端下拉框使用）"""
    return get_subjects()


def normalize_subject(subject: str) -> str | None:
    """把学科写法归一为当前学科配置（SUBJECTS）中的名称；不在清单内返回 None。

    兼容历史别名（如 信息技术 → 信息科技），但不再允许物理/生物/空值等
    非清单内学科进入题库。
    """
    value = str(subject or "").strip()
    if not value:
        return None
    subjects = get_subjects()
    if value in subjects:
        return value
    try:
        from backend.question_select import subject_family
        fam = subject_family(value)
        for candidate in subjects:
            if subject_family(candidate) == fam:
                return candidate
    except Exception:
        pass
    return None


def require_subject(subject: str) -> str:
    """校验并归一学科；非法时抛 ValueError（调用方转成 400/任务错误）。"""
    normalized = normalize_subject(subject)
    if not normalized:
        raise ValueError(f"请选择已配置的学科：{', '.join(get_subjects())}")
    return normalized
