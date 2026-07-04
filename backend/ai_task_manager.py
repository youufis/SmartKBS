"""
AI 异步任务管理器

将耗时的 AI 调用放到后台执行，前端通过 task_id 轮询结果。
避免同步阻塞 FastAPI 工作线程。
"""
import asyncio
import json
import time
import uuid
from enum import Enum
from typing import Any, Callable, Coroutine, Optional

from backend.logger import logger


async def create_ai_task(description: str, prompt: str, api_key: str) -> str:
    """快捷方式：创建一个 AI 异步调用任务，返回 task_id

    自动处理 API Key 为空的情况（返回错误结果）。
    """
    if not api_key:
        task_id = uuid.uuid4().hex[:12]
        task = AITask(task_id, description)
        task.status = TaskStatus.FAILED
        task.error = "API Key 未配置"
        task.completed_at = time.time()
        task_manager._tasks[task_id] = task  # type: ignore[protected-access]
        return task_id

    async def _do_call() -> dict[str, Any]:
        from backend.api.ai_service import call_ai_async
        result = await call_ai_async(prompt, api_key)
        return {"result": result}

    return await task_manager.create_task(description=description, coro_factory=_do_call)


class TaskStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class AITask:
    """单个 AI 任务"""
    def __init__(self, task_id: str, description: str):
        self.task_id = task_id
        self.description = description
        self.status = TaskStatus.PENDING
        self.result: Any = None
        self.error: Optional[str] = None
        self.created_at = time.time()
        self.completed_at: Optional[float] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "description": self.description,
            "status": self.status.value,
            "result": self.result,
            "error": self.error,
            "created_at": self.created_at,
            "completed_at": self.completed_at,
        }


class AITaskManager:
    """AI 后台任务管理器（内存存储）"""

    # 任务保留时间：完成/失败后保留 5 分钟后清理
    TASK_TTL = 300

    def __init__(self):
        self._tasks: dict[str, AITask] = {}
        self._lock = asyncio.Lock()

    async def create_task(
        self,
        description: str,
        coro_factory: Callable[[], Coroutine[Any, Any, Any]],
    ) -> str:
        """创建后台任务，返回 task_id

        Args:
            description: 任务描述
            coro_factory: 返回协程的可调用对象（延迟创建，避免事件循环问题）
        """
        task_id = uuid.uuid4().hex[:12]
        task = AITask(task_id, description)
        async with self._lock:
            self._tasks[task_id] = task

        # 启动后台执行
        asyncio.create_task(self._execute(task_id, coro_factory))
        logger.info(f"AI 后台任务已创建: {task_id} - {description}")
        return task_id

    async def _execute(
        self,
        task_id: str,
        coro_factory: Callable[[], Coroutine[Any, Any, Any]],
    ):
        """执行后台任务"""
        task = self._tasks.get(task_id)
        if not task:
            return

        task.status = TaskStatus.RUNNING
        try:
            result = await coro_factory()
            task.result = result
            task.status = TaskStatus.COMPLETED
            logger.info(f"AI 后台任务完成: {task_id}")
        except Exception as e:
            task.error = str(e)
            task.status = TaskStatus.FAILED
            logger.error(f"AI 后台任务失败: {task_id} - {e}")
        finally:
            task.completed_at = time.time()
            # 延迟清理（捕获取消异常，避免 reload 时崩溃）
            try:
                await asyncio.sleep(self.TASK_TTL)
                async with self._lock:
                    self._tasks.pop(task_id, None)
                    logger.debug(f"AI 后台任务已清理: {task_id}")
            except (asyncio.CancelledError, RuntimeError):
                # 服务器关闭/reload 时忽略清理任务取消
                pass

    def get_task(self, task_id: str) -> Optional[AITask]:
        """获取任务状态"""
        return self._tasks.get(task_id)

    def get_task_dict(self, task_id: str) -> Optional[dict[str, Any]]:
        """获取任务状态字典"""
        task = self.get_task(task_id)
        return task.to_dict() if task else None


# 全局单例
task_manager = AITaskManager()
