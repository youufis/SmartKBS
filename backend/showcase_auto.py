# -*- coding: utf-8 -*-
"""荣耀殿堂：自动建卡（S1，默认开启）。

为什么可以很便宜：卡片上的积分/称号/进度/学科称号/徽章**本来就是实时覆盖**的
（见 showcase_router._overlay_live_points），快照里真正还会被用到的只有
「姓名/年级/班级」与默认主题。因此自动建卡不再跑人均 27ms 的 _build_snapshot，
而是「一条 SELECT + 一次 executemany INSERT」，可反复执行、天然幂等。

三条不变量（改这里之前先读）：
  1. **只为"达到积分门槛"的学生建卡**（默认门槛 1 分，即 0 分不建、不上墙）；
  2. **只补缺失，绝不改 is_active** —— 被教师下架的卡片不会被自动补齐复活；
  3. 建卡用的是"最小快照"（student_info + 称号/进度 + 空徽章数组），
     其余装饰性数据一律由 live 覆盖补齐；前端对缺字段也要有兜底。
"""
from __future__ import annotations

import json
import threading
import time as _time
from datetime import datetime
from typing import Any

from backend.database import execute_query, get_connection
from backend.logger import logger
from backend.title_system import get_badge_config, get_main_title, get_main_title_progress

# 巡检间隔（分钟）：兜住"学生积分从 0 变正"这种情况
_DEFAULT_INTERVAL_MIN = 30
# 单轮最多补多少人（避免一次全表写；剩下的下一轮继续）
_BATCH = 500
_thread: threading.Thread | None = None


def _cfg(key: str, default: Any = None) -> Any:
    try:
        from backend.api.config_router import get_config_value
        return get_config_value(key, default)
    except Exception:
        return default


def auto_enabled() -> bool:
    return bool(_cfg("SHOWCASE_AUTO_ENABLED", True))


def min_points() -> int:
    """上墙门槛：默认 1（= 有积分才上墙，0 分不上墙）"""
    try:
        return max(0, int(_cfg("SHOWCASE_MIN_POINTS", 1)))
    except (TypeError, ValueError):
        return 1


def _minimal_snapshot(name: str, grade: str, cls: str, points: int) -> str:
    """最小快照：装饰性数据留空由 live 覆盖，但结构齐全（前端不再因缺字段崩）"""
    main_title = get_main_title(points)
    try:
        badge_total = len(get_badge_config())
    except Exception:
        badge_total = 0
    return json.dumps({
        "total_points": points,
        "main_title": main_title,
        "progress": get_main_title_progress(points),
        "subject_titles": [],
        "badges": [],
        "unlocked_badge_count": 0,
        "total_badge_count": badge_total,
        "student_info": {"name": name or "", "grade": grade or "", "class": cls or ""},
        "theme_style": "auto",
        "auto_created": True,
    }, ensure_ascii=False)


def ensure_cards(usernames: list[str] | None = None, *,
                 grade: str = "", class_name: str = "", limit: int = _BATCH) -> int:
    """为"有积分但还没有卡"的学生补卡；返回本次新建数量。

    usernames 给了就只在这一批里补（页面惰性补齐用），否则按 grade/class 全量扫。
    """
    if not auto_enabled():
        return 0
    threshold = min_points()
    conds = ["u.role = 2",
             "COALESCE(u.status, 'active') = 'active'",
             "COALESCE(stp.total_points, 0) >= ?",
             "NOT EXISTS (SELECT 1 FROM student_showcase sc WHERE sc.student_username = u.username)"]
    params: list[Any] = [threshold]
    if usernames:
        ph = ",".join("?" * len(usernames))
        conds.append(f"u.username IN ({ph})")
        params.extend(usernames)
    if grade:
        conds.append("u.grade = ?")
        params.append(grade)
    if class_name:
        conds.append("u.class = ?")
        params.append(str(class_name).replace("班", "").strip())

    rows = execute_query(
        f"""SELECT u.username, COALESCE(u.name, u.username), COALESCE(u.grade, ''),
                   COALESCE(u.class, ''), COALESCE(stp.total_points, 0)
            FROM users u
            JOIN student_total_points stp ON stp.student_username = u.username
            WHERE {' AND '.join(conds)}
            ORDER BY COALESCE(stp.total_points, 0) DESC
            LIMIT ?""",
        tuple(params + [max(1, int(limit))]),
    ) or []
    if not rows:
        return 0

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    batch_id = f"auto_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    payload = [
        (r[0], "system", _minimal_snapshot(r[1], r[2], r[3], int(r[4] or 0)),
         "auto", 0, batch_id, now_str, now_str)
        for r in rows
    ]
    created = 0
    with get_connection() as conn:
        c = conn.cursor()
        for one in payload:
            # 再判一次"是否存在"：并发下（页面补齐 + 巡检同时跑）避免撞唯一键
            exists = c.execute("SELECT 1 FROM student_showcase WHERE student_username=?",
                               (one[0],)).fetchone()
            if exists:
                continue
            c.execute(
                """INSERT OR IGNORE INTO student_showcase
                   (student_username, generated_by, snapshot_data, theme_style,
                    sort_order, batch_id, generated_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?)""", one)
            created += 1
        conn.commit()
    if created:
        logger.info(f"[showcase-auto] 自动建卡 {created} 张（门槛 {threshold} 分，候选 {len(rows)}）")
    return created


def run_once() -> int:
    """兜底巡检：把"新达到门槛"的学生补上卡（幂等）"""
    try:
        return ensure_cards()
    except Exception as e:
        logger.warning(f"[showcase-auto] 巡检失败: {e}")
        return 0


def _loop() -> None:
    _time.sleep(180)          # 启动后先让服务稳定
    while True:
        try:
            interval = max(5, int(_cfg("SHOWCASE_AUTO_INTERVAL_MIN", _DEFAULT_INTERVAL_MIN) or 30))
        except (TypeError, ValueError):
            interval = _DEFAULT_INTERVAL_MIN
        try:
            run_once()
        except Exception as e:
            logger.warning(f"[showcase-auto] 循环异常: {e}")
        _time.sleep(interval * 60)


def start() -> None:
    """启动巡检线程（幂等）"""
    global _thread
    if _thread and _thread.is_alive():
        return
    _thread = threading.Thread(target=_loop, daemon=True, name="showcase-auto")
    _thread.start()
    logger.info("[showcase-auto] 自动建卡巡检已启动（受 SHOWCASE_AUTO_ENABLED 控制，默认开）")
