/** 对话 API（SSE 流式） */
import apiClient from './client';

export interface UsageInfo {
  enabled: boolean;
  used: number;
  max: number;
  remaining: number;
  multimodal_enabled?: boolean;
  model_name?: string;
}

/** 获取当前用户的每日用量 */
export async function getUsage(): Promise<UsageInfo> {
  const { data } = await apiClient.get('/api/chat/usage');
  return data;
}

/** API Key 配置状态 */
export interface ApiKeyStatus {
  status: 'env' | 'config' | 'missing';
  source: string;
  hint: string;
  configured: boolean;
}

/** 检查 API Key 是否已配置 */
export async function checkApiKeyStatus(): Promise<ApiKeyStatus> {
  const { data } = await apiClient.get('/api/config/apikey-status');
  return data;
}

/** 获取多模态模型启用状态 */
export async function getMultimodalStatus(): Promise<{ multimodal_enabled: boolean }> {
  const { data } = await apiClient.get('/api/config/multimodal-status');
  return data;
}

export interface ChatParams {
  prompt: string;
  file_paths?: string[];
  session_id?: string | null;
  context_enhance?: boolean;
}

/**
 * SSE 流式对话
 * 使用 fetch 原生 API，因为 axios 对流式支持不够好
 */
export async function chatStream(
  params: ChatParams,
  onDelta: (text: string) => void,
  onDone: (sessionId: string) => void,
  onError: (error: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const token = localStorage.getItem('smartkb_token');

  try {
    const response = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(params),
      signal,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: '请求失败' }));
      onError(err.detail || '请求失败');
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      onError('无法读取响应流');
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留未完成的行

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            switch (data.type) {
              case 'delta':
                onDelta(data.content || '');
                break;
              case 'done':
                onDone(data.session_id || '');
                break;
              case 'error':
                onError(data.content || '未知错误');
                break;
            }
          } catch {
            // 忽略解析错误
          }
        }
      }
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      onDone('');
    } else {
      onError(err.message || '网络连接错误');
    }
  }
}

export async function newTopic(): Promise<void> {
  await apiClient.post('/api/chat/new-topic');
}
