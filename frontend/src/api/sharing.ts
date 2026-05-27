/** 资源共享 API */
import apiClient from './client';

export interface ShareItem {
  id: number;
  owner_username: string;
  file_path: string;
  file_name: string;
  resource_type: 'html' | 'download';
  share_scope: 'all' | 'class';
  target_grade: string;
  target_class: string;
  created_at: string;
}

export interface ShareRequest {
  file_path: string;
  file_name: string;
  resource_type: 'html' | 'download';
  share_scope: 'all' | 'class';
  target_grade?: string;
  target_class?: string;
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
