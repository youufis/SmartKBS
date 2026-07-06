/**
 * QuickQuizLobby — 抢答活动等候区
 * 显示玩家列表、房间信息，等待教师开始
 */
import React, { useState, useEffect, useRef } from 'react'
import {
  Card, Button, Typography, Space, Tag, Avatar, List, message, Spin,
} from 'antd'
import {
  ThunderboltOutlined, TeamOutlined, UserOutlined,
  ClockCircleOutlined, SettingOutlined, CopyOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'

const { Title, Text } = Typography

const QuickQuizLobby: React.FC = () => {
  const { roomId } = useParams<{ roomId: string }>()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'

  const [room, setRoom] = useState<any>(null)
  const [players, setPlayers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [countdown, setCountdown] = useState<number | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectRef = useRef(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    loadRoom()
    connectWebSocket()
    // 轮询房间状态，防止 WebSocket 消息丢失导致不跳转
    pollRef.current = setInterval(async () => {
      try {
        const { data } = await apiClient.get(`/api/quick-quiz/room/${roomId}`)
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
          } catch { /* 加入失败，可能无权限等 */ }
        }
      }
    } catch (err: any) {
      message.error('加载房间信息失败')
      navigate('/quick-quiz')
    } finally {
      setLoading(false)
    }
  }

  const connectWebSocket = () => {
    if (!roomId) return
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/ws/quick-quiz/${roomId}`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
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
      message.error(err.response?.data?.detail || '启动失败')
    } finally {
      setStarting(false)
    }
  }

  const handleCopyCode = () => {
    if (room?.room_code) {
      navigator.clipboard.writeText(room.room_code)
      message.success('房间码已复制')
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '70vh' }}>
        <Spin size="large" description="加载中..." />
      </div>
    )
  }

  if (!room) {
    return (
      <div style={{ textAlign: 'center', paddingTop: 120 }}>
        <Title level={4}>房间不存在</Title>
        <Button type="primary" onClick={() => navigate('/quick-quiz')}>返回</Button>
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
                {room.status === 'waiting' ? '等待开始' : '进行中'}
              </Tag>
            </Space>
            <div style={{ marginTop: 8 }}>
              <Text style={{ color: 'rgba(255,255,255,0.85)' }}>
                房间码：
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
            <div style={{ color: 'rgba(255,255,255,0.75)' }}>已加入 / {room.max_players || 50}</div>
          </div>
        </div>
      </Card>

      {/* 房间配置 */}
      <Card style={{ borderRadius: 12, marginBottom: 16 }} size="small"
        title={<Space><SettingOutlined /> 活动配置</Space>}>
        <Space wrap size={16}>
          <Text><ClockCircleOutlined /> 每题限时：<Text strong>{room.time_limit}s</Text></Text>
          <Text>📝 共 <Text strong>{room.question_count}</Text> 题</Text>
          <Text>🎯 计分模式：<Text strong>{room.scoring_mode === 'speed' ? '速度递减' : '分段奖励'}</Text></Text>
          <Text>📚 题目来源：<Text strong>
            {room.question_source === 'bank_academic' ? '学科试题库' :
             room.question_source === 'bank_general' ? '百科知识题库' :
             room.question_source === 'bank' ? '试题库' : room.question_source || '未设置'}
          </Text></Text>
          {room.subject && <Text>📖 学科：{room.subject}</Text>}
        </Space>
      </Card>

      {/* 玩家列表 */}
      <Card title={<Space><TeamOutlined /> 玩家列表 ({players.length})</Space>}
        style={{ borderRadius: 12 }} styles={{ body: { padding: players.length === 0 ? '24px' : '12px 24px' } }}>
        {players.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 20 }}>
            <Text type="secondary">暂无玩家加入，等待中...</Text>
          </div>
        ) : (
          <List
            dataSource={players}
            renderItem={(p: any, idx: number) => (
              <List.Item>
                <Space>
                  <Avatar icon={<UserOutlined />} style={{ backgroundColor: ['#1677ff', '#52c41a', '#fa8c16', '#eb2f96', '#722ed1'][idx % 5] }} />
                  <Text strong>{p.student_name || p.student_username}</Text>
                </Space>
              </List.Item>
            )}
          />
        )}
      </Card>

      {/* 倒计时覆盖 */}
      {countdown !== null && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.7)', display: 'flex',
          justifyContent: 'center', alignItems: 'center', zIndex: 1000,
          flexDirection: 'column',
        }}>
          <div style={{ fontSize: 120, color: '#fff', fontWeight: 'bold' }}>
            {countdown > 0 ? countdown : 'GO!'}
          </div>
          <div style={{ color: '#fff', fontSize: 24, marginTop: 16 }}>即将开始...</div>
        </div>
      )}

      {/* 操作区 */}
      {isTeacherOrAdmin && room.status === 'waiting' && (
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <Space orientation="vertical" size={12} style={{ width: '100%' }}>
            <Space>
              <Button
                type="primary"
                size="large"
                icon={<PlayCircleOutlined />}
                onClick={handleStart}
                loading={starting}
                disabled={players.length < 1}
                style={{ height: 48, borderRadius: 24, paddingLeft: 32, paddingRight: 32 }}
              >
                🚀 开始抢答
              </Button>
            </Space>
          </Space>
          <div style={{ marginTop: 8 }}>
            <Button onClick={() => navigate('/quick-quiz')}>返回列表</Button>
          </div>
        </div>
      )}

      {!isTeacherOrAdmin && room.status === 'waiting' && (
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <Text type="secondary">等待教师开始抢答...</Text>
          <div style={{ marginTop: 8 }}>
            <Button onClick={() => navigate('/quick-quiz')}>返回列表</Button>
          </div>
        </div>
      )}
    </Card>
  )
}

export default QuickQuizLobby
