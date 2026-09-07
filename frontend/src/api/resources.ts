/** 资源中心 API */
import apiClient from './client';
import type { ResourceFile, TreeNode } from '../types';

export async function listResources(): Promise<{ files: ResourceFile[]; html_dir: string }> {
  const { data } = await apiClient.get('/api/resources/list');
  return data;
}

export async function getResourceTree(): Promise<{ tree: TreeNode[]; root: string }> {
  const { data } = await apiClient.get('/api/resources/tree');
  return data;
}

export async function uploadResource(files: FileList): Promise<{ message: string; uploaded: string[]; errors: string[] }> {
  const formData = new FormData();
  for (let i = 0; i < files.length; i++) {
    formData.append(`file${i}`, files[i]);
    formData.append(`path${i}`, '');
  }
  const { data } = await apiClient.post('/api/resources/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

export async function deleteResource(path: string): Promise<string> {
  const { data } = await apiClient.delete('/api/resources/file', { params: { path } });
  return data.message;
}

export async function renameResource(path: string, new_name: string): Promise<string> {
  const { data } = await apiClient.put('/api/resources/rename', { path, new_name });
  return data.message;
}

// ── 资源分组 API ──

export interface ResourceGroup {
  id: number;
  group_name: string;
  sort_order: number;
  /** 已统一路径格式并剔除失效引用后的资源列表（与 file_count 口径一致） */
  files: string[];
  /** 后端返回的资源个数 = files.length */
  file_count?: number;
}

export async function listGroups(): Promise<{ groups: ResourceGroup[] }> {
  const { data } = await apiClient.get('/api/resources/groups');
  return data;
}

export async function createGroup(group_name: string): Promise<{ message: string; id: number }> {
  const { data } = await apiClient.post('/api/resources/groups', { group_name });
  return data;
}

export async function renameGroup(group_id: number, group_name: string): Promise<{ message: string; group_name: string }> {
  const { data } = await apiClient.put(`/api/resources/groups/${group_id}`, { group_name });
  return data;
}

export async function deleteGroup(group_id: number): Promise<{ message: string }> {
  const { data } = await apiClient.delete(`/api/resources/groups/${group_id}`);
  return data;
}

export async function addToGroup(group_id: number, file_path: string): Promise<{ message: string }> {
  const { data } = await apiClient.post(`/api/resources/groups/${group_id}/items`, { file_path });
  return data;
}

export async function removeFromGroup(group_id: number, file_path: string): Promise<{ message: string }> {
  const { data } = await apiClient.delete(`/api/resources/groups/${group_id}/items`, { data: { file_path } });
  return data;
}

export async function reorderGroups(group_ids: number[]): Promise<{ message: string }> {
  const { data } = await apiClient.put('/api/resources/groups/reorder', { group_ids });
  return data;
}

// ── AI 生成 HTML 资源 ──

export interface AiTheme {
  id: string;
  name: string;
  icon: string;
  desc: string;
}

export interface AiPreviewParams {
  type: 'animation' | 'quiz' | 'practice' | 'custom' | 'interactive';
  topic: string;
  subject?: string;
  grade?: string;
  custom_prompt?: string;
  theme?: string;  // 主题 ID
  experiment_params?: Record<string, string>;  // 实验参数
  enable_media?: boolean;  // 是否启用自动配图增强
}

// 实验分类常量（覆盖全学科）
export const EXPERIMENT_CATEGORIES = [
  { value: 'algorithm', label: '🔬 算法与编程', desc: '排序搜索、数据结构、编程逻辑、编译原理等' },
  { value: 'math', label: '📐 数学', desc: '函数图像、几何证明、概率统计、微积分、线性代数等' },
  { value: 'physics', label: '⚡ 物理', desc: '力学、电磁学、光学、热力学、波动、量子物理等' },
  { value: 'chemistry', label: '🧪 化学', desc: '分子结构、化学反应、元素周期表、滴定实验、有机化学等' },
  { value: 'biology', label: '🧬 生物', desc: '细胞结构、遗传学、生态系统、人体解剖、进化论等' },
  { value: 'geography', label: '🌍 地理与天文', desc: '地图投影、气候模拟、地质构造、天文仿真、板块运动等' },
  { value: 'humanities', label: '🏛️ 人文与社会', desc: '历史年表、经济模型、语言语法、艺术配色、社会统计等' },
  { value: 'ai', label: '🤖 人工智能', desc: '神经网络可视化、CNN 卷积过程、图像分类、NLP 演示等' },
  { value: 'general', label: '🎯 通用交互', desc: '拖拽点击、数据图表联动、自定义仿真场景等' },
] as const;

export type ExperimentCategory = typeof EXPERIMENT_CATEGORIES[number]['value'];

export interface AiPreviewResult {
  html_content: string;
  suggested_name: string;
  type_label: string;
  db_saved?: number;  // AI 新题目入库数量
}

export async function getAiThemes(type: string): Promise<AiTheme[]> {
  const { data } = await apiClient.get('/api/resources/ai-themes', { params: { type } });
  return data.themes;
}

export async function aiPreviewHtml(params: AiPreviewParams): Promise<AiPreviewResult> {
  const { data } = await apiClient.post('/api/resources/ai-preview', params, {
    timeout: 300000,  // 5 分钟超时，AI 生成可能需要较长时间
  });
  return data;
}

// ── 异步生成（复杂资源） ──

export interface AsyncGenTask {
  task_id: string;
  message: string;
  poll_url: string;
}

export interface AsyncGenResult {
  task_id: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: {
    saved?: {
      is_subdir?: boolean;
      dir_name?: string;
      main_entry?: string;
      url_path?: string;
      file_count?: number;
      file_name?: string;
    };
    error?: string;
  };
  error?: string;
  created_at: number;
  completed_at?: number;
}

export async function aiGenerateAsync(params: AiPreviewParams): Promise<AsyncGenTask> {
  const { data } = await apiClient.post('/api/resources/ai-generate-async', params);
  return data;
}

export async function getAiTaskStatus(task_id: string): Promise<AsyncGenResult> {
  const { data } = await apiClient.get(`/api/resources/ai-task/${task_id}`);
  return data;
}

// ── 多文件保存 ──

export interface AiSaveMultiResult {
  message: string;
  is_subdir: boolean;
  dir_name?: string;
  main_entry?: string;
  url_path: string;
  file_count?: number;
  file_name?: string;
}

export async function aiSaveMultiHtml(
  ai_output: string,
  dir_name: string,
  html_content?: string,
): Promise<AiSaveMultiResult> {
  const { data } = await apiClient.post('/api/resources/ai-save-multi', {
    ai_output,
    dir_name,
    html_content,
  });
  return data;
}

export interface AiSaveResult {
  message: string;
  file_name: string;
  file_path: string;
  url_path: string;
  is_subdir?: boolean;
  dir_name?: string;
  main_entry?: string;
  file_count?: number;
}

export async function aiSaveHtml(html_content: string, filename: string): Promise<AiSaveResult> {
  const { data } = await apiClient.post('/api/resources/ai-save', { html_content, filename });
  return data;
}
