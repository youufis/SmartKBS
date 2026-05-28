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
  title: string
  content: string
  target_role: string
  target_grade: string
  target_class: string
  priority: string
  is_pinned: boolean
  created_at: string
  updated_at: string
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
  await apiClient.put(`/api/notifications/${id}/read`)
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
export async function getAnnouncements(page = 1, pageSize = 20): Promise<{ announcements: AnnouncementItem[]; total: number }> {
  const { data } = await apiClient.get('/api/notifications/announcements', {
    params: { page, page_size: pageSize },
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
