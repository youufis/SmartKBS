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
  const internalEditorRef = useRef<Editor | null>(null)
  const editorRef = externalEditorRef || internalEditorRef
  const [ready, setReady] = useState(false)
  const isSendingRef = useRef(false) // 防止远程变更触发本地发送
  const readOnlyRef = useRef(readOnly)  // 用 ref 追踪 readOnly，避免闭包陈旧
  const httpSyncedRef = useRef(false) // 防止重复 HTTP 同步
  const lastWSUpdateRef = useRef(0) // 上次 WS 收到快照的时间戳

  // 同步 readOnly 到 ref
  useEffect(() => {
    readOnlyRef.current = readOnly
  }, [readOnly])

  // ═══════════════════════════════════════════════════════════
  // ★ 关键修复：使用 TLDraw store.listen 事件驱动检测内容变更
  // 替代原来每秒轮询 editor.getSnapshot() 的方式，避免无操作时
  // 反复创建快照字符串导致的内存泄漏
  // ═══════════════════════════════════════════════════════════
  const pendingChangesRef = useRef(false) // TLDraw 内容是否发生实际变更
  const didSaveRef = useRef(false)        // 快照是否有过实际变更发送（控制 HTTP 保存）

  // 监听 TLDraw store 变更：仅在用户操作（非远程同步）且文档内容变化时标记
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !ready) return
    // 仅在广播端（教师/互动模式已授权学生）注册监听
    if (!isBroadcaster && store.mode !== 'interactive') {
      pendingChangesRef.current = false
      return
    }
    const cleanup = editor.store.listen(
      () => { pendingChangesRef.current = true },
      { source: 'user', scope: 'document' }
    )
    return () => {
      cleanup()
      pendingChangesRef.current = false
    }
  }, [isBroadcaster, store.mode, ready])
  // ═══════════════════════════════════════════════════════════

  // 快照内容哈希缓存，避免无变化时重复序列化/同步
  const snapshotHashRef = useRef('')

  // HTTP 轮询兜底 + 定时广播（WS 可用时也发）
  useEffect(() => {
    if (readOnly) {
      // 只读端（演示模式学生 / 未授权的互动学生）：每 5s 拉取最新快照 + 授权状态
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
              // 快照未变化则跳过，减少内存分配
              const hash = data.snapshot.length + '_' + (typeof data.snapshot === 'string' ? data.snapshot.slice(0, 200) : '')
              if (hash === snapshotHashRef.current) return
              snapshotHashRef.current = hash
              editorRef.current.store.mergeRemoteChanges(() => {
                try { editorRef.current?.loadSnapshot(JSON.parse(data.snapshot)) } catch { /* 静默 */ }
              })
            }
          }
        } catch { /* 静默 */ }
      }, 5000)
      return () => clearInterval(interval)
    } else if (isBroadcaster) {
      // 教师端：★ 使用 store.listen 事件驱动代替每秒轮询 ★
      // 仅在有实际变更（pendingChangesRef）时才序列化快照并发送
      const wsTimer = setInterval(() => {
        // ── 关键修复：无变更时跳过，避免 JSON.stringify 反复执行 ──
        if (!pendingChangesRef.current) return
        pendingChangesRef.current = false

        const editor = editorRef.current
        if (!editor) return
        const snapshot = JSON.stringify(editor.getSnapshot())
        if (snapshot.length > 100) {
          snapshotHashRef.current = snapshot
          didSaveRef.current = true
          ws.send({
            type: 'op',
            op_id: generateUUID(),
            page: 1,
            data: { snapshot },
          })
        }
      }, 1000)
      // ★ HTTP 保存：降低频率至 30s，且仅在有实际变更时才提交
      const httpTimer = setInterval(async () => {
        if (!didSaveRef.current) return
        didSaveRef.current = false
        if (!snapshotHashRef.current) return
        await apiClient.put(`/api/whiteboard/rooms/${roomId}/pages/1`, { snapshot_data: snapshotHashRef.current })
      }, 30000)
      return () => { clearInterval(wsTimer); clearInterval(httpTimer); snapshotHashRef.current = ''; didSaveRef.current = false }
    } else if (store.mode === 'interactive') {
      // 互动模式已授权学生：★ 同样使用事件驱动 ★
      const wsTimer = setInterval(() => {
        if (!pendingChangesRef.current) return
        pendingChangesRef.current = false

        const editor = editorRef.current
        if (!editor) return
        const snapshot = JSON.stringify(editor.getSnapshot())
        if (snapshot.length > 100) {
          snapshotHashRef.current = snapshot
          ws.send({
            type: 'op',
            op_id: generateUUID(),
            page: 1,
            data: { snapshot },
          })
        }
      }, 2000)
      return () => { clearInterval(wsTimer); snapshotHashRef.current = '' }
    } else {
      // 自习模式学生：自己画自己的，不做任何同步
    }
  }, [roomId, store.mode, readOnly])

  const [tldrawEditor, setTldrawEditor] = useState<Editor | null>(null)

  // 将 editor 实例同步到 ref（供外部和定时器访问），避免在 useCallback 中直接修改 ref
  useEffect(() => {
    editorRef.current = tldrawEditor
    return () => { editorRef.current = null }
  }, [tldrawEditor])

  const handleMount = useCallback((editor: Editor) => {
    if (readOnly) {
      editor.updateInstanceState({ isReadonly: true })
    }

    setReady(true)
    setTldrawEditor(editor)

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
  }, [readOnly, ws, store.currentPage, roomId])

  // readOnly 变化时实时更新编辑器状态（如互动模式授权）
  useEffect(() => {
    const editor = editorRef.current
    if (editor) {
      editor.updateInstanceState({ isReadonly: readOnly })
    }
  }, [readOnly])

  const pendingSnapshots = useRef<string[]>([]) // editor 就绪前的消息缓冲

  // ★ 解构出稳定函数引用，避免整个 store 对象作为依赖
  const setCurrentPage = store.setCurrentPage

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
        // 非只读且非广播端（互动模式下已授权学生）：跳过加载，防止覆盖自己正在画的内容
        if (!readOnlyRef.current && !isBroadcaster) {
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
        setCurrentPage(msg.page as number)
        try {
          const snap = JSON.parse(msg.snapshot as string) as TLStoreSnapshot
          editor.loadSnapshot(snap)
        } catch { /* ignore */ }
      }
    })
    return unsub
  }, [ws, setCurrentPage])

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
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

