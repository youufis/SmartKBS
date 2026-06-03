import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  Card, Table, Button, message, Space, Typography, Modal, Tag,
  Spin, Empty, Descriptions, Divider, Tooltip, Statistic, Row, Col,
  Select, Tabs,
} from 'antd'
import {
  ReloadOutlined, DeleteOutlined, HistoryOutlined,
  TeamOutlined, BarChartOutlined, EyeOutlined,
  DownloadOutlined, AimOutlined, CheckOutlined,
  CloseOutlined, ForwardOutlined, RollbackOutlined,
  TrophyOutlined,
} from '@ant-design/icons'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'

const { Text, Title } = Typography

// ============================================================
// 类型定义
// ============================================================

interface Session {
  teacher: string
  grade: string
  class: string
  student_count: number
  history_count: number
}

interface SessionDetail {
  teacher: string
  grade: string
  class: string
  weights: Record<string, number>
  history: { student: string; time: string; result: string; points: number }[]
  picked_in_round: string[]
  last_time: number | null
  updated: string
  student_count: number
  history_count: number
}

interface HistoryItem {
  student: string
  time: string
  result: string
  points: number
  teacher?: string
}

// ============================================================
// 智能点名工具组件
// ============================================================

const RollcallTool: React.FC = () => {
  const user = useAuthStore((s) => s.user)
  const teacherUsername = user?.username || 'root'

  const [grades, setGrades] = useState<string[]>([])
  const [classes, setClasses] = useState<string[]>([])
  const [grade, setGrade] = useState<string>('')
  const [cls, setCls] = useState<string>('')
  const [studentNames, setStudentNames] = useState<string[]>([])

  const [picking, setPicking] = useState(false)
  const [displayName, setDisplayName] = useState<string>('🎯')
  const [displayClass, setDisplayClass] = useState<string>('')
  const [lastPicked, setLastPicked] = useState<string>('')
  const [rolling, setRolling] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [resultType, setResultType] = useState<'correct' | 'participated' | ''>('')

  const [history, setHistory] = useState<HistoryItem[]>([])
  const [historyVisible, setHistoryVisible] = useState(false)
  const [covered, setCovered] = useState(0)
  const [total, setTotal] = useState(0)
  const [correctCount, setCorrectCount] = useState(0)

  const rollInterval = useRef<number | null>(null)
  const decelTimers = useRef<number[]>([])
  const frameRef = useRef(0)

  // ── 清理动画定时器 ──
  const clearAllTimers = useCallback(() => {
    if (rollInterval.current) {
      clearInterval(rollInterval.current)
      rollInterval.current = null
    }
    decelTimers.current.forEach(clearTimeout)
    decelTimers.current = []
  }, [])

  useEffect(() => {
    return clearAllTimers
  }, [clearAllTimers])

  // ── 加载年级 ──
  useEffect(() => {
    apiClient.get('/api/rollcall/grades')
      .then(({ data }) => setGrades(Array.isArray(data) ? data : []))
      .catch(() => setGrades([]))
  }, [])

  // ── 年级变更 → 加载班级 ──
  const handleGradeChange = async (val: string) => {
    setGrade(val)
    setCls('')
    setClasses([])
    setDisplayName('🎯')
    setDisplayClass('')
    setRevealed(false)
    setResultType('')
    setLastPicked('')
    if (!val) return
    try {
      const { data } = await apiClient.get('/api/rollcall/classes', {
        params: { grade: val, teacher: teacherUsername },
      })
      setClasses(Array.isArray(data) ? data : [])
    } catch { setClasses([]) }
  }

  // ── 班级变更 → 加载学生 + 历史 ──
  const handleClassChange = async (val: string) => {
    setCls(val)
    setDisplayName('🎯')
    setDisplayClass('')
    setRevealed(false)
    setResultType('')
    setLastPicked('')
    if (!grade || !val) return
    try {
      const { data } = await apiClient.get('/api/rollcall/students', {
        params: { grade, class: val, teacher: teacherUsername },
      })
      const names = (Array.isArray(data) ? data : []).map((s: { name: string }) => s.name)
      setStudentNames(names)
    } catch {
      setStudentNames([])
    }
    loadHistoryData(grade, val)
  }

  // ── 加载点名历史和统计 ──
  const loadHistoryData = async (g: string, c: string) => {
    if (!g || !c) return
    try {
      const { data } = await apiClient.get('/api/rollcall/history', {
        params: { grade: g, class: c, teacher: teacherUsername },
      })
      if (data) {
        setHistory(data.history || [])
        setCovered(data.covered || 0)
        setTotal(data.total || 0)
        setCorrectCount(data.correct_count || 0)
      }
    } catch { /* ignore */ }
  }

  const refreshHistory = () => loadHistoryData(grade, cls)

  // ── 点名（老虎机动画） ──
  const pickStudent = async () => {
    if (!grade || !cls) { message.warning('请先选择年级和班级'); return }
    setPicking(true)
    setRevealed(false)
    setResultType('')
    clearAllTimers()

    const pool = studentNames.length > 0 ? studentNames
      : ['张同学', '李同学', '王同学', '赵同学', '刘同学', '陈同学']

    // 阶段1：快速滚动
    setRolling(true)
    frameRef.current = 0
    rollInterval.current = window.setInterval(() => {
      setDisplayName(pool[frameRef.current % pool.length])
      frameRef.current++
    }, 50)

    // 发请求
    let data: any
    try {
      const resp = await apiClient.post('/api/rollcall/pick', {
        grade, class: cls, teacher: teacherUsername,
      })
      data = resp.data
    } catch {
      clearAllTimers()
      setRolling(false)
      setDisplayName('😅')
      setPicking(false)
      message.error('抽取失败')
      return
    }

    if (!data || data.error) {
      clearAllTimers()
      setRolling(false)
      setDisplayName('😅')
      setPicking(false)
      message.error(data?.error || '抽取失败')
      return
    }

    // 停止快速滚动
    if (rollInterval.current) {
      clearInterval(rollInterval.current)
      rollInterval.current = null
    }

    // 阶段2：减速效果
    const decelSteps = [
      { ms: 120, count: 8 },
      { ms: 200, count: 6 },
      { ms: 350, count: 4 },
      { ms: 600, count: 2 },
    ]

    let stepIdx = 0
    let subFrame = 0

    const doDecelStep = () => {
      if (stepIdx >= decelSteps.length) {
        // 最终揭示
        setRolling(false)
        setDisplayName(data.student)
        setDisplayClass(`${data.grade || grade} · ${data.class || cls}`)
        setRevealed(true)
        setResultType('')
        setLastPicked(data.student)
        setPicking(false)
        setCovered(data.covered || 0)
        setTotal(data.total || 0)
        message.success(`🎯 抽中：${data.student}`)
        refreshHistory()
        return
      }

      const step = decelSteps[stepIdx]
      const timer = window.setInterval(() => {
        setDisplayName(pool[frameRef.current % pool.length])
        frameRef.current++
        subFrame++
        if (subFrame >= step.count) {
          clearInterval(timer)
          subFrame = 0
          stepIdx++
          doDecelStep()
        }
      }, step.ms)
      decelTimers.current.push(timer)
    }

    doDecelStep()

    // 安全兜底：5秒后强制揭示
    const safetyTimer = window.setTimeout(() => {
      clearAllTimers()
      if (!data) return
      setRolling(false)
      setDisplayName(data.student)
      setDisplayClass(`${data.grade || grade} · ${data.class || cls}`)
      setRevealed(true)
      setResultType('')
      setLastPicked(data.student)
      setPicking(false)
      message.success(`🎯 抽中：${data.student}`)
      refreshHistory()
    }, 5000)
    decelTimers.current.push(safetyTimer)
  }

  // ── 标记结果 ──
  const markResult = async (result: string) => {
    if (!lastPicked) return
    try {
      await apiClient.post('/api/rollcall/mark', {
        grade, class: cls, student: lastPicked, result, teacher: teacherUsername,
      })
      if (result === 'correct') {
        setResultType('correct')
        message.success(`✅ ${lastPicked} +5 ⭐`)
        launchConfetti()
      } else if (result === 'incorrect') {
        setResultType('participated')
        message.info(`💬 ${lastPicked} 参与 +2`)
      } else {
        message.info('⏭ 已跳过')
      }
      setLastPicked('')
      setRevealed(false)
      refreshHistory()
    } catch {
      message.error('标记失败')
    }
  }

  // ── 重置 ──
  const resetCurrent = async () => {
    if (!grade || !cls) { message.warning('请先选择班级'); return }
    await apiClient.post('/api/rollcall/reset', {
      grade, class: cls, teacher: teacherUsername,
    })
    setDisplayName('🎯')
    setDisplayClass('')
    setRevealed(false)
    setResultType('')
    setLastPicked('')
    message.info('🔄 已重置')
    refreshHistory()
  }

  // ── 纸屑动画 ──
  const launchConfetti = () => {
    const colors = ['#4fc3f7', '#66bb6a', '#ffa726', '#ef5350', '#ab47bc', '#ffd700', '#7c4dff']
    const container = document.getElementById('rollcall-confetti')
    if (!container) return
    for (let i = 0; i < 40; i++) {
      const el = document.createElement('div')
      el.className = 'confetti-piece'
      el.style.cssText = `
        position:absolute; top:-10px; left:${Math.random() * 100}%;
        width:${6 + Math.random() * 8}px; height:${6 + Math.random() * 8}px;
        background:${colors[Math.floor(Math.random() * colors.length)]};
        border-radius:${Math.random() > 0.5 ? '50%' : '2px'};
        animation: rollcallConfettiFall ${1.5 + Math.random() * 2}s linear forwards;
        animation-delay:${Math.random() * 0.5}s;
        pointer-events:none;
      `
      container.appendChild(el)
      setTimeout(() => el.remove(), 4000)
    }
  }

  // ── 键盘快捷键 ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return
      const key = e.key
      if (key === ' ' || key === 'Space') { e.preventDefault(); if (!picking) pickStudent() }
      else if (key === '1' && lastPicked) markResult('correct')
      else if (key === '2' && lastPicked) markResult('incorrect')
      else if (key === '3' && lastPicked) markResult('skip')
      else if (key === 'r' || key === 'R') resetCurrent()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [grade, cls, lastPicked, picking, teacherUsername, studentNames])

  // ── 统计 ──
  const coverageRate = total > 0 ? Math.round((covered / total) * 100) : 0

  return (
    <Card
      title={
        <Space>
          <AimOutlined style={{ color: '#4fc3f7', fontSize: 20 }} />
          <span>🎯 智能随机点名</span>
          <Tag color="geekblue" style={{ fontSize: 11 }}>公平算法 · 服务端持久化</Tag>
        </Space>
      }
      extra={
        <Space>
          <Button size="small" icon={<RollbackOutlined />} onClick={resetCurrent}>重置本班权重</Button>
          <Button size="small" icon={<ReloadOutlined />} onClick={refreshHistory}>刷新数据</Button>
        </Space>
      }
      style={{ marginBottom: 16, position: 'relative', overflow: 'hidden' }}
    >
      {/* 纸屑容器 */}
      <div id="rollcall-confetti" style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 9999, overflow: 'hidden' }} />

      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {/* 选择器 */}
        <Space wrap>
          <Select
            placeholder="— 选择年级 —"
            value={grade || undefined}
            onChange={handleGradeChange}
            options={grades.map(g => ({ label: g, value: g }))}
            style={{ width: 160 }}
            size="large"
          />
          <Select
            placeholder="— 选择班级 —"
            value={cls || undefined}
            onChange={handleClassChange}
            options={classes.map(c => ({ label: c, value: c }))}
            style={{ width: 180 }}
            size="large"
            disabled={!grade}
          />
        </Space>

        {/* 名称展示区 */}
        <div style={{ textAlign: 'center', padding: '12px 0' }}>
          <Text type="secondary" style={{ fontSize: 14 }}>{displayClass || '请先选择年级和班级'}</Text>
          <div style={{
            fontSize: rolling ? 64 : 80,
            fontWeight: 800,
            minHeight: 90,
            lineHeight: 1.2,
            margin: '8px 0',
            transition: 'all 0.3s',
            color: rolling ? '#4fc3f7' :
                   resultType === 'correct' ? '#52c41a' :
                   resultType === 'participated' ? '#faad14' :
                   revealed ? '#4fc3f7' : 'inherit',
            textShadow: revealed ? '0 0 40px rgba(79,195,247,0.4)' :
                        resultType === 'correct' ? '0 0 40px rgba(82,196,26,0.4)' :
                        resultType === 'participated' ? '0 0 40px rgba(250,173,20,0.4)' : 'none',
            animation: rolling ? 'rollcallRoll 0.08s infinite' :
                       revealed ? 'rollcallPopIn 0.4s ease' : 'none',
          }}>
            {displayName}
          </div>

          {/* 统计 */}
          {total > 0 && (
            <Row gutter={48} justify="center" style={{ marginTop: 8 }}>
              <Col><Statistic title="已点人数" value={covered} suffix={`/ ${total}`} valueStyle={{ color: '#4fc3f7' }} /></Col>
              <Col><Statistic title="覆盖率" value={coverageRate} suffix="%" valueStyle={{ color: '#faad14' }} /></Col>
              <Col><Statistic title="答对次数" value={correctCount} valueStyle={{ color: '#52c41a' }} prefix={<TrophyOutlined />} /></Col>
            </Row>
          )}
        </div>

        {/* 操作按钮 */}
        <div style={{ textAlign: 'center' }}>
          <Space wrap size="large">
            <Button
              type="primary"
              size="large"
              icon={<AimOutlined />}
              onClick={pickStudent}
              loading={picking}
              style={{ height: 48, minWidth: 140, fontSize: 18, fontWeight: 600,
                background: 'linear-gradient(135deg,#4fc3f7,#2196f3)',
                borderColor: '#4fc3f7' }}
            >
              🎲 开始点名
            </Button>
            <Button
              size="large"
              icon={<CheckOutlined />}
              onClick={() => markResult('correct')}
              disabled={!lastPicked}
              style={{ height: 48, minWidth: 100, fontSize: 16,
                background: lastPicked ? 'linear-gradient(135deg,#66bb6a,#43a047)' : undefined,
                borderColor: '#66bb6a', color: lastPicked ? '#fff' : undefined }}
            >
              ✅ 答对
            </Button>
            <Button
              size="large"
              icon={<CloseOutlined />}
              onClick={() => markResult('incorrect')}
              disabled={!lastPicked}
              style={{ height: 48, minWidth: 100, fontSize: 16,
                background: lastPicked ? 'linear-gradient(135deg,#ef5350,#e53935)' : undefined,
                borderColor: '#ef5350', color: lastPicked ? '#fff' : undefined }}
            >
              💬 参与
            </Button>
            <Button
              size="large"
              icon={<ForwardOutlined />}
              onClick={() => markResult('skip')}
              disabled={!lastPicked}
              style={{ height: 48, minWidth: 100 }}
            >
              ⏭ 跳过
            </Button>
          </Space>
        </div>

        {/* 快捷键提示 */}
        <div style={{ textAlign: 'center' }}>
          <Space wrap size={8}>
            {[
              { key: 'Space', label: '抽人' },
              { key: '1', label: '答对' },
              { key: '2', label: '参与' },
              { key: '3', label: '跳过' },
              { key: 'R', label: '重置' },
            ].map(k => (
              <kbd key={k.key} style={{
                background: '#f5f5f5', border: '1px solid #d9d9d9',
                borderRadius: 4, padding: '2px 8px', fontSize: 12,
                fontFamily: 'inherit', color: '#888',
              }}>
                <span style={{ color: '#1677ff', fontWeight: 600 }}>{k.key}</span> {k.label}
              </kbd>
            ))}
          </Space>
        </div>

        {/* 历史记录 */}
        <Divider style={{ margin: '8px 0' }}>
          <Button type="link" onClick={() => setHistoryVisible(!historyVisible)} style={{ fontSize: 14 }}>
            <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: historyVisible ? 'rotate(90deg)' : 'none' }}>▶</span>
            {' '}📋 点名记录 {history.length > 0 && <Text type="secondary">（共 {history.length} 次 · 答对 {correctCount} 次）</Text>}
          </Button>
        </Divider>

        {historyVisible && (
          history.length === 0 ? (
            <Empty description="暂无记录 🎯" />
          ) : (
            <div style={{ maxHeight: 400, overflow: 'auto' }}>
              {[...history].reverse().map((h, i) => {
                const idx = history.length - i
                const label = { correct: '✅ 答对', incorrect: '💬 参与', skip: '⏭ 跳过' }[h.result] || h.result
                const pts = h.points > 0 ? <span style={{ color: '#52c41a', fontWeight: 700 }}>+{h.points}</span> : <span style={{ color: '#999' }}>-</span>
                return (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', padding: '6px 12px',
                    gap: 12, fontSize: 14, borderRadius: 6,
                    background: i % 2 === 0 ? 'rgba(0,0,0,0.02)' : 'transparent',
                  }}>
                    <Text type="secondary" style={{ width: 30 }}>#{idx}</Text>
                    <Text strong style={{ flex: 1 }}>{h.student}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>{h.time || ''}</Text>
                    <Tag color={h.result === 'correct' ? 'green' : h.result === 'incorrect' ? 'orange' : 'default'}>{label}</Tag>
                    <span style={{ minWidth: 30, textAlign: 'right' }}>{pts}</span>
                  </div>
                )
              })}
            </div>
          )
        )}
      </Space>
    </Card>
  )
}

// ============================================================
// 数据管理组件（原有点名管理）
// ============================================================

const SessionsManager: React.FC = () => {
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [detailVisible, setDetailVisible] = useState(false)
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const loadSessions = useCallback(async () => {
    try {
      const { data } = await apiClient.get('/api/rollcall/admin/sessions')
      setSessions(data.sessions || [])
    } catch {
      message.error('加载点名会话列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  const viewDetail = async (s: Session) => {
    setDetailLoading(true)
    setDetailVisible(true)
    try {
      const { data } = await apiClient.get('/api/rollcall/admin/detail', {
        params: { teacher: s.teacher, grade: s.grade, class: s.class },
      })
      setDetail(data)
    } catch {
      message.error('加载详情失败')
      setDetailVisible(false)
    } finally {
      setDetailLoading(false)
    }
  }

  const handleReset = async (s: Session) => {
    try {
      await apiClient.post('/api/rollcall/admin/reset', {
        teacher: s.teacher, grade: s.grade, class: s.class,
      })
      message.success(`已重置 ${s.grade}·${s.class}`)
      loadSessions()
      if (detailVisible) setDetailVisible(false)
    } catch {
      message.error('重置失败')
    }
  }

  const columns = [
    {
      title: '教师', dataIndex: 'teacher', key: 'teacher',
      render: (t: string) => <Tag color={t === 'root' ? 'blue' : 'default'}>{t}</Tag>,
    },
    { title: '年级', dataIndex: 'grade', key: 'grade' },
    { title: '班级', dataIndex: 'class', key: 'class' },
    {
      title: '学生数', dataIndex: 'student_count', key: 'student_count',
      sorter: (a: Session, b: Session) => a.student_count - b.student_count,
    },
    {
      title: '抽取次数', dataIndex: 'history_count', key: 'history_count',
      sorter: (a: Session, b: Session) => a.history_count - b.history_count,
    },
    {
      title: '操作', key: 'actions',
      render: (_: unknown, record: Session) => (
        <Space>
          <Tooltip title="查看详情">
            <Button icon={<EyeOutlined />} size="small" onClick={() => viewDetail(record)} />
          </Tooltip>
          <Tooltip title="重置数据">
            <Button icon={<DeleteOutlined />} size="small" danger
              onClick={() => {
                Modal.confirm({
                  title: '确认重置',
                  content: `确定要重置 ${record.grade}·${record.class} 的全部点名数据吗？`,
                  onOk: () => handleReset(record),
                })
              }}
            />
          </Tooltip>
        </Space>
      ),
    },
  ]

  const resultColor = (r: string) => {
    switch (r) {
      case 'correct': return 'green'
      case 'incorrect': return 'red'
      case 'skip': return 'orange'
      default: return 'default'
    }
  }

  const resultLabel = (r: string) => {
    switch (r) {
      case 'correct': return '正确'
      case 'incorrect': return '错误'
      case 'skip': return '跳过'
      default: return r
    }
  }

  return (
    <>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Space>
            <HistoryOutlined style={{ fontSize: 24, color: '#1677ff' }} />
            <Title level={4} style={{ margin: 0 }}>点名数据管理</Title>
          </Space>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={loadSessions} loading={loading}>刷新</Button>
            <Button icon={<DownloadOutlined />} onClick={() => {
              const token = localStorage.getItem('smartkb_token')
              window.open(`/api/export/rollcall?token=${token}`, '_blank')
            }}>
              导出记录
            </Button>
          </Space>
        </div>

        {sessions.length === 0 && !loading ? (
          <Empty description="暂无点名数据" />
        ) : (
          <Table
            dataSource={sessions}
            columns={columns}
            rowKey={(r) => `${r.teacher}|${r.grade}|${r.class}`}
            loading={loading}
            pagination={false}
            size="middle"
          />
        )}

        <Divider />
        <Row gutter={16}>
          <Col span={8}>
            <Statistic title="总会话数" value={sessions.length} prefix={<TeamOutlined />} />
          </Col>
          <Col span={8}>
            <Statistic title="总学生数" value={sessions.reduce((s, x) => s + x.student_count, 0)} prefix={<TeamOutlined />} />
          </Col>
          <Col span={8}>
            <Statistic title="总抽取次数" value={sessions.reduce((s, x) => s + x.history_count, 0)} prefix={<BarChartOutlined />} />
          </Col>
        </Row>
      </Card>

      {/* 详情弹窗 */}
      <Modal
        title={detail ? `点名详情 · ${detail.teacher} · ${detail.grade} ${detail.class}` : '加载中...'}
        open={detailVisible}
        onCancel={() => setDetailVisible(false)}
        footer={[
          <Button key="close" onClick={() => setDetailVisible(false)}>关闭</Button>,
          detail && (
            <Button key="reset" danger onClick={() => {
              Modal.confirm({
                title: '确认重置',
                content: `确定要重置 ${detail.grade}·${detail.class} 的全部数据？`,
                onOk: () => handleReset(detail),
              })
            }}>
              重置本班数据
            </Button>
          ),
        ]}
        width={800}
      >
        {detailLoading ? <Spin style={{ display: 'block', padding: 60 }} /> : detail ? (
          <div>
            <Descriptions column={3} size="small" bordered>
              <Descriptions.Item label="教师"><Tag>{detail.teacher}</Tag></Descriptions.Item>
              <Descriptions.Item label="年级">{detail.grade}</Descriptions.Item>
              <Descriptions.Item label="班级">{detail.class}</Descriptions.Item>
              <Descriptions.Item label="学生数">{detail.student_count}</Descriptions.Item>
              <Descriptions.Item label="抽取次数">{detail.history_count}</Descriptions.Item>
              <Descriptions.Item label="本轮已抽">{detail.picked_in_round.length} 人</Descriptions.Item>
              <Descriptions.Item label="最后更新">{detail.updated}</Descriptions.Item>
            </Descriptions>

            <Divider>⚖️ 权重分布</Divider>
            {Object.keys(detail.weights).length === 0 ? (
              <Text type="secondary">暂无权重数据</Text>
            ) : (
              <div style={{ maxHeight: 200, overflow: 'auto', marginBottom: 16 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#fafafa' }}>
                      <th style={thStyle}>学生</th>
                      <th style={thStyle}>权重</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(detail.weights)
                      .sort(([, a], [, b]) => b - a)
                      .map(([name, w]) => (
                        <tr key={name}>
                          <td style={tdStyle}>{name}</td>
                          <td style={tdStyle}>
                            <Tag color={w >= 8 ? 'green' : w >= 5 ? 'orange' : 'red'}>{w}</Tag>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}

            <Divider>📜 抽取历史 ({detail.history.length} 条)</Divider>
            {detail.history.length === 0 ? (
              <Text type="secondary">暂无历史记录</Text>
            ) : (
              <div style={{ maxHeight: 300, overflow: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#fafafa' }}>
                      <th style={thStyle}>时间</th>
                      <th style={thStyle}>学生</th>
                      <th style={thStyle}>结果</th>
                      <th style={thStyle}>积分</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...detail.history].reverse().map((h, i) => (
                      <tr key={i}>
                        <td style={tdStyle}>{h.time}</td>
                        <td style={tdStyle}>{h.student}</td>
                        <td style={tdStyle}>
                          <Tag color={resultColor(h.result)}>{resultLabel(h.result)}</Tag>
                        </td>
                        <td style={tdStyle}>{h.points > 0 ? `+${h.points}` : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}
      </Modal>
    </>
  )
}

// ============================================================
// 页面主组件
// ============================================================

const RollcallManagePage: React.FC = () => {
  return (
    <div style={{ padding: 24 }}>
      <Tabs
        defaultActiveKey="tool"
        items={[
          {
            key: 'tool',
            label: <span><AimOutlined /> 🎯 随机点名</span>,
            children: <RollcallTool />,
          },
          {
            key: 'manage',
            label: <span><HistoryOutlined /> 📊 数据管理</span>,
            children: <SessionsManager />,
          },
        ]}
      />
    </div>
  )
}

const thStyle: React.CSSProperties = {
  padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid #f0f0f0',
  fontWeight: 600, fontSize: 13,
}
const tdStyle: React.CSSProperties = {
  padding: '6px 12px', borderBottom: '1px solid #f0f0f0', fontSize: 13,
}

export default RollcallManagePage
