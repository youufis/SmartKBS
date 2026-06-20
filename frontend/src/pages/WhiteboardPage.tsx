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
import { useAuthStore } from '../stores/authStore'
import * as whiteboardApi from '../api/whiteboard'
import type { WhiteboardRoom, WhiteboardMode } from '../types'

const { Title, Text } = Typography

const WhiteboardPage: React.FC = () => {
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
      message.warning('请输入白板标题')
      return
    }
    setCreating(true)
    try {
      const res = await whiteboardApi.createRoom({
        title: title.trim(),
        mode,
        room_type: roomType,
      })
      message.success(`房间创建成功！房间码：${res.room_code}`)
      setCreateOpen(false)
      setTitle('')
      loadRooms()

      // 教师自动进入房间
      navigate(`/whiteboard-room/${res.id}`)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '创建失败')
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
      message.warning('请输入标题')
      return
    }
    setEditing(true)
    try {
      await whiteboardApi.updateRoom(editingRoom.id, {
        title: editTitle.trim(),
        mode: editMode,
      })
      message.success('白板已更新')
      setEditOpen(false)
      loadRooms()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '更新失败')
    } finally {
      setEditing(false)
    }
  }

  // ── 加入房间（学生）──
  const handleJoin = async () => {
    if (!joinCode.trim()) {
      message.warning('请输入房间码')
      return
    }
    setJoining(true)
    try {
      const res = await whiteboardApi.joinByCode(joinCode.trim().toUpperCase())
      message.success(`已加入「${res.title}」`)
      setJoinOpen(false)
      setJoinCode('')
      navigate(`/whiteboard-room/${res.room_id}`)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '加入失败')
    } finally {
      setJoining(false)
    }
  }

  // ── 结束房间 ──
  const handleEnd = async (roomId: number) => {
    try {
      await whiteboardApi.endRoom(roomId)
      message.success('房间已结束')
      loadRooms()
    } catch {
      message.error('操作失败')
    }
  }

  // ── 删除房间 ──
  const handleDelete = async (roomId: number) => {
    try {
      await whiteboardApi.deleteRoom(roomId)
      message.success('已删除')
      loadRooms()
    } catch {
      message.error('删除失败')
    }
  }

  const modeLabels: Record<string, { color: string; label: string }> = {
    demo: { color: 'blue', label: '演示' },
    interactive: { color: 'orange', label: '互动' },
    self_study: { color: 'purple', label: '自习' },
  }

  const columns: ColumnsType<WhiteboardRoom> = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 60 },
    { title: '房间码', dataIndex: 'room_code', key: 'room_code', width: 120,
      render: (code: string) => (
        <Space>
          <Tag color="blue" style={{ fontFamily: 'monospace' }}>{code}</Tag>
          <Tooltip title="复制房间码">
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={() => {
                navigator.clipboard.writeText(code)
                message.success('已复制房间码')
              }}
            />
          </Tooltip>
        </Space>
      ),
    },
    { title: '标题', dataIndex: 'title', key: 'title' },
    { title: '创建人', dataIndex: 'creator_name', key: 'creator_name', width: 100,
      render: (n: string) => n || '-',
    },
    { title: '模式', dataIndex: 'mode', key: 'mode', width: 80,
      render: (m: string) => (
        <Tag color={modeLabels[m]?.color}>{modeLabels[m]?.label || m}</Tag>
      ),
    },
    { title: '状态', dataIndex: 'status', key: 'status', width: 80,
      render: (s: string) => (
        <Tag color={s === 'active' ? 'green' : 'default'}>
          {s === 'active' ? '进行中' : '已结束'}
        </Tag>
      ),
    },
    { title: '参与人数', dataIndex: 'student_count', key: 'student_count', width: 80 },
    { title: '创建时间', dataIndex: 'created_at', key: 'created_at', width: 160,
      render: (t: string) => t?.replace('T', ' ').substring(0, 19) || '-',
    },
    {
      title: '操作', key: 'actions', width: 120,
      render: (_, record) => (
        <Space>
          <Tooltip title="进入房间">
            <Button
              size="small"
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={() => navigate(`/whiteboard-room/${record.id}`)}
            />
          </Tooltip>
          {isTeacher && record.status === 'active' && (
            <Popconfirm title="确定结束此房间？" onConfirm={() => handleEnd(record.id)}>
              <Tooltip title="结束房间">
                <Button size="small" danger icon={<StopOutlined />} />
              </Tooltip>
            </Popconfirm>
          )}
          {isTeacher && (
            <Tooltip title="编辑">
              <Button size="small" icon={<EditOutlined />} onClick={() => handleEditOpen(record)} />
            </Tooltip>
          )}
          {isTeacher && (
            <Popconfirm title="确定删除？" onConfirm={() => handleDelete(record.id)}>
              <Tooltip title="删除房间">
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Tooltip>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: '8px 16px', maxWidth: '100%', margin: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>🎨 白板</Title>
        <Space>
          {isStudent && (
            <Tooltip title="加入白板">
              <Button type="default" icon={<EyeOutlined />} onClick={() => setJoinOpen(true)} />
            </Tooltip>
          )}
          {isTeacher && (
            <Tooltip title="创建白板">
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)} />
            </Tooltip>
          )}
          <Tooltip title="刷新">
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
        locale={{ emptyText: '暂无白板房间' }}
      />

      {/* ── 创建房间弹窗 ── */}
      <Modal
        title="创建白板房间"
        open={createOpen}
        onOk={handleCreate}
        onCancel={() => { setCreateOpen(false); setTitle('') }}
        confirmLoading={creating}
        okText="创建"
        cancelText="取消"
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <div>
            <Text strong>白板标题</Text>
            <Input
              placeholder="例如：串联电路分析"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onPressEnter={handleCreate}
            />
          </div>
          <div>
            <Text strong>使用模式</Text>
            <Radio.Group value={mode} onChange={(e) => setMode(e.target.value as WhiteboardMode)} style={{ marginTop: 8 }}>
              <Radio.Button value="demo">演示模式</Radio.Button>
              <Radio.Button value="interactive">互动模式</Radio.Button>
              <Radio.Button value="self_study">自习模式</Radio.Button>
            </Radio.Group>
            <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
              {mode === 'demo' && '教师独占操作，学生只读观看'}
              {mode === 'interactive' && '教师授权后学生可上台操作'}
              {mode === 'self_study' && '学生各自独立白板，教师巡览'}
            </div>
          </div>
          <div>
            <Text strong>房间类型</Text>
            <Select
              value={roomType}
              onChange={(val) => setRoomType(val as 'classroom' | 'course' | 'temporary')}
              style={{ width: '100%', marginTop: 8 }}
              options={[
                { value: 'classroom', label: '课堂白板' },
                { value: 'temporary', label: '临时白板' },
                { value: 'course', label: '课程白板' },
              ]}
            />
          </div>
        </Space>
      </Modal>

      {/* ── 学生加入弹窗 ── */}
      <Modal
        title="加入白板房间"
        open={joinOpen}
        onOk={handleJoin}
        onCancel={() => { setJoinOpen(false); setJoinCode('') }}
        confirmLoading={joining}
        okText="加入"
        cancelText="取消"
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Text>输入老师提供的6位房间码</Text>
          <Input
            size="large"
            placeholder="例如：WB-3K8Q"
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
        title="编辑白板房间"
        open={editOpen}
        onOk={handleEdit}
        onCancel={() => setEditOpen(false)}
        confirmLoading={editing}
        okText="保存"
        cancelText="取消"
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <div>
            <Text strong>白板标题</Text>
            <Input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onPressEnter={handleEdit}
            />
          </div>
          <div>
            <Text strong>使用模式</Text>
            <Radio.Group value={editMode} onChange={(e) => setEditMode(e.target.value as WhiteboardMode)} style={{ marginTop: 8 }}>
              <Radio.Button value="demo">演示模式</Radio.Button>
              <Radio.Button value="interactive">互动模式</Radio.Button>
              <Radio.Button value="self_study">自习模式</Radio.Button>
            </Radio.Group>
            <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
              {editMode === 'demo' && '教师独占操作，学生只读观看'}
              {editMode === 'interactive' && '教师授权后学生可上台操作'}
              {editMode === 'self_study' && '学生各自独立白板，教师巡览'}
            </div>
          </div>
        </Space>
      </Modal>
    </div>
  )
}

export default WhiteboardPage
