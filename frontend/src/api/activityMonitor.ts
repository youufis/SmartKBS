/** 活动完成监控 API */
import apiClient from './client';

/** 活动类型 */
export type ActivityType = 'exam' | 'practice' | 'quick_quiz' | 'task' | 'quiz' | 'code' | 'discussion' | 'poll' | 'course' | 'all';

/** 活动信息 */
export interface ActivityItem {
  id: number;
  title: string;
  status: string;
  activity_type: ActivityType;
  submitted_count: number;
  /** 选了班级时返回的分母（该班学生数）；未选班级为 undefined/0 */
  student_count?: number;
  /** 未完成人数（= student_count - submitted_count），仅在选了班级时返回 */
  incomplete_count?: number;
  /** 完成率百分比（0-100，一位小数），仅在选了班级时返回 */
  completion_rate?: number;
  total_score: number;
  pass_score: number;
  duration: number;
  subject: string;
  creator_name?: string;
  creator_username?: string;
  target_scope?: string;
  target_grade?: string;
  target_class?: string;
  target_users?: string;
  created_at: string;
  updated_at: string;
}

/** 活动列表响应 */
export interface ActivityListResponse {
  activities: ActivityItem[];
  total: number;
  page: number;
  page_size: number;
}

/** 学生完成情况 */
export interface StudentStatus {
  username: string;
  name: string;
  grade: string;
  class_name: string;
  score: number;
  total_score: number;
  /** 百分制得分率（后端统一口径；无满分的活动为 null） */
  percentage?: number | null;
  /** 仍在后台批改的题数（>0 时分数未定，前端应显示「批改中」而不是半个分） */
  pending_ai?: number;
  submitted_at: string;
  status: 'completed' | 'incomplete';
}

/** 活动统计 */
export interface ActivityStatistics {
  total_students: number;
  completed_count: number;
  incomplete_count: number;
  avg_score: number;
  completion_rate: number;
}

/** 活动详情（含完成状态） */
export interface ActivityStatusDetail {
  activity: {
    id: number;
    title: string;
    type: ActivityType;
    type_label: string;
    status: string;
    total_score: number;
    pass_score: number;
    subject: string;
    created_at: string;
  };
  students: StudentStatus[];
  statistics: ActivityStatistics;
  page: number;
  page_size: number;
  total: number;
}

/** 年级班级信息 */
export interface GradeClassInfo {
  grade_id: number;
  grade_name: string;
  stage: string;
  classes: {
    class_id: number;
    class_name: string;
    display_name: string;
  }[];
}

/** 获取教师活动列表 */
export async function listActivities(params?: {
  activity_type?: ActivityType;
  keyword?: string;
  page?: number;
  page_size?: number;
  /** 按班级统计完成情况（可选）：传了才会在列表上显示 已完成 X/Y */
  grade_id?: number;
  class_id?: number;
}): Promise<ActivityListResponse> {
  const { data } = await apiClient.get('/api/activity-monitor/activities', { params });
  return data;
}

/** 获取活动完成状态详情 */
export async function getActivityStatus(
  activityType: ActivityType,
  activityId: number,
  params?: {
    grade_id?: number;
    class_id?: number;
    status_filter?: 'all' | 'completed' | 'incomplete';
    student_kw?: string;
    page?: number;
    page_size?: number;
  }
): Promise<ActivityStatusDetail> {
  const { data } = await apiClient.get(
    `/api/activity-monitor/activities/${activityType}/${activityId}/status`,
    { params }
  );
  return data;
}

/** 获取教师的年级班级列表 */
export async function getTeacherGradesClasses(): Promise<{ grades: GradeClassInfo[] }> {
  const { data } = await apiClient.get('/api/activity-monitor/grades-classes');
  return data;
}

/** 学习进度统计（单个学生或班级） */
export interface StudentProgress {
  username: string
  student_name: string
  course_progress: number
  completion_rate: number
  accuracy_rate: number
  streak_days: number
  course_done: number
  course_total: number
  exam_done: number
  practice_done: number
  code_done: number
}

export interface ClassProgressSummary {
  total_students: number
  avg_course_progress: number
  avg_completion_rate: number
  avg_accuracy_rate: number
  avg_streak_days: number
}

export interface LearningProgressResponse {
  summary: ClassProgressSummary
  students: StudentProgress[]
}

export async function getLearningProgress(params: {
  grade?: string
  class_name?: string
  username?: string
}): Promise<LearningProgressResponse> {
  const { data } = await apiClient.get('/api/activity-monitor/learning-progress', { params });
  return data;
}
