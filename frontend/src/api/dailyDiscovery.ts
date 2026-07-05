/** 每日精选 API */
import apiClient from './client';

export interface DiscoveryCard {
  id: number;
  emoji: string;
  category: string;
  title: string;
  summary: string;
  detail: string;
  source: string;
  fun_level: number;
  related_subject: string;
  tags: string[];
  is_favorited: boolean;
}

export interface DiscoveryResponse {
  date: string;
  cards: DiscoveryCard[];
  pool_size: number;
  refresh_remaining: number;
  today_view_count: number;
  today_points_earned: number;
  today_points_max: number;
}

export interface DiscoveryStats {
  view_count: number;
  refresh_count: number;
  points_earned: number;
  points_max: number;
  refresh_limit: number;
}

/** 获取精选 Feed */
export async function getFeed(): Promise<DiscoveryResponse> {
  const { data } = await apiClient.get('/api/discovery/feed');
  return data;
}

/** 手动刷新 */
export async function refreshFeed(): Promise<DiscoveryResponse> {
  const { data } = await apiClient.post('/api/discovery/refresh');
  return data;
}

/** 收藏/取消收藏 */
export async function toggleFavorite(cardId: number, action: 'favorite' | 'unfavorite'): Promise<void> {
  await apiClient.post('/api/discovery/favorite', { card_id: cardId, action });
}

/** 获取收藏列表 */
export async function getFavorites(): Promise<{ cards: DiscoveryCard[] }> {
  const { data } = await apiClient.get('/api/discovery/favorites');
  return data;
}

/** 获取今日统计 */
export async function getStats(): Promise<DiscoveryStats> {
  const { data } = await apiClient.get('/api/discovery/stats');
  return data;
}

/** 记录浏览 */
export async function recordView(cardId: number): Promise<{ points_awarded: number }> {
  const { data } = await apiClient.post('/api/discovery/view', { card_id: cardId });
  return data;
}
