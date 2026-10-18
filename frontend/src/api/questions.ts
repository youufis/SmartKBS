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
  knowledge_points?: string;
  start_date?: string;
  end_date?: string;
  page?: number;
  page_size?: number;
}): Promise<QuestionListResponse> {
  const { data } = await apiClient.get('/api/questions', { params });
  return data;
}

export interface QuestionAnalyticsSummary {
  total: number
  type_count: number
  knowledge_point_count: number
  creator_count: number
  with_knowledge_point: number
  knowledge_point_coverage: number
  with_explanation: number
  with_media: number
  media_coverage: number
  ai_count: number
  manual_count: number
  non_teacher_created: number
  invalid_subject: number
}

export interface QuestionAnalyticsCreator {
  username: string
  name: string
  role: number
  count: number
  types: Record<string, number>
  subjects: Record<string, number>
  last_created_at: string
}

export interface QuestionAnalytics {
  summary: QuestionAnalyticsSummary
  by_type: { type: string; count: number; percent: number }[]
  by_difficulty: { difficulty: string; count: number; percent: number }[]
  by_subject: { subject: string; count: number; percent: number }[]
  by_creator: QuestionAnalyticsCreator[]
  knowledge_points: { name: string; count: number; percent: number }[]
  knowledge_point_total: number
  timeline: { date: string; count: number }[]
  quality: {
    no_knowledge_point: number
    no_explanation: number
    no_media: number
    pending_media: number
    no_answer: number
    option_issues: number
    duplicate_groups: number
    duplicate_questions: number
    non_teacher_created: number
    invalid_subject: number
  }
  meta: {
    subjects: string[]
    creators: { username: string; name: string; role: number; count: number }[]
    types: string[]
    min_date: string
    max_date: string
  }
}

export async function getQuestionAnalytics(params?: {
  subject?: string
  type?: string
  difficulty?: string
  creator?: string
  knowledge_points?: string
  keyword?: string
  start_date?: string
  end_date?: string
}): Promise<QuestionAnalytics> {
  const { data } = await apiClient.get('/api/questions/analytics', { params })
  return data
}

export async function getQuestionAnalyticsMeta(): Promise<QuestionAnalytics['meta']> {
  const { data } = await apiClient.get('/api/questions/analytics/meta')
  return data
}

export interface CreatorAuditCreator {
  username: string
  name: string
  role: number
  count: number
}

export interface CreatorAuditQuestion {
  id: number
  type: string
  subject: string
  status: string
  created_at: string
  question_text: string
}

export interface CreatorAuditResult {
  creators: CreatorAuditCreator[]
  anomalies: CreatorAuditCreator[]
  targets: { username: string; name: string; role: number }[]
  questions: CreatorAuditQuestion[]
}

export async function getQuestionCreatorAudit(creator = ''): Promise<CreatorAuditResult> {
  const { data } = await apiClient.get('/api/questions/creator-audit', { params: creator ? { creator } : {} })
  return data
}

export async function transferQuestionCreator(req: {
  from_username: string
  to_username: string
  question_ids?: number[]
}): Promise<{ success: boolean; transferred: number; target?: string }> {
  const { data } = await apiClient.post('/api/questions/creator-audit/transfer', req)
  return data
}

export async function archiveQuestionCreator(req: {
  from_username: string
  question_ids?: number[]
}): Promise<{ success: boolean; archived: number }> {
  const { data } = await apiClient.post('/api/questions/creator-audit/archive', req)
  return data
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

export interface TagFillItem { id: number; tags: string[]; question?: string }

export interface TagFillResult {
  dry_run: boolean;
  scanned: number;
  suggested: number;
  written?: number;
  failed_batches?: number;
  items?: TagFillItem[];
  dropped?: number;
  allowed_tags?: string[];
  kp_map?: Record<string, unknown>;
  message?: string;
}

/**
 * AI 补标：默认只做预览；confirm=true 且带 items 时按用户编辑后的建议写入，
 * 不带 items 则走"AI 生成即写入"旧路径(仅管理员；多批 AI 调用，超时放宽)
 */
export async function tagFillQuestions(
  confirm = false, limit = 50, items?: { id: number; tags: string[] }[],
): Promise<TagFillResult> {
  const { data } = await apiClient.post(
    '/api/questions/tag-fill',
    { confirm, limit, ...(items ? { items } : {}) },
    { timeout: 300000 },
  );
  return data;
}

/** 提取响应: 短内容同步返回; 长文档转后台任务(mode=task)需轮询 task_id */
export interface ExtractResponse {
  mode?: 'task';
  task_id?: string;
  batches?: number;
  estimated?: number;
  message?: string;
  note?: string;
  total?: number;
  questions?: QuestionInfo[];
}

export async function extractQuestions(formData: FormData): Promise<ExtractResponse> {
  const { data } = await apiClient.post('/api/questions/extract', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 600000,
  });
  return data;
}
