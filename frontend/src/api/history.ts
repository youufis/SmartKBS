/** 历史记录 API */
import apiClient from './client';
import type { TreeNode } from '../types';

export async function getHistoryTree(): Promise<{ tree: TreeNode[]; root: string }> {
  const { data } = await apiClient.get('/api/history/tree');
  return data;
}

export interface HistorySearchHit {
  key: string;
  filename: string;
  title: string;
  date: string;
  created_at: string;
  size: number;
  message_count: number;
  snippet: string;
}

/** 正文检索（标题/文件名过滤在前端即时做，这里只补正文命中） */
export async function searchHistory(q: string, limit = 30): Promise<HistorySearchHit[]> {
  const { data } = await apiClient.get('/api/history/search', { params: { q, limit } });
  return (data.results || []) as HistorySearchHit[];
}

export interface HistoryPreview {
  title: string;
  filename: string;
  preview: string;
  message_count: number;
  size: number;
  created_at: string;
}

/** 预览开头一段（悬浮或弹窗用），不替换当前对话 */
export async function previewHistory(path: string, chars = 400): Promise<HistoryPreview> {
  const { data } = await apiClient.get('/api/history/preview', { params: { path, chars } });
  return data as HistoryPreview;
}

/** 改列表显示标题（只动索引 title，不改磁盘文件名） */
export async function renameHistoryTitle(path: string, title: string): Promise<string> {
  const { data } = await apiClient.put('/api/history/title', { path, title });
  return data.message;
}

export async function readHistoryFile(path: string): Promise<{
  content: string;
  filename: string;
  has_html: boolean;
  html_blocks: string[];
  /** 超过读取上限时只给前一段（大文件反复追加会撑到几十 MB） */
  truncated?: boolean;
  total_size?: number;
}> {
  const { data } = await apiClient.get('/api/history/file', { params: { path } });
  return data;
}

export async function deleteHistoryFile(path: string): Promise<string> {
  const { data } = await apiClient.delete('/api/history/file', { params: { path } });
  return data.message;
}

export async function saveConversation(content: string, session_id?: string, filename?: string): Promise<string> {
  const { data } = await apiClient.post('/api/history/save', { content, session_id, filename });
  return data.message;
}
