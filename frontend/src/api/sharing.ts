/** 资源共享 API */
import apiClient from './client';

export interface ShareItem {
  id: number;
  owner_username: string;
  file_path: string;
  file_name: string;
  resource_type: 'html' | 'download';
  share_scope: 'all' | 'teacher' | 'staff' | 'class';
  target_users: string;
  target_grade: string;
  target_class: string;
  created_at: string;
  url_path?: string;
  /** 共享者真实姓名（后端 join users 得到，缺省回退账号） */
  owner_name?: string;
  /** 共享者角色：0 管理员 / 1 教师 / 2 学生 */
  owner_role?: number | null;
  /** 当前用户最近一次查看时间，null = 未看 */
  viewed_at?: string | null;
  /** 该资源被查看总次数 */
  view_count?: number;
  /** 绑定的课程名（取第一个绑定） */
  course_name?: string;
  /** 绑定的知识点名（取第一个绑定） */
  kp_name?: string;
  /** 绑定知识点数量 */
  binding_count?: number;
}

export interface ShareRequest {
  file_path: string;
  file_name: string;
  resource_type: 'html' | 'download';
  share_scope: 'all' | 'teacher' | 'staff' | 'class';
  target_users?: string[];
  target_grades?: string[];
  target_classes?: string[];
  /** 'replace' 覆盖 / 'append' 追加 / 'remove' 移除 */
  mode?: 'replace' | 'append' | 'remove';
}

export interface UserItem {
  username: string;
  name: string;
  role: string;
  grade: string;
  class: string;
}

/** 共享一个资源 */
export async function shareResource(body: ShareRequest): Promise<{ message: string }> {
  const { data } = await apiClient.post('/api/sharing/share', body);
  return data;
}

/** 取消共享 */
export async function unshareResource(id: number): Promise<{ message: string }> {
  const { data } = await apiClient.delete('/api/sharing/share', { params: { id } });
  return data;
}

/** 获取我创建的共享 */
export async function getMyShares(): Promise<{ shares: ShareItem[] }> {
  const { data } = await apiClient.get('/api/sharing/my-shares');
  return data;
}

/** 获取共享给我的资源 */
export async function getReceivedShares(): Promise<{ shares: ShareItem[] }> {
  const { data } = await apiClient.get('/api/sharing/received');
  return data;
}
