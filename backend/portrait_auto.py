# -*- coding: utf-8 -*-
"""AI 画像：周期自动生成（P-7，默认关）。

每到新周期，为**上一周期有活动**的学生自动生成一张画像，并通知本人。
由系统配置 `PORTRAIT_AUTO_PUSH` 控制，**默认关闭** —— 打开后会自动消耗 AI 额度
（每个学生 = 1 次大模型 + 1 次生图），规模大的学校请先把周期调成每月。

幂等：以「该学生是否已有覆盖上一周期的画像」为判据（`student_portraits.period_start`），
所以每天跑也不会重复出图，失败的下一次会被重试（每轮上限 _BATCH 人）。

设计取舍：只做"周期自动生成"，未做"周报纯文字 + 月图"的双轨 —— 那需要第二套内容格式与
入口，且与首页动态重复；要省成本把周期调成每月或直接关掉即可。
"""
from __future__ import annotations

import asyncio
import threading
import time as _time
from datetime import datetime, timedelta

from backend.logger import logger

# 每轮最多处理多少个学生（避免一次把 AI 额度打满；剩下的下一轮继续）
_BATCH = 50
# 巡检间隔（秒）：半小时一次，足够"新周期开始后尽快出图"，又不会频繁查库
_INTERVAL = 30 * 60

_thread: threading.Thread | None = None


def _prev_period(period: str, today: datetime | None = None) -> tuple[str, str]:
    """上一个周期（周 / 月）的起止日期（today 仅供测试注入）"""
    today = today or datetime.now()
    if period == "monthly":
        first = today.replace(day=1)
        prev_end = first - timedelta(days=1)
        prev_start = prev_end.replace(day=1)
    else:
        monday = today - timedelta(days=today.weekday())
        prev_end = monday - timedelta(days=1)
        prev_start = prev_end - timedelta(days=6)
    return prev_start.strftime("%Y-%m-%d"), prev_end.strftime("%Y-%m-%d")


def _candidates(prev_start: str, prev_end: str) -> list[str]:
    """上一周期有活动、且还没有覆盖该周期画像的学生"""
    from backend.database import execute_query
    try:
        rows = execute_query(
            """SELECT DISTINCT ar.student_username
               FROM activity_rewards ar
               WHERE ar.created_at BETWEEN ? AND ?
                 AND NOT EXISTS (
                   SELECT 1 FROM student_portraits sp
                   WHERE sp.username = ar.student_username
                     AND sp.period_start = ?
                 )
               ORDER BY ar.student_username
               LIMIT ?""",
            (f"{prev_start} 00:00:00", f"{prev_end} 23:59:59", prev_start, _BATCH),
        ) or []
        return [r[0] for r in rows if r and r[0]]
    except Exception as e:
        logger.warning(f"[portrait-auto] 取候选学生失败: {e}")
        return []


async def _generate_for(username: str, period: str, prev_start: str, prev_end: str) -> bool:
    """为一名学生自动生成；返回是否成功出图"""
    from backend.api.portrait_router import _get_api_key, _run_generation
    from backend.api.config_router import get_config_value
    api_key = ""
    try:
        api_key = _get_api_key()
    except Exception:
        pass
    if not api_key:
        logger.info("[portrait-auto] 未配置 AI Key，跳过本轮")
        return False

    style = str(get_config_value("PORTRAIT_AUTO_STYLE", "random") or "random")
    try:
        out = await _run_generation(
            username=username, role=2, style=style, period=period,
            period_start=prev_start, period_end=prev_end, api_key=api_key, charged=0,
        )
    except Exception as e:
        logger.warning(f"[portrait-auto] {username} 生成失败: {e}")
        return False

    portrait = (out or {}).get("portrait") or {}
    if not portrait.get("id"):
        return False
    try:
        from backend.api.notification_router import notify_users
        notify_users(
            [username], "info",
            "你的 AI 画像已生成 🎨",
            f"{'本月' if period == 'monthly' else '上周'}的专属画像已就绪，点开看看这一期的自己。",
            "/portrait",
            source_type="portrait", source_id=str(portrait.get("id")),
        )
    except Exception as e:
        logger.warning(f"[portrait-auto] 通知失败({username}): {e}")
    return bool(portrait.get("image_path"))


def run_once() -> int:
    """跑一轮（可被测试/管理端手动触发），返回本轮成功出图人数"""
    from backend.api.config_router import get_config_value
    try:
        if not bool(get_config_value("PORTRAIT_AUTO_PUSH", False)):
            return 0
        if not bool(get_config_value("PORTRAIT_ENABLED", True)):
            return 0
    except Exception:
        return 0

    period = "monthly" if get_config_value("PORTRAIT_PERIOD_MONTHLY", False) else "weekly"
    prev_start, prev_end = _prev_period(period)
    students = _candidates(prev_start, prev_end)
    if not students:
        return 0

    logger.info(f"[portrait-auto] 本周期自动生成：{len(students)} 名学生（{prev_start} ~ {prev_end}）")
    done = 0
    # 一个事件循环跑完这批（每生一个 loop 开销大，也容易踩第三方库的 loop 绑定）
    loop = asyncio.new_event_loop()
    try:
        for username in students:
            try:
                if loop.run_until_complete(_generate_for(username, period, prev_start, prev_end)):
                    done += 1
            except Exception as e:
                logger.warning(f"[portrait-auto] {username} 异常: {e}")
    finally:
        loop.close()
    logger.info(f"[portrait-auto] 完成：成功 {done}/{len(students)}")
    return done


def _loop() -> None:
    _time.sleep(120)          # 启动后先让服务稳定
    while True:
        try:
            run_once()
        except Exception as e:
            logger.warning(f"[portrait-auto] 巡检异常: {e}")
        _time.sleep(_INTERVAL)


def start() -> None:
    """启动周期巡检线程（幂等：重复调用不会起第二个）"""
    global _thread
    if _thread and _thread.is_alive():
        return
    _thread = threading.Thread(target=_loop, daemon=True, name="portrait-auto")
    _thread.start()
    logger.info("[portrait-auto] 周期自动生成巡检已启动（受 PORTRAIT_AUTO_PUSH 控制，默认关）")
