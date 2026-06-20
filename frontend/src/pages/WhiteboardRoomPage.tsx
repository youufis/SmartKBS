/**
 * 白板房间页面 — 教师演示/学生观看的交互界面
 */
import React, { useState, useEffect, useCallback } from 'react'
import {
  Button, Space, Typography, Tag, message, Modal, Input, Drawer,
  Tooltip, Badge, Divider, Segmented,
} from 'antd'
import {
  ArrowLeftOutlined, TeamOutlined, SettingOutlined,
  StopOutlined, CopyOutlined, RobotOutlined,
  ReloadOutlined, ExpandOutlined, CompressOutlined,
} from '@ant-design/icons'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { useWhiteboardStore } from '../stores/whiteboardStore'
import { WhiteboardCanvas } from '../components/whiteboard/WhiteboardCanvas'
import { useWhiteboardWS } from '../hooks/useWhiteboardWS'
import * as whiteboardApi from '../api/whiteboard'
import apiClient from '../api/client'
import type { WhiteboardMode, WhiteboardMember } from '../types'

const { Title, Text } = Typography

const WhiteboardRoomPage: React.FC = () => {
  const { roomId } = useParams<{ roomId: string }>()
  const rid = Number(roomId)
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const isTeacher = user?.role === 'admin' || user?.role === 'teacher'
  const wb = useWhiteboardStore()
  const ws = useWhiteboardWS({ roomId: rid })
  
  const [roomCode, setRoomCode] = useState('')
  const [roomTitle, setRoomTitle] = useState('')
  const [members, setMembers] = useState<WhiteboardMember[]>([])
  const [onlineCount, setOnlineCount] = useState(0)
  const [mode, setModeState] = useState<WhiteboardMode>('demo')
  const [roomStatus, setRoomStatus] = useState('active')
  const [membersOpen, setMembersOpen] = useState(false)
  const [selectedStudent, setSelectedStudent] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [grantedToMe, setGrantedToMe] = useState(false) // 学生：是否被授权操作

  // ── 加载房间信息 ──
  useEffect(() => {
    if (!rid) return
    const load = async () => {
      try {
        const room = await whiteboardApi.getRoom(rid)
        setRoomCode(room.room_code)
        setRoomTitle(room.title)
        setModeState(room.mode as WhiteboardMode)
        setRoomStatus(room.status)
        wb.setMode(room.mode as WhiteboardMode)
        wb.setRoom(room)
      } catch {
        message.error('房间不存在')
        navigate('/whiteboard')
      }
    }
    load()
  }, [rid, navigate, wb])

  // ── 加载成员 ──
  const loadMembers = useCallback(async () => {
    if (!isTeacher) return
    try {
      const list = await whiteboardApi.listStudents(rid)
      setMembers(list)
      setOnlineCount(list.length)
    } catch {
      // ignore
    }
  }, [rid, isTeacher])

  useEffect(() => {
    if (isTeacher) {
      loadMembers()
      const interval = setInterval(loadMembers, 10000)
      return () => clearInterval(interval)
    }
  }, [isTeacher, loadMembers])

  // ── WebSocket 消息 ──
  useEffect(() => {
    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'member_joined' || msg.type === 'member_left') {
        setOnlineCount(msg.online_count as number)
        if (isTeacher) loadMembers()
      }
      if (msg.type === 'mode_changed') {
        setModeState(msg.mode as WhiteboardMode)
        wb.setMode(msg.mode as WhiteboardMode)
      }
      if (msg.type === 'student_submitted') {
        message.success(`学生 ${msg.username} 已提交`)
        if (isTeacher) loadMembers()
      }
      if (msg.type === 'room_ended') {
        message.info('房间已结束')
        setRoomStatus('ended')
      }
      // 学生：收到授权/收回通知
      if (msg.type === 'control_granted') {
        setGrantedToMe(true)
        message.success('你已被授权操作白板！')
      }
      if (msg.type === 'control_revoked') {
        setGrantedToMe(false)
        message.info('操作权已收回')
      }
    })
    return unsub
  }, [ws, isTeacher, wb, loadMembers])

  // ── 操作 ──
  const handleModeChange = async (newMode: string) => {
    try {
      await whiteboardApi.updateRoom(rid, { mode: newMode })
      setModeState(newMode as WhiteboardMode)
      wb.setMode(newMode as WhiteboardMode)
      ws.send({ type: 'mode_change', mode: newMode })
      message.success('模式已切换')
    } catch {
      message.error('切换失败')
    }
  }

  const handleEnd = async () => {
    Modal.confirm({
      title: '确定结束白板？',
      content: '结束后所有学生将退出',
      onOk: async () => {
        try {
          await whiteboardApi.endRoom(rid)
          setRoomStatus('ended')
          message.success('房间已结束')
        } catch {
          message.error('操作失败')
        }
      },
    })
  }

  const handleSpotlight = async (username: string) => {
    try {
      await whiteboardApi.spotlightStudent(rid, username)
      setSelectedStudent(username)
      message.info(`已投屏 ${username} 的白板`)
    } catch {
      message.error('投屏失败')
    }
  }

  const handleGrantControl = async (username: string) => {
    try {
      await whiteboardApi.grantControl(rid, username)
      message.success(`已授权 ${username} 操作`)
      loadMembers()
    } catch {
      message.error('授权失败')
    }
  }

  const handleRevokeControl = async (username: string) => {
    try {
      await whiteboardApi.revokeControl(rid, username)
      message.success('已收回操作权')
      loadMembers()
    } catch {
      message.error('操作失败')
    }
  }

  const toggleFullscreen = () => {
    setFullscreen(!fullscreen)
  }

  // ── 退出 ──
  const handleLeave = async () => {
    try {
      await whiteboardApi.leaveRoom(rid)
    } catch {
      // ignore
    }
    navigate('/whiteboard')
  }

  // 演示模式：学生只读；互动模式：授权后可操作；自习：学生各自操作
  const readOnly = !isTeacher && mode !== 'self_study' && (!grantedToMe || mode !== 'interactive')

  return (
    <div style={{ 
      height: fullscreen ? '100vh' : 'calc(100vh - 80px)',
      display: 'flex', flexDirection: 'column',
      position: fullscreen ? 'fixed' : 'relative',
      top: 0, left: 0, right: 0, bottom: 0,
      zIndex: fullscreen ? 1000 : 1,
      background: '#fff',
    }}>
      {/* ── 顶栏 ── */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '8px 16px', borderBottom: '1px solid #f0f0f0',
        background: '#fafafa', flexShrink: 0,
      }}>
        <Space>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={handleLeave} />
          <Title level={5} style={{ margin: 0 }}>{roomTitle}</Title>
          <Tag color="blue" style={{ fontFamily: 'monospace' }}>{roomCode}</Tag>
          <Badge count={onlineCount} size="small" color="green">
            <TeamOutlined style={{ fontSize: 16 }} />
          </Badge>
        </Space>

        <Space>
          {isTeacher && roomStatus === 'active' && (
            <Segmented
              value={mode}
              onChange={(val) => handleModeChange(val as string)}
              options={[
                { value: 'demo', label: '演示' },
                { value: 'interactive', label: '互动' },
                { value: 'self_study', label: '自习' },
              ]}
            />
          )}
          {isTeacher && (
            <Button icon={<TeamOutlined />} onClick={() => setMembersOpen(true)}>
              成员 ({onlineCount})
            </Button>
          )}
          <Tooltip title="全屏">
            <Button
              type="text"
              icon={fullscreen ? <CompressOutlined /> : <ExpandOutlined />}
              onClick={toggleFullscreen}
            />
          </Tooltip>
          <Tooltip title="复制房间码">
            <Button
              type="text"
              icon={<CopyOutlined />}
              onClick={() => {
                navigator.clipboard.writeText(roomCode)
                message.success('已复制')
              }}
            />
          </Tooltip>
          {isTeacher && roomStatus === 'active' && (
            <Button danger icon={<StopOutlined />} onClick={handleEnd}>结束</Button>
          )}
        </Space>
      </div>

      {/* ── 主区域：白板 ── */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <WhiteboardCanvas roomId={rid} readOnly={readOnly} isBroadcaster={isTeacher} ws={ws} />
      </div>

      {/* ── 底部状态栏 ── */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '4px 16px', borderTop: '1px solid #f0f0f0',
        background: '#fafafa', flexShrink: 0, fontSize: 12, color: '#888',
      }}>
        <span>
          {readOnly ? '👁 只读模式' : '✏️ 可编辑'}
          {' '}|{' '}
          {mode === 'demo' && '教师演示中 — 学生只读'}
          {mode === 'interactive' && '互动模式 — 教师授权后可操作'}
          {mode === 'self_study' && '自习模式 — 各自独立白板'}
        </span>
        <span>
          {ws.isConnected ? '🟢 已连接' : '🔴 未连接'}
        </span>
      </div>

      {/* ── 成员侧栏 ── */}
      <Drawer
        title="成员列表"
        open={membersOpen}
        onClose={() => setMembersOpen(false)}
        width={320}
      >
        {members.map((m) => (
          <div key={m.username} style={{
            padding: '8px 0', borderBottom: '1px solid #f0f0f0',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <div>
              <Text strong>{m.name || m.username}</Text>
              <div><Text type="secondary">{m.class}</Text></div>
            </div>
            {isTeacher && mode === 'interactive' && (
              <Space>
                {m.granted ? (
                  <Button size="small" onClick={() => handleRevokeControl(m.username)}>
                    收回
                  </Button>
                ) : (
                  <Button size="small" type="primary" onClick={() => handleGrantControl(m.username)}>
                    授权
                  </Button>
                )}
              </Space>
            )}
            {isTeacher && mode === 'self_study' && (
              <Space>
                {m.self_snapshot && <Tag color="green">已提交</Tag>}
                <Button size="small" onClick={() => handleSpotlight(m.username)}>
                  查看
                </Button>
              </Space>
            )}
          </div>
        ))}
        {members.length === 0 && <Text type="secondary">暂无成员</Text>}
      </Drawer>
    </div>
  )
}

export default WhiteboardRoomPage
