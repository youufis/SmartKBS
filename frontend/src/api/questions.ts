/** 试题库 API */
import apiClient from './client';
import type {
  QuestionInfo,
  QuestionGenerateRequest,
  QuestionGenerateResponse,
  QuestionListResponse,
  QuestionTypeOption,
} from '../types';

export async function generateQuestions(req: QuestionGenerateRequest): Promise<QuestionGenerateResponse> {
  const { data } = await apiClient.post('/api/questions/generate', req, {
    timeout: 180000, // AI 生成较慢，设置 3 分钟超时
  });
  return data;
}

export async function listQuestions(params?: {
  type?: string;
  keyword?: string;
  creator?: string;
  difficulty?: string;
  subject?: string;
  page?: number;
  page_size?: number;
}): Promise<QuestionListResponse> {
  const { data } = await apiClient.get('/api/questions', { params });
  return data;
}

export async function getQuestion(id: number): Promise<QuestionInfo> {
  const { data } = await apiClient.get(`/api/questions/${id}`);
  return data;
}

export async function updateQuestion(
  id: number,
  updates: Partial<{
    question_text: string;
    options: string;
    correct_answer: string;
    explanation: string;
    knowledge_points: string;
    difficulty: string;
  }>
): Promise<{ message: string }> {
  const { data } = await apiClient.put(`/api/questions/${id}`, updates);
  return data;
}

export async function deleteQuestion(id: number): Promise<{ message: string }> {
  const { data } = await apiClient.delete(`/api/questions/${id}`);
  return data;
}

export async function getQuestionTypes(): Promise<{ types: QuestionTypeOption[] }> {
  const { data } = await apiClient.get('/api/questions/types/list');
  return data;
}

export async function dedupQuestions(): Promise<{
  total_deleted: number;
  groups: { question_text: string; keep_id: number; deleted_ids: number[]; count: number }[];
  message: string;
}> {
  const { data } = await apiClient.post('/api/questions/dedup');
  return data;
}
