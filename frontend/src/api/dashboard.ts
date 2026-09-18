/** 首页看板 API：概览、趋势、教师行动项 */
import apiClient from './client'

export interface ExamResultItem {
  id: number
  title: string
  score: number
  total_score: number
  submitted_at: string
  pass_score: number
  passed: boolean
}

export interface PendingExamItem {
  id: number
  title: string
  subject: string
  duration: number
  total_score: number
  pass_score: number
  start_time: string | null
  end_time: string | null
}

export interface RecentExamItem {
  id: number
  title: string
  status: string
  created_at: string
  creator_username?: string
  creator_name?: string
}

export interface DashboardSummary {
  role: 'admin' | 'teacher' | 'student'
  username: string
  user_name: string
  // 学生
  pending_exam_count?: number
  completed_exam_count?: number
  total_score?: number
  rank?: number
  active_task_count?: number
  title_name?: string
  title_level?: number
  title_emoji?: string
  title_color?: string
  next_title_name?: string | null
  title_progress?: number
  submission_count?: number
  recent_chat_count?: number
  exam_results?: ExamResultItem[]
  pending_exams?: PendingExamItem[]
  active_quiz_count?: number
  my_quiz_answers?: number
  student_poll_vote_count?: number
  my_questions_count?: number
  my_answers_count?: number
  my_approved_answers_count?: number
  active_discussion_count?: number
  my_discussion_count?: number
  pending_practice_count?: number
  completed_practice_count?: number
  wrong_exam_count?: number
  wrong_book_total?: number
  wrong_book_mastered?: number
  wrong_book_pending?: number
  exam_avg_rate?: number | null
  badges_unlocked?: number
  badges_total?: number
  streak_days?: number
  quest_completed_count?: number
  quest_score?: number
  quick_quiz_participated?: number
  quick_quiz_correct?: number
  course_practice_count?: number
  course_practice_avg_accuracy?: number
  shared_files_count?: number
  // 教师/管理员
  exam_stats?: { total: number; draft: number; published: number; ended: number }
  total_submissions?: number
  total_students?: number
  total_teachers?: number
  rollcall_this_week?: number
  today_chat_count?: number
  teacher_grades?: string
  teacher_classes?: string
  teacher_subjects?: string[]
  teacher_quiz_count?: number
  teacher_active_quiz_count?: number
  teacher_poll_count?: number
  teacher_question_count?: number
  teacher_pending_question_count?: number
  teacher_student_answer_count?: number
  teacher_approved_answer_count?: number
  discussion_total?: number
  discussion_active?: number
  discussion_member_count?: number
  practice_published?: number
  practice_submitted?: number
  quest_total_count?: number
  quest_completed_count_t?: number
  quick_quiz_total?: number
  quick_quiz_ended?: number
  online_count?: number
  recent_exams?: RecentExamItem[]
  shared_resources_count?: number
}

export interface ActivityItem {
  time: string
  type: string
  title: string
  detail: string
}

export async function getSummary(): Promise<DashboardSummary> {
  const { data } = await apiClient.get('/api/dashboard/summary')
  return data
}

/** 近 N 天真实按日趋势 */
export interface TrendPoint {
  date: string
  label: string
  points: number
  actions: number
  chats: number
}

export interface LearningTrend {
  series: TrendPoint[]
  scope: 'self' | 'class' | 'all'
  total_points: number
}

export async function getLearningTrend(days = 7): Promise<LearningTrend> {
  const { data } = await apiClient.get('/api/dashboard/learning-trend', { params: { days } })
  return data
}

/** 教师/管理员行动项聚合 */
export interface WeeklyStar {
  username: string
  name: string
  /** 年级·班级，如「高一2班」 */
  tag?: string
  points: number
}

export interface TeacherTodo {
  pending_exam_grading: number
  pending_task_grades: number
  pending_questions: number
  pending_answer_reviews: number
  in_progress_exam_count: number
  next_exam: { id: number; title: string; end_time: string | null } | null
  active_quizzes: number
  active_quick_quiz_rooms: number
  active_discussions: number
  active_polls: number
  active_tasks: number
  active_students_today: number
  weekly_top_students: WeeklyStar[]
}

export async function getTeacherTodo(): Promise<TeacherTodo> {
  const { data } = await apiClient.get('/api/dashboard/teacher-todo')
  return data
}

/** 学科称号 */
export interface SubjectTitle {
  subject: string
  question_count: number
  level: number
  name: string
}

export async function getSubjectTitles(): Promise<SubjectTitle[]> {
  const { data } = await apiClient.get('/api/rewards/my-subject-titles')
  return data
}
