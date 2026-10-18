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

export interface DiscoveryAdminCard extends DiscoveryCard {
  grade_level: string;
  pool_status: 'active' | 'disabled' | string;
  view_count: number;
  favorite_count: number;
  created_at: string;
  updated_at: string;
  updated_by: string;
}

export interface DiscoveryAdminList {
  cards: DiscoveryAdminCard[];
  total: number;
  page: number;
  page_size: number;
}

/** 获取精选 Feed */
export async function getFeed(): Promise<DiscoveryResponse> {
  const { data } = await apiClient.get('/api/discovery/feed');
  return data;
}

/** 手动刷新 */
export async function refreshFeed(): Promise<DiscoveryResponse> {
  const { data } = await apiClient.post('/api/discovery/refresh', null, { timeout: 180000 });
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

/** 管理员/教师：知识池管理列表 */
export async function getAdminCards(params: {
  keyword?: string;
  category?: string;
  grade_level?: string;
  status?: string;
  page?: number;
  page_size?: number;
}): Promise<DiscoveryAdminList> {
  const { data } = await apiClient.get('/api/discovery/admin/cards', { params });
  return data;
}

/** 管理员/教师：编辑知识池卡片 */
export async function updateAdminCard(cardId: number, payload: Record<string, unknown>): Promise<{ card: DiscoveryAdminCard }> {
  const { data } = await apiClient.patch(`/api/discovery/admin/cards/${cardId}`, payload);
  return data;
}

/** 管理员/教师：批量下架/恢复；彻底删除仅管理员 */
export async function bulkAdminCards(ids: number[], action: 'disable' | 'enable' | 'delete'): Promise<{ success: boolean; affected: number }> {
  const { data } = await apiClient.post('/api/discovery/admin/cards/bulk', { ids, action });
  return data;
}

export interface DiscoveryAdminHealth {
  total_active: number;
  total_disabled: number;
  categories: Record<string, number>;
  grades: Record<string, number>;
  last_refill_at: string;
  refill_min_interval_seconds: number;
  refill_threshold: number;
  daily_card_count: number;
}

export async function getAdminHealth(): Promise<DiscoveryAdminHealth> {
  const { data } = await apiClient.get('/api/discovery/admin/health');
  return data;
}
