/** 用户管理 API */
import apiClient from './client';
import type { UserItem } from '../types';

export interface RegisterParams {
  username: string;
  password: string;
  class_val?: string;
  name?: string;
  gender?: number;
  role?: number;
  grade?: string;
  subjects?: string[];
}

export async function registerUser(params: RegisterParams): Promise<string> {
  const { data } = await apiClient.post('/api/users/register', params);
  return data.message;
}

export async function updateUserInfo(username: string, class_val?: string, name?: string, gender?: number, grade?: string, subjects?: string[]): Promise<string> {
  const { data } = await apiClient.put('/api/users/update', { username, class_val, name, gender, grade, subjects });
  return data.message;
}

export async function changePassword(username: string, new_password: string): Promise<string> {
  const { data } = await apiClient.put('/api/users/password', { username, new_password });
  return data.message;
}

export async function deleteUser(username: string): Promise<string> {
  const { data } = await apiClient.delete(`/api/users/${encodeURIComponent(username)}`);
  return data.message;
}

export async function getUserInfo(username: string): Promise<any> {
  const { data } = await apiClient.get(`/api/users/${encodeURIComponent(username)}`);
  return data;
}

export async function getAllUsers(keyword?: string): Promise<{ users: UserItem[]; total: number }> {
  const params = keyword ? { keyword } : {};
  const { data } = await apiClient.get('/api/users', { params });
  return data;
}

export async function bulkDeleteUsers(pattern: string): Promise<string> {
  const { data } = await apiClient.post('/api/users/bulk-delete', { pattern });
  return data.message;
}

export async function importUsers(file: File): Promise<{ message: string; imported: number; errors: string[] }> {
  const formData = new FormData();
  formData.append('file', file);
  // 不手动设置 Content-Type，让 axios 自动添加 multipart boundary
  const { data } = await apiClient.post('/api/users/import', formData);
  return data;
}

/** 流式导入用户（支持进度回调） */
export interface ImportProgressEvent {
  type: 'start' | 'progress' | 'done';
  total?: number;
  current?: number;
  imported?: number;
  error_count?: number;
  percent?: number;
  errors?: string[];
  message?: string;
}

export async function importUsersStream(
  file: File,
  onProgress: (event: ImportProgressEvent) => void,
): Promise<ImportProgressEvent> {
  const token = localStorage.getItem('smartkb_token');
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch('/api/users/import', {
    method: 'POST',
    headers: token ? { 'Authorization': `Bearer ${token}` } : {},
    body: formData,
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.detail || `导入失败 (${response.status})`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const readStream = async (): Promise<ImportProgressEvent> => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6)) as ImportProgressEvent;
            onProgress(data);
            if (data.type === 'done') {
              return data;
            }
          } catch { /* ignore parse errors */ }
        }
      }
    }
    throw new Error('导入中断：连接已关闭');
  };

  return readStream();
}
