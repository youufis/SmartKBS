/** 考试发布 API */
import apiClient from './client';
import type {
  ExamInfo,
  ExamCreateRequest,
  ExamListResponse,
  ExamResultResponse,
  ExamAttempt,
} from '../types';

/** 创建考试 */
export async function createExam(req: ExamCreateRequest): Promise<{ message: string; exam_id: number }> {
  const { data } = await apiClient.post('/api/exams', req);
  return data;
}

/** 获取考试列表 */
export async function listExams(params?: {
  status?: string;
  subject?: string;
  keyword?: string;
  scope?: string;
  page?: number;
  page_size?: number;
}): Promise<ExamListResponse> {
  const { data } = await apiClient.get('/api/exams', { params });
  return data;
}

/** 获取考试详情 */
export async function getExam(examId: number): Promise<ExamInfo> {
  const { data } = await apiClient.get(`/api/exams/${examId}`);
  return data;
}

/** 更新考试 */
export async function updateExam(
  examId: number,
  updates: Partial<ExamCreateRequest>
): Promise<{ message: string }> {
  const { data } = await apiClient.put(`/api/exams/${examId}`, updates);
  return data;
}

/** 删除考试 */
export async function deleteExam(examId: number): Promise<{ message: string }> {
  const { data } = await apiClient.delete(`/api/exams/${examId}`);
  return data;
}

/** 发布考试 */
export async function publishExam(examId: number): Promise<{ message: string }> {
  const { data } = await apiClient.put(`/api/exams/${examId}/publish`);
  return data;
}

/** 结束考试 */
export async function endExam(examId: number): Promise<{ message: string }> {
  const { data } = await apiClient.put(`/api/exams/${examId}/end`);
  return data;
}

/** 向考试添加试题 */
export async function addQuestionsToExam(
  examId: number,
  questionIds: number[],
  scores?: number[]
): Promise<{ message: string; added: number; skipped_existing?: number; skipped_invalid?: number }> {
  const { data } = await apiClient.post(`/api/exams/${examId}/questions`, {
    question_ids: questionIds,
    scores,
  });
  return data;
}

/** 从考试移除试题 */
export async function removeQuestionsFromExam(
  examId: number,
  questionIds: number[]
): Promise<{ message: string }> {
  const { data } = await apiClient.delete(`/api/exams/${examId}/questions`, {
    params: { question_ids: questionIds.join(',') },
  });
  return data;
}

/** 批量更新试题分值 */
export async function batchUpdateScores(
  examId: number,
  scores: Record<string, number>
): Promise<{ message: string; current_total: number; expected_total: number; balanced: boolean }> {
  const { data } = await apiClient.put(`/api/exams/${examId}/questions/batch-scores`, { scores });
  return data;
}

/** 自动均衡分配总分到所有题目 */
export async function autoBalanceScores(
  examId: number
): Promise<{ message: string; count: number; score_per_question: number }> {
  const { data } = await apiClient.post(`/api/exams/${examId}/questions/auto-balance`);
  return data;
}

/** 智能选题：根据条件自动从题库选取试题 */
export async function autoSelectQuestions(
  examId: number,
  params: {
    subject?: string;
    question_types?: string[];
    difficulty?: string;
    knowledge_keyword?: string;
    count?: number;
    exclude_existing?: boolean;
  }
): Promise<{ message: string; added: number; questions: any[] }> {
  const { data } = await apiClient.post(`/api/exams/${examId}/auto-select-questions`, params);
  return data;
}

/** 学生开始考试 */
export async function startExam(examId: number): Promise<{
  message: string;
  attempt_id: number;
  existing: boolean;
}> {
  const { data } = await apiClient.post(`/api/exams/${examId}/start`);
  return data;
}

/** 学生提交答案 */
export async function submitExam(
  examId: number,
  answers: Record<string, string>
): Promise<{
  message: string;
  attempt_id: number;
  score: number;
  total_score: number;
  passed: boolean;
  details?: Record<string, any>;
}> {
  const { data } = await apiClient.post(`/api/exams/${examId}/submit`, { answers });
  return data;
}

/** 获取考试成绩统计 */
export async function getExamResults(examId: number): Promise<ExamResultResponse> {
  const { data } = await apiClient.get(`/api/exams/${examId}/results`);
  return data;
}

/** 获取我的考试成绩 */
export async function getMyResults(): Promise<{ results: ExamAttempt[] }> {
  const { data } = await apiClient.get('/api/exams/student/results');
  return data;
}

// ── 智能组卷相关 ──

/** 题型配置项 */
export interface TypeConfigItem {
  type: 'single' | 'multiple' | 'true_false' | 'short';
  count: number;
  score_per_question: number;
}

/** 智能组卷请求 */
export interface ComposeRequest {
  school_name?: string;
  semester?: string;
  target_grade?: string;
  type_configs: TypeConfigItem[];
  difficulty_easy_ratio?: number;
  difficulty_medium_ratio?: number;
  difficulty_hard_ratio?: number;
  knowledge_points?: string[];
  total_score?: number;
  replace_existing?: boolean;
  use_ai?: boolean;
}

/** 智能组卷响应 */
export interface ComposeResponse {
  message: string;
  added: number;
  total_questions: number;
  type_stats: Record<string, number>;
  difficulty_stats: Record<string, number>;
  total_score: number;
  reason: string;
}

/** 智能组卷：按配置从题库选题 */
export async function composeExam(
  examId: number,
  req: ComposeRequest
): Promise<ComposeResponse> {
  const { data } = await apiClient.post(`/api/exams/${examId}/compose`, req);
  return data;
}

/** 获取默认组卷配置 */
export async function getDefaultComposeConfig(
  examId: number
): Promise<{
  subject: string;
  question_stats: any[];
  available_knowledge_points: string[];
  default_config: {
    type_configs: TypeConfigItem[];
    difficulty_easy_ratio: number;
    difficulty_medium_ratio: number;
    difficulty_hard_ratio: number;
  };
}> {
  const { data } = await apiClient.get(`/api/exams/compose-config/defaults`, {
    params: { exam_id: examId },
  });
  return data;
}

/** 获取知识点列表 */
export async function getKnowledgePoints(): Promise<{
  knowledge_points: string[];
  total: number;
}> {
  const { data } = await apiClient.get('/api/exams/knowledge-points/list');
  return data;
}

/** 导出 Word 试卷（学生用） */
export function getExportPaperUrl(examId: number, schoolName?: string, semester?: string): string {
  const token = localStorage.getItem('smartkb_token');
  const params = new URLSearchParams({ token: token || '' });
  if (schoolName) params.set('school_name', schoolName);
  if (semester) params.set('semester', semester);
  return `/api/exams/${examId}/export-paper?${params.toString()}`;
}

/** 导出 Word 答案卷（教师用） */
export function getExportAnswerKeyUrl(examId: number, schoolName?: string, semester?: string): string {
  const token = localStorage.getItem('smartkb_token');
  const params = new URLSearchParams({ token: token || '' });
  if (schoolName) params.set('school_name', schoolName);
  if (semester) params.set('semester', semester);
  return `/api/exams/${examId}/export-answer-key?${params.toString()}`;
}

/** 导出 Word 答题卡 */
export function getExportAnswerSheetUrl(examId: number): string {
  const token = localStorage.getItem('smartkb_token');
  const params = new URLSearchParams({ token: token || '' });
  return `/api/exams/${examId}/export-answer-sheet?${params.toString()}`;
}
