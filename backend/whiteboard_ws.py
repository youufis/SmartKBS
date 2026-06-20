"""
协作白板 WebSocket 连接管理器
管理白板房间的实时连接，支持广播操作、光标同步、控制权管理
"""
import time
import random
import string
from typing import Any

from fastapi import WebSocket
from backend.logger import logger
from backend.database import execute_query, execute_insert_update


class WhiteboardManager:
    """白板房间连接管理器"""

    def __init__(self):
        # room_id → {
        #   connections: { username → { ws, role, cursor } },
        #   current_page: int,
        #   mode: str,
        #   controller: str,  (当前控制者)
        #   granted_users: set[str]  (互动模式下被授权的学生)
        # }
        self.rooms: dict[int, dict] = {}
        # 操作去重缓存
        self.processed_ops: dict[str, float] = {}
        self.op_ttl = 10

    # ── 房间码生成 ──
    @staticmethod
    def generate_room_code() -> str:
        chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
        while True:
            code = "WB-" + "".join(random.choices(chars, k=4))
            rows = execute_query(
                "SELECT id FROM whiteboard_rooms WHERE room_code=? AND status='active'",
                (code,),
            )
            if not rows:
                return code

    # ── 连接管理 ──
    async def join_room(self, room_id: int, username: str,
                        role: str, websocket: WebSocket):
        await websocket.accept()
        if room_id not in self.rooms:
            self.rooms[room_id] = {
                "connections": {},
                "current_page": 1,
                "mode": "demo",
                "controller": username,
                "granted_users": set(),
            }
        self.rooms[room_id]["connections"][username] = {
            "ws": websocket,
            "role": role,
            "cursor": {"x": 0, "y": 0},
            "granted": False,
        }
        logger.info(f"白板房间 #{room_id} 用户 {username}({role}) 加入, 在线: {len(self.rooms[room_id]['connections'])}")

        # 如果该用户之前被授权过，自动恢复
        if username in self.rooms[room_id].get("granted_users", set()):
            self.rooms[room_id]["connections"][username]["granted"] = True
            await self.send_to_user(room_id, username, {
                "type": "control_granted",
                "by": "system",
            })
            logger.info(f"[白板] 自动恢复授权: {username}, room={room_id}")

        # 更新数据库：清除离开时间，标记为在线
        execute_insert_update(
            "UPDATE whiteboard_room_members SET leave_time=NULL WHERE room_id=? AND username=?",
            (room_id, username),
        )

        # 更新数据库成员在线数（基于实时 WebSocket 连接中的学生数）
        student_online = sum(
            1 for c in self.rooms[room_id]["connections"].values()
            if c.get("role") == "student"
        )
        execute_insert_update(
            "UPDATE whiteboard_rooms SET student_count=? WHERE id=?",
            (student_online, room_id),
        )

        # 广播新成员加入（online_count 只计学生，与成员抽屉一致）
        await self.broadcast(room_id, {
            "type": "member_joined",
            "username": username,
            "role": role,
            "online_count": student_online,
        })
        # 新加入者：从内存获取最新快照
        last_snap = self.rooms[room_id].get("last_snapshot", "")
        if last_snap:
            await self.send_to_user(room_id, username, {
                "type": "op_broadcast",
                "sender": "system",
                "data": {"snapshot": last_snap},
            })
            logger.info(f"[白板] 发送初始快照给 {username}, size={len(last_snap)}")

    async def leave_room(self, room_id: int, username: str):
        if room_id in self.rooms:
            self.rooms[room_id]["connections"].pop(username, None)
            remaining = len(self.rooms[room_id]["connections"])

            # 更新数据库：标记用户离线
            execute_insert_update(
                "UPDATE whiteboard_room_members SET leave_time=datetime('now','localtime') WHERE room_id=? AND username=? AND leave_time IS NULL",
                (room_id, username),
            )

            # 更新房间在线学生数
            student_online = sum(
                1 for c in self.rooms[room_id]["connections"].values()
                if c.get("role") == "student"
            )
            execute_insert_update(
                "UPDATE whiteboard_rooms SET student_count=? WHERE id=?",
                (student_online, room_id),
            )

            if remaining == 0:
                del self.rooms[room_id]
                return
            await self.broadcast(room_id, {
                "type": "member_left",
                "username": username,
                "online_count": student_online,
            })

    # ── 广播 ──
    async def broadcast(self, room_id: int, message: dict,
                        exclude: str | None = None):
        if room_id not in self.rooms:
            return
        disconnected = []
        for username, conn in list(self.rooms[room_id]["connections"].items()):
            if username == exclude:
                continue
            try:
                await conn["ws"].send_json(message)
            except Exception:
                disconnected.append(username)
        for u in disconnected:
            await self.leave_room(room_id, u)

    async def send_to_user(self, room_id: int, username: str, message: dict):
        if room_id in self.rooms and username in self.rooms[room_id]["connections"]:
            try:
                await self.rooms[room_id]["connections"][username]["ws"].send_json(message)
            except Exception:
                await self.leave_room(room_id, username)

    # ── 白板操作处理 ──
    async def handle_op(self, room_id: int, username: str, data: dict):
        op_id = data.get("op_id", "")
        if op_id and op_id in self.processed_ops:
            return
        if op_id:
            self.processed_ops[op_id] = time.time()
            self._cleanup_old_ops()
        # 日志：统计房间内连接数
        conn_count = len(self.rooms.get(room_id, {}).get("connections", {}))
        logger.info(f"[白板WS] 广播 op 到 room={room_id}, 接收端数={conn_count - 1} (excl sender={username})")
        # 存入内存 + 写库持久化
        snap = data.get("data", {}).get("snapshot", "")
        if snap and isinstance(snap, str) and len(snap) > 100:
            if room_id in self.rooms:
                self.rooms[room_id]["last_snapshot"] = snap
            try:
                execute_insert_update(
                    "UPDATE whiteboard_pages SET snapshot_data=?, updated_at=CURRENT_TIMESTAMP WHERE room_id=? AND page_number=?",
                    (snap, room_id, data.get("page", 1)),
                )
            except Exception:
                pass
        await self.broadcast(room_id, {
            "type": "op_broadcast",
            "op_id": op_id,
            "page": data.get("page", 1),
            "sender": username,
            "data": data.get("data", {}),
        }, exclude=username)

    async def handle_cursor(self, room_id: int, username: str, data: dict):
        if room_id in self.rooms and username in self.rooms[room_id]["connections"]:
            x, y = data.get("x", 0), data.get("y", 0)
            self.rooms[room_id]["connections"][username]["cursor"] = {"x": x, "y": y}
        await self.broadcast(room_id, {
            "type": "cursor_broadcast",
            "username": username,
            "x": data.get("x", 0),
            "y": data.get("y", 0),
        }, exclude=username)

    # ── 权限相关 ──
    async def grant_control(self, room_id: int, target: str, by: str):
        if room_id in self.rooms:
            self.rooms[room_id].setdefault("granted_users", set()).add(target)
            if target in self.rooms[room_id]["connections"]:
                self.rooms[room_id]["connections"][target]["granted"] = True
            logger.info(f"[白板] 授权 {target} 操作, room={room_id}, by={by}")
            # 先发送最新快照（学生仍是只读，会加载），再发送授权通知
            last_snap = self.rooms[room_id].get("last_snapshot", "")
            if last_snap:
                await self.send_to_user(room_id, target, {
                    "type": "op_broadcast",
                    "sender": "system",
                    "data": {"snapshot": last_snap},
                })
            await self.send_to_user(room_id, target, {
                "type": "control_granted",
                "by": by,
            })
            await self.broadcast(room_id, {
                "type": "control_transferred",
                "username": target,
            })

    async def revoke_control(self, room_id: int, target: str):
        if room_id in self.rooms:
            self.rooms[room_id].setdefault("granted_users", set()).discard(target)
            if target in self.rooms[room_id]["connections"]:
                self.rooms[room_id]["connections"][target]["granted"] = False
            await self.send_to_user(room_id, target, {"type": "control_revoked"})

    def is_granted(self, room_id: int, username: str) -> bool:
        # 优先检查 granted_users 集合（持久化），其次检查连接中的 granted 标志
        if username in self.rooms.get(room_id, {}).get("granted_users", set()):
            return True
        return self.rooms.get(room_id, {}).get("connections", {}).get(username, {}).get("granted", False)

    def get_role(self, room_id: int, username: str) -> str:
        return self.rooms.get(room_id, {}).get("connections", {}).get(username, {}).get("role", "student")

    def get_mode(self, room_id: int) -> str:
        return self.rooms.get(room_id, {}).get("mode", "demo")

    def set_mode(self, room_id: int, mode: str):
        if room_id in self.rooms:
            self.rooms[room_id]["mode"] = mode

    def get_current_page(self, room_id: int) -> int:
        return self.rooms.get(room_id, {}).get("current_page", 1)

    def set_current_page(self, room_id: int, page: int):
        if room_id in self.rooms:
            self.rooms[room_id]["current_page"] = page

    def get_online_count(self, room_id: int) -> int:
        return len(self.rooms.get(room_id, {}).get("connections", {}))

    # ── 辅助 ──
    def _cleanup_old_ops(self):
        now = time.time()
        expired = [k for k, v in self.processed_ops.items() if now - v > self.op_ttl]
        for k in expired:
            del self.processed_ops[k]


# 全局单例
whiteboard_manager = WhiteboardManager()
