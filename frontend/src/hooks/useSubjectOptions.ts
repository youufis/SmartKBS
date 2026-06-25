/**
 * useSubjectOptions — 统一获取学科列表的 Hook
 * 从系统配置加载学科列表，失败时返回默认值
 */
import { useState, useEffect } from 'react'
import apiClient from '../api/client'

const DEFAULT_SUBJECTS: string[] = []

export function useSubjectOptions(): {
  subjects: string[]
  loading: boolean
} {
  const [subjects, setSubjects] = useState<string[]>(DEFAULT_SUBJECTS)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    apiClient.get('/api/config/subjects')
      .then(({ data }) => {
        if (cancelled) return
        if (data?.subjects?.length > 0) {
          setSubjects(data.subjects)
        }
      })
      .catch(() => {
        // 忽略错误，使用默认值
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  return { subjects, loading }
}

export default useSubjectOptions
