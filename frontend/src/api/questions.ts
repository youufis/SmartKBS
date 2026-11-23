/** 试题库 API */
import apiClient from './client';
import { pollAiTask, pollAiTaskWithProgress, type AiTaskProgress } from './aiTask';
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
async function runAiTask<T>(
  url: string,
  body: unknown,
  maxWait = 600000,
  onProgress?: (p: AiTaskProgress) => void,
): Promise<T> {
  const { data } = await apiClient.post(url, body);
  if (onProgress) {
    // 有进度回调时走带进度的轮询：出题/生图最慢，界面需要知道在第几步
    const task = await pollAiTaskWithProgress(data.task_id, onProgress, maxWait);
    return task.result as T;
  }
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

/* ══════════ 彻底删除（回收站 → 物理删除）══════════ */

export interface PurgeCleanup {
  /** 会连带清掉的知识点连边条数 */
  kp_edges: number;
  live_files: number;
  archived_dirs: number;
  archived_files: number;
}

export interface PurgeBlocker {
  /** not_found | not_in_recycle_bin | not_owner | in_use | in_wrong_book */
  kind: string;
  exams?: string[];
  practices?: string[];
  entries?: number;
  students?: number;
}

export interface PurgeItem {
  id: number;
  type?: string;
  subject?: string;
  status?: string;
  creator_username?: string;
  updated_at?: string;
  title?: string;
  purgeable: boolean;
  blockers: PurgeBlocker[];
  cleanup: PurgeCleanup;
}

export interface PurgePreviewResponse {
  items: PurgeItem[];
  purgeable: number;
  blocked: number;
}

export interface PurgeResponse {
  success: boolean;
  deleted: number;
  deleted_ids: number[];
  skipped: { id: number; kind: string; blockers: PurgeBlocker[] }[];
  media: { live_removed: number; archived_removed: number; files: number };
}

/** 彻底删除前把"能删哪些、为什么删不掉、连带清什么"摊开（判定与执行同源） */
export async function purgePreview(ids: number[]): Promise<PurgePreviewResponse> {
  const { data } = await apiClient.post('/api/questions/purge/preview', { ids });
  return data;
}

/** 物理删除回收站题目（后端要求 confirm，不可撤销） */
export interface QuestionRestoreSkipped {
  id: number;
  /** not_found | already_active | not_owner */
  kind: string;
}

export interface QuestionRestoreResponse {
  success: boolean;
  restored: number;
  restored_ids: number[];
  skipped: QuestionRestoreSkipped[];
  /** 搬回本题目录的归档配图目录数 */
  media_dirs_restored: number;
  /** 按题目知识点标签重新连上边的题数 */
  kp_relinked: number;
}

/** 从回收站还原试题（status 改回 active，配图目录搬回、知识点连边重建） */
export async function restoreQuestions(ids: number[]): Promise<QuestionRestoreResponse> {
  const { data } = await apiClient.post('/api/questions/restore', { ids });
  return data;
}

export async function purgeQuestions(ids: number[]): Promise<PurgeResponse> {
  const { data } = await apiClient.post('/api/questions/purge', { ids, confirm: true });
  return data;
}

/** AI 生成试题（含SVG配图+公式+自动生图，异步任务版） */
export async function generateQuestionsWithMedia(
  req: QuestionGenerateRequest,
  onProgress?: (p: AiTaskProgress) => void,
): Promise<QuestionGenerateResponse> {
  return runAiTask<QuestionGenerateResponse>('/api/questions/generate-with-media-async', req, 600000, onProgress);
}

export async function listQuestions(params?: {
  type?: string;
  keyword?: string;
  creator?: string;
  difficulty?: string;
  subject?: string;
  knowledge_points?: string;
  kp_state?: string;
  /** no_explanation | no_media | pending_media */
  quality?: string;
  start_date?: string;
  end_date?: string;
  /** active=在用（默认）、deleted=回收站、all=全部 */
  status?: string;
  /** 排序：created_at(默认) | updated_at | id | difficulty */
  sort?: string;
  order?: 'asc' | 'desc';
  /** 1 = 附带每道题被考试/练习引用的次数 */
  include_refs?: number;
  page?: number;
  page_size?: number;
}, opts?: { signal?: AbortSignal }): Promise<QuestionListResponse> {
  const { data } = await apiClient.get('/api/questions', { params, signal: opts?.signal });
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
    /** 没有知识点标签的题目数（与列表 kp_state=none 同一口径） */
    untagged_count?: number
  }
}

export async function getQuestionAnalytics(params?: {
  subject?: string
  type?: string
  difficulty?: string
  creator?: string
  knowledge_points?: string
  kp_state?: string
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

/** 批量删除里被跳过的题：kind 由前端翻译，exams/practices 是占用该题的活动名 */
export interface BatchDeleteSkipped {
  id: number;
  kind: 'not_found' | 'already_deleted' | 'not_owner' | 'in_use' | string;
  exams?: string[];
  practices?: string[];
}

export interface BatchDeleteResult {
  success: boolean;
  deleted: number;
  skipped: BatchDeleteSkipped[];
}

/**
 * 试题管理多选批量删除（软删除）。
 * 逐条校验归属与占用：能删的都删，删不掉的按条返回原因，不整批回滚。
 */
export async function batchDeleteQuestions(ids: number[]): Promise<BatchDeleteResult> {
  const { data } = await apiClient.post('/api/questions/batch-delete', { ids });
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
