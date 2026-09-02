/**
 * 协作白板主页面 — 教师创建/管理房间
 */
import React, { useState, useEffect, useCallback } from 'react'
import {
  Card, Button, Space, Typography, Table, Tag, Modal, Input, Select,
  message, Popconfirm, Tooltip, Tabs, Radio, Row, Col,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  PlusOutlined, CopyOutlined, PlayCircleOutlined,
  StopOutlined, DeleteOutlined, ReloadOutlined,
  EyeOutlined, EditOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/authStore'
import * as whiteboardApi from '../api/whiteboard'
import type { WhiteboardRoom, WhiteboardMode } from '../types'

const { Title, Text } = Typography

const WhiteboardPage: React.FC = () => {
  const { t } = useTranslation('discussion')
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const isTeacher = user?.role === 'admin' || user?.role === 'teacher'
  const isStudent = user?.role === 'student'

  const [rooms, setRooms] = useState<WhiteboardRoom[]>([])
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [joinOpen, setJoinOpen] = useState(false)

  // 创建表单
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<WhiteboardMode>('demo')
  const [roomType, setRoomType] = useState<'classroom' | 'course' | 'temporary'>('classroom')
  const [creating, setCreating] = useState(false)

  // 加入表单
  const [joinCode, setJoinCode] = useState('')
  const [joining, setJoining] = useState(false)

  const loadRooms = useCallback(async () => {
    setLoading(true)
    try {
      const data = await whiteboardApi.listRooms(1, 50)
      setRooms(data)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadRooms()
  }, [loadRooms])

  // ── 创建房间 ──
  const handleCreate = async () => {
    if (!title.trim()) {
      message.warning(t('titleRequired'))
      return
    }
    setCreating(true)
    try {
      const res = await whiteboardApi.createRoom({
        title: title.trim(),
        mode,
        room_type: roomType,
      })
      message.success(t('roomCreated', { code: res.room_code }))
      setCreateOpen(false)
      setTitle('')
      loadRooms()

      // 教师自动进入房间
      navigate(`/whiteboard-room/${res.id}`)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('createFailed'))
    } finally {
      setCreating(false)
    }
  }

  // ── 编辑房间 ──
  const [editOpen, setEditOpen] = useState(false)
  const [editingRoom, setEditingRoom] = useState<WhiteboardRoom | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editMode, setEditMode] = useState<WhiteboardMode>('demo')
  const [editing, setEditing] = useState(false)

  const handleEditOpen = (record: WhiteboardRoom) => {
    setEditingRoom(record)
    setEditTitle(record.title)
    setEditMode(record.mode as WhiteboardMode)
    setEditOpen(true)
  }

  const handleEdit = async () => {
    if (!editingRoom || !editTitle.trim()) {
      message.warning(t('titleRequired'))
      return
    }
    setEditing(true)
    try {
      await whiteboardApi.updateRoom(editingRoom.id, {
        title: editTitle.trim(),
        mode: editMode,
      })
      message.success(t('whiteboardUpdated'))
      setEditOpen(false)
      loadRooms()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('updateFailed'))
    } finally {
      setEditing(false)
    }
  }

  // ── 加入房间（学生）──
  const handleJoin = async () => {
    if (!joinCode.trim()) {
      message.warning(t('enterRoomCode'))
      return
    }
    setJoining(true)
    try {
      const res = await whiteboardApi.joinByCode(joinCode.trim().toUpperCase())
      message.success(t('joinedRoom', { title: res.title }))
      setJoinOpen(false)
      setJoinCode('')
      navigate(`/whiteboard-room/${res.room_id}`)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('joinFailed'))
    } finally {
      setJoining(false)
    }
  }

  // ── 结束房间 ──
  const handleEnd = async (roomId: number) => {
    try {
      await whiteboardApi.endRoom(roomId)
      message.success(t('roomEnded'))
      loadRooms()
    } catch {
      message.error(t('operationFailed'))
    }
  }

  // ── 删除房间 ──
  const handleDelete = async (roomId: number) => {
    try {
      await whiteboardApi.deleteRoom(roomId)
      message.success(t('deleted'))
      loadRooms()
    } catch {
      message.error(t('deleteFailed'))
    }
  }

  const modeLabels: Record<string, { color: string; label: string }> = {
    demo: { color: 'blue', label: t('demo') },
    interactive: { color: 'orange', label: t('interactive') },
    self_study: { color: 'purple', label: t('selfStudy') },
  }

  const columns: ColumnsType<WhiteboardRoom> = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 60 },
    { title: t('roomCode'), dataIndex: 'room_code', key: 'room_code', width: 120,
      render: (code: string) => (
        <Space>
          <Tag color="blue" style={{ fontFamily: 'monospace' }}>{code}</Tag>
          <Tooltip title={t('copyRoomCode')}>
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={() => {
                navigator.clipboard.writeText(code)
                message.success(t('roomCodeCopied'))
              }}
            />
          </Tooltip>
        </Space>
      ),
    },
    { title: t('title'), dataIndex: 'title', key: 'title' },
    { title: t('creator'), dataIndex: 'creator_name', key: 'creator_name', width: 100,
      render: (n: string) => n || '-',
    },
    { title: t('mode'), dataIndex: 'mode', key: 'mode', width: 80,
      render: (m: string) => (
        <Tag color={modeLabels[m]?.color}>{modeLabels[m]?.label || m}</Tag>
      ),
    },
    { title: t('status'), dataIndex: 'status', key: 'status', width: 80,
      render: (s: string) => (
        <Tag color={s === 'active' ? 'green' : 'default'}>
          {s === 'active' ? t('active') : t('ended')}
        </Tag>
      ),
    },
    { title: t('participantCount'), dataIndex: 'student_count', key: 'student_count', width: 80 },
    { title: t('createdAt'), dataIndex: 'created_at', key: 'created_at', width: 160,
      render: (t: string) => t?.replace('T', ' ').substring(0, 19) || '-',
    },
    {
      title: t('actions'), key: 'actions', width: 120,
      render: (_, record) => (
        <Space>
          <Tooltip title={t('wpEnterRoom')}>
            <Button
              size="small"
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={() => navigate(`/whiteboard-room/${record.id}`)}
            />
          </Tooltip>
          {isTeacher && record.status === 'active' && (
            <Popconfirm title={t('wpConfirmEnd')} onConfirm={() => handleEnd(record.id)}>
              <Tooltip title={t('wpEndRoom')}>
                <Button size="small" danger icon={<StopOutlined />} />
              </Tooltip>
            </Popconfirm>
          )}
          {isTeacher && (
            <Tooltip title={t('wpEdit')}>
              <Button size="small" icon={<EditOutlined />} onClick={() => handleEditOpen(record)} />
            </Tooltip>
          )}
          {isTeacher && (
            <Popconfirm title={t('wpConfirmDel')} onConfirm={() => handleDelete(record.id)}>
              <Tooltip title={t('wpDelRoom')}>
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Tooltip>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  return (
    <Card style={{ borderRadius: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>🎨 {t('whiteboard')}</Title>
        <Space>
          {isStudent && (
            <Tooltip title={t('wpJoin')}>
              <Button type="default" icon={<EyeOutlined />} onClick={() => setJoinOpen(true)} />
            </Tooltip>
          )}
          {isTeacher && (
            <Tooltip title={t('wpCreate')}>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)} />
            </Tooltip>
          )}
          <Tooltip title={t('wpRefresh')}>
            <Button icon={<ReloadOutlined />} onClick={loadRooms} />
          </Tooltip>
        </Space>
      </div>

      <Table
        columns={columns}
        dataSource={rooms}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 20 }}
        locale={{ emptyText: t('noWhiteboards') }}
      />

      {/* ── 创建房间弹窗 ── */}
      <Modal
        title={t('createWhiteboard')}
        open={createOpen}
        onOk={handleCreate}
        onCancel={() => { setCreateOpen(false); setTitle('') }}
        confirmLoading={creating}
        okText={t('wpCreateBtn')}
        cancelText={t('wpCancel')}
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <div>
            <Text strong>{t('whiteboardTitle')}</Text>
            <Input
              placeholder={t('wpExamplePh')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onPressEnter={handleCreate}
            />
          </div>
          <div>
            <Text strong>{t('usageMode')}</Text>
            <Radio.Group value={mode} onChange={(e) => setMode(e.target.value as WhiteboardMode)} style={{ marginTop: 8 }}>
              <Radio.Button value="demo">{t('demoMode')}</Radio.Button>
              <Radio.Button value="interactive">{t('interactiveMode')}</Radio.Button>
              <Radio.Button value="self_study">{t('selfStudyMode')}</Radio.Button>
            </Radio.Group>
            <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
              {mode === 'demo' && t('demoModeDesc')}
              {mode === 'interactive' && t('interactiveModeDesc')}
              {mode === 'self_study' && t('selfStudyModeDesc')}
            </div>
          </div>
          <div>
            <Text strong>{t('roomType')}</Text>
            <Select
              value={roomType}
              onChange={(val) => setRoomType(val as 'classroom' | 'course' | 'temporary')}
              style={{ width: '100%', marginTop: 8 }}
              options={[
                { value: 'classroom', label: t('classroomWhiteboard') },
                { value: 'temporary', label: t('temporaryWhiteboard') },
                { value: 'course', label: t('courseWhiteboard') },
              ]}
            />
          </div>
        </Space>
      </Modal>

      {/* ── 学生加入弹窗 ── */}
      <Modal
        title={t('whiteboardRoom')}
        open={joinOpen}
        onOk={handleJoin}
        onCancel={() => { setJoinOpen(false); setJoinCode('') }}
        confirmLoading={joining}
        okText={t('join')}
        cancelText={t('cancel')}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Text>{t('enterRoomCodeHint')}</Text>
          <Input
            size="large"
            placeholder={t('roomCodeExample')}
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            onPressEnter={handleJoin}
            maxLength={7}
            style={{ textTransform: 'uppercase', fontFamily: 'monospace', letterSpacing: 2 }}
          />
        </Space>
      </Modal>

      {/* ── 编辑房间弹窗 ── */}
      <Modal
        title={t('wpEditPrefix') + t('whiteboardRoom')}
        open={editOpen}
        onOk={handleEdit}
        onCancel={() => setEditOpen(false)}
        confirmLoading={editing}
        okText={t('save')}
        cancelText={t('cancel')}
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <div>
            <Text strong>{t('whiteboardTitle')}</Text>
            <Input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onPressEnter={handleEdit}
            />
          </div>
          <div>
            <Text strong>{t('usageMode')}</Text>
            <Radio.Group value={editMode} onChange={(e) => setEditMode(e.target.value as WhiteboardMode)} style={{ marginTop: 8 }}>
              <Radio.Button value="demo">{t('demoMode')}</Radio.Button>
              <Radio.Button value="interactive">{t('interactiveMode')}</Radio.Button>
              <Radio.Button value="self_study">{t('selfStudyMode')}</Radio.Button>
            </Radio.Group>
            <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
              {editMode === 'demo' && t('demoModeDesc')}
              {editMode === 'interactive' && t('interactiveModeDesc')}
              {editMode === 'self_study' && t('selfStudyModeDesc')}
            </div>
          </div>
        </Space>
      </Modal>
    </Card>
  )
}

export default WhiteboardPage
