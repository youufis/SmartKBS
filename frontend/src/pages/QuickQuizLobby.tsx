/**
 * QuickQuizLobby — 抢答活动等候区
 * 显示学生列表、房间信息，等待教师开始
 */
import React, { useState, useEffect, useRef } from 'react'
import { Card, Button, Typography, Space, Tag, Avatar, Spin } from 'antd'
import { message } from '../utils/feedback'
import {
  ThunderboltOutlined, TeamOutlined, UserOutlined,
  ClockCircleOutlined, SettingOutlined, CopyOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'
import { useTranslation } from 'react-i18next'
import { reportLoadError } from '../utils/loadError'
import { RowList, RowItem } from '../components/RowList'

const { Title, Text } = Typography

const QuickQuizLobby: React.FC = () => {
  const { t } = useTranslation('interaction')
  const { roomId } = useParams<{ roomId: string }>()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'

  const [room, setRoom] = useState<any>(null)
  const [players, setPlayers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectRef = useRef(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    loadRoom()
    connectWebSocket()
    // 轮询房间状态与学生名单：防止 WebSocket 消息丢失导致不跳转/不刷新
    pollRef.current = setInterval(async () => {
      try {
        const { data } = await apiClient.get(`/api/quick-quiz/room/${roomId}`)
        if (data.status === 'waiting') {
          setRoom((prev: any) => ({ ...(prev || {}), ...data }))
          setPlayers(data.players || [])
        }
        if (data.status === 'playing') {
          if (pollRef.current) clearInterval(pollRef.current)
          if (isTeacherOrAdmin) {
            navigate(`/quick-quiz/console/${roomId}`, { replace: true })
          } else {
            navigate(`/quick-quiz/play/${roomId}`, { replace: true })
          }
        } else if (data.status === 'ended') {
          if (pollRef.current) clearInterval(pollRef.current)
          navigate(`/quick-quiz/result/${roomId}`, { replace: true })
        }
      } catch { /* ignore */ }
    }, 2000)
    return () => {
      if (wsRef.current) wsRef.current.close()
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [roomId])

  const loadRoom = async () => {
    try {
      const { data } = await apiClient.get(`/api/quick-quiz/room/${roomId}`)
      setRoom(data)
      setPlayers(data.players || [])

      // 如果游戏已经开始或结束，直接跳转
      if (data.status === 'playing') {
        if (isTeacherOrAdmin) {
          navigate(`/quick-quiz/console/${roomId}`, { replace: true })
        } else {
          navigate(`/quick-quiz/play/${roomId}`, { replace: true })
        }
        return
      }
      if (data.status === 'ended') {
        navigate(`/quick-quiz/result/${roomId}`, { replace: true })
        return
      }

      // 学生通过链接进入时自动加入房间
      if (!isTeacherOrAdmin && data.room_code) {
        const isPlayer = (data.players || []).some(
          (p: any) => p.student_username === user?.username
        )
        if (!isPlayer) {
          try {
            await apiClient.post('/api/quick-quiz/join', { room_code: data.room_code })
            // 重新加载玩家列表
            const { data: reloadData } = await apiClient.get(`/api/quick-quiz/room/${roomId}`)
            setPlayers(reloadData.players || [])
          } catch (err) { reportLoadError(err, { key: 'quickQuizLobby.join' }) }
        }
      }
    } catch (err: any) {
      message.error(t('loadRoomInfoFailed'))
      navigate('/quick-quiz')
    } finally {
      setLoading(false)
    }
  }

  const connectWebSocket = () => {
    if (!roomId) return
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const token = localStorage.getItem('smartkb_token') || ''
    // S1: WS 现在必须带有效 token, 无凭证时不再反复重连(旧代码会 3 秒一次无限重试)
    if (!token) {
      console.warn('[quick-quiz] 缺少登录凭证, 跳过 WebSocket 连接')
      return
    }
    const wsUrl = `${protocol}//${window.location.host}/api/ws/quick-quiz/${roomId}?token=${encodeURIComponent(token)}`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      // 允许下一次断线继续重连（旧实现 reconnectRef 置真后永不复位，只重连一次）
      reconnectRef.current = false
      // 注册身份
      ws.send(JSON.stringify({
        type: 'register',
        data: { username: user?.username || '' }
      }))
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        handleWsMessage(msg)
      } catch { /* ignore */ }
    }

    ws.onclose = () => {
      if (!reconnectRef.current) {
        reconnectRef.current = true
        setTimeout(connectWebSocket, 3000)
      }
    }

    ws.onerror = () => ws.close()
  }

  const handleWsMessage = (msg: any) => {
    switch (msg.type) {
      case 'player_list':
        setPlayers(msg.data.players || [])
        break
      case 'room_state':
        if (msg.data.status === 'playing') {
          if (isTeacherOrAdmin) {
            navigate(`/quick-quiz/console/${roomId}`, { replace: true })
          } else {
            navigate(`/quick-quiz/play/${roomId}`, { replace: true })
          }
        }
        break
      case 'game_start':
        // 立即跳转到答题页，由答题页轮询拿题目
        if (isTeacherOrAdmin) {
          navigate(`/quick-quiz/console/${roomId}`, { replace: true })
        } else {
          navigate(`/quick-quiz/play/${roomId}`, { replace: true })
        }
        break
    }
  }

  const handleStart = async () => {
    setStarting(true)
    try {
      await apiClient.post(`/api/quick-quiz/room/${roomId}/start`)
      navigate(`/quick-quiz/console/${roomId}`, { replace: true })
    } catch (err: any) {
      const d = err.response?.data?.detail
      if (d && typeof d === 'object' && d.code === 'min_players_not_met') {
        message.error(t('qqMinPlayersNeeded', { needed: d.needed, current: d.current }))
      } else {
        message.error((typeof d === 'string' && d) || t('startFailed'))
      }
    } finally {
      setStarting(false)
    }
  }

  const handleCopyCode = () => {
    if (room?.room_code) {
      navigator.clipboard.writeText(room.room_code)
      message.success(t('roomCodeCopied'))
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '70vh' }}>
        <Spin size="large" description={t('loading')} />
      </div>
    )
  }

  if (!room) {
    return (
      <div style={{ textAlign: 'center', paddingTop: 120 }}>
        <Title level={4}>{t('roomNotFound')}</Title>
        <Button type="primary" onClick={() => navigate('/quick-quiz')}>{t('back')}</Button>
      </div>
    )
  }

  return (
    <Card style={{ borderRadius: 8 }}>
      {/* 顶部信息 */}
      <Card style={{ borderRadius: 12, marginBottom: 16, background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}
        styles={{ body: { padding: '20px 24px' } }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
          <div>
            <Space>
              <ThunderboltOutlined style={{ fontSize: 24, color: '#fff' }} />
              <Title level={3} style={{ color: '#fff', margin: 0 }}>{room.title}</Title>
              <Tag color={room.status === 'waiting' ? 'processing' : 'success'} style={{ borderRadius: 12 }}>
                {room.status === 'waiting' ? t('waitingStart') : t('inProgress')}
              </Tag>
            </Space>
            <div style={{ marginTop: 8 }}>
              <Text style={{ color: 'rgba(255,255,255,0.85)' }}>
                {t('roomCodeLabel')}
              </Text>
              <Text code style={{ color: '#fff', fontSize: 24, fontWeight: 'bold', letterSpacing: 4,
                background: 'rgba(255,255,255,0.15)', padding: '2px 12px', borderRadius: 6 }}>
                {room.room_code}
              </Text>
              <Button size="small" type="text"
                icon={<CopyOutlined style={{ color: '#fff' }} />}
                onClick={handleCopyCode}
                style={{ color: '#fff', marginLeft: 8 }}
              />
            </div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 36, fontWeight: 'bold', color: '#fff' }}>{players.length}</div>
            <div style={{ color: 'rgba(255,255,255,0.75)' }}>{t('joined')} / {room.max_players || 50}</div>
          </div>
        </div>
      </Card>

      {/* 房间配置 */}
      <Card style={{ borderRadius: 12, marginBottom: 16 }} size="small"
        title={<Space><SettingOutlined /> {t('activityConfig')}</Space>}>
        <Space wrap size={16}>
          <Text><ClockCircleOutlined /> {t('timeLimit')}：<Text strong>{room.time_limit}s</Text></Text>
          <Text>📝 {t('totalQuestions')}：<Text strong>{room.question_count}</Text></Text>
          <Text>🎯 {t('scoring')}：<Text strong>{room.scoring_mode === 'speed' ? t('speedScoring') : t('tieredScoring')}</Text></Text>
          <Text>⏸️ {t('revealHold')}：<Text strong>{room.reveal_hold_sec === 0 ? t('manualAdvance') : t('secondUnitN', { n: room.reveal_hold_sec ?? 5 })}</Text></Text>
          <Text>📚 {t('questionSource')}：<Text strong>
            {room.question_source === 'bank_academic' ? t('bankAcademicLabel') :
             room.question_source === 'bank_general' ? t('bankGeneralLabel') :
             room.question_source === 'bank' ? t('bankAcademicLabel') : room.question_source || t('notSet')}
          </Text></Text>
          {room.subject && <Text>📖 {t('subject')}：{room.subject}</Text>}
        </Space>
      </Card>

      {/* 学生列表 */}
      <Card title={<Space><TeamOutlined /> {t('playerListWithCount', { count: players.length })}</Space>}
        style={{ borderRadius: 12 }} styles={{ body: { padding: players.length === 0 ? '24px' : '12px 24px' } }}>
        {players.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 20 }}>
            <Text type="secondary">{t('noPlayersWaiting')}</Text>
          </div>
        ) : (
          <RowList
            items={players}
            renderItem={(p: any, idx: number) => (
              <RowItem
                title={(
                <Space>
                  <Avatar icon={<UserOutlined />} style={{ backgroundColor: ['#1677ff', '#52c41a', '#fa8c16', '#eb2f96', '#722ed1'][idx % 5] }} />
                  <Text strong>{p.student_name || p.student_username}</Text>
                </Space>
                )}
              />
            )}
          />
        )}
      </Card>

      {/* 操作区 */}
      {isTeacherOrAdmin && room.status === 'waiting' && (
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <Space orientation="vertical" size={12} style={{ width: '100%' }}>
            <Space orientation="vertical" size={4} align="center">
              <Button
                type="primary"
                size="large"
                icon={<PlayCircleOutlined />}
                onClick={handleStart}
                loading={starting}
                disabled={players.length < Math.max(1, room.min_players || 1)}
                style={{ height: 48, borderRadius: 24, paddingLeft: 32, paddingRight: 32 }}
              >
                {t('startQuizBattle')}
              </Button>
              {players.length < Math.max(1, room.min_players || 1) && (
                <Text type="warning" style={{ fontSize: 13 }}>
                  {t('qqMinPlayersNeeded', { needed: Math.max(1, room.min_players || 1), current: players.length })}
                </Text>
              )}
            </Space>
          </Space>
          <div style={{ marginTop: 8 }}>
            <Button onClick={() => navigate('/quick-quiz')}>{t('backToList')}</Button>
          </div>
        </div>
      )}

      {!isTeacherOrAdmin && room.status === 'waiting' && (
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <Text type="secondary">{t('waitingForTeacher')}</Text>
          <div style={{ marginTop: 8 }}>
            <Button onClick={() => navigate('/quick-quiz')}>{t('backToList')}</Button>
          </div>
        </div>
      )}
    </Card>
  )
}

export default QuickQuizLobby
