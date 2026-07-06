"""
学子风采·荣誉展示墙 API 路由
教师生成荣誉卡片，全校师生浏览、搜索、点赞
"""
import json
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.auth import is_admin
from backend.database import execute_query, execute_insert_update, get_connection
from backend.logger import logger
from backend.permission_service import get_teacher_grades, get_teacher_classes, get_grade_by_name
from backend.reward_engine import get_student_total
from backend.title_system import (
    get_main_title, get_main_title_progress,
    get_student_subject_titles, get_student_badges,
    get_badge_config,
)

router = APIRouter()

# ── 数据模型 ──

class GenerateRequest(BaseModel):
    count: int = 10
    grade: str = ""
    class_name: str = ""
    student_name: str = ""


class ReorderRequest(BaseModel):
    ids: list[int]


# ── 10 套预设主题（供师生手动更换）──

PRESET_THEMES = {
    "golden":    {"name": "晨曦金", "color": "#faad14", "desc": "温暖金色，如晨曦般耀眼"},
    "ocean":     {"name": "海洋蓝", "color": "#1677ff", "desc": "深邃蓝色，如海洋般广阔"},
    "forest":    {"name": "森林绿", "color": "#52c41a", "desc": "生机绿色，如森林般蓬勃"},
    "cherry":    {"name": "樱花粉", "color": "#eb2f96", "desc": "柔美粉色，如樱花般绚烂"},
    "aurora":    {"name": "极光紫", "color": "#722ed1", "desc": "梦幻紫色，如极光般神秘"},
    "gunset":    {"name": "日落橙", "color": "#fa8c16", "desc": "温暖橙色，如夕阳般浪漫"},
    "cosmic":    {"name": "星空黑", "color": "#1a1a2e", "desc": "深邃星空，神秘而高贵"},
    "mint":      {"name": "薄荷青", "color": "#13c2c2", "desc": "清新薄荷，如春风般怡人"},
    "flame":     {"name": "烈焰红", "color": "#f5222d", "desc": "热情红色，如火焰般奔放"},
    "minimal":   {"name": "极简灰", "color": "#8c8c8c", "desc": "简约灰色，低调而高级"},
}

# ── 称号等级 → 默认主题映射（12级→10套）──

LEVEL_THEME_MAP = [
    "golden",   # Lv.1
    "forest",   # Lv.2
    "mint",     # Lv.3
    "ocean",    # Lv.4
    "aurora",   # Lv.5
    "aurora",   # Lv.6
    "cherry",   # Lv.7
    "golden",   # Lv.8
    "gunset",   # Lv.9
    "flame",    # Lv.10
    "flame",    # Lv.11
    "cosmic",   # Lv.12
]

def _get_default_theme(level: int) -> str:
    """根据称号等级返回默认主题"""
    idx = max(0, min(level - 1, len(LEVEL_THEME_MAP) - 1))
    return LEVEL_THEME_MAP[idx]

class ThemeUpdateRequest(BaseModel):
    theme: str  # theme key


def _build_snapshot(student_username: str) -> dict[str, Any]:
    """构建学生当前积分/称号/徽章的快照数据"""
    total_points = get_student_total(student_username)
    main_title = get_main_title(total_points)
    subject_titles = get_student_subject_titles(student_username)
    badges = get_student_badges(student_username)
    badge_config = get_badge_config()
    unlocked_count = sum(1 for b in badges if b.get("unlocked"))
    total_badge_count = len(badge_config)

    # 获取学生基本信息
    rows = execute_query(
        "SELECT name, grade, class FROM users WHERE username=?",
        (student_username,),
    )
    student_info = {}
    if rows:
        student_info = {
            "name": rows[0][0] or student_username,
            "grade": rows[0][1] or "",
            "class": rows[0][2] or "",
        }

    return {
        "total_points": total_points,
        "main_title": main_title,
        "progress": get_main_title_progress(total_points),
        "subject_titles": subject_titles,
        "badges": badges,
        "unlocked_badge_count": unlocked_count,
        "total_badge_count": total_badge_count,
        "student_info": student_info,
        "theme_style": _get_default_theme(main_title["level"]),
    }


def _format_showcase_row(row: tuple) -> dict[str, Any]:
    """将数据库行转为响应字典"""
    snapshot = json.loads(row[3]) if isinstance(row[3], str) else {}
    return {
        "id": row[0],
        "student_username": row[1],
        "generated_by": row[2],
        "snapshot_data": snapshot,
        "theme_style": row[4] or "auto",
        "like_count": row[5] or 0,
        "view_count": row[6] or 0,
        "is_active": bool(row[7]),
        "sort_order": row[8] or 0,
        "batch_id": row[9],
        "generated_at": row[10],
        "updated_at": row[11],
        # 补充字段
        "student_name": snapshot.get("student_info", {}).get("name", row[1]),
        "grade": snapshot.get("student_info", {}).get("grade", ""),
        "class_name": snapshot.get("student_info", {}).get("class", ""),
    }


def _check_liked(showcase_id: int, username: str) -> bool:
    """检查用户是否已点赞"""
    rows = execute_query(
        "SELECT id FROM showcase_likes WHERE showcase_id=? AND username=?",
        (showcase_id, username),
    )
    return bool(rows)


# ═══════════════════════════════════════════════
# API 端点
# ═══════════════════════════════════════════════


@router.post("/showcase/generate", summary="批量生成荣誉展示卡")
async def generate_showcase(request: Request, body: GenerateRequest):
    """教师按条件筛选学生并批量生成荣誉展示卡"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可生成展示卡")

    # 参数校验
    count = max(1, min(body.count, 200))
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    batch_id = f"showcase_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

    # 构建查询
    conditions = ["u.role=2"]
    params: list[Any] = []

    if body.student_name:
        conditions.append("u.name LIKE ?")
        params.append(f"%{body.student_name}%")

    # 教师权限过滤（管理员跳过）
    if role == 1 and not is_admin(username):
        teacher_grades = get_teacher_grades(username)
        teacher_grade_names = [g["name"] for g in teacher_grades]
        if not teacher_grade_names:
            raise HTTPException(status_code=403, detail="您暂无任教班级，无法生成展示卡")

        if body.grade:
            if body.grade not in teacher_grade_names:
                raise HTTPException(status_code=403, detail=f"您未任教「{body.grade}」，无法生成该年级展示卡")
            conditions.append("u.grade=?")
            params.append(body.grade)
            grade_info = get_grade_by_name(body.grade)
            if grade_info:
                allowed = get_teacher_classes(username, grade_info["id"])
                allowed_nums = [c["name"] for c in allowed]
                if allowed_nums:
                    if body.class_name:
                        cls_num = body.class_name.replace("班", "").strip()
                        if cls_num not in allowed_nums:
                            raise HTTPException(status_code=403, detail=f"您未任教「{body.grade}」的「{body.class_name}」")
                        conditions.append("u.class=?")
                        params.append(cls_num)
                    else:
                        placeholders = ",".join("?" for _ in allowed_nums)
                        conditions.append(f"u.class IN ({placeholders})")
                        params.extend(allowed_nums)
        else:
            grade_placeholders = ",".join("?" for _ in teacher_grade_names)
            conditions.append(f"u.grade IN ({grade_placeholders})")
            params.extend(teacher_grade_names)
    else:
        # 管理员/其他：按请求参数直接筛选
        if body.grade:
            conditions.append("u.grade=?")
            params.append(body.grade)
        if body.class_name:
            cls_num = body.class_name.replace("班", "").strip()
            conditions.append("u.class=?")
            params.append(cls_num)

    where_clause = " AND ".join(conditions)
    sql = f"""
        SELECT u.username
        FROM users u
        LEFT JOIN student_total_points stp ON u.username = stp.student_username
        WHERE {where_clause}
        ORDER BY COALESCE(stp.total_points, 0) DESC
        LIMIT ?
    """
    params.append(count)

    rows = execute_query(sql, tuple(params))
    if not rows:
        raise HTTPException(status_code=404, detail="未找到符合条件的学生")

    student_usernames = [r[0] for r in rows]

    # 批量生成/更新卡片
    generated_count = 0
    updated_count = 0

    with get_connection() as conn:
        c = conn.cursor()
        for idx, stu_username in enumerate(student_usernames):
            snapshot = _build_snapshot(stu_username)
            snapshot_json = json.dumps(snapshot, ensure_ascii=False)
            theme = snapshot.get("theme_style", "auto")

            # 检查是否已存在
            existing = c.execute(
                "SELECT id FROM student_showcase WHERE student_username=?",
                (stu_username,),
            ).fetchone()

            if existing:
                c.execute(
                    """UPDATE student_showcase SET
                       generated_by=?, snapshot_data=?, theme_style=?,
                       sort_order=?, batch_id=?, updated_at=?
                       WHERE student_username=?""",
                    (username, snapshot_json, theme, idx, batch_id, now_str, stu_username),
                )
                updated_count += 1
            else:
                c.execute(
                    """INSERT INTO student_showcase
                       (student_username, generated_by, snapshot_data, theme_style,
                        sort_order, batch_id, generated_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (stu_username, username, snapshot_json, theme,
                     idx, batch_id, now_str, now_str),
                )
                generated_count += 1
        conn.commit()

    # 新批次全部设为活跃
    if student_usernames:
        placeholders = ",".join("?" for _ in student_usernames)
        with get_connection() as conn2:
            c2 = conn2.cursor()
            c2.execute(
                f"UPDATE student_showcase SET is_active=1 WHERE student_username IN ({placeholders})",
                student_usernames,
            )
            conn2.commit()

    logger.info(f"展示卡生成: teacher={username}, batch={batch_id}, new={generated_count}, updated={updated_count}")

    return {
        "message": f"生成成功 🎉 新增 {generated_count} 张，更新 {updated_count} 张",
        "generated_count": generated_count,
        "updated_count": updated_count,
        "batch_id": batch_id,
        "total": len(student_usernames),
    }


@router.get("/showcase/list", summary="获取荣誉展示卡列表")
async def list_showcase(
    request: Request,
    grade: str = Query("", description="年级筛选"),
    class_name: str = Query("", description="班级筛选"),
    student_name: str = Query("", description="学生姓名模糊搜索"),
    sort_by: str = Query("points", description="排序: points/likes/newest"),
    page: int = Query(1, ge=1, description="页码"),
    page_size: int = Query(20, ge=1, le=100, description="每页数量"),
):
    """获取荣誉展示卡列表，支持筛选、搜索、排序和分页"""
    user = get_current_user(request)
    current_username = user["username"]

    conditions = ["sc.is_active=1"]
    params: list[Any] = []

    if grade:
        conditions.append("u.grade=?")
        params.append(grade)
    if class_name:
        cls_num = class_name.replace("班", "").strip()
        conditions.append("u.class=?")
        params.append(cls_num)
    if student_name:
        conditions.append("u.name LIKE ?")
        params.append(f"%{student_name}%")

    where_clause = " AND ".join(conditions) if conditions else "1=1"

    # 排序
    order_map = {
        "points": "COALESCE(json_extract(sc.snapshot_data, '$.total_points'), 0) DESC",
        "likes": "sc.like_count DESC",
        "newest": "sc.generated_at DESC",
    }
    order_by = order_map.get(sort_by, order_map["points"])

    # 统计总数
    count_sql = f"""
        SELECT COUNT(*) FROM student_showcase sc
        JOIN users u ON sc.student_username = u.username
        WHERE {where_clause}
    """
    count_row = execute_query(count_sql, tuple(params))
    total = count_row[0][0] if count_row else 0

    # 分页查询
    offset = (page - 1) * page_size
    data_sql = f"""
        SELECT sc.id, sc.student_username, sc.generated_by,
               sc.snapshot_data, sc.theme_style, sc.like_count, sc.view_count,
               sc.is_active, sc.sort_order, sc.batch_id, sc.generated_at, sc.updated_at
        FROM student_showcase sc
        JOIN users u ON sc.student_username = u.username
        WHERE {where_clause}
        ORDER BY {order_by}, sc.sort_order ASC
        LIMIT ? OFFSET ?
    """
    rows = execute_query(data_sql, tuple(params) + (page_size, offset))

    cards = []
    for row in rows:
        card = _format_showcase_row(row)
        card["liked"] = _check_liked(card["id"], current_username)
        cards.append(card)

    return {
        "cards": cards,
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.get("/showcase/{showcase_id}", summary="获取单张展示卡详情")
async def get_showcase_detail(showcase_id: int, request: Request):
    """获取单张展示卡详情，并记录浏览"""
    user = get_current_user(request)
    current_username = user["username"]

    rows = execute_query(
        """SELECT id, student_username, generated_by, snapshot_data, theme_style,
                  like_count, view_count, is_active, sort_order, batch_id,
                  generated_at, updated_at
           FROM student_showcase WHERE id=?""",
        (showcase_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="展示卡不存在")

    card = _format_showcase_row(rows[0])

    if not card["is_active"]:
        raise HTTPException(status_code=404, detail="展示卡已下架")

    # 记录浏览（每人每卡仅计一次）
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        execute_insert_update(
            "INSERT OR IGNORE INTO showcase_view_logs (showcase_id, username, viewed_at) VALUES (?, ?, ?)",
            (showcase_id, current_username, now_str),
        )
        # 更新浏览计数（只增不减）
        execute_insert_update(
            "UPDATE student_showcase SET view_count = (SELECT COUNT(*) FROM showcase_view_logs WHERE showcase_id=?) WHERE id=?",
            (showcase_id, showcase_id),
        )
    except Exception as e:
        logger.warning(f"记录浏览失败: {e}")

    card["liked"] = _check_liked(showcase_id, current_username)
    return card


@router.post("/showcase/{showcase_id}/like", summary="点赞/取消点赞")
async def toggle_like(showcase_id: int, request: Request):
    """点赞或取消点赞"""
    user = get_current_user(request)
    current_username = user["username"]

    # 检查卡片是否存在且活跃
    rows = execute_query(
        "SELECT id, is_active FROM student_showcase WHERE id=?",
        (showcase_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="展示卡不存在")
    if not rows[0][1]:
        raise HTTPException(status_code=400, detail="展示卡已下架")

    # 检查是否已点赞
    existing = execute_query(
        "SELECT id FROM showcase_likes WHERE showcase_id=? AND username=?",
        (showcase_id, current_username),
    )

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    if existing:
        execute_insert_update(
            "DELETE FROM showcase_likes WHERE showcase_id=? AND username=?",
            (showcase_id, current_username),
        )
        action = "unliked"
    else:
        execute_insert_update(
            "INSERT INTO showcase_likes (showcase_id, username, created_at) VALUES (?, ?, ?)",
            (showcase_id, current_username, now_str),
        )
        action = "liked"

    # 更新点赞计数
    count_row = execute_query(
        "SELECT COUNT(*) FROM showcase_likes WHERE showcase_id=?",
        (showcase_id,),
    )
    count = count_row[0][0] if count_row else 0
    execute_insert_update(
        "UPDATE student_showcase SET like_count=? WHERE id=?",
        (count, showcase_id),
    )

    return {"action": action, "count": count}


@router.delete("/showcase/{showcase_id}", summary="下架展示卡")
async def deactivate_showcase(showcase_id: int, request: Request):
    """教师下架单张展示卡"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可操作")

    rows = execute_query(
        "SELECT id, student_username FROM student_showcase WHERE id=?",
        (showcase_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="展示卡不存在")

    execute_insert_update(
        "UPDATE student_showcase SET is_active=0 WHERE id=?",
        (showcase_id,),
    )
    logger.info(f"展示卡已下架: id={showcase_id}, operator={username}")
    return {"message": "已下架"}


@router.put("/showcase/reorder", summary="批量调整排序")
async def reorder_showcase(request: Request, body: ReorderRequest):
    """批量调整展示卡排序"""
    user = get_current_user(request)
    role = user.get("role", 2)

    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可操作")

    with get_connection() as conn:
        c = conn.cursor()
        for idx, card_id in enumerate(body.ids):
            c.execute(
                "UPDATE student_showcase SET sort_order=? WHERE id=?",
                (idx, card_id),
            )
        conn.commit()


@router.get("/showcase/themes", summary="获取所有预设主题")
async def get_themes():
    """获取10套预设主题列表"""
    themes = []
    for key, info in PRESET_THEMES.items():
        themes.append({
            "key": key,
            "name": info["name"],
            "color": info["color"],
            "desc": info["desc"],
        })
    return {"themes": themes}


@router.put("/showcase/{showcase_id}/theme", summary="更新展示卡主题")
async def update_theme(showcase_id: int, request: Request, body: ThemeUpdateRequest):
    """学生或教师更新展示卡的主题风格"""
    user = get_current_user(request)
    username = user["username"]

    if body.theme not in PRESET_THEMES:
        raise HTTPException(status_code=400, detail=f"无效的主题: {body.theme}，可选: {', '.join(PRESET_THEMES.keys())}")

    rows = execute_query(
        "SELECT id, student_username FROM student_showcase WHERE id=?",
        (showcase_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="展示卡不存在")

    # 允许：卡片主人 + 教师/管理员 修改
    owner = rows[0][1]
    role = user.get("role", 2)
    if owner != username and role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅卡片主人或教师可修改主题")

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_insert_update(
        "UPDATE student_showcase SET theme_style=?, updated_at=? WHERE id=?",
        (body.theme, now_str, showcase_id),
    )
    logger.info(f"展示卡主题更新: id={showcase_id}, theme={body.theme}, operator={username}")
    return {"message": f"主题已更新为「{PRESET_THEMES[body.theme]['name']}」"}

    return {"message": "排序已更新"}
