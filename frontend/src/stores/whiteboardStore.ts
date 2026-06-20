/**
 * 协作白板状态管理 (Zustand)
 */
import { create } from 'zustand'
import type { WhiteboardRoom, WhiteboardPage, WhiteboardMember, WhiteboardMode } from '../types'

interface WhiteboardState {
  // 房间
  room: WhiteboardRoom | null
  roomCode: string
  myRole: 'teacher' | 'student' | null

  // 模式
  mode: WhiteboardMode
  isHost: boolean

  // 页面
  currentPage: number
  pages: WhiteboardPage[]

  // 成员
  members: WhiteboardMember[]
  onlineCount: number

  // 工具状态
  activeTool: string
  activeColor: string
  strokeWidth: number

  // UI 状态
  aiPanelOpen: boolean
  aiLoading: boolean
  sidebarCollapsed: boolean

  // 自习模式
  selfSnapshot: string | null
  submitted: boolean

  // 操作
  setRoom: (room: WhiteboardRoom | null) => void
  setRoomCode: (code: string) => void
  setMyRole: (role: 'teacher' | 'student' | null) => void
  setMode: (mode: WhiteboardMode) => void
  setIsHost: (v: boolean) => void
  setCurrentPage: (page: number) => void
  setPages: (pages: WhiteboardPage[]) => void
  addPage: (page: WhiteboardPage) => void
  updatePage: (pageNum: number, data: Partial<WhiteboardPage>) => void
  removePage: (pageNum: number) => void
  setMembers: (members: WhiteboardMember[]) => void
  addMember: (member: WhiteboardMember) => void
  removeMember: (username: string) => void
  updateMember: (username: string, data: Partial<WhiteboardMember>) => void
  setOnlineCount: (n: number) => void
  setActiveTool: (tool: string) => void
  setActiveColor: (color: string) => void
  setStrokeWidth: (w: number) => void
  setAiPanelOpen: (open: boolean) => void
  setAiLoading: (loading: boolean) => void
  setSidebarCollapsed: (v: boolean) => void
  setSelfSnapshot: (snap: string | null) => void
  setSubmitted: (v: boolean) => void
  reset: () => void
}

const initialState = {
  room: null,
  roomCode: '',
  myRole: null as 'teacher' | 'student' | null,
  mode: 'demo' as WhiteboardMode,
  isHost: false,
  currentPage: 1,
  pages: [],
  members: [],
  onlineCount: 0,
  activeTool: 'select',
  activeColor: '#1a1a1a',
  strokeWidth: 3,
  aiPanelOpen: false,
  aiLoading: false,
  sidebarCollapsed: false,
  selfSnapshot: null,
  submitted: false,
}

export const useWhiteboardStore = create<WhiteboardState>((set) => ({
  ...initialState,

  setRoom: (room) => set({ room }),
  setRoomCode: (code) => set({ roomCode: code }),
  setMyRole: (role) => set({ myRole: role }),
  setMode: (mode) => set({ mode }),
  setIsHost: (v) => set({ isHost: v }),
  setCurrentPage: (page) => set({ currentPage: page }),
  setPages: (pages) => set({ pages }),
  addPage: (page) => set((s) => ({ pages: [...s.pages, page] })),
  updatePage: (pageNum, data) =>
    set((s) => ({
      pages: s.pages.map((p) => (p.page_number === pageNum ? { ...p, ...data } : p)),
    })),
  removePage: (pageNum) =>
    set((s) => ({ pages: s.pages.filter((p) => p.page_number !== pageNum) })),
  setMembers: (members) => set({ members }),
  addMember: (member) =>
    set((s) => ({
      members: s.members.some((m) => m.username === member.username)
        ? s.members.map((m) => (m.username === member.username ? member : m))
        : [...s.members, member],
    })),
  removeMember: (username) =>
    set((s) => ({ members: s.members.filter((m) => m.username !== username) })),
  updateMember: (username, data) =>
    set((s) => ({
      members: s.members.map((m) => (m.username === username ? { ...m, ...data } : m)),
    })),
  setOnlineCount: (n) => set({ onlineCount: n }),
  setActiveTool: (tool) => set({ activeTool: tool }),
  setActiveColor: (color) => set({ activeColor: color }),
  setStrokeWidth: (w) => set({ strokeWidth: w }),
  setAiPanelOpen: (open) => set({ aiPanelOpen: open }),
  setAiLoading: (loading) => set({ aiLoading: loading }),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  setSelfSnapshot: (snap) => set({ selfSnapshot: snap }),
  setSubmitted: (v) => set({ submitted: v }),
  reset: () => set({ ...initialState }),
}))
