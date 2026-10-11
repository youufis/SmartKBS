/**
 * 课堂抽问（随机抽问）API
 *
 * 后端：backend/api/class_drill_router.py（/api/class-drill）
 * 抽人算法与积分口径复用「智能点名」，但会话与流水独立，不写进点名单。
 */
import apiClient from './client'

export interface DrillQuestion {
  id: number | null
  type: string
  question: string
  options: string[]
  answer: string
  explanation: string
  source: string
}

export interface DrillSession {
  session_id: number
  grade: string
  class: string
  subject: string
  topic: string
  ai_enabled: boolean
  status: string
  total_students: number
  covered: number
  picked_in_round: number
  correct_count: number
  incorrect_count: number
  skip_count: number
  created_at: string
}

export interface DrillRecord {
  id: number
  student_name: string
  question_id: number | null
  question_type: string
  question_text: string
  options: string[]
  correct_answer: string
  student_answer: string
  source: string
  result: 'correct' | 'incorrect' | 'skip' | string
  points: number
  created_at: string
}

export interface DrillSessionSummary extends DrillSession {
  teacher: string
  total_count: number
  ended_at: string
}

export interface DrillConfig {
  ai_enabled: boolean
  points: { correct: number; incorrect: number; skip: number }
  question_types: { value: string; label: string }[]
}

export async function getDrillConfig(): Promise<DrillConfig> {
  const { data } = await apiClient.get('/api/class-drill/config')
  return data
}

export async function getDrillSession(
  grade: string,
  cls: string,
): Promise<{ session: DrillSession | null }> {
  const { data } = await apiClient.get('/api/class-drill/session', {
    params: { grade, class: cls },
  })
  return data
}

export async function openDrillSession(payload: {
  grade: string
  class: string
  subject?: string
  topic?: string
  allow_ai?: boolean
}): Promise<DrillSession> {
  const { data } = await apiClient.post('/api/class-drill/session', payload)
  return data
}

export async function resetDrillSession(payload: {
  grade: string
  class: string
  subject?: string
  topic?: string
  allow_ai?: boolean
}): Promise<DrillSession> {
  const { data } = await apiClient.post('/api/class-drill/session/reset', payload)
  return data
}

export async function drawDrillQuestion(payload: {
  grade: string
  class: string
  subject?: string
  topic: string
  question_type?: string
  allow_ai?: boolean
  exclude_ids?: number[]
}): Promise<{ question: DrillQuestion; source: string; note: string; session: DrillSession }> {
  // AI 现出题可能要几十秒，这里给足 3 分钟（后端 AI_REQUEST_TIMEOUT 另外兜底）
  const { data } = await apiClient.post('/api/class-drill/draw', payload, { timeout: 180000 })
  return data
}

export async function pickDrillStudent(
  grade: string,
  cls: string,
): Promise<{ student: string; covered: number; total: number }> {
  const { data } = await apiClient.post('/api/class-drill/pick', { grade, class: cls })
  return data
}

export async function judgeDrillAnswer(payload: {
  grade: string
  class: string
  student: string
  /** 学生所选项（字母或「对/错」）：给了就由服务端判对错 */
  selected?: string
  result?: 'correct' | 'incorrect' | 'skip'
}): Promise<{
  success: boolean
  student: string
  result: string
  correct_answer: string
  student_answer: string
  points_added: number
  total_score: number
  session: DrillSession
}> {
  const { data } = await apiClient.post('/api/class-drill/judge', payload)
  return data
}

export async function getDrillRecords(
  grade: string,
  cls: string,
): Promise<{ session: DrillSession | null; records: DrillRecord[] }> {
  const { data } = await apiClient.get('/api/class-drill/records', {
    params: { grade, class: cls },
  })
  return data
}

export async function listDrillSessions(
  limit = 30,
): Promise<{ sessions: DrillSessionSummary[]; total: number }> {
  const { data } = await apiClient.get('/api/class-drill/sessions', { params: { limit } })
  return data
}

export async function deleteDrillSession(sessionId: number): Promise<{ success: boolean }> {
  const { data } = await apiClient.delete(`/api/class-drill/session/${sessionId}`)
  return data
}
