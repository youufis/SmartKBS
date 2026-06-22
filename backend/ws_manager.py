"""
WebSocket 连接管理器
管理分组讨论的实时连接，支持广播消息
"""
from typing import Any

from fastapi import WebSocket
from backend.logger import logger


class ConnectionManager:
    """管理所有 WebSocket 连接，按 group_id 分组"""

    def __init__(self):
        self.active_connections: dict[int, list[WebSocket]] = {}

    async def connect(self, group_id: int, websocket: WebSocket):
        await websocket.accept()
        if group_id not in self.active_connections:
            self.active_connections[group_id] = []
        self.active_connections[group_id].append(websocket)

    def disconnect(self, group_id: int, websocket: WebSocket):
        if group_id in self.active_connections:
            if websocket in self.active_connections[group_id]:
                self.active_connections[group_id].remove(websocket)
                if not self.active_connections[group_id]:
                    del self.active_connections[group_id]

    async def broadcast(self, group_id: int, message: dict[str, Any]):
        """广播消息到指定小组的所有连接"""
        if group_id not in self.active_connections:
            return
        disconnected = []
        for connection in self.active_connections[group_id]:
            try:
                await connection.send_json(message)
            except Exception:
                disconnected.append(connection)
        for conn in disconnected:
            self.disconnect(group_id, conn)

    def get_group_connections(self, group_id: int) -> int:
        """获取指定小组的在线连接数"""
        return len(self.active_connections.get(group_id, []))


# 全局单例
manager = ConnectionManager()
