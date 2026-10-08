/**
 * 白板 WebSocket 通信 Hook
 * 复用项目现有的 WebSocket 模式（token 认证 + 自动重连）
 *
 * 房间不存在 / 已结束 / 无权限 属于"重连也不会变"的拒绝：服务端会先 accept、
 * 用 ws_rejected 帧把原因送下来再关闭。这里据此停止重试并把原因交给页面显示，
 * 不再让教师对着一块静默失败的空白画布（以前只有一行 uvicorn 403）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WhiteboardWSMessage } from '../types'

interface UseWhiteboardWSOptions {
  roomId: number | null
  enabled?: boolean
}

export type WsConnectionState = 'connecting' | 'open' | 'retrying' | 'rejected' | 'closed'

export interface WsRejection {
  code: number
  reason: string
}

/** 重连也不会变的关闭码：停止重试，把原因交给界面 */
const NON_RETRYABLE_CODES = new Set([4001, 4003, 4401, 4403, 4404, 4410])
/**
 * 可重试的断开要一直退避重连，不再"试满 5 次就放弃"。
 * 服务端 --reload 每改一次代码就重启一次（现场开发时几乎必然踩到），
 * 固定 5 次 ×3s 只覆盖 15 秒，重启一慢就永久停在"已断开"，
 * 师生都以为"白板没内容了"，其实只是浏览器不再试了。
 */
const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 30000
/** 心跳间隔/失联阈值：半开连接（代理空闲回收、断网）不会触发 onclose，只能靠没回音发现 */
const HEARTBEAT_INTERVAL = 15000
const HEARTBEAT_STALE = 35000
/**
 * 心跳只能在服务端"证明自己会回 pong"之后才有权掐线。
 * 旧版后端没有 ping 分支，永远不回 pong：不加这道闸就会把本来好好的连接
 * 每 35~50 秒掐一次，教师端只剩 30 秒一次的 HTTP 落库，学生端看到的
 * 还是服务端内存里那份旧快照 —— 表现成"再也没有新内容"。
 */

export function useWhiteboardWS({ roomId, enabled = true }: UseWhiteboardWSOptions) {
  const wsRef = useRef<WebSocket | null>(null)
  const listenersRef = useRef<Set<(msg: WhiteboardWSMessage) => void>>(new Set())
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptRef = useRef(0)
  const lastPongRef = useRef(0)
  const pongCapableRef = useRef(false) // 服务端回过 pong = 心跳可用，才允许按失联掐线
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<WsConnectionState>('connecting')
  const [rejection, setRejection] = useState<WsRejection | null>(null)

  const clearTimer = () => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }

  useEffect(() => {
    if (!roomId || !enabled) {
      clearTimer()
      wsRef.current?.close()
      wsRef.current = null
      setState('closed')
      return
    }

    // 本次 effect 的销毁标记：切换房间/离开页面时的 onclose 不能再排重连，
    // 否则上一个房间的 socket 会在新房间里复活。
    let disposed = false
    setRejection(null)
    setState('connecting')

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const token = localStorage.getItem('smartkb_token') || ''
      const host = window.location.host
      // 同源握手会自动带上登录 Cookie（后端优先读 Cookie，URL 上的 token 只作兜底），
      // 服务端访问日志也已把 token= 打码，避免每连一次就往日志里抄一份 JWT。
      const wsUrl = `${protocol}//${host}/api/whiteboard/ws/${roomId}?token=${encodeURIComponent(token)}`

      try {
        const ws = new WebSocket(wsUrl)
        wsRef.current = ws

        ws.onopen = () => {
          reconnectAttemptRef.current = 0
          lastPongRef.current = Date.now()
          pongCapableRef.current = false   // 新连接：重新确认服务端是否会回 pong
          setState('open')
        }

        ws.onmessage = (event) => {
          let data: WhiteboardWSMessage
          try {
            data = JSON.parse(event.data) as WhiteboardWSMessage
          } catch {
            return
          }
          if (data?.type === 'pong') {
            lastPongRef.current = Date.now()
            pongCapableRef.current = true  // 心跳从此有据可依
            return
          }
          if (data?.type === 'ws_rejected') {
            // 拒绝帧只用于界面提示，不派发给业务监听器
            setRejection({ code: Number(data.code) || 0, reason: String(data.reason || '') })
            return
          }
          listenersRef.current.forEach((fn) => {
            try {
              fn(data)
            } catch {
              // 忽略单个监听器错误
            }
          })
        }

        ws.onclose = (e) => {
          wsRef.current = null
          if (disposed) return
          if (NON_RETRYABLE_CODES.has(e.code)) {
            setState('rejected')
            return
          }
          const n = reconnectAttemptRef.current
          const delay = Math.min(RETRY_BASE_MS * 2 ** Math.min(n, 4), RETRY_MAX_MS)
          reconnectAttemptRef.current = n + 1
          setState(n >= 4 ? 'closed' : 'retrying')   // 界面给出"未连接"，但仍在后台退避重连
          reconnectTimerRef.current = setTimeout(connect, delay)
        }

        ws.onerror = () => {
          ws.close()
        }
      } catch {
        if (!disposed) {
          reconnectTimerRef.current = setTimeout(connect, RETRY_BASE_MS)
        }
      }
    }

    connect()

    // 断网恢复 / 标签页回到前台：立刻重试一次，别等退避计时器慢慢熬
    const wakeUp = () => {
      if (disposed) return
      const ws = wsRef.current
      if (ws && ws.readyState <= WebSocket.OPEN) return   // 已有连接（含握手中）
      clearTimer()
      reconnectAttemptRef.current = 0
      connect()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') wakeUp()
    }
    window.addEventListener('online', wakeUp)
    document.addEventListener('visibilitychange', onVisibility)

    const heartbeat = setInterval(() => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      // 只有确认服务端支持心跳，"没回音"才是断线的证据；否则照旧只发 ping、不掐线
      if (pongCapableRef.current && Date.now() - lastPongRef.current > HEARTBEAT_STALE) {
        ws.close() // 长时间没回音：链路已半开，走 onclose 的常规重连
        return
      }
      ws.send(JSON.stringify({ type: 'ping', t: Date.now() }))
    }, HEARTBEAT_INTERVAL)

    return () => {
      disposed = true
      clearTimer()
      clearInterval(heartbeat)
      window.removeEventListener('online', wakeUp)
      document.removeEventListener('visibilitychange', onVisibility)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [roomId, enabled, attempt])

  // 发送消息
  const send = useCallback((data: WhiteboardWSMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data))
    }
  }, [])

  // 注册消息监听（返回取消注册函数）
  const onMessage = useCallback((fn: (msg: WhiteboardWSMessage) => void) => {
    listenersRef.current.add(fn)
    return () => {
      listenersRef.current.delete(fn)
    }
  }, [])

  // 手动重连（例如教师点"重新开启白板"之后）
  const reconnect = useCallback(() => {
    clearTimer()
    reconnectAttemptRef.current = 0
    setAttempt((a) => a + 1)
  }, [])

  const isConnected = state === 'open'

  // ★ 使用 useMemo 稳定对象引用，防止每次渲染生成新对象导致 effects 反复重跑
  return useMemo(
    () => ({ send, onMessage, reconnect, isConnected, state, rejection }),
    [send, onMessage, reconnect, isConnected, state, rejection],
  )
}