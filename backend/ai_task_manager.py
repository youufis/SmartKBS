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
        task = AITask(task_id, description, _resolve_owner())
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


class TooManyAITasks(RuntimeError):
    """同一用户进行中的 AI 后台任务超过并发上限(仅对显式设置上限的端点生效)"""

    def __init__(self, owner: str, limit: int):
        self.owner = owner
        self.limit = limit
        super().__init__(f"进行中的 AI 任务已达上限 {limit} 个")


class AITask:
    """单个 AI 任务"""
    def __init__(self, task_id: str, description: str, owner_username: str = "",
                 dedupe_key: str = ""):
        self.task_id = task_id
        self.description = description
        # 去重键: 同一用户的同键任务不重复调模型(见 create_task)
        self.dedupe_key = dedupe_key or ""
        # S5: 任务归属者(创建时自动取自请求上下文), 查询接口据此鉴权
        self.owner = owner_username or ""
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
            # S5: 供查询端点做归属校验, 返回前会被 pop 掉, 不下发给客户端
            "owner": self.owner,
        }


def _resolve_owner(explicit: str | None = None) -> str:
    """任务归属者: 显式传入优先, 否则取当前请求上下文"""
    if explicit:
        return explicit
    try:
        from backend.request_ctx import get_current_username
        return get_current_username() or ""
    except Exception:
        return ""


class AITaskManager:
    """AI 后台任务管理器（内存存储）"""

    # 任务保留时间：完成/失败后保留 5 分钟后清理
    TASK_TTL = 300
    # 默认并发上限: 挡"脚本刷/前端异常重试"把付费模型刷爆, 又高于任何正常的批量操作。
    # 端点可传 max_concurrent=N 收紧(如 GET 分析类用 4), 或传 0 表示不设限。
    DEFAULT_MAX_CONCURRENT = 10

    def __init__(self):
        self._tasks: dict[str, AITask] = {}
        self._lock = asyncio.Lock()

    # 刚完成的任务在该时间窗内命中同键请求时直接复用结果, 不再重复调模型
    REUSE_DONE_WINDOW = 60

    async def create_task(
        self,
        description: str,
        coro_factory: Callable[[], Coroutine[Any, Any, Any]],
        owner_username: str | None = None,
        dedupe_key: str | None = None,
        max_concurrent: int | None = None,
    ) -> str:
        """创建后台任务，返回 task_id

        Args:
            description: 任务描述
            coro_factory: 返回协程的可调用对象（延迟创建，避免事件循环问题）
            owner_username: 任务归属者, 缺省取当前请求上下文
            dedupe_key: 去重键。同一归属者的同键任务若仍在排队/执行, 或已在
                REUSE_DONE_WINDOW 内完成, 则直接复用既有 task_id 而不再发起一次
                真实模型调用 —— 用于挡住刷新、误点两下、前端重试造成的重复计费。
                刻意不传时行为与旧版一致(不去重), 以免把不同参数的请求误并成一个。
            max_concurrent: 该归属者允许的进行中任务数上限, 超出抛 TooManyAITasks
                (由 main.py 的统一异常处理器转成 429)。不传=用默认 10; 传 0=不设限。
        """
        owner = _resolve_owner(owner_username)
        key = (dedupe_key or "").strip()
        async with self._lock:
            now = time.time()
            if key:
                for t in self._tasks.values():
                    if t.owner != owner or t.dedupe_key != key:
                        continue
                    if t.status in (TaskStatus.PENDING, TaskStatus.RUNNING):
                        logger.info(f"AI 后台任务复用(进行中): {t.task_id} - {description}")
                        return t.task_id
                    if (t.status == TaskStatus.COMPLETED and t.completed_at
                            and now - t.completed_at < self.REUSE_DONE_WINDOW):
                        logger.info(f"AI 后台任务复用(完成 {int(now - t.completed_at)}s): "
                                    f"{t.task_id} - {description}")
                        return t.task_id
            # 未显式指定时用全局默认上限; 显式传 0 表示不设限
            limit = self.DEFAULT_MAX_CONCURRENT if max_concurrent is None else int(max_concurrent)
            if limit > 0:
                active = sum(1 for x in self._tasks.values()
                             if x.owner == owner
                             and x.status in (TaskStatus.PENDING, TaskStatus.RUNNING))
                if active >= limit:
                    raise TooManyAITasks(owner, limit)

            task_id = uuid.uuid4().hex[:12]
            task = AITask(task_id, description, owner, dedupe_key=key)
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
