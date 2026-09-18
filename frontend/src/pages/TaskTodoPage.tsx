/** 学生任务清单：降噪分组 + 今日聚焦 + 搜索排序 + 已完成回看（深色主题自适应） */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Button, Card, Col, Empty, Input, Progress, Row, Segmented, Select, Space, Spin, Tabs, Tag, Tooltip, Typography,
} from 'antd'
import {
  AlertOutlined, BarChartOutlined, BellOutlined, BookOutlined, CalendarOutlined, CheckCircleOutlined,
  ClockCircleOutlined, CodeOutlined, CustomerServiceOutlined, EditOutlined, ExperimentOutlined,
  FileAddOutlined, FireOutlined, FolderOutlined, MessageOutlined, ReloadOutlined, RightOutlined,
  SearchOutlined, TeamOutlined, ThunderboltOutlined, TrophyOutlined,
} from '@ant-design/icons'
import { getTaskTodo, type DoneRecord, type TaskTodoItem, type TaskTodoResponse } from '../api/taskTodo'
import { deadlineInfo, friendlyTime } from './dashboard/fmt'
import { useChartTheme } from './dashboard/chartTheme'

const { Text, Paragraph } = Typography

/** 类型 → 分类（与导航菜单一致，无需翻译） */
const TYPE_CATEGORY: Record<string, string> = {
  exam: 'exam', task: 'exam', practice: 'exam', code: 'exam', quest: 'exam', wrong_book: 'exam',
  course_practice: 'curriculum',
  quiz: 'interactive', poll: 'interactive', discussion: 'interactive',
  whiteboard: 'interactive', quick_quiz: 'interactive',
  question_waiting: 'interactive', question_can_answer: 'interactive',
  shared_resource: 'challenge',
  notification: 'service',
}

const FOCUS_TYPES = ['exam', 'task', 'wrong_book', 'practice', 'course_practice', 'code']
const GROUP_ORDER = ['overdue', 'urgent', 'live', 'study', 'suggest'] as const
const COLLAPSED = 6
const DONE_COLLAPSED = 10

const LS_FILTER = 'smartkb_todo_cat'
const LS_QUICK = 'smartkb_todo_quick'
const LS_SORT = 'smartkb_todo_sort'

const TaskTodoPage: React.FC = () => {
  const navigate = useNavigate()
  const { t, i18n } = useTranslation('dashboard')
  const ct = useChartTheme()

  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<TaskTodoResponse | null>(null)
  const [cat, setCat] = useState('all')
  const [quick, setQuick] = useState('all')
  const [sort, setSort] = useState('deadline')
  const [kw, setKw] = useState('')
  const [tab, setTab] = useState('todo')
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  const [doneMore, setDoneMore] = useState(false)
  /** 时间基准放在 state 里（渲染期不取时间，避免 purity 告警，同时让倒计时随刷新推进） */
  const [nowMs, setNowMs] = useState(() => Date.parse(new Date().toISOString()))

  const fetchSilent = useCallback(async () => {
    try {
      const res = await getTaskTodo()
      setData(res)
      setNowMs(Date.now())
    } catch {
      setData({ items: [], counts: {}, stats: { course_progress: 0, completion_rate: 0, accuracy_rate: 0, streak_days: 0 }, recent_done: [] })
      setNowMs(Date.now())
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchManual = useCallback(async () => {
    setLoading(true)
    await fetchSilent()
  }, [fetchSilent])

  useEffect(() => {
    fetchSilent()
    // 恢复上次的筛选偏好
    try {
      const c = localStorage.getItem(LS_FILTER)
      const q = localStorage.getItem(LS_QUICK)
      const s = localStorage.getItem(LS_SORT)
      if (c) setCat(c)
      if (q) setQuick(q)
      if (s) setSort(s)
    } catch { /* 忽略隐私模式 */ }
  }, [fetchSilent])

  // 从答题/练习页返回时自动核对，避免最长 30s 缓存造成的“做完了还挂着”
  useEffect(() => {
    const onBack = () => {
      if (document.visibilityState === 'visible') fetchSilent()
    }
    window.addEventListener('focus', onBack)
    document.addEventListener('visibilitychange', onBack)
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => {
      window.removeEventListener('focus', onBack)
      document.removeEventListener('visibilitychange', onBack)
      window.clearInterval(timer)
    }
  }, [fetchSilent])

  useEffect(() => {
    try {
      localStorage.setItem(LS_FILTER, cat)
      localStorage.setItem(LS_QUICK, quick)
      localStorage.setItem(LS_SORT, sort)
    } catch { /* 忽略 */ }
  }, [cat, quick, sort])

  const CATEGORY_LABELS = useMemo<Record<string, { label: string; color: string; icon: React.ReactNode }>>(() => ({
    exam: { label: t('todo.category.exam'), color: '#1677ff', icon: <FileAddOutlined /> },
    curriculum: { label: t('todo.category.curriculum'), color: '#13c2c2', icon: <BookOutlined /> },
    interactive: { label: t('todo.category.interactive'), color: '#ff4d4f', icon: <ThunderboltOutlined /> },
    challenge: { label: t('todo.category.challenge'), color: '#52c41a', icon: <FolderOutlined /> },
    service: { label: t('todo.category.service'), color: '#8c8c8c', icon: <BellOutlined /> },
  }), [t])

  const TYPE_CONFIG = useMemo<Record<string, { icon: React.ReactNode; color: string }>>(() => ({
    exam: { icon: <FileAddOutlined />, color: '#1677ff' },
    task: { icon: <CheckCircleOutlined />, color: '#faad14' },
    practice: { icon: <ExperimentOutlined />, color: '#52c41a' },
    code: { icon: <CodeOutlined />, color: '#2f54eb' },
    course_practice: { icon: <BookOutlined />, color: '#13c2c2' },
    quiz: { icon: <ThunderboltOutlined />, color: '#ff4d4f' },
    poll: { icon: <BarChartOutlined />, color: '#722ed1' },
    discussion: { icon: <TeamOutlined />, color: '#1677ff' },
    whiteboard: { icon: <EditOutlined />, color: '#eb2f96' },
    quick_quiz: { icon: <CustomerServiceOutlined />, color: '#fa8c16' },
    quest: { icon: <FireOutlined />, color: '#ff4d4f' },
    wrong_book: { icon: <BookOutlined />, color: '#fa8c16' },
    question_waiting: { icon: <MessageOutlined />, color: '#fa541c' },
    question_can_answer: { icon: <MessageOutlined />, color: '#52c41a' },
    shared_resource: { icon: <FolderOutlined />, color: '#52c41a' },
    notification: { icon: <BellOutlined />, color: '#eb2f96' },
  }), [])

  const typeLabel = (item: TaskTodoItem) => t(`todo.type.${item.type}`, { defaultValue: item.type })
  const actionLabel = (item: TaskTodoItem) =>
    t(`todo.action.${item.type}`, { defaultValue: item.action_label || t('todo.action.default') })

  const now = useMemo(() => new Date(nowMs), [nowMs])

  /** 截止时间文案：逾期 / 今天剩几小时 / 还剩几天 */
  const dlLabel = (dl: ReturnType<typeof deadlineInfo>): string => {
    if (!dl) return ''
    if (dl.level === 'overdue') return t('todo.deadline.overdue', { days: dl.overdueDays })
    if (dl.level === 'today') return t('todo.deadline.today', { hours: dl.hoursLeft })
    return t('todo.deadline.remaining', { days: dl.days })
  }

  /** 搜索 + 分类过滤后的候选集 */
  const scoped = useMemo(() => {
    const items = data?.items ?? []
    const k = kw.trim().toLowerCase()
    return items.filter((it) => {
      if (cat !== 'all' && TYPE_CATEGORY[it.type] !== cat) return false
      if (!k) return true
      return `${it.title} ${it.description} ${it.subject}`.toLowerCase().includes(k)
    })
  }, [data, cat, kw])

  /** 按分组口径切分（推荐看看单独成组，不计入硬待办） */
  const groups = useMemo(() => {
    const g: Record<string, TaskTodoItem[]> = { overdue: [], urgent: [], live: [], study: [], suggest: [] }
    for (const it of scoped) {
      if (it.suggest) { g.suggest.push(it); continue }
      const dl = deadlineInfo(it.deadline, now)
      if (dl?.level === 'overdue') g.overdue.push(it)
      else if (dl && dl.diffMs <= 3 * 86400000) g.urgent.push(it)
      else if (it.live) g.live.push(it)
      else g.study.push(it)
    }
    const cmp = (a: TaskTodoItem, b: TaskTodoItem): number => {
      if (sort === 'type') return a.type.localeCompare(b.type) || a.title.localeCompare(b.title)
      const da = parseMs(a.deadline)
      const db = parseMs(b.deadline)
      if (sort === 'deadline' && da !== db) return da === 0 ? 1 : db === 0 ? -1 : da - db
      return (b.priority ?? 0) - (a.priority ?? 0)
    }
    Object.values(g).forEach((arr) => arr.sort(cmp))
    return g
  }, [scoped, now, sort])

  /** 分类卡数字：按当前数据逐类统计（推荐看看也计入所属类，点进去才分组） */
  const catCounts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const it of data?.items ?? []) {
      const c = TYPE_CATEGORY[it.type]
      if (c) m[c] = (m[c] || 0) + 1
    }
    return m
  }, [data])

  const todoCount = groups.overdue.length + groups.urgent.length + groups.live.length + groups.study.length
  const suggestCount = groups.suggest.length

  /** 今日必须完成：优先有截止时间的硬任务 */
  const focus = useMemo(() => {
    const pool = [...groups.overdue, ...groups.urgent, ...groups.study, ...groups.live]
      .filter((it) => FOCUS_TYPES.includes(it.type))
    pool.sort((a, b) => {
      const da = parseMs(a.deadline) || Number.MAX_SAFE_INTEGER
      const db = parseMs(b.deadline) || Number.MAX_SAFE_INTEGER
      return da - db || (b.priority ?? 0) - (a.priority ?? 0)
    })
    return pool.slice(0, 4)
  }, [groups])

  const QUICK_OPTIONS = [
    { value: 'all', label: t('todo.quick.all') },
    { value: 'urgent', label: `${t('todo.quick.urgent')} (${groups.overdue.length + groups.urgent.length})` },
    { value: 'live', label: `${t('todo.quick.live')} (${groups.live.length})` },
    { value: 'study', label: `${t('todo.quick.study')} (${groups.study.length})` },
    { value: 'suggest', label: `${t('todo.quick.suggest')} (${suggestCount})` },
  ]

  const GROUP_META: Record<string, { title: string; hint: string; icon: React.ReactNode; color: string }> = {
    overdue: { title: t('todo.group.overdue'), hint: t('todo.groupHint.overdue'), icon: <AlertOutlined />, color: '#ff4d4f' },
    urgent: { title: t('todo.group.urgent'), hint: t('todo.groupHint.urgent'), icon: <ClockCircleOutlined />, color: '#fa8c16' },
    live: { title: t('todo.group.live'), hint: t('todo.groupHint.live'), icon: <ThunderboltOutlined />, color: '#13c2c2' },
    study: { title: t('todo.group.study'), hint: t('todo.groupHint.study'), icon: <FileAddOutlined />, color: '#1677ff' },
    suggest: { title: t('todo.group.suggest'), hint: t('todo.groupHint.suggest'), icon: <FolderOutlined />, color: '#8c8c8c' },
  }

  const go = (url: string) => {
    if (url.startsWith('/api/')) window.open(url, '_blank', 'noopener')
    else navigate(url)
  }

  const renderRow = (item: TaskTodoItem, idx: number) => {
    const cfg = TYPE_CONFIG[item.type] || { icon: <BellOutlined />, color: '#8c8c8c' }
    const dl = deadlineInfo(item.deadline, now)
    const dlText = item.deadline ? dlLabel(dl) : item.live ? '' : t('todo.noDeadline')
    const dlColor = !item.deadline ? ct.tick : dl?.level === 'overdue' ? '#ff4d4f' : dl?.level === 'today' ? '#fa8c16' : '#faad14'

    return (
      <div
        key={`${item.id}-${idx}`}
        style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0',
          borderBottom: `1px solid ${ct.isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'}`,
        }}
      >
        <div style={{
          width: 38, height: 38, borderRadius: 10, flexShrink: 0,
          background: ct.isDark ? 'rgba(255,255,255,0.06)' : `${cfg.color}14`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, color: cfg.color,
        }}>
          {cfg.icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Space size={6} wrap style={{ marginBottom: 2 }}>
            <Text strong style={{ fontSize: 14 }}>{item.title}</Text>
            <Tag style={{ fontSize: 10, lineHeight: '16px', marginInlineEnd: 0, color: cfg.color, borderColor: cfg.color, background: 'transparent' }}>
              {typeLabel(item)}
            </Tag>
            {item.subject && (
              <Tag style={{ fontSize: 10, lineHeight: '16px', marginInlineEnd: 0 }}>{item.subject}</Tag>
            )}
            {dlText && (
              <Text style={{ fontSize: 12, color: dlColor }}>
                <CalendarOutlined style={{ marginRight: 3 }} />{dlText}
              </Text>
            )}
          </Space>
          <Paragraph type="secondary" ellipsis={{ rows: 1 }} style={{ fontSize: 12, margin: 0 }}>
            {item.description}
          </Paragraph>
        </div>
        <Button size="small" type="primary" ghost icon={<RightOutlined />} style={{ flexShrink: 0 }} onClick={() => go(item.url)}>
          {actionLabel(item)}
        </Button>
      </div>
    )
  }

  const renderGroup = (key: string) => {
    const items = groups[key]
    if (!items.length) return null
    // 顶部快切：「即将截止」同时看逾期与临期，其余一对一
    const allowed = quick === 'all' ? GROUP_ORDER as readonly string[]
      : quick === 'urgent' ? ['overdue', 'urgent'] : [quick]
    if (!allowed.includes(key)) return null
    const meta = GROUP_META[key]
    const isOpen = !!openGroups[key]
    const cap = key === 'suggest' ? COLLAPSED : COLLAPSED * 2
    const shown = isOpen || items.length <= cap ? items : items.slice(0, cap)
    return (
      <Card
        key={key}
        size="small"
        style={{ marginBottom: 16, borderRadius: 8 }}
        title={
          <Space size={8}>
            <span style={{ color: meta.color }}>{meta.icon}</span>
            <Text strong>{meta.title}</Text>
            <Tag style={{ fontSize: 11, borderRadius: 8, marginInlineEnd: 0 }}>{items.length}</Tag>
            <Text type="secondary" style={{ fontSize: 11, fontWeight: 400 }}>{meta.hint}</Text>
          </Space>
        }
        styles={{ body: { padding: '0 16px 8px' } }}
      >
        {shown.map((it, i) => renderRow(it, i))}
        {items.length > cap && (
          <div style={{ textAlign: 'center', paddingTop: 8 }}>
            <Button type="link" size="small" onClick={() => setOpenGroups((p) => ({ ...p, [key]: !p[key] }))}>
              {isOpen ? t('todo.collapse') : t('todo.expand', { count: items.length })}
            </Button>
          </div>
        )}
      </Card>
    )
  }

  const renderDone = () => {
    const rows: DoneRecord[] = data?.recent_done ?? []
    if (!rows.length) {
      return (
        <Card style={{ borderRadius: 8 }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<Text type="secondary">{t('todo.done.empty')}</Text>} />
        </Card>
      )
    }
    const shown = doneMore ? rows : rows.slice(0, DONE_COLLAPSED)
    return (
      <Card
        size="small"
        style={{ borderRadius: 8 }}
        title={<Text strong>{t('todo.done.title', { count: rows.length })}</Text>}
        styles={{ body: { padding: '0 16px 8px' } }}
      >
        {shown.map((r) => {
          const cfg = TYPE_CONFIG[r.type] || { icon: <CheckCircleOutlined />, color: '#52c41a' }
          const scoreText = r.score == null
            ? ''
            : r.total
              ? t('todo.done.score', { score: fmtNum(r.score), total: fmtNum(r.total) })
              : t('todo.done.scoreOnly', { score: fmtNum(r.score) })
          return (
            <div
              key={r.id}
              onClick={() => go(r.url)}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', cursor: 'pointer',
                borderBottom: `1px solid ${ct.isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'}`,
              }}
            >
              <div style={{
                width: 32, height: 32, borderRadius: 9, flexShrink: 0,
                background: ct.isDark ? 'rgba(255,255,255,0.06)' : `${cfg.color}14`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, color: cfg.color,
              }}>
                {cfg.icon}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Space size={6} wrap>
                  <Text style={{ fontSize: 13.5 }}>{r.title}</Text>
                  {r.detail && <Text type="secondary" style={{ fontSize: 11 }}>{r.detail}</Text>}
                </Space>
                <div><Text type="secondary" style={{ fontSize: 11 }}>{friendlyTime(r.time, i18n.language)}</Text></div>
              </div>
              {scoreText && <Tag color="green" style={{ marginInlineEnd: 0, fontSize: 11 }}>{scoreText}</Tag>}
            </div>
          )
        })}
        {rows.length > DONE_COLLAPSED && (
          <div style={{ textAlign: 'center', paddingTop: 8 }}>
            <Button type="link" size="small" onClick={() => setDoneMore((v) => !v)}>
              {doneMore ? t('todo.collapse') : t('todo.expand', { count: rows.length })}
            </Button>
          </div>
        )}
      </Card>
    )
  }

  if (loading && !data) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 400 }}>
        <Spin size="large" description={t('todo.loading')} />
      </div>
    )
  }
  if (!data) return <Empty description={t('todo.loadFailed')} />

  const hasFilter = cat !== 'all' || quick !== 'all' || !!kw.trim()

  return (
    <Card style={{ borderRadius: 8 }}>
      {/* ─── 页头 ─── */}
      <Row justify="space-between" align="middle" gutter={[8, 8]} style={{ marginBottom: 14 }}>
        <Col>
          <Space size={8} wrap>
            <span style={{ fontSize: 20, fontWeight: 600 }}>{t('todo.title')}</span>
            <Tag color="blue" style={{ fontSize: 13, padding: '0 12px', borderRadius: 8 }}>
              {t('todo.itemCount', { count: todoCount })}
            </Tag>
            {suggestCount > 0 && (
              <Text type="secondary" style={{ fontSize: 12 }}>+ {suggestCount} {t('todo.quick.suggest')}</Text>
            )}
          </Space>
        </Col>
        <Col>
          <Space size={8} wrap>
            <Input
              allowClear
              size="small"
              style={{ width: 190 }}
              prefix={<SearchOutlined style={{ color: ct.tick }} />}
              placeholder={t('todo.searchPh')}
              value={kw}
              onChange={(e) => setKw(e.target.value)}
            />
            <Select
              size="small"
              style={{ width: 118 }}
              value={sort}
              onChange={setSort}
              options={[
                { value: 'deadline', label: t('todo.sort.deadline') },
                { value: 'priority', label: t('todo.sort.priority') },
                { value: 'type', label: t('todo.sort.type') },
              ]}
            />
            <Tooltip title={t('todo.refresh')}>
              <Button icon={<ReloadOutlined />} onClick={fetchManual} size="small" loading={loading} />
            </Tooltip>
          </Space>
        </Col>
      </Row>

      {/* ─── 分类统计条：一行五格，点击即筛选 ─── */}
      <Card
        size="small"
        style={{ marginBottom: 14, borderRadius: 8 }}
        styles={{ body: { padding: '2px 6px' } }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch' }}>
          {Object.entries(CATEGORY_LABELS).map(([key, cfg], idx) => {
            const count = catCounts[key] || 0
            const active = cat === key
            const toggle = () => setCat(active ? 'all' : key)
            return (
              <div
                key={key}
                role="button"
                tabIndex={0}
                title={active ? t('todo.clearedFilter') : cfg.label}
                onClick={toggle}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
                style={{
                  flex: '1 1 118px', minWidth: 112, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 10px',
                  borderInlineStart: idx === 0 ? 'none' : `1px solid ${ct.isDark ? ct.grid : '#f0f0f0'}`,
                  background: active ? (ct.isDark ? 'rgba(79,140,255,0.12)' : `${cfg.color}12`) : 'transparent',
                  boxShadow: active ? `inset 0 0 0 1px ${cfg.color}` : 'none',
                  transition: 'background .2s',
                }}
              >
                <span style={{ fontSize: 16, color: count > 0 ? cfg.color : ct.tick, flexShrink: 0 }}>{cfg.icon}</span>
                <span style={{ minWidth: 0 }}>
                  <Text
                    type="secondary"
                    style={{ fontSize: 11.5, display: 'block', lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                  >
                    {cfg.label}
                  </Text>
                  <span style={{ fontSize: 17, fontWeight: 600, color: count > 0 ? cfg.color : ct.tick }}>{count}</span>
                </span>
              </div>
            )
          })}
        </div>
      </Card>

      {/* ─── 今日必须完成 ─── */}
      {tab === 'todo' && focus.length > 0 && (
        <Card
          size="small"
          style={{
            marginBottom: 14, borderRadius: 8,
            border: `1px solid ${ct.isDark ? 'rgba(250,140,22,0.45)' : '#ffe7ba'}`,
            background: ct.isDark ? 'rgba(250,140,22,0.10)' : '#fffbe6',
          }}
          styles={{ body: { padding: '10px 14px' } }}
        >
          <Space size={10} wrap>
            <Text strong style={{ fontSize: 13 }}><BulbIcon /> {t('todo.focus.title')}</Text>
            {focus.map((it) => {
              const dl = deadlineInfo(it.deadline, now)
              const tone = dl?.level === 'overdue' ? 'red' : dl?.level === 'today' ? 'orange' : 'blue'
              return (
                <Tag key={it.id} color={tone} style={{ cursor: 'pointer', marginInlineEnd: 0, padding: '2px 8px', borderRadius: 8 }} onClick={() => go(it.url)}>
                  {it.title.length > 14 ? `${it.title.slice(0, 14)}…` : it.title}
                  {it.deadline && (
                    <Text style={{ fontSize: 11, marginInlineStart: 4, color: 'inherit' }}>{dlLabel(dl)}</Text>
                  )}
                </Tag>
              )
            })}
          </Space>
        </Card>
      )}

      {/* ─── 待办 / 已完成 ─── */}
      <Tabs
        activeKey={tab}
        onChange={setTab}
        size="small"
        items={[
          {
            key: 'todo',
            label: <span><CheckCircleOutlined /> {t('todo.tabs.todo')} ({todoCount})</span>,
            children: (
              <>
                <Segmented
                  size="small"
                  value={quick}
                  onChange={(v) => setQuick(v as string)}
                  options={QUICK_OPTIONS}
                  style={{ marginBottom: 14 }}
                />
                {hasFilter && (
                  <div style={{ marginTop: -6, marginBottom: 12 }}>
                    <Button type="link" size="small" style={{ padding: 0 }} onClick={() => { setCat('all'); setQuick('all'); setKw('') }}>
                      {t('todo.clearedFilter')}
                    </Button>
                  </div>
                )}
                {todoCount + suggestCount === 0 ? (
                  <Card style={{ borderRadius: 8 }}>
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<Text type="secondary">{t('todo.empty')}</Text>} />
                  </Card>
                ) : (
                  GROUP_ORDER.map((k) => renderGroup(k))
                )}
              </>
            ),
          },
          {
            key: 'done',
            label: <span><TrophyOutlined /> {t('todo.tabs.done')}</span>,
            children: renderDone(),
          },
        ]}
      />

      {/* ─── 学习进度概览 ─── */}
      {data.stats && (
        <Card
          size="small"
          style={{ borderRadius: 8, marginTop: 8 }}
          title={<Space><TrophyOutlined style={{ color: '#faad14' }} /><Text strong>{t('todo.stats.title')}</Text></Space>}
        >
          <Row gutter={[16, 16]}>
            <Col xs={12} sm={6}>
              <div style={{ textAlign: 'center' }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('todo.stats.courseProgress')}</Text>
                <Progress type="dashboard" percent={data.stats.course_progress || 0} size={80} strokeColor="#1677ff" />
              </div>
            </Col>
            <Col xs={12} sm={6}>
              <div style={{ textAlign: 'center' }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('todo.stats.completionRate')}</Text>
                <Progress type="dashboard" percent={data.stats.completion_rate || 0} size={80} strokeColor="#52c41a" />
              </div>
            </Col>
            <Col xs={12} sm={6}>
              <div style={{ textAlign: 'center' }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('todo.stats.accuracyRate')}</Text>
                <Progress type="dashboard" percent={data.stats.accuracy_rate || 0} size={80} strokeColor="#722ed1" format={(p) => `${p}%`} />
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

/** 时间串 → 毫秒（无截止时间的排到最后） */
function parseMs(s: string | null | undefined): number {
  if (!s) return 0
  const d = new Date(s.trim().replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? 0 : d.getTime()
}

function fmtNum(v: number | null | undefined): string {
  const n = Number(v ?? 0)
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

function BulbIcon() {
  return <span role="img" aria-label="focus">⚡</span>
}

export default TaskTodoPage
