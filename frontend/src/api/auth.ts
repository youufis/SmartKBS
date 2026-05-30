/** 认证 API */
import apiClient from './client';
import type { LoginResponse, User } from '../types';

export async function login(username_or_name: string, password: string): Promise<LoginResponse> {
  const { data } = await apiClient.post('/api/auth/login', {
    username_or_name,
    password,
  });
  return data;
}

export async function logout(): Promise<void> {
  await apiClient.post('/api/auth/logout');
}

export async function getMe(): Promise<User> {
  const { data } = await apiClient.get('/api/auth/me');
  return data;
}

/** 带超时的 session 验证（用于页面初始化时快速检测 token 有效性） */
export async function getMeWithTimeout(timeoutMs = 3000): Promise<User> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { data } = await apiClient.get('/api/auth/me', {
      signal: controller.signal,
    });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function getOnlineCount(): Promise<number> {
  const { data } = await apiClient.get('/api/auth/online-count');
  return data.count;
}
