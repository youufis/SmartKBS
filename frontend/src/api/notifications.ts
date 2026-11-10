/** 通知公告 API */
import apiClient from './client'

export interface NotificationItem {
  id: number
  type: string
  title: string
  content: string
  related_link: string
  is_read: boolean
  created_at: string
  /** 可选的结构化文案标识，见 utils/notificationText */
  payload?: string
}

export interface NotificationListResponse {
  notifications: NotificationItem[]
  total: number
  page: number
  page_size: number
}

export interface AnnouncementItem {
  id: number
  creator_username: string
  creator_name?: string
  title: string
  content: string
  target_role: string
  target_grade: string
  target_class: string
  priority: string
  is_pinned: boolean
  created_at: string
  updated_at: string
  read_count?: number
}

/** 获取通知列表 */
export async function getNotifications(unreadOnly = false, page = 1, pageSize = 20): Promise<NotificationListResponse> {
  const { data } = await apiClient.get('/api/notifications', {
    params: { unread_only: unreadOnly, page, page_size: pageSize },
  })
  return data
}

/** 获取未读通知数 */
export async function getUnreadCount(): Promise<number> {
  const { data } = await apiClient.get('/api/notifications/unread-count')
  return data.unread_count
}

/** 标记通知为已读 */
export async function markAsRead(id: number): Promise<void> {
  const resp = await apiClient.put(`/api/notifications/${id}/read`)
  console.log(`[markAsRead] id=${id}, status=${resp.status}, data=`, resp.data)
}

/** 标记所有通知为已读 */
export async function markAllAsRead(): Promise<void> {
  await apiClient.put('/api/notifications/read-all')
}

/** 删除通知 */
export async function deleteNotification(id: number): Promise<void> {
  await apiClient.delete(`/api/notifications/${id}`)
}

/** 获取公告列表 */

/** 批量删除通知 */
export async function batchDeleteNotifications(ids: number[]): Promise<void> {
  await apiClient.post('/api/notifications/batch-delete', { ids })
}


export async function getAnnouncements(page = 1, pageSize = 20, keyword = '', priority = ''): Promise<{ announcements: AnnouncementItem[]; total: number }> {
  const { data } = await apiClient.get('/api/notifications/announcements', {
    params: { page, page_size: pageSize, keyword, priority },
  })
  return data
}

/** 发布公告 */
export async function createAnnouncement(announcement: {
  title: string
  content: string
  target_role?: string
  target_grade?: string
  target_class?: string
  target_scope?: string
  target_users?: string
  priority?: string
  is_pinned?: boolean
}): Promise<{ message: string; announcement_id: number }> {
  const { data } = await apiClient.post('/api/notifications/announcements', announcement)
  return data
}

/** 删除公告 */
export async function deleteAnnouncement(id: number): Promise<void> {
  await apiClient.delete(`/api/notifications/announcements/${id}`)
}

/** 批量删除公告 */
export async function batchDeleteAnnouncements(ids: number[]): Promise<{ message: string; deleted: number }> {
  const { data } = await apiClient.post('/api/notifications/announcements/batch-delete', { ids })
  return data
}

/** 标记公告已读 */
export async function markAnnouncementRead(id: number): Promise<void> {
  await apiClient.post(`/api/notifications/announcements/${id}/read`)
}

/** 获取公告已读名单 */
export async function getAnnouncementReadUsers(id: number): Promise<{ read_count: number; read_users: Array<{ username: string; name: string; read_at: string }> }> {
  const { data } = await apiClient.get(`/api/notifications/announcements/${id}/read-users`)
  return data
}

export async function updateAnnouncement(id: number, data: Record<string, unknown>): Promise<void> {
  await apiClient.put(`/api/notifications/announcements/${id}`, data)
}
