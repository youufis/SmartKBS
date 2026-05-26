"""
对话历史记录 API 路由
目录树浏览 / 文件读取 / 删除
移植自 AgentSmartKBXS.py
"""
import os
import shutil

from fastapi import APIRouter, HTTPException, Request, Query
from fastapi.responses import JSONResponse

from backend.api.dependencies import get_current_user
from backend.utils import get_account_chat_history_dir, get_admin_chat_history_dir
from backend.config import DEFAULT_LOGGED_IN_NAME, ROOT_DIR
from backend.logger import logger

router = APIRouter()


def _scan_tree(dirpath: str, base_rel: str = "") -> list:
    """递归扫描目录，返回目录树结构"""
    entries = []
    try:
        for name in sorted(os.listdir(dirpath), key=str.lower):
            full = os.path.join(dirpath, name)
            rel = os.path.join(base_rel, name) if base_rel else name
            if os.path.isfile(full):
                entries.append({
                    "title": name,
                    "key": rel,
                    "isLeaf": True,
                    "size": os.path.getsize(full),
                })
            elif os.path.isdir(full):
                children = _scan_tree(full, rel)
                entries.append({
                    "title": name,
                    "key": rel,
                    "isLeaf": False,
                    "children": children,
                })
    except PermissionError:
        pass
    return entries


@router.get("/tree")
async def get_history_tree(request: Request):
    """获取当前用户的历史记录目录树"""
    user = get_current_user(request)
    username = user["username"]
    chat_dir = get_account_chat_history_dir(username)

    if not os.path.exists(chat_dir):
        return {"tree": []}

    tree = _scan_tree(chat_dir)
    return {"tree": tree, "root": chat_dir}


@router.get("/file")
async def read_history_file(path: str = Query(...), request: Request = None):
    """读取历史文件内容"""
    if request:
        user = get_current_user(request)
        username = user["username"]
        chat_dir = os.path.abspath(get_account_chat_history_dir(username))
    else:
        chat_dir = os.path.abspath(get_admin_chat_history_dir())

    # 如果 path 是相对路径，拼接用户目录
    if not os.path.isabs(path):
        target_path = os.path.abspath(os.path.join(chat_dir, path))
    else:
        target_path = os.path.abspath(path)

    # 安全校验
    if not target_path.startswith(chat_dir):
        raise HTTPException(status_code=403, detail="无权访问该文件")

    if not os.path.isfile(target_path):
        raise HTTPException(status_code=404, detail="文件不存在")

    try:
        with open(target_path, "r", encoding="utf-8") as f:
            content = f.read()

        # 检测是否包含 HTML 代码块
        import re
        html_blocks = re.findall(r'```(?:html|HTML)\s*(.*?)\s*```', content, re.DOTALL)
        has_html = len(html_blocks) > 0

        return {
            "content": content,
            "filename": os.path.basename(target_path),
            "has_html": has_html,
            "html_blocks": html_blocks[:5] if has_html else [],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"读取文件失败: {str(e)}")


@router.delete("/file")
async def delete_history_file(path: str = Query(...), request: Request = None):
    """删除历史文件或目录"""
    if request:
        user = get_current_user(request)
        username = user["username"]
        chat_dir = os.path.abspath(get_account_chat_history_dir(username))
    else:
        chat_dir = os.path.abspath(get_admin_chat_history_dir())

    if not os.path.isabs(path):
        target_path = os.path.abspath(os.path.join(chat_dir, path))
    else:
        target_path = os.path.abspath(path)

    if not target_path.startswith(chat_dir):
        raise HTTPException(status_code=403, detail="无权删除该文件")

    if not os.path.exists(target_path):
        raise HTTPException(status_code=404, detail="文件不存在")

    # 记录请求的路径和实际解析的路径，帮助排查
    logger.info(f"删除请求: path='{path}' → chat_dir='{chat_dir}' → target='{target_path}'")

    try:
        if os.path.isfile(target_path):
            os.remove(target_path)
            # 验证删除
            still_exists = os.path.exists(target_path)
            logger.info(f"os.remove 结果: file='{target_path}' still_exists={still_exists}")
            if still_exists:
                raise Exception(f"文件删除后仍然存在: {target_path}")
            msg = f"文件 {os.path.basename(target_path)} 已删除"
        elif os.path.isdir(target_path):
            shutil.rmtree(target_path)
            still_exists = os.path.exists(target_path)
            logger.info(f"shutil.rmtree 结果: dir='{target_path}' still_exists={still_exists}")
            if still_exists:
                raise Exception(f"目录删除后仍然存在: {target_path}")
            msg = f"目录 {os.path.basename(target_path)} 已删除"
        else:
            raise HTTPException(status_code=400, detail="路径不是文件也不是目录")

        logger.info(f"历史记录已删除: {target_path}")
        return {"message": msg}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"删除历史记录失败: {e}")
        raise HTTPException(status_code=500, detail=f"删除失败: {str(e)}")


@router.post("/save")
async def save_conversation(request: Request):
    """保存对话记录到文件"""
    body = await request.json()
    content = body.get("content", "")
    session_id = body.get("session_id")
    filename = body.get("filename")

    user = get_current_user(request)
    username = user["username"]
    chat_dir = get_account_chat_history_dir(username)
    os.makedirs(chat_dir, exist_ok=True)

    # 按日期目录保存
    from datetime import datetime
    date_str = datetime.now().strftime("%Y-%m-%d")
    date_dir = os.path.join(chat_dir, date_str)
    os.makedirs(date_dir, exist_ok=True)

    if not filename:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"conversation_{timestamp}.md"

    file_path = os.path.join(date_dir, filename)

    try:
        file_exists = os.path.exists(file_path)
        with open(file_path, "a", encoding="utf-8") as f:
            if not file_exists:
                f.write(f"创建时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n---\n\n")
            f.write(f"{content}\n\n---\n\n")

        return {"message": "对话已保存", "path": file_path}
    except Exception as e:
        logger.error(f"保存对话记录失败: {e}")
        raise HTTPException(status_code=500, detail=f"保存失败: {str(e)}")
