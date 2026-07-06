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
}

export interface ShowcaseListResponse {
  cards: ShowcaseCard[];
  total: number;
  page: number;
  page_size: number;
}

export interface GenerateRequest {
  count: number;
  grade?: string;
  class_name?: string;
  student_name?: string;
}

export interface GenerateResponse {
  message: string;
  generated_count: number;
  updated_count: number;
  batch_id: string;
  total: number;
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
  sort_by?: string;
  page?: number;
  page_size?: number;
}): Promise<ShowcaseListResponse> {
  const { data } = await apiClient.get('/api/showcase/list', { params });
  return data;
}

/** 获取单张展示卡详情 */
export async function getShowcaseDetail(id: number): Promise<ShowcaseCard> {
  const { data } = await apiClient.get(`/api/showcase/${id}`);
  return data;
}

/** 生成展示卡（教师） */
export async function generateShowcase(body: GenerateRequest): Promise<GenerateResponse> {
  const { data } = await apiClient.post('/api/showcase/generate', body);
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
