/** 首页看板共享数据：概览 + 最近动态 + 公告
 * 新鲜度：mount 首载 + focus/回到可见/可见期轮询重验（stale-while-revalidate，旧值先展示）；
 * 失败态由页面渲染重试入口（refresh 在无数据时回骨架）。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import apiClient from '../../api/client'
import * as notificationsApi from '../../api/notifications'
import type { AnnouncementItem } from '../../api/notifications'
import { getSummary, type ActivityItem, type DashboardSummary } from '../../api/dashboard'
import { useAutoRefresh } from './useAutoRefresh'

export function useDashboardData() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [activities, setActivities] = useState<ActivityItem[]>([])
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([])
  const [loading, setLoading] = useState(true)
  const [activityLoading, setActivityLoading] = useState(true)
  const [activityError, setActivityError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const hasDataRef = useRef(false)
  hasDataRef.current = summary !== null

  const load = useCallback(async (silent: boolean) => {
    if (silent) setRefreshing(true)
    else { setLoading(true); setActivityLoading(true) }
    try {
      const [sumRes, actRes] = await Promise.all([
        getSummary(),
        apiClient.get('/api/dashboard/recent-activity').catch(() => ({ data: null })),
      ])
      setSummary(sumRes)
      setUpdatedAt(Date.now())
      if (actRes.data === null) {
        setActivityError(true)
        setActivities([])
      } else {
        setActivityError(false)
        setActivities(Array.isArray(actRes.data) ? actRes.data : [])
      }
    } catch {
      /* summary 失败时保持 null，由页面渲染错误态（带重试） */
    }
    setLoading(false)
    setActivityLoading(false)
    setRefreshing(false)
    notificationsApi.getAnnouncements(1, 5).then((data) => {
      setAnnouncements(data.announcements || [])
    }).catch(() => {})
  }, [])

  const fetchActivities = useCallback(async () => {
    setActivityLoading(true)
    try {
      const { data } = await apiClient.get('/api/dashboard/recent-activity')
      setActivities(Array.isArray(data) ? data : [])
      setActivityError(false)
    } catch {
      setActivityError(true)
    }
    setActivityLoading(false)
  }, [])

  useEffect(() => { load(false) }, [load])
  useAutoRefresh(useCallback(() => { load(true) }, [load]))

  /** 手动刷新/失败重试：无数据回骨架，有数据静默更新不闪骨架 */
  const refresh = useCallback(() => { load(!hasDataRef.current) }, [load])

  return {
    summary, activities, announcements, loading, activityLoading, activityError,
    fetchActivities, refresh, refreshing, updatedAt,
  }
}
