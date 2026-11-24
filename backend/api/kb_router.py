"""本地知识库 API（独立命名空间 /api/kb，不接入文件中心/资源中心）。"""
import hashlib
import os
import shutil
import urllib.parse
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse
from starlette.datastructures import UploadFile

from backend import local_kb
from backend.api.dependencies import get_current_user
from backend.config import STORAGE_DIR
from backend.logger import logger

router = APIRouter()

_MAX_PER_REQUEST = 20


def _user(request: Request) -> dict:
    return get_current_user(request)


def _role(user: dict) -> int:
    try:
        return int(user.get("role", 2))
    except Exception:
        return 2


def _need_editor(user: dict) -> None:
    if _role(user) not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足：仅管理员和教师可使用知识库")


def _need_admin(user: dict) -> None:
    if _role(user) != 0:
        raise HTTPException(status_code=403, detail="权限不足：仅管理员")


def _guard_enabled() -> None:
    if not local_kb.enabled():
        raise HTTPException(status_code=400, detail="本地知识库未启用（系统配置 → AI 能力 → 本地知识库）")


async def _save_to_tmp(uf: UploadFile, max_bytes: int) -> tuple:
    tmp = local_kb.tmp_dir() / f"{uuid.uuid4().hex}.part"
    sha = hashlib.sha256()
    size = 0
    try:
        with open(tmp, "wb") as f:
            while True:
                chunk = await uf.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(status_code=413, detail=f"文件超过 {max_bytes // 1048576}MB 限制")
                sha.update(chunk)
                f.write(chunk)
    except HTTPException:
        try:
            tmp.unlink()
        except Exception:
            pass
        raise
    except Exception as e:
        try:
            tmp.unlink()
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=f"写入临时文件失败: {e}")
    if size == 0:
        try:
            tmp.unlink()
        except Exception:
            pass
        raise HTTPException(status_code=422, detail="文件内容为空")
    return tmp, sha.hexdigest(), size


def _folder_row(fid: int):
    for it in local_kb.folders().get("items", []):
        if int(it["id"]) == int(fid):
            return it
    return None


@router.get("/folders", summary="目录列表")
async def kb_folders(request: Request):
    user = _user(request)
    _need_editor(user)
    _guard_enabled()
    return local_kb.folders()


@router.post("/folders", summary="新建目录")
async def kb_folder_create(request: Request):
    user = _user(request)
    _need_editor(user)
    _guard_enabled()
    try:
        body = await request.json()
    except Exception:
        body = {}
    res = local_kb.create_folder(str((body or {}).get("name") or ""), user.get("username", ""))
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error") or "创建失败")
    return res


@router.put("/folders/{fid}", summary="重命名目录")
async def kb_folder_rename(request: Request, fid: int):
    user = _user(request)
    _need_editor(user)
    _guard_enabled()
    row = _folder_row(fid)
    if not row:
        raise HTTPException(status_code=404, detail="文件夹不存在")
    if _role(user) != 0 and row.get("owner") != user.get("username"):
        raise HTTPException(status_code=403, detail="仅创建者或管理员可重命名")
    try:
        body = await request.json()
    except Exception:
        body = {}
    res = local_kb.rename_folder(fid, str((body or {}).get("name") or ""), user.get("username", ""))
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error") or "重命名失败")
    return res


@router.delete("/folders/{fid}", summary="删除目录（文档回落未分类）")
async def kb_folder_delete(request: Request, fid: int):
    user = _user(request)
    _need_editor(user)
    _guard_enabled()
    row = _folder_row(fid)
    if not row:
        raise HTTPException(status_code=404, detail="文件夹不存在")
    if _role(user) != 0 and row.get("owner") != user.get("username"):
        raise HTTPException(status_code=403, detail="仅创建者或管理员可删除")
    res = local_kb.delete_folder(fid, user.get("username", ""))
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error") or "删除失败")
    return res


@router.post("/docs/{doc_id}/move", summary="移动到目录")
async def kb_doc_move(request: Request, doc_id: int):
    user = _user(request)
    _need_editor(user)
    _guard_enabled()
    detail = local_kb.doc_detail(doc_id)
    if not detail:
        raise HTTPException(status_code=404, detail="文档不存在")
    if _role(user) != 0 and detail.get("owner") != user.get("username"):
        raise HTTPException(status_code=403, detail="仅上传者或管理员可移动")
    try:
        body = await request.json()
    except Exception:
        body = {}
    fid = (body or {}).get("folder_id")
    try:
        fid = int(fid) if fid not in (None, "", 0, "0") else None
    except Exception:
        fid = None
    res = local_kb.move_doc(doc_id, fid)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error") or "移动失败")
    return res


@router.get("/stats", summary="知识库容量与健康")
async def kb_stats(request: Request):
    user = _user(request)
    _need_editor(user)
    return local_kb.stats()


@router.get("/docs", summary="文档列表")
async def kb_docs(request: Request, q: str = "", status: str = "", scope: str = "all",
                  folder: str = "all", page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100)):
    user = _user(request)
    _need_editor(user)
    _guard_enabled()
    data = local_kb.list_docs(q=q, status=status, scope=scope, folder=folder,
                              username=user.get("username", ""), page=page, page_size=page_size)
    data["stats"] = local_kb.stats()
    return data


@router.get("/docs/status", summary="批量状态轮询")
async def kb_status(request: Request, ids: str = ""):
    user = _user(request)
    _need_editor(user)
    id_list = []
    for part in (ids or "").split(","):
        part = part.strip()
        if part.isdigit():
            id_list.append(int(part))
    return {"items": local_kb.status_batch(id_list[:100])}


@router.get("/docs/{doc_id}", summary="文档详情")
async def kb_doc_detail(request: Request, doc_id: int):
    user = _user(request)
    _need_editor(user)
    d = local_kb.doc_detail(doc_id)
    if not d:
        raise HTTPException(status_code=404, detail="文档不存在")
    return d


@router.get("/docs/{doc_id}/file", summary="下载原件")
async def kb_doc_file(request: Request, doc_id: int):
    user = _user(request)
    _need_editor(user)
    d = local_kb.doc_detail(doc_id)
    if not d:
        raise HTTPException(status_code=404, detail="文档不存在")
    c = local_kb._conn()
    try:
        row = c.execute("SELECT path,name FROM kb_docs WHERE id=?", (doc_id,)).fetchone()
    finally:
        c.close()
    if not row or not row["path"] or not os.path.exists(row["path"]):
        raise HTTPException(status_code=404, detail="原件已不存在")
    fname = urllib.parse.quote(row["name"])
    return FileResponse(row["path"], filename=row["name"],
                        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{fname}"})

@router.post("/upload", summary="上传文档（多文件）")
async def kb_upload(request: Request):
    user = _user(request)
    _need_editor(user)
    _guard_enabled()
    username = user.get("username", "")
    form = await request.form()
    try:
        folder_id = int(str(form.get("folder_id") or "").strip() or 0) or None
    except Exception:
        folder_id = None
    force_new = str(form.get("force_new") or "").strip().lower() in ("1", "true", "yes")
    files = []
    for key in form.keys():
        item = form[key]
        if isinstance(item, UploadFile) and item.filename:
            files.append(item)
    if not files:
        raise HTTPException(status_code=400, detail="未收到文件")
    if len(files) > _MAX_PER_REQUEST:
        raise HTTPException(status_code=400, detail=f"一次最多上传 {_MAX_PER_REQUEST} 个文件")

    max_bytes = local_kb._max_file_mb() * 1048576
    free = shutil.disk_usage(str(STORAGE_DIR)).free
    uploaded, skipped, errors = [], [], []
    for uf in files:
        name = local_kb.safe_name(uf.filename)
        ext = os.path.splitext(name)[1].lower()
        if ext not in local_kb.allowed_exts():
            errors.append({"name": uf.filename,
                           "reason": "格式不支持（仅 " + " / ".join(sorted(x.lstrip(".") for x in local_kb.allowed_exts())) + "；旧版 Office 请另存为 docx/pdf）"})
            continue
        if uf.size is not None and uf.size > max_bytes:
            errors.append({"name": uf.filename, "reason": f"超过 {local_kb._max_file_mb()}MB 限制"})
            continue
        if free < max_bytes * 2:
            errors.append({"name": uf.filename, "reason": "服务器磁盘空间不足"})
            continue
        try:
            tmp, sha, size = await _save_to_tmp(uf, max_bytes)
        except HTTPException as e:
            errors.append({"name": uf.filename, "reason": str(e.detail)})
            continue
        try:
            res = local_kb.register_upload(tmp, name, username, sha, size,
                                           folder_id=folder_id, force_new=force_new)
        except Exception as e:
            logger.warning(f"[KB] 入库失败 {name}: {e}")
            res = {"ok": False, "error": str(e)[:160]}
        finally:
            try:
                tmp.unlink()
            except Exception:
                pass
        if res.get("ok"):
            uploaded.append({"id": res["id"], "name": res["name"], "status": res.get("status", "pending")})
        elif res.get("skipped"):
            skipped.append({"name": res.get("name") or name, "id": res.get("id"),
                            "reason": res.get("reason")})
        else:
            errors.append({"name": uf.filename, "reason": res.get("error") or "入库失败"})
    return {"uploaded": uploaded, "skipped": skipped, "errors": errors}


@router.post("/docs/{doc_id}/replace", summary="替换文件（管理员）")
async def kb_replace(request: Request, doc_id: int):
    user = _user(request)
    _need_admin(user)
    _guard_enabled()
    form = await request.form()
    uf = None
    for key in form.keys():
        item = form[key]
        if isinstance(item, UploadFile) and item.filename:
            uf = item
            break
    if not uf:
        raise HTTPException(status_code=400, detail="未收到文件")
    ext = os.path.splitext(local_kb.safe_name(uf.filename))[1].lower()
    if ext not in local_kb.allowed_exts():
        raise HTTPException(status_code=415, detail="格式不支持（仅 " + " / ".join(sorted(x.lstrip(".") for x in local_kb.allowed_exts())) + "）")
    tmp, sha, size = await _save_to_tmp(uf, local_kb._max_file_mb() * 1048576)
    try:
        res = local_kb.replace_doc(doc_id, tmp, uf.filename, sha, size)
    finally:
        try:
            tmp.unlink()
        except Exception:
            pass
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error") or "替换失败")
    return res


@router.post("/docs/{doc_id}/reindex", summary="重新索引（管理员）")
async def kb_reindex(request: Request, doc_id: int):
    user = _user(request)
    _need_admin(user)
    _guard_enabled()
    if not local_kb.doc_detail(doc_id):
        raise HTTPException(status_code=404, detail="文档不存在")
    return local_kb.reindex_doc(doc_id)


@router.delete("/docs/{doc_id}", summary="移出知识库（软删）")
async def kb_remove(request: Request, doc_id: int):
    user = _user(request)
    _need_editor(user)
    _guard_enabled()
    detail = local_kb.doc_detail(doc_id)
    if not detail:
        raise HTTPException(status_code=404, detail="文档不存在")
    if _role(user) != 0 and detail.get("owner") != user.get("username"):
        raise HTTPException(status_code=403, detail="仅上传者或管理员可移除")
    res = local_kb.remove_doc(doc_id, user.get("username", ""))
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error") or "移除失败")
    return res


@router.get("/trash", summary="回收站（管理员）")
async def kb_trash(request: Request):
    user = _user(request)
    _need_admin(user)
    _guard_enabled()
    return {"items": local_kb.list_trash()}


@router.post("/trash/{doc_id}/restore", summary="恢复（管理员）")
async def kb_restore(request: Request, doc_id: int):
    user = _user(request)
    _need_admin(user)
    _guard_enabled()
    res = local_kb.restore_doc(doc_id, user.get("username", ""))
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error") or "恢复失败")
    return res


@router.delete("/trash/{doc_id}", summary="彻底删除（管理员）")
async def kb_purge(request: Request, doc_id: int, confirm_name: str = Query("")):
    user = _user(request)
    _need_admin(user)
    _guard_enabled()
    detail = local_kb.doc_detail(doc_id)
    if not detail:
        raise HTTPException(status_code=404, detail="文档不存在")
    if (confirm_name or "").strip() != detail.get("name"):
        raise HTTPException(status_code=400, detail="确认名称不匹配")
    res = local_kb.purge_doc(doc_id, user.get("username", ""))
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error") or "删除失败")
    return res


@router.post("/rebuild", summary="重建向量索引（管理员）")
async def kb_rebuild(request: Request):
    user = _user(request)
    _need_admin(user)
    _guard_enabled()
    return local_kb.rebuild_all()


@router.post("/search-test", summary="检索测试")
async def kb_search_test(request: Request):
    user = _user(request)
    _need_editor(user)
    _guard_enabled()
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    q = str((body or {}).get("q") or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="请输入检索问题")
    hits, stat = local_kb.search(q, top_k=8)
    return {"items": hits, "stat": stat, "embed": local_kb.stats().get("embed")}
