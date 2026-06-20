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

export async function aiGenerateDiagram(description: string, subject?: string): Promise<{
  shapes: unknown[]
}> {
  const res = await apiClient.post('/api/whiteboard/ai/generate-diagram', { description, subject })
  return res.data
}

export async function aiSuggest(content: string, kpName?: string): Promise<{
  suggestion: string
}> {
  const res = await apiClient.post('/api/whiteboard/ai/suggest', { content, kp_name: kpName })
  return res.data
}
