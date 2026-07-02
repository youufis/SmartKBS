/** 自我画像 API */
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

export interface GenerateResponse {
  message: string;
  portrait: PortraitData;
}

export interface TodayResponse {
  exists: boolean;
  portrait?: PortraitData;
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

/** 生成今日画像（超时 300 秒，因需调用 LLM + 通义万相） */
export async function generatePortrait(style: string = 'random', usePoints: boolean = false): Promise<GenerateResponse> {
  const { data } = await apiClient.post('/api/portrait/generate', { style, use_points: usePoints }, { timeout: 300000 });
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
