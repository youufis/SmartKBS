import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Card, Row, Col, Statistic, Typography, Spin, List, Tag, Space,
  Timeline, Button, Empty,
} from 'antd'
import {
  FileAddOutlined, TrophyOutlined, CheckCircleOutlined,
  MessageOutlined, TeamOutlined, BookOutlined,
  RiseOutlined, ClockCircleOutlined, ThunderboltOutlined,
  AuditOutlined, BarChartOutlined, ReloadOutlined,
  RightOutlined, ExperimentOutlined,
  DatabaseOutlined, FolderOutlined, BellOutlined,
} from '@ant-design/icons'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'
import * as notificationsApi from '../api/notifications'
import type { AnnouncementItem } from '../api/notifications'

const { Title, Text, Paragraph } = Typography

interface DashboardSummary {
  role: 'admin' | 'teacher' | 'student'
  username: string
  user_name: string
  // 学生
  pending_exam_count?: number
  completed_exam_count?: number
  total_score?: number
  rank?: number
  active_task_count?: number
  submission_count?: number
  recent_chat_count?: number
  exam_results?: Array<{
    id: number
    title: string
    score: number
    total_score: number
    submitted_at: string
    pass_score: number
    passed: boolean
  }>
  pending_exams?: Array<{
    id: number
    title: string
    subject: string
    duration: number
    total_score: number
    pass_score: number
    start_time: string | null
    end_time: string | null
  }>
  // 学生 - 课堂互动
  active_quiz_count?: number
  my_quiz_answers?: number
  student_poll_vote_count?: number
  // 教师/管理员
  exam_stats?: {
    total: number
    draft: number
    published: number
    ended: number
  }
  total_submissions?: number
  active_task_count_teacher?: number
  total_students?: number
  total_teachers?: number
  rollcall_this_week?: number
  today_chat_count?: number
  teacher_grades?: string
  teacher_classes?: string
  // 教师/管理员 - 课堂互动
  teacher_quiz_count?: number
  teacher_active_quiz_count?: number
  teacher_poll_count?: number
  teacher_quiz_answer_count?: number
  teacher_poll_vote_count?: number
  // AI 用量
  token_today?: number
}

interface Activity {
  time: string
  type: 'exam' | 'score' | 'task' | 'rollcall' | 'quiz' | 'poll'
  title: string
  detail: string
}

const TYPE_CONFIG: Record<string, { color: string; icon: React.ReactNode }> = {
  exam: { color: '#1677ff', icon: <FileAddOutlined /> },
  score: { color: '#52c41a', icon: <TrophyOutlined /> },
  task: { color: '#faad14', icon: <CheckCircleOutlined /> },
  rollcall: { color: '#722ed1', icon: <AuditOutlined /> },
  quiz: { color: '#ff4d4f', icon: <ThunderboltOutlined /> },
  poll: { color: '#722ed1', icon: <BarChartOutlined /> },
}

const DashboardPage: React.FC = () => {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [activities, setActivities] = useState<Activity[]>([])
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([])
  const [loading, setLoading] = useState(true)
  const [activityLoading, setActivityLoading] = useState(true)

  const isStudent = user?.role === 'student'
  const isTeacher = user?.role === 'teacher'
  const isAdmin = user?.role === 'admin'

  const fetchData = async () => {
    setLoading(true)
    try {
      const { data } = await apiClient.get('/api/dashboard/summary')
      setSummary(data)
    } catch {
      // ignore
    }
    setLoading(false)
  }

  const fetchActivities = async () => {
    setActivityLoading(true)
    try {
      const { data } = await apiClient.get('/api/dashboard/recent-activity')
      setActivities(data || [])
    } catch {
      // ignore
    }
    setActivityLoading(false)
  }

  const fetchAnnouncements = async () => {
    try {
      const data = await notificationsApi.getAnnouncements(1, 5)
      setAnnouncements(data.announcements || [])
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    fetchData()
    fetchActivities()
    fetchAnnouncements()
  }, [])

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 400 }}>
        <Spin size="large" tip="加载中..." />
      </div>
    )
  }

  if (!summary) {
    return <Empty description="无法加载仪表盘数据" />
  }

  // ── 欢迎横幅 ──
  const roleLabel = isStudent ? '同学' : isTeacher ? '老师' : '管理员'
  const timeOfDay = new Date().getHours() < 12 ? '上午' : new Date().getHours() < 18 ? '下午' : '晚上'

  return (
    <div>
      {/* ─── 欢迎横幅 ─── */}
      <Card
        style={{
          marginBottom: 24,
          background: 'linear-gradient(135deg, #1677ff 0%, #0958d9 100%)',
          borderRadius: 12,
          border: 'none',
        }}
      >
        <div style={{ color: '#fff' }}>
          <Title level={3} style={{ color: '#fff', margin: 0 }}>
            {timeOfDay}好，{summary.user_name}{roleLabel}！👋
          </Title>
          <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 15, marginTop: 8, display: 'block' }}>
            {isStudent
              ? '欢迎回来，继续你的学习之旅吧！'
              : '欢迎使用 SmartKBS 智慧教学平台'}
          </Text>
        </div>
      </Card>

      {/* ─── 统计卡片 ─── */}
      {isStudent ? (
        <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
          <Col xs={12} sm={6}>
            <Card hoverable onClick={() => navigate('/exam')}>
              <Statistic
                title="待完成考试"
                value={summary.pending_exam_count ?? 0}
                prefix={<FileAddOutlined style={{ color: '#1677ff' }} />}
                suffix="场"
                valueStyle={{ color: '#1677ff' }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card hoverable onClick={() => navigate('/exam')}>
              <Statistic
                title="已完成考试"
                value={summary.completed_exam_count ?? 0}
                prefix={<CheckCircleOutlined style={{ color: '#52c41a' }} />}
                suffix="场"
                valueStyle={{ color: '#52c41a' }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card hoverable onClick={() => navigate('/score')}>
              <Statistic
                title="累计积分"
                value={summary.total_score ?? 0}
                prefix={<TrophyOutlined style={{ color: '#faad14' }} />}
                suffix="分"
                valueStyle={{ color: '#faad14' }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card>
              <Statistic
                title="积分排名"
                value={summary.rank ?? '-'}
                prefix={<RiseOutlined style={{ color: '#722ed1' }} />}
                suffix={summary.rank ? '/ 全班' : ''}
                valueStyle={{ color: '#722ed1' }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card hoverable onClick={() => navigate('/tasks')}>
              <Statistic
                title="活跃任务"
                value={summary.active_task_count ?? 0}
                prefix={<BookOutlined style={{ color: '#fa8c16' }} />}
                suffix="个"
                valueStyle={{ color: '#fa8c16' }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card>
              <Statistic
                title="本周对话"
                value={summary.recent_chat_count ?? 0}
                prefix={<MessageOutlined style={{ color: '#13c2c2' }} />}
                suffix="次"
                valueStyle={{ color: '#13c2c2' }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card hoverable onClick={() => navigate('/interaction')}>
              <Statistic
                title="待答测验"
                value={summary.active_quiz_count ?? 0}
                prefix={<ThunderboltOutlined style={{ color: '#ff4d4f' }} />}
                suffix="个"
                valueStyle={{ color: '#ff4d4f' }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card hoverable onClick={() => navigate('/interaction')}>
              <Statistic
                title="已参与投票"
                value={summary.student_poll_vote_count ?? 0}
                prefix={<BarChartOutlined style={{ color: '#722ed1' }} />}
                suffix="次"
                valueStyle={{ color: '#722ed1' }}
              />
            </Card>
          </Col>
        </Row>
      ) : (
        <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
          <Col xs={12} sm={6}>
            <Card hoverable onClick={() => navigate('/exam')}>
              <Statistic
                title="考试总数"
                value={summary.exam_stats?.total ?? 0}
                prefix={<FileAddOutlined style={{ color: '#1677ff' }} />}
                suffix={
                  <Space size={4} style={{ fontSize: 14 }}>
                    <Tag color="default">草稿 {summary.exam_stats?.draft ?? 0}</Tag>
                    <Tag color="green">发布 {summary.exam_stats?.published ?? 0}</Tag>
                    <Tag color="red">结束 {summary.exam_stats?.ended ?? 0}</Tag>
                  </Space>
                }
                valueStyle={{ color: '#1677ff', fontSize: 28 }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card hoverable onClick={() => navigate('/tasks')}>
              <Statistic
                title="任务提交"
                value={summary.total_submissions ?? 0}
                prefix={<CheckCircleOutlined style={{ color: '#52c41a' }} />}
                suffix={
                  <Space size={4}>
                    <Text type="secondary" style={{ fontSize: 14 }}>
                      活跃 {summary.active_task_count ?? 0}
                    </Text>
                  </Space>
                }
                valueStyle={{ color: '#52c41a', fontSize: 28 }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card hoverable onClick={() => navigate(isAdmin ? '/user-mgmt' : '/score')}>
              <Statistic
                title="学生总数"
                value={summary.total_students ?? 0}
                prefix={<TeamOutlined style={{ color: '#722ed1' }} />}
                suffix={
                  isAdmin ? (
                    <Text type="secondary" style={{ fontSize: 14 }}>
                      教师 {summary.total_teachers ?? 0}
                    </Text>
                  ) : null
                }
                valueStyle={{ color: '#722ed1', fontSize: 28 }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card hoverable onClick={() => navigate('/rollcall')}>
              <Statistic
                title="本周点名"
                value={summary.rollcall_this_week ?? 0}
                prefix={<AuditOutlined style={{ color: '#fa8c16' }} />}
                suffix="次"
                valueStyle={{ color: '#fa8c16', fontSize: 28 }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card hoverable onClick={() => navigate('/token-usage')}>
              <Statistic
                title="AI 用量（今日）"
                value={summary.token_today ?? 0}
                prefix={<BarChartOutlined style={{ color: '#1677ff' }} />}
                suffix="tokens"
                valueStyle={{ color: '#1677ff', fontSize: 28 }}
              />
            </Card>
          </Col>
          {isAdmin && (
            <Col xs={12} sm={6}>
              <Card>
                <Statistic
                  title="今日对话"
                  value={summary.today_chat_count ?? 0}
                  prefix={<MessageOutlined style={{ color: '#13c2c2' }} />}
                  suffix="次"
                  valueStyle={{ color: '#13c2c2', fontSize: 28 }}
                />
              </Card>
            </Col>
          )}
          {/* ── 课堂互动卡片（教师/管理员） ── */}
          <Col xs={12} sm={6}>
            <Card hoverable onClick={() => navigate('/interaction')}>
              <Statistic
                title="随堂测验"
                value={summary.teacher_quiz_count ?? 0}
                prefix={<ThunderboltOutlined style={{ color: '#ff4d4f' }} />}
                suffix={
                  <Text type="secondary" style={{ fontSize: 14 }}>
                    进行中 {summary.teacher_active_quiz_count ?? 0}
                  </Text>
                }
                valueStyle={{ color: '#ff4d4f', fontSize: 28 }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card hoverable onClick={() => navigate('/interaction')}>
              <Statistic
                title="活跃投票"
                value={summary.teacher_poll_count ?? 0}
                prefix={<BarChartOutlined style={{ color: '#722ed1' }} />}
                suffix={
                  <Text type="secondary" style={{ fontSize: 14 }}>
                    回应 {summary.teacher_quiz_answer_count ?? 0} 人
                  </Text>
                }
                valueStyle={{ color: '#722ed1', fontSize: 28 }}
              />
            </Card>
          </Col>
        </Row>
      )}

      <Row gutter={[16, 16]}>
        {/* ─── 左侧：待办/考试列表 ─── */}
        <Col xs={24} lg={14}>
          {isStudent && summary.pending_exams && summary.pending_exams.length > 0 && (
            <Card
              title={<Space><ClockCircleOutlined style={{ color: '#faad14' }} />待参加的考试</Space>}
              style={{ marginBottom: 16 }}
              extra={
                <Button type="link" onClick={() => navigate('/exam')}>
                  查看全部 <RightOutlined />
                </Button>
              }
            >
              <List
                dataSource={summary.pending_exams}
                renderItem={(exam) => (
                  <List.Item
                    actions={[
                      <Button
                        type="primary"
                        size="small"
                        onClick={() => navigate(`/exam-take/${exam.id}`)}
                      >
                        开始考试
                      </Button>,
                    ]}
                  >
                    <List.Item.Meta
                      avatar={<ExperimentOutlined style={{ fontSize: 20, color: '#1677ff' }} />}
                      title={exam.title}
                      description={
                        <Space size={16}>
                          <Tag>{exam.subject}</Tag>
                          <Text type="secondary">时长 {exam.duration} 分钟</Text>
                          <Text type="secondary">{exam.total_score} 分</Text>
                        </Space>
                      }
                    />
                  </List.Item>
                )}
              />
            </Card>
          )}

          {/* 教师：任教信息 */}
          {isTeacher && summary.teacher_grades && (
            <Card title={<Space><TeamOutlined />任教信息</Space>} style={{ marginBottom: 16 }}>
              <Space direction="vertical">
                <Text>任教年级：<Tag color="blue">{summary.teacher_grades}</Tag></Text>
                <Text>任教班级：<Tag color="green">{summary.teacher_classes}</Tag></Text>
              </Space>
            </Card>
          )}

          {/* 学生：近期考试成绩 */}
          {isStudent && summary.exam_results && summary.exam_results.length > 0 && (
            <Card
              title={<Space><BarChartOutlined style={{ color: '#1677ff' }} />近期考试成绩</Space>}
              style={{ marginBottom: 16 }}
              extra={
                <Button type="link" onClick={() => navigate('/exam')}>
                  查看全部 <RightOutlined />
                </Button>
              }
            >
              <List
                dataSource={summary.exam_results}
                renderItem={(item) => (
                  <List.Item>
                    <List.Item.Meta
                      title={item.title}
                      description={
                        <Space>
                          <Text>
                            得分：
                            <Text strong style={{ color: item.passed ? '#52c41a' : '#ff4d4f' }}>
                              {item.score} / {item.total_score}
                            </Text>
                          </Text>
                          <Tag color={item.passed ? 'green' : 'red'}>
                            {item.passed ? '已通过' : '未通过'}
                          </Tag>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {item.submitted_at ? new Date(item.submitted_at).toLocaleString('zh-CN') : ''}
                          </Text>
                        </Space>
                      }
                    />
                  </List.Item>
                )}
              />
            </Card>
          )}

          {/* 教师/管理员：考试概览小表格 */}
          {!isStudent && (
            <Card
              title={<Space><FileAddOutlined style={{ color: '#1677ff' }} />考试概览</Space>}
              style={{ marginBottom: 16 }}
              extra={
                <Button type="link" onClick={() => navigate('/exam')}>
                  管理考试 <RightOutlined />
                </Button>
              }
            >
              <Row gutter={[16, 16]}>
                {[
                  { label: '草稿', value: summary.exam_stats?.draft ?? 0, color: '#999' },
                  { label: '已发布', value: summary.exam_stats?.published ?? 0, color: '#52c41a' },
                  { label: '已结束', value: summary.exam_stats?.ended ?? 0, color: '#ff4d4f' },
                  { label: '总计', value: summary.exam_stats?.total ?? 0, color: '#1677ff' },
                ].map((item) => (
                  <Col span={6} key={item.label}>
                    <Card size="small" style={{ textAlign: 'center' }}>
                      <Text type="secondary">{item.label}</Text>
                      <div style={{ fontSize: 28, fontWeight: 600, color: item.color }}>
                        {item.value}
                      </div>
                    </Card>
                  </Col>
                ))}
              </Row>
            </Card>
          )}

          {/* 系统公告 */}
          {announcements.length > 0 && (
            <Card
              title={<Space><BellOutlined style={{ color: '#fa8c16' }} />系统公告</Space>}
              style={{ marginBottom: 16 }}
              size="small"
              extra={
                <Button type="link" onClick={() => navigate('/announcements')}>
                  查看全部 <RightOutlined />
                </Button>
              }
            >
              <List
                size="small"
                dataSource={announcements.slice(0, 3)}
                renderItem={(item) => (
                  <List.Item>
                    <List.Item.Meta
                      title={
                        <Space>
                          {item.is_pinned && <BellOutlined style={{ color: '#fa8c16', fontSize: 12 }} />}
                          <Text strong style={{ fontSize: 13 }}>{item.title}</Text>
                          <Tag color={item.priority === 'urgent' ? 'red' : item.priority === 'important' ? 'orange' : 'blue'} style={{ fontSize: 10, lineHeight: '16px' }}>
                            {item.priority === 'urgent' ? '紧急' : item.priority === 'important' ? '重要' : '普通'}
                          </Tag>
                        </Space>
                      }
                      description={
                        <Paragraph
                          ellipsis={{ rows: 2 }}
                          type="secondary"
                          style={{ fontSize: 12, margin: 0 }}
                        >
                          {item.content}
                        </Paragraph>
                      }
                    />
                  </List.Item>
                )}
              />
            </Card>
          )}

          {/* 快速入口 */}
          <Card title={<Space><ThunderboltOutlined style={{ color: '#faad14' }} />快速入口</Space>}>
            <Row gutter={[12, 12]}>
              {isStudent ? (
                <>
                  <Col span={8}><Button block icon={<MessageOutlined />} onClick={() => navigate('/chat')}>AI 对话</Button></Col>
                  <Col span={8}><Button block icon={<FileAddOutlined />} onClick={() => navigate('/exam')}>在线考试</Button></Col>
                  <Col span={8}><Button block icon={<TrophyOutlined />} onClick={() => navigate('/score')}>查看积分</Button></Col>
                </>
              ) : (
                <>
                  <Col span={8}><Button block icon={<MessageOutlined />} onClick={() => navigate('/chat')}>AI 对话</Button></Col>
                  <Col span={8}><Button block icon={<FileAddOutlined />} onClick={() => navigate('/exam')}>考试发布</Button></Col>
                  <Col span={8}><Button block icon={<AuditOutlined />} onClick={() => navigate('/rollcall')}>智能点名</Button></Col>
                  {isAdmin && (
                    <Col span={8}><Button block icon={<TeamOutlined />} onClick={() => navigate('/user-mgmt')}>用户管理</Button></Col>
                  )}
                  <Col span={8}><Button block icon={<DatabaseOutlined />} onClick={() => navigate('/question-bank')}>试题管理</Button></Col>
                  <Col span={8}><Button block icon={<FolderOutlined />} onClick={() => navigate('/resource-mgmt')}>资源管理</Button></Col>
                </>
              )}
            </Row>
          </Card>
        </Col>

        {/* ─── 右侧：最近动态时间线 ─── */}
        <Col xs={24} lg={10}>
          <Card
            title={<Space><ClockCircleOutlined />最近动态</Space>}
            extra={
              <Button type="text" icon={<ReloadOutlined />} onClick={fetchActivities} />
            }
            style={{ height: 500 }}
            styles={{ body: { height: 450, overflow: 'auto' } }}
          >
            {activityLoading ? (
              <Spin style={{ display: 'block', margin: '40px auto' }} />
            ) : activities.length === 0 ? (
              <Empty description="暂无最近动态" />
            ) : (
              <Timeline
                items={activities.slice(0, 30).map((act) => ({
                  color: TYPE_CONFIG[act.type]?.color || '#999',
                  children: (
                    <div>
                      <Space>
                        {TYPE_CONFIG[act.type]?.icon}
                        <Text strong>{act.title}</Text>
                      </Space>
                      {act.detail && (
                        <div>
                          <Text type="secondary" style={{ fontSize: 12 }}>{act.detail}</Text>
                        </div>
                      )}
                      <div>
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          {act.time ? new Date(act.time).toLocaleString('zh-CN') : ''}
                        </Text>
                      </div>
                    </div>
                  ),
                }))}
              />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  )
}

export default DashboardPage
