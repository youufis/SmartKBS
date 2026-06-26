/** 学生任务清单 API */
import apiClient from './client';

/** 待办项 */
export interface TaskTodoItem {
  id: string;
  type: 'exam' | 'task' | 'practice' | 'code' | 'curriculum'
      | 'course_practice' | 'quiz' | 'poll' | 'discussion'
      | 'whiteboard' | 'quick_quiz' | 'quest' | 'wrong_book'
      | 'question_waiting' | 'question_can_answer' | 'notification';
  title: string;
  description: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed' | 'overdue';
  priority: number;
  deadline: string | null;
  url: string;
  action_label: string;
  meta: Record<string, any>;
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
}

/** 获取学生任务清单 */
export async function getTaskTodo(): Promise<TaskTodoResponse> {
  const { data } = await apiClient.get('/api/dashboard/task-todo');
  return data;
}
