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

/** 获取今日简报 */
export async function getDailyBriefing(): Promise<NewsBriefing> {
  const { data } = await apiClient.get('/api/news/briefing/today');
  return data;
}

/** 获取个人统计 */
export async function getStats(): Promise<NewsStats> {
  const { data } = await apiClient.get('/api/news/stats');
  return data;
}
