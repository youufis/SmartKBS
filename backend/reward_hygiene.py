"""
积分奖励流水口径治理（启动期幂等自愈）

这是"活动重置"功能的前置修复。`activity_rewards` 用 (activity_type, activity_id)
定位一个活动发出的积分流水，历史上存在两处口径缺陷，使"按活动清理流水"不可靠：

- R-A 命名空间冲突：同步练习写 ('practice', practice_sessions.id)，课程练习也曾写
  ('practice', knowledge_points.id)。两个 id 域重叠后：
    1) 按活动清理会互相误伤（重置"练习 #5"会连带删掉"课程知识点 #5"的流水）；
    2) `award_participation/award_grade` 的幂等检查误判为"已发放"，
       学生第二次参加（另一类活动）时静默不加分。
  写入侧已拆为 'practice'(同步练习) / 'course_practice'(课程练习)，本模块归位存量流水。

- R-B 抢答 activity_id 带前缀：写入侧曾用 f"quick_quiz_{room_id}"，而清理侧一律用
  str(room_id)，两边永不相交 -> 删除房间从不清理流水，`student_total_points` 虚高。
  写入侧已统一为 str(room_id)，本模块给存量流水去前缀。

- R-C 资源浏览 activity_id 不带资源类型：html 与 download 的 id 各自成体系，
  裸 id 让两种资源互相顶掉（后浏览的那种静默不给分）。写入侧已改成
  "{resource_type}:{resource_id}"，本模块给存量行补上类型，避免改键后
  已计过分的老资源被当成"第一次浏览"再给一次分。

- R-D 点名 activity_id 用姓名：写入侧按「姓名+年级+班级」反查 users 取第一条，
  同班两个"张三"永远查到同一个学号，而幂等键里也是姓名 -> 第二个张三当天被
  第一个人占位，答对也静默拿不到分。写入侧已改为优先用抽人台账里的学号，
  本模块把存量键里的姓名段替换成该行**实际入账的学号**（不猜身份、不动 points）。

安全约束：
- 只改标签（activity_type / activity_id），绝不改 points，因此学生总积分、称号、
  排行榜数值均不变（"全能选手"徽章除外：course_practice 早已在 ACTIVITY_TYPE_NAMES 中
  却从未被写入，导致该徽章按口径永远无法集齐，归位后才真正可达）。
- 幂等：R-B 每次都做廉价预检（可自愈老节点回写）；R-A 需要跨库读证据，
  完成一次后写 `system_state` 标记，后续启动直接跳过。
- 保守：R-A 仅在存在**行级正向证据**时才改写。证据冲突或不足的流水一律原样保留并告警，
  绝不按"id 落在哪个域"猜测归位（已删除的练习会话会留下无主流水，猜错就是错删他人积分）。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from backend.database import execute_query, get_transaction
from backend.logger import logger

QQ_TYPE = "quick_quiz"
QQ_LEGACY_PREFIX = "quick_quiz_"
PRACTICE_TYPE = "practice"
COURSE_PRACTICE_TYPE = "course_practice"
RESOURCE_VIEW_TYPE = "resource_view"
ROLLCALL_TYPE = "rollcall"

# R-A 规则的完成标记键。日后若新增/收紧归位规则，把版本号 +1 即可让存量库重跑一次。
HYGIENE_RULE_VERSION = 3   # v3 新增 R-D：点名幂等键里的姓名换成学号
_STATE_KEY = f"reward_keys_hygiene_v{HYGIENE_RULE_VERSION}"
_RESOURCE_VIEW_STATE_KEY = f"reward_resource_view_keyed_v2"
_ROLLCALL_STATE_KEY = f"reward_rollcall_keyed_v{HYGIENE_RULE_VERSION}"
_AMBIGUOUS_SAMPLE_LIMIT = 5


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ── system_state 读写（表缺失时按"未标记"处理，绝不因此中断启动）──

def _state_get(key: str) -> Optional[str]:
    try:
        rows = execute_query("SELECT value FROM system_state WHERE key=?", (key,))
        return rows[0][0] if rows else None
    except Exception:
        return None


def _state_set(key: str, value: str) -> None:
    with get_transaction() as conn:
        conn.execute(
            """INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at""",
            (key, value, _now()),
        )


# ── R-B：抢答流水去历史前缀 ──

def _preview_quick_quiz() -> tuple[int, int]:
    """返回 (待去前缀行数, 去前缀后会与既有流水重叠的行数)"""
    rows = execute_query(
        "SELECT id, activity_id FROM activity_rewards"
        " WHERE activity_type=? AND activity_id GLOB ?",
        (QQ_TYPE, f"{QQ_LEGACY_PREFIX}*"),
    ) or []
    if not rows:
        return 0, 0
    # 重叠 = 去前缀后与同一学生同类型的既有流水撞号（历史上前缀 bug 让幂等检查失效，
    # 同一房间被重复发过分的证据）。仅告警，不回收 points。
    overlap = int(execute_query(
        """SELECT COUNT(*) FROM activity_rewards a
           WHERE a.activity_type=? AND a.activity_id GLOB ?
             AND EXISTS(
                 SELECT 1 FROM activity_rewards b
                 WHERE b.id <> a.id AND b.student_username = a.student_username
                   AND b.activity_type = a.activity_type
                   AND b.reward_type = a.reward_type
                   AND b.activity_id = substr(a.activity_id, ?)
             )""",
        (QQ_TYPE, f"{QQ_LEGACY_PREFIX}*", len(QQ_LEGACY_PREFIX) + 1),
    )[0][0] or 0)
    return len(rows), overlap


def _normalize_quick_quiz() -> tuple[int, int]:
    """执行去前缀：activity_id 'quick_quiz_9' -> '9'（单事务）"""
    pending, overlap = _preview_quick_quiz()
    if pending:
        with get_transaction() as conn:
            conn.execute(
                "UPDATE activity_rewards SET activity_id = substr(activity_id, ?)"
                " WHERE activity_type=? AND activity_id GLOB ?",
                (len(QQ_LEGACY_PREFIX) + 1, QQ_TYPE, f"{QQ_LEGACY_PREFIX}*"),
            )
    return pending, overlap


# ── R-A：practice / course_practice 归位 ──

def _load_practice_evidence() -> dict[str, Any]:
    """读取归属判定证据。

    注意两个库的 helper 返回形态不同：
      - backend.database.execute_query      -> list[tuple]
      - backend.question_db.execute_query   -> list[dict]
    """
    from backend.question_db import execute_query as q_query

    ev: dict[str, Any] = {
        "session_ids": set(), "session_titles": {}, "attempt_pairs": set(),
        "kp_ids": set(), "kp_names": {}, "ai_result_pairs": set(),
    }
    try:
        for r in q_query("SELECT id, title FROM practice_sessions") or []:
            sid = str(r["id"])
            ev["session_ids"].add(sid)
            ev["session_titles"][sid] = (r.get("title") or "").strip()
        for r in q_query("SELECT session_id, student_username FROM practice_attempts") or []:
            ev["attempt_pairs"].add((str(r["session_id"]), r["student_username"]))
    except Exception as e:
        logger.warning(f"[积分治理] 读取 questions.db 练习证据失败: {e}")
    try:
        # knowledge_points 在主库(smartkb)，ai_practice_results 在 questions.db
        for r in execute_query("SELECT id, name FROM knowledge_points") or []:
            kid = str(r[0])
            ev["kp_ids"].add(kid)
            ev["kp_names"][kid] = (r[1] or "").strip()
        for r in q_query("SELECT kp_id, student_username FROM ai_practice_results") or []:
            ev["ai_result_pairs"].add((str(r["kp_id"]), r["student_username"]))
    except Exception as e:
        logger.warning(f"[积分治理] 读取课程练习证据失败: {e}")
    return ev


def _classify(activity_id: str, student: str, title: str, ev: dict[str, Any]) -> str:
    """判定单条 ('practice', id) 流水的真实归属

    返回：'course'(归位课程练习) / 'session'(确属同步练习) /
          'conflict'(两类答卷证据同时存在，无法回溯) / 'unknown'(无行级证据)

    判定顺序体现保守原则：该生该 id 的**行级提交证据**优先于标题匹配，
    标题匹配优先于"id 是否存在于某一域"。两者都没有时不写库。
    """
    has_se = (activity_id, student) in ev["attempt_pairs"]
    has_kp = (activity_id, student) in ev["ai_result_pairs"]
    if has_se and has_kp:
        # 同一学生既交过会话 #N 也做过知识点 #N：流水只会因第一次事件产生，
        # 事后无法回溯归属 -> 保留原样，不猜。
        return "conflict"
    if has_se:
        return "session"
    if has_kp:
        return "course"
    title = (title or "").strip()
    if title and ev["session_titles"].get(activity_id) == title:
        return "session"
    if title and ev["kp_names"].get(activity_id) == title:
        return "course"
    if activity_id in ev["session_ids"]:
        return "session"          # 会话仍然存在，无改写风险
    return "unknown"               # 可能来自已删除的会话，也可能来自课程练习


def _plan_practice_retype(ev: dict[str, Any]) -> tuple[list[tuple[str, tuple[Any, ...]]], dict[str, Any]]:
    """生成归位写操作清单（不执行），并把统计写进 report 片段"""
    rows = execute_query(
        "SELECT id, activity_id, student_username, activity_title"
        " FROM activity_rewards WHERE activity_type=?",
        (PRACTICE_TYPE,),
    ) or []
    ops: list[tuple[str, tuple[Any, ...]]] = []
    stat = {"kept_as_practice": 0, "conflict": 0, "unknown": 0, "samples": []}
    for rid, act_id, student, title in rows:
        aid = str(act_id or "").strip()
        if not aid.isdigit():
            stat["unknown"] += 1
            continue
        verdict = _classify(aid, student, title or "", ev)
        if verdict == "course":
            ops.append((
                "UPDATE activity_rewards SET activity_type=? WHERE id=?",
                (COURSE_PRACTICE_TYPE, rid),
            ))
        elif verdict == "session":
            stat["kept_as_practice"] += 1
        else:
            stat[verdict] += 1
            if len(stat["samples"]) < _AMBIGUOUS_SAMPLE_LIMIT:
                stat["samples"].append(
                    {"reward_id": rid, "activity_id": aid, "student": student,
                     "title": title, "verdict": verdict}
                )
    return ops, stat


# ── R-C：resource_view 幂等键补上资源类型 ──

def _plan_resource_view_keying() -> tuple[list[tuple[str, tuple[Any, ...]]], int]:
    """把 ('resource_view', '6') 这类裸 id 归位成 ('resource_view', 'html:6')。

    写入侧现在用 f"{resource_type}:{resource_id}"，因为 html 与 download 的 id 各自
    成体系，裸 id 会让两种资源互相顶掉（后者静默不给分）。但不同步归位存量行的话，
    改键等于把"已经拿过分的资源"重新变成第一次浏览，学生再点一次就白得 1 分。

    证据来自同一张埋点表 resource_view_logs：该生该 resource_id 只出现过一种
    resource_type 才归位；两种都有（真撞号）或查不到证据，一律保留原样，绝不猜。
    """
    rows = execute_query(
        "SELECT id, student_username, activity_id FROM activity_rewards"
        " WHERE activity_type=? AND activity_id NOT LIKE '%:%'",
        (RESOURCE_VIEW_TYPE,),
    ) or []
    ops: list[tuple[str, tuple[Any, ...]]] = []
    ambiguous = 0
    for rid, student, act_id in rows:
        aid = str(act_id or "").strip()
        if not aid.isdigit():
            ambiguous += 1
            continue
        types = {str(r[0] or "") for r in (execute_query(
            "SELECT DISTINCT resource_type FROM resource_view_logs"
            " WHERE student_username=? AND resource_id=?",
            (student, int(aid)),
        ) or []) if str(r[0] or "")}
        if len(types) != 1:
            ambiguous += 1
            continue
        ops.append((
            "UPDATE activity_rewards SET activity_id=? WHERE id=?",
            (f"{next(iter(types))}:{aid}", rid),
        ))
    return ops, ambiguous


# ── R-D：点名幂等键里的姓名换成学号 ──

def _plan_rollcall_keying() -> tuple[list[tuple[str, tuple[Any, ...]]], int]:
    """把 ('rollcall', '高一_1班_张三_2026-10-24') 归位成 ('rollcall', '高一_1班_s11048_2026-10-24')。

    写入侧的键已改成以**台账学号**为主：旧写法按「姓名+年级+班级」反查 users 取第一条，
    同班两个"张三"永远查到同一个学号，而幂等键里又是姓名 —— 第二个张三当天被第一个
    人占位，答对也静默拿不到分。不归位存量行的话，改键后同一个人当天再被点名答对，
    会因为新键查无旧行而多拿一次参与分。

    这里不需要猜身份：每行流水本来就记着**实际入账的那个学号**（student_username），
    把键里的姓名段替换成它即可，与写入侧新口径逐字一致。
    目标键已被占用（历史上真发生过双发）的行保留原样并计数，绝不合并 points。
    """
    rows = execute_query(
        "SELECT id, student_username, activity_id, reward_type FROM activity_rewards"
        " WHERE activity_type=?",
        (ROLLCALL_TYPE,),
    ) or []
    ops: list[tuple[str, tuple[Any, ...]]] = []
    conflict = 0
    for rid, stu, act_id, reward_type in rows:
        aid = str(act_id or "").strip()
        parts = aid.rsplit("_", 2)          # 前缀(年级_班级) _ 姓名或学号 _ 日期
        if len(parts) != 3:
            conflict += 1
            continue
        prefix, who, day = parts
        stu = str(stu or "").strip()
        if not stu or who == stu:
            continue                          # 已经是学号键，或行本身没有学号
        target = f"{prefix}_{stu}_{day}"
        if execute_query(
            "SELECT id FROM activity_rewards"
            " WHERE student_username=? AND activity_type=? AND activity_id=? AND reward_type=?",
            (stu, ROLLCALL_TYPE, target, str(reward_type or "")),
        ):
            conflict += 1                     # 目标键已有同档流水：不合并，保留原样
            continue
        ops.append(("UPDATE activity_rewards SET activity_id=? WHERE id=?", (target, rid)))
    return ops, conflict


# ── 入口 ──

def normalize_reward_activity_keys(dry_run: bool = False, force: bool = False) -> dict[str, Any]:
    """修复积分流水口径；dry_run=True 时只报告不改库，force=True 时忽略完成标记重跑 R-A。

    任何异常都被吞掉并降级为告警：这是启动期的尽力自愈，不能阻断服务。
    """
    report: dict[str, Any] = {
        "dry_run": dry_run,
        "quick_quiz_prefix_fixed": 0, "quick_quiz_overlap": 0,
        "course_practice_retyped": 0, "kept_as_practice": 0,
        "conflict": 0, "unknown": 0, "ambiguous_samples": [],
        "practice_pass": "skipped(already-marked)",
        "resource_view_keyed": 0, "resource_view_ambiguous": 0,
        "resource_view_pass": "skipped(already-marked)",
        "rollcall_keyed": 0, "rollcall_conflict": 0, "rollcall_pass": "skipped(already-marked)",
        "changed": False,
    }
    try:
        # R-B: 便宜且可自愈（老节点若仍回写带前缀的 id，下次启动再修一次）
        if dry_run:
            pending, overlap = _preview_quick_quiz()
            report["quick_quiz_prefix_fixed"] = pending
            report["quick_quiz_overlap"] = overlap
        else:
            fixed, overlap = _normalize_quick_quiz()
            report["quick_quiz_prefix_fixed"] = fixed
            report["quick_quiz_overlap"] = overlap
            if overlap:
                logger.warning(
                    f"[积分治理] 抢答流水去前缀后与既有流水重叠 {overlap} 例"
                    "（历史上同一房间被重复发分），积分未回收，如需校正请人工处理"
                )

        # R-A: 需要跨库读证据，做完一次即打标记
        if force or _state_get(_STATE_KEY) is None:
            ev = _load_practice_evidence()
            ops, stat = _plan_practice_retype(ev)
            report["kept_as_practice"] = stat["kept_as_practice"]
            report["conflict"] = stat["conflict"]
            report["unknown"] = stat["unknown"]
            report["ambiguous_samples"] = stat["samples"]
            report["course_practice_retyped"] = len(ops)
            report["practice_pass"] = "dry-run" if dry_run else "ran"
            if ops and not dry_run:
                with get_transaction() as conn:
                    for sql, params in ops:
                        conn.execute(sql, params)
        else:
            report["practice_pass"] = "skipped(already-marked)"

        # R-C: 资源浏览键归位（与 R-A 同样保守，只在有行级证据时动手）
        if force or _state_get(_RESOURCE_VIEW_STATE_KEY) is None:
            ops, ambiguous = _plan_resource_view_keying()
            report["resource_view_keyed"] = len(ops)
            report["resource_view_ambiguous"] = ambiguous
            report["resource_view_pass"] = "dry-run" if dry_run else "ran"
            if ops and not dry_run:
                with get_transaction() as conn:
                    for sql, params in ops:
                        conn.execute(sql, params)
        else:
            report["resource_view_pass"] = "skipped(already-marked)"

        # R-D: 点名键里的姓名归位成学号（用行内 student_username，无需猜身份）
        if force or _state_get(_ROLLCALL_STATE_KEY) is None:
            ops, conflict = _plan_rollcall_keying()
            report["rollcall_keyed"] = len(ops)
            report["rollcall_conflict"] = conflict
            report["rollcall_pass"] = "dry-run" if dry_run else "ran"
            if ops and not dry_run:
                with get_transaction() as conn:
                    for sql, params in ops:
                        conn.execute(sql, params)
        else:
            report["rollcall_pass"] = "skipped(already-marked)"

        report["changed"] = bool(
            report["quick_quiz_prefix_fixed"] or report["course_practice_retyped"]
            or report["resource_view_keyed"] or report["rollcall_keyed"]
        )
        if not dry_run and report["practice_pass"] == "ran":
            _state_set(_STATE_KEY, f"ran:{report['course_practice_retyped']}")
        if not dry_run and report["resource_view_pass"] == "ran":
            _state_set(_RESOURCE_VIEW_STATE_KEY, f"ran:{report['resource_view_keyed']}")
        if not dry_run and report["rollcall_pass"] == "ran":
            _state_set(_ROLLCALL_STATE_KEY, f"ran:{report['rollcall_keyed']}")
        if report["conflict"] or report["unknown"]:
            logger.info(
                f"[积分治理] practice 流水: 确属同步练习 {report['kept_as_practice']} 条,"
                f" 归位课程练习 {report['course_practice_retyped']} 条,"
                f" 证据冲突 {report['conflict']} 条, 无行级证据 {report['unknown']} 条（后两类保留原样）"
            )
        if report["changed"] and not dry_run:
            logger.info(
                f"[积分治理] 完成: 抢答去前缀 {report['quick_quiz_prefix_fixed']} 条,"
                f" 课程练习归位 {report['course_practice_retyped']} 条,"
                f" 资源浏览补类型键 {report['resource_view_keyed']} 条,"
                f" 点名键姓名改学号 {report['rollcall_keyed']} 条（分值未变动）"
            )
    except Exception as e:
        report["error"] = str(e)
        logger.warning(f"[积分治理] 流水口径修复失败（不阻断启动）: {e}")
    return report


if __name__ == "__main__":
    import json
    import sys

    print(json.dumps(
        normalize_reward_activity_keys(dry_run="--dry-run" in sys.argv, force="--force" in sys.argv),
        ensure_ascii=False, indent=2,
    ))
