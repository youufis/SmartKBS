"""
协作白板 WebSocket 连接管理器
管理白板房间的实时连接，支持广播操作、光标同步、控制权管理

消息投递与落库的三条铁律（都是被现场延迟问题逼出来的）：
  1. 每条连接只有一个发送任务 + 一个待发队列：绝不在广播里 await 各连接的写操作，
     否则一个慢学生能把全班的板书拖住几十秒。
  2. 状态型消息（整份快照、光标）在队列里"新值顶替旧值"：白板广播的是状态，
     把几秒前的中间状态发给学生只是让他反复整篇重载、并且越拖越远。
  3. 落库不占事件循环、且按房间节流：广播不等数据库；切页/最后离开/结束房间时
     强制 flush，保证库里的副本不会比内存旧过关键节点。
"""
import asyncio
import random
import string
import time
from collections import deque
from typing import Any

from fastapi import WebSocket
from backend.logger import logger
from backend.database import execute_query, execute_insert_update

#: 单连接队列上限：超了丢最旧的（状态型消息丢中间值无损，事件型丢一条也远好过全班卡住）
_MAX_QUEUE = 200
#: 同一房间两次落库的最小间隔（秒）
_PERSIST_MIN_INTERVAL = 3.0


class WhiteboardManager:
    """白板房间连接管理器"""

    def __init__(self):
        # room_id → {
        #   connections: { username → { ws, role, cursor, granted, outbox, sending } },
        #   current_page: int,
        #   mode: str,
        #   controller: str,  (当前控制者)
        #   granted_users: set[str]  (互动模式下被授权的学生)
        #   dirty_pages: {page → snapshot}  (待落库的最新快照)
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
    def _ensure_room(self, room_id: int, controller: str = "") -> dict:
        """获取房间；不存在则创建，并尽量从数据库恢复最新快照"""
        room = self.rooms.get(room_id)
        if room is not None:
            return room
        room = {
            "connections": {},
            "current_page": 1,
            "mode": "demo",
            "controller": controller,
            "granted_users": set(),
            "last_snapshot": "",
            "dirty_pages": {},
            "writing": {},          # 已交给落库线程、还没写完的那一批
            "write_done": None,     # 上面这批写完的哨兵
            "last_persist": 0.0,
            "persisting": False,
        }
        # 房间可能已因全员离开/结束而被回收，尝试从数据库恢复最新快照，避免白板内容丢失
        try:
            rows = execute_query(
                "SELECT snapshot_data FROM whiteboard_pages "
                "WHERE room_id=? AND snapshot_data IS NOT NULL AND snapshot_data != '' "
                "ORDER BY updated_at DESC LIMIT 1",
                (room_id,),
            )
            if rows and rows[0][0]:
                room["last_snapshot"] = rows[0][0]
        except Exception as e:
            logger.warning(f"[白板] 恢复房间 {room_id} 最新快照失败: {e}")
        self.rooms[room_id] = room
        return room

    def _register_connection(self, room: dict, username: str, role: str,
                             websocket: WebSocket):
        room["connections"][username] = {
            "ws": websocket,
            "role": role,
            "cursor": {"x": 0, "y": 0},
            "granted": username in room.get("granted_users", set()),
            "outbox": deque(),
            "sending": False,
            "notices_sent": set(),
        }

    async def join_room(self, room_id: int, username: str,
                        role: str, websocket: WebSocket):
        await websocket.accept()
        # 房间可能被并发移除（如最后一个连接恰好断开/房间被结束），
        # 每次 await 后都重新获取，避免 KeyError 崩溃
        room = self._ensure_room(room_id, controller=username)
        self._register_connection(room, username, role, websocket)

        # 如果该用户之前被授权过，自动恢复
        if username in room.get("granted_users", set()):
            room["connections"][username]["granted"] = True
            await self.send_to_user(room_id, username, {
                "type": "control_granted",
                "by": "system",
            })
            # await 期间房间可能被移除，重新获取并恢复连接
            room = self._ensure_room(room_id, controller=username)
            self._register_connection(room, username, role, websocket)

        # 更新数据库：清除离开时间，标记为在线
        execute_insert_update(
            "UPDATE whiteboard_room_members SET leave_time=NULL WHERE room_id=? AND username=?",
            (room_id, username),
        )

        # 更新数据库成员在线数（基于实时 WebSocket 连接中的学生数）
        student_online = sum(
            1 for c in room["connections"].values()
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
        # 广播期间房间可能被并发移除，重新获取并恢复本连接
        room = self._ensure_room(room_id, controller=username)
        if username not in room["connections"]:
            self._register_connection(room, username, role, websocket)
        # 新加入者：从内存获取最新快照
        last_snap = room.get("last_snapshot", "")
        if last_snap:
            await self.send_to_user(room_id, username, {
                "type": "op_broadcast",
                "sender": "system",
                "data": {"snapshot": last_snap},
            })

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
                # 房间收尾前必须落库：否则最后一个学生一断线，最后几秒的板书就没了
                await self.flush_persist(room_id)
                del self.rooms[room_id]
                return
            await self.broadcast(room_id, {
                "type": "member_left",
                "username": username,
                "online_count": student_online,
            })

    # ── 投递：单连接单发送任务，状态型消息新值顶替旧值 ──
    @staticmethod
    def _coalesce_key(message: dict) -> str | None:
        mtype = message.get("type")
        if mtype == "op_broadcast":
            return "snapshot"
        if mtype == "cursor_broadcast":
            return f"cursor:{message.get('username')}"
        return None

    def _enqueue(self, room_id: int, username: str, message: dict):
        conn = self.rooms.get(room_id, {}).get("connections", {}).get(username)
        if conn is None:
            return
        outbox = conn["outbox"]
        key = self._coalesce_key(message)
        if key is not None:
            for i, old in enumerate(outbox):
                if self._coalesce_key(old) == key:
                    outbox[i] = message      # 原地顶替：不打乱事件型消息的顺序
                    break
            else:
                outbox.append(message)
        else:
            outbox.append(message)
        if len(outbox) > _MAX_QUEUE:
            dropped = outbox.popleft()
            logger.warning(
                f"[白板] 连接积压超 {_MAX_QUEUE}，丢弃最旧消息 "
                f"room={room_id} user={username} type={dropped.get('type')}"
            )
        if not conn["sending"]:
            conn["sending"] = True
            asyncio.create_task(self._drain(room_id, username))

    async def _drain(self, room_id: int, username: str):
        """这条连接唯一的发送任务。发不出去就算断线，绝不回头阻塞别人。"""
        while True:
            conn = self.rooms.get(room_id, {}).get("connections", {}).get(username)
            if conn is None:
                return
            outbox = conn["outbox"]
            try:
                while outbox:
                    await conn["ws"].send_json(outbox.popleft())
            except Exception:
                conn["sending"] = False
                await self.leave_room(room_id, username)
                return
            conn["sending"] = False
            if not outbox:
                return
            conn["sending"] = True        # 让出期间又积压了，继续占位发送

    # ── 广播 ──
    async def broadcast(self, room_id: int, message: dict,
                        exclude: str | None = None):
        room = self.rooms.get(room_id)
        if not room:
            return
        for username in list(room["connections"].keys()):
            if username == exclude:
                continue
            self._enqueue(room_id, username, message)

    async def send_to_user(self, room_id: int, username: str, message: dict):
        self._enqueue(room_id, username, message)

    async def notify_once(self, room_id: int, username: str, message: dict):
        """同一条提示每个连接只回一次。

        权限拒绝是逐条操作发生的（广播端约每 0.1s 就推一次快照），照原样回发会把
        当事人的消息条刷成屏；只报第一次，后面交给界面里的常驻说明。
        """
        conn = self.rooms.get(room_id, {}).get("connections", {}).get(username)
        if conn is None:
            return
        key = message.get("type", "")
        sent = conn.setdefault("notices_sent", set())
        if key in sent:
            return
        sent.add(key)
        self._enqueue(room_id, username, message)

    async def close_room(self, room_id: int, code: int = 4410,
                         reason: str = "房间已结束", final_message: dict | None = None):
        """结束房间：通知并关闭全部连接，回收内存房间。

        原来只广播一条 room_ended 就把连接和内存房间都留着，于是"已结束"和
        "还在写"同时成立：教师继续在死房间里画、学生再也进不来、在线人数也不清零。
        收尾消息必须由这里"先发再关"——走队列的话，关闭和排队会打架，
        学生端只剩一个没有说明的断开。
        """
        await self.flush_persist(room_id)
        room = self.rooms.pop(room_id, None)   # 先摘房间：队列不再进新消息，发送任务也拿不到连接
        if not room:
            return
        for conn in list(room.get("connections", {}).values()):
            if final_message is not None:
                try:
                    await conn["ws"].send_json(final_message)
                except Exception:
                    pass
            try:
                await conn["ws"].close(code=code, reason=reason)
            except Exception:
                pass

    # ── 落库：不占事件循环、按房间节流、关键节点强制 flush ──
    def _mark_dirty(self, room_id: int, page: Any, snapshot: str):
        room = self.rooms.get(room_id)
        if room is None:
            return
        room.setdefault("dirty_pages", {})[page] = snapshot
        if not room.get("persisting"):
            room["persisting"] = True
            asyncio.create_task(self._persist_worker(room_id))

    async def _persist_worker(self, room_id: int):
        while True:
            room = self.rooms.get(room_id)
            dirty = room.get("dirty_pages") if room else None
            if not dirty:
                break
            wait = _PERSIST_MIN_INTERVAL - (time.monotonic() - room.get("last_persist", 0.0))
            if wait > 0:
                await asyncio.sleep(wait)
                room = self.rooms.get(room_id)
                dirty = room.get("dirty_pages") if room else None
                if not dirty:
                    break
            await self._write_now(room_id, room)   # 清 dirty、标记 writing、写完再放行，都由它负责
        room = self.rooms.get(room_id)
        if room:
            room["persisting"] = False
            if room.get("dirty_pages"):          # 收尾时又有新内容，重新起跑
                room["persisting"] = True
                asyncio.create_task(self._persist_worker(room_id))

    async def _write_now(self, room_id: int, room: dict):
        """取一批立刻写，并把"正在写"挂出来让 flush 等得到。

        坑在顺序：以前是先清 dirty 再异步写，切页/收尾时 flush 一看 dirty 是空的
        就直接返回，可那一批其实还没落库 —— 于是切页读到的是几秒前的旧板书。
        """
        batch = room.get("dirty_pages") or {}
        if not batch:
            return
        room["dirty_pages"] = {}
        room["last_persist"] = time.monotonic()
        room["writing"] = batch
        done = asyncio.Event()
        room["write_done"] = done
        try:
            await asyncio.to_thread(self._write_pages, room_id, dict(batch))
        except Exception as e:
            logger.warning(f"[白板] 实时快照落库失败 room={room_id}: {e}")
        finally:
            room["writing"] = {}
            done.set()

    async def flush_persist(self, room_id: int):
        """把待写快照全部落库，并**真的等它写完**（切页前、最后离开前、结束房间前）"""
        room = self.rooms.get(room_id)
        if not room:
            return
        if room.get("writing"):
            done = room.get("write_done")
            if done is not None:
                try:
                    await asyncio.wait_for(done.wait(), timeout=10)
                except Exception:
                    logger.warning(f"[白板] 等待落库收尾超时 room={room_id}，按现有副本继续")
        if room.get("dirty_pages"):
            await self._write_now(room_id, room)
    @staticmethod
    def _write_pages(room_id: int, batch: dict):
        """在线程里跑同步 SQLite：实时内容必须落库。

        原来只做 UPDATE，页面行还不存在时（新建房间/新增页）影响 0 行且静默失败，
        后端一重启内存房间就没了，AI 就再也读不到白板内容。
        """
        for page, snap in batch.items():
            try:
                exists = execute_query(
                    "SELECT 1 FROM whiteboard_pages WHERE room_id=? AND page_number=? LIMIT 1",
                    (room_id, page),
                )
                if exists:
                    execute_insert_update(
                        "UPDATE whiteboard_pages SET snapshot_data=?, updated_at=CURRENT_TIMESTAMP WHERE room_id=? AND page_number=?",
                        (snap, room_id, page),
                    )
                else:
                    execute_insert_update(
                        "INSERT INTO whiteboard_pages (room_id, page_number, snapshot_data, is_current, updated_at, created_at)"
                        " VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
                        (room_id, page, snap),
                    )
            except Exception as e:
                logger.warning(f"[白板] 实时快照落库失败 room={room_id} page={page}: {e}")

    # ── 白板操作处理 ──
    async def handle_op(self, room_id: int, username: str, data: dict):
        op_id = data.get("op_id", "")
        if op_id and op_id in self.processed_ops:
            return
        if op_id:
            self.processed_ops[op_id] = time.time()
            self._cleanup_old_ops()

        snap = data.get("data", {}).get("snapshot", "")
        if snap and isinstance(snap, str) and len(snap) > 100:
            room = self.rooms.get(room_id)
            if room is not None:
                room["last_snapshot"] = snap        # 内存里立刻是最新的，广播与兜底都读它
            self._mark_dirty(room_id, data.get("page", 1), snap)
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