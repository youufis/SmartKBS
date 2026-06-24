/** 学伴 API */
import apiClient from './client';

export interface CompanionConfig {
  username: string;
  enabled: boolean;
  personality: string;
  personality_label: string;
  companion_name: string;
  avatar_style: string;
  wakeup_time: string;
  student_name?: string;
  personality_list?: { key: string; label: string; desc: string }[];
  unread_push_count?: number;
  created_at: string;
  updated_at: string;
}

export interface CompanionProfile {
  profile: {
    username: string;
    name: string;
    grade: string;
    class: string;
    weakness: { kp: string; wrong_count: number; level: string }[];
    strength: { kp: string; correct_rate: number; level: string }[];
    titles: Record<string, string>;
    total_points: number;
    recent_exams: { avg: number; trend: string; count: number };
    streak_days: number;
    milestones: string[];
    recommendation: string;
  };
  config: CompanionConfig;
}

export interface PushMessage {
  id: number;
  push_type: string;
  push_type_label: string;
  title: string;
  content: string;
  created_at: string;
  is_read?: boolean;
}

export interface PushListResponse {
  pushes: PushMessage[];
  total: number;
  page: number;
  page_size: number;
}

/** 获取学伴配置 */
export async function getConfig(): Promise<CompanionConfig> {
  const { data } = await apiClient.get('/api/companion/config');
  return data;
}

/** 更新学伴配置 */
export async function updateConfig(cfg: Partial<CompanionConfig>): Promise<{ success: boolean; config: CompanionConfig }> {
  const { data } = await apiClient.put('/api/companion/config', cfg);
  return data;
}

/** 获取学伴画像 */
export async function getProfile(studentUsername?: string): Promise<CompanionProfile> {
  const params = studentUsername ? { student_username: studentUsername } : {};
  const { data } = await apiClient.get('/api/companion/profile', { params });
  return data;
}

/** 刷新画像 */
export async function refreshProfile(): Promise<{ success: boolean; message: string; profile: any }> {
  const { data } = await apiClient.post('/api/companion/refresh');
  return data;
}

/** 获取推送消息 */
export async function getPushes(): Promise<{ pushes: PushMessage[]; total: number }> {
  const { data } = await apiClient.get('/api/companion/push');
  return data;
}

/** 标记推送已读 */
export async function markPushRead(pushId: number): Promise<{ success: boolean }> {
  const { data } = await apiClient.put(`/api/companion/push/${pushId}/read`);
  return data;
}

/** 标记所有推送已读 */
export async function markAllPushesRead(): Promise<{ success: boolean }> {
  const { data } = await apiClient.put('/api/companion/push/read-all');
  return data;
}

/** 获取未读推送数量 */
export async function getUnreadPushCount(): Promise<{ count: number }> {
  const { data } = await apiClient.get('/api/companion/push/unread-count');
  return data;
}

/** 检查早安推送 */
export async function checkMorningPush(): Promise<{ success: boolean }> {
  const { data } = await apiClient.post('/api/companion/push/check-morning');
  return data;
}

/** 获取推送消息列表（分页） */
export async function getPushList(page = 1, pageSize = 20, unreadOnly = false): Promise<PushListResponse> {
  const { data } = await apiClient.get('/api/companion/push/list', {
    params: { page, page_size: pageSize, unread_only: unreadOnly },
  });
  return data;
}

/** 删除推送消息 */
export async function deletePush(pushId: number): Promise<{ success: boolean }> {
  const { data } = await apiClient.delete(`/api/companion/push/${pushId}`);
  return data;
}

/**
 * 学伴 SSE 流式对话
 */
export async function companionChat(
  prompt: string,
  onDelta: (text: string) => void,
  onDone: (sessionId: string) => void,
  onError: (error: string) => void,
  signal?: AbortSignal,
  file_paths?: string[],
  context_enhance?: boolean,
): Promise<void> {
  const token = localStorage.getItem('smartkb_token');

  try {
    const response = await fetch('/api/companion/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ prompt, session_id: null, file_paths, context_enhance }),
      signal,
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      onError(errData.detail || `HTTP ${response.status}`);
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      onError('无法读取响应流');
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let sessionId = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          switch (data.type) {
            case 'delta':
              onDelta(data.content);
              break;
            case 'done':
              sessionId = data.session_id || '';
              break;
            case 'error':
              onError(data.content);
              return;
          }
        } catch { /* skip parse errors */ }
      }
    }

    onDone(sessionId);
  } catch (err: any) {
    if (err.name === 'AbortError') return;
    onError(err.message || '网络错误');
  }
}
