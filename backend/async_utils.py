# -*- coding: utf-8 -*-
"""后台任务小工具: 把重活丢到线程池执行, 不阻塞 HTTP 响应与事件循环"""
import asyncio

from backend.logger import logger

_BG_TASKS: set = set()


def spawn_bg(fn, *args, name: str = "") -> bool:
    """fire-and-forget 执行一个同步函数(在线程池里)。

    没有运行中的事件循环时退化为直接执行, 保证功能不因调用环境不同而丢失。
    返回 True 表示已交由后台执行。
    """
    label = name or getattr(fn, "__name__", "bg_task")

    def _done(task):
        _BG_TASKS.discard(task)
        if task.cancelled():
            logger.warning(f"[async_utils] 后台任务被取消: {label}")
            return
        exc = task.exception()
        if exc is not None:
            logger.warning(f"[async_utils] 后台任务失败: {label} -> {exc!r}")

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        try:
            fn(*args)
        except Exception as e:
            logger.warning(f"[async_utils] 同步执行后台任务失败: {label} -> {e}")
            return False
        return False

    task = loop.create_task(asyncio.to_thread(fn, *args))
    _BG_TASKS.add(task)
    task.add_done_callback(_done)
    return True
