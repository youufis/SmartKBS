/** 学生任务清单 API */
import apiClient from './client';

/** 待办项 */
export interface TaskTodoItem {
  id: string;
  type: 'exam' | 'task' | 'practice' | 'code' | 'curriculum'
      | 'course_practice' | 'quiz' | 'poll' | 'discussion'
      | 'whiteboard' | 'quick_quiz' | 'quest' | 'wrong_book'
      | 'question_waiting' | 'question_can_answer' | 'notification'
      | 'shared_resource' | string;
  title: string;
  description: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed' | 'overdue';
  priority: number;
  deadline: string | null;
  url: string;
  action_label: string;
  meta: Record<string, any>;
  /** 课堂即时活动：老师刚发起、现在就能参与 */
  live?: boolean;
  /** 推荐看看：非硬待办（未浏览的共享资源、可回答的同学提问） */
  suggest?: boolean;
  /** 发起教师（P2 下发）：提问/闯关/错题/通知等无单一发起者为 null，筛选归"无归属" */
  teacher?: { username: string; name: string } | null;
  /** 锚定课程（学科→课程两级，宁缺勿错：匹不上为 null） */
  course?: { id: number; name: string; subject: string } | null;
  /** 活动开始时间（live 类透出，时间线/看板次级排序用） */
  start_at?: string | null;
}

/** 已完成记录（近 30 天） */
export interface DoneRecord {
  id: string;
  type: string;
  title: string;
  detail?: string;
  score?: number | null;
  total?: number | null;
  time: string;
  url: string;
}

/** 任务清单响应 */
export interface TaskTodoResponse {
  items: TaskTodoItem[];
  counts: Record<string, number>;
  stats: {
    course_progress: number;
    completion_rate: number;
    accuracy_rate: number;
    streak_days: number;
  };
  /** 课堂进行中条目数 */
  live_count?: number;
  /** 推荐看看条目数（不计入待办分类数） */
  suggest_count?: number;
  /** 近 30 天已完成记录 */
  recent_done?: DoneRecord[];
  /** 筛选选项源：课程不依赖当前待办（没作业也选得了课）；教师=全体教职工快照 */
  facets?: {
    teachers?: { username: string; name: string }[];
    courses?: { id: number; name: string; subject: string }[];
  };
}

/** 获取学生任务清单 */
export async function getTaskTodo(): Promise<TaskTodoResponse> {
  const { data } = await apiClient.get('/api/dashboard/task-todo');
  return data;
}
