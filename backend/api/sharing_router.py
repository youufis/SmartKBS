"""
共享资源 API 路由
管理员/教师共享 HTML 资源和下载文件，可按角色、年级、班级灵活设置共享范围
支持多选教师、多选年级、多选班级
"""
import asyncio
import os
import re
import time
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.auth import ROLE_ADMIN, ROLE_TEACHER, ROLE_STUDENT
from backend.database import execute_query, execute_insert_update, execute_batch
from backend.logger import logger
from backend.api.config_router import get_config_value
from backend.config import STU_DIR, ROOT_DIR, DATA_DIR
from backend.permission_service import check_share_visibility
from backend import resource_registry as rr
from backend import shared_assets

router = APIRouter()


class ShareRequest(BaseModel):
    file_path: str
    file_name: str
    resource_type: str  # 'html' or 'download'
    share_scope: str = "all"  # 'all', 'teacher', 'staff', 'class'
    target_users: list[str] = []
    target_grades: list[str] = []
    target_classes: list[str] = []
    mode: str = "replace"  # 'replace' 覆盖 / 'append' 追加 / 'remove' 移除
    # 2026-10-27：管理员在「共享给我的」里代管同事的共享时，必须用主键点名要改哪一行。
    # 旧实现一律按「当前登录名 + 路径模糊匹配」定位，管理员改别人创建的共享必然匹配不到 -> 404。
    share_id: int | None = None



def _list_to_csv(items: list[str]) -> str:
    """将列表转为逗号分隔字符串"""
    return ",".join(items)


def _uniq_keep_order(items) -> list[str]:
    """去重、去空白，保持首次出现顺序"""
    return [x for x in dict.fromkeys(str(i).strip() for i in items) if x]


_grade_rank_cache: dict[str, int] | None = None


def _grade_rank() -> dict[str, int]:
    """年级名称 -> 排序权重（grades.id：一年级…高三 的自然顺序）；读不到就退回按名称排。"""
    global _grade_rank_cache
    if _grade_rank_cache is None:
        try:
            _grade_rank_cache = {str(r[0]): int(r[1]) for r in execute_query("SELECT name, id FROM grades")}
        except Exception as e:
            logger.warning(f"读取年级顺序失败，年级改按名称排序: {e}")
            _grade_rank_cache = {}
    return _grade_rank_cache


def _normalize_grades(items) -> list[str]:
    """年级去重 + 固定排序。

    历史上「高一,高二」与「高二,高一」两种写法并存（取决于点击顺序），同一份共享在卡片上
    和在共享弹窗里会显示成两个不一样的范围。
    """
    rank = _grade_rank()
    return sorted(_uniq_keep_order(items), key=lambda g: (rank.get(g, 9999), g))


def _normalize_classes(items) -> list[str]:
    """班级去重 + 按「年级顺序 -> 班号数字」排序（高一2班 排在 高一10班 前面）。"""
    rank = _grade_rank()

    def key(c: str):
        g = next((name for name in rank if c.startswith(name)), "")
        m = re.search(r"(\d+)", c)
        return (rank.get(g, 9999), int(m.group(1)) if m else 9999, c)

    return sorted(_uniq_keep_order(items), key=key)


def _share_physical_path(row_owner: str, file_path: str, resource_type: str) -> str:
    """共享行里的路径 -> 相对项目根的物理路径（判断两行是不是同一个文件的唯一口径）。

    入库形态混着 `x.html` / `html/x.html` / `<owner>/html/x.html` / `stu/<owner>/html/x.html`，
    再共享还会出现「行 owner=root、路径却是 youufis/html/x.html」这种 owner 与文件属主不一致的行，
    所以必须看这段路径自己是否已带 <谁>/html/ 前缀，不能一律再拼一遍 owner。
    """
    _dir = "html" if resource_type == "html" else "downloads"
    p = str(file_path or "").replace("\\", "/").strip().lstrip("/")
    if not p:
        return f"{row_owner}/{_dir}/"
    if p.startswith(f"{STU_DIR}/"):
        return p
    if p.startswith(f"{_dir}/"):
        return f"{row_owner}/{p}"
    if f"/{_dir}/" in f"/{p}":       # 已带 <某账号>/html|downloads/ 前缀 -> 本身就是物理路径
        return p
    return f"{row_owner}/{_dir}/{p}"


def _teacher_allowed_grades(username: str) -> list[str]:
    """教师的任教年级名称列表。
    优先取 teacher_assignments（任教关系，权威数据），
    回退到 users.grade 字段（兼容 '高一|高二' / '高一,高二' 等多年级写法）。"""
    grades: list[str] = []
    try:
        from backend.permission_service import get_teacher_grades
        grades = [g["name"] for g in get_teacher_grades(username) if g.get("name")]
    except Exception as e:
        logger.warning(f"读取教师任教年级失败 ({username}): {e}")
    if not grades:
        rows = execute_query("SELECT grade FROM users WHERE username=?", (username,))
        if rows:
            raw = (rows[0][0] or "").replace("|", ",")
            grades = [g.strip() for g in raw.split(",") if g.strip()]
    result: list[str] = []
    for g in grades:
        if g not in result:
            result.append(g)
    return result


def _build_url_path(owner: str, resource_type: str, file_path: str) -> str:
    """构建完整的 /api/files/ 访问路径（相对于 BASE_DIR）。

    2026-10-27：再共享会产生 owner≠文件属主的行（owner=root、path=youufis/html/x.html），
    旧实现无条件再拼一次 owner 前缀 -> url_path 变成 root/html/youufis/html/x.html，点开 404。
    """
    return _share_physical_path(owner, file_path, resource_type)


# ── 目录型共享：条目类型与内容统计（「共享文件」浏览器要区分目录/文件两种条目）──

_DIR_STATS_TTL = 60.0      # 秒。目录内容不需要实时，避免每次 /received 都全量扫盘
_DIR_STATS_MAX = 2000      # 单次最多统计的文件数，防止超大目录把接口拖慢
_dir_stats_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def is_dir_share_path(file_path: str) -> bool:
    """按共享记录里的路径判断是不是「目录型共享」（一个共享指向整个文件夹）

    目录共享入库形态是 "pics/" 或 "pics"（末段没有扩展名），文件共享必然带扩展名。
    与 cleanup_empty_dir_shares 用同一套判定，避免两处各猜一遍。
    """
    p = str(file_path or "").replace("\\", "/").strip()
    if not p:
        return False
    if p.endswith("/"):
        return True
    last = p.rstrip("/").split("/")[-1]
    return "." not in last


def download_share_stats(owner: str, file_path: str, res_type: str = "download") -> dict[str, Any]:
    """共享文件条目的展示数据：是不是目录、里面几个文件、总共多大（进程内 60 秒缓存）

    只对 download 类型扫盘：目录走有界递归，单文件只做一次 stat。
    """
    if res_type != "download":
        return {"is_dir": False, "file_count": 0, "total_size": 0}
    looks_dir = is_dir_share_path(file_path)
    info: dict[str, Any] = {"is_dir": looks_dir, "file_count": 0, "total_size": 0}

    rel = str(file_path or "").replace("\\", "/").strip("/")
    _pfx = f"{owner}/downloads/"
    if rel.startswith(_pfx):          # 容忍入库时已带 owner/downloads 前缀的历史写法
        rel = rel[len(_pfx):]
    key = f"{owner}|{rel}"
    now = time.time()
    cached = _dir_stats_cache.get(key)
    if cached and now - cached[0] < _DIR_STATS_TTL:
        return cached[1]

    file_count = 0
    total_size = 0
    try:
        from backend.api.downloads_router import _get_user_downloads_dir
        target = os.path.join(_get_user_downloads_dir(owner), *rel.split("/")) if rel else ""
        if target and looks_dir and os.path.isdir(target):
            for dirpath, _dirnames, filenames in os.walk(target):
                for fn in filenames:
                    file_count += 1
                    try:
                        total_size += os.path.getsize(os.path.join(dirpath, fn))
                    except OSError:
                        pass
                    if file_count >= _DIR_STATS_MAX:
                        break
                if file_count >= _DIR_STATS_MAX:
                    break
        elif target and not looks_dir and os.path.isfile(target):
            file_count = 1
            try:
                total_size = os.path.getsize(target)
            except OSError:
                total_size = 0
    except Exception as e:
        logger.debug(f"[sharing] 共享文件统计失败 {owner}/{rel}: {e}")

    info.update({"file_count": file_count, "total_size": total_size})
    _dir_stats_cache[key] = (now, info)
    if len(_dir_stats_cache) > 512:   # 简单回收，别让缓存在长驻进程里无上限增长
        for k in [k for k, v in _dir_stats_cache.items() if now - v[0] > _DIR_STATS_TTL * 10]:
            _dir_stats_cache.pop(k, None)
    return info


def cleanup_empty_dir_shares(owner_username: str | None = None):
    """清理不存在的空目录的共享记录

    目录共享是指共享目录下的所有文件。如果目录不存在或为空，
    则该共享记录无意义，应自动清除。

    如果指定 owner_username，只清理该用户的记录。
    """
    dir_name_map = {"download": "downloads", "html": "html"}
    try:
        cond = "WHERE resource_type='download'"
        params = []
        if owner_username:
            cond += " AND owner_username=?"
            params.append(owner_username)

        rows = execute_query(
            f"SELECT id, owner_username, file_path, resource_type FROM shared_resources {cond}",
            tuple(params),
        )
        removed = 0
        for rid, owner, file_path, res_type in rows:
            # 判断是否为目录共享：与 is_dir_share_path 同一口径
            if not is_dir_share_path(file_path):
                continue
            dir_name = dir_name_map.get(res_type, "downloads")
            clean_path = file_path.strip("/")
            # 容忍已带 owner/目录 前缀的路径
            _pfx = f"{owner}/{dir_name}/"
            if clean_path.startswith(_pfx):
                clean_path = clean_path[len(_pfx):]
            full_dir = os.path.join(str(DATA_DIR), owner, dir_name, clean_path)
            if not os.path.isdir(full_dir) or not os.listdir(full_dir):
                # 清理关联的课程绑定
                try:
                    execute_insert_update(
                        "DELETE FROM curriculum_bindings WHERE resource_type=? AND resource_id=?",
                        (res_type, rid),
                    )
                except Exception:
                    pass
                execute_insert_update("DELETE FROM shared_resources WHERE id=?", (rid,))
                removed += 1
                logger.info(f"自动清理空目录共享: id={rid}, owner={owner}, path={file_path}")
        if removed:
            logger.info(f"共清理 {removed} 条空目录共享记录")
            shared_assets.invalidate_cache()   # 共享清单变了，依赖放行判定需立即重算
    except Exception as e:
        logger.warning(f"清理空目录共享时出错: {e}")


_VALID_SCOPES = {"all", "teacher", "staff", "class"}


def _canon_rel_path(path: str, username: str, dir_name: str) -> str:
    """把各种历史存储格式归一成"账号内相对路径"，用于判断两行是不是同一个文件。

    出现过的格式：`x.html` / `html/x.html` / `<owner>/html/x.html` / `stu/<owner>/html/x.html`，
    目录共享还会带子目录。归一只剥前缀，不去掉子目录 —— 子目录正是区分同名文件的关键。
    """
    p = str(path or "").replace("\\", "/").strip().lstrip("/")
    for prefix in (f"stu/{username}/{dir_name}/", f"{username}/{dir_name}/", f"{dir_name}/"):
        if p.startswith(prefix):
            return p[len(prefix):]
    return p


def _find_share_rows_multi_format(username: str, resource_type: str, file_path: str):
    """多格式匹配同一资源的现有共享行（全路径/裸文件名/owner前缀等存储格式混用），
    按 id 升序返回 (id, target_users, target_grade, target_class, share_scope, file_path)。

    ⚠️ 匹配分两级（2026-10-11 修）：
      ① **能唯一对上就用唯一的那几行** —— 归一后相对路径完全相等；
      ② 一行都精确对不上（老客户端只传裸文件名）才回落到宽松匹配。
    旧实现直接拿宽松结果去 UPDATE + 合并去重：`html/班级A/课件.html` 与 `html/班级B/课件.html`
    同名不同目录，会被当成"同一个资源"合并，**并把前者的课程绑定改指到后者** ——
    表现就是"改了共享范围后绑定显示残留、必须删掉重绑"。
    """
    _dir = "html" if resource_type == "html" else "downloads"
    clean_fp = str(file_path).replace("\\", "/").rstrip("/")
    bn = clean_fp.split("/")[-1]
    prefixed = clean_fp if clean_fp.startswith(f"{username}/{_dir}/") else f"{username}/{_dir}/{clean_fp}"
    rows = execute_query(
        """SELECT id, target_users, target_grade, target_class, share_scope, file_path
           FROM shared_resources
           WHERE owner_username=? AND resource_type=?
           AND (file_path=? OR file_path=? OR file_path=?
                OR file_path LIKE ? OR file_path LIKE ?)
           ORDER BY id""",
        (username, resource_type, file_path, clean_fp, prefixed, f"%/{bn}", f"%/{clean_fp}"),
    )
    if not rows:
        return rows
    want = _canon_rel_path(clean_fp or file_path, username, _dir)
    exact = [r for r in rows if _canon_rel_path(r[5], username, _dir) == want]
    if exact and len(exact) != len(rows):
        logger.info(f"[共享] 同名不同目录的文件不再合并：精确命中 {len(exact)} 行，"
                    f"宽松匹配到 {len(rows)} 行（path={clean_fp!r}）")
    return exact or rows


def _drop_share_row(rid: int, resource_type: str):
    """删除共享行并同步清理关联绑定/练习成绩/浏览日志（与取消共享行为一致）"""
    try:
        kp_rows = execute_query(
            "SELECT knowledge_point_id FROM curriculum_bindings WHERE resource_type=? AND resource_id=?",
            (resource_type, rid),
        )
        execute_insert_update(
            "DELETE FROM curriculum_bindings WHERE resource_type=? AND resource_id=?",
            (resource_type, rid),
        )
        if resource_type == "html" and kp_rows:
            from backend.question_db import execute_insert as q_del
            for (kpid,) in kp_rows:
                q_del("DELETE FROM ai_practice_results WHERE kp_id=?", (kpid,))
        # 按资源口径删：resource_id 即 shared_resources.id(跨类型唯一)，
        # 顺带收掉历史上被误标成另一种 resource_type 的浏览行
        execute_insert_update(
            "DELETE FROM resource_view_logs WHERE resource_id=?",
            (rid,),
        )
        execute_insert_update("DELETE FROM shared_resources WHERE id=?", (rid,))
        shared_assets.invalidate_cache()
    except Exception as e:
        logger.warning(f"删除共享行 {rid} 失败: {e}")


def _merge_share_row(old_id: int, keep_id: int, resource_type: str):
    """把重复残留共享行并入保留行：转移课程绑定（去重）、迁移浏览日志，然后删除旧行"""
    try:
        execute_insert_update(
            """DELETE FROM curriculum_bindings
               WHERE resource_type=? AND resource_id=?
               AND knowledge_point_id IN (
                   SELECT knowledge_point_id FROM curriculum_bindings
                   WHERE resource_type=? AND resource_id=?)""",
            (resource_type, old_id, resource_type, keep_id),
        )
        execute_insert_update(
            "UPDATE curriculum_bindings SET resource_id=? WHERE resource_type=? AND resource_id=?",
            (keep_id, resource_type, old_id),
        )
        execute_insert_update(
            "UPDATE resource_view_logs SET resource_id=? WHERE resource_type=? AND resource_id=?",
            (keep_id, resource_type, old_id),
        )
        execute_insert_update("DELETE FROM shared_resources WHERE id=?", (old_id,))
        shared_assets.invalidate_cache()
        logger.info(f"合并重复共享行: {old_id} -> {keep_id} ({resource_type})")
    except Exception as e:
        logger.warning(f"合并重复共享行 {old_id}->{keep_id} 失败: {e}")


# ── 创建共享 ──

@router.post("/share")
async def share_resource(request: Request, body: ShareRequest):
    """共享一个资源，支持多选教师、多选年级/班级"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)   # JWT 缺字段时不应 500

    if role not in (ROLE_ADMIN, ROLE_TEACHER):
        raise HTTPException(status_code=403, detail="仅管理员和教师可以共享资源")

    if body.resource_type not in ("html", "download"):
        raise HTTPException(status_code=400, detail="resource_type 必须是 html 或 download")

    if body.share_scope not in _VALID_SCOPES:
        raise HTTPException(status_code=400, detail=f"无效的共享范围: {body.share_scope}")

    if body.mode not in ("replace", "append", "remove"):
        raise HTTPException(status_code=400, detail=f"无效的操作模式: {body.mode}，必须为 replace/append/remove")

    # 参数完整性校验
    if body.share_scope == "class" and not body.target_grades:
        raise HTTPException(status_code=400, detail="指定年级/班级时必须至少选择一个年级")
    if body.share_scope == "teacher" and not body.target_users:
        raise HTTPException(status_code=400, detail="指定教师时必须至少选择一个用户")

    # 权限校验
    if role == ROLE_TEACHER:
        if body.share_scope == "all":
            raise HTTPException(status_code=403, detail="教师不能选择「所有人」范围")
        if body.share_scope == "class" and body.target_grades:
            allowed_grades = _teacher_allowed_grades(username)
            for g in body.target_grades:
                if g not in allowed_grades:
                    raise HTTPException(
                        status_code=403,
                        detail="教师只能共享给自己任教的年级（可共享年级："
                        + ("、".join(allowed_grades) or "无，请先在用户管理中配置任教年级") + "）",
                    )

    # 将数组转为逗号分隔字符串存储
    target_users_csv = _list_to_csv(sorted(set(_uniq_keep_order(body.target_users))))
    target_grades_csv = _list_to_csv(_normalize_grades(body.target_grades))
    target_classes_csv = _list_to_csv(_normalize_classes(body.target_classes))

    # 如果是教师 scope='class' 但未指定，自动填充教师任教的年级/班级
    if role == ROLE_TEACHER and body.share_scope == 'class' and not target_grades_csv and not target_classes_csv:
        try:
            from backend.permission_service import get_teacher_assignments
            tas = get_teacher_assignments(username)
        except Exception:
            tas = []
        if tas:
            grades = list(dict.fromkeys(t["grade_name"] for t in tas if t.get("grade_name")))
            target_grades_csv = _list_to_csv(_normalize_grades(grades))
            classes = list(dict.fromkeys(t["class_display_name"] for t in tas if t.get("class_display_name")))
            target_classes_csv = _list_to_csv(_normalize_classes(classes))
        else:
            target_grades_csv = _list_to_csv(_normalize_grades(_teacher_allowed_grades(username)))

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # 现有共享行（多格式匹配）：命中则原行 UPDATE 保持 id 稳定，避免重新共享"换 id"导致课程绑定悬挂
    # 给了 share_id 就按主键点名（管理员代管同事的共享走这条路），否则沿用旧口径。
    if body.share_id:
        _row = execute_query(
            "SELECT owner_username, file_path, resource_type FROM shared_resources WHERE id=?",
            (body.share_id,),
        )
        if not _row:
            raise HTTPException(status_code=404, detail="共享记录不存在或已被取消，请刷新后重试")
        target_owner = _row[0][0] or ""
        if (_row[0][2] or "") != body.resource_type:
            raise HTTPException(status_code=400, detail="共享记录的资源类型与请求不一致，请刷新后重试")
        if target_owner != username and role != ROLE_ADMIN:
            raise HTTPException(status_code=403, detail="无权修改他人创建的共享记录")
        share_rows_all = _find_share_rows_multi_format(
            target_owner, body.resource_type, _row[0][1] or body.file_path)
    else:
        target_owner = username
        share_rows_all = _find_share_rows_multi_format(username, body.resource_type, body.file_path)

    try:
        if body.mode == "append":
            # 追加模式：合并现有目标
            existing = share_rows_all
            if existing:
                exist_users = existing[0][1] or ""
                exist_grades = existing[0][2] or ""
                exist_classes = existing[0][3] or ""
                exist_scope = existing[0][4]

                # 合并目标用户
                merged_users = set(exist_users.split(",")) if exist_users else set()
                merged_users.update(body.target_users)
                merged_users.discard("")
                target_users_csv = _list_to_csv(sorted(merged_users))

                # 合并年级
                merged_grades = set(exist_grades.split(",")) if exist_grades else set()
                merged_grades.update(body.target_grades)
                merged_grades.discard("")
                target_grades_csv = _list_to_csv(_normalize_grades(merged_grades))

                # 合并班级
                merged_classes = set(exist_classes.split(",")) if exist_classes else set()
                merged_classes.update(body.target_classes)
                merged_classes.discard("")
                target_classes_csv = _list_to_csv(_normalize_classes(merged_classes))

                # 保留原来的 scope（追加不改变 scope）
                actual_scope = exist_scope
            else:
                actual_scope = body.share_scope
        elif body.mode == "remove":
            # 移除模式：从现有目标中移除指定项
            existing = share_rows_all
            if not existing:
                raise HTTPException(
                    status_code=404, detail="未找到要修改的共享记录（可能已被取消），请刷新后重试")

            exist_users = set(existing[0][1].split(",")) if existing[0][1] else set()
            exist_grades = set(existing[0][2].split(",")) if existing[0][2] else set()
            exist_classes = set(existing[0][3].split(",")) if existing[0][3] else set()
            actual_scope = existing[0][4]

            remove_users_set = set(body.target_users)
            remove_grades_set = set(body.target_grades)
            remove_classes_set = set(body.target_classes)

            merged_users = exist_users - remove_users_set
            merged_grades = exist_grades - remove_grades_set
            merged_classes = exist_classes - remove_classes_set

            merged_users.discard("")
            merged_grades.discard("")
            merged_classes.discard("")

            target_users_csv = _list_to_csv(sorted(merged_users))
            target_grades_csv = _list_to_csv(_normalize_grades(merged_grades))
            target_classes_csv = _list_to_csv(_normalize_classes(merged_classes))

            # 如果所有目标都被移除了，自动删除共享记录
            if not merged_users and not merged_grades and not merged_classes:
                for _r in share_rows_all:
                    _drop_share_row(_r[0], body.resource_type)
                logger.info(f"共享所有目标已移除，自动删除共享: {username} -> {body.file_path} ({len(share_rows_all)}行)")
                return {"message": "共享目标已全部移除，共享已取消", "file_path": body.file_path}
        else:
            # replace 模式（默认）：直接覆盖
            actual_scope = body.share_scope

        if share_rows_all:
            # 优先保留已被绑定引用的 id，否则取最小 id 为主行；其余重复格式行并入主行
            _ids = [r[0] for r in share_rows_all]
            _ph = ",".join(["?"] * len(_ids))
            _bound = execute_query(
                f"SELECT resource_id FROM curriculum_bindings WHERE resource_type=? AND resource_id IN ({_ph}) ORDER BY id",
                (body.resource_type, *_ids),
            )
            # 绑定表的 resource_id 已迁为 TEXT，这里统一转回 int 再用作 shared_resources 主键
            primary_id = int(_bound[0][0]) if _bound else _ids[0]
            execute_insert_update(
                """UPDATE shared_resources SET file_path=?, file_name=?, share_scope=?,
                          target_users=?, target_grade=?, target_class=?, updated_at=?
                   WHERE id=?""",
                (body.file_path, body.file_name, actual_scope,
                 target_users_csv, target_grades_csv, target_classes_csv, now, primary_id),
            )
            for _r in share_rows_all:
                if _r[0] != primary_id:
                    _merge_share_row(_r[0], primary_id, body.resource_type)
            logger.info(f"共享更新成功(保持id): {target_owner} -> {body.file_path} "
                        f"(by={username}, scope={actual_scope}, id={primary_id})")
        else:
            execute_insert_update(
                """INSERT INTO shared_resources
                   (owner_username, file_path, file_name, resource_type, share_scope,
                    target_users, target_grade, target_class, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (username, body.file_path, body.file_name, body.resource_type,
                 actual_scope, target_users_csv, target_grades_csv, target_classes_csv, now, now),
            )
            logger.info(f"共享创建成功: {username} -> {body.file_path} (scope={actual_scope})")

        # 共享范围变化会改变"哪些页面可以把依赖素材带出来"，清掉判定缓存使其即时生效
        shared_assets.invalidate_cache()

        # 共享后清理空目录共享记录（如果共享的是空目录，会自动删除）
        cleanup_empty_dir_shares(username)

        # ── 后台批量发送通知（仅 replace/新建时发送，追加/移除模式跳过） ──
        # 管理员代管同事的共享（target_owner != 本人）不群发通知：改的是别人的资源，
        # 以学生收到的「root 分享了…」推送只会造成困扰。
        if body.mode not in ("append", "remove") and target_owner == username:
            def _send_notifications_sync():
                """同步执行通知发送，在后台线程中运行"""
                try:
                    # 检查分享通知类型是否启用
                    enabled = set(get_config_value("enabled_notification_types", ["exam"]))
                    if "share" not in enabled:
                        return
                    resource_label = "HTML 资源" if body.resource_type == "html" else "下载文件"
                    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

                    # 确定收件人列表
                    recipients: list[str] = []
                    link = "/html-files" if body.resource_type == "html" else "/downloads"
                    title = f"新的{resource_label}已分享"
                    content = ""
                    if body.share_scope == "all":
                        rows = execute_query("SELECT username FROM users WHERE role IN (0, 1, 2)")
                        recipients = [r[0] for r in rows]
                        content = f"{username} 分享了「{body.file_name}」"
                    elif body.share_scope == "staff":
                        rows = execute_query("SELECT username FROM users WHERE role IN (0, 1)")
                        recipients = [r[0] for r in rows]
                        content = f"{username} 分享了「{body.file_name}」（教师共享）"
                    elif body.share_scope == "teacher" and body.target_users:
                        recipients = body.target_users
                        content = f"{username} 分享了「{body.file_name}」给您"
                    elif body.share_scope == "class":
                        # 通知目标年级/班级的学生（使用 class_id + classes.display_name 匹配）
                        _student_params: list[str] = []
                        if body.target_grades:
                            ph = ",".join(["?"] * len(body.target_grades))
                            grade_cond = f"u.grade IN ({ph})"
                            _student_params.extend(body.target_grades)
                        else:
                            grade_cond = "1=1"
                        class_cond = "1=1"
                        if body.target_classes:
                            ph = ",".join(["?"] * len(body.target_classes))
                            class_cond = (
                                f"(u.class_id IN (SELECT id FROM classes WHERE display_name IN ({ph}))"
                                f" OR u.class IN ({ph}))"
                            )
                            _student_params.extend(body.target_classes * 2)
                        if _student_params:
                            rows = execute_query(
                                f"""SELECT u.username FROM users u
                                    WHERE u.role=2 AND {grade_cond} AND {class_cond}""",
                                tuple(_student_params),
                            )
                            recipients = [r[0] for r in rows]
                        # 也通知任教这些年级/班级的教师和管理员（使用 class_id 匹配）
                        _t_params: list[str] = []
                        if body.target_grades:
                            ph = ",".join(["?"] * len(body.target_grades))
                            t_grade_cond = f"u.grade IN ({ph})"
                            _t_params.extend(body.target_grades)
                        else:
                            t_grade_cond = "1=1"
                        t_class_cond = "1=1"
                        if body.target_classes:
                            ph = ",".join(["?"] * len(body.target_classes))
                            t_class_cond = (
                                f"(u.class_id IN (SELECT id FROM classes WHERE display_name IN ({ph}))"
                                f" OR u.class IN ({ph}))"
                            )
                            _t_params.extend(body.target_classes * 2)
                        if _t_params:
                            t_rows = execute_query(
                                f"""SELECT u.username FROM users u
                                    WHERE u.role IN (0,1) AND {t_grade_cond} AND {t_class_cond}""",
                                tuple(_t_params),
                            )
                            for tr in t_rows:
                                if tr[0] not in recipients:
                                    recipients.append(tr[0])
                        content = f"「{body.file_name}」可供您所在班级使用"

                    # 批量插入通知
                    if recipients:
                        sql = """INSERT INTO notifications
                                 (recipient_username, type, title, content, related_link, is_read, created_at)
                                 VALUES (?, 'share', ?, ?, ?, 0, ?)"""
                        ops = [(sql, (r, title, content, link, now)) for r in recipients]
                        execute_batch(ops)
                        logger.info(f"已发送 {len(recipients)} 条共享通知")
                except Exception as notify_err:
                    logger.warning(f"发送共享通知失败: {notify_err}")

            # 在线程池中运行，不阻塞事件循环
            loop = asyncio.get_event_loop()
            loop.run_in_executor(None, _send_notifications_sync)

        return {"message": "共享成功", "file_path": body.file_path}
    except HTTPException:
        # 参数/权限/记录不存在这类明确错误原样返回。旧实现连 HTTPException 一起吞进
        # 下面的通用分支，前端只看到被降级成 500 的「共享失败: 404: 未找到现有共享记录…」
        raise
    except Exception as e:
        logger.error(f"共享创建失败: {e}")
        raise HTTPException(status_code=500, detail=f"共享失败: {str(e)}")


# ── 修复悬挂/无效的残留资源绑定（启动自动执行，也可手动触发） ──

def purge_dead_share_rows(owner: str | None = None, resource_ids: list | None = None,
                          resource_type: str | None = None) -> list[dict]:
    """检测并删除文件/目录已不存在的脏共享行（重命名、外部删除后的残留），
    联动清理其课程绑定/查看日志/练习成绩。返回被清理明细，幂等可重复调用。
    触发点：服务启动、打开绑定候选列表、知识点绑定列表（师生）、活动监控统计列表、repair 接口。"""
    sql = "SELECT id, owner_username, resource_type, file_path FROM shared_resources WHERE 1=1"
    params: list = []
    if owner:
        sql += " AND owner_username=?"
        params.append(owner)
    if resource_type:
        sql += " AND resource_type=?"
        params.append(resource_type)
    if resource_ids:
        _ids = [int(i) for i in resource_ids]
        sql += f" AND id IN ({','.join(['?'] * len(_ids))})"
        params.extend(_ids)
    sql += " ORDER BY id"
    stale: list[dict] = []
    for (sid, sowner, stype, sfp) in execute_query(sql, tuple(params)):
        fp = str(sfp or "").replace("\\", "/")
        dir_name = "html" if stype == "html" else "downloads"
        last = fp.rstrip("/").split("/")[-1]
        is_dir = is_dir_share_path(fp)
        if is_dir:
            rel = fp[len(f"{sowner}/{dir_name}/"):] if fp.startswith(f"{sowner}/{dir_name}/") else fp
            full_dir = os.path.join(str(DATA_DIR), sowner, dir_name, rel.rstrip("/"))
            ok = os.path.isdir(full_dir) and bool(os.listdir(full_dir))
        else:
            cands = {fp.lstrip("/"), f"{sowner}/{dir_name}/{fp.lstrip('/')}", f"stu/{sowner}/{dir_name}/{fp.lstrip('/')}"}
            cands |= {f"{sowner}/{dir_name}/{last}", f"stu/{sowner}/{dir_name}/{last}"}
            ok = any(os.path.exists(os.path.join(str(DATA_DIR), c)) for c in cands)
        if not ok:
            stale.append({"id": sid, "owner": sowner, "resource_type": stype, "file_path": fp})
            _drop_share_row(sid, stype)
    if stale:
        logger.info(f"[资源记录自动清理] 文件已不存在的脏共享行 {len(stale)} 条 (owner={owner or 'ALL'}, type={resource_type or 'ALL'})")
    return stale


def run_bind_repair(by_user: str = "system") -> dict:
    """清理两类资源绑定残留，幂等可重复调用：
    1) 悬挂绑定：curriculum_bindings 指向的共享行 id 已不存在（旧版重新共享换 id 造成）；
    2) 脏共享行：shared_resources 的 file_path 指向的文件/目录已不存在
       （重命名/外部删除后的残留，列表显示旧名且点开 404），删除行并联动清理绑定/日志/成绩。
    服务启动时自动执行一次；也可 POST /api/sharing/repair-bindings 手动触发。"""
    # 1) 悬挂绑定
    rows = execute_query(
        """SELECT cb.id, cb.knowledge_point_id, cb.resource_type, cb.resource_id
           FROM curriculum_bindings cb
           LEFT JOIN shared_resources sr
                  ON cb.resource_type=sr.resource_type AND cb.resource_id=sr.id
           WHERE cb.resource_type IN ('html','download') AND sr.id IS NULL
           ORDER BY cb.id""",
    )
    details = []
    for (bid, kpid, rtype, rid) in rows:
        execute_insert_update("DELETE FROM curriculum_bindings WHERE id=?", (bid,))
        if rtype == "html":
            try:
                from backend.question_db import execute_insert as q_del
                q_del("DELETE FROM ai_practice_results WHERE kp_id=?", (kpid,))
            except Exception:
                pass
        details.append({"binding_id": bid, "knowledge_point_id": kpid,
                        "resource_type": rtype, "stale_resource_id": rid})

    # 2) 脏共享行（文件/目录已不存在）
    stale_shares = purge_dead_share_rows()

    if details or stale_shares:
        logger.info(f"[资源绑定修复] 悬挂绑定 {len(details)} 条 + 脏共享行 {len(stale_shares)} 条 (by {by_user})")
    return {"removed": len(details), "details": details,
            "removed_shares": len(stale_shares), "stale_share_rows": stale_shares}


@router.post("/repair-bindings", summary="清理悬挂/无效的资源绑定残留")
async def repair_dangling_bindings(request: Request):
    """手动触发资源绑定残留修复（教师/管理员）。服务启动时也会自动执行。"""
    user = get_current_user(request)
    if user["role"] not in (ROLE_ADMIN, ROLE_TEACHER):
        raise HTTPException(status_code=403, detail="权限不足")
    return run_bind_repair(by_user=user["username"])



# ── 取消共享 ──

@router.delete("/share")
async def unshare_resource(request: Request, id: int = Query(...)):
    """取消共享（含通知）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)   # JWT 缺字段时不应 500

    # 在删除前查出完整的共享信息（用于后续通知）
    rows = execute_query(
        """SELECT owner_username, file_path, file_name, resource_type,
                  share_scope, target_users, target_grade, target_class
           FROM shared_resources WHERE id=?""",
        (id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="共享记录不存在")

    (owner, file_path, file_name, resource_type,
     share_scope, target_users_csv, target_grade_csv, target_class_csv) = rows[0]

    if username != owner and role != ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="无权取消此共享")

    try:
        execute_insert_update(
            "DELETE FROM shared_resources WHERE id=?",
            (id,),
        )
        logger.info(f"共享已取消: id={id}, by={username}")
        shared_assets.invalidate_cache()

        # 清理关联的课程绑定
        try:
            bind_rows = execute_query(
                "SELECT knowledge_point_id FROM curriculum_bindings WHERE resource_type=? AND resource_id=?",
                (resource_type, id),
            )
            if bind_rows:
                # 仅 HTML 资源（练习）需要清理学生作答记录
                if resource_type == "html":
                    kp_ids = [r["knowledge_point_id"] for r in bind_rows]
                    from backend.question_db import execute_insert as q_del
                    for kpid in kp_ids:
                        q_del("DELETE FROM ai_practice_results WHERE kp_id=?", (kpid,))
                # 清理绑定记录
                execute_insert_update(
                    "DELETE FROM curriculum_bindings WHERE resource_type=? AND resource_id=?",
                    (resource_type, id),
                )
                logger.info(f"已清理 {resource_type} 资源 id={id} 关联的 {len(bind_rows)} 个课程绑定")
        except Exception as e2:
            logger.warning(f"清理关联记录时出错: {e2}")

        # 清理查看日志 + 积分 + 通知
        try:
            # 同上：不按 resource_type 过滤，避免误标行漏删
            execute_insert_update(
                "DELETE FROM resource_view_logs WHERE resource_id=?",
                (id,),
            )
            logger.info(f"已清理 resource_view_logs: id={id}")
        except Exception as e3:
            logger.warning(f"清理资源查看日志失败: {e3}")
        try:
            from backend.reward_engine import activity_reward_students, recompute_students
            # 受影响名单必须在删除流水之前取，重算必须在这之后
            _affected = activity_reward_students([("share", id)])
            execute_insert_update(
                "DELETE FROM activity_rewards WHERE activity_type='share' AND activity_id=?",
                (str(id),),
            )
            execute_insert_update(
                "DELETE FROM notifications WHERE source_type='share' AND source_id=?",
                (str(id),),
            )
            recompute_students(_affected)      # 缺陷A：删流水必须就地重算总分
        except Exception as e4:
            # 原来这里是 except Exception: pass —— 有一次把 recompute_students 误写进
            # execute_insert_update 的参数列表里，TypeError 被静默吞掉，导致取消共享
            # 既不清通知也不重算总分，长期无人察觉。回收失败必须留痕。
            logger.warning(f"取消共享时清理积分/通知失败 (share id={id}): {e4}")

        # 取消共享后清理空目录共享
        cleanup_empty_dir_shares(owner)

        # ── 后台发送取消通知（不阻塞取消操作） ──
        loop = asyncio.get_event_loop()
        loop.run_in_executor(None, _notify_unshare_sync,
            owner, file_name, resource_type,
            share_scope, target_users_csv,
            target_grade_csv, target_class_csv)

        return {"message": "共享已取消"}
    except Exception as e:
        logger.error(f"取消共享失败: {e}")
        raise HTTPException(status_code=500, detail=f"取消共享失败: {str(e)}")


def _notify_unshare_sync(owner: str, file_name: str, resource_type: str,
                          share_scope: str, target_users_csv: str,
                          target_grade_csv: str, target_class_csv: str):
    """同步发送取消共享通知，在后台线程中运行"""
    try:
        enabled = set(get_config_value("enabled_notification_types", ["exam"]))
        if "share" not in enabled:
            return
        resource_label = "HTML 资源" if resource_type == "html" else "下载文件"
        link = "/html-files" if resource_type == "html" else "/downloads"
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        target_users = [u for u in target_users_csv.split(",") if u] if target_users_csv else []
        target_grades = [g for g in target_grade_csv.split(",") if g] if target_grade_csv else []
        target_classes = [c for c in target_class_csv.split(",") if c] if target_class_csv else []

        recipients: list[str] = []
        title = f"{resource_label}共享已取消"
        content = ""
        if share_scope == "all":
            rows = execute_query("SELECT username FROM users WHERE role IN (0, 1, 2)")
            recipients = [r[0] for r in rows]
            content = f"{owner} 已取消对「{file_name}」的共享"
        elif share_scope == "staff":
            rows = execute_query("SELECT username FROM users WHERE role IN (0, 1)")
            recipients = [r[0] for r in rows]
            content = f"{owner} 已取消对「{file_name}」的共享（教师共享）"
        elif share_scope == "teacher" and target_users:
            recipients = target_users
            content = f"{owner} 已取消对「{file_name}」的共享"
        elif share_scope == "class":
            # 通知目标年级/班级的学生（使用 class_id + classes.display_name 匹配）
            unshare_params: list[str] = []
            if target_grades:
                ph = ",".join(["?"] * len(target_grades))
                g_cond = f"u.grade IN ({ph})"
                unshare_params.extend(target_grades)
            else:
                g_cond = "1=1"
            c_cond = "1=1"
            if target_classes:
                ph = ",".join(["?"] * len(target_classes))
                c_cond = (
                    f"(u.class_id IN (SELECT id FROM classes WHERE display_name IN ({ph}))"
                    f" OR u.class IN ({ph}))"
                )
                unshare_params.extend(target_classes * 2)
            if unshare_params:
                rows = execute_query(
                    f"""SELECT u.username FROM users u
                        WHERE u.role=2 AND {g_cond} AND {c_cond}""",
                    tuple(unshare_params),
                )
                recipients = [r[0] for r in rows]
            # 也通知任教这些年级/班级的教师和管理员
            t_params: list[str] = []
            if target_grades:
                ph = ",".join(["?"] * len(target_grades))
                tg_cond = f"u.grade IN ({ph})"
                t_params.extend(target_grades)
            else:
                tg_cond = "1=1"
            tc_cond = "1=1"
            if target_classes:
                ph = ",".join(["?"] * len(target_classes))
                tc_cond = (
                    f"(u.class_id IN (SELECT id FROM classes WHERE display_name IN ({ph}))"
                    f" OR u.class IN ({ph}))"
                )
                t_params.extend(target_classes * 2)
            if t_params:
                t_rows = execute_query(
                    f"""SELECT u.username FROM users u
                        WHERE u.role IN (0,1) AND {tg_cond} AND {tc_cond}""",
                    tuple(t_params),
                )
                for tr in t_rows:
                    if tr[0] not in recipients:
                        recipients.append(tr[0])
            content = f"「{file_name}」已不再对您所在班级共享"

        if recipients:
            sql = """INSERT INTO notifications
                     (recipient_username, type, title, content, related_link, is_read, created_at)
                     VALUES (?, 'share', ?, ?, ?, 0, ?)"""
            ops = [(sql, (r, title, content, link, now)) for r in recipients]
            execute_batch(ops)
            logger.info(f"已发送 {len(recipients)} 条取消共享通知")
    except Exception as e:
        logger.warning(f"发送取消共享通知失败: {e}")


# ── 共享列表的统一装配：补展示字段 + 合并同一物理文件的多条共享行 ──

def _build_share_items(rows, username: str) -> list[dict[str, Any]]:
    """把 shared_resources 行补成前端要展示的条目。

    /received（共享给我的）与 /my-shares（我共享的 / 全部共享）共用，
    保证两个标签页字段一致、同一套浏览器渲染不用各写一遍口径。
    """
    # ── 批量补全展示字段（共享者姓名/角色、当前用户已读态、课程与知识点绑定）──
    # 统一用一次 IN 查询补，避免往三种角色的 SQL 分支里各加一遍 JOIN
    owner_map: dict[str, dict[str, Any]] = {}
    owners = {str(r[1] or "") for r in rows} - {""}
    if owners:
        _ph = ",".join("?" for _ in owners)
        for row in execute_query(
            f"SELECT username, name, role FROM users WHERE username IN ({_ph})", tuple(owners)
        ) or []:
            owner_map[str(row[0])] = {
                "name": str(row[1] or row[0]),
                "role": int(row[2]) if row[2] is not None else None,
            }

    # 指定教师/管理员共享：卡片上要直接写出是谁，不能只写「指定个人」。
    # 一次把出现过的账号全查出来，避免逐行查。
    user_names: dict[str, str] = {}
    _accounts: set[str] = set()
    for r in rows:
        _accounts.update(u.strip() for u in str(r[6] or "").split(",") if u.strip())
    if _accounts:
        _ph = ",".join("?" for _ in _accounts)
        for row in execute_query(
            f"SELECT username, name FROM users WHERE username IN ({_ph})", tuple(_accounts)
        ) or []:
            user_names[str(row[0])] = str(row[1] or row[0])

    def _names_of(csv: str) -> list[str]:
        return [user_names.get(u, u) for u in _uniq_keep_order(str(csv or "").split(","))]

    ids = [int(r[0]) for r in rows if r[0] is not None]
    view_map: dict[int, dict[str, Any]] = {}
    total_view_map: dict[int, int] = {}
    if ids:
        _ph = ",".join("?" for _ in ids)
        for row in execute_query(
            f"""SELECT resource_id, MAX(viewed_at), COUNT(*)
                FROM resource_view_logs
                WHERE student_username=? AND resource_id IN ({_ph})
                GROUP BY resource_id""",
            (username, *ids),
        ) or []:
            view_map[int(row[0])] = {"viewed_at": row[1], "view_count": int(row[2] or 0)}
        # 所有人合计的浏览次数：「我共享的」这一栏真正关心的是"有多少学生看过这份"
        for row in execute_query(
            f"""SELECT resource_id, COUNT(*) FROM resource_view_logs
                WHERE resource_id IN ({_ph}) GROUP BY resource_id""",
            tuple(ids),
        ) or []:
            total_view_map[int(row[0])] = int(row[1] or 0)

    bind_map: dict[int, dict[str, Any]] = {}
    if ids:
        _ph = ",".join("?" for _ in ids)
        for row in execute_query(
            f"""SELECT cb.resource_id, MIN(c.name), MIN(kp.name), COUNT(*)
                FROM curriculum_bindings cb
                JOIN knowledge_points kp ON cb.knowledge_point_id = kp.id
                JOIN chapters ch ON kp.chapter_id = ch.id
                JOIN courses c ON ch.course_id = c.id
                WHERE cb.resource_id IN ({_ph})
                GROUP BY cb.resource_id""",
            tuple(ids),
        ) or []:
            bind_map[int(row[0])] = {
                "course_name": str(row[1] or ""),
                "kp_name": str(row[2] or ""),
                "binding_count": int(row[3] or 0),
            }

    # 共享文件条目：补「是不是目录 / 几个文件 / 总共多大」，前端据此渲染文件夹与文件卡片
    dir_map: dict[int, dict[str, Any]] = {}
    for r in rows:
        if r[0] is not None and str(r[4] or "") == "download":
            dir_map[int(r[0])] = download_share_stats(str(r[1] or ""), str(r[2] or ""), "download")

    items: list[dict[str, Any]] = []
    for r in rows:
        _rid = int(r[0] or 0)
        items.append({
            "id": r[0],
            "owner_username": r[1],
            "file_path": r[2],
            "file_name": r[3],
            "resource_type": r[4],
            "share_scope": r[5],
            "target_users": r[6] or "",
            "target_user_names": _names_of(r[6]),
            "target_grade": r[7] or "",
            "target_class": r[8] or "",
            "created_at": r[9],
            "url_path": _build_url_path(r[1], r[4], r[2]),
            # 展示增强字段：共享者姓名/角色、当前用户已读态、课程与知识点绑定
            "owner_name": (owner_map.get(str(r[1] or "")) or {}).get("name") or str(r[1] or ""),
            "owner_role": (owner_map.get(str(r[1] or "")) or {}).get("role"),
            "viewed_at": (view_map.get(_rid) or {}).get("viewed_at"),
            "view_count": (view_map.get(_rid) or {}).get("view_count", 0),
            "total_view_count": total_view_map.get(_rid, 0),
            "course_name": (bind_map.get(_rid) or {}).get("course_name", ""),
            "kp_name": (bind_map.get(_rid) or {}).get("kp_name", ""),
            "binding_count": (bind_map.get(_rid) or {}).get("binding_count", 0),
            # 目录型共享（一个共享指向整个文件夹）：前端显示为文件夹条目并保留目录浏览
            "is_dir": bool((dir_map.get(_rid) or {}).get("is_dir")),
            "file_count": (dir_map.get(_rid) or {}).get("file_count", 0),
            "total_size": (dir_map.get(_rid) or {}).get("total_size", 0),
            # 内容小类（动画讲解/章节练习/播客…）：与「课程 -> 绑定资源」同一套口径，
            # 卡片不再只显示笼统的"网页课件"
            "sub_kind": rr.sub_kind_of(r[3]) if str(r[4] or "") == "html" else "",
            # 同一物理文件被多人各共享一次时的合并信息（「再共享」会产生这种行）
            "share_count": 1,
            "shared_by": [],
        })

    # 同一物理文件的多条共享行合并成一条卡片。
    # 「再共享」会让同一个文件多出一行 owner != 文件属主的记录，列表里就是两张一模一样的卡片、
    # 计数也跟着虚高。数据行保持不动（课程绑定与已读日志各挂各行），只按物理路径合并展示，
    # 并把"还有谁共享了这份"如实标出来。
    grouped: dict[str, list[dict[str, Any]]] = {}
    for it in items:
        _key = (str(it["resource_type"]) + "|" + _share_physical_path(
            str(it["owner_username"] or ""), str(it["file_path"] or ""), str(it["resource_type"] or "")))
        grouped.setdefault(_key, []).append(it)

    merged: list[dict[str, Any]] = []
    for group in grouped.values():
        if len(group) == 1:
            merged.append(group[0])
            continue
        # 保留行：有课程绑定的优先，其次浏览量高的，再取最早那条（id 稳定，绑定不会悬挂）
        group.sort(key=lambda x: (-int(x["binding_count"] or 0),
                                  -int(x["total_view_count"] or 0), int(x["id"] or 0)))
        keep = group[0]
        keep["share_count"] = len(group)
        keep["shared_by"] = [str(x["owner_name"] or x["owner_username"]) for x in group[1:]]
        keep["target_grade"] = _list_to_csv(_normalize_grades(
            [g for x in group for g in str(x["target_grade"] or "").split(",")]))
        keep["target_class"] = _list_to_csv(_normalize_classes(
            [c for x in group for c in str(x["target_class"] or "").split(",")]))
        keep["target_users"] = _list_to_csv(sorted(
            {u for x in group for u in str(x["target_users"] or "").split(",") if u.strip()}))
        keep["target_user_names"] = _names_of(keep["target_users"])
        for x in group[1:]:
            if not keep["course_name"] and x["course_name"]:
                keep["course_name"] = x["course_name"]
                keep["kp_name"] = x["kp_name"]
            if str(x["viewed_at"] or "") > str(keep["viewed_at"] or ""):
                keep["viewed_at"] = x["viewed_at"]
            keep["view_count"] = int(keep["view_count"] or 0) + int(x["view_count"] or 0)
            keep["total_view_count"] = int(keep["total_view_count"] or 0) + int(x["total_view_count"] or 0)
        merged.append(keep)

    merged.sort(key=lambda x: str(x["created_at"] or ""), reverse=True)
    return merged


# ── 我创建的共享 ──

@router.get("/my-shares")
async def my_shares(request: Request, all_shares: bool = False):
    """我创建的共享 —— 只返回当前用户名下的行（管理员同理）。

    资源中心第三个标签页「我共享的」用的就是它。这一栏的语义是"我共享出去的"，
    把别人创建的记录混进来会让人以为自己的共享有几百条（管理员此前看到的就是全站 203 条）。
    全站清单退到 all_shares=true（仅管理员、界面默认不调用）；
    要看/改同事创建的共享，走「同事共享的」卡片上的代管入口。

    字段与 /received 同一套装配逻辑（内容小类 / 绑定 / 浏览量 / 目录信息 / 同文件合并），
    资源中心第三个标签页直接复用同一个浏览器组件。
    total_view_count = 所有人合计浏览次数；view_count = 当前用户自己的浏览次数。"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role == ROLE_ADMIN and all_shares:
        # 只有显式要求时才给全站清单（管理员排障用，界面不走这条）
        rows = execute_query(
            """SELECT id, owner_username, file_path, file_name, resource_type,
                      share_scope, target_users, target_grade, target_class, created_at
               FROM shared_resources
               ORDER BY created_at DESC""",
        )
    else:
        # 默认：只给我自己创建的（管理员也不例外）
        rows = execute_query(
            """SELECT id, owner_username, file_path, file_name, resource_type,
                      share_scope, target_users, target_grade, target_class, created_at
               FROM shared_resources WHERE owner_username=?
               ORDER BY created_at DESC""",
            (username,),
        )

    return {"shares": _build_share_items(rows, username)}


# ── 收到的共享（给当前用户可见的共享） ──

@router.get("/received")
async def received_shares(request: Request, include_self: bool = False):
    """获取共享给当前用户的资源（按角色、年级、班级、指定用户过滤）

    「共享给我的」= 别人共享给我的：自己名下的行一律不出现（管理员同理），
    自己共享出去的在 /my-shares（资源中心「我共享的 / 全部共享」标签页）里管理。
    include_self=true 只退回旧口径（隐藏"仅共享给自己"的私有行），留给要看全量的场景。"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)   # JWT 缺字段时不应 500

    # 构建可见条件：
    #   scope='all'       → 所有人可见
    #   scope='staff'     → 管理员(role=0)和教师(role=1)可见
    #   scope='teacher'   → 在 target_users 列表中，或匹配年级/班级
    #   scope='class'     → 学生按年级/班级匹配；管理员可见全部；教师按任教范围匹配
    seen_conditions = ["s.share_scope='all'"]
    if role in (ROLE_ADMIN, ROLE_TEACHER):
        seen_conditions.append("s.share_scope='staff'")
    # scope='teacher' → target_users 精确匹配（使用参数化查询防SQL注入）
    teacher_user_cond = (
        "(s.share_scope='teacher' AND s.target_users!=''"
        " AND (',' || s.target_users || ',') LIKE ('%,' || ? || ',%'))"
    )
    seen_conditions.append(teacher_user_cond)

    if role == ROLE_ADMIN:
        # 管理员：可见所有 class 范围共享
        seen_conditions.append("(s.share_scope='class' AND s.target_grade != '')")
        # 管理员也可见 teacher+grade/class 组合共享
        seen_conditions.append(
            """(s.share_scope='teacher' AND s.target_grade != '' AND s.target_class != '')"""
        )
    elif role == ROLE_TEACHER:
        # 教师：通过 teacher_assignments 匹配 class 范围共享
        seen_conditions.append(
            """(s.share_scope='class' AND s.target_grade != ''
                AND EXISTS (
                    SELECT 1 FROM teacher_assignments ta
                    JOIN grades g ON ta.grade_id = g.id
                    WHERE ta.teacher_username=?
                    AND (s.target_grade=g.name
                         OR ',' || s.target_grade || ',' LIKE '%,' || g.name || ',%')
                    AND (s.target_class='' OR EXISTS (
                        SELECT 1 FROM classes c
                        WHERE c.grade_id = g.id
                        AND (c.display_name=s.target_class
                             OR ',' || s.target_class || ',' LIKE '%,' || c.display_name || ',%')
                        AND (ta.class_id IS NULL OR ta.class_id = c.id)
                    ))
                )
            )"""
        )
        # 教师也可见 teacher+grade/class 组合共享（匹配任教范围）
        seen_conditions.append(
            """(s.share_scope='teacher' AND s.target_grade != '' AND s.target_class != ''
                AND EXISTS (
                    SELECT 1 FROM teacher_assignments ta
                    JOIN grades g ON ta.grade_id = g.id
                    JOIN classes c ON c.grade_id = g.id
                    WHERE ta.teacher_username=?
                    AND (s.target_grade=g.name
                         OR ',' || s.target_grade || ',' LIKE '%,' || g.name || ',%')
                    AND (s.target_class=c.display_name
                         OR ',' || s.target_class || ',' LIKE '%,' || c.display_name || ',%')
                    AND (ta.class_id IS NULL OR ta.class_id = c.id)
                )
            )"""
        )
    elif role == ROLE_STUDENT:
        # 学生：匹配 scope='class'（仅匹配年级，班级由 Python 层精确过滤）
        seen_conditions.append(
            """(s.share_scope='class'
                AND s.target_grade != ''
                AND (s.target_grade=u.grade
                     OR ',' || s.target_grade || ',' LIKE '%,' || CAST(u.grade AS TEXT) || ',%'))"""
        )
        # 学生：匹配 teacher+grade/class 组合共享（仅匹配年级，班级由 Python 层过滤）
        seen_conditions.append(
            """(s.share_scope='teacher' AND s.target_grade != '' AND s.target_class != ''
                AND (s.target_grade=u.grade
                     OR ',' || s.target_grade || ',' LIKE '%,' || CAST(u.grade AS TEXT) || ',%'))"""
        )

    where_clause = " OR ".join(seen_conditions)

    if role == ROLE_TEACHER:
        # 教师：需要额外参数用于 EXISTS 子查询 + teacher_user_cond 的 ?
        rows = execute_query(
            f"""SELECT s.id, s.owner_username, s.file_path, s.file_name, s.resource_type,
                       s.share_scope, s.target_users, s.target_grade, s.target_class, s.created_at
                FROM shared_resources s
                WHERE {where_clause}
                ORDER BY s.created_at DESC""",
            (username, username, username),
        )
    elif role == ROLE_STUDENT:
        rows = execute_query(
            f"""SELECT s.id, s.owner_username, s.file_path, s.file_name, s.resource_type,
                       s.share_scope, s.target_users, s.target_grade, s.target_class, s.created_at
                FROM shared_resources s
                LEFT JOIN users u ON u.username=?
                WHERE {where_clause}
                ORDER BY s.created_at DESC""",
            (username, username),
        )
    else:
        rows = execute_query(
            f"""SELECT s.id, s.owner_username, s.file_path, s.file_name, s.resource_type,
                       s.share_scope, s.target_users, s.target_grade, s.target_class, s.created_at
                FROM shared_resources s
                WHERE {where_clause}
                ORDER BY s.created_at DESC""",
            (username,),
        )

    # 对所有角色的结果再做一次精确的 Python 层权限过滤
    # （弥补 SQL 复杂匹配因数据格式差异（如 "高一1班" vs "1"）可能存在的偏差）
    filtered = []
    for r in rows:
        row_data = (r[5], r[6] or "", r[7] or "", r[8] or "")
        if not _check_share_scope(row_data, username):
            continue
        # 默认过滤"仅共享给自己"的记录：owner=本人 且 目标用户只有本人（或为空）且未指定年级/班级
        # 2026-10-27 定口径：「共享给我的」= 别人共享给我的，自己名下的一律不出现（管理员同理）。
        # 自己共享的资源在「我的资源」里管理；出现在这里会让人以为列表算错了。
        # include_self=true 才退回旧口径（只隐藏"仅共享给自己"的私有行），留给要看全量的场景。
        if (r[1] or "") == username:
            if not include_self:
                continue
            _tu = {u.strip() for u in str(r[6] or "").split(",") if u.strip()}
            _tg = str(r[7] or "").strip()
            _tc = str(r[8] or "").strip()
            if not _tg and not _tc and (_tu == {username} or not _tu):
                continue
        filtered.append(r)
    rows = filtered

    return {"shares": _build_share_items(rows, username)}


# ── 通用：检查文件是否对用户可见（供 serve_static_file 调用） ──

def is_file_shared_with_user(file_rel_path: str, resource_type: str,
                             owner_username: str, viewer_username: str) -> bool:
    """检查一个文件是否通过共享对当前用户可见

    支持目录共享：如果文件的父目录被共享，该文件也对用户可见。
    """
    if not viewer_username:
        return False

    # 先尝试精确匹配（同时尝试带 / 和不带 / 的格式）
    # 数据库中目录共享的 file_path 可能以 / 结尾（如 "pics/"）
    # 但前端传入的 file_rel_path 可能不带 /（如 "pics"）
    candidates = [file_rel_path]
    if file_rel_path.endswith("/"):
        candidates.append(file_rel_path.rstrip("/"))
    else:
        candidates.append(file_rel_path + "/")

    for candidate in candidates:
        rows = execute_query(
            """SELECT s.share_scope, s.target_users, s.target_grade, s.target_class
               FROM shared_resources s
               WHERE s.owner_username=? AND s.file_path=? AND s.resource_type=?""",
            (owner_username, candidate, resource_type),
        )
        if rows:
            if _check_share_scope(rows[0], viewer_username):
                return True

    # 目录共享匹配：逐级向上检查父目录是否被共享
    # 例如 file_rel_path = "subdir/images/photo.png"
    # 检查 "subdir/images" 和 "subdir" 是否有共享记录
    parts = file_rel_path.strip("/").split("/")
    for i in range(len(parts) - 1, 0, -1):
        dir_path = "/".join(parts[:i])
        # 同时尝试带 / 和不带 / 的格式
        for d in [dir_path, dir_path + "/"]:
            rows = execute_query(
                """SELECT s.share_scope, s.target_users, s.target_grade, s.target_class
                   FROM shared_resources s
                   WHERE s.owner_username=? AND s.file_path=? AND s.resource_type=?""",
                (owner_username, d, resource_type),
            )
            if rows:
                if _check_share_scope(rows[0], viewer_username):
                    return True

    # 再共享（2026-10-27）：同事/管理员把同一份文件以他自己的名义又共享了一次，
    # 这种行 owner != 文件属主，上面按属主查的两个分支永远命中不到 ——
    # 结果「再共享给我班」只多了一张卡片、学生照样 403。这里补一次跨 owner 判定。
    phys = _share_physical_path(owner_username, file_rel_path, resource_type)
    bn = phys.split("/")[-1]
    if bn:
        for r in execute_query(
            """SELECT owner_username, file_path, share_scope, target_users, target_grade, target_class
               FROM shared_resources WHERE resource_type=? AND file_path LIKE ?""",
            (resource_type, f"%{bn}"),
        ):
            if str(r[0] or "") == str(owner_username or ""):
                continue
            if _share_physical_path(str(r[0] or ""), str(r[1] or ""), resource_type) != phys:
                continue
            if _check_share_scope((r[2], r[3] or "", r[4] or "", r[5] or ""), viewer_username):
                return True

    return False


def is_file_bound_to_course(file_rel_path: str, resource_type: str, owner_username: str) -> bool:
    """该文件（或其父目录型共享）是否已被绑定到某个知识点。

    用途：教师打开「同事绑到课程上的资源」。知识点绑定的资源对全体教师可见是既定口径
    （课程导学面板所有人都能看到名字与链接），学生也按绑定时的自动放开年级能打开；
    结果同事点开是 403 —— 看得到打不开。绑定这个动作本身就是把资源交付给这门课，
    所以对教师放开只读；学生侧一律不变，仍走共享范围判定。
    """
    if not owner_username or not file_rel_path:
        return False
    candidates = [file_rel_path]
    if file_rel_path.endswith("/"):
        candidates.append(file_rel_path.rstrip("/"))
    else:
        candidates.append(file_rel_path + "/")
    # 目录型共享被绑定时，目录里的文件同样算已绑定
    parts = str(file_rel_path).strip("/").split("/")
    for i in range(len(parts) - 1, 0, -1):
        d = "/".join(parts[:i])
        candidates.extend([d, d + "/"])
    ph = ",".join("?" for _ in candidates)
    try:
        rows = execute_query(
            f"""SELECT 1 AS ok FROM curriculum_bindings cb
                JOIN shared_resources sr
                      ON sr.id = cb.resource_id AND sr.resource_type = cb.resource_type
                WHERE sr.owner_username=? AND sr.resource_type=? AND sr.file_path IN ({ph})
                LIMIT 1""",
            (owner_username, resource_type, *candidates),
        )
    except Exception as e:
        logger.warning(f"已绑定资源判定查询失败 ({owner_username}/{file_rel_path}): {e}")
        return False
    return bool(rows)


def bound_resource_ids(owner_username: str, resource_type: str = "html") -> set[str]:
    """某人名下「已绑定到知识点」的 shared_resources id 集合（供素材放行批量判定用）。"""
    try:
        rows = execute_query(
            """SELECT DISTINCT cb.resource_id FROM curriculum_bindings cb
               JOIN shared_resources sr
                     ON sr.id = cb.resource_id AND sr.resource_type = cb.resource_type
               WHERE sr.owner_username=? AND cb.resource_type=?""",
            (owner_username, resource_type),
        )
    except Exception as e:
        logger.warning(f"已绑定 id 集合查询失败 ({owner_username}): {e}")
        return set()
    # 本模块的 execute_query 返回元组行（不是 dict），取下标 0
    return {str(r[0]) for r in rows or []}


def _check_share_scope(row, viewer_username: str) -> bool:
    """检查共享范围是否对 viewer_username 可见

    统一委托给 permission_service.check_share_visibility
    """
    share_scope, target_users, target_grade, target_class = row
    return check_share_visibility(
        viewer_username=viewer_username,
        share_scope=share_scope,
        target_users_csv=target_users or "",
        target_grade_csv=target_grade or "",
        target_class_csv=target_class or "",
    )
