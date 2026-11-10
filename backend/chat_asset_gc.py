"""聊天附件回收。

原则：附件与历史记录同寿命。只有「任何历史 md 都不再引用」且闲置超过
CHAT_ASSET_GC_DAYS 天的文件才删除——删历史时级联清空间，靠的就是这个。

安全阀：某个用户的历史目录读不到（权限/迁移中）时，整户跳过，
宁可晚点回收也不能把还在用的图删了。
"""
import json
import os
import re
import threading
import time

from backend.api.config_router import get_config_value
from backend.config import CHAT_ASSET_ROOT
from backend.logger import logger
from backend.utils import get_account_chat_history_dir

_REF_RE = re.compile(r"<!--\s*attachments:\s*(\[.*?\])\s*-->", re.S)
_started = False


def _refs_of_user(username: str) -> set[str] | None:
    """该用户历史里引用到的附件相对路径；历史目录不可读返回 None（调用方跳过该用户）"""
    root = get_account_chat_history_dir(username)
    if not os.path.isdir(root):
        return None
    refs: set[str] = set()
    for dirpath, _dirs, files in os.walk(root):
        for fn in files:
            if not fn.lower().endswith(".md"):
                continue
            try:
                with open(os.path.join(dirpath, fn), "r", encoding="utf-8", errors="ignore") as f:
                    txt = f.read()
            except OSError:
                return None
            for m in _REF_RE.finditer(txt):
                try:
                    arr = json.loads(m.group(1))
                except Exception:
                    continue
                if isinstance(arr, list):
                    for a in arr:
                        if isinstance(a, dict) and a.get("f"):
                            refs.add(str(a["f"]))
    return refs


def sweep_once() -> dict:
    days = int(get_config_value("CHAT_ASSET_GC_DAYS", 7) or 0)
    if days <= 0:
        return {"skipped": "disabled"}
    if not os.path.isdir(CHAT_ASSET_ROOT):
        return {"skipped": "no_dir"}

    cutoff = time.time() - days * 86400
    removed = freed = 0
    scanned_users = skipped_users = 0

    for user_dir in sorted(CHAT_ASSET_ROOT.iterdir()):
        if not user_dir.is_dir():
            continue
        refs = _refs_of_user(user_dir.name)
        if refs is None:
            skipped_users += 1
            continue
        scanned_users += 1
        for dirpath, _dirs, files in os.walk(user_dir):
            for fn in files:
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, user_dir).replace("\\", "/")
                if rel in refs:
                    continue
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                if st.st_mtime > cutoff:
                    continue          # 可能刚上传、历史还没写进去
                try:
                    os.unlink(full)
                    removed += 1
                    freed += st.st_size
                except OSError as e:
                    logger.warning("附件回收失败 %s: %s", full, e)

    # 清掉空的月份目录
    for user_dir in sorted(CHAT_ASSET_ROOT.iterdir()):
        if not user_dir.is_dir():
            continue
        for sub in sorted(user_dir.iterdir()):
            if sub.is_dir():
                try:
                    if not any(sub.iterdir()):
                        sub.rmdir()
                except OSError:
                    pass

    if removed:
        logger.info("聊天附件回收: 用户 %s 个, 删除 %s 个文件, 释放 %.1fMB (闲置>%s天)",
                    scanned_users, removed, freed / 1048576, days)
    return {"users": scanned_users, "skipped_users": skipped_users,
            "removed": removed, "freed": freed}


def _loop() -> None:
    time.sleep(300)          # 启动 5 分钟后首跑，避开开机高峰
    while True:
        try:
            sweep_once()
        except Exception as e:
            logger.warning("聊天附件回收异常: %s", e)
        time.sleep(86400)


def start() -> None:
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, name="chat-asset-gc", daemon=True).start()
