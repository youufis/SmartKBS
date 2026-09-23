# -*- coding: utf-8 -*-
"""知识点挂接：把任意知识点（尤其是教师自建/教材外条目）指向**教材知识点**，多对多。

为什么需要它：题库标签与教材知识点是两套词，实测 540 个标签对不上任何知识点名、
139/234 个知识点一道题都召不到。字符串规则（相等/互为子串/题干实词）能自动吃掉的
已经吃掉了，剩下的是语义不同名但同一知识点的情况 —— 只能由人挂，工具不猜。

按已确认的规则实现：
  · 一对多（一个知识点可挂多个教材知识点）
  · 只挂到知识点级，**不允许挂章节**（避免把同章节其它知识点的题拉进来造成乱选）
  · 未挂接不拦截，只在生成结果里提示（见 gap_report / 练习生成 notice）
"""
from __future__ import annotations

from typing import Any

from backend.database import execute_query, execute_query_dict, get_transaction
from backend.logger import logger
from backend.question_select import norm


DDL = """CREATE TABLE IF NOT EXISTS kp_link (
    kp_id INTEGER NOT NULL,
    textbook_kp_id INTEGER NOT NULL,
    source TEXT DEFAULT 'manual',
    created_by TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    PRIMARY KEY (kp_id, textbook_kp_id)
)"""


def ensure_table() -> dict[str, Any]:
    """幂等建表：必须随启动自检跑。

    漏了它，部署机升级后 kp_link 表不存在 —— 挂接展开会静默降级（只写 debug），
    表现为"按钮点了没效果、接口 500"，而日志里看不出原因。
    """
    report: dict[str, Any] = {"changed": False, "table": "kp_link"}
    try:
        with get_transaction() as conn:
            had = conn.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='kp_link'").fetchone()[0]
            conn.execute(DDL)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_kp_link_src ON kp_link(kp_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_kp_link_dst ON kp_link(textbook_kp_id)")
            report["changed"] = not had
        if report["changed"]:
            logger.info("[启动自检] 挂接表 kp_link 已创建（首次）")
    except Exception as e:
        report["error"] = str(e)
        logger.warning(f"[挂接] 建表失败: {e}")
    return report


def _rowdict(r: Any) -> dict[str, Any]:
    """兼容 dict / sqlite3.Row / 元组 三种行形态。"""
    if isinstance(r, dict):
        return r
    try:
        return dict(r)
    except (TypeError, ValueError):
        return {}


def _kp_meta() -> dict[int, dict[str, Any]]:
    rows = execute_query_dict(
        """SELECT k.id, k.name, COALESCE(c.subject,'') AS subject, COALESCE(ch.name,'') AS chapter
           FROM knowledge_points k
           LEFT JOIN chapters ch ON ch.id = k.chapter_id
           LEFT JOIN courses c ON c.id = ch.course_id
           WHERE COALESCE(k.status,'') <> 'deleted'""") or []
    out: dict[int, dict[str, Any]] = {}
    for r in rows:
        d = _rowdict(r)
        try:
            out[int(d["id"])] = d
        except Exception:
            continue
    return out


def linked_targets(kp_id: int) -> list[dict[str, Any]]:
    """该知识点已挂接的教材知识点（含名称，供选题展开与前端回显）。"""
    try:
        ids = [int(_rowdict(r).get("textbook_kp_id"))
               for r in execute_query_dict("SELECT textbook_kp_id FROM kp_link WHERE kp_id=?", (int(kp_id),)) or []]
    except Exception as e:
        logger.debug(f"[挂接] 读取失败 kp_id={kp_id}: {e}")
        return []
    meta = _kp_meta()
    return [{"id": i, "name": meta.get(i, {}).get("name", ""),
             "subject": meta.get(i, {}).get("subject", "")} for i in ids if i in meta]


def expand_kp(kp_id: int) -> tuple[list[int], list[str]]:
    """选题用：返回 (自身+挂接目标 的 ID 列表, 对应的知识点名列表)。"""
    ids = [int(kp_id)] if kp_id else []
    names: list[str] = []
    for t in linked_targets(kp_id):
        if t["id"] not in ids:
            ids.append(int(t["id"]))
        if t.get("name"):
            names.append(t["name"])
    return ids, names


def set_links(kp_id: int, textbook_kp_ids: list[int], username: str = "") -> dict[str, Any]:
    """整体覆盖式保存挂接关系（前端提交一个数组即可，幂等）。"""
    meta = _kp_meta()
    kp_id = int(kp_id or 0)
    if kp_id not in meta:
        return {"ok": False, "error": "知识点不存在"}
    want: list[int] = []
    rejected: list[dict[str, Any]] = []
    for raw in textbook_kp_ids or []:
        try:
            tid = int(raw)
        except (TypeError, ValueError):
            continue
        if tid == kp_id:
            rejected.append({"id": tid, "reason": "不能挂到自己"})
            continue
        if tid not in meta:
            rejected.append({"id": tid, "reason": "目标知识点不存在或已删除"})
            continue
        if tid not in want:
            want.append(tid)
    try:
        with get_transaction() as conn:
            conn.execute("DELETE FROM kp_link WHERE kp_id=?", (kp_id,))
            for tid in want:
                conn.execute("INSERT OR IGNORE INTO kp_link (kp_id, textbook_kp_id, created_by)"
                             " VALUES (?,?,?)", (kp_id, tid, username or ""))
        logger.info(f"[挂接] {username or 'system'} 将「{meta[kp_id]['name']}」挂到 {len(want)} 个教材知识点")
        return {"ok": True, "kp_id": kp_id, "linked": want, "rejected": rejected}
    except Exception as e:
        logger.warning(f"[挂接] 保存失败 kp_id={kp_id}: {e}")
        return {"ok": False, "error": str(e), "linked": [], "rejected": rejected}


def tag_hit_counts() -> dict[str, int]:
    """规范化标签 -> 题数。一次读全库，供 gap_report 与候选排序共用。"""
    from backend.question_db import execute_query as bank_exec
    counts: dict[str, int] = {}
    for r in bank_exec("SELECT knowledge_points FROM question_bank WHERE status='active'") or []:
        d = _rowdict(r)
        for tag in str(d.get("knowledge_points") or "").replace("，", ",").replace("、", ",").split(","):
            nn = norm(tag)
            if nn:
                counts[nn] = counts.get(nn, 0) + 1
    return counts


def kp_info(kp_id: int) -> dict[str, Any]:
    return _kp_meta().get(int(kp_id or 0), {}) or {}


def kp_chapter_id(kp_id: int) -> int:
    """知识点所属章节 ID（用于按课程判权限）。表在 smartkb.db，这里只读。"""
    try:
        rows = execute_query("SELECT chapter_id FROM knowledge_points WHERE id=?", (int(kp_id),)) or []
        if not rows:
            return 0
        d = _rowdict(rows[0])
        return int(d.get("chapter_id") or 0)
    except Exception as e:
        logger.warning(f"[挂接] 取章节失败 kp_id={kp_id}: {e}")
        return 0


def candidate_kps(kp_id: int, limit: int = 60) -> list[dict[str, Any]]:
    """可挂接的教材知识点候选：同学科优先、按各自题库命中题数降序（0 命中的排最后）。"""
    meta = _kp_meta()
    self = meta.get(int(kp_id))
    if not self:
        return []
    counts = tag_hit_counts()
    rows = [{"id": kid, "name": info["name"], "subject": info.get("subject", ""),
             "chapter": info.get("chapter", ""), "hits": counts.get(norm(info["name"]), 0),
             "same_subject": 1 if info.get("subject") == self.get("subject") else 0}
            for kid, info in meta.items() if kid != int(kp_id)]
    rows.sort(key=lambda x: (-x["same_subject"], -x["hits"], x["name"]))
    return rows[:limit]


def gap_report(subject: str = "", only_gaps: bool = True) -> list[dict[str, Any]]:
    """缺口清单：每个知识点按"标签精确相等"能命中多少题、挂了几个、还缺多少。

    一次性读全库标签计数，避免逐个知识点打库（234 次查询太慢，不能放进请求路径）。
    """
    from backend.question_db import execute_query as bank_exec
    counts: dict[str, int] = {}
    try:
        for r in bank_exec("SELECT knowledge_points, subject FROM question_bank WHERE status='active'") or []:
            d = _rowdict(r)
            for tag in str(d.get("knowledge_points") or "").replace("，", ",").replace("、", ",").split(","):
                nn = norm(tag)
                if nn:
                    counts[nn] = counts.get(nn, 0) + 1
    except Exception as e:
        logger.warning(f"[挂接] 题库标签统计失败: {e}")
    links: dict[int, list[int]] = {}
    try:
        for r in execute_query_dict("SELECT kp_id, textbook_kp_id FROM kp_link") or []:
            d = _rowdict(r)
            links.setdefault(int(d["kp_id"]), []).append(int(d["textbook_kp_id"]))
    except Exception:
        pass
    meta = _kp_meta()
    rows: list[dict[str, Any]] = []
    for kid, info in sorted(meta.items()):
        if subject and info.get("subject") != subject:
            continue
        direct = counts.get(norm(info["name"]), 0)
        via_link = sum(counts.get(norm(meta[t]["name"]), 0) for t in links.get(kid, []) if t in meta)
        hit = direct + via_link
        if only_gaps and hit > 0:
            continue
        rows.append({"kp_id": kid, "kp_name": info["name"], "subject": info.get("subject", ""),
                     "chapter": info.get("chapter", ""), "direct_hits": direct,
                     "linked_hits": via_link, "links": len(links.get(kid, [])), "hits": hit})
    rows.sort(key=lambda x: (-x["hits"], x["kp_name"]))
    return rows
