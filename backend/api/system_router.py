"""
系统工具 API 路由
文件服务
"""
import os
import random
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.auth import ROLE_ADMIN
from backend.config import ROOT_DIR
from backend.security_guard import snapshot as guard_snapshot, unban as guard_unban
from backend.utils import get_account_html_dir
from backend.logger import logger

router = APIRouter()


@router.get("/examples/files")
async def get_random_files(request: Request):
    """获取随机文件示例"""
    imgs_dir = os.path.join(ROOT_DIR, "imgs")
    if not os.path.exists(imgs_dir):
        return {"files": []}

    try:
        files = [
            os.path.join(imgs_dir, f) for f in os.listdir(imgs_dir)
            if os.path.isfile(os.path.join(imgs_dir, f))
        ]
        random.seed(time.time())
        sampled = random.sample(files, min(5, len(files)))
        return {"files": [[[f]] for f in sampled]}
    except Exception as e:
        logger.warning(f"读取文件示例失败: {e}")
        return {"files": []}


# ── 来源 IP 防护：管理员可查"谁在失败、被封到什么时候、用的什么 UA" ──

class UnbanRequest(BaseModel):
    ip: str


def _require_admin(request: Request) -> str:
    user = get_current_user(request)
    if user.get("role") != ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="仅管理员可查看来源 IP 防护状态")
    return user.get("username", "")


@router.get("/security/guard")
async def security_guard_status(request: Request):
    """IP 防护快照：黑名单、临时封禁列表、最近失败来源（含 UA/Referer）"""
    _require_admin(request)
    return guard_snapshot()


@router.post("/security/guard/unban")
async def security_guard_unban(req: UnbanRequest, request: Request):
    """手工解除某个 IP 的临时封禁（误封/用户催的时候用；黑名单要改 IP_DENYLIST）"""
    admin = _require_admin(request)
    ip = (req.ip or "").strip()
    if not ip:
        raise HTTPException(status_code=400, detail="缺少 ip 参数")
    removed = guard_unban(ip)
    logger.info(f"[安全] 管理员 {admin} 解除 IP 临时封禁: {ip} (原本={'是' if removed else '否'}在封禁中)")
    return {"ip": ip, "unbanned": removed}
