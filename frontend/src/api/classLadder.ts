/**
 * 课堂闯关（大屏版）API
 *
 * 后端：backend/api/class_ladder_router.py（/api/class-ladder）
 * 规则与学生端「知识闯关」同口径；抽人/出题/计分复用课堂抽问与题库链路。
 */
import apiClient from './client'

export interface LadderLevel {
  level: number
  score: number
  difficulty: string
  safe: boolean
}

export interface LadderLifeline {
  type: string
  name: string
  discount: number
}



export interface LadderSkin {
  value: string
  label: string
  light: boolean
}

export interface LadderConfig {
  ai_enabled: boolean
  default_skin: string
  skins: LadderSkin[]
  default_lifelines: string[]
  max_lifelines: number
  sound_enabled: boolean
  ladder: LadderLevel[]
  full_score: number
  max_levels: number
  safe_levels: number[]
  lifelines: LadderLifeline[]
  question_types: { value: string; label: string }[]
  time_limits: number[]
  default_time_limit: number
  default_pool_size: number
}


export interface LadderPool {
  total: number
  bank: number
  ai: number
  by_level: Record<string, number>
}

export interface LadderSession {
  session_id: number
  grade: string
  class: string
  subject: string
  topic: string
  ai_enabled: boolean
  question_type: string
  time_limit_sec: number
  pool_size: number
  safe_mode: number
  skin: string
  lifelines: string[]
  status: string
  total_students: number
  pool: LadderPool
  note: string
  created_at: string
}

export interface LadderQuestion {
  level: number
  question_id: number | null
  type: string
  question: string
  options: string[]
  source: string
  svg_content?: string
  has_svg?: number
  media_files?: unknown
  media_placeholders?: unknown
  score: number
  difficulty: string
  lifelines: string[]
}

export interface LadderAnswer {
  level: number
  selected: string
  correct_answer: string
  correct: boolean
  score: number
  lifeline: string[]
  time_spent: number
  timeout?: boolean
  question_id?: number | null
}

export interface LadderRun {
  run_id: number
  session_id: number
  student: string
  status: 'playing' | 'win' | 'lost' | 'timeout' | string
  reached_level: number
  correct_count: number
  ladder_score: number
  points_awarded: number
  lifelines_used: string[]
  current_level: number
  time_limit_sec: number
  answered: LadderAnswer[]
  question?: LadderQuestion
}

export interface LadderBoardRow {
  id: number
  student_name: string
  status: string
  reached_level: number
  correct_count: number
  ladder_score: number
  created_at: string
}

export interface LadderResultItem {
  level: number
  correct: boolean
  selected: string
  correct_answer: string
  score: number
  lifeline: string[]
  question: string
  options: string[]
  explanation: string
  source: string
  svg_content?: string
  has_svg?: number
  media_files?: unknown
  media_placeholders?: unknown
}

export async function getLadderConfig(): Promise<LadderConfig> {
  const { data } = await apiClient.get('/api/class-ladder/config')
  return data
}


export async function openLadderSession(payload: {
  lifelines?: string[]
  grade: string
  class: string
  subject?: string
  topic?: string
  theme_id?: number
  allow_ai?: boolean
  question_type?: string
  time_limit_sec?: number
  pool_size?: number
  safe_mode?: number
  skin?: string
}): Promise<LadderSession> {
  const { data } = await apiClient.post('/api/class-ladder/session', payload)
  return data
}

export async function getLadderSession(
  grade: string, cls: string,
): Promise<{ session: LadderSession | null }> {
  const { data } = await apiClient.get('/api/class-ladder/session', { params: { grade, class: cls } })
  return data
}

export async function buildPool(
  grade: string, cls: string,
): Promise<{ added: number; notes: string[]; session: LadderSession }> {
  // 题库秒回；AI 补题可能需要一会儿，给足 3 分钟（后端 AI 超时另外兜底）
  const { data } = await apiClient.post('/api/class-ladder/session/pool',
    { grade, class: cls }, { timeout: 180000 })
  return data
}

export async function buildPoolAsync(
  grade: string, cls: string,
): Promise<{ task_id: string; accepted: boolean }> {
  const { data } = await apiClient.post('/api/class-ladder/session/pool/async', { grade, class: cls })
  return data
}


export async function getSessionReport(grade: string, cls: string): Promise<{
  session: LadderSession | null
  board: LadderBoardRow[]
  runs: { run_id: number; student: string; status: string; reached_level: number
          correct_count: number; ladder_score: number; points_awarded: number
          created_at: string; detail: LadderResultItem[] }[]
}> {
  const { data } = await apiClient.get('/api/class-ladder/session/report', { params: { grade, class: cls } })
  return data
}

export async function endSession(
  grade: string, cls: string,
): Promise<{ success: boolean; session_id?: number }> {
  const { data } = await apiClient.post('/api/class-ladder/session/end', { grade, class: cls })
  return data
}

export async function openRun(
  grade: string, cls: string,
): Promise<{ run: LadderRun; covered: number; total: number }> {
  const { data } = await apiClient.post('/api/class-ladder/run', { grade, class: cls })
  return data
}

export async function getRun(runId: number): Promise<{ run: LadderRun }> {
  const { data } = await apiClient.get(`/api/class-ladder/run/${runId}`)
  return data
}

export async function answerRun(runId: number, payload: {
  level: number; selected: string; time_spent?: number; reason?: string
}): Promise<{ correct: boolean; correct_answer: string; selected: string; score_added: number; run: LadderRun }> {
  const { data } = await apiClient.post(`/api/class-ladder/run/${runId}/answer`, payload)
  return data
}

export async function timeoutRun(runId: number, level: number): Promise<{
  correct: boolean; correct_answer: string; score_added: number; run: LadderRun
}> {
  const { data } = await apiClient.post(`/api/class-ladder/run/${runId}/timeout`, { level })
  return data
}

export async function useLifeline(
  runId: number, type: string, votes?: Record<string, number>,
): Promise<{
  type: string; success: boolean; score_after?: number
  removed?: string; advice?: string; votes?: Record<string, number>
  counts?: Record<string, number>; total_voters?: number; student?: string
}> {
  const { data } = await apiClient.post(`/api/class-ladder/run/${runId}/lifeline`,
    { type, ...(votes ? { votes } : {}) }, { timeout: 60000 })
  return data
}

export async function getRunResult(runId: number): Promise<{
  run: LadderRun; detail: LadderResultItem[]
}> {
  const { data } = await apiClient.get(`/api/class-ladder/run/${runId}/result`)
  return data
}

export async function getBoard(
  grade: string, cls: string, limit = 12,
): Promise<{ session: LadderSession | null; rows: LadderBoardRow[]; best: LadderBoardRow | null }> {
  const { data } = await apiClient.get('/api/class-ladder/board',
    { params: { grade, class: cls, limit } })
  return data
}

export async function getLadderRecords(
  grade: string, cls: string, limit = 50,
): Promise<{ session: LadderSession | null; records: LadderBoardRow[] }> {
  const { data } = await apiClient.get('/api/class-ladder/records',
    { params: { grade, class: cls, limit } })
  return data
}