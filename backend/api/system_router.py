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
from backend.config import APP_VERSION, ROOT_DIR  # APP_VERSION: /api/system/info 要回身份位
from backend.security_guard import snapshot as guard_snapshot, unban as guard_unban
from backend.utils import get_account_html_dir
from backend.logger import logger

router = APIRouter()

#: 本次进程启动的随机身份位（同机多个后端可据此区分）
_BOOT_ID = ""


@router.get("/info", summary="实例身份标识（免鉴权，供桌面壳校验连的是不是自己拉起的后端）")
async def system_info(verify: str = ""):
    """只回答"我是谁、什么版本、哪种部署"，不含路径、密钥与任何用户数据。

    为什么需要：桌面版 Electron 的"等后端就绪"是轮询 :8086 通不通。上一次没退干净的
    `smartkb-backend.exe`、或同机 IIS 上的 Web 版，都可能在占着这个端口 —— 于是桌面版
    装完打开的是**旧进程**，表现成"升级没生效/数据不对"。有了身份位就能判定并提示。
    """
    import os as _os
    import uuid as _uuid
    from backend.api.upgrade_router import _deploy_mode, _read_local_version_payload
    global _BOOT_ID
    if not _BOOT_ID:
        _BOOT_ID = _uuid.uuid4().hex[:12]
    payload = _read_local_version_payload()
    out = {
        "app_version": APP_VERSION,
        "desktop_build": str(payload.get("desktop_build") or ""),
        "deploy_mode": _deploy_mode(),
        "boot_id": _BOOT_ID,
    }
    # 桌面壳会随机生成一个只有它和它拉起的子进程知道的暗号：
    # 带上正确暗号才回 owned=true，于是"8086 上是不是我自己那个后端"有确定答案，
    # 不再靠"端口通了就算就绪"（同机残留的旧后端、或 IIS 上的 Web 版都能冒充）。
    token = (_os.environ.get("SMARTKB_DESKTOP_TOKEN") or "").strip()
    if token and verify == token:
        out["owned"] = True
    return out


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
