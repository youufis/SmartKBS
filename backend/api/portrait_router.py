"""
学生自我画像 API 路由
每日生成一张 AI 画像 + 创意寄语，支持画廊、分享与点赞
"""
import os
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
    """R2: 兑换型操作失败时冲正积分(写一条 refund 流水, 保持账目可追溯)"""
    if points <= 0:
        return
    try:
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        execute_insert_update(
            """INSERT INTO activity_rewards
               (student_username, activity_type, activity_id, activity_title, reward_type, points, reason, created_at)
               VALUES (?, 'portrait', ?, '自我画像', 'refund', ?, ?, ?)""",
            (username, now, points, f"{reason}(+{points})", now),
        )
        from backend.reward_engine import update_student_total
        update_student_total(username)
        logger.info(f"画像积分退还: {username} +{points} ({reason})")
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
    }
    if include_path:
        result["image_path"] = row[4] or ""
    return result


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


def _enrich_role_data(profile: dict[str, Any]) -> None:
    """根据角色补充累计动态数据"""
    role = profile.get("role", 2)
    username = profile.get("username", "")

    try:
        if role == 2:  # 学生累计数据
            week_start, week_end = _get_week_range()

            # 累计考试数
            q_rows = execute_query(
                "SELECT COUNT(*) FROM exam_attempts WHERE student_username=? AND status IN ('submitted','graded')",
                (username,),
            )
            total_exams = q_rows[0][0] if q_rows else 0

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

        elif role == 1:  # 教师累计数据
            week_start, week_end = _get_week_range()
            # 任教班级数
            class_rows = execute_query(
                "SELECT COUNT(DISTINCT grade||class) FROM users WHERE username=?",
                (username,),
            )
            # 累计创建的活动数量
            quiz_count = execute_query(
                "SELECT COUNT(*) FROM interaction_quizzes WHERE creator_username=?",
                (username,),
            )
            exam_count = execute_query(
                "SELECT COUNT(*) FROM exams WHERE creator_username=?",
                (username,),
            )
            # 本周新创建活动
            week_quiz = execute_query(
                "SELECT COUNT(*) FROM interaction_quizzes WHERE creator_username=? AND created_at >= ?",
                (username, week_start),
            )
            week_exam = execute_query(
                "SELECT COUNT(*) FROM exams WHERE creator_username=? AND created_at >= ?",
                (username, week_start),
            )
            # 批阅任务数
            try:
                task_count = execute_query(
                    "SELECT COUNT(*) FROM task_grades WHERE teacher_username=?",
                    (username,),
                )
                if task_count and task_count[0][0] > 0:
                    profile["teach_stats"] += f"，批阅{task_count[0][0]}份任务"
            except Exception:
                pass

            profile["teach_stats"] = (
                f"任教{class_rows[0][0] if class_rows else 0}个班级，"
                f"累计创建{quiz_count[0][0] if quiz_count else 0}个测验、"
                f"{exam_count[0][0] if exam_count else 0}场考试"
            )
            week_extra = []
            if week_quiz[0][0] > 0:
                week_extra.append(f"本周新增{week_quiz[0][0]}个测验")
            if week_exam[0][0] > 0:
                week_extra.append(f"本周新增{week_exam[0][0]}场考试")
            if week_extra:
                profile["teach_stats"] += "，" + "、".join(week_extra)

        elif role == 0:  # 管理员累计数据
            total_users = execute_query("SELECT COUNT(*) FROM users", ())
            week_start, week_end = _get_week_range()
            new_this_week = execute_query(
                "SELECT COUNT(*) FROM users WHERE rowid IN (SELECT rowid FROM users ORDER BY rowid DESC LIMIT 100) AND username NOT IN ('root','admin')",
                (),
            )
            active_users = execute_query(
                "SELECT COUNT(DISTINCT username) FROM login_logs WHERE login_time >= date('now', '-7 days')",
                (),
            )
            total_portraits = execute_query(
                "SELECT COUNT(*) FROM student_portraits WHERE status='active'",
                (),
            )
            total_exams = execute_query("SELECT COUNT(*) FROM exams", ())

            profile["admin_stats"] = (
                f"平台共{total_users[0][0] if total_users else 0}名用户，"
                f"近7日{active_users[0][0] if active_users else 0}人活跃，"
                f"累计{total_exams[0][0] if total_exams else 0}场考试、"
                f"{total_portraits[0][0] if total_portraits else 0}幅画像"
            )
    except Exception as e:
        logger.warning(f"补充角色数据失败: {e}")


# ── 获取 AI API Key ──

def _get_week_range() -> tuple[str, str]:
    """获取当前周的起止日期 (周一, 周日)"""
    today = datetime.now()
    monday = today - timedelta(days=today.weekday())
    sunday = monday + timedelta(days=6)
    return monday.strftime("%Y-%m-%d"), sunday.strftime("%Y-%m-%d")


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
    """获取本周画像（如果已生成）"""
    user = get_current_user(request)
    username = user["username"]
    week_start, week_end = _get_week_range()

    rows = execute_query(
        """SELECT id, username, created_date, style, image_path, ai_comment,
                  prompt, generated_at, view_count, is_shared, share_scope, like_count
           FROM student_portraits
           WHERE username=? AND created_date BETWEEN ? AND ?""",
        (username, week_start, week_end),
    )
    if not rows:
        return {"exists": False}

    portrait = _format_portrait_row(rows[0])
    portrait = _enrich_with_student_info(portrait)

    # 如果已软删除，标记不可用但仍告知已生成
    if portrait.get("status") == "deleted":
        return {"exists": True, "portrait": {**portrait, "deleted": True}}

    # 增加浏览次数
    execute_insert_update(
        "UPDATE student_portraits SET view_count = view_count + 1 WHERE id=?",
        (portrait["id"],),
    )
    portrait["liked"] = _check_liked(portrait["id"], username)
    return {"exists": True, "portrait": portrait}


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


@router.post("/generate")
async def generate_portrait(request: Request, body: GenerateRequest):
    """生成本周画像（每周一次免费，可用 100 积分兑换额外机会）"""
    user = get_current_user(request)
    username = user["username"]

    week_start, week_end = _get_week_range()

    # R2: 先确认 AI 可用, 避免"扣了分却什么都生成不出来"
    api_key = _get_api_key()
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 AI 服务 Key，暂时无法生成画像，请联系管理员")

    # 检查本周是否已生成
    existing = execute_query(
        "SELECT id FROM student_portraits WHERE username=? AND created_date BETWEEN ? AND ?",
        (username, week_start, week_end),
    )
    charged = 0
    if existing:
        if body.use_points:
            # 用 100 积分兑换本周额外生成机会
            from backend.reward_engine import deduct_points, get_student_total
            total = get_student_total(username)
            if total < 100:
                raise HTTPException(status_code=400, detail=f"积分不足，当前仅有 {total} 积分，需要 100 积分才能兑换额外生成机会 📉")
            charged = deduct_points(username, "消耗100积分兑换画像生成", 100)
            if charged <= 0:
                raise HTTPException(status_code=400, detail="积分扣除未成功（可用积分不足），请刷新后重试")
            logger.info(f"学生 {username} 消耗 {charged} 积分兑换了本周额外画像生成")
        else:
            raise HTTPException(status_code=400, detail="本周画像已生成，消耗 100 积分可再生成一次 ✨")

    # 确定风格
    style = body.style or "random"
    if style not in PORTRAIT_STYLES:
        style = "random"

    # 当前日期字符串
    today_str = datetime.now().strftime("%Y-%m-%d")

    try:
        # 1. 聚合用户数据
        profile = get_student_profile(username)
        profile["username"] = username
        profile["role"] = user.get("role", 2)
        role_names = {0: "管理员", 1: "教师", 2: "学生"}
        profile["role_name"] = role_names.get(profile["role"], "用户")

        # 1b. 补充教师/管理员特有数据
        _enrich_role_data(profile)

        # 2. 构建生图 Prompt（直接用于通义万相，无需 LLM 二次处理）
        logger.info(f"构建生图 prompt: username={username}, role={profile['role_name']}, style={style}")
        img_prompt = build_portrait_image_prompt(profile, style)

        # 3. LLM 生成创意寄语（失败有兜底文案, 不影响出图）
        logger.info(f"开始生成寄语: username={username}")
        try:
            comment_prompt = apply_skills(build_portrait_comment_prompt(profile, style), "portrait")
            comment = await call_ai_sync_with_timeout(comment_prompt, api_key, timeout=150)
            comment = comment.strip().strip('"\'')
            comment_ok = True
        except Exception as e:
            logger.error(f"生成寄语失败: {e}")
            role_name = profile.get('role_name', '用户')
            fallbacks = {
                '教师': '三尺讲台育桃李，一支粉笔写春秋。今日的你依然在发光发热 🌟',
                '管理员': '运筹帷幄之中，决胜千里之外。平台因你而精彩 🚀',
            }
            comment = fallbacks.get(role_name, '今日份的努力，是明日惊喜的铺垫！继续加油哦 🌟')
            comment_ok = False

        # 4. 通义万相生图
        logger.info(f"开始生成图片: username={username}")
        save_dir = _get_portrait_dir(username)
        style_key = style
        filename = f"{today_str}_{style_key}"
        img_err = ""
        try:
            image_path = await generate_and_save_image(
                prompt=img_prompt,
                save_dir=str(save_dir),
                filename=filename,
            )
            if not image_path:
                logger.warning(f"生图失败: username={username}")
                img_err = "配图服务未返回图片"
                image_path = ""
        except Exception as e:
            logger.error(f"生图异常: {e}")
            img_err = str(e)[:120]
            image_path = ""

        # 5. 保存到数据库（R2: 同一天再次生成 = 覆盖当天记录, 不再撞 UNIQUE(username, created_date)）
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        old_row = execute_query(
            "SELECT id, image_path FROM student_portraits WHERE username=? AND created_date=?",
            (username, today_str),
        )
        if old_row:
            keep_path = old_row[0][1] if (image_path == "" and old_row[0][1]) else image_path
            execute_insert_update(
                """UPDATE student_portraits
                   SET style=?, image_path=?, ai_comment=?, prompt=?, generated_at=?, status='active'
                   WHERE id=?""",
                (style_key, keep_path, comment, img_prompt, now_str, old_row[0][0]),
            )
            image_path = keep_path
        else:
            execute_insert_update(
                """INSERT INTO student_portraits
                   (username, created_date, style, image_path, ai_comment, prompt, generated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (username, today_str, style_key, image_path, comment, img_prompt, now_str),
            )
    except HTTPException:
        if charged:
            _refund_points(username, charged, "画像生成中断")
        raise
    except Exception as e:
        # R2: 任何失败都冲正积分, 绝不白扣学生积分
        if charged:
            _refund_points(username, charged, "画像生成失败")
        logger.error(f"画像生成失败({username}): {e}")
        raise HTTPException(status_code=502, detail=f"画像生成失败，已退还 {charged} 积分，请稍后再试")

    # 重新查询本次结果(优先当天那条: 同日再生成会覆盖当天记录, 周内有多个历史画像时不能取到旧的那条)
    rows = execute_query(
        """SELECT id, username, created_date, style, image_path, ai_comment,
                  prompt, generated_at, view_count, is_shared, share_scope, like_count
           FROM student_portraits WHERE username=? AND created_date=?""",
        (username, today_str),
    ) or execute_query(
        """SELECT id, username, created_date, style, image_path, ai_comment,
                  prompt, generated_at, view_count, is_shared, share_scope, like_count
           FROM student_portraits WHERE username=? AND created_date BETWEEN ? AND ?
           ORDER BY created_date DESC""",
        (username, week_start, week_end),
    )
    portrait = _format_portrait_row(rows[0]) if rows else {}
    portrait["liked"] = False

    # R11: 不再一律高喊"成功", 如实反映配图/寄语状态
    #      付费兑换却本次没出图 → 无论库里是否还留着旧图, 都退还本次积分
    if charged and img_err:
        _refund_points(username, charged, "本次配图未产出")
        message = f"本次未生成新配图，{charged} 积分已退还 🙏（{img_err}）"
        charged = 0
    elif not portrait.get("image_path"):
        if charged:
            _refund_points(username, charged, "配图未产出")
            message = f"配图未生成，本次积分已退还 🙏（{img_err or '请稍后再试'}）"
        else:
            message = "寄语已生成，但配图未成功，稍后可再试一次 ✨"
    elif not comment_ok:
        message = "画像已生成（寄语使用了默认文案）🎨"
    else:
        message = "今日画像生成成功 🎉"

    return {
        "message": message,
        "portrait": portrait,
        "charged_points": charged,
    }


@router.get("/list")
async def list_portraits(request: Request, include_deleted: bool = Query(False)):
    """获取用户的所有画像(默认只列有效记录; include_deleted 可回看已删除的寄语)"""
    user = get_current_user(request)
    username = user["username"]

    status_sql = "" if include_deleted else "AND status='active'"
    rows = execute_query(
        f"""SELECT id, username, created_date, style, image_path, ai_comment,
                  prompt, generated_at, view_count, is_shared, share_scope, like_count
           FROM student_portraits
           WHERE username=? {status_sql}
           ORDER BY created_date DESC""",
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
        """SELECT id, username, created_date, style, image_path, ai_comment,
                  prompt, generated_at, view_count, is_shared, share_scope, like_count, status
           FROM student_portraits WHERE id=?""",
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
