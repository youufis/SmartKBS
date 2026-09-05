import React, { useState, useEffect, useRef } from 'react'
import {
  Card, Row, Col, Typography, Spin, Select, Button, Space, message,
  Empty, Tabs, Statistic, Table, Tag, Tooltip,
} from 'antd'
import {
  RobotOutlined, BarChartOutlined,
  TeamOutlined, ThunderboltOutlined, BookOutlined,
  CheckCircleOutlined, ClockCircleOutlined, StopOutlined, ReloadOutlined, DownloadOutlined,
  BulbOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'
import { pollAiTask } from '../api/aiTask'
import { useTranslation } from 'react-i18next'
import LearningProgress from '../components/LearningProgress'

const { Title, Text } = Typography

interface QuestionAccuracy {
  id: number
  type: string
  text: string
  correct_rate: number
  difficulty: string
  knowledge_points: string
}

interface ExamAnalytics {
  exam: { id: number; title: string; subject: string }
  statistics: {
    total_students: number
    avg_score: number
    max_score: number
    min_score: number
    pass_count: number
    pass_rate: number
    total_score: number
  }
  question_accuracy: QuestionAccuracy[]
  report: string
}

interface ClassOverviewData {
  total_students: number
  score_total: number
  score_avg: number
  rollcall_correct: number
  rollcall_total: number
  active_tasks: number
  submitted_students: number
  [key: string]: unknown
}

interface ExamItem {
  id: number
  title: string
  subject: string
  [key: string]: unknown
}

interface CourseItem {
  id: number
  name: string
  [key: string]: unknown
}

interface ProgressStudent {
  username: string
  name: string
  grade: string
  class: string
  courses?: {
    course_id: number
    completed_kps: number
    total_kps: number
    rate: number
    details?: {
      kp_id: number
      kp_name: string
      status: string
    }[]
  }[]
  [key: string]: unknown
}

const AnalyticsPage: React.FC = () => {
  const { t } = useTranslation('dashboard')
  const user = useAuthStore((s) => s.user)
  const isStudent = user?.role === 'student'

  const [activeTab, setActiveTab] = useState('class')
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState('')
  const [rawData, setRawData] = useState<ClassOverviewData | null>(null)

  // 班级分析参数
  const [grade, setGrade] = useState('')
  const [cls, setCls] = useState('')
  const [classes, setClasses] = useState<string[]>([])
  const [allowedGrades, setAllowedGrades] = useState<string[]>([])

  // 考试列表
  const [exams, setExams] = useState<ExamItem[]>([])
  const [selectedExam, setSelectedExam] = useState<number | null>(null)
  const [examAnalytics, setExamAnalytics] = useState<ExamAnalytics | null>(null)
  const [examLoading, setExamLoading] = useState(false)

  // 学情进度
  const [courses, setCourses] = useState<CourseItem[]>([])
  const [courseId, setCourseId] = useState<number | undefined>()
  const [progressGrade, setProgressGrade] = useState<string | undefined>()
  const [progressClass, setProgressClass] = useState<string | undefined>()
  const [progressStudents, setProgressStudents] = useState<ProgressStudent[]>([])
  const [progressLoading, setProgressLoading] = useState(false)
  const [progressStats, setProgressStats] = useState({ totalStudents: 0, avgRate: 0 })
  const [classOptions, setClassOptions] = useState<string[]>([])
  const [gradeOptions, setGradeOptions] = useState<string[]>([])
  const [expandedRowKeys, setExpandedRowKeys] = useState<React.Key[]>([])
  // G1: 总览改服务端分页, 知识点明细改按需拉取
  const [progressPage, setProgressPage] = useState(1)
  const [progressTotal, setProgressTotal] = useState(0)
  const [progressDetails, setProgressDetails] = useState<Record<string, any[]>>({})

  // 加载教师可见年级（学情分析用）
  useEffect(() => {
    apiClient.get('/api/scores/my-grades', { params: { teacher: user?.username } })
      .then(({ data }) => {
        if (Array.isArray(data) && data.length > 0) {
          setAllowedGrades(data)
          if (!data.includes(grade)) setGrade(data[0])
        }
      })
      .catch(() => {})
  }, [user?.username, grade])

  // 加载班级列表
  useEffect(() => {
    if (grade) {
      apiClient.get('/api/scores/classes', { params: { grade, teacher: user?.username } })
        .then(({ data }) => {
          if (Array.isArray(data)) setClasses(data)
        })
        .catch(() => {})
    }
  }, [grade, user?.username])

  // 加载考试列表
  useEffect(() => {
    apiClient.get('/api/exams', { params: { page_size: 50 } })
      .then(({ data }) => {
        if (data?.exams) setExams(data.exams)
        else if (Array.isArray(data)) setExams(data)
      })
      .catch(() => {})
  }, [])

  // 加载学情进度数据
  useEffect(() => {
    apiClient.get('/api/curriculum/courses', { params: { status: 'active' } })
      .then(({ data }) => {
        const list = data.courses || []
        setCourses(list)
        if (list.length > 0) setCourseId(list[0].id)
      })
      .catch(() => {})
  }, [])

  // 加载学情进度下拉选项（教师只能看到自己的年级和班级）
  useEffect(() => {
    apiClient.get('/api/scores/my-grades', { params: { teacher: user?.username } })
      .then(({ data }) => {
        const grades = Array.isArray(data) ? (data as string[]) : []
        setGradeOptions(grades)
        if (grades.length > 0 && !grades.includes(progressGrade ?? '')) {
          setProgressGrade(undefined)
        }
      })
      .catch(() => {})
  }, [user?.username, progressGrade])

  // 当进度年级变化时，加载对应班级
  const prevProgressGrade = useRef(progressGrade)
  useEffect(() => {
    if (progressGrade) {
      prevProgressGrade.current = progressGrade
      apiClient.get('/api/scores/classes', { params: { grade: progressGrade, teacher: user?.username } })
        .then(({ data }) => {
          const clsList = Array.isArray(data) ? (data as string[]) : []
          setClassOptions(clsList)
        })
        .catch(() => setClassOptions([]))
    } else if (prevProgressGrade.current !== undefined) {
      prevProgressGrade.current = undefined
      setClassOptions([])
    }
  }, [progressGrade, user?.username])

  // 加载进度（服务端分页：一次只取一页学生，明细另行懒加载）
  const loadProgress = async (page = 1) => {
    setProgressLoading(true)
    try {
      const params: Record<string, unknown> = { course_id: courseId, page, page_size: 50 }
      if (progressGrade) params.grade = progressGrade
      // class_name 只需班级数字（从 "高一1班" 中提取 "1"）
      if (progressClass) {
        const match = progressClass.match(/(\d+)/)
        params.class_name = match ? match[1] : progressClass
      }
      const { data } = await apiClient.get('/api/curriculum/progress/overview', { params })
      const rows: ProgressStudent[] = data.students || []
      setProgressPage(page)
      setProgressTotal(data.total || rows.length)
      setProgressStudents(rows)
      setProgressDetails({})
      setExpandedRowKeys(rows.length > 0 ? [rows[0].username] : [])
      const stats = data.stats || {}
      setProgressStats({
        totalStudents: stats.total_students ?? data.total ?? 0,
        avgRate: stats.avg_rate ?? 0,
      })
    } catch { /* ignore */ }
    setProgressLoading(false)
  }

  // 展开某一行时才拉取该学生的知识点掌握明细
  useEffect(() => {
    (expandedRowKeys as React.Key[]).forEach((k) => {
      const uname = String(k || '')
      if (!uname || progressDetails[uname]) return
      apiClient
        .get(`/api/curriculum/progress/student/${encodeURIComponent(uname)}`, {
          params: courseId ? { course_id: courseId } : {},
        })
        .then(({ data }) => setProgressDetails((prev) => ({ ...prev, [uname]: data?.courses || [] })))
        .catch(() => setProgressDetails((prev) => ({ ...prev, [uname]: [] })))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedRowKeys, courseId])

  // 班级学情分析
  const handleClassAnalysis = async () => {
    if (!cls) return
    setLoading(true)
    setReport('')
    try {
      const { data } = await apiClient.get('/api/analytics/class-overview', {
        params: { grade, cls, teacher: user?.username },
      })
      if (data.task_id) {
        const result = await pollAiTask(data.task_id)
        if (result) {
          setReport(result.result || t('analytics.noResult'))
          setRawData(data.data)
        } else {
          setReport(t('analytics.aiTimeout'))
        }
      } else {
        setReport(data.report || t('analytics.noResult'))
        setRawData(data.data)
      }
    } catch {
      setReport(t('analytics.analysisFailed'))
    }
    setLoading(false)
  }

  // ── AI 教学建议 ──
  const [suggestionsLoading, setSuggestionsLoading] = useState(false)
  const [suggestionsData, setSuggestionsData] = useState<{ suggestions: string; data?: any } | null>(null)
  const handleTeachingSuggestions = async () => {
    if (!cls) return
    setSuggestionsLoading(true)
    setSuggestionsData(null)
    try {
      const { data } = await apiClient.get('/api/analytics/teaching-suggestions', {
        params: { grade, cls, teacher_username: user?.username },
      })
      if (data.task_id) {
        const result = await pollAiTask(data.task_id)
        if (result) {
          setSuggestionsData({ suggestions: result.result || '', data: data.data })
        } else {
        }
      } else {
        setSuggestionsData(data)
      }
    } catch {
    }
    setSuggestionsLoading(false)
  }

  // 考试分析
  const handleExamAnalysis = async () => {
    if (!selectedExam) return
    setExamLoading(true)
    setExamAnalytics(null)
    try {
      const { data } = await apiClient.get(`/api/analytics/exam/${selectedExam}/report`)
      if (data.task_id) {
        const result = await pollAiTask(data.task_id)
        if (result) {
          setExamAnalytics({ ...(data as any), report: result.result || '' })
        } else {
          setReport(t('analytics.examAiTimeout'))
        }
      } else {
        setExamAnalytics(data)
      }
    } catch {
      setReport(t('analytics.examAnalysisFailed'))
    }
    setExamLoading(false)
  }

  // ── 导出功能 ──
  const exportReportAsMarkdown = () => {
    if (!report) return
    const blob = new Blob([report], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = t('analytics.reportFilename', { grade, cls })
    a.click()
    URL.revokeObjectURL(url)
  }

  const exportExamExcel = () => {
    if (!selectedExam) return
    window.open(`/api/export/exam/${selectedExam}`, '_blank')
  }

  const exportProgressExcel = () => {
    const params = new URLSearchParams()
    if (courseId) params.set('course_id', String(courseId))
    if (progressGrade) params.set('grade', progressGrade)
    if (progressClass) {
      const m = progressClass.match(/(\d+)/)
      params.set('class_name', m ? m[1] : progressClass)
    }
    const qs = params.toString()
    window.open(`/api/export/progress${qs ? `?${qs}` : ''}`, '_blank')
  }

  const typeLabel: Record<string, string> = {
    single: t('analytics.questionType.single'), multiple: t('analytics.questionType.multiple'), true_false: t('analytics.questionType.trueFalse'), short: t('analytics.questionType.short'), fill: t('analytics.questionType.fill'), essay: t('analytics.questionType.essay'), subjective: t('analytics.questionType.subjective'),
  }
  const diffColor: Record<string, string> = {
    easy: 'green', medium: 'orange', hard: 'red',
  }

  if (isStudent) {
    return (
      <Card>
        <Empty description={t('analytics.studentRestricted')} />
      </Card>
    )
  }

  return (
    <Card style={{ borderRadius: 8 }}>
      <Card style={{ marginBottom: 16, background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', border: 'none' }}>
        <div style={{ color: '#fff', display: 'flex', alignItems: 'center', gap: 12 }}>
          <RobotOutlined style={{ fontSize: 28 }} />
          <Title level={3} style={{ color: '#fff', margin: 0 }}>{t('analytics.title')}</Title>
          <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 14, marginTop: 4 }}>
            {t('analytics.description')}
          </Text>
        </div>
      </Card>

      <Card>
        <Tabs activeKey={activeTab} onChange={setActiveTab}
          items={[
            {
              key: 'class',
              label: <span><TeamOutlined /> {t('analytics.tabs.class')}</span>,
              children: (
                <div>
                  <Space style={{ marginBottom: 16 }}>
                    <Select value={grade} onChange={(v) => { setGrade(v); setCls('') }}
                      style={{ width: 100 }} options={allowedGrades.map((g) => ({ label: g, value: g }))} />
                    <Select value={cls} onChange={setCls} style={{ width: 160 }}
                      placeholder={t('analytics.selectClass')}
                      options={classes.map((c) => ({ label: c, value: c }))} />
                    <Button type="primary" icon={<RobotOutlined />} onClick={handleClassAnalysis}
                      loading={loading} disabled={!cls}>
                      {t('analytics.aiAnalyze')}
                    </Button>
                    <Button icon={<BulbOutlined />} onClick={handleTeachingSuggestions}
                      loading={suggestionsLoading} disabled={!cls}>
                      {t('analytics.aiSuggestions')}
                    </Button>
                  </Space>

                  {loading && (
                    <div style={{ textAlign: 'center', padding: 40 }}>
                      <Spin size="large" description={t('analytics.aiAnalyzing')} />
                    </div>
                  )}

                  {rawData && !loading && (
                    <Row gutter={16} style={{ marginBottom: 16 }}>
                      <Col span={4}><Statistic title={t('analytics.stats.studentCount')} value={rawData.total_students} prefix={<TeamOutlined />} /></Col>
                      <Col span={4}><Statistic title={t('analytics.stats.totalScore')} value={rawData.score_total} prefix={<ThunderboltOutlined />} /></Col>
                      <Col span={4}><Statistic title={t('analytics.stats.avgScore')} value={rawData.score_avg} /></Col>
                      <Col span={4}>
                        <Statistic title={t('analytics.stats.rollcallCorrect')} value={rawData.rollcall_correct}
                          suffix={`/ ${rawData.rollcall_total}`}
                          styles={{ content: { color: rawData.rollcall_total > 0 ? '#52c41a' : '#999' } }} />
                      </Col>
                      <Col span={4}><Statistic title={t('analytics.stats.activeTasks')} value={rawData.active_tasks} /></Col>
                      <Col span={4}><Statistic title={t('analytics.stats.submittedStudents')} value={rawData.submitted_students} /></Col>
                    </Row>
                  )}

                  {report && !loading && (
                    <>
                      <Space style={{ marginBottom: 12, justifyContent: 'space-between', width: '100%' }}>
                        <span />
                        <Space>
                          <Button icon={<DownloadOutlined />} onClick={() => {
                            if (!cls) return
                            window.open(`/api/analytics/class-overview/export?${new URLSearchParams({ grade, cls, teacher: user?.username || '' }).toString()}`, '_blank')
                          }}>{t('analytics.exportWord')}</Button>
                          <Button icon={<DownloadOutlined />} onClick={exportReportAsMarkdown}>{t('analytics.exportMarkdown')}</Button>
                        </Space>
                      </Space>
                      <Card style={{ background: '#f6f8ff', border: '1px solid #d6e4ff' }}>
                        <div className="markdown-report">
                          <ReactMarkdown>{report}</ReactMarkdown>
                        </div>
                      </Card>
                    </>
                  )}

                  {/* AI 教学建议 */}
                  {suggestionsData && !suggestionsLoading && (
                    <div style={{ marginTop: 16 }}>
                      <Typography.Title level={5}><BulbOutlined style={{ color: '#faad14' }} /> {t('analytics.suggestionsTitle')}</Typography.Title>
                      {suggestionsData.data && (
                        <Row gutter={16} style={{ marginBottom: 12 }}>
                          <Col span={6}><Statistic title={t('analytics.stats.studentCount')} value={suggestionsData.data.total_students} /></Col>
                          <Col span={6}><Statistic title={t('analytics.stats.avgScore')} value={suggestionsData.data.score_avg} /></Col>
                          <Col span={6}><Statistic title={t('analytics.stats.rollcallRate')} value={suggestionsData.data.rollcall_rate} suffix="%" /></Col>
                          <Col span={6}><Statistic title={t('analytics.stats.taskRate')} value={suggestionsData.data.task_rate} suffix="%" /></Col>
                        </Row>
                      )}
                      <Space style={{ marginBottom: 12, justifyContent: 'flex-end', width: '100%' }}>
                        <Button icon={<DownloadOutlined />} onClick={() => {
                          if (!cls) return
                          window.open(`/api/analytics/teaching-suggestions/export?${new URLSearchParams({ grade, cls, teacher_username: user?.username || '' }).toString()}`, '_blank')
                        }}>{t('analytics.exportWord')}</Button>
                      </Space>
                      <Card style={{ background: '#fffbe6', border: '1px solid #ffe58f' }}>
                        <div className="markdown-report">
                          <ReactMarkdown>{suggestionsData.suggestions}</ReactMarkdown>
                        </div>
                      </Card>
                    </div>
                  )}
                </div>
              ),
            },
            {
              key: 'exam',
              label: <span><BarChartOutlined /> {t('analytics.tabs.exam')}</span>,
              children: (
                <div>
                  <Space style={{ marginBottom: 16 }}>
                    <Select value={selectedExam} onChange={setSelectedExam} style={{ width: 300 }}
                      placeholder={t('analytics.selectExam')}
                      options={exams.map((e) => ({ label: `${e.title} (${e.subject})`, value: e.id }))} />
                    <Button type="primary" icon={<RobotOutlined />} onClick={handleExamAnalysis}
                      loading={examLoading} disabled={!selectedExam}>
                      {t('analytics.aiAnalyze')}
                    </Button>
                  </Space>

                  {examLoading && (
                    <div style={{ textAlign: 'center', padding: 40 }}>
                      <Spin size="large" description={t('analytics.aiAnalyzing')} />
                    </div>
                  )}

                  {examAnalytics && (
                    <>
                      <Row gutter={16} style={{ marginBottom: 16 }}>
                        <Col span={4}><Statistic title={t('analytics.stats.examParticipants')} value={examAnalytics.statistics.total_students} /></Col>
                        <Col span={4}><Statistic title={t('analytics.stats.examAvgScore')} value={examAnalytics.statistics.avg_score} precision={1} /></Col>
                        <Col span={4}><Statistic title={t('analytics.stats.examMaxScore')} value={examAnalytics.statistics.max_score} /></Col>
                        <Col span={4}><Statistic title={t('analytics.stats.examMinScore')} value={examAnalytics.statistics.min_score} /></Col>
                        <Col span={4}><Statistic title={t('analytics.stats.examPassRate')} value={examAnalytics.statistics.pass_rate} suffix="%" precision={1} /></Col>
                      </Row>

                      <Table
                        dataSource={examAnalytics.question_accuracy}
                        rowKey="id"
                        size="small"
                        pagination={false}
                        style={{ marginBottom: 16 }}
                        columns={[
                          { title: t('analytics.columns.questionType'), dataIndex: 'type', width: 70, render: (typeVal: string) => typeLabel[typeVal] || typeVal },
                          { title: t('analytics.columns.question'), dataIndex: 'text', ellipsis: true },
                          {
                            title: t('analytics.columns.difficulty'), dataIndex: 'difficulty', width: 70,
                            render: (d: string) => <Tag color={diffColor[d] || 'default'}>{d === 'easy' ? t('analytics.difficulty.easy') : d === 'medium' ? t('analytics.difficulty.medium') : t('analytics.difficulty.hard')}</Tag>,
                          },
                          {
                            title: t('analytics.columns.accuracy'), dataIndex: 'correct_rate', width: 90,
                            render: (r: number) => (
                              <Text strong style={{ color: r >= 60 ? '#52c41a' : '#ff4d4f' }}>{r}%</Text>
                            ),
                          },
                          { title: t('analytics.columns.knowledgePoints'), dataIndex: 'knowledge_points', width: 150, ellipsis: true },
                        ]}
                      />

                      <Space style={{ marginBottom: 12, justifyContent: 'space-between', width: '100%' }}>
                        <span />
                        <Space>
                          <Button icon={<DownloadOutlined />} onClick={() => {
                            if (!selectedExam) return
                            window.open(`/api/analytics/exam/${selectedExam}/report/export`, '_blank')
                          }}>{t('analytics.exportWord')}</Button>
                          <Button icon={<DownloadOutlined />} onClick={exportExamExcel}>{t('analytics.exportExcel')}</Button>
                        </Space>
                      </Space>
                      <Card style={{ background: '#f6f8ff', border: '1px solid #d6e4ff' }}>
                        <div className="markdown-report">
                          <ReactMarkdown>{examAnalytics.report}</ReactMarkdown>
                        </div>
                      </Card>
                    </>
                  )}
                </div>
              ),
            },
            {
              key: 'progress',
              label: <span><BookOutlined /> {t('analytics.tabs.progress')}</span>,
              children: (
                <div>
                  <Row gutter={16} style={{ marginBottom: 16 }}>
                    <Col span={6}><Statistic title={t('analytics.stats.filteredStudents')} value={progressStats.totalStudents} prefix={<TeamOutlined />} /></Col>
                    <Col span={6}>
                      <Statistic title={t('analytics.stats.avgCompletionRate')} value={progressStats.avgRate} suffix="%"
                        precision={1} styles={{ content: { color: progressStats.avgRate >= 60 ? '#52c41a' : '#faad14' } }} />
                    </Col>
                  </Row>

                  <Space wrap style={{ marginBottom: 16 }}>
                    <Select
                      value={courseId} onChange={setCourseId} style={{ width: 160 }}
                      placeholder={t('analytics.selectCourse')} allowClear
                      options={courses.map((c) => ({ label: c.name, value: c.id }))} />
                    <Select
                      value={progressGrade} onChange={setProgressGrade} style={{ width: 120 }}
                      placeholder={t('analytics.allGrades')} allowClear
                      options={gradeOptions.map(g => ({ label: g, value: g }))} />
                    <Select
                      value={progressClass} onChange={setProgressClass} style={{ width: 120 }}
                      placeholder={t('analytics.allClasses')} allowClear
                      options={classOptions.map(c => ({ label: c, value: c }))} />
                    <Button type="primary" icon={<ReloadOutlined />} onClick={() => void loadProgress(1)} loading={progressLoading}>{t('analytics.query')}</Button>
                    <Button icon={<DownloadOutlined />} onClick={exportProgressExcel}
                      disabled={progressStudents.length === 0}>{t('analytics.exportExcel')}</Button>
                  </Space>

                  <Space style={{ marginBottom: 12 }}>
                    <Tag icon={<CheckCircleOutlined />} color="success">{t('analytics.status.completed')}</Tag>
                    <Tag icon={<ClockCircleOutlined />} color="processing">{t('analytics.status.learning')}</Tag>
                    <Tag icon={<StopOutlined />} color="default">{t('analytics.status.notStarted')}</Tag>
                  </Space>

                  {!progressLoading && progressStudents.length === 0 ? (
                    <Empty description={t('analytics.emptyProgress')} />
                  ) : (
                  <Table
                    dataSource={progressStudents}
                    rowKey="username"
                    loading={progressLoading}
                    pagination={{
                      current: progressPage,
                      pageSize: 50,
                      total: progressTotal,
                      showSizeChanger: false,
                      showTotal: (total) => t('analytics.totalStudentsFormat', { count: total }),
                      onChange: (p: number) => void loadProgress(p),
                    }}
                    expandable={{
                      expandedRowRender: (record: ProgressStudent) => {
                        const stuCourses = progressDetails[record.username] || record.courses || []
                        const detail = stuCourses.find((c: any) => c.course_id === courseId) || stuCourses[0]
                        const details = (detail?.details || []) as { kp_id: number; kp_name: string; status: string }[]
                        if (!details.length) return <Text type="secondary">{t('analytics.noKnowledgePoints')}</Text>
                        return (
                          <Space wrap>
                            {details.map((d) => (
                              <Tooltip key={d.kp_id} title={d.kp_name}>
                                <Tag color={d.status === 'completed' ? 'success' : d.status === 'in_progress' ? 'processing' : 'default'}
                                  style={{ fontSize: 12, cursor: 'pointer', maxWidth: 160 }}>
                                  <Text ellipsis style={{ maxWidth: 120, display: 'inline-block' }}>{d.kp_name}</Text>
                                </Tag>
                              </Tooltip>
                            ))}
                          </Space>
                        )
                      },
                      expandedRowKeys,
                      onExpandedRowsChange: (keys: readonly React.Key[]) => setExpandedRowKeys([...keys]),
                      rowExpandable: () => true,
                    }}
                    scroll={{ x: 600 }}
                    size="middle"
                    columns={[
                      {
                        title: t('analytics.columns.name'), dataIndex: 'name', key: 'name', width: 100,
                        render: (name: string) => <Text strong><TeamOutlined /> {name}</Text>,
                      },
                      { title: t('analytics.columns.grade'), dataIndex: 'grade', width: 70 },
                      { title: t('analytics.columns.class'), dataIndex: 'class', width: 70 },
                      {
                        title: t('analytics.columns.completionRate'), key: 'courses', width: 200,
                        render: (_: unknown, record: ProgressStudent) => {
                          const cd = (record.courses || []).find((c) => c.course_id === courseId) || (record.courses || [])[0]
                          if (!cd) return <Text type="secondary">—</Text>
                          const { completed_kps, total_kps, rate } = cd
                          return (
                            <Tooltip title={t('analytics.tooltipFormat', { completed: completed_kps, total: total_kps, rate })}>
                              <Space>
                                <div style={{ width: 120, height: 20, background: '#f0f0f0', borderRadius: 10, overflow: 'hidden' }}>
                                  <div style={{ width: `${rate}%`, height: '100%', background: rate >= 80 ? '#52c41a' : rate >= 40 ? '#faad14' : '#ff4d4f', borderRadius: 10, transition: 'width 0.3s' }} />
                                </div>
                                <Text style={{ fontSize: 12, minWidth: 40 }}>{rate}%</Text>
                              </Space>
                            </Tooltip>
                          )
                        },
                      },
                    ]}
                  />
                  )}
                </div>
              ),
            },
            {
              key: 'overall',
              label: <span><BarChartOutlined /> {t('analytics.tabs.progressDetail')}</span>,
              children: <LearningProgress />,
            },
          ]}
        />
      </Card>
    </Card>
  )
}

export default AnalyticsPage
