/**
 * 协作白板主页面 — 教师创建/管理房间
 */
import React, { useState, useEffect, useCallback } from 'react'
import {
  Card, Button, Space, Typography, Tag, Modal, Input, Select, Pagination,
  message, Popconfirm, Tooltip, Radio, Empty, Spin,
} from 'antd'
import {
  PlusOutlined, CopyOutlined, PlayCircleOutlined,
  StopOutlined, DeleteOutlined, ReloadOutlined,
  EyeOutlined, EditOutlined, UnlockOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/authStore'
import * as whiteboardApi from '../api/whiteboard'
import type { WhiteboardRoom, WhiteboardMode } from '../types'
import ScopeTag from '../components/ScopeTag'
import { RowList } from '../components/RowList'
import ActivityScopeSelector, { type ActivityScopeValue } from '../components/ActivityScopeSelector'

const { Title, Text } = Typography

const WhiteboardPage: React.FC = () => {
  const { t } = useTranslation('discussion')
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const isTeacher = user?.role === 'admin' || user?.role === 'teacher'
  const isAdmin = user?.role === 'admin'
  const isStudent = user?.role === 'student'

  const [rooms, setRooms] = useState<WhiteboardRoom[]>([])
  const [loading, setLoading] = useState(false)
  // 卡片列表自己管分页（原来是 Table 内置分页）
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [createOpen, setCreateOpen] = useState(false)
  const [joinOpen, setJoinOpen] = useState(false)

  // 创建表单
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<WhiteboardMode>('demo')
  const [roomType, setRoomType] = useState<'classroom' | 'course' | 'temporary'>('classroom')
  // 与考试/测验/投票统一的活动目标范围(谁能看到这块白板)
  const [roomScope, setRoomScope] = useState<ActivityScopeValue>({
    target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '',
  })
  const [creating, setCreating] = useState(false)

  // 加入表单
  const [joinCode, setJoinCode] = useState('')
  const [joining, setJoining] = useState(false)

  const loadRooms = useCallback(async () => {
    setLoading(true)
    try {
      const data = await whiteboardApi.listRooms(1, 50)
      // 进行中的排前面：老师点开列表要找的是"这节课能用哪个"，不是一堆历史房间
      const rank = (r: WhiteboardRoom) => (r.status === 'active' ? 0 : 1)
      setRooms([...data].sort((a, b) => rank(a) - rank(b) || b.id - a.id))
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
        ...roomScope,
      })
      // 白板用自己的文案键：discussion 命名空间的 roomCreated 是"讨论室已创建"（同键串味）
      message.success(t('wbRoomCreated', { code: res.room_code }))
      setCreateOpen(false)
      setTitle('')
      setRoomScope({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' })
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

  // ── 重新开启房间（已结束的房间学生端不可见，教师也连不上）──
  const handleReopen = async (roomId: number) => {
    try {
      await whiteboardApi.reopenRoom(roomId)
      message.success(t('wbReopened'))
      loadRooms()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('wbReopenFailed'))
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

  // 卡片列表（与随堂测验/抢答/同步练习/活动监控/考试中心同款）：
  // 这张表 10 列（ID + 房间码 + 标题 + 创建者 + 范围 + 模式 + 状态 + 人数 + 时间 + 5 个操作），
  // 窄窗必然横向滚动、操作被挤到第二行；卡片不挑列宽，操作图标一定在同一行。
  const fmtRoomTime = (v?: string) => (v ? String(v).replace('T', ' ').substring(0, 19) : '-')

  const renderRoomCard = (record: WhiteboardRoom) => {
    const inRoom = record.status === 'active'
    const meta = modeLabels[record.mode]
    return (
      <Card size="small" hoverable style={{ marginBottom: 8, cursor: 'pointer' }}
        onClick={() => navigate(`/whiteboard-room/${record.id}`)}>
        <div className="page-header-flex stack-row"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Space size={8} align="center" wrap>
              <Text strong>{record.title || t('whiteboardTitle')}</Text>
              <Tag color={inRoom ? 'green' : 'default'}>{inRoom ? t('active') : t('ended')}</Tag>
              <Tag color={meta?.color}>{meta?.label || record.mode}</Tag>
            </Space>
            <div style={{ marginTop: 4 }}>
              <Tag color="blue" style={{ fontFamily: 'monospace' }}>{record.room_code}</Tag>
              {/* 复制房间码：行上直接点，不必先点进房间再找 */}
              <Tooltip title={t('copyRoomCode')}>
                <Button type="text" size="small" icon={<CopyOutlined />}
                  onClick={(e) => {
                    e.stopPropagation()
                    navigator.clipboard.writeText(record.room_code)
                    message.success(t('roomCodeCopied'))
                  }} />
              </Tooltip>
              <Tag>{t('creator')}：{record.creator_username || '-'}</Tag>
              {record.target_scope
                ? <ScopeTag scope={record.target_scope} grade={record.target_grade}
                    classes={record.target_class} users={record.target_users} />
                : <ScopeTag variant="text" grade={record.grade} classes={String(record.class_name ?? '')} />}
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('participantCount')} {record.student_count ?? 0}{' · '}{fmtRoomTime(record.created_at)}
              </Text>
            </div>
          </div>
          <span onClick={(e) => e.stopPropagation()}>
            <Space size={2} wrap={false} style={{ whiteSpace: 'nowrap' }}>
              <Tooltip title={inRoom ? t('wpEnterRoom') : t('wpReviewRoom')}>
                <Button size="small" type="primary" icon={<PlayCircleOutlined />}
                  onClick={() => navigate(`/whiteboard-room/${record.id}`)} />
              </Tooltip>
              {isTeacher && !inRoom && (
                <Popconfirm title={t('wbReopenConfirm')} onConfirm={() => handleReopen(record.id)}>
                  <Tooltip title={t('wpReopenRoom')}>
                    <Button size="small" icon={<UnlockOutlined />} />
                  </Tooltip>
                </Popconfirm>
              )}
              {isTeacher && inRoom && (
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
          </span>
        </div>
      </Card>
    )
  }

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

      {loading && rooms.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40 }}><Spin size="large" /></div>
      ) : rooms.length === 0 ? (
        <Empty description={isStudent ? t('noWhiteboardsStudent') : t('noWhiteboards')} />
      ) : (
        <>
          <RowList items={rooms.slice((page - 1) * pageSize, page * pageSize)}
            split={false} renderItem={renderRoomCard} />
          <div style={{ marginTop: 12, textAlign: 'center' }}>
            <Pagination
              current={page} pageSize={pageSize} total={rooms.length}
              showSizeChanger showTotal={(total) => t('wbTotalRooms', { total })}
              pageSizeOptions={['10', '20', '50']}
              onChange={(p, ps) => { setPage(p); setPageSize(ps) }}
              size="small"
            />
          </div>
        </>
      )}

      {/* ── 创建房间弹窗 ── */}
      <Modal maskClosable={false}
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
          <div>
            <ActivityScopeSelector value={roomScope} onChange={setRoomScope} showAllOption={isAdmin} />
          </div>
        </Space>
      </Modal>

      {/* ── 学生加入弹窗 ── */}
      <Modal maskClosable={false}
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
      <Modal maskClosable={false}
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
