"""
每日精选 API 路由 — 智能知识池（按需补充，不过期）

核心策略
────────────────
1. discovery_pool 表中积累卡片，永不过期
2. 学生请求 feed 时，从池中筛选最近7天内未看过的卡片，随机抽取
3. 当池中可用卡片不足时，后台异步触发 AI 补充
4. 补充只在"池快被看完"时发生，学生不常来就不补充，零浪费
"""
import json
import random
import re
import asyncio
from datetime import date, datetime, timedelta
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.api.chat_router import get_api_keys
from backend.api.ai_service import call_ai_sync_direct
from backend.database import execute_query, execute_insert_update
from backend.prompts.daily_discovery import (
    DAILY_DISCOVERY_GENERATE_PROMPT,
    DAILY_DISCOVERY_REFRESH_PROMPT,
)
from backend.logger import logger
from backend.prompts import apply_skills

router = APIRouter()

# ── 常量 ──
DAILY_CARD_COUNT = 6               # 每次展示 N 条
POOL_REFILL_THRESHOLD = 30         # 池中活跃卡片少于此值时触发补充
DAILY_REFRESH_LIMIT = 3            # 每人每日手动刷新上限
DAILY_POINTS_MAX = 5               # 每日通过浏览获得积分上限
POINTS_PER_VIEW = 1


# ── 请求/响应模型 ──

class FavoriteRequest(BaseModel):
    card_id: int
    action: str  # "favorite" / "unfavorite"

class ViewRequest(BaseModel):
    card_id: int


# ── 辅助函数 ──

def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def _today() -> str:
    return date.today().isoformat()

def _get_dashscope_api_key() -> str:
    key, _ = get_api_keys("")
    return key

def _row_to_card(r) -> dict:
    """将数据库行转为卡片字典"""
    tags = r[9]
    if tags and isinstance(tags, str) and tags != "[]":
        try:
            tags = json.loads(tags)
        except (json.JSONDecodeError, ValueError):
            tags = []
    else:
        tags = []
    return {
        "id": r[0],
        "emoji": r[1] or "💡",
        "category": r[2],
        "title": r[3],
        "summary": r[4],
        "detail": r[5],
        "source": r[6] or "",
        "fun_level": r[7] or 3,
        "related_subject": r[8] or "",
        "tags": tags,
    }

def _parse_ai_response(text: str) -> list[dict]:
    """解析AI返回的JSON，带自动修复"""
    if not text or not text.strip():
        raise ValueError("AI 返回为空")

    text = text.strip()

    # 1. 清理 markdown 代码块包裹
    if text.startswith("```"):
        # 尝试找 JSON 数组或对象
        start = text.find("[")
        if start < 0:
            start = text.find("{")
        end = text.rfind("]")
        if end < 0:
            end = text.rfind("}")
        if start >= 0 and end > start:
            text = text[start:end + 1]

    # 2. 尝试标准解析
    try:
        cards = json.loads(text)
        if isinstance(cards, list):
            return cards
        if isinstance(cards, dict):
            # 有些AI会包一层 {cards: [...]}
            for key in ("cards", "data", "result", "items"):
                if key in cards and isinstance(cards[key], list):
                    return cards[key]
            return [cards]
        raise ValueError("AI返回非数组")
    except json.JSONDecodeError:
        pass

    # 3. 尝试修复常见问题：单引号、尾部逗号
    try:

        # 替换单引号为双引号（但避开字符串内的）
        fixed = re.sub(r"(?<!\\)'(?=[^:\[\],{}]*:)", '"', text)
        fixed = re.sub(r",\s*([\]}])", r"\1", fixed)  # 删尾部逗号
        cards = json.loads(fixed)
        if isinstance(cards, list):
            return cards
    except Exception:
        pass

    # 4. 尝试提取 JSON 数组片段
    try:
        start = text.find("[")
        end = text.rfind("]")
        if start >= 0 and end > start:
            fragment = text[start:end + 1]
            # 修正常见问题
            fragment = re.sub(r",\s*([\]}])", r"\1", fragment)
            cards = json.loads(fragment)
            if isinstance(cards, list):
                return cards
    except Exception:
        pass

    # 5. 最后尝试：从 Markdown 格式降级解析
    try:
        cards = _parse_markdown_cards(text)
        if cards:
            return cards
    except Exception:
        pass

    raise ValueError("AI 返回格式错误")


def _parse_markdown_cards(text: str) -> list:
    """从 Markdown 格式降级解析卡片（当 AI 没按 JSON 输出时）"""
    import re

    # 按分隔线或连续换行拆分段落块
    blocks = re.split(r"\n---+\n|\n{3,}", text)
    cards = []
    for block in blocks:
        block = block.strip()
        if not block or len(block) < 20:
            continue

        # 提取键值对行: **领域：物理学** 或 **标题:** xxx
        lines = block.split("\n")
        fields = {}
        detail_parts = []
        for line in lines:
            line = line.strip()
            # 匹配 **键：值** 或 **键:** 值
            m = re.match(r'\*\*(.+?)[：:]\s*(.+?)\*\*$', line)
            if m:
                key = m.group(1).strip()
                val = m.group(2).strip()
                # 规范化字段名
                for k, alias in [("领域", "category"), ("类别", "category"),
                                 ("卡片标题", "title"), ("标题", "title"),
                                 ("摘要", "summary"), ("一句话摘要", "summary"),
                                 ("详细", "detail"), ("详细知识", "detail"),
                                 ("趣味等级", "fun_level"), ("趣味", "fun_level"),
                                 ("来源", "source"), ("知识来源", "source"),
                                 ("关联学科", "related_subject"), ("学科", "related_subject"),
                                 ("emoji", "emoji"), ("标签", "tags")]:
                    if k in key or key in k:
                        fields[alias] = val
                        break
                else:
                    detail_parts.append(line)
            else:
                # 非字段行 → 归入详情
                if line and not line.startswith("---"):
                    detail_parts.append(line)

        if not fields:
            continue

        # 用段落作为 detail
        if "detail" not in fields and detail_parts:
            fields["detail"] = " ".join(detail_parts)
        if "summary" not in fields and detail_parts:
            fields["summary"] = detail_parts[0][:80] if detail_parts else ""
        if "title" not in fields:
            continue  # 无标题则跳过

        # 类型转换
        for nk in ("fun_level",):
            if nk in fields:
                try:
                    m = re.search(r"\d", str(fields[nk]))
                    fields[nk] = int(m.group()) if m else 3
                except Exception:
                    fields[nk] = 3
        if "tags" in fields and isinstance(fields["tags"], str):
            fields["tags"] = [t.strip() for t in re.split(r"[、,，]", fields["tags"]) if t.strip()]

        cards.append(fields)

    return cards


# ═══════════════════════════════════════════════
# 核心服务类
# ═══════════════════════════════════════════════

class DiscoveryService:
    """每日精选服务 — 智能知识池"""

    @staticmethod
    def get_feed(username: str, grade: str = "") -> dict:
        """获取该学生的精选 Feed

        核心逻辑：
        1. 查出最近7天内看过的卡片ID（仅排除窗口内）
        2. 从池中筛选可看卡片
        3. 可用卡片不足时触发异步补充
        4. 随机抽取 N 条
        5. 标记已看，返回
        """
        # 第1步：查出可看卡片
        available = DiscoveryService._get_available_cards(username)

        # 第2步：不足时触发补充
        if len(available) < DAILY_CARD_COUNT:
            DiscoveryService._trigger_refill_if_needed(grade)

        # 第3步：随机抽取
        if len(available) >= DAILY_CARD_COUNT:
            selected = random.sample(available, DAILY_CARD_COUNT)
        elif len(available) > 0:
            selected = available
        else:
            selected = DiscoveryService._get_fallback_with_shorter_window(username, grade)

        # 第4步：标记已看
        DiscoveryService._mark_as_viewed(username, selected)

        return DiscoveryService._build_response(username, selected)

    @staticmethod
    def _get_excluded_card_ids(username: str) -> set[int]:
        """最近7天内看过的卡片ID"""
        cutoff = (datetime.now() - timedelta(days=7)).isoformat()
        rows = execute_query(
            "SELECT pool_card_id FROM discovery_viewed "
            "WHERE username=? AND viewed_at >= ?",
            (username, cutoff)
        )
        return {row[0] for row in rows}

    @staticmethod
    def _get_available_cards(username: str) -> list[dict]:
        """查出该学生可看的卡片（排除7天内看过的）"""
        excluded = DiscoveryService._get_excluded_card_ids(username)

        if excluded:
            placeholders = ",".join("?" for _ in excluded)
            rows = execute_query(
                f"SELECT id, emoji, category, title, summary, detail, "
                f"source, fun_level, related_subject, tags "
                f"FROM discovery_pool WHERE pool_status='active' "
                f"AND id NOT IN ({placeholders}) "
                f"ORDER BY view_count ASC, RANDOM()",
                tuple(excluded)
            )
        else:
            rows = execute_query(
                "SELECT id, emoji, category, title, summary, detail, "
                "source, fun_level, related_subject, tags "
                "FROM discovery_pool WHERE pool_status='active' "
                "ORDER BY view_count ASC, RANDOM()"
            )
        return [_row_to_card(r) for r in rows]

    @staticmethod
    def _get_fallback_with_shorter_window(username: str, grade: str) -> list[dict]:
        """兜底：7天窗口全看过 → 缩到3天 → 再不够就彻底放开"""
        # 尝试3天窗口
        cutoff = (datetime.now() - timedelta(days=3)).isoformat()
        rows = execute_query(
            "SELECT pool_card_id FROM discovery_viewed "
            "WHERE username=? AND viewed_at >= ?",
            (username, cutoff)
        )
        recent_ids = {row[0] for row in rows}

        if recent_ids:
            placeholders = ",".join("?" for _ in recent_ids)
            rows = execute_query(
                f"SELECT id, emoji, category, title, summary, detail, "
                f"source, fun_level, related_subject, tags "
                f"FROM discovery_pool WHERE pool_status='active' "
                f"AND id NOT IN ({placeholders}) "
                f"ORDER BY RANDOM() LIMIT ?",
                tuple(list(recent_ids) + [DAILY_CARD_COUNT])
            )
        else:
            rows = execute_query(
                "SELECT id, emoji, category, title, summary, detail, "
                "source, fun_level, related_subject, tags "
                "FROM discovery_pool WHERE pool_status='active' "
                "ORDER BY RANDOM() LIMIT ?",
                (DAILY_CARD_COUNT,)
            )
        cards = [_row_to_card(r) for r in rows]
        if len(cards) >= DAILY_CARD_COUNT:
            return cards

        # 池中不足，触发异步补充后再抽
        DiscoveryService._trigger_refill_if_needed(grade)
        rows = execute_query(
            "SELECT id, emoji, category, title, summary, detail, "
            "source, fun_level, related_subject, tags "
            "FROM discovery_pool WHERE pool_status='active' "
            "ORDER BY view_count ASC, RANDOM() LIMIT ?",
            (DAILY_CARD_COUNT,)
        )
        cards = [_row_to_card(r) for r in rows]
        if len(cards) >= DAILY_CARD_COUNT:
            return cards

        # 池仍空 → 同步首次填充（确保首访用户有内容，不走 async）
        DiscoveryService._sync_initial_fill(grade)
        rows = execute_query(
            "SELECT id, emoji, category, title, summary, detail, "
            "source, fun_level, related_subject, tags "
            "FROM discovery_pool WHERE pool_status='active' "
            "ORDER BY RANDOM() LIMIT ?",
            (DAILY_CARD_COUNT,)
        )
        return [_row_to_card(r) for r in rows]

    # ── 池补充 ──

    @staticmethod
    def _trigger_refill_if_needed(grade: str):
        """检查池中活跃卡片数，不足则异步补充"""
        try:
            row = execute_query(
                "SELECT COUNT(*) FROM discovery_pool WHERE pool_status='active'"
            )
            total = row[0][0] if row else 0
            if total >= POOL_REFILL_THRESHOLD:
                return
            asyncio.ensure_future(DiscoveryService._refill_pool_async(grade))
        except Exception as e:
            logger.warning(f"检查知识池状态失败: {e}")

    @staticmethod
    def _sync_initial_fill(grade: str):
        """同步首次填充（池空时调用，确保首访用户有内容）"""
        api_key = _get_dashscope_api_key()
        if not api_key:
            return

        # 双重检查：可能已被并发请求填充
        row = execute_query(
            "SELECT COUNT(*) FROM discovery_pool WHERE pool_status='active'"
        )
        if row and row[0][0] > 0:
            return

        try:
            prompt = DAILY_DISCOVERY_GENERATE_PROMPT.format(
                grade=grade or "中学生",
                count=8,
                extra_instructions="请生成8条有趣的知识卡片，涵盖不同领域。"
            )
            prompt = apply_skills(prompt, "daily-discovery")
            text = call_ai_sync_direct(prompt, api_key)
            cards = _parse_ai_response(text)
            for card in cards:
                try:
                    execute_insert_update(
                        """INSERT OR IGNORE INTO discovery_pool
                           (emoji, category, title, summary, detail, source,
                            fun_level, related_subject, tags, grade_level, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (card.get("emoji", "💡"), card.get("category", ""),
                         card.get("title", ""), card.get("summary", ""),
                         card.get("detail", ""), card.get("source", ""),
                         card.get("fun_level", 3), card.get("related_subject", ""),
                         json.dumps(card.get("tags") if isinstance(card.get("tags"), list) else [], ensure_ascii=False),
                         card.get("grade_level", "all"), _now())
                    )
                except Exception:
                    continue
        except Exception as e:
            logger.warning(f"首次同步填充失败: {e}")

    @staticmethod
    async def _refill_pool_async(grade: str):
        """异步补充知识池（分批次，幂等去重）"""
        api_key = _get_dashscope_api_key()
        if not api_key:
            return

        # 统计稀缺领域
        cats = execute_query(
            "SELECT category, COUNT(*) as cnt FROM discovery_pool "
            "GROUP BY category ORDER BY cnt ASC"
        )
        low_cats = [row[0] for row in cats[:3]] if cats else []
        extra = ""
        if low_cats:
            extra = f"请优先覆盖以下领域：{', '.join(low_cats)}。"

        for batch in range(2):
            prompt = DAILY_DISCOVERY_GENERATE_PROMPT.format(
                grade=grade or "中学生",
                count=8,
                extra_instructions=f"{extra}请确保与知识池中已有内容不重复。"
            )
            prompt = apply_skills(prompt, "daily-discovery")
            try:
                text = call_ai_sync_direct(prompt, api_key)
                cards = _parse_ai_response(text)
                saved = 0
                for card in cards:
                    try:
                        execute_insert_update(
                            """INSERT OR IGNORE INTO discovery_pool
                               (emoji, category, title, summary, detail, source,
                                fun_level, related_subject, tags, grade_level, created_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                            (card.get("emoji", "💡"), card.get("category", ""),
                             card.get("title", ""), card.get("summary", ""),
                             card.get("detail", ""), card.get("source", ""),
                             card.get("fun_level", 3), card.get("related_subject", ""),
                             json.dumps(card.get("tags") if isinstance(card.get("tags"), list) else [], ensure_ascii=False),
                             card.get("grade_level", "all"), _now())
                        )
                        saved += 1  # INSERT OR IGNORE 幂等，不影响真实新增数
                    except Exception:
                        continue
                logger.info(f"知识池补充: batch {batch}, 新增 {saved} 条")
            except Exception as e:
                logger.error(f"知识池补充失败(batch {batch}): {e}")
                continue

    # ── 手动刷新 ──

    @staticmethod
    def refresh(username: str, grade: str = "", role: int = 2) -> dict:
        """手动刷新 → AI即时生成专属卡片（教师无限制，学生日限3次）"""
        today_str = _today()
        is_student = (role == 2)

        if is_student:
            stats = DiscoveryService._get_daily_stats(username, today_str)
            remaining = DAILY_REFRESH_LIMIT - stats["refresh_count"]
            if remaining <= 0:
                raise HTTPException(400, f"今日刷新次数已达上限({DAILY_REFRESH_LIMIT}次)")
        else:
            remaining = 99  # 教师无限制

        # 统计已看领域，避免重复
        used_cats = DiscoveryService._get_viewed_categories(username)

        prompt = DAILY_DISCOVERY_REFRESH_PROMPT.format(
            count=DAILY_CARD_COUNT,
            used_categories=json.dumps(used_cats, ensure_ascii=False)
        )
        prompt = apply_skills(prompt, "daily-discovery")
        api_key = _get_dashscope_api_key()
        if not api_key:
            raise HTTPException(503, "AI 服务不可用，请配置 API Key")

        try:
            text = call_ai_sync_direct(prompt, api_key)
            new_cards = _parse_ai_response(text)
        except Exception as e:
            logger.warning(f"AI 刷新失败: {e}")
            raise HTTPException(502, "AI 生成失败，请稍后重试")

        # 存入刷新记录
        execute_insert_update(
            "INSERT INTO discovery_refresh_cards (username, date, card_data, created_at) "
            "VALUES (?, ?, ?, ?)",
            (username, today_str, json.dumps(new_cards, ensure_ascii=False), _now())
        )

        # 学生更新统计（教师不计数）
        if is_student:
            execute_insert_update(
                "INSERT OR REPLACE INTO discovery_daily_stats "
                "(username, date, view_count, refresh_count, points_earned) "
                "VALUES (?, ?, "
                "COALESCE((SELECT view_count FROM discovery_daily_stats WHERE username=? AND date=?), 0), "
                "COALESCE((SELECT refresh_count FROM discovery_daily_stats WHERE username=? AND date=?), 0) + 1, "
                "COALESCE((SELECT points_earned FROM discovery_daily_stats WHERE username=? AND date=?), 0))",
                (username, today_str, username, today_str, username, today_str, username, today_str)
            )
            return DiscoveryService._build_response(username, new_cards, remaining - 1)
        else:
            return DiscoveryService._build_response(username, new_cards, 99)

    # ── 浏览计分 ──

    @staticmethod
    def record_view(username: str, card_id: int, role: int = 2) -> int:
        """记录浏览 + 发积分（仅学生计分，日上限5分）"""
        today_str = _today()
        is_student = (role == 2)

        if is_student:
            stats = DiscoveryService._get_daily_stats(username, today_str)
            if stats["points_earned"] >= DAILY_POINTS_MAX:
                return 0

            # 检查今天是否已对该卡片计过分
            existing = execute_query(
                "SELECT id FROM discovery_view_log WHERE username=? "
                "AND pool_card_id=? AND date(created_at)=?",
                (username, card_id, today_str)
            )
            if existing:
                return 0

            execute_insert_update(
                "INSERT INTO discovery_view_log (username, pool_card_id, points_awarded, created_at) "
                "VALUES (?, ?, ?, ?)",
                (username, card_id, POINTS_PER_VIEW, _now())
            )

            # 更新日统计
            execute_insert_update(
                "INSERT OR REPLACE INTO discovery_daily_stats (username, date, view_count, refresh_count, points_earned) "
                "VALUES (?, ?, COALESCE((SELECT view_count FROM discovery_daily_stats WHERE username=? AND date=?), 0) + 1, "
                "COALESCE((SELECT refresh_count FROM discovery_daily_stats WHERE username=? AND date=?), 0), "
                "COALESCE((SELECT points_earned FROM discovery_daily_stats WHERE username=? AND date=?), 0) + ?)",
                (username, today_str, username, today_str, username, today_str, username, today_str, POINTS_PER_VIEW)
            )

            # 发放积分
            try:
                from backend.reward_engine import award_participation
                award_participation(username, "daily_discovery",
                                  f"{today_str}_{card_id}", "每日精选")
            except Exception as e:
                logger.warning(f"每日精选积分发放失败: {e}")

            return POINTS_PER_VIEW

        # 教师/管理员：记录浏览但不计分
        execute_insert_update(
            "UPDATE discovery_pool SET view_count = view_count + 1 WHERE id=?",
            (card_id,)
        )
        return 0

    # ── 收藏 ──

    @staticmethod
    def toggle_favorite(username: str, card_id: int, action: str):
        """收藏/取消收藏"""
        if action == "favorite":
            execute_insert_update(
                "INSERT OR IGNORE INTO discovery_favorites (username, pool_card_id, created_at) "
                "VALUES (?, ?, ?)",
                (username, card_id, _now())
            )
            execute_insert_update(
                "UPDATE discovery_pool SET favorite_count = favorite_count + 1 WHERE id=?",
                (card_id,)
            )
        elif action == "unfavorite":
            execute_insert_update(
                "DELETE FROM discovery_favorites WHERE username=? AND pool_card_id=?",
                (username, card_id)
            )
            execute_insert_update(
                "UPDATE discovery_pool SET favorite_count = MAX(0, favorite_count - 1) WHERE id=?",
                (card_id,)
            )

    @staticmethod
    def get_favorites(username: str) -> list[dict]:
        """获取该学生的收藏列表"""
        rows = execute_query(
            "SELECT p.id, p.emoji, p.category, p.title, p.summary, p.detail, "
            "p.source, p.fun_level, p.related_subject, p.tags "
            "FROM discovery_favorites f "
            "JOIN discovery_pool p ON f.pool_card_id = p.id "
            "WHERE f.username=? ORDER BY f.created_at DESC",
            (username,)
        )
        return [_row_to_card(r) for r in rows]

    # ── 辅助 ──

    @staticmethod
    def _get_daily_stats(username: str, date_str: str) -> dict:
        """获取今日统计"""
        row = execute_query(
            "SELECT COALESCE(view_count,0), COALESCE(refresh_count,0), COALESCE(points_earned,0) "
            "FROM discovery_daily_stats WHERE username=? AND date=?",
            (username, date_str)
        )
        if row:
            return {"view_count": row[0][0], "refresh_count": row[0][1], "points_earned": row[0][2]}
        return {"view_count": 0, "refresh_count": 0, "points_earned": 0}

    @staticmethod
    def _get_viewed_categories(username: str) -> list[str]:
        """统计该学生看过的领域"""
        rows = execute_query(
            "SELECT DISTINCT p.category FROM discovery_viewed v "
            "JOIN discovery_pool p ON v.pool_card_id = p.id "
            "WHERE v.username=? AND p.category IS NOT NULL AND p.category != ''",
            (username,)
        )
        return [row[0] for row in rows]

    @staticmethod
    def _mark_as_viewed(username: str, cards: list[dict]):
        """标记卡片为该学生已看过"""
        now = _now()
        for card in cards:
            card_id = card.get("id", 0)
            if card_id <= 0:
                continue
            try:
                execute_insert_update(
                    "INSERT OR IGNORE INTO discovery_viewed (username, pool_card_id, viewed_at) "
                    "VALUES (?, ?, ?)",
                    (username, card_id, now)
                )
            except Exception:
                pass

    @staticmethod
    def _get_favorite_card_ids(username: str) -> set[int]:
        """获取该学生收藏的卡片ID集合"""
        rows = execute_query(
            "SELECT pool_card_id FROM discovery_favorites WHERE username=?",
            (username,)
        )
        return {row[0] for row in rows}

    @staticmethod
    def _get_pool_size() -> int:
        row = execute_query(
            "SELECT COUNT(*) FROM discovery_pool WHERE pool_status='active'"
        )
        return row[0][0] if row else 0

    @staticmethod
    def _build_response(username: str, cards: list[dict],
                        refresh_remaining: int = None) -> dict:
        today_str = _today()
        stats = DiscoveryService._get_daily_stats(username, today_str)
        fav_ids = DiscoveryService._get_favorite_card_ids(username)

        for card in cards:
            card["is_favorited"] = card.get("id", 0) in fav_ids

        return {
            "date": today_str,
            "cards": cards,
            "pool_size": DiscoveryService._get_pool_size(),
            "refresh_remaining": (
                refresh_remaining if refresh_remaining is not None
                else DAILY_REFRESH_LIMIT - stats["refresh_count"]
            ),
            "today_view_count": stats["view_count"],
            "today_points_earned": stats["points_earned"],
            "today_points_max": DAILY_POINTS_MAX,
        }


# ═══════════════════════════════════════════════
# 路由端点
# ═══════════════════════════════════════════════

@router.get("/discovery/feed")
async def get_feed(request: Request):
    """获取精选 Feed（教师不计分无限制）"""
    user = get_current_user(request)
    username = user["username"]
    grade = user.get("grade", "")
    role = user.get("role", 2)
    try:
        result = DiscoveryService.get_feed(username, grade)
    except Exception as e:
        logger.warning(f"获取精选Feed异常: {e}")
        result = {
            "date": _today(),
            "cards": [],
            "pool_size": 0,
            "refresh_remaining": 99 if role != 2 else DAILY_REFRESH_LIMIT,
            "today_view_count": 0,
            "today_points_earned": 0,
            "today_points_max": DAILY_POINTS_MAX,
        }

    # 非学生隐藏积分信息
    if role != 2:
        result["today_view_count"] = 0
        result["today_points_earned"] = 0
        result["refresh_remaining"] = 99
    return result


@router.post("/discovery/refresh")
async def refresh_feed(request: Request):
    """手动刷新（AI即时生成，教师无限制）"""
    user = get_current_user(request)
    username = user["username"]
    grade = user.get("grade", "")
    role = user.get("role", 2)
    try:
        return DiscoveryService.refresh(username, grade, role)
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"手动刷新异常: {e}")
        raise HTTPException(500, "刷新失败，请稍后重试")


@router.post("/discovery/favorite")
async def toggle_favorite(req: FavoriteRequest, request: Request):
    """收藏/取消收藏"""
    user = get_current_user(request)
    DiscoveryService.toggle_favorite(user["username"], req.card_id, req.action)
    return {"success": True}


@router.get("/discovery/favorites")
async def get_favorites(request: Request):
    """获取收藏列表"""
    user = get_current_user(request)
    return {"cards": DiscoveryService.get_favorites(user["username"])}


@router.get("/discovery/stats")
async def get_stats(request: Request):
    """获取今日统计（教师返回空统计）"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role != 2:
        return {"view_count": 0, "refresh_count": 0, "points_earned": 0,
                "points_max": 0, "refresh_limit": 99}
    stats = DiscoveryService._get_daily_stats(user["username"], _today())
    return {
        **stats,
        "points_max": DAILY_POINTS_MAX,
        "refresh_limit": DAILY_REFRESH_LIMIT,
    }


@router.post("/discovery/view")
async def record_view(req: ViewRequest, request: Request):
    """记录浏览+积分（仅学生计分）"""
    user = get_current_user(request)
    role = user.get("role", 2)
    points = DiscoveryService.record_view(user["username"], req.card_id, role)
    return {"points_awarded": points}


@router.get("/discovery/pool-status")
async def pool_status(request: Request):
    """查看知识池状态（管理员用）"""
    user = get_current_user(request)
    if user.get("role", 2) not in (0, 1):
        raise HTTPException(403, "仅管理员和教师可查看")
    total = DiscoveryService._get_pool_size()
    cat_rows = execute_query(
        "SELECT category, COUNT(*) FROM discovery_pool "
        "WHERE pool_status='active' GROUP BY category ORDER BY COUNT(*) DESC"
    )
    categories = {row[0]: row[1] for row in cat_rows}
    return {"total_active": total, "categories": categories}


@router.post("/discovery/pool/refill")
async def refill_pool(request: Request):
    """手动触发知识池补充（管理员用）"""
    user = get_current_user(request)
    if user.get("role", 2) not in (0, 1):
        raise HTTPException(403, "仅管理员和教师可触发")
    asyncio.ensure_future(DiscoveryService._refill_pool_async(
        user.get("grade", "中学生")
    ))
    return {"success": True, "message": "知识池补充已触发，请稍后查看"}
