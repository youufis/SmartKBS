import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Card, Row, Col, Statistic, Typography, Spin, List, Tag, Space,
  Timeline, Button, Empty,
} from 'antd'
import {
  FileAddOutlined, TrophyOutlined, CheckCircleOutlined,
  MessageOutlined, TeamOutlined, BookOutlined,
  ClockCircleOutlined, ThunderboltOutlined,
  AuditOutlined, BarChartOutlined, ReloadOutlined,
  RightOutlined, ExperimentOutlined, BellOutlined,
} from '@ant-design/icons'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'
import * as notificationsApi from '../api/notifications'
import type { AnnouncementItem } from '../api/notifications'

const { Text, Paragraph } = Typography

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
  // 学生 - 分组讨论
  active_discussion_count?: number
  my_discussion_count?: number
  // 教师/管理员 - 分组讨论
  discussion_total?: number
  discussion_active?: number
  discussion_member_count?: number
  // 管理员专有
  online_count?: number
  recent_exams?: Array<{ id: number; title: string; status: string; created_at: string; creator_username?: string; creator_name?: string }>
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
  discussion: { color: '#1677ff', icon: <TeamOutlined /> },
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

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [sumRes, actRes] = await Promise.all([
          apiClient.get('/api/dashboard/summary'),
          apiClient.get('/api/dashboard/recent-activity').catch(() => ({ data: [] })),
        ])
        if (cancelled) return
        setSummary(sumRes.data)
        setActivities(Array.isArray(actRes.data) ? actRes.data : [])
      } catch { /* ignore */ }
      if (!cancelled) {
        setLoading(false)
        setActivityLoading(false)
      }
    })()
    notificationsApi.getAnnouncements(1, 5).then((data) => {
      if (!cancelled) setAnnouncements(data.announcements || [])
    }).catch(() => {})
    return () => { cancelled = true }
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
        size="small"
        style={{
          marginBottom: 20,
          background: 'linear-gradient(135deg, #1677ff 0%, #0958d9 100%)',
          borderRadius: 8,
          border: 'none',
        }}
        bodyStyle={{ padding: '10px 20px' }}
      >
        <div style={{ color: '#fff', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 16, fontWeight: 600, whiteSpace: 'nowrap' }}>
            {timeOfDay}好，{summary.user_name}{roleLabel}！👋
          </span>
          <span style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13, whiteSpace: 'nowrap' }}>
            {isStudent ? '继续你的学习之旅吧' : '欢迎使用 SmartKBS 智慧教学平台'}
          </span>
          {isTeacher && summary.teacher_grades && (
            <span style={{ marginLeft: 'auto', fontSize: 13, color: 'rgba(255,255,255,0.9)' }}>
              <TeamOutlined /> {summary.teacher_grades} · {summary.teacher_classes}班
            </span>
          )}
        </div>
      </Card>

      {/* ─── 统计卡片（精简为每行 5 个） ─── */}
      {isStudent ? (
        <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
          <Col xs={12} sm={6} md={4}>
            <Card hoverable onClick={() => navigate('/exam')} size="small">
              <Statistic
                title="考试"
                value={`${summary.completed_exam_count ?? 0}/${summary.pending_exam_count ?? 0}`}
                prefix={<FileAddOutlined style={{ color: '#1677ff' }} />}
                suffix={<Text type="secondary" style={{ fontSize: 12 }}>已完成/待考</Text>}
                valueStyle={{ color: '#1677ff', fontSize: 22 }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6} md={4}>
            <Card hoverable onClick={() => navigate('/score')} size="small">
              <Statistic
                title="积分"
                value={summary.total_score ?? 0}
                prefix={<TrophyOutlined style={{ color: '#faad14' }} />}
                suffix={<Text type="secondary" style={{ fontSize: 12 }}>排名 {summary.rank ?? '-'}</Text>}
                valueStyle={{ color: '#faad14', fontSize: 22 }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6} md={4}>
            <Card hoverable onClick={() => navigate('/tasks')} size="small">
              <Statistic
                title="任务"
                value={summary.active_task_count ?? 0}
                prefix={<BookOutlined style={{ color: '#fa8c16' }} />}
                suffix={<Text type="secondary" style={{ fontSize: 12 }}>个活跃</Text>}
                valueStyle={{ color: '#fa8c16', fontSize: 22 }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6} md={4}>
            <Card hoverable onClick={() => navigate('/interaction')} size="small">
              <Statistic
                title="互动"
                value={summary.active_quiz_count ?? 0}
                prefix={<ThunderboltOutlined style={{ color: '#ff4d4f' }} />}
                suffix={<Text type="secondary" style={{ fontSize: 12 }}>待答 · {summary.student_poll_vote_count ?? 0}票</Text>}
                valueStyle={{ color: '#ff4d4f', fontSize: 22 }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6} md={4}>
            <Card hoverable onClick={() => navigate('/discussion')} size="small">
              <Statistic
                title="讨论"
                value={summary.my_discussion_count ?? 0}
                prefix={<TeamOutlined style={{ color: '#1677ff' }} />}
                suffix={<Text type="secondary" style={{ fontSize: 12 }}>/ {summary.active_discussion_count ?? 0} 进行中</Text>}
                valueStyle={{ color: '#1677ff', fontSize: 22 }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6} md={4}>
            <Card size="small">
              <Statistic
                title="对话"
                value={summary.recent_chat_count ?? 0}
                prefix={<MessageOutlined style={{ color: '#13c2c2' }} />}
                suffix={<Text type="secondary" style={{ fontSize: 12 }}>次/本周</Text>}
                valueStyle={{ color: '#13c2c2', fontSize: 22 }}
              />
            </Card>
          </Col>
        </Row>
      ) : (
        <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
          <Col xs={12} sm={6} md={4}>
            <Card hoverable onClick={() => navigate('/exam')} size="small">
              <Statistic
                title="考试"
                value={summary.exam_stats?.total ?? 0}
                prefix={<FileAddOutlined style={{ color: '#1677ff' }} />}
                suffix={
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    草稿{summary.exam_stats?.draft ?? 0} · 发布{summary.exam_stats?.published ?? 0} · 结束{summary.exam_stats?.ended ?? 0}
                  </Text>
                }
                valueStyle={{ color: '#1677ff', fontSize: 22 }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6} md={4}>
            <Card hoverable onClick={() => navigate('/tasks')} size="small">
              <Statistic
                title="任务"
                value={summary.total_submissions ?? 0}
                prefix={<CheckCircleOutlined style={{ color: '#52c41a' }} />}
                suffix={<Text type="secondary" style={{ fontSize: 12 }}>提交 · {summary.active_task_count ?? 0}活跃</Text>}
                valueStyle={{ color: '#52c41a', fontSize: 22 }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6} md={4}>
            <Card hoverable onClick={() => navigate(isAdmin ? '/user-mgmt' : '/score')} size="small">
              <Statistic
                title="师生"
                value={summary.total_students ?? 0}
                prefix={<TeamOutlined style={{ color: '#722ed1' }} />}
                suffix={
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {isAdmin ? `教师 ${summary.total_teachers ?? 0}` : '名学生'}
                  </Text>
                }
                valueStyle={{ color: '#722ed1', fontSize: 22 }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6} md={4}>
            <Card hoverable onClick={() => navigate('/rollcall')} size="small">
              <Statistic
                title="点名"
                value={summary.rollcall_this_week ?? 0}
                prefix={<AuditOutlined style={{ color: '#fa8c16' }} />}
                suffix={<Text type="secondary" style={{ fontSize: 12 }}>次/本周</Text>}
                valueStyle={{ color: '#fa8c16', fontSize: 22 }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6} md={4}>
            <Card hoverable onClick={() => navigate('/interaction')} size="small">
              <Statistic
                title="互动"
                value={summary.teacher_quiz_count ?? 0}
                prefix={<ThunderboltOutlined style={{ color: '#ff4d4f' }} />}
                suffix={<Text type="secondary" style={{ fontSize: 12 }}>测验 · {summary.teacher_poll_count ?? 0}投票</Text>}
                valueStyle={{ color: '#ff4d4f', fontSize: 22 }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6} md={4}>
            <Card hoverable onClick={() => navigate('/discussion')} size="small">
              <Statistic
                title="讨论"
                value={summary.discussion_active ?? 0}
                prefix={<TeamOutlined style={{ color: '#1677ff' }} />}
                suffix={<Text type="secondary" style={{ fontSize: 12 }}>进行中 · 共{summary.discussion_total ?? 0}</Text>}
                valueStyle={{ color: '#1677ff', fontSize: 22 }}
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

          {/* ── 教师：在线状态 + 最近考试 ── */}
          {isTeacher && (
            <>
              <Card size="small" style={{ marginBottom: 16 }}>
                <Space>
                  <Statistic
                    title="今日对话"
                    value={summary.today_chat_count ?? 0}
                    prefix={<MessageOutlined style={{ color: '#13c2c2' }} />}
                    valueStyle={{ color: '#13c2c2', fontSize: 20 }}
                  />
                  <Statistic
                    title="本周点名"
                    value={summary.rollcall_this_week ?? 0}
                    prefix={<AuditOutlined style={{ color: '#fa8c16' }} />}
                    valueStyle={{ color: '#fa8c16', fontSize: 20 }}
                  />
                </Space>
              </Card>
              {summary.recent_exams && summary.recent_exams.length > 0 && (
                <Card
                  title={<Space><FileAddOutlined style={{ color: '#1677ff' }} />最近创建的考试</Space>}
                  size="small"
                  style={{ marginBottom: 16 }}
                  extra={
                    <Button type="link" size="small" onClick={() => navigate('/exam')}>
                      管理 <RightOutlined />
                    </Button>
                  }
                >
                  <List
                    size="small"
                    dataSource={summary.recent_exams}
                    renderItem={(exam) => {
                      const statusMap: Record<string, { label: string; color: string }> = {
                        draft: { label: '草稿', color: 'default' },
                        published: { label: '已发布', color: 'green' },
                        ended: { label: '已结束', color: 'red' },
                      }
                      const s = statusMap[exam.status] || { label: exam.status, color: 'default' }
                      return (
                        <List.Item>
                          <List.Item.Meta
                            title={<Text style={{ fontSize: 13 }}>{exam.title}</Text>}
                            description={
                              <Space size={8}>
                                <Tag color={s.color} style={{ fontSize: 11 }}>{s.label}</Tag>
                                <Text type="secondary" style={{ fontSize: 11 }}>
                                  {exam.created_at?.slice(0, 10)}
                                </Text>
                              </Space>
                            }
                          />
                        </List.Item>
                      )
                    }}
                  />
                </Card>
              )}
            </>
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

          {/* ── 管理员：在线状态 + 最近考试 ── */}
          {isAdmin && (
            <>
              <Card size="small" style={{ marginBottom: 16 }}>
                <Space>
                  <Statistic
                    title="当前在线"
                    value={summary.online_count ?? 0}
                    prefix={<TeamOutlined style={{ color: '#52c41a' }} />}
                    valueStyle={{ color: '#52c41a', fontSize: 20 }}
                  />
                  <Statistic
                    title="今日对话"
                    value={summary.today_chat_count ?? 0}
                    prefix={<MessageOutlined style={{ color: '#13c2c2' }} />}
                    valueStyle={{ color: '#13c2c2', fontSize: 20 }}
                  />
                </Space>
              </Card>
              {summary.recent_exams && summary.recent_exams.length > 0 && (
                <Card
                  title={<Space><FileAddOutlined style={{ color: '#1677ff' }} />最近创建的考试</Space>}
                  size="small"
                  style={{ marginBottom: 16 }}
                  extra={
                    <Button type="link" size="small" onClick={() => navigate('/exam')}>
                      管理 <RightOutlined />
                    </Button>
                  }
                >
                  <List
                    size="small"
                    dataSource={summary.recent_exams}
                    renderItem={(exam) => {
                      const statusMap: Record<string, { label: string; color: string }> = {
                        draft: { label: '草稿', color: 'default' },
                        published: { label: '已发布', color: 'green' },
                        ended: { label: '已结束', color: 'red' },
                      }
                      const s = statusMap[exam.status] || { label: exam.status, color: 'default' }
                      return (
                        <List.Item>
                          <List.Item.Meta
                            title={<Text style={{ fontSize: 13 }}>{exam.title}</Text>}
                            description={
                              <Space size={8}>
                                <Tag color={s.color} style={{ fontSize: 11 }}>{s.label}</Tag>
                                <Text type="secondary" style={{ fontSize: 11 }}>
                                  {exam.creator_name || exam.creator_username || ''}
                                </Text>
                                <Text type="secondary" style={{ fontSize: 11 }}>
                                  {exam.created_at?.slice(0, 10)}
                                </Text>
                              </Space>
                            }
                          />
                        </List.Item>
                      )
                    }}
                  />
                </Card>
              )}
            </>
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

          {/* 快捷导航 */}
          <Card size="small" title={<Space><ThunderboltOutlined style={{ color: '#faad14' }} />快捷导航</Space>}>
            <Row gutter={[8, 8]}>
              {isStudent ? (
                <>
                  <Col span={8}><Button size="small" block icon={<MessageOutlined />} onClick={() => navigate('/chat')}>AI 对话</Button></Col>
                  <Col span={8}><Button size="small" block icon={<FileAddOutlined />} onClick={() => navigate('/exam')}>在线考试</Button></Col>
                  <Col span={8}><Button size="small" block icon={<TeamOutlined />} onClick={() => navigate('/discussion')}>分组讨论</Button></Col>
                </>
              ) : (
                <>
                  <Col span={6}><Button size="small" block icon={<MessageOutlined />} onClick={() => navigate('/chat')}>AI 对话</Button></Col>
                  <Col span={6}><Button size="small" block icon={<FileAddOutlined />} onClick={() => navigate('/exam')}>考试发布</Button></Col>
                  <Col span={6}><Button size="small" block icon={<AuditOutlined />} onClick={() => navigate('/rollcall')}>智能点名</Button></Col>
                  <Col span={6}><Button size="small" block icon={<TeamOutlined />} onClick={() => navigate('/discussion')}>分组讨论</Button></Col>
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
