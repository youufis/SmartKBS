/**
 * useSubjectOptions — 统一获取学科列表的 Hook
 * 从系统配置加载学科列表，失败时返回默认值
 */
import { useState, useEffect } from 'react'
import apiClient from '../api/client'

const DEFAULT_SUBJECTS: string[] = []

export function useSubjectOptions(): {
  subjects: string[]
  /**
   * 默认学科：后端按"这个人教什么"算（任教学科优先，其次系统学科列表首位）。
   *
   * 各新建表单以前各自抓 subjects[0]，于是"谁排在学科列表第一位"这个偶然事实
   * 决定了 AI 出题、题库导入、作业、测验把内容落到哪门学科。课程中心开放学科
   * 拖动排序后，首位的含义变成"管理员希望谁先出现"，两者必须分开。
   */
  defaultSubject: string
  loading: boolean
} {
  const [subjects, setSubjects] = useState<string[]>(DEFAULT_SUBJECTS)
  const [defaultSubject, setDefaultSubject] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    apiClient.get('/api/config/subjects')
      .then(({ data }) => {
        if (cancelled) return
        if (data?.subjects?.length > 0) {
          setSubjects(data.subjects)
          setDefaultSubject(data.default || data.subjects[0])
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

  return { subjects, defaultSubject, loading }
}

export default useSubjectOptions
