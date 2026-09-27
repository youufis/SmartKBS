/** 任务管理 API */
import apiClient from './client';
import type { TaskInfo } from '../types';

export async function getActiveTasks(user?: string): Promise<{ tasks: TaskInfo[]; total: number }> {
  const { data } = await apiClient.get('/api/tasks/active', { params: user ? { user } : {} });
  return data;
}

export async function createTask(name: string, description?: string, scope?: {
  target_scope?: string;
  target_grade?: string;
  target_class?: string;
  target_users?: string;
}): Promise<{ task: TaskInfo; message: string }> {
  const { data } = await apiClient.post('/api/tasks/create', {
    name,
    description,
    target_scope: scope?.target_scope || 'teacher_classes',
    target_grade: scope?.target_grade || '',
    target_class: scope?.target_class || '',
    target_users: scope?.target_users || '',
  });
  return data;
}

export async function submitTask(task_id: string, conversation_content: string): Promise<{ message: string }> {
  const { data } = await apiClient.post('/api/tasks/submit', { task_id, conversation_content });
  return data;
}

export async function deleteTask(task_id: string): Promise<{ message: string }> {
  const { data } = await apiClient.delete('/api/tasks/delete', { data: { task_id } });
  return data;
}

export async function endTask(task_id: string): Promise<{ message: string }> {
  const { data } = await apiClient.put('/api/tasks/end', { task_id });
  return data;
}

export async function getUserTasks(): Promise<{ tasks: TaskInfo[] }> {
  const { data } = await apiClient.get('/api/tasks/user');
  return data;
}

export interface TaskSubmission {
  username: string;
  name: string;
}

export async function getTaskSubmissions(task_id: string, student?: string): Promise<{
  task_name: string;
  task_status: string;
  submissions: TaskSubmission[];
  submission_count: number;
  student_content?: string;
}> {
  const params: any = {};
  if (student) params.student = student;
  const { data } = await apiClient.get(`/api/tasks/submissions/${encodeURIComponent(task_id)}`, { params });
  return data;
}

export async function revertSubmission(task_id: string, student: string): Promise<string> {
  const { data } = await apiClient.post('/api/tasks/revert-submission', { task_id, student });
  return data.message;
}

// ── AI 批改 ──

/** 按教师填的作业要求拆出的「要求点」逐条判定 */
export interface GradeCriterion {
  item: string;
  status?: string;
  evidence?: string;
}

/** 全班层面：每条要求点的达成情况 */
export interface RequirementReviewItem {
  item: string;
  class_status?: string;
  note?: string;
}

export interface AIClassSummary {
  class_average?: number;
  highest_score?: number;
  lowest_score?: number;
  total_students?: number;
  overall_comment?: string;
  teaching_suggestions?: string;
  requirement_review?: RequirementReviewItem[];
}

export interface AIGradeResult {
  student: string;
  score: number;
  comment: string;
  feedback: string;
  strengths: string[];
  weaknesses: string[];
  criteria?: GradeCriterion[];
  graded_at?: string;
}

export async function aiGradeTask(task_id: string): Promise<{
  summary?: AIClassSummary;
  grades: AIGradeResult[];
  graded_count: number;
  message: string;
}> {
  const { data } = await apiClient.post(`/api/tasks/ai-grade/${encodeURIComponent(task_id)}`, null, { timeout: 300000 });
  return data;
}

/** AI 起草对话作业：返回名称与要求草稿（不落库，教师改完再创建） */
export async function aiDraftHomework(payload: {
  idea: string;
  grade?: string;
  class?: string;
  duration_minutes?: string | number;
}): Promise<{ name: string; description: string; duration_minutes: number; tips: string }> {
  const { data } = await apiClient.post('/api/tasks/ai-create-draft', payload, { timeout: 180000 });
  return data;
}

/** 只批改一位学生（不覆盖其他学生的成绩） */
export async function aiGradeStudent(task_id: string, student: string): Promise<{
  grade: AIGradeResult;
  summary?: AIClassSummary;
  message: string;
}> {
  const { data } = await apiClient.post(
    `/api/tasks/ai-grade-student/${encodeURIComponent(task_id)}`,
    { student },
    { timeout: 300000 },
  );
  return data;
}

export async function getTaskGrades(task_id: string): Promise<{
  summary?: AIClassSummary;
  grades: AIGradeResult[];
  graded_count: number;
}> {
  const { data } = await apiClient.get(`/api/tasks/grades/${encodeURIComponent(task_id)}`);
  return data;
}
