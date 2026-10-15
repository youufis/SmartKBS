/** 学子风采·荣誉展示墙 API */
import apiClient from './client';

export interface MainTitle {
  level: number;
  name: string;
  emoji: string;
  color: string;
  desc: string;
  min_points?: number;
}

export interface TitleProgress {
  current: MainTitle;
  next: MainTitle | null;
  progress_percent: number;
  points_needed: number;
}

export interface SubjectTitle {
  subject: string;
  question_count: number;
  level: number;
  name: string;
  emoji: string;
  color: string;
}

export interface BadgeItem {
  badge_id: string;
  name: string;
  icon: string;
  desc: string;
  unlocked: boolean;
  unlocked_at?: string;
}

export interface SnapshotData {
  total_points: number;
  main_title: MainTitle;
  progress: TitleProgress;
  subject_titles: SubjectTitle[];
  badges: BadgeItem[];
  unlocked_badge_count: number;
  total_badge_count: number;
  theme_style: string;
  student_info: {
    name: string;
    grade: string;
    class: string;
  };
}

export interface ShowcaseCard {
  id: number;
  student_username: string;
  student_name: string;
  grade: string;
  class_name: string;
  snapshot_data: SnapshotData;
  theme_style: string;
  like_count: number;
  view_count: number;
  liked: boolean;
  is_active: boolean;
  sort_order: number;
  batch_id: string;
  generated_at: string;
  updated_at: string;
  /** 建卡那一刻定格的积分(points_mode=snapshot 时不下发这两个字段) */
  snapshot_points?: number;
  /** student_total_points 里的实时总积分, 默认口径下卡片显示的就是它 */
  live_points?: number;
  /** S2: 近 7 天新增积分（本周进步榜用） */
  week_gain?: number;
  /** S2: 名次（本班/全校；同分同名次）与对应范围总人数 */
  class_rank?: number | null;
  class_total?: number | null;
  school_rank?: number | null;
  school_total?: number | null;
  /** S2: 服务端按"名次展示策略"算好的开关 —— 低分保护只在这一处决定 */
  rank_show?: boolean;
}

export interface ShowcaseListResponse {
  cards: ShowcaseCard[];
  total: number;
  page: number;
  page_size: number;
  /** 后端「刷新」最小间隔（秒），前端据此对齐按钮冷却 */
  refresh_interval?: number;
}

export interface LikeResponse {
  action: 'liked' | 'unliked';
  count: number;
}

/** 获取展示卡列表 */
export async function getShowcaseList(params: {
  grade?: string;
  class_name?: string;
  student_name?: string;
  /** points=按积分 / progress=按本周进步 / likes=点赞 / newest=最新 */
  sort_by?: string;
  page?: number;
  page_size?: number;
  /** live=积分按实时汇总显示与排序(默认), snapshot=按建卡时的定格快照 */
  points_mode?: 'live' | 'snapshot';
  /** true=点「刷新」按钮触发的强制刷新，受后端每用户最小间隔限流 */
  manual?: boolean;
  /** true=连已下架的卡片一起返回（仅教师/管理员，用于重新上架） */
  include_inactive?: boolean;
}): Promise<ShowcaseListResponse> {
  const { data } = await apiClient.get('/api/showcase/list', { params });
  return data;
}

/** 获取单张展示卡详情 */
export async function getShowcaseDetail(id: number): Promise<ShowcaseCard> {
  const { data } = await apiClient.get(`/api/showcase/${id}`);
  return data;
}

/** 点赞/取消点赞 */
export async function toggleLike(id: number): Promise<LikeResponse> {
  const { data } = await apiClient.post(`/api/showcase/${id}/like`);
  return data;
}

/** 下架展示卡（教师） */
export async function deactivateShowcase(id: number): Promise<void> {
  await apiClient.delete(`/api/showcase/${id}`);
}

/** 重新上架展示卡（教师） */
export async function activateShowcase(id: number): Promise<void> {
  await apiClient.post(`/api/showcase/${id}/activate`);
}

/** 批量调整排序（教师） */
export async function reorderShowcase(ids: number[]): Promise<void> {
  await apiClient.put('/api/showcase/reorder', { ids });
}

/* ── 主题 ── */

export interface ThemeItem {
  key: string;
  name: string;
  color: string;
  desc: string;
}

export interface ThemesResponse {
  themes: ThemeItem[];
}

/** 获取所有预设主题 */
export async function getThemes(): Promise<ThemesResponse> {
  const { data } = await apiClient.get('/api/showcase/themes');
  return data;
}

/** 更新展示卡主题 */
export async function updateShowcaseTheme(id: number, theme: string): Promise<void> {
  await apiClient.put(`/api/showcase/${id}/theme`, { theme });
}
