/** 任务管理 API */
import apiClient from './client';
import type { TaskInfo } from '../types';

export async function getActiveTasks(user?: string): Promise<{ tasks: TaskInfo[]; total: number }> {
  const { data } = await apiClient.get('/api/tasks/active', { params: user ? { user } : {} });
  return data;
}

export async function createTask(name: string, description?: string): Promise<{ task: TaskInfo; message: string }> {
  const { data } = await apiClient.post('/api/tasks/create', { name, description });
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

export interface AIClassSummary {
  class_average?: number;
  highest_score?: number;
  lowest_score?: number;
  total_students?: number;
  overall_comment?: string;
  teaching_suggestions?: string;
}

export interface AIGradeResult {
  student: string;
  score: number;
  comment: string;
  feedback: string;
  strengths: string[];
  weaknesses: string[];
  graded_at?: string;
}

export async function aiGradeTask(task_id: string): Promise<{
  summary?: AIClassSummary;
  grades: AIGradeResult[];
  graded_count: number;
  message: string;
}> {
  const { data } = await apiClient.post(`/api/tasks/ai-grade/${encodeURIComponent(task_id)}`);
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
