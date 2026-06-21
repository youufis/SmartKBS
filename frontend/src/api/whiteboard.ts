/**
 * 协作白板 API 客户端
 */
import apiClient from './client'
import type {
  WhiteboardRoom,
  WhiteboardPage,
  WhiteboardMember,
  CreateRoomRequest,
} from '../types'

// ── 房间管理 ──

export async function createRoom(data: CreateRoomRequest): Promise<{ id: number; room_code: string }> {
  const res = await apiClient.post('/api/whiteboard/rooms', data)
  return res.data
}

export async function listRooms(page = 1, size = 20): Promise<WhiteboardRoom[]> {
  const res = await apiClient.get('/api/whiteboard/rooms', { params: { page, size } })
  return res.data
}

export async function getRoom(roomId: number): Promise<WhiteboardRoom> {
  const res = await apiClient.get(`/api/whiteboard/rooms/${roomId}`)
  return res.data
}

export async function updateRoom(roomId: number, data: {
  title?: string; mode?: string; allow_student_draw?: boolean
}): Promise<void> {
  await apiClient.patch(`/api/whiteboard/rooms/${roomId}`, data)
}

export async function endRoom(roomId: number): Promise<void> {
  await apiClient.post(`/api/whiteboard/rooms/${roomId}/end`)
}

export async function deleteRoom(roomId: number): Promise<void> {
  await apiClient.delete(`/api/whiteboard/rooms/${roomId}`)
}

// ── 加入/离开 ──

export async function joinByCode(roomCode: string): Promise<{
  room_id: number; title: string; mode: string; grade: string; class_name: string
}> {
  const res = await apiClient.post('/api/whiteboard/join-by-code', { room_code: roomCode })
  return res.data
}

export async function leaveRoom(roomId: number): Promise<void> {
  await apiClient.post(`/api/whiteboard/rooms/${roomId}/leave`)
}

// ── 页面管理 ──

export async function listPages(roomId: number): Promise<WhiteboardPage[]> {
  const res = await apiClient.get(`/api/whiteboard/rooms/${roomId}/pages`)
  return res.data
}

export async function getPage(roomId: number, pageNumber: number): Promise<{
  snapshot_data: string; title: string
}> {
  const res = await apiClient.get(`/api/whiteboard/rooms/${roomId}/pages/${pageNumber}`)
  return res.data
}

export async function savePage(roomId: number, pageNumber: number, data: {
  snapshot_data: string; thumbnail?: string; title?: string
}): Promise<void> {
  await apiClient.put(`/api/whiteboard/rooms/${roomId}/pages/${pageNumber}`, data)
}

export async function addPage(roomId: number): Promise<{ page_number: number }> {
  const res = await apiClient.post(`/api/whiteboard/rooms/${roomId}/pages`)
  return res.data
}

export async function deletePage(roomId: number, pageNumber: number): Promise<void> {
  await apiClient.delete(`/api/whiteboard/rooms/${roomId}/pages/${pageNumber}`)
}

// ── 控制权 ──

export async function grantControl(roomId: number, username: string): Promise<void> {
  await apiClient.post(`/api/whiteboard/rooms/${roomId}/control/grant`, { username })
}

export async function revokeControl(roomId: number, username: string): Promise<void> {
  await apiClient.post(`/api/whiteboard/rooms/${roomId}/control/revoke`, { username })
}

// ── 学生列表 ──

export async function listStudents(roomId: number): Promise<WhiteboardMember[]> {
  const res = await apiClient.get(`/api/whiteboard/rooms/${roomId}/students`)
  return res.data
}

export async function spotlightStudent(roomId: number, username: string): Promise<void> {
  await apiClient.post(`/api/whiteboard/rooms/${roomId}/spotlight`, { username })
}

// ── AI 辅助 ──

/**
 * AI 教学助手 SSE 流式对话
 */
export async function aiChatStream(
  prompt: string,
  roomId: number,
  onDelta: (text: string) => void,
  onDone: () => void,
  onError: (error: string) => void,
  options?: {
    kpName?: string
    subject?: string
    signal?: AbortSignal
  },
): Promise<void> {
  const token = localStorage.getItem('smartkb_token')
  try {
    const response = await fetch('/api/whiteboard/ai/chat-stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        prompt,
        room_id: roomId,
        kp_name: options?.kpName || '',
        subject: options?.subject || '',
      }),
      signal: options?.signal,
    })

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}))
      onError(errData.detail || `HTTP ${response.status}`)
      return
    }

    const reader = response.body?.getReader()
    if (!reader) {
      onError('无法读取响应流')
      return
    }

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
          const data = JSON.parse(line.slice(6))
          switch (data.type) {
            case 'delta':
              onDelta(data.content)
              break
            case 'done':
              break
            case 'error':
              onError(data.content)
              return
          }
        } catch { /* skip parse errors */ }
      }
    }

    onDone()
  } catch (err: any) {
    if (err.name === 'AbortError') return
    onError(err.message || '网络错误')
  }
}

export async function aiGenerateDiagram(
  description: string,
  subject?: string,
): Promise<{
  mode: 'svg' | 'image' | 'text'
  svg?: string
  image_url?: string
  title?: string
  error?: string
  width?: number
  height?: number
}> {
  const res = await apiClient.post('/api/whiteboard/ai/generate-diagram', { description, subject })
  return res.data
}

export async function aiGenerateBoard(
  kpName: string,
  subject?: string,
  grade?: string,
): Promise<{
  title: string
  shapes: unknown[]
}> {
  const res = await apiClient.post('/api/whiteboard/ai/generate-board', {
    kp_name: kpName,
    subject: subject || '',
    grade: grade || '',
  })
  return res.data
}

export async function aiBeautifyBoard(
  roomId: number,
  subject?: string,
): Promise<{
  title: string
  shapes: unknown[]
}> {
  const res = await apiClient.post('/api/whiteboard/ai/beautify-board', {
    room_id: roomId,
    subject: subject || '',
  })
  return res.data
}

export async function aiGenerateQuiz(
  roomId: number,
  subject?: string,
  kpName?: string,
): Promise<{
  question: string
  options: string[]
  correct_index: number
  explanation?: string
  error?: string
}> {
  const res = await apiClient.post('/api/whiteboard/ai/generate-quiz', {
    room_id: roomId,
    subject: subject || '',
    kp_name: kpName || '',
  })
  return res.data
}

export async function aiGenerateBilingual(
  roomId: number,
  subject?: string,
): Promise<{
  title: string
  shapes: unknown[]
}> {
  const res = await apiClient.post('/api/whiteboard/ai/generate-bilingual', {
    room_id: roomId,
    subject: subject || '',
  })
  return res.data
}

export async function aiSuggest(content: string, kpName?: string): Promise<{
  suggestion: string
}> {
  const res = await apiClient.post('/api/whiteboard/ai/suggest', { content, kp_name: kpName })
  return res.data
}
