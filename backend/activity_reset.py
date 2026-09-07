"""
活动数据重置 service（注册表驱动）

语义分层（与 docs/activity-reset/00-决策与实施日志.md 一致）：
  ① 内容 content    活动本体 + 题目/选项/测试用例/分组配置  -> 永远保留
  ② 数据 data       学生参与产生的记录                     -> 默认清除
  ③ 派生 derived    积分流水/通知/错题本/学习进度           -> 按选项联动清理并重算
  ④ 运行态 runtime  活动状态 + 进程内状态（内存房间）        -> 回到"可重新参与"

设计要点：
- 新增活动类型只需在 RESET_SCOPES 加一条声明，不必再抄一遍删除逻辑。
- 预览与执行共用同一份注册表：预览看到的数字就是执行会删的数字。
- 不假装跨库有事务：questions.db 与 smartkb.db 各自单事务提交。任一失败时另一半可能已
  提交，因此整个流程必须可重入——重跑一次即收敛，已删的不会重复计。
- 只删数据行，绝不"删内容再插回来"：保留主表 id / created_at / 房间码 / 任务 ID，
  学生端旧链接与统计口径才不会断。
- 可重入的准确含义：二次执行不再改动任何参与数据与积分。唯一会被再次删除的是
  上一轮由路由层推给学生的"已重置"通知？不是——那条通知带 i18n payload，属于系统回执，
  清理"活动关联通知"时被显式排除（见 NOTICE_SKIP），否则会自吃自。
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from backend.database import execute_query_dict, get_transaction
from backend.text_utils import plain_title
from backend.logger import logger
from backend.question_db import execute_query as q_query
from backend.question_db import get_connection as q_connection

DB_MAIN = "main"       # backend/smartkb.db
DB_QDB = "qdb"         # backend/questions.db

# ── 选项（默认值 = 已冻结的决策）──
OPT_RESET_STATUS = "reset_status"
OPT_CLEAR_REWARDS = "clear_rewards"
OPT_CLEAR_NOTIFY = "clear_notifications"
OPT_CLEAR_WRONG_BOOK = "clear_wrong_book"
OPT_CLEAR_PROGRESS = "clear_progress"
OPT_CLEAR_QUESTIONS = "clear_questions"
OPT_CLEAR_KEYS = "clear_keys"
OPT_CLEAR_VIEW_LOGS = "clear_view_logs"
OPT_DROP_GROUPS = "drop_groups"

# 活动状态枚举 -> 面向用户的中文标签（前端 i18n 缺失时回退到这里，绝不显示原始枚举）
STATUS_LABELS: dict[str, str] = {
    "draft": "草稿", "published": "已发布", "ended": "已结束", "finished": "已结束",
    "active": "进行中", "inactive": "已停用", "waiting": "等待中",
    "playing": "进行中", "pending": "待开始",
}

OPTION_LABELS: dict[str, str] = {
    OPT_RESET_STATUS: "同时回滚活动状态（使学生可重新参与）",
    OPT_CLEAR_REWARDS: "回收该活动发放的积分流水",
    OPT_CLEAR_NOTIFY: "清理该活动关联的通知",
    OPT_CLEAR_WRONG_BOOK: "清理由该活动产生的错题本条目",
    OPT_CLEAR_PROGRESS: "清理该活动关联的知识点学习进度",
    OPT_CLEAR_QUESTIONS: "同时清空活动题目（下次重新抽题/重新生成）",
    OPT_CLEAR_KEYS: "清空课程练习题卷密钥（学生端将重新抽题）",
    OPT_CLEAR_VIEW_LOGS: "清理该活动的资源浏览记录",
    OPT_DROP_GROUPS: "同时删除分组名单（回到未分组）",
}
OPTION_DEFAULTS: dict[str, bool] = {
    OPT_RESET_STATUS: True,
    OPT_CLEAR_REWARDS: True,
    OPT_CLEAR_NOTIFY: True,
    OPT_CLEAR_WRONG_BOOK: True,
    OPT_CLEAR_PROGRESS: True,
    OPT_CLEAR_QUESTIONS: False,   # 默认保留题目：重置后能立刻重开同一套
    OPT_CLEAR_KEYS: False,
    OPT_CLEAR_VIEW_LOGS: False,
    OPT_DROP_GROUPS: False,       # 讨论类由 group_mode 自动决定，见 _effective_options
}

_PREVIEW_STUDENT_LIMIT = 200      # 仅限制"展示用"名单长度，重算积分时用完整名单


class ResetError(Exception):
    """业务错误：活动不存在 / 类型不支持 / 需要强制确认。status_code 供路由层直接用"""

    def __init__(self, message: str, status_code: int = 400,
                 code: str = "", params: dict[str, Any] | None = None):
        super().__init__(message)
        self.status_code = status_code
        # code/params 供前端查 i18n 词典；message 保留中文只做兜底，
        # 这样英文界面不会露出后端中文，老客户端也仍有可读文案
        self.code = code
        self.params = params or {}

    def as_detail(self) -> dict[str, Any]:
        """路由层直接当作 HTTPException.detail 返回"""
        return {"code": self.code, "msg": str(self), "params": self.params}


# ────────────────────────── 数据库访问统一层 ──────────────────────────
# 两个库的 helper 返回形态不同（database.execute_query 给 tuple、question_db 给 dict），
# 这里统一成"字典行 + 命名参数"，注册表里的 SQL 因此可以两边照写不误。

def _fetch(db: str, sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    # 命名参数(:name)必须把 dict 原样交给 sqlite3；转成 tuple((k,v)...) 会报
    # "type 'tuple' is not supported"。两个库的 helper 都直接透传 params，可以共用。
    p = params or {}
    if db == DB_QDB:
        return [dict(r) for r in (q_query(sql, p) or [])]
    return execute_query_dict(sql, p) or []


def _one(db: str, sql: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
    rows = _fetch(db, sql, params)
    return rows[0] if rows else None


def _in_tx(db: str, ops: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """在一个事务里执行写操作；ops 每项含 table/label/sql/params。返回带 rows 的同一批 dict"""
    if not ops:
        return []
    if db == DB_QDB:
        with q_connection() as conn:
            cur = conn.cursor()
            for op in ops:
                cur.execute(op["sql"], op["params"])
                op["rows"] = int(cur.rowcount or 0)
            conn.commit()
        return ops
    with get_transaction() as conn:
        cur = conn.cursor()
        for op in ops:
            cur.execute(op["sql"], op["params"])
            op["rows"] = int(cur.rowcount or 0)
    return ops


def _placeholders(values: list[str], prefix: str) -> tuple[str, dict[str, Any]]:
    """生成 (:p0, :p1, ...) 与对应参数字典 —— 值一律走绑定，不拼进 SQL"""
    params = {f"{prefix}{i}": v for i, v in enumerate(values)}
    joined = "(" + ", ".join(f":{prefix}{i}" for i in range(len(values))) + ")"
    return joined, params


# ────────────────────────── 注册表 ──────────────────────────

def Target(table: str, where: str, label: str, db: str = DB_MAIN,
           student_col: str = "", option: str = "") -> dict[str, Any]:
    """一处待清理的数据表；option 非空表示需该选项为真才清"""
    return {"table": table, "where": where, "label": label, "db": db,
            "student_col": student_col, "option": option}


def Scope(key: str, label: str, **kw: Any) -> dict[str, Any]:
    d: dict[str, Any] = {"key": key, "label": label}
    d.update(kw)
    return d


_DEFAULTS: dict[str, Any] = {
    "db": DB_MAIN, "master": "", "title_col": "title", "creator_col": "creator_username",
    "targets": (), "keep": (), "reward_types": (), "legacy_reward_ids": (), "reward_id_key": "aid",
    "notify_type": "", "wrong_book_source": "", "status": None, "clear_cols": (),
    "in_progress": None, "runtime": "", "options": None, "id_kind": "int",
    "notes": (), "auto_options": (), "warnings": (), "i18n_key": "",
}

# fmt: off
RESET_SCOPES: dict[str, dict[str, Any]] = {
    # 1. 考试
    "exam": Scope(
        "exam", "考试", db=DB_QDB, master="exams",
        targets=[Target("exam_attempts", "exam_id = :aid", "答卷记录（含 AI 批改与教师复核）",
                        DB_QDB, student_col="student_username")],
        keep=[("exam_paper", "试卷本体"), ("exam_questions", "试卷题目构成与分值")],
        reward_types=("exam",), notify_type="exam", wrong_book_source="exam",
        status=("status", ("ended",), "published"),
        in_progress=("exam_attempts", "exam_id = :aid AND status = 'in_progress'",
                     "exam_answering", "正在答题的答卷"),
    ),
    # 2. 智能练习
    "practice": Scope(
        "practice", "智能练习", db=DB_QDB, master="practice_sessions",
        targets=[Target("practice_attempts", "session_id = :aid", "练习作答记录", DB_QDB,
                        student_col="student_username")],
        keep=[("practice_config", "练习配置"), ("practice_questions", "练习题组")],
        reward_types=("practice",), notify_type="practice", wrong_book_source="practice",
        status=("status", ("ended",), "active"),
    ),
    # 3. 知识抢答
    "quick_quiz": Scope(
        "quick_quiz", "知识抢答", master="quick_quiz_rooms", i18n_key="quickQuiz",
        targets=[
            Target("quick_quiz_rankings", "room_id = :aid", "每轮排名快照"),
            Target("quick_quiz_answers", "room_id = :aid", "抢答作答明细", student_col="student_username"),
            Target("quick_quiz_players", "room_id = :aid", "玩家战绩（得分/连击/用时）",
                   student_col="student_username"),
            Target("quick_quiz_questions", "room_id = :aid", "本场题目", option=OPT_CLEAR_QUESTIONS),
        ],
        keep=[("room_code", "房间码"), ("quiz_rules", "抢答规则与倒计时")],
        reward_types=("quick_quiz",), legacy_reward_ids=("quick_quiz_{aid}",), notify_type="quick_quiz",
        status=("status", ("ended", "playing"), "waiting"), clear_cols=("started_at", "ended_at"),
        in_progress=("quick_quiz_rooms", "id = :aid AND status = 'playing'",
                     "quiz_playing", "正在进行的抢答"),
        runtime="quick_quiz",
    ),
    # 4. 在线任务（tasks.id 是 TEXT，且被提交记录引用，绝不能改动）
    "task": Scope(
        "task", "在线任务", master="tasks", title_col="name", id_kind="str",
        targets=[
            Target("task_grades", "task_id = :aid", "AI 批改结果", student_col="student_username"),
            Target("task_submissions", "task_id = :aid", "任务提交记录", student_col="student_username"),
        ],
        keep=[("task_body", "任务标题、要求与截止时间")],
        reward_types=("task",), notify_type="task",
        status=("status", ("inactive",), "active"),
        warnings=[("task_ai_queue",
                   "该任务的 AI 批改可能仍在后台排队，极少数情况下会在重置后补回个别批改记录，"
                   "届时再执行一次重置即可")],
    ),
    # 5. 随堂测验
    "quiz": Scope(
        "quiz", "随堂测验", master="interaction_quizzes",
        targets=[Target("interaction_quiz_answers", "quiz_id = :aid", "测验答卷",
                        student_col="student_username")],
        keep=[("quiz_body", "题目、选项与正确答案")],
        reward_types=("quiz",), notify_type="quiz",
    ),
    # 6. 代码练习
    "code": Scope(
        "code", "代码练习", db=DB_QDB, master="code_problems",
        targets=[
            Target("code_submissions", "problem_id = :aid", "代码提交（含判题结果与 AI 点评）",
                   DB_QDB, student_col="student_username"),
            Target("code_runs", "problem_id = :aid", "调试运行记录", DB_QDB,
                   student_col="student_username"),
        ],
        keep=[("code_problem", "题面与初始代码模板"), ("code_test_cases", "测试用例")],
        reward_types=("code",), notify_type="code",
    ),
    # 7. 分组讨论
    "discussion": Scope(
        "discussion", "分组讨论", master="discussions",
        targets=[
            Target("discussion_messages",
                   "group_id IN (SELECT id FROM discussion_groups WHERE discussion_id = :aid)",
                   "讨论发言", student_col="username"),
            Target("discussion_members",
                   "group_id IN (SELECT id FROM discussion_groups WHERE discussion_id = :aid)",
                   "组员名单", student_col="username"),
            Target("discussion_reports", "discussion_id = :aid", "小组讨论报告"),
            Target("discussion_groups", "discussion_id = :aid", "分组结果", option=OPT_DROP_GROUPS),
        ],
        keep=[("discussion_topic", "讨论主题与要求"), ("discussion_config", "AI 角色、时长与分组模式")],
        reward_types=("discussion",), notify_type="discussion",
        status=("status", ("ended", "active"), "pending"),
        auto_options=((OPT_DROP_GROUPS, "group_mode=auto"),),
    ),
    # 8. 快速投票
    "poll": Scope(
        "poll", "快速投票", master="interaction_polls", title_col="question",
        targets=[Target("interaction_poll_votes", "poll_id = :aid", "投票记录",
                        student_col="student_username")],
        keep=[("poll_body", "投票题目与选项")],
        reward_types=("poll",), notify_type="poll",
    ),
    # 9. 课程练习（活动标识=binding_id，数据按 knowledge_point_id 归属，跨两个库）
    "course": Scope(
        "course", "课程练习", master="curriculum_bindings", title_col="", creator_col="",
        targets=[
            Target("ai_practice_results", "kp_id = :kp", "课程练习成绩与作答", DB_QDB,
                   student_col="student_username"),
            Target("learning_progress", "knowledge_point_id = :kp", "知识点学习进度",
                   student_col="student_username", option=OPT_CLEAR_PROGRESS),
            Target("resource_view_logs", "binding_id = :aid", "练习资源浏览记录",
                   student_col="student_username", option=OPT_CLEAR_VIEW_LOGS),
            Target("ai_practice_keys", "kp_id = :kp", "题卷密钥（清空后学生端重新抽题）", DB_QDB,
                   option=OPT_CLEAR_KEYS),
        ],
        keep=[("course_binding", "知识点与练习资源的绑定"), ("practice_page", "练习页面本体"),
              ("course_structure", "课程与知识框架")],
        reward_types=("course_practice",), reward_id_key="kp",
        options=(OPT_CLEAR_REWARDS, OPT_CLEAR_PROGRESS, OPT_CLEAR_KEYS, OPT_CLEAR_VIEW_LOGS),
        notes=[("course_reward_legacy", "历史遗留的旧积分流水已单独归位，不在课程练习的回收范围内")],
    ),
}
# fmt: on


def _resolve_course(aid: Any) -> dict[str, Any]:
    """课程练习：id 是 curriculum_bindings.id，数据挂在 knowledge_point_id 上"""
    rows = _fetch(DB_MAIN,
                  """SELECT cb.knowledge_point_id AS kp,
                            COALESCE(NULLIF(sr.file_name, ''), kp.name) AS raw_title,
                            kp.name AS kp_name, c.name AS course_name,
                            COALESCE(sr.owner_username, '') AS owner,
                            COALESCE(c.grade, '') AS course_grade
                     FROM curriculum_bindings cb
                     JOIN knowledge_points kp ON kp.id = cb.knowledge_point_id
                     JOIN chapters ch ON ch.id = kp.chapter_id
                     JOIN courses c ON c.id = ch.course_id
                     LEFT JOIN shared_resources sr ON sr.id = cb.resource_id AND sr.resource_type='html'
                     WHERE cb.id = :aid""", {"aid": aid})
    if not rows:
        raise ResetError("课程练习绑定不存在或已被删除", 404, code="activity_missing",
                         params={"type": "course"})
    r = rows[0]
    name = (r.get("raw_title") or r.get("kp_name") or "").strip()
    if name.endswith("_练习.html"):
        name = name[: -len("_练习.html")]
    return {
        "kp": r["kp"],
        "title": name or f"{r.get('course_name', '')} - {r.get('kp_name', '')}",
        "owner": r.get("owner") or "",
        "grade": (r.get("course_grade") or "").strip(),
    }


RESOLVERS: dict[str, Any] = {"course": _resolve_course}


def _scope(key: str) -> dict[str, Any]:
    sc = RESET_SCOPES.get(key)
    if not sc:
        raise ResetError(f"不支持的活动类型: {key}（可用: {'、'.join(RESET_SCOPES)}）", 404,
                         code="unsupported_type", params={"type": str(key)})
    merged = dict(_DEFAULTS)
    merged.update(sc)
    return merged


def scope_keys() -> list[str]:
    return list(RESET_SCOPES)


# ────────────────────────── 上下文 / 选项 ──────────────────────────

def _coerce_id(sc: dict[str, Any], raw: Any) -> Any:
    """按注册表声明强制 ID 类型。

    SQLite 的 INTEGER 列与 TEXT 参数比较**不做隐式转换**：把 '2' 绑给 exam_id=2 的查询
    会得到 0 行 -> 表现为"重置成功但什么都没删"，比报错更危险，所以入口必须先转类型。
    """
    s = str(raw if raw is not None else "").strip()
    if not s:
        raise ResetError("缺少活动标识", 400, code="missing_id")
    if sc["id_kind"] == "str":
        return s
    try:
        return int(s)
    except ValueError:
        raise ResetError(f"{sc['label']}的 ID 必须是数字，当前为 {s!r}", 400,
                         code="id_must_be_number",
                         params={"type": i18n_key(sc), "value": str(s)})


def _build_ctx(sc: dict[str, Any], aid: Any) -> dict[str, Any]:
    ctx: dict[str, Any] = {"aid": _coerce_id(sc, aid)}
    resolver = RESOLVERS.get(sc["key"])
    if resolver:
        ctx.update(resolver(aid))
    return ctx


def _master_cols(sc: dict[str, Any]) -> str:
    cols = ["id"]
    if sc["title_col"]:
        cols.append(sc["title_col"])
    if sc["creator_col"]:
        cols.append(sc["creator_col"])
    if sc["status"]:
        cols.append(sc["status"][0])
    if sc["key"] == "discussion":
        cols.append("group_mode")
    return ", ".join(cols)


def _master_row(sc: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    row = _one(sc["db"], f"SELECT {_master_cols(sc)} FROM {sc['master']} WHERE id = :aid", ctx)
    if not row:
        raise ResetError(f"{sc['label']}不存在或已被删除", 404, code="activity_missing",
                         params={"type": i18n_key(sc)})
    return row


def _effective_options(sc: dict[str, Any], master: dict[str, Any],
                       options: dict[str, bool] | None) -> dict[str, bool]:
    """生效值 = 显式选择覆盖默认值；再按活动自身配置补一次（讨论 auto 模式）"""
    eff = dict(OPTION_DEFAULTS)
    for k, v in (options or {}).items():
        if k in OPTION_LABELS:
            eff[k] = bool(v)
        else:
            logger.debug(f"[活动重置] 忽略未知选项: {k}")
    for opt, rule in sc["auto_options"]:
        if opt in (options or {}):
            continue                                    # 用户显式选过就不覆写
        if rule == "group_mode=auto":
            eff[opt] = (master.get("group_mode") or "auto") == "auto"
    return eff


def _scope_options(sc: dict[str, Any]) -> tuple[str, ...]:
    if sc["options"] is not None:
        return tuple(sc["options"])
    base: list[str] = [OPT_CLEAR_REWARDS, OPT_CLEAR_NOTIFY]
    if sc["wrong_book_source"]:
        base.append(OPT_CLEAR_WRONG_BOOK)
    base += [t["option"] for t in sc["targets"] if t["option"]]
    if sc["status"]:
        base.append(OPT_RESET_STATUS)
    return tuple(dict.fromkeys(base))


def _active_targets(sc: dict[str, Any], eff: dict[str, bool]) -> list[dict[str, Any]]:
    return [t for t in sc["targets"] if not t["option"] or eff.get(t["option"], False)]


def _reward_ids(sc: dict[str, Any], ctx: dict[str, Any]) -> list[str]:
    base = str(ctx.get(sc["reward_id_key"], ctx["aid"]))
    ids = [base]
    for tpl in sc["legacy_reward_ids"]:
        v = tpl.format(aid=base)
        if v not in ids:
            ids.append(v)
    return ids


# ────────────────────────── 统计 ──────────────────────────

def _reward_stats(sc: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    empty = {"count": 0, "points": 0, "students": []}
    if not sc["reward_types"]:
        return empty
    tph, tparams = _placeholders(list(sc["reward_types"]), "t")
    iph, iparams = _placeholders(_reward_ids(sc, ctx), "r")
    row = _one(DB_MAIN,
               f"""SELECT COUNT(*) AS cnt, COALESCE(SUM(points),0) AS pts,
                          GROUP_CONCAT(DISTINCT student_username) AS studs
                   FROM activity_rewards WHERE activity_type IN {tph} AND activity_id IN {iph}""",
               {**tparams, **iparams})
    if not row:
        return empty
    return {"count": int(row["cnt"] or 0), "points": int(row["pts"] or 0),
            "students": [s for s in (row["studs"] or "").split(",") if s]}


# 带 payload 的通知是"系统回执"（如重置告知），它和活动内容共用 source_type/source_id 以便点击跳转，
# 但不属于"活动关联的通知"，不能在一次重置时被自己清掉——否则学生再也找不到"记录被清空"的说明
NOTICE_SKIP = " AND COALESCE(payload, '') = ''"


def _notify_count(sc: dict[str, Any], ctx: dict[str, Any]) -> int:
    if not sc["notify_type"]:
        return 0
    rid = str(ctx.get(sc["reward_id_key"], ctx["aid"]))
    row = _one(DB_MAIN, "SELECT COUNT(*) AS cnt FROM notifications"
                        f" WHERE source_type = :st AND source_id = :sid{NOTICE_SKIP}",
               {"st": sc["notify_type"], "sid": rid})
    return int(row["cnt"]) if row else 0


def _wrong_book_stats(sc: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    empty = {"count": 0, "students": []}
    if not sc["wrong_book_source"]:
        return empty
    row = _one(DB_MAIN,
               """SELECT COUNT(*) AS cnt, GROUP_CONCAT(DISTINCT student_username) AS studs
                  FROM wrong_book WHERE source = :src AND source_id = :aid""",
               {"src": sc["wrong_book_source"], "aid": ctx["aid"]})
    if not row:
        return empty
    return {"count": int(row["cnt"] or 0), "students": [s for s in (row["studs"] or "").split(",") if s]}


def _target_stats(sc: dict[str, Any], ctx: dict[str, Any],
                  eff: dict[str, bool]) -> list[dict[str, Any]]:
    out = []
    for t in _active_targets(sc, eff):
        cnt = int((_one(t["db"], f"SELECT COUNT(*) AS cnt FROM {t['table']} WHERE {t['where']}", ctx)
                   or {}).get("cnt") or 0)
        students: list[str] = []
        if cnt and t["student_col"]:
            students = [str(r["s"]) for r in _fetch(
                t["db"], f"SELECT DISTINCT {t['student_col']} AS s FROM {t['table']} WHERE {t['where']}",
                ctx) if r.get("s")]
        out.append({"label": t["label"], "table": t["table"], "db": t["db"],
                    "count": cnt, "student_count": len(students), "_students": students})
    return out


def _affected_students(targets: list[dict[str, Any]], rewards: dict[str, Any],
                       wrong: dict[str, Any]) -> list[str]:
    names: set[str] = set()
    for t in targets:
        names.update(t["_students"])
    names.update(rewards["students"])
    names.update(wrong["students"])
    names.discard("")
    return sorted(names)


# ────────────────────────── 对外接口 ──────────────────────────

def describe_scope(activity_type: str) -> dict[str, Any]:
    """给前端渲染用：这一类保留什么、可勾什么、有哪些注意事项"""
    sc = _scope(activity_type)
    return {
        "activity_type": sc["key"],
        "i18n_key": i18n_key(sc),
        "label": sc["label"],
        "keep_content": [{"key": k, "label": v} for k, v in sc["keep"]],
        "clears": [t["label"] for t in sc["targets"]],
        "options": [{"key": k, "label": OPTION_LABELS[k], "default": OPTION_DEFAULTS[k]}
                    for k in _scope_options(sc)],
        "notes": _texts(list(sc["notes"]) + list(sc["warnings"])),
    }


def i18n_key(sc: dict[str, Any]) -> str:
    """这一类活动在 i18n 词典里的键（列表页词表用 camelCase）。
    由服务端下发，前端只查表，不再自己维护 snake->camel 映射，免得规则散到页面里。"""
    return sc.get("i18n_key") or sc["key"]


def _texts(pairs) -> list[dict[str, str]]:
    """(code, 中文兜底) -> {code, text}；前端优先按 code 查词典，查不到才用中文兜底"""
    return [{"code": c, "text": t} for c, t in pairs]


def status_pair(frm: str, to: str) -> dict[str, str]:
    """状态枚举对 -> 中文标签对，供前端直接展示，避免原始枚举漏到界面上"""
    return {"from_label": STATUS_LABELS.get(frm, frm), "to_label": STATUS_LABELS.get(to, to)}


def _status_plan(sc: dict[str, Any], master: dict[str, Any], eff: dict[str, bool]) -> dict[str, Any] | None:
    if not sc["status"] or not eff[OPT_RESET_STATUS]:
        return None
    col, froms, to = sc["status"]
    cur = master.get(col) or ""
    nxt = to if cur in froms else cur
    return {"column": col, "from": cur, "to": nxt, "will_change": cur in froms,
            **status_pair(cur, nxt)}


def preview_reset(activity_type: str, activity_id: Any,
                  options: dict[str, bool] | None = None) -> dict[str, Any]:
    """只读干跑：把"将删什么、删多少"完整算出来，供二次确认展示"""
    sc = _scope(activity_type)
    ctx = _build_ctx(sc, activity_id)
    master = _master_row(sc, ctx)
    eff = _effective_options(sc, master, options)

    targets = _target_stats(sc, ctx, eff)
    rewards = _reward_stats(sc, ctx) if eff[OPT_CLEAR_REWARDS] else {"count": 0, "points": 0, "students": []}
    wrong = _wrong_book_stats(sc, ctx) if eff[OPT_CLEAR_WRONG_BOOK] else {"count": 0, "students": []}
    notify_cnt = _notify_count(sc, ctx) if eff[OPT_CLEAR_NOTIFY] else 0
    students = _affected_students(targets, rewards, wrong)

    raw_status = (master.get(sc["status"][0]) if sc["status"] else "") or ""
    warnings = _texts(sc["warnings"])
    in_progress = {"count": 0, "label": "", "code": ""}
    if sc["in_progress"]:
        tbl, cond, ip_code, label = sc["in_progress"]
        cnt = int((_one(sc["db"], f"SELECT COUNT(*) AS cnt FROM {tbl} WHERE {cond}", ctx)
                   or {}).get("cnt") or 0)
        in_progress = {"count": cnt, "label": label, "code": ip_code}
        if cnt:
            # 中文只做兜底；界面按 code + label_code 查词典渲染
            warnings.append({"code": "in_progress",
                             "params": {"count": cnt, "label": label, "label_code": ip_code},
                             "text": f"检测到{label} {cnt} 条：重置会打断进行中的参与，需强制确认"})

    plan = _status_plan(sc, master, eff)
    # "当前状态不在可回滚范围"属于纯展示信息，交前端按语言渲染（见 statusKeep 文案）

    title = ctx.get("title") or (
        (master.get(sc["title_col"]) or "") if sc["title_col"] else "") or f"{sc['label']}#{activity_id}"
    shown = plain_title(title) or title
    total_rows = sum(t["count"] for t in targets) + rewards["count"] + notify_cnt + wrong["count"]
    # 要不要强制、要不要输入确认口令、有没有东西可删——这些是业务规则，统一在服务端算，
    # 前端只按 policy 渲染；execute_reset 会按同一份规则再校验一次，防止绕过界面直接调 API
    policy = {
        "requires_force": bool(in_progress["count"]),
        "requires_confirmation": bool(shown.strip()),
        # 口令用纯文本标题：既不用户去抄 markdown 符号，也不受显示端裁剪影响
        "confirmation_expected": shown,
        "nothing_to_do": total_rows == 0 and not (plan and plan["will_change"]),
    }
    return {
        "dry_run": True,
        "policy": policy,
        "activity": {
            "id": activity_id, "type": sc["key"], "type_label": sc["label"],
            "type_i18n_key": i18n_key(sc), "title": title, "title_plain": shown,
            "creator": ctx.get("owner") or (master.get(sc["creator_col"]) if sc["creator_col"] else ""),
            "status": raw_status,
            "status_label": STATUS_LABELS.get(raw_status, raw_status),
            "grade": ctx.get("grade", ""),
            "id_kind": sc["id_kind"],
        },
        "options_effective": {k: eff[k] for k in _scope_options(sc)},
        "targets": [{k: v for k, v in t.items() if not k.startswith("_")} for t in targets],
        "rewards": {"rows": rewards["count"], "points": rewards["points"]},
        "notifications": notify_cnt,
        "wrong_book": wrong["count"],
        "students_affected": len(students),
        "student_usernames": students,
        "student_preview": students[:_PREVIEW_STUDENT_LIMIT],
        "status_reset": plan,
        "total_rows": total_rows,
        "warnings": warnings,
        "in_progress": in_progress,
    }


def execute_reset(activity_type: str, activity_id: Any, options: dict[str, bool] | None = None,
                  operator: str = "", force: bool = False,
                  confirm_text: str = "") -> dict[str, Any]:
    """执行重置：返回每步实际删除行数，供审计与前端回执使用"""
    sc = _scope(activity_type)
    ctx = _build_ctx(sc, activity_id)
    master = _master_row(sc, ctx)
    eff = _effective_options(sc, master, options)

    if sc["in_progress"] and not force:
        tbl, cond, ip_code, label = sc["in_progress"]
        cnt = int((_one(sc["db"], f"SELECT COUNT(*) AS cnt FROM {tbl} WHERE {cond}", ctx)
                   or {}).get("cnt") or 0)
        if cnt:
            raise ResetError(f"检测到{label} {cnt} 条，重置将打断进行中的参与；确认无误请使用强制重置", 409,
                             code="in_progress_force",
                             params={"count": cnt, "label": label, "label_code": ip_code,
                                     "type": i18n_key(sc)})

    plan = preview_reset(activity_type, activity_id, eff)   # 与预览同一口径
    students = plan["student_usernames"]                    # 完整名单（不受展示截断影响）

    pol = plan["policy"]
    if pol["requires_confirmation"] and plain_title(confirm_text) != pol["confirmation_expected"]:
        # 界面上"输入活动名称确认"不是装饰：不通过就拒绝执行，脚本也绕不过去
        raise ResetError("确认文案与活动名称不一致，已拒绝重置", 400, code="confirm_mismatch",
                         params={"type": i18n_key(sc)})

    by_db: dict[str, list[dict[str, Any]]] = {DB_MAIN: [], DB_QDB: []}
    plan_counts = {x["table"]: x["count"] for x in plan["targets"]}
    for t in _active_targets(sc, eff):
        if not plan_counts.get(t["table"], 0):
            continue                                        # 空表不发 DELETE，回执更干净
        by_db[t["db"]].append({"table": t["table"], "label": t["label"],
                               "sql": f"DELETE FROM {t['table']} WHERE {t['where']}",
                               "params": dict(ctx)})

    # 与数据表同一规则：预览计数为 0 就不发 DELETE，审计回执里只留真实发生的删除
    if eff[OPT_CLEAR_REWARDS] and sc["reward_types"] and plan["rewards"]["rows"]:
        tph, tparams = _placeholders(list(sc["reward_types"]), "t")
        iph, iparams = _placeholders(_reward_ids(sc, ctx), "r")
        by_db[DB_MAIN].append({
            "table": "activity_rewards", "label": "积分流水",
            "sql": f"DELETE FROM activity_rewards WHERE activity_type IN {tph} AND activity_id IN {iph}",
            "params": {**tparams, **iparams}})

    if eff[OPT_CLEAR_NOTIFY] and sc["notify_type"] and plan["notifications"]:
        rid = str(ctx.get(sc["reward_id_key"], ctx["aid"]))
        by_db[DB_MAIN].append({
            "table": "notifications", "label": "活动通知",
            "sql": f"DELETE FROM notifications WHERE source_type = :st AND source_id = :sid{NOTICE_SKIP}",
            "params": {"st": sc["notify_type"], "sid": rid}})

    if eff[OPT_CLEAR_WRONG_BOOK] and sc["wrong_book_source"] and plan["wrong_book"]:
        by_db[DB_MAIN].append({
            "table": "wrong_book", "label": "错题本条目",
            "sql": "DELETE FROM wrong_book WHERE source = :src AND source_id = :aid",
            "params": {"src": sc["wrong_book_source"], "aid": ctx["aid"]}})

    deleted: list[dict[str, Any]] = []
    for db in (DB_QDB, DB_MAIN):            # 数据表在前、派生表在后；两库各自原子提交
        for op in _in_tx(db, by_db[db]):
            deleted.append({"db": db, "table": op["table"], "label": op["label"], "rows": op["rows"]})

    status_reset = None
    if eff[OPT_RESET_STATUS] and sc["status"]:
        col, froms, to = sc["status"]
        cur = master.get(col) or ""
        if cur in froms:
            sets = [f"{col} = :toval"] + [f"{c} = NULL" for c in sc["clear_cols"]]
            _in_tx(sc["db"], [{"table": sc["master"], "label": "活动状态",
                               "sql": f"UPDATE {sc['master']} SET {', '.join(sets)} WHERE id = :aid",
                               "params": {"aid": ctx["aid"], "toval": to}}])
            status_reset = {"column": col, "from": cur, "to": to, **status_pair(cur, to)}
        else:
            status_reset = {"column": col, "from": cur, "to": cur, "unchanged": True,
                            **status_pair(cur, cur)}

    points_recomputed = _recompute_points(students, deleted)
    runtime_done = _run_runtime(sc, ctx)

    result = {
        "ok": True,
        "activity": plan["activity"],
        "deleted": deleted,
        "deleted_total": sum(d["rows"] for d in deleted),
        "rewards_rows": _rows_of(deleted, "activity_rewards"),
        "rewards_points": plan["rewards"]["points"],
        "notifications_rows": _rows_of(deleted, "notifications"),
        "wrong_book_rows": _rows_of(deleted, "wrong_book"),
        "status_reset": status_reset,
        "students_affected": len(students),
        "student_usernames": students,
        "points_recomputed_students": points_recomputed,
        "runtime": runtime_done,
        "options_effective": eff,
        "operator": operator,
        "finished_at": _now(),
    }
    logger.info(
        f"[活动重置] {operator or '系统'} 重置 {sc['label']}#{activity_id}"
        f"（{result['activity']['title']}）: 删除 {result['deleted_total']} 行,"
        f" 回收积分 {result['rewards_points']} 分/{result['rewards_rows']} 条,"
        f" 影响 {len(students)} 名学生, 状态 {status_reset or '未变'}"
    )
    return result


def _rows_of(deleted: list[dict[str, Any]], table: str) -> int:
    return sum(d["rows"] for d in deleted if d["table"] == table)


def _recompute_points(students: list[str], deleted: list[dict[str, Any]]) -> int:
    """删过积分流水就必须重算总分，否则 student_total_points 与流水对不上（排行榜虚高）"""
    if not _rows_of(deleted, "activity_rewards") or not students:
        return 0
    from backend.reward_engine import update_student_total
    done = 0
    for stu in students:
        try:
            update_student_total(stu, check_upgrade=False)   # 决策 4：不自动降级称号/徽章
            done += 1
        except Exception as e:
            logger.warning(f"[活动重置] 重算 {stu} 总积分失败: {e}")
    return done


def _run_runtime(sc: dict[str, Any], ctx: dict[str, Any]) -> list[str]:
    """清理进程内状态。抢答房间态只活在内存里，不清就会把旧分数再广播回学生端。"""
    if sc["runtime"] != "quick_quiz":
        return []
    try:
        from backend.api.quick_quiz_router import game_manager
        game_manager.remove_room(int(ctx["aid"]))
        return ["quick_quiz:game_room"]
    except Exception as e:
        logger.warning(f"[活动重置] 清理抢答内存房间态失败（数据已重置，不影响结果）: {e}")
        return []


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")
