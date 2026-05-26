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

export async function getOnlineCount(): Promise<number> {
  const { data } = await apiClient.get('/api/auth/online-count');
  return data.count;
}
