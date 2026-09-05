import React, { useState, useEffect, useCallback } from 'react'
import {
  Card, Select, Table, Button, message, Statistic, Row, Col,
  Space, Typography, Divider, Modal, Input, Radio, Tooltip,
  Spin, Empty, Popconfirm, Tag,
} from 'antd'
import {
  PlusOutlined, MinusOutlined, TrophyOutlined,
  ReloadOutlined, BarChartOutlined, TeamOutlined,
  UserAddOutlined, DeleteOutlined, EditOutlined,
  DownloadOutlined, UserOutlined, StarOutlined,
  HistoryOutlined, RiseOutlined,
} from '@ant-design/icons'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

const { Text } = Typography

interface Student {
  class: string
  name: string
  gender: string
  language: string
  subjects: string
  major: string
  score?: number
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
      }).catch(() => {})
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
      .catch(() => {})
  }, [currentTeacher])

  const [grade, setGrade] = useState<string>('')
  const [classes, setClasses] = useState<string[]>([])
  const [cls, setCls] = useState<string>('')
  const [students, setStudents] = useState<Student[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'scores' | 'ranking' | 'manage'>('scores')

  // 学生管理
  const [editModal, setEditModal] = useState(false)
  const [editStudent, setEditStudent] = useState<Student | null>(null)
  const [editName, setEditName] = useState('')
  const [editClass, setEditClass] = useState('')
  const [editGender, setEditGender] = useState('')

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

  // ── 添加/编辑学生 ──
  const openAddStudent = () => {
    setEditStudent(null)
    setEditName('')
    setEditClass(cls)
    setEditGender('男')
    setEditModal(true)
  }

  const openEditStudent = (s: Student) => {
    setEditStudent(s)
    setEditName(s.name)
    setEditClass(s.class)
    setEditGender(s.gender || '男')
    setEditModal(true)
  }

  const handleSaveStudent = async () => {
    if (!editName.trim() || !editClass.trim()) {
      message.warning(t('requiredFields'))
      return
    }
    try {
      const body: Record<string, string> = {
        grade, name: editName.trim(), class: editClass.trim(),
        gender: editGender, language: '', subjects: '', major: '',
      }
      if (editStudent) {
        body.originalName = editStudent.name
        body.originalClass = editStudent.class
      }
      await apiClient.post('/api/scores/student', { ...body, teacher: currentTeacher })
      message.success(editStudent ? t('saveSuccess') : t('addSuccess'))
      setEditModal(false)
      loadStudents()
    } catch {
      message.error(t('saveFail'))
    }
  }

  // ── 删除学生 ──
  const handleDeleteStudent = async (s: Student) => {
    try {
      await apiClient.delete('/api/scores/student', {
        data: { grade, name: s.name, class: s.class, teacher: currentTeacher },
      })
      message.success(t('deleteSuccess', { name: s.name }))
      loadStudents()
      loadRanking()
    } catch {
      message.error(t('saveFail'))
    }
  }

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
        <Tooltip title={t('edit')}>
          <Button size="small" type="text"
            icon={<EditOutlined />}
            onClick={() => openEditStudent(student)}
          />
        </Tooltip>
      )}
      {isAdminOrTeacher && (
        <Popconfirm
          title={t('deleteStudentConfirm', { name: student.name })}
          onConfirm={() => handleDeleteStudent(student)}
          okText={t('confirm')}
          cancelText={t('cancel')}
        >
          <Tooltip title={t('delete')}>
            <Button size="small" type="text" danger
              icon={<DeleteOutlined />}
            />
          </Tooltip>
        </Popconfirm>
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
    { title: t('name'), dataIndex: 'name', key: 'name', width: 80 },
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
      title: t('actions'), key: 'action', width: 340,
      render: (_: any, record: Student) =>
        isAdminOrTeacher ? <ScoreActions student={record} /> : null,
    },
  ]

  // 排行榜（按综合积分排序）
  const rankingColumns = [
    { title: t('rank'), key: 'rank', width: 60,
      render: (_: any, __: any, idx: number) => {
        const medals = ['🥇', '🥈', '🥉']
        return <span style={{ fontSize: 16 }}>{medals[idx] || `#${idx + 1}`}</span>
      },
    },
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
                <Select value={currentTeacher} onChange={(v) => setCurrentTeacher(v)}
                  style={{ width: 120 }} options={teacherList.map((t) => ({ label: t, value: t }))}
                  placeholder={t('selectTeacher')}
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
                    { title: t('activity'), dataIndex: 'activity_type_name', key: 'activity_type', width: 70 },
                    { title: t('activityName'), dataIndex: 'activity_title', key: 'activity_title', ellipsis: true },
                    { title: t('rewardType'), dataIndex: 'reward_type_name', key: 'reward_type', width: 90,
                      render: (name: string, rec: any) => {
                        const colors: Record<string, string> = { participation: 'default', excellent: 'success', good: 'processing', pass: 'warning' }
                        return <Tag color={colors[rec.reward_type] || 'default'}>{name}</Tag>
                      },
                    },
                    { title: t('points'), dataIndex: 'points', key: 'points', width: 60,
                      render: (p: number) => <Text strong style={{ color: '#52c41a', fontSize: 15 }}>+{p}</Text>,
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

              {isAdminOrTeacher && (
                <Button
                  type={activeTab === 'manage' ? 'primary' : 'default'}
                  icon={<TeamOutlined />}
                  onClick={() => setActiveTab('manage')}
                >{t('studentManage')}</Button>
              )}
            </Space>
          </Col>
          <Col>
            {activeTab === 'scores' && cls && (
              <Space>
                {isAdminOrTeacher && (
                  <Button icon={<UserAddOutlined />} onClick={openAddStudent}>{t('addStudent')}</Button>
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
            {activeTab === 'manage' && cls && isAdminOrTeacher && (
              <Button icon={<UserAddOutlined />} onClick={openAddStudent}>{t('addStudent')}</Button>
            )}
          </Col>
        </Row>

        {/* ── 积分规则提示 ── */}
        {activeTab === 'scores' && (
          <Card size="small" style={{ marginBottom: 12, background: '#fffbe6', fontSize: 13 }}>
            📋 {t('scoreRulesDesc')}：<Tag color="blue">{t('tagParticipation')}</Tag> <Tag color="success">{t('tagExcellent')}</Tag> <Tag color="processing">{t('tagGood')}</Tag> <Tag color="warning">{t('tagPass')}</Tag>
          </Card>
        )}

        {/* ── 积分管理 Tab ── */}
        {activeTab === 'scores' && (
          !cls ? (
            <Empty description={t('selectGradeClass')} />
          ) : (
            <Spin spinning={loading}>
              <Table
                dataSource={students}
                columns={scoreColumns}
                rowKey={(r) => r.name}
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
                rowKey={(r) => r.name}
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

        {/* ── 学生管理 Tab ── */}
        {activeTab === 'manage' && (
          !cls ? (
            <Empty description={t('selectGradeClass')} />
          ) : (
            <Table
              dataSource={students}
              columns={[
                { title: t('name'), dataIndex: 'name', key: 'name', width: 100 },
                { title: t('gender'), dataIndex: 'gender', key: 'gender', width: 60 },
                { title: t('className'), dataIndex: 'class', key: 'class', width: 120 },
                { title: t('language'), dataIndex: 'language', key: 'language', width: 80 },
                { title: t('subjects'), dataIndex: 'subjects', key: 'subjects', width: 120 },
                { title: t('major'), dataIndex: 'major', key: 'major', width: 100 },
                {
                  title: t('actions'), key: 'action', width: 140,
                  render: (_: any, record: Student) => (
                    <Space>
                      <Button size="small" icon={<EditOutlined />}
                        onClick={() => openEditStudent(record)}>{t('edit')}</Button>
                      <Popconfirm
                        title={t('deleteStudentConfirm', { name: record.name })}
                        onConfirm={() => handleDeleteStudent(record)}
                        okText={t('confirm')}
                        cancelText={t('cancel')}
                      >
                        <Button size="small" danger icon={<DeleteOutlined />}>{t('delete')}</Button>
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]}
              rowKey={(r) => r.name}
                pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => t('totalStudents', { count: total }), pageSizeOptions: ['10', '20', '50'] }}
              size="small"
            />
          )
        )}
      </Card>
      )}

      {/* ── 添加/编辑学生弹窗 ── */}
      <Modal
        title={editStudent ? t('editStudent') : t('addStudent')}
        open={editModal}
        onOk={handleSaveStudent}
        onCancel={() => setEditModal(false)}
        okText={t('save')}
        cancelText={t('cancel')}
      >
        <Space orientation="vertical" style={{ width: '100%' }}>
          <div>
            <Text>{t('name')}</Text>
            <Input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder={t('studentName')} />
          </div>
          <div>
            <Text>{t('className')}</Text>
            <Input value={editClass} onChange={(e) => setEditClass(e.target.value)} placeholder={t('className')} />
          </div>
          <div>
            <Text>{t('gender')}</Text>
            <Radio.Group value={editGender} onChange={(e) => setEditGender(e.target.value)}>
              <Radio value="男">{t('male')}</Radio>
              <Radio value="女">{t('female')}</Radio>
            </Radio.Group>
          </div>
        </Space>
      </Modal>
    </Card>
  )
}

export default ScorePage
