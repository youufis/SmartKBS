"""公共选题逻辑：按 学科+题型+主题词 从学科题库(question_bank, questions.db)抽题。

随堂测验(AI 出题"题库优先、AI 补足")与同步练习(复用开关)共用，
避免两份实现漂移。返回原始行 dict（options 解析为 dict），
各业务端自行转换成前端展示格式。
"""
from __future__ import annotations

import json
from typing import Any

from backend.question_db import execute_query


def _parse_json_field(raw: Any, default: Any) -> Any:
    if isinstance(raw, str) and raw:
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return default
    return raw if raw is not None else default


def query_bank_questions(
    topic: str,
    subject: str,
    question_type: str,
    count: int,
    types: tuple[str, ...] | None = None,
) -> list[dict[str, Any]]:
    """随机抽取题库匹配题。

    topic 用于 knowledge_points / question_text 双字段 LIKE 模糊匹配；
    types 为候选题型白名单（默认与旧随堂测验口径一致：单选+判断）；
    question_type != "mixed" 时进一步限定为单一题型。
    """
    if count <= 0:
        return []
    types = tuple(types or ("single", "true_false"))
    conditions = ["status='active'", "type IN (" + ",".join("?" for _ in types) + ")"]
    params: list[Any] = list(types)

    if subject:
        conditions.append("subject=?")
        params.append(subject)

    if topic:
        conditions.append("(knowledge_points LIKE ? OR question_text LIKE ?)")
        kw = f"%{topic}%"
        params.extend([kw, kw])

    if question_type and question_type != "mixed":
        conditions.append("type=?")
        params.append(question_type)

    rows = execute_query(
        """SELECT id, type, question_text, options, correct_answer, explanation,
                  knowledge_points, difficulty,
                  svg_content, has_svg, media_files, media_placeholders
           FROM question_bank
           WHERE """ + " AND ".join(conditions) + """
           ORDER BY RANDOM()
           LIMIT ?""",
        tuple(params + [count]),
    )

    out: list[dict[str, Any]] = []
    for r in rows or []:
        r = dict(r)
        r["options"] = _parse_json_field(r.get("options"), {}) or {}
        r["media_files"] = _parse_json_field(r.get("media_files"), "")
        r["media_placeholders"] = _parse_json_field(r.get("media_placeholders"), "")
        out.append(r)
    return out
