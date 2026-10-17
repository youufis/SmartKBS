"""课堂提问实时推送连接管理器。

按“班级快照”分房间：学生进自己班，教师进所有任教班级，管理员进 admin。
"""
from typing import Any

from fastapi import WebSocket

from backend.logger import logger


ADMIN_ROOM = "question:admin"


def class_room(grade_id: int, class_id: int) -> str:
    return f"question:class:{grade_id}:{class_id}"


class QuestionWSManager:
    def __init__(self):
        self.rooms: dict[str, list[WebSocket]] = {}

    async def connect(self, rooms: list[str], websocket: WebSocket):
        await websocket.accept()
        for room in rooms:
            self.rooms.setdefault(room, []).append(websocket)

    def disconnect(self, rooms: list[str], websocket: WebSocket):
        for room in rooms:
            conns = self.rooms.get(room)
            if not conns:
                continue
            if websocket in conns:
                conns.remove(websocket)
            if not conns:
                self.rooms.pop(room, None)

    async def broadcast(self, rooms: list[str], message: dict[str, Any]):
        seen: set[int] = set()
        for room in rooms:
            for connection in list(self.rooms.get(room, [])):
                if id(connection) in seen:
                    continue
                seen.add(id(connection))
                try:
                    await connection.send_json(message)
                except Exception:
                    logger.debug(f"[提问WS] 推送失败，移除连接 room={room}")
                    self.disconnect([room], connection)


question_ws = QuestionWSManager()
