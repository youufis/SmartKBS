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
}, subject?: string, hw?: HomeworkOptions): Promise<{ task: TaskInfo; message: string }> {
  const { data } = await apiClient.post('/api/tasks/create', {
    name,
    description,
    // 学科：落库后活动监控/作业列表才显示得出科目
    subject: subject || '',
    target_scope: scope?.target_scope || 'teacher_classes',
    target_grade: scope?.target_grade || '',
    target_class: scope?.target_class || '',
    target_users: scope?.target_users || '',
    // 文件作业参数：不传就是对话作业（后端默认 conversation，老调用方行为不变）
    ...(hw || {}),
  });
  return data;
}

/** 编辑作业：名称 / 要求 / 学科（其它字段涉及发布范围，后端不放） */
export async function updateTask(
  task_id: string,
  patch: { name?: string; description?: string; subject?: string } & HomeworkOptions,
): Promise<{ task: TaskInfo; message: string }> {
  const { data } = await apiClient.put('/api/tasks/update', { task_id, ...patch });
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
  /** 有效分：教师改过就是教师分，否则是 AI 分 */
  score: number;
  comment: string;
  feedback: string;
  strengths: string[];
  weaknesses: string[];
  criteria?: GradeCriterion[];
  graded_at?: string;
  // ── 文件作业批改台用 ──
  ai_score?: number | null;
  teacher_score?: number | null;
  ai_comment?: string;
  /** 各评分维度得分 {维度名: 分数} */
  dim_scores?: Record<string, number>;
  needs_review?: boolean;
  published?: boolean;
  late_submitted?: boolean;
  similarity?: { with: string; ratio: number }[];
  graded_by?: 'ai' | 'teacher' | 'none';
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

/** AI 起草作业：返回名称与要求草稿（不落库，教师改完再创建）
 *
 * submit_mode 决定后端用哪套 prompt —— 文件作业还会一并给出评分维度与要交的文件类型。
 */
export interface HomeworkDraft {
  name: string;
  description: string;
  duration_minutes: number;
  tips: string;
  submit_mode?: string;
  /** 评分维度 JSON 串（文件作业才有） */
  rubric?: string;
  dims?: { name: string; max: number }[];
  /** 建议收的文件类型，逗号分隔（文件作业才有） */
  allowed_exts?: string;
}

export async function aiDraftHomework(payload: {
  idea: string;
  grade?: string;
  class?: string;
  duration_minutes?: string | number;
  submit_mode?: string;
  total_score?: number;
}): Promise<HomeworkDraft> {
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

// ── 文件提交类作业（Word / PDF / 图片 / 表格 / 演示稿）──

export interface HomeworkFileItem {
  id: number;
  task_id: string;
  student: string;
  seq: number;
  filename: string;
  ext: string;
  kind: string;
  mime: string;
  size: number;
  chars: number;
  /** ok | image | empty | scanned | failed | pending */
  extract_status: string;
  error: string;
  has_digest: boolean;
  created_at: string;
  url: string;
  is_latest?: boolean;
  text_preview?: string;
  text_truncated?: boolean;
}

export interface HomeworkOverview {
  task_id: string;
  task_name: string;
  submit_mode: string;
  deadline_at: string;
  allowed_exts: string[];
  max_files: number;
  max_file_mb: number;
  resubmit_limit: number;
  total_score: number;
  files: HomeworkFileItem[];
  submissions: Record<string, { submitted_at: string; note: string; late_submitted: boolean }>;
}

/** 提交/编辑作业时可选的文件作业参数（不传即对话作业，与老行为完全一致） */
export interface HomeworkOptions {
  submit_mode?: 'conversation' | 'file' | 'mixed';
  allowed_exts?: string;
  max_files?: number;
  max_file_mb?: number;
  deadline_at?: string;
  resubmit_limit?: number;
  allow_late?: number;
  total_score?: number;
  rubric?: string;
  grading_policy?: string;
}

export async function getTaskFiles(task_id: string, student?: string): Promise<HomeworkOverview> {
  const { data } = await apiClient.get(`/api/tasks/${encodeURIComponent(task_id)}/files`,
    { params: student ? { student } : {} });
  return data;
}

/** 上传作业文件（带真实进度；multipart 不能走 JSON 拦截器的默认头） */
export async function submitTaskFiles(
  task_id: string, files: File[], note = '',
  onProgress?: (percent: number) => void,
): Promise<{ message: string; submission_seq: number; late_submitted: boolean }> {
  const fd = new FormData();
  files.forEach((f) => fd.append('files', f));
  if (note) fd.append('note', note);
  const { data } = await apiClient.post(`/api/tasks/${encodeURIComponent(task_id)}/submit-files`, fd, {
    onUploadProgress: (e) => onProgress?.(e.total ? Math.round((e.loaded * 100) / e.total) : 0),
    timeout: 300000,
  });
  return data;
}

export async function deleteTaskFile(task_id: string, file_id: number): Promise<{ message: string }> {
  const { data } = await apiClient.delete(
    `/api/tasks/${encodeURIComponent(task_id)}/file/${file_id}`);
  return data;
}

export async function reextractTaskFiles(task_id: string, student?: string): Promise<{
  message: string; ok: number; failed: number; skipped: number
}> {
  const { data } = await apiClient.post(`/api/tasks/${encodeURIComponent(task_id)}/extract`,
    student ? { student } : {});
  return data;
}

/** 后台批改任务 id，交给 pollAiTaskWithProgress 轮询（进度走通用的 ai-task 端点） */
export async function startFileGradingJob(task_id: string, student?: string): Promise<{
  task_id: string; poll_url: string; message: string
}> {
  const { data } = await apiClient.post(`/api/tasks/grading-job/${encodeURIComponent(task_id)}`,
    student ? { student } : {});
  return data;
}

export async function reviewGrade(task_id: string, payload: {
  student: string; score?: number; comment?: string; feedback?: string; needs_review?: boolean
}): Promise<{ grade: AIGradeResult; message: string }> {
  const { data } = await apiClient.put(`/api/tasks/grade-review/${encodeURIComponent(task_id)}`, payload);
  return data;
}

export async function publishGrades(task_id: string): Promise<{
  message: string; published: number; grade_awarded: number; notified: boolean
}> {
  const { data } = await apiClient.post(`/api/tasks/publish/${encodeURIComponent(task_id)}`);
  return data;
}

export async function getTaskSimilarity(task_id: string): Promise<{
  pairs: { a: string; b: string; ratio: number }[]; count: number; message: string
}> {
  const { data } = await apiClient.get(`/api/tasks/${encodeURIComponent(task_id)}/similarity`);
  return data;
}

/** 单个作业文件的读取地址（<img>/<a download> 用；浏览器会带上登录 Cookie） */
export function homeworkFileUrl(fileId: number, inline = false): string {
  return `/api/tasks/file/${fileId}${inline ? '?inline=1' : ''}`;
}

export function homeworkArchiveUrl(taskId: string, student?: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/archive${student ? `?student=${encodeURIComponent(student)}` : ''}`;
}
