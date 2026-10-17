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
import contextlib
import json
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
#: 增量补丁积压阈值：慢连接超过这个条数就不再逐条追，改发 resync 让客户端要一份 keyframe。
#: patch 不能像快照那样"新值顶替旧值"，但也不能让一条慢连接无限堆积。
_MAX_PATCH_BACKLOG = 60
#: 同一房间两次落库的最小间隔（秒）
_PERSIST_MIN_INTERVAL = 3.0


def _encode(message: dict) -> str:
    """一条消息只序列化一次，广播时所有连接复用同一份 JSON 文本。"""
    return json.dumps(message, ensure_ascii=False, separators=(",", ":"))


def _pct(values: list[int] | list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return float(ordered[min(len(ordered) - 1, int(len(ordered) * q))])


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
            "last_snapshot_seq": -1,
            "patch_seq": 0,
            "perf": {
                "ops": 0,
                "sizes": deque(maxlen=200),
                "fanout_ms": deque(maxlen=200),
                "last_report": 0.0,
            },
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
            "sender_task": None,
            "caps": set(),
            "needs_resync": False,
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
                "seq": room.get("last_snapshot_seq", -1),
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

    def _enqueue_conn(self, room_id: int, username: str, conn: dict,
                      message: dict, raw: str | None = None):
        """把消息放进某条连接的队列；raw 由调用方算一次，广播时全班复用。"""
        if raw is None:
            raw = _encode(message)
        item = dict(message)
        item["_raw"] = raw
        outbox = conn["outbox"]
        key = self._coalesce_key(message)
        if key is not None:
            for i, old in enumerate(outbox):
                if self._coalesce_key(old) == key:
                    outbox[i] = item         # 原地顶替：不打乱事件型消息的顺序
                    break
            else:
                outbox.append(item)
        else:
            outbox.append(item)

        # 增量补丁不能折叠，否则学生端会缺记录。慢连接积压太多时直接放弃逐条追，
        # 清掉 patch、发一条 resync，让学生端要一份完整 keyframe。
        if len(outbox) > _MAX_PATCH_BACKLOG:
            kept = deque(m for m in outbox if m.get("type") != "patch_broadcast")
            if len(kept) != len(outbox):
                outbox.clear()
                outbox.extend(kept)
                if not any(m.get("type") == "resync" for m in outbox):
                    resync = {"type": "resync", "reason": "backlog"}
                    outbox.append(dict(resync, _raw=_encode(resync)))

        if len(outbox) > _MAX_QUEUE:
            dropped = outbox.popleft()
            logger.warning(
                f"[白板] 连接积压超 {_MAX_QUEUE}，丢弃最旧消息 "
                f"room={room_id} user={username} type={dropped.get('type')}"
            )
        if not conn["sending"]:
            conn["sending"] = True
            conn["sender_task"] = asyncio.create_task(
                self._drain(room_id, username, conn))

    def _enqueue(self, room_id: int, username: str, message: dict,
                 raw: str | None = None):
        conn = self.rooms.get(room_id, {}).get("connections", {}).get(username)
        if conn is None:
            return
        self._enqueue_conn(room_id, username, conn, message, raw)

    async def _drain(self, room_id: int, username: str, conn: dict):
        """这条连接唯一的发送任务。发不出去就算断线，绝不回头阻塞别人。"""
        try:
            while True:
                outbox = conn["outbox"]
                try:
                    while outbox:
                        item = outbox.popleft()
                        raw = item.get("_raw")
                        # 预编码文本直接发：全班 55 人不必把同一份 JSON 转义 55 遍。
                        if raw is not None and hasattr(conn["ws"], "send_text"):
                            await conn["ws"].send_text(raw)
                        else:
                            await conn["ws"].send_json(
                                {k: v for k, v in item.items() if k != "_raw"})
                except Exception:
                    await self.leave_room(room_id, username)
                    return
                conn["sending"] = False
                if not outbox:
                    return
                conn["sending"] = True     # 让出期间又积压了，继续占位发送
        finally:
            # 任务被取消/异常退出时，别让 sending 永远为 True 把后续消息卡死。
            if conn.get("sender_task") is asyncio.current_task():
                conn["sender_task"] = None
                conn["sending"] = False

    # ── 广播 ──
    async def broadcast(self, room_id: int, message: dict,
                        exclude: str | None = None):
        room = self.rooms.get(room_id)
        if not room:
            return
        raw = _encode(message)             # 一次序列化，全班复用
        for username in list(room["connections"].keys()):
            if username == exclude:
                continue
            self._enqueue(room_id, username, message, raw)

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
        收尾消息必须由这里"先发再关"——直写会和发送任务抢同一个 drain，
        学生端只剩一个没有说明的断开。
        """
        await self.flush_persist(room_id)
        room = self.rooms.pop(room_id, None)   # 先摘房间：队列不再进新消息，发送任务也拿不到连接
        if not room:
            return
        await asyncio.gather(*[
            self._finish_conn(room_id, username, conn, final_message, code, reason)
            for username, conn in list(room.get("connections", {}).items())
        ], return_exceptions=True)

    async def _finish_conn(self, room_id: int, username: str, conn: dict,
                           final_message: dict | None, code: int, reason: str):
        """先让队列把收尾帧发出去，再关闭；超时就取消发送任务，绝不并发写。"""
        if final_message is not None:
            self._enqueue_conn(room_id, username, conn, final_message)
        task = conn.get("sender_task")
        if task is not None:
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=2.0)
            except asyncio.TimeoutError:
                task.cancel()
                with contextlib.suppress(BaseException):
                    await task
            except Exception:
                pass
        try:
            await conn["ws"].close(code=code, reason=reason)
        except Exception:
            pass

    async def send_and_close(self, room_id: int, username: str, message: dict,
                             code: int = 4500, reason: str = "服务端异常，请重连"):
        """给单条连接发最后一帧再关闭（错误分支用）；调用方随后走 leave_room。"""
        conn = self.rooms.get(room_id, {}).get("connections", {}).get(username)
        if conn is None:
            return
        self._enqueue_conn(room_id, username, conn, message)
        task = conn.get("sender_task")
        if task is not None:
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=2.0)
            except asyncio.TimeoutError:
                task.cancel()
                with contextlib.suppress(BaseException):
                    await task
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
                # seq 由服务端统一分配：多端同时写也不会撞号，重连后也不用重新对齐。
                room["last_snapshot_seq"] = room.get("patch_seq", 0)
            self._mark_dirty(room_id, data.get("page", 1), snap)
        t0 = time.monotonic()
        seq = self.rooms.get(room_id, {}).get("last_snapshot_seq", -1)
        await self.broadcast(room_id, {
            "type": "op_broadcast",
            "op_id": op_id,
            "page": data.get("page", 1),
            "sender": username,
            "data": data.get("data", {}),
            "seq": seq,
        }, exclude=username)
        await self.send_to_user(room_id, username, {"type": "keyframe_ack", "seq": seq})
        self._record_perf(room_id, len(snap) if isinstance(snap, str) else 0,
                          (time.monotonic() - t0) * 1000)

    async def handle_patch(self, room_id: int, username: str, data: dict):
        """增量补丁：只广播变化的记录，不落库、不折叠。

        TLDraw 的 RecordsDiff：{added:{id:rec}, updated:{id:[from,to]}, removed:{id:rec}}。
        patch 有严格顺序，慢连接追不上时由 _enqueue_conn 改发 resync。
        """
        changes = data.get("changes")
        if not isinstance(changes, dict):
            return
        room = self.rooms.get(room_id)
        if room is None:
            return
        seq = int(room.get("patch_seq", 0)) + 1
        room["patch_seq"] = seq
        t0 = time.monotonic()
        await self.broadcast(room_id, {
            "type": "patch_broadcast",
            "seq": seq,
            "page": data.get("page", 1),
            "sender": username,
            "changes": changes,
        }, exclude=username)
        # 发送者不回放自己的补丁，但要把"服务端已到第几号"对齐，否则下一条
        # 别人的补丁会被它当成断号。
        await self.send_to_user(room_id, username, {"type": "patch_ack", "seq": seq})
        self._record_perf(room_id, len(_encode(changes)),
                          (time.monotonic() - t0) * 1000)

    def _record_perf(self, room_id: int, size: int, fanout_ms: float):
        """轻量观测：每 30 秒或每 200 次输出一行，别让日志自己变成负担。"""
        room = self.rooms.get(room_id)
        if room is None:
            return
        perf = room.setdefault("perf", {
            "ops": 0, "sizes": deque(maxlen=200),
            "fanout_ms": deque(maxlen=200), "last_report": 0.0,
        })
        perf["ops"] += 1
        perf["sizes"].append(size)
        perf["fanout_ms"].append(fanout_ms)
        now = time.monotonic()
        if perf["ops"] % 200 != 0 and now - perf["last_report"] < 30:
            return
        perf["last_report"] = now
        backlog = max((len(c.get("outbox") or ()) for c in room.get("connections", {}).values()),
                      default=0)
        logger.info(
            f"[白板][perf] room={room_id} ops={perf['ops']} "
            f"payload_p50={_pct(perf['sizes'], 0.5) / 1024:.1f}KB "
            f"payload_p95={_pct(perf['sizes'], 0.95) / 1024:.1f}KB "
            f"fanout_p95={_pct(perf['fanout_ms'], 0.95):.2f}ms "
            f"backlog_max={backlog}"
        )
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
                    "seq": self.rooms[room_id].get("last_snapshot_seq", -1),
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
