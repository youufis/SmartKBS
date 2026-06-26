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
  files: string[];
}

export async function listGroups(): Promise<{ groups: ResourceGroup[] }> {
  const { data } = await apiClient.get('/api/resources/groups');
  return data;
}

export async function createGroup(group_name: string): Promise<{ message: string; id: number }> {
  const { data } = await apiClient.post('/api/resources/groups', { group_name });
  return data;
}

export async function renameGroup(group_id: number, group_name: string): Promise<{ message: string }> {
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
  type: 'animation' | 'quiz' | 'practice' | 'custom';
  topic: string;
  subject?: string;
  grade?: string;
  custom_prompt?: string;
  theme?: string;  // 主题 ID
}

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

export interface AiSaveResult {
  message: string;
  file_name: string;
  file_path: string;
  url_path: string;
}

export async function aiSaveHtml(html_content: string, filename: string): Promise<AiSaveResult> {
  const { data } = await apiClient.post('/api/resources/ai-save', { html_content, filename });
  return data;
}
