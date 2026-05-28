import React, { useState, useEffect } from 'react'
import {
  Card, Row, Col, Typography, Spin, Select, Button, Space,
  Empty, Tabs, Statistic, Table, Tag,
} from 'antd'
import {
  RobotOutlined, BarChartOutlined,
  TeamOutlined, ThunderboltOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'

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

const AnalyticsPage: React.FC = () => {
  const user = useAuthStore((s) => s.user)
  const isStudent = user?.role === 'student'

  const [activeTab, setActiveTab] = useState('class')
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState('')
  const [rawData, setRawData] = useState<any>(null)

  // 班级分析参数
  const [grade, setGrade] = useState('高一')
  const [cls, setCls] = useState('')
  const [classes, setClasses] = useState<string[]>([])
  const [allowedGrades] = useState(['高一', '高二'])

  // 考试列表
  const [exams, setExams] = useState<any[]>([])
  const [selectedExam, setSelectedExam] = useState<number | null>(null)
  const [examAnalytics, setExamAnalytics] = useState<ExamAnalytics | null>(null)
  const [examLoading, setExamLoading] = useState(false)

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

  // 班级学情分析
  const handleClassAnalysis = async () => {
    if (!cls) return
    setLoading(true)
    setReport('')
    try {
      const { data } = await apiClient.get('/api/analytics/class-overview', {
        params: { grade, cls },
      })
      setReport(data.report || '暂无分析结果')
      setRawData(data.data)
    } catch {
      setReport('❌ 分析失败，请稍后重试')
    }
    setLoading(false)
  }

  // 考试分析
  const handleExamAnalysis = async () => {
    if (!selectedExam) return
    setExamLoading(true)
    setExamAnalytics(null)
    try {
      const { data } = await apiClient.get(`/api/analytics/exam/${selectedExam}/report`)
      setExamAnalytics(data)
    } catch {
      setReport('❌ 分析失败')
    }
    setExamLoading(false)
  }

  const typeLabel: Record<string, string> = {
    single: '单选', multiple: '多选', true_false: '判断', short: '简答',
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
    <div>
      <Card style={{ marginBottom: 16, background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', border: 'none' }}>
        <div style={{ color: '#fff' }}>
          <Space>
            <RobotOutlined style={{ fontSize: 28 }} />
            <Title level={3} style={{ color: '#fff', margin: 0 }}>AI 智能学情分析</Title>
          </Space>
          <Text style={{ color: 'rgba(255,255,255,0.85)', display: 'block', marginTop: 8 }}>
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
                  </Space>

                  {loading && (
                    <div style={{ textAlign: 'center', padding: 40 }}>
                      <Spin size="large" tip="AI 分析中，请稍候..." />
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
                          valueStyle={{ color: rawData.rollcall_total > 0 ? '#52c41a' : '#999' }} />
                      </Col>
                      <Col span={4}><Statistic title="活跃任务" value={rawData.active_tasks} /></Col>
                      <Col span={4}><Statistic title="已提交学生" value={rawData.submitted_students} /></Col>
                    </Row>
                  )}

                  {report && !loading && (
                    <Card style={{ background: '#f6f8ff', border: '1px solid #d6e4ff' }}>
                      <div className="markdown-report">
                        <ReactMarkdown>{report}</ReactMarkdown>
                      </div>
                    </Card>
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
                      options={exams.map((e: any) => ({ label: `${e.title} (${e.subject})`, value: e.id }))} />
                    <Button type="primary" icon={<RobotOutlined />} onClick={handleExamAnalysis}
                      loading={examLoading} disabled={!selectedExam}>
                      AI 分析
                    </Button>
                  </Space>

                  {examLoading && (
                    <div style={{ textAlign: 'center', padding: 40 }}>
                      <Spin size="large" tip="AI 分析中，请稍候..." />
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

                      {/* 逐题正确率表格 */}
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
          ]}
        />
      </Card>
    </div>
  )
}

export default AnalyticsPage
