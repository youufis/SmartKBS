"""
学生自我画像 API 路由
每日生成一张 AI 画像 + 创意寄语，支持画廊、分享与点赞
"""
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.api.config_router import get_config_value
from backend.auth import is_admin
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


class ShareRequest(BaseModel):
    scope: str = "public"  # public | class | private


# ── 辅助函数 ──

def _get_portrait_dir(username: str) -> Path:
    """获取学生画像存储目录"""
    base = Path(get_user_base_dir(username))
    portrait_dir = base / "portraits"
    portrait_dir.mkdir(parents=True, exist_ok=True)
    return portrait_dir


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


def _format_portrait_row(row: tuple) -> dict[str, Any]:
    """将数据库行转为响应字典"""
    return {
        "id": row[0],
        "username": row[1],
        "created_date": row[2],
        "style": row[3],
        "image_path": row[4] or "",
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


def _enrich_with_student_info(portrait: dict[str, Any]) -> dict[str, Any]:
    """补充学生姓名信息"""
    rows = execute_query(
        "SELECT name, grade, class FROM users WHERE username=?",
        (portrait["username"],),
    )
    if rows:
        portrait["student_name"] = rows[0][0] or portrait["username"]
        portrait["grade"] = rows[0][1] or ""
        portrait["class_name"] = rows[0][2] or ""
    else:
        portrait["student_name"] = portrait["username"]
        portrait["grade"] = ""
        portrait["class_name"] = ""
    return portrait


def _check_liked(portrait_id: int, username: str) -> bool:
    """检查用户是否已点赞"""
    rows = execute_query(
        "SELECT id FROM portrait_likes WHERE portrait_id=? AND username=?",
        (portrait_id, username),
    )
    return bool(rows)


def _enrich_role_data(profile: dict[str, Any]) -> None:
    """根据角色补充平台特有数据"""
    role = profile.get("role", 2)
    username = profile.get("username", "")
    if role == 2:
        return  # 学生无需额外补充

    try:
        if role == 1:  # 教师
            # 任教班级数
            rows = execute_query(
                "SELECT COUNT(DISTINCT grade||class) FROM users WHERE username=?",
                (username,),
            )
            # 创建的活动数量
            quiz_count = execute_query(
                "SELECT COUNT(*) FROM interaction_quizzes WHERE creator_username=?",
                (username,),
            )
            exam_count = execute_query(
                "SELECT COUNT(*) FROM exams WHERE creator_username=?",
                (username,),
            )
            profile["teach_stats"] = (
                f"任教{rows[0][0] if rows else 0}个班级，"
                f"创建{quiz_count[0][0] if quiz_count else 0}个测验、"
                f"{exam_count[0][0] if exam_count else 0}场考试"
            )
        elif role == 0:  # 管理员
            user_count = execute_query("SELECT COUNT(*) FROM users", ())
            active_count = execute_query(
                "SELECT COUNT(DISTINCT username) FROM login_logs WHERE login_time >= date('now', '-7 days')",
                (),
            )
            profile["admin_stats"] = (
                f"平台共{user_count[0][0] if user_count else 0}名用户，"
                f"近7日{active_count[0][0] if active_count else 0}人活跃"
            )
    except Exception as e:
        logger.warning(f"补充角色数据失败: {e}")


# ── 获取 AI API Key ──

def _get_api_key() -> str:
    """获取可用的 API Key"""
    key = (os.environ.get("DASHSCOPE_API_KEY", "")
           or get_config_value("dashscope_api_key", ""))
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
        "SELECT id, username, image_path, is_shared, share_scope FROM student_portraits WHERE id=?",
        (portrait_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="画像不存在")

    rec = rows[0]
    owner = rec[1]
    image_path = rec[2] or ""
    is_shared = rec[3] or 0
    share_scope = rec[4] or "private"

    if not image_path or not os.path.exists(image_path):
        raise HTTPException(status_code=404, detail="图片文件不存在")

    # 权限检查
    user = get_current_user(request)
    viewer = user["username"]

    if viewer != owner:
        if not is_shared or share_scope == "private":
            raise HTTPException(status_code=403, detail="无权查看该画像")
        if share_scope == "class":
            viewer_info = execute_query(
                "SELECT grade, class FROM users WHERE username=?", (viewer,)
            )
            owner_info = execute_query(
                "SELECT grade, class FROM users WHERE username=?", (owner,)
            )
            if viewer_info and owner_info:
                if viewer_info[0] != owner_info[0]:
                    raise HTTPException(status_code=403, detail="仅同班同学可查看")
            else:
                raise HTTPException(status_code=403, detail="无权查看该画像")

    return FileResponse(image_path)


@router.get("/today")
async def get_today_portrait(request: Request):
    """获取今日画像（如果已生成）"""
    user = get_current_user(request)
    username = user["username"]
    today = datetime.now().strftime("%Y-%m-%d")

    rows = execute_query(
        """SELECT id, username, created_date, style, image_path, ai_comment,
                  prompt, generated_at, view_count, is_shared, share_scope, like_count
           FROM student_portraits
           WHERE username=? AND created_date=?""",
        (username, today),
    )
    if not rows:
        return {"exists": False}

    portrait = _format_portrait_row(rows[0])

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


@router.post("/generate")
async def generate_portrait(request: Request, body: GenerateRequest):
    """生成今日画像（每天一次）"""
    user = get_current_user(request)
    username = user["username"]

    today = datetime.now().strftime("%Y-%m-%d")

    # 检查今日是否已生成
    existing = execute_query(
        "SELECT id FROM student_portraits WHERE username=? AND created_date=?",
        (username, today),
    )
    if existing:
        raise HTTPException(status_code=400, detail="今日画像已生成，明天再来吧 ✨")

    # 检查 API Key
    api_key = _get_api_key()

    # 确定风格
    style = body.style or "random"
    if style not in PORTRAIT_STYLES:
        style = "random"

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

    # 3. LLM 生成创意寄语
    logger.info(f"开始生成寄语: username={username}")
    try:
        comment = await call_ai_sync_with_timeout(
            build_portrait_comment_prompt(profile, style),
            api_key,
            timeout=150,
        )
        comment = comment.strip().strip('"\'')
    except Exception as e:
        logger.error(f"生成寄语失败: {e}")
        role_name = profile.get('role_name', '用户')
        fallbacks = {
            '教师': '三尺讲台育桃李，一支粉笔写春秋。今日的你依然在发光发热 🌟',
            '管理员': '运筹帷幄之中，决胜千里之外。平台因你而精彩 🚀',
        }
        comment = fallbacks.get(role_name, '今日份的努力，是明日惊喜的铺垫！继续加油哦 🌟')

    # 4. 通义万相生图
    logger.info(f"开始生成图片: username={username}")
    save_dir = _get_portrait_dir(username)
    style_key = style if style != "random" else "creative"
    filename = f"{today}_{style_key}"

    try:
        image_path = await generate_and_save_image(
            prompt=img_prompt,
            save_dir=str(save_dir),
            filename=filename,
        )
        if not image_path:
            logger.warning(f"生图失败，使用占位: username={username}")
            image_path = ""
    except Exception as e:
        logger.error(f"生图异常: {e}")
        image_path = ""

    # 5. 保存到数据库
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_insert_update(
        """INSERT INTO student_portraits
           (username, created_date, style, image_path, ai_comment, prompt, generated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (username, today, style_key, image_path, comment, img_prompt, now_str),
    )

    # 重新查询
    rows = execute_query(
        """SELECT id, username, created_date, style, image_path, ai_comment,
                  prompt, generated_at, view_count, is_shared, share_scope, like_count
           FROM student_portraits WHERE username=? AND created_date=?""",
        (username, today),
    )
    portrait = _format_portrait_row(rows[0]) if rows else {}
    portrait["liked"] = False

    return {
        "message": "今日画像生成成功 🎉",
        "portrait": portrait,
    }


@router.get("/list")
async def list_portraits(request: Request):
    """获取用户的所有画像"""
    user = get_current_user(request)
    username = user["username"]

    rows = execute_query(
        """SELECT id, username, created_date, style, image_path, ai_comment,
                  prompt, generated_at, view_count, is_shared, share_scope, like_count
           FROM student_portraits
           WHERE username=? AND status='active'
           ORDER BY created_date DESC""",
        (username,),
    )

    portraits = []
    for row in rows:
        p = _format_portrait_row(row)
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
                  prompt, generated_at, view_count, is_shared, share_scope, like_count
           FROM student_portraits WHERE id=?""",
        (portrait_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="画像不存在")

    portrait = _format_portrait_row(rows[0])

    # 权限：只能看自己的或公开的
    if portrait["username"] != username and not (portrait["is_shared"] and portrait["share_scope"] in ("public", "class")) and not is_admin(username):
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
        "SELECT id FROM student_portraits WHERE id=?",
        (portrait_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="画像不存在")

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
            "image_path": row[4] or "",
            "image_url": _to_portrait_url("", portrait_id=row[0]),
            "ai_comment": (row[5] or "")[:100],
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
           WHERE sp.is_shared=1 AND sp.share_scope='class' AND sp.status='active'
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
            "image_path": row[4] or "",
            "image_url": _to_portrait_url("", portrait_id=row[0]),
            "ai_comment": (row[5] or "")[:100],
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
            "image_path": row[4] or "",
            "image_url": _to_portrait_url("", portrait_id=row[0]),
            "ai_comment": (row[5] or "")[:100],
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

    return {"message": "画像已删除，今日无法再次生成"}
