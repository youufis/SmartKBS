/**
 * 白板 WebSocket 通信 Hook
 * 复用项目现有的 WebSocket 模式（token 认证 + 自动重连）
 */
import { useEffect, useRef, useCallback } from 'react'
import type { WhiteboardWSMessage } from '../types'

interface UseWhiteboardWSOptions {
  roomId: number | null
  enabled?: boolean
}

export function useWhiteboardWS({ roomId, enabled = true }: UseWhiteboardWSOptions) {
  const wsRef = useRef<WebSocket | null>(null)
  const listenersRef = useRef<Set<(msg: WhiteboardWSMessage) => void>>(new Set())
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptRef = useRef(0)

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
      return
    }

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const token = localStorage.getItem('smartkb_token') || ''
      const host = window.location.host
      const wsUrl = `${protocol}//${host}/api/whiteboard/ws/${roomId}?token=${encodeURIComponent(token)}`

      try {
        console.log('[白板WS] 连接中:', wsUrl)
        const ws = new WebSocket(wsUrl)
        wsRef.current = ws

        ws.onopen = () => {
          console.log('[白板WS] 已连接')
          reconnectAttemptRef.current = 0
        }

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data) as WhiteboardWSMessage
            listenersRef.current.forEach((fn) => {
              try {
                fn(data)
              } catch {
                // 忽略单个监听器错误
              }
            })
          } catch {
            // 忽略解析错误
          }
        }

        ws.onclose = (e) => {
          console.log('[白板WS] 已断开, code:', e.code, 'reason:', e.reason)
          wsRef.current = null
          // 3秒后重连，最多重试5次
          if (reconnectAttemptRef.current < 5) {
            reconnectAttemptRef.current++
            reconnectTimerRef.current = setTimeout(connect, 3000)
          }
        }

        ws.onerror = (e) => {
          console.error('[白板WS] 连接错误', e)
          ws.close()
        }
      } catch {
        // 连接失败，重试
        reconnectTimerRef.current = setTimeout(connect, 3000)
      }
    }

    connect()

    return () => {
      clearTimer()
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [roomId, enabled])

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

  const isConnected = wsRef.current?.readyState === WebSocket.OPEN

  return { send, onMessage, isConnected }
}
