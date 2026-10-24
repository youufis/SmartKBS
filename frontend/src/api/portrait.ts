/** AI 画像 API（原「每周画像 / 自我画像」，2026-10 统一命名） */
import apiClient from './client';

export interface PortraitData {
  id: number;
  username: string;
  created_date: string;
  style: string;
  image_path: string;
  image_url: string;
  ai_comment: string;
  prompt: string;
  generated_at: string;
  view_count: number;
  is_shared: number;
  share_scope: string;
  like_count: number;
  liked?: boolean;
  deleted?: boolean;
  status?: string;
  /** P-6：这张画像覆盖的周期（旧数据为空 → 按"历史"展示） */
  period_type?: string;
  period_start?: string;
  period_end?: string;
  /** 补充信息 */
  student_name?: string;
  grade?: string;
  class_name?: string;
  /** 创作者的主题偏好（分享后其他人可见） */
  portrait_theme?: string;
}

export interface PortraitStyle {
  key: string;
  name: string;
  desc: string;
}

/** 周期信息（后端按系统配置给出：每周 / 每月） */
export interface PeriodInfo {
  type: 'weekly' | 'monthly' | string;
  start: string;
  end: string;
  label: string;
}

/** 生成改为后台任务（P-5）：先拿 task_id，再轮询 */
export interface GenerateResponse {
  message: string;
  task_id: string;
  charged_points: number;
  used: number;
  period: PeriodInfo;
}

/** 任务体返回（轮询拿到） */
export interface GenerateTaskResult {
  portrait: PortraitData;
  message: string;
  charged_points: number;
}

export interface TodayResponse {
  exists: boolean;
  portrait?: PortraitData;
  period?: PeriodInfo;
  /** 本期已生成后，再要一次需要花多少积分（系统配置可调，别在前端写死） */
  cost?: { extra_points: number; extra_max: number };
}

/** 画像生成健康度（管理员） */
export interface PortraitHealth {
  days: number;
  total: number;
  success: number;
  success_rate: number | null;
  image_ok: number;
  avg_seconds: number;
  top_errors: { error: string; count: number }[];
}

export interface PortraitListResponse {
  portraits: PortraitData[];
}

export interface GalleryResponse {
  portraits: PortraitData[];
}

export interface LikeResponse {
  action: 'liked' | 'unliked';
  count: number;
}

export interface StylesResponse {
  styles: PortraitStyle[];
}

/** 获取今日画像 */
export async function getTodayPortrait(): Promise<TodayResponse> {
  const { data } = await apiClient.get('/api/portrait/today');
  return data;
}

/** 获取所有可用风格 */
export async function getPortraitStyles(): Promise<StylesResponse> {
  const { data } = await apiClient.get('/api/portrait/styles');
  return data;
}

/**
 * 生成本期画像：后端已改为后台任务，这里只等"任务创建"（很快），
 * 真正的出图进度由 pollAiTask 轮询（见 stores/portraitStore）。
 */
export async function generatePortrait(style: string = 'random', usePoints: boolean = false): Promise<GenerateResponse> {
  const { data } = await apiClient.post('/api/portrait/generate', { style, use_points: usePoints }, { timeout: 30000 });
  return data;
}

/** 只补配图：不占周期额度、不扣积分 */
export async function retryPortraitImage(id: number): Promise<{ message: string; image_ok: boolean }> {
  const { data } = await apiClient.post(`/api/portrait/${id}/retry-image`, {}, { timeout: 300000 });
  return data;
}

/** 画像生成健康度（管理员） */
export async function getPortraitHealth(days = 7): Promise<PortraitHealth> {
  const { data } = await apiClient.get(`/api/portrait/health`, { params: { days } });
  return data;
}

/** 获取历史画像列表 */
export async function listPortraits(): Promise<PortraitListResponse> {
  const { data } = await apiClient.get('/api/portrait/list');
  return data;
}

/** 获取画像详情 */
export async function getPortraitDetail(id: number): Promise<PortraitData> {
  const { data } = await apiClient.get(`/api/portrait/${id}`);
  return data;
}

/** 分享画像 */
export async function sharePortrait(id: number, scope: string = 'public'): Promise<{ message: string }> {
  const { data } = await apiClient.post(`/api/portrait/${id}/share`, { scope });
  return data;
}

/** 取消分享 */
export async function unsharePortrait(id: number): Promise<{ message: string }> {
  const { data } = await apiClient.post(`/api/portrait/${id}/unshare`);
  return data;
}

/** 获取当前用户的主题偏好 */
export async function getPortraitTheme(): Promise<string> {
  const { data } = await apiClient.get('/api/portrait/theme');
  return data.theme;
}

/** 保存当前用户的主题偏好 */
export async function setPortraitTheme(theme: string): Promise<void> {
  await apiClient.put('/api/portrait/theme', { theme });
}

/** 点赞/取消点赞 */
export async function toggleLike(id: number): Promise<LikeResponse> {
  const { data } = await apiClient.post(`/api/portrait/${id}/like`);
  return data;
}

/** 获取公开画廊 */
export async function getPublicGallery(): Promise<GalleryResponse> {
  const { data } = await apiClient.get('/api/portrait/gallery/public');
  return data;
}

/** 获取班级画廊 */
export async function getClassGallery(): Promise<GalleryResponse> {
  const { data } = await apiClient.get('/api/portrait/gallery/class');
  return data;
}

/** 获取热门画廊 */
export async function getHotGallery(): Promise<GalleryResponse> {
  const { data } = await apiClient.get('/api/portrait/gallery/hot');
  return data;
}

/** 删除画像 */
export async function deletePortrait(id: number): Promise<{ message: string }> {
  const { data } = await apiClient.delete(`/api/portrait/${id}`);
  return data;
}
