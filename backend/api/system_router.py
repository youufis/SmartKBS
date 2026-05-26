"""
系统工具 API 路由
文件服务
"""
import os

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse

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



