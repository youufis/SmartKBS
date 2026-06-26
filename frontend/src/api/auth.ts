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

// ── 密保问题（双问题 + 频率限制）──

export interface SecurityStatus {
  configured: boolean;
  question1: string;
  question2: string;
}

export interface SecurityCheckResult {
  username: string;
  question1: string;
  question2: string;
}

export async function getSecurityQuestions(): Promise<string[]> {
  const { data } = await apiClient.get('/api/auth/security-questions');
  return data.questions;
}

export async function getSecurityStatus(): Promise<SecurityStatus> {
  const { data } = await apiClient.get('/api/auth/security-status');
  return data;
}

export async function securityCheck(username: string): Promise<SecurityCheckResult> {
  const { data } = await apiClient.get(`/api/auth/security-check/${encodeURIComponent(username)}`);
  return data;
}

export async function setSecurityQuestions(
  question1: string, answer1: string,
  question2: string, answer2: string,
): Promise<string> {
  const { data } = await apiClient.put('/api/auth/security-question', {
    question1, answer1, question2, answer2,
  });
  return data.message;
}

export async function verifySecurity(
  username: string, answer: string, questionIndex = 0,
): Promise<boolean> {
  const { data } = await apiClient.post('/api/auth/verify-security', {
    username, answer, question_index: questionIndex,
  });
  return data.verified;
}

export async function resetPasswordBySecurity(
  username: string, answer1: string, answer2: string, new_password: string,
): Promise<string> {
  const { data } = await apiClient.post('/api/auth/reset-password-by-security', {
    username, answer1, answer2, new_password,
  });
  return data.message;
}
