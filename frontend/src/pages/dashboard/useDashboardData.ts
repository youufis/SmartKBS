/** 首页看板共享数据：概览 + 最近动态 + 公告 */
import { useEffect, useState } from 'react'
import apiClient from '../../api/client'
import * as notificationsApi from '../../api/notifications'
import type { AnnouncementItem } from '../../api/notifications'
import { getSummary, type ActivityItem, type DashboardSummary } from '../../api/dashboard'

export function useDashboardData() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [activities, setActivities] = useState<ActivityItem[]>([])
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([])
  const [loading, setLoading] = useState(true)
  const [activityLoading, setActivityLoading] = useState(true)
  const [activityError, setActivityError] = useState(false)

  const fetchActivities = async () => {
    setActivityLoading(true)
    try {
      const { data } = await apiClient.get('/api/dashboard/recent-activity')
      setActivities(Array.isArray(data) ? data : [])
      setActivityError(false)
    } catch {
      setActivityError(true)
    }
    setActivityLoading(false)
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [sumRes, actRes] = await Promise.all([
          getSummary(),
          apiClient.get('/api/dashboard/recent-activity').catch(() => ({ data: null })),
        ])
        if (cancelled) return
        setSummary(sumRes)
        if (actRes.data === null) {
          setActivityError(true)
          setActivities([])
        } else {
          setActivityError(false)
          setActivities(Array.isArray(actRes.data) ? actRes.data : [])
        }
      } catch {
        /* summary 失败时保持 null，由页面渲染错误态 */
      }
      if (!cancelled) {
        setLoading(false)
        setActivityLoading(false)
      }
    })()
    notificationsApi.getAnnouncements(1, 5).then((data) => {
      if (!cancelled) setAnnouncements(data.announcements || [])
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  return { summary, activities, announcements, loading, activityLoading, activityError, fetchActivities }
}
