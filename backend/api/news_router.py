"""
热点新闻 API 路由 — 按需懒加载 + 时效窗口

核心策略
────────────────
1. 不设定时抓取 → 零后台开销
2. 学生访问时检查缓存是否过期（2小时），过期则在后台异步抓取
3. RSS抓取只取标题+摘要+链接，不调用AI（免费）
4. AI摘要仅在学生点击"阅读全文"时触发（按需，省钱）
5. 72小时清理一次过期新闻
"""
import json
import asyncio
import re
import time
from datetime import date, datetime, timedelta
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.api.chat_router import get_api_keys
from backend.api.ai_service import call_ai_sync_direct
from backend.database import execute_query, execute_insert_update, execute_query_one
from backend.prompts.news import NEWS_SUMMARIZE_PROMPT, NEWS_DAILY_BRIEFING_PROMPT
from backend.logger import logger

router = APIRouter()

# ── 常量 ──
CACHE_DURATION_MINUTES = 120    # 缓存有效期2小时
NEWS_WINDOW_HOURS = 72          # 只保留72小时内新闻
DAILY_POINTS_MAX = 3            # 每日积分上限
POINTS_PER_VIEW = 1
RSS_TIMEOUT = 15                # RSS抓取超时（秒）

# ── RSS 新闻源（全部免费，无需API Key） ──
RSS_FEEDS = {
    "新华社":   "http://www.news.cn/rss/rollnews.xml",
    "央视新闻": "https://news.cctv.com/rss/roll.xml",
    "人民日报": "http://www.people.com.cn/rss/politics.xml",
    "环球网":   "https://www.huanqiu.com/rss/roll.xml",
    "36氪":     "https://36kr.com/feed",
}

# ── 分类关键词映射 ──
CATEGORY_KEYWORDS = {
    "科技":  ["科技", "互联网", "数码", "AI", "人工智能", "航天", "软件", "手机"],
    "体育":  ["体育", "足球", "篮球", "奥运", "NBA", "中超", "亚运"],
    "财经":  ["财经", "经济", "金融", "股市", "基金", "贸易"],
    "教育":  ["教育", "学校", "考试", "学习", "高考", "考研", "留学"],
    "国际":  ["国际", "全球", "联合国", "外交", "美国", "欧盟"],
    "娱乐":  ["娱乐", "电影", "音乐", "明星", "综艺", "游戏"],
}


# ── 请求/响应模型 ──

class FavoriteRequest(BaseModel):
    news_id: int
    action: str  # favorite / unfavorite


# ── 辅助函数 ──

def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def _get_dashscope_api_key() -> str:
    key, _ = get_api_keys("")
    return key


# ── 内存锁（防并发重复抓取） ──
_fetch_lock: dict[str, float] = {}

def _acquire_lock(lock_key: str, timeout_seconds: int = 180) -> bool:
    now = time.time()
    last = _fetch_lock.get(lock_key, 0)
    if last and (now - last) < timeout_seconds:
        return False
    _fetch_lock[lock_key] = now
    return True

def _release_lock(lock_key: str):
    _fetch_lock.pop(lock_key, None)


# ═══════════════════════════════════════════════
# 核心服务
# ═══════════════════════════════════════════════

class NewsService:
    """热点新闻服务 — 按需懒加载"""

    # ── 获取新闻列表（懒加载触发点） ──

    @staticmethod
    def get_news_list(category: str = "", page: int = 1,
                      page_size: int = 20, username: str = "") -> dict:
        """获取新闻列表 — 页面访问入口"""
        NewsService._trigger_fetch_if_needed()

        where = "WHERE fetched_at >= ?"
        params: list[Any] = [
            (datetime.now() - timedelta(hours=NEWS_WINDOW_HOURS)).isoformat()
        ]
        if category:
            where += " AND category=?"
            params.append(category)

        rows = execute_query(
            f"SELECT id, title, url, source_name, "
            f"CASE WHEN is_ai_summarized=1 THEN COALESCE(ai_one_liner, '') ELSE '' END as display_summary, "
            f"category, image_url, published_at, fetched_at "
            f"FROM news_articles {where} "
            f"ORDER BY COALESCE(published_at, fetched_at) DESC "
            f"LIMIT ? OFFSET ?",
            tuple(params + [page_size, (page - 1) * page_size])
        )

        count_row = execute_query(
            f"SELECT COUNT(*) FROM news_articles {where}", tuple(params)
        )
        total = count_row[0][0] if count_row else 0

        # 查出该学生已读和已收藏的新闻ID
        viewed_ids = set()
        fav_ids = set()
        if username:
            vrows = execute_query(
                "SELECT news_id FROM news_view_log WHERE username=?",
                (username,)
            )
            viewed_ids = {r[0] for r in vrows}
            frows = execute_query(
                "SELECT news_id FROM news_favorites WHERE username=?",
                (username,)
            )
            fav_ids = {r[0] for r in frows}

        articles = []
        for r in rows:
            articles.append({
                "id": r[0], "title": r[1], "url": r[2],
                "source_name": r[3],
                "summary": r[4] or "",
                "category": r[5], "image_url": r[6] or "",
                "published_at": r[7] or "", "fetched_at": r[8] or "",
                "is_viewed": r[0] in viewed_ids,
                "is_favorited": r[0] in fav_ids,
            })

        return {
            "articles": articles,
            "total": total,
            "page": page,
            "page_size": page_size,
            "cache_fresh": NewsService._is_cache_fresh(),
        }

    # ── 获取新闻详情（触发AI摘要） ──

    @staticmethod
    def get_article_detail(news_id: int, username: str, role: int = 2) -> dict:
        """获取新闻详情 — 首次调用触发AI摘要+计分（仅学生计分）"""
        row = execute_query(
            "SELECT id, title, url, source_name, summary, ai_summary, "
            "ai_one_liner, category, image_url, related_subjects, tags, "
            "published_at, is_ai_summarized "
            "FROM news_articles WHERE id=?",
            (news_id,)
        )
        if not row:
            raise HTTPException(404, "新闻不存在")

        r = row[0]
        need_ai = not r[12]  # is_ai_summarized == 0

        if need_ai:
            NewsService._generate_ai_summary(news_id, r)

        points = NewsService._record_view(username, news_id, role)

        return {
            "id": r[0], "title": r[1], "url": r[2],
            "source_name": r[3], "summary": r[4],
            "ai_summary": r[5] or "",
            "ai_one_liner": r[6] or "",
            "category": r[7], "image_url": r[8] or "",
            "related_subjects": json.loads(r[9]) if r[9] else [],
            "tags": json.loads(r[10]) if r[10] else [],
            "published_at": r[11] or "",
            "points_awarded": points,
        }

    # ── 按需抓取触发 ──

    @staticmethod
    def _trigger_fetch_if_needed():
        """缓存过期才触发抓取"""
        if NewsService._is_cache_fresh():
            return
        lock_key = "news_fetch"
        if not _acquire_lock(lock_key):
            return
        asyncio.ensure_future(NewsService._fetch_async(lock_key))

    @staticmethod
    def _is_cache_fresh() -> bool:
        row = execute_query("SELECT MAX(fetched_at) FROM news_articles")
        if not row or not row[0][0]:
            return False
        try:
            last = datetime.fromisoformat(row[0][0])
            return (datetime.now() - last).total_seconds() < CACHE_DURATION_MINUTES * 60
        except Exception:
            return False

    @staticmethod
    async def _fetch_async(lock_key: str):
        """异步RSS抓取（免费，不调用AI）"""
        batch_id = datetime.now().strftime("%Y%m%d_%H%M%S")
        try:
            logger.info(f"[新闻] 开始按需抓取 batch={batch_id}")
            articles = NewsService._fetch_from_rss()

            new_count = 0
            for art in articles:
                try:
                    execute_insert_update(
                        """INSERT OR IGNORE INTO news_articles
                           (title, url, source_name, summary, category,
                            image_url, published_at, fetched_at, fetch_batch_id)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (art["title"], art["url"], art["source_name"],
                         art.get("summary", "")[:500],
                         art.get("category", "国内"),
                         art.get("image_url", ""),
                         art.get("published_at", ""),
                         _now(), batch_id)
                    )
                    if execute_query("SELECT changes()")[0][0] > 0:
                        new_count += 1
                except Exception as e:
                    logger.warning(f"[新闻] 入库失败: {art.get('title','')} {e}")

            execute_insert_update(
                "INSERT OR REPLACE INTO news_fetch_meta (batch_id, fetched_at, article_count, status) "
                "VALUES (?, ?, ?, 'success')",
                (batch_id, _now(), new_count)
            )
            NewsService._cleanup_old()
            logger.info(f"[新闻] 按需抓取完成: batch={batch_id}, 新增={new_count}")
        except Exception as e:
            logger.error(f"[新闻] 按需抓取失败: {e}")
            execute_insert_update(
                "INSERT OR REPLACE INTO news_fetch_meta (batch_id, fetched_at, article_count, status, message) "
                "VALUES (?, ?, 0, 'failed', ?)",
                (batch_id, _now(), str(e)[:200])
            )
        finally:
            _release_lock(lock_key)

    # ── RSS 抓取 ──

    @staticmethod
    def _fetch_from_rss() -> list[dict]:
        """从RSS源抓取最新新闻"""
        import feedparser
        all_articles = []
        for source_name, rss_url in RSS_FEEDS.items():
            try:
                feed = feedparser.parse(rss_url)
                for entry in feed.entries[:8]:
                    summary = entry.get("description", "") or entry.get("summary", "")
                    summary = re.sub(r'<[^>]+>', '', summary)[:300]

                    image_url = ""
                    if hasattr(entry, "media_content"):
                        for media in entry.media_content:
                            if media.get("type", "").startswith("image"):
                                image_url = media.get("url", "")
                                break
                    if not image_url and hasattr(entry, "links"):
                        for link in entry.links:
                            if link.get("type", "").startswith("image"):
                                image_url = link.get("href", "")
                                break

                    all_articles.append({
                        "title": entry.get("title", ""),
                        "url": entry.get("link", ""),
                        "source_name": source_name,
                        "summary": summary,
                        "category": NewsService._guess_category(entry),
                        "image_url": image_url,
                        "published_at": entry.get("published", ""),
                    })
            except Exception as e:
                logger.warning(f"[新闻] RSS抓取失败 [{source_name}]: {e}")

        # 去重
        seen = set()
        unique = []
        for art in all_articles:
            if art["url"] and art["url"] not in seen:
                seen.add(art["url"])
                unique.append(art)
        return unique

    @staticmethod
    def _guess_category(entry) -> str:
        """根据标签/标题猜测分类"""
        # 优先从标签判断
        if hasattr(entry, "tags") and entry.tags:
            tag_text = " ".join(t.get("term", "") for t in entry.tags)
            for cat, keywords in CATEGORY_KEYWORDS.items():
                if any(kw in tag_text for kw in keywords):
                    return cat
        # 从标题判断
        title = entry.get("title", "")
        for cat, keywords in CATEGORY_KEYWORDS.items():
            if any(kw in title for kw in keywords):
                return cat
        return "国内"

    # ── AI摘要（仅在点击阅读时触发） ──

    @staticmethod
    def _generate_ai_summary(news_id: int, row: tuple):
        """为单篇新闻生成AI摘要+学科关联"""
        try:
            api_key = _get_dashscope_api_key()
            if not api_key:
                return

            title = row[1]
            summary = row[4] or title

            prompt = NEWS_SUMMARIZE_PROMPT.format(
                title=title, content=summary
            )
            text = call_ai_sync_direct(prompt, api_key)
            result = json.loads(text)

            execute_insert_update(
                """UPDATE news_articles SET
                   ai_summary=?, ai_one_liner=?, related_subjects=?,
                   tags=?, is_ai_summarized=1
                   WHERE id=?""",
                (result.get("summary", ""),
                 result.get("one_liner", ""),
                 json.dumps(result.get("related_subjects", []), ensure_ascii=False),
                 json.dumps(result.get("tags", []), ensure_ascii=False),
                 news_id)
            )
            execute_insert_update(
                "UPDATE news_articles SET ai_view_count = ai_view_count + 1 WHERE id=?",
                (news_id,)
            )
        except Exception as e:
            logger.warning(f"[新闻] AI摘要生成失败 id={news_id}: {e}")

    # ── 浏览计分 ──

    @staticmethod
    def _record_view(username: str, news_id: int, role: int = 2) -> int:
        """记录阅读全文 + 发积分（仅学生计分）"""
        is_student = (role == 2)
        if not is_student:
            return 0

        today_str = date.today().isoformat()
        stats = NewsService._get_daily_stats(username, today_str)
        if stats["points_earned"] >= DAILY_POINTS_MAX:
            return 0

        existing = execute_query(
            "SELECT id FROM news_view_log WHERE username=? AND news_id=?",
            (username, news_id)
        )
        if existing:
            return 0

        execute_insert_update(
            "INSERT INTO news_view_log (username, news_id, points_awarded, created_at) "
            "VALUES (?, ?, ?, ?)",
            (username, news_id, POINTS_PER_VIEW, _now())
        )

        NewsService._update_daily_stats(username, today_str, POINTS_PER_VIEW)

        # 发放积分
        try:
            from backend.reward_engine import award_participation
            award_participation(username, "news_view",
                              f"{today_str}_{news_id}", "热点新闻")
        except Exception as e:
            logger.warning(f"新闻积分发放失败: {e}")

        return POINTS_PER_VIEW

    # ── 收藏 ──

    @staticmethod
    def toggle_favorite(username: str, news_id: int, action: str):
        if action == "favorite":
            execute_insert_update(
                "INSERT OR IGNORE INTO news_favorites (username, news_id, created_at) "
                "VALUES (?, ?, ?)",
                (username, news_id, _now())
            )
        elif action == "unfavorite":
            execute_insert_update(
                "DELETE FROM news_favorites WHERE username=? AND news_id=?",
                (username, news_id)
            )

    @staticmethod
    def get_favorites(username: str) -> list[dict]:
        rows = execute_query(
            "SELECT n.id, n.title, n.url, n.source_name, "
            "n.ai_one_liner, n.category, n.image_url, n.published_at "
            "FROM news_favorites f JOIN news_articles n ON f.news_id = n.id "
            "WHERE f.username=? ORDER BY f.created_at DESC",
            (username,)
        )
        return [
            {"id": r[0], "title": r[1], "url": r[2], "source_name": r[3],
             "summary": r[4] or "", "category": r[5], "image_url": r[6] or "",
             "published_at": r[7] or ""}
            for r in rows
        ]

    # ── 每日简报 ──

    @staticmethod
    def get_daily_briefing(username: str) -> dict:
        """获取今日简报（按需AI聚合生成）"""
        today_str = date.today().isoformat()
        row = execute_query(
            "SELECT brief_content, news_ids, created_at FROM news_daily_briefing WHERE date=?",
            (today_str,)
        )
        if row:
            return {"date": today_str, "brief_content": row[0][0],
                    "article_count": len(json.loads(row[0][1])),
                    "generated_at": row[0][2]}

        # 获取当前新闻列表
        articles = NewsService.get_news_list(page=1, page_size=15, username=username)
        if not articles["articles"]:
            return {"date": today_str, "brief_content": "暂无今日新闻",
                    "article_count": 0, "generated_at": _now()}

        news_lines = []
        for a in articles["articles"]:
            news_lines.append(f"- [{a['category']}] {a['title']}")
        news_text = "\n".join(news_lines)

        api_key = _get_dashscope_api_key()
        if not api_key:
            return {"date": today_str, "brief_content": "AI不可用，无法生成简报",
                    "article_count": 0, "generated_at": _now()}

        prompt = NEWS_DAILY_BRIEFING_PROMPT.format(
            date=today_str, news_list=news_text
        )
        try:
            content = call_ai_sync_direct(prompt, api_key)

            # AI返回空时的备用简报
            if not content or not content.strip():
                content = NewsService._build_fallback_briefing(today_str, articles["articles"])

            news_ids = [a["id"] for a in articles["articles"] if a.get("id")]
            execute_insert_update(
                "INSERT OR REPLACE INTO news_daily_briefing (date, brief_content, news_ids, created_at) "
                "VALUES (?, ?, ?, ?)",
                (today_str, content, json.dumps(news_ids), _now())
            )
            return {"date": today_str, "brief_content": content,
                    "article_count": len(news_ids), "generated_at": _now()}
        except Exception as e:
            logger.warning(f"[新闻] 生成简报失败: {e}")
            # AI不可用时用本地拼接的简报
            fallback = NewsService._build_fallback_briefing(today_str, articles["articles"])
            return {"date": today_str, "brief_content": fallback,
                    "article_count": len(articles["articles"]), "generated_at": _now()}

    @staticmethod
    def _build_fallback_briefing(date_str: str, articles: list) -> str:
        """AI不可用时，用本地拼接生成简单简报"""
        if not articles:
            return "📰 暂无今日新闻"
        lines = [f"📰 **今日要闻简报 - {date_str}**\n"]
        lines.append("☀️ 以下是最新资讯，快速了解今日要闻：\n")
        for i, a in enumerate(articles[:10], 1):
            cat = a.get("category", "国内")
            title = a.get("title", "")
            lines.append(f"{i}. [{cat}] {title}")
        if len(articles) > 10:
            lines.append(f"\n...以及另外 {len(articles) - 10} 篇新闻")
        lines.append("\n---\n💪 每天进步一点点，坚持带来大改变！")
        return "\n".join(lines)

    # ── 统计 ──

    @staticmethod
    def get_stats(username: str) -> dict:
        today_str = date.today().isoformat()
        stats = NewsService._get_daily_stats(username, today_str)
        total_rows = execute_query(
            "SELECT COUNT(*) FROM news_view_log WHERE username=?",
            (username,)
        )
        fav_rows = execute_query(
            "SELECT COUNT(*) FROM news_favorites WHERE username=?",
            (username,)
        )
        return {
            "today_views": stats["view_count"],
            "today_points": stats["points_earned"],
            "view_count": stats["view_count"],
            "points_earned": stats["points_earned"],
            "points_max": DAILY_POINTS_MAX,
            "total_views": total_rows[0][0] if total_rows else 0,
            "total_favorites": fav_rows[0][0] if fav_rows else 0,
        }

    @staticmethod
    def _get_daily_stats(username: str, date_str: str) -> dict:
        row = execute_query(
            "SELECT COALESCE(view_count,0), COALESCE(points_earned,0) "
            "FROM news_daily_stats WHERE username=? AND date=?",
            (username, date_str)
        )
        if row:
            return {"view_count": row[0][0], "points_earned": row[0][1]}
        return {"view_count": 0, "points_earned": 0}

    @staticmethod
    def _update_daily_stats(username: str, date_str: str, points: int):
        execute_insert_update(
            "INSERT OR REPLACE INTO news_daily_stats (username, date, view_count, points_earned) "
            "VALUES (?, ?, "
            "COALESCE((SELECT view_count FROM news_daily_stats WHERE username=? AND date=?), 0) + 1, "
            "COALESCE((SELECT points_earned FROM news_daily_stats WHERE username=? AND date=?), 0) + ?)",
            (username, date_str, username, date_str, username, date_str, points)
        )

    # ── 清理 ──

    @staticmethod
    def _cleanup_old():
        cutoff = (datetime.now() - timedelta(hours=NEWS_WINDOW_HOURS)).isoformat()
        execute_insert_update("DELETE FROM news_articles WHERE fetched_at < ?", (cutoff,))
        logger.info(f"[新闻] 已清理 {NEWS_WINDOW_HOURS} 小时前的过期数据")

    @staticmethod
    def get_categories() -> list[str]:
        rows = execute_query(
            "SELECT DISTINCT category FROM news_articles "
            "WHERE category IS NOT NULL AND category != '' "
            "ORDER BY category"
        )
        cats = [r[0] for r in rows]
        # 保证常用分类在前
        order = ["国内", "国际", "科技", "教育", "体育", "财经", "娱乐"]
        for c in order:
            if c in cats:
                cats.remove(c)
        return order + cats


# ═══════════════════════════════════════════════
# 路由端点
# ═══════════════════════════════════════════════

@router.get("/news/list")
async def get_news_list(
    request: Request,
    category: str = Query("", description="分类筛选"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=50),
):
    """获取新闻列表"""
    user = get_current_user(request)
    return NewsService.get_news_list(category, page, page_size, user["username"])


@router.get("/news/categories")
async def get_news_categories():
    """获取新闻分类列表"""
    return {"categories": NewsService.get_categories()}


@router.get("/news/{news_id}")
async def get_news_detail(news_id: int, request: Request):
    """获取新闻详情（触发AI摘要和积分，仅学生计分）"""
    user = get_current_user(request)
    role = user.get("role", 2)
    return NewsService.get_article_detail(news_id, user["username"], role)


@router.post("/news/favorite")
async def toggle_news_favorite(req: FavoriteRequest, request: Request):
    """收藏/取消收藏"""
    user = get_current_user(request)
    NewsService.toggle_favorite(user["username"], req.news_id, req.action)
    return {"success": True}


@router.get("/news/favorites/list")
async def get_news_favorites(request: Request):
    """获取收藏列表"""
    user = get_current_user(request)
    return {"articles": NewsService.get_favorites(user["username"])}


@router.get("/news/briefing/today")
async def get_today_briefing(request: Request):
    """获取今日简报"""
    user = get_current_user(request)
    return NewsService.get_daily_briefing(user["username"])


@router.get("/news/stats")
async def get_news_stats(request: Request):
    """获取个人新闻统计"""
    user = get_current_user(request)
    return NewsService.get_stats(user["username"])
