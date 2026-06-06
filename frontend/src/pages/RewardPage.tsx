import React, { useState, useEffect, useCallback } from 'react'
import {
  Card, Table, Tabs, Button, Space, Typography, Tag, message,
  Spin, Empty, Statistic, Row, Col, Select, Tooltip, Progress,
} from 'antd'
import {
  TrophyOutlined, HistoryOutlined, TeamOutlined,
  StarOutlined, ThunderboltOutlined, RiseOutlined,
  FireOutlined, BookOutlined, MessageOutlined,
  RobotOutlined, AuditOutlined,
} from '@ant-design/icons'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'

const { Title, Text } = Typography

const ACTIVITY_ICONS: Record<string, React.ReactNode> = {
  quiz: <ThunderboltOutlined style={{ color: '#1677ff' }} />,
  poll: <TeamOutlined style={{ color: '#722ed1' }} />,
  question: <MessageOutlined style={{ color: '#13c2c2' }} />,
  exam: <BookOutlined style={{ color: '#52c41a' }} />,
  practice: <RobotOutlined style={{ color: '#fa8c16' }} />,
  discussion: <TeamOutlined style={{ color: '#eb2f96' }} />,
  rollcall: <AuditOutlined style={{ color: '#faad14' }} />,
  chat: <MessageOutlined style={{ color: '#1677ff' }} />,
  task: <FireOutlined style={{ color: '#ff4d4f' }} />,
  learning: <RiseOutlined style={{ color: '#52c41a' }} />,
}

const ACTIVITY_COLORS: Record<string, string> = {
  quiz: '#e6f4ff',
  poll: '#f9f0ff',
  question: '#e6fffb',
  exam: '#f6ffed',
  practice: '#fff7e6',
  discussion: '#fff0f6',
  rollcall: '#fffbe6',
  chat: '#e6f4ff',
  task: '#fff2f0',
  learning: '#f6ffed',
}

const RewardPage: React.FC = () => {
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'
  const isStudent = user?.role === 'student'

  const [myPoints, setMyPoints] = useState<number>(0)
  const [myHistory, setMyHistory] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('my')

  // 教师端：班级排名
  const [grades, setGrades] = useState<string[]>([])
  const [selectedGrade, setSelectedGrade] = useState<string>('')
  const [selectedClass, setSelectedClass] = useState<string>('')
  const [classes, setClasses] = useState<string[]>([])
  const [ranking, setRanking] = useState<any[]>([])
  const [stats, setStats] = useState<any>(null)
  const [rankingLoading, setRankingLoading] = useState(false)

  // 加载我的积分
  const loadMyPoints = useCallback(async () => {
    setLoading(true)
    try {
      const [pointsRes, historyRes] = await Promise.all([
        apiClient.get('/api/rewards/my-points'),
        apiClient.get('/api/rewards/my-history', { params: { limit: 100 } }),
      ])
      setMyPoints(pointsRes.data.total_points || 0)
      setMyHistory(Array.isArray(historyRes.data) ? historyRes.data : [])
    } catch {
      // 忽略
    } finally {
      setLoading(false)
    }
  }, [])

  // 加载年级列表
  useEffect(() => {
    if (isTeacherOrAdmin) {
      apiClient.get('/api/config/subjects').then(({ data }) => {
        if (data?.subjects?.length > 0) {
          // 从用户信息获取年级
          apiClient.get('/api/scores/my-grades').then(({ data: grades }) => {
            if (Array.isArray(grades) && grades.length > 0) {
              setGrades(grades)
              setSelectedGrade(grades[0])
            }
          }).catch(() => {})
        }
      }).catch(() => {})
    }
  }, [isTeacherOrAdmin])

  // 加载班级列表
  useEffect(() => {
    if (selectedGrade) {
      apiClient.get('/api/scores/classes', { params: { grade: selectedGrade } }).then(({ data }) => {
        setClasses(Array.isArray(data) ? data : [])
      }).catch(() => {})
    }
  }, [selectedGrade])

  // 加载排名
  const loadRanking = useCallback(async () => {
    if (!selectedGrade) return
    setRankingLoading(true)
    try {
      const params: any = { grade: selectedGrade }
      if (selectedClass) params.class_name = selectedClass
      const [rankRes, statsRes] = await Promise.all([
        apiClient.get('/api/rewards/ranking', { params }),
        apiClient.get('/api/rewards/statistics', { params }),
      ])
      setRanking(Array.isArray(rankRes.data) ? rankRes.data : [])
      setStats(statsRes.data || null)
    } catch {
      // 忽略
    } finally {
      setRankingLoading(false)
    }
  }, [selectedGrade, selectedClass])

  useEffect(() => {
    if (isTeacherOrAdmin && selectedGrade) {
      loadRanking()
    }
  }, [isTeacherOrAdmin, selectedGrade, selectedClass, loadRanking])

  useEffect(() => {
    if (isStudent) {
      loadMyPoints()
    }
  }, [isStudent, loadMyPoints])

  // 学生视图：我的积分
  const renderStudentView = () => (
    <Spin spinning={loading}>
      {/* 积分总览 */}
      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={8}>
          <Card>
            <Statistic
              title="我的总积分"
              value={myPoints}
              prefix={<TrophyOutlined style={{ color: '#faad14' }} />}
              valueStyle={{ color: '#faad14', fontSize: 32, fontWeight: 'bold' }}
              suffix="分"
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title="参与活动"
              value={myHistory.length}
              prefix={<ThunderboltOutlined style={{ color: '#1677ff' }} />}
              valueStyle={{ color: '#1677ff' }}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title="获得奖励"
              value={myHistory.filter(h => h.reward_type !== 'participation').length}
              prefix={<StarOutlined style={{ color: '#52c41a' }} />}
              valueStyle={{ color: '#52c41a' }}
            />
          </Card>
        </Col>
      </Row>

      {/* 积分流水 */}
      <Card title={
        <Space><HistoryOutlined /> 积分明细</Space>
      }>
        {myHistory.length === 0 ? (
          <Empty description="暂无积分记录，快参与活动获取积分吧！" />
        ) : (
          <Table
            dataSource={myHistory}
            rowKey="id"
            size="small"
            pagination={{ pageSize: 15, showTotal: (t) => `共 ${t} 条记录` }}
            columns={[
              {
                title: '时间', dataIndex: 'created_at', key: 'created_at', width: 140,
                render: (t: string) => t ? t.slice(0, 16) : '',
              },
              {
                title: '活动', dataIndex: 'activity_type', key: 'activity_type', width: 80,
                render: (type: string) => (
                  <Tag icon={ACTIVITY_ICONS[type]}>{type ? (type.charAt(0).toUpperCase() + type.slice(1)) : ''}</Tag>
                ),
              },
              {
                title: '活动名称', dataIndex: 'activity_title', key: 'activity_title', ellipsis: true,
              },
              {
                title: '奖励类型', dataIndex: 'reward_type_name', key: 'reward_type', width: 100,
                render: (name: string, record: any) => {
                  const colors: Record<string, string> = {
                    participation: 'default',
                    excellent: 'success',
                    good: 'processing',
                    pass: 'warning',
                  }
                  return <Tag color={colors[record.reward_type] || 'default'}>{name}</Tag>
                },
              },
              {
                title: '积分', dataIndex: 'points', key: 'points', width: 70,
                render: (points: number) => (
                  <Text strong style={{ color: points > 2 ? '#52c41a' : '#1677ff', fontSize: 15 }}>
                    +{points}
                  </Text>
                ),
              },
              {
                title: '说明', dataIndex: 'reason', key: 'reason', ellipsis: true,
              },
            ]}
          />
        )}
      </Card>
    </Spin>
  )

  // 教师视图：排名与统计
  const renderTeacherView = () => (
    <div>
      {/* 筛选条件 */}
      <Card style={{ marginBottom: 16 }}>
        <Space wrap>
          <Select
            value={selectedGrade}
            onChange={v => { setSelectedGrade(v); setSelectedClass('') }}
            style={{ width: 150 }}
            placeholder="选择年级"
          >
            {grades.map(g => <Select.Option key={g} value={g}>{g}</Select.Option>)}
          </Select>
          <Select
            value={selectedClass}
            onChange={setSelectedClass}
            style={{ width: 180 }}
            placeholder="选择班级（全部）"
            allowClear
          >
            {classes.map(c => <Select.Option key={c} value={c}>{c}</Select.Option>)}
          </Select>
          <Button type="primary" icon={<RiseOutlined />} onClick={loadRanking}>
            刷新排名
          </Button>
        </Space>
      </Card>

      {/* 统计概览 */}
      {stats && (
        <Row gutter={16} style={{ marginBottom: 24 }}>
          <Col span={6}>
            <Card size="small">
              <Statistic title="总积分" value={stats.total_points} prefix={<TrophyOutlined />} valueStyle={{ color: '#faad14' }} />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic title="参与学生数" value={stats.participant_count} prefix={<TeamOutlined />} valueStyle={{ color: '#1677ff' }} />
            </Card>
          </Col>
          <Col span={12}>
            <Card size="small" title="活动类型分布">
              <Space wrap>
                {Object.entries(stats.activity_breakdown || {}).map(([type, info]: any) => (
                  <Tag key={type} icon={ACTIVITY_ICONS[type]} color="processing">
                    {info.name}: {info.points}分
                  </Tag>
                ))}
              </Space>
            </Card>
          </Col>
        </Row>
      )}

      {/* 排名表 */}
      <Card title={
        <Space><TrophyOutlined style={{ color: '#faad14' }} /> 学生积分排名</Space>
      }>
        <Spin spinning={rankingLoading}>
          {ranking.length === 0 ? (
            <Empty description={selectedGrade ? '暂无数据' : '请先选择年级'} />
          ) : (
            <Table
              dataSource={ranking}
              rowKey="username"
              size="small"
              pagination={{ pageSize: 30, showTotal: (t) => `共 ${t} 名学生` }}
              columns={[
                {
                  title: '排名', dataIndex: 'rank', key: 'rank', width: 60,
                  render: (rank: number) => {
                    if (rank === 1) return <Tag color="gold">🥇 1</Tag>
                    if (rank === 2) return <Tag color="silver">🥈 2</Tag>
                    if (rank === 3) return <Tag color="bronze">🥉 3</Tag>
                    return <Text type="secondary">{rank}</Text>
                  },
                },
                {
                  title: '姓名', dataIndex: 'name', key: 'name',
                  render: (name: string, record: any) => (
                    <Text strong>{name || record.username}</Text>
                  ),
                },
                {
                  title: '用户名', dataIndex: 'username', key: 'username',
                },
                {
                  title: '总积分', dataIndex: 'total_points', key: 'total_points', width: 100,
                  render: (points: number) => (
                    <Text strong style={{ color: '#fa8c16', fontSize: 16 }}>{points}</Text>
                  ),
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
        </Spin>
      </Card>
    </div>
  )

  return (
    <div>
      <Card>
        <Space style={{ marginBottom: 16 }}>
          <TrophyOutlined style={{ fontSize: 24, color: '#faad14' }} />
          <Title level={4} style={{ margin: 0 }}>🏆 积分奖励</Title>
        </Space>

        {/* 积分规则说明 */}
        <Card size="small" style={{ marginBottom: 16, background: '#fffbe6' }}>
          <Space direction="vertical" size={4}>
            <Text type="secondary">📋 积分规则：</Text>
            <Text type="secondary" style={{ fontSize: 13 }}>
              • 参与任何课堂活动均可获得 <Tag color="blue">+2 分</Tag> 基础参与分
            </Text>
            <Text type="secondary" style={{ fontSize: 13 }}>
              • 获得优秀成绩（得分率≥90%）可获得 <Tag color="success">+15 分</Tag> 优秀奖励
            </Text>
            <Text type="secondary" style={{ fontSize: 13 }}>
              • 获得良好成绩（得分率≥75%）可获得 <Tag color="processing">+10 分</Tag> 良好奖励
            </Text>
            <Text type="secondary" style={{ fontSize: 13 }}>
              • 成绩及格（得分率≥60%）可获得 <Tag color="warning">+5 分</Tag> 及格奖励
            </Text>
          </Space>
        </Card>

        {isStudent ? renderStudentView() : (
          <Tabs activeKey={activeTab} onChange={setActiveTab}>
            <Tabs.TabPane tab={<span><TrophyOutlined /> 积分排名</span>} key="my">
              {renderTeacherView()}
            </Tabs.TabPane>
            <Tabs.TabPane tab={<span><HistoryOutlined /> 我的积分</span>} key="history">
              {(() => {
                // 教师也可以看自己的积分信息，直接复用学生视图
                const [tMyPoints, setTMyPoints] = useState(0)
                const [tMyHistory, setTMyHistory] = useState<any[]>([])
                const [tLoading, setTLoading] = useState(false)
                useEffect(() => {
                  setTLoading(true)
                  Promise.all([
                    apiClient.get('/api/rewards/my-points'),
                    apiClient.get('/api/rewards/my-history', { params: { limit: 100 } }),
                  ]).then(([p, h]) => {
                    setTMyPoints(p.data.total_points || 0)
                    setTMyHistory(Array.isArray(h.data) ? h.data : [])
                  }).catch(() => {}).finally(() => setTLoading(false))
                }, [])
                return (
                  <Spin spinning={tLoading}>
                    <Row gutter={16} style={{ marginBottom: 24 }}>
                      <Col span={8}>
                        <Card>
                          <Statistic title="我的总积分" value={tMyPoints} prefix={<TrophyOutlined style={{ color: '#faad14' }} />} />
                        </Card>
                      </Col>
                    </Row>
                    <Table dataSource={tMyHistory} rowKey="id" size="small"
                      pagination={{ pageSize: 15 }}
                      columns={[
                        { title: '时间', dataIndex: 'created_at', render: (t: string) => t?.slice(0, 16) || '', width: 140 },
                        { title: '活动', dataIndex: 'activity_type_name', width: 80 },
                        { title: '活动名称', dataIndex: 'activity_title', ellipsis: true },
                        { title: '奖励类型', dataIndex: 'reward_type_name', width: 100 },
                        { title: '积分', dataIndex: 'points', width: 70, render: (p: number) => <Text strong style={{ color: '#52c41a' }}>+{p}</Text> },
                        { title: '说明', dataIndex: 'reason', ellipsis: true },
                      ]}
                    />
                  </Spin>
                )
              })()}
            </Tabs.TabPane>
          </Tabs>
        )}
      </Card>
    </div>
  )
}

export default RewardPage
