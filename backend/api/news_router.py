"""
热点新闻 API 路由 — 按需懒加载 + 时效窗口

核心策略
────────────────
1. 不设定时抓取 → 零后台开销；页面访问或点"刷新"时按需抓取
2. 抓到内容才按 2 小时缓存；抓到 0 条 / 抓取失败只按 5 / 30 分钟节流（不再"空结果也算新鲜"）
3. 时效窗口内没有可用新闻 → 立即判定过期并重新抓取（旧实现空表也当新鲜，页面能空白两小时）
4. RSS 抓取只取标题+摘要+链接，不调用 AI（免费）；AI 摘要在学生点开"阅读全文"时按需生成
5. 抓取用 httpx 直连并逐源校验 HTTP 状态码/条目数，失败原因写入 news_fetch_meta（feedparser
   对 404 与非 XML 响应不抛异常，旧实现因此静默失败，日志里一行错误都没有）
6. 已存在的 URL 按批次续期(fetched_at)而不是 INSERT OR IGNORE 丢弃；过期清理带保底，
   绝不允许把唯一还能看的一批删成空表
"""
import calendar
import json
import re
import sqlite3
import time
from pathlib import Path
from datetime import date, datetime, timedelta
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel

from starlette.concurrency import run_in_threadpool

from backend.api.dependencies import get_current_user
from backend.api.chat_router import get_api_keys
from backend.api.ai_service import call_ai_sync_direct
from backend.async_utils import spawn_bg
from backend.database import execute_query, execute_insert_update, execute_query_one
import backend.database as _database
from backend.prompts.news import NEWS_SUMMARIZE_PROMPT, NEWS_DAILY_BRIEFING_PROMPT
from backend.logger import logger
from backend.utils import extract_json_from_text

router = APIRouter()

# ── 常量 ──
CACHE_DURATION_MINUTES = 120        # 抓取成功后的缓存有效期 2 小时
EMPTY_RESULT_RETRY_MINUTES = 5      # NW12: 源可达但本轮 0 条时的重试间隔（旧实现按成功缓存 2 小时）
FETCH_RETRY_MINUTES = 10            # NW3: 两次抓取尝试的最小间隔
FETCH_FAIL_BACKOFF_MINUTES = 30     # NW3: 抓取失败后的退避时间
NEWS_WINDOW_HOURS = 72              # 只保留 72 小时内新闻
DAILY_POINTS_MAX = 3                # 每日积分上限
POINTS_PER_VIEW = 1
RSS_TIMEOUT = 10                    # NW10: 单源 HTTP 超时（秒），直接传给 httpx
MAX_ARTICLES_PER_SOURCE = 15        # NW10: 单个源每轮最多取多少条
MANUAL_REFRESH_MIN_INTERVAL = 60    # NW11: 同一用户手动强制刷新的最小间隔（秒）
DB_LOCK_TTL_MINUTES = 5             # NW9: 跨进程抓取锁的有效期
SOURCE_FAIL_THRESHOLD = 2           # NW18: 连续几轮取不到可用内容就熔断该源
BRIEFING_WAIT_SECONDS = 10          # NW21: 简报冷启动最多同步等这么久，超时返回 generating
BRIEFING_ESTIMATE_SECONDS = 20      # NW21: 给前端的预计等待提示
BRIEFING_INFLIGHT_TTL = 180         # NW21: 简报生成单飞标记有效期（秒）
SOURCE_COOLDOWN_MINUTES = 30        # NW18: 熔断后跳过多久（期间不再浪费超时）

SYSTEM_CONFIG_PATH = Path(__file__).resolve().parents[1] / "system_config.json"

FETCH_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
FETCH_ACCEPT = "application/rss+xml, application/xml, text/xml, */*"

# ── RSS 新闻源（全部免费，无需 API Key） ──
# NW10: 2026-09-12 服务器出口实测 —
#   新华社 news.cn/rss/rollnews.xml 、央视新闻 news.cctv.com/rss/roll.xml 、
#   环球网 huanqiu.com/rss/roll.xml 均已 HTTP 404；36氪 /feed 返回 HTML 反爬页(0 条目)；
#   人民日报 politics.xml 可解析但内容冻结在 2025-06-05，且条目恒定为同样 8 条 URL，
#   与 url UNIQUE + INSERT OR IGNORE 相互抵消 → 每轮新增 0 条，正是"刷新拿不到新闻"的根因。
#   以下替换为实测可解析、且带当日 pubDate 的境内源。
DEFAULT_RSS_FEEDS = {
    "中国新闻网":       "https://www.chinanews.com.cn/rss/importnews.xml",
    "中国新闻网·即时":  "https://www.chinanews.com.cn/rss/scroll-news.xml",
    "IT之家":           "https://www.ithome.com/rss/",
    "少数派":           "https://sspai.com/feed",
}

RSS_FEEDS = DEFAULT_RSS_FEEDS  # 兼容历史引用

# NW18: 备用源池 —— 平时不参与抓取；主源全部拿不到内容时自动顶替一轮，
# 并在日志里提示"哪个备用源可用"，验证稳定后再搬进 news_rss_feeds 固化。
# 候选源先用 scripts/check_news_feeds.py --url <候选RSS> 体检，别直接上主源。
RESERVE_RSS_FEEDS: dict[str, str] = {}


def _read_config_section(key: str) -> dict[str, str]:
    """从 system_config.json 读一段 {名称: URL} 配置（读不到就返回空）"""
    try:
        if SYSTEM_CONFIG_PATH.exists():
            raw = json.loads(SYSTEM_CONFIG_PATH.read_text(encoding="utf-8")).get(key)
            if isinstance(raw, dict):
                return {str(k): str(v).strip() for k, v in raw.items()}
    except Exception as e:
        logger.warning(f"[新闻] 读取配置 {key} 失败: {e}")
    return {}


def _apply_feed_overrides(base: dict[str, str], overrides: dict[str, str]) -> dict[str, str]:
    """同名覆盖 URL；值置空 = 禁用该内置源"""
    for k, v in overrides.items():
        if v == "":
            base.pop(k, None)
        else:
            base[k] = v
    return base


def _get_rss_feeds() -> dict[str, str]:
    """新闻源清单 — 允许 system_config.json 的 news_rss_feeds 覆盖（改源不必发版、不必重启）。

    覆盖语义：同名 key 改写 URL；把值写成 "" 表示禁用该内置源；新 key 即为新增源。
    """
    return {k: v for k, v in _apply_feed_overrides(
        dict(DEFAULT_RSS_FEEDS), _read_config_section("news_rss_feeds")).items() if v}


def _get_reserve_feeds() -> dict[str, str]:
    """备用源清单（内置 + system_config.json 的 news_rss_reserves）"""
    reserves = dict(RESERVE_RSS_FEEDS)
    return {k: v for k, v in
            _apply_feed_overrides(reserves, _read_config_section("news_rss_reserves")).items() if v}

# 源默认分类：标题没命中任何关键词时使用，避免科技源整体落进"国内"
SOURCE_DEFAULT_CATEGORY = {
    "IT之家": "科技",
    "少数派": "科技",
}

# ── 分类关键词映射 ──
CATEGORY_KEYWORDS = {
    "科技":  ["科技", "互联网", "数码", "AI", "人工智能", "航天", "软件", "硬件", "芯片",
              "手机", "电脑", "系统", "应用", "机器人", "数据", "算力", "大模型", "网络",
              "微软", "苹果", "谷歌", "英伟达", "华为", "小米", "开源"],
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

def _safe_json_loads(val: Any, default: Any = None) -> Any:
    """安全解析 JSON 字符串，失败返回默认值"""
    if val is None:
        return default
    if isinstance(val, (list, dict)):
        return val
    if isinstance(val, str):
        try:
            return json.loads(val)
        except (json.JSONDecodeError, ValueError):
            pass
    return default


# ── RSS 时间归一化 ──

def _entry_datetime(entry) -> Optional[datetime]:
    """NW10: 把 RSS 里五花八门的时间(RFC822 / ISO / 纯日期)统一成本地 naive datetime。

    旧实现把 entry["published"] 原样入库，中新网这类 RFC822 串会让后端
    ORDER BY published_at DESC 退化成错误的字符串排序，前端 slice(0,16) 也显示成半截英文。
    """
    for key in ("published_parsed", "updated_parsed"):
        st = entry.get(key)
        if st:
            try:
                return datetime.fromtimestamp(calendar.timegm(st))
            except Exception:
                pass
    for key in ("published", "updated", "date"):
        raw = str(entry.get(key) or "").strip()
        if not raw:
            continue
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d", "%Y/%m/%d"):
            try:
                return datetime.strptime(raw[:len(fmt) + 2].strip(), fmt)
            except ValueError:
                continue
        try:
            return datetime.fromisoformat(raw[:19])
        except Exception:
            pass
    return None


# ── 抓取锁：进程内快路径 + 数据库跨进程锁 ──
# NW9: 线上 IIS(httpPlatformHandler) 与本地开发实例共用同一个 smartkb.db，
#      内存锁互不可见 —— news_fetch_meta 里出现过相隔 5 秒的两个批次，
#      说明节流被并发绕过。这里补一层数据库级锁。
_fetch_lock: dict[str, float] = {}
_LOCK_KEY = "news_fetch"
_manual_refresh_gate: dict[str, float] = {}


def _acquire_lock(lock_key: str = _LOCK_KEY, timeout_seconds: int = 180) -> bool:
    now = time.time()
    last = _fetch_lock.get(lock_key, 0)
    if last and (now - last) < timeout_seconds:
        return False
    _fetch_lock[lock_key] = now
    return True


def _release_lock(lock_key: str = _LOCK_KEY):
    _fetch_lock.pop(lock_key, None)


def _db_acquire_fetch_lock() -> bool:
    """NW9: 跨进程抓取锁 —— 抢到返回 True；锁超过 DB_LOCK_TTL_MINUTES 视为持有者已死可接管。

    用独立短连接 + BEGIN IMMEDIATE，而不是走 execute_insert_update：
    后者对任何异常都会 ERROR 打整段 traceback，而"锁被别的进程占着"是正常业务分支。
    """
    stale = (datetime.now() - timedelta(minutes=DB_LOCK_TTL_MINUTES)).strftime("%Y-%m-%d %H:%M:%S")
    conn = None
    try:
        conn = sqlite3.connect(str(_database.DB_PATH), timeout=5)
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT acquired_at FROM news_fetch_lock WHERE lock_key=?", (_LOCK_KEY,)
        ).fetchone()
        if row and str(row[0] or "") >= stale:
            conn.rollback()
            return False
        conn.execute(
            "INSERT OR REPLACE INTO news_fetch_lock (lock_key, acquired_at) VALUES (?, ?)",
            (_LOCK_KEY, _now()),
        )
        conn.commit()
        return True
    except Exception as e:
        logger.warning(f"[新闻] 获取数据库抓取锁失败(降级放行): {type(e).__name__}: {str(e)[:80]}")
        return True
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def _db_release_fetch_lock():
    """释放跨进程抓取锁（只删自己的锁行）"""
    conn = None
    try:
        conn = sqlite3.connect(str(_database.DB_PATH), timeout=5)
        conn.execute("DELETE FROM news_fetch_lock WHERE lock_key=?", (_LOCK_KEY,))
        conn.commit()
    except Exception as e:
        logger.warning(f"[新闻] 释放抓取锁失败: {type(e).__name__}: {str(e)[:80]}")
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


# NW15: 同一篇新闻的 AI 摘要在飞标记 —— 摘要一次要 ~30s，
# 学生在它回填前反复点开同一篇，旧实现会重复起任务、重复烧 token。
_ai_summary_inflight: dict[int, float] = {}
_briefing_inflight: dict[str, float] = {}   # NW21: {日期: 起任务时间}
AI_SUMMARY_INFLIGHT_TTL = 300


def _try_mark_ai(news_id: int) -> bool:
    now = time.time()
    last = _ai_summary_inflight.get(news_id)
    if last and (now - last) < AI_SUMMARY_INFLIGHT_TTL:
        return False
    _ai_summary_inflight[news_id] = now
    if len(_ai_summary_inflight) > 2000:
        for k in [k for k, v in _ai_summary_inflight.items() if (now - v) > AI_SUMMARY_INFLIGHT_TTL]:
            _ai_summary_inflight.pop(k, None)
    return True


def _unmark_ai(news_id: int):
    _ai_summary_inflight.pop(news_id, None)


def _prune_refresh_gate():
    """手动刷新节流表兜底清理，避免长期驻留"""
    if len(_manual_refresh_gate) <= 500:
        return
    cutoff = time.time() - MANUAL_REFRESH_MIN_INTERVAL * 5
    for k in [k for k, v in _manual_refresh_gate.items() if v < cutoff]:
        _manual_refresh_gate.pop(k, None)


# ── NW18: 单源熔断（源死了就别一直撞墙） ──
# 结构: {源名: {"fails": 连续失败轮数, "until": 熔断截止 epoch}}
_feed_breaker: dict[str, dict[str, float]] = {}


def _breaker_mark(source: str, ok: bool) -> None:
    st = _feed_breaker.setdefault(source, {"fails": 0.0, "until": 0.0})
    if ok:
        if st["fails"] or st["until"]:
            logger.info(f"[新闻] 源 [{source}] 已恢复，解除熔断")
        st["fails"], st["until"] = 0.0, 0.0
        return
    st["fails"] += 1
    if st["fails"] >= SOURCE_FAIL_THRESHOLD:
        st["until"] = time.time() + SOURCE_COOLDOWN_MINUTES * 60
        logger.warning(
            f"[新闻] 源 [{source}] 连续 {int(st['fails'])} 轮无可用内容，"
            f"熔断 {SOURCE_COOLDOWN_MINUTES} 分钟后自动重试；"
            f"若长期如此，请更新 system_config.json 的 news_rss_feeds"
        )


def _breaker_open_until(source: str) -> float:
    """返回该源熔断剩余的 epoch 秒（<=0 表示未熔断）"""
    st = _feed_breaker.get(source)
    if not st:
        return 0.0
    left = st.get("until", 0.0) - time.time()
    if left <= 0:
        # 半开：熔断到期后不清零计数，成功一次才会清零，避免死源每 30 分钟又撞满墙
        return 0.0
    return left


def _breaker_snapshot() -> list[dict]:
    now = time.time()
    return [
        {"source": k, "consecutive_fails": int(v.get("fails", 0)),
         "cooldown_left_seconds": max(0, int(v.get("until", 0) - now))}
        for k, v in sorted(_feed_breaker.items())
        if v.get("fails", 0) or v.get("until", 0) > now
    ]


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

        cutoff_str = (datetime.now() - timedelta(hours=NEWS_WINDOW_HOURS)).strftime("%Y-%m-%d %H:%M:%S")
        where = "WHERE fetched_at >= ?"
        params: list[Any] = [cutoff_str]
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
        if total == 0 and not category:
            # NW5: 抓取长期失败时不让新闻页整页空白, 回退展示最近一批
            rows = execute_query(
                f"""SELECT id, title, url, source_name,
                          CASE WHEN is_ai_summarized=1 THEN COALESCE(ai_one_liner, '') ELSE '' END as display_summary,
                          category, image_url, published_at, fetched_at
                   FROM news_articles
                   WHERE fetched_at = (SELECT MAX(fetched_at) FROM news_articles)
                   ORDER BY COALESCE(published_at, fetched_at) DESC
                   LIMIT ? OFFSET ?""",
                (page_size, (page - 1) * page_size),
            )
            total = len(rows)

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
            "last_fetch": NewsService._fetch_health_summary(),
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
        if need_ai and _try_mark_ai(news_id):
            # NW: 摘要生成丢后台线程, 首屏立即返回, 再次打开即可看到 AI 摘要
            spawn_bg(NewsService._generate_ai_summary, news_id, r, name="news_ai_summary")

        points = NewsService._record_view(username, news_id, role)

        return {
            "id": r[0], "title": r[1], "url": r[2],
            "source_name": r[3], "summary": r[4],
            "ai_summary": r[5] or "",
            "ai_one_liner": r[6] or "",
            "category": r[7], "image_url": r[8] or "",
            "related_subjects": _safe_json_loads(r[9], []),
            "tags": _safe_json_loads(r[10], []),
            "published_at": r[11] or "",
            "points_awarded": points,
        }

    # ── 抓取状态与按需触发 ──

    @staticmethod
    def _last_attempt() -> tuple:
        """NW3: 返回 (上次抓取尝试时间, 上次抓取状态)；以 news_fetch_meta 为准"""
        row = execute_query(
            "SELECT fetched_at, status FROM news_fetch_meta ORDER BY fetched_at DESC LIMIT 1"
        )
        if not row:
            return None, ""
        try:
            return datetime.fromisoformat(str(row[0][0])), str(row[0][1] or "")
        except Exception:
            return None, ""

    @staticmethod
    def _fresh_window_minutes(status: str) -> int:
        """NW12: 不同抓取结果对应不同的"可认为新鲜"时长"""
        if status == "success":
            return CACHE_DURATION_MINUTES
        if status in ("partial", "empty"):
            return EMPTY_RESULT_RETRY_MINUTES
        if status == "failed":
            return FETCH_FAIL_BACKOFF_MINUTES
        return FETCH_RETRY_MINUTES

    @staticmethod
    def _stored_article_count() -> int:
        """时效窗口内当前可用(可展示)的新闻条数"""
        cutoff = (datetime.now() - timedelta(hours=NEWS_WINDOW_HOURS)).strftime("%Y-%m-%d %H:%M:%S")
        row = execute_query("SELECT COUNT(*) FROM news_articles WHERE fetched_at>=?", (cutoff,))
        return int(row[0][0]) if row else 0

    @staticmethod
    def _fetch_health_summary() -> dict:
        """最近一次抓取的健康度（给前端显示"更新于/失败原因"用）"""
        row = execute_query(
            "SELECT fetched_at, article_count, status, message FROM news_fetch_meta "
            "ORDER BY fetched_at DESC LIMIT 1"
        )
        if not row:
            return {"fetched_at": "", "article_count": 0, "status": "", "detail": {}}
        detail = _safe_json_loads(row[0][3], {})
        return {
            "fetched_at": str(row[0][0] or ""),
            "article_count": int(row[0][1] or 0),
            "status": str(row[0][2] or ""),
            "detail": detail if isinstance(detail, dict) else {},
        }

    @staticmethod
    def _busy_result() -> dict:
        """已有抓取在跑时的返回体（前端据此短暂重试，不重复触发抓取）"""
        return {
            "status": "busy",
            "fetched": 0, "inserted": 0, "renewed": 0,
            "stored_total": NewsService._stored_article_count(),
            "last_fetch": NewsService._fetch_health_summary(),
            "categories": NewsService.get_categories(),
        }

    @staticmethod
    def _trigger_fetch_if_needed(force: bool = False) -> bool:
        """NW2/NW3/NW9: 抓取放线程池后台执行，按上次结果节流；返回是否已交由后台抓取。

        force=True（点"刷新"）跳过节流与新鲜判断，只保留并发锁。
        """
        if not force:
            if NewsService._is_cache_fresh():
                return False
            last_at, last_status = NewsService._last_attempt()
            if last_at and last_status == "success":
                gap = (datetime.now() - last_at).total_seconds()
                if gap < FETCH_RETRY_MINUTES * 60:
                    return False
        if not _acquire_lock():
            return False
        if not _db_acquire_fetch_lock():
            _release_lock()
            return False
        spawn_bg(NewsService._fetch_and_store, name="news_rss_fetch")
        return True

    @staticmethod
    def _is_cache_fresh() -> bool:
        """NW12: 空结果不再冒充"新鲜"；窗口内已无可用新闻时立刻重抓。"""
        if NewsService._stored_article_count() == 0:
            return False
        last_at, status = NewsService._last_attempt()
        if not last_at:
            row = execute_query("SELECT MAX(fetched_at) FROM news_articles")
            if not row or not row[0][0]:
                return False
            try:
                last_at = datetime.fromisoformat(str(row[0][0]))
            except Exception:
                return False
            status = "success"
        window = NewsService._fresh_window_minutes(status)
        return (datetime.now() - last_at).total_seconds() < window * 60

    @staticmethod
    def _fetch_and_store() -> dict:
        """NW2/NW13: RSS 抓取 + 入库（同步，由调用方放线程池执行，不阻塞事件循环）。

        调用方需先持有 _acquire_lock() + _db_acquire_fetch_lock()，本函数负责在 finally 释放。
        NW13 三处关键修复：
          1) 已存在的 URL 改为"续期"而不是 INSERT OR IGNORE 丢弃 —— 旧实现下 72h 清理会把
             唯一一批新闻删掉，而下一轮抓取又因 URL 重复算 0 条，永远补不回来；
          2) 零入库保护：本轮一条都没抓到就不做过期清理，不会把页面删成空白；
          3) 抓取结果分级 success/partial/empty/failed 并逐源记录原因，供退避与前端展示。
        """
        batch_id = datetime.now().strftime("%Y%m%d_%H%M%S")
        started = time.time()
        summary: dict[str, Any] = {
            "batch_id": batch_id, "fetched": 0, "inserted": 0, "renewed": 0,
            "status": "failed", "sources": [],
        }
        try:
            articles, sources = NewsService._fetch_from_rss()
            summary["sources"] = sources
            summary["fetched"] = len(articles)

            existing = {r[0] for r in execute_query("SELECT url FROM news_articles")}
            for art in articles:
                try:
                    if art["url"] in existing:
                        execute_insert_update(
                            """UPDATE news_articles SET
                                   fetched_at=?, fetch_batch_id=?, source_name=?,
                                   category=?, image_url=?, published_at=?,
                                   summary=COALESCE(NULLIF(?, ''), summary)
                               WHERE url=?""",
                            (_now(), batch_id, art["source_name"],
                             art.get("category", "国内"), art.get("image_url", ""),
                             art.get("published_at", ""), art.get("summary", "")[:500],
                             art["url"]),
                        )
                        summary["renewed"] += 1
                    else:
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
                             _now(), batch_id),
                        )
                        summary["inserted"] += 1
                        existing.add(art["url"])
                except Exception as e:
                    logger.warning(f"[新闻] 入库失败: {str(art.get('title',''))[:30]} {e}")

            ok_sources = [s for s in sources if s.get("ok")]
            bad_sources = [s for s in sources if not s.get("ok")]
            if not ok_sources:
                summary["status"] = "failed"
            elif summary["fetched"] == 0:
                summary["status"] = "empty"
            elif bad_sources:
                summary["status"] = "partial"
            else:
                summary["status"] = "success"

            summary["took_ms"] = int((time.time() - started) * 1000)
            summary["stored_total"] = NewsService._stored_article_count()
            execute_insert_update(
                "INSERT OR REPLACE INTO news_fetch_meta "
                "(batch_id, fetched_at, article_count, status, message) VALUES (?, ?, ?, ?, ?)",
                (batch_id, _now(), summary["inserted"] + summary["renewed"], summary["status"],
                 json.dumps({"sources": sources, "took_ms": summary["took_ms"],
                             "inserted": summary["inserted"], "renewed": summary["renewed"],
                             "stored_total": summary["stored_total"]},
                            ensure_ascii=False)[:1900]),
            )
            if summary["fetched"] > 0:
                NewsService._cleanup_old()
                summary["stored_total"] = NewsService._stored_article_count()
            logger.info(
                f"[新闻] 抓取完成 status={summary['status']} fetched={summary['fetched']} "
                f"inserted={summary['inserted']} renewed={summary['renewed']} "
                f"sources_ok={len(ok_sources)}/{len(sources)} 窗口内留存={summary['stored_total']} "
                f"耗时={summary['took_ms']}ms"
            )
        except Exception as e:
            logger.error(f"[新闻] 按需抓取失败: {e}")
            summary["status"] = "failed"
            summary["error"] = str(e)[:200]
            execute_insert_update(
                "INSERT OR REPLACE INTO news_fetch_meta (batch_id, fetched_at, article_count, status, message) "
                "VALUES (?, ?, 0, 'failed', ?)",
                (batch_id, _now(), str(e)[:200])
            )
        finally:
            _release_lock()
            _db_release_fetch_lock()
        return summary

    # ── RSS 探测与抓取 ──

    @staticmethod
    def _probe_sources(feeds: dict[str, str]) -> dict[str, tuple[dict, list[dict]]]:
        """并发探测一组源，返回 {源名: (健康度, 可入库文章)}。

        纯探测：不做熔断记账、不写库 —— 抓取(_fetch_from_rss)、体检(diagnose_feeds)、
        命令行 scripts/check_news_feeds.py 三条路径共用同一套判断标准，结论不会走偏。

        这里也是对旧实现的关键修正：feedparser 对 HTTP 404 / 返回 HTML 反爬页
        **根本不抛异常**，只会安静给出 0 条目，所以旧代码 4 个死源跑了几个月而
        日志一行错误都没有。现在逐源校验 http 状态码 / 条目数 / 时效。
        """
        from concurrent.futures import ThreadPoolExecutor

        if not feeds:
            return {}
        cutoff = datetime.now() - timedelta(hours=NEWS_WINDOW_HOURS)

        def _grab_one(source_name: str, rss_url: str) -> tuple[dict, list[dict]]:
            import feedparser
            import httpx

            item: dict[str, Any] = {"source": source_name, "url": rss_url, "ok": False,
                                    "http": 0, "entries": 0, "kept": 0, "undated": 0}
            found: list[dict] = []
            try:
                with httpx.Client(timeout=RSS_TIMEOUT, follow_redirects=True,
                                  headers={"User-Agent": FETCH_USER_AGENT,
                                           "Accept": FETCH_ACCEPT}) as client:
                    resp = client.get(rss_url)
                item["http"] = resp.status_code
                if resp.status_code != 200:
                    item["error"] = f"HTTP {resp.status_code}"
                    return item, found

                feed = feedparser.parse(resp.content)
                entries = list(feed.entries or [])
                item["entries"] = len(entries)
                if not entries:
                    bozo = feed.get("bozo_exception")
                    item["error"] = "源无条目" + (
                        f"（{type(bozo).__name__}，多半返回的不是 XML）" if bozo else "")
                    return item, found

                latest: Optional[datetime] = None
                for entry in entries[:MAX_ARTICLES_PER_SOURCE]:
                    title = re.sub(r"\s+", " ", str(entry.get("title", "") or "")).strip()
                    link = str(entry.get("link", "") or "").strip()
                    if not title or not link:
                        continue
                    pub_dt = _entry_datetime(entry)
                    if pub_dt and (latest is None or pub_dt > latest):
                        latest = pub_dt
                    if pub_dt and (pub_dt < cutoff or pub_dt > datetime.now() + timedelta(hours=8)):
                        continue  # 超出时效的老内容 / 明显异常的"未来"时间，都不占名额
                    art = NewsService._entry_to_article(entry, title, link, source_name, pub_dt)
                    if pub_dt is None:
                        item["undated"] += 1
                    found.append(art)
                    item["kept"] += 1

                if latest:
                    item["latest"] = latest.strftime("%Y-%m-%d %H:%M:%S")
                item["ok"] = item["kept"] > 0
                item["dead"] = item["kept"] == 0
                if not item["ok"]:
                    item["error"] = (f"{item['entries']} 条均不在 {NEWS_WINDOW_HOURS} 小时时效内"
                                     f"（最新 {item.get('latest', '未知')}）—— 源可能已停止更新")
                elif item["undated"] == item["kept"]:
                    item["note"] = "无 pubDate，时效无法校验，不建议长期作为主源"
            except Exception as e:
                item["error"] = f"{type(e).__name__}: {str(e)[:120]}"
                item["dead"] = True
            return item, found

        results: dict[str, tuple[dict, list[dict]]] = {}
        with ThreadPoolExecutor(max_workers=min(4, len(feeds))) as pool:
            futures = {pool.submit(_grab_one, name, url): name
                       for name, url in feeds.items()}
            for fut, name in futures.items():
                try:
                    results[name] = fut.result(timeout=RSS_TIMEOUT + 10)
                except Exception as e:
                    results[name] = (
                        {"source": name, "url": feeds.get(name, ""), "ok": False, "http": 0,
                         "entries": 0, "kept": 0, "dead": True,
                         "error": f"{type(e).__name__}: {str(e)[:120]}"}, [])

        for name, (item, _arts) in results.items():
            if item.get("dead"):
                logger.warning(f"[新闻] 源不可用 [{name}]: {item.get('error', '')} {item.get('url', '')}")
        return results

    @staticmethod
    def _collect(results: dict[str, tuple[dict, list[dict]]],
                 order: list[str]) -> list[dict]:
        """按源声明顺序汇总并跨源去重（中新网两个频道会重复推送同一条）"""
        seen: set[str] = set()
        unique: list[dict] = []
        for name in order:
            for art in results.get(name, ({}, []))[1]:
                if art["url"] and art["url"] not in seen:
                    seen.add(art["url"])
                    unique.append(art)
        return unique

    @staticmethod
    def _fetch_from_rss() -> tuple[list[dict], list[dict]]:
        """抓取 RSS —— NW10 逐源校验 + NW18 熔断跳过 + NW18 备用源顶替。

        返回 (可入库文章, 逐源健康度)。
        """
        feeds = _get_rss_feeds()
        if not feeds:
            logger.error("[新闻] 未配置任何可用 RSS 源，"
                         "请检查 system_config.json 的 news_rss_feeds 是否把源全禁用了")
            return [], []

        health: list[dict] = []
        cooling = {n: _breaker_open_until(n) for n in feeds}
        to_probe = {n: u for n, u in feeds.items() if cooling.get(n, 0) <= 0}
        results: dict[str, tuple[dict, list[dict]]] = {}

        if to_probe:
            results = NewsService._probe_sources(to_probe)
            for name, (item, _arts) in results.items():
                _breaker_mark(name, ok=bool(item.get("ok")))
                health.append(item)

        for name, left in cooling.items():
            if left > 0:
                health.append({"source": name, "url": feeds[name], "ok": False, "http": 0,
                               "entries": 0, "kept": 0, "dead": True, "cooldown": True,
                               "error": f"连续失败已熔断，{int(left / 60) + 1} 分钟后自动重试"})

        unique = NewsService._collect(results, list(feeds.keys()))

        # NW18: 主源全军覆没 → 备用源自动顶替一轮（不计入熔断统计，只做临时续命）
        if not unique:
            reserves = _get_reserve_feeds()
            if reserves:
                res_results = NewsService._probe_sources(reserves)
                res_ok = [n for n, (it, _a) in res_results.items() if it.get("ok")]
                health.extend(it for it, _a in res_results.values())
                unique = NewsService._collect(res_results, list(reserves.keys()))
                if unique:
                    logger.info(f"[新闻] 主源全部失效，备用源顶替成功: {res_ok} —— "
                                f"验证稳定后请把备用源搬进 news_rss_feeds 固化")
            else:
                logger.error("[新闻] 主源全部失效且未配置备用源(news_rss_reserves) —— "
                             "执行 python scripts/check_news_feeds.py 找新源")

        ok_n = sum(1 for h in health if h.get("ok"))
        logger.info(f"[新闻] RSS源 {ok_n}/{len(health)} 可用"
                    f"（熔断 {sum(1 for h in health if h.get('cooldown'))}），本轮候选 {len(unique)} 条")
        return unique, health

    @staticmethod
    def diagnose_feeds(include_reserves: bool = True) -> dict:
        """NW17: 新闻源体检 —— 绕过熔断与缓存，把已配置源真实探一遍。

        设计初衷：新闻源哪天又变死源，不该等学生打开空白页才发现。
        用法：已登录的浏览器（带 smartkb_token cookie）直接打开
        https://站点/api/news/diagnose ，或命令行跑 scripts/check_news_feeds.py，
        两条路共用 _probe_sources，判断标准完全一致。
        """
        feeds = _get_rss_feeds()
        reserves = _get_reserve_feeds() if include_reserves else {}
        probe_map = dict(feeds)
        for k, v in reserves.items():
            probe_map[f"[备用] {k}"] = v

        results = NewsService._probe_sources(probe_map)
        sources = [it for it, _a in results.values()]
        is_reserve = lambda it: str(it.get("source", "")).startswith("[备用]")
        main_ok = [it for it in sources if it.get("ok") and not is_reserve(it)]
        reserve_ok = [it for it in sources if it.get("ok") and is_reserve(it)]
        if len(main_ok) >= 2:
            verdict = "ok"
        elif main_ok:
            verdict = "degraded"
        else:
            verdict = "dead"

        suggestion = ""
        if verdict == "dead":
            suggestion = ("主源全部不可用：用 python scripts/check_news_feeds.py --url 候选RSS "
                          "验证新源，写入 backend/system_config.json 的 news_rss_feeds，"
                          "再点一次“刷新”即生效（不用发版、不用重启）")
            if reserve_ok:
                suggestion += f"；本次备用源 {[r['source'] for r in reserve_ok]} 可用，可先搬进主源"
        elif verdict == "degraded":
            suggestion = "只剩 1 个主源可用，建议尽快补源，否则它一挂页面就空"
        if any(it.get("note") for it in sources):
            suggestion += "；注意：无 pubDate 的源无法校验时效，慎用"

        return {
            "checked_at": _now(),
            "verdict": verdict,
            "usable_sources": sum(1 for it in sources if it.get("ok")),
            "window_hours": NEWS_WINDOW_HOURS,
            "stored_total": NewsService._stored_article_count(),
            "sources": sources,
            "breaker": _breaker_snapshot(),
            "last_fetch": NewsService._fetch_health_summary(),
            "config": {"news_rss_feeds": feeds, "news_rss_reserves": reserves,
                       "config_file": str(SYSTEM_CONFIG_PATH)},
            "suggestion": suggestion,
        }

    @staticmethod
    def _entry_to_article(entry, title: str, link: str, source_name: str,
                          pub_dt: Optional[datetime]) -> dict:
        """RSS entry → 入库结构（摘要去 HTML、图片多级取值、时间归一化）"""
        raw_summary = entry.get("description", "") or entry.get("summary", "")
        summary = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", str(raw_summary or ""))).strip()

        image_url = ""
        for media in (getattr(entry, "media_content", None) or []):
            if str(media.get("type", "")).startswith("image"):
                image_url = media.get("url", "")
                break
        if not image_url:
            for link_obj in (getattr(entry, "links", None) or []):
                if str(link_obj.get("type", "")).startswith("image"):
                    image_url = link_obj.get("href", "")
                    break
        if not image_url:
            thumb = getattr(entry, "image", None)
            if isinstance(thumb, dict):
                image_url = thumb.get("href", "") or ""

        return {
            "title": title[:200],
            "url": link[:600],
            "source_name": source_name,
            "summary": summary[:500],
            "category": NewsService._guess_category(entry, source_name),
            "image_url": image_url,
            "published_at": (pub_dt or datetime.now()).strftime("%Y-%m-%d %H:%M:%S"),
        }

    @staticmethod
    def _guess_category(entry, source_name: str = "") -> str:
        """根据标签/标题猜测分类；都没命中时用该源的默认分类"""
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
        return SOURCE_DEFAULT_CATEGORY.get(source_name, "国内")

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
            # 注意：不注入技能 — 技能的结构化输出指令与 JSON 格式要求冲突
            # NW20: 关掉思考链 —— 摘要无需推理，实测单篇 30.5s → 约 3s，学生点开就能看见摘要
            text = call_ai_sync_direct(prompt, api_key, enable_thinking=False)

            # 安全解析 AI 返回的 JSON
            result = extract_json_from_text(text) if isinstance(text, str) else {}

            execute_insert_update(
                """UPDATE news_articles SET
                   ai_summary=?, ai_one_liner=?, related_subjects=?,
                   tags=?, is_ai_summarized=1
                   WHERE id=?""",
                (result.get("summary", "") if isinstance(result, dict) else "",
                 result.get("one_liner", "") if isinstance(result, dict) else "",
                 json.dumps(result.get("related_subjects", []), ensure_ascii=False) if isinstance(result, dict) else "[]",
                 json.dumps(result.get("tags", []), ensure_ascii=False) if isinstance(result, dict) else "[]",
                 news_id)
            )
            execute_insert_update(
                "UPDATE news_articles SET ai_view_count = ai_view_count + 1 WHERE id=?",
                (news_id,)
            )
        except Exception as e:
            logger.warning(f"[新闻] AI摘要生成失败 id={news_id}: {e}")
        finally:
            _unmark_ai(news_id)   # NW15: 生成结束(成功或失败)才允许再次排队

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

        # NW7: UNIQUE(username,news_id) + 先查后插并非原子, 并发双击会 500
        try:
            execute_insert_update(
                "INSERT OR IGNORE INTO news_view_log (username, news_id, points_awarded, created_at) "
                "VALUES (?, ?, ?, ?)",
                (username, news_id, POINTS_PER_VIEW, _now())
            )
        except Exception as e:
            logger.warning(f"[新闻] 浏览记录写入失败(忽略): {e}")
            return 0

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
        if action not in ("favorite", "unfavorite"):
            raise HTTPException(status_code=400, detail="无效的收藏操作")
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
    def _read_briefing_cache(today_str: str) -> Optional[dict]:
        row = execute_query(
            "SELECT brief_content, news_ids, created_at FROM news_daily_briefing WHERE date=?",
            (today_str,)
        )
        if not row:
            return None
        news_ids = _safe_json_loads(row[0][1], [])
        news_ids = news_ids if isinstance(news_ids, list) else []
        return {"date": today_str, "status": "ready", "brief_content": row[0][0],
                "article_count": len(news_ids), "generated_at": row[0][2]}

    @staticmethod
    def get_daily_briefing(username: str, wait_seconds: float = BRIEFING_WAIT_SECONDS) -> dict:
        """今日简报 —— NW21: 命中缓存直接返回；冷启动起后台生成 + 最多同步等 wait_seconds。

        旧实现把整次 AI 生成（思考链未关时实测 57.2s）压在请求里，而前端 axios 全局超时只有
        30s：学生看到"加载失败 + 空白抽屉"，服务器却仍在后台跑完并写入缓存 —— 所以"关掉再
        点开就有了"。现在拿不到就明确回 generating，由前端轮询，绝不假报失败。
        """
        today_str = date.today().isoformat()
        cached = NewsService._read_briefing_cache(today_str)
        if cached:
            return cached

        NewsService._start_briefing_generation(username)
        deadline = time.time() + max(0.0, wait_seconds)
        while time.time() < deadline:
            time.sleep(0.5)
            cached = NewsService._read_briefing_cache(today_str)
            if cached:
                return cached
        logger.info(f"[新闻] 简报仍在生成，返回 generating 交前端轮询（已等 {wait_seconds:.0f}s）")
        return {"date": today_str, "status": "generating", "brief_content": "",
                "article_count": 0, "generated_at": "",
                "estimated_seconds": BRIEFING_ESTIMATE_SECONDS,
                "message": "AI 正在生成今日简报"}

    @staticmethod
    def _start_briefing_generation(username: str) -> bool:
        """NW21: 单飞 —— 同一天只放一个生成任务，避免多个学生同时点开重复烧 AI"""
        today_str = date.today().isoformat()
        last = _briefing_inflight.get(today_str, 0.0)
        if last and (time.time() - last) < BRIEFING_INFLIGHT_TTL:
            return False
        _briefing_inflight[today_str] = time.time()
        return spawn_bg(NewsService._generate_briefing, username, name="news_daily_briefing")

    @staticmethod
    def _generate_briefing(username: str) -> bool:
        """后台生成今日简报并写缓存。

        一定落库（AI 失败就落本地拼接的兜底稿），否则前端轮询永远等不到结果；
        失败且没落库时才清掉单飞标记，让下一次点开能重试。
        """
        today_str = date.today().isoformat()
        ok = False
        try:
            articles = NewsService.get_news_list(page=1, page_size=15, username=username)["articles"]
            ids = [a["id"] for a in articles if a.get("id")]
            content = ""
            if not articles:
                content = NewsService._build_fallback_briefing(today_str, [])
            else:
                news_text = "\n".join(f"- [{a['category']}] {a['title']}" for a in articles)
                prompt = NEWS_DAILY_BRIEFING_PROMPT.format(date=today_str, news_list=news_text)
                # NW21: 不再注入教学技能 —— "禁止跳步/展示过程/实例驱动"这类约束与新闻简报冲突，
                #       实测把输出从 367 字灌水到 904 字，白烧 token 还拖慢；与 commit 3075d36
                #       （JSON 端点全面移除技能注入）同一判断。
                api_key = _get_dashscope_api_key()
                if api_key:
                    try:
                        content = call_ai_sync_direct(prompt, api_key, enable_thinking=False)
                    except Exception as e:
                        logger.warning(f"[新闻] 简报 AI 生成失败，改用本地兜底稿: {e}")
                if not content or not content.strip():
                    content = NewsService._build_fallback_briefing(today_str, articles)
            execute_insert_update(
                "INSERT OR REPLACE INTO news_daily_briefing (date, brief_content, news_ids, created_at) "
                "VALUES (?, ?, ?, ?)",
                (today_str, content, json.dumps(ids), _now())
            )
            logger.info(f"[新闻] 今日简报已生成：{len(content)} 字，覆盖 {len(ids)} 条新闻")
            ok = True
        except Exception as e:
            logger.error(f"[新闻] 生成简报异常: {e}")
        finally:
            if not ok:
                _briefing_inflight.pop(today_str, None)
        return ok

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
        """NW13: 清理带保底 —— 删除后窗口内就没数据时直接跳过。

        旧实现"先按 URL 去重(全部忽略→0 条)、再无条件清理过期"，等于每 72 小时
        自己把唯一一批新闻删空，之后长期 0 条，页面整页空白。
        """
        cutoff = (datetime.now() - timedelta(hours=NEWS_WINDOW_HOURS)).strftime("%Y-%m-%d %H:%M:%S")
        keep = execute_query("SELECT COUNT(*) FROM news_articles WHERE fetched_at>=?", (cutoff,))
        if keep and int(keep[0][0] or 0) > 0:
            execute_insert_update("DELETE FROM news_articles WHERE fetched_at < ?", (cutoff,))
            return
        newest = execute_query("SELECT MAX(fetched_at) FROM news_articles")
        if newest and newest[0][0]:
            floor = str(newest[0][0])
            execute_insert_update(
                "DELETE FROM news_articles WHERE fetched_at < ? AND fetched_at <> ?",
                (cutoff, floor),
            )
            logger.info("[新闻] 窗口内已无留存，仅清理更早批次，保留最近一批兜底展示")

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
    try:
        return NewsService.get_news_list(category, page, page_size, user["username"])
    except Exception as e:
        logger.warning(f"获取新闻列表异常: {e}")
        return {"articles": [], "total": 0, "page": page, "page_size": page_size, "cache_fresh": False}


@router.get("/news/categories")
async def get_news_categories(request: Request):
    """获取新闻分类列表(NW6: 与其余新闻端点一致, 需要登录)"""
    get_current_user(request)
    return {"categories": NewsService.get_categories()}


@router.post("/news/refresh")
async def refresh_news(request: Request):
    """NW11: 手动强制抓取 —— 同步抓完再返回真实结果。

    旧实现的"刷新"只是重读列表：抓取既被 2 小时缓存/10 分钟节流拦住，又是后台异步，
    本次响应必然还是旧数据，所以点了毫无效果还提示"已刷新"。现在前端点刷新会真的等一次
    抓取完成，并按 inserted / status / 源健康度给出准确反馈。
    """
    user = get_current_user(request)
    username = user["username"]
    now_ts = time.time()
    last_ts = _manual_refresh_gate.get(username, 0)
    if now_ts - last_ts < MANUAL_REFRESH_MIN_INTERVAL:
        wait_s = int(MANUAL_REFRESH_MIN_INTERVAL - (now_ts - last_ts)) + 1
        raise HTTPException(429, f"刷新过于频繁，请 {wait_s} 秒后再试")
    _manual_refresh_gate[username] = now_ts
    _prune_refresh_gate()

    def _do_force_fetch() -> dict:
        if not _acquire_lock():
            return NewsService._busy_result()
        if not _db_acquire_fetch_lock():
            _release_lock()
            return NewsService._busy_result()
        out = NewsService._fetch_and_store()
        if isinstance(out, dict):
            out["categories"] = NewsService.get_categories()
            out["last_fetch"] = NewsService._fetch_health_summary()
        return out

    return await run_in_threadpool(_do_force_fetch)


@router.get("/news/fetch-status")
async def get_news_fetch_status(request: Request):
    """NW11: 抓取健康度（前端显示"更新于 HH:MM / 上次抓取失败原因"）

    注意：本路由必须声明在 /news/{news_id} 之前，否则 "fetch-status" 会被当成 news_id。
    """
    get_current_user(request)
    return await run_in_threadpool(
        lambda: {"last_fetch": NewsService._fetch_health_summary(),
                 "cache_fresh": NewsService._is_cache_fresh(),
                 "stored_total": NewsService._stored_article_count()}
    )


@router.get("/news/diagnose")
async def diagnose_news_feeds(request: Request):
    """NW17: 新闻源体检（教师/管理员）—— 主动发现死源，不用等学生打开空白页

    注意：必须声明在 /news/{news_id} 之前，否则 "diagnose" 会被当成 news_id。
    """
    user = get_current_user(request)
    if user.get("role") == 2:
        raise HTTPException(403, "仅教师/管理员可执行新闻源体检")
    return await run_in_threadpool(NewsService.diagnose_feeds)


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
    # NW3: 简报每天首次访问会同步调 AI, 必须放线程池, 否则整站卡住几十秒
    return await run_in_threadpool(NewsService.get_daily_briefing, user["username"])


@router.get("/news/stats")
async def get_news_stats(request: Request):
    """获取个人新闻统计"""
    user = get_current_user(request)
    return NewsService.get_stats(user["username"])


# NW4: /news/{news_id} 是通配段, 必须放在 /news/stats 等字面路径之后,
#      否则 "stats" 会被当成 news_id -> 恒 422(旧实现即如此)
@router.get("/news/{news_id}")
async def get_news_detail(news_id: int, request: Request):
    """获取新闻详情（触发AI摘要和积分，仅学生计分）"""
    user = get_current_user(request)
    role = user.get("role", 2)
    try:
        return await run_in_threadpool(
            NewsService.get_article_detail, news_id, user["username"], role
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"获取新闻详情异常 id={news_id}: {e}")
        raise HTTPException(500, "获取新闻详情失败")
