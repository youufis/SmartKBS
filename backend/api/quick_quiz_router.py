"""
知识抢答活动 API 路由
教师创建抢答房间 → 学生加入 → 实时抢答 → 自动计分 → 排行榜
"""
import asyncio
import json
import random
import string
from datetime import datetime
from typing import Optional

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
STREAK_MULTIPLIERS = {
    0: 1.0,
    1: 1.0,
    2: 1.2,
    3: 1.5,
    4: 1.8,
    5: 2.0,
}
CONSECUTIVE_WRONG_PENALTY = -10  # 连续答错3题扣分
CONSECUTIVE_WRONG_THRESHOLD = 3
PERFECT_MULTIPLIER = 1.2

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


def _calc_speed_score(time_spent: float, time_limit: int) -> float:
    """速度递减计分：用时越少得分越高"""
    min_score = 10
    max_score = 100
    if time_spent <= 0:
        return max_score
    if time_spent >= time_limit:
        return min_score
    decay = (max_score - min_score) / time_limit
    return round(max_score - decay * time_spent, 1)


def _calc_tiered_score(time_spent: float) -> float:
    """分段计分"""
    for lo, hi, score in SCORE_TIERS:
        if lo <= time_spent < hi:
            return score
    return 10


def _calc_streak_multiplier(streak: int) -> float:
    """计算连击倍率"""
    for s, m in sorted(STREAK_MULTIPLIERS.items(), reverse=True):
        if streak >= s:
            return m
    return 1.0


def _get_username_display(username: str) -> str:
    """获取学生显示名"""
    row = execute_query_one(
        "SELECT name FROM users WHERE username=?",
        (username,),
    )
    if row and row.get("name"):
        return row["name"]
    return username


def _get_student_grade_class(username: str) -> tuple:
    """查询学生的年级和班级"""
    row = execute_query_one(
        "SELECT grade, class FROM users WHERE username=?",
        (username,),
    )
    if row:
        return str(row.get("grade", "") or ""), str(row.get("class", "") or "")
    return "", ""


def _can_view_room(room: dict, username: str, role: int) -> bool:
    """判断用户是否有权限查看/管理该房间"""
    if role == 0:
        # 管理员：全部可见
        return True
    if role == 1:
        # 教师：自己的房间，或管理员创建的房间（同年级/不限年级）
        if room["creator_username"] == username:
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
                cls_param = f",{cls},"
                if cls and f",{room['target_class']}," and f",{room['target_class']}," and (not room['target_class'] or cls == room['target_class'] or f",{room['target_class']},".find(cls_param) >= 0):
                    return True
        return False
    if role == 2:
        # 学生：已加入该房间的始终可见
        existing = execute_query_one(
            "SELECT id FROM quick_quiz_players WHERE room_id=? AND student_username=?",
            (room["id"], username),
        )
        if existing:
            return True
        # 管理员创建的（不限班级）
        creator = execute_query_one(
            "SELECT role FROM users WHERE username=?",
            (room["creator_username"],),
        )
        if creator and creator["role"] == 0:
            return True
        # 同年级同班级
        grade, cls = _get_student_grade_class(username)
        if not grade or not cls:
            return False
        if room.get("target_grade") and room["target_grade"] != grade:
            return False
        if room.get("target_class"):
            target_classes = [c.strip() for c in room["target_class"].split(",") if c.strip()]
            if target_classes and cls not in target_classes:
                return False
        return True
    return False


def _room_to_dict(room: dict) -> dict:
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
        "target_grade": room["target_grade"] or "",
        "target_class": room["target_class"] or "",
        "use_ai_generate": room["use_ai_generate"],
        "subject": room.get("subject", "") or "",
        "knowledge_points": room.get("knowledge_points", "") or "",
        "difficulty": room.get("difficulty", "medium") or "medium",
        "created_at": room["created_at"],
        "started_at": room.get("started_at"),
        "ended_at": room.get("ended_at"),
    }


def _load_questions_from_general_bank(category: str = "", count: int = 10,
                                        exclude_ids: Optional[list[int]] = None) -> list[dict]:
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
                                exclude_ids: Optional[list[int]] = None) -> list[dict]:
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
        f"""SELECT id, type, question_text, options, correct_answer, explanation
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
        })
    return questions


def _call_ai_generate_question(subject: str = "信息科技",
                                 knowledge_points: str = "",
                                 difficulty: str = "medium") -> dict | None:
    """调用 AI 生成一道抢答题目"""
    from backend.api.chat_router import get_api_keys
    from backend.api.ai_service import call_ai_sync_direct
    from backend.prompts.quick_quiz import QUICK_QUIZ_GENERATE_PROMPT

    # 尝试获取 API key
    api_key = None
    try:
        api_key, _ = get_api_keys("root")
    except Exception:
        pass
    if not api_key:
        import os
        api_key = os.environ.get("DASHSCOPE_API_KEY", "")
    if not api_key:
        try:
            from backend.api.config_router import load_config
            cfg = load_config()
            api_key = cfg.get("dashscope_api_key", "")
        except Exception:
            pass
    if not api_key:
        return None

    prompt = QUICK_QUIZ_GENERATE_PROMPT.format(
        subject=subject,
        knowledge_points=knowledge_points or "综合知识",
        difficulty=difficulty,
    )
    try:
        text = call_ai_sync_direct(prompt, api_key)
        text = text.strip()
        if text.startswith("```"):
            start = text.find("{")
            end = text.rfind("}")
            if start >= 0 and end > start:
                text = text[start:end + 1]
        result = json.loads(text)
        for key in ("question", "options", "answer", "explanation"):
            if key not in result:
                raise ValueError(f"AI 返回缺少字段: {key}")
        # 统一答案为大写字母
        result["answer"] = result["answer"].strip().upper()
        return result
    except Exception as e:
        logger.error(f"AI 出题失败: {e}")
        return None


def _prepare_questions_for_room(room_id: int, room: dict) -> list[dict]:
    """为房间准备题目（从题库/AI/手动）"""
    count = room["question_count"]
    source = room["question_source"]
    questions = []

    # ── 学科题库 ──
    if source in ("bank", "bank_academic", "mixed"):
        try:
            bank_qs = _load_questions_from_bank(
                subject=room.get("subject", ""),
                knowledge_points=room.get("knowledge_points", ""),
                difficulty=room.get("difficulty", "medium"),
                count=count if source in ("bank", "bank_academic") else max(1, count // 2),
            )
            questions.extend(bank_qs)
        except Exception as e:
            logger.warning(f"从学科试题库加载题目失败: {e}")

    # ── 百科题库 ──
    if source in ("bank", "bank_general", "mixed"):
        if len(questions) < count:
            try:
                g_count = count if source == "bank_general" else (count - len(questions))
                general_qs = _load_questions_from_general_bank(count=g_count)
                questions.extend(general_qs)
            except Exception as e:
                logger.warning(f"从百科题库加载题目失败: {e}")

    if source == "ai" or source == "mixed":
        ai_count = count if source == "ai" else (count - len(questions))
        for i in range(ai_count):
            # 如果已从题库拿到足够题，跳过
            if len(questions) >= count:
                break
            try:
                q = _call_ai_generate_question(
                    subject=room.get("subject", "信息科技"),
                    knowledge_points=room.get("knowledge_points", ""),
                    difficulty=room.get("difficulty", "medium"),
                )
                if q:
                    questions.append({
                        "question_text": q["question"],
                        "options": q["options"],
                        "correct_answer": q["answer"],
                        "explanation": q.get("explanation", ""),
                    })
            except Exception as e:
                logger.warning(f"AI 出题失败: {e}，将使用兜底题")

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
               (room_id, sort_order, question_text, options, correct_answer, explanation, source)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (room_id, i + 1, q["question_text"],
             json.dumps(q["options"], ensure_ascii=False),
             q["correct_answer"], q.get("explanation", ""),
             q.get("id") and "bank" or "ai"),
        ))
    if operations:
        execute_batch(operations)

    return questions


# ── 实时抢答管理器（内存状态） ──

class QuickQuizGameManager:
    """抢答活动状态管理器（内存中维护每局状态）"""

    def __init__(self):
        self.rooms: dict[int, dict] = {}
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

    def get_room(self, room_id: int) -> dict | None:
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

    async def broadcast(self, room_id: int, message: dict):
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

    async def broadcast_to_player(self, room_id: int, username: str, message: dict):
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
    # 教师未指定年级/班级时，自动填充自己的
    target_grade = body.get("target_grade", "")
    target_class = body.get("target_class", "")
    if role == 1 and not target_grade:
        auto_grade, auto_cls = _get_student_grade_class(username)
        if auto_grade and not target_grade:
            target_grade = auto_grade
        if auto_cls and not target_class:
            target_class = auto_cls
    use_ai_generate = 1 if body.get("use_ai_generate") else 0
    subject = body.get("subject", "")
    knowledge_points = body.get("knowledge_points", "")
    difficulty = body.get("difficulty", "medium")

    room_code = _generate_room_code()
    now = _now()

    room_id = execute_insert_update(
        """INSERT INTO quick_quiz_rooms
           (room_code, title, creator_username, status, question_source, question_count,
            time_limit, scoring_mode, min_players, max_players,
            target_grade, target_class, use_ai_generate, subject, knowledge_points, difficulty,
            created_at)
           VALUES (?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (room_code, title, username, question_source, question_count,
         time_limit, scoring_mode, min_players, max_players,
         target_grade, target_class, use_ai_generate, subject, knowledge_points, difficulty,
         now),
    )

    # 初始化内存状态
    game_manager.create_room_state(room_id, time_limit)

    room = execute_query_one(
        "SELECT * FROM quick_quiz_rooms WHERE id=?",
        (room_id,),
    )

    return _room_to_dict(room)


@router.get("/quick-quiz/rooms", summary="获取抢答房间列表")
async def list_rooms(
    request: Request,
    status: str = Query("", description="筛选状态"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1),
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
        # 教师：自己的 + 管理员创建的同年级
        grade, cls = _get_student_grade_class(username)
        conditions.append(
            "(qq.creator_username=? OR (u2.role=0"
        )
        params.append(username)
        if grade:
            conditions[-1] += " AND (qq.target_grade='' OR qq.target_grade=?)"
            params.append(grade)
        conditions[-1] += "))"
    elif role == 2:
        # 学生：活跃 + 可加入的
        conditions.append("qq.status IN ('waiting','playing')")
        grade, cls = _get_student_grade_class(username)
        if grade:
            # 管理员创建的（不限年级）或 同年级的
            conditions.append(
                "(u2.role=0 OR (qq.target_grade=?"
            )
            params.append(grade)
            if cls:
                conditions[-1] += f" AND (qq.target_class='' OR INSTR(',' || qq.target_class || ',', ?) > 0)"
                params.append(f",{cls},")
            conditions[-1] += "))"
        else:
            conditions.append("(u2.role=0)")

    if status:
        conditions.append("qq.status=?")
        params.append(status)

    where = " AND ".join(conditions) if conditions else "1=1"
    offset = (page - 1) * page_size

    rows = execute_query_dict(
        f"""SELECT qq.*, COALESCE(u.name, u.username) AS creator_name
            FROM quick_quiz_rooms qq
            LEFT JOIN users u ON qq.creator_username = u.username
            LEFT JOIN users u2 ON qq.creator_username = u2.username
            WHERE {where}
            ORDER BY qq.created_at DESC
            LIMIT ? OFFSET ?""",
        tuple(params + [page_size, offset]),
    )

    # 获取每个房间的玩家数
    result = []
    for r in rows:
        room = _room_to_dict(r)
        player_count = execute_query_one(
            "SELECT COUNT(*) as cnt FROM quick_quiz_players WHERE room_id=?",
            (r["id"],),
        )
        room["player_count"] = player_count["cnt"] if player_count else 0
        room["creator_name"] = r.get("creator_name", "")
        result.append(room)

    total = execute_query_one(
        f"SELECT COUNT(*) as cnt FROM quick_quiz_rooms qq LEFT JOIN users u2 ON qq.creator_username = u2.username WHERE {where}",
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
                   "target_grade", "target_class", "subject", "knowledge_points", "difficulty"]:
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

    result = await _do_reveal(room_id)
    if not result:
        raise HTTPException(status_code=400, detail="当前没有活跃题目或已公布")

    return result


@router.post("/quick-quiz/room/{room_id}/ai-generate", summary="AI 生成题目")
async def ai_generate_question(room_id: int, request: Request):
    """教师在教学过程中用 AI 生成一道新题目并加入当前抢答"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    room = execute_query_one("SELECT * FROM quick_quiz_rooms WHERE id=?", (room_id,))
    if not room:
        raise HTTPException(status_code=404, detail="房间不存在")
    if room["creator_username"] != username and role != 0:
        raise HTTPException(status_code=403, detail="仅创建者可操作")

    body = await request.json()
    topic = body.get("topic", "").strip()
    subject = body.get("subject", room.get("subject", "信息科技")) or "信息科技"
    difficulty = body.get("difficulty", room.get("difficulty", "medium")) or "medium"

    # 调用 AI 生成
    q = _call_ai_generate_question(
        subject=subject,
        knowledge_points=topic or room.get("knowledge_points", "综合知识"),
        difficulty=difficulty,
    )
    if not q:
        raise HTTPException(status_code=500, detail="AI 出题失败，请检查 API Key 配置")

    # 计算下一个题号
    max_order = execute_query_one(
        "SELECT COALESCE(MAX(sort_order), 0) as max_order FROM quick_quiz_questions WHERE room_id=?",
        (room_id,),
    )
    next_order = (max_order["max_order"] if max_order else 0) + 1

    # 插入题目
    options_json = json.dumps(q["options"], ensure_ascii=False)
    qid = execute_insert_update(
        """INSERT INTO quick_quiz_questions
           (room_id, sort_order, question_text, options, correct_answer, explanation, source)
           VALUES (?, ?, ?, ?, ?, ?, 'ai')""",
        (room_id, next_order, q["question"], options_json, q["answer"], q.get("explanation", "")),
    )

    # 更新房间的总题数
    total_q = execute_query_one(
        "SELECT COUNT(*) as cnt FROM quick_quiz_questions WHERE room_id=?",
        (room_id,),
    )
    execute_insert_update(
        "UPDATE quick_quiz_rooms SET question_count=? WHERE id=?",
        (total_q["cnt"] if total_q else next_order, room_id),
    )

    return {
        "question_id": qid,
        "sort_order": next_order,
        "question_text": q["question"],
        "options": q["options"],
        "correct_answer": q["answer"],
        "explanation": q.get("explanation", ""),
        "total_questions": total_q["cnt"] if total_q else next_order,
    }


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
            f"""SELECT id, question_text, options, correct_answer, explanation
                FROM quest_question_bank
                WHERE id IN ({placeholders})""",
            tuple(question_ids),
        )
        # 统一格式，type 设为 single
        for r in rows:
            r["type"] = "single"
    else:
        rows = qb_execute_query(
            f"""SELECT id, type, question_text, options, correct_answer, explanation
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
               (room_id, sort_order, question_text, options, correct_answer, explanation, source, source_question_id)
               VALUES (?, ?, ?, ?, ?, ?, 'bank', ?)""",
            (room_id, sort_order, q_text, options_json, q_answer, q_explanation, q_id),
        ))
        added.append({
            "sort_order": sort_order,
            "question_text": q_text,
            "options": opts,
            "correct_answer": q_answer,
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
    import time
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

    # 计分：答对 +1 分，答错 -2 分
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

    # 更新玩家统计
    old_streak = player["streak"] if player else 0
    new_correct = (player["correct_count"] if player else 0) + (1 if is_correct else 0)
    new_wrong = (player["wrong_count"] if player else 0) + (0 if is_correct else 1)
    new_total_time = (player["total_time"] if player else 0) + time_spent
    new_score = (player["total_score"] if player else 0) + score
    new_max_streak = max(player["max_streak"] if player else 0, streak)

    execute_insert_update(
        """UPDATE quick_quiz_players
           SET total_score=?, correct_count=?, wrong_count=?, total_time=?,
               streak=?, max_streak=?
           WHERE room_id=? AND student_username=?""",
        (new_score, new_correct, new_wrong, new_total_time,
         streak, new_max_streak, room_id, username),
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
        }
    }


@router.get("/quick-quiz/room/{room_id}/result", summary="获取活动结果")
async def get_result(room_id: int, request: Request):
    """获取抢答活动的完整结果"""
    user = get_current_user(request)
    username = user["username"]

    room = execute_query_one("SELECT * FROM quick_quiz_rooms WHERE id=?", (room_id,))
    if not room:
        raise HTTPException(status_code=404, detail="房间不存在")

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

    question_details = []
    for q in questions:
        answers = execute_query_dict(
            """SELECT student_username, answer, is_correct, time_spent, score
               FROM quick_quiz_answers WHERE question_id=?
               ORDER BY time_spent ASC""",
            (q["id"],),
        )
        options = json.loads(q["options"]) if isinstance(q["options"], str) else q["options"]

        # 统计各选项分布
        option_stats = {}
        for opt_key in options:
            option_stats[opt_key] = 0
        for a in answers:
            ans = a["answer"]
            if ans in option_stats:
                option_stats[ans] += 1

        question_details.append({
            "sort_order": q["sort_order"],
            "question_text": q["question_text"],
            "options": options,
            "correct_answer": q["correct_answer"],
            "explanation": q["explanation"],
            "correct_count": sum(1 for a in answers if a["is_correct"] == 1),
            "total_answers": len(answers),
            "option_stats": option_stats,
            "answers": answers,
        })

    # 我的信息
    my_info = execute_query_one(
        "SELECT * FROM quick_quiz_players WHERE room_id=? AND student_username=?",
        (room_id, username),
    )

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

    return {"ranking": ranking}


@router.get("/quick-quiz/history", summary="学生抢答历史")
async def get_history(
    request: Request,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1),
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

    import time
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
            )["cnt"],
        }
    })

    # 启动倒计时
    state["timer_task"] = asyncio.create_task(
        game_manager.start_timer(room_id, _get_room_coro())
    )


async def _do_reveal(room_id: int) -> dict | None:
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

    # 立即推送下一题（或结束），不依赖任何定时器
    if is_last:
        await _do_end_game(room_id)
        reveal_data["ended"] = True
    else:
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

    return reveal_data


async def _do_end_game(room_id: int):
    """结束游戏，发放奖励"""
    state = game_manager.get_room(room_id)
    now = _now()

    # 如果还有未公布答案的题目，先公布
    if state and state["phase"] == "question":
        await _do_reveal(room_id)

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
    await game_manager.broadcast(room_id, {
        "type": "game_end",
        "data": {
            "final_ranking": ranking,
            "room": _room_to_dict(room) if room else {},
        }
    })

    # 清理内存状态
    game_manager.remove_room(room_id)


async def _award_rewards(room_id: int, room: dict, ranking: list[dict]):
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
    """抢答活动 WebSocket 连接"""
    # 接受连接
    await game_manager.add_connection(room_id, websocket)

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type", "")
            msg_data = data.get("data", {})

            if msg_type == "register":
                # 注册玩家连接
                username = msg_data.get("username", "")
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
        logger.error(f"WebSocket 错误 (room={room_id}): {e}")
    finally:
        game_manager.remove_connection(room_id, websocket)
