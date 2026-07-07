import React, { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Card, Row, Col, Tag, Space, Typography, Spin, Empty,
  Button, List, Progress, Segmented, Badge, Tooltip,
} from 'antd'
import {
  FileAddOutlined, CheckCircleOutlined, ExperimentOutlined, CodeOutlined,
  BookOutlined, ThunderboltOutlined, BarChartOutlined, TeamOutlined,
  EditOutlined, CustomerServiceOutlined, FireOutlined,
  MessageOutlined, BellOutlined, ClockCircleOutlined,
  RightOutlined, ReloadOutlined, AlertOutlined,
  FolderOutlined, TrophyOutlined, CalendarOutlined,
} from '@ant-design/icons'
import { getTaskTodo } from '../api/taskTodo'
import type { TaskTodoItem, TaskTodoResponse } from '../api/taskTodo'

const { Text, Paragraph } = Typography

// ── 类型→分类映射（无需翻译） ──
const TYPE_CATEGORY: Record<string, string> = {
  exam: 'exam', task: 'exam', practice: 'exam', code: 'exam',
  course_practice: 'curriculum',
  quiz: 'interactive', poll: 'interactive', discussion: 'interactive',
  whiteboard: 'interactive', quick_quiz: 'interactive',
  question_waiting: 'interactive', question_can_answer: 'interactive',
  quest: 'exam', wrong_book: 'exam',
  shared_resource: 'challenge', notification: 'service',
}

const TaskTodoPage: React.FC = () => {
  const navigate = useNavigate()
  const { t } = useTranslation('dashboard')
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<TaskTodoResponse | null>(null)
  const [filter, setFilter] = useState('all')
  // 每个分组的当前页码
  const [groupPages, setGroupPages] = useState<Record<string, number>>({
    overdue: 1, urgent: 1, pending: 1, inProgress: 1,
  })

  // ── 类型配置映射 ──
  const TYPE_CONFIG: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
    exam:            { icon: <FileAddOutlined />, color: '#1677ff', label: t('todo.type.exam') },
    task:            { icon: <CheckCircleOutlined />, color: '#faad14', label: t('todo.type.task') },
    practice:        { icon: <ExperimentOutlined />, color: '#52c41a', label: t('todo.type.practice') },
    code:            { icon: <CodeOutlined />, color: '#2f54eb', label: t('todo.type.code') },
    course_practice: { icon: <BookOutlined />, color: '#13c2c2', label: t('todo.type.course_practice') },
    quiz:            { icon: <ThunderboltOutlined />, color: '#ff4d4f', label: t('todo.type.quiz') },
    poll:            { icon: <BarChartOutlined />, color: '#722ed1', label: t('todo.type.poll') },
    discussion:      { icon: <TeamOutlined />, color: '#1677ff', label: t('todo.type.discussion') },
    whiteboard:      { icon: <EditOutlined />, color: '#eb2f96', label: t('todo.type.whiteboard') },
    quick_quiz:      { icon: <CustomerServiceOutlined />, color: '#fa8c16', label: t('todo.type.quick_quiz') },
    quest:           { icon: <FireOutlined />, color: '#ff4d4f', label: t('todo.type.quest') },
    wrong_book:      { icon: <BookOutlined />, color: '#fa8c16', label: t('todo.type.wrong_book') },
    question_waiting:{ icon: <MessageOutlined />, color: '#fa541c', label: t('todo.type.question_waiting') },
    question_can_answer:{ icon: <MessageOutlined />, color: '#52c41a', label: t('todo.type.question_can_answer') },
    shared_resource:{ icon: <FolderOutlined />, color: '#52c41a', label: t('todo.type.shared_resource') },
    notification:    { icon: <BellOutlined />, color: '#eb2f96', label: t('todo.type.notification') },
  }

  // ── 分类汇总 ──
  const CATEGORY_LABELS: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
    exam:        { label: t('todo.category.exam'), color: '#1677ff', icon: <FileAddOutlined /> },
    curriculum:  { label: t('todo.category.curriculum'), color: '#13c2c2', icon: <BookOutlined /> },
    interactive: { label: t('todo.category.interactive'), color: '#ff4d4f', icon: <ThunderboltOutlined /> },
    challenge:   { label: t('todo.category.challenge'), color: '#52c41a', icon: <FolderOutlined /> },
    service:     { label: t('todo.category.service'), color: '#8c8c8c', icon: <BellOutlined /> },
  }

  // ── 筛选选项 ──
  const FILTER_OPTIONS = [
    { key: 'all', label: t('todo.filter.all') },
    { key: 'urgent', label: t('todo.filter.urgent') },
    { key: 'exam', label: t('todo.filter.exam') },
    { key: 'curriculum', label: t('todo.filter.curriculum') },
    { key: 'interactive', label: t('todo.filter.interactive') },
    { key: 'challenge', label: t('todo.filter.challenge') },
    { key: 'service', label: t('todo.filter.service') },
  ]

  const fetchData = async () => {
    setLoading(true)
    try {
      const res = await getTaskTodo()
      setData(res)
    } catch {
      setData({ items: [], counts: {}, stats: { course_progress: 0, completion_rate: 0, accuracy_rate: 0, streak_days: 0 } })
    }
    setLoading(false)
  }

  useEffect(() => { fetchData() }, [])

  // 筛选条件切换时重置页码
  useEffect(() => {
    setGroupPages({ overdue: 1, urgent: 1, pending: 1, inProgress: 1 })
  }, [filter])

  // ── 按筛选条件过滤 ──
  const filteredItems = useMemo(() => {
    if (!data) return []
    if (filter === 'all') return data.items

    if (filter === 'urgent') {
      return data.items.filter(it => {
        if (!it.deadline) return false
        const diff = (new Date(it.deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        return diff <= 3
      })
    }

    return data.items.filter(it => TYPE_CATEGORY[it.type] === filter)
  }, [data, filter])

  // ── 按状态分组 ──
  const groupedItems = useMemo(() => {
    const overdue: TaskTodoItem[] = []
    const urgent: TaskTodoItem[] = []
    const pending: TaskTodoItem[] = []
    const inProgress: TaskTodoItem[] = []

    for (const item of filteredItems) {
      if (item.deadline && new Date(item.deadline).getTime() < Date.now()) {
        overdue.push(item)
      } else if (item.deadline) {
        const diff = (new Date(item.deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        if (diff <= 3) {
          urgent.push(item)
        } else {
          pending.push(item)
        }
      } else if (item.status === 'in_progress') {
        inProgress.push(item)
      } else {
        pending.push(item)
      }
    }

    return { overdue, urgent, pending, inProgress }
  }, [filteredItems])

  // ── 渲染单个待办项 ──
  const renderItem = (item: TaskTodoItem) => {
    const cfg = TYPE_CONFIG[item.type] || { icon: <BellOutlined />, color: '#999', label: item.type }
    const cat = CATEGORY_LABELS[TYPE_CATEGORY[item.type]] || CATEGORY_LABELS.other
    let deadlineText = ''
    let deadlineColor = 'rgba(0,0,0,0.45)'
    if (item.deadline) {
      const diff = (new Date(item.deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      if (diff < 0) {
        deadlineText = t('todo.deadline.overdue', { days: Math.abs(Math.round(diff)) })
        deadlineColor = '#ff4d4f'
      } else if (diff < 1) {
        deadlineText = t('todo.deadline.today', { hours: Math.round(diff * 24) })
        deadlineColor = '#fa8c16'
      } else if (diff <= 3) {
        deadlineText = t('todo.deadline.remaining', { days: Math.round(diff) })
        deadlineColor = '#faad14'
      } else {
        deadlineText = `${item.deadline.slice(0, 10)}`
        deadlineColor = 'rgba(0,0,0,0.45)'
      }
    }

    const isExternalUrl = item.url.startsWith('/api/')
    return (
      <List.Item
        key={item.id}
        actions={[
          <Button
            type="primary"
            size="small"
            ghost
            icon={<RightOutlined />}
            onClick={() => isExternalUrl ? window.open(item.url, '_blank') : navigate(item.url)}
          >
            {item.action_label}
          </Button>,
        ]}
      >
        <List.Item.Meta
          avatar={
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: `${cfg.color}15`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 18, color: cfg.color,
            }}>
              {cfg.icon}
            </div>
          }
          title={
            <Space size={8} style={{ flexWrap: 'wrap' }}>
              <Text strong style={{ fontSize: 14 }}>{item.title}</Text>
              <Tag color={cfg.color} style={{ fontSize: 11, lineHeight: '18px', borderRadius: 4, margin: 0 }}>
                {cfg.label}
              </Tag>
              {item.deadline && (
                <Text style={{ fontSize: 12, color: deadlineColor }}>
                  <CalendarOutlined style={{ marginRight: 3 }} />
                  {deadlineText}
                </Text>
              )}
            </Space>
          }
          description={
            <Text type="secondary" style={{ fontSize: 13 }}>
              {item.description}
            </Text>
          }
        />
      </List.Item>
    )
  }

  const PAGE_SIZE = 10

  // ── 渲染分组 ──
  const renderGroup = (groupKey: string, title: string, icon: React.ReactNode, color: string, items: TaskTodoItem[]) => {
    if (items.length === 0) return null
    const current = groupPages[groupKey] || 1
    const start = (current - 1) * PAGE_SIZE
    const pageItems = items.slice(start, start + PAGE_SIZE)
    return (
      <Card
        size="small"
        style={{ marginBottom: 16, borderRadius: 8 }}
        title={
          <Space>
            <span style={{ color }}>{icon}</span>
            <Text strong>{title}</Text>
            <Tag style={{ fontSize: 11, borderRadius: 8 }}>{items.length}</Tag>
          </Space>
        }
      >
        <List
          size="small"
          dataSource={pageItems}
          renderItem={renderItem}
          style={{ background: '#fff', borderRadius: 6 }}
          pagination={items.length > PAGE_SIZE ? {
            current,
            pageSize: PAGE_SIZE,
            total: items.length,
            showSizeChanger: true,
            showTotal: (total) => t('todo.paginationTotal', { count: total }),
            pageSizeOptions: ['10', '20', '50'],
            onChange: (p) => setGroupPages(prev => ({ ...prev, [groupKey]: p })),
            size: 'small',
          } : undefined}
        />
      </Card>
    )
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 400 }}>
        <Spin size="large" description={t('todo.loading')} />
      </div>
    )
  }

  if (!data) {
    return <Empty description={t('todo.loadFailed')} />
  }

  const totalCount = data.items.length

  return (
    <Card style={{ borderRadius: 8 }}>
      {/* ─── 页头 ─── */}
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
        <Col>
          <Space>
            <span style={{ fontSize: 20, fontWeight: 600 }}>{t('todo.title')}</span>
            <Tag style={{ fontSize: 13, padding: '0 12px', borderRadius: 8 }}>
              {t('todo.itemCount', { count: totalCount })}
            </Tag>
          </Space>
        </Col>
        <Col>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={fetchData} size="small">
              {t('todo.refresh')}
            </Button>
          </Space>
        </Col>
      </Row>

      {/* ─── 统计卡片（5 大分类，flex 居中平均分布） ─── */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, width: '100%' }}>
        {Object.entries(CATEGORY_LABELS).map(([key, cfg]) => {
          const count = data.counts[key] || 0
          return (
            <div key={key} style={{ flex: 1, minWidth: 0 }}>
              <Card
                hoverable
                size="small"
                onClick={() => setFilter(key)}
                style={{
                  borderRadius: 8,
                  border: filter === key ? `2px solid ${cfg.color}` : '1px solid #f0f0f0',
                }}
                styles={{ body: { padding: '12px 16px' } }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <Text type="secondary" style={{ fontSize: 12 }}>{cfg.label}</Text>
                    <div style={{ fontSize: 24, fontWeight: 600, color: cfg.color, lineHeight: 1.3 }}>
                      {count}
                    </div>
                  </div>
                  <span style={{ fontSize: 28, color: `${cfg.color}30` }}>{cfg.icon}</span>
                </div>
              </Card>
            </div>
          )
        })}
      </div>

      {/* ─── 筛选栏 ─── */}
      <Card size="small" style={{ marginBottom: 16, borderRadius: 8 }}>
        <Segmented
          value={filter}
          onChange={(val) => setFilter(val as string)}
          options={FILTER_OPTIONS.map(opt => ({
            label: opt.key === 'all'
              ? t('todo.filter.allCount', { count: totalCount })
              : opt.label,
            value: opt.key,
          }))}
          style={{ borderRadius: 6 }}
        />
      </Card>

      {/* ─── 待办列表 ─── */}
      {filteredItems.length === 0 ? (
        <Card style={{ borderRadius: 8 }}>
          <Empty description={t('todo.empty')} />
        </Card>
      ) : (
        <>
          {renderGroup('overdue', t('todo.group.overdue'), <AlertOutlined />, '#ff4d4f', groupedItems.overdue)}
          {renderGroup('urgent', t('todo.group.urgent'), <ClockCircleOutlined />, '#fa8c16', groupedItems.urgent)}
          {renderGroup('pending', t('todo.group.pending'), <FileAddOutlined />, '#1677ff', groupedItems.pending)}
          {renderGroup('inProgress', t('todo.group.inProgress'), <FireOutlined />, '#722ed1', groupedItems.inProgress)}
        </>
      )}

      {/* ─── 学习进度概览 ─── */}
      {data.stats && (
        <Card
          size="small"
          style={{ borderRadius: 8, marginTop: 8 }}
          title={
            <Space>
              <TrophyOutlined style={{ color: '#faad14' }} />
              <Text strong>{t('todo.stats.title')}</Text>
            </Space>
          }
        >
          <Row gutter={[16, 16]}>
            <Col xs={12} sm={6}>
              <div style={{ textAlign: 'center' }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('todo.stats.courseProgress')}</Text>
                <Progress
                  type="dashboard"
                  percent={data.stats.course_progress || 0}
                  size={80}
                  strokeColor="#1677ff"
                />
              </div>
            </Col>
            <Col xs={12} sm={6}>
              <div style={{ textAlign: 'center' }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('todo.stats.completionRate')}</Text>
                <Progress
                  type="dashboard"
                  percent={data.stats.completion_rate || 0}
                  size={80}
                  strokeColor="#52c41a"
                />
              </div>
            </Col>
            <Col xs={12} sm={6}>
              <div style={{ textAlign: 'center' }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('todo.stats.accuracyRate')}</Text>
                <Progress
                  type="dashboard"
                  percent={data.stats.accuracy_rate || 0}
                  size={80}
                  strokeColor="#722ed1"
                  format={(pct) => `${pct}%`}
                />
              </div>
            </Col>
            <Col xs={12} sm={6}>
              <div style={{ textAlign: 'center', paddingTop: 8 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('todo.stats.streakDays')}</Text>
                <div style={{ fontSize: 28, fontWeight: 700, color: '#fa8c16' }}>
                  {data.stats.streak_days || 0}
                  <Text style={{ fontSize: 14, color: '#fa8c16', marginLeft: 4 }}>{t('todo.stats.streakDaysUnit')}</Text>
                </div>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {data.stats.streak_days > 0 ? t('todo.stats.streakActive') : t('todo.stats.streakInactive')}
                </Text>
              </div>
            </Col>
          </Row>
        </Card>
      )}
    </Card>
  )
}

export default TaskTodoPage
