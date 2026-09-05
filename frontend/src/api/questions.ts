/** 试题库 API */
import apiClient from './client';
import { pollAiTask } from './aiTask';
import type {
  QuestionInfo,
  QuestionGenerateRequest,
  QuestionGenerateResponse,
  QuestionListResponse,
  QuestionTypeOption,
} from '../types';

/**
 * 提交 AI 后台任务并轮询结果。
 * 出题/生图这类调用在单条 HTTP 请求里可长达数分钟, 容易被网关/代理掐断,
 * 因此统一走 ai_task_manager 的异步任务(Q7)。
 */
async function runAiTask<T>(url: string, body: unknown, maxWait = 600000): Promise<T> {
  const { data } = await apiClient.post(url, body);
  const result = await pollAiTask(data.task_id, maxWait);
  if (!result) {
    // 超时: 不带 message, 由调用方回落到本地化文案
    const err: any = new Error('');
    err.aiTaskTimeout = true;
    throw err;
  }
  if (result.error) throw new Error(result.error);
  return result as T;
}

export async function generateQuestions(req: QuestionGenerateRequest): Promise<QuestionGenerateResponse> {
  return runAiTask<QuestionGenerateResponse>('/api/questions/generate-async', req);
}

/** AI 生成试题（含SVG配图+公式+自动生图，异步任务版） */
export async function generateQuestionsWithMedia(req: QuestionGenerateRequest): Promise<QuestionGenerateResponse> {
  return runAiTask<QuestionGenerateResponse>('/api/questions/generate-with-media-async', req);
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
    type: string;
    subject: string;
  }>
): Promise<{ message: string; warnings?: string[] }> {
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

export interface DedupResult {
  dry_run?: boolean;
  total_deleted: number;
  deletable_count?: number;
  total_skipped_owner?: number;
  total_skipped_ref?: number;
  groups: {
    question_text: string;
    type?: string;
    correct_answer?: string;
    keep_id: number;
    deleted_ids: number[];
    count: number;
    skipped_owner?: number;
    skipped_ref?: number;
  }[];
  message: string;
}

/** 题库去重：默认只做预览，confirm=true 才真正清理(Q4 两步式) */
export async function dedupQuestions(confirm = false): Promise<DedupResult> {
  const { data } = await apiClient.post('/api/questions/dedup', { confirm });
  return data;
}

export async function extractQuestions(formData: FormData): Promise<QuestionGenerateResponse> {
  const { data } = await apiClient.post('/api/questions/extract', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 600000,
  });
  return data;
}
