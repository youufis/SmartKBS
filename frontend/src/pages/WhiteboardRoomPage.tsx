/**
 * 白板房间页面 — 教师演示/学生观看的交互界面
 */
import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  Button, Space, Typography, Tag, message, Modal, Input, Drawer,
  Tooltip, Badge, Divider, Segmented,
} from 'antd'
import {
  ArrowLeftOutlined, TeamOutlined, SettingOutlined,
  StopOutlined, CopyOutlined, RobotOutlined,
  ReloadOutlined, ExpandOutlined, CompressOutlined,
  CustomerServiceOutlined, ClearOutlined,
  UndoOutlined, RedoOutlined, DownloadOutlined,
} from '@ant-design/icons'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/authStore'
import { useWhiteboardStore } from '../stores/whiteboardStore'
import { WhiteboardCanvas } from '../components/whiteboard/WhiteboardCanvas'
import { AIPanel } from '../components/whiteboard/AIPanel'
import { useWhiteboardWS } from '../hooks/useWhiteboardWS'
import * as whiteboardApi from '../api/whiteboard'
import apiClient from '../api/client'
import type { Editor } from 'tldraw'
import type { WhiteboardMode, WhiteboardMember } from '../types'

const { Title, Text } = Typography

const WhiteboardRoomPage: React.FC = () => {
  const { t } = useTranslation('discussion')
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
  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  const editorRef = useRef<Editor | null>(null)

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
        setMode(room.mode as WhiteboardMode)
        setRoom(room)
      } catch {
        message.error(t('roomNotFound'))
        navigate('/whiteboard')
      }
    }
    load()
    // 注册当前用户进入房间（HTTP 方式，WS 不通时仍能被识别）
    whiteboardApi.registerToRoom(rid).catch(() => {})
  }, [rid, navigate])

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
      const timer = setTimeout(() => loadMembers(), 0)
      const interval = setInterval(loadMembers, 10000)
      return () => {
        clearTimeout(timer)
        clearInterval(interval)
      }
    }
  }, [isTeacher, loadMembers])

  // ── WebSocket 消息 ──
  // ★ 解构出稳定的 store setter，避免整个 wb 对象作为依赖
  const setMode = wb.setMode
  const setRoom = wb.setRoom

  useEffect(() => {
    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'member_joined' || msg.type === 'member_left') {
        setOnlineCount(msg.online_count as number)
        if (isTeacher) loadMembers()
      }
      if (msg.type === 'mode_changed') {
        setModeState(msg.mode as WhiteboardMode)
        setMode(msg.mode as WhiteboardMode)
      }
      if (msg.type === 'student_submitted') {
        message.success(t('studentSubmitted', { username: msg.username }))
        if (isTeacher) loadMembers()
      }
      if (msg.type === 'room_ended') {
        message.info(t('roomEnded'))
        setRoomStatus('ended')
      }
      // 学生：收到授权/收回通知
      if (msg.type === 'control_granted') {
        setGrantedToMe(true)
        message.success(t('authorizedToEdit'))
      }
      if (msg.type === 'control_revoked') {
        setGrantedToMe(false)
        message.info(t('editRevoked'))
      }
    })
    return unsub
  }, [ws, isTeacher, setMode, loadMembers])

  // ── 操作 ──
  const handleModeChange = async (newMode: string) => {
    try {
      await whiteboardApi.updateRoom(rid, { mode: newMode })
      setModeState(newMode as WhiteboardMode)
      setMode(newMode as WhiteboardMode)
      ws.send({ type: 'mode_change', mode: newMode })
      message.success(t('modeSwitched'))
    } catch {
      message.error(t('switchFailed'))
    }
  }

  const handleEnd = async () => {
    Modal.confirm({
      title: t('confirmEndWhiteboard'),
      content: t('endWhiteboardHint'),
      onOk: async () => {
        try {
          await whiteboardApi.endRoom(rid)
          setRoomStatus('ended')
          message.success(t('wbEnded'))
        } catch {
          message.error(t('wbOpFailed'))
        }
      },
    })
  }

  const handleSpotlight = async (username: string) => {
    try {
      await whiteboardApi.spotlightStudent(rid, username)
      setSelectedStudent(username)
      message.info(t('spotlighted', { username: username }))
    } catch {
      message.error(t('screenCastFailed'))
    }
  }

  const handleGrantControl = async (username: string) => {
    try {
      await whiteboardApi.grantControl(rid, username)
      message.success(t('grantedControl', { username: username }))
      loadMembers()
    } catch {
      message.error(t('authFailed'))
    }
  }

  const handleRevokeControl = async (username: string) => {
    try {
      await whiteboardApi.revokeControl(rid, username)
      message.success(t('editRevoked'))
      loadMembers()
    } catch {
      message.error(t('operationFailed'))
    }
  }

  const toggleFullscreen = () => {
    setFullscreen(!fullscreen)
  }

  // ── 清空白板 ──
  const handleClearBoard = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const shapeIds = editor.getCurrentPageShapeIds()
    if (shapeIds.size === 0) {
      message.info(t('whiteboardAlreadyEmpty'))
      return
    }
    Modal.confirm({
      title: t('clearWhiteboard'),
      content: t('confirmClearShapes', { count: shapeIds.size }),
      okText: t('clear'),
      okType: 'danger',
      cancelText: t('cancel'),
      onOk: () => {
        editor.deleteShapes(Array.from(shapeIds))
        message.success(t('whiteboardCleared'))
      },
    })
  }, [])

  // ── 撤销/恢复 ──
  const handleUndo = useCallback(() => {
    editorRef.current?.undo()
  }, [])

  const handleRedo = useCallback(() => {
    editorRef.current?.redo()
  }, [])

  // ── 导出板书总结 ──
  const handleExportSummary = useCallback(async () => {
    message.loading({ content: t('exportingBoard'), key: 'exportBoard' })
    try {
      const token = localStorage.getItem('smartkb_token') || ''
      const response = await fetch(`/api/whiteboard/ai/export-summary/${rid}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!response.ok) {
        const err = await response.json().catch(() => ({ detail: t('exportFailed') }))
        throw new Error(err.detail || `HTTP ${response.status}`)
      }
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${t('wbBoardSummary')}_${roomTitle}.docx`
      a.click()
      window.URL.revokeObjectURL(url)
      message.success({ content: t('boardExported'), key: 'exportBoard' })
    } catch (err: any) {
      message.error({ content: err.message || t('exportFailed'), key: 'exportBoard' })
    }
  }, [rid, roomTitle])

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
      height: fullscreen ? '100vh' : '100%',
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
                { value: 'demo', label: t('wbModeDemo') },
                { value: 'interactive', label: t('wbModeInter') },
                { value: 'self_study', label: t('wbModeSelf') },
              ]}
            />
          )}
          {isTeacher && (
            <Button icon={<TeamOutlined />} onClick={() => setMembersOpen(true)}>
              {t('wbMembers')} ({onlineCount})
            </Button>
          )}
          {isTeacher && (
            <Tooltip title={t('wbUndo')}>
              <Button
                type="text"
                icon={<UndoOutlined />}
                onClick={handleUndo}
              />
            </Tooltip>
          )}
          {isTeacher && (
            <Tooltip title={t('wbRedo')}>
              <Button
                type="text"
                icon={<RedoOutlined />}
                onClick={handleRedo}
              />
            </Tooltip>
          )}
          <Tooltip title={t('wbFullscreen')}>
            <Button
              type="text"
              icon={fullscreen ? <CompressOutlined /> : <ExpandOutlined />}
              onClick={toggleFullscreen}
            />
          </Tooltip>
          <Tooltip title={t('wbCopyCode')}>
            <Button
              type="text"
              icon={<CopyOutlined />}
              onClick={() => {
                navigator.clipboard.writeText(roomCode)
                message.success(t('copied'))
              }}
            />
          </Tooltip>
          {isTeacher && (
            <Tooltip title={t('wbExportWord')}>
              <Button
                type="text"
                icon={<DownloadOutlined />}
                onClick={handleExportSummary}
              />
            </Tooltip>
          )}
          {isTeacher && (
            <Tooltip title={t('wbClear')}>
              <Button
                type="text"
                icon={<ClearOutlined />}
                onClick={handleClearBoard}
              />
            </Tooltip>
          )}
          {isTeacher && (
            <Tooltip title={t('wbAiAssistant')}>
              <Button
                type={aiPanelOpen ? 'primary' : 'text'}
                icon={<CustomerServiceOutlined />}
                onClick={() => setAiPanelOpen(!aiPanelOpen)}
              >
                AI
              </Button>
            </Tooltip>
          )}
          {isTeacher && roomStatus === 'active' && (
            <Button danger icon={<StopOutlined />} onClick={handleEnd}>{t('end')}</Button>
          )}
        </Space>
      </div>

      {/* ── 主区域：白板 + AI 面板（占位模式） ── */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'row' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <WhiteboardCanvas roomId={rid} readOnly={readOnly} isBroadcaster={isTeacher} ws={ws} externalEditorRef={editorRef} />
        </div>
        <AIPanel
          roomId={rid}
          visible={aiPanelOpen}
          onClose={() => {
            setAiPanelOpen(false)
            // 关闭面板后触发 TLDraw 重新计算布局，修复 HTTPS 下工具栏消失
            setTimeout(() => window.dispatchEvent(new Event('resize')), 150)
          }}
          editorRef={editorRef}
          isTeacher={isTeacher}
          kpName={wb.room?.course_kp_id ? `知识点#${wb.room.course_kp_id}` : ''}
          subject="通用技术"
        />
      </div>

      {/* ── 底部状态栏 ── */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '4px 16px', borderTop: '1px solid #f0f0f0',
        background: '#fafafa', flexShrink: 0, fontSize: 12, color: '#888',
      }}>
        <span>
          {readOnly ? '👁 ' + t('wbReadonly') : '✏️ ' + t('wbEditable')}
          {' '}|{' '}
          {mode === 'demo' && t('wbDemoHint')}
          {mode === 'demo' && isTeacher && <span style={{ color: '#faad14' }}>{t('wbDemoHint2')}</span>}
          {mode === 'interactive' && t('wbModeInterHint')}
          {mode === 'self_study' && t('wbModeSelfHint')}
        </span>
        <span>
          {ws.isConnected ? '\ud83d\udfe2 ' + t('wbConnected') : <Tooltip title={t('wbPollTip')}>\u26a1 {t('wbPollConnected')}</Tooltip>}
        </span>
      </div>

      {/* ── 成员侧栏 ── */}
      <Drawer
        title={t('members')}
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
                    {t('wbRevoke')}
                  </Button>
                ) : (
                  <Button size="small" type="primary" onClick={() => handleGrantControl(m.username)}>
                    {t('wbGrant')}
                  </Button>
                )}
              </Space>
            )}
            {isTeacher && mode === 'self_study' && (
              <Space>
                {m.self_snapshot && <Tag color="green">{t('wbSubmitted')}</Tag>}
                <Button size="small" onClick={() => handleSpotlight(m.username)}>
                  {t('wbView')}
                </Button>
              </Space>
            )}
          </div>
        ))}
        {members.length === 0 && <Text type="secondary">{t('noMembers')}</Text>}
      </Drawer>
    </div>
  )
}

export default WhiteboardRoomPage
