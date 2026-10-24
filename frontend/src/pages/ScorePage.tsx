import React, { useState, useEffect, useCallback } from 'react'
import {
  Card, Select, Table, Button, message, Statistic, Row, Col,
  Space, Typography, Divider, Tooltip, Alert, Drawer, Input, InputNumber, Modal,
  Spin, Empty, Popconfirm, Tag,
} from 'antd'
import {
  PlusOutlined, MinusOutlined, TrophyOutlined,
  ReloadOutlined, BarChartOutlined, TeamOutlined,
  DownloadOutlined, UserOutlined, StarOutlined,
  HistoryOutlined, RiseOutlined, UndoOutlined,
} from '@ant-design/icons'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useRewardLabels, REWARD_TAG_COLORS } from '../utils/rewardLabels'
import { PointsCell } from '../components/PointsCell'
import { reportLoadError } from '../utils/loadError'

const { Text } = Typography

interface Student {
  /** 学号 = 登录用户名（全站统一以 username 作为学号展示） */
  username?: string
  class: string
  name: string
  gender: string
  score?: number
  reward_points?: number
  total_points?: number
}

/** 教师端提示条用的规则摘要（全部来自后端，避免再写死一份会过期的分值） */
interface RewardChips {
  participation_min: number; participation_max: number
  grade_exam: { excellent: number; good: number; pass: number }
  grade_quiz: { excellent: number; good: number; pass: number }
  grade_class: { excellent: number; good: number; pass: number }
  rank_bonus_list: string
  pool_academic: number; pool_class: number; pool_fun: number
  has_grade_bonus: boolean
}

interface Stats {
  total: number
  avg: number
  max_score: number
  max_name: string
  count: number
}

const ScorePage: React.FC = () => {
  const { t } = useTranslation('score')
  const { actLabel, rewardTypeLabel } = useRewardLabels()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const isAdminOrTeacher = user?.role === 'admin' || user?.role === 'teacher'
  const isStudent = user?.role === 'student'
  const isAdmin = user?.role === 'admin'

  // 教师隔离：默认当前用户，管理员可切换
  const [currentTeacher, setCurrentTeacher] = useState(user?.username || 'root')
  const [teacherList, setTeacherList] = useState<string[]>([])
  const [allowedGrades, setAllowedGrades] = useState<string[]>([])

  useEffect(() => {
    if (user?.username) setCurrentTeacher(user.username)
  }, [user?.username])

  useEffect(() => {
    if (isAdmin) {
      apiClient.get('/api/scores/teachers').then(({ data }) => {
        if (Array.isArray(data)) setTeacherList(data)
      }).catch((err) => { reportLoadError(err, { key: 'score.teachers' }) })
    }
  }, [isAdmin])

  // 加载当前教师可查看的年级列表
  useEffect(() => {
    apiClient.get('/api/scores/my-grades', { params: { teacher: currentTeacher } })
      .then(({ data }) => {
        if (Array.isArray(data) && data.length > 0) {
          setAllowedGrades(data)
          setGrade((prev) => data.includes(prev) ? prev : data[0])
        }
      })
      .catch((err) => { reportLoadError(err, { key: 'score.grades' }) })
  }, [currentTeacher])

  const [grade, setGrade] = useState<string>('')
  const [classes, setClasses] = useState<string[]>([])
  const [cls, setCls] = useState<string>('')
  const [students, setStudents] = useState<Student[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'scores' | 'ranking'>('scores')
  // 奖励积分规则摘要（后端 /api/rewards/rules 是唯一真相，这里只取提示条要用的几个数）
  const [ruleChips, setRuleChips] = useState<RewardChips | null>(null)

  useEffect(() => {
    let ignore = false
    apiClient.get('/api/rewards/rules')
      .then(({ data }) => {
        if (ignore || !Array.isArray(data?.activities)) return
        const acts = data.activities as Array<{ type: string; participation: number; grade: null | { excellent: number; good: number; pass: number } }>
        const grades = acts.filter((a) => a.grade).map((a) => a.grade!)
        const pick = (type: string) => acts.find((a) => a.type === type)?.grade ?? { excellent: 0, good: 0, pass: 0 }
        const pools = Object.fromEntries((data.pools ?? []).map((p: { key: string; cap: number }) => [p.key, p.cap]))
        setRuleChips({
          participation_min: Math.min(...acts.map((a) => a.participation)),
          participation_max: Math.max(...acts.map((a) => a.participation)),
          grade_exam: pick('exam'),
          grade_quiz: pick('quiz'),
          grade_class: pick('rollcall'),
          rank_bonus_list: (Object.values(data.rank_bonus ?? {}) as Array<{ points: number }>)
            .map((v) => v.points).join('/'),
          pool_academic: pools.academic ?? 0,
          pool_class: pools.class ?? 0,
          pool_fun: pools.fun ?? 0,
          has_grade_bonus: grades.length > 0,
        })
      })
      .catch((err) => { reportLoadError(err, { key: 'score.rules' }) })
    return () => { ignore = true }
  }, [])


  // 加载当前教师的任教信息
  const [teacherInfo, setTeacherInfo] = useState<string>('')
  useEffect(() => {
    apiClient.get('/api/scores/teacher-info', { params: { teacher: currentTeacher } })
      .then(({ data }) => setTeacherInfo(data.teaching || ''))
      .catch(() => setTeacherInfo(''))
  }, [currentTeacher])

  // 带 teacher 参数的 API 调用封装
  const scoreParams = useCallback((extra: Record<string, any> = {}) => ({
    ...extra, teacher: currentTeacher,
  }), [currentTeacher])


  // ── 加载班级列表（当年级或教师变化时自动加载） ──
  useEffect(() => {
    if (!grade) return
    apiClient.get('/api/scores/classes', { params: { grade, teacher: currentTeacher } })
      .then(({ data }) => {
        setClasses(Array.isArray(data) ? data : [])
        // 如果当前选中的班级不在新列表中，重置
        setCls((prev) => {
          if (!prev || !Array.isArray(data) || !data.includes(prev)) return ''
          return prev
        })
      })
      .catch(() => setClasses([]))
  }, [grade, currentTeacher])

  // ── 加载学生及积分 ──
  const loadStudents = useCallback(async () => {
    if (!cls) return
    setLoading(true)
    try {
      const { data } = await apiClient.get('/api/scores/students', {
        params: scoreParams({ grade, class: cls }),
      })
      setStudents(Array.isArray(data) ? data : [])
    } catch {
      message.error(t('loadFailed'))
      setStudents([])
    } finally {
      setLoading(false)
    }
  }, [grade, cls, scoreParams])

  // ── 加载统计 ──
  const loadStats = useCallback(async () => {
    if (!cls) return
    try {
      const { data } = await apiClient.get('/api/scores/stats', {
        params: scoreParams({ grade, class: cls }),
      })
      setStats(data)
    } catch {
      setStats(null)
    }
  }, [grade, cls, scoreParams])

  // ── 加载排行 ──
  const [ranking, setRanking] = useState<Student[]>([])
  const [rankingLoading, setRankingLoading] = useState(false)

  const loadRanking = useCallback(async () => {
    setRankingLoading(true)
    try {
      const params: Record<string, any> = scoreParams({ grade })
      if (cls) params.class = cls
      const { data } = await apiClient.get('/api/scores/ranking', { params })
      setRanking(Array.isArray(data) ? data : [])
    } catch {
      setRanking([])
    } finally {
      setRankingLoading(false)
    }
  }, [grade, cls, scoreParams])

  // 学生直接查询自己的积分
  const [myScore, setMyScore] = useState<{ score: number; class: string; grade: string; teacher?: string; teacher_scores?: Record<string, number> } | null>(null)
  const [myScoreLoading, setMyScoreLoading] = useState(false)

  // ── 积分奖励（活动自动积分） ──
  const [rewardPoints, setRewardPoints] = useState<number>(0)
  const [rewardHistory, setRewardHistory] = useState<any[]>([])
  const [rewardLoading, setRewardLoading] = useState(false)

  useEffect(() => {
    if (isStudent && user?.name) {
      setMyScoreLoading(true)
      apiClient.get('/api/scores/my-score', { params: { name: user.name, teacher: currentTeacher } })
        .then(({ data }) => {
          if (data.score !== undefined && data.score !== null) {
            setMyScore(data)
          } else {
            setMyScore(null)
          }
        })
        .catch(() => setMyScore(null))
        .finally(() => setMyScoreLoading(false))
    }
  }, [isStudent, user?.name, currentTeacher])

  // 加载学生奖励积分
  const loadRewardPoints = useCallback(async () => {
    if (!isStudent) return
    setRewardLoading(true)
    try {
      const [pRes, hRes] = await Promise.all([
        apiClient.get('/api/rewards/my-points'),
        apiClient.get('/api/rewards/my-history', { params: { limit: 50 } }),
      ])
      setRewardPoints(pRes.data.total_points || 0)
      setRewardHistory(Array.isArray(hRes.data) ? hRes.data : [])
    } catch {
      // 忽略
    } finally {
      setRewardLoading(false)
    }
  }, [isStudent])

  useEffect(() => { loadStudents(); loadStats() }, [loadStudents, loadStats])
  useEffect(() => {
    if (activeTab === 'ranking') loadRanking()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])
  useEffect(() => {
    if (isStudent) loadRewardPoints()
  }, [isStudent, loadRewardPoints])

  // ── 加减分 ──
  const handleScore = async (student: Student, points: number) => {
    try {
      const { data } = await apiClient.post('/api/scores/score', {
        grade, class: cls, name: student.name, points, teacher: currentTeacher,
      })
      message.success(t('pointsChanged', { name: student.name, points: points > 0 ? '+' + points : points, total: data.total }))
      loadStudents()
      loadStats()
    } catch {
      message.error(t('saveFail'))
    }
  }

  // ── 重置分数 ──
  const handleReset = async (student?: Student) => {
    try {
      if (student) {
        await apiClient.post('/api/scores/reset', {
          grade, class: cls, name: student.name, teacher: currentTeacher,
        })
        message.success(t('resetSuccess', { name: student.name }))
      } else {
        await apiClient.post('/api/scores/reset', { grade, class: cls, teacher: currentTeacher })
        message.success(t('resetAllSuccess', { cls }))
      }
      loadStudents()
      loadStats()
    } catch {
      message.error(t('resetFail'))
    }
  }

  // ── 批量选择 / 自定义分值 / 积分流水 / 撤销（S-UI）──
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([])
  const [customOpen, setCustomOpen] = useState(false)
  const [customTarget, setCustomTarget] = useState<Student | null>(null)
  const [customValue, setCustomValue] = useState<number | null>(null)
  const [customReason, setCustomReason] = useState('')
  const [logsOpen, setLogsOpen] = useState(false)
  const [logsLoading, setLogsLoading] = useState(false)
  const [logs, setLogs] = useState<any[]>([])
  const [logsFor, setLogsFor] = useState('')          // '' = 全班
  const [undoing, setUndoing] = useState(false)

  const selectedStudents = students.filter((s) => selectedKeys.includes(s.username || s.name))

  const refreshAll = () => { loadStudents(); loadStats(); loadRanking() }

  /** 批量加减分：一次操作共用一个 op_id，可整组撤销 */
  const applyBatch = async (points: number, reason = '') => {
    const names = selectedStudents.map((s) => s.name)
    if (!names.length) return
    try {
      const { data } = await apiClient.post('/api/scores/batch', {
        grade, class: cls, names, points, reason, teacher: currentTeacher,
      })
      message.success(t('batchDone', { count: data.updated, points: points > 0 ? '+' + points : points }))
      setSelectedKeys([])
      refreshAll()
    } catch {
      message.error(t('saveFail'))
    }
  }

  const openCustomPoints = (student: Student | null) => {
    setCustomTarget(student)
    setCustomValue(null)
    setCustomReason('')
    setCustomOpen(true)
  }

  /** 自定义分值：单人（customTarget）或批量（当前勾选） */
  const submitCustomPoints = async () => {
    const pts = Number(customValue || 0)
    if (!pts) { message.warning(t('pointsNotZero')); return }
    if (!customTarget && !selectedStudents.length) { message.warning(t('batchPickFirst')); return }
    if (!customTarget) {
      setCustomOpen(false)
      await applyBatch(pts, customReason.trim())
      return
    }
    try {
      const { data } = await apiClient.post('/api/scores/score', {
        grade, class: cls, name: customTarget.name, points: pts,
        reason: customReason.trim(), teacher: currentTeacher,
      })
      message.success(t('pointsChanged', { name: customTarget.name, points: pts > 0 ? '+' + pts : pts, total: data.total }))
      setCustomOpen(false)
      refreshAll()
    } catch {
      message.error(t('saveFail'))
    }
  }

  /** 撤销最近一次操作：后端按流水反向应用（学生改名转班也能撤对） */
  const handleUndo = async () => {
    setUndoing(true)
    try {
      const { data } = await apiClient.post('/api/scores/undo', {
        grade, class: cls, teacher: currentTeacher,
      })
      if (data.success) message.success(t('undoDone', { count: data.reversed_students, points: data.reversed_points }))
      else message.info(t('undoNothing'))
      refreshAll()
      if (logsOpen) loadLogs(logsFor)
    } catch {
      message.error(t('undoFail'))
    } finally {
      setUndoing(false)
    }
  }

  const loadLogs = async (studentName = '') => {
    setLogsLoading(true)
    try {
      const { data } = await apiClient.get('/api/scores/logs', {
        params: scoreParams({ grade, class: cls, name: studentName, limit: 200 }),
      })
      setLogs(Array.isArray(data.logs) ? data.logs : [])
    } catch {
      setLogs([])
    } finally {
      setLogsLoading(false)
    }
  }

  const openLogs = (studentName = '') => {
    setLogsFor(studentName)
    setLogsOpen(true)
    loadLogs(studentName)
  }

  /** 流水里的原因：内置操作存的是机器码，显示时翻译；其余是老师手填的原文 */
  const reasonLabel = (r: string) =>
    r === 'reset' ? t('reasonReset') : r === 'undo' ? t('reasonUndo') : (r || t('reasonManual'))

  // ── 积分操作按钮 ──
  const ScoreActions = ({ student }: { student: Student }) => (
    <Space size="small">
      <Tooltip title="+1">
        <Button size="small" type="primary" ghost
          icon={<PlusOutlined />}
          onClick={() => handleScore(student, 1)}
        >+1</Button>
      </Tooltip>
      <Tooltip title="+2">
        <Button size="small" style={{ borderColor: '#52c41a', color: '#52c41a' }}
          icon={<PlusOutlined />}
          onClick={() => handleScore(student, 2)}
        >+2</Button>
      </Tooltip>
      <Tooltip title="+5">
        <Button size="small" type="primary"
          icon={<PlusOutlined />}
          onClick={() => handleScore(student, 5)}
        >+5</Button>
      </Tooltip>
      <Tooltip title="-1">
        <Button size="small" danger
          icon={<MinusOutlined />}
          onClick={() => handleScore(student, -1)}
        >-1</Button>
      </Tooltip>
      <Popconfirm
        title={t('resetStudentConfirm')}
        onConfirm={() => handleReset(student)}
        okText={t('confirm')}
        cancelText={t('cancel')}
      >
        <Tooltip title={t('resetToZero')}>
          <Button size="small" danger type="dashed" icon={<ReloadOutlined />} />
        </Tooltip>
      </Popconfirm>
      {isAdminOrTeacher && (
        <Tooltip title={t('logs')}>
          <Button size="small" type="text" icon={<HistoryOutlined />}
            onClick={() => openLogs(student.name)} />
        </Tooltip>
      )}
      {isAdminOrTeacher && (
        <Tooltip title={t('customPoints')}>
          <Button size="small" type="text" icon={<RiseOutlined />}
            onClick={() => openCustomPoints(student)} />
        </Tooltip>
      )}
      {isAdminOrTeacher && (
        <Tooltip title={t('viewPortfolio')}>
          <Button size="small" type="link"
            icon={<UserOutlined />}
            onClick={async () => {
              try {
                const { data } = await apiClient.get('/api/users', { params: { keyword: student.name } })
                const found = data.users?.find((u: any) => u.name === student.name && u.role === '普通用户')
                if (found) navigate(`/portfolio/${found.username}`)
                else message.warning(t('userNotFound'))
              } catch { message.warning(t('queryFailed')) }
            }}
          >
            {t('portfolio')}
          </Button>
        </Tooltip>
      )}
    </Space>
  )

  // ── 表格列（统一显示手动积分 + 奖励积分 + 综合积分）──
  const scoreColumns = [
    { title: t('studentId'), dataIndex: 'username', key: 'username', width: 100,
      render: (v: string) => v || '-' },
    { title: t('name'), dataIndex: 'name', key: 'name', width: 80 },
    { title: t('gender'), dataIndex: 'gender', key: 'gender', width: 60 },
    {
      title: t('manualScore'), dataIndex: 'score', key: 'score', width: 80,
      sorter: (a: any, b: any) => (b.score || 0) - (a.score || 0),
      render: (score: number) => (
        <Text strong style={{ color: score > 0 ? '#52c41a' : score < 0 ? '#ff4d4f' : undefined }}>
          {score ?? 0}
        </Text>
      ),
    },
    {
      title: t('rewardScore'), dataIndex: 'reward_points', key: 'reward_points', width: 80,
      sorter: (a: any, b: any) => (b.reward_points || 0) - (a.reward_points || 0),
      render: (points: number) => (
        <Text strong style={{ color: '#fa8c16' }}>{points ?? 0}</Text>
      ),
    },
    {
      title: t('totalScore_'), dataIndex: 'total_points', key: 'total_points', width: 80,
      sorter: (a: any, b: any) => (b.total_points || 0) - (a.total_points || 0),
      defaultSortOrder: 'descend' as const,
      render: (points: number) => (
        <Text strong style={{ color: '#722ed1', fontSize: 15 }}>{points ?? 0}</Text>
      ),
    },
    {
      title: t('actions'), key: 'action', width: 400,
      render: (_: any, record: Student) =>
        isAdminOrTeacher ? <ScoreActions student={record} /> : null,
    },
  ]

  // 排行榜（按综合积分排序）
  const rankingColumns = [
    { title: t('rank'), key: 'rank', width: 60,
      render: (_: any, __: any, idx: number) => {
        // S-RANK: 同分并列 —— 名次与前一名相同则沿用前一名次，奖牌只给并列的第一人，
        // 其余显示 #名次（旧实现直接拿数组下标发牌，并列时奖牌会错位）
        const cur = ranking[idx]?.total_points ?? 0
        const prev = idx > 0 ? (ranking[idx - 1]?.total_points ?? 0) : null
        let rank = idx + 1
        if (prev !== null && cur === prev) {
          let k = idx - 1
          while (k > 0 && (ranking[k]?.total_points ?? 0) === (ranking[k - 1]?.total_points ?? 0)) k--
          rank = k + 1
        }
        const tiedAndNotFirst = prev !== null && cur === prev
        const medals = ['🥇', '🥈', '🥉']
        return (
          <span style={{ fontSize: 16 }}>
            {rank <= 3 && !tiedAndNotFirst ? medals[rank - 1] : `#${rank}`}
          </span>
        )
      },
    },
    { title: t('studentId'), dataIndex: 'username', key: 'username', width: 100,
      render: (v: string) => v || '-' },
    { title: t('name'), dataIndex: 'name', key: 'name', width: 100 },
    ...(!cls ? [{ title: t('className'), dataIndex: 'class', key: 'class', width: 100 }] : []),
    {
      title: t('score_'), dataIndex: 'score', key: 'score', width: 60,
      render: (score: number) => <Text type="secondary">{score ?? 0}</Text>,
    },
    {
      title: t('reward_'), dataIndex: 'reward_points', key: 'reward_points', width: 60,
      render: (points: number) => <Text type="secondary" style={{ color: '#fa8c16' }}>{points ?? 0}</Text>,
    },
    {
      title: t('total_'), dataIndex: 'total_points', key: 'total_points', width: 80,
      render: (points: number) => (
        <Text strong style={{ color: '#faad14', fontSize: 16 }}>
          {points ?? 0}
        </Text>
      ),
    },
    {
      title: t('levelLabel'), key: 'level', width: 70,
      render: (_: any, record: any) => {
        const p = record.total_points || record.score || 0
        if (p >= 200) return <Tag color="red">{t('levelGod')}</Tag>
        if (p >= 100) return <Tag color="orange">{t('levelScholar')}</Tag>
        if (p >= 50) return <Tag color="blue">{t('levelAdvanced')}</Tag>
        if (p >= 20) return <Tag color="green">{t('levelRookie')}</Tag>
        return <Tag>{t('levelBeginner')}</Tag>
      },
    },
  ]

  return (
    <Card style={{ borderRadius: 8 }}>
      {/* ── 顶栏：年级/班级选择 + 统计 ── */}
      {isStudent ? null : (
      <Card style={{ marginBottom: 16 }}>
        <Row gutter={16} align="middle">
          <Col>
            <Space>
              {isAdmin && teacherList.length > 0 && (
                // S-ROLE: 只有管理员能切换"以哪位教师的身份看积分"；教师页面上这个下拉不渲染，
                // 后端也强制用登录身份（参数 teacher 仅管理员生效），所以教师切不了别人。
                <Select value={currentTeacher} onChange={(v) => setCurrentTeacher(v)}
                  style={{ width: 150 }} options={teacherList.map((t) => ({ label: t, value: t }))}
                  placeholder={t('selectTeacher')}
                  showSearch optionFilterProp="label"
                />
              )}
              {teacherInfo && (
                <Typography.Text type="secondary" style={{ fontSize: 12, maxWidth: 300 }} ellipsis={{ tooltip: teacherInfo }}>
                  📍 {teacherInfo}
                </Typography.Text>
              )}
              <Select value={grade} onChange={(v) => { setGrade(v); setCls('') }}
                style={{ width: 100 }} options={allowedGrades.map((g) => ({ label: g, value: g }))}
              />
              <Select value={cls} onChange={setCls} style={{ width: 160 }}
                placeholder={t('selectClass')}
                options={classes.map((c) => ({ label: c, value: c }))}
                notFoundContent={<Empty description={t('noClass')} />}
              />
              <Tooltip title={t('refresh')}>
                <Button icon={<ReloadOutlined />} onClick={() => { loadStudents(); loadStats() }} />
              </Tooltip>
              <Tooltip title={t('exportExcel')}>
                <Button icon={<DownloadOutlined />} onClick={() => {
                  const params = new URLSearchParams({ teacher: currentTeacher, grade, cls })
                  window.open(`/api/export/scores?${params.toString()}`, '_blank')
                }} disabled={!cls} />
              </Tooltip>
            </Space>
          </Col>

          {stats && cls && (
            <>
              <Divider type="vertical" style={{ height: 40 }} />
              <Col>
                <Statistic title={t('totalScoreStat')} value={stats.total} prefix={<TrophyOutlined />}
                  styles={{ content: { color: '#faad14' } }} />
              </Col>
              <Col>
                <Statistic title={t('avgScore')} value={stats.avg} suffix="/" />
              </Col>
              <Col>
                <Statistic title={t('maxScore')} value={stats.max_score}
                  suffix={<Text type="secondary">({stats.max_name})</Text>} />
              </Col>
              <Col>
                <Statistic title={t('studentCount')} value={stats.count} prefix={<TeamOutlined />} />
              </Col>
            </>
          )}
        </Row>
      </Card>
      )}

      {/* ── 学生个人积分（统一视图） ── */}
      {isStudent && (
        <>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={8}>
              <Card style={{ background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none' }}>
                {myScoreLoading ? (
                  <div style={{ textAlign: 'center', padding: 10, color: 'rgba(255,255,255,0.8)' }}>{t('loading')}</div>
                ) : myScore ? (
                  <div style={{ textAlign: 'center' }}>
                    <TrophyOutlined style={{ fontSize: 32, color: '#ffd700' }} />
                    <div style={{ fontSize: 12, opacity: 0.8, color: '#fff', marginTop: 4 }}>{t('myManualScore')}</div>
                    <div style={{ fontSize: 26, fontWeight: 700, color: '#ffd700' }}>{myScore.score ?? 0}</div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 4 }}>
                      {user?.name} · {myScore.class}
                    </div>
                  </div>
                ) : (
                  <div style={{ textAlign: 'center', padding: 10, color: 'rgba(255,255,255,0.8)' }}>{t('noScoreData')}</div>
                )}
              </Card>
            </Col>
            <Col span={8}>
              <Card style={{ background: 'linear-gradient(135deg,#fa8c16,#faad14)', color: '#fff', border: 'none' }}>
                <Spin spinning={rewardLoading}>
                  <div style={{ textAlign: 'center' }}>
                    <StarOutlined style={{ fontSize: 32, color: '#fff' }} />
                    <div style={{ fontSize: 12, opacity: 0.8, color: '#fff', marginTop: 4 }}>{t('myRewardPoints')}</div>
                    <div style={{ fontSize: 26, fontWeight: 700, color: '#fff' }}>{rewardPoints}</div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 4 }}>
                      {(() => {
                        const p = rewardPoints
                        if (p >= 200) return t('levelGod')
                        if (p >= 100) return t('levelScholar')
                        if (p >= 50) return t('levelAdvanced')
                        if (p >= 20) return t('levelRookie')
                        return t('levelBeginner')
                      })()}
                    </div>
                  </div>
                </Spin>
              </Card>
            </Col>
            <Col span={8}>
              <Card style={{ background: 'linear-gradient(135deg,#722ed1,#9c27b0)', color: '#fff', border: 'none' }}>
                <div style={{ textAlign: 'center' }}>
                  <TrophyOutlined style={{ fontSize: 32, color: '#ffd700' }} />
                  <div style={{ fontSize: 12, opacity: 0.8, color: '#fff', marginTop: 4 }}>{t('myTotalScore')}</div>
                  <div style={{ fontSize: 32, fontWeight: 700, color: '#ffd700' }}>
                    {myScoreLoading || rewardLoading ? '...' : (myScore?.score || 0) + rewardPoints}
                  </div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 4 }}>
                    {t('manualPlusReward')}
                  </div>
                </div>
              </Card>
            </Col>
          </Row>

          {/* 积分奖励明细 */}
          <Card
            size="small"
            title={<Space><StarOutlined style={{ color: '#faad14' }} /> {t('activityRewards')}</Space>}
            style={{ marginBottom: 16 }}
          >
            <Spin spinning={rewardLoading}>
              {rewardHistory.length === 0 ? (
                <Empty description={t('noActivityRewards')} />
              ) : (
                <Table
                  dataSource={rewardHistory}
                  rowKey="id"
                  size="small"
                  pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => t('totalRecords', { count: total }), pageSizeOptions: ['5', '10', '20', '50'] }}
                  columns={[
                    { title: t('time'), dataIndex: 'created_at', key: 'created_at', width: 130,
                      render: (v: string) => v?.slice(0, 16) || '' },
                    { title: t('activity'), dataIndex: 'activity_type', key: 'activity_type', width: 90,
                      render: (type: string, rec: any) => <Tag>{actLabel(type, rec.activity_type_name)}</Tag> },
                    { title: t('activityName'), dataIndex: 'activity_title', key: 'activity_title', ellipsis: true },
                    { title: t('rewardType'), dataIndex: 'reward_type', key: 'reward_type', width: 90,
                      render: (type: string, rec: any) => (
                        <Tag color={REWARD_TAG_COLORS[type] || 'default'}>{rewardTypeLabel(type, rec.reward_type_name)}</Tag>
                      ),
                    },
                    { title: t('points'), dataIndex: 'points', key: 'points', width: 70,
                      render: (p: number) => <PointsCell points={p} />,
                    },
                    { title: t('description'), dataIndex: 'reason', key: 'reason', ellipsis: true },
                  ]}
                />
              )}
            </Spin>
          </Card>
        </>
      )}

      {/* ── 学生：仅看自己积分，不显示班级列表 ── */}
      {isStudent ? null : (
      <Card>
        <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
          <Col>
            <Space>
              <Button
                type={activeTab === 'scores' ? 'primary' : 'default'}
                icon={<TrophyOutlined />}
                onClick={() => setActiveTab('scores')}
              >{t('scoreManage')}</Button>
              <Button
                type={activeTab === 'ranking' ? 'primary' : 'default'}
                icon={<BarChartOutlined />}
                onClick={() => setActiveTab('ranking')}
              >{t('ranking')}</Button>

            </Space>
          </Col>
          <Col>
            {activeTab === 'scores' && cls && (
              <Space>
                {isAdminOrTeacher && (
                  <>
                    <Button icon={<HistoryOutlined />} onClick={() => openLogs('')}>{t('logs')}</Button>
                    <Popconfirm
                      title={t('undoConfirm')}
                      onConfirm={handleUndo}
                      okText={t('confirm')}
                      cancelText={t('cancel')}
                    >
                      <Button icon={<UndoOutlined />} loading={undoing}>{t('undo')}</Button>
                    </Popconfirm>
                  </>
                )}
                <Popconfirm
                  title={t('resetAllConfirm', { cls })}
                  onConfirm={() => handleReset()}
                  okText={t('confirmReset')}
                  cancelText={t('cancel')}
                >
                  <Button danger icon={<ReloadOutlined />}>{t('resetAll')}</Button>
                </Popconfirm>
              </Space>
            )}
          </Col>
        </Row>

        {/* ── 积分规则提示 ──
            这里以前写死"参与+2 / 优秀+15 / 良好+10 / 及格+5"，是奖励引擎之外的第二份真相：
            等级奖改成按活动权重发放后，这排标签还在宣传旧分值（只有考试是 15/10/5，
            测验作业 9/6/3、课堂应答 6/4/2，参与分也变成 1~3 不等）。现在统一从
            GET /api/rewards/rules 取，教师看到的与学生看到的同源。 */}
        {activeTab === 'scores' && ruleChips && (
          <Card size="small" style={{ marginBottom: 12, background: '#fffbe6', fontSize: 13 }}>
            📋 {t('scoreRulesDesc')}
            <div style={{ marginTop: 6 }}>
              <Tag color="blue">{t('tagParticipationRange', { min: ruleChips.participation_min, max: ruleChips.participation_max })}</Tag>
              <Tag color="success">{t('tagGradeExam', { e: ruleChips.grade_exam.excellent, g: ruleChips.grade_exam.good, p: ruleChips.grade_exam.pass })}</Tag>
              <Tag color="processing">{t('tagGradeQuiz', { e: ruleChips.grade_quiz.excellent, g: ruleChips.grade_quiz.good, p: ruleChips.grade_quiz.pass })}</Tag>
              <Tag color="purple">{t('tagGradeClass', { e: ruleChips.grade_class.excellent, g: ruleChips.grade_class.good, p: ruleChips.grade_class.pass })}</Tag>
              <Tag color="orange">{t('tagRankBonus', { list: ruleChips.rank_bonus_list })}</Tag>
              <Tag color="red">{t('tagDailyPools', { a: ruleChips.pool_academic, c: ruleChips.pool_class, f: ruleChips.pool_fun })}</Tag>
            </div>
          </Card>
        )}

        {/* ── 积分管理 Tab ── */}
        {activeTab === 'scores' && (
          !cls ? (
            <Empty description={t('selectGradeClass')} />
          ) : (
            <Spin spinning={loading}>
              {isAdminOrTeacher && selectedStudents.length > 0 && (
                <Alert
                  type="info" showIcon style={{ marginBottom: 8 }}
                  message={
                    <Space wrap>
                      <Text>{t('batchSelected', { count: selectedStudents.length })}</Text>
                      {[1, 2, 5, -1].map((p) => (
                        <Button key={p} size="small" onClick={() => applyBatch(p)}>
                          {p > 0 ? `+${p}` : p}
                        </Button>
                      ))}
                      <Button size="small" onClick={() => openCustomPoints(null)}>{t('customPoints')}</Button>
                      <Button size="small" type="link" onClick={() => setSelectedKeys([])}>{t('clearSelection')}</Button>
                    </Space>
                  }
                />
              )}
              <Table
                dataSource={students}
                columns={scoreColumns}
                rowKey={(r) => r.username || r.name}
                rowSelection={isAdminOrTeacher ? {
                  selectedRowKeys: selectedKeys,
                  onChange: (keys) => setSelectedKeys(keys),
                } : undefined}
                pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => t('totalStudents', { count: total }), pageSizeOptions: ['10', '20', '50'] }}
                size="small"
                locale={{ emptyText: <Empty description={t('noStudentData')} /> }}
              />
            </Spin>
          )
        )}

        {/* ── 排行榜 Tab ── */}
        {activeTab === 'ranking' && (
          <Spin spinning={rankingLoading}>
            {ranking.length === 0 ? (
              <Empty description={cls ? t('noRankingData') : t('selectGradeForRanking')} />
            ) : (
              <Table
                dataSource={ranking}
                columns={rankingColumns}
                rowKey={(r) => r.username || r.name}
                pagination={{ pageSize: 50, hideOnSinglePage: true }}
                size="small"
                rowClassName={(record) =>
                  isStudent && record.name === user?.name ? 'score-my-row' : ''
                }
              />
            )}
            <style>{`
              .score-my-row { background-color: #e6f4ff !important; }
              .score-my-row td:first-child::after { content: ' 👈'; }
            `}</style>
          </Spin>
        )}

      </Card>
      )}

      {/* ── 积分明细（流水）：谁、何时、加/扣多少、为什么，可撤销 ── */}
      <Drawer
        title={logsFor ? t('logsFor', { name: logsFor }) : t('logs')}
        placement="right"
        width={540}
        open={logsOpen}
        onClose={() => setLogsOpen(false)}
        extra={isAdminOrTeacher ? (
          <Popconfirm
            title={t('undoConfirm')}
            onConfirm={handleUndo}
            okText={t('confirm')}
            cancelText={t('cancel')}
          >
            <Button size="small" icon={<UndoOutlined />} loading={undoing}>{t('undo')}</Button>
          </Popconfirm>
        ) : null}
      >
        <Table
          dataSource={logs}
          rowKey="id"
          size="small"
          loading={logsLoading}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          locale={{ emptyText: <Empty description={t('logsEmpty')} /> }}
          columns={[
            { title: t('time'), dataIndex: 'created_at', key: 'created_at', width: 140,
              render: (v: string) => v?.slice(5, 16) || '' },
            { title: t('name'), dataIndex: 'name', key: 'name', width: 90, ellipsis: true },
            { title: t('points'), dataIndex: 'points', key: 'points', width: 70,
              render: (p: number) => (
                <Text strong style={{ color: p > 0 ? '#52c41a' : '#ff4d4f' }}>{p > 0 ? `+${p}` : p}</Text>
              ) },
            { title: t('reason'), dataIndex: 'reason', key: 'reason', ellipsis: true,
              render: (r: string) => reasonLabel(r) },
            { title: t('actions'), key: 'undone', width: 80,
              render: (_: any, rec: any) => (rec.undone ? <Tag>{t('logsUndone')}</Tag> : null) },
          ]}
        />
      </Drawer>

      {/* ── 自定义分值：单人加/扣任意分，或给勾选的多人批量加/扣 ── */}
      <Modal maskClosable={false}
        title={customTarget
          ? t('customPointsFor', { name: customTarget.name })
          : t('customPointsBatch', { count: selectedStudents.length })}
        open={customOpen}
        onOk={submitCustomPoints}
        onCancel={() => setCustomOpen(false)}
        okText={t('save')}
        cancelText={t('cancel')}
      >
        <Space orientation="vertical" style={{ width: '100%' }}>
          <InputNumber
            value={customValue}
            onChange={(v) => setCustomValue(v as number | null)}
            style={{ width: '100%' }}
            placeholder={t('pointsPlaceholder')}
            autoFocus
          />
          <Text type="secondary" style={{ fontSize: 12 }}>{t('pointsHint')}</Text>
          <Input value={customReason} onChange={(e) => setCustomReason(e.target.value)}
            placeholder={t('reasonPlaceholder')} maxLength={60} />
        </Space>
      </Modal>

    </Card>
  )
}

export default ScorePage
