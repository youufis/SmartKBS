"""
知识闯关 API 路由
学生端：AI 即时出题的百科答题挑战
教师端：闯关记录查看 + 闯关题库管理
"""
import asyncio
import json
import random
import re
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request, Query, UploadFile, File
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.database import execute_query, execute_query_dict, execute_insert_update, execute_query_one
from backend.permission_service import get_teacher_classes, get_teacher_grades, parse_legacy_teacher_grade_class
from backend.api.chat_router import get_api_keys
from backend.api.ai_service import call_ai_sync_direct
from backend.prompts.quest import (
    QUEST_GENERATE_PROMPT,
    PHONE_FRIEND_PROMPT,
    AUDIENCE_VOTE_PROMPT,
)
from backend.prompts.chat import SVG_GENERATE_PROMPT, IMAGE_GEN_PROMPT_TEMPLATE
from backend.logger import logger
from backend.reward_engine import award_participation, award_grade, update_student_total
from backend.title_system import check_and_unlock_badges

router = APIRouter()

# ── 常量 ──
MAX_QUEST_QUESTIONS = 15
LIFELINE_TYPES = {"remove_one", "phone_friend", "audience_vote"}

# 各题号基础分
SCORE_TABLE = {
    1: 10, 2: 15, 3: 15,
    4: 20, 5: 20, 6: 20,
    7: 25, 8: 25, 9: 25,
    10: 30, 11: 30, 12: 30,
    13: 50, 14: 50, 15: 50,
}

# 锦囊折减系数
LIFELINE_DISCOUNT = {
    "remove_one": 0.85,
    "phone_friend": 0.70,
    "audience_vote": 0.70,
}

# 里程碑徽章配置（按累计成功闯关次数）
MILESTONE_BADGES = [
    {"id": "quest_first", "name": "初出茅庐", "emoji": "🥉", "min_count": 1},
    {"id": "quest_novice", "name": "闯关新秀", "emoji": "🥈", "min_count": 5},
    {"id": "quest_expert", "name": "闯关达人", "emoji": "🥇", "min_count": 10},
    {"id": "quest_master", "name": "闯关大师", "emoji": "💎", "min_count": 20},
    {"id": "quest_legend", "name": "闯关传奇", "emoji": "👑", "min_count": 50},
]

# ── 辅助函数 ──

def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _calc_question_score(question_index: int, lifelines: list[str]) -> int:
    """计算单题得分（含锦囊折减）"""
    base = SCORE_TABLE.get(question_index, 10)
    discount = 1.0
    for lf in lifelines:
        discount *= LIFELINE_DISCOUNT.get(lf, 1.0)
    return max(1, round(base * discount))


def _call_ai_generate_question(api_key: str, used_categories: list[str],
                                 question_index: int) -> dict[str, Any]:
    """调用 AI 生成一道题目，支持公式($...$)和SVG配图(svg_content)"""
    used_cats_str = json.dumps(used_categories, ensure_ascii=False)
    prompt = QUEST_GENERATE_PROMPT.format(
        used_categories=used_cats_str,
        question_index=question_index,
    )
    try:
        text = call_ai_sync_direct(prompt, api_key)
        # 清理可能的 markdown 代码块
        text = text.strip()
        if text.startswith("```"):
            # 提取 JSON
            start = text.find("{")
            end = text.rfind("}")
            if start >= 0 and end > start:
                text = text[start:end + 1]
        result = json.loads(text)
        # 验证必要字段
        for key in ("category", "question", "options", "answer", "explanation"):
            if key not in result:
                raise ValueError(f"AI 返回缺少字段: {key}")
        # 补充可选媒体字段（AI 可能未返回）
        result.setdefault("svg_content", "")
        result.setdefault("has_svg", 1 if result.get("svg_content") else 0)
        result.setdefault("media_files", "")
        result.setdefault("media_placeholders", "")
        # 如果有 SVG 内容，做基本合法性校验
        svg = result.get("svg_content", "")
        if svg and "<svg" not in svg:
            logger.warning(f"AI 返回的 svg_content 格式异常，已忽略: {svg[:50]}")
            result["svg_content"] = ""
            result["has_svg"] = 0
        return result
    except Exception as e:
        logger.error(f"AI 出题失败: {e}，尝试从题库取备用题")
        # 降级：从题库取一道题
        bank_q = _get_question_from_bank([])
        if bank_q:
            return bank_q
        # 题库也没有，返回内置兜底题
        return {
            "category": "综合",
            "question": "以下哪项不是中国的四大发明？",
            "options": {"A": "造纸术", "B": "火药", "C": "电灯", "D": "印刷术"},
            "answer": "C",
            "explanation": "中国的四大发明是造纸术、火药、印刷术和指南针。电灯是爱迪生发明的。",
            "svg_content": "", "has_svg": 0, "media_files": "", "media_placeholders": "",
        }


def _save_question_to_bank(question_data: dict[str, Any]):
    """将 AI 生成的题目持久化到题库表（去重）"""
    try:
        execute_insert_update(
            """INSERT OR IGNORE INTO quest_question_bank
               (category, question_text, options, correct_answer, explanation, used_count, created_at,
                svg_content, has_svg, media_files, media_placeholders)
               VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)""",
            (
                question_data.get("category", "综合"),
                question_data["question"],
                json.dumps(question_data["options"], ensure_ascii=False),
                question_data["answer"],
                question_data.get("explanation", ""),
                _now(),
                question_data.get("svg_content", ""),
                question_data.get("has_svg", 0),
                question_data.get("media_files", ""),
                question_data.get("media_placeholders", ""),
            ),
        )
    except Exception as e:
        logger.warning(f"保存题目到题库失败: {e}")


def _get_question_from_bank(used_categories: list[str]) -> dict[str, Any] | None:
    """从题库中随机选取一道适合的题目（未使用过的类别优先）"""
    # 找可用类别（不在 used_categories 中）
    available_cats = execute_query(
        """SELECT category, COUNT(*) as cnt FROM quest_question_bank
           GROUP BY category ORDER BY cnt DESC"""
    )
    if not available_cats:
        return None

    # 优先选没用过的类别
    chosen_cat = None
    for row in available_cats:
        cat = row[0] if isinstance(row, (list, tuple)) else row["category"]
        if cat not in used_categories:
            chosen_cat = cat
            break

    if not chosen_cat:
        # 所有类别都用过了，随便选一个使用次数最少的
        chosen_cat = available_cats[0][0] if isinstance(available_cats[0], (list, tuple)) else available_cats[0]["category"]

    # 从该类别中按 used_count 升序取一道题（优先使用次数少的）
    rows = execute_query(
        """SELECT id, category, question_text, options, correct_answer, explanation,
                   svg_content, has_svg, media_files, media_placeholders
           FROM quest_question_bank
           WHERE category=?
           ORDER BY used_count ASC, RANDOM()
           LIMIT 1""",
        (chosen_cat,),
    )
    if not rows:
        return None

    r = rows[0]
    result = {
        "category": r[1] if isinstance(r, (list, tuple)) else r["category"],
        "question": r[2] if isinstance(r, (list, tuple)) else r["question_text"],
        "options": json.loads(r[3] if isinstance(r, (list, tuple)) else r["options"]),
        "answer": r[4] if isinstance(r, (list, tuple)) else r["correct_answer"],
        "explanation": r[5] if isinstance(r, (list, tuple)) else r["explanation"],
        "svg_content": r[6] if isinstance(r, (list, tuple)) else r.get("svg_content", ""),
        "has_svg": r[7] if isinstance(r, (list, tuple)) else r.get("has_svg", 0),
        "media_files": r[8] if isinstance(r, (list, tuple)) else r.get("media_files", ""),
        "media_placeholders": r[9] if isinstance(r, (list, tuple)) else r.get("media_placeholders", ""),
    }

    # 更新使用次数
    qid = r[0] if isinstance(r, (list, tuple)) else r["id"]
    execute_insert_update(
        "UPDATE quest_question_bank SET used_count = used_count + 1 WHERE id=?",
        (qid,),
    )
    return result


BATCH_SIZE = 3  # 预生成缓存量（开局 + 答题中补货）


async def _generate_question_async(api_key: str, used_categories: list[str],
                                    question_index: int, use_bank: int = 0) -> dict[str, Any]:
    """异步生成一道题（AI 调用放到线程池避免阻塞）"""
    return await asyncio.to_thread(
        _generate_question, api_key, used_categories, question_index, use_bank
    )


async def _batch_generate(api_key: str, count: int,
                           used_categories: list[str],
                           start_index: int, use_bank: int = 0) -> list[dict[str, Any]]:
    """批量生成 count 道题（逐个生成，确保领域随机分布）"""
    questions = []
    for i in range(count):
        idx = start_index + i
        q = await _generate_question_async(api_key, list(used_categories), idx, use_bank)
        if isinstance(q, Exception):
            logger.error(f"批量生成中某题失败: {q}")
            continue
        # 将新领域加入已用列表，确保后续题目选择不同领域
        cat = q.get("category", "综合")
        if cat not in used_categories:
            used_categories.append(cat)
        questions.append(q)
    return questions


async def _async_refill_buffer(quest_id: int, api_key: str,
                                used_categories: list[str],
                                start_index: int, use_bank: int = 0):
    """后台异步补充题目缓存（答对后触发，不阻塞用户）"""
    try:
        count = min(BATCH_SIZE, MAX_QUEST_QUESTIONS - start_index + 1)
        if count <= 0:
            return
        questions = await _batch_generate(api_key, count, used_categories, start_index, use_bank)
        for i, q_data in enumerate(questions):
            cat = q_data.get("category", "综合")
            options_json = json.dumps(q_data["options"], ensure_ascii=False)
            try:
                execute_insert_update(
                    """INSERT OR IGNORE INTO quest_question_records
                       (quest_id, sort_order, category, question_text, options, correct_answer,
                        student_answer, is_correct, lifeline_used, time_spent, score, explanation,
                        svg_content, has_svg, media_files, media_placeholders)
                       VALUES (?, ?, ?, ?, ?, ?, '', -1, '', 0, 0, ?, ?, ?, ?, ?)""",
                    (quest_id, start_index + i, cat, q_data["question"],
                     options_json, q_data["answer"], q_data.get("explanation", ""),
                     q_data.get("svg_content", ""), q_data.get("has_svg", 0),
                     q_data.get("media_files", ""), q_data.get("media_placeholders", "")),
                )
            except Exception:
                pass  # 已存在则跳过
    except Exception as e:
        logger.error(f"后台补题失败 (quest={quest_id}): {e}")


def _generate_question(api_key: str, used_categories: list[str],
                        question_index: int, use_bank: int = 0) -> dict[str, Any]:
    """生成一道题：优先从题库取（use_bank=1 且题库有足够题），否则 AI 生成"""
    if use_bank:
        bank_q = _get_question_from_bank(used_categories)
        if bank_q:
            return bank_q

    # AI 生成并保存到题库
    q = _call_ai_generate_question(api_key, used_categories, question_index)
    _save_question_to_bank(q)
    return q


def _call_ai_phone_friend(api_key: str, question: str, options: dict[str, Any]) -> str:
    """调用 AI 模拟电话朋友提示"""
    opts = options
    prompt = PHONE_FRIEND_PROMPT.format(
        question=question,
        option_a=opts.get("A", ""),
        option_b=opts.get("B", ""),
        option_c=opts.get("C", ""),
        option_d=opts.get("D", ""),
    )
    try:
        text = call_ai_sync_direct(prompt, api_key)
        return text.strip().strip('"').strip("'")
    except Exception as e:
        logger.error(f"电话朋友 AI 调用失败: {e}")
        return "朋友说：这个题有点难，我也不敢确定，你相信自己的直觉吧！"


def _call_ai_audience_vote(api_key: str, question: str, options: dict[str, Any]) -> dict[str, Any]:
    """调用 AI 模拟现场观众投票"""
    prompt = AUDIENCE_VOTE_PROMPT.format(
        question=question,
        option_a=options.get("A", ""),
        option_b=options.get("B", ""),
        option_c=options.get("C", ""),
        option_d=options.get("D", ""),
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
        votes = result.get("votes", {})
        # 确保四个选项都有值且总和为 100
        for k in ("A", "B", "C", "D"):
            if k not in votes:
                votes[k] = 0
        total = sum(votes.values())
        if total != 100 and total > 0:
            # 按比例缩放
            for k in votes:
                votes[k] = round(votes[k] / total * 100)
        return votes
    except Exception as e:
        logger.error(f"观众投票 AI 调用失败: {e}")
        return {"A": 25, "B": 25, "C": 25, "D": 25}


def _get_or_init_badge_count(student_username: str) -> int:
    """获取或初始化学生闯关徽章计数"""
    row = execute_query_one(
        "SELECT total_success_count FROM quest_badge_counts WHERE student_username=?",
        (student_username,),
    )
    if row:
        return row["total_success_count"]
    execute_insert_update(
        "INSERT OR IGNORE INTO quest_badge_counts (student_username, total_success_count, updated_at) VALUES (?, 0, ?)",
        (student_username, _now()),
    )
    return 0


def _increment_badge_count(student_username: str) -> int:
    """增加一次成功闯关计数，返回新计数"""
    _get_or_init_badge_count(student_username)
    execute_insert_update(
        "UPDATE quest_badge_counts SET total_success_count = total_success_count + 1, updated_at=? WHERE student_username=?",
        (_now(), student_username),
    )
    row = execute_query_one(
        "SELECT total_success_count FROM quest_badge_counts WHERE student_username=?",
        (student_username,),
    )
    return row["total_success_count"] if row else 1


def _check_milestone_badges(student_username: str, total_count: int) -> list[dict[str, Any]]:
    """检测里程碑徽章是否解锁"""
    newly = []
    for badge in MILESTONE_BADGES:
        if total_count >= badge["min_count"]:
            # 检查是否已解锁
            existing = execute_query(
                "SELECT id FROM student_badges WHERE student_username=? AND badge_id=?",
                (student_username, badge["id"]),
            )
            if not existing:
                now = _now()
                execute_insert_update(
                    "INSERT INTO student_badges (student_username, badge_id, badge_name, unlocked_at) VALUES (?, ?, ?, ?)",
                    (student_username, badge["id"], badge["name"], now),
                )
                # 写入升级历史
                execute_insert_update(
                    """INSERT INTO title_upgrade_history
                       (student_username, old_title, new_title, title_type, created_at)
                       VALUES (?, '', ?, 'badge', ?)""",
                    (student_username, badge["name"], now),
                )
                # 创建通知
                try:
                    execute_insert_update(
                        """INSERT INTO notifications
                           (recipient_username, type, title, content, is_read, created_at)
                           VALUES (?, 'badge_unlock', ?, ?, 0, ?)""",
                        (student_username,
                         f"🏅 解锁徽章：{badge['emoji']} {badge['name']}",
                         f"恭喜达成 {badge['min_count']} 次闯关成功，获得 {badge['emoji']} {badge['name']} 徽章！",
                         now),
                    )
                except Exception:
                    pass
                newly.append(badge)
    return newly


def _check_honor_badges(student_username: str, correct_count: int) -> list[dict[str, Any]]:
    """检测荣誉徽章（一次性，额外条件）"""
    newly = []
    honor_checks = [
        {"id": "quest_all_15", "name": "一站到底", "condition": correct_count >= 15},
        {"id": "quest_10_plus", "name": "十连斩", "condition": correct_count >= 10},
    ]
    for badge in honor_checks:
        if badge["condition"]:
            existing = execute_query(
                "SELECT id FROM student_badges WHERE student_username=? AND badge_id=?",
                (student_username, badge["id"]),
            )
            if not existing:
                now = _now()
                execute_insert_update(
                    "INSERT INTO student_badges (student_username, badge_id, badge_name, unlocked_at) VALUES (?, ?, ?, ?)",
                    (student_username, badge["id"], badge["name"], now),
                )
                execute_insert_update(
                    """INSERT INTO title_upgrade_history
                       (student_username, old_title, new_title, title_type, created_at)
                       VALUES (?, '', ?, 'badge', ?)""",
                    (student_username, badge["name"], now),
                )
                try:
                    execute_insert_update(
                        """INSERT INTO notifications
                           (recipient_username, type, title, content, is_read, created_at)
                           VALUES (?, 'badge_unlock', ?, ?, 0, ?)""",
                        (student_username,
                         f"🏅 解锁荣誉徽章：{badge['name']}",
                         f"单轮答对 {correct_count} 题，获得 {badge['name']} 荣誉徽章！",
                         now),
                    )
                except Exception:
                    pass
                newly.append(badge)
    return newly


# ════════════════════════════════════════════
# API 端点
# ════════════════════════════════════════════

@router.post("/quest/start", summary="开始新闯关")
async def start_quest(request: Request):
    """开始一轮新的闯关——可选 use_bank 从题库出题"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role != 2:
        raise HTTPException(status_code=403, detail="仅学生可参与闯关")

    # 从系统配置读取出题模式（不由学生控制）
    # 题库数量 >= 500 时自动切换为题库模式
    from backend.api.config_router import get_config_value
    count_row = execute_query_one("SELECT COUNT(*) as cnt FROM quest_question_bank")
    bank_count = count_row["cnt"] if count_row else 0
    use_bank_config = get_config_value("QUEST_USE_BANK", False)
    use_bank = 1 if (use_bank_config or bank_count >= 500) else 0

    # 检查是否有未完成的闯关
    existing = execute_query_one(
        "SELECT id FROM quest_records WHERE student_username=? AND completed=0",
        (username,),
    )
    if existing:
        execute_insert_update(
            "UPDATE quest_records SET completed=-1, completed_at=? WHERE id=?",
            (_now(), existing["id"]),
        )

    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="API Key 未配置")

    now = _now()

    # 创建闯关记录（execute_insert_update 返回自增 ID）
    quest_id = execute_insert_update(
        """INSERT INTO quest_records
           (student_username, total_questions, answered_count, correct_count, score,
            wrong_question_index, lifelines_used, current_question_index, used_categories,
            completed, created_at, completed_at, use_bank)
           VALUES (?, ?, 0, 0, 0, 0, '[]', 0, '[]', 0, ?, NULL, ?)""",
        (username, MAX_QUEST_QUESTIONS, now, use_bank),
    )

    # 批量生成首批 BATCH_SIZE 道题（并行 AI + 题库混合）
    batch_count = min(BATCH_SIZE, MAX_QUEST_QUESTIONS)
    questions_batch = await _batch_generate(
        api_key, batch_count, [], 1, use_bank
    )

    if not questions_batch:
        raise HTTPException(status_code=500, detail="出题失败，请重试")

    used_cats = []
    for i, q_data in enumerate(questions_batch):
        cat = q_data.get("category", "综合")
        used_cats.append(cat)
        options_json = json.dumps(q_data["options"], ensure_ascii=False)
        execute_insert_update(
            """INSERT INTO quest_question_records
               (quest_id, sort_order, category, question_text, options, correct_answer,
                student_answer, is_correct, lifeline_used, time_spent, score, explanation,
                svg_content, has_svg, media_files, media_placeholders)
               VALUES (?, ?, ?, ?, ?, ?, '', -1, '', 0, 0, ?, ?, ?, ?, ?)""",
            (quest_id, i + 1, cat, q_data["question"], options_json,
             q_data["answer"], q_data.get("explanation", ""),
             q_data.get("svg_content", ""), q_data.get("has_svg", 0),
             q_data.get("media_files", ""), q_data.get("media_placeholders", "")),
        )

    execute_insert_update(
        "UPDATE quest_records SET used_categories=?, current_question_index=1 WHERE id=?",
        (json.dumps(used_cats, ensure_ascii=False), quest_id),
    )

    first = questions_batch[0]
    return {
        "quest_id": quest_id,
        "use_bank": bool(use_bank),
        "question": {
            "sort_order": 1,
            "category": first.get("category", "综合"),
            "question_text": first["question"],
            "options": first["options"],
            "explanation": first.get("explanation", ""),
            "svg_content": first.get("svg_content", ""),
            "has_svg": first.get("has_svg", 0),
            "media_files": first.get("media_files", ""),
            "media_placeholders": first.get("media_placeholders", ""),
        },
        "quest_info": {
            "answered_count": 0,
            "correct_count": 0,
            "score": 0,
            "current_question_index": 1,
            "total_questions": MAX_QUEST_QUESTIONS,
            "lifelines_used": [],
            "completed": 0,
        }
    }


@router.get("/quest/{quest_id}/question", summary="获取当前题目")
async def get_current_question(quest_id: int, request: Request):
    """获取闯关的当前题目"""
    user = get_current_user(request)
    username = user["username"]

    quest = _get_quest(quest_id, username)
    if quest["completed"] != 0:
        raise HTTPException(status_code=400, detail="该闯关已结束")

    current_idx = quest["current_question_index"]
    question = execute_query_one(
        """SELECT id, sort_order, category, question_text, options, correct_answer,
                  explanation, lifeline_used,
                  svg_content, has_svg, media_files, media_placeholders
           FROM quest_question_records
           WHERE quest_id=? AND sort_order=?""",
        (quest_id, current_idx),
    )
    if not question:
        raise HTTPException(status_code=404, detail="题目不存在")

    # 如果该题已使用锦囊，返回锦囊效果信息
    lifeline_used = question["lifeline_used"] or ""

    result = {
        "sort_order": question["sort_order"],
        "category": question["category"],
        "question_text": question["question_text"],
        "options": json.loads(question["options"]),
        "explanation": question["explanation"],
        "lifeline_used": lifeline_used,
        "lifeline_data": None,
        "svg_content": question.get("svg_content", ""),
        "has_svg": question.get("has_svg", 0),
        "media_files": question.get("media_files", ""),
        "media_placeholders": question.get("media_placeholders", ""),
    }

    # 如果使用过去伪存真，返回剩余选项
    if lifeline_used == "remove_one":
        options = json.loads(question["options"])
        result["lifeline_data"] = {"remaining_options": options}

    return result


@router.post("/quest/{quest_id}/answer", summary="提交答案")
async def submit_answer(quest_id: int, request: Request):
    """提交当前题目的答案"""
    user = get_current_user(request)
    username = user["username"]
    body = await request.json()
    answer = body.get("answer", "").strip().upper()
    time_spent = body.get("time_spent", 0)

    quest = _get_quest(quest_id, username)
    if quest["completed"] != 0:
        raise HTTPException(status_code=400, detail="该闯关已结束")

    current_idx = quest["current_question_index"]
    api_key, _ = get_api_keys(username)

    # 获取当前题目
    question = execute_query_one(
        """SELECT id, correct_answer, lifeline_used, options
           FROM quest_question_records
           WHERE quest_id=? AND sort_order=?""",
        (quest_id, current_idx),
    )
    if not question:
        raise HTTPException(status_code=404, detail="题目不存在")

    correct_answer = question["correct_answer"].strip().upper()
    is_correct = 1 if answer == correct_answer else 0
    lifeline_used = question["lifeline_used"] or ""
    lifelines_on_this = [l.strip() for l in lifeline_used.split(",") if l.strip()]

    # 计算得分
    score = _calc_question_score(current_idx, lifelines_on_this) if is_correct else 0

    # 更新题目记录
    execute_insert_update(
        """UPDATE quest_question_records
           SET student_answer=?, is_correct=?, time_spent=?, score=?
           WHERE id=?""",
        (answer, is_correct, time_spent, score, question["id"]),
    )

    if is_correct:
        # 答对：更新闯关记录
        correct_count = quest["correct_count"] + 1
        answered_count = quest["answered_count"] + 1
        total_score = quest["score"] + score

        if current_idx >= MAX_QUEST_QUESTIONS:
            # 已答完所有题，闯关成功
            execute_insert_update(
                """UPDATE quest_records
                   SET answered_count=?, correct_count=?, score=?,
                       current_question_index=?, completed=1, completed_at=?
                   WHERE id=?""",
                (answered_count, correct_count, total_score,
                 current_idx, _now(), quest_id),
            )
            # 发放奖励
            _award_quest_rewards(username, quest_id, correct_count, total_score)
            return {
                "is_correct": True,
                "score": score,
                "total_score": total_score,
                "terminated": False,
                "completed": True,
                "message": "🎉 恭喜你完成了全部 15 题！通关成功！",
            }
        else:
            next_idx = current_idx + 1
            used_categories = json.loads(quest["used_categories"]) if quest["used_categories"] else []
            use_bank = quest.get("use_bank", 0) or 0

            # 检查是否已有预生成的下一题
            buffered = execute_query_one(
                """SELECT id, sort_order, category, question_text, options,
                          correct_answer, explanation
                   FROM quest_question_records
                   WHERE quest_id=? AND sort_order=? AND is_correct=-1""",
                (quest_id, next_idx),
            )

            if buffered:
                # ✅ 缓存命中，直接返回（零等待）
                new_category = buffered["category"]
                used_categories.append(new_category)
                execute_insert_update(
                    """UPDATE quest_records
                       SET answered_count=?, correct_count=?, score=?,
                           current_question_index=?, used_categories=?
                       WHERE id=?""",
                    (answered_count, correct_count, total_score,
                     next_idx, json.dumps(used_categories, ensure_ascii=False), quest_id),
                )

                # 缓存即将耗尽时，后台补货
                remaining = execute_query_one(
                    """SELECT COUNT(*) as cnt FROM quest_question_records
                       WHERE quest_id=? AND is_correct=-1 AND sort_order>?""",
                    (quest_id, next_idx),
                )
                if remaining and remaining["cnt"] <= 1 and next_idx < MAX_QUEST_QUESTIONS:
                    asyncio.create_task(_async_refill_buffer(
                        quest_id, api_key, used_categories, next_idx + 1, use_bank
                    ))

                return {
                    "is_correct": True, "score": score, "total_score": total_score,
                    "terminated": False, "completed": False,
                    "explanation": buffered["explanation"],
                    "next_question": {
                        "sort_order": buffered["sort_order"],
                        "category": buffered["category"],
                        "question_text": buffered["question_text"],
                        "options": json.loads(buffered["options"]),
                        "explanation": buffered["explanation"],
                    },
                }
            else:
                # ❌ 缓存未命中（极少发生），同步生成
                question_data = _generate_question(api_key, used_categories, next_idx, use_bank)
                new_category = question_data.get("category", "综合")
                used_categories.append(new_category)
                options_json = json.dumps(question_data["options"], ensure_ascii=False)
                execute_insert_update(
                    """INSERT INTO quest_question_records
                       (quest_id, sort_order, category, question_text, options, correct_answer,
                        student_answer, is_correct, lifeline_used, time_spent, score, explanation)
                       VALUES (?, ?, ?, ?, ?, ?, '', -1, '', 0, 0, ?)""",
                    (quest_id, next_idx, new_category, question_data["question"],
                     options_json, question_data["answer"], question_data.get("explanation", "")),
                )

                execute_insert_update(
                    """UPDATE quest_records
                       SET answered_count=?, correct_count=?, score=?,
                           current_question_index=?, used_categories=?
                       WHERE id=?""",
                    (answered_count, correct_count, total_score,
                     next_idx, json.dumps(used_categories, ensure_ascii=False), quest_id),
                )

                return {
                    "is_correct": True, "score": score, "total_score": total_score,
                    "terminated": False, "completed": False,
                    "explanation": question_data.get("explanation", ""),
                    "next_question": {
                        "sort_order": next_idx,
                        "category": new_category,
                        "question_text": question_data["question"],
                        "options": question_data["options"],
                        "explanation": question_data.get("explanation", ""),
                    },
                }
    else:
        # 答错：闯关终止
        answered_count = quest["answered_count"] + 1
        execute_insert_update(
            """UPDATE quest_records
               SET answered_count=?, wrong_question_index=?, completed=-1, completed_at=?
               WHERE id=?""",
            (answered_count, current_idx, _now(), quest_id),
        )
        # 发放奖励（即使答错第一题，也尝试给参与分）
        _award_quest_rewards(username, quest_id, quest["correct_count"], quest["score"])

        # 获取正确答案对应的选项文本
        options = json.loads(question["options"]) if isinstance(question["options"], str) else question.get("options", {})

        return {
            "is_correct": False,
            "terminated": True,
            "correct_answer": correct_answer,
            "correct_answer_text": options.get(correct_answer, ""),
            "total_correct": quest["correct_count"],
            "total_score": quest["score"],
        }


@router.post("/quest/{quest_id}/timeout", summary="超时提交")
async def timeout_question(quest_id: int, request: Request):
    """超时（视为答错，闯关终止）"""
    user = get_current_user(request)
    username = user["username"]

    quest = _get_quest(quest_id, username)
    if quest["completed"] != 0:
        raise HTTPException(status_code=400, detail="该闯关已结束")

    current_idx = quest["current_question_index"]

    # 更新题目记录
    execute_insert_update(
        """UPDATE quest_question_records
           SET student_answer='__timeout__', is_correct=0, time_spent=20, score=0
           WHERE quest_id=? AND sort_order=?""",
        (quest_id, current_idx),
    )

    # 终止闯关
    answered_count = quest["answered_count"] + 1
    execute_insert_update(
        """UPDATE quest_records
           SET answered_count=?, wrong_question_index=?, completed=-1, completed_at=?
           WHERE id=?""",
        (answered_count, current_idx, _now(), quest_id),
    )
    _award_quest_rewards(username, quest_id, quest["correct_count"], quest["score"])

    return {
        "is_correct": False,
        "terminated": True,
        "reason": "timeout",
        "total_correct": quest["correct_count"],
        "total_score": quest["score"],
    }


@router.post("/quest/{quest_id}/lifeline", summary="使用锦囊")
async def use_lifeline(quest_id: int, request: Request):
    """使用锦囊"""
    user = get_current_user(request)
    username = user["username"]
    body = await request.json()
    lifeline_type = body.get("type", "")

    if lifeline_type not in LIFELINE_TYPES:
        raise HTTPException(status_code=400, detail=f"无效的锦囊类型: {lifeline_type}")

    quest = _get_quest(quest_id, username)
    if quest["completed"] != 0:
        raise HTTPException(status_code=400, detail="该闯关已结束")

    current_idx = quest["current_question_index"]
    lifelines_used = json.loads(quest["lifelines_used"]) if quest["lifelines_used"] else []

    # 检查该锦囊是否已使用
    if lifeline_type in lifelines_used:
        raise HTTPException(status_code=400, detail=f"锦囊「{lifeline_type}」已使用过")

    api_key, _ = get_api_keys(username)

    # 获取当前题目
    question = execute_query_one(
        """SELECT id, question_text, options, lifeline_used
           FROM quest_question_records
           WHERE quest_id=? AND sort_order=?""",
        (quest_id, current_idx),
    )
    if not question:
        raise HTTPException(status_code=404, detail="题目不存在")

    options = json.loads(question["options"]) if isinstance(question["options"], str) else {}
    question_text = question["question_text"]

    # 记录锦囊使用
    lifelines_used.append(lifeline_type)
    previous_lifeline = question["lifeline_used"] or ""
    new_lifeline = f"{previous_lifeline},{lifeline_type}" if previous_lifeline else lifeline_type

    execute_insert_update(
        "UPDATE quest_question_records SET lifeline_used=? WHERE id=?",
        (new_lifeline, question["id"]),
    )
    execute_insert_update(
        "UPDATE quest_records SET lifelines_used=? WHERE id=?",
        (json.dumps(lifelines_used, ensure_ascii=False), quest_id),
    )

    result = {"type": lifeline_type, "success": True}

    if lifeline_type == "remove_one":
        # 去掉一个错误答案
        correct = execute_query_one(
            "SELECT correct_answer FROM quest_question_records WHERE id=?",
            (question["id"],),
        )["correct_answer"]  # type: ignore[index]
        wrong_options = [k for k in options.keys() if k != correct]
        if wrong_options:
            removed = random.choice(wrong_options)
            del options[removed]
            result["remaining_options"] = options
            result["removed_option"] = removed

    elif lifeline_type == "phone_friend":
        advice = _call_ai_phone_friend(api_key, question_text, options)
        result["advice"] = advice

    elif lifeline_type == "audience_vote":
        votes = _call_ai_audience_vote(api_key, question_text, options)
        result["votes"] = votes

    return result


@router.get("/quest/{quest_id}/result", summary="获取闯关结果")
async def get_quest_result(quest_id: int, request: Request):
    """获取闯关结算结果"""
    user = get_current_user(request)
    username = user["username"]

    quest = _get_quest(quest_id, username)
    if quest["completed"] == 0:
        raise HTTPException(status_code=400, detail="该闯关尚未结束")

    # 获取所有题目记录（排除预生成但未作答的题目）
    questions = execute_query_dict(
        """SELECT sort_order, category, question_text, options, correct_answer,
                  student_answer, is_correct, lifeline_used, time_spent, score, explanation,
                  svg_content, has_svg, media_files, media_placeholders
           FROM quest_question_records
           WHERE quest_id=? AND is_correct != -1
           ORDER BY sort_order""",
        (quest_id,),
    )

    questions_list = []
    for q in questions:
        questions_list.append({
            "sort_order": q["sort_order"],
            "category": q["category"],
            "question_text": q["question_text"],
            "options": json.loads(q["options"]) if isinstance(q["options"], str) else q["options"],
            "correct_answer": q["correct_answer"],
            "student_answer": q["student_answer"] if q["student_answer"] else None,
            "is_correct": q["is_correct"],
            "lifeline_used": q["lifeline_used"] or "",
            "time_spent": q["time_spent"],
            "score": q["score"],
            "explanation": q["explanation"],
            "svg_content": q.get("svg_content", ""),
            "has_svg": q.get("has_svg", 0),
            "media_files": q.get("media_files", ""),
            "media_placeholders": q.get("media_placeholders", ""),
        })

    lifelines_used = json.loads(quest["lifelines_used"]) if quest["lifelines_used"] else []

    # 获取徽章计数
    badge_count = _get_or_init_badge_count(username)
    total_badge_count = execute_query_one(
        "SELECT COUNT(*) as cnt FROM student_badges WHERE student_username=?",
        (username,),
    )
    total_badges = total_badge_count["cnt"] if total_badge_count else 0

    return {
        "quest_id": quest_id,
        "completed": quest["completed"],
        "correct_count": quest["correct_count"],
        "answered_count": quest["answered_count"],
        "total_score": quest["score"],
        "wrong_question_index": quest["wrong_question_index"],
        "lifelines_used": lifelines_used,
        "questions": questions_list,
        "badge_count": badge_count,
        "total_badges": total_badges,
        "created_at": quest["created_at"],
        "completed_at": quest["completed_at"],
    }


@router.get("/quest/history", summary="闯关历史记录")
async def get_quest_history(
    request: Request,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=50),
):
    """获取个人闯关历史"""
    user = get_current_user(request)
    username = user["username"]

    offset = (page - 1) * page_size
    rows = execute_query_dict(
        """SELECT id, answered_count, correct_count, score, wrong_question_index,
                  completed, created_at, completed_at
           FROM quest_records
           WHERE student_username=?
           ORDER BY created_at DESC
           LIMIT ? OFFSET ?""",
        (username, page_size, offset),
    )

    total = execute_query_one(
        "SELECT COUNT(*) as cnt FROM quest_records WHERE student_username=?",
        (username,),
    )
    total_count = total["cnt"] if total else 0

    return {
        "records": [{
            "id": r["id"],
            "answered_count": r["answered_count"],
            "correct_count": r["correct_count"],
            "score": r["score"],
            "wrong_question_index": r["wrong_question_index"],
            "completed": r["completed"],
            "created_at": r["created_at"],
            "completed_at": r["completed_at"],
        } for r in rows],
        "total": total_count,
        "page": page,
        "page_size": page_size,
    }


@router.get("/quest/stats", summary="个人闯关统计")
async def get_quest_stats(request: Request):
    """获取个人闯关统计数据"""
    user = get_current_user(request)
    username = user["username"]

    # 总参与次数
    total_quests = execute_query_one(
        "SELECT COUNT(*) as cnt FROM quest_records WHERE student_username=?",
        (username,),
    )["cnt"]  # type: ignore[index]

    # 成功次数（答对≥1题）
    success_count = execute_query_one(
        "SELECT COUNT(*) as cnt FROM quest_records WHERE student_username=? AND completed=1 AND correct_count>=1",
        (username,),
    )["cnt"]  # type: ignore[index]

    # 总答对题数
    total_correct = execute_query_one(
        "SELECT COALESCE(SUM(correct_count), 0) as total FROM quest_records WHERE student_username=? AND completed!=0",
        (username,),
    )["total"]  # type: ignore[index]

    # 最佳战绩（最高答对题数）
    best = execute_query_one(
        "SELECT MAX(correct_count) as max_correct, MAX(score) as max_score FROM quest_records WHERE student_username=? AND completed!=0",
        (username,),
    )

    # 闯关徽章计数
    badge_count = _get_or_init_badge_count(username)

    # 总徽章数
    total_badges = execute_query_one(
        "SELECT COUNT(*) as cnt FROM student_badges WHERE student_username=?",
        (username,),
    )["cnt"]  # type: ignore[index]

    return {
        "total_quests": total_quests,
        "success_count": success_count,
        "total_correct": total_correct,
        "best_correct": best["max_correct"] if best else 0,
        "best_score": best["max_score"] if best else 0,
        "badge_count": badge_count,
        "total_badges": total_badges,
    }


@router.get("/quest/bank/stats", summary="题库统计")
async def get_bank_stats(request: Request):
    """获取闯关题库的统计数据"""
    user = get_current_user(request)
    _ = user  # 仅需登录

    total = execute_query_one("SELECT COUNT(*) as cnt FROM quest_question_bank")["cnt"]  # type: ignore[index]

    by_category = execute_query(
        """SELECT category, COUNT(*) as cnt, SUM(used_count) as total_used
           FROM quest_question_bank
           GROUP BY category ORDER BY cnt DESC"""
    )

    return {
        "total_questions": total,
        "by_category": [
            {
                "category": r[0] if isinstance(r, (list, tuple)) else r["category"],
                "count": r[1] if isinstance(r, (list, tuple)) else r["cnt"],
                "total_used": r[2] if isinstance(r, (list, tuple)) else r["total_used"],
            }
            for r in (by_category or [])
        ],
    }


@router.get("/quest/config", summary="获取闯关系统配置")
async def get_quest_config():
    """返回闯关挑战的系统配置（无需登录）
    当题库超过 500 题时自动切换为题库出题模式。
    """
    from backend.api.config_router import get_config_value

    # 检测题库数量
    count_row = execute_query_one("SELECT COUNT(*) as cnt FROM quest_question_bank")
    bank_count = count_row["cnt"] if count_row else 0
    bank_full = bank_count >= 500

    config_use_bank = bool(get_config_value("QUEST_USE_BANK", False))

    # 题库充足时强制使用题库模式，否则遵循配置
    effective = config_use_bank or bank_full

    return {
        "use_bank": effective,
        "config_use_bank": config_use_bank,
        "bank_count": bank_count,
        "bank_full": bank_full,
    }


@router.get("/quest/admin/grades", summary="[教师] 可查看的年级列表")
async def get_admin_quest_grades(request: Request):
    """管理员基于实际学生数据，教师基于任教范围"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role == 0:
        from backend.database import execute_query
        rows = execute_query(
            "SELECT DISTINCT grade FROM users WHERE role=2 AND grade IS NOT NULL AND grade!='' ORDER BY grade"
        )
        return [row[0] for row in rows]
    grades = get_teacher_grades(user["username"])
    return [g["name"] for g in grades]


@router.get("/quest/admin/classes", summary="[教师] 可查看的班级列表")
async def get_admin_quest_classes(
    request: Request,
    grade: str = Query("", description="年级"),
):
    """返回当前教师在某个年级可查看的班级列表（复用 score_router 统一函数）"""
    user = get_current_user(request)
    username = user["username"]

    rows = execute_query(
        "SELECT DISTINCT class FROM users WHERE role=2 AND grade=? ORDER BY class",
        (grade,),
    )
    all_classes = [r[0] for r in rows] if rows else []

    if username == "root":
        return all_classes

    from backend.permission_service import get_grade_by_name
    grade_info = get_grade_by_name(grade)
    allowed = []
    if grade_info:
        classes = get_teacher_classes(username, grade_info["id"])
        allowed = [c["name"].replace("班", "") for c in classes]
    if allowed:
        allowed_set = {int(a) for a in allowed if a.isdigit()}
        return [c for c in all_classes if c in allowed_set]
    return all_classes


@router.get("/quest/admin/records", summary="[教师] 查看学生闯关记录")
async def get_admin_quest_records(
    request: Request,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    grade: str = Query("", description="年级筛选"),
    class_name: str = Query("", description="班级筛选"),
    student_name: str = Query("", description="学生姓名搜索"),
):
    """教师/管理员查看学生闯关记录（自动按教师任课班级过滤）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看")

    conditions = ["qr.student_username = u.username"]
    params: list[str] = []

    # 非管理员：限制只能看自己班级的学生
    if username != "root":
        allowed_all: dict[str, list[str]] = {}
        # 获取教师所有年级的班级权限
        rows = execute_query("SELECT grade, class FROM users WHERE username=?", (username,))
        if rows:
            tg = (rows[0][0] or "").strip()
            tc = str(rows[0][1] or "").strip()
            allowed_all = parse_legacy_teacher_grade_class(tg, tc) if tg else {}

        if allowed_all:
            # 构建 (grade=G AND class IN (...)) OR ... 条件
            or_parts = []
            for g, classes in allowed_all.items():
                if classes:
                    placeholders = ",".join(["?" for _ in classes])
                    or_parts.append(f"(u.grade=? AND u.class IN ({placeholders}))")
                    params.append(g)
                    params.extend(classes)
                else:
                    or_parts.append("(u.grade=? AND 1=1)")
                    params.append(g)
            if or_parts:
                conditions.append(f"({' OR '.join(or_parts)})")

    if grade:
        conditions.append("u.grade=?")
        params.append(grade)
    if class_name:
        # 统一格式：从 "高一1班" 提取 "1"，兼容 "1" 和 "1班"
        cls_num = re.sub(r'[^\d]', '', str(class_name))
        conditions.append("(u.class=? OR u.class=?)")
        params.extend([cls_num, f"{cls_num}班"])
    if student_name:
        conditions.append("u.name LIKE ?")
        params.append(f"%{student_name}%")

    where_clause = " AND ".join(conditions)

    count_row = execute_query_one(
        f"SELECT COUNT(*) as cnt FROM quest_records qr, users u WHERE {where_clause}",
        tuple(params),
    )
    total_count = count_row["cnt"] if count_row else 0

    offset = (page - 1) * page_size

    rows = execute_query_dict(
        f"""SELECT qr.id, qr.student_username, u.name as student_name, u.grade, u.class as class_name,
                   qr.answered_count, qr.correct_count, qr.score, qr.wrong_question_index,
                   qr.lifelines_used, qr.completed, qr.created_at, qr.completed_at
           FROM quest_records qr, users u
           WHERE {where_clause}
           ORDER BY qr.created_at DESC
           LIMIT ? OFFSET ?""",
        tuple(params + [page_size, offset]),
    )

    records = []
    for r in rows:
        q_rows = execute_query_dict(
            """SELECT sort_order, category, question_text, options, correct_answer,
                      student_answer, is_correct, lifeline_used, time_spent, score, explanation
               FROM quest_question_records
               WHERE quest_id=? AND is_correct != -1
               ORDER BY sort_order""",
            (r["id"],),
        )
        questions = []
        for q in q_rows:
            questions.append({
                "sort_order": q["sort_order"],
                "category": q["category"],
                "question_text": q["question_text"],
                "options": json.loads(q["options"]) if isinstance(q["options"], str) else q["options"],
                "correct_answer": q["correct_answer"],
                "student_answer": q["student_answer"] if q["student_answer"] and q["student_answer"] != "__timeout__" else ("超时" if q["student_answer"] == "__timeout__" else "未答"),
                "is_correct": q["is_correct"],
                "lifeline_used": q["lifeline_used"] or "",
                "time_spent": q["time_spent"],
                "score": q["score"],
                "explanation": q["explanation"],
            })

        lifelines = json.loads(r["lifelines_used"]) if r["lifelines_used"] else []

        records.append({
            "id": r["id"],
            "student_username": r["student_username"],
            "student_name": r["student_name"],
            "grade": r["grade"],
            "class_name": r["class_name"],
            "answered_count": r["answered_count"],
            "correct_count": r["correct_count"],
            "score": r["score"],
            "wrong_question_index": r["wrong_question_index"],
            "completed": r["completed"],
            "lifelines_used": lifelines,
            "questions": questions,
            "created_at": r["created_at"],
            "completed_at": r["completed_at"],
        })

    return {
        "records": records,
        "total": total_count,
        "page": page,
        "page_size": page_size,
    }


@router.delete("/quest/admin/records/{quest_id}", summary="[教师] 删除闯关记录")
async def delete_quest_record(quest_id: int, request: Request):
    """教师/管理员删除指定的闯关记录及其题目"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可删除")

    # 检查记录是否存在
    quest = execute_query_one(
        "SELECT id FROM quest_records WHERE id=?", (quest_id,)
    )
    if not quest:
        raise HTTPException(status_code=404, detail="闯关记录不存在")

    # 删除题目记录
    execute_insert_update(
        "DELETE FROM quest_question_records WHERE quest_id=?", (quest_id,)
    )
    # 删除闯关记录
    execute_insert_update(
        "DELETE FROM quest_records WHERE id=?", (quest_id,)
    )

    return {"success": True, "message": f"闯关记录 #{quest_id} 已删除"}


# ═══════════════════════════════════════════════════════════
# 闯关题库管理（教师端 CRUD）
# ═══════════════════════════════════════════════════════════

class QuestBankCreate(BaseModel):
    """添加闯关题目请求"""
    category: str = "综合"
    question_text: str
    options: dict[str, str]
    correct_answer: str
    explanation: str = ""
    svg_content: str = ""
    has_svg: int = 0
    media_files: str = ""
    media_placeholders: str = ""


class QuestBankUpdate(BaseModel):
    """更新闯关题目请求"""
    category: str | None = None
    question_text: str | None = None
    options: dict[str, str] | None = None
    correct_answer: str | None = None
    explanation: str | None = None
    svg_content: str | None = None
    has_svg: int | None = None
    media_files: str | None = None
    media_placeholders: str | None = None


@router.get("/quest/admin/bank", summary="[教师] 获取闯关题库列表")
async def list_quest_bank(
    request: Request,
    category: str = Query("", description="分类筛选"),
    keyword: str = Query("", description="关键词搜索(题目)"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    """教师/管理员查看闯关题库列表，支持筛选和分页"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可管理闯关题库")

    conditions: list[str] = []
    params: list[Any] = []

    if category:
        conditions.append("category = ?")
        params.append(category)
    if keyword:
        conditions.append("question_text LIKE ?")
        params.append(f"%{keyword}%")

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    count_row = execute_query_one(
        f"SELECT COUNT(*) as cnt FROM quest_question_bank {where}",
        tuple(params),
    )
    total = count_row["cnt"] if count_row else 0

    offset = (page - 1) * page_size
    rows = execute_query_dict(
        f"""SELECT id, category, question_text, options, correct_answer, explanation,
                   used_count, svg_content, has_svg, media_files, media_placeholders,
                   created_at
           FROM quest_question_bank {where}
           ORDER BY id DESC
           LIMIT ? OFFSET ?""",
        tuple(params + [page_size, offset]),
    )

    questions = []
    for r in rows:
        # 解析 JSON 字符串字段
        media_files = r.get("media_files", "")
        if isinstance(media_files, str):
            try: media_files = json.loads(media_files) if media_files else []
            except: media_files = []
        media_placeholders = r.get("media_placeholders", "")
        if isinstance(media_placeholders, str):
            try: media_placeholders = json.loads(media_placeholders) if media_placeholders else []
            except: media_placeholders = []
        questions.append({
            "id": r["id"],
            "category": r["category"],
            "question_text": r["question_text"],
            "options": json.loads(r["options"]) if isinstance(r["options"], str) else r["options"],
            "correct_answer": r["correct_answer"],
            "explanation": r["explanation"],
            "used_count": r["used_count"],
            "svg_content": r.get("svg_content", ""),
            "has_svg": r.get("has_svg", 0),
            "media_files": media_files,
            "media_placeholders": media_placeholders,
            "created_at": r["created_at"],
        })

    # 同时返回分类列表供筛选
    categories = execute_query_dict(
        "SELECT category, COUNT(*) as cnt FROM quest_question_bank GROUP BY category ORDER BY cnt DESC"
    )

    return {
        "questions": questions,
        "total": total,
        "page": page,
        "page_size": page_size,
        "categories": [{"name": c["category"], "count": c["cnt"]} for c in categories],
    }


@router.get("/quest/admin/bank/{question_id}", summary="[教师] 获取单道闯关题")
async def get_quest_bank_question(question_id: int, request: Request):
    """获取单道闯关题库题目详情"""
    user = get_current_user(request)
    _ = user  # 仅验证登录

    row = execute_query_one(
        "SELECT * FROM quest_question_bank WHERE id=?",
        (question_id,),
    )
    if not row:
        raise HTTPException(status_code=404, detail="题目不存在")

    result = dict(row)
    if isinstance(result.get("options"), str):
        result["options"] = json.loads(result["options"])
    for field in ["media_files", "media_placeholders"]:
        val = result.get(field, "")
        if isinstance(val, str):
            try: result[field] = json.loads(val) if val else []
            except: result[field] = []
    return result


@router.post("/quest/admin/bank", summary="[教师] 添加闯关题")
async def create_quest_bank_question(req: QuestBankCreate, request: Request):
    """教师手动添加一道闯关题到题库"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可添加")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    options_json = json.dumps(req.options, ensure_ascii=False)

    # 检查是否已存在相同题目
    existing = execute_query_one(
        "SELECT id FROM quest_question_bank WHERE question_text=?",
        (req.question_text,),
    )
    if existing:
        raise HTTPException(status_code=400, detail="该题目已存在于题库中")

    qid = execute_insert_update(
        """INSERT INTO quest_question_bank
           (category, question_text, options, correct_answer, explanation,
            used_count, created_at, svg_content, has_svg, media_files, media_placeholders)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)""",
        (req.category, req.question_text, options_json, req.correct_answer,
         req.explanation, now,
         req.svg_content, req.has_svg, req.media_files, req.media_placeholders),
    )

    return {"id": qid, "message": "添加成功"}


@router.put("/quest/admin/bank/{question_id}", summary="[教师] 更新闯关题")
async def update_quest_bank_question(question_id: int, req: QuestBankUpdate, request: Request):
    """更新闯关题库中的题目"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可编辑")

    row = execute_query_one(
        "SELECT id FROM quest_question_bank WHERE id=?",
        (question_id,),
    )
    if not row:
        raise HTTPException(status_code=404, detail="题目不存在")

    updates: list[str] = []
    params: list[Any] = []

    for field in ["category", "question_text", "correct_answer", "explanation",
                   "svg_content", "has_svg", "media_files", "media_placeholders"]:
        val = getattr(req, field, None)
        if val is not None:
            updates.append(f"{field} = ?")
            params.append(val)

    if req.options is not None:
        updates.append("options = ?")
        params.append(json.dumps(req.options, ensure_ascii=False))

    if not updates:
        raise HTTPException(status_code=400, detail="没有需要更新的字段")

    params.append(question_id)
    execute_insert_update(
        f"UPDATE quest_question_bank SET {', '.join(updates)} WHERE id=?",
        tuple(params),
    )

    return {"success": True, "message": "更新成功"}


@router.delete("/quest/admin/bank/{question_id}", summary="[教师] 删除闯关题")
async def delete_quest_bank_question(question_id: int, request: Request):
    """删除闯关题库中的一道题"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可删除")

    row = execute_query_one(
        "SELECT id FROM quest_question_bank WHERE id=?",
        (question_id,),
    )
    if not row:
        raise HTTPException(status_code=404, detail="题目不存在")

    execute_insert_update(
        "DELETE FROM quest_question_bank WHERE id=?",
        (question_id,),
    )

    return {"success": True, "message": "删除成功"}


# ═══════════════════════════════════════════════════════════
# 闯关题库配图管理（教师端）
# ═══════════════════════════════════════════════════════════


def _get_quest_bank_question(question_id: int) -> dict[str, Any]:
    """获取闯关题库单题并校验存在"""
    row = execute_query_one(
        "SELECT * FROM quest_question_bank WHERE id=?", (question_id,)
    )
    if not row:
        raise HTTPException(status_code=404, detail="题目不存在")
    return row


@router.post("/quest/admin/bank/{question_id}/generate-svg", summary="[教师] 生成SVG配图")
async def quest_bank_generate_svg(question_id: int, request: Request):
    """为闯关题库题目生成 SVG 配图"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可操作")

    row = _get_quest_bank_question(question_id)
    api_key, _ = get_api_keys(user["username"])
    if not api_key:
        raise HTTPException(status_code=400, detail="API Key 未配置")

    prompt = SVG_GENERATE_PROMPT.format(
        description=row["question_text"],
        subject=row.get("category", "百科")
    )
    try:
        text = call_ai_sync_direct(prompt, api_key)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI 生成 SVG 失败: {str(e)}")

    # 提取 SVG 代码
    svg_match = re.search(r'<svg[\s\S]*?</svg>', text, re.IGNORECASE)
    svg_code = svg_match.group() if svg_match else ""

    if not svg_code:
        raise HTTPException(status_code=502, detail="AI 未能生成有效的 SVG 代码")

    # 安全过滤
    svg_code = re.sub(r'<script[\s\S]*?</script>', '', svg_code, flags=re.IGNORECASE)
    svg_code = re.sub(r'\bon\w+\s*=\s*["\'][\s\S]*?["\']', '', svg_code)

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_insert_update(
        "UPDATE quest_question_bank SET svg_content=?, has_svg=1 WHERE id=?",
        (svg_code, question_id),
    )

    return {"message": "SVG 配图已生成", "svg_code": svg_code}


@router.post("/quest/admin/bank/{question_id}/generate-image", summary="[教师] 万相生图")
async def quest_bank_generate_image(question_id: int, request: Request):
    """为闯关题库题目生成 AI 配图"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可操作")

    row = _get_quest_bank_question(question_id)
    q_text = (row["question_text"] or "")[:200]

    prompt = IMAGE_GEN_PROMPT_TEMPLATE.format(
        subject=row.get("category", "百科"),
        purpose="示意图",
        description=f"与「{q_text}」相关的教学插图",
    )

    from backend.api.image_gen_service import generate_and_save_image
    from backend.config import BASE_DIR
    from pathlib import Path

    media_dir = BASE_DIR / "question_media" / str(question_id)
    local_path = await generate_and_save_image(prompt, media_dir)
    if not local_path:
        raise HTTPException(status_code=502, detail="AI 生图失败，请检查 API Key 或稍后重试")

    relative_url = f"/api/files/question_media/{question_id}/{Path(local_path).name}"
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    media_files = json.loads(row.get("media_files") or "[]")
    key = "wanxiang"
    existing = next((f for f in media_files if f.get("key") == key), None)
    if existing:
        existing["url"] = relative_url
        existing["alt"] = q_text[:100]
        existing["created_at"] = now
    else:
        media_files.append({
            "key": key, "type": "image", "url": relative_url,
            "alt": q_text[:100], "created_at": now,
        })

    execute_insert_update(
        "UPDATE quest_question_bank SET media_files=? WHERE id=?",
        (json.dumps(media_files, ensure_ascii=False), question_id),
    )
    return {"message": "配图已生成", "url": relative_url, "key": key}


@router.post("/quest/admin/bank/{question_id}/generate-media/{placeholder_key}", summary="[教师] 占位符生图")
async def quest_bank_generate_media(question_id: int, placeholder_key: str, request: Request):
    """为闯关题目的占位符生成图片"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可操作")

    row = _get_quest_bank_question(question_id)
    placeholders = json.loads(row.get("media_placeholders") or "[]")
    target = next((p for p in placeholders if p["key"] == placeholder_key), None)
    if not target:
        raise HTTPException(status_code=404, detail="占位符不存在")

    prompt = IMAGE_GEN_PROMPT_TEMPLATE.format(
        subject=row.get("category", "百科"),
        purpose=target.get("purpose", "示意图"),
        description=target["description"],
    )

    from backend.api.image_gen_service import generate_and_save_image
    from backend.config import BASE_DIR
    from pathlib import Path

    media_dir = BASE_DIR / "question_media" / str(question_id)

    # 清理旧文件
    media_files = json.loads(row.get("media_files") or "[]")
    old_entry = next((f for f in media_files if f.get("key") == placeholder_key), None)
    if old_entry and old_entry.get("url"):
        old_filename = old_entry["url"].rstrip("/").split("/")[-1]
        old_path = media_dir / old_filename
        if old_path.exists():
            old_path.unlink()

    local_path = await generate_and_save_image(prompt, media_dir)
    if not local_path:
        raise HTTPException(status_code=502, detail="AI 生图失败")

    target["status"] = "generated"
    relative_url = f"/api/files/question_media/{question_id}/{Path(local_path).name}"

    file_entry = next((f for f in media_files if f.get("key") == placeholder_key), None)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    if file_entry:
        file_entry["url"] = relative_url
        file_entry["created_at"] = now
    else:
        media_files.append({
            "key": placeholder_key, "type": "image", "url": relative_url,
            "alt": target["description"], "created_at": now,
        })

    execute_insert_update(
        "UPDATE quest_question_bank SET media_placeholders=?, media_files=? WHERE id=?",
        (json.dumps(placeholders, ensure_ascii=False),
         json.dumps(media_files, ensure_ascii=False), question_id),
    )
    return {"message": "图片已生成", "url": relative_url, "placeholder_key": placeholder_key}


@router.post("/quest/admin/bank/{question_id}/upload-media/{placeholder_key}", summary="[教师] 上传图片")
async def quest_bank_upload_media(
    question_id: int, placeholder_key: str,
    request: Request, file: UploadFile = File(...),
):
    """上传图片替换闯关题目的占位符"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可操作")

    row = _get_quest_bank_question(question_id)

    _, ext = (file.filename or "").lower().rsplit(".", 1) if "." in (file.filename or "") else ("", ".jpg")
    ext = f".{ext}" if not ext.startswith(".") else ext
    allowed = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'}
    if ext not in allowed:
        raise HTTPException(status_code=400, detail=f"不支持的图片格式: {ext}")

    content = await file.read()
    from backend.api.config_router import get_config_value
    max_size_mb = get_config_value("MAX_IMAGE_SIZE_MB", 5)
    max_size = max_size_mb * 1024 * 1024
    if len(content) > max_size:
        raise HTTPException(status_code=400, detail=f"图片大小超过 {max_size_mb}MB 限制")

    from backend.config import BASE_DIR
    from pathlib import Path
    import uuid

    media_dir = BASE_DIR / "question_media" / str(question_id)
    media_dir.mkdir(parents=True, exist_ok=True)
    file_id = uuid.uuid4().hex
    save_path = media_dir / f"{file_id}{ext}"
    save_path.write_bytes(content)

    placeholders = json.loads(row.get("media_placeholders") or "[]")
    target = next((p for p in placeholders if p["key"] == placeholder_key), None)
    if target:
        target["status"] = "uploaded"

    relative_url = f"/api/files/question_media/{question_id}/{file_id}{ext}"
    media_files = json.loads(row.get("media_files") or "[]")
    file_entry = next((f for f in media_files if f.get("key") == placeholder_key), None)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    if file_entry:
        file_entry["url"] = relative_url
        file_entry["created_at"] = now
    else:
        media_files.append({
            "key": placeholder_key, "type": "image", "url": relative_url,
            "alt": target["description"] if target else file.filename,
            "created_at": now,
        })

    execute_insert_update(
        "UPDATE quest_question_bank SET media_placeholders=?, media_files=? WHERE id=?",
        (json.dumps(placeholders, ensure_ascii=False),
         json.dumps(media_files, ensure_ascii=False), question_id),
    )
    return {"message": "图片上传成功", "url": relative_url, "placeholder_key": placeholder_key}


@router.delete("/quest/admin/bank/{question_id}/svg", summary="[教师] 删除SVG配图")
async def quest_bank_delete_svg(question_id: int, request: Request):
    """删除闯关题目的 SVG 配图"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可操作")
    _get_quest_bank_question(question_id)
    execute_insert_update(
        "UPDATE quest_question_bank SET svg_content='', has_svg=0 WHERE id=?",
        (question_id,),
    )
    return {"message": "SVG 配图已删除"}


@router.delete("/quest/admin/bank/{question_id}/media/{placeholder_key}", summary="[教师] 删除配图")
async def quest_bank_delete_media(question_id: int, placeholder_key: str, request: Request):
    """删除闯关题目的配图"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可操作")

    row = _get_quest_bank_question(question_id)

    placeholders = json.loads(row.get("media_placeholders") or "[]")
    target = next((p for p in placeholders if p["key"] == placeholder_key), None)
    if target:
        target["status"] = "pending"

    media_files = json.loads(row.get("media_files") or "[]")
    deleted_file = next((f for f in media_files if f.get("key") == placeholder_key), None)
    if deleted_file and deleted_file.get("url"):
        from backend.config import BASE_DIR
        from pathlib import Path
        filename = deleted_file["url"].rstrip("/").split("/")[-1]
        file_path = BASE_DIR / "question_media" / str(question_id) / filename
        if file_path.exists():
            file_path.unlink()
    media_files = [f for f in media_files if f.get("key") != placeholder_key]

    execute_insert_update(
        "UPDATE quest_question_bank SET media_placeholders=?, media_files=? WHERE id=?",
        (json.dumps(placeholders, ensure_ascii=False),
         json.dumps(media_files, ensure_ascii=False), question_id),
    )
    return {"message": "配图已删除", "placeholder_key": placeholder_key}


# ── 内部辅助 ──

def _get_quest(quest_id: int, username: str) -> dict[str, Any]:
    """获取闯关记录并校验所有权"""
    quest = execute_query_one(
        """SELECT * FROM quest_records WHERE id=? AND student_username=?""",
        (quest_id, username),
    )
    if not quest:
        raise HTTPException(status_code=404, detail="闯关记录不存在")
    return quest


def _award_quest_rewards(student_username: str, quest_id: int,
                          correct_count: int, total_score: int):
    """发放闯关奖励"""
    quest_id_str = str(quest_id)
    today = _now()[:10]

    # 1. 参与基础分（每天仅限一次）
    today_rewarded = execute_query_one(
        """SELECT id FROM activity_rewards
           WHERE student_username=? AND activity_type='quest' AND reward_type='participation'
           AND created_at>=? AND created_at<?""",
        (student_username, f"{today} 00:00:00", f"{today} 23:59:59"),
    )
    if not today_rewarded:
        try:
            award_participation(
                student_username=student_username,
                activity_type="quest",
                activity_id=quest_id_str,
                activity_title=f"知识闯关 #{quest_id}",
            )
        except Exception as e:
            logger.warning(f"发放闯关参与分失败: {e}")

    # 2. 成绩等级奖励
    if correct_count > 0:
        try:
            award_grade(
                student_username=student_username,
                activity_type="quest",
                activity_id=quest_id_str,
                score=float(correct_count),
                total_score=float(MAX_QUEST_QUESTIONS),
                activity_title=f"知识闯关 #{quest_id}",
            )
        except Exception as e:
            logger.warning(f"发放闯关成绩奖励失败: {e}")

    # 3. 闯关徽章（答对≥1题算成功）
    if correct_count >= 1:
        try:
            new_count = _increment_badge_count(student_username)
            # 检测里程碑徽章
            _check_milestone_badges(student_username, new_count)
        except Exception as e:
            logger.warning(f"发放闯关徽章失败: {e}")

    # 4. 荣誉徽章检测
    try:
        _check_honor_badges(student_username, correct_count)
    except Exception as e:
        logger.warning(f"检测荣誉徽章失败: {e}")

    # 5. 称号升级检测（由 reward_engine 自动触发）
    try:
        update_student_total(student_username)
    except Exception as e:
        logger.warning(f"更新学生总积分失败: {e}")

    # 6. 徽章检测（现有徽章系统）
    try:
        check_and_unlock_badges(student_username)
    except Exception as e:
        logger.warning(f"检测现有徽章失败: {e}")
