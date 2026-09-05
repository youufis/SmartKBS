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
  TrophyOutlined, UserOutlined, ClockCircleOutlined,
  LoginOutlined, StopOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('interaction')
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
  const loadHistoryData = useCallback(async (g: string, c: string) => {
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
  }, [teacherUsername])

  const refreshHistory = useCallback(() => loadHistoryData(grade, cls), [grade, cls, loadHistoryData])

  // ── 点名（老虎机动画） ──
  const pickStudent = useCallback(async () => {
    if (!grade || !cls) { message.warning(t('selectGradeClass')); return }
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
      message.error(t('rollFailed'))
      return
    }

    if (!data || data.error) {
      clearAllTimers()
      setRolling(false)
      setDisplayName('😅')
      setPicking(false)
      message.error(data?.error || t('rollFailed'))
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
        message.success(t('picked', { student: data.student }))
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
      message.success(t('picked', { student: data.student }))
      refreshHistory()
    }, 5000)
    decelTimers.current.push(safetyTimer)
  }, [grade, cls, studentNames, teacherUsername, t, clearAllTimers, refreshHistory])

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

  // ── 标记结果 ──
  const markResult = useCallback(async (result: string) => {
    if (!lastPicked) return
    try {
      await apiClient.post('/api/rollcall/mark', {
        grade, class: cls, student: lastPicked, result, teacher: teacherUsername,
      })
      if (result === 'correct') {
        setResultType('correct')
        message.success(t('scorePlus', { name: lastPicked, points: 5 }))
        launchConfetti()
      } else if (result === 'incorrect') {
        setResultType('participated')
        message.info(t('scorePlus', { name: lastPicked, points: 2 }))
      } else {
        message.info(t('skipped'))
      }
      setLastPicked('')
      setRevealed(false)
      refreshHistory()
    } catch {
      message.error(t('markFailed'))
    }
  }, [lastPicked, grade, cls, teacherUsername, t, refreshHistory])

  // ── 重置 ──
  const resetCurrent = useCallback(async () => {
    if (!grade || !cls) { message.warning(t('selectClassFirst')); return }
    await apiClient.post('/api/rollcall/reset', {
      grade, class: cls, teacher: teacherUsername,
    })
    setDisplayName('🎯')
    setDisplayClass('')
    setRevealed(false)
    setResultType('')
    setLastPicked('')
    message.info(t('resetDone'))
    refreshHistory()
  }, [grade, cls, teacherUsername, t, refreshHistory])

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
  }, [grade, cls, lastPicked, picking, teacherUsername, studentNames, pickStudent, markResult, resetCurrent])

  // ── 统计 ──
  const coverageRate = total > 0 ? Math.round((covered / total) * 100) : 0

  return (
    <Card
      title={
        <Space>
          <AimOutlined style={{ color: '#4fc3f7', fontSize: 20 }} />
          <span>{t('smartRollcall')}</span>
          <Tag color="geekblue" style={{ fontSize: 11 }}>{t('fairAlgorithm')}</Tag>
        </Space>
      }
      extra={
        <Space>
          <Button size="small" icon={<RollbackOutlined />} onClick={resetCurrent}>{t('resetWeights')}</Button>
          <Button size="small" icon={<ReloadOutlined />} onClick={refreshHistory}>{t('refreshData')}</Button>
        </Space>
      }
      style={{ marginBottom: 16, position: 'relative', overflow: 'hidden' }}
    >
      {/* 纸屑容器 */}
      <div id="rollcall-confetti" style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 9999, overflow: 'hidden' }} />

      <Space orientation="vertical" style={{ width: '100%' }} size="middle">
        {/* 选择器 */}
        <Space wrap>
          <Select
            placeholder={t('selectGradePlaceholder')}
            value={grade || undefined}
            onChange={handleGradeChange}
            options={grades.map(g => ({ label: g, value: g }))}
            style={{ width: 160 }}
            size="large"
          />
          <Select
            placeholder={t('selectClassPlaceholder')}
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
          <Text type="secondary" style={{ fontSize: 14 }}>{displayClass || t('selectGradeClass')}</Text>
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
              <Col><Statistic title={t('calledCount')} value={covered} suffix={`/ ${total}`} styles={{ content: { color: '#4fc3f7' } }} /></Col>
              <Col><Statistic title={t('coverageRate')} value={coverageRate} suffix="%" styles={{ content: { color: '#faad14' } }} /></Col>
              <Col><Statistic title={t('correctTimes')} value={correctCount} styles={{ content: { color: '#52c41a' } }} prefix={<TrophyOutlined />} /></Col>
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
              {t('startRollcallEmoji')}
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
              {t('correctWithEmoji')}
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
              {t('participateWithEmoji')}
            </Button>
            <Button
              size="large"
              icon={<ForwardOutlined />}
              onClick={() => markResult('skip')}
              disabled={!lastPicked}
              style={{ height: 48, minWidth: 100 }}
            >
              {t('skipWithEmoji')}
            </Button>
          </Space>
        </div>

        {/* 快捷键提示 */}
        <div style={{ textAlign: 'center' }}>
          <Space wrap size={8}>
            {[
              { key: 'Space', label: t('pickPerson') },
              { key: '1', label: t('correct') },
              { key: '2', label: t('participate') },
              { key: '3', label: t('skip') },
              { key: 'R', label: t('reset') },
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
            {' '}📋 {t('rollcallRecords')} {history.length > 0 && <Text type="secondary">({t('totalCount', { count: history.length })} · {t('correctCount', { count: correctCount })})</Text>}
          </Button>
        </Divider>

        {historyVisible && (
          history.length === 0 ? (
            <Empty description={t('noRecords')} />
          ) : (
            <div style={{ maxHeight: 400, overflow: 'auto' }}>
              {[...history].reverse().map((h, i) => {
                const idx = history.length - i
                const label = { correct: t('correctWithEmoji'), incorrect: t('participateWithEmoji'), skip: t('skipWithEmoji') }[h.result] || h.result
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
  const { t } = useTranslation('interaction')
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
      message.error(t('loadSessionFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

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
      message.error(t('loadDetailFailed'))
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
      message.success(t('resetDoneFor', { grade: s.grade, cls: s.class }))
      loadSessions()
      if (detailVisible) setDetailVisible(false)
    } catch {
      message.error(t('resetFailed'))
    }
  }

  const columns = [
    {
      title: t('teacher'), dataIndex: 'teacher', key: 'teacher',
      render: (teacher: string) => <Tag color={teacher === 'root' ? 'blue' : 'default'}>{teacher}</Tag>,
    },
    { title: t('grade'), dataIndex: 'grade', key: 'grade' },
    { title: t('classLabel'), dataIndex: 'class', key: 'class' },
    {
      title: t('studentCount'), dataIndex: 'student_count', key: 'student_count',
      sorter: (a: Session, b: Session) => a.student_count - b.student_count,
    },
    {
      title: t('drawCount'), dataIndex: 'history_count', key: 'history_count',
      sorter: (a: Session, b: Session) => a.history_count - b.history_count,
    },
    {
      title: t('actions'), key: 'actions',
      render: (_: unknown, record: Session) => (
        <Space>
          <Tooltip title={t('viewDetails')}>
            <Button icon={<EyeOutlined />} size="small" onClick={() => viewDetail(record)} />
          </Tooltip>
          <Tooltip title={t('resetData')}>
            <Button icon={<DeleteOutlined />} size="small" danger
              onClick={() => {
                Modal.confirm({
                  title: t('confirmReset'),
                  content: t('confirmResetContent', { grade: record.grade, class: record.class }),
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
      case 'correct': return t('correct')
      case 'incorrect': return t('wrong')
      case 'skip': return t('skip')
      default: return r
    }
  }

  return (
    <>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Space>
            <HistoryOutlined style={{ fontSize: 24, color: '#1677ff' }} />
            <Title level={4} style={{ margin: 0 }}>{t('rollcall')}</Title>
          </Space>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={loadSessions} loading={loading}>{t('refresh')}</Button>
            <Button icon={<DownloadOutlined />} onClick={() => window.open('/api/export/rollcall', '_blank')}>
              {t('exportRecords')}
            </Button>
          </Space>
        </div>

        {sessions.length === 0 && !loading ? (
          <Empty description={t('noRollcallData')} />
        ) : (
          <Table
            dataSource={sessions}
            columns={columns}
            rowKey={(r) => `${r.teacher}|${r.grade}|${r.class}`}
            loading={loading}
            pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => t('totalSessionsCount', { count: total }), pageSizeOptions: ['10', '20', '50'] }}
            size="middle"
          />
        )}

        <Divider />
        <Row gutter={16}>
          <Col span={8}>
            <Statistic title={t('totalSessions')} value={sessions.length} prefix={<TeamOutlined />} />
          </Col>
          <Col span={8}>
            <Statistic title={t('totalStudents')} value={sessions.reduce((s, x) => s + x.student_count, 0)} prefix={<TeamOutlined />} />
          </Col>
          <Col span={8}>
            <Statistic title={t('totalDraws')} value={sessions.reduce((s, x) => s + x.history_count, 0)} prefix={<BarChartOutlined />} />
          </Col>
        </Row>
      </Card>

      {/* 详情弹窗 */}
      <Modal
        title={detail ? t('rollcallDetailTitle', { teacher: detail.teacher, grade: detail.grade, class: detail.class }) : t('loading')}
        open={detailVisible}
        onCancel={() => setDetailVisible(false)}
        footer={[
          <Button key="close" onClick={() => setDetailVisible(false)}>{t('close')}</Button>,
          detail && (
            <Button key="reset" danger onClick={() => {
              Modal.confirm({
                title: t('confirmReset'),
                content: t('confirmResetContent', { grade: detail.grade, class: detail.class }),
                onOk: () => handleReset(detail),
              })
            }}>
              {t('resetClassData')}
            </Button>
          ),
        ]}
        width={800}
      >
        {detailLoading ? <Spin style={{ display: 'block', padding: 60 }} /> : detail ? (
          <div>
            <Descriptions column={3} size="small" bordered>
              <Descriptions.Item label={t('teacher')}><Tag>{detail.teacher}</Tag></Descriptions.Item>
              <Descriptions.Item label={t('grade')}>{detail.grade}</Descriptions.Item>
              <Descriptions.Item label={t('classLabel')}>{detail.class}</Descriptions.Item>
              <Descriptions.Item label={t('studentCount')}>{detail.student_count}</Descriptions.Item>
              <Descriptions.Item label={t('drawCount')}>{detail.history_count}</Descriptions.Item>
              <Descriptions.Item label={t('pickedInRound')}>{detail.picked_in_round.length} {t('people')}</Descriptions.Item>
              <Descriptions.Item label={t('lastUpdated')}>{detail.updated}</Descriptions.Item>
            </Descriptions>

            <Divider>{t('weightDistribution')}</Divider>
            {Object.keys(detail.weights).length === 0 ? (
              <Text type="secondary">{t('noWeightData')}</Text>
            ) : (
              <div style={{ maxHeight: 200, overflow: 'auto', marginBottom: 16 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#fafafa' }}>
                      <th style={thStyle}>{t('student')}</th>
                      <th style={thStyle}>{t('weight')}</th>
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

            <Divider>{t('drawHistory', { count: detail.history.length })}</Divider>
            {detail.history.length === 0 ? (
              <Text type="secondary">{t('noHistoryRecords')}</Text>
            ) : (
              <div style={{ maxHeight: 300, overflow: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#fafafa' }}>
                      <th style={thStyle}>{t('time')}</th>
                      <th style={thStyle}>{t('student')}</th>
                      <th style={thStyle}>{t('result')}</th>
                      <th style={thStyle}>{t('points')}</th>
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
// 考勤统计组件（v4.3）
// ============================================================

interface AttendanceStudent {
  name: string
  username: string
  grade: string
  class: string
  gender: string
  has_logged_in: boolean
  last_login_time: string
  last_login_ip: string
}

interface AttendanceSummary {
  grade: string
  class: string
  total_count: number
  logged_in_count: number
  not_logged_in_count: number
  login_rate: number
  students: AttendanceStudent[]
}

interface StaffLoginInfo {
  name: string
  username: string
  role: string
  grade: string
  class: string
  is_online: boolean
  last_login_time: string
  last_login_ip: string
  last_user_agent: string
}

const AttendanceStats: React.FC = () => {
  const { t } = useTranslation('interaction')
  const user = useAuthStore((s) => s.user)

  const [grades, setGrades] = useState<string[]>([])
  const [classes, setClasses] = useState<string[]>([])
  const [grade, setGrade] = useState<string>('')
  const [cls, setCls] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [summary, setSummary] = useState<AttendanceSummary | null>(null)
  const [viewLogs, setViewLogs] = useState<AttendanceStudent | null>(null)
  const [logRecords, setLogRecords] = useState<any[]>([])
  const [logLoading, setLogLoading] = useState(false)
  const [logModalVisible, setLogModalVisible] = useState(false)
  const [onlineStudents, setOnlineStudents] = useState<AttendanceStudent[]>([])
  const [onlineLoading, setOnlineLoading] = useState(false)

  // ── 教职工登录信息（管理员可见） ──
  const [viewMode, setViewMode] = useState<'student' | 'staff'>('student')
  const [staffList, setStaffList] = useState<StaffLoginInfo[]>([])
  const [staffLoading, setStaffLoading] = useState(false)

  // 默认加载全部在线学生
  const loadOnlineStudents = useCallback(async () => {
    setOnlineLoading(true)
    try {
      const { data } = await apiClient.get('/api/rollcall/attendance/online-students')
      setOnlineStudents(data.students || [])
    } catch {
      // ignore
    } finally {
      setOnlineLoading(false)
    }
  }, [])

  useEffect(() => {
    loadOnlineStudents()
  }, [loadOnlineStudents])

  // ── 加载教职工登录信息（管理员） ──
  const loadStaffLogins = async () => {
    setStaffLoading(true)
    try {
      const { data } = await apiClient.get('/api/rollcall/attendance/staff-logins')
      setStaffList(data.staff || [])
    } catch {
      message.error(t('loadStaffFailed'))
      setStaffList([])
    } finally {
      setStaffLoading(false)
    }
  }

  // 加载年级
  useEffect(() => {
    apiClient.get('/api/rollcall/attendance/grades')
      .then(({ data }) => setGrades(Array.isArray(data) ? data : []))
      .catch(() => setGrades([]))
  }, [])

  const handleGradeChange = async (val: string) => {
    setGrade(val)
    setCls('')
    setClasses([])
    setSummary(null)
    if (!val) {
      loadOnlineStudents()
      return
    }
    try {
      const { data } = await apiClient.get('/api/rollcall/attendance/classes', {
        params: { grade: val },
      })
      setClasses(Array.isArray(data) ? data : [])
    } catch {
      setClasses([])
    }
  }

  const handleClassChange = async (val: string) => {
    setCls(val)
    setSummary(null)
    if (!grade || !val) {
      if (!val) loadOnlineStudents()
      return
    }
    setLoading(true)
    try {
      const { data } = await apiClient.get('/api/rollcall/attendance/summary', {
        params: { grade, class: val },
      })
      setSummary(data)
    } catch {
      message.error(t('loadAttendanceFailed'))
    } finally {
      setLoading(false)
    }
  }

  // ── 清除登录日志 ──
  const [clearTargetUsername, setClearTargetUsername] = useState<string>('')
  const [clearModalVisible, setClearModalVisible] = useState(false)
  const [clearAll, setClearAll] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [keepDays, setKeepDays] = useState<number>(0)

  const showClearModal = (all: boolean, username?: string) => {
    setClearAll(all)
    setClearTargetUsername(username || '')
    setKeepDays(0)
    setClearModalVisible(true)
  }

  const handleClearLogs = async () => {
    setClearing(true)
    try {
      const params: Record<string, string> = {}
      if (!clearAll && clearTargetUsername) {
        params.username = clearTargetUsername
      }
      if (keepDays > 0) {
        params.keep_days = String(keepDays)
      }
      await apiClient.delete('/api/rollcall/attendance/login-logs', { params })
      const msg = keepDays > 0
        ? (clearAll
          ? t('clearLogSuccessKeep', { keepDays })
          : t('clearLogSuccessUserKeep', { keepDays, username: clearTargetUsername }))
        : clearAll
          ? t('clearLogSuccessAll')
          : t('clearLogSuccessUser', { username: clearTargetUsername })
      message.success(msg)
      setClearModalVisible(false)
      // 刷新数据
      if (viewMode === 'staff') {
        loadStaffLogins()
      }
    } catch {
      message.error(t('clearLogFailed'))
    } finally {
      setClearing(false)
    }
  }

  const viewStudentLogs = async (student: AttendanceStudent) => {
    if (!student.username) {
      message.info(t('noStudentRecord'))
      return
    }
    setViewLogs(student)
    setLogLoading(true)
    setLogModalVisible(true)
    try {
      const { data } = await apiClient.get('/api/rollcall/attendance/logs', {
        params: { username: student.username },
      })
      setLogRecords(data.logs || [])
    } catch {
      message.error(t('loadLoginDetailFailed'))
      setLogRecords([])
    } finally {
      setLogLoading(false)
    }
  }

  const columns = [
    {
      title: t('index'), key: 'index', width: 60,
      render: (_: unknown, __: unknown, i: number) => i + 1,
    },
    {
      title: t('name'), dataIndex: 'name', key: 'name',
      render: (name: string, record: AttendanceStudent) => (
        <Space>
          <span>{name}</span>
          {record.gender === '男' ? '♂' : record.gender === '女' ? '♀' : ''}
        </Space>
      ),
    },
    {
      title: t('grade'), dataIndex: 'grade', key: 'grade',
      render: (g: string) => g || <Text type="secondary">-</Text>,
    },
    {
      title: t('classLabel'), dataIndex: 'class', key: 'class',
      render: (c: string) => c || <Text type="secondary">-</Text>,
    },
    {
      title: t('username'), dataIndex: 'username', key: 'username',
      render: (u: string) => u ? <Text copyable={{ text: u }} style={{ fontSize: 12 }}>{u}</Text> : <Text type="secondary">-</Text>,
    },
    {
      title: t('loginStatus'), dataIndex: 'has_logged_in', key: 'has_logged_in',
      render: (logged: boolean) => logged
        ? <Tag icon={<LoginOutlined />} color="success">{t('loggedIn')}</Tag>
        : <Tag icon={<StopOutlined />} color="default">{t('notLoggedIn')}</Tag>,
    },
    {
      title: t('lastLoginTime'), dataIndex: 'last_login_time', key: 'last_login_time',
      render: (t: string) => t || <Text type="secondary">-</Text>,
    },
    {
      title: t('loginIP'), dataIndex: 'last_login_ip', key: 'last_login_ip',
      render: (ip: string) => ip || <Text type="secondary">-</Text>,
    },
    {
      title: t('actions'), key: 'actions', width: 100,
      render: (_: unknown, record: AttendanceStudent) => (
        <Button type="link" size="small" icon={<ClockCircleOutlined />}
          disabled={!record.has_logged_in}
          onClick={() => viewStudentLogs(record)}>
          {t('details')}
        </Button>
      ),
    },
  ]

  // ── 教职工登录表格列 ──
  const staffColumns = [
    {
      title: t('index'), key: 'index', width: 60,
      render: (_: unknown, __: unknown, i: number) => i + 1,
    },
    {
      title: t('name'), dataIndex: 'name', key: 'name',
      render: (n: string) => n || <Text type="secondary">-</Text>,
    },
    {
      title: t('role'), dataIndex: 'role', key: 'role',
      render: (r: string) => r === '管理员'
        ? <Tag color="red">{r}</Tag>
        : <Tag color="blue">{r}</Tag>,
    },
    {
      title: t('username'), dataIndex: 'username', key: 'username',
      render: (u: string) => u ? <Text copyable={{ text: u }} style={{ fontSize: 12 }}>{u}</Text> : <Text type="secondary">-</Text>,
    },
    {
      title: t('onlineStatus'), dataIndex: 'is_online', key: 'is_online',
      render: (online: boolean) => online
        ? <Tag icon={<LoginOutlined />} color="success">{t('online')}</Tag>
        : <Tag icon={<StopOutlined />} color="default">{t('offline')}</Tag>,
    },
    {
      title: t('lastLoginTime'), dataIndex: 'last_login_time', key: 'last_login_time',
      render: (t: string) => t || <Text type="secondary">-</Text>,
    },
    {
      title: t('loginIP'), dataIndex: 'last_login_ip', key: 'last_login_ip',
      render: (ip: string) => ip || <Text type="secondary">-</Text>,
    },
    {
      title: t('actions'), key: 'actions', width: 80,
      render: (_: unknown, record: StaffLoginInfo) => (
        <Button type="link" size="small" danger
          onClick={() => showClearModal(false, record.username)}>
          {t('clearRecord')}
        </Button>
      ),
    },
  ]

  const isAdmin = user?.role === 'admin'

  return (
    <>
      <Card
        title={
          <Space>
            <UserOutlined style={{ color: '#52c41a', fontSize: 20 }} />
            <span>📋 {t('attendanceStats')}</span>
            {isAdmin && (
              <Space.Compact size="small" style={{ marginLeft: 12 }}>
                <Button
                  type={viewMode === 'student' ? 'primary' : 'default'}
                  icon={<TeamOutlined />}
                  onClick={() => { setViewMode('student'); setSummary(null); loadOnlineStudents() }}
                >
                  {t('studentAttendance')}
                </Button>
                <Button
                  type={viewMode === 'staff' ? 'primary' : 'default'}
                  icon={<UserOutlined />}
                  onClick={() => { setViewMode('staff'); loadStaffLogins() }}
                >
                  {t('staffLogin')}
                </Button>
              </Space.Compact>
            )}
          </Space>
        }
        extra={
          <Space>
            {viewMode === 'student' && summary && (
              <Tag color="blue" style={{ fontSize: 13 }}>
                {summary.grade} · {summary.class}
              </Tag>
            )}
            {viewMode === 'student' && !grade && !cls && onlineStudents.length > 0 && (
              <Tag icon={<LoginOutlined />} color="success" style={{ fontSize: 13 }}>
                {t('allOnline', { count: onlineStudents.length })}
              </Tag>
            )}
            {viewMode === 'staff' && staffList.length > 0 && (
              <Tag icon={<UserOutlined />} color="purple" style={{ fontSize: 13 }}>
                {t('staffCount', { count: staffList.length })}
              </Tag>
            )}
            {isAdmin && (
              <Button icon={<DeleteOutlined />} danger
                onClick={() => showClearModal(true)}>
                {t('clearAllRecords')}
              </Button>
            )}
            <Button icon={<ReloadOutlined />}
              onClick={() => {
                if (viewMode === 'staff') loadStaffLogins()
                else if (grade && cls) handleClassChange(cls)
                else loadOnlineStudents()
              }}
              loading={loading || onlineLoading || staffLoading}>
              {t('refreshData')}
            </Button>
          </Space>
        }
        style={{ marginBottom: 16 }}
      >
        <Space orientation="vertical" style={{ width: '100%' }} size="middle">
          {/* ── 学生考勤模式 ── */}
          {viewMode === 'student' && (
            <>
              {/* 选择器 */}
              <Space wrap>
                <Select
                  placeholder={t('selectGradePlaceholder')}
                  value={grade || undefined}
                  onChange={handleGradeChange}
                  options={grades.map(g => ({ label: g, value: g }))}
                  style={{ width: 160 }}
                  size="large"
                  allowClear
                />
                <Select
                  placeholder={t('selectClassPlaceholder')}
                  value={cls || undefined}
                  onChange={handleClassChange}
                  options={classes.map(c => ({ label: c, value: c }))}
                  style={{ width: 180 }}
                  size="large"
                  disabled={!grade}
                  allowClear
                />
                <Text type="secondary" style={{ fontSize: 13 }}>
                  {t('attendanceHelperText')}
                </Text>
              </Space>

              {/* 统计概览 - 班级模式 */}
              {summary && (
                <>
                  <Row gutter={24}>
                    <Col span={6}>
                      <Card size="small" style={{ textAlign: 'center', background: '#f6ffed' }}>
                        <Statistic title={t('classTotalCount')} value={summary.total_count}
                          prefix={<TeamOutlined />} styles={{ content: { color: '#52c41a' } }} />
                      </Card>
                    </Col>
                    <Col span={6}>
                      <Card size="small" style={{ textAlign: 'center', background: '#e6f7ff' }}>
                        <Statistic title={t('loggedInCount')} value={summary.logged_in_count}
                          prefix={<LoginOutlined />} styles={{ content: { color: '#1890ff' } }} />
                      </Card>
                    </Col>
                    <Col span={6}>
                      <Card size="small" style={{ textAlign: 'center', background: '#fff7e6' }}>
                        <Statistic title={t('notLoggedInCount')} value={summary.not_logged_in_count}
                          prefix={<StopOutlined />} styles={{ content: { color: '#faad14' } }} />
                      </Card>
                    </Col>
                    <Col span={6}>
                      <Card size="small" style={{ textAlign: 'center', background: '#f0f5ff' }}>
                        <Statistic title={t('loginRate')} value={summary.login_rate} suffix="%"
                          prefix={<BarChartOutlined />} styles={{ content: { color: '#722ed1' } }} />
                      </Card>
                    </Col>
                  </Row>

                  <Divider>{t('attendanceDetails')}</Divider>

                  <Table
                    dataSource={summary.students}
                    columns={columns}
                    rowKey={(r) => r.username || r.name}
                    loading={loading}
                    pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => t('totalStudentsWithCount', { count: total }) }}
                    size="middle"
                  />
                </>
              )}

              {/* 全部在线学生模式（默认） */}
              {!summary && onlineStudents.length > 0 && (
                <>
                  <Divider>{t('currentOnlineStudents')}</Divider>
                  <Table
                    dataSource={onlineStudents}
                    columns={columns}
                    rowKey={(r) => r.username || r.name}
                    loading={onlineLoading}
                    pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => t('totalOnlineStudents', { count: total }) }}
                    size="middle"
                  />
                </>
              )}

              {!summary && onlineStudents.length === 0 && !onlineLoading && !loading && (
                <Empty description={grade || cls ? t('selectGradeClassHint') : t('noOnlineStudents')} />
              )}

              {(loading || onlineLoading) && (
                <div style={{ textAlign: 'center', padding: 40 }}>
                  <Spin>{t('loadingAttendance')}</Spin>
                </div>
              )}
            </>
          )}

          {/* ── 教职工登录模式 ── */}
          {viewMode === 'staff' && (
            <>
              <Divider>{t('staffLoginInfo')}</Divider>
              <Table
                dataSource={staffList}
                columns={staffColumns}
                rowKey="username"
                loading={staffLoading}
                pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => t('totalStaffCount', { count: total }) }}
                size="middle"
              />
              {staffList.length === 0 && !staffLoading && (
                <Empty description={t('noStaffRecords')} />
              )}
              {staffLoading && (
                <div style={{ textAlign: 'center', padding: 40 }}>
                  <Spin>{t('loadingStaffInfo')}</Spin>
                </div>
              )}
            </>
          )}
        </Space>
      </Card>

      {/* 清除确认弹窗 */}
      <Modal
        title={t('confirmClearLogTitle')}
        open={clearModalVisible}
        onOk={handleClearLogs}
        onCancel={() => setClearModalVisible(false)}
        confirmLoading={clearing}
        okText={t('confirmClear')}
        cancelText={t('cancel')}
        okButtonProps={{ danger: true }}
      >
        <Space orientation="vertical" style={{ width: '100%' }} size="middle">
          <p>
            {clearAll
              ? t('confirmClearLogContent')
              : t('confirmClearUserLogContent', { username: clearTargetUsername })
            }
          </p>
          {clearAll && (
            <Space>
              <span style={{ whiteSpace: 'nowrap' }}>{t('clearOnly')}</span>
              <Select
                value={keepDays}
                onChange={setKeepDays}
                style={{ width: 120 }}
                options={[
                  { label: t('allRecords'), value: 0 },
                  { label: t('keep7Days'), value: 7 },
                  { label: t('keep15Days'), value: 15 },
                  { label: t('keep30Days'), value: 30 },
                  { label: t('keep90Days'), value: 90 },
                ]}
              />
              <span style={{ whiteSpace: 'nowrap' }}>{t('beforeOldRecords')}</span>
            </Space>
          )}
        </Space>
      </Modal>

      {/* 登录明细弹窗 */}
      <Modal
        title={viewLogs ? t('loginRecordOf', { name: viewLogs.name }) : t('loginDetails')}
        open={logModalVisible}
        onCancel={() => setLogModalVisible(false)}
        footer={<Button onClick={() => setLogModalVisible(false)}>{t('close')}</Button>}
        width={700}
      >
        {logLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
        ) : logRecords.length === 0 ? (
          <Empty description={t('noLoginRecords')} />
        ) : (
          <Table
            dataSource={logRecords}
            rowKey="id"
            size="small"
            pagination={{ pageSize: 10, showTotal: (total) => t('totalRecordCount', { count: total }) }}
            columns={[
              { title: t('index'), key: 'idx', width: 60, render: (_: unknown, __: unknown, i: number) => i + 1 },
              { title: t('loginTime'), dataIndex: 'login_time', key: 'login_time' },
              { title: t('loginIP'), dataIndex: 'login_ip', key: 'login_ip' },
              { title: t('browser'), dataIndex: 'user_agent', key: 'user_agent', ellipsis: true },
              {
                title: t('logoutTime'), dataIndex: 'logout_time', key: 'logout_time',
                render: (val: string) => val || <Tag color="processing">{t('online')}</Tag>,
              },
            ]}
          />
        )}
      </Modal>
    </>
  )
}


// ============================================================
// 页面主组件
// ============================================================

const RollcallManagePage: React.FC = () => {
  const { t } = useTranslation('interaction')
  return (
    <Card style={{ borderRadius: 8 }}>
      <Tabs
        defaultActiveKey="tool"
        items={[
          {
            key: 'tool',
            label: <span><AimOutlined /> 🎯 {t('randomRollcall')}</span>,
            children: <RollcallTool />,
          },
          {
            key: 'manage',
            label: <span><HistoryOutlined /> 📊 {t('dataManagement')}</span>,
            children: <SessionsManager />,
          },
          {
            key: 'attendance',
            label: <span><UserOutlined /> 📋 {t('attendanceStats')}</span>,
            children: <AttendanceStats />,
          },
        ]}
      />
    </Card>
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
