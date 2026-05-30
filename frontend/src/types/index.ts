/** SmartKB 全局类型定义 */

// 用户信息
export interface User {
  username: string;
  name: string;
  class: string;
  gender: string;
  role: 'admin' | 'teacher' | 'student';
  grade: string;
}

// 登录响应
export interface LoginResponse {
  token: string;
  user: User;
}

// 认证状态
export interface AuthState {
  isLoggedIn: boolean;
  user: User | null;
  token: string | null;
}

// 聊天消息
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

// SSE 流式数据块
export interface SSEChunk {
  type: 'delta' | 'done' | 'error';
  content?: string;
  session_id?: string;
}

// 用户管理 - 用户列表项
export interface UserItem {
  username: string;
  /** 班级：学生为单个值如 "3"，教师可用 "1,2,3,4|1,2,7,8" 格式（| 分隔不同年级的班级列表） */
  class: string;
  name: string;
  gender: string;
  role: string;
  /** 年级：学生为 "高一" 或 "高二"，教师可用 "高一|高二" 格式（| 分隔多个年级） */
  grade: string;
}

// 历史记录 - 树节点
export interface TreeNode {
  title: string;
  key: string;
  isLeaf: boolean;
  children?: TreeNode[];
  size?: number;
}

// 资源文件信息
export interface ResourceFile {
  name: string;
  path: string;
  url_path?: string;
  size: number;
  display_name: string;
}

// 任务信息
export interface TaskInfo {
  id: string;
  creator: string;
  name: string;
  description?: string;
  status: 'active' | 'inactive';
  created_time: string;
  submissions: string[];
}

// ── 试题库类型 ──

export interface QuestionInfo {
  id: number;
  type: 'single' | 'multiple' | 'true_false' | 'short';
  question_text: string;
  options: Record<string, string> | null;
  correct_answer: string;
  explanation: string;
  knowledge_points: string;
  subject: string;
  difficulty: 'easy' | 'medium' | 'hard';
  creator_username: string;
  creator_name: string;
  source: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface QuestionGenerateRequest {
  subject: string;
  knowledge_points: string;
  question_type: 'single' | 'multiple' | 'true_false' | 'short';
  count: number;
  difficulty: 'easy' | 'medium' | 'hard';
}

export interface QuestionGenerateResponse {
  message: string;
  questions: QuestionInfo[];
  total: number;
}

export interface QuestionListResponse {
  questions: QuestionInfo[];
  total: number;
  page: number;
  page_size: number;
}

export interface QuestionTypeOption {
  key: string;
  label: string;
}

// ── 考试发布类型 ──

export interface ExamInfo {
  id: number;
  title: string;
  description: string;
  subject: string;
  duration: number;
  total_score: number;
  pass_score: number;
  shuffle_questions: number;
  shuffle_options: number;
  show_result_immediately: number;
  max_attempts: number;
  start_time: string | null;
  end_time: string | null;
  status: 'draft' | 'published' | 'ended';
  creator_username: string;
  creator_name: string;
  question_count?: number;
  created_at: string;
  updated_at: string;
  /** 学生端专用：我的答题记录 */
  my_attempt?: ExamAttempt | null;
  /** 详情接口返回的题目列表 */
  questions?: ExamQuestion[];
}

export interface ExamQuestion {
  eq_id: number;
  sort_order: number;
  question_score: number;
  id: number;
  type: string;
  question_text: string;
  options: Record<string, string> | null;
  correct_answer?: string;
  explanation?: string;
  difficulty: string;
  knowledge_points: string;
}

export interface ExamAttempt {
  id: number;
  exam_id: number;
  student_username: string;
  student_name: string;
  started_at: string;
  submitted_at: string | null;
  status: 'in_progress' | 'submitted' | 'graded';
  score: number;
  total_score: number;
  answers: Record<string, any> | null;
  auto_graded: number;
  exam_title?: string;
  exam_subject?: string;
  pass_score?: number;
}

export interface ExamCreateRequest {
  title: string;
  description?: string;
  subject?: string;
  duration?: number;
  total_score?: number;
  pass_score?: number;
  shuffle_questions?: boolean;
  shuffle_options?: boolean;
  show_result_immediately?: boolean;
  max_attempts?: number;
  start_time?: string | null;
  end_time?: string | null;
}

export interface ExamListResponse {
  exams: ExamInfo[];
  total: number;
  page: number;
  page_size: number;
}

export interface ExamResultResponse {
  exam: ExamInfo;
  attempts: ExamAttempt[];
  statistics: {
    total_students: number;
    avg_score: number;
    pass_count: number;
    pass_rate: number;
    max_score: number;
    min_score: number;
  };
}

// ── 课程大纲类型 ──

export interface Course {
  id: number;
  name: string;
  code: string;
  description: string;
  grade: string;
  cover_image: string;
  sort_order: number;
  status: string;
  created_at: string;
  updated_at: string;
  chapters?: ChapterTreeNode[];
  progress?: { total: number; completed: number };
}

export interface ChapterTreeNode {
  id: number;
  course_id: number;
  parent_id: number | null;
  name: string;
  description: string;
  sort_order: number;
  status: string;
  children?: ChapterTreeNode[];
  knowledge_points?: KnowledgePoint[];
}

export interface KnowledgePoint {
  id: number;
  chapter_id: number;
  name: string;
  description: string;
  learning_objectives: string;
  difficulty: string;
  estimated_minutes: number;
  sort_order: number;
  status: string;
  progress_status?: 'not_started' | 'in_progress' | 'completed';
  progress_score?: number;
  resource_count?: number;
  resources?: CurriculumResource[];
}

export interface CurriculumResource {
  binding_id: number;
  knowledge_point_id: number;
  resource_type: string;
  resource_id: number;
  resource_name: string;
  resource_url: string;
  sort_order: number;
  created_at: string;
}

export interface CourseCreateRequest {
  name: string;
  code?: string;
  description?: string;
  grade?: string;
  cover_image?: string;
  sort_order?: number;
}

export interface ChapterCreateRequest {
  course_id: number;
  parent_id?: number | null;
  name: string;
  description?: string;
  sort_order?: number;
}

export interface KnowledgePointCreateRequest {
  chapter_id: number;
  name: string;
  description?: string;
  learning_objectives?: string;
  difficulty?: string;
  estimated_minutes?: number;
  sort_order?: number;
}

export interface BindingCreateRequest {
  knowledge_point_id: number;
  resource_type: string;
  resource_id: number;
  sort_order?: number;
}

export interface ProgressStats {
  course_id: number;
  course_name?: string;
  total: number;
  completed: number;
  rate: number;
}
