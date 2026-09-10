"""共享 HTML 资源的"依赖文件"访问判定

背景：把 root/html/小活动-渡河问题2.html 共享给学生后，页面本身能 200 打开，
但它引用的 puzzle/ruffle/ruffle.js、core.ruffle.<hash>.js、*.wasm、river2.swf
在 shared_resources 里没有记录，走 files_router 的共享检查会 403，
学生看到的是"永远在加载中"或白屏。

判定规则（只对静态素材扩展名生效，HTML/HTM 一律要求单独共享或位于已共享目录下）：
  1) 精确引用：某个"已共享给该用户"的页面，其源码（含它再加载的 js/css/json，逐层追踪）
     里确实出现了这个路径；
  2) 同目录兄弟：页面引用了某个**位于页面目录下级**的目录里的文件，则该目录内的其它
     静态素材一并放行 —— webpack / Ruffle 这类加载器会在运行时拼出
     "core.ruffle." + hash + ".js" 这样的文件名，源码里搜不到完整字符串，只能按目录放开。

安全边界：素材必须与共享页面同属一个所有者目录树（root/... 只能带出 root/... 的素材），
且不得越出项目根目录。
"""
from __future__ import annotations

import os
import posixpath
import re
import threading
import time
from collections import OrderedDict

from backend.config import BASE_DIR
from backend.database import execute_query
from backend.logger import logger
from backend.permission_service import check_share_visibility

# 允许"随共享页面一起被读取"的静态素材类型
ASSET_EXTS = frozenset({
    # 脚本 / 样式
    ".js", ".mjs", ".cjs", ".css", ".map",
    # Flash 与 WebAssembly 运行时
    ".wasm", ".swf",
    # 数据
    ".json", ".geojson", ".topojson", ".xml", ".manifest", ".webmanifest",
    # 图片
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico",
    ".tif", ".tiff", ".avif",
    # 字体
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    # 音频 / 视频
    ".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".amr",
    ".mp4", ".webm", ".mov", ".mkv",
    # 课件常见附件
    ".pptx", ".pdf", ".zip",
})

# 会被进一步解析引用关系的文本资源（HTML 只作为入口，不向下爬别的页面）
_SCANNABLE_EXTS = frozenset({".js", ".mjs", ".cjs", ".css", ".json"})

_MAX_SCAN_BYTES = 4 * 1024 * 1024   # 单文件超过 4MB 不解析
_MAX_FILES_PER_PAGE = 300           # 单个页面闭包最多解析多少个文件
_MAX_PAGES_PER_REQUEST = 40         # 单次请求最多考察多少个候选页面
_CLOSURE_TTL = 60.0                 # 页面闭包缓存时长(秒)
_CANDIDATE_TTL = 30.0               # "某用户可见的共享页面清单"缓存时长(秒)
_REF_CACHE_MAX = 512

# 引号内的整段字面量。允许空格与 %：中文名常被写成 images/%E5%9B%BE.png 或带空格
_QUOTED_RE = re.compile(r"""["'`]([^"'`\n<>{}]{1,256})["'`]""")
_QUOTED_RE = re.compile(r"""["'`]([^"'`\n<>{}%]{1,256})["'`]""")
_URL_RE = re.compile(r"""url\(\s*["']?([^"')\n]{1,256}?)["']?\s*\)""")
_SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z\d+\-.]*:")

_LOCK = threading.Lock()
# abs_path -> (mtime, size, refs)     单个文件解析出的引用
_REF_CACHE: "OrderedDict[str, tuple[float, int, frozenset[str]]]" = OrderedDict()
# abs_path -> (ts, (files, dirs))     页面 + 依赖链的闭包
_CLOSURE_CACHE: "OrderedDict[str, tuple[float, tuple[frozenset[str], frozenset[str]]]]" = OrderedDict()
# 已记过放行日志的素材路径(去重用)
_ALLOW_LOGGED: "OrderedDict[str, None]" = OrderedDict()
# (owner, viewer) -> (ts, [page_rel, ...])  该用户可见的共享页面(已按离请求由近到远排序)
_CANDIDATE_CACHE: "OrderedDict[tuple[str, str], tuple[float, list[str]]]" = OrderedDict()


def _norm_rel(p: str) -> str:
    """归一化为相对项目根目录的 posix 路径；越界或绝对路径返回空串。"""
    p = p.replace("\\", "/").strip()
    if not p:
        return ""
    try:
        from urllib.parse import unquote
        p = unquote(p)
    except Exception:
        pass
    p = p.split("#", 1)[0].split("?", 1)[0].strip()
    if not p or p.startswith("//") or _SCHEME_RE.match(p) or p.startswith("data:"):
        return ""
    if p.startswith("/api/files/"):
        p = p[len("/api/files/"):]
    elif p.startswith("/"):
        return ""          # 站内绝对路径无法可靠映射到文件树，保守拒绝
    p = posixpath.normpath(p)
    if p.startswith("..") or p == "." or posixpath.isabs(p):
        return ""
    return p


def _ext_of(p: str) -> str:
    return posixpath.splitext(p)[1].lower()


def _resolve_ref(raw: str, base_dir: str) -> str:
    """把页面里写的引用解析成相对项目根目录的路径。"""
    rel = _norm_rel(raw)
    if not rel:
        return ""
    if not raw.startswith("/api/files/"):
        rel = posixpath.normpath(posixpath.join(base_dir, rel))
        if rel.startswith(".."):
            return ""
    ext = _ext_of(rel)
    if ext not in ASSET_EXTS and ext not in _SCANNABLE_EXTS:
        return ""
    return rel


def _scan_refs(abs_path: str, rel_dir: str) -> frozenset[str]:
    """解析单个文件里出现的资源引用（带缓存）。"""
    try:
        st = os.stat(abs_path)
    except OSError:
        return frozenset()
    key = abs_path
    with _LOCK:
        hit = _REF_CACHE.get(key)
        if hit and hit[0] == st.st_mtime and hit[1] == st.st_size:
            _REF_CACHE.move_to_end(key)
            return hit[2]
    refs: set[str] = set()
    if st.st_size <= _MAX_SCAN_BYTES:
        try:
            with open(abs_path, "r", encoding="utf-8", errors="ignore") as f:
                text = f.read()
        except OSError:
            text = ""
        for regex in (_QUOTED_RE, _URL_RE):
            for m in regex.finditer(text):
                r = _resolve_ref(m.group(1), rel_dir)
                if r:
                    refs.add(r)
    result = frozenset(refs)
    with _LOCK:
        _REF_CACHE[key] = (st.st_mtime, st.st_size, result)
        _REF_CACHE.move_to_end(key)
        while len(_REF_CACHE) > _REF_CACHE_MAX:
            _REF_CACHE.popitem(last=False)
    return result


def _page_closure(page_abs: str, page_rel: str) -> tuple[frozenset[str], frozenset[str]]:
    """返回 (页面依赖链引用的文件集合, 可整目录放开的下级目录集合)。"""
    now = time.time()
    with _LOCK:
        hit = _CLOSURE_CACHE.get(page_abs)
        if hit and now - hit[0] < _CLOSURE_TTL:
            _CLOSURE_CACHE.move_to_end(page_abs)
            return hit[1]

    page_dir = posixpath.dirname(page_rel)
    files: set[str] = set()
    queue: list[tuple[str, str]] = [(page_abs, page_dir)]   # (绝对路径, 引用基准目录)
    scanned = 0
    while queue and scanned < _MAX_FILES_PER_PAGE:
        abs_path, base_dir = queue.pop(0)
        refs = _scan_refs(abs_path, base_dir)
        scanned += 1
        for r in refs:
            already = r in files
            files.add(r)
            if already:
                continue
            # 只有位于页面自身目录树之下、且是可解析的脚本/样式才继续向下追；
            # 它自己的引用要以"它所在的目录"为基准解析
            if _ext_of(r) in _SCANNABLE_EXTS and r.startswith(page_dir + "/"):
                queue.append((os.path.join(_BASE_DIR, r.replace("/", os.sep)),
                              posixpath.dirname(r)))

    # "同目录兄弟"只对页面目录的下级目录生效，避免借一个页面放开整个 html/ 目录
    dirs = {posixpath.dirname(f) for f in files
            if f.startswith(page_dir + "/") and posixpath.dirname(f) != page_dir}
    result = (frozenset(files), frozenset(dirs))
    with _LOCK:
        _CLOSURE_CACHE[page_abs] = (now, result)
        _CLOSURE_CACHE.move_to_end(page_abs)
        while len(_CLOSURE_CACHE) > 256:
            _CLOSURE_CACHE.popitem(last=False)
    return result


# 判定全程以项目根目录为边界（也是所有 rel_path 的基准）
_BASE_DIR = os.path.realpath(str(BASE_DIR))


def _tree_of(rel_path: str) -> str:
    """所有者目录树：普通用户是首段(root/youufis/...)，学生是前两段(stu/s110005)。"""
    parts = rel_path.split("/")
    if parts and parts[0] == "stu" and len(parts) > 1:
        return "/".join(parts[:2])
    return parts[0] if parts else ""


def _row_to_page_rels(owner: str, file_path: str) -> list[str]:
    """shared_resources.file_path 历史上存过两种写法，都还原成相对根目录的路径。"""
    fp = (file_path or "").replace("\\", "/").lstrip("/")
    if not fp:
        return []
    cands = []
    if owner and fp.startswith(owner + "/"):
        cands.append(fp)
    elif owner:
        cands += [posixpath.normpath(owner + "/" + fp),
                  posixpath.normpath(f"{owner}/html/{fp}"),
                  posixpath.normpath(f"stu/{owner}/html/{fp}")]
    # 也兼容直接把完整 rel_path 记在别人名下的情况
    else:
        cands.append(fp)
    return [c for c in dict.fromkeys(cands) if "/" in c]


def _visible_shared_pages(rel_path: str, owner: str, viewer_username: str) -> list[str]:
    """列出"共享给该用户"且与请求素材同属一棵所有者树的 HTML 页面。

    清单按 (owner, viewer) 缓存 _CANDIDATE_TTL 秒：一次页面加载会并发请求
    loader/分包/wasm/swf 等好几个素材，不缓存的话每个请求都要重跑一遍
    shared_resources 查询 + 逐条可见性判断(每条还可能查库)，实测 0.8s 起跳。
    共享关系变更时由 sharing_router 调用 invalidate_cache() 立即失效。
    """
    key = (owner, viewer_username)
    now = time.time()
    with _LOCK:
        hit = _CANDIDATE_CACHE.get(key)
        if hit and now - hit[0] < _CANDIDATE_TTL:
            _CANDIDATE_CACHE.move_to_end(key)
            return hit[1]

    pages: list[str] = []
    try:
        rows = execute_query(
            """SELECT file_path, share_scope, target_users, target_grade, target_class
               FROM shared_resources
               WHERE owner_username=? AND resource_type='html'""",
            (owner,),
        )
    except Exception as e:
        logger.warning(f"共享子资源判定查询失败({owner}): {e}")
        return []

    for row in rows:
        file_path, share_scope, users, grade, cls = row[0], row[1], row[2], row[3], row[4]
        # scope='all' 先短路，省掉逐条查查看者身份的开销
        if share_scope != "all" and not check_share_visibility(
            viewer_username=viewer_username,
            share_scope=share_scope,
            target_users_csv=users or "",
            target_grade_csv=grade or "",
            target_class_csv=cls or "",
        ):
            continue
        for page_rel in _row_to_page_rels(owner, file_path):
            if _ext_of(page_rel) not in (".html", ".htm"):
                continue      # 目录/文件级共享由 is_file_shared_with_user 逐级向上负责
            # 素材必须与共享页面在同一棵所有者目录树里：
            # root/... 的页面只能带出 root/... 的素材，stu/学号/... 只能带出自己树的
            if not rel_path.startswith(_tree_of(page_rel) + "/"):
                continue
            pages.append(page_rel)

    # 目录层级越深的页面越可能是素材的"就近拥有者"，先试它，命中即退出
    pages.sort(key=lambda r: -r.count("/"))
    pages = pages[:_MAX_PAGES_PER_REQUEST]
    with _LOCK:
        _CANDIDATE_CACHE[key] = (now, pages)
        _CANDIDATE_CACHE.move_to_end(key)
        while len(_CANDIDATE_CACHE) > 256:
            _CANDIDATE_CACHE.popitem(last=False)
    return pages


def is_asset_of_shared_page(rel_path: str, owner: str, viewer_username: str) -> bool:
    """rel_path 自身没被共享，但它是"共享给该用户的页面"运行所依赖的素材时返回 True。

    rel_path: 相对项目根目录的 posix 路径（如 root/html/puzzle/ruffle/ruffle.js）
    owner:    该路径的所有者用户名（root / 教师账号 / 学号）
    """
    if not viewer_username or not owner or not _BASE_DIR:
        return False
    ext = _ext_of(rel_path)
    if ext not in ASSET_EXTS:
        return False
    candidates = _visible_shared_pages(rel_path, owner, viewer_username)
    if not candidates:
        return False

    for page_rel in candidates:      # 清单已在 _visible_shared_pages 里截断到上限
        # 不额外 isfile：文件不存在时 _page_closure 会拿到空集合(缺失只在缓存未命中时 stat 一次)
        page_abs = os.path.join(_BASE_DIR, page_rel.replace("/", os.sep))
        files, dirs = _page_closure(page_abs, page_rel)
        if rel_path in files or posixpath.dirname(rel_path) in dirs:
            _log_allow(rel_path, page_rel, viewer_username)
            return True
    return False


def _log_allow(rel_path: str, page_rel: str, viewer: str) -> None:
    """每个素材只在首次放行时记一行，避免一次页面加载刷 6 条日志。"""
    with _LOCK:
        if rel_path in _ALLOW_LOGGED:
            return
        _ALLOW_LOGGED[rel_path] = None
        while len(_ALLOW_LOGGED) > 2048:
            _ALLOW_LOGGED.popitem(last=False)
    logger.info(f"[共享子资源放行] {viewer} <- {rel_path} (依赖自 {page_rel})")


def invalidate_cache(path: str = "") -> None:
    """文件被覆盖/删除、或共享关系变更时清缓存；不传参数即全清。"""
    with _LOCK:
        if not path:
            _REF_CACHE.clear()
            _CLOSURE_CACHE.clear()
            _CANDIDATE_CACHE.clear()
            return
        key = os.path.realpath(str(path))
        _REF_CACHE.pop(key, None)
        _CLOSURE_CACHE.pop(key, None)