"""
学科与年级配置
所有学科名称、年级等从 system_config.json 读取，避免硬编码
"""
import time

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


# ── 学科显示顺序 ──────────────────────────────────────────────────────────
# 成员的唯一真相仍是 system_config.json 的 SUBJECTS；subject_order 表只回答"谁排在
# 前面"，由课程中心（仅管理员）拖动写入。两件事互不绑架：
#   · 配置页新增学科 → 顺序表没登记过，按 SUBJECTS 原相对顺序追加到末尾；
#   · 配置页删除学科 → 顺序表里的孤儿行直接忽略，下次整表重写时顺带清掉。
# 没人拖过时这张表是空的，结果与引入本功能前逐位一致，所以可以安全灰度。
_ORDER_TTL = 30.0
_order_cache: tuple[float, list[str]] | None = None


def _ordered_names() -> list[str]:
    """subject_order 里的学科名，按 sort_order 排好。

    带 TTL 缓存是必须的：get_subjects() 在自动选题的热路径上（normalize_subject
    几乎每题一次），裸 SELECT 会把"读一次配置"变成"每题查一次库"。
    """
    global _order_cache
    now = time.monotonic()
    if _order_cache is not None and now - _order_cache[0] < _ORDER_TTL:
        return _order_cache[1]
    names: list[str] = []
    try:
        from backend.database import execute_query
        rows = execute_query("SELECT name FROM subject_order ORDER BY sort_order, name") or []
        names = [str(r[0]).strip() for r in rows if str(r[0] or "").strip()]
    except Exception as e:
        # 老库还没建表 = 没人拖过，按"无自定义顺序"处理，绝不能因此把学科列表变成空
        logger.debug(f"subject_order 读取失败，按无自定义顺序处理: {e}")
    _order_cache = (now, names)
    return names


def invalidate_subject_order_cache() -> None:
    """拖动排序后调用，让下一个请求立刻看到新顺序，不用等 TTL 到期。"""
    global _order_cache
    _order_cache = None


def get_subject_members() -> list[str]:
    """学科成员（不含显示顺序）：校验"这个名字算不算已配置学科"时用它。

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


def get_subjects() -> list[str]:
    """获取启用的学科列表（已应用拖动后的显示顺序）。"""
    members = get_subject_members()
    known = [n for n in _ordered_names() if n in set(members)]
    if not known:
        return members
    picked = set(known)
    return known + [m for m in members if m not in picked]


def get_subject_presets() -> list[str]:
    """配置页候选：常用清单在前，当前已配置但不在清单里的补在后面（顺序稳定，不随保存抖动）。"""
    out = list(SUBJECT_PRESETS)
    for s in get_subjects():
        if s not in out:
            out.append(s)
    return out


def teacher_subjects_by_load(username: str | None) -> list[str]:
    """该账号真实登记的任教学科，按任教班级数从多到少（并列按名称），无记录返回空。

    与 permission_service.get_teacher_subjects 的区别：那边对管理员回落"全部学科"，
    那是权限判断要的口径；这里要回答的是"这个人默认该在哪门课上动手"。
    """
    if not username:
        return []
    try:
        from backend.database import execute_query
        rows = execute_query(
            """SELECT subject, COUNT(*) AS n FROM teacher_assignments
               WHERE teacher_username=? AND subject IS NOT NULL AND subject != ''
               GROUP BY subject ORDER BY n DESC, subject""",
            (username,),
        ) or []
        members = set(get_subjects())
        # 任教记录里可能留着已停用的旧写法（如「信息技术」）；不在成员内的不能当默认值
        return [str(r[0]).strip() for r in rows if str(r[0]).strip() in members]
    except Exception as e:
        logger.debug(f"任教学科读取失败，回落系统学科首位: {e}")
        return []


def get_default_subject(username: str | None = None) -> str:
    """默认学科：先看这个人教什么，其次才看系统学科列表首位。

    以前这里直接 return subjects[0]，于是"谁排在配置数组第一位"这个纯属偶然的事实
    （学科列表是 tags 控件顺手点出来的）决定了 AI 出题、题库导入在未传学科时题目落到
    哪门课，并连带影响学科称号统计。课程中心开放学科拖动排序后，首位的含义变成
    "管理员希望谁先出现"，两者必须解耦。
    没有任教记录时（含未排课的管理员）仍回落首位 —— 而首位现在恰好只有管理员能改，口径自洽。
    """
    own = teacher_subjects_by_load(username)
    if own:
        return own[0]
    subjects = get_subjects()
    return subjects[0] if subjects else DEFAULT_SUBJECTS[0]


def _pick_canonical(candidates: list[str]) -> str:
    """同族多个写法同时出现在学科配置里时，选「实际在用」的那个。

    以前按 get_subjects() 的顺序取第一个，等于让拖动排序决定别名归一到哪个名字；
    改成按挂课数量取，数量并列再按名称排，结果与显示顺序无关。
    """
    if len(candidates) == 1:
        return candidates[0]
    try:
        from backend.database import execute_query
        placeholders = ",".join("?" * len(candidates))
        rows = execute_query(
            f"SELECT subject, COUNT(*) AS n FROM courses WHERE subject IN ({placeholders})"
            " GROUP BY subject",
            tuple(candidates),
        ) or []
        counts = {str(r[0]): int(r[1] or 0) for r in rows}
        if any(counts.values()):
            return sorted(candidates, key=lambda s: (-counts.get(s, 0), s))[0]
    except Exception as e:
        logger.debug(f"同族学科按挂课数挑选失败，退回按名称排: {e}")
    return sorted(candidates)[0]


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
        cands = [candidate for candidate in subjects if subject_family(candidate) == fam]
        if cands:
            return _pick_canonical(cands)
    except Exception:
        pass
    return None


def require_subject(subject: str) -> str:
    """校验并归一学科；非法时抛 ValueError（调用方转成 400/任务错误）。"""
    normalized = normalize_subject(subject)
    if not normalized:
        raise ValueError(f"请选择已配置的学科：{', '.join(get_subjects())}")
    return normalized
