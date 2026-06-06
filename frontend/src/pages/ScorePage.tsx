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

  const [grade, setGrade] = useState<string>('')
  const [classes, setClasses] = useState<string[]>([])
  const [cls, setCls] = useState<string>('')
  const [students, setStudents] = useState<Student[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'scores' | 'ranking' | 'manage' | 'rewards'>('scores')

  // ── 学生管理 ──
  const [editModal, setEditModal] = useState(false)
  const [editStudent, setEditStudent] = useState<Student | null>(null)
  const [editName, setEditName] = useState('')
  const [editClass, setEditClass] = useState('')
  const [editGender, setEditGender] = useState('')

  // ── 加载班级列表 ──
  const loadClasses = useCallback(async () => {
    try {
      const { data } = await apiClient.get('/api/scores/classes', { params: { grade, teacher: currentTeacher } })
      setClasses(Array.isArray(data) ? data : [])
    } catch {
      setClasses([])
    }
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
      message.error('加载学生列表失败')
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
  const [rewardRanking, setRewardRanking] = useState<any[]>([])
  const [rewardRankingLoading, setRewardRankingLoading] = useState(false)

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

  // 加载教师端奖励排名
  const loadRewardRanking = useCallback(async () => {
    if (!grade) return
    setRewardRankingLoading(true)
    try {
      const params: Record<string, any> = { grade, teacher: currentTeacher }
      if (cls) params.class_name = cls.replace(/^\d+班$/, m => m.replace('班', ''))
      // 班级名格式转换：如 "高一1班" → class_name="1"
      const clsMatch = cls ? cls.match(/(\d+)班/) : null
      if (clsMatch) params.class_name = clsMatch[1]
      const { data } = await apiClient.get('/api/rewards/ranking', { params })
      setRewardRanking(Array.isArray(data) ? data : [])
    } catch {
      setRewardRanking([])
    } finally {
      setRewardRankingLoading(false)
    }
  }, [grade, cls, currentTeacher])

  useEffect(() => { loadClasses() }, [loadClasses])
  useEffect(() => { loadStudents(); loadStats() }, [loadStudents, loadStats])
  useEffect(() => {
    if (activeTab === 'ranking') loadRanking()
    if (activeTab === 'rewards') loadRewardRanking()
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
      message.success(`${student.name} ${points > 0 ? '+' : ''}${points} 分 (当前 ${data.total} 分)`)
      loadStudents()
      loadStats()
    } catch {
      message.error('操作失败')
    }
  }

  // ── 重置分数 ──
  const handleReset = async (student?: Student) => {
    try {
      if (student) {
        await apiClient.post('/api/scores/reset', {
          grade, class: cls, name: student.name, teacher: currentTeacher,
        })
        message.success(`已重置 ${student.name} 的积分`)
      } else {
        await apiClient.post('/api/scores/reset', { grade, class: cls, teacher: currentTeacher })
        message.success(`已重置 ${cls} 全部积分`)
      }
      loadStudents()
      loadStats()
    } catch {
      message.error('重置失败')
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
      message.warning('姓名和班级为必填项')
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
      message.success(editStudent ? '学生信息已更新' : '学生已添加')
      setEditModal(false)
      loadStudents()
    } catch {
      message.error('保存失败')
    }
  }

  // ── 删除学生 ──
  const handleDeleteStudent = async (s: Student) => {
    try {
      await apiClient.delete('/api/scores/student', {
        data: { grade, name: s.name, class: s.class, teacher: currentTeacher },
      })
      message.success(`已删除 ${s.name}`)
      loadStudents()
      loadRanking()
    } catch {
      message.error('删除失败')
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
        title="确认重置该学生积分？"
        onConfirm={() => handleReset(student)}
        okText="确认"
        cancelText="取消"
      >
        <Tooltip title="重置为 0">
          <Button size="small" danger type="dashed" icon={<ReloadOutlined />} />
        </Tooltip>
      </Popconfirm>
      {isAdminOrTeacher && (
        <Tooltip title="编辑">
          <Button size="small" type="text"
            icon={<EditOutlined />}
            onClick={() => openEditStudent(student)}
          />
        </Tooltip>
      )}
      {isAdminOrTeacher && (
        <Popconfirm
          title={`确认删除 ${student.name}？`}
          onConfirm={() => handleDeleteStudent(student)}
          okText="确认"
          cancelText="取消"
        >
          <Tooltip title="删除">
            <Button size="small" type="text" danger
              icon={<DeleteOutlined />}
            />
          </Tooltip>
        </Popconfirm>
      )}
      {isAdminOrTeacher && (
        <Tooltip title="查看成长档案">
          <Button size="small" type="link"
            icon={<UserOutlined />}
            onClick={async () => {
              try {
                const { data } = await apiClient.get('/api/users', { params: { keyword: student.name } })
                const found = data.users?.find((u: any) => u.name === student.name && u.role === '普通用户')
                if (found) navigate(`/portfolio/${found.username}`)
                else message.warning('未找到对应用户')
              } catch { message.warning('查询失败') }
            }}
          >
            档案
          </Button>
        </Tooltip>
      )}
    </Space>
  )

  // ── 表格列 ──
  const scoreColumns = [
    { title: '姓名', dataIndex: 'name', key: 'name', width: 100 },
    {
      title: '性别', dataIndex: 'gender', key: 'gender', width: 60,
      render: (v: string) => v || '-',
    },
    {
      title: '积分', dataIndex: 'score', key: 'score', width: 80,
      sorter: (a: Student, b: Student) => (b.score || 0) - (a.score || 0),
      render: (score: number) => (
        <Text strong style={{ color: score > 0 ? '#52c41a' : score < 0 ? '#ff4d4f' : undefined }}>
          {score ?? 0}
        </Text>
      ),
    },
    {
      title: '操作', key: 'action', width: 340,
      render: (_: any, record: Student) =>
        isAdminOrTeacher ? <ScoreActions student={record} /> : null,
    },
  ]

  // 班级列仅在年级排行时显示（cls 为空时）
  const rankingColumns = [
    { title: '排名', key: 'rank', width: 60,
      render: (_: any, __: any, idx: number) => {
        const medals = ['🥇', '🥈', '🥉']
        return <span style={{ fontSize: 16 }}>{medals[idx] || `#${idx + 1}`}</span>
      },
    },
    { title: '姓名', dataIndex: 'name', key: 'name', width: 120 },
    ...(!cls ? [{ title: '班级', dataIndex: 'class', key: 'class', width: 100 }] : []),
    {
      title: '积分', dataIndex: 'score', key: 'score', width: 80,
      render: (score: number) => (
        <Text strong style={{ color: '#faad14', fontSize: 16 }}>
          {score ?? 0}
        </Text>
      ),
    },
  ]

  return (
    <div>
      {/* ── 顶栏：年级/班级选择 + 统计 ── */}
      {isStudent ? null : (
      <Card style={{ marginBottom: 16 }}>
        <Row gutter={16} align="middle">
          <Col>
            <Space>
              {isAdmin && teacherList.length > 0 && (
                <Select value={currentTeacher} onChange={(v) => setCurrentTeacher(v)}
                  style={{ width: 120 }} options={teacherList.map((t) => ({ label: t, value: t }))}
                  placeholder="选择教师"
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
                placeholder="选择班级"
                options={classes.map((c) => ({ label: c, value: c }))}
                notFoundContent={<Empty description="暂无班级" />}
              />
              <Tooltip title="刷新">
                <Button icon={<ReloadOutlined />} onClick={() => { loadStudents(); loadStats() }} />
              </Tooltip>
              <Tooltip title="导出 Excel">
                <Button icon={<DownloadOutlined />} onClick={() => {
                  const token = localStorage.getItem('smartkb_token')
                  const url = `/api/export/scores?teacher=${currentTeacher}&grade=${grade}&cls=${cls}`
                  window.open(`${url}&token=${token}`, '_blank')
                }} disabled={!cls} />
              </Tooltip>
            </Space>
          </Col>

          {stats && cls && (
            <>
              <Divider type="vertical" style={{ height: 40 }} />
              <Col>
                <Statistic title="总积分" value={stats.total} prefix={<TrophyOutlined />}
                  valueStyle={{ color: '#faad14' }} />
              </Col>
              <Col>
                <Statistic title="平均分" value={stats.avg} suffix="/ 人" />
              </Col>
              <Col>
                <Statistic title="最高分" value={stats.max_score}
                  suffix={<Text type="secondary">({stats.max_name})</Text>} />
              </Col>
              <Col>
                <Statistic title="人数" value={stats.count} prefix={<TeamOutlined />} />
              </Col>
            </>
          )}
        </Row>
      </Card>
      )}

      {/* ── 学生个人积分 ── */}
      {isStudent && (
        <>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={12}>
              <Card style={{ background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', border: 'none' }}>
                {myScoreLoading ? (
                  <div style={{ textAlign: 'center', padding: 10, color: 'rgba(255,255,255,0.8)' }}>加载中...</div>
                ) : myScore ? (
                  <div>
                    <Row gutter={16} align="middle">
                      <Col>
                        <TrophyOutlined style={{ fontSize: 36, color: '#ffd700' }} />
                      </Col>
                      <Col>
                        <div style={{ fontSize: 13, opacity: 0.8, color: '#fff' }}>{user?.name} · {myScore.class}</div>
                        <div style={{ fontSize: 28, fontWeight: 700, color: '#ffd700' }}>{myScore.score ?? 0} 分</div>
                      </Col>
                    </Row>
                    <div style={{ borderTop: '1px solid rgba(255,255,255,0.2)', marginTop: 10, paddingTop: 8 }}>
                      {myScore.teacher_scores && Object.entries(myScore.teacher_scores).map(([t, sc]) => (
                        <Row key={t} justify="space-between" style={{ padding: '2px 0', fontSize: 13 }}>
                          <span style={{ color: 'rgba(255,255,255,0.8)' }}>{t}</span>
                          <span style={{ color: '#fff', fontWeight: 600 }}>{sc as number} 分</span>
                        </Row>
                      ))}
                    </div>
                    <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginTop: 6 }}>
                      📋 教师评定的课堂积分
                    </div>
                  </div>
                ) : (
                  <div style={{ textAlign: 'center', padding: 10, color: 'rgba(255,255,255,0.8)' }}>
                    暂无积分记录
                  </div>
                )}
              </Card>
            </Col>
            <Col span={12}>
              <Card style={{ background: 'linear-gradient(135deg,#fa8c16,#faad14)', color: '#fff', border: 'none' }}>
                <Spin spinning={rewardLoading}>
                  <Row gutter={16} align="middle">
                    <Col>
                      <StarOutlined style={{ fontSize: 36, color: '#fff' }} />
                    </Col>
                    <Col>
                      <div style={{ fontSize: 13, opacity: 0.8, color: '#fff' }}>活动奖励积分</div>
                      <div style={{ fontSize: 28, fontWeight: 700, color: '#fff' }}>{rewardPoints} 分</div>
                    </Col>
                  </Row>
                  <div style={{ borderTop: '1px solid rgba(255,255,255,0.2)', marginTop: 10, paddingTop: 8 }}>
                    <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.9)' }}>
                      参与活动 {rewardHistory.length} 次 ·
                      获得奖励 {rewardHistory.filter(h => h.reward_type !== 'participation').length} 次
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginTop: 6 }}>
                    🤖 参与活动自动获得的积分
                  </div>
                </Spin>
              </Card>
            </Col>
          </Row>

          {/* 积分奖励明细 */}
          <Card
            size="small"
            title={<Space><StarOutlined style={{ color: '#faad14' }} /> 活动奖励明细</Space>}
            style={{ marginBottom: 16 }}
          >
            <Spin spinning={rewardLoading}>
              {rewardHistory.length === 0 ? (
                <Empty description="暂无活动奖励记录，参与课堂互动自动获得积分" />
              ) : (
                <Table
                  dataSource={rewardHistory}
                  rowKey="id"
                  size="small"
                  pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }}
                  columns={[
                    { title: '时间', dataIndex: 'created_at', key: 'created_at', width: 130,
                      render: (t: string) => t?.slice(0, 16) || '' },
                    { title: '活动', dataIndex: 'activity_type_name', key: 'activity_type', width: 70 },
                    { title: '活动名称', dataIndex: 'activity_title', key: 'activity_title', ellipsis: true },
                    { title: '奖励类型', dataIndex: 'reward_type_name', key: 'reward_type', width: 90,
                      render: (name: string, rec: any) => {
                        const colors: Record<string, string> = { participation: 'default', excellent: 'success', good: 'processing', pass: 'warning' }
                        return <Tag color={colors[rec.reward_type] || 'default'}>{name}</Tag>
                      },
                    },
                    { title: '积分', dataIndex: 'points', key: 'points', width: 60,
                      render: (p: number) => <Text strong style={{ color: '#52c41a', fontSize: 15 }}>+{p}</Text>,
                    },
                    { title: '说明', dataIndex: 'reason', key: 'reason', ellipsis: true },
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
              >积分管理</Button>
              <Button
                type={activeTab === 'ranking' ? 'primary' : 'default'}
                icon={<BarChartOutlined />}
                onClick={() => setActiveTab('ranking')}
              >排行榜</Button>
              <Button
                type={activeTab === 'rewards' ? 'primary' : 'default'}
                icon={<StarOutlined />}
                onClick={() => setActiveTab('rewards' as any)}
              >活动奖励</Button>
              {isAdminOrTeacher && (
                <Button
                  type={activeTab === 'manage' ? 'primary' : 'default'}
                  icon={<TeamOutlined />}
                  onClick={() => setActiveTab('manage')}
                >学生管理</Button>
              )}
            </Space>
          </Col>
          <Col>
            {activeTab === 'scores' && cls && (
              <Space>
                {isAdminOrTeacher && (
                  <Button icon={<UserAddOutlined />} onClick={openAddStudent}>添加学生</Button>
                )}
                <Popconfirm
                  title={`确认重置 ${cls} 全部积分？此操作不可撤销！`}
                  onConfirm={() => handleReset()}
                  okText="确认重置"
                  cancelText="取消"
                >
                  <Button danger icon={<ReloadOutlined />}>重置全部</Button>
                </Popconfirm>
              </Space>
            )}
            {activeTab === 'manage' && cls && isAdminOrTeacher && (
              <Button icon={<UserAddOutlined />} onClick={openAddStudent}>添加学生</Button>
            )}
          </Col>
        </Row>

        {/* ── 积分管理 Tab ── */}
        {activeTab === 'scores' && (
          !cls ? (
            <Empty description="请先选择年级和班级" />
          ) : (
            <Spin spinning={loading}>
              <Table
                dataSource={students}
                columns={scoreColumns}
                rowKey={(r) => r.name}
                pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 名学生`, pageSizeOptions: ['10', '20', '50'] }}
                size="small"
                locale={{ emptyText: <Empty description="暂无学生数据" /> }}
              />
            </Spin>
          )
        )}

        {/* ── 排行榜 Tab ── */}
        {activeTab === 'ranking' && (
          <Spin spinning={rankingLoading}>
            {ranking.length === 0 ? (
              <Empty description={cls ? "暂无排行数据" : "请选择年级查看排行（可选班级筛选）"} />
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

        {/* ── 活动奖励 Tab ── */}
        {activeTab === 'rewards' && (
          <Spin spinning={rewardRankingLoading}>
            {!grade ? (
              <Empty description="请先选择年级" />
            ) : (
              <div>
                <Card size="small" style={{ marginBottom: 16, background: '#fffbe6' }}>
                  <Space direction="vertical" size={2}>
                    <Text type="secondary">📋 积分规则：</Text>
                    <Text style={{ fontSize: 13 }}>• 参与活动 <Tag color="blue">+2 分</Tag> 基础参与分</Text>
                    <Text style={{ fontSize: 13 }}>• 优秀(≥90%) <Tag color="success">+15 分</Tag> · 良好(≥75%) <Tag color="processing">+10 分</Tag> · 及格(≥60%) <Tag color="warning">+5 分</Tag></Text>
                  </Space>
                </Card>
                {rewardRanking.length === 0 ? (
                  <Empty description="暂无活动奖励数据" />
                ) : (
                  <Table
                    dataSource={rewardRanking}
                    rowKey="username"
                    size="small"
                    pagination={{ pageSize: 30, showTotal: (t) => `共 ${t} 名学生` }}
                    columns={[
                      { title: '排名', dataIndex: 'rank', key: 'rank', width: 60,
                        render: (rank: number) => {
                          if (rank === 1) return <Tag color="gold">🥇 1</Tag>
                          if (rank === 2) return <Tag color="silver">🥈 2</Tag>
                          if (rank === 3) return <Tag color="bronze">🥉 3</Tag>
                          return <Text type="secondary">{rank}</Text>
                        },
                      },
                      { title: '姓名', dataIndex: 'name', key: 'name', width: 100 },
                      { title: '用户名', dataIndex: 'username', key: 'username', width: 100 },
                      {
                        title: '奖励积分', dataIndex: 'total_points', key: 'total_points', width: 100,
                        render: (p: number) => <Text strong style={{ color: '#fa8c16', fontSize: 16 }}>{p}</Text>,
                        sorter: (a: any, b: any) => a.total_points - b.total_points,
                        defaultSortOrder: 'descend' as const,
                      },
                      {
                        title: '等级', key: 'level', width: 80,
                        render: (_: any, record: any) => {
                          const p = record.total_points
                          if (p >= 200) return <Tag color="red">⭐ 学神</Tag>
                          if (p >= 100) return <Tag color="orange">🌟 学霸</Tag>
                          if (p >= 50) return <Tag color="blue">📈 进阶</Tag>
                          if (p >= 20) return <Tag color="green">🌱 新秀</Tag>
                          return <Tag>⚡ 起步</Tag>
                        },
                      },
                    ]}
                  />
                )}
              </div>
            )}
          </Spin>
        )}

        {/* ── 学生管理 Tab ── */}
        {activeTab === 'manage' && (
          !cls ? (
            <Empty description="请先选择年级和班级" />
          ) : (
            <Table
              dataSource={students}
              columns={[
                { title: '姓名', dataIndex: 'name', key: 'name', width: 100 },
                { title: '性别', dataIndex: 'gender', key: 'gender', width: 60 },
                { title: '班级', dataIndex: 'class', key: 'class', width: 120 },
                { title: '语言', dataIndex: 'language', key: 'language', width: 80 },
                { title: '科目', dataIndex: 'subjects', key: 'subjects', width: 120 },
                { title: '专业', dataIndex: 'major', key: 'major', width: 100 },
                {
                  title: '操作', key: 'action', width: 140,
                  render: (_: any, record: Student) => (
                    <Space>
                      <Button size="small" icon={<EditOutlined />}
                        onClick={() => openEditStudent(record)}>编辑</Button>
                      <Popconfirm
                        title={`确认删除 ${record.name}？`}
                        onConfirm={() => handleDeleteStudent(record)}
                        okText="确认"
                        cancelText="取消"
                      >
                        <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]}
              rowKey={(r) => r.name}
              pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 名学生`, pageSizeOptions: ['10', '20', '50'] }}
              size="small"
            />
          )
        )}
      </Card>
      )}

      {/* ── 添加/编辑学生弹窗 ── */}
      <Modal
        title={editStudent ? '编辑学生' : '添加学生'}
        open={editModal}
        onOk={handleSaveStudent}
        onCancel={() => setEditModal(false)}
        okText="保存"
        cancelText="取消"
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <div>
            <Text>姓名</Text>
            <Input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="学生姓名" />
          </div>
          <div>
            <Text>班级</Text>
            <Input value={editClass} onChange={(e) => setEditClass(e.target.value)} placeholder="班级" />
          </div>
          <div>
            <Text>性别</Text>
            <Radio.Group value={editGender} onChange={(e) => setEditGender(e.target.value)}>
              <Radio value="男">男</Radio>
              <Radio value="女">女</Radio>
            </Radio.Group>
          </div>
        </Space>
      </Modal>
    </div>
  )
}

export default ScorePage
