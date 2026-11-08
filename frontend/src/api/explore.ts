/** 探索画布 API（师生个人无限画布；后端 backend/api/personal_canvas_router.py） */
import apiClient from './client'

export interface ExploreCanvasMeta {
  id: number
  title: string
  preset_key: string
  subject_tag?: string
  cover?: number | null
  updated_at: string
  page_count?: number
  hit_page?: number | null
}

export interface ExplorePageMeta {
  page_number: number
  title: string
  updated_at: string
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'offline'

export async function listCanvases(q = ''): Promise<ExploreCanvasMeta[]> {
  const { data } = await apiClient.get('/api/explore/canvases', { params: q ? { q } : {} })
  return data.canvases as ExploreCanvasMeta[]
}

export async function listTrash(): Promise<ExploreCanvasMeta[]> {
  const { data } = await apiClient.get('/api/explore/canvases/trash')
  return data.canvases as ExploreCanvasMeta[]
}

export async function createCanvas(title: string, presetKey = 'blank'): Promise<{ id: number; title: string }> {
  const { data } = await apiClient.post('/api/explore/canvases', { title, preset_key: presetKey })
  return data
}

export async function transcribeAudio(blob: Blob): Promise<{ text: string }> {
  const form = new FormData()
  form.append('file', blob, 'voice.webm')
  const { data } = await apiClient.post('/api/explore/ai/transcribe', form,
    { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 90000 })
  return data
}

export async function renameCanvas(id: number, title: string) {
  await apiClient.patch('/api/explore/canvases/' + id, { title })
}

export async function archiveCanvas(id: number) {
  await apiClient.delete('/api/explore/canvases/' + id)
}

export async function restoreCanvas(id: number) {
  await apiClient.post('/api/explore/canvases/' + id + '/restore')
}

export async function getCanvas(id: number): Promise<{ canvas: { id: number; title: string; preset_key: string }; pages: ExplorePageMeta[] }> {
  const { data } = await apiClient.get('/api/explore/canvases/' + id)
  return data
}

export async function getPage(id: number, page: number): Promise<{ snapshot_data: string; title: string; updated_at: string }> {
  const { data } = await apiClient.get('/api/explore/canvases/' + id + '/pages/' + page)
  return data
}

export async function savePage(id: number, page: number, snapshotData: string, title?: string) {
  const { data } = await apiClient.put('/api/explore/canvases/' + id + '/pages/' + page,
    { snapshot_data: snapshotData, title: title ?? null })
  return data as { ok: boolean; updated_at: string }
}

export async function addPage(id: number): Promise<{ page_number: number; title: string }> {
  const { data } = await apiClient.post('/api/explore/canvases/' + id + '/pages')
  return data
}

export async function deletePage(id: number, page: number) {
  await apiClient.delete('/api/explore/canvases/' + id + '/pages/' + page)
}

export async function uploadAsset(id: number, file: File): Promise<{ src: string; filename: string; bytes: number }> {
  const form = new FormData()
  form.append('file', file)
  const { data } = await apiClient.post('/api/explore/canvases/' + id + '/assets', form,
    { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 60000 })
  return data
}
// ═══ AI 链路（T4~T6）：问答流式 / 生图任务 / 朗读 / 用量 ═══

export interface AskHistoryItem { role: 'user' | 'assistant'; content: string }

export interface AskOptions {
  canvasId?: number
  selectionText?: string
  pageImage?: string
  history?: AskHistoryItem[]
  signal?: AbortSignal
  onReferences?: (items: KbRefItem[]) => void
}

/** 探索画布问答（SSE；delta 为累计全文，直接替换渲染——与白板同一口径） */
export async function askExplore(
  prompt: string,
  onDelta: (full: string) => void,
  onError: (msg: string) => void,
  options: AskOptions = {},
): Promise<void> {
  const token = localStorage.getItem('smartkb_token')
  try {
    const response = await fetch('/api/explore/ai/ask-stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: JSON.stringify({
        prompt,
        canvas_id: options.canvasId || null,
        selection_text: options.selectionText || '',
        page_image: options.pageImage || '',
        history: options.history || [],
      }),
      signal: options.signal,
    })
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}))
      onError((errData as any).detail || 'HTTP ' + response.status)
      return
    }
    const reader = response.body?.getReader()
    if (!reader) { onError('无法读取响应流'); return }
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        try {
          const d = JSON.parse(line.slice(6))
          if (d.type === 'delta') onDelta(d.content || '')
          else if (d.type === 'references') options.onReferences?.(d.items || [])
          else if (d.type === 'error') { onError(d.content || 'AI 响应失败'); return }
        } catch { /* skip */ }
      }
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') return
    onError(e?.message || '网络异常，请稍后再试')
  }
}

export interface GenResult {
  mode?: 'svg' | 'image' | 'error'
  svg?: string
  width?: number
  height?: number
  title?: string
  image_url?: string
  error?: string
}

export async function submitGenerate(description: string, subject = '', canvasId?: number): Promise<{ task_id: string }> {
  const { data } = await apiClient.post('/api/explore/ai/generate',
    { description, subject, canvas_id: canvasId || null })
  return data
}

export async function pollGenerate(taskId: string, maxWait = 180000): Promise<GenResult> {
  const start = Date.now()
  while (Date.now() - start < maxWait) {
    try {
      const { data } = await apiClient.get('/api/explore/ai/tasks/' + taskId)
      if (data.status === 'completed') return (data.result || { mode: 'error', error: '空结果' }) as GenResult
      if (data.status === 'failed') return { mode: 'error', error: data.error || '生成失败' }
    } catch (e: any) {
      const s = e?.response?.status
      if (s === 403 || s === 404) return { mode: 'error', error: '任务不可用' }
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return { mode: 'error', error: '还在生成中，稍后回来画布上会看到它' }
}

export async function speak(text: string): Promise<{ urls: string[]; partial?: boolean }> {
  const { data } = await apiClient.post('/api/explore/ai/speech', { text })
  return data
}

export interface QuotaItem { used: number; limit: number }
export interface QuotaMap { chat: QuotaItem; image: QuotaItem; tts: QuotaItem; points?: { used: number; cap: number } }

export interface ArchiveResult { ok: boolean; title: string; points: number; badges: { name: string; icon: string }[] }

/** 一键把本页存入成长档案（服务端记作品 + 发弱积分 + 触发徽章） */
export async function archivePortfolio(
  canvasId: number, page: number, payload: { image_src: string; title?: string; summary?: string },
): Promise<ArchiveResult> {
  const { data } = await apiClient.post(
    '/api/explore/canvases/' + canvasId + '/pages/' + page + '/archive-portfolio', payload)
  return data
}

export interface ArchiveItem { id: number; canvas_id: number; title: string; canvas_title: string; page_number: number; image_src: string; created_at: string }

export async function listArchives(): Promise<ArchiveItem[]> {
  const { data } = await apiClient.get('/api/explore/archives')
  return data.archives
}

export async function getQuota(): Promise<QuotaMap> {
  const { data } = await apiClient.get('/api/explore/quota')
  return data
}

// ═══ M1：教材引用 / 导图与星图 / 时间线 ═══

export interface KbRefItem { doc_name: string; title?: string; score?: number }

export interface ShapeSpec { type: string; x: number; y: number; props: Record<string, unknown> }

export interface StructResult {
  mode?: 'shapes' | 'error'
  kind?: string
  title?: string
  shapes?: ShapeSpec[]
  intro?: string
  followups?: string[]
  error?: string
}

export async function submitMindmap(topic: string, subject = '', canvasId?: number): Promise<{ task_id: string }> {
  const { data } = await apiClient.post('/api/explore/ai/mindmap', { topic, subject, canvas_id: canvasId || null })
  return data
}

export async function submitTopicCard(topic: string, subject = '', canvasId?: number): Promise<{ task_id: string }> {
  const { data } = await apiClient.post('/api/explore/ai/topic-card', { topic, subject, canvas_id: canvasId || null })
  return data
}

/** 通用任务轮询（导图/星图的结构化结果） */
export async function pollStruct(taskId: string, maxWait = 180000): Promise<StructResult> {
  const start = Date.now()
  while (Date.now() - start < maxWait) {
    try {
      const { data } = await apiClient.get('/api/explore/ai/tasks/' + taskId)
      if (data.status === 'completed') return (data.result || { mode: 'error', error: '空结果' }) as StructResult
      if (data.status === 'failed') return { mode: 'error', error: data.error || '生成失败' }
    } catch (e: any) {
      const s = e?.response?.status
      if (s === 403 || s === 404) return { mode: 'error', error: '任务不可用' }
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return { mode: 'error', error: '还在生成中，稍后回画布查看' }
}

export async function archivePage(canvasId: number, page: number, snapshotData: string): Promise<{ ok: boolean; saved_at: string }> {
  const { data } = await apiClient.post('/api/explore/canvases/' + canvasId + '/pages/' + page + '/archive',
    { snapshot_data: snapshotData })
  return data
}

export interface HistoryItem { id: number; saved_at: string; bytes: number }

export async function pageHistory(canvasId: number, page: number): Promise<HistoryItem[]> {
  const { data } = await apiClient.get('/api/explore/canvases/' + canvasId + '/pages/' + page + '/history')
  return data.items as HistoryItem[]
}

export async function restoreHistory(canvasId: number, page: number, historyId: number): Promise<string> {
  const { data } = await apiClient.post(
    '/api/explore/canvases/' + canvasId + '/pages/' + page + '/history/' + historyId + '/restore')
  return data.snapshot_data as string
}

/** 时间线回滚后需立刻把内容写回服务端（restore 接口只回传快照，不直接落库） */
export async function saveSnapshotNow(canvasId: number, page: number, snapshotData: string) {
  await savePage(canvasId, page, snapshotData)
}


export interface UsageStudentRow {
  username: string; name: string; grade: string; class: string
  asks: number; topics: number; svgs: number; minds: number; images: number; tts: number
  archives: number; points: number; badges: number; canvases: number; pages: number
  active_days: number; last_active: string
}
export interface UsageStatsData {
  summary: { students: number; active_recent: number; asks_total: number; archives_total: number; scope: string; days: number }
  trend: { date: string; active: number; asks: number; archives: number }[]
  students: UsageStudentRow[]
}
export async function usageStats(days = 14): Promise<UsageStatsData> {
  const { data } = await apiClient.get('/api/explore/usage/stats', { params: { days } })
  return data
}

// ═══ 关怀提醒台账（管理员；只给"谁/几次/何时"，后端从不返回提问原文）═══
export interface CareStudentRow {
  username: string; name: string; grade: string; class: string
  count: number; flag_count: number; first_at: string; last_at: string
}
export interface CareEventsData {
  since: string; days: number; total: number; students: CareStudentRow[]
}
export async function careEvents(days = 14): Promise<CareEventsData> {
  const { data } = await apiClient.get('/api/explore/care/events', { params: { days } })
  return data
}


// ═══ M2 分享与模板（后端 personal_canvas_router /shares /templates）═══
export interface ShareMeta {
  id: number
  owner_username: string
  owner_name: string
  grade: string
  class: number | string
  title: string
  canvas_id: number
  page_number: number
  image_src: string
  view_count: number
  created_at: string
  expires_at: string
  expired: boolean
  mine: boolean
}

export interface ShareDetail {
  id: number
  owner_username: string
  owner_name: string
  title: string
  canvas_id: number
  page_number: number
  image_src: string
  view_count: number
  created_at: string
  expires_at: string
  snapshot_json: string
}

export interface TemplateMeta {
  id: number
  publisher_username: string
  publisher_name: string
  title: string
  description: string
  image_src: string
  use_count: number
  created_at: string
  mine: boolean
}

export async function createShare(payload: { canvas_id: number; page_number: number; title?: string; image_src?: string })
  : Promise<{ id: number; title: string; expires_at: string }> {
  const { data } = await apiClient.post('/api/explore/shares', payload)
  return data
}

export async function listShares(): Promise<ShareMeta[]> {
  const { data } = await apiClient.get('/api/explore/shares')
  return data.shares as ShareMeta[]
}

export async function getShare(id: number): Promise<ShareDetail> {
  const { data } = await apiClient.get('/api/explore/shares/' + id)
  return data
}

export async function revokeShare(id: number) {
  await apiClient.delete('/api/explore/shares/' + id)
}

export async function publishTemplate(payload: { canvas_id: number; page_number: number; title: string; description?: string; image_src?: string })
  : Promise<{ id: number; title: string }> {
  const { data } = await apiClient.post('/api/explore/templates', payload)
  return data
}

export async function listTemplates(): Promise<TemplateMeta[]> {
  const { data } = await apiClient.get('/api/explore/templates')
  return data.templates as TemplateMeta[]
}

export async function applyTemplate(id: number): Promise<{ canvas_id: number }> {
  const { data } = await apiClient.post('/api/explore/templates/' + id + '/use')
  return data
}

export async function deleteTemplate(id: number) {
  await apiClient.delete('/api/explore/templates/' + id)
}
