"""

文件服务 API 路由

文件上传 + 静态文件服务

"""

import os

import uuid

import shutil

import json

from datetime import datetime

from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, UploadFile, File, Query

from fastapi.responses import FileResponse, HTMLResponse

from backend.api.auth_guard import unauthorized

from backend.api.dependencies import get_current_user

from backend.utils import path_within

from backend.auth import is_admin

from backend.config import BASE_DIR, STORAGE_DIR, TEMP_UPLOAD_ROOT, CHAT_ASSET_ROOT

from backend.api.config_router import get_config_value

from backend.config import ROOT_DIR, STU_DIR

from backend.api.sharing_router import is_file_bound_to_course, is_file_shared_with_user

from backend import shared_assets

from backend.database import execute_insert_update

from backend.logger import logger

router = APIRouter()

# 任何角色都不得通过文件接口读取运行时代码/依赖目录(内含 system_config.json 等敏感配置)

_DENY_TOP_DIRS = {

    ".venv", "venv", "node_modules", ".git", ".vscode", ".codex",

    "backend", "frontend", "Temp", "__pycache__", "dist",

}

# 允许匿名访问的公开文档(必须位于项目根目录)

_PUBLIC_ROOT_FILES = {"USER_MANUAL.md", "README.md", "README.en.md"}

TEMP_UPLOAD_DIR = TEMP_UPLOAD_ROOT

TEMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# 已入档附件：长期保留，与历史记录同寿命

CHAT_ASSET_DIR = CHAT_ASSET_ROOT

CHAT_ASSET_DIR.mkdir(parents=True, exist_ok=True)

def _user_chat_asset_dir(username: str) -> Path:

    d = CHAT_ASSET_DIR / str(username or "_")

    d.mkdir(parents=True, exist_ok=True)

    return d

def _dir_bytes(d: Path) -> int:

    total = 0

    for root, _dirs, files in os.walk(d):

        for fn in files:

            try:

                total += os.path.getsize(os.path.join(root, fn))

            except OSError:

                pass

    return total

def _image_exts() -> set[str]:

    from backend.config_lists import as_str_list

    default = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp']

    return set(as_str_list(get_config_value("IMAGE_EXTENSIONS", default), default))

def _get_allowed_extensions() -> set[str]:

    """获取允许的文件扩展名集合（运行时读取，支持热更新）"""

    from backend.config_lists import as_str_list

    img = as_str_list(

        get_config_value("IMAGE_EXTENSIONS", ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp']),

        ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp'],

    )

    doc = as_str_list(

        get_config_value("DOCUMENT_EXTENSIONS",

                         ['.txt', '.md', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',

                          '.csv', '.json', '.html', '.htm']),

        ['.txt', '.md', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',

         '.csv', '.json', '.html', '.htm'],

    )

    return set(img + doc)

# ── 自动清理旧临时文件（每 24 小时检查一次，删除超过 24 小时的） ──

_last_temp_cleanup: float = 0

_TEMP_CLEANUP_INTERVAL = 86400  # 24 小时

_TEMP_MAX_AGE = 86400  # 24 小时

def _auto_cleanup_temp():

    """自动清理过期临时文件"""

    global _last_temp_cleanup

    import time

    now = time.time()

    if now - _last_temp_cleanup < _TEMP_CLEANUP_INTERVAL:

        return

    _last_temp_cleanup = now

    if not TEMP_UPLOAD_DIR.exists():

        return

    cutoff = now - _TEMP_MAX_AGE

    for user_dir in TEMP_UPLOAD_DIR.iterdir():

        if not user_dir.is_dir():

            continue

        for f in user_dir.iterdir():

            if f.is_file() and f.stat().st_mtime < cutoff:

                f.unlink()

        # 删除空目录

        if user_dir.exists() and not list(user_dir.iterdir()):

            user_dir.rmdir()

@router.post("/upload-temp")

async def upload_temp_file(request: Request, file: UploadFile = File(...)):

    """上传临时文件，返回服务器端路径（相同内容只保存一份）"""

    _auto_cleanup_temp()

    user = get_current_user(request)

    username = user["username"]

    filename = file.filename or "unknown"

    _, ext = os.path.splitext(filename.lower())

    if ext not in _get_allowed_extensions():

        raise HTTPException(status_code=400, detail=f"不支持的文件类型: {ext}")

    user_dir = TEMP_UPLOAD_DIR / username

    user_dir.mkdir(parents=True, exist_ok=True)

    try:

        max_size = 10 * 1024 * 1024

        if ext in get_config_value("IMAGE_EXTENSIONS", ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp']):

            max_size = 5 * 1024 * 1024

        # M6: 先按声明大小拒绝超限文件, 不全量读入内存

        if file.size is not None and file.size > max_size:

            raise HTTPException(status_code=400, detail="文件超过大小限制")

        content = await file.read()

        if len(content) > max_size:

            raise HTTPException(status_code=400, detail="文件超过大小限制")

        # 计算内容哈希，相同内容的文件只保存一份

        import hashlib

        file_hash = hashlib.sha256(content).hexdigest()

        save_path = user_dir / f"{file_hash}{ext}"

        if not save_path.exists():

            with open(save_path, "wb") as f:

                f.write(content)

        return {"path": str(save_path), "filename": filename, "size": len(content)}

    except HTTPException:

        raise

    except Exception as e:

        logger.error(f"文件上传失败: {e}")

        raise HTTPException(status_code=500, detail=f"文件上传失败: {str(e)}")

@router.post("/promote")

async def promote_chat_assets(request: Request):

    """把已发送的附件从 temp_uploads 转入长期目录。

    temp_uploads 只服务"选了但还没发"的草稿（24h 清理）；一旦发送成功，

    文件必须搬进 chat_assets，否则第二天历史里的图就全成死链。

    """

    user = get_current_user(request)

    username = user["username"]

    body = await request.json()

    items = body.get("items") or []

    if not isinstance(items, list) or not items:

        return {"attachments": []}

    temp_root = os.path.realpath(str(TEMP_UPLOAD_DIR / username))

    asset_dir = _user_chat_asset_dir(username)

    quota_mb = int(get_config_value("CHAT_ASSET_QUOTA_MB", 1024) or 1024)

    used = _dir_bytes(asset_dir)

    month = datetime.now().strftime("%Y-%m")

    img_exts = _image_exts()

    out: list[dict] = []

    for it in items[:20]:

        if not isinstance(it, dict):

            continue                       # 脏请求直接跳过，别让 500 冒出来

        raw = str(it.get("path") or "")

        name = str(it.get("name") or os.path.basename(raw) or "附件")[:120]

        src = os.path.realpath(raw)

        if not path_within(temp_root, src) or not os.path.isfile(src):

            out.append({"name": name, "f": "", "error": "文件已失效"})

            continue

        size = os.path.getsize(src)

        if quota_mb > 0 and used + size > quota_mb * 1024 * 1024:

            raise HTTPException(status_code=413,

                                detail=f"附件空间已满（每人上限 {quota_mb} MB），删除一些旧对话后可继续")

        dest_dir = asset_dir / month

        dest_dir.mkdir(parents=True, exist_ok=True)

        dest = dest_dir / os.path.basename(src)

        deduped = dest.exists()

        if deduped:

            try:

                os.unlink(src)          # 同内容已入档：去重，只留一份

            except OSError:

                pass

        else:

            try:

                os.replace(src, dest)

            except OSError:

                shutil.copy2(src, dest)

                try:

                    os.unlink(src)

                except OSError:

                    pass

        if not deduped:

            used += size                # 去重命中时不占新空间，别把配额算虚

        ext = os.path.splitext(dest.name)[1].lower()

        out.append({

            "name": name,

            "f": f"{month}/{dest.name}",

            "path": str(dest),

            "size": size,

            "kind": "image" if ext in img_exts else "file",

        })

    logger.info("附件入档: user=%s n=%s used=%sKB", username, len(out), used // 1024)

    return {"attachments": out}

@router.get("/chat-asset")

async def get_chat_asset(request: Request, f: str = Query(...), dl: int = 0):

    """读取已入档附件：只允许访问本人目录，路径必须落在目录内"""

    user = get_current_user(request)

    base = os.path.realpath(str(_user_chat_asset_dir(user["username"])))

    target = os.path.realpath(os.path.join(base, f))

    if not path_within(base, target) or not os.path.isfile(target):

        raise HTTPException(status_code=404, detail="附件不存在或已过期")

    return FileResponse(

        target,

        filename=os.path.basename(target) if dl else None,

        content_disposition_type="attachment" if dl else "inline",

    )

@router.delete("/cleanup-temp")

async def cleanup_temp_files(request: Request, all: bool = False):

    """清理临时文件

    - 管理员传 all=true 清理所有用户的临时文件

    - 普通用户只能清理自己的

    """

    user = get_current_user(request)

    username = user["username"]

    if all:

        if not is_admin(username):

            raise HTTPException(status_code=403, detail="权限不足：仅管理员可清理所有缓存")

        if TEMP_UPLOAD_DIR.exists():

            shutil.rmtree(TEMP_UPLOAD_DIR)

            TEMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

        return {"message": "所有临时文件已清理"}

    else:

        user_dir = TEMP_UPLOAD_DIR / username

        if user_dir.exists():

            shutil.rmtree(user_dir)

        return {"message": "已清理"}

def _parse_file_owner_and_type(rel_path: str):

    """从相对路径解析文件的所有者和资源类型"""

    parts = rel_path.split("/")

    if len(parts) >= 3:

        if parts[0] == STU_DIR:

            return parts[1], parts[2]  # stu/s110005/html/... → (s110005, html)

        elif parts[0] == ROOT_DIR:

            return parts[0], parts[1]  # root/html/... → (root, html)

        else:

            return parts[0], parts[1]  # youufis/html/... → (youufis, html)

    return None, None

@router.get("/{path:path}")

async def serve_static_file(path: str, request: Request):

    """静态文件服务（需登录，按用户角色隔离）

    

    URL 示例: /api/files/root/html/some/file.html

    

    访问权限规则：

    - 管理员 (role=0): 可访问所有目录

    - 教师 (role=1): 可访问 root/（共享资源）和自己目录下的资源

    - 学生 (role=2): 仅可访问 stu/自己学号/ 下的资源 + 共享给该学生的资源

    - 未登录: 仅可访问 USER_MANUAL.md 等公开文件

    

    共享覆盖：管理员共享给所有人的资源、教师共享给对应年级/班级的资源也可访问。

    """

    base_dir_abs = os.path.realpath(str(STORAGE_DIR))   # 用户数据根（root/、stu/、question_media/…）

    doc_dir_abs = os.path.realpath(str(BASE_DIR))       # 随包文档根（README 等）

    # T8: 用 realpath + 路径段比较判边界(旧写法 startswith 会把兄弟目录当成前缀放行)

    requested_path = os.path.realpath(os.path.join(base_dir_abs, path))

    # 随包文档（README/USER_MANUAL）不在用户数据目录里：只对白名单文件名、且确实位于

    # 代码目录根部时放行，其余越界请求一律拒绝（与改动前的安全口径一致）

    if not path_within(base_dir_abs, requested_path) or not os.path.exists(requested_path):

        alt_path = os.path.realpath(os.path.join(doc_dir_abs, path))

        if (os.path.basename(alt_path) in _PUBLIC_ROOT_FILES

                and os.path.dirname(alt_path) == doc_dir_abs

                and path_within(doc_dir_abs, alt_path)

                and os.path.exists(alt_path)):

            return FileResponse(alt_path)

    if not path_within(base_dir_abs, requested_path):

        raise HTTPException(status_code=403, detail="无权访问该文件")

    

    if not os.path.exists(requested_path):

        raise HTTPException(status_code=404, detail="文件不存在")

    

    # ── 用户隔离检查 ──

    user = request.state.user  # 由中间件注入

    basename = os.path.basename(requested_path)

    

    # T7: 公开文件必须确实位于（用户数据）根目录, 不再按"任意目录同名文件"放行

    if basename in _PUBLIC_ROOT_FILES and os.path.dirname(requested_path) == base_dir_abs:

        return FileResponse(requested_path)

    # T7: 试题配图也要登录(旧实现只要 URL 含 /question_media/ 即匿名放行,

    #     凭 uuid 文件名即可批量拖走全部教学配图)

    if user is None:

        raise unauthorized(message="需要登录才能访问资源文件")

    

    username = user.get("username", "")

    role = user.get("role", 2)  # 默认学生

    rel_path = os.path.relpath(requested_path, base_dir_abs).replace("\\", "/")

    path_parts = rel_path.split("/")

    if path_parts and path_parts[0] in _DENY_TOP_DIRS:

        raise HTTPException(status_code=403, detail="无权访问该位置")

    

    # 标记是否允许访问

    # 试题配图(question_media)本就随考题下发给学生: 收口为"登录即可读", 但不再匿名可枚举

    allowed = path_parts[0] == "question_media"

    

    # 管理员：除上面 deny 列表(运行时代码/依赖目录)外均可

    if role == 0:

        allowed = True

    

    # 教师：可访问 root/（共享）和自己名下的资源

    elif role == 1:

        # 原来的 backend/data 放行分支指向一个不存在的目录, 反而成了口子, 已移除

        if path_parts[0] == ROOT_DIR or path_parts[0] == username:

            allowed = True

    

    # 学生：仅可访问 stu/自己学号/ 下的资源

    elif role == 2:

        if len(path_parts) >= 3 and path_parts[0] == STU_DIR and path_parts[1] == username:

            allowed = True

    

    # ── 共享覆盖检查：如果普通检查未通过，检查是否为共享资源 ──

    if not allowed:

        owner, dir_type = _parse_file_owner_and_type(rel_path)

        resource_type_map = {"html": "html", "downloads": "download"}

        if owner and dir_type in resource_type_map:

            res_type = resource_type_map[dir_type]

            # 构建相对于所有者目录的文件路径

            if dir_type in ("html", "downloads"):

                idx = rel_path.index(dir_type)

                file_rel = rel_path[idx + len(dir_type) + 1:]  # 去掉 "html/" 或 "downloads/"

            else:

                file_rel = ""

            # 同时尝试两种路径格式：

            # 1. 截短后的相对路径（来自资源管理页 tree node.key）

            # 2. 完整 rel_path（来自资源中心页 f.url_path）

            if is_file_shared_with_user(file_rel, res_type, owner, username):

                allowed = True

            elif is_file_shared_with_user(rel_path, res_type, owner, username):

                allowed = True

            # 教师：同事绑到课程知识点上的资源，课程面板里人人可见，就该人人打得开

            elif role == 1 and (

                is_file_bound_to_course(file_rel, res_type, owner)

                or is_file_bound_to_course(rel_path, res_type, owner)

            ):

                allowed = True

    

        # 依赖文件跟随：共享页面自己引用的 ruffle.js / *.wasm / *.swf / 图片等素材

        # 在 shared_resources 里没有独立记录，若不放行，学生打开互动课件就会白屏(403)

        if not allowed and owner:

            allowed = shared_assets.is_asset_of_shared_page(rel_path, owner, username)

        # 已绑定页面的依赖素材：同上，教师侧放开，否则同事打开是白屏

        if not allowed and owner and role == 1:

            allowed = shared_assets.is_asset_of_bound_page(rel_path, owner)

    

    if not allowed:

        raise HTTPException(

            status_code=403,

            detail="无权访问该资源（该文件本身未共享，也不是已共享页面引用的依赖文件）",

        )

    

    # ── 学生访问 HTML/下载文件时记录查看日志 ──

    if role == 2 and (path_parts[-1].endswith('.html') or path_parts[-1].endswith('.htm') or "downloads" in path_parts):

        try:

            _log_resource_access(rel_path, username, role, path_parts, request)

        except Exception as log_err:

            # 不阻断访问, 但要留下线索(旧实现静默 pass, 统计缺失时无从排查)

            logger.warning(f"记录资源查看日志失败: {log_err}")

    

    # 白板图片按内容哈希命名，永不变化：给一年强缓存，学生只下一次。

    if rel_path.startswith(("question_media/whiteboard_assets/", "question_media/explore_canvas_assets/")):

        return FileResponse(

            requested_path,

            headers={"Cache-Control": "public, max-age=31536000, immutable"},

        )

    # H2/M2: downloads 目录里的 HTML 一律附件下载 —— inline 打开会在主站源执行,

    # 学生上传的 HTML 被管理员/教师浏览时即成存储型 XSS（课件预览走 html 目录的沙箱 iframe）

    if "/downloads/" in rel_path and rel_path.lower().endswith((".html", ".htm")):

        return FileResponse(

            requested_path,

            filename=os.path.basename(requested_path),

            content_disposition_type="attachment",

        )

    # 预览桥：html 目录的 inline HTML 注入 token 桥 + 存储 shim（沙箱 iframe 内 API 鉴权自愈）

    if requested_path.lower().endswith((".html", ".htm")):


        try:

            html_text = Path(requested_path).read_text(encoding="utf-8", errors="replace")

            # no-store: 旧 FileResponse 带 Last-Modified 无 cache-control，浏览器启发式缓存

            # 会让 iframe 一直用修复前的旧 HTML（桥注入不生效）



            return HTMLResponse(_localize_html(html_text), headers={"Cache-Control": "no-store"})

        except OSError:

            return FileResponse(requested_path)

    return FileResponse(requested_path)

def _localize_html(html: str) -> str:

    """课件外部依赖本地化：校园网无外网时阻断式字体/CDN 会挂起致白屏。

    字体 link 移除（CSS 已有系统字体回退）；KaTeX/Chart.js 改指内置本地副本。"""

    import re as _re

    html = _re.sub(r"<link[^>]*(fonts\.googleapis\.com|fonts\.gstatic\.com)[^>]*>", "", html, flags=_re.I)

    html = _re.sub(r"@import\s+url\(\s*['\"]?https://(fonts\.googleapis|fonts\.gstatic)[^)]*\)\s*;?", "", html, flags=_re.I)

    html = _re.sub(r"url\(\s*['\"]?https://(fonts\.googleapis|fonts\.gstatic)[^)]*\)", "none", html, flags=_re.I)

    html = _re.sub(r"https://cdn\.jsdelivr\.net/npm/katex@[\d.]+/dist/", "/katex/", html)

    html = _re.sub(r"https://cdn\.jsdelivr\.net/npm/chart\.js(@[\d.]+)?(/dist/chart\.umd\.js)?",

                   "/vendor/chart.umd.js", html)

    return html

def _log_resource_access(rel_path: str, username: str, role: int, path_parts: list[str], request: Request):

    """记录学生访问 HTML 资源的日志（后端兜底记录）"""

    from datetime import datetime

    # 只记录学生

    if role != 2:

        return

    # 推断资源类型

    if "html" in path_parts:

        dir_type = "html"

    elif "downloads" in path_parts:

        dir_type = "download"

    else:

        return

    # 尝试从共享记录中查找 resource_id

    resource_id = 0

    owner_username = ""

    try:

        # 解析所有者

        if len(path_parts) >= 3:

            if path_parts[0] == "stu":

                owner_username = path_parts[1]

            else:

                owner_username = path_parts[0]

        # 通过文件路径查询共享记录中的资源 ID

        # 注意：URL 里的目录段是 "downloads"，而 resource_type 是 "download"，

        # 早先用 dir_type 去 index 会 ValueError 被外层 except 静默吞掉，

        # 结果是共享文件的浏览记录从来没关联到 resource_id（已读态/浏览量/积分全丢）

        _dir_seg = "html" if dir_type == "html" else "downloads"

        file_rel = "/".join(path_parts[path_parts.index(_dir_seg) + 1:]) if _dir_seg in path_parts else ""

        from backend.database import execute_query_one

        def _find_share(fp: str):

            # 同一个文件可能被多人各存一行共享（「再共享」会产生 owner != 文件属主的行）。

            # 已读态/浏览量必须稳定挂到文件属主那一行，否则和资源中心卡片用的 id 对不上。

            return execute_query_one(

                """SELECT id, owner_username FROM shared_resources

                   WHERE resource_type=? AND (file_path=? OR file_path LIKE ?)

                   ORDER BY CASE WHEN owner_username=? THEN 0 ELSE 1 END, id

                   LIMIT 1""",

                (dir_type, fp, f"%/{fp}", owner_username),

            )

        share = _find_share(file_rel) if file_rel else None

        if file_rel and not share:

            # 目录型共享（一个共享指向整个文件夹）：文件自己没有共享记录，

            # 逐级向上找「父目录被共享」的那条，否则目录里的文件永远带 resource_id=0，

            # 已读态、浏览量、首次浏览积分全都对不上号

            _segs = [s for s in file_rel.strip("/").split("/") if s]

            for _i in range(len(_segs) - 1, 0, -1):

                _d = "/".join(_segs[:_i])

                share = _find_share(_d) or _find_share(_d + "/")

                if share:

                    break

        if share:

            resource_id = share["id"]

            owner_username = share["owner_username"]

    except Exception:

        # 兜底查询失败只影响 resource_id 关联，不阻断文件访问；但必须留痕——

        # 否则像「占位符与参数个数不符」这类低级错误会永远静默（2026-10-27 就踩了）

        logger.debug("共享资源浏览日志关联失败: %s", rel_path, exc_info=True)

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    client_ip = request.client.host if request.client else ""

    # 去重: 前端埋点通常已记一条, 60 秒内同人同资源存在记录则跳过(消除 total_views 双计)

    try:

        from datetime import timedelta as _td

        from backend.database import execute_query_one as _q1

        _cut = (datetime.now() - _td(seconds=60)).strftime("%Y-%m-%d %H:%M:%S")

        if resource_id > 0:

            _dup = _q1(

                "SELECT id FROM resource_view_logs WHERE student_username=? AND resource_type=? AND resource_id=? AND viewed_at>=? LIMIT 1",

                (username, dir_type, resource_id, _cut),

            )

        else:

            _dup = _q1(

                "SELECT id FROM resource_view_logs WHERE student_username=? AND resource_type=? AND file_path=? AND viewed_at>=? LIMIT 1",

                (username, dir_type, rel_path, _cut),

            )

        if _dup:

            return

    except Exception:

        pass

    try:

        execute_insert_update(

            """INSERT INTO resource_view_logs

               (student_username, resource_type, resource_id, knowledge_point_id,

                binding_id, source, file_path, owner_username, viewed_at, ip_address)

               VALUES (?, ?, ?, NULL, NULL, 'direct', ?, ?, ?, ?)""",

            (username, dir_type, resource_id, rel_path, owner_username, now, client_ip),

        )

        # 首次浏览共享资源奖励 1 分（幂等，不重复累计）

        if resource_id > 0:

            try:

                from backend.reward_engine import award_participation

                award_participation(

                    student_username=username,

                    activity_type="resource_view",

                    # 键里带资源类型：html 与 download 的 id 各自成体系，只用裸 id 会让

                    # "下载 #6"和"网页 #6"互相顶掉，后者静默不给分

                    activity_id=f"{dir_type}:{resource_id}",

                    activity_title=rel_path.split("/")[-1] or "共享资源",

                )

            except Exception:

                pass

    except Exception:

        pass

