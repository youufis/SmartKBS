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

  // 加载进度
  const loadProgress = async () => {
    setProgressLoading(true)
    try {
      const params: Record<string, unknown> = { course_id: courseId }
      if (progressGrade) params.grade = progressGrade
      // class_name 只需班级数字（从 "高一1班" 中提取 "1"）
      if (progressClass) {
        const match = progressClass.match(/(\d+)/)
        params.class_name = match ? match[1] : progressClass
      }
      const { data } = await apiClient.get('/api/curriculum/progress/overview', { params })
      setProgressStudents(data.students || [])
      if (data.students?.length > 0) setExpandedRowKeys([data.students[0].username])
      const total = data.students?.length || 0
      let totalRate = 0
      if (total > 0) {
        for (const stu of data.students) {
          for (const c of stu.courses || []) totalRate += c.rate
        }
        totalRate = totalRate / total
      }
      setProgressStats({ totalStudents: total, avgRate: totalRate })
    } catch { /* ignore */ }
    setProgressLoading(false)
  }

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
          setReport(result.result || '暂无分析结果')
          setRawData(data.data)
        } else {
          setReport('❌ AI 分析超时，请稍后重试')
        }
      } else {
        setReport(data.report || '暂无分析结果')
        setRawData(data.data)
      }
    } catch {
      setReport('❌ 分析失败，请稍后重试')
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
          message.error('AI 分析超时')
        }
      } else {
        setSuggestionsData(data)
      }
    } catch {
      message.error('获取教学建议失败')
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
          setReport('❌ AI 分析超时')
        }
      } else {
        setExamAnalytics(data)
      }
    } catch {
      setReport('❌ 分析失败')
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
    a.download = `学情报告_${grade}_${cls}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  const exportExamExcel = () => {
    if (!selectedExam) return
    const token = localStorage.getItem('smartkb_token')
    window.open(`/api/export/exam/${selectedExam}?token=${token}`, '_blank')
  }

  const exportProgressExcel = () => {
    const token = localStorage.getItem('smartkb_token')
    let url = `/api/export/progress?token=${token}`
    if (courseId) url += `&course_id=${courseId}`
    if (progressGrade) url += `&grade=${progressGrade}`
    if (progressClass) {
      const match = progressClass.match(/(\d+)/)
      url += `&class_name=${match ? match[1] : progressClass}`
    }
    window.open(url, '_blank')
  }

  const typeLabel: Record<string, string> = {
    single: '单选', multiple: '多选', true_false: '判断', short: '简答', fill: '填空', essay: '作文', subjective: '主观题',
  }
  const diffColor: Record<string, string> = {
    easy: 'green', medium: 'orange', hard: 'red',
  }

  if (isStudent) {
    return (
      <Card>
        <Empty description="学情分析仅对教师和管理员开放" />
      </Card>
    )
  }

  return (
    <Card style={{ borderRadius: 8 }}>
      <Card style={{ marginBottom: 16, background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', border: 'none' }}>
        <div style={{ color: '#fff', display: 'flex', alignItems: 'center', gap: 12 }}>
          <RobotOutlined style={{ fontSize: 28 }} />
          <Title level={3} style={{ color: '#fff', margin: 0 }}>AI 学情分析</Title>
          <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 14, marginTop: 4 }}>
            基于 DashScope AI，对学习数据进行深度分析，生成专业学情报告
          </Text>
        </div>
      </Card>

      <Card>
        <Tabs activeKey={activeTab} onChange={setActiveTab}
          items={[
            {
              key: 'class',
              label: <span><TeamOutlined /> 班级学情</span>,
              children: (
                <div>
                  <Space style={{ marginBottom: 16 }}>
                    <Select value={grade} onChange={(v) => { setGrade(v); setCls('') }}
                      style={{ width: 100 }} options={allowedGrades.map((g) => ({ label: g, value: g }))} />
                    <Select value={cls} onChange={setCls} style={{ width: 160 }}
                      placeholder="选择班级"
                      options={classes.map((c) => ({ label: c, value: c }))} />
                    <Button type="primary" icon={<RobotOutlined />} onClick={handleClassAnalysis}
                      loading={loading} disabled={!cls}>
                      AI 分析
                    </Button>
                    <Button icon={<BulbOutlined />} onClick={handleTeachingSuggestions}
                      loading={suggestionsLoading} disabled={!cls}>
                      AI 教学建议
                    </Button>
                  </Space>

                  {loading && (
                    <div style={{ textAlign: 'center', padding: 40 }}>
                      <Spin size="large" description="AI 分析中，请稍候..." />
                    </div>
                  )}

                  {rawData && !loading && (
                    <Row gutter={16} style={{ marginBottom: 16 }}>
                      <Col span={4}><Statistic title="学生人数" value={rawData.total_students} prefix={<TeamOutlined />} /></Col>
                      <Col span={4}><Statistic title="总积分" value={rawData.score_total} prefix={<ThunderboltOutlined />} /></Col>
                      <Col span={4}><Statistic title="平均积分" value={rawData.score_avg} /></Col>
                      <Col span={4}>
                        <Statistic title="点名正确" value={rawData.rollcall_correct}
                          suffix={`/ ${rawData.rollcall_total}`}
                          styles={{ content: { color: rawData.rollcall_total > 0 ? '#52c41a' : '#999' } }} />
                      </Col>
                      <Col span={4}><Statistic title="活跃任务" value={rawData.active_tasks} /></Col>
                      <Col span={4}><Statistic title="已提交学生" value={rawData.submitted_students} /></Col>
                    </Row>
                  )}

                  {report && !loading && (
                    <>
                      <Space style={{ marginBottom: 12, justifyContent: 'space-between', width: '100%' }}>
                        <span />
                        <Space>
                          <Button icon={<DownloadOutlined />} onClick={() => {
                            if (!cls) return
                            const token = localStorage.getItem('smartkb_token')
                            window.open(`/api/analytics/class-overview/export?grade=${grade}&cls=${cls}&teacher=${user?.username}&token=${token}`, '_blank')
                          }}>导出 Word</Button>
                          <Button icon={<DownloadOutlined />} onClick={exportReportAsMarkdown}>导出报告(.md)</Button>
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
                      <Typography.Title level={5}><BulbOutlined style={{ color: '#faad14' }} /> AI 教学建议</Typography.Title>
                      {suggestionsData.data && (
                        <Row gutter={16} style={{ marginBottom: 12 }}>
                          <Col span={6}><Statistic title="学生人数" value={suggestionsData.data.total_students} /></Col>
                          <Col span={6}><Statistic title="平均积分" value={suggestionsData.data.score_avg} /></Col>
                          <Col span={6}><Statistic title="点名正确率" value={suggestionsData.data.rollcall_rate} suffix="%" /></Col>
                          <Col span={6}><Statistic title="任务参与率" value={suggestionsData.data.task_rate} suffix="%" /></Col>
                        </Row>
                      )}
                      <Space style={{ marginBottom: 12, justifyContent: 'flex-end', width: '100%' }}>
                        <Button icon={<DownloadOutlined />} onClick={() => {
                          if (!cls) return
                          const token = localStorage.getItem('smartkb_token')
                          window.open(`/api/analytics/teaching-suggestions/export?grade=${grade}&cls=${cls}&teacher_username=${user?.username}&token=${token}`, '_blank')
                        }}>导出 Word</Button>
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
              label: <span><BarChartOutlined /> 考试分析</span>,
              children: (
                <div>
                  <Space style={{ marginBottom: 16 }}>
                    <Select value={selectedExam} onChange={setSelectedExam} style={{ width: 300 }}
                      placeholder="选择考试"
                      options={exams.map((e) => ({ label: `${e.title} (${e.subject})`, value: e.id }))} />
                    <Button type="primary" icon={<RobotOutlined />} onClick={handleExamAnalysis}
                      loading={examLoading} disabled={!selectedExam}>
                      AI 分析
                    </Button>
                  </Space>

                  {examLoading && (
                    <div style={{ textAlign: 'center', padding: 40 }}>
                      <Spin size="large" description="AI 分析中，请稍候..." />
                    </div>
                  )}

                  {examAnalytics && (
                    <>
                      <Row gutter={16} style={{ marginBottom: 16 }}>
                        <Col span={4}><Statistic title="参考人数" value={examAnalytics.statistics.total_students} /></Col>
                        <Col span={4}><Statistic title="平均分" value={examAnalytics.statistics.avg_score} precision={1} /></Col>
                        <Col span={4}><Statistic title="最高分" value={examAnalytics.statistics.max_score} /></Col>
                        <Col span={4}><Statistic title="最低分" value={examAnalytics.statistics.min_score} /></Col>
                        <Col span={4}><Statistic title="及格率" value={examAnalytics.statistics.pass_rate} suffix="%" precision={1} /></Col>
                      </Row>

                      <Table
                        dataSource={examAnalytics.question_accuracy}
                        rowKey="id"
                        size="small"
                        pagination={false}
                        style={{ marginBottom: 16 }}
                        columns={[
                          { title: '题型', dataIndex: 'type', width: 70, render: (t: string) => typeLabel[t] || t },
                          { title: '题目', dataIndex: 'text', ellipsis: true },
                          {
                            title: '难度', dataIndex: 'difficulty', width: 70,
                            render: (d: string) => <Tag color={diffColor[d] || 'default'}>{d === 'easy' ? '易' : d === 'medium' ? '中' : '难'}</Tag>,
                          },
                          {
                            title: '正确率', dataIndex: 'correct_rate', width: 90,
                            render: (r: number) => (
                              <Text strong style={{ color: r >= 60 ? '#52c41a' : '#ff4d4f' }}>{r}%</Text>
                            ),
                          },
                          { title: '知识点', dataIndex: 'knowledge_points', width: 150, ellipsis: true },
                        ]}
                      />

                      <Space style={{ marginBottom: 12, justifyContent: 'space-between', width: '100%' }}>
                        <span />
                        <Space>
                          <Button icon={<DownloadOutlined />} onClick={() => {
                            if (!selectedExam) return
                            const token = localStorage.getItem('smartkb_token')
                            window.open(`/api/analytics/exam/${selectedExam}/report/export?token=${token}`, '_blank')
                          }}>导出 Word</Button>
                          <Button icon={<DownloadOutlined />} onClick={exportExamExcel}>导出Excel</Button>
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
              label: <span><BookOutlined /> 学情进度</span>,
              children: (
                <div>
                  <Row gutter={16} style={{ marginBottom: 16 }}>
                    <Col span={6}><Statistic title="筛选学生数" value={progressStats.totalStudents} prefix={<TeamOutlined />} /></Col>
                    <Col span={6}>
                      <Statistic title="平均完成率" value={progressStats.avgRate} suffix="%"
                        precision={1} styles={{ content: { color: progressStats.avgRate >= 60 ? '#52c41a' : '#faad14' } }} />
                    </Col>
                  </Row>

                  <Space wrap style={{ marginBottom: 16 }}>
                    <Select
                      value={courseId} onChange={setCourseId} style={{ width: 160 }}
                      placeholder="选择课程" allowClear
                      options={courses.map((c) => ({ label: c.name, value: c.id }))} />
                    <Select
                      value={progressGrade} onChange={setProgressGrade} style={{ width: 120 }}
                      placeholder="全部年级" allowClear
                      options={gradeOptions.map(g => ({ label: g, value: g }))} />
                    <Select
                      value={progressClass} onChange={setProgressClass} style={{ width: 120 }}
                      placeholder="全部班级" allowClear
                      options={classOptions.map(c => ({ label: c, value: c }))} />
                    <Button type="primary" icon={<ReloadOutlined />} onClick={loadProgress} loading={progressLoading}>查询</Button>
                    <Button icon={<DownloadOutlined />} onClick={exportProgressExcel}
                      disabled={progressStudents.length === 0}>导出Excel</Button>
                  </Space>

                  <Space style={{ marginBottom: 12 }}>
                    <Tag icon={<CheckCircleOutlined />} color="success">已完成</Tag>
                    <Tag icon={<ClockCircleOutlined />} color="processing">学习中</Tag>
                    <Tag icon={<StopOutlined />} color="default">未开始</Tag>
                  </Space>

                  {!progressLoading && progressStudents.length === 0 ? (
                    <Empty description="请选择筛选条件后点击「查询」按钮加载数据" />
                  ) : (
                  <Table
                    dataSource={progressStudents}
                    rowKey="username"
                    loading={progressLoading}
                    pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 名学生` }}
                    expandable={{
                      expandedRowRender: (record: ProgressStudent) => {
                        const stuCourses = record.courses || []
                        const detail = stuCourses.find((c) => c.course_id === courseId) || stuCourses[0]
                        const details = detail?.details || []
                        if (!details.length) return <Text type="secondary">该课程暂无知识点</Text>
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
                        title: '姓名', dataIndex: 'name', key: 'name', width: 100,
                        render: (name: string) => <Text strong><TeamOutlined /> {name}</Text>,
                      },
                      { title: '年级', dataIndex: 'grade', width: 70 },
                      { title: '班级', dataIndex: 'class', width: 70 },
                      {
                        title: '课程完成率', key: 'courses', width: 200,
                        render: (_: unknown, record: ProgressStudent) => {
                          const cd = (record.courses || []).find((c) => c.course_id === courseId) || (record.courses || [])[0]
                          if (!cd) return <Text type="secondary">—</Text>
                          const { completed_kps, total_kps, rate } = cd
                          return (
                            <Tooltip title={`${completed_kps}/${total_kps} (${rate}%)`}>
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
          ]}
        />
      </Card>
    </Card>
  )
}

export default AnalyticsPage
