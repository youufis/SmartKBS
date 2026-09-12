/** 热点新闻 API */
import apiClient from './client';

export interface NewsArticle {
  id: number;
  title: string;
  url: string;
  source_name: string;
  summary: string;
  category: string;
  image_url: string;
  published_at: string;
  fetched_at: string;
  is_viewed: boolean;
  is_favorited: boolean;
}

export interface NewsListResponse {
  articles: NewsArticle[];
  total: number;
  page: number;
  page_size: number;
  cache_fresh: boolean;
  /** NW11: 最近一次抓取的健康度（更新于时间 / 状态 / 逐源结果） */
  last_fetch?: NewsFetchHealth | null;
}

/** 单个新闻源的抓取健康度 */
export interface NewsSourceHealth {
  source: string;
  ok: boolean;
  http?: number;
  entries?: number;
  kept?: number;
  error?: string;
}

/** 最近一次抓取结果 */
export interface NewsFetchHealth {
  fetched_at: string;
  article_count: number;
  status: "" | "success" | "partial" | "empty" | "failed" | "busy" | string;
  detail?: {
    sources?: NewsSourceHealth[];
    took_ms?: number;
    inserted?: number;
    renewed?: number;
    stored_total?: number;
  };
}

/** POST /api/news/refresh 的返回 */
export interface NewsRefreshResult {
  status: "success" | "partial" | "empty" | "failed" | "busy" | string;
  batch_id?: string;
  fetched: number;
  inserted: number;
  renewed: number;
  stored_total?: number;
  took_ms?: number;
  sources?: NewsSourceHealth[];
  error?: string;
  categories?: string[];
  last_fetch?: NewsFetchHealth;
}

export interface NewsDetail {
  id: number;
  title: string;
  url: string;
  source_name: string;
  summary: string;
  ai_summary: string;
  ai_one_liner: string;
  category: string;
  image_url: string;
  related_subjects: string[];
  tags: string[];
  published_at: string;
  points_awarded: number;
}

export interface NewsBriefing {
  date: string;
  brief_content: string;
  article_count: number;
  generated_at: string;
  /** NW21: ready = 有内容；generating = 后台正在生成，前端应轮询而不是报"加载失败" */
  status?: 'ready' | 'generating' | string;
  estimated_seconds?: number;
  message?: string;
}

export interface NewsStats {
  today_views: number;
  today_points: number;
  view_count: number;
  points_earned: number;
  points_max: number;
  total_views: number;
  total_favorites: number;
}

/** 获取新闻列表 */
export async function getNewsList(category?: string, page = 1, pageSize = 20): Promise<NewsListResponse> {
  const params: Record<string, any> = { page, page_size: pageSize };
  if (category) params.category = category;
  const { data } = await apiClient.get('/api/news/list', { params });
  return data;
}

/** 获取新闻分类 */
export async function getCategories(): Promise<{ categories: string[] }> {
  const { data } = await apiClient.get('/api/news/categories');
  return data;
}

/** 获取新闻详情 */
export async function getNewsDetail(newsId: number): Promise<NewsDetail> {
  const { data } = await apiClient.get(`/api/news/${newsId}`);
  return data;
}

/** 收藏/取消收藏 */
export async function toggleFavorite(newsId: number, action: 'favorite' | 'unfavorite'): Promise<void> {
  await apiClient.post('/api/news/favorite', { news_id: newsId, action });
}

/** 获取收藏列表 */
export async function getFavorites(): Promise<{ articles: NewsArticle[] }> {
  const { data } = await apiClient.get('/api/news/favorites/list');
  return data;
}

/** 获取今日简报（冷启动后端只同步等 10s，其余走轮询，所以这里给 25s 足够） */
export async function getDailyBriefing(): Promise<NewsBriefing> {
  const { data } = await apiClient.get('/api/news/briefing/today', { timeout: 25000 });
  return data;
}

/** 获取个人统计 */
export async function getStats(): Promise<NewsStats> {
  const { data } = await apiClient.get('/api/news/stats');
  return data;
}

/** NW11: 强制抓取一次热点新闻（后端同步抓完再返回真实结果） */
export async function refreshNews(): Promise<NewsRefreshResult> {
  const { data } = await apiClient.post('/api/news/refresh');
  return data;
}

/** NW11: 抓取健康度（"更新于 / 上次失败原因"） */
export async function getFetchStatus(): Promise<{
  last_fetch: NewsFetchHealth;
  cache_fresh: boolean;
  stored_total: number;
}> {
  const { data } = await apiClient.get('/api/news/fetch-status');
  return data;
}

/** 从 axios 错误里取后端 detail（429 刷新过频等场景） */
export function apiErrorDetail(e: unknown): string {
  const err = e as { response?: { data?: { detail?: unknown } } };
  const detail = err?.response?.data?.detail;
  return typeof detail === 'string' ? detail : '';
}
