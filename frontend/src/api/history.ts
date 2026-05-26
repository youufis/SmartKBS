/** 历史记录 API */
import apiClient from './client';
import type { TreeNode } from '../types';

export async function getHistoryTree(): Promise<{ tree: TreeNode[]; root: string }> {
  const { data } = await apiClient.get('/api/history/tree');
  return data;
}

export async function readHistoryFile(path: string): Promise<{
  content: string;
  filename: string;
  has_html: boolean;
  html_blocks: string[];
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
