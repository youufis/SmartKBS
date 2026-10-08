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
import { reportLoadError } from '../../utils/loadError'

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
  const wsStateRef = useRef(ws.state) // 镜像连接状态：兜底轮询频率据此自适应
  const lastSentRef = useRef(0)     // 上次推送快照的时间
  const lastChangeRef = useRef(0)   // 上次本地笔迹变更的时间（"落笔停住"判定）
  const appliedSigRef = useRef('')  // 已应用快照的指纹：内容没变就别整篇重载

  // 同步 readOnly 到 ref
  useEffect(() => {
    readOnlyRef.current = readOnly
  }, [readOnly])

  useEffect(() => {
    wsStateRef.current = ws.state
  }, [ws.state])

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
      () => {
        pendingChangesRef.current = true
        lastChangeRef.current = Date.now()
      },
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

  // 与后端 _snapshot_sig() 保持一致的指纹算法：长度 + 前 200 字符
  const sigOf = (snap: string) => snap.length + '_' + snap.slice(0, 200)

  // ═══════════════════════════════════════════════════════════
  // ★ 自适应同步节拍（原来是：教师端固定 1s / 台上学生 2s 轮询，
  //   只读端不管 WS 好坏都每 5s 重下一份全量快照）
  //   连续书写：最长 MAX_WAIT 推一次 —— 跟手，不再要等满一秒
  //   落笔停住：QUIET 后立即补发一次 —— 笔画的结尾最该被看到
  //   兜底轮询：WS 正常降到 20s 心跳，WS 不通收紧到 3s，并带指纹让服务端
  //             在内容没变时不再回传 21KB 全量（55 人 × 每 5s 一份本身就是全班延迟）
  // ═══════════════════════════════════════════════════════════
  const PUSH_TICK_MS = 60
  const PUSH_QUIET_MS = 160
  const TEACHER_MAX_WAIT_MS = 400
  const STAGE_MAX_WAIT_MS = 600
  const POLL_FAST_MS = 3000
  const POLL_SLOW_MS = 20000

  // 变更驱动广播 + 自适应兜底轮询
  useEffect(() => {
    const pushSnapshot = (maxWait: number) => {
      const editor = editorRef.current
      if (!editor) return
      if (!pendingChangesRef.current) return        // 没变化就绝不序列化（原逻辑保留）
      const now = Date.now()
      if (now - lastSentRef.current < maxWait && now - lastChangeRef.current < PUSH_QUIET_MS) return
      const snapshot = JSON.stringify(editor.getSnapshot())
      if (snapshot.length <= 100) return
      pendingChangesRef.current = false
      lastSentRef.current = now
      snapshotHashRef.current = snapshot
      didSaveRef.current = true
      appliedSigRef.current = sigOf(snapshot)       // 自己这份不用再收一遍
      ws.send({
        type: 'op',
        op_id: generateUUID(),
        // 用当前页，别写死第 1 页：多页白板把内容全存到 page 1，
        // 后端按「当前页」读快照时就会读到空白页，AI 判定白板为空
        page: useWhiteboardStore.getState().currentPage,
        data: { snapshot },
      })
    }

    if (readOnly) {
      // 只读端（演示模式学生 / 未授权的互动学生）：自适应兜底轮询
      let timer = 0
      const pollOnce = async () => {
        try {
          const { data } = await apiClient.get(`/api/whiteboard/rooms/${roomId}/snapshot`, {
            params: snapshotHashRef.current ? { sig: snapshotHashRef.current } : {},
          })
          if (data.granted && readOnlyRef.current && data.mode === 'interactive') {
            readOnlyRef.current = false
            editorRef.current?.updateInstanceState({ isReadonly: false })
          } else if (!data.granted && !readOnlyRef.current && data.mode === 'interactive') {
            readOnlyRef.current = true
            editorRef.current?.updateInstanceState({ isReadonly: true })
          }
          // 只有当前仍是只读状态才加载快照（防止初始 demo 定时器在切自习后覆盖学生内容）
          if (data.snapshot && editorRef.current && readOnlyRef.current) {
            if (Date.now() - lastWSUpdateRef.current > 5000) {   // WS 刚推过就别覆盖
              const sig = (data.sig as string) || sigOf(data.snapshot)
              if (sig === snapshotHashRef.current) return
              snapshotHashRef.current = sig
              appliedSigRef.current = sig
              editorRef.current.store.mergeRemoteChanges(() => {
                try { editorRef.current?.loadSnapshot(JSON.parse(data.snapshot)) } catch { /* 静默 */ }
              })
            }
          } else if (data.sig) {
            // 服务端说没变：留住指纹，下一轮继续省掉整份传输
            snapshotHashRef.current = data.sig as string
          }
        } catch { /* 静默 */ }
      }
      const schedule = () => {
        const healthy = wsStateRef.current === 'open'
          && Date.now() - lastWSUpdateRef.current < 15000
        timer = window.setTimeout(async () => {
          await pollOnce()
          schedule()
        }, healthy ? POLL_SLOW_MS : POLL_FAST_MS)
      }
      schedule()
      return () => clearTimeout(timer)
    }

    if (isBroadcaster) {
      // 教师端：事件驱动 + 双阈值，代替原来每秒一次的定时序列化
      const tick = setInterval(() => pushSnapshot(TEACHER_MAX_WAIT_MS), PUSH_TICK_MS)
      // ★ HTTP 保存：WS 正常时 30s 一次（服务端自己也按房间节流落库）；WS 掉了就收紧到
      //   10s —— 这时它是唯一能把板书送进服务端的路径，学生端兜底轮询要靠它才拿得到新内容
      let httpTimer = 0
      const httpSave = async () => {
        if (didSaveRef.current && snapshotHashRef.current) {
          didSaveRef.current = false
          try {
            await apiClient.put(
              `/api/whiteboard/rooms/${roomId}/pages/${useWhiteboardStore.getState().currentPage}`,
              { snapshot_data: snapshotHashRef.current },
            )
          } catch { /* 静默：下一轮再试 */ }
        }
        httpTimer = window.setTimeout(httpSave, wsStateRef.current === 'open' ? 30000 : 10000)
      }
      httpTimer = window.setTimeout(httpSave, 30000)
      return () => {
        clearInterval(tick); clearTimeout(httpTimer)
        snapshotHashRef.current = ''; didSaveRef.current = false
      }
    }

    if (store.mode === 'interactive') {
      // 互动模式已授权学生：同样事件驱动，节拍放宽一档（一人对着全班，带宽省着用）
      const tick = setInterval(() => pushSnapshot(STAGE_MAX_WAIT_MS), PUSH_TICK_MS)
      return () => { clearInterval(tick); snapshotHashRef.current = '' }
    }
    // 自习模式学生：自己画自己的，不做任何同步
  }, [roomId, store.mode, readOnly, isBroadcaster, ws.send])


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
    // HTTP 兜底拉取初始快照：只读端之外，WS 已被拒/已断的端也要（仅一次）。
  // 房间已结束或无权限时 WS 连不上，还只认 WS 就会出现
  // "板书明明在库里、屏幕却是一片空白"。
if ((readOnlyRef.current || ws.state === 'rejected' || ws.state === 'closed') && !httpSyncedRef.current) {
  httpSyncedRef.current = true
  apiClient.get(`/api/whiteboard/rooms/${roomId}/snapshot`)
    .then(res => {
      // 请求发出后可能已切换为非只读（如自习）且 WS 正常，此时不加载以免覆盖
      if (!readOnlyRef.current && ws.state === 'open') return
      const data = res.data
      if (data.snapshot) {
        editor.store.mergeRemoteChanges(() => {
          try { editor.loadSnapshot(JSON.parse(data.snapshot)) } catch { /* 静默 */ }
        })
      }
    })
    .catch((err) => { reportLoadError(err, { key: 'whiteboard.snapshot' }) })
}
// 主动请求服务端推送最新快照（解决初始演示模式学生端收不到内容的问题）
ws.send({ type: 'request_sync' })
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
        // loadSnapshot 是整篇替换（重建全部图形 + 重算几何），一份 21KB 在弱机上就是
        // 一眼可见的卡顿；内容其实没变的话，跳过这次重载。
        const sig = snapshot.length + '_' + snapshot.slice(0, 200)
        if (sig === appliedSigRef.current) return
        appliedSigRef.current = sig
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
          background: 'var(--bg-layout)', zIndex: 1000,
        }}>
          加载中...
        </div>
      )}
    </div>
  )
}

