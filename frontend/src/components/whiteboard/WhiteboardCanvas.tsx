/**
 * 白板画布组件 — 基于 TLDraw
 * 支持三种模式：演示/互动/自习
 */
import React, { useEffect, useMemo, useRef, useCallback, useState } from 'react'
import { isAxiosError } from 'axios'
import { Tldraw, type Editor, type TLStoreSnapshot, type TLComponents,
  type TLRecord } from 'tldraw'
import { squashRecordDiffs, type RecordsDiff } from '@tldraw/store'
import type { TLAssetStore } from '@tldraw/tlschema'
import 'tldraw/tldraw.css'
import { useWhiteboardStore } from '../../stores/whiteboardStore'
import { useWhiteboardWS } from '../../hooks/useWhiteboardWS'
import apiClient from '../../api/client'
import { reportLoadError } from '../../utils/loadError'
import { startPoller, stopPoller } from '../../utils/poller'

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

  // 图片先上传成 URL 再进快照：TLDraw 默认会把 File 转成 data URL 塞进 asset.props.src，
  // 一张 500KB 的截图会让之后每一笔笔迹的整份快照都变成 600KB+。
  const assetStore = useMemo<TLAssetStore>(() => ({
    async upload(asset, file) {
      const asDataUrl = () => new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })
      // 非图片（视频等）暂不接管，保持旧行为，避免上传接口把它当图片处理。
      if (!file.type.startsWith('image/')) {
        return { src: await asDataUrl() }
      }
      try {
        const form = new FormData()
        form.append('file', file)
        const { data } = await apiClient.post(
          `/api/whiteboard/rooms/${roomId}/assets`, form,
        )
        if (data?.src) return { src: String(data.src) }
      } catch {
        // 上传失败时退回 data URL：宁可变大，也不能让老师粘贴图片直接失败。
      }
      return { src: await asDataUrl(), meta: asset.meta }
    },
    resolve(asset) {
      return (asset.props as { src?: string }).src || null
    },
  }), [roomId])

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
  // ★ 增量同步：store.listen 直接拿 RecordsDiff，只发变化的记录
  //   旧实现每 400ms 发整份快照（含 asset base64），55 人一班直接把 AP 打满。
  // ═══════════════════════════════════════════════════════════
  const pendingDiffsRef = useRef<RecordsDiff<TLRecord>[]>([])
  const didSaveRef = useRef(false)          // 自上次 keyframe 后是否有变更
  const appliedSeqRef = useRef(-1)          // 已应用的服务端序号
  const hasBaseRef = useRef(false)          // 是否已有完整快照作为基线
  const lastKeyframeSentRef = useRef(0)
  const keyframeRequestAtRef = useRef(0)
  const serverSupportsDiffRef = useRef(false)  // 老后端没有 hello_ack：退回整份快照
  const sendKeyframeRef = useRef<(force?: boolean) => void>(() => {})
  const requestKeyframeRef = useRef<() => void>(() => {})

  const requestKeyframe = useCallback(() => {
    const now = Date.now()
    if (now - keyframeRequestAtRef.current < 1500) return
    keyframeRequestAtRef.current = now
    ws.send({ type: 'request_keyframe' })
  }, [ws])

  useEffect(() => {
    requestKeyframeRef.current = requestKeyframe
  }, [requestKeyframe])

  // 监听 TLDraw store 变更：只收用户操作、只收文档记录（不含相机/session）
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !ready) return
    // 仅在广播端（教师/互动模式已授权学生）注册监听
    if (!isBroadcaster && store.mode !== 'interactive') {
      pendingDiffsRef.current = []
      return
    }
    const cleanup = editor.store.listen(
      ({ changes }) => {
        if (!changes) return
        if (!Object.keys(changes.added).length
          && !Object.keys(changes.updated).length
          && !Object.keys(changes.removed).length) return
        pendingDiffsRef.current.push(changes)
        lastChangeRef.current = Date.now()
      },
      { source: 'user', scope: 'document' }
    )
    return () => {
      cleanup()
      pendingDiffsRef.current = []
    }
  }, [isBroadcaster, store.mode, ready])
  // ═══════════════════════════════════════════════════════════

  // 快照内容哈希缓存，避免无变化时重复序列化/同步
  const snapshotHashRef = useRef('')

  // 与后端 _snapshot_sig() 保持一致的指纹算法：长度 + 前 200 字符
  const sigOf = (snap: string) => snap.length + '_' + snap.slice(0, 200)

  // ═══════════════════════════════════════════════════════════
  // 节拍：patch 每 40ms 检查一次，连续书写最多 120ms 推一批；
  // 落笔停住 60ms 立刻补发。keyframe 每 10s 一份（给新加入/断号/落库用）。
  // ═══════════════════════════════════════════════════════════
  const PUSH_TICK_MS = 40
  const PUSH_QUIET_MS = 60
  const TEACHER_MAX_WAIT_MS = 120
  const STAGE_MAX_WAIT_MS = 200
  const KEYFRAME_INTERVAL_MS = 5000
  const POLL_FAST_MS = 3000
  const POLL_SLOW_MS = 20000

  const takeSnapshot = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return ''
    try {
      const snap = JSON.stringify(editor.getSnapshot())
      return snap.length > 100 ? snap : ''
    } catch {
      return ''
    }
  }, [])

  // 变更驱动广播 + 自适应兜底轮询
  useEffect(() => {
    const pushPatch = (maxWait: number) => {
      if (!pendingDiffsRef.current.length) return
      if (!ws.isConnected) return
      const now = Date.now()
      const wait = serverSupportsDiffRef.current ? maxWait : Math.max(maxWait, 400)
      if (now - lastSentRef.current < wait && now - lastChangeRef.current < PUSH_QUIET_MS) return
      // 兼容老后端（桌面版/未重启的 IIS）：没有 hello_ack 就继续发整份快照，
      // 否则新前端连老后端时 patch 会被当成未知消息丢掉。
      if (!serverSupportsDiffRef.current) {
        const snapshot = takeSnapshot()
        if (!snapshot) return
        pendingDiffsRef.current = []
        lastSentRef.current = now
        didSaveRef.current = true
        snapshotHashRef.current = sigOf(snapshot)
        appliedSigRef.current = snapshotHashRef.current
        ws.send({
          type: 'op',
          op_id: generateUUID(),
          page: useWhiteboardStore.getState().currentPage,
          data: { snapshot },
        })
        return
      }
      const pending = pendingDiffsRef.current
      pendingDiffsRef.current = []
      let changes: RecordsDiff<TLRecord>
      try {
        changes = squashRecordDiffs(pending)
      } catch {
        changes = pending[pending.length - 1]
      }
      lastSentRef.current = now
      didSaveRef.current = true
      ws.send({
        type: 'patch',
        page: useWhiteboardStore.getState().currentPage,
        changes,
      })
    }

    const sendKeyframe = (force = false) => {
      if (!ws.isConnected) return
      // 老后端没有 patch：整份快照已经由 pushPatch 按 400ms 发出，别再叠加 keyframe
      if (!serverSupportsDiffRef.current && !force) return
      if (!force && !didSaveRef.current) return
      // 同一轮多个学生请求 keyframe：只回一份，别把 55 个连接又打一遍
      if (force && Date.now() - lastKeyframeSentRef.current < 600) return
      const snapshot = takeSnapshot()
      if (!snapshot) return
      // 快照已经包含当前全部本地变更，之前攒的 patch 不必再发一遍
      pendingDiffsRef.current = []
      didSaveRef.current = false
      snapshotHashRef.current = snapshot
      appliedSigRef.current = sigOf(snapshot)
      ws.send({
        type: 'op',
        op_id: generateUUID(),
        page: useWhiteboardStore.getState().currentPage,
        data: { snapshot },
      })
      lastKeyframeSentRef.current = Date.now()
    }
    sendKeyframeRef.current = sendKeyframe

    if (readOnly) {
      // 只读端（演示模式学生 / 未授权的互动学生）：自适应兜底轮询。
      // WS 正常时 20s 一轮，掉线时 3s；带 sig 让服务端内容没变就只回 unchanged。
      const pollKey = `whiteboard-snapshot-${roomId}`
      let disposed = false
      let lastPollAt = 0
      const pollOnce = async () => {
        if (disposed) return
        lastPollAt = Date.now()
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
          if (data.snapshot && editorRef.current && readOnlyRef.current) {
            if (Date.now() - lastWSUpdateRef.current > 5000) {
              const sig = (data.sig as string) || sigOf(data.snapshot)
              if (sig === snapshotHashRef.current) return
              snapshotHashRef.current = sig
              appliedSigRef.current = sig
              editorRef.current.store.mergeRemoteChanges(() => {
                try { editorRef.current?.loadSnapshot(JSON.parse(data.snapshot)) } catch { /* 静默 */ }
              })
              hasBaseRef.current = true
              const seq = Number(data.seq)
              if (Number.isFinite(seq) && seq > appliedSeqRef.current) {
                appliedSeqRef.current = seq
              }
            }
          } else if (data.sig) {
            snapshotHashRef.current = data.sig as string
          }
        } catch (err) {
          // 401 = 凭证已失效：拦截器已经清凭证 + 跳登录，这里绝不再发。
          if (isAxiosError(err) && err.response?.status === 401) {
            disposed = true
            stopPoller(pollKey)
          }
        }
      }
      startPoller(pollKey, async () => {
        const healthy = wsStateRef.current === 'open'
          && Date.now() - lastWSUpdateRef.current < 15000
        if (Date.now() - lastPollAt < (healthy ? POLL_SLOW_MS : POLL_FAST_MS)) return
        await pollOnce()
      }, POLL_FAST_MS, { immediate: false })
      return () => { disposed = true; stopPoller(pollKey) }
    }

    if (isBroadcaster) {
      const tick = setInterval(() => pushPatch(TEACHER_MAX_WAIT_MS), PUSH_TICK_MS)
      const keyTimer = setInterval(() => sendKeyframe(false), KEYFRAME_INTERVAL_MS)
      // HTTP 保存：WS 正常 30s，掉线 10s。它是 WS 不通时唯一能把板书送进
      // 服务端的路径；正常时 keyframe 已经覆盖，这里基本是空转。
      let httpTimer = 0
      const httpSave = async () => {
        if (didSaveRef.current) {
          const snap = takeSnapshot()
          if (snap) {
            didSaveRef.current = false
            snapshotHashRef.current = snap
            try {
              await apiClient.put(
                `/api/whiteboard/rooms/${roomId}/pages/${useWhiteboardStore.getState().currentPage}`,
                { snapshot_data: snap },
              )
            } catch {
              didSaveRef.current = true
            }
          }
        }
        httpTimer = window.setTimeout(httpSave, wsStateRef.current === 'open' ? 30000 : 10000)
      }
      httpTimer = window.setTimeout(httpSave, 30000)
      return () => {
        clearInterval(tick); clearInterval(keyTimer); clearTimeout(httpTimer)
        sendKeyframeRef.current = () => {}
      }
    }

    if (store.mode === 'interactive') {
      // 互动模式已授权学生：只发 patch，不发 keyframe（权威快照仍由老师出）
      const tick = setInterval(() => pushPatch(STAGE_MAX_WAIT_MS), PUSH_TICK_MS)
      return () => { clearInterval(tick) }
    }
    // 自习模式学生：自己画自己的，不做任何同步
  }, [roomId, store.mode, readOnly, isBroadcaster, ws.isConnected, ws.send, takeSnapshot])

  // 连接建立/重连：声明能力；只读端/台上学生本地可能落后，要一份 keyframe 重新对齐。
  // 老师自己就是权威副本，不需要向别人要快照。
  useEffect(() => {
    if (ws.state !== 'open') return
    ws.send({ type: 'hello', caps: ['diff'] })
    serverSupportsDiffRef.current = false
    hasBaseRef.current = false
    appliedSeqRef.current = -1
    keyframeRequestAtRef.current = 0
    if (!isBroadcaster) requestKeyframeRef.current()
  }, [ws.state, ws.send, isBroadcaster])

  // 切到后台/关标签页前补一份 keyframe：patch 不落库，最后几秒不能丢。
  useEffect(() => {
    if (!isBroadcaster) return
    const onHide = () => {
      if (document.visibilityState === 'hidden') sendKeyframeRef.current(true)
    }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [isBroadcaster])


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
      const last = pending[pending.length - 1]
      try {
        editor.store.mergeRemoteChanges(() => {
          editor.loadSnapshot(JSON.parse(last.snapshot))
        })
        hasBaseRef.current = true
        snapshotHashRef.current = last.snapshot.length + '_' + last.snapshot.slice(0, 200)
        appliedSigRef.current = snapshotHashRef.current
        if (typeof last.seq === 'number' && last.seq >= 0) {
          appliedSeqRef.current = Math.max(appliedSeqRef.current, last.seq)
        }
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
        try {
          editor.store.mergeRemoteChanges(() => {
            editor.loadSnapshot(JSON.parse(data.snapshot))
          })
          hasBaseRef.current = true
          snapshotHashRef.current = (data.sig as string) || ''
          const seq = Number(data.seq)
          if (Number.isFinite(seq) && seq >= 0) {
            appliedSeqRef.current = Math.max(appliedSeqRef.current, seq)
          }
        } catch { /* 静默 */ }
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

  // editor 就绪前的消息缓冲（带 seq，就绪后才知道自己对齐到哪一号）
  const pendingSnapshots = useRef<Array<{ snapshot: string; seq?: number }>>([])

  // ★ 解构出稳定函数引用，避免整个 store 对象作为依赖
  const setCurrentPage = store.setCurrentPage

  useEffect(() => {
    const applyFullSnapshot = (snapshot: string, seq?: number) => {
      const ed = editorRef.current
      if (!ed) return
      const sig = snapshot.length + '_' + snapshot.slice(0, 200)
      if (sig === appliedSigRef.current) {
        if (typeof seq === 'number' && seq >= 0) {
          appliedSeqRef.current = Math.max(appliedSeqRef.current, seq)
        }
        return
      }
      appliedSigRef.current = sig
      snapshotHashRef.current = sig
      try {
        isSendingRef.current = true
        ed.store.mergeRemoteChanges(() => {
          ed.loadSnapshot(JSON.parse(snapshot))
        })
        hasBaseRef.current = true
        if (typeof seq === 'number' && seq >= 0) {
          appliedSeqRef.current = Math.max(appliedSeqRef.current, seq)
        }
      } catch (e) {
        console.error('[白板] 应用快照失败:', e)
      } finally {
        isSendingRef.current = false
      }
    }

    const unsub = ws.onMessage((msg) => {
      const editor = editorRef.current

      // editor 未就绪 → 缓存 op_broadcast 消息
      if (!editor) {
        if (msg.type === 'op_broadcast') {
          const snap = (msg.data as { snapshot?: string })?.snapshot
          if (snap) {
            pendingSnapshots.current.push({
              snapshot: snap,
              seq: typeof msg.seq === 'number' ? msg.seq : undefined,
            })
          }
        }
        return
      }

      if (msg.type === 'op_broadcast') {
        const snapshot = (msg.data as { snapshot?: string })?.snapshot
        if (!snapshot) return
        lastWSUpdateRef.current = Date.now()
        const seq = typeof msg.seq === 'number' ? msg.seq : undefined
        // 非只读且非广播端（互动模式下已授权学生）：跳过加载，防止覆盖自己正在画的内容
        if (!readOnlyRef.current && !isBroadcaster) {
          hasBaseRef.current = true
          if (seq !== undefined && seq >= 0) {
            appliedSeqRef.current = Math.max(appliedSeqRef.current, seq)
          }
          return
        }
        // keyframe 只在进房/切页/断号时出现，整篇替换可以接受
        applyFullSnapshot(snapshot, seq)
        return
      }

      if (msg.type === 'hello_ack') {
        serverSupportsDiffRef.current = true
        return
      }

      // ── 增量补丁：只改变化的记录，不再整篇重建 ──
      if (msg.type === 'patch_broadcast') {
        lastWSUpdateRef.current = Date.now()
        const seq = Number(msg.seq)
        const changes = msg.changes as RecordsDiff<TLRecord> | undefined
        if (!changes || !Number.isFinite(seq)) return
        if (seq <= appliedSeqRef.current) return          // 重复/乱序：丢掉
        if (!hasBaseRef.current) {                        // 还没有基线，补丁不能落在空板上
          requestKeyframeRef.current()
          return
        }
        if (appliedSeqRef.current >= 0 && seq > appliedSeqRef.current + 1) {
          // 断号：让老师补一份完整快照，别在缺记录的状态上继续叠补丁
          requestKeyframeRef.current()
          return
        }
        const t0 = performance.now()
        try {
          isSendingRef.current = true
          editor.store.mergeRemoteChanges(() => {
            editor.store.applyDiff(changes)
          })
          appliedSeqRef.current = seq
        } catch (e) {
          console.error('[白板] 应用增量补丁失败:', e)
          requestKeyframeRef.current()
        } finally {
          isSendingRef.current = false
        }
        const cost = performance.now() - t0
        if (cost > 60) {
          console.warn(`[白板][perf] patch apply ${cost.toFixed(1)}ms seq=${seq}`)
        }
        return
      }

      // 发送者的补丁不会回放，用 ack 对齐服务端序号
      if (msg.type === 'patch_ack' || msg.type === 'keyframe_ack') {
        const seq = Number(msg.seq)
        if (Number.isFinite(seq) && seq >= 0) {
          appliedSeqRef.current = Math.max(appliedSeqRef.current, seq)
          hasBaseRef.current = true
        }
        return
      }

      if (msg.type === 'resync') {
        keyframeRequestAtRef.current = 0
        requestKeyframeRef.current()
        return
      }

      if (msg.type === 'keyframe_requested' && isBroadcaster) {
        sendKeyframeRef.current(true)
        return
      }

      if (msg.type === 'page_switched' && msg.snapshot) {
        setCurrentPage(msg.page as number)
        appliedSigRef.current = ''
        try {
          const snap = JSON.parse(msg.snapshot as string) as TLStoreSnapshot
          editor.store.mergeRemoteChanges(() => {
            editor.loadSnapshot(snap)
          })
          hasBaseRef.current = true
          const seq = Number(msg.seq)
          if (Number.isFinite(seq) && seq >= 0) appliedSeqRef.current = seq
          const raw = msg.snapshot as string
          snapshotHashRef.current = raw.length + '_' + raw.slice(0, 200)
        } catch { /* ignore */ }
      }
    })
    return unsub
  }, [ws, setCurrentPage, isBroadcaster])

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Tldraw onMount={handleMount} components={minimalComponents}
        assets={assetStore} licenseKey="oss" />
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

