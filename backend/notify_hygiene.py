"""
存量通知来源回填（一次性幂等修复）

背景（P0-C）：`notifications` 有 `source_type` / `source_id` 两列，各活动路由的清理语句
（删除活动 / 将来的重置活动）也都按这两列写，但历史上所有发送方都没传值，
导致这些清理语句长期空转 —— 删除活动后学生端仍留着指向它的僵尸通知。

Step 2A 已补齐 15 个写入点；本模块回填存量行，让清理口径对历史数据同样生效。

回填判据 = 通知标题（或正文）里的活动名，且**只有唯一命中才回填**：
- 命中 0 个（活动已被删除）与命中多个（同名活动）都保留原样，绝不猜。
- 课堂提问类标题里没有活动名，改用正文前缀反查 interaction_questions.content，
  并要求片段足够长且唯一命中。

跑完在 `system_state` 打标记，启动期不再重跑；扩充判据后把 RULE_VERSION +1
即可让所有环境带着新规则重扫一次（本模块全程幂等，重跑不产生额外修改）。
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Optional

from backend.database import execute_query, get_transaction
from backend.logger import logger

RULE_VERSION = 2
_STATE_KEY = f"notification_source_backfill_v{RULE_VERSION}"
_TITLE_RE = re.compile("「(.*?)」")
# 正文反查活动名时的最小匹配长度，太短容易误命中多条
_MIN_QUESTION_FRAG = 8

# (标题前缀, source_type, 活动名所在位置: title=标题里的「」 / content=正文里的「」)
_RULES: tuple[tuple[tuple[str, ...], str, str], ...] = (
    (("新考试「", "考试「"), "exam", "title"),
    (("学生提交答卷",), "exam", "content"),
    (("新随堂测验「",), "quiz", "title"),
    (("新投票「",), "poll", "title"),
)

# 课堂提问类：标题固定，活动名（问题正文）在 content 里
_QUESTION_TITLES = {
    "新课堂提问",
    "你的提问收到同学回答（待教师审批）",
    "有学生回答了提问，需要审批",
    "你的提问已被教师回答",
    "你的回答已通过教师审批",
    "你的提问已有回答（已通过教师审批）",
    "你的回答未通过教师审批，可重新回答",
}
_QUESTION_CONTENT_PREFIXES = ("学生提出了新问题：", "问题：")


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


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


def _load_lookups() -> dict[str, Any]:
    """活动名 -> [id] 反查表（考试在 questions.db，其余在主库）"""
    def build(rows) -> dict[str, list[int]]:
        m: dict[str, list[int]] = {}
        for rid, name in rows:
            key = (name or "").strip()
            if key:
                m.setdefault(key, []).append(int(rid))
        return m

    from backend.question_db import execute_query as q_query

    return {
        "exam": build([(r["id"], r["title"]) for r in q_query("SELECT id, title FROM exams") or []]),
        "quiz": build(execute_query("SELECT id, title FROM interaction_quizzes") or []),
        "poll": build(execute_query("SELECT id, question FROM interaction_polls") or []),
        "question": [(r[0], (r[1] or "").strip())
                     for r in (execute_query("SELECT id, content FROM interaction_questions") or [])],
    }


def _match_rule(title: str) -> tuple[str, str]:
    """返回 (source_type, 判据模式)；非活动类通知返回 ("", "")"""
    t = (title or "").strip()
    for prefixes, stype, field in _RULES:
        if any(t.startswith(p) for p in prefixes):
            return stype, field
    if t in _QUESTION_TITLES:
        return "question", "content_prefix"
    return "", ""


def _resolve(title: str, content: str, lookups: dict[str, Any]) -> tuple[str, str, str]:
    """定位通知所属活动，返回 (source_type, source_id, status)

    status: 'ok' 唯一命中 / 'unmatched' 活动已删或定不出 / 'ambiguous' 多命中 / 'no_pattern' 非活动类
    """
    stype, mode = _match_rule(title)
    if not stype:
        return "", "", "no_pattern"

    if mode == "content_prefix":
        body = (content or "").strip()
        for cp in _QUESTION_CONTENT_PREFIXES:
            if not body.startswith(cp):
                continue
            frag = body[len(cp):].strip()
            if frag.endswith("..."):         # 正文是按 50 字截断后补的省略号
                frag = frag[:-3].strip()
            if len(frag) < _MIN_QUESTION_FRAG:
                return "", "", "unmatched"
            hits = {qid for qid, qtext in lookups["question"] if qtext.startswith(frag)}
            if len(hits) == 1:
                return stype, str(hits.pop()), "ok"
            return "", "", ("ambiguous" if hits else "unmatched")
        return "", "", "unmatched"

    source_text = title if mode == "title" else content
    m = _TITLE_RE.search(source_text or "")
    if not m:
        return "", "", "unmatched"
    ids = lookups[stype].get(m.group(1).strip(), [])
    if len(ids) == 1:
        return stype, str(ids[0]), "ok"
    return "", "", ("ambiguous" if len(ids) > 1 else "unmatched")


def backfill_notification_sources(dry_run: bool = False, force: bool = False) -> dict[str, Any]:
    """回填 notifications.source_type / source_id；dry_run=True 时只统计不写库"""
    report: dict[str, Any] = {
        "dry_run": dry_run, "candidates": 0,
        "backfilled": {"exam": 0, "quiz": 0, "poll": 0, "question": 0},
        "unmatched": 0, "ambiguous": 0, "no_pattern": 0,
        "pass": "skipped(already-marked)", "changed": False,
    }
    try:
        if not force and _state_get(_STATE_KEY) is not None:
            return report
        report["pass"] = "dry-run" if dry_run else "ran"

        rows = execute_query(
            "SELECT id, title, content FROM notifications"
            " WHERE COALESCE(source_type, '') = '' AND COALESCE(source_id, '') = ''"
        ) or []
        report["candidates"] = len(rows)
        if not rows:
            report["pass"] = "ran(nothing-to-do)"
            if not dry_run:
                _state_set(_STATE_KEY, "empty")
            return report

        lookups = _load_lookups()
        ops: list[tuple[str, tuple[Any, ...]]] = []
        for nid, title, content in rows:
            stype, sid, status = _resolve(title or "", content or "", lookups)
            if status != "ok":
                report[status] += 1
                continue
            report["backfilled"][stype] += 1
            ops.append((
                "UPDATE notifications SET source_type=?, source_id=? WHERE id=?",
                (stype, sid, nid),
            ))

        if ops and not dry_run:
            with get_transaction() as conn:
                for sql, params in ops:
                    conn.execute(sql, params)
        report["changed"] = bool(ops)
        if not dry_run:
            _state_set(_STATE_KEY, f"v{RULE_VERSION}:ran:{len(ops)}")
        logger.info(
            f"[通知治理] {'[预演/dry-run] ' if dry_run else ''}存量来源回填: "
            f"候选 {report['candidates']} 条, 回填 {len(ops)} 条 {report['backfilled']}, "
            f"活动已删/定不出 {report['unmatched']} 条, 同名多命中 {report['ambiguous']} 条, "
            f"非活动类 {report['no_pattern']} 条"
        )
    except Exception as e:
        report["error"] = str(e)
        logger.warning(f"[通知治理] 存量回填失败（不阻断启动）: {e}")
    return report


if __name__ == "__main__":
    import json
    import sys

    print(json.dumps(
        backfill_notification_sources(dry_run="--dry-run" in sys.argv, force="--force" in sys.argv),
        ensure_ascii=False, indent=2,
    ))
