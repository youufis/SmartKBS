"""
知识抢答活动 API 路由
教师创建抢答房间 → 学生加入 → 实时抢答 → 自动计分 → 排行榜
"""
import asyncio
import json
import random
import string
import time
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request, Query, WebSocket, WebSocketDisconnect

from backend.api.dependencies import get_current_user
from backend.database import (
    execute_query, execute_query_dict, execute_query_one,
    execute_insert_update, execute_batch, get_connection as smartkb_conn,
)
from backend.logger import logger
from backend.reward_engine import award_participation, award_grade, REWARD_CONFIG
from backend.title_system import check_and_unlock_badges
from backend.question_db import execute_query as qb_execute_query, execute_query_one as qb_execute_query_one
from backend.prompts import apply_skills
from backend.async_utils import spawn_bg

router = APIRouter()

# ── 常量 ──

ROOM_CODE_LENGTH = 6
DEFAULT_TIME_LIMIT = 15  # 秒
DEFAULT_QUESTION_COUNT = 10
SCORE_TIERS = [
    (0, 3, 100),     # 0-3秒: 100分
    (3, 7, 70),      # 3-7秒: 70分
    (7, 11, 40),     # 7-11秒: 40分
    (11, 999, 20),   # 11秒+: 20分
]

# ── 辅助函数 ──

def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _generate_room_code() -> str:
    """生成6位唯一房间码（字母+数字，排除易混淆字符）"""
    chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    for _ in range(100):
        code = "".join(random.choices(chars, k=ROOM_CODE_LENGTH))
        existing = execute_query(
            "SELECT id FROM quick_quiz_rooms WHERE room_code=? AND status IN ('waiting','playing')",
            (code,),
        )
        if not existing:
            return code
    # 极端情况：用时间戳后缀
    return f"R{int(datetime.now().timestamp()) % 100000:05d}"


# ── 计分辅助函数 ──


def _calc_speed_score(time_spent: float, time_limit: int) -> int:
    """速度递减计分：用时越少得分越高（整数分）"""
    min_score = 10
    max_score = 100
    if time_spent <= 0:
        return max_score
    if time_spent >= time_limit:
        return min_score
    decay = (max_score - min_score) / time_limit
    return round(max_score - decay * time_spent)


def _calc_tiered_score(time_spent: float) -> int:
    """分段计分"""
    for lo, hi, score in SCORE_TIERS:
        if lo <= time_spent < hi:
            return score
    return 10


def _get_username_display(username: str) -> str:
    """获取学生显示名"""
    row = execute_query_one(
        "SELECT name FROM users WHERE username=?",
        (username,),
    )
    if row and row.get("name"):
        return row["name"]
    return username


def _get_student_grade_class(username: str) -> tuple[str, str]:
    """查询学生的年级和班级"""
    row = execute_query_one(
        "SELECT grade, class FROM users WHERE username=?",
        (username,),
    )
    if row:
        return str(row.get("grade", "") or ""), str(row.get("class", "") or "")
    return "", ""


def _can_view_room(room: dict[str, Any], username: str, role: int) -> bool:
    """判断用户是否有权限查看/管理该房间"""
    if role == 0:
        # 管理员：全部可见
        return True
    if role == 1:
        # 教师：自己的房间，或管理员创建的房间（同年级/不限年级）
        if room["creator_username"] == username:
            return True
        # 全体学生范围的活动，教师可见
        if room.get("target_scope") == "all":
            return True
        # 管理员创建的房间，教师也可以看
        creator = execute_query_one(
            "SELECT role FROM users WHERE username=?",
            (room["creator_username"],),
        )
        if creator and creator["role"] == 0:
            # 不限年级 或 同年级
            if not room.get("target_grade"):
                return True
            grade, cls = _get_student_grade_class(username)
            if grade and grade == room["target_grade"]:
                if not room.get("target_class"):
                    return True
                # 教师 class 可能是 "1,2,3"，用 INSTR 匹配
                if not room.get("target_class"):
                    return True
                target_classes = str(room["target_class"]).split(",")
                if cls in target_classes:
                    return True
        return False
    if role == 2:
        # 学生：已加入该房间的始终可见（已加入的无论范围如何都可见）
        existing = execute_query_one(
            "SELECT id FROM quick_quiz_players WHERE room_id=? AND student_username=?",
            (room["id"], username),
        )
        if existing:
            return True
        # 使用统一的 permission_service 判断可见性
        from backend.permission_service import check_activity_visibility
        grade, cls = _get_student_grade_class(username)
        return check_activity_visibility(
            student_username=username,
            student_grade=grade,
            student_class=cls,
            creator_username=room["creator_username"],
            target_scope=room.get("target_scope", "teacher_classes") or "teacher_classes",
            target_grade=room.get("target_grade", "") or "",
            target_class=room.get("target_class", "") or "",
            target_users=room.get("target_users", "") or "",
        )
    return False


def _assert_room_manager(room: dict[str, Any], username: str, role: int, action: str = "操作") -> None:
    """S2: 只有创建者或管理员能推进活动进度(reveal 等)"""
    if role != 0 and room["creator_username"] != username:
        raise HTTPException(status_code=403, detail=f"仅创建者可{action}")


def _require_room_member(room: dict[str, Any], username: str, role: int, doing: str) -> None:
    """S6/S7: 活动进行中只允许已加入的玩家(或创建者/管理员)作答与看实时题面/排行"""
    if role == 0 or room["creator_username"] == username:
        return
    joined = execute_query_one(
        "SELECT id FROM quick_quiz_players WHERE room_id=? AND student_username=?",
        (room["id"], username),
    )
    if joined:
        return
    if room.get("status") != "playing" and _can_view_room(room, username, role):
        return      # 未开始/已结束时按可见性放行(教师复盘、学生回看)
    raise HTTPException(status_code=403, detail=f"请先加入该抢答房间后再{doing}")


def _room_to_dict(room: dict[str, Any]) -> dict[str, Any]:
    """将房间数据库行转为返回字典"""
    return {
        "id": room["id"],
        "room_code": room["room_code"],
        "title": room["title"],
        "creator_username": room["creator_username"],
        "status": room["status"],
        "question_source": room["question_source"],
        "question_count": room["question_count"],
        "time_limit": room["time_limit"],
        "scoring_mode": room["scoring_mode"],
        "min_players": room["min_players"],
        "max_players": room["max_players"],
        "target_scope": room.get("target_scope", "teacher_classes") or "teacher_classes",
        "target_grade": room["target_grade"] or "",
        "target_class": room["target_class"] or "",
        "target_users": room.get("target_users", "") or "",
        "subject": room.get("subject", "") or "",
        "knowledge_points": room.get("knowledge_points", "") or "",
        "difficulty": room.get("difficulty", "medium") or "medium",
        "created_at": room["created_at"],
        "started_at": room.get("started_at"),
        "ended_at": room.get("ended_at"),
    }


def _load_questions_from_general_bank(category: str = "", count: int = 10,
                                        exclude_ids: Optional[list[int]] = None) -> list[dict[str, Any]]:
    """从百科题库（smartkb.db quest_question_bank）加载题目"""
    exclude_ids = exclude_ids or []
    conditions = []
    params = []

    if category:
        conditions.append("category=?")
        params.append(category)
    if exclude_ids:
        placeholders = ",".join(["?" for _ in exclude_ids])
        conditions.append(f"id NOT IN ({placeholders})")
        params.extend(exclude_ids)

    where = " AND ".join(conditions) if conditions else "1=1"

    rows = execute_query_dict(
        f"""SELECT id, category, question_text, options, correct_answer, explanation
            FROM quest_question_bank
            WHERE {where}
            ORDER BY RANDOM()
            LIMIT ?""",
        tuple(params + [count]),
    )

    questions = []
    for r in rows:
        opts = {}
        opt_raw = r.get("options")
        if opt_raw:
            try:
                opts = json.loads(opt_raw) if isinstance(opt_raw, str) else opt_raw
            except (json.JSONDecodeError, TypeError):
                opts = {}
        questions.append({
            "id": r.get("id"),
            "question_text": r.get("question_text", ""),
            "options": opts,
            "correct_answer": (r.get("correct_answer") or "").strip().upper(),
            "explanation": r.get("explanation") or "",
            "_bank_type": "general",
        })
    return questions


def _load_questions_from_bank(subject: str = "", knowledge_points: str = "",
                                difficulty: str = "medium", count: int = 10,
                                exclude_ids: Optional[list[int]] = None) -> list[dict[str, Any]]:
    """从学科题库（questions.db question_bank）加载题目"""
    exclude_ids = exclude_ids or []
    conditions = ["status='active'"]
    params = []

    if subject:
        conditions.append("subject=?")
        params.append(subject)
    if knowledge_points:
        kws = [kw.strip() for kw in knowledge_points.split(",") if kw.strip()]
        if kws:
            kw_conditions = " OR ".join(["knowledge_points LIKE ?" for _ in kws])
            conditions.append(f"({kw_conditions})")
            params.extend([f"%{kw}%" for kw in kws])
    if difficulty:
        conditions.append("difficulty=?")
        params.append(difficulty)
    if exclude_ids:
        placeholders = ",".join(["?" for _ in exclude_ids])
        conditions.append(f"id NOT IN ({placeholders})")
        params.extend(exclude_ids)

    where = " AND ".join(conditions)

    rows = qb_execute_query(
        f"""SELECT id, type, question_text, options, correct_answer, explanation,
                   svg_content, has_svg, media_files, media_placeholders
            FROM question_bank
            WHERE {where} AND type IN ('single', 'true_false')
            ORDER BY RANDOM()
            LIMIT ?""",
        tuple(params + [count]),
    )

    questions = []
    for r in rows:
        opts = {}
        opt_raw = r.get("options")
        if opt_raw:
            try:
                opts = json.loads(opt_raw) if isinstance(opt_raw, str) else opt_raw
            except (json.JSONDecodeError, TypeError):
                opts = {}
        # 处理判断题
        if r.get("type") == "true_false":
            opts = {"A": "对", "B": "错"}

        questions.append({
            "id": r.get("id"),
            "question_text": r.get("question_text", ""),
            "options": opts,
            "correct_answer": (r.get("correct_answer") or "").strip().upper(),
            "explanation": r.get("explanation") or "",
            "svg_content": r.get("svg_content") or "",
            "has_svg": r.get("has_svg") or 0,
            "media_files": _parse_json_field(r.get("media_files")),
            "media_placeholders": _parse_json_field(r.get("media_placeholders")),
        })
    return questions


def _parse_json_field(val: Any) -> Any:
    """解析可能为 JSON 字符串的字段，失败时返回原文"""
    if isinstance(val, str):
        try:
            return json.loads(val)
        except (json.JSONDecodeError, TypeError):
            return val
    return val or ""


def _prepare_questions_for_room(room_id: int, room: dict[str, Any]) -> list[dict[str, Any]]:
    """为房间准备题目（从题库加载）"""
    count = room["question_count"]
    source = room["question_source"]
    questions = []

    # ── 学科题库 ──
    if source in ("bank", "bank_academic"):
        try:
            bank_qs = _load_questions_from_bank(
                subject=room.get("subject", ""),
                knowledge_points=room.get("knowledge_points", ""),
                difficulty=room.get("difficulty", "medium"),
                count=count,
            )
            questions.extend(bank_qs)
        except Exception as e:
            logger.warning(f"从学科试题库加载题目失败: {e}")

    # ── 百科题库 ──
    if source == "bank_general":
        if len(questions) < count:
            try:
                general_qs = _load_questions_from_general_bank(count=count)
                questions.extend(general_qs)
            except Exception as e:
                logger.warning(f"从百科题库加载题目失败: {e}")

    # 如果题目不够，用兜底题补齐
    fallbacks = [
        {"question_text": "中国的四大发明不包括以下哪项？",
         "options": {"A": "造纸术", "B": "火药", "C": "电灯", "D": "印刷术"},
         "correct_answer": "C", "explanation": "四大发明是造纸术、火药、印刷术和指南针。"},
        {"question_text": "世界上最长的河流是？",
         "options": {"A": "长江", "B": "亚马逊河", "C": "尼罗河", "D": "密西西比河"},
         "correct_answer": "C", "explanation": "尼罗河全长约6650公里，是世界上最长的河流。"},
        {"question_text": "光在真空中的传播速度约为？",
         "options": {"A": "3×10⁶ m/s", "B": "3×10⁸ m/s", "C": "3×10¹⁰ m/s", "D": "3×10⁴ m/s"},
         "correct_answer": "B", "explanation": "光速约为3×10⁸米/秒。"},
    ]
    while len(questions) < count:
        fb = fallbacks[len(questions) % len(fallbacks)]
        questions.append(dict(fb))

    # 截断到指定数量
    questions = questions[:count]

    # 写入数据库
    operations = []
    for i, q in enumerate(questions):
        operations.append((
            """INSERT INTO quick_quiz_questions
               (room_id, sort_order, question_text, options, correct_answer, explanation, source,
                svg_content, has_svg, media_files, media_placeholders)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (room_id, i + 1, q["question_text"],
             json.dumps(q["options"], ensure_ascii=False),
             q["correct_answer"], q.get("explanation", ""),
             q.get("id") and "bank" or "ai",
             q.get("svg_content", ""), q.get("has_svg", 0),
             q.get("media_files", ""), q.get("media_placeholders", "")),
        ))
    if operations:
        execute_batch(operations)

    return questions


# ── 实时抢答管理器（内存状态） ──

class QuickQuizGameManager:
    """抢答活动状态管理器（内存中维护每局状态）"""

    def __init__(self):
        self.rooms: dict[int, dict[str, Any]] = {}
        # {room_id: {
        #   "current_question": int,        # 当前题号 (1-based)
        #   "phase": str,                   # waiting | question | reveal | ended
        #   "question_start_time": float,   # 本题开始时间戳
        #   "answered_players": set,        # 已作答的玩家用户名
        #   "first_blood": str | None,      # 最先答对的玩家
        #   "answered_in_round": dict,      # {username: {"answer": str, "time_spent": float}}
        #   "time_limit": int,              # 本题时限
        #   "timer_task": asyncio.Task,     # 倒计时任务
        #   "connections": list[WebSocket], # 所有连接
        #   "player_connections": dict,     # {username: WebSocket}
        # }}

    def create_room_state(self, room_id: int, time_limit: int = 15):
        old_state = self.rooms.get(room_id, {})
        old_connections = old_state.get("connections", [])
        old_player_connections = old_state.get("player_connections", {})
        # 保留已有 WebSocket 连接，否则广播发不出去
        self.rooms[room_id] = {
            "current_question": 0,
            "phase": "waiting",
            "question_start_time": 0,
            "answered_players": set(),
            "first_blood": None,
            "answered_in_round": {},
            "time_limit": time_limit,
            "timer_task": None,
            "connections": old_connections,
            "player_connections": old_player_connections,
        }

    def get_room(self, room_id: int) -> dict[str, Any] | None:
        return self.rooms.get(room_id)

    def remove_room(self, room_id: int):
        state = self.rooms.pop(room_id, None)
        if state and state["timer_task"]:
            state["timer_task"].cancel()

    async def add_connection(self, room_id: int, ws: WebSocket):
        await ws.accept()
        state = self.rooms.get(room_id)
        if state:
            state["connections"].append(ws)

    def remove_connection(self, room_id: int, ws: WebSocket):
        state = self.rooms.get(room_id)
        if state:
            if ws in state["connections"]:
                state["connections"].remove(ws)
            # 清理玩家映射
            to_remove = [k for k, v in state["player_connections"].items() if v == ws]
            for k in to_remove:
                del state["player_connections"][k]

    def register_player(self, room_id: int, username: str, ws: WebSocket):
        state = self.rooms.get(room_id)
        if state:
            state["player_connections"][username] = ws

    async def broadcast(self, room_id: int, message: dict[str, Any]):
        """向房间内所有连接广播消息"""
        state = self.rooms.get(room_id)
        if not state:
            return
        disconnected = []
        for ws in state["connections"]:
            try:
                await ws.send_json(message)
            except Exception:
                disconnected.append(ws)
        for ws in disconnected:
            self.remove_connection(room_id, ws)

    async def broadcast_to_player(self, room_id: int, username: str, message: dict[str, Any]):
        """向指定玩家发送消息"""
        state = self.rooms.get(room_id)
        if not state:
            return
        ws = state["player_connections"].get(username)
        if ws:
            try:
                await ws.send_json(message)
            except Exception:
                self.remove_connection(room_id, ws)

    async def start_timer(self, room_id: int, room_coro):
        """启动倒计时，超时后自动 reveal"""
        state = self.rooms.get(room_id)
        if not state:
            return
        try:
            await asyncio.sleep(state["time_limit"])
            # 倒计时结束，自动公布答案
            if state["phase"] == "question":
                await room_coro.reveal_answer(room_id)
        except asyncio.CancelledError:
            pass


# 全局单例
game_manager = QuickQuizGameManager()


# ════════════════════════════════════════════
# REST API 端点
# ════════════════════════════════════════════

@router.post("/quick-quiz/room", summary="创建抢答房间")
async def create_room(request: Request):
    """教师创建一个新的抢答房间"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可创建抢答活动")

    body = await request.json()
    title = body.get("title", "知识抢答")
    question_source = body.get("question_source", "bank")
    question_count = int(body.get("question_count", DEFAULT_QUESTION_COUNT))
    time_limit = int(body.get("time_limit", DEFAULT_TIME_LIMIT))
    scoring_mode = body.get("scoring_mode", "speed")
    min_players = int(body.get("min_players", 1))
    max_players = int(body.get("max_players", 50))
    target_scope = body.get("target_scope", "teacher_classes") or "teacher_classes"
    target_grade = body.get("target_grade", "")
    target_class = body.get("target_class", "")
    target_users = body.get("target_users", "") or ""
    # 教师未指定年级/班级时，自动填充自己的（仅兼容旧模式）
    if not target_scope or target_scope == "teacher_classes":
        if role == 1 and not target_grade:
            auto_grade, auto_cls = _get_student_grade_class(username)
            if auto_grade and not target_grade:
                target_grade = auto_grade
            if auto_cls and not target_class:
                target_class = auto_cls
    subject = body.get("subject", "")
    knowledge_points = body.get("knowledge_points", "")
    difficulty = body.get("difficulty", "medium")

    room_code = _generate_room_code()
    now = _now()

    room_id = execute_insert_update(
        """INSERT INTO quick_quiz_rooms
           (room_code, title, creator_username, status, question_source, question_count,
            time_limit, scoring_mode, min_players, max_players,
            target_scope, target_grade, target_class, target_users,
            subject, knowledge_points, difficulty,
            created_at)
           VALUES (?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (room_code, title, username, question_source, question_count,
         time_limit, scoring_mode, min_players, max_players,
         target_scope, target_grade, target_class, target_users,
         subject, knowledge_points, difficulty,
         now),
    )

    # 初始化内存状态
    assert room_id is not None
    game_manager.create_room_state(room_id, time_limit)

    room = execute_query_one(
        "SELECT * FROM quick_quiz_rooms WHERE id=?",
        (room_id,),
    )
    if room is None:
        raise HTTPException(status_code=404, detail="房间不存在")
    return _room_to_dict(room)


@router.get("/quick-quiz/rooms", summary="获取抢答房间列表")
async def list_rooms(
    request: Request,
    status: str = Query("", description="筛选状态"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),   # S11: 分页上限
):
    """获取抢答房间列表
    管理员：全部可见
    教师：自己的 + 管理员创建的同年级
    学生：本班教师的 + 管理员创建的
    """
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    conditions = []
    params = []

    if role == 0:
        # 管理员：全部
        pass
    elif role == 1:
        # 教师：仅查看和管理自己创建的房间
        conditions.append("qq.creator_username=?")
        params.append(username)
    elif role == 2:
        # 学生：仅看等待中/进行中的活动
        conditions.append("qq.status IN ('waiting','playing')")

    if status:
        conditions.append("qq.status=?")
        params.append(status)

    where = " AND ".join(conditions) if conditions else "1=1"
    offset = (page - 1) * page_size

    rows = execute_query_dict(
        f"""SELECT qq.*, COALESCE(u.name, u.username) AS creator_name
            FROM quick_quiz_rooms qq
            LEFT JOIN users u ON qq.creator_username = u.username
            WHERE {where}
            ORDER BY qq.created_at DESC
            LIMIT ? OFFSET ?""",
        tuple(params + [page_size, offset]),
    )

    # 获取每个房间的玩家数
    result = []
    for r in rows:
        room = _room_to_dict(r)
        # 对学生角色做细粒度权限过滤（支持 target_scope 统一判断）
        if role == 2 and not _can_view_room(r, username, role):
            continue
        player_count = execute_query_one(
            "SELECT COUNT(*) as cnt FROM quick_quiz_players WHERE room_id=?",
            (r["id"],),
        )
        room["player_count"] = player_count["cnt"] if player_count else 0
        room["creator_name"] = r.get("creator_name", "")
        result.append(room)

    total = execute_query_one(
        f"SELECT COUNT(*) as cnt FROM quick_quiz_rooms qq WHERE {where}",
        tuple(params),
    )

    return {"rooms": result, "total": total["cnt"] if total else 0}


@router.get("/quick-quiz/room/{room_id}", summary="获取房间详情")
async def get_room(room_id: int, request: Request):
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    room = execute_query_one("SELECT * FROM quick_quiz_rooms WHERE id=?", (room_id,))
    if not room:
        raise HTTPException(status_code=404, detail="房间不存在")
    if not _can_view_room(room, username, role):
        raise HTTPException(status_code=403, detail="无权查看此房间")

    result = _room_to_dict(room)

    # 玩家列表
    players = execute_query_dict(
        """SELECT student_username, student_name, total_score, correct_count, wrong_count, streak
           FROM quick_quiz_players WHERE room_id=? ORDER BY total_score DESC""",
        (room_id,),
    )
    result["players"] = players
    result["player_count"] = len(players)

    # 当前题号
    state = game_manager.get_room(room_id)
    result["current_question"] = state["current_question"] if state else 0
    result["phase"] = state["phase"] if state else "waiting"

    return result


@router.put("/quick-quiz/room/{room_id}", summary="更新房间配置")
async def update_room(room_id: int, request: Request):
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    room = execute_query_one(
        "SELECT * FROM quick_quiz_rooms WHERE id=?",
        (room_id,),
    )
    if not room:
        raise HTTPException(status_code=404, detail="房间不存在")
    if room["creator_username"] != username and role != 0:
        raise HTTPException(status_code=403, detail="无权修改")
    if room["status"] != "waiting":
        raise HTTPException(status_code=400, detail="活动已开始，无法修改")

    body = await request.json()
    upd_fields = []
    upd_params = []

    for field in ["title", "question_source", "question_count", "time_limit",
                   "scoring_mode", "min_players", "max_players",
                   "target_scope", "target_grade", "target_class", "target_users",
                   "subject", "knowledge_points", "difficulty"]:
        if field in body:
            upd_fields.append(f"{field}=?")
            upd_params.append(body[field])

    if upd_fields:
        upd_params.append(room_id)
        execute_insert_update(
            f"UPDATE quick_quiz_rooms SET {', '.join(upd_fields)} WHERE id=?",
            tuple(upd_params),
        )

    return {"message": "已更新"}


@router.delete("/quick-quiz/room/{room_id}", summary="删除房间")
async def delete_room(room_id: int, request: Request):
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    room = execute_query_one("SELECT * FROM quick_quiz_rooms WHERE id=?", (room_id,))
    if not room:
        raise HTTPException(status_code=404, detail="房间不存在")
    if room["creator_username"] != username and role != 0:
        raise HTTPException(status_code=403, detail="无权删除")

    # 清理数据
    execute_insert_update("DELETE FROM quick_quiz_rankings WHERE room_id=?", (room_id,))
    execute_insert_update("DELETE FROM quick_quiz_answers WHERE room_id=?", (room_id,))
    execute_insert_update("DELETE FROM quick_quiz_questions WHERE room_id=?", (room_id,))
    execute_insert_update("DELETE FROM quick_quiz_players WHERE room_id=?", (room_id,))
    execute_insert_update("DELETE FROM activity_rewards WHERE activity_type='quick_quiz' AND activity_id=?", (str(room_id),))
    execute_insert_update("DELETE FROM notifications WHERE source_type='quick_quiz' AND source_id=?", (str(room_id),))
    execute_insert_update("DELETE FROM quick_quiz_rooms WHERE id=?", (room_id,))

    game_manager.remove_room(room_id)

    return {"message": "已删除"}


@router.post("/quick-quiz/join", summary="加入抢答房间")
async def join_room(request: Request):
    """学生通过房间码加入抢答活动"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role != 2:
        raise HTTPException(status_code=403, detail="仅学生可加入抢答活动")

    body = await request.json()
    room_code = body.get("room_code", "").strip().upper()
    if not room_code:
        raise HTTPException(status_code=400, detail="请输入房间码")

    room = execute_query_one(
        "SELECT * FROM quick_quiz_rooms WHERE room_code=? AND status IN ('waiting','playing')",
        (room_code,),
    )
    if not room:
        raise HTTPException(status_code=404, detail="房间不存在或活动已结束")

    # 校验权限：学生只能加入自己班级的（或管理员创建的）
    if not _can_view_room(room, username, role):
        raise HTTPException(status_code=403, detail="该活动仅限指定班级参加")

    # 检查是否已加入
    existing = execute_query_one(
        "SELECT id FROM quick_quiz_players WHERE room_id=? AND student_username=?",
        (room["id"], username),
    )
    if existing:
        return {"room_id": room["id"], "room": _room_to_dict(room), "already_joined": True}

    # 检查人数限制
    player_count = execute_query_one(
        "SELECT COUNT(*) as cnt FROM quick_quiz_players WHERE room_id=?",
        (room["id"],),
    )
    if player_count and player_count["cnt"] >= room["max_players"]:
        raise HTTPException(status_code=400, detail="房间已满")

    grade, cls = _get_student_grade_class(username)
    student_name = _get_username_display(username)
    now = _now()

    execute_insert_update(
        """INSERT INTO quick_quiz_players
           (room_id, student_username, student_name, grade, class_name, total_score,
            correct_count, wrong_count, total_time, streak, max_streak, joined_at)
           VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, ?)""",
        (room["id"], username, student_name, grade, cls, now),
    )

    # 广播玩家列表更新
    await _broadcast_player_list(room["id"])

    return {"room_id": room["id"], "room": _room_to_dict(room), "already_joined": False}


@router.post("/quick-quiz/room/{room_id}/start", summary="开始抢答活动")
async def start_quiz(room_id: int, request: Request):
    """教师开始抢答活动，准备题目并推送第一题"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    room = execute_query_one("SELECT * FROM quick_quiz_rooms WHERE id=?", (room_id,))
    if not room:
        raise HTTPException(status_code=404, detail="房间不存在")
    if room["creator_username"] != username and role != 0:
        raise HTTPException(status_code=403, detail="仅创建者可开始")
    if room["status"] != "waiting":
        raise HTTPException(status_code=400, detail="活动已开始或已结束")

    # 检查玩家数量
    player_count = execute_query_one(
        "SELECT COUNT(*) as cnt FROM quick_quiz_players WHERE room_id=?",
        (room_id,),
    )
    if not player_count or player_count["cnt"] < 1:
        raise HTTPException(status_code=400, detail=f"至少需要1名玩家才能开始")

    now = _now()
    execute_insert_update(
        "UPDATE quick_quiz_rooms SET status='playing', started_at=? WHERE id=?",
        (now, room_id),
    )

    # 准备题目
    questions = _prepare_questions_for_room(room_id, room)

    # 重置内存状态
    game_manager.create_room_state(room_id, room["time_limit"])

    # 广播游戏开始
    await game_manager.broadcast(room_id, {
        "type": "game_start",
        "data": {
            "total_questions": len(questions),
            "time_limit": room["time_limit"],
            "scoring_mode": room["scoring_mode"],
        }
    })

    # 推送第一题
    await _push_question(room_id, 1)

    return {"message": "活动已开始", "total_questions": len(questions)}


@router.post("/quick-quiz/room/{room_id}/next", summary="下一题")
async def next_question(room_id: int, request: Request):
    """教师手动切换到下一题"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    room = execute_query_one("SELECT * FROM quick_quiz_rooms WHERE id=?", (room_id,))
    if not room:
        raise HTTPException(status_code=404, detail="房间不存在")
    if room["creator_username"] != username and role != 0:
        raise HTTPException(status_code=403, detail="仅创建者可操作")
    if room["status"] != "playing":
        raise HTTPException(status_code=400, detail="活动未在进行中")

    state = game_manager.get_room(room_id)
    if not state:
        raise HTTPException(status_code=400, detail="游戏状态异常")

    current = state["current_question"]
    if current >= room["question_count"]:
        raise HTTPException(status_code=400, detail="已经是最后一题")

    await _push_question(room_id, current + 1)

    return {"message": f"已切换到第 {current + 1} 题"}


@router.post("/quick-quiz/room/{room_id}/reveal", summary="公布答案")
async def reveal_answer(room_id: int, request: Request):
    """教师手动公布当前题目的答案（或倒计时自动调用）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    room = execute_query_one("SELECT * FROM quick_quiz_rooms WHERE id=?", (room_id,))
    if not room:
        raise HTTPException(status_code=404, detail="房间不存在")
    # S2: 旧实现取了 role 却完全不校验, 任何学生都能自行公布答案并推进进度
    _assert_room_manager(room, username, role, "公布答案")

    result = await _do_reveal(room_id)
    if not result:
        raise HTTPException(status_code=400, detail="当前没有活跃题目或已公布")

    return result


@router.get("/quick-quiz/room/{room_id}/bank-questions", summary="从题库选题")
async def list_bank_questions(
    room_id: int,
    request: Request,
    bank_type: str = Query("academic", description="题库类型: academic|general"),
    subject: str = Query("", description="筛选学科（仅academic）"),
    difficulty: str = Query("", description="筛选难度（仅academic）"),
    category: str = Query("", description="筛选分类（仅general）"),
    keyword: str = Query("", description="关键词搜索"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=50),
):
    """获取试题库中可选题目（排除已添加到当前房间的）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师可操作")

    room = execute_query_one("SELECT * FROM quick_quiz_rooms WHERE id=?", (room_id,))
    if not room:
        raise HTTPException(status_code=404, detail="房间不存在")

    # 获取已在此房间的题目ID（用于排除）
    existing_ids = execute_query(
        "SELECT source_question_id FROM quick_quiz_questions WHERE room_id=? AND source='bank' AND source_question_id IS NOT NULL",
        (room_id,),
    )
    exclude = [r[0] for r in existing_ids if r[0] is not None]

    if bank_type == "general":
        # ── 百科题库（quest_question_bank） ──
        conditions = []
        params = []
        if category:
            conditions.append("category=?")
            params.append(category)
        if keyword:
            conditions.append("question_text LIKE ?")
            params.append(f"%{keyword}%")
        if exclude:
            placeholders = ",".join(["?" for _ in exclude])
            conditions.append(f"id NOT IN ({placeholders})")
            params.extend(exclude)
        where = " AND ".join(conditions) if conditions else "1=1"

        count_row = execute_query_one(
            f"SELECT COUNT(*) as cnt FROM quest_question_bank WHERE {where}",
            tuple(params),
        )
        total = count_row["cnt"] if count_row else 0

        offset = (page - 1) * page_size
        rows = execute_query_dict(
            f"""SELECT id, category, question_text, options, correct_answer, explanation
                FROM quest_question_bank
                WHERE {where}
                ORDER BY RANDOM()
                LIMIT ? OFFSET ?""",
            tuple(params) + (page_size, offset),
        )

        questions = []
        for r in rows:
            opts = {}
            opt_raw = r.get("options")
            if opt_raw:
                try:
                    opts = json.loads(opt_raw) if isinstance(opt_raw, str) else opt_raw
                except (json.JSONDecodeError, TypeError):
                    opts = {}
            questions.append({
                "id": r.get("id"),
                "type": "single",
                "question_text": r.get("question_text", ""),
                "options": opts,
                "correct_answer": (r.get("correct_answer") or "").strip().upper(),
                "explanation": r.get("explanation") or "",
                "difficulty": "",
                "knowledge_points": r.get("category", ""),
                "subject": "",
                "_bank_type": "general",
            })

    else:
        # ── 学科题库（question_bank） ──
        conditions = ["status='active'", "type IN ('single','true_false')"]
        params = []
        if subject:
            conditions.append("subject=?")
            params.append(subject)
        if difficulty:
            conditions.append("difficulty=?")
            params.append(difficulty)
        if keyword:
            conditions.append("(question_text LIKE ? OR knowledge_points LIKE ?)")
            kw = f"%{keyword}%"
            params.extend([kw, kw])
        if exclude:
            placeholders = ",".join(["?" for _ in exclude])
            conditions.append(f"id NOT IN ({placeholders})")
            params.extend(exclude)
        where = " AND ".join(conditions)

        count_row = qb_execute_query_one(
            f"SELECT COUNT(*) as cnt FROM question_bank WHERE {where}",
            tuple(params),
        )
        total = count_row["cnt"] if count_row else 0

        offset = (page - 1) * page_size
        rows = qb_execute_query(
            f"""SELECT id, type, question_text, options, correct_answer, explanation,
                       difficulty, knowledge_points, subject
                FROM question_bank
                WHERE {where}
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?""",
            tuple(params) + (page_size, offset),
        )

        questions = []
        for r in rows:
            opts = {}
            opt_raw = r.get("options")
            if opt_raw:
                try:
                    opts = json.loads(opt_raw) if isinstance(opt_raw, str) else opt_raw
                except (json.JSONDecodeError, TypeError):
                    opts = {}
            if r.get("type") == "true_false":
                opts = {"A": "对", "B": "错"}
            questions.append({
                "id": r.get("id"),
                "type": r.get("type"),
                "question_text": r.get("question_text", ""),
                "options": opts,
                "correct_answer": (r.get("correct_answer") or "").strip().upper(),
                "explanation": r.get("explanation") or "",
                "difficulty": r.get("difficulty") or "",
                "knowledge_points": r.get("knowledge_points") or "",
                "subject": r.get("subject") or "",
                "_bank_type": "academic",
            })

    return {"questions": questions, "total": total, "page": page, "page_size": page_size, "bank_type": bank_type}


@router.post("/quick-quiz/room/{room_id}/add-bank-questions", summary="从题库选题加入房间")
async def add_bank_questions(room_id: int, request: Request):
    """教师从试题库选取题目加入抢答房间"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师可操作")

    room = execute_query_one("SELECT * FROM quick_quiz_rooms WHERE id=?", (room_id,))
    if not room:
        raise HTTPException(status_code=404, detail="房间不存在")
    if room["creator_username"] != username and role != 0:
        raise HTTPException(status_code=403, detail="仅创建者可操作")

    body = await request.json()
    question_ids = body.get("question_ids", [])
    bank_type = body.get("bank_type", "academic")
    if not question_ids:
        raise HTTPException(status_code=400, detail="请选择题目")

    # 根据题库类型查询题目
    placeholders = ",".join(["?" for _ in question_ids])
    if bank_type == "general":
        rows = execute_query_dict(
            f"""SELECT id, question_text, options, correct_answer, explanation,
                       '' as svg_content, 0 as has_svg, '' as media_files, '' as media_placeholders
                FROM quest_question_bank
                WHERE id IN ({placeholders})""",
            tuple(question_ids),
        )
        # 统一格式，type 设为 single
        for r in rows:
            r["type"] = "single"
    else:
        rows = qb_execute_query(
            f"""SELECT id, type, question_text, options, correct_answer, explanation,
                       svg_content, has_svg, media_files, media_placeholders
                FROM question_bank
                WHERE id IN ({placeholders}) AND status='active' AND type IN ('single','true_false')""",
            tuple(question_ids),
        )
    if not rows:
        raise HTTPException(status_code=404, detail="未找到有效题目")

    # 计算当前最大题号
    max_order = execute_query_one(
        "SELECT COALESCE(MAX(sort_order), 0) as max_order FROM quick_quiz_questions WHERE room_id=?",
        (room_id,),
    )
    next_order = (max_order["max_order"] if max_order else 0) + 1

    operations = []
    added = []
    for i, r in enumerate(rows):
        opts = {}
        opt_raw = r.get("options")
        if opt_raw:
            try:
                opts = json.loads(opt_raw) if isinstance(opt_raw, str) else opt_raw
            except (json.JSONDecodeError, TypeError):
                opts = {}
        if r.get("type") == "true_false":
            opts = {"A": "对", "B": "错"}

        q_text = r.get("question_text", "")
        q_answer = (r.get("correct_answer") or "").strip().upper()
        q_explanation = r.get("explanation") or ""
        q_id = r.get("id")

        sort_order = next_order + i
        options_json = json.dumps(opts, ensure_ascii=False)
        operations.append((
            """INSERT INTO quick_quiz_questions
               (room_id, sort_order, question_text, options, correct_answer, explanation, source, source_question_id,
                svg_content, has_svg, media_files, media_placeholders)
               VALUES (?, ?, ?, ?, ?, ?, 'bank', ?, ?, ?, ?, ?)""",
            (room_id, sort_order, q_text, options_json, q_answer, q_explanation, q_id,
             r.get("svg_content", ""), r.get("has_svg", 0),
             r.get("media_files", ""), r.get("media_placeholders", "")),
        ))
        added.append({
            "sort_order": sort_order,
            "question_text": q_text,
            "options": opts,
            "correct_answer": q_answer,
            "svg_content": r.get("svg_content", ""),
            "has_svg": r.get("has_svg", 0),
            "media_files": r.get("media_files", ""),
            "media_placeholders": r.get("media_placeholders", ""),
        })

    if operations:
        execute_batch(operations)

    # 更新房间总题数
    total_q = execute_query_one(
        "SELECT COUNT(*) as cnt FROM quick_quiz_questions WHERE room_id=?",
        (room_id,),
    )
    execute_insert_update(
        "UPDATE quick_quiz_rooms SET question_count=? WHERE id=?",
        (total_q["cnt"] if total_q else (next_order + len(rows) - 1), room_id),
    )

    return {
        "added_count": len(added),
        "questions": added,
        "total_questions": total_q["cnt"] if total_q else (next_order + len(rows) - 1),
    }


@router.post("/quick-quiz/room/{room_id}/end", summary="结束活动")
async def end_quiz(room_id: int, request: Request):
    """教师提前结束抢答活动"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    room = execute_query_one("SELECT * FROM quick_quiz_rooms WHERE id=?", (room_id,))
    if not room:
        raise HTTPException(status_code=404, detail="房间不存在")
    if room["creator_username"] != username and role != 0:
        raise HTTPException(status_code=403, detail="仅创建者可操作")

    await _do_end_game(room_id)

    return {"message": "活动已结束"}


@router.post("/quick-quiz/room/{room_id}/answer", summary="提交答案")
async def submit_answer(room_id: int, request: Request):
    """学生提交当前题目的答案"""
    user = get_current_user(request)
    username = user["username"]

    room = execute_query_one("SELECT * FROM quick_quiz_rooms WHERE id=?", (room_id,))
    if not room:
        raise HTTPException(status_code=404, detail="房间不存在")
    if room["status"] != "playing":
        raise HTTPException(status_code=400, detail="活动未在进行中")
    # S7: 必须先通过房间码 join, 否则答案写进明细却进不了 players/排行, 数据自相矛盾
    _require_room_member(room, username, user.get("role", 2), "作答")

    state = game_manager.get_room(room_id)
    if not state or state["phase"] != "question":
        raise HTTPException(status_code=400, detail="当前没有活跃题目")

    # 检查是否已作答
    if username in state["answered_players"]:
        raise HTTPException(status_code=400, detail="您已作答，请等待下一题")

    body = await request.json()
    answer = body.get("answer", "").strip().upper()
    if not answer:
        raise HTTPException(status_code=400, detail="请选择答案")

    # 计算用时
    time_spent = round(time.time() - state["question_start_time"], 1)

    # 获取当前题目
    current_q = state["current_question"]
    question = execute_query_one(
        "SELECT * FROM quick_quiz_questions WHERE room_id=? AND sort_order=?",
        (room_id, current_q),
    )
    if not question:
        raise HTTPException(status_code=404, detail="题目不存在")

    correct_answer = question["correct_answer"].strip().upper()
    is_correct = 1 if answer == correct_answer else 0

    # 获取玩家信息
    player = execute_query_one(
        "SELECT * FROM quick_quiz_players WHERE room_id=? AND student_username=?",
        (room_id, username),
    )

    # 计分：根据 scoring_mode 计算
    room_data = execute_query_one("SELECT scoring_mode FROM quick_quiz_rooms WHERE id=?", (room_id,))
    scoring_mode = room_data["scoring_mode"] if room_data else "simple"
    if scoring_mode == "speed":
        score = _calc_speed_score(time_spent, state["time_limit"]) if is_correct else -20
    elif scoring_mode == "tiered":
        score = _calc_tiered_score(time_spent) if is_correct else -20
    else:
        score = 1 if is_correct else -2
    streak = (player["streak"] if player else 0) + 1 if is_correct else 0

    # 记录答题
    now = _now()
    execute_insert_update(
        """INSERT INTO quick_quiz_answers
           (room_id, question_id, student_username, answer, is_correct, time_spent, score, answered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (room_id, question["id"], username, answer, is_correct, time_spent, score, now),
    )

    # W7: 随堂测验答错也进错题本(仅题库来源的题目可追溯; 现场生成的题不在题库)
    if not is_correct and (question.get("source") or "") == "bank" and question.get("source_question_id"):
        try:
            from backend.api.wrong_book_router import record_single_wrong
            spawn_bg(record_single_wrong, username, question["source_question_id"], answer,
                     "quiz", room_id, name="随堂测验错题入库")
        except Exception as wb_err:
            logger.warning(f"随堂测验错题入库失败 (room={room_id}, user={username}): {wb_err}")

    # 更新玩家统计
    old_streak = player["streak"] if player else 0
    new_correct = (player["correct_count"] if player else 0) + (1 if is_correct else 0)
    new_wrong = (player["wrong_count"] if player else 0) + (0 if is_correct else 1)
    new_total_time = (player["total_time"] if player else 0) + time_spent
    new_score = (player["total_score"] if player else 0) + score
    new_max_streak = max(player["max_streak"] if player else 0, streak)

    new_score = max(0, new_score)   # S11: 扣分模式不让排行榜出现负分
    updated = execute_insert_update(
        """UPDATE quick_quiz_players
           SET total_score=?, correct_count=?, wrong_count=?, total_time=?,
               streak=?, max_streak=?
           WHERE room_id=? AND student_username=?""",
        (new_score, new_correct, new_wrong, new_total_time,
         streak, new_max_streak, room_id, username),
    )
    if not updated:
        # S7: 兜底补建玩家行, 避免"答案已入库但统计里没有这个人"
        grade, cls = _get_student_grade_class(username)
        name_row = execute_query_one("SELECT name FROM users WHERE username=?", (username,))
        execute_insert_update(
            """INSERT OR IGNORE INTO quick_quiz_players
               (room_id, student_username, student_name, grade, class_name, total_score,
                correct_count, wrong_count, total_time, streak, max_streak, joined_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (room_id, username, (name_row["name"] if name_row else "") or username,
             grade, cls, new_score, new_correct, new_wrong, new_total_time,
             streak, new_max_streak, now),
        )

    # 标记已作答
    state["answered_players"].add(username)
    state["answered_in_round"][username] = {
        "answer": answer,
        "is_correct": is_correct,
        "time_spent": time_spent,
        "score": score,
    }

    # 检查是否所有人已答完
    total_players = execute_query_one(
        "SELECT COUNT(*) as cnt FROM quick_quiz_players WHERE room_id=?",
        (room_id,),
    )
    all_answered = total_players and len(state["answered_players"]) >= total_players["cnt"]

    # 广播有人作答（匿名）
    correct_count = sum(1 for d in state["answered_in_round"].values() if d["is_correct"])
    await game_manager.broadcast(room_id, {
        "type": "someone_answered",
        "data": {
            "answered_count": len(state["answered_players"]),
            "total_players": total_players["cnt"] if total_players else 0,
            "correct_count": correct_count,
            "all_answered": bool(all_answered),
        }
    })
    # 通知该玩家自己的结果
    await game_manager.broadcast_to_player(room_id, username, {
        "type": "your_answer_result",
        "data": {
            "is_correct": bool(is_correct),
            "score": score,
            "time_spent": time_spent,
            "correct_answer": correct_answer if is_correct else None,
        }
    })

    # 所有人已答完，前端收到 all_answered 后会主动调 reveal
    if all_answered:
        if state["timer_task"]:
            state["timer_task"].cancel()
            state["timer_task"] = None

    return {
        "is_correct": bool(is_correct),
        "score": score,
        "time_spent": time_spent,
        "correct_answer": correct_answer,
        "total_score": new_score,
        "all_answered": bool(all_answered),
    }


@router.get("/quick-quiz/room/{room_id}/current-question", summary="获取当前题目")
async def get_current_question(room_id: int, request: Request):
    """获取抢答活动的当前题目（学生延迟加入/重连时使用）"""
    user = get_current_user(request)

    room = execute_query_one("SELECT * FROM quick_quiz_rooms WHERE id=?", (room_id,))
    if not room:
        raise HTTPException(status_code=404, detail="房间不存在")
    # S6: 进行中不把题面发给未加入者(可提前偷题)
    _require_room_member(room, user["username"], user.get("role", 2), "获取题目")

    state = game_manager.get_room(room_id)
    phase = state["phase"] if state else room.get("status", "waiting")
    current_idx = state["current_question"] if state else 0

    # 如果内存状态不在了（进程重启等情况），从 DB 推断
    if not state:
        # 尝试从 quick_quiz_questions 取第一道题
        first_q = execute_query_one(
            "SELECT * FROM quick_quiz_questions WHERE room_id=? ORDER BY sort_order ASC LIMIT 1",
            (room_id,),
        )
        if first_q and room.get("status") == "playing":
            phase = "question"
            current_idx = first_q["sort_order"]

    if phase not in ("question",):
        return {"phase": phase, "question": None, "current_question": current_idx, "total_questions": room.get("question_count", 0)}

    question = execute_query_one(
        "SELECT * FROM quick_quiz_questions WHERE room_id=? AND sort_order=?",
        (room_id, current_idx),
    )
    if not question:
        return {"phase": phase, "question": None, "current_question": current_idx, "total_questions": room.get("question_count", 0)}

    options = json.loads(question["options"]) if isinstance(question["options"], str) else question["options"]
    total_q = execute_query_one(
        "SELECT COUNT(*) as cnt FROM quick_quiz_questions WHERE room_id=?",
        (room_id,),
    )

    time_limit = state["time_limit"] if state else 15

    return {
        "phase": phase,
        "current_question": current_idx,
        "total_questions": total_q["cnt"] if total_q else room.get("question_count", 0),
        "question": {
            "sort_order": question["sort_order"],
            "question_text": question["question_text"],
            "options": options,
            "time_limit": time_limit,
            "total_questions": total_q["cnt"] if total_q else room.get("question_count", 0),
            "svg_content": question.get("svg_content", ""),
            "has_svg": question.get("has_svg", 0),
            "media_files": question.get("media_files", ""),
            "media_placeholders": question.get("media_placeholders", ""),
        }
    }


@router.get("/quick-quiz/room/{room_id}/result", summary="获取活动结果")
async def get_result(room_id: int, request: Request):
    """获取抢答活动的完整结果"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    room = execute_query_one("SELECT * FROM quick_quiz_rooms WHERE id=?", (room_id,))
    if not room:
        raise HTTPException(status_code=404, detail="房间不存在")
    # S3: 结果页含每题正确答案/解析与他人逐题作答, 必须先过房间可见性
    if not _can_view_room(room, username, role):
        raise HTTPException(status_code=403, detail="无权查看此房间")
    # 学生只看自己的作答; 活动结束前不下发正确答案与解析
    student_view = role == 2 and room["creator_username"] != username
    hide_answer = student_view and room.get("status") != "ended"

    # 排行榜
    ranking = execute_query_dict(
        """SELECT student_username, student_name, total_score, correct_count, wrong_count,
                  total_time, max_streak
           FROM quick_quiz_players
           WHERE room_id=?
           ORDER BY total_score DESC, correct_count DESC, total_time ASC""",
        (room_id,),
    )

    # 每题回顾
    questions = execute_query_dict(
        "SELECT * FROM quick_quiz_questions WHERE room_id=? ORDER BY sort_order",
        (room_id,),
    )

    # S3/S9: 一次取回全部作答并按题目分组(旧实现每题一次查询)
    all_answers = execute_query_dict(
        """SELECT a.question_id, a.student_username, a.answer, a.is_correct, a.time_spent, a.score
           FROM quick_quiz_answers a
           JOIN quick_quiz_questions q2 ON q2.id = a.question_id
           WHERE q2.room_id = ?
           ORDER BY a.time_spent ASC""",
        (room_id,),
    )
    answers_by_q: dict[int, list[dict[str, Any]]] = {}
    for a in all_answers:
        answers_by_q.setdefault(a["question_id"], []).append(a)

    question_details = []
    for q in questions:
        answers = answers_by_q.get(q["id"], [])
        options = json.loads(q["options"]) if isinstance(q["options"], str) else q["options"]

        # 统计各选项分布
        option_stats = {}
        for opt_key in options:
            option_stats[opt_key] = 0
        for a in answers:
            ans = a["answer"]
            if ans in option_stats:
                option_stats[ans] += 1

        shown_answers = [a for a in answers if a["student_username"] == username] if student_view else answers
        question_details.append({
            "sort_order": q["sort_order"],
            "question_text": q["question_text"],
            "options": options,
            "correct_answer": "" if hide_answer else q["correct_answer"],
            "explanation": "" if hide_answer else q["explanation"],
            "svg_content": q.get("svg_content", ""),
            "has_svg": q.get("has_svg", 0),
            "media_files": q.get("media_files", ""),
            "media_placeholders": q.get("media_placeholders", ""),
            "correct_count": sum(1 for a in answers if a["is_correct"] == 1),
            "total_answers": len(answers),
            "option_stats": option_stats,
            "answers": shown_answers,
        })

    # 我的信息
    my_info = execute_query_one(
        "SELECT * FROM quick_quiz_players WHERE room_id=? AND student_username=?",
        (room_id, username),
    )

    # 结果页: 排行榜与每题作答明细里的学生都补上年级班级
    from backend.permission_service import attach_student_info
    attach_student_info(ranking, key="student_username", prefix="student_")
    for _qd in question_details:
        if isinstance(_qd, dict):
            attach_student_info(_qd.get("answers") or [], key="student_username", prefix="student_")
    return {
        "room": _room_to_dict(room),
        "ranking": ranking,
        "questions": question_details,
        "my_info": my_info,
    }


@router.get("/quick-quiz/room/{room_id}/ranking", summary="获取排行榜")
async def get_ranking(room_id: int, request: Request):
    """获取当前排行榜"""
    user = get_current_user(request)
    room = execute_query_one("SELECT * FROM quick_quiz_rooms WHERE id=?", (room_id,))
    if not room:
        raise HTTPException(status_code=404, detail="房间不存在")
    # S6: 排行含全班学号与姓名, 进行中只对玩家/创建者/管理员开放
    _require_room_member(room, user["username"], user.get("role", 2), "查看排行")

    ranking = execute_query_dict(
        """SELECT student_username, student_name, total_score, correct_count, wrong_count,
                  total_time, max_streak
           FROM quick_quiz_players
           WHERE room_id=?
           ORDER BY total_score DESC, correct_count DESC, total_time ASC""",
        (room_id,),
    )

    for i, r in enumerate(ranking):
        r["rank"] = i + 1

    from backend.permission_service import attach_student_info
    attach_student_info(ranking, key="student_username", prefix="student_")   # 补姓名/年级/班级
    return {"ranking": ranking}


@router.get("/quick-quiz/history", summary="学生抢答历史")
async def get_history(
    request: Request,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),   # S11: 原来无上限, ?page_size=99999 可整库拖取
):
    """学生查看自己参与过的抢答活动"""
    user = get_current_user(request)
    username = user["username"]

    offset = (page - 1) * page_size

    rows = execute_query_dict(
        """SELECT qq.id, qq.room_code, qq.title, qq.status, qq.question_count,
                  qq.created_at, qq.ended_at, qq.scoring_mode, qq.time_limit,
                  qp.total_score, qp.correct_count, qp.wrong_count, qp.max_streak,
                  COALESCE(u.name, qq.creator_username) AS creator_name
           FROM quick_quiz_players qp
           JOIN quick_quiz_rooms qq ON qp.room_id = qq.id
           LEFT JOIN users u ON qq.creator_username = u.username
           WHERE qp.student_username=?
           ORDER BY qq.created_at DESC
           LIMIT ? OFFSET ?""",
        (username, page_size, offset),
    )

    total = execute_query_one(
        """SELECT COUNT(*) as cnt
           FROM quick_quiz_players qp
           JOIN quick_quiz_rooms qq ON qp.room_id = qq.id
           WHERE qp.student_username=?""",
        (username,),
    )

    return {"records": rows, "total": total["cnt"] if total else 0}


# ── 内部方法 ──

async def _push_question(room_id: int, question_index: int, skip_cancel: bool = False):
    """推送指定题号的题目到所有客户端"""
    state = game_manager.get_room(room_id)
    if not state:
        logger.warning(f"push_question: room={room_id} 内存状态不存在")
        return

    # 验证题目是否存在
    total_in_db = execute_query_one(
        "SELECT COUNT(*) as cnt FROM quick_quiz_questions WHERE room_id=?",
        (room_id,),
    )
    logger.info(f"push_question: room={room_id} 查询第{question_index}题，题库中共{total_in_db['cnt'] if total_in_db else 0}题")

    question = execute_query_one(
        "SELECT * FROM quick_quiz_questions WHERE room_id=? AND sort_order=?",
        (room_id, question_index),
    )
    if not question:
        logger.warning(f"push_question: room={room_id} 未找到第{question_index}题，尝试取已有题目")
        question = execute_query_one(
            "SELECT * FROM quick_quiz_questions WHERE room_id=? ORDER BY sort_order ASC LIMIT 1",
            (room_id,),
        )
    if not question:
        logger.error(f"push_question: room={room_id} 没有任何题目，结束游戏")
        await _do_end_game(room_id)
        return
    
    logger.info(f"push_question: room={room_id} 成功加载题目: {question.get('question_text', '')[:30]}...")

    options = json.loads(question["options"]) if isinstance(question["options"], str) else question["options"]

    # 更新状态
    state["current_question"] = question_index
    state["phase"] = "question"
    state["answered_players"] = set()
    state["first_blood"] = None
    state["answered_in_round"] = {}

    state["question_start_time"] = time.time()

    # 取消旧的定时器（如果正在被该函数调用则不取消，避免自我取消）
    if state["timer_task"] and not skip_cancel:
        state["timer_task"].cancel()

    # 广播题目（不包含答案）
    await game_manager.broadcast(room_id, {
        "type": "new_question",
        "data": {
            "sort_order": question["sort_order"],
            "question_text": question["question_text"],
            "options": options,
            "time_limit": state["time_limit"],
            "total_questions": execute_query_one(
                "SELECT COUNT(*) as cnt FROM quick_quiz_questions WHERE room_id=?",
                (room_id,),
            )["cnt"],  # type: ignore[index]
            "svg_content": question.get("svg_content", ""),
            "has_svg": question.get("has_svg", 0),
            "media_files": question.get("media_files", ""),
            "media_placeholders": question.get("media_placeholders", ""),
        }
    })

    # 启动倒计时
    state["timer_task"] = asyncio.create_task(
        game_manager.start_timer(room_id, _get_room_coro())
    )


async def _do_reveal(room_id: int, push_next: bool = True) -> dict[str, Any] | None:
    """公布当前题目答案"""
    state = game_manager.get_room(room_id)
    if not state or state["phase"] != "question":
        return None

    current_q = state["current_question"]
    question = execute_query_one(
        "SELECT * FROM quick_quiz_questions WHERE room_id=? AND sort_order=?",
        (room_id, current_q),
    )
    if not question:
        return None

    state["phase"] = "reveal"

    # 取消倒计时
    if state["timer_task"]:
        state["timer_task"].cancel()
        state["timer_task"] = None

    options = json.loads(question["options"]) if isinstance(question["options"], str) else question["options"]

    # 统计各选项分布
    answers = execute_query_dict(
        "SELECT answer, is_correct, time_spent, score FROM quick_quiz_answers WHERE question_id=?",
        (question["id"],),
    )
    option_stats = {}
    for opt_key in options:
        option_stats[opt_key] = 0
    for a in answers:
        ans = a["answer"]
        if ans in option_stats:
            option_stats[ans] += 1

    # 获取当前排行榜
    ranking = execute_query_dict(
        """SELECT student_username, student_name, total_score, correct_count, wrong_count
           FROM quick_quiz_players
           WHERE room_id=?
           ORDER BY total_score DESC, correct_count DESC, total_time ASC""",
        (room_id,),
    )
    for i, r in enumerate(ranking):
        r["rank"] = i + 1

    from backend.permission_service import attach_student_info
    attach_student_info(ranking, key="student_username", prefix="student_")
    reveal_data = {
        "sort_order": question["sort_order"],
        "correct_answer": question["correct_answer"],
        "explanation": question["explanation"],
        "option_stats": option_stats,
        "total_answers": len(answers),
        "first_blood": state["first_blood"],
        "ranking": ranking,
    }

    # 计算总题数
    total_q = execute_query_one(
        "SELECT COUNT(*) as cnt FROM quick_quiz_questions WHERE room_id=?",
        (room_id,),
    )
    total = total_q["cnt"] if total_q else 0
    is_last = current_q >= total

    reveal_data["is_last"] = is_last

    await game_manager.broadcast(room_id, {
        "type": "answer_reveal",
        "data": reveal_data,
    })

    # 如果不是强制结束（push_next=True），推送下一题或结束
    if is_last:
        await _do_end_game(room_id)
        reveal_data["ended"] = True
    elif push_next:
        await _push_question(room_id, current_q + 1)
        # 在 reveal_data 中附带下一题信息，前端可直接使用
        nq = execute_query_one(
            "SELECT * FROM quick_quiz_questions WHERE room_id=? AND sort_order=?",
            (room_id, current_q + 1),
        )
        if nq:
            n_opts = json.loads(nq["options"]) if isinstance(nq["options"], str) else nq["options"]
            reveal_data["next_question"] = {
                "sort_order": nq["sort_order"],
                "question_text": nq["question_text"],
                "options": n_opts,
                "time_limit": state["time_limit"],
                "total_questions": total,
            }
    # else: push_next=False 即教师提前结束，仅公布答案不推送下一题

    return reveal_data


_end_game_lock: set[int] = set()  # 防止 _do_end_game 重复执行


async def _do_end_game(room_id: int):
    """结束游戏，发放奖励"""
    # 防重入锁
    if room_id in _end_game_lock:
        return
    _end_game_lock.add(room_id)
    try:
        state = game_manager.get_room(room_id)
        now = _now()

        # 如果还有未公布答案的题目，先公布（但不再推送下一题）
        if state and state["phase"] == "question":
            await _do_reveal(room_id, push_next=False)

        # 更新房间状态
        execute_insert_update(
            "UPDATE quick_quiz_rooms SET status='ended', ended_at=? WHERE id=?",
            (now, room_id),
        )

        room = execute_query_one("SELECT * FROM quick_quiz_rooms WHERE id=?", (room_id,))

        # 获取最终排行榜
        ranking = execute_query_dict(
            """SELECT student_username, student_name, total_score, correct_count, wrong_count,
                      total_time, max_streak
               FROM quick_quiz_players
               WHERE room_id=?
               ORDER BY total_score DESC, correct_count DESC, total_time ASC""",
            (room_id,),
        )
        for i, r in enumerate(ranking):
            r["rank"] = i + 1

        # 保存排行快照
        execute_insert_update(
            "INSERT INTO quick_quiz_rankings (room_id, round_number, rankings, created_at) VALUES (?, ?, ?, ?)",
            (room_id, 0, json.dumps(ranking, ensure_ascii=False), now),
        )

        # 发放积分奖励
        if room:
            await _award_rewards(room_id, room, ranking)

        # 广播结束
        from backend.permission_service import attach_student_info
        attach_student_info(ranking, key="student_username", prefix="student_")   # 广播里也带上年级班级
        await game_manager.broadcast(room_id, {
            "type": "game_end",
            "data": {
                "final_ranking": ranking,
                "room": _room_to_dict(room) if room else {},
            }
        })

        # 清理内存状态
        game_manager.remove_room(room_id)
    finally:
        _end_game_lock.discard(room_id)


async def _award_rewards(room_id: int, room: dict[str, Any], ranking: list[dict[str, Any]]):
    """发放抢答活动积分奖励"""
    activity_id = f"quick_quiz_{room_id}"
    title = room.get("title", "知识抢答")

    for i, player in enumerate(ranking):
        username = player["student_username"]
        rank = i + 1

        # 参与基础分
        award_participation(
            username, "quick_quiz", activity_id,
            activity_title=title,
        )

        # 排名奖励
        if rank == 1:
            award_grade(username, "quick_quiz", activity_id,
                        score=100, total_score=100,  # 第一名=满分
                        activity_title=title)
        elif rank <= 3:
            award_grade(username, "quick_quiz", activity_id,
                        score=85, total_score=100,
                        activity_title=title)
        elif rank <= 5:
            award_grade(username, "quick_quiz", activity_id,
                        score=75, total_score=100,
                        activity_title=title)
        elif player["correct_count"] > 0 and player["total_score"] > 0:
            award_grade(username, "quick_quiz", activity_id,
                        score=60, total_score=100,
                        activity_title=title)

        # 检测徽章解锁
        try:
            check_and_unlock_badges(username)
        except Exception:
            pass


async def _broadcast_player_list(room_id: int):
    """广播玩家列表更新"""
    players = execute_query_dict(
        "SELECT student_username, student_name, total_score FROM quick_quiz_players WHERE room_id=?",
        (room_id,),
    )
    from backend.permission_service import attach_student_info
    attach_student_info(players, key="student_username", prefix="student_")   # 玩家列表补年级班级
    await game_manager.broadcast(room_id, {
        "type": "player_list",
        "data": {"players": players},
    })


def _get_room_coro():
    """获取当前房间协程的引用（用于倒计时回调）"""
    # 这是一个 hack，为了在倒计时结束时调用 _do_reveal
    # 实际使用时在 start_timer 中传递 room_coro 参数
    class _RoomCoro:
        async def reveal_answer(self, room_id):
            await _do_reveal(room_id)
    return _RoomCoro()


# ════════════════════════════════════════════
# WebSocket 端点
# ════════════════════════════════════════════

@router.websocket("/ws/quick-quiz/{room_id}")
async def quick_quiz_websocket(websocket: WebSocket, room_id: int):
    """抢答活动 WebSocket 连接

    S1: 握手必须带 token(?token=), 且身份一律以 token 为准 —— 旧实现不校验任何凭证,
    并直接采信客户端传来的 username, 任何人可连任意房间、冒充任意学号,
    还会收到广播出去的正确答案与解析。
    """
    from backend.auth import authenticate_payload

    token = websocket.query_params.get("token") or ""
    payload = authenticate_payload(token)
    if not payload:
        await websocket.close(code=4401)
        return

    username = payload.get("username", "")
    role = payload.get("role", 2)
    room = execute_query_one("SELECT * FROM quick_quiz_rooms WHERE id=?", (room_id,))
    if not room:
        await websocket.close(code=4404)
        return
    if not _can_view_room(room, username, role):
        await websocket.close(code=4403)
        return

    # S13: 进程重启后内存态丢失时按房间配置自愈, 否则连接根本不被登记(收不到任何推送)
    if game_manager.get_room(room_id) is None:
        game_manager.create_room_state(room_id, room.get("time_limit") or 15)

    # 接受连接
    await game_manager.add_connection(room_id, websocket)

    try:
        while True:
            try:
                data = await websocket.receive_json()
            except WebSocketDisconnect:
                raise
            except Exception as parse_err:
                logger.warning(f"WebSocket 收到无法解析的帧 (room={room_id}): {parse_err}")
                continue
            if not isinstance(data, dict):
                continue
            msg_type = data.get("type", "")
            msg_data = data.get("data", {}) if isinstance(data.get("data"), dict) else {}

            if msg_type == "register":
                # 注册玩家连接(S1: 忽略客户端自报的 username, 防止冒充)
                claimed = msg_data.get("username", "")
                if claimed and claimed != username:
                    logger.warning(f"[quick-quiz WS] 拒绝身份不一致的注册请求(声称={claimed}, 实际={username})")
                if username:
                    game_manager.register_player(room_id, username, websocket)
                    # 发送当前状态
                    room = execute_query_one(
                        "SELECT * FROM quick_quiz_rooms WHERE id=?",
                        (room_id,),
                    )
                    if room:
                        state = game_manager.get_room(room_id)
                        await websocket.send_json({
                            "type": "room_state",
                            "data": {
                                "status": room["status"],
                                "current_question": state["current_question"] if state else 0,
                                "phase": state["phase"] if state else "waiting",
                            }
                        })
                    # 广播玩家列表
                    await _broadcast_player_list(room_id)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        # S1: 单条异常消息(如非 JSON 帧)不应终止会话, 记录后继续
        logger.warning(f"WebSocket 消息处理异常 (room={room_id}): {e}")
    finally:
        game_manager.remove_connection(room_id, websocket)
