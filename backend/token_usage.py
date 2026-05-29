"""
AI Token 用量统计工具
记录和查询每次 AI 调用的 token 消耗
"""
import time
from typing import Optional

from backend.database import get_connection, execute_query


def record_token_usage(
    username: str,
    user_role: int = 2,
    model: str = "",
    input_tokens: int = 0,
    output_tokens: int = 0,
    source: str = "chat",
    conversation_id: str = "",
):
    """记录一次 AI 调用的 token 消耗"""
    total = input_tokens + output_tokens
    if total <= 0:
        return
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    try:
        with get_connection() as conn:
            conn.cursor().execute(
                """INSERT INTO ai_token_usage
                   (username, user_role, model, input_tokens, output_tokens, total_tokens, source, conversation_id, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (username, user_role, model, input_tokens, output_tokens, total, source, conversation_id, now),
            )
            conn.commit()
    except Exception:
        pass


def get_token_usage_summary(
    username: Optional[str] = None,
    user_role: Optional[int] = None,
    range_type: str = "today",
    custom_from: str = "",
    custom_to: str = "",
) -> dict:
    """获取 token 用量汇总统计

    Args:
        username: 指定用户（None 表示不限制）
        user_role: 指定角色（None 表示不限制）
        range_type: today / yesterday / week / month / custom
        custom_from/custom_to: range_type=custom 时的起止日期
    Returns:
        { by_model: [...], by_source: [...], grand_total, total_requests }
    """
    from datetime import datetime, timedelta

    today = datetime.now().strftime("%Y-%m-%d")

    if range_type == "today":
        date_from = today
        date_to = today
    elif range_type == "yesterday":
        yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        date_from = yesterday
        date_to = yesterday
    elif range_type == "week":
        week_ago = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
        date_from = week_ago
        date_to = today
    elif range_type == "month":
        month_ago = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")
        date_from = month_ago
        date_to = today
    elif range_type == "custom":
        date_from = custom_from
        date_to = custom_to
    else:
        date_from = today
        date_to = today

    conditions = ["created_at >= ?", "created_at <= ?"]
    params: list = [date_from, date_to + " 23:59:59"]

    if username:
        conditions.append("username = ?")
        params.append(username)
    if user_role is not None:
        conditions.append("user_role = ?")
        params.append(user_role)

    where = " AND ".join(conditions)

    # 按模型分组
    by_model = execute_query(
        f"""SELECT model, SUM(input_tokens), SUM(output_tokens), SUM(total_tokens), COUNT(*)
            FROM ai_token_usage WHERE {where}
            GROUP BY model ORDER BY SUM(total_tokens) DESC""",
        tuple(params),
    )

    # 按来源分组
    by_source = execute_query(
        f"""SELECT source, SUM(total_tokens), COUNT(*)
            FROM ai_token_usage WHERE {where}
            GROUP BY source ORDER BY SUM(total_tokens) DESC""",
        tuple(params),
    )

    # 总计
    grand = execute_query(
        f"""SELECT COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
                   COALESCE(SUM(total_tokens), 0), COUNT(*)
            FROM ai_token_usage WHERE {where}""",
        tuple(params),
    )

    return {
        "by_model": [
            {"model": r[0], "input_tokens": r[1], "output_tokens": r[2], "total_tokens": r[3], "requests": r[4]}
            for r in by_model
        ],
        "by_source": [
            {"source": r[0], "total_tokens": r[1], "requests": r[2]}
            for r in by_source
        ],
        "grand_total": grand[0][2] if grand else 0,
        "total_input": grand[0][0] if grand else 0,
        "total_output": grand[0][1] if grand else 0,
        "total_requests": grand[0][3] if grand else 0,
    }


def get_token_usage_detail(
    username: Optional[str] = None,
    page: int = 1,
    page_size: int = 20,
) -> list:
    """获取 token 用量明细（分页）"""
    if username:
        rows = execute_query(
            """SELECT username, model, input_tokens, output_tokens, total_tokens, source, created_at
               FROM ai_token_usage WHERE username = ?
               ORDER BY id DESC LIMIT ? OFFSET ?""",
            (username, page_size, (page - 1) * page_size),
        )
    else:
        rows = execute_query(
            """SELECT username, model, input_tokens, output_tokens, total_tokens, source, created_at
               FROM ai_token_usage
               ORDER BY id DESC LIMIT ? OFFSET ?""",
            (page_size, (page - 1) * page_size),
        )
    return [
        {
            "username": r[0],
            "model": r[1],
            "input_tokens": r[2],
            "output_tokens": r[3],
            "total_tokens": r[4],
            "source": r[5],
            "created_at": r[6],
        }
        for r in rows
    ]
