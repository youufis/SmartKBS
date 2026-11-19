/** 教学简报 API */
import apiClient from './client'

export interface BriefingSection {
  key: string
  title: string
  severity?: 'info' | 'warning' | 'good'
  narrative?: string
  bullets?: string[]
  charts?: { type: string; title: string; data: { name: string; value: number | null }[] }[]
  tables?: { title: string; columns: string[]; rows: (string | number)[][] }[]
  actions?: { text: string; basis: string }[]
}

export interface BriefingPeriod {
  type: string
  key: string
  start: string
  end: string
  start_date: string
  end_date: string
  label: string
  custom?: boolean
  year_mode?: string
}

export interface BriefingPraiseStudent {
  username?: string
  title: string
  group?: string
  name: string
  class: string
  reason: string
}

export interface BriefingPraiseClass {
  title: string
  name: string
  reason: string
}

export interface BriefingMetrics {
  period?: { key: string; label: string }
  scope?: { total_students: number; filter_label: string; classes: string[] }
  activity?: { total: number; by_type: Record<string, number> }
  learning?: {
    samples: number; avg_rate: number | null; pass_rate: number | null
    excellent_rate: number | null; delta: number | null; enough_sample: boolean
    by_source?: Record<string, { samples: number; avg_rate: number | null }>
  }
  participation?: { participants: number; rate: number | null; silent_count: number }
  tasks?: { assigned: number; submit_rate: number | null; pending_grading: number }
  growth?: { available: boolean; points_gained: number }
  weak_points?: { kp: string; rate: number | null; total: number }[]
  praise?: {
    quota: { students: number; classes: number }
    students: BriefingPraiseStudent[]
    classes: BriefingPraiseClass[]
    vacant: { title: string; reason: string }[]
    coverage?: number | null
  }
  alerts?: { level: string; student: string; class?: string; reason: string }[]
  is_empty?: boolean
}

export interface BriefingReport {
  id: number
  snapshot_id: number
  version: number
  headline: string
  sections: BriefingSection[]
  metrics: BriefingMetrics
  period_type: string
  period_key: string
  period_start: string
  period_end: string
  filter_label: string
  status: string
  ai_model?: string
  created_at: string
  is_empty?: number
  snapshot_at?: string
}

export interface BriefingOptions {
  role: number
  grades: string[]
  classes: { grade: string; name: string; id: number }[]
  subjects: string[]
  teachers: { username: string; name: string }[]
  year_mode: string
}

export interface BriefingPreview {
  period: BriefingPeriod
  scope: {
    total_students: number
    filter_label: string
    classes: string[]
    grades: string[]
    subjects: string[]
  }
  summary: {
    activity_total: number
    samples: number
    avg_rate: number | null
    delta: number | null
    participation_rate: number | null
    silent_count: number
    pending_grading: number
    praise_count: number
    alert_count: number
  }
  is_empty: boolean
  facts?: { id: string; kind: string; text: string; value?: unknown }[]
}

export interface BriefingJob {
  id: string
  status: string
  progress: number
  stage: string
  report_id?: number | null
  error?: string
}

export interface BriefingFilter {
  period_type: string
  year_mode?: string
  anchor?: string
  start?: string
  end?: string
  teacher?: string
  grade?: string
  class?: string
  subject?: string
}

export const getOptions = (teacher = '') =>
  apiClient.get<BriefingOptions>('/api/briefing/options', {
    params: teacher ? { teacher } : undefined,
  }).then(r => r.data)

export const getLatest = (f: BriefingFilter) =>
  apiClient.get<{ exists: boolean; report?: BriefingReport; period?: BriefingPeriod; scope?: string }>(
    '/api/briefing/latest', { params: f }).then(r => r.data)

export const getPreview = (f: BriefingFilter) =>
  apiClient.get<BriefingPreview>('/api/briefing/preview', { params: f }).then(r => r.data)

export const generate = (f: BriefingFilter & { force?: boolean }) =>
  apiClient.post<{ job_id?: string; report_id?: number; existed: boolean; status: string }>(
    '/api/briefing/generate', f, { timeout: 60000 }).then(r => r.data)

export const getJob = (jobId: string) =>
  apiClient.get<BriefingJob>(`/api/briefing/jobs/${jobId}`).then(r => r.data)

export const getDetail = (id: number) =>
  apiClient.get<BriefingReport>(`/api/briefing/${id}`).then(r => r.data)

export const listReports = (params: { type?: string; page?: number; size?: number }) =>
  apiClient.get<{ total: number; page: number; items: any[] }>(
    '/api/briefing/list', { params }).then(r => r.data)

export const regenerate = (id: number) =>
  apiClient.post<{ job_id: string; status: string }>(`/api/briefing/${id}/regenerate`).then(r => r.data)

export const exportWord = (id: number) =>
  apiClient.get(`/api/briefing/${id}/export`, { responseType: 'blob', timeout: 180000 })

export interface BriefingSettings {
  owner_username: string
  auto_daily: number
  auto_weekly: number
  auto_monthly: number
  auto_yearly: number
  notify: number
  year_mode: string
}

export const getVersions = (id: number) =>
  apiClient.get<{ items: { id: number; version: number; status: string; created_at: string }[] }>(
    `/api/briefing/${id}/versions`).then(r => r.data.items)

export const getSettings = () =>
  apiClient.get<BriefingSettings>('/api/briefing/settings').then(r => r.data)

export const saveSettings = (data: Partial<BriefingSettings>) =>
  apiClient.put<BriefingSettings>('/api/briefing/settings', data).then(r => r.data)

export const deleteReport = (id: number) =>
  apiClient.delete<{ ok: boolean }>(`/api/briefing/${id}`).then(r => r.data)
