"""
资源类型注册表 —— 知识点「绑定资源」的唯一真源。

背景（2026-10-26 改版）：类型清单原先散落 6 处硬编码 —— 前端下拉 options、
后端两份 valid_types、_get_resource_info 的解析分支、_check_resource_ownership 的
校验分支、KpResourceCard 的图标与文案（还另用一套 i18n 键）—— 改一处漏五处，
于是「任务」没跟着全站改成「作业」、「同步练习」一直没有上架。
现在加一个类型只需：本文件加一条 SPEC + 语言包加两个词。

约定：
- `key` 是落库值（curriculum_bindings.resource_type），**永不重命名**；改名只改 label_key。
- 绑定表的 `resource_id` 已迁为 TEXT，所有类型统一按字符串主键存取（作业的主键本来就是 TEXT）。
- `on_shelf=False`：后端已能解析、但暂不提供给教师选择（试题 —— 1578 题没有分类维度前不上架）。
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ResourceTypeSpec:
    """一种可绑定资源的完整描述。"""

    key: str
    label_key: str          # i18n 键（curriculum 命名空间：resourceType.<key>）
    group: str              # courseware | practice | assessment | interaction
    icon: str               # 前端图标名（由前端 RESOURCE_ICON_MAP 映射，后端不引组件）
    source_db: str          # main=smartkb.db | questions=questions.db
    table: str
    name_col: str
    id_col: str = "id"
    owner_col: str = "creator_username"
    status_col: str = "status"
    # 可绑的状态白名单；空元组 = 该表没有状态列或不按状态筛
    visible_status: tuple[str, ...] = ()
    subject_col: str = ""
    grade_col: str = ""
    class_col: str = ""
    scope_col: str = ""      # target_scope / share_scope：用于「目标范围」展示
    created_col: str = "created_at"
    kp_col: str = ""         # 知识点字段（自由文本，用于「本知识点」推荐匹配）
    source_col: str = ""     # 来源字段（AI 生成 / 题库组卷 / 手动）
    # 卡片副信息：(别名, SQL 表达式)。表达式必须能在该表的查询里直接求值。
    meta_exprs: tuple[tuple[str, str], ...] = ()
    url: str = ""            # 站内深链模板，{id} 占位
    id_is_text: bool = False
    bindable: bool = True    # 允许写入 curriculum_bindings
    on_shelf: bool = True    # 出现在绑定框的类型列表里
    order: int = 100         # 类型展示顺序


SPECS: tuple[ResourceTypeSpec, ...] = (
    # ── 课件与文件 ──
    ResourceTypeSpec(
        key="html", label_key="resourceType.html", group="courseware", icon="file",
        source_db="main", table="shared_resources", name_col="file_name",
        owner_col="owner_username", status_col="",
        grade_col="target_grade", class_col="target_class", scope_col="share_scope",
        url="",  # 文件类走 /api/files/... ，由 _get_resource_info 特例拼
        order=10,
    ),
    ResourceTypeSpec(
        key="download", label_key="resourceType.download", group="courseware", icon="download",
        source_db="main", table="shared_resources", name_col="file_name",
        owner_col="owner_username", status_col="",
        grade_col="target_grade", class_col="target_class", scope_col="share_scope",
        url="",
        order=20,
    ),
    # ── 练习与作业 ──
    ResourceTypeSpec(
        key="task", label_key="resourceType.task", group="practice", icon="check",
        source_db="main", table="tasks", name_col="name",
        visible_status=("active",),
        subject_col="subject", grade_col="target_grade", class_col="target_class", scope_col="target_scope",
        meta_exprs=(("submit_mode", "submit_mode"), ("deadline_at", "deadline_at"),
                    ("total_score", "total_score")),
        url="/tasks?open={id}",
        id_is_text=True,   # tasks.id 是 TEXT 复合主键：root_xxx_1792666468_100b7b43
        order=30,
    ),
    ResourceTypeSpec(
        key="practice", label_key="resourceType.practice", group="practice", icon="practice",
        source_db="questions", table="practice_sessions", name_col="title",
        visible_status=("active",),
        subject_col="subject", grade_col="target_grade", class_col="target_class", scope_col="target_scope",
        kp_col="knowledge_points", source_col="source",
        meta_exprs=(("question_count", "question_count"), ("total_score", "total_score")),
        url="/practice?open={id}",
        order=40,
    ),
    ResourceTypeSpec(
        key="interaction_quiz", label_key="resourceType.interaction_quiz", group="practice", icon="quiz",
        source_db="main", table="interaction_quizzes", name_col="title",
        visible_status=("active",),
        subject_col="subject", grade_col="target_grade", class_col="target_class", scope_col="target_scope",
        kp_col="knowledge_points",
        url="/interaction?open={id}",
        order=50,
    ),
    # ── 考核 ──
    ResourceTypeSpec(
        key="exam", label_key="resourceType.exam", group="assessment", icon="form",
        source_db="questions", table="exams", name_col="title",
        visible_status=("published",),
        subject_col="subject", grade_col="target_grade", class_col="target_class", scope_col="target_scope",
        meta_exprs=(("question_count",
                     "(SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = exams.id)"),
                    ("total_score", "total_score"), ("duration", "duration")),
        url="/exam?open={id}",
        order=60,
    ),
    # ── 互动 ──
    ResourceTypeSpec(
        key="discussion", label_key="resourceType.discussion", group="interaction", icon="team",
        source_db="main", table="discussions", name_col="title",
        visible_status=("pending", "active"),
        subject_col="subject", grade_col="target_grade", class_col="target_class", scope_col="target_scope",
        meta_exprs=(("group_count", "group_count"), ("duration_minutes", "duration_minutes")),
        url="/discussion?open={id}",
        order=70,
    ),
    # ── 已能解析、暂不上架 ──
    ResourceTypeSpec(
        key="question", label_key="resourceType.question", group="practice", icon="question",
        source_db="questions", table="question_bank", name_col="question_text",
        visible_status=("active",),
        subject_col="subject", kp_col="knowledge_points", source_col="source",
        url="/question-bank?open={id}",
        bindable=False, on_shelf=False, order=900,
    ),
)

SPEC_BY_KEY: dict[str, ResourceTypeSpec] = {s.key: s for s in SPECS}

# 落库白名单（含未上架的 question：历史绑定行仍要能解析与解绑）
BINDABLE_KEYS: frozenset[str] = frozenset(s.key for s in SPECS if s.bindable)
# 绑定框可见类型（按 order 排好）
SHELF_KEYS: tuple[str, ...] = tuple(
    s.key for s in sorted((x for x in SPECS if x.on_shelf and x.bindable), key=lambda x: x.order)
)

GROUP_ORDER: tuple[str, ...] = ("courseware", "practice", "assessment", "interaction")

# 网页课件的内容小类：AI 产物文件名后缀 → 小类键（与 resources_router 的 type_labels 同口径）
# 「_课件」排在最前：它是 AI 课件产物的固定后缀（{知识点id}_{知识点名}_课件.html），
# 而知识点名本身可能带「练习」等字样，先判它才不会把课件错认成章节练习。
HTML_SUBKINDS: tuple[tuple[str, str], ...] = (
    ("_课件", "courseware"),
    ("_动画讲解", "animation"),
    ("_互动答题", "quiz"),
    ("_练习", "practice"),
    ("_播客", "podcast"),
    ("_实验交互", "interactive"),
    ("_自定义", "custom"),
)

# 候选拉取的安全上限：绑定框是「一次拉全量、本地分类翻页」（与共享资源页同一套交互），
# 但表越大越要给个硬顶，并在响应里如实告诉前端 truncated，绝不再静默截断。
CANDIDATE_LIMIT = 2000


def spec_of(key: str) -> ResourceTypeSpec | None:
    return SPEC_BY_KEY.get(key)


def query_fn(spec: ResourceTypeSpec):
    """按 spec 取查询函数：两个库分开，统一返回 list[dict]。"""
    if spec.source_db == "questions":
        from backend.question_db import execute_query as _fn   # 该库的 execute_query 已返回 dict
    else:
        from backend.database import execute_query_dict as _fn
    return _fn


def open_url(spec: ResourceTypeSpec, resource_id: object) -> str:
    if not spec.url:
        return ""
    return spec.url.replace("{id}", str(resource_id))


def sub_kind_of(name: object) -> str:
    """网页课件的内容小类：从 AI 产物文件名后缀判断（历史数据没落库字段，只能猜）。"""
    text = str(name or "")
    for suffix, kind in HTML_SUBKINDS:
        if suffix in text:
            return kind
    return "other"


def normalize_id(raw: object) -> str:
    """主键统一成字符串：作业本来就是 TEXT 主键，数字类型也按字符串存，避免两种形态混存。"""
    return str(raw if raw is not None else "").strip()


def display_name(spec: ResourceTypeSpec, raw_name: object) -> str:
    """候选列表 / 已绑列表共用的展示名清洗。"""
    name = str(raw_name or "")
    if spec.key == "question" and len(name) > 60:
        name = name[:60] + "..."
    return name


def status_filter(spec: ResourceTypeSpec) -> tuple[str, list]:
    """可绑状态白名单 → SQL 片段 + 参数。"""
    if not spec.status_col or not spec.visible_status:
        return "", []
    ph = ",".join("?" for _ in spec.visible_status)
    return f" AND {spec.status_col} IN ({ph})", list(spec.visible_status)
