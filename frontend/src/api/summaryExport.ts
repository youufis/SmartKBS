/**
 * 跨活动成绩汇总导出 API
 * 后端: backend/api/export_router.py  /api/export/summary/*
 * 下拉数据级联: meta(年级/类型/教师) → classes(按年级) → students(按年级+班级)
 */
import apiClient from './client'

export type ActivityKind = 'score' | 'participation' | 'points'

export interface SummaryTypeMeta { key: string; label: string; kind: ActivityKind }
export interface StudentLite { username: string; name: string; grade: string; class_name: string }

export interface SummaryMeta {
  is_admin: boolean
  grades: string[]
  activity_types: SummaryTypeMeta[]
  teachers?: { username: string; name: string }[]
}

export interface StudentListResult {
  total: number
  truncated: boolean
  students: StudentLite[]
}

export interface SummaryRecord {
  type: string
  type_label: string
  kind: ActivityKind
  activity_id: number | string | null
  activity_title: string
  creator_name: string
  username: string
  student_name: string
  grade: string
  class_name: string
  score: number | null
  total_score: number | null
  rate: number | null
  status: string
  time: string
}

export interface StudentAggRow {
  username: string
  name: string
  grade: string
  class_name: string
  types: Record<string, { count?: number; avg_rate?: number | null; max_rate?: number | null; points?: number | null }>
  total_done: number
  overall_avg_rate: number | null
  points: number | null
}

export interface ActivityAggRow {
  type: string
  type_label: string
  kind: ActivityKind
  activity_id: number | string | null
  activity_title: string
  creator_name: string
  expected: number
  participants: number
  participation_rate: number | null
  avg_rate: number | null
  max_rate: number | null
  min_rate: number | null
  pass_rate: number | null
  last_time: string
}

export interface ClassAggRow {
  grade: string
  class_name: string
  students: number
  types: Record<string, { count?: number; avg_rate?: number | null }>
  total_done: number
  overall_avg_rate: number | null
  points_total: number | null
}

export interface SummaryPreview {
  types: Record<string, SummaryTypeMeta>
  population_size: number
  total_records: number
  preview_limit: number
  records: SummaryRecord[]
  by_student: StudentAggRow[]
  by_activity: ActivityAggRow[]
  by_class: ClassAggRow[]
}

export interface SummaryFilters {
  grade?: string
  cls?: string
  usernames?: string
  types?: string
  start?: string
  end?: string
  teacher?: string
}

function toParams(f: SummaryFilters): Record<string, string> {
  const p: Record<string, string> = {}
  Object.entries(f).forEach(([k, v]) => {
    if (v !== undefined && v !== null && String(v) !== '') p[k] = String(v)
  })
  return p
}

/** 提取后端 HTTPException.detail 作为提示文案 */
export function extractErrorDetail(err: unknown): string {
  const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
  return typeof detail === 'string' && detail ? detail : String(err)
}

export async function fetchSummaryMeta(): Promise<SummaryMeta> {
  const { data } = await apiClient.get<SummaryMeta>('/api/export/summary/meta')
  return data
}

/** 指定年级下当前用户可见的班级 (管理员=全部, 教师=任教班级) */
export async function fetchSummaryClasses(grade: string): Promise<string[]> {
  const { data } = await apiClient.get<{ grade: string; classes: string[] }>(
    '/api/export/summary/classes', { params: { grade } },
  )
  return Array.isArray(data.classes) ? data.classes : []
}

/** 指定年级/班级下当前用户可见的学生 (按权限收口, 有返回上限) */
export async function fetchSummaryStudents(grade: string, cls: string): Promise<StudentListResult> {
  const params: Record<string, string> = {}
  if (grade) params.grade = grade
  if (cls) params.cls = cls
  const { data } = await apiClient.get<StudentListResult>('/api/export/summary/students', { params })
  return { total: data.total || 0, truncated: !!data.truncated, students: data.students || [] }
}

export async function fetchSummaryPreview(f: SummaryFilters): Promise<SummaryPreview> {
  const { data } = await apiClient.get<SummaryPreview>('/api/export/summary/preview', {
    params: toParams(f),
    timeout: 120000,
  })
  return data
}

/** 下载链接 (浏览器直接打开, 走 cookie 鉴权, 与现有导出页一致) */
export function summaryDownloadUrl(kind: 'excel' | 'csv', f: SummaryFilters, sheet?: string): string {
  const p = new URLSearchParams(toParams(f))
  if (kind === 'csv' && sheet) p.set('sheet', sheet)
  const qs = p.toString()
  return `/api/export/summary/${kind}${qs ? `?${qs}` : ''}`
}