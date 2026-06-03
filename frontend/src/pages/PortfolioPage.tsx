import React, { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Card, Row, Col, Statistic, Typography, Spin, Tag, Space,
  Timeline, Empty, Alert, Button, Select, message,
  Table, List, Modal,
} from 'antd'
import {
  TrophyOutlined, FileAddOutlined, CheckCircleOutlined,
  AuditOutlined, MessageOutlined, UserOutlined,
  RightOutlined,
  BookOutlined, CalendarOutlined, RobotOutlined, DownloadOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'

const { Title, Text } = Typography

interface PortfolioData {
  user: {
    username: string
    name: string
    class: string
    grade: string
    gender: string
  }
  summary: string
  exams: {
    results: any[]
    stats: {
      total_exams: number
      avg_score: number
      avg_percentage: number
      passed_count: number
      failed_count: number
      max_score: number
      min_score: number
      trend: number[]
      subjects: string[]
    }
  }
  scores: {
    total_score: number
    teacher_count: number
    class_count: number
    records: Array<{ teacher: string; grade: string; class: string; score: number; updated_at: string }>
    trend: Array<{ date: string; score: number }>
  } | null
  rollcall: {
    total_calls: number
    correct_count: number
    wrong_count: number
    accuracy: number
    total_points: number
  } | null
  tasks: {
    completed: number
    tasks: Array<{ name: string; description: string; submitted_at: string }>
  }
  chats: {
    total_days: number
    total_chats: number
    avg_daily: number
    recent_days: Array<{ date: string; count: number }>
  } | null
}

const TYPE_ICONS: Record<string, React.ReactNode> = {
  exam: <FileAddOutlined style={{ color: '#1677ff' }} />,
  score: <TrophyOutlined style={{ color: '#faad14' }} />,
  rollcall: <AuditOutlined style={{ color: '#722ed1' }} />,
  task: <CheckCircleOutlined style={{ color: '#52c41a' }} />,
}

const PortfolioPage: React.FC = () => {
  const { username: paramUsername } = useParams<{ username: string }>()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'

  const targetUsername = paramUsername || user?.username || ''
  const [data, setData] = useState<PortfolioData | null>(null)
  const [timeline, setTimeline] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!targetUsername) return
    setLoading(true)
    setError('')
    Promise.all([
      apiClient.get(`/api/portfolio/${targetUsername}`),
      apiClient.get(`/api/portfolio/${targetUsername}/timeline`),
    ])
      .then(([portfolioRes, timelineRes]) => {
        setData(portfolioRes.data)
        setTimeline(timelineRes.data || [])
      })
      .catch((err) => {
        setError(err.response?.data?.detail || '加载失败')
      })
      .finally(() => setLoading(false))
  }, [targetUsername])

  // ── AI 学习报告 ──
  const [reportModal, setReportModal] = useState(false)
  const [reportLoading, setReportLoading] = useState(false)
  const [reportData, setReportData] = useState<{ report: string; period: string; data?: any } | null>(null)
  const [reportDays, setReportDays] = useState<number>(30)

  const handleGenerateReport = async () => {
    setReportLoading(true)
    setReportData(null)
    setReportModal(true)
    try {
      const { data } = await apiClient.get(`/api/portfolio/${targetUsername}/report`, {
        params: { days: reportDays, period: `近${reportDays}天` },
      })
      setReportData(data)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '生成报告失败')
      setReportModal(false)
    }
    setReportLoading(false)
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 400 }}>
        <Spin size="large" tip="加载成长档案..." />
      </div>
    )
  }

  if (error) {
    return <Alert type="error" message={error} showIcon />
  }

  if (!data) {
    return <Empty description="暂无数据" />
  }

  const { user: student, exams, scores, rollcall, tasks, chats } = data
  const examStats = exams?.stats
  const totalDataPoints = [
    { label: '考试', value: examStats?.total_exams ?? 0, icon: <FileAddOutlined />, color: '#1677ff' },
    { label: '课堂积分', value: scores?.total_score ?? 0, icon: <TrophyOutlined />, color: '#faad14' },
    { label: '点名次数', value: rollcall?.total_calls ?? 0, icon: <AuditOutlined />, color: '#722ed1' },
    { label: '完成任务', value: tasks?.completed ?? 0, icon: <CheckCircleOutlined />, color: '#52c41a' },
    { label: '对话天数', value: chats?.total_days ?? 0, icon: <MessageOutlined />, color: '#13c2c2' },
  ]

  return (
    <div>
      {/* ─── 学生信息头 ─── */}
      <Card style={{ marginBottom: 16, background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', border: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, color: '#fff' }}>
          <div style={{
            width: 64, height: 64, borderRadius: 32, background: 'rgba(255,255,255,0.2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28,
          }}>
            <UserOutlined />
          </div>
          <div style={{ flex: 1 }}>
            <Title level={3} style={{ color: '#fff', margin: 0 }}>{student.name}</Title>
            <Space style={{ marginTop: 4 }}>
              <Tag color="rgba(255,255,255,0.3)" style={{ color: '#fff', border: 'none' }}>{student.grade}</Tag>
              <Tag color="rgba(255,255,255,0.3)" style={{ color: '#fff', border: 'none' }}>{student.class}班</Tag>
              <Tag color="rgba(255,255,255,0.3)" style={{ color: '#fff', border: 'none' }}>{student.username}</Tag>
            </Space>
          </div>
          {isTeacherOrAdmin && (
            <Button ghost icon={<RightOutlined />} onClick={() => navigate(-1)}>
              返回
            </Button>
          )}
        </div>
      </Card>

      {/* ─── 综合摘要 ─── */}
      <Alert
        type="info"
        message={
          <Space>
            <BookOutlined />
            <Text>{data.summary}</Text>
          </Space>
        }
        style={{ marginBottom: 16, background: '#f6f8ff', border: '1px solid #d6e4ff' }}
      />

      {/* ─── AI 学习报告（仅教师/管理员可见） ─── */}
      {isTeacherOrAdmin && (
        <Card size="small" style={{ marginBottom: 16, background: '#fffbe6', border: '1px solid #ffe58f' }}>
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Space>
              <RobotOutlined style={{ color: '#faad14', fontSize: 18 }} />
              <Text strong>AI 学习报告</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>基于 AI 对学习数据深度分析，生成个性化学习报告</Text>
            </Space>
            <Space>
              <Select value={reportDays} onChange={setReportDays} style={{ width: 100 }} size="small"
                options={[
                  { value: 7, label: '近7天' },
                  { value: 30, label: '近30天' },
                  { value: 90, label: '近90天' },
                ]} />
              <Button type="primary" size="small" icon={<RobotOutlined />}
                loading={reportLoading} onClick={handleGenerateReport}>
                生成报告
              </Button>
            </Space>
          </Space>
        </Card>
      )}

      {/* ─── 数据总览卡片 ─── */}
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        {totalDataPoints.map((item) => (
          <Col xs={12} sm={8} lg={4} key={item.label}>
            <Card hoverable size="small" style={{ textAlign: 'center' }}>
              <Space direction="vertical" size={2}>
                <span style={{ fontSize: 22, color: item.color }}>{item.icon}</span>
                <Text strong style={{ fontSize: 20, color: item.color }}>{item.value}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>{item.label}</Text>
              </Space>
            </Card>
          </Col>
        ))}
      </Row>

      <Row gutter={[16, 16]}>
        {/* ─── 左侧：详细数据 ─── */}
        <Col xs={24} lg={14}>
          {/* 考试成绩表 */}
          {exams?.results && exams.results.length > 0 && (
            <Card title={<Space><FileAddOutlined />考试成绩</Space>} style={{ marginBottom: 16 }} size="small">
              <Row gutter={16} style={{ marginBottom: 12 }}>
                <Col span={6}><Statistic title="平均分" value={examStats?.avg_percentage ?? 0} suffix="%" valueStyle={{ color: '#1677ff' }} /></Col>
                <Col span={6}><Statistic title="最高分" value={examStats?.max_score ?? 0} valueStyle={{ color: '#52c41a' }} /></Col>
                <Col span={6}><Statistic title="通过" value={examStats?.passed_count ?? 0} suffix={`/ ${examStats?.total_exams ?? 0}`} valueStyle={{ color: '#52c41a' }} /></Col>
                <Col span={6}>
                  <Statistic title="正确率" value={rollcall?.accuracy ?? 0} suffix="%" prefix={<AuditOutlined />} />
                </Col>
              </Row>

              {/* 简易成绩走势图（纯 CSS 条形） */}
              {examStats?.trend && examStats.trend.length > 1 && (
                <div style={{ marginBottom: 12 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>成绩走势</Text>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 60, paddingTop: 8 }}>
                    {examStats.trend.map((pct: number, i: number) => (
                      <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <div style={{
                          width: '100%', height: `${Math.max(pct, 2)}%`, minHeight: 4,
                          background: pct >= 60 ? '#52c41a' : '#ff4d4f',
                          borderRadius: '4px 4px 0 0',
                          transition: 'height 0.3s',
                        }} />
                        <Text style={{ fontSize: 9, marginTop: 2 }}>{pct}%</Text>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <Table
                dataSource={exams.results}
                rowKey="id"
                size="small"
                pagination={false}
                columns={[
                  { title: '考试', dataIndex: 'title', ellipsis: true },
                  {
                    title: '得分', key: 'score',
                    render: (_: any, r: any) => (
                      <Text strong style={{ color: r.score >= r.pass_score ? '#52c41a' : '#ff4d4f' }}>
                        {r.score} / {r.total_score}
                      </Text>
                    ),
                  },
                  {
                    title: '结果', key: 'result',
                    render: (_: any, r: any) => (
                      <Tag color={r.score >= r.pass_score ? 'green' : 'red'}>
                        {r.score >= r.pass_score ? '通过' : '未通过'}
                      </Tag>
                    ),
                  },
                  {
                    title: '时间', dataIndex: 'submitted_at',
                    render: (t: string) => t ? t.slice(0, 10) : '-',
                    width: 100,
                  },
                ]}
              />
            </Card>
          )}

          {/* 课堂积分明细 */}
          {scores?.records && scores.records.length > 0 && (
            <Card title={<Space><TrophyOutlined />课堂积分</Space>} style={{ marginBottom: 16 }} size="small">
              <Row gutter={16} style={{ marginBottom: 12 }}>
                <Col span={8}><Statistic title="累计积分" value={scores.total_score} valueStyle={{ color: '#faad14' }} prefix={<TrophyOutlined />} /></Col>
                <Col span={8}><Statistic title="授课教师" value={scores.teacher_count} suffix="人" /></Col>
                <Col span={8}><Statistic title="班级数" value={scores.class_count} suffix="个" /></Col>
              </Row>

              {/* 积分趋势 */}
              {scores.trend && scores.trend.length > 1 && (
                <div style={{ marginBottom: 12 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>积分趋势</Text>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 50, paddingTop: 8 }}>
                    {scores.trend.map((point, i) => {
                      const maxVal = Math.max(...scores.trend.map((p) => p.score), 1)
                      return (
                        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                          <div style={{
                            width: '100%', height: `${(point.score / maxVal) * 100}%`, minHeight: 4,
                            background: '#faad14', borderRadius: '4px 4px 0 0',
                          }} />
                          <Text style={{ fontSize: 8, marginTop: 1 }}>{point.date.slice(5)}</Text>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              <Table
                dataSource={scores.records}
                rowKey={(_, i) => String(i)}
                size="small"
                pagination={false}
                columns={[
                  { title: '教师', dataIndex: 'teacher', width: 80 },
                  { title: '年级', dataIndex: 'grade', width: 60 },
                  { title: '班级', dataIndex: 'class', width: 80 },
                  { title: '积分', dataIndex: 'score', width: 60 },
                  { title: '时间', dataIndex: 'updated_at', render: (t: string) => t ? t.slice(0, 10) : '-' },
                ]}
              />
            </Card>
          )}

          {/* 任务完成 */}
          {tasks.tasks.length > 0 && (
            <Card title={<Space><CheckCircleOutlined />任务完成</Space>} style={{ marginBottom: 16 }} size="small">
              <List
                size="small"
                dataSource={tasks.tasks}
                renderItem={(item) => (
                  <List.Item>
                    <List.Item.Meta
                      title={item.name}
                      description={
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {item.description} | 提交于 {item.submitted_at?.slice(0, 10) || '未知'}
                        </Text>
                      }
                    />
                  </List.Item>
                )}
              />
            </Card>
          )}

          {/* 对话活跃 */}
          {chats && (
            <Card title={<Space><MessageOutlined />AI 对话活跃度</Space>} size="small">
              <Row gutter={16}>
                <Col span={8}><Statistic title="对话天数" value={chats.total_days} suffix="天" /></Col>
                <Col span={8}><Statistic title="总对话数" value={chats.total_chats} suffix="次" /></Col>
                <Col span={8}><Statistic title="日均" value={chats.avg_daily} suffix="次" /></Col>
              </Row>
            </Card>
          )}
        </Col>

        {/* ─── 右侧：成长时间轴 ─── */}
        <Col xs={24} lg={10}>
          <Card
            title={<Space><CalendarOutlined />成长时间轴</Space>}
            style={{ height: '100%' }}
          >
            {timeline.length === 0 ? (
              <Empty description="暂无成长记录" />
            ) : (
              <Timeline
                items={timeline.slice(-30).reverse().map((ev: any) => ({
                  color: ev.type === 'exam' ? '#1677ff' : ev.type === 'score' ? '#faad14' : ev.type === 'rollcall' ? '#722ed1' : '#52c41a',
                  children: (
                    <div>
                      <Space>
                        {TYPE_ICONS[ev.type]}
                        <Text strong style={{ fontSize: 13 }}>{ev.title}</Text>
                      </Space>
                      {ev.detail && <div><Text type="secondary" style={{ fontSize: 12 }}>{ev.detail}</Text></div>}
                      <div><Text type="secondary" style={{ fontSize: 11 }}>{ev.time?.slice(0, 16) || ''}</Text></div>
                    </div>
                  ),
                }))}
              />
            )}
          </Card>
        </Col>
      </Row>

      {/* ── AI 学习报告弹窗 ── */}
      <Modal
        title={<><RobotOutlined style={{ color: '#1677ff' }} /> AI 学习报告 - {student.name}（{reportData?.period || ''}）</>}
        open={reportModal}
        onCancel={() => setReportModal(false)}
        width={700}
        footer={
          <Space style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
            <Button icon={<DownloadOutlined />} onClick={() => {
              if (!targetUsername) return
              const token = localStorage.getItem('smartkb_token')
              window.open(`/api/portfolio/${targetUsername}/report/export?days=${reportDays}&period=近${reportDays}天&token=${token}`, '_blank')
            }}>导出 Word</Button>
            <Button onClick={() => setReportModal(false)}>关闭</Button>
          </Space>
        }
      >
        <Spin spinning={reportLoading}>
          {reportData && (
            <div style={{ maxHeight: '70vh', overflow: 'auto', padding: '0 4px' }}>
              {reportData.data && (
                <Row gutter={12} style={{ marginBottom: 16 }}>
                  <Col span={6}><Statistic title="考试次数" value={reportData.data.exams} suffix="次" /></Col>
                  <Col span={6}><Statistic title="累计积分" value={reportData.data.total_score} /></Col>
                  <Col span={6}><Statistic title="点名正确率" value={reportData.data.rollcall_rate} suffix="%" /></Col>
                  <Col span={6}><Statistic title="对话天数" value={reportData.data.chat_days} suffix="天" /></Col>
                </Row>
              )}
              <div className="markdown-content">
                <ReactMarkdown>{reportData.report}</ReactMarkdown>
              </div>
            </div>
          )}
        </Spin>
      </Modal>
    </div>
  )
}

export default PortfolioPage
