"""
资源查看追踪 API 路由
记录学生查看 HTML/下载资源的日志，并提供教师端统计查询
"""
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Query

from backend.api.dependencies import get_current_user
from backend.database import execute_insert_update, execute_query_dict, execute_query_one
from backend.logger import logger

router = APIRouter()


# ═══════════════════════════════════════════════════════════
# 记录资源查看
# ═══════════════════════════════════════════════════════════

@router.post("/tracking/resource-view", summary="记录资源查看事件")
async def log_resource_view(request: Request):
    """
    记录学生查看 HTML/下载资源的事件。
    由前端在点击资源时调用。
    """
    user = get_current_user(request)
    username = user.get("username", "")
    role = user.get("role", 2)
    if role != 2:
        # 非学生不记录
        return {"message": "ok"}

    body = await request.json()
    resource_type = body.get("resource_type", "")
    resource_id = body.get("resource_id", 0)
    knowledge_point_id = body.get("knowledge_point_id")
    binding_id = body.get("binding_id")
    source = body.get("source", "curriculum")
    file_path = body.get("file_path", "")
    owner_username = body.get("owner_username", "")

    if not resource_type or not file_path:
        raise HTTPException(status_code=400, detail="缺少必要参数 resource_type 或 file_path")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    client_ip = request.client.host if request.client else ""

    try:
        execute_insert_update(
            """INSERT INTO resource_view_logs
               (student_username, resource_type, resource_id, knowledge_point_id,
                binding_id, source, file_path, owner_username, viewed_at, ip_address)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (username, resource_type, resource_id,
             knowledge_point_id, binding_id, source,
             file_path, owner_username, now, client_ip),
        )

        # 首次浏览共享资源奖励 1 分（幂等，不重复累计）
        try:
            from backend.reward_engine import award_participation
            award_participation(
                student_username=username,
                activity_type="resource_view",
                activity_id=str(resource_id),
                activity_title=file_path.split("/")[-1] or "共享资源",
            )
        except Exception as reward_err:
            logger.warning(f"资源浏览积分奖励失败: {reward_err}")

        return {"message": "记录成功"}
    except Exception as e:
        logger.warning(f"记录资源查看失败: {e}")
        return {"message": "ok"}  # 不影响用户操作


# ═══════════════════════════════════════════════════════════
# 获取单个资源的查看统计
# ═══════════════════════════════════════════════════════════

@router.get("/tracking/resource-view-stats", summary="获取单个资源的查看统计")
async def get_resource_view_stats(
    request: Request,
    resource_type: str = Query(...),
    resource_id: int = Query(...),
):
    """获取指定资源的查看统计数据（教师/管理员）"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")

    # 总查看次数
    total_views = execute_query_one(
        "SELECT COUNT(*) as cnt FROM resource_view_logs WHERE resource_type=? AND resource_id=?",
        (resource_type, resource_id),
    )
    total = total_views["cnt"] if total_views else 0

    # 去重人数
    unique_students = execute_query_one(
        "SELECT COUNT(DISTINCT student_username) as cnt FROM resource_view_logs WHERE resource_type=? AND resource_id=?",
        (resource_type, resource_id),
    )
    unique = unique_students["cnt"] if unique_students else 0

    # 最近查看
    last_view = execute_query_one(
        "SELECT student_username, viewed_at FROM resource_view_logs WHERE resource_type=? AND resource_id=? ORDER BY viewed_at DESC LIMIT 1",
        (resource_type, resource_id),
    )

    return {
        "total_views": total,
        "unique_viewers": unique,
        "last_view": last_view,
    }


# ═══════════════════════════════════════════════════════════
# 全部共享资源浏览统计（一次聚合，替代前端逐资源循环请求）
# ═══════════════════════════════════════════════════════════

@router.get("/tracking/resource-view-stats/all", summary="获取全部共享资源的浏览统计")
async def get_all_resource_view_stats(request: Request):
    """一次性返回共享资源的浏览统计（教师=自己的共享，管理员=全部共享）。

    仅共享给自己（target_users 只有本人且未指定年级/班级）的资源不参与统计，
    包括个人目录自动登记的私有记录——它们不是"共享出来的"资源。
    """
    user = get_current_user(request)
    username = user.get("username", "")
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")

    # 自动清理文件已不存在的脏共享行（重命名/删除后的残留），统计列表不留无效条目
    try:
        from backend.api.sharing_router import purge_dead_share_rows
        purge_dead_share_rows(owner=None if role == 0 else username)
    except Exception:
        pass

    # 排除共享给自己的记录（私有登记 / 仅共享给自己）
    _not_self_only = (
        "NOT (s.share_scope='teacher'"
        " AND COALESCE(s.target_grade,'')=''"
        " AND COALESCE(s.target_class,'')=''"
        " AND s.target_users = s.owner_username)"
    )
    if role == 0:
        where_sql, params = _not_self_only, []
    else:
        where_sql, params = f"s.owner_username=? AND {_not_self_only}", [username]

    try:
        agg_rows = execute_query_dict(
            f"""SELECT s.id AS resource_id, s.resource_type, s.file_name, s.owner_username,
                       COUNT(v.id) AS total_views,
                       COUNT(DISTINCT v.student_username) AS unique_viewers
                FROM shared_resources s
                LEFT JOIN resource_view_logs v
                       ON v.resource_type = s.resource_type AND v.resource_id = s.id
                WHERE {where_sql}
                GROUP BY s.id, s.resource_type, s.file_name, s.owner_username
                ORDER BY total_views DESC, s.id DESC""",
            tuple(params),
        )

        # 每个资源最近一次查看（单条窗口函数查询 + 关联学生姓名）
        last_rows = execute_query_dict(
            """SELECT t.resource_type, t.resource_id, t.student_username,
                      COALESCE(u.name, '') AS student_name, t.viewed_at
               FROM (
                   SELECT resource_type, resource_id, student_username, viewed_at,
                          ROW_NUMBER() OVER (
                              PARTITION BY resource_type, resource_id
                              ORDER BY viewed_at DESC, id DESC
                          ) AS rn
                   FROM resource_view_logs
               ) t
               LEFT JOIN users u ON u.username = t.student_username
               WHERE t.rn = 1""",
        )
    except Exception as e:
        logger.warning(f"聚合资源浏览统计失败: {e}")
        raise HTTPException(status_code=500, detail="统计查询失败")

    last_map = {(r["resource_type"], r["resource_id"]): r for r in last_rows}
    resources = []
    for r in agg_rows:
        last = last_map.get((r["resource_type"], r["resource_id"]))
        resources.append({
            "id": r["resource_id"],
            "resource_name": r["file_name"],
            "resource_type": r["resource_type"],
            "owner": r["owner_username"],
            "total_views": r["total_views"],
            "unique_viewers": r["unique_viewers"],
            "last_view_time": (last["viewed_at"] if last else "") or "",
            "last_view_student": (last["student_name"] or last["student_username"]) if last else "",
        })
    return {"resources": resources, "total": len(resources)}


# ═══════════════════════════════════════════════════════════
# 学生个人资源浏览统计（自己查看自己的）
# ═══════════════════════════════════════════════════════════

@router.get("/tracking/my-view-stats", summary="学生个人资源浏览统计")
async def get_my_view_stats(request: Request):
    """获取当前学生自己的资源浏览统计数据"""
    user = get_current_user(request)
    username = user.get("username", "")
    role = user.get("role", 2)

    if role != 2:
        return {"total_views": 0, "unique_html": 0, "unique_download": 0, "total_reward_points": 0}

    total_row = execute_query_one(
        "SELECT COUNT(*) as cnt FROM resource_view_logs WHERE student_username=?",
        (username,),
    )
    total_views = total_row["cnt"] if total_row else 0

    html_row = execute_query_one(
        "SELECT COUNT(DISTINCT resource_id) as cnt FROM resource_view_logs WHERE student_username=? AND resource_type='html' AND resource_id>0",
        (username,),
    )
    unique_html = html_row["cnt"] if html_row else 0

    dl_row = execute_query_one(
        "SELECT COUNT(DISTINCT resource_id) as cnt FROM resource_view_logs WHERE student_username=? AND resource_type='download' AND resource_id>0",
        (username,),
    )
    unique_download = dl_row["cnt"] if dl_row else 0

    points_row = execute_query_one(
        """SELECT COALESCE(SUM(points), 0) as total
           FROM activity_rewards
           WHERE student_username=? AND activity_type='resource_view'""",
        (username,),
    )
    total_reward_points = points_row["total"] if points_row else 0

    return {
        "total_views": total_views,
        "unique_html": unique_html,
        "unique_download": unique_download,
        "total_reward_points": total_reward_points,
    }


# ═══════════════════════════════════════════════════════════
# 教师端：按知识点维度查看全班统计
# ═══════════════════════════════════════════════════════════

@router.get("/tracking/kp-view-stats/{kp_id}", summary="获取知识点绑定的资源浏览统计")
async def get_kp_view_stats(kp_id: int, request: Request):
    """教师查看指定知识点下所有 HTML/下载资源的浏览统计"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")

    bindings = execute_query_dict(
        """SELECT cb.id as binding_id, cb.resource_type, cb.resource_id,
                  COALESCE(sr.file_name, '') as resource_name
           FROM curriculum_bindings cb
           LEFT JOIN shared_resources sr ON cb.resource_id=sr.id AND cb.resource_type=sr.resource_type
           WHERE cb.knowledge_point_id=? AND cb.resource_type IN ('html', 'download')
           ORDER BY cb.sort_order, cb.id""",
        (kp_id,),
    )

    result = []
    for b in bindings:
        stats = get_resource_view_stats_sync(b["resource_type"], b["resource_id"])
        result.append({
            "binding_id": b["binding_id"],
            "resource_type": b["resource_type"],
            "resource_id": b["resource_id"],
            "resource_name": b["resource_name"] or f"[{b['resource_type']}:{b['resource_id']}]",
            **stats,
        })

    return {"resources": result, "total": len(result)}


def get_resource_view_stats_sync(resource_type: str, resource_id: int) -> dict[str, Any]:
    """同步版本获取资源查看统计"""
    try:
        total = execute_query_one(
            "SELECT COUNT(*) as cnt FROM resource_view_logs WHERE resource_type=? AND resource_id=?",
            (resource_type, resource_id),
        )
        unique = execute_query_one(
            "SELECT COUNT(DISTINCT student_username) as cnt FROM resource_view_logs WHERE resource_type=? AND resource_id=?",
            (resource_type, resource_id),
        )
        last = execute_query_one(
            "SELECT student_username, viewed_at FROM resource_view_logs WHERE resource_type=? AND resource_id=? ORDER BY viewed_at DESC LIMIT 1",
            (resource_type, resource_id),
        )
        return {
            "total_views": total["cnt"] if total else 0,
            "unique_viewers": unique["cnt"] if unique else 0,
            "last_view": last,
        }
    except Exception:
        return {"total_views": 0, "unique_viewers": 0, "last_view": None}


# ═══════════════════════════════════════════════════════════
# 教师端：按班级维度统计资源浏览情况
# ═══════════════════════════════════════════════════════════

@router.get("/tracking/resource-view-students", summary="查看哪些学生看了某个资源")
async def get_resource_view_students(
    request: Request,
    resource_type: str = Query(...),
    resource_id: int = Query(...),
):
    """获取查看过指定资源的学生列表"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")

    rows = execute_query_dict(
        """SELECT rvl.student_username, u.name as student_name,
                  COUNT(*) as view_count, MAX(rvl.viewed_at) as last_viewed
           FROM resource_view_logs rvl
           LEFT JOIN users u ON rvl.student_username = u.username
           WHERE rvl.resource_type=? AND rvl.resource_id=?
           GROUP BY rvl.student_username
           ORDER BY last_viewed DESC""",
        (resource_type, resource_id),
    )

    return {"students": rows, "total": len(rows)}


# ═══════════════════════════════════════════════════════════
# 教师端：按知识点查看学生浏览明细
# ═══════════════════════════════════════════════════════════

@router.get("/tracking/kp-student-views/{kp_id}", summary="获取某个知识点下所有学生的资源浏览明细")
async def get_kp_student_views(kp_id: int, request: Request):
    """获取指定知识点下所有资源被哪些学生查看了"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")

    # 获取该知识点下所有绑定的资源
    bindings = execute_query_dict(
        "SELECT id as binding_id, resource_type, resource_id FROM curriculum_bindings WHERE knowledge_point_id=? AND resource_type IN ('html', 'download')",
        (kp_id,),
    )

    if not bindings:
        return {"students": [], "total": 0}

    # 构建 IN 子句
    conditions = []
    params: list[Any] = []
    for b in bindings:
        conditions.append("(resource_type=? AND resource_id=?)")
        params.extend([b["resource_type"], b["resource_id"]])

    sql = f"""SELECT rvl.student_username, u.name as student_name,
                     rvl.resource_type, rvl.resource_id,
                     rvl.source, rvl.file_path,
                     MIN(rvl.viewed_at) as first_viewed,
                     MAX(rvl.viewed_at) as last_viewed,
                     COUNT(*) as view_count
              FROM resource_view_logs rvl
              LEFT JOIN users u ON rvl.student_username = u.username
              WHERE ({' OR '.join(conditions)})
              GROUP BY rvl.student_username, rvl.resource_type, rvl.resource_id
              ORDER BY last_viewed DESC"""

    rows = execute_query_dict(sql, tuple(params))

    return {"students": rows, "total": len(rows)}


# ═══════════════════════════════════════════════════════════
# 教师端：按班级/年级统计资源浏览情况（仪表盘用）
# ═══════════════════════════════════════════════════════════

@router.get("/tracking/resource-view-dashboard", summary="资源浏览仪表盘数据")
async def get_resource_view_dashboard(
    request: Request,
    grade: str = Query(default=""),
    class_name: str = Query(default=""),
    days: int = Query(default=7, alias="days"),
):
    """获取资源浏览的概要数据，供教师仪表盘使用"""
    user = get_current_user(request)
    role = user.get("role", 2)
    username = user.get("username", "")
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")

    # 时间范围
    from datetime import timedelta
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")

    # 如果是指定年级/班级，先查出该班所有学生
    student_cond = "1=1"
    params: list[Any] = [cutoff]
    if grade and class_name:
        student_cond = "u.grade=? AND u.class=?"
        params.extend([grade, class_name])

    # 老师只能看自己班级的，如果是教师角色，通过 teacher_assignments 过滤
    if role == 1:
        if grade and class_name:
            student_cond += " AND EXISTS (SELECT 1 FROM teacher_assignments ta JOIN grades g ON ta.grade_id=g.id WHERE ta.teacher_username=? AND g.name=? AND (ta.class_id IS NULL OR ta.class_id IN (SELECT id FROM classes WHERE display_name=?)))"
            params.extend([username, grade, class_name])
        else:
            student_cond = "EXISTS (SELECT 1 FROM teacher_assignments ta JOIN grades g ON ta.grade_id=g.id WHERE ta.teacher_username=? AND g.name=u.grade AND (ta.class_id IS NULL OR ta.class_id IN (SELECT id FROM classes c WHERE c.display_name=u.class)))"
            params.append(username)

    sql = f"""SELECT COUNT(DISTINCT rvl.student_username) as active_students,
                     COUNT(*) as total_views,
                     COUNT(DISTINCT rvl.resource_id) as viewed_resources
              FROM resource_view_logs rvl
              JOIN users u ON rvl.student_username = u.username
              WHERE rvl.viewed_at >= ? AND {student_cond}"""

    row = execute_query_one(sql, tuple(params))
    if not row:
        return {"active_students": 0, "total_views": 0, "viewed_resources": 0}

    return {
        "active_students": row["active_students"],
        "total_views": row["total_views"],
        "viewed_resources": row["viewed_resources"],
    }
