"""
学生自我画像 API 路由
每日生成一张 AI 画像 + 创意寄语，支持画廊、分享与点赞
"""
import os
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.api.config_router import get_config_value
from backend.auth import is_admin
from backend.prompts import apply_skills
from backend.api.ai_service import call_ai_sync_with_timeout
from backend.api.image_gen_service import generate_and_save_image
from backend.companion_memory import get_student_profile
from backend.database import execute_query, execute_insert_update
from backend.question_db import execute_query as q_execute_query
from backend.config import BASE_DIR
from backend.utils import get_user_base_dir
from backend.logger import logger
from backend.prompts.portrait import (
    PORTRAIT_STYLES,
    build_portrait_image_prompt,
    build_portrait_comment_prompt,
)

router = APIRouter()


# ── 数据模型 ──

class GenerateRequest(BaseModel):
    style: str = "random"
    use_points: bool = False  # 是否消耗 100 积分兑换额外生成机会


class ThemeRequest(BaseModel):
    theme: str = "auto"  # 'auto' 或主题 key


class ShareRequest(BaseModel):
    scope: str = "public"  # public | class | private


# ── 辅助函数 ──

def _get_portrait_dir(username: str) -> Path:
    """获取学生画像存储目录"""
    base = Path(get_user_base_dir(username))
    portrait_dir = base / "portraits"
    portrait_dir.mkdir(parents=True, exist_ok=True)
    return portrait_dir


def _user_grade_class(username: str) -> tuple[str, str]:
    rows = execute_query("SELECT grade, class FROM users WHERE username=?", (username,))
    if not rows:
        return "", ""
    return str(rows[0][0] or "").strip(), str(rows[0][1] or "").strip()


def _norm_cls(v: str) -> str:
    """班级归一化: '1' / '1班' / '01' -> '1'; '1,2,3' -> '123'(教师串, 仅用于非学生角色兜底)"""
    import re as _re
    digits = _re.sub(r"\D", "", str(v or ""))
    return digits.lstrip("0") or digits


def _can_view_portrait(owner: str, is_shared: int, share_scope: str, viewer: str, role: int) -> bool:
    """R5: share_scope='class' 必须同年级且同班。

    旧实现写的是 `viewer_info[0] != owner_info[0]`(比较年级), 导致"仅同班可见"
    实际变成"整个年级 + 任意教师可见"。
    """
    if owner == viewer or role == 0:
        return True
    if not is_shared or (share_scope or "private") in ("", "private"):
        return False
    scope = share_scope or "public"
    if scope == "public":
        return True
    if scope == "class":
        if role == 1:
            try:
                from backend.permission_service import is_student_in_teacher_scope
                return bool(is_student_in_teacher_scope(owner, viewer))
            except Exception:
                return False
        og, oc = _user_grade_class(owner)
        vg, vc = _user_grade_class(viewer)
        return bool(og) and og == vg and bool(_norm_cls(vc)) and _norm_cls(oc) == _norm_cls(vc)
    return False


def _refund_points(username: str, points: int, reason: str) -> None:
    """R2: 兑换型操作失败时冲正积分(写一条 refund 流水, 保持账目可追溯)

    改为调用 reward_engine.refund_points：这里原来是全仓唯一"绕过引擎直接 INSERT
    activity_rewards"的地方，守卫、幂等索引、批量重算都管不到它。
    """
    if points <= 0:
        return
    try:
        from backend.reward_engine import refund_points
        refund_points(username, points, f"{reason}(+{points})",
                      activity_id=datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    except Exception as e:
        logger.error(f"画像积分退还失败({username}, {points}): {e}")


def _to_portrait_url(image_path: str, portrait_id: int = 0) -> str:
    """将本地路径转为可访问的 URL
    优先使用 portrait_id 指向专用图片端点（绕过 files_router 权限限制）
    """
    if portrait_id:
        return f"/api/portrait/image/{portrait_id}"
    if not image_path:
        return ""
    # fallback: 通过 files_router 访问（仅对自己可见）
    rel = os.path.relpath(image_path, str(BASE_DIR)).replace("\\", "/")
    return f"/api/files/{rel}"


def _format_portrait_row(row: tuple, include_path: bool = True) -> dict[str, Any]:
    """将数据库行转为响应字典

    K6: include_path=False 时不返回服务器绝对路径(用于"看别人画像"的列表场景),
    图片一律通过 image_url(/api/portrait/image/{id}) 走权限校验访问。
    """
    result = {
        "id": row[0],
        "username": row[1],
        "created_date": row[2],
        "style": row[3],
        "image_url": _to_portrait_url("", portrait_id=row[0]),
        "ai_comment": row[5] or "",
        "prompt": row[6] or "",
        "generated_at": row[7] or "",
        "view_count": row[8] or 0,
        "is_shared": row[9] or 0,
        "share_scope": row[10] or "private",
        "like_count": row[11] or 0,
        "status": row[12] if len(row) > 12 else "active",
        # P-3/P-6: 这张画像覆盖哪个周期（旧数据留空 → 前端按"历史"展示）
        "period_type": (row[13] if len(row) > 13 else "") or "",
        "period_start": (row[14] if len(row) > 14 else "") or "",
        "period_end": (row[15] if len(row) > 15 else "") or "",
    }
    if include_path:
        result["image_path"] = row[4] or ""
    return result


# 本人视角的画像查询统一列顺序（_format_portrait_row 按位置解析，0..15）
_P_COLS = ("id, username, created_date, style, image_path, ai_comment, prompt, generated_at, "
           "view_count, is_shared, share_scope, like_count, status, "
           "period_type, period_start, period_end")


def _enrich_with_student_info(portrait: dict[str, Any]) -> dict[str, Any]:
    """补充学生姓名信息和主题偏好"""
    rows = execute_query(
        "SELECT name, grade, class, portrait_theme FROM users WHERE username=?",
        (portrait["username"],),
    )
    if rows:
        portrait["student_name"] = rows[0][0] or portrait["username"]
        portrait["grade"] = rows[0][1] or ""
        portrait["class_name"] = rows[0][2] or ""
        portrait["portrait_theme"] = rows[0][3] or "auto"
    else:
        portrait["student_name"] = portrait["username"]
        portrait["grade"] = ""
        portrait["class_name"] = ""
        portrait["portrait_theme"] = "auto"
    return portrait


def _check_liked(portrait_id: int, username: str) -> bool:
    """检查用户是否已点赞"""
    rows = execute_query(
        "SELECT id FROM portrait_likes WHERE portrait_id=? AND username=?",
        (portrait_id, username),
    )
    return bool(rows)


def _safe_count(
    sql: str,
    params: tuple[Any, ...] = (),
    *,
    use_question_db: bool = False,
) -> int:
    """执行一个 COUNT 统计并返回整数。

    画像里的角色统计属于"锦上添花"，单个口径查失败不该让整段统计消失，
    所以这里吞掉异常只记 warning。
    use_question_db=True 时查试题库（exams / exam_attempts / question_bank 等在 questions.db，
    主库里的同名表是历史遗留空表，直接查会永远得到 0）。
    """
    try:
        if use_question_db:
            rows = q_execute_query(sql, params)
            if not rows:
                return 0
            value = next(iter(rows[0].values()))
        else:
            rows = execute_query(sql, params)
            if not rows or not rows[0]:
                return 0
            value = rows[0][0]
        return int(value or 0)
    except Exception as e:
        logger.warning(f"画像统计查询失败: {e} | {' '.join(sql.split())[:140]}")
        return 0


def _enrich_role_data(profile: dict[str, Any], since: str = "", until: str = "",
                      period_label: str = "本周") -> None:
    """按角色补充数据。

    P-6：`since/until` 是**当前周期**（周或月，见 _get_period_range）。累计量进 student_stats/teach_stats，
    周期量进 period_stats —— 画像内容因此真正反映"这个周期"，与名字里的周期/配置一致。
    """
    role = profile.get("role", 2)
    username = profile.get("username", "")
    since = since or _get_period_range()[0]
    until = until or _get_period_range()[1]

    try:
        if role == 2:  # 学生累计数据
            week_start, week_end = since, until

            # 累计考试数（考试数据在试题库 questions.db，主库同名表是历史遗留空壳）
            total_exams = _safe_count(
                "SELECT COUNT(*) FROM exam_attempts WHERE student_username=? AND status IN ('submitted','graded')",
                (username,),
                use_question_db=True,
            )

            # 本周新增积分
            pt_rows = execute_query(
                "SELECT COALESCE(SUM(points),0) FROM activity_rewards WHERE student_username=? AND created_at BETWEEN ? AND ?",
                (username, week_start, week_end),
            )
            week_points = pt_rows[0][0] if pt_rows else 0

            # 累计总积分
            total_pts = execute_query(
                "SELECT COALESCE(SUM(points),0) FROM activity_rewards WHERE student_username=?",
                (username,),
            )
            total_points_all = total_pts[0][0] if total_pts else 0

            # 全部活动类型的累计次数（15种）
            act_rows = execute_query(
                """SELECT activity_type, COUNT(*) as cnt
                   FROM activity_rewards
                   WHERE student_username=?
                   GROUP BY activity_type
                   ORDER BY cnt DESC""",
                (username,),
            )
            activity_detail = {}
            total_activities = 0
            for r in act_rows:
                activity_detail[str(r[0])] = r[1]
                total_activities += r[1]

            # 错题总数
            wb_rows = execute_query(
                "SELECT COUNT(*) FROM wrong_book WHERE student_username=? AND status IN ('active','reviewing')",
                (username,),
            )
            wrong_count = wb_rows[0][0] if wb_rows else 0

            # AI 对话次数
            chat_count = execute_query(
                "SELECT COUNT(*) FROM conversations WHERE username=?",
                (username,),
            )
            total_chats = chat_count[0][0] if chat_count else 0

            # 讨论参与次数
            disc_count = execute_query(
                "SELECT COUNT(*) FROM discussion_messages WHERE username=?",
                (username,),
            )
            total_discussions = disc_count[0][0] if disc_count else 0

            # 资源浏览统计
            rv_total = execute_query(
                "SELECT COUNT(*) FROM resource_view_logs WHERE student_username=?",
                (username,),
            )
            total_resource_views = rv_total[0][0] if rv_total else 0
            rv_week = execute_query(
                "SELECT COUNT(*) FROM resource_view_logs WHERE student_username=? AND viewed_at BETWEEN ? AND ?",
                (username, week_start, week_end),
            )
            week_resource_views = rv_week[0][0] if rv_week else 0

            # 每日精选浏览
            disc_rows = execute_query(
                "SELECT COUNT(*) FROM discovery_view_log WHERE username=?",
                (username,),
            )
            total_discovery = disc_rows[0][0] if disc_rows else 0

            # 热点新闻阅读
            news_rows = execute_query(
                "SELECT COUNT(*) FROM news_view_log WHERE username=?",
                (username,),
            )
            total_news = news_rows[0][0] if news_rows else 0

            profile["student_stats"] = {
                "total_exams": total_exams,
                "week_points": week_points,
                "total_points": total_points_all,
                "total_activities": total_activities,
                "activity_detail": activity_detail,
                "wrong_count": wrong_count,
                "total_chats": total_chats,
                "total_discussions": total_discussions,
                "total_resource_views": total_resource_views,
                "week_resource_views": week_resource_views,
                "total_discovery": total_discovery,
                "total_news": total_news,
            }

            # ── P-6：本期（周 / 月，随系统配置）表现 —— 画像内容主体 ──
            def _cnt(sql: str, params: tuple, use_question_db: bool = False) -> int:
                try:
                    rows_ = q_execute_query(sql, params) if use_question_db else execute_query(sql, params)
                    return int(rows_[0][0]) if rows_ and rows_[0][0] is not None else 0
                except Exception as e:
                    logger.warning(f"[portrait] 本期统计失败({username}): {e}")
                    return 0

            period_act_rows = execute_query(
                """SELECT activity_type, COUNT(*) FROM activity_rewards
                   WHERE student_username=? AND created_at BETWEEN ? AND ?
                   GROUP BY activity_type ORDER BY 2 DESC""",
                (username, since, until),
            ) or []
            period_detail = {str(r[0]): r[1] for r in period_act_rows}
            profile["period_stats"] = {
                "label": period_label,
                "start": since,
                "end": until,
                "points": week_points,            # 本期新增积分
                "activities": sum(period_detail.values()),
                "activity_detail": period_detail,
                "exams": _cnt(
                    """SELECT COUNT(*) FROM exam_attempts
                       WHERE student_username=? AND status IN ('submitted','graded')
                         AND submitted_at BETWEEN ? AND ?""",
                    (username, since, until), use_question_db=True),
                "wrong": _cnt(
                    "SELECT COUNT(*) FROM wrong_book WHERE student_username=? AND created_at BETWEEN ? AND ?",
                    (username, since, until)),
                "chats": _cnt(
                    "SELECT COUNT(*) FROM conversations WHERE username=? AND date BETWEEN ? AND ?",
                    (username, since, until)),
                "discussions": _cnt(
                    "SELECT COUNT(*) FROM discussion_messages WHERE username=? AND created_at BETWEEN ? AND ?",
                    (username, since, until)),
                "resource_views": week_resource_views,
                "discovery": _cnt(
                    "SELECT COUNT(*) FROM discovery_view_log WHERE username=? AND created_at BETWEEN ? AND ?",
                    (username, since, until)),
                "news": _cnt(
                    "SELECT COUNT(*) FROM news_view_log WHERE username=? AND created_at BETWEEN ? AND ?",
                    (username, since, until)),
            }
            profile["period_label"] = period_label

        elif role == 1:  # 教师累计数据
            week_start, week_end = since, until

            # 任教班级数：以任教关系表为准（users.grade/class 只是注册时留下的文本快照）
            class_total = _safe_count(
                """SELECT COUNT(DISTINCT grade_id || '-' || COALESCE(class_id, 'ALL'))
                   FROM teacher_assignments WHERE teacher_username=?""",
                (username,),
            )
            if not class_total:
                # 兜底：早期教师没有任教记录时，退回按用户年级班级字符串统计
                class_total = _safe_count(
                    "SELECT COUNT(DISTINCT grade||class) FROM users WHERE username=?",
                    (username,),
                )

            # 累计创建的活动数量
            quiz_count = _safe_count(
                "SELECT COUNT(*) FROM interaction_quizzes WHERE creator_username=?",
                (username,),
            )
            # 考试数据存放在试题库 questions.db
            exam_count = _safe_count(
                "SELECT COUNT(*) FROM exams WHERE creator_username=?",
                (username,),
                use_question_db=True,
            )
            # 本周新创建活动
            week_quiz = _safe_count(
                "SELECT COUNT(*) FROM interaction_quizzes WHERE creator_username=? AND created_at >= ?",
                (username, week_start),
            )
            week_exam = _safe_count(
                "SELECT COUNT(*) FROM exams WHERE creator_username=? AND created_at >= ?",
                (username, week_start),
                use_question_db=True,
            )
            # 批阅任务数：task_grades 只有 task_id + 学生，教师归属要顺着 tasks.creator_username 找
            graded_count = _safe_count(
                """SELECT COUNT(*) FROM task_grades tg
                   JOIN tasks t ON t.id = tg.task_id
                   WHERE t.creator_username=?""",
                (username,),
            )

            profile["teach_stats"] = (
                f"任教{class_total}个班级，"
                f"累计创建{quiz_count}个测验、"
                f"{exam_count}场考试"
            )
            if graded_count > 0:
                profile["teach_stats"] += f"，批阅{graded_count}份任务"
            week_extra = []
            if week_quiz > 0:
                week_extra.append(f"本周新增{week_quiz}个测验")
            if week_exam > 0:
                week_extra.append(f"本周新增{week_exam}场考试")
            if week_extra:
                profile["teach_stats"] += "，" + "、".join(week_extra)

        elif role == 0:  # 管理员累计数据
            total_users = execute_query("SELECT COUNT(*) FROM users", ())
            week_start, week_end = since, until
            active_users = execute_query(
                "SELECT COUNT(DISTINCT username) FROM login_logs WHERE login_time >= date('now', '-7 days')",
                (),
            )
            total_portraits = execute_query(
                "SELECT COUNT(*) FROM student_portraits WHERE status='active'",
                (),
            )
            total_exams = _safe_count("SELECT COUNT(*) FROM exams", (), use_question_db=True)

            profile["admin_stats"] = (
                f"平台共{total_users[0][0] if total_users else 0}名用户，"
                f"近7日{active_users[0][0] if active_users else 0}人活跃，"
                f"累计{total_exams}场考试、"
                f"{total_portraits[0][0] if total_portraits else 0}幅画像"
            )
    except Exception as e:
        logger.warning(f"补充角色数据失败: {e}")


# ── 周期与配置（P-2：周期可配）──

def _cfg(key: str, default: Any = None) -> Any:
    """读系统配置。配置读取异常一律回落默认值 —— 画像不该因配置层异常整体不可用。"""
    try:
        return get_config_value(key, default)
    except Exception:
        return default


def _portrait_enabled() -> bool:
    """画像总闸（系统配置 PORTRAIT_ENABLED）"""
    return bool(_cfg("PORTRAIT_ENABLED", True))


def _period_type() -> str:
    """画像周期：weekly（默认）/ monthly（系统配置 PORTRAIT_PERIOD_MONTHLY）"""
    return "monthly" if _cfg("PORTRAIT_PERIOD_MONTHLY", False) else "weekly"


def _get_period_range(period: str | None = None, today: datetime | None = None) -> tuple[str, str]:
    """当前周期起止：周 = 周一 ~ 周日（全站唯一口径，见 backend.utils.week_range_str）；
    月 = 当月 1 号 ~ 月末。（today 仅供测试注入）"""
    if (period or _period_type()) == "monthly":
        today = today or datetime.now()
        first = today.replace(day=1)
        nxt = (first + timedelta(days=32)).replace(day=1)
        return first.strftime("%Y-%m-%d"), (nxt - timedelta(days=1)).strftime("%Y-%m-%d")
    from backend.utils import week_range_str
    return week_range_str(now=today)


def _period_label(period: str | None = None) -> str:
    """周期的中文说法（寄语/提示文案用）"""
    return "本月" if (period or _period_type()) == "monthly" else "本周"


def _get_week_range() -> tuple[str, str]:
    """兼容旧调用点：等价于「当前周期」（周期可配后不再专指一周）"""
    return _get_period_range()


def _get_api_key() -> str:
    """获取可用的 API Key（使用统一缓存入口）"""
    from backend.api.chat_router import get_api_keys
    key, _ = get_api_keys("")
    if not key:
        raise HTTPException(status_code=400, detail="API Key 未配置，请在系统设置中配置")
    return key


# ═══════════════════════════════════════════════
# API 端点
# ═══════════════════════════════════════════════


@router.get("/image/{portrait_id}")
async def serve_portrait_image(portrait_id: int, request: Request):
    """提供画像图片文件（绕过 files_router 权限限制，使用画像自身的分享逻辑）"""
    from fastapi.responses import FileResponse

    rows = execute_query(
        "SELECT id, username, image_path, is_shared, share_scope, status FROM student_portraits WHERE id=?",
        (portrait_id,),
    )
    if not rows or (rows[0][5] or "active") != "active":
        raise HTTPException(status_code=404, detail="画像不存在")

    rec = rows[0]
    image_path = rec[2] or ""
    if not image_path or not os.path.exists(image_path):
        raise HTTPException(status_code=404, detail="图片文件不存在")

    user = get_current_user(request)
    if not _can_view_portrait(rec[1], rec[3] or 0, rec[4] or "private", user["username"], user.get("role", 2)):
        raise HTTPException(status_code=403, detail="无权查看该画像")

    return FileResponse(image_path)


@router.get("/today")
async def get_today_portrait(request: Request):
    """获取「本期画像」（如果已生成）。

    P-3: 旧实现按周取 `rows[0]` 且**没有 ORDER BY**（同一周期用积分多生成过时可能返回更旧的那张），
    SELECT 里也**没有 status**，导致前端「画像已删除」分支永远不触发。两者一并修掉。
    """
    user = get_current_user(request)
    username = user["username"]
    period = _period_type()
    period_start, period_end = _get_period_range(period)

    rows = execute_query(
        f"""SELECT {_P_COLS}
            FROM student_portraits
            WHERE username=? AND created_date BETWEEN ? AND ?
            ORDER BY created_date DESC, id DESC LIMIT 1""",
        (username, period_start, period_end),
    )
    if not rows:
        return {"exists": False, "period": {"type": period, "start": period_start, "end": period_end,
                                            "label": _period_label(period)}}

    portrait = _format_portrait_row(rows[0])
    portrait = _enrich_with_student_info(portrait)
    period_info = {"type": period, "start": period_start, "end": period_end,
                   "label": _period_label(period)}

    # 如果已软删除，标记不可用但仍告知已生成
    if portrait.get("status") == "deleted":
        return {"exists": True, "portrait": {**portrait, "deleted": True}, "period": period_info}

    # 增加浏览次数
    execute_insert_update(
        "UPDATE student_portraits SET view_count = view_count + 1 WHERE id=?",
        (portrait["id"],),
    )
    portrait["liked"] = _check_liked(portrait["id"], username)
    return {"exists": True, "portrait": portrait, "period": period_info}


@router.get("/styles")
async def get_portrait_styles():
    """获取所有可用风格"""
    styles = []
    for key, info in PORTRAIT_STYLES.items():
        styles.append({
            "key": key,
            "name": info["name"],
            "desc": info["desc_cn"],
        })
    return {"styles": styles}


@router.get("/theme")
async def get_theme(request: Request):
    """获取当前用户的主题偏好"""
    user = get_current_user(request)
    username = user["username"]
    rows = execute_query(
        "SELECT portrait_theme FROM users WHERE username=?",
        (username,),
    )
    theme = rows[0][0] if rows else "auto"
    return {"theme": theme}


@router.put("/theme")
async def set_theme(request: Request, body: ThemeRequest):
    """保存当前用户的主题偏好"""
    user = get_current_user(request)
    username = user["username"]
    execute_insert_update(
        "UPDATE users SET portrait_theme=? WHERE username=?",
        (body.theme, username),
    )
    return {"theme": body.theme}


def _count_period_portraits(username: str, period_start: str, period_end: str) -> int:
    """本周期已生成几张（软删除的不占额度：与旧行为一致，删掉可以再来一张）"""
    rows = execute_query(
        """SELECT COUNT(*) FROM student_portraits
           WHERE username=? AND created_date BETWEEN ? AND ?
             AND COALESCE(status,'active')='active'""",
        (username, period_start, period_end),
    )
    return int(rows[0][0]) if rows else 0


def _log_generation(username: str, period_start: str, *, ok: bool, comment_ok: bool,
                    image_ok: bool, seconds: float, charged: int, error: str = "") -> None:
    """P-5：生成健康度落一条 —— 失败也要落，否则"成功率"无从统计"""
    try:
        execute_insert_update(
            """INSERT INTO portrait_gen_log
               (username, created_at, period_start, ok, comment_ok, image_ok, seconds,
                charged_points, error)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (username, datetime.now().strftime("%Y-%m-%d %H:%M:%S"), period_start,
             1 if ok else 0, 1 if comment_ok else 0, 1 if image_ok else 0,
             round(float(seconds or 0), 1), int(charged or 0), str(error or "")[:300]),
        )
    except Exception as e:
        logger.warning(f"[portrait] 健康度落库失败({username}): {e}")


def _fetch_portrait_of(username: str, created_date: str) -> dict[str, Any]:
    """取某天那条画像（同日再生成 = 覆盖当天记录）"""
    rows = execute_query(
        f"SELECT {_P_COLS} FROM student_portraits WHERE username=? AND created_date=? LIMIT 1",
        (username, created_date),
    )
    return _format_portrait_row(rows[0]) if rows else {}


async def _run_generation(*, username: str, role: int, style: str, period: str,
                          period_start: str, period_end: str, api_key: str,
                          charged: int) -> dict[str, Any]:
    """后台任务体：本期数据 → 寄语 → 配图 → 落库（失败退款 + 健康度）。

    P-5：原来这一切都压在一个 HTTP 请求里（大模型 timeout=150 + 生图），前端挂 300 秒，
    反代常常先超时 —— 学生会看到"失败"，而后端其实已经把图存下来了。
    """
    t0 = time.time()
    comment_ok = False
    img_ok = False
    img_err = ""
    label = _period_label(period)
    today_str = datetime.now().strftime("%Y-%m-%d")

    try:
        # 1. 聚合数据（P-6：本期窗口交给 _enrich_role_data，画像吃的就是这个周期）
        profile = get_student_profile(username)
        profile["username"] = username
        profile["role"] = role
        profile["role_name"] = {0: "管理员", 1: "教师", 2: "学生"}.get(role, "用户")
        _enrich_role_data(profile, since=period_start, until=period_end, period_label=label)

        # 2. 生图 Prompt（直接给通义万相，无需 LLM 二次处理）
        img_prompt = build_portrait_image_prompt(profile, style)

        # 3. 创意寄语（失败有兜底文案，不影响出图）
        try:
            comment_prompt = apply_skills(build_portrait_comment_prompt(profile, style), "portrait")
            comment = await call_ai_sync_with_timeout(comment_prompt, api_key, timeout=150, use_kb=False)
            comment = comment.strip().strip('"\'')
            comment_ok = True
        except Exception as e:
            logger.error(f"生成寄语失败({username}): {e}")
            comment = {
                "教师": "三尺讲台育桃李，一支粉笔写春秋。今日的你依然在发光发热 🌟",
                "管理员": "运筹帷幄之中，决胜千里之外。平台因你而精彩 🚀",
            }.get(profile.get("role_name", ""), "今日份的努力，是明日惊喜的铺垫！继续加油哦 🌟")

        # 4. 通义万相生图
        save_dir = _get_portrait_dir(username)
        try:
            image_path = await generate_and_save_image(
                prompt=img_prompt, save_dir=str(save_dir), filename=f"{today_str}_{style}",
            )
            img_ok = bool(image_path)
            if not img_ok:
                img_err = "配图服务未返回图片"
                image_path = ""
        except Exception as e:
            logger.error(f"生图异常({username}): {e}")
            img_err = str(e)[:120]
            image_path = ""

        # 5. 落库（同日覆盖当天记录；同时写入周期字段，历史列表按周期展示）
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        old_row = execute_query(
            "SELECT id, image_path FROM student_portraits WHERE username=? AND created_date=?",
            (username, today_str),
        )
        if old_row:
            keep_path = old_row[0][1] if (image_path == "" and old_row[0][1]) else image_path
            execute_insert_update(
                """UPDATE student_portraits
                   SET style=?, image_path=?, ai_comment=?, prompt=?, generated_at=?,
                       status='active', period_type=?, period_start=?, period_end=?
                   WHERE id=?""",
                (style, keep_path, comment, img_prompt, now_str,
                 period, period_start, period_end, old_row[0][0]),
            )
            image_path = keep_path
        else:
            execute_insert_update(
                """INSERT INTO student_portraits
                   (username, created_date, style, image_path, ai_comment, prompt, generated_at,
                    period_type, period_start, period_end)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (username, today_str, style, image_path, comment, img_prompt, now_str,
                 period, period_start, period_end),
            )

        # 6. 退款口径与旧实现一致：本次没出图 → 退还本次积分
        if charged and not img_ok:
            _refund_points(username, charged, "本次配图未产出")
            message = f"本次未生成新配图，{charged} 积分已退还 🙏（{img_err}）"
            charged = 0
        elif not image_path:
            if charged:
                _refund_points(username, charged, "配图未产出")
                message = f"配图未生成，本次积分已退还 🙏（{img_err or '请稍后再试'}）"
                charged = 0
            else:
                message = "寄语已生成，但配图未成功，可点「重试配图」再试一次 ✨"
        elif not comment_ok:
            message = "画像已生成（寄语使用了默认文案）🎨"
        else:
            message = f"{label}画像生成成功 🎉"

        portrait = _fetch_portrait_of(username, today_str)
        portrait["liked"] = False
        _log_generation(username, period_start, ok=bool(image_path), comment_ok=comment_ok,
                        image_ok=img_ok, seconds=time.time() - t0, charged=charged, error=img_err)
        return {"portrait": portrait, "message": message, "charged_points": charged}
    except Exception as e:
        if charged:
            _refund_points(username, charged, "画像生成失败")
        _log_generation(username, period_start, ok=False, comment_ok=comment_ok, image_ok=False,
                        seconds=time.time() - t0, charged=charged, error=str(e)[:200])
        logger.error(f"画像生成失败({username}): {e}")
        raise


@router.post("/generate")
async def generate_portrait(request: Request, body: GenerateRequest):
    """生成「本期画像」：每周期 1 次免费，额外次数按系统配置兑换。

    P-5：改为后台任务 —— 配额与积分在请求内判定并扣除，立即返回 task_id；
    出图与落库在任务体里做，失败自动冲正积分，并向 portrait_gen_log 落健康度。
    """
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if not _portrait_enabled():
        raise HTTPException(status_code=403, detail="AI 画像功能已在系统配置中关闭")

    # 先确认 AI 可用，避免"扣了分却什么都生成不出来"
    api_key = _get_api_key()
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 AI 服务 Key，暂时无法生成画像，请联系管理员")

    period = _period_type()
    period_start, period_end = _get_period_range(period)
    label = _period_label(period)
    used = _count_period_portraits(username, period_start, period_end)

    extra_points = int(_cfg("PORTRAIT_EXTRA_POINTS", 100) or 0)
    extra_max = int(_cfg("PORTRAIT_EXTRA_MAX", 2) or 0)
    staff_max = int(_cfg("PORTRAIT_STAFF_MAX", 2) or 0)

    charged = 0
    if used > 0:
        if not body.use_points:
            raise HTTPException(status_code=400,
                                detail=f"{label}画像已生成，消耗 {extra_points} 积分可再生成一次 ✨")

        # 角色分支：教师/管理员不在积分体系内（恒 0 分），但仍要显式点"兑换"，
        # 并有每周期上限 —— 旧实现对他们完全不设限，等于开放了一个免费生图接口。
        from backend.permission_service import is_student_account
        if is_student_account(username):
            if used - 1 >= extra_max:
                raise HTTPException(status_code=400,
                                    detail=f"{label}额外生成次数已达上限（{extra_max} 次）")
            from backend.reward_engine import deduct_points, get_student_total
            total = get_student_total(username)
            if total < extra_points:
                raise HTTPException(status_code=400, detail=f"积分不足，当前仅有 {total} 积分，需要 {extra_points} 积分才能兑换额外生成机会 📉")
            charged = deduct_points(username, f"消耗{extra_points}积分兑换画像生成", extra_points)
            if charged <= 0:
                raise HTTPException(status_code=400, detail="积分扣除未成功（可用积分不足），请刷新后重试")
            logger.info(f"学生 {username} 消耗 {charged} 积分兑换了{label}额外画像生成")
        else:
            if used >= staff_max:
                raise HTTPException(status_code=400,
                                    detail=f"{label}生成次数已达上限（{staff_max} 次），请下个周期再来")
            logger.info(f"非学生账号 {username} 免积分兑换{label}额外画像生成（教师/管理员不参与积分体系）")

    # 确定风格
    style = body.style or "random"
    if style not in PORTRAIT_STYLES:
        style = "random"

    from backend.ai_task_manager import task_manager
    try:
        task_id = await task_manager.create_task(
            description=f"AI 画像生成（{username} · {label}）",
            coro_factory=lambda: _run_generation(
                username=username, role=role, style=style, period=period,
                period_start=period_start, period_end=period_end,
                api_key=api_key, charged=charged),
            owner_username=username,
            # 同周期同用户：进行中的重复点击复用（防误触重复计费），
            # 已完成的**不复用** —— 否则加购的第二次会拿到上一次的回执，学生白花积分。
            dedupe_key=f"portrait:{username}:{period_start}",
            reuse_completed=False,
            max_concurrent=4,
        )
    except Exception as e:
        if charged:
            _refund_points(username, charged, "画像任务创建失败")
        logger.error(f"画像任务创建失败({username}): {e}")
        raise HTTPException(status_code=502, detail="画像任务创建失败，积分已退还，请稍后再试")

    return {
        "task_id": task_id,
        "charged_points": charged,
        "period": {"type": period, "start": period_start, "end": period_end, "label": label},
        "used": used,
        "message": f"{label}画像生成已开始，请稍候…",
    }


@router.post("/{portrait_id}/retry-image")
async def retry_portrait_image(portrait_id: int, request: Request):
    """P-5：只重试配图 —— 不占周期额度、不扣积分。

    生图失败但寄语成功时，学生不该为了补一张图再花积分重来一次。
    （单张图调用，耗时可控，这里保持同步；生成整张画像仍走后台任务。）
    """
    user = get_current_user(request)
    username = user["username"]
    rows = execute_query(
        "SELECT id, username, image_path, prompt, status FROM student_portraits WHERE id=?",
        (portrait_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="画像不存在")
    row = rows[0]
    if row[1] != username and user.get("role", 2) != 0:
        raise HTTPException(status_code=403, detail="只能补自己的画像配图")
    if (row[4] or "active") != "active":
        raise HTTPException(status_code=400, detail="该画像已删除")
    if row[2] and os.path.exists(row[2]):
        return {"message": "这张画像已有配图，无需重试", "image_ok": True}
    prompt = row[3] or ""
    if not prompt:
        raise HTTPException(status_code=400, detail="这张画像没有可用的生图描述，请重新生成")
    if not _get_api_key():
        raise HTTPException(status_code=400, detail="未配置 AI 服务 Key，暂时无法补图")

    t0 = time.time()
    try:
        image_path = await generate_and_save_image(
            prompt=prompt, save_dir=str(_get_portrait_dir(username)),
            filename=f"retry_{portrait_id}",
        )
    except Exception as e:
        _log_generation(username, "", ok=False, comment_ok=True, image_ok=False,
                        seconds=time.time() - t0, charged=0, error=str(e)[:200])
        raise HTTPException(status_code=502, detail=f"补图失败：{str(e)[:80]}")
    if not image_path:
        _log_generation(username, "", ok=False, comment_ok=True, image_ok=False,
                        seconds=time.time() - t0, charged=0, error="配图服务未返回图片")
        raise HTTPException(status_code=502, detail="配图服务未返回图片，请稍后再试")

    execute_insert_update(
        "UPDATE student_portraits SET image_path=? WHERE id=?", (image_path, portrait_id))
    _log_generation(username, "", ok=True, comment_ok=True, image_ok=True,
                    seconds=time.time() - t0, charged=0)
    return {"message": "配图已补上 🎉", "image_ok": True}


@router.get("/health")
async def portrait_health(request: Request, days: int = Query(7, ge=1, le=90)):
    """P-5：画像生成健康度（管理员）—— 近 N 天成功率 / 平均耗时 / 常见失败原因"""
    user = get_current_user(request)
    if user.get("role", 2) != 0:
        raise HTTPException(status_code=403, detail="仅管理员可查看")
    since = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
    rows = execute_query(
        """SELECT COUNT(*), COALESCE(SUM(ok),0), COALESCE(SUM(image_ok),0), COALESCE(AVG(seconds),0)
           FROM portrait_gen_log WHERE created_at >= ?""",
        (since,),
    ) or []
    total, ok_n, img_n, avg_s = (rows[0][0], rows[0][1], rows[0][2], rows[0][3]) if rows else (0, 0, 0, 0)
    errs = execute_query(
        """SELECT error, COUNT(*) FROM portrait_gen_log
           WHERE created_at >= ? AND error <> ''
           GROUP BY error ORDER BY 2 DESC LIMIT 5""",
        (since,),
    ) or []
    return {
        "days": days,
        "total": total,
        "success": ok_n,
        "success_rate": round(ok_n / total * 100, 1) if total else None,
        "image_ok": img_n,
        "avg_seconds": round(float(avg_s or 0), 1),
        "top_errors": [{"error": r[0], "count": r[1]} for r in errs],
    }


@router.get("/list")
async def list_portraits(request: Request, include_deleted: bool = Query(False)):
    """获取用户的所有画像(默认只列有效记录; include_deleted 可回看已删除的寄语)"""
    user = get_current_user(request)
    username = user["username"]

    status_sql = "" if include_deleted else "AND status='active'"
    rows = execute_query(
        f"""SELECT {_P_COLS}
            FROM student_portraits
            WHERE username=? {status_sql}
            ORDER BY created_date DESC, id DESC""",
        (username,),
    )

    portraits = []
    for row in rows:
        p = _format_portrait_row(row)
        p = _enrich_with_student_info(p)
        p["liked"] = _check_liked(p["id"], username)
        portraits.append(p)

    return {"portraits": portraits}


@router.get("/{portrait_id}")
async def get_portrait_detail(portrait_id: int, request: Request):
    """获取单张画像详情"""
    user = get_current_user(request)
    username = user["username"]

    rows = execute_query(
        f"""SELECT {_P_COLS} FROM student_portraits WHERE id=?""",
        (portrait_id,),
    )
    if not rows or (rows[0][12] or "active") != "active":
        raise HTTPException(status_code=404, detail="画像不存在")

    # K6: 看别人的画像时不返回服务器绝对路径(自己的与管理员保留, 生成流程依赖该字段)
    _owner = rows[0][1]
    portrait = _format_portrait_row(rows[0], include_path=(_owner == username or user.get("role", 2) == 0))

    # R5: 统一可见性判断(同班必须真的同班)
    if not _can_view_portrait(portrait["username"], portrait.get("is_shared") or 0,
                              portrait.get("share_scope") or "private", username,
                              user.get("role", 2)):
        raise HTTPException(status_code=403, detail="无权查看该画像")

    # 增加浏览次数
    execute_insert_update(
        "UPDATE student_portraits SET view_count = view_count + 1 WHERE id=?",
        (portrait_id,),
    )

    portrait = _enrich_with_student_info(portrait)
    portrait["liked"] = _check_liked(portrait_id, username)
    return portrait


@router.post("/{portrait_id}/share")
async def share_portrait(portrait_id: int, request: Request, body: ShareRequest):
    """分享画像到平台"""
    user = get_current_user(request)
    username = user["username"]

    rows = execute_query(
        "SELECT id, username FROM student_portraits WHERE id=?",
        (portrait_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="画像不存在")
    if rows[0][1] != username and not is_admin(username):
        raise HTTPException(status_code=403, detail="只能分享自己的画像")

    scope = body.scope if body.scope in ("public", "class", "private") else "public"
    is_shared = 1 if scope != "private" else 0

    execute_insert_update(
        "UPDATE student_portraits SET is_shared=?, share_scope=? WHERE id=?",
        (is_shared, scope, portrait_id),
    )

    scope_names = {"public": "分享中心", "class": "本班", "private": "不公开"}
    return {"message": f"已分享到{scope_names.get(scope, '分享中心')} 🎉"}


@router.post("/{portrait_id}/unshare")
async def unshare_portrait(portrait_id: int, request: Request):
    """取消分享"""
    user = get_current_user(request)
    username = user["username"]

    owner_check = execute_query(
        "SELECT id, username FROM student_portraits WHERE id=?",
        (portrait_id,),
    )
    if not owner_check:
        raise HTTPException(status_code=404, detail="画像不存在")
    if owner_check[0][1] != username and not is_admin(username):
        raise HTTPException(status_code=403, detail="只能操作自己的画像")

    execute_insert_update(
        "UPDATE student_portraits SET is_shared=0, share_scope='private', like_count=0 WHERE id=?",
        (portrait_id,),
    )
    # 取消分享时清除互动数据
    execute_insert_update(
        "DELETE FROM portrait_likes WHERE portrait_id=?",
        (portrait_id,),
    )
    return {"message": "已取消分享，互动数据已清除"}


@router.post("/{portrait_id}/like")
async def toggle_like(portrait_id: int, request: Request):
    """点赞/取消点赞"""
    user = get_current_user(request)
    username = user["username"]

    rows = execute_query(
        "SELECT id, username, is_shared, share_scope, status FROM student_portraits WHERE id=?",
        (portrait_id,),
    )
    if not rows or (rows[0][4] or "active") != "active":
        raise HTTPException(status_code=404, detail="画像不存在")
    # R9: 私有/已删除画像不可被点赞(否则 like_count 可被任意刷)
    if not _can_view_portrait(rows[0][1], rows[0][2] or 0, rows[0][3] or "private",
                              username, user.get("role", 2)):
        raise HTTPException(status_code=403, detail="该画像未公开，无法点赞")

    # 检查是否已点赞
    existing = execute_query(
        "SELECT id FROM portrait_likes WHERE portrait_id=? AND username=?",
        (portrait_id, username),
    )

    if existing:
        execute_insert_update(
            "DELETE FROM portrait_likes WHERE portrait_id=? AND username=?",
            (portrait_id, username),
        )
        action = "unliked"
    else:
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        execute_insert_update(
            "INSERT INTO portrait_likes (portrait_id, username, created_at) VALUES (?, ?, ?)",
            (portrait_id, username, now_str),
        )
        action = "liked"

    # 更新点赞计数
    count_row = execute_query(
        "SELECT COUNT(*) FROM portrait_likes WHERE portrait_id=?",
        (portrait_id,),
    )
    count = count_row[0][0] if count_row else 0
    execute_insert_update(
        "UPDATE student_portraits SET like_count=? WHERE id=?",
        (count, portrait_id),
    )

    return {"action": action, "count": count}


@router.get("/gallery/public")
async def get_public_gallery(request: Request):
    """获取公开画廊（全校可见）"""
    rows = execute_query(
        """SELECT sp.id, sp.username, sp.created_date, sp.style, sp.image_path,
                  sp.ai_comment, sp.like_count, sp.view_count, sp.share_scope
           FROM student_portraits sp
           WHERE sp.is_shared=1 AND sp.share_scope='public' AND sp.status='active'
           ORDER BY sp.like_count DESC, sp.created_date DESC
           LIMIT 100""",
    )

    result = []
    for row in rows:
        item = {
            "id": row[0],
            "username": row[1],
            "created_date": row[2],
            "style": row[3],
            "image_url": _to_portrait_url("", portrait_id=row[0]),
            "ai_comment": (row[5] or ""),
            "like_count": row[6] or 0,
            "view_count": row[7] or 0,
        }
        item = _enrich_with_student_info(item)
        # 检查当前用户是否点赞
        item["liked"] = _check_liked(item["id"], get_current_user(request)["username"])
        result.append(item)

    return {"portraits": result}


@router.get("/gallery/class")
async def get_class_gallery(request: Request):
    """获取班级画廊（同班可见）"""
    user = get_current_user(request)
    username = user["username"]

    # 查询用户年级/班级
    user_info = execute_query(
        "SELECT grade, class FROM users WHERE username=?",
        (username,),
    )
    if not user_info or not user_info[0][0]:
        return {"portraits": []}

    grade = user_info[0][0]
    cls = user_info[0][1] or ""

    rows = execute_query(
        """SELECT sp.id, sp.username, sp.created_date, sp.style, sp.image_path,
                  sp.ai_comment, sp.like_count, sp.view_count
           FROM student_portraits sp
           JOIN users u ON sp.username = u.username
           WHERE sp.is_shared=1 AND sp.status='active'
             AND sp.share_scope IN ('public', 'class')
             AND u.grade=? AND u.class=?
           ORDER BY sp.created_date DESC""",
        (grade, cls),
    )

    result = []
    for row in rows:
        item = {
            "id": row[0],
            "username": row[1],
            "created_date": row[2],
            "style": row[3],
            "image_url": _to_portrait_url("", portrait_id=row[0]),
            "ai_comment": (row[5] or ""),
            "like_count": row[6] or 0,
            "view_count": row[7] or 0,
        }
        item = _enrich_with_student_info(item)
        item["liked"] = _check_liked(item["id"], username)
        result.append(item)

    return {"portraits": result}


@router.get("/gallery/hot")
async def get_hot_gallery(request: Request):
    """获取热门画像（点赞最多）"""
    rows = execute_query(
        """SELECT sp.id, sp.username, sp.created_date, sp.style, sp.image_path,
                  sp.ai_comment, sp.like_count, sp.view_count
           FROM student_portraits sp
           WHERE sp.is_shared=1 AND sp.share_scope='public' AND sp.status='active'
           ORDER BY sp.like_count DESC
           LIMIT 50""",
    )

    result = []
    for row in rows:
        item = {
            "id": row[0],
            "username": row[1],
            "created_date": row[2],
            "style": row[3],
            "image_url": _to_portrait_url("", portrait_id=row[0]),
            "ai_comment": (row[5] or ""),
            "like_count": row[6] or 0,
            "view_count": row[7] or 0,
        }
        item = _enrich_with_student_info(item)
        item["liked"] = _check_liked(item["id"], get_current_user(request)["username"])
        result.append(item)

    return {"portraits": result}


@router.delete("/{portrait_id}")
async def delete_portrait(portrait_id: int, request: Request):
    """删除画像"""
    user = get_current_user(request)
    username = user["username"]

    rows = execute_query(
        "SELECT id, username, image_path FROM student_portraits WHERE id=?",
        (portrait_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="画像不存在")
    if rows[0][1] != username and not is_admin(username):
        raise HTTPException(status_code=403, detail="只能删除自己的画像")

    # 删除本地文件
    img_path = rows[0][2]
    if img_path and os.path.exists(img_path):
        try:
            os.remove(img_path)
        except Exception as e:
            logger.warning(f"删除画像文件失败: {e}")

    # 软删除：保留 DB 记录以维持每日生成限制，清空图片路径并取消分享
    execute_insert_update(
        "UPDATE student_portraits SET status='deleted', image_path='', is_shared=0, share_scope='private' WHERE id=?",
        (portrait_id,),
    )
    # 清理点赞数据
    execute_insert_update(
        "DELETE FROM portrait_likes WHERE portrait_id=?",
        (portrait_id,),
    )

    return {"message": "画像已删除并取消分享；本周生成额度已使用，删除后本周不能再免费生成"}
