/**
 * 白板画布组件 — 基于 TLDraw
 * 支持三种模式：演示/互动/自习
 */
import React, { useEffect, useRef, useCallback, useState } from 'react'
import { Tldraw, type Editor, type TLStoreSnapshot, type TLComponents } from 'tldraw'
import 'tldraw/tldraw.css'
import { useWhiteboardStore } from '../../stores/whiteboardStore'
import { useWhiteboardWS } from '../../hooks/useWhiteboardWS'
import apiClient from '../../api/client'

// 使用自建 WebSocket 后端，屏蔽 TLDraw 默认的云同步面板和右下角水印
const minimalComponents: TLComponents = {
  SharePanel: null,
  DebugPanel: null,
  MenuPanel: null,
  HelperButtons: null,
  PeopleMenu: null,
}

interface Props {
  roomId: number
  readOnly?: boolean
  isBroadcaster?: boolean  // 教师端可广播；自习模式下学生虽非只读，但不广播
  ws: ReturnType<typeof useWhiteboardWS>
  externalEditorRef?: React.MutableRefObject<Editor | null>  // 外部 editor ref（供 AI 面板使用）
}

// crypto.randomUUID 在 HTTP（非 localhost）环境下不可用，用兼容实现兜底
function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    try { return crypto.randomUUID() } catch { /* 兜底 */ }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}

export const WhiteboardCanvas: React.FC<Props> = ({ roomId, readOnly = false, isBroadcaster = false, ws, externalEditorRef }) => {
  const store = useWhiteboardStore()
  const editorRef = useRef<Editor | null>(null)
  const [ready, setReady] = useState(false)
  const isSendingRef = useRef(false) // 防止远程变更触发本地发送
  const readOnlyRef = useRef(readOnly)  // 用 ref 追踪 readOnly，避免闭包陈旧
  const httpSyncedRef = useRef(false) // 防止重复 HTTP 同步
  const lastWSUpdateRef = useRef(0) // 上次 WS 收到快照的时间戳
  const containerRef = useRef<HTMLDivElement>(null) // 容器 ref，用于 ResizeObserver

  // ResizeObserver 兜底：HTTPS 下 TLDraw 内部监听可能失效
  // 容器尺寸变化时直接通知 TLDraw 更新视口
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let rafId: number
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        const editor = editorRef.current
        if (editor) {
          try {
            // 传入容器元素，TLDraw 内部会调用 getBoundingClientRect() 获取真实尺寸
            editor.updateViewportScreenBounds(el)
          } catch { /* ignore */ }
        }
      })
    })
    ro.observe(el)
    return () => { ro.disconnect(); cancelAnimationFrame(rafId) }
  }, [])

  // 同步 readOnly 到 ref
  useEffect(() => {
    readOnlyRef.current = readOnly
  }, [readOnly])

  // HTTP 轮询兜底 + 定时广播（WS 可用时也发）
  useEffect(() => {
    if (readOnly) {
      // 只读端（演示模式学生 / 未授权的互动学生）：每 2s 拉取最新快照 + 授权状态
      const interval = setInterval(async () => {
        try {
          const { data } = await apiClient.get(`/api/whiteboard/rooms/${roomId}/snapshot`)
          if (data.granted && readOnlyRef.current && data.mode === 'interactive') {
            readOnlyRef.current = false
            if (editorRef.current) {
              editorRef.current.updateInstanceState({ isReadonly: false })
            }
          } else if (!data.granted && !readOnlyRef.current && data.mode === 'interactive') {
            readOnlyRef.current = true
            if (editorRef.current) {
              editorRef.current.updateInstanceState({ isReadonly: true })
            }
          }
          // 只有当前仍是只读状态才加载快照（防止初始 demo 定时器在切自习后覆盖学生内容）
          if (data.snapshot && editorRef.current && readOnlyRef.current) {
            // WS 近 5 秒内有更新则跳过（防止覆盖用户刚画的内容）
            if (Date.now() - lastWSUpdateRef.current > 5000) {
              editorRef.current.store.mergeRemoteChanges(() => {
                try { editorRef.current?.loadSnapshot(JSON.parse(data.snapshot)) } catch { /* 静默 */ }
              })
            }
          }
        } catch { /* 静默 */ }
      }, 2000)
      return () => clearInterval(interval)
    } else if (isBroadcaster) {
      // 教师端：每 500ms 广播快照（WS 方式） + 每 3s HTTP 保存
      const wsTimer = setInterval(() => {
        const editor = editorRef.current
        if (!editor) return
        const snapshot = JSON.stringify(editor.getSnapshot())
        if (snapshot.length > 100) {
          console.log('[白板] 广播快照, 大小:', snapshot.length)
          ws.send({
            type: 'op',
            op_id: generateUUID(),
            page: 1,
            data: { snapshot },
          })
        }
      }, 500)
      const httpTimer = setInterval(async () => {
        const editor = editorRef.current
        if (!editor) return
        const snapshot = JSON.stringify(editor.getSnapshot())
        if (snapshot.length > 100) {
          await apiClient.put(`/api/whiteboard/rooms/${roomId}/pages/1`, { snapshot_data: snapshot })
        }
      }, 3000)
      return () => { clearInterval(wsTimer); clearInterval(httpTimer) }
    } else if (store.mode === 'interactive') {
      // 互动模式已授权学生：每 1s 广播快照（WS 方式）
      const wsTimer = setInterval(() => {
        const editor = editorRef.current
        if (!editor) return
        const snapshot = JSON.stringify(editor.getSnapshot())
        if (snapshot.length > 100) {
          ws.send({
            type: 'op',
            op_id: generateUUID(),
            page: 1,
            data: { snapshot },
          })
        }
      }, 1000)
      return () => clearInterval(wsTimer)
    } else {
      // 自习模式学生：自己画自己的，不做任何同步
    }
  }, [roomId, store.mode, readOnly, isBroadcaster, ws])

  const pendingSnapshots = useRef<string[]>([]) // editor 就绪前的消息缓冲

  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor
    if (externalEditorRef) {
      externalEditorRef.current = editor
    }
    if (readOnly) {
      editor.updateInstanceState({ isReadonly: true })
    }

    setReady(true)
    // 重放编辑就绪前缓存的快照
    const pending = pendingSnapshots.current
    if (pending.length > 0) {
      pendingSnapshots.current = []
      try {
        editor.store.mergeRemoteChanges(() => {
          pending.forEach(snap => {
            try { editor.loadSnapshot(JSON.parse(snap)) } catch { /* skip */ }
          })
        })
      } catch { /* skip */ }
    }
    // HTTP 兜底拉取初始快照（仅限只读端，且仅一次）
    if (readOnlyRef.current && !httpSyncedRef.current) {
      httpSyncedRef.current = true
      apiClient.get(`/api/whiteboard/rooms/${roomId}/snapshot`)
        .then(res => {
          // 请求发出后可能已切换为非只读（如自习），此时不加载快照以免覆盖
          if (!readOnlyRef.current) return
          const data = res.data
          if (data.snapshot) {
            editor.store.mergeRemoteChanges(() => {
              try { editor.loadSnapshot(JSON.parse(data.snapshot)) } catch { /* 静默 */ }
            })
          }
        })
        .catch(() => {})
    }
  }, [readOnly, roomId, externalEditorRef])

  // readOnly 变化时实时更新编辑器状态（如互动模式授权）
  useEffect(() => {
    const editor = editorRef.current
    if (editor) {
      editor.updateInstanceState({ isReadonly: readOnly })
    }
  }, [readOnly])

  useEffect(() => {
    const unsub = ws.onMessage((msg) => {
      const editor = editorRef.current

      // editor 未就绪 → 缓存 op_broadcast 消息
      if (!editor) {
        if (msg.type === 'op_broadcast') {
          const snap = (msg.data as { snapshot?: string })?.snapshot
          if (snap) pendingSnapshots.current.push(snap)
        }
        return
      }

      if (msg.type === 'op_broadcast') {
        const snapshot = (msg.data as { snapshot?: string })?.snapshot
        if (!snapshot) return
        // 广播端（教师）：跳过加载自己的广播，避免快照覆盖当前视口
        // 非只读非广播端（互动学生）：跳过，防止覆盖自己正在画的内容
        // 只有纯只读端（演示学生）才加载远程快照
        if (isBroadcaster || !readOnlyRef.current) {
          lastWSUpdateRef.current = Date.now()
          return
        }
        lastWSUpdateRef.current = Date.now()
        try {
          isSendingRef.current = true
          editor.store.mergeRemoteChanges(() => {
            editor.loadSnapshot(JSON.parse(snapshot))
          })
        } catch (e) {
          console.error('[白板] 应用快照失败:', e)
        } finally {
          isSendingRef.current = false
        }
      }

      if (msg.type === 'page_switched' && msg.snapshot) {
        store.setCurrentPage(msg.page as number)
        try {
          const snap = JSON.parse(msg.snapshot as string) as TLStoreSnapshot
          editor.loadSnapshot(snap)
        } catch { /* ignore */ }
      }
    })
    return unsub
  }, [ws, store, isBroadcaster])

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Tldraw onMount={handleMount} components={minimalComponents} licenseKey="oss" />
      {/* 隐藏 TLDraw 右下角 "Get a license for production" 水印 */}
      <style>{`
        .tl-watermark,
        [class*="watermark"],
        [class*="license"],
        .tlui-debug-panel,
        .tlui-share-panel,
        a[href*="tldraw"][href*="license"],
        a[href*="tldraw"][href*="pricing"] {
          display: none !important;
        }
      `}</style>
      {!ready && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: '#f5f5f5', zIndex: 1000,
        }}>
          加载中...
        </div>
      )}
    </div>
  )
}

