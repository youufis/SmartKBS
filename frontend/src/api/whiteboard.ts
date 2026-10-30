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

/** 重新开启已结束的白板（仅房主与管理员）：结束后学生端看不到房间、教师也连不上 */
export async function reopenRoom(roomId: number): Promise<void> {
  await apiClient.post(`/api/whiteboard/rooms/${roomId}/reopen`)
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

export async function registerToRoom(roomId: number): Promise<void> {
    await apiClient.post(`/api/whiteboard/rooms/${roomId}/register`)
}
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
    useVision?: boolean
    /** 浏览器里的实时白板快照（服务端那份是异步落库的副本，可能过期/为空） */
    snapshot?: string
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
        use_vision: options?.useVision ?? false,
        snapshot: options?.snapshot || '',
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

// ── AI 图示生成的事件回调类型 ──

export interface DiagramProgressEvent {
  phase: string
  message: string
}

export interface DiagramResultEvent {
  mode: 'svg' | 'image' | 'text'
  svg?: string
  image_url?: string
  title?: string
  error?: string
  width?: number
  height?: number
  fallback?: string
}

export interface DiagramErrorEvent {
  message: string
  fallback?: string
  mode?: string
}

/**
 * AI 图示生成（SSE 流式进度版本）
 * 通过 EventSource 接收进度事件，防止 IIS 超时
 */
export async function aiGenerateDiagramStream(
  description: string,
  subject: string | undefined,
  callbacks: {
    onProgress: (phase: string, message: string) => void
    onResult: (result: DiagramResultEvent) => void
    onError: (error: string) => void
  },
  options?: { signal?: AbortSignal; roomId?: number },
): Promise<void> {
  const token = localStorage.getItem('smartkb_token')
  try {
    const response = await fetch('/api/whiteboard/ai/generate-diagram', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ description, subject, room_id: options?.roomId }),
      signal: options?.signal,
    })

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}))
      callbacks.onError(errData.detail || `HTTP ${response.status}`)
      return
    }

    const reader = response.body?.getReader()
    if (!reader) {
      callbacks.onError('无法读取响应流')
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''

    // ⚠️ currentEvent 必须跨 read 存活。SSE 一帧 = 「event: 行」+「data: 行」+ 空行，
    // 而图示结果帧里塞着整段 SVG（动辄 5KB），公网/慢链路上一定会被拆进多次 read。
    // 旧写法把 currentEvent 声明在 while 里面：event 行与 data 行一旦落在相邻两次
    // read 里，data 行到达时事件名已被重置成空串，switch 全部落空 —— result 被静默
    // 丢弃，进度框就永远停在「AI 正在生成 SVG 图示…」，而后端其实 20 秒就返回了。
    let currentEvent = ''
    let settled = false

    // 静默看门狗：链路彻底不动时也要给个终点，绝不让模态框无限转。
    // 330s 与前端其它 AI 端点的 320s 同量级，且后端已改为每 10 秒补一次进度心跳，
    // 正常生成途中永远不会触发。
    const IDLE_TIMEOUT_MS = 330_000
    const readWithIdleTimeout = async (): Promise<{ done: boolean; value?: Uint8Array }> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('AI 响应超时：长时间没有收到任何进度，请重试')),
              IDLE_TIMEOUT_MS,
            )
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    const handleFrame = (payload: string) => {
      let data: any
      try {
        data = JSON.parse(payload)
      } catch {
        return /* 半帧/脏数据：等下一帧 */
      }
      if (currentEvent === 'progress') {
        callbacks.onProgress(data.phase, data.message)
      } else if (currentEvent === 'result') {
        settled = true
        callbacks.onResult(data as DiagramResultEvent)
      } else if (currentEvent === 'error') {
        settled = true
        callbacks.onError(data.message || '生成失败')
      }
    }

    while (!settled) {
      const { done, value } = await readWithIdleTimeout()
      if (value) buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          handleFrame(line.slice(5).trim())
          if (settled) {
            await reader.cancel().catch(() => { /* 已结束的流取消会抛错，忽略 */ })
            return
          }
        } else if (line.trim() === '') {
          currentEvent = '' // 空行 = 一帧结束，事件名到此作废
        }
      }
      if (done) break
    }

    // 流已结束却始终没有 result/error：把最后一段残留再试一次，
    // 仍拿不到结果就明确报错 —— 让老师看到失败，而不是"一直在生成中"。
    if (!settled && buffer.trim()) {
      const tail = buffer.trim()
      if (tail.startsWith('data:')) handleFrame(tail.slice(5).trim())
    }
    if (!settled) {
      callbacks.onError('连接已结束，但没有收到生成结果（多为网络中断或代理超时），请重试')
    }
  } catch (err: any) {
    if (err.name === 'AbortError') return
    callbacks.onError(err.message || '网络错误')
  }
}

export async function aiGenerateDiagram(
  description: string,
  subject?: string,
  roomId?: number,
): Promise<{
  mode: 'svg' | 'image' | 'text'
  svg?: string
  image_url?: string
  title?: string
  error?: string
  width?: number
  height?: number
}> {
  const res = await apiClient.post('/api/whiteboard/ai/generate-diagram', { description, subject, room_id: roomId }, { timeout: 320000 })
  return res.data
}

export async function aiGenerateBoard(
  kpName: string,
  subject?: string,
  grade?: string,
  roomId?: number,
): Promise<{
  title: string
  shapes: unknown[]
}> {
  const res = await apiClient.post('/api/whiteboard/ai/generate-board', {
    kp_name: kpName,
    subject: subject || '',
    grade: grade || '',
    room_id: roomId,
  }, { timeout: 320000 })
  return res.data
}

export async function aiBeautifyBoard(
  roomId: number,
  subject?: string,
  snapshot?: string,
): Promise<{
  title: string
  shapes: unknown[]
}> {
  const res = await apiClient.post('/api/whiteboard/ai/beautify-board', {
    room_id: roomId,
    subject: subject || '',
    snapshot: snapshot || '',
  }, { timeout: 320000 })
  return res.data
}

export async function aiGenerateQuiz(
  roomId: number,
  subject?: string,
  kpName?: string,
  snapshot?: string,
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
    snapshot: snapshot || '',
  }, { timeout: 320000 })
  return res.data
}

export async function aiSmartAnnotation(
  selectionDesc: string,
  mode?: string,
): Promise<{
  summary: string
  label_type: string
  label_text: string
  color: string
}> {
  const res = await apiClient.post('/api/whiteboard/ai/smart-annotation', {
    selection_desc: selectionDesc,
    mode: mode || 'demo',
  }, { timeout: 320000 })
  return res.data
}

export async function aiGenerateMindmap(
  roomId: number,
  subject?: string,
  snapshot?: string,
): Promise<{
  title: string
  shapes: unknown[]
}> {
  const res = await apiClient.post('/api/whiteboard/ai/generate-mindmap', {
    room_id: roomId,
    subject: subject || '',
    snapshot: snapshot || '',
  }, { timeout: 320000 })
  return res.data
}

export async function aiGenerateBilingual(
  roomId: number,
  subject?: string,
  snapshot?: string,
): Promise<{
  title: string
  shapes: unknown[]
}> {
  const res = await apiClient.post('/api/whiteboard/ai/generate-bilingual', {
    room_id: roomId,
    subject: subject || '',
    snapshot: snapshot || '',
  }, { timeout: 320000 })
  return res.data
}

export async function aiSuggest(
  content: string,
  kpName?: string,
  options?: { snapshot?: string; roomId?: number },
): Promise<{
  suggestion: string
}> {
  const res = await apiClient.post(
    '/api/whiteboard/ai/suggest',
    { content, kp_name: kpName, snapshot: options?.snapshot || '', room_id: options?.roomId },
    { timeout: 320000 },
  )
  return res.data
}
