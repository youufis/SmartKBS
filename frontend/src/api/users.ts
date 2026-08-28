/** 用户管理 API */
import apiClient from './client';
import type { UserItem } from '../types';

/** 从后端错误响应中取出可读错误信息（detail 可能是字符串，也可能是结构化对象） */
export function extractApiErrorDetail(errData: unknown): string {
  const detail = (errData as { detail?: unknown } | undefined)?.detail;
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object') {
    const d = detail as { message?: string; error?: string };
    return d.message || d.error || '';
  }
  return '';
}

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

/** 批量删除的用户名匹配模式：前缀 / 包含 / 精确 */
export type BulkMatchMode = 'prefix' | 'contains' | 'exact';

/** 批量删除预览结果（后端 /bulk-delete/preview 返回，不会删除任何数据） */
export interface BulkDeletePreview {
  pattern: string;
  match_mode: BulkMatchMode;
  match_mode_label?: string;
  matched_count: number;
  preview: string[];
  skipped_admin_count: number;
  message: string;
}

/** 预览批量删除将命中的用户，用于删除前的二次确认 */
export async function previewBulkDelete(
  pattern: string,
  matchMode: BulkMatchMode = 'prefix',
): Promise<BulkDeletePreview> {
  const { data } = await apiClient.post('/api/users/bulk-delete/preview', {
    pattern,
    match_mode: matchMode,
  });
  return data;
}

/**
 * 批量删除（非流式）。
 * 后端要求 confirm=true 才会真正删除；confirm=false 只返回匹配预览并报 400。
 */
export async function bulkDeleteUsers(
  pattern: string,
  matchMode: BulkMatchMode = 'prefix',
  confirm = true,
): Promise<string> {
  const { data } = await apiClient.post('/api/users/bulk-delete', {
    pattern,
    match_mode: matchMode,
    confirm,
  });
  return data.message;
}

/** 流式批量删除用户（支持进度回调） */
export interface BulkDeleteProgressEvent {
  type: 'start' | 'progress' | 'done';
  pattern?: string;
  match_mode?: BulkMatchMode;
  skipped_admin_count?: number;
  total?: number;
  current?: number;
  deleted?: number;
  error_count?: number;
  percent?: number;
  errors?: string[];
  message?: string;
}

export async function bulkDeleteUsersStream(
  pattern: string,
  onProgress: (event: BulkDeleteProgressEvent) => void,
  matchMode: BulkMatchMode = 'prefix',
  confirm = true,
): Promise<BulkDeleteProgressEvent> {
  const token = localStorage.getItem('smartkb_token');

  const response = await fetch('/api/users/bulk-delete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
    // confirm 必须为 true：否则后端只会回“请确认”的 400，不会真的删除任何用户
    body: JSON.stringify({ pattern, match_mode: matchMode, confirm }),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(extractApiErrorDetail(errData) || `批量删除失败 (${response.status})`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const readStream = async (): Promise<BulkDeleteProgressEvent> => {
    let lastEvent: BulkDeleteProgressEvent = { type: 'done' };

    const processBuffer = () => {
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(trimmed.slice(6)) as BulkDeleteProgressEvent;
          lastEvent = event;
          onProgress(event);
        } catch { /* skip malformed */ }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      processBuffer();
    }
    // 处理剩余 buffer
    processBuffer();

    return lastEvent;
  };

  return readStream();
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

/** 导出用户为 CSV 文件 */
export async function exportUsersCsv(keyword?: string): Promise<void> {
  const params = keyword ? `?keyword=${encodeURIComponent(keyword)}` : '';
  // 先用默认 responseType 请求，成功再转 blob 下载
  const response = await apiClient.get(`/api/users/export${params}`, {
    responseType: 'arraybuffer',
  });
  const disp = response.headers['content-disposition'] || '';
  const match = disp.match(/filename\*?=(?:UTF-8'')?([^;\s]+)/i);
  const filename = match ? decodeURIComponent(match[1]) : 'users_export.csv';
  const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8-sig' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

// ── 批量升年级 ──

export interface GradePromotionPreview {
  promotion_map: Record<string, string | null>;
  grade_details: Array<{
    grade: string;
    grade_id: number;
    count: number;
    classes: string[];
    next_grade: string | null;
    next_grade_id: number | null;
  }>;
  total_students: number;
}

export interface GradePromotionResult {
  success: boolean;
  direction: 'up' | 'down';
  promoted: Record<string, number>;
  not_moved: Record<string, number>;
  updated_users: number;
  updated_scores: number;
  updated_rollcall: number;
  errors: string[];
  skipped?: string[];
}

/** 预览升年级影响范围 */
export async function previewPromoteGrades(): Promise<GradePromotionPreview> {
  const { data } = await apiClient.get('/api/users/promote-grades/preview');
  return data;
}

/** 执行批量升年级 */
export async function executePromoteGrades(params: {
  sync_scores?: boolean;
  sync_rollcall?: boolean;
  match_class?: boolean;
  confirm: boolean;
}): Promise<GradePromotionResult> {
  const { data } = await apiClient.post('/api/users/promote-grades', params);
  return data;
}

/** 反向降级（升年级的逆操作） */
export async function reversePromoteGrades(params: {
  sync_scores?: boolean;
  sync_rollcall?: boolean;
  match_class?: boolean;
  confirm: boolean;
}): Promise<GradePromotionResult> {
  const { data } = await apiClient.post('/api/users/promote-grades/reverse', params);
  return data;
}
