/** 资源查看追踪 API */
import apiClient from './client';

export interface ViewLogRequest {
  resource_type: string;
  resource_id: number;
  knowledge_point_id?: number | null;
  binding_id?: number | null;
  source: 'curriculum' | 'sharing' | 'direct';
  file_path: string;
  owner_username?: string;
}

/** 记录资源查看事件（学生点击资源时调用） */
export async function logResourceView(body: ViewLogRequest): Promise<void> {
  try {
    await apiClient.post('/api/tracking/resource-view', body);
  } catch {
    // 静默失败，不影响用户体验
  }
}

export interface ViewStats {
  total_views: number;
  unique_viewers: number;
  last_view: { student_username: string; viewed_at: string } | null;
}

export interface ResourceViewStudent {
  student_username: string;
  student_name: string;
  view_count: number;
  last_viewed: string;
}

export interface KpResourceView {
  binding_id: number;
  resource_type: string;
  resource_id: number;
  resource_name: string;
  total_views: number;
  unique_viewers: number;
  last_view: { student_username: string; viewed_at: string } | null;
}

/** 获取单个资源的查看统计 */
export async function getResourceViewStats(
  resourceType: string,
  resourceId: number,
): Promise<ViewStats> {
  const { data } = await apiClient.get('/api/tracking/resource-view-stats', {
    params: { resource_type: resourceType, resource_id: resourceId },
  });
  return data;
}

/** 获取查看过某资源的学生列表 */
export async function getResourceViewStudents(
  resourceType: string,
  resourceId: number,
): Promise<{ students: ResourceViewStudent[]; total: number }> {
  const { data } = await apiClient.get('/api/tracking/resource-view-students', {
    params: { resource_type: resourceType, resource_id: resourceId },
  });
  return data;
}

/** 聚合获取全部共享资源的浏览统计（教师端，一次请求；已排除共享给自己的资源） */
export async function getAllResourceViewStats(): Promise<{
  resources: {
    id: number;
    resource_name: string;
    resource_type: string;
    owner: string;
    total_views: number;
    unique_viewers: number;
    last_view_time: string;
    last_view_student: string;
  }[];
  total: number;
}> {
  const { data } = await apiClient.get('/api/tracking/resource-view-stats/all');
  return data;
}

/** 获取知识点下所有资源的浏览统计（教师端） */
export async function getKpViewStats(
  kpId: number,
): Promise<{ resources: KpResourceView[]; total: number }> {
  const { data } = await apiClient.get(`/api/tracking/kp-view-stats/${kpId}`);
  return data;
}

/** 获取知识点下学生浏览明细（教师端） */
export async function getKpStudentViews(
  kpId: number,
): Promise<{ students: any[]; total: number }> {
  const { data } = await apiClient.get(`/api/tracking/kp-student-views/${kpId}`);
  return data;
}

/** 获取资源浏览仪表盘数据 */
export async function getResourceViewDashboard(params: {
  grade?: string;
  class_name?: string;
  days?: number;
}): Promise<{ active_students: number; total_views: number; viewed_resources: number }> {
  const { data } = await apiClient.get('/api/tracking/resource-view-dashboard', { params });
  return data;
}

/** 获取当前学生自己的资源浏览统计 */
export async function getMyViewStats(): Promise<{
  total_views: number;
  unique_html: number;
  unique_download: number;
  total_reward_points: number;
}> {
  const { data } = await apiClient.get('/api/tracking/my-view-stats');
  return data;
}
